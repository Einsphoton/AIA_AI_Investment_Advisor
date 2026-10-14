/**
 * Display formatting helpers. Owner: Lead. All pages must format money and
 * percentages through these functions so the UI stays consistent.
 */
import { CURRENCY_SYMBOL, MARKET_CURRENCY_SYMBOL, type Market } from '@aia/shared';

export function symbolFor(currency?: string): string {
  if (!currency) return '';
  return CURRENCY_SYMBOL[currency.toUpperCase()] ?? `${currency} `;
}

export function symbolForMarket(market?: Market): string {
  return market ? MARKET_CURRENCY_SYMBOL[market] : '';
}

/** `1234.5` → `1,234.50`; keeps 2 decimals for money, 4 for prices < 1. */
export function fmtMoney(value: number | null | undefined, currency?: string, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const text = value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${symbolFor(currency)}${text}`;
}

export function fmtPrice(value: number | null | undefined, currency?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return '—';
  const digits = Math.abs(value) < 1 ? 4 : Math.abs(value) < 10 ? 3 : 2;
  return fmtMoney(value, currency, digits);
}

/** Signed percentage, e.g. `+12.34%`. */
export function fmtPct(value: number | null | undefined, digits = 2, signed = true): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const prefix = signed && value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(digits)}%`;
}

/** Signed money with explicit sign for P&L columns. */
export function fmtSignedMoney(value: number | null | undefined, currency?: string, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${symbolFor(currency)}${Math.abs(value).toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

/** Chinese compact units: 万 / 亿. */
export function fmtCompact(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(digits)}万亿`;
  if (abs >= 1e8) return `${(value / 1e8).toFixed(digits)}亿`;
  if (abs >= 1e4) return `${(value / 1e4).toFixed(digits)}万`;
  return value.toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

export function fmtShares(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
}

export function fmtNum(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

export function fmtDate(value: string | null | undefined): string {
  if (!value) return '—';
  return value.slice(0, 10);
}

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtRelative(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return fmtDate(value);
}

/** Colour class for a signed number (A-share convention: red = up). */
export function pnlClass(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return 'flat';
  return value > 0 ? 'pos' : 'neg';
}

export function todayIso(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function safeNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}
