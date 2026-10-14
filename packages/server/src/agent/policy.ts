/**
 * P1-1: tool authorisation policy + write-approval gate + audit trail.
 *
 * Owned by: P1 workstream. Installed by `index.ts` via
 * {@link installToolInterceptor}; `agent/tools.ts` calls the hooks around
 * *every* tool call (builtin or MCP-provided) from its single dispatch point.
 *
 * Three rules, evaluated in order, in `before`:
 *  1. `settings.toolPolicy.deny` contains the tool → the call is refused with a
 *     structured `policy_denied` result and never reaches the handler;
 *  2. `risk === 'write'` and `settings.toolPolicy.requireWriteApproval` → the
 *     call is stored in `pending_writes` and *not* executed; the model is told to
 *     keep working and to mention the pending item in its conclusion;
 *  3. everything else → allow.
 *
 * `after` records one `audit_log` row per resolved call (executed / denied /
 * deferred / failed). Both hooks are fail-open: a broken audit or settings read
 * logs a warning and must never abort a run.
 *
 * The bypass is intentionally narrow: `runWithApprovalBypass` opens a one-shot
 * window for `POST /api/agent/pending/:id/approve`, where a human has already
 * made the decision. `AsyncLocalStorage` (rather than a module-level boolean)
 * keeps concurrent runs and parallel approvals from leaking the window into
 * each other.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type { ToolPolicy, ToolRisk } from '@aia/shared';

import type { LoggerLike } from '../types/agent.js';
import type { AuditRow, PendingWriteRow } from '../types/models.js';
import type { Repo } from '../types/repo.js';
import {
  setToolInterceptor,
  type ToolCallDecision,
  type ToolContext,
  type ToolExecution,
  type ToolOutcome,
} from './tools.js';

export interface PolicyDeps {
  /** Resolved lazily so the interceptor always sees the live repository. */
  getRepo: () => Repo;
  logger: LoggerLike;
}

/** `audit_log.summary` is a display column, not a document. */
const SUMMARY_MAX = 500;
/** `audit_log.args` keeps enough of the payload to explain a write, no more. */
const ARGS_MAX = 2000;
/** `pending_writes.summary` is shown in the approval list. */
const PENDING_SUMMARY_MAX = 300;

/** Set only inside {@link runWithApprovalBypass}; never a process-wide flag. */
const bypass = new AsyncLocalStorage<true>();

/**
 * Opens a one-shot window in which `requireWriteApproval` is ignored.
 *
 * Only the human-approval route may use it: the decision was already taken, so
 * re-deferring the same call would deadlock the queue. Async-context-local, so
 * an unrelated concurrent run stays gated.
 */
export function runWithApprovalBypass<T>(fn: () => Promise<T>): Promise<T> {
  return bypass.run(true, fn);
}

function inApprovalBypass(): boolean {
  return bypass.getStore() === true;
}

/** Installs the policy + audit interceptor (`agent/tools.ts` seam). */
export function installToolInterceptor(deps: PolicyDeps): void {
  setToolInterceptor({
    before(name, args, ctx, risk) {
      return beforeCall(deps, name, args, ctx, risk);
    },
    after(name, args, ctx, risk, outcome, result) {
      afterCall(deps, name, args, ctx, risk, outcome, result);
    },
  });
}

/* ────────────────────────────────── before ────────────────────────────────── */

function beforeCall(
  deps: PolicyDeps,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  risk: ToolRisk,
): ToolCallDecision {
  let policy: ToolPolicy;
  try {
    policy = deps.getRepo().getSettings().toolPolicy;
  } catch (error) {
    // Fail open: an unreadable policy must not break every tool call. This
    // mirrors `executeTool`'s own catch around a throwing `before`.
    deps.logger.warn(`tool policy unavailable for ${name}: ${messageOf(error)}`);
    return { action: 'allow' };
  }

  if (Array.isArray(policy.deny) && policy.deny.includes(name)) {
    return { action: 'deny', result: deniedResult(name) };
  }

  if (risk === 'write' && policy.requireWriteApproval === true && !inApprovalBypass()) {
    const summary = describeWrite(name, args);
    const row: PendingWriteRow = {
      id: randomUUID(),
      runId: ctx.runId,
      sessionId: ctx.sessionId ?? null,
      tool: name,
      args: stringify(args),
      summary,
      risk,
      status: 'pending',
      createdAt: new Date().toISOString(),
      decidedAt: null,
      result: null,
    };
    try {
      deps.getRepo().addPendingWrite(row);
    } catch (error) {
      // If the request cannot be queued it must not run: silently executing it
      // would turn "approval required" into "approval skipped".
      deps.logger.warn(`pending write could not be stored for ${name}: ${messageOf(error)}`);
      return { action: 'deny', result: approvalUnavailableResult(name) };
    }
    // `ok:false` on purpose: the write did *not* happen, and the model must not
    // report it as done. The outcome recorded by the dispatcher is `deferred`.
    return { action: 'defer', result: deferredResult(name, row.id, summary) };
  }

  return { action: 'allow' };
}

