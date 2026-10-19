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
 * **失败自动续跑（2026-10）**：定时流水线里只要有阶段 run 失败，且失败属于可重试类
 * （见 `services/auto-retry.ts`），就落一条续跑任务并按 2 / 10 / 30 分钟退避、最多 3 次
 * 从持久化轨迹 `resume`，而不是等下一次定时触发（每天一次的任务否则要等 24 小时）。
 * 续跑任务与「正在跑的定时流水线」都写进 SQLite `kv`：进程重启后接着等；
 * 若进程是在流水线中途退出，启动时会用 `in-flight` 标记 + stale run 轨迹自动自愈。
 * 失败不可重试（未配置 Key / 认证失败 / 暂停）时只记日志，仍由界面「一键续跑」兜底。
 *
 * The created instance is published through {@link getActiveScheduler} (module
 * singleton) *and* registered in `registry.ts` by `index.ts`, so route modules
 * can always report the **real** plan instead of re-deriving it from settings.
 *
 * Owner: agent-engine.
 */
import type { AgentRun, ScheduleTask } from '@aia/shared';

import type {
  Scheduler,
  SchedulerDeps,
  SchedulerPlanEntry,
  SchedulerRetryState,
  SchedulerTimers,
} from '../types/agent.js';
import { PipelineFailureError, runFullPipeline } from './advice.js';
import { trackAdviceOutcomes } from './advice-outcomes.js';
import type { PipelineContext } from './analytics.js';
import {
  AUTO_RETRY_BOOT_DELAY_MS,
  AUTO_RETRY_BUSY_DELAY_MS,
  AUTO_RETRY_MAX_ATTEMPTS,
  classifyErrorMessage,
  classifyPipelineError,
  classifyRunFailure,
  clearInFlight,
  describeRetryJob,
  hasAnyStep,
  hasAutoResumedMark,
  kindsForFlags,
  loadInFlight,
  loadRetryJob,
  markAutoResumed,
  retryDelayMs,
  saveInFlight,
  saveRetryJob,
  skipFlagsFor,
  type InFlightMarker,
  type RetryJob,
} from './auto-retry.js';
import { PipelineBusyError, runExclusiveOrThrow } from './pipeline-lock.js';
import { describeTask, mergeTaskFlags, nextFireAt, taskStepLabels } from './schedule.js';
import type { RunRow } from '../types/models.js';

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

/** 一次失败阶段（用于续跑判定：`id` 是 run id，`error` 是它的错误文本）。 */
interface RetryFailure {
  id: string;
  error: string;
}

/** 一次成功续跑：原失败 run → 新 run（成功后给原 run 打「已自动续跑」标记）。 */
interface ResumedRun {
  originalId: string;
  run: AgentRun;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? Math.random;
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
  /** 待执行的自动续跑（同时落 `kv`；内存里这份是权威状态）。 */
  let retryJob: RetryJob | null = null;

  function repo(): ReturnType<SchedulerDeps['getRepo']> {
    return deps.getRepo();
  }

