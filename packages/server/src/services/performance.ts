/**
 * 组合年化收益率（当年 / 全周期）—— 由真实账本 + 真实收盘价确定性重算。
 *
 * Owner: server-core. 设计口径（全部可复算、可核对、缺数据就如实说不可度量）：
 *
 * 1. **年化 = XIRR，不是线性外推**。`(1+r)^(t/365)` 形式的资金加权内部收益率
 *    （Excel 的 XIRR 同口径），能正确处理「不定时、不定额」的申赎现金流；
 *    `收益率 ÷ 天数 × 365` 对不规则现金流是错的口径，这里刻意不用。
 * 2. **当年 = 自然年**：起点 = 上一自然年最后一天。期初持仓按**各自 ≤ 该日的最后
 *    收盘价**估值（真实行情，不是拿成本价顶替）；当年买入/卖出的真实现金流按
 *    交易日参与求解；终点 = 期末总市值。
 * 3. **已实现年化**只统计**当年卖出**的部分：账面法（移动加权平均）没有批次，
 *    因此把卖出份额的成本锚定在**这些份额的加权平均买入日**，与卖出净收入一起
 *    求 XIRR —— 一个数就是「当年落袋那部分的年化收益率」。
 * 4. **含费用**：所有现金流都是真实现金流（买入含费、卖出扣费），否则算出来的是
 *    不含成本的“毛收益”。`realizedPnl` 字段仍保持账本口径（不含费）以便对账。
 * 5. **诚实降级**：拿不到历史收盘价、当年没有卖出、持有期不足一天……一律返回
 *    `null` 并在 `notes` 里写明原因，绝不用 0 或估算值冒充。
 *
 * 上游只有 `getSeries` 一处网络调用，且结果按「标的 × 年度」缓存在 SQLite `kv`：
 * 同一年度内每个标的只取一次历史收盘价，之后 Dashboard 每次打开都是纯本地计算。
 */
import {
  MIN_ANNUALIZE_DAYS,
  type AssetSummary,
  type InstrumentType,
  type Market,
  type PortfolioPerformance,
  type RangeKey,
  type SeriesPoint,
} from '@aia/shared';

import type { AssetRow, TxRow } from '../types/models.js';
import { fxRateInto, orderTransactions } from './portfolio.js';
import { round4, toNumber } from '../db/util.js';

const DAY_MS = 86_400_000;
/** 份额小于该值视为已清仓（与账本一致）。 */
const SHARE_EPSILON = 1e-6;
/** 期初估值最多抓取多少个标的的历史收盘价（保护上游接口）。 */
export const MAX_OPENING_LOOKUPS = 40;
/** 期初估值整体超时（毫秒）：宁可当年年化显示「不可度量」，也不拖死 Dashboard。 */
export const OPENING_VALUE_DEADLINE_MS = 6000;
/** 期初估值的并发上限，与流水线/建议追踪保持一致。 */
const OPENING_LOOKUP_CONCURRENCY = 3;
/** 面值过小的现金流（占位）直接忽略。 */
const MIN_FLOW = 1e-6;

/**
 * 重新导出「允许年化的最短区间」——口径定义在 `@aia/shared`（服务端与界面共用一份），
 * 这里转发是为了让 `services/performance` 的调用方/测试不必再记另一条 import 路径。
 */
export { MIN_ANNUALIZE_DAYS };

