/**
 * 财报解析单测（task: 财报纳入 AI 分析流程）。
 *
 * 全部离线：只喂「上游响应形状」的固定数据，验证宽表/长表映射、口径二选一、
 * 窗口截断处理与派生比率。任何一条失败都意味着写进报告的数字会出错。
 *
 * Owner: agent-engine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compactFinancials,
  currencyOf,
  dayOf,
  deriveHighlights,
  financialsCacheKey,
  hkSecucode,
  parseCnStatement,
  parseLongStatement,
  parseWideIndicator,
  usSecucodeCandidates,
} from '../src/datasources/financials.js';
import type { FinancialStatement, Financials } from '@aia/shared';

/* ─────────────────────────────── fixtures ──────────────────────────────── */

const cnRow = (over: Record<string, unknown>): Record<string, unknown> => ({
  REPORT_DATE: '2026-06-30 00:00:00',
  REPORT_DATE_NAME: '2026中报',
  REPORT_TYPE: '中报',
  CURRENCY: 'CNY',
  ...over,
});

const longRow = (over: Record<string, unknown>): Record<string, unknown> => ({
  STD_REPORT_DATE: '2026-06-30 00:00:00',
  REPORT_TYPE: '中报',
  CURRENCY_CODE: 'CNY',
  ...over,
});

/* ─────────────────────────────── helpers ───────────────────────────────── */

test('dayOf：截取日期，非法值返回 null', () => {
  assert.equal(dayOf('2026-06-30 00:00:00'), '2026-06-30');
  assert.equal(dayOf('2026-06-30'), '2026-06-30');
  assert.equal(dayOf(''), null);
  assert.equal(dayOf(null), null);
  assert.equal(dayOf('未知'), null);
});

test('currencyOf：ISO 代码优先，中文名次之，最后按市场兜底', () => {
  assert.equal(currencyOf({ CURRENCY_CODE: 'usd' }, 'US'), 'USD');
  assert.equal(currencyOf({ CURRENCY: '人民币' }, 'HK'), 'CNY');
  assert.equal(currencyOf({ CURRENCY: '港元' }, 'HK'), 'HKD');
  assert.equal(currencyOf({}, 'US'), 'USD');
  assert.equal(currencyOf(undefined, 'CN'), 'CNY');
});

test('美股/港股 SECUCODE：必须带交易所后缀 / 5 位港股代码', () => {
  assert.deepEqual(usSecucodeCandidates('aapl'), ['AAPL.O', 'AAPL.N']);
  assert.deepEqual(usSecucodeCandidates('BABA.N'), ['BABA.O', 'BABA.N']);
  assert.equal(hkSecucode('700'), '00700.HK');
  assert.equal(hkSecucode('00700'), '00700.HK');
});

test('缓存键必须区分期数：否则 8 期请求会命中 4 期的脏缓存', () => {
  const four = financialsCacheKey('G:income', '600519', 4);
  const eight = financialsCacheKey('G:income', '600519', 8);
  assert.notEqual(four, eight, '不同 pageSize 不能共用缓存键');
  assert.equal(financialsCacheKey('G:income', '600519', 4), four, '同一请求必须稳定命中同一键');
  assert.notEqual(financialsCacheKey('G:income', '600519', 4), financialsCacheKey('B:income', '600519', 4), '不同行业模板不能共用');
  assert.notEqual(financialsCacheKey('G:income', '600519', 4), financialsCacheKey('G:income', '000001', 4), '不同标的不能共用');
});

/* ─────────────────────────── A 股宽表解析 ──────────────────────────────── */

