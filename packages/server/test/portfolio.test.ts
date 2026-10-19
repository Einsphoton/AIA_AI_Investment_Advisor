/**
 * Portfolio math + budget tests (docs/API.md §4 / §6).
 *
 * Owner: server-core. Pure functions only — no database, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import type { AssetRow, TxRow } from '../src/types/models.js';
import {
  computeBudgetStatus,
  computePosition,
  summarizePortfolio,
  toAdviceItem,
  toAssetSummary,
  toWatchItem,
} from '../src/services/portfolio.js';

function tx(
  kind: 'buy' | 'sell',
  shares: number,
  price: number,
  tradeDate: string,
  assetId = 'a-cn',
  id: string = crypto.randomUUID(),
): TxRow {
  return {
    id,
    assetId,
    kind,
    shares,
    price,
    fee: 0,
    tradeDate,
    note: '',
    source: 'manual',
    createdAt: `${tradeDate}T09:30:00.000+08:00`,
  };
}

function assetRow(over: Partial<AssetRow> = {}): AssetRow {
  return {
    id: 'a-cn',
    name: '测试标的',
    code: '000001',
    market: 'CN',
    type: 'stock',
    source: 'manual',
    currency: 'CNY',
    note: '',
    aiSummary: '',
    aiSummaryAt: null,
    thesis: '',
    qualityScore: 0,
    targetPrice: 0,
    expectedReturn: 0,
    price: 0,
    priceAt: null,
    prevClose: 0,
    dayChangePct: 0,
    spark: [],
    createdAt: '2026-01-01T09:30:00.000+08:00',
    updatedAt: '2026-01-01T09:30:00.000+08:00',
    ...over,
  };
}

test('移动加权平均：多次买入摊薄成本', () => {
  const txs = [tx('buy', 100, 10, '2026-01-02'), tx('buy', 100, 20, '2026-01-05')];
  const position = computePosition(txs);
  assert.equal(position.shares, 200);
  assert.equal(position.avgCost, 15);
  assert.equal(position.cost, 3000);
  assert.equal(position.realizedPnl, 0);
  assert.equal(position.firstBuyAt, '2026-01-02');
  assert.equal(position.lastBuyAt, '2026-01-05');
  assert.equal(position.lastSellAt, null);
});

test('移动加权平均：部分卖出结算已实现盈亏且成本价不变', () => {
  const txs = [
    tx('buy', 100, 10, '2026-01-02'),
    tx('buy', 100, 20, '2026-01-05'),
    tx('sell', 50, 25, '2026-02-01'),
  ];
  const position = computePosition(txs);
  assert.equal(position.shares, 150);
  assert.equal(position.avgCost, 15);
  assert.equal(position.cost, 2250);
  // (25 − 15) × 50
  assert.equal(position.realizedPnl, 500);
  assert.equal(position.lastSellAt, '2026-02-01');
});

test('清仓：cost 归零、已实现盈亏保留、closed=true', () => {
  const txs = [
    tx('buy', 100, 10, '2026-01-02'),
    tx('sell', 60, 12, '2026-02-01'),
    tx('sell', 40, 8, '2026-02-10'),
  ];
  const position = computePosition(txs);
  assert.equal(position.shares, 0);
  assert.equal(position.avgCost, 0);
  assert.equal(position.cost, 0);
  // (12−10)×60 + (8−10)×40 = 120 − 80
  assert.equal(position.realizedPnl, 40);

  const summary = toAssetSummary(assetRow({ price: 9, prevClose: 9 }), txs);
  assert.equal(summary.closed, true);
  assert.equal(summary.marketValue, 0);
  assert.equal(summary.unrealizedPnl, 0);
  assert.equal(summary.realizedPnl, 40);
  assert.equal(summary.lastSellAt, '2026-02-10');
});

test('清仓后重新建仓：成本价重置为新买入价', () => {
  const txs = [
    tx('buy', 100, 10, '2026-01-02'),
    tx('sell', 100, 11, '2026-01-20'),
    tx('buy', 10, 30, '2026-03-01'),
  ];
  const position = computePosition(txs);
  assert.equal(position.shares, 10);
  assert.equal(position.avgCost, 30);
  assert.equal(position.cost, 300);
  assert.equal(position.realizedPnl, 100);
  assert.equal(position.firstBuyAt, '2026-01-02');
  assert.equal(position.lastBuyAt, '2026-03-01');
});

test('交易乱序输入仍按交易日计算', () => {
  const txs = [
    tx('sell', 50, 25, '2026-02-01'),
    tx('buy', 100, 20, '2026-01-05'),
    tx('buy', 100, 10, '2026-01-02'),
  ];
  const position = computePosition(txs);
  assert.equal(position.shares, 150);
  assert.equal(position.avgCost, 15);
  assert.equal(position.realizedPnl, 500);
  assert.equal(position.firstBuyAt, '2026-01-02');
});

test('AssetSummary 派生字段：市值/浮动盈亏/当日变动', () => {
  const txs = [tx('buy', 200, 15, '2026-01-02')];
  const summary = toAssetSummary(
    assetRow({ price: 12, prevClose: 11, dayChangePct: 0, spark: [11, 12] }),
    txs,
  );
  assert.equal(summary.shares, 200);
  assert.equal(summary.cost, 3000);
  assert.equal(summary.marketValue, 2400);
  assert.equal(summary.unrealizedPnl, -600);
  assert.equal(summary.unrealizedPnlPct, -20);
  // 200 × (12 − 11)
  assert.equal(summary.dayChange, 200);
  assert.equal(summary.dayChangePct, 9.0909);
  assert.deepEqual(summary.spark, [11, 12]);
  assert.equal(summary.closed, false);
});

test('组合汇总：按汇率折算为 CNY', () => {
  const cn = assetRow({
    id: 'a-cn',
    price: 12,
    prevClose: 11,
  });
  const cnSummary = {
    ...toAssetSummary(cn, [tx('buy', 100, 10, '2026-01-02')]),
    realizedPnl: 50,
  };
  const us = assetRow({
    id: 'a-us',
    market: 'US',
    currency: 'USD',
    price: 100,
    prevClose: 100,
    code: 'AAPL',
  });
  const usSummary = toAssetSummary(us, [tx('buy', 10, 90, '2026-01-03', 'a-us')]);

  const totals = summarizePortfolio([cnSummary, usSummary], { CNY: 1, HKD: 0.92, USD: 7.1 });
  assert.equal(totals.currency, 'CNY');
  assert.equal(totals.marketValue, 8300); // 1200 + 10×100×7.1
  assert.equal(totals.cost, 7390); // 1000 + 900×7.1
  assert.equal(totals.unrealizedPnl, 910);
  assert.equal(totals.dayChange, 100);
  assert.equal(totals.realizedPnl, 50);
  assert.deepEqual(totals.fxRates, { CNY: 1, HKD: 0.92, USD: 7.1 });
});

test('组合汇总：清仓持仓只贡献已实现盈亏', () => {
  const closed = assetRow({ id: 'a-closed', price: 10, prevClose: 10 });
  const closedSummary = {
    ...toAssetSummary(closed, [
      tx('buy', 100, 10, '2026-01-02', 'a-closed'),
      tx('sell', 100, 12, '2026-02-02', 'a-closed'),
    ]),
  };
  const totals = summarizePortfolio([closedSummary], { CNY: 1, HKD: 0.92, USD: 7.1 });
  assert.equal(totals.marketValue, 0);
  assert.equal(totals.cost, 0);
  assert.equal(totals.realizedPnl, 200);
});

test('预算：按自然月与市场币种统计买入成交额，卖出不释放预算', () => {
  const assets = [
    assetRow({ id: 'a-cn', market: 'CN' }),
    assetRow({ id: 'a-us', market: 'US', currency: 'USD', code: 'AAPL' }),
  ];
  const txs = [
    tx('buy', 100, 10, '2026-10-02', 'a-cn'), // CN 买入 1000
    tx('sell', 10, 12, '2026-10-09', 'a-cn'), // 卖出不释放预算
    tx('buy', 5, 100, '2026-10-03', 'a-us'), // US 买入 500
    tx('buy', 100, 99, '2026-09-30', 'a-cn'), // 上月，忽略
  ];
  const status = computeBudgetStatus(assets, txs, { CN: 5000, HK: 5000, US: 1000 }, '2026-10');

  assert.equal(status.month, '2026-10');
  const cn = status.markets.find((item) => item.market === 'CN')!;
  assert.equal(cn.currency, 'CNY');
  assert.equal(cn.budget, 5000);
  assert.equal(cn.spent, 1000);
  assert.equal(cn.remaining, 4000);
  assert.equal(cn.usedPct, 20);
  assert.equal(cn.exhausted, false);

  const us = status.markets.find((item) => item.market === 'US')!;
  assert.equal(us.currency, 'USD');
  assert.equal(us.spent, 500);
  assert.equal(us.remaining, 500);
  assert.equal(us.usedPct, 50);

  const hk = status.markets.find((item) => item.market === 'HK')!;
  assert.equal(hk.spent, 0);
  assert.equal(hk.remaining, 5000);
  assert.equal(hk.usedPct, 0);
  assert.equal(hk.exhausted, false);
});

test('预算：契约口径（买 10@10、卖 5@200 → spent=100）', () => {
  const assets = [assetRow({ id: 'a-cn', market: 'CN' })];
  const txs = [tx('buy', 10, 10, '2026-10-02', 'a-cn'), tx('sell', 5, 200, '2026-10-03', 'a-cn')];
  const cn = computeBudgetStatus(assets, txs, { CN: 1000, HK: 0, US: 0 }, '2026-10').markets[0]!;
  assert.equal(cn.spent, 100);
  assert.equal(cn.remaining, 900);
  assert.equal(cn.usedPct, 10);
  assert.equal(cn.exhausted, false);
});

test('预算：超支时 remaining 为负且 exhausted=true', () => {
  const assets = [assetRow({ id: 'a-cn', market: 'CN' })];
  const txs = [tx('buy', 1000, 1, '2026-10-02', 'a-cn')]; // 1000 > 50
  const status = computeBudgetStatus(assets, txs, { CN: 50, HK: 0, US: 0 }, '2026-10');
  const cn = status.markets.find((item) => item.market === 'CN')!;
  assert.equal(cn.spent, 1000);
  assert.equal(cn.remaining, -950);
  assert.equal(cn.exhausted, true);
  assert.equal(cn.usedPct, 2000);
});

test('建议来源（origin）：持仓 / 我的标的 / 池外，由链接字段如实推导', () => {
  const base = {
    id: 'adv-1',
    batchId: 'b1',
    assetId: null as string | null,
    watchItemId: null as string | null,
    assetName: '国电南瑞',
    code: '600406',
    market: 'CN' as const,
    type: 'stock' as const,
    // 建议行新增的两列：本文件一律按股票建议（无卖权方案）构造。
    instrument: 'stock' as const,
    action: 'buy' as const,
    targetShares: 50,
    targetPrice: 25,
    amount: 1250,
    currency: 'CNY',
    reason: '测试',
    confidence: 0.7,
    status: 'pending' as const,
    createdAt: '2026-10-15T00:00:00.000Z',
    decidedAt: null,
    executedShares: null,
    executedPrice: null,
    option: null,
  };
  assert.equal(toAdviceItem({ ...base, assetId: 'a1' }).origin, 'holding');
  assert.equal(toAdviceItem({ ...base, watchItemId: 'w1' }).origin, 'watchlist');
  assert.equal(toAdviceItem(base).origin, 'external', '没有链接 = 池外建议（跳过了候选池筛选）');
  // 持仓优先：同时存在链接时以持仓为准。
  assert.equal(toAdviceItem({ ...base, assetId: 'a1', watchItemId: 'w1' }).origin, 'holding');
});

test('toWatchItem：预期收益期限缺失时退化为空串（不是 undefined）', () => {
  const row: Parameters<typeof toWatchItem>[0] = {
    id: 'w1',
    name: '国电南瑞',
    code: '600406',
    market: 'CN',
    type: 'stock',
    source: 'ai',
    qualityScore: 74,
    targetPrice: 25,
    expectedReturn: 14,
    expectedReturnHorizon: '',
    initialPrice: 22.18,
    initialPriceAt: '2026-10-14T00:00:00.000Z',
    price: 22.29,
    priceAt: '2026-10-15T00:00:00.000Z',
    prevClose: 22.18,
    dayChangePct: 0.5,
    thesis: '',
    note: '',
    aiSummary: '',
    aiSummaryAt: null,
    spark: [],
    status: 'active',
    retiredReason: '',
    retiredAt: null,
    retireStreak: 0,
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
  };
  assert.equal(toWatchItem(row).expectedReturnHorizon, '');
  assert.equal(toWatchItem({ ...row, expectedReturnHorizon: '6-12 个月' }).expectedReturnHorizon, '6-12 个月');
});

test('预算：budget=0 表示「本月不投」（remaining<=0 → exhausted、usedPct=100）', () => {
  const assets = [assetRow({ id: 'a-cn', market: 'CN' })];
  const txs = [tx('buy', 100, 10, '2026-10-02', 'a-cn')];
  const spent = computeBudgetStatus(assets, txs, { CN: 0, HK: 0, US: 0 }, '2026-10').markets[0]!;
  assert.equal(spent.spent, 1000);
  assert.equal(spent.remaining, -1000);
  assert.equal(spent.exhausted, true);
  assert.equal(spent.usedPct, 100, '预算为 0 时显示 100% 而不是 0%');

  const untouched = computeBudgetStatus(assets, [], { CN: 0, HK: 0, US: 0 }, '2026-10').markets[0]!;
  assert.equal(untouched.spent, 0);
  assert.equal(untouched.remaining, 0);
  assert.equal(untouched.exhausted, true, 'remaining 为 0 即视为用尽');
  assert.equal(untouched.usedPct, 100);
});
