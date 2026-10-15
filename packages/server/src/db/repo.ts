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
  DEFAULT_PERSONA,
  DEFAULT_REPORT_STYLE,
  DEFAULT_SCHEDULE,
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
  type Market,
  type McpServerConfig,
  type PendingWrite,
  type PendingWriteStatus,
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
  NewAdvice,
  NewAsset,
  NewStep,
  NewTx,
  NewWatch,
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
  };
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
    schedule: {
      mode: (str(row.schedule_mode, DEFAULT_SCHEDULE.mode) || DEFAULT_SCHEDULE.mode) as StoredSettings['schedule']['mode'],
      intervalMinutes: int(row.schedule_interval_minutes, DEFAULT_SCHEDULE.intervalMinutes),
      dailyTime: str(row.schedule_daily_time, DEFAULT_SCHEDULE.dailyTime),
      runAssetAnalysis: bool(row.schedule_run_asset, DEFAULT_SCHEDULE.runAssetAnalysis),
      runWatchlistAnalysis: bool(row.schedule_run_watchlist, DEFAULT_SCHEDULE.runWatchlistAnalysis),
      runAdvice: bool(row.schedule_run_advice, DEFAULT_SCHEDULE.runAdvice),
    },
    enforceBudget: bool(row.enforce_budget, DEFAULT_ENFORCE_BUDGET),
    watchlistCandidateLimit: int(row.watchlist_candidate_limit, DEFAULT_WATCHLIST_CANDIDATE_LIMIT),
    watchlistRetireDeleteRuns: int(row.watchlist_retire_delete_runs, DEFAULT_WATCHLIST_RETIRE_DELETE_RUNS),
    lastRunAt: nullableStr(row.last_run_at),
    updatedAt: str(row.updated_at, nowIso()),
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
 * `clearAllData` 清空的表。数组顺序即删除顺序：子表在父表之前，避免外键约束
 * （`transactions.asset_id → assets.id`）。表名来自本常量而非请求参数。
 */
const CLEARED_TABLES = [
  'transactions',
  'assets',
  'watchlist',
  'advice',
  'advice_outcomes',
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
         schedule_run_asset, schedule_run_watchlist, schedule_run_advice, last_run_at, updated_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
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
      DEFAULT_SCHEDULE.mode,
      DEFAULT_SCHEDULE.intervalMinutes,
      DEFAULT_SCHEDULE.dailyTime,
      DEFAULT_SCHEDULE.runAssetAnalysis ? 1 : 0,
      DEFAULT_SCHEDULE.runWatchlistAnalysis ? 1 : 0,
      DEFAULT_SCHEDULE.runAdvice ? 1 : 0,
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
      schedule: { ...current.schedule, ...withoutUndefined(patch.schedule) },
      enforceBudget: patch.enforceBudget ?? current.enforceBudget,
      watchlistCandidateLimit: patch.watchlistCandidateLimit ?? current.watchlistCandidateLimit,
      watchlistRetireDeleteRuns: patch.watchlistRetireDeleteRuns ?? current.watchlistRetireDeleteRuns,
      toolPolicy: mergeToolPolicy(current.toolPolicy, patch.toolPolicy),
      mcpServers: patch.mcpServers !== undefined ? patch.mcpServers : current.mcpServers,
      lastRunAt: patch.lastRunAt !== undefined ? patch.lastRunAt : current.lastRunAt,
      updatedAt: nowIso(),
    };

    this.run(
      `UPDATE settings SET
         persona = ?, report_style = ?, llm_base_url = ?, llm_api_key = ?, llm_model = ?, llm_temperature = ?,
         llm_max_tokens = ?, llm_fast_model = ?, llm_timeout_ms = ?, llm_context_tokens = ?, data_sources = ?,
         tool_policy = ?, mcp_servers = ?, budget_cny = ?,
         budget_hkd = ?, budget_usd = ?, enforce_budget = ?, watchlist_candidate_limit = ?,
         watchlist_retire_delete_runs = ?, schedule_mode = ?,
         schedule_interval_minutes = ?, schedule_daily_time = ?, schedule_run_asset = ?, schedule_run_watchlist = ?,
         schedule_run_advice = ?, last_run_at = ?, updated_at = ?
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
      merged.schedule.mode,
      merged.schedule.intervalMinutes,
      merged.schedule.dailyTime,
      merged.schedule.runAssetAnalysis ? 1 : 0,
      merged.schedule.runWatchlistAnalysis ? 1 : 0,
      merged.schedule.runAdvice ? 1 : 0,
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
         id, batch_id, asset_id, watch_item_id, asset_name, code, market, type, action, target_shares,
         target_price, currency, reason, confidence, status, executed_shares, executed_price, created_at, decided_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)`,
      input.id,
      input.batchId,
      input.assetId ?? null,
      input.watchItemId ?? null,
      input.assetName ?? '',
      input.code,
      input.market,
      input.type,
      input.action,
      input.targetShares ?? 0,
      input.targetPrice ?? 0,
      input.currency ?? DEFAULT_CURRENCY(input.market),
      input.reason ?? '',
      input.confidence ?? 0,
      input.status ?? 'pending',
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
      ['action', 'action'],
      ['targetShares', 'target_shares'],
      ['targetPrice', 'target_price'],
      ['currency', 'currency'],
      ['reason', 'reason'],
      ['confidence', 'confidence'],
      ['status', 'status'],
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
      values.push(value);
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
    };
  }

  importAll(bundle: ExportBundle, mode: ImportMode): ImportResult {
    return this.transaction(() => {
      const result: ImportResult = { assets: 0, transactions: 0, watchlist: 0, advice: 0, skipped: 0, mode };

      if (mode === 'replace') {
        this.run('DELETE FROM transactions');
        this.run('DELETE FROM assets');
        this.run('DELETE FROM watchlist');
        this.run('DELETE FROM advice');
      }

      const knownAssetIds = new Set(this.all('SELECT id FROM assets').map((row) => str(row.id)));
      const knownTxIds = new Set(this.all('SELECT id FROM transactions').map((row) => str(row.id)));
      const knownWatchIds = new Set(this.all('SELECT id FROM watchlist').map((row) => str(row.id)));
      const knownAdviceIds = new Set(this.all('SELECT id FROM advice').map((row) => str(row.id)));

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
    this.createAdvice(row);
    if (row.executedShares !== null || row.executedPrice !== null || row.decidedAt !== null) {
      this.updateAdvice(row.id, {
        executedShares: row.executedShares,
        executedPrice: row.executedPrice,
        decidedAt: row.decidedAt,
      });
    }
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
    const content =
      input.content.length > MAX_RUN_MESSAGE_CHARS
        ? `${input.content.slice(0, MAX_RUN_MESSAGE_CHARS)}…（已截断，原始 ${input.content.length} 字符）`
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
const TX_SOURCES = new Set(['manual', 'ai', 'advice']);

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
    (row.action === 'buy' || row.action === 'sell')
  );
}