/* ─────────────────────────────── 日期工具 ─────────────────────────────── */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` → UTC 零点毫秒（避免本地时区把交易日移一天）。 */
export function dayMs(day: string): number {
  return DAY_RE.test(day) ? Date.parse(`${day}T00:00:00Z`) : Number.NaN;
}

/** 毫秒 → `YYYY-MM-DD`。 */
export function msToDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 自然日差（`to - from`，含端点误差 ≤ 1 天）。 */
export function daysBetween(from: string, to: string): number {
  const a = dayMs(from);
  const b = dayMs(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / DAY_MS);
}

/** 本地时区的今天（`YYYY-MM-DD`），与 `localMonth()` 同一口径。 */
export function localDay(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/* ──────────────────────────────── XIRR ────────────────────────────────── */

export interface DatedFlow {
  /** `YYYY-MM-DD`；金额的符号表示方向（投入为负、回收为正）。 */
  date: string;
  amount: number;
}

export type XirrFailure = 'insufficient-flows' | 'no-sign-change' | 'too-short' | 'no-root';

export interface XirrResult {
  /** 年化收益率（小数，0.12 = 12%）；`null` = 不可度量。 */
  rate: number | null;
  reason?: XirrFailure;
  /** 实际参与求解的现金流笔数（排查口径时有用）。 */
  count: number;
}

/** 求解用的利率扫描点（牛顿法失败时的兜底括号搜索）。 */
const RATE_GRID = [-0.9999, -0.99, -0.9, -0.7, -0.5, -0.3, -0.1, -0.02, 0, 0.02, 0.05, 0.1, 0.2, 0.35, 0.6, 1, 2, 5, 20, 100, 1e4];

/**
 * XIRR：解 `Σ CF_i / (1+r)^(t_i/365) = 0`（`t_i` = 距首笔现金流的天数）。
 *
 * 先牛顿迭代（快且精度高），收敛失败再在利率网格上找变号区间二分。
 * 只有在残差相对误差足够小的时候才算解出来 —— 否则返回 `no-root`，
 * 而不是把一个不满足方程的中间值当成答案。
 */
export function solveXirr(flows: DatedFlow[]): XirrResult {
  const usable = flows
    .filter((flow) => DAY_RE.test(flow.date) && Number.isFinite(flow.amount) && Math.abs(flow.amount) > MIN_FLOW)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  if (usable.length < 2) return { rate: null, reason: 'insufficient-flows', count: usable.length };
  if (!usable.some((flow) => flow.amount > 0) || !usable.some((flow) => flow.amount < 0)) {
    return { rate: null, reason: 'no-sign-change', count: usable.length };
  }

  const origin = dayMs(usable[0]!.date);
  const years = usable.map((flow) => (dayMs(flow.date) - origin) / DAY_MS / 365);
  const amounts = usable.map((flow) => flow.amount);
  const spanDays = years[years.length - 1]! * 365;
  // 不足一天时年化没有意义（同日买卖会被放大成天文数字）。
  if (spanDays < 1) return { rate: null, reason: 'too-short', count: usable.length };

  const scale = amounts.reduce((sum, amount) => sum + Math.abs(amount), 0);
  const npv = (rate: number): number => {
    const base = 1 + rate;
    if (base <= 1e-12) return Number.NaN;
    let total = 0;
    for (let i = 0; i < amounts.length; i += 1) total += amounts[i]! / base ** years[i]!;
    return total;
  };
  const dNpv = (rate: number): number => {
    const base = 1 + rate;
    if (base <= 1e-12) return Number.NaN;
    let total = 0;
    for (let i = 0; i < amounts.length; i += 1) {
      total -= (years[i]! * amounts[i]!) / base ** (years[i]! + 1);
    }
    return total;
  };
  const isRoot = (rate: number): boolean => {
    if (!Number.isFinite(rate) || rate <= -0.999999) return false;
    const value = npv(rate);
    return Number.isFinite(value) && Math.abs(value) <= 1e-7 * scale;
  };

  // ① 牛顿迭代
  let rate = 0.1;
  for (let i = 0; i < 100; i += 1) {
    const value = npv(rate);
    const slope = dNpv(rate);
    if (!Number.isFinite(value) || !Number.isFinite(slope) || Math.abs(slope) < 1e-14) break;
    const next = rate - value / slope;
    if (!Number.isFinite(next) || next <= -0.999999) break;
    const converged = Math.abs(next - rate) < 1e-10;
    rate = next;
    if (converged) break;
  }
  if (isRoot(rate)) return { rate, count: usable.length };

  // ② 网格扫描 + 二分（牛顿发散或多解时的兜底）
  let previousRate: number | null = null;
  let previousValue = 0;
  for (const gridRate of RATE_GRID) {
    const value = npv(gridRate);
    if (!Number.isFinite(value)) {
      previousRate = null;
      continue;
    }
    if (value === 0) return { rate: gridRate, count: usable.length };
    if (previousRate !== null && Math.sign(value) !== Math.sign(previousValue)) {
      let low = previousRate;
      let high = gridRate;
      for (let i = 0; i < 200; i += 1) {
        const mid = (low + high) / 2;
        const midValue = npv(mid);
        if (!Number.isFinite(midValue)) break;
        if (Math.abs(midValue) <= 1e-9 * scale) return { rate: mid, count: usable.length };
        if (Math.sign(midValue) === Math.sign(npv(low))) low = mid;
        else high = mid;
      }
      const mid = (low + high) / 2;
      if (isRoot(mid)) return { rate: mid, count: usable.length };
    }
    previousRate = gridRate;
    previousValue = value;
  }

  return { rate: null, reason: 'no-root', count: usable.length };
}

/* ─────────────────────────── 账本重放（已实现） ─────────────────────────── */

/** 一笔卖出所释放份额的「已实现」切片。 */
export interface SaleRealization {
  assetId: string;
  currency: string;
  /** 卖出交易日。 */
  tradeDate: string;
  /** 被卖出份额。 */
  shares: number;
  /** 账面成本（移动加权平均，不含费用）。 */
  costBasis: number;
  /** 这些份额分摊到的买入费用。 */
  allocatedBuyFees: number;
  /** 卖出净收入（股数 × 价格 − 卖出费用）。 */
  proceeds: number;
  /** 成本锚定日：这些份额的加权平均买入日（账面法无批次时的标准近似）。 */
  acquiredDate: string;
  /** 含费用的已实现盈亏 = 净收入 − 成本 − 分摊买入费用。 */
  netPnl: number;
  /** 与账本一致的已实现盈亏（不含费用，可用来对账）。 */
  ledgerPnl: number;
  /** 持有自然日数。 */
  holdingDays: number;
}

/**
 * 按时间顺序重放账本，返回每一笔卖出释放的份额切片。
 *
 * 追踪三个权重：移动加权平均成本（与 `computePosition` 一致）、仍持有份额分摊到的
 * **买入费用/份额**，以及仍持有份额的**加权平均买入时间**（已实现年化的成本锚点）。
 * 买入费用按份额摊入成本侧，卖出费用从收入侧扣除 —— 年化因此是含费用的真实收益。
 */
export function replaySales(txs: TxRow[], currency: string): SaleRealization[] {
  const sales: SaleRealization[] = [];
  let shares = 0;
  let avgCost = 0;
  let feePerShare = 0;
  let acquiredMs = 0;

  for (const tx of orderTransactions(txs)) {
    const quantity = Math.max(0, toNumber(tx.shares));
    if (quantity === 0) continue;
    const price = toNumber(tx.price);
    const fee = Math.max(0, toNumber(tx.fee));
    const tradeMs = dayMs(tx.tradeDate);
    if (!Number.isFinite(tradeMs)) continue;

    if (tx.kind === 'sell') {
      const sold = Math.min(quantity, shares);
      if (sold > SHARE_EPSILON) {
        const costBasis = sold * avgCost;
        const allocatedBuyFees = sold * feePerShare;
        // 卖出费用按份额比例分摊（正常不会超卖，`sold === quantity`）。
        const saleFee = quantity > 0 ? fee * (sold / quantity) : 0;
        const proceeds = sold * price - saleFee;
        const anchorMs = acquiredMs > 0 ? acquiredMs : tradeMs;
        sales.push({
          assetId: tx.assetId,
          currency,
          tradeDate: tx.tradeDate,
          shares: round4(sold),
          costBasis: round4(costBasis),
          allocatedBuyFees: round4(allocatedBuyFees),
          proceeds: round4(proceeds),
          acquiredDate: msToDay(anchorMs),
          netPnl: round4(proceeds - costBasis - allocatedBuyFees),
          ledgerPnl: round4((price - avgCost) * sold),
          holdingDays: Math.max(0, Math.round((tradeMs - anchorMs) / DAY_MS)),
        });
      }
      shares -= quantity;
      if (shares <= SHARE_EPSILON) {
        shares = 0;
        avgCost = 0;
        feePerShare = 0;
        acquiredMs = 0;
      }
      continue;
    }

    const nextShares = shares + quantity;
    feePerShare = (feePerShare * shares + fee) / nextShares;
    avgCost = (avgCost * shares + price * quantity) / nextShares;
    acquiredMs = shares > 0 && acquiredMs > 0 ? (acquiredMs * shares + tradeMs * quantity) / nextShares : tradeMs;
    shares = nextShares;
  }

  return sales;
}

/** 截止 `day`（含）的净持有份额 —— 期初持仓的快照。 */
export function sharesOn(txs: TxRow[], day: string): number {
  const cutoff = dayMs(day);
  if (!Number.isFinite(cutoff)) return 0;
  let shares = 0;
  for (const tx of orderTransactions(txs)) {
    const tradeMs = dayMs(tx.tradeDate);
    if (!Number.isFinite(tradeMs) || tradeMs > cutoff) continue;
    const quantity = Math.max(0, toNumber(tx.shares));
    if (quantity === 0) continue;
    shares += tx.kind === 'sell' ? -quantity : quantity;
  }
  return shares > SHARE_EPSILON ? shares : 0;
}

/** 首个买入交易日（全周期年化的起点）。 */
export function firstBuyDay(txs: TxRow[]): string | null {
  const buys = orderTransactions(txs).filter((tx) => tx.kind === 'buy' && Math.max(0, toNumber(tx.shares)) > 0);
  return buys[0]?.tradeDate ?? null;
}

/* ────────────────────────────── 期初估值 ─────────────────────────────── */

/** 取 ≤ `day` 的最后一个收盘价（真实行情；取不到返回 null）。 */
export function lastCloseOnOrBefore(points: SeriesPoint[], day: string): number | null {
  let found: number | null = null;
  let foundDay = '';
  for (const point of points) {
    if (typeof point.date !== 'string' || !DAY_RE.test(point.date)) continue;
    if (point.date > day) continue;
    if (!Number.isFinite(point.close) || point.close <= 0) continue;
    if (point.date >= foundDay) {
      foundDay = point.date;
      found = point.close;
    }
  }
  return found;
}

/** 期初收盘价加载器（测试可注入假实现）。 */
export type YearStartCloseLoader = (
  asset: { code: string; market: Market; type: InstrumentType },
  cutoff: string,
) => Promise<number | null>;

/** 需要在期初持有的标的（用于估值）。 */
export interface OpeningPosition {
  assetId: string;
  name: string;
  code: string;
  market: Market;
  type: InstrumentType;
  currency: string;
  shares: number;
}

export interface OpeningValueOptions {
  /** 上一自然年最后一天（估值基准日）。 */
  cutoff: string;
  positions: OpeningPosition[];
  /** 折算用的汇率函数（与 `portfolio.fxRateInto` 同口径）。 */
  rateOf: (currency: string) => number;
  /** `kv` 缓存（同一标的 × 年度只取一次真实收盘价）。 */
  cache?: { get(key: string): string | null; set(key: string, value: string): void };
  loader: YearStartCloseLoader;
  deadlineMs?: number;
}

export interface OpeningValueResult {
  /** 期初持仓市值（折算后）；null = 有标的取不到历史收盘价。 */
  value: number | null;
  notes: string[];
}

const CACHE_PREFIX = 'perf.openClose';
/**
 * 取不到历史收盘价时的负缓存时长：这段时间内不再重试上游。
 * 否则一个手工录入的、上游根本没有行情的标的会让**每次**打开 Dashboard 都白等一轮。
 */
const MISS_TTL_MS = 6 * 60 * 60 * 1000;

async function runWithLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  });
  await Promise.all(runners);
}

/**
 * 计算**上一自然年最后一天**的持仓市值：`Σ 期初份额 × 各自 ≤ 该日的最后收盘价`。
 *
 * 三个保护：结果按标的一年度缓存进 `kv`（每个标的每年只打一次上游）、并发 3、
 * 整体超过 `deadlineMs` 就放弃并说明原因。任何一个标的取不到价 → 返回 null：
 * 期初估值不完整时，当年年化就是**不可度量**，不能拿部分市值硬算。
 */
export async function loadOpeningValue(options: OpeningValueOptions): Promise<OpeningValueResult> {
  const notes: string[] = [];
  const positions = options.positions.filter((item) => item.shares > SHARE_EPSILON);
  if (positions.length === 0) return { value: 0, notes };

  if (positions.length > MAX_OPENING_LOOKUPS) {
    notes.push(`期初持有 ${positions.length} 个标的，超过 ${MAX_OPENING_LOOKUPS} 个上限，已跳过历史收盘价估值`);
    return { value: null, notes };
  }

  const prices = new Map<string, number | null>();
  const cache = options.cache;
  const deadline = Date.now() + (options.deadlineMs ?? OPENING_VALUE_DEADLINE_MS);
  let timedOut = false;

  await runWithLimit(positions, OPENING_LOOKUP_CONCURRENCY, async (position) => {
    const cacheKey = `${CACHE_PREFIX}.${options.cutoff}.${position.assetId}`;
    const cached = cache?.get(cacheKey);
    if (cached !== null && cached !== undefined && cached !== '') {
      const parsed = Number(cached);
      prices.set(position.assetId, Number.isFinite(parsed) && parsed > 0 ? parsed : null);
      return;
    }
    // 负缓存：最近失败过就不要再打上游（命中缓存的成功值永远优先）。
    const missKey = `${cacheKey}.miss`;
    const missAt = Number(cache?.get(missKey) ?? '');
    if (Number.isFinite(missAt) && missAt > 0 && Date.now() - missAt < MISS_TTL_MS) {
      prices.set(position.assetId, null);
      return;
    }
    if (Date.now() >= deadline) {
      timedOut = true;
      prices.set(position.assetId, null);
      return;
    }
    let price: number | null = null;
    try {
      price = await options.loader(
        { code: position.code, market: position.market, type: position.type },
        options.cutoff,
      );
    } catch {
      price = null;
    }
    if (price !== null && Number.isFinite(price) && price > 0) cache?.set(cacheKey, String(price));
    else cache?.set(missKey, String(Date.now()));
    prices.set(position.assetId, price);
  });

  const missing = positions.filter((position) => {
    const price = prices.get(position.assetId);
    return price === null || price === undefined || !Number.isFinite(price) || price <= 0;
  });
  if (missing.length > 0) {
    const names = missing.slice(0, 4).map((item) => `${item.name || item.code}(${item.code})`);
    const suffix = missing.length > names.length ? ` 等 ${missing.length} 个标的` : '';
    notes.push(`缺少 ${options.cutoff} 的历史收盘价：${names.join('、')}${suffix}，期初市值无法完整估值`);
    if (timedOut) {
      const seconds = Math.round((options.deadlineMs ?? OPENING_VALUE_DEADLINE_MS) / 1000);
      notes.push(`历史行情获取超时（超过 ${seconds} 秒），已放弃补齐（下次打开 Dashboard 会自动重试）`);
    }
    return { value: null, notes };
  }

  let value = 0;
  for (const position of positions) {
    const price = prices.get(position.assetId)!;
    value += position.shares * price * options.rateOf(position.currency);
  }
  return { value: round4(value), notes };
}

/* ───────────────────────────── 组合年化计算 ───────────────────────────── */

export interface PerformanceAssetInput {
  id: string;
  name: string;
  currency: string;
  txs: TxRow[];
}

export interface PerformanceInput {
  /** 统计年度（自然年）。 */
  year: number;
  /** 估值终点（本地日期）。 */
  asOf: string;
  currency: string;
  assets: PerformanceAssetInput[];
  /** 期初持仓市值（折算后）；null = 无法估值。 */
  openingValue: number | null;
  /** 期末持仓总市值（折算后）。 */
  endingValue: number;
  /** 期初估值阶段产生的说明（缺价 / 超时等）。 */
  openingNotes?: string[];
  /** 汇率换算（默认用 fxRates + 内置兜底）。 */
  rateOf: (currency: string) => number;
}

/** 当年组合年化（纯函数：同一输入必然同一输出，便于复算与单测）。 */
export function computePerformance(input: PerformanceInput): PortfolioPerformance {
  const { year, asOf, currency, rateOf } = input;
  const periodStart = `${year - 1}-12-31`;
  const notes: string[] = ['口径：XIRR 资金加权年化（实际天数/365），现金流含交易费用。'];
  const portfolioFlows: DatedFlow[] = [];
  const yearFlows: DatedFlow[] = [];
  const realizedFlows: DatedFlow[] = [];
  let netInvested = 0;
  let realizedPnl = 0;
  let futureDated = 0;
  /** 当年买入总支出（含费用）与卖出净收入（扣费用），用于「区间累计收益率」。 */
  let buysTotal = 0;
  let sellsTotal = 0;
  /** 已实现部分的含费成本与净收入（当年卖出份额）。 */
  let realizedCost = 0;
  let realizedProceeds = 0;

  for (const asset of input.assets) {
    const rate = rateOf(asset.currency);

    for (const tx of orderTransactions(asset.txs)) {
      const quantity = Math.max(0, toNumber(tx.shares));
      if (quantity === 0) continue;
      const gross = quantity * toNumber(tx.price);
      const fee = Math.max(0, toNumber(tx.fee));
      // 真实现金流：买入为负（含费），卖出为正（扣费）。
      const amount = round4((tx.kind === 'sell' ? gross - fee : -(gross + fee)) * rate);
      const flow: DatedFlow = { date: tx.tradeDate, amount };
      portfolioFlows.push(flow);

      if (tx.tradeDate > asOf) {
        futureDated += 1;
        continue;
      }
      if (tx.tradeDate <= periodStart) continue;
      yearFlows.push(flow);
      // 净投入 = Σ(−现金流)：买入增加投入，卖出减少投入。
      netInvested -= amount;
      if (amount < 0) buysTotal += -amount;
      else sellsTotal += amount;
    }

    for (const sale of replaySales(asset.txs, asset.currency)) {
      if (!sale.tradeDate.startsWith(`${year}-`)) continue;
      const saleRate = rateOf(sale.currency);
      realizedPnl += sale.ledgerPnl * saleRate;
      const cost = (sale.costBasis + sale.allocatedBuyFees) * saleRate;
      const proceeds = sale.proceeds * saleRate;
      realizedCost += cost;
      realizedProceeds += proceeds;
      realizedFlows.push(
        { date: sale.acquiredDate, amount: round4(-cost) },
        { date: sale.tradeDate, amount: round4(proceeds) },
      );
    }
  }

  if (input.openingValue !== null && input.openingValue > 0) {
    // 期初持仓视为区间起点的「投入」，期末市值视为「回收」。
    yearFlows.push({ date: periodStart, amount: -input.openingValue });
  }
  if (input.endingValue > 0) {
    yearFlows.push({ date: asOf, amount: input.endingValue });
    portfolioFlows.push({ date: asOf, amount: input.endingValue });
  }

  if (futureDated > 0) notes.push(`已忽略 ${futureDated} 笔晚于估值日（${asOf}）的交易记录`);
  if (input.openingValue === null) {
    notes.push(`缺少 ${periodStart} 的期初持仓市值，当年年化不可度量`);
  } else if (input.openingValue === 0) {
    notes.push(`期初（${periodStart}）无持仓：当年收益从当年首笔买入起算`);
  } else {
    notes.push(`期初持仓市值 ${formatMoney(input.openingValue, currency)}（按 ${periodStart} 收盘价折算）`);
  }
  notes.push(...(input.openingNotes ?? []));

  const yearResult = solveXirr(yearFlows);
  const realizedResult = solveXirr(realizedFlows);
  const inceptionResult = solveXirr(portfolioFlows);

  /* ── 区间长度：不足 30 天不年化（几何年化会把短期波动放大成荒谬的数字） ── */
  const cashFlowDays = flowSpanDays(yearFlows);
  const realizedCashFlowDays = flowSpanDays(realizedFlows);
  const annualizedReliable = cashFlowDays >= MIN_ANNUALIZE_DAYS;
  const realizedAnnualizedReliable = realizedCashFlowDays >= MIN_ANNUALIZE_DAYS;

  /* ── 区间累计（简单）收益率：不管资金时点，直接回答「赚亏百分之几」 ── */
  const capital = (input.openingValue ?? 0) + buysTotal;
  const cumulativePct =
    input.openingValue === null || capital <= 0
      ? null
      : round4(((input.endingValue + sellsTotal - capital) / capital) * 100);
  const realizedCumulativePct = realizedCost > 0 ? round4(((realizedProceeds - realizedCost) / realizedCost) * 100) : null;

  if (!annualizedReliable && yearResult.rate !== null) {
    // 有解但不该报：说明原因 + 保留「强行年化」的数值，口径完全透明。
    notes.push(
      `当年实际有资金 ${cashFlowDays} 天（不足 ${MIN_ANNUALIZE_DAYS} 天），几何年化会把短期波动放大成 ${
        percent(yearResult.rate)?.toFixed(2) ?? '—'
      }%，统计意义不大；卡片改为显示区间累计收益率。`,
    );
  } else if (yearResult.rate === null) {
    notes.push(
      yearResult.reason === 'insufficient-flows' || yearResult.reason === 'no-sign-change'
        ? '当年现金流不足（只有买入或只有卖出），无法求年化'
        : yearResult.reason === 'too-short'
          ? '统计区间不足 1 天，年化无意义'
          : '年化方程在合理利率区间内无解（现金流方向异常），已如实标记为不可度量',
    );
  }
  if (!realizedAnnualizedReliable && realizedResult.rate !== null) {
    notes.push(
      `当年卖出部分的持有区间 ${realizedCashFlowDays} 天（不足 ${MIN_ANNUALIZE_DAYS} 天），已实现年化同样不展示，改为显示已实现累计收益率。`,
    );
  } else if (realizedResult.rate === null) {
    notes.push(
      realizedResult.reason === 'insufficient-flows' || realizedResult.reason === 'no-sign-change'
        ? '当年没有卖出记录，已实现年化不适用'
        : realizedResult.reason === 'too-short'
          ? '当年卖出部分的持有期不足 1 天，已实现年化无意义'
          : '当年已实现现金流无法求解年化，已如实标记为不可度量',
    );
  }

  const days = daysBetween(periodStart, asOf);

  return {
    year,
    periodStart,
    periodEnd: asOf,
    openingValue: input.openingValue === null ? null : round4(input.openingValue),
    endingValue: round4(input.endingValue),
    netInvested: round4(netInvested),
    realizedPnl: round4(realizedPnl),
    annualizedPct: annualizedReliable ? percent(yearResult.rate) : null,
    realizedAnnualizedPct: realizedAnnualizedReliable ? percent(realizedResult.rate) : null,
    cumulativePct,
    realizedCumulativePct,
    cashFlowDays,
    annualizedReliable,
    realizedAnnualizedReliable,
    sinceInceptionPct: percent(inceptionResult.rate),
    sinceInceptionFrom: firstBuyDay(input.assets.flatMap((asset) => asset.txs)),
    days,
    notes,
  };
}

function percent(rate: number | null): number | null {
  if (rate === null || !Number.isFinite(rate)) return null;
  return round4(rate * 100);
}

/** 现金流区间天数（首笔 → 末笔）；少于两笔或日期不可解析时为 0。 */
function flowSpanDays(flows: DatedFlow[]): number {
  const days = flows.map((flow) => dayMs(flow.date)).filter((value) => Number.isFinite(value));
  if (days.length < 2) return 0;
  return Math.round((Math.max(...days) - Math.min(...days)) / DAY_MS);
}

/** 简易金额文案（仅用于 notes，避免引入前端格式化模块）。 */
function formatMoney(value: number, currency: string): string {
  return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${currency}`;
}

