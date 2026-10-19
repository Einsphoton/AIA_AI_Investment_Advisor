/**
 * Option-chain datasource tests — HKEX + CBOE parsers.
 *
 * Owner: options-datasource.
 *
 * 全部 fixture 都是**从真实响应里原样粘出来的**（不是构造的）：
 *  · CBOE：`cdn.cboe.com/api/global/delayed_quotes/options/{AAPL,KO,SPY}.json`
 *    实测于 2026-10-19（数据时点 2026-10-16 收盘）。
 *  · HKEX：`hkex.com.hk/eng/stat/dmstat/dayrpt/dqe251016.htm`（6,669,912 B，4,146 ms）。
 *
 * 网络永远不需要：这里只测纯解析函数（`optionChain()` 需要网络，由集成命令验证）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_EXPIRIES,
  OptionChainUnavailableError,
  clearOptionsCache,
  describeOptionError,
  describeUpstreamFailure,
  hkMultiplierKey,
  normalizeHkStockCode,
  optionMultiplier,
  parseCboeOptionQuote,
  parseHkexClassHeading,
  parseHkexClassSection,
  parseHkexQuoteRow,
  parseHkexSummary,
  parseOccSymbol,
  pickHkatsForStockCode,
  extractHkexSection,
} from '../src/datasources/options.js';
import { AppError } from '../src/errors.js';
import { unverifiedHkMultiplierWarning } from '../src/services/options.js';
import {
  calendarDaysBetween,
  datePart,
  hkExpiryFromContractMonth,
  isWeekendIso,
  isoToYyMmDd,
  occExpiryToIso,
  recentTradingDateCandidates,
} from '../src/datasources/options-calendar.js';
import { HK_OPTION_MULTIPLIERS, HK_OPTION_MULTIPLIER_FALLBACK, US_OPTION_MULTIPLIER } from '@aia/shared';

/* ══════════════════════════ 真实 fixture：CBOE ════════════════════════════ */

/** AAPL options[0] —— 2026-10-19 实测原样（iv=0、含 null 之外的边界值）。 */
const AAPL_FIRST = {
  option: 'AAPL261019C00245000',
  bid: 96.8,
  bid_size: 188,
  ask: 99.25,
  ask_size: 67,
  iv: 0,
  open_interest: 0,
  volume: 4,
  delta: 0.9999,
  gamma: 0,
  vega: 0.0001,
  theta: -0.0005,
  rho: 0.0067,
  theo: 98.4353,
  change: 2.815,
  open: 98.5,
  high: 100.34,
  low: 97.25,
  tick: 'up',
  last_trade_price: 100.34,
  last_trade_time: '2026-10-16T10:56:55',
  percent_change: 2.88644,
  prev_day_close: 98.1499977111816,
};

/** AAPL 一条 iv>0 的真实合约（实测 iv=0.728）。 */
const AAPL_IV_POSITIVE = {
  option: 'AAPL261019C00300000',
  bid: 42.95,
  bid_size: 107,
  ask: 44.25,
  ask_size: 27,
  iv: 0.728,
  open_interest: 7,
  volume: 18,
  delta: 0.998,
  gamma: 0.0004,
  vega: 0.002,
  theta: -0.0079,
  rho: 0.0082,
  theo: 43.4501,
  change: 1.325,
  open: 42.69,
  high: 45.84,
  low: 42.25,
  tick: 'down',
  last_trade_price: 43.95,
  last_trade_time: '2026-10-16T11:03:36',
  percent_change: 3.1085,
  prev_day_close: 43.2249984741211,
};

/** KO options[0] —— OCC 码 17 位（root 2 字符）。 */
const KO_FIRST = {
  option: 'KO261023C00045000',
  bid: 47.5,
  bid_size: 200,
  ask: 49.15,
  ask_size: 11,
  iv: 0,
  open_interest: 14,
  volume: 4,
  delta: 0.9996,
  gamma: 0,
  vega: 0.0001,
  theta: -0.0011,
  rho: 0.0086,
  theo: 48.897,
  change: 0.795,
  open: 48.42,
  high: 48.42,
  low: 48.12,
  tick: 'down',
  last_trade_price: 48.12,
  last_trade_time: '2026-10-16T14:12:46',
  percent_change: 1.67988,
  prev_day_close: 48.2250003814697,
};

/** SPY 单边报价（bid=0）+ iv 真实值 1.0622 的合约。 */
const SPY_ONE_SIDED = {
  option: 'SPY261019P00550000',
  bid: 0,
  bid_size: 0,
  ask: 0.01,
  ask_size: 220,
  iv: 1.0622,
  open_interest: 400,
  volume: 1835,
  delta: -0.0007,
  gamma: 0,
  vega: 0.0017,
  theta: -0.0141,
  rho: 0,
  theo: 0.0148,
  change: 0.005,
  open: 0.01,
  high: 0.02,
  low: 0.01,
  tick: 'no_change',
  last_trade_price: 0.01,
  last_trade_time: '2026-10-16T16:14:08',
  percent_change: 100,
  prev_day_close: 0.00499999988824129,
};

/* ══════════════════════════ 真实 fixture：HKEX ════════════════════════════ */

