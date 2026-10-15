/**
 * 财务报表（三表）provider —— 东方财富 F10，零 Key。
 *
 * 端点全部实测于 2026-10-15（见 docs/SOURCES.md §2.3）：
 *  - A 股：`RPT_F10_FINANCE_GINCOME` / `_GBALANCE` / `_GCASHFLOW`，**宽表**（一行一期，
 *    200+ 列），`sortColumns=REPORT_DATE` 可取近 100 期。
 *  - 港股：`RPT_HKF10_FN_INCOME` / `_BALANCE` 为**长表**（每科目一行，含 `STD_ITEM_CODE`
 *    / `ITEM_NAME` / `AMOUNT` / `YOY_RATIO`）；`RPT_HKF10_FN_MAININDICATOR` 为宽表，
 *    含经营/投资/筹资现金流净额，用于兜底现金流量表。
 *  - 美股：`RPT_USF10_FN_INCOME` / `_BALANCE` 为长表。**SECUCODE 必须带交易所后缀**
 *    （`.O` 纳斯达克、`.N` 纽交所）；裸代码一律返回「返回数据为空」。
 *  - 缺失：港股/美股的现金流量表**明细**在 datacenter 无对应 reportName（全部返回
 *    「报表配置不存在」）。港股用主要指标的总量兜底并显式标注；美股标注为数据缺失，
 *    由主提示词要求走 web_search 查 10-K/10-Q 原文补足 —— 绝不留空、绝不填 0。
 *
 * 口径提醒：A 股/港股定期报告是**年初至今累计**，美股同一报告期会同时给出
 * `单季报` 与 `累计季报` 两套行（数值不同），解析时必须二选一，否则同一科目会
 * 出现两个互相矛盾的数值。
 *
 * Owner: agent-engine.
 */
import {
  MARKET_CURRENCY,
  type FinancialLine,
  type FinancialPeriod,
  type FinancialStatement,
  type Financials,
  type Market,
  type SourceId,
  type StatementKind,
} from '@aia/shared';
import { round4, toNumber, tryJson } from './http.js';
import { edgarCashflow, edgarUsesPlaceholder } from './edgar.js';

const SOURCE: SourceId = 'eastmoney';
const FIN_TTL_MS = 30 * 60_000;
/** 长表每期科目数的保守估计（港股利润表 ~27、美股利润表含双口径 ~50、资产负债表 ~30-55）。 */
const LONG_ROWS_PER_PERIOD = 60;
const DATACENTER = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';
const REFERER = 'https://emweb.securities.eastmoney.com/';
const MAX_PERIODS = 8;

export const STATEMENT_LABELS: Record<StatementKind, string> = {
  income: '利润表',
  balance: '资产负债表',
  cashflow: '现金流量表',
};

/* ────────────────────────────── 列映射定义 ───────────────────────────────── */

interface LineSpec {
  key: string;
  label: string;
  /** A 股宽表字段名（按优先级回退）。 */
  fields?: string[];
  /** 与 `fields` 一一对应的展示标签（命中回退字段时用，例如银行没有「营业总收入」）。 */
  fieldLabels?: string[];
  /** A 股宽表同比字段（按优先级回退：金融行业模板用 OPERATE_INCOME_YOY）。 */
  yoyField?: string | string[];
  /** 港股/美股长表的科目名（精确匹配，按优先级）。 */
  aliases?: string[];
  /** 每股指标（单位 `<币种>/股`）。 */
  perShare?: boolean;
  /** 同比字段（港股/美股长表用 `YOY_RATIO`）。 */
  longYoy?: boolean;
}

const CN_INCOME: LineSpec[] = [
  // 银行/保险/证券模板没有「营业总收入」，用「营业收入」（OPERATE_INCOME）回退。
  { key: 'revenue', label: '营业总收入', fields: ['TOTAL_OPERATE_INCOME', 'OPERATE_INCOME'], fieldLabels: ['营业总收入', '营业收入'], yoyField: ['TOTAL_OPERATE_INCOME_YOY', 'OPERATE_INCOME_YOY'] },
  { key: 'operateCost', label: '营业成本', fields: ['OPERATE_COST'], yoyField: 'OPERATE_COST_YOY' },
  { key: 'totalOperateCost', label: '营业总成本', fields: ['TOTAL_OPERATE_COST'], yoyField: 'TOTAL_OPERATE_COST_YOY' },
  { key: 'operateTaxAdd', label: '税金及附加', fields: ['OPERATE_TAX_ADD'], yoyField: 'OPERATE_TAX_ADD_YOY' },
  { key: 'saleExpense', label: '销售费用', fields: ['SALE_EXPENSE'], yoyField: 'SALE_EXPENSE_YOY' },
  { key: 'manageExpense', label: '管理费用', fields: ['MANAGE_EXPENSE'], yoyField: 'MANAGE_EXPENSE_YOY' },
  { key: 'researchExpense', label: '研发费用', fields: ['RESEARCH_EXPENSE'], yoyField: 'RESEARCH_EXPENSE_YOY' },
  { key: 'financeExpense', label: '财务费用', fields: ['FINANCE_EXPENSE'], yoyField: 'FINANCE_EXPENSE_YOY' },
  { key: 'investIncome', label: '投资收益', fields: ['INVEST_INCOME'], yoyField: 'INVEST_INCOME_YOY' },
  { key: 'assetImpairment', label: '资产减值损失', fields: ['ASSET_IMPAIRMENT_LOSS'], yoyField: 'ASSET_IMPAIRMENT_LOSS_YOY' },
  { key: 'creditImpairment', label: '信用减值损失', fields: ['CREDIT_IMPAIRMENT_LOSS'], yoyField: 'CREDIT_IMPAIRMENT_LOSS_YOY' },
  { key: 'operateProfit', label: '营业利润', fields: ['OPERATE_PROFIT'], yoyField: 'OPERATE_PROFIT_YOY' },
  { key: 'totalProfit', label: '利润总额', fields: ['TOTAL_PROFIT'], yoyField: 'TOTAL_PROFIT_YOY' },
  { key: 'incomeTax', label: '所得税费用', fields: ['INCOME_TAX'], yoyField: 'INCOME_TAX_YOY' },
  { key: 'netProfit', label: '净利润', fields: ['NETPROFIT'], yoyField: 'NETPROFIT_YOY' },
  { key: 'parentNetProfit', label: '归母净利润', fields: ['PARENT_NETPROFIT'], yoyField: 'PARENT_NETPROFIT_YOY' },
  { key: 'deductParentNetProfit', label: '扣非归母净利润', fields: ['DEDUCT_PARENT_NETPROFIT'], yoyField: 'DEDUCT_PARENT_NETPROFIT_YOY' },
  { key: 'minorityInterest', label: '少数股东损益', fields: ['MINORITY_INTEREST'], yoyField: 'MINORITY_INTEREST_YOY' },
  { key: 'basicEps', label: '基本每股收益', fields: ['BASIC_EPS'], yoyField: 'BASIC_EPS_YOY', perShare: true },
  { key: 'totalCompreIncome', label: '综合收益总额', fields: ['TOTAL_COMPRE_INCOME'], yoyField: 'TOTAL_COMPRE_INCOME_YOY' },
];

