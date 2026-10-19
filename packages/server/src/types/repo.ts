/**
 * Repository seam — the ONLY way routes/services/agent touch persistence.
 *
 * Owned by: Lead (frozen contract). Implemented by `server-core` in
 * `../db/repo.ts` (SQLite via built-in `node:sqlite`).
 * Implementations must be synchronous and transaction-safe; callers may treat
 * every method as throwing on unexpected DB errors.
 */
import type {
  AdviceOutcomeStatus,
  AdviceStatus,
  AgentRunKind,
  AgentRunStatus,
  ClearDataResult,
  Creator,
  ImportMode,
  ImportResult,
  IpoMarketStatus,
  Market,
  OptionMarket,
  OptionPositionStatus,
  OptionSettlementStatus,
  PendingWriteStatus,
  ToolRisk,
  WatchItemStatus,
} from '@aia/shared';
import type {
  AdviceOutcomeRow,
  AdviceRow,
  AssetPatch,
  AssetRow,
  AuditRow,
  ChatMessageRow,
  ChatSessionRow,
  IpoOfferPatch,
  IpoOfferRow,
  IpoSubscriptionRow,
  NewAdvice,
  NewAsset,
  NewIpoOffer,
  NewIpoSubscription,
  NewOptionContract,
  NewOptionSettlement,
  NewStep,
  NewTx,
  NewWatch,
  OptionContractPatch,
  OptionContractRow,
  OptionSettlementPatch,
  OptionSettlementRow,
  PendingWriteRow,
  RunMessageRow,
  RunRow,
  StepRow,
  StoredSettings,
  TxRow,
  WatchPatch,
  WatchRow,
} from './models.js';

export interface ExportBundle {
  assets: AssetRow[];
  transactions: TxRow[];
  watchlist: WatchRow[];
  advice: AdviceRow[];
  /** 新股打新：标的 + 我的申购记录（老备份缺失时按空数组处理）。 */
  ipoOffers: IpoOfferRow[];
  ipoSubscriptions: IpoSubscriptionRow[];
  /** 期权卖权：卖出的合约 + 到期结算记录（老备份缺失时按空数组处理）。 */
  optionContracts: OptionContractRow[];
  optionSettlements: OptionSettlementRow[];
}

/** 自选池筛选：`all` 用于 prompt / 备份 / 计数，其余用于列表展示。 */
export type WatchlistStatusFilter = WatchItemStatus | 'all';

/**
 * Settings patch with *nested* partials.
 *
 * `Partial<StoredSettings>` alone would force callers to pass a complete
 * `LlmConfig`/`DataSourceConfig` whenever they touch one field, so each nested
 * group is explicitly deep-partial here.
 */
export interface SettingsPatch {
  persona?: StoredSettings['persona'];
  reportStyle?: StoredSettings['reportStyle'];
  llm?: Partial<StoredSettings['llm']>;
  dataSources?: { [K in keyof StoredSettings['dataSources']]?: Partial<StoredSettings['dataSources'][K]> };
  budget?: Partial<StoredSettings['budget']>;
  /** 定时任务：整体替换（数组；空数组 = 不排程）。 */
  schedules?: StoredSettings['schedules'];
  enforceBudget?: boolean;
  watchlistCandidateLimit?: number;
  /** P3 淘汰机制：连续确认退役多少次后才真正删除（0 = 只标记不删除）。 */
  watchlistRetireDeleteRuns?: number;
  /** P1-1: tool policy (deny list + write-approval mode). */
  toolPolicy?: Partial<StoredSettings['toolPolicy']>;
  /** P1-2: MCP servers (replaced wholesale when provided). */
  mcpServers?: StoredSettings['mcpServers'];
  /** 期权卖权设置：可用现金（分市场）+ 到期结算模式 + 是否随流水线跑。 */
  option?: Partial<Omit<StoredSettings['option'], 'cash'>> & { cash?: Partial<StoredSettings['option']['cash']> };
  lastRunAt?: string | null;
}

export interface Repo {
  /* ── lifecycle ─────────────────────────────────────────────────────────── */
  /** Creates tables/indexes when missing; never destroys data. */
  migrate(): void;
  /** Runs `fn` inside a single SQLite transaction. */
  transaction<T>(fn: () => T): T;
  /** Closes the underlying database handle. */
  close(): void;

  /* ── settings ──────────────────────────────────────────────────────────── */
  getSettings(): StoredSettings;
  /** Deep-merges the patch into the stored settings and returns the result. */
  saveSettings(patch: SettingsPatch): StoredSettings;

  /* ── assets ────────────────────────────────────────────────────────────── */
  listAssets(): AssetRow[];
  getAsset(id: string): AssetRow | undefined;
  findAsset(code: string, market: string, type: string): AssetRow | undefined;
  createAsset(input: NewAsset): AssetRow;
  updateAsset(id: string, patch: AssetPatch): AssetRow | undefined;
  deleteAsset(id: string): boolean;