/**
 * dqe251016.htm 的 HKATS UNDERLYING SUMMARY —— 按真实文件顺序（HKATS 字母序）原样粘贴。
 *
 * 关键回归点：真实表在第 51 行处夹着停牌类别 `EVG … (  NIL)`，**它后面还有 87 行**。
 * 早期实现遇到不匹配行就 `break`，导致只解析出 51/138 行、00700（在第 327 行）被
 * 误判成「没有股票期权」—— 这里把 `(  NIL)` 行和 `TOTAL` 合计行都放进 fixture 守住。
 */
const HKEX_SUMMARY_FIXTURE = [
  'HKATS   UNDERLYING                          SUMMARY TRADING VOLUME             SUMMARY OPEN INTEREST      IV%',
  'CODE    STOCK                            TOTAL      CALLS       PUTS       TOTAL       CALLS        PUTS    *',
  'A50 X ISHARES A50           (02823)        355        257         98      16,220       9,893       6,327   22',
  'ALB BABA                    (09988)     88,232     45,427     42,805   1,984,715     893,722   1,090,993   58',
  'BYA BYD (ADJ-A)             (01211)         16         14          2      31,886      11,476      20,410   38',
  'BYD BYD COMPANY             (01211)     14,339      9,583      4,756     536,479     225,745     310,734   44',
  'EVG EVERGRANDE              (  NIL)          0          0          0           0           0           0  141',
  'GAC GAC GROUP               (02238)         87          2         85       6,434       3,656       2,778   50',
  'HKB HSBC HOLDINGS PLC       (00005)     32,092     22,779      9,313     549,322     238,234     311,088   30',
  'MET MEITUAN DIANPING        (03690)     60,514     26,601     33,913   1,946,238     870,565   1,075,673   44',
  'MIU XIAOMI                  (01810)    166,662     81,800     84,862   1,234,641     649,947     584,694   41',
  'PHA PHT (ADJ-A)             (01833)          0          0          0         131         121          10   41',
  'PHT PA GOODDOCTOR           (01833)        874        467        407      27,581      13,230      14,351   53',
  'TCH TENCENT HOLDINGS LTD    (00700)    156,996     62,429     94,567   1,844,894     868,011     976,883   31',
  'WHD WHG (ADJ-B)             (00288)          6          6          0       1,928         921       1,007   35',
  'WHE WHG (ADJ-C)             (00288)          0          0          0          23           8          15   29',
  'WHG WH GROUP                (00288)         11          7          4         397         128         269   33',
  'XTA CHINA TOWER ($0.001) (AD(00788)          0          0          0       1,114         668         446   31',
  'XTW CHINA TOWER ($0.001)    (00788)      3,136      2,109      1,027      49,602      29,594      20,008   28',
  '',
  '    TOTAL                            1,037,439    530,237    507,202  19,088,913   9,053,587  10,035,326',
  '',
  '<A NAME="A50">',
].join('\n');

/** 00700 (TCH) 段落头 —— 原样。 */
const TCH_CLASS_LINE = 'CLASS TCH - TENCENT HOLDINGS LTD                  CLOSING PRICE HK$  620.00';
/** 09988 (ALB) 段落头 —— 原样。 */
const ALB_CLASS_LINE = 'CLASS ALB - BABA                                  CLOSING PRICE HK$  161.20';

/** 00700 17OCT25 认购 5 行 —— 原样（要求逐字段贴出的那 5 行）。 */
const TCH_ROWS = [
  '17OCT25   610.00 C     18.00     18.00      8.86     12.02      -7.30   43         61          72          +24',
  '17OCT25   620.00 C      8.00     10.75      3.00      4.28      -6.55   32      1,068         486         +381',
  '17OCT25   630.00 C      3.50      4.50      0.80      1.25      -4.00   35      4,367       1,918         +960',
  '17OCT25   640.00 C      1.20      1.25      0.25      0.35      -1.83   39      1,625       2,311          +58',
  '17OCT25   650.00 C      0.37      0.42      0.11      0.11      -0.77   44        754       3,161         -460',
];

/** 09988 17OCT25 认购 5 行 —— 原样。 */
const ALB_CALL_ROWS = [
  '17OCT25   157.50 C      5.13      6.50      2.93      4.36      -0.96   59        342         906          -12',
  '17OCT25   160.00 C      3.04      4.86      1.66      2.58      -1.00   56      1,588       1,477         -547',
  '17OCT25   162.50 C      1.68      3.11      0.78      1.37      -0.92   57      3,373       1,964         -344',
  '17OCT25   165.00 C      0.84      1.80      0.34      0.64      -0.69   58      4,915       1,419       -1,132',
  '17OCT25   167.50 C      0.50      0.95      0.17      0.25      -0.45   58      1,147       1,804         -204',
];

/** 09988 17OCT25 认沽 5 行 —— 原样（含 `+0.31` 正号）。 */
const ALB_PUT_ROWS = [
  '17OCT25   157.50 P      0.97      1.52      0.45      0.65      -0.44   59      3,095       1,809         +385',
  '17OCT25   160.00 P      1.70      2.80      0.85      1.47      -0.43   60      1,375       1,344         +209',
  '17OCT25   162.50 P      3.09      4.53      1.68      2.70      -0.39   58        592       1,179          -26',
  '17OCT25   165.00 P      4.58      5.47      2.80      4.48      -0.10   60         79       1,598          -38',
  '17OCT25   167.50 P      6.40      7.91      5.20      6.71      +0.31   67         21         397          -15',
];

