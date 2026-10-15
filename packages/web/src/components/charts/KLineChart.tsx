/**
 * Candlestick chart with volume, drag/zoom range selection and buy/sell markers.
 * Owner: Lead — used by both detail dialogs.
 */
import { useMemo } from 'react';
import type { SeriesPoint } from '@aia/shared';
import { EChart, CHART_COLORS, baseAxisStyle, goldTooltipStyle, type EChartsCoreOption } from './EChart';
import { markerPointTooltip, seriesTooltipFormatter, type MarkerInfo } from './tradeMarkers';

/** 买卖点：带成交明细，悬浮时显示完整信息（金额 / 费用 / 备注）。 */
export type TradeMarker = MarkerInfo;

export interface KLineChartProps {
  points: SeriesPoint[];
  markers?: TradeMarker[];
  currency?: string;
  className?: string;
  /** Chart identity — changing it re-creates the canvas. */
  resetKey?: string;
}

export function KLineChart({ points, markers = [], currency = '', className = 'chart chart-lg', resetKey }: KLineChartProps) {
  const option = useMemo<EChartsCoreOption>(() => {
    const dates = points.map((point) => point.date);
    // ECharts candlestick expects [open, close, low, high].
    const candles = points.map((point) => [point.open, point.close, point.low, point.high]);
    const volumes = points.map((point, index) => ({
      value: point.volume,
      itemStyle: { color: point.close >= point.open ? 'rgba(255,90,95,0.5)' : 'rgba(47,191,143,0.5)' },
      index,
    }));
    const markerData = markers
      .filter((marker) => dates.includes(marker.date.slice(0, 10)))
      .map((marker) => ({
        name: marker.kind === 'buy' ? '买入' : '卖出',
        coord: [marker.date.slice(0, 10), marker.price],
        value: marker.kind === 'buy' ? '买' : '卖',
        symbol: 'pin',
        symbolSize: 34,
        itemStyle: {
          color: marker.kind === 'buy' ? CHART_COLORS.buy : CHART_COLORS.sell,
          shadowBlur: 14,
          shadowColor: marker.kind === 'buy' ? 'rgba(212,175,55,0.9)' : 'rgba(47,191,143,0.8)',
        },
        label: {
          color: CHART_COLORS.ink,
          fontSize: 10,
          fontWeight: 'bold' as const,
          formatter: marker.kind === 'buy' ? 'B' : 'S',
        },
        // 直接悬停 pin 时的面板（坐标轴面板由下方的 chart tooltip 提供）。
        tooltip: { formatter: markerPointTooltip(marker, currency) },
        emphasis: { scale: 1.25 },
      }));

    return {
      animation: false,
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: {
          type: 'cross',
          crossStyle: { color: 'rgba(212,175,55,0.55)', width: 1, type: 'dashed' },
          label: { backgroundColor: '#1b160b', borderColor: CHART_COLORS.panelBorder, color: CHART_COLORS.inkText },
        },
        ...goldTooltipStyle(),
        // 行情 + 当天买卖点：鼠标落在买卖标签上也能看到成交明细。
        formatter: seriesTooltipFormatter({ points, markers, currency, kind: 'kline' }) as unknown as string,
      },
      legend: { show: false },
      grid: [
        { left: 58, right: 18, top: 18, height: '58%' },
        { left: 58, right: 18, top: '76%', height: '14%' },
      ],
      xAxis: [
        {
          type: 'category',
          data: dates,
          boundaryGap: true,
          ...baseAxisStyle(),
          axisLabel: { color: CHART_COLORS.text, fontSize: 11, hideOverlap: true },
        },
        {
          type: 'category',
          gridIndex: 1,
          data: dates,
          axisLabel: { show: false },
          axisLine: { lineStyle: { color: CHART_COLORS.axis } },
          axisTick: { show: false },
        },
      ],
      yAxis: [
        {
          scale: true,
          ...baseAxisStyle(),
          axisLabel: { color: CHART_COLORS.text, fontSize: 11, formatter: (value: number) => String(value) },
        },
        {
          gridIndex: 1,
          scale: true,
          splitNumber: 2,
          axisLabel: { show: false },
          axisLine: { show: false },
          splitLine: { show: false },
        },
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], start: 55, end: 100, zoomOnMouseWheel: true, moveOnMouseMove: true },
        {
          type: 'slider',
          xAxisIndex: [0, 1],
          bottom: 4,
          height: 18,
          start: 55,
          end: 100,
          borderColor: CHART_COLORS.axis,
          fillerColor: CHART_COLORS.goldSoft,
          handleStyle: { color: CHART_COLORS.gold, borderColor: CHART_COLORS.gold, shadowBlur: 12, shadowColor: 'rgba(212,175,55,0.9)' },
          moveHandleStyle: { color: CHART_COLORS.gold },
          textStyle: { color: CHART_COLORS.text, fontSize: 10 },
          dataBackground: { lineStyle: { color: CHART_COLORS.axis }, areaStyle: { color: 'rgba(212,175,55,0.1)' } },
          selectedDataBackground: { lineStyle: { color: CHART_COLORS.gold }, areaStyle: { color: CHART_COLORS.goldSoft } },
        },
      ],
      series: [
        {
          name: 'K线',
          type: 'candlestick',
          data: candles,
          itemStyle: {
            color: CHART_COLORS.up,
            color0: CHART_COLORS.down,
            borderColor: CHART_COLORS.up,
            borderColor0: CHART_COLORS.down,
          },
          markPoint: markerData.length > 0 ? { data: markerData, silent: false } : undefined,
        },
        {
          name: '成交量',
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: volumes,
          barWidth: '60%',
        },
      ],
    };
  }, [points, markers, currency]);

  return <EChart option={option} className={className} resetKey={resetKey} />;
}
