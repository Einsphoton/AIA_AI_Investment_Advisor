/**
 * P1-1: audit / pending-write approval routes + P1-3 trace & resume routes.
 *
 * Real Fastify + `app.inject()` against a temporary SQLite database. The agent
 * is a stub (no LLM, no network): the approve path is exercised through the real
 * `executeTool` dispatcher with repo-only write tools (`save_asset_analysis`),
 * so "approved" can be verified by reading the written record back.
 *
 * The app is assembled here from `registerApprovalRoutes` / `registerRunRoutes` /
 * `registerSettingsRoutes` instead of `buildApp()` because the Lead-owned
 * `routes/index.ts` does not import these modules yet (see the report).
 *
 * Owner: P1 workstream.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';

import type { AgentRun, PendingWriteStatus, ToolRisk } from '@aia/shared';

import { createRepo } from '../src/db/repo.js';
import { AppError } from '../src/errors.js';
import { setServices } from '../src/registry.js';
import { registerApprovalRoutes } from '../src/routes/approval.js';
import { registerRunRoutes } from '../src/routes/runs.js';
import { registerSettingsRoutes } from '../src/routes/settings.js';
import { isPipelineRunning, runExclusive } from '../src/services/pipeline-lock.js';
import { installToolInterceptor } from '../src/agent/policy.js';
import type { AgentRuntime } from '../src/types/agent.js';
import type { Repo } from '../src/types/repo.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-approval-'));
process.env.AIA_OFFLINE = '1';

const repo: Repo = createRepo(path.join(dataDir, 'advisor.db'));
repo.migrate();

/** Silent logger for the interceptor installed below (mirrors `index.ts`). */
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** Run ids handed to `agent.resume`, to prove the route actually delegates. */
const resumed: string[] = [];

const stubAgent: AgentRuntime = {
  isConfigured: () => true,
  tools: () => [],
  run: async () => {
    throw new Error('run is not exercised by this test');
  },
  resume: async (runId, request): Promise<AgentRun> => {
    resumed.push(runId);
    request?.sink?.({ type: 'text', runId, delta: '续跑中' });
    const row = repo.updateRun(runId, { status: 'done', summary: '已续跑', finishedAt: new Date().toISOString() });
    if (!row) throw new Error(`运行记录 ${runId} 不存在`);
    // The real loop emits `run-finished` through the sink; the route only
    // guarantees the trailing `done`.
    request?.sink?.({ type: 'run-finished', runId, status: 'done', summary: '已续跑', error: null });
    return { ...row, steps: repo.listSteps(runId) };
  },
};

let appPromise: Promise<FastifyInstance> | undefined;

/**
 * Builds the test app once and (re)points the service locator at this file's
 * repo on every call — several suites share one process, and only the routes'
 * own `getRepo()` matters here.
 */
async function testApp(): Promise<FastifyInstance> {
  setServices({ repo, agent: stubAgent });
  appPromise ??= build();
  return appPromise;
}

async function build(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Same serialisation as `app.ts`.
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    const status = error.statusCode ?? 500;
    reply.code(status).send({
      error: { code: status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST', message: error.message || 'Unexpected error' },
    });
  });
  await registerSettingsRoutes(app);
  await registerApprovalRoutes(app);
  await registerRunRoutes(app);
  await app.ready();
  return app;
}

