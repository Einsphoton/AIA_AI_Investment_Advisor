/**
 * 机械落地校验测试 —— 把「提示词写了、代码没管」的三类约束钉死。
 *
 * Owner: agent-engine. 覆盖：
 *  ① 交易单位（A股/场内基金整手、科创板 200 股起、港美股不校验）；
 *  ② 单笔买入金额不得透支当月预算剩余；
 *  ③ 取值范围 + 目标价与预期收益方向一致性；
 *  ④ 数值接地**只告警不拦截**（派生值/截断都不能误杀一条好建议）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRepo } from '../src/db/repo.js';
import { executeTool, setToolInterceptor, type AllowWrite } from '../src/agent/tools.js';
import {
  clearToolEvidence,
  evidenceStats,
  readToolEvidence,
  recordToolEvidence,
} from '../src/agent/evidence.js';
import {
  checkAnalysisRanges,
  checkBuyAmount,
  checkShareLot,
  checkTargetConsistency,
  extractNumbers,
  findUnsupportedPreciseNumbers,
  groundingWarning,
  lotRuleFor,
  significantDigits,
} from '../src/agent/validation.js';
import type { LoggerLike } from '../src/types/agent.js';
import type { Repo } from '../src/types/repo.js';

const silentLogger: LoggerLike = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function tempRepo(): { repo: Repo; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-validation-'));
  const repo = createRepo(path.join(dir, 'advisor.db'));
  repo.migrate();
  return { repo, dir };
}

function closeAndRemove(repo: Repo, dir: string): void {
  try {
    repo.close();
  } catch {
    /* already closed */
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp dir left behind: harmless */
  }
}

function toolCtx(repo: Repo, allow: AllowWrite[] = ['advice', 'watchlist', 'asset'], runId = 'run-validation') {
  return {
    runId,
    kind: 'advice' as const,
    repo,
    logger: silentLogger,
    sink: () => undefined,
    allowWrites: new Set<AllowWrite>(allow),
    target: null,
    batchId: `batch-${runId}`,
  };
}

/** Runs a tool call and parses the JSON payload handed back to the model. */
async function callTool(
  repo: Repo,
  tool: string,
  args: Record<string, unknown>,
  runId = 'run-validation',
): Promise<{ ok: boolean; code: string; message: string; content: string; value: Record<string, any> }> {
  const ctx = toolCtx(repo, ['advice', 'watchlist', 'asset'], runId);
  const result = await executeTool(tool, JSON.stringify(args), ctx);
  let payload: Record<string, any> = {};
  try {
    payload = JSON.parse(result.content.split('\n…')[0]!) as Record<string, any>;
  } catch {
    payload = {};
  }
  return {
    ok: result.ok,
    code: String(payload.error ?? ''),
    message: String(payload.message ?? ''),
    content: result.content,
    value: payload,
  };
}

/* ───────────────────────── ① 交易单位（整手） ───────────────────────────── */

test('lotRuleFor：A股 100 股、科创板 200 股起、场外基金与港美股不校验', () => {
  assert.deepEqual(lotRuleFor('CN', 'stock', '601899'), { size: 100, step: 100, label: 'A 股 / 场内基金最小 100 股（份）' });
  assert.deepEqual(lotRuleFor('CN', 'stock', '300750'), { size: 100, step: 100, label: 'A 股 / 场内基金最小 100 股（份）' });
  assert.deepEqual(lotRuleFor('CN', 'etf', '510300'), { size: 100, step: 100, label: 'A 股 / 场内基金最小 100 股（份）' });
  assert.equal(lotRuleFor('CN', 'stock', '688213')?.size, 200, '科创板最小 200 股');
  assert.equal(lotRuleFor('CN', 'stock', '688213')?.step, 1, '科创板达到 200 后可按 1 股递增');
  assert.equal(lotRuleFor('CN', 'stock', '430047')?.size, 100, '北交所 100 股');
  assert.equal(lotRuleFor('CN', 'stock', '830799')?.size, 100, '北交所 8 开头');
  assert.equal(lotRuleFor('CN', 'fund', '000001'), null, '场外基金按金额申购，不校验份额');
  assert.equal(lotRuleFor('HK', 'stock', '00700'), null, '港股每手因标的而异，无数据源 → 不校验');
  assert.equal(lotRuleFor('US', 'stock', 'AAPL'), null, '美股 1 股起');
});

