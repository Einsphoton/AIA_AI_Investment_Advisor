/**
 * P0-1 context governance tests — deterministic, no LLM, no network.
 *
 * Owner: agent-engine. Covers docs/ARCHITECTURE.md §4.4: token estimation,
 * budget handling, the `system`-message and recent-turn invariants, the
 * `[已压缩]` / `[历史压缩]` markers and the assistant↔tool pairing invariant.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_OLD_TOOL_RESULT_CHARS } from '@aia/shared';

import { compactContext, countMessagesTokens, estimateTokens } from '../src/agent/context.js';
import type { LlmMessage, LlmToolSchema } from '../src/agent/llm.js';

const SYSTEM = '你是一名严谨的投资顾问，所有结论必须有工具数据支撑。';
const HISTORY_NOTE = '[历史压缩] 已省略 3 轮更早的推理与工具结果，如需请重新调用工具获取。';

/* ────────────────────────────── helpers ───────────────────────────────────── */

interface TurnSpec {
  user: string;
  assistant: string;
  toolName: string;
  toolChars: number;
  ok?: boolean;
}

/** CJK filler of exactly `chars` characters (≈ 1 token per character). */
function filler(chars: number, label: string): string {
  return `${label}：${'数据分析'.repeat(Math.ceil(chars / 4) + 1)}`.slice(0, chars);
}

function specCount(
  count: number,
  opts: { userChars?: number; assistantChars?: number; toolChars: number; toolName?: string; from?: number },
): TurnSpec[] {
  const from = opts.from ?? 0;
  return Array.from({ length: count }, (_, offset) => {
    const turn = from + offset + 1;
    return {
      user: filler(opts.userChars ?? 60, `第 ${turn} 轮提问`),
      assistant: filler(opts.assistantChars ?? 60, `第 ${turn} 轮草稿`),
      toolName: opts.toolName ?? 'get_quote',
      toolChars: opts.toolChars,
    };
  });
}

/** Well-formed history: every `tool` message answers the `assistant` before it. */
function conversation(system: string, specs: TurnSpec[]): LlmMessage[] {
  const messages: LlmMessage[] = [{ role: 'system', content: system }];
  specs.forEach((spec, index) => {
    const id = `call_${index + 1}`;
    messages.push({ role: 'user', content: spec.user });
    messages.push({
      role: 'assistant',
      content: spec.assistant,
      tool_calls: [{ id, type: 'function', function: { name: spec.toolName, arguments: `{"turn":${index + 1}}` } }],
    });
    messages.push({
      role: 'tool',
      tool_call_id: id,
      name: spec.toolName,
      content: JSON.stringify({ ok: spec.ok !== false, turn: index + 1, payload: 'x'.repeat(spec.toolChars) }),
    });
  });
  return messages;
}

/**
 * 10 huge tool-heavy turns + 2 small recent turns. Well above any budget below,
 * and the protected (recent) turns are small, so dropping always reaches the
 * budget while droppable groups are left over.
 */
function budgetBustingConversation(): LlmMessage[] {
  return conversation(SYSTEM, [
    ...specCount(10, { userChars: 200, assistantChars: 200, toolChars: 3000 }),
    ...specCount(2, { userChars: 50, assistantChars: 50, toolChars: 100, from: 10 }),
  ]);
}

function isHistoryNote(message: LlmMessage): boolean {
  return message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('[历史压缩]');
}

/** Hard invariant 5: no `tool` message without the `assistant` that requested it. */
function assertNoOrphanTools(messages: LlmMessage[]): void {
  const requested = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) requested.add(call.id);
      continue;
    }
    if (message.role !== 'tool') continue;
    assert.ok(message.tool_call_id, 'tool 消息必须带 tool_call_id');
    assert.ok(
      requested.has(message.tool_call_id!),
      `孤儿 tool 消息：${message.tool_call_id} 没有前置 assistant.tool_calls`,
    );
  }
}

const droppedCount = (content: string): number => Number.parseInt(/已省略\s*(\d+)\s*轮/.exec(content)?.[1] ?? '0', 10);

/* ──────────────────────────── token estimation ────────────────────────────── */

