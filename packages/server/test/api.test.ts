/**
 * HTTP API tests — settings masking, assets/transactions, watchlist, advice,
 * dashboard, backup. Runs the real Fastify assembly (`buildApp`) against a
 * temporary SQLite database with an agent stub.
 *
 * Owner: server-core.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';

import { createRepo } from '../src/db/repo.js';
import { config } from '../src/config.js';
import { setServices } from '../src/registry.js';
import type { AgentRuntime } from '../src/types/agent.js';
import type { Repo } from '../src/types/repo.js';
import { DEFAULT_OPTION_SETTINGS, type BackupPayload } from '@aia/shared';

const RAW_API_KEY = 'sk-test1234abcd';

let app: FastifyInstance;
let repo: Repo;
let dataDir: string;

const now = new Date();
const MONTH = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const day = (n: number): string => `${MONTH}-${String(n).padStart(2, '0')}`;

const stubAgent: AgentRuntime = {
  isConfigured: () => false,
  tools: () => [],
  run: async () => {
    throw new Error('agent runtime stub (not part of this test)');
  },
  resume: async () => {
    throw new Error('agent runtime stub (not part of this test)');
  },
};

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-api-'));
  process.env.AIA_OFFLINE = '1';
  const { buildApp } = await import('../src/app.js');

  repo = createRepo(path.join(dataDir, 'advisor.db'));
  repo.migrate();
  setServices({ repo, agent: stubAgent });
  app = await buildApp({ serveWeb: false });
});

after(async () => {
  await app?.close();
  repo?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const json = (res: { body: string }): any => JSON.parse(res.body);

/* ─────────────── 版本 / 构建标识（前端左上角徽标的数据源） ─────────────── */

test('version: /api/version 返回运行中的构建标识，版本号来自根 package.json', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/version' });
  assert.equal(res.statusCode, 200);
  const payload = json(res);
  const rootVersion = (
    JSON.parse(fs.readFileSync(path.join(config.appRoot, 'package.json'), 'utf8')) as { version: string }
  ).version;

  assert.equal(payload.ok, true);
  assert.equal(payload.version, rootVersion, '版本号必须等于根 package.json（唯一来源）');
  assert.match(payload.commit, /^([0-9a-f]{7,40}|unknown)$/, 'commit 必须是短哈希或 unknown');
  assert.ok(typeof payload.branch === 'string' && payload.branch.length > 0, 'branch 不能为空');
  assert.ok(typeof payload.environment === 'string' && payload.environment.length > 0);
  assert.equal(payload.node, process.version);
  assert.ok(Number.isFinite(payload.uptimeSeconds) && payload.uptimeSeconds >= 0);
  assert.ok(!Number.isNaN(Date.parse(payload.startedAt)), 'startedAt 必须是可解析的 ISO 时间');
  assert.ok(Date.parse(payload.startedAt) <= Date.now(), '启动时间不能在未来');
});

test('health: 带上 commit/builtAt，部署核查不用再发第二个请求', async () => {
  const health = json(await app.inject({ method: 'GET', url: '/api/health' }));
  const version = json(await app.inject({ method: 'GET', url: '/api/version' }));
  assert.equal(health.ok, true);
  assert.equal(health.version, version.version);
  assert.equal(health.commit, version.commit);
  assert.equal(health.builtAt, version.builtAt);
});

test('settings: 掩码返回，绝不泄漏明文；apiKey 省略/null/字符串 三态', async () => {
  const initial = json(await app.inject({ method: 'GET', url: '/api/settings' }));
  assert.equal(initial.hasApiKey, false);
  assert.equal(initial.apiKeyMasked, '');
  assert.equal(initial.llm.apiKey, '');
  assert.equal('apiKey' in initial.llm, true);

  const set = await app.inject({ method: 'PUT', url: '/api/settings', payload: { apiKey: RAW_API_KEY } });
  assert.equal(set.statusCode, 200);
  const setBody = json(set);
  assert.equal(setBody.hasApiKey, true);
  assert.equal(setBody.apiKeyMasked, 'sk-****abcd');
  assert.equal(setBody.llm.apiKey, '');
  assert.ok(!set.body.includes(RAW_API_KEY), '响应中不得出现明文 API Key');
  assert.equal(repo.getSettings().llm.apiKey, RAW_API_KEY, '明文只存 SQLite');

  const readBack = json(await app.inject({ method: 'GET', url: '/api/settings' }));
  assert.equal(readBack.hasApiKey, true);
  assert.equal(readBack.apiKeyMasked, 'sk-****abcd');
  assert.ok(!readBack.llm.apiKey);

  // 期权卖权设置：DTO 必须带 option，PUT 只覆盖给出的字段（未传的保持不变）。
  assert.deepEqual(readBack.option, DEFAULT_OPTION_SETTINGS);
  const optionPatched = json(
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { option: { cash: { US: 3000 }, settlementMode: 'manual' } },
    }),
  );
  assert.equal(optionPatched.option.cash.US, 3000);
  assert.equal(optionPatched.option.cash.HK, DEFAULT_OPTION_SETTINGS.cash.HK, '未传的市场现金保持不变');
  assert.equal(optionPatched.option.settlementMode, 'manual');
  assert.equal(optionPatched.option.runWithPipeline, DEFAULT_OPTION_SETTINGS.runWithPipeline);
  assert.equal(repo.getSettings().option.cash.US, 3000, '期权现金设置真的落库');
  // 还原，避免影响后续用例对默认值的假设。
  await app.inject({ method: 'PUT', url: '/api/settings', payload: { option: { cash: { US: 0 }, settlementMode: 'auto' } } });

  // Omitted → keep; empty string → keep; null → clear.
  const keep = json(await app.inject({ method: 'PUT', url: '/api/settings', payload: { llm: { model: 'deepseek-reasoner' } } }));
  assert.equal(keep.hasApiKey, true);
  assert.equal(keep.llm.model, 'deepseek-reasoner');
  assert.equal(keep.llm.baseUrl, 'https://api.deepseek.com/v1', '未传字段保持默认值');

  const blank = json(await app.inject({ method: 'PUT', url: '/api/settings', payload: { apiKey: '' } }));
  assert.equal(blank.hasApiKey, true, '空字符串表示保持不变');

  const cleared = json(await app.inject({ method: 'PUT', url: '/api/settings', payload: { apiKey: null } }));
  assert.equal(cleared.hasApiKey, false);
  assert.equal(cleared.apiKeyMasked, '');

  const merged = json(
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { persona: 'value', budget: { US: 2000 } } }),
  );
  assert.equal(merged.persona, 'value');
  assert.equal(merged.budget.US, 2000);
  assert.equal(merged.budget.CN, 5000, '未传的预算市场保持不变');

  const catalogue = json(await app.inject({ method: 'GET', url: '/api/settings/data-sources' }));
  assert.equal(catalogue.slots.length, 6);
  assert.ok(Array.isArray(catalogue.providers) && catalogue.providers.length > 0);
  assert.ok(catalogue.slots.every((slot: any) => Array.isArray(slot.options) && 'label' in slot));

  const bad = await app.inject({ method: 'PUT', url: '/api/settings', payload: { persona: 'nope' } });
  assert.equal(bad.statusCode, 400);
  assert.equal(json(bad).error.code, 'BAD_REQUEST');
});

test('S1: 数据源槽位 API Key 绝不明文外泄（settings / data-sources / 备份）', async () => {
  const slotKey = 'sk-SLOT-LEAK-999';
  const webKey = 'tvly-SEARCH-LEAK';
  const llmKey = 'sk-TEST-LEAK-123456';

  const saved = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: {
      dataSources: {
        stockUS: { provider: 'finnhub', enabled: true, apiKey: slotKey },
        webSearch: { provider: 'tavily', enabled: true, apiKey: webKey },
      },
      llm: { apiKey: llmKey },
    },
  });
  assert.equal(saved.statusCode, 200);
  assert.ok(!saved.body.includes('LEAK'), 'PUT 响应不得包含明文 Key');
  assert.equal(json(saved).dataSources.stockUS.apiKey, undefined);
  assert.equal(json(saved).dataSources.stockUS.hasApiKey, true);
  assert.equal(json(saved).dataSources.stockUS.enabled, true);
  assert.equal(json(saved).dataSources.stockUS.provider, 'finnhub');
  assert.ok(json(saved).dataSources.stockUS.apiKeyMasked.length > 0);

  // The secret is still stored server-side (it must keep working).
  const stored = repo.getSettings();
  assert.equal(stored.dataSources.stockUS.apiKey, slotKey);
  assert.equal(stored.dataSources.webSearch.apiKey, webKey);
  assert.equal(stored.llm.apiKey, llmKey);

  const settings = json(await app.inject({ method: 'GET', url: '/api/settings' }));
  assert.ok(!JSON.stringify(settings).includes('LEAK'), 'GET /api/settings 不得包含明文 Key');
  assert.equal(settings.dataSources.webSearch.hasApiKey, true);
  assert.equal(settings.dataSources.webSearch.apiKey, undefined);
  assert.equal(settings.dataSources.stockCN.hasApiKey, false);
  assert.equal(settings.dataSources.stockCN.apiKey, undefined);
  assert.equal(settings.hasApiKey, true);
  assert.equal(settings.llm.apiKey, '');

  const catalogue = await app.inject({ method: 'GET', url: '/api/settings/data-sources' });
  assert.ok(!catalogue.body.includes('LEAK'), 'GET /api/settings/data-sources 不得包含明文 Key');
  const catalogueBody = json(catalogue);
  const usSlot = catalogueBody.slots.find((slot: any) => slot.slot === 'stockUS');
  assert.equal(usSlot.current.apiKey, undefined);
  assert.equal(usSlot.current.hasApiKey, true);
  assert.equal(usSlot.current.provider, 'finnhub');
  assert.equal(catalogueBody.webSearch.apiKey, undefined);
  assert.equal(catalogueBody.webSearch.hasApiKey, true);

  const exported = await app.inject({ method: 'GET', url: '/api/backup/export' });
  assert.ok(!exported.body.includes('LEAK'), '备份导出不得包含明文 Key');
  assert.equal(json(exported).settings.dataSources.stockUS.apiKey, undefined);
  assert.equal(json(exported).settings.dataSources.stockUS.hasApiKey, true);

  // Round-tripping the masked DTO back must NOT wipe the stored keys.
  const roundTrip = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { dataSources: settings.dataSources },
  });
  assert.equal(roundTrip.statusCode, 200);
  assert.equal(repo.getSettings().dataSources.stockUS.apiKey, slotKey, '掩码对象回传不得清空 Key');
  assert.equal(repo.getSettings().llm.apiKey, llmKey);
  assert.ok(!roundTrip.body.includes('LEAK'));

  // '' = keep, null = clear (per-slot tri-state).
  const keep = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { dataSources: { webSearch: { apiKey: '' } } },
  });
  assert.equal(keep.statusCode, 200);
  assert.equal(repo.getSettings().dataSources.webSearch.apiKey, webKey, '空串表示保持不变');

  const cleared = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { dataSources: { webSearch: { apiKey: null } } },
  });
  assert.equal(cleared.statusCode, 200);
  assert.equal(repo.getSettings().dataSources.webSearch.apiKey, '');
  assert.equal(json(cleared).dataSources.webSearch.hasApiKey, false);
  assert.equal(json(cleared).dataSources.stockUS.hasApiKey, true, '其他槽位不受影响');
  assert.ok(!cleared.body.includes('LEAK'));
});

