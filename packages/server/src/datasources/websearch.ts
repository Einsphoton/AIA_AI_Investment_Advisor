/**
 * Web search + page fetching for the agent's research tools.
 *
 * Chain (docs/SOURCES.md §5, all verified 2026-10-14):
 *   keyed (Tavily / Serper / Brave, when a key is configured)
 *     → Bing HTML (default, zero-key, works from this network)
 *     → DuckDuckGo HTML (备用; ECONNRESET on some networks)
 *
 * Owner: agent-engine.
 */
import type { SourceId } from '@aia/shared';
import { httpRequest, httpText, tryText } from './http.js';
import { newsSearch } from './news.js';
import type { FetchedPage, WebSearchResponse, WebSearchResult } from './types.js';

const SEARCH_TTL_MS = 10 * 60_000;
const PAGE_TTL_MS = 10 * 60_000;

export const ZERO_KEY_SEARCH_CHAIN: SourceId[] = ['bing', 'duckduckgo'];
export const KEYED_SEARCH_CHAIN: SourceId[] = ['tavily', 'serper', 'brave'];

export interface WebSearchOptions {
  limit?: number;
  /** Provider order to try; defaults to the zero-key chain. */
  providers?: SourceId[];
  /** API keys for keyed providers, keyed by provider id. */
  keys?: Record<string, string>;
  timeoutMs?: number;
}

/* ─────────────────────────────── HTML helpers ────────────────────────────── */

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&middot;': '·',
};

export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&[a-z]+;|&#\d+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

function safeCodePoint(code: number): string {
  try {
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  } catch {
    return '';
  }
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** Converts an HTML document into readable plain text (for `fetch_url`). */
export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? stripTags(titleMatch[1]!) : '';
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|table|ul|ol|blockquote)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  body = decodeEntities(body)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
  return { title, text: body };
}

/* ──────────────────────────────── providers ──────────────────────────────── */

async function bingSearch(query: string, limit: number, timeoutMs?: number): Promise<WebSearchResult[]> {
  // `ensearch=1` is required from this network: without it cn.bing.com serves a
  // degraded SERP whose results are unrelated to the query (verified 2026-10-14).
  const html = await httpText(
    `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(limit * 2, 30)}&ensearch=1`,
    {
      headers: { Referer: 'https://cn.bing.com/', Accept: 'text/html,application/xhtml+xml' },
      cacheTtlMs: SEARCH_TTL_MS,
      cacheKey: `bing:${query}:${limit}`,
      timeoutMs,
    },
  );
  const blocks = html.match(/<li class="b_algo"[\s\S]*?(?=<li class="b_algo"|<\/ol>|$)/g) ?? [];
  const out: WebSearchResult[] = [];
  for (const block of blocks) {
    const linkMatch =
      /<h2[^>]*>[\s\S]*?<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block) ??
      /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*class="[^"]*tilk[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!linkMatch) continue;
    const url = resolveBingUrl(decodeEntities(linkMatch[1]!));
    const title = stripTags(linkMatch[2]!);
    const snippetMatch =
      /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block) ??
      /<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block) ??
      /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const dateMatch = /<span[^>]*class="[^"]*news_dt[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block);
    const citeMatch = /<cite[^>]*>([\s\S]*?)<\/cite>/i.exec(block);
    out.push({
      title,
      url: url.startsWith('http') && !url.includes('bing.com/ck/a') ? url : stripTags(citeMatch?.[1] ?? url),
      snippet: snippetMatch ? stripTags(snippetMatch[1]!) : '',
      publishedAt: dateMatch ? normalizeSearchDate(stripTags(dateMatch[1]!)) : '',
      source: 'bing',
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Bing wraps organic links in `bing.com/ck/a?...&u=a1<base64>`; unwrap when possible. */
export function resolveBingUrl(href: string): string {
  if (!/bing\.com\/ck\/a/i.test(href)) return href;
  const match = /[?&]u=([^&]+)/.exec(href);
  if (!match) return href;
  let raw = decodeURIComponent(match[1]!);
  if (raw.startsWith('a1')) raw = raw.slice(2);
  try {
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch {
    /* fall through */
  }
  return href;
}

/* ────────────────────────────── relevance gate ──────────────────────────── */

/** Meaningful query tokens: CJK bigrams + ASCII words of length ≥ 2. */
export function queryTokens(query: string): string[] {
  const tokens: string[] = [];
  for (const run of query.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) tokens.push(run.slice(i, i + 2));
  }
  for (const word of query.match(/[A-Za-z0-9]{2,}/g) ?? []) tokens.push(word.toLowerCase());
  return [...new Set(tokens)];
}

/** Counts how many query tokens appear in the result; 0 means "unrelated SERP". */
export function relevanceScore(result: WebSearchResult, tokens: string[]): number {
  const haystack = `${result.title} ${result.snippet}`.toLowerCase();
  let score = 0;
  for (const token of tokens) if (haystack.includes(token)) score += 1;
  return score;
}

/** Keeps relevant hits first; returns [] when nothing matches the query. */
function rankByRelevance(results: WebSearchResult[], query: string): WebSearchResult[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return results;
  const scored = results
    .map((result, index) => ({ result, score: relevanceScore(result, tokens), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const relevant = scored.filter((entry) => entry.score > 0);
  return relevant.length > 0 ? relevant.map((entry) => entry.result) : [];
}

async function duckSearch(query: string, limit: number, timeoutMs?: number): Promise<WebSearchResult[]> {
  const html = await httpText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { Referer: 'https://duckduckgo.com/', Accept: 'text/html' },
    cacheTtlMs: SEARCH_TTL_MS,
    cacheKey: `ddg:${query}:${limit}`,
    timeoutMs,
  });
  const blocks = html.match(/<div class="result[^"]*"[\s\S]*?(?=<div class="result|<\/body>|$)/g) ?? [];
  const out: WebSearchResult[] = [];
  for (const block of blocks) {
    const linkMatch = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!linkMatch) continue;
    const snippetMatch = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block) ?? /<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    out.push({
      title: stripTags(linkMatch[2]!),
      url: resolveDuckUrl(linkMatch[1]!),
      snippet: snippetMatch ? stripTags(snippetMatch[1]!) : '',
      publishedAt: '',
      source: 'duckduckgo',
    });
    if (out.length >= limit) break;
  }
  return out;
}

