/**
 * AdvicePage — owner: web-ai-pages.
 * AI 投资建议：月度预算约束、SSE 生成、确认/驳回。
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MARKETS, MARKET_LABELS } from '@aia/shared';
import type { AdviceItem } from '@aia/shared';
import { api } from '../api/client';
import { useAgentActivity, useAgentRefresh } from '../api/agentActivity';
import { toApiError, useAsync } from '../api/hooks';
import { fmtDateTime, fmtMoney, fmtPct, fmtPrice, fmtShares, safeNumber, todayIso } from '../format';
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
  Modal,
  ProgressBar,
  Segmented,
  useToast,
} from '../components/ui';

type StatusFilter = 'pending' | 'confirmed' | 'rejected';

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'pending', label: '待处理' },
  { value: 'confirmed', label: '已确认' },
  { value: 'rejected', label: '已驳回' },
];

export function AdvicePage() {
  const toast = useToast();
  const [status, setStatus] = useState<StatusFilter>('pending');
  const [nonce, setNonce] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<AdviceItem | null>(null);

  const list = useAsync(() => api.advice.list(status), [status, nonce]);
  const last = useAsync(() => api.advice.last(), [nonce]);
  const settings = useAsync(() => api.settings.get(), []);
  const llmMissing = settings.data !== null && !settings.data.hasApiKey;
  // 建议写作 / 资产写作 / 简报写作与运行结束都会刷新列表；
  // 推理过程与「新增 N 条建议」结论统一显示在右下角全局面板里。
  const { run, running, budget: liveBudget } = useAgentActivity();
  useAgentRefresh(() => setNonce((value) => value + 1));

  const items = list.data?.items ?? [];
  // 运行中优先用 SSE 推送的实时预算（budget 事件）；运行结束后回落到列表返回的预算
  const budget = (running ? liveBudget : null) ?? list.data?.budget ?? null;

  async function reject(item: AdviceItem) {
    setBusyId(item.id);
    try {
      await api.advice.reject(item.id);
      toast.info('已驳回该建议', `${item.assetName} · 本次不采纳`);
      setNonce((value) => value + 1);
    } catch (error) {
      const err = toApiError(error);
      toast.error('驳回失败', err.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex" style={{ flexDirection: 'column', gap: 14 }}>
      <Card
        title={
          <span className="center gap-2">
            本月投资预算
            {budget && <Badge>{budget.month}</Badge>}
          </span>
        }
        actions={
          <div className="toolbar">
            {last.data ? (
              <span className="tiny mute">
                最近生成：{fmtDateTime(last.data.startedAt)}
                {last.data.status === 'error' ? ' · 失败' : ''}
              </span>
            ) : (
              <span className="tiny mute">尚未生成过投资建议</span>
            )}
            <Button variant="primary" loading={running} onClick={() => run({ path: '/advice/generate', title: 'AI 投资建议' })}>
              AI 投资建议
            </Button>
          </div>
        }
      >
        <div className="tiny mute mb-2">
          点击「AI 投资建议」会先跑<strong>资产分析 → 标的分析</strong>，再汇总生成买入 / 卖出建议；买入建议受下方月度预算约束。
        </div>

        {llmMissing && (
          <div className="mb-3">
            <Alert tone="warn">
              尚未配置 LLM API Key，AI 建议无法生成。请前往 <Link to="/settings">设置</Link> 填写 Base URL 与 API Key 后重试。
            </Alert>
          </div>
        )}

        {!budget && <Loading label="正在读取预算…" />}
        {budget && (
          <div className="stat-grid">
            {MARKETS.map((market) => {
              const row = budget.markets.find((entry) => entry.market === market);
              if (!row) return null;
              return (
                <div className="stat-card" key={market}>
                  <div className="stat-label">
                    {MARKET_LABELS[market]} · {row.currency}
                    {(row.exhausted || row.remaining <= 0) && <Badge tone="warn">预算耗尽</Badge>}
                  </div>
                  <div className="stat-value">
                    {fmtMoney(row.spent, row.currency, 0)} <span className="mute">/ {fmtMoney(row.budget, row.currency, 0)}</span>
                  </div>
                  <div className="stat-sub">
                    已用 {fmtPct(row.usedPct, 1, false)} · 剩余 {fmtMoney(row.remaining, row.currency, 0)}
                  </div>
                  <div className="mt-2">
                    <ProgressBar value={row.usedPct} max={100} />
                  </div>
                  {row.exhausted && (
                    <div className="mt-2">
                      <Alert tone="warn">本月预算已用完，不再推荐该市场买入。</Alert>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card
        title={`建议列表（${items.length}）`}
        actions={<Segmented value={status} options={STATUS_OPTIONS} onChange={setStatus} />}
      >
        <ErrorAlert error={list.error} onRetry={list.reload} />

        {list.loading && !list.data && <Loading label="正在加载建议…" />}

        {!list.loading && items.length === 0 && (
          <Empty
            title={status === 'pending' ? '暂无待处理建议' : status === 'confirmed' ? '暂无已确认建议' : '暂无已驳回建议'}
            hint={
              status === 'pending'
                ? '点击上方「AI 投资建议」让 Agent 结合持仓、标的与预算生成建议。'
                : '切换上方分段控件可以看到其他状态的建议。'
            }
          />
        )}

        {items.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>资产名称</th>
                  <th>建议</th>
                  <th className="num">目标份额</th>
                  <th className="num">目标单价</th>
                  <th className="num">建议金额</th>
                  <th>理由</th>
                  <th className="num">置信度</th>
                  <th>给出建议的日期</th>
                  <th className="right">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const isOpen = Boolean(expanded[item.id]);
                  return (
                    <tr key={item.id} style={item.status === 'pending' ? undefined : { opacity: 0.62 }}>
                      <td>
                        <div className="strong">{item.assetName || item.code}</div>
                        <div className="tiny mute mono">
                          {MARKET_LABELS[item.market]} · {item.code}
                        </div>
                      </td>
                      <td>
                        <Badge tone={item.action === 'buy' ? 'buy' : 'sell'}>{item.action === 'buy' ? '买入' : '卖出'}</Badge>
                      </td>
                      <td className="num">{fmtShares(item.targetShares)}</td>
                      <td className="num">{fmtPrice(item.targetPrice, item.currency)}</td>
                      <td className="num">{fmtMoney(item.amount, item.currency)}</td>
                      <td style={{ maxWidth: 320 }}>
                        <div className={isOpen ? '' : 'truncate'} style={{ whiteSpace: isOpen ? 'pre-wrap' : 'normal' }}>
                          {item.reason || '—'}
                        </div>
                        {(item.reason?.length ?? 0) > 48 && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm mt-1"
                            onClick={() => setExpanded((previous) => ({ ...previous, [item.id]: !isOpen }))}
                          >
                            {isOpen ? '收起' : '展开'}
                          </button>
                        )}
                      </td>
                      <td className="num">{fmtPct(item.confidence * 100, 0, false)}</td>
                      <td className="nowrap">{fmtDateTime(item.createdAt)}</td>
                      <td>
                        {item.status === 'pending' ? (
                          <div className="row-actions">
                            <Button size="sm" variant="primary" onClick={() => setConfirmTarget(item)}>
                              确认
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              loading={busyId === item.id}
                              onClick={() => void reject(item)}
                            >
                              驳回
                            </Button>
                          </div>
                        ) : (
                          <div className="right tiny mute nowrap">
                            {item.status === 'confirmed'
                              ? `已买入 ${fmtShares(item.executedShares)} @ ${fmtPrice(item.executedPrice, item.currency)}`
                              : '已驳回'}
                            {item.decidedAt && <div>{fmtDateTime(item.decidedAt)}</div>}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ConfirmAdviceDialog
        item={confirmTarget}
        onClose={() => setConfirmTarget(null)}
        onDone={(message) => {
          setConfirmTarget(null);
          toast.success('已确认建议', message);
          setNonce((value) => value + 1);
        }}
      />
    </div>
  );
}

/* ─────────────────────────── 确认建议（写入资产） ──────────────────────────── */

