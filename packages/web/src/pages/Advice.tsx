/**
 * AdvicePage — owner: web-ai-pages.
 * AI 投资建议：月度预算约束、SSE 生成、确认/驳回。
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  MARKETS,
  MARKET_LABELS,
  IPO_SOURCE_LABELS,
  OPTION_STRATEGY_INTENT,
  OPTION_STRATEGY_LABELS,
  OPTION_TYPE_LABELS,
} from '@aia/shared';
import type { AdviceItem, AdviceOutcome, IpoOffer } from '@aia/shared';
import { api } from '../api/client';
import { useAgentActivity, useAgentRefresh } from '../api/agentActivity';
import { toApiError, useAsync } from '../api/hooks';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, fmtPct, fmtPrice, fmtShares, pnlClass, safeNumber, todayIso } from '../format';
import { ConfirmOptionAdviceDialog } from './ConfirmOptionAdviceDialog';
import {
  OPTION_STRATEGY_TONE,
  assignmentProbabilityHint,
  expiryCountdown,
  liquidityText,
  optionAssignmentConsequence,
  optionCollateralText,
  optionDataLine,
} from './optionView';
import { IpoDetailDialog } from './IpoDetailDialog';
import {
  IPO_VERDICT_HINT,
  IPO_VERDICT_TONE,
  expectedReturnClass,
  expectedReturnText,
  priceText,
  selectActionableIpoOffers,
  truncateText,
  verdictLabel,
  verdictReasonText,
  winRateText,
} from './ipoView';
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
  /** 期权建议的最终确认弹窗（与股票那份分开：写的是卖出合约而不是股票流水）。 */
  const [optionTarget, setOptionTarget] = useState<AdviceItem | null>(null);

  const list = useAsync(() => api.advice.list(status), [status, nonce]);
  const last = useAsync(() => api.advice.last(), [nonce]);
  const settings = useAsync(() => api.settings.get(), []);
  const [trackNonce, setTrackNonce] = useState(0);
  const [tracking, setTracking] = useState(false);
  /** 打新登记入口：从「打新建议」表格点按钮打开同一个详情/登记浮窗。 */
  const [registerId, setRegisterId] = useState<string | null>(null);
  const outcomes = useAsync(() => api.advice.outcomes(), [nonce, trackNonce]);
  // 打新结论也参与预算：中签缴款占用的现金必须从当月可用额度里扣掉，
  // 所以建议页要能看到「正在招股 + AI 建议申购」的标的与建议股数。
  const ipo = useAsync(() => api.ipo.list({ limit: 100 }), [nonce]);
  const llmMissing = settings.data !== null && !settings.data.hasApiKey;
  // 建议写作 / 资产写作 / 简报写作与运行结束都会刷新列表；
  // 推理过程与「新增 N 条建议」结论统一显示在右下角全局面板里。
  const { run, running, budget: liveBudget } = useAgentActivity();
  useAgentRefresh(() => setNonce((value) => value + 1));

  const items = list.data?.items ?? [];
  /**
   * 期权建议与股票建议分开渲染：期权要讲的是「行权价 / 到期 / 年化 / 安全垫 / 被行权概率 /
   * 担保占用」，塞进股票那张表里只会两边都读不清。
   */
  const optionItems = items.filter((item) => item.instrument === 'option');
  const stockItems = items.filter((item) => item.instrument !== 'option');
  const optionPending = optionItems.filter((item) => item.status === 'pending').length;
  /** 正在招股 / 待申购的新股：这是会与买入建议抢当月现金的部分。 */
  const ipoLive: IpoOffer[] = (ipo.data?.items ?? []).filter(
    (offer) => offer.status === 'subscribing' || offer.status === 'upcoming',
  );
  /**
   * 只把**值得下手**的放进这张表：AI 已明确「建议放弃」的不再占位
   * （放弃的标的不会占用现金，列在这里只会稀释注意力），改成一句计数说明。
   */
  const { actionable: ipoActionable, avoided: ipoAvoided } = selectActionableIpoOffers(ipo.data?.items ?? []);
  const ipoRegisterCount = ipoActionable.filter((offer) => offer.verdict === 'subscribe').length;
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
          点击「AI 投资建议」会先跑<strong>资产分析 → 标的分析 → 打新分析 → 期权卖权</strong>，再汇总生成买入 / 卖出 / 期权卖权建议；
          买入建议受下方月度预算约束，打新缴款同样占用当月资金，卖 Put 的担保现金在「设置 → 期权卖权」里填。
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

      {/* 正股买卖建议排在最前面：它是本页最主要、也最常被处理的内容；
          打新与期权卖权各自独立成卡片，排在它后面。 */}
      <Card
        title={
          <span className="center gap-2">
            建议列表（{stockItems.length}）
            {optionItems.length > 0 && <Badge tone="ai">期权另有 {optionItems.length} 条</Badge>}
          </span>
        }
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

        {!list.loading && items.length > 0 && stockItems.length === 0 && (
          <div className="tiny mute">本批建议都是期权卖权，已在下方「期权卖权建议」卡片里逐条展开。</div>
        )}

        {stockItems.length > 0 && (
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
                {stockItems.map((item) => {
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

      {/* 打新与买入建议共用同一份当月预算：正在招股且**还没被建议放弃**的标的必须在这里可见，
          并且可以直接登记申购 / 中签（复用打新详情浮窗，不另造表单）。 */}
      <Card
        title={
          <span className="center gap-2">
            打新建议
            {ipoActionable.length > 0 && <Badge>{ipoActionable.length} 只可打</Badge>}
            {ipoRegisterCount > 0 && (
              <Badge tone="ipo-subscribe" title={IPO_VERDICT_HINT.subscribe}>
                {ipoRegisterCount} 只建议申购
              </Badge>
            )}
          </span>
        }
        actions={
          <div className="toolbar">
            <Link to="/ipo" className="tiny">
              全部新股 / 历史结论 →
            </Link>
            <Button
              loading={running}
              onClick={() => run({ path: '/ipo/analyze', title: 'AI 打新分析' })}
            >
              AI 打新分析
            </Button>
          </div>
        }
      >
        {ipoLive.length === 0 ? (
          <div className="tiny mute">
            当前没有正在招股 / 待申购的新股（数据来自 {Object.values(IPO_SOURCE_LABELS).join(' · ')}）。
            点击右上角「AI 打新分析」会先刷新新股信息再分析。
          </div>
        ) : ipoActionable.length === 0 ? (
          <div className="tiny mute">
            本批 {ipoAvoided.length} 只在招新股 AI 都建议放弃，因此这里不再列出（放弃的不会占用当月现金）。
            如需查看理由，请前往「新股打新」页看 AI 结论全文。
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>新股</th>
                    <th>市场</th>
                    <th className="num">发行价</th>
                    <th>申购截止</th>
                    <th className="num">中签率 / 超购</th>
                    <th className="num">胜率 / 预期收益</th>
                    <th>AI 结论</th>
                    <th>推荐理由</th>
                    <th className="num">建议申购</th>
                    <th>我的登记</th>
                    <th className="right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {ipoActionable.map((offer) => (
                    <tr key={offer.id}>
                      <td>
                        <div className="strong">{offer.name || offer.code}</div>
                        <div className="tiny mute mono">{offer.code}</div>
                      </td>
                      <td>
                        <MarketTag market={offer.market} />
                      </td>
                      <td className="num mono tiny">{priceText(offer)}</td>
                      <td className="tiny mono">{offer.subscribeEnd ? fmtDate(offer.subscribeEnd) : '未提供'}</td>
                      <td className="num tiny">
                        {offer.winningRate > 0 ? `${fmtNum(offer.winningRate, 2)}%` : '未提供'}
                        {offer.oversubscribe > 0 ? ` / ${fmtNum(offer.oversubscribe, 1)}×` : ''}
                      </td>
                      <td className="num tiny">
                        <div>{winRateText(offer)}</div>
                        <div className={expectedReturnClass(offer)}>{expectedReturnText(offer)}</div>
                      </td>
                      <td>
                        {offer.verdict ? (
                          <Badge tone={IPO_VERDICT_TONE[offer.verdict]} title={IPO_VERDICT_HINT[offer.verdict]}>
                            {verdictLabel(offer.verdict)}
                          </Badge>
                        ) : (
                          <span className="tiny mute">待分析</span>
                        )}
                      </td>
                      {/* 简明推荐理由：只说一句话（预算缺口 / 定价折价 / 破发风险），全文在详情里。 */}
                      <td className="tiny" style={{ maxWidth: 260 }} title={verdictReasonText(offer) || undefined}>
                        {verdictReasonText(offer) ? (
                          truncateText(verdictReasonText(offer), 48)
                        ) : (
                          <span className="mute">—</span>
                        )}
                      </td>
                      <td className="num mono tiny">{offer.suggestedShares > 0 ? `${fmtNum(offer.suggestedShares, 0)} 股` : '—'}</td>
                      <td className="tiny">
                        {offer.subscription
                          ? `${fmtNum(offer.subscription.appliedShares, 0)} 股${
                              offer.subscription.allottedShares > 0 ? ` · 中签 ${fmtNum(offer.subscription.allottedShares, 0)}` : ''
                            }`
                          : '未登记'}
                      </td>
                      <td>
                        <div className="row-actions">
                          <Button size="sm" onClick={() => setRegisterId(offer.id)}>
                            {offer.subscription
                              ? offer.subscription.status === 'allotted'
                                ? '修改中签'
                                : '登记中签'
                              : offer.status === 'listed'
                                ? '查看'
                                : '登记申购'}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="tiny mute mt-2">
              中签率来自上游公告（「能不能买到」）；胜率与预期收益是 AI 推算（「买到之后赚不赚」）。
              颜色为打新风险语义：绿=值得下手、红=建议放弃。
              <br />
              结论回答的是「<b>本期该不该打</b>」——已经把本月预算与一手入场费算进去，所以胜率高但预算不够时会显示
              「中性观察」并在推荐理由里写明缺口；「胜率高」和「本期打不打得起」是两件事。
              {ipoAvoided.length > 0 && `另有 ${ipoAvoided.length} 只已建议放弃，未列在此表。`}
            </div>
          </>
        )}
      </Card>

      {/* 期权卖权建议：用独立卡片而不是表格行 —— 安全垫、被行权概率、担保占用、
          数据口径这些数字塞进股票那张表只会两边都读不清。 */}
      <Card
        title={
          <span className="center gap-2">
            期权卖权建议
            {optionItems.length > 0 && <Badge tone="ai">{optionItems.length} 条</Badge>}
            {optionPending > 0 && <Badge tone="warn">待确认 {optionPending}</Badge>}
          </span>
        }
        actions={
          <Button
            loading={running}
            title="单独跑一次期权卖权分析：资产/标的 → 期权链 → 卖权建议"
            onClick={() => run({ path: '/options/analyze', title: 'AI 期权卖权建议' })}
          >
            AI 期权卖权建议
          </Button>
        }
      >
        <div className="tiny mute mb-2">
          卖期权的首要目标是<b>安全地把权利金收进来</b>，所以每张卡片都把「安不安全」摊开：行权价与现价的距离（安全垫）、
          被行权概率、年化 / 静态收益率、流动性、担保占用，以及这组数字的来源与是否延迟。
          <br />
          现金担保卖 Put <b>只在标的足够划算时才做</b>：被行权就是按行权价收股，收股数量与占用现金写在卡片上。
          点「确认」后会弹出<b>最终确认</b>弹窗（可改合约价格与合约时间）；到期自动结算的结果在「期权卖权」页跟踪。
        </div>
        {optionItems.length === 0 ? (
          <div className="tiny mute">
            本批没有期权卖权建议（期权只做港股 / 美股，A 股没有个股期权）。
            {settings.data?.option?.runWithPipeline === false
              ? '当前「设置 → 期权卖权」里关掉了「随 AI 投资建议一起跑」，所以流水线不会产出期权建议，可点右上角单独跑一次。'
              : '如果持仓与「我的标的」里都没有可卖权的标的，就不会有期权建议。'}
          </div>
        ) : (
          <div className="flex" style={{ flexDirection: 'column', gap: 10 }}>
            {optionItems.map((item) => (
              <OptionAdviceCard
                key={item.id}
                item={item}
                busyId={busyId}
                onConfirm={setOptionTarget}
                onReject={(target) => void reject(target)}
              />
            ))}
          </div>
        )}
      </Card>

      <IpoDetailDialog
        id={registerId}
        focusRegister
        onClose={() => setRegisterId(null)}
        onChanged={() => setNonce((value) => value + 1)}
      />

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

      {/* 期权建议的最终确认：可改合约价格 / 合约时间 / 张数 / 行权价，并写明被行权后果。 */}
      <ConfirmOptionAdviceDialog
        item={optionTarget}
        onClose={() => setOptionTarget(null)}
        onDone={(message) => {
          setOptionTarget(null);
          toast.success('已建立卖出合约', `${message}。到期结算在「期权卖权」页跟踪。`);
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

/* ─────────────────────── 期权卖权建议卡片（独立视觉） ─────────────────────── */

/** 卡片里的单个指标块（与 stat-card 区分：这里是同一张卡片内部的读数）。 */
function OptionMetric(props: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="panel option-metric">
      <div className="tiny mute">{props.label}</div>
      <div className={`strong mono ${props.tone ?? ''}`}>{props.value}</div>
      {props.sub && <div className="tiny mute">{props.sub}</div>}
    </div>
  );
}

/**
 * 期权建议必须独立成卡（而不是塞进股票那张表的某一行）。
 *
 * 理由：判断「这个权利金值不值得收」需要同时看到 安全垫 / 被行权概率 / 年化与静态收益 /
 * 流动性 / 担保占用 / 数据来源与延迟 —— 六个数字加两段后果说明，一行表格装不下，
 * 挤进去只会两边都读不清。
 */
export function OptionAdviceCard(props: {
  item: AdviceItem;
  busyId: string | null;
  onConfirm: (item: AdviceItem) => void;
  onReject: (item: AdviceItem) => void;
}) {
  const { item } = props;
  const plan = item.option;
  if (!plan) {
    return (
      <div className="panel option-card">
        <Alert tone="warn">
          {item.assetName || item.code} 被标记为期权建议，但合约方案字段为空（`option=null`），无法确认。请重新生成建议。
        </Alert>
      </div>
    );
  }
  const currency = plan.currency || item.currency;
  const multiplier = plan.multiplier > 0 ? plan.multiplier : 0;
  const metrics = plan.metrics;
  const collateralLabel = metrics.collateralKind === 'shares' ? '担保占用（持股）' : '担保占用（现金）';
  const collateralValue = fmtMoney(metrics.collateral, currency);

  return (
    <div className="panel option-card">
      <div className="between wrap gap-2">
        <div className="center gap-2 wrap">
          <Badge tone="ai">期权</Badge>
          <Badge tone={OPTION_STRATEGY_TONE[plan.strategy]}>{OPTION_STRATEGY_LABELS[plan.strategy]}</Badge>
          <span className="strong">{item.assetName || item.code}</span>
          <MarketTag market={item.market} />
          <span className="mono tiny mute">
            {item.code} · {plan.optionCode} · {OPTION_TYPE_LABELS[plan.optionType]}
          </span>
          <Badge tone={ORIGIN_TONE[item.origin]} title={ORIGIN_HINT[item.origin]}>
            {`来源：${ORIGIN_LABEL[item.origin]}`}
          </Badge>
        </div>
        {item.status === 'pending' ? (
          <div className="row-actions">
            <Button size="sm" variant="primary" onClick={() => props.onConfirm(item)}>
              确认
            </Button>
            <Button size="sm" variant="ghost" loading={props.busyId === item.id} onClick={() => props.onReject(item)}>
              驳回
            </Button>
          </div>
        ) : (
          <div className="right tiny mute nowrap">
            {item.status === 'confirmed' ? '已确认（已建立卖出合约）' : '已驳回'}
            {item.decidedAt && <div>{fmtDateTime(item.decidedAt)}</div>}
          </div>
        )}
      </div>

      <div className="tiny muted mt-1">{OPTION_STRATEGY_INTENT[plan.strategy]}</div>

      <div className="grid-4 mt-2">
        <OptionMetric
          label="行权价"
          value={fmtPrice(plan.strike, currency)}
          sub={`标的现价 ${fmtPrice(plan.underlyingPrice, currency)}`}
        />
        <OptionMetric label="到期日" value={fmtDate(plan.expiry)} sub={expiryCountdown(plan.expiry)} />
        <OptionMetric label="张数" value={fmtNum(plan.contracts, 0)} sub={`${fmtNum(multiplier, 0)} 股/张`} />
        <OptionMetric
          label="权利金（每股价 / 总额）"
          value={fmtPrice(plan.premium, currency)}
          sub={`合计 ${fmtMoney(metrics.premiumIncome, currency)}（已扣费用）`}
        />
        <OptionMetric
          label="年化收益率"
          value={fmtPct(metrics.annualizedYieldPct, 2, false)}
          sub={`静态 ${fmtPct(metrics.staticYieldPct, 2, false)}`}
          tone="pos"
        />
        <OptionMetric
          label="安全垫（距行权价）"
          value={fmtPct(metrics.downsideProtectionPct, 2, false)}
          sub="越低越容易被行权"
        />
        <OptionMetric
          label="被行权概率"
          value={fmtPct(metrics.assignmentProbability * 100, 1, false)}
          sub={assignmentProbabilityHint(item.market)}
        />
        <OptionMetric label={collateralLabel} value={collateralValue} sub={optionCollateralText(plan)} />
      </div>

      <div className="tiny mute mt-2">{liquidityText(metrics.liquidityScore)} · 盈亏平衡价 {fmtPrice(metrics.breakeven, currency)}</div>

      {/* 数据口径：卖权定价的基础，来源 / 时间 / 是否延迟必须逐条标注。 */}
      <div className="tiny mt-1">
        数据口径：{optionDataLine(plan)}
        {plan.delayed && <span className="warn">（延迟 / 收盘价，不能当成实时价）</span>}
      </div>

      {/* 被行权后果：卖 Call 交股 / 卖 Put 按行权价收股并占用现金，股数与现金都要写出来。 */}
      <div className="tiny warn mt-1">
        {optionAssignmentConsequence({
          optionType: plan.optionType,
          strike: plan.strike,
          multiplier,
          contracts: plan.contracts,
          currency,
          collateralNote: plan.collateralNote,
        })}
      </div>

      {plan.warnings.length > 0 && (
        <div className="mt-2">
          <Alert tone="warn">
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {plan.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </Alert>
        </div>
      )}

      <div className="mt-2">
        <div className="tiny mute mb-1">AI 理由</div>
        <Markdown text={item.reason} variant="compact" />
      </div>
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
