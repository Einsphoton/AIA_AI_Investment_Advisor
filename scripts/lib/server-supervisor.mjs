/**
 * 开发模式的服务进程监管器（替代 `node --watch`，但**不会杀掉正在跑的 AI 分析**）。
 *
 * 为什么需要它：AI 流水线跑在 API 进程内（没有队列 / worker）。`node --watch` 一
 * 发现编译产物变化就立刻杀掉并重启服务，于是「改源码 / 跑一次 build 或 test」会把
 * 正在跑的分析判成「运行被中断（服务进程在本次分析结束前退出）」，白烧一遍 token。
 *
 * 这里的策略：
 *   1. 轮询 `packages/server/dist` + `packages/shared/dist` 的指纹（文件名 + mtime + size）；
 *   2. 指纹变了先不动手，而是问一次服务「有没有流水线在跑」（`lib/pipeline-state.mjs`）；
 *   3. 有流水线就**延后重启**并定期提示，等它跑完（或超过 maxDeferMs）再重启；
 *   4. 服务意外退出（崩溃）时自动拉起，但连续「刚起来就退」超过 maxEarlyExits 次就停手，
 *      避免把终端刷成重启风暴。
 *
 * 所有副作用（spawn / 探测 / 指纹 / 计时器）都可注入，便于 `scripts/test/` 里做确定性单测。
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { detectRunningPipeline, describeRun } from './pipeline-state.mjs';

export const SUPERVISOR_DEFAULTS = {
  /** 指纹轮询间隔。 */
  intervalMs: 800,
  /** 有流水线在跑时最多延后多久（超过就强制重启并给出警告）。 */
  maxDeferMs: 30 * 60_000,
  /** 崩溃后的重启延迟。 */
  restartDelayMs: 1500,
  /** 「已延后重启」提示的最小间隔，避免刷屏。 */
  busyLogIntervalMs: 30_000,
  /** 连续「启动后立刻退出」多少次就停止自动重启。 */
  maxEarlyExits: 5,
  /** 多久算「立刻退出」。 */
  earlyExitMs: 3_000,
};

/**
 * 目录指纹：递归收集 `路径:mtimeMs:size`，排序后拼成一个字符串。
 * 任一文件被重写 / 新增 / 删除都会改变指纹。
 *
 * @param {string[]} dirs
 * @returns {string}
 */
export function fingerprintDirs(dirs) {
  const parts = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop();
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue; // 目录刚好被删除：下一次轮询会看到新指纹
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        try {
          const stat = statSync(full);
          parts.push(`${full}:${stat.mtimeMs}:${stat.size}`);
        } catch {
          /* 文件刚好被替换：忽略这一条 */
        }
      }
    }
  }
  return parts.sort().join('|');
}

/**
 * @typedef {object} SupervisorConfig
 * @property {string} entry 服务入口（绝对路径）
 * @property {string[]} [args] node 参数（默认 `['--enable-source-maps']`）
 * @property {string} [cwd]
 * @property {Record<string, string>} [env]
 * @property {number} port
 * @property {string[]} watchDirs 参与指纹的目录
 * @property {(message: string) => void} [log]
 * @property {(message: string) => void} [warn]
 * @property {typeof spawn} [spawnImpl]
 * @property {typeof detectRunningPipeline} [detectImpl]
 * @property {(dirs: string[]) => string} [fingerprintImpl]
 * @property {() => number} [now]
 * @property {typeof setInterval} [setIntervalImpl]
 * @property {typeof clearInterval} [clearIntervalImpl]
 * @property {typeof setTimeout} [setTimeoutImpl]
 * @property {typeof clearTimeout} [clearTimeoutImpl]
 * @property {number} [intervalMs]
 * @property {number} [maxDeferMs]
 * @property {number} [restartDelayMs]
 * @property {number} [busyLogIntervalMs]
 * @property {number} [maxEarlyExits]
 * @property {number} [earlyExitMs]
 */

/**
 * 创建一个监管器。返回 `{ start, stop, snapshot }`。
 *
 * @param {SupervisorConfig} config
 */
