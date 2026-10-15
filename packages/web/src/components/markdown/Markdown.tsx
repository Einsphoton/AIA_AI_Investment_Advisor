/**
 * Markdown renderer for AI output — turns agent reports into a scannable,
 * highly visual document. Owner: Lead.
 *
 * Design notes
 * ------------
 * The agent writes structured Markdown (see packages/server/src/agent/prompts.ts);
 * this module is the other half of that contract. Everything is rendered as real
 * React elements — there is no innerHTML anywhere — so an injected tag shows up
 * as text instead of executing.
 *
 * Blocks are deliberately NOT rendered 1:1 to their Markdown meaning. They are
 * rendered to whatever reads best, which is what makes these reports scannable:
 *
 *   ## 一、估值与价格        → section header：编号徽标 + 语义图标
 *   ## 名称｜角色：…          → 主标题 + 副标题胶囊
 *   **结论**：入选。…         → 结论卡（带 入选 / 回避 判定胶囊）
 *   **主要风险**：…           → 风险卡（红色导轨）
 *   **目标价**：25.00 CNY     → 目标卡（绿色导轨）
 *   | 指标 | 数值 |（两列）    → 指标卡面板（表格会浪费宽度，且表头默认居中）
 *   | a | b | c |（≥三列）     → 数据表：表头与列对齐、斑马纹、数值右对齐、内联柱
 *   > …                      → 引用提示块
 *   ```chart                  → 真实 ECharts 图表
 *   ```metrics                → 指标卡面板
 *   **+12.4%**               → 带底色的涨跌胶囊
 *   3.50 倍 / 22.18 CNY      → 语义数字着色（红涨绿跌）
 */
import { useMemo, type ReactNode } from 'react';
import { CHART_COLORS, EChart, baseAxisStyle, goldTooltipStyle, type EChartsCoreOption } from '../charts/EChart';
import {
  extractMetrics,
  isKvTable,
  parseInline,
  parseMarkdown,
  plainText,
  percentOf,
  toneOf,
  type Block,
  type ChartSpec,
  type Inline,
  type Metric,
} from './parse';

export interface MarkdownProps {
  text: string | null | undefined;
  /** 'compact' tightens spacing for chat bubbles and narrow side panels. */
  variant?: 'report' | 'compact';
  /** Render the auto-extracted KPI strip (default: true for reports). */
  metrics?: boolean;
  /**
   * Split long reports into two columns on wide screens (>=1400px). The KPI
   * strip stays full width above the columns.
   */
  columns?: boolean;
  className?: string;
}

