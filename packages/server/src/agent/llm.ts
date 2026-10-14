/**
 * OpenAI-compatible chat/completions client (DeepSeek / OpenAI / Moonshot /
 * Qwen / Ollama…). Pure `fetch`, no SDK.
 *
 * Features: function-calling, streaming (`delta` callbacks), AbortController
 * timeout, HTTP errors normalized into human-readable Chinese messages.
 *
 * P0-2: `ChatRequest.signal` is linked to the request for the whole exchange —
 * including the streamed body read — so a cancelled run stops immediately and
 * surfaces as `LlmError('已取消（用户中断或连接断开）', 'LLM_ABORTED')`.
 *
 * P2: transient upstream failures (429 / 408 / 5xx / network) are retried with
 * exponential backoff + jitter, honouring `Retry-After`; cancellation and
 * deterministic 4xx errors are never retried.
 *
 * P3: every request reports TTFT / latency / token usage / prompt-cache hits via
 * `ChatRequest.onMetrics` — the agent loop forwards them as `metrics` SSE events
 * so the UI can show inference telemetry while the model is thinking.
 *
 * Owner: agent-engine.
 */
import { DEFAULT_LLM, LLM_MAX_RETRIES, LLM_RETRY_BASE_MS, type InferenceMetrics, type LlmConfig } from '@aia/shared';
import type { LoggerLike } from '../types/agent.js';

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface LlmToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/**
 * One LLM request's inference metrics, as reported to the agent loop. Same shape
 * as the `metrics` SSE event minus `turn` (the loop knows the turn, the client
 * library does not).
 */
export type LlmRequestMetrics = Omit<InferenceMetrics, 'turn'>;

export interface ChatRequest {
  messages: LlmMessage[];
  tools?: LlmToolSchema[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Called for every streamed content delta. */
  onDelta?: (delta: string) => void;
  /**
   * Called twice per request: once when the first streamed delta arrives
   * (`phase: 'first-token'`, TTFT known) and once when the request settles
   * (`phase: 'done'`, usage + speed final). Never called on failure.
   */
  onMetrics?: (metrics: LlmRequestMetrics) => void;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  toolCalls: LlmToolCall[];
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from the provider's prompt/KV cache. */
  cachedTokens: number;
  /** Time to first token (ms); null for non-streamed responses. */
  ttftMs: number | null;
  /** Total request wall time (ms). */
  latencyMs: number;
  finishReason: string;
  model: string;
  /** True when the response arrived as a stream. */
  streamed: boolean;
}

export class LlmError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(message: string, code = 'LLM_ERROR', status: number | null = null) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.status = status;
  }
}

export interface LlmClient {
  isConfigured(): boolean;
  config(): Required<LlmConfig>;
  chat(request: ChatRequest): Promise<ChatResult>;
  /** Minimal ping used by `POST /api/settings/test-llm`. */
  ping(): Promise<{ ok: boolean; model: string; latencyMs: number; message: string }>;
}

export const NOT_CONFIGURED_MESSAGE =
  '未配置 API Key：请在「设置 → LLM」中填写 OpenAI 兼容的 baseUrl 与 apiKey（例如 DeepSeek）。';

/** P0-2: message + code used for every abort (client cancel / connection drop). */
export const LLM_ABORTED_MESSAGE = '已取消（用户中断或连接断开）';
export const LLM_ABORTED_CODE = 'LLM_ABORTED';

function normalizeConfig(raw: Partial<LlmConfig> | undefined): Required<LlmConfig> {
  return {
    baseUrl: (raw?.baseUrl || DEFAULT_LLM.baseUrl).replace(/\/+$/, ''),
    apiKey: raw?.apiKey ?? '',
    model: raw?.model || DEFAULT_LLM.model,
    temperature: typeof raw?.temperature === 'number' ? raw.temperature : DEFAULT_LLM.temperature,
    maxTokens: typeof raw?.maxTokens === 'number' && raw.maxTokens > 0 ? raw.maxTokens : DEFAULT_LLM.maxTokens,
    fastModel: raw?.fastModel ?? '',
    timeoutMs: typeof raw?.timeoutMs === 'number' && raw.timeoutMs > 0 ? raw.timeoutMs : DEFAULT_LLM.timeoutMs,
    contextTokens:
      typeof raw?.contextTokens === 'number' && raw.contextTokens > 0 ? raw.contextTokens : DEFAULT_LLM.contextTokens,
  };
}

