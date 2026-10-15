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

import { DEFAULT_DATA_SOURCES, DEFAULT_LLM, DEFAULT_PERSONA } from '@aia/shared';

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
import type { NewAdvice, NewAsset, NewTx, NewWatch } from '../src/types/models.js';

function tempRepo(): { repo: Repo; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-repo-'));
  const repo = createRepo(path.join(dir, 'advisor.db'));
  repo.migrate();
  return { repo, dir };
}

let counter = 0;
const uid = (): string => `${(counter += 1).toString().padStart(4, '0')}-${crypto.randomUUID()}`;

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
    action: over.action ?? 'buy',
    targetShares: over.targetShares ?? 10,
    targetPrice: over.targetPrice ?? 100,
    currency: over.currency ?? 'USD',
    reason: over.reason ?? '业绩超预期',
    confidence: over.confidence ?? 0.7,
    status: over.status ?? 'pending',
    createdAt: over.createdAt ?? '2026-10-01T10:00:00.000+08:00',
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
    assert.equal(settings.schedule.mode, 'off');
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
        schedule: { mode: 'daily', dailyTime: '07:15' },
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
    assert.equal(saved.schedule.mode, 'daily');
    assert.equal(saved.schedule.dailyTime, '07:15');

    const reloaded = repo.getSettings();
    assert.deepEqual(reloaded.dataSources, saved.dataSources);
    assert.equal(reloaded.llm.apiKey, 'sk-secret-0001');
    assert.equal(reloaded.schedule.dailyTime, '07:15');

    // Clearing the key.
    assert.equal(repo.saveSettings(settingsPatch({ llm: { apiKey: '' } })).llm.apiKey, '');
  } finally {
    repo.close();
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

    const bundle = source.repo.exportAll();
    assert.equal(bundle.assets.length, 1);
    assert.equal(bundle.transactions.length, 2);
    assert.equal(bundle.watchlist.length, 1);
    assert.equal(bundle.advice.length, 1);

    const merged = target.repo.importAll(bundle, 'merge');
    assert.deepEqual(merged, {
      assets: 1,
      transactions: 2,
      watchlist: 1,
      advice: 1,
      skipped: 0,
      mode: 'merge',
    });

    // Round-trip equality of the durable fields.
    assert.deepEqual(target.repo.exportAll(), bundle);

    // Importing again is a no-op thanks to id-based dedup.
    const again = target.repo.importAll(bundle, 'merge');
    assert.equal(again.assets, 0);
    assert.equal(again.transactions, 0);
    assert.equal(again.skipped, 5);

    // Invalid rows are skipped, valid ones still land.
    const dirty = target.repo.importAll(
      {
        assets: [{ ...bundle.assets[0]!, id: 'broken', code: '', market: 'CN', type: 'stock' } as never],
        transactions: [{ ...bundle.transactions[0]!, id: 'orphan', assetId: 'nope' } as never],
        watchlist: [],
        advice: [],
      },
      'merge',
    );
    assert.equal(dirty.assets, 0);
    assert.equal(dirty.transactions, 0);
    assert.equal(dirty.skipped, 2);

    // `replace` wipes whatever is there first.
    replaced.repo.createAsset(newAsset({ code: 'JUNK' }));
    replaced.repo.createWatchItem(newWatch({ code: 'JUNKW' }));
    const result = replaced.repo.importAll(bundle, 'replace');
    assert.equal(result.mode, 'replace');
    assert.equal(result.assets, 1);
    assert.equal(replaced.repo.listAssets().length, 1);
    assert.equal(replaced.repo.findAsset('JUNK', 'CN', 'stock'), undefined);
    assert.equal(replaced.repo.listWatchlist().length, 1);
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
    repo.saveSettings(
      settingsPatch({ llm: { apiKey: 'sk-keep-me' }, persona: 'steady', dataSources: { stockUS: { apiKey: 'fh-keep-me' } } }),
    );
    repo.saveSettings(settingsPatch({ lastRunAt: '2026-10-01T10:00:00.000+08:00' }));

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
      settingsReset: false,
      deleted: 13,
    });

    // 每张表都真的空了。
    assert.deepEqual(repo.exportAll(), { assets: [], transactions: [], watchlist: [], advice: [] });
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
    assert.equal(fresh.schedule.mode, 'off');
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
