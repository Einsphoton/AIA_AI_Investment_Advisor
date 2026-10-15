/**
 * Version + build identity resolution (owner: Lead).
 *
 * The root `package.json` `version` is the single source of truth — nothing in
 * this repository may hard-code it (a `version.test.ts` guard fails the build if
 * someone does). Everything else is best-effort metadata:
 *
 *   version   AIA_VERSION → <appRoot>/package.json → FALLBACK_VERSION
 *   commit    AIA_GIT_COMMIT | GIT_COMMIT | GITHUB_SHA → .git → 'unknown'
 *   branch    AIA_GIT_BRANCH | GITHUB_REF_NAME → .git → 'unknown'
 *   builtAt   AIA_BUILD_TIME | SOURCE_DATE_EPOCH → running artifact mtime → ''
 *
 * Deliberately subprocess-free: `child_process` with piped stdio is unavailable
 * in the restricted sandboxes this project is verified in, so `.git` is parsed
 * directly (HEAD → refs/heads/<branch> → packed-refs). `.git` is excluded from
 * the container image, hence the env overrides: CI passes the commit/branch as
 * Docker build args (see `Dockerfile` + `.github/workflows/docker-publish.yml`)
 * so `/api/version` of a published image identifies its exact revision.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION_UNKNOWN, type AppVersionInfo } from '@aia/shared';

/** Used when even a readable root `package.json` is missing (unbuilt checkout). */
export const FALLBACK_VERSION = '0.0.0-unknown';

/** Short git hash length (matches `git rev-parse --short`). */
const SHORT_SHA_LENGTH = 7;

export interface VersionResolveOptions {
  /** Repository root (or `/app` in the container). */
  appRoot: string;
  /** Overrides `NODE_ENV`; default `development`. */
  environment?: string;
  /** Env snapshot; defaults to `process.env` (injectable for tests). */
  env?: NodeJS.ProcessEnv;
  /**
   * File whose mtime stands in for the build time when no build-time env var is
   * set. Defaults to this module, i.e. the compiled artifact that is running.
   */
  artifactPath?: string;
}

/** Reads `version` from `<appRoot>/package.json`; `null` when unreadable. */
export function readPackageVersion(appRoot: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    const version = typeof parsed.version === 'string' ? parsed.version.trim() : '';
    return version === '' ? null : version;
  } catch {
    return null;
  }
}

/** Resolves the `.git` directory, following the `gitdir:` pointer of worktrees. */
function gitDirOf(appRoot: string): string | null {
  const dotGit = path.join(appRoot, '.git');
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (!stat.isFile()) return null;
    // Worktree / submodule checkout: `.git` is a file holding `gitdir: <path>`.
    const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!match) return null;
    return path.resolve(path.dirname(dotGit), match[1]!.trim());
  } catch {
    // No `.git` at all (container image): callers degrade to `unknown`.
    return null;
  }
}

/** Reads `<gitDir>/<ref>`; falls back to `packed-refs` for gc'ed refs. */
function readGitRef(gitDir: string, ref: string): string | null {
  try {
    const sha = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim();
    return /^[0-9a-f]{7,}$/i.test(sha) ? sha : null;
  } catch {
    /* ref may be packed */
  }
  try {
    for (const line of fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('^')) continue;
      const [sha, name] = trimmed.split(' ');
      if (name === ref && sha && /^[0-9a-f]{7,}$/i.test(sha)) return sha;
    }
  } catch {
    /* no packed-refs */
  }
  return null;
}

/** Reads HEAD; `null` when `.git` is missing or unreadable. */
export function readGitInfo(appRoot: string): { commit: string; branch: string } | null {
  const gitDir = gitDirOf(appRoot);
  if (!gitDir) return null;
  let head: string;
  try {
    head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return null;
  }
  if (head.startsWith('ref:')) {
    const ref = head.slice('ref:'.length).trim();
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    const sha = readGitRef(gitDir, ref);
    // The branch is known even when the ref itself cannot be read.
    return { commit: sha ? shortSha(sha) : VERSION_UNKNOWN, branch: branch || VERSION_UNKNOWN };
  }
  // Detached HEAD: the file holds the commit directly, there is no branch.
  return /^[0-9a-f]{7,}$/i.test(head)
    ? { commit: shortSha(head), branch: VERSION_UNKNOWN }
    : null;
}

/** Truncates a full SHA to `SHORT_SHA_LENGTH`; passes anything else through. */
export function shortSha(value: string): string {
  const trimmed = value.trim();
  return /^[0-9a-f]{40}$/i.test(trimmed) ? trimmed.slice(0, SHORT_SHA_LENGTH).toLowerCase() : trimmed;
}

/** Normalizes an ISO string / unix seconds / unix millis into ISO-8601. */
function toIso(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    // SOURCE_DATE_EPOCH is seconds; anything past year 33658 in ms is nonsense.
    const ms = trimmed.length <= 10 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** `statSync(...).mtime` as ISO-8601, used only when no build time is recorded. */
function artifactMtimeIso(artifactPath: string | undefined): string {
  if (!artifactPath) return '';
  try {
    return fs.statSync(artifactPath).mtime.toISOString();
  } catch {
    return '';
  }
}

/**
 * Resolves the build identity. Pure with respect to its options: the same
 * options always produce the same result, which is what the tests rely on.
 */
export function resolveVersionInfo(options: VersionResolveOptions): AppVersionInfo {
  const env = options.env ?? process.env;
  const envStr = (name: string): string | null => {
    const raw = env[name];
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
  };

  const version = envStr('AIA_VERSION') ?? readPackageVersion(options.appRoot) ?? FALLBACK_VERSION;
  const git = readGitInfo(options.appRoot);
  const commit = envStr('AIA_GIT_COMMIT') ?? envStr('GIT_COMMIT') ?? envStr('GITHUB_SHA') ?? git?.commit ?? VERSION_UNKNOWN;
  const branch = envStr('AIA_GIT_BRANCH') ?? envStr('GITHUB_REF_NAME') ?? git?.branch ?? VERSION_UNKNOWN;
  const builtAt =
    toIso(envStr('AIA_BUILD_TIME')) ??
    toIso(envStr('SOURCE_DATE_EPOCH')) ??
    artifactMtimeIso(options.artifactPath ?? fileURLToPath(import.meta.url));

  return {
    version,
    commit: shortSha(commit),
    branch,
    builtAt,
    environment: options.environment ?? envStr('NODE_ENV') ?? 'development',
    node: process.version,
  };
}