const CN_BALANCE: LineSpec[] = [
  { key: 'totalAssets', label: '资产总计', fields: ['TOTAL_ASSETS', 'ASSET_BALANCE'] },
  { key: 'currentAssets', label: '流动资产合计', fields: ['TOTAL_CURRENT_ASSETS', 'CURRENT_ASSET_BALANCE'] },
  { key: 'noncurrentAssets', label: '非流动资产合计', fields: ['TOTAL_NONCURRENT_ASSETS', 'NONCURRENT_ASSET_BALANCE'] },
  { key: 'monetaryFunds', label: '货币资金', fields: ['MONETARYFUNDS'] },
  { key: 'accountsRece', label: '应收账款', fields: ['ACCOUNTS_RECE'] },
  { key: 'inventory', label: '存货', fields: ['INVENTORY'] },
  { key: 'contractAsset', label: '合同资产', fields: ['CONTRACT_ASSET'] },
  { key: 'fixedAsset', label: '固定资产', fields: ['FIXED_ASSET'] },
  { key: 'cip', label: '在建工程', fields: ['CIP'] },
  { key: 'intangibleAsset', label: '无形资产', fields: ['INTANGIBLE_ASSET'] },
  { key: 'goodwill', label: '商誉', fields: ['GOODWILL'] },
  { key: 'totalLiab', label: '负债合计', fields: ['TOTAL_LIABILITIES', 'LIAB_BALANCE'] },
  { key: 'currentLiab', label: '流动负债合计', fields: ['TOTAL_CURRENT_LIAB', 'CURRENT_LIAB_BALANCE'] },
  { key: 'noncurrentLiab', label: '非流动负债合计', fields: ['TOTAL_NONCURRENT_LIAB', 'NONCURRENT_LIAB_BALANCE'] },
  { key: 'shortLoan', label: '短期借款', fields: ['SHORT_LOAN'] },
  { key: 'longLoan', label: '长期借款', fields: ['LONG_LOAN'] },
  { key: 'accountsPayable', label: '应付账款', fields: ['ACCOUNTS_PAYABLE'] },
  { key: 'contractLiab', label: '合同负债', fields: ['CONTRACT_LIAB'] },
  { key: 'parentEquity', label: '归属于母公司股东权益', fields: ['TOTAL_PARENT_EQUITY', 'PARENT_EQUITY_BALANCE'] },
  { key: 'minorityEquity', label: '少数股东权益', fields: ['MINORITY_EQUITY'] },
];

const CN_CASHFLOW: LineSpec[] = [
  { key: 'salesServices', label: '销售商品提供劳务收到的现金', fields: ['SALES_SERVICES'] },
  { key: 'totalOperateInflow', label: '经营活动现金流入小计', fields: ['TOTAL_OPERATE_INFLOW'] },
  { key: 'totalOperateOutflow', label: '经营活动现金流出小计', fields: ['TOTAL_OPERATE_OUTFLOW'] },
  { key: 'netcashOperate', label: '经营活动产生的现金流量净额', fields: ['NETCASH_OPERATE'] },
  { key: 'netcashInvest', label: '投资活动产生的现金流量净额', fields: ['NETCASH_INVEST'] },
  { key: 'netcashFinance', label: '筹资活动产生的现金流量净额', fields: ['NETCASH_FINANCE'] },
  { key: 'constructLongAsset', label: '购建长期资产支付的现金', fields: ['CONSTRUCT_LONG_ASSET'] },
  { key: 'investPayCash', label: '投资支付的现金', fields: ['INVEST_PAY_CASH'] },
  { key: 'receiveInvestIncome', label: '取得投资收益收到的现金', fields: ['RECEIVE_INVEST_INCOME'] },
  { key: 'payDebtCash', label: '偿还债务支付的现金', fields: ['PAY_DEBT_CASH'] },
  { key: 'assignDividendProfit', label: '分配股利利润或偿付利息支付的现金', fields: ['ASSIGN_DIVIDEND_PORFIT'] },
  { key: 'faIrDepr', label: '固定资产折旧', fields: ['FA_IR_DEPR'] },
  { key: 'iaAmortize', label: '无形资产摊销', fields: ['IA_AMORTIZE'] },
  { key: 'cceAdd', label: '现金及现金等价物净增加额', fields: ['CCE_ADD'] },
  { key: 'beginCce', label: '期初现金及现金等价物余额', fields: ['BEGIN_CCE'] },
  { key: 'endCce', label: '期末现金及现金等价物余额', fields: ['END_CCE'] },
];

