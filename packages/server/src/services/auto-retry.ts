/**
 * 定时流水线失败后的**自动续跑**（auto-retry / self-heal）。
 *
 * 为什么需要：AI 流水线跑在 API 进程内（没有独立队列/worker），一次失败过去只会
 * `logger.error` 一句，然后等下一次定时触发 —— 每天 08:30 的任务失败就要等到
 * **第二天** 08:30；进程重启还会把正在跑的 run 标成 `error` 后不管。用户只能去
 * 「活动与审计」手动点「续跑」。
 *
 * 现在把「失败 → 等待 → 从持久化轨迹继续」做成确定性状态机：
 *
 *   · **可重试**：LLM 429 / 5xx / 网络 / 超时 / 空响应（客户端内部重试用尽后）、
 *     轮次上限、进程被中断、未知的暂时性错误 → 按 2 / 10 / 30 分钟退避续跑，最多 3 次；
 *   · **不可重试**：未配置 API Key、401/403 认证失败、402 余额不足、404 接口/模型
 *     不存在、用户取消、没有可续跑的轨迹 —— 重试只会重复同样的失败；
 *   · 续跑走 **`AgentRuntime.resume()`**（`agent_run_messages` 轨迹），不是从头重跑，
 *     已完成的阶段不会被再次计费；
 *   · 状态落在 SQLite `kv` 里（`scheduler:autoRetry` / `scheduler:inFlight`），
 *     进程重启后能接着等/接着跑 —— 这是「部署在服务器上」场景的关键。
 *
 * 本模块只做**纯判定 + 持久化**，定时器与执行在 `services/scheduler.ts`。
 *
 * Owner: agent-engine.
 */
import type { AgentRun, AgentRunKind } from '@aia/shared';

import type { Repo } from '../types/repo.js';
import type { PipelineStepFlags } from './schedule.js';

/** 一次失败最多自动续跑几次（第 1/2/3 次）。 */
export const AUTO_RETRY_MAX_ATTEMPTS = 3;
/** 第 1/2/3 次续跑前的等待（毫秒）：2 分钟 → 10 分钟 → 30 分钟。 */
export const AUTO_RETRY_DELAYS_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000] as const;
/** 进程重启后，发现「上次定时流水线被中断」时先等这么久再自愈（等服务完全就绪）。 */
export const AUTO_RETRY_BOOT_DELAY_MS = 45_000;
/** 续跑到期时若手工流水线正持锁（同一把进程级锁），延后这么久重试，**不消耗**次数。 */
export const AUTO_RETRY_BUSY_DELAY_MS = 2 * 60_000;

/** 持久化键：当前待执行的续跑任务。 */
export const AUTO_RETRY_KV_KEY = 'scheduler:autoRetry';
/** 持久化键：正在跑的定时流水线（进程若在此间退出，启动时据此自愈）。 */
export const IN_FLIGHT_KV_KEY = 'scheduler:inFlight';

/**
 * 自动续跑成功时追加到**原失败 run** `error` 文案里的标记。
 *
 * 原 run 的状态保持 `error`（历史事实、已烧的 token 不回滚），但加一句说明，让：
 *   · 前端「未完成」提示条不再劝用户手动再续跑一次（`/已自动续跑/` 过滤）；
 *   · `POST /api/agent/runs/:id/resume` 拒绝重复续跑（否则会拿同一份轨迹再跑一遍）。
 */
export const AUTO_RESUMED_MARK = '已自动续跑';

/** `resume` = 从失败 run 的轨迹继续；`pipeline` = 找不到可续跑轨迹时整条流水线重跑一次。 */
export type RetryKind = 'resume' | 'pipeline';

