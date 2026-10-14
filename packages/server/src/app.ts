/**
 * Fastify application factory.
 *
 * Owned by: Lead. Order matters: API routes are registered before the static
 * web app so `/api/*` is never swallowed by the SPA fallback.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import { config } from './config.js';
import { AppError } from './errors.js';
import { registerRoutes } from './routes/index.js';

export interface BuildAppOptions {
  /** Disable the static web app (used by tests). */
  serveWeb?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    bodyLimit: 32 * 1024 * 1024,
    // Long-running AI pipelines stream for minutes; never time them out.
    requestTimeout: 0,
    connectionTimeout: 0,
    keepAliveTimeout: 72_000,
  });

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }
    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, 'request failed');
    else request.log.warn({ err: error }, 'request rejected');
    reply.code(status).send({
      error: {
        code: status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST',
        message: error.message || 'Unexpected error',
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: `Unknown endpoint ${request.method} ${request.url}` } });
      return;
    }
    // SPA fallback.
    if (serveWebEnabled(options) && fs.existsSync(`${config.webDistDir}/index.html`)) {
      reply.header('Content-Type', 'text/html; charset=utf-8');
      reply.send(fs.createReadStream(`${config.webDistDir}/index.html`));
      return;
    }
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });

  app.get('/api/health', async () => ({
    ok: true,
    version: config.version,
    uptime: process.uptime(),
    dataDir: config.dataDir,
    webBuilt: fs.existsSync(`${config.webDistDir}/index.html`),
  }));

  await registerRoutes(app);

  if (serveWebEnabled(options) && fs.existsSync(config.webDistDir)) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      prefix: '/',
      index: ['index.html'],
      // API responses are handled above; static must not shadow them.
      wildcard: false,
    });
  }

  return app;
}

function serveWebEnabled(options: BuildAppOptions): boolean {
  if (options.serveWeb === false) return false;
  return true;
}
