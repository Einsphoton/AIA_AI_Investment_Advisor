/**
 * 建议来源（origin）与标的预期期限的工具层契约测试。
 *
 * 背景（用户反馈）：AI 投资建议里出现「我的标的」完全没见过的买入标的，
 * 用户无法判断这条建议有没有经过候选池筛选。这里的规则是：
 *   · `create_advice` 必须能按 code 反查回填 assetId / watchItemId，
 *     否则界面只能把它当「池外建议」；
 *   · origin 由链接字段如实推导：持仓 / 我的标的 / 池外；
 *   · `upsert_watch_item` 必须支持 expected_return_horizon（预期多久到目标收益）。
 *
 * 不跑 LLM、不访问网络：只走 executeTool + 临时 SQLite。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TOOLS, executeTool, toolDescriptors, type AllowWrite } from '../src/agent/tools.js';
import { createRepo } from '../src/db/repo.js';
import { toAdviceItem } from '../src/services/portfolio.js';
import type { LoggerLike } from '../src/types/agent.js';
import type { Repo } from '../src/types/repo.js';

const silentLogger: LoggerLike = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function tempRepo(): { repo: Repo; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-origin-'));
  const repo = createRepo(path.join(dir, 'advisor.db'));
  repo.migrate();
  return { repo, dir };
}

function toolCtx(repo: Repo, allow: AllowWrite[] = ['advice', 'watchlist']) {
  return {
    runId: 'run-origin',
    kind: 'advice' as const,
    repo,
    logger: silentLogger,
    sink: () => undefined,
    allowWrites: new Set<AllowWrite>(allow),
    target: null,
    batchId: 'run-origin',
  };
}

function seedWatch(repo: Repo, code: string, market: 'CN' | 'HK' | 'US' = 'CN'): string {
  const now = new Date().toISOString();
  return repo.createWatchItem({
    id: `w-${code}`,
    name: `标的${code}`,
    code,
    market,
    type: 'stock',
    source: 'ai',
    initialPrice: 10,
    initialPriceAt: now,
    price: 10,
    priceAt: now,
    prevClose: 10,
    dayChangePct: 0,
    spark: [],
    note: '',
    createdAt: now,
  }).id;
}

function seedAsset(repo: Repo, code: string, market: 'CN' | 'HK' | 'US' = 'CN'): string {
  const now = new Date().toISOString();
  return repo.createAsset({
    id: `a-${code}`,
    name: `持仓${code}`,
    code,
    market,
    type: 'stock',
    source: 'manual',
    currency: 'CNY',
    note: '',
    price: 10,
    priceAt: now,
    prevClose: 10,
    dayChangePct: 0,
    spark: [],
    createdAt: now,
  }).id;
}

test('工具契约：upsert_watch_item 声明 expected_return_horizon，create_advice 说明来源链接', () => {
  const descriptors = toolDescriptors('watchlist-analysis', ['watchlist']);
  const upsert = descriptors.find((tool) => tool.name === 'upsert_watch_item');
  assert.ok(upsert, '缺少 upsert_watch_item');
  assert.ok(
    Object.keys(upsert!.parameters.properties ?? {}).includes('expectedReturnHorizon'),
    'upsert_watch_item 必须暴露 expectedReturnHorizon（预期多久达到目标收益）',
  );

  const advice = TOOLS.find((tool) => tool.descriptor.name === 'create_advice');
  assert.ok(advice, '缺少 create_advice');
  assert.ok(
    /watchItemId|assetId/.test(advice!.descriptor.description),
    'create_advice 必须提示带上 assetId / watchItemId，否则建议无法追溯来源',
  );
});

test('create_advice：标的在「我的标的」里但模型没带 id → 自动回填 watchItemId，来源=watchlist', async () => {
  const { repo, dir } = tempRepo();
  try {
    const watchId = seedWatch(repo, '600406');
    const outcome = await executeTool(
      'create_advice',
      JSON.stringify({
        code: '600406',
        market: 'CN',
        type: 'stock',
        action: 'buy',
        targetShares: 100,
        targetPrice: 25,
        reason: '电网投资基本盘 + 低相关',
        confidence: 0.7,
      }),
      toolCtx(repo),
    );
    assert.equal(outcome.ok, true, JSON.stringify(outcome).slice(0, 300));
    const rows = repo.listAdvice({ status: 'pending' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.watchItemId, watchId, '必须按 code 回填 watchItemId，否则会被误判为池外');
    assert.equal(rows[0]!.assetId, null);
    assert.equal(toAdviceItem(rows[0]!).origin, 'watchlist');
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('create_advice：标的是持仓 → 回填 assetId，来源=holding（持仓优先）', async () => {
  const { repo, dir } = tempRepo();
  try {
    const assetId = seedAsset(repo, '600406');
    seedWatch(repo, '600406');
    const outcome = await executeTool(
      'create_advice',
      JSON.stringify({
        code: '600406',
        market: 'CN',
        type: 'stock',
        action: 'sell',
        targetShares: 10,
        targetPrice: 25,
        reason: '止盈',
        confidence: 0.6,
      }),
      toolCtx(repo),
    );
    assert.equal(outcome.ok, true);
    const row = repo.listAdvice({ status: 'pending' })[0]!;
    assert.equal(row.assetId, assetId);
    assert.equal(toAdviceItem(row).origin, 'holding');
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('create_advice：池外标的保持 external（跳过了候选池，界面必须标出来）', async () => {
  const { repo, dir } = tempRepo();
  try {
    const outcome = await executeTool(
      'create_advice',
      JSON.stringify({
        code: 'ZZZZ',
        market: 'US',
        type: 'stock',
        assetName: '池外标的',
        action: 'buy',
        targetShares: 1,
        targetPrice: 100,
        reason: '池外标的：不在「我的标的」中，理由……',
        confidence: 0.5,
      }),
      toolCtx(repo),
    );
    assert.equal(outcome.ok, true);
    const row = repo.listAdvice({ status: 'pending' })[0]!;
    assert.equal(row.assetId, null);
    assert.equal(row.watchItemId, null);
    assert.equal(toAdviceItem(row).origin, 'external');
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
