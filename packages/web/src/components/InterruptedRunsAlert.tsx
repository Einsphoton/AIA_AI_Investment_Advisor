/**
 * 「最近有 AI 运行没跑完」提示条 + 一键续跑（owner: web-ai-pages）。
 *
 * 为什么需要它：AI 流水线跑在 API 进程内（没有队列 / worker），服务进程重启
 * （开发模式下编译产物变化就会重启）、机器重启或上游超时，都会把正在跑的分析写成
 * `status='error'`。被中断的 run 的完整消息轨迹已经落库（`agent_run_messages`），
 * 「活动与审计」页可以从断点续跑，但那个页面不会主动告诉用户「刚才那次失败了」——
 * 于是用户常常以为分析跑完了、或者从头再点一次，白烧一遍 token。
 *
 * 数据来源是现成的 `GET /api/agent/runs`（`status`/`error` 已在
 * `AgentRunSummary` 里），判定只依赖 `status === 'error'`。
 *
 * 自动续跑（`GET /api/agent/retry`）：定时流水线因可重试错误失败后，服务端会自己
 * 在约 2 / 10 / 30 分钟后从落库的消息轨迹接着跑（最多 3 次、跨重启保留）。凡是已经
 * 被自动续跑接管的失败 run，这里**不再显示**「一键续跑」按钮 —— 手动点一下就是和
 * 服务端的自动重试并发跑同一条流水线，token 白烧两份；改为一句话告知
 * 「系统将在 X 自动续跑第 N/M 次（失败原因：…）」。
 *
 * 另一种「不该提示」的情况：自动续跑**成功**后，原 run 的 `status='error'` 是历史事实
 * 不会改写，服务端只往 `error` 文本末尾追加标记 `（已自动续跑：第 1/3 次，新运行 xxxxxxxx）`，
 * 新 run 以 `done` 出现在列表里。此时 `pending` 已为空，那条旧 error 行若还留在
 * 「未完成」列表里，用户会以为没跑完再点一次（服务端会用 409 拒绝，体验也差），
 * 因此 `selectResumableRuns` 还要按 `error` 里的 `已自动续跑` 标记二次过滤。
 */
import { useCallback, useMemo, useState } from 'react';

import type { AgentRunSummary } from '@aia/shared';

import { api, type AgentRetryPending, type AgentRetryState } from '../api/client';
import { useAgentActivity, useAgentRefresh } from '../api/agentActivity';
import { useAsync } from '../api/hooks';
import { fmtDateTime, fmtRelative } from '../format';
import { Alert, Badge, Button } from './ui';

/** 用户点过「忽略」的 run id（按浏览器持久化，避免反复打扰）。 */
const DISMISS_KEY = 'aia.resumable-runs.dismissed';
/** 一次最多展示几条，避免刷屏。 */
const MAX_SHOWN = 3;
/** 服务端没给出合法 `maxAttempts` 时的兜底（契约里固定是 3）。 */
const MAX_ATTEMPTS_FALLBACK = 3;

/**
 * 服务端「自动续跑已成功」后追加进 `run.error` 的标记（与
 * `packages/server/src/services/auto-retry.ts` 的 `AUTO_RESUMED_MARK` 保持一致）。
 */
export const AUTO_RESUMED_MARKER = '已自动续跑';

/**
 * 这条 run 是否已经被系统自动续跑成功过。
 *
 * 判据只能是 `error` 文本里的标记：成功后原 run 的 `status` 仍是 `'error'`（历史事实，
 * 服务端不改写），`pending` 也已清空。`error` 为 `null`（正常失败的 run 也可能没有
 * 错误文本）时必须安全返回 false，不能抛错。
 */
export function isAutoResumed(run: { error?: string | null }): boolean {
  return typeof run.error === 'string' && run.error.includes(AUTO_RESUMED_MARKER);
}

/**
 * 从未完成的运行里挑出可以**手动**续跑的（纯函数，便于单测）：
 *   · 只有 `status === 'error'` 的 run 才需要续跑（`done` 的会被服务端 409 拒绝）；
 *   · 用户忽略过的 id 不再出现；
 *   · 已被自动续跑接管的 id（`autoRetryRunIds`）必须排除，否则用户和自动重试会
 *     各跑一遍同一条流水线，token 烧两份（`autoRetryRunIds` 默认空数组 = 旧行为）；
 *   · `error` 里带「已自动续跑」标记的 run 也排除：自动续跑已经成功过，旧的 error 行
 *     只是历史记录，再提示手动续跑就是重复执行（服务端会 409）。
 */