/** `-` 哨兵行 —— 原样（第 7 / 第 11 列是字面量 `-`，全文件 124 行）。 */
const DASH_SENTINEL_ROW =
  '30OCT25    35.00 C      0.00      0.00      0.00      0.01          -   70          0           0            -';

/** 深度实值、零成交行 —— 原样（IV=231）。 */
const DEEP_ITM_ROW = '17OCT25   500.00 C      0.00      0.00      0.00    121.08      -6.02  231          0           0            0';

/** 两个真实段落：`<A NAME="TCH">` … `<A NAME="ALB">`，用原样的表头与 CLASS 行拼装。 */
const HKEX_SECTIONS_FIXTURE = [
  '<A NAME="TCH">',
  '     CONTRACT        OPENING     DAILY     DAILY   SETTLE-  CHANGE IN  IV%     VOLUME        OPEN       CHANGE',
  '                      PRICE#     HIGH#      LOW#      MENT       SETL                    INTEREST        IN OI',
  '                                                     PRICE      PRICE                              ',
  TCH_CLASS_LINE,
  '',
  ...TCH_ROWS,
  '',
  '<A NAME="ALB">',
  '     CONTRACT        OPENING     DAILY     DAILY   SETTLE-  CHANGE IN  IV%     VOLUME        OPEN       CHANGE',
  '                      PRICE#     HIGH#      LOW#      MENT       SETL                    INTEREST        IN OI',
  '                                                     PRICE      PRICE                              ',
  ALB_CLASS_LINE,
  '',
  ...ALB_CALL_ROWS,
  ...ALB_PUT_ROWS,
  '',
  '<A NAME="AAC">',
].join('\n');

/* ═══════════════════════════ CBOE / OCC 解析 ══════════════════════════════ */

test('parseOccSymbol：长度 17/18/19 不定，只能从右往左解析', () => {
  // AAPL 19 位
  assert.deepEqual(parseOccSymbol('AAPL261019C00245000'), {
    root: 'AAPL',
    occExpiry: '261019',
    expiry: '2026-10-19',
    type: 'call',
    strike: 245,
  });
  // KO 17 位
  assert.deepEqual(parseOccSymbol('KO261023C00045000'), {
    root: 'KO',
    occExpiry: '261023',
    expiry: '2026-10-23',
    type: 'call',
    strike: 45,
  });
  // SPY 18 位
  assert.deepEqual(parseOccSymbol('SPY261019P00550000'), {
    root: 'SPY',
    occExpiry: '261019',
    expiry: '2026-10-19',
    type: 'put',
    strike: 550,
  });
  // 8 位行权价是千分之一价：00245000 → 245、00250000 → 250
  assert.equal(parseOccSymbol('AAPL261120C00250000')!.strike, 250);
  // 带点代码的点会被吃掉（BRK.B → BRKB），所以 root 不能用来反推标的
  assert.equal(parseOccSymbol('BRKB261023C00270000')!.root, 'BRKB');

  // 非法输入 → null（不是抛错）
  assert.equal(parseOccSymbol(''), null);
  assert.equal(parseOccSymbol('AAPL261019X00245000'), null, 'C/P 只能是 C 或 P');
  assert.equal(parseOccSymbol('AAPL261019C0024500'), null, '行权价不足 8 位');
  assert.equal(parseOccSymbol('AAPL261319C00245000'), null, '13 月不存在');
  assert.equal(parseOccSymbol('AAPL261032C00245000'), null, '10 月 32 日不存在');
});

test('parseCboeOptionQuote：iv<=0 → 0；mid/spreadPct 只在双边报价时计算', () => {
  const quote = parseCboeOptionQuote(AAPL_FIRST)!;
  assert.equal(quote.code, 'AAPL261019C00245000');
  assert.equal(quote.type, 'call');
  assert.equal(quote.strike, 245);
  assert.equal(quote.expiry, '2026-10-19');
  assert.equal(quote.bid, 96.8);
  assert.equal(quote.ask, 99.25);
  assert.equal(quote.mid, 98.025, '(96.8+99.25)/2');
  assert.equal(quote.spreadPct, 2.4994, '(99.25-96.8)/98.025*100 四舍五入 4 位');
  assert.equal(quote.last, 100.34);
  assert.equal(quote.settlement, 98.4353, '美股 settlement = CBOE theo');
  assert.equal(quote.iv, 0, 'iv=0 表示上游未给出（AAPL 3,358 条里 397 条如此）');
  assert.equal(quote.delta, 0.9999);
  assert.equal(quote.openInterest, 0, 'open_interest=0 是合法值');
  assert.equal(quote.volume, 4);
  assert.equal(quote.multiplier, US_OPTION_MULTIPLIER);
});

test('parseCboeOptionQuote：iv 是小数（0.728 = 72.8%），原样保留不再换算', () => {
  const quote = parseCboeOptionQuote(AAPL_IV_POSITIVE)!;
  assert.equal(quote.iv, 0.728);
  assert.equal(quote.delta, 0.998);
  assert.equal(quote.settlement, 43.4501);
});

