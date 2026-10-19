/**
 * Portfolio math + DTO mapping (pure functions, no DB access).
 *
 * Owner: server-core. This module is the single implementation of the holding
 * rules frozen in docs/API.md §4 (moving weighted-average cost):
 *
 *   shares        = Σ buy.shares − Σ sell.shares
 *   avgCost       = weighted average of the buys of the still-open position
 *   realizedPnl  += (sell.price − avgCost) × sell.shares   (on every sell)
 *   cost          = shares × avgCost                        (0 once closed)
 *   marketValue   = shares × price
 *   unrealizedPnl = marketValue − cost
 *
 * Fees are recorded on the transaction but deliberately excluded from the cost
 * basis, matching the formulas above literally.
 */
import {
  FX_FALLBACK_INTO_CNY,
  MARKET_CURRENCY,
  MARKETS,
  type AdviceItem,
  type AgentRunSummary,
  type AssetDetail,
  type AssetSummary,
  type BudgetConfig,
  type BudgetStatus,
  type DashboardPortfolio,
  type Market,
  type MarketBudgetStatus,
  type Transaction,
  type WatchItem,
} from '@aia/shared';

import type { AdviceRow, AssetRow, RunRow, TxRow, WatchRow } from '../types/models.js';
import { localMonth, round4, toNumber } from '../db/util.js';

const SHARE_EPSILON = 1e-9;

export interface PositionState {
  shares: number;
  avgCost: number;
  cost: number;
  realizedPnl: number;
  firstBuyAt: string | null;
  lastBuyAt: string | null;
  lastSellAt: string | null;
}

/** Chronological order: trade date first, then creation time. */
export function orderTransactions(txs: TxRow[]): TxRow[] {
  return [...txs].sort((a, b) => {
    if (a.tradeDate !== b.tradeDate) return a.tradeDate.localeCompare(b.tradeDate);
    return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
  });
}

export interface LedgerDeficit {
  /** Trade date of the sell that has no matching holding. */
  tradeDate: string;
  /** Shares the sell wanted to dispose of. */
  shares: number;
  /** Shares actually available at that point in time. */
  available: number;
}

/**
 * Replays a ledger chronologically (`orderTransactions`) and reports the first
 * moment the running quantity would go negative — i.e. a sell with no matching
 * holding. `computePosition` silently discards such oversized sells, which makes
 * realised P&L and cash vanish; callers must turn this into a 409 instead.
 *
 * Shared by every write path that can introduce a sell (assets transactions and
 * advice confirmation).
 */
export function findLedgerDeficit(txs: TxRow[]): LedgerDeficit | undefined {
  let shares = 0;
  for (const item of orderTransactions(txs)) {
    const quantity = toNumber(item.shares);
    if (item.kind === 'sell') {
      if (quantity - shares > 1e-6) {
        return { tradeDate: item.tradeDate, shares: quantity, available: round4(Math.max(0, shares)) };
      }
      shares -= quantity;
    } else {
      shares += quantity;
    }
  }
  return undefined;
}

export function computePosition(txs: TxRow[]): PositionState {
  let shares = 0;
  let avgCost = 0;
  let realizedPnl = 0;
  let firstBuyAt: string | null = null;
  let lastBuyAt: string | null = null;
  let lastSellAt: string | null = null;

  for (const tx of orderTransactions(txs)) {
    const quantity = Math.max(0, toNumber(tx.shares));
    const price = toNumber(tx.price);
    if (quantity === 0) continue;

    if (tx.kind === 'sell') {
      const sold = Math.min(quantity, shares);
      realizedPnl += (price - avgCost) * sold;
      shares -= quantity;
      if (shares <= SHARE_EPSILON) {
        // Fully closed: the position's cost basis resets.
        shares = 0;
        avgCost = 0;
      }
      if (!lastSellAt || tx.tradeDate > lastSellAt) lastSellAt = tx.tradeDate;
      continue;
    }

    const nextShares = shares + quantity;
    avgCost = nextShares > 0 ? (avgCost * shares + price * quantity) / nextShares : 0;
    shares = nextShares;
    if (!firstBuyAt || tx.tradeDate < firstBuyAt) firstBuyAt = tx.tradeDate;
    if (!lastBuyAt || tx.tradeDate > lastBuyAt) lastBuyAt = tx.tradeDate;
  }

  return {
    shares: Math.round(shares * 1e6) / 1e6,
    avgCost: round4(avgCost),
    cost: round4(shares * avgCost),
    realizedPnl: round4(realizedPnl),
    firstBuyAt,
    lastBuyAt,
    lastSellAt,
  };
}

/* ────────────────────────────── DTO mapping ───────────────────────────────── */

