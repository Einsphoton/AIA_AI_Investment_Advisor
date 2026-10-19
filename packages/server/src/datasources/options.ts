/**
 * Option-chain datasource — **zero key**, two authoritative upstreams:
 *
 *  - US: `GET https://cdn.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json`
 *  - HK: `GET https://www.hkex.com.hk/eng/stat/dmstat/dayrpt/dqe{YYMMDD}.htm`
 *
 * Owner: options-datasource. Consumers: `services/options.ts`, `services/analytics.ts`,
 * `agent/tools.ts` (they import this module through a lazy bridge with the frozen
 * signatures implemented at the bottom of this file).
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 实测记录（2026-10-19 采样，全部来自真实响应；下面每条都对应代码里的一个处理）
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * CBOE（美股）—— 已实测标的：AAPL / KO / SPY / BRK.B
 *  · 体积与耗时：AAPL 1,498,581 B / 193,851 ms；KO 456,744 B / 20,784 ms；
 *    SPY 5,680,886 B / 113,636 ms；BRK.B 847,581 B / 13,226 ms。
 *  · **连通性很差**：`cdn.cboe.com` CNAME 到 `cdn-api.cboe.com`，undici 默认 10s
 *    连接超时经常被打穿 —— 实测 HTTP 成功率约 **40–50%**（同一 URL 连续请求会出现
 *    `UND_ERR_CONNECT_TIMEOUT`，第 4 次才成功：`try1/try2/try3 FAIL … try4 status 200
 *    ms 84455 n 3358 exps 23`）。=> 必须长超时 + 多次重试，见 `CBOE_TIMEOUT_MS` /
 *    `CBOE_RETRIES`。
 *  · **不需要 User-Agent**（之前「不带 UA 失败」经查明是 TCP connect 超时，发生在
 *    TLS/HTTP 之前，与 UA 无关）。
 *  · **小写代码是错的**：`aapl.json` → **403**；未知代码 `ZZZZNOTREAL.json` → **403**，
 *    body 是 S3 的 `<?xml …><Error><Code>AccessDenied</Code>…`（111 B）。所以
 *    「该标的没有期权链」= 403 AccessDenied，**不是** 404，也不能重试。
 *  · 顶层只有 `timestamp`（字符串，如 `"2026-10-18 22:25:11"`，是 CDN 快照时间）、
 *    `symbol`、`data`。**没有** `data.timestamp`。
 *  · `data` 实测 keys：`options, symbol, security_type, exchange_id, current_price,
 *    price_change, price_change_percent, bid, ask, bid_size, ask_size, open, high, low,
 *    close, prev_day_close, volume, iv30, iv30_change, iv30_change_percent, seqno,
 *    last_trade_time, tick`。
 *  · `data.options[]` 实测 keys（24 个）：`option, bid, bid_size, ask, ask_size, iv,
 *    open_interest, volume, delta, gamma, vega, theta, rho, theo, change, open, high,
 *    low, tick, last_trade_price, last_trade_time, percent_change, prev_day_close`。
 *    真实首项（AAPL，原样）：
 *      {"option":"AAPL261019C00245000","bid":96.8,"bid_size":188,"ask":99.25,
 *       "ask_size":67,"iv":0,"open_interest":0,"volume":4,"delta":0.9999,"gamma":0,
 *       "vega":0.0001,"theta":-0.0005,"rho":0.0067,"theo":98.4353,"change":2.815,
 *       "open":98.5,"high":100.34,"low":97.25,"tick":"up","last_trade_price":100.34,
 *       "last_trade_time":"2026-10-16T10:56:55","percent_change":2.88644,
 *       "prev_day_close":98.1499977111816}
 *  · **OCC 码长度不固定**：AAPL 19（`AAPL261019C00245000`）、SPY 18、KO 17
 *    （`KO261023C00045000`）、BRK.B 18 且 root 变成 `BRKB`（点被吃掉）。=> 只能用
 *    正则 `/^(.+?)(\d{6})([CP])(\d{8})$/` 从右往左解析，**绝不能定长切片**；也
 *    **不能用 root 反推标的代码**（BRKB ≠ BRK.B），标的代码只信请求参数。
 *  · **`iv` 是小数**（AAPL 非零区间 0.1588–3.6693，KO 0.1278–3.6698），`iv=0` 表示
 *    「上游没给」而不是「波动率为 0」：AAPL 3,358 条里 397 条 iv=0。=> `iv<=0` 归一化
 *    成 0（`OptionQuote.iv` 的 0 语义就是「未给出」），**绝不参与估算**。
 *  · `open_interest` 合法为 0（AAPL 666 条）；`bid==0 && ask==0` 有 40 条（无报价）。
 *    另外 **`options[]` 里会出现 null 字段**（AAPL 3,358 条里 525 条含至少一个 null）
 *    => 每个数值都要 `Number.isFinite` 兜底。
 *  · **延迟口径**：响应体里**没有**任何 delay/延迟字段（`data.delay` 不存在）。
 *    => 只写「延迟行情」，**不声称「15 分钟延迟」**（那是官方产品定位，响应体没给证据）。
 *  · **周末行为（实测）**：周日请求返回上一交易日 2026-10-16 的收盘快照，
 *    `data.last_trade_time = 2026-10-16T15:59:59`（AAPL）/ `16:00:00`（KO/SPY）；
 *    `data.current_price = 342.62` 而 `data.close = data.prev_day_close = 343.46`。
 *    => `current_price` = 最新价，`close` = 上一交易日收盘价（两者在周末不相等）。
 *  · **`price_change` 不可用**：AAPL `price_change=1.46` 但 `current_price - close =
 *    -0.84`，`price_change_percent=0.4251`（=1.46/343.46）—— 自相矛盾。=> 本模块
 *    **不读** `price_change` / `price_change_percent`，昨收一律用 `close`。
 *  · 未见限频：连发 4 次没有 429，成功时 payload 完全一致；瓶颈是 CDN 连通性。
 *
 * HKEX（港股）—— 日报 `dqe{YYMMDD}.htm`
 *  · 体积与耗时：**6,669,912 B / 4,146 ms**（251016）；251017 = 6,688,280 B /
 *    4,661 ms；251020 = 6,693,656 B；251021 = 6,701,496 B。是 `charset=iso-8859-1`
 *    的纯文本塞在**单个 `<pre>`** 里，用 `TextDecoder('utf-8')` 读 ASCII 部分无损。
 *  · **非交易日 = HTTP 404**（通用 2,902 B 的 HKEX 404 页，不是报告）。实测
 *    251018(六)/251019(日)/251001(国庆)/250101(元旦) 404；251016/251017/251020/251021 200。
 *    => 逐日回退，见 `resolveHkexReport()`。**不需要本地公众假期表**（见
 *    `options-calendar.ts` 文件头）。
 *  · 摘要表 `HKATS UNDERLYING SUMMARY` 实测 **138 行，正则 0 失败**，行宽 110：
 *      `TCH TENCENT HOLDINGS LTD    (00700)    156,996     62,429     94,567   1,844,894     868,011     976,883   31`
 *    即 `HKATS码 名称 (5位港股代码) 成交量(总/购/沽) 未平仓(总/购/沽) IV%`。
 *  · **一码多 HKATS（实测 4 组）**：`01211 → [BYA,BYD]`（BYA 是 `BYD (ADJ-A)` 调整
 *    系列）、`01833 → [PHA,PHT]`、`00288 → [WHD,WHE,WHG]`、`00788 → [XTA,XTW]`。
 *    => `pickHkatsForStockCode()` 取「成交+未平仓」最大者并 push warning。
 *  · 明细段：`<A NAME="{HKATS}">` 起，到下一个 `<A NAME="` 止。段落头：
 *      `CLASS TCH - TENCENT HOLDINGS LTD                  CLOSING PRICE HK$  620.00`
 *    实测 139 个 CLASS 行**全部含 CLOSING PRICE（139/139）**。
 *  · 明细行字段顺序（**实测 58,408 行 100% 都是 12 个空白分隔 token**）：
 *      0 CONTRACT(DDMMMYY **完整到期日**) 1 STRIKE 2 C/P 3 OPENING 4 DAILY HIGH
 *      5 DAILY LOW 6 SETTLEMENT PRICE 7 CHANGE IN SETTLEMENT 8 IV%
 *      9 VOLUME 10 OPEN INTEREST 11 CHANGE IN OI
 *    原样样例（00700 17OCT25）：
 *      "17OCT25   620.00 C      8.00     10.75      3.00      4.28      -6.55   32      1,068         486         +381"
 *  · **`-` 哨兵**：全文件 124 行（0.21%）在第 7 或第 11 列是字面量 `-`（无值）：
 *      "30OCT25    35.00 C      0.00      0.00      0.00      0.01          -   70          0           0            -"
 *    => 必须映射成 `null`，否则得到 NaN。带正号的 `+0.31` 也要能解析。
 *  · **港股没有买卖报价**：报告只有 开市/最高/最低/结算价/IV/成交量/未平仓，
 *    全文件 grep 不到 BID/ASK/LAST 列。=> `bid/ask/last/mid/spreadPct` 一律 0，
 *    `settlement` = HKEX 每日结算价，并用 warning 说清这一点（**不编造价差**）。
 *  · **港股没有希腊字母**（无 delta/gamma/vega/theta）=> `delta = 0` 表示「未知」
 *    并 push warning。**绝不自算一个 delta 冒充上游真实值**（被行权概率的估算由
 *    `services/options.ts` 在服务层做并标注 `estimated`）。
 *  · 官方合约规格（来源 URL 见 `packages/shared/src/constants.ts` 的
 *    `HK_OPTION_MULTIPLIERS` 注释）：
 *      00700 TCH 100 股/张、09988 ALB **500**（= 5 个每手）、00005 HKB 400、
 *      01810 MIU **1,000**（= 5 个每手）、03690 MET **500**（= 5 个每手）。
 *    **乘数 ≠ 每手股数**，按每手算会低估 5 倍。全部 154 个类别的乘数分布为
 *    `100:10, 200:10, 400:4, 500:34, 1000:46, 2000:24, …`，跨度 20–20,000，
 *    所以不存在「合理默认值」，未核对的必须回退并告警。
 *  · 美股结算/行权口径**没有实测证据**：`theocc.com` / `cdn.cboe.com/.../rule_book`
 *    本机实测全部 **403**（WAF / 错误 S3 key），`sec.gov` / `finra.org` /
 *    `optionseducation.org` 对应页 404/403。代码注释只按**公开规则**写（美式、
 *    实物交割 100 股/张、OCC ExByEx ITM ≥ $0.01），**不当作实测结论**。
 */