test('parseCboeOptionQuote：单边报价（bid=0）→ mid/spreadPct = 0（不是「零价差」）', () => {
  const quote = parseCboeOptionQuote(SPY_ONE_SIDED)!;
  assert.equal(quote.bid, 0);
  assert.equal(quote.ask, 0.01);
  assert.equal(quote.mid, 0);
  assert.equal(quote.spreadPct, 0);
  assert.equal(quote.iv, 1.0622, 'iv 仍原样保留（1.0622 = 106.22%）');
  assert.equal(quote.delta, -0.0007);
  assert.equal(quote.openInterest, 400);
  assert.equal(quote.volume, 1835);
  assert.equal(quote.last, 0.01);
});

test('parseCboeOptionQuote：KO 17 位 OCC 码也能解析', () => {
  const quote = parseCboeOptionQuote(KO_FIRST)!;
  assert.equal(quote.code, 'KO261023C00045000');
  assert.equal(quote.strike, 45);
  assert.equal(quote.expiry, '2026-10-23');
  assert.equal(quote.bid, 47.5);
  assert.equal(quote.ask, 49.15);
  assert.equal(quote.mid, 48.325);
  assert.equal(quote.spreadPct, 3.4144);
});

test('parseCboeOptionQuote：null 字段与字符串数字都要兜底', () => {
  const quote = parseCboeOptionQuote({
    option: 'AAPL261120C00250000',
    bid: null,
    ask: '2.50',
    iv: '0.31',
    open_interest: '1,234',
    volume: '--',
    delta: null,
    theo: 1.25,
  })!;
  assert.equal(quote.bid, 0, 'null → 0');
  assert.equal(quote.ask, 2.5, '字符串数字可解析');
  assert.equal(quote.iv, 0.31);
  assert.equal(quote.openInterest, 1234, '千分位逗号要能解析');
  assert.equal(quote.volume, 0, '"--" = 无值 → 0');
  assert.equal(quote.delta, 0);
  assert.equal(quote.mid, 0, 'bid=0 → 无中间价');
});

/* ═══════════════════════════ HKEX 解析 ════════════════════════════════════ */

test('parseHkexSummary：实测 138 行全部可解析，`(  NIL)` 与 TOTAL 行不能截断表格', () => {
  const rows = parseHkexSummary(HKEX_SUMMARY_FIXTURE);
  // fixture 里有 16 条真实数据行 + 1 条停牌 `(  NIL)` 行 + 1 条 TOTAL 合计行
  assert.equal(rows.length, 16);
  assert.equal(rows.some((row) => row.stockCode === 'NIL'), false, '`(  NIL)` 行必须被跳过');

  // 回归：00700 排在 HKB…XTA 之后（真实文件第 327 行），在 `(  NIL)` 行后面，
  // 早期「遇到不匹配行就 break」的实现会把它整段丢掉
  const tch = rows.find((row) => row.hkats === 'TCH')!;
  assert.deepEqual(tch, {
    hkats: 'TCH',
    name: 'TENCENT HOLDINGS LTD',
    stockCode: '00700',
    volumeTotal: 156996,
    volumeCalls: 62429,
    volumePuts: 94567,
    openInterestTotal: 1844894,
    openInterestCalls: 868011,
    openInterestPuts: 976883,
    ivPct: 31,
  });

  const alb = rows.find((row) => row.hkats === 'ALB')!;
  assert.equal(alb.stockCode, '09988');
  assert.equal(alb.name, 'BABA');
  assert.equal(alb.ivPct, 58);
  assert.equal(alb.volumeTotal, 88232);
  assert.equal(alb.openInterestTotal, 1984715);

  // `(  NIL)` 行后面那一行仍然要能解析
  assert.equal(rows.find((row) => row.hkats === 'GAC')!.stockCode, '02238');

  // 名称里带括号/被截断的行也要正确切出 5 位港股代码
  const xta = rows.find((row) => row.hkats === 'XTA')!;
  assert.equal(xta.stockCode, '00788');
  assert.equal(xta.name, 'CHINA TOWER ($0.001) (AD');
});

test('pickHkatsForStockCode：一码多期权时优先非调整系列（实测 4 组全对）', () => {
  const rows = parseHkexSummary(HKEX_SUMMARY_FIXTURE);

  // 01211：BYA 是 BYD (ADJ-A)，BYD 是主系列
  const byd = pickHkatsForStockCode(rows, '01211')!;
  assert.equal(byd.row.hkats, 'BYD');
  assert.deepEqual(byd.ambiguous, ['BYD']);

  // 01833：PHA 是 PHT (ADJ-A)
  const pht = pickHkatsForStockCode(rows, '01833')!;
  assert.equal(pht.row.hkats, 'PHT');

  // 00288：WHG 主系列，WHD/WHE 都是调整系列 —— 只按成交量会错选 WHD(1,934)，
  // 因此必须「先排除 (ADJ) 再排序」
  const whg = pickHkatsForStockCode(rows, '00288')!;
  assert.equal(whg.row.hkats, 'WHG', '不能选中调整系列 WHD');
  assert.deepEqual(whg.ambiguous, ['WHG']);

  // 00788：XTA 名称被截断成 "(AD"，XTW 是主系列
  const xtw = pickHkatsForStockCode(rows, '00788')!;
  assert.equal(xtw.row.hkats, 'XTW');

  // 单一系列没有 ambiguous
  const single = pickHkatsForStockCode(rows, '00700')!;
  assert.equal(single.row.hkats, 'TCH');
  assert.deepEqual(single.ambiguous, []);

  // 不存在的代码 → null
  assert.equal(pickHkatsForStockCode(rows, '09999'), null);
});