const CN_SPECS: Record<StatementKind, LineSpec[]> = {
  income: CN_INCOME,
  balance: CN_BALANCE,
  cashflow: CN_CASHFLOW,
};

/** 港股/美股长表科目名（同一套中文科目体系，精确匹配）。 */
const LONG_INCOME: LineSpec[] = [
  { key: 'revenue', label: '营业收入', aliases: ['营业额', '营业收入', '营运收入', '主营收入'], longYoy: true },
  { key: 'grossProfit', label: '毛利', aliases: ['毛利'], longYoy: true },
  { key: 'operateCost', label: '营业成本', aliases: ['营业成本', '主营成本', '营运支出', '营业费用', '销售成本'], longYoy: true },
  { key: 'researchExpense', label: '研发费用', aliases: ['研发费用'], longYoy: true },
  { key: 'saleExpense', label: '销售及分销费用', aliases: ['销售及分销费用', '营销费用', '销售费用'], longYoy: true },
  { key: 'manageExpense', label: '管理费用', aliases: ['行政开支', '管理费用'], longYoy: true },
  { key: 'financeExpense', label: '财务费用/融资成本', aliases: ['融资成本', '财务费用'], longYoy: true },
  { key: 'operateProfit', label: '营业利润', aliases: ['经营溢利', '营业利润'], longYoy: true },
  { key: 'pretaxProfit', label: '税前利润', aliases: ['除税前溢利', '持续经营税前利润', '税前利润'], longYoy: true },
  { key: 'incomeTax', label: '所得税', aliases: ['税项', '所得税'], longYoy: true },
  { key: 'netProfit', label: '净利润', aliases: ['除税后溢利', '净利润', '持续经营净利润'], longYoy: true },
  { key: 'parentNetProfit', label: '归母净利润', aliases: ['股东应占溢利', '归属于母公司股东净利润', '归属于普通股股东净利润'], longYoy: true },
  { key: 'minorityInterest', label: '少数股东损益', aliases: ['少数股东损益', '非控股权益'], longYoy: true },
  { key: 'basicEps', label: '基本每股收益', aliases: ['每股基本盈利', '基本每股收益-普通股'], perShare: true, longYoy: true },
  { key: 'dilutedEps', label: '摊薄每股收益', aliases: ['每股摊薄盈利', '摊薄每股收益-普通股'], perShare: true, longYoy: true },
];

const LONG_BALANCE: LineSpec[] = [
  { key: 'totalAssets', label: '总资产', aliases: ['总资产', '资产总计', '资产合计'], longYoy: true },
  { key: 'currentAssets', label: '流动资产合计', aliases: ['流动资产合计'], longYoy: true },
  { key: 'noncurrentAssets', label: '非流动资产合计', aliases: ['非流动资产合计'], longYoy: true },
  { key: 'cash', label: '现金及等价物', aliases: ['现金及等价物', '现金及现金等价物'], longYoy: true },
  { key: 'accountsRece', label: '应收账款', aliases: ['应收帐款', '应收账款'], longYoy: true },
  { key: 'inventory', label: '存货', aliases: ['存货'], longYoy: true },
  { key: 'goodwill', label: '商誉', aliases: ['商誉'], longYoy: true },
  { key: 'ppAndE', label: '物业厂房及设备', aliases: ['物业厂房及设备', '物业、厂房及设备'], longYoy: true },
  { key: 'intangibleAsset', label: '无形资产', aliases: ['无形资产'], longYoy: true },
  { key: 'totalLiab', label: '总负债', aliases: ['总负债', '负债合计'], longYoy: true },
  { key: 'currentLiab', label: '流动负债合计', aliases: ['流动负债合计'], longYoy: true },
  { key: 'noncurrentLiab', label: '非流动负债合计', aliases: ['非流动负债合计'], longYoy: true },
  { key: 'shortDebt', label: '短期借款', aliases: ['短期贷款', '短期债务', '短期借款'], longYoy: true },
  { key: 'longDebt', label: '长期借款', aliases: ['长期贷款', '长期负债', '长期借款'], longYoy: true },
  { key: 'parentEquity', label: '归母股东权益', aliases: ['股东权益', '归属于母公司股东权益', '归属于母公司股东权益合计'], longYoy: true },
  { key: 'totalEquity', label: '所有者权益合计', aliases: ['总权益', '股东权益合计', '净资产'], longYoy: true },
  { key: 'minorityEquity', label: '少数股东权益', aliases: ['少数股东权益', '非控股权益'], longYoy: true },
  { key: 'retainedEarnings', label: '留存收益', aliases: ['保留溢利(累计亏损)', '留存收益'], longYoy: true },
];

/** 港股主要指标里的现金流总量（明细源不可用时的兜底）。 */
const HK_CASHFLOW_SUMMARY: LineSpec[] = [
  { key: 'netcashOperate', label: '经营活动产生的现金流量净额', aliases: ['@NETCASH_OPERATE'], longYoy: true },
  { key: 'netcashInvest', label: '投资活动产生的现金流量净额', aliases: ['@NETCASH_INVEST'], longYoy: true },
  { key: 'netcashFinance', label: '筹资活动产生的现金流量净额', aliases: ['@NETCASH_FINANCE'], longYoy: true },
  { key: 'endCce', label: '期末现金', aliases: ['@END_CASH'], longYoy: true },
];

const LONG_SPECS: Record<StatementKind, LineSpec[]> = {
  income: LONG_INCOME,
  balance: LONG_BALANCE,
  cashflow: [],
};

/* ─────────────────────────────── 纯解析逻辑 ─────────────────────────────── */

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim();
}

/** `2026-06-30 00:00:00` / `2026-06-30` → `2026-06-30`；无效返回 null。 */
export function dayOf(value: unknown): string | null {
  const raw = text(value);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  return match ? match[1]! : null;
}

