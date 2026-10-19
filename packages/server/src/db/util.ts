/**
 * Small shared helpers for the persistence layer and route modules.
 *
 * Owner: server-core. Keep this file dependency-light: it must never import
 * anything that reaches back into the repository or the Fastify app.
 */
import type {
  BudgetConfig,
  Creator,
  DataSourceChoice,
  DataSourceConfig,
  InstrumentType,
  LlmConfig,
  Market,
  Quote,
} from '@aia/shared';
import { z, type ZodType } from 'zod';

import { badRequest } from '../errors.js';
import type { StoredSettings } from '../types/models.js';
import type { Repo } from '../types/repo.js';

/* ───────────────────────────── numbers / strings ──────────────────────────── */

/** Money precision used across the API (docs/API.md §0: 4 decimals). */
export function round4(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  if (typeof value === 'bigint') return Number(value);
  return fallback;
}

export function toBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes') return true;
    if (v === '0' || v === 'false' || v === 'no' || v === '') return false;
  }
  return fallback;
}

export function toText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

export function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = toText(value);
  return text === '' ? null : text;
}

export function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
}

/* ─────────────────────────────────── json ─────────────────────────────────── */

export function parseJson<T>(text: unknown): T | undefined {
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return 'null';
  }
}

export function toNumberArray(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : parseJson<unknown>(value);
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => toNumber(item)).filter((item) => Number.isFinite(item));
}

/* ────────────────────────────────── dates ─────────────────────────────────── */

const pad = (value: number, width = 2): string => String(Math.abs(value)).padStart(width, '0');

