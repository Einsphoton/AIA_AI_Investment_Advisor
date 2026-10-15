/**
 * 财报对比页（`/compare`）—— 把 2-4 个标的的财报关键指标并排看。
 *
 * 数据来自 `GET /api/market/financials`（与 agent 工具 `get_financials` 同源）：
 * 候选来自「我的资产」与「我的标的」，选中后逐个拉取多期三表。
 * 缺失一律显示为「—」并给出原因，绝不用 0 顶替；ETF/基金明确标为「无财报」。
 *
 * Owner: Lead.
 */
import { useMemo, useState } from 'react';
import type { FinancialsResponse, InstrumentType, Market } from '@aia/shared';
import { api } from '../api/client';
import { useAsync } from '../api/hooks';
import { fmtCompact, fmtPct, pnlClass } from '../format';
import { Alert, Badge, Button, Card, Empty, Loading, Segmented } from '../components/ui';
import { FinancialsView, parseHighlight } from '../components/FinancialsPanel';

const MAX_COMPARE = 4;
const PERIOD_OPTIONS = [
  { value: '4', label: '4 期' },
  { value: '6', label: '6 期' },
  { value: '8', label: '8 期' },
];

export interface CompareCandidate {
  key: string;
  name: string;
  market: Market;
  code: string;
  type: InstrumentType;
  group: '持仓' | '标的';
}

export interface CompareInput extends CompareCandidate {
  data: FinancialsResponse | null;
}

export interface CompareRow {
  label: string;
  /** 与输入顺序一一对应；缺值为 null（渲染成「—」）。 */
  values: (string | null)[];
  /** 需要按涨跌着色的数值（同比等）。 */
  tones: (number | null)[];
}

export interface CompareTable {
  rows: CompareRow[];
  /** 每个标的的最新报告期（用于表头副标题）。 */
  periods: (string | null)[];
  warnings: string[];
}

/** 对比表的指标顺序（也是白名单：只展示这里列出的指标，避免把差异很大的科目硬凑一行）。 */
export const COMPARE_METRICS = [
  '营业总收入',
  '营业总收入同比',
  '归母净利润',
  '归母净利润同比',
  '毛利率',
  '归母净利率',
  '资产负债率',
  '经营活动现金流量净额',
  '自由现金流',
  '经营现金流/归母净利润',
] as const;

function money(value: number | null, unit: string): string | null {
  if (value === null) return null;
  return `${fmtCompact(value)}${unit === '%' ? '' : unit}`;
}

/** 把一只标的的财报压成「指标 → 显示值」；缺失的指标不入表（而不是填 0）。 */
function metricsOf(input: CompareInput): Map<string, { text: string; tone: number | null }> {
  const map = new Map<string, { text: string; tone: number | null }>();
  const data = input.data;
  if (!data || !data.applicable) return map;

  const statement = (kind: 'income' | 'balance' | 'cashflow') => data.statements.find((item) => item.kind === kind);
  const latest = (kind: 'income' | 'balance' | 'cashflow') => {
    const found = statement(kind);
    return found?.available ? found.periods[0] : undefined;
  };
  const line = (kind: 'income' | 'balance' | 'cashflow', key: string) =>
    latest(kind)?.lines.find((item) => item.key === key) ?? null;

  // 派生比率直接引用后端口径（已保证跨表同期）
  for (const text of data.highlights) {
    const item = parseHighlight(text);
    if (item.value) map.set(item.label, { text: item.value, tone: null });
  }

  const currency = data.currency;
  const revenue = line('income', 'revenue');
  if (revenue) map.set('营业总收入', { text: money(revenue.value, revenue.unit || currency)!, tone: null });
  if (revenue?.yoy !== undefined && revenue.yoy !== null) {
    map.set('营业总收入同比', { text: fmtPct(revenue.yoy), tone: revenue.yoy });
  }
  const profit = line('income', 'parentNetProfit') ?? line('income', 'netProfit');
  if (profit) map.set('归母净利润', { text: money(profit.value, profit.unit || currency)!, tone: null });
  if (profit?.yoy !== undefined && profit.yoy !== null) {
    map.set('归母净利润同比', { text: fmtPct(profit.yoy), tone: profit.yoy });
  }
  const ocf = line('cashflow', 'netcashOperate');
  if (ocf) map.set('经营活动现金流量净额', { text: money(ocf.value, ocf.unit || currency)!, tone: null });

  return map;
}

