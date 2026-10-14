/**
 * AI analytics pipelines — 资产分析 & 标的分析 (ARCHITECTURE.md §4.3).
 *
 * Strategy: the pipeline fetches each instrument's data in parallel (行情 / K线 /
 * 基本面 / 基金 / 分红 / 资讯 / 宏观), compacts it into a grounded brief, and hands
 * that brief to the shared Agent Loop. The model then writes conclusions back
 * through `save_asset_analysis` / `upsert_watch_item` / `save_dashboard_briefing`.
 *
 * Owner: agent-engine.
 */
import {
  DEFAULT_PERSONA,
  DEFAULT_REPORT_STYLE,
  DEFAULT_WATCHLIST_CANDIDATE_LIMIT,
  DEFAULT_WATCHLIST_RETIRE_DELETE_RUNS,
  PERSONA_MAP,
  type AgentRun,
  type BudgetStatus,
  type Persona,
  type ReportStyle,
} from '@aia/shared';
import type { AgentRuntime, EventSink, LoggerLike } from '../types/agent.js';
import type { Repo } from '../types/repo.js';
import type { AssetRow, TxRow } from '../types/models.js';
import * as ds from '../datasources/registry.js';
import { mapLimit } from '../datasources/http.js';
import { fundInfo } from '../datasources/fund.js';
import { computeBudgetStatus } from '../agent/budget.js';
import { compactHolding, computePosition, hasOpenPosition, round, sparkFrom, type CompactHolding } from '../agent/positions.js';
import { executeTool, type AllowWrite } from '../agent/tools.js';
import { readBriefing } from './briefing.js';

export interface PipelineContext {
  agent: AgentRuntime;
  repo: Repo;
  logger: LoggerLike;
  sink?: EventSink;
}

const MAX_ASSETS = 12;
const MAX_WATCH_REFRESH = 20;

export interface SafeSettings {
  persona: Persona;
  reportStyle: ReportStyle;
  watchlistCandidateLimit: number;
  /** P3 淘汰阈值：连续多少次确认退役后才真正删除（0 = 永不删除）。 */
  watchlistRetireDeleteRuns: number;
}

/** Settings read that never throws during boot/tests. */
export function safeSettings(repo: Repo): SafeSettings {
  try {
    const settings = repo.getSettings();
    return {
      persona: settings.persona,
      reportStyle: settings.reportStyle,
      watchlistCandidateLimit: settings.watchlistCandidateLimit || DEFAULT_WATCHLIST_CANDIDATE_LIMIT,
      watchlistRetireDeleteRuns:
        typeof settings.watchlistRetireDeleteRuns === 'number'
          ? settings.watchlistRetireDeleteRuns
          : DEFAULT_WATCHLIST_RETIRE_DELETE_RUNS,
    };
  } catch {
    return {
      persona: DEFAULT_PERSONA,
      reportStyle: DEFAULT_REPORT_STYLE,
      watchlistCandidateLimit: DEFAULT_WATCHLIST_CANDIDATE_LIMIT,
      watchlistRetireDeleteRuns: DEFAULT_WATCHLIST_RETIRE_DELETE_RUNS,
    };
  }
}

function safeBudget(repo: Repo): BudgetStatus {
  try {
    return computeBudgetStatus(repo);
  } catch {
    return { month: '', markets: [] };
  }
}

/* ─────────────────────────── asset analysis ─────────────────────────────── */