const CURRENCY_NAMES: Record<string, string> = {
  人民币: 'CNY',
  港元: 'HKD',
  港币: 'HKD',
  美元: 'USD',
  新加坡元: 'SGD',
  日元: 'JPY',
};

/** 报表币种：优先 ISO 代码字段，其次中文名映射，最后按市场兜底。 */
export function currencyOf(row: Row | undefined, market: Market): string {
  if (!row) return MARKET_CURRENCY[market];
  for (const field of ['CURRENCY_CODE', 'CURRENCY_ABBR', 'CURRENCY']) {
    const raw = text(row[field]).toUpperCase();
    if (/^[A-Z]{3}$/.test(raw)) return raw;
    const mapped = CURRENCY_NAMES[text(row[field])];
    if (mapped) return mapped;
  }
  return MARKET_CURRENCY[market];
}

function isCumulative(reportType: string): boolean {
  if (/单季/.test(reportType)) return false;
  return true;
}

/**
 * A 股宽表 → 期间列表（行已按 REPORT_DATE 倒序）。
 *
 * 一条记录一期：`data[0]` 是最近一期。空值（null/''）不入表，避免用 0 冒充缺失。
 */
export function parseCnStatement(kind: StatementKind, rows: Row[], periods: number): FinancialPeriod[] {
  const specs = CN_SPECS[kind] ?? [];
  const out: FinancialPeriod[] = [];
  for (const row of rows.slice(0, Math.max(1, periods))) {
    const reportDate = dayOf(row.REPORT_DATE);
    if (!reportDate) continue;
    const currency = currencyOf(row, 'CN');
    const reportType = text(row.REPORT_TYPE) || '定期报告';
    const period = text(row.REPORT_DATE_NAME) || `${reportDate.slice(0, 4)}${reportType}`;
    const lines: FinancialLine[] = [];
    for (const spec of specs) {
      const hit = firstPresent(row, spec.fields ?? []);
      if (!hit) continue;
      const line: FinancialLine = {
        key: spec.key,
        label: spec.fieldLabels?.[hit.index] ?? spec.label,
        value: round4(toNumber(hit.value)),
        unit: spec.perShare ? `${currency}/股` : currency,
      };
      const yoy = firstYoy(row, spec.yoyField);
      if (yoy !== null) line.yoy = yoy;
      lines.push(line);
    }
    if (lines.length === 0) continue;
    out.push({
      period,
      reportDate,
      reportType,
      currency,
      cumulative: isCumulative(reportType),
      lines,
    });
  }
  return out;
}

function firstPresent(row: Row, fields: string[]): { value: unknown; index: number } | null {
  for (const [index, field] of fields.entries()) {
    const value = row[field];
    if (value === null || value === undefined || value === '') continue;
    // 上游偶尔给出 0 占位（如 ASSET_BALANCE=0 而 TOTAL_ASSETS 有值）：不算命中。
    if (toNumber(value) === 0 && index < fields.length - 1) continue;
    return { value, index };
  }
  return null;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = toNumber(value);
  return Number.isFinite(parsed) ? round4(parsed) : null;
}

/** 同比字段按优先级回退（通用模板与金融行业模板的字段名不同）。 */
function firstYoy(row: Row, field: string | string[] | undefined): number | null {
  const fields = typeof field === 'string' ? [field] : field ?? [];
  for (const name of fields) {
    const value = numOrNull(row[name]);
    if (value !== null) return value;
  }
  return null;
}

export interface LongParseOptions {
  periods: number;
  market: Market;
  /** 同一报告期存在多套口径时的优先顺序（美股利润表：累计季报 > 单季报）。 */
  preferReportTypes?: string[];
  /** 分页窗口是否已饱和：饱和时最旧一组可能被截断，必须整组丢弃。 */
  windowTruncated?: boolean;
}

/** 报告期标签：优先上游给定的详情（已含年份），否则补上年份前缀。 */
function longPeriodLabel(reportDate: string, reportType: string, details: unknown): string {
  const detail = text(details);
  if (detail) return detail;
  const year = reportDate.slice(0, 4);
  return reportType.startsWith(year) ? reportType : `${year}${reportType}`;
}

/**
 * 港股/美股长表 → 期间列表。
 *
 * 长表把「科目」当行，所以必须：① 按报告期分组；② 同一期内按 `REPORT_TYPE`
 * 二选一（美股同一天同时有「单季报」和「累计季报」，数值不同）；③ 丢掉窗口
 * 截断造成的残缺期间（行数远少于其它期间，只会出现在最旧一端）。
 */
export function parseLongStatement(kind: StatementKind, rows: Row[], options: LongParseOptions): FinancialPeriod[] {
  const specs = LONG_SPECS[kind] ?? [];
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const day = dayOf(row.STD_REPORT_DATE ?? row.REPORT_DATE);
    if (!day) continue;
    const list = groups.get(day);
    if (list) list.push(row);
    else groups.set(day, [row]);
  }

  const ordered = [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  // 分页窗口饱和 → 最旧一组多半被截断（科目不全），整组丢弃，避免出现
  // 「同一张表里有的期间有总资产、有的期间没有」这种自相矛盾的缺口。
  const usable = options.windowTruncated && ordered.length > 1 ? ordered.slice(0, -1) : ordered;

  const chosen: Array<{ date: string; rows: Row[] }> = [];
  for (const [date, list] of usable) {
    chosen.push({ date, rows: pickReportType(list, options.preferReportTypes) });
  }
  const maxItems = chosen.reduce((max, group) => Math.max(max, group.rows.length), 0);
  // 兜底：分页窗口没饱和、但最旧一组科目数不足一半（上游半张表 / 异常分页）时丢弃。
  // 只对最旧一组生效 —— 中间期间科目数天然会有出入，不能一概丢弃。
  const floor = Math.max(1, Math.floor(maxItems * 0.5));

  const out: FinancialPeriod[] = [];
  for (const [index, group] of chosen.entries()) {
    if (index === chosen.length - 1 && group.rows.length < floor) continue;
    const first = group.rows[0];
    const currency = currencyOf(first, options.market);
    const reportType = text(first?.REPORT_TYPE) || '定期报告';
    const period = longPeriodLabel(group.date, reportType, first?.REPORT_TYPE_DETAILS);
    const byName = new Map<string, Row>();
    for (const row of group.rows) {
      const name = text(row.ITEM_NAME);
      if (name && !byName.has(name)) byName.set(name, row);
    }
    const lines: FinancialLine[] = [];
    for (const spec of specs) {
      const row = matchAlias(byName, spec.aliases ?? []);
      if (!row) continue;
      const value = numOrNull(row.AMOUNT);
      if (value === null) continue;
      const line: FinancialLine = {
        key: spec.key,
        label: spec.label,
        value,
        unit: spec.perShare ? `${currency}/股` : currency,
      };
      if (spec.longYoy) {
        const yoy = numOrNull(row.YOY_RATIO);
        if (yoy !== null) line.yoy = yoy;
      }
      lines.push(line);
    }
    if (lines.length === 0) continue;
    out.push({
      period,
      reportDate: group.date,
      reportType,
      currency,
      cumulative: isCumulative(reportType),
      lines,
    });
    if (out.length >= Math.max(1, options.periods)) break;
  }
  return out;
}

