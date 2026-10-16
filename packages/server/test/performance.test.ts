/**
 * 组合年化收益率（当年）测试 —— 口径必须站得住，缺数据必须说「不可度量」。
 *
 * Owner: server-core. 纯函数 + 注入式 I/O：没有数据库、没有网络。
 *
 * 这里刻意用**独立实现**的净现值函数校验求解结果（不依赖被测模块内部的牛顿迭代），
 * 因为「年化」这种东西最容易在实现里悄悄写成一个看起来合理的错数字。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import type { AssetSummary, SeriesPoint } from '@aia/shared';
import type { AssetRow, TxRow } from '../src/types/models.js';
import {
  buildPortfolioPerformance,
  computePerformance,
  daysBetween,
  firstBuyDay,
  lastCloseOnOrBefore,
  loadOpeningValue,
  replaySales,
  sharesOn,
  solveXirr,
  type DatedFlow,
  type OpeningPosition,
} from '../src/services/performance.js';
import { computePosition, summarizePortfolio, toAssetSummary } from '../src/services/portfolio.js';

const DAY = 86_400_000;

function tx(
  kind: 'buy' | 'sell',
  shares: number,
  price: number,
  tradeDate: string,
  assetId = 'a-cn',
  fee = 0,
): TxRow {
  return {
    id: crypto.randomUUID(),
    assetId,
    kind,
    shares,
    price,
    fee,
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

/** 独立实现的 NPV（校验解出来的利率确实满足方程）。 */
function testNpv(flows: DatedFlow[], rate: number): number {
  const sorted = [...flows].sort((a, b) => a.date.localeCompare(b.date));
  const origin = Date.parse(`${sorted[0]!.date}T00:00:00Z`);
  return sorted.reduce((sum, flow) => {
    const years = (Date.parse(`${flow.date}T00:00:00Z`) - origin) / DAY / 365;
    return sum + flow.amount / (1 + rate) ** years;
  }, 0);
}

function flowScale(flows: DatedFlow[]): number {
  return flows.reduce((sum, flow) => sum + Math.abs(flow.amount), 0);
}

/** 求解结果必须满足 |NPV| ≈ 0，否则就是个假数字。 */
function assertSolves(flows: DatedFlow[], rate: number | null, label: string): void {
  assert.ok(rate !== null, `${label}：应当有解`);
  assert.ok(
    Math.abs(testNpv(flows, rate!)) <= 1e-6 * flowScale(flows),
    `${label}：解出来的利率不满足 XIRR 方程（NPV=${testNpv(flows, rate!)}）`,
  );
}

/* ──────────────────────────────── XIRR ──────────────────────────────── */

test('XIRR：一年 10% 的现金流解出 10%（不是线性外推）', () => {
  const flows: DatedFlow[] = [
    { date: '2025-01-01', amount: -1000 },
    { date: '2026-01-01', amount: 1100 },
  ];
  const { rate } = solveXirr(flows);
  assert.ok(rate !== null);
  assert.ok(Math.abs(rate! - 0.1) < 1e-9, `期望 0.1，实际 ${rate}`);
});

test('XIRR：两年翻倍 → 年化 √2−1（几何年化，不是 100%÷2）', () => {
  const flows: DatedFlow[] = [
    { date: '2025-01-01', amount: -1000 },
    { date: '2027-01-01', amount: 2000 },
  ];
  const { rate } = solveXirr(flows);
  assert.ok(rate !== null);
  assert.ok(Math.abs(rate! - (Math.SQRT2 - 1)) < 1e-7, `期望 ${Math.SQRT2 - 1}，实际 ${rate}`);
});

test('XIRR：不规则现金流（Excel XIRR 官方示例量级）解出的利率确实让净现值为 0', () => {
  const flows: DatedFlow[] = [
    { date: '2008-01-01', amount: -10000 },
    { date: '2008-03-01', amount: 2750 },
    { date: '2008-10-30', amount: 4250 },
    { date: '2009-02-15', amount: 3250 },
    { date: '2009-04-01', amount: 2750 },
  ];
  const { rate } = solveXirr(flows);
  assertSolves(flows, rate, '不规则现金流');
  assert.ok(rate! > 0.3 && rate! < 0.45, `示例年化应落在 30%~45%，实际 ${rate}`);
});