test('checkShareLot：拦下不可交易的份额并给出可直接使用的修正值', () => {
  const bad = checkShareLot({ market: 'CN', type: 'stock', code: '601899', shares: 37 });
  assert.ok(bad);
  assert.equal(bad.suggested, 100);
  assert.match(bad.message, /100/);
  assert.match(bad.message, /不可交易/);

  assert.equal(checkShareLot({ market: 'CN', type: 'stock', code: '601899', shares: 150 })?.suggested, 100);
  assert.equal(checkShareLot({ market: 'CN', type: 'stock', code: '601899', shares: 100 }), null);
  assert.equal(checkShareLot({ market: 'CN', type: 'stock', code: '601899', shares: 1000 }), null);

  // 科创板：≥200 即可，之后 1 股递增。
  assert.equal(checkShareLot({ market: 'CN', type: 'stock', code: '688213', shares: 150 })?.suggested, 200);
  assert.equal(checkShareLot({ market: 'CN', type: 'stock', code: '688213', shares: 200 }), null);
  assert.equal(checkShareLot({ market: 'CN', type: 'stock', code: '688213', shares: 201 }), null);

  // 不校验的市场/品种一律放行。
  assert.equal(checkShareLot({ market: 'US', type: 'stock', code: 'AAPL', shares: 37 }), null);
  assert.equal(checkShareLot({ market: 'HK', type: 'stock', code: '00700', shares: 37 }), null);
  assert.equal(checkShareLot({ market: 'CN', type: 'fund', code: '000001', shares: 37 }), null);
});

test('checkShareLot：卖出允许清掉零股，但不允许卖半手', () => {
  // 持仓只有 10 股（送股产生）→ 一次性卖出合法，不能按整手拦。
  assert.equal(
    checkShareLot({ market: 'CN', type: 'stock', code: '601899', shares: 10, action: 'sell', positionShares: 10 }),
    null,
  );
  // 持仓 1000 股却要卖 150 股 → 半手，拦。
  const half = checkShareLot({ market: 'CN', type: 'stock', code: '601899', shares: 150, action: 'sell', positionShares: 1000 });
  assert.ok(half);
  assert.equal(half.suggested, 100);
  // 持仓 150 股（零股）→ 全部卖出合法。
  assert.equal(
    checkShareLot({ market: 'CN', type: 'stock', code: '601899', shares: 150, action: 'sell', positionShares: 150 }),
    null,
  );
  // 取不到持仓时保守放行（宁可少拦，不可误杀清仓）。
  assert.equal(checkShareLot({ market: 'CN', type: 'stock', code: '601899', shares: 150, action: 'sell' }), null);
  assert.equal(checkShareLot({ market: 'CN', type: 'stock', code: '601899', shares: 100, action: 'sell' }), null);
  // 买入不受这些例外影响。
  assert.ok(checkShareLot({ market: 'CN', type: 'stock', code: '601899', shares: 10, action: 'buy' }));
});

/* ───────────────────── ② 单笔金额 ≤ 预算剩余 ─────────────────────────────── */

