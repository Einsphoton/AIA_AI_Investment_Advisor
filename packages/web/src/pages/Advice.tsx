/**
 * AdvicePage — owner: web-ai-pages.
 * AI 投资建议：月度预算约束、SSE 生成、确认/驳回。
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MARKETS, MARKET_LABELS } from '@aia/shared';
import type { AdviceItem, AdviceOutcome } from '@aia/shared';
import { api } from '../api/client';
import { useAgentActivity, useAgentRefresh } from '../api/agentActivity';
import { toApiError, useAsync } from '../api/hooks';
import { fmtDateTime, fmtMoney, fmtPct, fmtPrice, fmtShares, pnlClass, safeNumber, todayIso } from '../format';
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  ErrorAlert,
  Field,
  HoverTip,
  Input,
  InstrumentTypeTag,
  Loading,
  MarketTag,
  Modal,
  ProgressBar,
  Segmented,
  StatCard,
  useToast,
} from '../components/ui';
import { Markdown } from '../components/markdown/Markdown';
import { parseMarkdown, toPlainText } from '../components/markdown/parse';

type StatusFilter = 'pending' | 'confirmed' | 'rejected';

/** 建议来源标签：持仓（加仓/减仓）/ 我的标的（过过质量分门槛）/ 池外。 */
const ORIGIN_LABEL: Record<AdviceItem['origin'], string> = {
  holding: '持仓',
  watchlist: '我的标的',
  external: '池外',
};

const ORIGIN_TONE: Record<AdviceItem['origin'], 'manual' | 'ai' | 'warn'> = {
  holding: 'manual',
  watchlist: 'ai',
  external: 'warn',
};

const ORIGIN_HINT: Record<AdviceItem['origin'], string> = {
  holding: '针对你已持有的标的（加仓 / 减仓）。',
  watchlist: '来自「我的标的」——已经通过 AI 标的分析的质量分门槛。',
  external: '既不是持仓、也不在「我的标的」中：这条建议跳过了候选池筛选，建议先进「我的标的」复核后再决定。',
};

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'pending', label: '待处理' },
  { value: 'confirmed', label: '已确认' },
  { value: 'rejected', label: '已驳回' },
];

