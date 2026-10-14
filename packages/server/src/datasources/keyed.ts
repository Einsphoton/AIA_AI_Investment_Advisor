/**
 * Optional keyed providers (Finnhub / Alpha Vantage / FMP) — enhancement only.
 *
 * Every function returns `null` when no key is configured or the upstream call
 * fails, so the zero-key chain stays the baseline and the agent never blocks on
 * a missing key.
 *
 * Owner: agent-engine.
 */
import type { BarInterval, Fundamentals, Market, Quote, RangeKey, SeriesPoint, SeriesResponse, SourceId } from '@aia/shared';
import { MARKET_CURRENCY, RANGE_DAYS } from '@aia/shared';
import { round4, toNumber, tryJson } from './http.js';
import type { ProviderQuote, ProviderSeries } from './types.js';

const KEYED_TTL_MS = 5 * 60_000;

const KEY_ENV_HINTS: Record<string, string> = {
  finnhub: 'FINNHUB_API_KEY',
  alphavantage: 'ALPHAVANTAGE_API_KEY',
  fmp: 'FMP_API_KEY',
};

export function keyEnvHint(provider: SourceId): string {
  return KEY_ENV_HINTS[provider] ?? `${provider.toUpperCase()}_API_KEY`;
}

/** Provider symbol convention (Finnhub/AV use `0700.HK` for Hong Kong). */
export function keyedSymbol(provider: SourceId, market: Market, code: string): string {
  const clean = code.trim().toUpperCase();
  if (market === 'CN') return clean;
  if (market === 'HK') return `${clean.replace(/^0+/, '').padStart(4, '0')}.HK`;
  return clean;
}

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/* ──────────────────────────────── Finnhub ────────────────────────────────── */

interface FinnhubQuote {
  c?: number; d?: number; dp?: number; h?: number; l?: number; o?: number; pc?: number; t?: number;
}

interface FinnhubProfile {
  name?: string; currency?: string; exchange?: string; marketCapitalization?: number; finnhubIndustry?: string; ipo?: string;
}

async function finnhubQuote(market: Market, code: string, key: string): Promise<ProviderQuote | null> {
  const symbol = keyedSymbol('finnhub', market, code);
  const [quote, profile] = await Promise.all([
    tryJson<FinnhubQuote>(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`, {
      cacheTtlMs: KEYED_TTL_MS,
      cacheKey: `finnhub:q:${symbol}`,
    }),
    tryJson<FinnhubProfile>(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`, {
      cacheTtlMs: 30 * 60_000,
      cacheKey: `finnhub:p:${symbol}`,
    }),
  ]);
  if (!quote || !quote.c) return null;
  const price = toNumber(quote.c);
  return {
    source: 'finnhub',
    quote: {
      code,
      market,
      name: profile?.name ?? code,
      currency: profile?.currency ?? MARKET_CURRENCY[market],
      price: round4(price),
      prevClose: round4(toNumber(quote.pc)),
      open: round4(toNumber(quote.o)),
      high: round4(toNumber(quote.h)),
      low: round4(toNumber(quote.l)),
      change: round4(toNumber(quote.d) || price - toNumber(quote.pc)),
      changePct: round4(toNumber(quote.dp)),
      volume: 0,
      amount: 0,
      turnoverRate: 0,
      marketCap: round4(toNumber(profile?.marketCapitalization) * 1e6),
      floatMarketCap: 0,
      pe: 0,
      peTtm: 0,
      pb: 0,
      roe: 0,
      revenue: 0,
      industry: profile?.finnhubIndustry ?? '',
      updatedAt: quote.t ? new Date(toNumber(quote.t) * 1000).toISOString() : new Date().toISOString(),
      source: 'finnhub',
    },
  };
}

async function finnhubCandles(market: Market, code: string, key: string, range: RangeKey, interval: BarInterval): Promise<ProviderSeries | null> {
  const symbol = keyedSymbol('finnhub', market, code);
  const resolution = interval === 'day' ? 'D' : interval === 'week' ? 'W' : 'M';
  const days = Math.min(RANGE_DAYS[range] ?? 366, 3000);
  const url =
    `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}` +
    `&from=${Math.floor((Date.now() - days * 86_400_000) / 1000)}&to=${Math.floor(Date.now() / 1000)}&token=${encodeURIComponent(key)}`;
  const json = await tryJson<{ s?: string; t?: number[]; o?: number[]; h?: number[]; l?: number[]; c?: number[]; v?: number[] }>(url, {
    cacheTtlMs: KEYED_TTL_MS,
    cacheKey: `finnhub:k:${symbol}:${resolution}:${days}`,
  });
  if (!json || json.s !== 'ok' || !Array.isArray(json.t) || json.t.length === 0) return null;
  const points: SeriesPoint[] = json.t.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString().slice(0, 10),
    open: round4(toNumber(json.o?.[i])),
    high: round4(toNumber(json.h?.[i])),
    low: round4(toNumber(json.l?.[i])),
    close: round4(toNumber(json.c?.[i])),
    volume: toNumber(json.v?.[i]),
  }));
  const series: SeriesResponse = {
    code,
    market,
    type: 'stock',
    kind: 'kline',
    interval,
    range,
    currency: MARKET_CURRENCY[market],
    name: '',
    points,
    sources: ['finnhub'],
    warnings: [],
  };
  return { series, source: 'finnhub' };
}

