/**
 * SEC EDGAR XBRL provider —— 美股官方口径（零 Key，免费）。
 *
 * 为什么需要它：东方财富的美股 F10 **没有**现金流量表接口（20+ reportName 全部
 * 「报表配置不存在」），导致 `get_financials` 对美股只能给利润表 + 资产负债表，
 * 而「经营现金流 / 净利润」恰恰是财报质量分析最关键的一项。EDGAR 的 XBRL
 * companyconcept 接口按科目返回全部报告期的官方数值，正好补这个洞。
 *
 * 实测（2026-10-15）：
 *  - `https://www.sec.gov/files/company_tickers.json`（ticker → CIK，约 1MB）✅
 *  - `https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/NetCashProvidedByUsedInOperatingActivities.json` ✅（AAPL 134 个数据点）
 *  - 两个接口都**要求**带联系方式的 User-Agent，否则会被 SEC 拒绝（403）。
 *    默认 UA 见下，可用 `AIA_EDGAR_USER_AGENT` 覆盖（建议填你的邮箱）。
 *
 * 口径说明：同一 `end` 日期上会同时存在「单季」与「年初至今」两种 duration，
 * 本模块按**最长 duration（≤400 天）**取数，与 A 股/港股的累计口径保持一致；
 * 年度（≈365 天）标为年报，其余按 `fp` 标成一季报/中报/三季报。
 *
 * Owner: agent-engine.
 */
import type { FinancialLine, FinancialPeriod } from '@aia/shared';
import { round4, toNumber, tryJson } from './http.js';

const TICKER_TTL_MS = 24 * 60 * 60_000;
const FACT_TTL_MS = 6 * 60 * 60_000;
/**
 * SEC 的 WAF **拒绝**只带 URL 的 User-Agent（实测 403），必须带联系邮箱样式的标识。
 * 这里给一个占位邮箱保证开箱可用，但 SEC 明确要求填真实联系方式 —— 用户可用
 * `AIA_EDGAR_USER_AGENT` 覆盖，未覆盖时会在 warnings 里提示（见 `edgarUsesPlaceholder()`）。
 */
const DEFAULT_UA =
  'AIInvestmentAdvisor/0.1 (self-hosted; contact: aia@example.com; set AIA_EDGAR_USER_AGENT with your email)';

/** SEC 要求可识别的调用方；用环境变量填邮箱/站点更合规。 */
export function edgarUserAgent(): string {
  const raw = process.env.AIA_EDGAR_USER_AGENT;
  return raw && raw.trim() ? raw.trim() : DEFAULT_UA;
}

/** 是否在用占位邮箱（用于把「请填真实邮箱」写进 warnings）。 */
export function edgarUsesPlaceholder(): boolean {
  const raw = process.env.AIA_EDGAR_USER_AGENT;
  return !raw || !raw.trim();
}

/** 抓取用到的表单元数据（`units.USD` 里的一条事实）。 */
export interface EdgarFact {
  start?: string;
  end?: string;
  val?: number;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
  frame?: string;
}

interface CompanyConcept {
  tag?: string;
  label?: string;
  units?: Record<string, EdgarFact[]>;
}

/** 只在定期报告里取数：10-K/10-Q（本土）与 20-F/40-F（外国私人发行人）。 */
const PERIODIC_FORMS = new Set(['10-K', '10-Q', '20-F', '40-F']);

export interface DurationFact {
  start: string;
  end: string;
  val: number;
  fp: string;
  form: string;
  filed: string;
  /** 覆盖天数。 */
  days: number;
}

/** `AAPL` / `aapl` → CIK 映射里用的候选 ticker（EDGAR 用 `-` 而不是 `.`，优先横线形式）。 */
export function edgarTickerCandidates(code: string): string[] {
  const clean = code.trim().toUpperCase();
  const dashed = clean.replace(/\./g, '-');
  return dashed === clean ? [clean] : [dashed, clean];
}

/**
 * 从同一科目的全部事实里，为每个报告期挑一条「年初至今」事实。
 *
 * 规则：① 只要定期报告（`form` ∈ 10-K/10-Q/20-F/40-F）；② duration 落在
 * [60, 400] 天；③ 同一 `end` 取 duration 最长的一条（= 累计口径，含年报）；
 * ④ 同一 `end` + 同 duration 时取最近申报（处理重述）。
 */
