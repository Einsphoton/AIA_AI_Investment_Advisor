/**
 * Zero-dependency Markdown parser for AI-generated reports. Owner: Lead.
 *
 * Why hand-rolled instead of a markdown package: this project builds with a
 * pure-JS toolchain and must run in restricted/offline environments, so the
 * renderer cannot add runtime dependencies. The subset below is exactly what
 * the agent is instructed to emit (see packages/server/src/agent/prompts.ts):
 * headings, paragraphs, lists, GFM tables, blockquotes, fenced code and rules.
 *
 * Safety: the parser never produces HTML strings. Every piece of model output
 * becomes a React text node, so a script tag inside a report renders as literal
 * text instead of executing (Markdown.tsx uses no dangerouslySetInnerHTML).
 */

export type Tone = 'pos' | 'neg' | 'flat' | 'accent';

/** Inline node kinds produced by the inline scanner. */
export type Inline =
  | { kind: 'text'; value: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'del'; children: Inline[] }
  | { kind: 'code'; value: string }
  | { kind: 'link'; href: string; children: Inline[] }
  /** A number that carries meaning: signed value, percentage or unit-tagged. */
  | { kind: 'num'; value: string; tone: Tone; pct: number | null };

export type Align = 'left' | 'center' | 'right';

export interface ListItem {
  children: Inline[];
  /** Nested blocks (indented sub-list / continuation). */
  sub: Block[];
}

export interface Metric {
  label: string;
  value: string;
  tone: Tone;
  /** Filled when the value is a percentage — drives the mini bar. */
  pct: number | null;
  hint?: string;
}

export interface ChartSeries {
  name: string;
  data: number[];
}

export interface ChartSpec {
  type: 'bar' | 'line';
  title?: string;
  categories: string[];
  series: ChartSeries[];
}

export type Block =
  | { kind: 'heading'; level: number; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: ListItem[] }
  | { kind: 'table'; header: Inline[][]; rows: Inline[][][]; aligns: Align[]; numeric: boolean[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'code'; lang: string; value: string }
  | { kind: 'metrics'; items: Metric[] }
  | { kind: 'chart'; spec: ChartSpec | null; raw: string }
  | { kind: 'hr' };

/* ────────────────────────────── block parsing ─────────────────────────────── */

const RE_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_FENCE = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/;
const RE_HR = /^\s*(?:[-*_]\s*){3,}$/;
const RE_QUOTE = /^\s*>\s?(.*)$/;
const RE_LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const RE_TABLE_DELIM = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Splits a table row into trimmed cells, honouring escaped pipes. */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let buffer = '';
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    if (char === '\\' && trimmed[index + 1] === '|') {
      buffer += '|';
      index += 1;
      continue;
    }
    if (char === '|') {
      cells.push(buffer.trim());
      buffer = '';
      continue;
    }
    buffer += char;
  }
  cells.push(buffer.trim());
  return cells;
}

