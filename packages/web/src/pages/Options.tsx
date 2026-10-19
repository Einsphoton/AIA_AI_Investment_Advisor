/**
 * OptionsPage — 期权卖权（港股 / 美股）。Owner: web-options.
 *
 * 三件事：
 *   ① 看清在手合约：权利金、浮盈、担保占用、剩余天数与被行权风险（买平入口）；
 *   ② 到期结算必须有人负责：结论明确的自动入账，存疑的一条条摆在「待确认结算」区，
 *      确认时才写进「我的资产」（交股 / 收股）；
 *   ③ 价格来源与延迟口径显眼：港股是 HKEX 每日收市报告、美股默认 CBOE 延迟行情，
 *      用户有权知道这些数字是不是实时价。
 *
 * SSE 联动：AI 期权卖权建议（`POST /api/options/analyze`）写库后由全局
 * `useAgentRefresh` 触发本页刷新，推理过程显示在右下角面板。
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MARKET_LABELS, OPTION_SETTLEMENT_ACTION_LABELS, OPTION_SETTLEMENT_STATUS_LABELS, OPTION_SETTLEMENT_VERDICT_LABELS, OPTION_SOURCE_LABELS, OPTION_STRATEGY_LABELS, OPTION_TYPE_LABELS } from '@aia/shared';
import type {
  OptionCandidatesResponse,
  OptionChainSnapshot,
  OptionMarket,
  OptionPosition,
  OptionPortfolioSummary,
  OptionSettlement,
} from '@aia/shared';
import { api, type OptionSettlementQueryStatus } from '../api/client';
import { useAgentActivity, useAgentRefresh } from '../api/agentActivity';
import { toApiError, useAsync } from '../api/hooks';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, fmtPct, fmtPrice, fmtSignedMoney, pnlClass, safeNumber } from '../format';
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  ErrorAlert,
  Field,
  Input,
  Loading,
  MarketTag,
  Segmented,
  StatCard,
  useToast,
} from '../components/ui';
import { OptionCandidatePanel, OptionChainPanel } from './OptionChainPanel';
import { OptionCloseDialog } from './OptionCloseDialog';
import { OptionCreateDialog } from './OptionCreateDialog';
import {
  OPTION_POSITION_TONE,
  OPTION_SETTLEMENT_STATUS_TONE,
  OPTION_SETTLEMENT_VERDICT_TONE,
  OPTION_STRATEGY_TONE,
  expiryCountdown,
  settlementReferenceText,
} from './optionView';

const SETTLEMENT_FILTERS: { value: OptionSettlementQueryStatus; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'pending_review', label: '待确认' },
  { value: 'auto_settled', label: '已自动入账' },
  { value: 'confirmed', label: '已确认' },
  { value: 'dismissed', label: '已忽略' },
];

/** 市场 → 合约货币（期权只做港股/美股）。 */
const OPTION_MARKET_CURRENCY: Record<OptionMarket, string> = { HK: 'HKD', US: 'USD' };

/* ───────────────────────────── ① 顶部 KPI ───────────────────────────── */

export function OptionKpiGrid(props: { summary: OptionPortfolioSummary | null }) {
  const summary = props.summary;
  return (
    <div className="stat-grid">
      <StatCard label="在手合约" value={fmtNum(summary?.openContracts ?? 0, 0)} sub="卖出后未到期、未平仓" />
      <StatCard
        label="权利金总收入"
        value={fmtMoney(summary?.premiumIncome ?? 0, undefined, 2)}
        sub="在手合约合计（已扣费用）"
        hint="各市场原币直接相加，仅用于数量级参考；分市场请见下方担保占用。"
      />
      <StatCard
        label="已实现权利金"
        value={fmtMoney(summary?.realizedPremium ?? 0, undefined, 2)}
        sub="到期落袋 + 提前买平"
        tone={(summary?.realizedPremium ?? 0) > 0 ? 'pos' : 'default'}
      />
      <StatCard
        label="被行权次数"
        value={fmtNum(summary?.assignedCount ?? 0, 0)}
        sub="到期实值被行权（已交股 / 收股）"
        tone={(summary?.assignedCount ?? 0) > 0 ? 'neg' : 'default'}
      />
      <StatCard
        label="待确认结算"
        value={fmtNum(summary?.pendingSettlements ?? 0, 0)}
        sub="必须人工确认后才入账"
        tone={(summary?.pendingSettlements ?? 0) > 0 ? 'neg' : 'default'}
      />
      {(summary?.collateralByMarket ?? []).map((row) => (
        <StatCard
          key={`${row.market}-${row.currency}`}
          label={`担保占用 · ${MARKET_LABELS[row.market] ?? row.market}`}
          value={fmtMoney(row.amount, row.currency, 0)}
          sub="卖 Call 的持股市值 + 卖 Put 的占用现金"
          hint="覆盖式卖 Call 占用的是持股，现金担保卖 Put 占用的是现金。"
        />
      ))}
    </div>
  );
}