test('XIRR：亏损组合解出负年化（−50% / 两年腰斩 −29.29%）', () => {
  const oneYear: DatedFlow[] = [
    { date: '2025-01-01', amount: -1000 },
    { date: '2026-01-01', amount: 500 },
  ];
  const oneYearRate = solveXirr(oneYear).rate;
  assert.ok(oneYearRate !== null);
  assert.ok(Math.abs(oneYearRate! + 0.5) < 1e-9, `期望 -0.5，实际 ${oneYearRate}`);

  const twoYears: DatedFlow[] = [
    { date: '2025-01-01', amount: -1000 },
    { date: '2027-01-01', amount: 500 },
  ];
  const twoYearRate = solveXirr(twoYears).rate;
  assertSolves(twoYears, twoYearRate, '两年腰斩');
  assert.ok(Math.abs(twoYearRate! - (1 / Math.SQRT2 - 1)) < 1e-7, `期望 ${1 / Math.SQRT2 - 1}，实际 ${twoYearRate}`);
});

test('XIRR：退化输入如实返回原因，绝不猜一个数字', () => {
  assert.equal(solveXirr([{ date: '2026-01-01', amount: -1000 }]).reason, 'insufficient-flows');
  assert.equal(solveXirr([{ date: '2026-01-01', amount: -1000 }, { date: '2026-02-01', amount: -500 }]).reason, 'no-sign-change');
  assert.equal(solveXirr([{ date: '2026-01-01', amount: 100 }, { date: '2026-02-01', amount: 200 }]).reason, 'no-sign-change');
  // 同日买卖：年化会被放大成天文数字，直接判为无意义。
  assert.equal(
    solveXirr([{ date: '2026-01-01', amount: -1000 }, { date: '2026-01-01', amount: 1100 }]).reason,
    'too-short',
  );
  // 全是 0 的现金流等于没有现金流。
  assert.equal(
    solveXirr([{ date: '2026-01-01', amount: 0 }, { date: '2026-02-01', amount: 0 }]).reason,
    'insufficient-flows',
  );
  assert.equal(solveXirr([{ date: 'bad-date', amount: -1 }, { date: '2026-02-01', amount: 2 }]).rate, null);
});

/* ─────────────────────────── 账本重放（已实现） ─────────────────────────── */

test('已实现切片：移动加权平均成本 + 分摊买入费用 + 加权平均买入日', () => {
  const txs = [
    tx('buy', 100, 10, '2025-01-10', 'a-cn', 10),
    tx('buy', 100, 20, '2025-07-10', 'a-cn', 10),
    tx('sell', 100, 30, '2026-03-05', 'a-cn', 5),
  ];
  const sales = replaySales(txs, 'CNY');
  assert.equal(sales.length, 1);
  const sale = sales[0]!;
  assert.equal(sale.shares, 100);
  assert.equal(sale.costBasis, 1500, '成本 = 100 × 移动加权平均 15');
  assert.equal(sale.allocatedBuyFees, 10, '分摊到卖出份额的买入费用');
  assert.equal(sale.proceeds, 2995, '卖出净收入 = 3000 − 5');
  assert.equal(sale.netPnl, 1485, '含费用已实现盈亏 = 2995 − 1500 − 10');
  assert.equal(sale.ledgerPnl, 1500, '账本口径（不含费用）= (30 − 15) × 100');
  assert.equal(sale.acquiredDate, '2025-04-10', '两笔等额买入的加权平均买入日');
  assert.equal(sale.holdingDays, 329);
});

test('已实现切片：清仓后重新买入，成本锚点重置', () => {
  const txs = [
    tx('buy', 100, 10, '2025-01-01'),
    tx('sell', 100, 12, '2025-06-01'),
    tx('buy', 50, 20, '2026-02-01'),
    tx('sell', 50, 25, '2026-03-01'),
  ];
  const sales = replaySales(txs, 'CNY');
  assert.equal(sales.length, 2);
  assert.equal(sales[0]!.acquiredDate, '2025-01-01');
  assert.equal(sales[0]!.costBasis, 1000);
  assert.equal(sales[1]!.acquiredDate, '2026-02-01', '清仓后重新买入必须重置成本锚点');
  assert.equal(sales[1]!.costBasis, 1000);
  assert.equal(sales[1]!.proceeds, 1250);
  assert.equal(sales[1]!.holdingDays, 28);
});

