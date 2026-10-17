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

/**
 * Origin of a transaction record.
 *
 * `ipo` = 打新中签缴款自动入账（`POST /api/ipo/:id/allot`）：金额与份额由中签结果决定，
 * 与人工录入、AI 建议、建议确认区分开，便于在交易记录里追溯来源。
 */
export type TxSource = 'manual' | 'ai' | 'advice' | 'ipo';

/** Kind of autonomous agent run. */
export type AgentRunKind =
  | 'asset-analysis'
  | 'watchlist-analysis'
  | 'ipo-analysis'
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
  /** 东方财富新股数据：A股数据中心报表 + 港股新股列表页（零 Key）。 */
  | 'eastmoney-ipo'
  /** 經濟通 etnet 港股新股日历（零 Key，页面内嵌 JSON）。 */
  | 'etnet'
  /** 阿斯達克 AAStocks 港股新股列表（零 Key，HTML 表格）。 */
  | 'aastocks'
  /** 纳斯达克官方 IPO 日历（零 Key）。 */
  | 'nasdaq'
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

/**
 * 定时任务的触发方式。
 *
 * 这里**没有** `off`：整体开关已经取消，改为每个任务自己的 `enabled`
 * （停用后配置保留但不排程），因为用户可以并存多个任务。
 */
export type ScheduleMode = 'interval' | 'daily';

/**
 * 一个定时任务（`Settings.schedules[i]`）。
 *
 * 2026-10 之前这里是一个整体配置 `Settings.schedule`；现在改成数组，可以并存多个：
 * 例如「工作日 09:10 跑资产分析 + 投资建议」和「周日 20:00 只挖标的」互不干扰 ——
 * 每个任务自带触发方式与要跑的步骤，跑完只重排自己那一条。
 */
export interface ScheduleTask {
  /** 稳定 id（`sched_…`）：前端增删改与排程重载都靠它定位。 */
  id: string;
  /** 展示名，例如「工作日盘前」。 */
  name: string;
  /** 停用后配置保留、不再排程（等价于旧的 mode='off'，但按任务生效）。 */
  enabled: boolean;
  mode: ScheduleMode;
  /** mode='interval'：两次运行之间的分钟数（≥1，从上次跑完算起）。 */
  intervalMinutes: number;
  /** mode='daily'：本地时间 `HH:mm`。 */
  dailyTime: string;
  /** 该任务连带执行的流水线步骤；三项全关的任务会被服务端拒绝。 */
  runAssetAnalysis: boolean;
  runWatchlistAnalysis: boolean;
  /** 打新分析：对新股/次新股标的做财报 / 招股书 / 基本面与申购建议。 */
  runIpoAnalysis: boolean;
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
  /** 定时任务列表：每个任务独立触发、独立选择要跑的步骤。空数组 = 不排程。 */
  schedules: ScheduleTask[];
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
  /** 定时任务：**整体替换**（发送完整数组；省略该字段 = 保持不变）。 */
  schedules?: ScheduleTask[];
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
  /** 预期多久达到该收益，例如「6-12 个月」「1-3 年」；空串表示未标注。 */
  expectedReturnHorizon: string;
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
  /** 预期收益的到达期限（自由文本，例如「6-12 个月」）。 */
  expectedReturnHorizon?: string;
  thesis?: string;
}

/* ───────────────────────────────── advice ─────────────────────────────────── */

/**
 * 建议的来源：持仓（加仓/减仓）、我的标的（经标的分析的候选池）、
 * 池外（既非持仓也不在「我的标的」中）。
 */
export type AdviceOrigin = 'holding' | 'watchlist' | 'external';

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
  /**
   * 建议依据的池子。池外建议意味着它跳过了「AI 标的分析」的质量分门槛，
   * 界面上必须标出来，用户才知道该建议没经过候选池筛选。
   */
  origin: AdviceOrigin;
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

/* ── 建议结果追踪（确定性，不经过 LLM） ─────────────────────────────────────── */

