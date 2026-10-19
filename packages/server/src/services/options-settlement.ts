/**
 * 期权到期结算引擎 —— 「到期后自动跟踪行权并更新我的资产」的唯一写账本路径。
 *
 * 用户最担心的两件事，在代码里的落地方式：
 *  1. **到底会不会自动更新我的资产**：`settings.option.settlementMode='auto'` 且结论明确时，
 *     资产/流水**当场写入**（覆盖式卖 Call 被行权 → 按行权价卖出交割股数；现金担保卖 Put
 *     被行权 → 按行权价买入收股），与打新中签入账同理：真实现金/股票已发生，账必须记上，
 *     **不受当月预算拦截**（预算是 AI 买入建议的约束，不是记账的约束）。
 *  2. **数据准不准**：每条结算记录都带 `referencePrice`（参考价）与 `priceSource`（口径与日期），
 *     以及可读 `note`（为什么这样判、为什么转人工）。取不到参考价、价格贴行权价、交股缺口
 *     一律转 `pending_review`，**绝不用 0 或猜测值掩盖**。
 *
 * 判定口径（`OPTION_SETTLEMENT_RULES`）：
 *  - `itmAmount`：call = 参考价 − 行权价；put = 行权价 − 参考价。
 *  - `itmAmount < minItmAmount(0.01)` → `otm_no_assignment`（虚值到期，权利金全额落袋）。
 *  - 否则 `assigned`（实值行权）。
 *  - `|参考价 − 行权价| / 行权价 × 100 < uncertainBandPct(0.5%)` → `uncertain` + 待确认：
 *    收盘价四舍五入、结算价口径差异、跨假期取不到当日价都可能把结论翻面。
 *  - 参考价来源：美股 = 日线序列里「到期日或之后第一个交易日」的收盘价（source 写明来源与日期）；
 *    港股 = 优先 HKEX 每日收市报告的 CLOSING PRICE（从到期日**往前**逐日回退，最多 10 个自然日，
 *    实际使用的日期必须写进 priceSource），取不到再回退日线（并 warning）。
 *
 * 【口径来源与局限（不要写成「已实测」）】
 *  - 港股：到期日 = HKEX 报告 CONTRACT 列（`DDMMMYY`，实测 7 个月度到期日与「合约月最后营业日
 *    的前一营业日」规则 9/9 吻合），所以**到期日是精确的**，只有参考价取不到才转待确认；
 *    港交所每日报告只有结算价/收市价，没有买卖盘（上层指标据此降级）。
 *  - 美股：**依据公开规则**（美式行权、100 股/张实物交割、OCC ExByEx 实值 ≥ $0.01 自动行权），
 *    官方页（OCC/Cboe/SEC）本机请求被 WAF 403 拦截，**未实测**。因此这 0.01 只作为「最小实值
 *    门槛」，贴行权价（0.5% 带内）仍转人工确认 —— 不能把未实测的规则当成 100% 事实。
 *
 * 幂等与并发（写路径的三道锁）：
 *  - **只按 contract_id upsert 一条结算记录**，重复扫描不会产生第二条；
 *  - `auto_settled`/`confirmed` 的记录永不重写、重复扫描什么都不做（流水只写一次）；
 *  - 整个扫描持有 `pipeline-lock`（label `option-settlement:scan`）：定时器拿不到锁就跳过本轮，
 *    手工路由拿不到锁返回 409；参考价抓取（有 await）在锁内完成，而「读结算行状态 → 判定 →
 *    写 transactions → 更新合约/结算行」全部放在**同一个 `repo.transaction`** 内且中间无 await，
 *    因此在单线程事件循环下不可能与「用户手动确认」重叠出第二笔流水。
 *
 * Owner: server-core（期权卖权）。
 */
import crypto from 'node:crypto';

import {
  MARKET_CURRENCY,
  OPTION_SETTLEMENT_RULES,
  type OptionSettlement,
  type OptionSettlementMode,
  type OptionSettlementRunResult,
  type OptionSettlementStatus,
  type OptionSettlementVerdict,
} from '@aia/shared';

import { conflict, notFound } from '../errors.js';
import { getRepo } from '../registry.js';
import type { Repo } from '../types/repo.js';
import type { AssetRow, NewOptionSettlement, OptionContractRow, OptionSettlementRow } from '../types/models.js';
import { isOffline, localDate, nowIso, round4, toNumber } from '../db/util.js';
import { getSeries } from '../datasources/registry.js';
import { hkUnderlyingClose } from '../datasources/options.js';
import { runExclusive } from './pipeline-lock.js';
import { computePosition } from './portfolio.js';
import { calendarDaysBetween, datePart, toOptionSettlement, unverifiedHkMultiplierWarning } from './options.js';

/** 流水线锁标签：出现在 409 的 reason 里，用户能看出「是谁在跑」。 */
const LOCK_LABEL = 'option-settlement:scan';

/** 结算记录 action 的取值（与 shared 的 OptionSettlement.action 一致）。 */
type SettlementAction = OptionSettlementRow['action'];

