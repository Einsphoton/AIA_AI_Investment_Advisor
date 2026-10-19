/**
 * 定时流水线失败后的**自动续跑 / 启动自愈**测试。
 *
 * 覆盖：
 *   · 纯判定 —— 错误分类、退避时长（2/10/30 分钟 + ±15% 抖动）、步骤开关 → run kind；
 *   · 可重试的阶段失败 → 按 2 分钟排期 → 到期从失败 run 的轨迹 `resume` → 给原 run 打
 *     「已自动续跑」标记；
 *   · 不可重试（401 认证失败）不排期；
 *   · 3 次上限：连续失败后停止，不再无限重试；
 *   · 进程重启自愈：`in-flight` 标记 + `failStaleRuns` 产生的 stale run → 45 秒后续跑；
 *   · 重启自愈的**补跑**：续跑被中断的阶段后，只补跑这次没来得及执行的阶段
 *     （已完成的阶段不重跑；被中断的恰好是最后一步时不补跑）。
 *
 * Owner: server-tests. 与 `schedule.test.ts` 同款：定时器与时钟都是注入的假实现
 * （**绝不**替换全局 `setTimeout` —— 同一进程里还并行跑着其它测试文件）；仓库是真
 * SQLite 临时文件，每个用例独立目录并自行清理。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentRun, AgentRunKind, ScheduleTask } from '@aia/shared';

import { createRepo } from '../src/db/repo.js';
import { createScheduler } from '../src/services/scheduler.js';
import type { AgentRuntime, LoggerLike, SchedulerTimers } from '../src/types/agent.js';
import type { Repo } from '../src/types/repo.js';
import {
  AUTO_RETRY_BOOT_DELAY_MS,
  AUTO_RETRY_DELAYS_MS,
  AUTO_RETRY_MAX_ATTEMPTS,
  classifyErrorMessage,
  classifyPipelineError,
  classifyRunFailure,
  kindsForFlags,
  loadRetryJob,
  retryDelayMs,
  saveInFlight,
} from '../src/services/auto-retry.js';

const silentLogger: LoggerLike = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 假时钟 + 可手动触发的假定时器：精确控制「时间」与「触发」，不碰全局 setTimeout。 */
function fakeClock(start: number): {
  state: { now: number };
  timers: SchedulerTimers;
  live: Set<number>;
  fire: () => Promise<void>;
} {
  const state = { now: start };
  const live = new Set<number>();
  const pending = new Map<number, () => void>();
  let seq = 0;
  const timers: SchedulerTimers = {
    setTimeout: (fn) => {
      const id = ++seq;
      live.add(id);
      pending.set(id, fn);
      return { unref() {} };
    },
    clearTimeout: (handle) => {
      const id = (handle as { id?: number } | undefined)?.id;
      if (id !== undefined) live.delete(id);
    },
  };
  /** 触发当前挂起的定时器，并等若干拍（流水线内部要跨多个 await）。 */
  const fire = async (): Promise<void> => {
    const id = [...live].pop();
    assert.notEqual(id, undefined, '应当有一个已武装的定时器');
    live.delete(id!);
    pending.get(id!)?.();
    for (let i = 0; i < 10; i += 1) await flush();
  };
  return { state, timers, live, fire };
}

function tempRepo(prefix: string): { dir: string; repo: Repo } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = createRepo(path.join(dir, 'advisor.db'));
  repo.migrate();
  return { dir, repo };
}

