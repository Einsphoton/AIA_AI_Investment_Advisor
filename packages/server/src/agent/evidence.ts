/**
 * 本次 run 的工具证据累积器 —— 供「数值接地」校验使用。
 *
 * **为什么不直接读 `agent_run_messages`**：同一条 assistant 消息里的工具结果是在
 * **整批执行完之后**才落库的，而写工具（create_advice / upsert_watch_item）是屏障，
 * 会在「同批读工具刚拿到结果、结果还没落库」时执行。从库里读会漏掉这一批证据，
 * 从而产生大量假告警。因此这里在 `executeTool` 内部即时累积。
 *
 * 生命周期：`clearToolEvidence(runId)` 在每次 run 开始时清空、结束时释放，因此不会
 * 跨 run 泄漏；单 run 有字符上限，避免超长工具返回把内存撑大。
 *
 * Owner: agent-engine.
 */

/** 单个 run 的证据上限（工具结果本身已被截断到 7000 字符，正常远低于此）。 */
export const MAX_EVIDENCE_CHARS = 400_000;
/** 同时保留的 run 数上限：万一某个 run 异常中断没来得及释放，也不会无限增长。 */
export const MAX_TRACKED_RUNS = 8;

interface EvidenceEntry {
  text: string;
  truncated: boolean;
}

const EVIDENCE = new Map<string, EvidenceEntry>();

function evictOldest(): void {
  while (EVIDENCE.size > MAX_TRACKED_RUNS) {
    const oldest = EVIDENCE.keys().next();
    if (oldest.done) return;
    EVIDENCE.delete(oldest.value);
  }
}

/**
 * Records one successful tool output. Best effort: a run that never calls
 * `clearToolEvidence` (e.g. an unexpected crash) is bounded by the per-run cap.
 */
export function recordToolEvidence(runId: string, toolName: string, content: string): void {
  if (!runId || !content) return;
  const current = EVIDENCE.get(runId) ?? { text: '', truncated: false };
  if (current.truncated) return;
  const next = `${current.text}\n[${toolName}]\n${content}`;
  if (next.length > MAX_EVIDENCE_CHARS) {
    EVIDENCE.set(runId, {
      text: `${next.slice(0, MAX_EVIDENCE_CHARS)}\n[证据已达上限，后续工具返回未记录]`,
      truncated: true,
    });
    evictOldest();
    return;
  }
  EVIDENCE.set(runId, { text: next, truncated: false });
  evictOldest();
}

/** Concatenated evidence of one run (empty string when nothing was recorded). */
export function readToolEvidence(runId: string): string {
  return EVIDENCE.get(runId)?.text ?? '';
}

/** Releases a run's evidence. Safe to call for unknown runs. */
export function clearToolEvidence(runId: string): void {
  EVIDENCE.delete(runId);
}

/** Diagnostics for tests / leak checks. */
export function evidenceStats(): { runs: number; chars: number } {
  let chars = 0;
  for (const entry of EVIDENCE.values()) chars += entry.text.length;
  return { runs: EVIDENCE.size, chars };
}
