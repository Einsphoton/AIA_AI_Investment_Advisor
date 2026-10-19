/**
 * 期权卖权 HTTP 路由测试（契约 §C）。
 *
 * 用 Fastify `inject` + 内存假仓库：不碰网络（`AIA_OFFLINE=1`）、不碰真实 SQLite，
 * 因此这些用例只验证「路由契约 + 服务层协作」，真库路径由 repo.test.ts / api.test.ts 覆盖。
 *
 * 覆盖：参数校验（400）、离线降级（502 / warnings）、201/202 状态码、
 * 结算三条分支与状态过滤、人工确认/忽略的幂等与 409 冲突、建议确认的幂等。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';

import type {
  OptionChainSnapshot,
  OptionMarket,
  OptionQuote,
  OptionSettings,
  OptionType,
} from '@aia/shared';
import { US_OPTION_MULTIPLIER } from '@aia/shared';

import { AppError } from '../src/errors.js';
import { setServices } from '../src/registry.js';
import { registerOptionRoutes } from '../src/routes/options.js';
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
import { buildOptionAdvicePlan } from '../src/services/options.js';

/* ─────────────────────────────── 假仓库（内存） ───────────────────────────── */

interface FakeRepo {
  repo: Repo;
  assets: AssetRow[];
  transactions: TxRow[];
  contracts: OptionContractRow[];
  settlements: OptionSettlementRow[];
  advice: AdviceRow[];
}

function makeFakeRepo(cash: { HK: number; US: number } = { HK: 0, US: 0 }): FakeRepo {
  const assets: AssetRow[] = [];
  const transactions: TxRow[] = [];
  const contracts: OptionContractRow[] = [];
  const settlements: OptionSettlementRow[] = [];
  const advice: AdviceRow[] = [];
  const settings: OptionSettings = { cash, settlementMode: 'auto', runWithPipeline: true };

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
    listAdvice: (): AdviceRow[] => [...advice],
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

  return { repo: repo as unknown as Repo, assets, transactions, contracts, settlements, advice };
}

/* ─────────────────────────────── 测试夹具 ────────────────────────────────── */

const today = localDate();

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function makeQuote(over: Partial<OptionQuote> & { type: OptionType; strike: number; expiry: string }): OptionQuote {
  const bid = over.bid ?? 2;
  const ask = over.ask ?? 2.1;
  const mid = (bid + ask) / 2;
  return {
    code: over.code ?? 'AAPL260116C00110000',
    type: over.type,
    strike: over.strike,
    expiry: over.expiry,
    bid,
    ask,
    last: 0,
    settlement: 0,
    iv: over.iv ?? 0.3,
    delta: over.delta ?? 0.2,
    openInterest: over.openInterest ?? 500,
    volume: over.volume ?? 100,
    multiplier: over.multiplier ?? US_OPTION_MULTIPLIER,
    mid: over.mid ?? Math.round(mid * 10_000) / 10_000,
    spreadPct: over.spreadPct ?? Math.round(((ask - bid) / mid) * 10_000) / 100,
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
    multiplier: over.multiplier ?? US_OPTION_MULTIPLIER,
    currency: over.currency ?? 'USD',
    premium: over.premium ?? 2,
    fee: over.fee ?? 0,
    premiumIncome: over.premiumIncome ?? 200,
    collateralKind: over.collateralKind ?? 'shares',
    collateral: over.collateral ?? 10_000,
    underlyingPriceAtOpen: over.underlyingPriceAtOpen ?? 100,
    status: over.status ?? 'open',
    openedAt: over.openedAt ?? '2025-12-01T09:30:00.000+08:00',
    closedAt: null,
    closePrice: null,
    realizedPnl: null,
    note: over.note ?? '',
    createdAt: over.createdAt ?? '2025-12-01T09:30:00.000+08:00',
    updatedAt: over.updatedAt ?? '2025-12-01T09:30:00.000+08:00',
  };
}

