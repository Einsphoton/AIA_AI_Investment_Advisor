/**
 * SQLite repository — implements the frozen `Repo` interface.
 *
 * Owner: server-core. Uses the built-in `node:sqlite` module (`DatabaseSync`):
 * no native dependencies, no ORM. Schema lives in ./schema.ts.
 *
 * Conventions
 *  - columns are snake_case, objects are camelCase (mapping below);
 *  - JSON columns (`assets.spark`, `watchlist.spark`, `settings.data_sources`)
 *    are (de)serialised here so callers always see real values;
 *  - every write goes through the prepared statements built in this module and
 *    each multi-row mutation uses `transaction()`.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  DEFAULT_BUDGET,
  DEFAULT_DATA_SOURCES,
  DEFAULT_ENFORCE_BUDGET,
  DEFAULT_LLM,
  DEFAULT_MCP_SERVERS,
  DEFAULT_OPTION_SETTINGS,
  DEFAULT_PERSONA,
  DEFAULT_REPORT_STYLE,
  DEFAULT_SCHEDULE_TASK,
  DEFAULT_TOOL_POLICY,
  DEFAULT_WATCHLIST_CANDIDATE_LIMIT,
  DEFAULT_WATCHLIST_RETIRE_DELETE_RUNS,
  MARKET_CURRENCY,
  type AuditEntry,
  type AdviceAction,
  type AdviceOutcomeStatus,
  type AdviceStatus,
  type ClearDataResult,
  type Creator,
  type ImportMode,
  type ImportResult,
  type InstrumentType,
  type IpoMarketStatus,
  type Market,
  type McpServerConfig,
  type OptionMarket,
  type OptionPositionStatus,
  type OptionSettlementStatus,
  type PendingWrite,
  type PendingWriteStatus,
  type ScheduleTask,
  type ToolPolicy,
  type ToolRisk,
} from '@aia/shared';

import { badRequest, conflict } from '../errors.js';
import type { ExportBundle, Repo, WatchlistStatusFilter } from '../types/repo.js';
import type {
  AdviceOutcomeRow,
  AdviceRow,
  AssetPatch,
  AssetRow,
  AuditRow,
  ChatMessageRow,
  ChatSessionRow,
  IpoOfferPatch,
  IpoOfferRow,
  IpoSubscriptionRow,
  NewAdvice,
  NewAsset,
  NewIpoOffer,
  NewIpoSubscription,
  NewOptionContract,
  NewOptionSettlement,
  NewStep,
  NewTx,
  NewWatch,
  OptionContractPatch,
  OptionContractRow,
  OptionSettlementPatch,
  OptionSettlementRow,
  PendingWriteRow,
  RunMessageRow,
  RunRow,
  StepRow,
  StoredSettings,
  TxRow,
  WatchPatch,
  WatchRow,
} from '../types/models.js';
import { migrateSchema } from './schema.js';
import { nowIso, parseJson, stringifyJson, toNumber, toNumberArray, toText } from './util.js';

type Row = Record<string, unknown>;

/* ──────────────────────────────── conversions ─────────────────────────────── */

const str = (value: unknown, fallback = ''): string => (value === null || value === undefined ? fallback : String(value));
const nullableStr = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const bool = (value: unknown, fallback = false): boolean =>
  value === null || value === undefined ? fallback : toNumber(value, fallback ? 1 : 0) !== 0;
const int = (value: unknown, fallback = 0): number => Math.trunc(toNumber(value, fallback));