/** 同一报告期内挑一套口径；未指定优先顺序时取科目最全的那一套。 */
function pickReportType(rows: Row[], prefer?: string[]): Row[] {
  const buckets = new Map<string, Row[]>();
  for (const row of rows) {
    const type = text(row.REPORT_TYPE);
    const list = buckets.get(type);
    if (list) list.push(row);
    else buckets.set(type, [row]);
  }
  if (buckets.size <= 1) return rows;
  for (const type of prefer ?? []) {
    const bucket = buckets.get(type);
    if (bucket && bucket.length > 0) return bucket;
  }
  let best: Row[] = rows;
  for (const bucket of buckets.values()) if (bucket.length > best.length) best = bucket;
  return best;
}

/** 支持 `@FIELD` 形式直接读宽表字段（港股主要指标兜底用）。 */
function matchAlias(byName: Map<string, Row>, aliases: string[]): Row | undefined {
  for (const alias of aliases) {
    if (alias.startsWith('@')) continue;
    const hit = byName.get(alias);
    if (hit) return hit;
  }
  return undefined;
}

/** 宽表字段 → 指标行（港股主要指标：字段名即指标）。 */
export function parseWideIndicator(rows: Row[], periods: number, market: Market): FinancialPeriod[] {
  const specs = HK_CASHFLOW_SUMMARY;
  const out: FinancialPeriod[] = [];
  for (const row of rows.slice(0, Math.max(1, periods))) {
    const reportDate = dayOf(row.STD_REPORT_DATE ?? row.REPORT_DATE);
    if (!reportDate) continue;
    const reportType = text(row.REPORT_TYPE) || '定期报告';
    const period = longPeriodLabel(reportDate, reportType, row.REPORT_TYPE_DETAILS);
    const currency = currencyOf(row, market);
    const lines: FinancialLine[] = [];
    for (const spec of specs) {
      const field = (spec.aliases?.[0] ?? '').replace('@', '');
      const value = numOrNull(row[field]);
      if (value === null) continue;
      lines.push({ key: spec.key, label: spec.label, value, unit: currency });
    }
    if (lines.length === 0) continue;
    out.push({ period, reportDate, reportType, currency, cumulative: isCumulative(reportType), lines });
  }
  return out;
}

/* ───────────────────────── 比率 / 排雷信号（派生） ───────────────────────── */

function latest(statements: FinancialStatement[], kind: StatementKind): FinancialPeriod | undefined {
  const statement = statements.find((item) => item.kind === kind);
  return statement?.available ? statement.periods[0] : undefined;
}

function lineValue(period: FinancialPeriod | undefined, key: string): number | null {
  const line = period?.lines.find((item) => item.key === key);
  return line ? line.value : null;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return round4((numerator / denominator) * 100);
}

function yi(value: number | null, currency: string): string {
  if (value === null) return '—';
  return `${round4(value / 1e8)}亿${currency}`;
}

/**
 * 从已取到的报表数据算出比率与排雷信号。
 *
 * 全部来自工具返回值，模型可以直接引用；分母缺失或为 0 时该条不出（绝不用 0 顶替）。
 *
 * **跨表比率必须同期**：不同数据源的报告期标签可能对不齐（例如美股利润表来自东财
 * 「2026年 中报」而现金流量表来自 SEC EDGAR 的「2025年 年报」），此时把两个不同期
 * 的数字相除会得到无意义的结果（实测出过「经营现金流/归母净利润=0.38 倍」这种把
 * FY2025 现金流除以 2026 中报利润的错值）。因此：同期才算比率，不同期只给绝对额。
 */