test('parseCnStatement：宽表 → 期间列表，命中字段带出同比', () => {
  const rows = [
    cnRow({
      TOTAL_OPERATE_INCOME: 92278072083.21,
      TOTAL_OPERATE_INCOME_YOY: 1.3,
      OPERATE_PROFIT: 60000000000,
      BASIC_EPS: 30.5,
      INCOME_TAX: null,
      NONEXISTENT_FIELD: 1,
    }),
  ];
  const periods = parseCnStatement('income', rows, 4);
  assert.equal(periods.length, 1);
  const period = periods[0]!;
  assert.equal(period.period, '2026中报');
  assert.equal(period.reportDate, '2026-06-30');
  assert.equal(period.reportType, '中报');
  assert.equal(period.cumulative, true);
  assert.equal(period.currency, 'CNY');

  const revenue = period.lines.find((line) => line.key === 'revenue')!;
  assert.equal(revenue.label, '营业总收入');
  assert.equal(revenue.value, 92278072083.21);
  assert.equal(revenue.unit, 'CNY');
  assert.equal(revenue.yoy, 1.3);
  const eps = period.lines.find((line) => line.key === 'basicEps')!;
  assert.equal(eps.unit, 'CNY/股');
  // 上游 null 不得变成 0
  assert.equal(period.lines.some((line) => line.key === 'incomeTax'), false);
});

test('parseCnStatement：金融行业模板缺「营业总收入」时回退「营业收入」并换标签', () => {
  const periods = parseCnStatement(
    'income',
    [cnRow({ OPERATE_INCOME: 465859000000, OPERATE_INCOME_YOY: 9.077, TOTAL_OPERATE_INCOME: null })],
    1,
  );
  const revenue = periods[0]!.lines.find((line) => line.key === 'revenue')!;
  assert.equal(revenue.label, '营业收入');
  assert.equal(revenue.value, 465859000000);
  assert.equal(revenue.yoy, 9.077);
});

test('parseCnStatement：0 占位字段不当作有效值（ASSET_BALANCE=0 的坑）', () => {
  const periods = parseCnStatement(
    'balance',
    [cnRow({ TOTAL_ASSETS: 0, ASSET_BALANCE: 309050784569.31 })],
    1,
  );
  const totalAssets = periods[0]!.lines.find((line) => line.key === 'totalAssets')!;
  assert.equal(totalAssets.value, 309050784569.31);
});

test('parseCnStatement：单季报标记为非累计', () => {
  const periods = parseCnStatement('income', [cnRow({ REPORT_TYPE: '一季报', REPORT_DATE_NAME: '2026一季报', TOTAL_OPERATE_INCOME: 1 })], 1);
  assert.equal(periods[0]!.cumulative, true, '一季报本身是累计口径（=1 个季度）');
  const us = parseCnStatement('income', [cnRow({ REPORT_TYPE: '单季报', TOTAL_OPERATE_INCOME: 1 })], 1);
  assert.equal(us[0]!.cumulative, false, '单季报是单季口径');
});

/* ───────────────────────── 港股/美股长表解析 ───────────────────────────── */

const hkIncomeRows = (): Record<string, unknown>[] => [
  longRow({ STD_ITEM_CODE: '004001001', ITEM_NAME: '营业额', AMOUNT: 396431000000, YOY_RATIO: 9.64 }),
  longRow({ STD_ITEM_CODE: '004007999', ITEM_NAME: '毛利', AMOUNT: 229698000000, YOY_RATIO: 11.77 }),
  longRow({ STD_ITEM_CODE: '004005001', ITEM_NAME: '营运支出', AMOUNT: 171545000000 }),
  longRow({ STD_ITEM_CODE: '004010999', ITEM_NAME: '经营溢利', AMOUNT: 134651000000 }),
  longRow({ STD_ITEM_CODE: '004011999', ITEM_NAME: '除税前溢利', AMOUNT: 143659000000 }),
  longRow({ STD_ITEM_CODE: '004025002', ITEM_NAME: '股东应占溢利', AMOUNT: 114115000000, YOY_RATIO: 10.31 }),
  longRow({ STD_REPORT_DATE: '2025-06-30 00:00:00', STD_ITEM_CODE: '004001001', ITEM_NAME: '营业额', AMOUNT: 1 }),
  longRow({ STD_REPORT_DATE: '2025-06-30 00:00:00', STD_ITEM_CODE: '004007999', ITEM_NAME: '毛利', AMOUNT: 2 }),
];

