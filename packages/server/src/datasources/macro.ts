/**
 * 宏观数据中心 provider — zero-key CPI / PPI / GDP / PMI / M2 / LPR + global indices.
 *
 * Endpoint shapes verified 2026-10-14 / 2026-10-15 (docs/SOURCES.md §4).
 *
 * LPR 走 `RPTA_WEB_RATE`（贷款市场报价利率，字段 LPR1Y / LPR5Y）—— 2026-10-15
 * 复核确认可用，此前注释里「上游没有 LPR 报表」的结论是错的，已修正。
 *
 * 全球指数走 `indices.globalIndices()`（东财优先、腾讯兜底），不再直接调
 * `emIndices()` —— 那条路径没有兜底，上游 502 就会整块报「快照不可用」。
 *
 * 社会融资规模确实没有可用的零 Key 报表（已核对 RPT_ECONOMY_* / RPTA_WEB_*
 * 的常见命名）。它是**已知覆盖缺口，不是故障**：放在 `notes` 而不是 `warnings`，
 * 不再每次运行都刷一条「缺失」；模型侧由系统提示词规则 14 兜底。
 *
 * Owner: agent-engine.
 */
import type { MacroItem, SourceId } from '@aia/shared';
import { round4, toNumber, tryJson } from './http.js';
import { globalIndices } from './indices.js';
import type { MacroBundle } from './types.js';

const SOURCE: SourceId = 'eastmoney-macro';
const MACRO_TTL_MS = 30 * 60_000;
const REFERER = 'https://data.eastmoney.com/';

interface EmDataResponse {
  success?: boolean;
  result?: { data?: Array<Record<string, unknown>> | null } | null;
}

async function macroRows(
  reportName: string,
  pageSize: number,
  sortColumn = 'REPORT_DATE',
): Promise<Array<Record<string, unknown>>> {
  const url =
    `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=${reportName}` +
    `&columns=ALL&pageNumber=1&pageSize=${pageSize}&sortColumns=${sortColumn}&sortTypes=-1`;
  const json = await tryJson<EmDataResponse>(url, {
    headers: { Referer: REFERER },
    cacheTtlMs: MACRO_TTL_MS,
    cacheKey: `macro:${reportName}:${pageSize}:${sortColumn}`,
  });
  return json?.result?.data ?? [];
}

/** Exported for tests: report period label from whichever date column exists. */
export const periodOf = (row: Record<string, unknown> | undefined): string => {
  if (!row) return '';
  if (typeof row.TIME === 'string' && row.TIME.trim()) return row.TIME.trim();
  if (typeof row.REPORT_DATE === 'string') return row.REPORT_DATE.slice(0, 7);
  // LPR（RPTA_WEB_RATE）只有 TRADE_DATE，精确到报价日（每月 20 日）。
  if (typeof row.TRADE_DATE === 'string' && row.TRADE_DATE.trim()) return row.TRADE_DATE.slice(0, 10);
  return '';
};

/** Exported for tests: one report row → one macro item. */
export function item(
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
  const [cpi, ppi, gdp, pmi, money, lpr, indices] = await Promise.all([
    macroRows('RPT_ECONOMY_CPI', 3),
    macroRows('RPT_ECONOMY_PPI', 3),
    macroRows('RPT_ECONOMY_GDP', 3),
    macroRows('RPT_ECONOMY_PMI', 3),
    macroRows('RPT_ECONOMY_CURRENCY_SUPPLY', 3),
    // LPR 按报价日（每月 20 日）排序，没有 REPORT_DATE 列。
    macroRows('RPTA_WEB_RATE', 3, 'TRADE_DATE'),
    // 东财优先、腾讯兜底；失败原因留在 `indices.warnings` 里。
    globalIndices(),
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
  // 贷款市场报价利率（LPR）：每月 20 日公布，是判断利率环境的直接指标。
  push(item('lpr_1y', 'LPR 1 年期', latest(lpr), 'LPR1Y', '%'));
  push(item('lpr_5y', 'LPR 5 年期以上', latest(lpr), 'LPR5Y', '%'));

  if (cpi.length === 0) warnings.push('宏观：CPI 报表不可用');
  if (ppi.length === 0) warnings.push('宏观：PPI 报表不可用');
  if (gdp.length === 0) warnings.push('宏观：GDP 报表不可用');
  if (pmi.length === 0) warnings.push('宏观：PMI 报表不可用');
  if (money.length === 0) warnings.push('宏观：货币供应报表不可用');
  if (lpr.length === 0) warnings.push('宏观：LPR 报表不可用（RPTA_WEB_RATE）');

  // 指数：两家都拿到空才是「不可用」；东财挂了但腾讯兜住，如实标注降级原因，
  // 但不再让整块指数消失（此前 macroBundle 直接调 emIndices()，没有兜底）。
  if (indices.value.length === 0) {
    warnings.push(`宏观：全球指数快照不可用（${indices.warnings.join('；') || '两家上游均返回空'}）`);
  } else if (!indices.sources.includes('eastmoney')) {
    warnings.push(`宏观：全球指数已降级为腾讯行情（${indices.warnings.join('；') || '东方财富不可用'}）`);
  }

  // 已知覆盖缺口，不是故障 —— 见文件头注释与系统提示词规则 14。
  const notes: string[] = [
    '社会融资规模：东财数据中心无可用零 Key 报表（已核对 RPT_ECONOMY_* / RPTA_WEB_* 常见命名），属已知覆盖缺口；如需引用请用 web_search 检索官方口径并注明来源与发布日期',
  ];

  return { items, indices: indices.value, warnings, notes };
}

/** Exposed for tests/tools: single macro report rows. */
export const macroReport = macroRows;
export { SOURCE as MACRO_SOURCE };
