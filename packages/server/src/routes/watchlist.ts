/**
 * 我的标的 CRUD + clear + patch (docs/API.md §5)
 *
 * Owner: server-core. The SSE pipeline endpoints
 * (`POST /api/watchlist/analyze`, `GET /api/watchlist/analyze/last`) live in
 * `routes/agent.ts` (agent-engine owns the pipeline services).
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { WatchItem, WatchlistDetail, WatchlistListResponse } from '@aia/shared';

import { conflict, notFound } from '../errors.js';
import { getRepo } from '../registry.js';
import type { WatchRow } from '../types/models.js';
import type { WatchlistStatusFilter } from '../types/repo.js';
import {
  loadMarketBridge,
  matchesQuery,
  nowIso,
  parseListQuery,
  parseOrThrow,
  round4,
  sortDirection,
  sortItems,
  toNumber,
} from '../db/util.js';
import { toAssetSummary, toTransaction, toWatchItem } from '../services/portfolio.js';

const createWatchSchema = z.object({
  code: z.string().trim().min(1, '代码不能为空'),
  market: z.enum(['CN', 'HK', 'US']),
  type: z.enum(['stock', 'etf', 'fund']),
  name: z.string().trim().optional(),
  note: z.string().optional(),
  source: z.enum(['manual', 'ai']).optional(),
});

const updateWatchSchema = z.object({
  note: z.string().optional(),
  qualityScore: z.number().min(0).max(100).optional(),
  targetPrice: z.number().min(0).optional(),
  expectedReturn: z.number().optional(),
  /** 预期收益的到达期限（自由文本，例如「6-12 个月」），最长 40 字。 */
  expectedReturnHorizon: z.string().max(40).optional(),
  thesis: z.string().optional(),
});

function requireWatchItem(id: string): WatchRow {
  const item = getRepo().getWatchItem(id);
  if (!item) throw notFound(`标的不存在：${id}`);
  return item;
}

function watchSortValue(item: WatchItem, sort: string | undefined): unknown {
  switch (sort) {
    case 'marketValue':
    case 'pnl':
      return item.changeSinceAdded;
    case 'changeSinceAdded':
      return item.changeSinceAddedPct;
    case 'qualityScore':
      return item.qualityScore;
    case 'createdAt':
      return item.createdAt;
    case 'name':
      return item.name;
    case 'targetPrice':
      return item.targetPrice;
    default:
      return item.createdAt;
  }
}

