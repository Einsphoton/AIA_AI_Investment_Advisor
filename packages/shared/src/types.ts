/**
 * @aia/shared — frozen cross-package contract (server ⇄ web).
 *
 * RULES
 *  - This file is the single source of truth for HTTP payload shapes.
 *  - Only type-only exports live here; runtime constants are in ./constants.ts.
 *  - Never import server- or DOM-only code here.
 */

/* ────────────────────────────── enums / unions ────────────────────────────── */

/** Market codes. CN = A股, HK = 港股, US = 美股. */
export type Market = 'CN' | 'HK' | 'US';

/** Tradable instrument kinds covered by the app. */
export type InstrumentType = 'stock' | 'etf' | 'fund';

/** Who created the record. */
export type Creator = 'manual' | 'ai';

/** 投资性格 */
export type Persona =
  | 'steady'      // 稳健型
  | 'aggressive'  // 激进型
  | 'value'       // 价值型
  | 'income'      // 収息型
  | 'balanced'    // 均衡型
  | 'shortterm';  // 短线交易型

/** AI 报告风格 */
export type ReportStyle = 'professional' | 'beginner';

/** Advice direction. */
export type AdviceAction = 'buy' | 'sell';

/** Advice lifecycle. */
export type AdviceStatus = 'pending' | 'confirmed' | 'rejected' | 'expired';

/** Transaction direction. */
export type TxKind = 'buy' | 'sell';

/** Origin of a transaction record. */
export type TxSource = 'manual' | 'ai' | 'advice';

/** Kind of autonomous agent run. */
export type AgentRunKind =
  | 'asset-analysis'
  | 'watchlist-analysis'
  | 'advice'
  | 'chat'
  | 'scheduled'
  | 'custom';

export type AgentRunStatus = 'running' | 'done' | 'error';

export type StepStatus = 'pending' | 'running' | 'done' | 'error';

/** Series granularity used by charts. */
export type RangeKey = '1m' | '3m' | '6m' | '1y' | '3y' | '5y' | 'max';

export type BarInterval = 'day' | 'week' | 'month';

/** Which underlying source produced a datum (shown in the UI / logs). */
export type SourceId =
  | 'eastmoney'
  | 'tencent'
  | 'eastmoney-fund'
  | 'eastmoney-macro'
  | 'eastmoney-news'
  | 'bing'
  | 'duckduckgo'
  | 'tavily'
  | 'serper'
  | 'brave'
  | 'yahoo'
  | 'stooq'
  | 'finnhub'
  | 'alphavantage'
  | 'fmp'
  | 'synthetic';

/* ──────────────────────────────── settings ────────────────────────────────── */

export interface DataSourceChoice {
  /** 'auto' = use the built-in priority chain; otherwise pin one SourceId. */
  provider: SourceId | 'auto';
  /**
   * REQUESTS ONLY — the stored key is never returned by the API.
   * Tri-state on write: omitted/'' = keep, null = clear, non-empty = overwrite.
   */
  apiKey?: string;
  /** Whether this slot is usable (auto chain, or a pinned provider with a key). */
  enabled: boolean;
  /** RESPONSE ONLY — a key is stored for this slot. */
  hasApiKey?: boolean;
  /** RESPONSE ONLY — masked placeholder; never contains the real key. */
  apiKeyMasked?: string;
}

export interface DataSourceConfig {
  /** 'stock:CN' | 'stock:HK' | 'stock:US' | 'fund:CN' | 'fund:HK' | 'fund:US' */
  stockCN: DataSourceChoice;
  stockHK: DataSourceChoice;
  stockUS: DataSourceChoice;
  fundCN: DataSourceChoice;
  fundHK: DataSourceChoice;
  fundUS: DataSourceChoice;
  /** Web search configuration used by the agent's research tools. */
  webSearch: DataSourceChoice;
}

export interface BudgetConfig {
  /** Monthly budget per market, expressed in that market's own currency. */
  CN: number;
  HK: number;
  US: number;
}

export type ScheduleMode = 'off' | 'interval' | 'daily';

