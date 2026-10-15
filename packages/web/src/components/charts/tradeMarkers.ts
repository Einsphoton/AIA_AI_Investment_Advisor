/**
 * 买卖点悬浮面板 —— K 线 / 净值曲线共用。Owner: Lead.
 *
 * ECharts 的 markPoint 自带 tooltip，但两个图表用的是 `trigger: 'axis'`，鼠标落在
 * 买卖标签上时优先触发坐标轴提示，成交细节看不到。这里把成交信息**合并进
 * axis tooltip**：悬浮到哪一天，就在那一天的行情下面列出当天的买入 / 卖出，
 * 同时保留 markPoint 自身的 tooltip（直接悬停 pin 时也能看）。
 *
 * 返回的是 ECharts 接受的 HTML 片段。内容全部来自本地账本（数字 + 用户备注），
 * 仍然统一转义一次 —— 备注里可能出现 `<` / `>`。
 */
import type { SeriesPoint } from '@aia/shared';
import { fmtMoney, fmtNum, fmtPrice, fmtShares } from '../../format';

export interface MarkerInfo {
  kind: 'buy' | 'sell';
  date: string;
  price: number;
  shares?: number;
  /** 成交金额（缺失时按 shares × price 计算）。 */
  amount?: number;
  fee?: number;
  note?: string;
}

const INK = '#f4efe3';
const DIM = '#b7ae9c';
const MUTE = '#8b8375';
const BUY = '#e2ba55';
const SELL = '#2fbf8f';

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    if (char === '&') return '&amp;';
    if (char === '<') return '&lt;';
    if (char === '>') return '&gt;';
    if (char === '"') return '&quot;';
    return '&#39;';
  });
}

function row(label: string, value: string): string {
  return (
    '<div style="display:flex;justify-content:space-between;gap:18px;line-height:1.7">' +
    `<span style="color:${DIM}">${escapeHtml(label)}</span>` +
    `<span style="color:${INK};font-variant-numeric:tabular-nums">${escapeHtml(value)}</span></div>`
  );
}

/** 单笔成交的面板块（买入金色 / 卖出绿色）。 */
export function markerTooltipBlock(marker: MarkerInfo, currency = ''): string {
  const buy = marker.kind === 'buy';
  const color = buy ? BUY : SELL;
  const shares = marker.shares && marker.shares > 0 ? fmtShares(marker.shares) : '—';
  const amount = marker.amount && marker.amount > 0 ? marker.amount : (marker.shares ?? 0) * marker.price;
  const lines = [
    row('成交份额', shares),
    row('成交价格', fmtPrice(marker.price, currency)),
    row('成交金额', fmtMoney(amount, currency)),
  ];
  if (marker.fee) lines.push(row('费用', fmtMoney(marker.fee, currency)));
  return (
    `<div style="margin-top:6px;padding:7px 9px;border-left:3px solid ${color};background:rgba(255,255,255,0.04);border-radius:4px">` +
    '<div style="display:flex;justify-content:space-between;gap:18px;margin-bottom:3px">' +
    `<span style="color:${color};font-weight:700">${buy ? '买入' : '卖出'}</span>` +
    `<span style="color:${MUTE}">${escapeHtml(marker.date.slice(0, 10))}</span></div>` +
    lines.join('') +
    (marker.note
      ? `<div style="color:${MUTE};margin-top:2px;max-width:260px;white-space:normal">备注：${escapeHtml(marker.note)}</div>`
      : '') +
    '</div>'
  );
}

export function markersOnDate(markers: MarkerInfo[], date: string): MarkerInfo[] {
  return markers.filter((marker) => marker.date.slice(0, 10) === date);
}

/** markPoint 自身的 tooltip（直接悬停 pin 时）。 */
export function markerPointTooltip(marker: MarkerInfo, currency = ''): string {
  return markerTooltipBlock(marker, currency);
}