import {
  HK_OPTION_MULTIPLIERS,
  HK_OPTION_MULTIPLIER_FALLBACK,
  US_OPTION_MULTIPLIER,
  type OptionChainSnapshot,
  type OptionExpiryGroup,
  type OptionMarket,
  type OptionQuote,
  type OptionType,
} from '@aia/shared';

import { errorMessage, httpRequest, localDate, round4 } from './http.js';
import { AppError } from '../errors.js';
import {
  HKEX_REPORT_MAX_LOOKBACK_DAYS,
  calendarDaysBetween,
  datePart,
  hkExpiryFromContractMonth,
  isoToYyMmDd,
  occExpiryToIso,
  recentTradingDateCandidates,
} from './options-calendar.js';

export { hkExpiryFromContractMonth };

/* ─────────────────────────────── endpoints & tuning ──────────────────────── */

const CBOE_OPTIONS_BASE = 'https://cdn.cboe.com/api/global/delayed_quotes/options';
const HKEX_REPORT_BASE = 'https://www.hkex.com.hk/eng/stat/dmstat/dayrpt';

/**
 * CBOE 超时给到 60s（实测单请求 13s–194s）；重试 3 次（实测成功率约 40–50%，
 * 连通失败主要是 `UND_ERR_CONNECT_TIMEOUT`）。403（小写代码 / 未知代码）由
 * `http.ts` 的 `httpRequest` 直接判定为不可重试。
 */
const CBOE_TIMEOUT_MS = 60_000;
const CBOE_RETRIES = 3;
const CBOE_TIMEOUT_HINT_MS = 20_000;
/** CBOE 上游本就是延迟行情，120s 缓存足够，避免把不稳定的 CDN 打爆。 */
const CBOE_CACHE_TTL_MS = 120_000;

/** HKEX 单份 6.7MB / 约 4s；同一天只下一次。 */
const HKEX_TIMEOUT_MS = 30_000;
const HKEX_RETRIES = 2;
const HKEX_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** 默认最多返回 6 个最近到期。 */
export const DEFAULT_MAX_EXPIRIES = 6;

/* ──────────────────────────────── public types ───────────────────────────── */

export interface OptionChainRequest {
  market: OptionMarket;
  code: string;
  name?: string;
  /** 调用方已知现价时传入，避免重复抓行情。 */
  underlyingPrice?: number;
  /** 只保留这些到期日（`YYYY-MM-DD`）。 */
  expiries?: string[];
  /** 默认 6，按最近优先。 */
  maxExpiries?: number;
  forceRefresh?: boolean;
}

/* ──────────────────────────────── caches ─────────────────────────────────── */

interface CboePayload {
  timestamp?: unknown;
  symbol?: unknown;
  data?: {
    options?: unknown;
    symbol?: unknown;
    current_price?: unknown;
    close?: unknown;
    prev_day_close?: unknown;
    iv30?: unknown;
    last_trade_time?: unknown;
    [key: string]: unknown;
  };
}

interface CboeCacheEntry {
  at: number;
  payload: CboePayload;
  bytes: number;
  ms: number;
}

interface HkexTextEntry {
  at: number;
  /** `null` = 该日非交易日（HTTP 404），做负缓存避免反复探测。 */
  text: string | null;
  bytes: number;
  ms: number;
}

const cboeCache = new Map<string, CboeCacheEntry>();
const cboeInflight = new Map<string, Promise<CboeCacheEntry>>();
const hkexTextCache = new Map<string, HkexTextEntry>();
const hkexInflight = new Map<string, Promise<HkexTextEntry>>();
const hkexSummaryCache = new Map<string, HkexUnderlyingRow[]>();
const hkexSectionCache = new Map<string, HkexClassSection | null>();

