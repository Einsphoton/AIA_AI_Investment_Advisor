/**
 * P3 inference metrics tests — owner: agent-engine.
 *
 * The right-bottom reasoning panel shows TTFT / generation speed / token usage /
 * KV-cache hit rate **while the model is thinking**, so the numbers must come
 * off the real stream: a local fake LLM speaks the OpenAI SSE protocol and the
 * `metrics` events of `runAgent` are asserted end to end.
 *
 * Also covers the provider dialects for prompt-cache hits (OpenAI/OpenCode
 * `prompt_tokens_details.cached_tokens`, DeepSeek `prompt_cache_hit_tokens`,
 * Anthropic-style `cache_read_input_tokens`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentEvent, InferenceMetrics } from '@aia/shared';

import { createRepo } from '../src/db/repo.js';
import { runAgent } from '../src/agent/loop.js';
import { cachedTokensFromUsage } from '../src/agent/llm.js';
import type { AgentDeps, LoggerLike } from '../src/types/agent.js';
import type { Repo } from '../src/types/repo.js';

const silentLogger: LoggerLike = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function sseHeaders(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
}

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Turn 1: some text + one unknown tool call (so the loop runs a second turn),
 * usage reported the OpenAI/OpenCode way (cache under `prompt_tokens_details`).
 */