test('D4: 掩码串不能作为 API Key 保存（400，且不破坏已存 Key）', async () => {
  const real = 'fh-REAL-KEY-1234';
  const seeded = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { dataSources: { stockUS: { provider: 'finnhub', enabled: true, apiKey: real } } },
  });
  assert.equal(seeded.statusCode, 200);
  assert.equal(repo.getSettings().dataSources.stockUS.apiKey, real);

  const masked = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { dataSources: { stockUS: { apiKey: '****' } } },
  });
  assert.equal(masked.statusCode, 400);
  assert.equal(json(masked).error.code, 'BAD_REQUEST');
  assert.match(json(masked).error.message, /掩码值不能作为 API Key 保存/);
  assert.equal(repo.getSettings().dataSources.stockUS.apiKey, real, '原有真 Key 未被破坏');

  // The LLM key is guarded the same way (`sk-****abcd` is a preview, not a key).
  const llmBefore = repo.getSettings().llm.apiKey;
  const maskedLlm = await app.inject({ method: 'PUT', url: '/api/settings', payload: { apiKey: 'sk-****abcd' } });
  assert.equal(maskedLlm.statusCode, 400);
  assert.equal(repo.getSettings().llm.apiKey, llmBefore);

  // A genuine new key is still accepted.
  const updated = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { dataSources: { stockUS: { apiKey: 'fh-NEW-KEY-5678' } } },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(repo.getSettings().dataSources.stockUS.apiKey, 'fh-NEW-KEY-5678');
});

test('D2: budget=0 表示本月不投（exhausted=true、usedPct=100）', async () => {
  await app.inject({ method: 'PUT', url: '/api/settings', payload: { budget: { HK: 0 } } });

  const before = json(await app.inject({ method: 'GET', url: '/api/budget' }));
  const hkBefore = before.markets.find((item: any) => item.market === 'HK');
  assert.equal(hkBefore.budget, 0);
  assert.equal(hkBefore.spent, 0);
  assert.equal(hkBefore.remaining, 0);
  assert.equal(hkBefore.exhausted, true, '正零预算即视为用尽');
  assert.equal(hkBefore.usedPct, 100);

  const bought = await app.inject({
    method: 'POST',
    url: '/api/assets',
    payload: { code: 'HKZERO', market: 'HK', type: 'stock', shares: 10, price: 10, tradeDate: day(1) },
  });
  assert.equal(bought.statusCode, 200);

  const after = json(await app.inject({ method: 'GET', url: '/api/budget' }));
  const hkAfter = after.markets.find((item: any) => item.market === 'HK');
  assert.equal(hkAfter.spent, 100);
  assert.equal(hkAfter.remaining, -100);
  assert.equal(hkAfter.exhausted, true);
  assert.equal(hkAfter.usedPct, 100);

  // Normal regression: a funded market still reports precisely.
  await app.inject({ method: 'PUT', url: '/api/settings', payload: { budget: { HK: 1000 } } });
  const funded = json(await app.inject({ method: 'GET', url: '/api/budget' }));
  const hkFunded = funded.markets.find((item: any) => item.market === 'HK');
  assert.equal(hkFunded.spent, 100);
  assert.equal(hkFunded.remaining, 900);
  assert.equal(hkFunded.usedPct, 10);
  assert.equal(hkFunded.exhausted, false);
});

