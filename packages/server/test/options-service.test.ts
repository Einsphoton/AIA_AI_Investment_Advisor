/**
 * 期权卖权服务测试：确定性指标 / 候选筛选 / 方案构建 / 到期结算判定 / 幂等。
 *
 * 全部离线、确定性：
 *  - 纯函数部分（指标/筛选/方案/汇总）不碰网络也不碰库；
 *  - 结算与确认路径用**内存假仓库**（只实现服务层实际调用的方法，按契约语义做
 *    「按 contract_id upsert、updateAdvice 覆写」），因此这些用例不依赖 db/repo.ts 的
 *    并行实现进度，也能守护「重复扫描不重复写流水」这条最关键的性质。
 *    真实 SQLite 的 upsert 语义由 task-4 的 repo.test.ts 覆盖。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import type {
  OptionChainSnapshot,
  OptionMarket,
  OptionQuote,
  OptionSettlementMode,
  OptionSettings,
  OptionStrategy,
  OptionType,
} from '@aia/shared';
import { OPTION_SCREEN_RULES } from '@aia/shared';

import { AppError } from '../src/errors.js';
import { getServices, setServices, type ServerServices } from '../src/registry.js';
import type { Repo } from '../src/types/repo.js';
import type {
  AdviceRow,
  AssetRow,
  NewAsset,
  NewOptionContract,
  NewOptionSettlement,
  NewTx,
  OptionContractPatch,
  OptionContractRow,
  OptionSettlementPatch,
  OptionSettlementRow,
  StoredSettings,
  TxRow,
} from '../src/types/models.js';
import { localDate, nowIso } from '../src/db/util.js';
import {
  buildOptionAdvicePlan,
  closeOptionPosition,
  confirmOptionAdvice,
  optionCandidateMetrics,
  optionPortfolioSummary,
  screenOptionCandidates,
} from '../src/services/options.js';
import { confirmOptionSettlement, scanOptionSettlements } from '../src/services/options-settlement.js';

/* ─────────────────────────────── 假仓库（内存） ───────────────────────────── */

interface FakeRepo {
  repo: Repo;
  assets: AssetRow[];
  transactions: TxRow[];
  contracts: OptionContractRow[];
  settlements: OptionSettlementRow[];
  advice: AdviceRow[];
  settings: OptionSettings;
}

function makeFakeRepo(input: { cash?: { HK: number; US: number }; mode?: OptionSettlementMode } = {}): FakeRepo {
  const assets: AssetRow[] = [];
  const transactions: TxRow[] = [];
  const contracts: OptionContractRow[] = [];
  const settlements: OptionSettlementRow[] = [];
  const advice: AdviceRow[] = [];
  const settings: OptionSettings = {
    cash: input.cash ?? { HK: 0, US: 0 },
    settlementMode: input.mode ?? 'auto',
    runWithPipeline: true,
  };

  const repo = {
    transaction: <T>(fn: () => T): T => fn(),
    getSettings: (): StoredSettings => ({ option: settings }) as unknown as StoredSettings,

    listAssets: (): AssetRow[] => [...assets],
    getAsset: (id: string): AssetRow | undefined => assets.find((row) => row.id === id),
    findAsset: (code: string, market: string, type: string): AssetRow | undefined =>
      assets.find((row) => row.code === code && row.market === market && row.type === type),
    createAsset: (row: NewAsset): AssetRow => {
      const asset: AssetRow = {
        ...row,
        prevClose: row.prevClose ?? row.price,
        dayChangePct: row.dayChangePct ?? 0,
        spark: row.spark ?? [],
        thesis: '',
        qualityScore: 0,
        targetPrice: 0,
        expectedReturn: 0,
        aiSummary: '',
        aiSummaryAt: null,
        updatedAt: row.createdAt,
      };
      assets.push(asset);
      return asset;
    },

    listTransactions: (assetId?: string): TxRow[] =>
      assetId ? transactions.filter((row) => row.assetId === assetId) : [...transactions],
    getTransaction: (id: string): TxRow | undefined => transactions.find((row) => row.id === id),
    addTransaction: (row: NewTx): TxRow => {
      const tx: TxRow = { ...row, fee: row.fee ?? 0, note: row.note ?? '' };
      transactions.push(tx);
      return tx;
    },

    getAdvice: (id: string): AdviceRow | undefined => advice.find((row) => row.id === id),
    listAdvice: (filter?: { status?: AdviceRow['status'] }): AdviceRow[] =>
      filter?.status ? advice.filter((row) => row.status === filter.status) : [...advice],
    updateAdvice: (id: string, patch: Partial<Omit<AdviceRow, 'id'>>): AdviceRow | undefined => {
      const row = advice.find((entry) => entry.id === id);
      if (!row) return undefined;
      Object.assign(row, patch);
      return row;
    },

    listOptionContracts: (filter?: {
      status?: OptionContractRow['status'] | 'all';
      market?: OptionMarket;
      underlyingAssetId?: string;
      expiringOnOrBefore?: string;
    }): OptionContractRow[] =>
      contracts
        .filter((row) => (filter?.status && filter.status !== 'all' ? row.status === filter.status : true))
        .filter((row) => (filter?.market ? row.market === filter.market : true))
        .filter((row) => (filter?.underlyingAssetId ? row.underlyingAssetId === filter.underlyingAssetId : true))
        .filter((row) => (filter?.expiringOnOrBefore ? row.expiry <= filter.expiringOnOrBefore : true))
        .sort((a, b) => (a.openedAt < b.openedAt ? 1 : a.openedAt > b.openedAt ? -1 : 0)),
    getOptionContract: (id: string): OptionContractRow | undefined => contracts.find((row) => row.id === id),
    createOptionContract: (input: NewOptionContract): OptionContractRow => {
      const row: OptionContractRow = {
        id: input.id,
        adviceId: input.adviceId ?? null,
        strategy: input.strategy,
        market: input.market,
        underlyingCode: input.underlyingCode,
        underlyingName: input.underlyingName ?? '',
        underlyingAssetId: input.underlyingAssetId ?? null,
        optionCode: input.optionCode,
        optionType: input.optionType,
        strike: input.strike,
        expiry: input.expiry,
        contracts: input.contracts,
        multiplier: input.multiplier,
        currency: input.currency,
        premium: input.premium,
        fee: input.fee ?? 0,
        premiumIncome: input.premiumIncome,
        collateralKind: input.collateralKind,
        collateral: input.collateral,
        underlyingPriceAtOpen: input.underlyingPriceAtOpen ?? 0,
        status: input.status ?? 'open',
        openedAt: input.openedAt,
        closedAt: null,
        closePrice: null,
        realizedPnl: null,
        note: input.note ?? '',
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      };
      contracts.push(row);
      return row;
    },
    updateOptionContract: (id: string, patch: OptionContractPatch): OptionContractRow | undefined => {
      const row = contracts.find((entry) => entry.id === id);
      if (!row) return undefined;
      Object.assign(row, patch);
      return row;
    },
    deleteOptionContract: (id: string): boolean => {
      const index = contracts.findIndex((row) => row.id === id);
      if (index < 0) return false;
      contracts.splice(index, 1);
      return true;
    },

    listOptionSettlements: (filter?: {
      status?: OptionSettlementRow['status'] | 'all';
      contractId?: string;
      expiry?: string;
    }): OptionSettlementRow[] =>
      settlements
        .filter((row) => (filter?.status && filter.status !== 'all' ? row.status === filter.status : true))
        .filter((row) => (filter?.contractId ? row.contractId === filter.contractId : true))
        .filter((row) => (filter?.expiry ? row.expiry === filter.expiry : true)),
    getOptionSettlement: (id: string): OptionSettlementRow | undefined => settlements.find((row) => row.id === id),
    findOptionSettlementByContract: (contractId: string): OptionSettlementRow | undefined =>
      settlements.find((row) => row.contractId === contractId),
    /** 按 contract_id 幂等 upsert（与冻结契约一致）。 */
    upsertOptionSettlement: (input: NewOptionSettlement): OptionSettlementRow => {
      const index = settlements.findIndex((row) => row.contractId === input.contractId);
      const row: OptionSettlementRow = {
        id: input.id,
        contractId: input.contractId,
        expiry: input.expiry,
        evaluatedAt: input.evaluatedAt,
        referencePrice: input.referencePrice,
        priceSource: input.priceSource,
        verdict: input.verdict,
        itmAmount: input.itmAmount,
        itmPct: input.itmPct,
        status: input.status,
        action: input.action,
        transactionId: input.transactionId ?? null,
        assetId: input.assetId ?? null,
        realizedPnl: input.realizedPnl ?? 0,
        note: input.note ?? '',
        createdAt: input.createdAt,
      };
      if (index >= 0) settlements[index] = { ...row, id: settlements[index]!.id, createdAt: settlements[index]!.createdAt };
      else settlements.push(row);
      return settlements.find((entry) => entry.contractId === input.contractId)!;
    },
    updateOptionSettlement: (id: string, patch: OptionSettlementPatch): OptionSettlementRow | undefined => {
      const row = settlements.find((entry) => entry.id === id);
      if (!row) return undefined;
      Object.assign(row, patch);
      return row;
    },
  };

  return { repo: repo as unknown as Repo, assets, transactions, contracts, settlements, advice, settings };
}

