/**
 * Persistence-layer row shapes (snake_case columns ⇄ camelCase objects).
 *
 * Owned by: Lead (frozen contract). `server-core` implements readers/writers
 * that return exactly these shapes; `agent-engine` only consumes them.
 */
import type {
  AdviceAction,
  AdviceInstrument,
  AdviceOutcomeStatus,
  AdviceStatus,
  AgentRunKind,
  AgentRunStatus,
  ChatRole,
  Creator,
  InstrumentType,
  IpoAdviceVerdict,
  IpoMarketStatus,
  IpoSubscriptionStatus,
  LlmConfig,
  Market,
  OptionAdvicePlan,
  OptionCollateralKind,
  OptionMarket,
  OptionPositionStatus,
  OptionSettings,
  OptionSettlementStatus,
  OptionSettlementVerdict,
  OptionStrategy,
  OptionType,
  Persona,
  ReportStyle,
  ScheduleTask,
  StepStatus,
  ToolPolicy,
  ToolRisk,
  TxKind,
  TxSource,
  DataSourceConfig,
  McpServerConfig,
  PendingWriteStatus,
  WatchItemStatus,
} from '@aia/shared';

export interface StoredSettings {
  persona: Persona;
  reportStyle: ReportStyle;
  llm: LlmConfig;
  dataSources: DataSourceConfig;
  budget: { CN: number; HK: number; US: number };
  /** 定时任务列表（旧库的 `schedule_*` 单任务列会在读取时迁移到这个数组）。 */
  schedules: ScheduleTask[];
  enforceBudget: boolean;
  watchlistCandidateLimit: number;
  /** P3 淘汰机制：连续 N 次分析仍被标记退役才真正删除；0 = 永不删除。 */
  watchlistRetireDeleteRuns: number;
  /** P1-1: tool authorisation policy (deny list + write approval mode). */
  toolPolicy: ToolPolicy;
  /** P1-2: configured MCP servers. */
  mcpServers: McpServerConfig[];
  /** 期权卖权：各市场可用现金 + 到期结算模式（见 OptionSettings）。 */
  option: OptionSettings;
  lastRunAt: string | null;
  updatedAt: string;
}

/** P1-1: one row of the agent audit trail. */
export interface AuditRow {
  id: string;
  at: string;
  runId: string | null;
  sessionId: string | null;
  tool: string;
  risk: ToolRisk;
  outcome: 'executed' | 'denied' | 'deferred' | 'failed';
  entity: string | null;
  entityId: string | null;
  summary: string;
  args: string;
}

/** P1-1: a mutating tool call waiting for human approval. */
export interface PendingWriteRow {
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
  result: string | null;
}

/** P1-3: one persisted message of a run (resume + trajectory replay). */
export interface RunMessageRow {
  id: string;
  runId: string;
  index: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls: string | null;
  toolCallId: string | null;
  name: string | null;
  /**
   * Thinking-mode trace of an assistant message, persisted so a resumed run can
   * echo it back (thinking providers require it on tool-call messages).
   */
  reasoningContent: string | null;
  createdAt: string;
}

export interface AssetRow {
  id: string;
  name: string;
  code: string;
  market: Market;
  type: InstrumentType;
  source: Creator;
  currency: string;
  note: string;
  aiSummary: string;
  aiSummaryAt: string | null;
  thesis: string;
  qualityScore: number;
  targetPrice: number;
  expectedReturn: number;
  price: number;
  priceAt: string | null;
  prevClose: number;
  dayChangePct: number;
  spark: number[];
  createdAt: string;
  updatedAt: string;
}

export interface TxRow {
  id: string;
  assetId: string;
  kind: TxKind;
  shares: number;
  price: number;
  fee: number;
  tradeDate: string;
  note: string;
  source: TxSource;
  createdAt: string;
}

