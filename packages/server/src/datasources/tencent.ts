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
 * Owner: agent-engine.
 */
import { MARKET_CURRENCY, type Market, type Quote, type SourceId } from '@aia/shared';
import { httpText, round4, toNumber } from './http.js';
import type { ProviderQuote } from './types.js';

const SOURCE: SourceId = 'tencent';
const QUOTE_TTL_MS = 60_000;
const REFERER = 'https://gu.qq.com/';

/** Tencent's `q=` symbol for a market/code pair. */
export function tencentSymbol(market: Market, code: string): string {
  const clean = code.trim().toUpperCase();
  if (market === 'CN') return `${/^[659]/.test(clean) ? 'sh' : 'sz'}${clean}`;
  if (market === 'HK') return `hk${clean.padStart(5, '0')}`;
  return `us${clean}`;
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
    pb: round4(toNumber(fields[47])),
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
  const match = /v_[A-Za-z0-9_]+="([^"]+)"/.exec(text);
  if (!match) return null;
  const quote = parseTencentRecord(match[1], market, code);
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
  const re = /v_([A-Za-z0-9_]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const [, symbol, record] = m;
    const code = symbol.replace(/^(sh|sz|hk|us)/i, '');
    const quote = parseTencentRecord(record, marketOf(symbol), code);
    if (quote) out.push(quote);
  }
  return out;
}
