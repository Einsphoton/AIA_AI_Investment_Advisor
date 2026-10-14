/**
 * 行情 / K线 / 基本面 / 基金 / 宏观 / 资讯 (docs/API.md §8).
 *
 * Owner: agent-engine. All responses come from `datasources/registry.ts`, which
 * degrades across providers and reports `sources` / `warnings`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BarInterval, InstrumentType, Market, RangeKey } from '@aia/shared';
import { badRequest, notFound, upstreamError } from '../errors.js';
import * as ds from '../datasources/registry.js';

function query(request: FastifyRequest): Record<string, string> {
  return (request.query ?? {}) as Record<string, string>;
}

function requireParam(request: FastifyRequest, key: string): string {
  const value = query(request)[key]?.trim();
  if (!value) throw badRequest(`缺少查询参数 ${key}`);
  return value;
}

function parseMarket(request: FastifyRequest, key = 'market'): Market {
  const raw = requireParam(request, key).toUpperCase();
  if (raw !== 'CN' && raw !== 'HK' && raw !== 'US') {
    throw badRequest(`market 必须是 CN / HK / US，收到「${raw}」`);
  }
  return raw;
}

function optionalMarket(request: FastifyRequest): Market | undefined {
  const raw = query(request).market?.trim().toUpperCase();
  if (!raw) return undefined;
  if (raw !== 'CN' && raw !== 'HK' && raw !== 'US') {
    throw badRequest(`market 必须是 CN / HK / US，收到「${raw}」`);
  }
  return raw;
}

function parseType(request: FastifyRequest, fallback: InstrumentType = 'stock'): InstrumentType {
  const raw = query(request).type?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'stock' || raw === 'etf' || raw === 'fund') return raw;
  throw badRequest(`type 必须是 stock / etf / fund，收到「${raw}」`);
}

function parseRange(request: FastifyRequest): RangeKey {
  const raw = query(request).range?.trim().toLowerCase() ?? '1y';
  const allowed: RangeKey[] = ['1m', '3m', '6m', '1y', '3y', '5y', 'max'];
  if (!allowed.includes(raw as RangeKey)) throw badRequest(`range 必须是 ${allowed.join(' / ')}`);
  return raw as RangeKey;
}

function parseInterval(request: FastifyRequest): BarInterval {
  const raw = query(request).interval?.trim().toLowerCase() ?? 'day';
  if (raw !== 'day' && raw !== 'week' && raw !== 'month') throw badRequest('interval 必须是 day / week / month');
  return raw;
}

/** Distinguishes "no such symbol" (404) from "upstream failed" (502). */
/**
 * Fault mapping (L3 — one upstream failure must not yield three different codes):
 *
 *  1. 有有效内容 → `200`（可携带 warnings，例如 quote 缺失但有基本面）。
 *  2. 上游确认代码不存在 → `404 NOT_FOUND`。判定依据：`market_search` 正常返回，
 *     但没有任何一条命中该 market+code（交易所侧没有这个标的）。
 *  3. 取不到任何内容、且无法证明标的不存在 → `502 UPSTREAM_ERROR`。判定依据：
 *     provider 全部失败（`sources` 为空）、搜索本身也失败（无法证明 404）、
 *     或上游只回了一个没有有效价格的空壳。
 */
type Existence = 'exists' | 'missing' | 'unknown';

/** Tri-state existence probe: only `missing` justifies a 404. */
async function probeExistence(market: Market, code: string): Promise<Existence> {
  try {
    const search = await ds.searchInstruments(code, market);
    if (search.value.some((hit) => hit.code.toUpperCase() === code.toUpperCase() && hit.market === market)) {
      return 'exists';
    }
    // `sources` only lists providers that *produced hits*, so an empty result set
    // is not proof of failure — the warnings tell us whether a provider broke.
    const providerFailed = search.warnings.some((warning) => /失败|超时|ECONN|HTTP \d|不可用/.test(warning));
    return providerFailed ? 'unknown' : 'missing';
  } catch {
    return 'unknown';
  }
}

