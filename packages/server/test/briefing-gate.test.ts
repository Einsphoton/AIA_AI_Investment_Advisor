/**
 * D1 regression (found by independent verification, fixed by Lead):
 * the asset-analysis pipeline used to persist its "model forgot the briefing"
 * fallback with a direct `writeBriefing()` → `repo.setKv('dashboard.briefing')`.
 * That bypassed `toolPolicy.deny` and the write-approval gate, so a denied or
 * pending briefing still landed in the Dashboard. Every write must go through
 * the tool layer.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRepo } from '../src/db/repo.js';
import { installToolInterceptor } from '../src/agent/policy.js';
import { setToolInterceptor } from '../src/agent/tools.js';
import { runAssetAnalysis } from '../src/services/analytics.js';
import type { AgentRun } from '@aia/shared';
import type { AgentRuntime } from '../src/types/agent.js';
import type { Repo } from '../src/types/repo.js';

process.env.AIA_OFFLINE = '1';

let repo: Repo;
let dataDir: string;
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const BRIEFING_KEY = 'dashboard.briefing';

function fakeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  const now = new Date().toISOString();
  return {
    id: 'run-brief',
    kind: 'asset-analysis',
    status: 'done',
    target: 'assets:0',
    title: 'AI 资产分析',
    summary: '兜底简报正文',
    error: null,
    turns: 1,
    promptTokens: 0,
    completionTokens: 0,
    startedAt: now,
    finishedAt: now,
    steps: [],
    ...overrides,
  };
}

/** Stub runtime that "succeeds" without calling any tool. */
function stubAgent(run: AgentRun): AgentRuntime {
  return {
    isConfigured: () => true,
    tools: () => [],
    run: async () => run,
    resume: async () => run,
  };
}

before(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-brief-'));
  repo = createRepo(path.join(dataDir, 'advisor.db'));
  repo.migrate();
});

after(() => {
  setToolInterceptor(null);
  repo?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('D1: deny save_dashboard_briefing → 兜底写入被拒绝，不再旁路落库', async () => {
  repo.saveSettings({ toolPolicy: { deny: ['save_dashboard_briefing'], requireWriteApproval: false } });
  installToolInterceptor({ getRepo: () => repo, logger });

  await runAssetAnalysis({ agent: stubAgent(fakeRun()), repo, logger });

  assert.equal(repo.getKv(BRIEFING_KEY), undefined, 'deny 生效后不得写入简报');
  const audit = repo.listAudit({ limit: 10 });
  assert.equal(audit[0]?.tool, 'save_dashboard_briefing', '兜底写入必须留下审计');
  assert.equal(audit[0]?.outcome, 'denied', '被策略拒绝必须记为 denied');
});

test('D1: 开启写入审批 → 兜底写入进入待审批，而不是直接落库', async () => {
  repo.saveSettings({ toolPolicy: { deny: [], requireWriteApproval: true } });
  installToolInterceptor({ getRepo: () => repo, logger });

  await runAssetAnalysis({ agent: stubAgent(fakeRun({ id: 'run-brief-approval' })), repo, logger });

  assert.equal(repo.getKv(BRIEFING_KEY), undefined, '审批模式下不得直接写入');
  const pending = repo.listPendingWritesByRun('run-brief-approval', 10);
  assert.ok(
    pending.some((row) => row.tool === 'save_dashboard_briefing' && row.status === 'pending'),
    '兜底写入应进入待审批队列',
  );
});

test('D1: 策略放行时兜底写入仍然生效（功能没有被关掉）', async () => {
  repo.saveSettings({ toolPolicy: { deny: [], requireWriteApproval: false } });
  installToolInterceptor({ getRepo: () => repo, logger });

  await runAssetAnalysis({ agent: stubAgent(fakeRun({ id: 'run-brief-ok', summary: '正常兜底正文' })), repo, logger });

  const stored = repo.getKv(BRIEFING_KEY);
  assert.ok(stored, '放行时必须写入简报');
  const parsed = JSON.parse(stored) as { text: string; runId: string };
  assert.equal(parsed.text, '正常兜底正文');
  assert.equal(parsed.runId, 'run-brief-ok');
  const audit = repo.listAudit({ limit: 10, outcome: 'executed' });
  assert.ok(audit.some((row) => row.tool === 'save_dashboard_briefing'), '放行写入也应留审计');
});
