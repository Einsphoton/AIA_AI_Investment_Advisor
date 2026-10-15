/**
 * Data-source degradation regressions.
 *
 * Production context (2026-10-15): Eastmoney's `push2` / `push2his` hosts returned
 * HTTP 502 / connection resets from the user's network while
 * `datacenter.eastmoney.com` (F10 statements) and Tencent stayed reachable.
 * Because `get_series` and the HK/US `get_fundamentals` path had exactly one
 * zero-key provider, those tools answered `no_data` for every instrument —
 * 26 red steps in the activity log and 12+ reports whose conclusion line read
 * 「数据缺失…该工具已停用」. Nothing covered this offline.
 *
 * These tests stub `globalThis.fetch`, so they are deterministic and network-free.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { clearHttpCache, UpstreamHttpError } from '../src/datasources/http.js';
import { normalizeCode } from '../src/datasources/registry.js';
import { getFundamentals, getQuote, getSeries } from '../src/datasources/registry.js';
import { emSecidCandidates, emUsCode } from '../src/datasources/eastmoney.js';
import { globalIndices } from '../src/datasources/indices.js';
import { macroBundle } from '../src/datasources/macro.js';
import { parseTencentRecord, parseIfzqSeries, tencentSymbol } from '../src/datasources/tencent.js';

/** One `~`-separated Tencent record; only the indices we assert on need meaning. */
function tencentRecord(fields: Partial<Record<number, string>>): string {
  const out = new Array<string>(80).fill('');
  for (const [index, value] of Object.entries(fields)) {
    if (value !== undefined) out[Number(index)] = value;
  }
  out[1] = fields[1] ?? '中国海油';
  out[3] = fields[3] ?? '34.78';
  // A single `v_<symbol>="…"` assignment, exactly like the real payload — the
  // parser takes the *first* match, so a decoy assignment must not be prepended.
  return `v_hk00939="${out.join('~')}";`;
}

function tencentKlineBody(symbol: string, name: string, rows: string[][]): string {
  return JSON.stringify({
    code: 0,
    data: { [symbol]: { qfqday: rows, qt: { [symbol]: ['delay', name, symbol.toUpperCase(), rows.at(-1)?.[2] ?? '0'] } } },
  });
}

/** Routes each datasource host to a scripted answer; records every URL hit. */
function stubFetch(handler: (url: string) => Response | null): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    const response = handler(url);
    if (response) return response;
    // Anything unrouted is an upstream outage, like the real push2 host was.
    return new Response('<html><title>502 Bad Gateway</title></html>', { status: 502 });
  }) as unknown as typeof fetch;
  clearHttpCache();
  return { urls };
}

const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
});

const KLINE_ROWS = [
  ['2026-10-12', '35.10', '35.40', '35.50', '34.90', '1000'],
  ['2026-10-13', '35.40', '35.20', '35.60', '35.00', '1200'],
  ['2026-10-14', '35.20', '34.78', '35.30', '34.50', '2000'],
];

/* ───────────────────────── series fallback (D2) ──────────────────────────── */

