/**
 * 思考模型（DeepSeek `reasoning_content`）工具循环回归测试。
 *
 * 生产事故复现：Agent 的多轮工具循环在第 2 轮被厂商以 HTTP 400 拒绝 ——
 * 「The `reasoning_content` in the thinking mode must be passed back to the API.」
 * 根因是 `ChatResult` 丢掉了思考轨迹、assistant 消息回填时不带该字段。
 *
 * 这里用**进程内假 LLM**（真 SSE 协议、经真实 `fetch`）把契约钉死：
 *  1. 回传了思考轨迹 → 第 2 轮必须 200，run 必须 done；
 *  2. 厂商反过来拒绝该字段时 → 自动关闭回传并重试，run 仍然 done。
 *
 * Owner: agent-engine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRepo } from '../src/db/repo.js';
import { runAgent } from '../src/agent/loop.js';
import { hasReasoningContent, reasoningEchoFix, stripReasoningContent, type LlmMessage } from '../src/agent/llm.js';
import type { AgentDeps, LoggerLike } from '../src/types/agent.js';
import type { Repo } from '../src/types/repo.js';

const REASONING = '先核对行情与财报，再给出结论。';
const FINAL_TEXT = '已核对：预算充足，结论有据。';
/** 厂商原话（生产库里真实记录到的那一条）。 */
const PROVIDER_REQUIRES =
  'Upstream request failed: [invalid_request_error] The `reasoning_content` in the thinking mode must be passed back to the API.';
const PROVIDER_REJECTS = 'Invalid parameter: unexpected field `reasoning_content` in messages[2].';

const silentLogger: LoggerLike = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

interface FakeLlm {
  baseUrl: string;
  requests: () => number;
  /** Parsed request bodies, in arrival order (for contract assertions). */
  bodies: () => Record<string, unknown>[];
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

function jsonError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}

/** Turn with a thinking trace plus one tool call (the shape a reasoning model emits). */
function writeReasoningToolTurn(res: http.ServerResponse): void {
  sseHeaders(res);
  res.write(sseChunk({ model: 'fake-model', choices: [{ delta: { reasoning_content: REASONING }, finish_reason: null }] }));
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

/** An empty completion: no content and no tool calls (the gateway hiccup). */
function writeEmptyTurn(res: http.ServerResponse): void {
  sseHeaders(res);
  res.write(sseChunk({ model: 'fake-model', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 0 } }));
  res.write('data: [DONE]\n\n');
  res.end();
}

function writeFinalTurn(res: http.ServerResponse): void {
  sseHeaders(res);
  res.write(sseChunk({ model: 'fake-model', choices: [{ delta: { content: FINAL_TEXT }, finish_reason: null }] }));
  res.write(
    sseChunk({
      model: 'fake-model',
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 21, completion_tokens: 9 },
    }),
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

async function startFakeLlm(
  handle: (requestNo: number, body: Record<string, unknown>, res: http.ServerResponse) => void,
): Promise<FakeLlm> {
  let count = 0;
  const bodies: Record<string, unknown>[] = [];
  const server = http.createServer((request, res) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      count += 1;
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      } catch {
        body = {};
      }
      bodies.push(body);
      handle(count, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake LLM failed to bind a port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests: () => count,
    bodies: () => bodies,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function tempRepo(baseUrl: string): { repo: Repo; deps: AgentDeps; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-reasoning-'));
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

/** Extracts the assistant tool-call message of a captured request body. */
function assistantWithTools(body: Record<string, unknown>): LlmMessage | undefined {
  const messages = (body.messages ?? []) as LlmMessage[];
  return messages.find((message) => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0);
}

/* ───────────────────────────── pure classification ───────────────────────── */

test('reasoning_content：缺失时才可修复，已回传时不重复翻转', () => {
  const withTrace: LlmMessage[] = [{ role: 'assistant', content: null, reasoning_content: REASONING }];
  const without: LlmMessage[] = [{ role: 'assistant', content: null }];

  // Provider demands the trace; we are not sending one → turn echo back on.
  assert.equal(reasoningEchoFix(new Error(PROVIDER_REQUIRES), false, withTrace), true);
  // Provider demands it and we already send it → flipping cannot help.
  assert.equal(reasoningEchoFix(new Error(PROVIDER_REQUIRES), true, withTrace), null);
  // Nothing to send → not fixable by flipping.
  assert.equal(reasoningEchoFix(new Error(PROVIDER_REQUIRES), false, without), null);

  // Provider rejects the field we send → stop echoing.
  assert.equal(reasoningEchoFix(new Error(PROVIDER_REJECTS), true, withTrace), false);
  // Already not sending → nothing to flip.
  assert.equal(reasoningEchoFix(new Error(PROVIDER_REJECTS), false, withTrace), null);

  // Unrelated failures must never touch the flag.
  assert.equal(reasoningEchoFix(new Error('LLM 请求失败（HTTP 500）：boom'), true, withTrace), null);
  assert.equal(reasoningEchoFix(undefined, true, withTrace), null);
});

test('stripReasoningContent：剥离只为拒绝该字段的厂商准备，无轨迹时保持原引用', () => {
  const messages: LlmMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }], reasoning_content: REASONING },
    { role: 'tool', content: '{}', tool_call_id: 'c1' },
  ];
  assert.equal(hasReasoningContent(messages), true);
  const stripped = stripReasoningContent(messages);
  assert.notEqual(stripped, messages);
  assert.equal('reasoning_content' in stripped[1], false);
  assert.equal(stripped[0].content, 'sys');
  assert.equal(stripped[2].tool_call_id, 'c1');

  const clean: LlmMessage[] = [{ role: 'user', content: 'hi' }];
  assert.equal(hasReasoningContent(clean), false);
  assert.equal(stripReasoningContent(clean), clean, '无轨迹时应返回同一引用（调用方用 identity 判断无需变更）');
});

