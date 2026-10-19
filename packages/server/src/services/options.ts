/**
 * 期权卖权服务 —— 确定性指标 / 候选筛选 / 建议方案 / 确认落库 / 买平 / 持仓视图。
 *
 * 三条硬规则（用户诉求直接落成代码约束）：
 *  1. **钱相关的数字一律服务端算**：权利金收入、静态/年化收益率、担保额、安全垫、
 *     被行权概率、流动性分全部由本文件按快照机械算出（可复算、幂等）。AI 与前端
 *     只能引用，不能改写 —— 与「预算上限由系统校验」同一思路。
 *  2. **安全落成可校验的门槛**：覆盖式卖 Call 必须真有那么多股（乘数 × 张数 ≤ 持股），
 *     现金担保卖 Put 必须真有那么多现金（行权价 × 乘数 × 张数 ≤ 可用现金）；门槛在
 *     筛选（screenOptionCandidates）与确认（confirmOptionAdvice）两处都执行，后者不信前端。
 *  3. **不确定就明说**：上游缺 delta / IV / 买卖价 / 现价时，绝不用 0 冒充「没有风险」，
 *     一律把口径写进 warnings（调用方原样展示）。
 *
 * 口径定义（与 @aia/shared 的 OptionCandidateMetrics 注释一致，必须成对维护）：
 *  - premiumIncome   = 每股价权利金 × 乘数 × 张数 − 费用。
 *  - collateral      = 覆盖式卖 Call：标的现价 × 乘数 × 张数（占用的是持股的市值）；
 *                      现金担保卖 Put：行权价 × 乘数 × 张数（占用的是现金，真会被划走）。
 *  - staticYieldPct  = premiumIncome / collateral × 100（collateral = 0 时返回 0 + warning）。
 *  - annualizedYieldPct = staticYieldPct × 365 / 剩余自然日；剩余 ≤ 0 时年化没有意义，
 *    返回 0 + warning，**绝不**用 max(1, 剩余) 硬除 —— 那会把「已到期」算成天文数字。
 *  - downsideProtectionPct（安全垫）：正数 = 虚值（对卖方安全）。
 *      卖 Call = (行权价 − 现价) / 现价 × 100；卖 Put = (现价 − 行权价) / 现价 × 100。
 *  - breakeven：卖 Call = 行权价 + 每股价权利金；卖 Put = 行权价 − 每股价权利金。
 *  - assignmentProbability：美股 = |delta|（上游给 0 表示**未知**，按 0 返回并 warning）；
 *      港股上游不提供 delta，用「虚值幅度 + IV」做正态近似 N(-d2) 并**明确标注为估算**。
 *  - liquidityScore：买卖价差 40 分 + 未平仓 30 分 + 成交量 30 分，规则写死在
 *      `optionLiquidityScore` 里（价差缺失时该档 0 分并 warning，不给高分）。
 *
 * 依赖说明：期权链/港股收市价来自 `datasources/options.ts`（task-5 实现）。该模块尚未落地时
 * 通过下方 `loadOptionDatasource` 的**惰性桥**降级（与 db/util.ts 的 loadMarketBridge 同一范式）：
 * 上层拿到 null 就按「数据不可用」处理并给明确错误/警告，绝不编造合约与价格。
 *
 * Owner: server-core（期权卖权）。
 */
import crypto from 'node:crypto';

import {
  HK_OPTION_MULTIPLIER_FALLBACK,
  HK_OPTION_MULTIPLIERS,
  MARKET_CURRENCY,
  OPTION_SCREEN_RULES,
  OPTION_SETTLEMENT_RULES,
  US_OPTION_MULTIPLIER,
  type ConfirmOptionAdviceInput,
  type OptionAdvicePlan,
  type OptionCandidate,
  type OptionCandidateMetrics,
  type OptionChainSnapshot,
  type OptionCollateralKind,
  type OptionMarket,
  type OptionPortfolioSummary,
  type OptionPosition,
  type OptionPositionsResponse,
  type OptionQuote,
  type OptionSettlement,
  type OptionSettlementsResponse,
  type OptionSettlementStatus,
  type OptionStrategy,
  type OptionType,
} from '@aia/shared';

import { badRequest, conflict, notFound, upstreamError } from '../errors.js';
import { getRepo } from '../registry.js';
import type { Repo } from '../types/repo.js';
import type { AdviceRow, AssetRow, OptionContractRow, OptionSettlementRow } from '../types/models.js';
import { isOffline, localDate, nowIso, round4, toNumber } from '../db/util.js';
import { computePosition } from './portfolio.js';
import { getQuote } from '../datasources/registry.js';
import { optionChain, optionMultiplier, type OptionChainRequest } from '../datasources/options.js';

/* ─────────────────────────────── 日期 / 小工具 ────────────────────────────── */

const MS_PER_DAY = 86_400_000;

/**
 * 两个 `YYYY-MM-DD` 之间的自然日（`to − from`）。
 *
 * 用 UTC 零点做减法而不是本地时间：本地时间在夏令时/时区偏移变化时会出现 23h/25h 的天，
 * 年化收益率的小数位就会漂。
 */
export function calendarDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / MS_PER_DAY);
}

/** `YYYY-MM-DD`（或 ISO 8601 时间戳）中的日期部分；解析不了返回 `fallback`。 */
export function datePart(value: string, fallback = localDate()): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? ''));
  return match ? match[1]! : fallback;
}

/** 今天 → 到期日的自然日（已过期为负数）。 */
export function daysToExpiry(expiry: string, today: string = localDate()): number {
  return calendarDaysBetween(today, datePart(expiry, today));
}

/** 卖权策略 → 期权方向（covered_call 只能卖 call，cash_secured_put 只能卖 put）。 */
export function optionTypeForStrategy(strategy: OptionStrategy): OptionType {
  return strategy === 'covered_call' ? 'call' : 'put';
}

export function collateralKindForStrategy(strategy: OptionStrategy): OptionCollateralKind {
  return strategy === 'covered_call' ? 'shares' : 'cash';
}

/** 去重但保留顺序（warnings 要给用户看，不能重复刷屏）。 */
function dedupeWarnings(warnings: string[]): string[] {
  return [...new Set(warnings.filter((warning) => typeof warning === 'string' && warning.trim() !== ''))];
}

/** 标准正态分布 CDF（Abramowitz-Stegun 7.1.26，最大误差 1.5e-7）：给港股估算被行权概率用。 */
function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/* ───────────────────────────── 报价 → 权利金/乘数 ─────────────────────────── */

/** 卖方实际能拿到的每股价权利金：买价（bid）优先，缺失时才降级并告警。 */
export interface PremiumPick {
  /** 每股价权利金（0 = 没有任何有效报价）。 */
  price: number;
  /**
   * 口径：`bid` 买价 / `mid` 中间价 / `last` 最新成交价 /
   * `settlement` 结算价（港股 HKEX 每日结算价、美股 CBOE 理论价）/ `none` 无报价。
   */
  source: 'bid' | 'mid' | 'last' | 'settlement' | 'none';
}

/**
 * 取「能成交」的权利金。
 *
 * 为什么优先 bid：卖出开仓是**以买价成交**的，用 ask/mid 会让收益率偏高、把不安全
 * 的合约算得很划算。只有上游没给买价时才逐级降级，并写清「实际成交可能更低」。
 *
 * 为什么最后才退到 `settlement`：港交所每日报告**只给结算价**（没有买卖盘，实测），
 * 退到这一档时必须明说「这是 EOD 结算价估算，实际成交以券商报盘为准」，不能当成实时买价。
 */
export function pickSellPremium(quote: OptionQuote, warnings: string[] = []): PremiumPick {
  const bid = toNumber(quote.bid);
  if (bid > 0) return { price: round4(bid), source: 'bid' };
  const mid = toNumber(quote.mid);
  if (mid > 0) {
    warnings.push(
      `${quote.code} 买价缺失（bid=0），权利金按中间价 ${round4(mid)} 估算；实际成交可能更低，收益率会偏高。`,
    );
    return { price: round4(mid), source: 'mid' };
  }
  const last = toNumber(quote.last);
  if (last > 0) {
    warnings.push(
      `${quote.code} 买卖价均缺失（bid/ask=0），权利金按最新成交价 ${round4(last)} 估算；该合约的成交能力无法核实。`,
    );
    return { price: round4(last), source: 'last' };
  }
  const settlement = toNumber(quote.settlement);
  if (settlement > 0) {
    warnings.push(
      `${quote.code} 上游无买卖盘（bid/ask=0；港交所每日报告只提供结算价），` +
        `权利金按结算价 ${round4(settlement)} 估算；这是 EOD 口径，实际成交价以券商报盘为准，收益率会偏差。`,
    );
    return { price: round4(settlement), source: 'settlement' };
  }
  warnings.push(`${quote.code} 没有任何有效报价（bid/mid/last/settlement 均为 0），权利金收入无法计算，不可作为候选。`);
  return { price: 0, source: 'none' };
}

