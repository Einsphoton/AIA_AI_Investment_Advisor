/**
 * AI 投资建议 pipeline (ARCHITECTURE.md §4.3-3).
 *
 * asset analysis → watchlist analysis → advice, sharing one Agent Loop. Advice
 * creation is budget-gated inside the `create_advice` tool; this module hands the
 * model the holdings, the refreshed watchlist and the live budget status.
 *
 * Owner: agent-engine.
 */
import { PERSONA_MAP, type AgentRun, type AgentRunKind, type AgentRunSummary } from '@aia/shared';
import { AppError } from '../errors.js';
import type { Repo } from '../types/repo.js';
import { budgetLine, computeBudgetStatus } from '../agent/budget.js';
import { compactHolding, round } from '../agent/positions.js';
import { runAssetAnalysis, runWatchlistAnalysis, safeSettings, type PipelineContext } from './analytics.js';

export interface FullPipelineOptions {
  skipAsset?: boolean;
  skipWatchlist?: boolean;
  skipAdvice?: boolean;
}

/** Runs the 建议生成 pipeline (assumes asset/watchlist analysis already done). */
export async function runAdvice(context: PipelineContext): Promise<AgentRun> {
  const { repo, agent, logger, sink } = context;
  const settings = safeSettings(repo);
  const persona = PERSONA_MAP[settings.persona];
  const budget = computeBudgetStatus(repo);
  const assets = repo.listAssets();
  const transactions = repo.listTransactions();
  const holdings = assets
    .map((asset) => compactHolding(asset, transactions.filter((tx) => tx.assetId === asset.id)))
    .filter((holding) => !holding.closed);
  const watchlist = repo.listWatchlist().map((item) => ({
    id: item.id,
    name: item.name,
    code: item.code,
    market: item.market,
    type: item.type,
    price: item.price,
    initialPrice: item.initialPrice,
    qualityScore: item.qualityScore,
    targetPrice: item.targetPrice,
    expectedReturn: item.expectedReturn,
    thesis: item.thesis,
    aiSummary: item.aiSummary,
  }));

  const exhausted = budget.markets.filter((market) => market.exhausted);
  const goal = [
    '请基于持仓、自选标的、预算与投资性格，生成本批次可执行的买卖建议。',
    `投资性格：${persona.label} — ${persona.guidance}`,
    `本月预算：${budget.markets.map((market) => budgetLine(market)).join('；')}`,
    exhausted.length > 0
      ? `注意：${exhausted.map((market) => market.market).join('、')} 当月预算已用尽，禁止对这些市场生成买入建议（create_advice 会直接拒绝）。`
      : '所有市场预算均未用尽。',
    '要求：',
    '1) 每条建议必须调用 create_advice 写入（code / market / type / action / target_shares / target_price / reason / confidence）。',
    '2) reason 必须引用具体数据（现价、估值、K 线位置、预算剩余、成本与盈亏）。',
    '3) 建议数量精炼（3-8 条），优先处理：风险敞口过大、估值偏高/偏低、预算内的高质量机会。',
    '4) 数据缺失要说明；不要给出没有数据支撑的目标价。',
    `持仓（含成本与盈亏）：${JSON.stringify(holdings)}`,
    `自选标的：${JSON.stringify(watchlist)}`,
  ].join('\n');

  const run = await agent.run({
    kind: 'advice',
    title: 'AI 投资建议',
    goal,
    target: `advice:${holdings.length}`,
    sink,
    allowWrites: ['advice'],
  });
  logger.info(`advice run ${run.id} finished (${run.status}) after ${run.turns} turns`);
  return run;
}

/** asset analysis → watchlist analysis → advice (used by `/api/agent/run-now`). */
export async function runFullPipeline(context: PipelineContext, options: FullPipelineOptions = {}): Promise<AgentRun> {
  const { skipAsset, skipWatchlist, skipAdvice } = options;
  if (skipAsset && skipWatchlist && skipAdvice) {
    throw new AppError(409, 'NOTHING_TO_RUN', '本次流水线未勾选任何步骤');
  }
  let last: AgentRun | null = null;
  if (!skipAsset) last = await runAssetAnalysis(context);
  if (!skipWatchlist) last = await runWatchlistAnalysis(context);
  if (!skipAdvice) last = await runAdvice(context);
  if (!last) throw new AppError(500, 'NO_RUN', '流水线未产生任何运行记录');
  return last;
}

/** Step flags derived from `settings.schedule` (scheduler entry point). */
export function scheduleFlags(repo: Repo): FullPipelineOptions {
  try {
    const schedule = repo.getSettings().schedule;
    return {
      skipAsset: !schedule.runAssetAnalysis,
      skipWatchlist: !schedule.runWatchlistAnalysis,
      skipAdvice: !schedule.runAdvice,
    };
  } catch {
    return { skipAsset: false, skipWatchlist: false, skipAdvice: false };
  }
}

/** Latest run summary of a kind, for `GET /api/.../last` endpoints. */
export function latestRunSummary(repo: Repo, kind?: AgentRunKind): AgentRunSummary | null {
  try {
    const runs = repo.listRuns(kind ? { kind, limit: 1 } : { limit: 1 });
    const row = runs[0];
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      title: row.title,
      summary: row.summary,
      error: row.error,
      turns: row.turns,
      stepCount: repo.listSteps(row.id).length,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
  } catch {
    return null;
  }
}

/** Convenience: portfolio exposure summary used in prompts/reports. */
export function portfolioSnapshot(repo: Repo): {
  holdings: number;
  marketValue: number;
  cost: number;
  unrealizedPnl: number;
  byMarket: Record<string, number>;
} {
  const assets = repo.listAssets();
  const transactions = repo.listTransactions();
  const byMarket: Record<string, number> = {};
  let marketValue = 0;
  let cost = 0;
  const holdings = assets
    .map((asset) => compactHolding(asset, transactions.filter((tx) => tx.assetId === asset.id)))
    .filter((holding) => !holding.closed);
  for (const holding of holdings) {
    marketValue += holding.marketValue;
    cost += holding.cost;
    byMarket[holding.market] = round((byMarket[holding.market] ?? 0) + holding.marketValue);
  }
  return {
    holdings: holdings.length,
    marketValue: round(marketValue),
    cost: round(cost),
    unrealizedPnl: round(marketValue - cost),
    byMarket,
  };
}