test('D1: 建议确认复用账本一致性校验（倒填/超卖 → 409）', async () => {
  const offsetDay = (offset: number): string => {
    const date = new Date(now);
    date.setDate(date.getDate() + offset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const sellAdvice = (over: Record<string, unknown> = {}): string => {
    const id = crypto.randomUUID();
    repo.createAdvice({
      id,
      batchId: 'batch-d1',
      assetId: null,
      watchItemId: null,
      assetName: 'DCONF1',
      code: 'DCONF1',
      market: 'CN',
      type: 'stock',
      action: 'sell',
      targetShares: 1,
      targetPrice: 100,
      currency: 'CNY',
      reason: 'D1 校验',
      confidence: 0.5,
      status: 'pending',
      createdAt: new Date().toISOString(),
      ...over,
    });
    return id;
  };

  const created = await app.inject({
    method: 'POST',
    url: '/api/assets',
    payload: { code: 'DCONF1', market: 'CN', type: 'stock', shares: 10, price: 100, tradeDate: offsetDay(0) },
  });
  assert.equal(created.statusCode, 200);
  const asset = json(created);

  // 场景 1：倒填到买入之前 → 409，账本与建议都不变。
  const backdatedId = sellAdvice({ assetId: asset.id });
  const backdated = await app.inject({
    method: 'POST',
    url: `/api/advice/${backdatedId}/confirm`,
    payload: { shares: 1, price: 100, tradeDate: offsetDay(-30) },
  });
  assert.equal(backdated.statusCode, 409);
  assert.equal(json(backdated).error.code, 'CONFLICT');
  assert.match(json(backdated).error.message, /该卖出日期早于可用持仓形成时间/);

  const ledger = json(await app.inject({ method: 'GET', url: `/api/assets/${asset.id}` }));
  assert.equal(ledger.transactions.length, 1, '被拒的确认不得写入交易');
  assert.equal(ledger.shares, 10);
  assert.equal(ledger.realizedPnl, 0);
  assert.equal(repo.getAdvice(backdatedId)?.status, 'pending', '被拒的确认不得改建议状态');

  // 场景 2：超卖 20 > 持仓 10 → 409（不是 400）。
  const overId = sellAdvice({ targetShares: 20 });
  const over = await app.inject({
    method: 'POST',
    url: `/api/advice/${overId}/confirm`,
    payload: { shares: 20, price: 100, tradeDate: offsetDay(0) },
  });
  assert.equal(over.statusCode, 409);
  assert.equal(json(over).error.code, 'CONFLICT');
  assert.match(json(over).error.message, /超过当前持仓/);

  // 场景 3：正常买入确认 → 200，持仓 10 + 5。
  const buyId = crypto.randomUUID();
  repo.createAdvice({
    id: buyId,
    batchId: 'batch-d1',
    assetId: asset.id,
    watchItemId: null,
    assetName: 'DCONF1',
    code: 'DCONF1',
    market: 'CN',
    type: 'stock',
    action: 'buy',
    targetShares: 5,
    targetPrice: 100,
    currency: 'CNY',
    reason: 'D1 买入',
    confidence: 0.6,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
  const bought = await app.inject({
    method: 'POST',
    url: `/api/advice/${buyId}/confirm`,
    payload: { shares: 5, price: 100, tradeDate: offsetDay(0) },
  });
  assert.equal(bought.statusCode, 200);
  assert.equal(json(bought).asset.shares, 15);
  assert.equal(json(bought).advice.status, 'confirmed');

  // 合法的部分卖出确认仍然放行。
  const okSellId = sellAdvice({ assetId: asset.id, targetShares: 5 });
  const okSell = await app.inject({
    method: 'POST',
    url: `/api/advice/${okSellId}/confirm`,
    payload: { shares: 5, price: 110, tradeDate: offsetDay(1) },
  });
  assert.equal(okSell.statusCode, 200);
  assert.equal(json(okSell).asset.shares, 10);

  // Cleanup: keep later absolute-count assertions (month spend / pending advice)
  // independent of this test's fixture data.
  repo.deleteAsset(asset.id);
  for (const id of [backdatedId, overId, okSellId]) repo.updateAdvice(id, { status: 'rejected' });
});

test('market/financials: 参数校验 + ETF 走「不适用」而不是报错（离线可测）', async () => {
  const missingCode = await app.inject({ method: 'GET', url: '/api/market/financials?market=CN' });
  assert.equal(missingCode.statusCode, 400);

  const badMarket = await app.inject({ method: 'GET', url: '/api/market/financials?market=XX&code=600519' });
  assert.equal(badMarket.statusCode, 400);

  const badPeriods = await app.inject({ method: 'GET', url: '/api/market/financials?market=CN&code=600519&periods=99' });
  assert.equal(badPeriods.statusCode, 400);
  const floatPeriods = await app.inject({ method: 'GET', url: '/api/market/financials?market=CN&code=600519&periods=4.5' });
  assert.equal(floatPeriods.statusCode, 400);

  // ETF 没有公司财报：判定为「不适用」（200 + applicable:false），不是 502。
  const etf = await app.inject({ method: 'GET', url: '/api/market/financials?market=US&code=SCHD&type=etf' });
  assert.equal(etf.statusCode, 200);
  const body = json(etf);
  assert.equal(body.applicable, false);
  assert.deepEqual(body.statements, []);
  assert.equal(body.currency, 'USD');
  assert.ok(body.warnings.length > 0, '不适用时必须给出原因');

  const fund = await app.inject({ method: 'GET', url: '/api/market/financials?market=CN&code=000001&type=fund' });
  assert.equal(fund.statusCode, 200);
  assert.equal(json(fund).applicable, false);
});

test('assets: 建仓写首笔买入、摊薄成本、超卖 409、CRUD 与预算', async () => {
  await app.inject({ method: 'PUT', url: '/api/settings', payload: { budget: { CN: 5000, HK: 5000, US: 1000 } } });

  const created = await app.inject({
    method: 'POST',
    url: '/api/assets',
    payload: { code: '600519', market: 'CN', type: 'stock', name: '贵州茅台', shares: 100, price: 10, tradeDate: day(2) },
  });
  assert.equal(created.statusCode, 200);
  const asset = json(created);
  assert.equal(asset.shares, 100);
  assert.equal(asset.avgCost, 10);
  assert.equal(asset.cost, 1000);
  assert.equal(asset.currency, 'CNY');
  assert.equal(asset.closed, false);
  assert.equal(asset.transactions.length, 1, '建仓时写入第一条 buy 交易');
  assert.equal(asset.transactions[0].kind, 'buy');
  assert.equal(asset.transactions[0].amount, 1000);

  const duplicate = await app.inject({
    method: 'POST',
    url: '/api/assets',
    payload: { code: '600519', market: 'CN', type: 'stock', shares: 1, price: 1, tradeDate: day(2) },
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(json(duplicate).error.code, 'CONFLICT');

  const secondBuy = await app.inject({
    method: 'POST',
    url: `/api/assets/${asset.id}/transactions`,
    payload: { kind: 'buy', shares: 100, price: 20, tradeDate: day(3) },
  });
  assert.equal(secondBuy.statusCode, 200);
  const diluted = json(secondBuy);
  assert.equal(diluted.shares, 200);
  assert.equal(diluted.avgCost, 15);
  assert.equal(diluted.cost, 3000);
  assert.equal(diluted.firstBuyAt, day(2));
  assert.equal(diluted.lastBuyAt, day(3));

  const partialSell = await app.inject({
    method: 'POST',
    url: `/api/assets/${asset.id}/transactions`,
    payload: { kind: 'sell', shares: 50, price: 25, tradeDate: day(4), fee: 1 },
  });
  assert.equal(partialSell.statusCode, 200);
  const afterSell = json(partialSell);
  assert.equal(afterSell.shares, 150);
  assert.equal(afterSell.avgCost, 15);
  assert.equal(afterSell.realizedPnl, 500);
  assert.equal(afterSell.lastSellAt, day(4));

  const oversell = await app.inject({
    method: 'POST',
    url: `/api/assets/${asset.id}/transactions`,
    payload: { kind: 'sell', shares: 1000, price: 25, tradeDate: day(5) },
  });
  // Sell conflicts are now uniformly 409 (ledger state conflict, docs/API.md §0).
  assert.equal(oversell.statusCode, 409);
  assert.equal(json(oversell).error.code, 'CONFLICT');
  assert.match(json(oversell).error.message, /超过当前持仓/);

  const badBody = await app.inject({
    method: 'POST',
    url: `/api/assets/${asset.id}/transactions`,
    payload: { kind: 'buy', shares: 0, price: 25, tradeDate: day(5) },
  });
  assert.equal(badBody.statusCode, 400);

  const list = json(await app.inject({ method: 'GET', url: `/api/assets?market=CN&q=${encodeURIComponent('茅台')}` }));
  assert.equal(list.total, 1);
  assert.equal(list.items[0].shares, 150);
  assert.equal(list.items[0].code, '600519');

  const filteredOut = json(await app.inject({ method: 'GET', url: '/api/assets?market=US' }));
  assert.equal(filteredOut.total, 0);

  const detail = json(await app.inject({ method: 'GET', url: `/api/assets/${asset.id}` }));
  assert.equal(detail.transactions.length, 3);

  const updated = await app.inject({
    method: 'PUT',
    url: `/api/assets/${asset.id}`,
    payload: { name: '贵州茅台(改名)', note: '长期持有' },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(json(updated).name, '贵州茅台(改名)');
  assert.equal(json(updated).code, '600519');
  assert.equal(json(updated).note, '长期持有');

  const missing = await app.inject({ method: 'GET', url: '/api/assets/does-not-exist' });
  assert.equal(missing.statusCode, 404);

  // Budget (contract): spent = buy turnover only; sells do NOT release budget.
  const budget = json(await app.inject({ method: 'GET', url: '/api/budget' }));
  assert.equal(budget.month, MONTH);
  const cn = budget.markets.find((item: any) => item.market === 'CN');
  assert.equal(cn.currency, 'CNY');
  assert.equal(cn.budget, 5000);
  assert.equal(cn.spent, 3000, '100@10 + 100@20，卖出不释放');
  assert.equal(cn.remaining, 2000);
  assert.equal(cn.usedPct, 60);
  assert.equal(cn.exhausted, false);
  const us = budget.markets.find((item: any) => item.market === 'US');
  assert.equal(us.spent, 0);

  // Deleting the sell keeps the ledger consistent (buys 200 ≥ 0).
  const txId = detail.transactions.find((tx: any) => tx.kind === 'sell').id;
  const afterDelete = await app.inject({ method: 'DELETE', url: `/api/assets/${asset.id}/transactions/${txId}` });
  assert.equal(afterDelete.statusCode, 200);
  assert.equal(json(afterDelete).shares, 200);
  assert.equal(json(afterDelete).realizedPnl, 0);

  const tx404 = await app.inject({ method: 'DELETE', url: `/api/assets/${asset.id}/transactions/nope` });
  assert.equal(tx404.statusCode, 404);
});

test('倒填日期的卖出被 409 拒绝（时间轴为负的账本）', async () => {
  const past = (offsetDays: number): string => {
    const date = new Date(now);
    date.setDate(date.getDate() + offsetDays);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };

  // 场景 A：今日买入 10，倒填到 10 天前卖出 5 → 409，且未落库。
  const created = await app.inject({
    method: 'POST',
    url: '/api/assets',
    payload: { code: 'BACKDATE', market: 'CN', type: 'stock', shares: 10, price: 100, tradeDate: past(0) },
  });
  assert.equal(created.statusCode, 200);
  const asset = json(created);

  const backdated = await app.inject({
    method: 'POST',
    url: `/api/assets/${asset.id}/transactions`,
    payload: { kind: 'sell', shares: 5, price: 120, tradeDate: past(-10) },
  });
  assert.equal(backdated.statusCode, 409);
  assert.equal(json(backdated).error.code, 'CONFLICT');
  assert.match(json(backdated).error.message, /该卖出日期早于可用持仓形成时间/);
  assert.match(json(backdated).error.message, /当时仅有 0 份/);

  const untouched = json(await app.inject({ method: 'GET', url: `/api/assets/${asset.id}` }));
  assert.equal(untouched.shares, 10);
  assert.equal(untouched.realizedPnl, 0);
  assert.equal(untouched.transactions.length, 1, '被拒交易不得落库');

  // 场景 B：正常的次日卖出 → 200，realizedPnl = (120-100)*5 = 100。
  const normal = await app.inject({
    method: 'POST',
    url: `/api/assets/${asset.id}/transactions`,
    payload: { kind: 'sell', shares: 5, price: 120, tradeDate: past(1) },
  });
  assert.equal(normal.statusCode, 200);
  assert.equal(json(normal).shares, 5);
  assert.equal(json(normal).realizedPnl, 100);

  // 场景 C：同日多笔按 createdAt 排序重放。
  const sameDay = json(
    await app.inject({
      method: 'POST',
      url: '/api/assets',
      payload: { code: 'SAME-DAY', market: 'CN', type: 'stock', shares: 10, price: 50, tradeDate: past(0) },
    }),
  );
  for (const [index, shares] of [5, 5].entries()) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/assets/${sameDay.id}/transactions`,
      payload: { kind: 'sell', shares, price: 60, tradeDate: past(0) },
    });
    assert.equal(res.statusCode, 200, `同日第 ${index + 1} 笔卖出应成功`);
  }
  const sameDayAfter = json(await app.inject({ method: 'GET', url: `/api/assets/${sameDay.id}` }));
  assert.equal(sameDayAfter.shares, 0);
  assert.equal(sameDayAfter.realizedPnl, 100);

  const oneMore = await app.inject({
    method: 'POST',
    url: `/api/assets/${sameDay.id}/transactions`,
    payload: { kind: 'sell', shares: 1, price: 60, tradeDate: past(0) },
  });
  assert.equal(oneMore.statusCode, 409, '持仓已清零后同日再卖必须 409');

  // 买入不受影响（可倒填/加仓）。
  const buy = await app.inject({
    method: 'POST',
    url: `/api/assets/${sameDay.id}/transactions`,
    payload: { kind: 'buy', shares: 3, price: 55, tradeDate: past(-5) },
  });
  assert.equal(buy.statusCode, 200);
  assert.equal(json(buy).shares, 3);

  // 部分被覆盖的卖出：持有 10（今日），卖出 15 → 合计校验 409。
  const overTotal = await app.inject({
    method: 'POST',
    url: `/api/assets/${asset.id}/transactions`,
    payload: { kind: 'sell', shares: 15, price: 130, tradeDate: past(2) },
  });
  assert.equal(overTotal.statusCode, 409);
  assert.match(json(overTotal).error.message, /超过当前持仓/);
});

test('交易日必须是真实日历日期（含闰年）', async () => {
  const invalid = ['2026-13-45', '2026-02-30', '2026-04-31', '2026-00-00', '2026-99-99', '2026-10-32', '2026-02-29'];
  for (const [index, tradeDate] of invalid.entries()) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/assets',
      payload: { code: `BAD${index}`, market: 'CN', type: 'stock', shares: 1, price: 1, tradeDate },
    });
    assert.equal(res.statusCode, 400, `${tradeDate} 应被拒绝`);
    assert.equal(json(res).error.code, 'BAD_REQUEST');
  }

  const leap = await app.inject({
    method: 'POST',
    url: '/api/assets',
    payload: { code: 'LEAP2028', market: 'CN', type: 'stock', shares: 1, price: 1, tradeDate: '2028-02-29' },
  });
  assert.equal(leap.statusCode, 200, '2028-02-29 是闰年日期');

  const normal = await app.inject({
    method: 'POST',
    url: '/api/assets',
    payload: { code: 'FEB28', market: 'CN', type: 'stock', shares: 1, price: 1, tradeDate: '2026-02-28' },
  });
  assert.equal(normal.statusCode, 200);

  // The same validation applies to transactions and advice confirmation.
  const badTx = await app.inject({
    method: 'POST',
    url: `/api/assets/${json(leap).id}/transactions`,
    payload: { kind: 'buy', shares: 1, price: 1, tradeDate: '2026-06-31' },
  });
  assert.equal(badTx.statusCode, 400);
});

test('删除交易：会产生无对应持仓卖出的买入删除被 409 拒绝', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/assets',
    payload: { code: 'REPLAY1', market: 'CN', type: 'stock', shares: 10, price: 100, tradeDate: day(2) },
  });
  assert.equal(created.statusCode, 200);
  const asset = json(created);
  const buyTx = asset.transactions[0].id;

  const sold = await app.inject({
    method: 'POST',
    url: `/api/assets/${asset.id}/transactions`,
    payload: { kind: 'sell', shares: 8, price: 120, tradeDate: day(3) },
  });
  assert.equal(sold.statusCode, 200);
  assert.equal(json(sold).realizedPnl, 160);
  const sellTx = json(sold).transactions.find((tx: any) => tx.kind === 'sell').id;

  const rejected = await app.inject({ method: 'DELETE', url: `/api/assets/${asset.id}/transactions/${buyTx}` });
  assert.equal(rejected.statusCode, 409);
  assert.equal(json(rejected).error.code, 'CONFLICT');
  assert.match(json(rejected).error.message, /没有对应持仓的卖出/);

  const stillThere = json(await app.inject({ method: 'GET', url: `/api/assets/${asset.id}` }));
  assert.equal(stillThere.transactions.length, 2, '被拒绝时不得删除任何交易');
  assert.equal(stillThere.realizedPnl, 160);

  // Removing the sell first, then the buy, is consistent and must succeed.
  assert.equal(
    (await app.inject({ method: 'DELETE', url: `/api/assets/${asset.id}/transactions/${sellTx}` })).statusCode,
    200,
  );
  const buyGone = await app.inject({ method: 'DELETE', url: `/api/assets/${asset.id}/transactions/${buyTx}` });
  assert.equal(buyGone.statusCode, 200);
  assert.equal(json(buyGone).transactions.length, 0);
  assert.equal(json(buyGone).realizedPnl, 0);

  // A buy that is only partially covered can also be removed.
  const partial = json(
    await app.inject({
      method: 'POST',
      url: '/api/assets',
      payload: { code: 'REPLAY2', market: 'CN', type: 'stock', shares: 10, price: 100, tradeDate: day(2) },
    }),
  );
  const addBuy = await app.inject({
    method: 'POST',
    url: `/api/assets/${partial.id}/transactions`,
    payload: { kind: 'buy', shares: 10, price: 110, tradeDate: day(3) },
  });
  assert.equal(addBuy.statusCode, 200);
  await app.inject({
    method: 'POST',
    url: `/api/assets/${partial.id}/transactions`,
    payload: { kind: 'sell', shares: 5, price: 120, tradeDate: day(4) },
  });
  const removable = json(addBuy).transactions.find((tx: any) => tx.price === 110).id;
  assert.equal(
    (await app.inject({ method: 'DELETE', url: `/api/assets/${partial.id}/transactions/${removable}` })).statusCode,
    200,
    '未被卖出覆盖的加仓可以删除',
  );
});

test('watchlist: 新增/筛选/补全/更新/详情/清空', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/watchlist',
    payload: { code: '00700', market: 'HK', type: 'stock', name: '腾讯控股', note: '观察' },
  });
  assert.equal(created.statusCode, 200);
  const item = json(created);
  assert.equal(item.name, '腾讯控股');
  assert.equal(item.market, 'HK');
  assert.equal(item.price, 0, '无行情源时价格占位为 0');
  assert.equal(item.initialPriceAt, null);

  const duplicate = await app.inject({
    method: 'POST',
    url: '/api/watchlist',
    payload: { code: '00700', market: 'HK', type: 'stock' },
  });
  assert.equal(duplicate.statusCode, 409);

  const hkList = json(await app.inject({ method: 'GET', url: '/api/watchlist?market=HK&sort=qualityScore&dir=desc' }));
  assert.equal(hkList.total, 1);

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/watchlist/${item.id}`,
    payload: {
      qualityScore: 80,
      targetPrice: 400,
      expectedReturn: 25,
      expectedReturnHorizon: '6-12 个月',
      thesis: '社交护城河',
    },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(json(patched).qualityScore, 80);
  assert.equal(json(patched).targetPrice, 400);
  assert.equal(json(patched).expectedReturnHorizon, '6-12 个月', '预期期限必须随标的一起往返');
  assert.equal(json(patched).thesis, '社交护城河');

  const tooLongHorizon = await app.inject({
    method: 'PATCH',
    url: `/api/watchlist/${item.id}`,
    payload: { expectedReturnHorizon: 'x'.repeat(41) },
  });
  assert.equal(tooLongHorizon.statusCode, 400, '期限超过 40 字应被拒绝');

  const invalid = await app.inject({
    method: 'PATCH',
    url: `/api/watchlist/${item.id}`,
    payload: { qualityScore: 300 },
  });
  assert.equal(invalid.statusCode, 400);

  const detail = json(await app.inject({ method: 'GET', url: `/api/watchlist/${item.id}` }));
  assert.equal(detail.holding, null, '未持有该标的时 holding 为 null');
  assert.deepEqual(detail.transactions, []);
  assert.deepEqual(detail.dividends, []);

  const deleted = await app.inject({ method: 'DELETE', url: `/api/watchlist/${item.id}` });
  assert.equal(deleted.statusCode, 200);
  assert.equal(json(deleted).ok, true);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/watchlist/${item.id}` })).statusCode, 404);

  await app.inject({ method: 'POST', url: '/api/watchlist', payload: { code: '000001', market: 'CN', type: 'stock' } });
  await app.inject({ method: 'POST', url: '/api/watchlist', payload: { code: '000002', market: 'CN', type: 'stock' } });
  const cleared = json(await app.inject({ method: 'DELETE', url: '/api/watchlist' }));
  assert.equal(cleared.ok, true);
  assert.equal(cleared.deleted, 2);
  assert.equal(json(await app.inject({ method: 'GET', url: '/api/watchlist' })).total, 0);
});

test('watchlist: 行情刷新接口（离线时如实降级，不伪造 0 涨跌）', async () => {
  await app.inject({ method: 'POST', url: '/api/watchlist', payload: { code: '600519', market: 'CN', type: 'stock' } });
  const refreshed = await app.inject({ method: 'POST', url: '/api/watchlist/refresh' });
  assert.equal(refreshed.statusCode, 200);
  const body = json(refreshed);
  // 测试环境 AIA_OFFLINE=1：行情源不可用 → updated=0、failed=N，并给出 warning。
  assert.equal(body.updated, 0);
  assert.equal(body.failed, 1);
  assert.ok(Array.isArray(body.warnings) && body.warnings.length > 0, '数据源不可用必须给出 warning');

  const item = json(await app.inject({ method: 'GET', url: '/api/watchlist' })).items[0];
  assert.equal(item.price, 0, '离线时不得写入任何价格');
  assert.equal(item.changeSinceAddedPct, 0, '没有行情时推荐后涨跌为 0（而不是编造数值）');
  await app.inject({ method: 'DELETE', url: '/api/watchlist' });
});

test('advice: 列表+预算、驳回、确认写入交易', async () => {
  const buyAdviceId = crypto.randomUUID();
  repo.createAdvice({
    id: buyAdviceId,
    batchId: 'batch-test',
    assetId: null,
    watchItemId: null,
    assetName: '苹果',
    code: 'AAPL',
    market: 'US',
    type: 'stock',
    action: 'buy',
    targetShares: 10,
    targetPrice: 100,
    currency: 'USD',
    reason: '业绩超预期',
    confidence: 0.8,
    status: 'pending',
    createdAt: `${day(1)}T10:00:00.000+08:00`,
  });
  const rejectId = crypto.randomUUID();
  repo.createAdvice({
    id: rejectId,
    batchId: 'batch-test',
    assetId: null,
    watchItemId: null,
    assetName: '特斯拉',
    code: 'TSLA',
    market: 'US',
    type: 'stock',
    action: 'sell',
    targetShares: 5,
    targetPrice: 200,
    currency: 'USD',
    reason: '估值过高',
    confidence: 0.5,
    status: 'pending',
    createdAt: `${day(1)}T10:05:00.000+08:00`,
  });

  const list = json(await app.inject({ method: 'GET', url: '/api/advice?status=pending' }));
  assert.equal(list.items.length, 2);
  assert.equal(list.budget.month, MONTH);
  assert.equal(list.budget.markets.length, 3);
  assert.equal(list.items[0].amount, 1000, 'amount = targetShares × targetPrice');
  // 每条建议都带 instrument/option：界面与确认流程据此分流（股票写流水 / 期权写持仓）。
  assert.ok(
    list.items.every((item: { instrument?: string; option?: unknown }) => item.instrument === 'stock' && item.option === null),
    '股票建议的 instrument=stock 且没有卖权方案',
  );

  const rejected = await app.inject({ method: 'POST', url: `/api/advice/${rejectId}/reject` });
  assert.equal(rejected.statusCode, 200);
  assert.equal(json(rejected).status, 'rejected');
  assert.ok(json(rejected).decidedAt);
  assert.equal((await app.inject({ method: 'POST', url: `/api/advice/${rejectId}/reject` })).statusCode, 409);

  const confirmed = await app.inject({
    method: 'POST',
    url: `/api/advice/${buyAdviceId}/confirm`,
    payload: { shares: 8, price: 105, tradeDate: day(6), fee: 2 },
  });
  assert.equal(confirmed.statusCode, 200);
  const payload = json(confirmed);
  assert.equal(payload.advice.status, 'confirmed');
  assert.equal(payload.advice.executedShares, 8);
  assert.equal(payload.advice.executedPrice, 105);
  assert.equal(payload.asset.shares, 8);
  assert.equal(payload.asset.avgCost, 105);
  assert.equal(payload.asset.transactions[0].source, 'advice');
  assert.equal(payload.asset.market, 'US');

  const again = await app.inject({
    method: 'POST',
    url: `/api/advice/${buyAdviceId}/confirm`,
    payload: { shares: 1, price: 1 },
  });
  assert.equal(again.statusCode, 409);

  const notFoundRes = await app.inject({ method: 'POST', url: '/api/advice/nope/reject' });
  assert.equal(notFoundRes.statusCode, 404);
});

test('dashboard: 返回 DashboardPayload 全部字段并降级 indices', async () => {
  await app.inject({
    method: 'POST',
    url: '/api/watchlist',
    payload: { code: '600036', market: 'CN', type: 'stock', name: '招商银行' },
  });

  const first = await app.inject({ method: 'GET', url: '/api/dashboard' });
  assert.equal(first.statusCode, 200);
  const dash = json(first);

  assert.ok(dash.portfolio);
  assert.equal(dash.portfolio.currency, 'CNY');
  assert.equal(typeof dash.portfolio.marketValue, 'number');
  assert.equal(typeof dash.portfolio.realizedPnl, 'number');
  assert.equal(dash.portfolio.fxRates.CNY, 1);
  assert.equal(typeof dash.portfolio.fxRates.USD, 'number');

  // 当年年化（Dashboard 第一行的两个计数）：字段齐备 + 口径说明必须写清 +
  // 不可度量时如实为 null（绝不用 0 冒充）。
  const perf = dash.portfolio.performance;
  assert.ok(perf, 'portfolio.performance 必须存在');
  assert.equal(perf.year, new Date().getFullYear());
  assert.equal(perf.periodStart, `${new Date().getFullYear() - 1}-12-31`);
  assert.match(perf.periodEnd, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Number.isFinite(perf.days) && perf.days >= 0);
  assert.ok(Array.isArray(perf.notes) && perf.notes.length > 0, '口径说明不能为空');
  assert.ok(perf.notes[0].startsWith('口径：XIRR'), `第一条说明必须是口径：${perf.notes[0]}`);
  assert.equal(perf.endingValue, dash.portfolio.marketValue, '期末市值必须与持仓汇总完全一致');
  assert.ok(perf.openingValue === null || typeof perf.openingValue === 'number');
  assert.ok(perf.annualizedPct === null || typeof perf.annualizedPct === 'number');
  assert.ok(perf.realizedAnnualizedPct === null || typeof perf.realizedAnnualizedPct === 'number');
  assert.ok(perf.sinceInceptionPct === null || typeof perf.sinceInceptionPct === 'number');
  assert.ok(perf.sinceInceptionFrom === null || /^\d{4}-\d{2}-\d{2}$/.test(perf.sinceInceptionFrom));
  assert.equal(typeof perf.netInvested, 'number');

  assert.ok(dash.counts.holdings >= 1);
  assert.ok(dash.counts.instruments >= 2);
  assert.ok(dash.counts.watchItems >= 1);
  assert.ok(dash.counts.newWatchItems >= 1);
  assert.equal(typeof dash.counts.pendingAdvice, 'number');
  assert.equal(typeof dash.counts.newAdvice, 'number');
  assert.equal(typeof dash.counts.analysisRuns, 'number');
  assert.equal(dash.counts.lastRunAt, null);

  assert.ok(Array.isArray(dash.topHoldings) && dash.topHoldings.length <= 5);
  assert.ok(dash.topHoldings.every((item: any) => Array.isArray(item.spark)));

  assert.equal(dash.briefing, null, '尚无简报时为 null');
  assert.ok(Array.isArray(dash.indices), 'indices 必须降级为数组而不是 500');
  assert.equal(dash.budget.month, MONTH);
  assert.equal(dash.budget.markets.length, 3);
  assert.equal(dash.signals.watchlistChanged, true, '首次读取视为有变化');
  assert.equal(typeof dash.signals.adviceChanged, 'boolean');
  assert.equal(typeof dash.signals.priceStale, 'boolean');
  assert.equal(dash.signals.scheduleEnabled, false);
  assert.equal(dash.signals.nextRunAt, null);
  assert.ok(dash.updatedAt);

  const second = json(await app.inject({ method: 'GET', url: '/api/dashboard' }));
  assert.equal(second.signals.watchlistChanged, false, '再次读取后标记已清除');

  // Briefing from kv.
  repo.setKv(
    'dashboard.briefing',
    JSON.stringify({ text: '组合偏防御，建议降低美股仓位。', generatedAt: `${day(1)}T09:00:00.000+08:00`, runId: 'run-1' }),
  );
  const withBriefing = json(await app.inject({ method: 'GET', url: '/api/dashboard' }));
  assert.equal(withBriefing.briefing.text, '组合偏防御，建议降低美股仓位。');
  assert.equal(withBriefing.briefing.runId, 'run-1');
  assert.equal(withBriefing.briefing.persona, repo.getSettings().persona);
});

test('backup: 导出剔除 apiKey，导入 merge/replace 往返一致', async () => {
  await app.inject({ method: 'PUT', url: '/api/settings', payload: { apiKey: RAW_API_KEY } });

  const exported = await app.inject({ method: 'GET', url: '/api/backup/export' });
  assert.equal(exported.statusCode, 200);
  assert.match(String(exported.headers['content-disposition']), /attachment; filename=/);
  const payload = json(exported) as BackupPayload;

  assert.equal(payload.schema, 'ai-investment-advisor/backup');
  assert.equal(payload.version, 1);
  assert.equal(typeof payload.exportedAt, 'string');
  assert.ok(payload.assets.length >= 2);
  assert.ok(payload.watchlist.length >= 1);
  assert.ok(payload.settings);
  assert.equal('apiKey' in (payload.settings!.llm as object), false, 'llm.apiKey 不得导出');
  assert.equal(payload.settings!.hasApiKey, true);
  assert.equal(payload.settings!.apiKeyMasked, 'sk-****abcd');
  assert.ok(!exported.body.includes(RAW_API_KEY), '导出内容不得包含明文 Key');
  // 期权卖权：合约/结算进 payload，期权设置随 settings 一起导出（此处还没有期权数据）。
  assert.deepEqual(payload.optionContracts, []);
  assert.deepEqual(payload.optionSettlements, []);
  assert.ok(payload.settings!.option, '期权设置必须出现在备份里');

  // merge into the same database → everything deduped.
  const merge = json(await app.inject({ method: 'POST', url: '/api/backup/import', payload: { data: payload, mode: 'merge' } }));
  assert.equal(merge.mode, 'merge');
  assert.equal(merge.assets, 0);
  assert.equal(merge.optionContracts, 0);
  assert.equal(merge.optionSettlements, 0);
  assert.ok(merge.skipped >= payload.assets.length);

  // Wipe, then restore with replace.
  const assetIds = repo.listAssets().map((asset) => asset.id);
  for (const id of assetIds) repo.deleteAsset(id);
  repo.clearWatchlist();
  assert.equal(repo.listAssets().length, 0);

  const replaced = json(
    await app.inject({ method: 'POST', url: '/api/backup/import', payload: { data: payload, mode: 'replace' } }),
  );
  assert.equal(replaced.mode, 'replace');
  assert.equal(replaced.assets, payload.assets.length);
  assert.equal(replaced.transactions, payload.transactions.length);
  assert.equal(replaced.watchlist, payload.watchlist.length);
  assert.equal(replaced.optionContracts, 0);
  assert.equal(replaced.optionSettlements, 0);

  const restored = repo.listAssets();
  assert.equal(restored.length, payload.assets.length);
  const restoredAsset = restored.find((asset) => asset.code === '600519');
  assert.ok(restoredAsset, '核心持仓已恢复');
  assert.equal(restoredAsset!.spark.length, payload.assets.find((a) => a.code === '600519')!.spark.length);

  const detail = json(await app.inject({ method: 'GET', url: `/api/assets/${restoredAsset!.id}` }));
  assert.equal(detail.transactions.length, 2);
  assert.equal(detail.shares, 200);

  // Settings travelled but the local key survived (never imported).
  assert.equal(repo.getSettings().llm.apiKey, RAW_API_KEY);

  const invalid = await app.inject({ method: 'POST', url: '/api/backup/import', payload: { data: { nope: true } } });
  assert.equal(invalid.statusCode, 400);
});

/**
 * `/api/settings/llm-models` 的端到端测试：用本机 HTTP 桩冒充厂商 `/models`，
 * 校验「带上已保存（或草稿里新填）的 Key → 调 /v1/models → 归一化模型清单」，
 * 以及失败回执不抛 5xx、不泄漏 Key。
 */
test('settings/llm-models: 请求 {baseUrl}/models，沿用已保存 Key 并归一化结果', async () => {
  const seen: { auth: string; url: string }[] = [];
  const stub = http.createServer((req, res) => {
    seen.push({ auth: String(req.headers.authorization ?? ''), url: String(req.url ?? '') });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'model-b' }, { id: 'model-a' }] }));
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const { port } = stub.address() as AddressInfo;
  const stubBase = `http://127.0.0.1:${port}/v1`;

  try {
    const saved = json(await app.inject({ method: 'PUT', url: '/api/settings', payload: { llm: { baseUrl: stubBase } } }));
    assert.equal(saved.hasApiKey, true, '改 Base URL 不应影响已保存的 Key');

    const ok = json(await app.inject({ method: 'POST', url: '/api/settings/llm-models', payload: { baseUrl: stubBase } }));
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.models, ['model-a', 'model-b'], '应去重排序');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/v1/models', '应请求 {baseUrl}/models');
    assert.equal(seen[0].auth, `Bearer ${RAW_API_KEY}`, '省略 apiKey 时应沿用已保存的 Key');
    assert.ok(!JSON.stringify(ok).includes(RAW_API_KEY), '响应不得回显明文 Key');

    await app.inject({
      method: 'POST',
      url: '/api/settings/llm-models',
      payload: { baseUrl: stubBase, apiKey: 'sk-draft-key' },
    });
    assert.equal(seen[1].auth, 'Bearer sk-draft-key', '草稿里新填的 Key 应覆盖已保存的 Key');

    // 厂商返回 401 → 200 + ok:false + 厂商原文，便于前端回退手填。
    const failing = http.createServer((_req, res) => {
      res.statusCode = 401;
      res.end('{"error":"unauthorized"}');
    });
    await new Promise<void>((resolve) => failing.listen(0, '127.0.0.1', resolve));
    const failPort = (failing.address() as AddressInfo).port;
    try {
      const bad = await app.inject({
        method: 'POST',
        url: '/api/settings/llm-models',
        payload: { baseUrl: `http://127.0.0.1:${failPort}` },
      });
      assert.equal(bad.statusCode, 200);
      assert.equal(json(bad).ok, false);
      assert.match(json(bad).message, /401/);
    } finally {
      await new Promise<void>((resolve) => failing.close(() => resolve()));
    }

    // 未配置 Base URL → 400（明确告知，而不是去请求一个空地址）。
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { llm: { baseUrl: '' } } });
    const noUrl = await app.inject({ method: 'POST', url: '/api/settings/llm-models', payload: {} });
    assert.equal(noUrl.statusCode, 400);
  } finally {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
});

/**
 * `/api/settings/diagnose-llm`：按顺序探测并给出一句结论。
 * 用一个本机桩按「模型名」返回不同结果，覆盖可用 / 402 计费 / 401 凭据三种情形。
 */
test('settings/diagnose-llm: 逐项探测并给出结论', async () => {
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      if ((req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }] }));
        return;
      }
      let model = '';
      try {
        model = String((JSON.parse(body) as { model?: string }).model ?? '');
      } catch {
        model = '';
      }
      if (model === 'pay-model') {
        res.writeHead(402, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"Upstream request failed: Insufficient account funds"}}');
        return;
      }
      if (model === 'auth-model') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"Invalid credential"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const { port } = mock.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  try {
    const ok = json(
      await app.inject({
        method: 'POST',
        url: '/api/settings/diagnose-llm',
        payload: { baseUrl, apiKey: 'sk-diagnose', model: 'mock-model' },
      }),
    );
    assert.equal(ok.ok, true);
    assert.match(ok.verdict, /配置可用/);
    assert.deepEqual(
      ok.steps.map((entry: { id: string }) => entry.id),
      ['config', 'models', 'chat'],
      '非 opencode 域名不应出现套餐步骤',
    );
    assert.ok(ok.steps.every((entry: { ok: boolean }) => entry.ok), '全部步骤应通过');
    assert.ok(!JSON.stringify(ok).includes('sk-diagnose'), '诊断结果不得回显 Key');

    const pay = json(
      await app.inject({
        method: 'POST',
        url: '/api/settings/diagnose-llm',
        payload: { baseUrl, apiKey: 'sk-diagnose', model: 'pay-model' },
      }),
    );
    assert.equal(pay.ok, false);
    assert.match(pay.verdict, /额度|余额/);
    assert.match(
      String(pay.steps.find((entry: { id: string }) => entry.id === 'chat')?.detail ?? ''),
      /Insufficient account funds/,
    );

    const auth = json(
      await app.inject({
        method: 'POST',
        url: '/api/settings/diagnose-llm',
        payload: { baseUrl, apiKey: 'sk-diagnose', model: 'auth-model' },
      }),
    );
    assert.equal(auth.ok, false);
    assert.match(auth.verdict, /凭据被拒/);

    // 未配置 Key（且服务端也没有）→ 明确提示，不发起对话请求。
    const noKey = json(
      await app.inject({ method: 'POST', url: '/api/settings/diagnose-llm', payload: { baseUrl, apiKey: null } }),
    );
    assert.equal(noKey.ok, false);
    assert.match(noKey.verdict, /尚未发起对话请求|额度/);
  } finally {
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  }
});

/**
 * 回归：设置页的「测试连接」发送的是**草稿**（顶层 baseUrl/model），
 * 以前服务端只接受 `llm` 包裹的字段，顶层字段被 zod 丢掉，于是「选了新预设但没保存
 * 就点测试」实际测的是上一次保存的旧配置 —— 用户会一直看到旧地址的错误（如 402）。
 */
test('settings/test-llm: 未保存的草稿 baseUrl/model 必须生效', async () => {
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      let model = '';
      try {
        model = String((JSON.parse(body) as { model?: string }).model ?? '');
      } catch {
        model = '';
      }
      if (model === 'draft-model') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
        return;
      }
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"Upstream request failed: Insufficient account funds"}}');
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const { port } = mock.address() as AddressInfo;
  const draftBase = `http://127.0.0.1:${port}/v1`;

  try {
    const ok = json(
      await app.inject({
        method: 'POST',
        url: '/api/settings/test-llm',
        payload: { baseUrl: draftBase, model: 'draft-model', apiKey: 'sk-draft' },
      }),
    );
    assert.equal(ok.ok, true, '草稿 baseUrl/model 必须被采用（否则测的是旧配置）');
    assert.equal(ok.model, 'draft-model');

    const pay = json(
      await app.inject({
        method: 'POST',
        url: '/api/settings/test-llm',
        payload: { baseUrl: draftBase, model: 'other-model', apiKey: 'sk-draft' },
      }),
    );
    assert.equal(pay.ok, false);
    assert.match(pay.message, /402/);
    assert.match(pay.message, /Insufficient account funds/);
  } finally {
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  }
});