export function deriveHighlights(statements: FinancialStatement[]): string[] {
  const income = latest(statements, 'income');
  const balance = latest(statements, 'balance');
  const cashflow = latest(statements, 'cashflow');
  const currency = income?.currency ?? balance?.currency ?? cashflow?.currency ?? 'CNY';
  const out: string[] = [];

  /** 报告期标签归一（「2026年 中报」与「2026年中报」视为同一期）。 */
  const normalizePeriod = (label: string): string => label.replace(/\s+/g, '');
  const samePeriod = (a?: FinancialPeriod, b?: FinancialPeriod): boolean =>
    Boolean(a && b && normalizePeriod(a.period) === normalizePeriod(b.period));
  const suffixOf = (period?: FinancialPeriod): string => (period ? `（${period.period}）` : '');

  /* —— 利润表内：口径自洽 —— */
  const revenue = lineValue(income, 'revenue');
  const grossProfit = lineValue(income, 'grossProfit');
  const operateCost = lineValue(income, 'operateCost');
  const parentNetProfit = lineValue(income, 'parentNetProfit') ?? lineValue(income, 'netProfit');

  const grossMargin =
    grossProfit !== null && revenue
      ? round4((grossProfit / revenue) * 100)
      : revenue && operateCost !== null
        ? round4(((revenue - operateCost) / revenue) * 100)
        : null;
  if (grossMargin !== null) out.push(`毛利率=${grossMargin}%${suffixOf(income)}`);

  const netMargin = ratio(parentNetProfit, revenue);
  if (netMargin !== null) out.push(`归母净利率=${netMargin}%${suffixOf(income)}`);

  const revenueYoy = income?.lines.find((item) => item.key === 'revenue')?.yoy ?? null;
  if (revenueYoy !== null && revenueYoy !== undefined) out.push(`营业总收入同比=${round4(revenueYoy)}%${suffixOf(income)}`);
  const profitYoy = income?.lines.find((item) => item.key === 'parentNetProfit')?.yoy ?? null;
  if (profitYoy !== null && profitYoy !== undefined) out.push(`归母净利润同比=${round4(profitYoy)}%${suffixOf(income)}`);

  /* —— 资产负债表内：口径自洽 —— */
  const totalAssets = lineValue(balance, 'totalAssets');
  const totalLiab = lineValue(balance, 'totalLiab');
  const parentEquity = lineValue(balance, 'parentEquity') ?? lineValue(balance, 'totalEquity');

  const debtRatio = ratio(totalLiab, totalAssets);
  if (debtRatio !== null) out.push(`资产负债率=${debtRatio}%${suffixOf(balance)}`);

  const interestDebt =
    (lineValue(balance, 'shortLoan') ?? 0) +
    (lineValue(balance, 'longLoan') ?? 0) +
    (lineValue(balance, 'shortDebt') ?? 0) +
    (lineValue(balance, 'longDebt') ?? 0);
  const debtEquity = ratio(interestDebt || null, parentEquity);
  if (debtEquity !== null) out.push(`有息负债/股东权益=${debtEquity}%${suffixOf(balance)}`);

  const goodwill = lineValue(balance, 'goodwill');
  const goodwillRatio = ratio(goodwill, parentEquity);
  if (goodwillRatio !== null) out.push(`商誉/股东权益=${goodwillRatio}%（商誉排雷）${suffixOf(balance)}`);

  const inventory = lineValue(balance, 'inventory');
  const inventoryRatio = ratio(inventory, totalAssets);
  if (inventoryRatio !== null) out.push(`存货/总资产=${inventoryRatio}%${suffixOf(balance)}`);

  /* —— 跨表：只有同期才算比率 —— */
  const ocf = lineValue(cashflow, 'netcashOperate');
  if (ocf !== null) {
    if (parentNetProfit !== null && parentNetProfit !== 0 && samePeriod(cashflow, income)) {
      out.push(`经营现金流/归母净利润=${round4(ocf / parentNetProfit)}倍${suffixOf(income)}`);
    } else {
      out.push(`经营活动现金流量净额=${yi(ocf, currency)}${suffixOf(cashflow)}`);
    }
  }
  const capex = lineValue(cashflow, 'constructLongAsset');
  if (ocf !== null && capex !== null) out.push(`自由现金流=${yi(ocf - capex, currency)}${suffixOf(cashflow)}`);

  const receivables = lineValue(balance, 'accountsRece');
  const receivablesRatio = samePeriod(balance, income) ? ratio(receivables, revenue) : null;
  if (receivablesRatio !== null) out.push(`应收账款/营业收入=${receivablesRatio}%${suffixOf(income)}`);

  return out;
}

/* ─────────────────────────────── 端点请求 ───────────────────────────────── */

interface DataCenterResponse {
  result?: { data?: Row[] | null; pages?: number } | null;
  success?: boolean;
  message?: string;
}

/**
 * 财报请求的缓存键 —— **必须带 pageSize**。
 *
 * 同一标的 4 期与 8 期的响应体不同，而 `http.ts` 的缓存是按 key 存整段响应；
 * 早期版本漏了 pageSize，导致「先按 4 期取过、再按 8 期请求」会命中 4 期的脏缓存
 * （真实模型因此报出「请求 8 期上游只返 4 期」）。已由单测锁死。
 */
export function financialsCacheKey(scope: string, code: string, pageSize: number): string {
  return `em:fin:${scope}:${code}:${pageSize}`;
}

async function fetchRows(
  reportName: string,
  filter: string,
  sortColumn: string,
  pageSize: number,
  cacheKey: string,
): Promise<Row[]> {
  const query = new URLSearchParams({
    reportName,
    columns: 'ALL',
    filter,
    pageNumber: '1',
    pageSize: String(Math.max(1, Math.min(500, pageSize))),
    sortTypes: '-1',
    sortColumns: sortColumn,
    source: 'HSF10',
    client: 'PC',
  });
  const json = await tryJson<DataCenterResponse>(`${DATACENTER}?${query}`, {
    headers: { Referer: REFERER },
    cacheTtlMs: FIN_TTL_MS,
    cacheKey,
  });
  const rows = json?.result?.data;
  return Array.isArray(rows) ? rows : [];
}

/** 美股 SECUCODE 后缀：`.O` 纳斯达克、`.N` 纽交所（裸代码上游返回空）。 */
export function usSecucodeCandidates(code: string): string[] {
  const clean = code.trim().toUpperCase().replace(/\.[A-Z]+$/, '');
  return [`${clean}.O`, `${clean}.N`];
}

/** 港股 SECUCODE：5 位代码 + `.HK`。 */
export function hkSecucode(code: string): string {
  return `${code.trim().replace(/\.HK$/i, '').padStart(5, '0')}.HK`;
}

const resolvedSecucode = new Map<string, string | null>();

