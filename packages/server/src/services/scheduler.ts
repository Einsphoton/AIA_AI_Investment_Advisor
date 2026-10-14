/**
 * Background scheduler — implements the frozen `Scheduler` interface.
 *
 * Modes (settings.schedule): `off` | `interval` | `daily` (`HH:mm` local time).
 * Guarantees: never two overlapping pipeline runs, `nextRunAt()` is an ISO
 * timestamp or null, `reload()` applies new settings without a restart.
 *
 * The created instance is published through {@link getActiveScheduler} (module
 * singleton) *and* registered in `registry.ts` by `index.ts`, so route modules
 * can always report the **real** plan instead of re-deriving it from settings.
 *
 * Since task-13 the tick also shares the process-wide pipeline lock
 * (`services/pipeline-lock.ts`) with the four manual AI routes, so a scheduled
 * run and a manual run can never overlap; a held lock makes the tick *skip*
 * (and `nextRunAt()` never reports an instant in the past).
 *
 * Owner: agent-engine.
 */
import { DEFAULT_SCHEDULE, type AgentRun, type ScheduleConfig } from '@aia/shared';
import type { Scheduler, SchedulerDeps } from '../types/agent.js';
import { runFullPipeline, scheduleFlags } from './advice.js';
import type { PipelineContext } from './analytics.js';
import { PipelineBusyError, runExclusiveOrThrow } from './pipeline-lock.js';

/** setTimeout overflows above 2^31-1 ms, so long waits are re-armed. */
const MAX_TIMEOUT_MS = 2_147_000_000;

/**
 * The live scheduler instance.
 *
 * `registry.ts#setScheduler()` is the primary seam, but it is wired in
 * `index.ts` *after* startup; this module-level reference guarantees that
 * `routes/settings.ts` and `routes/dashboard.ts` always see the very same
 * instance even during a boot race (or in a test that only calls
 * `createScheduler`).
 */
let activeScheduler: Scheduler | null = null;

/** The running scheduler, or null when the process never created one. */
export function getActiveScheduler(): Scheduler | null {
  return activeScheduler;
}

function parseDailyTime(value: string): { hours: number; minutes: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim());
  if (!match) return { hours: 8, minutes: 30 };
  const hours = Math.min(23, Math.max(0, Number.parseInt(match[1]!, 10)));
  const minutes = Math.min(59, Math.max(0, Number.parseInt(match[2]!, 10)));
  return { hours, minutes };
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextAtMs: number | null = null;
  let running: Promise<AgentRun> | null = null;

  function schedule(): ScheduleConfig {
    try {
      return deps.getRepo().getSettings().schedule ?? DEFAULT_SCHEDULE;
    } catch {
      return DEFAULT_SCHEDULE;
    }
  }

  /** Next fire time relative to `from`. */
  function computeNext(from = Date.now()): number | null {
    const settings = schedule();
    if (settings.mode === 'off') return null;
    if (settings.mode === 'interval') {
      const minutes = Math.max(1, Math.floor(settings.intervalMinutes || DEFAULT_SCHEDULE.intervalMinutes));
      return from + minutes * 60_000;
    }
    const { hours, minutes } = parseDailyTime(settings.dailyTime);
    const next = new Date(from);
    next.setHours(hours, minutes, 0, 0);
    if (next.getTime() <= from) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function arm(): void {
    clearTimer();
    nextAtMs = computeNext();
    if (nextAtMs === null) return;
    const delay = Math.max(1000, nextAtMs - Date.now());
    timer = setTimeout(() => {
      void tick();
    }, Math.min(delay, MAX_TIMEOUT_MS));
    timer.unref?.();
  }

  function context(): PipelineContext {
    return { agent: deps.agent, repo: deps.getRepo(), logger: deps.logger };
  }

  async function runPipeline(): Promise<AgentRun> {
    if (running) {
      deps.logger.warn('scheduler: a pipeline is already running, reusing the in-flight run');
      return running;
    }
    const repo = deps.getRepo();
    const task = (async (): Promise<AgentRun> => {
      try {
        // Shared lock with the manual AI routes (task-13 / D3): a manual run in
        // flight makes this tick skip instead of starting a second pipeline.
        return await runExclusiveOrThrow(`scheduler:${schedule().mode}`, async () => {
          const run = await runFullPipeline(context(), scheduleFlags(repo));
          try {
            repo.saveSettings({ lastRunAt: new Date().toISOString() });
          } catch {
            /* settings write is best effort */
          }
          try {
            deps.onRunComplete?.(run);
          } catch (error) {
            deps.logger.warn(`scheduler onRunComplete failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          return run;
        });
      } finally {
        running = null;
      }
    })();
    running = task;
    return task;
  }

  async function tick(): Promise<void> {
    try {
      if (running) {
        deps.logger.warn('scheduler: previous run still in progress, skipping this tick');
      } else {
        const run = await runPipeline();
        deps.logger.info(`scheduler: pipeline finished (${run.status}) in ${run.turns} turns`);
      }
    } catch (error) {
      if (error instanceof PipelineBusyError) {
        deps.logger.warn(`scheduler: skipped this tick — ${error.message}`);
      } else {
        deps.logger.error(`scheduler: pipeline failed — ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      arm();
    }
  }

  /**
   * Never reports an instant in the past (D7): while a fired tick's pipeline is
   * still running, `nextAtMs` holds the trigger time, so we project the *next*
   * planned slot from now instead. Before the trigger the value stays frozen
   * (the real timer), and after `arm()` it is the freshly computed plan.
   */
  function nextRunAtIso(): string | null {
    if (nextAtMs === null) return null;
    if (nextAtMs <= Date.now()) {
      const projected = computeNext();
      return projected === null ? null : new Date(projected).toISOString();
    }
    return new Date(nextAtMs).toISOString();
  }

  const scheduler: Scheduler = {
    start(): void {
      const settings = schedule();
      arm();
      if (settings.mode === 'off') deps.logger.info('scheduler: disabled (mode=off)');
      else deps.logger.info(`scheduler: mode=${settings.mode}, next run at ${nextRunAtIso()}`);
    },
    stop(): void {
      clearTimer();
      nextAtMs = null;
    },
    /**
     * Re-reads `settings.schedule` and re-arms from now: mode switches
     * (off ⇄ interval ⇄ daily), interval changes and `dailyTime` changes all take
     * effect immediately. `arm()` always clears the previous timer first, so no
     * duplicate timers can accumulate; `nextRunAt()` reflects the new plan.
     */
    reload(): void {
      const settings = schedule();
      arm();
      deps.logger.info(`scheduler: reloaded (mode=${settings.mode}, next=${nextRunAtIso() ?? 'null'})`);
    },
    nextRunAt(): string | null {
      return nextRunAtIso();
    },
    runPipeline,
  };

  // Two independent seams (registry + module singleton) so neither a boot race
  // nor a missing `setScheduler()` call can leave the UI guessing.
  activeScheduler = scheduler;
  return scheduler;
}