export function Markdown({ text, variant = 'report', metrics, columns = false, className = '' }: MarkdownProps) {
  const source = text ?? '';
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const strip = useMemo(
    () => (metrics ?? variant === 'report' ? extractMetrics(blocks) : []),
    [blocks, metrics, variant],
  );

  if (!source.trim()) return null;

  return (
    <div className={`md md-${variant} ${className}`}>
      {strip.length > 0 && <MetricStrip items={strip} />}
      <div className={`md-flow${columns ? ' md-flow-cols' : ''}`}>
        {blocks.map((block, index) => (
          <BlockView key={index} block={block} lead={index === 0} />
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────── KPI strip ───────────────────────────────── */

export function MetricStrip({ items }: { items: Metric[] }) {
  return (
    <div className="md-metrics" role="list">
      {items.map((item, index) => (
        <div className={`md-metric tone-${item.tone}`} role="listitem" key={item.label + index}>
          <div className="md-metric-label" title={item.label}>
            {item.label}
          </div>
          <div className="md-metric-value">{item.value}</div>
          {item.hint && <div className="md-metric-hint">{item.hint}</div>}
          {item.pct !== null && <MiniBar pct={item.pct} tone={item.tone} />}
        </div>
      ))}
    </div>
  );
}

/** 0-100% bar; values above 100 are clamped but still shown in the label. */
function MiniBar({ pct, tone }: { pct: number; tone: Metric['tone'] }) {
  const width = Math.min(100, Math.abs(pct));
  return (
    <div className={`md-mini-bar tone-${tone}`} aria-hidden="true">
      <span style={{ width: width + '%' }} />
    </div>
  );
}

/* ─────────────────────────── semantic vocabulary ─────────────────────────── */

const HEADING_ICONS: { test: RegExp; icon: string }[] = [
  { test: /风险|警告|注意|回撤|止损|失效/, icon: '⚠' },
  { test: /结论|总结|判断|评级|观点/, icon: '◆' },
  { test: /建议|操作|策略|行动|下一步/, icon: '➤' },
  { test: /机会|亮点|催化|增长点/, icon: '✦' },
  { test: /估值|价格|目标价|收益/, icon: '◎' },
  { test: /基本面|财务|业绩|盈利/, icon: '▤' },
  { test: /技术|趋势|量价|形态/, icon: '∿' },
  { test: /数据|指标|参数/, icon: '▦' },
  { test: /角色|定位|组合/, icon: '◈' },
  { test: /行业|事件|资讯|消息/, icon: '☰' },
];

function headingIcon(text: string): string | null {
  for (const entry of HEADING_ICONS) if (entry.test.test(text)) return entry.icon;
  return null;
}

/** 段落/引用块左上角标签 → 视觉语义。 */
const CALLOUT_TONES: { test: RegExp; tone: string; icon: string }[] = [
  { test: /结论|总结|判断|评级|观点/, tone: 'verdict', icon: '◆' },
  { test: /建议|操作|行动|策略|下一步/, tone: 'verdict', icon: '➤' },
  { test: /风险|失效|警告|注意|数据缺失|不确定/, tone: 'risk', icon: '⚠' },
  { test: /目标价|预期收益|收益|估值|价格/, tone: 'target', icon: '◎' },
  { test: /依据|理由|逻辑|基本面|角色|催化|事件|行业|分红/, tone: 'info', icon: '▤' },
];

function calloutTone(text: string): { tone: string; icon: string } | null {
  for (const entry of CALLOUT_TONES) if (entry.test.test(text)) return entry;
  return null;
}

/** 结论里的操作动词 → 判定胶囊。 */
const VERDICTS: { test: RegExp; tone: string }[] = [
  { test: /^(买入|增持|推荐|入选|加仓|正面|持有)/, tone: 'buy' },
  { test: /^(卖出|减持|回避|不买入|不入选|不推荐|清仓|负面)/, tone: 'sell' },
  { test: /^(观望|中性|谨慎|等待)/, tone: 'neutral' },
];

function verdictOf(nodes: Inline[]): { text: string; tone: string } | null {
  const text = plainText(nodes).replace(/^[\s：:。，,、]+/, '');
  for (const rule of VERDICTS) {
    const match = rule.test.exec(text);
    if (match) return { text: match[1]!, tone: rule.tone };
  }
  return null;
}

/** 纯涨跌幅（**+12.4%**）渲染成带底色的胶囊。 */
const DELTA_TEXT = /^[+\-−]?\d[\d,]*(?:\.\d+)?\s*[%％]$/;

/** 标题里的编号：「一、」「3.」「（2）」→ 编号徽标。 */
function splitEnumerator(text: string): { badge: string | null; body: string } {
  const match = /^\s*([一二三四五六七八九十]{1,3}|\d{1,2})\s*[、.．)）]\s*/.exec(text);
  if (!match) return { badge: null, body: text };
  return { badge: match[1]!, body: text.slice(match[0].length) };
}

/** 「名称｜角色：…」→ 主标题 + 副标题胶囊。 */
function splitSubtitle(text: string): { title: string; subs: string[] } {
  const parts = text
    .split(/[｜|]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) return { title: text, subs: [] };
  return { title: parts[0]!, subs: parts.slice(1) };
}

/** 段落以「**标签**：正文」开头时，拆出标签与正文。 */
function parseCallout(nodes: Inline[]): { label: string; tone: string; icon: string; body: Inline[] } | null {
  const first = nodes[0];
  if (!first || first.kind !== 'strong') return null;
  const label = plainText(first.children).trim();
  if (!label || label.length > 14) return null;
  const next = nodes[1];
  if (!next || next.kind !== 'text') return null;
  const separator = /^\s*[：:。，,、]\s*/.exec(next.value);
  if (!separator) return null;
  const entry = calloutTone(label);
  if (!entry) return null;

  const body: Inline[] = [];
  const remainder = next.value.slice(separator[0].length);
  if (remainder) body.push({ kind: 'text', value: remainder });
  body.push(...nodes.slice(2));
  if (body.length === 0) return null;
  return { label, tone: entry.tone, icon: entry.icon, body };
}

/** 列表项以「**标签**：正文」开头 → 标签单独着色。 */
function splitListLabel(nodes: Inline[]): { label: Inline; rest: Inline[] } | null {
  const first = nodes[0];
  if (!first || first.kind !== 'strong') return null;
  const label = plainText(first.children).trim();
  if (!label || label.length > 12) return null;
  const next = nodes[1];
  if (!next || next.kind !== 'text' || !/^\s*[：:]/.test(next.value)) return null;
  return { label: first, rest: nodes.slice(1) };
}

/* ──────────────────────────────── blocks ─────────────────────────────────── */

function BlockView({ block, lead = false }: { block: Block; lead?: boolean }) {
  switch (block.kind) {
    case 'heading':
      return <HeadingView block={block} lead={lead} />;
    case 'paragraph':
      return <ParagraphView nodes={block.children} />;
    case 'list':
      return <ListView block={block} lead={lead} />;
    case 'table':
      return isKvTable(block) ? <KvTable block={block} /> : <DataTable block={block} />;
    case 'quote':
      return <QuoteView block={block} />;
    case 'code':
      return (
        <div className="md-code-wrap">
          {block.lang && <div className="md-code-lang">{block.lang}</div>}
          <pre className="md-code">
            <code>{block.value}</code>
          </pre>
        </div>
      );
    case 'metrics':
      return <MetricStrip items={block.items} />;
    case 'chart':
      return block.spec ? <ChartBlock spec={block.spec} /> : <RawFallback raw={block.raw} />;
    case 'hr':
      return <hr className="md-hr" />;
  }
}

function BlockList({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} lead={index === 0} />
      ))}
    </>
  );
}