/* ─────────────────────────────── 测试数据 ────────────────────────────────── */

const today = localDate();

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** 演示脚本用：与 `today` 相差的自然日。 */
function calendarGap(expiry: string): number {
  return Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** 演示脚本用：四舍五入到 N 位小数。 */
function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function makeQuote(over: Partial<OptionQuote> & { type: OptionType; strike: number; expiry: string }): OptionQuote {
  const bid = over.bid ?? 2;
  const ask = over.ask ?? 2.2;
  const mid = over.mid ?? (bid > 0 && ask > 0 ? Math.round(((bid + ask) / 2) * 10_000) / 10_000 : 0);
  return {
    code: over.code ?? `${over.type === 'call' ? 'C' : 'P'}${over.strike}`,
    type: over.type,
    strike: over.strike,
    expiry: over.expiry,
    bid,
    ask,
    last: over.last ?? 0,
    settlement: over.settlement ?? 0,
    iv: over.iv ?? 0.3,
    delta: over.delta ?? 0.2,
    openInterest: over.openInterest ?? 500,
    volume: over.volume ?? 100,
    multiplier: over.multiplier ?? 100,
    mid,
    spreadPct: over.spreadPct ?? (mid > 0 ? Math.round(((ask - bid) / mid) * 10_000) / 100 : 0),
  };
}

function makeSnapshot(over: Partial<OptionChainSnapshot> & { quotes: OptionQuote[] }): OptionChainSnapshot {
  return {
    market: over.market ?? 'US',
    code: over.code ?? 'AAPL',
    name: over.name ?? 'Apple',
    underlyingPrice: over.underlyingPrice ?? 100,
    currency: over.currency ?? 'USD',
    asOf: over.asOf ?? `${today}T09:40:00.000+08:00`,
    delayed: over.delayed ?? true,
    source: over.source ?? 'CBOE 延迟行情（测试夹具）',
    expiries: over.expiries ?? [],
    quotes: over.quotes,
    warnings: over.warnings ?? [],
  };
}

function makeAsset(over: Partial<AssetRow> = {}): AssetRow {
  return {
    id: over.id ?? 'asset-1',
    name: 'Apple',
    code: 'AAPL',
    market: 'US',
    type: 'stock',
    source: 'manual',
    currency: 'USD',
    note: '',
    price: 100,
    priceAt: nowIso(),
    prevClose: 100,
    dayChangePct: 0,
    spark: [],
    thesis: '',
    qualityScore: 0,
    targetPrice: 0,
    expectedReturn: 0,
    aiSummary: '',
    aiSummaryAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...over,
  };
}

function makeContract(over: Partial<OptionContractRow> = {}): OptionContractRow {
  return {
    id: over.id ?? 'contract-1',
    adviceId: over.adviceId ?? null,
    strategy: over.strategy ?? 'covered_call',
    market: over.market ?? 'US',
    underlyingCode: over.underlyingCode ?? 'AAPL',
    underlyingName: over.underlyingName ?? 'Apple',
    underlyingAssetId: over.underlyingAssetId ?? null,
    optionCode: over.optionCode ?? 'AAPL260116C00110000',
    optionType: over.optionType ?? 'call',
    strike: over.strike ?? 110,
    expiry: over.expiry ?? '2026-01-16',
    contracts: over.contracts ?? 1,
    multiplier: over.multiplier ?? 100,
    currency: over.currency ?? 'USD',
    premium: over.premium ?? 2,
    fee: over.fee ?? 0,
    premiumIncome: over.premiumIncome ?? 200,
    collateralKind: over.collateralKind ?? 'shares',
    collateral: over.collateral ?? 10_000,
    underlyingPriceAtOpen: over.underlyingPriceAtOpen ?? 100,
    status: over.status ?? 'open',
    openedAt: over.openedAt ?? '2025-12-01T09:30:00.000+08:00',
    closedAt: over.closedAt ?? null,
    closePrice: over.closePrice ?? null,
    realizedPnl: over.realizedPnl ?? null,
    note: over.note ?? '',
    createdAt: over.createdAt ?? '2025-12-01T09:30:00.000+08:00',
    updatedAt: over.updatedAt ?? '2025-12-01T09:30:00.000+08:00',
  };
}

function makeAdvice(over: Partial<AdviceRow> = {}): AdviceRow {
  return {
    id: over.id ?? 'advice-1',
    batchId: over.batchId ?? 'batch-1',
    assetId: over.assetId ?? 'asset-1',
    watchItemId: null,
    assetName: over.assetName ?? 'Apple',
    code: over.code ?? 'AAPL',
    market: over.market ?? 'US',
    type: over.type ?? 'stock',
    instrument: over.instrument ?? 'option',
    action: over.action ?? 'sell',
    targetShares: over.targetShares ?? 100,
    targetPrice: over.targetPrice ?? 2,
    currency: over.currency ?? 'USD',
    reason: over.reason ?? '测试',
    confidence: over.confidence ?? 0.6,
    status: over.status ?? 'pending',
    executedShares: over.executedShares ?? null,
    executedPrice: over.executedPrice ?? null,
    createdAt: over.createdAt ?? nowIso(),
    decidedAt: over.decidedAt ?? null,
    option: over.option ?? null,
  };
}

/** 从零构造一个「覆盖式卖 Call」方案（与 tools.ts 里 create_option_advice 的调用口径一致）。 */
function coveredCallPlan(over: { code?: string; underlyingPrice?: number; strike?: number; expiry?: string; contracts?: number } = {}) {
  const code = over.code ?? 'AAPL';
  const strike = over.strike ?? 110;
  const expiry = over.expiry ?? addDays(today, 30);
  const quote = makeQuote({ type: 'call', strike, expiry, bid: 2, multiplier: 100, delta: 0.2 });
  const snapshot = makeSnapshot({ code, underlyingPrice: over.underlyingPrice ?? 100, quotes: [quote] });
  const contracts = over.contracts ?? 1;
  return {
    strategy: 'covered_call' as OptionStrategy,
    market: 'US' as OptionMarket,
    code,
    name: 'Apple',
    quote,
    underlyingPrice: snapshot.underlyingPrice,
    contracts,
    collateral: snapshot.underlyingPrice * 100 * contracts,
    collateralNote: '测试担保说明',
    snapshot,
    acceptAssignment: true,
  };
}

/* ─────────────────────────── 服务定位器隔离 ──────────────────────────────── */

let previousServices: ServerServices | null = null;
before(() => {
  try {
    previousServices = getServices();
  } catch {
    previousServices = null;
  }
});
after(() => {
  if (previousServices) setServices(previousServices);
});

/** 每个用例一份新的假仓库，并通过服务定位器暴露给 getRepo()。 */
function useRepo(input: { cash?: { HK: number; US: number }; mode?: OptionSettlementMode } = {}): FakeRepo {
  const fake = makeFakeRepo(input);
  setServices({
    repo: fake.repo,
    agent: { isConfigured: () => false, tools: () => [], run: async () => { throw new Error('stub'); }, resume: async () => { throw new Error('stub'); } },
  });
  return fake;
}

/* ─────────────────────────────── 指标口径 ───────────────────────────────── */

test('年化收益率口径：权利金收入 = 价 × 乘数 × 张数 − 费用；年化 = 静态 × 365 / 剩余自然日', () => {
  const expiry = addDays(today, 30);
  const quote = makeQuote({ type: 'call', strike: 110, expiry, bid: 2, ask: 2.2, multiplier: 100, delta: 0.2 });
  const metrics = optionCandidateMetrics({
    market: 'US',
    code: 'AAPL',
    strategy: 'covered_call',
    quote,
    underlyingPrice: 100,
    contracts: 1,
  });

  assert.equal(metrics.premiumIncome, 200, '2 × 100 × 1 = 200');
  assert.equal(metrics.collateral, 10_000, '覆盖式卖 Call 的担保 = 现价 × 乘数 × 张数');
  assert.equal(metrics.collateralKind, 'shares');
  assert.equal(metrics.staticYieldPct, 2, '200 / 10000 = 2%');
  assert.equal(metrics.annualizedYieldPct, 24.3333, '2% × 365 / 30');
  assert.equal(metrics.maxProfit, 200);
  assert.equal(metrics.breakeven, 112, '卖 Call 盈亏平衡 = 行权价 + 权利金');
  assert.equal(metrics.requiredShares, 100);
  assert.equal(metrics.assignmentProbability, 0.2, '美股用 |delta|');
  assert.equal(metrics.downsideProtectionPct, 10, '虚值幅度 (110 − 100) / 100');
});

test('费用计入权利金收入与盈亏平衡之外的收益率', () => {
  const expiry = addDays(today, 45);
  const quote = makeQuote({ type: 'put', strike: 95, expiry, bid: 3, ask: 3.2, multiplier: 100, delta: 0.25 });
  const metrics = optionCandidateMetrics(
    { market: 'US', code: 'AAPL', strategy: 'cash_secured_put', quote, underlyingPrice: 100, contracts: 2, fee: 5 },
    [],
  );
  assert.equal(metrics.premiumIncome, 595, '3 × 100 × 2 − 5');
  assert.equal(metrics.collateral, 19_000, '卖 Put 担保 = 行权价 × 乘数 × 张数');
  assert.equal(metrics.collateralKind, 'cash');
  assert.equal(metrics.staticYieldPct, 3.1316, '595 / 19000');
  assert.equal(metrics.breakeven, 92, '卖 Put 盈亏平衡 = 行权价 − 权利金');
  assert.equal(metrics.requiredShares, 0, '卖 Put 不需要持股');
});

test('已到期合约的年化按 0 返回并给 warning（不除零、不给负数年化）', () => {
  const warnings: string[] = [];
  const quote = makeQuote({ type: 'call', strike: 110, expiry: '2020-01-17', bid: 2, multiplier: 100, delta: 0.2 });
  const metrics = optionCandidateMetrics(
    { market: 'US', code: 'AAPL', strategy: 'covered_call', quote, underlyingPrice: 100, contracts: 1 },
    warnings,
  );
  assert.equal(metrics.annualizedYieldPct, 0);
  assert.ok(warnings.some((warning) => warning.includes('年化收益率按 0')), `warnings=${warnings.join('|')}`);
});

test('安全垫方向：卖 Call 取 (行权价 − 现价)，卖 Put 取 (现价 − 行权价)，都为正数才是虚值', () => {
  const expiry = addDays(today, 20);
  const call = optionCandidateMetrics({
    market: 'US',
    code: 'AAPL',
    strategy: 'covered_call',
    quote: makeQuote({ type: 'call', strike: 110, expiry, bid: 1, multiplier: 100, delta: 0.2 }),
    underlyingPrice: 100,
    contracts: 1,
  });
  assert.equal(call.downsideProtectionPct, 10);

  const put = optionCandidateMetrics({
    market: 'US',
    code: 'AAPL',
    strategy: 'cash_secured_put',
    quote: makeQuote({ type: 'put', strike: 90, expiry, bid: 1, multiplier: 100, delta: 0.15 }),
    underlyingPrice: 100,
    contracts: 1,
  });
  assert.equal(put.downsideProtectionPct, 10);

  const itmCall = optionCandidateMetrics({
    market: 'US',
    code: 'AAPL',
    strategy: 'covered_call',
    quote: makeQuote({ type: 'call', strike: 95, expiry, bid: 1, multiplier: 100, delta: 0.7 }),
    underlyingPrice: 100,
    contracts: 1,
  });
  assert.equal(itmCall.downsideProtectionPct, -5, '实值 Call 的安全垫为负数（已被套在行权价之下）');
});

test('现价缺失时安全垫返回 0 并给 warning（不猜）', () => {
  const warnings: string[] = [];
  const metrics = optionCandidateMetrics(
    {
      market: 'US',
      code: 'AAPL',
      strategy: 'covered_call',
      quote: makeQuote({ type: 'call', strike: 110, expiry: addDays(today, 20), bid: 1, multiplier: 100, delta: 0.2 }),
      underlyingPrice: 0,
      contracts: 1,
    },
    warnings,
  );
  assert.equal(metrics.downsideProtectionPct, 0);
  assert.ok(warnings.some((warning) => warning.includes('安全垫按 0')));
});

test('港股无 delta：用虚值幅度 + IV 正态近似估算，并明确标注「估算」', () => {
  const warnings: string[] = [];
  const quote = makeQuote({
    code: 'TCH-20260129-660-C',
    type: 'call',
    strike: 660,
    expiry: addDays(today, 30),
    bid: 0,
    ask: 0,
    mid: 0,
    last: 0,
    settlement: 8.5,
    delta: 0,
    iv: 0.35,
    multiplier: 100,
    openInterest: 120,
    volume: 30,
    spreadPct: 0,
  });
  const metrics = optionCandidateMetrics(
    { market: 'HK', code: '00700', strategy: 'covered_call', quote, underlyingPrice: 620, contracts: 1 },
    warnings,
  );
  assert.ok(metrics.assignmentProbability > 0 && metrics.assignmentProbability < 0.35, `估算概率=${metrics.assignmentProbability}`);
  assert.ok(warnings.some((warning) => warning.includes('估算')), `warnings=${warnings.join('|')}`);
  assert.equal(metrics.premiumIncome, 850, '港股无买卖盘时按 HKEX 结算价估算权利金');
  assert.ok(warnings.some((warning) => warning.includes('结算价')), '必须说明权利金来自 EOD 结算价');
});

test('港股 IV 缺失（0 = 上游未提供）时被行权概率按未知处理，不代入 0% 波动', () => {
  const warnings: string[] = [];
  const quote = makeQuote({
    code: 'TCH-20260129-660-C',
    type: 'call',
    strike: 660,
    expiry: addDays(today, 30),
    bid: 0,
    ask: 0,
    mid: 0,
    settlement: 8.5,
    delta: 0,
    iv: 0,
    multiplier: 100,
    spreadPct: 0,
  });
  const metrics = optionCandidateMetrics(
    { market: 'HK', code: '00700', strategy: 'covered_call', quote, underlyingPrice: 620, contracts: 1 },
    warnings,
  );
  assert.equal(metrics.assignmentProbability, 0);
  assert.ok(warnings.some((warning) => warning.includes('无法估算被行权概率')), `warnings=${warnings.join('|')}`);
});

test('流动性分：买卖价缺失不给高分并给 warning；有报价时随 OI/成交量上升', () => {
  const noQuoteWarnings: string[] = [];
  const missing = makeQuote({
    type: 'call',
    strike: 110,
    expiry: addDays(today, 30),
    bid: 0,
    ask: 0,
    mid: 0,
    last: 0,
    settlement: 2,
    spreadPct: 0,
    openInterest: 0,
    volume: 0,
  });
  const missingScore = optionCandidateMetrics(
    { market: 'HK', code: '00700', strategy: 'covered_call', quote: missing, underlyingPrice: 100, contracts: 1 },
    noQuoteWarnings,
  ).liquidityScore;
  assert.equal(missingScore, 0);
  assert.ok(noQuoteWarnings.some((warning) => warning.includes('买卖价缺失')), noQuoteWarnings.join('|'));

  const liquid = optionCandidateMetrics({
    market: 'US',
    code: 'AAPL',
    strategy: 'covered_call',
    quote: makeQuote({ type: 'call', strike: 110, expiry: addDays(today, 30), bid: 2, ask: 2.05, openInterest: 1200, volume: 600 }),
    underlyingPrice: 100,
    contracts: 1,
  });
  assert.equal(liquid.liquidityScore, 100, '窄价差 + 高 OI + 高成交量 = 满分');
});

/* ─────────────────────────────── 候选筛选 ───────────────────────────────── */

function screenFixture(over: {
  quotes: OptionQuote[];
  underlyingPrice?: number;
  market?: OptionMarket;
  expiries?: OptionChainSnapshot['expiries'];
}): OptionChainSnapshot {
  return makeSnapshot({
    market: over.market ?? 'US',
    code: over.market === 'HK' ? '00700' : 'AAPL',
    currency: over.market === 'HK' ? 'HKD' : 'USD',
    underlyingPrice: over.underlyingPrice ?? 100,
    expiries: over.expiries,
    quotes: over.quotes,
  });
}

test('筛选：通过规则的候选按年化收益率降序，且带上服务端算好的指标', () => {
  const snapshot = screenFixture({
    quotes: [
      makeQuote({ code: 'C100', type: 'call', strike: 100, expiry: addDays(today, 14), bid: 1.5, ask: 1.6, delta: 0.3, openInterest: 800, volume: 200 }),
      makeQuote({ code: 'C105', type: 'call', strike: 105, expiry: addDays(today, 35), bid: 2.4, ask: 2.5, delta: 0.2, openInterest: 900, volume: 300 }),
    ],
  });
  const result = screenOptionCandidates({ snapshot, strategy: 'covered_call', contracts: 1, heldShares: 100 });
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates[0]!.metrics.annualizedYieldPct >= result.candidates[1]!.metrics.annualizedYieldPct, '必须按年化降序');
  assert.equal(result.candidates[0]!.strategy, 'covered_call');
  assert.equal(result.rejected.length, 0);
});

