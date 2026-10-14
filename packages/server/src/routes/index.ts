/**
 * Route registration table.
 *
 * Owned by: Lead. Every module below exports exactly one
 * `registerXxxRoutes(app: FastifyInstance): Promise<void>` function.
 */
import type { FastifyInstance } from 'fastify';

import { registerSettingsRoutes } from './settings.js';
import { registerAssetRoutes } from './assets.js';
import { registerWatchlistRoutes } from './watchlist.js';
import { registerAdviceRoutes } from './advice.js';
import { registerDashboardRoutes } from './dashboard.js';
import { registerBackupRoutes } from './backup.js';
import { registerMarketRoutes } from './market.js';
import { registerAgentRoutes } from './agent.js';
import { registerChatRoutes } from './chat.js';
import { registerApprovalRoutes } from './approval.js';
import { registerMcpRoutes } from './mcp.js';
import { registerRunRoutes } from './runs.js';

export const API_PREFIX = '/api';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await registerSettingsRoutes(app);
  await registerAssetRoutes(app);
  await registerWatchlistRoutes(app);
  await registerAdviceRoutes(app);
  await registerDashboardRoutes(app);
  await registerBackupRoutes(app);
  await registerMarketRoutes(app);
  await registerAgentRoutes(app);
  await registerChatRoutes(app);
  // P1 governance: audit/approval, MCP servers, trajectory + resume.
  await registerApprovalRoutes(app);
  await registerMcpRoutes(app);
  await registerRunRoutes(app);
}
