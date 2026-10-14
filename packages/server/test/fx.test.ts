/**
 * FX rate tests — eastmoney scaling + offline fallback.
 *
 * Owner: server-core. Network is never required: `AIA_OFFLINE=1` forces the
 * built-in fallback table.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AIA_OFFLINE = '1';

import { FX_FALLBACK_INTO_CNY } from '@aia/shared';

import { getFxRates, getFxRatesResult, invalidateFxCache, parseEastmoneyRate } from '../src/services/fx.js';

test('parseEastmoneyRate：按 f59 小数位缩放', () => {
  // 实测东财返回：USDCNH f43=66915 f59=4 → 6.6915；HKDCNH f43=8526 f59=4 → 0.8526
  assert.equal(parseEastmoneyRate(66915, 4), 6.6915);
  assert.equal(parseEastmoneyRate(8526, 4), 0.8526);
  assert.equal(parseEastmoneyRate('66914', '4'), 6.6914);
  // 缺少 f59 时的兜底：整体除以 100
  assert.equal(parseEastmoneyRate(712), 7.12);
  // 非法输入
  assert.equal(parseEastmoneyRate('-'), undefined);
  assert.equal(parseEastmoneyRate(0), undefined);
  assert.equal(parseEastmoneyRate(null), undefined);
  assert.equal(parseEastmoneyRate(66914, 0), undefined, '66914 不是合理汇率');
});

test('汇率交叉校验：USD/CNH ÷ HKD/CNH 应接近联系汇率 7.8', () => {
  const usd = parseEastmoneyRate(66915, 4)!;
  const hkd = parseEastmoneyRate(8526, 4)!;
  const ratio = usd / hkd;
  assert.ok(ratio > 7.75 && ratio < 7.85, `USD/HKD=${ratio} 应落在联系汇率区间`);
  // 旧实现的错误缩放（除以 100）会被这条检验拦住
  const wrong = parseEastmoneyRate(8526, 2)!;
  assert.equal(wrong, 85.26);
  assert.ok(usd / wrong < 7.5);
});

test('getFxRates：离线时回退内置汇率并带 warning', async () => {
  invalidateFxCache();
  const result = await getFxRatesResult(null);
  assert.equal(result.source, 'fallback');
  assert.ok(result.warning && result.warning.length > 0);
  assert.equal(result.rates.CNY, 1);
  assert.equal(result.rates.USD, FX_FALLBACK_INTO_CNY.USD);
  assert.equal(result.rates.HKD, FX_FALLBACK_INTO_CNY.HKD);

  const rates = await getFxRates(null);
  assert.deepEqual(rates, { CNY: 1, HKD: FX_FALLBACK_INTO_CNY.HKD, USD: FX_FALLBACK_INTO_CNY.USD });
});
