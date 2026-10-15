/**
 * 远程诊断：把「现场」一次请求打包带走 (README「排查」/ docs/API.md §11)。
 *
 *   GET /api/diagnostics/logs?limit=200&level=warn
 *   GET /api/diagnostics/report?logs=100&probe=1
 *
 * 存在的理由：远程 NAS 部署时，出问题只能靠 `docker logs`（json-file 10MB×3，
 * 很快被冲掉），而「全球指数快照不可用」这类 warning 既不写日志、也不落盘 ——
 * 事后无法复现。这个路由把三样东西放到一个 JSON 里：最近日志、数据源实时探测
 * 结果、以及宏观/指数这两条最容易出问题的链路。
 *
 * 安全：**绝不返回 API Key**（LLM 与数据源 Key 都只报「是否已配置」），
 * LLM 的 baseUrl 只报 host，避免网关把 token 放在 query 里被带出去。
 *
 * Owner: server-core.
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';

import { config } from '../config.js';
import { getRepo } from '../registry.js';
import { globalIndices } from '../datasources/indices.js';
import { macroBundle } from '../datasources/macro.js';
import { probeDataSource } from '../datasources/registry.js';
import type { SourceId } from '@aia/shared';
import { recentLogs, logBufferSize } from '../services/log-buffer.js';

/** 默认探测的零 Key 核心链路 —— 远程部署最先怀疑的就是它们。 */
const DEFAULT_PROBE_PROVIDERS: SourceId[] = [
  'eastmoney',
  'tencent',
  'eastmoney-macro',
  'eastmoney-news',
  'eastmoney-fund',
  'bing',
];

/** Hard cap so one diagnostics call cannot run for minutes. */
const MAX_LOGS = 1000;

function parseLimit(raw: unknown, fallback: number): number {
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, MAX_LOGS);
}

function truthy(raw: unknown): boolean {
  return !['0', 'false', 'no', 'off'].includes(String(raw ?? '').toLowerCase());
}

/** `https://gw.example.com/v1?token=…` → `gw.example.com`（不泄漏 query 里的凭据）。 */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl ? '(invalid base URL)' : '';
  }
}

function parseProviders(raw: unknown): SourceId[] {
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_PROBE_PROVIDERS;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item): item is SourceId => item.length > 0);
}

export async function registerDiagnosticsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/diagnostics/logs', async (request) => {
    const query = request.query as Record<string, unknown>;
    return {
      count: logBufferSize(),
      records: recentLogs(parseLimit(query.limit, 200), typeof query.level === 'string' ? query.level : undefined),
    };
  });

  app.get('/api/diagnostics/report', async (request) => {
    const query = request.query as Record<string, unknown>;
    const repo = getRepo();
    const stored = repo.getSettings();
    const withProbe = truthy(query.probe ?? '1');

    // 每条链路都独立降级：探测失败不能把整份报告变成 500。
    const [indices, macro, sources, runs] = await Promise.all([
      globalIndices().catch((error: unknown) => ({
        value: [],
        sources: [] as SourceId[],
        warnings: [`指数链路异常：${error instanceof Error ? error.message : String(error)}`],
      })),
      macroBundle().catch((error: unknown) => ({
        items: [],
        indices: [],
        warnings: [`宏观链路异常：${error instanceof Error ? error.message : String(error)}`],
        notes: [] as string[],
      })),
      withProbe
        ? Promise.all(parseProviders(query.providers).map((provider) => probeDataSource(provider))).catch(
            () => [],
          )
        : Promise.resolve([]),
      Promise.resolve(repo.listRuns({ limit: parseLimit(query.runs, 10) })),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      app: {
        version: config.version,
        uptimeSec: Math.round(process.uptime()),
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        logLevel: config.logLevel,
        dataDir: config.dataDir,
        dbPath: config.dbPath,
        webBuilt: fs.existsSync(`${config.webDistDir}/index.html`),
      },
      llm: {
        baseUrlHost: hostOf(stored.llm.baseUrl || config.envLlm.baseUrl),
        model: stored.llm.model || config.envLlm.model,
        keyConfigured: Boolean(stored.llm.apiKey || config.envLlm.apiKey),
        keySource: stored.llm.apiKey ? 'settings' : config.envLlm.apiKey ? 'env' : 'none',
      },
      // 实时探测：最能回答「为什么这台机器上某个源没数据」。
      sources,
      // 指数：与 `get_macro` 完全同一条代码路径，失败原因在这里可见。
      indices: { count: indices.value.length, sources: indices.sources, warnings: indices.warnings },
      macro: {
        itemCount: macro.items.length,
        indexCount: macro.indices.length,
        warnings: macro.warnings,
        notes: macro.notes,
      },
      runs: runs.map((run) => ({
        id: run.id,
        kind: run.kind,
        status: run.status,
        title: run.title,
        turns: run.turns,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        error: run.error ? run.error.slice(0, 300) : null,
        trace: `/api/agent/runs/${run.id}/trace`,
      })),
      logs: recentLogs(parseLimit(query.logs, 100)),
    };
  });
}