/**
 * IV 缺失时用「同到期日的平值 IV」兜底。
 *
 * 港股只有平值系列带 IV（实测），合约级 IV=0 表示**上游未提供**，不是「0% 波动」——
 * 代入公式会得出「被行权概率≈0」这种假结论。有平值 IV 时用同到期平值 IV 估算（并标注为估算），
 * 完全没有 IV 时保持 0 并明说「未知」。
 */
export function withFallbackIv(
  quote: OptionQuote,
  snapshot: OptionChainSnapshot,
  warnings: string[] = [],
): OptionQuote {
  if (toNumber(quote.iv) > 0) return quote;
  const group = snapshot.expiries.find((entry) => entry.expiry === datePart(quote.expiry));
  const atmIv = toNumber(group?.atmIv);
  if (atmIv > 0) {
    warnings.push(
      `${quote.code} 合约 IV 未提供（港股仅平值系列有 IV），用同到期日（${datePart(quote.expiry)}）平值 IV ` +
        `${round4(atmIv * 100)}% 估算；波动率与被行权概率都是估算值。`,
    );
    return { ...quote, iv: atmIv };
  }
  warnings.push(
    `${quote.code} 上游未提供 IV（0 = 未提供，不是「0% 波动」）：波动率与（港股）被行权概率为未知。`,
  );
  return quote;
}

/**
 * 合约乘数：以期权链给的为准；缺失时向数据源要（港股未核对会回退 100 并 `verified=false`），
 * 并**明确告警**（绝不静默用可能错的乘数算钱）。
 */
export function resolveOptionMultiplier(
  market: OptionMarket,
  quote: OptionQuote,
  warnings: string[] = [],
  underlyingCode = '',
): number {
  const fromChain = toNumber(quote.multiplier);
  if (fromChain > 0) return fromChain;
  if (underlyingCode) {
    const info = optionMultiplier(market, underlyingCode);
    warnings.push(
      `${quote.code} 上游未给出合约乘数，按 ${info.multiplier} 股/张估算（${
        info.verified
          ? '已核对的合约规格'
          : `标的 ${underlyingCode} 的乘数未经核对，必须以券商合约规格为准`
      }）；权利金收入与担保额都会随之偏差。`,
    );
    return info.multiplier;
  }
  const fallback = market === 'US' ? US_OPTION_MULTIPLIER : HK_OPTION_MULTIPLIER_FALLBACK;
  warnings.push(
    `${quote.code} 上游未给出合约乘数，按 ${fallback} 股/张估算（${
      market === 'US' ? '美股 OCC 标准合约' : '港股乘数各标的不同，必须以券商合约规格为准'
    }）；权利金收入与担保额都会随之偏差。`,
  );
  return fallback;
}

/**
 * 港股合约乘数的告警文案（没有问题时返回 null）。覆盖两种情况：
 *
 * 1. **未经核对**：代码不在 `HK_OPTION_MULTIPLIERS` 里、且用的是回退值 100。
 * 2. **与官方规格不一致**（OBS1）：代码已登记核对值，但**合约行上的乘数与它不等**
 *    （例如历史数据 / 手工录入 / 导入的行写的是 100，而官方是 500）。
 *    这种不一致以前完全静默：结算会按合约行的 100 股交割，用户看不到任何提示。
 *    现在一律告警，但**金额与股数仍按合约行计算**（不擅自改写用户数据）。
 *
 * 为什么单独抽出来：乘数错了，**权利金收入、担保额、行权要交付的股数**三个数字同时错，
 * 而这三处分别写在建议方案、确认后的合约、到期结算记录里。三处都必须带上这条 warning，
 * 才能让用户在每一个界面上都知道「这个乘数有问题」。
 * 港股乘数 ≠ 每手股数（实测：9988/1810/3690 是每手的 5 倍），查不到的标的一律回退 100。
 */
export function unverifiedHkMultiplierWarning(
  market: OptionMarket,
  code: string,
  multiplier: number,
): string | null {
  if (market !== 'HK') return null;
  const key = String(code ?? '').replace(/^0+/, '');
  if (!key) return null;
  const actual = toNumber(multiplier);
  const registered = Object.prototype.hasOwnProperty.call(HK_OPTION_MULTIPLIERS, key)
    ? HK_OPTION_MULTIPLIERS[key]
    : undefined;
  if (typeof registered === 'number' && Number.isFinite(registered) && registered > 0) {
    if (actual > 0 && actual !== registered) {
      return (
        `合约行乘数 ${actual} 与港股 ${code} 的官方合约规格 ${registered} 股/张不一致，请核对券商合约规格；` +
        '金额与交割股数仍按合约行计算，但若合约行有误，权利金收入、担保额与行权交割股数会同时偏差'
      );
    }
    return null;
  }
  if (actual !== HK_OPTION_MULTIPLIER_FALLBACK) return null;
  return (
    `港股 ${code} 的合约乘数未经核对，按 ${HK_OPTION_MULTIPLIER_FALLBACK} 股/张估算；` +
    '权利金收入、担保额与行权交割股数都可能偏差，请以券商合约规格为准'
  );
}

/* ─────────────────────────────── 被行权概率 ──────────────────────────────── */

export interface AssignmentProbabilityInput {
  market: OptionMarket;
  strategy: OptionStrategy;
  quote: OptionQuote;
  underlyingPrice: number;
  daysToExpiry: number;
}

export interface AssignmentProbabilityResult {
  /** 0-1；0 表示「未知/无法估算」，调用方必须看 `estimated` 与 warnings。 */
  probability: number;
  /** true = 港股正态近似（不是上游 delta，界面必须标注「估算」）。 */
  estimated: boolean;
  /** 为什么是 0（未知）：给 warnings 用。 */
  unknownReason: string | null;
}

/**
 * 被行权概率代理。
 *
 *  - 美股：|delta|（卖 Call/Put 的 delta 符号相反，取绝对值）；上游给 0 = 未知。
 *  - 港股：HKEX 每日报告不提供希腊字母，这里用「虚值幅度 + IV + 剩余期限」做
 *    正态近似：d2 = (ln(S/K) − σ²T/2) / (σ√T)，Call = N(d2)、Put = N(−d2)。
 *    这是**估算**，`estimated=true` + warning 文案会一路带到界面与 AI 提示词。
 */
export function assignmentProbability(input: AssignmentProbabilityInput): AssignmentProbabilityResult {
  const { market, strategy, quote, underlyingPrice, daysToExpiry: dte } = input;
  const delta = toNumber(quote.delta);
  if (market === 'US') {
    if (Math.abs(delta) > 0) return { probability: round4(Math.abs(delta)), estimated: false, unknownReason: null };
    return {
      probability: 0,
      estimated: false,
      unknownReason: '上游未提供 delta，被行权概率按 0（未知）处理 —— 这不等于「没有风险」。',
    };
  }

  const iv = toNumber(quote.iv);
  const strike = toNumber(quote.strike);
  if (!(iv > 0)) {
    return {
      probability: 0,
      estimated: true,
      unknownReason:
        '港股无 delta 上游且未给出 IV，无法估算被行权概率（按 0 表示未知；不是「没有风险」）。',
    };
  }
  if (!(strike > 0) || !(underlyingPrice > 0) || dte <= 0) {
    return {
      probability: 0,
      estimated: true,
      unknownReason: '缺少标的现价/行权价或合约已到期，无法估算港股被行权概率（按 0 表示未知）。',
    };
  }
  const sigma = iv;
  const t = dte / 365;
  const vol = sigma * Math.sqrt(t);
  if (!(vol > 0)) {
    return { probability: 0, estimated: true, unknownReason: '波动率口径异常，无法估算被行权概率。' };
  }
  const d2 = (Math.log(underlyingPrice / strike) - 0.5 * sigma * sigma * t) / vol;
  const raw = strategy === 'covered_call' ? normalCdf(d2) : normalCdf(-d2);
  return { probability: round4(Math.min(1, Math.max(0, raw))), estimated: true, unknownReason: null };
}

/* ─────────────────────────────── 流动性评分 ──────────────────────────────── */

/**
 * 流动性评分 0-100（规则写死，便于复算与展示）：
 *  - 买卖价差 40 分：spreadPct ≤ 5% 满分；线性衰减到 `OPTION_SCREEN_RULES.maxSpreadPct`(20%) 为 0；
 *    价差缺失（bid/ask=0，spreadPct=0）→ 这一档 0 分并 warning（「无法核实成交能力」≠ 满分）。
 *  - 未平仓 30 分：openInterest ≥ 1000 满分，线性到 0。
 *  - 成交量 30 分：volume ≥ 500 满分，线性到 0。
 */