function alignOf(cell: string): Align {
  const text = cell.trim();
  const left = text.startsWith(':');
  const right = text.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

/** 12.5% / 1,280 → number; anything else → null. Used for table bar charts. */
export function numericValue(text: string): number | null {
  const cleaned = text.replace(/[,\s]/g, '').replace(/[%％]$/, '');
  if (!/^[+\-−]?\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number.parseFloat(cleaned.replace('−', '-'));
  return Number.isFinite(value) ? value : null;
}

export function plainText(nodes: Inline[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
      case 'code':
      case 'num':
        out += node.value;
        break;
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
        out += plainText(node.children);
        break;
    }
  }
  return out;
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  if (!line.trim()) return true;
  if (RE_FENCE.test(line) || RE_HEADING.test(line) || RE_HR.test(line) || RE_QUOTE.test(line) || RE_LIST.test(line)) {
    return true;
  }
  if (line.includes('|') && RE_TABLE_DELIM.test(lines[index + 1] ?? '')) return true;
  return false;
}

export function parseMarkdown(source: string): Block[] {
  const lines = (source ?? '').replace(/\r\n?/g, '\n').split('\n');
  return parseBlocks(lines, 0, lines.length);
}

function parseBlocks(lines: string[], start: number, end: number): Block[] {
  const blocks: Block[] = [];
  let index = start;

  while (index < end) {
    const line = lines[index]!;

    if (!line.trim()) {
      index += 1;
      continue;
    }

    // fenced code -------------------------------------------------------
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const lang = (fence[2] ?? '').toLowerCase();
      const body: string[] = [];
      index += 1;
      const close = new RegExp('^\\s*' + marker[0]!.repeat(3) + '\\s*$');
      // Unterminated fences are normal while a reply is still streaming: treat
      // the remaining lines as code so the UI never loses text.
      while (index < end && !close.test(lines[index]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      if (index < end) index += 1;
      blocks.push(fencedBlock(lang, body.join('\n')));
      continue;
    }

    // horizontal rule ---------------------------------------------------
    if (RE_HR.test(line)) {
      blocks.push({ kind: 'hr' });
      index += 1;
      continue;
    }

    // heading -----------------------------------------------------------
    const heading = RE_HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, children: parseInline(heading[2] ?? '') });
      index += 1;
      continue;
    }

    // bold-only line → pseudo heading -------------------------------------
    // 模型经常用 **一、组合结构** 单独成行代替 ## 标题；识别出来才能形成目录感。
    const boldLine = /^\s*(\*\*|__)(.{1,60}?)\1\s*$/.exec(line);
    if (boldLine && !/[。！？]/.test(boldLine[2]!)) {
      blocks.push({ kind: 'heading', level: 3, children: parseInline(boldLine[2]!) });
      index += 1;
      continue;
    }

    // table -------------------------------------------------------------
    if (line.includes('|') && RE_TABLE_DELIM.test(lines[index + 1] ?? '')) {
      const headerCells = splitRow(line);
      const aligns = splitRow(lines[index + 1]!).map(alignOf);
      index += 2;
      const rows: string[][] = [];
      while (index < end && lines[index]!.includes('|') && lines[index]!.trim()) {
        rows.push(splitRow(lines[index]!));
        index += 1;
      }
      const width = headerCells.length;
      const header = headerCells.map((cell) => parseInline(cell));
      const body = rows.map((row) => {
        const cells = row.slice(0, width);
        while (cells.length < width) cells.push('');
        return cells.map((cell) => parseInline(cell));
      });
      const numeric = headerCells.map((_, column) => {
        const values = body.map((row) => plainText(row[column] ?? [])).filter((text) => text.trim().length > 0);
        return values.length > 0 && values.every((text) => numericValue(text) !== null);
      });
      blocks.push({ kind: 'table', header, rows: body, aligns, numeric });
      continue;
    }

    // blockquote --------------------------------------------------------
    if (RE_QUOTE.test(line)) {
      const inner: string[] = [];
      while (index < end && RE_QUOTE.test(lines[index]!)) {
        inner.push(RE_QUOTE.exec(lines[index]!)![1] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'quote', blocks: parseBlocks(inner, 0, inner.length) });
      continue;
    }

    // list --------------------------------------------------------------
    if (RE_LIST.test(line)) {
      const parsed = parseList(lines, index, end);
      blocks.push(parsed.list);
      index = parsed.next;
      continue;
    }

    // paragraph ---------------------------------------------------------
    const paragraph: string[] = [];
    while (index < end && !isBlockStart(lines, index)) {
      paragraph.push(lines[index]!.trim());
      index += 1;
    }
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join(' ')) });
    } else {
      // Defensive: never spin forever on an unexpected line shape.
      index += 1;
    }
  }

  return blocks;
}

/** Parses one list run, grouping nested indentation into child blocks. */
function parseList(lines: string[], start: number, end: number): { list: Block; next: number } {
  const first = RE_LIST.exec(lines[start]!)!;
  const baseIndent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const items: ListItem[] = [];
  let index = start;

  while (index < end) {
    const match = RE_LIST.exec(lines[index]!);
    if (!match) break;
    const indent = match[1]!.length;
    const markerOrdered = /\d/.test(match[2]!);
    // A different marker style at the same level starts a new list.
    if (indent < baseIndent || indent > baseIndent) break;
    if (markerOrdered !== ordered) break;

    const children = parseInline(match[3] ?? '');
    index += 1;

    // Collect indented continuation lines (nested list / wrapped text).
    const nested: string[] = [];
    while (index < end) {
      const line = lines[index]!;
      if (!line.trim()) {
        // A blank line only continues the list when the next line is indented.
        const next = lines[index + 1] ?? '';
        if (next.trim() && next.search(/\S/) > baseIndent) {
          nested.push('');
          index += 1;
          continue;
        }
        break;
      }
      const nestedMatch = RE_LIST.exec(line);
      const indentNext = nestedMatch ? nestedMatch[1]!.length : line.search(/\S/);
      if (indentNext > baseIndent) {
        nested.push(line.slice(Math.min(line.length, baseIndent + 2)));
        index += 1;
        continue;
      }
      break;
    }

    const sub = nested.length > 0 ? parseBlocks(nested, 0, nested.length) : [];
    items.push({ children, sub });
  }

  return { list: { kind: 'list', ordered, items }, next: index };
}

