/**
 * 打新展示口径（列表 / 详情 / AI 投资建议页共用）。
 *
 * 拆出来的原因：这三个页面都要回答同样的问题 —— 「这只值得打吗？买到能赚多少？」
 * 而且必须在**同一个口径**下显示，否则列表说胜率 62%、详情说 0.62、建议页另一个颜色，
 * 用户就没法比。所有格式化都放这里，页面只做布局。
 */
import { IPO_VERDICT_LABELS, MARKET_CURRENCY } from '@aia/shared';
import type { IpoAdviceVerdict, IpoOffer } from '@aia/shared';
import { fmtNum, fmtPrice } from '../format';

/** 打新建议 → 徽章色。用的是**风险语义**（绿=值得下手、红=建议放弃），不是行情红涨绿跌。 */
export const IPO_VERDICT_TONE: Record<IpoAdviceVerdict, 'ipo-subscribe' | 'ipo-avoid' | 'default'> = {
  subscribe: 'ipo-subscribe',
  neutral: 'default',
  avoid: 'ipo-avoid',
};

/**
 * 徽章 tooltip：把颜色语义**和 verdict 的口径**都写明。
 * verdict 是「本期该不该打」的综合判断（含预算），不是单纯的股票好坏 —— 这正是
 * 「胜率 75% 却显示不参与」时用户最容易误解的地方。
 */
export const IPO_VERDICT_HINT: Record<IpoAdviceVerdict, string> = {
  subscribe: 'AI 建议申购：标的值得且本期可执行（预算够、买得起至少一手）。绿色=值得下手，非行情涨跌色',
  neutral: 'AI 中性观察：标的不算差，但本期不参与（多为本月预算不足 / 一手入场费太贵）。灰色，不是看空',
  avoid: 'AI 建议放弃：标的不值得（定价 / 基本面 / 破发风险）。红色=风险提示，非行情涨跌色',
};

/**
 * 「推荐理由」：优先用 AI 写入的一句话理由；老数据没有该字段时，
 * 从建议正文的「结论」首句提取（老库里 75% 胜率却判不参与的真实原因就写在那里：预算不够）。
 *
 * 导出以便单测：这里的 fallback 决定了升级后老结论能不能立刻解释清楚自己。
 */
export function verdictReasonText(offer: IpoOffer): string {
  const stored = (offer.verdictReason ?? '').trim();
  if (stored) return stored;
  // 从 Markdown 里找「**结论**：xxx」或「结论：xxx」的首段，去掉加粗标记并压成一行。
  const line = /\*\*结论\*\*\s*[:：]\s*([^\n]+)/.exec(offer.advice)?.[1] ?? /(?:^|\n)\s*结论\s*[:：]\s*([^\n]+)/.exec(offer.advice)?.[1];
  if (!line) return '';
  const plain = line.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  return plain;
}

/** 截断成「简明扼要」的一行（列表列宽有限），完整内容放在 title 里。 */
export function truncateText(text: string, max = 42): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * 「AI 投资建议」页的打新板块只列**值得下手**的标的（导出以便单测）。
 *
 * 规则：
 *  - 只看在招/待申购的（`subscribing` / `upcoming`）——它们才与买入建议抢当月现金；
 *  - AI 已明确「建议放弃」的不占位（不会占用现金，列在那儿只会稀释注意力），只报个数；
 *  - 还没分析的照列（可能是刚刷新出来的新标的，需要用户/ AI 判断）。
 */
export function selectActionableIpoOffers(offers: IpoOffer[]): { actionable: IpoOffer[]; avoided: IpoOffer[] } {
  const live = offers.filter((offer) => offer.status === 'subscribing' || offer.status === 'upcoming');
  return {
    actionable: live.filter((offer) => offer.verdict !== 'avoid'),
    avoided: live.filter((offer) => offer.verdict === 'avoid'),
  };
}

export function verdictLabel(verdict: IpoAdviceVerdict | null | undefined): string {
  return verdict ? IPO_VERDICT_LABELS[verdict] : '待分析';
}

/** 发行价：已定价显示单价，只有区间时显示区间。 */
export function priceText(offer: IpoOffer): string {
  const currency = offer.currency || MARKET_CURRENCY[offer.market];
  if (offer.issuePrice > 0) return fmtPrice(offer.issuePrice, currency);
  if (offer.priceLow > 0 && offer.priceHigh > 0) {
    return offer.priceLow === offer.priceHigh
      ? fmtPrice(offer.priceLow, currency)
      : `${fmtPrice(offer.priceLow, currency)} ~ ${fmtPrice(offer.priceHigh, currency)}`;
  }
  return '未定价';
}

/** 申购窗口：上游可能只给截止日或只给开始日，缺失一律显示「未提供」。 */
export function windowText(offer: IpoOffer): string {
  if (!offer.subscribeStart && !offer.subscribeEnd) return '未提供';
  return `${offer.subscribeStart || '—'} ~ ${offer.subscribeEnd || '—'}`;
}

/**
 * 胜率（AI 推算的上市后正收益概率）。
 *
 * 注意与 `winningRate`（上游公告的中签率）区分：中签率是「买不买得到」，
 * 胜率是「买到之后赚不赚」。没有 AI 结论时如实说「未评估」，不给默认值。
 */
export function winRateValue(offer: IpoOffer): string {
  return offer.winProbability > 0 ? `${fmtNum(offer.winProbability * 100, 0)}%` : '未评估';
}

export function winRateText(offer: IpoOffer): string {
  if (offer.verdict === null) return '待分析';
  if (offer.winProbability <= 0) return '胜率未评估';
  return `胜率 ${winRateValue(offer)}`;
}

/** 预期收益（AI 推算，相对发行价的涨幅 %）。0 表示未评估，不是「预期不涨」。 */
export function expectedReturnValue(offer: IpoOffer): string {
  if (!offer.verdict || offer.expectedReturn === 0) return '未评估';
  return `${offer.expectedReturn > 0 ? '+' : ''}${fmtNum(offer.expectedReturn, 1)}%`;
}

export function expectedReturnText(offer: IpoOffer): string {
  if (!offer.verdict) return '待分析';
  if (offer.expectedReturn === 0) return '预期收益未评估';
  return `预期 ${expectedReturnValue(offer)}`;
}

/** 预期收益的文本色：正值用「机会」色，负值用「风险」色（与打新徽章同一套语义）。 */
export function expectedReturnClass(offer: IpoOffer): string {
  if (!offer.verdict || offer.expectedReturn === 0) return 'mute';
  return offer.expectedReturn > 0 ? 'ipo-pos' : 'ipo-neg';
}

/**
 * 期望值（胜率 × 预期收益），仅作量级参考。
 *
 * 刻意**不乘中签率**：中签率决定「能不能买到」，把它乘进来会得到一个「每申购一次赚多少」
 * 的数字，容易被误当成「这笔打新赚多少」。这里给的是「打中一手后的期望收益」。
 */
export function expectedValueValue(offer: IpoOffer): string {
  if (!offer.verdict || offer.winProbability <= 0) return '未评估';
  const value = offer.winProbability * offer.expectedReturn;
  return `${value > 0 ? '+' : ''}${fmtNum(value, 1)}%`;
}

export function expectedValueText(offer: IpoOffer): string {
  if (!offer.verdict) return '待分析';
  if (offer.winProbability <= 0) return '期望值未评估';
  return `期望值 ${expectedValueValue(offer)}`;
}