export function optionLiquidityScore(quote: OptionQuote, warnings: string[] = []): number {
  const spreadPct = toNumber(quote.spreadPct);
  const hasTwoSidedQuote = toNumber(quote.bid) > 0 && toNumber(quote.ask) > 0;
  let spreadScore = 0;
  if (hasTwoSidedQuote && spreadPct > 0) {
    const full = 5;
    const cap = OPTION_SCREEN_RULES.maxSpreadPct;
    spreadScore = spreadPct <= full ? 40 : Math.max(0, 40 * (1 - (spreadPct - full) / Math.max(1e-9, cap - full)));
  } else {
    warnings.push(
      `${quote.code} 买卖价缺失（bid/ask=0；港交所每日报告不提供买卖盘），` +
        '流动性评分只按未平仓与成交量计算，不按「零价差」给满分。',
    );
  }
  const oiScore = 30 * Math.min(1, Math.max(0, toNumber(quote.openInterest)) / 1000);
  const volumeScore = 30 * Math.min(1, Math.max(0, toNumber(quote.volume)) / 500);
  return Math.round(Math.min(100, Math.max(0, spreadScore + oiScore + volumeScore)));
}

/* ─────────────────────────────── 确定性指标 ──────────────────────────────── */

export interface OptionCandidateMetricInput {
  market: OptionMarket;
  code: string;
  strategy: OptionStrategy;
  quote: OptionQuote;
  underlyingPrice: number;
  contracts: number;
  fee?: number;
}

/** 指标 + 计算过程里用到的中间量（筛选与方案需要复用，不必重复推导）。 */
export interface OptionCandidateMetricsDetail {
  metrics: OptionCandidateMetrics;
  /** 参与计算的每股价权利金与其口径。 */
  premium: PremiumPick;
  multiplier: number;
  daysToExpiry: number;
  probability: AssignmentProbabilityResult;
}

/**
 * 指标的唯一计算入口（`optionCandidateMetrics` 是它的无副作用包装）。
 *
 * `warnings` 是调用方的收集器：指标本身没有 warnings 字段（契约冻结），但所有对外路径
 * （筛选结果 / 建议方案 / 持仓视图）都必须把「数据缺口」原样带给用户。
 */
export function optionCandidateMetricsDetail(
  input: OptionCandidateMetricInput,
  warnings: string[] = [],
): OptionCandidateMetricsDetail {
  const { market, strategy, quote, underlyingPrice } = input;
  const strike = toNumber(quote.strike);
  const underlying = toNumber(underlyingPrice);

  // 张数必须是正整数：这里不做「静默截断」，无效时按 0 张计算并告警（写库路径会直接拒绝）。
  const contracts = Number.isInteger(input.contracts) && input.contracts > 0 ? input.contracts : 0;
  if (contracts === 0) {
    warnings.push(`建议张数必须是正整数（收到 ${input.contracts}），无法计算权利金与担保。`);
  }
  const fee = Math.max(0, toNumber(input.fee));
  const multiplier = resolveOptionMultiplier(market, quote, warnings, input.code);
  const shares = multiplier * contracts;
  const premium = pickSellPremium(quote, warnings);
  const premiumIncome = round4(premium.price * shares - fee);

  // 担保额：卖 Call 占用持股市值（被行权就是交出这些股票），卖 Put 占用现金（行权价 × 乘数 × 张数）。
  const collateral =
    strategy === 'covered_call' ? round4(underlying * shares) : round4(strike * shares);
  if (strategy === 'covered_call' && !(underlying > 0)) {
    warnings.push('标的现价缺失（0），无法计算覆盖式卖 Call 的担保额（持股市值），静态收益率按 0 处理。');
  }
  if (!(collateral > 0)) {
    if (strategy === 'cash_secured_put') {
      warnings.push('担保额（行权价 × 乘数 × 张数）为 0，无法计算静态收益率。');
    }
  }
  const staticYieldPct = collateral > 0 ? round4((premiumIncome / collateral) * 100) : 0;

  const dte = daysToExpiry(quote.expiry);
  let annualizedYieldPct = 0;
  if (collateral <= 0) {
    annualizedYieldPct = 0;
  } else if (dte > 0) {
    annualizedYieldPct = round4((staticYieldPct * 365) / dte);
  } else {
    // 已到期/今日到期：年化没有意义，返回 0 而不是除零或负数。
    warnings.push(`合约 ${quote.code} 剩余自然日 ${dte}（≤0），年化收益率按 0 处理。`);
  }

  // 安全垫：正 = 虚值（对卖方安全）。两个方向都取「离行权价还有多远」。
  let downsideProtectionPct = 0;
  if (underlying > 0) {
    downsideProtectionPct = round4(
      strategy === 'covered_call' ? ((strike - underlying) / underlying) * 100 : ((underlying - strike) / underlying) * 100,
    );
  } else {
    warnings.push('标的现价缺失（0），安全垫按 0 处理（无法判断虚值幅度）。');
  }

  const probability = assignmentProbability({
    market,
    strategy,
    quote,
    underlyingPrice: underlying,
    daysToExpiry: dte,
  });
  if (probability.unknownReason) warnings.push(probability.unknownReason);
  if (probability.estimated && probability.probability > 0) {
    warnings.push(
      `港股无 delta 上游，被行权概率为估算（正态近似 N(-d2)，IV=${round4(toNumber(quote.iv) * 100)}%，剩余 ${dte} 天）；` +
        '估算值不能当作券商/交易所口径。',
    );
  }

  const breakeven = round4(strategy === 'covered_call' ? strike + premium.price : strike - premium.price);

  const metrics: OptionCandidateMetrics = {
    premiumIncome,
    staticYieldPct,
    annualizedYieldPct,
    downsideProtectionPct,
    collateral,
    collateralKind: collateralKindForStrategy(strategy),
    maxProfit: premiumIncome,
    breakeven,
    assignmentProbability: probability.probability,
    liquidityScore: optionLiquidityScore(quote, warnings),
    requiredShares: strategy === 'covered_call' ? shares : 0,
  };
  return { metrics, premium, multiplier, daysToExpiry: dte, probability };
}

/**
 * 一个候选合约的确定性指标（冻结签名）。
 *
 * 纯函数：同样的快照 + 同样的张数必然得到同样的数字。第二个可选参数只是「告警收集器」，
 * 不传时告警被丢弃（调用方若需要展示数据缺口，请用 `screenOptionCandidates` /
 * `buildOptionAdvicePlan`，它们会把 warnings 带回给调用方）。
 */
export function optionCandidateMetrics(
  input: OptionCandidateMetricInput,
  warnings: string[] = [],
): OptionCandidateMetrics {
  return optionCandidateMetricsDetail(input, warnings).metrics;
}

/* ─────────────────────────────── 候选筛选 ────────────────────────────────── */

export interface OptionScreenInput {
  snapshot: OptionChainSnapshot;
  strategy: OptionStrategy;
  contracts: number;
  /** 覆盖式卖 Call 的真实持股数（服务端从「我的资产」读，不信调用方声明）。 */
  heldShares?: number;
  /** 现金担保卖 Put 在该市场的可用现金（设置页填写；0 = 未填写）。 */
  availableCash?: number;
}

export interface OptionScreenResult {
  candidates: OptionCandidate[];
  /** 被挡掉的合约 + 机器可读原因（`code: 说明`，前缀稳定，界面可展开解释）。 */
  rejected: { code: string; reason: string }[];
  warnings: string[];
}

/** 被过滤原因的前缀（机器可读，测试与前端文案都依赖它，改动要同步）。 */
export const OPTION_REJECT_REASONS = {
  dteTooShort: 'dte_too_short',
  dteTooLong: 'dte_too_long',
  noQuote: 'no_quote',
  premiumTooThin: 'premium_too_thin',
  openInterestTooLow: 'open_interest_too_low',
  spreadMissing: 'spread_missing',
  spreadTooWide: 'spread_too_wide',
  deltaMissing: 'delta_missing',
  ivMissing: 'iv_missing',
  probabilityTooHigh: 'assignment_probability_too_high',
  probabilityTooLow: 'assignment_probability_too_low',
  insufficientShares: 'insufficient_shares',
  insufficientCash: 'insufficient_cash',
  yieldBelowMin: 'yield_below_min',
  underlyingPriceMissing: 'underlying_price_missing',
  wrongOptionType: 'wrong_option_type',
} as const;

const MAX_REJECTED = 200;

/**
 * 按 `OPTION_SCREEN_RULES` 确定性筛选卖权候选。
 *
 * 安全在这里被翻译成可机械校验的门槛：剩余期限、|delta|（港股用估算概率）、未平仓、
 * 买卖价差、年化收益率、每张权利金、以及**担保是否真的够**。被挡掉的进 `rejected`
 * 而不是静默丢弃 —— 用户有权知道「为什么没推荐这个合约」。
 */