/** Builds the error to throw: only a proven-missing symbol yields a 404. */
async function faultError(kind: string, market: Market, code: string, details?: unknown): Promise<never> {
  const existence = await probeExistence(market, code);
  if (existence === 'missing') {
    throw notFound(`未找到 ${market}/${code}：上游确认该代码不存在`, details);
  }
  throw upstreamError(
    `${kind} ${market}/${code} 获取失败：所有数据源均未返回有效内容${
      existence === 'unknown' ? '（标的搜索也不可用，无法判定代码是否存在）' : ''
    }`,
    details,
  );
}

export async function registerMarketRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/market/search', async (request) => {
    const q = requireParam(request, 'q');
    const market = optionalMarket(request);
    const result = await ds.searchInstruments(q, market);
    return result.value;
  });

  app.get('/api/market/quote', async (request) => {
    const market = parseMarket(request);
    const code = requireParam(request, 'code');
    const type = parseType(request);
    const result = await ds.getQuote({ code, market, type });
    // No result, or an upstream shell without a usable price → 404 or 502.
    if (!result || result.value.price <= 0) {
      throw await faultError('实时报价', market, code, {
        warnings: result?.warnings ?? [],
        price: result?.value.price ?? null,
      });
    }
    return result.value;
  });

  app.get('/api/market/series', async (request) => {
    const market = parseMarket(request);
    const code = requireParam(request, 'code');
    const type = parseType(request);
    const result = await ds.getSeries({ code, market, type, range: parseRange(request), interval: parseInterval(request) });
    if (!result || result.value.points.length === 0) {
      throw await faultError('行情序列', market, code, { warnings: result?.warnings ?? [] });
    }
    return { ...result.value, warnings: [...result.value.warnings, ...result.warnings] };
  });

  app.get('/api/market/profile', async (request) => {
    const market = parseMarket(request);
    const code = requireParam(request, 'code');
    const type = parseType(request);
    const profile = await ds.getProfile({ code, market, type });
    const partial = Boolean(profile.quote) || Boolean(profile.fundamentals) || Boolean(profile.fundInfo);
    if (!partial) {
      throw await faultError('资料', market, code, { warnings: profile.warnings });
    }
    // Partial content stays 200 — the caller sees exactly what is missing.
    const warnings = [...profile.warnings];
    if (!profile.quote) warnings.push('实时报价不可用（其余资料仍可参考）');
    if (type === 'fund' && !profile.fundInfo) warnings.push('基金详情不可用');
    return { ...profile, warnings };
  });

  app.get('/api/market/detail', async (request) => {
    const market = parseMarket(request);
    const code = requireParam(request, 'code');
    const type = parseType(request);
    const range = parseRange(request);
    const interval = parseInterval(request);
    const [seriesResult, profile] = await Promise.all([
      ds.getSeries({ code, market, type, range, interval }),
      ds.getProfile({ code, market, type }),
    ]);
    const series = seriesResult
      ? { ...seriesResult.value, warnings: [...seriesResult.value.warnings, ...seriesResult.warnings] }
      : null;
    const hasPartial = Boolean(series) || Boolean(profile.quote) || Boolean(profile.fundInfo) || Boolean(profile.fundamentals);
    if (!hasPartial) {
      throw await faultError('详情', market, code, [...profile.warnings, ...(seriesResult?.warnings ?? [])]);
    }
    return { series, profile };
  });

  app.get('/api/market/indices', async () => {
    const result = await ds.getIndices();
    return result.value;
  });

  app.get('/api/market/macro', async () => {
    return ds.getMacro();
  });

  app.get('/api/market/news', async (request) => {
    const q = query(request).q?.trim() || '股市';
    const result = await ds.getNews(q, 12);
    return result.value;
  });
}
