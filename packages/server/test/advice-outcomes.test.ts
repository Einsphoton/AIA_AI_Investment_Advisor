/**
 * 建议结果追踪的度量口径测试（纯函数，无网络）。
 *
 * Owner: agent-engine. 这些用例把「胜率」的口径钉死：
 *  - 基准价必须取**建议日之后**第一个交易日（无前视偏差）；
 *  - 卖出建议按方向调整（跌 = 对）；
 *  - 样本不足 / 无基准的条目**不得**进入胜率分母。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { AdviceOutcome, SeriesPoint } from '@aia/shared';

import type { AdviceOutcomeRow, AdviceRow } from '../src/types/models.js';
import type { Repo } from '../src/types/repo.js';
import type { LoggerLike } from '../src/types/agent.js';
import {
  OUTCOME_BENCHMARKS,
  MIN_MEASURABLE_SAMPLES,
  computeOutcome,
  rangeForAge,
  readAdviceOutcomes,
  runIdOfBatch,
  summarizeOutcomes,
  trackAdviceOutcomes,
} from '../src/services/advice-outcomes.js';

const silentLogger: LoggerLike = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/** Builds a daily close series from `[date, close]` pairs. */
function series(rows: [string, number][]): SeriesPoint[] {
  return rows.map(([date, close]) => ({ date, close, open: close, high: close, low: close, volume: 0 }));
}

function outcome(patch: Partial<AdviceOutcome> = {}): AdviceOutcome {
  return {
    adviceId: 'a1',
    runId: 'r1',
    code: '601899',
    market: 'CN',
    type: 'stock',
    action: 'buy',
    currency: 'CNY',
    advisedAt: '2026-01-05T02:00:00.000Z',
    adviceStatus: 'pending',
    executed: false,
    baselineDate: '2026-01-06',
    baselinePrice: 100,
    lastDate: '2026-01-16',
    lastPrice: 110,
    priceChangePct: 10,
    adviceReturnPct: 10,
    benchmarkCode: '000300',
    benchmarkName: '沪深300指数',
    benchmarkBase: 200,
    benchmarkChangePct: 5,
    excessPct: 5,
    maxReturnPct: 12,
    minReturnPct: -3,
    samples: 10,
    daysTracked: 10,
    status: 'tracking',
    warnings: [],
    updatedAt: '2026-01-16T02:00:00.000Z',
    ...patch,
  };
}

/* ─────────────────────────────── 口径 ─────────────────────────────────── */

test('基准价取建议日之后第一个交易日（无前视偏差）', () => {
  const points = series([
    ['2026-01-05', 99],
    ['2026-01-06', 100],
    ['2026-01-07', 110],
  ]);
  const computed = computeOutcome({
    points,
    benchmarkPoints: [],
    advisedAt: '2026-01-05T02:00:00.000Z',
    action: 'buy',
  });
  assert.ok(computed);
  assert.equal(computed.baselineDate, '2026-01-06', '建议当日收盘不得作为基准（建议时它还没发生）');
  assert.equal(computed.baselinePrice, 100);
  assert.equal(computed.lastDate, '2026-01-07');
  assert.equal(computed.samples, 2);
});

test('买入：涨幅即收益，超额 = 收益 − 基准涨幅', () => {
  const computed = computeOutcome({
    points: series([['2026-01-06', 100], ['2026-01-16', 110]]),
    benchmarkPoints: series([['2026-01-06', 200], ['2026-01-16', 210]]),
    advisedAt: '2026-01-05T02:00:00.000Z',
    action: 'buy',
  });
  assert.ok(computed);
  assert.equal(computed.priceChangePct, 10);
  assert.equal(computed.adviceReturnPct, 10);
  assert.equal(computed.benchmarkChangePct, 5);
  assert.equal(computed.excessPct, 5);
  assert.equal(computed.benchmarkAvailable, true);
});

test('卖出：下跌才算「建议方向对」', () => {
  const computed = computeOutcome({
    points: series([['2026-01-06', 100], ['2026-01-16', 90]]),
    benchmarkPoints: series([['2026-01-06', 200], ['2026-01-16', 210]]),
    advisedAt: '2026-01-05T02:00:00.000Z',
    action: 'sell',
  });
  assert.ok(computed);
  assert.equal(computed.priceChangePct, -10, '原始价格变动仍为负');
  assert.equal(computed.adviceReturnPct, 10, '卖出方向调整后为正 = 建议方向对');
  assert.equal(computed.excessPct, 5, '躲过 10% 下跌、基准同期涨 5% → 超额 = 10 − 5');
});

