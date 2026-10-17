/**
 * IpoPage — 新股打新（owner: web-ai-pages）。
 *
 * 三板斧：
 *   ① 自动收集：A股（东方财富新股频道）/ 港股（經濟通 + 东方财富 + 阿斯達克）/ 美股（纳斯达克 IPO 日历），
 *      全部零 API Key 公开接口，点「刷新新股信息」按 uid 覆盖写入；
 *   ② AI 打新分析：一键跑 `ipo-analysis` 流水线，Agent 结合发行定价、招股书、财报、宏观与国际局势
 *      给出 verdict / 建议股数 / 优质分，结论落在本页的「AI 结论」列与详情浮窗里；
 *   ③ 中签入账：登记申购 → 登记中签，中签股数 > 0 时自动在「我的资产」建/复用持仓并写一笔 IPO 买入流水。
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  IPO_SOURCE_LABELS,
  IPO_STATUS_LABELS,
  IPO_SUBSCRIPTION_LABELS,
  MARKETS,
  MARKET_LABELS,
} from '@aia/shared';
import type { IpoOffer, IpoMarketStatus, Market } from '@aia/shared';
import { api } from '../api/client';
import { useAgentActivity, useAgentRefresh } from '../api/agentActivity';
import { toApiError, useAsync, useDebounced } from '../api/hooks';
import { fmtCompact, fmtDate, fmtDateTime, fmtNum } from '../format';
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  ErrorAlert,
  Input,
  Loading,
  MarketTag,
  ProgressBar,
  Segmented,
  SortHeader,
  StatCard,
  useToast,
} from '../components/ui';
import { IpoAddDialog } from './IpoAddDialog';
import { IpoDetailDialog } from './IpoDetailDialog';
import {
  IPO_VERDICT_HINT,
  IPO_VERDICT_TONE,
  expectedReturnClass,
  expectedReturnText,
  expectedValueText,
  priceText,
  truncateText,
  verdictLabel,
  verdictReasonText,
  winRateText,
  windowText,
} from './ipoView';

type MarketFilter = 'all' | Market;
type StatusFilter = 'all' | IpoMarketStatus | 'mine';
export type IpoSortField = 'subscribeEnd' | 'listingDate' | 'qualityScore' | 'name' | 'code';

/** 我的打新状态徽标：没登记 → 空；已登记/已中签/未中签 → 对应文案。 */
function SubscriptionTag({ offer }: { offer: IpoOffer }) {
  const sub = offer.subscription;
  if (!sub) return <span className="tiny mute">未登记</span>;
  const tone = sub.status === 'allotted' ? 'buy' : sub.status === 'missed' ? 'warn' : 'ai';
  return (
    <span className="flex" style={{ flexDirection: 'column', gap: 2 }}>
      <Badge tone={tone}>{IPO_SUBSCRIPTION_LABELS[sub.status]}</Badge>
      <span className="tiny mute nowrap">
        申购 {fmtNum(sub.appliedShares, 0)} 股
        {sub.allottedShares > 0 ? ` · 中签 ${fmtNum(sub.allottedShares, 0)} 股` : ''}
      </span>
    </span>
  );
}

/**
 * 客户端排序（导出以便单测）。
 *
 * 规则：默认按申购截止日升序 —— 最紧急的先看；已上市的排到最后（当参考而不是当机会）；
 * **上游没给截止日的排最后**，绝不把「未知」当成「今天截止」插到最前面。
 */
export function sortIpoOffers(items: IpoOffer[], sort: IpoSortField, dir: 'asc' | 'desc'): IpoOffer[] {
  const rows = [...items];
  const rank = (offer: IpoOffer): number => (offer.status === 'listed' ? 1 : 0);
  const factor = dir === 'asc' ? 1 : -1;
  /** 日期排序：上游没给的排最后（升降序都沉底），绝不把「未知」当成「最近」。 */
  const byDate = (left: string | null, right: string | null): number => {
    if (!left && !right) return 0;
    if (!left) return 1;
    if (!right) return -1;
    return left.localeCompare(right) * factor;
  };
  rows.sort((a, b) => {
    // 已上市的一律沉底：它是参考信息，不是还能下手的机会（任何排序下都成立）。
    const byStatus = rank(a) - rank(b);
    if (byStatus !== 0) return byStatus;
    if (sort === 'qualityScore') return (a.qualityScore - b.qualityScore) * factor;
    if (sort === 'name') return a.name.localeCompare(b.name, 'zh-Hans-CN') * factor;
    if (sort === 'code') return a.code.localeCompare(b.code) * factor;
    if (sort === 'listingDate') return byDate(a.listingDate, b.listingDate);
    return byDate(a.subscribeEnd, b.subscribeEnd);
  });
  return rows;
}

