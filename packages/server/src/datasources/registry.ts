/**
 * Datasource registry — the single entry point every route/service/tool uses.
 *
 * Responsibilities:
 *  - pick providers from `settings.dataSources` (pin or `auto` built-in chain)
 *  - degrade automatically, recording `sources[]` + `warnings[]` (never silent 0s)
 *  - expose instrument resolution/search/quote/series/profile/indices/macro/news
 *
 * Owner: agent-engine.
 */
import {
  DEFAULT_DATA_SOURCES,
  MARKET_CURRENCY,
  SOURCE_CATALOGUE_MAP,
  type DataSourceChoice,
  type DataSourceConfig,
  type DividendItem,
  type Financials,
  type Fundamentals,
  type FundInfo,
  type InstrumentType,
  type MacroSnapshot,
  type Market,
  type NewsItem,
  type ProfileResponse,
  type Quote,
  type SeriesResponse,
  type SourceId,
} from '@aia/shared';
import { getRepo } from '../registry.js';
import type { StoredSettings } from '../types/models.js';
import {
  emDividends,
  emFundamentals,
  emQuote,
  emSearch,
  emSeries,
} from './eastmoney.js';
import { fundInfo, fundQuote, fundSearch, fundSeries } from './fund.js';
import { emFinancials } from './financials.js';
import { globalIndices } from './indices.js';
import { keyedFundamentals, keyedQuote, keyedSeries } from './keyed.js';
import { macroBundle, macroReport } from './macro.js';
import { newsSearch } from './news.js';
import { normalizeUsTicker, tencentFundamentals, tencentQuote, tencentSeries } from './tencent.js';
import { tryText, errorMessage, clearHttpCache } from './http.js';
import type {
  DataSourceSlot,
  MacroBundle,
  ProviderQuote,
  ProviderSeries,
  ResolvedInstrument,
  SearchHit,
  SearchOptions,
  Sourced,
  SeriesQuery,
  WebSearchResponse,
} from './types.js';
import { webSearch, type WebSearchOptions } from './websearch.js';

/* ──────────────────────────── settings plumbing ──────────────────────────── */

let injectedKeys: Record<string, string> = {};

/** Called by `createAgent` so env-provided keys reach the datasources. */
export function setProviderKeys(keys: Record<string, string>): void {
  injectedKeys = { ...keys };
}

/** Dropped whenever settings change (settings route calls it). */
export function resetDataSourceCache(): void {
  clearHttpCache();
}

function storedSettings(): StoredSettings | null {
  try {
    return getRepo().getSettings();
  } catch {
    return null;
  }
}

export function currentDataSources(): DataSourceConfig {
  return storedSettings()?.dataSources ?? DEFAULT_DATA_SOURCES;
}

export function slotFor(market: Market, type: InstrumentType): DataSourceSlot {
  const kind = type === 'fund' ? 'fund' : 'stock';
  return `${kind}${market}` as DataSourceSlot;
}

function choiceFor(slot: DataSourceSlot): DataSourceChoice {
  const config = currentDataSources();
  return config[slot] ?? { provider: 'auto', enabled: true };
}

function providerKey(provider: SourceId): string {
  return injectedKeys[provider]?.trim() ?? '';
}

/** Providers that are usable right now (keyed ones only with a key). */
function usable(provider: SourceId): boolean {
  const entry = SOURCE_CATALOGUE_MAP[provider];
  if (!entry) return false;
  if (!entry.requiresKey) return true;
  return providerKey(provider).length > 0;
}

/**
 * Collapses an upstream failure into one readable line.
 *
 * `UpstreamHttpError.message` embeds up to 160 characters of the response body,
 * and a gateway outage answers with a whole HTML error page. Those warnings are
 * surfaced twice — in the activity timeline **and** in the `数据缺失` list of the
 * prompt — so the raw markup was pure noise in both.
 */
export function condenseUpstreamError(message: string): string {
  const flat = message.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const [head = '', ...rest] = flat.split('::');
  const detail = rest.join(' ').trim();
  const line = detail ? `${head.trim()}（${detail.slice(0, 90)}）` : head.trim();
  return line.slice(0, 200);
}