function writeTurnOne(res: http.ServerResponse): void {
  sseHeaders(res);
  res.write(sseChunk({ model: 'fake-model', choices: [{ delta: { content: '第一轮' }, finish_reason: null }] }));
  res.write(
    sseChunk({
      model: 'fake-model',
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', type: 'function', function: { name: 'no_such_tool_xyz', arguments: '{"a":1}' } },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
  );
  res.write(
    sseChunk({
      model: 'fake-model',
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } },
    }),
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

/** Turn 2: final answer, usage reported the DeepSeek way. */
function writeTurnTwo(res: http.ServerResponse): void {
  sseHeaders(res);
  res.write(sseChunk({ model: 'fake-model', choices: [{ delta: { content: '结论' }, finish_reason: null }] }));
  res.write(
    sseChunk({
      model: 'fake-model',
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 200, completion_tokens: 20, prompt_cache_hit_tokens: 150, prompt_cache_miss_tokens: 50 },
    }),
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

async function startFakeLlm(handle: (requestNo: number, res: http.ServerResponse) => void): Promise<{
  baseUrl: string;
  stop: () => Promise<void>;
}> {
  let count = 0;
  const server = http.createServer((request, res) => {
    request.on('end', () => {
      count += 1;
      handle(count, res);
    });
    request.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake LLM failed to bind a port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function tempRepo(baseUrl: string): { repo: Repo; deps: AgentDeps; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-metrics-'));
  const repo = createRepo(path.join(dir, 'advisor.db'));
  repo.migrate();
  repo.saveSettings({
    llm: { baseUrl, apiKey: 'test-key', model: 'fake-model', timeoutMs: 60_000, contextTokens: 48_000 },
  });
  return { repo, dir, deps: { getRepo: () => repo, logger: silentLogger, dataDir: dir, providerKeys: {} } };
}

function closeAndRemove(repo: Repo, dir: string): void {
  try {
    repo.close();
  } catch {
    /* already closed */
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp dir left behind: harmless */
  }
}

test('P3: 每轮 LLM 请求都发出 metrics 事件（TTFT / 用量 / KV cache 命中 / 生成速度）', { timeout: 20_000 }, async () => {
  const fake = await startFakeLlm((requestNo, res) => (requestNo === 1 ? writeTurnOne(res) : writeTurnTwo(res)));
  const { deps, repo, dir } = tempRepo(fake.baseUrl);
  const events: AgentEvent[] = [];

  try {
    const run = await runAgent(deps, {
      kind: 'custom',
      title: '指标测试',
      goal: '请分析一下',
      sink: (event) => events.push(event),
    });

    assert.equal(run.status, 'done');
    assert.equal(run.turns, 2);

    const metrics = events.filter((event): event is Extract<AgentEvent, { type: 'metrics' }> => event.type === 'metrics');
    const done = metrics.filter((event) => event.metrics.phase === 'done').map((event) => event.metrics);
    const firstTokens = metrics.filter((event) => event.metrics.phase === 'first-token').map((event) => event.metrics);

    assert.equal(done.length, 2, '两轮请求各应有一条 phase=done 指标');
    assert.equal(firstTokens.length, 2, '两轮请求各应在首个 token 时先推一条 phase=first-token 指标');
    assert.deepEqual(
      done.map((m: InferenceMetrics) => m.turn),
      [1, 2],
      'turn 必须按实际推理轮次递增',
    );

    // 第 1 轮：OpenAI/OpenCode 形态的缓存字段。
    assert.equal(done[0]!.model, 'fake-model');
    assert.equal(done[0]!.promptTokens, 100);
    assert.equal(done[0]!.completionTokens, 5);
    assert.equal(done[0]!.cachedTokens, 80);
    assert.ok(typeof done[0]!.ttftMs === 'number' && done[0]!.ttftMs >= 0, 'TTFT 必须是毫秒数');
    assert.ok(typeof done[0]!.latencyMs === 'number' && done[0]!.latencyMs >= done[0]!.ttftMs!, '总耗时不得小于 TTFT');
    assert.ok(done[0]!.tokensPerSecond !== null && done[0]!.tokensPerSecond >= 0, '生成速度必须可计算');

    // 第 2 轮：DeepSeek 形态的缓存字段。
    assert.equal(done[1]!.promptTokens, 200);
    assert.equal(done[1]!.completionTokens, 20);
    assert.equal(done[1]!.cachedTokens, 150);

    // first-token 阶段只应有计时信息，用量仍未可知。
    for (const metrics of firstTokens) {
      assert.equal(metrics.promptTokens, 0);
      assert.equal(metrics.completionTokens, 0);
      assert.equal(metrics.cachedTokens, 0);
      assert.equal(metrics.latencyMs, null);
      assert.ok(metrics.ttftMs !== null && metrics.ttftMs >= 0);
    }

    // 用量必须同时沉淀到运行记录里（活动页 / 运行历史依赖它）。
    const row = repo.getRun(run.id);
    assert.equal(row?.promptTokens, 300, '两轮 prompt tokens 应累加');
    assert.equal(row?.completionTokens, 25, '两轮 completion tokens 应累加');

    // 步骤详情把 cache 命中与首字延迟写进时间线，便于事后回看。
    const detail = repo
      .listSteps(run.id)
      .map((step) => step.detail ?? '')
      .join('\n');
    assert.match(detail, /KV cache 命中 80/);
    assert.match(detail, /首字 \d+ms/);
  } finally {
    await fake.stop();
    closeAndRemove(repo, dir);
  }
});

test('P3: cachedTokensFromUsage 覆盖三种厂商口径并对脏数据退化为 0', () => {
  assert.equal(cachedTokensFromUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 64 } }), 64);
  assert.equal(cachedTokensFromUsage({ prompt_cache_hit_tokens: 900 }), 900);
  assert.equal(cachedTokensFromUsage({ cache_read_input_tokens: 12 }), 12);
  // 优先级：OpenAI 明细字段先于 DeepSeek 字段。
  assert.equal(
    cachedTokensFromUsage({ prompt_tokens_details: { cached_tokens: 7 }, prompt_cache_hit_tokens: 999 }),
    7,
  );
  assert.equal(cachedTokensFromUsage(null), 0);
  assert.equal(cachedTokensFromUsage({}), 0);
  assert.equal(cachedTokensFromUsage({ prompt_cache_hit_tokens: 0 }), 0);
  assert.equal(cachedTokensFromUsage({ prompt_tokens_details: { cached_tokens: -5 } }), 0);
  assert.equal(cachedTokensFromUsage({ prompt_cache_hit_tokens: Number.NaN }), 0);
});

test('P3: cache 命中数不会超过 prompt tokens（防止命中率 > 100%）', { timeout: 20_000 }, async () => {
  const fake = await startFakeLlm((_requestNo, res) => {
    sseHeaders(res);
    res.write(sseChunk({ model: 'fake-model', choices: [{ delta: { content: '结论' }, finish_reason: null }] }));
    res.write(
      sseChunk({
        model: 'fake-model',
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 999 },
      }),
    );
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const { deps, repo, dir } = tempRepo(fake.baseUrl);
  const events: AgentEvent[] = [];

  try {
    await runAgent(deps, { kind: 'custom', title: '越界缓存测试', goal: '请分析一下', sink: (event) => events.push(event) });
    const done = events.find(
      (event): event is Extract<AgentEvent, { type: 'metrics' }> => event.type === 'metrics' && event.metrics.phase === 'done',
    );
    assert.ok(done);
    assert.equal(done!.metrics.promptTokens, 10);
    assert.equal(done!.metrics.cachedTokens, 10, '命中数必须被钳制到 prompt tokens 以内');
  } finally {
    await fake.stop();
    closeAndRemove(repo, dir);
  }
});