function resolveDuckUrl(href: string): string {
  const raw = href.startsWith('//') ? `https:${href}` : href;
  const uddg = /[?&]uddg=([^&]+)/.exec(raw);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]!);
    } catch {
      return raw;
    }
  }
  return raw;
}

function normalizeSearchDate(raw: string): string {
  const parsed = new Date(raw.replace(/年|月/g, '-').replace(/日/g, ''));
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

async function tavilySearch(query: string, limit: number, key: string, timeoutMs?: number): Promise<WebSearchResult[]> {
  const response = await httpRequest('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: limit, search_depth: 'basic' }),
    cacheTtlMs: SEARCH_TTL_MS,
    cacheKey: `tavily:${query}:${limit}`,
    timeoutMs,
  });
  if (!response.ok) throw new Error(`Tavily HTTP ${response.status}`);
  const json = JSON.parse(response.text) as { results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }> };
  return (json.results ?? []).map((row) => ({
    title: row.title ?? '',
    url: row.url ?? '',
    snippet: row.content ?? '',
    publishedAt: row.published_date ?? '',
    source: 'tavily',
  }));
}

async function serperSearch(query: string, limit: number, key: string, timeoutMs?: number): Promise<WebSearchResult[]> {
  const response = await httpRequest('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: limit }),
    cacheTtlMs: SEARCH_TTL_MS,
    cacheKey: `serper:${query}:${limit}`,
    timeoutMs,
  });
  if (!response.ok) throw new Error(`Serper HTTP ${response.status}`);
  const json = JSON.parse(response.text) as { organic?: Array<{ title?: string; link?: string; snippet?: string; date?: string }> };
  return (json.organic ?? []).slice(0, limit).map((row) => ({
    title: row.title ?? '',
    url: row.link ?? '',
    snippet: row.snippet ?? '',
    publishedAt: row.date ?? '',
    source: 'serper',
  }));
}

async function braveSearch(query: string, limit: number, key: string, timeoutMs?: number): Promise<WebSearchResult[]> {
  const json = await fetchJsonWithHeaders<{ web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> } }>(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
    { Accept: 'application/json', 'X-Subscription-Token': key },
    `brave:${query}:${limit}`,
    timeoutMs,
  );
  return (json.web?.results ?? []).slice(0, limit).map((row) => ({
    title: row.title ?? '',
    url: row.url ?? '',
    snippet: row.description ?? '',
    publishedAt: row.age ?? '',
    source: 'brave',
  }));
}

async function fetchJsonWithHeaders<T>(url: string, headers: Record<string, string>, cacheKey: string, timeoutMs?: number): Promise<T> {
  const response = await httpRequest(url, { headers, cacheTtlMs: SEARCH_TTL_MS, cacheKey, timeoutMs });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return JSON.parse(response.text) as T;
}

/* ──────────────────────────────── entrypoint ─────────────────────────────── */

