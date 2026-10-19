/**
 * P1-3: run trajectory replay + resume routes.
 *
 * Owned by: P1 workstream. Registered by `routes/index.ts` (Lead).
 * Contract: docs/API.md §9.4 (轨迹与续跑).
 *
 *   GET  /api/agent/runs/:id/trace  → AgentTrace (messages + steps + audit + pending)
 *   POST /api/agent/runs/:id/resume → SSE, continues from the stored transcript
 *
 * SSE rule (docs/API.md §0), same as `routes/agent.ts`: once the stream is open
 * the HTTP status can no longer change, so 404/409 are thrown *before*
 * `reply.hijack()` and every later failure becomes `error` +
 * `run-finished(status='error')` + `done`. The pipeline lock is shared with the
 * scheduled tick and the manual pipelines, so a resume never runs concurrently
 * with another run — a held lock is answered immediately instead of queueing.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';

import type { AgentTrace } from '@aia/shared';

import { conflict, notFound } from '../errors.js';
import { getAgent, getRepo } from '../registry.js';
import { openSse } from './sse.js';
import { hasAutoResumedMark } from '../services/auto-retry.js';
import { runExclusive } from '../services/pipeline-lock.js';
import type { LoggerLike } from '../types/agent.js';

/** P1-1 audit / pending page size for a single run's trajectory. */
const TRACE_PAGE = 500;

function loggerOf(app: FastifyInstance): LoggerLike {
  return app.log as unknown as LoggerLike;
}

export async function registerRunRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/agent/runs/:id/trace', async (request) => {
    const { id } = request.params as { id: string };
    const repo = getRepo();
    const row = repo.getRun(id);
    if (!row) throw notFound(`运行记录 ${id} 不存在`);
    const steps = repo.listSteps(id);
    const trace: AgentTrace = {
      run: { ...row, steps },
      messages: repo.listRunMessages(id),
      steps,
      audit: repo.listAudit({ runId: id, limit: TRACE_PAGE }),
      // D5: filter by run in SQL — paging first and filtering afterwards silently
      // hid rows of older runs once the table grew past the page size.
      pendingWrites: repo.listPendingWritesByRun(id, TRACE_PAGE),
    };
    return trace;
  });

  app.post('/api/agent/runs/:id/resume', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getRepo().getRun(id);
    // Both checks must happen before the stream opens to keep a real status code.
    if (!row) throw notFound(`运行记录 ${id} 不存在`);
    if (row.status === 'done') throw conflict(`运行记录 ${id} 已完成，无需续跑`);
    // 定时流水线已自动续跑成功：同一份轨迹再跑一遍只会重复烧 token（见 auto-retry.ts）。
    if (hasAutoResumedMark(row.error)) throw conflict(`运行记录 ${id} 已由系统自动续跑成功，无需再次续跑`);
    await streamResume(app, reply, id);
  });
}

/** Opens the SSE stream, resumes under the pipeline lock, always emits `done`. */
async function streamResume(app: FastifyInstance, reply: FastifyReply, runId: string): Promise<void> {
  const log = loggerOf(app);
  reply.hijack();
  const stream = openSse(reply);

  try {
    const outcome = await runExclusive('manual:resume', () =>
      getAgent().resume(runId, { sink: (event) => stream.send(event) }),
    );
    if (!outcome.ok) {
      log.warn(`resume rejected: ${outcome.reason}`);
      stream.send({ type: 'error', message: outcome.reason });
      stream.send({ type: 'run-finished', runId, status: 'error', summary: '', error: outcome.reason });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`resume failed: ${message}`);
    stream.send({ type: 'error', message });
    stream.send({ type: 'run-finished', runId, status: 'error', summary: '', error: message });
  } finally {
    stream.send({ type: 'done' });
    stream.close();
  }
}