function byPriority(providers: SourceId[]): SourceId[] {
  return [...providers].sort(
    (a, b) => (SOURCE_CATALOGUE_MAP[a]?.priority ?? 99) - (SOURCE_CATALOGUE_MAP[b]?.priority ?? 99),
  );
}

/**
 * Ordered provider chain for a slot: the user's pin first (with its own key),
 * then the built-in zero-key chain. Unusable providers are dropped.
 */
export function providerChain(slot: DataSourceSlot, kind: 'quote' | 'series' | 'fundamentals'): SourceId[] {
  const choice = choiceFor(slot);
  const market = slot.endsWith('CN') ? 'CN' : slot.endsWith('HK') ? 'HK' : 'US';
  const isFundSlot = slot.startsWith('fund');

  let base: SourceId[];
  if (kind === 'fundamentals') {
    base = ['eastmoney', 'tencent', 'alphavantage', 'finnhub', 'fmp'];
  } else if (kind === 'series') {
    // `tencent` MUST be in the series chain: it is the only other zero-key K-line
    // source, and Eastmoney's `push2his` host is unreachable from some networks
    // (实测 HTTP 502 / 连接失败)。此前链里只有 eastmoney，该主机一挂
    // `get_series` 就对所有标的返回 no_data。
    base = ['eastmoney', 'tencent', 'finnhub', 'alphavantage'];
  } else if (isFundSlot) {
    base = ['eastmoney-fund'];
  } else {
    base = market === 'CN' ? ['eastmoney', 'tencent'] : ['eastmoney', 'tencent', 'finnhub', 'alphavantage', 'fmp'];
  }

  const chain: SourceId[] = [];
  if (choice.enabled !== false && choice.provider !== 'auto' && SOURCE_CATALOGUE_MAP[choice.provider as SourceId]) {
    chain.push(choice.provider as SourceId);
  }
  for (const provider of byPriority(base)) {
    if (!chain.includes(provider)) chain.push(provider);
  }
  return chain.filter((provider) => usable(provider) || provider === choice.provider);
}

/* ──────────────────────────────── quote ─────────────────────────────────── */

export interface QuoteRequest {
  code: string;
  market: Market;
  type?: InstrumentType;
  /**
   * Receives the degradation notes even when **every** provider fails (the
   * `null` return discards the `Sourced.warnings` otherwise, so the caller could
   * not tell「代码不存在」from「数据源全部不可用」and the UI/model only ever saw
   * a generic `no_data`).
   */
  onWarnings?: (warnings: string[]) => void;
}

/**
 * Real-time quote with automatic provider degradation.
 * Returns null only when every provider failed; callers surface `warnings`.
 */
export async function getQuote(request: QuoteRequest): Promise<Sourced<Quote> | null> {
  const market = request.market;
  const code = normalizeCode(market, request.code);
  const type = request.type ?? 'stock';
  const slot = slotFor(market, type);
  const warnings: string[] = [];
  const sources: SourceId[] = [];

  if (type === 'fund') {
    const quote = await fundQuote(code);
    if (quote) return { value: quote, sources: ['eastmoney-fund'], warnings };
    warnings.push('场外基金净值获取失败（天天基金 pingzhongdata / lsjz）');
    return null;
  }

  for (const provider of providerChain(slot, 'quote')) {
    try {
      const result = await quoteFromProvider(provider, market, code, slot, (message) =>
        warnings.push(`${provider} 报价失败：${condenseUpstreamError(message)}`),
      );
      if (result && result.quote.name) {
        sources.push(provider);
        return { value: result.quote, sources, warnings };
      }
      warnings.push(`${provider} 未返回报价（${code}/${market}）`);
    } catch (error) {
      warnings.push(`${provider} 报价失败：${condenseUpstreamError(errorMessage(error))}`);
    }
  }
  request.onWarnings?.(warnings);
  return null;
}