/** Parallel data pull for one instrument, compacted for LLM consumption. */
export async function collectInstrumentData(
  asset: Pick<AssetRow, 'code' | 'market' | 'type' | 'name'>,
  recentSeriesPoints = 20,
): Promise<{ data: Record<string, unknown>; warnings: string[] }> {
  const { code, market, type, name } = asset;
  const warnings: string[] = [];
  const [quote, series, fundamentals, dividends, news, fund] = await Promise.all([
    ds.getQuote({ code, market, type }),
    ds.getSeries({ code, market, type, range: '1y', interval: 'day' }),
    type === 'fund' ? Promise.resolve(null) : ds.getFundamentals({ code, market, type, name }),
    ds.getDividends({ code, market, type }),
    ds.getNews(`${name} ${code}`, 3),
    type === 'fund' ? fundInfo(code) : Promise.resolve(null),
  ]);

  const data: Record<string, unknown> = {};
  if (quote) {
    data.quote = quote.value;
    warnings.push(...quote.warnings);
  } else {
    warnings.push('报价不可用');
  }
  if (series && series.value.points.length > 0) {
    const points = series.value.points;
    const last = points[points.length - 1];
    const first = points[0];
    const closes = points.map((point) => point.close);
    data.series = {
      kind: series.value.kind,
      range: series.value.range,
      interval: series.value.interval,
      pointCount: points.length,
      firstDate: first?.date,
      latestDate: last?.date,
      latestClose: last?.close,
      highest: closes.length ? round(Math.max(...closes)) : 0,
      lowest: closes.length ? round(Math.min(...closes)) : 0,
      changePct: first && last && first.close > 0 ? round(((last.close - first.close) / first.close) * 100) : 0,
      recentCloses: points.slice(-recentSeriesPoints).map((point) => `${point.date}:${point.close}`),
    };
    warnings.push(...series.warnings);
  } else {
    warnings.push('K线/净值曲线不可用');
  }
  if (fundamentals) {
    data.fundamentals = {
      reportDate: fundamentals.value.reportDate,
      reportType: fundamentals.value.reportType,
      metrics: fundamentals.value.metrics.map((metric) => `${metric.label}=${metric.value}${metric.unit}`),
      highlights: fundamentals.value.highlights,
    };
    warnings.push(...fundamentals.warnings);
  }
  if (fund) {
    data.fundInfo = {
      name: fund.name,
      type: fund.type,
      manager: fund.manager,
      company: fund.company,
      scale: fund.scale,
      feeRate: fund.feeRate,
      nav: fund.nav,
      navDate: fund.navDate,
      accumNav: fund.accumNav,
      returns: fund.returns,
      allocation: fund.allocation,
      topHoldings: fund.holdings.slice(0, 10),
    };
  }
  if (dividends.value.length > 0) data.dividends = dividends.value.slice(0, 6);
  if (dividends.warnings.length > 0) warnings.push(...dividends.warnings);
  if (news.value.length > 0) {
    data.news = news.value.map((item) => ({ title: item.title, source: item.source, publishedAt: item.publishedAt }));
  }
  warnings.push(...news.warnings);

  const macro = await ds.getMacro();
  data.macro = {
    items: macro.items.map((item) => `${item.label}=${item.value}${item.unit}(${item.period})`),
    indices: macro.indices.map((index) => `${index.name}=${index.price}(${index.changePct}%)`),
  };
  if (macro.warnings.length > 0) warnings.push(...macro.warnings);

  return { data, warnings: [...new Set(warnings)] };
}

