/**
 * In-memory ring buffer of recent log lines (for remote post-mortems).
 *
 * Why this exists: pino writes to stdout only, and the container's json-file
 * driver rotates at 10MB × 3 — so on a remote NAS a failed run could be gone
 * before anyone looked, and there was no way to pull the scene out. This tees
 * the pino output into a bounded buffer that `GET /api/diagnostics/report`
 * can return in one request.
 *
 * `createLogStream()` is only used when logging is enabled; with
 * `LOG_LEVEL=silent` the buffer stays empty (tests).
 *
 * Owner: server-core.
 */
import { Writable } from 'node:stream';

export interface LogRecord {
  seq: number;
  at: string;
  level: string;
  msg: string;
  /** Full pino JSON line, capped so one huge tool result cannot blow up the payload. */
  raw: string;
}

const MAX_RECORDS = 1000;
const MAX_RAW_CHARS = 4000;
const MAX_MSG_CHARS = 500;

/** pino numeric levels → names. */
const LEVEL_NAMES: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};
const LEVEL_ORDER = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

const records: LogRecord[] = [];
let seq = 0;

/** Parses one pino line; tolerates non-JSON output (e.g. a stray stack trace). */
export function parseLogLine(line: string): LogRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  seq += 1;
  try {
    const json = JSON.parse(trimmed) as { level?: unknown; time?: unknown; msg?: unknown };
    const levelNum = typeof json.level === 'number' ? json.level : Number(json.level);
    const time = typeof json.time === 'number' && Number.isFinite(json.time) ? json.time : Date.now();
    const msg = typeof json.msg === 'string' ? json.msg : '';
    return {
      seq,
      at: new Date(time).toISOString(),
      level: LEVEL_NAMES[levelNum] ?? (typeof json.level === 'string' ? json.level : 'info'),
      msg: msg.length > MAX_MSG_CHARS ? `${msg.slice(0, MAX_MSG_CHARS)}…` : msg,
      raw: trimmed.length > MAX_RAW_CHARS ? `${trimmed.slice(0, MAX_RAW_CHARS)}…` : trimmed,
    };
  } catch {
    return {
      seq,
      at: new Date().toISOString(),
      level: 'info',
      msg: trimmed.slice(0, MAX_MSG_CHARS),
      raw: trimmed.slice(0, MAX_RAW_CHARS),
    };
  }
}

/** Appends a raw chunk of pino output (may contain several lines). */
export function pushLogChunk(chunk: string): void {
  for (const line of chunk.split('\n')) {
    const record = parseLogLine(line);
    if (!record) continue;
    records.push(record);
    if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  }
}

/** Newest-last slice of the buffer, optionally floored at `minLevel` (case-insensitive). */
export function recentLogs(limit = 200, minLevel?: string): LogRecord[] {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 200, MAX_RECORDS));
  const floor = minLevel ? LEVEL_ORDER.indexOf(minLevel.trim().toLowerCase()) : -1;
  const filtered = floor > 0 ? records.filter((record) => LEVEL_ORDER.indexOf(record.level) >= floor) : records.slice();
  return filtered.slice(-safeLimit);
}

export function logBufferSize(): number {
  return records.length;
}

export function clearLogBuffer(): void {
  records.length = 0;
}

/**
 * pino destination contract: a writable plus the two flush hooks pino touches on
 * shutdown (`logger.flush()` / `beforeExit`). Both are no-ops here.
 */
export type LogStream = Writable & {
  flush?: (cb?: () => void) => void;
  flushSync?: () => void;
};

/**
 * pino destination that mirrors every line to stdout (so `docker logs` keeps
 * working) **and** into the ring buffer.
 */
export function createLogStream(): LogStream {
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      pushLogChunk(text);
      process.stdout.write(text);
      callback();
    },
  }) as LogStream;

  // pino touches these on shutdown / `logger.flush()`; stdout above is already
  // synchronous, so they are no-ops rather than missing methods.
  stream.flush = (cb?: () => void): void => {
    if (cb) cb();
  };
  stream.flushSync = (): void => {};
  return stream;
}