async function quoteFromProvider(
  provider: SourceId,
  market: Market,
  code: string,
  slot: DataSourceSlot,
  onError: (message: string) => void,
): Promise<ProviderQuote | null> {
  switch (provider) {
    case 'eastmoney':
      return emQuote(market, code, onError);
    case 'tencent':
      return tencentQuote(market, code);
    case 'finnhub':
    case 'alphavantage':
    case 'fmp':
      return keyedQuote(provider, market, code, providerKey(provider));
    case 'eastmoney-fund':
      return fundQuote(code).then((quote) => (quote ? { quote, source: 'eastmoney-fund' as SourceId } : null));
    default:
      return null;
  }
}

/* ─────────────────────────────── series ─────────────────────────────────── */

/** K-line for stocks/ETFs, NAV curve for open-end funds. */
export async function getSeries(query: SeriesQuery): Promise<Sourced<SeriesResponse> | null> {
  const market = query.market;
  const code = normalizeCode(market, query.code);
  const type = query.type ?? 'stock';
  const warnings: string[] = [];
  const sources: SourceId[] = [];

  if (type === 'fund') {
    const series = await fundSeries(code, query.range, market, type);
    if (series && series.points.length > 0) return { value: series, sources: ['eastmoney-fund'], warnings };
    warnings.push('场外基金净值曲线不可用（pingzhongdata 解析失败），尝试净值历史接口');
    // fall back to the paginated NAV history
    const { fundNavHistory } = await import('./fund.js');
    const rows = await fundNavHistory(code, 200);
    if (rows.length > 0) {
      const points = rows
        .map((row) => ({
          date: row.date,
          open: row.nav,
          high: row.nav,
          low: row.nav,
          close: row.nav,
          volume: 0,
          accumNav: row.accumNav,
        }))
        .reverse();
      const seriesResponse: SeriesResponse = {
        code,
        market,
        type,
        kind: 'nav',
        interval: 'day',
        range: query.range,
        currency: 'CNY',
        name: '',
        points,
        sources: ['eastmoney-fund'],
        warnings,
      };
      return { value: seriesResponse, sources: ['eastmoney-fund'], warnings };
    }
    return null;
  }

  const slot = slotFor(market, type);
  for (const provider of providerChain(slot, 'series')) {
    try {
      const result = await seriesFromProvider(
        provider,
        market,
        code,
        type,
        query.range,
        query.interval,
        slot,
        (message) => warnings.push(`${provider} K线失败：${condenseUpstreamError(message)}`),
      );
      if (result && result.series.points.length > 0) {
        sources.push(provider);
        const merged = { ...result.series, warnings: [...result.series.warnings, ...warnings] };
        return { value: merged, sources, warnings };
      }
      warnings.push(`${provider} 未返回 ${query.interval} K线（${code}/${market}）`);
    } catch (error) {
      warnings.push(`${provider} K线失败：${condenseUpstreamError(errorMessage(error))}`);
    }
  }
  // Expose *why* every provider failed — otherwise the caller (and the user) only
  // sees a generic `no_data` and cannot tell a bad symbol from a dead upstream.
  query.onWarnings?.(warnings);
  return null;
}

async function seriesFromProvider(
  provider: SourceId,
  market: Market,
  code: string,
  type: InstrumentType,
  range: SeriesQuery['range'],
  interval: SeriesQuery['interval'],
  _slot: DataSourceSlot,
  onError: (message: string) => void,
): Promise<ProviderSeries | null> {
  switch (provider) {
    case 'eastmoney':
      return emSeries(market, code, type, range, interval, onError);
    case 'tencent':
      return tencentSeries(market, code, range, interval, type);
    case 'finnhub':
    case 'alphavantage':
      return keyedSeries(provider, market, code, range, interval, providerKey(provider));
    default:
      return null;
  }
}

/* ─────────────────────────────── profile ────────────────────────────────── */

