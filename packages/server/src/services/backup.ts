/**
 * Backup export / import / on-disk snapshots (docs/API.md §10).
 *
 * Owner: server-core.
 *
 * `BackupPayload` is the frozen wire shape; the repository stores richer rows
 * (`AssetRow`), so the mapping in both directions lives here. The export NEVER
 * contains `llm.apiKey` — only `hasApiKey` / `apiKeyMasked` metadata. Importing
 * restores the non-secret settings and never touches the stored API key.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  APP_VERSION,
  type AssetSummary,
  type BackupPayload,
  type ImportMode,
  type ImportResult,
  type LlmConfig,
  type Settings,
  type Transaction,
} from '@aia/shared';

import { badRequest, notFound } from '../errors.js';
import type { ExportBundle, Repo, SettingsPatch } from '../types/repo.js';
import type { AdviceRow, AssetRow, RunRow, StoredSettings, TxRow, WatchRow } from '../types/models.js';
import { maskApiKey, maskDataSourceConfig, nowIso, round4, safeMessage, settingsPatch, toNumber } from '../db/util.js';
import { toAdviceItem, toAssetSummary, toRunSummary, toTransaction, toWatchItem } from './portfolio.js';

export const BACKUP_SCHEMA = 'ai-investment-advisor/backup' as const;
export const BACKUP_VERSION = 1;

export interface BackupSnapshotFile {
  name: string;
  size: number;
  createdAt: string;
}

/* ────────────────────────────────── export ────────────────────────────────── */

export function buildBackupPayload(
  repo: Repo,
  options: { appVersion?: string; exportedAt?: string; includeSettings?: boolean } = {},
): BackupPayload {
  const bundle = repo.exportAll();
  const byAsset = new Map<string, TxRow[]>();
  for (const tx of bundle.transactions) {
    const list = byAsset.get(tx.assetId);
    if (list) list.push(tx);
    else byAsset.set(tx.assetId, [tx]);
  }

  const payload: BackupPayload = {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    exportedAt: options.exportedAt ?? nowIso(),
    appVersion: options.appVersion ?? APP_VERSION,
    assets: bundle.assets.map((asset) => toAssetSummary(asset, byAsset.get(asset.id) ?? [])),
    transactions: bundle.transactions.map(toTransaction),
    watchlist: bundle.watchlist.map(toWatchItem),
    advice: bundle.advice.map(toAdviceItem),
  };

  try {
    payload.runs = repo.listRuns().map((run: RunRow) => toRunSummary(run, repo.listSteps(run.id).length));
  } catch {
    payload.runs = [];
  }

  if (options.includeSettings !== false) {
    try {
      payload.settings = settingsForBackup(repo.getSettings());
    } catch {
      /* settings are optional in the payload */
    }
  }

  return payload;
}

/** `Settings` minus the LLM secret (only the mask travels). */
export function settingsForBackup(stored: StoredSettings): NonNullable<BackupPayload['settings']> {
  const { apiKey: _apiKey, ...llm } = stored.llm;
  return {
    persona: stored.persona,
    reportStyle: stored.reportStyle,
    llm,
    hasApiKey: stored.llm.apiKey.trim() !== '',
    apiKeyMasked: maskApiKey(stored.llm.apiKey),
    // Secret-free: each slot exposes only provider/enabled + hasApiKey/apiKeyMasked.
    dataSources: maskDataSourceConfig(stored.dataSources),
    budget: stored.budget,
    schedule: stored.schedule,
    enforceBudget: stored.enforceBudget,
    watchlistCandidateLimit: stored.watchlistCandidateLimit,
    watchlistRetireDeleteRuns: stored.watchlistRetireDeleteRuns,
    toolPolicy: stored.toolPolicy,
    // MCP `env` often carries tokens: keep the server list, drop the values.
    mcpServers: stored.mcpServers.map((server) => ({
      ...server,
      env: Object.fromEntries(Object.keys(server.env ?? {}).map((key) => [key, ''])),
    })),
    updatedAt: stored.updatedAt,
  };
}

