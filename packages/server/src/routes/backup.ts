/**
 * 备份导出/导入/快照 (docs/API.md §10)
 *
 * Owner: server-core. Export never contains the LLM apiKey (see
 * `services/backup.ts`). Snapshot files live in `config.backupDir`
 * (`data/backups`).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { BackupPayload, ImportMode } from '@aia/shared';

import { config } from '../config.js';
import { badRequest, conflict } from '../errors.js';
import { getRepo, getScheduler } from '../registry.js';
import { localDate, parseOrThrow, resetDatasourceCache } from '../db/util.js';
import { getActiveScheduler } from '../services/scheduler.js';
import { isPipelineRunning } from '../services/pipeline-lock.js';
import {
  buildBackupPayload,
  ensureBackupDir,
  importBackupPayload,
  listBackupSnapshots,
  readBackupSnapshot,
  writeBackupSnapshot,
} from '../services/backup.js';

const importSchema = z.object({
  data: z.unknown(),
  mode: z.enum(['merge', 'replace']).optional(),
});

const clearSchema = z.object({
  /** 默认 `true`：保留 AI 配置与 API Key，只清数据。 */
  keepSettings: z.boolean().optional(),
});

function isPayloadLike(value: unknown): value is BackupPayload {
  return !!value && typeof value === 'object' && 'assets' in (value as Record<string, unknown>);
}

export async function registerBackupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/backup/export', async (_request, reply) => {
    const payload = buildBackupPayload(getRepo(), { appVersion: config.version });
    reply.header('Content-Disposition', `attachment; filename="ai-investment-advisor-${localDate()}.json"`);
    reply.header('Content-Type', 'application/json; charset=utf-8');
    return payload;
  });

  app.post('/api/backup/import', async (request) => {
    const body = parseOrThrow(importSchema, request.body ?? {}, '导入参数');
    const mode: ImportMode = body.mode ?? 'merge';
    // Accept both `{ data, mode }` and a bare BackupPayload body.
    const payload = body.data !== undefined ? body.data : request.body;
    if (payload === undefined || payload === null) throw badRequest('导入参数缺少 data');
    if (!isPayloadLike(payload)) throw badRequest('导入数据无效：缺少 assets/watchlist 等字段');
    return importBackupPayload(getRepo(), payload, mode);
  });

  app.get('/api/backup/files', async () => {
    ensureBackupDir(config.backupDir);
    return listBackupSnapshots(config.backupDir);
  });

  /**
   * 一键清除所有数据（设置页「危险操作」）。
   *
   * 默认只清业务数据 + AI 历史 + 缓存，保留 AI 配置（含 API Key）；
   * `keepSettings: false` 时设置恢复为出厂默认。磁盘上的 `data/backups`
   * 快照文件不删除 —— 它是这条不可撤销操作的恢复后路。
   */
  app.post('/api/backup/clear', async (request) => {
    // 运行中的流水线结束后还会写回资产/建议，此时清库等于「清了又长回来」。
    if (isPipelineRunning()) throw conflict('已有 AI 流水线正在运行，请等它结束后再清除数据');
    const body = parseOrThrow(clearSchema, request.body ?? {}, '清除参数');
    const result = getRepo().clearAllData({ keepSettings: body.keepSettings !== false });
    if (result.settingsReset) {
      // 数据源 pin / Key 已清空、定时任务已回到 off：缓存与调度器必须同步刷新。
      await resetDatasourceCache();
      (getScheduler() ?? getActiveScheduler())?.reload();
    }
    return result;
  });

  app.post('/api/backup/files', async () => {
    const payload = buildBackupPayload(getRepo(), { appVersion: config.version });
    return writeBackupSnapshot(config.backupDir, payload);
  });

  app.get('/api/backup/files/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const text = readBackupSnapshot(config.backupDir, name);
    reply.header('Content-Disposition', `attachment; filename="${name}"`);
    reply.header('Content-Type', 'application/json; charset=utf-8');
    return text;
  });
}