test('normalizeHkStockCode：700 / 00700 / HK:700 都归一化成 00700', () => {
  assert.equal(normalizeHkStockCode('700'), '00700');
  assert.equal(normalizeHkStockCode('00700'), '00700');
  assert.equal(normalizeHkStockCode('HK:700'), '00700');
  assert.equal(normalizeHkStockCode(700 as unknown as string), '00700');
  assert.equal(normalizeHkStockCode(''), '');
  assert.equal(normalizeHkStockCode('ABC'), '');
});

test('parseHkexClassHeading：CLOSING PRICE HK$ 要能取到', () => {
  assert.deepEqual(parseHkexClassHeading(TCH_CLASS_LINE), {
    hkats: 'TCH',
    name: 'TENCENT HOLDINGS LTD',
    underlyingClose: 620,
  });
  assert.deepEqual(parseHkexClassHeading(ALB_CLASS_LINE), {
    hkats: 'ALB',
    name: 'BABA',
    underlyingClose: 161.2,
  });
  assert.equal(parseHkexClassHeading('     CONTRACT        OPENING     DAILY'), null);
  assert.equal(parseHkexClassHeading('CLASS TCH - TENCENT HOLDINGS LTD'), null, '没有 CLOSING PRICE 就不算段落头');
});

test('parseHkexQuoteRow：00700 真实 5 行逐字段', () => {
  const expected = [
    { strike: 610, open: 18, high: 18, low: 8.86, settlement: 12.02, settlementChange: -7.3, ivPct: 43, volume: 61, openInterest: 72, openInterestChange: 24 },
    { strike: 620, open: 8, high: 10.75, low: 3, settlement: 4.28, settlementChange: -6.55, ivPct: 32, volume: 1068, openInterest: 486, openInterestChange: 381 },
    { strike: 630, open: 3.5, high: 4.5, low: 0.8, settlement: 1.25, settlementChange: -4, ivPct: 35, volume: 4367, openInterest: 1918, openInterestChange: 960 },
    { strike: 640, open: 1.2, high: 1.25, low: 0.25, settlement: 0.35, settlementChange: -1.83, ivPct: 39, volume: 1625, openInterest: 2311, openInterestChange: 58 },
    { strike: 650, open: 0.37, high: 0.42, low: 0.11, settlement: 0.11, settlementChange: -0.77, ivPct: 44, volume: 754, openInterest: 3161, openInterestChange: -460 },
  ];
  TCH_ROWS.forEach((line, index) => {
    const row = parseHkexQuoteRow(line)!;
    assert.equal(row.contractMonth, '17OCT25');
    assert.equal(row.expiry, '2025-10-17', 'CONTRACT 列就是完整到期日');
    assert.equal(row.type, 'call');
    const want = expected[index]!;
    assert.equal(row.strike, want.strike, `${line} :: strike`);
    assert.equal(row.open, want.open, `${line} :: open`);
    assert.equal(row.high, want.high, `${line} :: high`);
    assert.equal(row.low, want.low, `${line} :: low`);
    assert.equal(row.settlement, want.settlement, `${line} :: settlement`);
    assert.equal(row.settlementChange, want.settlementChange, `${line} :: settlementChange`);
    assert.equal(row.ivPct, want.ivPct, `${line} :: ivPct`);
    assert.equal(row.volume, want.volume, `${line} :: volume（千分位逗号）`);
    assert.equal(row.openInterest, want.openInterest, `${line} :: openInterest`);
    assert.equal(row.openInterestChange, want.openInterestChange, `${line} :: openInterestChange`);
  });
});

test('parseHkexQuoteRow：09988 真实 5 行认购 + 5 行认沽（含 +0.31 正号）', () => {
  const calls = ALB_CALL_ROWS.map((line) => parseHkexQuoteRow(line)!);
  assert.deepEqual(
    calls.map((row) => [row.strike, row.settlement, row.ivPct, row.volume, row.openInterest, row.openInterestChange]),
    [
      [157.5, 4.36, 59, 342, 906, -12],
      [160, 2.58, 56, 1588, 1477, -547],
      [162.5, 1.37, 57, 3373, 1964, -344],
      [165, 0.64, 58, 4915, 1419, -1132],
      [167.5, 0.25, 58, 1147, 1804, -204],
    ],
  );

  const puts = ALB_PUT_ROWS.map((line) => parseHkexQuoteRow(line)!);
  assert.deepEqual(
    puts.map((row) => [row.type, row.strike, row.settlement, row.ivPct, row.volume, row.openInterest, row.openInterestChange]),
    [
      ['put', 157.5, 0.65, 59, 3095, 1809, 385],
      ['put', 160, 1.47, 60, 1375, 1344, 209],
      ['put', 162.5, 2.7, 58, 592, 1179, -26],
      ['put', 165, 4.48, 60, 79, 1598, -38],
      ['put', 167.5, 6.71, 67, 21, 397, -15],
    ],
  );
  // 真实文件里 +0.31 这种带正号的结算价变动
  assert.equal(puts[4]!.settlementChange, 0.31);
  assert.equal(puts[4]!.expiry, '2025-10-17');
});

