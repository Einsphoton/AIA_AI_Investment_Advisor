/**
 * Repository tests — schema migration, CRUD, settings, export/import roundtrip.
 *
 * Owner: server-core. Each test uses its own SQLite file in the OS temp dir.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DEFAULT_DATA_SOURCES, DEFAULT_LLM, DEFAULT_PERSONA, type OptionAdvicePlan, type ScheduleTask } from '@aia/shared';

import { createRepo } from '../src/db/repo.js';
import { settingsPatch } from '../src/db/util.js';
import { AppError } from '../src/errors.js';
import {
  buildBackupPayload,
  importBackupPayload,
  listBackupSnapshots,
  readBackupSnapshot,
  resolveSnapshotPath,
  validateBackupPayload,
  writeBackupSnapshot,
} from '../src/services/backup.js';
import type { Repo } from '../src/types/repo.js';
import type { NewAdvice, NewAsset, NewOptionContract, NewOptionSettlement, NewTx, NewWatch } from '../src/types/models.js';

function tempRepo(): { repo: Repo; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-repo-'));
  const repo = createRepo(path.join(dir, 'advisor.db'));
  repo.migrate();
  return { repo, dir };
}

let counter = 0;
const uid = (): string => `${(counter += 1).toString().padStart(4, '0')}-${crypto.randomUUID()}`;

/** 定时任务夹具（数组化之后的设置项）。 */
function task(over: Partial<ScheduleTask> = {}): ScheduleTask {
  return {
    id: over.id ?? `sched_${uid()}`,
    name: over.name ?? '测试任务',
    enabled: over.enabled ?? true,
    mode: over.mode ?? 'daily',
    intervalMinutes: over.intervalMinutes ?? 1440,
    dailyTime: over.dailyTime ?? '08:30',
    runAssetAnalysis: over.runAssetAnalysis ?? true,
    runWatchlistAnalysis: over.runWatchlistAnalysis ?? true,
    runIpoAnalysis: over.runIpoAnalysis ?? true,
    runAdvice: over.runAdvice ?? true,
  };
}

function newAsset(over: Partial<NewAsset> = {}): NewAsset {
  const id = over.id ?? uid();
  return {
    id,
    name: over.name ?? `资产${id}`,
    code: over.code ?? `CODE${id}`,
    market: over.market ?? 'CN',
    type: over.type ?? 'stock',
    source: over.source ?? 'manual',
    currency: over.currency ?? 'CNY',
    note: over.note ?? '',
    price: over.price ?? 10,
    priceAt: over.priceAt ?? '2026-10-01T10:00:00.000+08:00',
    prevClose: over.prevClose ?? 10,
    dayChangePct: over.dayChangePct ?? 0,
    spark: over.spark ?? [],
    createdAt: over.createdAt ?? '2026-10-01T10:00:00.000+08:00',
  };
}

function newTx(assetId: string, over: Partial<NewTx> = {}): NewTx {
  return {
    id: over.id ?? uid(),
    assetId,
    kind: over.kind ?? 'buy',
    shares: over.shares ?? 100,
    price: over.price ?? 10,
    fee: over.fee ?? 0,
    tradeDate: over.tradeDate ?? '2026-10-01',
    note: over.note ?? '',
    source: over.source ?? 'manual',
    createdAt: over.createdAt ?? '2026-10-01T10:00:00.000+08:00',
  };
}

function newWatch(over: Partial<NewWatch> = {}): NewWatch {
  const id = over.id ?? uid();
  return {
    id,
    name: over.name ?? `标的${id}`,
    code: over.code ?? `W${id}`,
    market: over.market ?? 'CN',
    type: over.type ?? 'stock',
    source: over.source ?? 'manual',
    initialPrice: over.initialPrice ?? 20,
    initialPriceAt: over.initialPriceAt ?? '2026-10-01T10:00:00.000+08:00',
    price: over.price ?? 22,
    priceAt: over.priceAt ?? '2026-10-02T10:00:00.000+08:00',
    prevClose: over.prevClose ?? 21,
    dayChangePct: over.dayChangePct ?? 4.76,
    spark: over.spark ?? [20, 21, 22],
    note: over.note ?? '',
    createdAt: over.createdAt ?? '2026-10-01T10:00:00.000+08:00',
  };
}

function newAdvice(over: Partial<NewAdvice> = {}): NewAdvice {
  const id = over.id ?? uid();
  return {
    id,
    batchId: over.batchId ?? 'batch-1',
    assetId: over.assetId ?? null,
    watchItemId: over.watchItemId ?? null,
    assetName: over.assetName ?? '测试',
    code: over.code ?? 'AAPL',
    market: over.market ?? 'US',
    type: over.type ?? 'stock',
    // 默认股票建议（不传即老行为）；卖权建议显式带 instrument + optionPlan。
    instrument: over.instrument ?? 'stock',
    action: over.action ?? 'buy',
    targetShares: over.targetShares ?? 10,
    targetPrice: over.targetPrice ?? 100,
    currency: over.currency ?? 'USD',
    reason: over.reason ?? '业绩超预期',
    confidence: over.confidence ?? 0.7,
    status: over.status ?? 'pending',
    createdAt: over.createdAt ?? '2026-10-01T10:00:00.000+08:00',
    optionPlan: over.optionPlan ?? null,
  };
}

/** 卖权方案夹具（`AdviceItem.option` / `AdviceRow.option`）。 */
function samplePlan(over: Partial<OptionAdvicePlan> = {}): OptionAdvicePlan {
  return {
    strategy: over.strategy ?? 'covered_call',
    optionType: over.optionType ?? 'call',
    optionCode: over.optionCode ?? 'AAPL261120C00250000',
    strike: over.strike ?? 250,
    expiry: over.expiry ?? '2026-11-20',
    contracts: over.contracts ?? 1,
    multiplier: over.multiplier ?? 100,
    currency: over.currency ?? 'USD',
    premium: over.premium ?? 3.5,
    metrics: over.metrics ?? {
      premiumIncome: 349,
      staticYieldPct: 1.4,
      annualizedYieldPct: 12,
      downsideProtectionPct: 2.1,
      collateral: 24_500,
      collateralKind: 'shares',
      maxProfit: 349,
      breakeven: 253.5,
      assignmentProbability: 0.28,
      liquidityScore: 82,
      requiredShares: 100,
    },
    underlyingPrice: over.underlyingPrice ?? 245,
    acceptAssignment: over.acceptAssignment ?? true,
    collateralNote: over.collateralNote ?? 'AAPL 100 股',
    dataSource: over.dataSource ?? 'CBOE 延迟行情',
    dataAsOf: over.dataAsOf ?? '2026-10-01T04:00:00.000+08:00',
    delayed: over.delayed ?? true,
    warnings: over.warnings ?? [],
  };
}