export function screenOptionCandidates(input: OptionScreenInput): OptionScreenResult {
  const warnings: string[] = [...input.snapshot.warnings];
  const rejected: { code: string; reason: string }[] = [];
  const candidates: OptionCandidate[] = [];
  const candidateWarnings: string[] = [];

  const asOfDate = datePart(input.snapshot.asOf);
  const wantType = optionTypeForStrategy(input.strategy);
  const contracts = Number.isInteger(input.contracts) && input.contracts > 0 ? input.contracts : 0;
  if (contracts === 0) {
    warnings.push(`筛选张数必须是正整数（收到 ${input.contracts}），本次不返回候选。`);
    return { candidates, rejected, warnings: dedupeWarnings(warnings) };
  }

  const underlyingPrice = toNumber(input.snapshot.underlyingPrice);
  if (!(underlyingPrice > 0)) {
    warnings.push('期权链没有给出标的现价（0），无法判断虚值幅度与被行权概率，本次不返回候选。');
    for (const quote of input.snapshot.quotes) {
      rejected.push({ code: quote.code, reason: `${OPTION_REJECT_REASONS.underlyingPriceMissing}: 标的现价为 0` });
    }
    return { candidates, rejected: rejected.slice(0, MAX_REJECTED), warnings: dedupeWarnings(warnings) };
  }

  const heldShares = Math.max(0, toNumber(input.heldShares));
  const availableCash = toNumber(input.availableCash);
  if (input.strategy === 'covered_call' && heldShares <= 0) {
    warnings.push('没有可用于覆盖的持股（我的资产里该标的持股为 0），覆盖式卖 Call 不产生候选 —— 卖无担保的 Call 是裸卖，风险无上限。');
  }
  if (input.strategy === 'cash_secured_put' && !(availableCash > 0)) {
    warnings.push(
      '设置里「期权可用现金」为 0（未填写），现金担保卖 Put 无法校验担保、不产生候选；请先到设置页填写该市场的可用现金。',
    );
  }

  for (const quote of input.snapshot.quotes) {
    if (quote.type !== wantType) {
      rejected.push({
        code: quote.code,
        reason: `${OPTION_REJECT_REASONS.wrongOptionType}: ${input.strategy} 只能卖 ${wantType}，该合约是 ${quote.type}`,
      });
      continue;
    }

    const itemWarnings: string[] = [];
    // IV=0 表示上游未提供（港股只有平值系列有 IV）：有同到期平值 IV 就用它估算并标注，
    // 绝不让 0 代入公式得出「没有波动 = 没有被行权风险」的假结论。
    const enrichedQuote = withFallbackIv(quote, input.snapshot, itemWarnings);
    const detail = optionCandidateMetricsDetail(
      {
        market: input.snapshot.market,
        code: input.snapshot.code,
        strategy: input.strategy,
        quote: enrichedQuote,
        underlyingPrice,
        contracts,
      },
      itemWarnings,
    );
    const { metrics } = detail;
    const dte = calendarDaysBetween(asOfDate, datePart(quote.expiry, asOfDate));

    const reject = (reason: string): void => {
      rejected.push({ code: quote.code, reason });
    };

    if (dte < OPTION_SCREEN_RULES.minDaysToExpiry) {
      reject(
        `${OPTION_REJECT_REASONS.dteTooShort}: 剩余 ${dte} 天，低于下限 ${OPTION_SCREEN_RULES.minDaysToExpiry} 天（时间价值太少、年化会被放大）`,
      );
      continue;
    }
    if (dte > OPTION_SCREEN_RULES.maxDaysToExpiry) {
      reject(
        `${OPTION_REJECT_REASONS.dteTooLong}: 剩余 ${dte} 天，超过上限 ${OPTION_SCREEN_RULES.maxDaysToExpiry} 天（占用担保过久、被行权概率高）`,
      );
      continue;
    }
    if (detail.premium.price <= 0) {
      reject(`${OPTION_REJECT_REASONS.noQuote}: 无有效权利金报价（bid/mid/last 均为 0）`);
      continue;
    }
    const premiumPerContract = round4(detail.premium.price * detail.multiplier);
    if (premiumPerContract < OPTION_SCREEN_RULES.minPremiumPerContract) {
      reject(
        `${OPTION_REJECT_REASONS.premiumTooThin}: 每张权利金 ${premiumPerContract}，低于下限 ${OPTION_SCREEN_RULES.minPremiumPerContract}`,
      );
      continue;
    }
    if (toNumber(quote.openInterest) < OPTION_SCREEN_RULES.minOpenInterest) {
      reject(
        `${OPTION_REJECT_REASONS.openInterestTooLow}: 未平仓 ${toNumber(quote.openInterest)}，低于下限 ${OPTION_SCREEN_RULES.minOpenInterest}`,
      );
      continue;
    }
    const hasTwoSided = toNumber(quote.bid) > 0 && toNumber(quote.ask) > 0;
    if (!hasTwoSided || !(toNumber(quote.spreadPct) > 0)) {
      if (input.snapshot.market === 'US') {
        // 美股延迟期权链本来就有 bid/ask：缺失只可能是上游降级，无法核实流动性就不能当安全候选。
        reject(`${OPTION_REJECT_REASONS.spreadMissing}: 买卖价缺失（bid/ask=0），无法核实流动性与成交价差`);
        continue;
      }
      // 港股：港交所每日报告**结构上就没有买卖盘**（只有 EOD 结算价），所以不能因此拒掉全部
      // 港股合约；放行但把「价差档 0 分 + 无法核实成交能力」写进 warnings，界面据此提示。
      itemWarnings.push(
        `${quote.code} 港交所每日报告无买卖盘（bid/ask=0），无法核实价差与真实成交能力；` +
          '权利金为 EOD 估算，流动性分已扣掉价差档。',
      );
    } else if (toNumber(quote.spreadPct) > OPTION_SCREEN_RULES.maxSpreadPct) {
      reject(
        `${OPTION_REJECT_REASONS.spreadTooWide}: 买卖价差 ${round4(toNumber(quote.spreadPct))}%，超过上限 ${OPTION_SCREEN_RULES.maxSpreadPct}%`,
      );
      continue;
    }
    if (input.snapshot.market === 'US' && !(Math.abs(toNumber(quote.delta)) > 0)) {
      reject(`${OPTION_REJECT_REASONS.deltaMissing}: 上游未提供 delta，无法判断被行权概率（不用 0 冒充「没风险」）`);
      continue;
    }
    if (input.snapshot.market === 'HK' && !(toNumber(enrichedQuote.iv) > 0)) {
      reject(`${OPTION_REJECT_REASONS.ivMissing}: 港股无 delta 上游且未给出 IV（连平值 IV 也没有），无法估算被行权概率`);
      continue;
    }
    const probability = detail.probability.probability;
    if (probability > OPTION_SCREEN_RULES.maxAbsDelta) {
      reject(
        `${OPTION_REJECT_REASONS.probabilityTooHigh}: 被行权概率 ${round4(probability * 100)}%，超过上限 ${round4(OPTION_SCREEN_RULES.maxAbsDelta * 100)}%`,
      );
      continue;
    }
    if (probability < OPTION_SCREEN_RULES.minAbsDelta) {
      reject(
        `${OPTION_REJECT_REASONS.probabilityTooLow}: 被行权概率 ${round4(probability * 100)}%，低于 ${round4(OPTION_SCREEN_RULES.minAbsDelta * 100)}%（权利金过薄）`,
      );
      continue;
    }
    // 担保门槛：这才是「安全收权利金」的底线 —— 股数不够就是裸卖 Call，现金不够就是超额卖 Put。
    if (input.strategy === 'covered_call') {
      const requiredShares = detail.multiplier * contracts;
      if (requiredShares > heldShares + 1e-6) {
        reject(
          `${OPTION_REJECT_REASONS.insufficientShares}: 需要 ${requiredShares} 股（${detail.multiplier} 股/张 × ${contracts} 张），` +
            `实际持股 ${heldShares} 股，缺口 ${round4(Math.max(0, requiredShares - heldShares))} 股 = 裸卖 Call（风险无上限），已拒绝`,
        );
        continue;
      }
    } else {
      const requiredCash = round4(toNumber(quote.strike) * detail.multiplier * contracts);
      if (requiredCash > availableCash + 1e-6) {
        reject(
          `${OPTION_REJECT_REASONS.insufficientCash}: 需要现金担保 ${requiredCash}，可用现金 ${round4(availableCash)}，` +
            '被行权时必须能全额接股，现金不够就不该卖这个 Put，已拒绝',
        );
        continue;
      }
    }
    if (metrics.annualizedYieldPct < OPTION_SCREEN_RULES.minAnnualizedYieldPct) {
      reject(
        `${OPTION_REJECT_REASONS.yieldBelowMin}: 年化收益率 ${metrics.annualizedYieldPct}%，低于下限 ${OPTION_SCREEN_RULES.minAnnualizedYieldPct}%`,
      );
      continue;
    }

    candidates.push({ strategy: input.strategy, quote, metrics });
    candidateWarnings.push(...itemWarnings);
  }

  candidates.sort((a, b) => b.metrics.annualizedYieldPct - a.metrics.annualizedYieldPct);
  const limited = candidates.slice(0, OPTION_SCREEN_RULES.maxCandidatesPerUnderlying);
  if (candidates.length > limited.length) {
    warnings.push(
      `通过筛选的合约有 ${candidates.length} 个，按年化收益率取前 ${OPTION_SCREEN_RULES.maxCandidatesPerUnderlying} 个。`,
    );
  }
  warnings.push(...candidateWarnings);
  return { candidates: limited, rejected: rejected.slice(0, MAX_REJECTED), warnings: dedupeWarnings(warnings) };
}