/** 一条待执行的自动续跑任务（整条 JSON 落 `kv`，所以字段都要能序列化）。 */
export interface RetryJob {
  kind: RetryKind;
  /** 即将执行的那一次（1-based）。 */
  attempt: number;
  /** 下一次尝试的时刻（epoch ms）。 */
  nextAttemptAt: number;
  /** `resume` 要续跑的失败 run id（按流水线阶段顺序）。 */
  failedRunIds: string[];
  /** 触发这条流水线的定时任务（日志 / 界面展示用）。 */
  taskIds: string[];
  taskNames: string[];
  /** 原始步骤开关：整条流水线重跑时使用。 */
  flags: PipelineStepFlags;
  /**
   * 进程中断自愈专用：续跑完被中断的阶段后，还要补跑这次流水线**没来得及执行**的阶段。
   *
   * 值为「原始 flags 再跳过已完成阶段」后的开关；执行时会再跳过本次已成功 resume 的
   * 阶段。只在启动自愈创建的任务里出现（正常运行失败时所有阶段都已执行过，不需要）。
   */
  followUpFlags?: PipelineStepFlags;
  /** 最近一次失败原因（界面展示 / 诊断）。 */
  lastError: string;
  /** 本任务创建时间（ISO）：进程重启时用来定位「这次尝试产生的 stale run」。 */
  createdAt: string;
}

/** 定时流水线开始执行前落盘的标记。 */
export interface InFlightMarker {
  startedAt: string;
  taskIds: string[];
  taskNames: string[];
  flags: PipelineStepFlags;
}

/** 失败分类结果：`retryable` 为真才会自动续跑。 */
export interface FailureVerdict {
  retryable: boolean;
  class: 'retryable' | 'fatal' | 'cancelled';
  /** 面向日志/界面的简短中文原因。 */
  reason: string;
}

/** 这条运行是否已经被系统自动续跑成功（见 {@link AUTO_RESUMED_MARK}）。 */
export function hasAutoResumedMark(error: string | null | undefined): boolean {
  return (error ?? '').includes(AUTO_RESUMED_MARK);
}

/**
 * 自动续跑成功后，在原失败 run 的 `error` 末尾追加一句说明（幂等）。
 *
 * 只做 best effort：写失败不影响续跑结果，最坏情况是用户还可能手动再点一次
 * （`POST /resume` 仍会跑同一份轨迹）。
 */
export function markAutoResumed(
  repo: Repo,
  originalRunId: string,
  newRunId: string,
  attempt: number,
): void {
  try {
    const run = repo.getRun(originalRunId);
    if (!run || hasAutoResumedMark(run.error)) return;
    const suffix = `（${AUTO_RESUMED_MARK}：第 ${attempt}/${AUTO_RETRY_MAX_ATTEMPTS} 次，新运行 ${newRunId.slice(0, 8)}）`;
    repo.updateRun(originalRunId, { error: `${run.error ?? ''}${run.error ? ' ' : ''}${suffix}` });
  } catch {
    /* 标记是便利信息，绝不能影响续跑本身 */
  }
}

/**
 * 不可重试的错误特征。顺序有意义：先判 fatal，再判可取消/可重试。
 *
 * 这些字符串来自 `agent/llm.ts`（`readableHttpError` / `NOT_CONFIGURED_MESSAGE`）、
 * `agent/loop.ts`（`CANCELLED_ERROR` / 轮次上限）、`index.ts`（`STALE_RUN_MESSAGE`）
 * 与 `agent/runtime.ts`（resume 无轨迹）。改文案时这里必须同步 —— 有单测覆盖。
 */
const FATAL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /未配置 API Key/, reason: '未配置 API Key' },
  { pattern: /认证失败|HTTP 401|HTTP 403/, reason: '认证失败（Key 或权限问题）' },
  { pattern: /账户余额或套餐额度不足|HTTP 402/, reason: '账户余额/套餐额度不足' },
  { pattern: /接口不存在|HTTP 404/, reason: '接口/模型不存在（检查 baseUrl 与模型名）' },
  { pattern: /没有可续跑的轨迹/, reason: '没有可续跑的持久化轨迹' },
];

