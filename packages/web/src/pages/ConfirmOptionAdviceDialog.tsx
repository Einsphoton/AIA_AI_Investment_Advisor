/**
 * ConfirmOptionAdviceDialog — 期权卖权建议的**最终确认**弹窗。Owner: web-options.
 *
 * 与股票确认（Advice.tsx 里的 `ConfirmAdviceDialog`）刻意分开：期权确认写入的是
 * 一张卖出合约（`option_contracts`），不是股票交易流水，需要用户核对的是
 * 合约价格（每股价权利金）、合约时间（到期日）、张数与行权价 —— 这四个数任意一个
 * 变了，权利金收入与「被行权会交出/收到多少股、占用多少现金」都会跟着变。
 *
 * 因此这里做了三件事：
 *   ① 默认值来自 AI 方案（`AdviceItem.option`），但每一个都可编辑；
 *   ② 改任何一项都实时重算权利金收入 / 静态收益率 / 年化收益率（与候选指标同口径）；
 *   ③ 把「被行权后果」与「到期自动结算规则」写在按钮上方，点确认前必须能看见。
 */
import { useEffect, useState } from 'react';
import { OPTION_STRATEGY_INTENT, OPTION_STRATEGY_LABELS } from '@aia/shared';
import type { AdviceItem, OptionAdvicePlan, OptionCollateralKind } from '@aia/shared';
import { api } from '../api/client';
import { toApiError } from '../api/hooks';
import { fmtDate, fmtMoney, fmtNum, fmtPct, fmtPrice, fmtShares, safeNumber, todayIso } from '../format';
import { Alert, Badge, Button, Field, Input, Modal, Textarea, useToast } from '../components/ui';
import {
  OPTION_SETTLEMENT_RULE_TEXT,
  OPTION_STRATEGY_TONE,
  assignmentProbabilityHint,
  daysUntil,
  optionAssignmentConsequence,
  optionCollateralText,
  optionDataLine,
  optionPremiumIncome,
} from './optionView';

/** 确认弹窗里的可编辑字段（数值一律存字符串，保存时才解析校验）。 */
export interface OptionConfirmDraft {
  /** 合约价格 = 每股价权利金。 */
  premium: string;
  /** 合约时间 = 到期日（YYYY-MM-DD）。 */
  expiry: string;
  contracts: string;
  strike: string;
  fee: string;
  tradeDate: string;
  note: string;
}

export const EMPTY_OPTION_CONFIRM_DRAFT: OptionConfirmDraft = {
  premium: '',
  expiry: '',
  contracts: '',
  strike: '',
  fee: '0',
  tradeDate: '',
  note: '',
};

/** 默认值 = AI 方案（`AdviceItem.option`）；没有方案时退回建议里的等价股数/单价。 */
export function optionConfirmDraft(item: AdviceItem): OptionConfirmDraft {
  const plan = item.option;
  return {
    premium: plan ? String(plan.premium) : String(item.targetPrice ?? ''),
    expiry: plan?.expiry ?? '',
    contracts: plan ? String(plan.contracts) : String(item.targetShares ?? ''),
    strike: plan ? String(plan.strike) : '',
    fee: '0',
    tradeDate: todayIso(),
    note: '',
  };
}

export interface OptionConfirmEconomics {
  /** 权利金收入 = 每股价 × 乘数 × 张数 − 费用。 */
  income: number;
  /** 被行权要交割的股数 = 乘数 × 张数。 */
  shares: number;
  /** 占用担保：卖 Call = 对应股数市值；卖 Put = 行权价 × 乘数 × 张数。 */
  collateral: number;
  /** 静态收益率（%）= 权利金收入 / 占用资金。 */
  staticYieldPct: number;
  /** 年化收益率（%）= 静态收益率 × 365 / 剩余自然日。 */
  annualizedYieldPct: number;
  /** 剩余自然日（可能为负 = 已过期）。 */
  daysToExpiry: number;
}

