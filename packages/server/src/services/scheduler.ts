/**
 * Background scheduler — implements the frozen `Scheduler` interface.
 *
 * 现在排程的是**一组**定时任务（`settings.schedules: ScheduleTask[]`），每个任务自带
 * 触发方式（`interval` / `daily`）与要跑的步骤；停用用任务自己的 `enabled`：
 *
 *   · 只维护**一个** setTimeout，永远指向所有启用任务里最近的那次触发；
 *   · 同一时刻到期的多个任务合并成**一次**流水线（步骤取并集），跑完再各自重排 ——
 *     既不会同一秒跑两遍重量级分析，也不会因为某个任务而丢掉其它任务；
 *   · `nextRunAt()` 仍然是「最近一次」（向后兼容），`plan()` 给出每个任务各自的计划；
 *   · 进程级流水线锁（`services/pipeline-lock.ts`）与四个手工 AI 路由共享，定时与手工
 *     永远不会并发，抢不到锁的这一跳直接跳过（`nextRunAt()` 也绝不报告过去的时间）。
 *
 * The created instance is published through {@link getActiveScheduler} (module
 * singleton) *and* registered in `registry.ts` by `index.ts`, so route modules
 * can always report the **real** plan instead of re-deriving it from settings.
 *
 * Owner: agent-engine.
 */
import type { AgentRun, ScheduleTask } from '@aia/shared';

import type { Scheduler, SchedulerDeps, SchedulerPlanEntry, SchedulerTimers } from '../types/agent.js';
import { runFullPipeline } from './advice.js';
import { trackAdviceOutcomes } from './advice-outcomes.js';
import type { PipelineContext } from './analytics.js';
import { PipelineBusyError, runExclusiveOrThrow } from './pipeline-lock.js';
import { describeTask, mergeTaskFlags, nextFireAt, taskStepLabels } from './schedule.js';

/** setTimeout overflows above 2^31-1 ms, so long waits are re-armed. */
const MAX_TIMEOUT_MS = 2_147_000_000;
/** 到期判定容差：定时器提前/延迟几毫秒都算这一跳。 */
const DUE_TOLERANCE_MS = 2_000;

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

interface TrackedTask {
  task: ScheduleTask;
  /** 本任务的计划触发时间（毫秒）。 */
  nextAtMs: number;
  /** 触发方式签名：变了就重算计划，没变就保留原触发时间。 */
  signature: string;
}

