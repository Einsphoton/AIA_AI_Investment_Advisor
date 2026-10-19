/**
 * 期权卖权的展示口径（纯函数，便于单测）— owner: web-options.
 *
 * 界面上的「钱」与「百分比」一律走 format.ts；这里只负责把契约字段翻译成
 * 用户能读懂的一句话（被行权会发生什么、担保占用多少、这价格准不准），
 * 这样同一个口径在建议卡片 / 确认弹窗 / 期权页三处不会各写一份。
 */
import {
  OPTION_SOURCE_LABELS,
  type Market,
  type OptionAdvicePlan,
  type OptionPositionStatus,
  type OptionSettlementStatus,
  type OptionSettlementVerdict,
  type OptionStrategy,
  type OptionType,
} from '@aia/shared';
import { fmtDateTime, fmtMoney, fmtNum, fmtPct, fmtPrice, fmtShares } from '../format';

/** Badge 支持的语义色（与 ui.tsx 的 tone 保持一致）。 */
export type BadgeTone = 'default' | 'buy' | 'sell' | 'ai' | 'manual' | 'warn' | 'ok' | 'ipo-subscribe' | 'ipo-avoid';

/**
 * 策略徽标配色。
 *
 * 覆盖式卖 Call 有持股兜底（中性灰），现金担保卖 Put 要占用现金（提示色）：
 * 这是**担保物类型**的区分，不是看好/看空的判断，所以不复用红涨绿跌。
 */
export const OPTION_STRATEGY_TONE: Record<OptionStrategy, BadgeTone> = {
  covered_call: 'manual',
  cash_secured_put: 'warn',
};

/** 在手合约状态配色。 */
export const OPTION_POSITION_TONE: Record<OptionPositionStatus, BadgeTone> = {
  open: 'ai',
  closed: 'manual',
  assigned: 'warn',
  expired_otm: 'ok',
};

/** 结算判定配色：落袋=好、行权=需要交割（提示）、存疑=待人工判定。 */
export const OPTION_SETTLEMENT_VERDICT_TONE: Record<OptionSettlementVerdict, BadgeTone> = {
  otm_no_assignment: 'ok',
  assigned: 'warn',
  uncertain: 'manual',
};

/** 结算记录状态配色：自动入账/已确认=好，待确认=醒目，已忽略=灰。 */
export const OPTION_SETTLEMENT_STATUS_TONE: Record<OptionSettlementStatus, BadgeTone> = {
  auto_settled: 'ok',
  pending_review: 'warn',
  confirmed: 'ai',
  dismissed: 'default',
};

/**
 * 距到期自然日（只比日期，避免「时区差一小时」把剩余天数算错一天）。
 * 已过期返回负数。
 */
export function daysUntil(iso: string, now: Date = new Date()): number {
  const target = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(target)) return 0;
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86_400_000);
}

/** 「到期 2026-11-20 · 剩余 32 天」；今天到期 / 已过期都给出明确说法。 */
export function expiryCountdown(iso: string, now: Date = new Date()): string {
  if (!iso) return '到期日未提供';
  const days = daysUntil(iso, now);
  if (days < 0) return `到期 ${iso} · 已过期 ${-days} 天`;
  if (days === 0) return `到期 ${iso} · 今天到期`;
  return `到期 ${iso} · 剩余 ${days} 天`;
}

/**
 * 权利金收入 = 每股价 × 乘数 × 张数 − 费用。
 *
 * 与 `OptionCandidateMetrics.premiumIncome` 同一口径；确认弹窗里用户改价/改张数
 * 后必须用这个函数重算，绝不能让界面继续显示建议里的旧数字。
 */
export function optionPremiumIncome(premium: number, multiplier: number, contracts: number, fee = 0): number {
  return premium * multiplier * contracts - fee;
}

/** 数据口径一行：来源 + 抓取时间 + 是否延迟（用户最担心「这价准不准」）。 */
export function optionDataLine(plan: Pick<OptionAdvicePlan, 'dataSource' | 'dataAsOf' | 'delayed'>): string {
  const name = (plan.dataSource && OPTION_SOURCE_LABELS[plan.dataSource]) || plan.dataSource || '未知来源';
  const when = plan.dataAsOf ? fmtDateTime(plan.dataAsOf) : '时间未提供';
  return `${name} · ${when}${plan.delayed ? ' · 延迟/收盘口径（非实时）' : ' · 实时口径'}`;
}