function makeAdvice(over: Partial<AdviceRow> = {}): AdviceRow {
  return {
    id: over.id ?? 'advice-1',
    batchId: 'batch-1',
    assetId: over.assetId ?? 'asset-1',
    watchItemId: null,
    assetName: 'Apple',
    code: over.code ?? 'AAPL',
    market: over.market ?? 'US',
    type: over.type ?? 'stock',
    instrument: over.instrument ?? 'option',
    action: over.action ?? 'sell',
    targetShares: over.targetShares ?? 100,
    targetPrice: over.targetPrice ?? 2,
    currency: 'USD',
    reason: '测试',
    confidence: 0.6,
    status: over.status ?? 'pending',
    executedShares: null,
    executedPrice: null,
    createdAt: nowIso(),
    decidedAt: null,
    option: over.option ?? null,
  };
}

/* ─────────────────────────────── 生命周期 ───────────────────────────────── */

let app: FastifyInstance;
let fake: FakeRepo;
const previousOffline = process.env.AIA_OFFLINE;

before(async () => {
  process.env.AIA_OFFLINE = '1'; // 全部用例离线，避免任何真实网络请求
  app = Fastify({ logger: false });
  // 复刻 app.ts 的 AppError 分支：否则 AppError 会被 Fastify 当成 500。
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    reply.code(error.statusCode ?? 500).send({ error: { code: 'INTERNAL_ERROR', message: error.message } });
  });
  await registerOptionRoutes(app);
  await app.ready();
});

after(async () => {
  await app.close();
  if (previousOffline === undefined) delete process.env.AIA_OFFLINE;
  else process.env.AIA_OFFLINE = previousOffline;
});

function useRepo(cash: { HK: number; US: number } = { HK: 0, US: 0 }): FakeRepo {
  fake = makeFakeRepo(cash);
  setServices({
    repo: fake.repo,
    agent: {
      isConfigured: () => false,
      tools: () => [],
      run: async () => {
        throw new Error('stub');
      },
      resume: async () => {
        throw new Error('stub');
      },
    },
  });
  return fake;
}

/* ─────────────────────────────── 期权链 ─────────────────────────────────── */

test('GET /api/options/chain：缺 code → 400；离线 → 502 且不返回假快照', async () => {
  useRepo();
  const missing = await app.inject({ method: 'GET', url: '/api/options/chain?market=US' });
  assert.equal(missing.statusCode, 400, missing.body);

  const offline = await app.inject({ method: 'GET', url: '/api/options/chain?market=US&code=AAPL' });
  assert.equal(offline.statusCode, 502, offline.body);
  const payload = offline.json() as { error: { message: string } };
  assert.ok(payload.error.message.includes('离线'), offline.body);

  const badMarket = await app.inject({ method: 'GET', url: '/api/options/chain?market=JP&code=7203' });
  assert.equal(badMarket.statusCode, 400);
});

/* ─────────────────────────────── 候选筛选 ───────────────────────────────── */

test('GET /api/options/candidates：担保数据服务端读，持股不足时不给覆盖式卖 Call 候选', async () => {
  const repoState = useRepo();
  repoState.assets.push({
    id: 'asset-1',
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
  });
  // 该路由同样会取期权链（离线）→ 502；契约上不允许用空快照假装「没有候选」。
  const response = await app.inject({ method: 'GET', url: '/api/options/candidates?market=US&code=AAPL' });
  assert.equal(response.statusCode, 502, response.body);
});

/* ─────────────────────────────── 持仓读写 ───────────────────────────────── */