after(async () => {
  await appPromise?.then((app) => app.close()).catch(() => undefined);
  repo.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/* ────────────────────────────────── helpers ───────────────────────────────── */

const json = (res: { body: string }): any => JSON.parse(res.body);

function seedAsset(id: string, name: string, code: string): void {
  repo.createAsset({
    id,
    name,
    code,
    market: 'CN',
    type: 'stock',
    source: 'manual',
    currency: 'CNY',
    note: '',
    price: 0,
    priceAt: null,
    prevClose: 0,
    dayChangePct: 0,
    spark: [],
    createdAt: new Date().toISOString(),
  });
}

function seedPending(input: {
  tool: string;
  args: Record<string, unknown>;
  runId: string | null;
  status?: PendingWriteStatus;
  risk?: ToolRisk;
  createdAt?: string;
  sessionId?: string | null;
}): string {
  const id = randomUUID();
  repo.addPendingWrite({
    id,
    runId: input.runId,
    sessionId: input.sessionId ?? null,
    tool: input.tool,
    args: JSON.stringify(input.args),
    summary: `待审批：${input.tool}`,
    risk: input.risk ?? 'write',
    status: input.status ?? 'pending',
    createdAt: input.createdAt ?? new Date().toISOString(),
    decidedAt: null,
    result: null,
  });
  return id;
}

/* ─────────────────────────────── settings (P1-1) ──────────────────────────── */

test('settings：toolPolicy 局部更新、mcpServers 整体替换、env 值不回流', async () => {
  const app = await testApp();

  const policy = await app.inject({ method: 'PUT', url: '/api/settings', payload: { toolPolicy: { requireWriteApproval: true } } });
  assert.equal(policy.statusCode, 200);
  assert.deepEqual(json(policy).toolPolicy, { deny: [], requireWriteApproval: true });

  const servers = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: {
      mcpServers: [
        { id: 'm1', name: '行情 MCP', transport: 'http', url: 'https://mcp.example.com', env: { TOKEN: 'super-secret' } },
        { id: 'm2', name: '本地 MCP', transport: 'stdio' },
      ],
    },
  });
  assert.equal(servers.statusCode, 200);
  const dto = json(servers).mcpServers;
  assert.equal(dto.length, 2);
  assert.deepEqual(Object.keys(dto[0].env), ['TOKEN'], 'env 的形状必须保留');
  assert.equal(dto[0].env.TOKEN, '', 'env 的值必须置空');
  assert.ok(!servers.body.includes('super-secret'), '响应中不得出现 MCP 机密');
  assert.deepEqual(dto[1], {
    id: 'm2',
    name: '本地 MCP',
    transport: 'stdio',
    command: '',
    args: [],
    env: {},
    url: '',
    enabled: true,
  });
  assert.equal(repo.getSettings().mcpServers[0]!.env.TOKEN, 'super-secret', '明文只存 SQLite');

  // 整体替换：空数组即清空。
  const cleared = await app.inject({ method: 'PUT', url: '/api/settings', payload: { mcpServers: [] } });
  assert.deepEqual(json(cleared).mcpServers, []);
  assert.equal(repo.getSettings().mcpServers.length, 0);

  // 局部 patch 不得抹掉 deny（除非显式给出）。
  const deny = await app.inject({ method: 'PUT', url: '/api/settings', payload: { toolPolicy: { deny: ['fetch_url'] } } });
  assert.deepEqual(json(deny).toolPolicy, { deny: ['fetch_url'], requireWriteApproval: true });
  const read = await app.inject({ method: 'GET', url: '/api/settings' });
  assert.deepEqual(json(read).toolPolicy, { deny: ['fetch_url'], requireWriteApproval: true });

  // 上限：deny ≤ 200 条、mcpServers ≤ 20 个（校验而非截断）。
  const tooManyDeny = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { toolPolicy: { deny: Array.from({ length: 201 }, (_, index) => `tool-${index}`) } },
  });
  assert.equal(tooManyDeny.statusCode, 400);
  const tooManyServers = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: {
      mcpServers: Array.from({ length: 21 }, (_, index) => ({ id: `m${index}`, name: `MCP ${index}`, transport: 'stdio' })),
    },
  });
  assert.equal(tooManyServers.statusCode, 400);
});

/* ───────────────────────────── audit / pending GET ────────────────────────── */

test('GET /api/agent/pending：裸数组、倒序、可按 status 过滤', async () => {
  const app = await testApp();
  const older = seedPending({
    tool: 'save_dashboard_briefing',
    args: { text: 'a' },
    runId: 'run-pending',
    createdAt: '2026-01-01T00:00:00.000+08:00',
  });
  const newer = seedPending({
    tool: 'save_dashboard_briefing',
    args: { text: 'b' },
    runId: 'run-pending',
    createdAt: '2026-02-01T00:00:00.000+08:00',
  });

  const res = await app.inject({ method: 'GET', url: '/api/agent/pending' });
  assert.equal(res.statusCode, 200);
  const list = json(res);
  assert.ok(Array.isArray(list), '必须是裸数组');
  assert.deepEqual(
    list.filter((row: { runId: string }) => row.runId === 'run-pending').map((row: { id: string }) => row.id),
    [newer, older],
    '按 createdAt 倒序',
  );

  const pendingOnly = json(await app.inject({ method: 'GET', url: '/api/agent/pending?status=pending' }));
  assert.ok(pendingOnly.every((row: { status: string }) => row.status === 'pending'));

  const bad = await app.inject({ method: 'GET', url: '/api/agent/pending?status=nope' });
  assert.equal(bad.statusCode, 400);

  // 文档里的空值查询串（?status=）等价于不过滤。
  const templated = await app.inject({ method: 'GET', url: '/api/agent/pending?status=' });
  assert.equal(templated.statusCode, 200);
  assert.equal(json(templated).length, list.length);
});

