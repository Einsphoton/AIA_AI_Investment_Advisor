/**
 * 天天基金（东方财富场外基金）provider — zero-key NAV curve, detail, holdings, search.
 *
 * Sources & shapes verified 2026-10-14 (docs/SOURCES.md §3, probe3/probe round 4):
 *  - `pingzhongdata/{code}.js` → `var` declarations (fS_name, syl_*, Data_netWorthTrend…)
 *  - `api.fund.eastmoney.com/f10/lsjz` → paginated NAV history (needs fundf10 Referer)
 *  - `fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc` → top-10 holdings with weights
 *  - `fundsuggest.eastmoney.com/.../FundSearchAPI.ashx` → code/name/company/type
 *
 * Owner: agent-engine.
 */
import type {
  FundHolding,
  FundInfo,
  InstrumentType,
  Market,
  Quote,
  RangeKey,
  SeriesPoint,
  SeriesResponse,
  SourceId,
} from '@aia/shared';
import { round4, toNumber, tryJson, tryText } from './http.js';
import { sliceByRange } from './eastmoney.js';
import type { SearchHit } from './types.js';

const SOURCE: SourceId = 'eastmoney-fund';
const NAV_TTL_MS = 5 * 60_000;
const DETAIL_TTL_MS = 30 * 60_000;
const SEARCH_TTL_MS = 10 * 60_000;

/* ───────────────────────── pingzhongdata .js parsing ─────────────────────── */

export type PingzhongVars = Record<string, unknown>;

/**
 * Extracts `var NAME = VALUE;` declarations from the pingzhongdata bundle.
 * Values may be strings, numbers, booleans, arrays or objects — bracket/quote
 * aware scanning keeps nested JSON intact.
 */
export function parsePingzhongVars(source: string): PingzhongVars {
  const out: PingzhongVars = {};
  const re = /var\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const name = match[1]!;
    const start = match.index + match[0].length;
    const raw = readJsValue(source, start);
    if (raw === null) continue;
    out[name] = parseJsValue(raw);
  }
  return out;
}

function readJsValue(source: string, start: number): string | null {
  const first = source[start];
  if (first === '[' || first === '{') {
    let depth = 0;
    let inString: string | null = null;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i]!;
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = ch;
        continue;
      }
      if (ch === '[' || ch === '{') depth += 1;
      else if (ch === ']' || ch === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    return null;
  }
  const semi = source.indexOf(';', start);
  if (semi < 0) return null;
  return source.slice(start, semi);
}

