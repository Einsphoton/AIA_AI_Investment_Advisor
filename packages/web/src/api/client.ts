/**
 * Typed HTTP client for the backend API. Owner: Lead.
 *
 * Keep this module in sync with docs/API.md — pages should never call `fetch`
 * directly, so that error handling and JSON parsing stay uniform.
 */
import type {
  AdviceItem,
  AdviceOutcomesResponse,
  AdviceOutcomesTrackResponse,
  AgentRun,
  AgentRunSummary,
  AgentTrace,
  AppVersionPayload,
  AssetDetail,
  AssetSummary,
  AuditEntry,
  BackupPayload,
  BudgetStatus,
  ChatMessage,
  ChatSession,
  ClearDataResult,
  ConfirmAdviceInput,
  ConfirmOptionAdviceInput,
  ConfirmOptionAdviceResult,
  CreateAssetInput,
  CreateTransactionInput,
  CreateWatchItemInput,
  DashboardPayload,
  DataSourceCatalogueEntry,
  FinancialsResponse,
  ImportMode,
  ImportResult,
  InstrumentSearchResult,
  IpoAllotInput,
  IpoAllotResult,
  IpoListResponse,
  IpoOffer,
  IpoRefreshResult,
  IpoSubscribeInput,
  IpoUpsertInput,
  MacroSnapshot,
  NewsItem,
  OptionAnalyzeResponse,
  OptionCandidatesResponse,
  OptionChainSnapshot,
  OptionMarket,
  OptionPosition,
  OptionPositionsResponse,
  OptionSettlement,
  OptionSettlementRunResult,
  OptionSettlementStatus,
  OptionSettlementsResponse,
  OptionSettlementVerdict,
  OptionStrategy,
  OptionType,
  PendingWrite,
  ProfileResponse,
  Quote,
  RangeKey,
  BarInterval,
  SeriesResponse,
  Settings,
  SettingsInput,
  ToolRisk,
  Transaction,
  UpdateAssetInput,
  UpdateWatchItemInput,
  WatchItem,
  WatchlistDetail,
  WatchlistListResponse,
} from '@aia/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** True when the server needs an LLM API key before this call can succeed. */
  get isNotConfigured(): boolean {
    return this.code === 'NOT_CONFIGURED';
  }
}

type QueryValue = string | number | boolean | undefined | null;

function qs(params: object = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params) as [string, QueryValue][]) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      ...init,
    });
  } catch (error) {
    throw new ApiError(0, 'NETWORK_ERROR', `无法连接服务端：${(error as Error).message}`);
  }

  const text = await response.text();
  const payload = text ? safeJson(text) : null;

  if (!response.ok) {
    const body = payload as { error?: { code?: string; message?: string; details?: unknown } } | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? `HTTP_${response.status}`,
      body?.error?.message ?? text.slice(0, 300) ?? response.statusText,
      body?.error?.details,
    );
  }
  return payload as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: 'BAD_JSON', message: text.slice(0, 300) } };
  }
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const patchBody = (body: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(body) });
const putBody = (body: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(body) });

export interface AssetListQuery {
  market?: string;
  type?: string;
  source?: string;
  q?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
}

export interface WatchlistQuery extends AssetListQuery {
  group?: 'market' | 'type' | 'none';
  /** P3：在池 / 已退役 / 全部（默认 active）。 */
  status?: 'active' | 'retired' | 'all';
}

/** `GET /api/options/settlements` 的筛选值：`all` + 四种结算状态。 */
export type OptionSettlementQueryStatus = 'all' | OptionSettlementStatus;

/**
 * `POST /api/options/positions` 的请求体（手工补录一笔卖出合约）。
 *
 * 契约里没有单独的 shared 类型：它是「登记」而不是派生计算，字段与
 * `OptionPosition` 的可写部分一一对应。`optionCode` 是合约标识、`code` 是标的代码。
 */
export interface CreateOptionPositionInput {
  market: OptionMarket;
  /** 标的代码（港股 5 位数字 / 美股 ticker）。 */
  code: string;
  underlyingName?: string;
  strategy: OptionStrategy;
  optionType: OptionType;
  optionCode: string;
  strike: number;
  expiry: string;
  contracts: number;
  premium: number;
  fee?: number;
  multiplier?: number;
  tradeDate?: string;
  note?: string;
}

/* ─────────────── 定时流水线的自动续跑（GET /api/agent/retry） ─────────────── */