test('parseLongStatement：按报告期分组、按科目名映射、残缺期间丢弃', () => {
  const periods = parseLongStatement('income', hkIncomeRows(), { periods: 4, market: 'HK' });
  assert.equal(periods.length, 1, '2025-06-30 只有 2 个科目（上游半张表），必须丢弃');
  const period = periods[0]!;
  assert.equal(period.reportDate, '2026-06-30');
  assert.equal(period.lines.find((line) => line.key === 'revenue')!.value, 396431000000);
  assert.equal(period.lines.find((line) => line.key === 'grossProfit')!.value, 229698000000);
  assert.equal(period.lines.find((line) => line.key === 'parentNetProfit')!.value, 114115000000);
  assert.equal(period.lines.find((line) => line.key === 'revenue')!.yoy, 9.64);
});

test('parseLongStatement：windowTruncated 时最旧一组整组丢弃，不做半张表', () => {
  const rows = [
    ...hkIncomeRows().filter((row) => row.STD_REPORT_DATE === '2026-06-30 00:00:00'),
    longRow({ STD_REPORT_DATE: '2025-12-31 00:00:00', STD_ITEM_CODE: '004001001', ITEM_NAME: '营业额', AMOUNT: 743689000000 }),
    longRow({ STD_REPORT_DATE: '2025-12-31 00:00:00', STD_ITEM_CODE: '004007999', ITEM_NAME: '毛利', AMOUNT: 422593000000 }),
    longRow({ STD_REPORT_DATE: '2025-12-31 00:00:00', STD_ITEM_CODE: '004025002', ITEM_NAME: '股东应占溢利', AMOUNT: 224632000000 }),
  ];
  const periods = parseLongStatement('income', rows, { periods: 4, market: 'HK', windowTruncated: true });
  assert.equal(periods.length, 1, '窗口饱和 → 最旧的 2025 年报整组丢弃，只保留 2026 中报');
  assert.equal(periods[0]!.reportDate, '2026-06-30');
});

test('parseLongStatement：美股同期两套口径取「累计季报」，不混用', () => {
  const rows: Record<string, unknown>[] = [
    longRow({ REPORT_TYPE: '单季报', REPORT_TYPE_DETAILS: '2026年 第三季报', STD_ITEM_CODE: '004001999', ITEM_NAME: '营业收入', AMOUNT: 109417000000 }),
    longRow({ REPORT_TYPE: '单季报', REPORT_TYPE_DETAILS: '2026年 第三季报', STD_ITEM_CODE: '004005999', ITEM_NAME: '毛利', AMOUNT: 54770000000 }),
    longRow({ REPORT_TYPE: '累计季报', REPORT_TYPE_DETAILS: '2026年 三季报', STD_ITEM_CODE: '004001999', ITEM_NAME: '营业收入', AMOUNT: 364357000000 }),
    longRow({ REPORT_TYPE: '累计季报', REPORT_TYPE_DETAILS: '2026年 三季报', STD_ITEM_CODE: '004005999', ITEM_NAME: '毛利', AMOUNT: 178782000000 }),
  ];
  const periods = parseLongStatement('income', rows, {
    periods: 4,
    market: 'US',
    preferReportTypes: ['累计季报', '单季报'],
    windowTruncated: true,
  });
  assert.equal(periods.length, 1);
  assert.equal(periods[0]!.reportType, '累计季报');
  assert.equal(periods[0]!.period, '2026年 三季报');
  assert.equal(periods[0]!.lines.find((line) => line.key === 'revenue')!.value, 364357000000);
  assert.equal(periods[0]!.lines.filter((line) => line.key === 'revenue').length, 1, '同一科目不得出现两条');
});

