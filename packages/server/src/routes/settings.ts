/**
 * Settings / data-source catalogue / LLM test routes (docs/API.md §2)
 *
 * Owner: server-core. `GET /api/settings` never leaks the API key: it returns
 * `hasApiKey` + `apiKeyMasked` only. `PUT /api/settings` treats `apiKey` as
 * "omitted = unchanged, null = clear, non-empty string = overwrite"
 * (an empty string keeps the stored key, per the frozen `SettingsInput` doc).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  DATA_SOURCE_SLOTS,
  MAX_SCHEDULES,
  SOURCE_CATALOGUE,
  type DataSourceCatalogueEntry,
  type LlmConfig,
  type Settings,
  type SourceId,
} from '@aia/shared';

import { config } from '../config.js';
import { APP_USER_AGENT, providerHeaders, providerMessage } from '../agent/llm.js';
import { badRequest } from '../errors.js';
import { getRepo, getScheduler } from '../registry.js';
import { getActiveScheduler } from '../services/scheduler.js';
import type { StoredSettings } from '../types/models.js';
import {
  maskApiKey,
  maskDataSourceChoice,
  maskDataSourceConfig,
  parseOrThrow,
  resetDatasourceCache,
  safeMessage,
  settingsPatch,
} from '../db/util.js';

const SOURCE_IDS = [
  'eastmoney',
  'tencent',
  'eastmoney-fund',
  'eastmoney-macro',
  'eastmoney-news',
  'bing',
  'duckduckgo',
  'tavily',
  'serper',
  'brave',
  'yahoo',
  'stooq',
  'finnhub',
  'alphavantage',
  'fmp',
  'synthetic',
] as const satisfies readonly SourceId[];

const choiceSchema = z.object({
  provider: z.enum(['auto', ...SOURCE_IDS]).optional(),
  apiKey: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

const dataSourcesSchema = z.object({
  stockCN: choiceSchema.optional(),
  stockHK: choiceSchema.optional(),
  stockUS: choiceSchema.optional(),
  fundCN: choiceSchema.optional(),
  fundHK: choiceSchema.optional(),
  fundUS: choiceSchema.optional(),
  webSearch: choiceSchema.optional(),
});

const llmSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  fastModel: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const settingsInputSchema = z.object({
  persona: z.enum(['steady', 'aggressive', 'value', 'income', 'balanced', 'shortterm']).optional(),
  reportStyle: z.enum(['professional', 'beginner']).optional(),
  llm: llmSchema.optional(),
  dataSources: dataSourcesSchema.optional(),
  budget: z
    .object({ CN: z.number().min(0).optional(), HK: z.number().min(0).optional(), US: z.number().min(0).optional() })
    .optional(),
  // 定时任务：**整体替换**（与 mcpServers 同语义，空数组 = 不排程）。每个任务自带
  // 触发方式与要跑的步骤；模式里没有 off —— 停用是任务自己的 enabled。
  schedules: z
    .array(
      z
        .object({
          id: z
            .string()
            .min(1)
            .max(40)
            .regex(/^[A-Za-z0-9_-]+$/, '只能包含字母、数字、下划线与连字符'),
          name: z.string().min(1).max(60),
          enabled: z.boolean().optional().default(true),
          mode: z.enum(['interval', 'daily']),
          intervalMinutes: z.number().int().min(1).max(100_000).optional().default(1440),
          dailyTime: z
            .string()
            .regex(/^\d{2}:\d{2}$/, '需为 HH:mm')
            .refine((value) => {
              // Range check: the regex alone accepts "25:99", which the scheduler
              // would silently clamp — the UI would then show a time that never runs.
              const [hour, minute] = value.split(':').map(Number);
              return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
            }, '需为合法的 24 小时时间（00:00–23:59）')
            .optional()
            .default('08:30'),
          runAssetAnalysis: z.boolean().optional().default(true),
          runWatchlistAnalysis: z.boolean().optional().default(true),
          runIpoAnalysis: z.boolean().optional().default(true),
          runAdvice: z.boolean().optional().default(true),
        })
        .refine(
          (task) => task.runAssetAnalysis || task.runWatchlistAnalysis || task.runIpoAnalysis || task.runAdvice,
          '至少要选择一个要跑的步骤（资产分析 / 标的分析 / 打新分析 / 投资建议）',
        ),
    )
    .max(MAX_SCHEDULES, `最多 ${MAX_SCHEDULES} 个定时任务`)
    .refine(
      (tasks) => new Set(tasks.map((task) => task.id)).size === tasks.length,
      '任务 id 不能重复',
    )
    .optional(),
  enforceBudget: z.boolean().optional(),
  watchlistCandidateLimit: z.number().int().min(0).max(100).optional(),
  /** P3：连续确认退役多少次后才真正删除标的；0 = 只标记不删除。 */
  watchlistRetireDeleteRuns: z.number().int().min(0).max(50).optional(),
  // P1-1: partial anywhere (repo.saveSettings merges both objects), so the UI
  // can flip `requireWriteApproval` without echoing the whole deny list.
  toolPolicy: z
    .object({
      deny: z.array(z.string()).max(200).optional(),
      requireWriteApproval: z.boolean().optional(),
    })
    .optional(),
  // P1-2: replaced wholesale (an empty array clears every server). The defaults
  // keep stored rows uniform, so the MCP layer never has to guard for holes.
  mcpServers: z
    .array(
      z.object({
        // D6: keep the id short enough that `mcp__<id>__<tool>` keeps its
        // structure after the 64-char tool-name cap.
        id: z
          .string()
          .min(1)
          .max(24)
          .regex(/^[A-Za-z0-9_-]+$/, '只能包含字母、数字、下划线与连字符'),
        name: z.string().max(60),
        transport: z.enum(['stdio', 'http']),
        command: z.string().optional().default(''),
        args: z.array(z.string()).optional().default([]),
        env: z.record(z.string(), z.string()).optional().default({}),
        url: z.string().optional().default(''),
        enabled: z.boolean().optional().default(true),
      }),
    )
    .max(20)
    .optional(),
  apiKey: z.string().nullable().optional(),
});