/** Structured refusal handed back to the model (never an exception). */
function deniedResult(name: string): ToolExecution {
  return {
    ok: false,
    summary: `工具 ${name} 被设置中的策略禁用`,
    content: JSON.stringify({
      error: 'policy_denied',
      message:
        `工具「${name}」已被设置中的工具策略（deny 列表）禁用，本次调用未执行。` +
        '请改用只读工具完成分析；如果该项确实需要改动，请在结论中说明并由用户手动操作。',
    }),
  };
}

/** Stored, but nothing ran yet — the human decides. */
function deferredResult(name: string, pendingId: string, summary: string): ToolExecution {
  return {
    ok: false,
    summary: `${summary}：已提交人工审批`,
    content: JSON.stringify({
      error: 'pending_approval',
      pendingId,
      message:
        `工具「${name}」是写入操作，该写入已提交人工审批，本次调用未执行、数据尚未变更。` +
        '请先继续其它只读工作，或在结论中说明待审批项（用户可在「审计与审批」中确认或驳回）。',
    }),
  };
}

function approvalUnavailableResult(name: string): ToolExecution {
  return {
    ok: false,
    summary: `写入 ${name} 未能登记审批，已阻止执行`,
    content: JSON.stringify({
      error: 'approval_unavailable',
      message:
        `工具「${name}」需要人工审批，但审批队列写入失败，为安全起见已阻止执行。` +
        '请改用只读工具，或提示用户检查数据库状态后重试。',
    }),
  };
}

/* ─────────────────────────────────── after ────────────────────────────────── */

function afterCall(
  deps: PolicyDeps,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  risk: ToolRisk,
  outcome: ToolOutcome,
  result: ToolExecution,
): void {
  recordAudit(deps, {
    runId: ctx.runId ?? null,
    sessionId: ctx.sessionId ?? null,
    tool: name,
    risk,
    outcome,
    entity: result.entity?.entity ?? null,
    entityId: result.entity?.id ?? null,
    summary: result.summary ?? '',
    args: stringify(args),
  });
}

export interface AuditInput {
  runId: string | null;
  sessionId: string | null;
  tool: string;
  risk: ToolRisk;
  outcome: AuditRow['outcome'];
  entity?: string | null;
  entityId?: string | null;
  summary: string;
  args: string;
}

/**
 * Appends one audit row. Shared with `routes/approval.ts` so a manual
 * approve/reject is truncated and fail-open exactly like an intercepted call;
 * any failure is warned about and swallowed.
 */
export function recordAudit(deps: PolicyDeps, input: AuditInput): void {
  try {
    deps.getRepo().addAudit({
      id: randomUUID(),
      at: new Date().toISOString(),
      runId: input.runId,
      sessionId: input.sessionId,
      tool: input.tool,
      risk: input.risk,
      outcome: input.outcome,
      entity: input.entity ?? null,
      entityId: input.entityId ?? null,
      summary: clip(input.summary, SUMMARY_MAX),
      args: clip(input.args, ARGS_MAX),
    });
  } catch (error) {
    deps.logger.warn(`audit log write failed for ${input.tool}: ${messageOf(error)}`);
  }
}

/* ───────────────────────────────── helpers ────────────────────────────────── */

/** Human wording for the known write tools; unknown tools fall back to the name. */
const WRITE_LABELS: Record<string, string> = {
  save_asset_analysis: '写回持仓分析结论',
  upsert_watch_item: '新建/更新自选标的',
  create_advice: '写入买卖建议',
  save_dashboard_briefing: '写入组合简报',
};

/** Arg keys that make a pending row identifiable at a glance, in priority order. */
const HINT_KEYS = ['code', 'market', 'assetId', 'watchItemId', 'id', 'name', 'text', 'reason'];

function describeWrite(tool: string, args: Record<string, unknown>): string {
  const label = WRITE_LABELS[tool] ?? `调用写入工具 ${tool}`;
  const hint = argHint(args);
  return clip(hint ? `${label}（${hint}）` : label, PENDING_SUMMARY_MAX);
}

function argHint(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of HINT_KEYS) {
    if (parts.length >= 3) break;
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') parts.push(`${key}=${clip(value.trim(), 40)}`);
  }
  return parts.join(' ');
}

/** Never throws: an unserialisable payload becomes `{}` rather than killing the run. */
function stringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}) ?? '{}';
  } catch {
    return '{}';
  }
}

function clip(text: string, max: number): string {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return value.length <= max ? value : value.slice(0, max);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
