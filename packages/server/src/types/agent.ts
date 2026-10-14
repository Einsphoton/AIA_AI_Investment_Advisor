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
  allowWrites?: Array<'asset' | 'watchlist' | 'advice' | 'briefing' | 'settings'>;
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

/** Background scheduler seam (implemented by `agent-engine`). */
export interface SchedulerDeps {
  getRepo: () => import('./repo.js').Repo;
  agent: AgentRuntime;
  logger: LoggerLike;
  /** Invoked after every scheduled/manual pipeline run (for UI signalling). */
  onRunComplete?: (run: AgentRun) => void;
}

export interface Scheduler {
  /** Starts the in-process timer; safe to call when `mode === 'off'`. */
  start(): void;
  stop(): void;
  /** Applies the current settings without restarting the process. */
  reload(): void;
  /** ISO timestamp of the next planned run, or null when disabled. */
  nextRunAt(): string | null;
  /** Runs the full pipeline now (asset → watchlist → advice) and resolves it. */
  runPipeline(): Promise<AgentRun>;
}
