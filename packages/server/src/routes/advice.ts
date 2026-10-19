/**
 * AI 投资建议 list / reject / confirm + budget (docs/API.md §6)
 *
 * Owner: server-core. The generation pipeline
 * (`POST /api/advice/generate`, `GET /api/advice/last`) lives in
 * `routes/agent.ts` (agent-engine owns the pipeline services).
 *
 * Budget rules (docs/API.md §6): per calendar month, per market currency,
 * `spent` = buy turnover, `remaining = budget − spent`, `exhausted = remaining <= 0`.
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  MARKET_CURRENCY,
  type AdviceItem,
  type BudgetStatus,
} from '@aia/shared';

import { badRequest, conflict, notFound } from '../errors.js';
import { getRepo } from '../registry.js';
import type { AdviceRow, TxRow } from '../types/models.js';
import type { LoggerLike } from '../types/agent.js';
import { localDate, localMonth, nowIso, parseOrThrow, tradeDateSchema } from '../db/util.js';
import { readAdviceOutcomes, trackAdviceOutcomes } from '../services/advice-outcomes.js';
import {
  computeBudgetStatus,
  computePosition,
  findLedgerDeficit,
  toAdviceItem,
  toAssetDetail,
} from '../services/portfolio.js';

const listQuerySchema = z.object({
  status: z.enum(['pending', 'confirmed', 'rejected', 'expired']).optional(),
});

const confirmSchema = z.object({
  shares: z.number().positive('份额需大于 0'),
  price: z.number().positive('价格需大于 0'),
  tradeDate: tradeDateSchema.optional(),
  fee: z.number().min(0).optional(),
});

function budgetStatus(month: string = localMonth()): BudgetStatus {
  const repo = getRepo();
  return computeBudgetStatus(repo.listAssets(), repo.listTransactions(), repo.getSettings().budget, month);
}

function requireAdvice(id: string): AdviceRow {
  const advice = getRepo().getAdvice(id);
  if (!advice) throw notFound(`建议不存在：${id}`);
  return advice;
}

export async function registerAdviceRoutes(app: FastifyInstance): Promise<void> {
  const logger = app.log as unknown as LoggerLike;

  app.get('/api/budget', async () => budgetStatus());

  /**
   * 建议结果追踪：确定性记录每条建议相对基准指数的实际表现。
   * 只读——数字由 `trackAdviceOutcomes` 落库，这里不触网。
   */
  app.get('/api/advice/outcomes', async () => readAdviceOutcomes(getRepo()));

  /** 手动触发一次重算（界面上的「刷新追踪」按钮 / 定时任务的旁路能力）。 */
  app.post('/api/advice/outcomes/track', async () => {
    const repo = getRepo();
    const result = await trackAdviceOutcomes({ repo, logger });
    return { ...readAdviceOutcomes(repo), tracked: result };
  });

  app.get('/api/advice', async (request) => {
    const query = parseOrThrow(listQuerySchema, request.query, '查询参数');
    const items = getRepo().listAdvice(query.status ? { status: query.status } : {}).map(toAdviceItem);
    const response: { items: AdviceItem[]; budget: BudgetStatus } = { items, budget: budgetStatus() };
    return response;
  });

  app.post('/api/advice/:id/reject', async (request) => {
    const { id } = request.params as { id: string };
    const advice = requireAdvice(id);
    if (advice.status !== 'pending') throw conflict(`该建议当前状态为 ${advice.status}，无法驳回`);
    const updated = getRepo().updateAdvice(id, { status: 'rejected', decidedAt: nowIso() });
    if (!updated) throw notFound(`建议不存在：${id}`);
    return toAdviceItem(updated);
  });

  app.post('/api/advice/:id/confirm', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(confirmSchema, request.body, '执行参数');
    const repo = getRepo();
    const advice = requireAdvice(id);
    if (advice.status !== 'pending') throw conflict(`该建议当前状态为 ${advice.status}，无法执行`);

    // 期权卖权建议必须走合约确认：这条路径会把 action='sell' 当股票卖出（校验持仓、
    // 写 stock 交易流水），而期权要写的是 option_contracts（只有权利金流入）。
    // 分流判断必须放在下面「卖出无持仓」之前——否则用户看到的是误导性的「没有对应持仓」。
    if (advice.instrument === 'option') {
      throw badRequest('该建议是期权卖权建议，请按合约条件确认', {
        code: 'USE_CONFIRM_OPTION',
        instrument: advice.instrument,
        endpoint: `/api/advice/${advice.id}/confirm-option`,
        hint: '期权确认需要填张数 / 权利金 / 到期日（可选行权价），参数见 ConfirmOptionAdviceInput。',
      });
    }

    const tradeDate = body.tradeDate ?? localDate();
    const now = nowIso();

    return repo.transaction(() => {
      let assetId = advice.assetId ?? undefined;
      if (assetId && !repo.getAsset(assetId)) assetId = undefined;
      if (!assetId) assetId = repo.findAsset(advice.code, advice.market, advice.type)?.id;
      if (!assetId) {
        if (advice.action === 'sell') throw badRequest('该卖出建议没有对应持仓，无法执行');
        const created = crypto.randomUUID();
        repo.createAsset({
          id: created,
          name: advice.assetName || advice.code,
          code: advice.code,
          market: advice.market,
          type: advice.type,
          source: 'ai',
          currency: advice.currency || MARKET_CURRENCY[advice.market],
          note: `由 AI 建议 ${advice.id} 建仓`,
          price: body.price,
          priceAt: now,
          prevClose: body.price,
          dayChangePct: 0,
          spark: [],
          createdAt: now,
        });
        assetId = created;
      }

      if (advice.action === 'sell') {
        const existing = repo.listTransactions(assetId);

        // Gate 1 (aggregate): never sell more than the position held today.
        const position = computePosition(existing);
        if (body.shares > position.shares + 1e-6) {
          throw conflict(`卖出份额 ${body.shares} 超过当前持仓 ${position.shares}`, {
            shares: body.shares,
            held: position.shares,
          });
        }

        // Gate 2 (timeline): a back-dated confirmation may still be impossible at
        // its own trade date — same invariant as the assets transaction path.
        const candidate: TxRow = {
          id: 'pending',
          assetId,
          kind: 'sell',
          shares: body.shares,
          price: body.price,
          fee: body.fee ?? 0,
          tradeDate,
          note: '',
          source: 'advice',
          createdAt: now,
        };
        const deficit = findLedgerDeficit([...existing, candidate]);
        if (deficit) {
          throw conflict(
            `该卖出日期早于可用持仓形成时间（${deficit.tradeDate} 卖出 ${deficit.shares} 份，当时仅有 ${deficit.available} 份）`,
            { tradeDate: deficit.tradeDate, shares: deficit.shares, available: deficit.available },
          );
        }
      }

      repo.addTransaction({
        id: crypto.randomUUID(),
        assetId,
        kind: advice.action,
        shares: body.shares,
        price: body.price,
        fee: body.fee ?? 0,
        tradeDate,
        note: `AI 建议：${advice.reason || advice.id}`.slice(0, 500),
        source: 'advice',
        createdAt: now,
      });

      const updatedAdvice = repo.updateAdvice(id, {
        status: 'confirmed',
        assetId,
        executedShares: body.shares,
        executedPrice: body.price,
        decidedAt: now,
      });
      const asset = repo.getAsset(assetId);
      if (!updatedAdvice || !asset) throw notFound(`建议或持仓更新失败：${id}`);
      return { advice: toAdviceItem(updatedAdvice), asset: toAssetDetail(asset, repo.listTransactions(assetId)) };
    });
  });
}
