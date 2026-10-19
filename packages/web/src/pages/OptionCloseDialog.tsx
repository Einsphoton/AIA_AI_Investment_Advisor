/**
 * OptionCloseDialog — 买平（buy to close）一笔卖出合约。Owner: web-options.
 *
 * 提前买平是「赚权利金」的第二种收尾方式（另一种是等到期）。买平的盈亏 =
 * （卖出时每股价 − 买平价）× 乘数 × 张数 − 费用，改价格时界面上要能立刻看到。
 */
import { useEffect, useState } from 'react';
import { OPTION_STRATEGY_LABELS } from '@aia/shared';
import type { OptionPosition } from '@aia/shared';
import { api } from '../api/client';
import { toApiError } from '../api/hooks';
import { fmtDate, fmtMoney, fmtNum, fmtPrice, fmtSignedMoney, pnlClass, safeNumber, todayIso } from '../format';
import { Badge, Button, Field, Input, Modal, Textarea, useToast } from '../components/ui';
import { OPTION_STRATEGY_TONE } from './optionView';

export function OptionCloseDialog(props: {
  position: OptionPosition | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { position } = props;
  const toast = useToast();
  const [price, setPrice] = useState('');
  const [fee, setFee] = useState('0');
  const [tradeDate, setTradeDate] = useState(todayIso());
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!position) return;
    // 默认填当前中间价口径的估算：用最新标的价无法推权利金，所以留空让用户按券商成交价填。
    setPrice('');
    setFee('0');
    setTradeDate(todayIso());
    setNote('');
  }, [position]);

  const closePrice = safeNumber(price, Number.NaN);
  const estimated =
    position && Number.isFinite(closePrice)
      ? (position.premium - closePrice) * position.multiplier * position.contracts - safeNumber(fee, 0)
      : null;

  async function submit(): Promise<void> {
    if (!position) return;
    if (!Number.isFinite(closePrice) || closePrice < 0) {
      toast.error('请填写有效的买平价格（每股价）');
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.options.closePosition(position.id, {
        price: closePrice,
        fee: safeNumber(fee, 0),
        tradeDate: tradeDate || todayIso(),
        note: note.trim() || undefined,
      });
      props.onDone(
        `${result.underlyingName || result.underlyingCode} ${result.optionCode} · 已实现盈亏 ${fmtSignedMoney(
          result.realizedPnl ?? 0,
          result.currency,
        )}`,
      );
    } catch (error) {
      toast.error('买平失败', toApiError(error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={position !== null}
      title={position ? `买平卖出合约 · ${position.underlyingName || position.underlyingCode}` : '买平卖出合约'}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={submitting}>
            取消
          </Button>
          <Button variant="primary" loading={submitting} onClick={() => void submit()}>
            确认买平
          </Button>
        </>
      }
    >
      {position && (
        <div className="flex" style={{ flexDirection: 'column', gap: 12 }}>
          <div className="panel small">
            <div className="center gap-2 wrap">
              <Badge tone={OPTION_STRATEGY_TONE[position.strategy]}>{OPTION_STRATEGY_LABELS[position.strategy]}</Badge>
              <span className="mono tiny">{position.optionCode}</span>
              <span className="tiny mute">
                行权价 {fmtPrice(position.strike, position.currency)} · 到期 {fmtDate(position.expiry)} · {fmtNum(position.contracts, 0)} 张
              </span>
            </div>
            <div className="tiny mute mt-1">
              卖出时每股价 {fmtPrice(position.premium, position.currency)} · 权利金收入{' '}
              {fmtMoney(position.premiumIncome, position.currency)} · 占用担保 {fmtMoney(position.collateral, position.currency)}
            </div>
          </div>

          <div className="form-grid">
            <Field label={`买平价格（每股价，${position.currency}）`} hint="按券商实际成交价填写">
              <Input inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} />
            </Field>
            <Field label={`费用（${position.currency}）`}>
              <Input inputMode="decimal" value={fee} onChange={(event) => setFee(event.target.value)} />
            </Field>
            <Field label="交易日期">
              <Input type="date" value={tradeDate} onChange={(event) => setTradeDate(event.target.value)} />
            </Field>
          </div>

          <div className="panel">
            <div className="tiny mute">预估已实现盈亏（（卖出价 − 买平价）× 乘数 × 张数 − 费用，最终以服务端为准）</div>
            <div className={`strong mono ${pnlClass(estimated ?? 0)}`}>
              {estimated === null ? '—' : fmtSignedMoney(estimated, position.currency)}
            </div>
          </div>

          <Field label="备注（可选）">
            <Textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>

          <div className="tiny mute">
            买平后合约状态变为「已平仓」，占用担保立即释放（持股/现金不再被占用）；已实现盈亏按服务端口径重算。
          </div>
        </div>
      )}
    </Modal>
  );
}