export interface ScheduleConfig {
  mode: ScheduleMode;
  /** Minutes between runs when mode === 'interval'. */
  intervalMinutes: number;
  /** 'HH:mm' local time when mode === 'daily'. */
  dailyTime: string;
  /** Run the full pipeline (asset analysis → watchlist analysis → advice). */
  runAssetAnalysis: boolean;
  runWatchlistAnalysis: boolean;
  runAdvice: boolean;
}

export interface LlmConfig {
  /** OpenAI-compatible chat-completions base URL, e.g. https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  /** Optional second-stage model for cheap sub-tasks; empty = use `model`. */
  fastModel: string;
  /** Per-request timeout in ms. */
  timeoutMs: number;
  /**
   * Context budget in tokens. The agent compacts history before each turn so a
   * request never exceeds this estimate (P0 context governance).
   */
  contextTokens: number;
}

/** How dangerous a tool is. Drives policy, audit level and approval prompts. */
export type ToolRisk = 'read' | 'external' | 'write';

/** Per-tool authorisation policy (settings → 工具策略). */
export interface ToolPolicy {
  /** Tool names that the agent must never call; the model gets a structured denial. */
  deny: string[];
  /**
   * When true, mutating tools are **not** executed immediately: the call is
   * stored as a `PendingWrite` and the model is told it awaits approval.
   */
  requireWriteApproval: boolean;
}

/** One external MCP (Model Context Protocol) server. */
export interface McpServerConfig {
  id: string;
  name: string;
  /** 'stdio' spawns `command args…`; 'http' posts JSON-RPC to `url`. */
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Only used when transport === 'http'. */
  url: string;
  enabled: boolean;
}

export interface Settings {
  persona: Persona;
  reportStyle: ReportStyle;
  llm: LlmConfig;
  /** True when an API key is stored (the key itself is never returned over HTTP). */
  hasApiKey: boolean;
  /** Masked preview, e.g. `sk-****abcd`. */
  apiKeyMasked: string;
  dataSources: DataSourceConfig;
  budget: BudgetConfig;
  schedule: ScheduleConfig;
  /** Whether budget enforcement blocks new buy advice. */
  enforceBudget: boolean;
  /** Max number of watchlist candidates the agent may create per run. */
  watchlistCandidateLimit: number;
  /**
   * 连续多少次分析仍被标记退役后，流水线才真正删除该标的；0 = 永不自动删除。
   * 有持仓 / 人工录入 / 有待处理建议的标的即使达到次数也不会被删除（见 ARCHITECTURE §4.3.2）。
   */
  watchlistRetireDeleteRuns: number;
  /** Tool authorisation policy (deny list + write-approval mode). */
  toolPolicy: ToolPolicy;
  /** Configured MCP servers (may be empty). */
  mcpServers: McpServerConfig[];
  updatedAt: string;
}

/** Partial update accepted by `PUT /api/settings`. */
export interface SettingsInput {
  persona?: Persona;
  reportStyle?: ReportStyle;
  llm?: Partial<LlmConfig>;
  dataSources?: Partial<DataSourceConfig>;
  budget?: Partial<BudgetConfig>;
  schedule?: Partial<ScheduleConfig>;
  enforceBudget?: boolean;
  watchlistCandidateLimit?: number;
  watchlistRetireDeleteRuns?: number;
  toolPolicy?: Partial<ToolPolicy>;
  mcpServers?: McpServerConfig[];
  /** Send an empty string to keep the stored key; send null to clear it. */
  apiKey?: string | null;
}

/* ─────────────────────── agent governance (P1) ────────────────────────────── */

/** One entry of the write/execution audit trail (`GET /api/agent/audit`). */
export interface AuditEntry {
  id: string;
  at: string;
  runId: string | null;
  sessionId: string | null;
  tool: string;
  risk: ToolRisk;
  /** 'executed' | 'denied' | 'deferred' | 'failed' */
  outcome: 'executed' | 'denied' | 'deferred' | 'failed';
  entity: string | null;
  entityId: string | null;
  summary: string;
  /** Truncated tool arguments (JSON). */
  args: string;
}

export type PendingWriteStatus = 'pending' | 'approved' | 'rejected' | 'failed';