/** Runs the 资产分析 pipeline (writes `assets.ai_summary` + dashboard briefing). */
export async function runAssetAnalysis(context: PipelineContext): Promise<AgentRun> {
  const { repo, agent, logger, sink } = context;
  const assets = repo.listAssets();
  const transactions = repo.listTransactions();
  const byAsset = new Map<string, TxRow[]>();
  for (const tx of transactions) {
    const list = byAsset.get(tx.assetId) ?? [];
    list.push(tx);
    byAsset.set(tx.assetId, list);
  }

  const holdings = assets.map((asset) => compactHolding(asset, byAsset.get(asset.id) ?? []));
  const open = holdings.filter((holding) => !holding.closed);
  const pool = open.length > 0 ? open : holdings;
  const selected = pool.slice(0, MAX_ASSETS);
  const truncated = pool.length > selected.length;

  logger.info(`asset analysis: ${selected.length} 个持仓，并行抓取数据`);
  const briefs = await mapLimit(selected, 3, async (holding) => {
    const asset = assets.find((row) => row.id === holding.id)!;
    try {
      const collected = await collectInstrumentData(asset);
      return { holding, data: collected.data, warnings: collected.warnings };
    } catch (error) {
      return {
        holding,
        data: {} as Record<string, unknown>,
        warnings: [`数据抓取失败：${error instanceof Error ? error.message : String(error)}`],
      };
    }
  });

  const settings = safeSettings(repo);
  const persona = PERSONA_MAP[settings.persona];
  const budget = safeBudget(repo);
  const payload = {
    持仓数量: selected.length,
    投资性格: {
      id: persona.id,
      label: persona.label,
      guidance: persona.guidance,
      qualityGate: persona.qualityGate,
      riskLevel: persona.riskLevel,
    },
    预算: budget.markets.map((market) => ({
      market: market.market,
      币种: market.currency,
      预算: market.budget,
      已用: market.spent,
      剩余: market.remaining,
      已用尽: market.exhausted,
    })),
    持仓明细: briefs.map((brief) => ({
      标的信息: brief.holding,
      市场数据: brief.data,
      数据缺失: brief.warnings,
    })),
  };

  const goal = [
    '请对以下持仓逐项完成深度分析，并生成组合简报。',
    truncated ? `注意：持仓数量超过单次上限，本次仅提供前 ${MAX_ASSETS} 项。` : '',
    '要求：',
    '1) 对每一项调用 save_asset_analysis 写回 ai_summary（Markdown，200-400 字）：趋势与量价、估值水平（引用 PE/PB/ROE 等具体数值）、基本面对比、基金质量（场外基金看净值/阶段收益/持仓）、消息面与风险。',
    '2) 全部写回后调用 save_dashboard_briefing 写组合简报（200-500 字）：组合结构、行业集中度、风险敞口、需要关注的事件与 2-4 条可执行动作。',
    '3) 数据缺失（见「数据缺失」字段）必须在结论中明说，不得用 0 或编造数值填充；必要时调用工具补充（get_series/get_fundamentals/get_fund_info/get_news/web_search/get_macro）。',
    '以下是已抓取好的市场数据 JSON：',
    JSON.stringify(payload),
  ]
    .filter(Boolean)
    .join('\n');

  const run = await agent.run({
    kind: 'asset-analysis',
    title: 'AI 资产分析',
    goal,
    target: `assets:${selected.length}`,
    sink,
    allowWrites: ['asset', 'briefing'],
  });

  // Defensive: if the model forgot the briefing, persist the run summary instead
  // — but ONLY through the tool layer (D1): a direct `writeBriefing` here bypassed
  // `toolPolicy.deny` and the write-approval gate, so a denied/pending briefing
  // still landed in the Dashboard.
  const stored = readBriefing(repo);
  const fallbackText =
    run.status === 'done' && run.summary.trim() && (!stored || stored.runId !== run.id)
      ? run.summary
      : run.status === 'error' && !stored
        ? `简报生成失败：${run.error ?? '未知错误'}`
        : '';
  if (fallbackText) {
    const outcome = await executeTool(
      'save_dashboard_briefing',
      JSON.stringify({ text: fallbackText }),
      {
        runId: run.id,
        kind: 'asset-analysis',
        repo,
        logger,
        sink: sink ?? (() => undefined),
        allowWrites: new Set<AllowWrite>(['briefing']),
        target: run.target ?? null,
        batchId: run.id,
      },
    );
    logger.info(
      `dashboard briefing fallback via tool layer: ok=${outcome.ok} (${outcome.summary})`,
    );
  }
  logger.info(`asset analysis run ${run.id} finished (${run.status}) after ${run.turns} turns`);
  return run;
}

/* ────────────────────────── watchlist analysis ─────────────────────────── */