/* ────────────────────────────────── import ────────────────────────────────── */

const MARKETS = new Set(['CN', 'HK', 'US']);
const TYPES = new Set(['stock', 'etf', 'fund']);
const CREATORS = new Set(['manual', 'ai']);
const TX_KINDS = new Set(['buy', 'sell']);
const TX_SOURCES = new Set(['manual', 'ai', 'advice']);
const ACTIONS = new Set(['buy', 'sell']);
const STATUSES = new Set(['pending', 'confirmed', 'rejected', 'expired']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Lenient structural validation: unknown extra fields are ignored. */
export function validateBackupPayload(input: unknown): BackupPayload {
  if (!isRecord(input)) throw badRequest('备份数据无效：应为 JSON 对象');
  const raw = input as Record<string, unknown>;

  if (raw.schema !== undefined && raw.schema !== BACKUP_SCHEMA) {
    throw badRequest(`备份数据无效：schema 应为 ${BACKUP_SCHEMA}`, { schema: raw.schema });
  }
  for (const key of ['assets', 'transactions', 'watchlist', 'advice'] as const) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) {
      throw badRequest(`备份数据无效：${key} 应为数组`);
    }
  }

  const version = toNumber(raw.version, BACKUP_VERSION);
  return {
    schema: BACKUP_SCHEMA,
    version: Number.isFinite(version) && version > 0 ? Math.trunc(version) : BACKUP_VERSION,
    exportedAt: typeof raw.exportedAt === 'string' && raw.exportedAt ? raw.exportedAt : nowIso(),
    appVersion: typeof raw.appVersion === 'string' && raw.appVersion ? raw.appVersion : APP_VERSION,
    assets: (raw.assets ?? []) as AssetSummary[],
    transactions: (raw.transactions ?? []) as Transaction[],
    watchlist: (raw.watchlist ?? []) as BackupPayload['watchlist'],
    advice: (raw.advice ?? []) as BackupPayload['advice'],
    runs: Array.isArray(raw.runs) ? (raw.runs as BackupPayload['runs']) : undefined,
    settings: isRecord(raw.settings) ? (raw.settings as BackupPayload['settings']) : undefined,
  };
}