/** Full instrument profile: quote + fundamentals + fund detail + dividends. */
export async function getProfile(request: QuoteRequest): Promise<ProfileResponse> {
  const market = request.market;
  const code = normalizeCode(market, request.code);
  const type = request.type ?? 'stock';
  if (type === 'fund') return fundProfile(code, market, type);

  const sources: SourceId[] = [];
  const warnings: string[] = [];
  const [quoteResult, fundamentalsResult, dividendsResult] = await Promise.all([
    getQuote({ code, market, type }),
    getFundamentals({ code, market, type }),
    getDividends({ code, market, type }),
  ]);
  const quote = quoteResult?.value ?? null;
  if (quoteResult) {
    sources.push(...quoteResult.sources);
    warnings.push(...quoteResult.warnings);
  } else {
    warnings.push(`${market}/${code} 报价不可用`);
  }
  if (fundamentalsResult) {
    sources.push(...fundamentalsResult.sources);
    warnings.push(...fundamentalsResult.warnings);
  }
  if (dividendsResult) {
    sources.push(...dividendsResult.sources);
    warnings.push(...dividendsResult.warnings);
  }
  return {
    quote,
    fundamentals: fundamentalsResult?.value ?? null,
    fundInfo: null,
    dividends: dividendsResult?.value ?? [],
    sources: [...new Set(sources)],
    warnings,
  };
}

async function fundProfile(code: string, market: Market, type: InstrumentType): Promise<ProfileResponse> {
  const [info, quote] = await Promise.all([fundInfo(code), fundQuote(code)]);
  const warnings: string[] = [];
  const sources: SourceId[] = ['eastmoney-fund'];
  if (!info) warnings.push('场外基金详情不可用（pingzhongdata 无数据）');
  if (!quote) warnings.push('场外基金净值不可用');
  if (info && info.holdings.some((h) => h.weight === 0)) {
    warnings.push('基金重仓股权重不可用，仅返回股票代码');
  }
  return {
    quote,
    fundamentals: null,
    fundInfo: info,
    dividends: [],
    sources,
    warnings,
  };
}

export interface FundamentalsRequest {
  code: string;
  market: Market;
  type?: InstrumentType;
  name?: string;
  /** See {@link QuoteRequest.onWarnings}. */
  onWarnings?: (warnings: string[]) => void;
}

/** Financial/fundamental indicators with provider degradation. */
export async function getFundamentals(request: FundamentalsRequest): Promise<Sourced<Fundamentals> | null> {
  const market = request.market;
  const code = normalizeCode(market, request.code);
  const type = request.type ?? 'stock';
  if (type === 'fund') return null;
  const slot = slotFor(market, type);
  const warnings: string[] = [];
  for (const provider of providerChain(slot, 'fundamentals')) {
    try {
      // Tencent derives PE/PB from its quote record, which for an ETF carries
      // fund-scale fields (实测 510880 的「PB」=3.85，与该 ETF 的净资产口径无关).
      // Publishing that as 市净率 would put a fabricated number into a report, so
      // the fallback is restricted to stocks; Eastmoney F10 is still tried first.
      if (provider === 'tencent' && type === 'etf') {
        warnings.push('tencent 不提供 ETF 的公司基本面指标（不适用）');
        continue;
      }
      const value =
        provider === 'eastmoney'
          ? await emFundamentals(market, code, request.name ?? '')
          : provider === 'tencent'
            ? await tencentFundamentals(market, code, request.name ?? '')
            : await keyedFundamentals(provider, market, code, providerKey(provider));
      if (value && value.metrics.length > 0) {
        return { value, sources: [provider], warnings };
      }
      warnings.push(`${provider} 未返回基本面指标（${code}/${market}）`);
    } catch (error) {
      warnings.push(`${provider} 基本面失败：${condenseUpstreamError(errorMessage(error))}`);
    }
  }
  request.onWarnings?.(warnings);
  return null;
}

export interface FinancialsRequest {
  code: string;
  market: Market;
  type?: InstrumentType;
  name?: string;
  /** 需要的报告期数量（1-8），默认 4。 */
  periods?: number;
}

/**
 * 财报三表（利润表 / 资产负债表 / 现金流量表，多期）。
 *
 * 目前只有东方财富 F10 提供零 Key 的三表：A 股完整三表，港股为利润表 + 资产负债表 +
 * 主要指标兜底的现金流总量，美股为利润表 + 资产负债表（现金流量表明细上游无接口）。
 * 基金/ETF 没有财报，直接返回 null —— 调用方必须把「不可用」写进结论。
 */