/* ─────────────────────────── 编排（Dashboard 用） ─────────────────────────── */

/** 上游历史收盘价的默认加载器：懒加载数据源模块，离线/失败一律 null。 */
let datasourceModule: Promise<typeof import('../datasources/registry.js')> | undefined;

async function defaultYearStartCloseLoader(
  asset: { code: string; market: Market; type: InstrumentType },
  cutoff: string,
): Promise<number | null> {
  if (process.env.AIA_OFFLINE === '1') return null;
  try {
    datasourceModule ??= import('../datasources/registry.js');
    const ds = await datasourceModule;
    // 1 年窗口足够覆盖上一年最后一天；跨年较久时拉长窗口，避免上游把基准日切掉。
    const range: RangeKey = daysBetween(cutoff, localDay()) > 330 ? '3y' : '1y';
    const result = await ds.getSeries({
      code: asset.code,
      market: asset.market,
      type: asset.type,
      range,
      interval: 'day',
    });
    if (!result) return null;
    return lastCloseOnOrBefore(result.value.points, cutoff);
  } catch {
    return null;
  }
}

export interface PortfolioPerformanceOptions {
  /** `kv` 缓存（`repo.getKv` / `repo.setKv`）。 */
  cache?: { get(key: string): string | null; set(key: string, value: string): void };
  /** 资产行（提供 code/market/type/currency/name）。 */
  assets: AssetRow[];
  /** 每笔资产的全部交易（缺省时按 assetId 排序自 `transactions`）。 */
  transactions: TxRow[];
  /** 期末持仓市值来源（与 `portfolio.marketValue` 同源）。 */
  summaries: AssetSummary[];
  fxRates: Record<string, number>;
  currency: string;
  /** 统计年度（缺省 = 本地当前年）。 */
  year?: number;
  /** 估值终点（缺省 = 本地今天）。 */
  asOf?: string;
  /** 汇率换算（缺省用 fxRates + 内置兜底表）。 */
  rateOf?: (currency: string) => number;
  /** 期初收盘价加载器（测试注入）。 */
  loader?: YearStartCloseLoader;
  deadlineMs?: number;
}