test('最大有利/最大不利取自区间内每一个交易日', () => {
  const computed = computeOutcome({
    points: series([
      ['2026-01-06', 100],
      ['2026-01-07', 120],
      ['2026-01-08', 95],
      ['2026-01-09', 105],
    ]),
    benchmarkPoints: [],
    advisedAt: '2026-01-05T02:00:00.000Z',
    action: 'buy',
  });
  assert.ok(computed);
  assert.equal(computed.maxReturnPct, 20);
  assert.equal(computed.minReturnPct, -5);
  assert.equal(computed.adviceReturnPct, 5);
});

test('卖出方向下，最大/最小同样按方向调整', () => {
  const computed = computeOutcome({
    points: series([
      ['2026-01-06', 100],
      ['2026-01-07', 120],
      ['2026-01-08', 80],
    ]),
    benchmarkPoints: [],
    advisedAt: '2026-01-05T02:00:00.000Z',
    action: 'sell',
  });
  assert.ok(computed);
  assert.equal(computed.maxReturnPct, 20, '跌到 80 = 卖出方向 +20');
  assert.equal(computed.minReturnPct, -20, '涨到 120 = 卖出方向 −20');
});

test('窗口满后冻结为 expired，样本与天数如实统计', () => {
  const computed = computeOutcome({
    points: series([['2026-01-06', 100], ['2026-02-06', 120]]),
    benchmarkPoints: [],
    advisedAt: '2026-01-05T02:00:00.000Z',
    action: 'buy',
    windowDays: 10,
  });
  assert.ok(computed);
  assert.equal(computed.status, 'expired');
  assert.equal(computed.daysTracked, 31);
  assert.equal(computed.samples, 2);
});

test('尚不可度量时返回 null，而不是 0（0 会被误当成「不赚不亏」）', () => {
  // 建议当天还没有「之后」的交易日。
  assert.equal(
    computeOutcome({
      points: series([['2026-01-05', 100]]),
      benchmarkPoints: [],
      advisedAt: '2026-01-05T02:00:00.000Z',
      action: 'buy',
    }),
    null,
  );
  assert.equal(
    computeOutcome({ points: [], benchmarkPoints: [], advisedAt: '2026-01-05T02:00:00.000Z', action: 'buy' }),
    null,
  );
});

test('基准不可用时给出告警且不上报超额', () => {
  const computed = computeOutcome({
    points: series([['2026-01-06', 100], ['2026-01-16', 110]]),
    benchmarkPoints: [],
    advisedAt: '2026-01-05T02:00:00.000Z',
    action: 'buy',
  });
  assert.ok(computed);
  assert.equal(computed.benchmarkAvailable, false);
  assert.equal(computed.excessPct, 0);
  assert.match(computed.warnings.join(' '), /基准序列不可用/);
});

test('序列按日期排序，脏数据被忽略', () => {
  const dirty: SeriesPoint[] = [
    { date: '2026-01-16', close: 110, open: 0, high: 0, low: 0, volume: 0 },
    { date: '2026-01-06', close: 100, open: 0, high: 0, low: 0, volume: 0 },
    { date: '2026-01-07', close: 0, open: 0, high: 0, low: 0, volume: 0 },
    { date: '', close: 50, open: 0, high: 0, low: 0, volume: 0 },
  ];
  const computed = computeOutcome({
    points: dirty,
    benchmarkPoints: [],
    advisedAt: '2026-01-05T02:00:00.000Z',
    action: 'buy',
  });
  assert.ok(computed);
  assert.equal(computed.baselineDate, '2026-01-06');
  assert.equal(computed.lastDate, '2026-01-16');
  assert.equal(computed.samples, 2, '零价与空日期必须被丢弃');
});

/* ─────────────────────────────── 统计 ─────────────────────────────────── */

