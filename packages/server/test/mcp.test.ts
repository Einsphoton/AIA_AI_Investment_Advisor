/**
 * P1-2 MCP tests — every transport is an in-process fake.
 *
 * The Windows sandbox denies `spawn` with captured stdio, so no test starts a
 * child process; the stdio transport is only exercised through its injectable
 * boundary (the manager's `createTransport` seam).
 *
 * Owner: P1-2 workstream.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import type { McpServerConfig } from '@aia/shared';

import {
  McpClient,
  createHttpTransport,
  type McpToolSpec,
  type McpTransport,
} from '../src/agent/mcp.js';
import { executeTool, toolDescriptors, type ToolContext } from '../src/agent/tools.js';
import {
  findMcpServerConfig,
  initMcp,
  mcpStatus,
  reloadMcpServers,
  shutdownMcp,
  testMcpServer,
  type McpServerTestResult,
  type McpStatusEntry,
} from '../src/services/mcp-manager.js';
import { registerMcpRoutes } from '../src/routes/mcp.js';
import type { AppError } from '../src/errors.js';
import type { LoggerLike } from '../src/types/agent.js';
import type { Repo } from '../src/types/repo.js';

/* ──────────────────────────────── fakes ──────────────────────────────────── */

interface SentFrame {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: Record<string, any>;
}

/** Records every outgoing frame and answers JSON-RPC requests from a script. */
class FakeTransport implements McpTransport {
  readonly sent: SentFrame[] = [];
  readonly tools: McpToolSpec[] = [
    { name: 'echo', description: '回显参数', inputSchema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] } },
    { name: 'fail', description: '总是失败' },
    { name: 'weird.name', description: '非法字符工具名' },
  ];
  serverName = 'fake-server';
  serverVersion = '1.2.3';
  /** When false, requests are swallowed (used by the timeout test). */
  respond = true;
  closed = false;
  private messageHandler: ((message: unknown) => void) | undefined;
  private closeHandler: ((error?: Error) => void) | undefined;

  send(message: unknown): void {
    const frame = message as SentFrame;
    this.sent.push(frame);
    if (!this.respond) return;
    if (typeof frame.id !== 'number') return; // notification: no response
    queueMicrotask(() => this.reply(frame));
  }

  private reply(frame: SentFrame): void {
    const id = frame.id;
    if (frame.method === 'initialize') {
      this.emit({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: this.serverName, version: this.serverVersion },
        },
      });
      return;
    }
    if (frame.method === 'tools/list') {
      this.emit({ jsonrpc: '2.0', id, result: { tools: this.tools } });
      return;
    }
    if (frame.method === 'tools/call') {
      const params = frame.params ?? {};
      if (params.name === 'echo') {
        this.emit({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(params.arguments ?? {}) }] } });
        return;
      }
      if (params.name === 'fail') {
        this.emit({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } });
        return;
      }
      this.emit({ jsonrpc: '2.0', id, error: { code: -32602, message: 'method not found' } });
      return;
    }
    this.emit({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(frame.method)}` } });
  }

  emit(message: unknown): void {
    this.messageHandler?.(message);
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  /** Simulates the child process dying (the stdio transport's failure path). */
  fail(error: Error): void {
    this.closeHandler?.(error);
  }

  close(): void {
    this.closed = true;
  }
}

/** Transport whose process fails to start (EPERM-style spawn failure). */
class FailingTransport implements McpTransport {
  send(message: unknown): void {
    const frame = message as SentFrame;
    if (typeof frame.id !== 'number') return;
    queueMicrotask(() => this.closeHandler?.(new Error('spawn EPERM：沙箱拒绝启动子进程')));
  }

  private closeHandler: ((error?: Error) => void) | undefined;

  onMessage(): void {}

  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  close(): void {}
}

function makeLogger(): { logger: LoggerLike; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      info: () => {},
      warn: (message: string) => {
        warnings.push(message);
      },
      error: () => {},
      debug: () => {},
    },
  };
}

function stubRepo(servers: McpServerConfig[]): Repo {
  return { getSettings: () => ({ mcpServers: servers }) } as unknown as Repo;
}

function serverConfig(id: string, enabled = true): McpServerConfig {
  return { id, name: id === 'broken' ? 'Broken' : 'Fake', transport: 'http', command: '', args: [], env: {}, url: `http://${id}`, enabled };
}

