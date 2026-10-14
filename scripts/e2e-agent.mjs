/**
 * Real-LLM end-to-end probe (`npm run e2e:agent`).
 *
 * Uses the **configured API key from your own database** (it clones `data/` into
 * a scratch directory first, so your real data is never touched), boots the
 * server and drives the Agent through three scenarios:
 *
 *   1. chat, no tools expected      → LLM reachability + SSE + transcript
 *   2. chat that must call a tool   → real function-calling round trip
 *   3. full asset-analysis pipeline → agent loop + writes + briefing (opt-in)
 *
 * Usage:
 *   npm run e2e:agent                 # scenarios 1 + 2
 *   npm run e2e:agent -- --pipeline   # also runs the asset-analysis pipeline
 *   npm run e2e:agent -- --keep       # keep the scratch data dir for inspection
 *
 * Cost note: each scenario spends real tokens. Scenario 1–2 are one or two turns.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const runPipeline = args.includes('--pipeline');
const runCancel = args.includes('--cancel');
const keep = args.includes('--keep');
const port = Number.parseInt(process.env.E2E_PORT ?? '8791', 10);
const base = `http://127.0.0.1:${port}`;

const source = path.isAbsolute(process.env.DATA_DIR ?? '') ? process.env.DATA_DIR : path.resolve(root, process.env.DATA_DIR ?? 'data');
const scratch = path.join(root, '.e2e-data');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/* ── scratch DB (clone, so the user's data stays untouched) ────────────────── */

fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
if (!fs.existsSync(path.join(source, 'advisor.db'))) {
  console.error(`[e2e] 未找到数据库：${path.join(source, 'advisor.db')}。请先在应用里配置 API Key。`);
  process.exit(1);
}
for (const name of fs.readdirSync(source)) {
  if (name.startsWith('advisor.db')) fs.copyFileSync(path.join(source, name), path.join(scratch, name));
}
console.log(`[e2e] 已克隆数据库到 ${path.relative(root, scratch)}（你的原始数据不会被改动）`);

const server = spawn(process.execPath, ['--enable-source-maps', path.join(root, 'packages/server/dist/index.js')], {
  cwd: root,
  env: { ...process.env, PORT: String(port), DATA_DIR: scratch, NODE_ENV: 'production', LOG_LEVEL: 'error' },
  stdio: ['ignore', 'inherit', 'inherit'],
});

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/* ── SSE reader ────────────────────────────────────────────────────────────── */

async function streamPost(pathname, body, label) {
  const started = Date.now();
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    return { ok: false, status: response.status, text, events: [], ms: Date.now() - started };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const events = [];
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index !== -1) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const dataLine = chunk
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (dataLine) {
        try {
          events.push(JSON.parse(dataLine));
        } catch {
          /* ignore malformed frame */
        }
      }
      index = buffer.indexOf('\n\n');
    }
  }
  if (label) console.log(`[e2e] ${label}: ${events.length} 个事件，${Math.round((Date.now() - started) / 1000)}s`);
  return { ok: true, status: response.status, events, ms: Date.now() - started };
}

function summarize(events) {
  const counts = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  const tools = events.filter((e) => e.type === 'tool-call').map((e) => e.name);
  const toolResults = events.filter((e) => e.type === 'tool-result');
  const finished = [...events].reverse().find((e) => e.type === 'run-finished');
  const errors = events.filter((e) => e.type === 'error').map((e) => e.message);
  return { counts, text, tools, toolResults, finished, errors };
}

/* ── scenarios ─────────────────────────────────────────────────────────────── */

