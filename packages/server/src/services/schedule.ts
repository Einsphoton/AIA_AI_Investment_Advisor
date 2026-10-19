/**
 * 定时任务排程数学（纯函数）—— scheduler / dashboard / 流水线步骤选择共用一份口径。
 *
 * Owner: agent-engine. 这里只做「什么时候跑、跑哪些步骤」的计算，不碰定时器、不碰 IO：
 *
 *   · `nextFireAt(task, from)`：任务相对某个时刻的下一次触发（interval 从 `from` 起算，
 *     daily 取当天 `HH:mm`，已过则顺延到明天）；
 *   · `mergeTaskFlags(tasks)`：多个任务在同一时刻到期时，步骤取**并集**
 *     （任一任务要跑某一步就跑），避免同一秒触发两次重量级流水线；
 *   · `describeTask(task)`：日志与界面共用的中文描述。
 *
 * 保留「整体关闭」的语义：空数组 / 全部 `enabled === false` = 不排程。
 */
import type { ScheduleTask, ScheduleNextRun } from '@aia/shared';

/** 默认每天运行时间（与 DEFAULT_SCHEDULE_TASK 一致）。 */
export const FALLBACK_DAILY_TIME = '08:30';
/** 默认间隔（分钟）。 */
export const FALLBACK_INTERVAL_MINUTES = 1440;

/** `HH:mm` → { hours, minutes }，越界或不合法时回退到 08:30。 */
export function parseDailyTime(value: string): { hours: number; minutes: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim());
  if (!match) return { hours: 8, minutes: 30 };
  const hours = Math.min(23, Math.max(0, Number.parseInt(match[1]!, 10)));
  const minutes = Math.min(59, Math.max(0, Number.parseInt(match[2]!, 10)));
  return { hours, minutes };
}

/** 已启用的任务（排程只看这些）。 */
export function enabledTasks(schedules: ScheduleTask[] | undefined | null): ScheduleTask[] {
  return (schedules ?? []).filter((task) => task?.enabled === true);
}

/** 任务相对 `from` 的下一次触发毫秒；停用任务返回 null。 */
export function nextFireAt(task: ScheduleTask, from = Date.now()): number | null {
  if (!task?.enabled) return null;
  if (task.mode === 'interval') {
    return from + intervalMinutesOf(task) * 60_000;
  }
  const { hours, minutes } = parseDailyTime(task.dailyTime || FALLBACK_DAILY_TIME);
  const next = new Date(from);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= from) next.setDate(next.getDate() + 1);
  return next.getTime();
}

/** 间隔分钟数：非法/缺失 → 默认 1440；数值但 < 1 → 夹到 1 分钟。 */
export function intervalMinutesOf(task: ScheduleTask): number {
  const raw = Number(task?.intervalMinutes);
  if (!Number.isFinite(raw)) return FALLBACK_INTERVAL_MINUTES;
  return Math.max(1, Math.floor(raw));
}

/** 一组任务里最近的一次触发（毫秒）；没有启用任务时 null。 */
export function earliestFireAt(tasks: ScheduleTask[], from = Date.now()): number | null {
  let earliest: number | null = null;
  for (const task of enabledTasks(tasks)) {
    const at = nextFireAt(task, from);
    if (at === null) continue;
    if (earliest === null || at < earliest) earliest = at;
  }
  return earliest;
}

/** 一组任务的下次触发计划（按时间升序，ISO 字符串），供界面逐条展示。 */
export function planNextRuns(tasks: ScheduleTask[], from = Date.now()): ScheduleNextRun[] {
  return enabledTasks(tasks)
    .map((task) => ({ task, at: nextFireAt(task, from) }))
    .filter((entry): entry is { task: ScheduleTask; at: number } => entry.at !== null)
    .sort((a, b) => a.at - b.at)
    .map((entry) => ({ id: entry.task.id, name: entry.task.name, nextRunAt: new Date(entry.at).toISOString() }));
}

export interface PipelineStepFlags {
  skipAsset: boolean;
  skipWatchlist: boolean;
  skipIpo: boolean;
  /**
   * 期权卖权阶段（独立 run kind `option-advice`）。
   *
   * 刻意**不**新增 `ScheduleTask` 字段：期权阶段跟随「投资建议」步骤一起跑，
   * 避免「任务开了期权、设置关了流水线」两套开关互相打架。全局总开关是
   * `settings.option.runWithPipeline`（见 services/advice.ts 的 planPipeline）。
   */
  skipOption: boolean;
  skipAdvice: boolean;
}

/**
 * 到期任务集合 → 一次流水线的步骤开关（并集）。
 *
 * 同一时刻多个任务到期时只跑一次流水线：某一步只要**任一**到期任务要它，就执行。
 * 传入空集合（理论上不会发生）时保守地跑全流程。
 */
export function mergeTaskFlags(tasks: ScheduleTask[]): PipelineStepFlags {
  const step = (pick: (task: ScheduleTask) => boolean): boolean => {
    if (tasks.length === 0) return true;
    return tasks.some((task) => pick(task));
  };
  return {
    skipAsset: !step((task) => task.runAssetAnalysis),
    skipWatchlist: !step((task) => task.runWatchlistAnalysis),
    skipIpo: !step((task) => task.runIpoAnalysis),
    // 期权卖权没有独立的任务开关：跟着「投资建议」一起跑（Lead 裁定，见 PipelineStepFlags）。
    skipOption: !step((task) => task.runAdvice),
    skipAdvice: !step((task) => task.runAdvice),
  };
}

/** 中文描述：`每天 08:30` / `每 60 分钟`（日志与界面共用）。 */
export function describeTask(task: ScheduleTask): string {
  const base =
    task.mode === 'interval' ? `每 ${intervalMinutesOf(task)} 分钟` : `每天 ${task.dailyTime || FALLBACK_DAILY_TIME}`;
  return task.enabled ? base : `${base}（已停用）`;
}

/** 任务要跑的步骤名列表（用于日志）。 */
export function taskStepLabels(task: ScheduleTask): string[] {
  const steps: string[] = [];
  if (task.runAssetAnalysis) steps.push('资产分析');
  if (task.runWatchlistAnalysis) steps.push('标的分析');
  if (task.runIpoAnalysis) steps.push('打新分析');
  // 期权卖权跟随投资建议步骤（无独立开关），日志里也要能看出来它会跑。
  if (task.runAdvice) steps.push('期权卖权');
  if (task.runAdvice) steps.push('投资建议');
  return steps;
}