export function selectResumableRuns(
  runs: AgentRunSummary[],
  dismissedIds: string[],
  autoRetryRunIds: string[] = [],
): AgentRunSummary[] {
  const dismissed = new Set(dismissedIds);
  const autoRetry = new Set(autoRetryRunIds);
  return runs.filter(
    (run) =>
      run.status === 'error' &&
      !dismissed.has(run.id) &&
      !autoRetry.has(run.id) &&
      !isAutoResumed(run),
  );
}

/**
 * 自动续跑状态的宽松归一化：只要服务端给了个对象就展示，字段缺失全部走兜底。
 * 返回 `null` = 「当前没有排队的自动续跑」（请求失败、老服务端 404、脏数据都算）。
 */
export function normalizePendingRetry(state: AgentRetryState | null | undefined): AgentRetryPending | null {
  const pending = state?.pending;
  if (!pending || typeof pending !== 'object') return null;
  return pending;
}

/**
 * 自动续跑的两句文案（纯函数，便于无头单测）：
 * 主句给出「下一次什么时候、第几次」，副句给出最近一次失败原因 —— 用户据此判断
 * 还值不值得等，而不是自己再点一次续跑。
 */
export function autoRetrySummary(pending: AgentRetryPending): { headline: string; detail: string } {
  const attempt = Number.isFinite(pending.attempt) && pending.attempt > 0 ? pending.attempt : 1;
  const max =
    Number.isFinite(pending.maxAttempts) && pending.maxAttempts > 0
      ? pending.maxAttempts
      : MAX_ATTEMPTS_FALLBACK;
  const error = typeof pending.lastError === 'string' ? pending.lastError.trim() : '';
  return {
    headline: `系统将在 ${fmtDateTime(pending.nextRunAt)} 自动续跑第 ${attempt}/${max} 次`,
    detail: `失败原因：${error || '未记录失败原因'}`,
  };
}

/**
 * 自动续跑的说明条（纯展示组件，便于 `renderToString` 单测）。
 *
 * 只负责「告知」：服务端已经排好队，用户什么都不用做。这里**绝不渲染**续跑按钮 ——
 * 手动续跑会和服务端的自动重试并发。`runTitles` 是列表里对应 run 的标题，
 * 拿不到时退回服务端给的 `taskNames`。
 */
export function AutoRetryNotice({
  pending,
  runTitles = [],
}: {
  pending: AgentRetryPending;
  runTitles?: string[];
}) {
  const { headline, detail } = autoRetrySummary(pending);
  // 服务端字段可能缺失（契约演进 / 脏数据）：这里一律按数组兜底，绝不让提示条崩掉。
  const backendNames: string[] = Array.isArray(pending.taskNames) ? pending.taskNames : [];
  const names =
    runTitles.length > 0
      ? runTitles
      : backendNames.filter((name) => typeof name === 'string' && name.trim().length > 0);
  const listed = names.slice(0, MAX_SHOWN);
  const rest = names.length - listed.length;
  return (
    <Alert tone="info">
      <div className="strong">
        <Badge tone="ai">自动续跑</Badge> {headline}
      </div>
      <div className="tiny mute mt-1">
        {detail}
        {pending.kind === 'pipeline'
          ? ' · 整条定时流水线会重新执行。'
          : ' · 服务端会从已保存的消息轨迹接着跑。'}
        {listed.length > 0 && ` 涉及：${listed.join('、')}${rest > 0 ? ` 等 ${names.length} 项` : ''}。`}
        {' '}
        这些运行由系统自动接续（服务重启也会继续），无需手动操作。
      </div>
    </Alert>
  );
}