/* ─────────────────────────────── 建议方案 ────────────────────────────────── */

export interface BuildOptionAdvicePlanInput {
  strategy: OptionStrategy;
  market: OptionMarket;
  code: string;
  name?: string;
  quote: OptionQuote;
  underlyingPrice: number;
  contracts: number;
  /** 建议占用担保额（调用方算好传入；本函数会与服务端重算值交叉校验）。 */
  collateral: number;
  collateralNote: string;
  snapshot: OptionChainSnapshot;
  acceptAssignment: boolean;
}

/**
 * 组装 AI 卖权方案（`AdviceItem.option`）。
 *
 * 方案里的指标一律**重新算**（不采信调用方传入的数字）；`collateral` 只用于交叉校验：
 * 传入值与服务端重算值不一致时给 warning，界面与指标都以重算值为准（钱不能由前端/模型定义）。
 * `acceptAssignment=false` 也只会给 warning —— 卖权被行权是义务，不是偏好。
 */
export function buildOptionAdvicePlan(input: BuildOptionAdvicePlanInput): OptionAdvicePlan {
  const warnings: string[] = [...input.snapshot.warnings];
  const expectedType = optionTypeForStrategy(input.strategy);
  if (input.quote.type !== expectedType) {
    warnings.push(
      `合约方向 ${input.quote.type} 与策略 ${input.strategy} 不一致（应卖 ${expectedType}）；请以期权链为准重新选择合约。`,
    );
  }
  const detail = optionCandidateMetricsDetail(
    {
      market: input.market,
      code: input.code,
      strategy: input.strategy,
      quote: withFallbackIv(input.quote, input.snapshot, warnings),
      underlyingPrice: input.underlyingPrice,
      contracts: input.contracts,
    },
    warnings,
  );
  const metrics = detail.metrics;
  // 港股乘数未核对时，方案必须自己带上 warning（不能只依赖快照 warnings 恰好包含它）。
  const multiplierWarning = unverifiedHkMultiplierWarning(input.market, input.code, detail.multiplier);
  if (multiplierWarning) warnings.push(multiplierWarning);
  const passedCollateral = toNumber(input.collateral);
  if (metrics.collateral > 0 && Math.abs(passedCollateral - metrics.collateral) > Math.max(1, metrics.collateral * 0.01)) {
    warnings.push(
      `传入的担保额 ${round4(passedCollateral)} 与服务端重算值 ${metrics.collateral} 不一致，` +
        '界面与收益率一律以服务端重算值为准（担保不能被前端数字改写）。',
    );
  }
  if (!input.acceptAssignment && input.strategy === 'covered_call') {
    warnings.push('方案标记为「不接受被行权」，但覆盖式卖 Call 被行权即按行权价交股；请确认你真的接受交股，否则不应卖这个 Call。');
  }
  if (detail.daysToExpiry <= 0) {
    warnings.push(`合约到期日 ${input.quote.expiry} 不在未来（剩余 ${detail.daysToExpiry} 天），无法卖出开仓。`);
  }
  return {
    strategy: input.strategy,
    optionType: expectedType,
    optionCode: input.quote.code,
    strike: round4(toNumber(input.quote.strike)),
    expiry: datePart(input.quote.expiry),
    contracts: Number.isInteger(input.contracts) && input.contracts > 0 ? input.contracts : 0,
    multiplier: detail.multiplier,
    currency: input.snapshot.currency || MARKET_CURRENCY[input.market],
    premium: detail.premium.price,
    metrics,
    underlyingPrice: round4(toNumber(input.underlyingPrice)),
    acceptAssignment: input.acceptAssignment,
    collateralNote: input.collateralNote,
    dataSource: input.snapshot.source,
    dataAsOf: input.snapshot.asOf,
    delayed: input.snapshot.delayed,
    warnings: dedupeWarnings(warnings),
  };
}

/* ─────────────────────────── 行 → 对外契约（映射） ───────────────────────── */

/** `option_settlements` 一行 → 对外 `OptionSettlement`（字段一一对应，显式复制避免漏字段）。 */
export function toOptionSettlement(row: OptionSettlementRow): OptionSettlement {
  return {
    id: row.id,
    contractId: row.contractId,
    expiry: row.expiry,
    evaluatedAt: row.evaluatedAt,
    referencePrice: round4(toNumber(row.referencePrice)),
    priceSource: row.priceSource,
    verdict: row.verdict,
    itmAmount: round4(toNumber(row.itmAmount)),
    itmPct: round4(toNumber(row.itmPct)),
    status: row.status,
    action: row.action,
    transactionId: row.transactionId,
    assetId: row.assetId,
    realizedPnl: round4(toNumber(row.realizedPnl)),
    note: row.note,
    createdAt: row.createdAt,
  };
}

/** 实值/虚值/平值判定：|现价 − 行权价| / 行权价 小于结算的「存疑带」就算平值。 */
function moneynessOf(optionType: OptionType, underlyingPrice: number, strike: number): OptionPosition['moneyness'] {
  if (!(underlyingPrice > 0) || !(strike > 0)) return 'unknown';
  const distancePct = (Math.abs(underlyingPrice - strike) / strike) * 100;
  if (distancePct < OPTION_SETTLEMENT_RULES.uncertainBandPct) return 'atm';
  if (optionType === 'call') return underlyingPrice > strike ? 'itm' : 'otm';
  return underlyingPrice < strike ? 'itm' : 'otm';
}

/**
 * 行 → `OptionPosition`（**不取网络**）。
 *
 * 开仓瞬间用：标的价沿用卖出时的价格、浮盈按 0（刚以卖出价成交，还没有价差）。
 * 需要「最新行情 + 当前期权价」的列表/详情走 `toOptionPosition`。
 */
function buildPositionWithoutMarket(
  row: OptionContractRow,
  settlement: OptionSettlementRow | null,
): OptionPosition {
  const underlyingPrice = round4(toNumber(row.underlyingPriceAtOpen));
  return {
    id: row.id,
    adviceId: row.adviceId,
    strategy: row.strategy,
    market: row.market,
    underlyingCode: row.underlyingCode,
    underlyingName: row.underlyingName,
    underlyingAssetId: row.underlyingAssetId,
    optionCode: row.optionCode,
    optionType: row.optionType,
    strike: round4(toNumber(row.strike)),
    expiry: row.expiry,
    contracts: row.contracts,
    multiplier: row.multiplier,
    currency: row.currency,
    premium: round4(toNumber(row.premium)),
    fee: round4(toNumber(row.fee)),
    premiumIncome: round4(toNumber(row.premiumIncome)),
    collateralKind: row.collateralKind,
    collateral: round4(toNumber(row.collateral)),
    underlyingPriceAtOpen: round4(toNumber(row.underlyingPriceAtOpen)),
    status: row.status,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    closePrice: row.closePrice === null ? null : round4(toNumber(row.closePrice)),
    realizedPnl: row.realizedPnl === null ? null : round4(toNumber(row.realizedPnl)),
    unrealizedPnl: 0,
    daysToExpiry: daysToExpiry(row.expiry),
    underlyingPrice,
    moneyness: moneynessOf(row.optionType, underlyingPrice, toNumber(row.strike)),
    settlement: settlement ? toOptionSettlement(settlement) : null,
    note: row.note,
  };
}

/** 一个标的的「最新行情 + 当前期权价」上下文（同一标的多条合约只取一次）。 */
interface PositionMarketContext {
  underlyingPrice: number;
  /** 当前买平需要的每股价（ask 优先）；0 = 拿不到，浮盈按 0 显示并已有 warning。 */
  buyToClosePrice: number;
  /** 标的价来源说明（写进 warnings，界面据此标注口径）。 */
  source: string;
}

