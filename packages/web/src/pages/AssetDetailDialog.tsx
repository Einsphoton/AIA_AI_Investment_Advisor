/**
 * 「我的资产」查看详情浮窗 + 可复用的交易记录表格。owner: web-core-pages
 *
 * 详情数据一次性来自 GET /api/assets/:id（含 transactions），图表与基本面复用
 * InstrumentDetailSections，避免在页面里重复拉取行情。
 */
import { useEffect, useMemo, useState } from 'react';
import type { AssetDetail, Transaction } from '@aia/shared';
import { INSTRUMENT_TYPE_LABELS } from '@aia/shared';
import { api } from '../api/client';
import { toApiError, useAsync } from '../api/hooks';
import { fmtDate, fmtDateTime, fmtMoney, fmtPct, fmtPrice, fmtShares, fmtSignedMoney, pnlClass } from '../format';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Disclosure,
  Empty,
  ErrorAlert,
  Loading,
  MarketTag,
  Modal,
  Tabs,
  useToast,
} from '../components/ui';
import { MarketSeriesPanel, ProfilePanel, markersFromTransactions } from '../components/InstrumentDetailSections';
import { FinancialsPanel } from '../components/FinancialsPanel';
import { Markdown } from '../components/markdown/Markdown';

const TX_SOURCE_LABELS: Record<string, string> = {
  manual: '手动',
  ai: 'AI',
  advice: '建议',
};