async function resolveLongSecucode(market: Market, code: string): Promise<string | null> {
  const cacheKey = `${market}:${code}`;
  if (resolvedSecucode.has(cacheKey)) return resolvedSecucode.get(cacheKey) ?? null;
  const candidates = market === 'US' ? usSecucodeCandidates(code) : [hkSecucode(code)];
  const probeReport = market === 'US' ? 'RPT_USF10_FN_INCOME' : 'RPT_HKF10_FN_INCOME';
  let hit: string | null = null;
  for (const candidate of candidates) {
    const rows = await fetchRows(probeReport, `(SECUCODE="${candidate}")`, 'STD_REPORT_DATE', 1, `em:finsec:${candidate}`);
    if (rows.length > 0) {
      hit = candidate;
      break;
    }
  }
  resolvedSecucode.set(cacheKey, hit);
  return hit;
}

/* ──────────────────────────────── 组装入口 ─────────────────────────────── */

/**
 * A 股 F10 按行业分模板：`G` 通用 / `B` 银行 / `S` 证券 / `I` 保险。
 *
 * 实测：`RPT_F10_FINANCE_GBALANCE` 对银行/证券/保险一律返回「返回数据为空」，
 * 必须换用对应的行业模板（例如工商银行走 `BBALANCE`/`BCASHFLOW`/`BINCOME`），
 * 否则会出现「有利润表、没有资产负债表和现金流量表」的假缺口。
 */
export const CN_TEMPLATES = ['G', 'B', 'S', 'I'] as const;

const resolvedCnTemplate = new Map<string, string | null>();

async function resolveCnTemplate(code: string, filter: string): Promise<string | null> {
  const cacheKey = `cn:${code}`;
  if (resolvedCnTemplate.has(cacheKey)) return resolvedCnTemplate.get(cacheKey) ?? null;
  for (const kind of ['BALANCE', 'INCOME'] as const) {
    for (const letter of CN_TEMPLATES) {
      const rows = await fetchRows(
        `RPT_F10_FINANCE_${letter}${kind}`,
        filter,
        'REPORT_DATE',
        1,
        `em:fintpl:${letter}:${kind}:${code}`,
      );
      if (rows.length > 0) {
        resolvedCnTemplate.set(cacheKey, letter);
        return letter;
      }
    }
  }
  resolvedCnTemplate.set(cacheKey, null);
  return null;
}

/** A 股：按行业模板一次拿三表（宽表，多期）。 */
async function cnFinancials(code: string, fallbackName: string, periods: number): Promise<Financials | null> {
  const suffix = /^[659]/.test(code) ? 'SH' : 'SZ';
  const filter = `(SECUCODE="${code}.${suffix}")`;
  const template = await resolveCnTemplate(code, filter);
  if (!template) return null;
  const [income, balance, cashflow] = await Promise.all([
    fetchRows(`RPT_F10_FINANCE_${template}INCOME`, filter, 'REPORT_DATE', periods, financialsCacheKey(`${template}:income`, code, periods)),
    fetchRows(`RPT_F10_FINANCE_${template}BALANCE`, filter, 'REPORT_DATE', periods, financialsCacheKey(`${template}:balance`, code, periods)),
    fetchRows(`RPT_F10_FINANCE_${template}CASHFLOW`, filter, 'REPORT_DATE', periods, financialsCacheKey(`${template}:cashflow`, code, periods)),
  ]);
  const first = income[0] ?? balance[0] ?? cashflow[0];
  if (!first) return null;

  const statements: FinancialStatement[] = (['income', 'balance', 'cashflow'] as StatementKind[]).map((kind) => {
    const rows = kind === 'income' ? income : kind === 'balance' ? balance : cashflow;
    const periodsData = parseCnStatement(kind, rows, periods);
    return {
      kind,
      label: STATEMENT_LABELS[kind],
      available: periodsData.length > 0,
      ...(periodsData.length === 0 ? { reason: '东方财富 A 股 F10 未返回该表数据' } : {}),
      periods: periodsData,
    };
  });

  return {
    code,
    market: 'CN',
    name: text(first.SECURITY_NAME_ABBR) || fallbackName || code,
    currency: currencyOf(first, 'CN'),
    standard: '中国会计准则',
    statements,
    highlights: deriveHighlights(statements),
    sources: [SOURCE],
    warnings: [],
  };
}