test('样本不足的条目只计入 unmeasured，绝不进胜率分母', () => {
  const stats = summarizeOutcomes([
    outcome({ adviceId: 'a', samples: 1, adviceReturnPct: 0 }),
    outcome({ adviceId: 'b', samples: 0, adviceReturnPct: 0 }),
    outcome({ adviceId: 'c', samples: 5, adviceReturnPct: 8 }),
  ]);
  assert.equal(MIN_MEASURABLE_SAMPLES, 2);
  assert.equal(stats.total, 3);
  assert.equal(stats.measured, 1);
  assert.equal(stats.unmeasured, 2);
  assert.equal(stats.winRate, 100, '只有可度量的 1 条且为正 → 100%');
});

test('胜率 / 跑赢率 / 均值按可度量条目计算，无基准的不进跑赢率分母', () => {
  const stats = summarizeOutcomes([
    outcome({ adviceId: 'a', adviceReturnPct: 10, excessPct: 5 }), // 赢 + 跑赢
    outcome({ adviceId: 'b', adviceReturnPct: -4, excessPct: 2 }), // 输 + 跑赢
    outcome({ adviceId: 'c', adviceReturnPct: 6, excessPct: -3 }), // 赢 + 跑输
    outcome({ adviceId: 'd', adviceReturnPct: 20, excessPct: 0, benchmarkCode: '', benchmarkName: '' }), // 赢，无基准
  ]);
  assert.equal(stats.measured, 4);
  assert.equal(stats.winRate, 75, '4 条里 3 条为正');
  assert.equal(stats.beatRate, 66.6667, '有基准的 3 条里 a、b 跑赢 → 2/3');
  assert.equal(stats.avgReturnPct, 8, '(10 − 4 + 6 + 20) / 4');
  assert.equal(stats.avgExcessPct, 1.3333, '(5 + 2 − 3) / 3，无基准的不参与');
});

test('全不可度量时必须给出告警，样本偏少也要告警', () => {
  const none = summarizeOutcomes([outcome({ samples: 0 })]);
  assert.match(none.warnings.join(' '), /没有任何建议可度量/);

  const few = summarizeOutcomes([outcome({ adviceId: 'a' }), outcome({ adviceId: 'b' })]);
  assert.match(few.warnings.join(' '), /统计意义有限/);
});

test('按市场拆分，只列出出现过的市场', () => {
  const stats = summarizeOutcomes([
    outcome({ adviceId: 'cn1', market: 'CN', adviceReturnPct: 10 }),
    outcome({ adviceId: 'cn2', market: 'CN', adviceReturnPct: -5 }),
    outcome({ adviceId: 'hk1', market: 'HK', adviceReturnPct: 3, excessPct: -1 }),
  ]);
  const cn = stats.byMarket.find((row) => row.market === 'CN');
  const hk = stats.byMarket.find((row) => row.market === 'HK');
  assert.ok(cn && hk);
  assert.equal(cn.measured, 2);
  assert.equal(cn.winRate, 50);
  assert.equal(hk.measured, 1);
  assert.equal(stats.byMarket.some((row) => row.market === 'US'), false);
});

test('updatedAt 取最新一次更新时间', () => {
  const stats = summarizeOutcomes([
    outcome({ adviceId: 'a', updatedAt: '2026-01-10T00:00:00.000Z' }),
    outcome({ adviceId: 'b', updatedAt: '2026-02-01T00:00:00.000Z' }),
  ]);
  assert.equal(stats.updatedAt, '2026-02-01T00:00:00.000Z');
  assert.equal(summarizeOutcomes([]).updatedAt, null);
});

/* ─────────────────────────────── 辅助 ─────────────────────────────────── */

test('runIdOfBatch 只认 batch- 前缀', () => {
  assert.equal(runIdOfBatch('batch-abc-123'), 'abc-123');
  assert.equal(runIdOfBatch('approval'), null);
  assert.equal(runIdOfBatch('batch-'), null);
});

test('观测区间随建议年龄放宽', () => {
  assert.equal(rangeForAge(1), '1m');
  assert.equal(rangeForAge(20), '1m');
  assert.equal(rangeForAge(21), '3m');
  assert.equal(rangeForAge(80), '3m');
  assert.equal(rangeForAge(81), '6m');
});

test('基准映射覆盖三个市场，且都是可实测到序列的代码', () => {
  for (const market of ['CN', 'HK', 'US'] as const) {
    const spec = OUTCOME_BENCHMARKS[market];
    assert.ok(spec.code.length > 0);
    assert.ok(spec.name.length > 0);
  }
  assert.equal(OUTCOME_BENCHMARKS.CN.code, '000300');
});