/* ── 建议结果追踪（只读接口 + 追踪计数） ─────────────────────────────────── */

test('advice/outcomes: 无追踪结果时返回空列表与零统计，不假装有数据', async () => {
  const body = json(await app.inject({ method: 'GET', url: '/api/advice/outcomes' }));
  assert.deepEqual(body.items, []);
  assert.equal(body.stats.total, 0);
  assert.equal(body.stats.measured, 0);
  assert.equal(body.stats.unmeasured, 0);
  assert.equal(body.stats.winRate, 0);
  assert.equal(body.stats.beatRate, 0);
  assert.equal(body.stats.windowDays, 90, '观测窗口必须显式暴露，否则用户不知道口径');
  assert.equal(body.stats.updatedAt, null, '从未追踪过时 updatedAt 为 null，不能假装有数据');
});

test('advice/outcomes: 物化结果按条返回，统计只吃可度量样本', async () => {
  const adviceId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const advisedAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
  repo.createAdvice({
    id: adviceId,
    batchId: `batch-${runId}`,
    assetId: null,
    watchItemId: null,
    assetName: '紫金矿业',
    code: '601899',
    market: 'CN',
    type: 'stock',
    action: 'buy',
    targetShares: 50,
    targetPrice: 29.98,
    currency: 'CNY',
    reason: '测试用建议',
    confidence: 0.72,
    status: 'pending',
    createdAt: advisedAt,
  });
  repo.upsertAdviceOutcome({
    adviceId,
    runId,
    code: '601899',
    market: 'CN',
    type: 'stock',
    action: 'buy',
    currency: 'CNY',
    advisedAt,
    adviceStatus: 'pending',
    executed: false,
    baselineDate: '2026-10-06',
    baselinePrice: 100,
    lastDate: '2026-10-15',
    lastPrice: 107.5,
    priceChangePct: 7.5,
    adviceReturnPct: 7.5,
    benchmarkCode: '000300',
    benchmarkName: '沪深300指数',
    benchmarkBase: 4000,
    benchmarkChangePct: 2,
    excessPct: 5.5,
    maxReturnPct: 9,
    minReturnPct: -1.5,
    samples: 8,
    daysTracked: 9,
    status: 'tracking',
    warnings: [],
    updatedAt: new Date().toISOString(),
  });

  const body = json(await app.inject({ method: 'GET', url: '/api/advice/outcomes' }));
  const item = body.items.find((row: { adviceId: string }) => row.adviceId === adviceId);
  assert.ok(item, '已落库的结果必须能被接口读回');
  assert.equal(item.code, '601899');
  assert.equal(item.adviceReturnPct, 7.5);
  assert.equal(item.excessPct, 5.5);
  assert.equal(item.benchmarkName, '沪深300指数');
  assert.equal(item.runId, runId, 'runId 由 batch- 前缀反查，保证可回放');
  assert.equal(item.executed, false);
  assert.equal(item.status, 'tracking');

  assert.equal(body.stats.measured, 1);
  assert.equal(body.stats.unmeasured, 0);
  assert.equal(body.stats.winRate, 100);
  assert.equal(body.stats.beatRate, 100);
  assert.equal(body.stats.avgReturnPct, 7.5);
  const cn = body.stats.byMarket.find((row: { market: string }) => row.market === 'CN');
  assert.ok(cn);
  assert.equal(cn.measured, 1);
});

