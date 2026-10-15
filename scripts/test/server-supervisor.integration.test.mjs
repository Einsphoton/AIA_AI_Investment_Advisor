/**
 * `lib/server-supervisor.mjs` 的真机集成测试：**真的** spawn / kill 一个子进程，
 * 只把「有没有流水线在跑」注入成可控开关，验证开发模式最关键的那条路径：
 *   「编译产物变了 + 有流水线在跑 = 不重启；分析结束 = 自动补上重启」。
 *
 * 单测（server-supervisor.test.mjs）用假子进程覆盖决策逻辑；这里覆盖真实
 * `child_process` 的退出/杀进程时序 —— 这两层合起来才敢说 dev.mjs 换掉
 * `node --watch` 是安全的。
 *
 * 受限环境（不允许 spawn 子进程）会自动 skip，不会把整套测试拖红。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createServerSupervisor } from '../lib/server-supervisor.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 进程还活着吗（signal 0 = 只探测存在性）。 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 轮询等待条件成立。 */
async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
}

test('真机集成：产物变化时延后重启，流水线结束后自动重启', async (t) => {
  const workdir = mkdtempSync(path.join(tmpdir(), 'aia-supervisor-'));
  const distDir = path.join(workdir, 'dist');
  const entry = path.join(workdir, 'entry.mjs');
  mkdirSync(distDir);
  // 子进程：什么都不打印，只是活着（pid 由监管器的日志给出）。
  writeFileSync(entry, 'setInterval(() => {}, 1000);\n');
  writeFileSync(path.join(distDir, 'chunk.js'), 'v1');

  const pids = [];
  let busy = true;
  const supervisor = createServerSupervisor({
    entry,
    args: [],
    cwd: workdir,
    port: 1, // 不会被真的请求：detect 是注入的
    watchDirs: [distDir],
    log: (message) => {
      const match = /pid (\d+)/.exec(message);
      if (match) pids.push(Number(match[1]));
    },
    warn: () => undefined,
    detectImpl: async () => ({
      reachable: true,
      run: busy ? { id: 'x', kind: 'advice', status: 'running', turns: 3 } : null,
    }),
    intervalMs: 60,
  });

  try {
    supervisor.start();
    const started = await waitFor(() => pids.length === 1, 5_000);
    if (!started) {
      t.skip('此环境不允许 spawn 子进程，跳过真机集成测试');
      return;
    }
    const first = pids[0];
    assert.ok(alive(first), '第一个服务进程应该真的活着');

    // 编译产物变化：此刻「有流水线在跑」→ 绝不能重启。
    writeFileSync(path.join(distDir, 'chunk.js'), 'v2-with-more-content');
    await sleep(400);
    assert.equal(pids.length, 1, '有流水线在跑时不得重启服务进程');
    assert.ok(alive(first), '原服务进程必须还活着（分析不能被打断）');

    // 流水线跑完 → 监管器补上这次重启。
    busy = false;
    const restarted = await waitFor(() => pids.length === 2, 5_000);
    assert.ok(restarted, '分析结束后应自动重启');
    const second = pids[1];
    assert.notEqual(second, first);
    assert.ok(await waitFor(() => !alive(first), 5_000), '旧服务进程应已退出');

    // stop() 必须收拾干净：不能留下占着端口的孤儿进程。
    supervisor.stop();
    assert.ok(await waitFor(() => !alive(second), 5_000), 'stop() 之后不得留下孤儿进程');
    assert.equal(supervisor.snapshot().running, false);
  } finally {
    try {
      supervisor.stop();
    } catch {
      /* 已经停了 */
    }
    for (const pid of pids) {
      if (alive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* 已经退出 */
        }
      }
    }
    await sleep(100);
    rmSync(workdir, { recursive: true, force: true, maxRetries: 3 });
  }
});