/**
 * 一条建议的实际结果，全部由「建议日 → 今」的日线序列算出，可重复计算且幂等。
 *
 * 口径（必须显式写清，否则胜率会误导）：
 * - 基准价 = 建议日当日（或之后第一个交易日）的收盘价；标的一旦取不到序列即不可度量。
 * - `adviceReturnPct` 按方向调整：买入=涨幅，卖出=跌幅（正数代表「建议方向对」）。
 *   它衡量的是模型方向判断的准确度，**不是**用户真实盈亏（用户可能没执行）。
 * - `excessPct` 与同区间的基准指数（A股 沪深300 / 港股 盈富基金 / 美股 SPY）比较。
 */
export interface AdviceOutcome {
  adviceId: string;
  runId: string | null;
  code: string;
  market: Market;
  type: InstrumentType;
  action: AdviceAction;
  currency: string;
  /** 建议创建时间。 */
  advisedAt: string;
  /** 建议是否已被用户确认执行（仅作展示与筛选，不改变度量口径）。 */
  adviceStatus: AdviceStatus;
  executed: boolean;
  /** 度量起点（YYYY-MM-DD）：建议日或之后第一个交易日。 */
  baselineDate: string;
  baselinePrice: number;
  /** 最新观测日与收盘价。 */
  lastDate: string;
  lastPrice: number;
  /** 原始价格变动 %，不做方向调整。 */
  priceChangePct: number;
  /** 方向调整后的收益 %：buy=+涨，sell=+跌。 */
  adviceReturnPct: number;
  benchmarkCode: string;
  benchmarkName: string;
  benchmarkBase: number;
  benchmarkChangePct: number;
  /** adviceReturnPct − benchmarkChangePct。 */
  excessPct: number;
  /** 区间内最大有利 / 最大不利（方向调整后，均为 %）。 */
  maxReturnPct: number;
  minReturnPct: number;
  /** 区间内的有效交易日数；< 2 表示还度量不了（如建议当天）。 */
  samples: number;
  daysTracked: number;
  status: AdviceOutcomeStatus;
  /** 取数失败等非致命问题，必须原样展示。 */
  warnings: string[];
  updatedAt: string;
}

/**
 * `tracking` 在观测窗口内持续更新；`expired` 表示窗口已满、数字冻结为最终结果。
 */
export type AdviceOutcomeStatus = 'tracking' | 'expired';

export interface AdviceOutcomeMarketStats {
  market: Market;
  measured: number;
  /** 方向正确（adviceReturnPct > 0）的比例，0–100。 */
  winRate: number;
  /** 跑赢基准（excessPct > 0）的比例，0–100。 */
  beatRate: number;
  avgReturnPct: number;
  avgExcessPct: number;
}

export interface AdviceOutcomeStats {
  /** 参与统计的建议总数（含不可度量项）。 */
  total: number;
  /** 可度量项：samples >= 2。 */
  measured: number;
  /** 不可度量项（样本不足或序列取不到）——必须显示，否则胜率会虚高。 */
  unmeasured: number;
  winRate: number;
  beatRate: number;
  avgReturnPct: number;
  avgExcessPct: number;
  byMarket: AdviceOutcomeMarketStats[];
  /** 观测窗口（自然日），超过即冻结为最终结果。 */
  windowDays: number;
  /** 最近一次成功追踪的时间；从未追踪过为 null。 */
  updatedAt: string | null;
  warnings: string[];
}

export interface AdviceOutcomesResponse {
  items: AdviceOutcome[];
  stats: AdviceOutcomeStats;
}

/** 一次追踪重算的结果（`POST /api/advice/outcomes/track`）。 */
export interface AdviceOutcomeTrackResult {
  /** 本次实际重算并写入的建议数。 */
  tracked: number;
  measured: number;
  unmeasurable: number;
  /** 已超出观测窗口、被冻结为最终结果的条数（本次未重算）。 */
  frozen: number;
  /** 清理掉的、对应建议已不存在的残留行。 */
  pruned: number;
  ranAt: string;
  warnings: string[];
}