/* ──────────────────────────────── headings ───────────────────────────────── */

function HeadingView({ block, lead }: { block: Extract<Block, { kind: 'heading' }>; lead: boolean }) {
  const source = plainText(block.children);
  const level = Math.min(4, Math.max(1, block.level));
  const { badge, body } = splitEnumerator(source);
  const { title, subs } = splitSubtitle(body);
  const icon = headingIcon(title) ?? (badge ? null : headingIcon(body));
  const Tag = (`h${level}`) as 'h1' | 'h2' | 'h3' | 'h4';
  const headingTone = level <= 2 ? calloutTone(title)?.tone : undefined;
  const classes = [
    'md-h',
    `md-h${level}`,
    lead && level <= 2 ? 'md-h-lead' : '',
    headingTone ? `tone-${headingTone}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Tag className={classes}>
      <span className="md-h-line">
        {badge ? (
          <span className="md-h-badge" aria-hidden="true">
            {badge}
          </span>
        ) : (
          icon && (
            <span className="md-h-icon" aria-hidden="true">
              {icon}
            </span>
          )
        )}
        <span className="md-h-title">{renderInline(parseInline(title))}</span>
      </span>
      {subs.length > 0 && (
        <span className="md-h-sub">
          {subs.map((sub, index) => (
            <span className="md-h-subitem" key={index}>
              {sub}
            </span>
          ))}
        </span>
      )}
    </Tag>
  );
}

/* ─────────────────────────────── paragraphs ──────────────────────────────── */

function ParagraphView({ nodes }: { nodes: Inline[] }) {
  const callout = parseCallout(nodes);
  if (!callout) return <p className="md-p">{renderInline(nodes)}</p>;

  const verdict = verdictOf(callout.body);
  return (
    <div className={`md-callout tone-${callout.tone}`}>
      <div className="md-callout-head">
        <span className="md-callout-icon" aria-hidden="true">
          {callout.icon}
        </span>
        <span className="md-callout-label">{callout.label}</span>
        {verdict && <span className={`md-verdict tone-${verdict.tone}`}>{verdict.text}</span>}
      </div>
      <div className="md-callout-body">{renderInline(callout.body)}</div>
    </div>
  );
}

/* ───────────────────────────────── lists ─────────────────────────────────── */

function ListView({ block, lead }: { block: Extract<Block, { kind: 'list' }>; lead: boolean }) {
  const Tag = block.ordered ? 'ol' : 'ul';
  return (
    <Tag className={'md-list' + (lead ? ' md-list-lead' : '')}>
      {block.items.map((item, index) => {
        const labelled = splitListLabel(item.children);
        return (
          <li key={index}>
            {labelled ? (
              <>
                <span className="md-li-label">{renderInline([labelled.label])}</span>
                {renderInline(labelled.rest)}
              </>
            ) : (
              renderInline(item.children)
            )}
            {item.sub.length > 0 && <BlockList blocks={item.sub} />}
          </li>
        );
      })}
    </Tag>
  );
}

/* ──────────────────────────────── kv panel ───────────────────────────────── */

/**
 * 两列短值表格 → 指标卡面板。
 *
 * 这是 AI 报告里最常见的表格形状（| 指标 | 数值 |）。做成卡片后既避免
 * 「表头默认居中、和数值对不齐」的老问题，也能给百分比加迷你条、给涨跌加胶囊。
 */
function KvTable({ block }: { block: Extract<Block, { kind: 'table' }> }) {
  return (
    <div className="md-kv">
      {block.rows.map((row, index) => {
        const label = plainText(row[0] ?? []).trim();
        const value = plainText(row[1] ?? []).trim();
        const pct = percentOf(value);
        const leadsWithPct = /^\s*(?:约|近|超)?\s*[+\-−]?\d[\d,]*(?:\.\d+)?\s*[%％]/.test(value);
        // 长值独占整行，短值走卡片栅格：同一张表里两种排布都不会挤。
        const wide = value.length > 30 ? ' md-kv-item-wide' : '';
        return (
          <div className={`md-kv-item tone-${toneOf(value)}${wide}`} key={label + index}>
            <div className="md-kv-label" title={label}>
              {label}
            </div>
            <div className="md-kv-value">{renderInline(row[1] ?? [])}</div>
            {pct !== null && leadsWithPct && Math.abs(pct) <= 100 && <MiniBar pct={pct} tone={toneOf(value)} />}
          </div>
        );
      })}
    </div>
  );
}

/* ──────────────────────────────── data table ─────────────────────────────── */

function DataTable({ block }: { block: Extract<Block, { kind: 'table' }> }) {
  // 对齐规则：分隔行显式声明优先；否则数值列右对齐（与应用内 .data-table 一致）。
  const aligns = block.header.map((_, column) => {
    const explicit = block.aligns[column] ?? 'left';
    if (explicit !== 'left') return explicit;
    return block.numeric[column] ? 'right' : 'left';
  });

  const scales = block.numeric.map((isNumeric, column) => {
    if (!isNumeric) return 0;
    return block.rows.reduce((max, row) => {
      const value = Math.abs(Number.parseFloat(plainText(row[column] ?? []).replace(/[,\s%％]/g, '')) || 0);
      return Math.max(max, value);
    }, 0);
  });

  return (
    <div className="md-table-wrap">
      <table className="md-table">
        <thead>
          <tr>
            {block.header.map((cell, index) => (
              <th key={index} className={`align-${aligns[index]}`}>
                {renderInline(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, column) => {
                const scale = scales[column] ?? 0;
                const value = scale > 0 ? Math.abs(Number.parseFloat(plainText(cell).replace(/[,\s%％]/g, '')) || 0) : 0;
                const width = scale > 0 ? Math.max(3, (value / scale) * 100) : 0;
                return (
                  <td key={column} className={`align-${aligns[column]}${scale > 0 ? ' num' : ''}`}>
                    {scale > 0 && <span className="md-bar-fill" style={{ width: width + '%' }} aria-hidden="true" />}
                    <span className="md-cell">{renderInline(cell)}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ──────────────────────────────── quotes ─────────────────────────────────── */

function QuoteView({ block }: { block: Extract<Block, { kind: 'quote' }> }) {
  const text = plainText(
    block.blocks.flatMap((inner) => (inner.kind === 'paragraph' || inner.kind === 'heading' ? inner.children : [])),
  );
  const entry = calloutTone(text);
  const tone = entry?.tone ?? 'info';
  return (
    <blockquote className={`md-quote tone-${tone}`}>
      <span className="md-quote-icon" aria-hidden="true">
        {entry?.icon ?? '❞'}
      </span>
      <div className="md-quote-body">
        <BlockList blocks={block.blocks} />
      </div>
    </blockquote>
  );
}

/* ──────────────────────────────── charts ─────────────────────────────────── */

function chartOption(spec: ChartSpec): EChartsCoreOption {
  const palette = [CHART_COLORS.gold, CHART_COLORS.line2, CHART_COLORS.up, CHART_COLORS.down];
  const axis = baseAxisStyle();
  return {
    color: palette,
    grid: { left: 6, right: 14, top: spec.title ? 40 : 16, bottom: 4, containLabel: true },
    tooltip: { trigger: 'axis', ...goldTooltipStyle() },
    legend:
      spec.series.length > 1
        ? { top: 4, right: 4, textStyle: { color: CHART_COLORS.text, fontSize: 11 }, data: spec.series.map((item) => item.name) }
        : undefined,
    xAxis: {
      type: 'category',
      data: spec.categories,
      ...axis,
      axisLabel: { color: CHART_COLORS.text, fontSize: 11, hideOverlap: true },
    },
    yAxis: { type: 'value', ...axis },
    series: spec.series.map((item, index) => ({
      name: item.name,
      type: spec.type,
      data: item.data,
      smooth: spec.type === 'line',
      symbolSize: 6,
      barMaxWidth: 34,
      itemStyle: { color: palette[index % palette.length], borderRadius: spec.type === 'bar' ? [4, 4, 0, 0] : 0 },
      lineStyle: { width: 2 },
    })),
    animationDuration: 420,
  } as EChartsCoreOption;
}

function ChartBlock({ spec }: { spec: ChartSpec }) {
  return (
    <figure className="md-chart">
      {spec.title && <figcaption className="md-chart-title">{spec.title}</figcaption>}
      <EChart option={chartOption(spec)} className="chart chart-md" resetKey={spec.title ?? spec.type} />
    </figure>
  );
}

/** Malformed chart fences still show their payload instead of vanishing. */
function RawFallback({ raw }: { raw: string }) {
  return (
    <div className="md-code-wrap">
      <div className="md-code-lang">chart（JSON 解析失败）</div>
      <pre className="md-code">
        <code>{raw}</code>
      </pre>
    </div>
  );
}

/* ──────────────────────────────── inline ─────────────────────────────────── */

export function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => <InlineView key={index} node={node} />);
}

function InlineView({ node }: { node: Inline }) {
  switch (node.kind) {
    case 'text':
      return <>{node.value}</>;
    case 'strong': {
      // 加粗的纯涨跌幅 → 带底色的胶囊，比单纯的红色粗体更醒目。
      const text = plainText(node.children).trim();
      if (DELTA_TEXT.test(text)) {
        return <span className={`md-chip tone-${toneOf(text)}`}>{renderInline(node.children)}</span>;
      }
      return <strong className="md-strong">{renderInline(node.children)}</strong>;
    }
    case 'em':
      return <em className="md-em">{renderInline(node.children)}</em>;
    case 'del':
      return <del className="md-del">{renderInline(node.children)}</del>;
    case 'code':
      return <code className="md-inline-code">{node.value}</code>;
    case 'link':
      return (
        <a className="md-link" href={node.href} target="_blank" rel="noreferrer noopener">
          {renderInline(node.children)}
        </a>
      );
    case 'num':
      return <span className={`md-num tone-${node.tone}`}>{node.value}</span>;
  }
}