test('estimateTokens: 空串为 0、单调不减、CJK≈1/字、ASCII≈1/4', () => {
  assert.equal(estimateTokens(''), 0);

  // Monotone over every prefix of a mixed string.
  let previous = 0;
  let accumulated = '';
  for (const char of '你好abc世界123投资顾问🚀') {
    accumulated += char;
    const current = estimateTokens(accumulated);
    assert.ok(current >= previous, `estimateTokens("${accumulated}")=${current} < ${previous}`);
    previous = current;
  }

  assert.equal(estimateTokens('中文'), 2);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('a'.repeat(400)), 100);
  assert.equal(estimateTokens('x'.repeat(1000)), 250);

  // Longer text never scores lower than a shorter *prefix* of it.
  const samples = ['', 'a', 'ab', 'hello world', 'a你b好c', '你好，世界！', '中文'.repeat(50)];
  for (const longer of samples) {
    for (const shorter of samples) {
      if (!longer.startsWith(shorter)) continue;
      assert.ok(estimateTokens(longer) >= estimateTokens(shorter), `"${longer}" vs "${shorter}"`);
    }
  }
});

test('countMessagesTokens: tool schema 与消息开销都计入', () => {
  const messages: LlmMessage[] = [{ role: 'user', content: '你好' }];
  const plain = countMessagesTokens(messages);
  assert.ok(plain > estimateTokens('你好'), '消息结构本身也占 token');

  const tools: LlmToolSchema[] = [
    {
      type: 'function',
      function: { name: 'get_quote', description: '获取行情', parameters: { type: 'object', properties: { code: { type: 'string' } } } },
    },
  ];
  const withTools = countMessagesTokens(messages, tools);
  assert.ok(withTools > plain, 'tool schema 必须计入预算');
  assert.equal(withTools - plain, estimateTokens(JSON.stringify(tools[0])));

  assert.ok(countMessagesTokens([{ role: 'user', content: '你好'.repeat(20) }]) > plain);
});

/* ────────────────────────────── compaction ────────────────────────────────── */

test('compactContext: 预算内的输入不压缩，且不改动入参', () => {
  const messages = conversation(SYSTEM, specCount(3, { toolChars: 100 }));
  const snapshot = structuredClone(messages);
  const result = compactContext(messages, { budgetTokens: 48_000 });

  assert.equal(result.compacted, false);
  assert.equal(result.droppedTurns, 0);
  assert.equal(result.shrunkenToolResults, 0);
  assert.equal(result.afterTokens, result.beforeTokens);
  assert.deepEqual(result.messages, messages);
  assert.deepEqual(messages, snapshot, '输入数组与消息不得被就地修改');
});

test('compactContext: 超预算时压缩旧工具结果并丢弃最老整组，system 永不改动', () => {
  const messages = budgetBustingConversation();
  const before = countMessagesTokens(messages);
  const budget = 4000;
  const result = compactContext(messages, { budgetTokens: budget, outputReserveTokens: 0, minRecentTurns: 2 });

  assert.equal(result.beforeTokens, before);
  assert.ok(result.afterTokens < result.beforeTokens, '压缩必须真的减少 token');
  assert.ok(result.afterTokens <= budget, `afterTokens=${result.afterTokens} > budget=${budget}`);
  assert.equal(result.compacted, true);
  assert.ok(result.shrunkenToolResults > 0, '更早的工具结果应被压缩');
  assert.ok(result.droppedTurns > 0, '仍超预算时应丢弃最老的整组');

  // Rule 1: the system message survives unchanged, still first and unique.
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[0].content, SYSTEM);
  assert.equal(result.messages.filter((message) => message.role === 'system').length, 1);

  // Rule 2: the N most recent user turns are byte-for-byte identical.
  assert.deepEqual(result.messages.slice(-6), messages.slice(-6));

  // Rule 5: no orphan tool message survived the drop.
  assertNoOrphanTools(result.messages);

  // Rule 4: exactly one synthetic notice, carrying the dropped turn count.
  const notes = result.messages.filter(isHistoryNote);
  assert.equal(notes.length, 1);
  assert.equal(
    String(notes[0].content),
    `[历史压缩] 已省略 ${result.droppedTurns} 轮更早的推理与工具结果，如需请重新调用工具获取。`,
  );
});

