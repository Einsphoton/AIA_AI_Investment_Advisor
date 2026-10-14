/**
 * 我的资产 CRUD + transactions + refresh (docs/API.md §4)
 *
 * Owner: server-core. Holdings are always derived from `transactions`
 * (`services/portfolio.ts`); nothing here stores shares/avgCost.
 *
 * NOTE: the SSE pipeline endpoints (`POST /api/assets/analyze`,
 * `GET /api/assets/analyze/last`) are registered by `routes/agent.ts`
 * (agent-engine owns the pipeline services) — do not add them here.
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  MARKET_CURRENCY,
  type AssetDetail,
  type AssetSummary,
  type ListResponse,
  type Market,
  type InstrumentType,
} from '@aia/shared';

import { badRequest, conflict, notFound } from '../errors.js';
import { getRepo } from '../registry.js';
import type { AssetRow, TxRow } from '../types/models.js';
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
  tradeDateSchema,
} from '../db/util.js';
import { computePosition, findLedgerDeficit, toAssetDetail, toAssetSummary } from '../services/portfolio.js';

/* ───────────────────────────────── helpers ────────────────────────────────── */

const createAssetSchema = z.object({
  code: z.string().trim().min(1, '代码不能为空'),
  market: z.enum(['CN', 'HK', 'US']),
  type: z.enum(['stock', 'etf', 'fund']),
  name: z.string().trim().optional(),
  shares: z.number().positive('份额需大于 0'),
  price: z.number().positive('价格需大于 0'),
  tradeDate: tradeDateSchema,
  note: z.string().optional(),
  fee: z.number().min(0).optional(),
  source: z.enum(['manual', 'ai']).optional(),
});

const updateAssetSchema = z.object({
  name: z.string().trim().min(1).optional(),
  note: z.string().optional(),
  market: z.enum(['CN', 'HK', 'US']).optional(),
  type: z.enum(['stock', 'etf', 'fund']).optional(),
});

const createTxSchema = z.object({
  kind: z.enum(['buy', 'sell']),
  shares: z.number().positive('份额需大于 0'),
  price: z.number().positive('价格需大于 0'),
  tradeDate: tradeDateSchema,
  note: z.string().optional(),
  fee: z.number().min(0).optional(),
  source: z.enum(['manual', 'ai', 'advice']).optional(),
});

function requireAsset(id: string): AssetRow {
  const asset = getRepo().getAsset(id);
  if (!asset) throw notFound(`资产不存在：${id}`);
  return asset;
}

function detailOf(asset: AssetRow): AssetDetail {
  return toAssetDetail(asset, getRepo().listTransactions(asset.id));
}

async function resolveName(
  code: string,
  market: Market,
  type: InstrumentType,
  fallback: string,
): Promise<string> {
  const bridge = await loadMarketBridge();
  if (!bridge) return fallback;
  const resolved = await bridge.resolveInstrument({ code, market, type });
  const name = resolved?.name;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : fallback;
}

/** `marketValue | pnl | changeSinceAdded | qualityScore | createdAt | name` */
function assetSortValue(item: { row: AssetRow; summary: AssetSummary }, sort: string | undefined): unknown {
  switch (sort) {
    case 'pnl':
      return item.summary.unrealizedPnl;
    case 'changeSinceAdded':
      return item.summary.dayChangePct;
    case 'qualityScore':
      return item.row.qualityScore;
    case 'createdAt':
      return item.summary.createdAt;
    case 'name':
      return item.summary.name;
    case 'shares':
      return item.summary.shares;
    case 'marketValue':
    default:
      return item.summary.marketValue;
  }
}

function groupTransactions(txs: TxRow[]): Map<string, TxRow[]> {
  const grouped = new Map<string, TxRow[]>();
  for (const tx of txs) {
    const list = grouped.get(tx.assetId);
    if (list) list.push(tx);
    else grouped.set(tx.assetId, [tx]);
  }
  return grouped;
}