async function loadPositionMarketContext(
  row: OptionContractRow,
  warnings: string[],
): Promise<PositionMarketContext> {
  if (isOffline()) {
    warnings.push(
      `${row.underlyingCode}：离线模式（AIA_OFFLINE=1）未取实时行情，标的价沿用卖出时的 ${round4(
        toNumber(row.underlyingPriceAtOpen),
      )}，浮盈未计算。`,
    );
    return { underlyingPrice: toNumber(row.underlyingPriceAtOpen), buyToClosePrice: 0, source: 'offline' };
  }
  const market = row.market;
  try {
    const snapshot = await optionChain({ market, code: row.underlyingCode, maxExpiries: 6 });
    const quote =
      snapshot.quotes.find((entry) => entry.code.toUpperCase() === row.optionCode.toUpperCase()) ??
      snapshot.quotes.find(
        (entry) =>
          entry.type === row.optionType &&
          Math.abs(toNumber(entry.strike) - toNumber(row.strike)) < 1e-6 &&
          datePart(entry.expiry) === datePart(row.expiry),
      );
    const ask = quote ? toNumber(quote.ask) : 0;
    const mid = quote ? toNumber(quote.mid) : 0;
    const last = quote ? toNumber(quote.last) : 0;
    const buyToClosePrice = ask > 0 ? round4(ask) : mid > 0 ? round4(mid) : last > 0 ? round4(last) : 0;
    if (quote && buyToClosePrice <= 0) {
      warnings.push(`${row.optionCode} 在期权链里没有有效报价，浮盈按 0 显示（不是没有盈亏）。`);
    }
    if (!quote) {
      warnings.push(`${row.optionCode} 不在当前期权链返回里（可能已到期/下架），浮盈按 0 显示。`);
    }
    const underlyingPrice =
      toNumber(snapshot.underlyingPrice) > 0 ? toNumber(snapshot.underlyingPrice) : toNumber(row.underlyingPriceAtOpen);
    warnings.push(
      `${row.underlyingCode} 行情口径：${snapshot.source}（asOf ${snapshot.asOf}${snapshot.delayed ? '，延迟行情' : ''}）`,
    );
    return { underlyingPrice, buyToClosePrice, source: snapshot.source };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`${row.underlyingCode}：期权链取数失败（${message}），标的价沿用卖出时价格。`);
  }
  // 退一步只用现价（不依赖期权链），仍然拿不到就沿用卖出价并明说。
  try {
    const quote = await getQuote({ code: row.underlyingCode, market, type: 'stock' });
    const price = quote ? toNumber(quote.value.price) : 0;
    if (price > 0) {
      return { underlyingPrice: price, buyToClosePrice: 0, source: quote!.sources.join('/') || 'quote' };
    }
  } catch {
    /* 下面统一降级 */
  }
  warnings.push(
    `${row.underlyingCode} 最新行情获取失败，标的价沿用卖出时价格 ${round4(toNumber(row.underlyingPriceAtOpen))}（浮盈未计算）。`,
  );
  return { underlyingPrice: toNumber(row.underlyingPriceAtOpen), buyToClosePrice: 0, source: 'fallback' };
}

/**
 * 行 → 对外 `OptionPosition`（冻结签名，异步：需要最新行情）。
 *
 * `underlyingPrice` / `moneyness` / `daysToExpiry` / `unrealizedPnl` 是派生字段：
 * 取不到行情时**沿用**卖出时价格（不编造），并在调用方给出的 warnings 里写清降级原因。
 * 注意：冻结签名没有 warnings 出口，单行详情接口只能通过 `note`/`moneyness=unknown`
 * 体现降级；列表接口请用 `optionPositionsPayload`（它把 warnings 一起返回）。
 */
export async function toOptionPosition(
  row: OptionContractRow,
  settlement?: OptionSettlementRow | null,
): Promise<OptionPosition> {
  const warnings: string[] = [];
  const context = await loadPositionMarketContext(row, warnings);
  const position = buildPositionFromMarket(row, settlement ?? null, context);
  if (warnings.length > 0) {
    // 单行接口没有 warnings 字段：把数据降级写进 note（用户可见、可追溯），不静默。
    position.note = [position.note, `⚠ ${warnings.join('；')}`].filter((part) => part && part.trim() !== '').join('；');
  }
  return position;
}

/** 行 + 行情上下文 → 对外 `OptionPosition`。 */
function buildPositionFromMarket(
  row: OptionContractRow,
  settlement: OptionSettlementRow | null,
  context: PositionMarketContext,
): OptionPosition {
  const position = buildPositionWithoutMarket(row, settlement);
  const multiplier = toNumber(row.multiplier) > 0 ? toNumber(row.multiplier) : 1;
  const units = multiplier * toNumber(row.contracts);
  position.underlyingPrice = round4(context.underlyingPrice);
  position.moneyness = moneynessOf(row.optionType, context.underlyingPrice, toNumber(row.strike));
  position.daysToExpiry = daysToExpiry(row.expiry);
  // 浮盈 = (卖出时权利金 − 当前买平价) × 乘数 × 张数：买平越便宜，赚得越多。
  position.unrealizedPnl =
    context.buyToClosePrice > 0 ? round4((toNumber(row.premium) - context.buyToClosePrice) * units) : 0;
  return position;
}

/* ─────────────────────────────── 持仓视图 ────────────────────────────────── */

/** 在手合约 + 已平/已到期合约的对外视图（含 KPI 汇总与取数降级说明）。 */
export async function optionPositionsPayload(): Promise<OptionPositionsResponse> {
  const repo = getRepo();
  const rows = repo.listOptionContracts({ status: 'all' });
  const settlements = repo.listOptionSettlements({ status: 'all' });
  const settlementByContract = new Map(settlements.map((row) => [row.contractId, row]));
  const warnings: string[] = [];
  const contextCache = new Map<string, Promise<PositionMarketContext>>();
  const items: OptionPosition[] = [];

  for (const row of rows) {
    const settlement = settlementByContract.get(row.id) ?? null;
    if (row.status !== 'open') {
      // 已结束的合约不再取行情：它的数字已经定死，重复抓只会拖慢页面。
      items.push(buildPositionWithoutMarket(row, settlement));
      continue;
    }
    const key = `${row.market}:${row.underlyingCode}`;
    let pending = contextCache.get(key);
    if (!pending) {
      pending = loadPositionMarketContext(row, warnings);
      contextCache.set(key, pending);
    }
    const context = await pending;
    items.push(buildPositionFromMarket(row, settlement, context));
  }

  return { items, summary: optionPortfolioSummary(rows, settlements), warnings: dedupeWarnings(warnings) };
}

/**
 * 顶部 KPI 汇总（纯函数，可复算）：
 *  - `premiumIncome` 只统计**在手**合约（还没到手的权利金不能算已赚）；
 *  - `realizedPremium` = 已结束（平仓/到期/被行权）合约的权利金收入合计；
 *  - `assignedCount` = 已被行权的合约数；
 *  - `pendingSettlements` = 待确认的结算记录数；
 *  - `collateralByMarket` = 在手合约按市场分组的担保占用（本币，不折算汇率 —— 折算会让
 *    「还能卖多少」失真，用户按市场看才是有意义的）。
 */
export function optionPortfolioSummary(
  rows: OptionContractRow[],
  settlements: OptionSettlementRow[],
): OptionPortfolioSummary {
  const open = rows.filter((row) => row.status === 'open');
  const closed = rows.filter((row) => row.status !== 'open');
  const collateral = new Map<OptionMarket, { market: OptionMarket; currency: string; amount: number }>();
  for (const row of open) {
    const current = collateral.get(row.market) ?? {
      market: row.market,
      currency: MARKET_CURRENCY[row.market] ?? row.currency,
      amount: 0,
    };
    current.amount = round4(current.amount + toNumber(row.collateral));
    collateral.set(row.market, current);
  }
  const markets: OptionMarket[] = ['HK', 'US'];
  return {
    openContracts: open.length,
    premiumIncome: round4(open.reduce((sum, row) => sum + toNumber(row.premiumIncome), 0)),
    realizedPremium: round4(closed.reduce((sum, row) => sum + toNumber(row.premiumIncome), 0)),
    assignedCount: rows.filter((row) => row.status === 'assigned').length,
    pendingSettlements: settlements.filter((row) => row.status === 'pending_review').length,
    collateralByMarket: markets
      .filter((market) => collateral.has(market))
      .map((market) => collateral.get(market)!),
  };
}

/** 结算记录列表（对外契约；`status='all'` 含已确认/已忽略的历史）。 */
export function optionSettlementsPayload(status: OptionSettlementStatus | 'all' = 'all'): OptionSettlementsResponse {
  const repo = getRepo();
  const rows = status === 'all' ? repo.listOptionSettlements({ status: 'all' }) : repo.listOptionSettlements({ status });
  return {
    items: rows.map(toOptionSettlement),
    warnings: [],
  };
}

/* ───────────────────────────── 手工登记 / 买平 ───────────────────────────── */

export interface ManualOptionPositionInput {
  market: OptionMarket;
  code: string;
  underlyingName?: string;
  strategy: OptionStrategy;
  optionType: OptionType;
  optionCode: string;
  strike: number;
  expiry: string;
  contracts: number;
  premium: number;
  fee?: number;
  multiplier?: number;
  tradeDate?: string;
  note?: string;
}

/**
 * 手工登记一笔已卖出的合约（计划外成交时补录）。
 *
 * 与 `confirmOptionAdvice` 的分工：确认走建议（**开仓前**校验担保是否够，不够直接拒绝）；
 * 手工登记是「我**已经**卖了」，所以要记账而不是拦截 —— 但仍会把担保额与可行口径算清楚、
 * 把缺口写进 warnings，绝不因为「反正已经卖了」就假装担保充足。
 */
