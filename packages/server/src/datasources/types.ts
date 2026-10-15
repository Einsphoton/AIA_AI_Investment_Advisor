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