/**
 * markPoint 数据项（买卖 pin）。K 线图与净值曲线共用，两边不再各抄一份。
 *
 * **`tooltip.trigger: 'item'` 不能省。** 两个图表的全局 tooltip 都是
 * `trigger: 'axis'`；鼠标落在 pin 上时 ECharts 走的是
 * `TooltipView._showSeriesItemTooltip`，它会把 `[数据项模型, markPoint 模型,
 * 坐标系模型]` 与全局 tooltip 级联，再用**级联后**的 `trigger` 判断
 * （echarts 6.1 `TooltipView.js` 中 `if (tooltipTrigger != null && tooltipTrigger
 * !== 'item') return;`）。只写 `formatter` 时 `trigger` 会从全局继承到 `'axis'`
 * 并直接 return —— pin 上既没有成交明细浮窗，轴提示也因为 pin 常常伸出坐标系
 * （`coordSys.containPoint()` 为假、`dataByCoordSys.list` 为空 → hideTip）而
 * 什么都不显示，这就是「悬浮买卖标签没有任何浮窗」。
 *
 * formatter 用**函数**而不是字符串：字符串会被当成 `{a}` 模板再走一遍 formatTpl。
 */
export function markerPointData(marker: MarkerInfo, currency = '') {
  const buy = marker.kind === 'buy';
  return {
    name: buy ? '买入' : '卖出',
    coord: [marker.date.slice(0, 10), marker.price],
    value: buy ? '买' : '卖',
    symbol: 'pin',
    symbolSize: 34,
    itemStyle: {
      color: buy ? BUY : SELL,
      shadowBlur: 14,
      shadowColor: buy ? 'rgba(212,175,55,0.9)' : 'rgba(47,191,143,0.8)',
    },
    label: { color: INK, fontSize: 10, fontWeight: 'bold' as const, formatter: buy ? 'B' : 'S' },
    tooltip: { trigger: 'item' as const, formatter: () => markerPointTooltip(marker, currency) },
    emphasis: { scale: 1.25 },
  };
}

/**
 * axis tooltip formatter：行情明细 + 当天全部买卖点。
 *
 * 用 `params[0].dataIndex` 回查原始点，而不是解析 ECharts 塞进 `data` 的
 * 数组形状（candlestick 在不同版本里会多带一个 index），这样数值永远准确。
 */
export function seriesTooltipFormatter(opts: {
  points: SeriesPoint[];
  markers: MarkerInfo[];
  currency?: string;
  kind: 'kline' | 'nav';
}): (params: unknown) => string {
  const { points, markers, currency = '', kind } = opts;
  return (raw) => {
    const params = Array.isArray(raw) ? raw : [raw];
    const index = Number((params[0] as { dataIndex?: number } | undefined)?.dataIndex ?? -1);
    const point = index >= 0 && index < points.length ? points[index] : undefined;
    if (!point) return '';
    const date = point.date.slice(0, 10);
    const rows: string[] = [];
    if (kind === 'kline') {
      rows.push(row('开盘', fmtNum(point.open, 3)));
      rows.push(row('最高', fmtNum(point.high, 3)));
      rows.push(row('最低', fmtNum(point.low, 3)));
      rows.push(row('收盘', fmtNum(point.close, 3)));
      if (point.open > 0) {
        const pct = ((point.close - point.open) / point.open) * 100;
        rows.push(row('涨跌', `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`));
      }
      if (point.volume) rows.push(row('成交量', fmtNum(point.volume, 0)));
    } else {
      rows.push(row('单位净值', fmtNum(point.close, 4)));
      if (point.accumNav) rows.push(row('累计净值', fmtNum(point.accumNav, 4)));
    }
    const blocks = markersOnDate(markers, date).map((marker) => markerTooltipBlock(marker, currency)).join('');
    return `<div style="color:${INK};font-weight:600;margin-bottom:4px">${escapeHtml(date)}</div>` + rows.join('') + blocks;
  };
}
