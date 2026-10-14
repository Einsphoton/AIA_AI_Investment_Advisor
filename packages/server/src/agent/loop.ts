/**
 * The Agent Loop — messages → LLM → tool calls → tool results → repeat.
 *
 * Guarantees:
 *  - never rejects: any failure lands in `run.status = 'error'` + `run.error`
 *  - every step is persisted (`agent_steps`) and streamed (`step`)
 *  - a failing tool becomes a structured tool message (max 3 identical failures,
 *    then the tool is withdrawn for the rest of the run)
 *  - `AGENT_MAX_TURNS` / `AGENT_MAX_TOOL_CALLS_PER_TURN` / `AGENT_MAX_STEPS`
 *    are hard caps
 *  - P0-1: the message list is compacted (`agent/context.ts`) before **every**
 *    LLM call. Shrink → drop-oldest-group → hard-trim keep the request inside
 *    `llm.contextTokens`; if even that cannot fit (e.g. the system prompt alone
 *    is larger than the budget) the run continues but logs/emits a warning with
 *    the overflow size instead of silently pretending the budget was respected.
 *  - P0-2: `request.signal` cancels the run at the next turn/tool boundary and
 *    the partial answer stays in `run.summary` (`status='error'`, `error='已取消'`).
 *    A tool call that is **already in flight** finishes (its HTTP request is not
 *    aborted mid-way); cancellation stops new work and never rewrites completed
 *    work. **Already committed writes are deliberately NOT rolled back**: they
 *    were produced by tools the run was authorised to call, the user may already
 *    have seen them, and ARCHITECTURE §4.4 records the same trade-off
 *    ("已确认的信息不丢").
 *  - P1-3: every message handed to the model is persisted (`agent_run_messages`,
 *    idx from 0); `request.resumeRunId` restarts from such a stored transcript
 *    in a **new** run row.
 *
 * Owner: agent-engine.
 */
import {
  AGENT_MAX_STEPS,
  AGENT_MAX_TOOL_CALLS_PER_TURN,
  AGENT_TOOL_CONCURRENCY,
  AGENT_MAX_TURNS,
  AGENT_MIN_RECENT_TURNS,
  AGENT_OUTPUT_RESERVE_TOKENS,
  AGENT_RESUME_EXTRA_TURNS,
  DEFAULT_LLM,
  DEFAULT_PERSONA,
  DEFAULT_REPORT_STYLE,
  type AgentEvent,
  type AgentRun,
  type AgentStep,
  type ChatMessage,
} from '@aia/shared';
import type { AgentDeps, AgentRunRequest, EventSink } from '../types/agent.js';
import type { RunMessageRow, RunRow } from '../types/models.js';
import { createLlmClient, LlmError, NOT_CONFIGURED_MESSAGE, type LlmClient, type LlmMessage, type LlmToolSchema } from './llm.js';
import { compactContext } from './context.js';
import { buildSystemPrompt, personaSummary } from './prompts.js';
import { executeTool, llmToolSchemas, riskOfTool, type AllowWrite, type ToolContext } from './tools.js';
import { randomUUID } from 'node:crypto';

const DEFAULT_WRITES: Record<string, AllowWrite[]> = {
  'asset-analysis': ['asset', 'briefing'],
  'watchlist-analysis': ['watchlist'],
  advice: ['advice', 'briefing'],
  chat: ['asset', 'watchlist', 'advice', 'briefing'],
  scheduled: ['asset', 'watchlist', 'advice', 'briefing'],
  custom: [],
};

/** P0-2: `run.error` / SSE `error` text once the run has been cancelled. */
const CANCELLED_ERROR = '已取消';
const CANCELLED_MESSAGE = '已取消（用户中断或连接断开）';
/** Tool replies synthesised for calls that were never executed (pairing). */
const CANCELLED_TOOL_RESULT = '[已取消] 该工具调用未执行（运行已取消）。';
const STEP_CAP_TOOL_RESULT = '[未执行] 达到本次运行的步骤上限，该工具调用未执行。';

interface RunSettings {
  persona: typeof DEFAULT_PERSONA;
  reportStyle: typeof DEFAULT_REPORT_STYLE;
}

