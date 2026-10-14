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
  DashboardSignals,
  Quote,
} from '@aia/shared';

import { getRepo, getScheduler } from '../registry.js';
import type { StoredSettings, TxRow } from '../types/models.js';
import type { Scheduler } from '../types/agent.js';
import { loadMarketBridge, localMonth, nowIso, parseJson, toNumber } from '../db/util.js';
import { computeBudgetStatus, computePosition, summarizePortfolio, toAssetSummary } from '../services/portfolio.js';
import { getFxRatesResult } from '../services/fx.js';
import { getActiveScheduler } from '../services/scheduler.js';

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
 * the app without `index.ts`) we approximate the plan from the stored schedule.
 * The live scheduler is authoritative — see `signals` below.
 */
function computeNextRunAt(settings: StoredSettings, lastRunAt: string | null): string | null {
  const schedule = settings.schedule;
  if (schedule.mode === 'off') return null;
  const now = new Date();
  if (schedule.mode === 'interval') {
    const base = timestamp(lastRunAt) || now.getTime();
    const interval = Math.max(1, toNumber(schedule.intervalMinutes, 1440)) * 60_000;
    const next = new Date(base + interval);
    return (next.getTime() > now.getTime() ? next : now).toISOString();
  }
  const [hour, minute] = (schedule.dailyTime || '00:00').split(':').map((part) => toNumber(part));
  const next = new Date(now);
  next.setHours(Math.min(23, Math.max(0, hour)), Math.min(59, Math.max(0, minute)), 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
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

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/dashboard', async (request): Promise<DashboardPayload> => {
    const repo = getRepo();
    const settings = repo.getSettings();
    const now = Date.now();

    const grouped = new Map<string, TxRow[]>();
    for (const tx of repo.listTransactions()) {
      const list = grouped.get(tx.assetId);
      if (list) list.push(tx);
      else grouped.set(tx.assetId, [tx]);
    }

    const rows = repo.listAssets();
    const summaries: AssetSummary[] = rows.map((row) => toAssetSummary(row, grouped.get(row.id) ?? []));

    /* ── block 1: portfolio (CNY) ── */
    const fx = await getFxRatesResult(repo);
    if (fx.warning) request.log.warn({ warning: fx.warning }, 'fx rates fell back to built-in table');
    const portfolio = summarizePortfolio(summaries, fx.rates);

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

    // The scheduler is the source of truth: `scheduleEnabled` must mean "a run
    // is really planned", not merely "mode !== off" (M1 regression).
    const scheduler = liveScheduler();
    const schedulerNext = scheduler?.nextRunAt() ?? null;
    const scheduleEnabled = scheduler ? schedulerNext !== null : settings.schedule.mode !== 'off';
    const nextRunAt = scheduler ? schedulerNext : computeNextRunAt(settings, counts.lastRunAt);

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
    const budget: BudgetStatus = computeBudgetStatus(rows, repo.listTransactions(), settings.budget, localMonth());

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