export async function registerWatchlistRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/watchlist', async (request) => {
    const query = parseListQuery(request.query);
    const repo = getRepo();
    // P3：默认只看在池标的；`status=retired|all` 用于复盘与全量查看。
    const rawStatus = (request.query as Record<string, unknown>).status;
    const status: WatchlistStatusFilter = rawStatus === 'retired' || rawStatus === 'all' ? rawStatus : 'active';
    const items = repo
      .listWatchlist(status)
      .map(toWatchItem)
      .filter(
        (item) =>
          (!query.market || item.market === query.market) &&
          (!query.type || item.type === query.type) &&
          (!query.source || item.source === query.source) &&
          matchesQuery(query.q, item.name, item.code, item.note, item.thesis),
      );
    const sorted = sortItems(items, (item) => watchSortValue(item, query.sort), sortDirection(query.dir));
    const response: WatchlistListResponse = {
      items: sorted,
      total: sorted.length,
      counts: repo.countWatchlist(),
    };
    return response;
  });

  app.post('/api/watchlist', async (request) => {
    const body = parseOrThrow(createWatchSchema, request.body, '标的参数');
    const repo = getRepo();
    if (repo.findWatchItem(body.code, body.market, body.type)) {
      throw conflict(`标的已存在：${body.code}（${body.market}/${body.type}）`);
    }

    let name = body.name?.trim() ?? '';
    let initialPrice = 0;
    let priceAt: string | null = null;
    const bridge = await loadMarketBridge();
    if (bridge) {
      const resolved = await bridge.resolveInstrument({ code: body.code, market: body.market, type: body.type });
      if (!name && typeof resolved?.name === 'string' && resolved.name.trim() !== '') name = resolved.name.trim();
      const quote = await bridge.quote(body.market, body.code, body.type);
      const price = round4(toNumber(quote?.price));
      if (price > 0) {
        initialPrice = price;
        priceAt = nowIso();
      }
    }
    if (!name) name = body.code;

    const createdAt = nowIso();
    const id = crypto.randomUUID();
    const created = repo.createWatchItem({
      id,
      name,
      code: body.code,
      market: body.market,
      type: body.type,
      source: body.source ?? 'manual',
      initialPrice,
      initialPriceAt: priceAt,
      price: initialPrice,
      priceAt,
      prevClose: initialPrice,
      dayChangePct: 0,
      spark: [],
      note: body.note ?? '',
      createdAt,
    });
    return toWatchItem(created);
  });

  app.delete('/api/watchlist', async () => ({ ok: true, deleted: getRepo().clearWatchlist() }));

  /**
   * 刷新池内标的行情：现价 / 昨收 / 当日涨跌 / 走势缩略图。
   *
   * 以前价格只在「AI 标的分析」开跑时顺带刷新一次，两次分析之间列表里的
   * 「推荐后涨跌」一直是 0。这个入口让页面可以随取随新（也供定时任务之外的手动刷新）。
   */
  app.post('/api/watchlist/refresh', async (request) => {
    const repo = getRepo();
    const items = repo.listWatchlist('all');
    const bridge = await loadMarketBridge();
    if (!bridge) {
      request.log.warn('行情数据源不可用（AIA_OFFLINE 或 datasources 模块缺失），跳过标的行情刷新');
      return { updated: 0, failed: items.length, warnings: ['行情数据源不可用，未能刷新行情'] };
    }

    let updated = 0;
    let failed = 0;
    for (const item of items) {
      try {
        const quote = await bridge.quote(item.market, item.code, item.type);
        const price = round4(toNumber(quote?.price));
        if (!(price > 0)) {
          failed += 1;
          continue;
        }
        const prevClose = toNumber(quote?.prevClose, item.prevClose) || price;
        const dayChangePct =
          quote?.dayChangePct !== undefined
            ? toNumber(quote.dayChangePct)
            : prevClose > 0
              ? round4(((price - prevClose) / prevClose) * 100)
              : 0;
        const spark = await bridge.series(item.market, item.code, item.type);
        repo.updateWatchItem(item.id, {
          price,
          prevClose,
          dayChangePct,
          priceAt: nowIso(),
          spark: spark.length > 0 ? spark : undefined,
        });
        updated += 1;
      } catch (error) {
        failed += 1;
        request.log.warn(
          `标的行情刷新失败 ${item.code}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { updated, failed, warnings: failed > 0 ? [`${failed} 个标的行情刷新失败`] : [] };
  });

  app.get('/api/watchlist/:id', async (request) => {
    const { id } = request.params as { id: string };
    const repo = getRepo();
    const item = requireWatchItem(id);

    const asset = repo.findAsset(item.code, item.market, item.type);
    const transactions = asset ? repo.listTransactions(asset.id) : [];
    const detail: WatchlistDetail = {
      ...toWatchItem(item),
      holding: asset ? toAssetSummary(asset, transactions) : null,
      transactions: transactions.map(toTransaction),
      // Dividends come from the market-data layer; an empty list means "unknown".
      dividends: [],
    };
    return detail;
  });

  app.patch('/api/watchlist/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(updateWatchSchema, request.body, '标的参数');
    requireWatchItem(id);
    const updated = getRepo().updateWatchItem(id, body);
    if (!updated) throw notFound(`标的不存在：${id}`);
    return toWatchItem(updated);
  });

  app.delete('/api/watchlist/:id', async (request) => {
    const { id } = request.params as { id: string };
    requireWatchItem(id);
    getRepo().deleteWatchItem(id);
    return { ok: true };
  });

  /**
   * P3 复活：清空退役标记与累计次数。
   *
   * 两个场景：AI 判断有误（用户重新看好），或该标的重新进入候选池。
   * 有持仓的标的不会进入淘汰流程，因此这里的复活只影响候选状态。
   */
  app.post('/api/watchlist/:id/restore', async (request) => {
    const { id } = request.params as { id: string };
    requireWatchItem(id);
    const updated = getRepo().updateWatchItem(id, {
      status: 'active',
      retiredReason: '',
      retiredAt: null,
      retireStreak: 0,
    });
    if (!updated) throw notFound(`标的不存在：${id}`);
    return toWatchItem(updated);
  });
}