/* ─────────────────────────────── approve / reject ─────────────────────────── */

test('approve：真正执行写入，pending 变 approved，audit 记 executed', async () => {
  const app = await testApp();
  // D2: mirror the real assembly (`index.ts` installs the interceptor before
  // routing) *inside* the test, because the interceptor is a process-wide
  // singleton shared with other suites in this single-process runner. Without a
  // live interceptor the approve path used to record its own audit row, hiding
  // that production wrote two identical `executed` rows per approval.
  installToolInterceptor({ getRepo: () => repo, logger: silentLogger });
  seedAsset('asset-approve', '贵州茅台', '600519');
  const pendingId = seedPending({
    tool: 'save_asset_analysis',
    args: { assetId: 'asset-approve', summary: '审批后写回的分析结论' },
    runId: 'run-approve',
  });

  const res = await app.inject({ method: 'POST', url: `/api/agent/pending/${pendingId}/approve` });
  assert.equal(res.statusCode, 200);
  const body = json(res);
  assert.equal(body.pending.id, pendingId);
  assert.equal(body.pending.status, 'approved');
  assert.ok(body.pending.decidedAt, 'decidedAt 必须写入');
  assert.equal(typeof body.result, 'string');
  assert.equal(body.pending.result, body.result);
  assert.match(body.result, /写回/);

  const asset = repo.getAsset('asset-approve');
  assert.equal(asset!.aiSummary, '审批后写回的分析结论', '目标数据必须真的被写入');
  assert.ok(asset!.aiSummaryAt);
  assert.equal(repo.getPendingWrite(pendingId)!.status, 'approved');

  const audit = repo.listAudit({ runId: 'run-approve', limit: 20 });
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.outcome, 'executed');
  assert.equal(audit[0]!.tool, 'save_asset_analysis');
  assert.equal(audit[0]!.risk, 'write');
  assert.equal(audit[0]!.entity, 'asset');
  assert.equal(audit[0]!.entityId, 'asset-approve');
  assert.ok(audit[0]!.summary.length > 0);
});

test('reject：状态 rejected、数据未变、audit 记 denied', async () => {
  const app = await testApp();
  seedAsset('asset-reject', '拒绝样本', '000001');
  const pendingId = seedPending({
    tool: 'save_asset_analysis',
    args: { assetId: 'asset-reject', summary: '不应写回' },
    runId: 'run-reject',
  });

  const res = await app.inject({ method: 'POST', url: `/api/agent/pending/${pendingId}/reject`, payload: { reason: '逻辑不成立' } });
  assert.equal(res.statusCode, 200);
  const body = json(res);
  assert.equal(body.pending.status, 'rejected');
  assert.equal(body.pending.result, '逻辑不成立');
  assert.ok(body.pending.decidedAt);

  assert.equal(repo.getAsset('asset-reject')!.aiSummary, '', '驳回后数据必须保持不变');
  const audit = repo.listAudit({ runId: 'run-reject', limit: 20 });
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.outcome, 'denied');
  assert.match(audit[0]!.summary, /驳回/);
  assert.match(audit[0]!.summary, /逻辑不成立/);

  const noReasonId = seedPending({
    tool: 'save_dashboard_briefing',
    args: { text: 'x' },
    runId: 'run-reject-empty',
  });
  const noReason = await app.inject({ method: 'POST', url: `/api/agent/pending/${noReasonId}/reject` });
  assert.equal(noReason.statusCode, 200);
  assert.equal(json(noReason).pending.result, '用户驳回');
});