/** 测试/诊断用：清空所有模块级缓存。 */
export function clearOptionsCache(): void {
  cboeCache.clear();
  cboeInflight.clear();
  hkexTextCache.clear();
  hkexInflight.clear();
  hkexSummaryCache.clear();
  hkexSectionCache.clear();
}

function trimMap<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/* ──────────────────────────── number coercion ────────────────────────────── */

/** HKEX 的 `-` 哨兵 → null；其余（含 `+0.31`、`1,068`）→ number。 */
function hkexNumber(value: string | undefined): number | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw === '-' || raw === '--') return null;
  const parsed = Number(raw.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** 任意上游数字 → number | null（null 表示「上游没给」）。 */
function finiteOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const raw = value.trim().replace(/,/g, '');
    if (!raw || raw === '-' || raw === '--') return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 任意上游数字 → number（缺失/非法一律 0，用于「0 就是未给出」的字段）。 */
function finiteOrZero(value: unknown): number {
  return finiteOrNull(value) ?? 0;
}

/* ══════════════════════════════ US: CBOE ═══════════════════════════════════ */

export interface OccSymbolParts {
  /** OCC root。注意带点代码会被吃掉点（`BRK.B` → `BRKB`），**不能**反推标的。 */
  root: string;
  /** OCC 里的 6 位到期日 `YYMMDD`。 */
  occExpiry: string;
  /** `YYYY-MM-DD`。 */
  expiry: string;
  type: OptionType;
  strike: number;
}

/**
 * 解析 OCC 期权代码 `{ROOT}{YYMMDD}{C|P}{8位千分之一价}`。
 *
 * 实测长度不固定：AAPL 19 / SPY 18 / KO 17 / BRK.B 18（root `BRKB`）。
 * 所以用惰性 root + 从右往左锚定的正则，不能定长切片。
 * 到期日非法（如 13 月、32 日）时返回 `null` —— 宁可丢掉一条，也不产出错日期。
 */
export function parseOccSymbol(option: string): OccSymbolParts | null {
  if (typeof option !== 'string') return null;
  const match = /^(.+?)(\d{6})([CP])(\d{8})$/.exec(option.trim().toUpperCase());
  if (!match) return null;
  const root = match[1]!;
  const occExpiry = match[2]!;
  const strikeRaw = Number(match[4]!);
  if (!root || !Number.isFinite(strikeRaw)) return null;
  const expiry = occExpiryToIso(occExpiry);
  if (!expiry) return null;
  return {
    root,
    occExpiry,
    expiry,
    type: match[3] === 'C' ? 'call' : 'put',
    strike: round4(strikeRaw / 1000),
  };
}

/**
 * 单条 CBOE option → `OptionQuote`。
 *
 * 归一化规则（每一条都对应上面的实测坑）：
 *  · `iv <= 0` → 0（= 上游未给出）；CBOE 的 `iv` 本来就是小数，不用换算。
 *  · `settlement` = `theo`（CBOE 理论价，`OptionQuote.settlement` 对美股的口径）。
 *  · 不读 `price_change` / `price_change_percent`。
 *  · `mid` / `spreadPct` 只在双边报价都存在时才算，否则 0（表示「没给报价」）。
 */
export function parseCboeOptionQuote(raw: Record<string, unknown>, multiplier = US_OPTION_MULTIPLIER): OptionQuote | null {
  const parts = parseOccSymbol(String(raw.option ?? ''));
  if (!parts) return null;

  const bid = Math.max(0, finiteOrZero(raw.bid));
  const ask = Math.max(0, finiteOrZero(raw.ask));
  const last = Math.max(0, finiteOrZero(raw.last_trade_price));
  const twoSided = bid > 0 && ask > 0 && ask >= bid;
  const mid = twoSided ? round4((bid + ask) / 2) : 0;
  const spreadPct = twoSided && mid > 0 ? round4(((ask - bid) / mid) * 100) : 0;
  const ivRaw = finiteOrZero(raw.iv);

  return {
    code: String(raw.option ?? '').toUpperCase(),
    type: parts.type,
    strike: parts.strike,
    expiry: parts.expiry,
    bid: round4(bid),
    ask: round4(ask),
    last: round4(last),
    settlement: round4(Math.max(0, finiteOrZero(raw.theo))),
    // 0 = 上游未给出（实测 AAPL 3,358 条里 397 条 iv=0）
    iv: ivRaw > 0 ? round4(ivRaw) : 0,
    delta: round4(finiteOrZero(raw.delta)),
    openInterest: round4(Math.max(0, finiteOrZero(raw.open_interest))),
    volume: round4(Math.max(0, finiteOrZero(raw.volume))),
    multiplier,
    mid,
    spreadPct,
  };
}

/** Biome-free guard: CBOE 的 `data.options` 必须是数组。 */
export function cboeOptionsOf(payload: CboePayload): Record<string, unknown>[] {
  const options = payload?.data?.options;
  return Array.isArray(options) ? (options as Record<string, unknown>[]) : [];
}

/** 把 `Error` 的 `cause` 链摊平成字符串（undici 把真实原因藏在 cause 里）。 */
function errorChainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const code = typeof (current as { code?: unknown }).code === 'string' ? (current as { code: string }).code : '';
    if (code) parts.push(code);
    const message = errorMessage(current);
    if (message && message !== code) parts.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

/**
 * 把任意网络层异常翻译成**中文可读**的失败原因。
 *
 * 实测坑（D2）：`httpRequest` 在连接阶段失败时抛的是原始 `Error('fetch failed')`
 * （cause 链里是 `UND_ERR_CONNECT_TIMEOUT`），既不是 `AppError` 也没有中文，
 * 上层 `loadOptionChain` 捕获不到 → 直接变成 500 INTERNAL_ERROR + 英文 "fetch failed"，
 * 与「上游失败 = 502 + 中文原因」的约定不符。所以这里统一转成
 * `OptionChainUnavailableError(kind='upstream_failed')`。
 */
export function describeUpstreamFailure(error: unknown, label: string): string {
  const text = errorChainText(error);
  if (/CONNECT_TIMEOUT|ETIMEDOUT|connect timeout/i.test(text)) {
    return `${label}连接超时（上游 CDN 连通性差，已重试仍失败；实测 CBOE 单次成功率约 40–50%）`;
  }
  if (/ERR_ABORT|AbortError|aborted|timeout/i.test(text)) {
    return `${label}请求超时（已重试仍失败）`;
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return `${label}域名解析失败（本机 DNS 或网络异常）`;
  }
  if (/ECONNRESET|EPIPE|socket hang up|ECONNREFUSED/i.test(text)) {
    return `${label}连接被重置/拒绝（上游或中间网络异常）`;
  }
  if (/EPERM|EACCES/i.test(text)) {
    return `${label}网络访问被本机沙箱/防火墙拦截`;
  }
  if (/CERT|TLS|SSL/i.test(text)) {
    return `${label}TLS 握手失败`;
  }
  return `${label}请求失败（${text || '未知网络原因'}）`;
}

/**
 * 调用 `httpRequest`，把**连接级**异常统一转成 `OptionChainUnavailableError`。
 *
 * 只包连接/超时这类异常；HTTP 状态码由调用方自己看 `response.status` 判断
 *（403 = 没有该期权链，不是网络故障，不能重试、也不能报成 upstream_failed）。
 */
async function requestOrUnavailable(
  url: string,
  options: Parameters<typeof httpRequest>[1],
  label: string,
): Promise<Awaited<ReturnType<typeof httpRequest>>> {
  try {
    return await httpRequest(url, options);
  } catch (error) {
    if (error instanceof OptionChainUnavailableError) throw error;
    throw new OptionChainUnavailableError(describeUpstreamFailure(error, label), 'upstream_failed');
  }
}

async function fetchCboePayload(symbol: string, forceRefresh: boolean): Promise<CboeCacheEntry> {
  const cached = cboeCache.get(symbol);
  if (!forceRefresh && cached && Date.now() - cached.at < CBOE_CACHE_TTL_MS) return cached;
  const pending = cboeInflight.get(symbol);
  if (!forceRefresh && pending) return pending;

  const url = `${CBOE_OPTIONS_BASE}/${symbol}.json`;
  const task = (async (): Promise<CboeCacheEntry> => {
    const started = Date.now();
    const response = await requestOrUnavailable(
      url,
      { timeoutMs: CBOE_TIMEOUT_MS, retries: CBOE_RETRIES, headers: { Accept: 'application/json' } },
      `CBOE ${symbol} 期权链`,
    );
    if (!response.ok) {
      // 实测：未知代码 / 小写代码 → 403 + S3 AccessDenied XML。
      if (response.status === 403) {
        throw new OptionChainUnavailableError(
          `CBOE 没有 ${symbol} 的期权链（HTTP 403${response.text.includes('AccessDenied') ? ' AccessDenied' : ''}）；` +
            '请确认代码为大写、且在 CBOE 有上市期权。',
          'not_listed',
        );
      }
      throw new OptionChainUnavailableError(`CBOE 返回 HTTP ${response.status}`, 'upstream_failed');
    }
    let payload: CboePayload;
    try {
      payload = JSON.parse(response.text) as CboePayload;
    } catch {
      throw new OptionChainUnavailableError(`CBOE 返回的不是合法 JSON（${symbol}）`, 'upstream_failed');
    }
    const entry: CboeCacheEntry = { at: Date.now(), payload, bytes: response.text.length, ms: Date.now() - started };
    cboeCache.set(symbol, entry);
    trimMap(cboeCache, 40);
    return entry;
  })();

  cboeInflight.set(symbol, task);
  try {
    return await task;
  } finally {
    cboeInflight.delete(symbol);
  }
}

/**
 * 可读的上游不可用错误（上层会把它变成 502 / warning，绝不用假数据兜）。
 *
 * **必须继承 `AppError`**：`app.ts` 的错误处理器只对 `AppError` 用 `statusCode`，
 * 其它异常一律兜成 **500 INTERNAL_ERROR + 原始英文消息**（实测踩过：连接失败抛裸
 * `Error('fetch failed')`，前端看到的就是 500 "fetch failed"）。现在：
 *  · `unsupported`（调用方传错市场/代码）→ **400 BAD_REQUEST**
 *  · 其余（没有该期权链 / 非交易日 / 上游故障）→ **502 UPSTREAM_ERROR**
 */
export class OptionChainUnavailableError extends AppError {
  /** `not_listed` = 该标的确实没有期权；`non_trading_day`；`upstream_failed`；`unsupported`。 */
  readonly kind: 'not_listed' | 'non_trading_day' | 'upstream_failed' | 'unsupported';

  constructor(message: string, kind: 'not_listed' | 'non_trading_day' | 'upstream_failed' | 'unsupported') {
    super(
      kind === 'unsupported' ? 400 : 502,
      kind === 'unsupported' ? 'BAD_REQUEST' : 'UPSTREAM_ERROR',
      message,
      { kind },
    );
    this.name = 'OptionChainUnavailableError';
    this.kind = kind;
  }
}

/* ══════════════════════════════ HK: HKEX ═══════════════════════════════════ */

export interface HkexUnderlyingRow {
  /** HKATS 期权代码，如 `TCH`。 */
  hkats: string;
  name: string;
  /** 报告里的 5 位港股代码，如 `00700`。 */
  stockCode: string;
  volumeTotal: number;
  volumeCalls: number;
  volumePuts: number;
  openInterestTotal: number;
  openInterestCalls: number;
  openInterestPuts: number;
  /** IV%（整数，报告原样，如 `31`）。 */
  ivPct: number;
}

export interface HkexQuoteRow {
  /** `CONTRACT` 列：**完整到期日** `DDMMMYY`（不是「合约月份」，见文件头实测）。 */
  contractMonth: string;
  /** `YYYY-MM-DD`；解析不出时 null。 */
  expiry: string | null;
  strike: number;
  type: OptionType;
  open: number;
  high: number;
  low: number;
  settlement: number;
  /** `CHANGE IN SETTLEMENT PRICE`；`-` 哨兵 → null。 */
  settlementChange: number | null;
  /** IV%，报告原样整数；0 = 上游未给出。 */
  ivPct: number;
  volume: number;
  openInterest: number;
  /** `CHANGE IN OI`；`-` 哨兵 → null。 */
  openInterestChange: number | null;
}

export interface HkexClassHeading {
  hkats: string;
  name: string;
  /** `CLOSING PRICE HK$` 后的标的收市价。 */
  underlyingClose: number;
}

export interface HkexClassSection {
  heading: HkexClassHeading;
  rows: HkexQuoteRow[];
}

/** 摘要表行的正则（实测 138/138 通过，行宽 110）。 */
const HKEX_SUMMARY_ROW_RE =
  /^([A-Z0-9]{3})\s+(.{20,30}?)\s*\((\d{5})\)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+(\d+)\s*$/;

/** `CLASS TCH - TENCENT HOLDINGS LTD                  CLOSING PRICE HK$  620.00` */
const HKEX_CLASS_HEADING_RE = /^CLASS\s+(\S+)\s*-\s*(.+?)\s{2,}CLOSING PRICE HK\$\s+([\d.,]+)\s*$/;

/** `17OCT25   620.00 C      8.00     10.75      3.00      4.28      -6.55   32      1,068         486         +381` */
const HKEX_QUOTE_ROW_RE = /^(\d{2}[A-Z]{3}\d{2})\s+([\d.]+)\s+([CP])\s+(\S.*)$/;

/**
 * 解析 `HKATS UNDERLYING SUMMARY` 表（→ 期权代码 ↔ 港股代码映射 + IV%）。
 *
 * 实测 138 行、正则 0 失败；**港股代码 → HKATS 不是一对一**（4 组一码多期权，
 * 见 `pickHkatsForStockCode`）。
 *
 * ⚠️ 表中间会夹着**非数据行**，绝不能因为一行不匹配就 `break`（这个坑实测踩过：
 * 会在第 51 行处截断，导致 00700 这种排在后面的标的被误判成「没有期权」）：
 *  · `EVG EVERGRANDE              (  NIL)          0 ...` —— 停牌/下市类别，代码
 *    位是 `(  NIL)` 而不是 5 位数字，整行跳过。
 *  · `    TOTAL  1,037,439 ...` 合计行。
 * 表尾 = 空行（随后是 `<A NAME="A50">` 之类的锚点）或 `<` 开头。
 */
export function parseHkexSummary(text: string): HkexUnderlyingRow[] {
  if (typeof text !== 'string' || !text) return [];
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^HKATS\s+UNDERLYING/.test(line));
  if (headerIndex < 0) return [];
  const rows: HkexUnderlyingRow[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.trim() || line.startsWith('<')) break;
    if (/^TOTAL\b/.test(line.trim())) break;
    if (/^CODE\s+STOCK/.test(line)) continue;
    const match = HKEX_SUMMARY_ROW_RE.exec(line);
    if (!match) continue;
    rows.push({
      hkats: match[1]!,
      name: (match[2] ?? '').trim(),
      stockCode: match[3]!,
      volumeTotal: finiteOrZero(match[4]),
      volumeCalls: finiteOrZero(match[5]),
      volumePuts: finiteOrZero(match[6]),
      openInterestTotal: finiteOrZero(match[7]),
      openInterestCalls: finiteOrZero(match[8]),
      openInterestPuts: finiteOrZero(match[9]),
      ivPct: finiteOrZero(match[10]),
    });
  }
  return rows;
}