test('parseLongStatement：科目名精确匹配（「股东权益」不得命中「股东权益合计」）', () => {
  const rows = [
    longRow({ STD_ITEM_CODE: '004030999', ITEM_NAME: '股东权益', AMOUNT: 1135853000000 }),
    longRow({ STD_ITEM_CODE: '004036999', ITEM_NAME: '总权益', AMOUNT: 1222513000000 }),
  ];
  const periods = parseLongStatement('balance', rows, { periods: 1, market: 'HK' });
  const lines = periods[0]!.lines;
  assert.equal(lines.find((line) => line.key === 'parentEquity')!.value, 1135853000000);
  assert.equal(lines.find((line) => line.key === 'totalEquity')!.value, 1222513000000);
});

test('parseLongStatement：AMOUNT 为空不生成指标行', () => {
  const rows = [
    longRow({ STD_ITEM_CODE: '004001999', ITEM_NAME: '营业收入', AMOUNT: null }),
    longRow({ STD_ITEM_CODE: '004005999', ITEM_NAME: '毛利', AMOUNT: 5 }),
  ];
  const periods = parseLongStatement('income', rows, { periods: 1, market: 'US' });
  assert.equal(periods[0]!.lines.length, 1);
  assert.equal(periods[0]!.lines[0]!.key, 'grossProfit');
});

test('parseWideIndicator：港股现金流通量口径，报告期标签不重复年份', () => {
  const rows = [
    longRow({
      REPORT_TYPE: '2026年中报',
      NETCASH_OPERATE: 154061000000,
      NETCASH_INVEST: -74724000000,
      NETCASH_FINANCE: -9469000000,
      END_CASH: 206930000000,
    }),
  ];
  const periods = parseWideIndicator(rows, 1, 'HK');
  assert.equal(periods[0]!.period, '2026年中报');
  assert.equal(periods[0]!.lines.length, 4);
  assert.equal(periods[0]!.lines.find((line) => line.key === 'netcashOperate')!.value, 154061000000);
});

/* ─────────────────────────── 派生比率与排雷 ─────────────────────────────── */

function buildStatements(): FinancialStatement[] {
  const income = parseCnStatement(
    'income',
    [cnRow({ TOTAL_OPERATE_INCOME: 1000, TOTAL_OPERATE_INCOME_YOY: 12.5, OPERATE_COST: 400, PARENT_NETPROFIT: 200, PARENT_NETPROFIT_YOY: -5 })],
    1,
  );
  const balance = parseCnStatement(
    'balance',
    [cnRow({ TOTAL_ASSETS: 5000, TOTAL_LIABILITIES: 2000, TOTAL_PARENT_EQUITY: 3000, GOODWILL: 300, ACCOUNTS_RECE: 250, INVENTORY: 500, SHORT_LOAN: 200, LONG_LOAN: 400 })],
    1,
  );
  const cashflow = parseCnStatement('cashflow', [cnRow({ NETCASH_OPERATE: 260 })], 1);
  return (['income', 'balance', 'cashflow'] as const).map((kind, index) => ({
    kind,
    label: kind,
    available: true,
    periods: [income, balance, cashflow][index]!,
  }));
}

test('deriveHighlights：比率由报表数据算出，可直接引用', () => {
  const highlights = deriveHighlights(buildStatements());
  const joined = highlights.join(' | ');
  assert.match(joined, /毛利率=60%/);
  assert.match(joined, /归母净利率=20%/);
  assert.match(joined, /资产负债率=40%/);
  assert.match(joined, /经营现金流\/归母净利润=1\.3倍/);
  assert.match(joined, /有息负债\/股东权益=20%/);
  assert.match(joined, /商誉\/股东权益=10%/);
  assert.match(joined, /应收账款\/营业收入=25%/);
  assert.match(joined, /营业总收入同比=12\.5%/);
  assert.match(joined, /归母净利润同比=-5%/);
});