/** 担保占用：卖 Call = 需要持股；卖 Put = 占用现金。 */
export function optionCollateralText(plan: Pick<OptionAdvicePlan, 'metrics' | 'currency'>): string {
  const metrics = plan.metrics;
  if (metrics.collateralKind === 'shares') {
    return `需持股 ${fmtShares(metrics.requiredShares)} 股（市值约 ${fmtMoney(metrics.collateral, plan.currency)}）`;
  }
  return `占用现金 ${fmtMoney(metrics.collateral, plan.currency)}`;
}

/** 被行权概率的口径说明：港股的 delta 只覆盖平值系列，所以只能当估算用。 */
export function assignmentProbabilityHint(market: Market): string {
  return market === 'HK' ? '港股为估算（只覆盖平值系列的 IV/delta）' : '|delta| 代理';
}

/** 被行权概率：代理指标是 |delta|；港股只有平值系列有 IV/delta，必须标注是估算。 */
export function assignmentProbabilityText(probability: number, market: Market): string {
  if (!Number.isFinite(probability) || probability <= 0) return '被行权概率未评估';
  return `被行权概率 ${fmtPct(probability * 100, 1, false)} · ${assignmentProbabilityHint(market)}`;
}

/** 流动性：分数低时明确写出「按中间价成交会高估权利金」。 */
export function liquidityText(score: number): string {
  if (!Number.isFinite(score) || score <= 0) return '流动性未评估';
  if (score >= 70) return `流动性 ${fmtNum(score, 0)}/100（价差小、盘口厚）`;
  if (score >= 40) return `流动性 ${fmtNum(score, 0)}/100（一般）`;
  return `流动性 ${fmtNum(score, 0)}/100（偏薄：按中间价成交可能高估权利金）`;
}

/**
 * 被行权后果（确认弹窗与建议卡片的「不可逆提示」共用一段口径）。
 *
 * 卖 Call = 交出 multiplier × contracts 股；卖 Put = 按行权价收股，
 * 占用「行权价 × 乘数 × 张数」现金。两句话必须都把**数量与现金**写出来，
 * 否则用户只会看到「可能被行权」这种无法决策的提示。
 */
export function optionAssignmentConsequence(args: {
  optionType: OptionType;
  strike: number;
  multiplier: number;
  contracts: number;
  currency: string;
  collateralNote?: string;
}): string {
  const shares = Math.max(0, args.multiplier) * Math.max(0, args.contracts);
  const cash = Math.max(0, args.strike) * shares;
  if (args.optionType === 'call') {
    const backing = args.collateralNote?.trim() || '「我的资产」里的持股';
    return `被行权：按行权价 ${fmtPrice(args.strike, args.currency)} 交出 ${fmtShares(shares)} 股（担保来自${backing}），股票端盈亏另算。`;
  }
  return `被行权：按行权价 ${fmtPrice(args.strike, args.currency)} 收到 ${fmtShares(shares)} 股，占用现金 ${fmtMoney(
    cash,
    args.currency,
  )}（现金担保，权利金归你）。`;
}

/**
 * 到期自动结算规则（必须在最终确认弹窗里写清楚，避免用户以为卖出就结束了）。
 *
 * 与 shared 的 `OPTION_SETTLEMENT_RULES` / 设置页 `settlementMode` 的语义一致。
 */
export const OPTION_SETTLEMENT_RULE_TEXT =
  '到期后系统按到期日参考价自动判定：虚值到期 → 权利金全额落袋；实值且结论明确 → 按行权价自动交股 / 收股并写入「我的资产」；' +
  '参考价贴行权价、取不到结算价、跨假期等存疑情况 → 一律转「待确认结算」，必须由你在期权卖权页确认后才入账（设置里选 manual 时全部转待确认）。';

/** 结算记录里「实际动作」的一句话说明，找不到映射时回退原值。 */
export function settlementActionText(action: string, labels: Record<string, string>): string {
  return labels[action] ?? action;
}

/** 结算记录的一行摘要，用于历史表与告警提示。 */
export function settlementReferenceText(args: {
  referencePrice: number;
  priceSource: string;
  itmAmount: number;
  itmPct: number;
  currency: string;
}): string {
  const price = args.referencePrice > 0 ? fmtPrice(args.referencePrice, args.currency) : '未取得参考价';
  const itm = args.itmAmount > 0 ? `实值 ${fmtPrice(args.itmAmount, args.currency)}（${fmtPct(args.itmPct, 2, false)}）` : '无实值';
  return `参考价 ${price} · 来源：${args.priceSource || '未标注'} · ${itm}`;
}