/** Turns a fenced block into a structured block (metrics / chart / code). */
function fencedBlock(lang: string, value: string): Block {
  if (lang === 'metrics' || lang === 'kpi') {
    return { kind: 'metrics', items: parseMetricsBlock(value) };
  }
  if (lang === 'chart' || lang === 'echarts') {
    return { kind: 'chart', spec: parseChartSpec(value), raw: value };
  }
  return { kind: 'code', lang, value };
}

/**
 * metrics fence body — one metric per line, pipe separated:
 *   市盈率(PE) | 28.4 倍 | 行业 22.1 倍
 *   预期收益 | +12.4%
 */
export function parseMetricsBlock(value: string): Metric[] {
  const items: Metric[] = [];
  for (const rawLine of value.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    const label = cells[0] ?? '';
    const text = cells[1] ?? '';
    if (!label || !text) continue;
    items.push(metricFrom(label, text, cells[2] || undefined));
  }
  return items.slice(0, 12);
}

function metricFrom(label: string, value: string, hint?: string): Metric {
  const pct = percentOf(value);
  const tone = toneOf(value);
  return { label: cleanLabel(label), value: value.trim(), tone, pct, ...(hint ? { hint } : {}) };
}

export function percentOf(value: string): number | null {
  const match = /([+\-−]?\d[\d,]*(?:\.\d+)?)\s*[%％]/.exec(value);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1]!.replace(/,/g, '').replace('−', '-'));
  return Number.isFinite(parsed) ? parsed : null;
}

export function toneOf(value: string): Tone {
  const trimmed = value.trim();
  if (/^[+\-−]/.test(trimmed)) return trimmed.startsWith('-') || trimmed.startsWith('−') ? 'neg' : 'pos';
  if (/(增持|上涨|买入|上调|超预期|增长|流入|利好)/.test(trimmed)) return 'pos';
  if (/(减持|下跌|卖出|下调|低于|流出|亏损|利空)/.test(trimmed)) return 'neg';
  if (/[%％倍]/.test(trimmed)) return 'accent';
  if (/(?:美元|港元|港币|人民币|元|CNY|USD|HKD|EUR)$/.test(trimmed)) return 'accent';
  return 'flat';
}