/* ────────────────────────────────── routes ────────────────────────────────── */

export async function registerAssetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/assets', async (request) => {
    const query = parseListQuery(request.query);
    const repo = getRepo();
    const grouped = groupTransactions(repo.listTransactions());

    const rows = repo.listAssets().map((row) => ({ row, summary: toAssetSummary(row, grouped.get(row.id) ?? []) }));
    const filtered = rows.filter(
      ({ row, summary }) =>
        (!query.market || summary.market === query.market) &&
        (!query.type || summary.type === query.type) &&
        (!query.source || summary.source === query.source) &&
        matchesQuery(query.q, summary.name, summary.code, row.note),
    );
    const sorted = sortItems(filtered, (item) => assetSortValue(item, query.sort), sortDirection(query.dir));

    const items: AssetSummary[] = sorted.map(({ summary }) => summary);
    const response: ListResponse<AssetSummary> = { items, total: items.length };
    return response;
  });

  app.post('/api/assets', async (request) => {
    const body = parseOrThrow(createAssetSchema, request.body, '资产参数');
    const repo = getRepo();
    if (repo.findAsset(body.code, body.market, body.type)) {
      throw conflict(`资产已存在：${body.code}（${body.market}/${body.type}）`);
    }

    const name = body.name?.trim() ? body.name.trim() : await resolveName(body.code, body.market, body.type, body.code);
    const now = nowIso();
    const id = crypto.randomUUID();

    return repo.transaction(() => {
      repo.createAsset({
        id,
        name,
        code: body.code,
        market: body.market,
        type: body.type,
        source: body.source ?? 'manual',
        currency: MARKET_CURRENCY[body.market],
        note: body.note ?? '',
        // No live quote yet: use the trade price and make the day change zero.
        price: body.price,
        priceAt: now,
        prevClose: body.price,
        dayChangePct: 0,
        spark: [],
        createdAt: now,
      });
      repo.addTransaction({
        id: crypto.randomUUID(),
        assetId: id,
        kind: 'buy',
        shares: body.shares,
        price: body.price,
        fee: body.fee ?? 0,
        tradeDate: body.tradeDate,
        note: body.note ?? '',
        source: 'manual',
        createdAt: now,
      });
      const created = repo.getAsset(id);
      if (!created) throw badRequest('资产创建失败');
      return detailOf(created);
    });
  });

  app.post('/api/assets/refresh', async (request) => {
    const repo = getRepo();
    const grouped = groupTransactions(repo.listTransactions());
    const openAssets = repo
      .listAssets()
      .filter((asset) => computePosition(grouped.get(asset.id) ?? []).shares > 0);

    const bridge = await loadMarketBridge();
    if (!bridge) {
      request.log.warn('行情数据源不可用（AIA_OFFLINE 或 datasources 模块缺失），跳过资产价格刷新');
      return { updated: 0, failed: openAssets.length, warnings: ['行情数据源不可用，未能刷新价格'] };
    }

    let updated = 0;
    let failed = 0;
    for (const asset of openAssets) {
      try {
        const quote = await bridge.quote(asset.market, asset.code, asset.type);
        const price = round4(toNumber(quote?.price));
        if (!(price > 0)) {
          failed += 1;
          continue;
        }
        const prevClose = toNumber(quote?.prevClose, asset.prevClose) || price;
        const dayChangePct =
          quote?.dayChangePct !== undefined
            ? toNumber(quote.dayChangePct)
            : prevClose > 0
              ? round4(((price - prevClose) / prevClose) * 100)
              : 0;
        const spark = await bridge.series(asset.market, asset.code, asset.type);
        repo.updateAsset(asset.id, {
          price,
          prevClose,
          dayChangePct,
          priceAt: nowIso(),
          spark: spark.length > 0 ? spark : undefined,
        });
        updated += 1;
      } catch {
        failed += 1;
      }
    }
    return { updated, failed, warnings: failed > 0 ? [`${failed} 个标的价格刷新失败`] : [] };
  });

  app.get('/api/assets/:id', async (request) => {
    const { id } = request.params as { id: string };
    return detailOf(requireAsset(id));
  });

  app.put('/api/assets/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(updateAssetSchema, request.body, '资产参数');
    const repo = getRepo();
    const asset = requireAsset(id);

    const market = body.market ?? asset.market;
    const type = body.type ?? asset.type;
    if (market !== asset.market || type !== asset.type) {
      const clash = repo.findAsset(asset.code, market, type);
      if (clash && clash.id !== id) throw conflict(`同市场下已存在 ${asset.code}（${market}/${type}）`);
    }

    const updated = repo.updateAsset(id, {
      name: body.name,
      note: body.note,
      market: body.market,
      type: body.type,
      currency: body.market ? MARKET_CURRENCY[body.market] : undefined,
    });
    if (!updated) throw notFound(`资产不存在：${id}`);
    return detailOf(updated);
  });

  app.delete('/api/assets/:id', async (request) => {
    const { id } = request.params as { id: string };
    requireAsset(id);
    getRepo().deleteAsset(id);
    return { ok: true };
  });

  app.post('/api/assets/:id/transactions', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(createTxSchema, request.body, '交易参数');
    const repo = getRepo();
    const asset = requireAsset(id);

    const createdAt = nowIso();
    const existing = repo.listTransactions(id);

    if (body.kind === 'sell') {
      // Gate 1 (aggregate): never sell more than the position held today.
      const position = computePosition(existing);
      if (body.shares > position.shares + 1e-6) {
        throw conflict(`卖出份额 ${body.shares} 超过当前持仓 ${position.shares}`, { shares: body.shares, held: position.shares });
      }

      // Gate 2 (timeline): a back-dated sell may still be impossible at its own
      // trade date; replaying with it inserted keeps the ledger non-negative.
      const candidate: TxRow = {
        id: 'pending',
        assetId: id,
        kind: 'sell',
        shares: body.shares,
        price: body.price,
        fee: body.fee ?? 0,
        tradeDate: body.tradeDate,
        note: body.note ?? '',
        source: body.source ?? 'manual',
        createdAt,
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
      assetId: id,
      kind: body.kind,
      shares: body.shares,
      price: body.price,
      fee: body.fee ?? 0,
      tradeDate: body.tradeDate,
      note: body.note ?? '',
      source: body.source ?? 'manual',
      createdAt,
    });

    const refreshed = repo.getAsset(id);
    if (!refreshed) throw notFound(`资产不存在：${id}`);
    return detailOf(refreshed);
  });

  app.delete('/api/assets/:id/transactions/:txId', async (request) => {
    const { id, txId } = request.params as { id: string; txId: string };
    const repo = getRepo();
    requireAsset(id);
    const tx = repo.getTransaction(txId);
    if (!tx || tx.assetId !== id) throw notFound(`交易不存在：${txId}`);

    // Deleting a buy can leave sells without a matching position; the portfolio
    // math would silently drop the oversized sell and make realised P&L vanish.
    const deficit = findLedgerDeficit(repo.listTransactions(id).filter((item) => item.id !== txId));
    if (deficit) {
      throw conflict(
        `删除该笔${tx.kind === 'buy' ? '买入' : ''}交易后会出现没有对应持仓的卖出记录` +
          `（${deficit.tradeDate} 卖出 ${deficit.shares}，当时可用 ${deficit.available}），已拒绝删除`,
        { txId: tx.id, tradeDate: deficit.tradeDate, shares: deficit.shares },
      );
    }

    repo.deleteTransaction(txId);
    const asset = repo.getAsset(id);
    if (!asset) throw notFound(`资产不存在：${id}`);
    return detailOf(asset);
  });
}