/**
 * Never exposes a plaintext secret: `llm.apiKey` is blanked and every
 * `dataSources.*.apiKey` is replaced by `hasApiKey` + `apiKeyMasked`
 * (docs/ARCHITECTURE.md §5「不落敏感数据」).
 *
 * `mcpServers[].env` is a secret carrier too — MCP servers are configured with
 * tokens such as `GITHUB_TOKEN`, so the values are blanked while the *keys*
 * (and every other field) survive: the UI can still show which variables a
 * server needs without ever receiving the credentials. The plaintext lives only
 * in SQLite and is restored by `PUT /api/settings` (the client sends what the
 * user re-enters; an omitted `mcpServers` leaves the stored set untouched).
 */
export function toSettingsDto(stored: StoredSettings): Settings {
  const apiKey = stored.llm.apiKey ?? '';
  return {
    persona: stored.persona,
    reportStyle: stored.reportStyle,
    llm: { ...stored.llm, apiKey: '' },
    hasApiKey: apiKey.trim() !== '',
    apiKeyMasked: maskApiKey(apiKey),
    dataSources: maskDataSourceConfig(stored.dataSources),
    budget: stored.budget,
    schedules: stored.schedules,
    enforceBudget: stored.enforceBudget,
    watchlistCandidateLimit: stored.watchlistCandidateLimit,
    watchlistRetireDeleteRuns: stored.watchlistRetireDeleteRuns,
    toolPolicy: stored.toolPolicy,
    mcpServers: stored.mcpServers.map((server) => ({
      ...server,
      env: Object.fromEntries(Object.keys(server.env ?? {}).map((key) => [key, ''])),
    })),
    updatedAt: stored.updatedAt,
  };
}