function cleanLabel(label: string): string {
  return label.replace(/[*_`]/g, '').replace(/^[\s\-•·]+/, '').replace(/[：:]\s*$/, '').trim();
}

/** Parses the JSON payload of a chart fence; null when it is malformed. */
export function parseChartSpec(value: string): ChartSpec | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = parsed as Record<string, unknown>;
  const type = raw.type === 'line' ? 'line' : raw.type === 'bar' ? 'bar' : null;
  const categories = Array.isArray(raw.categories) ? raw.categories.map((item) => String(item)) : null;
  if (!type || !categories || categories.length === 0) return null;

  const seriesInput = Array.isArray(raw.series) ? raw.series : [];
  const series: ChartSeries[] = [];
  for (const entry of seriesInput) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    if (!Array.isArray(item.data)) continue;
    const data = item.data.map((point) => (typeof point === 'number' ? point : Number.parseFloat(String(point))));
    if (data.some((point) => !Number.isFinite(point))) continue;
    series.push({ name: String(item.name ?? '数值'), data: data as number[] });
  }
  if (series.length === 0) return null;
  return {
    type,
    categories,
    series,
    ...(typeof raw.title === 'string' && raw.title.trim() ? { title: raw.title.trim() } : {}),
  };
}

/* ────────────────────────────── inline parsing ────────────────────────────── */

const BOUNDARY_BEFORE = /[\s(（[【:：,，、=<>~*|>]|^$/;

/** A number is only highlighted when it carries a sign, a unit or a percent. */
function matchNumber(text: string, index: number): { node: Inline; next: number } | null {
  const previous = index === 0 ? '' : text[index - 1]!;
  if (previous && !BOUNDARY_BEFORE.test(previous)) return null;
  const rest = text.slice(index);
  const match = /^([+\-−]?\d[\d,]*(?:\.\d+)?)(\s*)([%％]|美元|港元|港币|人民币|亿元|万元|元|万|亿|倍|点|股|CNY|USD|HKD|EUR)?/.exec(rest);
  if (!match) return null;
  const digits = match[1]!;
  const unit = match[3] ?? '';
  const signed = /^[+\-−]/.test(digits);
  // Bare numbers stay plain text: highlighting every integer makes reports noisy.
  if (!unit && !signed) return null;
  const value = digits + (unit ? (match[2] ?? '') + unit : '');
  const pct = percentOf(value);
  return { node: { kind: 'num', value, tone: toneOf(value), pct }, next: index + value.length };
}

export function parseInline(text: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buffer = '';
  let index = 0;

  const flush = (): void => {
    if (buffer) {
      out.push({ kind: 'text', value: buffer });
      buffer = '';
    }
  };

  while (index < text.length) {
    const char = text[index]!;

    // inline code
    if (char === '`') {
      const close = text.indexOf('`', index + 1);
      if (close > index + 1) {
        flush();
        out.push({ kind: 'code', value: text.slice(index + 1, close) });
        index = close + 1;
        continue;
      }
    }

    // strong
    if (depth < 6 && ((char === '*' && text[index + 1] === '*') || (char === '_' && text[index + 1] === '_'))) {
      const marker = char + char;
      const close = text.indexOf(marker, index + 2);
      if (close > index + 2) {
        flush();
        out.push({ kind: 'strong', children: parseInline(text.slice(index + 2, close), depth + 1) });
        index = close + 2;
        continue;
      }
    }

    // strikethrough
    if (depth < 6 && char === '~' && text[index + 1] === '~') {
      const close = text.indexOf('~~', index + 2);
      if (close > index + 2) {
        flush();
        out.push({ kind: 'del', children: parseInline(text.slice(index + 2, close), depth + 1) });
        index = close + 2;
        continue;
      }
    }

    // emphasis
    if (depth < 6 && (char === '*' || char === '_')) {
      const close = text.indexOf(char, index + 1);
      const next = text[index + 1] ?? '';
      if (close > index + 1 && next && !/\s/.test(next) && text[close - 1] !== ' ') {
        flush();
        out.push({ kind: 'em', children: parseInline(text.slice(index + 1, close), depth + 1) });
        index = close + 1;
        continue;
      }
    }

    // link
    if (depth < 6 && char === '[') {
      const close = text.indexOf(']', index + 1);
      if (close > index && text[close + 1] === '(') {
        const paren = text.indexOf(')', close + 2);
        if (paren > close) {
          const href = text.slice(close + 2, paren).trim();
          if (href && !/^\s*javascript:/i.test(href)) {
            flush();
            out.push({ kind: 'link', href, children: parseInline(text.slice(index + 1, close), depth + 1) });
            index = paren + 1;
            continue;
          }
        }
      }
    }

    // numbers / percentages
    const number = matchNumber(text, index);
    if (number) {
      flush();
      out.push(number.node);
      index = number.next;
      continue;
    }

    buffer += char;
    index += 1;
  }

  flush();
  return out;
}

/* ───────────────────────────── metric extraction ──────────────────────────── */

/**
 * Pulls the report's headline numbers into a visual KPI strip.
 *
 * Works on parsed blocks (not raw text) so bold/list/table markup never leaks
 * into a label. Only entries whose value actually contains a digit qualify —
 * prose like 趋势：均线多头排列 stays in the body where it belongs.
 */
export function extractMetrics(blocks: Block[], limit = 8): Metric[] {
  const out: Metric[] = [];
  const seen = new Set<string>();

  const push = (label: string, value: string, hint?: string): void => {
    const clean = cleanLabel(label);
    if (!clean || clean.length > 16 || seen.has(clean)) return;
    const firstDigit = value.search(/\d/);
    if (firstDigit < 0) return;
    if (value.length > 24) return;
    // A KPI value starts with its number ("72%", "128.5 元"). When the digits
    // only appear late the line is prose with a number in it, so keep it in
    // the body where it reads in context.
    if (firstDigit > Math.max(2, value.length * 0.5)) return;
    seen.add(clean);
    out.push(metricFrom(clean, value, hint));
  };

  for (const block of blocks) {
    if (out.length >= limit) break;
    if (block.kind === 'metrics') {
      for (const item of block.items) push(item.label, item.value, item.hint);
      continue;
    }
    if (block.kind === 'table') {
      // 两列短值表格会渲染成指标卡面板（KvGrid）并自带可视化，不再重复进顶部指标条。
      if (block.header.length === 2 && !isKvTable(block)) {
        for (const row of block.rows) push(plainText(row[0] ?? []), plainText(row[1] ?? []));
      }
      continue;
    }
    const lines: Inline[][] = [];
    if (block.kind === 'paragraph') lines.push(block.children);
    if (block.kind === 'list') for (const item of block.items) lines.push(item.children);
    for (const nodes of lines) {
      const text = plainText(nodes);
      const match = /^([^：:]{1,16})[：:]\s*(.+)$/.exec(text.trim());
      if (match) push(match[1]!, match[2]!);
    }
  }

  // 第二遍：逐句找「标签 数值」片段，覆盖没有冒号、整段叙述的旧报告。
  const prose: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'paragraph') prose.push(plainText(block.children));
    else if (block.kind === 'list') for (const item of block.items) prose.push(plainText(item.children));
  }
  for (const text of prose) {
    if (out.length >= limit) break;
    for (const piece of text.split(/[；;。、/：:\n]/)) {
      if (out.length >= limit) break;
      const metric = fragmentMetric(piece);
      if (metric) push(metric.label, metric.value, metric.hint);
    }
  }

  return out.slice(0, limit);
}

