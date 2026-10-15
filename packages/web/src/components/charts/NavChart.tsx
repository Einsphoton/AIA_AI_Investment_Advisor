/**
 * Net-asset-value (基金净值) line chart with buy/sell markers and range zoom.
 * Owner: Lead.
 */
import { useMemo } from 'react';
import type { SeriesPoint } from '@aia/shared';
import { EChart, CHART_COLORS, baseAxisStyle, goldTooltipStyle, type EChartsCoreOption } from './EChart';
import { markerPointData, seriesTooltipFormatter } from './tradeMarkers';
import type { TradeMarker } from './KLineChart';

export interface NavChartProps {
  points: SeriesPoint[];
  markers?: TradeMarker[];
  /** 计价货币，用于买卖点面板里的金额。 */
  currency?: string;
  className?: string;
  resetKey?: string;
  /** Show the accumulated NAV as a second line when available. */
  showAccum?: boolean;
}

export function NavChart({ points, markers = [], currency = '', className = 'chart chart-lg', resetKey, showAccum = true }: NavChartProps) {
  const option = useMemo<EChartsCoreOption>(() => {
    const dates = points.map((point) => point.date);
    const nav = points.map((point) => point.close);
    const accum = points.map((point) => point.accumNav ?? null);
    const hasAccum = showAccum && accum.some((value) => typeof value === 'number' && value > 0);

    // 买卖点：悬停 pin 弹成交明细（trigger: 'item' 必须显式声明，见 tradeMarkers）。
    const markerData = markers
      .filter((marker) => dates.includes(marker.date.slice(0, 10)))
      .map((marker) => markerPointData(marker, currency));

    return {
      animation: false,
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: 'rgba(212,175,55,0.55)', width: 1, type: 'dashed' } },
        ...goldTooltipStyle(),
        // 净值 + 当天买卖点。
        formatter: seriesTooltipFormatter({ points, markers, currency, kind: 'nav' }) as unknown as string,
      },
      legend: hasAccum
        ? { top: 0, right: 0, textStyle: { color: CHART_COLORS.text, fontSize: 11 }, data: ['单位净值', '累计净值'] }
        : { show: false },
      grid: { left: 62, right: 18, top: hasAccum ? 30 : 18, bottom: 46 },
      xAxis: { type: 'category', data: dates, boundaryGap: false, ...baseAxisStyle(), axisLabel: { color: CHART_COLORS.text, fontSize: 11, hideOverlap: true } },
      yAxis: { scale: true, ...baseAxisStyle() },
      dataZoom: [
        { type: 'inside', start: 55, end: 100 },
        {
          type: 'slider',
          bottom: 4,
          height: 18,
          borderColor: CHART_COLORS.axis,
          fillerColor: CHART_COLORS.goldSoft,
          handleStyle: { color: CHART_COLORS.gold, borderColor: CHART_COLORS.gold, shadowBlur: 12, shadowColor: 'rgba(212,175,55,0.9)' },
          textStyle: { color: CHART_COLORS.text, fontSize: 10 },
          dataBackground: { lineStyle: { color: CHART_COLORS.axis }, areaStyle: { color: 'rgba(212,175,55,0.1)' } },
          selectedDataBackground: { lineStyle: { color: CHART_COLORS.gold }, areaStyle: { color: CHART_COLORS.goldSoft } },
        },
      ],
      series: [
        {
          name: '单位净值',
          type: 'line',
          data: nav,
          showSymbol: false,
          smooth: false,
          lineStyle: { color: CHART_COLORS.line, width: 1.8, shadowBlur: 18, shadowColor: 'rgba(212,175,55,0.55)', shadowOffsetY: 6 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(212,175,55,0.34)' },
                { offset: 0.55, color: 'rgba(212,175,55,0.09)' },
                { offset: 1, color: 'rgba(212,175,55,0.01)' },
              ],
            },
          },
          markPoint: markerData.length > 0 ? { data: markerData } : undefined,
        },
        ...(hasAccum
          ? [
              {
                name: '累计净值',
                type: 'line' as const,
                data: accum,
                showSymbol: false,
                lineStyle: { color: CHART_COLORS.line2, width: 1.2, type: 'dashed' as const },
              },
            ]
          : []),
      ],
    };
  }, [points, markers, currency, showAccum]);

  return <EChart option={option} className={className} resetKey={resetKey} />;
}
