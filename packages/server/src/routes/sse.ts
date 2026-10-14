/**
 * Server-Sent Events plumbing shared by every streaming endpoint.
 *
 * Owned by: Lead. Wire format is frozen in docs/API.md §0:
 *   `event: <type>\n` + `data: <json>\n\n`
 */
import type { FastifyReply } from 'fastify';
import { AGENT_EVENT_TYPES, type AgentEvent } from '@aia/shared';

export interface SseStream {
  /** Queues one event; silently ignores write failures after disconnect. */
  send(event: AgentEvent): void;
  /** Ends the stream exactly once. */
  close(): void;
  readonly closed: boolean;
}

export function openSse(reply: FastifyReply): SseStream {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.flushHeaders?.();

  let closed = false;

  const heartbeat = setInterval(() => {
    if (closed) return;
    try {
      reply.raw.write(': ping\n\n');
    } catch {
      /* client gone; the close handler will clean up */
    }
  }, 15_000);
  heartbeat.unref?.();

  return {
    get closed() {
      return closed;
    },
    send(event: AgentEvent) {
      if (closed) return;
      const type = AGENT_EVENT_TYPES.includes(event.type) ? event.type : 'error';
      try {
        reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        closed = true;
        clearInterval(heartbeat);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      try {
        reply.raw.end();
      } catch {
        /* already ended */
      }
    },
  };
}