/** 解析 `CLASS … CLOSING PRICE HK$ …` 段落头。实测 139/139 都有收市价。 */
export function parseHkexClassHeading(line: string): HkexClassHeading | null {
  if (typeof line !== 'string') return null;
  const match = HKEX_CLASS_HEADING_RE.exec(line.trimEnd());
  if (!match) return null;
  const close = finiteOrNull(match[3]);
  if (close === null) return null;
  return { hkats: match[1]!, name: match[2]!.trim(), underlyingClose: close };
}

/**
 * 解析一条 HKEX 明细行（实测 58,408 行全部 12 个 token）。
 *
 * `-` 哨兵（实测 124 行，占 0.21%）在第 7/11 列 → `null`；`+0.31` 这种带正号也支持。
 */
export function parseHkexQuoteRow(line: string): HkexQuoteRow | null {
  if (typeof line !== 'string') return null;
  if (!HKEX_QUOTE_ROW_RE.test(line)) return null;
  const tokens = line.trim().split(/\s+/);
  if (tokens.length !== 12) return null;

  const contractMonth = tokens[0]!;
  const strike = finiteOrNull(tokens[1]);
  const side = tokens[2]!;
  const open = finiteOrNull(tokens[3]);
  const high = finiteOrNull(tokens[4]);
  const low = finiteOrNull(tokens[5]);
  const settlement = finiteOrNull(tokens[6]);
  const ivPct = finiteOrNull(tokens[8]);
  const volume = finiteOrNull(tokens[9]);
  const openInterest = finiteOrNull(tokens[10]);
  if (strike === null || open === null || high === null || low === null || settlement === null) return null;
  if (ivPct === null || volume === null || openInterest === null) return null;

  return {
    contractMonth,
    expiry: hkExpiryFromContractMonth(contractMonth),
    strike: round4(strike),
    type: side === 'C' ? 'call' : 'put',
    open: round4(open),
    high: round4(high),
    low: round4(low),
    settlement: round4(settlement),
    settlementChange: hkexNumber(tokens[7]),
    ivPct: round4(ivPct),
    volume: round4(volume),
    openInterest: round4(openInterest),
    openInterestChange: hkexNumber(tokens[11]),
  };
}

