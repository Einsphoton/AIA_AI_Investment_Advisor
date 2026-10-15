/**
 * SQLite DDL for the advisor database.
 *
 * Authoritative column names come from `docs/ARCHITECTURE.md` §3 (snake_case).
 * `migrateSchema` is idempotent: it creates what is missing and never destroys
 * data, so it is safe to run on every boot.
 */
import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS settings (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     persona TEXT NOT NULL DEFAULT 'balanced',
     report_style TEXT NOT NULL DEFAULT 'professional',
     llm_base_url TEXT NOT NULL DEFAULT '',
     llm_api_key TEXT NOT NULL DEFAULT '',
     llm_model TEXT NOT NULL DEFAULT '',
     llm_temperature REAL NOT NULL DEFAULT 0,
     llm_max_tokens INTEGER NOT NULL DEFAULT 0,
     llm_fast_model TEXT NOT NULL DEFAULT '',
     llm_timeout_ms INTEGER NOT NULL DEFAULT 0,
     llm_context_tokens INTEGER NOT NULL DEFAULT 0,
     data_sources TEXT NOT NULL DEFAULT '{}',
     tool_policy TEXT NOT NULL DEFAULT '{}',
     mcp_servers TEXT NOT NULL DEFAULT '[]',
     budget_cny REAL NOT NULL DEFAULT 0,
     budget_hkd REAL NOT NULL DEFAULT 0,
     budget_usd REAL NOT NULL DEFAULT 0,
     enforce_budget INTEGER NOT NULL DEFAULT 1,
     watchlist_candidate_limit INTEGER NOT NULL DEFAULT 5,
     watchlist_retire_delete_runs INTEGER NOT NULL DEFAULT 3,
     schedule_mode TEXT NOT NULL DEFAULT 'off',
     schedule_interval_minutes INTEGER NOT NULL DEFAULT 1440,
     schedule_daily_time TEXT NOT NULL DEFAULT '08:30',
     schedule_run_asset INTEGER NOT NULL DEFAULT 1,
     schedule_run_watchlist INTEGER NOT NULL DEFAULT 1,
     schedule_run_advice INTEGER NOT NULL DEFAULT 1,
     last_run_at TEXT,
     updated_at TEXT NOT NULL DEFAULT ''
   )`,

  `CREATE TABLE IF NOT EXISTS assets (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL DEFAULT '',
     code TEXT NOT NULL,
     market TEXT NOT NULL,
     type TEXT NOT NULL,
     source TEXT NOT NULL DEFAULT 'manual',
     currency TEXT NOT NULL DEFAULT 'CNY',
     note TEXT NOT NULL DEFAULT '',
     ai_summary TEXT NOT NULL DEFAULT '',
     ai_summary_at TEXT,
     thesis TEXT NOT NULL DEFAULT '',
     quality_score REAL NOT NULL DEFAULT 0,
     target_price REAL NOT NULL DEFAULT 0,
     expected_return REAL NOT NULL DEFAULT 0,
     price REAL NOT NULL DEFAULT 0,
     price_at TEXT,
     price_prev_close REAL NOT NULL DEFAULT 0,
     day_change_pct REAL NOT NULL DEFAULT 0,
     spark TEXT NOT NULL DEFAULT '[]',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (code, market, type)
   )`,

  `CREATE TABLE IF NOT EXISTS transactions (
     id TEXT PRIMARY KEY,
     asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     shares REAL NOT NULL DEFAULT 0,
     price REAL NOT NULL DEFAULT 0,
     fee REAL NOT NULL DEFAULT 0,
     trade_date TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     source TEXT NOT NULL DEFAULT 'manual',
     created_at TEXT NOT NULL
   )`,

  // NOTE: `price_prev_close` is an additive extension of the §3 DDL — the frozen
  // `WatchRow` contract exposes `prevClose`, which has no column in ARCHITECTURE §3.
  `CREATE TABLE IF NOT EXISTS watchlist (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL DEFAULT '',
     code TEXT NOT NULL,
     market TEXT NOT NULL,
     type TEXT NOT NULL,
     source TEXT NOT NULL DEFAULT 'manual',
     quality_score REAL NOT NULL DEFAULT 0,
     target_price REAL NOT NULL DEFAULT 0,
     expected_return REAL NOT NULL DEFAULT 0,
     expected_return_horizon TEXT NOT NULL DEFAULT '',
     initial_price REAL NOT NULL DEFAULT 0,
     initial_price_at TEXT,
     price REAL NOT NULL DEFAULT 0,
     price_at TEXT,
     price_prev_close REAL NOT NULL DEFAULT 0,
     day_change_pct REAL NOT NULL DEFAULT 0,
     thesis TEXT NOT NULL DEFAULT '',
     note TEXT NOT NULL DEFAULT '',
     ai_summary TEXT NOT NULL DEFAULT '',
     ai_summary_at TEXT,
     spark TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL DEFAULT 'active',
     retired_reason TEXT NOT NULL DEFAULT '',
     retired_at TEXT,
     retire_streak INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (code, market, type)
   )`,

  `CREATE TABLE IF NOT EXISTS advice (
     id TEXT PRIMARY KEY,
     batch_id TEXT NOT NULL DEFAULT '',
     asset_id TEXT,
     watch_item_id TEXT,
     asset_name TEXT NOT NULL DEFAULT '',
     code TEXT NOT NULL DEFAULT '',
     market TEXT NOT NULL DEFAULT 'CN',
     type TEXT NOT NULL DEFAULT 'stock',
     action TEXT NOT NULL DEFAULT 'buy',
     target_shares REAL NOT NULL DEFAULT 0,
     target_price REAL NOT NULL DEFAULT 0,
     currency TEXT NOT NULL DEFAULT 'CNY',
     reason TEXT NOT NULL DEFAULT '',
     confidence REAL NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'pending',
     executed_shares REAL,
     executed_price REAL,
     created_at TEXT NOT NULL,
     decided_at TEXT
   )`,

  /* ── 建议结果追踪：由序列确定性重算的物化结果（幂等，可随时重建） ──────────── */
  `CREATE TABLE IF NOT EXISTS advice_outcomes (
     advice_id TEXT PRIMARY KEY,
     run_id TEXT,
     code TEXT NOT NULL DEFAULT '',
     market TEXT NOT NULL DEFAULT 'CN',
     type TEXT NOT NULL DEFAULT 'stock',
     action TEXT NOT NULL DEFAULT 'buy',
     currency TEXT NOT NULL DEFAULT 'CNY',
     advised_at TEXT NOT NULL,
     advice_status TEXT NOT NULL DEFAULT 'pending',
     executed INTEGER NOT NULL DEFAULT 0,
     baseline_date TEXT NOT NULL DEFAULT '',
     baseline_price REAL NOT NULL DEFAULT 0,
     last_date TEXT NOT NULL DEFAULT '',
     last_price REAL NOT NULL DEFAULT 0,
     price_change_pct REAL NOT NULL DEFAULT 0,
     advice_return_pct REAL NOT NULL DEFAULT 0,
     benchmark_code TEXT NOT NULL DEFAULT '',
     benchmark_name TEXT NOT NULL DEFAULT '',
     benchmark_base REAL NOT NULL DEFAULT 0,
     benchmark_change_pct REAL NOT NULL DEFAULT 0,
     excess_pct REAL NOT NULL DEFAULT 0,
     max_return_pct REAL NOT NULL DEFAULT 0,
     min_return_pct REAL NOT NULL DEFAULT 0,
     samples INTEGER NOT NULL DEFAULT 0,
     days_tracked INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'tracking',
     warnings TEXT NOT NULL DEFAULT '[]',
     updated_at TEXT NOT NULL DEFAULT ''
   )`,

  `CREATE TABLE IF NOT EXISTS agent_runs (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     status TEXT NOT NULL,
     target TEXT,
     title TEXT NOT NULL DEFAULT '',
     summary TEXT NOT NULL DEFAULT '',
     error TEXT,
     turns INTEGER NOT NULL DEFAULT 0,
     prompt_tokens INTEGER NOT NULL DEFAULT 0,
     completion_tokens INTEGER NOT NULL DEFAULT 0,
     started_at TEXT NOT NULL,
     finished_at TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS agent_steps (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL,
     idx INTEGER NOT NULL DEFAULT 0,
     label TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'pending',
     detail TEXT NOT NULL DEFAULT '',
     tool_name TEXT,
     tool_args TEXT,
     tool_result TEXT,
     started_at TEXT,
     finished_at TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS chat_sessions (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS chat_messages (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     role TEXT NOT NULL,
     content TEXT NOT NULL DEFAULT '',
     tool_calls TEXT,
     tool_call_id TEXT,
     run_id TEXT,
     created_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS kv (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL DEFAULT ''
   )`,

  /* ── P1-1 audit trail: every tool call that could change state or reach out ── */
  `CREATE TABLE IF NOT EXISTS audit_log (
     id TEXT PRIMARY KEY,
     at TEXT NOT NULL,
     run_id TEXT,
     session_id TEXT,
     tool TEXT NOT NULL,
     risk TEXT NOT NULL DEFAULT 'read',
     outcome TEXT NOT NULL DEFAULT 'executed',
     entity TEXT,
     entity_id TEXT,
     summary TEXT NOT NULL DEFAULT '',
     args TEXT NOT NULL DEFAULT ''
   )`,

  /* ── P1-1 pending writes (approval mode) ──────────────────────────────────── */
  `CREATE TABLE IF NOT EXISTS pending_writes (
     id TEXT PRIMARY KEY,
     run_id TEXT,
     session_id TEXT,
     tool TEXT NOT NULL,
     args TEXT NOT NULL DEFAULT '{}',
     summary TEXT NOT NULL DEFAULT '',
     risk TEXT NOT NULL DEFAULT 'write',
     status TEXT NOT NULL DEFAULT 'pending',
     created_at TEXT NOT NULL,
     decided_at TEXT,
     result TEXT
   )`,

  /* ── P1-3 per-run message transcript (resume + trajectory replay) ─────────── */
  `CREATE TABLE IF NOT EXISTS agent_run_messages (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL,
     idx INTEGER NOT NULL,
     role TEXT NOT NULL,
     content TEXT NOT NULL DEFAULT '',
     tool_calls TEXT,
     tool_call_id TEXT,
     name TEXT,
     reasoning_content TEXT,
     created_at TEXT NOT NULL
   )`,
];

export const INDEX_STATEMENTS: string[] = [
  'CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_assets_market ON assets(market)',
  'CREATE INDEX IF NOT EXISTS idx_transactions_asset ON transactions(asset_id)',
  'CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(trade_date)',
  'CREATE INDEX IF NOT EXISTS idx_watchlist_created ON watchlist(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_advice_status ON advice(status)',
  'CREATE INDEX IF NOT EXISTS idx_advice_batch ON advice(batch_id)',
  'CREATE INDEX IF NOT EXISTS idx_advice_created ON advice(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_advice_outcomes_advised ON advice_outcomes(advised_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_advice_outcomes_status ON advice_outcomes(status)',
  'CREATE INDEX IF NOT EXISTS idx_runs_kind_started ON agent_runs(kind, started_at)',
  'CREATE INDEX IF NOT EXISTS idx_steps_run ON agent_steps(run_id, idx)',
  'CREATE INDEX IF NOT EXISTS idx_messages_session ON chat_messages(session_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at)',
  'CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_log(run_id)',
  'CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_writes(status, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_run_messages ON agent_run_messages(run_id, idx)',
];

/** Applies pragmas, creates missing tables/columns/indexes. Idempotent. */
export function migrateSchema(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  for (const statement of SCHEMA_STATEMENTS) db.exec(statement);

  // Forward compatibility for databases created by earlier builds.
  ensureColumn(db, 'assets', 'price_prev_close', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'watchlist', 'price_prev_close', 'REAL NOT NULL DEFAULT 0');
  // P0/P1 additions.
  ensureColumn(db, 'settings', 'llm_context_tokens', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'settings', 'tool_policy', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'settings', 'mcp_servers', "TEXT NOT NULL DEFAULT '[]'");
  // P3 淘汰机制：退役状态 + 连续退役次数（老库补列，默认在池/0 次）。
  ensureColumn(db, 'watchlist', 'status', "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(db, 'watchlist', 'retired_reason', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'watchlist', 'retired_at', 'TEXT');
  ensureColumn(db, 'watchlist', 'retire_streak', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'settings', 'watchlist_retire_delete_runs', 'INTEGER NOT NULL DEFAULT 3');
  // 标的预期收益的到达期限（自由文本，如「6-12 个月」）。
  ensureColumn(db, 'watchlist', 'expected_return_horizon', "TEXT NOT NULL DEFAULT ''");
  // 思考模型（DeepSeek reasoning）要求把 assistant 的思考轨迹回传；老库补列，
  // 否则续跑一个工具循环会在第一轮就 400。
  ensureColumn(db, 'agent_run_messages', 'reasoning_content', 'TEXT');

  for (const statement of INDEX_STATEMENTS) db.exec(statement);
}

export function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name?: unknown }[];
  if (rows.some((row) => String(row.name) === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