/**
 * 追踪入口的**契约**：200、结构完整、计数自洽。
 *
 * 刻意不断言具体条数：本文件前面的用例已经写入了 advice 行，而追踪器会去取真实
 * 行情序列（离线环境里失败会被降级成 warning），因此这里只钉住「计数内部一致」
 * 与「已落库结果都能读回」这两条与外部数据无关的不变量。
 */
test('advice/outcomes/track: 返回结构完整的追踪计数且计数自洽', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/advice/outcomes/track' });
  assert.equal(res.statusCode, 200, '追踪失败只能降级为 warning，不得 5xx');
  const body = json(res);

  assert.ok(typeof body.tracked.ranAt === 'string' && body.tracked.ranAt.length > 0);
  assert.equal(
    body.tracked.measured + body.tracked.unmeasurable,
    body.tracked.tracked,
    '每条被重算的建议要么可度量、要么不可度量',
  );
  assert.equal(body.stats.total, body.items.length, '统计口径必须覆盖全部已落库结果');
  assert.equal(body.stats.measured + body.stats.unmeasured, body.stats.total);
  assert.equal(typeof body.tracked.pruned, 'number');
  assert.ok(Array.isArray(body.tracked.warnings));

  // 再读一次：GET 与 POST 返回的结果集合必须一致（POST 只是「重算 + 读取」）。
  const readBack = json(await app.inject({ method: 'GET', url: '/api/advice/outcomes' }));
  assert.deepEqual(
    readBack.items.map((row: { adviceId: string }) => row.adviceId).sort(),
    body.items.map((row: { adviceId: string }) => row.adviceId).sort(),
  );
});