test('筛选：覆盖式卖 Call 股数不足直接拒绝并给出机器可读原因', () => {
  const snapshot = screenFixture({
    quotes: [makeQuote({ code: 'C105', type: 'call', strike: 105, expiry: addDays(today, 35), bid: 2.4, ask: 2.5, delta: 0.2, openInterest: 900 })],
  });
  const result = screenOptionCandidates({ snapshot, strategy: 'covered_call', contracts: 1, heldShares: 50 });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0]!.reason, /^insufficient_shares: /);
  assert.ok(result.rejected[0]!.reason.includes('裸卖'), '必须解释为什么不能卖（裸卖 Call 风险无上限）');
});

test('筛选：现金担保卖 Put 现金不足被拒；可用现金为 0 时不给候选并明确提示去设置页', () => {
  const quote = makeQuote({ type: 'put', strike: 90, expiry: addDays(today, 35), bid: 2, ask: 2.1, delta: 0.2, openInterest: 900 });
  const snapshot = screenFixture({ quotes: [quote], underlyingPrice: 100 });

  const notEnough = screenOptionCandidates({ snapshot, strategy: 'cash_secured_put', contracts: 1, availableCash: 5000 });
  assert.equal(notEnough.candidates.length, 0);
  assert.match(notEnough.rejected[0]!.reason, /^insufficient_cash: /);

  const notConfigured = screenOptionCandidates({ snapshot, strategy: 'cash_secured_put', contracts: 1, availableCash: 0 });
  assert.equal(notConfigured.candidates.length, 0);
  assert.ok(notConfigured.warnings.some((warning) => warning.includes('未填写')), notConfigured.warnings.join('|'));

  const ok = screenOptionCandidates({ snapshot, strategy: 'cash_secured_put', contracts: 1, availableCash: 9000 });
  assert.equal(ok.candidates.length, 1);
  assert.equal(ok.candidates[0]!.metrics.collateral, 9000);
});

