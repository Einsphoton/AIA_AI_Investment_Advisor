/**
 * Shared HTTP plumbing for every marketplace datasource.
 *
 * Rules (docs/SOURCES.md §7):
 *  - 20s timeout per attempt, up to 2 retries with exponential backoff
 *  - GBK auto-detection via `TextDecoder('gbk')` (Tencent + a few legacy pages)
 *  - Tiny in-process TTL cache (quotes 60s / series 5min / macro 30min) with an
 *    LRU cap, plus in-flight de-duplication so parallel pipelines don't hammer
 *    the same upstream endpoint twice.
 *  - Global concurrency cap so we stay polite (and un-throttled).
 *
 * Owner: agent-engine.
 */
import { DEFAULT_HTTP_TIMEOUT_MS } from '@aia/shared';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Accept: 'application/json, text/plain, text/html, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

export class UpstreamHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(url: string, status: number, body: string) {
    super(`HTTP ${status} for ${shortUrl(url)}${body ? ` :: ${body.slice(0, 160)}` : ''}`);
    this.name = 'UpstreamHttpError';
    this.status = status;
    this.url = url;
    this.body = body.slice(0, 400);
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url.slice(0, 120);
  }
}

/* ──────────────────────────────── cache ──────────────────────────────────── */

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const CACHE_MAX_ENTRIES = 600;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();

export function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  // refresh LRU position
  cache.delete(key);
  cache.set(key, hit);
  return hit.value as T;
}

export function cacheSet(key: string, value: unknown, ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
  cache.delete(key);
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export function clearHttpCache(): void {
  cache.clear();
  inflight.clear();
}

/* ─────────────────────────── concurrency limiter ─────────────────────────── */

const MAX_CONCURRENCY = 8;
let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENCY) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active += 1;
}

function release(): void {
  active -= 1;
  const next = waiters.shift();
  if (next) next();
}

/** Runs `fn` under the shared concurrency cap. */
export async function withLimit<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** `Promise.all` with a bounded number of concurrent workers (order preserved). */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length || 1))).fill(0).map(async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ─────────────────────────────── fetching ────────────────────────────────── */

export type Encoding = 'utf8' | 'gbk' | 'auto' | 'binary';

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Extra attempts after the first failure. Default 2. */
  retries?: number;
  encoding?: Encoding;
  /** Non-zero enables TTL caching for this request. */
  cacheTtlMs?: number;
  /** Explicit cache key; defaults to method+url+body. */
  cacheKey?: string;
  signal?: AbortSignal;
  /** Skip the global concurrency limiter (rare). */
  skipLimiter?: boolean;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  text: string;
  headers: Headers;
  url: string;
}

function decodeBody(buffer: ArrayBuffer, encoding: Encoding): string {
  const bytes = new Uint8Array(buffer);
  if (encoding === 'binary') return Buffer.from(bytes).toString('binary');
  if (encoding === 'gbk') return new TextDecoder('gbk').decode(bytes);
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (encoding === 'utf8') return utf8;
  // auto: replacement chars usually mean a GBK payload
  return utf8.includes('\uFFFD') ? new TextDecoder('gbk').decode(bytes) : utf8;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function attempt(url: string, options: HttpOptions): Promise<HttpResponse> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = (): void => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: { ...DEFAULT_HEADERS, ...(options.headers ?? {}) },
      body: options.body,
      signal: controller.signal,
      redirect: 'follow',
    });
    const buffer = await response.arrayBuffer();
    const text = decodeBody(buffer, options.encoding ?? 'auto');
    return { status: response.status, ok: response.ok, text, headers: response.headers, url };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Performs a GET/POST with timeout + retry, returning the decoded text. */
export async function httpRequest(url: string, options: HttpOptions = {}): Promise<HttpResponse> {
  const retries = Math.max(0, options.retries ?? 2);
  const cacheKey = options.cacheTtlMs ? (options.cacheKey ?? `${options.method ?? 'GET'} ${url}`) : null;

  if (cacheKey) {
    const cached = cacheGet<HttpResponse>(cacheKey);
    if (cached) return cached;
    const pending = inflight.get(cacheKey);
    if (pending) return (await pending) as HttpResponse;
  }

  const task = (async (): Promise<HttpResponse> => {
    let lastError: unknown;
    for (let attemptIndex = 0; attemptIndex <= retries; attemptIndex += 1) {
      try {
        const response = await (options.skipLimiter ? attempt(url, options) : withLimit(() => attempt(url, options)));
        if (!response.ok && response.status !== 404 && (response.status >= 500 || response.status === 429)) {
          throw new UpstreamHttpError(url, response.status, response.text);
        }
        return response;
      } catch (error) {
        lastError = error;
        const status = error instanceof UpstreamHttpError ? error.status : 0;
        if (status === 400 || status === 401 || status === 403) break; // no point retrying
        if (attemptIndex < retries) await sleep(300 * 2 ** attemptIndex);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  })();

  if (cacheKey) {
    inflight.set(cacheKey, task);
    try {
      const response = await task;
      if (response.ok) cacheSet(cacheKey, response, options.cacheTtlMs ?? 0);
      return response;
    } finally {
      inflight.delete(cacheKey);
    }
  }
  return task;
}

/** Text body; throws on non-2xx (except 404 which is returned as empty text). */
export async function httpText(url: string, options: HttpOptions = {}): Promise<string> {
  const response = await httpRequest(url, options);
  if (!response.ok) {
    if (response.status === 404) return '';
    throw new UpstreamHttpError(url, response.status, response.text);
  }
  return response.text;
}

/** JSON body; throws a readable error when the payload is not JSON. */
export async function httpJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
  const response = await httpRequest(url, options);
  if (!response.ok) {
    if (response.status === 404) throw new UpstreamHttpError(url, 404, 'not found');
    throw new UpstreamHttpError(url, response.status, response.text);
  }
  try {
    return JSON.parse(response.text) as T;
  } catch {
    throw new Error(`invalid JSON from ${shortUrl(url)}: ${response.text.slice(0, 120)}`);
  }
}

/** Best-effort JSON: never throws, returns null when unavailable. */
export async function tryJson<T>(url: string, options: HttpOptions = {}): Promise<T | null> {
  try {
    return await httpJson<T>(url, options);
  } catch {
    return null;
  }
}

/** Best-effort text: never throws, returns '' when unavailable. */
export async function tryText(url: string, options: HttpOptions = {}): Promise<string> {
  try {
    return await httpText(url, options);
  } catch {
    return '';
  }
}

/* ─────────────────────────────── utilities ───────────────────────────────── */

export function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/,/g, '');
    if (!trimmed || trimmed === '-' || trimmed === '--') return 0;
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function nullableNumber(value: unknown): number | null {
  const parsed = toNumber(value);
  return parsed === 0 ? null : parsed;
}

/** Rounds to 4 decimals (API.md §0 money precision). */
export function round4(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10_000) / 10_000;
}

export function todayIso(): string {
  return new Date().toISOString();
}

/** `YYYY-MM-DD` in local time. */
export function localDate(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim().replace(' ', 'T');
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return '请求超时（20s）';
    return error.message;
  }
  return String(error);
}
