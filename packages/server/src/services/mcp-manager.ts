/**
 * P1-2: MCP server manager — lifecycle, status and the dynamic tool provider.
 *
 * Responsibilities:
 *   - read `Settings.mcpServers` and connect every `enabled === true` server;
 *   - register a single `ToolProvider` (`id: 'mcp'`) so MCP tools show up in
 *     `GET /api/agent/tools` and the LLM tool table as `mcp__<serverId>__<tool>`;
 *   - isolate failures: one broken server is recorded in its own `error` and
 *     never breaks other servers, the catalogue, or the caller (no throwing).
 *
 * Transports are injectable (`deps.createTransport`) so tests use an in-process
 * fake instead of spawning: the Windows sandbox denies `spawn` with captured
 * stdio.
 *
 * Owner: P1-2 workstream.
 */
import type { McpServerConfig, ToolRisk } from '@aia/shared';

import {
  McpClient,
  createHttpTransport,
  createStdioTransport,
  type McpToolSpec,
  type McpTransport,
} from '../agent/mcp.js';
import {
  registerToolProvider,
  unregisterToolProvider,
  type ExternalTool,
  type ToolExecution,
} from '../agent/tools.js';
import type { LoggerLike } from '../types/agent.js';
import type { Repo } from '../types/repo.js';

export const MCP_PROVIDER_ID = 'mcp';
const MAX_TOOL_NAME = 64;
const DEFAULT_INPUT_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} };

/** One row of `GET /api/mcp/servers`. */
export interface McpStatusEntry {
  id: string;
  name: string;
  transport: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  tools: string[];
  error: string | null;
}

/** Payload of `POST /api/mcp/servers/:id/test`. */
export interface McpServerTestResult {
  ok: boolean;
  toolCount: number;
  tools: string[];
  error: string | null;
}

export interface McpDeps {
  getRepo: () => Repo;
  logger: LoggerLike;
  /** Test seam: build the transport for a server instead of spawning/fetching. */
  createTransport?: (config: McpServerConfig) => McpTransport;
  /** Overrides the JSON-RPC per-request timeout (default 15 s). */
  timeoutMs?: number;
}

interface ServerRuntime {
  config: McpServerConfig;
  client: McpClient | null;
  tools: McpToolSpec[];
  connected: boolean;
  error: string | null;
}

let deps: McpDeps | null = null;
const runtimes = new Map<string, ServerRuntime>();
/** Serialises connect/reload work so two reloads never interleave. */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ───────────────────────────── tools mapping ─────────────────────────────── */

function sanitizePart(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned || '_';
}

/** `mcp__<serverId>__<toolName>`, sanitised; the structure survives truncation. */
export function mcpToolName(serverId: string, toolName: string): string {
  const id = sanitizePart(serverId);
  const tool = sanitizePart(toolName);
  const name = `mcp__${id}__${tool}`;
  if (name.length <= MAX_TOOL_NAME) return name;
  // D6: never let truncation swallow the `mcp__<id>__` structure — shrink each
  // part instead, so tools of one server stay recognisable and distinguishable.
  const fixed = 'mcp__'.length + '__'.length;
  const room = Math.max(2, MAX_TOOL_NAME - fixed);
  const idRoom = Math.max(1, Math.min(id.length, Math.floor(room / 2)));
  const toolRoom = Math.max(1, room - idRoom);
  return `mcp__${id.slice(0, idRoom)}__${tool.slice(0, toolRoom)}`;
}

function makeHandler(serverId: string, toolName: string, displayName: string) {
  return async (args: Record<string, unknown>): Promise<ToolExecution> => {
    const runtime = runtimes.get(serverId);
    const client = runtime?.client;
    if (!runtime || !runtime.connected || !client) {
      return {
        ok: false,
        summary: `${displayName} 不可用`,
        content: JSON.stringify({ error: 'mcp_error', message: `MCP 服务器 ${serverId} 当前未连接` }),
      };
    }
    try {
      const result = await client.callTool(toolName, args);
      return { ok: !result.isError, content: result.content, summary: result.summary };
    } catch (error) {
      // Never throw at the tool layer: hand the model a structured, actionable error.
      return {
        ok: false,
        summary: `${displayName} 调用失败`,
        content: JSON.stringify({
          error: 'mcp_error',
          message: `MCP 工具 ${toolName} 调用失败：${errorMessage(error)}`,
        }),
      };
    }
  };
}