/** 港股 / 美股：长表（科目为行）+ 港股主要指标兜底。 */
async function longFinancials(
  market: Market,
  code: string,
  fallbackName: string,
  periods: number,
): Promise<Financials | null> {
  const secucode = await resolveLongSecucode(market, code);
  if (!secucode) return null;
  const filter = `(SECUCODE="${secucode}")`;
  const prefix = market === 'US' ? 'RPT_USF10_FN' : 'RPT_HKF10_FN';
  // 长表把科目当行，一期有 25-60 行；多取一期用于判断窗口是否饱和（饱和即丢弃最旧一组）。
  const windowSize = Math.min(500, (periods + 1) * LONG_ROWS_PER_PERIOD);
  const [incomeRows, balanceRows, indicatorRows] = await Promise.all([
    fetchRows(`${prefix}_INCOME`, filter, 'STD_REPORT_DATE', windowSize, financialsCacheKey(`income:${market}`, code, windowSize)),
    fetchRows(`${prefix}_BALANCE`, filter, 'STD_REPORT_DATE', windowSize, financialsCacheKey(`balance:${market}`, code, windowSize)),
    market === 'HK'
      ? fetchRows('RPT_HKF10_FN_MAININDICATOR', filter, 'STD_REPORT_DATE', periods, financialsCacheKey('indicator:HK', code, periods))
      : Promise.resolve<Row[]>([]),
  ]);
  const first = incomeRows[0] ?? balanceRows[0] ?? indicatorRows[0];
  if (!first) return null;

  const income = parseLongStatement('income', incomeRows, {
    periods,
    market,
    // 美股同一报告期有「单季报 / 累计季报」两套数值，优先累计口径以便与 A 股/港股对齐。
    preferReportTypes: ['累计季报', '年报', '中报', '单季报'],
    windowTruncated: incomeRows.length >= windowSize,
  });
  const balance = parseLongStatement('balance', balanceRows, {
    periods,
    market,
    windowTruncated: balanceRows.length >= windowSize,
  });

  const statements: FinancialStatement[] = [
    {
      kind: 'income',
      label: STATEMENT_LABELS.income,
      available: income.length > 0,
      ...(income.length === 0 ? { reason: `${market} F10 未返回利润表数据` } : {}),
      periods: income,
    },
    {
      kind: 'balance',
      label: STATEMENT_LABELS.balance,
      available: balance.length > 0,
      ...(balance.length === 0 ? { reason: `${market} F10 未返回资产负债表数据` } : {}),
      periods: balance,
    },
  ];

  if (market === 'HK') {
    const cashflow = parseWideIndicator(indicatorRows, periods, market);
    statements.push({
      kind: 'cashflow',
      label: STATEMENT_LABELS.cashflow,
      available: cashflow.length > 0,
      reason: '东方财富港股 F10 现金流量表明细无对应接口，以下为「主要指标」中的现金流总量',
      note: '港股现金流量表明细不可用，仅总量口径',
      periods: cashflow,
    });
  } else {
    // 东方财富美股 F10 无现金流量表接口 → 回退到 SEC EDGAR XBRL（官方口径，零 Key）。
    const edgarPeriods = await edgarCashflow(code, periods);
    if (edgarPeriods.length > 0) {
      statements.push({
        kind: 'cashflow',
        label: STATEMENT_LABELS.cashflow,
        available: true,
        note: '来源：SEC EDGAR XBRL（10-K/10-Q 官方口径）',
        periods: edgarPeriods,
      });
    } else {
      statements.push({
        kind: 'cashflow',
        label: STATEMENT_LABELS.cashflow,
        available: false,
        reason:
          '东方财富美股 F10 无现金流量表接口，且 SEC EDGAR 未返回该发行人的现金流科目；如需明细请用 web_search 检索 10-K/10-Q 原文',
        periods: [],
      });
    }
  }

  const warnings: string[] = [];
  for (const statement of statements) {
    if (!statement.available && statement.kind !== 'cashflow') warnings.push(`${statement.label}不可用`);
  }
  const cashflow = statements.find((statement) => statement.kind === 'cashflow');
  if (market === 'US' && cashflow && !cashflow.available) {
    warnings.push('美股现金流量表不可用（东方财富无接口，SEC EDGAR 亦无该发行人数据）');
  }
  if (market === 'US' && cashflow?.available && edgarUsesPlaceholder()) {
    warnings.push('SEC EDGAR 使用默认 User-Agent（含占位邮箱），建议设置 AIA_EDGAR_USER_AGENT 为你的真实邮箱以符合 SEC 要求');
  }

  return {
    code,
    market,
    name: text(first.SECURITY_NAME_ABBR) || fallbackName || code,
    currency: currencyOf(first, market),
    standard: text(first.ACCOUNT_STANDARD) || null,
    statements,
    highlights: deriveHighlights(statements),
    sources: [SOURCE],
    warnings,
  };
}

/**
 * 拉取一只标的的财报三表（多期）。
 *
 * 返回 null 表示**完全拿不到**任何报表数据；部分缺失（如美股现金流量表）会以
 * `available:false` + `reason` 表达，不会被静默吞掉。
 */
export async function emFinancials(
  market: Market,
  code: string,
  fallbackName = '',
  periods = 4,
): Promise<Financials | null> {
  const clean = code.trim();
  if (!clean) return null;
  const limit = Math.max(1, Math.min(MAX_PERIODS, Math.trunc(periods) || 4));
  try {
    return market === 'CN'
      ? await cnFinancials(clean, fallbackName, limit)
      : await longFinancials(market, clean, fallbackName, limit);
  } catch {
    return null;
  }
}

/* ────────────────────────── 供 LLM 使用的紧凑结构 ────────────────────────── */

/**
 * 把 `Financials` 压成「标签 → 各期数值数组」的列式结构。
 *
 * 指标名只出现一次，N 期数值跟在后面 —— 同样的数据比逐期对象省 60%+ token。
 */
export function compactFinancials(financials: Financials, maxPeriods = 4): Record<string, unknown> {
  const statements: Record<string, unknown> = {};
  const unavailable: Array<{ table: string; reason: string }> = [];
  let columns: string[] = [];

  for (const statement of financials.statements) {
    if (!statement.available) {
      unavailable.push({ table: statement.label, reason: statement.reason ?? '不可用' });
      continue;
    }
    const periods = statement.periods.slice(0, Math.max(1, maxPeriods));
    if (periods.length > columns.length) columns = periods.map((item) => item.period);
    const labels: string[] = [];
    for (const period of periods) {
      for (const line of period.lines) if (!labels.includes(line.label)) labels.push(line.label);
    }
    const rows: Record<string, Array<number | null>> = {};
    for (const label of labels) {
      rows[label] = periods.map((period) => period.lines.find((line) => line.label === label)?.value ?? null);
    }
    statements[statement.kind] = {
      label: statement.label,
      ...(statement.note ? { note: statement.note } : {}),
      cumulative: periods.map((period) => (period.cumulative ? '累计' : '单季')),
      lines: rows,
    };
  }

  return {
    name: financials.name,
    currency: financials.currency,
    standard: financials.standard,
    periods: columns,
    unit: `金额=${financials.currency}，每股=${financials.currency}/股，比率=%`,
    statements,
    highlights: financials.highlights,
    ...(unavailable.length > 0 ? { unavailable } : {}),
    ...(financials.warnings.length > 0 ? { warnings: financials.warnings } : {}),
  };
}