/* ───────────────────────────── data-source probes ─────────────────────────── */

const PROBE_TIMEOUT_MS = 5_000;

const PROBE_URLS: Partial<Record<SourceId, string>> = {
  eastmoney: 'https://push2.eastmoney.com/api/qt/stock/get?secid=1.000001&fields=f43,f58',
  'eastmoney-fund': 'https://fundgz.1234567.com.cn/js/000001.js',
  'eastmoney-macro': 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_ECONOMY_CPI&columns=ALL&pageSize=1',
  'eastmoney-news': 'https://so.eastmoney.com/news/s?keyword=%E6%B2%AA%E6%B7%B1300',
  tencent: 'https://qt.gtimg.cn/q=sh000001',
  bing: 'https://www.bing.com/search?q=stock',
  duckduckgo: 'https://duckduckgo.com/html/?q=stock',
  yahoo: 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1d',
  stooq: 'https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlc&h&e=csv',
};

const KEY_BY_PROVIDER: Partial<Record<SourceId, keyof typeof config.providerKeys>> = {
  tavily: 'tavily',
  serper: 'serper',
  brave: 'brave',
  finnhub: 'finnhub',
  alphavantage: 'alphavantage',
  fmp: 'fmp',
};

interface ProbeResult {
  provider: SourceId;
  ok: boolean;
  latencyMs: number;
  message: string;
}

function storedProviderKey(stored: StoredSettings, provider: SourceId): string {
  for (const slot of Object.values(stored.dataSources)) {
    if (slot?.provider === provider && typeof slot.apiKey === 'string' && slot.apiKey !== '') return slot.apiKey;
  }
  const envKey = KEY_BY_PROVIDER[provider];
  return envKey ? (config.providerKeys[envKey] ?? '') : '';
}

async function probeProvider(provider: SourceId, stored: StoredSettings): Promise<ProbeResult> {
  const started = Date.now();
  const requiresKey = SOURCE_CATALOGUE.find((entry) => entry.id === provider)?.requiresKey ?? false;
  const key = storedProviderKey(stored, provider);

  if (requiresKey && key === '') {
    return { provider, ok: false, latencyMs: 0, message: '未配置 API Key' };
  }
  const url = PROBE_URLS[provider];
  if (!url) {
    return {
      provider,
      ok: requiresKey ? key !== '' : false,
      latencyMs: 0,
      message: requiresKey ? '已配置 API Key（未发起探测请求）' : '暂无探测方式',
    };
  }

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: '*/*', 'user-agent': APP_USER_AGENT },
    });
    const latencyMs = Date.now() - started;
    return {
      provider,
      ok: response.ok,
      latencyMs,
      message: response.ok ? `HTTP ${response.status}（${latencyMs}ms）` : `HTTP ${response.status}`,
    };
  } catch (error) {
    return { provider, ok: false, latencyMs: Date.now() - started, message: safeMessage(error) };
  }
}

/* ────────────────────────────── model catalogue ───────────────────────────── */

/** `GET /models` gets a longer budget than a plain probe: gateways list a lot. */
const MODEL_LIST_TIMEOUT_MS = 15_000;

/**
 * Normalizes the `/models` response shapes seen in the wild:
 *   OpenAI / DeepSeek / OpenCode → `{ data: [{ id }] }`
 *   Google / Anthropic-compat    → `{ models: [{ name }] }` or `{ data: [...] }`
 *   some gateways                → a bare array of strings or objects
 * Ids are de-duplicated and sorted so the picker order is stable.
 */
