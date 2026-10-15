/**
 * P0-2 end-to-end cancellation tests.
 *
 * Owner: agent-engine. A **local fake LLM** (an in-process HTTP server speaking
 * the OpenAI SSE protocol on 127.0.0.1) is injected through the stored
 * `llm.baseUrl`, so the real `createLlmClient` -> `fetch` -> `AbortSignal` path is
 * exercised end to end.
 *
 * Asserts docs/ARCHITECTURE.md §4.4: cancel -> stop immediately, `status='error'`,
 * `error='已取消'`, partial text kept in `summary`, transcript already persisted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AGENT_RESUME_EXTRA_TURNS, type AgentEvent } from '@aia/shared';

import { createRepo } from '../src/db/repo.js';
import { runAgent } from '../src/agent/loop.js';
import type { AgentDeps, LoggerLike } from '../src/types/agent.js';
import type { Repo } from '../src/types/repo.js';

const TURN_ONE_TEXT = '第一轮已经拿到的部分结论';

const silentLogger: LoggerLike = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

interface FakeLlm {
  baseUrl: string;
  /** How many `/chat/completions` requests the fake server received. */
  requests: () => number;
  stop: () => Promise<void>;
}

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

/** SSE answer of turn 1: some text plus one (unknown) tool call. */
function writeTurnOne(res: http.ServerResponse): void {
  sseHeaders(res);
  res.write(sseChunk({ model: 'fake-model', choices: [{ delta: { content: TURN_ONE_TEXT }, finish_reason: null }] }));
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
      usage: { prompt_tokens: 11, completion_tokens: 5 },
    }),
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

