/**
 * P1-1: tool policy + audit + write-approval routes.
 *
 * Owned by: P1 workstream. Registered by `routes/index.ts` (Lead).
 * Contract: docs/API.md §9.2 (审计与审批).
 *
 *   GET  /api/agent/audit?limit=&risk=&outcome=&runId=  → bare `AuditEntry[]`
 *   GET  /api/agent/pending?status=                     → bare `PendingWrite[]`
 *   POST /api/agent/pending/:id/approve                 → { pending, result }
 *   POST /api/agent/pending/:id/reject                  → { pending }
 *
 * `approve` is the *only* place that runs a deferred write: it re-dispatches the
 * stored tool + args through `executeTool` inside `runWithApprovalBypass`, so the
 * call goes through the normal tool layer (argument parsing, write-permission
 * check, audit) exactly once, and the policy gate does not defer it again.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AuditEntry, PendingWrite } from '@aia/shared';

import { conflict, notFound } from '../errors.js';
import { getRepo } from '../registry.js';
import { parseOrThrow } from '../db/util.js';
import { executeTool, type AllowWrite, type ToolContext, type ToolExecution } from '../agent/tools.js';
import { recordAudit, runWithApprovalBypass } from '../agent/policy.js';
import type { LoggerLike } from '../types/agent.js';

/** Writes the approval flow is allowed to perform (mirrors the agent's own set). */
const APPROVAL_WRITES: AllowWrite[] = ['asset', 'watchlist', 'advice', 'briefing', 'settings'];

const auditQuerySchema = z.object({
  // Clamped to 500 below rather than rejected: a too-large `limit` must not 400.
  limit: z.coerce.number().int().optional(),
  risk: z.enum(['read', 'external', 'write']).optional(),
  outcome: z.enum(['executed', 'denied', 'deferred', 'failed']).optional(),
  runId: z.string().min(1).optional(),
});

const pendingQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'failed']).optional(),
});

const rejectBodySchema = z.object({
  reason: z.string().max(2000).optional(),
});

function loggerOf(app: FastifyInstance): LoggerLike {
  return app.log as unknown as LoggerLike;
}

/**
 * Drops `?key=` / `?key` (empty) entries so the documented query templates
 * (`…/audit?limit=&risk=&outcome=&runId=`, `…/pending?status=`) work verbatim
 * instead of failing enum/coercion validation.
 */
function withoutEmpty(query: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!query || typeof query !== 'object') return out;
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === '' || value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

export async function registerApprovalRoutes(app: FastifyInstance): Promise<void> {
  /* ── audit trail ───────────────────────────────────────────────────────── */

  app.get('/api/agent/audit', async (request) => {
    const query = parseOrThrow(auditQuerySchema, withoutEmpty(request.query), '审计查询参数');
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    // Frozen contract: a BARE array (same style as /api/settings/data-sources).
    return getRepo().listAudit({
      limit,
      ...(query.runId ? { runId: query.runId } : {}),
      ...(query.risk ? { risk: query.risk } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
    }) satisfies AuditEntry[];
  });

  /* ── pending writes ────────────────────────────────────────────────────── */

  app.get('/api/agent/pending', async (request) => {
    const query = parseOrThrow(pendingQuerySchema, withoutEmpty(request.query), '待审批查询参数');
    // Newest first; the repo caps the page at 500 rows.
    return getRepo().listPendingWrites(query.status, 500) satisfies PendingWrite[];
  });

  app.post('/api/agent/pending/:id/approve', async (request) => {
    const { id } = request.params as { id: string };
    const repo = getRepo();
    const row = repo.getPendingWrite(id);
    if (!row) throw notFound(`待审批写入 ${id} 不存在`);
    if (row.status !== 'pending') throw conflict(`待审批写入 ${id} 已处理（${row.status}），不能重复审批`);

    const deps = { getRepo: () => repo, logger: loggerOf(app) };
    // Minimal context: the original run may be long gone, so identity comes from
    // the stored row and the write set is the full approval set.
    const ctx: ToolContext = {
      runId: row.runId ?? 'approval',
      kind: 'custom',
      repo,
      logger: deps.logger,
      sink: () => {},
      allowWrites: new Set<AllowWrite>(APPROVAL_WRITES),
      target: null,
      batchId: 'approval',
      ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    };

    const result: ToolExecution = await runWithApprovalBypass(() => executeTool(row.tool, row.args, ctx));
    const decidedAt = new Date().toISOString();
    const pending = repo.updatePendingWrite(id, {
      status: 'approved',
      decidedAt,
      result: clip(result.summary || (result.ok ? '已执行' : '执行失败'), 500),
    });
    // D2: the audit row for this execution is written by the tool interceptor
    // (`interceptor.after`) — recording another one here produced two identical
    // `executed` entries per approval in the real (wired) process.

    return { pending: pending ?? row, result: result.summary };
  });

  app.post('/api/agent/pending/:id/reject', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(rejectBodySchema, request.body ?? {}, '驳回参数');
    const repo = getRepo();
    const row = repo.getPendingWrite(id);
    if (!row) throw notFound(`待审批写入 ${id} 不存在`);
    if (row.status !== 'pending') throw conflict(`待审批写入 ${id} 已处理（${row.status}），不能重复审批`);

    const reason = typeof body.reason === 'string' && body.reason.trim() !== '' ? body.reason.trim() : '用户驳回';
    const decidedAt = new Date().toISOString();
    const pending = repo.updatePendingWrite(id, { status: 'rejected', decidedAt, result: reason });
    recordAudit({ getRepo: () => repo, logger: loggerOf(app) }, {
      runId: row.runId,
      sessionId: row.sessionId,
      tool: row.tool,
      risk: row.risk,
      outcome: 'denied',
      summary: `用户驳回写入：${reason}`,
      args: row.args,
    });

    return { pending: pending ?? row };
  });
}

function clip(text: string, max: number): string {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return value.length <= max ? value : value.slice(0, max);
}
