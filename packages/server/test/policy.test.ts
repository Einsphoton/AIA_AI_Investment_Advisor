/**
 * P1-1: tool policy (deny list / write approval) + audit interceptor tests.
 *
 * Everything runs against a real SQLite repo and the real `executeTool`
 * dispatcher with a deterministically installed interceptor. No network: the
 * tools used here are repo-only (`list_watchlist`, `save_dashboard_briefing`,
 * `get_budget`) or fail before touching a datasource (`save_asset_analysis`
 * with an unknown assetId).
 *
 * Owner: P1 workstream.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRepo } from '../src/db/repo.js';
import { installToolInterceptor, recordAudit, runWithApprovalBypass } from '../src/agent/policy.js';
import { executeTool, setToolInterceptor, type AllowWrite, type ToolContext } from '../src/agent/tools.js';
import type { LoggerLike } from '../src/types/agent.js';
import type { Repo } from '../src/types/repo.js';

let repo: Repo;
let dataDir: string;

const warnings: string[] = [];
const logger: LoggerLike = {
  info: () => {},
  warn: (message: string) => {
    warnings.push(message);
  },
  error: () => {},
  debug: () => {},
};

const ALL_WRITES: AllowWrite[] = ['asset', 'watchlist', 'advice', 'briefing', 'settings'];

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    runId: 'run-default',
    kind: 'custom',
    repo,
    logger,
    sink: () => {},
    allowWrites: new Set<AllowWrite>(ALL_WRITES),
    target: null,
    batchId: 'batch-policy',
    sessionId: 'session-policy',
    ...overrides,
  };
}

before(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-policy-'));
  process.env.AIA_OFFLINE = '1';
  repo = createRepo(path.join(dataDir, 'advisor.db'));
  repo.migrate();
});

// The interceptor is a process-wide singleton and every suite in this runner
// shares one process, so it must be (re)installed before *each* test: other
// suites (approval.test.ts) install their own with the same seam.
beforeEach(() => {
  installToolInterceptor({ getRepo: () => repo, logger });
});

after(() => {
  // Global seam: never leave the interceptor installed for the other suites.
  setToolInterceptor(null);
  repo?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('deny 命中：工具不执行、返回结构化 policy_denied、audit 记 denied', async () => {
  repo.saveSettings({ toolPolicy: { deny: ['save_dashboard_briefing'], requireWriteApproval: false } });

  const result = await executeTool('save_dashboard_briefing', JSON.stringify({ text: '不应写入' }), ctx({ runId: 'run-deny' }));

  assert.equal(result.ok, false, '被拒的调用必须报告未执行');
  const payload = JSON.parse(result.content) as { error: string; message: string };
  assert.equal(payload.error, 'policy_denied');
  assert.match(payload.message, /禁用/);
  assert.match(payload.message, /只读工具/, '必须提示模型改用只读工具');
  assert.match(result.summary, /被设置中的策略禁用/);

  assert.equal(repo.getKv('dashboard.briefing'), undefined, '被拒绝的写入绝不能落库');

  const audit = repo.listAudit({ runId: 'run-deny', limit: 10 });
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.tool, 'save_dashboard_briefing');
  assert.equal(audit[0]!.outcome, 'denied');
  assert.equal(audit[0]!.risk, 'write');
  assert.equal(audit[0]!.entity, null);
  assert.equal(audit[0]!.sessionId, 'session-policy');
});

test('deny 只按工具名精确匹配，未命中的工具照常执行', async () => {
  repo.saveSettings({ toolPolicy: { deny: ['save_dashboard_briefing'], requireWriteApproval: false } });

  const result = await executeTool('list_watchlist', '{}', ctx({ runId: 'run-deny-miss' }));

  assert.equal(result.ok, true);
  assert.equal(repo.listAudit({ runId: 'run-deny-miss', limit: 10 })[0]!.outcome, 'executed');
});

test('requireWriteApproval=true：写工具被 defer，登记 pending 行，数据未变', async () => {
  repo.saveSettings({ toolPolicy: { deny: [], requireWriteApproval: true } });

  const result = await executeTool('save_dashboard_briefing', JSON.stringify({ text: '待审批简报' }), ctx({ runId: 'run-defer' }));

  assert.equal(result.ok, false, 'defer 表示本次没有执行');
  const payload = JSON.parse(result.content) as { error: string; message: string; pendingId: string };
  assert.equal(payload.error, 'pending_approval');
  assert.match(payload.message, /已提交人工审批/);
  assert.match(payload.message, /继续其它/);
  assert.ok(payload.pendingId.length > 0);

  assert.equal(repo.getKv('dashboard.briefing'), undefined, '审批前不得写入目标数据');

  const pending = repo.listPendingWrites('pending', 50).filter((row) => row.runId === 'run-defer');
  assert.equal(pending.length, 1);
  const row = pending[0]!;
  assert.equal(row.id, payload.pendingId);
  assert.equal(row.tool, 'save_dashboard_briefing');
  assert.equal(row.status, 'pending');
  assert.equal(row.risk, 'write');
  assert.equal(row.sessionId, 'session-policy');
  assert.deepEqual(JSON.parse(row.args), { text: '待审批简报' });
  assert.match(row.summary, /组合简报/, 'summary 应是可读的中文短句');
  assert.equal(row.decidedAt, null);
  assert.equal(row.result, null);

  const audit = repo.listAudit({ runId: 'run-defer', limit: 10 });
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.outcome, 'deferred');
});

test('runWithApprovalBypass：窗口内放行，窗口外仍然 defer（AsyncLocalStorage 不泄漏）', async () => {
  repo.saveSettings({ toolPolicy: { deny: [], requireWriteApproval: true } });

  const blocked = await executeTool(
    'save_dashboard_briefing',
    JSON.stringify({ text: '窗口外' }),
    ctx({ runId: 'run-bypass-before' }),
  );
  assert.equal((JSON.parse(blocked.content) as { error: string }).error, 'pending_approval');

  const allowed = await runWithApprovalBypass(() =>
    executeTool('save_dashboard_briefing', JSON.stringify({ text: '审批通过' }), ctx({ runId: 'run-bypass-inside' })),
  );
  assert.equal(allowed.ok, true);
  assert.equal((JSON.parse(repo.getKv('dashboard.briefing')!) as { text: string }).text, '审批通过');

  // Started concurrently: only the bypassed call may run.
  const [inside, outside] = await Promise.all([
    runWithApprovalBypass(() =>
      executeTool('save_dashboard_briefing', JSON.stringify({ text: '并发放行' }), ctx({ runId: 'run-bypass-concurrent' })),
    ),
    executeTool('save_dashboard_briefing', JSON.stringify({ text: '并发拦截' }), ctx({ runId: 'run-bypass-concurrent-outside' })),
  ]);
  assert.equal(inside.ok, true);
  assert.equal(outside.ok, false);
  assert.equal((JSON.parse(repo.getKv('dashboard.briefing')!) as { text: string }).text, '并发放行');
  assert.equal(
    repo.listPendingWrites('pending', 50).filter((row) => row.runId === 'run-bypass-concurrent-outside').length,
    1,
    '窗口外的并发调用必须登记 pending',
  );
});

test('audit：成功/失败都落行，risk 与 session 正确', async () => {
  repo.saveSettings({ toolPolicy: { deny: [], requireWriteApproval: false } });

  const ok = await executeTool('list_watchlist', '{}', ctx({ runId: 'run-audit-ok', sessionId: undefined }));
  assert.equal(ok.ok, true);

  const failed = await executeTool(
    'save_asset_analysis',
    JSON.stringify({ assetId: 'missing-asset', summary: '不存在' }),
    ctx({ runId: 'run-audit-fail' }),
  );
  assert.equal(failed.ok, false);

  const okRows = repo.listAudit({ runId: 'run-audit-ok', limit: 10 });
  assert.equal(okRows.length, 1);
  assert.equal(okRows[0]!.outcome, 'executed');
  assert.equal(okRows[0]!.risk, 'read');
  assert.equal(okRows[0]!.sessionId, null, '未提供 sessionId 时必须是 null');

  const failRows = repo.listAudit({ runId: 'run-audit-fail', limit: 10 });
  assert.equal(failRows.length, 1);
  assert.equal(failRows[0]!.outcome, 'failed');
  assert.equal(failRows[0]!.risk, 'write');
  assert.match(failRows[0]!.summary, /不存在|未找到/);
});

test('audit：summary 截断 500、args 截断 2000', async () => {
  warnings.length = 0;
  recordAudit({ getRepo: () => repo, logger }, {
    runId: 'run-audit-clip',
    sessionId: null,
    tool: 'unit_test',
    risk: 'write',
    outcome: 'executed',
    summary: 'S'.repeat(900),
    args: 'A'.repeat(5000),
  });

  const row = repo.listAudit({ runId: 'run-audit-clip', limit: 5 })[0]!;
  assert.equal(row.summary.length, 500);
  assert.equal(row.args.length, 2000);

  const longArgs = await executeTool('get_budget', JSON.stringify({ pad: 'x'.repeat(4000) }), ctx({ runId: 'run-audit-args' }));
  assert.equal(longArgs.ok, true, '超长参数不得影响工具执行');
  assert.equal(repo.listAudit({ runId: 'run-audit-args', limit: 5 })[0]!.args.length, 2000);
});

test('audit 写入异常被吞掉并 warn，绝不影响 run', async () => {
  const mutable = repo as unknown as { addAudit: (...args: unknown[]) => unknown };
  const original = mutable.addAudit;
  warnings.length = 0;
  mutable.addAudit = () => {
    throw new Error('disk full');
  };
  try {
    const result = await executeTool('list_watchlist', '{}', ctx({ runId: 'run-audit-throw' }));
    assert.equal(result.ok, true, '审计失败不得改变工具结果');
    assert.ok(
      warnings.some((message) => message.includes('audit log write failed')),
      '必须 warn 而不是抛出',
    );
  } finally {
    mutable.addAudit = original;
  }
});

test('policy 读取失败时 fail-open：工具照常执行', async () => {
  const mutable = repo as unknown as { getSettings: () => unknown };
  const original = mutable.getSettings;
  warnings.length = 0;
  mutable.getSettings = () => {
    throw new Error('settings unavailable');
  };
  try {
    const result = await executeTool('list_watchlist', '{}', ctx({ runId: 'run-policy-throw' }));
    assert.equal(result.ok, true);
    assert.ok(warnings.some((message) => message.includes('tool policy unavailable')));
  } finally {
    mutable.getSettings = original;
  }
});