test('parseHkexQuoteRow：`-` 哨兵 → null（否则会得到 NaN）', () => {
  const row = parseHkexQuoteRow(DASH_SENTINEL_ROW)!;
  assert.equal(row.strike, 35);
  assert.equal(row.settlement, 0.01);
  assert.equal(row.settlementChange, null, '第 7 列的 `-` = 无值');
  assert.equal(row.ivPct, 70);
  assert.equal(row.volume, 0);
  assert.equal(row.openInterest, 0);
  assert.equal(row.openInterestChange, null, '第 11 列的 `-` = 无值');
  assert.equal(row.contractMonth, '30OCT25');
  assert.equal(row.expiry, '2025-10-30');
});

test('parseHkexQuoteRow：真实文件 58,408 行都是 12 个 token；表头/空行必须被拒', () => {
  const deepItm = parseHkexQuoteRow(DEEP_ITM_ROW)!;
  assert.equal(deepItm.strike, 500);
  assert.equal(deepItm.settlement, 121.08);
  assert.equal(deepItm.ivPct, 231);
  assert.equal(deepItm.volume, 0);
  assert.equal(deepItm.openInterest, 0);
  assert.equal(deepItm.openInterestChange, 0);

  assert.equal(parseHkexQuoteRow('     CONTRACT        OPENING     DAILY     DAILY   SETTLE-  CHANGE IN  IV%     VOLUME        OPEN       CHANGE'), null);
  assert.equal(parseHkexQuoteRow('                      PRICE#     HIGH#      LOW#      MENT       SETL                    INTEREST        IN OI'), null);
  assert.equal(parseHkexQuoteRow(TCH_CLASS_LINE), null);
  assert.equal(parseHkexQuoteRow(''), null);
  // 少一列（11 个 token）必须被拒，不能把 OI 当成交变动
  assert.equal(parseHkexQuoteRow('17OCT25   620.00 C      8.00     10.75      3.00      4.28      -6.55   32      1,068         486'), null);
});

test('extractHkexSection + parseHkexClassSection：按 <A NAME> 切段并按需抽取', () => {
  const tchSection = extractHkexSection(HKEX_SECTIONS_FIXTURE, 'TCH')!;
  assert.ok(tchSection.startsWith('<A NAME="TCH">'));
  assert.ok(!tchSection.includes('ALB'), 'TCH 段不能越界到 ALB');

  const tch = parseHkexClassSection(tchSection)!;
  assert.equal(tch.heading.hkats, 'TCH');
  assert.equal(tch.heading.name, 'TENCENT HOLDINGS LTD');
  assert.equal(tch.heading.underlyingClose, 620, '标的收市价 = 620.00');
  assert.equal(tch.rows.length, 5);
  assert.equal(tch.rows[1]!.strike, 620);

  const alb = parseHkexClassSection(extractHkexSection(HKEX_SECTIONS_FIXTURE, 'ALB')!)!;
  assert.equal(alb.heading.underlyingClose, 161.2);
  assert.equal(alb.rows.length, 10, '5 行认购 + 5 行认沽');
  assert.equal(alb.rows.filter((row) => row.type === 'call').length, 5);
  assert.equal(alb.rows.filter((row) => row.type === 'put').length, 5);

  assert.equal(extractHkexSection(HKEX_SECTIONS_FIXTURE, 'NOPE'), null);
});

/* ═══════════════════════════ 到期日 / 日历 ════════════════════════════════ */

test('hkExpiryFromContractMonth：9 个真实到期日全部解析正确', () => {
  // 00700 / 09988 实测共同拥有的 9 个到期
  assert.equal(hkExpiryFromContractMonth('17OCT25'), '2025-10-17');
  assert.equal(hkExpiryFromContractMonth('24OCT25'), '2025-10-24');
  assert.equal(hkExpiryFromContractMonth('30OCT25'), '2025-10-30');
  assert.equal(hkExpiryFromContractMonth('27NOV25'), '2025-11-27');
  assert.equal(hkExpiryFromContractMonth('30DEC25'), '2025-12-30');
  assert.equal(hkExpiryFromContractMonth('29JAN26'), '2026-01-29');
  assert.equal(hkExpiryFromContractMonth('30MAR26'), '2026-03-30');
  assert.equal(hkExpiryFromContractMonth('29JUN26'), '2026-06-29');
  assert.equal(hkExpiryFromContractMonth('29SEP26'), '2026-09-29');

  assert.equal(hkExpiryFromContractMonth('31FEB25'), null, '2 月 31 日不存在');
  assert.equal(hkExpiryFromContractMonth('OCT25'), null);
  assert.equal(hkExpiryFromContractMonth('30XXX25'), null);
  assert.equal(hkExpiryFromContractMonth(''), null);
});