function safeEmit(sink: EventSink | undefined, event: AgentEvent): void {
  try {
    sink?.(event);
  } catch {
    /* disconnected client: keep running (ARCHITECTURE §5 可中断) */
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Latest non-empty assistant text already produced (P0-2 partial result). */
function lastAssistantText(messages: LlmMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && typeof message.content === 'string' && message.content.trim()) {
      return message.content.trim();
    }
  }
  return '';
}

/** P1-3: rebuilds one LLM message from its persisted transcript row. */
function runMessageToLlmMessage(row: RunMessageRow): LlmMessage {
  const content = row.content.length > 0 ? row.content : row.role === 'tool' ? '' : null;
  const message: LlmMessage = { role: row.role, content };
  if (row.toolCalls) {
    try {
      const parsed = JSON.parse(row.toolCalls) as LlmMessage['tool_calls'];
      if (Array.isArray(parsed) && parsed.length > 0) message.tool_calls = parsed;
    } catch {
      /* corrupt row: keep the text part only */
    }
  }
  if (row.toolCallId) message.tool_call_id = row.toolCallId;
  if (row.name) message.name = row.name;
  return message;
}

function historyToMessages(history: ChatMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const message of history) {
    if (message.role === 'tool') {
      out.push({ role: 'tool', content: message.content, tool_call_id: message.toolCallId ?? undefined });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls) {
      try {
        const parsed = JSON.parse(message.toolCalls) as LlmMessage['tool_calls'];
        out.push({ role: 'assistant', content: message.content || null, tool_calls: parsed });
        continue;
      } catch {
        /* fall through: treat as plain text */
      }
    }
    out.push({ role: message.role, content: message.content });
  }
  return out;
}

