/**
 * DashboardPage — 仪表盘。owner: web-core-pages
 *
 * 板块顺序：持仓统计 → 计数与信号 → 全球指数概览 → 持仓排名前五 →
 * AI 持仓简报 → 月度预算 → 快捷入口。
 *
 * 布局约定（配合 styles.css §20）：
 *   · 主内容区不再限制宽度，列表（表格）直接铺满整行；
 *   · 区块（统计卡 / 指数 / 预算）统一用 auto-fit 栅格，列数随屏幕宽度动态平铺；
 *   · AI 简报走 <Markdown> 渲染（指标条 + 语义数字 + 表格内联柱），超宽屏自动分栏。
 *
 * 指数单独走 /api/market/indices，失败静默降级（回退 DashboardPayload.indices）。
 * 工具栏「AI一键分析」走 POST /api/agent/run-now：在同一条 SSE 流里顺序跑
 * 资产分析 → 标的分析 → AI 投资建议（因此流内有多组 run-started/run-finished）。
 * 推理过程由全局右下角面板（AgentActivityDock）展示，不再占用页面空间。
 */
import { Link } from 'react-router-dom';
import type { DashboardPayload, PortfolioPerformance, Quote } from '@aia/shared';
import { MARKET_LABELS, REPORT_STYLE_MAP, PERSONA_MAP } from '@aia/shared';
import { api } from '../api/client';
import { useAgentActivity, useAgentRefresh } from '../api/agentActivity';
import { useAsync } from '../api/hooks';
import { fmtDateTime, fmtMoney, fmtNum, fmtPct, fmtPrice, fmtRelative, fmtShares, fmtSignedMoney, pnlClass } from '../format';
import { Alert, Badge, Button, Card, Empty, ErrorAlert, Loading, MarketTag, ProgressBar, StatCard } from '../components/ui';
import { InterruptedRunsAlert } from '../components/InterruptedRunsAlert';
import { Sparkline } from '../components/charts/Sparkline';
import { Markdown } from '../components/markdown/Markdown';

/* ───────────────────────── 年化收益（第一行） ───────────────────────── */

/** 年化收益率不显示正负号时也要着色；null（不可度量）保持中性。 */
function returnTone(value: number | null | undefined): 'default' | 'pos' | 'neg' {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return 'default';
  return value > 0 ? 'pos' : 'neg';
}

/** 年化口径说明：数值怎么来的、期初期末是多少、为什么不可度量 —— 悬浮可查。 */
function performanceHint(perf: PortfolioPerformance, kind: 'portfolio' | 'realized', currency: string): string {
  const lines: string[] = [];
  if (kind === 'portfolio') {
    lines.push(`区间：${perf.periodStart} → ${perf.periodEnd}（${perf.days} 天）。`);
    lines.push(`期初持仓市值：${perf.openingValue === null ? '不可得' : fmtMoney(perf.openingValue, currency)}（按 ${perf.periodStart} 收盘价折算）。`);
    lines.push(`期末持仓市值：${fmtMoney(perf.endingValue, currency)}；当年净投入：${fmtSignedMoney(perf.netInvested, currency)}。`);
    lines.push(
      `全周期年化（${perf.sinceInceptionFrom ?? '尚无买入'} 起）：${
        perf.sinceInceptionPct === null ? '不可度量' : fmtPct(perf.sinceInceptionPct)
      }。`,
    );
  } else {
    lines.push(`口径：只统计 ${perf.year} 年卖出掉的那部分份额。`);
    lines.push('账面法（移动加权平均）没有批次，成本因此锚定在这些份额的加权平均买入日。');
    lines.push(
      `当年已实现盈亏（账本口径，不含费用）：${fmtSignedMoney(perf.realizedPnl, currency)}；年化结果含交易费用。`,
    );
  }
  lines.push(...perf.notes);
  return lines.join('\n');
}

