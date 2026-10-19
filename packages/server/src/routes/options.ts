/**
 * 期权卖权 HTTP 路由（契约冻结，前端按这个写）。
 *
 * 分工（与「新股打新」路由同一思路）：
 *  - 读路径（chain / candidates / positions / settlements）只做参数校验 + 调服务层；
 *  - 写路径（确认建议、手工登记、买平、人工确认/忽略结算）全部落在服务层的
 *    `repo.transaction` 里做「读状态 → 写」的原子判断，路由不自己写库；
 *  - 到期结算扫描是一条**写账本**路径：它经由 `services/options-settlement.ts` 拿到
 *    进程级流水线锁（拿不到就 409，reason 原样给用户），因为结算会写股票交割流水。
 *
 * 校验与错误口径：zod + `parseOrThrow`（照 routes/ipo.ts），错误用 badRequest / conflict /
 * notFound / upstreamError（errors.ts）。降级（取数失败、乘数未核对、港股无买卖盘…）
 * 一律以 `warnings` 原样返回，**绝不用 0 或猜测值掩盖**。
 *
 * Owner: server-core（期权卖权）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  MARKET_CURRENCY,
  type ConfirmOptionAdviceResult,
  type OptionAnalyzeResponse,
  type OptionCandidatesResponse,
  type OptionChainSnapshot,
  type OptionMarket,
  type OptionPosition,
  type OptionSettlementsResponse,
  type OptionSettlementRunResult,
  type OptionStrategy,
} from '@aia/shared';

import { NOT_CONFIGURED_MESSAGE } from '../agent/llm.js';
import { badRequest, conflict, notConfigured, notFound } from '../errors.js';
import { getAgent, getRepo } from '../registry.js';
import { localDate, parseOrThrow, tradeDateSchema } from '../db/util.js';
import type { LoggerLike } from '../types/agent.js';
import { computePosition, toAdviceItem } from '../services/portfolio.js';
import { runOptionAdvice, type PipelineContext } from '../services/analytics.js';
import { runExclusive } from '../services/pipeline-lock.js';
import {
  closeOptionPosition,
  confirmOptionAdvice,
  createManualOptionPosition,
  loadOptionChain,
  optionPositionsPayload,
  optionSettlementsPayload,
  screenOptionCandidates,
  toOptionPosition,
  type ManualOptionPositionInput,
} from '../services/options.js';
import {
  confirmOptionSettlement,
  dismissOptionSettlement,
  scanOptionSettlements,
} from '../services/options-settlement.js';

const optionMarketSchema = z.enum(['HK', 'US']);
const strategySchema = z.enum(['covered_call', 'cash_secured_put']);
const optionTypeSchema = z.enum(['call', 'put']);
const settlementStatusSchema = z.enum(['all', 'pending_review', 'auto_settled', 'confirmed', 'dismissed']);

const manualPositionSchema = z.object({
  market: optionMarketSchema,
  code: z.string().trim().min(1, '标的代码不能为空').max(20),
  underlyingName: z.string().trim().max(80).optional(),
  strategy: strategySchema,
  optionType: optionTypeSchema,
  optionCode: z.string().trim().min(1, '合约代码不能为空').max(64),
  strike: z.number().positive('行权价必须大于 0'),
  expiry: tradeDateSchema,
  contracts: z.number().int('张数必须是整数').min(1, '张数至少 1 张').max(1000),
  premium: z.number().positive('每股价权利金必须大于 0'),
  fee: z.number().min(0).optional(),
  multiplier: z.number().int().min(1).max(100_000).optional(),
  tradeDate: tradeDateSchema.optional(),
  note: z.string().max(500).optional(),
});

const closeSchema = z.object({
  price: z.number().positive('买平价格必须大于 0'),
  fee: z.number().min(0).optional(),
  tradeDate: tradeDateSchema.optional(),
  note: z.string().max(500).optional(),
});

const scanSchema = z
  .object({
    /** 强制重新取价（默认同一天已评估过的记录跳过）。 */
    force: z.boolean().optional(),
    /** 结算基准日（默认今天）。 */
    asOf: tradeDateSchema.optional(),
  })
  .optional();

const confirmSettlementSchema = z.object({
  verdict: z.enum(['assigned', 'otm_no_assignment']),
  /** 覆盖参考价（例如用户从券商对账单上拿到更权威的结算价）。 */
  referencePrice: z.number().positive().optional(),
  note: z.string().max(500).optional(),
});

