/**
 * `fundInfo()` 确证规则单测（task-10）。
 *
 * 背景：`fundsuggest` 是「基金 + 证券」混合搜索，会把股票按原样回显——
 * 实测 `key=600519` 返回 `{ CODE: "600519", CATEGORY: 100, CATEGORYDESC: "沪市",
 * STOCKMARKET: "1", FundBaseInfo: null }`（贵州茅台）。所以「CODE 完全相等」
 * 本身不是基金确证，否则纯股票代码会返回伪造的基金详情（违反「不得编造」）。
 *
 * Owner: agent-engine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findConfirmedFundRow,
  fundInfo,
  hasFundData,
  isFundRow,
  parsePingzhongVars,
} from '../src/datasources/fund.js';

test('hasFundData：只有 pingzhongdata 的关键变量才算确证', () => {
  assert.equal(hasFundData({}), false);
  assert.equal(hasFundData({ fS_name: '' }), false);
  assert.equal(hasFundData({ fS_name: '   ' }), false);
  assert.equal(hasFundData({ Data_netWorthTrend: [] }), false);
  assert.equal(hasFundData({ fS_name: '华夏成长混合' }), true);
  assert.equal(hasFundData({ Data_netWorthTrend: [{ x: 1, y: 1.161 }] }), true);
});

test('hasFundData：基金代码的「页面未找到」HTML 不产生任何基金变量', () => {
  // 实测 pingzhongdata/600519.js 返回 HTTP 200 + 404 页面（len≈3814）
  const html = '<!doctype html><html><head><title>页面未找到 - 东方财富网</title></head><body>…</body></html>';
  const vars = parsePingzhongVars(html);
  assert.deepEqual(Object.keys(vars), []);
  assert.equal(hasFundData(vars), false);
});

test('isFundRow / findConfirmedFundRow：股票回显行不算基金，基金行才算', () => {
  // 实测：fundsuggest(600519) 的原样回显（股票）
  const stockEcho = { CODE: '600519', NAME: '贵州茅台', CATEGORY: 100, CATEGORYDESC: '沪市', STOCKMARKET: '1', FundBaseInfo: null };
  // 实测：fundsuggest(000001) 返回同一 CODE 的基金行 + 股票行（平安银行）
  const fundRow = { CODE: '000001', NAME: '华夏成长混合', CATEGORY: 700, CATEGORYDESC: '基金', STOCKMARKET: null, FundBaseInfo: { FCODE: '000001', FTYPE: '混合型-灵活', JJGS: '华夏基金' } };
  const bankRow = { CODE: '000001', NAME: '平安银行', CATEGORY: 150, CATEGORYDESC: '深市', STOCKMARKET: '2', FundBaseInfo: null };

  assert.equal(isFundRow(stockEcho), false);
  assert.equal(isFundRow(bankRow), false);
  assert.equal(isFundRow(fundRow), true);
  assert.equal(isFundRow({ CODE: '015278', CATEGORY: 700 }), true, 'CATEGORY=700 也是基金');
  assert.equal(isFundRow({ CODE: '015278', CATEGORYDESC: '基金' }), true, 'CATEGORYDESC 含「基金」也是基金');

  assert.equal(findConfirmedFundRow([stockEcho], '600519'), null, '纯股票回显不得确证');
  assert.equal(findConfirmedFundRow([bankRow], '000001'), null, '同代码的股票行不得确证');
  assert.equal(findConfirmedFundRow([fundRow, bankRow], '000001'), fundRow, '必须挑出基金那一行');
  assert.equal(findConfirmedFundRow([{ CODE: '010001', FundBaseInfo: {} }], '000001'), null, '代码不同不得命中');
  assert.equal(findConfirmedFundRow([], '000001'), null);
});

test('fundInfo：股票代码 + 基金类型必须返回 null（不得编造基金详情）', async () => {
  // 600519 = 贵州茅台（股票）：pingzhongdata 只有 404 页面，fundsuggest 只有股票回显
  // → 无任何确证，必须为 null（离线时同样为 null，测试不依赖网络结果）
  const info = await fundInfo('600519');
  assert.equal(info, null);
});

test('fundInfo：未知/空代码一律返回 null', async () => {
  assert.equal(await fundInfo('999999'), null);
  assert.equal(await fundInfo(''), null);
});