/** Executes a full agent run to completion. Never rejects. */
export async function runAgent(deps: AgentDeps, request: AgentRunRequest): Promise<AgentRun> {
  const repo = deps.getRepo();
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const llmConfig = resolveLlmConfig(deps);
  const client = createLlmClient(llmConfig, deps.logger);
  const allowWrites = new Set<AllowWrite>(request.allowWrites ?? DEFAULT_WRITES[request.kind] ?? []);
  const batchId =
    request.target && request.target.startsWith('batch:') ? request.target.slice('batch:'.length) : `batch-${runId}`;
  /** P1-3: set when this run continues an earlier trajectory. */
  const resumeRunId =
    typeof request.resumeRunId === 'string' && request.resumeRunId.trim() ? request.resumeRunId.trim() : null;

  let run: RunRow;
  try {
    run = repo.createRun({
      id: runId,
      kind: request.kind,
      status: 'running',
      target: request.target ?? null,
      title: resumeRunId ? `${request.title}（续跑 ${resumeRunId.slice(0, 8)}）` : request.title,
      startedAt,
    });
  } catch (error) {
    deps.logger.error('failed to create agent run', error);
    throw error;
  }

  safeEmit(request.sink, { type: 'run-started', runId, kind: request.kind, title: request.title });

  if (!client.isConfigured()) {
    const finished = repo.updateRun(runId, {
      status: 'error',
      error: NOT_CONFIGURED_MESSAGE,
      summary: '',
      finishedAt: new Date().toISOString(),
    });
    safeEmit(request.sink, { type: 'error', message: NOT_CONFIGURED_MESSAGE });
    safeEmit(request.sink, {
      type: 'run-finished',
      runId,
      status: 'error',
      summary: '',
      error: NOT_CONFIGURED_MESSAGE,
    });
    return toAgentRun(finished ?? run, []);
  }

  let stepIndex = 0;
  const addStep = (
    label: string,
    detail: string,
    tool?: { name: string; args: string },
  ): AgentStep => {
    const row = repo.addStep({
      id: randomUUID(),
      runId,
      index: stepIndex++,
      label,
      status: 'running',
      detail,
      toolName: tool?.name ?? null,
      toolArgs: tool?.args ? truncate(tool.args, 2000) : null,
      toolResult: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    });
    const step: AgentStep = { ...row };
    safeEmit(request.sink, { type: 'step', step });
    return step;
  };

  const finishStep = (step: AgentStep, status: 'done' | 'error', detail: string, toolResult?: string): void => {
    const updated = repo.updateStep(step.id, {
      status,
      detail: truncate(detail, 1000),
      finishedAt: new Date().toISOString(),
      ...(toolResult === undefined ? {} : { toolResult: truncate(toolResult, 2000) }),
    });
    if (updated) safeEmit(request.sink, { type: 'step', step: { ...updated } });
  };

  const context: ToolContext = {
    runId,
    kind: request.kind,
    repo,
    logger: deps.logger,
    sink: request.sink ?? (() => undefined),
    allowWrites,
    target: request.target ?? null,
    sessionId: request.sessionId,
    batchId,
  };

  const settings = safeSettings(deps);
  const systemPrompt = buildSystemPrompt({
    persona: settings.persona,
    reportStyle: settings.reportStyle,
    kind: request.kind,
    extra: `【运行上下文】投资性格：${personaSummary(settings.persona)}。本次运行授权写入：${
      allowWrites.size > 0 ? [...allowWrites].join('、') : '无（仅只读）'
    }。`,
  });

  const messages: LlmMessage[] = [];
  /** P1-3: monotonically increasing index of the persisted trajectory. */
  let messageIndex = 0;

  /**
   * P1-3: persists one message of the trajectory (`agent_run_messages`), system
   * included, at index `messageIndex++`. Best effort: a storage hiccup slows
   * replay/resume down but must never kill a running analysis.
   */
  const persist = (message: LlmMessage): void => {
    const index = messageIndex;
    messageIndex += 1;
    try {
      repo.addRunMessage({
        id: randomUUID(),
        runId,
        index,
        role: message.role,
        content: typeof message.content === 'string' ? message.content : '',
        toolCalls: message.tool_calls?.length ? JSON.stringify(message.tool_calls) : null,
        toolCallId: message.tool_call_id ?? null,
        name: message.name ?? null,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      deps.logger.warn(
        `failed to persist run message #${index} of run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  /**
   * Appends a message to the live context **and** to the trajectory.
   *
   * Compaction below rewrites `messages` in place without going through `push`,
   * so the stored transcript always keeps the full, uncompacted trajectory and a
   * resumed run re-derives the exact same compacted view (deterministic).
   */
  const push = (message: LlmMessage): void => {
    messages.push(message);
    persist(message);
  };

  const appendGoal = (): void => {
    if (!request.goal) return;
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && last.content === request.goal) return;
    push({ role: 'user', content: request.goal });
  };

  if (resumeRunId) {
    // P1-3: continue from the stored transcript — nothing but `system` (only if
    // the stored trajectory has none) and an optional fresh goal is added.
    let stored: RunMessageRow[] = [];
    try {
      stored = repo.listRunMessages(resumeRunId);
    } catch (error) {
      deps.logger.warn(
        `failed to load run messages of ${resumeRunId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      stored = [];
    }
    if (stored.length === 0) {
      const message = `该运行（${resumeRunId}）没有可续跑的轨迹：未找到任何持久化消息。`;
      deps.logger.warn(`resume of run ${resumeRunId} aborted: empty transcript`);
      const failed = repo.updateRun(runId, {
        status: 'error',
        error: message,
        summary: '',
        finishedAt: new Date().toISOString(),
      });
      safeEmit(request.sink, { type: 'error', message });
      safeEmit(request.sink, { type: 'run-finished', runId, status: 'error', summary: '', error: message });
      return toAgentRun(failed ?? run, []);
    }
    const restored = stored.map(runMessageToLlmMessage);
    if (restored[0]?.role !== 'system') push({ role: 'system', content: systemPrompt });
    for (const message of restored) push(message);
    appendGoal();
  } else if (request.kind === 'chat' && request.messages?.length) {
    push({ role: 'system', content: systemPrompt });
    for (const message of historyToMessages(request.messages)) push(message);
    appendGoal();
  } else {
    push({ role: 'system', content: systemPrompt });
    push({ role: 'user', content: request.goal });
  }

  // P1-3: a resumed run gets a smaller default budget of new turns.
  const defaultTurns = resumeRunId ? AGENT_RESUME_EXTRA_TURNS : AGENT_MAX_TURNS;
  const maxTurns = Math.max(1, Math.min(request.maxTurns ?? defaultTurns, AGENT_MAX_TURNS));
  const allTools = llmToolSchemas(request.kind, [...allowWrites]);
  const withdrawn = new Set<string>();
  const failureCounts = new Map<string, number>();

  let turns = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let finalText = '';
  let runError: string | null = null;
  let converged = false;
  let errorEmitted = false;
  /** P0-2: set as soon as `request.signal` aborted. */
  let cancelled = false;
  /** P0-1: how often this run had to compact its context. */
  let compactionCount = 0;
  /** Latest fully received assistant text (partial result on cancel). */
  let latestText = '';
  /** Text streamed during the current turn (partial result mid-stream). */
  let streamedText = '';
  const isAborted = (): boolean => request.signal?.aborted === true;

  try {
    while (turns < maxTurns && stepIndex < AGENT_MAX_STEPS) {
      // P0-2: never start another turn once the client hung up.
      if (isAborted()) {
        cancelled = true;
        runError = CANCELLED_ERROR;
        break;
      }
      turns += 1;
      streamedText = '';
      safeEmit(request.sink, {
        type: 'progress',
        runId,
        done: turns,
        total: maxTurns,
        label: `第 ${turns}/${maxTurns} 轮推理`,
      });

      const activeTools: LlmToolSchema[] = allTools.filter((tool) => !withdrawn.has(tool.function.name));

      // P0-1: deterministic compaction right before the request goes out.
      const compacted = compactContext(messages, {
        budgetTokens: llmConfig.contextTokens,
        tools: activeTools.length > 0 ? activeTools : undefined,
        minRecentTurns: AGENT_MIN_RECENT_TURNS,
        outputReserveTokens: AGENT_OUTPUT_RESERVE_TOKENS,
      });
      if (compacted.compacted) {
        compactionCount += 1;
        messages.length = 0;
        messages.push(...compacted.messages);
        deps.logger.info(
          `context compacted (#${compactionCount}, run ${runId}, turn ${turns}): ${compacted.beforeTokens} → ${compacted.afterTokens} tokens, dropped ${compacted.droppedTurns} turns, shrunk ${compacted.shrunkenToolResults} tool results, hard-trimmed ${compacted.hardTrimmedMessages}`,
        );
        const compactStep = addStep(
          '上下文压缩',
          `上下文压缩（${compacted.beforeTokens} → ${compacted.afterTokens} tokens，省略 ${compacted.droppedTurns} 轮，强制裁剪 ${compacted.hardTrimmedMessages} 条）`,
        );
        finishStep(
          compactStep,
          'done',
          `保留 ${messages.length} 条消息（预算 ${llmConfig.contextTokens} tokens，预留输出 ${AGENT_OUTPUT_RESERVE_TOKENS}）`,
        );
      }
      // D3: surface an unresolvable overflow instead of silently overshooting.
      if (compacted.overflowTokens > 0) {
        deps.logger.warn(
          `context still over budget by ${compacted.overflowTokens} tokens (run ${runId}, turn ${turns}, budget ${llmConfig.contextTokens})`,
        );
        const overStep = addStep(
          '上下文超预算',
          `压缩后仍超出预算 ${compacted.overflowTokens} tokens（上下文 ${compacted.afterTokens} / 预算 ${llmConfig.contextTokens}）；请求仍会发出，但可能被模型拒绝或截断。请调大「上下文预算」或减少持仓/标的数量。`,
        );
        finishStep(overStep, 'error', `超出 ${compacted.overflowTokens} tokens`);
      }

      const step = addStep(`LLM 推理（第 ${turns} 轮）`, `发送 ${messages.length} 条消息，可用工具 ${activeTools.length} 个`);

      let result;
      try {
        result = await client.chat({
          messages,
          tools: activeTools.length > 0 ? activeTools : undefined,
          signal: request.signal,
          onDelta: (delta) => {
            streamedText += delta;
            safeEmit(request.sink, { type: 'text', runId, delta });
          },
          // P3: inference telemetry (TTFT / tokens / KV-cache hits) of this turn.
          onMetrics: (metrics) => {
            if (!request.sink) return;
            safeEmit(request.sink, { type: 'metrics', runId, metrics: { ...metrics, turn: turns } });
          },
        });
      } catch (error) {
        const message = error instanceof LlmError ? error.message : error instanceof Error ? error.message : String(error);
        if (isAborted()) {
          cancelled = true;
          runError = CANCELLED_ERROR;
          finishStep(step, 'error', CANCELLED_MESSAGE);
          safeEmit(request.sink, { type: 'error', message: CANCELLED_MESSAGE });
        } else {
          finishStep(step, 'error', message);
          runError = message;
          safeEmit(request.sink, { type: 'error', message });
        }
        errorEmitted = true;
        break;
      }

      promptTokens += result.promptTokens;
      completionTokens += result.completionTokens;
      const resultText = result.content.trim();
      if (resultText) latestText = resultText;
      finishStep(
        step,
        'done',
        `返回 ${result.content.length} 字、${result.toolCalls.length} 个工具调用（tokens: ${result.promptTokens}+${result.completionTokens}${
          result.cachedTokens > 0 ? `，KV cache 命中 ${result.cachedTokens}` : ''
        }${result.ttftMs !== null ? `，首字 ${result.ttftMs}ms` : ''}）`,
      );

      if (result.toolCalls.length === 0) {
        finalText = resultText;
        converged = true;
        break;
      }

      const calls = result.toolCalls.slice(0, AGENT_MAX_TOOL_CALLS_PER_TURN);
      push({
        role: 'assistant',
        content: result.content || null,
        tool_calls: calls,
      });

      const answered = new Set<string>();

      /**
       * Executes one tool call and returns its transcript entry **without**
       * pushing it: the driver pushes results in the model's original order, so
       * parallel batches still produce a deterministic, replayable transcript.
       */
      const runCall = async (
        call: (typeof calls)[number],
      ): Promise<{ call: (typeof calls)[number]; content: string } | null> => {
        const name = call.function.name;
        let parsedArgs: unknown = {};
        try {
          parsedArgs = call.function.arguments ? (JSON.parse(call.function.arguments) as unknown) : {};
        } catch {
          parsedArgs = { _raw: truncate(call.function.arguments, 200) };
        }
        const toolStep = addStep(
          `调用工具 ${name}`,
          typeof parsedArgs === 'object' && parsedArgs !== null
            ? Object.entries(parsedArgs as Record<string, unknown>)
                .map(([key, value]) => `${key}=${typeof value === 'string' ? truncate(value, 60) : JSON.stringify(value)?.slice(0, 60)}`)
                .join(' ')
            : '',
          { name, args: call.function.arguments ?? '{}' },
        );
        safeEmit(request.sink, { type: 'tool-call', runId, id: call.id, name, args: parsedArgs });

        const outcome = await executeTool(name, call.function.arguments ?? '{}', context);
        safeEmit(request.sink, {
          type: 'tool-result',
          runId,
          id: call.id,
          name,
          ok: outcome.ok,
          summary: outcome.summary,
        });
        finishStep(toolStep, outcome.ok ? 'done' : 'error', outcome.summary, outcome.content);

        if (outcome.ok) {
          failureCounts.set(name, 0);
        } else {
          const count = (failureCounts.get(name) ?? 0) + 1;
          failureCounts.set(name, count);
          if (count >= 3) {
            withdrawn.add(name);
            deps.logger.warn(`tool ${name} withdrawn after ${count} consecutive failures`);
          }
        }

        return {
          call,
          content:
            !outcome.ok && failureCounts.get(name)! >= 3
              ? `${outcome.content}\n\n[系统提示] 工具 ${name} 已连续失败 3 次，本工具已停用；请基于已有信息作答，并在结论中说明该数据缺失。`
              : outcome.content,
        };
      };

      // P2: read/external tools of one assistant message run concurrently (bounded),
      // while write tools act as barriers and keep their original order — the model
      // legitimately emits several independent lookups per turn, which used to be
      // executed strictly one after another.
      let callIndex = 0;
      while (callIndex < calls.length) {
        if (stepIndex >= AGENT_MAX_STEPS) break;
        if (isAborted()) {
          // P0-2: no new tool call once cancelled (its step is never created).
          cancelled = true;
          runError = CANCELLED_ERROR;
          break;
        }

        const batch: (typeof calls)[number][] = [];
        while (
          callIndex < calls.length &&
          batch.length < AGENT_TOOL_CONCURRENCY &&
          riskOfTool(calls[callIndex]!.function.name) !== 'write'
        ) {
          batch.push(calls[callIndex]!);
          callIndex += 1;
        }
        if (batch.length === 0) {
          // Barriered call (write / approval-gated): always run alone, in order.
          batch.push(calls[callIndex]!);
          callIndex += 1;
        }

        const results =
          batch.length === 1
            ? [await runCall(batch[0]!)]
            : await Promise.all(batch.map((call) => runCall(call)));

        for (const entry of results) {
          if (!entry) continue;
          push({ role: 'tool', tool_call_id: entry.call.id, name: entry.call.function.name, content: entry.content });
          answered.add(entry.call.id);
        }
      }

      // An `assistant` message carrying tool_calls must always be followed by a
      // reply for every call: the API rejects incomplete pairs and a later
      // `resume` (P1-3) would inherit them. Cancelled / skipped calls get a stub.
      for (const call of calls) {
        if (answered.has(call.id)) continue;
        push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: isAborted() ? CANCELLED_TOOL_RESULT : STEP_CAP_TOOL_RESULT,
        });
      }

      if (cancelled) break;
    }
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
    deps.logger.error('agent loop crashed', error);
  }

  // P0-2: an abort that landed while the last turn was still running, and the
  // loop then stopped for another reason (turn/step cap), is still a cancel.
  if (!cancelled && !converged && isAborted()) {
    cancelled = true;
    runError = runError ?? CANCELLED_ERROR;
  }

  if (!finalText) {
    // P0-2: a cancelled run keeps the text it already produced — the answer
    // streamed during the interrupted turn wins, then the last full answer, then
    // the last assistant message still in context.
    finalText = streamedText.trim() || latestText || lastAssistantText(messages);
  }

  if (!runError && !finalText) {
    // The model kept calling tools until the cap without ever concluding.
    runError = `达到最大推理轮次（${maxTurns}）仍未给出最终结论，请重试或缩小分析范围。`;
    deps.logger.warn(`run ${runId} hit the turn cap without a final answer (turns=${turns})`);
  }

  const hitTurnCap = !runError && !converged;
  const summary = hitTurnCap && finalText ? `${finalText}\n\n（注：已达最大推理轮次 ${maxTurns}，结论可能未完全收敛。）` : finalText;

  if (runError && !errorEmitted) {
    safeEmit(request.sink, { type: 'error', message: runError });
  }

  const finished = repo.updateRun(runId, {
    status: runError ? 'error' : 'done',
    error: runError,
    summary: truncate(summary, 8000),
    turns,
    promptTokens,
    completionTokens,
    finishedAt: new Date().toISOString(),
  });

  safeEmit(request.sink, {
    type: 'run-finished',
    runId,
    status: runError ? 'error' : 'done',
    summary: truncate(summary, 4000),
    error: runError,
  });

  deps.logger.info(
    `agent run ${runId} finished (${runError ? 'error' : 'done'}${cancelled ? ', cancelled' : ''}) after ${turns} turns, ${compactionCount} context compaction(s)`,
  );

  return toAgentRun(finished ?? run, repo.listSteps(runId));
}

function toAgentRun(row: RunRow, steps: AgentStep[]): AgentRun {
  return { ...row, steps: steps.map((step) => ({ ...step })) };
}

function safeSettings(deps: AgentDeps): RunSettings {
  try {
    const settings = deps.getRepo().getSettings();
    return { persona: settings.persona, reportStyle: settings.reportStyle };
  } catch {
    return { persona: DEFAULT_PERSONA, reportStyle: DEFAULT_REPORT_STYLE };
  }
}

/** Stored settings win; env vars are the fallback (config.ts seeds them). */
export function resolveLlmConfig(deps: AgentDeps): {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  fastModel: string;
  timeoutMs: number;
  contextTokens: number;
} {
  let stored: Partial<{
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: number;
    fastModel: string;
    timeoutMs: number;
    contextTokens: number;
  }> = {};
  try {
    stored = deps.getRepo().getSettings().llm ?? {};
  } catch {
    stored = {};
  }
  const env = process.env;
  return {
    baseUrl: stored.baseUrl || env.LLM_BASE_URL || 'https://api.deepseek.com/v1',
    apiKey: stored.apiKey || env.LLM_API_KEY || '',
    model: stored.model || env.LLM_MODEL || 'deepseek-flash',
    temperature: typeof stored.temperature === 'number' ? stored.temperature : 0.3,
    maxTokens: typeof stored.maxTokens === 'number' && stored.maxTokens > 0 ? stored.maxTokens : 8192,
    fastModel: stored.fastModel || '',
    timeoutMs: typeof stored.timeoutMs === 'number' && stored.timeoutMs > 0 ? stored.timeoutMs : 180_000,
    /** P0-1: context budget handed to `compactContext` before every LLM call. */
    contextTokens:
      typeof stored.contextTokens === 'number' && stored.contextTokens > 0
        ? stored.contextTokens
        : DEFAULT_LLM.contextTokens,
  };
}

export type { LlmClient };