function newOptionContract(over: Partial<NewOptionContract> = {}): NewOptionContract {
  const id = over.id ?? uid();
  return {
    id,
    adviceId: over.adviceId ?? null,
    strategy: over.strategy ?? 'covered_call',
    market: over.market ?? 'US',
    underlyingCode: over.underlyingCode ?? 'AAPL',
    underlyingName: over.underlyingName ?? '苹果',
    underlyingAssetId: over.underlyingAssetId ?? null,
    optionCode: over.optionCode ?? 'AAPL261120C00250000',
    optionType: over.optionType ?? 'call',
    strike: over.strike ?? 250,
    expiry: over.expiry ?? '2026-11-20',
    contracts: over.contracts ?? 1,
    multiplier: over.multiplier ?? 100,
    currency: over.currency ?? 'USD',
    premium: over.premium ?? 3.5,
    fee: over.fee ?? 1,
    premiumIncome: over.premiumIncome ?? 349,
    collateralKind: over.collateralKind ?? 'shares',
    collateral: over.collateral ?? 0,
    underlyingPriceAtOpen: over.underlyingPriceAtOpen ?? 245,
    status: over.status ?? 'open',
    openedAt: over.openedAt ?? '2026-10-01T10:00:00.000+08:00',
    note: over.note ?? '',
    createdAt: over.createdAt ?? '2026-10-01T10:00:00.000+08:00',
    updatedAt: over.updatedAt ?? '2026-10-01T10:00:00.000+08:00',
  };
}

function newOptionSettlement(contractId: string, over: Partial<NewOptionSettlement> = {}): NewOptionSettlement {
  const id = over.id ?? uid();
  return {
    id,
    contractId,
    expiry: over.expiry ?? '2026-11-20',
    evaluatedAt: over.evaluatedAt ?? '2026-11-21T06:00:00.000+08:00',
    referencePrice: over.referencePrice ?? 240,
    priceSource: over.priceSource ?? 'cboe-close',
    verdict: over.verdict ?? 'otm_no_assignment',
    itmAmount: over.itmAmount ?? 0,
    itmPct: over.itmPct ?? 0,
    status: over.status ?? 'auto_settled',
    action: over.action ?? 'none',
    transactionId: over.transactionId ?? null,
    assetId: over.assetId ?? null,
    realizedPnl: over.realizedPnl ?? 349,
    note: over.note ?? '',
    createdAt: over.createdAt ?? '2026-11-21T06:00:00.000+08:00',
  };
}

