/**
 * 腾讯行情 provider — zero-key fallback used when Eastmoney is unreachable.
 *
 * `https://qt.gtimg.cn/q=sh600519,hk00700,usAAPL` returns a GBK-encoded
 * `v_xxx="a~b~c..."` variable-length record. Index layout verified 2026-10-14
 * (docs/SOURCES.md §1.2 + probe3):
 *   1 name · 2 code · 3 price · 4 prevClose · 5 open · 6 volume · 30 time
 *   31 change · 32 changePct · 33 high · 34 low · 37 amount · 38 turnoverRate
 *   39 PE · 43 amplitude · 44 floatMarketCap(亿) · 45 marketCap(亿) · 47 PB
 *
 * Besides quotes this module also serves **K-line** (`ifzq` endpoint) and
 * **valuation fundamentals** (`push2`/F10 不可用时的兜底). Both exist because
 * Eastmoney's `push2*` hosts can be unreachable from some networks — 实测
 * `push2.eastmoney.com` 返回 HTTP 502、`push2his.eastmoney.com` 直接连接失败，
 * 而 `datacenter*.eastmoney.com`（F10 财报）与腾讯均可用。此前 `get_series`
 * 的 provider 链里只有东方财富，导致该工具在这些网络上对**所有**标的都返回
 * no_data；港股/美股的 `get_fundamentals` 也因为依赖 push2 报价而全线失败。
 *
 * Owner: agent-engine.
 */
import {
  MARKET_CURRENCY,
  RANGE_DAYS,
  type BarInterval,
  type FundamentalMetric,
  type Fundamentals,
  type InstrumentType,
  type Market,
  type Quote,
  type RangeKey,
  type SeriesPoint,
  type SeriesResponse,
  type SourceId,
} from '@aia/shared';
import { httpText, round4, toNumber } from './http.js';
import type { ProviderQuote, ProviderSeries } from './types.js';

const SOURCE: SourceId = 'tencent';
const QUOTE_TTL_MS = 60_000;
const SERIES_TTL_MS = 5 * 60_000;
const REFERER = 'https://gu.qq.com/';

/** Tencent's `q=` symbol for a market/code pair. */
export function tencentSymbol(market: Market, code: string): string {
  const clean = code.trim().toUpperCase();
  if (market === 'CN') return `${/^[659]/.test(clean) ? 'sh' : 'sz'}${clean}`;
  if (market === 'HK') return `hk${clean.padStart(5, '0')}`;
  return `us${clean}`;
}

/**
 * US tickers are spelled differently by every vendor. Users (and the model) write
 * `BRK-B`, `BRK_B`, `BRKB` or `BRK.B`; Tencent only answers to `BRK.B`
 * (实测 `usBRK-B` / `usBRKB` → `pv_none_match`, `usBRK.B` → 伯克希尔B).
 * Normalize the dash/underscore spelling to the dotted class-share form.
 */
export function normalizeUsTicker(code: string): string {
  // `BRK-B` / `BRK_B` / `BRK B` → `BRK.B`. Tencent answers `pv_none_match` for the
  // dash and underscore spellings (实测), so the dotted form is the canonical one.
  return code.trim().toUpperCase().replace(/[\s_-]+/g, '.');
}

/** Reads the `v_xxx="..."` record for the first matching symbol. */
function firstRecord(text: string): { symbol: string; fields: string[] } | null {
  const match = /v_([A-Za-z0-9_.]+)="([^"]*)"/.exec(text);
  if (!match) return null;
  return { symbol: match[1]!, fields: match[2]!.split('~') };
}

/**
 * Tencent's **exchange-qualified** US symbol (field 2 of the quote record), e.g.
 * `WFC` → `WFC.N`, `AAPL` → `AAPL.OQ`, `SCHD` → `SCHD.AM`, `BRK.B` → `BRK.B.N`.
 *
 * The K-line endpoint needs this suffix: 实测 `usWFC,day,,,320` 只返回 2 根
 * （延迟快照），而 `usWFC.N` 返回完整 320 根。The plain quote endpoint already
 * carries it, so one cached quote request resolves it.
 */