function buildTools(): ExternalTool[] {
  const out: ExternalTool[] = [];
  const used = new Set<string>();
  for (const runtime of runtimes.values()) {
    if (!runtime.connected || !runtime.client) continue;
    for (const spec of runtime.tools) {
      let name = mcpToolName(runtime.config.id, spec.name);
      if (used.has(name)) {
        let suffix = 2;
        const head = name.slice(0, MAX_TOOL_NAME - 3);
        while (used.has(`${head}_${suffix}`) && suffix < 100) suffix += 1;
        name = `${head}_${suffix}`;
      }
      used.add(name);
      out.push({
        name,
        description: spec.description || `MCP 工具 ${spec.name}（来自 ${runtime.config.name}）`,
        parameters: spec.inputSchema ?? DEFAULT_INPUT_SCHEMA,
        risk: 'external' as ToolRisk,
        source: `mcp:${runtime.config.name}`,
        handler: makeHandler(runtime.config.id, spec.name, name),
      });
    }
  }
  return out;
}

/* ────────────────────────────── lifecycle ────────────────────────────────── */

function readServers(): McpServerConfig[] {
  if (!deps) return [];
  try {
    const stored = deps.getRepo().getSettings();
    const list = stored?.mcpServers;
    return Array.isArray(list) ? list.filter((server) => server !== null && typeof server === 'object') : [];
  } catch (error) {
    deps.logger.warn(`[mcp] 读取 mcpServers 失败：${errorMessage(error)}`);
    return [];
  }
}

function defaultTransport(config: McpServerConfig): McpTransport {
  if (config.transport === 'stdio') {
    return createStdioTransport({
      command: config.command,
      args: Array.isArray(config.args) ? [...config.args] : [],
      env: { ...(config.env ?? {}) },
    });
  }
  return createHttpTransport({ url: config.url });
}

function buildTransport(config: McpServerConfig): McpTransport {
  if (deps?.createTransport) return deps.createTransport(config);
  return defaultTransport(config);
}

function newClient(transport: McpTransport): McpClient {
  const timeoutMs = deps?.timeoutMs;
  return new McpClient({
    transport,
    clientName: 'ai-investment-advisor',
    ...(timeoutMs && timeoutMs > 0 ? { timeoutMs } : {}),
  });
}

/** Connects one server; every failure is captured on the runtime. Never throws. */
async function connectRuntime(runtime: ServerRuntime): Promise<void> {
  runtime.tools = [];
  runtime.connected = false;
  runtime.error = null;
  let client: McpClient | null = null;
  try {
    client = newClient(buildTransport(runtime.config));
    runtime.client = client;
    const info = await client.connect();
    const tools = await client.listTools();
    runtime.tools = tools;
    runtime.connected = true;
    deps?.logger.info(
      `[mcp] ${runtime.config.id} 已连接（${info.serverName} ${info.serverVersion}，${tools.length} 个工具）`,
    );
  } catch (error) {
    const message = errorMessage(error);
    runtime.error = message;
    runtime.connected = false;
    runtime.tools = [];
    runtime.client = null;
    try {
      client?.close();
    } catch {
      /* best effort */
    }
    deps?.logger.warn(`[mcp] ${runtime.config.id} 连接失败：${message}`);
  }
}

function disconnectAll(): void {
  for (const [id, runtime] of [...runtimes.entries()]) {
    try {
      runtime.client?.close();
    } catch {
      /* best effort */
    }
    runtime.client = null;
    runtime.connected = false;
    runtime.tools = [];
    runtimes.delete(id);
  }
}