/* ───────────────── ② 前置条件自检（为什么这里是空的） ───────────────── */

/**
 * 「为什么期权卖权页什么都没有」的现场解释。
 *
 * 存在的理由：本页是**合约/结算管理页**，只有确认过建议（或手工登记）后才有内容；
 * 而 AI 的卖权建议是**从担保物推导**出来的（卖 Call 要港股/美股持股，卖 Put 要现金），
 * 没有担保物时它会明确说「没有可分析的标的」并且不写任何建议 —— 用户看不到这句话，
 * 只会看到空页面，就会以为功能坏了。所以把三个前置条件和「建议在哪个页面看」直接摆在页首。
 *
 * 刻意不在这里算「最多能卖几张」：港股合约乘数 ≠ 每手股数（实测 9988/1810/3690 是 5 倍），
 * 张数必须由服务端按合约乘数机械校验，前端算会算出漂亮但错误的数字。
 */
export function OptionReadinessPanel(props: {
  holdings: { code: string; name: string; market: OptionMarket; shares: number }[];
  cash: { HK: number; US: number };
  pendingAdvice: number;
  loading?: boolean;
}) {
  const { holdings, cash, pendingAdvice, loading } = props;
  const hkCash = safeNumber(cash.HK);
  const usCash = safeNumber(cash.US);
  const putReady = hkCash > 0 || usCash > 0;
  const callReady = holdings.length > 0;
  const nothingSellable = !callReady && !putReady;

  return (
    <Card
      title={
        <span className="center gap-2">
          卖权前置条件自检
          {nothingSellable && <Badge tone="warn">当前没有可卖权的担保物</Badge>}
        </span>
      }
      actions={
        <Link className="tiny" to="/advice">
          去「AI 投资建议」页 →
        </Link>
      }
    >
      {loading ? (
        <Loading label="正在核对持仓与期权设置…" />
      ) : (
        <>
          <div className="tiny mute mb-2">
            本页只管理<b>已确认的卖出合约</b>与<b>到期结算</b>。AI 的卖权建议不在这里，而是出现在「AI 投资建议」页；
            在那里点「确认」后，合约才会进入下面的「在手卖出合约」。
          </div>

          {nothingSellable && (
            <div className="mb-2">
              <Alert tone="warn">
                <div>
                  <b>所以现在跑「AI 期权卖权建议」不会产生任何建议，这不是故障：</b>
                  卖权建议是从担保物推导出来的（覆盖式卖 Call 要港股/美股持股，现金担保卖 Put 要现金），
                  两个都没有时，AI 只会报告「没有可分析的标的」，不会凭空给出行权价、权利金或年化收益率。
                  <b>你只要填了任一市场的「期权可用现金」，卖 Put 就能跑</b>（标的从观察池里挑）。
                </div>
              </Alert>
            </div>
          )}

          <div className="flex" style={{ flexDirection: 'column', gap: 8 }}>
            <div className="small">
              <b>{callReady ? '✅' : '⚠️'} 覆盖式卖 Call 的担保物（港股/美股持股）</b>
              {callReady ? (
                <div className="tiny mute mt-1">
                  {holdings.map((item) => `${MARKET_LABELS[item.market] ?? item.market} ${item.code} ${item.name} ${fmtNum(item.shares, 0)} 股`).join('；')}
                  。具体能卖几张由服务端按<b>合约乘数</b>校验（港股乘数 ≠ 每手股数）。
                </div>
              ) : (
                <div className="tiny mute mt-1">
                  「我的资产」里没有港股/美股持仓 → 覆盖式卖 Call 没有可覆盖的股票，卖无担保的 Call 就是裸卖（风险无上限），系统不会给这种建议。
                  A 股没有个股期权，<b>不能</b>用 A 股持股做覆盖式卖 Call。
                  <b>这不影响现金担保卖 Put</b>：卖 Put 的担保物是现金，标的由 AI 从「观察池」的港股/美股里选（不需要先持股）。
                </div>
              )}
            </div>

            <div className="small">
              <b>{putReady ? '✅' : '⚠️'} 现金担保卖 Put 的可用现金（设置 → 期权卖权）</b>
              <div className="tiny mute mt-1">
                HK {fmtMoney(hkCash, 'HKD', 2)} · US {fmtMoney(usCash, 'USD', 2)}
                {putReady
                  ? '。卖 Put 会按「行权价 × 乘数 × 张数」占用现金，被行权时必须能全额接股，因此现金不足的张数会被拒绝并告诉你最多能做几笔；标的由 AI 从「观察池」的港股/美股里挑（不需要先持股）。'
                  : '。两项都是 0，等于没有现金担保 → 现金担保卖 Put 一律不产生候选（避免被行权时接不住）。'}
              </div>
              {!putReady && (
                <div className="tiny mt-1">
                  <Link to="/settings">去设置页填写各市场「期权可用现金」→</Link>
                </div>
              )}
            </div>

            <div className="small">
              <b>{pendingAdvice > 0 ? '✅' : 'ℹ️'} 期权卖权建议在哪看</b>
              <div className="tiny mute mt-1">
                {pendingAdvice > 0
                  ? `已有 ${pendingAdvice} 条期权卖权建议在「AI 投资建议」页等你确认/驳回；确认时需要最终核对合约价格与到期日。`
                  : '当前没有待处理的期权卖权建议。上方两个前置条件满足后，点本页右上角「AI 期权卖权建议」即可生成。'}
              </div>
            </div>
          </div>

          <div className="tiny mute mt-2">
            到期后的跟踪：系统按日扫描到期合约，<b>结论明确就自动入账</b>（交股/收股直接写入「我的资产」，来源标记为期权），
            <b>贴行权价或取不到参考价则转「待确认结算」</b>，由你核对券商结果后确认；每条记录都带参考价与其来源口径。
          </div>
        </>
      )}
    </Card>
  );
}