test('POST /api/options/positions：201 创建并出现在列表；非法张数 → 400', async () => {
  useRepo();
  const created = await app.inject({
    method: 'POST',
    url: '/api/options/positions',
    payload: {
      market: 'US',
      code: 'AAPL',
      strategy: 'covered_call',
      optionType: 'call',
      optionCode: 'AAPL260116C00110000',
      strike: 110,
      expiry: '2026-01-16',
      contracts: 1,
      premium: 2,
      tradeDate: '2025-12-01',
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const position = created.json() as { id: string; contracts: number; premiumIncome: number; warnings?: string[] };
  assert.equal(position.contracts, 1);
  assert.equal(position.premiumIncome, 200);

  const list = await app.inject({ method: 'GET', url: '/api/options/positions' });
  assert.equal(list.statusCode, 200);
  const payload = list.json() as { items: Array<{ id: string }>; summary: { openContracts: number }; warnings: string[] };
  assert.equal(payload.items.length, 1);
  assert.equal(payload.summary.openContracts, 1);
  assert.ok(payload.warnings.some((warning) => warning.includes('离线')), payload.warnings.join('|'));

  const invalid = await app.inject({
    method: 'POST',
    url: '/api/options/positions',
    payload: {
      market: 'US',
      code: 'AAPL',
      strategy: 'covered_call',
      optionType: 'call',
      optionCode: 'AAPL260116C00110000',
      strike: 110,
      expiry: '2026-01-16',
      contracts: 0,
      premium: 2,
    },
  });
  assert.equal(invalid.statusCode, 400, invalid.body);
});

test('GET /api/options/positions/:id：存在返回 200，不存在 404', async () => {
  const state = useRepo();
  state.contracts.push(makeContract({ id: 'c-detail' }));
  const found = await app.inject({ method: 'GET', url: '/api/options/positions/c-detail' });
  assert.equal(found.statusCode, 200, found.body);
  const position = found.json() as { id: string; optionType: string; strike: number };
  assert.equal(position.id, 'c-detail');
  assert.equal(position.optionType, 'call');
  assert.equal(position.strike, 110);

  const missing = await app.inject({ method: 'GET', url: '/api/options/positions/nope' });
  assert.equal(missing.statusCode, 404);
});

test('POST /api/options/positions/:id/close：买平后 realizedPnl=权利金−买平成本；重复买平 409', async () => {
  const state = useRepo();
  state.contracts.push(makeContract({ id: 'c-close', premiumIncome: 200 }));
  const closed = await app.inject({
    method: 'POST',
    url: '/api/options/positions/c-close/close',
    payload: { price: 0.5, fee: 1, tradeDate: '2026-01-05' },
  });
  assert.equal(closed.statusCode, 200, closed.body);
  const position = closed.json() as { status: string; realizedPnl: number };
  assert.equal(position.status, 'closed');
  assert.equal(position.realizedPnl, 149);

  const again = await app.inject({ method: 'POST', url: '/api/options/positions/c-close/close', payload: { price: 0.4 } });
  assert.equal(again.statusCode, 409, again.body);
});

/* ───────────────────────────── 到期结算 ────────────────────────────────── */

test('POST /api/options/positions/:id/settle：离线时转待确认（不假装已结清）', async () => {
  const state = useRepo();
  state.contracts.push(makeContract({ id: 'c-settle', expiry: '2020-01-17' }));
  const response = await app.inject({ method: 'POST', url: '/api/options/positions/c-settle/settle', payload: {} });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json() as { scanned: number; autoSettled: number; pendingReview: number; warnings: string[] };
  assert.equal(result.scanned, 1);
  assert.equal(result.autoSettled, 0);
  assert.equal(result.pendingReview, 1);
  assert.equal(state.settlements[0]!.status, 'pending_review');
  assert.ok(state.settlements[0]!.note.includes('离线模式'), state.settlements[0]!.note);
  assert.equal(state.contracts[0]!.status, 'open', '未结清前合约状态不变');
});

test('GET /api/options/settlements：按状态过滤；非法状态 400', async () => {
  const state = useRepo();
  state.settlements.push({
    id: 's1',
    contractId: 'c1',
    expiry: '2026-01-16',
    evaluatedAt: nowIso(),
    referencePrice: 105,
    priceSource: '夹具',
    verdict: 'otm_no_assignment',
    itmAmount: -5,
    itmPct: 4.5,
    status: 'pending_review',
    action: 'pending',
    transactionId: null,
    assetId: null,
    realizedPnl: 0,
    note: '',
    createdAt: nowIso(),
  });
  state.settlements.push({ ...state.settlements[0]!, id: 's2', contractId: 'c2', status: 'auto_settled' });

  const all = await app.inject({ method: 'GET', url: '/api/options/settlements' });
  assert.equal(all.statusCode, 200);
  assert.equal((all.json() as { items: unknown[] }).items.length, 2);

  const pending = await app.inject({ method: 'GET', url: '/api/options/settlements?status=pending_review' });
  assert.equal((pending.json() as { items: unknown[] }).items.length, 1);

  const invalid = await app.inject({ method: 'GET', url: '/api/options/settlements?status=bogus' });
  assert.equal(invalid.statusCode, 400);
});

test('POST /api/options/settlements/scan：扫描一批并返回统计', async () => {
  const state = useRepo();
  state.contracts.push(makeContract({ id: 'c-scan-1', expiry: '2020-01-17' }));
  state.contracts.push(makeContract({ id: 'c-scan-2', expiry: addDays(today, 30) }));
  const response = await app.inject({ method: 'POST', url: '/api/options/settlements/scan', payload: {} });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json() as { scanned: number; pendingReview: number };
  assert.equal(result.scanned, 1, '只处理到期日已过的合约');
  assert.equal(result.pendingReview, 1);
});

test('POST /api/options/settlements/:id/confirm：人工判定入账后合约状态更新，重复确认幂等', async () => {
  const state = useRepo();
  state.contracts.push(makeContract({ id: 'c-confirm', expiry: '2020-01-17', strike: 110, premiumIncome: 200 }));
  await app.inject({ method: 'POST', url: '/api/options/settlements/scan', payload: {} });
  const settlementId = state.settlements[0]!.id;

  const confirmed = await app.inject({
    method: 'POST',
    url: `/api/options/settlements/${settlementId}/confirm`,
    payload: { verdict: 'otm_no_assignment', referencePrice: 104, note: '券商对账单' },
  });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  const result = confirmed.json() as { autoSettled: number; pendingReview: number; warnings: string[] };
  assert.equal(result.autoSettled, 1);
  // 人工确认必须落 `confirmed`（界面上是「已确认」），不能与系统自动入账混为一谈。
  assert.equal(state.settlements[0]!.status, 'confirmed');
  assert.equal(state.settlements[0]!.referencePrice, 104);
  assert.equal(state.contracts[0]!.status, 'expired_otm');
  assert.equal(state.contracts[0]!.realizedPnl, 200);
  assert.equal(state.transactions.length, 0, '虚值到期没有股票交割，不写流水');

  const again = await app.inject({ method: 'POST', url: `/api/options/settlements/${settlementId}/confirm`, payload: { verdict: 'assigned' } });
  assert.equal(again.statusCode, 200, again.body);
  const idempotent = again.json() as { autoSettled: number; warnings: string[] };
  assert.equal(idempotent.autoSettled, 0, '已入账的记录不再重复入账');
  assert.ok(idempotent.warnings.some((warning) => warning.includes('已')), idempotent.warnings.join('|'));
  assert.equal(state.settlements[0]!.status, 'confirmed', '幂等确认保持原状态（人工确认），不被后一次判定改写');
  assert.equal(state.contracts[0]!.status, 'expired_otm', '幂等确认不得改写已结清结论');
});

test('POST /api/options/settlements/:id/dismiss：忽略后冻结；未 force 的扫描不再重判', async () => {
  const state = useRepo();
  state.contracts.push(makeContract({ id: 'c-dismiss', expiry: '2020-01-17' }));
  await app.inject({ method: 'POST', url: '/api/options/settlements/scan', payload: {} });
  const settlementId = state.settlements[0]!.id;

  const dismissed = await app.inject({
    method: 'POST',
    url: `/api/options/settlements/${settlementId}/dismiss`,
    payload: { note: '券商端未行权' },
  });
  assert.equal(dismissed.statusCode, 200, dismissed.body);
  assert.equal(state.settlements[0]!.status, 'dismissed');
  assert.equal(state.settlements[0]!.note.includes('忽略'), true);

  await app.inject({ method: 'POST', url: '/api/options/settlements/scan', payload: {} });
  assert.equal(state.settlements[0]!.status, 'dismissed', '忽略的结论不能被普通扫描翻回来');
  assert.equal(state.settlements.length, 1);

  const dismissAgain = await app.inject({ method: 'POST', url: `/api/options/settlements/${settlementId}/dismiss`, payload: {} });
  assert.equal(dismissAgain.statusCode, 200);
});

test('POST /api/options/settlements/:id/confirm：已忽略的记录再次确认 → 409', async () => {
  const state = useRepo();
  state.contracts.push(makeContract({ id: 'c-locked', expiry: '2020-01-17' }));
  await app.inject({ method: 'POST', url: '/api/options/settlements/scan', payload: {} });
  const settlementId = state.settlements[0]!.id;
  await app.inject({ method: 'POST', url: `/api/options/settlements/${settlementId}/dismiss`, payload: {} });

  const response = await app.inject({
    method: 'POST',
    url: `/api/options/settlements/${settlementId}/confirm`,
    payload: { verdict: 'assigned', referencePrice: 130 },
  });
  assert.equal(response.statusCode, 409, response.body);
});

/* ────────────────────────── 建议确认（+ 期权建议引导） ────────────────────── */

test('POST /api/advice/:id/confirm-option：201 建仓、幂等；非期权建议 400；持股不足 409', async () => {
  const state = useRepo();
  state.assets.push({
    id: 'asset-1',
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
  });
  state.transactions.push({
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

  const expiry = addDays(today, 30);
  const quote = makeQuote({ type: 'call', strike: 110, expiry });
  const snapshot: OptionChainSnapshot = {
    market: 'US',
    code: 'AAPL',
    name: 'Apple',
    underlyingPrice: 100,
    currency: 'USD',
    asOf: `${today}T09:40:00.000+08:00`,
    delayed: true,
    source: '测试夹具',
    expiries: [],
    quotes: [quote],
    warnings: [],
  };
  const plan = buildOptionAdvicePlan({
    strategy: 'covered_call',
    market: 'US',
    code: 'AAPL',
    name: 'Apple',
    quote,
    underlyingPrice: 100,
    contracts: 1,
    collateral: 10_000,
    collateralNote: '持股市值',
    snapshot,
    acceptAssignment: true,
  });
  state.advice.push(makeAdvice({ id: 'advice-option', option: plan }));
  state.advice.push(makeAdvice({ id: 'advice-stock', instrument: 'stock', option: null }));

  const created = await app.inject({
    method: 'POST',
    url: '/api/advice/advice-option/confirm-option',
    payload: { contracts: 1, premium: 2.4, expiry, fee: 1 },
  });
  assert.equal(created.statusCode, 201, created.body);
  const body = created.json() as { position: { id: string; contracts: number; premiumIncome: number; collateral: number }; warnings: string[] };
  assert.equal(body.position.contracts, 1);
  assert.equal(body.position.premiumIncome, 239);
  assert.equal(body.position.collateral, 10_000);
  assert.equal(state.contracts.length, 1);
  assert.equal(state.advice[0]!.status, 'confirmed');

  const again = await app.inject({
    method: 'POST',
    url: '/api/advice/advice-option/confirm-option',
    payload: { contracts: 1, premium: 2.4, expiry },
  });
  assert.equal(again.statusCode, 201, again.body);
  assert.equal((again.json() as { position: { id: string } }).position.id, body.position.id, '幂等：返回同一合约');
  assert.equal(state.contracts.length, 1);

  const notOption = await app.inject({
    method: 'POST',
    url: '/api/advice/advice-stock/confirm-option',
    payload: { contracts: 1, premium: 2, expiry },
  });
  assert.equal(notOption.statusCode, 400, notOption.body);

  // 同一份建议已确认过 → 幂等优先；换一条未确认的建议验证「持股不足」硬拦截。
  state.advice.push(makeAdvice({ id: 'advice-option-short', option: plan }));
  const insufficient = await app.inject({
    method: 'POST',
    url: '/api/advice/advice-option-short/confirm-option',
    payload: { contracts: 5, premium: 2, expiry },
  });
  assert.equal(insufficient.statusCode, 409, insufficient.body);
  assert.ok((insufficient.json() as { error: { message: string } }).error.message.includes('持股'), insufficient.body);
  assert.equal(state.contracts.length, 1, '被拒绝时不得建仓');
});

test('POST /api/options/analyze：AI 未配置 → 400 NOT_CONFIGURED（与全站口径一致，不排队假任务）', async () => {
  useRepo();
  const response = await app.inject({ method: 'POST', url: '/api/options/analyze', payload: {} });
  assert.equal(response.statusCode, 400, response.body);
  const payload = response.json() as { error: { code: string; message: string } };
  assert.equal(payload.error.code, 'NOT_CONFIGURED');
  assert.ok(payload.error.message.includes('设置'), payload.error.message);
});

test('GET /api/health 不存在于本注册器（未注册路由 → 404，避免误以为注册了全站路由）', async () => {
  useRepo();
  const response = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 404);
});