/**
 * Version + build identity contract, shared by the API and the web client.
 *
 * Single source of truth is the root `package.json` `version` field:
 *   · the server resolves it at boot (`packages/server/src/version.ts`);
 *   · the web bundle gets a build-time copy injected by
 *     `packages/web/build/app-version-plugin.mjs` (`__AIA_VERSION__`).
 *
 * Both sides are reported separately on purpose: a browser that still runs an
 * older `app.js` against a freshly deployed API is otherwise invisible, and the
 * resulting "the UI behaves differently than the code says" reports are
 * impossible to diagnose. The badge in the top-left corner compares the two and
 * warns when they differ.
 */

/** Placeholder for a field that could not be resolved (never invented). */
export const VERSION_UNKNOWN = 'unknown';

/** Version + build identity of one running build. */
export interface AppVersionInfo {
  /** SemVer of the root `package.json` — the single source of truth. */
  version: string;
  /** Short git commit the artifact was built from, or `unknown`. */
  commit: string;
  /** Git branch, or `unknown` when detached / read from a container image. */
  branch: string;
  /** ISO-8601 timestamp of the artifact build, or `''` when not recorded. */
  builtAt: string;
  /** `production` / `development` / `test`. */
  environment: string;
  /** Node.js version the API runs on. */
  node: string;
}

/** `GET /api/version` — build identity plus process liveness. */
export interface AppVersionPayload extends AppVersionInfo {
  ok: true;
  /** ISO-8601 process start time. */
  startedAt: string;
  /** Whole seconds since the process started. */
  uptimeSeconds: number;
}

/** True when a field carries a real value (`''` / `unknown` / undefined do not). */
export function hasVersionValue(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed !== '' && trimmed !== VERSION_UNKNOWN;
}

/**
 * Compact corner label: `v0.1.0` or `v0.1.0 · a1b2c3d`.
 *
 * The commit is part of the label because two builds of the same semver are
 * different artifacts — that is exactly what a bug report needs to pin down.
 */
export function formatVersionLabel(version: string | null | undefined, commit?: string | null): string {
  const head = hasVersionValue(version) ? `v${(version as string).trim()}` : 'v—';
  return hasVersionValue(commit) ? `${head} · ${(commit as string).trim()}` : head;
}

/**
 * True when the loaded frontend bundle and the API were built from different
 * versions. Unknown values never count as a mismatch — a missing version must
 * not raise a false alarm.
 */
export function isVersionMismatch(
  bundleVersion: string | null | undefined,
  apiVersion: string | null | undefined,
): boolean {
  if (!hasVersionValue(bundleVersion) || !hasVersionValue(apiVersion)) return false;
  return (bundleVersion as string).trim() !== (apiVersion as string).trim();
}
