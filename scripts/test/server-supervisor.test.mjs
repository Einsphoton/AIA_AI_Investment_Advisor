/**
 * `lib/server-supervisor.mjs` 的确定性单测。
 *
 * 这个模块是「本仓库最贵的一次事故」的补丁：`node --watch` 在编译产物变化时无条件
 * 重启服务，把正在跑的 AI 分析（跑在同一个进程里）判成中断。所以核心用例就是
 * **「产物变了 + 有流水线在跑 = 不重启」**，以及它随后能正常补上重启。
 *
 * spawn / 探测 / 指纹 / 计时器全部注入，测试里不真的起进程。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createServerSupervisor } from '../lib/server-supervisor.mjs';

/** 假子进程：`kill()` 同步派发一次 `exit`（之后再 kill 就是 no-op，与真实 child_process 一致）。 */
function fakeChild(pid) {
  const handlers = new Map();
  return {
    pid,
    kills: [],
    exited: false,
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return this;
    },
    once(event, handler) {
      const wrapped = (...args) => {
        this.off(event, wrapped);
        handler(...args);
      };
      return this.on(event, wrapped);
    },
    off(event, handler) {
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((entry) => entry !== handler),
      );
      return this;
    },
    emit(event, ...args) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(...args);
    },
    kill(signal = 'SIGTERM') {
      if (this.exited) return false;
      this.exited = true;
      this.kills.push(signal);
      this.emit('exit', null, signal);
      return true;
    },
  };
}

/**
 * 建一个可手动驱动的监管器。
 * `timers.interval()` 触发一次轮询并返回其 promise（因此测试可以 await）；
 * `timers.runTimeouts()` 手动点掉所有到期的 setTimeout（崩溃重启延迟 / 兜底强杀）。
 */
function harness(overrides = {}) {
  const logs = [];
  const warns = [];
  const children = [];
  const timeouts = [];
  let fingerprint = 'fp-0';
  let clock = 1_000_000;
  let intervalFn = null;
  let detectImpl = async () => ({ reachable: true, run: null });

  const supervisor = createServerSupervisor({
    entry: 'C:/fake/packages/server/dist/index.js',
    port: 8787,
    watchDirs: ['C:/fake/dist'],
    log: (message) => logs.push(message),
    warn: (message) => warns.push(message),
    spawnImpl: () => {
      const child = fakeChild(1000 + children.length);
      children.push(child);
      return child;
    },
    detectImpl: (baseUrl) => detectImpl(baseUrl),
    fingerprintImpl: () => fingerprint,
    now: () => clock,
    setIntervalImpl: (fn) => {
      intervalFn = fn;
      return { unref() {} };
    },
    clearIntervalImpl: () => {
      intervalFn = null;
    },
    setTimeoutImpl: (fn) => {
      const handle = { fn, cleared: false, fired: false, unref() {} };
      timeouts.push(handle);
      return handle;
    },
    clearTimeoutImpl: (handle) => {
      if (handle) handle.cleared = true;
    },
    ...overrides,
  });

  return {
    supervisor,
    logs,
    warns,
    children,
    setFingerprint: (value) => {
      fingerprint = value;
    },
    setDetect: (value) => {
      detectImpl = value;
    },
    advance: (ms) => {
      clock += ms;
    },
    tick: async () => {
      assert.ok(intervalFn, '监管器还没 start()，没有轮询回调');
      await intervalFn();
    },
    runTimeouts: () => {
      for (let guard = 0; guard < 50; guard += 1) {
        const next = timeouts.find((handle) => !handle.cleared && !handle.fired);
        if (!next) return;
        next.fired = true;
        next.fn();
      }
      throw new Error('定时器没有收敛（可能有重启风暴）');
    },
  };
}

test('start()：拉起服务进程，并记录指纹基线', () => {
  const h = harness();
  h.supervisor.start();
  assert.equal(h.children.length, 1);
  assert.equal(h.supervisor.snapshot().running, true);
  assert.equal(h.supervisor.snapshot().pendingRestart, false);
});