test('repo: migrate 幂等且 settings 单行 seed 来自 @aia/shared 默认值', () => {
  const { repo, dir } = tempRepo();
  try {
    // Running again must not throw nor duplicate anything.
    repo.migrate();
    repo.migrate();

    const settings = repo.getSettings();
    assert.equal(settings.persona, 'balanced');
    assert.equal(settings.reportStyle, 'professional');
    assert.equal(settings.llm.model, DEFAULT_LLM.model);
    assert.equal(settings.llm.baseUrl, DEFAULT_LLM.baseUrl);
    assert.equal(settings.budget.CN, 5000);
    assert.equal(settings.budget.HK, 5000);
    assert.equal(settings.budget.US, 1000);
    assert.equal(settings.enforceBudget, true);
    assert.equal(settings.watchlistCandidateLimit, 5);
    assert.equal(settings.schedules.length, 0, '出厂不预置定时任务');
    assert.equal(settings.dataSources.stockUS.provider, DEFAULT_DATA_SOURCES.stockUS.provider);

    // Reopening the same file (existing DB) keeps working.
    repo.close();
    const reopened = createRepo(path.join(dir, 'advisor.db'));
    assert.equal(reopened.getSettings().persona, 'balanced');
    reopened.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repo: settings 深合并 + JSON 列 data_sources 往返', () => {
  const { repo, dir } = tempRepo();
  try {
    const saved = repo.saveSettings(
      settingsPatch({
        persona: 'value',
        llm: { model: 'deepseek-reasoner', apiKey: 'sk-secret-0001' },
        dataSources: { stockUS: { provider: 'tencent', enabled: false } },
        budget: { US: 2000 },
        schedules: [task({ id: 'sched_a', name: '盘前', mode: 'daily', dailyTime: '07:15' })],
      }),
    );

    assert.equal(saved.persona, 'value');
    assert.equal(saved.llm.model, 'deepseek-reasoner');
    assert.equal(saved.llm.apiKey, 'sk-secret-0001');
    assert.equal(saved.llm.baseUrl, DEFAULT_LLM.baseUrl, '未传字段应保持原值');
    assert.equal(saved.dataSources.stockUS.provider, 'tencent');
    assert.equal(saved.dataSources.stockUS.enabled, false);
    assert.equal(saved.dataSources.stockCN.provider, 'auto', '其他槽位不受影响');
    assert.equal(saved.budget.US, 2000);
    assert.equal(saved.budget.CN, 5000);
    assert.equal(saved.schedules.length, 1);
    assert.equal(saved.schedules[0]!.mode, 'daily');
    assert.equal(saved.schedules[0]!.dailyTime, '07:15');

    const reloaded = repo.getSettings();
    assert.deepEqual(reloaded.dataSources, saved.dataSources);
    assert.equal(reloaded.llm.apiKey, 'sk-secret-0001');
    assert.deepEqual(reloaded.schedules, saved.schedules, '定时任务数组必须原样往返');

    // Clearing the key.
    assert.equal(repo.saveSettings(settingsPatch({ llm: { apiKey: '' } })).llm.apiKey, '');
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repo: 定时任务数组整体替换、去重、旧列同步（可回滚）', () => {
  const { repo, dir } = tempRepo();
  try {
    const first = task({ id: 'sched_a', name: '盘前', mode: 'interval', intervalMinutes: 90 });
    const second = task({ id: 'sched_b', name: '周末', mode: 'daily', dailyTime: '20:00', enabled: false });
    repo.saveSettings({ schedules: [first, second] });
    assert.deepEqual(repo.getSettings().schedules, [first, second]);

    // 整体替换语义：只发一个任务 = 另一个被删掉（不是合并）。
    repo.saveSettings({ schedules: [second] });
    assert.deepEqual(repo.getSettings().schedules.map((item) => item.id), ['sched_b']);

    // 坏数据防御：重复 id / 结构不对的条目被丢弃，而不是让整个设置读不出来。
    const sanitized = repo.saveSettings({
      schedules: [
        first,
        { ...first } as unknown as ScheduleTask,
        { id: 'broken' } as unknown as ScheduleTask,
      ],
    });
    assert.deepEqual(sanitized.schedules.map((item) => item.id), ['sched_a']);

    // 旧列同步：第一个**启用**任务写进 schedule_* 列（旧版本代码也能排程）。
    repo.saveSettings({ schedules: [task({ id: 'sched_c', mode: 'interval', intervalMinutes: 45 })] });
    repo.close();
    const raw = new DatabaseSync(path.join(dir, 'advisor.db'));
    const row = raw.prepare('SELECT schedule_mode, schedule_interval_minutes FROM settings WHERE id = 1').get() as {
      schedule_mode: string;
      schedule_interval_minutes: number;
    };
    assert.equal(row.schedule_mode, 'interval');
    assert.equal(row.schedule_interval_minutes, 45);
    raw.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repo: 老库的单任务列（mode=daily）读取时迁移成 schedules 数组，且不会被重复迁移', () => {
  const { repo, dir } = tempRepo();
  repo.saveSettings({ schedules: [] });
  repo.close();

  // 模拟 2026-10 之前的库：schedules 列是空的，排程信息只在 schedule_* 列里。
  const raw = new DatabaseSync(path.join(dir, 'advisor.db'));
  raw
    .prepare(
      'UPDATE settings SET schedule_mode = ?, schedule_daily_time = ?, schedule_run_watchlist = ?, schedule_run_advice = ? WHERE id = 1',
    )
    .run('daily', '07:15', 0, 1);
  raw.close();

  const reopened = createRepo(path.join(dir, 'advisor.db'));
  reopened.migrate();
  try {
    const migrated = reopened.getSettings();
    assert.equal(migrated.schedules.length, 1, '旧库必须迁移出一个任务');
    assert.equal(migrated.schedules[0]!.enabled, true);
    assert.equal(migrated.schedules[0]!.mode, 'daily');
    assert.equal(migrated.schedules[0]!.dailyTime, '07:15');
    assert.equal(migrated.schedules[0]!.runWatchlistAnalysis, false, '步骤开关也要迁移');

    // 用户删光任务后：不得因为旧列还留着历史值而「复活」一个幽灵任务。
    reopened.saveSettings({ schedules: [] });
    assert.deepEqual(reopened.getSettings().schedules, []);
  } finally {
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repo: assets CRUD、唯一约束、spark JSON、级联删除交易', () => {
  const { repo, dir } = tempRepo();
  try {
    const asset = repo.createAsset(newAsset({ code: '600519', name: '贵州茅台', spark: [1, 2, 3] }));
    assert.equal(asset.code, '600519');
    assert.deepEqual(asset.spark, [1, 2, 3]);
    assert.equal(repo.getAsset(asset.id)?.name, '贵州茅台');
    assert.equal(repo.findAsset('600519', 'CN', 'stock')?.id, asset.id);
    assert.equal(repo.listAssets().length, 1);
    assert.equal(repo.listAssets().length, 1);

    assert.throws(
      () => repo.createAsset(newAsset({ code: '600519', market: 'CN', type: 'stock' })),
      (error: unknown) => error instanceof AppError && error.statusCode === 409,
    );

    const first = repo.addTransaction(newTx(asset.id, { shares: 100, price: 10 }));
    repo.addTransaction(newTx(asset.id, { kind: 'sell', shares: 40, price: 12, tradeDate: '2026-10-05' }));
    assert.equal(repo.listTransactions(asset.id).length, 2);
    assert.equal(repo.getTransaction(first.id)?.shares, 100);
    assert.deepEqual(repo.listOpenAssetIds(), [asset.id]);

    const updated = repo.updateAsset(asset.id, { name: '茅台', note: '长期持有', price: 1500, prevClose: 1480 });
    assert.equal(updated?.name, '茅台');
    assert.equal(updated?.code, '600519', '未传字段保持不变');
    assert.equal(updated?.price, 1500);
    assert.equal(repo.updateAsset('missing', { name: 'x' }), undefined);

    assert.equal(repo.deleteAsset(asset.id), true);
    assert.equal(repo.getAsset(asset.id), undefined);
    assert.equal(repo.listTransactions(asset.id).length, 0, 'FK 级联删除交易');
    assert.equal(repo.deleteAsset(asset.id), false);
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repo: transactions 增删与 countCreator', () => {
  const { repo, dir } = tempRepo();
  try {
    const aiAsset = repo.createAsset(newAsset({ source: 'ai' }));
    const manualAsset = repo.createAsset(newAsset({ source: 'manual' }));
    const tx = repo.addTransaction(newTx(aiAsset.id));

    assert.equal(repo.countCreator('ai'), 1);
    assert.equal(repo.countCreator('manual'), 0, '未建仓（无净持仓）不计入');

    const sell = repo.addTransaction(newTx(aiAsset.id, { kind: 'sell', shares: 100, tradeDate: '2026-10-20' }));
    assert.deepEqual(repo.listOpenAssetIds(), [], '清仓后不在持仓列表');
    assert.equal(repo.countCreator('ai'), 0);

    assert.equal(repo.deleteTransaction(sell.id), true);
    assert.equal(repo.deleteTransaction(sell.id), false);
    assert.deepEqual(repo.listOpenAssetIds(), [aiAsset.id]);
    assert.equal(repo.deleteTransaction(tx.id), true);
    assert.equal(repo.listOpenAssetIds().length, 0);
    assert.ok(manualAsset.id);
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repo: watchlist CRUD + clear', () => {
  const { repo, dir } = tempRepo();
  try {
    const item = repo.createWatchItem(newWatch({ code: '00700', market: 'HK', type: 'stock' }));
    assert.equal(item.initialPrice, 20);
    // 老库补列后默认空串（不是 undefined），前端才能安全渲染。
    assert.equal(item.expectedReturnHorizon, '');
    assert.deepEqual(item.spark, [20, 21, 22]);
    assert.equal(repo.findWatchItem('00700', 'HK', 'stock')?.id, item.id);
    assert.throws(
      () => repo.createWatchItem(newWatch({ code: '00700', market: 'HK', type: 'stock' })),
      (error: unknown) => error instanceof AppError && error.statusCode === 409,
    );

    const patched = repo.updateWatchItem(item.id, {
      qualityScore: 82,
      targetPrice: 300,
      expectedReturn: 25,
      expectedReturnHorizon: '1-3 年',
      thesis: '护城河',
    });
    assert.equal(patched?.qualityScore, 82);
    assert.equal(patched?.targetPrice, 300);
    assert.equal(patched?.expectedReturnHorizon, '1-3 年', '预期期限必须落库并可读回');
    assert.equal(patched?.code, '00700', '未传字段保持不变');
    assert.equal(repo.updateWatchItem('missing', { note: 'x' }), undefined);

    repo.createWatchItem(newWatch());
    repo.createWatchItem(newWatch());
    assert.equal(repo.listWatchlist().length, 3);
    assert.equal(repo.clearWatchlist(), 3);
    assert.equal(repo.listWatchlist().length, 0);

    const one = repo.createWatchItem(newWatch());
    assert.equal(repo.deleteWatchItem(one.id), true);
    assert.equal(repo.deleteWatchItem(one.id), false);
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repo: advice 过滤、更新与过期', () => {
  const { repo, dir } = tempRepo();
  try {
    const first = repo.createAdvice(newAdvice({ batchId: 'b1' }));
    const second = repo.createAdvice(newAdvice({ batchId: 'b1', action: 'sell' }));
    const third = repo.createAdvice(newAdvice({ batchId: 'b2' }));

    assert.equal(repo.listAdvice({ batchId: 'b1' }).length, 2);
    assert.equal(repo.listAdvice({ limit: 1 }).length, 1);

    const confirmed = repo.updateAdvice(second.id, {
      status: 'confirmed',
      executedShares: 5,
      executedPrice: 99,
      decidedAt: '2026-10-02T10:00:00.000+08:00',
    });
    assert.equal(confirmed?.status, 'confirmed');
    assert.equal(confirmed?.executedShares, 5);
    assert.equal(repo.getAdvice(second.id)?.executedPrice, 99);
    assert.equal(repo.updateAdvice('missing', { status: 'rejected' }), undefined);

    assert.equal(repo.expirePendingAdvice('b2'), 1, '仅过期的 b1 批次');
    assert.equal(repo.getAdvice(first.id)?.status, 'expired');
    assert.equal(repo.getAdvice(third.id)?.status, 'pending');
    assert.equal(repo.listAdvice({ status: 'pending' }).length, 1);
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repo: runs / steps / chat / kv', () => {
  const { repo, dir } = tempRepo();
  try {
    const run = repo.createRun({
      id: uid(),
      kind: 'asset-analysis',
      status: 'running',
      target: null,
      title: 'AI 资产分析',
      startedAt: '2026-10-01T10:00:00.000+08:00',
    });
    assert.equal(run.turns, 0);
    assert.equal(run.summary, '');

    const step = repo.addStep({ id: uid(), runId: run.id, index: 0, label: '拉取行情', status: 'running' });
    assert.equal(repo.listSteps(run.id).length, 1);
    assert.equal(repo.updateStep(step.id, { status: 'done', detail: 'ok' })?.status, 'done');

    const finished = repo.updateRun(run.id, {
      status: 'done',
      summary: '简报',
      turns: 3,
      promptTokens: 100,
      completionTokens: 50,
      finishedAt: '2026-10-01T10:05:00.000+08:00',
    });
    assert.equal(finished?.status, 'done');
    assert.equal(finished?.turns, 3);
    assert.equal(repo.listRuns({ kind: 'asset-analysis' }).length, 1);
    assert.equal(repo.listRuns({ kind: 'advice' }).length, 0);
    assert.equal(repo.getRun('missing'), undefined);

    const session = repo.createSession(uid(), '新会话', '2026-10-01T10:00:00.000+08:00');
    repo.addMessage({
      id: uid(),
      sessionId: session.id,
      role: 'user',
      content: '你好',
      toolCalls: null,
      toolCallId: null,
      runId: null,
      createdAt: '2026-10-01T10:01:00.000+08:00',
    });
    repo.addMessage({
      id: uid(),
      sessionId: session.id,
      role: 'assistant',
      content: '在的',
      toolCalls: JSON.stringify([{ id: 'call-1', name: 'get_quote' }]),
      toolCallId: null,
      runId: run.id,
      createdAt: '2026-10-01T10:02:00.000+08:00',
    });
    const messages = repo.listMessages(session.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[1]?.toolCalls, JSON.stringify([{ id: 'call-1', name: 'get_quote' }]));
    assert.equal(repo.listSessions()[0]?.id, session.id);

    repo.setKv('fx.rates', '{"USD":7.1}');
    assert.equal(repo.getKv('fx.rates'), '{"USD":7.1}');
    repo.setKv('fx.rates', '{"USD":7.2}');
    assert.equal(repo.getKv('fx.rates'), '{"USD":7.2}');
    assert.equal(repo.getKv('missing'), undefined);

    assert.equal(repo.deleteSession(session.id), true);
    assert.equal(repo.listMessages(session.id).length, 0);
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backup service: payload 组装（剔除 apiKey）、快照读写与导入', () => {
  const { repo, dir } = tempRepo();
  const target = tempRepo();
  const backupDir = path.join(dir, 'backups');
  try {
    const asset = repo.createAsset(
      newAsset({ code: 'TSLA', market: 'US', type: 'stock', currency: 'USD', source: 'ai', price: 250, prevClose: 240, dayChangePct: 4.16, spark: [240, 250] }),
    );
    repo.addTransaction(newTx(asset.id, { shares: 4, price: 200 }));
    repo.createWatchItem(newWatch({ code: 'NVDA', market: 'US' }));
    repo.createRun({
      id: 'run-1',
      kind: 'advice',
      status: 'done',
      target: null,
      title: 'AI 投资建议',
      startedAt: '2026-10-01T10:00:00.000+08:00',
    });
    repo.addStep({ id: 'step-1', runId: 'run-1', index: 0, label: '生成建议', status: 'done' });
    repo.saveSettings(
      settingsPatch({
        llm: { apiKey: 'sk-live-9999' },
        persona: 'steady',
        dataSources: { stockUS: { provider: 'finnhub', enabled: true, apiKey: 'fh-SLOT-LEAK-777' } },
      }),
    );

    const payload = buildBackupPayload(repo, { appVersion: '9.9.9', exportedAt: '2026-10-14T10:00:00.000+08:00' });
    assert.equal(payload.schema, 'ai-investment-advisor/backup');
    assert.equal(payload.version, 1);
    assert.equal(payload.appVersion, '9.9.9');
    assert.equal(payload.exportedAt, '2026-10-14T10:00:00.000+08:00');
    assert.equal(payload.assets.length, 1);
    assert.equal(payload.assets[0]!.spark.length, 2);
    assert.equal(payload.transactions.length, 1);
    assert.equal(payload.watchlist.length, 1);
    assert.equal(payload.runs?.[0]?.stepCount, 1);
    assert.equal(payload.settings?.persona, 'steady');
    assert.equal(payload.settings?.hasApiKey, true);
    assert.equal(payload.settings?.apiKeyMasked, 'sk-****9999');
    assert.equal('apiKey' in (payload.settings!.llm as object), false, '导出不得包含 apiKey');
    // S1: data-source slot secrets must never be exported either.
    assert.equal(payload.settings?.dataSources.stockUS.apiKey, undefined);
    assert.equal((payload.settings?.dataSources.stockUS as { hasApiKey?: boolean }).hasApiKey, true);
    assert.equal(payload.settings?.dataSources.stockUS.provider, 'finnhub');
    assert.ok(!JSON.stringify(payload).includes('sk-live-9999'));
    assert.ok(!JSON.stringify(payload).includes('fh-SLOT-LEAK-777'));

    const snap = writeBackupSnapshot(backupDir, payload, 'backup-test.json');
    assert.equal(snap.name, 'backup-test.json');
    assert.ok(snap.size > 0);
    const files = listBackupSnapshots(backupDir);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.name, 'backup-test.json');
    const snapshotText = readBackupSnapshot(backupDir, 'backup-test.json');
    assert.ok(!snapshotText.includes('sk-live-9999'), '快照文件不得包含 llm Key');
    assert.ok(!snapshotText.includes('fh-SLOT-LEAK-777'), '快照文件不得包含槽位 Key');
    assert.equal(validateBackupPayload(JSON.parse(snapshotText)).assets.length, 1);

    assert.throws(() => resolveSnapshotPath(backupDir, '../evil.json'));
    assert.throws(() => resolveSnapshotPath(backupDir, 'evil.txt'));
    assert.throws(
      () => readBackupSnapshot(backupDir, 'missing.json'),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    );
    assert.equal(listBackupSnapshots(path.join(dir, 'nope')).length, 0);

    const result = importBackupPayload(target.repo, payload, 'merge');
    assert.equal(result.assets, 1);
    assert.equal(result.transactions, 1);
    assert.equal(result.watchlist, 1);
    assert.equal(target.repo.findAsset('TSLA', 'US', 'stock')?.spark.length, 2);
    assert.equal(target.repo.listTransactions()[0]?.price, 200);
    assert.equal(target.repo.listWatchlist()[0]?.code, 'NVDA');
    assert.equal(target.repo.getSettings().persona, 'steady', '非敏感设置随备份恢复');
    assert.equal(target.repo.getSettings().llm.apiKey, '', '导入不会写入 API Key');

    assert.throws(
      () => validateBackupPayload({ schema: 'something-else' }),
      (error: unknown) => error instanceof AppError && error.statusCode === 400,
    );
  } finally {
    repo.close();
    target.repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(target.dir, { recursive: true, force: true });
  }
});

test('repo: export → import 往返一致（merge 去重 / replace 覆盖）', () => {
  const source = tempRepo();
  const target = tempRepo();
  const replaced = tempRepo();
  try {
    const asset = source.repo.createAsset(newAsset({ code: '000858', name: '五粮液', spark: [10, 11] }));
    source.repo.addTransaction(newTx(asset.id, { shares: 200, price: 30 }));
    source.repo.addTransaction(newTx(asset.id, { kind: 'sell', shares: 50, price: 40, tradeDate: '2026-10-08' }));
    source.repo.createWatchItem(newWatch({ code: '09988', market: 'HK' }));
    source.repo.createAdvice(newAdvice({ batchId: 'batch-x' }));
    // 卖权建议 + 卖出的合约 + 到期结算：三者的持久字段都必须往返。
    const optionAdvice = source.repo.createAdvice(
      newAdvice({
        batchId: 'batch-x',
        action: 'sell',
        instrument: 'option',
        code: 'AAPL',
        optionPlan: samplePlan(),
        // 与上一条建议错开秒级时间戳：`created_at` 相同时列表排序不稳定（既有行为）。
        createdAt: '2026-10-01T10:05:00.000+08:00',
      }),
    );
    const contract = source.repo.createOptionContract(
      newOptionContract({ adviceId: optionAdvice.id, status: 'assigned', underlyingAssetId: asset.id }),
    );
    source.repo.updateOptionContract(contract.id, {
      closedAt: '2026-11-21T06:00:00.000+08:00',
      closePrice: 250,
      realizedPnl: 349,
    });
    source.repo.upsertOptionSettlement(newOptionSettlement(contract.id, { verdict: 'assigned', status: 'confirmed' }));

    const bundle = source.repo.exportAll();
    assert.equal(bundle.assets.length, 1);
    assert.equal(bundle.transactions.length, 2);
    assert.equal(bundle.watchlist.length, 1);
    assert.equal(bundle.advice.length, 2);
    assert.equal(bundle.optionContracts.length, 1);
    assert.equal(bundle.optionSettlements.length, 1);
    // instrument 与卖权方案是持久字段：导出必须带上，否则恢复时会静默退化成股票建议。
    assert.equal(bundle.advice.find((row) => row.instrument === 'option')?.option?.optionCode, 'AAPL261120C00250000');

    const merged = target.repo.importAll(bundle, 'merge');
    assert.deepEqual(merged, {
      assets: 1,
      transactions: 2,
      watchlist: 1,
      advice: 2,
      ipoOffers: 0,
      ipoSubscriptions: 0,
      optionContracts: 1,
      optionSettlements: 1,
      skipped: 0,
      mode: 'merge',
    });

    // Round-trip equality of the durable fields.
    assert.deepEqual(target.repo.exportAll(), bundle);

    // Importing again is a no-op thanks to id-based dedup.
    const again = target.repo.importAll(bundle, 'merge');
    assert.equal(again.assets, 0);
    assert.equal(again.transactions, 0);
    assert.equal(again.optionContracts, 0);
    assert.equal(again.optionSettlements, 0);
    // 1 asset + 2 tx + 1 watch + 2 advice + 1 contract + 1 settlement。
    assert.equal(again.skipped, 8);

    // Invalid rows are skipped, valid ones still land.
    const dirty = target.repo.importAll(
      {
        assets: [{ ...bundle.assets[0]!, id: 'broken', code: '', market: 'CN', type: 'stock' } as never],
        transactions: [{ ...bundle.transactions[0]!, id: 'orphan', assetId: 'nope' } as never],
        watchlist: [],
        advice: [],
        ipoOffers: [],
        ipoSubscriptions: [],
        // 张数不是正整数、结算指向不存在的合约 → 都该被丢弃。
        optionContracts: [{ ...bundle.optionContracts[0]!, id: 'bad-lots', contracts: 1.5 } as never],
        optionSettlements: [{ ...bundle.optionSettlements[0]!, id: 'orphan-settle', contractId: 'nope' } as never],
      },
      'merge',
    );
    assert.equal(dirty.assets, 0);
    assert.equal(dirty.transactions, 0);
    assert.equal(dirty.optionContracts, 0);
    assert.equal(dirty.optionSettlements, 0);
    assert.equal(dirty.skipped, 4);

    // `replace` wipes whatever is there first.
    replaced.repo.createAsset(newAsset({ code: 'JUNK' }));
    replaced.repo.createWatchItem(newWatch({ code: 'JUNKW' }));
    replaced.repo.createOptionContract(newOptionContract({ id: 'junk-contract', underlyingCode: 'JUNK' }));
    const result = replaced.repo.importAll(bundle, 'replace');
    assert.equal(result.mode, 'replace');
    assert.equal(result.assets, 1);
    assert.equal(result.optionContracts, 1);
    assert.equal(result.optionSettlements, 1);
    assert.equal(replaced.repo.listAssets().length, 1);
    assert.equal(replaced.repo.findAsset('JUNK', 'CN', 'stock'), undefined);
    assert.equal(replaced.repo.listWatchlist().length, 1);
    assert.equal(replaced.repo.getOptionContract('junk-contract'), undefined, 'replace 先清空期权表');
    assert.deepEqual(replaced.repo.exportAll(), bundle);
  } finally {
    source.repo.close();
    target.repo.close();
    replaced.repo.close();
    fs.rmSync(source.dir, { recursive: true, force: true });
    fs.rmSync(target.dir, { recursive: true, force: true });
    fs.rmSync(replaced.dir, { recursive: true, force: true });
  }
});

/**
 * 一键清除（设置页「危险操作」）的存储层契约：逐表清空 + 计数自洽，
 * 默认保留设置与 API Key，`keepSettings: false` 时恢复出厂默认。
 */
test('repo: clearAllData 逐表清空并计数，默认保留设置 / 可选重置', () => {
  const { repo, dir } = tempRepo();
  try {
    // 铺满所有会被清空的表，确保没有表被漏掉。
    const asset = repo.createAsset(newAsset());
    repo.addTransaction(newTx(asset.id));
    repo.createWatchItem(newWatch());
    repo.createAdvice(newAdvice());
    repo.upsertAdviceOutcome({
      adviceId: 'adv-1',
      runId: 'run-1',
      code: 'AAPL',
      market: 'US',
      type: 'stock',
      action: 'buy',
      currency: 'USD',
      advisedAt: '2026-10-01T10:00:00.000+08:00',
      adviceStatus: 'pending',
      executed: false,
      baselineDate: '2026-10-02',
      baselinePrice: 100,
      lastDate: '2026-10-10',
      lastPrice: 110,
      priceChangePct: 10,
      adviceReturnPct: 10,
      benchmarkCode: 'SPX',
      benchmarkName: '标普500',
      benchmarkBase: 4000,
      benchmarkChangePct: 2,
      excessPct: 8,
      maxReturnPct: 12,
      minReturnPct: -1,
      samples: 6,
      daysTracked: 7,
      status: 'tracking',
      warnings: [],
      updatedAt: '2026-10-10T10:00:00.000+08:00',
    });
    repo.createRun({ id: 'run-1', kind: 'advice', status: 'done', target: null, title: '建议', startedAt: '2026-10-01T10:00:00.000+08:00' });
    repo.addStep({ id: 'step-1', runId: 'run-1', index: 0, label: '生成建议', status: 'done' });
    repo.addRunMessage({
      id: 'msg-1',
      runId: 'run-1',
      index: 0,
      role: 'user',
      content: '你好',
      toolCalls: null,
      toolCallId: null,
      name: null,
      reasoningContent: null,
      createdAt: '2026-10-01T10:00:00.000+08:00',
    });
    const session = repo.createSession('sess-1', '会话', '2026-10-01T10:00:00.000+08:00');
    repo.addMessage({
      id: 'chat-1',
      sessionId: session.id,
      role: 'user',
      content: '你好',
      toolCalls: null,
      toolCallId: null,
      runId: null,
      createdAt: '2026-10-01T10:00:00.000+08:00',
    });
    repo.addAudit({
      id: 'audit-1',
      at: '2026-10-01T10:00:00.000+08:00',
      runId: 'run-1',
      sessionId: null,
      tool: 'upsert_asset',
      risk: 'write',
      outcome: 'executed',
      entity: 'asset',
      entityId: asset.id,
      summary: '新建资产',
      args: '{}',
    });
    repo.addPendingWrite({
      id: 'pending-1',
      runId: 'run-1',
      sessionId: null,
      tool: 'upsert_asset',
      args: '{}',
      summary: '待批准',
      risk: 'write',
      status: 'pending',
      createdAt: '2026-10-01T10:00:00.000+08:00',
      decidedAt: null,
      result: null,
    });
    repo.setKv('fx.rates', '{"USD":7.1}');
    // 打新数据也是用户数据：一键清除必须把它一起清掉（含中签后指向资产的订阅记录）。
    repo.createIpoOffer({
      id: 'ipo-1',
      uid: 'CN:001381',
      market: 'CN',
      code: '001381',
      name: '皇冠新材',
      source: 'eastmoney-ipo',
      issuePrice: 16.98,
      currency: 'CNY',
      lotSize: 500,
      subscribeStart: '2026-10-19',
      subscribeEnd: '2026-10-19',
      listingDate: '2026-10-27',
      createdAt: '2026-10-18T10:00:00.000+08:00',
    });
    repo.upsertIpoSubscription({
      id: 'iposub-1',
      offerUid: 'CN:001381',
      market: 'CN',
      code: '001381',
      name: '皇冠新材',
      status: 'allotted',
      appliedShares: 500,
      allottedShares: 500,
      price: 16.98,
      currency: 'CNY',
      appliedAt: '2026-10-19',
      allottedAt: '2026-10-21',
      assetId: 'asset-1',
      transactionId: 'tx-1',
    });
    repo.saveSettings(
      settingsPatch({ llm: { apiKey: 'sk-keep-me' }, persona: 'steady', dataSources: { stockUS: { apiKey: 'fh-keep-me' } } }),
    );
    repo.saveSettings(settingsPatch({ lastRunAt: '2026-10-01T10:00:00.000+08:00' }));

    // 期权也是用户数据：一笔在手合约 + 一条结算记录，清除时必须一起清（含计数）。
    repo.createOptionContract(newOptionContract({ id: 'option-1' }));
    repo.upsertOptionSettlement(newOptionSettlement('option-1', { id: 'optsettle-1' }));

    const result = repo.clearAllData();
    assert.deepEqual(result, {
      assets: 1,
      transactions: 1,
      watchlist: 1,
      advice: 1,
      adviceOutcomes: 1,
      runs: 1,
      steps: 1,
      runMessages: 1,
      chatSessions: 1,
      chatMessages: 1,
      auditEntries: 1,
      pendingWrites: 1,
      kvEntries: 1,
      ipoOffers: 1,
      ipoSubscriptions: 1,
      optionContracts: 1,
      optionSettlements: 1,
      settingsReset: false,
      deleted: 17,
    });

    // 每张表都真的空了。
    assert.deepEqual(repo.exportAll(), {
      assets: [],
      transactions: [],
      watchlist: [],
      advice: [],
      ipoOffers: [],
      ipoSubscriptions: [],
      optionContracts: [],
      optionSettlements: [],
    });
    assert.equal(repo.listOptionContracts({ status: 'all' }).length, 0, '期权合约不得悬挂');
    assert.equal(repo.listOptionSettlements({ status: 'all' }).length, 0);
    assert.equal(repo.listAdviceOutcomes().length, 0);
    assert.equal(repo.listRuns().length, 0);
    assert.equal(repo.listRunMessages('run-1').length, 0);
    assert.equal(repo.listSessions().length, 0);
    assert.equal(repo.listAudit().length, 0);
    assert.equal(repo.listPendingWrites().length, 0);
    assert.equal(repo.getKv('fx.rates'), undefined);
    assert.equal(repo.getSettings().lastRunAt, null, 'last_run_at 不再指向已删除的 run');

    // 默认保留 AI 配置（含两个 Key）。
    assert.equal(repo.getSettings().llm.apiKey, 'sk-keep-me');
    assert.equal(repo.getSettings().dataSources.stockUS.apiKey, 'fh-keep-me');
    assert.equal(repo.getSettings().persona, 'steady');

    // 空库再清一次是安全幂等的。
    assert.equal(repo.clearAllData().deleted, 0);

    // `keepSettings: false` → 恢复出厂默认（Key 全清、定时任务关闭）。
    const reset = repo.clearAllData({ keepSettings: false });
    assert.equal(reset.settingsReset, true);
    const fresh = repo.getSettings();
    assert.equal(fresh.llm.apiKey, '');
    assert.equal(fresh.dataSources.stockUS.apiKey, undefined, '出厂默认的数据源槽位不含 Key');
    assert.equal(fresh.persona, DEFAULT_PERSONA);
    assert.deepEqual(fresh.schedules, [], '恢复出厂后不保留任何定时任务');
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ───────────────────────────── 期权卖权：持久化 ───────────────────────────── */

test('repo: 期权合约 CRUD、筛选与张数校验', () => {
  const { repo, dir } = tempRepo();
  try {
    const asset = repo.createAsset(newAsset({ code: 'AAPL', market: 'US', type: 'stock', currency: 'USD' }));
    const us = repo.createOptionContract(
      newOptionContract({
        id: 'oc-us',
        underlyingAssetId: asset.id,
        expiry: '2026-11-20',
        openedAt: '2026-10-03T10:00:00.000+08:00',
      }),
    );
    repo.createOptionContract(
      newOptionContract({
        id: 'oc-hk',
        market: 'HK',
        underlyingCode: '00700',
        underlyingName: '腾讯',
        currency: 'HKD',
        optionCode: 'TCH-20261230-660-C',
        expiry: '2026-12-30',
        openedAt: '2026-10-01T10:00:00.000+08:00',
      }),
    );
    repo.createOptionContract(
      newOptionContract({ id: 'oc-old', status: 'expired_otm', expiry: '2026-10-01', openedAt: '2026-09-01T10:00:00.000+08:00' }),
    );

    // 写入的行原样读回（snake_case ↔ camelCase 映射无误）
    assert.equal(us.contracts, 1);
    assert.equal(us.multiplier, 100);
    assert.equal(us.premiumIncome, 349);
    assert.equal(us.collateralKind, 'shares');
    assert.equal(us.status, 'open');
    assert.equal(us.closedAt, null);
    assert.equal(us.closePrice, null);
    assert.equal(us.realizedPnl, null);

    // 默认按 opened_at DESC；`all` 与不传等价（含已到期/已平仓的历史）
    assert.deepEqual(
      repo.listOptionContracts().map((row) => row.id),
      ['oc-us', 'oc-hk', 'oc-old'],
    );
    assert.equal(repo.listOptionContracts({ status: 'all' }).length, 3);
    assert.deepEqual(
      repo.listOptionContracts({ status: 'open' }).map((row) => row.id),
      ['oc-us', 'oc-hk'],
    );
    assert.deepEqual(
      repo.listOptionContracts({ market: 'HK' }).map((row) => row.id),
      ['oc-hk'],
    );
    assert.deepEqual(
      repo.listOptionContracts({ underlyingAssetId: asset.id }).map((row) => row.id),
      ['oc-us'],
    );
    // 到期扫描器：只取 status='open' 且到期日已过的；显式传 status 时以调用方为准。
    assert.deepEqual(
      repo.listOptionContracts({ expiringOnOrBefore: '2026-11-30' }).map((row) => row.id),
      ['oc-us'],
    );
    assert.deepEqual(
      repo.listOptionContracts({ status: 'all', expiringOnOrBefore: '2026-11-30' }).map((row) => row.id),
      ['oc-us', 'oc-old'],
    );

    // 平仓：三列可写，updated_at 自动前移
    const closed = repo.updateOptionContract('oc-us', {
      status: 'closed',
      closedAt: '2026-10-20T10:00:00.000+08:00',
      closePrice: 1.2,
      realizedPnl: 229,
      note: '提前买平',
    });
    assert.equal(closed?.status, 'closed');
    assert.equal(closed?.closedAt, '2026-10-20T10:00:00.000+08:00');
    assert.equal(closed?.closePrice, 1.2);
    assert.equal(closed?.realizedPnl, 229);
    assert.equal(closed?.note, '提前买平');
    assert.notEqual(closed?.updatedAt, us.updatedAt);
    assert.equal(repo.updateOptionContract('nope', { status: 'closed' }), undefined);
    assert.equal(repo.getOptionContract('nope'), undefined);

    // 张数必须是正整数：小数会被 SQLite 静默截断，导致权利金与担保额对不上 → 拒绝。
    for (const bad of [1.5, 0, -2, Number.NaN]) {
      assert.throws(
        () => repo.createOptionContract(newOptionContract({ contracts: bad })),
        (error: unknown) => error instanceof AppError && error.statusCode === 400,
        `contracts=${String(bad)} 必须被拒绝`,
      );
    }
    assert.equal(repo.createOptionContract(newOptionContract({ contracts: 3 })).contracts, 3);

    // 删合约连带删结算，不留悬挂记录
    repo.upsertOptionSettlement(newOptionSettlement('oc-hk'));
    assert.equal(repo.listOptionSettlements({ status: 'all' }).length, 1);
    assert.equal(repo.deleteOptionContract('oc-hk'), true);
    assert.equal(repo.listOptionSettlements({ status: 'all' }).length, 0);
    assert.equal(repo.deleteOptionContract('oc-hk'), false);
    assert.equal(repo.getOptionContract('oc-hk'), undefined);
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repo: 删除标的资产保留期权合约，只解绑 underlyingAssetId', () => {
  const { repo, dir } = tempRepo();
  try {
    const asset = repo.createAsset(newAsset({ code: 'AAPL', market: 'US', type: 'stock', currency: 'USD' }));
    const bound = repo.createOptionContract(
      newOptionContract({ id: 'oc-bound', underlyingAssetId: asset.id, underlyingCode: 'AAPL' }),
    );
    repo.upsertOptionSettlement(newOptionSettlement('oc-bound', { id: 'st-bound', assetId: asset.id }));
    assert.equal(bound.underlyingAssetId, asset.id);
    assert.equal(repo.findOptionSettlementByContract('oc-bound')?.assetId, asset.id, '结算行先绑定到该资产');

    assert.equal(repo.deleteAsset(asset.id), true);
    assert.equal(repo.findAsset('AAPL', 'US', 'stock'), undefined, '资产本身已删除');

    // 卖出的期权是真实义务：合约与结算记录都必须活着，只是解绑资产引用。
    const after = repo.getOptionContract('oc-bound');
    assert.ok(after, '期权合约不得随资产级联删除');
    assert.equal(after?.underlyingAssetId, null, 'underlying_asset_id 必须置空');
    assert.equal(after?.status, 'open');
    assert.equal(after?.contracts, 1);
    // 冗余字段仍在：解绑后标的代码/名称不丢。
    assert.equal(after?.underlyingCode, 'AAPL');
    assert.equal(after?.underlyingName, '苹果');
    // 交割结算行同样保留，只解绑 asset_id（与合约对称）。
    const settlement = repo.findOptionSettlementByContract('oc-bound');
    assert.equal(settlement?.id, 'st-bound', '结算记录不受影响');
    assert.equal(settlement?.assetId, null, 'settlement.asset_id 必须置空');
    assert.equal(settlement?.realizedPnl, 349, '结算结论本身不动');

    // 不相关的合约不动。
    const other = repo.createOptionContract(newOptionContract({ id: 'oc-other', underlyingCode: 'MSFT' }));
    assert.equal(repo.getOptionContract(other.id)?.underlyingAssetId, null);
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repo: upsertOptionSettlement 按 contract_id 幂等；advice 的 instrument / option_plan 往返', () => {
  const { repo, dir } = tempRepo();
  try {
    repo.createOptionContract(newOptionContract({ id: 'oc-1' }));
    const first = repo.upsertOptionSettlement(newOptionSettlement('oc-1', { id: 'st-1', note: '首次扫描' }));
    const second = repo.upsertOptionSettlement(
      newOptionSettlement('oc-1', { id: 'st-2', status: 'pending_review', verdict: 'uncertain', note: '重扫' }),
    );
    assert.equal(repo.listOptionSettlements({ status: 'all' }).length, 1, '同一合约只能有一条结算');
    assert.equal(first.id, 'st-1');
    assert.equal(second.id, 'st-1', '重扫复用首条 id，不产生第二条');
    assert.equal(second.note, '重扫');
    assert.equal(second.status, 'pending_review');
    assert.equal(second.verdict, 'uncertain');
    assert.equal(second.createdAt, first.createdAt, '重扫不改首条 created_at');
    assert.equal(repo.findOptionSettlementByContract('oc-1')?.id, 'st-1');
    assert.equal(repo.findOptionSettlementByContract('nope'), undefined);

    // 筛选：status / contractId / expiry
    repo.createOptionContract(newOptionContract({ id: 'oc-2', expiry: '2026-12-30' }));
    repo.upsertOptionSettlement(
      newOptionSettlement('oc-2', { id: 'st-2', expiry: '2026-12-30', status: 'dismissed', action: 'pending' }),
    );
    assert.deepEqual(
      repo.listOptionSettlements({ status: 'all' }).map((row) => row.id).sort(),
      ['st-1', 'st-2'],
    );
    assert.deepEqual(
      repo.listOptionSettlements({ status: 'pending_review' }).map((row) => row.id),
      ['st-1'],
    );
    assert.deepEqual(
      repo.listOptionSettlements({ contractId: 'oc-2' }).map((row) => row.id),
      ['st-2'],
    );
    assert.deepEqual(
      repo.listOptionSettlements({ expiry: '2026-12-30' }).map((row) => row.id),
      ['st-2'],
    );

    const patched = repo.updateOptionSettlement('st-2', {
      status: 'confirmed',
      action: 'shares_delivered',
      transactionId: 'tx-9',
      assetId: 'asset-9',
      realizedPnl: -1200,
    });
    assert.equal(patched?.status, 'confirmed');
    assert.equal(patched?.action, 'shares_delivered');
    assert.equal(patched?.transactionId, 'tx-9');
    assert.equal(patched?.assetId, 'asset-9');
    assert.equal(patched?.realizedPnl, -1200);
    assert.equal(repo.updateOptionSettlement('nope', { status: 'confirmed' }), undefined);

    // advice：instrument 默认 stock；卖权建议带 optionPlan，读回是解析后的对象
    const plain = repo.createAdvice(newAdvice({ id: 'adv-stock' }));
    assert.equal(plain.instrument, 'stock');
    assert.equal(plain.option, null);
    const opt = repo.createAdvice(
      newAdvice({ id: 'adv-opt', action: 'sell', instrument: 'option', code: 'AAPL', optionPlan: samplePlan() }),
    );
    assert.equal(opt.instrument, 'option');
    assert.equal(opt.action, 'sell');
    assert.equal(opt.option?.optionCode, 'AAPL261120C00250000');
    assert.equal(opt.option?.metrics.premiumIncome, 349);
    assert.deepEqual(repo.getAdvice('adv-opt')?.option, samplePlan());

    // 清空/改写方案：null → 空串落库 → 读回 null（`option_plan` 是 NOT NULL 列）
    assert.equal(repo.updateAdvice('adv-opt', { option: null })?.option, null);
    assert.equal(repo.getAdvice('adv-opt')?.option, null);
    assert.equal(repo.updateAdvice('adv-opt', { instrument: 'stock' })?.instrument, 'stock');
    assert.equal(repo.updateAdvice('adv-opt', { option: samplePlan({ strike: 260 }) })?.option?.strike, 260);
    assert.equal(repo.updateAdvice('nope', { instrument: 'option' }), undefined);
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repo: advice.option_plan 空串读回 null，坏 JSON 不抛也不会拖垮列表', () => {
  const { repo, dir } = tempRepo();
  const dbPath = path.join(dir, 'advisor.db');
  const adviceId = 'adv-raw';
  try {
    repo.createAdvice(newAdvice({ id: adviceId }));
    assert.equal(repo.getAdvice(adviceId)?.option, null, '空串必须映射成 null（不能 JSON.parse 空串）');
  } finally {
    repo.close();
  }
  // 直接改库，模拟半截写入 / 手工改坏的数据。
  const raw = new DatabaseSync(dbPath);
  raw.prepare('UPDATE advice SET option_plan = ? WHERE id = ?').run('{"strategy":', adviceId);
  raw.close();
  const reopened = createRepo(dbPath);
  reopened.migrate();
  try {
    assert.equal(reopened.getAdvice(adviceId)?.option, null, '坏 JSON 降级成 null 而不是抛错');
    assert.equal(reopened.listAdvice().length, 1, '一条脏数据不得影响列表读取');
  } finally {
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backup service: 期权合约/结算与 option 设置往返，source=option 不被降级', () => {
  const { repo, dir } = tempRepo();
  const target = tempRepo();
  try {
    const asset = repo.createAsset(newAsset({ code: 'AAPL', market: 'US', type: 'stock', currency: 'USD' }));
    repo.createAdvice(newAdvice({ id: 'adv-opt', action: 'sell', instrument: 'option', code: 'AAPL', optionPlan: samplePlan() }));
    repo.createOptionContract(newOptionContract({ id: 'oc-1', underlyingAssetId: asset.id, adviceId: 'adv-opt' }));
    repo.upsertOptionSettlement(
      newOptionSettlement('oc-1', {
        id: 'st-1',
        status: 'confirmed',
        verdict: 'assigned',
        action: 'shares_delivered',
        transactionId: 'tx-opt',
      }),
    );
    // 到期交割流水：source='option' 必须原样往返，否则恢复后被静默降级成 manual。
    repo.addTransaction(newTx(asset.id, { id: 'tx-opt', kind: 'sell', shares: 100, price: 250, source: 'option' }));
    repo.saveSettings(
      settingsPatch({ option: { cash: { HK: 12000, US: 5000 }, settlementMode: 'manual', runWithPipeline: false } }),
    );

    const payload = buildBackupPayload(repo);
    assert.equal(payload.optionContracts?.length, 1);
    assert.equal(payload.optionSettlements?.length, 1);
    assert.equal(payload.optionContracts?.[0]?.premiumIncome, 349);
    assert.equal(payload.optionContracts?.[0]?.settlement?.status, 'confirmed', '合约自带结算结论');
    assert.equal(payload.optionSettlements?.[0]?.priceSource, 'cboe-close');
    assert.equal(payload.settings?.option.cash.HK, 12000);
    assert.equal(payload.settings?.option.settlementMode, 'manual');
    assert.equal(payload.settings?.option.runWithPipeline, false);
    assert.equal(payload.transactions.find((tx) => tx.id === 'tx-opt')?.source, 'option');

    const result = importBackupPayload(target.repo, payload, 'merge');
    assert.equal(result.optionContracts, 1);
    assert.equal(result.optionSettlements, 1);
    const restored = target.repo.getOptionContract('oc-1');
    assert.equal(restored?.premiumIncome, 349);
    assert.equal(restored?.adviceId, 'adv-opt');
    assert.equal(restored?.underlyingAssetId, asset.id);
    assert.equal(restored?.status, 'open');
    const restoredSettlement = target.repo.findOptionSettlementByContract('oc-1');
    assert.equal(restoredSettlement?.verdict, 'assigned');
    assert.equal(restoredSettlement?.transactionId, 'tx-opt');
    assert.equal(target.repo.getAdvice('adv-opt')?.instrument, 'option', '导入不得把卖权建议退化成股票建议');
    assert.equal(target.repo.getAdvice('adv-opt')?.option?.optionCode, 'AAPL261120C00250000');
    assert.equal(target.repo.listTransactions().find((tx) => tx.id === 'tx-opt')?.source, 'option');
    assert.deepEqual(target.repo.getSettings().option, {
      cash: { HK: 12000, US: 5000 },
      settlementMode: 'manual',
      runWithPipeline: false,
    });

    // 幂等：同一 payload 再导入一次不产生第二份
    const again = importBackupPayload(target.repo, payload, 'merge');
    assert.equal(again.optionContracts, 0);
    assert.equal(again.optionSettlements, 0);
    assert.equal(target.repo.listOptionContracts({ status: 'all' }).length, 1);
    assert.equal(target.repo.listOptionSettlements({ status: 'all' }).length, 1);

    // 老备份（完全没有期权字段）：按空数组处理，不报错、不清空已有期权数据。
    const legacy = { ...payload, optionContracts: undefined, optionSettlements: undefined };
    const validated = validateBackupPayload(legacy);
    assert.equal(validated.optionContracts, undefined);
    const legacyResult = importBackupPayload(target.repo, legacy, 'merge');
    assert.equal(legacyResult.optionContracts, 0);
    assert.equal(legacyResult.optionSettlements, 0);
    assert.equal(target.repo.listOptionContracts({ status: 'all' }).length, 1, '缺字段的老备份不得清掉期权持仓');

    // 半截 option 设置：缺的字段保持现值，只覆盖给出的市场现金。
    const partial = {
      ...payload,
      settings: { ...payload.settings!, option: { cash: { US: 777 } } },
    };
    importBackupPayload(target.repo, partial, 'merge');
    assert.deepEqual(target.repo.getSettings().option, {
      cash: { HK: 12000, US: 777 },
      settlementMode: 'manual',
      runWithPipeline: false,
    });
  } finally {
    repo.close();
    target.repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(target.dir, { recursive: true, force: true });
  }
});
