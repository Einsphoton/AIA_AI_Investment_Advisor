/**
 * 期权卖权设置卡片 — owner: web-options.
 *
 * 两个必须由用户填的数字 / 选择：
 *   · 各市场可用现金：现金担保卖 Put 的担保额度。本应用不跟踪证券账户现金余额，
 *     所以只能由用户填写；填 0 = 未填写，此时不会给出覆盖不了的卖 Put。
 *   · 到期结算模式：auto = 结论明确自动入账、存疑转待确认；manual = 全部转待确认。
 *
 * 这是草稿 + 保存模式（与设置页其它卡片一致），改动只在点「保存设置」后生效。
 */
import { Checkbox, Field, Input, Segmented, Badge, Card } from '../components/ui';
import { fmtMoney, fmtPrice, safeNumber } from '../format';
import type { OptionDraft } from './settingsDraft';

/** 现金能覆盖的合约规模提示（按 100 股/张估算；实际乘数取决于合约）。 */
function coverageHint(cashText: string, currency: string): string {
  const cash = safeNumber(cashText, 0);
  if (!Number.isFinite(cash) || cash <= 0) return '未填写现金：不会给出「被行权也覆盖得起」的现金担保卖 Put。';
  const maxStrike = cash / 100;
  return `按 100 股/张估算：约可覆盖 1 张行权价 ≤ ${fmtPrice(maxStrike, currency)} 的卖 Put（占用 = 行权价 × 乘数 × 张数）。`;
}

export function OptionSettingsCard(props: { value: OptionDraft; onChange: (next: OptionDraft) => void }) {
  const value = props.value;
  return (
    <Card
      title={
        <span className="center gap-2">
          期权卖权
          <Badge tone={value.settlementMode === 'auto' ? 'ok' : 'warn'}>
            {value.settlementMode === 'auto' ? '明确自动入账' : '全部待确认'}
          </Badge>
          {!value.runWithPipeline && <Badge tone="manual">不随建议流水线跑</Badge>}
        </span>
      }
      actions={<span className="tiny mute">只做港股 / 美股期权（A 股无个股期权）</span>}
    >
      <div className="tiny mute mb-3">
        卖期权的两条底线写在这里：<b>现金担保卖 Put 必须被现金完全覆盖</b>，以及
        <b>到期结算要不要自动入账</b>。应用本身不跟踪证券账户余额，所以可用现金必须由你填写；
        填 0 视为未填写，此时建议端不会给出覆盖不了的卖 Put。
      </div>

      <div className="form-grid">
        <Field label="港股可用现金（HKD）" hint="现金担保卖 Put 的担保额度；0 = 未填写">
          <Input
            inputMode="decimal"
            value={value.cashHK}
            onChange={(event) => props.onChange({ ...value, cashHK: event.target.value })}
          />
        </Field>
        <Field label="美股可用现金（USD）" hint="现金担保卖 Put 的担保额度；0 = 未填写">
          <Input
            inputMode="decimal"
            value={value.cashUS}
            onChange={(event) => props.onChange({ ...value, cashUS: event.target.value })}
          />
        </Field>
      </div>
      <div className="tiny mute mt-1">
        HK$ {fmtMoney(safeNumber(value.cashHK, 0), 'HKD', 0)} · {coverageHint(value.cashHK, 'HKD')}
      </div>
      <div className="tiny mute mt-1">
        $ {fmtMoney(safeNumber(value.cashUS, 0), 'USD', 0)} · {coverageHint(value.cashUS, 'USD')}
      </div>

      <div className="divider" />

      <div className="small strong">到期结算模式</div>
      <div className="mt-2">
        <Segmented
          value={value.settlementMode}
          onChange={(mode) => props.onChange({ ...value, settlementMode: mode })}
          options={[
            { value: 'auto' as const, label: '明确自动入账 · 存疑待确认' },
            { value: 'manual' as const, label: '全部待确认' },
          ]}
        />
      </div>
      <div className="field-hint mt-1">
        auto：虚值到期或实值距离明确时，结算器直接把股票交割流水写进「我的资产」；贴行权价、取不到结算价、
        跨假期等模糊情况一律转「待确认结算」。manual：任何情况都只生成待确认记录，确认后才入账。
      </div>

      <div className="divider" />

      <Checkbox
        checked={value.runWithPipeline}
        onChange={(checked) => props.onChange({ ...value, runWithPipeline: checked })}
        label="随「AI 投资建议」流水线一起跑期权卖权分析"
      />
      <div className="field-hint mt-1">
        关闭后，点「AI 投资建议」只跑资产 → 标的 → 打新 → 建议，不会产出期权建议；
        仍可在「AI 投资建议」页或「期权卖权」页点「AI 期权卖权建议」单独跑一次。
      </div>
    </Card>
  );
}