test('deriveHighlights：分母缺失不出比率（不得用 0 顶替）', () => {
  const statements: FinancialStatement[] = [
    { kind: 'income', label: '利润表', available: true, periods: parseCnStatement('income', [cnRow({ TOTAL_OPERATE_INCOME: 1000 })], 1) },
    { kind: 'balance', label: '资产负债表', available: true, periods: [] },
    { kind: 'cashflow', label: '现金流量表', available: false, reason: '无接口', periods: [] },
  ];
  const highlights = deriveHighlights(statements);
  assert.equal(highlights.some((line) => line.includes('资产负债率')), false);
  assert.equal(highlights.some((line) => line.includes('经营现金流')), false);
});

test('deriveHighlights：跨表期数不一致时不算比率，只给绝对额（美股 EDGAR × 东财错期）', () => {
  const income = parseCnStatement('income', [cnRow({ TOTAL_OPERATE_INCOME: 1000, PARENT_NETPROFIT: 200 })], 1);
  const statements: FinancialStatement[] = [
    { kind: 'income', label: '利润表', available: true, periods: income },
    { kind: 'balance', label: '资产负债表', available: true, periods: [] },
    {
      kind: 'cashflow',
      label: '现金流量表',
      available: true,
      periods: [
        {
          period: '2025年 年报',
          reportDate: '2025-12-31',
          reportType: '年报',
          currency: 'CNY',
          cumulative: true,
          lines: [
            { key: 'netcashOperate', label: '经营活动产生的现金流量净额', value: 50_000_000_000, unit: 'CNY' },
            { key: 'constructLongAsset', label: '购建固定资产支付的现金', value: 10_000_000_000, unit: 'CNY' },
          ],
        },
      ],
    },
  ];
  const highlights = deriveHighlights(statements);
  assert.equal(
    highlights.some((line) => line.includes('经营现金流/归母净利润')),
    false,
    '利润表是 2026中报、现金流是 2025 年报，不能相除',
  );
  assert.ok(highlights.some((line) => line.startsWith('经营活动现金流量净额=')), '不同期时给绝对额');
  assert.ok(highlights.some((line) => line === '自由现金流=400亿CNY（2025年 年报）'), '自由现金流用现金流量表自己的期间');
});

test('deriveHighlights：仅空格不同的标签视为同期，比率照算（港股两源）', () => {
  const statements: FinancialStatement[] = [
    { kind: 'income', label: '利润表', available: true, periods: parseCnStatement('income', [cnRow({ REPORT_DATE_NAME: '2026年 中报', TOTAL_OPERATE_INCOME: 1000, PARENT_NETPROFIT: 200 })], 1) },
    { kind: 'balance', label: '资产负债表', available: true, periods: [] },
    { kind: 'cashflow', label: '现金流量表', available: true, periods: [{ period: '2026年中报', reportDate: '2026-06-30', reportType: '中报', currency: 'CNY', cumulative: true, lines: [{ key: 'netcashOperate', label: '经营活动产生的现金流量净额', value: 260, unit: 'CNY' }] }] },
  ];
  const highlights = deriveHighlights(statements);
  assert.ok(highlights.some((line) => line.includes('经营现金流/归母净利润=1.3倍')), '归一空格后应视为同期');
});

/* ─────────────────────────── 工具与注册表契约 ───────────────────────────── */

test('get_financials 已注册为只读工具，并进入资产分析的工具表', async () => {
  const { toolDescriptors, llmToolSchemas } = await import('../src/agent/tools.js');
  const descriptor = toolDescriptors().find((tool) => tool.name === 'get_financials');
  assert.ok(descriptor, 'get_financials 必须出现在工具目录里');
  assert.equal(descriptor!.risk, 'read');
  assert.ok(
    llmToolSchemas('asset-analysis').some((schema) => schema.function.name === 'get_financials'),
    '资产分析必须把 get_financials 交给模型',
  );
  assert.ok(
    llmToolSchemas('watchlist-analysis').some((schema) => schema.function.name === 'get_financials'),
    '标的分析必须把 get_financials 交给模型',
  );
});