async function doReload(): Promise<{ reloaded: number; failed: number }> {
  disconnectAll();
  let reloaded = 0;
  let failed = 0;
  const configs = readServers().filter((server) => server.enabled === true);
  for (const config of configs) {
    const runtime: ServerRuntime = { config, client: null, tools: [], connected: false, error: null };
    runtimes.set(config.id, runtime);
    try {
      await connectRuntime(runtime);
    } catch (error) {
      // connectRuntime already swallows; this is belt-and-braces isolation.
      runtime.error = errorMessage(error);
      runtime.connected = false;
      runtime.tools = [];
    }
    if (runtime.connected) reloaded += 1;
    else failed += 1;
  }
  return { reloaded, failed };
}

/** Registers the `mcp` tool provider and starts the first connection. */
export function initMcp(nextDeps: McpDeps): void {
  deps = nextDeps;
  registerToolProvider({
    id: MCP_PROVIDER_ID,
    tools: () => {
      try {
        return buildTools();
      } catch (error) {
        deps?.logger.warn(`[mcp] 工具表构建失败：${errorMessage(error)}`);
        return [];
      }
    },
  });
  // Async on purpose: `initMcp` is synchronous by contract and must not block startup.
  void serialize(() => doReload()).catch((error: unknown) => {
    deps?.logger.warn(`[mcp] 首次连接失败：${errorMessage(error)}`);
  });
}

/** Closes every connection and reconnects from the current settings. */
export function reloadMcpServers(): Promise<{ reloaded: number; failed: number }> {
  return serialize(() => doReload()).catch((error: unknown) => {
    deps?.logger.warn(`[mcp] 重载失败：${errorMessage(error)}`);
    return { reloaded: 0, failed: 0 };
  });
}

/** Configured servers (including disabled ones) merged with live connection state. */
export function mcpStatus(): McpStatusEntry[] {
  try {
    const out: McpStatusEntry[] = [];
    const seen = new Set<string>();
    for (const config of readServers()) {
      seen.add(config.id);
      const runtime = runtimes.get(config.id);
      out.push({
        id: config.id,
        name: config.name,
        transport: config.transport,
        enabled: config.enabled === true,
        connected: runtime?.connected === true,
        toolCount: runtime?.connected ? runtime.tools.length : 0,
        tools: runtime?.connected ? runtime.tools.map((tool) => tool.name) : [],
        error: runtime?.error ?? null,
      });
    }
    // A runtime whose config vanished (settings edited without a reload) is still reported.
    for (const [id, runtime] of runtimes) {
      if (seen.has(id)) continue;
      out.push({
        id,
        name: runtime.config.name,
        transport: runtime.config.transport,
        enabled: runtime.config.enabled === true,
        connected: runtime.connected,
        toolCount: runtime.connected ? runtime.tools.length : 0,
        tools: runtime.connected ? runtime.tools.map((tool) => tool.name) : [],
        error: runtime.error,
      });
    }
    return out;
  } catch (error) {
    deps?.logger.warn(`[mcp] 状态读取失败：${errorMessage(error)}`);
    return [];
  }
}

/** The stored config for `id`, or `undefined` (routes map that to 404). */
export function findMcpServerConfig(id: string): McpServerConfig | undefined {
  return readServers().find((server) => server.id === id);
}

/**
 * One-off probe used by `POST /api/mcp/servers/:id/test`: connects a **throwaway**
 * client (never registered in the provider) and lists its tools.
 */
export async function testMcpServer(config: McpServerConfig): Promise<McpServerTestResult> {
  let client: McpClient | null = null;
  try {
    client = newClient(buildTransport(config));
    await client.connect();
    const tools = await client.listTools();
    return { ok: true, toolCount: tools.length, tools: tools.map((tool) => tool.name), error: null };
  } catch (error) {
    return { ok: false, toolCount: 0, tools: [], error: errorMessage(error) };
  } finally {
    try {
      client?.close();
    } catch {
      /* best effort */
    }
  }
}

/** Closes every connection and removes the provider (called on process exit). */
export function shutdownMcp(): void {
  disconnectAll();
  unregisterToolProvider(MCP_PROVIDER_ID);
  deps = null;
}