/**
 * 一条**已排队**的自动续跑。
 *
 * 背景：定时流水线跑在 API 进程内，因可重试错误（上游超时、连接被掐）失败后，
 * 服务端会自己排队在约 2 / 10 / 30 分钟后从落库的消息轨迹接着跑，最多 3 次，
 * 且跨进程重启保留。前端拿到它只有两个用途：告诉用户「系统会自己重试」，
 * 以及**别再给这条失败 run 显示「一键续跑」**（手动点一下会和服务端的自动重试
 * 并发跑同一条流水线，token 烧两份）。
 *
 * 为什么类型定义在前端而不是 `@aia/shared`：目前只有 `InterruptedRunsAlert` 一个
 * 消费方，放进 shared 只会多一个两边同步的公共面；出现第二个消费方时再上提。
 * 字段与 `docs/API.md` 的 `GET /api/agent/retry` 一一对应。
 */
export interface AgentRetryPending {
  /** `resume`：从断点续跑已有 run；`pipeline`：整条定时流水线重新执行。 */
  kind: 'resume' | 'pipeline';
  /** 即将执行的那一次，1 起算。 */
  attempt: number;
  /** 该流水线的最大尝试次数（服务端固定 3）。 */
  maxAttempts: number;
  /** ISO 时间戳：下一次自动执行的时间。 */
  nextRunAt: string;
  /** 本次会被接续的失败 run id；`kind === 'pipeline'` 时为空数组。 */
  failedRunIds: string[];
  /** 涉及的定时任务名，用于说明「是谁在重试」。 */
  taskNames: string[];
  /** 最近一次失败的原因（服务端截断后的文本）。 */
  lastError: string;
}

/**
 * `GET /api/agent/retry` 的响应。
 *
 * `pending === null` 表示当前没有排队的自动续跑；老版本服务端没有这个端点时
 * 请求会失败，调用方必须按「没有排队」降级处理（见 `InterruptedRunsAlert`）。
 */
export interface AgentRetryState {
  pending: AgentRetryPending | null;
  /** 服务端配置的最大尝试次数（前端兜底显示用）。 */
  maxAttempts: number;
}