export function DashboardPage() {
  const state = useAsync<DashboardPayload>(() => api.dashboard(), []);
  // 指数失败不允许影响整页：catch 成空数组，页面回退到 dashboard payload 里的快照。
  const liveIndices = useAsync<Quote[]>(() => api.market.indices().catch(() => []), []);

  // AI 一键分析 = 完整流水线（资产分析 → 标的分析 → 建议生成）；流由全局 Provider 持有，
  // 切换页面不会中断，推理过程显示在右下角面板里。
  const { run, running } = useAgentActivity();
  useAgentRefresh(state.reload);

  const payload = state.data;
  const portfolio = payload?.portfolio;
  const counts = payload?.counts;
  const signals = payload?.signals;
  // 旧服务端可能没有 performance 字段（滚动升级 / 缓存旧包）：缺了就不渲染这两个计数，
  // 而不是让整页崩掉。左上角版本徽标会把「前后端版本不一致」直接标出来。
  const perf = portfolio?.performance;
  const indices = liveIndices.data && liveIndices.data.length > 0 ? liveIndices.data : payload?.indices ?? [];
  const fxLines = portfolio
    ? Object.entries(portfolio.fxRates ?? {})
        .filter(([code]) => code.toUpperCase() !== portfolio.currency.toUpperCase())
        .map(([code, rate]) => `1 ${code} ≈ ${fmtNum(rate, 4)} ${portfolio.currency}`)
    : [];

  return (
    <>
      <div className="flex between wrap gap-2 mb-3">
        <div className="flex wrap center gap-2 tiny mute">
          <span>数据更新于 {fmtDateTime(payload?.updatedAt)}</span>
          {signals?.priceStale && <Badge tone="warn">行情可能过期，建议刷新</Badge>}
          {signals?.scheduleEnabled && (
            <Badge tone="ok">
              定时任务已开启（{signals.nextRuns?.length ?? 0} 个）
              {signals.nextRunAt ? ` · 下次 ${fmtDateTime(signals.nextRunAt)}` : ''}
            </Badge>
          )}
          {payload?.briefing && (
            <Badge tone="ai">
              {PERSONA_MAP[payload.briefing.persona]?.label ?? payload.briefing.persona} ·{' '}
              {REPORT_STYLE_MAP[payload.briefing.reportStyle]?.label ?? payload.briefing.reportStyle}
            </Badge>
          )}
        </div>
        <div className="toolbar">
          <Button onClick={state.reload} loading={state.loading && !!payload}>
            刷新
          </Button>
          <Button
            variant="primary"
            loading={running}
            onClick={() => {
              // 完整流水线：资产分析 → 标的分析 → AI 投资建议（同一条 SSE 流）。
              run({ path: '/agent/run-now', title: 'AI 一键分析' });
            }}
          >
            AI一键分析
          </Button>
        </div>
      </div>

      {state.error && <ErrorAlert error={state.error} onRetry={state.reload} />}
      {state.error?.isNotConfigured && (
        <Alert tone="warn">
          尚未配置 LLM API Key，AI 分析不可用，请到 <Link to="/settings">设置页</Link> 填写 API Key。
        </Alert>
      )}

      {/* 未跑完的 AI 运行：服务进程重启 / 上游超时都会留下 error 状态的 run，
          轨迹已落库，可以一键续跑而不是从头再点一次。 */}
      <InterruptedRunsAlert />

      {state.loading && !payload && <Loading label="正在汇总持仓…" />}

      {payload && portfolio && counts && (
        <>
          {/* ① 持仓统计 */}
          <Card
            title="持仓统计"
            actions={
              <span className="tiny mute">
                统一折算为 {portfolio.currency}
                {fxLines.length > 0 ? ` · ${fxLines.join(' · ')}` : ''}
              </span>
            }
            className="card-hero mb-3"
          >
            <div className="stat-grid">
              <StatCard
                label="当前持仓总市值"
                value={fmtMoney(portfolio.marketValue, portfolio.currency)}
                sub={
                  <span className={pnlClass(portfolio.dayChange)}>
                    当日 {fmtSignedMoney(portfolio.dayChange, portfolio.currency)}（{fmtPct(portfolio.dayChangePct)}）
                  </span>
                }
              />
              <StatCard label="当前持仓总成本" value={fmtMoney(portfolio.cost, portfolio.currency)} sub="按移动加权平均成本法" />
              <StatCard
                label="浮动盈亏"
                value={fmtSignedMoney(portfolio.unrealizedPnl, portfolio.currency)}
                tone={portfolio.unrealizedPnl > 0 ? 'pos' : portfolio.unrealizedPnl < 0 ? 'neg' : 'default'}
                sub={fmtPct(portfolio.unrealizedPnlPct)}
              />
              <StatCard
                label="已实现盈亏"
                value={fmtSignedMoney(portfolio.realizedPnl, portfolio.currency)}
                tone={portfolio.realizedPnl > 0 ? 'pos' : portfolio.realizedPnl < 0 ? 'neg' : 'default'}
                sub="卖出部分累计落袋"
              />
              {/* 年化收益率 / 已实现年化收益率：XIRR（资金加权，含费用），
                  口径与降级原因在悬浮说明里逐条写明 —— 不可度量时显示 — 而不是 0。 */}
              {perf && (
                <>
                  <StatCard
                    label="年化收益率"
                    value={fmtPct(perf.annualizedPct)}
                    tone={returnTone(perf.annualizedPct)}
                    sub={`${perf.year} 年至今 · ${perf.days} 天 · XIRR`}
                    hint={performanceHint(perf, 'portfolio', portfolio.currency)}
                  />
                  <StatCard
                    label="已实现年化收益率"
                    value={fmtPct(perf.realizedAnnualizedPct)}
                    tone={returnTone(perf.realizedAnnualizedPct)}
                    sub={
                      perf.realizedAnnualizedPct === null
                        ? '当年没有卖出记录'
                        : `当年卖出落袋 ${fmtSignedMoney(perf.realizedPnl, portfolio.currency)}`
                    }
                    hint={performanceHint(perf, 'realized', portfolio.currency)}
                  />
                </>
              )}
            </div>
          </Card>

          {/* ② 计数与信号 */}
          <Card title="计数与信号" className="mb-3">
            <div className="stat-grid">
              <StatCard label="当前持有标的" value={counts.holdings} sub="份额大于 0 的持仓" />
              <StatCard label="当前购买资产" value={counts.instruments} sub="已录入的资产总数（含已清仓）" />
              <StatCard
                label={
                  <span className="center gap-2">
                    我的标的
                    {counts.newWatchItems > 0 && <Badge tone="warn">新增 {counts.newWatchItems}</Badge>}
                  </span>
                }
                value={counts.watchItems}
                sub={
                  counts.retiredWatchItems > 0
                    ? `在池标的 · ${counts.retiredWatchItems} 个已退役（AI 判定不再适合）`
                    : `AI 已运行 ${counts.analysisRuns} 次 · 最近 ${fmtRelative(counts.lastRunAt)}`
                }
              />
              <StatCard
                label={
                  <span className="center gap-2">
                    AI 投资建议
                    {counts.newAdvice > 0 && <Badge tone="warn">新增 {counts.newAdvice}</Badge>}
                  </span>
                }
                value={counts.pendingAdvice}
                sub={`待处理建议 · 本次新增 ${counts.newAdvice}`}
              />
            </div>
            <div className="flex wrap gap-2 mt-3">
              <Badge tone={signals?.watchlistChanged ? 'warn' : 'ok'}>
                {signals?.watchlistChanged ? '投资标的有新变化' : '投资标的无变化'}
              </Badge>
              <Badge tone={signals?.adviceChanged ? 'warn' : 'ok'}>
                {signals?.adviceChanged ? '有新的 AI 投资建议' : '暂无新的 AI 投资建议'}
              </Badge>
              <Badge tone={signals?.priceStale ? 'warn' : 'ok'}>{signals?.priceStale ? '行情待刷新' : '行情已更新'}</Badge>
            </div>
          </Card>

          {/* ③ 全球指数概览 —— 紧跟「计数与信号」，同属市场信号类信息 */}
          <Card
            title="全球指数概览"
            actions={<span className="tiny mute">{liveIndices.loading ? '刷新中…' : `${indices.length} 个指数`}</span>}
            className="mb-3"
          >
            {indices.length === 0 ? (
              <div className="mute small">指数数据源暂不可用（不影响其它板块，稍后可重试）。</div>
            ) : (
              // 动态平铺：列数随可用宽度自动增减，超宽屏不会只铺一列。
              <div className="grid-3">
                {indices.map((quote) => (
                  <div className="panel" key={`${quote.market}-${quote.code}`}>
                    <div className="tiny mute truncate" title={quote.name || quote.code}>
                      {quote.name || quote.code}
                    </div>
                    <div className="strong" style={{ marginTop: 2 }}>
                      {fmtPrice(quote.price, quote.currency)}
                    </div>
                    <div className={`tiny ${pnlClass(quote.changePct)}`}>
                      {fmtSignedMoney(quote.change, quote.currency)} ({fmtPct(quote.changePct)})
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* ④ 持仓排名前五 —— 列表类：铺满整行 */}
          <Card
            title="持仓排名前五"
            actions={
              <Link className="btn btn-sm btn-ghost" to="/assets">
                查看全部资产
              </Link>
            }
            className="mb-3"
            padded={false}
          >
            {payload.topHoldings.length === 0 ? (
              <Empty
                title="还没有可排名的持仓"
                hint="先在「我的资产」录入持仓，Dashboard 会自动汇总"
                action={
                  <Link className="btn btn-sm btn-primary" to="/assets">
                    去添加资产
                  </Link>
                }
              />
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>资产名称</th>
                      <th>代码</th>
                      <th>市场</th>
                      <th className="num">份额</th>
                      <th className="num">成本单价</th>
                      <th className="num">现价</th>
                      <th className="num">市值</th>
                      <th className="num">浮动盈亏</th>
                      <th>走势</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payload.topHoldings.map((asset) => (
                      <tr key={asset.id}>
                        <td>
                          <div className="strong truncate" style={{ maxWidth: 200 }} title={asset.name}>
                            {asset.name}
                          </div>
                        </td>
                        <td className="mono tiny">{asset.code}</td>
                        <td className="nowrap">
                          <MarketTag market={asset.market} />
                        </td>
                        <td className="num">{fmtShares(asset.shares)}</td>
                        <td className="num">{fmtPrice(asset.avgCost, asset.currency)}</td>
                        <td className="num">{fmtPrice(asset.price, asset.currency)}</td>
                        <td className="num">{fmtMoney(asset.marketValue, asset.currency)}</td>
                        <td className="num">
                          <div className={pnlClass(asset.unrealizedPnl)}>{fmtSignedMoney(asset.unrealizedPnl, asset.currency)}</div>
                          <div className={`tiny ${pnlClass(asset.unrealizedPnlPct)}`}>{fmtPct(asset.unrealizedPnlPct)}</div>
                        </td>
                        <td>
                          <Sparkline values={asset.spark} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* ⑤ AI 持仓简报 —— Markdown 渲染 */}
          <Card
            title={
              <span className="center gap-2">
                AI 持仓分析简报
                {payload.briefing && <Badge tone="ai">生成于 {fmtDateTime(payload.briefing.generatedAt)}</Badge>}
              </span>
            }
            actions={
              <Button
                size="sm"
                variant="primary"
                loading={running}
                onClick={() => {
                  run({ path: '/assets/analyze', title: 'AI 资产分析' });
                }}
              >
                运行 AI 资产分析
              </Button>
            }
            className="mb-3"
          >
            {payload.briefing ? (
              <>
                {/* 标题分层 + 关键指标条 + 语义数字 + 表格内联柱；超宽屏自动分两栏，
                    避免正文被拉成一条两百字的超长行。 */}
                <Markdown text={payload.briefing.text} columns />
                <div className="tiny mute mt-3">
                  {fmtRelative(payload.briefing.generatedAt)}
                  {payload.briefing.runId ? ` · run ${payload.briefing.runId.slice(0, 8)}` : ''}
                </div>
              </>
            ) : (
              <Empty title="尚未生成，点击右侧按钮运行 AI 资产分析" hint="Agent 会逐项分析每只持仓，并把结论汇总成这份简报" />
            )}
          </Card>

          {/* ⑥ 月度预算使用 —— 单独铺满整行，各市场按宽度动态平铺 */}
          <Card
            title={`月度预算使用（${payload.budget.month}）`}
            actions={
              <Link className="tiny" to="/settings">
                调整预算
              </Link>
            }
            className="mb-3"
          >
            <div className="grid-3">
              {payload.budget.markets.map((item) => (
                <div className="panel" key={item.market}>
                  <div className="between mb-1">
                    <MarketTag market={item.market} />
                    <span className="center gap-2">
                      {item.exhausted ? (
                        <Badge tone="warn">预算已用尽</Badge>
                      ) : (
                        <span className="tiny mute">剩余 {fmtMoney(item.remaining, item.currency)}</span>
                      )}
                      <span className="tiny mono">{fmtPct(item.usedPct, 1, false)}</span>
                    </span>
                  </div>
                  <div className="tiny mute mb-1">
                    {fmtMoney(item.spent, item.currency)} / {fmtMoney(item.budget, item.currency)}
                  </div>
                  <ProgressBar value={item.usedPct} max={100} />
                </div>
              ))}
            </div>
            <div className="tiny mute mt-3">按自然月统计各市场买入成交额（按币种分别计算）。</div>
          </Card>

          <Card title="快捷入口">
            <div className="flex wrap gap-2">
              <Link className="btn btn-ghost" to="/assets">
                我的资产（{counts.instruments}）
              </Link>
              <Link className="btn btn-ghost" to="/watchlist">
                我的标的（{counts.watchItems}）
              </Link>
              <Link className="btn btn-ghost" to="/advice">
                AI 投资建议（{counts.pendingAdvice} 待处理）
              </Link>
              <Link className="btn btn-ghost" to="/chat">
                和 AI 聊聊持仓
              </Link>
              <Link className="btn btn-ghost" to="/settings">
                设置 · API Key / 预算
              </Link>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