export async function tencentQualifiedSymbol(code: string): Promise<string | null> {
  const text = await httpText(`https://qt.gtimg.cn/q=us${code}`, {
    headers: { Referer: REFERER },
    encoding: 'gbk',
    cacheTtlMs: QUOTE_TTL_MS,
    // Same key as `tencentQuote` so a preceding quote request is reused, not refetched.
    cacheKey: `tx:quote:us${code}`,
  });
  const record = firstRecord(text);
  const qualified = record?.fields[2]?.trim();
  return qualified && /^[A-Z0-9.\-]+$/.test(qualified) && qualified !== 'pv_none_match' ? qualified : null;
}

/**
 * Index of 市净率 inside the `~` record, **per market**.
 *
 * The header comment above (and the original code) read index 47 as PB. It is not:
 * 实测 `600938 → 39.33`、`00939 → 4.41`、`WFC → 7.10`, none of which match the
 * instruments' net assets — every AI report flagged it with「行情 PB 字段与净资产
 * 口径不符，故不采用」and computed PB by hand instead. The real field sits at a
 * market-specific index, verified against known values (600938 = 1.93,
 * 00939 = 0.63, 00066 = 0.97 — the HK record carries the company's English name
 * at 46, which shifts nothing but tells us the layouts differ):
 *
 *   CN → 46, HK → 58.
 *
 * US records use yet another layout and no index matched (`VZ f[64] = 0.73`
 * against a true ≈1.8), so the US reports **no** PB rather than a wrong one.
 */
const PB_INDEX: Partial<Record<Market, number>> = { CN: 46, HK: 58 };

function tencentPb(fields: string[], market: Market): number {
  const index = PB_INDEX[market];
  if (index === undefined) return 0;
  const value = toNumber(fields[index]);
  // Guard against a shifted layout: a plausible PB is small and positive.
  return value > 0 && value < 100 ? round4(value) : 0;
}

/** Parses the `~`-separated record into a Quote. Exported for tests/tools. */
export function parseTencentRecord(record: string, market: Market, code: string): Quote | null {
  const fields = record.split('~');
  if (fields.length < 40) return null;
  const name = (fields[1] ?? '').trim();
  if (!name) return null;
  const currencyToken = fields.find((f, i) => (i === 35 || i === 75) && /^[A-Z]{3}$/.test((f ?? '').trim()));
  const price = toNumber(fields[3]);
  const prevClose = toNumber(fields[4]);
  const change = toNumber(fields[31]);
  const changePct = toNumber(fields[32]);
  return {
    code: code.trim().toUpperCase(),
    market,
    name,
    currency: currencyToken ? currencyToken.trim() : MARKET_CURRENCY[market],
    price: round4(price),
    prevClose: round4(prevClose),
    open: round4(toNumber(fields[5])),
    high: round4(toNumber(fields[33])),
    low: round4(toNumber(fields[34])),
    change: round4(change || price - prevClose),
    changePct: round4(changePct),
    volume: toNumber(fields[6]),
    amount: toNumber(fields[37]),
    turnoverRate: round4(toNumber(fields[38])),
    // 44/45 are quoted in 亿元
    floatMarketCap: round4(toNumber(fields[44]) * 1e8),
    marketCap: round4(toNumber(fields[45]) * 1e8),
    pe: round4(toNumber(fields[39])),
    peTtm: round4(toNumber(fields[39])),
    pb: tencentPb(fields, market),
    roe: 0,
    revenue: 0,
    industry: '',
    updatedAt: tencentTimeToIso(fields[30]) ?? new Date().toISOString(),
    source: SOURCE,
  };
}

