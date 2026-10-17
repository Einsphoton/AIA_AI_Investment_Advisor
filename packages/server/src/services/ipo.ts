/**
 * 新股打新 (IPO) 服务 —— 架构见 docs/ARCHITECTURE.md §4.3.4。
 *
 * 三条确定性职责（都不调用 LLM）：
 *  1. **汇总**：`refreshIpoOffers` 从公开数据源抓 A股/港股/美股新股，按稳定业务键
 *     `uid = market:code` 落库（只更新上游真正给到的字段，不覆盖人工备注与 AI 结论）。
 *  2. **登记**：`subscribeIpo` / `recordIpoAllotment` 记录「我申购了多少」「我中签了多少」。
 *  3. **入账**：中签股数 > 0 时**自动**写入「我的资产」——建资产 + 买入流水
 *     （`source='ipo'`），复用与人工录入完全相同的账本一致性校验（见 routes/assets.ts）。
 *
 * 口径说明（必须显式，否则界面与 AI 会误读）：
 *  - 中签入账**不受**月预算阻拦：钱已经缴了，账必须记上；超出预算只给 `warnings` 提示，
 *    因为预算是「AI 买入建议」的约束，不是记账的约束。
 *  - 同一只新股重复入账 = **幂等修正**：先删掉上一次由本流程写入的买入流水再写新的，
 *    不会把两次中签累加成两倍持仓；若期间已有卖出，删除会破坏账本，此时直接拒绝。
 */
import crypto from 'node:crypto';
import {
  IPO_REFRESH_MAX_PER_MARKET,
  MARKET_CURRENCY,
  type IpoAdviceVerdict,
  type IpoAllotInput,
  type IpoAllotResult,
  type IpoListResponse,
  type IpoMarketStatus,
  type IpoOffer,
  type IpoRefreshResult,
  type IpoSubscribeInput,
  type IpoSubscription,
  type IpoUpsertInput,
  type Market,
  type SourceId,
} from '@aia/shared';

import { AppError, conflict, notFound } from '../errors.js';
import type { Repo } from '../types/repo.js';
import type { IpoOfferRow, IpoSubscriptionRow, NewIpoOffer, NewIpoSubscription, AssetRow } from '../types/models.js';
import { localDate, nowIso, round4, toNumber } from '../db/util.js';
import { collectIpoOffers } from '../datasources/registry.js';
import type { IpoOfferDraft } from '../datasources/types.js';
import { computeBudgetStatus, findLedgerDeficit, toAssetDetail } from './portfolio.js';

/* ────────────────────────────── 纯函数：映射 ──────────────────────────────── */

/** 稳定业务键：`market:code`（上市代码缺失时退化为申购代码）。 */
export function ipoUid(market: Market, code: string, subscribeCode = ''): string {
  const key = (code || subscribeCode).trim().toUpperCase();
  return `${market}:${key}`;
}

/**
 * 由日期确定性推导新股阶段。
 *
 * 上游给的状态五花八门（有的只有「待上市」，有的什么都不给），所以一律用**日期**判断，
 * 拿不到日期时给 `unknown` 而不是猜 —— 界面会显示「状态未知」，AI 也会被提示不要去猜。
 */
export function deriveIpoStatus(
  input: {
    subscribeStart?: string | null;
    subscribeEnd?: string | null;
    allotmentDate?: string | null;
    listingDate?: string | null;
  },
  today: string = localDate(),
): IpoMarketStatus {
  const listing = normalizeDate(input.listingDate);
  const applyEnd = normalizeDate(input.subscribeEnd);
  const applyStart = normalizeDate(input.subscribeStart);
  const allot = normalizeDate(input.allotmentDate);

  if (listing && listing <= today) return 'listed';
  // 申购开始日已过 / 今天就是开始日 → 视为招股中（上游常常只给其中一头日期）。
  if (applyStart && today < applyStart) return 'upcoming';
  if (applyEnd && today <= applyEnd) return 'subscribing';
  // 申购期已过（或没给申购期）但还没上市：有上市日/中签结果日就是「待上市」。
  if (listing || allot) return 'allotted';
  if (applyEnd) return 'allotted';
  return 'unknown';
}

