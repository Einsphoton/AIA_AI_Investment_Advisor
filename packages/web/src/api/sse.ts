/**
 * Server-Sent-Events client for POST endpoints. Owner: Lead.
 *
 * Uses fetch + ReadableStream (no EventSource, which cannot POST). Wire format
 * is documented in docs/API.md §0: `event: <type>\n` + `data: <json>\n\n`.
 */
import type { AgentEvent } from '@aia/shared';

export interface StreamHandlers {
  onEvent: (event: AgentEvent) => void;
  /** Called once when the stream ends (successfully or not). */
  onClose?: () => void;
  onError?: (error: Error) => void;
}

export interface StreamHandle {
  /** Aborts the client-side read. The server finishes its run regardless. */
  cancel: () => void;
  done: Promise<void>;
}

export function streamPost(path: string, body: unknown, handlers: StreamHandlers): StreamHandle {
  const controller = new AbortController();
  const done = (async () => {
    try {
      const response = await fetch(`/api${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        // Errors before the stream starts arrive as regular JSON.
        const text = await response.text();
        let message = `请求失败（HTTP ${response.status}）`;
        let code = `HTTP_${response.status}`;
        try {
          const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
          message = parsed.error?.message ?? message;
          code = parsed.error?.code ?? code;
        } catch {
          /* keep defaults */
        }
        handlers.onEvent({ type: 'error', message });
        handlers.onEvent({ type: 'done' });
        throw Object.assign(new Error(message), { code });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });

        let separator = buffer.indexOf('\n\n');
        while (separator !== -1) {
          const raw = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const event = parseChunk(raw);
          if (event) handlers.onEvent(event);
          separator = buffer.indexOf('\n\n');
        }
      }
      if (buffer.trim()) {
        const event = parseChunk(buffer);
        if (event) handlers.onEvent(event);
      }
      handlers.onClose?.();
    } catch (error) {
      const err = error as Error;
      if (err.name === 'AbortError') {
        handlers.onClose?.();
        return;
      }
      handlers.onError?.(err);
      handlers.onEvent({ type: 'error', message: err.message });
      handlers.onClose?.();
    }
  })();

  return { cancel: () => controller.abort(), done };
}

function parseChunk(raw: string): AgentEvent | null {
  if (!raw || raw.startsWith(':')) return null;
  let data = '';
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  try {
    return JSON.parse(data) as AgentEvent;
  } catch {
    return { type: 'error', message: `无法解析服务端事件：${data.slice(0, 200)}` };
  }
}