/**
 * Sentence-fragment KPI matcher.
 *
 * Legacy / free-form reports pack everything into one paragraph
 * (`现价 22.18 CNY、-1.25%；PE 28.99 …`), which has no `label：value` line for
 * the primary extractor to find. This matches a *whole* short fragment —
 * label + optional filler + number + optional unit — so a number buried
 * mid-sentence can never be mistaken for a KPI.
 */
const FRAGMENT_FILLER = '约|近|为|是|报|达|仅|已|降至|升至|剩余|已用|合计|共计|最多|至少';
const FRAGMENT_METRIC = new RegExp(
  '^([A-Za-z\\u4e00-\\u9fa5()（）/.]{2,10})\\s*(?:' +
    FRAGMENT_FILLER +
    ')?\\s*[:：]?\\s*([+\\-−]?\\d[\\d,]*(?:\\.\\d+)?)\\s*([%％]|美元|港元|港币|人民币|亿元|万元|元|万|亿|倍|CNY|USD|HKD|EUR)?\\s*(?:[（(][^）)]{0,28}[）)])?$',
);
const FRAGMENT_LABEL_STOP = /[的了和与或等在是为]/;

function fragmentMetric(fragment: string): Metric | null {
  const match = FRAGMENT_METRIC.exec(fragment.trim());
  if (!match) return null;
  const label = match[1]!;
  if (FRAGMENT_LABEL_STOP.test(label)) return null;
  const unit = match[3] ?? '';
  // 无单位的裸整数多半是句子里的计数（600406 / 已用 0），只接受小数（PE 28.99）。
  if (!unit && !match[2]!.includes('.')) return null;
  // 百分比直接贴数字（25.34%），货币与倍率留一个空格（22.18 CNY / 28.4 倍）。
  const value = match[2]! + (unit ? (unit === '%' || unit === '％' ? unit : ' ' + unit) : '');
  const hint = match[4] ? match[4].slice(1, -1) : undefined;
  return metricFrom(label, value, hint);
}

/**
 * A two-column table with short values is a 指标清单, not a data grid.
 *
 * Rendering it as a table wastes width and, worse, browsers centre `<th>` by
 * default — which is exactly how the header ended up misaligned with its own
 * column. The renderer turns these into a KPI card grid instead.
 */
export function isKvTable(block: Extract<Block, { kind: 'table' }>): boolean {
  if (block.header.length !== 2) return false;
  if (block.rows.length === 0 || block.rows.length > 16) return false;
  return block.rows.every((row) => {
    const label = plainText(row[0] ?? []).trim();
    const value = plainText(row[1] ?? []).trim();
    // 标签必须短（长标签说明这是一句说明文字，不是指标名）；值可以是长串，
    // 渲染时那一项会独占整行（.md-kv-item-wide），所以不需要因此退回表格。
    return label.length > 0 && label.length <= 14 && value.length > 0;
  });
}

/** Flattens blocks back to plain text (used for titles / aria labels). */
export function toPlainText(blocks: Block[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'heading' || block.kind === 'paragraph') parts.push(plainText(block.children));
    else if (block.kind === 'list') parts.push(block.items.map((item) => plainText(item.children)).join(' '));
    else if (block.kind === 'quote') parts.push(toPlainText(block.blocks));
    else if (block.kind === 'table') parts.push(block.rows.map((row) => row.map(plainText).join(' ')).join(' '));
  }
  return parts.join('\n');
}
