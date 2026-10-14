/**
 * Context governance (P0-1) — deterministic, LLM-free token estimation and
 * history compaction for the agent loop.
 *
 * Contract (docs/ARCHITECTURE.md §4.4, docs/API.md §3):
 *  1. `system` messages are **never** modified or dropped.
 *  2. The most recent `minRecentTurns` user turns stay byte-for-byte intact.
 *  3. When compaction runs, every older `tool` result shrinks to at most
 *     `AGENT_OLD_TOOL_RESULT_CHARS` characters and is prefixed with `[已压缩]`,
 *     keeping the tool name and the ok/fail status so the model still knows the
 *     data once existed.
 *  4. Still over budget → drop the oldest whole assistant-tool_calls groups and
 *     insert/update exactly one `[历史压缩] …` notice.
 *  5. The assistant↔tool pairing invariant is repaired **both ways**: orphan
 *     `tool` messages are dropped, and a `tool_calls` entry with no result gets
 *     a synthetic `[已取消]` result (a cancelled run can leave that gap).
 *  6. No LLM, no randomness, no clock: the same input always yields the same
 *     output, so a resumed run (P1-3) rebuilds exactly what the model saw.
 *
 * Budget: `budgetTokens - outputReserveTokens` (the reserve pays for the model's
 * own answer). Tool schemas count towards it, because they are part of the
 * request. When the estimate exceeds the budget we shrink → drop → **hard-trim**
 * (step 3); the result reports `overflowTokens > 0` when even that cannot fit
 * (e.g. the system prompt alone is larger than the budget), so callers can warn
 * instead of pretending the request fits.
 *
 * Owner: agent-engine (P0-1); step-3 hard trim and the reverse pairing repair
 * were added by Lead after independent verification found D3/D4.
 */
import {
  AGENT_MIN_RECENT_TURNS,
  AGENT_OLD_TOOL_RESULT_CHARS,
  AGENT_OUTPUT_RESERVE_TOKENS,
} from '@aia/shared';
import type { LlmMessage, LlmToolSchema } from './llm.js';

/** Prefix added to a shrunk historical tool result. */
export const COMPACTED_TOOL_MARKER = '[已压缩]';
/** Prefix of the single synthetic notice describing dropped history. */
export const DROPPED_HISTORY_MARKER = '[历史压缩]';
/** Placeholder result for a tool call that never ran (cancelled / capped run). */
export const CANCELLED_TOOL_MARKER = '[已取消]';
/** Floor a message content is trimmed to by the hard pass (D3). */
const HARD_TRIM_FLOOR_CHARS = 400;

/** Token cost of one message's framing (`role`, separators, …). */
const MESSAGE_OVERHEAD_TOKENS = 4;
/** Tokens per ASCII character (≈ 4 chars per token). */
const ASCII_TOKENS_PER_CHAR = 0.25;
/** Longest tool name echoed back into a shrunk result. */
const MAX_TOOL_NAME_CHARS = 48;
/** Matches the notice so a second pass updates it instead of adding another. */
const DROPPED_COUNT_PATTERN = /已省略\s*(\d+)\s*轮/;

export interface CompactOptions {
  /** Total context window of the model (e.g. `llm.contextTokens`). */
  budgetTokens: number;
  /** Tool schemas sent with the request; they consume budget too. */
  tools?: LlmToolSchema[];
  /** Most recent user turns kept verbatim (default `AGENT_MIN_RECENT_TURNS`). */
  minRecentTurns?: number;
  /** Tokens reserved for the answer (default `AGENT_OUTPUT_RESERVE_TOKENS`). */
  outputReserveTokens?: number;
}

export interface CompactResult {
  messages: LlmMessage[];
  /** True only when something was really shrunk or dropped. */
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
  /** Number of whole assistant+tool groups dropped by this call. */
  droppedTurns: number;
  /** Number of historical tool results shrunk by this call. */
  shrunkenToolResults: number;
  /**
   * D3: tokens still exceeding the budget after the hard-trim pass. `> 0` means
   * the request WILL be over budget (the system prompt plus one minimum message
   * cannot be compressed further) — the caller must log/emit a warning instead
   * of silently pretending the budget was respected.
   */
  overflowTokens: number;
  /** D3: messages force-trimmed by the hard pass (recent results included). */
  hardTrimmedMessages: number;
}

