/**
 * Runtime configuration for the server.
 *
 * Precedence: environment variables > defaults. User-editable settings that the
 * UI manages (persona, LLM key, budgets, schedule鈥? live in SQLite and are
 * seeded from the shared defaults; this module only covers process concerns.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveVersionInfo } from './version.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repository root — found by walking up to the workspace manifest.
 *
 * A fixed number of `..` hops does not work: the compiled server sits at
 * `<root>/packages/server/dist` in production but at
 * `<root>/packages/server/dist-test/src` in the test build, and the wrong root
 * silently resolves to `packages/` (which has no `package.json`, so the version,
 * the web bundle and the default data dir all point at nothing). The manifest
 * check is the deterministic marker of the workspace root; the historical
 * 3-level hop stays as the fallback.
 */
function findAppRoot(from: string): string {
  let dir = from;
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { workspaces?: unknown };
      if (manifest.workspaces) return dir;
    } catch {
      /* no manifest here — keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(from, '..', '..', '..');
}

/** Repository root (…/packages/server/src → …) or `/app` in the container. */
export const APP_ROOT = findAppRoot(here);

/**
 * Build identity (version from the root `package.json`, plus commit / branch /
 * build time). Resolved once at boot: it cannot change while the process runs.
 */
const versionInfo = resolveVersionInfo({
  appRoot: APP_ROOT,
  environment: process.env.NODE_ENV ?? 'development',
});

function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const dataDir = path.isAbsolute(envStr('DATA_DIR', ''))
  ? envStr('DATA_DIR', '')
  : path.resolve(APP_ROOT, envStr('DATA_DIR', 'data'));

export const config = {
  appRoot: APP_ROOT,
  port: envInt('PORT', 8787),
  host: envStr('HOST', '0.0.0.0'),
  logLevel: envStr('LOG_LEVEL', process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  dataDir,
  dbPath: path.resolve(dataDir, 'advisor.db'),
  backupDir: path.resolve(dataDir, 'backups'),
  /** Built web assets served in production (`packages/web/dist`). */
  webDistDir: path.resolve(APP_ROOT, 'packages/web/dist'),
  isProduction: process.env.NODE_ENV === 'production',
  /** Always mirrors `versionInfo.version`; kept for existing callers. */
  version: versionInfo.version,
  /** Version + build identity, surfaced by `GET /api/version` and the UI badge. */
  versionInfo,
  /** Default LLM config from env; overridden by stored settings when present. */
  envLlm: {
    baseUrl: envStr('LLM_BASE_URL', 'https://api.deepseek.com/v1'),
    apiKey: envStr('LLM_API_KEY', ''),
    model: envStr('LLM_MODEL', 'deepseek-flash'),
    timeoutMs: envInt('LLM_TIMEOUT_MS', 180_000),
  },
  /** Optional provider keys accepted from the environment. */
  providerKeys: {
    tavily: envStr('TAVILY_API_KEY', ''),
    serper: envStr('SERPER_API_KEY', ''),
    brave: envStr('BRAVE_API_KEY', ''),
    finnhub: envStr('FINNHUB_API_KEY', ''),
    alphavantage: envStr('ALPHAVANTAGE_API_KEY', ''),
    fmp: envStr('FMP_API_KEY', ''),
  },
} as const;

export function ensureDataDirs(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.backupDir, { recursive: true });
}

export type AppConfig = typeof config;

