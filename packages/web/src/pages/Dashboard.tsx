/**
 * DashboardPage — 仪表盘。owner: web-core-pages
 *
 * 四个板块：持仓统计 / 计数与信号 / 持仓排名前五 / AI 持仓简报，
 * 外加全球指数、月度预算与快捷入口。
 * 指数单独走 /api/market/indices，失败静默降级（回退 DashboardPayload.indices）。
 * 工具栏「AI一键分析」走 POST /api/agent/run-now：在同一条 SSE 流里顺序跑
 * 资产分析 → 标的分析 → AI 投资建议（因此流内有多组 run-started/run-finished）。
 * 推理过程由全局右下角面板（AgentActivityDock）展示，不再占用页面空间。
 */
import { Link } from 'react-router-dom';
import type { DashboardPayload, Quote } from '@aia/shared';
import { MARKET_LABELS, REPORT_STYLE_MAP, PERSONA_MAP } from '@aia/shared';
import { api } from '../api/client';
import { useAgentActivity, useAgentRefresh } from '../api/agentActivity';
import { useAsync } from '../api/hooks';
import { fmtDateTime, fmtMoney, fmtNum, fmtPct, fmtPrice, fmtRelative, fmtShares, fmtSignedMoney, pnlClass } from '../format';
import { Alert, Badge, Button, Card, Empty, ErrorAlert, Loading, ProgressBar, StatCard } from '../components/ui';
import { Sparkline } from '../components/charts/Sparkline';

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
            <Badge tone="ok">定时任务已开启{signals.nextRunAt ? ` · 下次 ${fmtDateTime(signals.nextRunAt)}` : ''}</Badge>
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

          {/* ③ 持仓排名前五 */}
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
                        <td className="nowrap">{MARKET_LABELS[asset.market]}</td>
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

          {/* ④ AI 持仓简报 */}
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
                <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
                  {payload.briefing.text}
                </div>
                <div className="tiny mute mt-3">
                  {fmtRelative(payload.briefing.generatedAt)}
                  {payload.briefing.runId ? ` · run ${payload.briefing.runId.slice(0, 8)}` : ''}
                </div>
              </>
            ) : (
              <Empty title="尚未生成，点击右侧按钮运行 AI 资产分析" hint="Agent 会逐项分析每只持仓，并把结论汇总成这份简报" />
            )}
          </Card>

          {/* 额外上下文：指数 + 预算 */}
          <div className="grid-2 mb-3">
            <Card title="全球指数概览" actions={<span className="tiny mute">{liveIndices.loading ? '刷新中…' : `${indices.length} 个指数`}</span>}>
              {indices.length === 0 ? (
                <div className="mute small">指数数据源暂不可用（不影响其它板块，稍后可重试）。</div>
              ) : (
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

            <Card title={`月度预算使用（${payload.budget.month}）`} actions={<Link className="tiny" to="/settings">调整预算</Link>}>
              <div className="flex" style={{ flexDirection: 'column', gap: 12 }}>
                {payload.budget.markets.map((item) => (
                  <div key={item.market}>
                    <div className="between mb-1">
                      <span className="small">
                        {MARKET_LABELS[item.market]}{' '}
                        <span className="mute tiny">
                          {fmtMoney(item.spent, item.currency)} / {fmtMoney(item.budget, item.currency)}
                        </span>
                      </span>
                      <span className="center gap-2">
                        {item.exhausted ? (
                          <Badge tone="warn">预算已用尽</Badge>
                        ) : (
                          <span className="tiny mute">剩余 {fmtMoney(item.remaining, item.currency)}</span>
                        )}
                        <span className="tiny mono">{fmtPct(item.usedPct, 1, false)}</span>
                      </span>
                    </div>
                    <ProgressBar value={item.usedPct} max={100} />
                  </div>
                ))}
              </div>
              <div className="tiny mute mt-3">按自然月统计各市场买入成交额（按币种分别计算）。</div>
            </Card>
          </div>

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