  /* ── transactions ──────────────────────────────────────────────────────── */
  listTransactions(assetId?: string): TxRow[];
  getTransaction(id: string): TxRow | undefined;
  addTransaction(input: NewTx): TxRow;
  deleteTransaction(id: string): boolean;

  /* ── watchlist ─────────────────────────────────────────────────────────── */
  /** `status` defaults to `'active'`; pass `'all'` for prompt/backup/counting. */
  listWatchlist(status?: WatchlistStatusFilter): WatchRow[];
  countWatchlist(): { active: number; retired: number };
  getWatchItem(id: string): WatchRow | undefined;
  findWatchItem(code: string, market: string, type: string): WatchRow | undefined;
  createWatchItem(input: NewWatch): WatchRow;
  updateWatchItem(id: string, patch: WatchPatch): WatchRow | undefined;
  deleteWatchItem(id: string): boolean;
  clearWatchlist(): number;

  /* ── advice ────────────────────────────────────────────────────────────── */
  listAdvice(filter?: { status?: AdviceStatus; batchId?: string; limit?: number }): AdviceRow[];
  getAdvice(id: string): AdviceRow | undefined;
  createAdvice(input: NewAdvice): AdviceRow;
  updateAdvice(id: string, patch: Partial<Omit<AdviceRow, 'id'>>): AdviceRow | undefined;
  /** Expires every still-pending advice of an earlier batch. */
  expirePendingAdvice(exceptBatchId?: string): number;

  /* ── advice outcomes（物化结果，可确定性重建） ────────────────────────────── */
  upsertAdviceOutcome(input: AdviceOutcomeRow): AdviceOutcomeRow;
  getAdviceOutcome(adviceId: string): AdviceOutcomeRow | undefined;
  listAdviceOutcomes(filter?: { limit?: number; status?: AdviceOutcomeStatus }): AdviceOutcomeRow[];
  /** 追踪窗口之外的旧结果（用于清理已删除建议的残留）。 */
  deleteAdviceOutcomesForMissingAdvice(): number;

  /* ── 新股打新 (IPO) ────────────────────────────────────────────────────── */
  /**
   * 打新标的列表。默认返回**全部**（含已上市），由调用方按状态/时间过滤：
   * 界面需要看「近期已上市」来复盘，AI 需要看「待申购」来决定打不打。
   */
  listIpoOffers(filter?: { market?: Market; status?: IpoMarketStatus; limit?: number }): IpoOfferRow[];
  getIpoOffer(id: string): IpoOfferRow | undefined;
  /** 按稳定业务键 `market:code` 查（刷新时判断插入还是更新）。 */
  findIpoOfferByUid(uid: string): IpoOfferRow | undefined;
  createIpoOffer(input: NewIpoOffer): IpoOfferRow;
  updateIpoOffer(id: string, patch: IpoOfferPatch): IpoOfferRow | undefined;
  /** 删除标的（同时删除其申购记录，避免悬挂记录）。 */
  deleteIpoOffer(id: string): boolean;
  /** 我的申购记录（一只新股最多一条），按 key 为 offerUid。 */
  listIpoSubscriptions(): IpoSubscriptionRow[];
  getIpoSubscription(offerUid: string): IpoSubscriptionRow | undefined;
  /** 插入或按 `offerUid` 更新（登记申购、录入中签都用它，重复调用收敛到一条）。 */
  upsertIpoSubscription(input: NewIpoSubscription): IpoSubscriptionRow;
  deleteIpoSubscription(id: string): boolean;

  /* ── 期权卖权：卖出的合约与到期结算 ─────────────────────────────────────── */
  /**
   * 卖出合约列表。
   *
   * `status='all'` 用于历史复盘（含已到期/已平仓）；默认按 `opened_at DESC`。
   * `expiringOnOrBefore` 供到期扫描器用（只取 `status='open'` 且到期日已过的）。
   */
  listOptionContracts(filter?: {
    status?: OptionPositionStatus | 'all';
    market?: OptionMarket;
    underlyingAssetId?: string;
    expiringOnOrBefore?: string;
  }): OptionContractRow[];
  getOptionContract(id: string): OptionContractRow | undefined;
  createOptionContract(input: NewOptionContract): OptionContractRow;
  updateOptionContract(id: string, patch: OptionContractPatch): OptionContractRow | undefined;
  deleteOptionContract(id: string): boolean;
  /** 结算记录（一合约一条）。`status='all'` 含已确认/已忽略的历史。 */
  listOptionSettlements(filter?: {
    status?: OptionSettlementStatus | 'all';
    contractId?: string;
    expiry?: string;
  }): OptionSettlementRow[];
  getOptionSettlement(id: string): OptionSettlementRow | undefined;
  findOptionSettlementByContract(contractId: string): OptionSettlementRow | undefined;
  /** 按 `contract_id` 插入或更新：重复扫描同一天不会产生第二条记录。 */
  upsertOptionSettlement(input: NewOptionSettlement): OptionSettlementRow;
  updateOptionSettlement(id: string, patch: OptionSettlementPatch): OptionSettlementRow | undefined;