/* ───────────────── 一键清除所有数据（设置页「危险操作」） ───────────────── */

/**
 * 本用例会清空整库，因此必须放在文件最后：前面的用例都依赖已写入的数据。
 */
test('backup/clear: 一键清除所有数据（默认保留 AI 配置，可恢复出厂设置）', async () => {
  await app.inject({ method: 'PUT', url: '/api/settings', payload: { apiKey: RAW_API_KEY, persona: 'value' } });
  const bought = await app.inject({
    method: 'POST',
    url: '/api/assets',
    payload: { code: 'CLEARME', market: 'CN', type: 'stock', shares: 10, price: 10, tradeDate: day(1) },
  });
  assert.equal(bought.statusCode, 200);
  const watched = await app.inject({
    method: 'POST',
    url: '/api/watchlist',
    payload: { code: 'CLEARW', market: 'US', type: 'stock' },
  });
  assert.equal(watched.statusCode, 200);
  const session = await app.inject({ method: 'POST', url: '/api/chat/sessions', payload: { title: '清除测试' } });
  assert.equal(session.statusCode, 200);
  repo.addMessage({
    id: crypto.randomUUID(),
    sessionId: json(session).id,
    role: 'user',
    content: '你好',
    toolCalls: null,
    toolCallId: null,
    runId: null,
    createdAt: new Date().toISOString(),
  });
  const runId = crypto.randomUUID();
  repo.createRun({ id: runId, kind: 'custom', status: 'done', target: null, title: '清除测试', startedAt: new Date().toISOString() });
  repo.addStep({ id: crypto.randomUUID(), runId, index: 0, label: '步骤', status: 'done' });
  repo.setKv('clear.test', '1');

  // 期权持仓与到期结算也是用户数据：一键清除必须连带清掉，否则合约悬挂。
  const optionContract = repo.createOptionContract({
    id: crypto.randomUUID(),
    strategy: 'covered_call',
    market: 'US',
    underlyingCode: 'CLEARME',
    underlyingName: '清除测试',
    optionCode: 'CLEARME261218C00010000',
    optionType: 'call',
    strike: 10,
    expiry: '2026-12-18',
    contracts: 1,
    multiplier: 100,
    currency: 'USD',
    premium: 1,
    premiumIncome: 99,
    collateralKind: 'shares',
    collateral: 0,
    status: 'open',
    openedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  repo.upsertOptionSettlement({
    id: crypto.randomUUID(),
    contractId: optionContract.id,
    expiry: optionContract.expiry,
    evaluatedAt: new Date().toISOString(),
    referencePrice: 9,
    priceSource: 'test',
    verdict: 'otm_no_assignment',
    itmAmount: 0,
    itmPct: 0,
    status: 'auto_settled',
    action: 'none',
    realizedPnl: 99,
    createdAt: new Date().toISOString(),
  });

  // 参数非布尔 → 400，且不得清掉任何东西。
  const bad = await app.inject({ method: 'POST', url: '/api/backup/clear', payload: { keepSettings: 'yes' } });
  assert.equal(bad.statusCode, 400);
  assert.equal(json(bad).error.code, 'BAD_REQUEST');
  assert.ok(repo.listAssets().length > 0, '参数校验失败不得清库');

  const cleared = await app.inject({ method: 'POST', url: '/api/backup/clear', payload: {} });
  assert.equal(cleared.statusCode, 200);
  const body = json(cleared);
  assert.ok(body.assets >= 1, '资产必须被清空并计数');
  assert.ok(body.transactions >= 1);
  assert.ok(body.watchlist >= 1);
  assert.ok(body.runs >= 1);
  assert.ok(body.steps >= 1);
  assert.ok(body.chatSessions >= 1);
  assert.ok(body.chatMessages >= 1);
  assert.ok(body.kvEntries >= 1);
  assert.ok(body.optionContracts >= 1, '期权合约必须被清空并计数');
  assert.ok(body.optionSettlements >= 1);
  assert.equal(body.settingsReset, false);
  assert.ok(body.deleted >= body.assets + body.transactions + body.watchlist + body.runs);

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
  assert.equal(repo.listRuns().length, 0);
  assert.equal(repo.listSessions().length, 0);
  assert.equal(repo.listAudit().length, 0);
  assert.equal(repo.getKv('clear.test'), undefined);

  // 默认保留 AI 配置（含 API Key）与投资性格：清完可直接继续用。
  assert.equal(repo.getSettings().llm.apiKey, RAW_API_KEY);
  assert.equal(repo.getSettings().persona, 'value');
  const kept = json(await app.inject({ method: 'GET', url: '/api/settings' }));
  assert.equal(kept.hasApiKey, true, '默认不得清掉 API Key');

  // 空库再清一次是安全幂等的。
  const again = json(await app.inject({ method: 'POST', url: '/api/backup/clear', payload: {} }));
  assert.equal(again.deleted, 0);

  // 可选：恢复出厂设置（清空 Key、定时任务清空）。
  const reset = json(await app.inject({ method: 'POST', url: '/api/backup/clear', payload: { keepSettings: false } }));
  assert.equal(reset.settingsReset, true);
  const fresh = json(await app.inject({ method: 'GET', url: '/api/settings' }));
  assert.equal(fresh.hasApiKey, false);
  assert.equal(fresh.apiKeyMasked, '');
  assert.equal(fresh.persona, 'balanced');
  assert.deepEqual(fresh.schedules, [], '恢复出厂后不保留任何定时任务');
  assert.ok(!JSON.stringify(fresh).includes(RAW_API_KEY), '响应中不得出现明文 API Key');
});

/* ───────────────────────── 远程诊断（/api/diagnostics） ───────────────────── */

test('diagnostics: 一次请求带齐日志/探测/指数现场，且绝不泄漏 Key', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  // 生产现场：push2 / 腾讯 / bing 全挂 —— 报告必须把真实原因写出来。
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    return new Response('<html>502 Bad Gateway</html>', { status: 502 });
  }) as unknown as typeof fetch;
  try {
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { apiKey: RAW_API_KEY } });
    const res = await app.inject({ method: 'GET', url: '/api/diagnostics/report?probe=1&logs=20&runs=5' });
    assert.equal(res.statusCode, 200);
    const body = json(res);

    assert.equal(typeof body.app.version, 'string');
    assert.ok(body.app.version.length > 0);
    assert.equal(typeof body.app.uptimeSec, 'number');
    assert.ok(body.app.dataDir.length > 0);

    // Key 只报「是否已配置」，明文与字段名都不许出现。
    assert.equal(body.llm.keyConfigured, true);
    assert.equal(body.llm.keySource, 'settings');
    assert.ok(!('apiKey' in body.llm), '诊断报告不得包含 apiKey 字段');
    assert.ok(!res.body.includes(RAW_API_KEY), '诊断报告不得出现明文 API Key');

    // 指数失败原因必须可见（这正是「全球指数快照不可用」以前查不到的地方）。
    assert.ok(
      body.indices.warnings.some((warning: string) => /HTTP 502|失败/.test(warning)),
      `指数链路原因必须透出，实际：${JSON.stringify(body.indices.warnings)}`,
    );
    // 社融是已知缺口 → notes；不得再作为 warning 出现。
    assert.ok(body.macro.notes.some((note: string) => note.includes('社会融资规模')));
    assert.ok(!body.macro.warnings.some((warning: string) => warning.includes('社会融资规模')));

    assert.ok(Array.isArray(body.sources) && body.sources.length > 0, 'probe=1 必须返回探测结果');
    assert.ok(calls.length > 0, 'probe=1 必须真的发起探测请求');
    assert.ok(Array.isArray(body.runs));
    assert.ok(Array.isArray(body.logs));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('diagnostics: probe=0 跳过探测；日志接口不会因缓冲为空而失败', async () => {
  const originalFetch = globalThis.fetch;
  // 即便 probe=0，report 仍会实时跑指数/宏观链路 —— 用 502 短路，避免真实联网。
  globalThis.fetch = (async () => new Response('502', { status: 502 })) as unknown as typeof fetch;
  try {
    const res = await app.inject({ method: 'GET', url: '/api/diagnostics/report?probe=0&logs=5' });
    assert.equal(res.statusCode, 200);
    const body = json(res);
    assert.deepEqual(body.sources, [], 'probe=0 不发起探测');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const logs = json(await app.inject({ method: 'GET', url: '/api/diagnostics/logs?limit=5&level=warn' }));
  assert.equal(typeof logs.count, 'number');
  assert.ok(Array.isArray(logs.records));
  for (const record of logs.records) {
    assert.equal(typeof record.at, 'string');
    assert.equal(typeof record.msg, 'string');
  }
});

/* ───────────── 当年年化收益率（XIRR）：端到端真账本重算 ───────────── */

const ISO_DAY = 86_400_000;
const isoOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

test('dashboard: 年化收益率走 XIRR（当年真实现金流 + 期末市值），已实现年化只算当年卖出', async (t) => {
  const todayMs = Date.parse(`${isoOf(Date.now())}T00:00:00Z`);
  const year = new Date().getFullYear();
  const yearStartMs = Date.parse(`${year}-01-01T00:00:00Z`);
  const daysIntoYear = Math.round((todayMs - yearStartMs) / ISO_DAY);
  // 年初那几周没有足够的当年区间，年化会被短期波动放大：跳过数值断言（口径本身仍被上面的用例覆盖）。
  if (daysIntoYear < 45) {
    t.skip(`当前是 ${year} 年第 ${daysIntoYear} 天，当年区间过短，跳过数值断言`);
    return;
  }

  const buyDay = isoOf(yearStartMs + 5 * ISO_DAY); // 当年 1 月 6 日
  // 卖出日固定在 5 天前：这样「卖出份额的持有区间」= daysIntoYear − 10 ≥ 35 天，
  // 够长到允许年化（< 30 天时服务端会拒绝给年化，改给累计收益率）。
  const sellDay = isoOf(todayMs - 5 * ISO_DAY);
  const today = isoOf(todayMs);

  // 建仓：100 股 @10（当年买入 → 期初无持仓，当年年化从这笔现金流起算）。
  const created = await app.inject({
    method: 'POST',
    url: '/api/assets',
    payload: { code: '000778', market: 'CN', type: 'stock', name: '年化测试标的', shares: 100, price: 10, tradeDate: buyDay },
  });
  assert.equal(created.statusCode, 200, created.body);
  const asset = json(created);

  // 卖出 20 股 @12（当年卖出 → 已实现年化可算）。
  const sold = await app.inject({
    method: 'POST',
    url: `/api/assets/${asset.id}/transactions`,
    payload: { kind: 'sell', shares: 20, price: 12, tradeDate: sellDay },
  });
  assert.equal(sold.statusCode, 200, sold.body);

  const dash = json(await app.inject({ method: 'GET', url: `/api/dashboard?asOf=${today}` }));
  const perf = dash.portfolio.performance;

  assert.equal(perf.periodEnd, today, 'asOf 必须可复核（口径固定在指定估值日）');
  assert.equal(perf.year, year);
  assert.equal(perf.openingValue, 0, '当年才建仓 → 期初无持仓，不需要历史行情');
  assert.equal(perf.endingValue, dash.portfolio.marketValue);
  assert.equal(perf.endingValue, 80 * 10, '期末 80 股 × 现价 10');
  assert.equal(perf.netInvested, 100 * 10 - 20 * 12, '净投入 = 买入 1000 − 卖出 240');
  assert.equal(perf.realizedPnl, (12 - 10) * 20, '账本口径已实现盈亏');

  // 当年年化：投入 1000，回收 240 + 期末 800（共 1040）→ 必须为正。
  assert.ok(perf.annualizedPct !== null, `当年年化应可度量：${perf.notes.join(' | ')}`);
  assert.ok(perf.annualizedPct! > 0, `净赚 40 时年化必须为正，实际 ${perf.annualizedPct}`);

  // 已实现年化：-200（20 股成本，锚定买入日）+240（卖出净收入）→ 20% / 持有天数 的几何年化。
  const holdingDays = Math.round((Date.parse(`${sellDay}T00:00:00Z`) - Date.parse(`${buyDay}T00:00:00Z`)) / ISO_DAY);
  const expectedRealized = ((240 / 200) ** (365 / holdingDays) - 1) * 100;
  assert.ok(perf.realizedAnnualizedPct !== null, `已实现年化应可度量：${perf.notes.join(' | ')}`);
  assert.ok(
    Math.abs(perf.realizedAnnualizedPct! - expectedRealized) < 1e-3,
    `已实现年化应为 ${expectedRealized.toFixed(4)}%，实际 ${perf.realizedAnnualizedPct}`,
  );

  assert.equal(typeof perf.sinceInceptionPct, 'number', '全周期年化只用账本，必须可算');
  assert.equal(perf.sinceInceptionFrom, buyDay);
  assert.ok(perf.notes.some((note: string) => note.includes('期初') && note.includes('无持仓')));
  // 累计收益率始终给出（年化不可信时的替代展示）。
  assert.ok(typeof perf.cumulativePct === 'number', '区间累计收益率必须可算');
  assert.equal(perf.annualizedReliable, true, '区间 ≥30 天才允许年化');
  assert.ok(perf.cashFlowDays >= 30, `实际有资金天数应 ≥30，实际 ${perf.cashFlowDays}`);

  // 未来日期一律夹到今天；非法日期忽略。
  const clamped = json(await app.inject({ method: 'GET', url: '/api/dashboard?asOf=2999-01-01' }));
  assert.equal(clamped.portfolio.performance.periodEnd, today, '未来估值日必须夹到今天');
  const ignored = json(await app.inject({ method: 'GET', url: '/api/dashboard?asOf=not-a-date' }));
  assert.equal(ignored.portfolio.performance.periodEnd, today, '非法估值日忽略，退回今天');

  // 估值日设在买入日当天：区间不足 1 天，年化必须为 null（改由累计收益率兜底展示）。
  const sameDay = json(await app.inject({ method: 'GET', url: `/api/dashboard?asOf=${buyDay}` }));
  assert.equal(sameDay.portfolio.performance.annualizedReliable, false);
  assert.equal(sameDay.portfolio.performance.annualizedPct, null, '区间过短不得给年化数字');
});

/* ───────────── 定时任务数组（设置页可添加多个） ───────────── */

test('settings: 定时任务数组 —— 多任务并存、整体替换、非法值被拒', async () => {
  const morning = {
    id: 'sched_morning',
    name: '工作日盘前',
    enabled: true,
    mode: 'daily',
    dailyTime: '08:45',
    runAssetAnalysis: true,
    runWatchlistAnalysis: false,
    runAdvice: true,
  };
  const weekend = {
    id: 'sched_weekend',
    name: '周末挖标的',
    enabled: true,
    mode: 'interval',
    intervalMinutes: 360,
    runAssetAnalysis: false,
    runWatchlistAnalysis: true,
    runAdvice: false,
  };

  const saved = await app.inject({ method: 'PUT', url: '/api/settings', payload: { schedules: [morning, weekend] } });
  assert.equal(saved.statusCode, 200, saved.body);
  const body = json(saved);
  assert.deepEqual(body.schedules.map((task: any) => task.id), ['sched_morning', 'sched_weekend']);
  assert.equal(body.schedules[0].dailyTime, '08:45');
  assert.equal(body.schedules[0].intervalMinutes, 1440, '未传的字段由服务端补默认值');
  assert.equal(body.schedules[1].runAdvice, false);

  const reread = json(await app.inject({ method: 'GET', url: '/api/settings' }));
  assert.deepEqual(reread.schedules, body.schedules, '定时任务必须原样读回');

  // Dashboard 逐个任务给出计划（设置页与首页徽标都读它）。
  const dash = json(await app.inject({ method: 'GET', url: '/api/dashboard' }));
  assert.equal(dash.signals.scheduleEnabled, true);
  assert.equal(dash.signals.nextRuns.length, 2);
  assert.ok(
    dash.signals.nextRuns.every((entry: any) => entry.id && entry.name && !Number.isNaN(Date.parse(entry.nextRunAt))),
  );
  assert.equal(dash.signals.nextRunAt, dash.signals.nextRuns[0].nextRunAt, '最近一次 = 计划里最早的一条');
  const sorted = [...dash.signals.nextRuns].sort((a: any, b: any) => a.nextRunAt.localeCompare(b.nextRunAt));
  assert.deepEqual(dash.signals.nextRuns, sorted, '计划必须按时间升序');

  // 整体替换：只发一个任务 → 另一个消失（不是合并）。
  const replaced = json(await app.inject({ method: 'PUT', url: '/api/settings', payload: { schedules: [weekend] } }));
  assert.deepEqual(replaced.schedules.map((task: any) => task.id), ['sched_weekend']);

  // 空数组 = 删光所有任务。
  const cleared = json(await app.inject({ method: 'PUT', url: '/api/settings', payload: { schedules: [] } }));
  assert.deepEqual(cleared.schedules, []);
  const clearedDash = json(await app.inject({ method: 'GET', url: '/api/dashboard' }));
  assert.equal(clearedDash.signals.scheduleEnabled, false);
  assert.deepEqual(clearedDash.signals.nextRuns, []);

  // 校验：非法时间 / 一个步骤都不选 / id 重复 / 旧的 off 模式，一律 400。
  const badTime = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { schedules: [{ id: 'x', name: 'x', mode: 'daily', dailyTime: '25:99' }] },
  });
  assert.equal(badTime.statusCode, 400, '非法 HH:mm 必须被拒（否则界面显示的时间永远不会跑）');

  const noSteps = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: {
      schedules: [
        { id: 'x', name: 'x', mode: 'daily', runAssetAnalysis: false, runWatchlistAnalysis: false, runIpoAnalysis: false, runAdvice: false },
      ],
    },
  });
  assert.equal(noSteps.statusCode, 400);
  assert.ok(
    json(noSteps).error.details.some((issue: { message: string }) => /至少/.test(issue.message)),
    '必须提示至少选一个步骤',
  );

  const duplicate = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: {
      schedules: [
        { id: 'dup', name: 'a', mode: 'daily' },
        { id: 'dup', name: 'b', mode: 'daily' },
      ],
    },
  });
  assert.equal(duplicate.statusCode, 400);

  const legacyMode = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { schedules: [{ id: 'x', name: 'x', mode: 'off' }] },
  });
  assert.equal(legacyMode.statusCode, 400, '整体 off 模式已被任务自己的 enabled 取代');

  // 省略该字段 = 保持不变（不会因为保存别的设置而清空任务）。
  const keep = json(await app.inject({ method: 'PUT', url: '/api/settings', payload: { schedules: [morning] } }));
  assert.equal(keep.schedules.length, 1);
  const untouched = json(await app.inject({ method: 'PUT', url: '/api/settings', payload: { enforceBudget: true } }));
  assert.equal(untouched.schedules.length, 1, '省略 schedules 时不得改动已保存的任务');
  await app.inject({ method: 'PUT', url: '/api/settings', payload: { schedules: [] } });
});

