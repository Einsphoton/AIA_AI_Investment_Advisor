/**
 * Typed HTTP client for the backend API. Owner: Lead.
 *
 * Keep this module in sync with docs/API.md — pages should never call `fetch`
 * directly, so that error handling and JSON parsing stay uniform.
 */
import type {
  AdviceItem,
  AgentRun,
  AgentRunSummary,
  AgentTrace,
  AssetDetail,
  AssetSummary,
  AuditEntry,
  BackupPayload,
  BudgetStatus,
  ChatMessage,
  ChatSession,
  ConfirmAdviceInput,
  CreateAssetInput,
  CreateTransactionInput,
  CreateWatchItemInput,
  DashboardPayload,
  DataSourceCatalogueEntry,
  ImportMode,
  ImportResult,
  InstrumentSearchResult,
  MacroSnapshot,
  NewsItem,
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
}

export const api = {
  health: () => request<{ ok: boolean; version: string; webBuilt: boolean }>('/health'),

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
    list: (query: WatchlistQuery = {}) => request<{ items: WatchItem[]; total: number }>(`/watchlist${qs(query)}`),
    create: (input: CreateWatchItemInput) => request<WatchItem>('/watchlist', json(input)),
    get: (id: string) => request<WatchlistDetail>(`/watchlist/${encodeURIComponent(id)}`),
    update: (id: string, input: UpdateWatchItemInput) => request<WatchItem>(`/watchlist/${encodeURIComponent(id)}`, patchBody(input)),
    remove: (id: string) => request<{ ok: boolean }>(`/watchlist/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    clear: () => request<{ ok: boolean; deleted: number }>('/watchlist', { method: 'DELETE' }),
    lastAnalysis: () => request<AgentRunSummary | null>('/watchlist/analyze/last'),
  },

  /* ── advice ───────────────────────────────────────────────────────────── */
  advice: {
    list: (status?: string) => request<{ items: AdviceItem[]; budget: BudgetStatus }>(`/advice${qs({ status })}`),
    reject: (id: string) => request<AdviceItem>(`/advice/${encodeURIComponent(id)}/reject`, json({})),
    confirm: (id: string, input: ConfirmAdviceInput) =>
      request<{ advice: AdviceItem; asset: AssetDetail }>(`/advice/${encodeURIComponent(id)}/confirm`, json(input)),
    last: () => request<AgentRunSummary | null>('/advice/last'),
    budget: () => request<BudgetStatus>('/budget'),
  },

  /* ── market ───────────────────────────────────────────────────────────── */
  market: {
    search: (q: string, market?: string) => request<InstrumentSearchResult[]>(`/market/search${qs({ q, market })}`),
    quote: (market: string, code: string) => request<Quote>(`/market/quote${qs({ market, code })}`),
    series: (args: { market: string; code: string; type: string; range?: RangeKey; interval?: BarInterval }) =>
      request<SeriesResponse>(`/market/series${qs(args)}`),
    profile: (args: { market: string; code: string; type: string }) => request<ProfileResponse>(`/market/profile${qs(args)}`),
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
  },
};

export type TransactionList = Transaction[];
