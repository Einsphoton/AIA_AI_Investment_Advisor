/**
 * 东方财富 provider — zero-key quotes / K-line / F10 / dividends / indices / search.
 *
 * Every field mapping below was verified against live responses on 2026-10-14
 * (see docs/SOURCES.md §1, §2, §4). Prices come back as scaled integers and MUST
 * be restored with the response's own `f59` (stock/get) or `f1`/`decimal`
 * (ulist/kline) precision — never with a hard-coded guess.
 *
 * Owner: agent-engine.
 */
import {
  EASTMONEY_MARKET_PREFIX,
  MARKET_CURRENCY,
  RANGE_DAYS,
  type BarInterval,
  type DividendItem,
  type Fundamentals,
  type FundamentalMetric,
  type InstrumentType,
  type Market,
  type Quote,
  type RangeKey,
  type SeriesPoint,
  type SeriesResponse,
  type SourceId,
} from '@aia/shared';
import { errorMessage, httpJson, isoOrNull, round4, toNumber, tryJson } from './http.js';
import type { ProviderQuote, ProviderSeries, SearchHit, SearchOptions } from './types.js';

const SOURCE: SourceId = 'eastmoney';
const QUOTE_TTL_MS = 60_000;
const SERIES_TTL_MS = 5 * 60_000;
const SEARCH_TTL_MS = 10 * 60_000;
const FIN_TTL_MS = 30 * 60_000;
const REFERER = 'https://quote.eastmoney.com/';

const QUOTE_FIELDS = [
  'f43', 'f44', 'f45', 'f46', 'f47', 'f48', 'f49', 'f50', 'f51', 'f52',
  'f57', 'f58', 'f59', 'f60', 'f84', 'f85', 'f86', 'f92', 'f107',
  'f116', 'f117', 'f127', 'f162', 'f163', 'f164', 'f167', 'f168',
  'f169', 'f170', 'f171', 'f172', 'f173', 'f183', 'f189',
].join(',');

/* ─────────────────────────────── secid helpers ───────────────────────────── */

/**
 * Eastmoney's US class-share spelling is the **underscore** form: 实测
 * `ulist.np/get?secids=106.BRK_B,…` resolves 伯克希尔哈撒韦-B while
 * `106.BRK-B` / `106.BRK.B` / `106.BRKB` resolve nothing, and the suggest index
 * only knows `BRK_B`. The rest of the app canonicalizes US tickers to the dotted
 * form (that is what Tencent serves), so the translation lives here — at the
 * provider boundary — instead of in the shared `normalizeCode`.
 */
export function emUsCode(code: string): string {
  return code.trim().toUpperCase().replace(/[.\-\s]+/g, '_');
}

/** Eastmoney secid for a market/code pair. */
export function emSecid(market: Market, code: string): string {
  const clean = code.trim().toUpperCase();
  if (market === 'CN') {
    // 6/5/9 → 沪市(1), 0/3/1/2 → 深市(0); A股用 1. 也能命中多数标的。
    const prefix = /^[659]/.test(clean) ? '1' : '0';
    return `${prefix}.${clean}`;
  }
  if (market === 'HK') return `${EASTMONEY_MARKET_PREFIX.HK}.${clean.padStart(5, '0')}`;
  return `${EASTMONEY_MARKET_PREFIX.US}.${emUsCode(clean)}`;
}

/**
 * secids a US code has already resolved to, so the second candidate is not
 * re-probed on every call. NYSE tickers only answer on `106.*` (实测 `105.WFC`
 * never resolves), and the first call of a run used to pay for both — twice over,
 * because `get_quote` and `get_series` each walked the full list.
 */
const resolvedUsSecids = new Map<string, string>();
const MAX_RESOLVED_US = 200;

/** Records which secid actually answered, promoting it for later calls. */
export function rememberEmSecid(market: Market, code: string, secid: string): void {
  if (market !== 'US') return;
  const key = code.trim().toUpperCase();
  if (resolvedUsSecids.get(key) === secid) return;
  resolvedUsSecids.delete(key);
  resolvedUsSecids.set(key, secid);
  while (resolvedUsSecids.size > MAX_RESOLVED_US) {
    const oldest = resolvedUsSecids.keys().next();
    if (oldest.done) break;
    resolvedUsSecids.delete(oldest.value);
  }
}