test('筛选：港股允许「无买卖盘」的 EOD 合约进候选，但风险与降级全部写进 warnings', () => {
  const snapshot = screenFixture({
    market: 'HK',
    underlyingPrice: 620,
    quotes: [
      makeQuote({
        code: 'TCH-20260129-660-C',
        type: 'call',
        strike: 660,
        expiry: addDays(today, 30),
        bid: 0,
        ask: 0,
        mid: 0,
        last: 0,
        settlement: 9,
        delta: 0,
        iv: 0.4,
        multiplier: 100,
        openInterest: 300,
        volume: 0,
        spreadPct: 0,
      }),
    ],
    expiries: [{ expiry: addDays(today, 30), daysToExpiry: 30, contracts: 1, atmIv: 0.38 }],
  });
  const result = screenOptionCandidates({ snapshot, strategy: 'covered_call', contracts: 1, heldShares: 100 });
  assert.equal(result.candidates.length, 1, '港交所每日报告没有买卖盘是设计如此，不能因此拒掉全部港股合约');
  const merged = result.warnings.join('|');
  assert.ok(merged.includes('无买卖盘'), merged);
  assert.ok(merged.includes('估算'), merged);
  assert.ok(result.candidates[0]!.metrics.liquidityScore < 100, '价差档 0 分，不应给满分');
});

test('筛选：美股 delta 缺失时拒绝（不用 0 冒充「没有风险」）', () => {
  const snapshot = screenFixture({
    quotes: [makeQuote({ type: 'call', strike: 105, expiry: addDays(today, 35), bid: 2.4, ask: 2.5, delta: 0, openInterest: 900 })],
  });
  const result = screenOptionCandidates({ snapshot, strategy: 'covered_call', contracts: 1, heldShares: 100 });
  assert.equal(result.candidates.length, 0);
  assert.match(result.rejected[0]!.reason, /^delta_missing: /);
});

test('筛选：标的现价为 0 时不给任何候选（无法判断虚值幅度）', () => {
  const snapshot = screenFixture({
    underlyingPrice: 0,
    quotes: [makeQuote({ type: 'call', strike: 105, expiry: addDays(today, 35), bid: 2.4, ask: 2.5, delta: 0.2, openInterest: 900 })],
  });
  const result = screenOptionCandidates({ snapshot, strategy: 'covered_call', contracts: 1, heldShares: 100 });
  assert.equal(result.candidates.length, 0);
  assert.match(result.rejected[0]!.reason, /^underlying_price_missing: /);
});

test('筛选：年化低于下限被拒（原因机器可读）', () => {
  const snapshot = screenFixture({
    quotes: [makeQuote({ type: 'call', strike: 105, expiry: addDays(today, 70), bid: 0.3, ask: 0.32, delta: 0.1, openInterest: 900, volume: 50 })],
  });
  const result = screenOptionCandidates({ snapshot, strategy: 'covered_call', contracts: 1, heldShares: 100 });
  assert.equal(result.candidates.length, 0);
  assert.ok(
    result.rejected.some((entry) => entry.reason.startsWith('yield_below_min: ') || entry.reason.startsWith('premium_too_thin: ')),
    result.rejected.map((entry) => entry.reason).join('|'),
  );
});

test('筛选：每标的最多返回 maxCandidatesPerUnderlying 个', () => {
  const quotes: OptionQuote[] = [];
  for (let index = 0; index < 10; index += 1) {
    quotes.push(
      makeQuote({
        code: `C${105 + index}`,
        type: 'call',
        strike: 105 + index,
        expiry: addDays(today, 20 + index),
        bid: 2 + index * 0.1,
        ask: 2.1 + index * 0.1,
        delta: 0.2,
        openInterest: 900,
        volume: 300,
      }),
    );
  }
  const result = screenOptionCandidates({ snapshot: screenFixture({ quotes }), strategy: 'covered_call', contracts: 1, heldShares: 100 });
  assert.equal(result.candidates.length, OPTION_SCREEN_RULES.maxCandidatesPerUnderlying);
});

/* ─────────────────────────────── 方案构建 ───────────────────────────────── */

test('buildOptionAdvicePlan：指标服务端重算、口径原样带上、担保额不一致要告警', () => {
  // 差异超过 1%（且至少 1 元）才算口径不一致，才值得告警。
  const plan = buildOptionAdvicePlan({ ...coveredCallPlan(), collateral: 5000 });
  assert.equal(plan.premium, 2, '权利金取买价（卖方实际成交价）');
  assert.equal(plan.metrics.premiumIncome, 200);
  assert.equal(plan.metrics.collateral, 10_000, '担保以服务端重算值为准');
  assert.equal(plan.optionType, 'call');
  assert.equal(plan.dataSource, 'CBOE 延迟行情（测试夹具）');
  assert.equal(plan.delayed, true);
  assert.ok(plan.warnings.some((warning) => warning.includes('担保额')), plan.warnings.join('|'));
});

test('buildOptionAdvicePlan：acceptAssignment=false 的覆盖式卖 Call 必须给出语义警告', () => {
  const plan = buildOptionAdvicePlan({ ...coveredCallPlan(), acceptAssignment: false });
  assert.ok(plan.warnings.some((warning) => warning.includes('交股')), plan.warnings.join('|'));
});

test('buildOptionAdvicePlan：港股乘数未核对时，方案 warnings 明确写「未经核对」', () => {
  const expiry = addDays(today, 30);
  const quote = makeQuote({
    code: 'TCH-20260129-660-C',
    type: 'call',
    strike: 660,
    expiry,
    bid: 0,
    ask: 0,
    mid: 0,
    settlement: 9,
    delta: 0,
    iv: 0.4,
    multiplier: 100,
    spreadPct: 0,
    openInterest: 300,
  });
  const snapshot = makeSnapshot({
    market: 'HK',
    code: '00772',
    name: 'China Literature',
    currency: 'HKD',
    underlyingPrice: 620,
    quotes: [quote],
  });
  const plan = buildOptionAdvicePlan({
    strategy: 'covered_call',
    market: 'HK',
    // 0772 不在已核对的乘数表里 → 必须带「未经核对」warning（腾讯 00700 是已核对标的）。
    code: '00772',
    name: 'China Literature',
    quote,
    underlyingPrice: 620,
    contracts: 1,
    collateral: 62_000,
    collateralNote: '测试',
    snapshot,
    acceptAssignment: true,
  });
  assert.ok(plan.warnings.some((warning) => warning.includes('乘数未经核对')), plan.warnings.join('|'));
});

