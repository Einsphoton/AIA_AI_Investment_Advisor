/**
 * 东财 suggest 的类型判定单测（issue：只推 A 股股票，场外基金不可用）。
 *
 * 背景：\`searchapi.eastmoney.com/api/suggest/get\` 对场外基金返回
 * \`SecurityTypeName='基金'\`，旧代码据此一律判成 \`etf\`；而 A 股同一代码可能
 * 是股票 —— \`getQuote({ code: '000001', type: 'etf' })\` 会静默返回
 * **平安银行**（11.39 元）而不是华夏成长的净值（1.126 元）。模型一旦发现
 * 名称对不上就放弃场外基金，久而久之池子里只剩 A 股股票。
 *
 * 下面的 fixture 全部来自 2026-10-15 的真实响应（见 docs/SOURCES.md）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { suggestMarket, suggestType, type EmSuggestRow } from '../src/datasources/eastmoney.js';

const otcFund: EmSuggestRow = {
  Code: '000001',
  Name: '华夏成长混合',
  MktNum: '150',
  MarketType: '6',
  SecurityType: '17',
  SecurityTypeName: '基金',
  Classify: 'OTCFUND',
  JYS: 'OTCFUND',
  QuoteID: '150.000001',
};

const etf: EmSuggestRow = {
  Code: '510300',
  Name: '沪深300ETF华泰柏瑞',
  MktNum: '1',
  MarketType: '1',
  SecurityType: '8',
  SecurityTypeName: '基金',
  Classify: 'Fund',
  JYS: '9',
  QuoteID: '1.510300',
};

const cnStock: EmSuggestRow = {
  Code: '600519',
  Name: '贵州茅台',
  MktNum: '1',
  MarketType: '1',
  SecurityType: '1',
  SecurityTypeName: '沪A',
  Classify: 'AStock',
  JYS: '1',
  QuoteID: '1.600519',
};

const hkStock: EmSuggestRow = { Code: '00700', Name: '腾讯控股', MktNum: '116', MarketType: '5', SecurityType: '19', SecurityTypeName: '港股', Classify: 'HK', JYS: 'HK' };
const usStock: EmSuggestRow = { Code: 'AAPL', Name: '苹果', MktNum: '105', MarketType: '7', SecurityType: '7', SecurityTypeName: '美股', Classify: 'UsStock', JYS: 'NASDAQ' };
const usEtf: EmSuggestRow = { Code: 'SPY', Name: '标普500指数ETF-SPDR', MktNum: '107', MarketType: '7', SecurityType: '7', SecurityTypeName: '美股', Classify: 'UsStock', JYS: 'AMEX' };

test('suggestType：场外基金判为 fund，场内 ETF 判为 etf，股票判为 stock', () => {
  assert.equal(suggestType(otcFund), 'fund', '场外基金必须是 fund，否则报价会命中同代码股票');
  assert.equal(suggestType(etf), 'etf');
  assert.equal(suggestType(cnStock), 'stock');
  assert.equal(suggestType(hkStock), 'stock');
  assert.equal(suggestType(usStock), 'stock');
  // 美股 ETF 在 suggest 里没有基金标记，按股票处理（行情接口对两者一致）。
  assert.equal(suggestType(usEtf), 'stock');
});

test('suggestType：JYS 也带 OTCFUND 时同样判 fund（两个字段任一命中即可）', () => {
  assert.equal(suggestType({ ...otcFund, Classify: 'Fund' }), 'fund');
  assert.equal(suggestType({ ...otcFund, Classify: '', JYS: 'OTCFUND' }), 'fund');
});

test('suggestMarket：场外基金（MktNum 150 / MarketType 6）归 CN', () => {
  assert.equal(suggestMarket(otcFund), 'CN');
  assert.equal(suggestMarket(etf), 'CN');
  assert.equal(suggestMarket(cnStock), 'CN');
  assert.equal(suggestMarket(hkStock), 'HK');
  assert.equal(suggestMarket(usStock), 'US');
});

test('suggestMarket：无法识别的市场返回 null（不得默认归到 A 股）', () => {
  assert.equal(suggestMarket({ Code: 'X', Name: 'X', MktNum: '999', MarketType: '999', Classify: '' }), null);
});