/**
 * Dashboard 的「年化收益率 / 已实现年化收益率」数据源。
 *
 * 默认实现只依赖账本 + 期末市值（离线也能算），唯一的外部输入是**期初持仓的历史
 * 收盘价**，拿不到就把当年年化标成 `null` 并说明原因。
 */
export async function buildPortfolioPerformance(
  options: PortfolioPerformanceOptions,
): Promise<PortfolioPerformance> {
  const year = options.year ?? new Date().getFullYear();
  const asOf = options.asOf ?? localDay();
  const cutoff = `${year - 1}-12-31`;
  // 与组合汇总共用同一套汇率口径，保证 endingValue === portfolio.marketValue。
  const rateOf = options.rateOf ?? ((code: string) => fxRateInto(code, options.fxRates));

  const byAsset = new Map<string, TxRow[]>();
  for (const tx of options.transactions) {
    const list = byAsset.get(tx.assetId);
    if (list) list.push(tx);
    else byAsset.set(tx.assetId, [tx]);
  }

  const assets: PerformanceAssetInput[] = options.assets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    currency: asset.currency,
    txs: byAsset.get(asset.id) ?? [],
  }));

  const openingPositions: OpeningPosition[] = options.assets
    .map((asset) => ({
      assetId: asset.id,
      name: asset.name,
      code: asset.code,
      market: asset.market,
      type: asset.type,
      currency: asset.currency,
      shares: sharesOn(byAsset.get(asset.id) ?? [], cutoff),
    }))
    .filter((item) => item.shares > SHARE_EPSILON);

  let openingValue: number | null = 0;
  let openingNotes: string[] = [];
  if (openingPositions.length > 0) {
    const result = await loadOpeningValue({
      cutoff,
      positions: openingPositions,
      rateOf,
      cache: options.cache,
      loader: options.loader ?? defaultYearStartCloseLoader,
      deadlineMs: options.deadlineMs,
    });
    openingValue = result.value;
    openingNotes = result.notes;
  }

  let endingValue = 0;
  for (const summary of options.summaries) {
    if (summary.shares <= 0) continue;
    endingValue += summary.marketValue * rateOf(summary.currency);
  }

  return computePerformance({
    year,
    asOf,
    currency: options.currency,
    assets,
    openingValue,
    endingValue: round4(endingValue),
    openingNotes,
    rateOf,
  });
}
