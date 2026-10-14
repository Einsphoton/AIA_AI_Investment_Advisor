/**
 * Thin React wrapper around Apache ECharts (modular build). Owner: Lead.
 */
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, CandlestickChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  AxisPointerComponent,
  DataZoomComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  MarkPointComponent,
  TitleComponent,
  ToolboxComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

echarts.use([
  CandlestickChart,
  LineChart,
  BarChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkPointComponent,
  AxisPointerComponent,
  TitleComponent,
  ToolboxComponent,
  GraphicComponent,
  CanvasRenderer,
]);

export interface EChartProps {
  option: EChartsCoreOption;
  /** CSS class controlling the height (`.chart-md`, `.chart-lg`, `.chart-sm`). */
  className?: string;
  /** Re-create the chart when the underlying instrument changes. */
  resetKey?: string;
  onInit?: (chart: echarts.ECharts) => void;
}

export function EChart({ option, className = 'chart chart-md', resetKey, onInit }: EChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const chart = echarts.init(node, undefined, { renderer: 'canvas' });
    chartRef.current = chart;
    onInit?.(chart);

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(node);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, [option, resetKey]);

  return <div ref={containerRef} className={className} />;
}

/**
 * Chart palette — "Obsidian & Gold". Kept in one place so every ECharts option
 * (K线 / 净值 / 成交量 / 提示框 / 缩放条) stays on the same black-gold theme.
 * `up`/`down` keep the A 股 convention (红涨绿跌) instead of following the gold
 * accent, because they carry meaning rather than decoration.
 */
export const CHART_COLORS = {
  up: '#ff5a5f',
  down: '#2fbf8f',
  line: '#e2ba55',
  line2: '#c8ccd6',
  axis: 'rgba(212, 175, 55, 0.26)',
  text: '#b7ae9c',
  grid: 'rgba(255, 255, 255, 0.05)',
  buy: '#e2ba55',
  sell: '#2fbf8f',
  gold: '#d4af37',
  goldSoft: 'rgba(212, 175, 55, 0.16)',
  /** Tooltip / label surfaces. */
  panel: 'rgba(8, 8, 11, 0.96)',
  panelBorder: 'rgba(212, 175, 55, 0.32)',
  ink: '#0a0a0d',
  inkText: '#f4efe3',
};

export function baseAxisStyle() {
  return {
    axisLine: { lineStyle: { color: CHART_COLORS.axis } },
    axisLabel: { color: CHART_COLORS.text, fontSize: 11 },
    splitLine: { lineStyle: { color: CHART_COLORS.grid } },
  };
}

/** Shared tooltip chrome for all charts. */
export function goldTooltipStyle() {
  return {
    backgroundColor: CHART_COLORS.panel,
    borderColor: CHART_COLORS.panelBorder,
    borderWidth: 1,
    padding: [8, 12] as [number, number],
    extraCssText: 'backdrop-filter: blur(10px); box-shadow: 0 18px 50px -20px rgba(0,0,0,.95), 0 0 40px -22px rgba(212,175,55,.8); border-radius: 10px;',
    textStyle: { color: CHART_COLORS.inkText, fontSize: 12 },
  };
}

export type { EChartsCoreOption };