test('重复审批 → 409；未知 id → 404；参数非法 → 400', async () => {
  const app = await testApp();
  seedAsset('asset-dup', '重复审批', '000003');
  const pendingId = seedPending({
    tool: 'save_asset_analysis',
    args: { assetId: 'asset-dup', summary: '只允许一次' },
    runId: 'run-dup',
  });

  assert.equal((await app.inject({ method: 'POST', url: `/api/agent/pending/${pendingId}/approve` })).statusCode, 200);
  const again = await app.inject({ method: 'POST', url: `/api/agent/pending/${pendingId}/approve` });
  assert.equal(again.statusCode, 409);
  assert.equal(json(again).error.code, 'CONFLICT');
  assert.equal(json(again).error.message.includes('已处理'), true);

  const rejectAfter = await app.inject({ method: 'POST', url: `/api/agent/pending/${pendingId}/reject`, payload: {} });
  assert.equal(rejectAfter.statusCode, 409);

  for (const url of ['/api/agent/pending/nope/approve', '/api/agent/pending/nope/reject']) {
    const res = await app.inject({ method: 'POST', url, payload: {} });
    assert.equal(res.statusCode, 404);
    assert.equal(json(res).error.code, 'NOT_FOUND');
  }

  const badReason = await app.inject({
    method: 'POST',
    url: `/api/agent/pending/${seedPending({ tool: 'save_asset_analysis', args: {}, runId: 'run-dup-2' })}/reject`,
    payload: { reason: 42 },
  });
  assert.equal(badReason.statusCode, 400);
});

/* ────────────────────────────────── audit GET ─────────────────────────────── */

test('GET /api/agent/audit：裸数组、limit 夹取、可按 runId/outcome/risk 过滤', async () => {
  const app = await testApp();
  const res = await app.inject({ method: 'GET', url: '/api/agent/audit' });
  assert.equal(res.statusCode, 200);
  const all = json(res);
  assert.ok(Array.isArray(all), '必须是裸数组');
  assert.ok(all.length >= 2);
  assert.ok(all.every((row: { id: string; at: string; tool: string }) => typeof row.id === 'string' && typeof row.at === 'string'));

  const one = json(await app.inject({ method: 'GET', url: '/api/agent/audit?limit=0' }));
  assert.equal(one.length, 1, 'limit 下限夹到 1');
  const capped = json(await app.inject({ method: 'GET', url: '/api/agent/audit?limit=10000' }));
  assert.ok(capped.length <= 500, 'limit 上限为 500');

  const byRun = json(await app.inject({ method: 'GET', url: '/api/agent/audit?runId=run-reject' }));
  assert.equal(byRun.length, 1);
  assert.equal(byRun[0].outcome, 'denied');
  assert.equal(json(await app.inject({ method: 'GET', url: '/api/agent/audit?outcome=executed&runId=run-approve' })).length, 1);
  assert.equal(json(await app.inject({ method: 'GET', url: '/api/agent/audit?risk=write&runId=run-approve' })).length, 1);
  assert.equal(json(await app.inject({ method: 'GET', url: '/api/agent/audit?risk=read&runId=run-approve' })).length, 0);

  const bad = await app.inject({ method: 'GET', url: '/api/agent/audit?risk=nope' });
  assert.equal(bad.statusCode, 400);
  assert.equal(json(bad).error.code, 'BAD_REQUEST');

  // 文档里的空值查询串必须照常工作（limit 取默认 100，而不是 1）。
  const templated = await app.inject({ method: 'GET', url: '/api/agent/audit?limit=&risk=&outcome=&runId=' });
  assert.equal(templated.statusCode, 200);
  assert.ok(Array.isArray(json(templated)));
});

/* ─────────────────────────────── trace (P1-3) ─────────────────────────────── */