/** A mutating tool call waiting for human approval (`toolPolicy.requireWriteApproval`). */
export interface PendingWrite {
  id: string;
  runId: string | null;
  sessionId: string | null;
  tool: string;
  args: string;
  summary: string;
  risk: ToolRisk;
  status: PendingWriteStatus;
  createdAt: string;
  decidedAt: string | null;
  /** Result summary after approve/reject. */
  result: string | null;
}

/** One persisted message of a run, enabling resume + trajectory replay. */
export interface RunMessage {
  id: string;
  runId: string;
  index: number;
  role: ChatRole;
  content: string;
  toolCalls: string | null;
  toolCallId: string | null;
  name: string | null;
  createdAt: string;
}

/** Full trajectory of a run (`GET /api/agent/runs/:id/trace`). */
export interface AgentTrace {
  run: AgentRun;
  messages: RunMessage[];
  steps: AgentStep[];
  audit: AuditEntry[];
  pendingWrites: PendingWrite[];
}


export interface DataSourceCatalogueEntry {
  id: SourceId;
  name: string;
  markets: Market[];
  kinds: InstrumentType[];
  requiresKey: boolean;
  /** Higher runs first in the automatic fallback chain. */
  priority: number;
  notes: string;
  /** Live reachability probe result, filled by `GET /api/settings/data-sources`. */
  status?: 'unknown' | 'ok' | 'error';
}

/* ──────────────────────────────── portfolio ───────────────────────────────── */

export interface Transaction {
  id: string;
  assetId: string;
  kind: TxKind;
  shares: number;
  price: number;
  fee: number;
  /** Cash value of the trade (shares * price), signed by kind. */
  amount: number;
  tradeDate: string; // YYYY-MM-DD
  note: string;
  source: TxSource;
  createdAt: string;
}

export interface PositionMath {
  shares: number;
  /** Weighted-average cost per share of the currently open position. */
  avgCost: number;
  /** Total cost basis of the open position (shares * avgCost). */
  cost: number;
  realizedPnl: number;
}

export interface AssetSummary extends PositionMath {
  id: string;
  name: string;
  code: string;
  market: Market;
  type: InstrumentType;
  source: Creator;
  currency: string;
  /** Latest price; 0 when unavailable. */
  price: number;
  priceAt: string | null;
  /** price * shares (0 when price unavailable). */
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  dayChange: number;
  dayChangePct: number;
  firstBuyAt: string | null;
  lastBuyAt: string | null;
  lastSellAt: string | null;
  note: string;
  aiSummary: string;
  aiSummaryAt: string | null;
  /** Compact close series for the list sparkline (oldest → newest). */
  spark: number[];
  createdAt: string;
  /** true when the position has been fully closed (shares <= 0). */
  closed: boolean;
}

export interface AssetDetail extends AssetSummary {
  transactions: Transaction[];
}

export interface CreateAssetInput {
  code: string;
  market: Market;
  type: InstrumentType;
  /** Optional: resolved from the market data source when omitted. */
  name?: string;
  shares: number;
  price: number;
  tradeDate: string;
  note?: string;
  fee?: number;
  source?: Creator;
}

export interface UpdateAssetInput {
  name?: string;
  note?: string;
  market?: Market;
  type?: InstrumentType;
}

export interface CreateTransactionInput {
  kind: TxKind;
  shares: number;
  price: number;
  tradeDate: string;
  note?: string;
  fee?: number;
  source?: TxSource;
}

/* ──────────────────────────────── watchlist ───────────────────────────────── */

/**
 * 自选池状态（P3 淘汰机制）。
 *
 * active  = 在池，参与建议生成与候选挖掘；
 * retired = AI 认为已不适合继续作为标的（原因见 `retiredReason`），
 *           默认不在列表展示，但仍保留历史与「推荐后涨跌」复盘。
 *
 * 只有连续 `settings.watchlistRetireDeleteRuns` 次分析都确认退役、且未命中
 * 持仓 / 人工录入 / 待处理建议等护栏时，流水线才会真正删除（见 ARCHITECTURE §4.3.2）。
 */
export type WatchItemStatus = 'active' | 'retired';