/* ─────────────────────────────── 持仓汇总 ───────────────────────────────── */

test('持仓汇总：在手权利金 / 已实现权利金 / 被行权次数 / 待确认数 / 分市场担保', () => {
  const rows = [
    makeContract({ id: 'c1', premiumIncome: 200, collateral: 10_000, status: 'open' }),
    makeContract({ id: 'c2', market: 'HK', currency: 'HKD', premiumIncome: 1500, collateral: 60_000, status: 'open', underlyingCode: '00700' }),
    makeContract({ id: 'c3', premiumIncome: 300, status: 'expired_otm' }),
    makeContract({ id: 'c4', premiumIncome: 400, status: 'assigned' }),
  ];
  const settlements = [
    { id: 's1', contractId: 'c4', status: 'pending_review' },
    { id: 's2', contractId: 'c3', status: 'auto_settled' },
  ] as OptionSettlementRow[];

  const summary = optionPortfolioSummary(rows, settlements);
  assert.equal(summary.openContracts, 2);
  assert.equal(summary.premiumIncome, 1700, '只算在手合约');
  assert.equal(summary.realizedPremium, 700, '已到期/已行权/已平仓的权利金');
  assert.equal(summary.assignedCount, 1);
  assert.equal(summary.pendingSettlements, 1);
  assert.deepEqual(summary.collateralByMarket, [
    { market: 'HK', currency: 'HKD', amount: 60_000 },
    { market: 'US', currency: 'USD', amount: 10_000 },
  ]);
});

/* ─────────────────────────── 到期结算：三条分支 ─────────────────────────── */

const AS_OF = '2026-01-20';
const EXPIRY = '2026-01-16';

function fixedReference(price: number, note = '测试夹具') {
  return async () => ({ price, priceSource: `${note} 日线收盘价 2026-01-16` });
}

test('结算分支①：明确虚值 → 自动入账（权利金落袋，不写股票流水）', async () => {
  const fake = useRepo();
  fake.contracts.push(makeContract({ id: 'c-otm', strike: 110, optionType: 'call', expiry: EXPIRY, premiumIncome: 200 }));

  const result = await scanOptionSettlements({ asOf: AS_OF, resolveReference: fixedReference(105) });
  assert.equal(result.scanned, 1);
  assert.equal(result.autoSettled, 1);
  assert.equal(result.settlements.length, 1);
  const settlement = fake.settlements[0]!;
  assert.equal(settlement.verdict, 'otm_no_assignment');
  assert.equal(settlement.status, 'auto_settled');
  assert.equal(settlement.action, 'none');
  assert.equal(settlement.referencePrice, 105);
  assert.ok(settlement.priceSource.includes('2026-01-16'), settlement.priceSource);
  assert.equal(settlement.realizedPnl, 200);
  assert.equal(fake.transactions.length, 0, '虚值到期没有股票交割，绝不写流水');
  assert.equal(fake.contracts[0]!.status, 'expired_otm');
  assert.equal(fake.contracts[0]!.realizedPnl, 200);
});

test('结算分支②：明确实值 → 覆盖式卖 Call 自动交股（写 sell 流水，价格=行权价，source=option）', async () => {
  const fake = useRepo();
  fake.assets.push(makeAsset({ id: 'asset-1' }));
  fake.transactions.push({
    id: 'buy-1',
    assetId: 'asset-1',
    kind: 'buy',
    shares: 100,
    price: 100,
    fee: 0,
    tradeDate: '2025-11-03',
    note: '',
    source: 'manual',
    createdAt: '2025-11-03T09:30:00.000+08:00',
  });
  fake.contracts.push(
    makeContract({ id: 'c-itm', strike: 110, optionType: 'call', expiry: EXPIRY, premiumIncome: 200, underlyingAssetId: 'asset-1' }),
  );

  const result = await scanOptionSettlements({ asOf: AS_OF, resolveReference: fixedReference(115) });
  assert.equal(result.autoSettled, 1);
  const settlement = fake.settlements[0]!;
  assert.equal(settlement.verdict, 'assigned');
  assert.equal(settlement.status, 'auto_settled');
  assert.equal(settlement.action, 'shares_delivered');
  assert.equal(settlement.itmAmount, 5);
  assert.ok(settlement.note.includes('参考价'), settlement.note);

  assert.equal(fake.transactions.length, 2);
  const delivery = fake.transactions[1]!;
  assert.equal(delivery.kind, 'sell');
  assert.equal(delivery.shares, 100);
  assert.equal(delivery.price, 110);
  assert.equal(delivery.source, 'option');
  assert.equal(delivery.tradeDate, EXPIRY);
  assert.ok(delivery.note.includes('期权行权交股'), delivery.note);
  assert.equal(settlement.transactionId, delivery.id);
  // realizedPnl = 权利金 200 + 股票端 (110 − 100) × 100
  assert.equal(settlement.realizedPnl, 1200);
  assert.equal(fake.contracts[0]!.status, 'assigned');
});

test('结算分支②b：现金担保卖 Put 被行权 → 自动收股（写 buy 流水，并新建资产）', async () => {
  const fake = useRepo();
  fake.contracts.push(
    makeContract({
      id: 'c-put',
      strategy: 'cash_secured_put',
      optionType: 'put',
      strike: 90,
      collateralKind: 'cash',
      collateral: 9000,
      premiumIncome: 250,
      underlyingAssetId: null,
    }),
  );

  const result = await scanOptionSettlements({ asOf: AS_OF, resolveReference: fixedReference(85) });
  assert.equal(result.autoSettled, 1);
  const settlement = fake.settlements[0]!;
  assert.equal(settlement.action, 'shares_received');
  assert.equal(settlement.realizedPnl, 250, '收股按 0 计股票端盈亏，只实现权利金');
  assert.equal(fake.assets.length, 1, '收股必须建资产（否则持仓凭空消失）');
  const buy = fake.transactions[0]!;
  assert.equal(buy.kind, 'buy');
  assert.equal(buy.shares, 100);
  assert.equal(buy.price, 90);
  assert.equal(buy.source, 'option');
  assert.equal(fake.contracts[0]!.status, 'assigned');
});

test('结算分支③：价格贴行权价（存疑带内）→ 只落待确认，不写流水、合约保持 open', async () => {
  const fake = useRepo();
  fake.contracts.push(makeContract({ id: 'c-band', strike: 110, optionType: 'call', expiry: EXPIRY, premiumIncome: 200 }));

  const result = await scanOptionSettlements({ asOf: AS_OF, resolveReference: fixedReference(110.2) });
  assert.equal(result.autoSettled, 0);
  assert.equal(result.pendingReview, 1);
  const settlement = fake.settlements[0]!;
  assert.equal(settlement.verdict, 'uncertain');
  assert.equal(settlement.status, 'pending_review');
  assert.equal(settlement.action, 'pending');
  assert.ok(settlement.note.includes('存疑带'), settlement.note);
  assert.equal(fake.transactions.length, 0);
  assert.equal(fake.contracts[0]!.status, 'open', '待确认时合约仍是持有中，避免「已到期却未入账」的矛盾显示');
});

test('结算：取不到参考价 → uncertain + 待确认（不用 0 或猜测值掩盖）', async () => {
  const fake = useRepo();
  fake.contracts.push(makeContract({ id: 'c-noprice', expiry: EXPIRY }));
  const result = await scanOptionSettlements({
    asOf: AS_OF,
    resolveReference: async () => ({ price: 0, priceSource: '未取得参考价（夹具）' }),
  });
  assert.equal(result.pendingReview, 1);
  assert.equal(fake.settlements[0]!.verdict, 'uncertain');
  assert.equal(fake.settlements[0]!.referencePrice, 0);
  assert.ok(fake.settlements[0]!.priceSource.includes('未取得参考价'));
  assert.equal(result.warnings.length, 0, '解析器自己带回的 warning 才进 warnings');
});