/** East-Asian wide code points that cost ≈ 1 token per character. */
function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK radicals / Kangxi / CJK punctuation
    (code >= 0x3041 && code <= 0x33ff) || // Kana, CJK compatibility
    (code >= 0x3400 && code <= 0x4dbf) || // CJK ext A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
    (code >= 0xa000 && code <= 0xa4cf) || // Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK compatibility forms
    (code >= 0xff00 && code <= 0xff60) || // Fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3ffff) // CJK ext B+
  );
}

/**
 * Rough token estimate: CJK/wide characters ≈ 1 token each, ASCII ≈ 1/4 token,
 * other code points (emoji, accented letters, …) ≈ 1 token. Rounded up, so the
 * estimate is monotone: a longer text never scores lower than a shorter one.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let wide = 0;
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) ascii += 1;
    else if (isWideCodePoint(code)) wide += 1;
    else other += 1;
  }
  return Math.ceil(wide + other + ascii * ASCII_TOKENS_PER_CHAR);
}

function messageTokens(message: LlmMessage): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS;
  if (typeof message.content === 'string') tokens += estimateTokens(message.content);
  if (message.name) tokens += estimateTokens(message.name);
  if (message.tool_call_id) tokens += estimateTokens(message.tool_call_id) + 2;
  for (const call of message.tool_calls ?? []) {
    tokens +=
      estimateTokens(call.id ?? '') +
      estimateTokens(call.function?.name ?? '') +
      estimateTokens(call.function?.arguments ?? '') +
      8;
  }
  return tokens;
}

/** Token estimate of a whole request body (messages + tool schemas). */
export function countMessagesTokens(messages: LlmMessage[], tools?: LlmToolSchema[]): number {
  let total = 0;
  for (const message of messages) total += messageTokens(message);
  for (const tool of tools ?? []) total += estimateTokens(JSON.stringify(tool));
  return total;
}

/** `ok` / `fail` keyword kept in a shrunk tool result. */
function toolStatus(content: string): 'ok' | 'fail' {
  if (/"ok"\s*:\s*false/.test(content)) return 'fail';
  if (/"errors?"\s*:/.test(content)) return 'fail';
  if (/^\s*(?:错误|失败|无法)/.test(content)) return 'fail';
  return 'ok';
}

/** Shrinks one historical tool result to `AGENT_OLD_TOOL_RESULT_CHARS` chars. */
function shrinkToolResult(content: string, name: string | undefined): string {
  const tool = (name ?? 'unknown').slice(0, MAX_TOOL_NAME_CHARS);
  const prefix = `${COMPACTED_TOOL_MARKER} [tool=${tool} ${toolStatus(content)}] `;
  const room = Math.max(0, AGENT_OLD_TOOL_RESULT_CHARS - prefix.length - 1);
  if (room === 0) return prefix.slice(0, AGENT_OLD_TOOL_RESULT_CHARS);
  return `${prefix}${content.slice(0, room)}…`;
}

function cloneMessage(message: LlmMessage): LlmMessage {
  const copy: LlmMessage = { role: message.role, content: message.content };
  if (message.tool_calls) copy.tool_calls = message.tool_calls.map((call) => ({ ...call, function: { ...call.function } }));
  if (message.tool_call_id !== undefined) copy.tool_call_id = message.tool_call_id;
  if (message.name !== undefined) copy.name = message.name;
  return copy;
}

function isHistoryNote(message: LlmMessage): boolean {
  return message.role === 'user' && typeof message.content === 'string' && message.content.startsWith(DROPPED_HISTORY_MARKER);
}

/**
 * A droppable unit: one `assistant` message that requested tool calls plus every
 * `tool` message answering it. They are removed together or not at all.
 */
interface ToolGroup {
  assistant: number;
  tools: number[];
}