test('已实现切片与账本口径一致（ledgerPnl === computePosition 的 realizedPnl）', () => {
  const txs = [
    tx('buy', 100, 10, '2026-01-02'),
    tx('buy', 100, 20, '2026-01-05'),
    tx('sell', 150, 25, '2026-02-02'),
    tx('sell', 50, 30, '2026-03-02'),
  ];
  const total = replaySales(txs, 'CNY').reduce((sum, sale) => sum + sale.ledgerPnl, 0);
  assert.equal(Number(total.toFixed(4)), computePosition(txs).realizedPnl);
});

test('期初份额 / 首次买入 / 历史收盘价锚定', () => {
  const txs = [
    tx('buy', 100, 10, '2025-05-01'),
    tx('sell', 40, 12, '2025-08-01'),
    tx('buy', 10, 11, '2026-02-01'),
  ];
  assert.equal(sharesOn(txs, '2025-12-31'), 60, '期初份额只看当年之前的交易');
  assert.equal(sharesOn(txs, '2025-05-01'), 100);
  assert.equal(sharesOn(txs, '2025-01-01'), 0);
  assert.equal(firstBuyDay(txs), '2025-05-01');

  const points: SeriesPoint[] = [
    { date: '2025-12-31', open: 11, high: 12, low: 10, close: 11.5, volume: 0 },
    { date: '2026-01-02', open: 11.6, high: 12, low: 11, close: 12, volume: 0 },
    { date: '2025-12-30', open: 10, high: 11, low: 9, close: 10, volume: 0 },
    { date: '2025-12-29', open: 0, high: 0, low: 0, close: 0, volume: 0 },
  ];
  assert.equal(lastCloseOnOrBefore(points, '2025-12-31'), 11.5, '取 ≤ 基准日的最后一个有效收盘价');
  assert.equal(lastCloseOnOrBefore(points, '2025-12-29'), null, '基准日之前的点不算');
  assert.equal(lastCloseOnOrBefore(points, '2025-01-01'), null, '序列没覆盖到基准日 → null');
  assert.equal(lastCloseOnOrBefore([{ date: '2025-12-31', open: 1, high: 1, low: 1, close: 9, volume: 0 }], '2025-12-31'), 9);
});

/* ─────────────────────────── 当年年化（组合） ─────────────────────────── */

test('当年年化：期初持仓 + 当年买卖 + 期末市值（XIRR，含费用）', () => {
  const txs = [
    tx('buy', 100, 10, '2025-01-05'),
    tx('buy', 50, 12, '2026-03-01'),
    tx('sell', 30, 15, '2026-06-01'),
  ];
  const perf = computePerformance({
    year: 2026,
    asOf: '2026-10-16',
    currency: 'CNY',
    assets: [{ id: 'a-cn', name: '测试标的', currency: 'CNY', txs }],
    openingValue: 1000, // 100 股 × 2025-12-31 收盘价 10
    endingValue: 1560, // 120 股 × 13
    rateOf: () => 1,
  });

  assert.equal(perf.periodStart, '2025-12-31');
  assert.equal(perf.periodEnd, '2026-10-16');
  assert.equal(perf.days, 289);
  assert.equal(perf.openingValue, 1000);
  assert.equal(perf.endingValue, 1560);
  assert.equal(perf.netInvested, 150, '净投入 = 买入 600 − 卖出 450');
  assert.equal(perf.realizedPnl, 130, '账本口径已实现盈亏 = (15 − 10.6667) × 30');

  // 独立构造「应有的现金流」再校验解出来的利率。
  const expectedYearFlows: DatedFlow[] = [
    { date: '2025-12-31', amount: -1000 },
    { date: '2026-03-01', amount: -600 },
    { date: '2026-06-01', amount: 450 },
    { date: '2026-10-16', amount: 1560 },
  ];
  assertSolves(expectedYearFlows, perf.annualizedPct === null ? null : perf.annualizedPct / 100, '当年年化');
  assert.ok(perf.annualizedPct! > 0, '总体盈利时年化必须为正');

  // 已实现部分：-320（100 股锚定在加权平均买入日）+450（卖出净收入）。
  assert.ok(perf.realizedAnnualizedPct !== null, '当年有卖出就必须能算出已实现年化');
  assert.ok(perf.realizedAnnualizedPct! > 0, '卖出价 15 > 成本 10.6667 → 已实现年化为正');
  assert.equal(perf.notes[0]!.startsWith('口径：XIRR'), true, '第一条说明必须写清口径');
  assert.ok(perf.notes.some((note) => note.includes('期初持仓市值')), '期初市值要写进说明');
  assert.equal(perf.sinceInceptionFrom, '2025-01-05');
});

