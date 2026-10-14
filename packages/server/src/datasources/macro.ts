/**
 * 宏观数据中心 provider — zero-key CPI / PPI / GDP / PMI / M2 + global indices.
 *
 * Endpoint shapes verified 2026-10-14 (docs/SOURCES.md §4). LPR / 社融 reports do
 * not exist upstream; the agent is expected to use `web_search` for those.
 *
 * Owner: agent-engine.
 */
import type { MacroItem, SourceId } from '@aia/shared';
import { round4, toNumber, tryJson } from './http.js';
import { emIndices } from './eastmoney.js';
import type { MacroBundle } from './types.js';

const SOURCE: SourceId = 'eastmoney-macro';
const MACRO_TTL_MS = 30 * 60_000;
const REFERER = 'https://data.eastmoney.com/';

interface EmDataResponse {
  success?: boolean;
  result?: { data?: Array<Record<string, unknown>> | null } | null;
}

async function macroRows(reportName: string, pageSize: number): Promise<Array<Record<string, unknown>>> {
  const url =
    `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=${reportName}` +
    `&columns=ALL&pageNumber=1&pageSize=${pageSize}&sortColumns=REPORT_DATE&sortTypes=-1`;
  const json = await tryJson<EmDataResponse>(url, {
    headers: { Referer: REFERER },
    cacheTtlMs: MACRO_TTL_MS,
    cacheKey: `macro:${reportName}:${pageSize}`,
  });
  return json?.result?.data ?? [];
}

const periodOf = (row: Record<string, unknown> | undefined): string => {
  if (!row) return '';
  if (typeof row.TIME === 'string' && row.TIME.trim()) return row.TIME.trim();
  if (typeof row.REPORT_DATE === 'string') return row.REPORT_DATE.slice(0, 7);
  return '';
};

function item(
  key: string,
  label: string,
  row: Record<string, unknown> | undefined,
  field: string,
  unit: string,
  yoyField?: string,
): MacroItem | null {
  if (!row) return null;
  const raw = row[field];
  if (raw === null || raw === undefined || raw === '') return null;
  // `yoy` is only set when the upstream field really is a year-over-year figure
  // (money supply). PMI/CPI/PPI publish 环比/指数 fields instead, which are
  // exported as separate items to avoid mislabelling.
  const yoyRaw = yoyField ? row[yoyField] : undefined;
  return {
    key,
    label,
    value: round4(toNumber(raw)),
    unit,
    period: periodOf(row),
    yoy: yoyRaw === null || yoyRaw === undefined || yoyRaw === '' ? null : round4(toNumber(yoyRaw)),
  };
}

/**
 * Macro snapshot: CPI/PPI/GDP/PMI/M2 items + global indices.
 * Missing upstream reports are reported as warnings, never as silent zeros.
 */
export async function macroBundle(): Promise<MacroBundle> {
  const warnings: string[] = [];
  const [cpi, ppi, gdp, pmi, money, indices] = await Promise.all([
    macroRows('RPT_ECONOMY_CPI', 3),
    macroRows('RPT_ECONOMY_PPI', 3),
    macroRows('RPT_ECONOMY_GDP', 3),
    macroRows('RPT_ECONOMY_PMI', 3),
    macroRows('RPT_ECONOMY_CURRENCY_SUPPLY', 3),
    emIndices(),
  ]);

  const latest = (rows: Array<Record<string, unknown>>): Record<string, unknown> | undefined => rows[0];
  const items: MacroItem[] = [];
  const push = (entry: MacroItem | null): void => {
    if (entry) items.push(entry);
  };

  // `yoy` is passed only where the upstream column is a true year-over-year
  // figure (money supply). CPI/PPI/PMI publish 环比/指数 columns, which are
  // exposed as separate items instead of being mislabelled as yoy.
  push(item('cpi_yoy', 'CPI 同比', latest(cpi), 'NATIONAL_SAME', '%'));
  push(item('cpi_mom', 'CPI 环比', latest(cpi), 'NATIONAL_SEQUENTIAL', '%'));
  push(item('ppi_yoy', 'PPI 同比', latest(ppi), 'BASE_SAME', '%'));
  push(item('ppi_index', 'PPI 指数（上年同月=100）', latest(ppi), 'BASE', ''));
  push(item('gdp_yoy', 'GDP 同比', latest(gdp), 'SUM_SAME', '%'));
  push(item('gdp_total', 'GDP 总量', latest(gdp), 'DOMESTICL_PRODUCT_BASE', '亿元'));
  push(item('pmi_manufacturing', '制造业 PMI', latest(pmi), 'MAKE_INDEX', ''));
  push(item('pmi_non_manufacturing', '非制造业 PMI', latest(pmi), 'NMAKE_INDEX', ''));
  push(item('m2', 'M2 余额', latest(money), 'BASIC_CURRENCY', '亿元', 'BASIC_CURRENCY_SAME'));
  push(item('m1', 'M1 余额', latest(money), 'CURRENCY', '亿元', 'CURRENCY_SAME'));
  push(item('m0', 'M0 余额', latest(money), 'FREE_CASH', '亿元', 'FREE_CASH_SAME'));

  if (cpi.length === 0) warnings.push('宏观：CPI 报表不可用');
  if (ppi.length === 0) warnings.push('宏观：PPI 报表不可用');
  if (gdp.length === 0) warnings.push('宏观：GDP 报表不可用');
  if (pmi.length === 0) warnings.push('宏观：PMI 报表不可用');
  if (money.length === 0) warnings.push('宏观：货币供应报表不可用');
  if (indices.length === 0) warnings.push('宏观：全球指数快照不可用');
  warnings.push('LPR / 社会融资规模无可用零 Key 报表，需要时请使用 web_search 联网获取');

  return { items, indices, warnings };
}

/** Exposed for tests/tools: single macro report rows. */
export const macroReport = macroRows;
export { SOURCE as MACRO_SOURCE };
