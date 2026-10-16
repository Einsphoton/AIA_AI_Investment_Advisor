/**
 * Dashboard 汇总 (docs/API.md §3)
 *
 * Owner: server-core. Four blocks: portfolio (CNY), counts + signals,
 * topHoldings (Top5 by market value) and the AI briefing. `indices`/`signals`
 * degrade gracefully — a missing market-data bridge must never 500 the page.
 */
import type { FastifyInstance } from 'fastify';

import type {
  AssetSummary,
  BudgetStatus,
  DashboardBriefing,
  DashboardCounts,
  DashboardPayload,
  DashboardPortfolio,
  DashboardSignals,
  Quote,
  ScheduleNextRun,
} from '@aia/shared';

import { getRepo, getScheduler } from '../registry.js';
import type { StoredSettings, TxRow } from '../types/models.js';
import type { Scheduler } from '../types/agent.js';
import { loadMarketBridge, localMonth, nowIso, parseJson, toNumber } from '../db/util.js';
import { computeBudgetStatus, computePosition, summarizePortfolio, toAssetSummary } from '../services/portfolio.js';
import { buildPortfolioPerformance, localDay } from '../services/performance.js';
import { enabledTasks, nextFireAt } from '../services/schedule.js';
import { getFxRatesResult } from '../services/fx.js';
import { getActiveScheduler } from '../services/scheduler.js';

/** 期初估值（历史收盘价）的整体超时：宁可当年年化显示「不可度量」，也不拖慢 Dashboard。 */
const PERFORMANCE_DEADLINE_MS = 6000;

export const BRIEFING_KV_KEY = 'dashboard.briefing';
export const SEEN_WATCHLIST_KV_KEY = 'seen.watchlistAt';
export const SEEN_ADVICE_KV_KEY = 'seen.adviceAt';

const NEW_ITEM_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_PRICE_MS = 12 * 60 * 60 * 1000;

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function maxTimestamp(values: (string | null | undefined)[]): number {
  return values.reduce((max, value) => Math.max(max, timestamp(value)), 0);
}

/**
 * The live scheduler: `registry.getScheduler()` is the primary seam (wired by
 * `index.ts`), with the scheduler module's own singleton as a boot-race-proof
 * fallback. Null only when this process never created a scheduler.
 */
function liveScheduler(): Scheduler | null {
  try {
    const viaRegistry = getScheduler();
    if (viaRegistry) return viaRegistry;
  } catch {
    /* registry not initialised yet — fall through to the module singleton */
  }
  return getActiveScheduler();
}

/**
 * Fallback only: when no scheduler instance exists (e.g. unit tests that build
 * the app without `index.ts`) we approximate the plan from the stored tasks.
 * The live scheduler is authoritative — see `signals` below.
 *
 * 与实时排程同一套口径（`services/schedule.ts`）：interval 从上次运行时间起算，
 * daily 取当天 `HH:mm`（已过则顺延）。返回每个启用任务各自的计划（升序）。
 */
function computePlan(settings: StoredSettings, lastRunAt: string | null): ScheduleNextRun[] {
  const tasks = enabledTasks(settings.schedules);
  if (tasks.length === 0) return [];
  const now = Date.now();
  const base = timestamp(lastRunAt) || now;
  return tasks
    .map((task) => {
      const at =
        task.mode === 'interval'
          ? Math.max(now, base + Math.max(1, toNumber(task.intervalMinutes, 1440)) * 60_000)
          : nextFireAt({ ...task, enabled: true }, now) ?? now;
      return { id: task.id, name: task.name, nextRunAt: new Date(at).toISOString() };
    })
    .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
}

function readBriefing(settings: StoredSettings): DashboardBriefing | null {
  const raw = getRepo().getKv(BRIEFING_KV_KEY);
  const parsed = parseJson<{ text?: unknown; generatedAt?: unknown; runId?: unknown }>(raw);
  if (!parsed || typeof parsed.text !== 'string' || parsed.text.trim() === '') return null;
  return {
    text: parsed.text,
    generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : nowIso(),
    runId: typeof parsed.runId === 'string' ? parsed.runId : null,
    persona: settings.persona,
    reportStyle: settings.reportStyle,
  };
}

/**
 * 可选 `?asOf=YYYY-MM-DD`（未来日期夹到今天）：把年化口径固定在某个估值日，
 * 便于复核「当年年化到底怎么算出来的」（`GET /api/dashboard?asOf=2026-06-30`）。
 * 不传就是今天 —— 与页面默认看到的一致。
 */