test('checkBuyAmount：透支预算剩余即拒绝，并给出可买的最大数量', () => {
  assert.equal(checkBuyAmount({ amount: 1499, remaining: 5000, currency: 'CNY', price: 29.98 }), null);
  assert.equal(checkBuyAmount({ amount: 5000.005, remaining: 5000, currency: 'CNY', price: 10 }), null, '1 分钱内算通过');

  const over = checkBuyAmount({ amount: 10000, remaining: 5000, currency: 'CNY', price: 100 });
  assert.ok(over);
  assert.equal(over.maxShares, 50);
  assert.match(over.message, /超过当月预算剩余/);
  assert.match(over.message, /50/);

  const noRoom = checkBuyAmount({ amount: 100, remaining: 10, currency: 'CNY', price: 100 });
  assert.ok(noRoom);
  assert.equal(noRoom.maxShares, 0);
  assert.match(noRoom.message, /不足以/);

  assert.equal(checkBuyAmount({ amount: 100, remaining: Number.NaN, currency: 'CNY', price: 10 }), null, '取不到额度时不拦');
});

/* ─────────────────── ③ 取值范围与方向一致性 ─────────────────────────────── */

test('checkAnalysisRanges：质量分 0–100、预期收益区间、目标价非负', () => {
  assert.deepEqual(checkAnalysisRanges({ qualityScore: 82, expectedReturn: 16, targetPrice: 34 }), []);
  assert.equal(checkAnalysisRanges({ qualityScore: 101 }).length, 1);
  assert.equal(checkAnalysisRanges({ qualityScore: -1 }).length, 1);
  assert.equal(checkAnalysisRanges({ expectedReturn: -101 }).length, 1);
  assert.equal(checkAnalysisRanges({ expectedReturn: 1001 }).length, 1);
  assert.equal(checkAnalysisRanges({ targetPrice: -5 }).length, 1);
  assert.deepEqual(checkAnalysisRanges({}), [], '未提供的字段不校验');
});

test('checkTargetConsistency：目标价与预期收益不能自相矛盾', () => {
  assert.equal(checkTargetConsistency({ price: 22.18, targetPrice: 25, expectedReturn: 14 }), null);
  assert.equal(checkTargetConsistency({ price: 22.18, targetPrice: 18, expectedReturn: -12 }), null);

  const bullish = checkTargetConsistency({ price: 22.18, targetPrice: 25, expectedReturn: -10 });
  assert.ok(bullish);
  assert.match(bullish, /矛盾/);

  const bearish = checkTargetConsistency({ price: 22.18, targetPrice: 18, expectedReturn: 10 });
  assert.ok(bearish);
  assert.match(bearish, /矛盾/);

  assert.equal(checkTargetConsistency({ price: 22.18, targetPrice: 22.2, expectedReturn: -10 }), null, '目标价≈现价时不判方向');
  assert.equal(checkTargetConsistency({ price: 0, targetPrice: 25, expectedReturn: -10 }), null, '取不到现价时不拦');
  assert.equal(checkTargetConsistency({ price: 22.18, targetPrice: 25 }), null, '缺预期收益时不拦');
});

/* ───────────────────── ④ 数值接地（软告警） ─────────────────────────────── */

test('significantDigits / extractNumbers：识别千分位与小数', () => {
  assert.equal(significantDigits('1941.78'), 6);
  assert.equal(significantDigits('2.0861'), 5);
  assert.equal(significantDigits('0.3103'), 4, '前导零不计入有效数字');
  assert.equal(significantDigits('1,280'), 4);
  assert.deepEqual(extractNumbers('营收 1,941.78 亿元、+15.78%').map((item) => item.value), [1941.78, 15.78]);
});

test('findUnsupportedPreciseNumbers：精确数字必须能在本次工具返回里找到', () => {
  const evidence = '{"revenue":1941.78,"netProfit":391.7,"roe":19.6,"cashPerShare":2.0861}';
  assert.deepEqual(findUnsupportedPreciseNumbers('营收 1941.78 亿元', evidence), []);
  assert.deepEqual(findUnsupportedPreciseNumbers('每股经营现金流 2.0861 元', evidence), []);

  const flagged = findUnsupportedPreciseNumbers('营收 1941.78 亿元，市占率 9999.99%', evidence);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0]!.raw, '9999.99');

  // 派生值只有 2–4 位有效数字，绝不能被误报。
  assert.deepEqual(findUnsupportedPreciseNumbers('H1 EPS 年化≈2.95 元 × 约 11.5x ≈ +16%', evidence), []);

  // 四舍五入容差：工具返回 1941.7845，正文写 1941.78 应算有据。
  assert.deepEqual(findUnsupportedPreciseNumbers('营收 1941.78 亿', '{"revenue":1941.7845}'), []);

  // 没有证据时不能乱报（例如纯对话轮）。
  assert.deepEqual(findUnsupportedPreciseNumbers('营收 1941.78 亿', ''), []);
});

