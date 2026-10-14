/**
 * Environment diagnosis (`npm run doctor`).
 *
 * Answers "why can't I start it locally?" in one screen without spawning
 * anything that a restricted shell might block: prints versions, artifact
 * presence, port availability, data-dir writability and whether an LLM key is
 * configured, and ends with concrete next steps.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number.parseInt(process.env.PORT ?? '8787', 10) || 8787;

const problems = [];
const hints = [];

function line(label, value, ok = true) {
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${mark} ${label.padEnd(34)} ${value}`);
}

function bad(label, value, hint) {
  line(label, value, false);
  problems.push(`${label}: ${value}`);
  if (hint) hints.push(hint);
}

console.log('\n== AI 投资顾问 · 环境自检 ==\n');

/* ── runtime ───────────────────────────────────────────────────────────────── */

const nodeVersion = process.versions.node;
const major = Number.parseInt(nodeVersion.split('.')[0], 10);
if (major >= 24) line('Node 版本', `v${nodeVersion}`, true);
else if (major >= 22 && major < 24) {
  line('Node 版本', `v${nodeVersion}`, true);
  hints.push('建议升级到 Node 24 LTS：本项目使用内置 node:sqlite（22.5+ 需要实验开关）。');
} else {
  bad('Node 版本', `v${nodeVersion}（需要 >= 22.5，推荐 24 LTS）`, '请安装 Node.js 24 LTS：https://nodejs.org');
}
line('平台', `${process.platform}/${process.arch}`);
line('npm', process.env.npm_config_user_agent ? process.env.npm_config_user_agent.split(' ')[0] : '（非 npm 环境启动）');

/* ── node:sqlite ───────────────────────────────────────────────────────────── */

try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(a INTEGER)');
  db.close();
  line('内置 node:sqlite', '可用');
} catch (error) {
  bad('内置 node:sqlite', error.message, '请升级 Node：数据库层依赖内置 node:sqlite（Node 22.5+）。');
}

/* ── artifacts ─────────────────────────────────────────────────────────────── */

const checks = [
  ['依赖 node_modules/', 'node_modules'],
  ['server 构建产物', 'packages/server/dist/index.js'],
  ['前端构建产物', 'packages/web/dist/index.html'],
  ['shared 构建产物', 'packages/shared/dist/index.js'],
];
for (const [label, rel] of checks) {
  const exists = fs.existsSync(path.join(root, rel));
  if (exists) line(label, path.join(root, rel).replace(`${root}${path.sep}`, ''), true);
  else bad(label, '缺失', '先运行 `npm run build`（或 `npm run dev`，它会自动先构建一次）。');
}

/* ── browser bundle sanity ─────────────────────────────────────────────────── */

/**
 * A blank page is usually not a "build finished?" problem: the browser has no
 * `process` global, so a bundle that kept React's `process.env.NODE_ENV` branch
 * throws `ReferenceError: process is not defined` before rendering anything.
 * The build rewrites that expression; this check proves the artifact is clean.
 */
const webBundlePath = path.join(root, 'packages/web/dist/assets/app.js');
if (fs.existsSync(webBundlePath)) {
  const bundle = fs.readFileSync(webBundlePath, 'utf8');
  if (/process\s*\.\s*env/.test(bundle)) {
    bad('前端产物 process.env', '产物引用了 Node 全局 process.env', '浏览器没有 process 全局，页面会整页空白。请重新构建：npm run build（构建时会把 process.env.NODE_ENV 替换为字面量）。');
  } else {
    line('前端产物 process.env', '无（浏览器可安全执行）');
  }
}

/* ── port ──────────────────────────────────────────────────────────────────── */

/**
 * Probe the *same* host the server binds (config default `0.0.0.0`).
 *
 * Binding a second socket to `127.0.0.1` while the server listens on the
 * wildcard succeeds on Windows, so a hard-coded `127.0.0.1` probe reported
 * "端口空闲" for a port that was actually taken.
 */
const probeHost = process.env.HOST ?? '0.0.0.0';
const free = await new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', (error) => resolve(error.code !== 'EADDRINUSE'));
  server.once('listening', () => server.close(() => resolve(true)));
  server.listen(port, probeHost);
});
if (free) line(`端口 ${port}`, '空闲');
else bad(`端口 ${port}`, '已被占用', `关闭占用进程，或换端口：$env:PORT=8788; npm run dev（Windows）。`);

/* ── data dir ──────────────────────────────────────────────────────────────── */

const dataDir = path.isAbsolute(process.env.DATA_DIR ?? '')
  ? process.env.DATA_DIR
  : path.resolve(root, process.env.DATA_DIR ?? 'data');
try {
  fs.mkdirSync(dataDir, { recursive: true });
  const probe = path.join(dataDir, `.doctor-${Date.now()}`);
  fs.writeFileSync(probe, 'ok');
  fs.rmSync(probe, { force: true });
  line('数据目录可写', dataDir);
} catch (error) {
  bad('数据目录可写', `${dataDir}（${error.message}）`, '检查目录权限，或用 DATA_DIR 指向可写目录。');
}

/* ── LLM key ───────────────────────────────────────────────────────────────── */

let keyInfo = process.env.LLM_API_KEY ? '来自环境变量 LLM_API_KEY' : '';
const dbPath = path.join(dataDir, 'advisor.db');
if (!keyInfo && fs.existsSync(dbPath)) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT llm_api_key, llm_model FROM settings WHERE id = 1').get();
    db.close();
    if (row && String(row.llm_api_key ?? '').trim()) {
      keyInfo = `已保存（模型 ${row.llm_model || '未设置'}）`;
    }
  } catch (error) {
    keyInfo = `无法读取 ${dbPath}（${error.message}）`;
  }
}
if (keyInfo) line('LLM API Key', keyInfo);
else {
  line('LLM API Key', '未配置（只影响 AI 功能，行情/持仓/备份可用）', true);
  hints.push('要使用 AI 分析：在「设置 → AI 配置」填 Key，或设置环境变量 LLM_API_KEY。');
}

/* ── summary ───────────────────────────────────────────────────────────────── */

console.log('');
if (problems.length === 0) {
  console.log('\x1b[32m环境自检通过。\x1b[0m启动本地调试：npm run dev   → http://127.0.0.1:' + port);
} else {
  console.log(`\x1b[31m发现 ${problems.length} 个问题：\x1b[0m`);
  for (const problem of problems) console.log(`  · ${problem}`);
}
if (hints.length > 0) {
  console.log('\n建议：');
  for (const hint of hints) console.log(`  · ${hint}`);
}
console.log(`\n其他常用命令：npm run build（构建）· npm test（测试）· npm run smoke（端到端）· npm run probe:sources（数据源）`);
console.log(`Node 内建提示：本机 ${os.type()} ${os.release()}\n`);

process.exit(problems.length === 0 ? 0 : 1);