export interface WatchItem {
  id: string;
  name: string;
  code: string;
  market: Market;
  type: InstrumentType;
  source: Creator;
  /** 优质评估 0–100 produced by the agent. */
  qualityScore: number;
  targetPrice: number;
  /** Expected return in percent, e.g. 25 means +25%. */
  expectedReturn: number;
  /** Price when the item was added, used for "推荐后涨跌". */
  initialPrice: number;
  initialPriceAt: string | null;
  price: number;
  priceAt: string | null;
  changeSinceAdded: number;
  changeSinceAddedPct: number;
  dayChangePct: number;
  note: string;
  aiSummary: string;
  aiSummaryAt: string | null;
  /** Short thesis / key points produced by the agent. */
  thesis: string;
  spark: number[];
  createdAt: string;
  /** active（在池）/ retired（AI 已判定不适合，等待复活或清理）。 */
  status: WatchItemStatus;
  /** Why the agent retired it (latest reason). */
  retiredReason: string;
  /** When it was last confirmed as retired (ISO 8601); null while active. */
  retiredAt: string | null;
  /** Consecutive analyses that confirmed the retirement; reset when revived. */
  retireStreak: number;
}

export interface WatchlistDetail extends WatchItem {
  /** Position info when the user also holds this instrument (may be null). */
  holding: AssetSummary | null;
  transactions: Transaction[];
  dividends: DividendItem[];
}

export interface CreateWatchItemInput {
  code: string;
  market: Market;
  type: InstrumentType;
  name?: string;
  note?: string;
}

export interface UpdateWatchItemInput {
  note?: string;
  qualityScore?: number;
  targetPrice?: number;
  expectedReturn?: number;
  thesis?: string;
}

/* ───────────────────────────────── advice ─────────────────────────────────── */

export interface AdviceItem {
  id: string;
  batchId: string;
  assetId: string | null;
  watchItemId: string | null;
  assetName: string;
  code: string;
  market: Market;
  type: InstrumentType;
  action: AdviceAction;
  targetShares: number;
  targetPrice: number;
  /** Cash value implied by targetShares * targetPrice. */
  amount: number;
  currency: string;
  reason: string;
  /** 0–1 confidence reported by the agent. */
  confidence: number;
  status: AdviceStatus;
  createdAt: string;
  decidedAt: string | null;
  /** Filled when the advice was confirmed into the portfolio. */
  executedShares: number | null;
  executedPrice: number | null;
}

export interface ConfirmAdviceInput {
  shares: number;
  price: number;
  tradeDate?: string;
  fee?: number;
}

export interface MarketBudgetStatus {
  market: Market;
  currency: string;
  budget: number;
  spent: number;
  remaining: number;
  /** remaining <= 0 */
  exhausted: boolean;
  /** Percent of budget consumed, 0–100+. */
  usedPct: number;
}

export interface BudgetStatus {
  /** YYYY-MM. */
  month: string;
  markets: MarketBudgetStatus[];
}

/* ─────────────────────────────── dashboard ────────────────────────────────── */

export interface DashboardPortfolio {
  marketValue: number;
  cost: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  realizedPnl: number;
  /** Valuation currency for the aggregate figures (CNY by default). */
  currency: string;
  dayChange: number;
  dayChangePct: number;
  /** Rates used for conversion into `currency`, keyed by source currency. */
  fxRates: Record<string, number>;
}

export interface DashboardCounts {
  holdings: number;
  instruments: number;
  watchItems: number;
  /** 已退役（AI 判定不适合，待复活或清理）的标的数量，不计入 `watchItems`。 */
  retiredWatchItems: number;
  newWatchItems: number;
  pendingAdvice: number;
  newAdvice: number;
  analysisRuns: number;
  lastRunAt: string | null;
}

export interface DashboardBriefing {
  text: string;
  generatedAt: string;
  runId: string | null;
  persona: Persona;
  reportStyle: ReportStyle;
}

export interface DashboardSignals {
  watchlistChanged: boolean;
  adviceChanged: boolean;
  priceStale: boolean;
  scheduleEnabled: boolean;
  nextRunAt: string | null;
}

export interface DashboardPayload {
  portfolio: DashboardPortfolio;
  counts: DashboardCounts;
  topHoldings: AssetSummary[];
  briefing: DashboardBriefing | null;
  signals: DashboardSignals;
  budget: BudgetStatus;
  indices: Quote[];
  updatedAt: string;
}

/* ──────────────────────────────── market data ─────────────────────────────── */

