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
  INSTRUMENT_TYPES,
  INSTRUMENT_TYPE_LABELS,
  MARKETS,
  MARKET_LABELS,
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
import { compactFinancials } from '../datasources/financials.js';
import { mapLimit } from '../datasources/http.js';
import { fundInfo } from '../datasources/fund.js';
import { computeBudgetStatus } from '../agent/budget.js';
import { estimateTokens } from '../agent/context.js';
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
/** 资产分析预取的财报期数（新 → 旧）：4 期足够看趋势，同时控制提示词 token。 */
const FINANCIAL_PERIODS = 4;
/**
 * Hard ceiling for the pre-fetched payload handed to the model as one user
 * message, measured in **estimated tokens** (the same estimator the context
 * budget uses — a character cap would be misleading, since CJK costs ≈1 token per
 * character while JSON numbers cost ≈1/4).
 *
 * The payload is the *first* user message and is exempt from compaction by design
 * (see `agent/context.ts`): if it alone exceeds `llm.contextTokens` minus the
 * output reserve, every subsequent request is over budget and no compaction can
 * help — the model then sees a prompt it cannot fit and the run degrades. With 12
 * holdings × (K线 + 三表 + 分红 + 资讯) the payload used to reach ≈120k tokens
 * against a 48k window. 24k leaves room for the system prompt (~2.3k), the tool
 * schemas (~2.2k) and the tool results the model still needs.
 */
