/**
 * Inference-metric formatting & aggregation for the reasoning dock. Owner: Lead.
 *
 * Pure functions only (no React, no DOM) so the numbers the user actually reads —
 * TTFT, generation speed, token usage, KV-cache hit rate — are unit-testable.
 * The wire shape is `InferenceMetrics` (see @aia/shared): one `first-token` and
 * one `done` event per `/chat/completions` request.
 */
import type { InferenceMetrics } from '@aia/shared';

export interface MetricsTotals {
  /** LLM requests that already finished (`phase: 'done'`). */
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Prompt tokens served from the provider's prompt/KV cache. */
  cachedTokens: number;
  /** cachedTokens / promptTokens (0..1); null while unknown. */
  cacheHitRate: number | null;
  /** Speed of the most recent request, tokens/s; null while unknown. */
  tokensPerSecond: number | null;
  /** Best / worst TTFT seen in this stream, ms. */
  bestTtftMs: number | null;
  worstTtftMs: number | null;
  /** Wall time of the most recent request, ms. */
  lastLatencyMs: number | null;
  /** Model of the most recent request. */
  model: string | null;
}

export const EMPTY_TOTALS: MetricsTotals = {
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cachedTokens: 0,
  cacheHitRate: null,
  tokensPerSecond: null,
  bestTtftMs: null,
  worstTtftMs: null,
  lastLatencyMs: null,
  model: null,
};

/**
 * Aggregates every metrics event of one stream session.
 *
 * `first-token` events only carry timing, so usage totals are summed over the
 * `done` events alone — otherwise a single request would be counted twice.
 */
export function summarizeMetrics(events: InferenceMetrics[]): MetricsTotals {
  if (events.length === 0) return EMPTY_TOTALS;
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let requests = 0;
  let tokensPerSecond: number | null = null;
  let bestTtftMs: number | null = null;
  let worstTtftMs: number | null = null;
  let lastLatencyMs: number | null = null;
  let model: string | null = null;
  for (const event of events) {
    if (event.model) model = event.model;
    if (typeof event.ttftMs === 'number' && Number.isFinite(event.ttftMs)) {
      bestTtftMs = bestTtftMs === null ? event.ttftMs : Math.min(bestTtftMs, event.ttftMs);
      worstTtftMs = worstTtftMs === null ? event.ttftMs : Math.max(worstTtftMs, event.ttftMs);
    }
    if (event.phase !== 'done') continue;
    requests += 1;
    promptTokens += event.promptTokens;
    completionTokens += event.completionTokens;
    cachedTokens += event.cachedTokens;
    if (typeof event.tokensPerSecond === 'number' && Number.isFinite(event.tokensPerSecond)) {
      tokensPerSecond = event.tokensPerSecond;
    }
    if (typeof event.latencyMs === 'number' && Number.isFinite(event.latencyMs)) lastLatencyMs = event.latencyMs;
  }
  return {
    requests,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cachedTokens,
    cacheHitRate: promptTokens > 0 ? Math.min(1, cachedTokens / promptTokens) : null,
    tokensPerSecond,
    bestTtftMs,
    worstTtftMs,
    lastLatencyMs,
    model,
  };
}

/** `1250` → `1.25s`, `84000` → `1m24s`; null → `—`. */
export function fmtMilliseconds(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

/** Thousands separators without relying on ICU (`12480` → `12,480`). */
export function fmtTokens(count: number | null | undefined): string {
  if (typeof count !== 'number' || !Number.isFinite(count)) return '—';
  const rounded = Math.round(count);
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** `42.06` → `42.1 tok/s`; null → `—`. */
export function fmtSpeed(tokensPerSecond: number | null | undefined): string {
  if (typeof tokensPerSecond !== 'number' || !Number.isFinite(tokensPerSecond)) return '—';
  return `${tokensPerSecond.toFixed(1)} tok/s`;
}

/** `0.8734` → `87.3%`; null → `—`. */
export function fmtCacheHitRate(rate: number | null | undefined): string {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '—';
  return `${(Math.max(0, Math.min(1, rate)) * 100).toFixed(1)}%`;
}

/** Human summary of what a finished stream wrote, e.g. `资产 ×3 · 标的 +2`. */
export function summarizeEntities(entities: { action: string; entity: string; label: string }[]): string[] {
  const LABELS: Record<string, string> = {
    asset: '资产',
    watchlist: '标的',
    advice: '建议',
    briefing: '简报',
    settings: '设置',
  };
  const MARK: Record<string, string> = { created: '+', updated: '~', deleted: '-' };
  const counts = new Map<string, number>();
  for (const entity of entities) {
    const key = `${entity.entity}|${entity.action}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => {
    const [entity, action] = key.split('|');
    return `${LABELS[entity ?? ''] ?? entity} ${MARK[action ?? ''] ?? action}${count}`;
  });
}