export const api = {
  health: () =>
    request<{ ok: boolean; version: string; commit: string; builtAt: string; webBuilt: boolean }>('/health'),
  /** Build identity of the running API — shown in the top-left version badge. */
  version: () => request<AppVersionPayload>('/version'),

  /* ── settings ─────────────────────────────────────────────────────────── */
  settings: {
    get: () => request<Settings>('/settings'),
    update: (input: SettingsInput) => request<Settings>('/settings', putBody(input)),
    testLlm: (input?: { baseUrl?: string; apiKey?: string; model?: string }) =>
      request<{ ok: boolean; model: string; latencyMs: number; message: string }>('/settings/test-llm', json(input ?? {})),
    /** Lists the models a Base URL exposes (`GET {baseUrl}/models`); the key never round-trips to the UI. */
    models: (input?: { baseUrl?: string; apiKey?: string }) =>
      request<{ ok: boolean; models: string[]; message: string }>('/settings/llm-models', json(input ?? {})),
    /** 一键诊断：配置 → /models → /chat/completions →（opencode.ai 域名）工作区套餐。 */
    diagnose: (input?: { baseUrl?: string; apiKey?: string; model?: string }) =>
      request<{ ok: boolean; verdict: string; steps: { id: string; label: string; ok: boolean; detail: string }[] }>(
        '/settings/diagnose-llm',
        json(input ?? {}),
      ),
    dataSources: () =>
      request<{
        slots: { slot: string; market: string; kind: string; label: string; options: DataSourceCatalogueEntry[] }[];
        providers: DataSourceCatalogueEntry[];
      }>('/settings/data-sources'),
    /** Contract: a bare array. Tolerates `{ items, total }` for forward safety. */
    probe: async () => {
      const result = await request<
        | { provider: string; ok: boolean; latencyMs: number; message: string }[]
        | { items: { provider: string; ok: boolean; latencyMs: number; message: string }[]; total: number }
      >('/settings/data-sources/probe', json({}));
      return Array.isArray(result) ? result : (result.items ?? []);
    },
  },

  /* ── dashboard ────────────────────────────────────────────────────────── */
  dashboard: () => request<DashboardPayload>('/dashboard'),

  /* ── assets ───────────────────────────────────────────────────────────── */
  assets: {
    list: (query: AssetListQuery = {}) => request<{ items: AssetSummary[]; total: number }>(`/assets${qs(query)}`),
    create: (input: CreateAssetInput) => request<AssetDetail>('/assets', json(input)),
    get: (id: string) => request<AssetDetail>(`/assets/${encodeURIComponent(id)}`),
    update: (id: string, input: UpdateAssetInput) => request<AssetDetail>(`/assets/${encodeURIComponent(id)}`, putBody(input)),
    remove: (id: string) => request<{ ok: boolean }>(`/assets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    addTransaction: (id: string, input: CreateTransactionInput) =>
      request<AssetDetail>(`/assets/${encodeURIComponent(id)}/transactions`, json(input)),
    removeTransaction: (id: string, txId: string) =>
      request<AssetDetail>(`/assets/${encodeURIComponent(id)}/transactions/${encodeURIComponent(txId)}`, { method: 'DELETE' }),
    refresh: () => request<{ updated: number; failed: number }>('/assets/refresh', json({})),
    lastAnalysis: () => request<AgentRunSummary | null>('/assets/analyze/last'),
  },

  /* ── watchlist ────────────────────────────────────────────────────────── */
  watchlist: {
    list: (query: WatchlistQuery = {}) => request<WatchlistListResponse>(`/watchlist${qs(query)}`),
    create: (input: CreateWatchItemInput) => request<WatchItem>('/watchlist', json(input)),
    get: (id: string) => request<WatchlistDetail>(`/watchlist/${encodeURIComponent(id)}`),
    update: (id: string, input: UpdateWatchItemInput) => request<WatchItem>(`/watchlist/${encodeURIComponent(id)}`, patchBody(input)),
    remove: (id: string) => request<{ ok: boolean }>(`/watchlist/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    clear: () => request<{ ok: boolean; deleted: number }>('/watchlist', { method: 'DELETE' }),
    /** 刷新池内标的行情（现价/涨跌/走势），让「推荐后涨跌」不再是 0。 */
    refresh: () =>
      request<{ updated: number; failed: number; warnings?: string[] }>('/watchlist/refresh', json({})),
    /** P3 复活：清空退役标记与累计次数。 */
    restore: (id: string) => request<WatchItem>(`/watchlist/${encodeURIComponent(id)}/restore`, json({})),
    lastAnalysis: () => request<AgentRunSummary | null>('/watchlist/analyze/last'),
  },

  /* ── advice ───────────────────────────────────────────────────────────── */
  advice: {
    list: (status?: string) => request<{ items: AdviceItem[]; budget: BudgetStatus }>(`/advice${qs({ status })}`),
    reject: (id: string) => request<AdviceItem>(`/advice/${encodeURIComponent(id)}/reject`, json({})),
    confirm: (id: string, input: ConfirmAdviceInput) =>
      request<{ advice: AdviceItem; asset: AssetDetail }>(`/advice/${encodeURIComponent(id)}/confirm`, json(input)),
    /**
     * 确认一条**期权**建议：写入的是卖出合约（`option_contracts`），不是股票持仓。
     *
     * 与股票确认分开是契约级的设计：入账路径不同（合约 vs 交易流水），
     * 返回体也不同（`{ advice, position }` vs `{ advice, asset }`）。
     */
    confirmOption: (id: string, input: ConfirmOptionAdviceInput) =>
      request<ConfirmOptionAdviceResult>(`/advice/${encodeURIComponent(id)}/confirm-option`, json(input)),
    last: () => request<AgentRunSummary | null>('/advice/last'),
    budget: () => request<BudgetStatus>('/budget'),
    /** 建议结果追踪（确定性、不调用 LLM）：逐条实际表现 + 胜率统计。 */
    outcomes: () => request<AdviceOutcomesResponse>('/advice/outcomes'),
    trackOutcomes: () => request<AdviceOutcomesTrackResponse>('/advice/outcomes/track', json({})),
  },

  /* ── IPO 打新 ─────────────────────────────────────────────────────────── */
  ipo: {
    list: (query: { market?: string; status?: string; q?: string; limit?: number } = {}) =>
      request<IpoListResponse>(`/ipo${qs(query)}`),
    get: (id: string) => request<IpoOffer>(`/ipo/${encodeURIComponent(id)}`),
    /** 抓取 A股/港股/美股三地新股（零 Key 公开源），按 uid 覆盖写入。 */
    refresh: (input: { markets?: string[]; limitPerMarket?: number } = {}) =>
      request<IpoRefreshResult>('/ipo/refresh', json(input)),
    /** 手动录入一只新股（上游缺失或券商 App 信息更准时使用）。 */
    create: (input: IpoUpsertInput) => request<IpoOffer>('/ipo', json(input)),
    remove: (id: string) => request<{ ok: boolean }>(`/ipo/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** 登记「我申购了 N 股」（不写账本）。 */
    subscribe: (id: string, input: IpoSubscribeInput) =>
      request<IpoOffer>(`/ipo/${encodeURIComponent(id)}/subscribe`, json(input)),
    unsubscribe: (id: string) =>
      request<IpoOffer>(`/ipo/${encodeURIComponent(id)}/subscription`, { method: 'DELETE' }),
    /** 登记中签：shares > 0 时自动建资产 + 买入流水；0 = 未中签。 */
    allot: (id: string, input: IpoAllotInput) =>
      request<IpoAllotResult>(`/ipo/${encodeURIComponent(id)}/allot`, json(input)),
    /** 最近一次 AI 打新分析（SSE 走全局推理面板 `run({path:'/ipo/analyze'})`）。 */
    lastAnalysis: () => request<AgentRunSummary | null>('/ipo/analyze/last'),
  },

  /* ── options 期权卖权（港股 / 美股） ────────────────────────────────────── */
  options: {
    /** 期权链快照：`delayed` / `source` / `asOf` 必须原样展示（卖权定价全靠它）。 */
    chain: (args: { market: OptionMarket; code: string; maxExpiries?: number; refresh?: boolean }) =>
      request<OptionChainSnapshot>(
        `/options/chain${qs({ market: args.market, code: args.code, maxExpiries: args.maxExpiries, refresh: args.refresh ? 1 : undefined })}`,
      ),
    /** 确定性筛选出的卖权候选（不经过 LLM）。 */
    candidates: (args: { market: OptionMarket; code: string; limit?: number }) =>
      request<OptionCandidatesResponse>(`/options/candidates${qs(args)}`),
    /** 专门跑一次「AI 期权卖权建议」（SSE 走全局推理面板）。 */
    analyze: (input: { markets?: OptionMarket[]; codes?: string[] } = {}) =>
      request<OptionAnalyzeResponse>('/options/analyze', json(input)),
    positions: () => request<OptionPositionsResponse>('/options/positions'),
    position: (id: string) => request<OptionPosition>(`/options/positions/${encodeURIComponent(id)}`),
    /** 手工补录一笔卖出合约（计划外成交）。 */
    createPosition: (input: CreateOptionPositionInput) => request<OptionPosition>('/options/positions', json(input)),
    /** 买平（buy to close）。 */
    closePosition: (id: string, input: { price: number; fee?: number; tradeDate?: string; note?: string }) =>
      request<OptionPosition>(`/options/positions/${encodeURIComponent(id)}/close`, json(input)),
    /** 对单个合约立即跑一次到期结算。 */
    settlePosition: (id: string) =>
      request<OptionSettlementRunResult>(`/options/positions/${encodeURIComponent(id)}/settle`, json({})),
    settlements: (status: OptionSettlementQueryStatus = 'all') =>
      request<OptionSettlementsResponse>(`/options/settlements${qs({ status })}`),
    /** 扫描所有已到期合约（到期自动跟踪行权并更新「我的资产」）。 */
    scanSettlements: () => request<OptionSettlementRunResult>('/options/settlements/scan', json({})),
    confirmSettlement: (id: string, input: { verdict: OptionSettlementVerdict; referencePrice?: number; note?: string }) =>
      request<OptionSettlementRunResult>(`/options/settlements/${encodeURIComponent(id)}/confirm`, json(input)),
    dismissSettlement: (id: string, input: { note?: string } = {}) =>
      request<OptionSettlement>(`/options/settlements/${encodeURIComponent(id)}/dismiss`, json(input)),
  },

  /* ── market ───────────────────────────────────────────────────────────── */
  market: {
    search: (q: string, market?: string) => request<InstrumentSearchResult[]>(`/market/search${qs({ q, market })}`),
    quote: (market: string, code: string) => request<Quote>(`/market/quote${qs({ market, code })}`),
    series: (args: { market: string; code: string; type: string; range?: RangeKey; interval?: BarInterval }) =>
      request<SeriesResponse>(`/market/series${qs(args)}`),
    profile: (args: { market: string; code: string; type: string }) => request<ProfileResponse>(`/market/profile${qs(args)}`),
    /** 财报三表（多期）：ETF/基金返回 applicable=false 而不是报错。 */
    financials: (args: { market: string; code: string; type: string; periods?: number }) =>
      request<FinancialsResponse>(`/market/financials${qs(args)}`),
    detail: (args: { market: string; code: string; type: string; range?: RangeKey; interval?: BarInterval }) =>
      request<{ series: SeriesResponse; profile: ProfileResponse }>(`/market/detail${qs(args)}`),
    indices: () => request<Quote[]>('/market/indices'),
    macro: () => request<MacroSnapshot>('/market/macro'),
    news: (q: string) => request<NewsItem[]>(`/market/news${qs({ q })}`),
  },

  /* ── agent ────────────────────────────────────────────────────────────── */
  agent: {
    runs: (limit = 20, kind?: string) => request<AgentRunSummary[]>(`/agent/runs${qs({ limit, kind })}`),
    run: (id: string) => request<AgentRun>(`/agent/runs/${encodeURIComponent(id)}`),
    /**
     * 定时流水线的自动续跑状态（`pending` 非空 = 服务端已排队一次自动重试）。
     * 调用方要容忍它失败（旧服务端 404 / 网络抖动），按「没有排队」渲染即可，
     * 绝不能让它连累基于 `runs` 的失败提示条。
     */
    retryState: () => request<AgentRetryState>('/agent/retry'),
    tools: () =>
      request<{ name: string; description: string; parameters: Record<string, unknown>; risk?: ToolRisk; source?: string }[]>(
        '/agent/tools',
      ),
    /** P1-3: full trajectory (messages + steps + audit + pending writes). */
    trace: (id: string) => request<AgentTrace>(`/agent/runs/${encodeURIComponent(id)}/trace`),
    /** P1-1: write/execution audit trail. */
    audit: (query: { limit?: number; runId?: string; risk?: ToolRisk; outcome?: string } = {}) =>
      request<AuditEntry[]>(`/agent/audit${qs(query)}`),
    /** P1-1: mutating tool calls waiting for approval. */
    pending: (status?: string) => request<PendingWrite[]>(`/agent/pending${qs({ status })}`),
    approvePending: (id: string) =>
      request<{ pending: PendingWrite; result: string }>(`/agent/pending/${encodeURIComponent(id)}/approve`, json({})),
    rejectPending: (id: string, reason?: string) =>
      request<{ pending: PendingWrite }>(`/agent/pending/${encodeURIComponent(id)}/reject`, json({ reason })),
  },

  /* ── MCP servers (P1-2) ───────────────────────────────────────────────── */
  mcp: {
    servers: () =>
      request<
        {
          id: string;
          name: string;
          transport: string;
          enabled: boolean;
          connected: boolean;
          toolCount: number;
          tools: string[];
          error: string | null;
        }[]
      >('/mcp/servers'),
    test: (id: string) =>
      request<{ ok: boolean; toolCount: number; tools: string[]; error: string | null }>(
        `/mcp/servers/${encodeURIComponent(id)}/test`,
        json({}),
      ),
    reload: () => request<{ reloaded: number; failed: number }>('/mcp/reload', json({})),
  },

  /* ── chat ─────────────────────────────────────────────────────────────── */
  chat: {
    sessions: () => request<ChatSession[]>('/chat/sessions'),
    createSession: (title?: string) => request<ChatSession>('/chat/sessions', json({ title })),
    removeSession: (id: string) => request<{ ok: boolean }>(`/chat/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    messages: (id: string) => request<ChatMessage[]>(`/chat/sessions/${encodeURIComponent(id)}/messages`),
  },

  /* ── backup ───────────────────────────────────────────────────────────── */
  backup: {
    exportAll: () => request<BackupPayload>('/backup/export'),
    import: (data: BackupPayload, mode: ImportMode = 'merge') => request<ImportResult>('/backup/import', json({ data, mode })),
    files: () => request<{ name: string; size: number; createdAt: string }[]>('/backup/files'),
    snapshot: () => request<{ name: string; size: number; createdAt: string }>('/backup/files', json({})),
    /**
     * 一键清除所有数据。默认 `keepSettings: true`（保留 AI 配置与 API Key）；
     * `false` 时设置一并恢复出厂默认。AI 流水线运行中服务端返回 409。
     */
    clear: (input?: { keepSettings?: boolean }) => request<ClearDataResult>('/backup/clear', json(input ?? {})),
  },
};

export type TransactionList = Transaction[];