/**
 * Pulls the human-readable message out of a provider's error body, so an auth
 * failure reads as「厂商返回：Invalid credential」instead of a raw JSON dump.
 * Covers OpenAI (`{error:{message}}`), OpenCode/Anthropic
 * (`{error:{type,message}}` 与 `{type,error:{message}}`), and plain text / HTML.
 */
export function providerMessage(body: string): string {
  const text = (body ?? '').trim();
  if (text === '') return '';
  try {
    const found = digMessage(JSON.parse(text) as unknown);
    if (found !== '') return found.length > 300 ? found.slice(0, 300) : found;
  } catch {
    // Not JSON (HTML error page / plain text) → fall back to a trimmed slice.
  }
  return text.slice(0, 300);
}

function digMessage(payload: unknown, depth = 0): string {
  if (depth > 3 || !payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  for (const key of ['error', 'message', 'detail']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (value && typeof value === 'object') {
      const nested = digMessage(value, depth + 1);
      if (nested !== '') return nested;
    }
  }
  return '';
}

/**
 * Maps an HTTP failure into a stable `LlmError`. Exported so the mapping can be
 * unit-tested without a live provider.
 *
 * 402 is deliberately separated: per OpenCode's billing docs, paid requests fail
 * with 402 once the workspace balance hits zero (`Insufficient account funds`) or
 * when a Go limit is reached without Extra usage / an invoice is overdue. That is
 * a billing state, not a bad key, so the message must say so.
 */
export function readableHttpError(status: number, body: string): LlmError {
  const detail = providerMessage(body);
  const snippet = detail === '' ? '' : ` 厂商返回：${detail}`;
  if (status === 401 || status === 403) {
    return new LlmError(`LLM 认证失败（HTTP ${status}）：API Key 无效或无权访问该模型。${snippet}`, 'LLM_AUTH', status);
  }
  if (status === 402) {
    return new LlmError(
      `LLM 账户余额或套餐额度不足（HTTP 402）：API Key 本身有效，是计费状态被拒——请在服务商控制台确认订阅是否生效、额度是否用尽、余额是否为零。${snippet}`,
      'LLM_PAYMENT',
      status,
    );
  }
  if (status === 404) {
    return new LlmError(`LLM 接口不存在（HTTP 404）：请检查 baseUrl 与模型名。${snippet}`, 'LLM_NOT_FOUND', status);
  }
  if (status === 429) {
    return new LlmError(`LLM 触发限流（HTTP 429）：请稍后重试或更换模型。${snippet}`, 'LLM_RATE_LIMIT', status);
  }
  if (status >= 500) {
    return new LlmError(`LLM 上游错误（HTTP ${status}）：${snippet}`, 'LLM_UPSTREAM', status);
  }
  return new LlmError(`LLM 请求失败（HTTP ${status}）：${snippet}`, 'LLM_HTTP', status);
}

/** Usage block of one response; every field is optional because providers differ. */
interface LlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** OpenAI / OpenCode: `prompt_tokens_details.cached_tokens`. */
  prompt_tokens_details?: { cached_tokens?: number } | null;
  /** DeepSeek: explicit hit/miss split of `prompt_tokens`. */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  /** Anthropic-style gateways. */
  cache_read_input_tokens?: number;
}