function collectToolGroups(messages: LlmMessage[]): ToolGroup[] {
  const groups: ToolGroup[] = [];
  let current: ToolGroup | null = null;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.tool_calls?.length) {
      current = { assistant: index, tools: [] };
      groups.push(current);
      continue;
    }
    if (message.role === 'tool') {
      if (current) current.tools.push(index);
      continue;
    }
    current = null;
  }
  return groups;
}

/**
 * Drops `tool` messages that have no preceding `assistant.tool_calls` to answer
 * (a hard invariant: every OpenAI-compatible API rejects such a request, and a
 * resumed transcript must stay valid). Pairing is by id, with a positional
 * fallback for transcripts written before ids were persisted.
 */
/**
 * Repairs the assistant↔tool pairing in both directions:
 *  - drops `tool` messages whose `assistant.tool_calls` counterpart is gone;
 *  - inserts a synthetic `[已取消]` tool result for every `assistant.tool_calls`
 *    entry that has no result (a cancelled run can leave such a gap, and an
 *    OpenAI-compatible request with an unanswered call is rejected outright).
 *
 * Pairing is strictly by id. This is a hard invariant: every API rejects
 * mismatched pairs, and a resumed transcript must stay valid.
 */
function repairOrphanTools(messages: LlmMessage[]): { messages: LlmMessage[]; dropped: number; filled: number } {
  // Pass 1 — keep only tool messages that answer a real, still-unanswered call.
  const callIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.tool_calls ?? []) if (call.id) callIds.add(call.id);
  }
  const out: LlmMessage[] = [];
  const answered = new Set<string>();
  let dropped = 0;
  for (const message of messages) {
    if (message.role !== 'tool') {
      out.push(message);
      continue;
    }
    const id = message.tool_call_id;
    if (!id || !callIds.has(id) || answered.has(id)) {
      dropped += 1;
      continue;
    }
    answered.add(id);
    out.push(message);
  }

  // Pass 2 — fill unanswered calls so the request stays valid after a cancel.
  const final: LlmMessage[] = [];
  let filled = 0;
  for (const message of out) {
    final.push(message);
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    for (const call of message.tool_calls) {
      if (!call.id || answered.has(call.id)) continue;
      answered.add(call.id);
      filled += 1;
      final.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function?.name,
        content: `${CANCELLED_TOOL_MARKER} 该工具调用未执行（运行被中断或达到步数上限）。`,
      });
    }
  }
  return { messages: final, dropped, filled };
}

