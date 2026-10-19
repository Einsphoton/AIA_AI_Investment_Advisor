/**
 * 续跑预算 + 「轮次用尽后的收尾」回归测试（owner: agent-engine）。
 *
 * 生产事故：定时流水线的某个阶段失败后由 `services/scheduler.ts` 自动续跑，续跑却
 * 反复报「达到最大推理轮次（8）仍未给出最终结论，请重试或缩小分析范围。」——
 * 轨迹完整、模型也一直在正常调用工具，只是 **8 轮新预算** 不够跑完剩下的阶段，
 * 而循环在预算耗尽时既不会强制作答、也没有把失败原因说清楚。
 *
 * 本文件用一个进程内假 LLM 走真实的 `createLlmClient` → `fetch` → SSE 路径（与
 * `agent-cancel.test.ts` 同构），锁定三件事：
 *
 *  1. 续跑默认预算 = 全新运行的预算（`AGENT_MAX_TURNS`），不再是 8 轮；
 *  2. 轮次真的用尽时，循环追加**一次不带工具的收尾调用**，把「报错」变成「有结论」；
 *  3. 非流式回退路径返回空结论时，错误文案必须说明「空结论」，不得谎报轮次上限。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AGENT_MAX_TURNS, type AgentEvent } from '@aia/shared';

import { createRepo } from '../src/db/repo.js';
import { runAgent } from '../src/agent/loop.js';
import type { AgentDeps, LoggerLike } from '../src/types/agent.js';
import type { Repo } from '../src/types/repo.js';

const FINAL_TEXT = '【收尾结论】基于已获取的数据给出最终结论。';

const silentLogger: LoggerLike = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

interface FakeRequest {
  requestNo: number;
  body: Record<string, unknown>;
}

interface FakeLlm {
  baseUrl: string;
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

/** One streamed assistant message: text (optional) + one unknown tool call. */
function writeToolCallTurn(res: http.ServerResponse, text = ''): void {
  sseHeaders(res);
  if (text) {
    res.write(`data: ${JSON.stringify({ model: 'fake-model', choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`);
  }
  res.write(
    `data: ${JSON.stringify({
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
    })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({
      model: 'fake-model',
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 11, completion_tokens: 5 },
    })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

/** One streamed assistant message with text only (the run converges). */
function writeTextTurn(res: http.ServerResponse, text: string): void {
  sseHeaders(res);
  res.write(`data: ${JSON.stringify({ model: 'fake-model', choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`);
  res.write(
    `data: ${JSON.stringify({
      model: 'fake-model',
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 5 },
    })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

async function startFakeLlm(handle: (request: FakeRequest, res: http.ServerResponse) => void): Promise<FakeLlm> {
  let count = 0;
  const server = http.createServer((request, res) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      count += 1;
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        body = {};
      }
      handle({ requestNo: count, body }, res);
    });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-turn-cap-'));
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

/**
 * Seeds a failed pipeline run whose transcript stops in the middle of a tool loop
 * — exactly what `failStaleRuns` leaves behind after a process restart.
 */
function seedInterruptedRun(repo: Repo, id: string, kind: 'custom' | 'watchlist-analysis' = 'custom'): string {
  const now = new Date().toISOString();
  repo.createRun({ id, kind, status: 'error', target: null, title: 'AI 标的分析', startedAt: now });
  const rows: Array<[string, 'system' | 'user' | 'assistant' | 'tool', string, string | null, string | null]> = [
    ['system', 'system', '原始 system 提示词', null, null],
    ['user', 'user', '原始目标：分析全部持仓与候选标的。', null, null],
    [
      'assistant',
      'assistant',
      '',
      JSON.stringify([
        { id: 'call_prev', type: 'function', function: { name: 'no_such_tool_xyz', arguments: '{"a":1}' } },
      ]),
      null,
    ],
    ['tool', 'tool', '工具结果', null, 'call_prev'],
  ];
  rows.forEach(([id2, role, content, toolCalls, toolCallId], index) => {
    repo.addRunMessage({
      id: id2,
      runId: id,
      index,
      role,
      content,
      toolCalls,
      toolCallId,
      name: role === 'tool' ? 'no_such_tool_xyz' : null,
      reasoningContent: null,
      createdAt: now,
    });
  });
  return id;
}

test('续跑默认预算与全新运行一致（不再只有 8 轮）', { timeout: 30_000 }, async () => {
  const fake = await startFakeLlm((_request, res) => writeTextTurn(res, '续跑完成'));
  const { deps, repo, dir } = tempRepo(fake.baseUrl);
  try {
    const sourceRunId = seedInterruptedRun(repo, 'aaaaaaaa-1111-2222-3333-444444444444');
    const events: AgentEvent[] = [];
    const run = await runAgent(deps, {
      kind: 'custom',
      title: 'AI 标的分析',
      goal: '',
      resumeRunId: sourceRunId,
      sink: (event) => events.push(event),
    });

    const firstProgress = events.find((event) => event.type === 'progress');
    assert.ok(firstProgress && firstProgress.type === 'progress');
    if (firstProgress && firstProgress.type === 'progress') {
      assert.equal(
        firstProgress.total,
        AGENT_MAX_TURNS,
        '续跑必须拿到与全新运行相同的轮次预算（8 轮跑不完剩下的流水线阶段）',
      );
    }
    assert.equal(run.status, 'done');
    assert.match(run.summary, /续跑完成/);
  } finally {
    await fake.stop();
    closeAndRemove(repo, dir);
  }
});

test('轮次用尽后追加一次不带工具的收尾调用：run 以结论结束而不是报错', { timeout: 60_000 }, async () => {
  // 有工具（正常推理）→ 一直要求调用工具；没有工具（收尾调用）→ 给出结论。
  const fake = await startFakeLlm(({ body }, res) => {
    const tools = body.tools;
    if (Array.isArray(tools) && tools.length > 0) writeToolCallTurn(res);
    else writeTextTurn(res, FINAL_TEXT);
  });
  const { deps, repo, dir } = tempRepo(fake.baseUrl);
  try {
    const sourceRunId = seedInterruptedRun(repo, 'bbbbbbbb-1111-2222-3333-444444444444');
    const run = await runAgent(deps, {
      kind: 'custom',
      title: 'AI 标的分析',
      goal: '',
      resumeRunId: sourceRunId,
      maxTurns: 2,
    });

    assert.equal(run.status, 'done', `收尾调用应把失败变成有结论的运行（error=${run.error ?? ''}）`);
    assert.equal(run.error, null);
    assert.match(run.summary, new RegExp(FINAL_TEXT));
    assert.match(run.summary, /已用尽推理预算（2\/2 轮）/, '收尾结论必须标注它是在预算用尽后得出的');

    const steps = repo.listSteps(run.id);
    assert.ok(
      steps.some((step) => /收尾|强制作答/.test(step.label)),
      `活动页要能看到这次收尾调用，实际步骤：${steps.map((step) => step.label).join('、')}`,
    );
    // 收尾调用确实发生过：2 轮工具循环 + 1 次收尾。
    assert.equal(fake.requests(), 3);
  } finally {
    await fake.stop();
    closeAndRemove(repo, dir);
  }
});

test('非流式回退拿到空结论时报「空响应」，不得谎报达到轮次上限', { timeout: 30_000 }, async () => {
  const fake = await startFakeLlm(({ body }, res) => {
    if (body.stream === true) {
      // 网关不支持流式：客户端会退回非流式（plainChat）。
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'streaming not supported' } }));
      return;
    }
    // 非流式成功但正文为空、且没有工具调用 —— 旧代码会把它当成「达到轮次上限」。
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'fake-model',
        choices: [{ message: { content: null, tool_calls: [] }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 0 },
      }),
    );
  });
  const { deps, repo, dir } = tempRepo(fake.baseUrl);
  try {
    const run = await runAgent(deps, { kind: 'custom', title: '空结论测试', goal: '请分析', maxTurns: 2 });
    assert.equal(run.status, 'error');
    assert.doesNotMatch(run.error ?? '', /达到最大推理轮次/, '空结论不是轮次上限，不能谎报');
    assert.match(run.error ?? '', /空响应|空结论/);
  } finally {
    await fake.stop();
    closeAndRemove(repo, dir);
  }
});