  /* ── agent runs ────────────────────────────────────────────────────────── */
  createRun(input: Omit<RunRow, 'finishedAt' | 'summary' | 'error' | 'turns' | 'promptTokens' | 'completionTokens'> & Partial<RunRow>): RunRow;
  updateRun(id: string, patch: Partial<Omit<RunRow, 'id'>>): RunRow | undefined;
  getRun(id: string): RunRow | undefined;
  listRuns(filter?: { limit?: number; kind?: AgentRunKind; status?: AgentRunStatus }): RunRow[];
  /**
   * Boot-time reconciliation: marks every run still `running` as `error`.
   *
   * A run row is only finalised by the loop's own `updateRun`, so a process that
   * dies mid-run (Ctrl-C, crash, container restart) leaves a permanent `running`
   * row. Those zombies used to show up forever as「运行中 / 报错」in the activity
   * list and could be resumed into a transcript that no live worker owns.
   */
  failStaleRuns(reason: string): number;
  listSteps(runId: string): StepRow[];
  addStep(input: NewStep): StepRow;
  updateStep(id: string, patch: Partial<Omit<StepRow, 'id' | 'runId'>>): StepRow | undefined;

  /* ── chat ──────────────────────────────────────────────────────────────── */
  listSessions(): ChatSessionRow[];
  getSession(id: string): ChatSessionRow | undefined;
  createSession(id: string, title: string, createdAt: string): ChatSessionRow;
  touchSession(id: string, title?: string): void;
  deleteSession(id: string): boolean;
  listMessages(sessionId: string): ChatMessageRow[];
  addMessage(input: ChatMessageRow): ChatMessageRow;

  /* ── key/value cache (FX rates, latest briefing pointer, …) ────────────── */
  getKv(key: string): string | undefined;
  setKv(key: string, value: string): void;

  /* ── backup ────────────────────────────────────────────────────────────── */
  exportAll(): ExportBundle;
  importAll(bundle: ExportBundle, mode: ImportMode): ImportResult;
  /**
   * 一键清除：业务数据 + AI 历史 + 缓存，单个事务内完成，返回逐表删除行数。
   * `keepSettings` 默认 `true`（保留 AI 配置与 API Key）；显式传 `false` 时
   * 设置恢复为出厂默认。
   */
  clearAllData(options?: { keepSettings?: boolean }): ClearDataResult;
  /** 设置恢复为出厂默认（含清空 LLM / 数据源 Key、关闭定时任务）。 */
  resetSettings(): StoredSettings;

  /* ── helpers used by portfolio math ────────────────────────────────────── */
  /** Distinct (market) list of currently held instruments, for price refresh. */
  listOpenAssetIds(): string[];
  countCreator(creator: Creator): number;

  /* ── P1-1 audit trail ──────────────────────────────────────────────────── */
  addAudit(entry: AuditRow): AuditRow;
  listAudit(filter?: { limit?: number; runId?: string; risk?: ToolRisk; outcome?: AuditRow['outcome'] }): AuditRow[];

  /* ── P1-1 pending writes (approval mode) ───────────────────────────────── */
  addPendingWrite(input: PendingWriteRow): PendingWriteRow;
  getPendingWrite(id: string): PendingWriteRow | undefined;
  listPendingWrites(status?: PendingWriteStatus, limit?: number): PendingWriteRow[];
  /** D5: filter by run **in SQL**, so a busy table cannot hide an old run's rows. */
  listPendingWritesByRun(runId: string, limit?: number): PendingWriteRow[];
  updatePendingWrite(
    id: string,
    patch: Partial<Pick<PendingWriteRow, 'status' | 'decidedAt' | 'result' | 'summary'>>,
  ): PendingWriteRow | undefined;

  /* ── P1-3 run message transcript (resume + replay) ─────────────────────── */
  addRunMessage(input: RunMessageRow): RunMessageRow;
  listRunMessages(runId: string): RunMessageRow[];
  countRunMessages(runId: string): number;
  /** D7: drops transcripts/steps/audit of all but the newest `keepRuns` runs. */
  pruneRunData(keepRuns?: number): number;
}

/** Alias kept for readability in route modules. */
export type { AssetRow, TxRow, WatchRow, AdviceRow, AdviceOutcomeRow, RunRow, StepRow, IpoOfferRow, IpoSubscriptionRow };