/** Tencent reports Beijing wall-clock time, e.g. `2026/10/14 11:38:49`. */
function tencentTimeToIso(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const pad = (v: string): string => v.padStart(2, '0');
  const parsed = new Date(`${m[1]}-${pad(m[2]!)}-${pad(m[3]!)}T${pad(m[4]!)}:${m[5]}:${m[6]}+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Fallback real-time quote. Returns null when the symbol is unknown. */
export async function tencentQuote(market: Market, code: string): Promise<ProviderQuote | null> {
  const symbol = tencentSymbol(market, code);
  const text = await httpText(`https://qt.gtimg.cn/q=${symbol}`, {
    headers: { Referer: REFERER },
    encoding: 'gbk',
    cacheTtlMs: QUOTE_TTL_MS,
    cacheKey: `tx:quote:${symbol}`,
  });
  const match = /v_[A-Za-z0-9_.]+="([^"]+)"/.exec(text);
  if (!match) return null;
  const quote = parseTencentRecord(match[1]!, market, code);
  return quote ? { quote, source: SOURCE } : null;
}

/** Batch quote for several symbols in one request (indices fallback). */
export async function tencentBatch(symbols: string[], marketOf: (symbol: string) => Market): Promise<Quote[]> {
  if (symbols.length === 0) return [];
  const text = await httpText(`https://qt.gtimg.cn/q=${symbols.join(',')}`, {
    headers: { Referer: REFERER },
    encoding: 'gbk',
    cacheTtlMs: QUOTE_TTL_MS,
    cacheKey: `tx:batch:${symbols.join(',')}`,
  });
  const out: Quote[] = [];
  const re = /v_([A-Za-z0-9_.]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const [, symbol, record] = m;
    const code = symbol.replace(/^(sh|sz|hk|us)/i, '');
    const quote = parseTencentRecord(record, marketOf(symbol), code);
    if (quote) out.push(quote);
  }
  return out;
}

/* ────────────────────────────────── K-line ───────────────────────────────── */

/** Tencent wants an explicit bar count, not a date range. */
function barsFor(range: RangeKey, interval: BarInterval): number {
  const days = RANGE_DAYS[range] ?? 366;
  if (interval === 'week') return Math.min(1200, Math.ceil(days / 7) + 5);
  if (interval === 'month') return Math.min(600, Math.ceil(days / 30) + 3);
  return Math.min(1500, days + 10);
}

const IFZQ_PATH: Record<BarInterval, string> = { day: 'day', week: 'week', month: 'month' };

interface IfzqResponse {
  code?: number;
  data?: Record<string, Record<string, unknown>> | null;
}

/**
 * Historical K-line from Tencent (`web.ifzq.gtimg.cn`), the zero-key fallback for
 * `get_series` when Eastmoney's `push2his` host is unreachable.
 *
 * US symbols need the exchange-qualified form (`usWFC.N`), which is resolved from
 * the cached quote endpoint; without it Tencent answers with a 2-bar delayed stub.
 */
