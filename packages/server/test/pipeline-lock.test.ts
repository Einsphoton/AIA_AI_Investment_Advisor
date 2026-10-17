/**
 * Pipeline lock (task-13 / D3) + scheduler D7 regression tests.
 *
 * Deterministic: timers are instrumented and the fake agent is gated manually, so
 * no test depends on a real clock or network.
 *
 * Owner: agent-engine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentRun, ScheduleTask } from '@aia/shared';

import { createRepo } from '../src/db/repo.js';
import { createScheduler } from '../src/services/scheduler.js';
import {
  PIPELINE_BUSY_MESSAGE,
  PipelineBusyError,
  isPipelineRunning,
  pipelineLockStatus,
  runExclusive,
  runExclusiveOrThrow,
} from '../src/services/pipeline-lock.js';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('runExclusive：同一时刻只允许一条流水线，第二条立刻被拒（不排队）', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = runExclusive('manual:run-now', async () => {
    await held;
    return 'first';
  });
  await flush();

  assert.equal(isPipelineRunning(), true);
  assert.equal(pipelineLockStatus()?.label, 'manual:run-now');

  const second = await runExclusive('manual:advice', async () => 'second');
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.match(second.reason, /已有 AI 流水线正在运行/);
    assert.match(second.reason, /manual:run-now/);
  }

  release();
  assert.deepEqual(await first, { ok: true, value: 'first' });
  assert.equal(isPipelineRunning(), false, '成功路径必须释放锁');
});

test('runExclusive：异常路径也必须释放锁', async () => {
  await assert.rejects(
    runExclusive('manual:asset-analysis', async () => {
      throw new Error('pipeline boom');
    }),
    /pipeline boom/,
  );
  assert.equal(isPipelineRunning(), false, '异常后锁必须释放');
  assert.deepEqual(await runExclusive('manual:run-now', async () => 'ok'), { ok: true, value: 'ok' });
});

test('runExclusiveOrThrow：占用时抛出 PipelineBusyError', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = runExclusive('manual:advice', async () => {
    await held;
  });
  await flush();
  await assert.rejects(
    runExclusiveOrThrow('scheduler:interval', async () => ({}) as AgentRun),
    (error: unknown) => error instanceof PipelineBusyError && /已有 AI 流水线正在运行/.test((error as Error).message),
  );
  release();
  await first;
  assert.equal(isPipelineRunning(), false);
});

test('D7 + D3：tick 与手动流水线共享锁；运行期间 nextRunAt() 绝不是过去时刻', async () => {
  let seq = 0;
  const live = new Set<number>();
  const pending = new Map<number, () => void>();
  /** 假定时器：注入 scheduler（不替换全局 setTimeout —— 那会干扰并行跑的其它测试）。 */
  const timers = {
    setTimeout: (fn: () => void): { unref: () => void } => {
      const id = ++seq;
      live.add(id);
      pending.set(id, fn);
      return { unref() {} };
    },
    clearTimeout: (handle: { unref?: () => void } | undefined): void => {
      const id = (handle as { id?: number } | undefined)?.id;
      if (id !== undefined) live.delete(id);
    },
  };
  const fireLatest = (): boolean => {
    const id = [...live].pop();
    if (id === undefined) return false;
    live.delete(id);
    pending.get(id)?.();
    return true;
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-lock-'));
  const repo = createRepo(path.join(dir, 'advisor.db'));
  repo.migrate();
  // runIpoAnalysis 显式关掉：打新步骤会真的去打四个上游（网络 I/O），本用例必须保持离线。
  const base = { intervalMinutes: 1, dailyTime: '08:30', runAssetAnalysis: true, runWatchlistAnalysis: true, runIpoAnalysis: false, runAdvice: true };
  const task = (over: Partial<ScheduleTask> = {}): ScheduleTask => ({
    id: 'sched_1',
    name: '测试任务',
    enabled: true,
    mode: 'interval',
    ...base,
    ...over,
  });
  repo.saveSettings({ schedules: [] });

  let gateOpen = false;
  // Holder object: a plain `let` would be flow-narrowed to `null` by TS.
  const gate: { release?: () => void } = {};
  const calls: string[] = [];
  const agent = {
    isConfigured: () => true,
    tools: () => [],
    resume: async (): Promise<AgentRun> => {
      throw new Error('resume is not exercised by this test');
    },
    run: async (req: { kind: string }): Promise<AgentRun> => {
      calls.push(req.kind);
      if (!gateOpen) {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      }
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
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        steps: [],
      };
    },
  };
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const scheduler = createScheduler({ getRepo: () => repo, agent, logger, timers });

  try {
    scheduler.start();
    assert.equal(scheduler.nextRunAt(), null, '没有启用任务时不排程');

    repo.saveSettings({ schedules: [task()] });
    scheduler.reload();
    const planned = scheduler.nextRunAt();
    assert.ok(planned !== null && Date.parse(planned) > Date.now(), '武装后必须是未来时间');

    // Fire the tick: the pipeline starts and stays in flight.
    assert.equal(fireLatest(), true);
    await flush();
    await flush();
    assert.equal(isPipelineRunning(), true, 'tick 必须持有流水线锁');
    assert.deepEqual(calls, ['asset-analysis']);

    // D7: during the run nextRunAt() must be future (or null). The old code
    // returned the already-fired trigger instant.
    for (let i = 0; i < 5; i += 1) {
      const during = scheduler.nextRunAt();
      assert.ok(
        during === null || Date.parse(during) > Date.now(),
        `运行期间 nextRunAt() 不得为过去时刻，得到 ${during}`,
      );
      await flush();
    }

    // D3: a manual request during the tick is rejected instead of stacking up.
    const manual = await runExclusive('manual:run-now', async () => 'should-not-run');
    assert.equal(manual.ok, false);

    gateOpen = true;
    gate.release?.();
    for (let i = 0; i < 8; i += 1) await flush();
    assert.equal(isPipelineRunning(), false, '流水线结束后锁必须释放');
    assert.deepEqual(calls, ['asset-analysis', 'watchlist-analysis', 'advice']);

    // The lock is reusable afterwards.
    assert.deepEqual(await runExclusive('manual:run-now', async () => 'ok'), { ok: true, value: 'ok' });
  } finally {
    scheduler.stop();
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PIPELINE_BUSY_MESSAGE：面向用户的文案稳定', () => {
  assert.equal(PIPELINE_BUSY_MESSAGE, '已有 AI 流水线正在运行，请稍后再试');
});
