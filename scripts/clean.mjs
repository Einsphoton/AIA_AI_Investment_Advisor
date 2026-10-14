/**
 * Removes build outputs (never touches data/).
 * Usage: npm run clean
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  'packages/shared/dist',
  'packages/server/dist',
  'packages/server/dist-test',
  'packages/web/dist',
  'packages/web/dist-a',
  'packages/web/dist-b',
];

for (const rel of targets) {
  const absolute = path.join(root, rel);
  if (fs.existsSync(absolute)) {
    fs.rmSync(absolute, { recursive: true, force: true });
    console.log(`removed ${rel}`);
  }
}
console.log('clean done（data/ 未被删除）');
