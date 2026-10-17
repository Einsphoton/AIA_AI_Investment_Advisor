/**
 * 新股打新 CRUD + 刷新 + 申购 / 中签入账（docs/API.md §12）
 *
 * 与「我的资产」「我的标的」的分工：
 *  - 打新标的是**发行期**数据，独立成表（`ipo_offers`），刷新时整体覆盖；
 *  - 中签入账**不在这里**直接操作账本，而是走 `services/ipo.ts` 的
 *    `recordIpoAllotment`，复用与人工录入相同的账本一致性校验（单笔写入 + 重放校验）。
 *
 * SSE 管线入口（`POST /api/ipo/analyze`）按既有约定放在 `routes/agent.ts`
 * （agent-engine 拥有流水线），此文件只做确定性 CRUD。
 *
 * Owner: server-core.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { IpoAllotResult, IpoListResponse, IpoOffer, IpoRefreshResult, Market } from '@aia/shared';

import { badRequest } from '../errors.js';
import { getRepo } from '../registry.js';
import { parseOrThrow, tradeDateSchema } from '../db/util.js';
import {
  ipoOfferDetail,
  listIpoPayload,
  recordIpoAllotment,
  refreshIpoOffers,
  removeIpoSubscription,
  requireIpoOffer,
  subscribeIpo,
  upsertManualIpoOffer,
} from '../services/ipo.js';

const marketSchema = z.enum(['CN', 'HK', 'US']);
const statusSchema = z.enum(['upcoming', 'subscribing', 'allotted', 'listed', 'unknown']);

const refreshSchema = z
  .object({
    markets: z.array(marketSchema).max(3).optional(),
    /** 每市场最多取多少条（1-200）。 */
    limitPerMarket: z.number().int().min(1).max(200).optional(),
  })
  .optional();

const subscribeSchema = z.object({
  shares: z.number().positive('申购股数需大于 0'),
  price: z.number().positive().optional(),
  note: z.string().max(500).optional(),
  appliedAt: tradeDateSchema.optional(),
});

const allotSchema = z.object({
  /** 0 = 未中签（只更新状态，不写账本）。 */
  shares: z.number().min(0, '中签股数不能为负数'),
  price: z.number().positive().optional(),
  fee: z.number().min(0).optional(),
  tradeDate: tradeDateSchema.optional(),
  note: z.string().max(500).optional(),
});

const manualOfferSchema = z.object({
  market: marketSchema,
  code: z.string().trim().min(1, '新股代码不能为空').max(20),
  name: z.string().trim().min(1, '新股名称不能为空').max(80),
  subscribeCode: z.string().trim().max(20).optional(),
  exchange: z.string().trim().max(40).optional(),
  board: z.string().trim().max(40).optional(),
  issuePrice: z.number().min(0).optional(),
  priceLow: z.number().min(0).optional(),
  priceHigh: z.number().min(0).optional(),
  lotSize: z.number().min(0).optional(),
  maxShares: z.number().min(0).optional(),
  subscribeStart: tradeDateSchema.optional(),
  subscribeEnd: tradeDateSchema.optional(),
  allotmentDate: tradeDateSchema.optional(),
  listingDate: tradeDateSchema.optional(),
  issuePe: z.number().min(0).optional(),
  industryPe: z.number().min(0).optional(),
  winningRate: z.number().min(0).optional(),
  sponsor: z.string().trim().max(120).optional(),
  industry: z.string().trim().max(60).optional(),
  prospectusUrl: z.string().trim().max(500).optional(),
  note: z.string().max(500).optional(),
});

export async function registerIpoRoutes(app: FastifyInstance): Promise<void> {
  /* ── 列表 ──────────────────────────────────────────────────────────────── */

  app.get('/api/ipo', async (request) => {
    const query = (request.query ?? {}) as Record<string, string>;
    const market = query.market ? parseOrThrow(marketSchema, query.market, 'market') : undefined;
    const status = query.status ? parseOrThrow(statusSchema, query.status, 'status') : undefined;
    const limitRaw = Number.parseInt(query.limit ?? '', 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 500)) : undefined;
    return listIpoPayload(getRepo(), {
      market,
      status,
      q: typeof query.q === 'string' ? query.q : undefined,
      limit,
    }) satisfies IpoListResponse;
  });

  /* ── 刷新（从公开数据源抓取） ────────────────────────────────────────────── */

  app.post('/api/ipo/refresh', async (request) => {
    const body = parseOrThrow(refreshSchema, request.body ?? {}, '请求体') ?? {};
    const markets = body.markets as Market[] | undefined;
    const result = await refreshIpoOffers(getRepo(), {
      markets,
      limitPerMarket: body.limitPerMarket,
    });
    return result satisfies IpoRefreshResult;
  });

  /* ── 手动录入 / 修正一只新股（上游缺数据时的兜底） ────────────────────────── */

  app.post('/api/ipo', async (request) => {
    const body = parseOrThrow(manualOfferSchema, request.body ?? {}, '请求体');
    return upsertManualIpoOffer(getRepo(), body) satisfies IpoOffer;
  });

  /* ── 详情 ──────────────────────────────────────────────────────────────── */

  app.get<{ Params: { id: string } }>('/api/ipo/:id', async (request) => {
    return ipoOfferDetail(getRepo(), request.params.id);
  });

  /* ── 删除标的（连带删除申购登记） ────────────────────────────────────────── */

  app.delete<{ Params: { id: string } }>('/api/ipo/:id', async (request) => {
    const repo = getRepo();
    const offer = requireIpoOffer(repo, request.params.id);
    repo.deleteIpoOffer(offer.id);
    return { ok: true, id: offer.id, uid: offer.uid };
  });

  /* ── 登记「我申购了 N 股」 ──────────────────────────────────────────────── */

  app.post<{ Params: { id: string } }>('/api/ipo/:id/subscribe', async (request) => {
    const body = parseOrThrow(subscribeSchema, request.body ?? {}, '请求体');
    return subscribeIpo(getRepo(), request.params.id, body) satisfies IpoOffer;
  });

  app.delete<{ Params: { id: string } }>('/api/ipo/:id/subscription', async (request) => {
    return removeIpoSubscription(getRepo(), request.params.id);
  });

  /* ── 登记中签结果 → 自动入账 ───────────────────────────────────────────── */

  app.post<{ Params: { id: string } }>('/api/ipo/:id/allot', async (request) => {
    const body = parseOrThrow(allotSchema, request.body ?? {}, '请求体');
    if (!Number.isFinite(body.shares)) throw badRequest('中签股数必须是数字');
    return recordIpoAllotment(getRepo(), request.params.id, body) satisfies IpoAllotResult;
  });
}