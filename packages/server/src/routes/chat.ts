/**
 * AI Chat — 会话 CRUD + 流式对话 (docs/API.md §7).
 *
 * Owner: agent-engine. The assistant reply is produced by the shared Agent Loop
 * (`kind: 'chat'`) with read/write tools; the transcript is persisted so the UI
 * can reload tool steps per message.
 */
import type { FastifyInstance } from 'fastify';
import type { AgentStep, ChatMessage, ChatSession } from '@aia/shared';
import { randomUUID } from 'node:crypto';
import { badRequest, notFound, notConfigured } from '../errors.js';
import { getAgent, getRepo } from '../registry.js';
import { openSse } from './sse.js';
import { NOT_CONFIGURED_MESSAGE } from '../agent/llm.js';
import type { LoggerLike } from '../types/agent.js';

const DEFAULT_TITLE = '新会话';
const MAX_TITLE_CHARS = 24;

function loggerOf(app: FastifyInstance): LoggerLike {
  return app.log as unknown as LoggerLike;
}

function toSession(row: { id: string; title: string; createdAt: string; updatedAt: string }): ChatSession {
  let messageCount = 0;
  try {
    messageCount = getRepo().listMessages(row.id).length;
  } catch {
    messageCount = 0;
  }
  return { id: row.id, title: row.title, createdAt: row.createdAt, updatedAt: row.updatedAt, messageCount };
}

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/chat/sessions', async () => {
    const repo = getRepo();
    return repo.listSessions().map((row) => toSession(row));
  });

  app.post('/api/chat/sessions', async (request) => {
    const body = (request.body ?? {}) as { title?: unknown };
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 60) : DEFAULT_TITLE;
    const repo = getRepo();
    const created = repo.createSession(randomUUID(), title, new Date().toISOString());
    return toSession(created);
  });

  app.delete('/api/chat/sessions/:id', async (request) => {
    const { id } = request.params as { id: string };
    const repo = getRepo();
    if (!repo.getSession(id)) throw notFound(`会话 ${id} 不存在`);
    repo.deleteSession(id);
    return { ok: true };
  });

  app.get('/api/chat/sessions/:id/messages', async (request) => {
    const { id } = request.params as { id: string };
    const repo = getRepo();
    if (!repo.getSession(id)) throw notFound(`会话 ${id} 不存在`);
    return repo.listMessages(id).map<ChatMessage>((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      role: row.role,
      content: row.content,
      toolCalls: row.toolCalls,
      toolCallId: row.toolCallId,
      steps: (row.runId ? safeSteps(row.runId) : []) as AgentStep[],
      createdAt: row.createdAt,
      runId: row.runId,
    }));
  });

  app.post('/api/chat/sessions/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { content?: unknown };
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) throw badRequest('content 不能为空');

    const repo = getRepo();
    const session = repo.getSession(id);
    if (!session) throw notFound(`会话 ${id} 不存在`);

    const agent = getAgent();
    if (!agent.isConfigured()) throw notConfigured(NOT_CONFIGURED_MESSAGE);

    const now = new Date().toISOString();
    repo.addMessage({
      id: randomUUID(),
      sessionId: id,
      role: 'user',
      content,
      toolCalls: null,
      toolCallId: null,
      runId: null,
      createdAt: now,
    });
    const history = repo.listMessages(id);
    const title =
      !session.title || session.title === DEFAULT_TITLE
        ? content.replace(/\s+/g, ' ').slice(0, MAX_TITLE_CHARS)
        : undefined;

    reply.hijack();
    const stream = openSse(reply);
    const fallbackRunId = randomUUID();

    // P0-2: cancel the run when the client hangs up. Node also emits `close` on
    // `request.raw` as soon as its body was consumed, so that one only counts
    // once the response socket is gone; `finished` keeps a normal end from
    // aborting the run it just wrote.
    const controller = new AbortController();
    let finished = false;
    const onReplyClose = (): void => {
      if (!finished) controller.abort();
    };
    const onRequestClose = (): void => {
      if (!finished && reply.raw.destroyed) controller.abort();
    };
    reply.raw.on('close', onReplyClose);
    request.raw.on('close', onRequestClose);

    try {
      const run = await agent.run({
        kind: 'chat',
        title: title ?? session.title,
        goal: content,
        target: `chat:${id}`,
        sessionId: id,
        messages: history.map<ChatMessage>((row) => ({
          id: row.id,
          sessionId: row.sessionId,
          role: row.role,
          content: row.content,
          toolCalls: row.toolCalls,
          toolCallId: row.toolCallId,
          steps: [],
          createdAt: row.createdAt,
          runId: row.runId,
        })),
        sink: (event) => stream.send(event),
        signal: controller.signal,
        allowWrites: ['asset', 'watchlist', 'advice', 'briefing'],
      });

      // P0-2: a cancelled run still stores the partial answer it produced
      // (nothing already written is rolled back).
      const assistantText =
        run.status === 'done'
          ? run.summary
          : run.summary.trim()
            ? `${run.summary}\n\n（本次回答中断：${run.error ?? '未知错误'}）`
            : `（本次回答失败：${run.error ?? '未知错误'}）`;
      repo.addMessage({
        id: randomUUID(),
        sessionId: id,
        role: 'assistant',
        content: assistantText,
        toolCalls: null,
        toolCallId: null,
        runId: run.id,
        createdAt: new Date().toISOString(),
      });
      try {
        repo.touchSession(id, title);
      } catch (error) {
        loggerOf(app).warn(`touchSession failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      loggerOf(app).error(`chat run failed: ${message}`);
      stream.send({ type: 'error', message });
      stream.send({ type: 'run-finished', runId: fallbackRunId, status: 'error', summary: '', error: message });
    } finally {
      finished = true;
      reply.raw.off('close', onReplyClose);
      request.raw.off('close', onRequestClose);
      stream.send({ type: 'done' });
      stream.close();
    }
  });
}

function safeSteps(runId: string): AgentStep[] {
  try {
    return getRepo().listSteps(runId);
  } catch {
    return [];
  }
}