function parseJsValue(raw: string): unknown {
  const text = raw.trim().replace(/;\s*$/, '');
  if (!text) return undefined;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  try {
    return JSON.parse(text.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":').replace(/'/g, '"'));
  } catch {
    return text;
  }
}

/** Beijing-local `YYYY-MM-DD` for millisecond timestamps used by fund charts. */
export function fundDate(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** Strips the JSONP wrapper of EM's finance-news endpoint (shared helper). */
export function stripJsonp(text: string): string {
  const trimmed = text.trim();
  const open = trimmed.indexOf('(');
  const close = trimmed.lastIndexOf(')');
  if (open > 0 && close > open) return trimmed.slice(open + 1, close);
  return trimmed;
}

async function pingzhongVars(code: string): Promise<PingzhongVars> {
  const text = await tryText(`https://fund.eastmoney.com/pingzhongdata/${encodeURIComponent(code)}.js`, {
    headers: { Referer: 'https://fund.eastmoney.com/' },
    cacheTtlMs: NAV_TTL_MS,
    cacheKey: `fund:pingzhong:${code}`,
  });
  if (!text) return {};
  return parsePingzhongVars(text);
}

/* ──────────────────────────────── NAV series ─────────────────────────────── */

/** Unit-NAV + accumulated-NAV curve (kind = 'nav'). */
export async function fundSeries(
  code: string,
  range: RangeKey,
  market: Market = 'CN',
  type: InstrumentType = 'fund',
): Promise<SeriesResponse | null> {
  const vars = await pingzhongVars(code);
  const netWorth = toPairs(vars.Data_netWorthTrend);
  const acWorth = new Map<string, number>();
  for (const [ts, value] of toPairs(vars.Data_ACWorthTrend)) {
    acWorth.set(fundDate(ts), value);
  }
  if (netWorth.length === 0) return null;
  const points: SeriesPoint[] = netWorth.map(([ts, nav]) => {
    const date = fundDate(ts);
    const accum = acWorth.get(date);
    return {
      date,
      open: round4(nav),
      high: round4(nav),
      low: round4(nav),
      close: round4(nav),
      volume: 0,
      ...(accum === undefined ? {} : { accumNav: round4(accum) }),
    };
  });
  const name = typeof vars.fS_name === 'string' ? vars.fS_name : '';
  return {
    code,
    market,
    type,
    kind: 'nav',
    interval: 'day',
    range,
    currency: 'CNY',
    name,
    points: sliceByRange(points, range),
    sources: [SOURCE],
    warnings: [],
  };
}

function toPairs(raw: unknown): Array<[number, number]> {
  if (!Array.isArray(raw)) return [];
  const out: Array<[number, number]> = [];
  for (const entry of raw) {
    if (Array.isArray(entry) && entry.length >= 2) {
      out.push([toNumber(entry[0]), toNumber(entry[1])]);
    } else if (entry && typeof entry === 'object') {
      const rec = entry as { x?: unknown; y?: unknown };
      if (rec.x !== undefined && rec.y !== undefined) out.push([toNumber(rec.x), toNumber(rec.y)]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** Latest NAV + date, used for fund quotes and watchlist refreshes. */
export async function fundLatestNav(code: string): Promise<{ nav: number; accumNav: number; navDate: string | null; name: string } | null> {
  const vars = await pingzhongVars(code);
  const netWorth = toPairs(vars.Data_netWorthTrend);
  if (netWorth.length === 0) {
    const fallback = await fundNavHistory(code, 1);
    if (fallback.length === 0) return null;
    const last = fallback[0]!;
    return { nav: last.nav, accumNav: last.accumNav, navDate: last.date, name: '' };
  }
  const last = netWorth[netWorth.length - 1]!;
  const acLast = toPairs(vars.Data_ACWorthTrend).at(-1);
  return {
    nav: round4(last[1]),
    accumNav: round4(acLast?.[1] ?? last[1]),
    navDate: fundDate(last[0]) || null,
    name: typeof vars.fS_name === 'string' ? vars.fS_name : '',
  };
}

/** Latest NAV expressed as a `Quote` so open-end funds fit the same pipeline. */
export async function fundQuote(code: string): Promise<Quote | null> {
  const vars = await pingzhongVars(code);
  const netWorth = toPairs(vars.Data_netWorthTrend);
  if (netWorth.length === 0) {
    const latest = await fundNavHistory(code, 2);
    if (latest.length === 0) return null;
    const price = latest[0]!.nav;
    const prev = latest[1]?.nav ?? price;
    return navQuote(code, typeof vars.fS_name === 'string' ? vars.fS_name : '', price, prev, latest[0]!.date);
  }
  const last = netWorth.at(-1)!;
  const prev = netWorth.at(-2)?.[1] ?? last[1];
  return navQuote(code, typeof vars.fS_name === 'string' ? vars.fS_name : '', last[1], prev, fundDate(last[0]));
}

function navQuote(code: string, name: string, price: number, prevClose: number, date: string): Quote {
  const change = round4(price - prevClose);
  const changePct = prevClose > 0 ? round4((change / prevClose) * 100) : 0;
  return {
    code,
    market: 'CN',
    name,
    currency: 'CNY',
    price: round4(price),
    prevClose: round4(prevClose),
    open: 0,
    high: 0,
    low: 0,
    change,
    changePct,
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
    updatedAt: date ? new Date(`${date}T15:00:00+08:00`).toISOString() : new Date().toISOString(),
    source: SOURCE,
  };
}

/** NAV history from the paginated F10 endpoint (backup / deeper history). */
export async function fundNavHistory(
  code: string,
  pageSize = 30,
): Promise<Array<{ date: string; nav: number; accumNav: number; changePct: number; purchase: string; redeem: string; dividend: string }>> {
  const url =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${encodeURIComponent(code)}` +
    `&pageIndex=1&pageSize=${Math.max(1, Math.min(pageSize, 200))}`;
  const json = await tryJson<{
    Data?: { LSJZList?: Array<Record<string, unknown>> | null } | null;
  }>(url, {
    headers: { Referer: 'https://fundf10.eastmoney.com/' },
    cacheTtlMs: NAV_TTL_MS,
    cacheKey: `fund:lsjz:${code}:${pageSize}`,
  });
  const rows = json?.Data?.LSJZList ?? [];
  return rows.map((row) => ({
    date: typeof row.FSRQ === 'string' ? row.FSRQ : '',
    nav: round4(toNumber(row.DWJZ)),
    accumNav: round4(toNumber(row.LJJZ)),
    changePct: round4(toNumber(row.JZZZL)),
    purchase: typeof row.SGZT === 'string' ? row.SGZT : '',
    redeem: typeof row.SHZT === 'string' ? row.SHZT : '',
    dividend: typeof row.FHSP === 'string' ? row.FHSP : '',
  }));
}

/* ──────────────────────────────── fund detail ────────────────────────────── */

interface SuggestFundRow {
  CODE?: unknown;
  NAME?: unknown;
  CATEGORY?: unknown;
  CATEGORYDESC?: unknown;
  STOCKMARKET?: unknown;
  FundBaseInfo?: {
    FCODE?: unknown;
    SHORTNAME?: unknown;
    JJGS?: unknown;
    JJJL?: unknown;
    FTYPE?: unknown;
    DWJZ?: unknown;
    FSRQ?: unknown;
    MINSG?: unknown;
  } | null;
}

/**
 * 确证 1/2：`pingzhongdata/{code}.js` 真的描述了这只基金。
 * 实测（2026-10-14）股票代码会返回 HTTP 200 + 「页面未找到」HTML，因此只看 HTTP
 * 状态码不够，必须存在关键变量（`fS_name` 或非空 `Data_netWorthTrend`）。
 */
export function hasFundData(vars: PingzhongVars): boolean {
  const name = vars.fS_name;
  if (typeof name === 'string' && name.trim() !== '') return true;
  const trend = vars.Data_netWorthTrend;
  return Array.isArray(trend) && trend.length > 0;
}

/**
 * fundsuggest 是一个「基金/证券」混合搜索接口：它会把**股票**按原样回显，
 * 例如 `key=600519` 只返回 `{CODE:"600519", CATEGORY:100, CATEGORYDESC:"沪市",
 * STOCKMARKET:"1", FundBaseInfo:null}`。所以 code 完全相等**不等于**是基金，
 * 必须同时带上基金元数据（FundBaseInfo / CATEGORY=700 / CATEGORYDESC 含「基金」）。
 */
export function isFundRow(row: SuggestFundRow): boolean {
  if (row.FundBaseInfo && typeof row.FundBaseInfo === 'object') return true;
  const category = typeof row.CATEGORY === 'number' ? row.CATEGORY : Number(row.CATEGORY);
  if (Number.isFinite(category) && category === 700) return true;
  return typeof row.CATEGORYDESC === 'string' && row.CATEGORYDESC.includes('基金');
}

/**
 * 确证 2/2：fundsuggest 中存在「CODE 与请求 code 完全相等**且确为基金**」的条目。
 * 同一 code 可能同时命中基金与股票（`000001` → 华夏成长混合 + 平安银行），
 * 因此返回值只认那一条基金记录。
 */
export function findConfirmedFundRow(rows: SuggestFundRow[], code: string): SuggestFundRow | null {
  const target = code.trim().toUpperCase();
  if (!target) return null;
  return (
    rows.find((row) => {
      const rowCode = typeof row.CODE === 'string' ? row.CODE.trim().toUpperCase() : '';
      return rowCode === target && isFundRow(row);
    }) ?? null
  );
}

async function fundSuggestRows(key: string, limit = 10): Promise<SuggestFundRow[]> {
  const url = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encodeURIComponent(key)}`;
  const json = await tryJson<{ Datas?: SuggestFundRow[] | null }>(url, {
    headers: { Referer: 'https://fund.eastmoney.com/' },
    cacheTtlMs: SEARCH_TTL_MS,
    cacheKey: `fund:suggest:${key}:${limit}`,
  });
  return (json?.Datas ?? []).slice(0, limit);
}

/** Open-end fund search (name, code, pinyin). */
export async function fundSearch(query: string, limit = 10): Promise<SearchHit[]> {
  const rows = await fundSuggestRows(query.trim(), limit);
  const hits: SearchHit[] = [];
  for (const row of rows) {
    const code = typeof row.CODE === 'string' ? row.CODE : typeof row.FundBaseInfo?.FCODE === 'string' ? row.FundBaseInfo.FCODE : '';
    const name = typeof row.NAME === 'string' ? row.NAME : typeof row.FundBaseInfo?.SHORTNAME === 'string' ? row.FundBaseInfo.SHORTNAME : '';
    if (!code || !name) continue;
    hits.push({
      code,
      name,
      market: 'CN',
      type: 'fund',
      exchange: typeof row.FundBaseInfo?.FTYPE === 'string' ? row.FundBaseInfo.FTYPE : '场外基金',
      source: SOURCE,
    });
  }
  return hits;
}

/** Top-10 holdings with NAV weights, parsed from the F10 holdings page. */
export async function fundHoldings(code: string, topline = 10): Promise<FundHolding[]> {
  const url =
    `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${encodeURIComponent(code)}` +
    `&topline=${topline}&year=&month=`;
  const html = await tryText(url, {
    headers: { Referer: 'https://fundf10.eastmoney.com/' },
    cacheTtlMs: DETAIL_TTL_MS,
    cacheKey: `fund:holdings:${code}:${topline}`,
  });
  if (!html) return [];
  const out: FundHolding[] = [];
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(html)) !== null) {
    const cells = [...row[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => stripTags(m[1]!));
    if (cells.length < 7) continue;
    const stockCode = cells[1]!;
    const stockName = cells[2]!;
    if (!/\d{5,6}|[A-Z]{1,6}/.test(stockCode)) continue;
    const weightCell = cells.find((c) => /^-?\d+(\.\d+)?%$/.test(c));
    out.push({
      code: stockCode,
      name: stockName,
      weight: round4(toNumber(weightCell?.replace('%', '') ?? '')),
    });
    if (out.length >= topline) break;
  }
  return out;
}

/**
 * Full fund detail used by `get_fund_info` and `/api/market/profile`.
 *
 * **确证才算命中** (task-10, data honesty): a code is treated as an open-end fund
 * only when `pingzhongdata/{code}.js` really carries fund variables **or**
 * `fundsuggest` returns a row whose CODE equals the request *and* which is a real
 * fund. Listed securities are echoed by fundsuggest with an identical CODE
 * (600519 → 沪市/贵州茅台, `FundBaseInfo: null`), so a bare code match is not proof
 * — otherwise a stock code would surface a fabricated fund profile (and feed it
 * to the LLM), violating 「数据缺失要明说，不得编造」.
 *
 * Returns `null` when unconfirmed; callers then report the missing data through
 * `warnings` (profile) / a structured `no_data` tool error.
 */
export async function fundInfo(code: string): Promise<FundInfo | null> {
  const normalized = code.trim();
  const [vars, suggest, holdings] = await Promise.all([
    pingzhongVars(normalized),
    fundSuggestRows(normalized, 10),
    fundHoldings(normalized),
  ]);
  const fundRow = findConfirmedFundRow(suggest, normalized);
  if (!hasFundData(vars) && !fundRow) return null;
  const base = fundRow; // 只使用确证的基金条目，绝不用模糊命中拼装元数据
  const netWorth = toPairs(vars.Data_netWorthTrend);
  const lastNav = netWorth.at(-1);
  const acLast = toPairs(vars.Data_ACWorthTrend).at(-1);
  const scaleSeries = extractSeriesLast(vars.Data_fluctuationScale);
  const allocation = extractAllocation(vars.Data_assetAllocation);
  const manager = firstManagerName(vars.Data_currentFundManager);
  const returns: Array<{ label: string; value: number }> = [];
  const pushReturn = (label: string, value: unknown): void => {
    const n = toNumber(value);
    if (typeof value === 'string' || typeof value === 'number') returns.push({ label, value: round4(n) });
  };
  pushReturn('近1月', vars.syl_1y);
  pushReturn('近3月', vars.syl_3y);
  pushReturn('近6月', vars.syl_6y);
  pushReturn('近1年', vars.syl_1n);

  const fallbackHoldings: FundHolding[] = [];
  if (holdings.length === 0) {
    const codes = vars.stockCodesNew ?? vars.stockCodes;
    if (Array.isArray(codes)) {
      for (const entry of codes.slice(0, 10)) {
        const raw = String(entry);
        const cleaned = raw.includes('.') ? raw.split('.')[1]! : raw.replace(/\d$/, '');
        fallbackHoldings.push({ code: cleaned, name: '', weight: 0 });
      }
    }
  }

  return {
    code: normalized,
    name: typeof vars.fS_name === 'string' && vars.fS_name ? vars.fS_name : String(base?.NAME ?? ''),
    type: typeof base?.FundBaseInfo?.FTYPE === 'string' ? base.FundBaseInfo.FTYPE : String(base?.CATEGORYDESC ?? '场外基金'),
    manager: manager || (typeof base?.FundBaseInfo?.JJJL === 'string' ? base.FundBaseInfo.JJJL : ''),
    company: typeof base?.FundBaseInfo?.JJGS === 'string' ? base.FundBaseInfo.JJGS : '',
    inceptionDate: netWorth.length > 0 ? fundDate(netWorth[0]![0]) || null : null,
    scale: round4(scaleSeries),
    feeRate: round4(toNumber(vars.fund_Rate)),
    nav: round4(toNumber(lastNav?.[1] ?? base?.FundBaseInfo?.DWJZ)),
    navDate:
      (lastNav ? fundDate(lastNav[0]) : '') ||
      (typeof base?.FundBaseInfo?.FSRQ === 'string' ? base.FundBaseInfo.FSRQ : null) ||
      null,
    accumNav: round4(toNumber(acLast?.[1] ?? lastNav?.[1] ?? base?.FundBaseInfo?.DWJZ)),
    returns,
    holdings: holdings.length > 0 ? holdings : fallbackHoldings,
    allocation,
    sources: [SOURCE],
  };
}

function extractSeriesLast(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0;
  const series = (raw as { series?: unknown }).series;
  if (!Array.isArray(series) || series.length === 0) return 0;
  const first = series[0] as { y?: unknown; data?: unknown[] };
  if (Array.isArray(first?.data)) return toNumber(first.data.at(-1));
  return toNumber(first?.y);
}

function extractAllocation(raw: unknown): Array<{ label: string; value: number }> {
  if (!raw || typeof raw !== 'object') return [];
  const series = (raw as { series?: unknown }).series;
  if (!Array.isArray(series)) return [];
  const out: Array<{ label: string; value: number }> = [];
  for (const entry of series) {
    const rec = entry as { name?: unknown; data?: unknown[] };
    if (typeof rec.name !== 'string' || !Array.isArray(rec.data)) continue;
    const last = rec.data.at(-1);
    if (last === undefined || last === null) continue;
    out.push({ label: rec.name, value: round4(toNumber(last)) });
  }
  return out;
}

function firstManagerName(raw: unknown): string {
  if (!Array.isArray(raw) || raw.length === 0) return '';
  const first = raw[0] as { name?: unknown };
  return typeof first?.name === 'string' ? first.name : '';
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