/* ─────────────────────────── end-to-end regression ────────────────────────── */

test('回归：思考模型的思考轨迹必须回传到第 2 轮，否则整轮工具循环 400 失败', { timeout: 20_000 }, async () => {
  const fake = await startFakeLlm((requestNo, body, res) => {
    if (requestNo === 1) {
      writeReasoningToolTurn(res);
      return;
    }
    // 第 2 轮起严格执行厂商契约：没有回传思考轨迹就直接 400。
    const assistant = assistantWithTools(body);
    if (!assistant || assistant.reasoning_content !== REASONING) {
      jsonError(res, 400, PROVIDER_REQUIRES);
      return;
    }
    writeFinalTurn(res);
  });
  const { repo, deps, dir } = tempRepo(fake.baseUrl);

  try {
    const run = await runAgent(deps, { kind: 'custom', title: '思考轨迹回归', goal: '请分析一下' });

    assert.equal(run.status, 'done', `run 必须成功，实际 error=${run.error ?? ''}`);
    assert.equal(run.turns, 2, `期望 2 轮（工具轮 + 收敛轮），实际 ${run.turns}`);
    assert.equal(fake.requests(), 2, '不得额外重试');
    assert.match(run.summary, new RegExp(FINAL_TEXT));

    // 契约本身：第 2 轮请求里的 assistant 工具消息带着思考轨迹。
    const echoed = assistantWithTools(fake.bodies()[1]!);
    assert.equal(echoed?.reasoning_content, REASONING);

    // 轨迹也要落库，否则续跑一个思考模型 run 会在第一轮就 400。
    const persisted = repo
      .listRunMessages(run.id)
      .find((row) => row.role === 'assistant' && (row.toolCalls?.length ?? 0) > 0);
    assert.ok(persisted, '必须持久化 assistant 工具消息');
    assert.equal(persisted?.reasoningContent, REASONING);
  } finally {
    await fake.stop();
    closeAndRemove(repo, dir);
  }
});

test('兜底：厂商反过来拒绝 reasoning_content 时自动关闭回传并重试', { timeout: 20_000 }, async () => {
  const fake = await startFakeLlm((requestNo, body, res) => {
    if (requestNo === 1) {
      writeReasoningToolTurn(res);
      return;
    }
    // 该厂商不接受未知字段：带 reasoning_content 就 400，去掉之后才放行。
    if (assistantWithTools(body)?.reasoning_content) {
      jsonError(res, 400, PROVIDER_REJECTS);
      return;
    }
    writeFinalTurn(res);
  });
  const { repo, deps, dir } = tempRepo(fake.baseUrl);

  try {
    const run = await runAgent(deps, { kind: 'custom', title: '未知字段兜底', goal: '请分析一下' });

    assert.equal(run.status, 'done', `run 必须成功，实际 error=${run.error ?? ''}`);
    assert.equal(fake.requests(), 3, '第 1 轮 + 被拒的第 2 轮 + 去掉字段后的重试');
    assert.equal(assistantWithTools(fake.bodies()[1]!)?.reasoning_content, REASONING, '首次仍应回传');
    assert.equal('reasoning_content' in (assistantWithTools(fake.bodies()[2]!) ?? {}), false, '重试必须剥离该字段');
    assert.match(run.summary, new RegExp(FINAL_TEXT));
  } finally {
    await fake.stop();
    closeAndRemove(repo, dir);
  }
});