/** Fallback secids to try in order (US: remembered → NASDAQ → NYSE/AMEX; CN: 沪 → 深). */
export function emSecidCandidates(market: Market, code: string): string[] {
  if (market === 'US') {
    const clean = emUsCode(code);
    const remembered = resolvedUsSecids.get(code.trim().toUpperCase());
    const all = [`105.${clean}`, `106.${clean}`, `107.${clean}`];
    return remembered ? [remembered, ...all.filter((secid) => secid !== remembered)] : all;
  }
  const primary = emSecid(market, code);
  if (market === 'CN') return [primary, primary.startsWith('1.') ? `0.${code}` : `1.${code}`];
  return [primary];
}

/** Precision multiplier from the response `f59`/decimal field, else market default. */
export function emScale(decimal: unknown, market: Market): number {
  const digits = toNumber(decimal);
  const safe = digits > 0 && digits <= 6 ? digits : market === 'CN' ? 2 : 3;
  return 10 ** safe;
}

/* ────────────────────────────────── quote ────────────────────────────────── */

interface EmQuoteData {
  f43?: unknown; f44?: unknown; f45?: unknown; f46?: unknown; f47?: unknown;
  f48?: unknown; f50?: unknown; f57?: unknown; f58?: unknown; f59?: unknown;
  f60?: unknown; f84?: unknown; f85?: unknown; f92?: unknown; f107?: unknown;
  f116?: unknown; f117?: unknown; f127?: unknown; f162?: unknown; f163?: unknown;
  f164?: unknown; f167?: unknown; f168?: unknown; f169?: unknown; f170?: unknown;
  f171?: unknown; f172?: unknown; f173?: unknown; f183?: unknown; f189?: unknown;
}

function mapEmQuote(data: EmQuoteData, market: Market, code: string): Quote {
  const scale = emScale(data.f59, market);
  const price = round4(toNumber(data.f43) / scale);
  const prevClose = round4(toNumber(data.f60) / scale);
  const currencyRaw = typeof data.f172 === 'string' ? data.f172.trim().toUpperCase() : '';
  const marketKey = toNumber(data.f107);
  const resolvedMarket: Market =
    marketKey === 116 ? 'HK' : marketKey === 105 || marketKey === 106 || marketKey === 107 ? 'US' : market;
  return {
    code: typeof data.f57 === 'string' && data.f57 ? data.f57 : code,
    market: resolvedMarket,
    name: typeof data.f58 === 'string' ? data.f58 : '',
    currency: currencyRaw || MARKET_CURRENCY[resolvedMarket],
    price,
    prevClose,
    open: round4(toNumber(data.f46) / scale),
    high: round4(toNumber(data.f44) / scale),
    low: round4(toNumber(data.f45) / scale),
    change: round4(toNumber(data.f169) / scale),
    changePct: round4(toNumber(data.f170) / 100),
    volume: toNumber(data.f47),
    amount: toNumber(data.f48),
    turnoverRate: round4(toNumber(data.f168) / 100),
    marketCap: toNumber(data.f116),
    floatMarketCap: toNumber(data.f117),
    pe: round4(toNumber(data.f162) / 100),
    peTtm: round4(toNumber(data.f164) / 100),
    pb: round4(toNumber(data.f167) / 100),
    roe: round4(toNumber(data.f173)),
    revenue: toNumber(data.f183),
    industry: typeof data.f127 === 'string' ? data.f127 : '',
    updatedAt: new Date().toISOString(),
    source: SOURCE,
  };
}

/**
 * Real-time quote with valuation fields. Returns null when the symbol is unknown.
 *
 * `onError` receives the transport failure of each attempt. Without it the error
 * was swallowed by `tryJson`, so an upstream outage was reported as the benign
 * 「未返回报价」 — the reader (and the UI) could not tell a dead host from a bad
 * symbol. 实测本次生产事故里 push2 返回 502 / 连接被重置，全部被记成了后者。
 */