test('groundingWarning：有疑点才提醒，且明确声明不影响写入', () => {
  assert.equal(groundingWarning('营收 1941.78 亿元', '{"revenue":1941.78}'), null);
  const warning = groundingWarning('毛利率 9999.99%', '{"revenue":1941.78}');
  assert.ok(warning);
  assert.match(warning, /9999.99/);
  assert.match(warning, /不会影响本次写入/);
});

/* ───────────────────────── 证据累积器 ───────────────────────────────────── */

test('evidence：累积、读取、释放，并对 run 数与总长设上限', () => {
  clearToolEvidence('run-ev');
  assert.equal(readToolEvidence('run-ev'), '');
  recordToolEvidence('run-ev', 'get_quote', '{"price":29.98}');
  recordToolEvidence('run-ev', 'get_financials', '{"revenue":1941.78}');
  const text = readToolEvidence('run-ev');
  assert.match(text, /get_quote/);
  assert.match(text, /1941\.78/);
  clearToolEvidence('run-ev');
  assert.equal(readToolEvidence('run-ev'), '');

  // run 数上限：异常中断也不会无限增长。
  for (let i = 0; i < 20; i += 1) recordToolEvidence(`run-${i}`, 'get_quote', '{"price":1}');
  assert.ok(evidenceStats().runs <= 8, `追踪中的 run 数必须有限，实际 ${evidenceStats().runs}`);
  for (let i = 0; i < 20; i += 1) clearToolEvidence(`run-${i}`);
});

/* ───────────────────── 工具层：真的拦住了 ───────────────────────────────── */

