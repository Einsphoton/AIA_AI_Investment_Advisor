/**
 * 定时任务排程测试 —— 纯函数（触发时间 / 步骤并集）+ 多任务调度器行为。
 *
 * Owner: agent-engine. 定时器被替换成可手动触发的假实现，因此不依赖真实时钟；
 * 仓库是真 SQLite（临时文件），与运行期同一条读写路径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentRun, ScheduleTask } from '@aia/shared';

import { createRepo } from '../src/db/repo.js';
import { createScheduler } from '../src/services/scheduler.js';
import { isPipelineRunning } from '../src/services/pipeline-lock.js';
import {
  describeTask,
  earliestFireAt,
  enabledTasks,
  mergeTaskFlags,
  nextFireAt,
  parseDailyTime,
  planNextRuns,
  taskStepLabels,
} from '../src/services/schedule.js';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function task(over: Partial<ScheduleTask> = {}): ScheduleTask {
  return {
    id: over.id ?? 'sched_1',
    name: over.name ?? '测试任务',
    enabled: over.enabled ?? true,
    mode: over.mode ?? 'daily',
    intervalMinutes: over.intervalMinutes ?? 60,
    dailyTime: over.dailyTime ?? '08:30',
    runAssetAnalysis: over.runAssetAnalysis ?? true,
    runWatchlistAnalysis: over.runWatchlistAnalysis ?? true,
    runAdvice: over.runAdvice ?? true,
  };
}

/* ──────────────────────────── 纯函数 ──────────────────────────── */

test('parseDailyTime：合法 HH:mm 解析，非法值退回 08:30', () => {
  assert.deepEqual(parseDailyTime('09:05'), { hours: 9, minutes: 5 });
  assert.deepEqual(parseDailyTime('23:59'), { hours: 23, minutes: 59 });
  assert.deepEqual(parseDailyTime(''), { hours: 8, minutes: 30 });
  assert.deepEqual(parseDailyTime('25:99'), { hours: 23, minutes: 59 });
});

test('nextFireAt：interval 从给定时刻起算；daily 当天已过则顺延到明天', () => {
  const from = Date.parse('2026-10-16T09:00:00+08:00');
  assert.equal(nextFireAt(task({ mode: 'interval', intervalMinutes: 90 }), from), from + 90 * 60_000);

  // 每天 10:15：还没到 → 今天；已经过了 → 明天。
  const before = new Date('2026-10-16T09:00:00+08:00');
  const after = new Date('2026-10-16T11:00:00+08:00');
  const todayAt = nextFireAt(task({ mode: 'daily', dailyTime: '10:15' }), before.getTime());
  const tomorrowAt = nextFireAt(task({ mode: 'daily', dailyTime: '10:15' }), after.getTime());
  assert.equal(new Date(todayAt!).getDate(), 16);
  assert.equal(new Date(todayAt!).getHours(), 10);
  assert.equal(new Date(tomorrowAt!).getDate(), 17, '已过的时间点必须顺延到次日');

  // 停用任务不排程；非法间隔退回到「至少 1 分钟」。
  assert.equal(nextFireAt(task({ enabled: false }), from), null);
  assert.equal(nextFireAt(task({ mode: 'interval', intervalMinutes: 0 }), from), from + 60_000);
});

test('计划组合：只算启用的任务，按时间升序，最近一次 = 第一条', () => {
  const from = Date.parse('2026-10-16T09:00:00+08:00');
  const tasks = [
    task({ id: 'late', name: '很晚', mode: 'interval', intervalMinutes: 600 }),
    task({ id: 'soon', name: '很快', mode: 'interval', intervalMinutes: 30 }),
    task({ id: 'off', name: '停用', enabled: false, mode: 'interval', intervalMinutes: 5 }),
  ];
  assert.deepEqual(enabledTasks(tasks).map((item) => item.id), ['late', 'soon']);
  const plan = planNextRuns(tasks, from);
  assert.deepEqual(plan.map((entry) => entry.id), ['soon', 'late']);
  assert.equal(plan[0]!.name, '很快');
  assert.equal(earliestFireAt(tasks, from), Date.parse(plan[0]!.nextRunAt));
  assert.deepEqual(planNextRuns([], from), []);
});

test('步骤并集：多个任务同时到期时，某一步只要任一任务要它就跑', () => {
  const assetOnly = task({ id: 'a', runAssetAnalysis: true, runWatchlistAnalysis: false, runAdvice: false });
  const adviceOnly = task({ id: 'b', runAssetAnalysis: false, runWatchlistAnalysis: false, runAdvice: true });
  assert.deepEqual(mergeTaskFlags([assetOnly, adviceOnly]), { skipAsset: false, skipWatchlist: true, skipAdvice: false });
  assert.deepEqual(mergeTaskFlags([assetOnly]), { skipAsset: false, skipWatchlist: true, skipAdvice: true });
  // 空集合（理论上不会发生）保守地跑全流程。
  assert.deepEqual(mergeTaskFlags([]), { skipAsset: false, skipWatchlist: false, skipAdvice: false });
  assert.deepEqual(taskStepLabels(assetOnly), ['资产分析']);
  assert.equal(describeTask(task({ mode: 'interval', intervalMinutes: 30 })), '每 30 分钟');
  assert.equal(describeTask(task({ mode: 'daily', dailyTime: '08:45' })), '每天 08:45');
  assert.match(describeTask(task({ enabled: false })), /已停用/);
});