/**
 * Prompt tokens the provider served from its prompt/KV cache.
 *
 * Providers spell this differently and all three shapes appear in the wild
 * (OpenCode/OpenAI `prompt_tokens_details.cached_tokens`, DeepSeek
 * `prompt_cache_hit_tokens`, Anthropic proxies `cache_read_input_tokens`), so we
 * read whichever one is present. Missing / non-numeric values become 0, which
 * makes the UI show「—」instead of a made-up hit rate.
 */
export function cachedTokensFromUsage(usage: LlmUsage | null | undefined): number {
  if (!usage) return 0;
  const candidates = [
    usage.prompt_tokens_details?.cached_tokens,
    usage.prompt_cache_hit_tokens,
    usage.cache_read_input_tokens,
  ];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return 0;
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: LlmUsage | null;
  model?: string;
  error?: { message?: string };
}

export const APP_USER_AGENT = 'ai-investment-advisor/0.1';

/**
 * Headers for every outbound LLM call.
 *
 * Two custom headers are deliberate:
 * - `user-agent`：各网关都要求客户端表明身份（而不是伪装成某个 SDK / HTTP 库）。
 * - `x-opencode-session`：OpenCode（Console 与 Go 订阅）要求同一轮对话带上稳定的
 *   会话 ID，用于路由与 prompt 缓存优化；见 opencode.ai/v2/docs/console/go
 *   「Identify itself with its own user agent / Send a stable session ID」。
 *   其它厂商不需要这个头，因此只在 opencode.ai 域名上发送。
 */
export function providerHeaders(baseUrl: string, apiKey: string, sessionId: string): Record<string, string> {
  const headers: Record<string, string> = { 'user-agent': APP_USER_AGENT };
  if (apiKey.trim() !== '') headers.authorization = `Bearer ${apiKey.trim()}`;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === 'opencode.ai' || host.endsWith('.opencode.ai')) headers['x-opencode-session'] = sessionId;
  } catch {
    // Malformed baseUrl: the caller surfaces a readable error on the fetch itself.
  }
  return headers;
}