test('getFinancials：ETF/基金没有财报，直接返回 null（不发网络请求）', async () => {
  const { getFinancials } = await import('../src/datasources/registry.js');
  assert.equal(await getFinancials({ code: 'SCHD', market: 'US', type: 'etf' }), null);
  assert.equal(await getFinancials({ code: '000001', market: 'CN', type: 'fund' }), null);
  assert.equal(await getFinancials({ code: '', market: 'CN', type: 'stock' }), null);
});

test('资产分析提示词：要求把财报趋势画成 chart 代码块', async () => {
  const { buildSystemPrompt } = await import('../src/agent/prompts.js');
  for (const kind of ['asset-analysis', 'watchlist-analysis'] as const) {
    const prompt = buildSystemPrompt({ persona: 'balanced', reportStyle: 'professional', kind });
    assert.ok(prompt.includes('get_financials'), `${kind} 提示词必须点名财报工具`);
    assert.ok(/```chart/.test(prompt), `${kind} 提示词必须要求财报趋势用 chart 代码块`);
    assert.ok(/categories/.test(prompt), 'chart 要求必须说明 categories/series 结构');
  }
});


test('compactFinancials：列式输出 + 明确列出不可用报表', () => {
  const financials: Financials = {
    code: 'AAPL',
    market: 'US',
    name: '苹果',
    currency: 'USD',
    standard: '美国会计准则',
    statements: [
      {
        kind: 'income',
        label: '利润表',
        available: true,
        periods: parseLongStatement(
          'income',
          [
            longRow({ REPORT_TYPE: '累计季报', REPORT_TYPE_DETAILS: '2026年 三季报', STD_ITEM_CODE: '1', ITEM_NAME: '营业收入', AMOUNT: 300 }),
            longRow({ REPORT_TYPE: '累计季报', REPORT_TYPE_DETAILS: '2026年 三季报', STD_ITEM_CODE: '2', ITEM_NAME: '毛利', AMOUNT: 120 }),
            longRow({ REPORT_TYPE: '累计季报', REPORT_TYPE_DETAILS: '2026年 三季报', STD_ITEM_CODE: '3', ITEM_NAME: '研发费用', AMOUNT: 30 }),
            longRow({ STD_REPORT_DATE: '2026-03-31 00:00:00', REPORT_TYPE: '累计季报', REPORT_TYPE_DETAILS: '2026年 一季报', STD_ITEM_CODE: '1', ITEM_NAME: '营业收入', AMOUNT: 100 }),
            longRow({ STD_REPORT_DATE: '2026-03-31 00:00:00', REPORT_TYPE: '累计季报', REPORT_TYPE_DETAILS: '2026年 一季报', STD_ITEM_CODE: '2', ITEM_NAME: '毛利', AMOUNT: 40 }),
          ],
          { periods: 2, market: 'US' },
        ),
      },
      { kind: 'cashflow', label: '现金流量表', available: false, reason: '上游无接口', periods: [] },
    ],
    highlights: ['毛利率=40%'],
    sources: ['eastmoney'],
    warnings: [],
  };

  const compact = compactFinancials(financials, 2) as {
    periods: string[];
    statements: Record<string, { lines: Record<string, Array<number | null>> }>;
    unavailable: Array<{ table: string; reason: string }>;
  };
  assert.deepEqual(compact.periods, ['2026年 三季报', '2026年 一季报']);
  assert.deepEqual(compact.statements.income!.lines['营业收入'], [300, 100]);
  assert.deepEqual(compact.statements.income!.lines['毛利'], [120, 40]);
  assert.deepEqual(compact.statements.income!.lines['研发费用'], [30, null], '某期没有该科目时补 null，而不是 0');
  assert.equal(compact.statements.cashflow, undefined);
  assert.deepEqual(compact.unavailable, [{ table: '现金流量表', reason: '上游无接口' }]);
});