test('当年年化：期初无持仓时从当年首笔买入起算（不与成本价混淆）', () => {
  const txs = [tx('buy', 100, 10, '2026-02-02')];
  const perf = computePerformance({
    year: 2026,
    asOf: '2026-10-16',
    currency: 'CNY',
    assets: [{ id: 'a-cn', name: '测试标的', currency: 'CNY', txs }],
    openingValue: 0,
    endingValue: 1200,
    rateOf: () => 1,
  });
  const expected = (1200 / 1000) ** (365 / 256) - 1;
  assert.ok(perf.annualizedPct !== null);
  assert.ok(
    Math.abs(perf.annualizedPct! / 100 - expected) < 1e-6,
    `期望 ${(expected * 100).toFixed(4)}%，实际 ${perf.annualizedPct}`,
  );
  assert.ok(perf.notes.some((note) => note.includes('期初') && note.includes('无持仓')));
});

test('当年年化：拿不到期初收盘价 → null 并写明原因，不拿 0 或估算值冒充', () => {
  const txs = [tx('buy', 100, 10, '2025-01-05'), tx('sell', 20, 12, '2026-04-01')];
  const perf = computePerformance({
    year: 2026,
    asOf: '2026-10-16',
    currency: 'CNY',
    assets: [{ id: 'a-cn', name: '测试标的', currency: 'CNY', txs }],
    openingValue: null,
    endingValue: 960,
    openingNotes: ['缺少 2025-12-31 的历史收盘价：测试标的(000001)，期初市值无法完整估值'],
    rateOf: () => 1,
  });
  assert.equal(perf.annualizedPct, null);
  assert.ok(perf.notes.some((note) => note.includes('期初持仓市值')));
  assert.ok(perf.notes.some((note) => note.includes('缺少 2025-12-31 的历史收盘价')));
  // 全周期年化不受影响：它只需要账本 + 期末市值。
  assert.ok(perf.sinceInceptionPct !== null);
});

test('当年没有卖出 → 已实现年化 null（不适用），不是 0', () => {
  const txs = [tx('buy', 100, 10, '2026-02-02')];
  const perf = computePerformance({
    year: 2026,
    asOf: '2026-10-16',
    currency: 'CNY',
    assets: [{ id: 'a-cn', name: '测试标的', currency: 'CNY', txs }],
    openingValue: 0,
    endingValue: 900,
    rateOf: () => 1,
  });
  assert.equal(perf.realizedAnnualizedPct, null);
  assert.equal(perf.realizedPnl, 0);
  assert.ok(perf.notes.some((note) => note.includes('当年没有卖出记录')));
});

test('短期区间提示按实际现金流判断：昨天刚买、今天算年化必须提示会被放大', () => {
  // 自然年已经过了 200+ 天，但真实资金在场只有 1 天 —— 提示必须按现金流区间给。
  const perf = computePerformance({
    year: 2026,
    asOf: '2026-10-16',
    currency: 'CNY',
    assets: [{ id: 'a-cn', name: '测试标的', currency: 'CNY', txs: [tx('buy', 100, 10, '2026-10-15')] }],
    openingValue: 0,
    endingValue: 1010,
    rateOf: () => 1,
  });
  assert.ok(perf.annualizedPct !== null, '1 天也能算，但必须提示');
  assert.ok(perf.days > 200, '自然年区间是长的');
  assert.ok(
    perf.notes.some((note) => note.includes('实际现金流区间仅 1 天')),
    `缺少短期提示：${perf.notes.join(' | ')}`,
  );
});

test('当年已实现年化：两笔现金流有解析解，锚点在加权平均买入日', () => {
  const txs = [
    tx('buy', 100, 10, '2025-01-05'),
    tx('buy', 50, 12, '2026-03-01'),
    tx('sell', 30, 15, '2026-06-01'),
  ];
  const perf = computePerformance({
    year: 2026,
    asOf: '2026-10-16',
    currency: 'CNY',
    assets: [{ id: 'a-cn', name: '测试标的', currency: 'CNY', txs }],
    openingValue: 1000,
    endingValue: 1560,
    rateOf: () => 1,
  });
  // 卖出 30 股：成本 30 × 10.6667 = 320，净收入 450；锚点 = 100/50 两笔买入的加权平均日 2025-05-25。
  const expected = (450 / 320) ** (365 / daysBetween('2025-05-25', '2026-06-01')) - 1;
  assert.ok(perf.realizedAnnualizedPct !== null);
  assert.ok(
    Math.abs(perf.realizedAnnualizedPct! / 100 - expected) < 1e-6,
    `期望 ${(expected * 100).toFixed(4)}%，实际 ${perf.realizedAnnualizedPct}`,
  );
});