test('compactContext: 旧工具结果压缩到 ≤600 字并保留标记、工具名与 ok/fail', () => {
  const longOk = JSON.stringify({ ok: true, payload: '数据'.repeat(2000) });
  const longFail = JSON.stringify({ error: 'network', message: '取数失败', details: '失败'.repeat(2000) });
  const recentTool = JSON.stringify({ ok: true, payload: '最近一轮'.repeat(50) });
  const messages: LlmMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: '第一轮' },
    { role: 'assistant', content: '成功轮', tool_calls: [{ id: 'call_ok', type: 'function', function: { name: 'get_quote', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_ok', name: 'get_quote', content: longOk },
    { role: 'user', content: '第二轮' },
    { role: 'assistant', content: '失败轮', tool_calls: [{ id: 'call_fail', type: 'function', function: { name: 'get_news', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_fail', name: 'get_news', content: longFail },
    { role: 'user', content: '第三轮（最近，原样保留）' },
    { role: 'assistant', content: '最近一轮', tool_calls: [{ id: 'call_recent', type: 'function', function: { name: 'get_series', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_recent', name: 'get_series', content: recentTool },
  ];

  const result = compactContext(messages, { budgetTokens: 2500, outputReserveTokens: 0, minRecentTurns: 1 });
  assert.equal(result.compacted, true);
  assert.equal(result.shrunkenToolResults, 2);
  assert.equal(result.droppedTurns, 0);

  const shrunk = result.messages.filter((message) => message.role === 'tool' && String(message.content).includes('[已压缩]'));
  assert.equal(shrunk.length, 2);
  for (const message of shrunk) {
    const content = String(message.content);
    assert.ok(content.length <= AGENT_OLD_TOOL_RESULT_CHARS, `${content.length} > ${AGENT_OLD_TOOL_RESULT_CHARS}`);
    assert.ok(content.includes(message.name!), '必须保留工具名');
    assert.match(content, / (ok|fail)\]/);
  }
  assert.match(String(shrunk.find((message) => message.name === 'get_quote')?.content), /^\[已压缩\] \[tool=get_quote ok\] /);
  assert.match(String(shrunk.find((message) => message.name === 'get_news')?.content), /^\[已压缩\] \[tool=get_news fail\] /);

  // The most recent turn is untouched — big tool result included.
  assert.equal(result.messages.find((message) => message.tool_call_id === 'call_recent')?.content, recentTool);
  assert.equal(result.messages.filter(isHistoryNote).length, 0, '仅压缩工具结果时不插入历史说明');

  assertNoOrphanTools(result.messages);
  assert.equal(result.messages[0].content, SYSTEM);
});

test('compactContext: 单条 [历史压缩] 说明被更新（轮次累加）而非重复插入', () => {
  const messages: LlmMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: HISTORY_NOTE },
    ...budgetBustingConversation().slice(1),
  ];

  const first = compactContext(messages, { budgetTokens: 4000, outputReserveTokens: 0, minRecentTurns: 2 });
  assert.ok(first.droppedTurns > 0);
  const firstNotes = first.messages.filter(isHistoryNote);
  assert.equal(firstNotes.length, 1, '只能存在一条合成说明');
  assert.equal(droppedCount(String(firstNotes[0].content)), 3 + first.droppedTurns, '轮次应累加到既有说明上');
  assertNoOrphanTools(first.messages);

  const second = compactContext(first.messages, {
    budgetTokens: Math.floor(first.afterTokens / 2),
    outputReserveTokens: 0,
    minRecentTurns: 2,
  });
  const secondNotes = second.messages.filter(isHistoryNote);
  assert.equal(secondNotes.length, 1, '再次压缩不得插入第二条说明');
  assert.ok(second.droppedTurns >= 0);
  assert.ok(droppedCount(String(secondNotes[0].content)) >= 3 + first.droppedTurns);
  assertNoOrphanTools(second.messages);
});

test('compactContext: 预算极小也保得住 system 与最近轮次（能丢的都丢完为止）', () => {
  const messages = conversation(SYSTEM, specCount(6, { toolChars: 4000 }));
  const result = compactContext(messages, { budgetTokens: 50, outputReserveTokens: 0, minRecentTurns: 4 });

  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[0].content, SYSTEM);
  assert.deepEqual(result.messages.slice(-12), messages.slice(-12), '最近 4 轮必须原样保留');
  assertNoOrphanTools(result.messages);
});

test('compactContext: 孤儿 tool 消息（缺 assistant 配对）不会出现在输出里', () => {
  const messages: LlmMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: '问题' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_quote', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', name: 'get_quote', content: '{}' },
    // Orphan: its assistant message is gone (transcript written by an older build).
    { role: 'tool', tool_call_id: 'call_gone', name: 'get_quote', content: '{"stale":true}' },
  ];
  const result = compactContext(messages, { budgetTokens: 48_000 });
  assert.ok(result.compacted, '修复孤儿消息也算一次丢弃');
  assert.equal(result.messages.some((message) => message.tool_call_id === 'call_gone'), false);
  assertNoOrphanTools(result.messages);
});

test('compactContext: 完全确定性（同一输入两次结果一致）', () => {
  const messages = budgetBustingConversation();
  const options = { budgetTokens: 4000, outputReserveTokens: 1024, minRecentTurns: 3 };
  const first = compactContext(messages, options);
  const second = compactContext(structuredClone(messages), options);

  assert.equal(first.compacted, true);
  assert.deepEqual(second, first);
  assert.deepEqual(compactContext(structuredClone(messages), options), first);
});

test('compactContext: 首轮（system+user）也能安全工作', () => {
  const messages: LlmMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: '请分析我的持仓' },
  ];
  const result = compactContext(messages, { budgetTokens: 48_000, tools: [] });
  assert.equal(result.compacted, false);
  assert.deepEqual(result.messages, messages);
  assert.equal(result.afterTokens, result.beforeTokens);
});

test('D3: 保护窗口本身超预算时如实报告 overflowTokens，且不裁剪最近轮次', () => {
  // The protected recent turns alone cannot fit a tiny budget, so compaction
  // cannot converge — the contract is then to *say so* (overflowTokens > 0)
  // rather than silently overshoot, and to keep those turns byte-for-byte intact.
  const messages = conversation(SYSTEM, specCount(6, { toolChars: 4000 }));
  const result = compactContext(messages, { budgetTokens: 200, outputReserveTokens: 0, minRecentTurns: 4 });

  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[0].content, SYSTEM);
  assert.deepEqual(result.messages.slice(-12), messages.slice(-12), '最近 4 轮不得被强制裁剪');
  assertNoOrphanTools(result.messages);
  assert.ok(result.overflowTokens > 0, '超预算必须如实报告 overflowTokens');
  assert.equal(result.afterTokens, 200 + result.overflowTokens, 'afterTokens 必须与 overflowTokens 自洽');
});

test('D3: 预算充足时不报告溢出，也不做无谓压缩', () => {
  const messages = conversation(SYSTEM, specCount(2, { toolChars: 200 }));
  const result = compactContext(messages, { budgetTokens: 48_000 });
  assert.equal(result.overflowTokens, 0);
  assert.equal(result.compacted, false);
  assert.deepEqual(result.messages, messages);
});

test('D4: assistant.tool_calls 缺少结果时补 [已取消] 占位（resume 后请求仍合法）', () => {
  const messages: LlmMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: '分析' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'get_quote', arguments: '{}' } },
        { id: 'call_b', type: 'function', function: { name: 'get_series', arguments: '{}' } },
      ],
    },
    // Only the first call got a result: the run was cancelled in between.
    { role: 'tool', tool_call_id: 'call_a', name: 'get_quote', content: '{"price":1}' },
  ];
  const result = compactContext(messages, { budgetTokens: 48_000 });
  assertNoOrphanTools(result.messages);
  const tools = result.messages.filter((message) => message.role === 'tool');
  assert.equal(tools.length, 2, '缺失的结果必须补齐');
  const byId = new Map(tools.map((message) => [message.tool_call_id, String(message.content)]));
  assert.equal(byId.get('call_a'), '{"price":1}', '已有结果必须原样保留');
  assert.match(byId.get('call_b') ?? '', /已取消/, '缺失的调用必须补占位');
});