export function TransactionTable(props: {
  transactions: Transaction[];
  /** 资产计价货币，用于金额/单价格式化。 */
  currency: string;
  /** 传入即显示删除按钮（详情浮窗与编辑浮窗共用）。 */
  onDelete?: (tx: Transaction) => void;
}) {
  const { transactions, currency, onDelete } = props;
  if (transactions.length === 0) {
    return <Empty title="暂无交易记录" hint="可在「编辑」浮窗中补录买入 / 卖出记录" />;
  }

  const rows = transactions.slice().sort((a, b) => b.tradeDate.localeCompare(a.tradeDate));

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>日期</th>
            <th>方向</th>
            <th className="num">份额</th>
            <th className="num">单价</th>
            <th className="num">金额</th>
            <th className="num">费用</th>
            <th>来源</th>
            <th>备注</th>
            {onDelete && <th className="right">操作</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((tx) => (
            <tr key={tx.id}>
              <td className="nowrap">{fmtDate(tx.tradeDate)}</td>
              <td>
                <Badge tone={tx.kind === 'buy' ? 'buy' : 'sell'}>{tx.kind === 'buy' ? '买入' : '卖出'}</Badge>
              </td>
              <td className="num">{fmtShares(tx.shares)}</td>
              <td className="num">{fmtPrice(tx.price, currency)}</td>
              <td className="num">{fmtSignedMoney(tx.amount, currency)}</td>
              <td className="num">{tx.fee ? fmtMoney(tx.fee, currency) : '—'}</td>
              <td>{TX_SOURCE_LABELS[tx.source] ?? tx.source}</td>
              <td className="muted">{tx.note || '—'}</td>
              {onDelete && (
                <td>
                  <div className="row-actions">
                    <Button size="sm" variant="ghost" onClick={() => onDelete(tx)}>
                      删除
                    </Button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AssetDetailDialog(props: {
  assetId: string | null;
  open: boolean;
  onClose: () => void;
  /** 交易增删成功后通知父级刷新列表。 */
  onMutated?: () => void;
}) {
  const { assetId, open, onClose, onMutated } = props;
  const toast = useToast();
  const [pendingTx, setPendingTx] = useState<Transaction | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [tab, setTab] = useState<'overview' | 'ai'>('overview');

  const state = useAsync<AssetDetail | null>(
    () => (open && assetId ? api.assets.get(assetId) : Promise.resolve(null)),
    [assetId, open],
  );
  const detail = open && assetId ? state.data : null;
  const markers = useMemo(() => markersFromTransactions(detail?.transactions ?? []), [detail]);

  // 换资产时回到「概览」，不要停留在上一个资产的 AI 页签。
  useEffect(() => {
    setTab('overview');
  }, [assetId, open]);

  const instrument = detail
    ? { market: detail.market, code: detail.code, type: detail.type, name: detail.name, currency: detail.currency }
    : null;

  const confirmRemoveTx = async () => {
    if (!detail || !pendingTx) return;
    setDeleting(true);
    try {
      await api.assets.removeTransaction(detail.id, pendingTx.id);
      toast.success('交易记录已删除', '持仓与成本已按移动加权平均法重算');
      setPendingTx(null);
      state.reload();
      onMutated?.();
    } catch (error) {
      toast.error('删除交易记录失败', toApiError(error).message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal
      open={open}
      size="lg"
      title={detail ? `资产详情 · ${detail.name}` : '资产详情'}
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      }
    >
      {state.loading && !detail && <Loading label="正在读取资产详情…" />}
      {state.error && <ErrorAlert error={state.error} onRetry={state.reload} />}

      {detail && instrument && (
        <>
          <Card
            title={
              <span className="center gap-2">
                {detail.name}
                <span className="mono tiny mute">
                  {detail.market}/{detail.code}
                </span>
                <Badge tone={detail.type === 'stock' ? 'manual' : 'ai'}>{INSTRUMENT_TYPE_LABELS[detail.type]}</Badge>
                <MarketTag market={detail.market} />
                {detail.closed && <Badge tone="warn">已清仓</Badge>}
              </span>
            }
          >
            <div className="grid-4">
              <Metric label="当前市值" value={fmtMoney(detail.marketValue, detail.currency)} />
              <Metric label="持仓份额" value={fmtShares(detail.shares)} />
              <Metric label="持仓成本" value={fmtMoney(detail.cost, detail.currency)} hint={`均价 ${fmtPrice(detail.avgCost, detail.currency)}`} />
              <Metric label="浮动盈亏" value={fmtSignedMoney(detail.unrealizedPnl, detail.currency)} tone={detail.unrealizedPnl} hint={fmtPct(detail.unrealizedPnlPct)} />
              <Metric label="已实现盈亏" value={fmtSignedMoney(detail.realizedPnl, detail.currency)} tone={detail.realizedPnl} />
              <Metric label="最新价" value={fmtPrice(detail.price, detail.currency)} tone={detail.dayChange} hint={fmtPct(detail.dayChangePct)} />
              <Metric label="建仓日期" value={fmtDate(detail.firstBuyAt)} />
              <Metric label="最新买入 / 卖出" value={`${fmtDate(detail.lastBuyAt)} / ${fmtDate(detail.lastSellAt)}`} />
            </div>
            {detail.note && <div className="tiny mute mt-3">用户备注：{detail.note}</div>}
            {detail.priceAt && <div className="tiny mute mt-1">行情时间：{fmtDateTime(detail.priceAt)}</div>}
          </Card>

          <Tabs
            ariaLabel="资产详情分页"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'overview', label: '概览' },
              {
                value: 'ai',
                label: 'AI 分析',
                badge: detail.aiSummary ? <Badge tone="ai">已生成</Badge> : undefined,
              },
            ]}
          />

          {tab === 'overview' ? (
            <>
              {/* 买卖点来自交易记录，与列表中的 AI 分析共用同一份数据。 */}
              <MarketSeriesPanel instrument={instrument} markers={markers} />

              <ProfilePanel instrument={instrument} />

              {/* 财报体积大且不是每次都要看 → 默认折叠，避免弹窗被拉得很长。 */}
              <Disclosure title="财务报表（三表）" summary="利润表 · 资产负债表 · 现金流量表（点击展开）">
                <FinancialsPanel instrument={instrument} />
              </Disclosure>

              <Card
                title={`交易记录（${detail.transactions.length} 笔）`}
                actions={<span className="tiny mute">按日期倒序 · 删除后将重算持仓</span>}
              >
                <TransactionTable transactions={detail.transactions} currency={detail.currency} onDelete={setPendingTx} />
              </Card>
            </>
          ) : (
            <Card
              title={
                <span className="center gap-2">
                  AI 分析总结
                  {detail.aiSummaryAt && <Badge tone="ai">生成于 {fmtDateTime(detail.aiSummaryAt)}</Badge>}
                </span>
              }
            >
              {detail.aiSummary ? (
                /* AI 分析以 Markdown 存储：这里渲染成带标题层级、指标条与语义数字的报告。 */
                <Markdown text={detail.aiSummary} />
              ) : (
                <Empty title="尚未生成该资产的 AI 分析" hint="回到列表点击「AI 资产分析」，Agent 会逐项分析财报、基本面、宏观与微观环境" />
              )}
            </Card>
          )}
        </>
      )}

      <ConfirmDialog
        open={pendingTx !== null}
        danger
        busy={deleting}
        title="删除这笔交易？"
        confirmLabel="删除"
        message={
          pendingTx
            ? `${fmtDate(pendingTx.tradeDate)} ${pendingTx.kind === 'buy' ? '买入' : '卖出'} ${fmtShares(pendingTx.shares)} 份 @ ${fmtPrice(pendingTx.price)}`
            : ''
        }
        onConfirm={confirmRemoveTx}
        onCancel={() => setPendingTx(null)}
      />
    </Modal>
  );
}

function Metric(props: { label: string; value: string; hint?: string; tone?: number }) {
  const toneClass = props.tone === undefined ? '' : pnlClass(props.tone);
  return (
    <div className="panel">
      <div className="tiny mute">{props.label}</div>
      <div className={`strong ${toneClass}`} style={{ marginTop: 2 }}>
        {props.value}
      </div>
      {props.hint && <div className="tiny mute">{props.hint}</div>}
    </div>
  );
}