function toolCtx(repo: Repo, logger: LoggerLike): ToolContext {
  return {
    runId: 'run-1',
    kind: 'chat',
    repo,
    logger,
    sink: () => {},
    allowWrites: new Set(),
    target: null,
    batchId: 'batch-1',
  };
}

/* ───────────────────────────── McpClient ─────────────────────────────────── */

test('McpClient：握手顺序 initialize → notifications/initialized → tools/list', async () => {
  const transport = new FakeTransport();
  const client = new McpClient({ transport, clientName: 'test-client', timeoutMs: 500 });
  try {
    const info = await client.connect();
    assert.equal(info.serverName, 'fake-server');
    assert.equal(info.serverVersion, '1.2.3');
    assert.equal(info.protocolVersion, '2024-11-05');

    assert.equal(transport.sent.length, 2);
    const initialize = transport.sent[0]!;
    assert.equal(initialize.jsonrpc, '2.0');
    assert.equal(typeof initialize.id, 'number');
    assert.equal(initialize.method, 'initialize');
    assert.equal(initialize.params?.protocolVersion, '2024-11-05');
    assert.deepEqual(initialize.params?.capabilities, {});
    assert.equal(initialize.params?.clientInfo?.name, 'test-client');
    const initialized = transport.sent[1]!;
    assert.equal(initialized.method, 'notifications/initialized');
    assert.equal(initialized.id, undefined, 'initialized 必须是通知（无 id）');

    const tools = await client.listTools();
    assert.equal(transport.sent[2]!.method, 'tools/list');
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['echo', 'fail', 'weird.name'],
    );
    assert.equal(tools[0]!.description, '回显参数');
    assert.deepEqual(tools[0]!.inputSchema, { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] });
    assert.equal(tools[1]!.inputSchema, undefined, '缺失 inputSchema 不得伪造');
  } finally {
    client.close();
  }
});

test('McpClient.callTool：拼接 text 内容、透传 isError、JSON-RPC error 拒绝', async () => {
  const transport = new FakeTransport();
  const client = new McpClient({ transport, timeoutMs: 500 });
  try {
    await client.connect();
    const echo = await client.callTool('echo', { x: 1 });
    assert.equal(echo.isError, false);
    assert.equal(echo.content, '{"x":1}');
    assert.equal(echo.summary, '工具 echo 返回 7 字符');
    assert.equal(transport.sent[2]!.method, 'tools/call');
    assert.deepEqual(transport.sent[2]!.params, { name: 'echo', arguments: { x: 1 } });

    const failed = await client.callTool('fail', {});
    assert.equal(failed.isError, true);
    assert.equal(failed.content, 'boom');

    await assert.rejects(() => client.callTool('missing', {}), /MCP 错误：method not found/);
  } finally {
    client.close();
  }
});

test('McpClient：请求超时 reject，传输关闭会拒绝在途请求', async () => {
  const silent = new FakeTransport();
  silent.respond = false;
  const timeoutClient = new McpClient({ transport: silent, timeoutMs: 40 });
  await assert.rejects(() => timeoutClient.connect(), /MCP 请求超时（40ms）：initialize/);
  timeoutClient.close();

  const dying = new FakeTransport();
  dying.respond = false;
  const dyingClient = new McpClient({ transport: dying, timeoutMs: 5_000 });
  const inFlight = dyingClient.connect();
  dying.fail(new Error('MCP stdio 进程已退出（code=1）'));
  await assert.rejects(inFlight, /进程已退出/);
  dyingClient.close();
});

