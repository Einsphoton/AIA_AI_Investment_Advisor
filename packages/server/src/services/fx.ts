/**
 * FX rates into CNY (docs/API.md §3 `portfolio.fxRates`).
 *
 * Owner: server-core. Source: 东方财富 forex quote (`push2.eastmoney.com`),
 * zero key. Live rates are cached in memory for one hour and persisted in the
 * `kv` table so a restart (or an offline host) still has usable rates.
 *
 * **All-or-nothing degradation** (fix M4): a partially fetched table used to mix
 * a live leg with a bundled leg, which produced absurd implied crosses
 * (e.g. USD 6.6917 live ÷ HKD 0.92 bundled = 7.274, outside the HKD peg band) and
 * made `npm run smoke` flap. Now:
 *   - every leg must succeed, otherwise the **whole** table falls back to
 *     {@link FX_FALLBACK_INTO_CNY} with an explicit warning;
 *   - the USD/HKD cross-check runs in **all** cases (including the fallback
 *     table) and any anomaly is surfaced as a warning.
 *
 * **Fallback is never persisted** (fix D6): writing `{USD:7.1, HKD:0.92}` to `kv`
 * used to keep serving the bundled constants for a full hour after the network
 * recovered (`invalidateFxCache()` only clears memory). Fallback results now live
 * in memory for {@link FX_FALLBACK_TTL_MS} (60 s) only, so recovery is picked up
 * on the next request while an outage still costs at most one probe per minute.
 */
import { FX_FALLBACK_INTO_CNY } from '@aia/shared';

import { getRepo } from '../registry.js';
import type { Repo } from '../types/repo.js';
import { nowIso, parseJson, round4, stringifyJson, toNumber } from '../db/util.js';

export const FX_KV_KEY = 'fx.rates.v3';
/** TTL for real (network) rates — memory **and** kv. */
export const FX_CACHE_TTL_MS = 60 * 60 * 1000;
/** TTL for the bundled fallback table — memory only, never persisted. */
export const FX_FALLBACK_TTL_MS = 60 * 1000;

/** `secid` → target currency code (rate = CNY per 1 unit of the currency). */
const PAIRS: { secid: string; currency: string; name: string }[] = [
  { secid: '133.USDCNH', currency: 'USD', name: 'USD/CNH' },
  { secid: '133.HKDCNH', currency: 'HKD', name: 'HKD/CNH' },
];

const EASTMONEY_URL = 'https://push2.eastmoney.com/api/qt/stock/get';
const FETCH_TIMEOUT_MS = 8_000;

/** Currencies that must all come from the same source to be usable together. */
const REQUIRED = PAIRS.map((pair) => pair.currency);

export interface FxRatesResult {
  rates: Record<string, number>;
  /** `live` when every pair came from the network, `fallback` otherwise. */
  source: 'live' | 'fallback';
  fetchedAt: string;
  warning?: string;
}

let memory: FxRatesResult | null = null;

function baseRates(): Record<string, number> {
  return { ...FX_FALLBACK_INTO_CNY };
}

/** Freshness depends on provenance: live 1 h, fallback 60 s. */
function isFresh(entry: FxRatesResult, now = Date.now()): boolean {
  const stamp = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(stamp)) return false;
  const ttl = entry.source === 'live' ? FX_CACHE_TTL_MS : FX_FALLBACK_TTL_MS;
  return now - stamp >= 0 && now - stamp < ttl;
}

function normalise(entry: FxRatesResult): FxRatesResult {
  const rates = baseRates();
  for (const [code, value] of Object.entries(entry.rates ?? {})) {
    const rate = toNumber(value);
    if (Number.isFinite(rate) && rate > 0) rates[code.toUpperCase()] = round4(rate);
  }
  rates.CNY = 1;
  return { ...entry, rates };
}

function resolveRepo(repo?: Repo | null): Repo | undefined {
  if (repo) return repo;
  try {
    return getRepo();
  } catch {
    return undefined;
  }
}

/** Live rates into CNY, falling back to the bundled table on failure. */
export async function getFxRatesResult(repo?: Repo | null): Promise<FxRatesResult> {
  const store = resolveRepo(repo);
  const now = Date.now();

  if (memory && isFresh(memory, now)) return memory;

  const cached = readPersisted(store);
  if (cached && isFresh(cached, now)) {
    memory = cached;
    return cached;
  }

  const fetched = await fetchLiveRates();
  memory = fetched;
  // D6: only real rates are worth a long-lived kv entry — a persisted fallback
  // would keep serving the bundled constants long after the network recovered.
  if (fetched.source === 'live') persist(store, fetched);
  return fetched;
}

/** Frozen signature used by the route layer: plain `{ USD: 7.1, … }`. */
export async function getFxRates(repo?: Repo | null): Promise<Record<string, number>> {
  return (await getFxRatesResult(repo)).rates;
}

/** Test/diagnostics helper: drops the in-memory cache. */
export function invalidateFxCache(): void {
  memory = null;
}