/* ──────────────────────── 调度器（多任务） ──────────────────────── */

test('调度器：多个任务只武装一个定时器，到期的任务合并成一次流水线（步骤并集）', async () => {
  // 假时钟 + 假定时器：精确控制「时间」与「触发」，完全不碰全局 setTimeout
  // （替换全局会让同一进程里并行跑的其它测试超时失败）。
  let clock = Date.parse('2026-10-16T09:00:00+08:00');
  const handles = new Map<number, () => void>();
  const live = new Set<number>();
  let seq = 0;
  const timers = {
    setTimeout: (fn: () => void): { unref: () => void; id: number } => {
      const id = ++seq;
      handles.set(id, fn);
      live.add(id);
      return { id, unref() {} };
    },
    clearTimeout: (handle: { unref?: () => void } | undefined): void => {
      const id = (handle as { id?: number } | undefined)?.id;
      if (id !== undefined) live.delete(id);
    },
  };
  /** 推进时钟并触发当前挂起的定时器。 */
  const fire = async (): Promise<void> => {
    const id = [...live].pop();
    assert.notEqual(id, undefined, '应当有一个已武装的定时器');
    live.delete(id!);
    handles.get(id!)?.();
    for (let i = 0; i < 8; i += 1) await flush();
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-sched-'));
  const repo = createRepo(path.join(dir, 'advisor.db'));
  repo.migrate();

  const calls: string[] = [];
  const agent = {
    isConfigured: () => true,
    tools: () => [],
    resume: async (): Promise<AgentRun> => {
      throw new Error('resume is not used here');
    },
    run: async (req: { kind: string }): Promise<AgentRun> => {
      calls.push(req.kind);
      return {
        id: `run-${calls.length}`,
        kind: req.kind as AgentRun['kind'],
        status: 'done',
        target: null,
        title: req.kind,
        summary: '',
        error: null,
        turns: 1,
        promptTokens: 0,
        completionTokens: 0,
        startedAt: new Date(clock).toISOString(),
        finishedAt: new Date(clock).toISOString(),
        steps: [],
      };
    },
  };
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const scheduler = createScheduler({ getRepo: () => repo, agent, logger, timers, now: () => clock });

  try {
    scheduler.start();
    assert.equal(scheduler.nextRunAt(), null, '没有任务时不排程');
    assert.deepEqual(scheduler.plan(), []);
    assert.equal(live.size, 0, '没有任务时不得武装定时器');

    // 两个**同时到期**的任务：一个只要资产分析，一个只要投资建议；
    // 再加一个停用任务（必须被完全忽略）。
    repo.saveSettings({
      schedules: [
        task({ id: 'asset_only', name: '只看资产', mode: 'interval', intervalMinutes: 30, runWatchlistAnalysis: false, runAdvice: false }),
        task({ id: 'advice_only', name: '只出建议', mode: 'interval', intervalMinutes: 30, runAssetAnalysis: false, runWatchlistAnalysis: false }),
        task({ id: 'disabled', name: '停用的', enabled: false, mode: 'interval', intervalMinutes: 1 }),
      ],
    });
    scheduler.reload();

    const plan = scheduler.plan();
    assert.deepEqual(plan.map((entry) => entry.id), ['asset_only', 'advice_only'], '停用任务不进计划');
    assert.equal(Date.parse(plan[0]!.nextRunAt), clock + 30 * 60_000, '30 分钟后运行');
    assert.equal(scheduler.nextRunAt(), plan[0]!.nextRunAt, 'nextRunAt = 计划里最早的一条');
    assert.equal(live.size, 1, '多个任务只能武装一个定时器（都指向最近那次触发）');

    // 到点触发：两个任务合并成**一次**流水线，步骤取并集。
    clock += 30 * 60_000;
    await fire();
    assert.equal(isPipelineRunning(), false, '流水线跑完必须释放锁');
    assert.deepEqual(calls, ['asset-analysis', 'advice'], '资产分析 + 投资建议都要跑，标的分析没人要 → 跳过');

    // 跑完各自重排：仍按 30 分钟间隔，且一定是未来时间（D7 回归护栏）。
    const after = scheduler.plan();
    assert.equal(after.length, 2);
    for (const entry of after) {
      assert.equal(Date.parse(entry.nextRunAt), clock + 30 * 60_000, `${entry.id} 从跑完时刻重新计间隔`);
    }

    // 每天固定时间：当天已过则排到次日。
    repo.saveSettings({ schedules: [task({ id: 'daily', name: '盘前', mode: 'daily', dailyTime: '08:45' })] });
    scheduler.reload();
    const dailyPlan = scheduler.plan();
    assert.equal(new Date(Date.parse(dailyPlan[0]!.nextRunAt)).getDate(), 17, '09:00 时 08:45 已过 → 次日');

    // 清空任务 → 不再排程、也不留定时器。
    repo.saveSettings({ schedules: [] });
    scheduler.reload();
    assert.equal(scheduler.nextRunAt(), null);
    assert.deepEqual(scheduler.plan(), []);
    assert.equal(live.size, 0, '没有任务时不得留下定时器');
  } finally {
    scheduler.stop();
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