test('GET /api/agent/runs/:id/trace：run+steps+messages+audit+pendingWrites', async () => {
  const app = await testApp();
  const runId = 'run-trace';
  const at = new Date().toISOString();
  repo.createRun({ id: runId, kind: 'custom', status: 'error', target: 'asset:asset-trace', title: '轨迹样本', startedAt: at });
  repo.addStep({ id: randomUUID(), runId, index: 0, label: '检索行情', status: 'done', detail: '完成' });
  repo.addRunMessage({
    id: randomUUID(),
    runId,
    index: 0,
    role: 'user',
    content: '分析茅台',
    toolCalls: null,
    toolCallId: null,
    name: null,
    createdAt: at,
  });
  repo.addRunMessage({
    id: randomUUID(),
    runId,
    index: 1,
    role: 'assistant',
    content: '正在分析',
    toolCalls: '[]',
    toolCallId: null,
    name: null,
    createdAt: at,
  });
  repo.addAudit({
    id: randomUUID(),
    at,
    runId,
    sessionId: null,
    tool: 'list_assets',
    risk: 'read',
    outcome: 'executed',
    entity: null,
    entityId: null,
    summary: '持仓 1 项',
    args: '{}',
  });
  const mine = seedPending({ tool: 'save_dashboard_briefing', args: { text: 'trace' }, runId });
  seedPending({ tool: 'save_dashboard_briefing', args: { text: 'other' }, runId: 'run-trace-other' });

  const res = await app.inject({ method: 'GET', url: `/api/agent/runs/${runId}/trace` });
  assert.equal(res.statusCode, 200);
  const trace = json(res);
  assert.equal(trace.run.id, runId);
  assert.equal(trace.run.title, '轨迹样本');
  assert.equal(trace.run.steps.length, 1);
  assert.equal(trace.steps.length, 1);
  assert.equal(trace.steps[0].label, '检索行情');
  assert.equal(trace.messages.length, 2);
  assert.equal(trace.messages[0].content, '分析茅台');
  assert.equal(trace.messages[1].role, 'assistant');
  assert.equal(trace.audit.length, 1);
  assert.equal(trace.audit[0].tool, 'list_assets');
  assert.deepEqual(
    trace.pendingWrites.map((row: { id: string }) => row.id),
    [mine],
    '只返回该 run 的待审批项',
  );

  assert.equal((await app.inject({ method: 'GET', url: '/api/agent/runs/nope/trace' })).statusCode, 404);
});

/* ────────────────────────────── resume (P1-3) ─────────────────────────────── */

test('POST /api/agent/runs/:id/resume：SSE 续跑，最后发 done 并关闭', async () => {
  const app = await testApp();
  const runId = 'run-resume';
  repo.createRun({
    id: runId,
    kind: 'custom',
    status: 'error',
    target: null,
    title: '续跑样本',
    startedAt: new Date().toISOString(),
    error: '达到轮次上限',
  });
  const before = resumed.length;

  const res = await app.inject({ method: 'POST', url: `/api/agent/runs/${runId}/resume` });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /text\/event-stream/);
  assert.equal(resumed.length, before + 1);
  assert.equal(resumed[resumed.length - 1], runId);
  assert.match(res.body, /event: text/);
  assert.match(res.body, /event: run-finished/);
  assert.match(res.body, /event: done/);
  assert.ok(res.body.indexOf('event: done') > res.body.indexOf('event: run-finished'), 'done 必须最后发送');
  assert.ok(res.body.trimEnd().endsWith('data: {"type":"done"}'), 'done 必须是最后一个事件');
  assert.equal(repo.getRun(runId)!.status, 'done');
  assert.equal(isPipelineRunning(), false, '续跑结束后流水线锁必须释放');
});

test('resume 前置校验：done → 409、未知 → 404，两者都不开流', async () => {
  const app = await testApp();
  const runId = 'run-resume-done';
  repo.createRun({ id: runId, kind: 'custom', status: 'done', target: null, title: '已完成', startedAt: new Date().toISOString() });

  const done = await app.inject({ method: 'POST', url: `/api/agent/runs/${runId}/resume` });
  assert.equal(done.statusCode, 409);
  assert.equal(json(done).error.code, 'CONFLICT');
  assert.ok(!done.body.includes('event:'), '409 必须是普通 JSON');

  const missing = await app.inject({ method: 'POST', url: '/api/agent/runs/nope/resume' });
  assert.equal(missing.statusCode, 404);
  assert.equal(json(missing).error.code, 'NOT_FOUND');
  assert.ok(!missing.body.includes('event:'));
});

test('resume 遇流水线锁被占：立刻 error + run-finished(error) + done，不调用 agent.resume', async () => {
  const app = await testApp();
  const runId = 'run-resume-busy';
  repo.createRun({ id: runId, kind: 'custom', status: 'error', target: null, title: '锁占用', startedAt: new Date().toISOString() });
  const before = resumed.length;

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holding = runExclusive('manual:run-now', async () => {
    await held;
  });
  await new Promise((resolve) => setImmediate(resolve));

  try {
    const res = await app.inject({ method: 'POST', url: `/api/agent/runs/${runId}/resume` });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /event: error/);
    assert.match(res.body, /已有 AI 流水线正在运行/);
    assert.match(res.body, /event: run-finished/);
    assert.match(res.body, /"status":"error"/);
    assert.match(res.body, /event: done/);
    assert.equal(resumed.length, before, '锁被占用时不得发起续跑');
  } finally {
    release();
    await holding;
  }
  assert.equal(isPipelineRunning(), false);
});