export interface Quote {
  code: string;
  market: Market;
  name: string;
  currency: string;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  change: number;
  changePct: number;
  volume: number;
  amount: number;
  turnoverRate: number;
  marketCap: number;
  floatMarketCap: number;
  pe: number;
  peTtm: number;
  pb: number;
  roe: number;
  revenue: number;
  industry: string;
  updatedAt: string;
  source: SourceId;
}

export interface SeriesPoint {
  /** YYYY-MM-DD. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** NAV-specific: accumulated NAV. */
  accumNav?: number;
}

export interface SeriesResponse {
  code: string;
  market: Market;
  type: InstrumentType;
  /** 'kline' for stocks/ETFs, 'nav' for open-end funds. */
  kind: 'kline' | 'nav';
  interval: BarInterval;
  range: RangeKey;
  currency: string;
  name: string;
  points: SeriesPoint[];
  sources: SourceId[];
  /** Non-fatal problems encountered while assembling the series. */
  warnings: string[];
}

export interface FundamentalMetric {
  key: string;
  label: string;
  value: number;
  unit: string;
  /** Year-over-year change in percent, when available. */
  yoy?: number;
  /** Report period the metric belongs to. */
  period?: string;
}

export interface Fundamentals {
  code: string;
  market: Market;
  name: string;
  reportDate: string | null;
  reportType: string | null;
  metrics: FundamentalMetric[];
  /** Peer/industry context lines, already formatted for display. */
  highlights: string[];
  sources: SourceId[];
}

export interface FundHolding {
  code: string;
  name: string;
  weight: number;
}

export interface FundInfo {
  code: string;
  name: string;
  type: string;
  manager: string;
  company: string;
  inceptionDate: string | null;
  scale: number;
  feeRate: number;
  nav: number;
  navDate: string | null;
  accumNav: number;
  /** Trailing returns in percent. */
  returns: { label: string; value: number }[];
  holdings: FundHolding[];
  /** Top-level asset allocation in percent. */
  allocation: { label: string; value: number }[];
  sources: SourceId[];
}

export interface DividendItem {
  /** 除权除息日 */
  exDate: string | null;
  /** 股权登记日 */
  recordDate: string | null;
  /** 派息日 */
  payDate: string | null;
  /** Cash dividend per share (pre-tax), in the instrument currency. */
  cashPerShare: number;
  /** Raw plan text, e.g. "10派25.911元". */
  plan: string;
  period: string;
}

export interface ProfileResponse {
  quote: Quote | null;
  fundamentals: Fundamentals | null;
  fundInfo: FundInfo | null;
  dividends: DividendItem[];
  sources: SourceId[];
  warnings: string[];
}

export interface MacroItem {
  key: string;
  label: string;
  value: number;
  unit: string;
  period: string;
  yoy: number | null;
}

export interface MacroSnapshot {
  items: MacroItem[];
  indices: Quote[];
  news: NewsItem[];
  updatedAt: string;
  warnings: string[];
}

export interface NewsItem {
  title: string;
  url: string;
  summary: string;
  publishedAt: string;
  source: string;
}

export interface InstrumentSearchResult {
  code: string;
  name: string;
  market: Market;
  type: InstrumentType;
  /** Exchange / board label, e.g. 沪A, 纳斯达克, 港交所. */
  exchange: string;
  source: SourceId;
}

/* ──────────────────────────────── agent runs ──────────────────────────────── */

export interface AgentStep {
  id: string;
  runId: string;
  index: number;
  /** Human-readable label shown in the UI timeline. */
  label: string;
  status: StepStatus;
  detail: string;
  toolName: string | null;
  /** JSON-encoded tool arguments (truncated). */
  toolArgs: string | null;
  /** Truncated tool result summary. */
  toolResult: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AgentRun {
  id: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  /** Which entity triggered the run, when applicable. */
  target: string | null;
  title: string;
  summary: string;
  error: string | null;
  /** Number of LLM turns consumed. */
  turns: number;
  promptTokens: number;
  completionTokens: number;
  startedAt: string;
  finishedAt: string | null;
  steps: AgentStep[];
}

export interface AgentRunSummary {
  id: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  title: string;
  summary: string;
  error: string | null;
  turns: number;
  stepCount: number;
  startedAt: string;
  finishedAt: string | null;
}

/* ───────────────────────────────── chat ───────────────────────────────────── */

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatRole;
  content: string;
  /** JSON-encoded tool calls attached to an assistant message. */
  toolCalls: string | null;
  toolCallId: string | null;
  /** Steps produced while answering this message. */
  steps: AgentStep[];
  createdAt: string;
  runId: string | null;
}