test('轨迹落库：reasoning_content 往返与截断上限', () => {  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-reasoning-repo-'));
  const repo = createRepo(path.join(dir, 'advisor.db'));
  repo.migrate();
  try {
    const runId = 'run-reasoning';
    const now = new Date().toISOString();
    repo.createRun({ id: runId, kind: 'custom', status: 'running', target: null, title: '轨迹', startedAt: now });
    repo.addRunMessage({
      id: 'm0',
      runId,
      index: 0,
      role: 'assistant',
      content: '正在检索',
      toolCalls: '[{"id":"c1","type":"function","function":{"name":"get_quote","arguments":"{}"}}]',
      toolCallId: null,
      name: null,
      reasoningContent: REASONING,
      createdAt: now,
    });
    repo.addRunMessage({
      id: 'm1',
      runId,
      index: 1,
      role: 'user',
      content: '继续',
      toolCalls: null,
      toolCallId: null,
      name: null,
      reasoningContent: null,
      createdAt: now,
    });

    const stored = repo.listRunMessages(runId);
    assert.equal(stored.length, 2);
    assert.equal(stored[0].reasoningContent, REASONING);
    assert.equal(stored[1].reasoningContent, null);

    // 思考轨迹与正文同样有单条上限，避免一个跑飞的模型把库撑爆。
    repo.addRunMessage({
      id: 'm2',
      runId,
      index: 2,
      role: 'assistant',
      content: 'x',
      toolCalls: null,
      toolCallId: null,
      name: null,
      reasoningContent: 'y'.repeat(30_000),
      createdAt: now,
    });
    const capped = repo.listRunMessages(runId)[2]!.reasoningContent ?? '';
    assert.ok(capped.length < 30_000, '超长思考轨迹必须被截断');
    assert.match(capped, /思考轨迹已截断/);
  } finally {
    closeAndRemove(repo, dir);
  }
});

/* ───────────────────── 空响应重试（生产实测丢过整批） ───────────────────── */

test('兜底：网关返回空响应时按上限重试，而不是让整批流水线失败', { timeout: 20_000 }, async () => {
  const fake = await startFakeLlm((requestNo, _body, res) => {
    // 前两次空白（生产实测：129k tokens 的建议阶段就是这样死的），第三次正常回答。
    if (requestNo <= 2) {
      writeEmptyTurn(res);
      return;
    }
    writeFinalTurn(res);
  });
  const { repo, deps, dir } = tempRepo(fake.baseUrl);

  try {
    const run = await runAgent(deps, { kind: 'custom', title: '空响应重试', goal: '你好' });
    assert.equal(run.status, 'done', `空响应应被重试后恢复，实际 error=${run.error ?? ''}`);
    assert.equal(fake.requests(), 3, '1 次原始 + 2 次重试');
    assert.equal(run.turns, 1, '重试属于同一次「逻辑轮次」，不该多算 turn');
    assert.match(run.summary, new RegExp(FINAL_TEXT));
  } finally {
    await fake.stop();
    closeAndRemove(repo, dir);
  }
});

test('兜底：连续空响应超过上限后如实失败，不会无限重试', { timeout: 20_000 }, async () => {
  const fake = await startFakeLlm((_requestNo, _body, res) => writeEmptyTurn(res));
  const { repo, deps, dir } = tempRepo(fake.baseUrl);

  try {
    const run = await runAgent(deps, { kind: 'custom', title: '空响应放弃', goal: '你好' });
    assert.equal(run.status, 'error');
    assert.match(run.error ?? '', /空响应/);
    assert.equal(fake.requests(), 3, '必须封顶在 1 + LLM_MAX_EMPTY_RETRIES 次');
  } finally {
    await fake.stop();
    closeAndRemove(repo, dir);
  }
});