function cleanup(dir: string, repo: Repo): void {
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 只跑资产分析的定时任务：空库 → 完全离线（打新/标的/建议/期权全部显式关掉）。 */
function assetOnlyTask(over: Partial<ScheduleTask> = {}): ScheduleTask {
  return {
    id: 'sched_1',
    name: '盘前',
    enabled: true,
    mode: 'interval',
    intervalMinutes: 60,
    dailyTime: '08:30',
    runAssetAnalysis: true,
    runWatchlistAnalysis: false,
    runIpoAnalysis: false,
    runAdvice: false,
    ...over,
  };
}

interface FakeAgent {
  runtime: AgentRuntime;
  /** 每次 `run()` 产生的 run（按调用顺序）。 */
  runCalls: AgentRun[];
  /** 每次 `resume(runId)` 收到的 run id（按调用顺序）。 */
  resumeCalls: string[];
}

/**
 * 假 Agent：`run()` / `resume()` 按配置返回成功或失败的 run，并把 run 行写进真仓库
 * （真实的运行时也会落库；「已自动续跑」标记只对库里的原 run 生效）。
 */
function fakeAgent(
  repo: Repo,
  options: { now: () => number; runError?: string | null; resumeError?: string | null },
): FakeAgent {
  const runCalls: AgentRun[] = [];
  const resumeCalls: string[] = [];
  let seq = 0;

  const makeRun = (kind: AgentRunKind, error: string | null): AgentRun => {
    seq += 1;
    const id = `run-${seq}`;
    const iso = new Date(options.now()).toISOString();
    const run: AgentRun = {
      id,
      kind,
      status: error === null ? 'done' : 'error',
      target: null,
      title: kind,
      summary: '',
      error,
      turns: 1,
      promptTokens: 0,
      completionTokens: 0,
      startedAt: iso,
      finishedAt: iso,
      steps: [],
    };
    repo.createRun({
      id: run.id,
      kind: run.kind,
      status: run.status,
      target: run.target,
      title: run.title,
      error: run.error,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    });
    return run;
  };

  const runtime: AgentRuntime = {
    isConfigured: () => true,
    tools: () => [],
    run: async (request) => {
      const run = makeRun(request.kind, options.runError ?? null);
      runCalls.push(run);
      return run;
    },
    resume: async (runId: string) => {
      resumeCalls.push(runId);
      // 真实 runtime 续跑出来的 run 沿用原 run 的 kind —— 启动自愈的「补跑未执行阶段」
      // 会按 resumed kind 跳过刚续跑完的阶段，因此这里也如实回报。
      const originalKind = repo.getRun(runId)?.kind ?? 'asset-analysis';
      return makeRun(originalKind, options.resumeError ?? null);
    },
  };
  return { runtime, runCalls, resumeCalls };
}

/* ──────────────────────────── 纯判定：错误分类 ──────────────────────────── */

test('classifyErrorMessage：暂时性错误（5xx/429/轮次上限/中断/网络）都可重试', () => {
  const retryable = [
    'LLM 上游错误（HTTP 502）：Bad Gateway',
    'LLM 触发限流（HTTP 429）：rate limit exceeded',
    '达到最大推理轮次（20）仍未给出最终结论',
    '运行被中断（服务进程在本次分析结束前退出）',
    '请求失败：fetch failed',
    '连接超时（timeout）',
    'ECONNRESET socket hang up',
    'LLM 返回空响应',
    '模型返回了空结论（第 1 轮既没有正文也没有工具调用），请重试。',
    '完全没见过的错误',
  ];
  for (const message of retryable) {
    const verdict = classifyErrorMessage(message);
    assert.equal(verdict.retryable, true, `${message} 应可重试`);
    assert.equal(verdict.class, 'retryable', `${message} 分类应为 retryable`);
    assert.ok(verdict.reason.length > 0, '必须给出简短中文原因');
  }
  // 空错误信息保守重试（有次数上限兜底）。
  assert.equal(classifyErrorMessage(null).retryable, true);
  assert.equal(classifyErrorMessage('   ').class, 'retryable');
});

test('classifyErrorMessage：配置/认证/余额/接口/无轨迹属于致命错误，不重试', () => {
  const fatal = [
    ['未配置 API Key：请先在设置页填写', /未配置 API Key/],
    ['LLM 认证失败（HTTP 401）：API Key 无效', /认证/],
    ['LLM 账户余额或套餐额度不足（HTTP 402）', /余额|额度/],
    ['LLM 接口不存在（HTTP 404）：检查 baseUrl 与模型名', /接口|模型/],
    ['该运行（run-1）没有可续跑的轨迹：没有任何持久化消息', /轨迹/],
  ] as const;
  for (const [message, reasonPattern] of fatal) {
    const verdict = classifyErrorMessage(message);
    assert.equal(verdict.retryable, false, `${message} 不应重试`);
    assert.equal(verdict.class, 'fatal', `${message} 分类应为 fatal`);
    assert.match(verdict.reason, reasonPattern);
  }
});

test('classifyErrorMessage：用户取消单独归类（cancelled），不重试', () => {
  const verdict = classifyErrorMessage('已取消');
  assert.equal(verdict.class, 'cancelled');
  assert.equal(verdict.retryable, false);
  assert.match(verdict.reason, /取消/);
});

test('classifyRunFailure：只有 status=error 的 run 才按错误文案分类', () => {
  assert.equal(classifyRunFailure({ status: 'error', error: 'LLM 上游错误（HTTP 502）' }).retryable, true);
  assert.equal(classifyRunFailure({ status: 'error', error: 'LLM 认证失败（HTTP 401）' }).retryable, false);
  const done = classifyRunFailure({ status: 'done', error: null });
  assert.equal(done.retryable, false);
  assert.equal(done.class, 'fatal');
  assert.match(done.reason, /未失败/);
});

test('classifyPipelineError：进入阶段前的错误同样分类（未勾选步骤 / 未产生记录为致命）', () => {
  assert.equal(classifyPipelineError(new Error('本次流水线未勾选任何步骤')).retryable, false);
  assert.equal(classifyPipelineError(new Error('流水线未产生任何运行记录')).retryable, false);
  assert.equal(classifyPipelineError(new Error('LLM 上游错误（HTTP 502）')).retryable, true);
  assert.equal(classifyPipelineError('fetch failed').retryable, true);
  assert.equal(classifyPipelineError('已取消').class, 'cancelled');
});

/* ──────────────────────────── 纯判定：退避 / kinds ──────────────────────────── */

test('retryDelayMs：2/10/30 分钟基准，random=0.5 时无抖动且 3 次后钳制', () => {
  const noJitter = (): number => 0.5;
  assert.equal(retryDelayMs(1, noJitter), 2 * 60_000);
  assert.equal(retryDelayMs(2, noJitter), 10 * 60_000);
  assert.equal(retryDelayMs(3, noJitter), 30 * 60_000);
  assert.equal(retryDelayMs(9, noJitter), 30 * 60_000, '超过 3 次沿用最后一次的 30 分钟基准');
  // 基准持续时长必须与常量一致（改了常量而忘了同步测试会立刻失败）。
  assert.deepEqual([...AUTO_RETRY_DELAYS_MS], [120_000, 600_000, 1_800_000]);
  assert.equal(AUTO_RETRY_MAX_ATTEMPTS, 3);
  assert.equal(AUTO_RETRY_BOOT_DELAY_MS, 45_000);
});

test('retryDelayMs：±15% 抖动有界（random=0 下限、random=1 上限）', () => {
  assert.equal(retryDelayMs(1, () => 0), 102_000);
  assert.equal(retryDelayMs(1, () => 1), 138_000);

  const cases = [
    [1, 120_000],
    [2, 600_000],
    [3, 1_800_000],
    [9, 1_800_000],
  ] as const;
  for (const [attempt, base] of cases) {
    for (const random of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = retryDelayMs(attempt, () => random);
      assert.ok(
        delay >= Math.round(base * 0.85) - 1 && delay <= Math.round(base * 1.15) + 1,
        `第 ${attempt} 次随机源 ${random} 的退避应落在 ±15% 内，实际 ${delay}`,
      );
    }
  }
});

test('kindsForFlags：五个步骤开关 → 五个 run kind（启动自愈按它筛选被中断的 run）', () => {
  const all = { skipAsset: false, skipWatchlist: false, skipIpo: false, skipOption: false, skipAdvice: false };
  assert.deepEqual(kindsForFlags(all), [
    'asset-analysis',
    'watchlist-analysis',
    'ipo-analysis',
    'option-advice',
    'advice',
  ]);
  assert.deepEqual(
    kindsForFlags({ ...all, skipAsset: true, skipWatchlist: true, skipIpo: true, skipOption: true }),
    ['advice'],
  );
  assert.deepEqual(
    kindsForFlags({ ...all, skipWatchlist: true, skipIpo: true, skipOption: true, skipAdvice: true }),
    ['asset-analysis'],
  );
  assert.deepEqual(
    kindsForFlags({ ...all, skipAsset: true, skipIpo: true, skipOption: true, skipAdvice: true }),
    ['watchlist-analysis'],
  );
  assert.deepEqual(
    kindsForFlags({ ...all, skipAsset: true, skipWatchlist: true, skipOption: true, skipAdvice: true }),
    ['ipo-analysis'],
  );
  assert.deepEqual(
    kindsForFlags({ ...all, skipAsset: true, skipWatchlist: true, skipIpo: true, skipAdvice: true }),
    ['option-advice'],
  );
  assert.deepEqual(kindsForFlags({ ...all, skipAsset: true, skipWatchlist: true, skipIpo: true, skipOption: true, skipAdvice: true }), []);
});

/* ──────────────────────── 调度器：可重试失败 → 自动续跑 ──────────────────────── */

test('自动续跑：可重试的阶段失败 → 2 分钟后 resume，成功后原 run 标记「已自动续跑」', async () => {
  const clock = fakeClock(Date.parse('2026-10-16T09:00:00+08:00'));
  const { dir, repo } = tempRepo('aia-retry-');
  const agent = fakeAgent(repo, { now: () => clock.state.now, runError: 'LLM 上游错误（HTTP 502）：Bad Gateway' });
  const scheduler = createScheduler({
    getRepo: () => repo,
    agent: agent.runtime,
    logger: silentLogger,
    timers: clock.timers,
    now: () => clock.state.now,
    random: () => 0.5,
  });

  try {
    repo.saveSettings({ schedules: [assetOnlyTask()] });
    scheduler.start();
    assert.equal(scheduler.retryState(), null, '刚启动时没有排期的续跑');

    // 到点触发：资产分析失败（一条 error run）→ 应排一次自动续跑。
    clock.state.now += 60 * 60_000;
    await clock.fire();
    assert.equal(agent.runCalls.length, 1, '定时流水线应恰好跑一次资产分析');
    const failedRunId = agent.runCalls[0]!.id;
    assert.equal(agent.runCalls[0]!.status, 'error');

    const state = scheduler.retryState();
    assert.ok(state, '可重试失败必须排一次自动续跑');
    assert.equal(state.kind, 'resume');
    assert.equal(state.attempt, 1);
    assert.equal(state.maxAttempts, AUTO_RETRY_MAX_ATTEMPTS);
    assert.deepEqual(state.failedRunIds, [failedRunId]);
    assert.deepEqual(state.taskNames, ['盘前']);
    assert.equal(Date.parse(state.nextRunAt), clock.state.now + AUTO_RETRY_DELAYS_MS[0], '第一次等 2 分钟');
    assert.match(state.lastError, /HTTP 502/);

    const plan = scheduler.plan();
    assert.ok(
      plan.some((entry) => entry.name.includes('自动续跑')),
      `计划里必须出现自动续跑条目，实际 ${JSON.stringify(plan)}`,
    );
    assert.ok(Date.parse(scheduler.nextRunAt()!) > clock.state.now, '下一次触发必须是未来时间');
    assert.ok(
      !/已自动续跑/.test(repo.getRun(failedRunId)?.error ?? ''),
      '还在等待续跑时不能提前打「已自动续跑」标记',
    );

    // 精确推进 2 分钟（random=0.5 → 抖动为 0）→ 到期续跑。
    clock.state.now += AUTO_RETRY_DELAYS_MS[0];
    await clock.fire();
    assert.deepEqual(agent.resumeCalls, [failedRunId], '必须续跑那条失败的 run（而不是整条重跑）');
    assert.equal(scheduler.retryState(), null, '续跑成功后状态必须清空');
    assert.ok(repo.getSettings().lastRunAt, '续跑成功必须更新 lastRunAt');

    const original = repo.getRun(failedRunId);
    assert.ok(original);
    assert.match(original!.error ?? '', /已自动续跑/, '成功后必须在原 run 上留下标记');
    assert.match(original!.error ?? '', /新运行/, '标记里要带新 run id 便于追溯');
    assert.equal(original!.status, 'error', '原 run 的历史状态保持 error（已烧的 token 不回滚）');
    assert.ok(
      !scheduler.plan().some((entry) => entry.name.includes('自动续跑')),
      '续跑成功后计划里不再有自动续跑条目',
    );
  } finally {
    scheduler.stop();
    cleanup(dir, repo);
  }
});

test('自动续跑：不可重试的失败（HTTP 401 认证失败）不排期、不打标记', async () => {
  const clock = fakeClock(Date.parse('2026-10-16T09:00:00+08:00'));
  const { dir, repo } = tempRepo('aia-retry-');
  const agent = fakeAgent(repo, { now: () => clock.state.now, runError: 'LLM 认证失败（HTTP 401）：API Key 无效' });
  const scheduler = createScheduler({
    getRepo: () => repo,
    agent: agent.runtime,
    logger: silentLogger,
    timers: clock.timers,
    now: () => clock.state.now,
    random: () => 0.5,
  });

  try {
    repo.saveSettings({ schedules: [assetOnlyTask()] });
    scheduler.start();
    clock.state.now += 60 * 60_000;
    await clock.fire();

    assert.equal(agent.runCalls.length, 1);
    const failedRunId = agent.runCalls[0]!.id;
    assert.equal(scheduler.retryState(), null, '不可重试的失败不得排自动续跑');
    assert.ok(
      !scheduler.plan().some((entry) => entry.name.includes('自动续跑')),
      '计划里不得出现自动续跑条目',
    );
    assert.equal(agent.resumeCalls.length, 0);
    assert.ok(
      !/已自动续跑/.test(repo.getRun(failedRunId)?.error ?? ''),
      '放弃续跑时不得打「已自动续跑」标记',
    );
  } finally {
    scheduler.stop();
    cleanup(dir, repo);
  }
});

test('自动续跑：连续失败 3 次后停止（2/10/30 分钟退避），resume 恰好 3 次', async () => {
  const clock = fakeClock(Date.parse('2026-10-16T09:00:00+08:00'));
  const { dir, repo } = tempRepo('aia-retry-');
  const agent = fakeAgent(repo, {
    now: () => clock.state.now,
    runError: 'LLM 上游错误（HTTP 502）：Bad Gateway',
    resumeError: 'LLM 上游错误（HTTP 503）：Service Unavailable',
  });
  const scheduler = createScheduler({
    getRepo: () => repo,
    agent: agent.runtime,
    logger: silentLogger,
    timers: clock.timers,
    now: () => clock.state.now,
    random: () => 0.5,
  });

  try {
    repo.saveSettings({ schedules: [assetOnlyTask()] });
    scheduler.start();

    // 第 0 步：定时触发，流水线失败 → 排第 1 次续跑（等 2 分钟）。
    clock.state.now += 60 * 60_000;
    await clock.fire();
    const firstFailedId = agent.runCalls[0]!.id;
    assert.equal(scheduler.retryState()?.attempt, 1);

    // 第 1 次续跑：失败 → 排第 2 次（等 10 分钟）。
    clock.state.now += AUTO_RETRY_DELAYS_MS[0];
    await clock.fire();
    assert.deepEqual(agent.resumeCalls, [firstFailedId]);
    const second = scheduler.retryState();
    assert.equal(second?.attempt, 2);
    assert.equal(Date.parse(second!.nextRunAt), clock.state.now + AUTO_RETRY_DELAYS_MS[1]);

    // 第 2 次续跑：失败 → 排第 3 次（等 30 分钟）。
    clock.state.now += AUTO_RETRY_DELAYS_MS[1];
    await clock.fire();
    assert.equal(agent.resumeCalls.length, 2);
    const third = scheduler.retryState();
    assert.equal(third?.attempt, 3);
    assert.equal(Date.parse(third!.nextRunAt), clock.state.now + AUTO_RETRY_DELAYS_MS[2]);

    // 第 3 次续跑：仍失败 → 达到上限，停止重试。
    clock.state.now += AUTO_RETRY_DELAYS_MS[2];
    await clock.fire();
    assert.equal(agent.resumeCalls.length, 3, '最多只续跑 3 次');
    assert.equal(scheduler.retryState(), null, '第 3 次失败后必须清空续跑状态（不再无限重试）');
    assert.ok(
      !scheduler.plan().some((entry) => entry.name.includes('自动续跑')),
      '达到上限后计划里不得再有自动续跑条目',
    );
    assert.ok(
      !/已自动续跑/.test(repo.getRun(firstFailedId)?.error ?? ''),
      '一直失败（放弃）时不得打「已自动续跑」标记',
    );
  } finally {
    scheduler.stop();
    cleanup(dir, repo);
  }
});

/* ──────────────────────── 调度器：进程重启后的启动自愈 ──────────────────────── */

test('启动自愈：进程在定时流水线中途退出 → 45 秒后从 stale run 的轨迹自动续跑', async () => {
  const clock = fakeClock(Date.parse('2026-10-16T09:00:00+08:00'));
  const { dir, repo } = tempRepo('aia-heal-');
  const staleRunId = 'run-stale-1';
  const startedAtMs = clock.state.now + 1_000;

  try {
    // 模拟上次进程留下的现场：一条 running 的资产分析 run + 轨迹 + in-flight 标记。
    repo.createRun({
      id: staleRunId,
      kind: 'asset-analysis',
      status: 'running',
      target: null,
      title: '资产分析',
      startedAt: new Date(startedAtMs).toISOString(),
    });
    repo.addRunMessage({
      id: 'msg-1',
      runId: staleRunId,
      index: 0,
      role: 'system',
      content: '你是投资顾问',
      toolCalls: null,
      toolCallId: null,
      name: null,
      reasoningContent: null,
      createdAt: new Date(startedAtMs).toISOString(),
    });
    repo.addRunMessage({
      id: 'msg-2',
      runId: staleRunId,
      index: 1,
      role: 'user',
      content: '请分析持仓',
      toolCalls: null,
      toolCallId: null,
      name: null,
      reasoningContent: null,
      createdAt: new Date(startedAtMs + 1).toISOString(),
    });
    // boot 时的僵尸 run 回收（真实的 `index.ts` 启动路径也一样）。
    assert.equal(repo.failStaleRuns('运行被中断（服务进程在本次分析结束前退出）'), 1);
    saveInFlight(repo, {
      startedAt: new Date(clock.state.now).toISOString(),
      taskIds: ['sched_1'],
      taskNames: ['盘前'],
      flags: { skipAsset: false, skipWatchlist: true, skipIpo: true, skipOption: true, skipAdvice: true },
    });

    const agent = fakeAgent(repo, { now: () => clock.state.now });
    const scheduler = createScheduler({
      getRepo: () => repo,
      agent: agent.runtime,
      logger: silentLogger,
      timers: clock.timers,
      now: () => clock.state.now,
      random: () => 0.5,
    });

    try {
      scheduler.start();
      const state = scheduler.retryState();
      assert.ok(state, 'in-flight 标记 + stale run 轨迹必须触发自愈');
      assert.equal(state.kind, 'resume');
      assert.equal(state.attempt, 1);
      // 启动时若已有持久化续跑任务会替换 failedRunIds，因此断言「包含」而不是「等于」。
      assert.ok(state.failedRunIds.includes(staleRunId), `应续跑 stale run，实际 ${JSON.stringify(state.failedRunIds)}`);
      assert.deepEqual(state.taskNames, ['盘前']);
      assert.equal(Date.parse(state.nextRunAt), clock.state.now + AUTO_RETRY_BOOT_DELAY_MS, '启动后先等 45 秒再自愈');
      assert.ok(clock.live.size >= 1);

      // 到自愈时刻：从 stale run 的轨迹续跑成功。
      clock.state.now += AUTO_RETRY_BOOT_DELAY_MS;
      await clock.fire();
      assert.deepEqual(agent.resumeCalls, [staleRunId]);
      assert.equal(scheduler.retryState(), null, '自愈成功后状态清空');
      const healed = repo.getRun(staleRunId);
      assert.ok(healed);
      assert.match(healed!.error ?? '', /已自动续跑/, '自愈成功也要在原 run 上留标记');
      assert.equal(healed!.status, 'error');
      assert.ok(repo.getSettings().lastRunAt, '自愈成功必须更新 lastRunAt');
      assert.equal(agent.runCalls.length, 0, '有可续跑轨迹时不应整条重跑');
    } finally {
      scheduler.stop();
    }
  } finally {
    cleanup(dir, repo);
  }
});

/* ──────────────── 调度器：重启自愈时补跑「没来得及执行」的阶段 ──────────────── */

/** 往临时仓库里写一条 run 行（可附带若干条轨迹消息，供自愈的 hasTranscript 判定）。 */
function seedRun(
  repo: Repo,
  input: { id: string; kind: AgentRunKind; status: 'running' | 'done'; startedAt: string; messages?: number },
): void {
  repo.createRun({
    id: input.id,
    kind: input.kind,
    status: input.status,
    target: null,
    title: input.kind,
    startedAt: input.startedAt,
    ...(input.status === 'done' ? { finishedAt: input.startedAt } : {}),
  });
  for (let index = 0; index < (input.messages ?? 0); index += 1) {
    repo.addRunMessage({
      id: `${input.id}-msg-${index}`,
      runId: input.id,
      index,
      role: index === 0 ? 'system' : 'user',
      content: index === 0 ? '你是投资顾问' : '请继续分析',
      toolCalls: null,
      toolCallId: null,
      name: null,
      reasoningContent: null,
      createdAt: new Date(Date.parse(input.startedAt) + index).toISOString(),
    });
  }
}

test('启动自愈：续跑被中断的阶段后补跑没来得及执行的阶段（已完成的不重跑）', async () => {
  const clock = fakeClock(Date.parse('2026-10-16T09:00:00+08:00'));
  const { dir, repo } = tempRepo('aia-followup-');
  const assetRunId = 'run-asset-done';
  const watchRunId = 'run-watch-stale';
  const markerAt = clock.state.now;
  const at = (offset: number): string => new Date(markerAt + offset).toISOString();

  try {
    // 上次进程中断时的现场：资产分析**已完成**；标的分析跑到一半（running + 轨迹）；
    // 建议阶段连 run 行都没有（进程在它开始前就退出了）。
    seedRun(repo, { id: assetRunId, kind: 'asset-analysis', status: 'done', startedAt: at(1_000) });
    seedRun(repo, { id: watchRunId, kind: 'watchlist-analysis', status: 'running', startedAt: at(2_000), messages: 2 });
    assert.equal(
      repo.failStaleRuns('运行被中断（服务进程在本次分析结束前退出）'),
      1,
      '只有 running 的那条会被 boot 回收成 error',
    );
    saveInFlight(repo, {
      startedAt: at(0),
      taskIds: ['sched_1'],
      taskNames: ['盘前'],
      flags: { skipAsset: false, skipWatchlist: false, skipIpo: true, skipOption: true, skipAdvice: false },
    });

    const agent = fakeAgent(repo, { now: () => clock.state.now });
    const scheduler = createScheduler({
      getRepo: () => repo,
      agent: agent.runtime,
      logger: silentLogger,
      timers: clock.timers,
      now: () => clock.state.now,
      random: () => 0.5,
    });

    try {
      scheduler.start();
      const state = scheduler.retryState();
      assert.ok(state, 'in-flight 标记 + stale run 轨迹必须触发自愈');
      assert.equal(state.kind, 'resume');
      assert.equal(state.attempt, 1);
      assert.deepEqual(state.failedRunIds, [watchRunId], '只续跑被中断的标的分析，不重跑已完成的资产分析');
      // 落库的补跑开关先把已完成阶段标成跳过：资产分析不跑；标的（待续跑）/建议仍待补。
      assert.deepEqual(loadRetryJob(repo)?.followUpFlags, {
        skipAsset: true,
        skipWatchlist: false,
        skipIpo: true,
        skipOption: true,
        skipAdvice: false,
      });

      // 到自愈时刻：先续跑标的分析，再只补跑从没执行过的建议阶段。
      clock.state.now += AUTO_RETRY_BOOT_DELAY_MS;
      await clock.fire();

      assert.deepEqual(agent.resumeCalls, [watchRunId], '先续跑被中断的标的分析');
      assert.deepEqual(
        agent.runCalls.map((run) => run.kind),
        ['advice'],
        '补跑时只跑建议阶段（资产已完成、标的刚续跑，都不重跑）',
      );
      assert.equal(agent.runCalls[0]!.status, 'done');
      assert.equal(scheduler.retryState(), null, '续跑 + 补跑都成功后状态清空');
      assert.match(repo.getRun(watchRunId)!.error ?? '', /已自动续跑/);
      assert.equal(repo.getRun(assetRunId)!.error, null, '已完成阶段既不重跑也不打标记');
      assert.ok(repo.getSettings().lastRunAt, '补跑成功同样更新 lastRunAt');
    } finally {
      scheduler.stop();
    }
  } finally {
    cleanup(dir, repo);
  }
});

test('启动自愈：被中断的恰好是最后一个阶段时，续跑完不再额外补跑（runCalls=0）', async () => {
  const clock = fakeClock(Date.parse('2026-10-16T09:00:00+08:00'));
  const { dir, repo } = tempRepo('aia-followup-');
  const adviceRunId = 'run-advice-stale';
  const markerAt = clock.state.now;
  const at = (offset: number): string => new Date(markerAt + offset).toISOString();

  try {
    // 资产/标的都已完成，只有最后的建议阶段被中断：补跑开关里没有剩余阶段。
    seedRun(repo, { id: 'run-asset-done', kind: 'asset-analysis', status: 'done', startedAt: at(1_000) });
    seedRun(repo, { id: 'run-watch-done', kind: 'watchlist-analysis', status: 'done', startedAt: at(2_000) });
    seedRun(repo, { id: adviceRunId, kind: 'advice', status: 'running', startedAt: at(3_000), messages: 2 });
    assert.equal(repo.failStaleRuns('运行被中断（服务进程在本次分析结束前退出）'), 1);
    saveInFlight(repo, {
      startedAt: at(0),
      taskIds: ['sched_1'],
      taskNames: ['盘前'],
      flags: { skipAsset: false, skipWatchlist: false, skipIpo: true, skipOption: true, skipAdvice: false },
    });

    const agent = fakeAgent(repo, { now: () => clock.state.now });
    const scheduler = createScheduler({
      getRepo: () => repo,
      agent: agent.runtime,
      logger: silentLogger,
      timers: clock.timers,
      now: () => clock.state.now,
      random: () => 0.5,
    });

    try {
      scheduler.start();
      assert.deepEqual(scheduler.retryState()?.failedRunIds, [adviceRunId], '只续跑被中断的建议阶段');

      clock.state.now += AUTO_RETRY_BOOT_DELAY_MS;
      await clock.fire();

      assert.deepEqual(agent.resumeCalls, [adviceRunId]);
      assert.equal(agent.runCalls.length, 0, '所有阶段都已完成或已续跑 → 不需要补跑整条流水线');
      assert.equal(scheduler.retryState(), null);
      assert.match(repo.getRun(adviceRunId)!.error ?? '', /已自动续跑/);
    } finally {
      scheduler.stop();
    }
  } finally {
    cleanup(dir, repo);
  }
});