export function parseModelIds(payload: unknown): string[] {
  const ids = new Set<string>();
  const collect = (entry: unknown): void => {
    if (typeof entry === 'string') {
      if (entry.trim() !== '') ids.add(entry.trim());
      return;
    }
    if (!entry || typeof entry !== 'object') return;
    const record = entry as Record<string, unknown>;
    for (const key of ['id', 'name', 'model']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '') {
        ids.add(value.trim());
        return;
      }
    }
  };
  const container = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  const list = Array.isArray(payload)
    ? payload
    : (container?.data ?? container?.models ?? container?.items ?? null);
  if (Array.isArray(list)) for (const entry of list) collect(entry);
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/* ─────────────────────────────── diagnosis ───────────────────────────────── */

export interface DiagnosisStep {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

/** `GET /console/api/v2/config` 里的 provider 及其模型数量。 */
export interface ConsoleProviderEntry {
  id: string;
  modelCount: number;
}

export function parseConsoleProviderEntries(payload: unknown): ConsoleProviderEntry[] {
  if (!payload || typeof payload !== 'object') return [];
  const providers = (payload as Record<string, unknown>).providers;
  if (!providers || typeof providers !== 'object') return [];
  return Object.entries(providers as Record<string, unknown>)
    .map(([id, value]) => {
      const models = value && typeof value === 'object' ? (value as Record<string, unknown>).models : null;
      return { id, modelCount: models && typeof models === 'object' ? Object.keys(models).length : 0 };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** `GET /console/api/v2/config` 里可用的 provider id（Console / Go / 自带渠道）。 */
export function parseConsoleProviders(payload: unknown): string[] {
  return parseConsoleProviderEntries(payload).map((entry) => entry.id);
}

/**
 * 把逐项探测结果汇成一句结论。用户不该自己去解读 401/402/404 ——
 * 「Key 有效但计费被拒」和「入口/模型不对」的处置方式完全不同；
 * 402 还要再分「工作区没有 Go」与「有 Go 但这次没被覆盖」。
 */
export function summariseLlmDiagnosis(steps: DiagnosisStep[]): string {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const chat = byId.get('chat');
  const models = byId.get('models');
  const plan = byId.get('opencode-plan');
  if (chat?.ok) {
    return models && !models.ok
      ? '配置可用；该入口不提供 /models，模型名需手动填写。'
      : '配置可用：认证、计费与对话请求都正常。';
  }
  const detail = chat?.detail ?? '';
  if (/402/.test(detail)) {
    if (plan && !plan.ok && /未列出 Go/.test(plan.detail)) {
      return 'Key 本身有效，但没有可用额度：该 Key 所在工作区未开通 Go 订阅（请求被按余额结算，而余额为 0）。请到订阅 Go 的那个工作区重新生成 Key。';
    }
    if (plan?.ok) {
      return '工作区已开通 Go，但这次请求仍被按余额结算（402）：说明该请求没有落在 Go 额度内——常见原因：该模型额度窗口已用尽（Go 为 5 小时 20% / 周 50% / 月 100%）、订阅续费失败已失效、或该 Key/工作区与订阅不匹配。请在 Console → Overview 查看用量条，额度用尽时打开 Extra usage（需余额）或换额度更大的模型。';
    }
    return 'Key 本身有效，但没有可用额度：请检查订阅是否生效/续费成功、该模型额度是否用尽、余额是否为零；Go 额度用尽时需在 Console 的 Overview 打开 Extra usage。';
  }
  if (/401|403/.test(detail)) {
    return '凭据被拒：确认 Key 类型与权限（OpenCode 需用 Console「Keys」里的 service account key）。';
  }
  if (/404/.test(detail)) {
    return '入口或模型不对：检查 Base URL 与模型名（部分网关的模型只支持特定协议，例如 GPT 系走 Responses）。';
  }
  if (chat) return '对话请求未通过，请按上面各步骤的返回逐条排查。';
  return '尚未发起对话请求：请先补全 Base URL 与 API Key。';
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 解析「草稿覆盖 + 已保存」的 LLM 配置。
 *
 * 设置页的测试/模型列表/诊断都必须用**表单里当前的值**，而不是要求用户先保存：
 * 客户端发的是顶层 `baseUrl` / `model` / `apiKey`（也兼容 `llm: {...}` 包裹的写法）。
 * 忽略它们会让「选了新预设但没保存就点测试」变成测旧配置 —— 一个真实踩过的坑。
 */
function resolveLlmOverride(
  stored: StoredSettings,
  body: { llm?: Partial<LlmConfig>; baseUrl?: string; model?: string; apiKey?: string | null },
): LlmConfig {
  const cfg: LlmConfig = { ...stored.llm, ...stripUndefined(body.llm ?? {}) };
  if (typeof body.baseUrl === 'string' && body.baseUrl.trim() !== '') cfg.baseUrl = body.baseUrl;
  if (typeof body.model === 'string' && body.model.trim() !== '') cfg.model = body.model;
  if (typeof body.apiKey === 'string' && body.apiKey !== '') cfg.apiKey = body.apiKey;
  if (body.apiKey === null) cfg.apiKey = '';
  return cfg;
}

/* ────────────────────────────────── routes ────────────────────────────────── */

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async () => toSettingsDto(getRepo().getSettings()));

  app.put('/api/settings', async (request) => {
    const body = parseOrThrow(settingsInputSchema, request.body ?? {}, '设置参数');
    const repo = getRepo();
    const current = repo.getSettings();
    const patch: Partial<StoredSettings> & { llm?: Partial<LlmConfig> } = {};

    if (body.persona !== undefined) patch.persona = body.persona;
    if (body.reportStyle !== undefined) patch.reportStyle = body.reportStyle;
    if (body.enforceBudget !== undefined) patch.enforceBudget = body.enforceBudget;
    if (body.watchlistCandidateLimit !== undefined) patch.watchlistCandidateLimit = body.watchlistCandidateLimit;
    if (body.watchlistRetireDeleteRuns !== undefined) patch.watchlistRetireDeleteRuns = body.watchlistRetireDeleteRuns;
    if (body.budget !== undefined) patch.budget = { ...stripUndefined(body.budget) } as StoredSettings['budget'];
    // 定时任务整体替换（空数组 = 删光所有任务）。
    if (body.schedules !== undefined) patch.schedules = body.schedules as StoredSettings['schedules'];
    if (body.dataSources !== undefined) {
      patch.dataSources = sanitiseDataSourcePatch(body.dataSources) as unknown as StoredSettings['dataSources'];
    }
    // P1-1: `toolPolicy` merges (a partial patch keeps the untouched half),
    // `mcpServers` replaces the whole list — that is how the UI deletes a server.
    if (body.toolPolicy !== undefined) {
      patch.toolPolicy = stripUndefined(body.toolPolicy) as StoredSettings['toolPolicy'];
    }
    if (body.mcpServers !== undefined) patch.mcpServers = body.mcpServers;

    // Tri-state API key: omitted/'' = keep, null = clear, string = overwrite.
    let nextApiKey: string | undefined;
    if (body.apiKey === null) nextApiKey = '';
    else if (typeof body.apiKey === 'string' && body.apiKey !== '') nextApiKey = body.apiKey;

    const llmPatch: Partial<LlmConfig> = { ...(body.llm ?? {}) };
    if (typeof llmPatch.apiKey === 'string' && llmPatch.apiKey !== '') nextApiKey = llmPatch.apiKey;
    delete llmPatch.apiKey;
    // Same guard as the data-source slots: never persist a masked preview.
    if (nextApiKey !== undefined && nextApiKey !== '') assertNotMaskValue(nextApiKey);

    patch.llm = { ...current.llm, ...llmPatch };
    if (nextApiKey !== undefined) patch.llm.apiKey = nextApiKey;

    const saved = repo.saveSettings(settingsPatch(patch));
    // Data-source pins / keys may have changed: drop the datasource HTTP cache.
    if (body.dataSources !== undefined) await resetDatasourceCache();
    // Schedule changes must take effect without a restart; the live timer is the
    // only thing that knows the plan, so a stale scheduler would silently keep a
    // deleted task or miss a new one. The module singleton covers the boot race
    // before `index.ts` calls `setScheduler()`.
    if (body.schedules !== undefined) (getScheduler() ?? getActiveScheduler())?.reload();
    return toSettingsDto(saved);
  });

  app.post('/api/settings/test-llm', async (request) => {
    const body = parseOrThrow(
      z.object({
        llm: llmSchema.optional(),
        // 设置页「测试连接」发送的是**草稿**字段（未保存也应生效）。以前只接受 `llm`
        // 包裹的写法，顶层 baseUrl/model 被 zod 丢掉，导致测试的其实是上次保存的旧配置。
        baseUrl: z.string().optional(),
        model: z.string().optional(),
        apiKey: z.string().nullable().optional(),
      }),
      request.body ?? {},
      'LLM 测试参数',
    );
    const stored = getRepo().getSettings();
    const cfg = resolveLlmOverride(stored, body);

    const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    if (!baseUrl) throw badRequest('未配置 LLM Base URL');
    if (!cfg.apiKey.trim()) {
      return { ok: false, model: cfg.model, latencyMs: 0, message: '未配置 LLM API Key，请在设置中填写后重试' };
    }

    const started = Date.now();
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...providerHeaders(baseUrl, cfg.apiKey, 'settings-test'),
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(Math.min(Math.max(cfg.timeoutMs, 5_000), 30_000)),
      });
      const latencyMs = Date.now() - started;
      const text = await response.text();
      if (!response.ok) {
        return {
          ok: false,
          model: cfg.model,
          latencyMs,
          message: `HTTP ${response.status}：${providerMessage(text)}`,
        };
      }
      return { ok: true, model: cfg.model, latencyMs, message: '连接成功，模型可用' };
    } catch (error) {
      return { ok: false, model: cfg.model, latencyMs: Date.now() - started, message: safeMessage(error) };
    }
  });