export function AdvicePage() {
  const toast = useToast();
  const [status, setStatus] = useState<StatusFilter>('pending');
  const [nonce, setNonce] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<AdviceItem | null>(null);

  const list = useAsync(() => api.advice.list(status), [status, nonce]);
  const last = useAsync(() => api.advice.last(), [nonce]);
  const settings = useAsync(() => api.settings.get(), []);
  const [trackNonce, setTrackNonce] = useState(0);
  const [tracking, setTracking] = useState(false);
  const outcomes = useAsync(() => api.advice.outcomes(), [nonce, trackNonce]);
  const llmMissing = settings.data !== null && !settings.data.hasApiKey;
  // 建议写作 / 资产写作 / 简报写作与运行结束都会刷新列表；
  // 推理过程与「新增 N 条建议」结论统一显示在右下角全局面板里。
  const { run, running, budget: liveBudget } = useAgentActivity();
  useAgentRefresh(() => setNonce((value) => value + 1));

  const items = list.data?.items ?? [];
  // 运行中优先用 SSE 推送的实时预算（budget 事件）；运行结束后回落到列表返回的预算
  const budget = (running ? liveBudget : null) ?? list.data?.budget ?? null;

  // 逐条实际表现：与建议按 adviceId 关联（列表可能只显示某个状态，追踪结果全量返回）。
  const outcomeById = new Map((outcomes.data?.items ?? []).map((row) => [row.adviceId, row]));
  const adviceNameById = new Map(items.map((row) => [row.id, row.assetName || row.code]));
  const outcomeStats = outcomes.data?.stats ?? null;

  /**
   * 主动重算一次（确定性、不调用 LLM）。界面上的数字永远来自这里写库的结果，
   * 而不是前端自己推算——口径与后端完全一致。
   */
  async function refreshOutcomes() {
    setTracking(true);
    try {
      const result = await api.advice.trackOutcomes();
      toast.info(
        '已刷新建议追踪',
        `重算 ${result.tracked.tracked} 条 · 可度量 ${result.tracked.measured} 条 · 不可度量 ${result.tracked.unmeasurable} 条`,
      );
      setTrackNonce((value) => value + 1);
    } catch (error) {
      toast.error('刷新追踪失败', toApiError(error).message);
    } finally {
      setTracking(false);
    }
  }

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
          <br />
          每条建议都会 <strong>结合你的持仓与「我的标的」</strong>给出，并标注来源：<Badge tone="manual">持仓</Badge> 加仓 / 减仓、
          <Badge tone="ai">我的标的</Badge> 来自候选池、<Badge tone="warn">池外</Badge> 表示既非持仓也不在「我的标的」中
          —— 这类建议<strong>跳过了候选池的质量分门槛</strong>，请先复核再决定是否采纳。
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
                  <th style={{ width: 268 }}>理由</th>
                  <th className="num">置信度</th>
                  <th>给出建议的日期</th>
                  <th className="right">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  return (
                    <tr key={item.id} style={item.status === 'pending' ? undefined : { opacity: 0.62 }}>
                      <td>
                        <div className="strong">{item.assetName || item.code}</div>
                        {/* 市场 + 资产类型：股票 / 场内基金 / 场外基金一眼可辨。 */}
                        <div className="tiny center gap-2 wrap">
                          <MarketTag market={item.market} />
                          <InstrumentTypeTag type={item.type} />
                          <span className="mono mute">{item.code}</span>
                        </div>
                        {/* 来源必须可见：池外建议意味着它跳过了「AI 标的分析」的候选池筛选。 */}
                        <div className="mt-1">
                          <Badge tone={ORIGIN_TONE[item.origin]} title={ORIGIN_HINT[item.origin]}>
                            来源：{ORIGIN_LABEL[item.origin]}
                          </Badge>
                        </div>
                        {outcomeById.get(item.id) && (
                          <div className="mt-1 tiny" title={outcomeHint(outcomeById.get(item.id)!)}>
                            <span className={`strong ${pnlClass(outcomeById.get(item.id)!.adviceReturnPct)}`}>
                              实际 {fmtPct(outcomeById.get(item.id)!.adviceReturnPct)}
                            </span>
                            {outcomeById.get(item.id)!.benchmarkCode !== '' ? (
                              <span className={`mute ${pnlClass(outcomeById.get(item.id)!.excessPct)}`}>
                                {' '}
                                · 超额 {fmtPct(outcomeById.get(item.id)!.excessPct)}
                              </span>
                            ) : (
                              <span className="mute"> · 无基准</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td>
                        <Badge tone={item.action === 'buy' ? 'buy' : 'sell'}>{item.action === 'buy' ? '买入' : '卖出'}</Badge>
                      </td>
                      <td className="num">{fmtShares(item.targetShares)}</td>
                      <td className="num">{fmtPrice(item.targetPrice, item.currency)}</td>
                      <td className="num">{fmtMoney(item.amount, item.currency)}</td>
                      <td style={{ maxWidth: 268 }}>
                        {/* 列表里只留两行摘要（去掉 Markdown 标记），全文放进悬浮浮窗，
                            避免长理由把整行撑高、把表格挤得难读。 */}
                        {item.reason ? (
                          <HoverTip
                            label={`查看完整理由：${item.assetName || item.code}`}
                            title={`${item.assetName || item.code} · ${item.action === 'buy' ? '买入' : '卖出'}理由`}
                            content={<Markdown text={item.reason} variant="compact" />}
                          >
                            <span className="hovertip-clamp">{summarizeReason(item.reason)}</span>
                            <span className="hovertip-more">悬浮 / 点击查看全文</span>
                          </HoverTip>
                        ) : (
                          <span className="mute">—</span>
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

      <Card
        title={
          <span className="center gap-2">
            建议结果追踪
            {outcomeStats && <Badge>{`观测窗口 ${outcomeStats.windowDays} 天`}</Badge>}
          </span>
        }
        actions={
          <div className="toolbar">
            {outcomeStats?.updatedAt && (
              <span className="tiny mute">最近追踪：{fmtDateTime(outcomeStats.updatedAt)}</span>
            )}
            <Button size="sm" loading={tracking} onClick={() => void refreshOutcomes()}>
              刷新追踪
            </Button>
          </div>
        }
      >
        <div className="tiny mute mb-2">
          这一栏回答的是「<strong>AI 的建议到底对不对</strong>」：每条建议按 <strong>建议日之后第一个交易日收盘</strong> 建基准
          （避免用建议当日收盘造成前视偏差），与同区间基准比较，算出方向调整后的收益与超额 ——
          <strong>卖出建议看跌幅</strong>（跌了才算方向对）。基准：A股 沪深300、港股 盈富基金（恒生指数 ETF）、美股 SPY。
          全部由后端确定性重算，<strong>与你是否真的买入无关</strong>；样本不足的条目不计入胜率。
        </div>

        <ErrorAlert error={outcomes.error} onRetry={outcomes.reload} />
        {outcomes.loading && !outcomes.data && <Loading label="正在读取追踪结果…" />}

        {outcomeStats && outcomeStats.total === 0 && (
          <Empty
            title="还没有追踪结果"
            hint="点击右上角「刷新追踪」：后端会按每条建议「建议日之后第一个交易日」的收盘价重算实际表现与超额收益（确定性计算，不调用 LLM）。"
          />
        )}

        {outcomeStats && outcomeStats.total > 0 && (
          <>
            {outcomeStats.warnings.map((warning) => (
              <div className="mb-2" key={warning}>
                <Alert tone="warn">{warning}</Alert>
              </div>
            ))}

            <div className="stat-grid">
              <StatCard
                label="方向胜率"
                value={outcomeStats.measured > 0 ? fmtPct(outcomeStats.winRate, 1, false) : '—'}
                tone={outcomeStats.measured > 0 ? (outcomeStats.winRate >= 50 ? 'pos' : 'neg') : 'default'}
                sub={`可度量 ${outcomeStats.measured} / ${outcomeStats.total} 条`}
                hint="adviceReturnPct > 0 的比例。买入看涨幅、卖出看跌幅。样本不足 2 个交易日的条目不参与。"
              />
              <StatCard
                label="跑赢基准"
                value={outcomeStats.measured > 0 ? fmtPct(outcomeStats.beatRate, 1, false) : '—'}
                tone={outcomeStats.measured > 0 ? (outcomeStats.beatRate >= 50 ? 'pos' : 'neg') : 'default'}
                sub="超额收益 > 0 的比例"
                hint="只统计能取到基准序列的条目；没有基准的不会进分母。"
              />
              <StatCard
                label="平均收益"
                value={outcomeStats.measured > 0 ? fmtPct(outcomeStats.avgReturnPct) : '—'}
                tone={outcomeStats.avgReturnPct >= 0 ? 'pos' : 'neg'}
                sub="按建议方向调整"
                hint="所有可度量条目的方向调整收益均值。"
              />
              <StatCard
                label="平均超额"
                value={outcomeStats.measured > 0 ? fmtPct(outcomeStats.avgExcessPct) : '—'}
                tone={outcomeStats.avgExcessPct >= 0 ? 'pos' : 'neg'}
                sub="相对同期基准"
                hint="收益 − 同区间基准涨幅；无基准的条目不计入。"
              />
              <StatCard
                label="还不可度量"
                value={String(outcomeStats.unmeasured)}
                sub="样本不足或序列缺失"
                hint="这些条目不进胜率分母。数字越小，上面的胜率越可信。"
              />
            </div>

            {(outcomes.data?.items.length ?? 0) > 0 && (
              <div className="table-wrap mt-3">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>标的</th>
                      <th>建议</th>
                      <th>度量区间</th>
                      <th className="num">基准价 → 最新</th>
                      <th className="num">收益</th>
                      <th className="num">基准</th>
                      <th className="num">超额</th>
                      <th className="num">区间最好 / 最差</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outcomes.data?.items.map((row) => (
                      <tr key={row.adviceId} title={outcomeHint(row)}>
                        <td>
                          <div className="strong">{adviceNameById.get(row.adviceId) ?? row.code}</div>
                          <div className="tiny mute mono">
                            {MARKET_LABELS[row.market]} · {row.code}
                          </div>
                        </td>
                        <td>
                          <Badge tone={row.action === 'buy' ? 'buy' : 'sell'}>
                            {row.action === 'buy' ? '买入' : '卖出'}
                          </Badge>
                          {row.executed && <div className="tiny mute mt-1">已执行</div>}
                        </td>
                        <td className="tiny nowrap">
                          {row.samples < 2 ? (
                            <span className="mute">样本不足（{row.samples} 个交易日）</span>
                          ) : (
                            <>
                              {row.baselineDate} → {row.lastDate}
                              <div className="mute">共 {row.samples} 个交易日</div>
                            </>
                          )}
                        </td>
                        <td className="num nowrap">
                          {row.baselinePrice > 0 ? (
                            <>
                              {fmtPrice(row.baselinePrice)}
                              <div className="mute">→ {fmtPrice(row.lastPrice)}</div>
                            </>
                          ) : (
                            <span className="mute">—</span>
                          )}
                        </td>
                        <td className={`num ${pnlClass(row.adviceReturnPct)}`}>
                          {row.samples < 2 ? <span className="mute">—</span> : fmtPct(row.adviceReturnPct)}
                        </td>
                        <td className={`num ${pnlClass(row.benchmarkChangePct)}`}>
                          {row.benchmarkCode === '' ? <span className="mute">—</span> : fmtPct(row.benchmarkChangePct)}
                        </td>
                        <td className={`num ${pnlClass(row.excessPct)}`}>
                          {row.benchmarkCode === '' ? <span className="mute">—</span> : fmtPct(row.excessPct)}
                        </td>
                        <td className="num nowrap">
                          <span className="pos">{fmtPct(row.maxReturnPct)}</span>
                          <div className="neg">{fmtPct(row.minReturnPct)}</div>
                        </td>
                        <td className="tiny">
                          {row.status === 'expired' ? (
                            <Badge>已冻结</Badge>
                          ) : (
                            <Badge tone="ai">追踪中</Badge>
                          )}
                          {row.warnings.length > 0 && (
                            <div className="mt-1">
                              <HoverTip
                                label={`查看 ${row.code} 的追踪告警`}
                                title={`${row.code} · 追踪告警`}
                                content={
                                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                                    {row.warnings.map((warning) => (
                                      <li key={warning}>{warning}</li>
                                    ))}
                                  </ul>
                                }
                              >
                                <span className="warn">⚠ {row.warnings.length} 条告警</span>
                              </HoverTip>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
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

/**
 * 鼠标悬浮的口径说明：必须把「基准日、基准价、方向调整规则、样本数」讲清楚，
 * 否则用户会把「收益 +10%」误读成自己的真实盈亏。
 */
function outcomeHint(row: AdviceOutcome): string {
  const direction =
    row.action === 'sell' ? '卖出建议：下跌才计入正收益（方向调整）' : '买入建议：上涨计入正收益';
  const span =
    row.baselinePrice > 0
      ? `基准 ${row.baselineDate} 收盘 ${row.baselinePrice} → ${row.lastDate} 收盘 ${row.lastPrice}`
      : '尚无可用基准价（建议日之后还没有交易日）';
  const bench =
    row.benchmarkCode === ''
      ? '基准数据缺失，未计算超额'
      : `基准 ${row.benchmarkName} 同期 ${fmtPct(row.benchmarkChangePct)}`;
  return `${direction}；${span}；${bench}；样本 ${row.samples} 个交易日。此为方向准确度，不是你的真实盈亏。`;
}

/**
 * One-line plain-text summary of a Markdown reason.
 *
 * Markdown markers (**、-、|) would otherwise show up as literal noise inside a
 * two-line table cell, so the summary is rendered from the parsed tree.
 */
function summarizeReason(reason: string): string {
  const text = toPlainText(parseMarkdown(reason)).replace(/\s+/g, ' ').trim();
  return text || reason;
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
            {item.reason && (
              <div className="mt-2">
                <Markdown text={item.reason} variant="compact" />
              </div>
            )}
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