const MAX_GOAL_PAYLOAD_TOKENS = 24_000;

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
  const [quote, series, fundamentals, financials, dividends, news, fund] = await Promise.all([
    ds.getQuote({ code, market, type }),
    ds.getSeries({ code, market, type, range: '1y', interval: 'day' }),
    type === 'fund' ? Promise.resolve(null) : ds.getFundamentals({ code, market, type, name }),
    // 财报三表（多期）：ETF/基金没有财报，registry 直接返回 null。
    type === 'fund' ? Promise.resolve(null) : ds.getFinancials({ code, market, type, name, periods: FINANCIAL_PERIODS }),
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
  if (financials) {
    data.financials = compactFinancials(financials.value, FINANCIAL_PERIODS);
    warnings.push(...financials.warnings);
  } else if (type !== 'fund') {
    warnings.push('财报三表不可用（上游未返回该标的的财务报表）');
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

  return { data, warnings: [...new Set(warnings)] };
}

/**
 * Macro snapshot, fetched **once** per pipeline run.
 *
 * It used to be pulled inside `collectInstrumentData`, i.e. once per holding —
 * the same 13 indicators landed in the prompt N times (pure token waste on top of
 * N redundant upstream calls, cached or not). The holding's industry context does
 * not depend on the instrument, so it belongs at the top of the payload.
 */
export async function collectMacro(): Promise<Record<string, unknown>> {
  const macro = await ds.getMacro();
  return {
    items: macro.items.map((item) => `${item.label}=${item.value}${item.unit}(${item.period})`),
    indices: macro.indices.map((index) => `${index.name}=${index.price}(${index.changePct}%)`),
    warnings: macro.warnings,
  };
}

/** Serializes the pre-fetched payload, dropping trailing holdings if it is too big. */
function fitGoalPayload(payload: {
  持仓数量: number;
  投资性格: Record<string, unknown>;
  预算: unknown;
  宏观: unknown;
  持仓明细: Array<{ 标的信息: unknown; 市场数据: Record<string, unknown>; 数据缺失: string[] }>;
}): { json: string; droppedHoldings: number } {
  let details = payload.持仓明细;
  let json = JSON.stringify({ ...payload, 持仓明细: details });
  let droppedHoldings = 0;
  // Drop from the tail (the model is told, so nothing is silently lost). Each
  // single holding is independently bounded by `collectInstrumentData`
  // (20 K-line points / 3 news / 10 fund holdings / 4 statement periods), so the
  // loop always terminates with a payload that fits.
  while (estimateTokens(json) > MAX_GOAL_PAYLOAD_TOKENS && details.length > 1) {
    details = details.slice(0, details.length - 1);
    droppedHoldings += 1;
    json = JSON.stringify({ ...payload, 持仓数量: details.length, 持仓明细: details });
  }
  return { json, droppedHoldings };
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
  // Macro starts in parallel with the per-holding pulls, but is only fetched when
  // there is something to analyse: an empty portfolio must not make the pipeline
  // depend on the macro upstream being reachable (that also kept this path
  // network-free for the hermetic pipeline tests).
  const macroPromise = selected.length > 0
    ? collectMacro().catch(() => ({ items: [], indices: [], warnings: ['宏观数据不可用'] }))
    : null;
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
  const macro = macroPromise ? await macroPromise : { items: [], indices: [], warnings: [] as string[] };

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
    宏观: macro,
    持仓明细: briefs.map((brief) => ({
      标的信息: brief.holding,
      市场数据: brief.data,
      数据缺失: brief.warnings,
    })),
  };
  const { json: payloadJson, droppedHoldings } = fitGoalPayload(payload);

  const goal = [
    '请对以下持仓逐项完成深度分析，并生成组合简报。',
    truncated ? `注意：持仓数量超过单次上限，本次仅提供前 ${MAX_ASSETS} 项。` : '',
    droppedHoldings > 0
      ? `注意：为控制上下文体积，已再省略最后 ${droppedHoldings} 项持仓的数据；如需分析请缩小持仓范围后另行发起分析。`
      : '',
    '要求：',
    '1) 对每一项调用 save_asset_analysis 写回 ai_summary（Markdown，200-400 字）：趋势与量价、估值水平（引用 PE/PB/ROE 等具体数值）、**财报分析（营收与归母净利同比、毛利率/ROE 的跨期变化、经营现金流与净利润是否匹配、资产负债率与商誉/应收排雷，必须引用 financials 里的多期数字）**、基金质量（场外基金看净值/阶段收益/持仓）、消息面与风险。',
    '2) 全部写回后调用 save_dashboard_briefing 写组合简报（200-500 字）：组合结构、行业集中度、风险敞口、需要关注的事件与 2-4 条可执行动作。',
    '3) 两份文本都按 Markdown 结构书写：`## 小标题` 分段、关键数字加粗、可对比的数据用表格；需要突出关键指标或数值分布时使用 metrics / chart 代码块（语法见系统提示的输出格式章节）。',
    '4) **不要重复调工具抓已经给你的数据**：「市场数据」就是行情/K线/估值/财报/基金/分红/资讯工具的**真实返回结果**，「宏观」也已抓取，直接引用即可。只有下列情况才调用工具：(a) 需要更长财报期数（get_financials periods 最多 8）；(b) 需要补充分红、资讯或联网核对（get_news / web_search）；(c) 某个字段确实缺失且换个来源能补上。反复调用同一个已失败的只读工具会浪费轮次与 Token。',
    '5) 数据缺失（见「数据缺失」字段）必须在结论中明说，不得用 0 或编造数值填充；每个缺失项只需说明一次，不要为了「补上」而反复重试同一个数据源。',
    '6) 财报核对：market 数据里的 financials 已预取 4 期三表（A股为完整三表；港股现金流量表为总量口径；美股现金流量明细来自 SEC EDGAR）。若某张报表 available=false，必须按 unavailable 里的 reason 写明「数据缺失」。注意 A 股/港股为年初至今累计口径，美股取的是累计季报口径，不得混用。',
    '7) 财报趋势图：financials 里某标的的报表有 ≥3 期时，ai_summary 必须附一张 ```chart 趋势图（营业总收入 / 归母净利润 / 经营活动现金流量净额，categories 用报告期），json 合法且 categories 与各 series.data 等长；期数不足 3 期则不画。',
    '8) 轮次纪律：本运行轮次有限，请**先写回已完成的分析**再继续下一项，不要在结论写回前做无穷尽的补充检索。',
    '以下是已抓取好的市场数据 JSON：',
    payloadJson,
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

/**
 * Trims a long Markdown text written by the app itself before re-sending it in a
 * prompt.
 *
 * The watchlist goal used to embed every item's **full previous `aiSummary`**:
 * in a 6-item pool that was 14,813 of the payload's 25,754 characters (58%), and
 * it is re-sent on every turn. The conclusion's first line is what the model
 * actually reasons about; the rest is retrievable with `list_watchlist`.
 */
export function trimForPrompt(text: string, maxChars: number): string {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars)}…（已截断，原文 ${clean.length} 字，如需全文请调用 list_watchlist）`;
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
    expectedReturnHorizon: item.expectedReturnHorizon,
    thesis: item.thesis,
    aiSummary: trimForPrompt(item.aiSummary, 240),
    note: item.note,
    status: item.status,
    retiredReason: item.retiredReason,
    retireStreak: item.retireStreak,
  }));

  // 覆盖度：模型天然会锚定已有池子（实测 5 个全是 A 股股票），把「缺哪个市场 /
  // 类型」显式喂给它，跨市场挖掘才会真的发生。退役标的不计入覆盖度。
  const active = watchlist.filter((item) => item.status !== 'retired');
  const byMarket = Object.fromEntries(MARKETS.map((m) => [m, active.filter((i) => i.market === m).length]));
  const byType = Object.fromEntries(INSTRUMENT_TYPES.map((t) => [t, active.filter((i) => i.type === t).length]));
  const gaps = [
    ...MARKETS.filter((m) => byMarket[m] === 0).map((m) => `${MARKET_LABELS[m]}（${m}）市场`),
    ...INSTRUMENT_TYPES.filter((t) => byType[t] === 0).map((t) => INSTRUMENT_TYPE_LABELS[t]),
  ];

  const goal = [
    '请按用户投资性格挖掘新的候选标的，复核既有标的，并淘汰不再适合继续跟踪的标的。',
    `候选数量上限：${settings.watchlistCandidateLimit} 个（本次允许新增）。质量分门槛：${persona.qualityGate}。`,
    // 市场/类型多样性：预算覆盖 CN/HK/US 三个市场，行情与财报数据源对三者都可用，
    // 因此不允许只挖 A 股；只有数据源真的不可用时才可跳过（必须在报告里说明）。
    `当前在池分布：市场 ${JSON.stringify(byMarket)}；类型 ${JSON.stringify(byType)}。`,
    gaps.length > 0
      ? `【覆盖度要求】本次请优先补齐未覆盖的：${gaps.join('、')}。CN / HK / US 三个市场都要认真检索（预算覆盖三地）；如果某个市场或类型最终没有合格候选，必须在报告中写明是哪个、为什么（数据源不可用 / 找不到达到质量分门槛的标的），不要默默只挑 A 股。`
      : '【覆盖度要求】池内已覆盖三个市场与三种类型，本次按景气度与性格择优，避免新增高度相关的同类标的。',
    '流程：',
    '1) 用 web_search / get_news 按性格偏好检索候选（行业景气、财务特征、政策与主题）。',
    '2) 用 market_search 确认代码与市场，用 get_quote 初筛（流动性、估值、涨跌幅），明显不合格的直接淘汰。',
    '3) 对通过初筛的候选做深度分析（get_financials 三表至少 4 期 / get_series / get_fundamentals / get_fund_info / get_dividends / get_news）。**基本面判断必须基于财报数字**：营收与归母净利同比、毛利率与 ROE 的跨期方向、经营现金流与净利润是否匹配、资产负债率与商誉/应收风险。',
    `4) 对每个合格候选调用 upsert_watch_item（quality_score 0-100、target_price、expected_return、expected_return_horizon、thesis、ai_summary）；quality_score 低于 ${persona.qualityGate} 的不要写入；最多新增 ${settings.watchlistCandidateLimit} 个。`,
    '4.1) **只对新候选做深度取数**：既有标的的价格与结论已在上面的「既有标的」里给出，不要为了复核它们重复调用 get_quote / get_series / get_financials；只有结论确实需要更新时才调用写工具。',
    '4.2) **同一个只读工具连续失败两次就不要再来第三次**（尤其是 get_series / get_fundamentals 返回 no_data）：工具报错里会带「数据源尝试」列表，说明是哪个上游失败。此时应在报告中写明「数据缺失：<指标>——<失败原因>」并继续，用已有数据或其它来源（get_financials / get_news / web_search）替代。',
    '5) 给出 target_price / expected_return 时必须同时给出 expected_return_horizon（例如「6-12 个月」「1-3 年」），期限要与收益口径一致（短线题材不要写「1-3 年」）。',
    '5.1) 【重要】每确认一个候选就**立刻**调用 upsert_watch_item 写回，不要攒到最后统一写 —— 轮次预算有限，实测出现过「研究完候选但轮次用尽、一个字都没写回」的情况。先写回，再研究下一个。',
    '6) 类型判定：market_search 对场外基金可能返回 type=etf（东财 suggest 的历史问题）。名称含「混合 / 债券 / 联接 / 发起式 / 定期开放 / 货币」的一律按场外基金处理：用 type=fund 再调 get_quote 与 get_fund_info 复核；type=etf 会命中同代码的股票（000001 场外基金 vs 平安银行），写入前必须核对 get_quote 返回的名称与搜索名称一致。',
    '7) 对既有标的中结论过时或价格显著变化的，同样调用 upsert_watch_item 更新（不要修改 initial_price）。',
    '8) 淘汰复核（P3）：逐个判断既有标的是否还值得继续跟踪。如果已经不适合（逻辑被证伪、基本面恶化、估值/趋势走坏、流动性或性价比明显落后），调用 retire_watch_item 写明原因；',
    `   已被标记 retired 的，如果仍然不适合，请再次调用 retire_watch_item 以累计次数（连续 ${settings.watchlistRetireDeleteRuns} 次后系统才会真正移除；0 表示只标记不删除）；如果重新变好，用 upsert_watch_item 更新即可自动复活。`,
    '   注意：有持仓的标的不得退役（retire_watch_item 会直接拒绝）——用户可能持续加仓，仓位处置请用 create_advice(action="sell")。',
    `既有标的（价格已刷新：成功 ${refresh.updated}、失败 ${refresh.failed}；status=active 在池 / retired 已退役）：`,
    JSON.stringify(existing),
    '分析要求：所有数字必须来自工具返回；数据缺失要写明（财报 unavailable 的 reason 必须原样交代）；给出目标价与预期收益时必须说明依据与风险；退役结论必须引用具体数据（含最新一期财报的可核对数字），不要凭感觉。',
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