  /**
   * Model catalogue for the settings-page picker. Uses the stored key unless the
   * client passes a freshly typed one, and never returns or logs the key.
   * Providers answer `/models` in several shapes (see `parseModelIds`); a failure
   * is reported as `{ ok: false }` rather than a 5xx so the UI can fall back to
   * manual input while still showing the provider's own message.
   */
  app.post('/api/settings/llm-models', async (request) => {
    const body = parseOrThrow(
      z.object({
        llm: llmSchema.optional(),
        baseUrl: z.string().optional(),
        model: z.string().optional(),
        apiKey: z.string().nullable().optional(),
      }),
      request.body ?? {},
      '模型列表参数',
    );
    const cfg = resolveLlmOverride(getRepo().getSettings(), body);

    const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    if (!baseUrl) throw badRequest('未配置 LLM Base URL');

    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: {
          accept: 'application/json',
          ...providerHeaders(baseUrl, cfg.apiKey, 'settings-models'),
        },
        signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
      });
      const text = await response.text();
      if (!response.ok) {
        return { ok: false, models: [], message: `HTTP ${response.status}：${providerMessage(text)}` };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        return { ok: false, models: [], message: '返回内容不是 JSON：该地址可能不是 OpenAI 兼容接口' };
      }
      const models = parseModelIds(payload);
      if (models.length === 0) return { ok: false, models: [], message: '未从返回内容中解析到模型列表' };
      return { ok: true, models, message: '' };
    } catch (error) {
      return { ok: false, models: [], message: safeMessage(error) };
    }
  });

  /**
   * 一键诊断：依次探测「配置 → GET /models → POST /chat/completions →
   * （opencode.ai 域名）工作区套餐」，返回每一步的状态与一句结论。
   * 全部请求都走 providerHeaders（含 UA 与会话头），Key 只进不出。
   */
  app.post('/api/settings/diagnose-llm', async (request) => {
    const body = parseOrThrow(
      z.object({
        llm: llmSchema.optional(),
        baseUrl: z.string().optional(),
        model: z.string().optional(),
        apiKey: z.string().nullable().optional(),
      }),
      request.body ?? {},
      '诊断参数',
    );
    const cfg = resolveLlmOverride(getRepo().getSettings(), body);

    const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    const steps: DiagnosisStep[] = [];
    const wellFormed = /^https?:\/\/\S+$/i.test(baseUrl);
    const hasKey = cfg.apiKey.trim() !== '';

    steps.push({
      id: 'config',
      label: '配置检查',
      ok: wellFormed && hasKey,
      detail: !wellFormed
        ? 'Base URL 为空或格式不对（需以 http(s):// 开头）'
        : hasKey
          ? `Base URL = ${baseUrl}`
          : '未配置 API Key（留空表示沿用已保存的 Key，而当前也没有）',
    });

    if (wellFormed) {
      try {
        const res = await fetch(`${baseUrl}/models`, {
          headers: { accept: 'application/json', ...providerHeaders(baseUrl, cfg.apiKey, 'diagnose-models') },
          signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
        });
        const text = await res.text();
        const models = res.ok ? parseModelIds(tryParseJson(text)) : [];
        steps.push({
          id: 'models',
          label: '模型列表 GET /models',
          ok: res.ok && models.length > 0,
          detail: res.ok
            ? models.length > 0
              ? `${models.length} 个模型可用`
              : '返回内容里没有可识别的模型'
            : `HTTP ${res.status}：${providerMessage(text)}`,
        });
      } catch (error) {
        steps.push({ id: 'models', label: '模型列表 GET /models', ok: false, detail: safeMessage(error) });
      }
    }

    if (wellFormed && hasKey) {
      const started = Date.now();
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...providerHeaders(baseUrl, cfg.apiKey, 'diagnose-chat') },
          body: JSON.stringify({
            model: cfg.model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            stream: false,
          }),
          signal: AbortSignal.timeout(Math.min(Math.max(cfg.timeoutMs, 5_000), 30_000)),
        });
        const text = await res.text();
        steps.push({
          id: 'chat',
          label: `对话请求 POST /chat/completions（模型 ${cfg.model}）`,
          ok: res.ok,
          detail: res.ok ? `HTTP ${res.status}（${Date.now() - started}ms）` : `HTTP ${res.status}：${providerMessage(text)}`,
        });
      } catch (error) {
        steps.push({ id: 'chat', label: '对话请求 POST /chat/completions', ok: false, detail: safeMessage(error) });
      }
    }

    let host = '';
    try {
      host = new URL(baseUrl).hostname.toLowerCase();
    } catch {
      // 非法 URL 已由「配置检查」步骤报出。
    }
    if ((host === 'opencode.ai' || host.endsWith('.opencode.ai')) && hasKey) {
      try {
        const res = await fetch('https://opencode.ai/console/api/v2/config', {
          headers: {
            accept: 'application/json',
            ...providerHeaders('https://opencode.ai/console', cfg.apiKey, 'diagnose-plan'),
          },
          signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
        });
        const text = await res.text();
        if (!res.ok) {
          steps.push({
            id: 'opencode-plan',
            label: 'OpenCode 工作区套餐',
            ok: false,
            detail: `HTTP ${res.status}：${providerMessage(text)}`,
          });
        } else {
          const entries = parseConsoleProviderEntries(tryParseJson(text));
          const hasGo = entries.some((entry) => /go/i.test(entry.id));
          steps.push({
            id: 'opencode-plan',
            label: 'OpenCode 工作区套餐',
            ok: hasGo,
            detail:
              entries.length > 0
                ? `可用 provider：${entries.map((entry) => `${entry.id}（${entry.modelCount} 个模型）`).join(' / ')}${hasGo ? '' : '（未列出 Go）'}`
                : '未解析到 provider 列表',
          });
        }
      } catch (error) {
        steps.push({ id: 'opencode-plan', label: 'OpenCode 工作区套餐', ok: false, detail: safeMessage(error) });
      }
    }

    const chatOk = steps.find((step) => step.id === 'chat')?.ok ?? false;
    return { ok: chatOk, verdict: summariseLlmDiagnosis(steps), steps };
  });

  app.get('/api/settings/data-sources', async () => {
    const stored = getRepo().getSettings();
    const slots = DATA_SOURCE_SLOTS.map((slot) => ({
      slot: slot.slot,
      market: slot.market,
      kind: slot.kind,
      label: slot.label,
      current: maskDataSourceChoice(stored.dataSources[slot.slot]),
      options: SOURCE_CATALOGUE.filter(
        (entry) => entry.markets.includes(slot.market) && entry.kinds.includes(slot.kind),
      ).sort((a, b) => a.priority - b.priority) as DataSourceCatalogueEntry[],
    }));
    return { slots, providers: SOURCE_CATALOGUE, webSearch: maskDataSourceChoice(stored.dataSources.webSearch) };
  });

  app.post('/api/settings/data-sources/probe', async (request) => {
    const stored = getRepo().getSettings();
    const providers = new Set<SourceId>();
    for (const slot of DATA_SOURCE_SLOTS) {
      const choice = stored.dataSources[slot.slot];
      if (!choice || choice.enabled === false) continue;
      if (choice.provider === 'auto') {
        providers.add('eastmoney');
        providers.add('tencent');
      } else {
        providers.add(choice.provider as SourceId);
      }
    }
    if (stored.dataSources.webSearch?.enabled !== false) {
      const web = stored.dataSources.webSearch?.provider;
      if (!web || web === 'auto') providers.add('bing');
      else providers.add(web as SourceId);
    }
    // Frozen contract (docs/API.md §2): a BARE array, not `{ items, total }`.
    return Promise.all([...providers].map((provider) => probeProvider(provider, stored)));
  });
}

