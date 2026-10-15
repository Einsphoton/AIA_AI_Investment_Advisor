/**
 * Version + build identity tests (owner: Lead).
 *
 * The mechanism has three promises that must not rot:
 *   1. the root `package.json` `version` is the only source of truth — the
 *      server may not hard-code it again (`config.version` drift guard);
 *   2. explicit environment overrides win, because a container image has no
 *      `.git` and CI is the only place that knows the built revision;
 *   3. every unresolved field degrades to `unknown` / `''` instead of throwing
 *      or inventing a value (a broken badge is worse than an honest "unknown").
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatVersionLabel, isVersionMismatch } from '@aia/shared';

import {
  FALLBACK_VERSION,
  readGitInfo,
  readPackageVersion,
  resolveVersionInfo,
  shortSha,
} from '../src/version.js';
import { config } from '../src/config.js';

const APP_ROOT = config.appRoot;
const ROOT_VERSION = (
  JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;
/** Directory that intentionally has no package.json and no .git. */
const EMPTY_ROOT = path.join(os.tmpdir(), 'aia-version-does-not-exist');

test('版本号唯一来源是根 package.json：config.version 不得再硬编码', () => {
  assert.equal(readPackageVersion(APP_ROOT), ROOT_VERSION);
  assert.equal(config.version, ROOT_VERSION, 'config.version 必须镜像根 package.json，不能再写死');
  assert.equal(config.versionInfo.version, ROOT_VERSION);
  // 2026-10 之前 config.ts 里是 `version: '0.1.0'`；这里直接扫源码防止回归。
  const source = fs.readFileSync(path.join(APP_ROOT, 'packages', 'server', 'src', 'config.ts'), 'utf8');
  assert.ok(!/version:\s*'\d+\.\d+/.test(source), 'config.ts 又硬编码了版本号');
});

test('读不到 package.json 时退化为哨兵值，而不是抛错或编造版本号', () => {
  assert.equal(readPackageVersion(EMPTY_ROOT), null);
  const info = resolveVersionInfo({ appRoot: EMPTY_ROOT, env: {}, artifactPath: '' });
  assert.equal(info.version, FALLBACK_VERSION);
  assert.equal(info.commit, 'unknown');
  assert.equal(info.branch, 'unknown');
  assert.equal(info.builtAt, '');
  assert.equal(info.environment, 'development');
});

test('环境变量优先：容器镜像里没有 .git，构建标识只能由 CI 注入', () => {
  const info = resolveVersionInfo({
    appRoot: EMPTY_ROOT,
    env: {
      AIA_VERSION: '9.9.9',
      AIA_GIT_COMMIT: 'a'.repeat(40),
      AIA_GIT_BRANCH: 'release/9.9',
      AIA_BUILD_TIME: '2026-01-02T03:04:05Z',
      NODE_ENV: 'production',
    },
    artifactPath: '',
  });
  assert.equal(info.version, '9.9.9', 'AIA_VERSION 必须覆盖 package.json');
  assert.equal(info.commit, 'a'.repeat(7), '完整 SHA 必须截成 7 位（与镜像标签一致）');
  assert.equal(info.branch, 'release/9.9');
  assert.equal(info.builtAt, '2026-01-02T03:04:05.000Z');
  assert.equal(info.environment, 'production');
  assert.equal(info.node, process.version);
});

test('构建时间：AIA_BUILD_TIME > SOURCE_DATE_EPOCH（秒）> 产物 mtime', () => {
  const fromEnv = resolveVersionInfo({ appRoot: APP_ROOT, env: { AIA_BUILD_TIME: '1700000000' }, artifactPath: '' });
  assert.equal(fromEnv.builtAt, new Date(1_700_000_000_000).toISOString(), '纯数字按秒解析');

  const reproducible = resolveVersionInfo({
    appRoot: APP_ROOT,
    env: { AIA_BUILD_TIME: '2026-05-06T07:08:09Z', SOURCE_DATE_EPOCH: '1700000000' },
    artifactPath: '',
  });
  assert.equal(reproducible.builtAt, '2026-05-06T07:08:09.000Z', '显式构建时间优先于可复现构建时间戳');

  const artifact = resolveVersionInfo({
    appRoot: APP_ROOT,
    env: {},
    artifactPath: fileURLToPath(import.meta.url),
  });
  assert.ok(!Number.isNaN(Date.parse(artifact.builtAt)), '没有环境变量时应回落到运行产物 mtime');
});

test('本地检出直接读 .git（不调用 git 子进程：受限沙箱没有管道）', (t) => {
  if (!fs.existsSync(path.join(APP_ROOT, '.git'))) {
    t.skip('当前工作区没有 .git（容器 / 打包产物）');
    return;
  }
  const git = readGitInfo(APP_ROOT);
  assert.ok(git, '存在 .git 时应能解析 HEAD');
  assert.match(git!.commit, /^[0-9a-f]{7,40}$/, 'commit 必须是十六进制短哈希');
  assert.ok(git!.branch.length > 0, 'branch 不允许为空字符串');
  const info = resolveVersionInfo({ appRoot: APP_ROOT, env: {}, artifactPath: '' });
  assert.match(info.commit, /^[0-9a-f]{7}$/, 'config 里的 commit 也应是 7 位短哈希');
});

test('shortSha 只截 40 位整哈希，短哈希与 unknown 原样保留', () => {
  assert.equal(shortSha('ABCDEF1234567890abcdef1234567890abcdef12'), 'abcdef1');
  assert.equal(shortSha('abcdef1'), 'abcdef1');
  assert.equal(shortSha('unknown'), 'unknown');
  assert.equal(shortSha('  1234567  '), '1234567');
});

test('版本徽标文案：有提交才带提交，缺值一律退化为 —', () => {
  assert.equal(formatVersionLabel('0.1.0', 'a1b2c3d'), 'v0.1.0 · a1b2c3d');
  assert.equal(formatVersionLabel('0.1.0', 'unknown'), 'v0.1.0');
  assert.equal(formatVersionLabel('0.1.0'), 'v0.1.0');
  assert.equal(formatVersionLabel(''), 'v—');
  assert.equal(formatVersionLabel('unknown', ''), 'v—');
});

test('前后端版本不一致才算告警：缺值不误报', () => {
  assert.equal(isVersionMismatch('0.1.0', '0.2.0'), true);
  assert.equal(isVersionMismatch('0.1.0', '0.1.0'), false);
  assert.equal(isVersionMismatch('0.1.0', 'unknown'), false, '服务端读不到版本不应报警');
  assert.equal(isVersionMismatch('', '0.2.0'), false, '前端未注入版本不应报警');
  assert.equal(isVersionMismatch(null, null), false);
});
