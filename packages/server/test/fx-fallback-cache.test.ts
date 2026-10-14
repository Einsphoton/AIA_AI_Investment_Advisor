/**
 * FX cache provenance (task-13 / D6).
 *
 * A degraded (bundled) table must never be persisted: before the fix a single
 * failed fetch wrote `{source:'fallback', USD:7.1, HKD:0.92}` to `kv` and kept
 * serving it for a full hour, so a recovered network still produced the bundled
 * constants (`invalidateFxCache()` only cleared memory).
 *
 * Owner: agent-engine.
 */
process.env.AIA_OFFLINE = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FX_FALLBACK_INTO_CNY } from '@aia/shared';

import { createRepo } from '../src/db/repo.js';
import {
  FX_CACHE_TTL_MS,
  FX_FALLBACK_TTL_MS,
  FX_KV_KEY,
  getFxRatesResult,
  invalidateFxCache,
} from '../src/services/fx.js';

test('D6：fallback 汇率只进内存（短 TTL），绝不写入 kv', async () => {
  invalidateFxCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-fx-'));
  const repo = createRepo(path.join(dir, 'advisor.db'));
  repo.migrate();
  try {
    const result = await getFxRatesResult(repo);
    assert.equal(result.source, 'fallback', 'AIA_OFFLINE=1 必须是回退结果');
    assert.equal(result.rates.USD, FX_FALLBACK_INTO_CNY.USD);
    assert.equal(result.rates.HKD, FX_FALLBACK_INTO_CNY.HKD);
    assert.ok(result.warning && result.warning.length > 0);
    assert.equal(repo.getKv(FX_KV_KEY), undefined, 'fallback 不得落 kv（否则网络恢复后仍返回内置常量）');
    assert.ok(FX_FALLBACK_TTL_MS < FX_CACHE_TTL_MS, '回退 TTL 必须远短于实时 TTL');
    assert.equal(FX_FALLBACK_TTL_MS, 60_000);
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