export function createServerSupervisor(config) {
  const {
    entry,
    args = ['--enable-source-maps'],
    cwd,
    env = {},
    port,
    watchDirs,
    log = () => undefined,
    warn = () => undefined,
    spawnImpl = spawn,
    detectImpl = detectRunningPipeline,
    fingerprintImpl = fingerprintDirs,
    now = Date.now,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    intervalMs = SUPERVISOR_DEFAULTS.intervalMs,
    maxDeferMs = SUPERVISOR_DEFAULTS.maxDeferMs,
    restartDelayMs = SUPERVISOR_DEFAULTS.restartDelayMs,
    busyLogIntervalMs = SUPERVISOR_DEFAULTS.busyLogIntervalMs,
    maxEarlyExits = SUPERVISOR_DEFAULTS.maxEarlyExits,
    earlyExitMs = SUPERVISOR_DEFAULTS.earlyExitMs,
  } = config;

  const baseUrl = `http://127.0.0.1:${port}`;

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let timer = null;
  let restartTimer = null;
  let stopping = false;
  let restarting = false;
  let polling = false;
  /** 指纹是否已变化、但还没应用（可能因为流水线在跑被延后）。 */
  let pendingRestart = false;
  let pendingSince = 0;
  let lastFingerprint = '';
  let lastBusyLogAt = 0;
  let consecutiveEarlyExits = 0;
  let forceKillTimer = null;

  function launch(label) {
    const childEnv = { ...process.env, ...env, PORT: String(port) };
    const spawnedAt = now();
    const proc = spawnImpl(process.execPath, [...args, entry], {
      cwd,
      env: childEnv,
      stdio: 'inherit',
      shell: false,
    });
    child = proc;
    log(`${label}服务进程（pid ${proc.pid ?? '?'}）`);
    proc.on('exit', (code, signal) => {
      if (child === proc) child = null;
      if (stopping || restarting) return;
      const early = now() - spawnedAt < earlyExitMs;
      consecutiveEarlyExits = early ? consecutiveEarlyExits + 1 : 0;
      if (consecutiveEarlyExits >= maxEarlyExits) {
        warn(
          `服务进程连续 ${consecutiveEarlyExits} 次启动后立刻退出，已停止自动重启；` +
            '请按 Ctrl+C 退出后检查上面的报错（常见原因：端口被占用、构建产物损坏、配置错误）。',
        );
        stop();
        return;
      }
      warn(`服务进程退出（code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}），${restartDelayMs} ms 后自动重启…`);
      scheduleRestart('服务进程崩溃');
    });
    return proc;
  }

  function scheduleRestart(reason) {
    if (restartTimer || stopping) return;
    restartTimer = setTimeoutImpl(() => {
      restartTimer = null;
      restart(reason);
    }, restartDelayMs);
    restartTimer?.unref?.();
  }

  function restart(reason) {
    if (stopping) return;
    pendingRestart = false;
    pendingSince = 0;
    const dying = child;
    if (!dying) {
      launch(`重启（${reason}）`);
      return;
    }
    restarting = true;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) {
        clearTimeoutImpl(forceKillTimer);
        forceKillTimer = null;
      }
      if (child === dying) child = null;
      restarting = false;
      launch(`重启（${reason}）`);
    };
    dying.once('exit', finish);
    // 兜底定时器「先装好再发信号」：否则进程同步退出后 settled 已置位，这个定时器
    // 却还挂在事件循环上（真实场景无害，但语义不干净）。
    forceKillTimer = setTimeoutImpl(() => {
      forceKillTimer = null;
      if (settled) return;
      try {
        dying.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
      finish();
    }, 3_000);
    forceKillTimer?.unref?.();
    try {
      dying.kill('SIGTERM');
    } catch {
      /* 已经退出 */
    }
  }

  /**
   * 一次轮询：先看指纹，再决定是否重启。
   * 有流水线在跑就只提示、不重启 —— 这是本模块存在的全部理由。
   * 自身绝不抛错（`setInterval` 的返回值没人接）。
   */
  async function tick() {
    if (stopping || polling) return;
    try {
      const fingerprint = fingerprintImpl(watchDirs);
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        if (!pendingRestart) {
          pendingRestart = true;
          pendingSince = now();
        }
      }
      if (!pendingRestart) return;

      polling = true;
      let run = null;
      try {
        ({ run } = await detectImpl(baseUrl));
      } catch (error) {
        // 探测本身不该成为重启的理由：拿不到状态就按「没有流水线」处理。
        warn(`探测流水线状态失败（按「空闲」处理）：${error instanceof Error ? error.message : String(error)}`);
      }
      if (run) {
        const deferredMs = now() - pendingSince;
        if (deferredMs >= maxDeferMs) {
          warn(
            `已延后 ${Math.round(deferredMs / 60_000)} 分钟仍未等到流水线结束（${describeRun(run)}），现在强制重启；` +
              '该分析会被标记为「运行被中断」，可在「活动与审计」页一键续跑。',
          );
          restart('延后超时');
          return;
        }
        if (now() - lastBusyLogAt >= busyLogIntervalMs) {
          lastBusyLogAt = now();
          warn(
            `编译产物已更新，但 AI 流水线正在运行（${describeRun(run)}）：已延后重启，等它跑完自动重启；` +
              '想立刻生效请先在界面中断该流水线（中断后可在活动页续跑）。',
          );
        }
        return;
      }
      log('编译产物已更新且没有流水线在跑 → 重启服务');
      restart('编译产物更新');
    } catch (error) {
      warn(`监督器轮询出错（已忽略，下次轮询重试）：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      polling = false;
    }
  }

  function stop() {
    if (stopping) return;
    stopping = true;
    if (timer) {
      clearIntervalImpl(timer);
      timer = null;
    }
    if (restartTimer) {
      clearTimeoutImpl(restartTimer);
      restartTimer = null;
    }
    if (forceKillTimer) {
      clearTimeoutImpl(forceKillTimer);
      forceKillTimer = null;
    }
    const dying = child;
    child = null;
    if (dying) {
      try {
        dying.kill('SIGTERM');
      } catch {
        /* 已经退出 */
      }
    }
  }

  return {
    /** 启动服务并开始轮询。 */
    start() {
      stopping = false;
      lastFingerprint = fingerprintImpl(watchDirs);
      launch('启动');
      timer = setIntervalImpl(() => tick(), intervalMs);
      timer?.unref?.();
    },
    stop,
    /** 供测试 / 日志使用。 */
    snapshot() {
      return {
        running: child !== null,
        pid: child?.pid ?? null,
        pendingRestart,
        pendingSince,
        stopping,
        lastFingerprint,
      };
    },
  };
}