export function toTransaction(tx: TxRow): Transaction {
  const quantity = toNumber(tx.shares);
  const price = toNumber(tx.price);
  const gross = quantity * price;
  return {
    id: tx.id,
    assetId: tx.assetId,
    kind: tx.kind,
    shares: quantity,
    price,
    fee: toNumber(tx.fee),
    // Positive for buys (cash deployed), negative for sells (cash released).
    amount: round4(tx.kind === 'sell' ? -gross : gross),
    tradeDate: tx.tradeDate,
    note: tx.note ?? '',
    source: tx.source,
    createdAt: tx.createdAt,
  };
}

export function toAssetSummary(asset: AssetRow, txs: TxRow[]): AssetSummary {
  const position = computePosition(txs);
  const price = toNumber(asset.price);
  const prevClose = toNumber(asset.prevClose);
  const marketValue = round4(position.shares * price);
  const unrealizedPnl = round4(marketValue - position.cost);
  const unrealizedPnlPct = position.cost > 0 ? round4((unrealizedPnl / position.cost) * 100) : 0;
  const dayChange = round4(position.shares * (price - prevClose));
  const dayChangePct =
    toNumber(asset.dayChangePct) !== 0
      ? round4(toNumber(asset.dayChangePct))
      : prevClose > 0
        ? round4(((price - prevClose) / prevClose) * 100)
        : 0;

  return {
    id: asset.id,
    name: asset.name,
    code: asset.code,
    market: asset.market,
    type: asset.type,
    source: asset.source,
    currency: asset.currency,
    shares: position.shares,
    avgCost: position.avgCost,
    cost: position.cost,
    realizedPnl: position.realizedPnl,
    price,
    priceAt: asset.priceAt,
    marketValue,
    unrealizedPnl,
    unrealizedPnlPct,
    dayChange,
    dayChangePct,
    firstBuyAt: position.firstBuyAt,
    lastBuyAt: position.lastBuyAt,
    lastSellAt: position.lastSellAt,
    note: asset.note ?? '',
    aiSummary: asset.aiSummary ?? '',
    aiSummaryAt: asset.aiSummaryAt,
    spark: Array.isArray(asset.spark) ? asset.spark : [],
    createdAt: asset.createdAt,
    closed: position.shares <= 0,
  };
}

export function toAssetDetail(asset: AssetRow, txs: TxRow[]): AssetDetail {
  return {
    ...toAssetSummary(asset, txs),
    transactions: orderTransactions(txs).map(toTransaction),
  };
}

export function toWatchItem(row: WatchRow): WatchItem {
  const price = toNumber(row.price);
  const initialPrice = toNumber(row.initialPrice);
  const changeSinceAdded = round4(price - initialPrice);
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    market: row.market,
    type: row.type,
    source: row.source,
    qualityScore: round4(toNumber(row.qualityScore)),
    targetPrice: round4(toNumber(row.targetPrice)),
    expectedReturn: round4(toNumber(row.expectedReturn)),
    expectedReturnHorizon: row.expectedReturnHorizon ?? '',
    initialPrice: round4(initialPrice),
    initialPriceAt: row.initialPriceAt,
    price: round4(price),
    priceAt: row.priceAt,
    changeSinceAdded,
    changeSinceAddedPct: initialPrice > 0 ? round4((changeSinceAdded / initialPrice) * 100) : 0,
    dayChangePct: round4(toNumber(row.dayChangePct)),
    note: row.note ?? '',
    aiSummary: row.aiSummary ?? '',
    aiSummaryAt: row.aiSummaryAt,
    thesis: row.thesis ?? '',
    spark: Array.isArray(row.spark) ? row.spark : [],
    createdAt: row.createdAt,
    status: row.status === 'retired' ? 'retired' : 'active',
    retiredReason: row.retiredReason ?? '',
    retiredAt: row.retiredAt ?? null,
    retireStreak: Number.isFinite(row.retireStreak) ? row.retireStreak : 0,
  };
}

export function toAdviceItem(row: AdviceRow): AdviceItem {
  return {
    id: row.id,
    batchId: row.batchId,
    assetId: row.assetId,
    watchItemId: row.watchItemId,
    assetName: row.assetName,
    code: row.code,
    market: row.market,
    type: row.type,
    // 期权卖权建议与股票建议共用同一张表：instrument 决定界面与确认流程的分流
    // （股票写交易流水，期权写 option_contracts）。老数据没有这一列，兜底成
    // 'stock'——前端若拿到 undefined 会把两种建议都当股票渲染。
    instrument: row.instrument ?? 'stock',
    action: row.action,
    // 来源由链接字段推导：带 assetId = 持仓；带 watchItemId = 我的标的；都没有 = 池外。
    // 写入时 tools.ts 会按 code 反查补全链接，所以这里能如实反映建议依据的池子。
    origin: row.assetId ? 'holding' : row.watchItemId ? 'watchlist' : 'external',
    targetShares: round4(toNumber(row.targetShares)),
    targetPrice: round4(toNumber(row.targetPrice)),
    amount: round4(toNumber(row.targetShares) * toNumber(row.targetPrice)),
    currency: row.currency,
    reason: row.reason ?? '',
    confidence: round4(toNumber(row.confidence)),
    status: row.status,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    executedShares: row.executedShares === null ? null : round4(toNumber(row.executedShares)),
    executedPrice: row.executedPrice === null ? null : round4(toNumber(row.executedPrice)),
    // 卖权方案：`instrument='option'` 时非空（合约条件、服务端算好的指标与数据口径）。
    option: row.option ?? null,
  };
}