export async function emQuote(
  market: Market,
  code: string,
  onError?: (message: string) => void,
): Promise<ProviderQuote | null> {
  for (const secid of emSecidCandidates(market, code)) {
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fields=${QUOTE_FIELDS}`;
    let json: { data?: EmQuoteData | null } | null = null;
    try {
      json = await httpJson<{ data?: EmQuoteData | null }>(url, {
        headers: { Referer: REFERER },
        cacheTtlMs: QUOTE_TTL_MS,
        cacheKey: `em:quote:${secid}`,
      });
    } catch (error) {
      onError?.(errorMessage(error));
      continue;
    }
    const data = json?.data;
    if (!data || typeof data.f58 !== 'string' || !data.f58) continue;
    rememberEmSecid(market, code, secid);
    return { quote: mapEmQuote(data, market, code), source: SOURCE };
  }
  return null;
}

/** Batch quotes (used for indices and heat lists): one HTTP round-trip. */
export async function emBatchQuotes(
  secids: string[],
  marketOf: (secid: string, code: string, marketFlag: number) => Market,
): Promise<Quote[]> {
  if (secids.length === 0) return [];
  const url =
    'https://push2.eastmoney.com/api/qt/ulist.np/get?secids=' +
    encodeURIComponent(secids.join(',')) +
    '&fields=f1,f2,f3,f4,f12,f13,f14';
  const json = await tryJson<{
    data?: { diff?: Array<{ f1?: unknown; f2?: unknown; f3?: unknown; f4?: unknown; f12?: unknown; f13?: unknown; f14?: unknown }> };
  }>(url, { headers: { Referer: REFERER }, cacheTtlMs: QUOTE_TTL_MS, cacheKey: `em:ulist:${secids.join(',')}` });
  const rows = json?.data?.diff ?? [];
  const out: Quote[] = [];
  for (const row of rows) {
    const code = typeof row.f12 === 'string' ? row.f12 : '';
    if (!code) continue;
    const flag = toNumber(row.f13);
    const market = marketOf(`?`, code, flag);
    const scale = emScale(row.f1, market);
    const price = round4(toNumber(row.f2) / scale);
    const change = round4(toNumber(row.f4) / scale);
    out.push({
      code,
      market,
      name: typeof row.f14 === 'string' ? row.f14 : code,
      currency: MARKET_CURRENCY[market],
      price,
      prevClose: round4(price - change),
      open: 0,
      high: 0,
      low: 0,
      change,
      changePct: round4(toNumber(row.f3) / 100),
      volume: 0,
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
      source: SOURCE,
    });
  }
  return out;
}

/* ────────────────────────────────── kline ────────────────────────────────── */

const KLT: Record<BarInterval, number> = { day: 101, week: 102, month: 103 };

function emBegDate(range: RangeKey): string {
  const days = RANGE_DAYS[range] ?? 366;
  const from = new Date(Date.now() - days * 86_400_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${from.getFullYear()}${pad(from.getMonth() + 1)}${pad(from.getDate())}`;
}

/**
 * Historical K-line. Returns null when unavailable (caller degrades to the next
 * provider and records a warning). `onError` reports transport failures instead of
 * letting `tryJson` turn an outage into a silent「没数据」.
 */
export async function emSeries(
  market: Market,
  code: string,
  type: InstrumentType,
  range: RangeKey,
  interval: BarInterval,
  onError?: (message: string) => void,
): Promise<ProviderSeries | null> {
  for (const secid of emSecidCandidates(market, code)) {
    const klt = KLT[interval];
    const beg = interval === 'day' && range === 'max' ? '19900101' : emBegDate(range);
    const url =
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}` +
      `&klt=${klt}&fqt=1&fields1=f1,f2,f3,f4,f5,f6` +
      `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&beg=${beg}&end=20500101&lmt=10000`;
    let json: { data?: { code?: string; market?: number; name?: string; decimal?: number; klines?: string[] } | null } | null;
    try {
      json = await httpJson(url, {
        headers: { Referer: REFERER },
        cacheTtlMs: SERIES_TTL_MS,
        cacheKey: `em:kline:${secid}:${klt}:${beg}`,
      });
    } catch (error) {
      onError?.(errorMessage(error));
      continue;
    }
    const data = json?.data;
    const lines = data?.klines;
    if (!data || !Array.isArray(lines) || lines.length === 0) continue;
    rememberEmSecid(market, code, secid);

    const resolvedMarket: Market = data.market === 116 ? 'HK' : data.market === 105 || data.market === 106 || data.market === 107 ? 'US' : market;
    const points: SeriesPoint[] = [];
    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length < 6) continue;
      const date = parts[0];
      const close = toNumber(parts[2]);
      points.push({
        date,
        open: round4(toNumber(parts[1])),
        high: round4(toNumber(parts[3])),
        low: round4(toNumber(parts[4])),
        close: round4(close),
        volume: toNumber(parts[5]),
      });
    }
    if (points.length === 0) continue;
    const kept = sliceByRange(points, range);
    const series: SeriesResponse = {
      code: typeof data.code === 'string' && data.code ? data.code : code,
      market: resolvedMarket,
      type,
      kind: 'kline',
      interval,
      range,
      currency: MARKET_CURRENCY[resolvedMarket],
      name: typeof data.name === 'string' ? data.name : '',
      points: kept,
      sources: [SOURCE],
      warnings: [],
    };
    return { series, source: SOURCE };
  }
  return null;
}

/** Keeps only the tail of a series that fits `range` (defensive; upstream already filters). */
export function sliceByRange(points: SeriesPoint[], range: RangeKey): SeriesPoint[] {
  const days = RANGE_DAYS[range] ?? 366;
  if (range === 'max') return points;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const kept = points.filter((p) => p.date >= cutoffIso);
  return kept.length > 0 ? kept : points.slice(-Math.max(20, Math.min(points.length, 60)));
}

/* ───────────────────────────────── search ────────────────────────────────── */

/** One row of the eastmoney suggest response (exported for the classification tests). */
export interface EmSuggestRow {
  Code?: unknown;
  Name?: unknown;
  MktNum?: unknown;
  MarketType?: unknown;
  SecurityTypeName?: unknown;
  Classify?: unknown;
  JYS?: unknown;
  SecurityType?: unknown;
  /** e.g. `150.000001`（场外基金）或 `1.510300`（场内）。 */
  QuoteID?: unknown;
}

/** Exported for the suggest-classification tests. */
export function suggestMarket(row: EmSuggestRow): Market | null {
  const num = toNumber(row.MktNum ?? row.MarketType);
  if (num === 116 || num === 128 || num === 124) return 'HK';
  if (num === 105 || num === 106 || num === 107) return 'US';
  // 150 = 场外基金（申赎，QuoteID=150.x）；MarketType 口径为 6。两者都属于 A 股挂牌范围。
  if (num === 0 || num === 1 || num === 2 || num === 150 || num === 6) return 'CN';
  const classify = typeof row.Classify === 'string' ? row.Classify : '';
  if (/Us/i.test(classify)) return 'US';
  if (/Hk/i.test(classify)) return 'HK';
  if (/AStock|Kcb|Cyb|Fund|Bond/i.test(classify)) return 'CN';
  return null;
}

/**
 * 类型判定。Exported for tests.
 *
 * 场外基金必须标成 `fund`，不能标 `etf`：同类代码在 A 股可能是股票
 * （000001 场外基金「华夏成长」vs 股票「平安银行」），按 etf 去查报价会
 * **静默命中同代码的股票**，写进池子的就是完全错误的价格与结论。
 * 东财 suggest 用 `Classify/JYS = 'OTCFUND'` 区分场外基金，`'Fund'` 才是场内 ETF/LOF。
 */
export function suggestType(row: EmSuggestRow): InstrumentType {
  const classify = typeof row.Classify === 'string' ? row.Classify : '';
  const jys = typeof row.JYS === 'string' ? row.JYS : '';
  if (/OTCFUND/i.test(classify) || /OTCFUND/i.test(jys)) return 'fund';
  const label = `${typeof row.SecurityTypeName === 'string' ? row.SecurityTypeName : ''} ${classify}`;
  if (/基金|ETF|LOF|Fund/i.test(label)) return 'etf';
  return 'stock';
}

/** Code/name auto-complete across A股 / 港股 / 美股. */
export async function emSearch(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const count = Math.max(1, Math.min(options.limit ?? 12, 30));
  const url =
    `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}` +
    `&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=${count}`;
  const json = await tryJson<{ QuotationCodeTable?: { Data?: EmSuggestRow[] | null } }>(url, {
    headers: { Referer: 'https://www.eastmoney.com/' },
    cacheTtlMs: SEARCH_TTL_MS,
    cacheKey: `em:suggest:${q}:${count}`,
  });
  const rows = json?.QuotationCodeTable?.Data ?? [];
  const hits: SearchHit[] = [];
  for (const row of rows) {
    const code = typeof row.Code === 'string' ? row.Code : '';
    const name = typeof row.Name === 'string' ? row.Name : '';
    const market = suggestMarket(row);
    if (!code || !name || !market) continue;
    if (options.market && market !== options.market) continue;
    hits.push({
      code,
      name,
      market,
      type: suggestType(row),
      exchange: typeof row.SecurityTypeName === 'string' ? row.SecurityTypeName : String(row.JYS ?? ''),
      source: SOURCE,
    });
  }
  return hits;
}

/* ─────────────────────────────── fundamentals ────────────────────────────── */

function secucode(code: string, market: Market): string {
  if (market === 'CN') return `${code}.${/^[659]/.test(code) ? 'SH' : 'SZ'}`;
  return code;
}

interface EmFinRow {
  REPORT_DATE?: unknown;
  REPORT_TYPE?: unknown;
  REPORT_DATE_NAME?: unknown;
  [key: string]: unknown;
}

const FIN_METRICS: Array<{ key: string; label: string; field: string; unit: string; scale?: number }> = [
  { key: 'eps', label: '基本每股收益', field: 'EPSJB', unit: '元' },
  { key: 'bps', label: '每股净资产', field: 'BPS', unit: '元' },
  { key: 'ocfps', label: '每股经营现金流', field: 'MGJYXJJE', unit: '元' },
  { key: 'revenue', label: '营业总收入', field: 'TOTALOPERATEREVE', unit: '元' },
  { key: 'revenueYoy', label: '营业总收入同比', field: 'TOTALOPERATEREVETZ', unit: '%' },
  { key: 'netProfit', label: '归母净利润', field: 'PARENTNETPROFIT', unit: '元' },
  { key: 'netProfitYoy', label: '归母净利润同比', field: 'PARENTNETPROFITTZ', unit: '%' },
  { key: 'netProfitDeduct', label: '扣非净利润', field: 'KCFJCXSYJLR', unit: '元' },
  { key: 'roe', label: '加权 ROE', field: 'ROEJQ', unit: '%' },
  { key: 'grossMargin', label: '销售毛利率', field: 'XSMLL', unit: '%' },
  { key: 'netMargin', label: '销售净利率', field: 'XSJLL', unit: '%' },
  { key: 'debtRatio', label: '资产负债率', field: 'ZCFZL', unit: '%' },
];

/**
 * A股走 F10 主要财务指标；港股/美股 F10 实测 404（docs/SOURCES.md §2.2），
 * 因此用 push2 报价里的 PE/PB/ROE/营收/市值作为结构化基本面主源。
 */
export async function emFundamentals(market: Market, code: string, fallbackName: string): Promise<Fundamentals | null> {
  if (market !== 'CN') return emValuationFundamentals(market, code, fallbackName);

  const sc = encodeURIComponent(`(SECUCODE="${secucode(code, market)}")`);
  const url =
    'https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA' +
    `&columns=ALL&filter=${sc}&pageNumber=1&pageSize=6&sortTypes=-1&sortColumns=REPORT_DATE&source=HSF10&client=PC`;
  const json = await tryJson<{ result?: { data?: EmFinRow[] | null } }>(url, {
    headers: { Referer: 'https://emweb.securities.eastmoney.com/' },
    cacheTtlMs: FIN_TTL_MS,
    cacheKey: `em:fin:${code}`,
  });
  const row = json?.result?.data?.[0];
  if (!row) return null;

  const period = typeof row.REPORT_DATE_NAME === 'string' ? row.REPORT_DATE_NAME : '';
  const reportDate = typeof row.REPORT_DATE === 'string' ? row.REPORT_DATE.slice(0, 10) : null;
  const metrics: FundamentalMetric[] = [];
  for (const spec of FIN_METRICS) {
    const raw = row[spec.field];
    if (raw === null || raw === undefined || raw === '') continue;
    const value = toNumber(raw);
    metrics.push({
      key: spec.key,
      label: spec.label,
      value: round4(value),
      unit: spec.unit,
      period: period || undefined,
    });
  }
  const revYoy = metrics.find((m) => m.key === 'revenueYoy');
  const profitYoy = metrics.find((m) => m.key === 'netProfitYoy');
  if (revYoy) revYoy.yoy = revYoy.value;
  if (profitYoy) profitYoy.yoy = profitYoy.value;

  const highlights = await emIndustryHighlights(code);
  highlights.unshift(`财报期间：${period || reportDate || '未知'}（${String(row.REPORT_TYPE ?? '')}）。`);

  return {
    code,
    market,
    name: fallbackName || secucode(code, market),
    reportDate,
    reportType: typeof row.REPORT_TYPE === 'string' ? row.REPORT_TYPE : null,
    metrics,
    highlights,
    sources: [SOURCE],
  };
}

async function emValuationFundamentals(market: Market, code: string, fallbackName: string): Promise<Fundamentals | null> {
  const result = await emQuote(market, code);
  if (!result) return null;
  const q = result.quote;
  const metrics: FundamentalMetric[] = [];
  const push = (key: string, label: string, value: number, unit: string): void => {
    if (value > 0) metrics.push({ key, label, value: round4(value), unit });
  };
  push('peTtm', '市盈率(TTM)', q.peTtm, '倍');
  push('pb', '市净率', q.pb, '倍');
  push('roe', '净资产收益率 ROE', q.roe, '%');
  push('marketCap', `总市值`, q.marketCap, q.currency);
  push('revenue', '营业总收入(TTM)', q.revenue, q.currency);
  push('epsTtm', '每股收益(TTM, 估算)', q.peTtm > 0 ? q.price / q.peTtm : 0, q.currency);
  return {
    code,
    market,
    name: q.name || fallbackName,
    reportDate: null,
    reportType: null,
    metrics,
    highlights: [
      '港股/美股本地 F10 财务明细不可用（东方财富 F10 返回 404），以上为 push2 实时估值指标；',
      '如需研报、财报解读与行业数据，请使用 web_search / get_news 工具做联网挖掘。',
      q.industry ? `所属行业：${q.industry}。` : '',
    ].filter(Boolean),
    sources: [SOURCE],
  };
}

/** Best-effort industry/concept board lines for A-shares. */
export async function emIndustryHighlights(code: string): Promise<string[]> {
  const sc = encodeURIComponent(`(SECUCODE="${secucode(code, 'CN')}")`);
  const url =
    'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_CORETHEME_BOARDTYPE' +
    `&columns=ALL&filter=${sc}&pageNumber=1&pageSize=20&source=HSF10&client=PC`;
  const json = await tryJson<{ result?: { data?: Array<Record<string, unknown>> | null } }>(url, {
    headers: { Referer: 'https://emweb.securities.eastmoney.com/' },
    cacheTtlMs: FIN_TTL_MS,
    cacheKey: `em:board:${code}`,
  });
  const rows = json?.result?.data ?? [];
  const names = new Set<string>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (!/NAME/i.test(key)) continue;
      if (typeof value === 'string' && value.trim() && value.trim() !== 'null') names.add(value.trim());
    }
  }
  if (names.size === 0) return [];
  return [`所属行业/概念板块：${[...names].slice(0, 8).join('、')}。`];
}

/* ──────────────────────────────── dividends ──────────────────────────────── */

interface EmBonusRow {
  EX_DIVIDEND_DATE?: unknown;
  EQUITY_RECORD_DATE?: unknown;
  REPORT_DATE?: unknown;
  IMPL_PLAN_PROFILE?: unknown;
  ASSIGN_PROGRESS?: unknown;
  PRETAX_BONUS_RMB?: unknown;
}

export function parsePlanCashPer10(plan: string): number {
  const m = /10\s*派\s*([0-9.]+)/.exec(plan);
  return m ? toNumber(m[1]) : 0;
}

const dateOnly = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, 10) : null;

/**
 * 分红送配：用 RPT_SHAREBONUS_DET（结构化，含税前每10股派息），
 * 并用 F10 BonusFinancing 的 PAY_CASH_DATE 补派息日（A股）。
 * 港股/美股无可用分红源，返回空数组由 registry 记 warning。
 */
export async function emDividends(market: Market, code: string): Promise<DividendItem[]> {
  if (market !== 'CN') return [];
  const filter = encodeURIComponent(`(SECURITY_CODE="${code}")`);
  const url =
    'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET' +
    `&columns=ALL&filter=${filter}&pageNumber=1&pageSize=20&sortColumns=REPORT_DATE&sortTypes=-1`;
  const [json, payDates] = await Promise.all([
    tryJson<{ result?: { data?: EmBonusRow[] | null } }>(url, {
      headers: { Referer: 'https://data.eastmoney.com/' },
      cacheTtlMs: FIN_TTL_MS,
      cacheKey: `em:bonus:${code}`,
    }),
    emPayDates(code),
  ]);
  const rows = json?.result?.data ?? [];
  const items: DividendItem[] = [];
  for (const row of rows) {
    const plan = typeof row.IMPL_PLAN_PROFILE === 'string' ? row.IMPL_PLAN_PROFILE : '';
    const per10 = toNumber(row.PRETAX_BONUS_RMB) || parsePlanCashPer10(plan);
    const exDate = dateOnly(row.EX_DIVIDEND_DATE);
    if (per10 <= 0 && !exDate) continue; // 预披露/不分配 rows carry no usable numbers
    items.push({
      exDate,
      recordDate: dateOnly(row.EQUITY_RECORD_DATE),
      payDate: exDate ? (payDates.get(exDate) ?? null) : null,
      cashPerShare: round4(per10 / 10),
      plan: plan || (per10 > 0 ? `10派${per10}元` : ''),
      period: (dateOnly(row.REPORT_DATE) ?? '').slice(0, 7),
    });
  }
  return items.slice(0, 20);
}

/** exDate → payDate map from the F10 bonus page (best effort). */
async function emPayDates(code: string): Promise<Map<string, string>> {
  const url = `https://emweb.securities.eastmoney.com/PC_HSF10/BonusFinancing/PageAjax?code=${/^[659]/.test(code) ? 'SH' : 'SZ'}${code}`;
  const json = await tryJson<{ fhyx?: Array<{ EX_DIVIDEND_DATE?: unknown; PAY_CASH_DATE?: unknown }> | null }>(url, {
    headers: { Referer: 'https://emweb.securities.eastmoney.com/' },
    cacheTtlMs: FIN_TTL_MS,
    cacheKey: `em:paydate:${code}`,
  });
  const map = new Map<string, string>();
  for (const row of json?.fhyx ?? []) {
    const ex = dateOnly(row.EX_DIVIDEND_DATE);
    const pay = dateOnly(row.PAY_CASH_DATE);
    if (ex && pay) map.set(ex, pay);
  }
  return map;
}