export function IpoPage() {
  const toast = useToast();
  const [market, setMarket] = useState<MarketFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<IpoSortField>('subscribeEnd');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [nonce, setNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const debouncedQuery = useDebounced(query, 350);
  const list = useAsync(
    () =>
      api.ipo.list({
        market: market === 'all' ? undefined : market,
        status: status === 'mine' ? undefined : status === 'all' ? undefined : status,
        q: debouncedQuery.trim() || undefined,
        limit: 200,
      }),
    [market, status, debouncedQuery, nonce],
  );
  const settings = useAsync(() => api.settings.get(), []);
  const lastRun = useAsync(() => api.ipo.lastAnalysis(), [nonce]);
  const llmMissing = settings.data !== null && !settings.data.hasApiKey;

  const { run, running } = useAgentActivity();
  useAgentRefresh(() => setNonce((value) => value + 1));
  useEffect(() => {
    if (list.data) setWarnings(list.data.warnings);
  }, [list.data]);

  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const counts = list.data?.counts ?? { total: 0, CN: 0, HK: 0, US: 0, subscribing: 0, applied: 0, allotted: 0 };

  const sorted = useMemo(() => sortIpoOffers(items, sort, dir), [items, sort, dir]);

  /** 我的打新（服务端全量过滤）：已登记申购/中签的标的。 */
  const mine = useMemo(() => items.filter((offer) => offer.subscription !== null), [items]);
  /** AI 结论分布：申购 / 放弃各有几只（写在标题上，一眼看清这批值不值得打）。 */
  const verdictCounts = useMemo(
    () => ({
      subscribe: items.filter((offer) => offer.verdict === 'subscribe').length,
      avoid: items.filter((offer) => offer.verdict === 'avoid').length,
    }),
    [items],
  );
  const visible = status === 'mine' ? mine : sorted;

  const onSort = (field: string): void => {
    const next = field as IpoSortField;
    if (next === sort) setDir(dir === 'asc' ? 'desc' : 'asc');
    else {
      setSort(next);
      setDir(next === 'qualityScore' ? 'desc' : 'asc');
    }
  };

  /** 抓取三地新股（零 Key 公开源）。 */
  async function refreshOffers(): Promise<void> {
    setRefreshing(true);
    try {
      const result = await api.ipo.refresh({});
      setWarnings(result.warnings);
      const scope = result.byMarket.map((entry) => `${MARKET_LABELS[entry.market]} ${entry.count}`).join(' / ');
      toast.success(
        '新股信息已刷新',
        `抓取 ${result.fetched} 只（新增 ${result.inserted}、更新 ${result.updated}）${scope ? `｜${scope}` : ''}`,
      );
      setNonce((value) => value + 1);
    } catch (error) {
      toast.error('刷新失败', toApiError(error).message);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="flex" style={{ flexDirection: 'column', gap: 14 }}>
      {/* ① 概览 + 主操作 */}
      <div className="grid-4">
        <StatCard
          label="申购中"
          value={counts.subscribing}
          sub={counts.subscribing > 0 ? '正在招股，抓紧申购' : '当前没有在招股的新股'}
          tone={counts.subscribing > 0 ? 'pos' : 'default'}
        />
        <StatCard label="库内新股" value={counts.total} sub={`A股 ${counts.CN} · 港股 ${counts.HK} · 美股 ${counts.US}`} />
        <StatCard label="我已申购" value={counts.applied} sub="登记后中签即可自动入账" />
        <StatCard label="已中签入账" value={counts.allotted} sub="已写入「我的资产」" tone={counts.allotted > 0 ? 'pos' : 'default'} />
      </div>

      <Card
        title={
          <span className="center gap-2">
            新股打新
            <Badge>{visible.length} 只</Badge>
            {verdictCounts.subscribe > 0 && (
              <Badge tone="ipo-subscribe" title={IPO_VERDICT_HINT.subscribe}>
                {verdictCounts.subscribe} 只建议申购
              </Badge>
            )}
            {verdictCounts.avoid > 0 && (
              <Badge tone="ipo-avoid" title={IPO_VERDICT_HINT.avoid}>
                {verdictCounts.avoid} 只建议放弃
              </Badge>
            )}
            {lastRun.data && <span className="tiny mute">最近分析 {fmtDateTime(lastRun.data.startedAt)}</span>}
            {list.data?.lastRefreshAt && (
              <span className="tiny mute">信息更新于 {fmtDateTime(list.data.lastRefreshAt)}</span>
            )}
          </span>
        }
        actions={
          <div className="toolbar">
            <Button loading={refreshing} title="抓取 A股/港股/美股新股信息（公开零 Key 数据源）" onClick={() => void refreshOffers()}>
              刷新新股信息
            </Button>
            <Button onClick={() => setAddOpen(true)}>手动录入</Button>
            <Button
              variant="primary"
              loading={running}
              title="AI 结合发行定价、招股书、财报、宏观与国际局势给出是否申购的结论"
              onClick={() => run({ path: '/ipo/analyze', title: 'AI 打新分析' })}
            >
              AI 打新分析
            </Button>
          </div>
        }
      >
        <div className="toolbar mb-3">
          <Segmented
            value={market}
            onChange={setMarket}
            options={[
              { value: 'all', label: '全部市场' },
              ...MARKETS.map((key) => ({ value: key as MarketFilter, label: MARKET_LABELS[key] })),
            ]}
          />
          <Segmented
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: '全部阶段' },
              { value: 'subscribing', label: '申购中' },
              { value: 'upcoming', label: '待申购' },
              { value: 'allotted', label: '待上市' },
              { value: 'listed', label: '已上市' },
              { value: 'mine', label: `我的打新（${mine.length}）` },
            ]}
          />
          <div style={{ minWidth: 180 }}>
            <Input value={query} placeholder="搜索名称 / 代码" onChange={(event) => setQuery(event.target.value)} />
          </div>
        </div>

        {llmMissing && (
          <div className="mb-3">
            <Alert tone="warn">
              尚未配置 LLM API Key，AI 打新分析无法运行。请前往 <Link to="/settings">设置</Link> 填写 Base URL 与 API Key 后重试。
            </Alert>
          </div>
        )}
        {warnings.length > 0 && (
          <div className="mb-3">
            <Alert tone="warn">
              <div>部分数据源本次不可用，下面的列表可能不完整：</div>
              <ul className="tiny" style={{ margin: '4px 0 0 16px' }}>
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Alert>
          </div>
        )}

        <ErrorAlert error={list.error} onRetry={list.reload} />
        {list.loading && !list.data && <Loading label="正在加载新股列表…" />}

        {!list.loading && visible.length === 0 && (
          <Empty
            title={status === 'mine' ? '还没有登记过打新' : query || market !== 'all' ? '没有符合条件的新股' : '还没有新股信息'}
            hint={
              status === 'mine'
                ? '在详情浮窗里点「登记申购」后，这里会显示你的申购与中签记录。'
                : '点「刷新新股信息」从 A股/港股/美股公开数据源抓取当前发行季的新股。'
            }
            action={
              <div className="toolbar">
                <Button size="sm" loading={refreshing} onClick={() => void refreshOffers()}>
                  刷新新股信息
                </Button>
                <Button size="sm" variant="primary" onClick={() => run({ path: '/ipo/analyze', title: 'AI 打新分析' })}>
                  AI 打新分析
                </Button>
              </div>
            }
          />
        )}

        {visible.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortHeader label="新股" field="name" sort={sort} dir={dir} onSort={onSort} />
                  <th>市场</th>
                  <th>阶段</th>
                  <th className="num">发行价</th>
                  <th className="num">每手 / 上限</th>
                  <SortHeader label="申购窗口" field="subscribeEnd" sort={sort} dir={dir} onSort={onSort} />
                  <SortHeader label="中签日 / 上市日" field="listingDate" sort={sort} dir={dir} onSort={onSort} />
                  <th className="num">中签率 / 超购</th>
                  <th className="num">胜率 / 预期收益</th>
                  <SortHeader label="AI 结论" field="qualityScore" sort={sort} dir={dir} onSort={onSort} numeric />
                  <th>我的打新</th>
                  <th className="right">操作</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((offer) => (
                  <tr key={offer.id}>
                    <td>
                      <div className="strong">
                        {offer.name || offer.code}
                        {offer.board && <span className="tiny mute"> {offer.board}</span>}
                      </div>
                      <div className="tiny mute mono">
                        {offer.code}
                        {offer.subscribeCode && offer.subscribeCode !== offer.code ? ` / 申购 ${offer.subscribeCode}` : ''}
                      </div>
                      {offer.industry && <div className="tiny mute truncate" style={{ maxWidth: 200 }}>{offer.industry}</div>}
                    </td>
                    <td>
                      <MarketTag market={offer.market} />
                    </td>
                    <td>
                      <Badge tone={offer.status === 'subscribing' ? 'ok' : 'default'}>
                        {IPO_STATUS_LABELS[offer.status] ?? offer.status}
                      </Badge>
                    </td>
                    <td className="num mono">{priceText(offer)}</td>
                    <td className="num tiny">
                      <div>{offer.lotSize > 0 ? `${fmtNum(offer.lotSize, 0)} 股/手` : '每手未提供'}</div>
                      <div className="mute">{offer.maxShares > 0 ? `上限 ${fmtCompact(offer.maxShares)} 股` : '上限未提供'}</div>
                    </td>
                    <td className="tiny mono">{windowText(offer)}</td>
                    <td className="tiny mono">
                      <div>{offer.allotmentDate ? `中签 ${offer.allotmentDate}` : '中签日未提供'}</div>
                      <div className="mute">{offer.listingDate ? `上市 ${fmtDate(offer.listingDate)}` : '上市日未提供'}</div>
                    </td>
                    <td className="num tiny">
                      <div>{offer.winningRate > 0 ? `中签率 ${fmtNum(offer.winningRate, 2)}%` : '中签率未提供'}</div>
                      <div className="mute">{offer.oversubscribe > 0 ? `超购 ${fmtNum(offer.oversubscribe, 1)} 倍` : '超购未提供'}</div>
                    </td>
                    {/* 胜率与预期收益都来自 AI 推算（中签率来自上游公告），未评估时如实说「未评估」。 */}
                    <td className="num tiny">
                      <div>{winRateText(offer)}</div>
                      <div className={expectedReturnClass(offer)}>{expectedReturnText(offer)}</div>
                      <div className="mute">{expectedValueText(offer)}</div>
                    </td>
                    <td className="num">
                      {offer.verdict ? (
                        <div className="center gap-2" style={{ justifyContent: 'flex-end' }}>
                          <div style={{ width: 54 }}>
                            <ProgressBar value={offer.qualityScore} max={100} />
                          </div>
                          <span className="mono tiny">{fmtNum(offer.qualityScore, 0)}</span>
                        </div>
                      ) : (
                        <span className="tiny mute">待分析</span>
                      )}
                      {offer.verdict && (
                        <div className="tiny nowrap">
                          <Badge tone={IPO_VERDICT_TONE[offer.verdict]} title={IPO_VERDICT_HINT[offer.verdict]}>
                            {verdictLabel(offer.verdict)}
                          </Badge>
                          {offer.suggestedShares > 0 ? (
                            <span className="mute"> {fmtNum(offer.suggestedShares, 0)} 股</span>
                          ) : (
                            <span className="mute"> 本期不申购</span>
                          )}
                        </div>
                      )}
                      {/* 一句话理由：高胜率却「本期不申购」时，必须在这里看到绑定约束（多为预算缺口）。 */}
                      {offer.verdict && verdictReasonText(offer) && (
                        <div className="tiny mute" style={{ maxWidth: 240, marginTop: 2 }} title={verdictReasonText(offer)}>
                          {truncateText(verdictReasonText(offer), 46)}
                        </div>
                      )}
                    </td>
                    <td>
                      <SubscriptionTag offer={offer} />
                    </td>
                    <td>
                      <div className="row-actions">
                        <Button size="sm" variant="ghost" onClick={() => setDetailId(offer.id)}>
                          详情 / 登记
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="tiny mute mt-2">
          数据来源：{Object.values(IPO_SOURCE_LABELS).join(' · ')}。上游没有提供的字段一律显示「未提供」，不使用 0
          冒充；港股已上市新股的招股价、超购倍数与中签率来自阿斯達克，中签率单位为 %。
          <br />
          口径提示：<b>中签率</b>来自上游公告，回答「能不能买到」；<b>胜率 / 预期收益 / 期望值</b>是 AI 推算，
          回答「买到之后赚不赚」（期望值 = 胜率 × 预期收益，只按打中一手计算，不含中签率）。
          <b>AI 结论</b>回答的是「<b>本期该不该打</b>」——已把本月预算与一手入场费算进去，所以「胜率高但显示中性观察/本期不申购」
          通常是预算不够，具体缺口写在结论下方的一句话理由里。
          本页颜色为<b>打新风险语义</b>：绿=值得下手、红=建议放弃，与行情「红涨绿跌」相反。
        </div>
      </Card>

      <IpoDetailDialog id={detailId} onClose={() => setDetailId(null)} onChanged={() => setNonce((value) => value + 1)} />
      <IpoAddDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={() => setNonce((value) => value + 1)}
      />
    </div>
  );
}