/** Starts a minimal OpenAI-compatible server; `handle` owns the response. */
async function startFakeLlm(handle: (requestNo: number, res: http.ServerResponse) => void): Promise<FakeLlm> {
  let count = 0;
  const server = http.createServer((request, res) => {
    request.on('end', () => {
      count += 1;
      handle(count, res);
    });
    request.resume(); // drain the body, then the 'end' handler answers
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake LLM failed to bind a port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests: () => count,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function tempRepo(baseUrl: string): { repo: Repo; deps: AgentDeps; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-cancel-'));
  const repo = createRepo(path.join(dir, 'advisor.db'));
  repo.migrate();
  repo.saveSettings({
    llm: { baseUrl, apiKey: 'test-key', model: 'fake-model', timeoutMs: 60_000, contextTokens: 48_000 },
  });
  return { repo, dir, deps: { getRepo: () => repo, logger: silentLogger, dataDir: dir, providerKeys: {} } };
}

/** Closes the SQLite handle (Windows keeps open files locked) and cleans up. */
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

test('P0-2: 第 2 轮前取消，不再发起 LLM 调用、保留部分结论、状态与轨迹一致', { timeout: 20_000 }, async () => {
  const fake = await startFakeLlm((_requestNo, res) => writeTurnOne(res));
  const { deps, repo, dir } = tempRepo(fake.baseUrl);
  const controller = new AbortController();
  const events: AgentEvent[] = [];

  const started = Date.now();
  try {
    const run = await runAgent(deps, {
      kind: 'custom',
      title: '取消测试',
      goal: '请分析一下',
      signal: controller.signal,
      sink: (event) => {
        events.push(event);
        // Cancel right after the first tool finished: i.e. before turn 2.
        if (event.type === 'tool-result') controller.abort();
      },
    });
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 10_000, `运行应在合理时间内结束（实际 ${elapsed}ms）`);
    assert.equal(run.status, 'error');
    assert.match(run.error ?? '', /已取消/);
    assert.match(run.summary, new RegExp(TURN_ONE_TEXT), 'summary 必须保留已拿到的部分文本');
    assert.equal(fake.requests(), 1, '取消后不得再发起第 2 轮 LLM 调用');

    // Streamed lifecycle: error + run-finished(status=error, partial summary).
    const errorEvent = events.find((event) => event.type === 'error');
    assert.ok(errorEvent && errorEvent.type === 'error' && /已取消/.test(errorEvent.message));
    const finished = events.find((event) => event.type === 'run-finished');
    assert.ok(finished && finished.type === 'run-finished');
    if (finished && finished.type === 'run-finished') {
      assert.equal(finished.status, 'error');
      assert.equal(finished.error, '已取消');
      assert.match(finished.summary, new RegExp(TURN_ONE_TEXT));
    }

    // The trajectory was persisted while the run was still going (P1-3).
    const stored = repo.listRunMessages(run.id);
    assert.ok(stored.length >= 4, `期望 system/user/assistant/tool，实际 ${stored.length}`);
    assert.equal(repo.countRunMessages(run.id), stored.length);
    assert.equal(stored[0].role, 'system');
    stored.forEach((row, index) => assert.equal(row.index, index, 'idx 必须从 0 连续递增'));
    assert.ok(stored.some((row) => row.role === 'tool' && row.toolCallId === 'call_1'));
    assert.ok(stored.some((row) => row.role === 'assistant' && row.toolCalls?.includes('call_1')));
    assert.equal(repo.getRun(run.id)?.status, 'error');
  } finally {
    await fake.stop();
    closeAndRemove(repo, dir);
  }
});

test('P0-2: 流式过程中取消，AbortError 归一为 LLM_ABORTED 且 summary 保留已流式文本', { timeout: 20_000 }, async () => {
  const fake = await startFakeLlm((_requestNo, res) => {
    sseHeaders(res);
    res.write(sseChunk({ model: 'fake-model', choices: [{ delta: { content: TURN_ONE_TEXT }, finish_reason: null }] }));
    // Never finishes: the client is expected to abort.
  });
  const { deps, repo, dir } = tempRepo(fake.baseUrl);
  const controller = new AbortController();

  const started = Date.now();
  try {
    const run = await runAgent(deps, {
      kind: 'custom',
      title: '流式取消测试',
      goal: '请继续分析',
      signal: controller.signal,
      sink: (event) => {
        if (event.type === 'text') controller.abort();
      },
    });
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 10_000, `流式取消应立即结束（实际 ${elapsed}ms）`);
    assert.equal(run.status, 'error');
    assert.match(run.error ?? '', /已取消/);
    assert.match(run.summary, new RegExp(TURN_ONE_TEXT), '已流式累计的文本必须保留');
    assert.equal(run.turns, 1);
    assert.ok(repo.listRunMessages(run.id).length >= 2, 'system/user 已落库');
  } finally {
    await fake.stop();
    closeAndRemove(repo, dir);
  }
});

test('P1-3: resumeRunId 从已存轨迹续跑（新 run 行 + 标题标注），轨迹为空时报错', { timeout: 20_000 }, async () => {
  const fake = await startFakeLlm((_requestNo, res) => writeTurnOne(res));
  const { deps, repo, dir } = tempRepo(fake.baseUrl);
  try {
    // A stored transcript to continue from.
    const sourceRunId = 'abcdef01-2345-6789-abcd-ef0123456789';
    const now = new Date().toISOString();
    repo.createRun({ id: sourceRunId, kind: 'custom', status: 'running', target: null, title: 'AI 资产分析', startedAt: now });
    repo.addRunMessage({
      id: 'm0',
      runId: sourceRunId,
      index: 0,
      role: 'system',
      content: '原始 system 提示词',
      toolCalls: null,
      toolCallId: null,
      name: null,
      reasoningContent: null,
      createdAt: now,
    });
    repo.addRunMessage({
      id: 'm1',
      runId: sourceRunId,
      index: 1,
      role: 'user',
      content: '原始目标',
      toolCalls: null,
      toolCallId: null,
      name: null,
      reasoningContent: null,
      createdAt: now,
    });

    const controller = new AbortController();
    const run = await runAgent(deps, {
      kind: 'custom',
      title: 'AI 资产分析',
      goal: '请继续',
      resumeRunId: sourceRunId,
      signal: controller.signal,
      maxTurns: 1,
      sink: (event) => {
        if (event.type === 'tool-result') controller.abort();
      },
    });

    assert.notEqual(run.id, sourceRunId, '续跑必须新开一条 run 行');
    assert.match(repo.getRun(run.id)?.title ?? '', /（续跑 abcdef01）/);
    const stored = repo.listRunMessages(run.id);
    assert.equal(stored[0].content, '原始 system 提示词', '不叠加新的 system 提示词');
    assert.equal(stored[1].content, '原始目标');
    assert.equal(stored[2].content, '请继续', 'goal 追加为新的 user 消息');
    assert.equal(run.status, 'error');
    assert.match(run.error ?? '', /已取消/);

    // Default turn budget of a resumed run is AGENT_RESUME_EXTRA_TURNS.
    const defaultTurns = new AbortController();
    const progress: AgentEvent[] = [];
    const resumed = await runAgent(deps, {
      kind: 'custom',
      title: 'AI 资产分析',
      goal: '请继续',
      resumeRunId: sourceRunId,
      signal: defaultTurns.signal,
      sink: (event) => {
        progress.push(event);
        if (event.type === 'tool-result') defaultTurns.abort();
      },
    });
    const firstProgress = progress.find((event) => event.type === 'progress');
    assert.ok(firstProgress && firstProgress.type === 'progress');
    if (firstProgress && firstProgress.type === 'progress') {
      assert.equal(firstProgress.total, AGENT_RESUME_EXTRA_TURNS);
    }
    assert.equal(resumed.status, 'error');

    // Empty transcript => deterministic error run (never rejects).
    const empty = await runAgent(deps, { kind: 'custom', title: '空轨迹', goal: '', resumeRunId: 'no-such-run' });
    assert.equal(empty.status, 'error');
    assert.match(empty.error ?? '', /没有可续跑的轨迹/);
    assert.equal(repo.countRunMessages(empty.id), 0);
  } finally {
    await fake.stop();
    closeAndRemove(repo, dir);
  }
});