/* ────────────────────────────── SSE event contract ────────────────────────── */

/**
 * Inference metrics of one LLM request inside an agent run (`metrics` event).
 *
 * Every agent turn issues exactly one `/chat/completions` request, and the
 * server reports it in two phases:
 *   · `first-token` — the stream just produced its first delta; only `ttftMs` is
 *     known yet, usage counters are still 0 (the panel can show 首字延迟 live);
 *   · `done`        — the request finished; usage, cache hits and speed are final.
 *
 * Counters are per request (never cumulative): a client that wants totals for a
 * whole run/pipeline must sum the `done` events it received.
 */
export interface InferenceMetrics {
  phase: 'first-token' | 'done';
  /** 1-based agent turn this request belongs to. */
  turn: number;
  /** Model actually reported by the provider (falls back to the configured one). */
  model: string;
  /** Time to first token (ms); null when the provider answered non-streamed. */
  ttftMs: number | null;
  /** Total request wall time (ms); null while the request is still streaming. */
  latencyMs: number | null;
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from the provider's prompt/KV cache. */
  cachedTokens: number;
  /** completionTokens / generation seconds; null until the request ends. */
  tokensPerSecond: number | null;
}

/**
 * Wire format (both analysis endpoints and chat):
 *   `event: <type>\n` + `data: <json>\n\n`
 * The `data` payload is always the corresponding AgentEvent object.
 */
export type AgentEvent =
  | { type: 'run-started'; runId: string; kind: AgentRunKind; title: string }
  | { type: 'step'; step: AgentStep }
  | { type: 'progress'; runId: string; done: number; total: number; label: string }
  | { type: 'text'; runId: string | null; delta: string }
  | { type: 'metrics'; runId: string; metrics: InferenceMetrics }
  | { type: 'tool-call'; runId: string | null; id: string; name: string; args: unknown }
  | { type: 'tool-result'; runId: string | null; id: string; name: string; ok: boolean; summary: string }
  | {
      type: 'entity';
      runId: string;
      action: 'created' | 'updated' | 'deleted';
      entity: 'asset' | 'watchlist' | 'advice' | 'briefing' | 'settings';
      id: string;
      label: string;
    }
  | { type: 'budget'; runId: string; budget: BudgetStatus }
  | { type: 'run-finished'; runId: string; status: AgentRunStatus; summary: string; error: string | null }
  | { type: 'error'; message: string }
  | { type: 'done' };

export type AgentEventType = AgentEvent['type'];

export const AGENT_EVENT_TYPES: AgentEventType[] = [
  'run-started',
  'step',
  'progress',
  'text',
  'metrics',
  'tool-call',
  'tool-result',
  'entity',
  'budget',
  'run-finished',
  'error',
  'done',
];

/* ─────────────────────────────── backup / restore ─────────────────────────── */

export interface BackupPayload {
  schema: 'ai-investment-advisor/backup';
  version: number;
  exportedAt: string;
  appVersion: string;
  assets: AssetSummary[];
  transactions: Transaction[];
  watchlist: WatchItem[];
  advice: AdviceItem[];
  runs?: AgentRunSummary[];
  settings?: Omit<Settings, 'llm'> & { llm: Omit<LlmConfig, 'apiKey'> };
}

export interface ImportResult {
  assets: number;
  transactions: number;
  watchlist: number;
  advice: number;
  skipped: number;
  mode: ImportMode;
}

export type ImportMode = 'merge' | 'replace';

/* ───────────────────────────────── errors ─────────────────────────────────── */

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ListResponse<T> {
  items: T[];
  total: number;
}

/** `GET /api/watchlist` — 列表 + 在池/已退役计数（不受筛选影响）。 */
export interface WatchlistListResponse extends ListResponse<WatchItem> {
  counts: { active: number; retired: number };
}
