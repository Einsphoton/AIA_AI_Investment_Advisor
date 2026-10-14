/**
 * Real-model agent evaluation set (`npm run eval:agent`).
 *
 * Runs a small, fixed battery of scenarios against the **configured model** and
 * scores the trajectory — not just "did it answer", but "did it call the right
 * tools, cite real numbers, and admit missing data instead of inventing it".
 *
 * Cost note: one real LLM request per scenario (4 scenarios ≈ a few cents).
 * Uses a cloned database, so your own data is never touched.
 *
 *   npm run eval:agent
 *   npm run eval:agent -- --only 3        # run a single scenario
 *   npm run eval:agent -- --keep          # keep the scratch DB for the trace tool
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const onlyIndex = argv.indexOf('--only');
const only = onlyIndex >= 0 ? Number.parseInt(argv[onlyIndex + 1] ?? '', 10) : null;
const keep = argv.includes('--keep');
const port = Number.parseInt(process.env.EVAL_PORT ?? '8792', 10);
const base = `http://127.0.0.1:${port}`;

const source = path.isAbsolute(process.env.DATA_DIR ?? '') ? process.env.DATA_DIR : path.resolve(root, process.env.DATA_DIR ?? 'data');
const scratch = path.join(root, '.eval-data');

/** Scenarios: each returns the prompt plus a scorer over the captured events. */
const SCENARIOS = [
  {
    name: 'S1 事实问答：上证指数所在市场与数据来源',
    prompt: '当前上证指数点位是多少？请给出具体数字、数据来源，并说明你没有编造。不要写投资建议。',
    score(events, text) {
      const tools = calledTools(events);
      return [
        ['调用了行情类工具', tools.some((name) => ['get_quote', 'get_macro', 'market_search'].includes(name)) || tools.includes('get_macro')],
        ['正文包含数字', /\d/.test(text)],
        ['没有编造免责声明之外的建议', !/(建议买入|建议卖出|强烈推荐)/.test(text)],
        ['run 正常完成', finished(events)?.status === 'done'],
      ];
    },
  },
  {
    name: 'S2 工具精度：必须核实代码再报价',
    prompt: '我想了解 00700 这只票的实时价格与估值（PE、PB）。请先核实标的，再给出数字。',
    score(events, text) {
      const tools = calledTools(events);
      return [
        ['调用了 get_quote', tools.includes('get_quote')],
        ['最终文本含价格数字', /(港元|HK\$|HKD|\d{2,})/.test(text)],
        ['工具全部成功', events.filter((e) => e.type === 'tool-result').every((e) => e.ok === true)],
        ['run 正常完成', finished(events)?.status === 'done'],
      ];
    },
  },
  {
    name: 'S3 数据缺失的处理：不存在的美股代码',
    prompt: '请查询美股代码 ZZZZQQ 的实时价格和最新财报。如果查不到，请明确说明数据缺失，不要编造任何数字。',
    score(events, text) {
      const tools = calledTools(events);
      const results = events.filter((e) => e.type === 'tool-result');
      return [
        ['尝试了工具调用', tools.length > 0],
        ['至少一次工具失败或返回空', results.some((e) => e.ok === false) || /数据缺失|无法获取|查不到|未找到/.test(text)],
        ['明确说明了数据缺失', /数据缺失|无法获取|查不到|未找到|不存在/.test(text)],
        ['没有编造价格（正文不含具体价格数字）', !/\d+\.\d{2}\s*(美元|USD|\$)/.test(text)],
      ];
    },
  },
  {
    name: 'S4 持仓读取与预算感知',
    prompt: '我现在持有哪些资产？各自的浮动盈亏是多少？并按本月预算说明我还能不能继续买入 A 股。',
    score(events, text) {
      const tools = calledTools(events);
      return [
        ['调用了 list_assets', tools.includes('list_assets')],
        ['查阅了预算（get_budget 或等价）', tools.includes('get_budget') || /预算/.test(text)],
        ['正文提到预算剩余或上限', /预算/.test(text)],
        ['run 正常完成', finished(events)?.status === 'done'],
      ];
    },
  },
];

function calledTools(events) {
  return events.filter((e) => e.type === 'tool-call').map((e) => e.name);
}
function finished(events) {
  return [...events].reverse().find((e) => e.type === 'run-finished');
}

/* ── harness ───────────────────────────────────────────────────────────────── */

fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
for (const name of fs.readdirSync(source)) {
  if (name.startsWith('advisor.db')) fs.copyFileSync(path.join(source, name), path.join(scratch, name));
}

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

async function ask(prompt) {
  const session = await (await fetch(`${base}/api/chat/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const response = await fetch(`${base}/api/chat/sessions/${session.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ content: prompt }),
  });
  if (!response.ok || !response.body) {
    return { events: [], text: '', error: `HTTP ${response.status} ${await response.text()}` };
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
      const data = chunk
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (data) {
        try {
          events.push(JSON.parse(data));
        } catch {
          /* ignore malformed frame */
        }
      }
      index = buffer.indexOf('\n\n');
    }
  }
  return { events, text: events.filter((e) => e.type === 'text').map((e) => e.delta).join('') };
}

let passed = 0;
let failed = 0;
const rows = [];

try {
  if (!(await waitForHealth())) {
    console.error('[eval] 服务启动失败');
    process.exit(1);
  }
  const settings = await (await fetch(`${base}/api/settings`)).json();
  if (!settings.hasApiKey) {
    console.error('[eval] 未配置 API Key（设置页填写后重试）。');
    process.exit(1);
  }
  console.log(`\n[eval] 模型：${settings.llm.model} @ ${settings.llm.baseUrl}\n`);

  const list = only === null || Number.isNaN(only) ? SCENARIOS : [SCENARIOS[only]].filter(Boolean);
  for (const scenario of list) {
    process.stdout.write(`[eval] ${scenario.name} … `);
    const started = Date.now();
    const { events, text, error } = await ask(scenario.prompt);
    const seconds = Math.round((Date.now() - started) / 1000);
    if (error) {
      console.log(`\x1b[31m请求失败\x1b[0m (${error.slice(0, 120)})`);
      failed += 1;
      continue;
    }
    const checks = scenario.score(events, text);
    const ok = checks.every(([, value]) => value);
    if (ok) passed += 1;
    else failed += 1;
    console.log(`${ok ? '\x1b[32m通过\x1b[0m' : '\x1b[31m未通过\x1b[0m'}  ${seconds}s  tools=${JSON.stringify(calledTools(events))}`);
    for (const [label, value] of checks) {
      console.log(`        ${value ? '✓' : '✗'} ${label}`);
    }
    rows.push({ scenario: scenario.name, ok, seconds, tools: calledTools(events).length, chars: text.length });
  }
} catch (error) {
  console.error('[eval] 异常：', error);
  failed += 1;
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
      /* harmless */
    }
  } else {
    console.log(`\n[eval] 保留临时数据目录：${path.relative(root, scratch)}（可用 npm run trace -- --list 查看轨迹）`);
  }
  console.log(`\n[eval] 计分：\x1b[32m${passed} 通过\x1b[0m / \x1b[31m${failed} 未通过\x1b[0m`);
  for (const row of rows) {
    console.log(`        ${row.ok ? '✓' : '✗'} ${row.scenario}  ${row.seconds}s  ${row.tools} 次工具调用  ${row.chars} 字`);
  }
  process.exit(failed === 0 ? 0 : 1);
}
