/**
 * 财报三表面板 —— 资产详情 / 标的详情共用。
 *
 * 数据来自 `GET /api/market/financials`（与 agent 工具 `get_financials` 同源），
 * 展示利润表 / 资产负债表 / 现金流量表的多期对比 + 派生比率；某张表上游拿不到时
 * 明确显示「数据缺失 + 原因」，绝不用 0 或估值指标顶替。
 *
 * Owner: Lead — 与 `InstrumentDetailSections` 一样由两个详情弹窗复用。
 */
import { useState } from 'react';
import type { FinancialPeriod, FinancialStatement, FinancialsResponse } from '@aia/shared';
import { api } from '../api/client';
import { useAsync } from '../api/hooks';
import { fmtCompact, fmtNum, fmtPct, pnlClass, safeNumber } from '../format';
import { Alert, Badge, Card, Empty, Loading, Segmented } from './ui';
import type { InstrumentRef } from './InstrumentDetailSections';

const PERIOD_OPTIONS = [
  { value: '4', label: '4 期' },
  { value: '6', label: '6 期' },
  { value: '8', label: '8 期' },
];

/* ─────────────────────── 纯函数（table 数据组装，可单测） ──────────────────── */

export interface StatementRow {
  key: string;
  label: string;
  unit: string;
  /** 与 `statement.periods` 一一对应（新 → 旧），缺值为 null。 */
  values: (number | null)[];
  /** 最新一期的同比（%），上游没给就是 null。 */
  latestYoy: number | null;
}

/**
 * 把一张报表的多个报告期转成「科目为行、报告期为列」。
 *
 * 行顺序以最新一期为准（老期间独有的科目追加在后面）；标签也以最新一期为准，
 * 因为同一 `key` 在不同行业模板下标签不同（例如银行是「营业收入」）。
 */
export function statementRows(statement: FinancialStatement): StatementRow[] {
  const periods: FinancialPeriod[] = statement.periods;
  const rows = new Map<string, StatementRow>();
  periods.forEach((period, index) => {
    for (const line of period.lines) {
      let row = rows.get(line.key);
      if (!row) {
        row = {
          key: line.key,
          label: line.label,
          unit: line.unit,
          values: periods.map((): number | null => null),
          latestYoy: null,
        };
        rows.set(line.key, row);
      }
      row.values[index] = line.value;
      if (index === 0) {
        row.label = line.label;
        row.unit = line.unit;
        row.latestYoy = line.yoy ?? null;
      }
    }
  });
  return [...rows.values()];
}

/** 金额走中文万/亿，比率带 %，每股指标保留 3 位小数。 */
export function formatFinancialValue(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (unit === '%') return fmtPct(value, 2, false);
  if (unit.endsWith('/股')) return fmtNum(value, 3);
  return fmtCompact(value);
}

/** `-1.6322亿CNY（2026中报）` → main `-1.6322亿CNY` + hint `2026中报`。 */
export function splitHighlightValue(value: string): { main: string; hint: string } {
  const match = /^(.*?)[（(]([^）)]*)[）)]\s*$/.exec(value.trim());
  if (!match) return { main: value.trim(), hint: '' };
  return { main: match[1]!.trim(), hint: match[2]!.trim() };
}

/**
 * 财报指标卡。
 *
 * 之前直接复用 `StatCard`（`font-size: 25px`），像
 * `归母净利润同比=4.0816%（2026中报）` 这样的长值会**溢出卡片边框**。
 * 这里把「期间」拆成单独一行提示，数值允许换行，并按需着色：只有「同比 / 环比 /
 * 增长」这类方向性指标才用红涨绿跌，比率类保持金色（否则 `资产负债率 40.42%`
 * 会被误标成「涨」）。
 */
function HighlightCard({ label, value }: { label: string; value: string }) {
  const { main, hint } = splitHighlightValue(value);
  const directional = /同比|环比|增长|增速/.test(label);
  const tone = directional ? pnlClass(safeNumber(main.replace(/[,\s%％]/g, ''), Number.NaN)) : 'flat';
  return (
    <div className="fin-highlight" title={`${label}：${value}`}>
      <div className="fin-highlight-label">{label}</div>
      <div className={`fin-highlight-value ${tone}`}>{main}</div>
      {hint && <div className="fin-highlight-hint">{hint}</div>}
    </div>
  );
}

/** `资产负债率=15.19%（2026中报）` → 指标卡片的 label / value。 */
export function parseHighlight(text: string): { label: string; value: string } {
  const index = text.indexOf('=');
  if (index <= 0) return { label: text.trim(), value: '' };
  return { label: text.slice(0, index).trim(), value: text.slice(index + 1).trim() };
}

