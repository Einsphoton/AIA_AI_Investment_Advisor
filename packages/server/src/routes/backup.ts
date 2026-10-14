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
import { badRequest } from '../errors.js';
import { getRepo } from '../registry.js';
import { localDate, parseOrThrow } from '../db/util.js';
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