test('多币种：现金流按组合币种汇率折算后再算年化', () => {
  const txs = [tx('buy', 10, 100, '2026-03-02', 'a-us')];
  const perf = computePerformance({
    year: 2026,
    asOf: '2026-10-16',
    currency: 'CNY',
    assets: [{ id: 'a-us', name: 'US ETF', currency: 'USD', txs }],
    openingValue: 0,
    endingValue: 10 * 110 * 7.1,
    rateOf: (code) => (code === 'USD' ? 7.1 : 1),
  });
  const expected = ((10 * 110 * 7.1) / (10 * 100 * 7.1)) ** (365 / daysBetween('2026-03-02', '2026-10-16')) - 1;
  assert.ok(perf.annualizedPct !== null);
  assert.ok(Math.abs(perf.annualizedPct! / 100 - expected) < 1e-6);
  assert.equal(perf.netInvested, 7100, '净投入按 CNY 折算');
});

/* ─────────────────────── 期初估值（I/O + 缓存 + 降级） ─────────────────────── */

const positions: OpeningPosition[] = [
  { assetId: 'a-cn', name: '招行', code: '600036', market: 'CN', type: 'stock', currency: 'CNY', shares: 100 },
  { assetId: 'a-us', name: '苹果', code: 'AAPL', market: 'US', type: 'stock', currency: 'USD', shares: 10 },
];

/** 极简 kv 替身，用来验证「一个标的 × 一年只取一次」。 */
function fakeCache(): { store: Map<string, string>; get(key: string): string | null; set(key: string, value: string): void } {
  const store = new Map<string, string>();
  return { store, get: (key) => store.get(key) ?? null, set: (key, value) => void store.set(key, value) };
}

test('期初估值：按 期末基准日 收盘价 × 份额 × 汇率，并写进 kv 缓存', async () => {
  const cache = fakeCache();
  let calls = 0;
  const loader = async (asset: { code: string }): Promise<number | null> => {
    calls += 1;
    return asset.code === '600036' ? 10 : 100;
  };
  const first = await loadOpeningValue({
    cutoff: '2025-12-31',
    positions,
    rateOf: (code) => (code === 'USD' ? 7.1 : 1),
    cache,
    loader,
  });
  assert.equal(calls, 2);
  assert.equal(first.value, 100 * 10 + 10 * 100 * 7.1);
  assert.equal(cache.store.size, 2, '每个标的都要落缓存');

  // 第二次：命中缓存，不再打上游。
  const second = await loadOpeningValue({
    cutoff: '2025-12-31',
    positions,
    rateOf: (code) => (code === 'USD' ? 7.1 : 1),
    cache,
    loader,
  });
  assert.equal(calls, 2, '同一年度同一标的只允许取一次历史收盘价');
  assert.equal(second.value, first.value);
});

test('期初估值：任一标的缺价 → 整体不可估值（不给部分市值硬算）', async () => {
  const result = await loadOpeningValue({
    cutoff: '2025-12-31',
    positions,
    rateOf: () => 1,
    loader: async (asset) => (asset.code === '600036' ? 10 : null),
  });
  assert.equal(result.value, null);
  assert.ok(result.notes.some((note) => note.includes('苹果(AAPL)')), `说明里必须点名缺价的标的：${result.notes.join(' | ')}`);
});

test('期初估值：取不到价时负缓存 —— 短时间内不再重复打上游，成功值优先', async () => {
  const cache = fakeCache();
  let calls = 0;
  let usdPrice: number | null = null;
  const loader = async (asset: { code: string }): Promise<number | null> => {
    calls += 1;
    return asset.code === '600036' ? 10 : usdPrice;
  };
  const options = { cutoff: '2025-12-31', positions, rateOf: () => 1, cache, loader };

  const first = await loadOpeningValue(options);
  assert.equal(first.value, null);
  assert.equal(calls, 2);
  assert.equal(
    [...cache.store.keys()].filter((key) => key.endsWith('.miss')).length,
    1,
    '只有失败的那个标的落负缓存',
  );

  const second = await loadOpeningValue(options);
  assert.equal(second.value, null);
  assert.equal(calls, 2, '负缓存有效期内不得再打上游');

  // 负缓存过期（重置为 0）后重试：成功的标的仍走正向缓存，失败的重试一次。
  for (const key of [...cache.store.keys()]) {
    if (key.endsWith('.miss')) cache.store.set(key, '0');
  }
  usdPrice = 100;
  const third = await loadOpeningValue(options);
  assert.equal(calls, 3, '只有过期失败的那个标的会重试');
  assert.equal(third.value, 100 * 10 + 10 * 100 * 1);
  assert.equal(
    [...cache.store.keys()].filter((key) => key.endsWith('.miss')).length,
    1,
    '重试成功后不得再写负缓存（旧的那条由新值覆盖语义排除）',
  );
});

