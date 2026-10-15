/**
 * 机械落地校验 —— 凡是用算术就能判定的约束，都不要只写在提示词里等模型自觉。
 *
 * 生产审计发现三类「提示词写了、代码没管」的问题：
 *  1. 建议份额不是可交易单位（A 股 100 股整数倍 / 科创板 200 股起 / 场外基金按金额申购）；
 *  2. 单笔金额可以远超当月预算剩余（原预算闸门只判「是否用尽」，从不判额度）；
 *  3. 质量分 / 预期收益 / 目标价没有范围与一致性校验 —— 人类录入接口有，AI 路径反而没有。
 *
 * 设计原则（重要）：
 *  - **硬拦**只用于零歧义的算术约束：交易单位、预算额度、取值范围、方向自相矛盾。
 *  - **数值接地**（reason 里的精确数字能否在本次工具返回里找到）一律只做**告警**：
 *    派生值（H1 EPS 年化）、四舍五入、以及工具返回被 7000 字符截断，都会造成合理的
 *    「找不到」。宁可提示模型自我纠正，也不能误杀一条其实没问题的建议。
 *
 * Owner: agent-engine.
 */
import type { InstrumentType, Market } from '@aia/shared';

/* ─────────────────────────── ① 交易单位（整手） ─────────────────────────── */

export interface LotRule {
  /** 最小申报数量。 */
  size: number;
  /** 递增步长：100 = 整手递增，1 = 达到最小值后逐股递增。 */
  step: number;
  label: string;
}

/**
 * 可交易单位规则。返回 `null` 表示**不校验**：
 * - 港股每手股数因标的而异（100 / 200 / 500 / 1000…），没有数据源可以判定，硬编码会误杀；
 * - 美股 1 股起，没有约束；
 * - 场外基金按金额申购，不看份额。
 */
export function lotRuleFor(market: Market, type: InstrumentType, code: string): LotRule | null {
  if (market !== 'CN') return null;
  if (type === 'fund') return null;
  const clean = code.trim();
  if (/^688/.test(clean)) return { size: 200, step: 1, label: '科创板最小 200 股（达到后可 1 股递增）' };
  if (/^(4|8|92)/.test(clean)) return { size: 100, step: 100, label: '北交所最小 100 股' };
  return { size: 100, step: 100, label: 'A 股 / 场内基金最小 100 股（份）' };
}

export interface LotProblem {
  rule: LotRule;
  suggested: number;
  message: string;
}

/**
 * `null` = 通过（或该市场/品种不需校验）。
 *
 * **买入与卖出的规则不同**（很容易写错）：
 * - 买入：必须满足最小申报量且按步长递增（A 股 100 股整数倍、科创板 ≥200）。
 * - 卖出：允许「清掉零股」—— 持仓本身不足 100 股（送股/配股产生）时可以一次性全部卖出，
 *   此时强行按整手拦截会挡住合法清仓。因此卖出只在「≥ 最小单位但不是步长整数倍、
 *   且不是全部持仓」时拒绝。取不到持仓时保守放行（宁可少拦，不可误杀）。
 */
export function checkShareLot(input: {
  market: Market;
  type: InstrumentType;
  code: string;
  shares: number;
  action?: 'buy' | 'sell';
  /** 卖出时的当前持仓份额；缺省表示取不到。 */
  positionShares?: number;
}): LotProblem | null {
  const rule = lotRuleFor(input.market, input.type, input.code);
  if (!rule) return null;
  const shares = input.shares;
  if (!Number.isFinite(shares) || shares <= 0) return null; // 正数校验由调用方负责

  const isSell = input.action === 'sell';
  const atStep = (value: number): boolean =>
    rule.step === 1 ? value >= rule.size : Number.isInteger(value) && value % rule.step === 0;

  if (atStep(shares)) return null;

  if (isSell) {
    // 清掉零股：卖出量等于当前持仓（允许 1 股误差内的浮点比较）。
    const position = input.positionShares;
    if (typeof position === 'number' && position > 0 && Math.abs(shares - position) <= 1e-6) return null;
    // 小于最小申报量的卖出，更可能是零股清仓；只有明显是「半手」的量才拦。
    if (shares < rule.size) return null;
    if (typeof position !== 'number' || position <= 0) return null;
  }

  if (rule.step === 1) {
    return {
      rule,
      suggested: rule.size,
      message: `建议份额 ${shares} 不可交易：${rule.label}。请把 targetShares 改为不小于 ${rule.size}（例如 ${rule.size}）。`,
    };
  }

  const floored = Math.floor(shares / rule.step) * rule.step;
  const suggested = floored >= rule.size ? floored : rule.size;
  return {
    rule,
    suggested,
    message: `建议份额 ${shares} 不可交易：${rule.label}，必须是 ${rule.step} 的整数倍。请把 targetShares 改为 ${suggested}（或其它 ${rule.step} 的整数倍）。`,
  };
}