/** Refreshes prices/sparklines for existing watchlist items (initialPrice untouched). */
export async function refreshWatchlistPrices(context: PipelineContext): Promise<{ updated: number; failed: number }> {
  const { repo, logger } = context;
  const items = repo.listWatchlist().slice(0, MAX_WATCH_REFRESH);
  let updated = 0;
  let failed = 0;
  await mapLimit(items, 3, async (item) => {
    try {
      const [quote, series] = await Promise.all([
        ds.getQuote({ code: item.code, market: item.market, type: item.type }),
        ds.getSeries({ code: item.code, market: item.market, type: item.type, range: '6m', interval: 'day' }),
      ]);
      if (!quote) {
        failed += 1;
        return;
      }
      repo.updateWatchItem(item.id, {
        price: quote.value.price,
        priceAt: new Date().toISOString(),
        prevClose: quote.value.prevClose,
        dayChangePct: quote.value.changePct,
        spark: series ? sparkFrom(series.value.points) : item.spark,
      });
      updated += 1;
    } catch (error) {
      failed += 1;
      logger.warn(`watchlist price refresh failed for ${item.code}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { updated, failed };
}

/** Runs the 标的分析 pipeline (search → screen → deep-dive → upsert → 淘汰复核). */
export async function runWatchlistAnalysis(context: PipelineContext): Promise<AgentRun> {
  const { repo, agent, logger, sink } = context;
  const settings = safeSettings(repo);
  const persona = PERSONA_MAP[settings.persona];
  const refresh = await refreshWatchlistPrices(context);
  // 退役标的也要进 prompt：模型需要看到退役原因与已累计次数，才能决定
  // 「再次确认退役（累计到阈值后清理）」还是「复活」。
  const watchlist = repo.listWatchlist('all');
  const existing = watchlist.map((item) => ({
    id: item.id,
    name: item.name,
    code: item.code,
    market: item.market,
    type: item.type,
    source: item.source,
    price: item.price,
    initialPrice: item.initialPrice,
    changeSinceAddedPct: item.initialPrice > 0 ? round(((item.price - item.initialPrice) / item.initialPrice) * 100) : 0,
    qualityScore: item.qualityScore,
    targetPrice: item.targetPrice,
    expectedReturn: item.expectedReturn,
    thesis: item.thesis,
    aiSummary: item.aiSummary,
    note: item.note,
    status: item.status,
    retiredReason: item.retiredReason,
    retireStreak: item.retireStreak,
  }));

  const goal = [
    '请按用户投资性格挖掘新的候选标的，复核既有标的，并淘汰不再适合继续跟踪的标的。',
    `候选数量上限：${settings.watchlistCandidateLimit} 个（本次允许新增）。质量分门槛：${persona.qualityGate}。`,
    '流程：',
    '1) 用 web_search / get_news 按性格偏好检索候选（行业景气、财务特征、政策与主题）。',
    '2) 用 market_search 确认代码与市场，用 get_quote 初筛（流动性、估值、涨跌幅），明显不合格的直接淘汰。',
    '3) 对通过初筛的候选做深度分析（get_series / get_fundamentals / get_fund_info / get_dividends / get_news）。',
    `4) 对每个合格候选调用 upsert_watch_item（quality_score 0-100、target_price、expected_return、thesis、ai_summary）；quality_score 低于 ${persona.qualityGate} 的不要写入；最多新增 ${settings.watchlistCandidateLimit} 个。`,
    '5) 对既有标的中结论过时或价格显著变化的，同样调用 upsert_watch_item 更新（不要修改 initial_price）。',
    '6) 淘汰复核（P3）：逐个判断既有标的是否还值得继续跟踪。如果已经不适合（逻辑被证伪、基本面恶化、估值/趋势走坏、流动性或性价比明显落后），调用 retire_watch_item 写明原因；',
    `   已被标记 retired 的，如果仍然不适合，请再次调用 retire_watch_item 以累计次数（连续 ${settings.watchlistRetireDeleteRuns} 次后系统才会真正移除；0 表示只标记不删除）；如果重新变好，用 upsert_watch_item 更新即可自动复活。`,
    '   注意：有持仓的标的不得退役（retire_watch_item 会直接拒绝）——用户可能持续加仓，仓位处置请用 create_advice(action="sell")。',
    `既有标的（价格已刷新：成功 ${refresh.updated}、失败 ${refresh.failed}；status=active 在池 / retired 已退役）：`,
    JSON.stringify(existing),
    '分析要求：所有数字必须来自工具返回；数据缺失要写明；给出目标价与预期收益时必须说明依据与风险；退役结论必须引用具体数据，不要凭感觉。',
  ].join('\n');

  const run = await agent.run({
    kind: 'watchlist-analysis',
    title: 'AI 标的分析',
    goal,
    target: `watchlist:${watchlist.length}`,
    sink,
    allowWrites: ['watchlist'],
  });
  logger.info(`watchlist analysis run ${run.id} finished (${run.status}) after ${run.turns} turns`);

  // 模型只负责「判断」，清理由代码按规则执行（不交给模型自己删）。
  try {
    const swept = await sweepRetiredWatchItems(context, run.id);
    if (swept.removed > 0 || swept.revived > 0) {
      logger.info(
        `watchlist retire sweep after run ${run.id}: removed ${swept.removed}, revived ${swept.revived}, kept ${swept.kept.length}, deferred ${swept.deferred}`,
      );
    }
  } catch (error) {
    // 清理失败绝不能影响这次分析的结论。
    logger.warn(`watchlist retire sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return run;
}

export interface RetireSweepResult {
  /** 真正移除的标的数（经工具层，含策略/审计）。 */
  removed: number;
  /** 因重新出现持仓而自动复活的标的数。 */
  revived: number;
  /** 保留但未删除的标的及其原因（含等待次数、护栏、待审批）。 */
  kept: { id: string; code: string; reason: string }[];
  /** 因写入审批模式被挂起的删除数。 */
  deferred: number;
}

/**
 * P3 淘汰清理（确定性，不依赖模型自觉）。
 *
 * 规则（按顺序判断）：
 *   1. 又出现持仓 → **自动复活**（持仓是加仓的复盘锚点，永不被淘汰流程删除）；
 *   2. 人工录入（source=manual）→ 只保留退役标记，需用户手动清理；
 *   3. 存在待处理建议引用它 → 暂不删除，等建议处理完；
 *   4. 连续确认次数 < 阈值 → 继续等待（每分析一次累计一次）；
 *   5. 否则通过 `delete_watch_item` 工具删除 —— 走工具策略（deny / 写入审批）与审计。
 *
 * 阈值为 0 时整个清理流程关闭（只标记不删除）。
 */
export async function sweepRetiredWatchItems(
  context: PipelineContext,
  runId: string,
  options: { batchId?: string } = {},
): Promise<RetireSweepResult> {
  const { repo, logger, sink } = context;
  const result: RetireSweepResult = { removed: 0, revived: 0, kept: [], deferred: 0 };
  const threshold = safeSettings(repo).watchlistRetireDeleteRuns;
  const retired = repo.listWatchlist('retired');
  if (retired.length === 0) return result;

  for (const item of retired) {
    // ① 持仓护栏（最高优先级）：买入过的标的自动回到在池状态。
    if (hasOpenPosition(repo, item)) {
      repo.updateWatchItem(item.id, { status: 'active', retiredReason: '', retiredAt: null, retireStreak: 0 });
      result.revived += 1;
      logger.info(`watchlist item ${item.code} revived: user holds an open position`);
      continue;
    }
    // ② 人工录入的标的一律不自动删除。
    if (item.source === 'manual') {
      result.kept.push({ id: item.id, code: item.code, reason: 'manual' });
      continue;
    }
    // ③ 还有待处理建议引用它 → 等用户先处理建议。
    const pending = repo
      .listAdvice({ status: 'pending' })
      .some((advice) => advice.watchItemId === item.id);
    if (pending) {
      result.kept.push({ id: item.id, code: item.code, reason: 'pending-advice' });
      continue;
    }
    // ④ 还没连续确认够次数（0 = 只标记不删除）。
    if (threshold <= 0 || item.retireStreak < threshold) {
      result.kept.push({ id: item.id, code: item.code, reason: 'below-threshold' });
      continue;
    }
    // ⑤ 通过工具层删除：策略拒绝 / 写入审批都会在这里被尊重。
    const outcome = await executeTool('delete_watch_item', JSON.stringify({ id: item.id }), {
      runId,
      kind: 'watchlist-analysis',
      repo,
      logger,
      sink: sink ?? (() => undefined),
      allowWrites: new Set<AllowWrite>(['watchlist']),
      target: null,
      batchId: options.batchId ?? runId,
    });
    if (outcome.ok) {
      result.removed += 1;
      logger.info(`watchlist item ${item.code} removed after ${item.retireStreak} confirmed retirements`);
    } else {
      result.deferred += 1;
      result.kept.push({ id: item.id, code: item.code, reason: outcome.summary || 'delete-rejected' });
      logger.warn(`watchlist item ${item.code} not removed: ${outcome.summary}`);
    }
  }
  // 上面 updateWatchItem 只写库；页面靠 entity 事件与运行结束时的刷新拿到结果。
  return result;
}

export { computePosition };