function readPersisted(store?: Repo): FxRatesResult | undefined {
  if (!store) return undefined;
  try {
    const raw = store.getKv(FX_KV_KEY);
    const parsed = parseJson<FxRatesResult>(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.rates) return undefined;
    // Fallback tables are memory-only (D6): ignore anything degraded that an
    // older build may have left in kv, so recovery is immediate.
    if (parsed.source !== 'live') return undefined;
    // A `live` entry with a missing leg would be completed from the bundled table
    // on read, silently re-introducing the mixed-table bug — reject it instead.
    if (!isComplete(parsed.rates)) return undefined;
    return normalise(parsed);
  } catch {
    return undefined;
  }
}

/** True when every required currency has its own usable value. */
function isComplete(rates: Record<string, unknown>): boolean {
  return REQUIRED.every((code) => toNumber(rates[code]) > 0);
}

function persist(store: Repo | undefined, entry: FxRatesResult): void {
  if (!store) return;
  // Defensive second gate (D6): never write a degraded table to the kv store.
  if (entry.source !== 'live') return;
  try {
    store.setKv(FX_KV_KEY, stringifyJson(entry));
  } catch {
    /* caching is best-effort */
  }
}

async function fetchLiveRates(): Promise<FxRatesResult> {
  const offline = (reason: string): FxRatesResult => {
    const rates = baseRates();
    const warning =
      `${reason}：已整体回退内置离线汇率（USD ${FX_FALLBACK_INTO_CNY.USD} / HKD ${FX_FALLBACK_INTO_CNY.HKD}，` +
      `为打包默认值，可能与实际偏差 5%+），未混用实时与内置值`;
    const anomaly = crossCheck(rates);
    return {
      rates,
      source: 'fallback',
      fetchedAt: nowIso(),
      warning: anomaly ? `${warning}；${anomaly}` : warning,
    };
  };

  if (process.env.AIA_OFFLINE === '1') return offline('AIA_OFFLINE=1');

  const fetched: Record<string, number> = {};
  const failures: string[] = [];

  await Promise.all(
    PAIRS.map(async (pair) => {
      try {
        const value = await fetchPair(pair.secid);
        if (value === undefined) {
          failures.push(pair.name);
          return;
        }
        // 1 unit of the foreign currency = `value` CNY, so it multiplies directly.
        fetched[pair.currency] = value;
      } catch {
        failures.push(pair.name);
      }
    }),
  );

  // All-or-nothing: mixing live and bundled legs distorts the implied cross rate.
  if (failures.length > 0) {
    return offline(`实时汇率不完整（缺失 ${failures.join('、')}）`);
  }
  if (!isComplete(fetched)) {
    return offline('实时汇率未返回全部币种');
  }

  // Cross-check the complete live table too — a mis-scaled leg must not silently
  // flow into portfolio conversion.
  const suspicious = crossCheck(fetched);
  if (suspicious) return offline(suspicious);

  return { rates: { ...baseRates(), ...fetched }, source: 'live', fetchedAt: nowIso() };
}

/**
 * Sanity self-check: HKD/CNH is pegged, so USD/CNY ÷ HKD/CNY must sit near 7.8
 * (7.75–7.85 band + a little slack). A wildly different ratio means one of the
 * two quotes was mis-scaled — surfaced as a warning instead of silent garbage.
 */
function crossCheck(rates: Record<string, number>): string | undefined {
  const usd = toNumber(rates.USD);
  const hkd = toNumber(rates.HKD);
  if (!(usd > 0) || !(hkd > 0)) return undefined;
  const ratio = usd / hkd;
  if (ratio < 7.5 || ratio > 8.1) {
    return `汇率交叉校验异常：USD/HKD=${round4(ratio)}（联系汇率应接近 7.8），汇率可能不可靠`;
  }
  return undefined;
}

async function fetchPair(secid: string): Promise<number | undefined> {
  const url = `${EASTMONEY_URL}?secid=${encodeURIComponent(secid)}&fields=f43,f58,f59`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json', 'user-agent': 'ai-investment-advisor/0.1' },
  });
  if (!response.ok) throw new Error(`eastmoney ${response.status}`);
  const body = (await response.json()) as { data?: { f43?: unknown; f59?: unknown } | null };
  return parseEastmoneyRate(body?.data?.f43, body?.data?.f59);
}

/**
 * Eastmoney returns forex prices as scaled integers: `f43` is the price ×
 * 10^`f59` (e.g. USDCNH → 66914 / 10^4 = 6.6914). When `f59` is missing we fall
 * back to the legacy “divide by 100” heuristic.
 */
export function parseEastmoneyRate(raw: unknown, decimals?: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === '-') return undefined;
  let value = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(value) || value <= 0) return undefined;

  const digits = typeof decimals === 'number' ? decimals : Number(decimals);
  if (Number.isFinite(digits) && digits >= 0 && digits <= 8) {
    value /= 10 ** Math.trunc(digits);
  } else if (value > 100) {
    value /= 100;
  }

  if (value <= 0.0001 || value > 100) return undefined;
  return round4(value);
}