export function createManualOptionPosition(input: ManualOptionPositionInput): OptionContractRow {
  const repo = getRepo();
  const market = input.market;
  if (market !== 'HK' && market !== 'US') throw badRequest('期权卖权只支持港股/美股');
  const code = (input.code ?? '').trim();
  if (!code) throw badRequest('标的代码不能为空');
  const optionCode = (input.optionCode ?? '').trim();
  if (!optionCode) throw badRequest('合约代码不能为空');
  if (!Number.isInteger(input.contracts) || input.contracts <= 0 || input.contracts > 1000) {
    throw badRequest(`张数必须是 1–1000 的整数（收到 ${input.contracts}）`);
  }
  if (!(toNumber(input.premium) > 0)) throw badRequest('每股价权利金必须大于 0');
  if (!(toNumber(input.strike) > 0)) throw badRequest('行权价必须大于 0');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiry)) throw badRequest('到期日必须是 YYYY-MM-DD');
  const expectedType = optionTypeForStrategy(input.strategy);
  if (input.optionType !== expectedType) {
    throw badRequest(`${input.strategy} 只能卖 ${expectedType}（收到 optionType=${input.optionType}）`);
  }

  const multiplier = Number.isInteger(input.multiplier) && (input.multiplier ?? 0) > 0 ? input.multiplier! : market === 'US' ? US_OPTION_MULTIPLIER : HK_OPTION_MULTIPLIER_FALLBACK;
  const contracts = input.contracts;
  const premium = round4(toNumber(input.premium));
  const fee = Math.max(0, toNumber(input.fee));
  const shares = multiplier * contracts;
  const asset = findUnderlyingAsset(repo, code, market);
  const heldShares = asset ? computePosition(repo.listTransactions(asset.id)).shares : 0;
  const now = nowIso();
  const warnings: string[] = [];
  if (!(Number.isInteger(input.multiplier) && (input.multiplier ?? 0) > 0)) {
    warnings.push(`未填写合约乘数，按 ${multiplier} 股/张登记（港股各标的不同，请以券商合约规格为准）。`);
  }

  let collateral = round4(toNumber(input.strike) * shares);
  let underlyingPriceAtOpen = 0;
  if (input.strategy === 'covered_call') {
    underlyingPriceAtOpen = asset ? round4(toNumber(asset.price)) : 0;
    collateral = round4(underlyingPriceAtOpen * shares);
    if (!asset) {
      warnings.push(`「我的资产」里没有 ${code} 的持仓：这笔卖 Call 可能是裸卖（风险无上限），请核对。`);
    } else if (heldShares + 1e-6 < shares) {
      warnings.push(`登记需要 ${shares} 股覆盖，但当前持股只有 ${heldShares} 股；缺口部分等于裸卖 Call。`);
    }
  } else {
    warnings.push(`现金担保 ${collateral} ${MARKET_CURRENCY[market]} 由设置里的「期权可用现金」覆盖情况自行核对（登记不校验现金余额）。`);
  }

  return repo.createOptionContract({
    id: crypto.randomUUID(),
    adviceId: null,
    strategy: input.strategy,
    market,
    underlyingCode: code,
    underlyingName: (input.underlyingName ?? asset?.name ?? code).trim(),
    underlyingAssetId: asset?.id ?? null,
    optionCode,
    optionType: input.optionType,
    strike: round4(toNumber(input.strike)),
    expiry: datePart(input.expiry),
    contracts,
    multiplier,
    currency: MARKET_CURRENCY[market] ?? 'USD',
    premium,
    fee,
    premiumIncome: round4(premium * shares - fee),
    collateralKind: collateralKindForStrategy(input.strategy),
    collateral,
    underlyingPriceAtOpen,
    status: 'open',
    // 手工补录允许回填成交日：按当地零点生成时间戳（账本按 opened_at 排序，日期必须如实）。
    openedAt: input.tradeDate ? nowIso(new Date(`${datePart(input.tradeDate)}T00:00:00`)) : now,
    note: [input.note ?? '', ...warnings].filter((part) => part && part.trim() !== '').join('；'),
    createdAt: now,
    updatedAt: now,
  });
}

/* ─────────────────────────────── 建议 → 合约入账 ─────────────────────────── */

export interface ConfirmOptionAdviceArgs {
  adviceId: string;
  input: ConfirmOptionAdviceInput;
}

export interface ConfirmOptionAdviceOutcome {
  advice: AdviceRow;
  position: OptionPosition;
  warnings: string[];
}

/**
 * 把一条**待确认**的卖权建议落成在手合约（`POST /api/advice/:id/confirm-option`）。
 *
 * 关键约束（钱与账本的不可逆操作，任何一条不满足都不写库）：
 *  1. 用确认弹窗的最终值覆写（张数 / 每股价权利金 / 到期日 / 行权价）；
 *  2. **担保额服务端重算**：覆盖式卖 Call = 持股市值（方案快照的标的价 × 乘数 × 张数），
 *     现金担保卖 Put = 行权价 × 乘数 × 张数。前端传什么都不采信；
 *  3. 开仓**不写 `transactions`**：卖权开仓只有权利金流入，没有股票交割；写流水会把持仓
 *     凭空改小/改大（到期结算时才写股票流水，见 services/options-settlement.ts）；
 *  4. **幂等**：同一 adviceId 已有合约时直接返回它（重复点击不会产生第二份合约）。
 *     `Repo` 冻结接口没有 `findOptionContractByAdvice`，只能全量列表里按 adviceId 过滤；
 *     判断放在写事务内部，单线程事件循环下「读 → 写」之间没有 await，不会写两次。
 *
 * 为什么是同步函数：冻结签名返回 `AdviceRow`（不是 Promise），且开仓瞬间没有任何行情要取；
 * 需要最新行情的 `OptionPosition` 由列表/详情接口通过 `toOptionPosition` 补全。
 */
