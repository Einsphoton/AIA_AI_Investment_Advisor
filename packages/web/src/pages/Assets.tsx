/**
 * AssetsPage — 「我的资产」。owner: web-core-pages
 *
 * 一次拉全量列表（GET /api/assets 返回 { items, total }），筛选/搜索交给服务端，
 * 排序与「按市场 / 按资产类型分列」在客户端完成：分组行只在渲染期插入，
 * 这样切换视图不会重新请求，也不会让服务端排序破坏分组顺序。
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AssetSummary, Creator, InstrumentType, Market } from '@aia/shared';
import { INSTRUMENT_TYPES, INSTRUMENT_TYPE_LABELS, MARKETS, MARKET_LABELS } from '@aia/shared';
import { api } from '../api/client';
import { useAgentActivity, useAgentRefresh } from '../api/agentActivity';
import { toApiError, useAsync, useDebounced } from '../api/hooks';
import { fmtDate, fmtMoney, fmtPct, fmtPrice, fmtShares, fmtSignedMoney, pnlClass } from '../format';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dropdown,
  Empty,
  ErrorAlert,
  Input,
  InstrumentTypeTag,
  Loading,
  MarketTag,
  Segmented,
  SortHeader,
  useToast,
} from '../components/ui';
import { Sparkline } from '../components/charts/Sparkline';
import { AssetDetailDialog } from './AssetDetailDialog';
import { AssetCreateDialog, AssetEditDialog } from './AssetFormDialog';

type SortField = 'name' | 'marketValue' | 'pnl' | 'change';
type GroupMode = 'none' | 'market' | 'type';

const SOURCE_OPTIONS: { value: Creator; label: string }[] = [
  { value: 'manual', label: '手动建仓' },
  { value: 'ai', label: 'AI 建仓' },
];

/** 表格列数，供分组行 colSpan 使用。 */
const COLUMN_COUNT = 19;

function compareAssets(a: AssetSummary, b: AssetSummary, field: SortField): number {
  switch (field) {
    case 'name':
      return a.name.localeCompare(b.name, 'zh-CN');
    case 'pnl':
      return a.unrealizedPnl - b.unrealizedPnl;
    case 'change':
      return a.dayChangePct - b.dayChangePct;
    case 'marketValue':
    default:
      return a.marketValue - b.marketValue;
  }
}

interface AssetGroup {
  key: string;
  label: string;
  caption: string;
  items: AssetSummary[];
}

function buildGroups(items: AssetSummary[], mode: GroupMode): AssetGroup[] {
  if (mode === 'none') {
    return [{ key: 'all', label: '', caption: '', items }];
  }
  const order: string[] = mode === 'market' ? [...MARKETS] : [...INSTRUMENT_TYPES];
  const keyOf = (asset: AssetSummary) => (mode === 'market' ? asset.market : asset.type);
  const labelOf = (key: string) =>
    mode === 'market' ? MARKET_LABELS[key as Market] ?? key : INSTRUMENT_TYPE_LABELS[key as InstrumentType] ?? key;

  const buckets = new Map<string, AssetSummary[]>();
  for (const asset of items) {
    const key = keyOf(asset);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(asset);
    else buckets.set(key, [asset]);
  }

  const known = order.filter((key) => buckets.has(key));
  const extra = [...buckets.keys()].filter((key) => !order.includes(key));

  return [...known, ...extra].map((key) => {
    const groupItems = buckets.get(key) ?? [];
    // 按市场分组时币种一致，可以安全地给出合计市值；按类型分组时币种混杂，只报数量。
    const caption =
      mode === 'market'
        ? `${groupItems.length} 个标的 · 合计市值 ${fmtMoney(
            groupItems.reduce((sum, asset) => sum + asset.marketValue, 0),
            groupItems[0]?.currency,
          )}`
        : `${groupItems.length} 个标的`;
    return { key, label: labelOf(key), caption, items: groupItems };
  });
}