/* ─────────────── 新股打新：/api/ipo*（列表 / 刷新 / 申购 / 中签入账） ─────────────── */

test('打新：列表是空库友好的结构（counts 全 0、items 空数组），非法过滤值直接 400', async () => {
  const listed = json(await app.inject({ method: 'GET', url: '/api/ipo' }));
  assert.deepEqual(listed.items, []);
  assert.deepEqual(listed.counts, { total: 0, CN: 0, HK: 0, US: 0, subscribing: 0, applied: 0, allotted: 0 });
  assert.equal(listed.lastRefreshAt, null, '从没刷新过时必须是 null，界面据此提示「先刷新」');
  assert.deepEqual(listed.warnings, []);

  const badMarket = await app.inject({ method: 'GET', url: '/api/ipo?market=MOON' });
  assert.equal(badMarket.statusCode, 400);
  assert.equal(json(badMarket).error.code, 'BAD_REQUEST');

  const badStatus = await app.inject({ method: 'GET', url: '/api/ipo?status=whatever' });
  assert.equal(badStatus.statusCode, 400);
});

test('打新：刷新走公开数据源（离线打桩），把标的写进库并记录刷新时间与警告', async () => {
  const originalFetch = globalThis.fetch;
  const { clearHttpCache } = await import('../src/datasources/http.js');
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes('datacenter-web.eastmoney.com')) {
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            data: [
              {
                SECURITY_CODE: '001381',
                APPLY_CODE: '001381',
                SECURITY_NAME_ABBR: '皇冠新材',
                ISSUE_PRICE: 16.98,
                ONLINE_APPLY_UPPER: 13500,
                EACHBALLOT_SHARES: '500',
                APPLY_DATE: '2026-10-19 00:00:00',
                BALLOT_NUM_DATE: '2026-10-21 00:00:00',
                TRADE_MARKET: '深交所主板',
              },
            ],
          },
        }),
        { status: 200 },
      );
    }
    return new Response('<html>502</html>', { status: 502 });
  }) as unknown as typeof fetch;
  clearHttpCache();
  try {
    const refreshed = await app.inject({ method: 'POST', url: '/api/ipo/refresh', payload: { markets: ['CN'] } });
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    const result = json(refreshed);
    assert.equal(result.inserted, 1);
    assert.equal(result.fetched, 1);
    assert.deepEqual(result.sources, ['eastmoney-ipo']);

    const list = json(await app.inject({ method: 'GET', url: '/api/ipo?market=CN' }));
    assert.equal(list.counts.total, 1);
    assert.equal(list.counts.CN, 1);
    assert.equal(list.items[0].code, '001381');
    assert.equal(list.items[0].lotSize, 500);
    assert.ok(list.lastRefreshAt, '刷新后必须能读到 lastRefreshAt');
  } finally {
    globalThis.fetch = originalFetch;
    clearHttpCache();
  }
});