const dismissSettlementSchema = z.object({ note: z.string().max(500).optional() }).optional();

const confirmOptionAdviceSchema = z.object({
  contracts: z.number().int('张数必须是整数').min(1, '张数至少 1 张').max(1000),
  premium: z.number().positive('每股价权利金必须大于 0'),
  expiry: tradeDateSchema,
  /** 行权价默认沿用建议值（用户可微调）。 */
  strike: z.number().positive().optional(),
  fee: z.number().min(0).optional(),
  tradeDate: tradeDateSchema.optional(),
  note: z.string().max(500).optional(),
});

const analyzeSchema = z
  .object({
    markets: z.array(optionMarketSchema).max(2).optional(),
    codes: z.array(z.string().trim().min(1).max(20)).max(20).optional(),
  })
  .optional();

export async function registerOptionRoutes(app: FastifyInstance): Promise<void> {
  const logger = app.log as unknown as LoggerLike;

  /* ── 期权链（真实报价；口径与降级必须原样展示） ─────────────────────────── */

  app.get('/api/options/chain', async (request) => {
    const query = (request.query ?? {}) as Record<string, string>;
    const market = parseOrThrow(optionMarketSchema, query.market, 'market') as OptionMarket;
    const code = (query.code ?? '').trim();
    if (!code) throw badRequest('code 必填（港股 5 位如 00700，美股如 AAPL）');
    const raw = Number.parseInt(query.maxExpiries ?? '', 10);
    const maxExpiries = Number.isFinite(raw) ? Math.max(1, Math.min(raw, 12)) : 6;
    const snapshot = await loadOptionChain({
      market,
      code,
      maxExpiries,
      forceRefresh: query.refresh === '1' || query.refresh === 'true',
    });
    return snapshot satisfies OptionChainSnapshot;
  });

  /* ── 确定性候选筛选（不经过 LLM；担保数据服务端读） ──────────────────────── */

  app.get('/api/options/candidates', async (request) => {
    const query = (request.query ?? {}) as Record<string, string>;
    const market = parseOrThrow(optionMarketSchema, query.market, 'market') as OptionMarket;
    const code = (query.code ?? '').trim();
    if (!code) throw badRequest('code 必填');
    const raw = Number.parseInt(query.limit ?? '', 10);
    const limit = Number.isFinite(raw) ? Math.max(1, Math.min(raw, 12)) : 6;

    const snapshot = await loadOptionChain({ market, code, maxExpiries: 6 });
    const repo = getRepo();
    // 担保数据一律从服务端读：持股来自「我的资产」的账本，现金来自设置页。
    const asset = repo.findAsset(code, market, 'stock') ?? repo.findAsset(code, market, 'etf');
    const heldShares = asset ? computePosition(repo.listTransactions(asset.id)).shares : 0;
    let availableCash = 0;
    const warnings: string[] = [];
    try {
      availableCash = repo.getSettings().option?.cash?.[market] ?? 0;
    } catch {
      warnings.push('读取「期权可用现金」设置失败；现金担保卖 Put 本次不产生候选。');
    }

    const strategies: OptionStrategy[] = ['covered_call', 'cash_secured_put'];
    const screened = strategies.map((strategy) => screenOptionCandidates({ snapshot, strategy, contracts: 1, heldShares, availableCash }));
    const candidates = screened
      .flatMap((result) => result.candidates)
      .sort((a, b) => b.metrics.annualizedYieldPct - a.metrics.annualizedYieldPct)
      .slice(0, limit);
    for (const result of screened) warnings.push(...result.warnings);
    if (heldShares > 0) warnings.push(`当前 ${code} 持股 ${heldShares} 股（覆盖量 = 持股 / 合约乘数）。`);

    return {
      market,
      code,
      currency: snapshot.currency || MARKET_CURRENCY[market],
      underlyingPrice: snapshot.underlyingPrice,
      asOf: snapshot.asOf,
      delayed: snapshot.delayed,
      source: snapshot.source,
      candidates,
      rejected: screened.flatMap((result) => result.rejected).slice(0, 60),
      warnings: [...new Set(warnings)],
    } satisfies OptionCandidatesResponse;
  });

  /* ── 触发一次 AI 期权卖权分析（非 SSE，返回 runId） ─────────────────────── */

  app.post('/api/options/analyze', async (request, reply) => {
    // 结构校验照旧；注意：本阶段的标的范围由「可用于担保的港股/美股持仓」决定
    // （见 analytics.ts 的 runOptionAdvice），markets/codes 仅用于校验与日志，
    // 不改变分析范围 —— 前端不应把它当成过滤器。
    const body = parseOrThrow(analyzeSchema, request.body ?? {}, '请求体') ?? {};
    const agent = getAgent();
    if (!agent.isConfigured()) throw notConfigured(NOT_CONFIGURED_MESSAGE);
    const context: PipelineContext = { agent, repo: getRepo(), logger };
    const outcome = await runExclusive('manual:option-advice', () => runOptionAdvice(context));
    if (!outcome.ok) throw conflict(outcome.reason);
    if (body.markets || body.codes) {
      logger.info(
        `option analyze requested with scope hint markets=${(body.markets ?? []).join(',') || '-'} codes=${(body.codes ?? []).join(',') || '-'}`,
      );
    }
    reply.code(202);
    return { runId: outcome.value.id } satisfies OptionAnalyzeResponse;
  });

  /* ── 在手合约 / 历史 ───────────────────────────────────────────────────── */

  app.get('/api/options/positions', async () => optionPositionsPayload());

  app.get<{ Params: { id: string } }>('/api/options/positions/:id', async (request) => {
    const repo = getRepo();
    const row = repo.getOptionContract(request.params.id);
    if (!row) throw notFound(`期权合约不存在：${request.params.id}`);
    return (await toOptionPosition(row, repo.findOptionSettlementByContract(row.id) ?? null)) satisfies OptionPosition;
  });

  app.post('/api/options/positions', async (request, reply) => {
    const body = parseOrThrow(manualPositionSchema, request.body ?? {}, '请求体');
    const row = createManualOptionPosition(body satisfies ManualOptionPositionInput);
    reply.code(201);
    return (await toOptionPosition(row, null)) satisfies OptionPosition;
  });

  app.post<{ Params: { id: string } }>('/api/options/positions/:id/close', async (request) => {
    const body = parseOrThrow(closeSchema, request.body ?? {}, '请求体');
    return closeOptionPosition({ id: request.params.id, ...body }) satisfies OptionPosition;
  });

  /** 只结算这一个合约（同样会写账本 → 走流水线锁，锁定返回 409）。 */
  app.post<{ Params: { id: string } }>('/api/options/positions/:id/settle', async (request) => {
    return (await scanOptionSettlements({ contractId: request.params.id, throwOnBusy: true })) satisfies OptionSettlementRunResult;
  });

  /* ── 到期结算记录 ──────────────────────────────────────────────────────── */

  app.get('/api/options/settlements', async (request) => {
    const query = (request.query ?? {}) as Record<string, string>;
    const status = query.status ? parseOrThrow(settlementStatusSchema, query.status, 'status') : 'all';
    return optionSettlementsPayload(status) satisfies OptionSettlementsResponse;
  });

  app.post('/api/options/settlements/scan', async (request) => {
    const body = parseOrThrow(scanSchema, request.body ?? {}, '请求体') ?? {};
    return (await scanOptionSettlements({ force: body.force === true, asOf: body.asOf, throwOnBusy: true })) satisfies OptionSettlementRunResult;
  });

  app.post<{ Params: { id: string } }>('/api/options/settlements/:id/confirm', async (request) => {
    const body = parseOrThrow(confirmSettlementSchema, request.body ?? {}, '请求体');
    return confirmOptionSettlement({ id: request.params.id, ...body }) satisfies OptionSettlementRunResult;
  });

  app.post<{ Params: { id: string } }>('/api/options/settlements/:id/dismiss', async (request) => {
    const body = parseOrThrow(dismissSettlementSchema, request.body ?? {}, '请求体') ?? {};
    return dismissOptionSettlement({ id: request.params.id, note: body.note });
  });

  /* ── 建议确认（写 option_contracts；开仓不写 transactions） ─────────────── */

  app.post<{ Params: { id: string } }>('/api/advice/:id/confirm-option', async (request, reply) => {
    const body = parseOrThrow(confirmOptionAdviceSchema, request.body ?? {}, '合约确认参数');
    if (body.tradeDate && body.tradeDate > localDate()) {
      throw badRequest(`成交日 ${body.tradeDate} 不能晚于今天（${localDate()}）`);
    }
    const result = confirmOptionAdvice({ adviceId: request.params.id, input: body });
    reply.code(201);
    return {
      advice: toAdviceItem(result.advice),
      position: result.position,
      warnings: result.warnings,
    } satisfies ConfirmOptionAdviceResult;
  });
}