/** DTO → repository rows (fields the wire contract does not carry are defaults). */
export function toExportBundle(payload: BackupPayload, fallbackUpdatedAt = nowIso()): ExportBundle {
  const assets: AssetRow[] = [];
  for (const item of payload.assets ?? []) {
    if (!isRecord(item)) continue;
    const id = String(item.id ?? '').trim();
    const code = String(item.code ?? '').trim();
    const market = String(item.market ?? '');
    const type = String(item.type ?? '');
    if (!id || !code || !MARKETS.has(market) || !TYPES.has(type)) continue;
    const price = toNumber(item.price);
    const shares = toNumber(item.shares);
    const dayChange = toNumber(item.dayChange);
    // Recover `prevClose` from the day change the summary carries.
    const prevClose = shares > 0 && Number.isFinite(dayChange) ? round4(price - dayChange / shares) : 0;
    assets.push({
      id,
      name: String(item.name ?? code),
      code,
      market: market as AssetRow['market'],
      type: type as AssetRow['type'],
      source: CREATORS.has(String(item.source)) ? (item.source as AssetRow['source']) : 'manual',
      currency: String(item.currency ?? 'CNY'),
      note: String(item.note ?? ''),
      aiSummary: String(item.aiSummary ?? ''),
      aiSummaryAt: (item.aiSummaryAt as string | null) ?? null,
      thesis: '',
      qualityScore: 0,
      targetPrice: 0,
      expectedReturn: 0,
      price,
      priceAt: (item.priceAt as string | null) ?? null,
      prevClose,
      dayChangePct: toNumber(item.dayChangePct),
      spark: Array.isArray(item.spark) ? item.spark.map((n) => toNumber(n)) : [],
      createdAt: String(item.createdAt ?? fallbackUpdatedAt),
      updatedAt: fallbackUpdatedAt,
    });
  }

  const assetIds = new Set(assets.map((asset) => asset.id));
  const transactions: TxRow[] = [];
  for (const item of payload.transactions ?? []) {
    if (!isRecord(item)) continue;
    const id = String(item.id ?? '').trim();
    const assetId = String(item.assetId ?? '').trim();
    const kind = String(item.kind ?? '');
    const tradeDate = String(item.tradeDate ?? '').trim();
    if (!id || !assetIds.has(assetId) || !TX_KINDS.has(kind) || !tradeDate) continue;
    transactions.push({
      id,
      assetId,
      kind: kind as TxRow['kind'],
      shares: toNumber(item.shares),
      price: toNumber(item.price),
      fee: toNumber(item.fee),
      tradeDate,
      note: String(item.note ?? ''),
      source: TX_SOURCES.has(String(item.source)) ? (item.source as TxRow['source']) : 'manual',
      createdAt: String(item.createdAt ?? `${tradeDate}T00:00:00.000Z`),
    });
  }

  const watchlist: WatchRow[] = [];
  for (const item of payload.watchlist ?? []) {
    if (!isRecord(item)) continue;
    const id = String(item.id ?? '').trim();
    const code = String(item.code ?? '').trim();
    const market = String(item.market ?? '');
    const type = String(item.type ?? '');
    if (!id || !code || !MARKETS.has(market) || !TYPES.has(type)) continue;
    const price = toNumber(item.price);
    const dayChangePct = toNumber(item.dayChangePct);
    const prevClose = price > 0 && dayChangePct !== -100 ? round4(price / (1 + dayChangePct / 100)) : 0;
    const createdAt = String(item.createdAt ?? fallbackUpdatedAt);
    watchlist.push({
      id,
      name: String(item.name ?? code),
      code,
      market: market as WatchRow['market'],
      type: type as WatchRow['type'],
      source: CREATORS.has(String(item.source)) ? (item.source as WatchRow['source']) : 'manual',
      qualityScore: toNumber(item.qualityScore),
      targetPrice: toNumber(item.targetPrice),
      expectedReturn: toNumber(item.expectedReturn),
      expectedReturnHorizon: String(item.expectedReturnHorizon ?? ''),
      initialPrice: toNumber(item.initialPrice),
      initialPriceAt: (item.initialPriceAt as string | null) ?? null,
      price,
      priceAt: (item.priceAt as string | null) ?? null,
      prevClose,
      dayChangePct,
      thesis: String(item.thesis ?? ''),
      note: String(item.note ?? ''),
      aiSummary: String(item.aiSummary ?? ''),
      aiSummaryAt: (item.aiSummaryAt as string | null) ?? null,
      spark: Array.isArray(item.spark) ? item.spark.map((n) => toNumber(n)) : [],
      // P3：退役状态随备份往返（缺失时退化为在池）。
      status: String(item.status ?? 'active') === 'retired' ? 'retired' : 'active',
      retiredReason: String(item.retiredReason ?? ''),
      retiredAt: (item.retiredAt as string | null) ?? null,
      retireStreak: Math.max(0, Math.trunc(toNumber(item.retireStreak))),
      createdAt,
      updatedAt: createdAt,
    });
  }

  const advice: AdviceRow[] = [];
  for (const item of payload.advice ?? []) {
    if (!isRecord(item)) continue;
    const id = String(item.id ?? '').trim();
    const market = String(item.market ?? '');
    const type = String(item.type ?? '');
    const action = String(item.action ?? '');
    if (!id || !MARKETS.has(market) || !TYPES.has(type) || !ACTIONS.has(action)) continue;
    const status = String(item.status ?? 'pending');
    advice.push({
      id,
      batchId: String(item.batchId ?? ''),
      assetId: (item.assetId as string | null) ?? null,
      watchItemId: (item.watchItemId as string | null) ?? null,
      assetName: String(item.assetName ?? ''),
      code: String(item.code ?? ''),
      market: market as AdviceRow['market'],
      type: type as AdviceRow['type'],
      action: action as AdviceRow['action'],
      targetShares: toNumber(item.targetShares),
      targetPrice: toNumber(item.targetPrice),
      currency: String(item.currency ?? 'CNY'),
      reason: String(item.reason ?? ''),
      confidence: toNumber(item.confidence),
      status: STATUSES.has(status) ? (status as AdviceRow['status']) : 'pending',
      executedShares: item.executedShares === null || item.executedShares === undefined ? null : toNumber(item.executedShares),
      executedPrice: item.executedPrice === null || item.executedPrice === undefined ? null : toNumber(item.executedPrice),
      createdAt: String(item.createdAt ?? fallbackUpdatedAt),
      decidedAt: (item.decidedAt as string | null) ?? null,
    });
  }

  return { assets, transactions, watchlist, advice };
}