export function pickPeriodFacts(
  facts: EdgarFact[],
  options: { minDays?: number; maxDays?: number } = {},
): Map<string, DurationFact> {
  const minDays = options.minDays ?? 60;
  const maxDays = options.maxDays ?? 400;
  const byEnd = new Map<string, DurationFact>();
  for (const fact of facts) {
    const start = typeof fact.start === 'string' ? fact.start.slice(0, 10) : '';
    const end = typeof fact.end === 'string' ? fact.end.slice(0, 10) : '';
    if (!start || !end) continue;
    const form = typeof fact.form === 'string' ? fact.form.toUpperCase() : '';
    if (!PERIODIC_FORMS.has(form)) continue;
    const startMs = Date.parse(`${start}T00:00:00Z`);
    const endMs = Date.parse(`${end}T00:00:00Z`);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    const days = Math.round((endMs - startMs) / 86_400_000);
    if (days < minDays || days > maxDays) continue;
    const candidate: DurationFact = {
      start,
      end,
      val: round4(toNumber(fact.val)),
      fp: typeof fact.fp === 'string' ? fact.fp.toUpperCase() : '',
      form,
      filed: typeof fact.filed === 'string' ? fact.filed.slice(0, 10) : '',
      days,
    };
    const existing = byEnd.get(end);
    if (!existing) {
      byEnd.set(end, candidate);
      continue;
    }
    if (candidate.days > existing.days) {
      byEnd.set(end, candidate);
      continue;
    }
    if (candidate.days === existing.days && candidate.filed > existing.filed) byEnd.set(end, candidate);
  }
  return byEnd;
}

/** 时点事实（资产负债表科目，只有 `end`）。 */
export function pickInstantFacts(facts: EdgarFact[]): Map<string, number> {
  const byEnd = new Map<string, { val: number; filed: string }>();
  for (const fact of facts) {
    const end = typeof fact.end === 'string' ? fact.end.slice(0, 10) : '';
    if (!end || fact.start) continue;
    const filed = typeof fact.filed === 'string' ? fact.filed.slice(0, 10) : '';
    const value = round4(toNumber(fact.val));
    const existing = byEnd.get(end);
    if (!existing || filed > existing.filed) byEnd.set(end, { val: value, filed });
  }
  const out = new Map<string, number>();
  for (const [end, item] of byEnd) out.set(end, item.val);
  return out;
}

function reportTypeOf(fact: DurationFact): string {
  if (fact.days >= 300) return '年报';
  if (fact.fp === 'Q1') return '一季报';
  if (fact.fp === 'Q2') return '中报';
  if (fact.fp === 'Q3') return '三季报';
  return '定期报告';
}

/** 把「锚点期间 + 各科目事实」拼成 `FinancialPeriod[]`（纯函数，可单测）。 */
export function buildCashflowPeriods(
  anchorEnds: string[],
  anchors: { key: string; label: string; facts: Map<string, DurationFact> }[],
  extras: { key: string; label: string; facts: Map<string, DurationFact> }[],
  instant: { key: string; label: string; values: Map<string, number> }[],
  currency = 'USD',
): FinancialPeriod[] {
  return anchorEnds.map((end) => {
    const primary = anchors
      .map((anchor) => anchor.facts.get(end))
      .find((fact): fact is DurationFact => Boolean(fact))!;
    const lines: FinancialLine[] = [];
    for (const anchor of anchors) {
      const fact = anchor.facts.get(end);
      if (!fact) continue;
      lines.push({ key: anchor.key, label: anchor.label, value: fact.val, unit: currency });
    }
    for (const extra of extras) {
      const fact = extra.facts.get(end);
      if (!fact) continue;
      lines.push({ key: extra.key, label: extra.label, value: fact.val, unit: currency });
    }
    for (const item of instant) {
      const value = item.values.get(end);
      if (value === undefined) continue;
      lines.push({ key: item.key, label: item.label, value, unit: currency });
    }
    const reportType = reportTypeOf(primary);
    return {
      period: `${end.slice(0, 4)}年 ${reportType}`,
      reportDate: end,
      reportType,
      currency,
      cumulative: true,
      lines,
    };
  });
}

const US_GAAP_TAGS = {
  operate: 'NetCashProvidedByUsedInOperatingActivities',
  invest: 'NetCashProvidedByUsedInInvestingActivities',
  finance: 'NetCashProvidedByUsedInFinancingActivities',
  capex: 'PaymentsToAcquirePropertyPlantAndEquipment',
  dividends: 'PaymentsOfDividendsCommonStock',
  depreciation: 'DepreciationDepletionAndAmortization',
  cash: 'CashAndCashEquivalentsAtCarryingValue',
} as const;

/** 20-F 等 IFRS 发行人的对应科目（找不到 US GAAP 时回退）。 */
const IFRS_TAGS = {
  operate: 'CashFlowsFromUsedInOperatingActivities',
  invest: 'CashFlowsFromUsedInInvestingActivities',
  finance: 'CashFlowsFromUsedInFinancingActivities',
  capex: 'PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities',
  dividends: 'DividendsPaidClassifiedAsFinancingActivities',
  depreciation: 'DepreciationAndAmortisationExpense',
  cash: 'CashAndCashEquivalents',
} as const;

type TagSet = Record<'operate' | 'invest' | 'finance' | 'capex' | 'dividends' | 'depreciation' | 'cash', string>;

const cikCache = new Map<string, { cik: string; title: string } | null>();

