/**
 * AI Investment Advisor — server entrypoint.
 *
 * Boot order: data dirs → repository (SQLite) → Fastify app → agent runtime →
 * scheduler → listen. Wiring lives here; behaviour lives in the modules.
 */
import { config, ensureDataDirs } from './config.js';
import { formatVersionLabel } from '@aia/shared';
import { buildApp } from './app.js';
import { createRepo } from './db/repo.js';
import { createAgent } from './agent/runtime.js';
import { createScheduler } from './services/scheduler.js';
import { setServices, setScheduler } from './registry.js';
import { installToolInterceptor } from './agent/policy.js';
import { initMcp, reloadMcpServers, shutdownMcp } from './services/mcp-manager.js';

/** `run.error` written by the boot-time reconciliation of interrupted runs. */
export const STALE_RUN_MESSAGE = '运行被中断（服务进程在本次分析结束前退出，重启后已标记为失败）。';

async function main(): Promise<void> {
  ensureDataDirs();

  const repo = createRepo(config.dbPath);
  repo.migrate();

  const app = await buildApp();
  const logger = {
    info: (msg: string, ...rest: unknown[]) => app.log.info(rest.length ? { rest } : {}, msg),
    warn: (msg: string, ...rest: unknown[]) => app.log.warn(rest.length ? { rest } : {}, msg),
    error: (msg: string, ...rest: unknown[]) => app.log.error(rest.length ? { rest } : {}, msg),
    debug: (msg: string, ...rest: unknown[]) => app.log.debug(rest.length ? { rest } : {}, msg),
  };

  const agent = createAgent({
    getRepo: () => repo,
    logger,
    dataDir: config.dataDir,
    providerKeys: { ...config.providerKeys },
  });

  // A process that died mid-run leaves `status='running'` rows behind forever:
  // they show up as zombie「运行中 / 报错」entries in the activity list and can
  // never be finished (production had three of them). Nothing can still be
  // running at boot, so reconcile before serving any request.
  const staleRuns = repo.failStaleRuns(STALE_RUN_MESSAGE);
  if (staleRuns > 0) app.log.warn({ staleRuns }, 'marked interrupted runs as error');

  setServices({ repo, agent });

  const scheduler = createScheduler({ getRepo: () => repo, agent, logger });
  scheduler.start();
  // Expose the live scheduler so routes can reload it after settings change and
  // report the *real* next run time (never a re-computed guess).
  setScheduler(scheduler);
  app.log.info(
    { schedule: repo.getSettings().schedule.mode, next: scheduler.nextRunAt() },
    'scheduler initialised',
  );

  // P1-1: the tool interceptor enforces `toolPolicy` (deny list / write approval)
  // and writes the audit trail for every tool call, builtin or external.
  installToolInterceptor({ getRepo: () => repo, logger });

  // P1-2: connect the configured MCP servers and publish their tools. Failures
  // are isolated per server (see mcpStatus()), so boot never blocks on them.
  initMcp({ getRepo: () => repo, logger });
  void reloadMcpServers().then((result) => {
    app.log.info({ ...result }, 'MCP servers initialised');
  });

  // D7: bound the trajectory tables (transcripts/steps/audit) to the newest runs.
  // 200 runs keeps months of history for a single-user instance while preventing
  // unbounded growth; the oldest rows are re-derivable from the run summaries.
  const pruned = repo.pruneRunData(200);
  if (pruned > 0) app.log.info({ pruned }, 'pruned old agent run transcripts');

  try {
    await app.listen({ port: config.port, host: config.host });
    // Log the full build identity: which revision is serving is the first thing
    // anyone needs when a deployment behaves differently than expected.
    const { version, commit, environment } = config.versionInfo;
    const identity = [formatVersionLabel(version, commit), environment].filter(Boolean).join(' · ');
    app.log.info(`AI Investment Advisor ${identity} → http://${config.host}:${config.port}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal}, shutting down`);
    try {
      scheduler.stop();
      shutdownMcp();
      await app.close();
      repo.close();
      process.exit(0);
    } catch (error) {
      app.log.error(error);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