export function importBackupPayload(repo: Repo, input: unknown, mode: ImportMode = 'merge'): ImportResult {
  const payload = validateBackupPayload(input);
  if (mode !== 'merge' && mode !== 'replace') throw badRequest(`导入模式无效：${String(mode)}`);
  const bundle = toExportBundle(payload, payload.exportedAt);
  const result = repo.importAll(bundle, mode);
  applyImportedSettings(repo, payload);
  return result;
}

/** Restores persona/budgets/schedule…; the stored LLM API key is never touched. */
function applyImportedSettings(repo: Repo, payload: BackupPayload): void {
  const imported = payload.settings;
  if (!imported || !isRecord(imported)) return;
  try {
    const patch: SettingsPatch = {};
    const current: Settings = { ...repo.getSettings(), hasApiKey: false, apiKeyMasked: '' } as Settings;
    if (imported.persona !== undefined) patch.persona = imported.persona as StoredSettings['persona'];
    if (imported.reportStyle !== undefined) patch.reportStyle = imported.reportStyle as StoredSettings['reportStyle'];
    if (imported.dataSources !== undefined) {
      patch.dataSources = sanitiseImportedDataSources(imported.dataSources);
    }
    if (imported.budget !== undefined) patch.budget = imported.budget as StoredSettings['budget'];
    if (imported.schedule !== undefined) patch.schedule = imported.schedule as StoredSettings['schedule'];
    if (typeof imported.enforceBudget === 'boolean') patch.enforceBudget = imported.enforceBudget;
    if (typeof imported.watchlistCandidateLimit === 'number') {
      patch.watchlistCandidateLimit = imported.watchlistCandidateLimit;
    }
    if (typeof imported.watchlistRetireDeleteRuns === 'number') {
      patch.watchlistRetireDeleteRuns = imported.watchlistRetireDeleteRuns;
    }
    if (isRecord(imported.llm)) {
      const llm = imported.llm as Omit<LlmConfig, 'apiKey'>;
      patch.llm = {
        baseUrl: typeof llm.baseUrl === 'string' ? llm.baseUrl : current.llm.baseUrl,
        model: typeof llm.model === 'string' ? llm.model : current.llm.model,
        temperature: typeof llm.temperature === 'number' ? llm.temperature : current.llm.temperature,
        maxTokens: typeof llm.maxTokens === 'number' ? llm.maxTokens : current.llm.maxTokens,
        fastModel: typeof llm.fastModel === 'string' ? llm.fastModel : current.llm.fastModel,
        timeoutMs: typeof llm.timeoutMs === 'number' ? llm.timeoutMs : current.llm.timeoutMs,
        contextTokens:
          typeof llm.contextTokens === 'number' ? llm.contextTokens : current.llm.contextTokens,
      };
    }
    if (imported.toolPolicy !== undefined && isRecord(imported.toolPolicy)) {
      const policy = imported.toolPolicy as { deny?: unknown; requireWriteApproval?: unknown };
      patch.toolPolicy = {
        deny: Array.isArray(policy.deny)
          ? policy.deny.filter((name): name is string => typeof name === 'string')
          : current.toolPolicy.deny,
        requireWriteApproval:
          typeof policy.requireWriteApproval === 'boolean'
            ? policy.requireWriteApproval
            : current.toolPolicy.requireWriteApproval,
      };
    }
    if (Array.isArray(imported.mcpServers)) {
      // MCP `env` values are stripped on export, so a restore only recovers shape.
      patch.mcpServers = imported.mcpServers.filter(isRecord) as unknown as StoredSettings['mcpServers'];
    }
    if (Object.keys(patch).length > 0) repo.saveSettings(settingsPatch(patch));
  } catch {
    /* a settings restore failure must not fail the data import */
  }
}

