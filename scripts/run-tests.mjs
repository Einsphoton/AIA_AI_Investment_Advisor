/**
 * In-process test runner (`node scripts/run-tests.mjs <dir>`).
 *
 * Why not `node --test`: the built-in runner spawns one child process per test
 * file, which fails in restricted environments (EPERM on spawn) and is slower.
 * Importing the compiled test files directly registers the `node:test` suites,
 * which the runtime then executes in-process.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const target = path.resolve(process.argv[2] ?? 'dist-test');
if (!fs.existsSync(target)) {
  console.error(`[test] 目录不存在：${target}`);
  process.exit(1);
}

const files = collect(target).sort();
if (files.length === 0) {
  console.error(`[test] 未找到 *.test.js：${target}`);
  process.exit(1);
}

console.log(`[test] ${files.length} 个测试文件：`);
for (const file of files) console.log(`       · ${path.relative(process.cwd(), file)}`);

for (const file of files) {
  await import(pathToFileURL(file).href);
}

function collect(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(absolute));
    else if (entry.name.endsWith('.test.js')) out.push(absolute);
  }
  return out;
}
