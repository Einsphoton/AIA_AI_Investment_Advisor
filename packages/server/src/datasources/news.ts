/**
 * 东方财富资讯检索 provider — zero-key finance news search.
 *
 * `search-api-web.eastmoney.com/search/jsonp?...` returns JSONP:
 *   cb({ result: { cmsArticleWebOld: [{ date, title, content, mediaName, url }] } })
 * Verified 2026-10-14 (docs/SOURCES.md §4).
 *
 * Owner: agent-engine.
 */
import type { NewsItem, SourceId } from '@aia/shared';
import { httpText, isoOrNull, tryText } from './http.js';

const SOURCE: SourceId = 'eastmoney-news';
const NEWS_TTL_MS = 10 * 60_000;

interface CmsArticle {
  date?: unknown;
  title?: unknown;
  content?: unknown;
  mediaName?: unknown;
  url?: unknown;
}

interface NewsPayload {
  result?: { cmsArticleWebOld?: CmsArticle[] | null } | null;
}

function stripTags(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseJsonp(text: string): NewsPayload | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as NewsPayload;
  } catch {
    return null;
  }
}

/**
 * Keyword news search. An empty keyword returns the latest market headlines
 * (keyword defaults to 股市) so `MacroSnapshot.news` is never empty.
 */
export async function newsSearch(query: string, limit = 8): Promise<NewsItem[]> {
  const keyword = query.trim() || '股市';
  const pageSize = Math.max(1, Math.min(limit, 30));
  const param = {
    uid: '',
    keyword,
    type: ['cmsArticleWebOld'],
    client: 'web',
    clientType: 'web',
    clientVersion: 'curr',
    param: {
      cmsArticleWebOld: {
        searchScope: 'default',
        sort: 'time',
        pageIndex: 1,
        pageSize,
        preTag: '',
        postTag: '',
      },
    },
  };
  const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=${encodeURIComponent(JSON.stringify(param))}`;
  const text = await tryText(url, {
    headers: { Referer: 'https://so.eastmoney.com/' },
    cacheTtlMs: NEWS_TTL_MS,
    cacheKey: `news:${keyword}:${pageSize}`,
  });
  if (!text) return [];
  const payload = parseJsonp(text);
  const rows = payload?.result?.cmsArticleWebOld ?? [];
  const items: NewsItem[] = [];
  for (const row of rows) {
    const title = typeof row.title === 'string' ? stripTags(row.title) : '';
    const link = typeof row.url === 'string' ? row.url : '';
    if (!title || !link) continue;
    items.push({
      title,
      url: link,
      summary: typeof row.content === 'string' ? stripTags(row.content).slice(0, 400) : '',
      publishedAt: isoOrNull(typeof row.date === 'string' ? row.date : null) ?? (typeof row.date === 'string' ? row.date : ''),
      source: typeof row.mediaName === 'string' && row.mediaName ? stripTags(row.mediaName) : '东方财富',
    });
    if (items.length >= pageSize) break;
  }
  return items;
}

/** Raw JSONP body (diagnostics). */
export async function newsRaw(url: string): Promise<string> {
  return httpText(url, { headers: { Referer: 'https://so.eastmoney.com/' } });
}

export { SOURCE as NEWS_SOURCE };