/* ───────────────────── ③ 价格来源与延迟口径（显眼） ───────────────────── */

export function OptionSourceNotice(props: { warnings?: string[] }) {
  const warnings = props.warnings ?? [];
  return (
    <Card title="数据来源与口径">
      <div className="tiny">
        <b>卖权的定价完全依赖下面这些行情数字，所以先把口径说清楚：</b>
      </div>
      <div className="small mt-1">
        港股期权链来自 <b>{OPTION_SOURCE_LABELS.hkex}</b>（每日收市报告，<b>收盘口径、非实时</b>）；
        美股默认 <b>{OPTION_SOURCE_LABELS.cboe}</b>（<b>延迟行情</b>，上游响应体未标注延迟时长，所以我们也不声称具体分钟数），失败时回退 {OPTION_SOURCE_LABELS.nasdaq}。
        每条建议卡片与期权链快照都会标注「来源 · 抓取时间 · 是否延迟」，延迟口径会显示为
        <Badge tone="warn">延迟 / 收盘口径（非实时）</Badge>。
      </div>
      <div className="tiny mute mt-2">
        权利金按「每股价 × 合约乘数 × 张数 − 费用」计算；港股各标的合约乘数不同，未核对的标的会回退按 100 股/张估算并在
        warnings 里明确写出。到期结算用的是到期日收盘价 / HKEX 结算价，不是盘中价。
      </div>
      {warnings.length > 0 && (
        <div className="mt-2">
          <Alert tone="warn">
            <div>取数时有以下问题（数字可能不完整，必须原样告知）：</div>
            <ul className="tiny" style={{ margin: '4px 0 0 16px' }}>
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </Alert>
        </div>
      )}
    </Card>
  );
}

/* ───────────────────────── ③ 待确认结算（醒目） ───────────────────────── */

interface SettlementDraft {
  verdict: 'assigned' | 'otm_no_assignment';
  referencePrice: string;
}

/** 存疑记录默认按「虚值落袋」预选：不交割股票是更保守的一侧，用户核对后可切到实值行权。 */
function settlementDraftOf(item: OptionSettlement): SettlementDraft {
  return {
    verdict: item.verdict === 'assigned' ? 'assigned' : 'otm_no_assignment',
    referencePrice: item.referencePrice > 0 ? String(item.referencePrice) : '',
  };
}

