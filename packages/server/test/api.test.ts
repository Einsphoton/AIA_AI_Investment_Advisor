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
import { setServices } from '../src/registry.js';
import type { AgentRuntime } from '../src/types/agent.js';
import type { Repo } from '../src/types/repo.js';
import type { BackupPayload } from '@aia/shared';

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

  // merge into the same database → everything deduped.
  const merge = json(await app.inject({ method: 'POST', url: '/api/backup/import', payload: { data: payload, mode: 'merge' } }));
  assert.equal(merge.mode, 'merge');
  assert.equal(merge.assets, 0);
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
  assert.equal(body.settingsReset, false);
  assert.ok(body.deleted >= body.assets + body.transactions + body.watchlist + body.runs);

  assert.deepEqual(repo.exportAll(), { assets: [], transactions: [], watchlist: [], advice: [] });
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

  // 可选：恢复出厂设置（清空 Key、定时任务回 off）。
  const reset = json(await app.inject({ method: 'POST', url: '/api/backup/clear', payload: { keepSettings: false } }));
  assert.equal(reset.settingsReset, true);
  const fresh = json(await app.inject({ method: 'GET', url: '/api/settings' }));
  assert.equal(fresh.hasApiKey, false);
  assert.equal(fresh.apiKeyMasked, '');
  assert.equal(fresh.persona, 'balanced');
  assert.equal(fresh.schedule.mode, 'off');
  assert.ok(!JSON.stringify(fresh).includes(RAW_API_KEY), '响应中不得出现明文 API Key');
});
