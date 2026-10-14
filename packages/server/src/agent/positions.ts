/**
 * Minimal position math used by the agent's read tools.
 *
 * The authoritative portfolio implementation lives in `services/portfolio.ts`
 * (server-core, exposed through `/api/assets`). The agent only needs a compact
 * view of "what does the user hold", so it derives it from the raw rows here to
 * avoid a hard dependency on a module under parallel construction.
 *
 * Owner: agent-engine.
 */
import type { PositionMath } from '@aia/shared';
import type { AssetRow, TxRow } from '../types/models.js';

/** Moving weighted-average cost, mirroring docs/API.md §4. */
export function computePosition(transactions: TxRow[]): PositionMath {
  const sorted = [...transactions].sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0));
  let shares = 0;
  let avgCost = 0;
  let realizedPnl = 0;
  for (const tx of sorted) {
    if (tx.kind === 'buy') {
      const totalCost = shares * avgCost + tx.shares * tx.price + (tx.fee ?? 0);
      shares += tx.shares;
      avgCost = shares > 0 ? totalCost / shares : 0;
    } else {
      realizedPnl += (tx.price - avgCost) * tx.shares - (tx.fee ?? 0);
      shares -= tx.shares;
      if (shares <= 0.000001) {
        shares = Math.max(0, shares);
        avgCost = shares > 0 ? avgCost : 0;
      }
    }
  }
  return {
    shares: round(shares),
    avgCost: round(avgCost),
    cost: round(shares * avgCost),
    realizedPnl: round(realizedPnl),
  };
}

export interface CompactHolding {
  id: string;
  name: string;
  code: string;
  market: string;
  type: string;
  currency: string;
  shares: number;
  avgCost: number;
  cost: number;
  price: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  dayChangePct: number;
  realizedPnl: number;
  firstBuyAt: string | null;
  lastBuyAt: string | null;
  closed: boolean;
  note: string;
  aiSummary: string;
  qualityScore: number;
  targetPrice: number;
  expectedReturn: number;
  transactionCount: number;
}

/** Compact holding view for LLM context (rounds + drops null noise). */
export function compactHolding(asset: AssetRow, transactions: TxRow[]): CompactHolding {
  const position = computePosition(transactions);
  const marketValue = round(position.shares * (asset.price || 0));
  const unrealizedPnl = round(marketValue - position.cost);
  const buys = transactions.filter((tx) => tx.kind === 'buy').map((tx) => tx.tradeDate).sort();
  const sells = transactions.filter((tx) => tx.kind === 'sell').map((tx) => tx.tradeDate).sort();
  return {
    id: asset.id,
    name: asset.name,
    code: asset.code,
    market: asset.market,
    type: asset.type,
    currency: asset.currency,
    shares: position.shares,
    avgCost: position.avgCost,
    cost: position.cost,
    price: asset.price,
    marketValue,
    unrealizedPnl,
    unrealizedPnlPct: position.cost > 0 ? round((unrealizedPnl / position.cost) * 100) : 0,
    dayChangePct: asset.dayChangePct,
    realizedPnl: position.realizedPnl,
    firstBuyAt: buys[0] ?? null,
    lastBuyAt: buys.at(-1) ?? null,
    closed: position.shares <= 0,
    note: asset.note,
    aiSummary: asset.aiSummary,
    qualityScore: asset.qualityScore,
    targetPrice: asset.targetPrice,
    expectedReturn: asset.expectedReturn,
    transactionCount: transactions.length,
  };
}

export function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Down-samples a close series into a sparkline (oldest → newest). */
export function sparkFrom(points: Array<{ close: number }>, size = 30): number[] {
  if (points.length === 0) return [];
  if (points.length <= size) return points.map((p) => round(p.close));
  const step = points.length / size;
  const out: number[] = [];
  for (let i = 0; i < size; i += 1) {
    const point = points[Math.min(points.length - 1, Math.floor(i * step))];
    if (point) out.push(round(point.close));
  }
  return out;
}
