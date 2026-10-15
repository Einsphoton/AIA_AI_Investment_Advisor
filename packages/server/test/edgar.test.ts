/**
 * SEC EDGAR XBRL 解析单测（离线）。
 *
 * 全部用「上游响应形状」的固定数据：定期报告过滤、累计口径选取、重述取最新、
 * 时点事实与期间拼接。EDGAR 是美股现金流量的唯一零 Key 官方来源，映射错了会直接
 * 把错数字喂给模型。
 *
 * Owner: agent-engine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCashflowPeriods,
  EDGAR_EXTRA_LINES,
  edgarCikForTicker,
  edgarTickerCandidates,
  edgarUserAgent,
  pickInstantFacts,
  pickPeriodFacts,
} from '../src/datasources/edgar.js';

test('EDGAR_EXTRA_LINES：附加科目标签映射必须指向站内统一指标键（资本开支 → constructLongAsset）', () => {
  const byKey = new Map(EDGAR_EXTRA_LINES.map((line) => [line.tag, line.key]));
  // 资本开支必须映射到 constructLongAsset：否则「自由现金流」在美股永远算不出来。
  assert.equal(byKey.get('capex'), 'constructLongAsset');
  assert.equal(byKey.get('dividends'), 'dividends');
  assert.equal(byKey.get('depreciation'), 'faIrDepr');
  // tag 必须是 TagSet 里真实存在的键名（曾因写成输出键名而静默取不到资本开支）
  for (const line of EDGAR_EXTRA_LINES) assert.ok(['capex', 'dividends', 'depreciation'].includes(line.tag));
});

test('edgarTickerCandidates：点号转横线（EDGAR 用 BRK-B）并归一大小写', () => {
  assert.deepEqual(edgarTickerCandidates('aapl'), ['AAPL']);
  assert.deepEqual(edgarTickerCandidates(' BRK.B '), ['BRK-B', 'BRK.B']);
  assert.deepEqual(edgarTickerCandidates('BABA'), ['BABA']);
});

test('edgarUserAgent：默认带联系邮箱（SEC 会拒绝只有 URL 的 UA）', () => {
  const ua = edgarUserAgent();
  assert.match(ua, /@/, 'UA 必须包含联系邮箱样式，否则 SEC 返回 403');
  assert.match(ua, /AIInvestmentAdvisor/);
});

test('pickPeriodFacts：只取 10-K/10-Q，同期取最长 duration（累计口径）', () => {
  const facts = [
    { start: '2026-03-29', end: '2026-06-27', val: 30, form: '10-Q', fp: 'Q3', filed: '2026-07-31' },
    { start: '2025-09-28', end: '2026-06-27', val: 117, form: '10-Q', fp: 'Q3', filed: '2026-07-31' },
    { start: '2025-09-28', end: '2026-06-27', val: 999, form: '8-K', fp: 'Q3', filed: '2026-08-01' },
    { start: '2025-01-01', end: '2025-03-31', val: 5, form: '10-Q', fp: 'Q1', filed: '2025-05-01' },
  ];
  const picked = pickPeriodFacts(facts);
  assert.equal(picked.size, 2);
  const q3 = picked.get('2026-06-27')!;
  assert.equal(q3.val, 117, '必须取年初至今（272 天）而不是单季（90 天）');
  assert.equal(q3.days, 272);
  assert.equal(q3.form, '10-Q');
  const q1 = picked.get('2025-03-31')!;
  assert.equal(q1.fp, 'Q1');
});

test('pickPeriodFacts：整段 400 天以上或 60 天以下的事实被排除', () => {
  const facts = [
    { start: '2025-01-01', end: '2026-12-31', val: 1, form: '10-K', fp: 'FY', filed: '2027-02-01' },
    { start: '2026-01-01', end: '2026-01-20', val: 2, form: '10-Q', fp: 'Q1', filed: '2026-02-01' },
  ];
  assert.equal(pickPeriodFacts(facts).size, 0);
});

test('pickPeriodFacts：同期限同长度取最近申报（重述以后者为准）', () => {
  const base = { start: '2025-01-01', end: '2025-12-31', form: '10-K', fp: 'FY' };
  const picked = pickPeriodFacts([
    { ...base, val: 1, filed: '2026-02-01' },
    { ...base, val: 2, filed: '2026-03-01' },
  ]);
  assert.equal(picked.get('2025-12-31')!.val, 2);
});

test('pickInstantFacts：只吃时点事实（无 start），取最近申报', () => {
  const values = pickInstantFacts([
    { end: '2026-06-27', val: 39.5, filed: '2026-07-31' },
    { end: '2026-06-27', val: 40.1, filed: '2026-08-15' },
    { start: '2026-03-29', end: '2026-06-27', val: 117, filed: '2026-07-31' },
  ]);
  assert.equal(values.size, 1);
  assert.equal(values.get('2026-06-27'), 40.1);
});

test('buildCashflowPeriods：拼期间 + 判断年报/季报 + 只带同期可得科目', () => {
  const mk = (val: number, days: number, fp = 'Q3') => ({
    start: '2025-09-28',
    end: '2026-06-27',
    val,
    fp,
    form: '10-Q',
    filed: '2026-07-31',
    days,
  });
  const periods = buildCashflowPeriods(
    ['2026-06-27', '2025-09-27'],
    [
      { key: 'netcashOperate', label: '经营活动产生的现金流量净额', facts: new Map([['2026-06-27', mk(117, 272)], ['2025-09-27', mk(111, 365, 'FY')]]) },
      { key: 'netcashInvest', label: '投资活动产生的现金流量净额', facts: new Map([['2026-06-27', mk(-18.8, 272)]]) },
      { key: 'netcashFinance', label: '筹资活动产生的现金流量净额', facts: new Map([['2026-06-27', mk(-94.6, 272)]]) },
    ],
    [{ key: 'constructLongAsset', label: '购建固定资产支付的现金', facts: new Map([['2026-06-27', mk(6.8, 272)]]) }],
    [{ key: 'endCce', label: '期末现金及现金等价物', values: new Map([['2026-06-27', 39.5]]) }],
  );
  assert.equal(periods.length, 2);
  assert.equal(periods[0]!.period, '2026年 三季报');
  assert.equal(periods[0]!.cumulative, true);
  assert.equal(periods[0]!.currency, 'USD');
  assert.deepEqual(
    periods[0]!.lines.map((line) => line.key),
    ['netcashOperate', 'netcashInvest', 'netcashFinance', 'constructLongAsset', 'endCce'],
  );
  // 2025-09-27 只有经营现金流 → 只出这一行，不补 0
  assert.deepEqual(periods[1]!.lines.map((line) => line.key), ['netcashOperate']);
  assert.equal(periods[1]!.reportType, '年报', '365 天必须标成年报');
});

test('edgarCikForTicker：空代码 / 不存在代码返回 null（不发请求也能判定）', async () => {
  assert.equal(await edgarCikForTicker(''), null);
});