  function schedules(): ScheduleTask[] {
    try {
      return repo().getSettings().schedules ?? [];
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

  /** 跟踪表里最早的一次触发（毫秒）；自动续跑也参与比较，保证只武装一个定时器。 */
  function earliestMs(): number | null {
    let earliest: number | null = retryJob ? retryJob.nextAttemptAt : null;
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
    return { agent: deps.agent, repo: repo(), logger: deps.logger };
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

  function lastRunAtMs(): number | null {
    try {
      const raw = repo().getSettings().lastRunAt;
      const ms = raw ? Date.parse(raw) : Number.NaN;
      return Number.isFinite(ms) ? ms : null;
    } catch {
      return null;
    }
  }

  function hasTranscript(runId: string): boolean {
    try {
      return repo().countRunMessages(runId) > 0;
    } catch {
      return false;
    }
  }

  /** 取出 `sinceMs` 之后开始的 run（启动自愈用；读取失败按空处理）。 */
  function runsSince(sinceMs: number): RunRow[] {
    if (!Number.isFinite(sinceMs)) return [];
    try {
      return repo()
        .listRuns({ limit: 100 })
        .filter((run) => Date.parse(run.startedAt) >= sinceMs - 5_000);
    } catch (error) {
      deps.logger.warn(`scheduler: 自愈时读取运行记录失败：${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * 找出 `sinceMs` 之后产生、已失败、且有持久化轨迹的 run（按流水线阶段过滤）。
   *
   * 用于启动自愈：`failStaleRuns` 在 boot 时把上次进程留下的 `running` 行标成
   * `error`，它们的轨迹通常足够续跑；`sinceMs` 取 in-flight 标记/续跑任务的创建
   * 时间，避免把更早的无关失败也捞进来。
   */
  function interruptedRunIds(sinceMs: number, kinds: Set<string>): string[] {
    return runsSince(sinceMs)
      .filter((run) => run.status === 'error' && kinds.has(run.kind) && hasTranscript(run.id))
      .map((run) => run.id);
  }

  /** 保存续跑任务（`null` = 清除）；内存与 `kv` 一起更新。 */
  function setRetryJob(job: RetryJob | null): void {
    retryJob = job;
    saveRetryJob(repo(), job);
  }

  /**
   * 一次失败之后决定「排下一次续跑」还是「放弃」。
   *
   * `failed` 为可重试的失败清单；`reason` 只用于日志。第 3 次之后停止（不无限重试），
   * 失败 run 仍留在历史里，界面仍可手动一键续跑。
   */
  function scheduleNextAttempt(job: RetryJob, failed: RetryFailure[], lastError: string, reason: string): void {
    if (job.attempt >= AUTO_RETRY_MAX_ATTEMPTS) {
      setRetryJob(null);
      deps.logger.error(
        `scheduler: 自动续跑已达上限（${AUTO_RETRY_MAX_ATTEMPTS} 次），停止重试 —— ${lastError.slice(0, 300)}`,
      );
      return;
    }
    const attempt = job.attempt + 1;
    const next: RetryJob = {
      ...job,
      attempt,
      nextAttemptAt: now() + retryDelayMs(attempt, random),
      failedRunIds: failed.map((entry) => entry.id),
      lastError: lastError.slice(0, 1000),
    };
    setRetryJob(next);
    deps.logger.warn(
      `scheduler: ${describeRetryJob(next)} 已排期（${reason}）→ ${new Date(next.nextAttemptAt).toISOString()}`,
    );
    arm();
  }

  /** 失败不可重试 / 重试次数用尽：清掉续跑任务，失败记录留给界面手动处理。 */
  function giveUpRetry(job: RetryJob, lastError: string, reason: string): void {
    setRetryJob(null);
    deps.logger.error(`scheduler: ${describeRetryJob(job)} 放弃 —— ${reason}：${lastError.slice(0, 300)}`);
  }

  /**
   * 定时流水线失败 → 排一次自动续跑。
   *
   * 阶段失败（`PipelineFailureError`）时只续跑**可重试**的那几条 run；流水线在进入阶段前
   * 就抛错（如读库失败）时没有 run 可续，改为整条流水线重跑（`kind='pipeline'`）。
   * 返回是否真的排了续跑。
   */
  function scheduleRetryFromFailure(error: unknown, tasks: ScheduleTask[]): boolean {
    const flags = mergeTaskFlags(tasks);
    const taskIds = tasks.map((task) => task.id);
    const taskNames = tasks.map((task) => task.name || task.id);
    const createdAt = new Date(now()).toISOString();
    const base = { taskIds, taskNames, flags, createdAt };

    if (error instanceof PipelineFailureError) {
      const verdicts = error.failedRuns.map((run) => ({ run, verdict: classifyRunFailure(run) }));
      const retryable = verdicts.filter((entry) => entry.verdict.retryable);
      if (retryable.length === 0) {
        deps.logger.warn(
          `scheduler: 失败不可自动续跑（${verdicts.map((entry) => entry.verdict.reason).join('、')}），等待人工处理`,
        );
        return false;
      }
      const lastError = error.failedRuns
        .map((run) => `${run.title || run.kind}：${run.error ?? '未知错误'}`)
        .join('；');
      const job: RetryJob = {
        ...base,
        kind: 'resume',
        attempt: 1,
        nextAttemptAt: now() + retryDelayMs(1, random),
        failedRunIds: retryable.map((entry) => entry.run.id),
        lastError: lastError.slice(0, 1000),
      };
      setRetryJob(job);
      deps.logger.warn(
        `scheduler: ${describeRetryJob(job)} 已排期（${retryable[0]!.verdict.reason}）→ ${new Date(job.nextAttemptAt).toISOString()}`,
      );
      arm();
      return true;
    }

    const verdict = classifyPipelineError(error);
    const lastError = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    if (!verdict.retryable) {
      deps.logger.warn(`scheduler: 流水线失败不可自动续跑（${verdict.reason}），等待人工处理`);
      return false;
    }
    const job: RetryJob = {
      ...base,
      kind: 'pipeline',
      attempt: 1,
      nextAttemptAt: now() + retryDelayMs(1, random),
      failedRunIds: [],
      lastError,
    };
    setRetryJob(job);
    deps.logger.warn(
      `scheduler: ${describeRetryJob(job)} 已排期（${verdict.reason}）→ ${new Date(job.nextAttemptAt).toISOString()}`,
    );
    arm();
    return true;
  }

  /** 成功结束一次自动续跑：清状态、给原失败 run 打标记、更新 lastRunAt、通知界面。 */
  function finishRetrySuccess(job: RetryJob, runs: AgentRun[], resumed: ResumedRun[]): void {    setRetryJob(null);
    for (const entry of resumed) markAutoResumed(repo(), entry.originalId, entry.run.id, job.attempt);
    try {
      repo().saveSettings({ lastRunAt: new Date().toISOString() });
    } catch {
      /* settings write is best effort */
    }
    const last = runs[runs.length - 1];
    if (last) {
      try {
        deps.onRunComplete?.(last);
      } catch (error) {
        deps.logger.warn(`scheduler onRunComplete failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    deps.logger.info(`scheduler: ${describeRetryJob(job)} 成功（${runs.length} 个阶段）`);
  }

  /** 续跑结果里仍有失败 → 决定下一次（或放弃）；已成功的阶段先打「已自动续跑」标记。 */
  function handleRetryFailure(job: RetryJob, failures: RetryFailure[], resumed: ResumedRun[] = []): void {
    for (const entry of resumed) markAutoResumed(repo(), entry.originalId, entry.run.id, job.attempt);
    if (failures.length === 0) {
      return;
    }
    const verdicts = failures.map((failure) => ({ ...failure, verdict: classifyErrorMessage(failure.error) }));
    const retryable = verdicts.filter((entry) => entry.verdict.retryable);
    const lastError = failures.map((failure) => failure.error).join('；').slice(0, 1000);
    // 本次已成功的阶段从补跑开关里剔除，下一轮不会再跑它们。
    const followUpFlags = job.followUpFlags
      ? skipFlagsFor(job.followUpFlags, resumed.map((entry) => entry.run.kind))
      : undefined;
    const baseJob: RetryJob = followUpFlags ? { ...job, followUpFlags } : job;

    if (retryable.length === 0) {
      // 轨迹丢失（例如进程在写入任何消息前就退出）时 resume 永远失败 —— 改为整条重跑一次。
      const onlyNoTranscript = verdicts.every((entry) => /没有可续跑的轨迹/.test(entry.error));
      if (job.kind === 'resume' && onlyNoTranscript) {
        deps.logger.warn(`scheduler: ${describeRetryJob(job)} 没有可续跑轨迹，改为整条流水线重跑`);
        scheduleNextAttempt(
          { ...baseJob, kind: 'pipeline', flags: job.followUpFlags ?? job.flags },
          [],
          lastError,
          '没有可续跑的轨迹',
        );
        return;
      }
      giveUpRetry(job, lastError, verdicts[0]!.verdict.reason);
      return;
    }
    scheduleNextAttempt(baseJob, retryable, lastError, retryable[0]!.verdict.reason);
  }

  /**
   * 执行当前排期的自动续跑（到期由 {@link tick} 调用，持流水线锁）。
   *
   * resume 是**逐条**续跑失败阶段；一条失败不影响其它条继续（阶段相互独立）。
   * 锁被手工流水线占用时延后 2 分钟且**不消耗**次数；进程若在本函数中途退出，
   * `kv` 里那条续跑任务仍在，下次启动会接着执行。
   */
  async function runRetryOnce(): Promise<void> {
    const job = retryJob;
    if (!job) return;
    // 先摘掉内存状态：持久化副本保留到有结果，进程中途退出时启动自愈还能接着跑。
    retryJob = null;
    deps.logger.info(`scheduler: ${describeRetryJob(job)} 开始（上次失败：${job.lastError.slice(0, 160)}）`);

    const runs: AgentRun[] = [];
    const resumed: ResumedRun[] = [];
    const failures: RetryFailure[] = [];
    try {
      await runExclusiveOrThrow(`scheduler:auto-retry:${job.attempt}`, async () => {
        if (job.kind === 'pipeline') {
          runs.push(await runFullPipeline(context(), job.flags));
          return;
        }
        for (const runId of job.failedRunIds) {
          try {
            const run = await deps.agent.resume(runId);
            runs.push(run);
            if (run.status === 'error') {
              failures.push({ id: run.id, error: run.error ?? '未知错误' });
            } else {
              resumed.push({ originalId: runId, run });
              // 逐个打标记（而不是等整轮结束）：进程若在续跑下一个阶段时退出，
              // 重启后才能知道这个原 run 已经续过、不必再续一遍。
              markAutoResumed(repo(), runId, run.id, job.attempt);
            }
          } catch (error) {
            failures.push({ id: runId, error: error instanceof Error ? error.message : String(error) });
          }
        }
        // 进程中断自愈：续跑完被中断的阶段后，把这一轮没来得及执行的后续阶段补上。
        if (failures.length === 0 && job.followUpFlags) {
          const remaining = skipFlagsFor(job.followUpFlags, resumed.map((entry) => entry.run.kind));
          if (hasAnyStep(remaining)) {
            deps.logger.info(
              `scheduler: ${describeRetryJob(job)} 续跑完成，继续补跑中断时未执行的阶段（${kindsForFlags(remaining).join('+')}）`,
            );
            runs.push(await runFullPipeline(context(), remaining));
          }
        }
      });
    } catch (error) {
      if (error instanceof PipelineBusyError) {
        // 手工流水线正持锁：延后，但不算一次失败（也不消耗重试次数）。
        const nextAt = now() + AUTO_RETRY_BUSY_DELAY_MS;
        setRetryJob({ ...job, nextAttemptAt: nextAt });
        deps.logger.warn(
          `scheduler: 自动续跑遇到流水线占用（${error.message}），顺延到 ${new Date(nextAt).toISOString()}`,
        );
        arm();
        return;
      }
      if (error instanceof PipelineFailureError) {
        handleRetryFailure(
          job,
          error.failedRuns.map((run) => ({ id: run.id, error: run.error ?? '未知错误' })),
          resumed,
        );
      } else {
        const verdict = classifyPipelineError(error);
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
        if (!verdict.retryable) {
          giveUpRetry(job, message, verdict.reason);
        } else if (job.kind === 'resume') {
          // 阶段续跑已完成、补跑后续阶段时在「进入阶段之前」失败：把它当成整条重跑，
          // 用补跑开关（已完成/已续跑的阶段都已标跳过）排下一次。
          const remaining = skipFlagsFor(
            job.followUpFlags ?? job.flags,
            resumed.map((entry) => entry.run.kind),
          );
          if (hasAnyStep(remaining)) {
            scheduleNextAttempt({ ...job, kind: 'pipeline', flags: remaining, failedRunIds: [] }, [], message, verdict.reason);
          } else {
            giveUpRetry(job, message, verdict.reason);
          }
        } else {
          scheduleNextAttempt(job, [], message, verdict.reason);
        }
      }
      return;
    }

    if (failures.length > 0) {
      handleRetryFailure(job, failures, resumed);
      return;
    }
    finishRetrySuccess(job, runs, resumed);
  }

  /**
   * 执行给定任务（步骤取并集）。同一时刻到期的多个任务只跑一次流水线；
   * `running` 兜住「上一跳还没跑完」的情况，进程级锁兜住与手工运行并发的情况。
   *
   * 开始前落 `in-flight` 标记、结束（成功/失败/跳过）后清除：进程若在流水线中途退出，
   * 下次启动可据此找到被中断的阶段并自动续跑。
   */
  async function runTasks(tasks: ScheduleTask[]): Promise<AgentRun> {
    if (running) {
      deps.logger.warn('scheduler: a pipeline is already running, reusing the in-flight run');
      return running;
    }
    const flags = mergeTaskFlags(tasks);
    const label = tasks.map((task) => task.id).join(',') || 'manual';
    const marker: InFlightMarker = {
      startedAt: new Date(now()).toISOString(),
      taskIds: tasks.map((task) => task.id),
      taskNames: tasks.map((task) => task.name || task.id),
      flags,
    };
    saveInFlight(repo(), marker);
    const pipeline = (async (): Promise<AgentRun> => {
      try {
        return await runExclusiveOrThrow(`scheduler:${label}`, async () => {
          const run = await runFullPipeline(context(), flags);
          try {
            repo().saveSettings({ lastRunAt: new Date().toISOString() });
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
        clearInFlight(repo());
        running = null;
      }
    })();
    running = pipeline;
    return pipeline;
  }

  async function tick(): Promise<void> {
    const due = dueTasks(armedForMs ?? now());
    const cutoff = Math.max(armedForMs ?? now(), now()) + DUE_TOLERANCE_MS;
    const retryDue = retryJob !== null && retryJob.nextAttemptAt <= cutoff;
    try {
      // 旁路能力：先刷新「建议结果追踪」。确定性、不调用 LLM，失败也不影响流水线。
      try {
        await trackAdviceOutcomes({ repo: repo(), logger: deps.logger });
      } catch (error) {
        deps.logger.warn(
          `scheduler: advice outcome tracking failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (retryDue) {
        // 自动续跑与定时触发同刻到期：只跑续跑（它续的正是上一轮），定时任务顺延一跳，
        // 避免同一时刻跑两遍重量级分析。
        if (due.length > 0) {
          deps.logger.warn('scheduler: 自动续跑与定时触发同时到期，本次只跑续跑，定时任务顺延到下一跳');
        }
        if (running) {
          const nextAt = now() + AUTO_RETRY_BUSY_DELAY_MS;
          if (retryJob) setRetryJob({ ...retryJob, nextAttemptAt: nextAt });
          deps.logger.warn(
            `scheduler: 上一轮仍在运行，自动续跑顺延到 ${new Date(nextAt).toISOString()}`,
          );
        } else {
          await runRetryOnce();
        }
      } else if (due.length === 0) {
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
        try {
          const run = await runTasks(tasks);
          deps.logger.info(`scheduler: pipeline finished (${run.status}) in ${run.turns} turns`);
        } catch (error) {
          if (error instanceof PipelineBusyError) {
            deps.logger.warn(`scheduler: skipped this tick — ${error.message}`);
          } else {
            deps.logger.error(`scheduler: pipeline failed — ${error instanceof Error ? error.message : String(error)}`);
            // 失败不能只记日志：按失败分类排一次自动续跑（不可重试的错误会被跳过）。
            scheduleRetryFromFailure(error, tasks);
          }
        }
      }
    } catch (error) {
      // 兜底：tick 是 setTimeout 的回调，绝不能把异常抛成 unhandledRejection，
      // 否则一次意外错误会让后续排程彻底停摆。
      deps.logger.error(`scheduler: tick failed — ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // 无论成功、跳过还是失败都要重排这一跳到期的任务，否则它们会永远卡在过去
      // （`syncTasks` 只在保存设置时重算，而计划本身就停留在过去）。
      rearm(due);
      arm();
    }
  }

  /**
   * 每个启用任务的下次触发（自动续跑也作为一条计划项参与排序）。
   * 正在运行的那一跳会按「从现在重排」投影，因此 `nextRunAt()` 永远不报告过去的时间（D7 回归护栏）。
   */
  function planEntries(): SchedulerPlanEntry[] {
    const current = now();
    const entries = [...tracked.values()].map((entry) => {
      const at = entry.nextAtMs > current ? entry.nextAtMs : nextFireAt(entry.task, current) ?? entry.nextAtMs;
      return { id: entry.task.id, name: entry.task.name, nextRunAt: new Date(Math.max(at, current)).toISOString() };
    });
    if (retryJob) {
      entries.push({
        id: '__auto_retry__',
        name: `自动续跑 · 第 ${retryJob.attempt}/${AUTO_RETRY_MAX_ATTEMPTS} 次`,
        nextRunAt: new Date(Math.max(retryJob.nextAttemptAt, current)).toISOString(),
      });
    }
    return entries.sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
  }

  /**
   * 进程启动时的自愈：
   *
   *   1. `kv` 里已有待执行的续跑任务 → 接着等；若停机期间已过期，启动 45s 后补跑；
   *   2. `kv` 里有 `in-flight` 标记（上次进程在定时流水线中途退出）→ 找 `failStaleRuns`
   *      刚标成 `error`、且属于该流水线阶段、且有持久化轨迹的 run，排一条 resume 续跑；
   *      找不到可续跑轨迹时排一次整条流水线重跑。
   *
   * 第 2 种情况正是「部署在服务器上，重启/升级把正在跑的分析打断」的自动兜底。
   */
  function heal(): void {
    // 1) 已有续跑任务：重启后继续等；停机错过的立即补。
    const persisted = loadRetryJob(repo());
    if (persisted) {
      // 若上次进程是在**续跑过程中**退出的，会留下新的 stale run；优先续这些
      // （它们的轨迹比最初那条失败 run 更靠后），避免把同一段分析再跑一遍。
      const kinds = new Set(kindsForFlags(persisted.flags));
      const interrupted = interruptedRunIds(Date.parse(persisted.createdAt), kinds);
      // 已经续跑成功的原 run 带「已自动续跑」标记，重启后不再重复续它。
      const failedRunIds =
        interrupted.length > 0
          ? interrupted
          : persisted.failedRunIds.filter((id) => {
              const run = repo().getRun(id);
              return run !== undefined && !hasAutoResumedMark(run.error);
            });
      const resumed: RetryJob = {
        ...persisted,
        failedRunIds,
        ...(interrupted.length > 0 ? { kind: 'resume' as const } : {}),
      };
      if (
        resumed.kind === 'resume' &&
        failedRunIds.length === 0 &&
        !(resumed.followUpFlags && hasAnyStep(resumed.followUpFlags))
      ) {
        setRetryJob(null);
        deps.logger.info('scheduler: 上次的自动续跑已全部完成（重启前已续跑成功），清除残留任务');
        return;
      }
      const nextAttemptAt =
        resumed.nextAttemptAt > now() ? resumed.nextAttemptAt : now() + AUTO_RETRY_BOOT_DELAY_MS;
      setRetryJob({ ...resumed, nextAttemptAt });
      deps.logger.warn(
        `scheduler: 恢复未完成的自动续跑 —— ${describeRetryJob(resumed)} → ${new Date(nextAttemptAt).toISOString()}${
          interrupted.length > 0 ? `（接续进程退出前新产生的 ${interrupted.length} 个失败阶段）` : ''
        }`,
      );
      return;
    }

    // 2) 上次进程在定时流水线中途退出：用 in-flight 标记 + stale run 轨迹自愈。
    const marker = loadInFlight(repo());
    if (!marker) return;
    clearInFlight(repo());

    const startedMs = Date.parse(marker.startedAt);
    if (!Number.isFinite(startedMs)) return;
    const finishedAt = lastRunAtMs();
    if (finishedAt !== null && finishedAt >= startedMs) {
      deps.logger.info('scheduler: 上次定时流水线已正常结束（in-flight 标记残留），无需自愈');
      return;
    }

    const sinceRuns = runsSince(startedMs);
    const plannedKinds = new Set(kindsForFlags(marker.flags));
    const stale = sinceRuns
      .filter((run) => run.status === 'error' && plannedKinds.has(run.kind) && hasTranscript(run.id))
      .map((run) => run.id);
    // 进程中断时后续阶段可能还没开始（连 run 行都没有）：自愈不仅要续跑被中断的阶段，
    // 还要把这一轮**没来得及执行**的阶段补上；已完成的阶段不重跑。
    const doneKinds = new Set(
      sinceRuns.filter((run) => run.status === 'done' && plannedKinds.has(run.kind)).map((run) => run.kind),
    );
    const remainingFlags = skipFlagsFor(marker.flags, doneKinds);
    if (stale.length === 0 && !hasAnyStep(remainingFlags)) {
      deps.logger.info('scheduler: 上次定时流水线被进程退出打断，但所有阶段都已完成，无需自愈');
      return;
    }

    const nextAttemptAt = now() + AUTO_RETRY_BOOT_DELAY_MS;
    const job: RetryJob = {
      kind: stale.length > 0 ? 'resume' : 'pipeline',
      attempt: 1,
      nextAttemptAt,
      failedRunIds: stale,
      taskIds: marker.taskIds,
      taskNames: marker.taskNames,
      flags: stale.length > 0 ? marker.flags : remainingFlags,
      ...(stale.length > 0 ? { followUpFlags: remainingFlags } : {}),
      lastError:
        stale.length > 0
          ? '服务进程在定时流水线结束前退出（运行被中断），已从持久化轨迹继续'
          : '服务进程在定时流水线中退出，未找到可续跑的阶段轨迹，整条重跑',
      createdAt: new Date(now()).toISOString(),
    };
    setRetryJob(job);
    deps.logger.warn(
      `scheduler: 检测到上次定时流水线被进程退出中断 —— ${describeRetryJob(job)} 将于 ${new Date(nextAttemptAt).toISOString()} 自愈（可续跑阶段 ${stale.length} 个，待补跑阶段 ${kindsForFlags(remainingFlags).length} 个）`,
    );
  }

  const scheduler: Scheduler = {
    start(): void {
      syncTasks();
      heal();
      arm();
      const tasks = tracked.size;
      if (tasks === 0 && !retryJob) deps.logger.info('scheduler: no enabled tasks');
      else
        deps.logger.info(
          `scheduler: ${tasks} task(s) enabled${retryJob ? ', 1 auto-retry pending' : ''}, next run at ${scheduler.nextRunAt()}`,
        );
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
    retryState(): SchedulerRetryState | null {
      if (!retryJob) return null;
      return {
        kind: retryJob.kind,
        attempt: retryJob.attempt,
        maxAttempts: AUTO_RETRY_MAX_ATTEMPTS,
        nextRunAt: new Date(Math.max(retryJob.nextAttemptAt, now())).toISOString(),
        failedRunIds: [...retryJob.failedRunIds],
        taskNames: [...retryJob.taskNames],
        lastError: retryJob.lastError,
      };
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
