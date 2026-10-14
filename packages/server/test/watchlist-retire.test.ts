/**
 * P3 淘汰机制测试 — owner: agent-engine.
 *
 * 需求（方案3 + 持仓保护）：
 *   1. Agent 用 `retire_watch_item` 软淘汰，写回原因并累计连续确认次数；
 *   2. 连续 N 次（`settings.watchlistRetireDeleteRuns`）确认退役后，流水线在
 *      `runWatchlistAnalysis` 结束时通过工具层删除（策略/审计/写入审批照常生效）；
 *   3. 硬护栏：**有持仓**、人工录入、存在待处理建议的标的永不被自动删除；
 *      其中「退役后又买入」的标的会自动复活（持仓是加仓的复盘锚点）；
 *   4. 模型重新 upsert（重新认可）即自动复活。
 *
 * 模型行为用 stub runtime 代替（清理是代码的确定性规则，与模型无关）；
 * 退役/复活本身走真实 `executeTool` 路径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentRun } from '@aia/shared';

import { createRepo } from '../src/db/repo.js';
import { runWatchlistAnalysis } from '../src/services/analytics.js';
import { executeTool, setToolInterceptor, type AllowWrite } from '../src/agent/tools.js';
import { installToolInterceptor } from '../src/agent/policy.js';
import type { AgentRuntime, LoggerLike } from '../src/types/agent.js';
import type { Repo } from '../src/types/repo.js';
import type { WatchRow } from '../src/types/models.js';

const silentLogger: LoggerLike = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function tempRepo(): { repo: Repo; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-retire-'));
  const repo = createRepo(path.join(dir, 'advisor.db'));
  repo.migrate();
  return { repo, dir };
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

/** Stub runtime: the sweep is deterministic and does not depend on the model. */
function stubAgent(): AgentRuntime {
  const now = new Date().toISOString();
  const run: AgentRun = {
    id: 'run-retire',
    kind: 'watchlist-analysis',
    status: 'done',
    target: 'watchlist:0',
    title: 'AI 标的分析',
    summary: '复核完成',
    error: null,
    turns: 1,
    promptTokens: 0,
    completionTokens: 0,
    startedAt: now,
    finishedAt: now,
    steps: [],
  };
  return { isConfigured: () => true, tools: () => [], run: async () => run, resume: async () => run };
}

function toolCtx(repo: Repo, allow: AllowWrite[] = ['watchlist']) {
  return {
    runId: 'run-tools',
    kind: 'watchlist-analysis' as const,
    repo,
    logger: silentLogger,
    sink: () => undefined,
    allowWrites: new Set<AllowWrite>(allow),
    target: null,
    batchId: 'run-tools',
  };
}

function seedWatchItem(repo: Repo, over: { code: string; source?: WatchRow['source']; status?: WatchRow['status']; retireStreak?: number }): WatchRow {
  const created = repo.createWatchItem({
    id: `w-${over.code}`,
    name: `测试${over.code}`,
    code: over.code,
    market: 'CN',
    type: 'stock',
    source: over.source ?? 'ai',
    initialPrice: 10,
    initialPriceAt: new Date().toISOString(),
    price: 10,
    priceAt: new Date().toISOString(),
    prevClose: 10,
    dayChangePct: 0,
    spark: [],
    note: '',
    createdAt: new Date().toISOString(),
  });
  if (over.status !== 'retired') return created;
  return repo.updateWatchItem(created.id, {
    status: 'retired',
    retiredReason: '估值与趋势双弱',
    retiredAt: new Date().toISOString(),
    retireStreak: over.retireStreak ?? 0,
  })!;
}

/** 建仓：买入 100 股，形成「有持仓」状态。 */
function holdPosition(repo: Repo, code: string): void {
  const asset = repo.createAsset({
    id: `a-${code}`,
    name: `持仓${code}`,
    code,
    market: 'CN',
    type: 'stock',
    source: 'manual',
    currency: 'CNY',
    note: '',
    price: 10,
    priceAt: new Date().toISOString(),
    prevClose: 10,
    dayChangePct: 0,
    spark: [],
    createdAt: new Date().toISOString(),
  });
  repo.addTransaction({
    id: `t-${code}`,
    assetId: asset.id,
    kind: 'buy',
    shares: 100,
    price: 10,
    fee: 0,
    tradeDate: '2026-01-05',
    note: '',
    source: 'manual',
    createdAt: new Date().toISOString(),
  });
}

/* ─────────────────────────────── 工具层 ─────────────────────────────── */