/* ───────────────────────────── Alpha Vantage ─────────────────────────────── */

interface AvOverview {
  Name?: string; Exchange?: string; Currency?: string; MarketCapitalization?: string; PERatio?: string;
  PEGRatio?: string; PriceToBookRatio?: string; ReturnOnEquityTTM?: string; RevenueTTM?: string;
  ProfitMargin?: string; Industry?: string; Sector?: string; DividendYield?: string; Beta?: string;
}

async function alphavantageQuote(market: Market, code: string, key: string): Promise<ProviderQuote | null> {
  const symbol = keyedSymbol('alphavantage', market, code);
  const json = await tryJson<{
    'Global Quote'?: Record<string, string>;
    Note?: string;
    Information?: string;
  }>(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`, {
    cacheTtlMs: KEYED_TTL_MS,
    cacheKey: `av:q:${symbol}`,
  });
  const row = json?.['Global Quote'];
  if (!row) return null;
  const price = toNumber(row['05. price']);
  if (price <= 0) return null;
  const quote: Quote = {
    code,
    market,
    name: '',
    currency: MARKET_CURRENCY[market],
    price: round4(price),
    prevClose: round4(toNumber(row['08. previous close'])),
    open: round4(toNumber(row['02. open'])),
    high: round4(toNumber(row['03. high'])),
    low: round4(toNumber(row['04. low'])),
    change: round4(toNumber(row['09. change'])),
    changePct: round4(toNumber(String(row['10. change percent'] ?? '').replace('%', ''))),
    volume: toNumber(row['06. volume']),
    amount: 0,
    turnoverRate: 0,
    marketCap: 0,
    floatMarketCap: 0,
    pe: 0,
    peTtm: 0,
    pb: 0,
    roe: 0,
    revenue: 0,
    industry: '',
    updatedAt: new Date().toISOString(),
    source: 'alphavantage',
  };
  return { quote, source: 'alphavantage' };
}

async function alphavantageOverview(market: Market, code: string, key: string): Promise<Fundamentals | null> {
  const symbol = keyedSymbol('alphavantage', market, code);
  const json = await tryJson<AvOverview>(`https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`, {
    cacheTtlMs: 30 * 60_000,
    cacheKey: `av:overview:${symbol}`,
  });
  if (!json || !json.Name) return null;
  const metrics = [
    { key: 'peTtm', label: '市盈率(TTM)', value: toNumber(json.PERatio), unit: '倍' },
    { key: 'peg', label: 'PEG', value: toNumber(json.PEGRatio), unit: '' },
    { key: 'pb', label: '市净率', value: toNumber(json.PriceToBookRatio), unit: '倍' },
    { key: 'roe', label: 'ROE(TTM)', value: toNumber(json.ReturnOnEquityTTM) * 100, unit: '%' },
    { key: 'netMargin', label: '净利率', value: toNumber(json.ProfitMargin) * 100, unit: '%' },
    { key: 'dividendYield', label: '股息率', value: toNumber(json.DividendYield) * 100, unit: '%' },
    { key: 'beta', label: 'Beta', value: toNumber(json.Beta), unit: '' },
    { key: 'marketCap', label: '总市值', value: toNumber(json.MarketCapitalization), unit: json.Currency ?? 'USD' },
    { key: 'revenue', label: '营业总收入(TTM)', value: toNumber(json.RevenueTTM), unit: json.Currency ?? 'USD' },
  ].filter((m) => m.value > 0);
  return {
    code,
    market,
    name: json.Name,
    reportDate: null,
    reportType: 'TTM',
    metrics: metrics.map((m) => ({ ...m, value: round4(m.value) })),
    highlights: [json.Sector ? `板块：${json.Sector}` : '', json.Industry ? `行业：${json.Industry}` : '']
      .filter(Boolean)
      .concat(['基本面数据来自 Alpha Vantage OVERVIEW 接口。']),
    sources: ['alphavantage'],
  };
}

async function alphavantageSeries(market: Market, code: string, key: string, range: RangeKey, interval: BarInterval): Promise<ProviderSeries | null> {
  if (interval !== 'day') return null;
  const symbol = keyedSymbol('alphavantage', market, code);
  const json = await tryJson<Record<string, unknown>>(
    `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&outputsize=full&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`,
    { cacheTtlMs: KEYED_TTL_MS, cacheKey: `av:daily:${symbol}` },
  );
  const table = json?.['Time Series (Daily)'];
  if (!table || typeof table !== 'object') return null;
  const days = RANGE_DAYS[range] ?? 366;
  const cutoff = isoDay(-days);
  const points: SeriesPoint[] = Object.entries(table as Record<string, Record<string, string>>)
    .filter(([date]) => range === 'max' || date >= cutoff)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, row]) => ({
      date,
      open: round4(toNumber(row['1. open'])),
      high: round4(toNumber(row['2. high'])),
      low: round4(toNumber(row['3. low'])),
      close: round4(toNumber(row['4. close'])),
      volume: toNumber(row['5. volume']),
    }));
  if (points.length === 0) return null;
  return {
    source: 'alphavantage',
    series: {
      code,
      market,
      type: 'stock',
      kind: 'kline',
      interval,
      range,
      currency: MARKET_CURRENCY[market],
      name: '',
      points,
      sources: ['alphavantage'],
      warnings: [],
    },
  };
}

/* ─────────────────────────── Financial Modeling Prep ─────────────────────── */

async function fmpQuote(market: Market, code: string, key: string): Promise<ProviderQuote | null> {
  const symbol = keyedSymbol('fmp', market, code);
  const json = await tryJson<Array<Record<string, unknown>>>(
    `https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(symbol)}?apikey=${encodeURIComponent(key)}`,
    { cacheTtlMs: KEYED_TTL_MS, cacheKey: `fmp:q:${symbol}` },
  );
  const row = json?.[0];
  if (!row) return null;
  const price = toNumber(row.price);
  if (price <= 0) return null;
  return {
    source: 'fmp',
    quote: {
      code,
      market,
      name: typeof row.name === 'string' ? row.name : code,
      currency: MARKET_CURRENCY[market],
      price: round4(price),
      prevClose: round4(toNumber(row.previousClose)),
      open: round4(toNumber(row.open)),
      high: round4(toNumber(row.dayHigh)),
      low: round4(toNumber(row.dayLow)),
      change: round4(toNumber(row.change)),
      changePct: round4(toNumber(row.changesPercentage)),
      volume: toNumber(row.volume),
      amount: 0,
      turnoverRate: 0,
      marketCap: toNumber(row.marketCap),
      floatMarketCap: 0,
      pe: round4(toNumber(row.pe)),
      peTtm: round4(toNumber(row.pe)),
      pb: 0,
      roe: 0,
      revenue: 0,
      industry: '',
      updatedAt: new Date().toISOString(),
      source: 'fmp',
    },
  };
}

/* ──────────────────────────────── dispatch ───────────────────────────────── */

/** Keyed quote for the selected provider; null when unsupported/unavailable. */
export async function keyedQuote(provider: SourceId, market: Market, code: string, key: string): Promise<ProviderQuote | null> {
  if (!key) return null;
  try {
    switch (provider) {
      case 'finnhub':
        return market === 'CN' ? null : await finnhubQuote(market, code, key);
      case 'alphavantage':
        return market === 'CN' ? null : await alphavantageQuote(market, code, key);
      case 'fmp':
        return market === 'US' ? await fmpQuote(market, code, key) : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Keyed K-line for the selected provider. */
export async function keyedSeries(
  provider: SourceId,
  market: Market,
  code: string,
  range: RangeKey,
  interval: BarInterval,
  key: string,
): Promise<ProviderSeries | null> {
  if (!key || market === 'CN') return null;
  try {
    if (provider === 'finnhub') return await finnhubCandles(market, code, key, range, interval);
    if (provider === 'alphavantage') return await alphavantageSeries(market, code, key, range, interval);
    return null;
  } catch {
    return null;
  }
}

/** Keyed fundamentals (Alpha Vantage is the only fully open one). */
export async function keyedFundamentals(provider: SourceId, market: Market, code: string, key: string): Promise<Fundamentals | null> {
  if (!key || market === 'CN') return null;
  if (provider !== 'alphavantage') return null;
  try {
    return await alphavantageOverview(market, code, key);
  } catch {
    return null;
  }
}

export const KEYED_PROVIDERS: SourceId[] = ['finnhub', 'alphavantage', 'fmp'];