function parseDroppedCount(content: string): number {
  const match = DROPPED_COUNT_PATTERN.exec(content);
  const parsed = match ? Number.parseInt(match[1], 10) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Compacts a message list so it fits the context budget. Pure & deterministic:
 * the input array and its messages are never mutated.
 */
export function compactContext(messages: LlmMessage[], options: CompactOptions): CompactResult {
  const minRecentTurns = Math.max(0, options.minRecentTurns ?? AGENT_MIN_RECENT_TURNS);
  const outputReserveTokens = Math.max(0, options.outputReserveTokens ?? AGENT_OUTPUT_RESERVE_TOKENS);
  const budget = Math.max(0, options.budgetTokens - outputReserveTokens);
  const tools = options.tools;

  const beforeTokens = countMessagesTokens(messages, tools);
  let work = messages.map((message) => cloneMessage(message));

  // Recent turns are protected: everything from the `minRecentTurns`-th newest
  // user message onwards is untouchable (system messages always are).
  const userIndexes: number[] = [];
  work.forEach((message, index) => {
    if (message.role === 'user' && !isHistoryNote(message)) userIndexes.push(index);
  });
  const protectFrom = userIndexes.length > 0 ? userIndexes[Math.max(0, userIndexes.length - minRecentTurns)] : work.length;
  // Capture the protected window by identity *before* any mutation: step 2
  // rewrites `work`, so a later `slice(protectFrom)` would point at the wrong
  // messages (that is exactly the bug the hard-trim pass must not repeat).
  const protectedMessages = new Set<LlmMessage>(work.slice(protectFrom));

  let shrunkenToolResults = 0;
  let droppedTurns = 0;

  if (beforeTokens > budget) {
    // Step 1 — shrink every historical tool result (never the recent turns).
    for (let index = 0; index < protectFrom; index += 1) {
      const message = work[index];
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : '';
      if (content.length <= AGENT_OLD_TOOL_RESULT_CHARS) continue;
      message.content = shrinkToolResult(content, message.name);
      shrunkenToolResults += 1;
    }

    // Step 2 — still over budget: drop the oldest whole assistant+tool groups.
    if (countMessagesTokens(work, tools) > budget) {
      // Room is reserved for the notice that replaces the dropped history, so the
      // final list (notice included) really stays inside the budget.
      const noticeTokens = work.some(isHistoryNote)
        ? 0
        : messageTokens({
            role: 'user',
            content: `${DROPPED_HISTORY_MARKER} 已省略 00 轮更早的推理与工具结果，如需请重新调用工具获取。`,
          });
      const dropped = new Set<number>();
      let remaining = work;
      for (const group of collectToolGroups(work)) {
        if (countMessagesTokens(remaining, tools) + noticeTokens <= budget) break;
        const indexes = [group.assistant, ...group.tools];
        if (indexes.some((index) => index >= protectFrom)) continue; // recent turn
        for (const index of indexes) dropped.add(index);
        droppedTurns += 1;
        remaining = work.filter((_, index) => !dropped.has(index));
      }
      if (droppedTurns > 0) {
        work = remaining;
        // Exactly one synthetic notice; a second compaction updates its count.
        const existing = work.find(isHistoryNote);
        const total = droppedTurns + (existing ? parseDroppedCount(String(existing.content)) : 0);
        const notice: LlmMessage = {
          role: 'user',
          content: `${DROPPED_HISTORY_MARKER} 已省略 ${total} 轮更早的推理与工具结果，如需请重新调用工具获取。`,
        };
        if (existing) existing.content = notice.content;
        else {
          const lastSystem = work.reduce((found, message, index) => (message.role === 'system' ? index : found), -1);
          work.splice(lastSystem + 1, 0, notice);
        }
      }
    }
  }

  // Hard invariant: repair both directions of the assistant↔tool pairing.
  let repaired = repairOrphanTools(work);

  // Step 3 (D3) — hard trim: if steps 1–2 could not reach the budget (e.g. one
  // turn with several very large tool results), shrink the largest remaining
  // bodies **outside the protected recent window** so the request converges.
  // Recent turns and the system prompt are never rewritten — contract rule 2 —
  // so callers still get a truthful `overflowTokens` when even this cannot fit.
  let hardTrimmedMessages = 0;
  if (budget > 0 && countMessagesTokens(repaired.messages, tools) > budget) {
    const trimmable = repaired.messages
      .filter(
        (message) =>
          !protectedMessages.has(message) &&
          message.role !== 'system' &&
          typeof message.content === 'string' &&
          message.content.length > HARD_TRIM_FLOOR_CHARS,
      )
      .sort((a, b) => String(b.content).length - String(a.content).length);
    for (const message of trimmable) {
      if (countMessagesTokens(repaired.messages, tools) <= budget) break;
      const content = String(message.content);
      const keep = Math.max(HARD_TRIM_FLOOR_CHARS, Math.floor(content.length / 2));
      message.content = `${content.slice(0, keep)}…${COMPACTED_TOOL_MARKER}（为满足上下文预算已强制裁剪，原始 ${content.length} 字符）`;
      hardTrimmedMessages += 1;
    }
    // Re-repair: the hard pass may have replaced a body but never a pairing.
    repaired = repairOrphanTools(repaired.messages);
  }

  const afterTokens = countMessagesTokens(repaired.messages, tools);

  return {
    messages: repaired.messages,
    compacted:
      shrunkenToolResults > 0 || droppedTurns > 0 || repaired.dropped > 0 || repaired.filled > 0 || hardTrimmedMessages > 0,
    beforeTokens,
    afterTokens,
    droppedTurns,
    shrunkenToolResults,
    overflowTokens: Math.max(0, afterTokens - budget),
    hardTrimmedMessages,
  };
}
