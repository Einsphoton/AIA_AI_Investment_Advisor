/**
 * AI 投资建议的结果追踪 —— 让「建议靠不靠谱」变成一个可计算的数字。
 *
 * 设计要点（全部是**确定性**的，不经过 LLM）：
 *
 * 1. **纯函数优先**：度量口径集中在 `computeOutcome()` / `summarizeOutcomes()`，
 *    输入是「建议行 + 日线序列」，因此可单测、可复算、幂等。
 * 2. **无前视偏差**：基准价 = **建议日之后**第一个交易日的收盘价。建议当日的收盘
 *    在建议发生时可能还没发生，用它当基准会引入前视偏差，所以刻意跳过当日。
 * 3. **口径对称**：基准指数用同一个锚定规则、同一段序列，`excessPct` 才是同区间比较。
 * 4. **诚实**：样本不足（samples < 2）或序列取不到时**不参与统计**，
 *    并在 `warnings` 里写明原因——宁可显示「不可度量」，也不给一个虚高的胜率。
 *
 * `advice_outcomes` 表是**可重建的物化缓存**：删掉重跑会得到同样的结果。
 *
 * Owner: agent-engine.
 */
import type {
  AdviceAction,
  AdviceOutcome,
  AdviceOutcomeMarketStats,
  AdviceOutcomeStats,
  AdviceOutcomeTrackResult,
  AdviceStatus,
  InstrumentType,
  Market,
  RangeKey,
  SeriesPoint,
} from '@aia/shared';

import { round } from '../agent/positions.js';
import { mapLimit } from '../datasources/http.js';
import * as ds from '../datasources/registry.js';
import type { AdviceOutcomeRow, AdviceRow } from '../types/models.js';
import type { Repo } from '../types/repo.js';
import type { LoggerLike } from '../types/agent.js';

/** 观测窗口（自然日）。窗口满后数字冻结为最终结果，不再重算。 */
export const OUTCOME_WINDOW_DAYS = 90;
/** 单次追踪最多处理的建议条数（保护上游接口）。 */
export const MAX_TRACKED_ADVICE = 200;
/** 并发抓取上限，与流水线保持一致。 */
const FETCH_CONCURRENCY = 3;

/**
 * 各市场的基准。
 *
 * A 股直接用沪深300指数；港股/美股的上游指数序列不可用（实测 HSI 502、SPX 404），
 * 因此改用跟踪同一指数的**流动性最好的 ETF** 作为基准，并在界面上如实标注。
 */
export const OUTCOME_BENCHMARKS: Record<Market, { code: string; type: InstrumentType; name: string }> = {
  CN: { code: '000300', type: 'stock', name: '沪深300指数' },
  HK: { code: '02800', type: 'etf', name: '盈富基金（恒生指数 ETF）' },
  US: { code: 'SPY', type: 'etf', name: 'SPY（标普500 ETF）' },
};

/* ─────────────────────────────── pure math ──────────────────────────────── */

export interface OutcomeComputation {
  baselineDate: string;
  baselinePrice: number;
  lastDate: string;
  lastPrice: number;
  priceChangePct: number;
  adviceReturnPct: number;
  benchmarkBase: number;
  benchmarkChangePct: number;
  /** false = 基准序列不可用，此时 excessPct 无意义（调用方写 0 并告警）。 */
  benchmarkAvailable: boolean;
  excessPct: number;
  maxReturnPct: number;
  minReturnPct: number;
  samples: number;
  daysTracked: number;
  status: AdviceOutcomeRow['status'];
  warnings: string[];
}

export interface OutcomeInput {
  points: SeriesPoint[];
  benchmarkPoints: SeriesPoint[];
  /** 建议创建时间（ISO）。 */
  advisedAt: string;
  action: AdviceAction;
  windowDays?: number;
}

const dayOf = (iso: string): string => (iso ?? '').slice(0, 10);

const byDate = (a: SeriesPoint, b: SeriesPoint): number => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

function usable(points: SeriesPoint[]): SeriesPoint[] {
  return points.filter((point) => typeof point.date === 'string' && point.date !== '' && Number.isFinite(point.close) && point.close > 0);
}