test('打新：手动录入 → 登记申购 → 登记中签自动入账 → 撤销/删除', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/ipo',
    payload: {
      market: 'HK',
      code: '09999',
      name: '接口测试新股',
      issuePrice: 12,
      lotSize: 500,
      maxShares: 5000,
      subscribeEnd: '2000-01-01',
      listingDate: '2999-01-01',
    },
  });
  assert.equal(created.statusCode, 200, created.body);
  const offer = json(created);
  assert.equal(offer.status, 'allotted', '申购已截止但未上市 → 待上市（中签缴款阶段）');
  assert.equal(offer.subscription, null);

  // 参数校验：缺名称 / 市场非法 / 股数非正 → 400。
  for (const payload of [
    { market: 'HK', code: '09999' },
    { market: 'MOON', code: '09999', name: 'x' },
  ]) {
    const bad = await app.inject({ method: 'POST', url: '/api/ipo', payload });
    assert.equal(bad.statusCode, 400, JSON.stringify(payload));
  }
  const badShares = await app.inject({ method: 'POST', url: `/api/ipo/${offer.id}/subscribe`, payload: { shares: 0 } });
  assert.equal(badShares.statusCode, 400);

  const subscribed = await app.inject({
    method: 'POST',
    url: `/api/ipo/${offer.id}/subscribe`,
    payload: { shares: 1000, appliedAt: '2026-10-14' },
  });
  assert.equal(subscribed.statusCode, 200, subscribed.body);
  assert.equal(json(subscribed).subscription.status, 'applied');
  assert.equal(json(subscribed).subscription.appliedShares, 1000);

  const detail = json(await app.inject({ method: 'GET', url: `/api/ipo/${offer.id}` }));
  assert.equal(detail.subscription.appliedShares, 1000);

  const missing = await app.inject({ method: 'GET', url: '/api/ipo/does-not-exist' });
  assert.equal(missing.statusCode, 404);

  // 撤销登记：只删登记，不动账本。
  const removed = await app.inject({ method: 'DELETE', url: `/api/ipo/${offer.id}/subscription` });
  assert.equal(removed.statusCode, 200);
  assert.equal(json(removed).subscription, null);

  // 重新登记后中签 500 股 → 自动建资产 + 写 ipo 买入流水。
  await app.inject({ method: 'POST', url: `/api/ipo/${offer.id}/subscribe`, payload: { shares: 1000 } });
  const allotted = await app.inject({
    method: 'POST',
    url: `/api/ipo/${offer.id}/allot`,
    payload: { shares: 500, tradeDate: '2026-10-16', fee: 12 },
  });
  assert.equal(allotted.statusCode, 200, allotted.body);
  const result = json(allotted);
  assert.equal(result.assetCreated, true);
  assert.equal(result.asset.code, '09999');
  assert.equal(result.asset.shares, 500);
  assert.equal(result.offer.subscription.status, 'allotted');
  assert.equal(result.offer.subscription.assetId, result.asset.id);

  const asset = json(await app.inject({ method: 'GET', url: `/api/assets/${result.asset.id}` }));
  assert.equal(asset.transactions.length, 1, '中签只写一笔买入');
  assert.equal(asset.transactions[0].source, 'ipo', '流水来源必须是 ipo（与人工买入区分）');
  assert.equal(asset.transactions[0].shares, 500);
  assert.equal(asset.transactions[0].fee, 12);

  // 修正中签股数：覆盖而不是累加。
  const corrected = await app.inject({
    method: 'POST',
    url: `/api/ipo/${offer.id}/allot`,
    payload: { shares: 200, tradeDate: '2026-10-16', fee: 12 },
  });
  assert.equal(corrected.statusCode, 200, corrected.body);
  const afterFix = json(await app.inject({ method: 'GET', url: `/api/assets/${result.asset.id}` }));
  assert.equal(afterFix.transactions.length, 1);
  assert.equal(afterFix.transactions[0].shares, 200);

  // 已入账的那只再报「未中签」：必须 409（否则账本会凭空少一笔持仓）。
  const bogusMissed = await app.inject({ method: 'POST', url: `/api/ipo/${offer.id}/allot`, payload: { shares: 0 } });
  assert.equal(bogusMissed.statusCode, 409, '已按中签入账后不能直接改成未中签');
  assert.equal(json(bogusMissed).error.code, 'CONFLICT');
  const afterMissed = json(await app.inject({ method: 'GET', url: `/api/assets/${result.asset.id}` }));
  assert.equal(afterMissed.transactions.length, 1, '被拒的请求不得改动已入账的流水');
  assert.equal(afterMissed.transactions[0].shares, 200);

  // 未中签（另一只新股）：0 股 → 状态变 missed，不建资产、不写流水。
  const other = json(
    await app.inject({
      method: 'POST',
      url: '/api/ipo',
      payload: {
        market: 'HK',
        code: '09998',
        name: '接口测试新股二',
        issuePrice: 5,
        lotSize: 100,
        subscribeEnd: '2000-01-01',
        listingDate: '2999-01-01',
      },
    }),
  );
  await app.inject({ method: 'POST', url: `/api/ipo/${other.id}/subscribe`, payload: { shares: 100 } });
  const missed = await app.inject({ method: 'POST', url: `/api/ipo/${other.id}/allot`, payload: { shares: 0 } });
  assert.equal(missed.statusCode, 200, missed.body);
  assert.equal(json(missed).offer.subscription.status, 'missed');
  assert.equal(json(missed).asset, null, '未中签不得产生资产');
  const missedList = json(await app.inject({ method: 'GET', url: '/api/ipo?market=HK&q=09998' }));
  assert.equal(missedList.items.length, 1);
  assert.equal(missedList.counts.allotted, 0, '未中签不计入「已中签」统计');
  assert.equal(missedList.counts.applied, 1, '未中签仍算「已登记」');

  // 删除标的：连带删掉登记。
  const deleted = await app.inject({ method: 'DELETE', url: `/api/ipo/${offer.id}` });
  assert.equal(deleted.statusCode, 200);
  const gone = await app.inject({ method: 'GET', url: `/api/ipo/${offer.id}` });
  assert.equal(gone.statusCode, 404);
  await app.inject({ method: 'DELETE', url: `/api/ipo/${other.id}` });

  // 资产是用户账本，不该被删除标的顺手抹掉。
  assert.equal((await app.inject({ method: 'GET', url: `/api/assets/${result.asset.id}` })).statusCode, 200);
});

test('打新：分析端点存在，且未配置模型时明确报错（不静默失败）', async () => {
  const last = json(await app.inject({ method: 'GET', url: '/api/ipo/analyze/last' }));
  assert.ok(
    last === null || (typeof last === 'object' && last.kind === 'ipo-analysis'),
    `从没跑过打新分析时必须返回 null（前端据此显示「还没有分析」），实际：${JSON.stringify(last)}`,
  );

  const started = await app.inject({ method: 'POST', url: '/api/ipo/analyze' });
  assert.equal(started.statusCode, 400, 'agent stub 未配置 → 必须 400 而不是挂起');
  assert.equal(json(started).error.code, 'NOT_CONFIGURED');
});

/* ───────────── 自动续跑状态（/api/agent/retry）+ 拒绝重复续跑 ───────────── */

/**
 * 契约：本文件只装配 `buildApp`、从未创建 scheduler，因此 `/api/agent/retry` 必须
 * 返回合法结构（`pending=null`）而不是 500；已被系统自动续跑成功的 run 不允许用户
 * 再手动续跑（409）—— 同一份轨迹再跑一遍只会重复烧 token（见 services/auto-retry.ts）。
 */
test('agent/retry：无调度器时返回 pending=null；已自动续跑成功的 run 拒绝再次续跑', async () => {
  const retry = await app.inject({ method: 'GET', url: '/api/agent/retry' });
  assert.equal(retry.statusCode, 200);
  assert.deepEqual(json(retry), { pending: null, maxAttempts: 3 }, '没有调度器时也必须返回固定上限');

  const runId = crypto.randomUUID();
  repo.createRun({
    id: runId,
    kind: 'asset-analysis',
    status: 'error',
    target: null,
    title: '资产分析',
    error: 'LLM 上游错误（HTTP 502）：Bad Gateway（已自动续跑：第 1/3 次，新运行 abcd1234）',
    startedAt: new Date().toISOString(),
  });

  const resumed = await app.inject({ method: 'POST', url: `/api/agent/runs/${runId}/resume` });
  assert.equal(resumed.statusCode, 409, '已自动续跑成功的 run 再次 resume 必须 409');
  assert.equal(json(resumed).error.code, 'CONFLICT');
  assert.match(json(resumed).error.message, /已由系统自动续跑成功/);

  // 不存在的 run 仍是 404：两种拒绝可区分。
  const missing = await app.inject({ method: 'POST', url: '/api/agent/runs/does-not-exist/resume' });
  assert.equal(missing.statusCode, 404);
});