/**
 * 组装对比表：指标为行、标的为列。
 *
 * 指标缺失显示 null（页面渲染成「—」），不做任何 0/空串兜底 —— 这是财报数字，
 * 静默补零比留空危险得多。
 */
export function buildComparison(inputs: CompareInput[]): CompareTable {
  const perInput = inputs.map(metricsOf);
  const periods = inputs.map((input) => {
    const data = input.data;
    if (!data || !data.applicable) return null;
    const income = data.statements.find((item) => item.kind === 'income');
    return income?.available ? income.periods[0]?.period ?? null : null;
  });

  const rows: CompareRow[] = [];
  for (const label of COMPARE_METRICS) {
    const cells = perInput.map((map) => map.get(label) ?? null);
    if (cells.every((cell) => cell === null)) continue;
    rows.push({
      label,
      values: cells.map((cell) => (cell ? cell.text : null)),
      tones: cells.map((cell) => (cell ? cell.tone : null)),
    });
  }

  const warnings: string[] = [];
  inputs.forEach((input, index) => {
    if (!input.data) {
      warnings.push(`「${input.name}」财报数据不可用`);
      return;
    }
    if (!input.data.applicable) {
      warnings.push(`「${input.name}」是 ETF / 场外基金，没有公司财报`);
      return;
    }
    for (const statement of input.data.statements) {
      if (!statement.available) {
        warnings.push(`「${input.name}」${statement.label}数据缺失：${statement.reason ?? '上游未返回'}`);
      }
    }
    if (periods[index] && periods[0] && periods[index] !== periods[0]) {
      warnings.push(`「${input.name}」最新报告期是 ${periods[index]}，与其它标的（${periods[0]}）不同期，横向比较需注意口径`);
    }
  });

  return { rows, periods, warnings: [...new Set(warnings)] };
}

/* ──────────────────────────────── 页面 ───────────────────────────────────── */

export interface ComparisonColumn {
  name: string;
  market: Market;
  code: string;
}

/**
 * 纯展示：指标为行、标的为列。缺值渲染成「—」（数据来自 `buildComparison`）。
 * 抽成独立组件是为了能被 SSR 断言与 `npm run preview:financials` 复用。
 */
