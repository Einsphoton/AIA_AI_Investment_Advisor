// @ts-nocheck
/**
 * 财报面板预览生成器（`npm run preview:financials`）。
 *
 * 为什么需要它：本仓库没有浏览器测试运行器（无头 Chrome/Edge 在本机沙箱里连 IPC
 * 都起不来），但界面改动又必须能被核对。这里用**真实数据源 + 真实组件**
 * （`FinancialsView`）通过 `renderToStaticMarkup` 渲染成一份自包含 HTML
 * （内联应用样式表、不依赖网络），交给人工用浏览器打开核对观感；
 * 同时可以脚本化断言结构（表格数、列数、缺失提示），比纯截图更耐回归。
 *
 * 数据直接调已编译的 server 数据源，不依赖运行中的服务；若离线则退化为
 * 「不适用/缺失」状态，仍能验证空状态渲染。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { FinancialsView } from '../src/components/FinancialsPanel';
import { buildComparison, ComparisonTableView } from '../src/pages/FinancialCompare';

const { emFinancials } = await import('../../server/dist/datasources/financials.js');

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const OUT = resolve(process.cwd(), 'preview-financials-panel.html');

const CASES = [
  { market: 'CN', code: '600519', name: '贵州茅台（A股·通用模板）', type: 'stock' },
  { market: 'HK', code: '00700', name: '腾讯控股（港股·现金流为总量口径）', type: 'stock' },
  { market: 'US', code: 'AAPL', name: '苹果（美股·现金流量表来自 SEC EDGAR）', type: 'stock' },
  { market: 'US', code: 'KO', name: '可口可乐（美股·现金流量表数据缺失）', type: 'stock' },
  { market: 'US', code: 'SCHD', name: 'Schwab 红利 ETF（不适用财报）', type: 'etf' },
];

const sections = [];
for (const item of CASES) {
  const financials = item.type === 'stock' ? await emFinancials(item.market, item.code, item.name, 4) : null;
  const data = financials
    ? { ...financials, applicable: true }
    : {
        code: item.code,
        market: item.market,
        name: item.name,
        currency: item.market === 'US' ? 'USD' : 'CNY',
        standard: null,
        applicable: false,
        statements: [],
        highlights: [],
        sources: [],
        warnings: ['ETF / 场外基金没有公司财报（三表），请看基金详情与净值数据'],
      };
  const markup = renderToStaticMarkup(
    <FinancialsView data={data} periods="4" onPeriodsChange={() => {}} showPeriods={item.type === 'stock'} />,
  );
  sections.push(
    `<section class="pv-section" data-code="${item.market}/${item.code}"><div class="pv-title">${item.market}/${item.code} · ${item.name}</div>${markup}</section>`,
  );
  console.log(`rendered ${item.market}/${item.code} (${markup.length} 字符, 有数据=${Boolean(financials)})`);
}

/* ② 财报对比视图（/compare）：把 A 股银行 / A 股消费 / 美股 三只并排 */
const COMPARE = [
  { market: 'CN', code: '600519', name: '贵州茅台', type: 'stock' },
  { market: 'CN', code: '601398', name: '工商银行', type: 'stock' },
  { market: 'CN', code: '600030', name: '中信证券', type: 'stock' },
  { market: 'US', code: 'AAPL', name: '苹果', type: 'stock' },
];
const inputs = [];
for (const item of COMPARE) {
  const financials = await emFinancials(item.market, item.code, item.name, 4);
  inputs.push({
    key: `${item.market}:${item.code}:${item.type}`,
    name: item.name,
    market: item.market,
    code: item.code,
    type: item.type,
    group: '标的',
    data: financials ? { ...financials, applicable: true } : null,
  });
}
const compared = buildComparison(inputs);
sections.push(
  `<section class="pv-section" data-code="compare"><div class="pv-title">财报对比视图 /compare · ${COMPARE.map((i) => i.code).join(' vs ')}</div>` +
    `<div class="card"><div class="card-title">财报对比（${compared.periods.filter(Boolean)[0] ?? '—'} 等 ${compared.periods.length} 个标的）</div>` +
    renderToStaticMarkup(<ComparisonTableView table={compared} columns={inputs} />) +
    `</div></section>`,
);
console.log(`rendered compare view (${compared.rows.length} 个指标行, ${compared.warnings.length} 条提示)`);

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>财报面板预览</title>
<style>${css}</style>
<style>
  body { margin: 0; padding: 28px; }
  .pv-wrap { max-width: 1180px; margin: 0 auto; }
  .pv-hd { margin: 0 0 22px; font-size: 20px; }
  .pv-hd small { opacity: .6; font-size: 12px; font-weight: 400; }
  .pv-section { margin-bottom: 34px; }
  .pv-title { font-size: 13px; margin: 0 0 8px; opacity: .75; font-family: ui-monospace, Consolas, monospace; }
</style>
</head>
<body><div class="pv-wrap">
<div class="pv-hd">财报面板（三表）真实渲染预览 <small>真实接口数据 + 应用本体组件与样式 · 生成于 ${new Date().toISOString()}</small></div>
${sections.join('\n')}
</div></body></html>`;

writeFileSync(OUT, html, 'utf8');
console.log(`HTML written: ${OUT} (${html.length} 字符)`);
