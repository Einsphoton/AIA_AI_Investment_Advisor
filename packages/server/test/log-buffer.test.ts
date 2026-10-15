/**
 * 日志环形缓冲单测（远程排障依赖它）。
 *
 * 背景：远程 NAS 上日志只进 stdout，Docker 的 json-file 轮转（10MB × 3）之后
 * 现场就没了；`GET /api/diagnostics/logs` 读的是进程内缓冲，必须能稳定解析
 * pino 的 JSON 行、按级别过滤、并有上限保护。
 *
 * Owner: server-core.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearLogBuffer,
  createLogStream,
  logBufferSize,
  parseLogLine,
  pushLogChunk,
  recentLogs,
} from '../src/services/log-buffer.js';

test('parseLogLine：解析 pino JSON，非 JSON 行也能兜住', () => {
  const info = parseLogLine('{"level":30,"time":1700000000000,"msg":"hello"}');
  assert.equal(info?.level, 'info');
  assert.equal(info?.msg, 'hello');
  assert.equal(info?.at, new Date(1700000000000).toISOString());

  const warn = parseLogLine('{"level":40,"time":1700000000001,"msg":"careful"}');
  assert.equal(warn?.level, 'warn');

  const fatal = parseLogLine('{"level":60,"time":1700000000002,"msg":"dead"}');
  assert.equal(fatal?.level, 'fatal');

  // 栈信息等非 JSON 输出不能丢，也不能抛。
  const raw = parseLogLine('    at foo (bar.js:1:1)');
  assert.equal(raw?.level, 'info');
  assert.match(raw?.msg ?? '', /at foo/);

  assert.equal(parseLogLine('   '), null);
});

test('pushLogChunk：一次写多行、按级别过滤、超长行截断', () => {
  clearLogBuffer();
  pushLogChunk(
    [
      '{"level":30,"time":1700000000000,"msg":"one"}',
      '{"level":50,"time":1700000000001,"msg":"two"}',
      '{"level":20,"time":1700000000002,"msg":"three"}',
      '',
    ].join('\n'),
  );
  assert.equal(logBufferSize(), 3, '空行不入缓冲');
  assert.deepEqual(
    recentLogs(10).map((record) => record.level),
    ['info', 'error', 'debug'],
  );
  assert.deepEqual(
    recentLogs(10, 'warn').map((record) => record.msg),
    ['two'],
  );
  assert.equal(recentLogs(2).length, 2, 'limit 取最新的 N 条');
  assert.deepEqual(
    recentLogs(2).map((record) => record.msg),
    ['two', 'three'],
  );

  clearLogBuffer();
  const huge = 'x'.repeat(9000);
  pushLogChunk(JSON.stringify({ level: 30, time: 1700000000000, msg: huge }));
  const [record] = recentLogs(1);
  assert.ok((record?.raw.length ?? 0) <= 4001, 'raw 必须有上限，避免一次大结果撑爆诊断响应');
  assert.ok((record?.msg.length ?? 0) <= 501);
  clearLogBuffer();
});

test('createLogStream：同时写 stdout 与环形缓冲（docker logs 不受影响）', async () => {
  clearLogBuffer();
  const stream = createLogStream();
  const written: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const line = '{"level":40,"time":1700000000000,"msg":"proxy probe failed"}\n';
    await new Promise<void>((resolve, reject) => {
      stream.write(line, (error?: Error | null) => (error ? reject(error) : resolve()));
    });
    assert.equal(written.join(''), line, '必须原样透传到 stdout');
    assert.equal(logBufferSize(), 1);
    assert.equal(recentLogs(1)[0]?.msg, 'proxy probe failed');
    // pino 在关机路径上会调用这两个方法；不能是 undefined。
    assert.equal(typeof stream.flushSync, 'function');
    assert.equal(typeof stream.flush, 'function');
  } finally {
    process.stdout.write = originalWrite;
    clearLogBuffer();
  }
});