export function toRunSummary(run: RunRow, stepCount: number): AgentRunSummary {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    title: run.title,
    summary: run.summary,
    error: run.error,
    turns: run.turns,
    stepCount,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

/* ─────────────────────────── portfolio aggregation ────────────────────────── */

export function fxRateInto(currency: string, fxRates: Record<string, number>): number {
  const code = (currency || 'CNY').toUpperCase();
  const live = Number(fxRates?.[code]);
  if (Number.isFinite(live) && live > 0) return live;
  const fallback = Number(FX_FALLBACK_INTO_CNY[code]);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 1;
}

/**
 * Aggregates every position into CNY. Closed positions keep contributing their
 * realised P&L but no market value / cost.
 *
 * `performance`（当年年化）由 `services/performance.ts` 计算后由调用方合并：
 * 它需要历史收盘价（异步 + 可能降级），不能塞进这个纯同步函数。
 */
export function summarizePortfolio(
  summaries: AssetSummary[],
  fxRates: Record<string, number>,
  currency = 'CNY',
): Omit<DashboardPortfolio, 'performance'> {
  let marketValue = 0;
  let cost = 0;
  let unrealizedPnl = 0;
  let realizedPnl = 0;
  let dayChange = 0;

  for (const item of summaries) {
    const rate = fxRateInto(item.currency, fxRates);
    realizedPnl += item.realizedPnl * rate;
    if (item.shares <= 0) continue;
    marketValue += item.marketValue * rate;
    cost += item.cost * rate;
    unrealizedPnl += item.unrealizedPnl * rate;
    dayChange += item.dayChange * rate;
  }

  const previousValue = marketValue - dayChange;
  return {
    marketValue: round4(marketValue),
    cost: round4(cost),
    unrealizedPnl: round4(unrealizedPnl),
    unrealizedPnlPct: cost > 0 ? round4((unrealizedPnl / cost) * 100) : 0,
    realizedPnl: round4(realizedPnl),
    currency,
    dayChange: round4(dayChange),
    dayChangePct: previousValue > 0 ? round4((dayChange / previousValue) * 100) : 0,
    fxRates,
  };
}

/* ───────────────────────────────── budget ─────────────────────────────────── */

const MONTH_RE = /^\d{4}-\d{2}$/;

/**
 * Monthly budget usage per market, in each market's own currency
 * (docs/API.md §6, Lead ruling):
 *
 *   spent     = Σ buy 成交额 (shares × price, gross, fees excluded)
 *   remaining = budget − spent        (may be negative; UI clamps for display)
 *   exhausted = remaining <= 0        →  budget = 0 means "do not invest this market
 *                                       this month"; overspending is true as well
 *   usedPct   = budget > 0 ? spent / budget × 100 : 100
 *
 * Sells deliberately do NOT release budget — otherwise a same-month round trip
 * could unlock unlimited buying power.
 */
export function computeBudgetStatus(
  assets: AssetRow[],
  txs: TxRow[],
  budget: BudgetConfig,
  month: string = localMonth(),
): BudgetStatus {
  const marketByAsset = new Map<string, Market>();
  for (const asset of assets) marketByAsset.set(asset.id, asset.market);

  const buys: Record<Market, number> = { CN: 0, HK: 0, US: 0 };

  const validMonth = MONTH_RE.test(month);
  for (const tx of txs) {
    if (tx.kind !== 'buy') continue;
    if (!validMonth || !tx.tradeDate.startsWith(month)) continue;
    const market = marketByAsset.get(tx.assetId);
    if (!market || !(market in buys)) continue;
    buys[market] += toNumber(tx.shares) * toNumber(tx.price);
  }

  const markets: MarketBudgetStatus[] = MARKETS.map((market) => {
    const budgetAmount = round4(toNumber(budget?.[market]));
    const spent = round4(buys[market]);
    const remaining = round4(budgetAmount - spent);
    return {
      market,
      currency: MARKET_CURRENCY[market],
      budget: budgetAmount,
      spent,
      remaining,
      // Lead-frozen semantics: exhausted keys off the SIGNED remaining, so
      // `budget = 0` means "do not invest in this market this month" (the buy
      // gate in agent/tools.ts only looks at `exhausted`). `usedPct` shows 100%
      // for a zero budget instead of pretending 0% was consumed.
      exhausted: remaining <= 0,
      usedPct: budgetAmount > 0 ? round4((spent / budgetAmount) * 100) : 100,
    };
  });

  return { month, markets };
}