test('结算：持股不足交股 → 转待确认并写明缺口，绝不写负持仓流水', async () => {
  const fake = useRepo();
  fake.assets.push(makeAsset({ id: 'asset-1' }));
  fake.transactions.push({
    id: 'buy-1',
    assetId: 'asset-1',
    kind: 'buy',
    shares: 50,
    price: 100,
    fee: 0,
    tradeDate: '2025-11-03',
    note: '',
    source: 'manual',
    createdAt: '2025-11-03T09:30:00.000+08:00',
  });
  fake.contracts.push(makeContract({ id: 'c-gap', strike: 110, optionType: 'call', expiry: EXPIRY, underlyingAssetId: 'asset-1' }));

  const result = await scanOptionSettlements({ asOf: AS_OF, resolveReference: fixedReference(120) });
  assert.equal(result.autoSettled, 0);
  assert.equal(result.pendingReview, 1);
  const settlement = fake.settlements[0]!;
  assert.equal(settlement.verdict, 'assigned');
  assert.equal(settlement.status, 'pending_review');
  assert.ok(settlement.note.includes('缺口 50'), settlement.note);
  assert.equal(fake.transactions.length, 1, '只保留原有的买入流水');
  assert.equal(fake.contracts[0]!.status, 'open');
});

test('结算：manual 模式只落待确认，不自动入账', async () => {
  const fake = useRepo({ mode: 'manual' });
  fake.assets.push(makeAsset({ id: 'asset-1' }));
  fake.contracts.push(makeContract({ id: 'c-manual', strike: 110, optionType: 'call', expiry: EXPIRY, underlyingAssetId: 'asset-1' }));
  const result = await scanOptionSettlements({ asOf: AS_OF, resolveReference: fixedReference(90) });
  assert.equal(result.autoSettled, 0);
  assert.equal(result.pendingReview, 1);
  assert.equal(fake.settlements[0]!.verdict, 'otm_no_assignment', '结论明确，但 manual 模式不自动入账');
  assert.equal(fake.settlements[0]!.status, 'pending_review');
  assert.equal(fake.contracts[0]!.status, 'open');
});

test('结算幂等：重复扫描不重复写流水、结算记录只有一条、不重复计数', async () => {
  const fake = useRepo();
  fake.assets.push(makeAsset({ id: 'asset-1' }));
  fake.transactions.push({
    id: 'buy-1',
    assetId: 'asset-1',
    kind: 'buy',
    shares: 100,
    price: 100,
    fee: 0,
    tradeDate: '2025-11-03',
    note: '',
    source: 'manual',
    createdAt: '2025-11-03T09:30:00.000+08:00',
  });
  fake.contracts.push(makeContract({ id: 'c-idem', strike: 110, optionType: 'call', expiry: EXPIRY, underlyingAssetId: 'asset-1' }));

  const first = await scanOptionSettlements({ asOf: AS_OF, resolveReference: fixedReference(115) });
  assert.equal(first.autoSettled, 1);
  const txAfterFirst = fake.transactions.length;
  assert.equal(txAfterFirst, 2);
  assert.equal(fake.settlements.length, 1);

  // force 也不能重复入账（流水只写一次），跳过的是「已 auto_settled」，连参考价都不再取。
  const second = await scanOptionSettlements({ asOf: AS_OF, force: true, resolveReference: fixedReference(115) });
  assert.equal(second.autoSettled, 0);
  assert.equal(second.pendingReview, 0);
  assert.equal(fake.transactions.length, txAfterFirst, '第二次扫描不得新增流水');
  assert.equal(fake.settlements.length, 1, '结算记录按 contract_id 幂等，只有一条');
  assert.equal(fake.contracts[0]!.status, 'assigned');
});

test('结算幂等：同一天重复扫描不再重复取价（避免 30s 定时器反复打上游）', async () => {
  const fake = useRepo();
  // 用「贴行权价」的合约让它留在 pending_review：这样才能观察到 force 是否重新取价。
  // 用默认 asOf（今天）：生产里定时器就是这么调的，evaluatedAt 与 asOf 同一天才走短路。
  fake.contracts.push(makeContract({ id: 'c-cache', strike: 110, expiry: '2020-01-17' }));
  let calls = 0;
  const counting = async () => {
    calls += 1;
    return { price: 110.2, priceSource: '夹具（贴行权价）' };
  };
  await scanOptionSettlements({ resolveReference: counting });
  await scanOptionSettlements({ resolveReference: counting });
  assert.equal(calls, 1);
  await scanOptionSettlements({ force: true, resolveReference: counting });
  assert.equal(calls, 2, 'force 才会重新取价');
  assert.equal(fake.settlements.length, 1, '重新取价也只更新同一条记录');
  assert.equal(fake.settlements[0]!.status, 'pending_review');
});

test('结算：settlementMode 取自设置（manual 时即使结论明确也不入账）', async () => {
  const fake = useRepo({ mode: 'manual' });
  fake.contracts.push(makeContract({ id: 'c-mode', strike: 110, expiry: EXPIRY }));
  const result = await scanOptionSettlements({ asOf: AS_OF, resolveReference: fixedReference(105) });
  assert.equal(result.autoSettled, 0);
  assert.equal(result.pendingReview, 1);
  assert.equal(fake.settlements[0]!.status, 'pending_review');
  assert.equal(fake.transactions.length, 0);
});

test('结算：只处理 expiry ≤ asOf 的 open 合约（未到期/已平仓不碰）', async () => {
  const fake = useRepo();
  fake.contracts.push(makeContract({ id: 'c-future', expiry: '2026-02-20' }));
  fake.contracts.push(makeContract({ id: 'c-closed', expiry: EXPIRY, status: 'closed' }));
  const result = await scanOptionSettlements({ asOf: AS_OF, resolveReference: fixedReference(130) });
  assert.equal(result.scanned, 0);
  assert.equal(fake.settlements.length, 0);
});

test('结算：contractId 指定单个合约；未到期时明确说明原因', async () => {
  const fake = useRepo();
  fake.contracts.push(makeContract({ id: 'c-one', expiry: '2026-03-20' }));
  const result = await scanOptionSettlements({ asOf: AS_OF, contractId: 'c-one', resolveReference: fixedReference(130) });
  assert.equal(result.scanned, 0);
  assert.ok(result.warnings.some((warning) => warning.includes('还未到')), result.warnings.join('|'));
});

test('结算：合约乘数缺失/为 0 → 不出结论（转人工，且绝不写交割流水）', async () => {
  const fake = useRepo();
  fake.assets.push(makeAsset({ id: 'asset-1' }));
  fake.transactions.push({
    id: 'buy-1',
    assetId: 'asset-1',
    kind: 'buy',
    shares: 500,
    price: 100,
    fee: 0,
    tradeDate: '2025-11-03',
    note: '',
    source: 'manual',
    createdAt: '2025-11-03T09:30:00.000+08:00',
  });
  // 乘数 0 的脏数据：按 1 股兜底会把「交 500 股」写成「交 1 股」，必须转人工。
  fake.contracts.push(
    makeContract({ id: 'c-bad-mult', strike: 110, optionType: 'call', expiry: EXPIRY, multiplier: 0, underlyingAssetId: 'asset-1' }),
  );

  const result = await scanOptionSettlements({ asOf: AS_OF, resolveReference: fixedReference(120) });
  assert.equal(result.autoSettled, 0);
  assert.equal(result.pendingReview, 1);
  const settlement = fake.settlements[0]!;
  assert.equal(settlement.verdict, 'uncertain');
  assert.equal(settlement.status, 'pending_review');
  assert.equal(settlement.action, 'pending');
  assert.ok(settlement.note.includes('乘数缺失'), settlement.note);
  assert.equal(settlement.transactionId, null);
  assert.equal(fake.transactions.length, 1, '只保留原有买入流水，绝不能写错误的交割股数');
  assert.equal(fake.contracts[0]!.status, 'open');
  assert.ok(result.warnings.some((warning) => warning.includes('multiplier=0')), result.warnings.join('|'));
});

test('结算：收股时建资产失败 → 转人工且不写重复买入流水（不 500）', async () => {
  const fake = useRepo();
  fake.contracts.push(
    makeContract({
      id: 'c-put-clash',
      strategy: 'cash_secured_put',
      optionType: 'put',
      strike: 90,
      collateralKind: 'cash',
      collateral: 9000,
      premiumIncome: 250,
      underlyingAssetId: null,
    }),
  );
  // 模拟唯一约束冲突且 findAsset 也命中不到（更刁钻的情况：行在、但查不到）。
  (fake.repo as unknown as { createAsset: () => never }).createAsset = () => {
    throw new AppError(409, 'CONFLICT', '资产已存在：AAPL（US/stock）');
  };

  const result = await scanOptionSettlements({ asOf: AS_OF, resolveReference: fixedReference(85) });
  assert.equal(result.autoSettled, 0);
  assert.equal(result.pendingReview, 1);
  const settlement = fake.settlements[0]!;
  assert.equal(settlement.verdict, 'assigned', '结论明确（实值行权），但入账失败要转人工');
  assert.equal(settlement.status, 'pending_review');
  assert.ok(settlement.note.includes('未写任何流水'), settlement.note);
  assert.equal(fake.transactions.length, 0, '入账失败时一笔流水都不能写');
  assert.equal(fake.contracts[0]!.status, 'open');
});

