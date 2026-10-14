/**
 * P1-2: MCP server management routes (docs/API.md §9.3).
 *
 *   GET  /api/mcp/servers          → bare array of {@link McpStatusEntry}
 *   POST /api/mcp/servers/:id/test → connect + tools/list with the stored config
 *   POST /api/mcp/reload           → reconnect every enabled server
 *
 * The heavy lifting lives in `services/mcp-manager.ts`; the test endpoint builds
 * a throwaway client that is never registered in the tool provider.
 *
 * Owner: P1-2 workstream. Registered by `routes/index.ts` (Lead).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { notFound } from '../errors.js';
import { findMcpServerConfig, mcpStatus, reloadMcpServers, testMcpServer } from '../services/mcp-manager.js';

const serverParams = z.object({ id: z.string().min(1) });

export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/mcp/servers', async () => mcpStatus());

  app.post('/api/mcp/servers/:id/test', async (request) => {
    const parsed = serverParams.safeParse(request.params);
    if (!parsed.success) throw notFound('缺少 MCP 服务器 id');
    const config = findMcpServerConfig(parsed.data.id);
    if (!config) throw notFound(`MCP 服务器 ${parsed.data.id} 不存在`);
    return testMcpServer(config);
  });

  app.post('/api/mcp/reload', async () => reloadMcpServers());
}
