/**
 * Internal datasource contracts (not part of the frozen HTTP contract).
 *
 * Owner: agent-engine.
 */
import type {
  BarInterval,
  DividendItem,
  Fundamentals,
  FundInfo,
  InstrumentType,
  MacroItem,
  Market,
  NewsItem,
  ProfileResponse,
  Quote,
  RangeKey,
  SeriesResponse,
  SourceId,
} from '@aia/shared';

/** Which market/kind slot a request belongs to in `settings.dataSources`. */
export type DataSourceSlot = 'stockCN' | 'stockHK' | 'stockUS' | 'fundCN' | 'fundHK' | 'fundUS';

export interface InstrumentRef {
  code: string;
  market: Market;
  type: InstrumentType;
}

export interface ResolvedInstrument extends InstrumentRef {
  name: string;
  currency: string;
  exchange: string;
  source: SourceId;
}

export interface SeriesQuery extends InstrumentRef {
  range: RangeKey;
  interval: BarInterval;
  /** Receives the degradation notes even when every provider fails. */
  onWarnings?: (warnings: string[]) => void;
}

/** A provider attempt result with provenance + degradation notes. */
export interface Sourced<T> {
  value: T;
  sources: SourceId[];
  warnings: string[];
}

/* ───────────────────────────── 新股打新 (IPO) ─────────────────────────────── */

/**
 * 上游抓到的一只新股（**未落库**）。
 *
 * 刻意不带 `id`/`uid`/AI 结论：这些是本地概念（uid 由 `services/ipo.ts` 按
 * `market:code` 生成，AI 结论由打新分析写入），数据源只负责「上游有什么」。
 */
export interface IpoOfferDraft {
  market: Market;
  /** 上市交易代码；上游未给时为空串（落库时用申购代码兜底生成 uid）。 */
  code: string;
  subscribeCode: string;
  name: string;
  source: SourceId;
  exchange: string;
  board: string;
  issuePrice: number;
  priceLow: number;
  priceHigh: number;
  currency: string;
  lotSize: number;
  maxShares: number;
  subscribeStart: string | null;
  subscribeEnd: string | null;
  allotmentDate: string | null;
  listingDate: string | null;
  issueShares: number;
  raiseAmount: number;
  issuePe: number;
  industryPe: number;
  winningRate: number;
  oversubscribe: number;
  sponsor: string;
  industry: string;
  prospectusUrl: string;
}

/** 一次打新数据收集的结果（逐市场给计数与问题，便于界面显示哪个源挂了）。 */
export interface IpoCollectResult {
  offers: IpoOfferDraft[];
  sources: SourceId[];
  /** 真实故障/降级（例如「港交所接口超时」）。 */
  warnings: string[];
  byMarket: { market: Market; count: number; sources: SourceId[] }[];
}

export interface ProviderQuote {
  quote: Quote;
  source: SourceId;
}

export interface ProviderSeries {
  series: SeriesResponse;
  source: SourceId;
}

export interface ProviderProfile {
  quote: Quote | null;
  fundamentals: Fundamentals | null;
  fundInfo: FundInfo | null;
  dividends: DividendItem[];
  sources: SourceId[];
  warnings: string[];
}

export interface MacroBundle {
  items: MacroItem[];
  indices: Quote[];
  /** Real failures / degradations only — every entry means something went wrong. */
  warnings: string[];
  /**
   * Known coverage gaps that are **not** failures (e.g. 社会融资规模 has no
   * zero-key upstream). Kept separate from `warnings` because a fixed note that
   * fired on every run made a healthy analysis look like an outage.
   */
  notes: string[];
}

export interface SearchOptions {
  market?: Market;
  limit?: number;
}

export interface SearchHit {
  code: string;
  name: string;
  market: Market;
  type: InstrumentType;
  exchange: string;
  source: SourceId;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string;
  source: string;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
  source: SourceId;
  warnings: string[];
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

export type { ProfileResponse };