/** 明确的暂时性错误（只影响日志里的原因标签；默认也是可重试）。 */
const TRANSIENT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /触发限流|HTTP 429/, reason: 'LLM 限流（429）' },
  { pattern: /上游错误|HTTP 5\d\d/, reason: 'LLM 上游错误（5xx）' },
  { pattern: /请求失败|fetch failed|socket hang up|连接|超时|timeout|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/, reason: '网络/上游暂时不可用' },
  { pattern: /空响应|empty response/i, reason: 'LLM 返回空响应' },
  { pattern: /达到最大推理轮次/, reason: '达到推理轮次上限（续跑会追加轮次）' },
  { pattern: /运行被中断/, reason: '进程中断（轨迹已落库，可续跑）' },
];

/** 单条错误文本 → 失败分类。 */
export function classifyErrorMessage(raw: string | null | undefined): FailureVerdict {
  const message = (raw ?? '').trim();
  if (message === '') return { retryable: true, class: 'retryable', reason: '未知错误（无错误信息）' };
  if (/^已取消/.test(message)) return { retryable: false, class: 'cancelled', reason: '用户已取消，不自动续跑' };
  for (const rule of FATAL_PATTERNS) {
    if (rule.pattern.test(message)) return { retryable: false, class: 'fatal', reason: rule.reason };
  }
  for (const rule of TRANSIENT_PATTERNS) {
    if (rule.pattern.test(message)) return { retryable: true, class: 'retryable', reason: rule.reason };
  }
  // 未知错误保守重试：次数有上限（默认 3 次），且续跑前会等 2/10/30 分钟，
  // 不会把「配置错误」变成无限重试风暴。
  return { retryable: true, class: 'retryable', reason: '暂时性错误' };
}

/** 一个失败的 agent run → 失败分类。 */
export function classifyRunFailure(run: Pick<AgentRun, 'status' | 'error'>): FailureVerdict {
  if (run.status !== 'error') return { retryable: false, class: 'fatal', reason: '运行未失败' };
  return classifyErrorMessage(run.error);
}

/** 流水线在进入阶段前就抛出的错误（不是某个 run 的 `run.error`）→ 失败分类。 */
export function classifyPipelineError(error: unknown): FailureVerdict {
  const message = error instanceof Error ? error.message : String(error);
  if (/未勾选任何步骤|未产生任何运行记录/.test(message)) {
    return { retryable: false, class: 'fatal', reason: message };
  }
  return classifyErrorMessage(message);
}

/**
 * 第 `attempt` 次（1-based）续跑前的等待。
 *
 * 以 2/10/30 分钟为基准加 ±15% 抖动，避免多实例/多次失败在同一秒一起打上游；
 * 下限 30 秒。测试通过 `random` 注入固定值消除抖动。
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(0, Math.floor(attempt) - 1), AUTO_RETRY_DELAYS_MS.length - 1);
  const base = AUTO_RETRY_DELAYS_MS[index]!;
  const jitter = (random() * 2 - 1) * 0.15;
  return Math.max(30_000, Math.round(base * (1 + jitter)));
}

/** 步骤开关 → 这次流水线会产生的 run kind（启动自愈时按它筛选被中断的 run）。 */
export function kindsForFlags(flags: PipelineStepFlags): AgentRunKind[] {
  const kinds: AgentRunKind[] = [];
  if (!flags.skipAsset) kinds.push('asset-analysis');
  if (!flags.skipWatchlist) kinds.push('watchlist-analysis');
  if (!flags.skipIpo) kinds.push('ipo-analysis');
  if (!flags.skipOption) kinds.push('option-advice');
  if (!flags.skipAdvice) kinds.push('advice');
  return kinds;
}

/** run kind → 对应的步骤开关字段。 */
const KIND_SKIP_FIELD: Record<AgentRunKind, keyof PipelineStepFlags> = {
  'asset-analysis': 'skipAsset',
  'watchlist-analysis': 'skipWatchlist',
  'ipo-analysis': 'skipIpo',
  'option-advice': 'skipOption',
  advice: 'skipAdvice',
  scheduled: 'skipAsset', // 兜底：不会命中，避免类型漏项
  chat: 'skipAsset',
  custom: 'skipAsset',
};

