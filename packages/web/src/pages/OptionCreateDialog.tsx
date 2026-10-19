/**
 * OptionCreateDialog — 手工登记一笔卖出合约（计划外成交时补录）。Owner: web-options.
 *
 * 用途：用户直接在券商 App 卖了期权，或者 AI 没建议（池外标的）但自己想收权利金。
 * 登记后与 AI 建议确认的合约走**同一条**跟踪链路：权利金、担保占用、到期结算。
 */
import { useState } from 'react';
import { OPTION_STRATEGY_INTENT, OPTION_STRATEGY_LABELS, OPTION_TYPE_LABELS, US_OPTION_MULTIPLIER } from '@aia/shared';
import type { OptionMarket, OptionStrategy, OptionType } from '@aia/shared';
import { api } from '../api/client';
import { toApiError } from '../api/hooks';
import { fmtMoney, fmtPrice, fmtShares, safeNumber, todayIso } from '../format';
import { Alert, Badge, Button, Field, Input, Modal, Segmented, Textarea, useToast } from '../components/ui';
import { OPTION_STRATEGY_TONE, expiryCountdown, optionAssignmentConsequence } from './optionView';

export function OptionCreateDialog(props: { open: boolean; onClose: () => void; onDone: (message: string) => void }) {
  const { open, onClose } = props;
  const toast = useToast();
  const [market, setMarket] = useState<OptionMarket>('US');
  const [code, setCode] = useState('');
  const [underlyingName, setUnderlyingName] = useState('');
  const [strategy, setStrategy] = useState<OptionStrategy>('covered_call');
  const [optionType, setOptionType] = useState<OptionType>('call');
  const [optionCode, setOptionCode] = useState('');
  const [strike, setStrike] = useState('');
  const [expiry, setExpiry] = useState('');
  const [contracts, setContracts] = useState('');
  const [premium, setPremium] = useState('');
  const [fee, setFee] = useState('0');
  const [multiplier, setMultiplier] = useState(String(US_OPTION_MULTIPLIER));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const currency = market === 'HK' ? 'HKD' : 'USD';
  const strikeValue = safeNumber(strike, 0);
  const contractsValue = safeNumber(contracts, 0);
  const multiplierValue = safeNumber(multiplier, market === 'US' ? US_OPTION_MULTIPLIER : 0) || 0;
  const shares = multiplierValue * contractsValue;
  const collateral = strategy === 'cash_secured_put' ? strikeValue * shares : 0;

  /** 切换市场时把乘数改成该市场的常用值（港股各标的乘数不同，允许手改）。 */
  function pickMarket(next: OptionMarket): void {
    setMarket(next);
    setMultiplier(next === 'US' ? String(US_OPTION_MULTIPLIER) : '100');
  }

  function reset(): void {
    setCode('');
    setUnderlyingName('');
    setOptionCode('');
    setStrike('');
    setExpiry('');
    setContracts('');
    setPremium('');
    setFee('0');
    setNote('');
  }

  async function submit(): Promise<void> {
    if (!code.trim()) {
      toast.error('请填写标的代码');
      return;
    }
    if (!optionCode.trim()) {
      toast.error('请填写合约代码', '合约代码用来与券商对账，建议照抄券商里的合约标识');
      return;
    }
    if (strikeValue <= 0) {
      toast.error('请填写有效的行权价');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
      toast.error('请填写有效的到期日');
      return;
    }
    if (contractsValue <= 0) {
      toast.error('请填写有效的张数');
      return;
    }
    if (safeNumber(premium, 0) <= 0) {
      toast.error('请填写有效的每股价权利金');
      return;
    }
    setBusy(true);
    try {
      const created = await api.options.createPosition({
        market,
        code: code.trim(),
        underlyingName: underlyingName.trim() || undefined,
        strategy,
        optionType,
        optionCode: optionCode.trim(),
        strike: strikeValue,
        expiry,
        contracts: contractsValue,
        premium: safeNumber(premium, 0),
        fee: safeNumber(fee, 0),
        multiplier: multiplierValue > 0 ? multiplierValue : undefined,
        tradeDate: todayIso(),
        note: note.trim() || undefined,
      });
      toast.success('已登记卖出合约', `${created.optionCode} · 权利金收入 ${fmtMoney(created.premiumIncome, created.currency)}`);
      reset();
      props.onDone(`${created.underlyingName || created.underlyingCode} ${created.optionCode}`);
    } catch (error) {
      toast.error('登记失败', toApiError(error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      size="lg"
      title="手工登记卖出合约"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            登记
          </Button>
        </>
      }
    >
      <div className="flex" style={{ flexDirection: 'column', gap: 12 }}>
        <Alert tone="info">
          这里登记的是**已经真实成交**的卖出合约（计划外成交补录）。登记后系统会跟踪权利金、担保占用与到期结算，
          到期结论明确时自动入账、存疑时进入「待确认结算」。
        </Alert>

        <Segmented
          value={market}
          onChange={pickMarket}
          options={[
            { value: 'US' as OptionMarket, label: '美股' },
            { value: 'HK' as OptionMarket, label: '港股' },
          ]}
        />

        <div className="form-grid">
          <Field label="标的代码" hint="港股 5 位数字（00700）/ 美股 ticker（AAPL）">
            <Input value={code} onChange={(event) => setCode(event.target.value)} placeholder="AAPL / 00700" />
          </Field>
          <Field label="标的名称（可选）">
            <Input value={underlyingName} onChange={(event) => setUnderlyingName(event.target.value)} />
          </Field>
          <Field label="合约代码" hint="券商里的合约标识，例如 AAPL261120C00250000">
            <Input value={optionCode} onChange={(event) => setOptionCode(event.target.value)} />
          </Field>
          <Field label={`行权价（${currency}）`}>
            <Input inputMode="decimal" value={strike} onChange={(event) => setStrike(event.target.value)} />
          </Field>
          <Field label="到期日">
            <Input type="date" value={expiry} onChange={(event) => setExpiry(event.target.value)} />
          </Field>
          <Field label="张数">
            <Input inputMode="numeric" value={contracts} onChange={(event) => setContracts(event.target.value)} />
          </Field>
          <Field label={`每股价权利金（${currency}）`}>
            <Input inputMode="decimal" value={premium} onChange={(event) => setPremium(event.target.value)} />
          </Field>
          <Field label={`费用（${currency}）`}>
            <Input inputMode="decimal" value={fee} onChange={(event) => setFee(event.target.value)} />
          </Field>
          <Field label="合约乘数（股/张）" hint="美股标准 100；港股各标的乘数不同，请照券商合约规格填写">
            <Input inputMode="numeric" value={multiplier} onChange={(event) => setMultiplier(event.target.value)} />
          </Field>
        </div>

        <div className="panel small">
          <div className="center gap-2 wrap">
            <Badge tone={OPTION_STRATEGY_TONE[strategy]}>{OPTION_STRATEGY_LABELS[strategy]}</Badge>
            <Segmented
              value={strategy}
              onChange={(value) => {
                setStrategy(value);
                setOptionType(value === 'covered_call' ? 'call' : 'put');
              }}
              options={[
                { value: 'covered_call' as OptionStrategy, label: OPTION_STRATEGY_LABELS.covered_call },
                { value: 'cash_secured_put' as OptionStrategy, label: OPTION_STRATEGY_LABELS.cash_secured_put },
              ]}
            />
            <Segmented
              value={optionType}
              onChange={setOptionType}
              options={[
                { value: 'call' as OptionType, label: OPTION_TYPE_LABELS.call },
                { value: 'put' as OptionType, label: OPTION_TYPE_LABELS.put },
              ]}
            />
          </div>
          <div className="tiny muted mt-1">{OPTION_STRATEGY_INTENT[strategy]}</div>
          <div className="tiny mute mt-1">
            权利金收入 = {fmtPrice(safeNumber(premium, 0), currency)} × {multiplierValue || '—'} 股/张 × {contractsValue || '—'} 张 − 费用{' '}
            {fmtMoney(safeNumber(fee, 0), currency)}
            {expiry ? ` · ${expiryCountdown(expiry)}` : ''}
          </div>
          <div className="tiny mute mt-1">
            被行权需交割 {fmtShares(shares)} 股
            {strategy === 'cash_secured_put' ? `，占用现金 ${fmtMoney(collateral, currency)}` : '（担保来自「我的资产」持股）'}
          </div>
          {strikeValue > 0 && contractsValue > 0 && (
            <div className="tiny warn mt-1">
              {optionAssignmentConsequence({
                optionType,
                strike: strikeValue,
                multiplier: multiplierValue,
                contracts: contractsValue,
                currency,
              })}
            </div>
          )}
        </div>

        <Field label="备注（可选）">
          <Textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}