/** 一条可追溯的结算参考价。 */
export interface OptionReferencePrice {
  /** 参考价（每股，本币）；<=0 表示没取到（调用方转 uncertain）。 */
  price: number;
  /** 口径与来源，例如「日线收盘价（eastmoney）2026-01-16」「HKEX 每日收市报告（到期日 2026-01-16）」。 */
  priceSource: string;
  /** 取价过程中的降级说明（例如跨假期改用之后第一个交易日）。 */
  warnings?: string[];
}

export interface SettlementScanOptions {
  /** 结算基准日（`YYYY-MM-DD`，默认今天）：只处理 `expiry <= asOf` 的 open 合约。 */
  asOf?: string;
  /** 只结算这一个合约（`POST /api/options/positions/:id/settle` 用）。 */
  contractId?: string;
  /** 强制重新取价：默认同一天已评估过的记录跳过（避免 30s 轮询反复打上游）。 */
  force?: boolean;
  /** 覆盖结算模式（默认取 `settings.option.settlementMode`）。 */
  mode?: OptionSettlementMode;
  /**
   * 手工路由传 true：拿不到流水线锁时抛 409（把持有者 label 原样告诉用户）。
   * 定时器路径不传：拿不到锁只记一条 warning 并跳过本轮，下次再试。
   */
  throwOnBusy?: boolean;
  /** 注入点：测试可传假的参考价解析器，避免联网（与 services/ipo.ts 的 `collect` 注入同理）。 */
  resolveReference?: (contract: OptionContractRow, asOf: string) => Promise<OptionReferencePrice | null>;
}

/* ─────────────────────────────── 扫描入口 ────────────────────────────────── */

/**
 * 扫描到期合约并结算（幂等）。
 *
 * 返回值 `scanned` = 本轮**取出待评估**的到期 open 合约数（含被幂等跳过的），
 * `settlements` = 这些合约当前最新的结算记录（新建的与已存在的都算）。
 */
export async function scanOptionSettlements(
  options: SettlementScanOptions = {},
): Promise<OptionSettlementRunResult> {
  const outcome = await runExclusive(LOCK_LABEL, () => scanLocked(options));
  if (!outcome.ok) {
    if (options.throwOnBusy) throw conflict(outcome.reason);
    // 定时器路径：跳过本轮，不排队、不抛错。
    return { scanned: 0, autoSettled: 0, pendingReview: 0, settlements: [], warnings: [outcome.reason] };
  }
  return outcome.value;
}