function pct(from: number, to: number): number {
  if (!Number.isFinite(from) || from <= 0) return 0;
  return round(((to - from) / from) * 100);
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/**
 * Anchors a series at the first trading day **strictly after** the advice day.
 * Returns the index, or -1 when the series does not reach that day yet.
 */
function anchorIndex(points: SeriesPoint[], advisedDay: string): number {
  return points.findIndex((point) => point.date > advisedDay);
}

/**
 * Measures one advice against its benchmark. Pure: same inputs → same output,
 * so the materialized row can always be rebuilt from the advice + series.
 *
 * Returns `null` when the advice is not yet measurable (no trading day after the
 * advice day, or no usable prices).
 */
export function computeOutcome(input: OutcomeInput): OutcomeComputation | null {
  const windowDays = input.windowDays ?? OUTCOME_WINDOW_DAYS;
  const advisedDay = dayOf(input.advisedAt);
  if (!advisedDay) return null;

  const points = usable(input.points).sort(byDate);
  if (points.length === 0) return null;
  const start = anchorIndex(points, advisedDay);
  if (start < 0) return null;

  const baseline = points[start]!;
  const last = points[points.length - 1]!;
  const direction = input.action === 'sell' ? -1 : 1;

  const priceChangePct = pct(baseline.close, last.close);
  const adviceReturnPct = round(direction * priceChangePct);

  // Excursions over the whole measured window (direction-adjusted).
  let maxReturnPct = adviceReturnPct;
  let minReturnPct = adviceReturnPct;
  for (let index = start; index < points.length; index += 1) {
    const value = round(direction * pct(baseline.close, points[index]!.close));
    if (value > maxReturnPct) maxReturnPct = value;
    if (value < minReturnPct) minReturnPct = value;
  }

  const warnings: string[] = [];
  const benchmark = usable(input.benchmarkPoints).sort(byDate);
  const benchStart = benchmark.length > 0 ? anchorIndex(benchmark, advisedDay) : -1;
  let benchmarkBase = 0;
  let benchmarkChangePct = 0;
  let benchmarkAvailable = false;
  if (benchStart >= 0) {
    benchmarkBase = benchmark[benchStart]!.close;
    benchmarkChangePct = pct(benchmarkBase, benchmark[benchmark.length - 1]!.close);
    benchmarkAvailable = true;
  } else {
    warnings.push('基准序列不可用：无法计算超额收益（仅显示绝对涨跌）');
  }

  const excessPct = benchmarkAvailable ? round(adviceReturnPct - benchmarkChangePct) : 0;
  const samples = points.length - start;
  const daysTracked = daysBetween(baseline.date, last.date);

  return {
    baselineDate: baseline.date,
    baselinePrice: round(baseline.close),
    lastDate: last.date,
    lastPrice: round(last.close),
    priceChangePct,
    adviceReturnPct,
    benchmarkBase: round(benchmarkBase),
    benchmarkChangePct,
    benchmarkAvailable,
    excessPct,
    maxReturnPct,
    minReturnPct,
    samples,
    daysTracked,
    status: daysTracked >= windowDays ? 'expired' : 'tracking',
    warnings,
  };
}

/** 可度量的最小样本数：至少要有一个「之后」的交易日，才谈得上涨跌。 */
export const MIN_MEASURABLE_SAMPLES = 2;

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? round((numerator / denominator) * 100) : 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/**
 * Aggregates tracked outcomes. Pure.
 *
 * Only rows with a real measurement (`samples >= 2`) enter the rates; everything
 * else is reported as `unmeasured` so a small sample can never masquerade as a
 * good win rate.
 */
export function summarizeOutcomes(
  items: AdviceOutcome[],
  windowDays = OUTCOME_WINDOW_DAYS,
): AdviceOutcomeStats {
  const measured = items.filter((item) => item.samples >= MIN_MEASURABLE_SAMPLES);
  const wins = measured.filter((item) => item.adviceReturnPct > 0);
  const beats = measured.filter((item) => item.benchmarkCode !== '' && item.excessPct > 0);

  const markets = [...new Set(items.map((item) => item.market))].sort();
  const byMarket: AdviceOutcomeMarketStats[] = markets.map((market) => {
    const rows = measured.filter((item) => item.market === market);
    const marketBeats = rows.filter((item) => item.benchmarkCode !== '' && item.excessPct > 0);
    return {
      market,
      measured: rows.length,
      winRate: rate(rows.filter((item) => item.adviceReturnPct > 0).length, rows.length),
      beatRate: rate(marketBeats.length, rows.filter((item) => item.benchmarkCode !== '').length),
      avgReturnPct: mean(rows.map((item) => item.adviceReturnPct)),
      avgExcessPct: mean(rows.filter((item) => item.benchmarkCode !== '').map((item) => item.excessPct)),
    };
  });

  const warnings: string[] = [];
  if (items.length > 0 && measured.length === 0) {
    warnings.push('目前没有任何建议可度量（需要建议日之后至少 2 个交易日），暂不显示胜率');
  } else if (measured.length > 0 && measured.length < 5) {
    warnings.push(`可度量样本仅 ${measured.length} 条，统计意义有限`);
  }

  return {
    total: items.length,
    measured: measured.length,
    unmeasured: items.length - measured.length,
    winRate: rate(wins.length, measured.length),
    beatRate: rate(beats.length, measured.filter((item) => item.benchmarkCode !== '').length),
    avgReturnPct: measured.length > 0 ? mean(measured.map((item) => item.adviceReturnPct)) : 0,
    avgExcessPct: measured.length > 0
      ? mean(measured.filter((item) => item.benchmarkCode !== '').map((item) => item.excessPct))
      : 0,
    byMarket,
    windowDays,
    updatedAt: items.reduce<string | null>(
      (latest, item) => (latest === null || item.updatedAt > latest ? item.updatedAt : latest),
      null,
    ),
    warnings,
  };
}

/* ──────────────────────────── materialization ───────────────────────────── */

export function toAdviceOutcome(row: AdviceOutcomeRow): AdviceOutcome {
  return {
    adviceId: row.adviceId,
    runId: row.runId,
    code: row.code,
    market: row.market,
    type: row.type,
    action: row.action,
    currency: row.currency,
    advisedAt: row.advisedAt,
    adviceStatus: row.adviceStatus,
    executed: row.executed,
    baselineDate: row.baselineDate,
    baselinePrice: row.baselinePrice,
    lastDate: row.lastDate,
    lastPrice: row.lastPrice,
    priceChangePct: row.priceChangePct,
    adviceReturnPct: row.adviceReturnPct,
    benchmarkCode: row.benchmarkCode,
    benchmarkName: row.benchmarkName,
    benchmarkBase: row.benchmarkBase,
    benchmarkChangePct: row.benchmarkChangePct,
    excessPct: row.excessPct,
    maxReturnPct: row.maxReturnPct,
    minReturnPct: row.minReturnPct,
    samples: row.samples,
    daysTracked: row.daysTracked,
    status: row.status,
    warnings: row.warnings,
    updatedAt: row.updatedAt,
  };
}

/** `batch-<runId>` → runId；approval 模式下无法反查则为 null。 */
export function runIdOfBatch(batchId: string): string | null {
  if (!batchId.startsWith('batch-')) return null;
  const id = batchId.slice('batch-'.length).trim();
  return id === '' ? null : id;
}

/** 观测窗口需要的序列区间（留出余量，避免基准日落在区间之外）。 */
export function rangeForAge(days: number): RangeKey {
  if (days <= 20) return '1m';
  if (days <= 80) return '3m';
  return '6m';
}

export interface OutcomeTrackingDeps {
  repo: Repo;
  logger: LoggerLike;
}

/** 返回类型定义在 `@aia/shared`，前端与后端共用同一份契约。 */
export type OutcomeTrackResult = AdviceOutcomeTrackResult;

/**
 * Recomputes every in-window advice outcome and materializes it.
 *
 * Cheap and idempotent: one series call per advice (plus at most one per market
 * for the benchmark, served from the datasource cache). Never throws — a failed
 * instrument only leaves that row unmeasured with a warning.
 */
export async function trackAdviceOutcomes(deps: OutcomeTrackingDeps): Promise<OutcomeTrackResult> {
  const { repo, logger } = deps;
  const ranAt = new Date().toISOString();
  const warnings: string[] = [];
  const cutoff = new Date(Date.now() - OUTCOME_WINDOW_DAYS * 86_400_000).toISOString();

  const advice = repo
    .listAdvice({ limit: MAX_TRACKED_ADVICE })
    // 期权卖权建议不参与股票口径的结果追踪：那一行的 code 是**标的**、盈亏由合约
    // 权利金与行权结果决定，按标的涨跌算「建议收益」既无意义又会让胜率虚高；
    // 期权自己的表现看 `/api/options/positions`（option_contracts 的未实现/已实现盈亏）。
    // 这里必须过滤，否则还会对同一标的重复取日线序列。
    .filter((row) => row.instrument !== 'option')
    .filter((row) => row.createdAt >= cutoff)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const result: OutcomeTrackResult = {
    tracked: 0,
    measured: 0,
    unmeasurable: 0,
    frozen: 0,
    pruned: 0,
    ranAt,
    warnings,
  };

  const existing = new Map(repo.listAdviceOutcomes({ limit: 5000 }).map((row) => [row.adviceId, row]));
  for (const row of existing.values()) {
    if (row.status === 'expired') result.frozen += 1;
  }

  // Benchmark series are shared across all advices of a market **and range**.
  const benchmarkCache = new Map<string, SeriesPoint[]>();
  const benchmarkFor = async (market: Market, ageDays: number): Promise<{ points: SeriesPoint[]; warning?: string }> => {
    const range = rangeForAge(ageDays);
    const cacheKey = `${market}:${range}`;
    const cached = benchmarkCache.get(cacheKey);
    if (cached) return { points: cached };
    const spec = OUTCOME_BENCHMARKS[market];
    try {
      const series = await ds.getSeries({ code: spec.code, market, type: spec.type, range, interval: 'day' });
      const points = series?.value.points ?? [];
      benchmarkCache.set(cacheKey, points);
      if (points.length === 0) {
        const detail = series?.warnings?.join('；') ?? '空序列';
        warnings.push(`${market} 基准（${spec.name}）取数失败：${detail}`);
        return { points, warning: `基准取数失败：${detail}` };
      }
      return { points };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      benchmarkCache.set(cacheKey, []);
      warnings.push(`${market} 基准（${spec.name}）取数异常：${message}`);
      return { points: [], warning: `基准取数异常：${message}` };
    }
  };

  const ageDaysOf = (row: AdviceRow): number => daysBetween(dayOf(row.createdAt), dayOf(ranAt));

  await mapLimit(advice, FETCH_CONCURRENCY, async (row) => {
    const ageDays = ageDaysOf(row);
    const previous = existing.get(row.id);
    // 已冻结（窗口满）的结果不再重算：它是最终结论，不该随后续行情漂移。
    if (previous?.status === 'expired') return;

    const spec = OUTCOME_BENCHMARKS[row.market];
    const benchmark = await benchmarkFor(row.market, ageDays);
    let points: SeriesPoint[] = [];
    let seriesWarning: string | undefined;
    try {
      const series = await ds.getSeries({
        code: row.code,
        market: row.market,
        type: row.type,
        range: rangeForAge(ageDays),
        interval: 'day',
      });
      points = series?.value.points ?? [];
      if (points.length === 0) {
        seriesWarning = `行情序列取不到（${series?.warnings?.join('；') ?? '空序列'}）`;
      }
    } catch (error) {
      seriesWarning = `行情序列取数异常：${error instanceof Error ? error.message : String(error)}`;
    }

    const computed =
      points.length > 0
        ? computeOutcome({
            points,
            benchmarkPoints: benchmark.points,
            advisedAt: row.createdAt,
            action: row.action,
            windowDays: OUTCOME_WINDOW_DAYS,
          })
        : null;

    const outcomeWarnings = [
      ...(seriesWarning ? [seriesWarning] : []),
      ...(benchmark.warning ? [benchmark.warning] : []),
      ...(computed?.warnings ?? []),
    ];
    if (!computed && !seriesWarning) {
      outcomeWarnings.push('建议日之后还没有可用交易日，暂不可度量');
    }

    const materialized: AdviceOutcomeRow = {
      adviceId: row.id,
      runId: runIdOfBatch(row.batchId),
      code: row.code,
      market: row.market,
      type: row.type,
      action: row.action,
      currency: row.currency,
      advisedAt: row.createdAt,
      adviceStatus: row.status as AdviceStatus,
      executed: row.executedShares !== null,
      baselineDate: computed?.baselineDate ?? '',
      baselinePrice: computed?.baselinePrice ?? 0,
      lastDate: computed?.lastDate ?? '',
      lastPrice: computed?.lastPrice ?? 0,
      priceChangePct: computed?.priceChangePct ?? 0,
      adviceReturnPct: computed?.adviceReturnPct ?? 0,
      benchmarkCode: computed?.benchmarkAvailable ? spec.code : '',
      benchmarkName: computed?.benchmarkAvailable ? spec.name : '',
      benchmarkBase: computed?.benchmarkBase ?? 0,
      benchmarkChangePct: computed?.benchmarkChangePct ?? 0,
      excessPct: computed?.excessPct ?? 0,
      maxReturnPct: computed?.maxReturnPct ?? 0,
      minReturnPct: computed?.minReturnPct ?? 0,
      samples: computed?.samples ?? 0,
      daysTracked: computed?.daysTracked ?? 0,
      status: computed?.status ?? 'tracking',
      warnings: outcomeWarnings,
      updatedAt: ranAt,
    };

    repo.upsertAdviceOutcome(materialized);
    result.tracked += 1;
    if (materialized.samples >= MIN_MEASURABLE_SAMPLES) result.measured += 1;
    else result.unmeasurable += 1;
  }).catch((error: unknown) => {
    // 追踪是旁路能力：任何单点失败都不该冒泡成接口 5xx。
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`追踪中断：${message}`);
    logger.warn(`advice outcome tracking failed: ${message}`);
  });

  try {
    result.pruned = repo.deleteAdviceOutcomesForMissingAdvice();
  } catch (error) {
    logger.warn(`advice outcome prune failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  logger.info(
    `advice outcomes tracked: ${result.tracked} recalculated, ${result.measured} measurable, ` +
      `${result.unmeasurable} not yet, ${result.frozen} frozen, ${result.pruned} pruned`,
  );
  return result;
}

/** Reads the materialized outcomes + stats (no I/O beyond SQLite). */
export function readAdviceOutcomes(repo: Repo): { items: AdviceOutcome[]; stats: AdviceOutcomeStats } {
  const rows = repo.listAdviceOutcomes({ limit: 200 }).map(toAdviceOutcome);
  return { items: rows, stats: summarizeOutcomes(rows) };
}