test('confirmOptionSettlement：人工确认后状态是 confirmed（不是 auto_settled），重复确认保持原状态且不重复写流水', async () => {
  const fake = useRepo({ mode: 'manual' });
  fake.assets.push(makeAsset({ id: 'asset-1' }));
  fake.transactions.push({
    id: 'buy-1',
    assetId: 'asset-1',
    kind: 'buy',
    shares: 100,
    price: 100,
    fee: 0,
    tradeDate: '2025-11-03',
    note: '',
    source: 'manual',
    createdAt: '2025-11-03T09:30:00.000+08:00',
  });
  fake.contracts.push(
    makeContract({ id: 'c-confirmed', strike: 110, optionType: 'call', expiry: EXPIRY, underlyingAssetId: 'asset-1' }),
  );

  // manual 模式 → 扫描只落待确认
  const scan = await scanOptionSettlements({ asOf: AS_OF, resolveReference: fixedReference(120) });
  assert.equal(scan.pendingReview, 1);
  assert.equal(fake.settlements[0]!.status, 'pending_review');
  assert.equal(fake.transactions.length, 1);

  // 用户点「确认并入账」→ 必须落 confirmed（界面要能区分「我确认过」和「系统自动入账」）
  const confirmed = confirmOptionSettlement({ id: fake.settlements[0]!.id, verdict: 'assigned', referencePrice: 120, note: '券商对账单' });
  assert.equal(confirmed.settlements[0]!.status, 'confirmed');
  assert.equal(confirmed.autoSettled, 1);
  assert.equal(fake.settlements[0]!.status, 'confirmed');
  assert.equal(fake.contracts[0]!.status, 'assigned');
  const txAfterConfirm = fake.transactions.length;
  assert.equal(txAfterConfirm, 2, '确认后按行权价写一笔卖出流水');

  // 再确认一次：保持 confirmed，不重复写流水、不新增结算记录
  const again = confirmOptionSettlement({ id: fake.settlements[0]!.id, verdict: 'otm_no_assignment' });
  assert.equal(again.settlements[0]!.status, 'confirmed', '幂等：后一次判定不得改写人工确认的结论');
  assert.equal(again.autoSettled, 0);
  assert.ok(again.warnings.some((warning) => warning.includes('幂等')), again.warnings.join('|'));
  assert.equal(fake.transactions.length, txAfterConfirm, '重复确认不得写第二笔流水');
  assert.equal(fake.settlements.length, 1);
});

test('confirmOptionSettlement：虚值落袋的人工确认同样是 confirmed，且不写股票流水', async () => {
  const fake = useRepo({ mode: 'manual' });
  fake.contracts.push(makeContract({ id: 'c-otm-confirm', strike: 110, expiry: EXPIRY, premiumIncome: 200 }));
  await scanOptionSettlements({ asOf: AS_OF, resolveReference: fixedReference(100) });

  const confirmed = confirmOptionSettlement({ id: fake.settlements[0]!.id, verdict: 'otm_no_assignment', referencePrice: 100 });
  assert.equal(confirmed.settlements[0]!.status, 'confirmed');
  assert.equal(confirmed.settlements[0]!.action, 'none');
  assert.equal(fake.transactions.length, 0);
  assert.equal(fake.contracts[0]!.status, 'expired_otm');
  assert.equal(fake.contracts[0]!.realizedPnl, 200);
  assert.equal(fake.settlements[0]!.status, 'confirmed');
});

/* ──────────────────────────── 确认建议（写合约） ─────────────────────────── */

test('confirmOptionAdvice：按弹窗最终值入账，担保额服务端重算，开仓不写 transactions', () => {
  const fake = useRepo();
  fake.assets.push(makeAsset({ id: 'asset-1', price: 100 }));
  fake.transactions.push({
    id: 'buy-1',
    assetId: 'asset-1',
    kind: 'buy',
    shares: 300,
    price: 100,
    fee: 0,
    tradeDate: '2025-11-03',
    note: '',
    source: 'manual',
    createdAt: '2025-11-03T09:30:00.000+08:00',
  });
  const plan = buildOptionAdvicePlan(coveredCallPlan({ contracts: 2 }));
  fake.advice.push(makeAdvice({ id: 'advice-1', option: plan, targetShares: 200, targetPrice: 2 }));

  const result = confirmOptionAdvice({
    adviceId: 'advice-1',
    input: { contracts: 2, premium: 2.5, expiry: plan.expiry, fee: 1, note: '确认成交' },
  });

  assert.equal(result.advice.status, 'confirmed');
  assert.equal(result.advice.executedShares, 200, '法定股数 = 乘数 × 张数');
  assert.equal(result.advice.executedPrice, 2.5, 'executedPrice = 最终每股价权利金');
  assert.equal(fake.contracts.length, 1);
  const contract = fake.contracts[0]!;
  assert.equal(contract.contracts, 2);
  assert.equal(contract.premium, 2.5);
  assert.equal(contract.premiumIncome, 499, '2.5 × 100 × 2 − 1');
  assert.equal(contract.collateral, 20_000, '持股市值 = 现价 100 × 100 × 2（前端数字一律不采信）');
  assert.equal(contract.collateralKind, 'shares');
  assert.equal(contract.underlyingAssetId, 'asset-1');
  assert.equal(contract.status, 'open');
  assert.ok(contract.note.includes('确认成交'), contract.note);
  assert.equal(fake.transactions.length, 1, '开仓只有权利金流入，不写股票流水');
});

test('confirmOptionAdvice：同一建议重复确认幂等（返回已存在合约，不写第二份）', () => {
  const fake = useRepo();
  fake.assets.push(makeAsset({ id: 'asset-1' }));
  fake.transactions.push({
    id: 'buy-1',
    assetId: 'asset-1',
    kind: 'buy',
    shares: 100,
    price: 100,
    fee: 0,
    tradeDate: '2025-11-03',
    note: '',
    source: 'manual',
    createdAt: '2025-11-03T09:30:00.000+08:00',
  });
  const plan = buildOptionAdvicePlan(coveredCallPlan());
  fake.advice.push(makeAdvice({ id: 'advice-idem', option: plan }));

  const first = confirmOptionAdvice({ adviceId: 'advice-idem', input: { contracts: 1, premium: 2, expiry: plan.expiry } });
  const second = confirmOptionAdvice({ adviceId: 'advice-idem', input: { contracts: 1, premium: 2, expiry: plan.expiry } });

  assert.equal(second.position.id, first.position.id);
  assert.equal(fake.contracts.length, 1);
  assert.equal(second.warnings.some((warning) => warning.includes('幂等')), true);
  assert.equal(fake.advice[0]!.status, 'confirmed');
});

test('confirmOptionAdvice：持股不足直接拒绝并给出最多可卖张数（裸卖 Call 必须拦住）', () => {
  const fake = useRepo();
  fake.assets.push(makeAsset({ id: 'asset-1' }));
  fake.transactions.push({
    id: 'buy-1',
    assetId: 'asset-1',
    kind: 'buy',
    shares: 100,
    price: 100,
    fee: 0,
    tradeDate: '2025-11-03',
    note: '',
    source: 'manual',
    createdAt: '2025-11-03T09:30:00.000+08:00',
  });
  const plan = buildOptionAdvicePlan(coveredCallPlan());
  fake.advice.push(makeAdvice({ id: 'advice-short', option: plan }));

  assert.throws(
    () => confirmOptionAdvice({ adviceId: 'advice-short', input: { contracts: 3, premium: 2, expiry: plan.expiry } }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 409);
      const details = error.details as { maxContracts: number; requiredShares: number; heldShares: number };
      assert.equal(details.requiredShares, 300);
      assert.equal(details.heldShares, 100);
      assert.equal(details.maxContracts, 1);
      return true;
    },
  );
  assert.equal(fake.contracts.length, 0, '被拒绝时不得写库');
});