export async function getFinancials(request: FinancialsRequest): Promise<Sourced<Financials> | null> {
  const market = request.market;
  const type = request.type ?? 'stock';
  if (type !== 'stock') return null;
  const code = normalizeCode(market, request.code);
  if (!code) return null;
  try {
    const value = await emFinancials(market, code, request.name ?? '', request.periods ?? 4);
    if (!value) return null;
    return { value, sources: value.sources, warnings: value.warnings };
  } catch {
    return null;
  }
}

export interface DividendsRequest {
  code: string;
  market: Market;
  type?: InstrumentType;
}

/** 分红送配 (A股可用；港美股上游无零 Key 源). */
export async function getDividends(request: DividendsRequest): Promise<Sourced<DividendItem[]>> {
  const market = request.market;
  const code = normalizeCode(market, request.code);
  const warnings: string[] = [];
  if (market !== 'CN') {
    warnings.push('港美股的零 Key 分红数据源不可用（东方财富港美股 F10 返回 404），请用 web_search 查询');
    return { value: [], sources: [], warnings };
  }
  try {
    const items = await emDividends(market, code);
    if (items.length === 0) warnings.push('未查询到分红送配记录');
    return { value: items, sources: ['eastmoney'], warnings };
  } catch (error) {
    warnings.push(`分红数据获取失败：${errorMessage(error)}`);
    return { value: [], sources: [], warnings };
  }
}

/* ──────────────────────────────── search ────────────────────────────────── */

/** Cross-market instrument search (code → name auto-complete). */
export async function searchInstruments(query: string, market?: Market): Promise<Sourced<SearchHit[]>> {
  const q = query.trim();
  if (!q) return { value: [], sources: [], warnings: ['搜索关键词为空'] };
  const warnings: string[] = [];
  const sources: SourceId[] = [];
  const hits: SearchHit[] = [];

  try {
    const em = await emSearch(q, { market, limit: 12 });
    if (em.length > 0) {
      hits.push(...em);
      sources.push('eastmoney');
    }
  } catch (error) {
    warnings.push(`东方财富搜索失败：${errorMessage(error)}`);
  }

  if (!market || market === 'CN') {
    try {
      const funds = await fundSearch(q, 8);
      // fundsuggest also echoes listed securities (e.g. 600519), which would
      // duplicate the Eastmoney stock hit — dedupe by market+code, stocks win.
      const seenCodes = new Set(hits.map((h) => `${h.market}:${h.code}`));
      const existing = new Set(hits.map((h) => `${h.market}:${h.code}:${h.type}`));
      let added = 0;
      for (const hit of funds) {
        const codeKey = `${hit.market}:${hit.code}`;
        const key = `${codeKey}:${hit.type}`;
        if (existing.has(key) || seenCodes.has(codeKey)) continue;
        hits.push(hit);
        existing.add(key);
        seenCodes.add(codeKey);
        added += 1;
      }
      if (added > 0) sources.push('eastmoney-fund');
    } catch (error) {
      warnings.push(`基金搜索失败：${errorMessage(error)}`);
    }
  }

  if (hits.length === 0) warnings.push(`未找到匹配「${q}」的标的`);
  return { value: hits, sources: [...new Set(sources)], warnings };
}

/* ─────────────────────── instrument resolution ──────────────────────────── */

/**
 * Turns a bare code into a fully-described instrument (name/currency/exchange).
 * Quote is authoritative; search is the fallback when the code is not listed.
 */