test('readAdviceOutcomes 在没有数据时给出空列表与全零统计（而不是抛错）', () => {
  const repo = {
    listAdviceOutcomes: () => [],
  } as unknown as Parameters<typeof readAdviceOutcomes>[0];
  const { items, stats } = readAdviceOutcomes(repo);
  assert.deepEqual(items, []);
  assert.equal(stats.total, 0);
  assert.equal(stats.measured, 0);
  assert.equal(stats.winRate, 0);
});

/* ───────────────────────── 追踪器（用桩仓储，不触网） ───────────────────── */

function adviceRow(patch: Partial<AdviceRow> = {}): AdviceRow {
  return {
    id: 'adv-1',
    batchId: 'batch-run-1',
    assetId: null,
    watchItemId: null,
    assetName: '紫金矿业',
    code: '601899',
    market: 'CN',
    type: 'stock',
    action: 'buy',
    targetShares: 50,
    targetPrice: 29.98,
    currency: 'CNY',
    reason: 'r',
    confidence: 0.7,
    status: 'pending',
    executedShares: null,
    executedPrice: null,
    createdAt: new Date().toISOString(),
    decidedAt: null,
    ...patch,
  };
}

function stubRepo(input: { advice?: AdviceRow[]; existing?: AdviceOutcomeRow[] }) {
  const upserts: AdviceOutcomeRow[] = [];
  const repo = {
    listAdvice: (filter?: { limit?: number }) => (input.advice ?? []).slice(0, filter?.limit ?? 100),
    listAdviceOutcomes: () => input.existing ?? [],
    upsertAdviceOutcome: (row: AdviceOutcomeRow) => {
      upserts.push(row);
      return row;
    },
    deleteAdviceOutcomesForMissingAdvice: () => 0,
  } as unknown as Repo;
  return { repo, upserts };
}

test('trackAdviceOutcomes：没有建议时不取数、不抛错，计数全为 0', async () => {
  const { repo, upserts } = stubRepo({});
  const result = await trackAdviceOutcomes({ repo, logger: silentLogger });
  assert.equal(result.tracked, 0);
  assert.equal(result.measured, 0);
  assert.equal(result.unmeasurable, 0);
  assert.equal(result.frozen, 0);
  assert.equal(result.pruned, 0);
  assert.equal(upserts.length, 0);
});

test('trackAdviceOutcomes：窗口外的旧建议直接跳过', async () => {
  const old = adviceRow({ id: 'old-1', createdAt: '2020-01-01T00:00:00.000Z' });
  const { repo, upserts } = stubRepo({ advice: [old] });
  const result = await trackAdviceOutcomes({ repo, logger: silentLogger });
  assert.equal(result.tracked, 0, '超出 90 天观测窗口的建议不再重算');
  assert.equal(upserts.length, 0);
});

test('trackAdviceOutcomes：已冻结（expired）的结果不再重算，避免最终结论漂移', async () => {
  const frozen: AdviceOutcomeRow = {
    adviceId: 'adv-1',
    runId: 'run-1',
    code: '601899',
    market: 'CN',
    type: 'stock',
    action: 'buy',
    currency: 'CNY',
    advisedAt: new Date(Date.now() - 100 * 86_400_000).toISOString(),
    adviceStatus: 'expired',
    executed: false,
    baselineDate: '2026-01-06',
    baselinePrice: 100,
    lastDate: '2026-04-06',
    lastPrice: 120,
    priceChangePct: 20,
    adviceReturnPct: 20,
    benchmarkCode: '000300',
    benchmarkName: '沪深300指数',
    benchmarkBase: 4000,
    benchmarkChangePct: 3,
    excessPct: 17,
    maxReturnPct: 25,
    minReturnPct: -2,
    samples: 60,
    daysTracked: 90,
    status: 'expired',
    warnings: [],
    updatedAt: '2026-04-06T00:00:00.000Z',
  };
  const { repo, upserts } = stubRepo({ advice: [adviceRow()], existing: [frozen] });
  const result = await trackAdviceOutcomes({ repo, logger: silentLogger });
  assert.equal(result.frozen, 1);
  assert.equal(result.tracked, 0, '冻结行不参与重算');
  assert.equal(upserts.length, 0);
});