/** 截出 `<A NAME="{hkats}">` 到下一个 `<A NAME="` 之间的段落（全文件 indexOf，毫秒级）。 */
export function extractHkexSection(text: string, hkats: string): string | null {
  if (typeof text !== 'string' || !text) return null;
  const anchor = `<A NAME="${hkats}">`;
  const start = text.indexOf(anchor);
  if (start < 0) return null;
  const next = text.indexOf('\n<A NAME="', start + anchor.length);
  return text.slice(start, next < 0 ? text.length : next);
}

/** 段落文本 → 段落头 + 全部明细行。 */
export function parseHkexClassSection(section: string): HkexClassSection | null {
  if (typeof section !== 'string' || !section) return null;
  const lines = section.split(/\r?\n/);
  let heading: HkexClassHeading | null = null;
  const rows: HkexQuoteRow[] = [];
  for (const line of lines) {
    if (!heading && line.startsWith('CLASS ')) {
      heading = parseHkexClassHeading(line);
      continue;
    }
    if (!HKEX_QUOTE_ROW_RE.test(line)) continue;
    const row = parseHkexQuoteRow(line);
    if (row) rows.push(row);
  }
  if (!heading) return null;
  return { heading, rows };
}

/** 港股代码 → 5 位规范形式（`700` / `00700` / `HK:700` 都 → `00700`）。 */
export function normalizeHkStockCode(code: string): string {
  const digits = String(code ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.padStart(5, '0').slice(-5);
}

/** `HK_OPTION_MULTIPLIERS` 的键：去前导零的港股代码（`00700` → `700`）。 */
export function hkMultiplierKey(code: string): string {
  const normalized = normalizeHkStockCode(code);
  if (!normalized) return '';
  return String(Number(normalized));
}

/**
 * 港股代码 → HKATS 期权代码。
 *
 * **实测一码多期权（4 组，2026-10-16 报告原样）**：
 *   `01211 → BYA "BYD (ADJ-A)" / BYD "BYD COMPANY"`
 *   `01833 → PHA "PHT (ADJ-A)" / PHT "PA GOODDOCTOR"`
 *   `00288 → WHD "WHG (ADJ-B)" / WHE "WHG (ADJ-C)" / WHG "WH GROUP"`
 *   `00788 → XTA "CHINA TOWER ($0.001) (AD" / XTW "CHINA TOWER ($0.001)"`
 *
 * 选取规则（两级，全部依据上面这份真实文本）：
 *  1. **优先非调整系列** —— 名称里带 `(ADJ-x)` / 被截断成 `(AD` 的是调整系列
 *     （实测 `BYA`/`PHA`/`WHD`/`WHE`/`XTA`）。这一条是必须的：`00288` 若只按
 *     「成交+未平仓」排序会选中调整系列 `WHD`（1,934）而不是主系列 `WHG`（408）。
 *  2. 同级内取「成交量 + 未平仓」最大者，再按代码字典序稳定排序。
 *
 * 命中多个时把全部候选放进 `ambiguous`，让调用方 push warning —— 不静默取第一个。
 */
export function pickHkatsForStockCode(
  rows: readonly HkexUnderlyingRow[],
  code: string,
): { row: HkexUnderlyingRow; ambiguous: string[] } | null {
  const normalized = normalizeHkStockCode(code);
  if (!normalized) return null;
  const matches = rows.filter((row) => row.stockCode === normalized);
  if (matches.length === 0) return null;
  if (matches.length === 1) return { row: matches[0]!, ambiguous: [] };

  const isAdjusted = (row: HkexUnderlyingRow): boolean => /\(AD/i.test(row.name);
  const plain = matches.filter((row) => !isAdjusted(row));
  const pool = plain.length > 0 ? plain : matches;
  const ranked = [...pool].sort(
    (a, b) =>
      b.volumeTotal + b.openInterestTotal - (a.volumeTotal + a.openInterestTotal) ||
      a.hkats.localeCompare(b.hkats),
  );
  return { row: ranked[0]!, ambiguous: ranked.map((row) => row.hkats) };
}

/**
 * 下载某一天的 HKEX 报告；**非交易日返回 `null`**（实测 HTTP 404 + 2,902 B 通用页），
 * 并做负缓存，避免同一天被反复探测。
 */
async function fetchHkexReport(isoDate: string, forceRefresh: boolean): Promise<HkexTextEntry> {
  const key = isoToYyMmDd(isoDate);
  if (!key) return { at: Date.now(), text: null, bytes: 0, ms: 0 };
  const cached = hkexTextCache.get(key);
  if (!forceRefresh && cached && Date.now() - cached.at < HKEX_CACHE_TTL_MS) return cached;
  const pending = hkexInflight.get(key);
  if (!forceRefresh && pending) return pending;

  const url = `${HKEX_REPORT_BASE}/dqe${key}.htm`;
  const task = (async (): Promise<HkexTextEntry> => {
    const started = Date.now();
    // 连接级失败同样要转成 OptionChainUnavailableError（否则上层拿到英文 "fetch failed" → 500）。
    const response = await requestOrUnavailable(
      url,
      { timeoutMs: HKEX_TIMEOUT_MS, retries: HKEX_RETRIES, headers: { Accept: 'text/html' } },
      `HKEX 日报 ${key}`,
    );
    const entry: HkexTextEntry =
      response.status === 404
        ? { at: Date.now(), text: null, bytes: response.text.length, ms: Date.now() - started }
        : response.ok
          ? { at: Date.now(), text: response.text, bytes: response.text.length, ms: Date.now() - started }
          : (() => {
              throw new OptionChainUnavailableError(
                `HKEX 报告 ${key} 返回 HTTP ${response.status}`,
                'upstream_failed',
              );
            })();
    hkexTextCache.set(key, entry);
    trimMap(hkexTextCache, 12);
    return entry;
  })();

  hkexInflight.set(key, task);
  try {
    return await task;
  } finally {
    hkexInflight.delete(key);
  }
}

export interface HkexReportHandle {
  /** 报告对应的交易日 `YYYY-MM-DD`。 */
  date: string;
  text: string;
  bytes: number;
  ms: number;
  /** 抓取日（本地日期）与报告日不一致时的自然日差（0 = 就是今天）。 */
  stalenessDays: number;
}

/**
 * 取「最近一份可用的」HKEX 报告：从今天起往前逐日回退，最多
 * `HKEX_REPORT_MAX_LOOKBACK_DAYS`(=10) 个自然日；周末直接跳过（必然 404），
 * 公众假期靠 HTTP 404 判定（**不依赖本地假期表**）。
 *
 * 单个候选日的**连接级失败不终止整轮回退**（CDN 抖动不该让「今天」的一次超时
 * 把昨天那份能用的报告也放弃掉）；只有所有候选日都失败时才抛出最后一次的错误，
 * 全部 404 则返回 `null`（= 连续非交易日）。
 */
export async function resolveHkexReport(forceRefresh = false, from = new Date()): Promise<HkexReportHandle | null> {
  const today = localDate(from);
  const candidates = recentTradingDateCandidates(HKEX_REPORT_MAX_LOOKBACK_DAYS, from);
  let lastError: OptionChainUnavailableError | null = null;
  for (const candidate of candidates) {
    /* eslint-disable no-await-in-loop -- 逐日回退必须串行：命中即停，不能并发打 10 次 */
    let entry: HkexTextEntry;
    try {
      entry = await fetchHkexReport(candidate, forceRefresh);
    } catch (error) {
      lastError =
        error instanceof OptionChainUnavailableError
          ? error
          : new OptionChainUnavailableError(describeUpstreamFailure(error, 'HKEX 日报'), 'upstream_failed');
      continue;
    }
    if (entry.text) {
      return {
        date: candidate,
        text: entry.text,
        bytes: entry.bytes,
        ms: entry.ms,
        stalenessDays: Math.abs(calendarDaysBetween(today, candidate)),
      };
    }
  }
  if (lastError) throw lastError;
  return null;
}

function hkexSummaryFor(handle: HkexReportHandle, forceRefresh: boolean): HkexUnderlyingRow[] {
  if (!forceRefresh) {
    const cached = hkexSummaryCache.get(handle.date);
    if (cached) return cached;
  }
  const rows = parseHkexSummary(handle.text);
  hkexSummaryCache.set(handle.date, rows);
  trimMap(hkexSummaryCache, 12);
  return rows;
}

function hkexSectionFor(handle: HkexReportHandle, hkats: string, forceRefresh: boolean): HkexClassSection | null {
  const key = `${handle.date}:${hkats}`;
  if (!forceRefresh) {
    const cached = hkexSectionCache.get(key);
    if (cached !== undefined) return cached;
  }
  const sectionText = extractHkexSection(handle.text, hkats);
  const section = sectionText ? parseHkexClassSection(sectionText) : null;
  hkexSectionCache.set(key, section);
  trimMap(hkexSectionCache, 64);
  return section;
}

/* ──────────────────────────── snapshot assembly ──────────────────────────── */

/** 平值 IV：取该到期里离标的现价最近、且上游给了 IV 的那条。 */
function atmIvFor(quotes: readonly OptionQuote[], underlyingPrice: number): number {
  let best: OptionQuote | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const quote of quotes) {
    if (!(quote.iv > 0)) continue;
    const distance = Math.abs(quote.strike - underlyingPrice);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = quote;
    }
  }
  return best ? best.iv : 0;
}