/** Drops `undefined` entries so a partial patch never clobbers stored values. */
function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    out[key] = item;
  }
  return out as Partial<T>;
}

/**
 * Per-slot tri-state for `dataSources.*.apiKey`, mirroring the top-level rule:
 * omitted or `''` = keep the stored key, `null` = clear it, non-empty = overwrite.
 * `''` must never wipe a key, because `GET /api/settings` no longer returns the
 * plaintext (a client round-tripping the masked object would otherwise erase it).
 * Mask-shaped values (`****`) are rejected: they are display artefacts, not keys.
 */
function sanitiseDataSourcePatch(
  input: NonNullable<z.infer<typeof settingsInputSchema>['dataSources']>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, choice] of Object.entries(input)) {
    if (!choice) continue;
    const next: Record<string, unknown> = {};
    if (choice.provider !== undefined) next.provider = choice.provider;
    if (choice.enabled !== undefined) next.enabled = choice.enabled;
    if (choice.apiKey === null) next.apiKey = '';
    else if (typeof choice.apiKey === 'string' && choice.apiKey !== '') {
      assertNotMaskValue(choice.apiKey);
      next.apiKey = choice.apiKey;
    }
    out[key] = next;
  }
  return out;
}

/**
 * A real credential never contains a run of asterisks; `****` (or the
 * `sk-****abcd` shape) can only be a masked preview echoed back by a client.
 * Storing it would overwrite a working key with garbage, so reject with 400.
 */
function assertNotMaskValue(value: string): void {
  if (/\*{2,}/.test(value)) {
    throw badRequest('掩码值不能作为 API Key 保存（请填写真实 Key，或省略该字段以保持不变）');
  }
}