test('期初估值：超过上限 / 超时一律放弃并说明（宁可不可度量）', async () => {
  const many = Array.from({ length: 41 }, (_, index) => ({
    ...positions[0]!,
    assetId: `a-${index}`,
    code: `0000${index}`,
  }));
  let called = 0;
  const over = await loadOpeningValue({
    cutoff: '2025-12-31',
    positions: many,
    rateOf: () => 1,
    loader: async () => {
      called += 1;
      return 1;
    },
  });
  assert.equal(over.value, null);
  assert.equal(called, 0, '超上限时不应打上游');
  assert.ok(over.notes.some((note) => note.includes('上限')), `超上限要说明原因：${over.notes.join(' | ')}`);

  const timedOut = await loadOpeningValue({
    cutoff: '2025-12-31',
    positions,
    rateOf: () => 1,
    deadlineMs: 0,
    loader: async () => {
      called += 1;
      return 1;
    },
  });
  assert.equal(timedOut.value, null);
  assert.equal(called, 0, '超时后不得继续打上游');
  assert.ok(timedOut.notes.some((note) => note.includes('超时')), `超时要说明原因：${timedOut.notes.join(' | ')}`);
});

test('期初无持仓时不需要任何历史行情（离线也能算当年年化）', async () => {
  const result = await loadOpeningValue({
    cutoff: '2025-12-31',
    positions: [],
    rateOf: () => 1,
    loader: async () => {
      throw new Error('不应该被调用');
    },
  });
  assert.equal(result.value, 0);
  assert.deepEqual(result.notes, []);
});

/* ───────────────────────── 编排（Dashboard 接入） ───────────────────────── */

test('编排：期末市值与组合汇总同源（同汇率口径），缺价时降级为不可度量', async () => {
  const row = assetRow({ id: 'a-us', code: 'AAPL', market: 'US', currency: 'USD', price: 110, prevClose: 110 });
  const txs = [tx('buy', 10, 100, '2026-03-02', 'a-us')];
  const summaries: AssetSummary[] = [toAssetSummary(row, txs)];
  const fxRates = { CNY: 1, USD: 7.1 };

  const perf = await buildPortfolioPerformance({
    assets: [row],
    transactions: txs,
    summaries,
    fxRates,
    currency: 'CNY',
    year: 2026,
    asOf: '2026-10-16',
    loader: async () => 100,
  });

  const totals = summarizePortfolio(summaries, fxRates);
  assert.equal(perf.endingValue, totals.marketValue, '期末市值必须与持仓汇总完全一致');
  assert.equal(perf.openingValue, 0, '当年才买入 → 期初无持仓');
  assert.ok(perf.annualizedPct !== null);
  assert.equal(perf.days, daysBetween('2025-12-31', '2026-10-16'));
});

test('编排：期初持仓缺历史行情 → 当年年化 null + 说明（离线/AIA_OFFLINE 的真实路径）', async () => {
  const row = assetRow({ id: 'a-cn', code: '600036', price: 12, prevClose: 12 });
  const txs = [tx('buy', 100, 10, '2025-06-02'), tx('sell', 20, 12, '2026-04-01')];
  const summaries: AssetSummary[] = [toAssetSummary(row, txs)];

  const perf = await buildPortfolioPerformance({
    assets: [row],
    transactions: txs,
    summaries,
    fxRates: { CNY: 1 },
    currency: 'CNY',
    year: 2026,
    asOf: '2026-10-16',
    loader: async () => null, // 模拟取不到 2025-12-31 收盘价
  });
  assert.equal(perf.openingValue, null);
  assert.equal(perf.annualizedPct, null);
  assert.ok(perf.notes.some((note) => note.includes('600036')));
  assert.ok(perf.realizedAnnualizedPct !== null, '已实现年化只用账本，缺历史行情也能算');
});