test('月度到期日符合官方规则「合约月最后一个营业日的前一个营业日」', () => {
  // 上月最后一个工作日（只跳周末；实测这 7 个月末都不含公众假期干扰）
  const lastWeekdayOfMonth = (year: number, month: number): string => {
    const last = new Date(Date.UTC(year, month, 0)); // month 是 1-based → 取上月末
    while (last.getUTCDay() === 0 || last.getUTCDay() === 6) last.setUTCDate(last.getUTCDate() - 1);
    return last.toISOString().slice(0, 10);
  };
  const previousWeekday = (iso: string): string => {
    const d = new Date(`${iso}T00:00:00Z`);
    do {
      d.setUTCDate(d.getUTCDate() - 1);
    } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
    return d.toISOString().slice(0, 10);
  };

  // 7 个月度到期（17OCT/24OCT 是周度，跳过）
  const monthly: Array<[string, number, number]> = [
    ['30OCT25', 2025, 10],
    ['27NOV25', 2025, 11],
    ['30DEC25', 2025, 12],
    ['29JAN26', 2026, 1],
    ['30MAR26', 2026, 3],
    ['29JUN26', 2026, 6],
    ['29SEP26', 2026, 9],
  ];
  for (const [token, year, month] of monthly) {
    const expected = previousWeekday(lastWeekdayOfMonth(year, month));
    assert.equal(hkExpiryFromContractMonth(token), expected, `${token} 应等于 ${expected}`);
  }

  // 周度到期 = 该周最后一个营业日（实测就是周五）
  assert.equal(isWeekendIso(hkExpiryFromContractMonth('17OCT25')!), false);
  assert.equal(isWeekendIso(hkExpiryFromContractMonth('24OCT25')!), false);
});

test('occExpiryToIso / isoToYyMmDd / calendarDaysBetween', () => {
  assert.equal(occExpiryToIso('261019'), '2026-10-19');
  assert.equal(occExpiryToIso('261218'), '2026-12-18');
  assert.equal(occExpiryToIso('290119'), '2029-01-19');
  assert.equal(occExpiryToIso('261332'), null);
  assert.equal(occExpiryToIso('26101'), null);

  assert.equal(isoToYyMmDd('2025-10-16'), '251016');
  assert.equal(isoToYyMmDd('2026-10-19'), '261019');
  assert.equal(isoToYyMmDd('bad'), '');

  assert.equal(calendarDaysBetween('2026-10-16', '2026-10-19'), 3);
  assert.equal(calendarDaysBetween('2025-10-16', '2025-10-30'), 14);
  assert.equal(calendarDaysBetween('2026-10-19', '2026-10-16'), -3);
  assert.equal(datePart('2026-10-16T15:59:59'), '2026-10-16');
});

test('recentTradingDateCandidates：回看 10 个自然日并跳过周末', () => {
  // 2026-10-19 是周一（当天是香港公众假期，但本地不判假期 —— 由上游 404 判定）
  const candidates = recentTradingDateCandidates(10, new Date(2026, 9, 19, 12, 0, 0));
  assert.deepEqual(candidates, [
    '2026-10-19',
    '2026-10-16',
    '2026-10-15',
    '2026-10-14',
    '2026-10-13',
    '2026-10-12',
  ]);
  assert.equal(candidates.every((iso) => !isWeekendIso(iso)), true);
});

/* ═══════════════════════════ 合约乘数 ════════════════════════════════════ */

test('HK_OPTION_MULTIPLIERS：只放已核对官方合约规格的标的', () => {
  assert.deepEqual(HK_OPTION_MULTIPLIERS, {
    700: 100,
    9988: 500,
    5: 400,
    1810: 1000,
    3690: 500,
  });
  // 乘数 ≠ 每手股数：这三只是每手的 5 倍
  assert.equal(HK_OPTION_MULTIPLIERS['9988'], 500);
  assert.equal(HK_OPTION_MULTIPLIERS['1810'], 1000);
  assert.equal(HK_OPTION_MULTIPLIERS['3690'], 500);
});

test('optionMultiplier：美股 100 已核对；港股查表，未命中回退 + verified=false', () => {
  assert.deepEqual(optionMultiplier('US', 'AAPL'), { multiplier: 100, verified: true });
  assert.deepEqual(optionMultiplier('US', 'SPY'), { multiplier: 100, verified: true });

  assert.deepEqual(optionMultiplier('HK', '00700'), { multiplier: 100, verified: true });
  assert.deepEqual(optionMultiplier('HK', '700'), { multiplier: 100, verified: true });
  assert.deepEqual(optionMultiplier('HK', '09988'), { multiplier: 500, verified: true });
  assert.deepEqual(optionMultiplier('HK', '00005'), { multiplier: 400, verified: true });
  assert.deepEqual(optionMultiplier('HK', '01810'), { multiplier: 1000, verified: true });
  assert.deepEqual(optionMultiplier('HK', '03690'), { multiplier: 500, verified: true });

  // 未核对 → 回退 100 且 verified=false（调用方必须 push warning）
  assert.deepEqual(optionMultiplier('HK', '00001'), {
    multiplier: HK_OPTION_MULTIPLIER_FALLBACK,
    verified: false,
  });
  assert.deepEqual(optionMultiplier('HK', ''), { multiplier: HK_OPTION_MULTIPLIER_FALLBACK, verified: false });
});

