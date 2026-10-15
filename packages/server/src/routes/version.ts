/**
 * Version + build identity route. Registered by `routes/index.ts`.
 * Contract: docs/API.md §1.
 *
 *   GET /api/version → AppVersionPayload
 *
 * Why a dedicated route instead of only `/api/health`: the left-top badge in the
 * web UI compares the version baked into the *served bundle* with the version of
 * the *running API*, so a browser still holding a cached `app.js` after a
 * deployment becomes visible instead of silently misbehaving. `health` stays
 * lean for the container HEALTHCHECK; this route carries the full identity.
 */
import type { FastifyInstance } from 'fastify';
import type { AppVersionPayload } from '@aia/shared';

import { config } from '../config.js';

export async function registerVersionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/version', async (): Promise<AppVersionPayload> => ({
    ok: true,
    ...config.versionInfo,
    // Derived instead of captured at module load so the value is correct even in
    // tests, where the module graph may be imported long after the process began.
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  }));
}
