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
 * `AgentRunSummary` 里），因此这里不需要任何新接口；判定只依赖 `status === 'error'`。
 */
import { useCallback, useMemo, useState } from 'react';

import type { AgentRunSummary } from '@aia/shared';

import { api } from '../api/client';
import { useAgentActivity, useAgentRefresh } from '../api/agentActivity';
import { useAsync } from '../api/hooks';
import { fmtRelative } from '../format';
import { Alert, Badge, Button } from './ui';

/** 用户点过「忽略」的 run id（按浏览器持久化，避免反复打扰）。 */
const DISMISS_KEY = 'aia.resumable-runs.dismissed';
/** 一次最多展示几条，避免刷屏。 */
const MAX_SHOWN = 3;

/**
 * 从未完成的运行里挑出可以续跑的（纯函数，便于单测）：
 * 只有 `status === 'error'` 的 run 才需要续跑（`done` 的会被服务端 409 拒绝），
 * 且用户忽略过的 id 不再出现。
 */
export function selectResumableRuns(runs: AgentRunSummary[], dismissedIds: string[]): AgentRunSummary[] {
  const dismissed = new Set(dismissedIds);
  return runs.filter((run) => run.status === 'error' && !dismissed.has(run.id));
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
  useAgentRefresh(runs.reload);
  const { run, running } = useAgentActivity();

  const resumable = useMemo(() => selectResumableRuns(runs.data ?? [], dismissed), [runs.data, dismissed]);

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

  if (resumable.length === 0) return null;

  const shown = resumable.slice(0, MAX_SHOWN);
  const rest = resumable.length - shown.length;

  return (
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
      </div>
    </Alert>
  );
}