/** ISO-8601 timestamp with the local offset (docs/API.md §0). */
export function nowIso(date: Date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${offset}`
  );
}

/** `YYYY-MM` of `date` in local time (budget months). */
export function localMonth(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

/** `YYYY-MM-DD` of `date` in local time. */
export function localDate(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const TRADE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True only for a `YYYY-MM-DD` string that exists on the real calendar
 * (month 1-12, day 1-{28,29,30,31}, leap years included). The regex alone would
 * happily accept `2026-13-45` / `2026-02-30` and pollute monthly buckets.
 */
export function isTradeDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
  );
}

/* ───────────────────────────────── settings ───────────────────────────────── */

/** `sk-****abcd` — never leaks more than the last four characters. */
export function maskApiKey(apiKey: string): string {
  const key = (apiKey ?? '').trim();
  if (key === '') return '';
  if (key.length <= 4) return '****';
  const prefix = /^sk-/i.test(key) ? key.slice(0, 3) : '';
  return `${prefix}****${key.slice(-4)}`;
}

/* ──────────────────────── data-source key sanitising ──────────────────────── */

/**
 * HTTP/backup representation of one data-source slot: the secret never leaves
 * the server, only `hasApiKey` + a redacted `apiKeyMasked` (same rule as
 * `llm.apiKey`).
 *
 * NOTE: slot keys are masked completely (`****`) rather than with
 * `maskApiKey`'s 4-character tail. A tail would echo real key material —
 * e.g. `maskApiKey('tvly-SEARCH-LEAK') === '****LEAK'` — which both leaks
 * characters and trips "no secret substring in any response" checks. The
 * documented `sk-****abcd` shape is only frozen for `llm.apiKey`.
 */
export interface MaskedDataSourceChoice {
  provider: DataSourceChoice['provider'];
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyMasked: string;
}

export type MaskedDataSourceConfig = { [K in keyof DataSourceConfig]: MaskedDataSourceChoice };

export function maskDataSourceChoice(choice: DataSourceChoice | undefined): MaskedDataSourceChoice {
  const apiKey = typeof choice?.apiKey === 'string' ? choice.apiKey : '';
  const hasApiKey = apiKey.trim() !== '';
  return {
    provider: choice?.provider ?? 'auto',
    enabled: choice?.enabled !== false,
    hasApiKey,
    apiKeyMasked: hasApiKey ? '****' : '',
  };
}

/** Strips every slot's plaintext `apiKey`; assignable to `DataSourceConfig`. */
export function maskDataSourceConfig(config: DataSourceConfig | undefined): MaskedDataSourceConfig {
  const source = (config ?? {}) as Partial<DataSourceConfig>;
  const masked = {} as MaskedDataSourceConfig;
  for (const key of Object.keys(source) as (keyof DataSourceConfig)[]) {
    masked[key] = maskDataSourceChoice(source[key]);
  }
  return masked;
}

/* ───────────────────────────── list query helpers ─────────────────────────── */

export type SortDir = 'asc' | 'desc';

export function sortDirection(value: unknown, fallback: SortDir = 'desc'): SortDir {
  return value === 'asc' || value === 'desc' ? value : fallback;
}

/** Sorts a copy of `items` by `pick`, treating `null`/`undefined`/NaN as lowest. */
export function sortItems<T>(items: T[], pick: (item: T) => unknown, dir: SortDir): T[] {
  const factor = dir === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const left = comparable(pick(a));
    const right = comparable(pick(b));
    if (left === right) return 0;
    if (left === null) return 1; // missing values always sort last
    if (right === null) return -1;
    if (typeof left === 'number' && typeof right === 'number') return (left - right) * factor;
    return String(left).localeCompare(String(right), 'zh-Hans-CN') * factor;
  });
}

function comparable(value: unknown): number | string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value === '' ? null : value;
  return null;
}

export function matchesQuery(query: string | undefined, ...fields: (string | null | undefined)[]): boolean {
  const needle = (query ?? '').trim().toLowerCase();
  if (needle === '') return true;
  return fields.some((field) => (field ?? '').toLowerCase().includes(needle));
}

/* ────────────────────────── market-data soft bridge ───────────────────────── */

/**
 * `agent-engine` owns `src/datasources/**` (module of record:
 * `datasources/registry.ts`). The dashboard/refresh routes only need a tiny
 * slice of it, so this bridge imports it lazily and degrades to `null` when the
 * module is unavailable or when `AIA_OFFLINE=1` (tests / air-gapped hosts):
 * callers then return empty indices or skip the refresh instead of failing.
 */
export interface MarketBridgeQuote {
  name?: string;
  price?: number;
  prevClose?: number;
  dayChangePct?: number;
  currency?: string;
}

export interface MarketBridge {
  resolveInstrument(input: { code: string; market: string; type: string }): Promise<{ name?: string } | undefined>;
  quote(market: string, code: string, type: string): Promise<MarketBridgeQuote | undefined>;
  /** Close series (oldest → newest) used for the list sparkline. */
  series(market: string, code: string, type: string): Promise<number[]>;
  indices(): Promise<Quote[]>;
}

const DATASOURCE_MODULE = '../datasources/registry.js';

let bridgePromise: Promise<MarketBridge | null> | undefined;

export function isOffline(): boolean {
  return process.env.AIA_OFFLINE === '1';
}

export function loadMarketBridge(): Promise<MarketBridge | null> {
  // Checked on every call so tests can force offline mode regardless of cache order.
  if (isOffline()) return Promise.resolve(null);
  bridgePromise ??= probeBridge();
  return bridgePromise;
}

async function probeBridge(): Promise<MarketBridge | null> {
  let mod: typeof import('../datasources/registry.js');
  try {
    mod = await import(DATASOURCE_MODULE);
  } catch {
    return null;
  }

  return {
    async resolveInstrument(input) {
      try {
        const resolved = await mod.resolveInstrument({
          code: input.code,
          market: input.market as Market,
          type: input.type as InstrumentType,
        });
        return resolved ? { name: resolved.value.name } : undefined;
      } catch {
        return undefined;
      }
    },
    async quote(market, code, type) {
      try {
        const result = await mod.getQuote({ code, market: market as Market, type: type as InstrumentType });
        if (!result) return undefined;
        const quote = result.value;
        return {
          name: quote.name,
          price: quote.price,
          prevClose: quote.prevClose,
          dayChangePct: quote.changePct,
          currency: quote.currency,
        };
      } catch {
        return undefined;
      }
    },
    async series(market, code, type) {
      try {
        const result = await mod.getSeries({
          code,
          market: market as Market,
          type: type as InstrumentType,
          range: '1m',
          interval: 'day',
        });
        return result?.value.points.map((point) => toNumber(point.close)).filter((value) => value > 0) ?? [];
      } catch {
        return [];
      }
    },
    async indices() {
      try {
        const result = await mod.getIndices();
        return Array.isArray(result.value) ? result.value : [];
      } catch {
        return [];
      }
    },
  };
}

/** Drops the datasource HTTP cache after a settings change. Best effort. */
export async function resetDatasourceCache(): Promise<void> {
  try {
    const mod = await import(DATASOURCE_MODULE);
    mod.resetDataSourceCache();
  } catch {
    /* agent-engine module unavailable: nothing to reset */
  }
}

/* ─────────────────────────── settings patch helper ────────────────────────── */

/**
 * Nested-partial settings patch accepted by `Repo.saveSettings`.
 *
 * The frozen interface declares the parameter as
 * `Partial<StoredSettings> & { llm?: Partial<StoredSettings['llm']> }`, whose
 * intersection collapses `llm` back to the full `LlmConfig` (and every other
 * nested object to its full shape). This alias + cast keeps call sites honest
 * until the contract is relaxed to a true deep-partial.
 */
export type SettingsPatch = {
  persona?: StoredSettings['persona'];
  reportStyle?: StoredSettings['reportStyle'];
  llm?: Partial<LlmConfig>;
  dataSources?: { [K in keyof DataSourceConfig]?: Partial<DataSourceConfig[K]> };
  budget?: Partial<BudgetConfig>;
  /** 定时任务：整体替换（数组）。 */
  schedules?: StoredSettings['schedules'];
  enforceBudget?: boolean;
  watchlistCandidateLimit?: number;
  /** 期权卖权设置（可用现金 + 到期结算模式）。 */
  option?: Partial<Omit<StoredSettings['option'], 'cash'>> & { cash?: Partial<StoredSettings['option']['cash']> };
  lastRunAt?: string | null;
  updatedAt?: string;
};

export function settingsPatch(patch: SettingsPatch): Parameters<Repo['saveSettings']>[0] {
  return patch as unknown as Parameters<Repo['saveSettings']>[0];
}

/* ─────────────────────────────── zod helpers ──────────────────────────────── */

/** Parses with a zod schema, converting failures into a 400 `AppError`. */
export function parseOrThrow<T>(schema: ZodType<T>, value: unknown, label = '参数'): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw badRequest(
      `${label}校验失败`,
      result.error.issues.map((issue) => ({
        path: issue.path.map((segment) => String(segment)).join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/* ─────────────────────────── shared query schemas ─────────────────────────── */

export const marketSchema = z.enum(['CN', 'HK', 'US']);
export const instrumentTypeSchema = z.enum(['stock', 'etf', 'fund']);
export const creatorSchema = z.enum(['manual', 'ai']);
export const tradeDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期需为 YYYY-MM-DD')
  .refine((value) => isTradeDate(value), { message: '日期不存在（请检查月份与当月天数，含闰年）' });

export const listQuerySchema = z.object({
  market: marketSchema.optional(),
  type: instrumentTypeSchema.optional(),
  source: creatorSchema.optional(),
  q: z.string().optional(),
  sort: z.string().optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

export interface ListQuery {
  market?: Market;
  type?: InstrumentType;
  source?: Creator;
  q?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
}

export function parseListQuery(value: unknown): ListQuery {
  return parseOrThrow(listQuerySchema, value ?? {}, '查询参数');
}
