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
import { runAssetAnalysis, runIpoAnalysis, runWatchlistAnalysis, safeSettings, trimForPrompt, type PipelineContext } from './analytics.js';
import { listIpoPayload } from './ipo.js';

export interface FullPipelineOptions {
  skipAsset?: boolean;
  skipWatchlist?: boolean;
  /** 打新分析（新股发行信息刷新 + 是否申购结论）。 */
  skipIpo?: boolean;
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
    expectedReturnHorizon: item.expectedReturnHorizon,
    thesis: item.thesis,
    // The full previous conclusion is re-sent on every turn; only its leading
    // judgement matters for advice generation, and 200+ characters of prose per
    // item dominated this goal (see `trimForPrompt` in ./analytics.js).
    aiSummary: trimForPrompt(item.aiSummary, 240),
  }));

  const exhausted = budget.markets.filter((market) => market.exhausted);
  // 打新结论（是否申购/建议股数）会占用当月同一市场的预算，因此必须让建议生成看到：
  // 打了新就意味着当月可用现金变少，两者不能各算各的。
  const ipo = listIpoPayload(repo, { limit: 20 }).items
    .filter((item) => item.status !== 'listed' || item.subscription)
    .map((item) => ({
      code: item.code,
      name: item.name,
      market: item.market,
      status: item.status,
      申购截止: item.subscribeEnd,
      上市日: item.listingDate,
      发行价: item.issuePrice || item.priceLow,
      建议申购股数: item.suggestedShares,
      打新结论: item.verdict,
      一句话理由: item.verdictReason || null,
      // 胜率（上市后正收益概率，0-1）与预期收益（%）：判断「这笔打新值不值得占用当月现金」的依据。
      胜率: item.winProbability || null,
      预期收益: item.verdict ? item.expectedReturn : null,
      我的登记: item.subscription
        ? { 申购股数: item.subscription.appliedShares, 中签股数: item.subscription.allottedShares, 状态: item.subscription.status }
        : null,
    }));
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
    '4.1) 交易单位与额度（系统会机械校验，报错请按提示改正）：A 股/场内基金买入必须是 100 股（份）的整数倍，科创板最小 200 股；卖出可清掉零股；美股 1 股起。',
    '     单笔买入金额 targetShares × targetPrice 不得超过当月该市场预算剩余，请先按剩余额度反推可买数量再落建议。',
    // 来源纪律：让建议可追溯，并让「跳过候选池」这件事在界面与理由里都可见。
    '5) 来源纪律：卖出建议必须来自已持仓；买入建议优先来自「我的标的」（已过质量分门槛的候选池）或已持仓的加仓。',
    '   —— 建议针对持仓时把资产 id 填进 assetId，针对「我的标的」时填 watchItemId；系统也会按代码自动回填。',
    '   —— 如果确实要买入「我的标的」之外的标的，这是允许的，但必须在 reason 开头写明「池外标的」并解释为什么它比池内候选更值得买（该建议会被标记为「池外」，等于跳过了候选池筛选）。',
    '6) 【打新与预算联动】下表是本次打新分析给出的结论与用户的申购/中签登记。打新缴款会占用同一市场的当月资金，制定买入建议时必须把它算进去（例如港股中签已占用资金、A股中签待缴款），避免建议金额超出真实可用现金；如某只新股的打新结论为 subscribe 且申购截止临近，请在 reason 里提示该资金占用。',
    '6.1) 打新结论里的「胜率」（0-1，上市后正收益概率）与「预期收益」（%，可为负）是取舍依据：高胜率高预期收益的打新可以优先占用当月现金；胜率低或预期收益为负的（`verdict=avoid`）不值得占用额度。注意「中签率」与「胜率」不是一回事，不要混用。',
    `打新情况（无记录表示当前没有可打新标的或尚未分析）：${JSON.stringify(ipo)}`,
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
  const { skipAsset, skipWatchlist, skipIpo, skipAdvice } = options;
  if (skipAsset && skipWatchlist && skipIpo && skipAdvice) {
    throw new AppError(409, 'NOTHING_TO_RUN', '本次流水线未勾选任何步骤');
  }
  let last: AgentRun | null = null;
  if (!skipAsset) last = await runAssetAnalysis(context);
  if (!skipWatchlist) last = await runWatchlistAnalysis(context);
  // 打新分析排在建议之前：新股的「是否申购」结论会影响当月的资金安排。
  if (!skipIpo) last = await runIpoAnalysis(context);
  if (!skipAdvice) last = await runAdvice(context);
  if (!last) throw new AppError(500, 'NO_RUN', '流水线未产生任何运行记录');
  return last;
}

/**
 * 流水线步骤开关由调用方给出：定时入口（`services/scheduler.ts`）按**到期任务的并集**
 * 计算（`mergeTaskFlags`），手工入口不传 = 四步全跑。
 */

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