async function scanLocked(options: SettlementScanOptions): Promise<OptionSettlementRunResult> {
  const repo = getRepo();
  const asOf = options.asOf && /^\d{4}-\d{2}-\d{2}$/.test(options.asOf) ? options.asOf : localDate();
  const mode: OptionSettlementMode = options.mode ?? readSettlementMode(repo);
  const warnings: string[] = [];

  const due = collectDueContracts(repo, options, asOf, warnings);
  const resolve = options.resolveReference ?? defaultReferenceResolver;
  const evaluations: { contract: OptionContractRow; reference: OptionReferencePrice | null }[] = [];

  // 阶段一（可以有 await）：取参考价。锁已持有，所以不会与 AI 流水线并发打上游。
  for (const contract of due) {
    const existing = repo.findOptionSettlementByContract(contract.id);
    if (skipSettlement(existing, options.force, asOf)) continue;
    let reference: OptionReferencePrice | null = null;
    try {
      reference = await resolve(contract, asOf);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${contract.optionCode} 参考价获取失败：${message}`);
    }
    if (reference?.warnings?.length) warnings.push(...reference.warnings);
    evaluations.push({ contract, reference });
  }

  // 阶段二（必须无 await）：读状态 → 判定 → 写流水 → 更新合约/结算行，全部在一个事务里。
  let autoSettled = 0;
  let pendingReview = 0;
  for (const { contract, reference } of evaluations) {
    const outcome = repo.transaction(() =>
      settleContract(repo, contract, reference, { asOf, mode, warnings }),
    );
    if (outcome.wroteLedger) autoSettled += 1;
    else if (outcome.row.status === 'pending_review') pendingReview += 1;
  }

  const settlements = due
    .map((contract) => repo.findOptionSettlementByContract(contract.id))
    .filter((row): row is OptionSettlementRow => row !== undefined)
    .map(toOptionSettlement);

  return {
    scanned: due.length,
    autoSettled,
    pendingReview,
    settlements,
    warnings: [...new Set(warnings)],
  };
}

/** 幂等短路：已入账的永不重写；已忽略的要 `force` 才会重看；同一天已评估过的不重复取价。 */
function skipSettlement(
  existing: OptionSettlementRow | undefined,
  force: boolean | undefined,
  asOf: string,
): boolean {
  if (!existing) return false;
  if (existing.status === 'auto_settled' || existing.status === 'confirmed') return true;
  // dismissed = 用户已处理（例如已在券商端自行交割）：扫描器不再擅自改写，除非显式 force。
  if (existing.status === 'dismissed' && !force) return true;
  if (!force && datePart(existing.evaluatedAt) === asOf) return true;
  return false;
}

/** 取出本轮要评估的到期合约（只处理 status='open' 且 expiry ≤ asOf）。 */
function collectDueContracts(
  repo: Repo,
  options: SettlementScanOptions,
  asOf: string,
  warnings: string[],
): OptionContractRow[] {
  if (options.contractId) {
    const row = repo.getOptionContract(options.contractId);
    if (!row) throw notFound(`期权合约不存在：${options.contractId}`);
    if (row.status !== 'open') {
      warnings.push(`合约 ${row.optionCode} 状态为 ${row.status}，无需结算。`);
      return [];
    }
    if (datePart(row.expiry) > asOf) {
      warnings.push(`合约 ${row.optionCode} 到期日 ${row.expiry} 还未到（基准日 ${asOf}），本次不结算。`);
      return [];
    }
    return [row];
  }
  return repo.listOptionContracts({ status: 'open', expiringOnOrBefore: asOf });
}

/** 结算模式：读设置失败时退回 `manual`（宁可不自动入账，也不能猜）。 */
function readSettlementMode(repo: Repo): OptionSettlementMode {
  try {
    return repo.getSettings().option?.settlementMode === 'manual' ? 'manual' : 'auto';
  } catch {
    return 'manual';
  }
}

/* ───────────────────────────── 单合约结算（事务内） ──────────────────────── */

interface SettleContext {
  asOf: string;
  mode: OptionSettlementMode;
  warnings: string[];
  /** 人工确认路径：强制结论并按自动路径入账（跳过自动判定的存疑带）。 */
  override?: {
    verdict: OptionSettlementVerdict;
    referencePrice?: number;
    note?: string;
  };
}

interface SettleOutcome {
  row: OptionSettlementRow;
  /** 本轮是否已结清（`auto_settled` 或人工确认的 `confirmed`）= 计入「已入账」的次数。 */
  wroteLedger: boolean;
}

/**
 * 判定并（在允许时）入账一个合约。**调用方必须已经开好 `repo.transaction`**，
 * 本函数内部只有同步调用：这样「读结算行状态 → 写流水」是原子的。
 */
function settleContract(
  repo: Repo,
  contract: OptionContractRow,
  reference: OptionReferencePrice | null,
  context: SettleContext,
): SettleOutcome {
  const existing = repo.findOptionSettlementByContract(contract.id);
  if (existing && (existing.status === 'auto_settled' || existing.status === 'confirmed')) {
    // 二次防线：即使上游漏掉了 skipSettlement，这里也绝不重复写流水。
    return { row: existing, wroteLedger: false };
  }

  const now = nowIso();
  const strike = toNumber(contract.strike);
  const rawMultiplier = toNumber(contract.multiplier);
  const multiplier = rawMultiplier > 0 ? rawMultiplier : 0;
  const contracts = toNumber(contract.contracts);
  // multiplier=0 时 shares 一定是 0 —— 不能拿它当结论，见下方「乘数缺失」分支。
  const shares = multiplier * contracts;
  const premiumIncome = toNumber(contract.premiumIncome);
  const referencePrice = context.override?.referencePrice ?? (reference ? toNumber(reference.price) : 0);
  const priceSource =
    context.override?.referencePrice !== undefined
      ? `${reference?.priceSource ?? existing?.priceSource ?? '原结算记录'}（人工确认覆盖参考价 ${round4(context.override.referencePrice)}）`
      : reference?.priceSource ?? '未取得参考价（美股日线与港股 HKEX 收市价均不可用）';

  // 港股乘数未经核对时，结算记录里必须写明：行权交割股数、权利金收入都基于估算乘数。
  const multiplierWarning = unverifiedHkMultiplierWarning(contract.market, contract.underlyingCode, multiplier);
  if (multiplierWarning) context.warnings.push(`${contract.optionCode}：${multiplierWarning}`);

  // ── 判定 ──────────────────────────────────────────────────────────────
  let verdict: OptionSettlementVerdict;
  let itmAmount = 0;
  let itmPct = 0;
  let reason: string;
  if (!(multiplier > 0) || !(contracts > 0)) {
    // 数据异常优先于任何结论（含人工判定）：乘数/张数缺失时**交割股数算不出来**，
    // 若按 1 股兜底会把「交 500 股」写成「交 1 股」，账本会出现无法解释的错误持仓。
    // 与 minItmAmount / uncertainBandPct 同一原则：零歧义算术之外一律转人工。
    verdict = 'uncertain';
    reason =
      !(multiplier > 0)
        ? '合约乘数缺失或为 0（数据异常），无法计算交割股数，转人工确认'
        : '合约张数缺失或为 0（数据异常），无法计算交割股数，转人工确认';
    context.warnings.push(`${contract.optionCode}：${reason}（multiplier=${round4(multiplier)}，contracts=${round4(contracts)}）`);
  } else if (context.override) {
    verdict = context.override.verdict;
    if (referencePrice > 0) {
      itmAmount = contract.optionType === 'call' ? referencePrice - strike : strike - referencePrice;
      itmPct = strike > 0 ? (Math.abs(itmAmount) / strike) * 100 : 0;
    }
    reason = `人工确认判定为「${verdict === 'assigned' ? '实值行权' : '虚值到期'}」`;
    if (context.override.note) reason += `（${context.override.note}）`;
    if (referencePrice > 0 && strike > 0) {
      const distancePct = (Math.abs(referencePrice - strike) / strike) * 100;
      if (verdict === 'assigned' && itmAmount < OPTION_SETTLEMENT_RULES.minItmAmount) {
        reason += `；注意：按参考价 ${round4(referencePrice)} 计算实值金额为 ${round4(itmAmount)}（低于 ${OPTION_SETTLEMENT_RULES.minItmAmount}），人工判定与参考价口径不一致，已按人工判定入账`;
      } else if (verdict === 'otm_no_assignment' && itmAmount >= OPTION_SETTLEMENT_RULES.minItmAmount) {
        reason += `；注意：按参考价 ${round4(referencePrice)} 计算实值金额为 ${round4(itmAmount)}（≥ ${OPTION_SETTLEMENT_RULES.minItmAmount}），人工判定为虚值落袋，已按人工判定入账`;
      } else if (distancePct < OPTION_SETTLEMENT_RULES.uncertainBandPct) {
        reason += `；该价格贴行权价（相距 ${round4(distancePct)}%），人工判定已覆盖自动口径`;
      }
    }
  } else if (!(referencePrice > 0)) {
    verdict = 'uncertain';
    reason = `取不到到期日参考价（${priceSource}），无法判定行权与否，转人工确认（不猜）`;
  } else {
    itmAmount = contract.optionType === 'call' ? referencePrice - strike : strike - referencePrice;
    itmPct = strike > 0 ? (Math.abs(itmAmount) / strike) * 100 : 0;
    const distancePct = strike > 0 ? (Math.abs(referencePrice - strike) / strike) * 100 : 0;
    if (strike <= 0) {
      verdict = 'uncertain';
      reason = '行权价缺失或为 0，无法判定行权与否，转人工确认';
    } else if (distancePct < OPTION_SETTLEMENT_RULES.uncertainBandPct) {
      verdict = 'uncertain';
      reason =
        `参考价 ${round4(referencePrice)} 与行权价 ${round4(strike)} 仅相距 ${round4(distancePct)}%` +
        `（< ${OPTION_SETTLEMENT_RULES.uncertainBandPct}% 存疑带），收盘价四舍五入/结算口径差异/跨假期都可能把结论翻面，转人工确认`;
    } else if (itmAmount < OPTION_SETTLEMENT_RULES.minItmAmount) {
      verdict = 'otm_no_assignment';
      reason =
        `参考价 ${round4(referencePrice)} 对 ${contract.optionType === 'call' ? 'Call' : 'Put'} 为虚值 ` +
        `${round4(Math.abs(itmAmount))}（< ${OPTION_SETTLEMENT_RULES.minItmAmount}），不会被行权，权利金全额落袋`;
    } else {
      verdict = 'assigned';
      reason =
        `参考价 ${round4(referencePrice)} 对 ${contract.optionType === 'call' ? 'Call' : 'Put'} 为实值 ` +
        `${round4(itmAmount)}（占行权价 ${round4(itmPct)}%），按行权价 ${round4(strike)} 交割` +
        (contract.market === 'US'
          ? '（美股口径依据公开规则：美式行权、实值 ≥ $0.01 自动行权、100 股/张实物交割；该规则未实测，故贴行权价一律转人工）'
          : '');
    }
  }

  // ── 入账动作 ───────────────────────────────────────────────────────────
  let status: OptionSettlementStatus;
  let action: SettlementAction;
  let transactionId: string | null = null;
  let assetId: string | null = null;
  let realizedPnl = 0;
  let note = `${reason}。参考价口径：${priceSource}。`;
  // 结清状态区分**谁**结清的：人工点「确认并入账」→ confirmed；系统自动判定 → auto_settled。
  // 两者在幂等判断里等价（isSettledStatus），但界面/审计必须能看出「这条是人确认的」。
  const settledStatus: OptionSettlementStatus = context.override ? 'confirmed' : 'auto_settled';

  if (verdict === 'uncertain') {
    status = 'pending_review';
    action = 'pending';
    note += ' 处理建议：核对券商端的到期结果后，用「确认并入账」或「忽略」结掉这条。';
  } else if (verdict === 'otm_no_assignment') {
    status = context.mode === 'auto' ? settledStatus : 'pending_review';
    action = context.mode === 'auto' ? 'none' : 'pending';
    realizedPnl = premiumIncome;
    note += ` 权利金收入 ${round4(premiumIncome)} 视为已实现（股票端无交割）。`;
    if (context.mode !== 'auto') note += ' 当前结算模式为 manual：等待你在页面上确认后才算落袋。';
  } else if (contract.strategy === 'covered_call') {
    // 被行权 = 按行权价交股。先在账本上核对股数，不够就绝不写流水（否则会写出负持仓）。
    const sharesRow = shares;
    const asset =
      (contract.underlyingAssetId ? repo.getAsset(contract.underlyingAssetId) : undefined) ??
      repo.findAsset(contract.underlyingCode, contract.market, 'stock') ??
      repo.findAsset(contract.underlyingCode, contract.market, 'etf');
    const heldShares = asset ? computePosition(repo.listTransactions(asset.id)).shares : 0;
    const avgCost = asset ? computePosition(repo.listTransactions(asset.id)).avgCost : 0;
    const deliveryPnl = round4((strike - avgCost) * sharesRow);
    realizedPnl = round4(premiumIncome + deliveryPnl);
    if (!asset || heldShares + 1e-6 < sharesRow) {
      status = 'pending_review';
      action = 'pending';
      note +=
        ` 应被行权需交付 ${sharesRow} 股，但账本${asset ? `仅 ${heldShares} 股` : '里没有该标的持仓'}` +
        `（缺口 ${round4(Math.max(0, sharesRow - heldShares))} 股）。为避免写出负持仓，本次不写股票流水：` +
        '如你已在券商端自行交股，请忽略这条结算；否则请先在「我的资产」补录持股后重新确认。';
    } else if (context.mode !== 'auto') {
      status = 'pending_review';
      action = 'pending';
      assetId = asset.id;
      note +=
        ` 当前结算模式为 manual：确认后将按行权价 ${round4(strike)} 卖出 ${sharesRow} 股（交割盈亏按成本 ${round4(avgCost)} 计约 ${deliveryPnl}）。`;
    } else {
      const tx = repo.addTransaction({
        id: crypto.randomUUID(),
        assetId: asset.id,
        kind: 'sell',
        shares: sharesRow,
        price: strike,
        fee: 0,
        // 交割发生在到期日；参考价可能取到期日之后第一个交易日，仅用于判定（口径已写在 priceSource）。
        tradeDate: datePart(contract.expiry),
        note: `期权行权交股：${contract.optionCode} 被行权，按行权价 ${round4(strike)} 卖出 ${sharesRow} 股（来源：到期结算 ${priceSource}）`,
        source: 'option',
        createdAt: now,
      });
      status = settledStatus;
      action = 'shares_delivered';
      transactionId = tx.id;
      assetId = asset.id;
      note += ` 已按行权价 ${round4(strike)} 写入股票卖出流水 ${sharesRow} 股（交割盈亏约 ${deliveryPnl}），权利金 ${round4(premiumIncome)} 已实现。`;
    }
  } else {
    // 现金担保卖 Put 被行权 = 按行权价收股（真实现金支出，不受当月预算拦截）。
    const sharesRow = shares;
    realizedPnl = premiumIncome; // 收股成本即行权价，未卖出前股票端不产生盈亏（契约口径）。
    const asset =
      (contract.underlyingAssetId ? repo.getAsset(contract.underlyingAssetId) : undefined) ??
      repo.findAsset(contract.underlyingCode, contract.market, 'stock') ??
      repo.findAsset(contract.underlyingCode, contract.market, 'etf');
    if (context.mode !== 'auto') {
      status = 'pending_review';
      action = 'pending';
      assetId = asset?.id ?? null;
      note += ` 当前结算模式为 manual：确认后将按行权价 ${round4(strike)} 买入 ${sharesRow} 股（收股）。`;
    } else {
      const created = asset ?? tryCreateUnderlyingAsset(repo, contract, strike, now, context.warnings);
      if (!created) {
        // 兜底：连资产都建不出来时绝不硬写流水（写进去就是一笔无法解释的持仓）。
        status = 'pending_review';
        action = 'pending';
        note += ' 收股时无法定位/创建标的资产（可能与既有记录存在同代码同市场同类型的冲突），为避免重复入账未写任何流水，请核对后重新确认。';
      } else {
        const tx = repo.addTransaction({
          id: crypto.randomUUID(),
          assetId: created.id,
          kind: 'buy',
          shares: sharesRow,
          price: strike,
          fee: 0,
          tradeDate: datePart(contract.expiry),
          note: `期权行权收股：${contract.optionCode} 被行权，按行权价 ${round4(strike)} 买入 ${sharesRow} 股（现金担保卖 Put；来源：到期结算 ${priceSource}）`,
          source: 'option',
          createdAt: now,
        });
        status = settledStatus;
        action = 'shares_received';
        transactionId = tx.id;
        assetId = created.id;
        note += ` 已按行权价 ${round4(strike)} 写入买入流水 ${sharesRow} 股（现金支出 ${round4(strike * sharesRow)} ${created.currency}，不受当月预算拦截），权利金 ${round4(premiumIncome)} 已实现。`;
        // 可用现金设置与实际占用的差额只提醒、不阻断（账已经发生了）。
        const cash = safeOptionCash(repo, contract.market);
        if (cash > 0 && strike * sharesRow > cash + 1e-6) {
          context.warnings.push(
            `${contract.underlyingCode} 行权占用 ${round4(strike * sharesRow)} 超过设置里的「期权可用现金」${round4(cash)}，请核对账户实际现金。`,
          );
        }
      }
    }
  }

  // ── 落库（同一事务内：结算记录 upsert + 合约状态） ─────────────────────
  if (multiplierWarning) note += ` 注意：${multiplierWarning}。`;
  const row = repo.upsertOptionSettlement({
    id: existing?.id ?? crypto.randomUUID(),
    contractId: contract.id,
    expiry: contract.expiry,
    evaluatedAt: now,
    referencePrice: round4(referencePrice),
    priceSource,
    verdict,
    itmAmount: round4(itmAmount),
    itmPct: round4(itmPct),
    status,
    action,
    transactionId,
    assetId,
    realizedPnl: round4(realizedPnl),
    note,
    createdAt: existing?.createdAt ?? now,
  } satisfies NewOptionSettlement);

  // 只有真正结清了（自动入账或人工确认）才动合约状态；待确认时合约仍是 open，避免
  // 用户在页面上看到「已到期」却还没入账的矛盾状态。
  if (isSettledStatus(status)) {
    repo.updateOptionContract(contract.id, {
      status: verdict === 'assigned' ? 'assigned' : 'expired_otm',
      realizedPnl: round4(realizedPnl),
      updatedAt: now,
    });
  }

  return { row, wroteLedger: isSettledStatus(status) };
}

function safeOptionCash(repo: Repo, market: OptionContractRow['market']): number {
  try {
    return toNumber(repo.getSettings().option?.cash?.[market]);
  } catch {
    return 0;
  }
}

/**
 * 建标的资产，撞唯一约束时不炸也不重复入账：
 * `createAsset` 已把 UNIQUE(code,market,type) 冲突包成 409（不会 500），但用户真正需要的是
 * 「收股成功」。所以这里重查一次：命中就复用（只记 warning），仍拿不到就返回 null，
 * 由调用方转 `pending_review` 且**一笔流水都不写**（宁可让人核对，也不能写重复买入）。
 */
function tryCreateUnderlyingAsset(
  repo: Repo,
  contract: OptionContractRow,
  strike: number,
  now: string,
  warnings: string[],
): AssetRow | null {
  try {
    return repo.createAsset({
      id: crypto.randomUUID(),
      name: contract.underlyingName || contract.underlyingCode,
      code: contract.underlyingCode,
      market: contract.market,
      type: 'stock',
      source: 'manual',
      currency: MARKET_CURRENCY[contract.market] ?? contract.currency,
      note: `期权行权收股（${contract.optionCode}）`,
      price: strike,
      priceAt: now,
      prevClose: strike,
      dayChangePct: 0,
      spark: [],
      createdAt: now,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retried =
      repo.findAsset(contract.underlyingCode, contract.market, 'stock') ??
      repo.findAsset(contract.underlyingCode, contract.market, 'etf');
    if (retried) {
      warnings.push(
        `${contract.underlyingCode} 收股时建资产提示已存在（${message}），已复用既有资产 ${retried.id}，不重复建仓。`,
      );
      return retried;
    }
    warnings.push(`${contract.underlyingCode} 收股建资产失败：${message}`);
    return null;
  }
}

/** 是否已真正结清（入账/人工确认）：只有这两种状态才允许改动合约状态。 */
function isSettledStatus(status: OptionSettlementStatus): boolean {
  return status === 'auto_settled' || status === 'confirmed';
}

/* ─────────────────────────── 人工确认 / 忽略 ─────────────────────────────── */

export interface ConfirmOptionSettlementInput {
  id: string;
  verdict: 'assigned' | 'otm_no_assignment';
  referencePrice?: number;
  note?: string;
}

/**
 * 人工确认一条待确认结算记录，**按自动路径入账**（该写流水就写流水）。
 *
 * 为什么不抢流水线锁：与既有 `POST /api/advice/:id/confirm`（股票确认）保持一致 ——
 * 请求内的写路径只要求「读状态 → 写」在同一个事务里，幂等由状态检查保证。
 * 已入账的记录再次确认只返回现状（不重复写流水），沿用「幂等」而非 409 的语义：
 * **原状态保持不变**（人工确认过的仍是 `confirmed`，系统自动入账的仍是 `auto_settled`），
 * 只补一条 warning 说明没有重复写流水。
 */
export function confirmOptionSettlement(input: ConfirmOptionSettlementInput): OptionSettlementRunResult {
  const repo = getRepo();
  const id = (input.id ?? '').trim();
  if (!id) throw conflict('结算记录 id 不能为空');
  if (input.verdict !== 'assigned' && input.verdict !== 'otm_no_assignment') {
    throw conflict('判定只能是 assigned（实值行权）或 otm_no_assignment（虚值落袋）');
  }
  const referenceOverride = input.referencePrice === undefined ? undefined : toNumber(input.referencePrice);
  if (referenceOverride !== undefined && !(referenceOverride > 0)) {
    throw conflict('覆盖的参考价必须大于 0');
  }

  const warnings: string[] = [];
  const row = repo.getOptionSettlement(id);
  if (!row) throw notFound(`结算记录不存在：${id}`);
  if (row.status === 'auto_settled' || row.status === 'confirmed') {
    return {
      scanned: 1,
      autoSettled: 0,
      pendingReview: 0,
      settlements: [toOptionSettlement(row)],
      warnings: ['该结算记录已经入账，本次没有重复写股票流水（幂等）。'],
    };
  }
  if (row.status === 'dismissed') {
    throw conflict('该结算记录已被忽略，无法再次确认；如需重新入账请联系管理员用 force 重扫或改用手工登记');
  }
  const contract = repo.getOptionContract(row.contractId);
  if (!contract) throw notFound(`结算记录对应的合约不存在：${row.contractId}`);

  const referencePrice = referenceOverride ?? toNumber(row.referencePrice);
  const reference: OptionReferencePrice = {
    price: referencePrice,
    priceSource: referencePrice > 0 ? row.priceSource : '未取得参考价（人工确认时也未提供）',
  };

  const outcome = repo.transaction(() =>
    settleContract(repo, contract, reference, {
      asOf: localDate(),
      mode: 'auto',
      warnings,
      override: { verdict: input.verdict, referencePrice: referenceOverride, note: input.note },
    }),
  );
  if (outcome.row.status === 'pending_review') {
    // 例如覆盖式卖 Call 交股缺口：人工确认了也写不了流水，必须让用户看到原因。
    warnings.push(outcome.row.note);
  }
  return {
    scanned: 1,
    autoSettled: outcome.wroteLedger ? 1 : 0,
    pendingReview: outcome.row.status === 'pending_review' ? 1 : 0,
    settlements: [toOptionSettlement(outcome.row)],
    warnings: [...new Set(warnings)],
  };
}

/** 忽略一条结算记录（用户已在券商端处理，或交易所临时调整）。已入账的不能忽略（会留下无来源的流水）。 */
export function dismissOptionSettlement(input: { id: string; note?: string }): OptionSettlement {
  const repo = getRepo();
  const id = (input.id ?? '').trim();
  const row = repo.getOptionSettlement(id);
  if (!row) throw notFound(`结算记录不存在：${id}`);
  if (row.status === 'auto_settled' || row.status === 'confirmed') {
    throw conflict('该结算记录已经入账，忽略不会撤销已写入的股票流水；请先在「我的资产」里处理对应交易');
  }
  return repo.transaction(() => {
    const patched = repo.updateOptionSettlement(row.id, {
      status: 'dismissed',
      evaluatedAt: nowIso(),
      note: [row.note, `用户已忽略：${input.note ?? '已在券商端处理'}`, `（原参考价口径：${row.priceSource}）`]
        .filter((part) => part && part.trim() !== '')
        .join('；'),
    });
    if (!patched) throw notFound(`结算记录不存在：${row.id}`);
    return toOptionSettlement(patched);
  });
}

/* ─────────────────────────────── 参考价解析 ─────────────────────────────── */

/** 港股取不到到期日报告时，往前回退的最大自然日数（覆盖周末 + 长假）。 */
const HK_CLOSE_LOOKBACK_DAYS = 10;

/** `YYYY-MM-DD` 偏移 `days` 天（UTC 零点算法，夏令时/时区不影响日期）。 */
function shiftDate(date: string, days: number): string {
  const at = Date.parse(`${datePart(date)}T00:00:00Z`);
  if (!Number.isFinite(at)) return datePart(date);
  return new Date(at + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 默认参考价解析器。
 *
 *  - 港股：优先 `hkUnderlyingClose`（HKEX 每日收市报告的 CLOSING PRICE，官方收市口径）。
 *    港交所对非交易日返回 404，所以从到期日**往前逐日回退**（最多 10 个自然日），
 *    并把**实际使用的日期**写进 priceSource 与 warning —— 用户要能核对「你用的是哪天的价」。
 *    取不到再回退日线收盘价（并 warning）。
 *  - 美股：日线序列里「到期日或之后第一个交易日」的收盘价（source 写明来源与日期）。
 *
 * 取不到任何价格时返回 price=0 + 说明，调用方据此转 `uncertain` + 待确认 —— 不猜、不用 0 冒充。
 */
async function defaultReferenceResolver(
  contract: OptionContractRow,
  asOf: string,
): Promise<OptionReferencePrice> {
  const expiry = datePart(contract.expiry);
  const warnings: string[] = [];

  if (isOffline()) {
    // 离线/断网时不假装结清了：转人工确认，并把原因写清楚（测试与内网部署都会走这里）。
    return {
      price: 0,
      priceSource: '离线模式（AIA_OFFLINE=1）未取参考价',
      warnings: ['离线模式（AIA_OFFLINE=1）：不联网取到期参考价，本次判定转人工确认。'],
    };
  }

  if (contract.market === 'HK') {
    for (let back = 0; back <= HK_CLOSE_LOOKBACK_DAYS; back += 1) {
      const date = shiftDate(expiry, -back);
      try {
        const close = await hkUnderlyingClose({ code: contract.underlyingCode, date });
        if (close && toNumber(close.price) > 0) {
          if (back > 0) {
            warnings.push(
              `到期日 ${expiry} 读不到 HKEX 每日收市报告（非交易日/假期），参考价向前回退 ${back} 天，` +
                `使用 ${date} 的 CLOSING PRICE ${round4(toNumber(close.price))}。`,
            );
          }
          return {
            price: toNumber(close.price),
            priceSource:
              `${close.source || 'HKEX 每日收市报告'}（${date} CLOSING PRICE` +
              `${back > 0 ? `，到期日 ${expiry} 无报告，向前回退 ${back} 天` : ''}）`,
            warnings,
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`HKEX ${date} 每日收市报告获取失败：${message}`);
      }
    }
    warnings.push(`HKEX 每日收市报告在 ${expiry} 起向前 ${HK_CLOSE_LOOKBACK_DAYS} 天内都取不到 ${contract.underlyingCode} 的收市价。`);
    const fallback = await seriesClose(contract, asOf, warnings);
    if (fallback) return { ...fallback, warnings };
    return { price: 0, priceSource: '未取得参考价（HKEX 收市价与日线均不可用）', warnings };
  }

  const fallback = await seriesClose(contract, asOf, warnings);
  if (fallback) return { ...fallback, warnings };
  return { price: 0, priceSource: '未取得参考价（美股日线序列不可用）', warnings };
}

/**
 * 日线序列里「到期日或之后第一个交易日、且不晚于基准日」的收盘价。
 *
 * 为什么要「之后第一个交易日」：到期日常常是周五/假期，上游那天的收盘价就是缺失的，
 * 而结算口径本来就是拿到期日的收盘价；假期顺延到下一个交易日必须在 source 里写清楚。
 */
async function seriesClose(
  contract: OptionContractRow,
  asOf: string,
  warnings: string[],
): Promise<OptionReferencePrice | null> {
  const expiry = datePart(contract.expiry);
  let result: Awaited<ReturnType<typeof getSeries>> = null;
  try {
    result = await getSeries({
      code: contract.underlyingCode,
      market: contract.market,
      type: 'stock',
      range: '6m',
      interval: 'day',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`${contract.underlyingCode} 日线序列获取失败：${message}`);
    return null;
  }
  if (!result) {
    warnings.push(`${contract.underlyingCode} 日线序列不可用（所有行情源均失败）。`);
    return null;
  }
  const points = result.value.points.filter((point) => Number.isFinite(point.close) && toNumber(point.close) > 0);
  const chosen = points.find((point) => point.date >= expiry && point.date <= asOf);
  if (!chosen) {
    warnings.push(
      `${contract.underlyingCode} 的日线序列里没有 ${expiry} 起、${asOf} 之前的收盘价（可能数据源只给近端区间，或当天还没出收盘）。`,
    );
    return null;
  }
  const source = result.sources.join('/') || '行情源';
  if (chosen.date !== expiry) {
    warnings.push(
      `到期日 ${expiry} 没有行情（非交易日/假期），参考价取之后第一个交易日 ${chosen.date} 的收盘价（结算口径差异请留意）。`,
    );
  }
  return {
    price: toNumber(chosen.close),
    priceSource: `日线收盘价（${source}）${chosen.date}`,
  };
}

/* ─────────────────────────────── 定时器 ─────────────────────────────────── */

/** 启动后先等 30s（避开启动高峰：迁移/首屏刷新都在抢 CPU），之后每 6 小时跑一次。 */
const INITIAL_DELAY_MS = 30_000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

let initialTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;

/**
 * 启动到期结算定时器（**幂等**：重复调用不会叠加计时器）。
 *
 * 为什么需要定时器而不是只靠手工点击：到期日往往在用户不看应用的那几天，
 * 而「到期后自动跟踪行权并更新我的资产」是明确承诺的能力。
 */
export function startOptionSettlementTimer(): void {
  if (initialTimer || intervalTimer) return;
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void runTimerScan('启动后 30s');
  }, INITIAL_DELAY_MS);
  initialTimer.unref?.();
  intervalTimer = setInterval(() => void runTimerScan('每 6 小时'), INTERVAL_MS);
  intervalTimer.unref?.();
}

/** 停止定时器（进程退出/测试收尾用；之后可以再次 start）。 */
export function stopOptionSettlementTimer(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}

/**
 * 定时器回调：拿不到流水线锁只记 warning 并跳过（下次再试），绝不排队、绝不抛错。
 * 定时任务没有 HTTP 响应可回，所以走 console（进程日志环形缓冲会收走）。
 */
async function runTimerScan(reason: string): Promise<void> {
  try {
    const result = await scanOptionSettlements();
    for (const warning of result.warnings) console.warn(`[options] 到期结算（${reason}）：${warning}`);
    if (result.scanned > 0) {
      console.info(
        `[options] 到期结算扫描（${reason}）：到期合约 ${result.scanned} 个，自动入账 ${result.autoSettled}，待确认 ${result.pendingReview}。`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[options] 到期结算扫描失败（${reason}）：${message}`);
  }
}

/** 距离到期还有多少自然日（给测试与调用方复用；已过期为负数）。 */
export function settlementDaysToExpiry(expiry: string, asOf: string = localDate()): number {
  return calendarDaysBetween(asOf, datePart(expiry, asOf));
}