/* ──────────────────────────────── 组件 ───────────────────────────────────── */

export interface FinancialsViewProps {
  data: FinancialsResponse;
  /** 期数选择器当前值（`4` / `6` / `8`）。 */
  periods: string;
  onPeriodsChange: (value: string) => void;
  /** ETF / 场外基金不显示期数选择器（也不适用三表）。 */
  showPeriods: boolean;
}

/**
 * 纯展示层：不取数、不带 hooks，便于无头渲染验证与静态预览。
 * 数据来自 `FinancialsResponse`（真实接口形状）。
 */
export function FinancialsView(props: FinancialsViewProps) {
  const { data, periods, onPeriodsChange, showPeriods } = props;
  const title = (
    <span className="center gap-2">
      财务报表（三表）
      {data.currency && <Badge tone="manual">{data.currency}</Badge>}
      {data.standard && <Badge tone="manual">{data.standard}</Badge>}
      {data.sources.map((source) => (
        <Badge key={source} tone="manual">
          {source}
        </Badge>
      ))}
    </span>
  );
  const actions = showPeriods ? <Segmented value={periods} options={PERIOD_OPTIONS} onChange={onPeriodsChange} /> : undefined;

  if (!data.applicable) {
    return (
      <Card title={title}>
        <Empty title="该标的没有公司财报" hint="ETF / 场外基金不披露三表，请看基金详情与净值曲线。" />
      </Card>
    );
  }

  const highlights = data.highlights.map(parseHighlight).filter((item) => item.value !== '');
  const hasCumulative = data.statements.some(
    (statement) => statement.available && statement.periods.some((period) => period.cumulative),
  );

  return (
    <Card title={title} actions={actions}>
      {highlights.length > 0 && (
        <div className="grid-4 mb-3">
          {highlights.map((item) => (
            <HighlightCard key={item.label} label={item.label} value={item.value} />
          ))}
        </div>
      )}

      {data.statements.map((statement) => (
        <div className="mb-3" key={statement.kind}>
          <div className="small strong mb-2">
            {statement.label}
            {statement.note && <span className="mute tiny">（{statement.note}）</span>}
          </div>
          {statement.available ? (
            <StatementTable statement={statement} />
          ) : (
            <Alert tone="warn">数据缺失：{statement.label} —— {statement.reason ?? '上游未返回数据'}</Alert>
          )}
        </div>
      ))}

      {hasCumulative && (
        <div className="tiny mute">
          口径：A 股 / 港股定期报告为年初至今累计（一季报=1 个季度、中报=上半年、三季报=前三季度、年报=全年），美股取累计季报口径；「同比」为最新一期。
        </div>
      )}
      {data.warnings.length > 0 && <div className="tiny mute mt-2">数据源提示：{data.warnings.join('；')}</div>}
    </Card>
  );
}

export function FinancialsPanel(props: { instrument: InstrumentRef }) {
  const { instrument } = props;
  const [periods, setPeriods] = useState('4');
  const state = useAsync<FinancialsResponse>(
    () =>
      api.market.financials({
        market: instrument.market,
        code: instrument.code,
        type: instrument.type,
        periods: Number(periods),
      }),
    [instrument.market, instrument.code, instrument.type, periods],
  );

  const data = state.data;
  if (state.loading && !data) {
    return (
      <Card title="财务报表（三表）">
        <Loading label="正在获取财报…" />
      </Card>
    );
  }
  if (state.error) {
    return (
      <Card title="财务报表（三表）">
        <Alert tone="error">{state.error.message}</Alert>
      </Card>
    );
  }
  if (!data) return null;
  return (
    <FinancialsView
      data={data}
      periods={periods}
      onPeriodsChange={setPeriods}
      showPeriods={instrument.type === 'stock'}
    />
  );
}

function StatementTable({ statement }: { statement: FinancialStatement }) {
  const rows = statementRows(statement);
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>科目</th>
            {statement.periods.map((period) => (
              <th className="num" key={`${period.reportDate}-${period.reportType}`}>
                {period.period}
                <div className="tiny mute">
                  {period.cumulative ? '累计' : '单季'} · {period.reportType}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>
                {row.label}
                {row.latestYoy !== null && <span className={`tiny ${pnlClass(row.latestYoy)}`}> 同比 {fmtPct(row.latestYoy)}</span>}
              </td>
              {row.values.map((value, index) => (
                <td className="num" key={index}>
                  {formatFinancialValue(value, row.unit)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