test('confirmOptionAdvice：现金担保不足（或未填写）直接拒绝', () => {
  const fake = useRepo({ cash: { HK: 0, US: 5000 } });
  const expiry = addDays(today, 30);
  const quote = makeQuote({ type: 'put', strike: 90, expiry, bid: 2, ask: 2.1, delta: 0.2 });
  const snapshot = makeSnapshot({ underlyingPrice: 100, quotes: [quote] });
  const plan = buildOptionAdvicePlan({
    strategy: 'cash_secured_put',
    market: 'US',
    code: 'AAPL',
    quote,
    underlyingPrice: 100,
    contracts: 1,
    collateral: 9000,
    collateralNote: '现金担保',
    snapshot,
    acceptAssignment: true,
  });
  fake.advice.push(makeAdvice({ id: 'advice-cash', option: plan, instrument: 'option' }));

  assert.throws(
    () => confirmOptionAdvice({ adviceId: 'advice-cash', input: { contracts: 1, premium: 2, expiry } }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /可用现金/);
      return true;
    },
  );

  // 可用现金为 0 = 未填写，必须提示去设置页（不是「没有风险」）。
  const broke = useRepo({ cash: { HK: 0, US: 0 } });
  broke.advice.push(makeAdvice({ id: 'advice-cash', option: plan, instrument: 'option' }));
  assert.throws(
    () => confirmOptionAdvice({ adviceId: 'advice-cash', input: { contracts: 1, premium: 2, expiry } }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.match(error.message, /未填写/);
      return true;
    },
  );
});

test('confirmOptionAdvice：非期权建议 / 张数非法直接 400；已驳回的建议不能确认', () => {
  const fake = useRepo();
  fake.advice.push(makeAdvice({ id: 'advice-stock', instrument: 'stock', option: null }));
  assert.throws(
    () => confirmOptionAdvice({ adviceId: 'advice-stock', input: { contracts: 1, premium: 2, expiry: addDays(today, 30) } }),
    (error: unknown) => error instanceof AppError && error.statusCode === 400,
  );

  const plan = buildOptionAdvicePlan(coveredCallPlan());
  fake.assets.push(makeAsset({ id: 'asset-1' }));
  fake.transactions.push({
    id: 'buy-1',
    assetId: 'asset-1',
    kind: 'buy',
    shares: 100,
    price: 100,
    fee: 0,
    tradeDate: '2025-11-03',
    note: '',
    source: 'manual',
    createdAt: '2025-11-03T09:30:00.000+08:00',
  });
  fake.advice.push(makeAdvice({ id: 'advice-bad', option: plan }));
  assert.throws(
    () => confirmOptionAdvice({ adviceId: 'advice-bad', input: { contracts: 1.5, premium: 2, expiry: plan.expiry } }),
    (error: unknown) => error instanceof AppError && error.statusCode === 400,
  );
  assert.throws(
    () => confirmOptionAdvice({ adviceId: 'advice-bad', input: { contracts: 0, premium: 2, expiry: plan.expiry } }),
    (error: unknown) => error instanceof AppError && error.statusCode === 400,
  );

  const rejected = makeAdvice({ id: 'advice-rejected', option: plan, status: 'rejected' });
  fake.advice.push(rejected);
  assert.throws(
    () => confirmOptionAdvice({ adviceId: 'advice-rejected', input: { contracts: 1, premium: 2, expiry: plan.expiry } }),
    (error: unknown) => error instanceof AppError && error.statusCode === 409,
  );
});

/* ─────────────────────────────── 提前买平 ───────────────────────────────── */

test('closeOptionPosition：已实现盈亏 = 权利金收入 − 买平成本；重复买平 409', () => {
  const fake = useRepo();
  fake.contracts.push(makeContract({ id: 'c-close', premiumIncome: 200, premium: 2, multiplier: 100, contracts: 1, status: 'open' }));

  const closed = closeOptionPosition({ id: 'c-close', price: 0.5, fee: 1, tradeDate: '2026-01-05' });
  assert.equal(closed.status, 'closed');
  assert.equal(closed.closePrice, 0.5);
  assert.equal(closed.realizedPnl, 149, '200 − (0.5 × 100 + 1)');
  assert.ok(closed.note.includes('买平'), closed.note);
  assert.throws(() => closeOptionPosition({ id: 'c-close', price: 0.6 }), (error: unknown) => error instanceof AppError && error.statusCode === 409);
});

/* ─────────────────────── 演示：快照 + 持仓 → 候选清单 ───────────────────── */

test('演示：手工构造 OptionChainSnapshot 与持仓，打印候选、年化收益率与担保额', () => {
  // 这段「演示脚本」同时是一个回归用例：
  //  - 持仓（300 股 AAPL）决定 covered_call 能卖几张；
  //  - 现金设置决定 cash_secured_put 的担保是否够；
  //  - 打印出来的数字全部来自服务端计算，不接受调用方传入。
  const expiries = [addDays(today, 21), addDays(today, 49)];
  const quotes: OptionQuote[] = [
    makeQuote({ code: 'AAPL0001C105', type: 'call', strike: 105, expiry: expiries[0]!, bid: 1.6, ask: 1.68, delta: 0.26, openInterest: 2400, volume: 800 }),
    makeQuote({ code: 'AAPL0001C110', type: 'call', strike: 110, expiry: expiries[0]!, bid: 0.85, ask: 0.92, delta: 0.16, openInterest: 1800, volume: 500 }),
    makeQuote({ code: 'AAPL0002C110', type: 'call', strike: 110, expiry: expiries[1]!, bid: 1.9, ask: 2.0, delta: 0.2, openInterest: 3100, volume: 900 }),
    makeQuote({ code: 'AAPL0001P95', type: 'put', strike: 95, expiry: expiries[0]!, bid: 1.1, ask: 1.2, delta: 0.22, openInterest: 1500, volume: 400 }),
    makeQuote({ code: 'AAPL0002P95', type: 'put', strike: 95, expiry: expiries[1]!, bid: 2.2, ask: 2.3, delta: 0.24, openInterest: 2200, volume: 700 }),
  ];
  const snapshot = makeSnapshot({ underlyingPrice: 100, expiries: expiries.map((expiry) => ({ expiry, daysToExpiry: calendarGap(expiry), contracts: 2, atmIv: 0.28 })), quotes });

  const heldShares = 300;
  const availableCash = 20_000;

  for (const strategy of ['covered_call', 'cash_secured_put'] as OptionStrategy[]) {
    const result = screenOptionCandidates({ snapshot, strategy, contracts: 1, heldShares, availableCash });
    const label = strategy === 'covered_call' ? '覆盖式卖 Call（担保=持股市值）' : '现金担保卖 Put（担保=行权价×乘数）';
    console.log(`\n[演示] ${snapshot.code} 现价 ${snapshot.underlyingPrice} ${snapshot.currency} · ${label} · 持股 ${heldShares} 股 / 可用现金 ${availableCash}`);
    console.log('  合约              行权价  剩余天  权利金/张  权利金收入  担保额    静态%   年化%   被行权概率  流动分  盈亏平衡');
    for (const candidate of result.candidates) {
      const metrics = candidate.metrics;
      console.log(
        `  ${candidate.quote.code.padEnd(16)} ${String(candidate.quote.strike).padStart(5)}  ${String(calendarGap(candidate.quote.expiry)).padStart(5)}  ` +
          `${String(candidate.quote.bid).padStart(9)}  ${String(metrics.premiumIncome).padStart(9)}  ${String(metrics.collateral).padStart(8)}  ` +
          `${String(metrics.staticYieldPct).padStart(6)}  ${String(metrics.annualizedYieldPct).padStart(6)}  ` +
          `${String(round(metrics.assignmentProbability * 100)).padStart(9)}%  ${String(metrics.liquidityScore).padStart(6)}  ${String(metrics.breakeven).padStart(8)}`,
      );
    }
    if (result.candidates.length === 0) console.log('  （无候选）');
    for (const warning of result.warnings) console.log(`  ! ${warning}`);
    for (const rejected of result.rejected.slice(0, 3)) console.log(`  ✗ ${rejected.code}: ${rejected.reason}`);
  }

  // 覆盖式卖 Call 需要 100 股/张 → 300 股最多 3 张；演示里按 1 张对比，故必然有候选。
  const covered = screenOptionCandidates({ snapshot, strategy: 'covered_call', contracts: 1, heldShares, availableCash });
  assert.ok(covered.candidates.length >= 1);
  // 现金担保卖 Put 需要 95 × 100 = 9500/张，20000 现金只够 2 张。
  const shortPut = screenOptionCandidates({ snapshot, strategy: 'cash_secured_put', contracts: 3, heldShares, availableCash });
  assert.equal(shortPut.candidates.length, 0);
  const cashRejects = shortPut.rejected.filter((entry) => /P\d+$/.test(entry.code));
  assert.equal(cashRejects.length, 2);
  assert.ok(cashRejects.every((entry) => entry.reason.startsWith('insufficient_cash: ')), cashRejects.map((entry) => entry.reason).join('|'));
});