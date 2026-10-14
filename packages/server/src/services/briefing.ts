/**
 * Dashboard briefing storage (docs/API.md §3 第四板块).
 *
 * Contract with server-core: the briefing lives in `kv['dashboard.briefing']` as
 * JSON `{ text, generatedAt, runId }`. `GET /api/dashboard` reads it and adds
 * persona/reportStyle.
 *
 * Owner: agent-engine.
 */
import type { Repo } from '../types/repo.js';

export const BRIEFING_KV_KEY = 'dashboard.briefing';

export interface StoredBriefing {
  text: string;
  generatedAt: string;
  runId: string;
}

/** Reads the stored briefing; tolerates legacy/malformed payloads. */
export function readBriefing(repo: Repo): StoredBriefing | null {
  let raw: string | undefined;
  try {
    raw = repo.getKv(BRIEFING_KV_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredBriefing>;
    if (typeof parsed?.text !== 'string' || !parsed.text.trim()) return null;
    return {
      text: parsed.text,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : new Date().toISOString(),
      runId: typeof parsed.runId === 'string' ? parsed.runId : '',
    };
  } catch {
    return null;
  }
}

/** Persists a briefing (last write wins). */
export function writeBriefing(repo: Repo, input: { text: string; runId?: string | null }): StoredBriefing {
  const payload: StoredBriefing = {
    text: input.text,
    generatedAt: new Date().toISOString(),
    runId: input.runId ?? '',
  };
  repo.setKv(BRIEFING_KV_KEY, JSON.stringify(payload));
  return payload;
}