export async function resolveInstrument(request: {
  code: string;
  market: Market;
  type?: InstrumentType;
}): Promise<Sourced<ResolvedInstrument> | null> {
  const market = request.market;
  const code = normalizeCode(market, request.code);
  const warnings: string[] = [];
  const type = request.type ?? 'stock';

  const quote = await getQuote({ code, market, type });
  if (quote) {
    warnings.push(...quote.warnings);
    return {
      value: {
        code: quote.value.code,
        market: quote.value.market,
        type,
        name: quote.value.name,
        currency: quote.value.currency,
        exchange: exchangeLabel(quote.value.market, quote.value.code, type),
        source: quote.sources[0] ?? 'eastmoney',
      },
      sources: quote.sources,
      warnings,
    };
  }

  const search = await searchInstruments(code, market);
  warnings.push(...search.warnings);
  const hit =
    search.value.find((h) => h.code === code && h.market === market && h.type === type) ??
    search.value.find((h) => h.code === code && h.market === market) ??
    search.value[0];
  if (!hit) return null;
  return {
    value: {
      code: hit.code,
      market: hit.market,
      type,
      name: hit.name,
      currency: MARKET_CURRENCY[hit.market],
      exchange: hit.exchange || exchangeLabel(hit.market, hit.code, type),
      source: hit.source,
    },
    sources: search.sources,
    warnings,
  };
}

function exchangeLabel(market: Market, code: string, type: InstrumentType): string {
  if (type === 'fund') return '场外基金';
  if (market === 'HK') return '港交所';
  if (market === 'US') return '美股';
  if (/^(60|68|9|5)/.test(code)) return '沪A';
  return '深A';
}

/**
 * Per-market code normalization.
 *
 * HK codes are 5 digits upstream; keep the user's format but pad when needed.
 * US tickers are spelled inconsistently (`BRK-B` / `BRK_B` / `BRKB` / `BRK.B`) —
 * production burned 4 `get_quote` calls on `US/BRK-B`, `US/BRK-A`, `US/BRKB` and
 * `US/BRK_B`, all `no_data`. Any explicit separator is folded to the dotted form
 * both providers accept.
 *
 * The **dashless** spelling is only mapped for an exact known set: `BRKB` and
 * `BRKR` are indistinguishable by shape (`BRK` + one letter), and rewriting a
 * real ticker would be far worse than leaving `BRKB` unresolved — an earlier
 * shape-based rule turned `BRKR` (Bruker Corp, a listed Nasdaq ticker) into the
 * nonexistent `BRK.R`.
 */
export function normalizeCode(market: Market, code: string): string {
  const clean = code.trim().toUpperCase();
  if (market === 'HK' && /^\d{1,4}$/.test(clean)) return clean.padStart(5, '0');
  if (market === 'US') {
    const dotted = normalizeUsTicker(clean);
    if (dotted !== clean) return dotted;
    return DASHLESS_US_CLASS_SHARES.get(clean) ?? clean;
  }
  return clean;
}

/** Exact dashless class-share spellings seen in the wild (never guess by shape). */
const DASHLESS_US_CLASS_SHARES = new Map([
  ['BRKB', 'BRK.B'],
  ['BRKA', 'BRK.A'],
]);

/* ─────────────────────────────── indices ────────────────────────────────── */

/** Global index snapshot: Eastmoney first, Tencent fallback (see `indices.ts`). */
export async function getIndices(): Promise<Sourced<Quote[]>> {
  return globalIndices();
}

/* ──────────────────────────────── macro ─────────────────────────────────── */

export async function getMacro(): Promise<MacroSnapshot> {
  const [bundle, news] = await Promise.all([macroBundle(), newsSearch('股市', 8)]);
  return {
    items: bundle.items,
    indices: bundle.indices,
    news,
    updatedAt: new Date().toISOString(),
    warnings: bundle.warnings,
    notes: bundle.notes,
  };
}

/** Lower-level macro bundle accessor (tools / diagnostics). */
export async function getMacroBundle(): Promise<MacroBundle> {
  return macroBundle();
}

export async function getNews(query: string, limit = 8): Promise<Sourced<NewsItem[]>> {
  const warnings: string[] = [];
  try {
    const items = await newsSearch(query, limit);
    if (items.length === 0) warnings.push(`未检索到「${query}」相关资讯`);
    return { value: items, sources: ['eastmoney-news'], warnings };
  } catch (error) {
    warnings.push(`资讯检索失败：${errorMessage(error)}`);
    return { value: [], sources: [], warnings };
  }
}

/* ─────────────────────────────── web search ─────────────────────────────── */

