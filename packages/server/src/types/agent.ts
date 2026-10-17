/**
 * Agent seam — how HTTP routes drive the LLM/tool loop.
 *
 * Owned by: Lead (frozen contract). Implemented by `agent-engine` in
 * `../agent/runtime.ts` (`createAgent`).
 */
import type { AgentEvent, AgentRun, AgentRunKind, ChatMessage, ToolRisk } from '@aia/shared';

/** Push one SSE event to the client. Must never throw. */
export type EventSink = (event: AgentEvent) => void;

export interface ToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments (OpenAI function-calling format). */
  parameters: Record<string, unknown>;
  /** Run kinds allowed to call this tool; `undefined` = every kind. */
  kinds?: AgentRunKind[];
  /** P1-1: read / external (network) / write — drives policy, audit, approval. */
  risk?: ToolRisk;
  /** P1-2: set for tools provided by an MCP server (`mcp__<server>__<tool>`). */
  source?: string;
  /**
   * P3: 只能由流水线/系统调用的工具（例如按退役次数清理标的）——`executeTool`
   * 仍可执行、策略与审计照常生效，但**不会**出现在发给模型的工具表里。
   */
  systemOnly?: boolean;
}

export interface AgentRunRequest {
  kind: AgentRunKind;
  /** Short human title, e.g. "AI 资产分析". */
  title: string;
  /** The user-visible objective handed to the model. */
  goal: string;
  /** Entity the run belongs to (`asset:<id>`, `watch:<id>`, `batch:<id>`…). */
  target?: string | null;
  /** Required for `chat` runs: the conversation so far (oldest first). */
  messages?: ChatMessage[];
  /** Runtime knobs. */
  maxTurns?: number;
  /** SSE sink; omit for background/scheduled runs (events are still persisted). */
  sink?: EventSink;
  /** Session id for chat runs (persisted transcript). */
  sessionId?: string;
  /** P0-2: aborts the run (client disconnected / user pressed stop). */
  signal?: AbortSignal;
  /** P1-3: continue a previously interrupted run from its stored transcript. */
  resumeRunId?: string;
  /**
   * Hint for pipelines: entities the run is allowed to create/modify.
   * Enforced by the tool layer, not by the model.
   */
  allowWrites?: Array<'asset' | 'watchlist' | 'advice' | 'briefing' | 'settings' | 'ipo'>;
}

export interface AgentRuntime {
  /** False when no LLM API key/base URL is configured. */
  isConfigured(): boolean;
  /** Tool catalogue exposed via `GET /api/agent/tools` and the LLM request. */
  tools(): ToolDescriptor[];
  /** Runs the loop to completion (never rejects: failures land in `run.status`). */
  run(request: AgentRunRequest): Promise<AgentRun>;
  /** P1-3: continues an interrupted / capped run from its stored transcript. */
  resume(runId: string, request?: Partial<AgentRunRequest>): Promise<AgentRun>;
}

export interface AgentDeps {
  /** Resolved lazily so tools always see the live repository. */
  getRepo: () => import('./repo.js').Repo;
  logger: LoggerLike;
  /** Absolute paths that the agent is allowed to read/write (data dir). */
  dataDir: string;
  /** Provider keys coming from the environment (fallback to stored settings). */
  providerKeys: Record<string, string>;
}

export interface LoggerLike {
  info: (msg: string, ...rest: unknown[]) => void;
  warn: (msg: string, ...rest: unknown[]) => void;
  error: (msg: string, ...rest: unknown[]) => void;
  debug: (msg: string, ...rest: unknown[]) => void;
}

/** 定时器注入点：默认用全局 `setTimeout/clearTimeout`，测试可换成假时钟。 */
export interface SchedulerTimers {
  setTimeout(fn: () => void, ms: number): { unref?: () => void };
  clearTimeout(handle: { unref?: () => void }): void;
}

/** Background scheduler seam (implemented by `agent-engine`). */
export interface SchedulerDeps {
  getRepo: () => import('./repo.js').Repo;
  agent: AgentRuntime;
  logger: LoggerLike;
  /** Invoked after every scheduled/manual pipeline run (for UI signalling). */
  onRunComplete?: (run: AgentRun) => void;
  /**
   * 定时器来源。测试传假实现即可精确控制触发时刻，**不需要**替换全局
   * `setTimeout` —— 那样会干扰同一进程里并行跑的其它测试（真实教训）。
   */
  timers?: SchedulerTimers;
  /** 当前时间（毫秒）。默认 `Date.now`，测试可注入假时钟。 */
  now?: () => number;
}

/** 单个定时任务的下次运行时间（`Scheduler.plan()` 的元素）。 */
export interface SchedulerPlanEntry {
  id: string;
  name: string;
  nextRunAt: string;
}

export interface Scheduler {
  /** Starts the in-process timer; safe to call when no task is enabled. */
  start(): void;
  stop(): void;
  /** Applies the current `settings.schedules` without restarting the process. */
  reload(): void;
  /** ISO timestamp of the next planned run (earliest task), or null when disabled. */
  nextRunAt(): string | null;
  /** 每个启用任务各自的下次运行时间（升序）；界面按任务展示。 */
  plan(): SchedulerPlanEntry[];
  /** Runs the full pipeline now (asset → watchlist → advice) and resolves it. */
  runPipeline(): Promise<AgentRun>;
}