function rowToAsset(row: Row): AssetRow {
  return {
    id: str(row.id),
    name: str(row.name),
    code: str(row.code),
    market: str(row.market, 'CN') as AssetRow['market'],
    type: str(row.type, 'stock') as AssetRow['type'],
    source: str(row.source, 'manual') as Creator,
    currency: str(row.currency, 'CNY'),
    note: str(row.note),
    aiSummary: str(row.ai_summary),
    aiSummaryAt: nullableStr(row.ai_summary_at),
    thesis: str(row.thesis),
    qualityScore: toNumber(row.quality_score),
    targetPrice: toNumber(row.target_price),
    expectedReturn: toNumber(row.expected_return),
    price: toNumber(row.price),
    priceAt: nullableStr(row.price_at),
    prevClose: toNumber(row.price_prev_close),
    dayChangePct: toNumber(row.day_change_pct),
    spark: toNumberArray(row.spark),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

function rowToTx(row: Row): TxRow {
  return {
    id: str(row.id),
    assetId: str(row.asset_id),
    kind: str(row.kind, 'buy') as TxRow['kind'],
    shares: toNumber(row.shares),
    price: toNumber(row.price),
    fee: toNumber(row.fee),
    tradeDate: str(row.trade_date),
    note: str(row.note),
    source: str(row.source, 'manual') as TxRow['source'],
    createdAt: str(row.created_at),
  };
}

function rowToWatch(row: Row): WatchRow {
  return {
    id: str(row.id),
    name: str(row.name),
    code: str(row.code),
    market: str(row.market, 'CN') as WatchRow['market'],
    type: str(row.type, 'stock') as WatchRow['type'],
    source: str(row.source, 'manual') as Creator,
    qualityScore: toNumber(row.quality_score),
    targetPrice: toNumber(row.target_price),
    expectedReturn: toNumber(row.expected_return),
    expectedReturnHorizon: str(row.expected_return_horizon),
    initialPrice: toNumber(row.initial_price),
    initialPriceAt: nullableStr(row.initial_price_at),
    price: toNumber(row.price),
    priceAt: nullableStr(row.price_at),
    prevClose: toNumber(row.price_prev_close),
    dayChangePct: toNumber(row.day_change_pct),
    thesis: str(row.thesis),
    note: str(row.note),
    aiSummary: str(row.ai_summary),
    aiSummaryAt: nullableStr(row.ai_summary_at),
    spark: toNumberArray(row.spark),
    // P3 淘汰机制：老库补列后可能为空，一律退化为「在池」。
    status: str(row.status, 'active') === 'retired' ? 'retired' : 'active',
    retiredReason: str(row.retired_reason),
    retiredAt: nullableStr(row.retired_at),
    retireStreak: int(row.retire_streak, 0),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

function rowToIpoOffer(row: Row): IpoOfferRow {
  return {
    id: str(row.id),
    uid: str(row.uid),
    market: str(row.market, 'CN') as IpoOfferRow['market'],
    code: str(row.code),
    subscribeCode: str(row.subscribe_code),
    name: str(row.name),
    source: str(row.source, 'manual'),
    exchange: str(row.exchange),
    board: str(row.board),
    issuePrice: toNumber(row.issue_price),
    priceLow: toNumber(row.price_low),
    priceHigh: toNumber(row.price_high),
    currency: str(row.currency, 'CNY'),
    lotSize: toNumber(row.lot_size),
    maxShares: toNumber(row.max_shares),
    subscribeStart: nullableStr(row.subscribe_start),
    subscribeEnd: nullableStr(row.subscribe_end),
    allotmentDate: nullableStr(row.allotment_date),
    listingDate: nullableStr(row.listing_date),
    issueShares: toNumber(row.issue_shares),
    raiseAmount: toNumber(row.raise_amount),
    issuePe: toNumber(row.issue_pe),
    industryPe: toNumber(row.industry_pe),
    winningRate: toNumber(row.winning_rate),
    oversubscribe: toNumber(row.oversubscribe),
    sponsor: str(row.sponsor),
    industry: str(row.industry),
    prospectusUrl: str(row.prospectus_url),
    status: str(row.status, 'unknown') as IpoOfferRow['status'],
    advice: str(row.advice),
    // 空串/缺失一律给 null：界面据此判断「还没分析」，不给假结论。
    verdict: str(row.verdict) === '' ? null : (str(row.verdict) as IpoOfferRow['verdict']),
    verdictReason: str(row.verdict_reason),
    suggestedShares: toNumber(row.suggested_shares),
    winProbability: toNumber(row.win_probability),
    expectedReturn: toNumber(row.expected_return),
    confidence: toNumber(row.confidence),
    qualityScore: toNumber(row.quality_score),
    adviceAt: nullableStr(row.advice_at),
    adviceRunId: nullableStr(row.advice_run_id),
    note: str(row.note),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

function rowToIpoSubscription(row: Row): IpoSubscriptionRow {
  return {
    id: str(row.id),
    offerUid: str(row.offer_uid),
    market: str(row.market, 'CN') as IpoSubscriptionRow['market'],
    code: str(row.code),
    name: str(row.name),
    status: str(row.status, 'applied') as IpoSubscriptionRow['status'],
    appliedShares: toNumber(row.applied_shares),
    allottedShares: toNumber(row.allotted_shares),
    price: toNumber(row.price),
    fee: toNumber(row.fee),
    currency: str(row.currency, 'CNY'),
    appliedAt: str(row.applied_at),
    allottedAt: nullableStr(row.allotted_at),
    assetId: nullableStr(row.asset_id),
    transactionId: nullableStr(row.transaction_id),
    note: str(row.note),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

/**
 * `advice.option_plan` TEXT 列 → 对象。
 *
 * 空串 = 「没有卖权方案」（`instrument='stock'` 的正常情况），**不能**拿去 JSON.parse。
 * 坏 JSON 也一律降级成 null：一条脏数据不该让整个建议列表读不出来。
 */
function parseOptionPlan(value: unknown): AdviceRow['option'] {
  const text = toText(value);
  if (text.trim() === '') return null;
  const parsed = parseJson<unknown>(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as AdviceRow['option'];
}

function rowToAdvice(row: Row): AdviceRow {
  return {
    id: str(row.id),
    batchId: str(row.batch_id),
    assetId: nullableStr(row.asset_id),
    watchItemId: nullableStr(row.watch_item_id),
    assetName: str(row.asset_name),
    code: str(row.code),
    market: str(row.market, 'CN') as AdviceRow['market'],
    type: str(row.type, 'stock') as AdviceRow['type'],
    instrument: str(row.instrument, 'stock') as AdviceRow['instrument'],
    action: str(row.action, 'buy') as AdviceRow['action'],
    targetShares: toNumber(row.target_shares),
    targetPrice: toNumber(row.target_price),
    currency: str(row.currency, 'CNY'),
    reason: str(row.reason),
    confidence: toNumber(row.confidence),
    status: str(row.status, 'pending') as AdviceRow['status'],
    executedShares: row.executed_shares === null || row.executed_shares === undefined ? null : toNumber(row.executed_shares),
    executedPrice: row.executed_price === null || row.executed_price === undefined ? null : toNumber(row.executed_price),
    createdAt: str(row.created_at),
    decidedAt: nullableStr(row.decided_at),
    option: parseOptionPlan(row.option_plan),
  };
}

function rowToOptionContract(row: Row): OptionContractRow {
  return {
    id: str(row.id),
    adviceId: nullableStr(row.advice_id),
    strategy: str(row.strategy, 'covered_call') as OptionContractRow['strategy'],
    market: str(row.market, 'US') as OptionContractRow['market'],
    underlyingCode: str(row.underlying_code),
    underlyingName: str(row.underlying_name),
    underlyingAssetId: nullableStr(row.underlying_asset_id),
    optionCode: str(row.option_code),
    optionType: str(row.option_type, 'call') as OptionContractRow['optionType'],
    strike: toNumber(row.strike),
    expiry: str(row.expiry),
    contracts: int(row.contracts),
    multiplier: toNumber(row.multiplier, 100),
    currency: str(row.currency, 'USD'),
    premium: toNumber(row.premium),
    fee: toNumber(row.fee),
    premiumIncome: toNumber(row.premium_income),
    collateralKind: str(row.collateral_kind, 'shares') as OptionContractRow['collateralKind'],
    collateral: toNumber(row.collateral),
    underlyingPriceAtOpen: toNumber(row.underlying_price_at_open),
    status: str(row.status, 'open') as OptionContractRow['status'],
    openedAt: str(row.opened_at),
    closedAt: nullableStr(row.closed_at),
    closePrice: row.close_price === null || row.close_price === undefined ? null : toNumber(row.close_price),
    realizedPnl: row.realized_pnl === null || row.realized_pnl === undefined ? null : toNumber(row.realized_pnl),
    note: str(row.note),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

function rowToOptionSettlement(row: Row): OptionSettlementRow {
  return {
    id: str(row.id),
    contractId: str(row.contract_id),
    expiry: str(row.expiry),
    evaluatedAt: str(row.evaluated_at),
    referencePrice: toNumber(row.reference_price),
    priceSource: str(row.price_source),
    verdict: str(row.verdict, 'uncertain') as OptionSettlementRow['verdict'],
    itmAmount: toNumber(row.itm_amount),
    itmPct: toNumber(row.itm_pct),
    status: str(row.status, 'pending_review') as OptionSettlementRow['status'],
    action: str(row.action, 'none') as OptionSettlementRow['action'],
    transactionId: nullableStr(row.transaction_id),
    assetId: nullableStr(row.asset_id),
    realizedPnl: toNumber(row.realized_pnl),
    note: str(row.note),
    createdAt: str(row.created_at),
  };
}

/**
 * `option_contracts.contracts` 是 INTEGER 列：小数张数会被 SQLite 静默截断，那会让
 * 权利金收入（`premium * multiplier * contracts - fee`）与担保额对不上。显式拒绝。
 */
function requireContractCount(value: number): number {
  if (!Number.isFinite(value) || Math.trunc(value) !== value || value <= 0) {
    throw badRequest(`期权张数必须是正整数（收到 ${String(value)}）`);
  }
  return Math.trunc(value);
}

function rowToRun(row: Row): RunRow {
  return {
    id: str(row.id),
    kind: str(row.kind, 'custom') as RunRow['kind'],
    status: str(row.status, 'running') as RunRow['status'],
    target: nullableStr(row.target),
    title: str(row.title),
    summary: str(row.summary),
    error: nullableStr(row.error),
    turns: int(row.turns),
    promptTokens: int(row.prompt_tokens),
    completionTokens: int(row.completion_tokens),
    startedAt: str(row.started_at),
    finishedAt: nullableStr(row.finished_at),
  };
}

function rowToStep(row: Row): StepRow {
  return {
    id: str(row.id),
    runId: str(row.run_id),
    index: int(row.idx),
    label: str(row.label),
    status: str(row.status, 'pending') as StepRow['status'],
    detail: str(row.detail),
    toolName: nullableStr(row.tool_name),
    toolArgs: nullableStr(row.tool_args),
    toolResult: nullableStr(row.tool_result),
    startedAt: nullableStr(row.started_at),
    finishedAt: nullableStr(row.finished_at),
  };
}

function rowToSession(row: Row): ChatSessionRow {
  return {
    id: str(row.id),
    title: str(row.title),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

function rowToMessage(row: Row): ChatMessageRow {
  return {
    id: str(row.id),
    sessionId: str(row.session_id),
    role: str(row.role, 'user') as ChatMessageRow['role'],
    content: str(row.content),
    toolCalls: nullableStr(row.tool_calls),
    toolCallId: nullableStr(row.tool_call_id),
    runId: nullableStr(row.run_id),
    createdAt: str(row.created_at),
  };
}

function rowToSettings(row: Row): StoredSettings {
  const dataSources = parseJson<StoredSettings['dataSources']>(row.data_sources) ?? DEFAULT_DATA_SOURCES;
  return {
    persona: (str(row.persona, DEFAULT_PERSONA) || DEFAULT_PERSONA) as StoredSettings['persona'],
    reportStyle: (str(row.report_style, DEFAULT_REPORT_STYLE) || DEFAULT_REPORT_STYLE) as StoredSettings['reportStyle'],
    llm: {
      baseUrl: str(row.llm_base_url, DEFAULT_LLM.baseUrl),
      apiKey: str(row.llm_api_key, ''),
      model: str(row.llm_model, DEFAULT_LLM.model),
      temperature: toNumber(row.llm_temperature, DEFAULT_LLM.temperature),
      maxTokens: int(row.llm_max_tokens, DEFAULT_LLM.maxTokens),
      fastModel: str(row.llm_fast_model, DEFAULT_LLM.fastModel),
      timeoutMs: int(row.llm_timeout_ms, DEFAULT_LLM.timeoutMs),
      contextTokens: int(row.llm_context_tokens, DEFAULT_LLM.contextTokens) || DEFAULT_LLM.contextTokens,
    },
    dataSources: mergeDataSources(DEFAULT_DATA_SOURCES, dataSources),
    toolPolicy: mergeToolPolicy(DEFAULT_TOOL_POLICY, parseJson<Partial<ToolPolicy>>(row.tool_policy)),
    mcpServers: parseJson<McpServerConfig[]>(row.mcp_servers) ?? [...DEFAULT_MCP_SERVERS],
    budget: {
      CN: toNumber(row.budget_cny, DEFAULT_BUDGET.CN),
      HK: toNumber(row.budget_hkd, DEFAULT_BUDGET.HK),
      US: toNumber(row.budget_usd, DEFAULT_BUDGET.US),
    },
    schedules: rowToSchedules(row),
    enforceBudget: bool(row.enforce_budget, DEFAULT_ENFORCE_BUDGET),
    watchlistCandidateLimit: int(row.watchlist_candidate_limit, DEFAULT_WATCHLIST_CANDIDATE_LIMIT),
    watchlistRetireDeleteRuns: int(row.watchlist_retire_delete_runs, DEFAULT_WATCHLIST_RETIRE_DELETE_RUNS),
    option: {
      cash: {
        HK: toNumber(row.option_cash_hkd, DEFAULT_OPTION_SETTINGS.cash.HK),
        US: toNumber(row.option_cash_usd, DEFAULT_OPTION_SETTINGS.cash.US),
      },
      settlementMode:
        row.option_settle_mode === 'manual' || row.option_settle_mode === 'auto'
          ? row.option_settle_mode
          : DEFAULT_OPTION_SETTINGS.settlementMode,
      runWithPipeline: bool(row.option_run_with_pipeline, DEFAULT_OPTION_SETTINGS.runWithPipeline),
    },
    lastRunAt: nullableStr(row.last_run_at),
    updatedAt: str(row.updated_at, nowIso()),
  };
}

/* ── 定时任务（数组）：读取时兼容旧库的单任务列 ─────────────────────────── */

/** 一条任务的防御性归一化；返回 null 表示这条数据不可用（直接丢弃）。 */
function normalizeScheduleTask(input: unknown): ScheduleTask | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const mode = raw.mode === 'interval' || raw.mode === 'daily' ? raw.mode : null;
  if (id === '' || mode === null) return null;
  const dailyTime = typeof raw.dailyTime === 'string' && /^\d{2}:\d{2}$/.test(raw.dailyTime) ? raw.dailyTime : DEFAULT_SCHEDULE_TASK.dailyTime;
  const intervalMinutes = Math.min(100_000, Math.max(1, Math.floor(toNumber(raw.intervalMinutes, DEFAULT_SCHEDULE_TASK.intervalMinutes))));
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : id,
    enabled: raw.enabled === undefined ? true : raw.enabled === true,
    mode,
    intervalMinutes,
    dailyTime,
    runAssetAnalysis: raw.runAssetAnalysis === undefined ? true : raw.runAssetAnalysis === true,
    runWatchlistAnalysis: raw.runWatchlistAnalysis === undefined ? true : raw.runWatchlistAnalysis === true,
    // 2026-10 新增的打新分析步骤：老任务没有该字段时按「开启」处理（与其它步骤一致）。
    runIpoAnalysis: raw.runIpoAnalysis === undefined ? true : raw.runIpoAnalysis === true,
    runAdvice: raw.runAdvice === undefined ? true : raw.runAdvice === true,
  };
}

/** 数组归一化：丢弃坏条目、去重（同 id 只保留第一条）。 */
export function normalizeSchedules(input: unknown): ScheduleTask[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: ScheduleTask[] = [];
  for (const item of input) {
    const task = normalizeScheduleTask(item);
    if (!task || seen.has(task.id)) continue;
    seen.add(task.id);
    out.push(task);
  }
  return out;
}

/**
 * `settings.schedules` 的读取：新列优先；新列为空时兼容旧库的单任务列
 * （`mode='off'` → 空数组）。旧列在每次保存时由 {@link schedulesToLegacy} 同步，
 * 因此「用户删光任务」不会被误判成「旧库还没迁移」。
 */
function rowToSchedules(row: Row): ScheduleTask[] {
  const parsed = normalizeSchedules(parseJson<unknown>(row.schedules));
  if (parsed.length > 0) return parsed;

  const legacyMode = str(row.schedule_mode, 'off');
  if (legacyMode !== 'interval' && legacyMode !== 'daily') return [];
  return [
    {
      id: 'sched_legacy',
      name: '默认定时任务',
      enabled: true,
      mode: legacyMode,
      intervalMinutes: int(row.schedule_interval_minutes, DEFAULT_SCHEDULE_TASK.intervalMinutes),
      dailyTime: str(row.schedule_daily_time, DEFAULT_SCHEDULE_TASK.dailyTime),
      runAssetAnalysis: bool(row.schedule_run_asset, DEFAULT_SCHEDULE_TASK.runAssetAnalysis),
      runWatchlistAnalysis: bool(row.schedule_run_watchlist, DEFAULT_SCHEDULE_TASK.runWatchlistAnalysis),
      runIpoAnalysis: DEFAULT_SCHEDULE_TASK.runIpoAnalysis,
      runAdvice: bool(row.schedule_run_advice, DEFAULT_SCHEDULE_TASK.runAdvice),
    },
  ];
}

/**
 * 旧列同步（可回滚）：把第一个启用任务写进 `schedule_*` 列，没有启用任务就写 `off`。
 * 这样用旧版本代码打开同一个库时，排程行为仍然合理（而不是静默全部失效）。
 */
function schedulesToLegacy(tasks: ScheduleTask[]): {
  mode: string;
  intervalMinutes: number;
  dailyTime: string;
  runAsset: boolean;
  runWatchlist: boolean;
  runAdvice: boolean;
} {
  const task = tasks.find((item) => item.enabled);
  if (!task) {
    return {
      mode: 'off',
      intervalMinutes: DEFAULT_SCHEDULE_TASK.intervalMinutes,
      dailyTime: DEFAULT_SCHEDULE_TASK.dailyTime,
      runAsset: DEFAULT_SCHEDULE_TASK.runAssetAnalysis,
      runWatchlist: DEFAULT_SCHEDULE_TASK.runWatchlistAnalysis,
      runAdvice: DEFAULT_SCHEDULE_TASK.runAdvice,
    };
  }
  return {
    mode: task.mode,
    intervalMinutes: task.intervalMinutes,
    dailyTime: task.dailyTime,
    runAsset: task.runAssetAnalysis,
    runWatchlist: task.runWatchlistAnalysis,
    runAdvice: task.runAdvice,
  };
}

function mergeToolPolicy(base: ToolPolicy, patch?: Partial<ToolPolicy> | null): ToolPolicy {
  if (!patch) return { ...base, deny: [...base.deny] };
  return {
    deny: Array.isArray(patch.deny) ? patch.deny.filter((name): name is string => typeof name === 'string') : [...base.deny],
    requireWriteApproval:
      typeof patch.requireWriteApproval === 'boolean' ? patch.requireWriteApproval : base.requireWriteApproval,
  };
}

function rowToAudit(row: Row): AuditRow {
  return {
    id: str(row.id),
    at: str(row.at),
    runId: nullableStr(row.run_id),
    sessionId: nullableStr(row.session_id),
    tool: str(row.tool),
    risk: str(row.risk, 'read') as ToolRisk,
    outcome: str(row.outcome, 'executed') as AuditRow['outcome'],
    entity: nullableStr(row.entity),
    entityId: nullableStr(row.entity_id),
    summary: str(row.summary),
    args: str(row.args),
  };
}

function rowToPendingWrite(row: Row): PendingWriteRow {
  return {
    id: str(row.id),
    runId: nullableStr(row.run_id),
    sessionId: nullableStr(row.session_id),
    tool: str(row.tool),
    args: str(row.args, '{}'),
    summary: str(row.summary),
    risk: str(row.risk, 'write') as ToolRisk,
    status: str(row.status, 'pending') as PendingWriteStatus,
    createdAt: str(row.created_at),
    decidedAt: nullableStr(row.decided_at),
    result: nullableStr(row.result),
  };
}

function rowToRunMessage(row: Row): RunMessageRow {
  return {
    id: str(row.id),
    runId: str(row.run_id),
    index: int(row.idx),
    role: str(row.role, 'user') as RunMessageRow['role'],
    content: str(row.content),
    toolCalls: nullableStr(row.tool_calls),
    toolCallId: nullableStr(row.tool_call_id),
    name: nullableStr(row.name),
    reasoningContent: nullableStr(row.reasoning_content),
    createdAt: str(row.created_at),
  };
}

function rowToAdviceOutcome(row: Row): AdviceOutcomeRow {
  return {
    adviceId: str(row.advice_id),
    runId: nullableStr(row.run_id),
    code: str(row.code),
    market: str(row.market, 'CN') as Market,
    type: str(row.type, 'stock') as InstrumentType,
    action: str(row.action, 'buy') as AdviceAction,
    currency: str(row.currency, 'CNY'),
    advisedAt: str(row.advised_at),
    adviceStatus: str(row.advice_status, 'pending') as AdviceStatus,
    executed: bool(row.executed, false),
    baselineDate: str(row.baseline_date),
    baselinePrice: toNumber(row.baseline_price),
    lastDate: str(row.last_date),
    lastPrice: toNumber(row.last_price),
    priceChangePct: toNumber(row.price_change_pct),
    adviceReturnPct: toNumber(row.advice_return_pct),
    benchmarkCode: str(row.benchmark_code),
    benchmarkName: str(row.benchmark_name),
    benchmarkBase: toNumber(row.benchmark_base),
    benchmarkChangePct: toNumber(row.benchmark_change_pct),
    excessPct: toNumber(row.excess_pct),
    maxReturnPct: toNumber(row.max_return_pct),
    minReturnPct: toNumber(row.min_return_pct),
    samples: int(row.samples),
    daysTracked: int(row.days_tracked),
    status: str(row.status, 'tracking') as AdviceOutcomeStatus,
    warnings: toStringArray(row.warnings),
    updatedAt: str(row.updated_at),
  };
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}function mergeDataSources(
  base: StoredSettings['dataSources'],
  patch?: Partial<StoredSettings['dataSources']> | null,
): StoredSettings['dataSources'] {
  const merged = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(base) as (keyof StoredSettings['dataSources'])[]) {
    const next = patch?.[key];
    merged[key] = next ? { ...(base[key] as object), ...next } : { ...(base[key] as object) };
  }
  return merged as unknown as StoredSettings['dataSources'];
}

function withoutUndefined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out as Partial<T>;
}

/** `true` when the value can be bound by `node:sqlite`. */
function bind(value: unknown): string | number | bigint | null | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' || typeof value === 'bigint' || value instanceof Uint8Array) return value;
  if (typeof value === 'object') return stringifyJson(value);
  return String(value);
}

function wrapDbError(error: unknown, duplicateMessage: string, fkMessage: string): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed/i.test(message)) throw conflict(duplicateMessage, { cause: message });
  if (/FOREIGN KEY constraint failed/i.test(message)) throw badRequest(fkMessage, { cause: message });
  throw error;
}

const DEFAULT_CURRENCY = (market: string): string => MARKET_CURRENCY[market as keyof typeof MARKET_CURRENCY] ?? 'CNY';

/** D7: per-message cap for persisted run transcripts (see `addRunMessage`). */
const MAX_RUN_MESSAGE_CHARS = 20_000;
/**
 * `user` messages get a much larger cap.
 *
 * The first user message is the run's goal, and the pipelines embed the whole
 * pre-fetched dataset in it as JSON. Cutting it at 20k characters left
 * `resumeRunId` (P1-3) replaying a **half-JSON payload** — the model then answered
 * `Unterminated string in JSON` and re-fetched everything. The producer already
 * caps the payload (`MAX_GOAL_PAYLOAD_CHARS`, ~60k), so a 4× headroom costs
 * nothing and keeps the transcript resumable.
 */
const MAX_RUN_USER_MESSAGE_CHARS = 250_000;

/**
 * `clearAllData` 清空的表。数组顺序即删除顺序：子表在父表之前，避免外键约束
 * （`transactions.asset_id → assets.id`）。表名来自本常量而非请求参数。
 */
const CLEARED_TABLES = [
  'transactions',
  'assets',
  'watchlist',
  'advice',
  'advice_outcomes',
  // 期权卖权：结算记录指向合约，先删子表。
  'option_settlements',
  'option_contracts',
  'ipo_subscriptions',
  'ipo_offers',
  'agent_steps',
  'agent_run_messages',
  'agent_runs',
  'chat_messages',
  'chat_sessions',
  'audit_log',
  'pending_writes',
  'kv',
] as const;

type ClearedTable = (typeof CLEARED_TABLES)[number];

/* ───────────────────────────────── factory ────────────────────────────────── */

export function createRepo(dbPath: string): Repo {
  return new SqliteRepo(dbPath);
}

class SqliteRepo implements Repo {
  private readonly db: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private inTransaction = false;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  /* ── lifecycle ─────────────────────────────────────────────────────────── */

  private stmt(sql: string): StatementSync {
    let cached = this.cache.get(sql);
    if (!cached) {
      cached = this.db.prepare(sql);
      this.cache.set(sql, cached);
    }
    return cached;
  }

  private run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const result = this.stmt(sql).run(...(params.map(bind) as never[]));
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  private get(sql: string, ...params: unknown[]): Row | undefined {
    const row = this.stmt(sql).get(...(params.map(bind) as never[]));
    return row === undefined ? undefined : (row as unknown as Row);
  }

  private all(sql: string, ...params: unknown[]): Row[] {
    return this.stmt(sql).all(...(params.map(bind) as never[])) as unknown as Row[];
  }

  migrate(): void {
    migrateSchema(this.db);
    this.seedSettings();
  }

  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN');
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* the transaction may already be aborted */
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  close(): void {
    this.cache.clear();
    this.db.close();
  }

  /* ── settings ──────────────────────────────────────────────────────────── */

  private seedSettings(): void {
    this.run(
      `INSERT INTO settings (
         id, persona, report_style, llm_base_url, llm_api_key, llm_model, llm_temperature, llm_max_tokens,
         llm_fast_model, llm_timeout_ms, llm_context_tokens, data_sources, tool_policy, mcp_servers, budget_cny,
         budget_hkd, budget_usd, enforce_budget,
         watchlist_candidate_limit, watchlist_retire_delete_runs, schedule_mode, schedule_interval_minutes, schedule_daily_time,
         schedule_run_asset, schedule_run_watchlist, schedule_run_advice, schedules, last_run_at, updated_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(id) DO NOTHING`,
      DEFAULT_PERSONA,
      DEFAULT_REPORT_STYLE,
      DEFAULT_LLM.baseUrl,
      DEFAULT_LLM.apiKey,
      DEFAULT_LLM.model,
      DEFAULT_LLM.temperature,
      DEFAULT_LLM.maxTokens,
      DEFAULT_LLM.fastModel,
      DEFAULT_LLM.timeoutMs,
      DEFAULT_LLM.contextTokens,
      stringifyJson(DEFAULT_DATA_SOURCES),
      stringifyJson(DEFAULT_TOOL_POLICY),
      stringifyJson(DEFAULT_MCP_SERVERS),
      DEFAULT_BUDGET.CN,
      DEFAULT_BUDGET.HK,
      DEFAULT_BUDGET.US,
      DEFAULT_ENFORCE_BUDGET ? 1 : 0,
      DEFAULT_WATCHLIST_CANDIDATE_LIMIT,
      DEFAULT_WATCHLIST_RETIRE_DELETE_RUNS,
      'off',
      DEFAULT_SCHEDULE_TASK.intervalMinutes,
      DEFAULT_SCHEDULE_TASK.dailyTime,
      DEFAULT_SCHEDULE_TASK.runAssetAnalysis ? 1 : 0,
      DEFAULT_SCHEDULE_TASK.runWatchlistAnalysis ? 1 : 0,
      DEFAULT_SCHEDULE_TASK.runAdvice ? 1 : 0,
      stringifyJson([]),
      nowIso(),
    );
  }

  getSettings(): StoredSettings {
    this.seedSettings();
    const row = this.get('SELECT * FROM settings WHERE id = 1');
    return row ? rowToSettings(row) : rowToSettings({});
  }

  saveSettings(patch: Partial<StoredSettings> & { llm?: Partial<StoredSettings['llm']> }): StoredSettings {
    const current = this.getSettings();
    const merged: StoredSettings = {
      persona: patch.persona ?? current.persona,
      reportStyle: patch.reportStyle ?? current.reportStyle,
      llm: { ...current.llm, ...withoutUndefined(patch.llm) },
      dataSources: mergeDataSources(current.dataSources, patch.dataSources),
      budget: { ...current.budget, ...withoutUndefined(patch.budget) },
      schedules: patch.schedules !== undefined ? normalizeSchedules(patch.schedules) : current.schedules,
      enforceBudget: patch.enforceBudget ?? current.enforceBudget,
      watchlistCandidateLimit: patch.watchlistCandidateLimit ?? current.watchlistCandidateLimit,
      watchlistRetireDeleteRuns: patch.watchlistRetireDeleteRuns ?? current.watchlistRetireDeleteRuns,
      toolPolicy: mergeToolPolicy(current.toolPolicy, patch.toolPolicy),
      mcpServers: patch.mcpServers !== undefined ? patch.mcpServers : current.mcpServers,
      option: {
        cash: { ...current.option.cash, ...withoutUndefined(patch.option?.cash) },
        settlementMode: patch.option?.settlementMode ?? current.option.settlementMode,
        runWithPipeline: patch.option?.runWithPipeline ?? current.option.runWithPipeline,
      },
      lastRunAt: patch.lastRunAt !== undefined ? patch.lastRunAt : current.lastRunAt,
      updatedAt: nowIso(),
    };
    const legacy = schedulesToLegacy(merged.schedules);

    this.run(
      `UPDATE settings SET
         persona = ?, report_style = ?, llm_base_url = ?, llm_api_key = ?, llm_model = ?, llm_temperature = ?,
         llm_max_tokens = ?, llm_fast_model = ?, llm_timeout_ms = ?, llm_context_tokens = ?, data_sources = ?,
         tool_policy = ?, mcp_servers = ?, budget_cny = ?,
         budget_hkd = ?, budget_usd = ?, enforce_budget = ?, watchlist_candidate_limit = ?,
         watchlist_retire_delete_runs = ?, schedule_mode = ?,
         schedule_interval_minutes = ?, schedule_daily_time = ?, schedule_run_asset = ?, schedule_run_watchlist = ?,
         schedule_run_advice = ?, schedules = ?, option_cash_hkd = ?, option_cash_usd = ?,
         option_settle_mode = ?, option_run_with_pipeline = ?, last_run_at = ?, updated_at = ?
       WHERE id = 1`,
      merged.persona,
      merged.reportStyle,
      merged.llm.baseUrl,
      merged.llm.apiKey,
      merged.llm.model,
      merged.llm.temperature,
      merged.llm.maxTokens,
      merged.llm.fastModel,
      merged.llm.timeoutMs,
      merged.llm.contextTokens,
      stringifyJson(merged.dataSources),
      stringifyJson(merged.toolPolicy),
      stringifyJson(merged.mcpServers),
      merged.budget.CN,
      merged.budget.HK,
      merged.budget.US,
      merged.enforceBudget ? 1 : 0,
      merged.watchlistCandidateLimit,
      merged.watchlistRetireDeleteRuns,
      // 旧列同步：第一个启用任务（没有就写 off），保证用旧版本代码打开同一库时排程仍然合理。
      legacy.mode,
      legacy.intervalMinutes,
      legacy.dailyTime,
      legacy.runAsset ? 1 : 0,
      legacy.runWatchlist ? 1 : 0,
      legacy.runAdvice ? 1 : 0,
      stringifyJson(merged.schedules),
      merged.option.cash.HK,
      merged.option.cash.US,
      merged.option.settlementMode,
      merged.option.runWithPipeline ? 1 : 0,
      merged.lastRunAt,
      merged.updatedAt,
    );
    return merged;
  }

  /* ── assets ────────────────────────────────────────────────────────────── */

  listAssets(): AssetRow[] {
    return this.all('SELECT * FROM assets ORDER BY created_at DESC, name ASC').map(rowToAsset);
  }

  getAsset(id: string): AssetRow | undefined {
    const row = this.get('SELECT * FROM assets WHERE id = ?', id);
    return row ? rowToAsset(row) : undefined;
  }

  findAsset(code: string, market: string, type: string): AssetRow | undefined {
    const row = this.get('SELECT * FROM assets WHERE code = ? AND market = ? AND type = ?', code, market, type);
    return row ? rowToAsset(row) : undefined;
  }

  createAsset(input: NewAsset): AssetRow {
    try {
      this.run(
        `INSERT INTO assets (
           id, name, code, market, type, source, currency, note, ai_summary, ai_summary_at, thesis,
           quality_score, target_price, expected_return, price, price_at, price_prev_close, day_change_pct,
           spark, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', NULL, '', 0, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
        input.id,
        input.name ?? '',
        input.code,
        input.market,
        input.type,
        input.source ?? 'manual',
        input.currency ?? DEFAULT_CURRENCY(input.market),
        input.note ?? '',
        input.price ?? 0,
        input.priceAt ?? null,
        input.prevClose ?? 0,
        input.dayChangePct ?? 0,
        stringifyJson(input.spark ?? []),
        input.createdAt ?? nowIso(),
        nowIso(),
      );
    } catch (error) {
      wrapDbError(error, `资产已存在：${input.code}（${input.market}/${input.type}）`, '资产写入失败：关联记录缺失');
    }
    const created = this.getAsset(input.id);
    if (!created) throw new Error(`createAsset: row ${input.id} disappeared after insert`);
    return created;
  }

  updateAsset(id: string, patch: AssetPatch): AssetRow | undefined {
    const map: Array<[keyof AssetPatch, string]> = [
      ['name', 'name'],
      ['note', 'note'],
      ['market', 'market'],
      ['type', 'type'],
      ['currency', 'currency'],
      ['thesis', 'thesis'],
      ['qualityScore', 'quality_score'],
      ['targetPrice', 'target_price'],
      ['expectedReturn', 'expected_return'],
      ['aiSummary', 'ai_summary'],
      ['aiSummaryAt', 'ai_summary_at'],
      ['price', 'price'],
      ['priceAt', 'price_at'],
      ['prevClose', 'price_prev_close'],
      ['dayChangePct', 'day_change_pct'],
      ['spark', 'spark'],
    ];
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of map) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(key === 'spark' ? stringifyJson(value) : value);
    }
    if (sets.length === 0) return this.getAsset(id);
    sets.push('updated_at = ?');
    values.push(nowIso());
    try {
      const result = this.run(`UPDATE assets SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
      if (result.changes === 0) return undefined;
    } catch (error) {
      wrapDbError(error, '资产更新失败：同市场下已存在相同代码与类型', '资产更新失败：关联记录缺失');
    }
    return this.getAsset(id);
  }

  deleteAsset(id: string): boolean {
    return this.transaction(() => {
      this.run('DELETE FROM transactions WHERE asset_id = ?', id);
      // 卖出的期权是真实义务，绝不级联删除合约；只把指向已删资产的引用解绑，
      // 否则「覆盖式卖 Call 的持股校验」与资产详情联动会读到脏 id。
      // 合约自带 underlying_code / underlying_name 冗余字段，解绑后信息依然完整。
      this.run('UPDATE option_contracts SET underlying_asset_id = NULL WHERE underlying_asset_id = ?', id);
      // 交割结算行同理：结算记录本身有 contract_id 可回溯，解绑 asset_id 后历史仍完整。
      this.run('UPDATE option_settlements SET asset_id = NULL WHERE asset_id = ?', id);
      return this.run('DELETE FROM assets WHERE id = ?', id).changes > 0;
    });
  }

  /* ── transactions ──────────────────────────────────────────────────────── */

  listTransactions(assetId?: string): TxRow[] {
    const rows = assetId
      ? this.all('SELECT * FROM transactions WHERE asset_id = ? ORDER BY trade_date ASC, created_at ASC', assetId)
      : this.all('SELECT * FROM transactions ORDER BY trade_date ASC, created_at ASC');
    return rows.map(rowToTx);
  }

  getTransaction(id: string): TxRow | undefined {
    const row = this.get('SELECT * FROM transactions WHERE id = ?', id);
    return row ? rowToTx(row) : undefined;
  }

  addTransaction(input: NewTx): TxRow {
    try {
      this.run(
        `INSERT INTO transactions (id, asset_id, kind, shares, price, fee, trade_date, note, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.id,
        input.assetId,
        input.kind,
        input.shares,
        input.price,
        input.fee ?? 0,
        input.tradeDate,
        input.note ?? '',
        input.source ?? 'manual',
        input.createdAt ?? nowIso(),
      );
    } catch (error) {
      wrapDbError(error, '交易已存在', '交易写入失败：持仓记录不存在');
    }
    const created = this.getTransaction(input.id);
    if (!created) throw new Error(`addTransaction: row ${input.id} disappeared after insert`);
    return created;
  }

  deleteTransaction(id: string): boolean {
    return this.run('DELETE FROM transactions WHERE id = ?', id).changes > 0;
  }

  /* ── watchlist ─────────────────────────────────────────────────────────── */

  /**
   * `status` defaults to `'active'`: 已退役的标的不参与建议生成与候选挖掘，
   * 但在 prompt / 备份 / 仪表盘计数里需要看到它们，那些调用点显式传 `'all'`。
   */
  listWatchlist(status: WatchlistStatusFilter = 'active'): WatchRow[] {
    const where = status === 'all' ? '' : ` WHERE status = '${status === 'retired' ? 'retired' : 'active'}'`;
    return this.all(`SELECT * FROM watchlist${where} ORDER BY created_at DESC, name ASC`).map(rowToWatch);
  }

  getWatchItem(id: string): WatchRow | undefined {
    const row = this.get('SELECT * FROM watchlist WHERE id = ?', id);
    return row ? rowToWatch(row) : undefined;
  }

  findWatchItem(code: string, market: string, type: string): WatchRow | undefined {
    const row = this.get('SELECT * FROM watchlist WHERE code = ? AND market = ? AND type = ?', code, market, type);
    return row ? rowToWatch(row) : undefined;
  }

  createWatchItem(input: NewWatch): WatchRow {
    try {
      this.run(
        `INSERT INTO watchlist (
           id, name, code, market, type, source, quality_score, target_price, expected_return, expected_return_horizon,
           initial_price, initial_price_at, price, price_at, price_prev_close, day_change_pct, thesis, note, ai_summary,
           ai_summary_at, spark, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, '', ?, '', NULL, ?, ?, ?)`,
        input.id,
        input.name ?? '',
        input.code,
        input.market,
        input.type,
        input.source ?? 'manual',
        input.expectedReturnHorizon ?? '',
        input.initialPrice ?? 0,
        input.initialPriceAt ?? null,
        input.price ?? 0,
        input.priceAt ?? null,
        input.prevClose ?? 0,
        input.dayChangePct ?? 0,
        input.note ?? '',
        stringifyJson(input.spark ?? []),
        input.createdAt ?? nowIso(),
        nowIso(),
      );
    } catch (error) {
      wrapDbError(error, `标的已存在：${input.code}（${input.market}/${input.type}）`, '标的写入失败：关联记录缺失');
    }
    const created = this.getWatchItem(input.id);
    if (!created) throw new Error(`createWatchItem: row ${input.id} disappeared after insert`);
    return created;
  }

  updateWatchItem(id: string, patch: WatchPatch): WatchRow | undefined {
    const map: Array<[keyof WatchPatch, string]> = [
      ['name', 'name'],
      ['note', 'note'],
      ['market', 'market'],
      ['type', 'type'],
      ['qualityScore', 'quality_score'],
      ['targetPrice', 'target_price'],
      ['expectedReturn', 'expected_return'],
      ['expectedReturnHorizon', 'expected_return_horizon'],
      ['thesis', 'thesis'],
      ['aiSummary', 'ai_summary'],
      ['aiSummaryAt', 'ai_summary_at'],
      ['initialPrice', 'initial_price'],
      ['initialPriceAt', 'initial_price_at'],
      ['price', 'price'],
      ['priceAt', 'price_at'],
      ['prevClose', 'price_prev_close'],
      ['dayChangePct', 'day_change_pct'],
      ['spark', 'spark'],
      ['source', 'source'],
      ['status', 'status'],
      ['retiredReason', 'retired_reason'],
      ['retiredAt', 'retired_at'],
      ['retireStreak', 'retire_streak'],
    ];
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of map) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(key === 'spark' ? stringifyJson(value) : value);
    }
    if (sets.length === 0) return this.getWatchItem(id);
    sets.push('updated_at = ?');
    values.push(nowIso());
    try {
      const result = this.run(`UPDATE watchlist SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
      if (result.changes === 0) return undefined;
    } catch (error) {
      wrapDbError(error, '标的更新失败：同市场下已存在相同代码与类型', '标的更新失败：关联记录缺失');
    }
    return this.getWatchItem(id);
  }

  deleteWatchItem(id: string): boolean {
    return this.run('DELETE FROM watchlist WHERE id = ?', id).changes > 0;
  }

  /** 在池 / 已退役计数（仪表盘用，避免把退役标的算进「我的标的」）。 */
  countWatchlist(): { active: number; retired: number } {
    const row = this.get(
      `SELECT
         SUM(CASE WHEN status = 'retired' THEN 0 ELSE 1 END) AS active,
         SUM(CASE WHEN status = 'retired' THEN 1 ELSE 0 END) AS retired
       FROM watchlist`,
    );
    return { active: int(row?.active, 0), retired: int(row?.retired, 0) };
  }

  clearWatchlist(): number {
    return this.run('DELETE FROM watchlist').changes;
  }

  /* ── 新股打新 (IPO) ────────────────────────────────────────────────────── */

  /**
   * 打新标的列表。
   *
   * 排序刻意用「申购日倒序 + 上市日倒序」：最新的发行季在最上面，而还没确定申购日
   * 的（`subscribe_start IS NULL`）退到后面 —— SQLite 里 `NULL` 排在最前，所以显式
   * 用 `IS NULL` 作为第一排序键。
   */
  listIpoOffers(filter: { market?: Market; status?: IpoMarketStatus; limit?: number } = {}): IpoOfferRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.market) {
      where.push('market = ?');
      params.push(filter.market);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    const limit = Number.isFinite(filter.limit) && (filter.limit ?? 0) > 0 ? Math.trunc(filter.limit as number) : 500;
    const sql =
      `SELECT * FROM ipo_offers${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}` +
      ` ORDER BY subscribe_start IS NULL, subscribe_start DESC, listing_date IS NULL, listing_date DESC, name ASC LIMIT ?`;
    return this.all(sql, ...params, limit).map(rowToIpoOffer);
  }

  getIpoOffer(id: string): IpoOfferRow | undefined {
    const row = this.get('SELECT * FROM ipo_offers WHERE id = ?', id);
    return row ? rowToIpoOffer(row) : undefined;
  }

  findIpoOfferByUid(uid: string): IpoOfferRow | undefined {
    const row = this.get('SELECT * FROM ipo_offers WHERE uid = ?', uid);
    return row ? rowToIpoOffer(row) : undefined;
  }

  createIpoOffer(input: NewIpoOffer): IpoOfferRow {
    try {
      this.run(
        `INSERT INTO ipo_offers (
           id, uid, market, code, subscribe_code, name, source, exchange, board, issue_price, price_low, price_high,
           currency, lot_size, max_shares, subscribe_start, subscribe_end, allotment_date, listing_date, issue_shares,
           raise_amount, issue_pe, industry_pe, winning_rate, oversubscribe, sponsor, industry, prospectus_url, status,
           note, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.id,
        input.uid,
        input.market,
        input.code ?? '',
        input.subscribeCode ?? '',
        input.name ?? '',
        input.source ?? 'manual',
        input.exchange ?? '',
        input.board ?? '',
        input.issuePrice ?? 0,
        input.priceLow ?? 0,
        input.priceHigh ?? 0,
        input.currency ?? DEFAULT_CURRENCY(input.market),
        input.lotSize ?? 0,
        input.maxShares ?? 0,
        input.subscribeStart ?? null,
        input.subscribeEnd ?? null,
        input.allotmentDate ?? null,
        input.listingDate ?? null,
        input.issueShares ?? 0,
        input.raiseAmount ?? 0,
        input.issuePe ?? 0,
        input.industryPe ?? 0,
        input.winningRate ?? 0,
        input.oversubscribe ?? 0,
        input.sponsor ?? '',
        input.industry ?? '',
        input.prospectusUrl ?? '',
        input.status ?? 'unknown',
        input.note ?? '',
        input.createdAt ?? nowIso(),
        nowIso(),
      );
    } catch (error) {
      wrapDbError(error, `新股已存在：${input.uid}`, '新股写入失败：关联记录缺失');
    }
    const created = this.getIpoOffer(input.id);
    if (!created) throw new Error(`createIpoOffer: row ${input.id} disappeared after insert`);
    return created;
  }

  updateIpoOffer(id: string, patch: IpoOfferPatch): IpoOfferRow | undefined {
    const map: Array<[keyof IpoOfferPatch, string]> = [
      ['market', 'market'],
      ['code', 'code'],
      ['subscribeCode', 'subscribe_code'],
      ['name', 'name'],
      ['source', 'source'],
      ['exchange', 'exchange'],
      ['board', 'board'],
      ['issuePrice', 'issue_price'],
      ['priceLow', 'price_low'],
      ['priceHigh', 'price_high'],
      ['currency', 'currency'],
      ['lotSize', 'lot_size'],
      ['maxShares', 'max_shares'],
      ['subscribeStart', 'subscribe_start'],
      ['subscribeEnd', 'subscribe_end'],
      ['allotmentDate', 'allotment_date'],
      ['listingDate', 'listing_date'],
      ['issueShares', 'issue_shares'],
      ['raiseAmount', 'raise_amount'],
      ['issuePe', 'issue_pe'],
      ['industryPe', 'industry_pe'],
      ['winningRate', 'winning_rate'],
      ['oversubscribe', 'oversubscribe'],
      ['sponsor', 'sponsor'],
      ['industry', 'industry'],
      ['prospectusUrl', 'prospectus_url'],
      ['status', 'status'],
      ['advice', 'advice'],
      ['verdict', 'verdict'],
      ['verdictReason', 'verdict_reason'],
      ['suggestedShares', 'suggested_shares'],
      ['winProbability', 'win_probability'],
      ['expectedReturn', 'expected_return'],
      ['confidence', 'confidence'],
      ['qualityScore', 'quality_score'],
      ['adviceAt', 'advice_at'],
      ['adviceRunId', 'advice_run_id'],
      ['note', 'note'],
    ];
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of map) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value);
    }
    if (sets.length === 0) return this.getIpoOffer(id);
    sets.push('updated_at = ?');
    values.push(nowIso());
    try {
      const result = this.run(`UPDATE ipo_offers SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
      if (result.changes === 0) return undefined;
    } catch (error) {
      wrapDbError(error, '新股更新失败：已存在相同 uid 的记录', '新股更新失败：关联记录缺失');
    }
    return this.getIpoOffer(id);
  }

  deleteIpoOffer(id: string): boolean {
    return this.transaction(() => {
      const row = this.get('SELECT uid FROM ipo_offers WHERE id = ?', id);
      if (!row) return false;
      // 申购记录按 uid 关联（不是外键），必须显式删除，否则会留下悬挂记录。
      this.run('DELETE FROM ipo_subscriptions WHERE offer_uid = ?', str(row.uid));
      return this.run('DELETE FROM ipo_offers WHERE id = ?', id).changes > 0;
    });
  }

  listIpoSubscriptions(): IpoSubscriptionRow[] {
    return this.all('SELECT * FROM ipo_subscriptions ORDER BY applied_at DESC, name ASC').map(rowToIpoSubscription);
  }

  getIpoSubscription(offerUid: string): IpoSubscriptionRow | undefined {
    const row = this.get('SELECT * FROM ipo_subscriptions WHERE offer_uid = ?', offerUid);
    return row ? rowToIpoSubscription(row) : undefined;
  }

  /**
   * 插入或更新申购记录（按 `offerUid` 唯一）。
   *
   * 刻意做成 upsert 而不是 create/update 两个方法：登记申购与录入中签都作用于同一条
   * 记录，重复提交（网络重试、AI 工具重复调用）必须收敛成一条，而不是报冲突或产生第二行。
   */
  upsertIpoSubscription(input: NewIpoSubscription): IpoSubscriptionRow {
    const existing = this.getIpoSubscription(input.offerUid);
    const now = nowIso();
    if (existing) {
      const patch: Array<[unknown, string]> = [
        [input.status, 'status'],
        [input.appliedShares, 'applied_shares'],
        [input.allottedShares, 'allotted_shares'],
        [input.price, 'price'],
        [input.fee, 'fee'],
        [input.currency, 'currency'],
        [input.appliedAt, 'applied_at'],
        [input.allottedAt, 'allotted_at'],
        [input.assetId, 'asset_id'],
        [input.transactionId, 'transaction_id'],
        [input.note, 'note'],
        [input.code, 'code'],
        [input.name, 'name'],
      ];
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [value, column] of patch) {
        if (value === undefined) continue;
        sets.push(`${column} = ?`);
        values.push(value);
      }
      if (sets.length > 0) {
        sets.push('updated_at = ?');
        values.push(now);
        this.run(`UPDATE ipo_subscriptions SET ${sets.join(', ')} WHERE id = ?`, ...values, existing.id);
      }
      const updated = this.getIpoSubscription(input.offerUid);
      if (!updated) throw new Error(`upsertIpoSubscription: row ${existing.id} disappeared after update`);
      return updated;
    }
    this.run(
      `INSERT INTO ipo_subscriptions (
         id, offer_uid, market, code, name, status, applied_shares, allotted_shares, price, fee, currency,
         applied_at, allotted_at, asset_id, transaction_id, note, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.offerUid,
      input.market,
      input.code ?? '',
      input.name ?? '',
      input.status ?? 'applied',
      input.appliedShares ?? 0,
      input.allottedShares ?? 0,
      input.price ?? 0,
      input.fee ?? 0,
      input.currency ?? DEFAULT_CURRENCY(input.market),
      input.appliedAt,
      input.allottedAt ?? null,
      input.assetId ?? null,
      input.transactionId ?? null,
      input.note ?? '',
      input.createdAt ?? now,
      now,
    );
    const created = this.getIpoSubscription(input.offerUid);
    if (!created) throw new Error(`upsertIpoSubscription: row ${input.offerUid} disappeared after insert`);
    return created;
  }

  deleteIpoSubscription(id: string): boolean {
    return this.run('DELETE FROM ipo_subscriptions WHERE id = ?', id).changes > 0;
  }

  /* ── advice ────────────────────────────────────────────────────────────── */

  listAdvice(filter: { status?: AdviceRow['status']; batchId?: string; limit?: number } = {}): AdviceRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.batchId) {
      where.push('batch_id = ?');
      params.push(filter.batchId);
    }
    const limit = filter.limit && filter.limit > 0 ? ` LIMIT ${Math.trunc(filter.limit)}` : '';
    const sql = `SELECT * FROM advice${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC${limit}`;
    return this.all(sql, ...params).map(rowToAdvice);
  }

  getAdvice(id: string): AdviceRow | undefined {
    const row = this.get('SELECT * FROM advice WHERE id = ?', id);
    return row ? rowToAdvice(row) : undefined;
  }

  createAdvice(input: NewAdvice): AdviceRow {
    this.run(
      `INSERT INTO advice (
         id, batch_id, asset_id, watch_item_id, asset_name, code, market, type, instrument, action,
         target_shares, target_price, currency, reason, confidence, status, option_plan,
         executed_shares, executed_price, created_at, decided_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)`,
      input.id,
      input.batchId,
      input.assetId ?? null,
      input.watchItemId ?? null,
      input.assetName ?? '',
      input.code,
      input.market,
      input.type,
      // 老调用点不传 instrument 即为股票建议；`option_plan` 用空串表示「没有方案」。
      input.instrument ?? 'stock',
      input.action,
      input.targetShares ?? 0,
      input.targetPrice ?? 0,
      input.currency ?? DEFAULT_CURRENCY(input.market),
      input.reason ?? '',
      input.confidence ?? 0,
      input.status ?? 'pending',
      input.optionPlan ? stringifyJson(input.optionPlan) : '',
      input.createdAt ?? nowIso(),
    );
    const created = this.getAdvice(input.id);
    if (!created) throw new Error(`createAdvice: row ${input.id} disappeared after insert`);
    return created;
  }

  updateAdvice(id: string, patch: Partial<Omit<AdviceRow, 'id'>>): AdviceRow | undefined {
    const map: Array<[keyof Omit<AdviceRow, 'id'>, string]> = [
      ['batchId', 'batch_id'],
      ['assetId', 'asset_id'],
      ['watchItemId', 'watch_item_id'],
      ['assetName', 'asset_name'],
      ['code', 'code'],
      ['market', 'market'],
      ['type', 'type'],
      ['instrument', 'instrument'],
      ['action', 'action'],
      ['targetShares', 'target_shares'],
      ['targetPrice', 'target_price'],
      ['currency', 'currency'],
      ['reason', 'reason'],
      ['confidence', 'confidence'],
      ['status', 'status'],
      ['option', 'option_plan'],
      ['executedShares', 'executed_shares'],
      ['executedPrice', 'executed_price'],
      ['createdAt', 'created_at'],
      ['decidedAt', 'decided_at'],
    ];
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of map) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      // `option_plan` 是 NOT NULL TEXT：null（清空方案）落成空串，读回仍是 null。
      values.push(key === 'option' ? (value === null ? '' : stringifyJson(value)) : value);
    }
    if (sets.length === 0) return this.getAdvice(id);
    const result = this.run(`UPDATE advice SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
    if (result.changes === 0) return undefined;
    return this.getAdvice(id);
  }

  expirePendingAdvice(exceptBatchId?: string): number {
    return this.run(
      `UPDATE advice SET status = 'expired', decided_at = ?
       WHERE status = 'pending' AND (? IS NULL OR IFNULL(batch_id, '') <> ?)`,
      nowIso(),
      exceptBatchId ?? null,
      exceptBatchId ?? null,
    ).changes;
  }

  /* ── advice outcomes（物化结果：整行由序列重算，因此可整体 REPLACE） ───────── */

  upsertAdviceOutcome(input: AdviceOutcomeRow): AdviceOutcomeRow {
    this.run(
      `INSERT OR REPLACE INTO advice_outcomes (
         advice_id, run_id, code, market, type, action, currency, advised_at, advice_status, executed,
         baseline_date, baseline_price, last_date, last_price, price_change_pct, advice_return_pct,
         benchmark_code, benchmark_name, benchmark_base, benchmark_change_pct, excess_pct,
         max_return_pct, min_return_pct, samples, days_tracked, status, warnings, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.adviceId,
      input.runId ?? null,
      input.code,
      input.market,
      input.type,
      input.action,
      input.currency,
      input.advisedAt,
      input.adviceStatus,
      input.executed ? 1 : 0,
      input.baselineDate,
      input.baselinePrice,
      input.lastDate,
      input.lastPrice,
      input.priceChangePct,
      input.adviceReturnPct,
      input.benchmarkCode,
      input.benchmarkName,
      input.benchmarkBase,
      input.benchmarkChangePct,
      input.excessPct,
      input.maxReturnPct,
      input.minReturnPct,
      input.samples,
      input.daysTracked,
      input.status,
      stringifyJson(input.warnings),
      input.updatedAt,
    );
    return input;
  }

  getAdviceOutcome(adviceId: string): AdviceOutcomeRow | undefined {
    const row = this.get('SELECT * FROM advice_outcomes WHERE advice_id = ?', adviceId);
    return row ? rowToAdviceOutcome(row) : undefined;
  }

  listAdviceOutcomes(filter: { limit?: number; status?: AdviceOutcomeStatus } = {}): AdviceOutcomeRow[] {
    const limit = Math.max(1, Math.min(filter.limit ?? 500, 5000));
    if (filter.status) {
      return this.all(
        'SELECT * FROM advice_outcomes WHERE status = ? ORDER BY advised_at DESC LIMIT ?',
        filter.status,
        limit,
      ).map(rowToAdviceOutcome);
    }
    return this.all('SELECT * FROM advice_outcomes ORDER BY advised_at DESC LIMIT ?', limit).map(rowToAdviceOutcome);
  }

  /**
   * Drops tracked rows whose advice no longer exists (e.g. the user cleared the
   * advice list). The table is a rebuildable cache, so nothing of value is lost.
   */
  deleteAdviceOutcomesForMissingAdvice(): number {
    return this.run('DELETE FROM advice_outcomes WHERE advice_id NOT IN (SELECT id FROM advice)').changes;
  }

  /* ── 期权卖权：卖出的合约与到期结算 ─────────────────────────────────────── */

  listOptionContracts(
    filter: {
      status?: OptionPositionStatus | 'all';
      market?: OptionMarket;
      underlyingAssetId?: string;
      expiringOnOrBefore?: string;
    } = {},
  ): OptionContractRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status && filter.status !== 'all') {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.market) {
      where.push('market = ?');
      params.push(filter.market);
    }
    if (filter.underlyingAssetId) {
      where.push('underlying_asset_id = ?');
      params.push(filter.underlyingAssetId);
    }
    if (filter.expiringOnOrBefore) {
      where.push('expiry <= ?');
      params.push(filter.expiringOnOrBefore);
      // 到期扫描器的用法（见 Repo 注释）：只关心还没结算的持仓。显式传 status 时以调用方为准。
      if (filter.status === undefined) where.push("status = 'open'");
    }
    const sql = `SELECT * FROM option_contracts${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY opened_at DESC, created_at DESC`;
    return this.all(sql, ...params).map(rowToOptionContract);
  }

  getOptionContract(id: string): OptionContractRow | undefined {
    const row = this.get('SELECT * FROM option_contracts WHERE id = ?', id);
    return row ? rowToOptionContract(row) : undefined;
  }

  createOptionContract(input: NewOptionContract): OptionContractRow {
    const now = nowIso();
    this.run(
      `INSERT INTO option_contracts (
         id, advice_id, strategy, market, underlying_code, underlying_name, underlying_asset_id,
         option_code, option_type, strike, expiry, contracts, multiplier, currency, premium, fee,
         premium_income, collateral_kind, collateral, underlying_price_at_open, status, opened_at,
         closed_at, close_price, realized_pnl, note, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
      input.id,
      input.adviceId ?? null,
      input.strategy,
      input.market,
      input.underlyingCode,
      input.underlyingName ?? '',
      input.underlyingAssetId ?? null,
      input.optionCode,
      input.optionType,
      input.strike,
      input.expiry,
      requireContractCount(input.contracts),
      input.multiplier,
      input.currency,
      input.premium,
      input.fee ?? 0,
      input.premiumIncome,
      input.collateralKind,
      input.collateral,
      input.underlyingPriceAtOpen ?? 0,
      input.status ?? 'open',
      input.openedAt,
      input.note ?? '',
      input.createdAt ?? now,
      input.updatedAt ?? now,
    );
    const created = this.getOptionContract(input.id);
    if (!created) throw new Error(`createOptionContract: row ${input.id} disappeared after insert`);
    return created;
  }

  updateOptionContract(id: string, patch: OptionContractPatch): OptionContractRow | undefined {
    const map: Array<[keyof OptionContractPatch, string]> = [
      ['underlyingName', 'underlying_name'],
      ['underlyingAssetId', 'underlying_asset_id'],
      ['status', 'status'],
      ['closedAt', 'closed_at'],
      ['closePrice', 'close_price'],
      ['realizedPnl', 'realized_pnl'],
      ['note', 'note'],
      ['updatedAt', 'updated_at'],
    ];
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of map) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value);
    }
    if (sets.length === 0) return this.getOptionContract(id);
    if (patch.updatedAt === undefined) {
      sets.push('updated_at = ?');
      values.push(nowIso());
    }
    const result = this.run(`UPDATE option_contracts SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
    if (result.changes === 0) return undefined;
    return this.getOptionContract(id);
  }

  deleteOptionContract(id: string): boolean {
    return this.transaction(() => {
      // 结算记录按 contract_id 关联（不是外键），必须显式删除，否则会留下悬挂记录。
      this.run('DELETE FROM option_settlements WHERE contract_id = ?', id);
      return this.run('DELETE FROM option_contracts WHERE id = ?', id).changes > 0;
    });
  }

  listOptionSettlements(
    filter: { status?: OptionSettlementStatus | 'all'; contractId?: string; expiry?: string } = {},
  ): OptionSettlementRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status && filter.status !== 'all') {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.contractId) {
      where.push('contract_id = ?');
      params.push(filter.contractId);
    }
    if (filter.expiry) {
      where.push('expiry = ?');
      params.push(filter.expiry);
    }
    const sql = `SELECT * FROM option_settlements${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY expiry DESC, evaluated_at DESC`;
    return this.all(sql, ...params).map(rowToOptionSettlement);
  }

  getOptionSettlement(id: string): OptionSettlementRow | undefined {
    const row = this.get('SELECT * FROM option_settlements WHERE id = ?', id);
    return row ? rowToOptionSettlement(row) : undefined;
  }

  findOptionSettlementByContract(contractId: string): OptionSettlementRow | undefined {
    const row = this.get('SELECT * FROM option_settlements WHERE contract_id = ?', contractId);
    return row ? rowToOptionSettlement(row) : undefined;
  }

  /**
   * 插入或更新结算记录（按 `contract_id` 唯一）。
   *
   * 刻意做成 upsert：到期扫描器每天都会重扫一遍未结算的合约，重复扫描**必须**收敛到
   * 同一条记录（保留首条的 id 与 created_at），而不是报冲突或插入第二行。
   */
  upsertOptionSettlement(input: NewOptionSettlement): OptionSettlementRow {
    const existing = this.findOptionSettlementByContract(input.contractId);
    if (existing) {
      const patch: Array<[unknown, string]> = [
        [input.expiry, 'expiry'],
        [input.evaluatedAt, 'evaluated_at'],
        [input.referencePrice, 'reference_price'],
        [input.priceSource, 'price_source'],
        [input.verdict, 'verdict'],
        [input.itmAmount, 'itm_amount'],
        [input.itmPct, 'itm_pct'],
        [input.status, 'status'],
        [input.action, 'action'],
        [input.transactionId, 'transaction_id'],
        [input.assetId, 'asset_id'],
        [input.realizedPnl, 'realized_pnl'],
        [input.note, 'note'],
      ];
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [value, column] of patch) {
        if (value === undefined) continue;
        sets.push(`${column} = ?`);
        values.push(value);
      }
      if (sets.length > 0) {
        this.run(`UPDATE option_settlements SET ${sets.join(', ')} WHERE id = ?`, ...values, existing.id);
      }
      const updated = this.getOptionSettlement(existing.id);
      if (!updated) throw new Error(`upsertOptionSettlement: row ${existing.id} disappeared after update`);
      return updated;
    }
    this.run(
      `INSERT INTO option_settlements (
         id, contract_id, expiry, evaluated_at, reference_price, price_source, verdict, itm_amount,
         itm_pct, status, action, transaction_id, asset_id, realized_pnl, note, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.contractId,
      input.expiry,
      input.evaluatedAt,
      input.referencePrice,
      input.priceSource,
      input.verdict,
      input.itmAmount,
      input.itmPct,
      input.status,
      input.action,
      input.transactionId ?? null,
      input.assetId ?? null,
      input.realizedPnl ?? 0,
      input.note ?? '',
      input.createdAt,
    );
    const created = this.getOptionSettlement(input.id);
    if (!created) throw new Error(`upsertOptionSettlement: row ${input.id} disappeared after insert`);
    return created;
  }

  updateOptionSettlement(id: string, patch: OptionSettlementPatch): OptionSettlementRow | undefined {
    const map: Array<[keyof OptionSettlementPatch, string]> = [
      ['evaluatedAt', 'evaluated_at'],
      ['referencePrice', 'reference_price'],
      ['priceSource', 'price_source'],
      ['verdict', 'verdict'],
      ['itmAmount', 'itm_amount'],
      ['itmPct', 'itm_pct'],
      ['status', 'status'],
      ['action', 'action'],
      ['transactionId', 'transaction_id'],
      ['assetId', 'asset_id'],
      ['realizedPnl', 'realized_pnl'],
      ['note', 'note'],
    ];
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of map) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value);
    }
    if (sets.length === 0) return this.getOptionSettlement(id);
    const result = this.run(`UPDATE option_settlements SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
    if (result.changes === 0) return undefined;
    return this.getOptionSettlement(id);
  }

  /* ── agent runs ────────────────────────────────────────────────────────── */

  createRun(
    input: Omit<RunRow, 'finishedAt' | 'summary' | 'error' | 'turns' | 'promptTokens' | 'completionTokens'> &
      Partial<RunRow>,
  ): RunRow {
    const startedAt = input.startedAt ?? nowIso();
    this.run(
      `INSERT INTO agent_runs (
         id, kind, status, target, title, summary, error, turns, prompt_tokens, completion_tokens,
         started_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.kind,
      input.status,
      input.target ?? null,
      input.title ?? '',
      input.summary ?? '',
      input.error ?? null,
      input.turns ?? 0,
      input.promptTokens ?? 0,
      input.completionTokens ?? 0,
      startedAt,
      input.finishedAt ?? null,
    );
    const created = this.getRun(input.id);
    if (!created) throw new Error(`createRun: row ${input.id} disappeared after insert`);
    return created;
  }

  updateRun(id: string, patch: Partial<Omit<RunRow, 'id'>>): RunRow | undefined {
    const map: Array<[keyof Omit<RunRow, 'id'>, string]> = [
      ['kind', 'kind'],
      ['status', 'status'],
      ['target', 'target'],
      ['title', 'title'],
      ['summary', 'summary'],
      ['error', 'error'],
      ['turns', 'turns'],
      ['promptTokens', 'prompt_tokens'],
      ['completionTokens', 'completion_tokens'],
      ['startedAt', 'started_at'],
      ['finishedAt', 'finished_at'],
    ];
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of map) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value);
    }
    if (sets.length === 0) return this.getRun(id);
    const result = this.run(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
    if (result.changes === 0) return undefined;
    return this.getRun(id);
  }

  getRun(id: string): RunRow | undefined {
    const row = this.get('SELECT * FROM agent_runs WHERE id = ?', id);
    return row ? rowToRun(row) : undefined;
  }

  listRuns(filter: { limit?: number; kind?: RunRow['kind']; status?: RunRow['status'] } = {}): RunRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.kind) {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    const limit = filter.limit && filter.limit > 0 ? ` LIMIT ${Math.trunc(filter.limit)}` : '';
    const sql = `SELECT * FROM agent_runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC${limit}`;
    return this.all(sql, ...params).map(rowToRun);
  }

  listSteps(runId: string): StepRow[] {
    return this.all('SELECT * FROM agent_steps WHERE run_id = ? ORDER BY idx ASC, started_at ASC', runId).map(rowToStep);
  }

  /**
   * Boot-time reconciliation (see `Repo.failStaleRuns`).
   *
   * `turns`/token columns are left untouched on purpose: they hold whatever the
   * run really spent before it was interrupted, and resetting them would hide the
   * cost. Only `status`/`error`/`finished_at` change, and the `status = 'running'`
   * predicate keeps this idempotent.
   */
  failStaleRuns(reason: string): number {
    const result = this.run(
      `UPDATE agent_runs SET status = 'error', error = ?, finished_at = ?
       WHERE status = 'running' AND finished_at IS NULL`,
      reason,
      nowIso(),
    );
    return Number(result.changes ?? 0);
  }

  addStep(input: NewStep): StepRow {
    const id = input.id ?? crypto.randomUUID();
    this.run(
      `INSERT INTO agent_steps (
         id, run_id, idx, label, status, detail, tool_name, tool_args, tool_result, started_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         idx = excluded.idx, label = excluded.label, status = excluded.status, detail = excluded.detail,
         tool_name = excluded.tool_name, tool_args = excluded.tool_args, tool_result = excluded.tool_result,
         started_at = excluded.started_at, finished_at = excluded.finished_at`,
      id,
      input.runId,
      input.index ?? 0,
      input.label ?? '',
      input.status ?? 'pending',
      input.detail ?? '',
      input.toolName ?? null,
      input.toolArgs ?? null,
      input.toolResult ?? null,
      input.startedAt ?? null,
      input.finishedAt ?? null,
    );
    const row = this.get('SELECT * FROM agent_steps WHERE id = ?', id);
    if (!row) throw new Error(`addStep: row ${id} disappeared after insert`);
    return rowToStep(row);
  }

  updateStep(id: string, patch: Partial<Omit<StepRow, 'id' | 'runId'>>): StepRow | undefined {
    const map: Array<[keyof Omit<StepRow, 'id' | 'runId'>, string]> = [
      ['index', 'idx'],
      ['label', 'label'],
      ['status', 'status'],
      ['detail', 'detail'],
      ['toolName', 'tool_name'],
      ['toolArgs', 'tool_args'],
      ['toolResult', 'tool_result'],
      ['startedAt', 'started_at'],
      ['finishedAt', 'finished_at'],
    ];
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of map) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value);
    }
    if (sets.length === 0) {
      const existing = this.get('SELECT * FROM agent_steps WHERE id = ?', id);
      return existing ? rowToStep(existing) : undefined;
    }
    const result = this.run(`UPDATE agent_steps SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
    if (result.changes === 0) return undefined;
    const row = this.get('SELECT * FROM agent_steps WHERE id = ?', id);
    return row ? rowToStep(row) : undefined;
  }

  /* ── chat ──────────────────────────────────────────────────────────────── */

  listSessions(): ChatSessionRow[] {
    return this.all('SELECT * FROM chat_sessions ORDER BY updated_at DESC').map(rowToSession);
  }

  getSession(id: string): ChatSessionRow | undefined {
    const row = this.get('SELECT * FROM chat_sessions WHERE id = ?', id);
    return row ? rowToSession(row) : undefined;
  }

  createSession(id: string, title: string, createdAt: string): ChatSessionRow {
    this.run(
      'INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
      id,
      title,
      createdAt,
      createdAt,
    );
    const created = this.getSession(id);
    if (!created) throw new Error(`createSession: row ${id} disappeared after insert`);
    return created;
  }

  touchSession(id: string, title?: string): void {
    this.run('UPDATE chat_sessions SET updated_at = ?, title = COALESCE(?, title) WHERE id = ?', nowIso(), title ?? null, id);
  }

  deleteSession(id: string): boolean {
    return this.transaction(() => {
      this.run('DELETE FROM chat_messages WHERE session_id = ?', id);
      return this.run('DELETE FROM chat_sessions WHERE id = ?', id).changes > 0;
    });
  }

  listMessages(sessionId: string): ChatMessageRow[] {
    return this.all(
      'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC',
      sessionId,
    ).map(rowToMessage);
  }

  addMessage(input: ChatMessageRow): ChatMessageRow {
    this.run(
      `INSERT INTO chat_messages (id, session_id, role, content, tool_calls, tool_call_id, run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.sessionId,
      input.role,
      input.content ?? '',
      input.toolCalls ?? null,
      input.toolCallId ?? null,
      input.runId ?? null,
      input.createdAt ?? nowIso(),
    );
    this.touchSession(input.sessionId);
    const row = this.get('SELECT * FROM chat_messages WHERE id = ?', input.id);
    if (!row) throw new Error(`addMessage: row ${input.id} disappeared after insert`);
    return rowToMessage(row);
  }

  /* ── kv ────────────────────────────────────────────────────────────────── */

  getKv(key: string): string | undefined {
    const row = this.get('SELECT value FROM kv WHERE key = ?', key);
    return row ? toText(row.value) : undefined;
  }

  setKv(key: string, value: string): void {
    this.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  /* ── backup ────────────────────────────────────────────────────────────── */

  exportAll(): ExportBundle {
    return {
      assets: this.listAssets(),
      transactions: this.listTransactions(),
      watchlist: this.listWatchlist('all'),
      advice: this.listAdvice(),
      // 打新：标的按 uid 全量导出，申购记录一并带上（否则恢复后「我中签了多少股」全丢）。
      ipoOffers: this.listIpoOffers({ limit: 100_000 }),
      ipoSubscriptions: this.listIpoSubscriptions(),
      // 期权卖权：合约与结算记录都要带上（否则恢复后持仓与到期结论全丢）。
      optionContracts: this.listOptionContracts({ status: 'all' }),
      optionSettlements: this.listOptionSettlements({ status: 'all' }),
    };
  }

  importAll(bundle: ExportBundle, mode: ImportMode): ImportResult {
    return this.transaction(() => {
      const result: ImportResult = {
        assets: 0,
        transactions: 0,
        watchlist: 0,
        advice: 0,
        ipoOffers: 0,
        ipoSubscriptions: 0,
        optionContracts: 0,
        optionSettlements: 0,
        skipped: 0,
        mode,
      };

      if (mode === 'replace') {
        this.run('DELETE FROM transactions');
        this.run('DELETE FROM assets');
        this.run('DELETE FROM watchlist');
        this.run('DELETE FROM advice');
        this.run('DELETE FROM ipo_subscriptions');
        this.run('DELETE FROM ipo_offers');
        // 期权：先删结算再删合约（结算按 contract_id 关联）。
        this.run('DELETE FROM option_settlements');
        this.run('DELETE FROM option_contracts');
      }

      const knownAssetIds = new Set(this.all('SELECT id FROM assets').map((row) => str(row.id)));
      const knownTxIds = new Set(this.all('SELECT id FROM transactions').map((row) => str(row.id)));
      const knownWatchIds = new Set(this.all('SELECT id FROM watchlist').map((row) => str(row.id)));
      const knownAdviceIds = new Set(this.all('SELECT id FROM advice').map((row) => str(row.id)));
      const knownIpoIds = new Set(this.all('SELECT id FROM ipo_offers').map((row) => str(row.id)));
      const knownIpoUids = new Set(this.all('SELECT uid FROM ipo_offers').map((row) => str(row.uid)));
      const knownSubIds = new Set(this.all('SELECT id FROM ipo_subscriptions').map((row) => str(row.id)));
      const knownSubUids = new Set(this.all('SELECT offer_uid FROM ipo_subscriptions').map((row) => str(row.offer_uid)));
      const knownOptionContractIds = new Set(this.all('SELECT id FROM option_contracts').map((row) => str(row.id)));
      const knownSettlementIds = new Set(this.all('SELECT id FROM option_settlements').map((row) => str(row.id)));
      // `contract_id` 是 UNIQUE：同一合约只能有一条结算，先按业务键去重再插入。
      const knownSettledContractIds = new Set(
        this.all('SELECT contract_id FROM option_settlements').map((row) => str(row.contract_id)),
      );

      for (const asset of bundle.assets ?? []) {
        if (!isValidAssetRow(asset) || knownAssetIds.has(asset.id)) {
          result.skipped += 1;
          continue;
        }
        try {
          this.insertAssetRow(asset);
          knownAssetIds.add(asset.id);
          result.assets += 1;
        } catch {
          result.skipped += 1;
        }
      }

      for (const tx of bundle.transactions ?? []) {
        if (!isValidTxRow(tx) || knownTxIds.has(tx.id) || !knownAssetIds.has(tx.assetId)) {
          result.skipped += 1;
          continue;
        }
        try {
          this.addTransaction(tx);
          knownTxIds.add(tx.id);
          result.transactions += 1;
        } catch {
          result.skipped += 1;
        }
      }

      for (const item of bundle.watchlist ?? []) {
        if (!isValidWatchRow(item) || knownWatchIds.has(item.id)) {
          result.skipped += 1;
          continue;
        }
        try {
          this.insertWatchRow(item);
          knownWatchIds.add(item.id);
          result.watchlist += 1;
        } catch {
          result.skipped += 1;
        }
      }

      for (const item of bundle.advice ?? []) {
        if (!isValidAdviceRow(item) || knownAdviceIds.has(item.id)) {
          result.skipped += 1;
          continue;
        }
        try {
          this.insertAdviceRow(item);
          knownAdviceIds.add(item.id);
          result.advice += 1;
        } catch {
          result.skipped += 1;
        }
      }

      // 打新标的：按 id 与 uid 双重去重，避免同一只新股以两条记录落在库里。
      for (const item of bundle.ipoOffers ?? []) {
        if (!isValidIpoOfferRow(item) || knownIpoIds.has(item.id) || knownIpoUids.has(item.uid)) {
          result.skipped += 1;
          continue;
        }
        try {
          this.insertIpoOfferRow(item);
          knownIpoIds.add(item.id);
          knownIpoUids.add(item.uid);
          result.ipoOffers += 1;
        } catch {
          result.skipped += 1;
        }
      }

      // 申购记录必须指向已存在的新股（uid），否则会变成查不到的悬挂记录。
      for (const item of bundle.ipoSubscriptions ?? []) {
        if (
          !isValidIpoSubscriptionRow(item) ||
          knownSubIds.has(item.id) ||
          knownSubUids.has(item.offerUid) ||
          !knownIpoUids.has(item.offerUid)
        ) {
          result.skipped += 1;
          continue;
        }
        try {
          this.upsertIpoSubscription(item);
          knownSubIds.add(item.id);
          knownSubUids.add(item.offerUid);
          result.ipoSubscriptions += 1;
        } catch {
          result.skipped += 1;
        }
      }

      // 期权合约：按 id 去重，merge 模式下重复导入不产生第二份持仓。
      for (const item of bundle.optionContracts ?? []) {
        if (!isValidOptionContractRow(item) || knownOptionContractIds.has(item.id)) {
          result.skipped += 1;
          continue;
        }
        try {
          this.insertOptionContractRow(item);
          knownOptionContractIds.add(item.id);
          result.optionContracts += 1;
        } catch {
          result.skipped += 1;
        }
      }

      // 结算记录必须指向已存在的合约（`contract_id` UNIQUE），否则会变成查不到的悬挂记录。
      for (const item of bundle.optionSettlements ?? []) {
        if (
          !isValidOptionSettlementRow(item) ||
          knownSettlementIds.has(item.id) ||
          !knownOptionContractIds.has(item.contractId) ||
          knownSettledContractIds.has(item.contractId)
        ) {
          result.skipped += 1;
          continue;
        }
        try {
          this.insertOptionSettlementRow(item);
          knownSettlementIds.add(item.id);
          knownSettledContractIds.add(item.contractId);
          result.optionSettlements += 1;
        } catch {
          result.skipped += 1;
        }
      }

      return result;
    });
  }

  /* ── one-click wipe（设置页「一键清除所有数据」） ────────────────────────── */

  /**
   * 清空全部业务数据、AI 历史与缓存，单个事务内完成。
   *
   * `keepSettings` 默认 `true`：AI 配置（含 LLM / 数据源 Key、投资性格、预算、
   * 定时任务）保持不动，用户清完可直接继续用；传 `false` 时设置回到出厂默认
   * （等价于全新数据库）。无论哪种，`last_run_at` 都会清空 —— 它指向的 run
   * 已经不存在了。
   *
   * 磁盘上的备份快照（`data/backups`）不属于数据库数据，不在此方法范围内。
   */
  clearAllData(options: { keepSettings?: boolean } = {}): ClearDataResult {
    const keepSettings = options.keepSettings !== false;
    return this.transaction(() => {
      const counts = {} as Record<ClearedTable, number>;
      for (const table of CLEARED_TABLES) {
        counts[table] = int(this.get(`SELECT COUNT(*) AS n FROM ${table}`)?.n, 0);
      }
      for (const table of CLEARED_TABLES) this.run(`DELETE FROM ${table}`);
      if (!keepSettings) this.resetSettings();
      // 运行历史已清空：时间戳不再对应任何 run。
      this.run('UPDATE settings SET last_run_at = NULL WHERE id = 1');
      const deleted = CLEARED_TABLES.reduce((total, table) => total + counts[table], 0);
      return {
        assets: counts.assets,
        transactions: counts.transactions,
        watchlist: counts.watchlist,
        advice: counts.advice,
        adviceOutcomes: counts.advice_outcomes,
        ipoOffers: counts.ipo_offers,
        ipoSubscriptions: counts.ipo_subscriptions,
        optionContracts: counts.option_contracts,
        optionSettlements: counts.option_settlements,
        runs: counts.agent_runs,
        steps: counts.agent_steps,
        runMessages: counts.agent_run_messages,
        chatSessions: counts.chat_sessions,
        chatMessages: counts.chat_messages,
        auditEntries: counts.audit_log,
        pendingWrites: counts.pending_writes,
        kvEntries: counts.kv,
        settingsReset: !keepSettings,
        deleted,
      };
    });
  }

  resetSettings(): StoredSettings {
    // 删行 + 重新播种：拿到的就是全新数据库的默认值（含清空全部 Key）。
    this.run('DELETE FROM settings WHERE id = 1');
    this.seedSettings();
    return this.getSettings();
  }

  /* ── full-fidelity row inserts used by importAll ────────────────────────── */
  private insertAssetRow(row: AssetRow): void {
    this.createAsset(row);
    this.updateAsset(row.id, {
      prevClose: row.prevClose,
      thesis: row.thesis,
      qualityScore: row.qualityScore,
      targetPrice: row.targetPrice,
      expectedReturn: row.expectedReturn,
      aiSummary: row.aiSummary,
      aiSummaryAt: row.aiSummaryAt,
      dayChangePct: row.dayChangePct,
      spark: row.spark,
    });
    this.run('UPDATE assets SET updated_at = ? WHERE id = ?', row.updatedAt ?? nowIso(), row.id);
  }

  private insertWatchRow(row: WatchRow): void {
    this.createWatchItem(row);
    this.updateWatchItem(row.id, {
      qualityScore: row.qualityScore,
      targetPrice: row.targetPrice,
      expectedReturn: row.expectedReturn,
      thesis: row.thesis,
      aiSummary: row.aiSummary,
      aiSummaryAt: row.aiSummaryAt,
      initialPrice: row.initialPrice,
      initialPriceAt: row.initialPriceAt,
      price: row.price,
      priceAt: row.priceAt,
      prevClose: row.prevClose,
      dayChangePct: row.dayChangePct,
      spark: row.spark,
      source: row.source,
      // P3：退役状态必须随备份/恢复一起往返，否则恢复后会被当成在池标的。
      status: row.status,
      retiredReason: row.retiredReason,
      retiredAt: row.retiredAt,
      retireStreak: row.retireStreak,
    });
    this.run('UPDATE watchlist SET updated_at = ? WHERE id = ?', row.updatedAt ?? nowIso(), row.id);
  }

  private insertAdviceRow(row: AdviceRow): void {
    // 备份恢复必须带上 instrument / option_plan，否则期权建议会被静默还原成股票建议。
    this.createAdvice({ ...row, instrument: row.instrument, optionPlan: row.option });
    if (row.executedShares !== null || row.executedPrice !== null || row.decidedAt !== null) {
      this.updateAdvice(row.id, {
        executedShares: row.executedShares,
        executedPrice: row.executedPrice,
        decidedAt: row.decidedAt,
      });
    }
  }

  /**
   * 期权合约的整体插入（`createOptionContract` 只写开仓态字段），用于备份恢复。
   *
   * 平仓才有的三列（`closed_at` / `close_price` / `realized_pnl`）创建后补写，
   * `updated_at` 也还原成备份里的值（否则恢复出来的行时间戳会变成「刚刚」）。
   */
  private insertOptionContractRow(row: OptionContractRow): void {
    this.createOptionContract({ ...row });
    if (row.closedAt !== null || row.closePrice !== null || row.realizedPnl !== null) {
      this.updateOptionContract(row.id, {
        closedAt: row.closedAt,
        closePrice: row.closePrice,
        realizedPnl: row.realizedPnl,
      });
    }
    this.run('UPDATE option_contracts SET updated_at = ? WHERE id = ?', row.updatedAt || nowIso(), row.id);
  }

  /** 结算记录整体插入：`upsertOptionSettlement` 保留首条 created_at，恢复时补回原值。 */
  private insertOptionSettlementRow(row: OptionSettlementRow): void {
    this.upsertOptionSettlement({ ...row });
    this.run('UPDATE option_settlements SET created_at = ? WHERE id = ?', row.createdAt || nowIso(), row.id);
  }

  /** 打新标的的整体插入（`createIpoOffer` + AI 结论字段），用于备份恢复。 */
  private insertIpoOfferRow(row: IpoOfferRow): void {
    this.createIpoOffer(row);
    this.updateIpoOffer(row.id, {
      exchange: row.exchange,
      board: row.board,
      priceLow: row.priceLow,
      priceHigh: row.priceHigh,
      subscribeStart: row.subscribeStart,
      subscribeEnd: row.subscribeEnd,
      allotmentDate: row.allotmentDate,
      listingDate: row.listingDate,
      issueShares: row.issueShares,
      raiseAmount: row.raiseAmount,
      industryPe: row.industryPe,
      winningRate: row.winningRate,
      oversubscribe: row.oversubscribe,
      industry: row.industry,
      prospectusUrl: row.prospectusUrl,
      status: row.status,
      advice: row.advice,
      verdict: row.verdict,
      verdictReason: row.verdictReason,
      suggestedShares: row.suggestedShares,
      winProbability: row.winProbability,
      expectedReturn: row.expectedReturn,
      confidence: row.confidence,
      qualityScore: row.qualityScore,
      adviceAt: row.adviceAt,
      adviceRunId: row.adviceRunId,
      note: row.note,
    });
    this.run('UPDATE ipo_offers SET updated_at = ? WHERE id = ?', row.updatedAt ?? nowIso(), row.id);
  }

  /* ── helpers ───────────────────────────────────────────────────────────── */

  listOpenAssetIds(): string[] {
    return this.all(
      `SELECT a.id AS id
         FROM assets a
         JOIN (
           SELECT asset_id AS asset_id, SUM(CASE WHEN kind = 'sell' THEN -shares ELSE shares END) AS net
             FROM transactions
            GROUP BY asset_id
         ) t ON t.asset_id = a.id
        WHERE t.net > 0
        ORDER BY a.created_at ASC`,
    ).map((row) => str(row.id));
  }

  countCreator(creator: Creator): number {
    const row = this.get(
      `SELECT COUNT(*) AS n
         FROM assets a
        WHERE a.source = ?
          AND EXISTS (
            SELECT 1 FROM transactions t
             WHERE t.asset_id = a.id
             GROUP BY t.asset_id
            HAVING SUM(CASE WHEN t.kind = 'sell' THEN -t.shares ELSE t.shares END) > 0
          )`,
      creator,
    );
    return row ? int(row.n) : 0;
  }

  /* ── P1-1 audit trail ──────────────────────────────────────────────────── */

  addAudit(entry: AuditRow): AuditRow {
    this.run(
      `INSERT INTO audit_log (id, at, run_id, session_id, tool, risk, outcome, entity, entity_id, summary, args)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.id,
      entry.at,
      entry.runId,
      entry.sessionId,
      entry.tool,
      entry.risk,
      entry.outcome,
      entry.entity,
      entry.entityId,
      entry.summary,
      entry.args,
    );
    return entry;
  }

  listAudit(filter: { limit?: number; runId?: string; risk?: ToolRisk; outcome?: AuditRow['outcome'] } = {}): AuditRow[] {
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 1000));
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.runId) {
      where.push('run_id = ?');
      params.push(filter.runId);
    }
    if (filter.risk) {
      where.push('risk = ?');
      params.push(filter.risk);
    }
    if (filter.outcome) {
      where.push('outcome = ?');
      params.push(filter.outcome);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit);
    return this.all(`SELECT * FROM audit_log ${clause} ORDER BY at DESC LIMIT ?`, ...params).map(rowToAudit);
  }

  /* ── P1-1 pending writes (approval mode) ───────────────────────────────── */

  addPendingWrite(input: PendingWriteRow): PendingWriteRow {
    this.run(
      `INSERT INTO pending_writes (id, run_id, session_id, tool, args, summary, risk, status, created_at, decided_at, result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      input.id,
      input.runId,
      input.sessionId,
      input.tool,
      input.args,
      input.summary,
      input.risk,
      input.status,
      input.createdAt,
    );
    return input;
  }

  getPendingWrite(id: string): PendingWriteRow | undefined {
    const row = this.get('SELECT * FROM pending_writes WHERE id = ?', id);
    return row ? rowToPendingWrite(row) : undefined;
  }

  listPendingWrites(status?: PendingWriteStatus, limit = 100): PendingWriteRow[] {
    const capped = Math.max(1, Math.min(limit, 500));
    if (status) {
      return this.all('SELECT * FROM pending_writes WHERE status = ? ORDER BY created_at DESC LIMIT ?', status, capped).map(
        rowToPendingWrite,
      );
    }
    return this.all('SELECT * FROM pending_writes ORDER BY created_at DESC LIMIT ?', capped).map(rowToPendingWrite);
  }

  listPendingWritesByRun(runId: string, limit = 500): PendingWriteRow[] {
    const capped = Math.max(1, Math.min(limit, 500));
    return this.all('SELECT * FROM pending_writes WHERE run_id = ? ORDER BY created_at DESC LIMIT ?', runId, capped).map(
      rowToPendingWrite,
    );
  }

  updatePendingWrite(
    id: string,
    patch: Partial<Pick<PendingWriteRow, 'status' | 'decidedAt' | 'result' | 'summary'>>,
  ): PendingWriteRow | undefined {
    const current = this.getPendingWrite(id);
    if (!current) return undefined;
    const next: PendingWriteRow = {
      ...current,
      status: patch.status ?? current.status,
      decidedAt: patch.decidedAt !== undefined ? patch.decidedAt : current.decidedAt,
      result: patch.result !== undefined ? patch.result : current.result,
      summary: patch.summary ?? current.summary,
    };
    this.run('UPDATE pending_writes SET status = ?, decided_at = ?, result = ?, summary = ? WHERE id = ?', next.status, next.decidedAt, next.result, next.summary, id);
    return next;
  }

  /* ── P1-3 run message transcript (resume + replay) ─────────────────────── */

  addRunMessage(input: RunMessageRow): RunMessageRow {
    // D7: cap a single transcript body so one runaway tool result cannot grow the
    // table without bound (agent_steps.tool_result is capped for the same reason).
    // `user` messages only get a sanity bound — see MAX_RUN_USER_MESSAGE_CHARS.
    const cap = input.role === 'user' ? MAX_RUN_USER_MESSAGE_CHARS : MAX_RUN_MESSAGE_CHARS;
    const content =
      input.content.length > cap
        ? `${input.content.slice(0, cap)}…（已截断，原始 ${input.content.length} 字符）`
        : input.content;
    // The thinking trace is echoed back to the provider verbatim on resume; a gate
    // is still needed because reasoning models can emit tens of KB per turn.
    const reasoning =
      input.reasoningContent && input.reasoningContent.length > MAX_RUN_MESSAGE_CHARS
        ? `${input.reasoningContent.slice(0, MAX_RUN_MESSAGE_CHARS)}…（思考轨迹已截断，原始 ${input.reasoningContent.length} 字符）`
        : (input.reasoningContent ?? null);
    this.run(
      `INSERT INTO agent_run_messages (id, run_id, idx, role, content, tool_calls, tool_call_id, name, reasoning_content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.runId,
      input.index,
      input.role,
      content,
      input.toolCalls,
      input.toolCallId,
      input.name,
      reasoning,
      input.createdAt,
    );
    return input;
  }

  listRunMessages(runId: string): RunMessageRow[] {
    return this.all('SELECT * FROM agent_run_messages WHERE run_id = ? ORDER BY idx ASC', runId).map(rowToRunMessage);
  }

  countRunMessages(runId: string): number {
    const row = this.get('SELECT COUNT(*) AS n FROM agent_run_messages WHERE run_id = ?', runId);
    return row ? int(row.n) : 0;
  }

  /**
   * D7: keeps the transcript of the newest `keepRuns` runs and drops older ones
   * (plus their audit rows), so a long-lived instance does not accumulate
   * unbounded trajectory data. Returns the number of deleted runs.
   */
  pruneRunData(keepRuns = 50): number {
    const keep = Math.max(1, Math.min(keepRuns, 5000));
    const doomed = this.all(
      'SELECT id FROM agent_runs ORDER BY started_at DESC LIMIT -1 OFFSET ?',
      keep,
    ).map((row) => str(row.id));
    if (doomed.length === 0) return 0;
    this.transaction(() => {
      for (const runId of doomed) {
        this.run('DELETE FROM agent_run_messages WHERE run_id = ?', runId);
        this.run('DELETE FROM agent_steps WHERE run_id = ?', runId);
        this.run('DELETE FROM audit_log WHERE run_id = ?', runId);
        this.run('DELETE FROM agent_runs WHERE id = ?', runId);
      }
    });
    return doomed.length;
  }
}

/* ───────────────────────────── row validation ─────────────────────────────── */

const MARKETS = new Set(['CN', 'HK', 'US']);
const TYPES = new Set(['stock', 'etf', 'fund']);
const CREATORS = new Set(['manual', 'ai']);
const TX_KINDS = new Set(['buy', 'sell']);
const TX_SOURCES = new Set(['manual', 'ai', 'advice', 'ipo', 'option']);
const IPO_STATUSES = new Set(['upcoming', 'subscribing', 'allotted', 'listed', 'unknown']);
const IPO_VERDICTS = new Set(['subscribe', 'neutral', 'avoid']);
const IPO_SUB_STATUSES = new Set(['applied', 'allotted', 'missed']);
const ADVICE_INSTRUMENTS = new Set(['stock', 'option']);
const OPTION_MARKETS = new Set(['HK', 'US']);
const OPTION_STRATEGIES = new Set(['covered_call', 'cash_secured_put']);
const OPTION_TYPES = new Set(['call', 'put']);
const OPTION_POSITION_STATUSES = new Set(['open', 'closed', 'assigned', 'expired_otm']);
const OPTION_COLLATERAL_KINDS = new Set(['shares', 'cash']);
const OPTION_SETTLEMENT_VERDICTS = new Set(['otm_no_assignment', 'assigned', 'uncertain']);
const OPTION_SETTLEMENT_STATUSES = new Set(['auto_settled', 'pending_review', 'confirmed', 'dismissed']);
const OPTION_SETTLEMENT_ACTIONS = new Set(['none', 'shares_delivered', 'shares_received', 'pending']);

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isValidAssetRow(row: AssetRow): boolean {
  return (
    !!row &&
    isNonEmpty(row.id) &&
    isNonEmpty(row.code) &&
    MARKETS.has(row.market) &&
    TYPES.has(row.type) &&
    (!row.source || CREATORS.has(row.source))
  );
}

function isValidTxRow(row: TxRow): boolean {
  return (
    !!row &&
    isNonEmpty(row.id) &&
    isNonEmpty(row.assetId) &&
    TX_KINDS.has(row.kind) &&
    Number.isFinite(row.shares) &&
    Number.isFinite(row.price) &&
    isNonEmpty(row.tradeDate) &&
    (!row.source || TX_SOURCES.has(row.source))
  );
}

function isValidWatchRow(row: WatchRow): boolean {
  return (
    !!row &&
    isNonEmpty(row.id) &&
    isNonEmpty(row.code) &&
    MARKETS.has(row.market) &&
    TYPES.has(row.type) &&
    (!row.source || CREATORS.has(row.source))
  );
}

function isValidAdviceRow(row: AdviceRow): boolean {
  return (
    !!row &&
    isNonEmpty(row.id) &&
    MARKETS.has(row.market) &&
    TYPES.has(row.type) &&
    (!row.instrument || ADVICE_INSTRUMENTS.has(row.instrument)) &&
    (row.action === 'buy' || row.action === 'sell')
  );
}

function isValidIpoOfferRow(row: IpoOfferRow): boolean {
  return (
    !!row &&
    isNonEmpty(row.id) &&
    isNonEmpty(row.uid) &&
    isNonEmpty(row.name) &&
    MARKETS.has(row.market) &&
    (!row.status || IPO_STATUSES.has(row.status)) &&
    (!row.verdict || IPO_VERDICTS.has(row.verdict))
  );
}

function isValidIpoSubscriptionRow(row: IpoSubscriptionRow): boolean {
  return (
    !!row &&
    isNonEmpty(row.id) &&
    isNonEmpty(row.offerUid) &&
    MARKETS.has(row.market) &&
    Number.isFinite(row.appliedShares) &&
    Number.isFinite(row.allottedShares) &&
    (!row.status || IPO_SUB_STATUSES.has(row.status))
  );
}

function isValidOptionContractRow(row: OptionContractRow): boolean {
  return (
    !!row &&
    isNonEmpty(row.id) &&
    isNonEmpty(row.underlyingCode) &&
    isNonEmpty(row.expiry) &&
    OPTION_MARKETS.has(row.market) &&
    OPTION_STRATEGIES.has(row.strategy) &&
    OPTION_TYPES.has(row.optionType) &&
    OPTION_COLLATERAL_KINDS.has(row.collateralKind) &&
    OPTION_POSITION_STATUSES.has(row.status) &&
    // 张数必须是正整数：小数会被 SQLite 静默截断，导致权利金与担保额对不上。
    Number.isInteger(row.contracts) &&
    row.contracts > 0 &&
    Number.isFinite(row.strike) &&
    Number.isFinite(row.multiplier) &&
    Number.isFinite(row.premium) &&
    Number.isFinite(row.premiumIncome) &&
    isNonEmpty(row.openedAt)
  );
}

function isValidOptionSettlementRow(row: OptionSettlementRow): boolean {
  return (
    !!row &&
    isNonEmpty(row.id) &&
    isNonEmpty(row.contractId) &&
    isNonEmpty(row.evaluatedAt) &&
    OPTION_SETTLEMENT_VERDICTS.has(row.verdict) &&
    OPTION_SETTLEMENT_STATUSES.has(row.status) &&
    OPTION_SETTLEMENT_ACTIONS.has(row.action) &&
    Number.isFinite(row.referencePrice) &&
    Number.isFinite(row.itmAmount) &&
    Number.isFinite(row.itmPct) &&
    Number.isFinite(row.realizedPnl)
  );
}