/** localStorage 只在浏览器里存在：`renderToString`（无头测试）下必须安全降级。 */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readDismissed(): string[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(DISMISS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeDismissed(ids: string[]): void {
  const store = storage();
  if (!store) return;
  try {
    // 只留最近 50 条，避免 localStorage 无限增长。
    store.setItem(DISMISS_KEY, JSON.stringify(ids.slice(-50)));
  } catch {
    /* 隐私模式 / 存储被禁用：只在内存里生效 */
  }
}

export function InterruptedRunsAlert() {
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  // 续跑的推理过程同样显示在右下角全局面板里；运行结束后刷新列表。
  const runs = useAsync<AgentRunSummary[]>(() => api.agent.runs(20), []);
  // 自动续跑状态走**独立**的一路请求：它失败（旧服务端 404 / 网络抖动）时只当
  // 「没有排队」，绝不能连累下面基于 runs 的失败提示条。
  const retry = useAsync<AgentRetryState>(() => api.agent.retryState(), []);
  // 一条流结束后两个列表都要重拉：自动重试会新开 run 行，排队状态也会变。
  useAgentRefresh(() => {
    runs.reload();
    retry.reload();
  });
  const { run, running } = useAgentActivity();

  const pending = useMemo(() => normalizePendingRetry(retry.data), [retry.data]);
  const pendingRunIds = useMemo(() => pending?.failedRunIds ?? [], [pending]);

  const resumable = useMemo(
    () => selectResumableRuns(runs.data ?? [], dismissed, pendingRunIds),
    [runs.data, dismissed, pendingRunIds],
  );

  /** 已被自动续跑接管、且仍在运行列表里的 run（标题用来补全提示文案）。 */
  const autoRetrying = useMemo(() => {
    if (!pending || pendingRunIds.length === 0) return [];
    const ids = new Set(pendingRunIds);
    return (runs.data ?? []).filter((item) => ids.has(item.id));
  }, [pending, pendingRunIds, runs.data]);

  const dismiss = useCallback((ids: string[]) => {
    setDismissed((previous) => {
      const next = [...previous, ...ids.filter((id) => !previous.includes(id))];
      writeDismissed(next);
      return next;
    });
  }, []);

  const resume = useCallback(
    (target: AgentRunSummary) => {
      // 续跑会新开一条 run 行：旧的那条直接忽略掉，避免提示条一直挂着。
      dismiss([target.id]);
      run({
        path: `/agent/runs/${encodeURIComponent(target.id)}/resume`,
        title: `续跑 · ${target.title || target.kind}`,
      });
    },
    [dismiss, run],
  );

  // 自动续跑的信息条与「失败运行」是否还在无关：它说的是服务端的行为，
  // 即使那些 run 全被用户忽略（或被自动重试接管后从列表里消失）也要照常显示。
  if (resumable.length === 0 && !pending) return null;

  const shown = resumable.slice(0, MAX_SHOWN);
  const rest = resumable.length - shown.length;
  const autoRetryTitles = autoRetrying.map((item) => item.title || item.kind);

  return (
    <>
      {pending && <AutoRetryNotice pending={pending} runTitles={autoRetryTitles} />}

      {resumable.length > 0 && (
        <Alert tone="warn">
          <div className="flex between wrap gap-2">
            <div>
              <div className="strong">
                <Badge tone="warn">未完成</Badge> 有 {resumable.length} 条 AI 运行没有跑完
              </div>
              <div className="tiny mute mt-1">
                服务进程重启或上游超时都会把正在跑的分析标记为失败。消息轨迹已经存下来了，
                可以从断点续跑，不用从头再来。
              </div>
            </div>
            <Button size="sm" onClick={() => dismiss(resumable.map((item) => item.id))}>
              全部忽略
            </Button>
          </div>

          <div className="mt-2">
            {shown.map((item) => (
              <div className="flex between wrap center gap-2 mt-1" key={item.id}>
                <span className="small truncate" title={item.error ?? item.title}>
                  {item.title || item.kind}
                  <span className="tiny mute">
                    {' '}
                    · 开始于 {fmtRelative(item.startedAt)}
                    {item.turns > 0 ? ` · 已推理 ${item.turns} 轮` : ' · 尚未完成第 1 轮'}
                  </span>
                </span>
                <Button size="sm" variant="primary" disabled={running} onClick={() => resume(item)}>
                  {running ? '正在运行…' : '一键续跑'}
                </Button>
              </div>
            ))}
            {rest > 0 && <div className="tiny mute mt-1">还有 {rest} 条，去「活动与审计」页逐条续跑或忽略。</div>}
            {pendingRunIds.length > 0 && (
              <div className="tiny mute mt-1">
                另有 {pendingRunIds.length} 条失败运行已由系统排队自动续跑，故未列在这里；系统会自动接续，无需手动操作。
              </div>
            )}
          </div>
        </Alert>
      )}
    </>
  );
}