export function createLlmClient(configInput: Partial<LlmConfig> | undefined, logger?: LoggerLike): LlmClient {
  const config = normalizeConfig(configInput);
  /** Stable per client instance, i.e. per run/conversation for OpenCode routing. */
  const sessionId = globalThis.crypto.randomUUID();

  /**
   * One abort scope per logical LLM request. It links the caller's `signal` (user
   * cancel / SSE disconnect), the per-request timeout and the `fetch` abort in a
   * single `AbortController`.
   *
   * The scope must outlive `sendHttp`: a streamed answer is read long after the
   * response headers arrive, so aborting must still interrupt the body read.
   * `dispose()` therefore runs in a `finally` around the whole request.
   */
  interface HttpScope {
    readonly signal: AbortSignal;
    /** True when the *caller* aborted (as opposed to our own timeout). */
    externalAborted(): boolean;
    timedOut(): boolean;
    dispose(): void;
  }

  function createHttpScope(external?: AbortSignal): HttpScope {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('timeout'));
    }, config.timeoutMs);
    const onAbort = (): void => controller.abort(external?.reason);
    external?.addEventListener('abort', onAbort, { once: true });
    if (external?.aborted) controller.abort(external.reason);
    return {
      signal: controller.signal,
      externalAborted: () => external?.aborted === true,
      timedOut: () => timedOut,
      dispose: () => {
        clearTimeout(timer);
        external?.removeEventListener('abort', onAbort);
      },
    };
  }

  /** Normalizes every aborted/failed request into a stable `LlmError`. */
  function toAbortError(error: unknown, scope: HttpScope): LlmError | null {
    if (error instanceof LlmError) return error.code === LLM_ABORTED_CODE ? error : null;
    if (scope.externalAborted()) return new LlmError(LLM_ABORTED_MESSAGE, LLM_ABORTED_CODE);
    if (scope.timedOut()) return new LlmError(`LLM 请求超时（${config.timeoutMs} ms）`, 'LLM_TIMEOUT');
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return new LlmError(LLM_ABORTED_MESSAGE, LLM_ABORTED_CODE);
    }
    return null;
  }

  /** Retries for transient upstream failures (429/5xx/network). */
  const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

  function isRetryable(error: unknown, scope: HttpScope): boolean {
    if (scope.externalAborted() || scope.timedOut()) return false;
    if (error instanceof LlmError) {
      if (error.code === LLM_ABORTED_CODE) return false;
      if (typeof error.status === 'number') return RETRYABLE_STATUSES.has(error.status);
      return error.code === 'LLM_NETWORK';
    }
    return false;
  }

  /** `Retry-After` (seconds or HTTP date), capped so a hostile header cannot stall us. */
  function retryAfterMs(response: Response): number | null {
    const raw = response.headers.get('retry-after');
    if (!raw) return null;
    const seconds = Number.parseFloat(raw);
    if (Number.isFinite(seconds)) return Math.min(Math.max(0, seconds) * 1000, 30_000);
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 30_000);
    return null;
  }

  /** Sleeps, but wakes immediately (and throws) when the request is cancelled. */
  function backoffSleep(ms: number, scope: HttpScope): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        scope.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new LlmError(LLM_ABORTED_MESSAGE, LLM_ABORTED_CODE));
      };
      scope.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function sendHttp(payload: Record<string, unknown>, stream: boolean, scope: HttpScope): Promise<Response> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt += 1) {
      try {
        const response = await fetch(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: stream ? 'text/event-stream' : 'application/json',
            ...providerHeaders(config.baseUrl, config.apiKey, sessionId),
          },
          body: JSON.stringify(payload),
          signal: scope.signal,
        });
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          const httpError = readableHttpError(response.status, body);
          // 429 / 5xx are transient: retry with backoff (honouring Retry-After).
          if (RETRYABLE_STATUSES.has(response.status) && attempt < LLM_MAX_RETRIES) {
            const wait = retryAfterMs(response) ?? Math.round(LLM_RETRY_BASE_MS * 2 ** attempt * (1 + Math.random() * 0.3));
            logger?.warn?.(
              `LLM ${response.status}（第 ${attempt + 1}/${LLM_MAX_RETRIES} 次重试），${wait}ms 后重试：${httpError.message.slice(0, 120)}`,
            );
            lastError = httpError;
            await backoffSleep(wait, scope);
            continue;
          }
          throw httpError;
        }
        return response;
      } catch (error) {
        if (error instanceof LlmError && error.code === LLM_ABORTED_CODE) throw error;
        const abortError = toAbortError(error, scope);
        if (abortError) throw abortError;
        const normalized =
          error instanceof LlmError
            ? error
            : new LlmError(
                `无法连接 LLM（${config.baseUrl}）：${error instanceof Error ? error.message : String(error)}`,
                'LLM_NETWORK',
              );
        lastError = normalized;
        if (!isRetryable(normalized, scope) || attempt >= LLM_MAX_RETRIES) throw normalized;
        const wait = Math.round(LLM_RETRY_BASE_MS * 2 ** attempt * (1 + Math.random() * 0.3));
        logger?.warn?.(`LLM 请求失败（第 ${attempt + 1}/${LLM_MAX_RETRIES} 次重试），${wait}ms 后重试：${normalized.message.slice(0, 120)}`);
        await backoffSleep(wait, scope);
      }
    }
    throw lastError instanceof LlmError
      ? lastError
      : new LlmError('LLM 请求失败（已重试）', 'LLM_NETWORK');
  }

  /**
   * Per-request inference metrics: `firstToken()` fires once when the first
   * streamed delta lands (TTFT), `done()` when the request settles (usage +
   * generation speed). Both are best-effort: a throwing consumer must never
   * break a run, so the calls are wrapped.
   */
  interface MetricsTracker {
    firstToken(model?: string): void;
    done(usage: { model: string; promptTokens: number; completionTokens: number; cachedTokens: number }): LlmRequestMetrics;
    readonly ttftMs: number | null;
  }

  function createMetricsTracker(
    onMetrics: ChatRequest['onMetrics'],
    fallbackModel: string,
  ): MetricsTracker {
    const startedAt = Date.now();
    let ttftMs: number | null = null;
    const emit = (metrics: LlmRequestMetrics): void => {
      try {
        onMetrics?.(metrics);
      } catch (error) {
        logger?.warn?.(`metrics sink threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    return {
      get ttftMs() {
        return ttftMs;
      },
      firstToken(model?: string): void {
        if (ttftMs !== null) return;
        ttftMs = Date.now() - startedAt;
        emit({
          phase: 'first-token',
          model: model || fallbackModel,
          ttftMs,
          latencyMs: null,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          tokensPerSecond: null,
        });
      },
      done(usage): LlmRequestMetrics {
        const latencyMs = Date.now() - startedAt;
        // Speed is measured from the first token, i.e. pure generation time.
        const generationMs = ttftMs === null ? latencyMs : Math.max(1, latencyMs - ttftMs);
        const metrics: LlmRequestMetrics = {
          phase: 'done',
          model: usage.model || fallbackModel,
          ttftMs,
          latencyMs,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          // A provider must never report more cached tokens than prompt tokens.
          cachedTokens: Math.max(0, Math.min(usage.cachedTokens, usage.promptTokens)),
          tokensPerSecond:
            usage.completionTokens > 0 ? Math.round((usage.completionTokens / (generationMs / 1000)) * 10) / 10 : null,
        };
        emit(metrics);
        return metrics;
      },
    };
  }

  async function chat(request: ChatRequest): Promise<ChatResult> {
    if (!config.apiKey) throw new LlmError(NOT_CONFIGURED_MESSAGE, 'NOT_CONFIGURED', 400);
    const model = request.model || config.model;
    const basePayload: Record<string, unknown> = {
      model,
      messages: request.messages,
      temperature: request.temperature ?? config.temperature,
      max_tokens: request.maxTokens ?? config.maxTokens,
    };
    if (request.tools && request.tools.length > 0) {
      basePayload.tools = request.tools;
      basePayload.tool_choice = 'auto';
    }

    // The scope keeps `request.signal` wired for the whole exchange, including
    // the streamed body read (P0-2: cancel must stop a running answer).
    const scope = createHttpScope(request.signal);
    const tracker = createMetricsTracker(request.onMetrics, model);
    try {
      try {
        return await streamChat(request, basePayload, model, scope, tracker);
      } catch (error) {
        const abortError = toAbortError(error, scope);
        if (abortError) throw abortError;
        // Some OpenAI-compatible servers reject stream_options/stream; retry once, plain.
        if (error instanceof LlmError && (error.status === 400 || error.code === 'LLM_HTTP')) {
          logger?.warn?.('llm stream failed, retrying without streaming', error.message);
          const retryScope = createHttpScope(request.signal);
          try {
            return await plainChat(request, basePayload, model, retryScope, tracker);
          } catch (retryError) {
            throw toAbortError(retryError, retryScope) ?? retryError;
          } finally {
            retryScope.dispose();
          }
        }
        throw error;
      }
    } finally {
      scope.dispose();
    }
  }

  async function streamChat(
    request: ChatRequest,
    payload: Record<string, unknown>,
    model: string,
    scope: HttpScope,
    tracker: MetricsTracker,
  ): Promise<ChatResult> {
    const response = await sendHttp(
      { ...payload, stream: true, stream_options: { include_usage: true } },
      true,
      scope,
    );
    if (!response.body) return await plainChat(request, payload, model, scope, tracker);

    let content = '';
    let finishReason = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;
    let resolvedModel = model;
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payloadText = line.slice(5).trim();
        if (payloadText === '[DONE]') continue;
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(payloadText) as StreamChunk;
        } catch {
          continue;
        }
        if (chunk.error?.message) throw new LlmError(`LLM 流式响应错误：${chunk.error.message}`, 'LLM_STREAM');
        if (chunk.model) resolvedModel = chunk.model;
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
          completionTokens = chunk.usage.completion_tokens ?? completionTokens;
          cachedTokens = cachedTokensFromUsage(chunk.usage) || cachedTokens;
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          // TTFT: measured on the first token of this request, not on headers.
          tracker.firstToken(resolvedModel);
          content += delta.content;
          request.onDelta?.(delta.content);
        }
        if ((delta.tool_calls?.length ?? 0) > 0) tracker.firstToken(resolvedModel);
        for (const call of delta.tool_calls ?? []) {
          const index = call.index ?? toolAcc.size;
          const current = toolAcc.get(index) ?? { id: '', name: '', args: '' };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name += call.function.name;
          if (call.function?.arguments) current.args += call.function.arguments;
          toolAcc.set(index, current);
        }
      }
    }

    const toolCalls: LlmToolCall[] = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, value]) => value.name)
      .map(([index, value], order) => ({
        id: value.id || `call_${index}_${order}`,
        type: 'function',
        function: { name: value.name, arguments: value.args || '{}' },
      }));

    if (content.length === 0 && toolCalls.length === 0) throw new LlmError('LLM 返回了空响应', 'LLM_EMPTY');
    const metrics = tracker.done({ model: resolvedModel, promptTokens, completionTokens, cachedTokens });
    return {
      content,
      toolCalls,
      promptTokens,
      completionTokens,
      cachedTokens: metrics.cachedTokens,
      ttftMs: metrics.ttftMs,
      latencyMs: metrics.latencyMs ?? 0,
      finishReason: finishReason || 'stop',
      model: resolvedModel,
      streamed: true,
    };
  }

  async function plainChat(
    request: ChatRequest,
    payload: Record<string, unknown>,
    model: string,
    scope: HttpScope,
    tracker: MetricsTracker,
  ): Promise<ChatResult> {
    const response = await sendHttp(payload, false, scope);
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: LlmToolCall[] }; finish_reason?: string }>;
      usage?: LlmUsage;
      model?: string;
      error?: { message?: string };
    };
    if (json.error?.message) throw new LlmError(`LLM 返回错误：${json.error.message}`, 'LLM_HTTP');
    const choice = json.choices?.[0];
    const content = choice?.message?.content ?? '';
    if (content) request.onDelta?.(content);
    const promptTokens = json.usage?.prompt_tokens ?? 0;
    const completionTokens = json.usage?.completion_tokens ?? 0;
    const metrics = tracker.done({
      model: json.model ?? model,
      promptTokens,
      completionTokens,
      cachedTokens: cachedTokensFromUsage(json.usage),
    });
    return {
      content,
      toolCalls: choice?.message?.tool_calls ?? [],
      promptTokens,
      completionTokens,
      cachedTokens: metrics.cachedTokens,
      ttftMs: metrics.ttftMs,
      latencyMs: metrics.latencyMs ?? 0,
      finishReason: choice?.finish_reason ?? 'stop',
      model: json.model ?? model,
      streamed: false,
    };
  }

  async function ping(): Promise<{ ok: boolean; model: string; latencyMs: number; message: string }> {
    const started = Date.now();
    if (!config.apiKey) {
      return { ok: false, model: config.model, latencyMs: 0, message: NOT_CONFIGURED_MESSAGE };
    }
    try {
      const scope = createHttpScope();
      try {
        const result = await plainChat(
          { messages: [{ role: 'user', content: 'ping' }] },
          { model: config.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, temperature: 0 },
          config.model,
          scope,
          createMetricsTracker(undefined, config.model),
        );
        return {
          ok: true,
          model: result.model,
          latencyMs: Date.now() - started,
          message: `连接成功（${result.model}）`,
        };
      } finally {
        scope.dispose();
      }
    } catch (error) {
      return {
        ok: false,
        model: config.model,
        latencyMs: Date.now() - started,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    isConfigured: () => config.apiKey.trim().length > 0,
    config: () => config,
    chat,
    ping,
  };
}