/**
 * 复活路径经过真实的 `upsert_watch_item`（内部会尝试抓取行情，因此在离线/慢网
 * 环境下这一步可能慢一些）；断言只依赖库内状态，不依赖行情是否取到。
 */
test('P3: retire_watch_item 写回原因并累计次数，upsert 重新认可即复活', { timeout: 60_000 }, async () => {
  const { repo, dir } = tempRepo();
  try {
    const item = seedWatchItem(repo, { code: '000001' });
    const ctx = toolCtx(repo);

    for (let i = 1; i <= 3; i += 1) {
      const outcome = await executeTool(
        'retire_watch_item',
        JSON.stringify({ code: '000001', market: 'CN', type: 'stock', reason: `第 ${i} 次判定：估值与趋势双弱` }),
        ctx,
      );
      assert.equal(outcome.ok, true, `第 ${i} 次退役应成功`);
      const row = repo.getWatchItem(item.id)!;
      assert.equal(row.status, 'retired');
      assert.equal(row.retireStreak, i, '连续确认次数必须逐次累计');
      assert.match(row.retiredReason, new RegExp(`第 ${i} 次`));
    }

    // 没有原因的退役不可接受（无法复盘）。
    const noReason = await executeTool(
      'retire_watch_item',
      JSON.stringify({ code: '000001', market: 'CN', type: 'stock' }),
      ctx,
    );
    assert.equal(noReason.ok, false);

    // 模型重新认可 → upsert 自动复活并清零次数。
    const revived = await executeTool(
      'upsert_watch_item',
      JSON.stringify({ code: '000001', market: 'CN', type: 'stock', qualityScore: 88, thesis: '基本面重新转好' }),
      ctx,
    );
    assert.equal(revived.ok, true);
    const after = repo.getWatchItem(item.id)!;
    assert.equal(after.status, 'active');
    assert.equal(after.retireStreak, 0);
    assert.equal(after.retiredReason, '');
  } finally {
    closeAndRemove(repo, dir);
  }
});

test('P3: 有持仓的标的拒绝退役，删除工具二次护栏兜底', { timeout: 20_000 }, async () => {
  const { repo, dir } = tempRepo();
  try {
    const item = seedWatchItem(repo, { code: '600000' });
    holdPosition(repo, '600000');
    const ctx = toolCtx(repo);

    const retire = await executeTool(
      'retire_watch_item',
      JSON.stringify({ code: '600000', market: 'CN', type: 'stock', reason: '趋势走坏' }),
      ctx,
    );
    assert.equal(retire.ok, false, '有持仓的标的不允许进入淘汰流程');
    assert.match(retire.content, /持仓/);
    assert.equal(repo.getWatchItem(item.id)!.status, 'active', '被拒绝后不得写入退役状态');

    // 即使调用方判断有误，删除工具也必须被护栏挡下。
    const forced = await executeTool('delete_watch_item', JSON.stringify({ id: item.id }), ctx);
    assert.equal(forced.ok, false, '有持仓时删除必须拒绝');
    assert.ok(repo.getWatchItem(item.id), '标的必须仍然存在');
  } finally {
    closeAndRemove(repo, dir);
  }
});

test('P3: delete_watch_item 不暴露给模型，但仍可被流水线调用', async () => {
  // llmToolSchemas 由 registry 生成：系统工具必须被过滤掉。
  const { llmToolSchemas, toolDescriptors } = await import('../src/agent/tools.js');
  const kinds = ['watchlist-analysis', 'scheduled', 'chat', 'custom'] as const;
  for (const kind of kinds) {
    const names = llmToolSchemas(kind, ['watchlist']).map((schema) => schema.function.name);
    assert.ok(!names.includes('delete_watch_item'), `${kind}: 删除工具不得交给模型`);
    assert.ok(names.includes('retire_watch_item'), `${kind}: 退役工具应可用`);
  }
  // 目录（设置页的工具策略）里仍能看到它，便于用户 deny。
  assert.ok(toolDescriptors().some((tool) => tool.name === 'delete_watch_item'));
});

/* ───────────────────────────── 流水线清理 ───────────────────────────── */