/** ticker → CIK（一次性拉全量表并按 24h 缓存）。 */
export async function edgarCikForTicker(code: string): Promise<{ cik: string; title: string } | null> {
  const candidates = edgarTickerCandidates(code).filter((item) => item.length > 0);
  if (candidates.length === 0) return null;
  const key = `edgar:cik:${candidates[0]}`;
  if (cikCache.has(key)) return cikCache.get(key) ?? null;
  const table = await tryJson<Record<string, { cik_str?: number; ticker?: string; title?: string }>>(
    'https://www.sec.gov/files/company_tickers.json',
    { headers: { 'User-Agent': edgarUserAgent() }, cacheTtlMs: TICKER_TTL_MS, cacheKey: 'edgar:tickers' },
  );
  let hit: { cik: string; title: string } | null = null;
  if (table) {
    const wanted = new Set(candidates);
    for (const row of Object.values(table)) {
      const ticker = typeof row?.ticker === 'string' ? row.ticker.toUpperCase() : '';
      if (!ticker || !wanted.has(ticker)) continue;
      hit = { cik: String(row.cik_str ?? '').padStart(10, '0'), title: typeof row.title === 'string' ? row.title : '' };
      break;
    }
  }
  cikCache.set(key, hit);
  return hit;
}

async function fetchConcept(cik: string, taxonomy: string, tag: string): Promise<EdgarFact[]> {
  const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${taxonomy}/${tag}.json`;
  const json = await tryJson<CompanyConcept>(url, {
    headers: { 'User-Agent': edgarUserAgent() },
    cacheTtlMs: FACT_TTL_MS,
    cacheKey: `edgar:${taxonomy}:${tag}:${cik}`,
  });
  const units = json?.units;
  if (!units) return [];
  // 优先 USD，其次任意币种（部分发行人报 USD 之外的币种）。
  const facts = units.USD ?? units[Object.keys(units)[0] ?? ''] ?? [];
  return Array.isArray(facts) ? facts : [];
}

/** 附加科目：`tag` 是 EDGAR 科目键，`key` 是站内统一指标键（与东财口径对齐）。 */
export const EDGAR_EXTRA_LINES: { tag: keyof TagSet; key: string; label: string }[] = [
  { tag: 'capex', key: 'constructLongAsset', label: '购建固定资产支付的现金' },
  { tag: 'dividends', key: 'dividends', label: '分配股利支付的现金' },
  { tag: 'depreciation', key: 'faIrDepr', label: '折旧摊销' },
];

async function cashflowFromTags(cik: string, taxonomy: string, tags: TagSet, periods: number): Promise<FinancialPeriod[]> {
  const keys = Object.keys(tags) as (keyof TagSet)[];
  const fetched = await Promise.all(keys.map((key) => fetchConcept(cik, taxonomy, tags[key])));
  const byKey = new Map<keyof TagSet, EdgarFact[]>();
  keys.forEach((key, index) => byKey.set(key, fetched[index] ?? []));

  const operate = pickPeriodFacts(byKey.get('operate') ?? []);
  const invest = pickPeriodFacts(byKey.get('invest') ?? []);
  const finance = pickPeriodFacts(byKey.get('finance') ?? []);
  // 三张净额必须齐全，否则这条期间不是一份完整的现金流量表。
  const anchorEnds = [...operate.keys()]
    .filter((end) => invest.has(end) && finance.has(end))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, Math.max(1, periods));
  if (anchorEnds.length === 0) return [];

  const extras: { key: string; label: string; facts: Map<string, DurationFact> }[] = [];
  for (const spec of EDGAR_EXTRA_LINES) {
    const facts = pickPeriodFacts(byKey.get(spec.tag) ?? []);
    if (facts.size > 0) extras.push({ key: spec.key, label: spec.label, facts });
  }
  const endCash = pickInstantFacts(byKey.get('cash') ?? []);

  return buildCashflowPeriods(
    anchorEnds,
    [
      { key: 'netcashOperate', label: '经营活动产生的现金流量净额', facts: operate },
      { key: 'netcashInvest', label: '投资活动产生的现金流量净额', facts: invest },
      { key: 'netcashFinance', label: '筹资活动产生的现金流量净额', facts: finance },
    ],
    extras,
    endCash.size > 0 ? [{ key: 'endCce', label: '期末现金及现金等价物', values: endCash }] : [],
  );
}

/**
 * 美股现金流量表（SEC EDGAR XBRL，官方口径）。
 *
 * 返回空数组表示该发行人在 EDGAR 里没有可用的现金流科目（例如 ETF / 信托），
 * 调用方必须据此写出「数据缺失」，不得静默留空。
 */
export async function edgarCashflow(code: string, periods = 4): Promise<FinancialPeriod[]> {
  const issuer = await edgarCikForTicker(code);
  if (!issuer) return [];
  const usGaap = await cashflowFromTags(issuer.cik, 'us-gaap', US_GAAP_TAGS, periods);
  if (usGaap.length > 0) return usGaap;
  return cashflowFromTags(issuer.cik, 'ifrs-full', IFRS_TAGS, periods);
}