/**
 * Only `provider` / `enabled` travel through an import: a backup never carries
 * slot secrets (and masked metadata must not be persisted as a fake key).
 */
function sanitiseImportedDataSources(value: unknown): StoredSettings['dataSources'] {
  const source = isRecord(value) ? value : {};
  const out: Record<string, unknown> = {};
  for (const [key, slot] of Object.entries(source)) {
    const choice = isRecord(slot) ? slot : {};
    const next: Record<string, unknown> = {
      provider: typeof choice.provider === 'string' ? choice.provider : 'auto',
      enabled: choice.enabled !== false,
    };
    out[key] = next;
  }
  return out as unknown as StoredSettings['dataSources'];
}

/* ──────────────────────────────── snapshots ───────────────────────────────── */

export function ensureBackupDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** `backup-20261014-115300.json` */
export function snapshotName(date: Date = new Date()): string {
  const p = (value: number, width = 2): string => String(value).padStart(width, '0');
  return (
    `backup-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.json`
  );
}

/** Guards against path traversal; only plain `*.json` names inside `dir`. */
export function resolveSnapshotPath(dir: string, name: string): string {
  const file = String(name ?? '').trim();
  if (!/^[A-Za-z0-9._-]+\.json$/.test(file) || file.includes('..')) {
    throw badRequest(`快照文件名无效：${name}`);
  }
  const resolved = path.resolve(dir, file);
  const base = path.resolve(dir);
  if (resolved !== path.join(base, file)) throw badRequest(`快照文件名无效：${name}`);
  return resolved;
}

export function listBackupSnapshots(dir: string): BackupSnapshotFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => {
      const full = path.join(dir, entry.name);
      let size = 0;
      let createdAt = nowIso();
      try {
        const stat = fs.statSync(full);
        size = stat.size;
        createdAt = stat.mtime.toISOString();
      } catch {
        /* unreadable entry: report zeros */
      }
      return { name: entry.name, size, createdAt };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function writeBackupSnapshot(dir: string, payload: BackupPayload, name?: string): BackupSnapshotFile {
  ensureBackupDir(dir);
  const file = name && /^[A-Za-z0-9._-]+\.json$/.test(name) ? name : snapshotName();
  const full = resolveSnapshotPath(dir, file);
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  fs.writeFileSync(full, text, 'utf8');
  return {
    name: file,
    size: Buffer.byteLength(text, 'utf8'),
    createdAt: fs.statSync(full).mtime.toISOString(),
  };
}

export function readBackupSnapshot(dir: string, name: string): string {
  const full = resolveSnapshotPath(dir, name);
  if (!fs.existsSync(full)) throw notFound(`快照不存在：${name}`);
  try {
    return fs.readFileSync(full, 'utf8');
  } catch (error) {
    throw badRequest(`快照读取失败：${safeMessage(error)}`);
  }
}