test('P3: 流水线按阈值清理，并遵守持仓 / 人工 / 待处理建议三条护栏', { timeout: 30_000 }, async () => {
  const { repo, dir } = tempRepo();
  try {
    repo.saveSettings({ watchlistRetireDeleteRuns: 2 });
    const ripe = seedWatchItem(repo, { code: '000001', status: 'retired', retireStreak: 2 });
    const notYet = seedWatchItem(repo, { code: '000002', status: 'retired', retireStreak: 1 });
    const held = seedWatchItem(repo, { code: '000003', status: 'retired', retireStreak: 5 });
    const manual = seedWatchItem(repo, { code: '000004', status: 'retired', retireStreak: 5, source: 'manual' });
    const withAdvice = seedWatchItem(repo, { code: '000005', status: 'retired', retireStreak: 5 });
    holdPosition(repo, '000003');
    repo.createAdvice({
      id: 'adv-1',
      batchId: 'batch-1',
      assetId: null,
      watchItemId: withAdvice.id,
      assetName: '测试000005',
      code: '000005',
      market: 'CN',
      type: 'stock',
      action: 'buy',
      targetShares: 100,
      targetPrice: 10,
      currency: 'CNY',
      reason: '估值便宜',
      confidence: 0.7,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    const events: import('@aia/shared').AgentEvent[] = [];
    await runWatchlistAnalysis({ agent: stubAgent(), repo, logger: silentLogger, sink: (event) => events.push(event) });

    assert.equal(repo.getWatchItem(ripe.id), undefined, '连续 2 次确认退役后应被移除');
    assert.ok(repo.getWatchItem(notYet.id), '未达阈值的必须保留');
    assert.ok(repo.getWatchItem(manual.id), '人工录入的永不自动删除');
    assert.ok(repo.getWatchItem(withAdvice.id), '有待处理建议引用的暂不删除');
    assert.equal(repo.getWatchItem(held.id)?.status, 'active', '重新出现持仓的标的应自动复活');
    assert.equal(repo.getWatchItem(held.id)?.retireStreak, 0, '复活后清零累计次数');

    // 删除必须通过工具层 → 留下 entity 事件，前端能立刻刷新列表。
    assert.ok(
      events.some((event) => event.type === 'entity' && event.action === 'deleted' && event.entity === 'watchlist'),
      '删除应发出 entity(deleted) 事件',
    );
  } finally {
    closeAndRemove(repo, dir);
  }
});

test('P3: 阈值为 0 时只标记不删除', { timeout: 20_000 }, async () => {
  const { repo, dir } = tempRepo();
  try {
    repo.saveSettings({ watchlistRetireDeleteRuns: 0 });
    const item = seedWatchItem(repo, { code: '000001', status: 'retired', retireStreak: 99 });
    await runWatchlistAnalysis({ agent: stubAgent(), repo, logger: silentLogger });
    assert.ok(repo.getWatchItem(item.id), 'threshold=0 时不得删除任何标的');
  } finally {
    closeAndRemove(repo, dir);
  }
});

test('P3: 开启写入审批时删除被挂起（进入待审批），标的保留', { timeout: 20_000 }, async () => {
  const { repo, dir } = tempRepo();
  try {
    repo.saveSettings({ watchlistRetireDeleteRuns: 1, toolPolicy: { deny: [], requireWriteApproval: true } });
    installToolInterceptor({ getRepo: () => repo, logger: silentLogger });
    const item = seedWatchItem(repo, { code: '000001', status: 'retired', retireStreak: 3 });

    await runWatchlistAnalysis({ agent: stubAgent(), repo, logger: silentLogger });

    assert.ok(repo.getWatchItem(item.id), '审批模式下不得直接删除');
    const pending = repo.listPendingWritesByRun('run-retire', 10);
    assert.ok(
      pending.some((row) => row.tool === 'delete_watch_item' && row.status === 'pending'),
      '删除应进入待审批队列',
    );
  } finally {
    setToolInterceptor(null);
    closeAndRemove(repo, dir);
  }
});

test('P3: 退役状态与次数随备份/恢复往返，且不参与建议候选', { timeout: 20_000 }, async () => {
  const { repo, dir } = tempRepo();
  try {
    repo.saveSettings({ watchlistRetireDeleteRuns: 5 });
    const item = seedWatchItem(repo, { code: '000001', status: 'retired', retireStreak: 2 });

    // 备份导出必须包含退役标的（否则恢复后凭空消失）。
    const bundle = repo.exportAll();
    assert.equal(bundle.watchlist.length, 1);
    assert.equal(bundle.watchlist[0]!.status, 'retired');
    assert.equal(bundle.watchlist[0]!.retireStreak, 2);

    // 列表默认只看在池标的。
    assert.equal(repo.listWatchlist().length, 0);
    assert.equal(repo.listWatchlist('all').length, 1);
    assert.equal(repo.listWatchlist('retired').length, 1);
    assert.deepEqual(repo.countWatchlist(), { active: 0, retired: 1 });
    assert.ok(item);
  } finally {
    closeAndRemove(repo, dir);
  }
});
