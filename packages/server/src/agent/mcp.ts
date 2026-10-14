/**
 * P1-2: minimal Model Context Protocol (MCP) client over JSON-RPC 2.0.
 *
 * Scope (deliberately minimal — docs/API.md §9.3):
 *   `initialize` → `notifications/initialized` → `tools/list` → `tools/call`.
 * MCP `resources`, `prompts`, `sampling`, roots and server-initiated requests are
 * **not** implemented; unknown server→client requests are ignored.
 *
 * The transport is injectable ({@link McpTransport}) so tests never spawn a
 * child process: the Windows sandbox denies `spawn` when stdio is captured, and
 * the stdio transport surfaces that failure through `onClose` instead of
 * throwing at the caller.
 *
 * Owner: P1-2 workstream.
 */
import { spawn } from 'node:child_process';

/** Injectable JSON-RPC transport (line-delimited stdio or HTTP POST). */
export interface McpTransport {
  send(message: unknown): void | Promise<void>;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: (error?: Error) => void): void;
  close(): void;
}

export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpServerInfo {
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
}

export interface McpCallResult {
  content: string;
  summary: string;
  isError: boolean;
}

/** Protocol revision this client speaks. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_CLIENT_NAME = 'ai-investment-advisor';
export const MCP_CLIENT_VERSION = '0.1.0';
/** Default per-request timeout. */
export const MCP_TIMEOUT_MS = 15_000;
/** HTTP transport request timeout. */
const MCP_HTTP_TIMEOUT_MS = 15_000;

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/* ───────────────────────────────── client ─────────────────────────────────── */

export interface McpClientOptions {
  transport: McpTransport;
  clientName?: string;
  /** Per-request timeout in ms (default {@link MCP_TIMEOUT_MS}). */
  timeoutMs?: number;
}

export class McpClient {
  private readonly transport: McpTransport;
  private readonly clientName: string;
  private readonly timeoutMs: number;
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  /** True once the transport died or `close()` was called. */
  private closed = false;
  private closeError: Error | null = null;

  constructor(options: McpClientOptions) {
    this.transport = options.transport;
    this.clientName = options.clientName || MCP_CLIENT_NAME;
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : MCP_TIMEOUT_MS;
    try {
      this.transport.onMessage((message) => this.handleMessage(message));
      this.transport.onClose((error) => this.handleClose(error));
    } catch {
      /* a broken transport must not break construction; connect() will reject */
    }
  }

