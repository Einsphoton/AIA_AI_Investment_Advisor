/**
 * 宏观 provider 的字段映射单测。
 *
 * 背景（用户反馈）：AI 简报里出现「LPR 与社会融资规模暂不可得」。复核后发现
 * **LPR 其实可以零 Key 拿到**（东财 `RPTA_WEB_RATE`，字段 LPR1Y / LPR5Y，
 * 每月 20 日报价），旧注释里「上游没有 LPR 报表」的结论是错的。社融确实没有。
 *
 * 这里用真实响应形状的 fixture 锁住映射，防止再次漏字段。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { item, periodOf } from '../src/datasources/macro.js';

/** 2026-10-15 实采：LPR / M2 / CPI 的响应形状。 */
const lprRow = { TRADE_DATE: '2026-09-20 00:00:00', LPR1Y: 3, LPR5Y: 3.5, RATE_1: 4.35, RATE_2: 4.9 };
const moneyRow = { REPORT_DATE: '2026-09-30 00:00:00', BASIC_CURRENCY: 3596289.7, BASIC_CURRENCY_SAME: 7.2 };
const cpiRow = { REPORT_DATE: '2026-09-30 00:00:00', NATIONAL_SAME: 0.9, NATIONAL_SEQUENTIAL: 0.2 };

test('periodOf：TIME > REPORT_DATE > TRADE_DATE（LPR 只有报价日）', () => {
  assert.equal(periodOf({ TIME: '2026年09月份', REPORT_DATE: '2026-09-30', TRADE_DATE: '2026-09-20' }), '2026年09月份');
  assert.equal(periodOf({ REPORT_DATE: '2026-09-30 00:00:00' }), '2026-09');
  assert.equal(periodOf(lprRow), '2026-09-20', 'LPR 必须显示到报价日');
  assert.equal(periodOf(undefined), '');
});

test('LPR：读 LPR1Y / LPR5Y，单位 %，期间为报价日', () => {
  const oneYear = item('lpr_1y', 'LPR 1 年期', lprRow, 'LPR1Y', '%');
  assert.deepEqual(oneYear, { key: 'lpr_1y', label: 'LPR 1 年期', value: 3, unit: '%', period: '2026-09-20', yoy: null });
  assert.equal(item('lpr_5y', 'LPR 5 年期以上', lprRow, 'LPR5Y', '%')?.value, 3.5);
});

test('item：字段缺失返回 null（不编造 0），yoy 只在指定时出现', () => {
  assert.equal(item('lpr_1y', 'LPR 1 年期', undefined, 'LPR1Y', '%'), null);
  assert.equal(item('lpr_1y', 'LPR 1 年期', {}, 'LPR1Y', '%'), null);
  assert.equal(item('lpr_1y', 'LPR 1 年期', { LPR1Y: '' }, 'LPR1Y', '%'), null);
  assert.equal(item('m2', 'M2 余额', moneyRow, 'BASIC_CURRENCY', '亿元')?.yoy, null);
  assert.equal(item('m2', 'M2 余额', moneyRow, 'BASIC_CURRENCY', '亿元', 'BASIC_CURRENCY_SAME')?.yoy, 7.2);
  assert.equal(item('cpi_yoy', 'CPI 同比', cpiRow, 'NATIONAL_SAME', '%')?.value, 0.9);
});