export interface AdviceOutcomesTrackResponse extends AdviceOutcomesResponse {
  tracked: AdviceOutcomeTrackResult;
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

/* ─────────────────────────────── 新股打新 (IPO) ───────────────────────────── */

/**
 * 新股当前所处的市场阶段，由服务端按上游状态与日期确定性推导
 * （见 `services/ipo.ts` 的 `deriveIpoStatus`），**不是**上游直接给的字段。
 *
 * - `upcoming`    尚未开始招股/申购（或上游只给了「待发行」）
 * - `subscribing` 招股中 / 可申购（申购期未结束）
 * - `allotted`    已定价或已公布中签，等待上市
 * - `listed`      已上市
 * - `unknown`     上游没给足够日期，无法判断（不猜）
 */
export type IpoMarketStatus = 'upcoming' | 'subscribing' | 'allotted' | 'listed' | 'unknown';

/**
 * AI 对一只新股的申购倾向 —— 注意这是**本期是否执行**的综合判断，不是单纯的「股票好坏」：
 *
 * - `subscribe`：标的值得 + 本期可执行（预算够、能买至少一手）→ 必须给 suggestedShares > 0；
 * - `neutral`：标的不算差、但本期不执行，必须在 `verdictReason` 写清绑定的约束
 *   （最常见：本月该市场预算不足 / 一手入场费太贵 / 定价区间未收窄 / 等暗盘）→ suggestedShares 恒为 0；
 * - `avoid`：标的不值得（定价、基本面、破发风险）→ suggestedShares 恒为 0。
 *
 * 因此「胜率高但判 neutral」是完全合法的组合，但**必须**用理由说明是资金约束而不是看空；
 * 反过来 `avoid` 不允许出现在胜率≥60% 且预期收益为正的标的上（见 `save_ipo_analysis` 的一致性校验）。
 */
export type IpoAdviceVerdict = 'subscribe' | 'neutral' | 'avoid';

/** 我的申购记录状态：已登记申购 / 已中签（含入账）/ 未中签。 */
export type IpoSubscriptionStatus = 'applied' | 'allotted' | 'missed';

/**
 * 一只新股（打新标的）。
 *
 * 与 `watchlist` / `assets` 分开建表的原因：新股有「申购代码、招股区间、中签率、上市日」
 * 这些**只在发行期存在**的字段，且刷新时按 `uid` 整体覆盖，与用户自选池的生命周期不同。
 * 上游没有的字段一律给 0 / null，界面与 AI 提示词都按「未提供」处理，绝不用 0 冒充。
 */
export interface IpoOffer {
  id: string;
  /** 稳定业务键 `market:上市代码（缺失时用申购代码）`，刷新与订阅关联都按它进行。 */
  uid: string;
  market: Market;
  /** 上市交易代码；尚未确定时为空串。 */
  code: string;
  /** 申购代码（A 股 732/787 开头；港股/美股通常等于上市代码）。 */
  subscribeCode: string;
  name: string;
  /** 实际拿到这条数据的数据源。 */
  source: SourceId;
  /** 交易所，例如 上交所 / 深交所 / 港交所 / 纳斯达克。 */
  exchange: string;
  /** 板块，例如 主板 / 创业板 / 科创板 / 北交所 / 主板-GEM。 */
  board: string;
  /** 发行价；未定价为 0。 */
  issuePrice: number;
  /** 招股价区间下限 / 上限（港股常用）；未提供为 0。 */
  priceLow: number;
  priceHigh: number;
  currency: string;
  /** 最小申购单位：A 股 500/1000 股，港股每手股数；0 = 上游未提供。 */
  lotSize: number;
  /** 单一账户申购上限（股）；0 = 未提供。 */
  maxShares: number;
  /** 申购 / 招股开始日（YYYY-MM-DD）。 */
  subscribeStart: string | null;
  /** 申购 / 招股截止日。 */
  subscribeEnd: string | null;
  /** 中签号公布日 / 定价日。 */
  allotmentDate: string | null;
  /** 上市日。 */
  listingDate: string | null;
  /** 发行总量（股）。 */
  issueShares: number;
  /** 募资额（按 `currency` 计）。 */
  raiseAmount: number;
  /** 发行市盈率。 */
  issuePe: number;
  /** 行业市盈率（A 股）。 */
  industryPe: number;
  /** 网上中签率（%）。 */
  winningRate: number;
  /** 超额认购倍数（港股公开发售 / 美股 oversubscription）。 */
  oversubscribe: number;
  /** 保荐机构 / 主承销商。 */
  sponsor: string;
  industry: string;
  /** 招股说明书 / 上市公告链接（可为空，AI 用 fetch_url 深读）。 */
  prospectusUrl: string;
  status: IpoMarketStatus;
  /** AI 打新分析（Markdown：基本面 / 财务 / 招股书要点 / 宏观与政商环境 / 风险 / 结论）。 */
  advice: string;
  /** AI 给出的申购倾向；尚未分析为 null。 */
  verdict: IpoAdviceVerdict | null;
  /**
   * 一句话结论理由（≤ 80 字）：**为什么是这个 verdict**。
   *
   * 必须写清「绑定约束」：定价折价/基本面/破发风险，或「本月预算只剩 X 元、一手要 Y 元」这类资金约束。
   * 界面的「推荐理由」列就显示这一条 —— 只有胜率/预期收益数字而没有理由，用户会觉得结论自相矛盾。
   */
  verdictReason: string;
  /** AI 建议的申购股数（已按申购上限与中签概率折算）。 */
  suggestedShares: number;
  /**
   * AI 推算的「上市后正收益」概率 0–1（即不破发的胜率）；0 = 还没评估。
   *
   * 与 `winningRate`（上游公告的中签率）是两件事：中签率回答「我能不能买到」，
   * 胜率回答「买到之后赚不赚」，界面必须分开显示，不能互相冒充。
   */
  winProbability: number;
  /** AI 推算的上市后相对发行价的预期收益（%），可为负；0 = 还没评估。 */
  expectedReturn: number;
  /** AI 置信度 0–1。 */
  confidence: number;
  /** 0–100 打新评分（越高越值得申购）。 */
  qualityScore: number;
  adviceAt: string | null;
  /** 产出该结论的 run id（可在「活动与审计」里回放）。 */
  adviceRunId: string | null;
  /** 人工备注。 */
  note: string;
  createdAt: string;
  updatedAt: string;
  /** 我的申购 / 中签记录；null = 还没登记。 */
  subscription: IpoSubscription | null;
}

/** 我的一笔打新登记（一只新股最多一条）。 */
export interface IpoSubscription {
  id: string;
  /** 关联 `IpoOffer.uid`（新股刷新后 offer id 可能重建，uid 不变）。 */
  offerUid: string;
  market: Market;
  code: string;
  name: string;
  status: IpoSubscriptionStatus;
  /** 登记的申购股数。 */
  appliedShares: number;
  /** 中签股数；0 = 未中签。 */
  allottedShares: number;
  /** 缴款单价（默认取发行价）。 */
  price: number;
  fee: number;
  currency: string;
  /** 申购登记日（YYYY-MM-DD）。 */
  appliedAt: string;
  /** 中签 / 入账日（YYYY-MM-DD）；未中签为 null。 */
  allottedAt: string | null;
  /** 中签入账后的资产 id；null = 尚未入账。 */
  assetId: string | null;
  /** 入账产生的交易 id。 */
  transactionId: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/ipo` — 列表 + 计数 + 上次刷新时间。 */
export interface IpoListResponse extends ListResponse<IpoOffer> {
  counts: {
    total: number;
    CN: number;
    HK: number;
    US: number;
    /** 当前可申购（招股中）。 */
    subscribing: number;
    /** 我已登记申购（含已中签/未中签）。 */
    applied: number;
    /** 我已中签且已入账。 */
    allotted: number;
  };
  /** 最近一次成功刷新时间（ISO）；从未刷新为 null。 */
  lastRefreshAt: string | null;
  /** 刷新过程中的非致命问题（数据源不可用等），必须原样展示。 */
  warnings: string[];
}

/** `POST /api/ipo/refresh` 的回执。 */
export interface IpoRefreshResult {
  /** 上游返回的新股条数（去重后）。 */
  fetched: number;
  inserted: number;
  updated: number;
  byMarket: { market: Market; count: number }[];
  sources: SourceId[];
  /** 每个市场各自的问题（例如「港股数据源不可用」）。 */
  warnings: string[];
  refreshedAt: string;
}

/** `POST /api/ipo/:id/subscribe` — 登记「我申购了 N 股」。 */
export interface IpoSubscribeInput {
  shares: number;
  /** 申购价；省略时取发行价。 */
  price?: number;
  note?: string;
  /** 申购日；省略时取服务端当天。 */
  appliedAt?: string;
}

/**
 * `POST /api/ipo/:id/allot` — 登记中签结果。
 *
 * `shares > 0` 时会**自动在账本里建资产 + 买入流水**（`source='ipo'`，成本 = 中签价 + 费用），
 * 因此这是「打新闭环」的落点；`shares = 0` 表示未中签，只更新状态、不写账本。
 */
export interface IpoAllotInput {
  /** 中签股数；0 = 未中签。 */
  shares: number;
  /** 缴款单价；省略时取发行价。 */
  price?: number;
  fee?: number;
  /** 入账交易日（YYYY-MM-DD）；省略时取服务端当天。 */
  tradeDate?: string;
  note?: string;
}

/** `POST /api/ipo/:id/allot` 的响应：新股 + 入账后的资产（未中签时 asset 为 null）。 */
export interface IpoAllotResult {
  offer: IpoOffer;
  asset: AssetDetail | null;
  /** true = 本次新建了资产；false = 复用已有资产（同一只票二次入账）。 */
  assetCreated: boolean;
  /**
   * 非阻断提示（例如「本次缴款已超出当月预算」）。预算只约束 AI 买入建议，
   * **不会**阻止真实中签入账——钱已经缴了，账必须记上，提示只是提醒。
   */
  warnings: string[];
}

/**
 * `POST /api/ipo` — 手动录入一只新股。
 *
 * 上游（尤其是美股/港股小盘新股）偶尔缺数据，或用户从券商 App 看到更准的招股信息时，
 * 允许人工录入；`source` 固定为 `manual`，刷新时**不会**被上游覆盖名称与申购日期以外的
 * 人工备注，但会被上游更新的发行价/上市日修正。
 */
export interface IpoUpsertInput {
  market: Market;
  code: string;
  name: string;
  subscribeCode?: string;
  exchange?: string;
  board?: string;
  issuePrice?: number;
  priceLow?: number;
  priceHigh?: number;
  lotSize?: number;
  maxShares?: number;
  subscribeStart?: string;
  subscribeEnd?: string;
  allotmentDate?: string;
  listingDate?: string;
  issuePe?: number;
  industryPe?: number;
  winningRate?: number;
  sponsor?: string;
  industry?: string;
  prospectusUrl?: string;
  note?: string;
}

/* ─────────────────────────────── dashboard ────────────────────────────────── */

/**
 * 当年收益统计（年化）。
 *
 * 全部由「真实账本 + 真实收盘价」确定性重算，口径写在 `notes` 里，可复算、可核对：
 *   · 年化 = XIRR（资金加权内部收益率，actual/365），不是「收益率 ÷ 天数 × 365」的
 *     外推——后者对不规则现金流是错的；
 *   · 期初持仓按**上一年最后一天收盘价**估值（缺价时如实置 null，不给假数字）；
 *   · 所有现金流含交易费用（真实现金流出/流入）。
 */
export interface PortfolioPerformance {
  /** 统计年度（自然年，本地时区）。 */
  year: number;
  /** 估值起点：上一自然年最后一天（各标的取各自 ≤ 该日的最后收盘价）。 */
  periodStart: string;
  /** 估值终点（本地日期）。 */
  periodEnd: string;
  /** 期初持仓市值（折算为组合币种）；null = 缺少历史收盘价，无法估值。 */
  openingValue: number | null;
  /** 期末持仓总市值（折算后，等于 `marketValue`）。 */
  endingValue: number;
  /** 当年净投入 = 买入含费用 − 卖出净额（正 = 当年净追加资金）。 */
  netInvested: number;
  /** 当年已实现盈亏（与账本口径一致：不含交易费用）。 */
  realizedPnl: number;
  /**
   * 当年组合年化收益率（XIRR，含费用），百分数；`null` = 不可度量**或区间过短不年化**。
   *
   * 注意 XIRR 是几何年化：只持有 1 天时，−0.45% 的区间收益会年化成 −80% —— 数学上没错，
   * 但把一天的波动外推成全年没有统计意义。因此**不足 30 天一律不年化**（`annualizedReliable
   * = false`），界面改为展示 {@link cumulativePct}（区间累计收益率），原因写在 `notes` 里。
   */
  annualizedPct: number | null;
  /** 当年已实现年化收益率（仅当年卖出部分，含费用），百分数；null = 当年无卖出 / 持有期过短 / 不可度量。 */
  realizedAnnualizedPct: number | null;
  /**
   * 区间累计（简单）收益率 %：
   * `(期末市值 + 卖出净额 − 买入含费 − 期初市值) / (期初市值 + 买入含费)`。
   *
   * 不考虑资金进出的**时点**（那是 XIRR 的职责），但它是「这段时间到底赚了/亏了百分之几」的直接答案，
   * 用于年化不可信时替代展示；`null` = 期初市值未知。
   */
  cumulativePct: number | null;
  /** 当年已实现的累计收益率 %：已实现净盈亏（含费）/ 卖出份额的含费成本；null = 当年无卖出。 */
  realizedCumulativePct: number | null;
  /** 当年**实际有资金在场**的自然日数（首笔 → 末笔现金流），不是自然年长度。 */
  cashFlowDays: number;
  /** 区间是否够长到可以年化（`cashFlowDays >= 30`）；false 时 `annualizedPct` 必为 null。 */
  annualizedReliable: boolean;
  /** 当年已实现部分是否够长到可以年化（卖出份额的加权买入日 → 卖出日）。 */
  realizedAnnualizedReliable: boolean;
  /** 全周期年化收益率（首次买入至今，XIRR，含费用）；null = 不可度量。 */
  sinceInceptionPct: number | null;
  /** 全周期起点（首次交易日）；null = 还没有任何买入。 */
  sinceInceptionFrom: string | null;
  /** 统计区间自然日数。 */
  days: number;
  /** 口径说明与降级原因（界面悬浮展示）。 */
  notes: string[];
}

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
  /** 当年年化收益（XIRR）：Dashboard 第一行的「年化收益率 / 已实现年化收益率」。 */
  performance: PortfolioPerformance;
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
  /** 是否至少有一个启用的定时任务（等价于旧的 `mode !== 'off'`）。 */
  scheduleEnabled: boolean;
  /** 所有启用任务中最近的一次运行时间。 */
  nextRunAt: string | null;
  /** 每个启用任务各自的下次运行时间（按时间升序），供设置页逐个显示。 */
  nextRuns: ScheduleNextRun[];
}

/** 一个启用任务的下次运行时间（`DashboardSignals.nextRuns` 的元素）。 */
export interface ScheduleNextRun {
  id: string;
  name: string;
  nextRunAt: string;
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

/* ───────────────────────────── 财务报表（三表） ───────────────────────────── */

/** 报表种类：利润表 / 资产负债表 / 现金流量表。 */
export type StatementKind = 'income' | 'balance' | 'cashflow';

export interface FinancialLine {
  /** 稳定的指标键（跨市场统一，便于跨期比较）。 */
  key: string;
  /** 中文标签，直接用于报告书写。 */
  label: string;
  value: number;
  /** 金额为币种代码（CNY/HKD/USD），每股指标为 `<币种>/股`，比率为 `%`。 */
  unit: string;
  /** 同比（%）；上游未提供时为 null。 */
  yoy?: number | null;
}

export interface FinancialPeriod {
  /** 报告期标签，例如 `2026中报`、`2026年 三季报`。 */
  period: string;
  /** 报告期截止日 `YYYY-MM-DD`。 */
  reportDate: string;
  /** 报告类型，例如 中报 / 年报 / 三季报 / 单季报 / 累计季报。 */
  reportType: string;
  currency: string;
  /** 是否为年初至今累计口径（定期报告为 true，美股单季报为 false）。 */
  cumulative: boolean;
  lines: FinancialLine[];
}

export interface FinancialStatement {
  kind: StatementKind;
  label: string;
  available: boolean;
  /** 不可用时的原因，必须回传给模型（禁止静默留空）。 */
  reason?: string;
  /** 补充说明，例如「港股现金流量表明细无源，此处为总量指标」。 */
  note?: string;
  /** 新 → 旧排序。 */
  periods: FinancialPeriod[];
}

export interface Financials {
  code: string;
  market: Market;
  name: string;
  /** 报表主币种。 */
  currency: string;
  /** 会计准则，例如「中国会计准则」「国际会计准则」「美国会计准则」。 */
  standard: string | null;
  statements: FinancialStatement[];
  /** 已由数据算出的比率/排雷信号（`标签=值`），可直接引用。 */
  highlights: string[];
  sources: SourceId[];
  warnings: string[];
}

/** `GET /api/market/financials` 的响应：三表 + 该标的是否适用财报。 */
export interface FinancialsResponse extends Financials {
  /** false = 该标的不适用公司财报（ETF / 场外基金），此时 statements 为空。 */
  applicable: boolean;
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
  /**
   * Known coverage gaps (不是故障): e.g. 社会融资规模没有零 Key 上游。
   * Optional so older clients/payloads stay valid.
   */
  notes?: string[];
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
      entity: 'asset' | 'watchlist' | 'ipo' | 'advice' | 'briefing' | 'settings';
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
  /** 新股打新：打新标的与我的申购记录（老备份没有这两项，读取时按空数组处理）。 */
  ipoOffers?: IpoOffer[];
  ipoSubscriptions?: IpoSubscription[];
  runs?: AgentRunSummary[];
  settings?: Omit<Settings, 'llm'> & { llm: Omit<LlmConfig, 'apiKey'> };
}

export interface ImportResult {
  assets: number;
  transactions: number;
  watchlist: number;
  advice: number;
  ipoOffers: number;
  ipoSubscriptions: number;
  skipped: number;
  mode: ImportMode;
}

export type ImportMode = 'merge' | 'replace';

/**
 * `POST /api/backup/clear`（设置页「一键清除所有数据」）的回执：逐表给出删除行数。
 *
 * 默认只清业务数据与 AI 历史，**保留** AI 配置（含 LLM / 数据源 Key）；
 * `keepSettings: false` 时连设置一起恢复出厂默认。服务端 `data/backups`
 * 下的快照文件不属于「数据」，不受影响。
 */
export interface ClearDataResult {
  assets: number;
  transactions: number;
  watchlist: number;
  advice: number;
  /** 建议结果追踪（可重算的物化缓存）。 */
  adviceOutcomes: number;
  /** 新股打新：打新标的。 */
  ipoOffers: number;
  /** 新股打新：我的申购 / 中签记录。 */
  ipoSubscriptions: number;
  runs: number;
  steps: number;
  runMessages: number;
  chatSessions: number;
  chatMessages: number;
  auditEntries: number;
  pendingWrites: number;
  /** 汇率 / 简报指针等本地缓存键。 */
  kvEntries: number;
  /** 设置是否被重置为出厂默认（含清空全部 API Key、关闭定时任务）。 */
  settingsReset: boolean;
  /** 删除的数据行总数（业务数据 + AI 历史 + 缓存，不含设置行本身）。 */
  deleted: number;
}

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