  /** `initialize` + `notifications/initialized`. */
  async connect(): Promise<McpServerInfo> {
    const result = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.clientName, version: MCP_CLIENT_VERSION },
    });
    // `notifications/initialized` is a notification: no id, no response, no await.
    this.notify('notifications/initialized');
    const info = asRecord(result);
    const serverInfo = asRecord(info.serverInfo);
    return {
      serverName: typeof serverInfo.name === 'string' && serverInfo.name ? serverInfo.name : 'unknown',
      serverVersion: typeof serverInfo.version === 'string' ? serverInfo.version : '',
      protocolVersion:
        typeof info.protocolVersion === 'string' && info.protocolVersion ? info.protocolVersion : MCP_PROTOCOL_VERSION,
    };
  }

  /** `tools/list` — tolerant of missing/extra fields. */
  async listTools(): Promise<McpToolSpec[]> {
    const result = asRecord(await this.request('tools/list', {}));
    const raw = Array.isArray(result.tools) ? result.tools : [];
    const tools: McpToolSpec[] = [];
    for (const item of raw) {
      const tool = asRecord(item);
      if (typeof tool.name !== 'string' || !tool.name) continue;
      tools.push({
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        ...(isRecord(tool.inputSchema) ? { inputSchema: tool.inputSchema } : {}),
      });
    }
    return tools;
  }

  /** `tools/call` — concatenates the `text` parts of `result.content`. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = asRecord(await this.request('tools/call', { name, arguments: args }));
    let content = '';
    if (typeof result.content === 'string') {
      content = result.content;
    } else if (Array.isArray(result.content)) {
      const parts: string[] = [];
      for (const item of result.content) {
        const part = asRecord(item);
        if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
      }
      content = parts.join('\n');
    }
    return {
      content,
      summary: `工具 ${name} 返回 ${content.length} 字符`,
      isError: result.isError === true,
    };
  }

  /** Rejects every in-flight request; safe to call more than once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = this.closeError ?? new Error('MCP 客户端已关闭');
    this.rejectAll(this.closeError);
    try {
      this.transport.close();
    } catch {
      /* best effort */
    }
  }

  /* ── internals ─────────────────────────────────────────────────────────── */

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closeError ?? new Error('MCP 客户端已关闭'));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时（${this.timeoutMs}ms）：${method}`));
      }, this.timeoutMs);
      // Never keep the process alive just for a pending MCP request.
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params }, id);
    });
  }

  private notify(method: string): void {
    this.write({ jsonrpc: '2.0', method });
  }

  /** A transport write failure fails the caller's request (never throws upward). */
  private write(message: unknown, id?: number): void {
    try {
      const outcome = this.transport.send(message);
      if (outcome && typeof (outcome as Promise<void>).then === 'function') {
        void (outcome as Promise<void>).catch((error: unknown) => {
          const failure = asError(error);
          if (id === undefined) this.handleClose(failure);
          else this.failPending(id, failure);
        });
      }
    } catch (error) {
      const failure = asError(error);
      if (id === undefined) this.handleClose(failure);
      else this.failPending(id, failure);
    }
  }

  private handleMessage(message: unknown): void {
    const frame = asRecord(message);
    const id = frame.id;
    if (typeof id !== 'number') return; // notification (or a server→client request we ignore)
    const call = this.pending.get(id);
    if (!call) return;
    clearTimeout(call.timer);
    this.pending.delete(id);
    if (frame.error !== undefined && frame.error !== null) {
      const error = asRecord(frame.error);
      call.reject(new Error(`MCP 错误：${error.message ?? JSON.stringify(frame.error)}`));
      return;
    }
    call.resolve(frame.result);
  }

  private handleClose(error?: Error): void {
    const failure = error ?? new Error('MCP 传输已关闭');
    if (!this.closed) {
      this.closed = true;
      this.closeError = failure;
    }
    this.rejectAll(failure);
  }

  private failPending(id: number, error: Error): void {
    const call = this.pending.get(id);
    if (!call) return;
    clearTimeout(call.timer);
    this.pending.delete(id);
    call.reject(error);
  }

  private rejectAll(error: Error): void {
    for (const call of [...this.pending.values()]) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }
}

/* ───────────────────────────── stdio transport ───────────────────────────── */

export interface StdioTransportOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Spawns `command args…` and speaks newline-delimited JSON-RPC on stdout.
 * stderr is inherited so the child's diagnostics land in the server log.
 *
 * **A failed `spawn` (e.g. EPERM inside a restricted sandbox) is reported via
 * `onClose`**, never thrown at the caller — the failure is delivered even when
 * `onClose` is registered after the error already happened.
 */
export function createStdioTransport(options: StdioTransportOptions): McpTransport {
  let messageHandler: ((message: unknown) => void) | undefined;
  let closeHandler: ((error?: Error) => void) | undefined;
  let closed = false;
  let notified = false;
  let pendingError: Error | undefined;
  let buffer = '';
  let child: ReturnType<typeof spawn> | undefined;

  const notifyClose = (error?: Error): void => {
    if (notified) return;
    notified = true;
    closed = true;
    pendingError = error;
    if (closeHandler) {
      try {
        closeHandler(error);
      } catch {
        /* ignore handler failures */
      }
    }
  };

  const deliver = (line: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // non-JSON noise on stdout is ignored
    }
    try {
      messageHandler?.(parsed);
    } catch {
      /* ignore handler failures */
    }
  };

  try {
    child = spawn(options.command, options.args, {
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
  } catch (error) {
    // Sandboxed hosts deny `spawn` with captured stdio: degrade instead of throwing.
    notifyClose(asError(error));
  }

  if (child) {
    const stdout = child.stdout;
    if (stdout) {
      stdout.setEncoding('utf8');
      stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line) deliver(line);
          index = buffer.indexOf('\n');
        }
      });
    }
    child.on('error', (error) => notifyClose(asError(error)));
    child.on('close', (code, signal) =>
      notifyClose(new Error(`MCP stdio 进程已退出（code=${code ?? '-'} signal=${signal ?? '-'}）`)),
    );
    child.stdin?.on('error', (error) => notifyClose(asError(error)));
  }

  return {
    send(message) {
      if (closed || !child || !child.stdin || child.stdin.destroyed) {
        throw new Error(`MCP stdio 进程不可用：${options.command}`);
      }
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onMessage(handler) {
      messageHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
      if (notified) {
        try {
          handler(pendingError);
        } catch {
          /* ignore handler failures */
        }
      }
    },
    close() {
      closed = true;
      if (!child) return;
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

/* ────────────────────────────── http transport ───────────────────────────── */

export interface HttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
}

/** Parses a JSON body, a JSON-RPC batch, or SSE-framed `data:` lines. */
function parseHttpMessages(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    /* fall through to SSE framing */
  }
  const out: unknown[] = [];
  for (const line of trimmed.split('\n')) {
    const match = /^data:\s*(.+)$/.exec(line.trim());
    if (!match?.[1]) continue;
    try {
      out.push(JSON.parse(match[1]));
    } catch {
      /* ignore malformed frame */
    }
  }
  return out;
}

/**
 * Streamable-HTTP style transport: every JSON-RPC message is POSTed to `url`
 * and the response body is handed to `onMessage`. A request-level failure closes
 * the transport (pending calls are rejected with the real error).
 */
export function createHttpTransport(options: HttpTransportOptions): McpTransport {
  let messageHandler: ((message: unknown) => void) | undefined;
  let closeHandler: ((error?: Error) => void) | undefined;
  let closed = false;
  let notified = false;
  let pendingError: Error | undefined;
  let sessionId: string | undefined;

  const notifyClose = (error?: Error): void => {
    if (notified) return;
    notified = true;
    closed = true;
    pendingError = error;
    if (closeHandler) {
      try {
        closeHandler(error);
      } catch {
        /* ignore handler failures */
      }
    }
  };

  async function post(message: unknown): Promise<void> {
    if (closed) throw new Error('MCP http 传输已关闭');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MCP_HTTP_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const response = await fetch(options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          ...options.headers,
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      const nextSession = response.headers.get('mcp-session-id');
      if (nextSession) sessionId = nextSession;
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`MCP HTTP ${response.status} ${response.statusText}${text ? `：${text.slice(0, 200)}` : ''}`);
      }
      for (const item of parseHttpMessages(text)) {
        try {
          messageHandler?.(item);
        } catch {
          /* ignore handler failures */
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    send(message) {
      return post(message).catch((error: unknown) => {
        notifyClose(asError(error));
      });
    },
    onMessage(handler) {
      messageHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
      if (notified) {
        try {
          handler(pendingError);
        } catch {
          /* ignore handler failures */
        }
      }
    },
    close() {
      closed = true;
    },
  };
}
