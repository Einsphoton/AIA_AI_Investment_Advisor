/**
 * 「本机是否正在跑 AI 流水线」的探测工具（`scripts/` 共用）。
 *
 * 为什么用 `/api/agent/runs` 而不是新接口：四个 AI 入口（一键分析 / 资产分析 /
 * 标的分析 / 建议生成）以及定时任务在进入流水线时都会先写一条 `status='running'`
 * 的 `agent_runs` 行，结束时才改成 `done`/`error`；所以「最近若干条 run 里有一条
 * `running`」== 服务进程正持有流水线锁（`services/pipeline-lock.ts`）。
 * 这样脚本侧**不需要服务端新增接口**，也就不会为了「防止重启」而先重启一次服务。
 *
 * 判定语义：
 *   · `reachable === false` → 服务没在监听（或端口不对），调用方按「没有流水线」处理；
 *   · `reachable === true`  → `run` 为正在运行的那条，没有则为 `null`。
 */

/** 拉取运行列表的路径（10 条足够覆盖一次流水线的三个阶段）。 */
export const RUNS_PATH = '/api/agent/runs?limit=10';

/** 单次探测的默认超时：本地接口，1.5 秒足够，且不会拖慢构建。 */
export const DEFAULT_TIMEOUT_MS = 1500;

/**
 * 探测一次。**永不抛错**：任何网络/解析问题都退化为「服务不可达」。
 *
 * @param {string} baseUrl 形如 `http://127.0.0.1:8787`
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ reachable: boolean, run: { id?: string, kind?: string, status?: string, turns?: number, startedAt?: string } | null }>}
 */
export async function detectRunningPipeline(baseUrl, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = options;
  try {
    const response = await fetchImpl(new URL(RUNS_PATH, baseUrl), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { reachable: false, run: null };
    const payload = await response.json();
    const runs = Array.isArray(payload) ? payload : [];
    const run = runs.find((entry) => entry && entry.status === 'running') ?? null;
    return { reachable: true, run };
  } catch {
    return { reachable: false, run: null };
  }
}

/**
 * 一行人类可读的运行描述，用于日志与报错文案。
 *
 * @param {{ id?: unknown, kind?: unknown, turns?: unknown, startedAt?: unknown } | null} run
 * @returns {string}
 */
export function describeRun(run) {
  if (!run) return '未知运行';
  const kind = typeof run.kind === 'string' && run.kind ? run.kind : 'run';
  const id = typeof run.id === 'string' && run.id ? run.id.slice(0, 8) : '????????';
  const parts = [`${kind} ${id}`];
  if (typeof run.turns === 'number' && Number.isFinite(run.turns)) parts.push(`已 ${run.turns} 轮`);
  if (typeof run.startedAt === 'string' && run.startedAt) parts.push(`始于 ${run.startedAt}`);
  return parts.join('，');
}