test('产物没变化：不重启', async () => {
  const h = harness();
  h.supervisor.start();
  await h.tick();
  await h.tick();
  assert.equal(h.children.length, 1, '指纹没变不应该产生新进程');
  assert.equal(h.children[0].kills.length, 0);
});

test('产物变化 + 没有流水线：立刻重启（保留原有的开发体验）', async () => {
  const h = harness();
  h.supervisor.start();
  h.setFingerprint('fp-1');
  await h.tick();
  assert.equal(h.children.length, 2, '空闲时应重启');
  assert.ok(h.children[0].kills.includes('SIGTERM'), '旧进程应被终止');
  assert.ok(
    h.logs.some((line) => line.includes('编译产物已更新')),
    '应记录重启原因',
  );
});

test('产物变化 + 有流水线在跑：延后重启，不杀服务进程（核心用例）', async () => {
  const h = harness();
  h.supervisor.start();
  h.setDetect(async () => ({
    reachable: true,
    run: { id: '45977223-6935-4144', kind: 'watchlist-analysis', status: 'running', turns: 9 },
  }));
  h.setFingerprint('fp-1');
  await h.tick();

  assert.equal(h.children.length, 1, '有流水线时绝不能重启');
  assert.equal(h.children[0].kills.length, 0, '不能杀进程');
  assert.equal(h.supervisor.snapshot().pendingRestart, true, '应记住这次待重启');
  assert.ok(
    h.warns.some((line) => line.includes('流水线正在运行') && line.includes('watchlist-analysis')),
    '应提示已延后重启',
  );

  // 再轮询几次也不该重启（指纹没再变，但待重启仍未应用）。
  await h.tick();
  await h.tick();
  assert.equal(h.children.length, 1);

  // 流水线跑完 → 下一次轮询补上重启。
  h.setDetect(async () => ({ reachable: true, run: null }));
  await h.tick();
  assert.equal(h.children.length, 2, '分析结束后应自动重启');
  assert.equal(h.supervisor.snapshot().pendingRestart, false);
});

test('延后超过上限：强制重启并明确告知分析会被判为中断', async () => {
  const h = harness({ maxDeferMs: 60_000, busyLogIntervalMs: 0 });
  h.supervisor.start();
  h.setDetect(async () => ({ reachable: true, run: { id: 'x', kind: 'advice', status: 'running', turns: 20 } }));
  h.setFingerprint('fp-1');
  await h.tick();
  assert.equal(h.children.length, 1);

  h.advance(61_000);
  await h.tick();
  assert.equal(h.children.length, 2, '超时后应强制重启');
  assert.ok(
    h.warns.some((line) => line.includes('强制重启') && line.includes('续跑')),
    '应提示可以续跑',
  );
});

test('探测失败：按「空闲」处理（拿不到状态不该永久卡住重启）', async () => {
  const h = harness();
  h.supervisor.start();
  h.setDetect(async () => {
    throw new Error('ECONNREFUSED');
  });
  h.setFingerprint('fp-1');
  await h.tick();
  assert.equal(h.children.length, 2);
  assert.ok(h.warns.some((line) => line.includes('探测流水线状态失败')));
});

test('服务崩溃：自动拉起；连续「起来就退」达到上限后停手', () => {
  const h = harness();
  h.supervisor.start();
  h.children[0].emit('exit', 1, null); // 未到 earlyExitMs（时钟没走）→ 计入 early exit
  h.runTimeouts(); // 走完「崩溃 → 延迟 → 重启」
  assert.equal(h.children.length, 2, '崩溃后应自动重启');
  assert.ok(h.warns.some((line) => line.includes('自动重启')));

  for (let index = 0; index < 4; index += 1) {
    h.children[h.children.length - 1].emit('exit', 1, null);
    h.runTimeouts();
  }
  assert.ok(
    h.warns.some((line) => line.includes('停止自动重启')),
    '连续快速退出应停止重启风暴',
  );
  assert.equal(h.children.length, 5, '上限 maxEarlyExits=5 后不再新增进程');
});

test('stop()：停止轮询并结束服务进程', () => {
  const h = harness();
  h.supervisor.start();
  h.supervisor.stop();
  assert.equal(h.children[0].kills.length, 1);
  assert.equal(h.supervisor.snapshot().running, false);
});
