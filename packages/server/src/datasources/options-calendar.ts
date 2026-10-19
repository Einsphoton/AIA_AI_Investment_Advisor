/**
 * Calendar helpers for the HK stock-option daily report (`HKEX dqe{YYMMDD}.htm`).
 *
 * Owner: options-datasource.
 *
 * ── 为什么这里**没有**「港股公众假期表」────────────────────────────────────────
 * 实测（2026-10-19）：HKEX 的官方假期日历页 `https://www.hkex.com.hk/News/HKEX-Calendar`
 * 是 JS 渲染的，抓到的 HTML（1,591,798 bytes）里没有可直接解析的假期表格；能拿到的
 * 只有「今日是否休市」的告示文案。硬编码一份凭记忆写的假期表属于**臆造数据**，
 * 一旦错一天就会把到期日/剩余天数算错，所以这里不做。
 *
 * 替代方案是**权威且实测可用**的：HKEX 每日报告在非交易日直接返回 HTTP 404
 * （实测 251018 周六、251019 周日、251001 国庆、250101 元旦 全部 404；
 * 251016/251017/251020/251021 工作日 200）。也就是说「这一天有没有报告 / 是不是
 * 交易日」由上游自己回答，不需要本地假期表 —— 见 `options.ts` 里的
 * `resolveHkexReport()` 逐日回退逻辑。
 *
 * ── 到期日：不需要推导 ──────────────────────────────────────────────────────
 * HKEX 报告的 `CONTRACT` 列实测是**完整的到期日** `DDMMMYY`（如 `17OCT25`、
 * `30OCT25`），不是「合约月份」。实测 00700 / 09988 各 9 个到期：
 *   17OCT25 24OCT25 30OCT25 27NOV25 30DEC25 29JAN26 30MAR26 29JUN26 29SEP26
 * 其中 7 个月度到期与官方 `Expiry Day` 规则（「合约月最后一个营业日的**前一个**
 * 营业日」）逐条吻合 7/7：10/31(Fri)→10/30、11/28(Fri)→11/27、12/31(Wed)→12/30、
 * 01/30(Fri)→01/29、03/31(Tue)→03/30、06/30(Tue)→06/29、09/30(Wed)→09/29；
 * 2 个周度到期 `17OCT25` / `24OCT25` 都是周五，符合「该周最后一个营业日」。
 * 所以 `hkExpiryFromContractMonth()` 只是把这个 `DDMMMYY` 解析成 ISO 日期，
 * **不做任何假期推算**。
 */

/** HKEX 报告最多往前回退多少个自然日（长假也能覆盖，实测国庆/元旦都是 404）。 */
export const HKEX_REPORT_MAX_LOOKBACK_DAYS = 10;

const MONTHS: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 校验并组装 `YYYY-MM-DD`；日期不存在（如 2 月 30 日）返回 null。 */
function isoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * HKEX 报告的 `CONTRACT` 列（`DDMMMYY`）→ `YYYY-MM-DD`。
 *
 * 实测样例：`'17OCT25' → '2025-10-17'`、`'30OCT25' → '2025-10-30'`、
 * `'29SEP26' → '2026-09-29'`。无法判定时返回 `null`（绝不用猜测值）。
 */
export function hkExpiryFromContractMonth(contractMonth: string): string | null {
  if (typeof contractMonth !== 'string') return null;
  const match = /^(\d{2})([A-Z]{3})(\d{2})$/.exec(contractMonth.trim().toUpperCase());
  if (!match) return null;
  const day = Number(match[1]);
  const month = MONTHS[match[2] as string];
  const year = 2000 + Number(match[3]);
  if (month === undefined) return null;
  return isoDate(year, month, day);
}

/**
 * OCC / CBOE 的 6 位到期日 `YYMMDD` → `YYYY-MM-DD`。
 *
 * 实测样例（AAPL 链）：`'261019' → '2026-10-19'`、`'261218' → '2026-12-18'`、
 * `'290119' → '2029-01-19'`。无法判定时返回 `null`。
 */
export function occExpiryToIso(yyMmDd: string): string | null {
  if (typeof yyMmDd !== 'string') return null;
  const match = /^(\d{2})(\d{2})(\d{2})$/.exec(yyMmDd.trim());
  if (!match) return null;
  return isoDate(2000 + Number(match[1]), Number(match[2]), Number(match[3]));
}

/** `YYYY-MM-DD` → HKEX 报告文件名用的 `YYMMDD`（如 `2025-10-16` → `251016`）。 */
export function isoToYyMmDd(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return '';
  return `${match[1]!.slice(2)}${match[2]}${match[3]}`;
}

/** ISO 日期加减自然日（UTC 口径，避免本地时区把日期推错一天）。 */
export function addDaysIso(iso: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return iso;
  const base = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const shifted = new Date(base + days * 86_400_000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/** `to - from` 的自然日差（正数 = 未来）。 */
export function calendarDaysBetween(fromIso: string, toIso: string): number {
  const parse = (iso: string): number | null => {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
    if (!match) return null;
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  };
  const from = parse(fromIso);
  const to = parse(toIso);
  if (from === null || to === null) return 0;
  return Math.round((to - from) / 86_400_000);
}

/** `YYYY-MM-DD` 取前 10 位；用于把 ISO 时间戳降级成日期。 */
export function datePart(iso: string): string {
  return typeof iso === 'string' ? iso.slice(0, 10) : '';
}

/** 周六/周日。只用来**减少**必然 404 的探测（HKEX 周末不出报告）。 */
export function isWeekendIso(iso: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return false;
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * 从 `from` 往前逐日列出「可能是交易日」的 ISO 日期（已跳过周末），最多 `days` 个自然日。
 *
 * 公众假期不在本地判断（理由见文件头），由 `options.ts` 对每个候选日发一次请求、
 * 拿 HTTP 404 来确认 —— 这就是上游给出的、权威的「非交易日」信号。
 */
export function recentTradingDateCandidates(days = HKEX_REPORT_MAX_LOOKBACK_DAYS, from = new Date()): string[] {
  const today = `${from.getFullYear()}-${pad2(from.getMonth() + 1)}-${pad2(from.getDate())}`;
  const out: string[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const iso = addDaysIso(today, -offset);
    if (!isWeekendIso(iso)) out.push(iso);
  }
  return out;
}