export function AssetsPage() {
  const toast = useToast();
  const [market, setMarket] = useState('');
  const [type, setType] = useState('');
  const [source, setSource] = useState('');
  const [groupMode, setGroupMode] = useState<GroupMode>('none');
  const [sortField, setSortField] = useState<SortField>('marketValue');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [searchText, setSearchText] = useState('');
  const query = useDebounced(searchText.trim(), 350);

  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AssetSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const autoRefreshed = useRef(false);

  const state = useAsync(() => api.assets.list({ market, type, source, q: query }), [market, type, source, query]);

  // entity 事件（AI 逐项分析写回 aiSummary）到达或运行结束时立刻刷新列表。
  const { run, running } = useAgentActivity();
  useAgentRefresh(state.reload);

  const rows = state.data?.items ?? [];

  const sorted = useMemo(() => {
    const factor = sortDir === 'asc' ? 1 : -1;
    return rows.slice().sort((a, b) => compareAssets(a, b, sortField) * factor);
  }, [rows, sortField, sortDir]);

  const groups = useMemo(() => buildGroups(sorted, groupMode), [sorted, groupMode]);

  const toggleSort = (field: string) => {
    const next = field as SortField;
    if (next === sortField) setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
    else {
      setSortField(next);
      setSortDir(next === 'name' ? 'asc' : 'desc');
    }
  };

  const hasFilter = Boolean(market || type || source || searchText);
  const resetFilters = () => {
    setMarket('');
    setType('');
    setSource('');
    setSearchText('');
  };

  /**
   * 刷新持仓行情（现价 / 当日涨跌 / 走势缩略图）。
   *
   * 「当前走势」取的是 `asset.spark`，它只在刷新行情时写入；若某次刷新时序列
   * 接口失败，价格会更新而走势仍为空 —— 列表里那一列就什么都没有。所以进页面
   * 时按新鲜度自动补刷一次，同时保留手动按钮兜底。
   */
  async function refreshQuotes(reason: 'auto' | 'manual' = 'manual') {
    if (reason === 'manual') setRefreshing(true);
    try {
      const result = await api.assets.refresh();
      if (reason === 'manual') {
        toast.success(`已刷新 ${result.updated} 个标的行情`, result.failed > 0 ? `${result.failed} 个标的刷新失败` : undefined);
      }
      state.reload();
    } catch (error) {
      if (reason === 'manual') toast.error('刷新行情失败', toApiError(error).message);
    } finally {
      if (reason === 'manual') setRefreshing(false);
    }
  }

  useEffect(() => {
    if (autoRefreshed.current || state.loading || !state.data || rows.length === 0) return;
    autoRefreshed.current = true;
    const newest = rows.reduce<string | null>(
      (acc, row) => (row.priceAt && (!acc || row.priceAt > acc) ? row.priceAt : acc),
      null,
    );
    // 缺走势（或走势过期）时自动补刷，避免每次进页面都打一遍数据源。
    const missingSpark = rows.some((row) => !Array.isArray(row.spark) || row.spark.length < 2);
    const ageMs = newest ? Date.now() - new Date(newest).getTime() : Number.POSITIVE_INFINITY;
    if (missingSpark || ageMs > 5 * 60_000) void refreshQuotes('auto');
  }, [state.loading, state.data, rows]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.assets.remove(deleteTarget.id);
      toast.success('资产已删除', `${deleteTarget.name} 及其交易记录已移除`);
      setDeleteTarget(null);
      state.reload();
    } catch (error) {
      toast.error('删除资产失败', toApiError(error).message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="flex between wrap gap-2 mb-3">
        <div className="toolbar">
          <Input
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="搜索名称 / 代码"
            style={{ width: 190 }}
          />
          <Dropdown
            value={market}
            style={{ width: 130 }}
            ariaLabel="市场筛选"
            onChange={setMarket}
            items={[
              { value: '', label: '全部市场' },
              ...MARKETS.map((item) => ({ value: item, label: MARKET_LABELS[item] })),
            ]}
          />
          <Dropdown
            value={type}
            style={{ width: 140 }}
            ariaLabel="类型筛选"
            onChange={setType}
            items={[
              { value: '', label: '全部类型' },
              ...INSTRUMENT_TYPES.map((item) => ({ value: item, label: INSTRUMENT_TYPE_LABELS[item] })),
            ]}
          />
          <Dropdown
            value={source}
            style={{ width: 140 }}
            ariaLabel="来源筛选"
            onChange={setSource}
            items={[{ value: '', label: '全部来源' }, ...SOURCE_OPTIONS]}
          />
          {hasFilter && (
            <Button size="sm" variant="ghost" onClick={resetFilters}>
              重置筛选
            </Button>
          )}
        </div>

        <div className="toolbar">
          <Segmented
            value={groupMode}
            onChange={setGroupMode}
            options={[
              { value: 'none', label: '不分列' },
              { value: 'market', label: '按市场分列' },
              { value: 'type', label: '按资产类型分列' },
            ]}
          />
          <Button
            onClick={() => void refreshQuotes('manual')}
            loading={refreshing}
            title="拉取最新现价 / 当日涨跌 / 走势缩略图（「当前走势」列依赖它）"
          >
            刷新行情
          </Button>
          <Button onClick={() => setCreateOpen(true)}>添加资产</Button>
          <Button
            variant="primary"
            loading={running}
            onClick={() => {
              run({ path: '/assets/analyze', title: 'AI 资产分析' });
            }}
          >
            AI 资产分析
          </Button>
        </div>
      </div>

      {state.error && <ErrorAlert error={state.error} onRetry={state.reload} />}
      {state.error?.isNotConfigured && (
        <Alert tone="warn">
          尚未配置 LLM API Key，AI 分析不可用，请到 <Link to="/settings">设置页</Link> 填写 API Key。
        </Alert>
      )}

      {state.loading && !state.data && <Loading label="正在读取持仓…" />}

      {state.data && (
        <Card
          title={`持仓列表（${sorted.length}${state.data.total !== sorted.length ? ` / 共 ${state.data.total}` : ''}）`}
          actions={
            <span className="tiny mute">
              点击表头排序 · 当前 {sortDir === 'asc' ? '升序' : '降序'} · 行情口径按各标的币种
            </span>
          }
          padded={false}
        >
          {sorted.length === 0 ? (
            <Empty
              title={hasFilter ? '没有符合条件的资产' : '还没有资产'}
              hint={hasFilter ? '试试放宽筛选条件或清空搜索关键词' : '点击「添加资产」录入第一笔持仓，或运行 AI 资产分析'}
              action={
                hasFilter ? (
                  <Button size="sm" onClick={resetFilters}>
                    重置筛选
                  </Button>
                ) : (
                  <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>
                    添加资产
                  </Button>
                )
              }
            />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <SortHeader label="资产名称" field="name" sort={sortField} dir={sortDir} onSort={toggleSort} />
                    <th>市场代码</th>
                    <th>类型</th>
                    <th>市场</th>
                    <th>建仓来源</th>
                    <th className="num">份额</th>
                    <th className="num" title="移动加权平均成本">
                      买入单价
                    </th>
                    <th className="num">当前单价</th>
                    <SortHeader numeric label="当日涨跌" field="change" sort={sortField} dir={sortDir} onSort={toggleSort} />
                    <SortHeader numeric label="当前市值" field="marketValue" sort={sortField} dir={sortDir} onSort={toggleSort} />
                    <th className="num">已实现盈亏</th>
                    <th>建仓日期</th>
                    <th>最新买入</th>
                    <th>最新卖出</th>
                    <SortHeader numeric label="浮动盈亏" field="pnl" sort={sortField} dir={sortDir} onSort={toggleSort} />
                    <th>当前走势</th>
                    <th>AI 建议</th>
                    <th>用户备注</th>
                    <th className="right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <Fragment key={group.key}>
                      {groupMode !== 'none' && (
                        <tr className="group-row">
                          <td colSpan={COLUMN_COUNT}>
                            {group.label} · {group.caption}
                          </td>
                        </tr>
                      )}
                      {group.items.map((asset) => (
                        <tr key={asset.id}>
                          <td>
                            <div className="strong truncate" style={{ maxWidth: 220 }} title={asset.name}>
                              {asset.name} {asset.closed && <Badge tone="warn">已清仓</Badge>}
                            </div>
                          </td>
                          <td className="mono tiny">{asset.code}</td>
                          <td>
                            <InstrumentTypeTag type={asset.type} />
                          </td>
                          <td className="nowrap">
                          <MarketTag market={asset.market} />
                        </td>
                          <td>
                            <Badge tone={asset.source === 'ai' ? 'ai' : 'manual'}>{asset.source === 'ai' ? 'AI 建仓' : '手动'}</Badge>
                          </td>
                          <td className="num">{fmtShares(asset.shares)}</td>
                          <td className="num">{fmtPrice(asset.avgCost, asset.currency)}</td>
                          <td className="num">{fmtPrice(asset.price, asset.currency)}</td>
                          <td className={`num ${pnlClass(asset.dayChangePct)}`}>{fmtPct(asset.dayChangePct)}</td>
                          <td className="num">{fmtMoney(asset.marketValue, asset.currency)}</td>
                          <td className={`num ${pnlClass(asset.realizedPnl)}`}>{fmtSignedMoney(asset.realizedPnl, asset.currency)}</td>
                          <td className="nowrap">{fmtDate(asset.firstBuyAt)}</td>
                          <td className="nowrap">{fmtDate(asset.lastBuyAt)}</td>
                          <td className="nowrap">{fmtDate(asset.lastSellAt)}</td>
                          <td className="num">
                            <div className={pnlClass(asset.unrealizedPnl)}>{fmtSignedMoney(asset.unrealizedPnl, asset.currency)}</div>
                            <div className={`tiny ${pnlClass(asset.unrealizedPnlPct)}`}>{fmtPct(asset.unrealizedPnlPct)}</div>
                          </td>
                          <td>
                            {asset.spark.length > 1 ? (
                              <Sparkline values={asset.spark} />
                            ) : (
                              <span className="tiny mute" title="暂无走势数据：点上方「刷新行情」重新拉取价格序列">
                                待刷新
                              </span>
                            )}
                          </td>
                          <td>
                            <div className="truncate tiny muted" style={{ maxWidth: 220 }} title={asset.aiSummary || '尚未生成 AI 分析'}>
                              {asset.aiSummary || '—'}
                            </div>
                          </td>
                          <td>
                            <div className="truncate tiny muted" style={{ maxWidth: 150 }} title={asset.note || '无备注'}>
                              {asset.note || '—'}
                            </div>
                          </td>
                          <td>
                            <div className="row-actions">
                              <Button size="sm" variant="ghost" onClick={() => setDetailId(asset.id)}>
                                详情
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setEditId(asset.id)}>
                                编辑
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(asset)}>
                                删除
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <AssetCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(asset) => {
          // 新建后直接打开详情，符合「建仓即核对」的使用习惯。
          setDetailId(asset.id);
          state.reload();
        }}
      />
      <AssetDetailDialog assetId={detailId} open={detailId !== null} onClose={() => setDetailId(null)} onMutated={state.reload} />
      <AssetEditDialog assetId={editId} open={editId !== null} onClose={() => setEditId(null)} onMutated={state.reload} />

      <ConfirmDialog
        open={deleteTarget !== null}
        danger
        busy={deleting}
        title="删除资产？"
        confirmLabel="删除"
        message={
          deleteTarget
            ? `将删除「${deleteTarget.name}」（${deleteTarget.market}/${deleteTarget.code}）及其全部交易记录，且不可恢复。`
            : ''
        }
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}