export function PendingSettlementsPanel(props: {
  items: OptionSettlement[];
  positionById: Map<string, OptionPosition>;
  busyId: string | null;
  onConfirm: (id: string, verdict: 'assigned' | 'otm_no_assignment', referencePrice?: number) => void;
  onDismiss: (id: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, SettlementDraft>>({});
  const { items, positionById, busyId } = props;

  if (items.length === 0) {
    return (
      <Empty
        title="没有待确认的结算"
        hint="到期结算里「结论明确」的会自动入账；只有贴行权价、取不到结算价等存疑情况才会出现在这里（设置里选 manual 时全部转待确认）。"
      />
    );
  }

  return (
    <div className="flex" style={{ flexDirection: 'column', gap: 10 }}>
      {items.map((item) => {
        const contract = positionById.get(item.contractId) ?? null;
        const draft = drafts[item.id] ?? settlementDraftOf(item);
        const currency = contract?.currency ?? (contract ? OPTION_MARKET_CURRENCY[contract.market] : '');
        const uncertain = item.verdict === 'uncertain';
        const patch = (changes: Partial<SettlementDraft>) =>
          setDrafts((previous) => ({ ...previous, [item.id]: { ...draft, ...changes } }));
        return (
          <div className={`settle-card${uncertain ? ' settle-card-uncertain' : ''}`} key={item.id}>
            <div className="between wrap gap-2">
              <div className="center gap-2 wrap">
                <Badge tone={OPTION_SETTLEMENT_VERDICT_TONE[item.verdict]}>{OPTION_SETTLEMENT_VERDICT_LABELS[item.verdict]}</Badge>
                <span className="strong">{contract ? contract.underlyingName || contract.underlyingCode : item.contractId.slice(0, 8)}</span>
                {contract && (
                  <>
                    <MarketTag market={contract.market} />
                    <Badge tone={OPTION_STRATEGY_TONE[contract.strategy]}>{OPTION_STRATEGY_LABELS[contract.strategy]}</Badge>
                    <span className="mono tiny mute">{contract.optionCode}</span>
                    <span className="tiny">
                      行权价 {fmtPrice(contract.strike, contract.currency)} · 到期 {fmtDate(contract.expiry)} · {fmtNum(contract.contracts, 0)} 张
                    </span>
                  </>
                )}
              </div>
              <span className="tiny mute nowrap">
                <Badge tone={OPTION_SETTLEMENT_STATUS_TONE[item.status]}>{OPTION_SETTLEMENT_STATUS_LABELS[item.status]}</Badge>
                <span className="ml-2">评估于 {fmtDateTime(item.evaluatedAt)}</span>
              </span>
            </div>

            {/* 参考价 + 来源口径：判定翻面往往就出在这里（收盘价四舍五入 / 结算价口径差异）。 */}
            <div className="tiny mt-2">
              {settlementReferenceText({
                referencePrice: item.referencePrice,
                priceSource: item.priceSource,
                itmAmount: item.itmAmount,
                itmPct: item.itmPct,
                currency,
              })}
            </div>
            <div className="tiny mute mt-1">
              将写入的动作：{OPTION_SETTLEMENT_ACTION_LABELS[item.action]} · 到期日 {fmtDate(item.expiry)}
              {item.realizedPnl !== 0 && (
                <>
                  {' '}
                  · 该合约已实现盈亏 <span className={pnlClass(item.realizedPnl)}>{fmtSignedMoney(item.realizedPnl, currency)}</span>
                </>
              )}
            </div>
            {item.note && <div className="tiny warn mt-1">原因说明：{item.note}</div>}

            <div className="row-actions mt-2 wrap">
              <span className="tiny mute">最终判定</span>
              <Segmented
                value={draft.verdict}
                onChange={(value) => patch({ verdict: value })}
                options={[
                  { value: 'assigned', label: '实值行权（交股 / 收股）' },
                  { value: 'otm_no_assignment', label: '虚值落袋（权利金归我）' },
                ]}
              />
              <div style={{ width: 150 }}>
                <Field label="覆盖参考价（可留空）">
                  <Input
                    inputMode="decimal"
                    value={draft.referencePrice}
                    placeholder={item.referencePrice > 0 ? String(item.referencePrice) : '按记录参考价'}
                    onChange={(event) => patch({ referencePrice: event.target.value })}
                  />
                </Field>
              </div>
              <Button
                size="sm"
                variant="primary"
                loading={busyId === item.id}
                title="按上面的最终判定入账：assigned 会把股票交割流水写进「我的资产」"
                onClick={() => {
                  const price = safeNumber(draft.referencePrice, Number.NaN);
                  props.onConfirm(item.id, draft.verdict, Number.isFinite(price) && price > 0 ? price : undefined);
                }}
              >
                确认并入账
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busyId === item.id}
                title="忽略这条结算（例如已在券商端处理）"
                onClick={() => props.onDismiss(item.id)}
              >
                忽略
              </Button>
            </div>
            {uncertain && (
              <div className="tiny mute mt-1">
                参考价贴行权价 → 系统不敢自动入账。请核对券商/交易所的到期结算价后，再选择最终判定。
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ───────────────────────────── ④ 在手合约表 ───────────────────────────── */

export function OpenPositionsTable(props: {
  items: OptionPosition[];
  busyId: string | null;
  onClose: (position: OptionPosition) => void;
  onSettle?: (position: OptionPosition) => void;
}) {
  const { items, busyId } = props;
  if (items.length === 0) {
    return (
      <Empty
        title="还没有在手的卖出合约"
        hint="在「AI 投资建议」页确认一条期权建议，或用右上角「手工登记卖出合约」补录计划外成交。"
      />
    );
  }
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>标的 / 合约</th>
            <th>策略</th>
            <th className="num">行权价</th>
            <th>到期 / 倒计时</th>
            <th className="num">张数</th>
            <th className="num">权利金</th>
            <th className="num">浮盈</th>
            <th className="num">担保占用</th>
            <th>状态</th>
            <th className="right">操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((position) => {
            const expired = position.daysToExpiry <= 0;
            return (
              <tr key={position.id}>
                <td>
                  <div className="strong">{position.underlyingName || position.underlyingCode}</div>
                  <div className="tiny center gap-2 wrap">
                    <MarketTag market={position.market} />
                    <span className="mono mute">{position.underlyingCode}</span>
                    <span className="mono mute">{position.optionCode}</span>
                  </div>
                  <div className="tiny mute">
                    标的现价 {fmtPrice(position.underlyingPrice, position.currency)} ·{' '}
                    {position.moneyness === 'itm' ? (
                      <span className="warn">实值</span>
                    ) : position.moneyness === 'otm' ? (
                      <span className="pos">虚值</span>
                    ) : position.moneyness === 'atm' ? (
                      '平值（贴行权价）'
                    ) : (
                      '价格未知'
                    )}
                  </div>
                </td>
                <td>
                  <Badge tone={OPTION_STRATEGY_TONE[position.strategy]}>{OPTION_STRATEGY_LABELS[position.strategy]}</Badge>
                  <div className="tiny mute mt-1">{OPTION_TYPE_LABELS[position.optionType]}</div>
                </td>
                <td className="num mono">{fmtPrice(position.strike, position.currency)}</td>
                <td className="tiny nowrap">
                  {expiryCountdown(position.expiry)}
                  {expired && <div className="warn">已到期，等待结算扫描</div>}
                </td>
                <td className="num">{fmtNum(position.contracts, 0)}</td>
                <td className="num mono">
                  {fmtMoney(position.premiumIncome, position.currency)}
                  <div className="tiny mute">
                    每股价 {fmtPrice(position.premium, position.currency)} × {fmtNum(position.multiplier, 0)}
                  </div>
                </td>
                <td className={`num mono ${pnlClass(position.unrealizedPnl)}`}>{fmtSignedMoney(position.unrealizedPnl, position.currency)}</td>
                <td className="num mono">
                  {fmtMoney(position.collateral, position.currency)}
                  <div className="tiny mute">{position.collateralKind === 'shares' ? '持股担保' : '现金担保'}</div>
                </td>
                <td>
                  <Badge tone={OPTION_POSITION_TONE[position.status]}>{position.status}</Badge>
                </td>
                <td>
                  <div className="row-actions">
                    <Button size="sm" loading={busyId === position.id} onClick={() => props.onClose(position)}>
                      买平
                    </Button>
                    {expired && props.onSettle && (
                      <Button size="sm" variant="ghost" onClick={() => props.onSettle?.(position)}>
                        结算
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────────────────── ⑤ 历史记录（含结算） ───────────────────────── */

export function SettlementHistoryTable(props: { items: OptionSettlement[]; positionById: Map<string, OptionPosition> }) {
  const { items, positionById } = props;
  if (items.length === 0) return <div className="tiny mute">还没有结算记录。到期后点「立即扫描到期结算」即可生成。</div>;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>合约</th>
            <th>到期日</th>
            <th>判定</th>
            <th className="num">参考价 / 来源</th>
            <th className="num">实值</th>
            <th>状态</th>
            <th>已写入</th>
            <th className="num">已实现盈亏</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const contract = positionById.get(item.contractId) ?? null;
            const currency = contract?.currency ?? (contract ? OPTION_MARKET_CURRENCY[contract.market] : '');
            return (
              <tr key={item.id}>
                <td>
                  <div className="strong">{contract ? contract.underlyingName || contract.underlyingCode : item.contractId.slice(0, 8)}</div>
                  <div className="tiny mute mono">{contract?.optionCode ?? item.contractId.slice(0, 8)}</div>
                </td>
                <td className="tiny mono nowrap">{fmtDate(item.expiry)}</td>
                <td>
                  <Badge tone={OPTION_SETTLEMENT_VERDICT_TONE[item.verdict]}>{OPTION_SETTLEMENT_VERDICT_LABELS[item.verdict]}</Badge>
                </td>
                <td className="num tiny">
                  <div className="mono">{fmtPrice(item.referencePrice, currency)}</div>
                  <div className="mute">{item.priceSource || '来源未标注'}</div>
                </td>
                <td className="num tiny">
                  {item.itmAmount > 0 ? `${fmtPrice(item.itmAmount, currency)}（${fmtPct(item.itmPct, 2, false)}）` : '无实值'}
                </td>
                <td>
                  <Badge tone={OPTION_SETTLEMENT_STATUS_TONE[item.status]}>{OPTION_SETTLEMENT_STATUS_LABELS[item.status]}</Badge>
                </td>
                <td className="tiny">{OPTION_SETTLEMENT_ACTION_LABELS[item.action]}</td>
                <td className={`num mono ${pnlClass(item.realizedPnl)}`}>{fmtSignedMoney(item.realizedPnl, currency)}</td>
                <td className="tiny mute" style={{ maxWidth: 260 }} title={item.note}>
                  {item.note || '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function OptionHistoryPanel(props: {
  positions: OptionPosition[];
  settlements: OptionSettlement[];
  positionById: Map<string, OptionPosition>;
}) {
  const closed = props.positions.filter((position) => position.status !== 'open');
  return (
    <>
      <div className="small strong mb-2">已平仓 / 已到期 / 已被行权（{closed.length}）</div>
      {closed.length === 0 ? (
        <div className="tiny mute">还没有结束的合约。</div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>合约</th>
                <th>策略</th>
                <th>结束时间</th>
                <th className="num">权利金收入</th>
                <th className="num">平仓价</th>
                <th className="num">已实现盈亏</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {closed.map((position) => (
                <tr key={position.id}>
                  <td>
                    <div className="strong">{position.underlyingName || position.underlyingCode}</div>
                    <div className="tiny mute mono">{position.optionCode}</div>
                  </td>
                  <td>
                    <Badge tone={OPTION_STRATEGY_TONE[position.strategy]}>{OPTION_STRATEGY_LABELS[position.strategy]}</Badge>
                  </td>
                  <td className="tiny nowrap">{position.closedAt ? fmtDateTime(position.closedAt) : fmtDate(position.expiry)}</td>
                  <td className="num mono">{fmtMoney(position.premiumIncome, position.currency)}</td>
                  <td className="num mono">{position.closePrice !== null ? fmtPrice(position.closePrice, position.currency) : '—'}</td>
                  <td className={`num mono ${pnlClass(position.realizedPnl ?? 0)}`}>
                    {position.realizedPnl === null ? '—' : fmtSignedMoney(position.realizedPnl, position.currency)}
                  </td>
                  <td>
                    <Badge tone={OPTION_POSITION_TONE[position.status]}>{position.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="divider" />

      <div className="small strong mb-2">到期结算记录（{props.settlements.length}）</div>
      <SettlementHistoryTable items={props.settlements} positionById={props.positionById} />
    </>
  );
}

/* ───────────────────────────── ⑥ 期权链查询 ───────────────────────────── */

/**
 * 自包含的期权链查询卡片：市场 + 标的代码 → 期权链快照 + 卖权候选。
 *
 * 自己拉数据（而不是让页面代持 query）是为了让「查一个标的」与页面的刷新节奏解耦：
 * 页面刷新（AI 写库后）不会清掉用户正在看的链，只有 AI 运行结束才跟着重取。
 */
export function ChainLookup() {
  const [market, setMarket] = useState<OptionMarket>('US');
  const [code, setCode] = useState('');
  const [query, setQuery] = useState<{ market: OptionMarket; code: string } | null>(null);
  const [nonce, setNonce] = useState(0);
  useAgentRefresh(() => setNonce((value) => value + 1));

  const chain = useAsync<OptionChainSnapshot | null>(
    () => (query ? api.options.chain(query) : Promise.resolve(null)),
    [query, nonce],
  );
  const candidates = useAsync<OptionCandidatesResponse | null>(
    () => (query ? api.options.candidates(query) : Promise.resolve(null)),
    [query, nonce],
  );
  const loading = query !== null && (chain.loading || candidates.loading);
  const error = chain.error ?? candidates.error;

  return (
    <Card
      title={
        <span className="center gap-2">
          期权链与卖权候选
          <Badge tone="ai">查询即取最新快照</Badge>
        </span>
      }
      actions={
        <div className="toolbar">
          <Segmented
            value={market}
            onChange={setMarket}
            options={[
              { value: 'US' as OptionMarket, label: '美股' },
              { value: 'HK' as OptionMarket, label: '港股' },
            ]}
          />
          <div style={{ width: 150 }}>
            <Input
              value={code}
              placeholder={market === 'US' ? '例如 AAPL' : '例如 00700'}
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
          <Button size="sm" variant="primary" disabled={code.trim().length === 0} onClick={() => setQuery({ market, code: code.trim() })}>
            查询
          </Button>
        </div>
      }
    >
      <div className="tiny mute mb-2">
        选择市场与标的即可拉取期权链快照：所有到期日、买卖价差、隐含波动率、delta、未平仓与成交量，
        并给出<b>通过安全门槛</b>的卖权候选（剩余期限、|delta|、流动性、最低年化收益率都由服务端确定性筛选）。
        这个查询用于在确认前先看清「这个价能不能成交」。
      </div>

      {!query && <div className="tiny mute">尚未查询。输入标的代码后点「查询」。</div>}
      <ErrorAlert
        error={error}
        onRetry={() => {
          chain.reload();
          candidates.reload();
        }}
      />
      {loading && <Loading label="正在读取期权链…" />}
      {!loading && query && chain.data && (
        <div className="flex" style={{ flexDirection: 'column', gap: 12 }}>
          <OptionChainPanel snapshot={chain.data} />
          {candidates.data && <OptionCandidatePanel data={candidates.data} />}
        </div>
      )}
    </Card>
  );
}

/* ─────────────────────────────────── page ─────────────────────────────────── */

export function OptionsPage() {
  const toast = useToast();
  const [nonce, setNonce] = useState(0);
  const [filter, setFilter] = useState<OptionSettlementQueryStatus>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [closeTarget, setCloseTarget] = useState<OptionPosition | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const positions = useAsync(() => api.options.positions(), [nonce]);
  const settlements = useAsync(() => api.options.settlements(filter), [filter, nonce]);
  // 前置条件自检：持股（卖 Call 的担保物）、期权可用现金（卖 Put 的担保物）、待处理的期权建议。
  const assets = useAsync(() => api.assets.list(), [nonce]);
  const settings = useAsync(() => api.settings.get(), [nonce]);
  const advice = useAsync(() => api.advice.list('pending'), [nonce]);

  const { run, running } = useAgentActivity();
  useAgentRefresh(() => setNonce((value) => value + 1));

  const items = positions.data?.items ?? [];
  const open = items.filter((position) => position.status === 'open');
  const positionById = new Map(items.map((position) => [position.id, position]));
  const settlementItems = settlements.data?.items ?? [];
  const pending = settlementItems.filter((item) => item.status === 'pending_review');
  const warnings = [...(positions.data?.warnings ?? []), ...(settlements.data?.warnings ?? [])];

  /** 可用于覆盖式卖 Call 的港股/美股持股（A 股没有个股期权，不参与）。 */
  const callHoldings = (assets.data?.items ?? [])
    .filter((item) => (item.market === 'HK' || item.market === 'US') && (item.type === 'stock' || item.type === 'etf') && safeNumber(item.shares) > 0)
    .map((item) => ({ code: item.code, name: item.name, market: item.market as OptionMarket, shares: safeNumber(item.shares) }));
  const optionCash = { HK: safeNumber(settings.data?.option?.cash?.HK), US: safeNumber(settings.data?.option?.cash?.US) };
  const pendingAdvice = (advice.data?.items ?? []).filter((item) => item.instrument === 'option').length;
  const readinessLoading = (assets.loading && !assets.data) || (settings.loading && !settings.data) || (advice.loading && !advice.data);

  /** 扫描所有已到期合约：结论明确的自动入账，存疑的转「待确认」。 */
  async function scan(): Promise<void> {
    setScanning(true);
    try {
      const result = await api.options.scanSettlements();
      const text = `扫描 ${result.scanned} 个 · 自动入账 ${result.autoSettled} · 待确认 ${result.pendingReview}`;
      setScanNote(text);
      for (const warning of result.warnings) toast.warn('结算扫描提醒', warning);
      toast.success('到期结算扫描完成', text);
      setNonce((value) => value + 1);
    } catch (error) {
      toast.error('扫描失败', toApiError(error).message);
    } finally {
      setScanning(false);
    }
  }

  async function confirmSettlement(id: string, verdict: 'assigned' | 'otm_no_assignment', referencePrice?: number): Promise<void> {
    setBusyId(id);
    try {
      const result = await api.options.confirmSettlement(id, { verdict, referencePrice });
      const target = result.settlements.find((entry) => entry.id === id);
      toast.success(
        '已确认并入账',
        target ? `${OPTION_SETTLEMENT_VERDICT_LABELS[target.verdict]} · ${OPTION_SETTLEMENT_ACTION_LABELS[target.action]}` : verdict,
      );
      for (const warning of result.warnings) toast.warn('入账提醒', warning);
      setNonce((value) => value + 1);
    } catch (error) {
      toast.error('确认结算失败', toApiError(error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function dismissSettlement(id: string): Promise<void> {
    setBusyId(id);
    try {
      await api.options.dismissSettlement(id, { note: '用户手动忽略' });
      toast.info('已忽略该结算', '不会写入「我的资产」；如已在券商端处理，请确认持仓与流水一致。');
      setNonce((value) => value + 1);
    } catch (error) {
      toast.error('忽略失败', toApiError(error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function settleOne(position: OptionPosition): Promise<void> {
    setBusyId(position.id);
    try {
      const result = await api.options.settlePosition(position.id);
      toast.success(
        '已结算该合约',
        `扫描 ${result.scanned} · 自动入账 ${result.autoSettled} · 待确认 ${result.pendingReview}`,
      );
      setNonce((value) => value + 1);
    } catch (error) {
      toast.error('结算失败', toApiError(error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex" style={{ flexDirection: 'column', gap: 14 }}>
      <OptionKpiGrid summary={positions.data?.summary ?? null} />

      <OptionReadinessPanel
        holdings={callHoldings}
        cash={optionCash}
        pendingAdvice={pendingAdvice}
        loading={readinessLoading}
      />

      <Card
        title={
          <span className="center gap-2">
            在手卖出合约（{open.length}）
            {pending.length > 0 && <Badge tone="warn">{pending.length} 条待确认结算</Badge>}
          </span>
        }
        actions={
          <div className="toolbar">
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              手工登记卖出合约
            </Button>
            <Button size="sm" loading={scanning} title="扫描所有已到期合约，自动判定行权结果" onClick={() => void scan()}>
              立即扫描到期结算
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={running}
              title="结合持仓与期权链跑一次卖权建议（结果出现在「AI 投资建议」页）"
              onClick={() => run({ path: '/options/analyze', title: 'AI 期权卖权建议' })}
            >
              AI 期权卖权建议
            </Button>
          </div>
        }
      >
        <div className="tiny mute mb-2">
          覆盖式卖 Call 用「我的资产」的持股做担保收权利金；现金担保卖 Put 占用现金，被行权即按行权价收股。
          到期后系统会自动跟踪行权结果并更新「我的资产」，存疑的会停在下方「待确认结算」区等你确认。
          {scanNote && <div className="mt-1">上次扫描：{scanNote}</div>}
        </div>

        <ErrorAlert error={positions.error} onRetry={positions.reload} />
        {positions.loading && !positions.data && <Loading label="正在读取卖出合约…" />}
        {!positions.loading && (
          <OpenPositionsTable
            items={open}
            busyId={busyId}
            onClose={setCloseTarget}
            onSettle={(position) => void settleOne(position)}
          />
        )}
      </Card>

      {/* 待确认结算：这是「到期自动跟踪行权」里唯一需要人负责的部分，必须显眼。 */}
      <Card
        title={
          <span className="center gap-2">
            待确认结算
            {pending.length > 0 && <Badge tone="warn">需人工确认 {pending.length} 条</Badge>}
          </span>
        }
        actions={<span className="tiny mute">确认后才写入「我的资产」</span>}
        glow={pending.length > 0}
      >
        <div className="tiny mute mb-2">
          判定存疑的记录会全部列在这里：系统不敢自动交股 / 收股（参考价贴行权价、取不到结算价、跨假期等）。
          核对券商与交易所的结算价后选择最终判定，点「确认并入账」才会生成股票交割流水。
        </div>
        <ErrorAlert error={settlements.error} onRetry={settlements.reload} />
        {settlements.loading && !settlements.data && <Loading label="正在读取结算记录…" />}
        {!settlements.loading && (
          <PendingSettlementsPanel
            items={pending}
            positionById={positionById}
            busyId={busyId}
            onConfirm={(id, verdict, referencePrice) => void confirmSettlement(id, verdict, referencePrice)}
            onDismiss={(id) => void dismissSettlement(id)}
          />
        )}
      </Card>

      <ChainLookup />

      <Card
        title={
          <span className="center gap-2">
            历史记录（{settlementItems.length} 条结算）
            <Segmented value={filter} options={SETTLEMENT_FILTERS} onChange={setFilter} />
          </span>
        }
      >
        <ErrorAlert error={settlements.error} onRetry={settlements.reload} />
        <OptionHistoryPanel positions={items} settlements={settlementItems} positionById={positionById} />
      </Card>

      <OptionSourceNotice warnings={warnings} />

      <OptionCloseDialog
        position={closeTarget}
        onClose={() => setCloseTarget(null)}
        onDone={(message) => {
          setCloseTarget(null);
          toast.success('已买平', message);
          setNonce((value) => value + 1);
        }}
      />
      <OptionCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={(message) => {
          setCreateOpen(false);
          toast.success('已登记卖出合约', message);
          setNonce((value) => value + 1);
        }}
      />
    </div>
  );
}