/**
 * AI 流水线 SSE + 运行记录 + 工具清单 (docs/API.md §4/§5/§6/§9).
 *
 * Owner: agent-engine.
 *
 * SSE rule (docs/API.md §0): once the stream is open the HTTP status can no
 * longer change, so every failure is converted into `error` +
 * `run-finished(status='error')` events. Missing configuration is rejected
 * *before* opening the stream with HTTP 400 `NOT_CONFIGURED`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AgentRunKind, AgentRunSummary } from '@aia/shared';
import { randomUUID } from 'node:crypto';
import { notFound, notConfigured } from '../errors.js';
import { getAgent, getRepo, getScheduler } from '../registry.js';
import { openSse } from './sse.js';
import { NOT_CONFIGURED_MESSAGE } from '../agent/llm.js';
import type { AgentRunRequest, AgentRuntime, LoggerLike } from '../types/agent.js';
import { runAssetAnalysis, runIpoAnalysis, runWatchlistAnalysis, type PipelineContext } from '../services/analytics.js';
import { latestRunSummary, runFullPipeline } from '../services/advice.js';
import { AUTO_RETRY_MAX_ATTEMPTS } from '../services/auto-retry.js';
import { runExclusive } from '../services/pipeline-lock.js';

function loggerOf(app: FastifyInstance): LoggerLike {
  return app.log as unknown as LoggerLike;
}

/**
 * P0-2: binds the request's AbortSignal to every agent call a pipeline makes.
 *
 * The pipelines live in `services/` and only receive `PipelineContext.agent`, so
 * closing over the agent keeps the signal end-to-end without threading it
 * through every service signature (and without touching frozen types). The
 * injected signal always wins over a pipeline-supplied one.
 */
function withSignal(agent: AgentRuntime, signal: AbortSignal): AgentRuntime {
  return {
    isConfigured: () => agent.isConfigured(),
    tools: () => agent.tools(),
    run: (request: AgentRunRequest) => agent.run(request.signal ? request : { ...request, signal }),
    resume: (runId: string, request?: Partial<AgentRunRequest>) =>
      agent.resume(runId, request?.signal ? request : { ...request, signal }),
  };
}

/**
 * P0-2: one AbortController per SSE request.
 *
 * Node emits `close` on `request.raw` as soon as its body has been consumed
 * (≈2 ms into an SSE response), so it only counts as a disconnect once the
 * response socket is gone; `reply.raw`'s own `close` is the reliable signal.
 * `finished` separates a normal end from a client hang-up, so the `close` that
 * `stream.close()` triggers can never abort a completed run.
 */
function watchDisconnect(request: FastifyRequest, reply: FastifyReply, controller: AbortController): () => void {
  let finished = false;
  const abort = (): void => {
    if (!finished) controller.abort();
  };
  const onReplyClose = (): void => abort();
  const onRequestClose = (): void => {
    if (reply.raw.destroyed) abort();
  };
  reply.raw.on('close', onReplyClose);
  request.raw.on('close', onRequestClose);
  return () => {
    finished = true;
    reply.raw.off('close', onReplyClose);
    request.raw.off('close', onRequestClose);
  };
}

/**
 * Wraps a pipeline in SSE: checks configuration first, then runs it under the
 * process-wide pipeline lock and always finishes with `run-finished` + `done`.
 *
 * D3: when another pipeline (a scheduled tick or another manual request) already
 * holds the lock we do **not** queue — the client immediately gets
 * `error` + `run-finished(status='error')` + `done`, and no run row is written.
 */