test('hkMultiplierKey：去前导零（00700 → 700、00005 → 5）', () => {
  assert.equal(hkMultiplierKey('00700'), '700');
  assert.equal(hkMultiplierKey('700'), '700');
  assert.equal(hkMultiplierKey('00005'), '5');
  assert.equal(hkMultiplierKey('09988'), '9988');
  assert.equal(hkMultiplierKey(''), '');
});

/* ═══════════════════════════ misc ════════════════════════════════════════ */

test('常量与错误类型契约', () => {
  assert.equal(DEFAULT_MAX_EXPIRIES, 6);
  const error = new OptionChainUnavailableError('该标的没有期权', 'not_listed');
  assert.equal(error.kind, 'not_listed');
  assert.equal(error.name, 'OptionChainUnavailableError');
  assert.ok(error instanceof Error);
});

test('D2：OptionChainUnavailableError 必须是 AppError，否则 app.ts 兜成 500 + 英文原始消息', () => {
  // 上游不可用 → 502 UPSTREAM_ERROR（前端拿到中文原因）
  const upstream = new OptionChainUnavailableError('CBOE AAPL 期权链连接超时', 'upstream_failed');
  assert.ok(upstream instanceof AppError, '必须是 AppError，app.ts 才会用 statusCode');
  assert.equal(upstream.statusCode, 502);
  assert.equal(upstream.code, 'UPSTREAM_ERROR');
  assert.equal(upstream.message, 'CBOE AAPL 期权链连接超时');

  assert.equal(new OptionChainUnavailableError('没有期权链', 'not_listed').statusCode, 502);
  assert.equal(new OptionChainUnavailableError('非交易日', 'non_trading_day').statusCode, 502);
  // 调用方传错市场/代码 → 400，不是上游的锅
  assert.equal(new OptionChainUnavailableError('不支持的期权市场', 'unsupported').statusCode, 400);
  assert.equal(new OptionChainUnavailableError('不支持的期权市场', 'unsupported').code, 'BAD_REQUEST');
});

test('D2：连接级异常（undici UND_ERR_CONNECT_TIMEOUT）要翻成中文可读原因', () => {
  // 实测形态：Error('fetch failed') { cause: Error('...') { code: 'UND_ERR_CONNECT_TIMEOUT' } }
  const connectTimeout = new Error('fetch failed', {
    cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
  });
  const text = describeUpstreamFailure(connectTimeout, 'CBOE AAPL 期权链');
  assert.match(text, /^CBOE AAPL 期权链/);
  assert.match(text, /连接超时/);
  assert.match(text, /40–50%/, '要把实测成功率写进原因里');
  assert.doesNotMatch(text, /^fetch failed$/, '不能只剩英文 fetch failed');

  const dns = new Error('fetch failed', { cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }) });
  assert.match(describeUpstreamFailure(dns, 'HKEX 日报 261016'), /域名解析失败/);

  const reset = new Error('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
  assert.match(describeUpstreamFailure(reset, 'CBOE AAPL 期权链'), /连接被重置/);

  const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  assert.match(describeUpstreamFailure(aborted, 'CBOE AAPL 期权链'), /超时/);

  // 未知原因也要有中文前缀，不能把裸英文抛给用户
  assert.match(describeUpstreamFailure(new Error('boom'), 'CBOE AAPL 期权链'), /^CBOE AAPL 期权链请求失败（boom）/);
  assert.match(describeUpstreamFailure(null, 'CBOE AAPL 期权链'), /^CBOE AAPL 期权链请求失败/);
});

test('describeOptionError：把错误转成可读文案', () => {
  assert.equal(
    describeOptionError(new OptionChainUnavailableError('没有期权链', 'not_listed')),
    '没有期权链',
  );
  assert.equal(describeOptionError(new Error('boom')), 'boom');
});

test('OBS1：合约行乘数与官方合约规格不一致时必须告警（不能静默按 100 交割）', () => {
  // 已核对标的：一致 → 无告警
  assert.equal(unverifiedHkMultiplierWarning('HK', '09988', 500), null);
  assert.equal(unverifiedHkMultiplierWarning('HK', '00700', 100), null);
  assert.equal(unverifiedHkMultiplierWarning('HK', '01810', 1000), null);

  // 已核对标的：不一致 → 必须告警，且写明「金额仍按合约行计算、不擅自改写用户数据」
  const mismatch = unverifiedHkMultiplierWarning('HK', '09988', 100)!;
  assert.match(mismatch, /合约行乘数 100 与港股 09988 的官方合约规格 500 股\/张不一致/);
  assert.match(mismatch, /请核对券商合约规格/);
  assert.match(mismatch, /仍按合约行计算/);
  // 带前导零的代码也要命中同一张表
  assert.match(unverifiedHkMultiplierWarning('HK', '03690', 100)!, /官方合约规格 500/);

  // 未核对标的 + 回退值 → 原有的「乘数未核对」告警保持不变
  const unverified = unverifiedHkMultiplierWarning('HK', '00001', 100)!;
  assert.match(unverified, /合约乘数未经核对，按 100 股\/张估算/);

  // 非港股不告警
  assert.equal(unverifiedHkMultiplierWarning('US', 'AAPL', 100), null);
});

test('clearOptionsCache：可重复调用（缓存是模块级的，测试之间要能重置）', () => {
  clearOptionsCache();
  clearOptionsCache();
});