/**
 * 重算确认后的经济性 —— **不沿用 AI 算好的数字**。
 *
 * 用户改价/改期/改张数后，界面必须显示「我按你的最终条件重算的结果」，
 * 否则他看到的还是建议里的旧权利金。
 */
export function optionConfirmEconomics(args: {
  premium: number;
  contracts: number;
  strike: number;
  fee: number;
  multiplier: number;
  collateralKind: OptionCollateralKind;
  underlyingPrice: number;
  expiry: string;
  now?: Date;
}): OptionConfirmEconomics {
  const multiplier = args.multiplier > 0 ? args.multiplier : 1;
  const contracts = Math.max(0, args.contracts);
  const shares = multiplier * contracts;
  const income = optionPremiumIncome(args.premium, multiplier, contracts, args.fee);
  const collateral =
    args.collateralKind === 'shares'
      ? Math.max(0, args.underlyingPrice) * shares
      : Math.max(0, args.strike) * shares;
  const staticYieldPct = collateral > 0 ? (income / collateral) * 100 : 0;
  const daysToExpiry = args.expiry ? daysUntil(args.expiry, args.now) : 0;
  const annualizedYieldPct = daysToExpiry > 0 ? (staticYieldPct * 365) / daysToExpiry : 0;
  return { income, shares, collateral, staticYieldPct, annualizedYieldPct, daysToExpiry };
}

/**
 * 弹窗正文（纯展示，导出以便无头测试）。
 *
 * `renderToString` 不支持 portal，真正的 `<Modal>` 无法在无头测试里打开，
 * 所以正文单独成组件：页面里由 `ConfirmOptionAdviceDialog` 塞进 Modal，
 * 测试里直接渲染它来核对默认值与可编辑字段。
 */