async function streamPipeline(
  request: FastifyRequest,
  app: FastifyInstance,
  reply: FastifyReply,
  label: string,
  run: (context: PipelineContext) => Promise<unknown>,
): Promise<void> {
  const agent = getAgent();
  if (!agent.isConfigured()) throw notConfigured(NOT_CONFIGURED_MESSAGE);

  const controller = new AbortController();
  const stopWatching = watchDisconnect(request, reply, controller);

  reply.hijack();
  const stream = openSse(reply);
  const fallbackRunId = randomUUID();
  const context: PipelineContext = {
    agent: withSignal(agent, controller.signal),
    repo: getRepo(),
    logger: loggerOf(app),
    sink: (event) => stream.send(event),
  };

  try {
    const outcome = await runExclusive(label, () => run(context));
    if (!outcome.ok) {
      loggerOf(app).warn(`pipeline rejected: ${outcome.reason}`);
      stream.send({ type: 'error', message: outcome.reason });
      stream.send({ type: 'run-finished', runId: fallbackRunId, status: 'error', summary: '', error: outcome.reason });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    loggerOf(app).error(`pipeline failed: ${message}`);
    stream.send({ type: 'error', message });
    stream.send({ type: 'run-finished', runId: fallbackRunId, status: 'error', summary: '', error: message });
  } finally {
    stopWatching();
    stream.send({ type: 'done' });
    stream.close();
  }
}

function parseKind(raw: unknown): AgentRunKind | undefined {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const allowed: AgentRunKind[] = [
    'asset-analysis',
    'watchlist-analysis',
    'ipo-analysis',
    // 期权卖权阶段：独立 run kind，活动页可按它筛选（漏加会静默忽略 ?kind= 过滤）。
    'option-advice',
    'advice',
    'chat',
    'scheduled',
    'custom',
  ];
  return allowed.includes(value as AgentRunKind) ? (value as AgentRunKind) : undefined;
}

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  /* ── SSE pipelines ─────────────────────────────────────────────────────── */

  app.post('/api/assets/analyze', async (request, reply) => {
    await streamPipeline(request, app, reply, 'manual:asset-analysis', (context) => runAssetAnalysis(context));
  });

  app.post('/api/watchlist/analyze', async (request, reply) => {
    await streamPipeline(request, app, reply, 'manual:watchlist-analysis', (context) => runWatchlistAnalysis(context));
  });

  app.post('/api/ipo/analyze', async (request, reply) => {
    await streamPipeline(request, app, reply, 'manual:ipo-analysis', (context) => runIpoAnalysis(context));
  });

  app.post('/api/advice/generate', async (request, reply) => {
    await streamPipeline(request, app, reply, 'manual:advice', (context) => runFullPipeline(context));
  });

  app.post('/api/agent/run-now', async (request, reply) => {
    await streamPipeline(request, app, reply, 'manual:run-now', (context) => runFullPipeline(context));
  });

  /* ── run history ───────────────────────────────────────────────────────── */

  /**
   * 定时流水线的自动续跑状态（前端「未完成」提示条据此避免重复手动续跑）。
   *
   * `pending=null` 表示当前没有排期的续跑；`maxAttempts` 是固定的重试上限。
   * 没有调度器（例如只装配了 app 的测试）时也返回合法结构，绝不 500。
   */
  app.get('/api/agent/retry', async () => {
    return {
      pending: getScheduler()?.retryState() ?? null,
      maxAttempts: AUTO_RETRY_MAX_ATTEMPTS,
    };
  });

  app.get('/api/agent/runs', async (request) => {
    const query = (request.query ?? {}) as Record<string, string>;
    const limitRaw = Number.parseInt(query.limit ?? '20', 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 200)) : 20;
    const kind = parseKind(query.kind);
    const repo = getRepo();
    return repo.listRuns({ limit, ...(kind ? { kind } : {}) }).map<AgentRunSummary>((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      title: row.title,
      summary: row.summary,
      error: row.error,
      turns: row.turns,
      stepCount: repo.listSteps(row.id).length,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    }));
  });

  app.get('/api/agent/runs/:id', async (request) => {
    const { id } = request.params as { id: string };
    const repo = getRepo();
    const row = repo.getRun(id);
    if (!row) throw notFound(`运行记录 ${id} 不存在`);
    return { ...row, steps: repo.listSteps(id) };
  });

  app.get('/api/agent/tools', async () => {
    return getAgent()
      .tools()
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        // P1-1/P1-2: the settings UI groups tools by risk and marks MCP origin.
        risk: tool.risk,
        source: tool.source,
      }));
  });

  /* ── "last run" helpers ────────────────────────────────────────────────── */

  app.get('/api/assets/analyze/last', async () => latestRunSummary(getRepo(), 'asset-analysis'));
  app.get('/api/watchlist/analyze/last', async () => latestRunSummary(getRepo(), 'watchlist-analysis'));
  app.get('/api/ipo/analyze/last', async () => latestRunSummary(getRepo(), 'ipo-analysis'));
  app.get('/api/advice/last', async () => latestRunSummary(getRepo(), 'advice'));
}