/* ─────────────────────────── ② 单笔金额 ≤ 预算剩余 ─────────────────────── */

export interface AmountProblem {
  /** 按剩余额度与限价能买的最大数量（供模型直接修正）。 */
  maxShares: number;
  message: string;
}

/**
 * 买入建议的额度闸门：`targetShares × targetPrice` 不得超过当月预算剩余。
 *
 * 与 `create_advice` 里既有的「预算是否用尽」是两条互补的闸门：那条只判 0/1，
 * 这条保证单笔不透支。卖出建议与 `enforceBudget=false` 不走这里。
 */
export function checkBuyAmount(input: {
  amount: number;
  remaining: number;
  currency: string;
  price: number;
}): AmountProblem | null {
  if (!Number.isFinite(input.amount) || input.amount <= 0) return null;
  if (!Number.isFinite(input.remaining)) return null;
  // 1 分钱的浮点容差：前端展示与用户心算都可能差一点。
  if (input.amount <= input.remaining + 0.01) return null;
  const maxShares = input.price > 0 ? Math.floor(input.remaining / input.price) : 0;
  return {
    maxShares,
    message:
      `本笔金额 ${round2(input.amount)} ${input.currency} 超过当月预算剩余 ${round2(input.remaining)} ${input.currency}` +
      `（targetShares × targetPrice 不得透支）。` +
      (maxShares > 0
        ? `请把 targetShares 降到 ${maxShares} 以内（按限价 ${input.price} 计算），或改出卖出建议、提示用户增加预算。`
        : '剩余额度已不足以按该限价买入任何数量，请改出卖出建议或提示用户增加预算。'),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/* ─────────────────────────── ③ 取值范围与一致性 ─────────────────────────── */

/** 返回问题描述数组（空数组 = 通过）。 */
export function checkAnalysisRanges(input: {
  qualityScore?: number;
  expectedReturn?: number;
  targetPrice?: number;
}): string[] {
  const problems: string[] = [];
  const { qualityScore, expectedReturn, targetPrice } = input;
  if (qualityScore !== undefined && (!Number.isFinite(qualityScore) || qualityScore < 0 || qualityScore > 100)) {
    problems.push(`qualityScore 必须在 0–100 之间（收到 ${qualityScore}）`);
  }
  if (expectedReturn !== undefined && (!Number.isFinite(expectedReturn) || expectedReturn < -100 || expectedReturn > 1000)) {
    problems.push(`expectedReturn 必须是 -100 到 1000 之间的百分数（收到 ${expectedReturn}）`);
  }
  if (targetPrice !== undefined && (!Number.isFinite(targetPrice) || targetPrice < 0)) {
    problems.push(`targetPrice 不能为负（收到 ${targetPrice}）`);
  }
  return problems;
}

/**
 * 目标价与预期收益的方向必须一致 —— 零歧义的算术约束。
 *
 * 只在能取到现价时校验：目标价高于现价却给负预期收益（或反之）一定是自相矛盾，
 * 这类建议会误导用户。绝对幅度不做限制（股息、汇率、分期兑现都能解释偏差）。
 */
export function checkTargetConsistency(input: {
  price: number;
  targetPrice?: number;
  expectedReturn?: number;
}): string | null {
  const { price, targetPrice, expectedReturn } = input;
  if (!Number.isFinite(price) || price <= 0) return null;
  if (targetPrice === undefined || expectedReturn === undefined) return null;
  if (!Number.isFinite(targetPrice) || !Number.isFinite(expectedReturn)) return null;

  const priceGainPct = round2(((targetPrice - price) / price) * 100);
  if (Math.abs(priceGainPct) < 0.5) return null; // 目标价≈现价，方向无从谈起
  if (priceGainPct > 0 && expectedReturn < 0) {
    return `目标价 ${targetPrice} 高于现价 ${price}（价格空间 +${priceGainPct}%），但 expectedReturn=${expectedReturn}% 为负，两者矛盾：请按「目标价相对现价的价格空间，可另加股息」统一口径。`;
  }
  if (priceGainPct < 0 && expectedReturn > 0) {
    return `目标价 ${targetPrice} 低于现价 ${price}（价格空间 ${priceGainPct}%），但 expectedReturn=${expectedReturn}% 为正，两者矛盾：请修正目标价或预期收益。`;
  }
  return null;
}

/* ───────────────────────── ④ 数值接地（只告警，不拦截） ─────────────────── */

export interface GroundingFinding {
  raw: string;
  value: number;
}

const NUMBER_RE = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g;

/** 有效数字位数（忽略符号、千分位与小数点，去掉前导零）。 */
export function significantDigits(raw: string): number {
  const digits = raw.replace(/[^\d]/g, '').replace(/^0+/, '');
  return digits.length;
}

export function extractNumbers(text: string): GroundingFinding[] {
  const out: GroundingFinding[] = [];
  if (!text) return out;
  const matches = text.match(NUMBER_RE) ?? [];
  for (const raw of matches) {
    const value = Number.parseFloat(raw.replace(/,/g, ''));
    if (Number.isFinite(value)) out.push({ raw, value });
  }
  return out;
}

/**
 * 找出「精确但找不到出处」的数字：有效数字 ≥ `minSignificantDigits`（默认 5）且
 * 在本次 run 的工具返回里没有任何数值能在四舍五入容差内匹配。
 *
 * 阈值取 5 位有效数字是刻意的：派生值（`H1 EPS 年化≈2.95`、`× 约 11.5x`、`≈ +16%`）
 * 这类手算结果通常只有 2–4 位有效数字，不会命中；而被编造的精确数字（`1941.78`、
 * `2.0861`）一定会命中。
 */
export function findUnsupportedPreciseNumbers(
  text: string,
  evidence: string,
  minSignificantDigits = 5,
  limit = 8,
): GroundingFinding[] {
  // 没有任何工具证据时无法判定（例如纯对话轮），跳过而不是全部报错。
  // 注意：这里只要求「有证据且证据里有数字」，不设长度门槛 —— 证据很少却写了
  // 一堆精确数字，本来就该被提醒。
  if (!evidence || !evidence.trim()) return [];
  const evidenceNumbers = extractNumbers(evidence).map((item) => item.value);
  if (evidenceNumbers.length === 0) return [];

  const out: GroundingFinding[] = [];
  const seen = new Set<string>();
  for (const candidate of extractNumbers(text)) {
    if (significantDigits(candidate.raw) < minSignificantDigits) continue;
    const key = String(candidate.value);
    if (seen.has(key)) continue;
    seen.add(key);
    const tolerance = Math.max(0.005, Math.abs(candidate.value) * 0.0005);
    if (evidenceNumbers.some((value) => Math.abs(value - candidate.value) <= tolerance)) continue;
    out.push(candidate);
    if (out.length >= limit) break;
  }
  return out;
}

/** 把接地发现拼成给模型看的自我纠正提示（不阻断写入）。 */
export function groundingWarning(text: string, evidence: string): string | null {
  const findings = findUnsupportedPreciseNumbers(text, evidence);
  if (findings.length === 0) return null;
  return (
    `⚠️ 数值接地提醒：以下精确数字在本次运行的工具返回中找不到出处：${findings.map((f) => f.raw).join('、')}。` +
    '如果它们是推算值，请在正文里写明推算过程（例如「按 H1 EPS 年化」）；如果是引用工具数据，请核对是否抄错。' +
    '注意：这条只是提醒，不会影响本次写入。'
  );
}