/** 在 `flags` 基础上再把 `kinds` 这些阶段标成跳过（不改原对象）。 */
export function skipFlagsFor(
  flags: PipelineStepFlags,
  kinds: Iterable<AgentRunKind | string>,
): PipelineStepFlags {
  const next: PipelineStepFlags = { ...flags };
  for (const kind of kinds) {
    const field = KIND_SKIP_FIELD[kind as AgentRunKind];
    if (field) next[field] = true;
  }
  return next;
}

/** 这组开关里是否还有阶段要跑。 */
export function hasAnyStep(flags: PipelineStepFlags): boolean {
  return !flags.skipAsset || !flags.skipWatchlist || !flags.skipIpo || !flags.skipOption || !flags.skipAdvice;
}

/** 面向日志/界面的一句话描述。 */
export function describeRetryJob(job: RetryJob): string {
  const target = job.kind === 'resume' ? `${job.failedRunIds.length} 个失败阶段` : '整条流水线';
  const tasks = job.taskNames.length > 0 ? `：${job.taskNames.join('、')}` : '';
  return `第 ${job.attempt}/${AUTO_RETRY_MAX_ATTEMPTS} 次自动续跑（${target}${tasks}）`;
}

/* ────────────────────────────── 持久化 ─────────────────────────────────── */

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isFlags(value: unknown): value is PipelineStepFlags {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.skipAsset === 'boolean' &&
    typeof record.skipWatchlist === 'boolean' &&
    typeof record.skipIpo === 'boolean' &&
    typeof record.skipOption === 'boolean' &&
    typeof record.skipAdvice === 'boolean'
  );
}

function readKvJson<T>(repo: Repo, key: string, guard: (value: unknown) => value is T): T | null {
  try {
    const raw = repo.getKv(key);
    if (!raw || raw === 'null') return null;
    const parsed: unknown = JSON.parse(raw);
    return guard(parsed) ? parsed : null;
  } catch {
    // 坏数据等于没有：自动续跑是增强能力，绝不能让它拖垮调度器。
    return null;
  }
}

function isRetryJob(value: unknown): value is RetryJob {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    (record.kind === 'resume' || record.kind === 'pipeline') &&
    typeof record.attempt === 'number' &&
    Number.isFinite(record.attempt) &&
    record.attempt >= 1 &&
    typeof record.nextAttemptAt === 'number' &&
    Number.isFinite(record.nextAttemptAt) &&
    isStringArray(record.failedRunIds) &&
    isStringArray(record.taskIds) &&
    isStringArray(record.taskNames) &&
    isFlags(record.flags) &&
    (record.followUpFlags === undefined || isFlags(record.followUpFlags)) &&
    typeof record.lastError === 'string' &&
    typeof record.createdAt === 'string'
  );
}

function isInFlightMarker(value: unknown): value is InFlightMarker {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.startedAt === 'string' &&
    isStringArray(record.taskIds) &&
    isStringArray(record.taskNames) &&
    isFlags(record.flags)
  );
}

export function loadRetryJob(repo: Repo): RetryJob | null {
  return readKvJson(repo, AUTO_RETRY_KV_KEY, isRetryJob);
}

/** 写入（`null` = 清除）。持久化失败只记在调用方日志里，不抛。 */
export function saveRetryJob(repo: Repo, job: RetryJob | null): void {
  try {
    repo.setKv(AUTO_RETRY_KV_KEY, JSON.stringify(job));
  } catch {
    /* kv 写失败时内存状态仍然有效（本次进程内会继续按计划续跑） */
  }
}

export function loadInFlight(repo: Repo): InFlightMarker | null {
  return readKvJson(repo, IN_FLIGHT_KV_KEY, isInFlightMarker);
}

export function saveInFlight(repo: Repo, marker: InFlightMarker): void {
  try {
    repo.setKv(IN_FLIGHT_KV_KEY, JSON.stringify(marker));
  } catch {
    /* 自愈只是兜底：标记写不进去不该影响本次流水线 */
  }
}

export function clearInFlight(repo: Repo): void {
  try {
    repo.setKv(IN_FLIGHT_KV_KEY, 'null');
  } catch {
    /* best effort */
  }
}