function resolveAsOf(query: unknown): string | undefined {
  const raw = (query as { asOf?: unknown } | undefined)?.asOf;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  if (!Number.isFinite(Date.parse(`${raw}T00:00:00Z`))) return undefined;
  const today = localDay();
  return raw > today ? today : raw;
}

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/dashboard', async (request): Promise<DashboardPayload> => {
    const repo = getRepo();
    const settings = repo.getSettings();
    const now = Date.now();
    const asOf = resolveAsOf(request.query);

    const grouped = new Map<string, TxRow[]>();
    const transactions = repo.listTransactions();
    for (const tx of transactions) {
      const list = grouped.get(tx.assetId);
      if (list) list.push(tx);
      else grouped.set(tx.assetId, [tx]);
    }

    const rows = repo.listAssets();
    const summaries: AssetSummary[] = rows.map((row) => toAssetSummary(row, grouped.get(row.id) ?? []));

    /* ── block 1: portfolio (CNY) + 当年年化（XIRR，真实账本 + 真实收盘价） ── */
    const fx = await getFxRatesResult(repo);
    if (fx.warning) request.log.warn({ warning: fx.warning }, 'fx rates fell back to built-in table');
    const totals = summarizePortfolio(summaries, fx.rates);
    const performance = await buildPortfolioPerformance({
      cache: { get: (key) => repo.getKv(key) ?? null, set: (key, value) => repo.setKv(key, value) },
      assets: rows,
      transactions,
      summaries,
      fxRates: fx.rates,
      currency: totals.currency,
      asOf,
      year: asOf ? Number(asOf.slice(0, 4)) : undefined,
      deadlineMs: PERFORMANCE_DEADLINE_MS,
    });
    if (performance.annualizedPct === null) {
      request.log.info({ notes: performance.notes }, 'portfolio annualized return not measurable');
    }
    const portfolio: DashboardPortfolio = { ...totals, performance };

    /* ── block 2: counts + signals ── */
    // 退役标的不计入「我的标的」，但数量单独展示；信号与「最近变化」仍看全部记录。
    const watchlist = repo.listWatchlist('all');
    const watchCounts = repo.countWatchlist();
    const advice = repo.listAdvice();
    const pendingAdvice = advice.filter((item) => item.status === 'pending');
    const runs = repo.listRuns();
    const openAssets = rows.filter((row) => computePosition(grouped.get(row.id) ?? []).shares > 0);

    const counts: DashboardCounts = {
      holdings: openAssets.length,
      instruments: rows.length,
      watchItems: watchCounts.active,
      retiredWatchItems: watchCounts.retired,
      newWatchItems: watchlist.filter(
        (item) => item.status === 'active' && now - timestamp(item.createdAt) <= NEW_ITEM_WINDOW_MS,
      ).length,
      pendingAdvice: pendingAdvice.length,
      newAdvice: pendingAdvice.length,
      analysisRuns: runs.length,
      lastRunAt: runs[0]?.startedAt ?? null,
    };

    const latestWatchAt = maxTimestamp(watchlist.map((item) => item.updatedAt || item.createdAt));
    const latestAdviceAt = maxTimestamp(advice.map((item) => item.decidedAt || item.createdAt));
    const seenWatchAt = timestamp(repo.getKv(SEEN_WATCHLIST_KV_KEY));
    const seenAdviceAt = timestamp(repo.getKv(SEEN_ADVICE_KV_KEY));

    // The scheduler is the source of truth — but only when it really has a plan.
    // 现在排程的是一组任务：实时计划优先；实时计划为空时按设置推算，因为
    // 「实例存在但读不到任务」（例如单例绑定的是另一个进程/已关闭的库）绝不能
    // 把用户配置好的任务显示成「未开启」。
    const scheduler = liveScheduler();
    const livePlan = scheduler?.plan() ?? [];
    const nextRuns = livePlan.length > 0 ? livePlan : computePlan(settings, counts.lastRunAt);
    const scheduleEnabled = nextRuns.length > 0;
    const nextRunAt = nextRuns[0]?.nextRunAt ?? null;

    const signals: DashboardSignals = {
      watchlistChanged: watchlist.length > 0 && (seenWatchAt === 0 || latestWatchAt > seenWatchAt),
      adviceChanged: advice.length > 0 && (seenAdviceAt === 0 || latestAdviceAt > seenAdviceAt),
      priceStale:
        openAssets.length > 0 &&
        openAssets.some((row) => {
          const at = timestamp(row.priceAt);
          return at === 0 || now - at > STALE_PRICE_MS;
        }),
      scheduleEnabled,
      nextRunAt,
      nextRuns,
    };

    // Mark the current version as seen so the badge clears until something new lands.
    if (watchlist.length > 0) repo.setKv(SEEN_WATCHLIST_KV_KEY, new Date(latestWatchAt).toISOString());
    if (advice.length > 0) repo.setKv(SEEN_ADVICE_KV_KEY, new Date(latestAdviceAt).toISOString());

    /* ── block 3: top holdings ── */
    const topHoldings = summaries
      .filter((item) => item.shares > 0)
      .sort((a, b) => b.marketValue - a.marketValue)
      .slice(0, 5);

    /* ── block 4: AI briefing ── */
    const briefing = readBriefing(settings);

    /* ── extra: budget + indices ── */
    const budget: BudgetStatus = computeBudgetStatus(rows, transactions, settings.budget, localMonth());

    let indices: Quote[] = [];
    const bridge = await loadMarketBridge();
    if (!bridge) {
      request.log.warn('行情数据源不可用（AIA_OFFLINE 或 datasources 模块缺失），indices 降级为空数组');
    } else {
      try {
        indices = await bridge.indices();
      } catch (error) {
        request.log.warn({ err: error }, '全球指数获取失败，indices 降级为空数组');
      }
    }

    const payload: DashboardPayload = {
      portfolio,
      counts,
      topHoldings,
      briefing,
      signals,
      budget,
      indices,
      updatedAt: nowIso(),
    };
    return payload;
  });
}