/** 按到期日分组（升序），`daysToExpiry` 以 `valuationDate` 为基准。 */
function groupExpiries(quotes: readonly OptionQuote[], valuationDate: string): OptionExpiryGroup[] {
  const byExpiry = new Map<string, OptionQuote[]>();
  for (const quote of quotes) {
    const bucket = byExpiry.get(quote.expiry);
    if (bucket) bucket.push(quote);
    else byExpiry.set(quote.expiry, [quote]);
  }
  return [...byExpiry.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([expiry, bucket]) => ({
      expiry,
      daysToExpiry: calendarDaysBetween(valuationDate, expiry),
      contracts: bucket.length,
      atmIv: atmIvFor(bucket, bucket.reduce((sum, q) => sum + q.strike, 0) / Math.max(1, bucket.length)),
    }));
}

/** 保留 `expiries` 指定的到期日，否则取最近 `maxExpiries` 个。 */
function selectExpiries(
  groups: readonly OptionExpiryGroup[],
  requested: string[] | undefined,
  maxExpiries: number,
): { selected: OptionExpiryGroup[]; unmatched: string[] } {
  if (requested && requested.length > 0) {
    const wanted = new Set(requested.map((value) => datePart(String(value))));
    const selected = groups.filter((group) => wanted.has(group.expiry));
    const present = new Set(selected.map((group) => group.expiry));
    return { selected, unmatched: [...wanted].filter((expiry) => !present.has(expiry)) };
  }
  return { selected: groups.slice(0, Math.max(1, maxExpiries)), unmatched: [] };
}