export function confirmOptionAdvice(args: ConfirmOptionAdviceArgs): ConfirmOptionAdviceOutcome {
  const repo = getRepo();
  const adviceId = (args.adviceId ?? '').trim();
  if (!adviceId) throw badRequest('建议 id 不能为空');
  const advice = repo.getAdvice(adviceId);
  if (!advice) throw notFound(`建议不存在：${adviceId}`);
  if (advice.instrument !== 'option') {
    throw badRequest('该建议不是期权卖权建议，请使用股票确认接口', {
      code: 'NOT_OPTION_ADVICE',
      instrument: advice.instrument,
      endpoint: `/api/advice/${advice.id}/confirm`,
    });
  }
  const plan = advice.option;
  if (!plan) throw badRequest('该期权建议缺少合约方案（option_plan），无法确认；请让 AI 重新生成');
  if (advice.market !== 'HK' && advice.market !== 'US') {
    throw badRequest(`期权卖权只支持港股/美股（该建议标的市场为 ${advice.market}）`);
  }
  const market: OptionMarket = advice.market;

  const body = args.input;
  if (!Number.isInteger(body.contracts) || body.contracts <= 0) {
    throw badRequest(`张数必须是正整数（收到 ${body.contracts}）`);
  }
  if (!(toNumber(body.premium) > 0)) throw badRequest('每股价权利金必须大于 0');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.expiry ?? '')) throw badRequest('到期日必须是 YYYY-MM-DD');
  const strike = body.strike === undefined ? toNumber(plan.strike) : toNumber(body.strike);
  if (!(strike > 0)) throw badRequest('行权价必须大于 0');
  const today = localDate();
  if (datePart(body.expiry) < today) {
    throw badRequest(`到期日 ${body.expiry} 已过（今天 ${today}），不能卖出开仓`);
  }
  const contracts = body.contracts;
  const premium = round4(toNumber(body.premium));
  const fee = Math.max(0, toNumber(body.fee));
  const multiplier = toNumber(plan.multiplier) > 0 ? toNumber(plan.multiplier) : market === 'US' ? US_OPTION_MULTIPLIER : HK_OPTION_MULTIPLIER_FALLBACK;
  const shares = multiplier * contracts;
  const now = nowIso();
  const warnings: string[] = [];
  if (!(toNumber(plan.multiplier) > 0)) {
    warnings.push(`建议方案没有合约乘数，按 ${multiplier} 股/张登记；请以券商合约规格为准。`);
  }
  // 乘数未经核对时必须落在合约 note 上：权利金、担保额、行权交割股数都依赖它，
  // 三个月后回看这条合约的用户也得知道「当时这个乘数是估算的」。
  const multiplierWarning = unverifiedHkMultiplierWarning(market, advice.code, multiplier);
  if (multiplierWarning) warnings.push(multiplierWarning);
  if (premium !== round4(toNumber(plan.premium))) {
    warnings.push(`最终权利金 ${premium} 与建议值 ${round4(toNumber(plan.premium))} 不同，已按最终值入账（权利金收入已重算）。`);
  }
  if (plan.strategy === 'covered_call' && !plan.acceptAssignment) {
    warnings.push('该方案标记为「不接受被行权」：一旦被行权仍必须按行权价交股，请确认持股足够。');
  }

  const result = repo.transaction(() => {
    const existing = repo.listOptionContracts({ status: 'all' }).find((row) => row.adviceId === advice.id);
    if (existing) {
      // 幂等：重复确认不写第二份合约，也不重复改建议。
      const current = repo.getAdvice(advice.id) ?? advice;
      return { contract: existing, advice: current, duplicate: true };
    }
    if (advice.status !== 'pending') {
      throw conflict(`该建议当前状态为 ${advice.status}，无法确认（只有待确认的建议能开仓）`);
    }

    let underlyingAssetId: string | null = advice.assetId ?? null;
    let collateral = round4(strike * shares);
    if (plan.strategy === 'covered_call') {
      const asset: AssetRow | undefined =
        (underlyingAssetId ? repo.getAsset(underlyingAssetId) : undefined) ?? findUnderlyingAsset(repo, advice.code, market);
      if (!asset) {
        throw conflict(
          `覆盖式卖 Call 需要「我的资产」里持有 ${advice.code}（${market}），当前没有任何持仓记录。` +
            '卖没有股票担保的 Call 是裸卖，风险无上限，已拒绝。',
          { code: 'NO_UNDERLYING_POSITION', requiredShares: shares },
        );
      }
      const heldShares = computePosition(repo.listTransactions(asset.id)).shares;
      if (heldShares + 1e-6 < shares) {
        const maxContracts = multiplier > 0 ? Math.floor(heldShares / multiplier + 1e-9) : 0;
        throw conflict(
          `持股不足以覆盖：${contracts} 张需要 ${shares} 股（${multiplier} 股/张），实际持股 ${heldShares} 股；` +
            (maxContracts >= 1 ? `最多只能卖 ${maxContracts} 张。` : '持股不足 1 张，请先买入正股或改做其他标的。'),
          { code: 'INSUFFICIENT_SHARES', requiredShares: shares, heldShares, maxContracts: Math.max(0, maxContracts) },
        );
      }
      underlyingAssetId = asset.id;
      // 担保额 = 持股市值：用方案里的标的快照价（服务端写入的），拿不到才退回落最新资产价。
      const markPrice = toNumber(plan.underlyingPrice) > 0 ? toNumber(plan.underlyingPrice) : toNumber(asset.price);
      collateral = round4(markPrice * shares);
      if (collateral <= 0) {
        warnings.push('标的现价为 0，担保额（持股市值）无法计算，已按 0 记录；收益率与占用资金会失真。');
      }
    } else {
      const cashSetting = safeOptionCash(repo, market, warnings);
      if (!(cashSetting > 0)) {
        throw conflict(
          `设置里「期权可用现金」（${market}）为 0（未填写），无法确认现金担保卖 Put：` +
            `本笔需要 ${collateral} ${plan.currency || MARKET_CURRENCY[market]}。请先到设置页填写可用现金。`,
          { code: 'NO_CASH', collateral, currency: plan.currency || MARKET_CURRENCY[market] },
        );
      }
      if (collateral > cashSetting + 1e-6) {
        const maxContracts = Math.floor(cashSetting / (strike * multiplier) + 1e-9);
        throw conflict(
          `现金担保不足：本笔需要 ${collateral}，设置里可用现金 ${round4(cashSetting)}；` +
            (maxContracts >= 1 ? `按该行权价最多只能卖 ${maxContracts} 张。` : '不足以按该行权价卖 1 张。'),
          { code: 'INSUFFICIENT_CASH', collateral, availableCash: round4(cashSetting), maxContracts: Math.max(0, maxContracts) },
        );
      }
    }

    const contract = repo.createOptionContract({
      id: crypto.randomUUID(),
      adviceId: advice.id,
      strategy: plan.strategy,
      market,
      underlyingCode: advice.code,
      underlyingName: advice.assetName || advice.code,
      underlyingAssetId,
      optionCode: plan.optionCode,
      optionType: optionTypeForStrategy(plan.strategy),
      strike: round4(strike),
      expiry: datePart(body.expiry),
      contracts,
      multiplier,
      currency: plan.currency || MARKET_CURRENCY[market],
      premium,
      fee,
      premiumIncome: round4(premium * shares - fee),
      collateralKind: collateralKindForStrategy(plan.strategy),
      collateral,
      underlyingPriceAtOpen: round4(toNumber(plan.underlyingPrice)),
      status: 'open',
      openedAt: now,
      note: [body.note ?? `由 AI 卖权建议 ${advice.id} 确认（${plan.optionCode}）`, multiplierWarning]
        .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
        .join('；'),
      createdAt: now,
      updatedAt: now,
    });

    // executedShares 记「法定股数」= 乘数 × 张数，与股票建议的成交股数同口径（列表直接渲染）。
    const updated = repo.updateAdvice(advice.id, {
      status: 'confirmed',
      assetId: underlyingAssetId ?? advice.assetId,
      executedShares: shares,
      executedPrice: premium,
      decidedAt: now,
    });
    if (!updated) throw notFound(`建议不存在：${advice.id}`);
    return { contract, advice: updated, duplicate: false };
  });

  const settlement = repo.findOptionSettlementByContract(result.contract.id) ?? null;
  if (result.duplicate) {
    warnings.push('该建议已经确认过，本次返回已存在的合约（幂等，未重复建仓）。');
  }
  return {
    advice: result.advice,
    position: buildPositionWithoutMarket(result.contract, settlement),
    warnings: dedupeWarnings(warnings),
  };
}

/* ─────────────────────────────── 提前买平 ────────────────────────────────── */

/**
 * 提前买平（buy to close）：把合约置为 closed 并结算已实现盈亏。
 *
 * 已实现盈亏 = 收到的权利金收入 − 买平成本（每股价 × 乘数 × 张数 + 买平费用）。
 * 只有 status='open' 的合约能平仓；重复买平直接 409（不是幂等操作，会重复花钱）。
 */
export function closeOptionPosition(input: {
  id: string;
  price: number;
  fee?: number;
  tradeDate?: string;
  note?: string;
}): OptionPosition {
  const repo = getRepo();
  const id = (input.id ?? '').trim();
  const price = toNumber(input.price);
  if (!(price > 0)) throw badRequest('买平价格必须大于 0');
  const fee = Math.max(0, toNumber(input.fee));
  const tradeDate = input.tradeDate && /^\d{4}-\d{2}-\d{2}$/.test(input.tradeDate) ? input.tradeDate : localDate();

  const updated = repo.transaction(() => {
    const row = repo.getOptionContract(id);
    if (!row) throw notFound(`期权合约不存在：${id}`);
    if (row.status !== 'open') {
      throw conflict(`该合约状态为 ${row.status}，无法买平（只有持有中的合约能平仓）`);
    }
    const units = toNumber(row.multiplier) * toNumber(row.contracts);
    const realizedPnl = round4(toNumber(row.premiumIncome) - (price * units + fee));
    const patched = repo.updateOptionContract(row.id, {
      status: 'closed',
      closedAt: nowIso(),
      closePrice: round4(price),
      realizedPnl,
      note: [row.note ?? '', input.note ?? `买平 @ ${round4(price)}（${tradeDate}）`, fee > 0 ? `买平费用 ${round4(fee)}` : '']
        .filter((part) => part && part.trim() !== '')
        .join('；'),
      updatedAt: nowIso(),
    });
    if (!patched) throw notFound(`期权合约不存在：${row.id}`);
    return patched;
  });
  return buildPositionWithoutMarket(updated, repo.findOptionSettlementByContract(updated.id) ?? null);
}

/* ────────────────────────── 「我的资产」辅助 ──────────────────────────────── */

/** 按标的代码找港股/美股持仓（先 stock 再 etf，与工具层的反查顺序一致）。 */
function findUnderlyingAsset(repo: Repo, code: string, market: OptionMarket): AssetRow | undefined {
  return repo.findAsset(code, market, 'stock') ?? repo.findAsset(code, market, 'etf');
}

/** 读设置里的期权可用现金；读失败时给 warning 并按 0（未填写）处理，绝不猜一个数字。 */
function safeOptionCash(repo: Repo, market: OptionMarket, warnings: string[]): number {
  try {
    const cash = repo.getSettings().option?.cash?.[market];
    return toNumber(cash);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`读取「期权可用现金」设置失败（${message}），按 0（未填写）处理。`);
    return 0;
  }
}

/* ─────────────────────────── 期权数据源（薄封装） ───────────────────────── */

/** 取期权链（HTTP 路由与结算器共用）。数据源不可用时抛 502，绝不用空/假快照糊过去。 */
export async function loadOptionChain(input: OptionChainRequest): Promise<OptionChainSnapshot> {
  if (isOffline()) {
    throw upstreamError('离线模式（AIA_OFFLINE=1）：期权链数据源不可用');
  }
  return optionChain(input);
}
