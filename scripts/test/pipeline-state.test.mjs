/**
 * `lib/pipeline-state.mjs` 的确定性单测：起一个只回答 `/api/agent/runs` 的本地
 * HTTP 服务，断言「有 / 没有流水线在跑」的判定与「服务不可达」的降级行为。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { RUNS_PATH, describeRun, detectRunningPipeline } from '../lib/pipeline-state.mjs';

/** 起一个临时服务，返回 baseUrl。 */
async function withRuns(payload, run) {
  const server = http.createServer((request, response) => {
    if (!request.url.startsWith('/api/agent/runs')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('detectRunningPipeline：命中 status=running 的那条', async () => {
  await withRuns(
    [
      { id: '01aa29f7-3c8d-4b86', kind: 'asset-analysis', status: 'done', turns: 4 },
      { id: '45977223-6935-4144', kind: 'watchlist-analysis', status: 'running', turns: 9 },
      { id: 'b8bb963b-938f-455d', kind: 'asset-analysis', status: 'error', turns: 0 },
    ],
    async (baseUrl) => {
      const result = await detectRunningPipeline(baseUrl);
      assert.equal(result.reachable, true);
      assert.equal(result.run?.id, '45977223-6935-4144');
    },
  );
});

test('detectRunningPipeline：只有 done/error 时 run=null（放行构建）', async () => {
  await withRuns(
    [
      { id: 'a', status: 'done' },
      { id: 'b', status: 'error' },
    ],
    async (baseUrl) => {
      const result = await detectRunningPipeline(baseUrl);
      assert.equal(result.reachable, true);
      assert.equal(result.run, null);
    },
  );
});

test('detectRunningPipeline：服务没在监听 → reachable=false 且不抛错', async () => {
  // 1 号端口不会有服务，连接立即被拒绝。
  const result = await detectRunningPipeline('http://127.0.0.1:1', { timeoutMs: 500 });
  assert.equal(result.reachable, false);
  assert.equal(result.run, null);
});

test('detectRunningPipeline：非 200 / 非数组响应按「不可达」处理', async () => {
  await withRuns({ error: 'boom' }, async (baseUrl) => {
    const result = await detectRunningPipeline(baseUrl);
    assert.equal(result.reachable, true);
    assert.equal(result.run, null);
  });
});

test('detectRunningPipeline：请求路径就是 /api/agent/runs?limit=…（服务端已有接口）', () => {
  assert.match(RUNS_PATH, /^\/api\/agent\/runs\?limit=\d+$/);
});

test('describeRun：带上 kind / 短 id / 轮次，缺失字段也不抛错', () => {
  const text = describeRun({ id: '45977223-6935-4144-b935', kind: 'watchlist-analysis', turns: 9, startedAt: 'T0' });
  assert.match(text, /watchlist-analysis/);
  assert.match(text, /45977223/);
  assert.match(text, /9 轮/);
  assert.equal(describeRun(null), '未知运行');
  assert.equal(typeof describeRun({}), 'string');
});