test('create_advice：份额不符合交易单位直接拒绝，并提示修正值', async () => {
  const { repo, dir } = tempRepo();
  setToolInterceptor(null);
  try {
    const result = await callTool(repo, 'create_advice', {
      code: '601899',
      market: 'CN',
      type: 'stock',
      action: 'buy',
      targetShares: 37,
      targetPrice: 29.98,
      reason: '测试',
      assetName: '紫金矿业',
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'lot_size');
    assert.match(result.message, /100/);
    assert.equal(repo.listAdvice().length, 0, '被拒绝的建议绝不能落库');
  } finally {
    closeAndRemove(repo, dir);
  }
});

test('create_advice：单笔金额透支预算剩余直接拒绝（原先只判「是否用尽」）', async () => {
  const { repo, dir } = tempRepo();
  setToolInterceptor(null);
  try {
    const settings = repo.getSettings();
    const cn = settings.budget.CN;
    assert.ok(cn > 0, '默认应有 A 股预算');
    const result = await callTool(repo, 'create_advice', {
      code: '601899',
      market: 'CN',
      type: 'stock',
      action: 'buy',
      targetShares: 100,
      targetPrice: cn * 10, // 明显透支
      reason: '测试',
      assetName: '紫金矿业',
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'budget_exceeded');
    assert.equal(result.value.details?.maxShares, Math.floor(cn / (cn * 10)));
    assert.equal(repo.listAdvice().length, 0);

    // 同一笔在额度内即通过（100 股 × 29.98 ≈ 2998 < 5000）。
    const okCall = await callTool(repo, 'create_advice', {
      code: '601899',
      market: 'CN',
      type: 'stock',
      action: 'buy',
      targetShares: 100,
      targetPrice: 29.98,
      reason: '现价 29.98',
      assetName: '紫金矿业',
    });
    assert.equal(okCall.ok, true, okCall.message);
    assert.equal(repo.listAdvice().length, 1);
  } finally {
    closeAndRemove(repo, dir);
  }
});

test('create_advice：关掉预算约束（enforceBudget=false）时两条额度闸门都放行', async () => {
  const { repo, dir } = tempRepo();
  setToolInterceptor(null);
  try {
    repo.saveSettings({ enforceBudget: false });
    const result = await callTool(repo, 'create_advice', {
      code: '601899',
      market: 'CN',
      type: 'stock',
      action: 'buy',
      targetShares: 100,
      targetPrice: 999999,
      reason: '测试',
      assetName: '紫金矿业',
    });
    assert.equal(result.ok, true, '用户显式关闭预算约束时不得再拦额度');
  } finally {
    closeAndRemove(repo, dir);
  }
});

test('create_advice：空 code 拒绝；reason 里的无据精确数字只提醒不拦截', async () => {
  const { repo, dir } = tempRepo();
  setToolInterceptor(null);
  const runId = 'run-grounding';
  try {
    const noCode = await callTool(repo, 'create_advice', {
      code: '',
      market: 'CN',
      type: 'stock',
      action: 'buy',
      targetShares: 100,
      targetPrice: 10,
      reason: '测试',
      assetName: '无代码',
    });
    assert.equal(noCode.ok, false);
    assert.equal(noCode.code, 'bad_request');

    // 本次 run 拿到了含 1941.78 的财报，正文又写了 9999.99（无出处）。
    recordToolEvidence(runId, 'get_financials', '{"revenue":1941.78,"netProfit":391.7}');
    const result = await callTool(
      repo,
      'create_advice',
      {
        code: '601899',
        market: 'CN',
        type: 'stock',
        action: 'buy',
        targetShares: 100,
        targetPrice: 29.98,
        reason: '营收 1941.78 亿元，市占率 9999.99%',
        assetName: '紫金矿业',
      },
      runId,
    );
    assert.equal(result.ok, true, '接地告警绝不能拦下建议');
    assert.equal(repo.listAdvice().length, 1);
    assert.match(result.content, /groundingWarning/);
    assert.match(result.content, /9999\.99/);
    assert.ok(!/groundingWarning[^]*1941\.78/.test(result.content), '有出处的数字不该出现在告警里');
  } finally {
    clearToolEvidence(runId);
    closeAndRemove(repo, dir);
  }
});

test('save_asset_analysis / upsert_watch_item：质量分越界直接拒绝（且取数前就拒）', async () => {
  const { repo, dir } = tempRepo();
  setToolInterceptor(null);
  try {
    const assetId = 'asset-1';
    repo.createAsset({
      id: assetId,
      name: '紫金矿业',
      code: '601899',
      market: 'CN',
      type: 'stock',
      source: 'manual',
      currency: 'CNY',
      note: '',
      price: 29.98,
      priceAt: new Date().toISOString(),
      prevClose: 29.5,
      dayChangePct: 1,
      spark: [],
      createdAt: new Date().toISOString(),
    });
    const asset = await callTool(repo, 'save_asset_analysis', {
      assetId,
      summary: '分析结论',
      qualityScore: 120,
    });
    assert.equal(asset.ok, false);
    assert.equal(asset.code, 'bad_request');
    assert.match(asset.message, /qualityScore/);

    const watch = await callTool(repo, 'upsert_watch_item', {
      code: '601899',
      market: 'CN',
      qualityScore: -5,
      name: '紫金矿业',
    });
    assert.equal(watch.ok, false);
    assert.equal(watch.code, 'bad_request');
    assert.match(watch.message, /qualityScore/);
    assert.equal(repo.listWatchlist().length, 0, '被拒绝的标的不得落库');
  } finally {
    closeAndRemove(repo, dir);
  }
});
