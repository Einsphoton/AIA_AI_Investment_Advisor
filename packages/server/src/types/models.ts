/**
 * Persistence-layer row shapes (snake_case columns ⇄ camelCase objects).
 *
 * Owned by: Lead (frozen contract). `server-core` implements readers/writers
 * that return exactly these shapes; `agent-engine` only consumes them.
 */
import type {
  AdviceAction,
  AdviceStatus,
  AgentRunKind,
  AgentRunStatus,
  ChatRole,
  Creator,
  InstrumentType,
  LlmConfig,
  Market,
  Persona,
  ReportStyle,
  ScheduleConfig,
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
  schedule: ScheduleConfig;
  enforceBudget: boolean;
  watchlistCandidateLimit: number;
  /** P3 淘汰机制：连续 N 次分析仍被标记退役才真正删除；0 = 永不删除。 */
  watchlistRetireDeleteRuns: number;
  /** P1-1: tool authorisation policy (deny list + write approval mode). */
  toolPolicy: ToolPolicy;
  /** P1-2: configured MCP servers. */
  mcpServers: McpServerConfig[];
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
}

export interface RunRow {
  id: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
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
  action: AdviceAction;
  targetShares: number;
  targetPrice: number;
  currency: string;
  reason: string;
  confidence: number;
  status: AdviceStatus;
  createdAt: string;
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
