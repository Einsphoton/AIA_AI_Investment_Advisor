/**
 * Route registration table.
 *
 * Owned by: Lead. Every module below exports exactly one
 * `registerXxxRoutes(app: FastifyInstance): Promise<void>` function.
 */
import type { FastifyInstance } from 'fastify';

import { registerVersionRoutes } from './version.js';
import { registerSettingsRoutes } from './settings.js';
import { registerAssetRoutes } from './assets.js';
import { registerWatchlistRoutes } from './watchlist.js';
import { registerAdviceRoutes } from './advice.js';
import { registerIpoRoutes } from './ipo.js';
import { registerDashboardRoutes } from './dashboard.js';
import { registerBackupRoutes } from './backup.js';
import { registerMarketRoutes } from './market.js';
import { registerAgentRoutes } from './agent.js';
import { registerChatRoutes } from './chat.js';
import { registerApprovalRoutes } from './approval.js';
import { registerDiagnosticsRoutes } from './diagnostics.js';
import { registerMcpRoutes } from './mcp.js';
import { registerRunRoutes } from './runs.js';

export const API_PREFIX = '/api';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Version/build identity first: the left-top UI badge hits it on every load.
  await registerVersionRoutes(app);
  await registerSettingsRoutes(app);
  await registerAssetRoutes(app);
  await registerWatchlistRoutes(app);
  await registerAdviceRoutes(app);
  // 新股打新：发行期数据（A股/港股/美股）+ 申购登记 + 中签入账。
  await registerIpoRoutes(app);
  await registerDashboardRoutes(app);
  await registerBackupRoutes(app);
  await registerMarketRoutes(app);
  await registerAgentRoutes(app);
  await registerChatRoutes(app);
  // P1 governance: audit/approval, MCP servers, trajectory + resume.
  await registerApprovalRoutes(app);
  await registerMcpRoutes(app);
  await registerRunRoutes(app);
  // 远程部署排障：日志环形缓冲 + 数据源实时探测 + 指数/宏观链路现场。
  await registerDiagnosticsRoutes(app);
}