test('回归：东方财富 K 线全部失败时，get_series 由腾讯兜底成功（不再 no_data）', async () => {
  const { urls } = stubFetch((url) => {
    if (url.includes('ifzq.gtimg.cn')) {
      return new Response(tencentKlineBody('sh600938', '中国海油', KLINE_ROWS), { status: 200 });
    }
    return null; // eastmoney push2his → 502
  });
  try {
    const result = await getSeries({ code: '600938', market: 'CN', type: 'stock', range: '1y', interval: 'day' });
    assert.ok(result, '腾讯兜底必须返回数据');
    assert.deepEqual(result.sources, ['tencent']);
    assert.equal(result.value.points.length, 3);
    // Tencent order is [date, open, close, high, low, volume].
    assert.deepEqual(result.value.points.at(-1), {
      date: '2026-10-14',
      open: 35.2,
      close: 34.78,
      high: 35.3,
      low: 34.5,
      volume: 2000,
    });
    assert.ok(urls.some((url) => url.includes('ifzq.gtimg.cn')), '必须真的请求过腾讯 K 线');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('回归：全部数据源失败时，get_series 把上游错误交给 onWarnings（不再吞成静默 no_data）', async () => {
  stubFetch(() => null); // every host down
  try {
    const warnings: string[] = [];
    const result = await getSeries({
      code: '600938',
      market: 'CN',
      type: 'stock',
      range: '1y',
      interval: 'day',
      onWarnings: (list) => warnings.push(...list),
    });
    assert.equal(result, null);
    assert.ok(warnings.length > 0, '失败原因必须被透出');
    assert.ok(
      warnings.some((warning) => /HTTP 502|失败/.test(warning)),
      `必须说明是上游故障而不是「没数据」，实际：${warnings.join(' | ')}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('腾讯 K 线解析：US 需要带交易所后缀的符号，且不接受空/坏响应', () => {
  const body = tencentKlineBody('usWFC.N', '富国银行', KLINE_ROWS);
  const parsed = parseIfzqSeries(body, 'usWFC.N', 'US', 'WFC', '1y', 'day');
  assert.equal(parsed?.series.points.length, 3);
  assert.equal(parsed?.series.name, '富国银行');

  assert.equal(parseIfzqSeries('not json', 'usWFC.N', 'US', 'WFC', '1y', 'day'), null);
  assert.equal(parseIfzqSeries('{"data":{}}', 'usWFC.N', 'US', 'WFC', '1y', 'day'), null);
  assert.equal(
    parseIfzqSeries(JSON.stringify({ data: { 'usWFC.N': { qfqday: [] } } }), 'usWFC.N', 'US', 'WFC', '1y', 'day'),
    null,
  );
});

/* ───────────────── fundamentals fallback for HK/US (D3) ──────────────────── */

test('回归：push2 报价不可用时，港股/美股 get_fundamentals 由腾讯兜底返回估值指标', async () => {
  const { urls } = stubFetch((url) => {
    if (url.includes('qt.gtimg.cn')) {
      return new Response(
        tencentRecord({ 1: '建设银行', 3: '9.96', 39: '6.94', 45: '26055.3980', 46: 'CCB', 58: '0.63' }),
        { status: 200 },
      );
    }
    return null; // push2 quote → 502, datacenter F10 → 502
  });
  try {
    const result = await getFundamentals({ code: '00939', market: 'HK', type: 'stock' });
    assert.ok(result, '港股基本面必须有兜底');
    assert.deepEqual(result.sources, ['tencent']);
    const pe = result.value.metrics.find((metric) => metric.key === 'peTtm');
    const pb = result.value.metrics.find((metric) => metric.key === 'pb');
    assert.equal(pe?.value, 6.94);
    assert.equal(pb?.value, 0.63, '港股 PB 必须取对字段（旧的 index 47 会得到 4.41）');
    assert.ok(urls.some((url) => url.includes('qt.gtimg.cn')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('回归：ETF 不使用腾讯估值兜底（行情字段不是公司基本面，会给报告塞假 PB）', async () => {
  stubFetch((url) => {
    if (url.includes('qt.gtimg.cn')) {
      return new Response(tencentRecord({ 1: '红利ETF', 3: '3.406', 39: '0', 46: '1.93' }), { status: 200 });
    }
    return null;
  });
  try {
    const warnings: string[] = [];
    const result = await getFundamentals({
      code: '510880',
      market: 'CN',
      type: 'etf',
      onWarnings: (list) => warnings.push(...list),
    });
    assert.equal(result, null, 'ETF 不应返回公司基本面指标');
    assert.ok(
      warnings.some((warning) => warning.includes('ETF')),
      `必须说明 ETF 不适用，实际：${warnings.join(' | ')}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* ────────────────────────── US class-share aliases (D4) ──────────────────── */

test('回归：US 类别股别名折成点号，且东方财富用下划线secid', () => {
  for (const spelling of ['BRK-B', 'BRK_B', 'BRKB', 'BRK.B', ' brk-b ']) {
    assert.equal(normalizeCode('US', spelling), 'BRK.B', `${spelling} 必须归一为 BRK.B`);
  }
  assert.equal(normalizeCode('US', 'BRK-A'), 'BRK.A');
  assert.equal(emUsCode('BRK.B'), 'BRK_B', '东方财富只认下划线写法');
  assert.ok(
    emSecidCandidates('US', 'BRK.B').includes('106.BRK_B'),
    '候选 secid 必须包含东方财富实际能命中的 106.BRK_B',
  );
});

test('回归：真实存在的美股代码绝不能被别名规则改写（BRKR≠BRK.R）', () => {
  // `BRKR` (Bruker Corp) is `BRK` + one letter by shape, exactly like `BRKB`.
  // Guessing by shape rewrote it into the nonexistent `BRK.R`; only an exact
  // allow-list may map the dashless spelling.
  for (const real of ['BRKR', 'WFC', 'AAPL', 'COP', 'VZ', 'T', 'SCHD', 'AGG']) {
    assert.equal(normalizeCode('US', real), real, `${real} 必须原样保留`);
  }
  assert.equal(tencentSymbol('US', 'BRK.B'), 'usBRK.B', '腾讯只认点号写法');
  assert.equal(tencentSymbol('HK', '939'), 'hk00939');
  assert.equal(tencentSymbol('CN', '600938'), 'sh600938');
});

test('回归：腾讯行情 PB 按市场取字段（index 47 不是 PB）', () => {
  const fields = new Array<string>(80).fill('');
  fields[1] = '中国海油';
  fields[3] = '34.78';
  fields[39] = '11.95';
  fields[46] = '1.93'; // CN 的真实 PB
  fields[47] = '39.33'; // 旧代码当成 PB 的字段
  const record = fields.join('~');

  assert.equal(parseTencentRecord(record, 'CN', '600938')?.pb, 1.93, 'A 股 PB 必须取 index 46');
  // 港股记录在 46 放公司英文名，真实 PB 在 58。
  const hk = new Array<string>(80).fill('');
  hk[1] = '建设银行';
  hk[3] = '9.96';
  hk[39] = '6.94';
  hk[46] = 'CCB';
  hk[47] = '4.41';
  hk[58] = '0.63';
  assert.equal(parseTencentRecord(hk.join('~'), 'HK', '00939')?.pb, 0.63, '港股 PB 必须取 index 58');
  // 美股布局不同，没有可靠字段时宁可不报，也不能报错值。
  assert.equal(parseTencentRecord(record, 'US', 'WFC')?.pb, 0, '美股不报 PB');
});

/* ───────────────────────── upstream failure vs empty data ────────────────── */

test('回归：HTTP 502 与「返回空数据」在诊断信息里必须可区分', async () => {
  stubFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
  try {
    const warnings: string[] = [];
    await getQuote({ code: 'WFC', market: 'US', onWarnings: (list) => warnings.push(...list) });
    assert.ok(
      warnings.some((warning) => /HTTP 502/.test(warning)),
      `必须保留 HTTP 状态，而不是笼统的「未返回报价」，实际：${warnings.join(' | ')}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UpstreamHttpError 保留状态码与响应体（诊断依赖它）', () => {
  const error = new UpstreamHttpError('https://push2.eastmoney.com/api/qt/stock/get', 502, '<html>502</html>');
  assert.equal(error.status, 502);
  assert.match(error.message, /502/);
});

/* ─────────────────── global indices fallback (macro, 2026-10-15) ──────────── */

/** `v_<symbol>="…"` batch body, the shape `qt.gtimg.cn/q=` really returns. */
function tencentBatchBody(entries: Array<[symbol: string, name: string, price: string]>): string {
  return entries
    .map(([symbol, name, price]) => {
      const fields = new Array<string>(80).fill('');
      fields[1] = name;
      fields[3] = price;
      return `v_${symbol}="${fields.join('~')}";`;
    })
    .join('');
}

test('回归：push2 挂掉时全球指数由腾讯兜底，且降级原因带 HTTP 状态', async () => {
  // 生产现场：首页能显示指数（走后端 registry.getIndices），而 get_macro 报
  // 「全球指数快照不可用」—— 因为 macroBundle 直接调 emIndices()，绕过了兜底。
  const { urls } = stubFetch((url) => {
    if (url.includes('qt.gtimg.cn')) {
      return new Response(
        tencentBatchBody([
          ['sh000001', '上证指数', '3200.12'],
          ['hkHSI', '恒生指数', '26000.50'],
        ]),
        { status: 200 },
      );
    }
    return null; // push2 ulist → 502
  });
  try {
    const result = await globalIndices();
    assert.ok(result.value.length > 0, '腾讯兜底必须给出指数，不能是空快照');
    assert.deepEqual(result.sources, ['tencent']);
    assert.ok(urls.some((url) => url.includes('push2.eastmoney.com')), '必须先试东方财富');
    assert.ok(urls.some((url) => url.includes('qt.gtimg.cn')), '必须真的请求过腾讯兜底');
    assert.ok(
      result.warnings.some((warning) => /HTTP 502/.test(warning)),
      `降级原因必须保留 HTTP 状态，实际：${result.warnings.join(' | ')}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('回归：两家都挂时，指数 warning 带真实原因而不是只有「不可用」', async () => {
  stubFetch(() => null); // push2 + qt.gtimg 全挂
  try {
    const result = await globalIndices();
    assert.equal(result.value.length, 0);
    assert.deepEqual(result.sources, []);
    assert.ok(
      result.warnings.some((warning) => /HTTP 502|失败/.test(warning)),
      `必须能区分「上游故障」与「上游返回空」，实际：${result.warnings.join(' | ')}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('回归：macroBundle 有兜底时不再报「快照不可用」；社融只在 notes、不进 warnings', async () => {
  stubFetch((url) => {
    if (url.includes('datacenter-web.eastmoney.com')) {
      // 报表返回空即可 —— 本用例只关心指数链路与 社融/notes 的分流。
      return new Response(JSON.stringify({ success: true, result: { data: [] } }), { status: 200 });
    }
    if (url.includes('qt.gtimg.cn')) {
      return new Response(tencentBatchBody([['sh000001', '上证指数', '3200.12']]), { status: 200 });
    }
    return null; // push2 → 502
  });
  try {
    const bundle = await macroBundle();
    assert.equal(bundle.indices.length, 1, '兜底成功后 indices 不能为空');
    assert.ok(
      bundle.warnings.some((warning) => warning.includes('已降级为腾讯行情')),
      `网络降级要如实标注，实际：${bundle.warnings.join(' | ')}`,
    );
    assert.ok(
      !bundle.warnings.some((warning) => warning.includes('全球指数快照不可用')),
      '有兜底数据时绝不能再说「不可用」',
    );
    assert.ok(
      bundle.notes.some((note) => note.includes('社会融资规模')),
      '社融是已知覆盖缺口，应作为 notes 告知模型',
    );
    assert.ok(
      !bundle.warnings.some((warning) => warning.includes('社会融资规模')),
      '社融是稳态缺口，不允许再当成每次运行的 warning 刷屏',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