try {
  if (!(await waitForHealth())) {
    console.error('[e2e] 服务启动失败');
    process.exit(1);
  }
  const health = await (await fetch(`${base}/api/health`)).json();
  check('服务启动', health.ok === true, `webBuilt=${health.webBuilt}`);

  const settings = await (await fetch(`${base}/api/settings`)).json();
  check('已配置 API Key', settings.hasApiKey === true, `model=${settings.llm.model} base=${settings.llm.baseUrl}`);
  if (!settings.hasApiKey) {
    console.error('[e2e] 未配置 API Key，无法进行真实模型验证（可在设置页填写）。');
    process.exit(1);
  }

  /* 1. 纯对话（不期望工具调用） */
  const session = await (await fetch(`${base}/api/chat/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const chat = await streamPost(`/api/chat/sessions/${session.id}/messages`, { content: '请用一句话说明你能帮我做什么。不要调用任何工具。' }, 'chat');
  let info = summarize(chat.events);
  console.log(`[e2e]   events=${JSON.stringify(info.counts)} text=${info.text.length}字`);
  check('chat：SSE 事件序列完整', Boolean(info.counts['run-started']) && Boolean(info.counts['run-finished']) && Boolean(info.counts['done']));
  check('chat：得到模型文本回复', info.text.trim().length > 0, `"${info.text.trim().slice(0, 60)}…"`);
  check('chat：run 正常收尾', info.finished?.status === 'done', `status=${info.finished?.status} error=${info.finished?.error ?? 'none'}`);
  check('chat：无 error 事件', info.errors.length === 0, info.errors.join(' | ').slice(0, 200));

  /* 2. 必须调用工具 */
  const toolChat = await streamPost(`/api/chat/sessions/${session.id}/messages`, { content: '请调用 get_quote 工具查询 A 股 600519 的当前价格，然后用一句话告诉我价格。必须真的调用工具。' }, 'tool-chat');
  info = summarize(toolChat.events);
  console.log(`[e2e]   events=${JSON.stringify(info.counts)} tools=${JSON.stringify(info.tools)}`);
  check('tool：模型发起了工具调用', info.tools.length > 0, JSON.stringify(info.tools));
  check('tool：工具调用有结果返回', info.toolResults.length > 0, `${info.toolResults.length} 条`);
  check('tool：工具执行成功', info.toolResults.every((r) => r.ok === true), JSON.stringify(info.toolResults.map((r) => r.ok)));
  check('tool：最终有结论文本', info.text.trim().length > 20, `${info.text.trim().length} 字`);
  console.log(`[e2e]   结论摘录：${info.text.trim().replace(/\s+/g, ' ').slice(0, 160)}`);

  /* 3. 真实模型下的端到端取消（P0-2） */
  if (runCancel) {
    const cancelSession = await (
      await fetch(`${base}/api/chat/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    ).json();
    const controller = new AbortController();
    const response = await fetch(`${base}/api/chat/sessions/${cancelSession.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ content: '请调用多个工具（get_quote、get_series、get_fundamentals、get_news、get_macro）详细分析贵州茅台 600519，写一份 800 字的深度报告。' }),
      signal: controller.signal,
    });
    let streamed = '';
    let abortedAt = 0;
    const startedAt = Date.now();
    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        streamed += decoder.decode(value, { stream: true });
        // Abort once the model has produced some output (or after 3s), i.e. mid-run.
        if (abortedAt === 0 && (streamed.includes('"type":"text"') || Date.now() - startedAt > 3000)) {
          abortedAt = Date.now() - startedAt;
          controller.abort();
        }
      }
    } catch (error) {
      if (error?.name !== 'AbortError') console.log(`[e2e] 取消时客户端异常：${error?.message}`);
    }
    const textChars = (streamed.match(/"type":"text"/g) ?? []).length;
    console.log(`[e2e] cancel: 客户端在第 ${abortedAt}ms 断开（已收到 ${textChars} 个 text 分片、${streamed.length} 字节）`);
    check('cancel：客户端在模型产出中途断开', abortedAt > 0, `${abortedAt}ms`);

    await new Promise((r) => setTimeout(r, 4000)); // let the server finish unwinding
    const runs = await (await fetch(`${base}/api/agent/runs?limit=5`)).json();
    const cancelled = runs.find((run) => run.kind === 'chat') ?? runs[0];
    check('cancel：服务端把 run 记为已取消', cancelled?.status === 'error' && /已取消/.test(String(cancelled?.error ?? '')), `status=${cancelled?.status} error=${cancelled?.error}`);
    const trace = await (await fetch(`${base}/api/agent/runs/${cancelled?.id}/trace`)).json();
    check('cancel：轨迹里 assistant↔tool 仍成对（可续跑）', (() => {
      const calls = new Set();
      const results = new Set();
      for (const message of trace.messages ?? []) {
        if (message.role === 'assistant') for (const call of JSON.parse(message.toolCalls || '[]')) calls.add(call.id);
        if (message.role === 'tool') results.add(message.toolCallId);
      }
      return [...calls].every((id) => results.has(id));
    })(), `${trace.messages?.length ?? 0} 条消息`);
  }

  /* 4. 真实流水线（可选） */
  if (runPipeline) {
    const created = await fetch(`${base}/api/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '600519', market: 'CN', type: 'stock', shares: 100, price: 1500, tradeDate: new Date().toISOString().slice(0, 10), note: 'e2e' }),
    });
    const asset = await created.json();
    check('流水线：建仓成功', created.ok, `id=${asset.id}`);

    const pipeline = await streamPost('/api/assets/analyze', {}, 'asset-analysis');
    info = summarize(pipeline.events);
    console.log(`[e2e]   events=${JSON.stringify(info.counts)} tools=${JSON.stringify(info.tools.slice(0, 12))}`);
    check('流水线：run 正常收尾', info.finished?.status === 'done', `status=${info.finished?.status} error=${(info.finished?.error ?? '').slice(0, 200)}`);
    check('流水线：有工具调用', info.tools.length > 0, `${info.tools.length} 次`);
    const after = await (await fetch(`${base}/api/assets/${asset.id}`)).json();
    check('流水线：写回了 AI 分析结论', typeof after.aiSummary === 'string' && after.aiSummary.trim().length > 40, `${(after.aiSummary ?? '').length} 字`);
    const dashboard = await (await fetch(`${base}/api/dashboard`)).json();
    check('流水线：产生了 Dashboard 简报', Boolean(dashboard.briefing?.text), `${dashboard.briefing?.text?.length ?? 0} 字`);
    console.log(`[e2e]   简报摘录：${(dashboard.briefing?.text ?? '').replace(/\s+/g, ' ').slice(0, 160)}`);

    const runs = await (await fetch(`${base}/api/agent/runs?limit=5`)).json();
    check('流水线：run 已入库', runs.length > 0, `turns=${runs[0]?.turns} steps=${runs[0]?.stepCount} status=${runs[0]?.status}`);
    const trace = await (await fetch(`${base}/api/agent/runs/${runs[0]?.id}/trace`)).json();
    check('流水线：轨迹可回放', Array.isArray(trace.messages) && trace.messages.length > 3, `${trace.messages?.length} 条消息`);
    const audit = await (await fetch(`${base}/api/agent/audit?limit=10`)).json();
    check('流水线：写入有审计', Array.isArray(audit) && audit.length > 0, `${audit.length} 条`);
  }
} catch (error) {
  check('探针执行', false, error.stack ?? String(error));
} finally {
  try {
    server.kill();
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 500));
  if (!keep) {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* leave it behind rather than fail the run */
    }
  } else {
    console.log(`[e2e] 保留临时数据目录：${path.relative(root, scratch)}`);
  }
  console.log(`\n[e2e] ${failures === 0 ? '\x1b[32m全部通过\x1b[0m' : `\x1b[31m${failures} 项失败\x1b[0m`}`);
  process.exit(failures === 0 ? 0 : 1);
}