/** `YYYY-MM-DD` → `YYYY-MM-DDT20:00:00.000Z`（美股收盘时点的近似，仅用于剩余天数计算）。 */
function usAsOf(lastTradeDate: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})$/.exec(lastTradeDate);
  if (!match) return new Date().toISOString();
  return `${match[1]}T20:00:00.000Z`;
}

/** 报告日 16:00 HKT = 08:00 UTC。 */
function hkAsOf(reportDate: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})$/.exec(reportDate);
  if (!match) return new Date().toISOString();
  return `${match[1]}T08:00:00.000Z`;
}

async function buildUsSnapshot(input: OptionChainRequest): Promise<OptionChainSnapshot> {
  const symbol = String(input.code ?? '').trim().toUpperCase();
  if (!symbol) throw new OptionChainUnavailableError('缺少美股标的代码', 'unsupported');

  const entry = await fetchCboePayload(symbol, input.forceRefresh === true);
  const payload = entry.payload;
  const data = payload.data ?? {};
  const warnings: string[] = [];

  const lastTradeRaw = typeof data.last_trade_time === 'string' ? data.last_trade_time : '';
  const valuationDate = datePart(lastTradeRaw) || localDate();
  const asOf = usAsOf(valuationDate);

  const close = finiteOrZero(data.close);
  const currentPrice = finiteOrZero(data.current_price);
  const underlyingPrice = finiteOrZero(input.underlyingPrice) || currentPrice || close;

  const multiplier = US_OPTION_MULTIPLIER;
  const raw = cboeOptionsOf(payload);
  const quotes: OptionQuote[] = [];
  let unparsed = 0;
  let ivMissing = 0;
  for (const item of raw) {
    const quote = parseCboeOptionQuote(item, multiplier);
    if (!quote) {
      unparsed += 1;
      continue;
    }
    if (!(quote.iv > 0)) ivMissing += 1;
    quotes.push(quote);
  }

  warnings.push(
    `CBOE 延迟行情（delayed quotes）；响应体未标注延迟时长，因此这里也不声称具体延迟分钟数。数据时点 ${valuationDate}（CBOE data.last_trade_time）。`,
  );
  if (input.underlyingPrice === undefined && !(currentPrice > 0) && close > 0) {
    warnings.push(`CBOE 未给出 current_price，标的现价退化为上一交易日收盘价 ${close}。`);
  }
  if (raw.length === 0) {
    warnings.push('CBOE 返回了空的 options[]（该标的可能没有上市期权）；不要编造任何合约。');
  }
  if (unparsed > 0) {
    warnings.push(`${unparsed} 条 OCC 代码无法解析，已跳过（OCC 码长度 17/18/19 不定，含点代码会丢点）。`);
  }
  if (ivMissing > 0) {
    warnings.push(`${ivMissing}/${raw.length} 条合约上游未给出 IV（iv=0），这些合约不参与波动率相关判断。`);
  }
  if (entry.ms > CBOE_TIMEOUT_HINT_MS) {
    warnings.push(
      `CBOE 本次请求耗时 ${entry.ms} ms（实测 CDN 连通性差、成功率约 40–50%，单请求 13s–194s 都出现过）。`,
    );
  }

  const groups = groupExpiries(quotes, valuationDate).map((group) => ({
    ...group,
    atmIv: atmIvFor(
      quotes.filter((quote) => quote.expiry === group.expiry),
      underlyingPrice,
    ),
  }));
  const selected = selectExpiries(groups, input.expiries, input.maxExpiries ?? DEFAULT_MAX_EXPIRIES);
  if (selected.unmatched.length > 0) {
    warnings.push(
      `请求的到期日 ${selected.unmatched.join('、')} 不在 ${symbol} 的期权链上，已被忽略；链上实际有 ${groups.length} 个到期日。`,
    );
  }
  const kept = new Set(selected.selected.map((group) => group.expiry));

  return {
    market: 'US',
    code: symbol,
    name: input.name?.trim() || String(data.symbol ?? symbol),
    underlyingPrice: round4(underlyingPrice),
    currency: 'USD',
    asOf,
    delayed: true,
    source: `CBOE 延迟期权链 cdn.cboe.com/api/global/delayed_quotes/options/${symbol}.json`,
    expiries: selected.selected,
    quotes: quotes.filter((quote) => kept.has(quote.expiry)),
    warnings,
  };
}