export interface WatchRow {
  id: string;
  name: string;
  code: string;
  market: Market;
  type: InstrumentType;
  source: Creator;
  qualityScore: number;
  targetPrice: number;
  expectedReturn: number;
  expectedReturnHorizon: string;
  initialPrice: number;
  initialPriceAt: string | null;
  price: number;
  priceAt: string | null;
  prevClose: number;
  dayChangePct: number;
  thesis: string;
  note: string;
  aiSummary: string;
  aiSummaryAt: string | null;
  spark: number[];
  /** P3 淘汰机制：'active'（在池）| 'retired'（AI 判定不适合）。 */
  status: WatchItemStatus;
  retiredReason: string;
  retiredAt: string | null;
  retireStreak: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdviceRow {
  id: string;
  batchId: string;
  assetId: string | null;
  watchItemId: string | null;
  assetName: string;
  code: string;
  market: Market;
  type: InstrumentType;
  /** 'stock' | 'option'：决定确认时写股票流水还是写期权合约。 */
  instrument: AdviceInstrument;
  action: AdviceAction;
  targetShares: number;
  targetPrice: number;
  currency: string;
  reason: string;
  confidence: number;
  status: AdviceStatus;
  executedShares: number | null;
  executedPrice: number | null;
  createdAt: string;
  decidedAt: string | null;
  /** 卖权方案（`instrument='option'` 时非空，读库时已 JSON 解析）。 */
  option: OptionAdvicePlan | null;
}

/**
 * 建议结果追踪（物化缓存）：由 `services/advice-outcomes.ts` 从「建议行 + 日线序列」
 * 确定性重算，因此永远是幂等的 —— 重跑一次会得到同样的数字。
 */
export interface AdviceOutcomeRow {
  adviceId: string;
  runId: string | null;
  code: string;
  market: Market;
  type: InstrumentType;
  action: AdviceAction;
  currency: string;
  advisedAt: string;
  adviceStatus: AdviceStatus;
  executed: boolean;
  baselineDate: string;
  baselinePrice: number;
  lastDate: string;
  lastPrice: number;
  priceChangePct: number;
  adviceReturnPct: number;
  benchmarkCode: string;
  benchmarkName: string;
  benchmarkBase: number;
  benchmarkChangePct: number;
  excessPct: number;
  maxReturnPct: number;
  minReturnPct: number;
  samples: number;
  daysTracked: number;
  status: AdviceOutcomeStatus;
  warnings: string[];
  updatedAt: string;
}

export interface RunRow {
  id: string;
  kind: AgentRunKind;  status: AgentRunStatus;
  target: string | null;
  title: string;
  summary: string;
  error: string | null;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface StepRow {
  id: string;
  runId: string;
  index: number;
  label: string;
  status: StepStatus;
  detail: string;
  toolName: string | null;
  toolArgs: string | null;
  toolResult: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ChatSessionRow {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageRow {
  id: string;
  sessionId: string;
  role: ChatRole;
  content: string;
  toolCalls: string | null;
  toolCallId: string | null;
  runId: string | null;
  createdAt: string;
}

/* ─────────────────────────── 新股打新 (IPO) rows ──────────────────────────── */

/**
 * `ipo_offers` 的一行。
 *
 * `uid`（`market:code`）是稳定业务键：新股刷新时上游可能改变主键（新库 id），
 * 但 uid 不变，因此订阅记录、AI 结论与界面选中项都挂 uid 而不是行 id。
 */
export interface IpoOfferRow {
  id: string;
  uid: string;
  market: Market;
  code: string;
  subscribeCode: string;
  name: string;
  source: string;
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
  status: IpoMarketStatus;
  advice: string;
  verdict: IpoAdviceVerdict | null;
  /** 一句话结论理由（必填，由 `save_ipo_analysis` 写入）。 */
  verdictReason: string;
  suggestedShares: number;
  /** AI 推算的上市后正收益概率 0–1（与上游中签率 `winningRate` 不同）。 */
  winProbability: number;
  /** AI 推算的上市后预期收益（%，可为负）。 */
  expectedReturn: number;
  confidence: number;
  qualityScore: number;
  adviceAt: string | null;
  adviceRunId: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

/** `ipo_subscriptions` 的一行。 */
export interface IpoSubscriptionRow {
  id: string;
  offerUid: string;
  market: Market;
  code: string;
  name: string;
  status: IpoSubscriptionStatus;
  appliedShares: number;
  allottedShares: number;
  price: number;
  fee: number;
  currency: string;
  appliedAt: string;
  allottedAt: string | null;
  assetId: string | null;
  transactionId: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

/** `createIpoOffer` 的入参（刷新与人工录入共用）。 */
export interface NewIpoOffer {
  id: string;
  uid: string;
  market: Market;
  code: string;
  subscribeCode?: string;
  name: string;
  source?: string;
  exchange?: string;
  board?: string;
  issuePrice?: number;
  priceLow?: number;
  priceHigh?: number;
  currency?: string;
  lotSize?: number;
  maxShares?: number;
  subscribeStart?: string | null;
  subscribeEnd?: string | null;
  allotmentDate?: string | null;
  listingDate?: string | null;
  issueShares?: number;
  raiseAmount?: number;
  issuePe?: number;
  industryPe?: number;
  winningRate?: number;
  oversubscribe?: number;
  sponsor?: string;
  industry?: string;
  prospectusUrl?: string;
  status?: IpoMarketStatus;
  /** 注意：AI 结论字段（`verdict` 等）不在这里 —— 刷新/人工录入只写发行要素，
   *  结论一律经 `updateIpoOffer`（`IpoOfferPatch`）由 `save_ipo_analysis` 落库。 */
  note?: string;
  createdAt?: string;
}

/** `updateIpoOffer` 的部分更新；`undefined` = 不动。 */
export type IpoOfferPatch = Partial<Omit<IpoOfferRow, 'id' | 'uid' | 'createdAt'>>;

export interface NewIpoSubscription {
  id: string;
  offerUid: string;
  market: Market;
  code: string;
  name: string;
  status?: IpoSubscriptionStatus;
  appliedShares?: number;
  allottedShares?: number;
  price?: number;
  fee?: number;
  currency?: string;
  appliedAt: string;
  allottedAt?: string | null;
  assetId?: string | null;
  transactionId?: string | null;
  note?: string;
  createdAt?: string;
}

/* ───────────────────────────── input shapes ───────────────────────────────── */

export interface NewAsset {
  id: string;
  name: string;
  code: string;
  market: Market;
  type: InstrumentType;
  source: Creator;
  currency: string;
  note: string;
  price: number;
  priceAt: string | null;
  prevClose: number;
  dayChangePct: number;
  spark: number[];
  createdAt: string;
}

export interface NewTx {
  id: string;
  assetId: string;
  kind: TxKind;
  shares: number;
  price: number;
  fee: number;
  tradeDate: string;
  note: string;
  source: TxSource;
  createdAt: string;
}

export interface NewWatch {
  id: string;
  name: string;
  expectedReturnHorizon?: string;
  code: string;
  market: Market;
  type: InstrumentType;
  source: Creator;
  initialPrice: number;
  initialPriceAt: string | null;
  price: number;
  priceAt: string | null;
  prevClose: number;
  dayChangePct: number;
  spark: number[];
  note: string;
  createdAt: string;
}

export interface NewAdvice {
  id: string;
  batchId: string;
  assetId: string | null;
  watchItemId: string | null;
  assetName: string;
  code: string;
  market: Market;
  type: InstrumentType;
  /** 默认 'stock'（不传即为股票建议，老调用点不用改）。 */
  instrument?: AdviceInstrument;
  action: AdviceAction;
  targetShares: number;
  targetPrice: number;
  currency: string;
  reason: string;
  confidence: number;
  status: AdviceStatus;
  createdAt: string;
  /** 卖权方案（`instrument='option'` 时必填，写库时序列化为 JSON）。 */
  optionPlan?: OptionAdvicePlan | null;
}

/* ─────────────────────── 期权卖权：持仓与到期结算的行结构 ─────────────────── */

/** `option_contracts` 一行（一笔卖出的合约）。 */
export interface OptionContractRow {
  id: string;
  adviceId: string | null;
  strategy: OptionStrategy;
  market: OptionMarket;
  underlyingCode: string;
  underlyingName: string;
  underlyingAssetId: string | null;
  optionCode: string;
  optionType: OptionType;
  strike: number;
  expiry: string;
  contracts: number;
  multiplier: number;
  currency: string;
  premium: number;
  fee: number;
  premiumIncome: number;
  collateralKind: OptionCollateralKind;
  collateral: number;
  underlyingPriceAtOpen: number;
  status: OptionPositionStatus;
  openedAt: string;
  closedAt: string | null;
  closePrice: number | null;
  realizedPnl: number | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewOptionContract {
  id: string;
  adviceId?: string | null;
  strategy: OptionStrategy;
  market: OptionMarket;
  underlyingCode: string;
  underlyingName?: string;
  underlyingAssetId?: string | null;
  optionCode: string;
  optionType: OptionType;
  strike: number;
  expiry: string;
  contracts: number;
  multiplier: number;
  currency: string;
  premium: number;
  fee?: number;
  premiumIncome: number;
  collateralKind: OptionCollateralKind;
  collateral: number;
  underlyingPriceAtOpen?: number;
  status?: OptionPositionStatus;
  openedAt: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

/** 部分更新：`undefined` = 不改。 */
export interface OptionContractPatch {
  underlyingName?: string;
  underlyingAssetId?: string | null;
  status?: OptionPositionStatus;
  closedAt?: string | null;
  closePrice?: number | null;
  realizedPnl?: number | null;
  note?: string;
  updatedAt?: string;
}

/** `option_settlements` 一行（一个合约最多一条，按 contract_id 幂等）。 */
export interface OptionSettlementRow {
  id: string;
  contractId: string;
  expiry: string;
  evaluatedAt: string;
  referencePrice: number;
  priceSource: string;
  verdict: OptionSettlementVerdict;
  itmAmount: number;
  itmPct: number;
  status: OptionSettlementStatus;
  action: 'none' | 'shares_delivered' | 'shares_received' | 'pending';
  transactionId: string | null;
  assetId: string | null;
  realizedPnl: number;
  note: string;
  createdAt: string;
}

export interface NewOptionSettlement {
  id: string;
  contractId: string;
  expiry: string;
  evaluatedAt: string;
  referencePrice: number;
  priceSource: string;
  verdict: OptionSettlementVerdict;
  itmAmount: number;
  itmPct: number;
  status: OptionSettlementStatus;
  action: 'none' | 'shares_delivered' | 'shares_received' | 'pending';
  transactionId?: string | null;
  assetId?: string | null;
  realizedPnl?: number;
  note?: string;
  createdAt: string;
}

export interface OptionSettlementPatch {
  evaluatedAt?: string;
  referencePrice?: number;
  priceSource?: string;
  verdict?: OptionSettlementVerdict;
  itmAmount?: number;
  itmPct?: number;
  status?: OptionSettlementStatus;
  action?: OptionSettlementRow['action'];
  transactionId?: string | null;
  assetId?: string | null;
  realizedPnl?: number;
  note?: string;
}

export interface NewStep {
  id: string;
  runId: string;
  index: number;
  label: string;
  status: StepStatus;
  detail?: string;
  toolName?: string | null;
  toolArgs?: string | null;
  toolResult?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

/** Partial updates use `undefined` = untouched. */
export interface AssetPatch {
  name?: string;
  note?: string;
  market?: Market;
  type?: InstrumentType;
  currency?: string;
  thesis?: string;
  qualityScore?: number;
  targetPrice?: number;
  expectedReturn?: number;
  aiSummary?: string;
  aiSummaryAt?: string | null;
  price?: number;
  priceAt?: string | null;
  prevClose?: number;
  dayChangePct?: number;
  spark?: number[];
}

export interface WatchPatch {
  expectedReturnHorizon?: string;
  name?: string;
  note?: string;
  market?: Market;
  type?: InstrumentType;
  qualityScore?: number;
  targetPrice?: number;
  expectedReturn?: number;
  thesis?: string;
  aiSummary?: string;
  aiSummaryAt?: string | null;
  initialPrice?: number;
  initialPriceAt?: string | null;
  price?: number;
  priceAt?: string | null;
  prevClose?: number;
  dayChangePct?: number;
  spark?: number[];
  source?: Creator;
  /** P3 淘汰机制字段（仅工具/流水线与 restore 接口写入）。 */
  status?: WatchItemStatus;
  retiredReason?: string;
  retiredAt?: string | null;
  retireStreak?: number;
}