export async function tencentSeries(
  market: Market,
  code: string,
  range: RangeKey,
  interval: BarInterval,
  type: InstrumentType = 'stock',
): Promise<ProviderSeries | null> {
  const bars = barsFor(range, interval);
  const candidates: string[] = [];
  if (market === 'US') {
    const qualified = await tencentQualifiedSymbol(code);
    if (qualified) candidates.push(`us${qualified}`);
    candidates.push(tencentSymbol(market, code));
  } else {
    candidates.push(tencentSymbol(market, code));
  }

  for (const symbol of candidates) {
    const key = `qfq${IFZQ_PATH[interval]}`;
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},${IFZQ_PATH[interval]},,,${bars},qfq`;
    const text = await httpText(url, {
      headers: { Referer: REFERER },
      cacheTtlMs: SERIES_TTL_MS,
      cacheKey: `tx:kline:${symbol}:${IFZQ_PATH[interval]}:${bars}`,
    }).catch(() => '');
    if (!text) continue;
    const parsed = parseIfzqSeries(text, symbol, market, code, range, interval, type, key);
    if (parsed && parsed.series.points.length > 0) return parsed;
  }
  return null;
}

/** Parses one `ifzq` payload into a `ProviderSeries`. Exported for tests. */
export function parseIfzqSeries(
  text: string,
  symbol: string,
  market: Market,
  code: string,
  range: RangeKey,
  interval: BarInterval,
  type: InstrumentType = 'stock',
  preferredKey = `qfq${IFZQ_PATH[interval]}`,
): ProviderSeries | null {
  let payload: IfzqResponse;
  try {
    payload = JSON.parse(text) as IfzqResponse;
  } catch {
    return null;
  }
  const node = payload?.data?.[symbol] as Record<string, unknown> | undefined;
  if (!node) return null;
  // `fqkline/get` answers with `qfqday`, while `kline/kline` answers with `day`.
  const rows = (node[preferredKey] ?? node[IFZQ_PATH[interval]]) as unknown;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const points: SeriesPoint[] = [];
  for (const row of rows) {
    // Tencent order: [date, open, close, high, low, volume] — note close comes
    // BEFORE high/low, unlike Eastmoney's kline rows.
    if (!Array.isArray(row) || row.length < 5) continue;
    const date = String(row[0] ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    points.push({
      date,
      open: round4(toNumber(row[1])),
      close: round4(toNumber(row[2])),
      high: round4(toNumber(row[3])),
      low: round4(toNumber(row[4])),
      volume: toNumber(row[5]),
    });
  }
  if (points.length === 0) return null;
  const quoteRecord = (node.qt as Record<string, string[]> | undefined)?.[symbol];
  const name = typeof quoteRecord?.[1] === 'string' ? quoteRecord[1] : '';
  const series: SeriesResponse = {
    code: code.trim().toUpperCase(),
    market,
    type,
    kind: 'kline',
    interval,
    range,
    currency: MARKET_CURRENCY[market],
    name,
    points,
    sources: [SOURCE],
    warnings: [],
  };
  return { series, source: SOURCE };
}

/* ────────────────────── valuation fundamentals fallback ───────────────────── */

/**
 * `get_fundamentals` fallback for HK/US.
 *
 * Eastmoney's HK/US path (`emValuationFundamentals`) is built entirely on the
 * `push2` quote, so a `push2` outage takes the whole tool down for those markets
 * (实测 `未能获取 US/WFC 基本面`、`HK/00939 基本面` 连续报错). Tencent carries
 * the same PE / PB / 市值 / 换手 fields and stays reachable, so it is the
 * structured last resort instead of an empty `no_data`.
 */
export async function tencentFundamentals(market: Market, code: string, fallbackName: string): Promise<Fundamentals | null> {
  const result = await tencentQuote(market, code);
  if (!result) return null;
  const q = result.quote;
  const metrics: FundamentalMetric[] = [];
  const push = (key: string, label: string, value: number, unit: string): void => {
    if (value > 0) metrics.push({ key, label, value: round4(value), unit });
  };
  push('peTtm', '市盈率(TTM)', q.peTtm, '倍');
  push('pb', '市净率', q.pb, '倍');
  push('marketCap', '总市值', q.marketCap, q.currency);
  push('floatMarketCap', '流通市值', q.floatMarketCap, q.currency);
  push('turnoverRate', '换手率', q.turnoverRate, '%');
  push('epsTtm', '每股收益(TTM, 估算)', q.peTtm > 0 ? q.price / q.peTtm : 0, q.currency);
  push('bps', '每股净资产(估算)', q.pb > 0 ? q.price / q.pb : 0, q.currency);
  if (metrics.length === 0) return null;
  return {
    code: code.trim().toUpperCase(),
    market,
    name: q.name || fallbackName,
    reportDate: null,
    reportType: null,
    metrics,
    highlights: [
      '以上为腾讯行情实时估值指标（东方财富 push2 报价不可用时的兜底）；',
      '腾讯不返回美股市净率，如需 PB 请用「总市值 ÷ 归母权益」自行推算并写明口径。',
      '港股/美股本地 F10 财务明细不受影响时请用 get_financials（东方财富 datacenter）核对三表。',
    ],
    sources: [SOURCE],
  };
}