export function OptionConfirmFields(props: {
  item: AdviceItem;
  draft: OptionConfirmDraft;
  onChange: (patch: Partial<OptionConfirmDraft>) => void;
}) {
  const plan: OptionAdvicePlan | null = props.item.option;
  if (!plan) {
    return (
      <Alert tone="error">
        这条建议没有附带期权合约条件（`option` 为空），无法确认卖出合约。请重新生成建议。
      </Alert>
    );
  }
  const { draft, onChange } = props;
  const currency = plan.currency || props.item.currency;
  const multiplier = plan.multiplier > 0 ? plan.multiplier : 1;
  const economics = optionConfirmEconomics({
    premium: safeNumber(draft.premium, 0),
    contracts: safeNumber(draft.contracts, 0),
    strike: safeNumber(draft.strike, plan.strike),
    fee: safeNumber(draft.fee, 0),
    multiplier,
    collateralKind: plan.metrics.collateralKind,
    underlyingPrice: plan.underlyingPrice,
    expiry: draft.expiry,
  });
  const strike = safeNumber(draft.strike, plan.strike);

  return (
    <div className="flex" style={{ flexDirection: 'column', gap: 12 }}>
      <div className="panel small">
        <div className="between wrap gap-2">
          <span className="center gap-2">
            <Badge tone={OPTION_STRATEGY_TONE[plan.strategy]}>{OPTION_STRATEGY_LABELS[plan.strategy]}</Badge>
            <Badge tone="ai">期权</Badge>
            <span className="strong">{props.item.assetName || props.item.code}</span>
            <span className="mono tiny mute">{plan.optionCode}</span>
          </span>
          <span className="tiny mute">
            {props.item.market} · 标的现价 {fmtPrice(plan.underlyingPrice, currency)}
          </span>
        </div>
        <div className="tiny muted mt-1">{OPTION_STRATEGY_INTENT[plan.strategy]}</div>
        <div className="tiny mute mt-1">
          AI 建议：行权价 {fmtPrice(plan.strike, currency)} · 到期 {fmtDate(plan.expiry)} · {fmtNum(plan.contracts, 0)} 张 · 每股价权利金{' '}
          {fmtPrice(plan.premium, currency)}（当前 {fmtNum(multiplier, 0)} 股/张）
        </div>
        <div className="tiny mute mt-1">数据口径：{optionDataLine(plan)}</div>
      </div>

      {/* 最终确认语义 + 不可逆提示：必须写在可编辑字段上方，用户先看到再填。 */}
      <Alert tone="warn">
        <div className="strong">最终确认：提交后立即按下方条件建立卖出合约</div>
        <div className="tiny mt-1">
          这一步不经过券商，只是把合约登记进「期权卖权」页跟踪权利金与到期结算。
          <b>请按券商里实际成交的价格与到期日填写</b>；提交后不能修改合约条件，只能买平或等待到期结算。
        </div>
      </Alert>

      <div className="form-grid">
        <Field
          label={`合约价格（每股价权利金，${currency}）`}
          hint="默认是 AI 建议价；按券商实际成交价改，权利金收入会随之重算"
        >
          <Input inputMode="decimal" value={draft.premium} onChange={(event) => onChange({ premium: event.target.value })} />
        </Field>
        <Field label="合约时间（到期日）" hint="默认来自建议；按券商里的实际到期日改（港股到期日是按合约月推算的）">
          <Input type="date" value={draft.expiry} onChange={(event) => onChange({ expiry: event.target.value })} />
        </Field>
        <Field label="张数（卖出合约数量）">
          <Input inputMode="numeric" value={draft.contracts} onChange={(event) => onChange({ contracts: event.target.value })} />
        </Field>
        <Field label={`行权价（${currency}）`} hint="默认建议值；改行权价会改变被行权概率与占用担保">
          <Input inputMode="decimal" value={draft.strike} onChange={(event) => onChange({ strike: event.target.value })} />
        </Field>
        <Field label={`费用（${currency}）`} hint="佣金 + 交易所费用合计，从权利金收入里扣除">
          <Input inputMode="decimal" value={draft.fee} onChange={(event) => onChange({ fee: event.target.value })} />
        </Field>
        <Field label="交易日期">
          <Input type="date" value={draft.tradeDate} onChange={(event) => onChange({ tradeDate: event.target.value })} />
        </Field>
      </div>

      {/* 用「最终条件」重算的数字，不是 AI 算好的旧数字。 */}
      <div className="panel">
        <div className="strong small mb-2">按最终条件重算</div>
        <div className="grid-4">
          <div>
            <div className="tiny mute">权利金收入</div>
            <div className="strong mono">{fmtMoney(economics.income, currency)}</div>
            <div className="tiny mute">
              {fmtPrice(safeNumber(draft.premium, 0), currency)} × {fmtNum(multiplier, 0)} 股/张 ×{' '}
              {fmtNum(safeNumber(draft.contracts, 0), 0)} 张 − 费用 {fmtMoney(safeNumber(draft.fee, 0), currency)}
            </div>
          </div>
          <div>
            <div className="tiny mute">占用担保</div>
            <div className="strong mono">{fmtMoney(economics.collateral, currency)}</div>
            <div className="tiny mute">
              {plan.metrics.collateralKind === 'shares'
                ? `需持股 ${fmtShares(economics.shares)} 股`
                : `现金 = 行权价 × ${fmtNum(multiplier, 0)} × ${fmtNum(safeNumber(draft.contracts, 0), 0)}`}
            </div>
          </div>
          <div>
            <div className="tiny mute">静态收益率</div>
            <div className="strong mono">{fmtPct(economics.staticYieldPct, 2, false)}</div>
            <div className="tiny mute">权利金收入 / 占用担保</div>
          </div>
          <div>
            <div className="tiny mute">年化收益率</div>
            <div className="strong mono">{fmtPct(economics.annualizedYieldPct, 2, false)}</div>
            <div className="tiny mute">
              {economics.daysToExpiry > 0 ? `剩余 ${economics.daysToExpiry} 天` : '已过期 / 未填到期日，不做年化'}
            </div>
          </div>
        </div>
        <div className="tiny mute mt-2">
          {fmtPct(plan.metrics.assignmentProbability * 100, 1, false)} · {assignmentProbabilityHint(props.item.market)} ·{' '}
          {optionCollateralText(plan)} · 盈亏平衡价 {fmtPrice(plan.metrics.breakeven, currency)}
        </div>
      </div>

      {/* 被行权后果：把股数与现金写死，避免「可能被行权」这种无法决策的提示。 */}
      <Alert tone="error">
        <div className="strong">被行权后果（不可逆）</div>
        <div className="tiny mt-1">
          {optionAssignmentConsequence({
            optionType: plan.optionType,
            strike,
            multiplier,
            contracts: safeNumber(draft.contracts, 0),
            currency,
            collateralNote: plan.collateralNote,
          })}
        </div>
        {plan.warnings.length > 0 && (
          <ul className="tiny mt-1" style={{ margin: 0, paddingLeft: 18 }}>
            {plan.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
      </Alert>

      <div className="tiny mute">
        <b>到期自动结算规则：</b>
        {OPTION_SETTLEMENT_RULE_TEXT}
      </div>

      <Field label="备注（可选）" hint="例如「券商成交号」「是否与建议一致」">
        <Textarea rows={2} value={draft.note} onChange={(event) => onChange({ note: event.target.value })} />
      </Field>
    </div>
  );
}

/** 最终确认弹窗：默认值来自 AI 方案，四个关键字段都可改，提交走 confirm-option。 */
export function ConfirmOptionAdviceDialog(props: {
  item: AdviceItem | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { item } = props;
  const toast = useToast();
  const [draft, setDraft] = useState<OptionConfirmDraft>(EMPTY_OPTION_CONFIRM_DRAFT);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (item) setDraft(optionConfirmDraft(item));
  }, [item]);

  async function submit(): Promise<void> {
    if (!item?.option) return;
    const contracts = safeNumber(draft.contracts, Number.NaN);
    const premium = safeNumber(draft.premium, Number.NaN);
    const strike = safeNumber(draft.strike, Number.NaN);
    if (!Number.isFinite(contracts) || contracts <= 0) {
      toast.error('请填写有效的张数');
      return;
    }
    if (!Number.isFinite(premium) || premium <= 0) {
      toast.error('请填写有效的合约价格（每股价权利金）', '最后确认的价格必须与券商成交价一致');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.expiry)) {
      toast.error('请填写有效的合约时间（到期日）');
      return;
    }
    if (!Number.isFinite(strike) || strike <= 0) {
      toast.error('请填写有效的行权价');
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.advice.confirmOption(item.id, {
        contracts,
        premium,
        expiry: draft.expiry,
        strike,
        fee: safeNumber(draft.fee, 0),
        tradeDate: draft.tradeDate || todayIso(),
        note: draft.note.trim() || undefined,
      });
      for (const warning of result.warnings) toast.warn('卖出合约已建立，但有一条提醒', warning);
      props.onDone(
        `已建立卖出合约：${result.position.optionCode} · ${OPTION_STRATEGY_LABELS[result.position.strategy]} · ${fmtNum(
          result.position.contracts,
          0,
        )} 张`,
      );
    } catch (error) {
      toast.error('确认失败', toApiError(error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={item !== null}
      size="md"
      title={item ? `最终确认卖出合约 · ${item.assetName || item.code}` : '最终确认卖出合约'}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={submitting}>
            取消
          </Button>
          <Button variant="danger" loading={submitting} onClick={() => void submit()}>
            最终确认并卖出
          </Button>
        </>
      }
    >
      {item && (
        <OptionConfirmFields
          item={item}
          draft={draft}
          onChange={(patch) => setDraft((previous) => ({ ...previous, ...patch }))}
        />
      )}
    </Modal>
  );
}