function normalizeDate(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const match = /^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/.exec(text);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** 落库行 + 申购记录 → 对外契约（列表与详情共用）。 */
export function toIpoOffer(row: IpoOfferRow, subscription: IpoSubscriptionRow | null): IpoOffer {
  return {
    id: row.id,
    uid: row.uid,
    market: row.market,
    code: row.code,
    subscribeCode: row.subscribeCode,
    name: row.name,
    source: row.source as SourceId,
    exchange: row.exchange,
    board: row.board,
    issuePrice: row.issuePrice,
    priceLow: row.priceLow,
    priceHigh: row.priceHigh,
    currency: row.currency,
    lotSize: row.lotSize,
    maxShares: row.maxShares,
    subscribeStart: row.subscribeStart,
    subscribeEnd: row.subscribeEnd,
    allotmentDate: row.allotmentDate,
    listingDate: row.listingDate,
    issueShares: row.issueShares,
    raiseAmount: row.raiseAmount,
    issuePe: row.issuePe,
    industryPe: row.industryPe,
    winningRate: row.winningRate,
    oversubscribe: row.oversubscribe,
    sponsor: row.sponsor,
    industry: row.industry,
    prospectusUrl: row.prospectusUrl,
    status: row.status,
    advice: row.advice,
    verdict: row.verdict,
    verdictReason: row.verdictReason,
    suggestedShares: row.suggestedShares,
    winProbability: row.winProbability,
    expectedReturn: row.expectedReturn,
    confidence: row.confidence,
    qualityScore: row.qualityScore,
    adviceAt: row.adviceAt,
    adviceRunId: row.adviceRunId,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    subscription: subscription ? toIpoSubscription(subscription) : null,
  };
}

export function toIpoSubscription(row: IpoSubscriptionRow): IpoSubscription {
  return {
    id: row.id,
    offerUid: row.offerUid,
    market: row.market,
    code: row.code,
    name: row.name,
    status: row.status,
    appliedShares: row.appliedShares,
    allottedShares: row.allottedShares,
    price: row.price,
    fee: row.fee,
    currency: row.currency,
    appliedAt: row.appliedAt,
    allottedAt: row.allottedAt,
    assetId: row.assetId,
    transactionId: row.transactionId,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/* ─────────────────────── 备份：DTO ⇄ 落库行的往返映射 ─────────────────────── */

/** `BackupPayload.ipoOffers[i]` → `ipo_offers` 一行（宽松校验，坏条目由调用方丢弃）。 */
export function toIpoOfferRow(dto: IpoOffer, fallbackUpdatedAt = nowIso()): IpoOfferRow {
  const code = String(dto.code ?? '').trim();
  const subscribeCode = String(dto.subscribeCode ?? '').trim();
  return {
    id: String(dto.id ?? ''),
    uid: String(dto.uid ?? '') || ipoUid(dto.market, code, subscribeCode),
    market: dto.market,
    code,
    subscribeCode,
    name: String(dto.name ?? ''),
    source: String(dto.source ?? 'manual'),
    exchange: String(dto.exchange ?? ''),
    board: String(dto.board ?? ''),
    issuePrice: toNumber(dto.issuePrice),
    priceLow: toNumber(dto.priceLow),
    priceHigh: toNumber(dto.priceHigh),
    currency: String(dto.currency ?? MARKET_CURRENCY[dto.market] ?? 'CNY'),
    lotSize: toNumber(dto.lotSize),
    maxShares: toNumber(dto.maxShares),
    subscribeStart: normalizeDate(dto.subscribeStart),
    subscribeEnd: normalizeDate(dto.subscribeEnd),
    allotmentDate: normalizeDate(dto.allotmentDate),
    listingDate: normalizeDate(dto.listingDate),
    issueShares: toNumber(dto.issueShares),
    raiseAmount: toNumber(dto.raiseAmount),
    issuePe: toNumber(dto.issuePe),
    industryPe: toNumber(dto.industryPe),
    winningRate: toNumber(dto.winningRate),
    oversubscribe: toNumber(dto.oversubscribe),
    sponsor: String(dto.sponsor ?? ''),
    industry: String(dto.industry ?? ''),
    prospectusUrl: String(dto.prospectusUrl ?? ''),
    status: (dto.status ?? 'unknown') as IpoMarketStatus,
    advice: String(dto.advice ?? ''),
    verdict: (dto.verdict ?? null) as IpoAdviceVerdict | null,
    verdictReason: String(dto.verdictReason ?? ''),
    suggestedShares: toNumber(dto.suggestedShares),
    winProbability: toNumber(dto.winProbability),
    expectedReturn: toNumber(dto.expectedReturn),
    confidence: toNumber(dto.confidence),
    qualityScore: toNumber(dto.qualityScore),
    adviceAt: dto.adviceAt ?? null,
    adviceRunId: dto.adviceRunId ?? null,
    note: String(dto.note ?? ''),
    createdAt: String(dto.createdAt ?? fallbackUpdatedAt),
    updatedAt: String(dto.updatedAt ?? fallbackUpdatedAt),
  };
}

/** `BackupPayload.ipoSubscriptions[i]` → `ipo_subscriptions` 一行。 */
export function toIpoSubscriptionRow(dto: IpoSubscription): NewIpoSubscription {
  return {
    id: String(dto.id ?? ''),
    offerUid: String(dto.offerUid ?? ''),
    market: dto.market,
    code: String(dto.code ?? ''),
    name: String(dto.name ?? ''),
    status: dto.status ?? 'applied',
    appliedShares: toNumber(dto.appliedShares),
    allottedShares: toNumber(dto.allottedShares),
    price: toNumber(dto.price),
    fee: toNumber(dto.fee),
    currency: String(dto.currency ?? MARKET_CURRENCY[dto.market] ?? 'CNY'),
    appliedAt: String(dto.appliedAt ?? localDate()),
    allottedAt: dto.allottedAt ?? null,
    assetId: dto.assetId ?? null,
    transactionId: dto.transactionId ?? null,
    note: String(dto.note ?? ''),
    createdAt: String(dto.createdAt ?? nowIso()),
  };
}

/* ────────────────────────────── 查询（列表 / 详情） ───────────────────────── */

export function listIpoPayload(
  repo: Repo,
  filter: { market?: Market; status?: IpoMarketStatus; q?: string; limit?: number } = {},
): IpoListResponse {
  const subs = new Map(repo.listIpoSubscriptions().map((row) => [row.offerUid, row]));
  const rows = repo.listIpoOffers({ market: filter.market, status: filter.status, limit: filter.limit });
  const items = rows
    .map((row) => toIpoOffer(row, subs.get(row.uid) ?? null))
    .filter((item) => (filter.q ? matches(item, filter.q) : true));

  const counts = {
    total: items.length,
    CN: items.filter((item) => item.market === 'CN').length,
    HK: items.filter((item) => item.market === 'HK').length,
    US: items.filter((item) => item.market === 'US').length,
    subscribing: items.filter((item) => item.status === 'subscribing').length,
    applied: items.filter((item) => item.subscription !== null).length,
    allotted: items.filter((item) => item.subscription?.status === 'allotted').length,
  };

  return {
    items,
    total: items.length,
    counts,
    lastRefreshAt: repo.getKv('ipo.lastRefreshAt') ?? null,
    warnings: parseWarnings(repo.getKv('ipo.lastRefreshWarnings')),
  };
}

function matches(item: IpoOffer, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [item.name, item.code, item.subscribeCode, item.industry, item.sponsor, item.exchange]
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .some((value) => value.toLowerCase().includes(needle));
}

function parseWarnings(text: string | undefined): string[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** 详情：找不到抛 404（路由直接用）。 */
export function requireIpoOffer(repo: Repo, idOrUid: string): IpoOfferRow {
  const row = repo.getIpoOffer(idOrUid) ?? repo.findIpoOfferByUid(idOrUid);
  if (!row) throw notFound(`新股不存在：${idOrUid}`);
  return row;
}

export function ipoOfferDetail(repo: Repo, idOrUid: string): IpoOffer {
  const row = requireIpoOffer(repo, idOrUid);
  return toIpoOffer(row, repo.getIpoSubscription(row.uid) ?? null);
}

/* ──────────────────────────────── 刷新汇总 ───────────────────────────────── */

export interface IpoRefreshOptions {
  markets?: Market[];
  /** 上游返回的最大条数（默认 60/市场，见 shared 常量）。 */
  limitPerMarket?: number;
  /** 注入点：测试可传假的收集器，避免真实网络。 */
  collect?: typeof collectIpoOffers;
}

/**
 * 从公开数据源收集新股并落库。
 *
 * 幂等：同一只新股重复刷新只会更新字段（按 uid），不会重复插入；
 * 上游没给到的字段**不会**清空已有值（避免一次上游降级把发行价/上市日抹成 0），
 * 人工备注与 AI 结论永远不会被刷新覆盖。
 */
export async function refreshIpoOffers(repo: Repo, options: IpoRefreshOptions = {}): Promise<IpoRefreshResult> {
  const collect = options.collect ?? collectIpoOffers;
  const markets = options.markets && options.markets.length > 0 ? options.markets : (['CN', 'HK', 'US'] as Market[]);
  const limitPerMarket = Math.max(1, Math.min(options.limitPerMarket ?? IPO_REFRESH_MAX_PER_MARKET, 500));

  const collected = await collect({ markets, limitPerMarket });
  const seen = new Set<string>();
  let inserted = 0;
  let updated = 0;

  repo.transaction(() => {
    for (const draft of collected.offers) {
      const uid = ipoUid(draft.market, draft.code, draft.subscribeCode);
      if (seen.has(uid)) continue;
      seen.add(uid);
      const existing = repo.findIpoOfferByUid(uid);
      if (!existing) {
        repo.createIpoOffer(draftToNew(draft, uid));
        inserted += 1;
        continue;
      }
      repo.updateIpoOffer(existing.id, mergeDraft(existing, draft));
      updated += 1;
    }

    // 阶段推进：即使某个市场今天没刷新，已存行的日期也会让状态自然迁移
    // （申购中 → 待上市 → 已上市），否则列表会永远停在旧状态。
    const today = localDate();
    for (const row of repo.listIpoOffers({})) {
      const next = deriveIpoStatus(row, today);
      if (next !== row.status) repo.updateIpoOffer(row.id, { status: next });
    }

    repo.setKv('ipo.lastRefreshAt', nowIso());
    repo.setKv('ipo.lastRefreshWarnings', JSON.stringify(collected.warnings.slice(0, 20)));
  });

  return {
    fetched: collected.offers.length,
    inserted,
    updated,
    byMarket: collected.byMarket,
    sources: collected.sources,
    warnings: collected.warnings,
    refreshedAt: nowIso(),
  };
}

function draftToNew(draft: IpoOfferDraft, uid: string): NewIpoOffer {
  return {
    id: crypto.randomUUID(),
    uid,
    market: draft.market,
    code: draft.code,
    subscribeCode: draft.subscribeCode,
    name: draft.name,
    source: draft.source,
    exchange: draft.exchange,
    board: draft.board,
    issuePrice: draft.issuePrice,
    priceLow: draft.priceLow,
    priceHigh: draft.priceHigh,
    currency: draft.currency || MARKET_CURRENCY[draft.market],
    lotSize: draft.lotSize,
    maxShares: draft.maxShares,
    subscribeStart: draft.subscribeStart,
    subscribeEnd: draft.subscribeEnd,
    allotmentDate: draft.allotmentDate,
    listingDate: draft.listingDate,
    issueShares: draft.issueShares,
    raiseAmount: draft.raiseAmount,
    issuePe: draft.issuePe,
    industryPe: draft.industryPe,
    winningRate: draft.winningRate,
    oversubscribe: draft.oversubscribe,
    sponsor: draft.sponsor,
    industry: draft.industry,
    prospectusUrl: draft.prospectusUrl,
    status: deriveIpoStatus(draft),
  };
}

/**
 * 上游草稿 → 已有行的补丁。
 *
 * 规则：**上游有值才覆盖**。`0` / 空串在上游语境里几乎总是「今天没给」而不是「真的变成 0」
 * （例如上市后发行价字段被清空），所以只 merge 非空值；`advice/verdict/note/qualityScore`
 * 属于本地结论，永不参与合并。
 */
function mergeDraft(existing: IpoOfferRow, draft: IpoOfferDraft) {
  const text = (value: string, fallback: string): string => (value.trim() !== '' ? value : fallback);
  const number = (value: number, fallback: number): number => (Number.isFinite(value) && value !== 0 ? value : fallback);
  const date = (value: string | null, fallback: string | null): string | null =>
    value && value.trim() !== '' ? value : fallback;

  return {
    code: text(draft.code, existing.code),
    subscribeCode: text(draft.subscribeCode, existing.subscribeCode),
    name: text(draft.name, existing.name),
    source: draft.source,
    exchange: text(draft.exchange, existing.exchange),
    board: text(draft.board, existing.board),
    issuePrice: number(draft.issuePrice, existing.issuePrice),
    priceLow: number(draft.priceLow, existing.priceLow),
    priceHigh: number(draft.priceHigh, existing.priceHigh),
    currency: text(draft.currency, existing.currency),
    lotSize: number(draft.lotSize, existing.lotSize),
    maxShares: number(draft.maxShares, existing.maxShares),
    subscribeStart: date(draft.subscribeStart, existing.subscribeStart),
    subscribeEnd: date(draft.subscribeEnd, existing.subscribeEnd),
    allotmentDate: date(draft.allotmentDate, existing.allotmentDate),
    listingDate: date(draft.listingDate, existing.listingDate),
    issueShares: number(draft.issueShares, existing.issueShares),
    raiseAmount: number(draft.raiseAmount, existing.raiseAmount),
    issuePe: number(draft.issuePe, existing.issuePe),
    industryPe: number(draft.industryPe, existing.industryPe),
    winningRate: number(draft.winningRate, existing.winningRate),
    oversubscribe: number(draft.oversubscribe, existing.oversubscribe),
    sponsor: text(draft.sponsor, existing.sponsor),
    industry: text(draft.industry, existing.industry),
    prospectusUrl: text(draft.prospectusUrl, existing.prospectusUrl),
    status: deriveIpoStatus({
      subscribeStart: date(draft.subscribeStart, existing.subscribeStart),
      subscribeEnd: date(draft.subscribeEnd, existing.subscribeEnd),
      allotmentDate: date(draft.allotmentDate, existing.allotmentDate),
      listingDate: date(draft.listingDate, existing.listingDate),
    }),
  };
}

/* ────────────────────────────── 人工录入 ─────────────────────────────────── */

/** 手动录入 / 修正一只新股（上游缺数据时的兜底，`source='manual'`）。 */
export function upsertManualIpoOffer(repo: Repo, input: IpoUpsertInput): IpoOffer {
  const code = input.code.trim();
  const name = input.name.trim();
  if (!code) throw new AppError(400, 'BAD_REQUEST', '新股代码不能为空');
  if (!name) throw new AppError(400, 'BAD_REQUEST', '新股名称不能为空');
  const uid = ipoUid(input.market, code, input.subscribeCode ?? '');
  const payload = {
    market: input.market,
    code,
    subscribeCode: input.subscribeCode ?? '',
    name,
    source: 'manual',
    exchange: input.exchange ?? '',
    board: input.board ?? '',
    issuePrice: toNumber(input.issuePrice),
    priceLow: toNumber(input.priceLow),
    priceHigh: toNumber(input.priceHigh),
    currency: MARKET_CURRENCY[input.market],
    lotSize: toNumber(input.lotSize),
    maxShares: toNumber(input.maxShares),
    subscribeStart: normalizeDate(input.subscribeStart),
    subscribeEnd: normalizeDate(input.subscribeEnd),
    allotmentDate: normalizeDate(input.allotmentDate),
    listingDate: normalizeDate(input.listingDate),
    issuePe: toNumber(input.issuePe),
    industryPe: toNumber(input.industryPe),
    winningRate: toNumber(input.winningRate),
    sponsor: input.sponsor ?? '',
    industry: input.industry ?? '',
    prospectusUrl: input.prospectusUrl ?? '',
    status: deriveIpoStatus({
      subscribeStart: normalizeDate(input.subscribeStart),
      subscribeEnd: normalizeDate(input.subscribeEnd),
      allotmentDate: normalizeDate(input.allotmentDate),
      listingDate: normalizeDate(input.listingDate),
    }),
  };

  const row = repo.transaction(() => {
    const existing = repo.findIpoOfferByUid(uid);
    if (existing) {
      const updated = repo.updateIpoOffer(existing.id, {
        ...payload,
        note: input.note === undefined ? existing.note : input.note,
      });
      if (!updated) throw notFound(`新股不存在：${uid}`);
      return updated;
    }
    return repo.createIpoOffer({
      id: crypto.randomUUID(),
      uid,
      ...payload,
      note: input.note ?? '',
    });
  });
  return toIpoOffer(row, repo.getIpoSubscription(uid) ?? null);
}

/* ───────────────────────────── 我的申购登记 ─────────────────────────────── */

/** 登记「我申购了 N 股」（可重复调用，覆盖上一次的股数）。 */
export function subscribeIpo(repo: Repo, idOrUid: string, input: IpoSubscribeInput): IpoOffer {
  const offer = requireIpoOffer(repo, idOrUid);
  const shares = toNumber(input.shares);
  if (!(shares > 0)) throw new AppError(400, 'BAD_REQUEST', '申购股数必须大于 0');
  if (offer.status === 'listed') {
    throw conflict(`${offer.name} 已上市，无法登记申购（可直接用「我的资产 →添加资产」补录成交）`);
  }
  if (offer.maxShares > 0 && shares > offer.maxShares) {
    throw conflict(`申购股数 ${shares} 超过该新股的申购上限 ${offer.maxShares} 股`, {
      shares,
      maxShares: offer.maxShares,
    });
  }
  const price = toNumber(input.price) > 0 ? toNumber(input.price) : offer.issuePrice;
  const appliedAt = normalizeDate(input.appliedAt) ?? localDate();

  repo.upsertIpoSubscription({
    id: crypto.randomUUID(),
    offerUid: offer.uid,
    market: offer.market,
    code: offer.code || offer.subscribeCode,
    name: offer.name,
    // 已经中签的记录不会因为「再登记一次申购」被打回 applied。
    status: repo.getIpoSubscription(offer.uid)?.status === 'allotted' ? 'allotted' : 'applied',
    appliedShares: shares,
    price,
    currency: offer.currency,
    appliedAt,
    note: input.note,
    allottedAt: undefined,
  });

  return ipoOfferDetail(repo, offer.id);
}

/** 删除申购登记（已入账的记录必须先撤销入账，避免账本里留下无来源的持仓）。 */
/**
 * 撤销「我申购了」登记。
 *
 * 只删登记、不动账本；已经中签入账的必须先处理资产（否则账本会无缘无故少一笔持仓）。
 * 返回最新的详情，界面据此原地刷新（与 `subscribe`/`recordIpoAllotment` 的返回口径一致）。
 */
export function removeIpoSubscription(repo: Repo, idOrUid: string): IpoOffer {
  const offer = requireIpoOffer(repo, idOrUid);
  const sub = repo.getIpoSubscription(offer.uid);
  if (!sub) throw notFound(`该新股还没有申购登记：${offer.name}`);
  if (sub.assetId) {
    throw conflict('该新股已经中签入账，请先在「我的资产」里删除对应交易与资产，再撤销登记');
  }
  repo.deleteIpoSubscription(sub.id);
  return ipoOfferDetail(repo, offer.id);
}

/* ───────────────────────────── 中签 → 自动入账 ───────────────────────────── */

/**
 * 登记中签结果并把中签股数**自动写入账本**。
 *
 * 关键约束：
 *  - `shares = 0` → 记「未中签」，不写账本；若此前已入账则拒绝（要求先撤销）。
 *  - `shares > 0` → 建/复用资产 + 写买入流水（`source='ipo'`），并做账本一致性重放校验。
 *  - 重复入账 = 修正：删除上一次由本流程写入的流水后重写（有后续卖出则拒绝）。
 */
export function recordIpoAllotment(repo: Repo, idOrUid: string, input: IpoAllotInput): IpoAllotResult {
  const offer = requireIpoOffer(repo, idOrUid);
  const existing = repo.getIpoSubscription(offer.uid);
  const shares = toNumber(input.shares);
  if (shares < 0) throw new AppError(400, 'BAD_REQUEST', '中签股数不能为负数');
  const tradeDate = normalizeDate(input.tradeDate) ?? localDate();
  const warnings: string[] = [];

  if (shares === 0) {
    if (existing?.assetId) {
      throw conflict(
        '该新股此前已按中签入账，无法直接改成「未中签」。请在「我的资产」中删除对应交易与资产后重试。',
      );
    }
    repo.upsertIpoSubscription({
      id: crypto.randomUUID(),
      offerUid: offer.uid,
      market: offer.market,
      code: offer.code || offer.subscribeCode,
      name: offer.name,
      status: 'missed',
      appliedShares: existing?.appliedShares ?? 0,
      allottedShares: 0,
      price: existing?.price ?? offer.issuePrice,
      currency: offer.currency,
      appliedAt: existing?.appliedAt ?? localDate(),
      allottedAt: tradeDate,
      note: input.note ?? existing?.note ?? '',
    });
    return { offer: ipoOfferDetail(repo, offer.id), asset: null, assetCreated: false, warnings };
  }

  const price = toNumber(input.price) > 0 ? toNumber(input.price) : offer.issuePrice;
  if (!(price > 0)) {
    throw new AppError(
      400,
      'BAD_REQUEST',
      `该新股还没有发行价（可能尚未定价），请填写实际缴款单价后重试。`,
    );
  }
  const fee = Math.max(0, toNumber(input.fee));
  const code = (offer.code || offer.subscribeCode).trim();
  if (!code) throw new AppError(400, 'BAD_REQUEST', '该新股没有可用代码，无法写入资产');
  const currency = offer.currency || MARKET_CURRENCY[offer.market];
  const now = nowIso();

  const result = repo.transaction(() => {
    const existingAsset = repo.findAsset(code, offer.market, 'stock');
    const asset: AssetRow = existingAsset
      ? existingAsset
      : repo.createAsset({
          id: crypto.randomUUID(),
          name: offer.name || code,
          code,
          market: offer.market,
          type: 'stock',
          source: 'manual',
          currency,
          note: `打新中签入账（${offer.name}）`,
          price,
          priceAt: now,
          prevClose: price,
          dayChangePct: 0,
          spark: [],
          createdAt: now,
        });

    // 修正上一次由打新流程写入的流水（如果有），避免持仓被累加两次。
    const previousTxId = existing?.transactionId ?? null;
    let replaced = false;
    if (previousTxId) {
      const previous = repo.getTransaction(previousTxId);
      if (previous && previous.assetId === asset.id) {
        // 删除前重放校验：若期间已卖出，删掉这笔买入会让账本出现「没有对应买入的卖出」。
        const deficit = findLedgerDeficit(repo.listTransactions(asset.id).filter((tx) => tx.id !== previousTxId));
        if (deficit) {
          throw conflict(
            `该新股已有后续卖出记录（${deficit.tradeDate} 卖出 ${deficit.shares} 股），无法直接修正中签股数；` +
              `请先在「我的资产」里手工调整交易。`,
            { tradeDate: deficit.tradeDate, shares: deficit.shares, available: deficit.available },
          );
        }
        repo.deleteTransaction(previousTxId);
        replaced = true;
      }
    }

    const txId = crypto.randomUUID();
    repo.addTransaction({
      id: txId,
      assetId: asset.id,
      kind: 'buy',
      shares,
      price,
      fee,
      tradeDate,
      note:
        input.note ??
        `打新中签 ${shares} 股（${offer.market} ${code}${offer.subscribeCode && offer.subscribeCode !== code ? ` 申购代码 ${offer.subscribeCode}` : ''}）`,
      source: 'ipo',
      createdAt: now,
    });

    repo.upsertIpoSubscription({
      id: crypto.randomUUID(),
      offerUid: offer.uid,
      market: offer.market,
      code,
      name: offer.name,
      status: 'allotted',
      appliedShares: existing?.appliedShares ?? 0,
      allottedShares: shares,
      price,
      fee,
      currency,
      appliedAt: existing?.appliedAt ?? tradeDate,
      allottedAt: tradeDate,
      assetId: asset.id,
      transactionId: txId,
      note: input.note ?? existing?.note ?? '',
    });

    const refreshed = repo.getAsset(asset.id);
    if (!refreshed) throw notFound(`资产写入后未找到：${asset.id}`);
    return { asset: toAssetDetail(refreshed, repo.listTransactions(refreshed.id)), created: !existingAsset, replaced };
  });

  // 预算提示（不阻断）：中签缴款是真实现金支出，账必须记，只在超出当月预算时提醒。
  const budget = computeBudgetStatus(repo.listAssets(), repo.listTransactions(), repo.getSettings().budget);
  const market = budget.markets.find((item) => item.market === offer.market);
  if (market && market.budget > 0 && shares * price + fee > market.remaining) {
    warnings.push(
      `本次缴款 ${round4(shares * price + fee)} ${market.currency} 超出该市场当月预算剩余 ` +
        `${market.remaining} ${market.currency}（预算是 AI 买入建议的约束，不影响中签入账）`,
    );
  }
  if (result.replaced) warnings.push('已用新的中签股数覆盖上一次由打新流程写入的买入流水');

  return {
    offer: ipoOfferDetail(repo, offer.id),
    asset: result.asset,
    assetCreated: result.created,
    warnings,
  };
}