async function buildHkSnapshot(input: OptionChainRequest): Promise<OptionChainSnapshot> {
  const stockCode = normalizeHkStockCode(input.code);
  if (!stockCode) throw new OptionChainUnavailableError('缺少港股标的代码（需要 5 位港股代码，如 00700）', 'unsupported');

  const warnings: string[] = [];
  const handle = await resolveHkexReport(input.forceRefresh === true);
  if (!handle) {
    throw new OptionChainUnavailableError(
      `最近 ${HKEX_REPORT_MAX_LOOKBACK_DAYS} 个自然日内没有可用的 HKEX 股票期权日报（可能连续长假）；已试过的都是 HTTP 404。`,
      'non_trading_day',
    );
  }

  if (handle.stalenessDays > 0) {
    warnings.push(
      `HKEX 最新可用日报是 ${handle.date}（距今天 ${handle.stalenessDays} 天，今天/近几日为非交易日或尚未出报告）。`,
    );
  }

  const summary = hkexSummaryFor(handle, input.forceRefresh === true);
  const picked = pickHkatsForStockCode(summary, stockCode);
  if (!picked) {
    throw new OptionChainUnavailableError(
      `HKEX ${handle.date} 的股票期权日报里没有 ${stockCode}（该标的可能没有股票期权）。`,
      'not_listed',
    );
  }
  if (picked.ambiguous.length > 1) {
    warnings.push(
      `${stockCode} 在 HKEX 报告里对应多个期权代码（${picked.ambiguous.join('、')}，属于调整系列）；已按成交+未平仓取最大者 ${picked.row.hkats}。`,
    );
  }

  const section = hkexSectionFor(handle, picked.row.hkats, input.forceRefresh === true);
  if (!section) {
    throw new OptionChainUnavailableError(
      `HKEX ${handle.date} 报告里找不到 ${picked.row.hkats} 的明细段落。`,
      'upstream_failed',
    );
  }

  const { multiplier, verified } = optionMultiplier('HK', stockCode);
  if (!verified) {
    warnings.push(
      `${stockCode} 的港股合约乘数未核对（HKEX 各类别差异极大，实测跨度 20–20,000 股/张），` +
        `已按 ${HK_OPTION_MULTIPLIER_FALLBACK} 股/张回退估算；权利金收入与担保额都可能偏差。请以券商合约规格为准。`,
    );
  }

  const valuationDate = handle.date;
  const asOf = hkAsOf(valuationDate);
  const underlyingPrice = finiteOrZero(input.underlyingPrice) || section.heading.underlyingClose;

  const quotes: OptionQuote[] = [];
  let ivMissing = 0;
  for (const row of section.rows) {
    if (!row.expiry) continue;
    if (!(row.ivPct > 0)) ivMissing += 1;
    quotes.push({
      // 形态与 OptionQuote 的示例一致：TCH-20251017-620-C
      code: `${section.heading.hkats}-${row.expiry.replace(/-/g, '')}-${row.strike}-${row.type === 'call' ? 'C' : 'P'}`,
      type: row.type,
      strike: row.strike,
      expiry: row.expiry,
      // 实测：HKEX 日报只有 开市/最高/最低/结算价，**没有 bid/ask/last 列**
      //（全文件 grep 不到 BID/ASK/LAST）。0 = 「上游未给出」，绝不编造价差。
      bid: 0,
      ask: 0,
      last: 0,
      settlement: row.settlement,
      iv: row.ivPct > 0 ? round4(row.ivPct / 100) : 0,
      delta: 0,
      openInterest: row.openInterest,
      volume: row.volume,
      multiplier,
      mid: 0,
      spreadPct: 0,
    });
  }

  warnings.push(
    `HKEX 每日收市报告口径（${handle.date}，16:00 HKT 收市价）：这是日终数据，盘中没有更新。`,
  );
  warnings.push(
    'HKEX 日报不提供期权买卖报价，bid/ask/last 一律为 0（不是「零价差」）；因此无法核实成交价差与流动性，权利金请以结算价 settlement 作参考并以券商报价为准。',
  );
  warnings.push(
    'HKEX 日报不提供希腊字母（delta/gamma/vega/theta），delta 一律为 0 = 未知；本模块不会自算 delta 冒充上游值（被行权概率的估算在服务层完成并标注为估算）。',
  );
  warnings.push('港股 IV 由 HKEX 只对部分系列给出（iv=0 = 上游未给出），本模块把 IV% 除以 100 转成小数。');
  if (ivMissing > 0) {
    warnings.push(`${ivMissing}/${section.rows.length} 条港股合约上游未给出 IV（iv=0）。`);
  }
  if (!(underlyingPrice > 0)) {
    warnings.push('HKEX 报告的 CLOSING PRICE 取不到，标的现价为 0。');
  }
  warnings.push(
    `本次读取的报告 ${handle.bytes} bytes、下载耗时 ${handle.ms} ms（同一天只下载一次，后续调用走内存缓存并按 <A NAME="{HKATS}"> 抽取段落）。`,
  );

  const productIv = picked.row.ivPct > 0 ? round4(picked.row.ivPct / 100) : 0;
  const groups = groupExpiries(quotes, valuationDate).map((group) => ({
    ...group,
    atmIv: atmIvFor(
      quotes.filter((quote) => quote.expiry === group.expiry),
      underlyingPrice,
    ) || productIv,
  }));
  const selected = selectExpiries(groups, input.expiries, input.maxExpiries ?? DEFAULT_MAX_EXPIRIES);
  if (selected.unmatched.length > 0) {
    warnings.push(
      `请求的到期日 ${selected.unmatched.join('、')} 不在 ${stockCode} 的期权链上，已被忽略；链上实际有 ${groups.length} 个到期日。`,
    );
  }
  const kept = new Set(selected.selected.map((group) => group.expiry));

  return {
    market: 'HK',
    code: stockCode,
    name: input.name?.trim() || section.heading.name || picked.row.name,
    underlyingPrice: round4(underlyingPrice),
    currency: 'HKD',
    asOf,
    delayed: true,
    source: `HKEX 每日收市报告 dqe${isoToYyMmDd(handle.date)}.htm（STOCK OPTIONS DAILY MARKET REPORT AS AT ${handle.date}）`,
    expiries: selected.selected,
    quotes: quotes.filter((quote) => kept.has(quote.expiry)),
    warnings,
  };
}

/* ══════════════════════════════ public API ═════════════════════════════════ */

/**
 * 取期权链快照（美股 = CBOE 延迟行情；港股 = HKEX 每日收市报告）。
 *
 * 失败绝不静默：上游不可用时抛 `OptionChainUnavailableError`（上层 `services/options.ts`
 * 会把它变成 502 或 warning），**不用 0/假报价填充**。
 */
export async function optionChain(input: OptionChainRequest): Promise<OptionChainSnapshot> {
  if (!input || (input.market !== 'HK' && input.market !== 'US')) {
    throw new OptionChainUnavailableError(`不支持的期权市场：${String(input?.market)}`, 'unsupported');
  }
  if (input.market === 'US') return buildUsSnapshot(input);
  return buildHkSnapshot(input);
}

/**
 * 合约乘数（每张对应的标的股数）。
 *
 * 美股恒为 OCC 标准 100 股/张。港股查 `HK_OPTION_MULTIPLIERS`（只放已核对官方
 * 合约规格的标的）；未命中 → `HK_OPTION_MULTIPLIER_FALLBACK` 且 `verified=false`，
 * 调用方**必须**把这件事写进 warnings，不允许静默用一个可能错的乘数算钱。
 */
export function optionMultiplier(market: OptionMarket, code: string): { multiplier: number; verified: boolean } {
  if (market === 'US') return { multiplier: US_OPTION_MULTIPLIER, verified: true };
  const key = hkMultiplierKey(code);
  const hit = key ? HK_OPTION_MULTIPLIERS[key] : undefined;
  if (typeof hit === 'number' && Number.isFinite(hit) && hit > 0) return { multiplier: hit, verified: true };
  return { multiplier: HK_OPTION_MULTIPLIER_FALLBACK, verified: false };
}

/**
 * 港股到期日参考价：读指定日期那一份 HKEX 报告里的 `CLOSING PRICE HK$`。
 *
 * 取不到（非交易日 / 该标的没有期权）返回 `null`。
 */
export async function hkUnderlyingClose(input: {
  code: string;
  date: string;
}): Promise<{ price: number; source: string } | null> {
  const stockCode = normalizeHkStockCode(input?.code ?? '');
  const iso = datePart(String(input?.date ?? ''));
  if (!stockCode || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;

  const entry = await fetchHkexReport(iso, false);
  if (!entry.text) return null;
  const handle: HkexReportHandle = {
    date: iso,
    text: entry.text,
    bytes: entry.bytes,
    ms: entry.ms,
    stalenessDays: 0,
  };
  const picked = pickHkatsForStockCode(hkexSummaryFor(handle, false), stockCode);
  if (!picked) return null;
  const section = hkexSectionFor(handle, picked.row.hkats, false);
  if (!section || !(section.heading.underlyingClose > 0)) return null;
  return {
    price: section.heading.underlyingClose,
    source: `HKEX dqe${isoToYyMmDd(iso)}.htm CLOSING PRICE HK$（${picked.row.hkats} ${section.heading.name}）`,
  };
}

/** 诊断用：把错误转成一句可读文案（上层拼 warning 用）。 */
export function describeOptionError(error: unknown): string {
  if (error instanceof OptionChainUnavailableError) return error.message;
  return errorMessage(error);
}