/**
 * Runs the search provider chain, recording every failure as a warning so the
 * agent (and the UI) can tell "no results" apart from "source unreachable".
 *
 * Results are relevance-gated (see `rankByRelevance`): this network's Bing
 * sometimes serves an unrelated SERP, which must never be fed to the model as if
 * it answered the query. Final fallback is Eastmoney's finance-news search.
 */
export async function webSearch(query: string, options: WebSearchOptions = {}): Promise<WebSearchResponse> {
  const q = query.trim();
  const limit = Math.max(1, Math.min(options.limit ?? 6, 20));
  if (!q) return { results: [], source: 'bing', warnings: ['web_search 需要非空关键词'] };
  const providers = options.providers?.length ? options.providers : ZERO_KEY_SEARCH_CHAIN;
  const keys = options.keys ?? {};
  const warnings: string[] = [];

  for (const provider of providers) {
    try {
      let raw: WebSearchResult[] = [];
      switch (provider) {
        case 'tavily': {
          const key = keys.tavily ?? '';
          if (!key) {
            warnings.push('tavily 未配置 API Key，跳过');
            continue;
          }
          raw = await tavilySearch(q, limit, key, options.timeoutMs);
          break;
        }
        case 'serper': {
          const key = keys.serper ?? '';
          if (!key) {
            warnings.push('serper 未配置 API Key，跳过');
            continue;
          }
          raw = await serperSearch(q, limit, key, options.timeoutMs);
          break;
        }
        case 'brave': {
          const key = keys.brave ?? '';
          if (!key) {
            warnings.push('brave 未配置 API Key，跳过');
            continue;
          }
          raw = await braveSearch(q, limit, key, options.timeoutMs);
          break;
        }
        case 'duckduckgo': {
          raw = await duckSearch(q, limit, options.timeoutMs);
          break;
        }
        case 'bing':
        default: {
          raw = await bingSearch(q, limit, options.timeoutMs);
          break;
        }
      }

      const relevant = rankByRelevance(raw, q);
      if (relevant.length > 0) {
        return { results: relevant.slice(0, limit), source: provider === 'bing' ? 'bing' : provider, warnings };
      }
      if (raw.length > 0) {
        warnings.push(
          `${provider} 返回 ${raw.length} 条结果但与查询词不相关（该网络下结果质量不稳定），已降级；建议在设置中配置 Tavily / Serper / Brave Key`,
        );
      } else {
        warnings.push(`${provider} 无结果，降级`);
      }
    } catch (error) {
      warnings.push(`${provider} 搜索失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Last resort: Eastmoney finance-news search (relevant, but news-only).
  try {
    const news = await newsSearch(q, limit);
    if (news.length > 0) {
      warnings.push('联网搜索不可用或结果不相关，已降级为东方财富资讯检索（仅财经新闻，来源见每条结果）');
      return {
        results: news.map((item) => ({
          title: item.title,
          url: item.url,
          snippet: item.summary,
          publishedAt: item.publishedAt,
          source: item.source,
        })),
        source: 'eastmoney-news',
        warnings,
      };
    }
  } catch (error) {
    warnings.push(`资讯兜底失败：${error instanceof Error ? error.message : String(error)}`);
  }

  return { results: [], source: providers[0] ?? 'bing', warnings };
}

/** Fetches a page and extracts its readable text, capped to avoid token blow-ups. */
export async function fetchUrl(url: string, maxChars = 8000): Promise<FetchedPage> {
  const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const response = await httpRequest(normalized, {
    headers: { Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8' },
    cacheTtlMs: PAGE_TTL_MS,
    cacheKey: `page:${normalized}`,
  });
  if (!response.ok) throw new Error(`抓取失败：HTTP ${response.status} (${normalized})`);
  const text = response.text;
  const contentType = response.headers.get('content-type') ?? '';
  let title = '';
  let plain: string;
  if (contentType.includes('application/json') || /^\s*[[{]/.test(text)) {
    try {
      plain = JSON.stringify(JSON.parse(text), null, 1);
    } catch {
      plain = text;
    }
  } else {
    const extracted = htmlToText(text);
    title = extracted.title;
    plain = extracted.text;
  }
  if (!plain.trim()) {
    plain = htmlToText(text).text;
  }
  const truncated = plain.length > maxChars;
  return {
    url: normalized,
    title,
    text: truncated ? `${plain.slice(0, maxChars)}\n…(已截断，共 ${plain.length} 字)` : plain,
    truncated,
  };
}

/** Plain text fetch with no parsing (used by diagnostics). */
export async function fetchRaw(url: string, timeoutMs?: number): Promise<string> {
  return tryText(url, { timeoutMs, cacheTtlMs: 0 });
}
