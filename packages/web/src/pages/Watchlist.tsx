/**
 * WatchlistPage — owner: web-ai-pages.
 * 我的标的：筛选/排序、添加、清空、AI 标的分析（SSE）与详情浮窗。
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  INSTRUMENT_TYPES,
  INSTRUMENT_TYPE_LABELS,
  MARKETS,
  MARKET_CURRENCY,
  MARKET_LABELS,
} from '@aia/shared';
import type { Creator, InstrumentType, Market, WatchItem } from '@aia/shared';
import { api } from '../api/client';
import { toApiError, useAgentStream, useAsync, useDebounced } from '../api/hooks';
import { fmtDate, fmtNum, fmtPct, fmtPrice, fmtSignedMoney, pnlClass } from '../format';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Empty,
  ErrorAlert,
  Input,
  Loading,
  ProgressBar,
  Segmented,
  SortHeader,
  useToast,
} from '../components/ui';
import { RunPanel } from '../components/RunPanel';
import { Sparkline } from '../components/charts/Sparkline';
import { WatchlistDetailDialog } from './WatchlistDetailDialog';
import { AddWatchItemDialog } from './WatchlistAddDialog';

type MarketFilter = 'all' | Market;
type TypeFilter = 'all' | InstrumentType;
type SourceFilter = 'all' | Creator;

export function WatchlistPage() {
  const toast = useToast();
  const [market, setMarket] = useState<MarketFilter>('all');
  const [type, setType] = useState<TypeFilter>('all');
  const [source, setSource] = useState<SourceFilter>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('changeSinceAdded');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [nonce, setNonce] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WatchItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const debouncedQuery = useDebounced(query, 350);
  const list = useAsync(
    () =>
      api.watchlist.list({
        market: market === 'all' ? undefined : market,
        type: type === 'all' ? undefined : type,
        source: source === 'all' ? undefined : source,
        q: debouncedQuery.trim() || undefined,
        sort,
        dir,
      }),
    [market, type, source, debouncedQuery, sort, dir, nonce],
  );
  const lastRun = useAsync(() => api.watchlist.lastAnalysis(), [nonce]);
  // 清空按钮面向全部标的（不受当前筛选影响），因此单独取一次未筛选的总数
  const allItems = useAsync(() => api.watchlist.list({}), [nonce]);
  const settings = useAsync(() => api.settings.get(), []);
  const llmMissing = settings.data !== null && !settings.data.hasApiKey;

  const stream = useAgentStream((event) => {
    if (event.entity === 'watchlist') setNonce((value) => value + 1);
  });

  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !stream.running) setNonce((value) => value + 1);
    wasRunning.current = stream.running;
  }, [stream.running]);

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? items.length;
  const clearCount = allItems.data?.total ?? total;
  const createdCount = stream.entities.filter((entity) => entity.entity === 'watchlist' && entity.action === 'created').length;
  const updatedCount = stream.entities.filter((entity) => entity.entity === 'watchlist' && entity.action === 'updated').length;
  const filtering = market !== 'all' || type !== 'all' || source !== 'all' || query.trim().length > 0;

  function onSort(field: string) {
    if (sort === field) setDir(dir === 'asc' ? 'desc' : 'asc');
    else {
      setSort(field);
      setDir('desc');
    }
  }

  async function removeItem() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.watchlist.remove(deleteTarget.id);
      toast.success('已删除标的', deleteTarget.name || deleteTarget.code);
      setDeleteTarget(null);
      setNonce((value) => value + 1);
    } catch (error) {
      const err = toApiError(error);
      toast.error('删除失败', err.isNotConfigured ? '服务端未配置 API Key，请到「设置」页填写' : err.message);
    } finally {
      setDeleting(false);
    }
  }

  async function clearAll() {
    setClearing(true);
    try {
      const result = await api.watchlist.clear();
      toast.success('已清空标的', `共删除 ${result.deleted} 个标的`);
      setClearOpen(false);
      setNonce((value) => value + 1);
    } catch (error) {
      const err = toApiError(error);
      toast.error('清空失败', err.message);
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="flex" style={{ flexDirection: 'column', gap: 14 }}>
      <Card
        title={
          <span className="center gap-2">
            我的标的
            <Badge>{total} 个</Badge>
            {lastRun.data && <span className="tiny mute">最近分析 {fmtDate(lastRun.data.startedAt)}</span>}
          </span>
        }
        actions={
          <div className="toolbar">
            <Button onClick={() => setAddOpen(true)}>添加标的</Button>
            <Button
              variant="primary"
              loading={stream.running}
              onClick={() => void stream.start('/watchlist/analyze')}
            >
              AI 标的分析
            </Button>
            <Button variant="danger" disabled={clearCount === 0} onClick={() => setClearOpen(true)}>
              清空标的
            </Button>
          </div>
        }
      >
        <div className="toolbar mb-3">
            <Segmented
              value={market}
              onChange={setMarket}
              options={[{ value: 'all', label: '全部市场' }, ...MARKETS.map((key) => ({ value: key as MarketFilter, label: MARKET_LABELS[key] }))]}
            />
            <Segmented
              value={type}
              onChange={setType}
              options={[
                { value: 'all', label: '全部类型' },
                ...INSTRUMENT_TYPES.map((key) => ({ value: key as TypeFilter, label: INSTRUMENT_TYPE_LABELS[key] })),
              ]}
            />
            <Segmented
              value={source}
              onChange={setSource}
              options={[
                { value: 'all', label: '全部来源' },
                { value: 'ai', label: 'AI 挖掘' },
                { value: 'manual', label: '手动添加' },
              ]}
            />
            <div style={{ minWidth: 180 }}>
              <Input
                value={query}
                placeholder="搜索名称 / 代码"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {filtering && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setMarket('all');
                  setType('all');
                  setSource('all');
                  setQuery('');
                }}
              >
                重置筛选
              </Button>
            )}
          </div>

          <div className="tiny mute mb-2">
            「AI 标的分析」会按当前投资性格搜索候选标的、逐个深度分析，并创建 / 更新「我的标的」。
          </div>

          {llmMissing && (
            <div className="mb-3">
              <Alert tone="warn">
                尚未配置 LLM API Key，AI 标的分析无法运行。请前往 <Link to="/settings">设置</Link> 填写 Base URL 与 API Key 后重试。
              </Alert>
            </div>
          )}

          <ErrorAlert error={list.error} onRetry={list.reload} />

          {list.loading && !list.data && <Loading label="正在加载标的列表…" />}

          {!list.loading && items.length === 0 && (
            <Empty
              title={filtering ? '没有符合条件的标的' : '还没有任何标的'}
              hint={filtering ? '试试放宽筛选条件或清空搜索关键词。' : '手动添加，或点击「AI 标的分析」让 Agent 按你的投资性格挖掘候选。'}
              action={
                <div className="toolbar">
                  <Button size="sm" onClick={() => setAddOpen(true)}>
                    添加标的
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => void stream.start('/watchlist/analyze')}>
                    AI 标的分析
                  </Button>
                </div>
              }
            />
          )}

          {items.length > 0 && (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <SortHeader label="标的资产名称" field="name" sort={sort} dir={dir} onSort={onSort} />
                    <th>市场代码</th>
                    <th>类型</th>
                    <th>市场</th>
                    <th>由谁创建</th>
                    <SortHeader label="优质评估" field="qualityScore" sort={sort} dir={dir} onSort={onSort} numeric />
                    <th className="num">目标价</th>
                    <th className="num">预期收益</th>
                    <SortHeader label="推荐后涨跌" field="changeSinceAdded" sort={sort} dir={dir} onSort={onSort} numeric />
                    <th className="right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const currency = MARKET_CURRENCY[item.market];
                    return (
                      <tr key={item.id}>
                        <td>
                          <div className="strong">{item.name || item.code}</div>
                          {item.note && <div className="tiny mute truncate" style={{ maxWidth: 200 }}>{item.note}</div>}
                        </td>
                        <td className="mono tiny">{item.code}</td>
                        <td>{INSTRUMENT_TYPE_LABELS[item.type]}</td>
                        <td>{MARKET_LABELS[item.market]}</td>
                        <td>
                          <Badge tone={item.source === 'ai' ? 'ai' : 'manual'}>{item.source === 'ai' ? 'AI' : '手动'}</Badge>
                        </td>
                        <td className="num">
                          <div className="center gap-2" style={{ justifyContent: 'flex-end' }}>
                            <div style={{ width: 64 }}>
                              <ProgressBar value={item.qualityScore} max={100} />
                            </div>
                            <span className="mono tiny">{fmtNum(item.qualityScore, 0)}</span>
                          </div>
                        </td>
                        <td className="num">{fmtPrice(item.targetPrice, currency)}</td>
                        <td className={`num ${pnlClass(item.expectedReturn)}`}>{fmtPct(item.expectedReturn)}</td>
                        <td className="num">
                          <div className={pnlClass(item.changeSinceAddedPct)}>{fmtPct(item.changeSinceAddedPct)}</div>
                          <div className={`tiny ${pnlClass(item.changeSinceAdded)}`}>
                            {fmtSignedMoney(item.changeSinceAdded, currency)}
                          </div>
                          <Sparkline
                            values={item.spark}
                            tone={item.changeSinceAddedPct > 0 ? 'pos' : item.changeSinceAddedPct < 0 ? 'neg' : 'flat'}
                          />
                        </td>
                        <td>
                          <div className="row-actions">
                            <Button size="sm" variant="ghost" onClick={() => setDetailId(item.id)}>
                              查看详情
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(item)}>
                              删除
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

      <RunPanel stream={stream} title="AI 标的分析" />

      {!stream.running && stream.finished && (
        <Alert tone={stream.finished.status === 'error' ? 'error' : 'info'}>
          本次运行结束（{stream.finished.status === 'error' ? '失败' : '成功'}）：新建 {createdCount} 个标的、更新 {updatedCount} 个标的。
          {stream.finished.summary && <div className="tiny mt-1">{stream.finished.summary}</div>}
        </Alert>
      )}

      <AddWatchItemDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={() => setNonce((value) => value + 1)}
      />

      <WatchlistDetailDialog
        id={detailId}
        onClose={() => setDetailId(null)}
        onChanged={() => setNonce((value) => value + 1)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        danger
        busy={deleting}
        title="删除标的"
        confirmLabel="删除"
        message={
          <>
            确认从「我的标的」中删除 <strong>{deleteTarget?.name || deleteTarget?.code}</strong>？此操作不可撤销。
          </>
        }
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void removeItem()}
      />

      <ConfirmDialog
        open={clearOpen}
        danger
        busy={clearing}
        title="清空我的标的"
        confirmLabel={`清空 ${clearCount} 个`}
        message={
          <>
            将删除「我的标的」中的<strong>全部 {clearCount} 个</strong>记录（含 AI 生成的分析结果）。已确认/已驳回的投资建议与我的资产不受影响，但此操作不可撤销。
          </>
        }
        onCancel={() => setClearOpen(false)}
        onConfirm={() => void clearAll()}
      />
    </div>
  );
}