export function ComparisonTableView(props: { table: CompareTable; columns: ComparisonColumn[] }) {
  const { table, columns } = props;
  return (
    <>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>指标</th>
              {columns.map((column, index) => (
                <th className="num" key={`${column.market}-${column.code}`}>
                  {column.name}
                  <div className="tiny mute">
                    {column.market}/{column.code}
                    {table.periods[index] ? ` · ${table.periods[index]}` : ''}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                {row.values.map((value, index) => (
                  <td className={`num ${row.tones[index] === null ? '' : pnlClass(row.tones[index])}`} key={index}>
                    {value ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
            {table.rows.length === 0 && (
              <tr>
                <td colSpan={columns.length + 1} className="mute">
                  所选标的都没有可用财报数据。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {table.warnings.length > 0 && (
        <ul className="small muted mt-2">
          {table.warnings.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      <div className="tiny mute mt-2">
        金额单位为各标的的报告币种；同比与比率为后端按同期口径算好（跨表不同期时只给绝对额）。
      </div>
    </>
  );
}

export function FinancialComparePage() {
  const [periods, setPeriods] = useState('4');
  const [selected, setSelected] = useState<string[]>([]);

  const assets = useAsync(() => api.assets.list({}), []);
  const watchlist = useAsync(() => api.watchlist.list({}), []);

  const candidates = useMemo<CompareCandidate[]>(() => {
    const out: CompareCandidate[] = [];
    const seen = new Set<string>();
    const push = (item: { name?: string; market: Market; code: string; type: InstrumentType }, group: '持仓' | '标的') => {
      const key = `${item.market}:${item.code}:${item.type}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ key, name: item.name?.trim() || `${item.market}/${item.code}`, market: item.market, code: item.code, type: item.type, group });
    };
    for (const item of assets.data?.items ?? []) push(item, '持仓');
    for (const item of watchlist.data?.items ?? []) push(item, '标的');
    return out;
  }, [assets.data, watchlist.data]);

  // 默认选中前 3 个持仓/标的，避免用户进来看到空白页。
  const active = selected.length > 0 ? selected.filter((key) => candidates.some((item) => item.key === key)) : candidates.slice(0, 3).map((item) => item.key);
  const chosen = candidates.filter((item) => active.includes(item.key)).slice(0, MAX_COMPARE);

  const state = useAsync<FinancialsResponse[]>(
    () =>
      Promise.all(
        chosen.map((item) =>
          api.market.financials({ market: item.market, code: item.code, type: item.type, periods: Number(periods) }),
        ),
      ),
    [chosen.map((item) => item.key).join(','), periods],
  );

  const loadingCandidates = (assets.loading && !assets.data) || (watchlist.loading && !watchlist.data);
  const table = useMemo(() => {
    if (!state.data) return null;
    return buildComparison(chosen.map((item, index) => ({ ...item, data: state.data![index] ?? null })));
  }, [state.data, chosen]);

  const toggle = (key: string) => {
    setSelected((current) => {
      const base = current.length > 0 ? current : candidates.slice(0, 3).map((item) => item.key);
      if (base.includes(key)) return base.filter((item) => item !== key);
      if (base.length >= MAX_COMPARE) return base;
      return [...base, key];
    });
  };

  return (
    <div className="flex" style={{ flexDirection: 'column', gap: 14 }}>
      <Card
        title={
          <span className="center gap-2">
            选择对比标的
            <Badge tone="manual">
              已选 {chosen.length}/{MAX_COMPARE}
            </Badge>
          </span>
        }
        actions={<Segmented value={periods} options={PERIOD_OPTIONS} onChange={setPeriods} />}
      >
        {loadingCandidates && <Loading label="正在读取持仓与标的…" />}
        {!loadingCandidates && candidates.length === 0 && (
          <Empty title="还没有可对比的标的" hint="先在「我的资产」建仓，或在「我的标的」加入候选，这里会自动列出。" />
        )}
        {candidates.length > 0 && (
          <div className="toolbar">
            {candidates.map((item) => {
              const on = active.includes(item.key);
              return (
                <Button
                  key={item.key}
                  size="sm"
                  variant={on ? 'primary' : 'default'}
                  onClick={() => toggle(item.key)}
                  title={`${item.name} · ${item.market}/${item.code}`}
                >
                  {item.group === '持仓' ? '▤' : '☆'} {item.name}
                  <span className="tiny mute">
                    {' '}
                    {item.market}/{item.code}
                  </span>
                </Button>
              );
            })}
          </div>
        )}
        {(assets.error || watchlist.error) && <Alert tone="error">读取持仓/标的失败：{(assets.error ?? watchlist.error)!.message}</Alert>}
      </Card>

      {chosen.length === 0 && candidates.length > 0 && (
        <Card title="财报对比">
          <Empty title="请至少选择一个标的" hint="点上面的标签选择（最多 4 个）。" />
        </Card>
      )}

      {chosen.length > 0 && state.loading && !state.data && (
        <Card title="财报对比">
          <Loading label="正在拉取财报…" />
        </Card>
      )}
      {state.error && (
        <Card title="财报对比">
          <Alert tone="error">{state.error.message}</Alert>
        </Card>
      )}

      {table && (
        <>
          <Card title={`财报对比（${table.periods.filter(Boolean)[0] ?? '—'} 等 ${table.periods.length} 个标的）`}>
            <ComparisonTableView table={table} columns={chosen} />
          </Card>

          {table.periods.some(Boolean) && (
            <Card title="三表明细">
              <div className="tiny mute mb-2">展开任一标的查看利润表 / 资产负债表 / 现金流量表的多期明细。</div>
              {chosen.map((item, index) => (
                <details className="panel mb-2" key={item.key}>
                  <summary className="strong">
                    {item.name}
                    <span className="mono tiny mute"> {item.market}/{item.code}</span>
                  </summary>
                  <div className="mt-2">
                    {state.data?.[index] ? (
                      <FinancialsView
                        data={state.data[index]!}
                        periods={periods}
                        onPeriodsChange={setPeriods}
                        showPeriods={false}
                      />
                    ) : (
                      <Alert tone="warn">未能获取该标的的财报</Alert>
                    )}
                  </div>
                </details>
              ))}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