/** 决定一个任务的计划是否需要重算（触发方式或间隔/时间变了）。 */
function signatureOf(task: ScheduleTask): string {
  return `${task.mode}|${task.intervalMinutes}|${task.dailyTime}`;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? (() => Date.now());
  const timers: SchedulerTimers =
    deps.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  let timer: { unref?: () => void } | null = null;
  /** 本次定时器是**为哪个时刻**武装的；到期判定用它而不是 `Date.now()`。 */
  let armedForMs: number | null = null;
  const tracked = new Map<string, TrackedTask>();
  let running: Promise<AgentRun> | null = null;

  function schedules(): ScheduleTask[] {
    try {
      return deps.getRepo().getSettings().schedules ?? [];
    } catch {
      return [];
    }
  }

  /** 按当前设置重建跟踪表：保留未变任务的计划，新增/变更的任务从现在起算。 */
  function syncTasks(from = now()): void {
    const next = new Map<string, TrackedTask>();
    for (const task of schedules()) {
      if (!task?.enabled) continue;
      const signature = signatureOf(task);
      const previous = tracked.get(task.id);
      // 计划不变的任务保留原触发时间（否则每次保存设置都会把间隔往后推）。
      const keep = previous && previous.signature === signature && previous.nextAtMs > from ? previous.nextAtMs : null;
      const nextAtMs = keep ?? nextFireAt(task, from);
      if (nextAtMs === null) continue;
      next.set(task.id, { task, nextAtMs, signature });
    }
    tracked.clear();
    for (const [id, entry] of next) tracked.set(id, entry);
  }

  /** 跟踪表里最早的一次触发（毫秒）。 */
  function earliestMs(): number | null {
    let earliest: number | null = null;
    for (const entry of tracked.values()) {
      if (earliest === null || entry.nextAtMs < earliest) earliest = entry.nextAtMs;
    }
    return earliest;
  }

  function clearTimer(): void {
    if (timer) {
      timers.clearTimeout(timer);
      timer = null;
    }
  }

  function arm(): void {
    clearTimer();
    const earliest = earliestMs();
    armedForMs = earliest;
    if (earliest === null) return;
    const delay = Math.max(1000, earliest - now());
    timer = timers.setTimeout(() => {
      void tick();
    }, Math.min(delay, MAX_TIMEOUT_MS));
    timer.unref?.();
  }

  function context(): PipelineContext {
    return { agent: deps.agent, repo: deps.getRepo(), logger: deps.logger };
  }

  /**
   * 到期任务，按计划时间升序。
   *
   * `reference` 取**定时器武装时的计划时刻**而不是 `Date.now()`：定时器就是为那个时刻
   * 设的，这一跳必须算到期 —— 否则提前触发的场景（或时钟回拨）会把任务判成未到期而跳过。
   * 进程被挂起导致晚触发时与 `Date.now()` 取大者，把这段时间里到期的任务一起补跑。
   */
  function dueTasks(reference = now()): TrackedTask[] {
    const cutoff = Math.max(reference, now()) + DUE_TOLERANCE_MS;
    return [...tracked.values()]
      .filter((entry) => entry.nextAtMs <= cutoff)
      .sort((a, b) => a.nextAtMs - b.nextAtMs);
  }

  /** 跑完（或跳过）后重排这些任务：从**现在**起算，与旧版「间隔从上次跑完算起」一致。 */
  function rearm(entries: TrackedTask[]): void {
    const from = now();
    for (const entry of entries) {
      const current = tracked.get(entry.task.id);
      if (!current) continue;
      const nextAtMs = nextFireAt(entry.task, from);
      if (nextAtMs === null) tracked.delete(entry.task.id);
      else current.nextAtMs = nextAtMs;
    }
  }

  /**
   * 执行给定任务（步骤取并集）。同一时刻到期的多个任务只跑一次流水线；
   * `running` 兜住「上一跳还没跑完」的情况，进程级锁兜住与手工运行并发的情况。
   */
  async function runTasks(tasks: ScheduleTask[]): Promise<AgentRun> {
    if (running) {
      deps.logger.warn('scheduler: a pipeline is already running, reusing the in-flight run');
      return running;
    }
    const label = tasks.map((task) => task.id).join(',') || 'manual';
    const pipeline = (async (): Promise<AgentRun> => {
      try {
        return await runExclusiveOrThrow(`scheduler:${label}`, async () => {
          const run = await runFullPipeline(context(), mergeTaskFlags(tasks));
          try {
            deps.getRepo().saveSettings({ lastRunAt: new Date().toISOString() });
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
    running = pipeline;
    return pipeline;
  }

  async function tick(): Promise<void> {
    const due = dueTasks(armedForMs ?? now());
    try {
      // 旁路能力：先刷新「建议结果追踪」。确定性、不调用 LLM，失败也不影响流水线。
      try {
        await trackAdviceOutcomes({ repo: deps.getRepo(), logger: deps.logger });
      } catch (error) {
        deps.logger.warn(
          `scheduler: advice outcome tracking failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (due.length === 0) {
        deps.logger.warn('scheduler: tick without a due task (settings changed mid-flight), re-arming');
      } else if (running) {
        deps.logger.warn('scheduler: previous run still in progress, skipping this tick');
      } else {
        const tasks = due.map((entry) => entry.task);
        deps.logger.info(
          `scheduler: firing ${tasks.length} task(s) — ${tasks
            .map((task) => `${task.name || task.id}(${describeTask(task)}：${taskStepLabels(task).join('+') || '无步骤'})`)
            .join('、')}`,
        );
        const run = await runTasks(tasks);
        deps.logger.info(`scheduler: pipeline finished (${run.status}) in ${run.turns} turns`);
      }
    } catch (error) {
      if (error instanceof PipelineBusyError) {
        deps.logger.warn(`scheduler: skipped this tick — ${error.message}`);
      } else {
        deps.logger.error(`scheduler: pipeline failed — ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      // 无论成功、跳过还是失败都要重排这一跳到期的任务，否则它们会永远卡在过去
      // （`syncTasks` 只在保存设置时重算，而计划本身就停留在过去）。
      rearm(due);
      arm();
    }
  }

  /**
   * 每个启用任务的下次触发。正在运行的那一跳会按「从现在重排」投影，
   * 因此 `nextRunAt()` 永远不报告过去的时间（D7 回归护栏）。
   */
  function planEntries(): SchedulerPlanEntry[] {
    const current = now();
    return [...tracked.values()]
      .map((entry) => {
        const at = entry.nextAtMs > current ? entry.nextAtMs : nextFireAt(entry.task, current) ?? entry.nextAtMs;
        return { id: entry.task.id, name: entry.task.name, nextRunAt: new Date(Math.max(at, current)).toISOString() };
      })
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
  }

  const scheduler: Scheduler = {
    start(): void {
      syncTasks();
      arm();
      const tasks = tracked.size;
      if (tasks === 0) deps.logger.info('scheduler: no enabled tasks');
      else deps.logger.info(`scheduler: ${tasks} task(s) enabled, next run at ${scheduler.nextRunAt()}`);
    },
    stop(): void {
      clearTimer();
      tracked.clear();
    },
    /**
     * 重新读取 `settings.schedules` 并重新排程：新增 / 删除 / 启停 / 改间隔 / 改时间
     * 都立即生效；未变更任务的下次触发时间保持不变（不会被每次保存往后推）。
     */
    reload(): void {
      const before = earliestMs();
      syncTasks();
      arm();
      const after = earliestMs();
      const detail = [...tracked.values()]
        .map((entry) => `${entry.task.name || entry.task.id}=${describeTask(entry.task)}`)
        .join('、');
      deps.logger.info(
        `scheduler: reloaded (${tracked.size} task(s)${detail ? `：${detail}` : ''}, next=${scheduler.nextRunAt() ?? 'null'}${
          before !== after ? ', plan changed' : ''
        })`,
      );
    },
    nextRunAt(): string | null {
      return planEntries()[0]?.nextRunAt ?? null;
    },
    plan(): SchedulerPlanEntry[] {
      return planEntries();
    },
    /** 立即跑一次完整流水线（手工/测试入口，步骤全开）。 */
    runPipeline(): Promise<AgentRun> {
      return runTasks([]);
    },
  };

  // Two independent seams (registry + module singleton) so neither a boot race
  // nor a missing `setScheduler()` call can leave the UI guessing.
  activeScheduler = scheduler;
  return scheduler;
}