/** Provider order + keys for the agent's `web_search` tool. */
export function webSearchOptions(limit = 6): WebSearchOptions {
  const choice = currentDataSources().webSearch;
  const providers: SourceId[] = [];
  if (choice.enabled !== false && choice.provider !== 'auto') providers.push(choice.provider as SourceId);
  for (const provider of ['tavily', 'serper', 'brave'] as SourceId[]) {
    if (providerKey(provider) && !providers.includes(provider)) providers.push(provider);
  }
  providers.push('bing', 'duckduckgo');
  return {
    limit,
    providers,
    keys: {
      tavily: choice.apiKey?.trim() || providerKey('tavily'),
      serper: choice.apiKey?.trim() || providerKey('serper'),
      brave: choice.apiKey?.trim() || providerKey('brave'),
    },
  };
}

export async function searchWeb(query: string, limit = 6): Promise<WebSearchResponse> {
  return webSearch(query, webSearchOptions(limit));
}

/* ────────────────────────────── diagnostics ─────────────────────────────── */

export interface ProbeResult {
  provider: SourceId;
  ok: boolean;
  latencyMs: number;
  message: string;
}

/** Live reachability probe used by `POST /api/settings/data-sources/probe`. */
export async function probeDataSource(provider: SourceId, market: Market = 'CN'): Promise<ProbeResult> {
  const started = Date.now();
  try {
    if (provider === 'eastmoney') {
      const quote = await emQuote(market, market === 'HK' ? '00700' : market === 'US' ? 'AAPL' : '600519');
      return done(provider, !!quote, started, quote ? `${quote.quote.name} ${quote.quote.price}` : '无数据');
    }
    if (provider === 'tencent') {
      const quote = await tencentQuote(market, market === 'HK' ? '00700' : market === 'US' ? 'AAPL' : '600519');
      return done(provider, !!quote, started, quote ? `${quote.quote.name} ${quote.quote.price}` : '无数据');
    }
    if (provider === 'eastmoney-fund') {
      const quote = await fundQuote('000001');
      return done(provider, !!quote, started, quote ? `净值 ${quote.price}` : '无数据');
    }
    if (provider === 'eastmoney-macro') {
      const rows = await macroReport('RPT_ECONOMY_CPI', 1);
      return done(provider, rows.length > 0, started, rows.length ? 'CPI 可用' : '无数据');
    }
    if (provider === 'eastmoney-news') {
      const items = await newsSearch('股市', 3);
      return done(provider, items.length > 0, started, items.length ? `${items.length} 条资讯` : '无数据');
    }
    if (provider === 'bing' || provider === 'duckduckgo' || provider === 'tavily' || provider === 'serper' || provider === 'brave') {
      const result = await webSearch('A股 行情', { ...webSearchOptions(3), providers: [provider] });
      return done(provider, result.results.length > 0, started, result.warnings.join('; ') || `${result.results.length} 条结果`);
    }
    if (provider === 'finnhub' || provider === 'alphavantage' || provider === 'fmp') {
      const key = providerKey(provider);
      if (!key) return { provider, ok: false, latencyMs: Date.now() - started, message: `未配置 Key（${provider.toUpperCase()}_API_KEY）` };
      const quote = await keyedQuote(provider, 'US', 'AAPL', key);
      return done(provider, !!quote, started, quote ? `AAPL ${quote.quote.price}` : '无数据');
    }
    if (provider === 'yahoo') {
      const text = await tryText('https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=5d&interval=1d');
      return done(provider, text.includes('"chart"'), started, text ? '可达' : '被拒绝（403/风控）');
    }
    if (provider === 'stooq') {
      const text = await tryText('https://stooq.com/q/d/l/?s=aapl.us&i=d');
      return done(provider, text.startsWith('Date'), started, text ? '可达' : '被拒绝（403）');
    }
    return { provider, ok: false, latencyMs: Date.now() - started, message: '该数据源无探针实现' };
  } catch (error) {
    return { provider, ok: false, latencyMs: Date.now() - started, message: errorMessage(error) };
  }
}

function done(provider: SourceId, ok: boolean, started: number, message: string): ProbeResult {
  return { provider, ok, latencyMs: Date.now() - started, message };
}

export type { ProviderQuote, ProviderSeries };
