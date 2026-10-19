/**
 * Process-wide mutex for the AI pipelines (D3).
 *
 * Why a separate module: the scheduler used to be the only place with an
 * in-flight guard, so `POST /api/agent/run-now` (and the other three manual AI
 * routes) could run a second full pipeline in parallel with a scheduled tick —
 * producing two advice batches with different `batchId`s, duplicate
 * `aiSummary` writes and doubled token spend. Every pipeline entry point now
 * goes through {@link runExclusive}.
 *
 * Semantics:
 *  - non-blocking: a caller that finds the lock held gets `{ ok: false }`
 *    immediately (manual routes turn that into an SSE `error`, the scheduler
 *    skips the tick) — no queue build-up;
 *  - the lock is released in a `finally`, so a throwing pipeline can never wedge
 *    the process;
 *  - single-process only, which matches the single-container deployment model.
 *
 * Owner: agent-engine.
 */
export interface PipelineLockStatus {
  /** Human label of the holder, e.g. `scheduler:interval` / `manual:advice`. */
  label: string;
  startedAt: string;
}

/** Message surfaced to the user when a manual pipeline is rejected. */
export const PIPELINE_BUSY_MESSAGE = '已有 AI 流水线正在运行，请稍后再试';

/** Thrown by `Scheduler.runPipeline()` when a manual run holds the lock. */
export class PipelineBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineBusyError';
  }
}

export type ExclusiveResult<T> = { ok: true; value: T } | { ok: false; reason: string };

let current: PipelineLockStatus | null = null;

/** Snapshot of the current holder (for diagnostics / tests). */
export function pipelineLockStatus(): PipelineLockStatus | null {
  return current === null ? null : { ...current };
}

export function isPipelineRunning(): boolean {
  return current !== null;
}

/**
 * Runs `fn` while holding the pipeline lock.
 * Returns `{ ok: false, reason }` when another pipeline is already running.
 */
export async function runExclusive<T>(label: string, fn: () => Promise<T>): Promise<ExclusiveResult<T>> {
  if (current) {
    return {
      ok: false,
      reason: `${PIPELINE_BUSY_MESSAGE}（正在运行：${current.label}，开始于 ${current.startedAt}）`,
    };
  }
  const status: PipelineLockStatus = { label, startedAt: new Date().toISOString() };
  current = status;
  try {
    return { ok: true, value: await fn() };
  } finally {
    // Always release — success, throw, or early return.
    if (current === status) current = null;
  }
}

/** Convenience wrapper for the scheduler: throws instead of returning a flag. */
export async function runExclusiveOrThrow<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const outcome = await runExclusive(label, fn);
  if (!outcome.ok) throw new PipelineBusyError(outcome.reason);
  return outcome.value;
}