/* ───────────────────────────────── indices ───────────────────────────────── */

/** Global index snapshot used by the dashboard and macro tool. */
export const INDEX_SECIDS = [
  '1.000001', // 上证指数
  '1.000300', // 沪深300
  '0.399001', // 深证成指
  '100.HSI',  // 恒生指数
  '100.NDX',  // 纳斯达克100
  '100.DJIA', // 道琼斯
  '100.SPX',  // 标普500
];

const INDEX_MARKET: Record<string, Market> = {
  '000001': 'CN',
  '000300': 'CN',
  '399001': 'CN',
  '399006': 'CN',
  HSI: 'HK',
  NDX: 'US',
  DJIA: 'US',
  SPX: 'US',
  'NDX.X': 'US',
};

export async function emIndices(): Promise<Quote[]> {
  return emBatchQuotes(INDEX_SECIDS, (_secid, code, flag) => {
    const known = INDEX_MARKET[code];
    if (known) return known;
    if (flag === 116) return 'HK';
    if (flag === 100) return 'US';
    return 'CN';
  });
}

/** Single-file JSON helper shared by the other EM endpoints. */
export async function emJson<T>(url: string, referer: string, cacheKey: string, ttlMs: number): Promise<T | null> {
  return tryJson<T>(url, { headers: { Referer: referer }, cacheTtlMs: ttlMs, cacheKey });
}

/** Plain JSON fetch (no cache) used by one-off probes/tests. */
export async function emJsonNoCache<T>(url: string, referer = REFERER): Promise<T | null> {
  try {
    return await httpJson<T>(url, { headers: { Referer: referer }, cacheTtlMs: 0 });
  } catch {
    return null;
  }
}

/** ISO timestamp helper re-exported for pipeline code. */
export const emIso = isoOrNull;
