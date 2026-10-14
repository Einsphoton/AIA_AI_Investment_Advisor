/**
 * Export an agent run's full trajectory (`npm run trace -- <runId>`).
 *
 *   node scripts/export-trace.mjs --list            # 最近 20 次运行
 *   node scripts/export-trace.mjs <runId>           # 打印轨迹摘要 + 写出 JSON 文件
 *   node scripts/export-trace.mjs <runId> --out x.json
 *
 * Opening the DB directly keeps this usable while the server is stopped, which
 * is exactly when you want to post-mortem a failed run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outFile = outIndex >= 0 ? args[outIndex + 1] : null;
// Only swallow the value that belongs to `--out`; without that flag every
// positional argument is a run id (this used to drop the first one).
const positional = args.filter((arg, index) => !arg.startsWith('--') && (outIndex < 0 || index !== outIndex + 1));

const dataDir = path.isAbsolute(process.env.DATA_DIR ?? '') ? process.env.DATA_DIR : path.resolve(root, process.env.DATA_DIR ?? 'data');
const dbPath = path.join(dataDir, 'advisor.db');
if (!fs.existsSync(dbPath)) {
  console.error(`[trace] 数据库不存在：${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const asArray = (rows) => rows.map((row) => ({ ...row }));

if (args.includes('--list') || positional.length === 0) {
  const runs = asArray(
    db
      .prepare(
        `SELECT id, kind, status, title, turns, prompt_tokens, completion_tokens, started_at, finished_at,
                (SELECT COUNT(*) FROM agent_steps s WHERE s.run_id = r.id) AS steps
           FROM agent_runs r ORDER BY started_at DESC LIMIT 20`,
      )
      .all(),
  );
  if (runs.length === 0) console.log('[trace] 暂无运行记录。');
  else {
    console.log('最近运行（用 `npm run trace -- <id>` 查看轨迹）：\n');
    for (const run of runs) {
      const duration = run.finished_at ? `${Math.round((Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000)}s` : '进行中';
      console.log(
        `  ${String(run.id).slice(0, 8)}  ${String(run.status).padEnd(7)} ${String(run.kind).padEnd(18)} ` +
          `turns=${run.turns} steps=${run.steps} tokens=${run.prompt_tokens}+${run.completion_tokens} ${duration}  ${run.title}`,
      );
    }
  }
  db.close();
  process.exit(0);
}

const runId = positional[0];
/* Accept a unique id prefix, which is what the list prints. */
const row =
  db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId) ??
  db.prepare('SELECT * FROM agent_runs WHERE id LIKE ? LIMIT 2').all(`${runId}%`)[0];
if (!row) {
  console.error(`[trace] 未找到运行记录：${runId}`);
  db.close();
  process.exit(1);
}

const full = {
  run: { ...row },
  steps: asArray(db.prepare('SELECT * FROM agent_steps WHERE run_id = ? ORDER BY idx ASC').all(row.id)),
  messages: asArray(db.prepare('SELECT * FROM agent_run_messages WHERE run_id = ? ORDER BY idx ASC').all(row.id)),
  audit: asArray(db.prepare('SELECT * FROM audit_log WHERE run_id = ? ORDER BY at ASC').all(row.id)),
  pendingWrites: asArray(db.prepare('SELECT * FROM pending_writes WHERE run_id = ? ORDER BY created_at ASC').all(row.id)),
};
db.close();

const duration = row.finished_at ? `${Math.round((Date.parse(row.finished_at) - Date.parse(row.started_at)) / 1000)}s` : '进行中';
console.log(`\n运行 ${row.id}`);
console.log(`  类型/状态 : ${row.kind} / ${row.status}   (${duration})`);
console.log(`  标题      : ${row.title}`);
console.log(`  轮次/步数 : ${row.turns} 轮 / ${full.steps.length} 步`);
console.log(`  token     : prompt ${row.prompt_tokens} + completion ${row.completion_tokens}`);
if (row.error) console.log(`  错误      : ${row.error}`);

const toolCalls = full.steps.filter((step) => step.tool_name);
console.log(`\n工具调用（${toolCalls.length}）：`);
for (const step of toolCalls) {
  const status = step.status === 'done' ? '✓' : '✗';
  console.log(`  ${status} [${step.idx}] ${step.tool_name}  ${String(step.tool_result ?? '').replace(/\s+/g, ' ').slice(0, 100)}`);
}

console.log(`\n轨迹：${full.messages.length} 条消息，审计 ${full.audit.length} 条，待审批 ${full.pendingWrites.length} 条`);
const summary = String(row.summary ?? '').replace(/\s+/g, ' ');
if (summary) console.log(`\n结论摘录：${summary.slice(0, 300)}${summary.length > 300 ? '…' : ''}`);

const target = outFile ? path.resolve(root, outFile) : path.join(root, '.traces', `${row.id}.json`);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(full, null, 2), 'utf8');
console.log(`\n完整轨迹已写出：${path.relative(root, target)}`);
