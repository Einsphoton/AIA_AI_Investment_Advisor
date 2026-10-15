/**
 * Cross-platform local dev orchestrator (`npm run dev`).
 *
 * Builds the workspace once, then runs three watchers in parallel:
 *   · tsc --watch  for @aia/server  (emits packages/server/dist)
 *   · rollup -w    for @aia/web     (emits packages/web/dist)
 *   · a supervisor that (re)starts the built server entry
 *
 * Deliberately uses only Node APIs + tsc/rollup (no esbuild/tsx/vite) so it also
 * works in restricted environments where spawning native helpers fails.
 *
 * Robustness added after a local-debugging report:
 *  - the port is probed *before* building, so "端口被占用" is reported in one
 *    line instead of a confusing watcher crash half a minute later;
 *  - Ctrl+C kills the whole process tree on Windows (`taskkill /T`), otherwise
 *    the npm→node grandchildren survived and kept the port bound, making the
 *    next `npm run dev` fail with EADDRINUSE.
 *
 * Robustness added after a second report（两次「AI一键分析」都被构建触发的重启杀掉）：
 *  `node --watch` 会在编译产物变化时立刻杀掉服务，而 AI 流水线跑在这个进程内，
 *  于是「一边跑分析一边改后端 / 跑 build」= 分析被判为中断。现在改用
 *  `lib/server-supervisor.mjs`：产物变化时先问一句「有没有流水线在跑」，
 *  有就延后重启，等分析结束再重启。
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { createServerSupervisor } from './lib/server-supervisor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const port = Number.parseInt(process.env.PORT ?? '8787', 10) || 8787;
/**
 * Host the server itself binds (see packages/server/src/config.ts). The port
 * probe must use the same host: on Windows, binding a second socket to
 * `127.0.0.1` succeeds even while the wildcard `0.0.0.0` is in use, so probing
 * `127.0.0.1` reported "port free" and the failure only surfaced later as an
 * EADDRINUSE crash from Fastify.
 */
const host = process.env.HOST ?? '0.0.0.0';
const url = `http://127.0.0.1:${port}`;
const shouldOpen = process.env.AIA_NO_OPEN !== '1';

/**
 * npm entry point next to the running Node interpreter.
 *
 * The bootstrap launchers may use a **portable** Node (`.tools/…`) that is not
 * on PATH, so npm is resolved relative to `process.execPath`:
 *   · official zip / Windows  → <dir>/node_modules/npm/bin/npm-cli.js
 *   · macOS/Linux tarball     → <dir>/../lib/node_modules/npm/bin/npm-cli.js
 *
 * Running `node npm-cli.js …` (no shell) also fixes the classic Windows bug where
 * a project path containing a space breaks `spawn(npm, args, { shell: true })`
 * — e.g. `C:\Users\me\Documents\AI Project\…`.
 */
function resolveNpmCli() {
  const exeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(exeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(exeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return path.resolve(candidate);
  }
  return null;
}

const npmCli = resolveNpmCli();

/** Builds a spawn descriptor that never relies on shell word-splitting. */
function npmSpawn(args) {
  if (npmCli) return { cmd: process.execPath, args: [npmCli, ...args], shell: false };
  return { cmd: isWindows ? 'npm.cmd' : 'npm', args, shell: isWindows };
}

const children = [];
let shuttingDown = false;
/** 服务进程监管器（不再是 `node --watch`：见文件头注释）。 */
let serverSupervisor = null;

function log(message) {
  process.stdout.write(`\x1b[36m[dev]\x1b[0m ${message}\n`);
}

function warn(message) {
  process.stdout.write(`\x1b[33m[dev]\x1b[0m ${message}\n`);
}

/** Resolves true when nothing is listening on the port. */
function probePort(free = true) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve(error.code === 'EADDRINUSE' ? false : free));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