test('createHttpTransport：POST JSON-RPC，响应体交给 onMessage', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init: Record<string, any> }[] = [];
  globalThis.fetch = (async (url: unknown, init: Record<string, any>) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  try {
    const transport = createHttpTransport({ url: 'http://example.test/mcp', headers: { authorization: 'Bearer t' } });
    const received: unknown[] = [];
    transport.onMessage((message) => received.push(message));
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'http://example.test/mcp');
    assert.equal(calls[0]!.init.method, 'POST');
    assert.equal(calls[0]!.init.headers.authorization, 'Bearer t');
    assert.equal(calls[0]!.init.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    assert.deepEqual(received, [{ jsonrpc: '2.0', id: 1, result: { ok: true } }]);
    transport.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* ──────────────────────────── mcp-manager ────────────────────────────────── */

test('mcp-manager：MCP 工具注册进工具表，executeTool 可调用', async () => {
  const transport = new FakeTransport();
  const repo = stubRepo([serverConfig('fake')]);
  const { logger } = makeLogger();
  try {
    initMcp({ getRepo: () => repo, logger, createTransport: () => transport });

    const reloaded = await reloadMcpServers();
    assert.deepEqual(reloaded, { reloaded: 1, failed: 0 });

    const descriptor = toolDescriptors().find((item) => item.name === 'mcp__fake__echo');
    assert.ok(descriptor, 'mcp__fake__echo 应出现在工具表里');
    assert.equal(descriptor.risk, 'external');
    assert.equal(descriptor.source, 'mcp:Fake');
    assert.deepEqual(descriptor.parameters, { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] });
    assert.ok(toolDescriptors().some((item) => item.name === 'mcp__fake__weird_name'), '非法字符应替换为 _');

    const echoed = await executeTool('mcp__fake__echo', '{"x":1}', toolCtx(repo, logger));
    assert.equal(echoed.ok, true);
    // P2: MCP tools are `external`, so their payload is fenced as untrusted data.
    assert.ok(echoed.content.includes('{"x":1}'), '原始内容必须仍在返回里');
    assert.ok(echoed.content.includes('<<UNTRUSTED_WEB_CONTENT>>'), '必须有开启围栏');
    assert.ok(echoed.content.includes('<</UNTRUSTED_WEB_CONTENT>>'), '必须有闭合围栏');
    assert.equal(echoed.summary, '工具 echo 返回 7 字符');

    const failed = await executeTool('mcp__fake__fail', '{}', toolCtx(repo, logger));
    assert.equal(failed.ok, false);
    assert.equal(failed.content, 'boom');

    const status = mcpStatus();
    assert.equal(status.length, 1);
    assert.equal(status[0]!.connected, true);
    assert.equal(status[0]!.toolCount, 3);
    assert.deepEqual(status[0]!.tools, ['echo', 'fail', 'weird.name']);
    assert.equal(status[0]!.error, null);
  } finally {
    shutdownMcp();
  }
});

test('mcp-manager：连接失败的 server 与其它 server 隔离，且处处不抛异常', async () => {
  const good = new FakeTransport();
  const bad = new FailingTransport();
  const brokenConfig = serverConfig('broken');
  const repo = stubRepo([serverConfig('fake'), brokenConfig]);
  const { logger, warnings } = makeLogger();
  try {
    initMcp({
      getRepo: () => repo,
      logger,
      createTransport: (config) => (config.id === 'broken' ? bad : good),
    });

    const result = await reloadMcpServers();
    assert.deepEqual(result, { reloaded: 1, failed: 1 });

    const status = mcpStatus();
    const broken = status.find((entry) => entry.id === 'broken')!;
    assert.equal(broken.connected, false);
    assert.equal(broken.toolCount, 0);
    assert.deepEqual(broken.tools, []);
    assert.ok(broken.error && broken.error.length > 0, '失败原因必须记录在 error 上');
    assert.ok(warnings.some((line) => line.includes('broken')), '失败必须告警而不是抛出');

    const healthy = status.find((entry) => entry.id === 'fake')!;
    assert.equal(healthy.connected, true);
    assert.equal(healthy.error, null);

    const mcpTools = toolDescriptors().filter((tool) => tool.name.startsWith('mcp__'));
    assert.ok(mcpTools.some((tool) => tool.name === 'mcp__fake__echo'));
    assert.ok(!mcpTools.some((tool) => tool.name.startsWith('mcp__broken__')), '坏 server 不得贡献工具');

    // POST /api/mcp/servers/:id/test 用的是一次性 client，两种结果都不抛。
    const goodTest = await testMcpServer(serverConfig('fake'));
    assert.equal(goodTest.ok, true);
    assert.equal(goodTest.toolCount, 3);
    const badTest = await testMcpServer(brokenConfig);
    assert.equal(badTest.ok, false);
    assert.ok(badTest.error);
    assert.equal(badTest.toolCount, 0);
  } finally {
    shutdownMcp();
  }
});

/* ───────────────────────────── routes/mcp ────────────────────────────────── */

test('routes/mcp：三段路由注册，禁用 server 不连接，未知 id 抛 404', async () => {
  const repo = stubRepo([serverConfig('off', false)]);
  const { logger } = makeLogger();
  try {
    initMcp({
      getRepo: () => repo,
      logger,
      createTransport: () => {
        throw new Error('禁用的 server 不应建立传输');
      },
    });
    const reloaded = await reloadMcpServers();
    assert.deepEqual(reloaded, { reloaded: 0, failed: 0 });

    const status = mcpStatus();
    assert.equal(status.length, 1);
    assert.equal(status[0]!.id, 'off');
    assert.equal(status[0]!.enabled, false);
    assert.equal(status[0]!.connected, false);
    assert.equal(findMcpServerConfig('off')?.id, 'off');
    assert.equal(findMcpServerConfig('nope'), undefined);

    const routes = new Map<string, (request: any) => Promise<unknown>>();
    const app = {
      get: (path: string, handler: (request: any) => Promise<unknown>) => routes.set(`GET ${path}`, handler),
      post: (path: string, handler: (request: any) => Promise<unknown>) => routes.set(`POST ${path}`, handler),
    };
    await registerMcpRoutes(app as unknown as FastifyInstance);

    const list = routes.get('GET /api/mcp/servers')!;
    const listed = (await list({})) as unknown[];
    assert.equal(listed.length, 1);

    const reload = routes.get('POST /api/mcp/reload')!;
    assert.deepEqual(await reload({}), { reloaded: 0, failed: 0 });

    const probe = routes.get('POST /api/mcp/servers/:id/test')!;
    await assert.rejects(
      () => probe({ params: { id: 'nope' } }),
      (error: unknown) => (error as AppError).statusCode === 404,
    );
    await assert.rejects(
      () => probe({ params: {} }),
      (error: unknown) => (error as AppError).statusCode === 404,
    );
  } finally {
    shutdownMcp();
  }
});

test('routes/mcp：真实 Fastify inject —— GET 裸数组、test 探测、reload、404 错误体', async () => {
  const repo = stubRepo([serverConfig('fake')]);
  const { logger } = makeLogger();
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const failure = error as AppError;
    reply.status(failure.statusCode ?? 500).send({ error: { code: failure.code, message: failure.message } });
  });
  try {
    initMcp({ getRepo: () => repo, logger, createTransport: () => new FakeTransport() });
    await reloadMcpServers();
    await registerMcpRoutes(app);
    await app.ready();

    const list = await app.inject({ method: 'GET', url: '/api/mcp/servers' });
    assert.equal(list.statusCode, 200);
    const body = JSON.parse(list.body) as McpStatusEntry[];
    assert.equal(Array.isArray(body), true);
    assert.equal(body.length, 1);
    assert.equal(body[0]!.connected, true);
    assert.deepEqual(body[0]!.tools, ['echo', 'fail', 'weird.name']);

    const probe = await app.inject({ method: 'POST', url: '/api/mcp/servers/fake/test' });
    assert.equal(probe.statusCode, 200);
    const probeBody = JSON.parse(probe.body) as McpServerTestResult;
    assert.equal(probeBody.ok, true);
    assert.equal(probeBody.toolCount, 3);

    const reload = await app.inject({ method: 'POST', url: '/api/mcp/reload' });
    assert.equal(reload.statusCode, 200);
    assert.deepEqual(JSON.parse(reload.body), { reloaded: 1, failed: 0 });

    const missing = await app.inject({ method: 'POST', url: '/api/mcp/servers/nope/test' });
    assert.equal(missing.statusCode, 404);
    assert.equal((JSON.parse(missing.body) as { error: { code: string } }).error.code, 'NOT_FOUND');
  } finally {
    await app.close();
    shutdownMcp();
  }
});