function ConfirmAdviceDialog(props: { item: AdviceItem | null; onClose: () => void; onDone: (message: string) => void }) {
  const toast = useToast();
  const { item } = props;
  const [shares, setShares] = useState('');
  const [price, setPrice] = useState('');
  const [tradeDate, setTradeDate] = useState(todayIso());
  const [fee, setFee] = useState('0');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!item) return;
    setShares(String(item.targetShares ?? 0));
    setPrice(String(item.targetPrice ?? 0));
    setTradeDate(todayIso());
    setFee('0');
  }, [item]);

  async function submit() {
    if (!item) return;
    const nextShares = safeNumber(shares, Number.NaN);
    const nextPrice = safeNumber(price, Number.NaN);
    if (!Number.isFinite(nextShares) || nextShares <= 0) {
      toast.error('请填写有效的实际份额');
      return;
    }
    if (!Number.isFinite(nextPrice) || nextPrice <= 0) {
      toast.error('请填写有效的买入单价');
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.advice.confirm(item.id, {
        shares: nextShares,
        price: nextPrice,
        tradeDate: tradeDate || todayIso(),
        fee: safeNumber(fee, 0),
      });
      props.onDone(`已写入我的资产：${result.asset.name || result.asset.code}`);
    } catch (error) {
      const err = toApiError(error);
      toast.error('确认失败', err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={item !== null}
      title={item ? `确认 ${item.action === 'buy' ? '买入' : '卖出'} · ${item.assetName || item.code}` : '确认建议'}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={submitting}>
            取消
          </Button>
          <Button variant="primary" loading={submitting} onClick={() => void submit()}>
            确认并写入资产
          </Button>
        </>
      }
    >
      {item && (
        <>
          <div className="panel small">
            <div className="between">
              <span>
                建议 {item.action === 'buy' ? '买入' : '卖出'} {fmtShares(item.targetShares)} 股 / 份，目标单价{' '}
                {fmtPrice(item.targetPrice, item.currency)}
              </span>
              <span className="mute">{fmtMoney(item.amount, item.currency)}</span>
            </div>
            {item.reason && <div className="tiny mute mt-1">{item.reason.slice(0, 200)}</div>}
          </div>

          <div className="form-grid">
            <Field label="实际份额">
              <Input inputMode="decimal" value={shares} onChange={(event) => setShares(event.target.value)} />
            </Field>
            <Field label={`买入单价（${item.currency}）`}>
              <Input inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} />
            </Field>
            <Field label="交易日期">
              <Input type="date" value={tradeDate} onChange={(event) => setTradeDate(event.target.value)} />
            </Field>
            <Field label={`费用（${item.currency}）`}>
              <Input inputMode="decimal" value={fee} onChange={(event) => setFee(event.target.value)} />
            </Field>
          </div>

          <div className="tiny mute">
            确认后会在「我的资产」写入一笔 {item.action === 'buy' ? '买入' : '卖出'} 交易并重算持仓；建议状态变为「已确认」。
          </div>
        </>
      )}
    </Modal>
  );
}