function runOnce(args, label) {
  return new Promise((resolve, reject) => {
    log(`${label} …`);
    const { cmd, args: spawnArgs, shell } = npmSpawn(args);
    const child = spawn(cmd, spawnArgs, { cwd: root, stdio: 'inherit', shell });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${label} 失败（exit ${code}）`))));
    child.on('error', reject);
  });
}

function start(args, label, env = {}) {
  const { cmd, args: spawnArgs, shell } = npmSpawn(args);
  const child = spawn(cmd, spawnArgs, {
    cwd: root,
    stdio: 'inherit',
    shell,
    env: { ...process.env, ...env },
  });
  child.on('exit', (code) => {
    if (!shuttingDown && code !== 0) warn(`${label} 退出（code ${code}）`);
  });
  children.push({ child, label });
  return child;
}

/** Kills a child **and its descendants** (npm spawns node). */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (isWindows) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}

/** Opens the app in the default browser (best effort, never fatal). */
function openBrowser(target) {
  try {
    if (isWindows) {
      spawn('cmd', ['/c', 'start', '', target], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [target], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    /* opening a browser is a convenience, never a requirement */
  }
}

/** Polls /api/health until the server answers (or gives up quietly). */
async function waitForServer(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shuttingDown) return false;
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return false;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('正在停止子进程…');
  serverSupervisor?.stop();
  for (const { child } of children) killTree(child);
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
  if (!fs.existsSync(path.join(root, 'node_modules'))) {
    log('未找到 node_modules，先执行 npm install …');
    await runOnce(['install', '--ignore-scripts', '--no-audit', '--no-fund'], 'npm install');
  }

  if (!(await probePort())) {
    warn(`端口 ${port} 已被占用，服务无法启动。`);
    warn(`处理方式：① 关闭占用它的进程（Windows: netstat -ano | findstr :${port} → taskkill /PID <pid> /F）；`);
    warn(`          ② 或换端口启动（Windows: $env:PORT=8788; npm run dev）`);
    process.exit(1);
  }

  await runOnce(['run', 'build:server'], '构建 shared + server');
  await runOnce(['run', 'build', '-w', '@aia/web'], '构建 web');

  log('启动监听进程：server(tsc) / web(rollup) / server(监管器)');
  start(['run', 'build:watch', '-w', '@aia/server'], 'tsc(server)');
  start(['run', 'build:watch', '-w', '@aia/web'], 'rollup(web)');
  // 不再用 `node --watch`：它在产物变化时无条件重启，会把正在跑的 AI 分析判成中断
  // （真实事故：两次「AI一键分析」都是被 build/test 触发的重启杀掉的）。
  // 监管器先看有没有流水线在跑，有就延后重启。
  serverSupervisor = createServerSupervisor({
    entry: path.join(root, 'packages', 'server', 'dist', 'index.js'),
    args: ['--enable-source-maps'],
    cwd: root,
    port,
    env: { NODE_ENV: process.env.NODE_ENV ?? 'development' },
    watchDirs: [path.join(root, 'packages', 'server', 'dist'), path.join(root, 'packages', 'shared', 'dist')],
    log: (message) => log(message),
    warn: (message) => warn(message),
  });
  serverSupervisor.start();

  log(`本地调试地址（前端由服务端托管）：${url}`);
  log('修改后端源码 → tsc 重编译 → 服务自动重启；若此刻正在跑 AI 分析，会延后到分析结束后再重启。');
  log('修改前端源码 → rollup 重新打包 → 刷新浏览器即可。');
  log('首次打开若报错，先运行 `npm run doctor` 检查环境（依赖/端口/数据目录/密钥）。');
  log('按 Ctrl+C 退出（会连同子进程一起结束）。');

  // One-click UX: wait for the server, then open the browser automatically.
  const ready = await waitForServer();
  if (ready) {
    log(`服务已就绪：${url}`);
    if (shouldOpen) {
      log('正在打开浏览器…（不想自动打开就设置 AIA_NO_OPEN=1）');
      openBrowser(url);
    }
  } else if (!shuttingDown) {
    warn(`等待 ${url}/api/health 超时：服务可能启动失败，请查看上面的日志，或运行 \`npm run doctor\`。`);
  }
}

main().catch((error) => {
  warn(`启动失败：${error.message}`);
  warn('可运行 `npm run doctor` 排查环境。');
  shutdown(1);
});
