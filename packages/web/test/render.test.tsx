/**
 * Headless render smoke test for every page (owner: Lead).
 *
 * `renderToString` runs the full component tree without a DOM, so this catches:
 *   · broken imports / renamed exports between teammates
 *   · crashes in the initial render path (hooks, formatters, chart wrappers)
 *   · missing route entries in App.tsx
 *
 * Data fetching happens in `useEffect` and therefore does not run here; the
 * assertions target the shell + page skeleton that must always render.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { AgentRunSummary, AssetSummary, InferenceMetrics, IpoOffer, SeriesPoint } from '@aia/shared';
import {
  DEFAULT_LLM,
  LLM_PROVIDER_CUSTOM_ID,
  LLM_PROVIDER_PRESET_MAP,
  LLM_PROVIDER_PRESETS,
  matchLlmProviderPreset,
  normalizeLlmBaseUrl,
} from '@aia/shared';
import { App } from '../src/App';
import {
  EMPTY_TOTALS,
  fmtCacheHitRate,
  fmtMilliseconds,
  fmtSpeed,
  fmtTokens,
  summarizeEntities,
  summarizeMetrics,
} from '../src/api/agentMetrics';
import {
  Disclosure,
  Dropdown,
  HoverTip,
  InstrumentTypeTag,
  MarketTag,
  Tabs,
  ToastProvider,
} from '../src/components/ui';
import { splitHighlightValue } from '../src/components/FinancialsPanel';
import { markerPointData, markerTooltipBlock, markersOnDate, seriesTooltipFormatter } from '../src/components/charts/tradeMarkers';
import { markersFromTransactions } from '../src/components/InstrumentDetailSections';
import { RunTimeline, runProgressView, runTimelineState } from '../src/components/RunTimeline';
import type { AgentStreamApi } from '../src/api/hooks';
import { FinancialsView, formatFinancialValue, parseHighlight, statementRows } from '../src/components/FinancialsPanel';
import { buildComparison } from '../src/pages/FinancialCompare';
import { AiAdviceCell } from '../src/pages/Assets';
import { Markdown, markdownSummary, markdownVerdict } from '../src/components/markdown/Markdown';
import { extractMetrics, parseChartSpec, parseMarkdown } from '../src/components/markdown/parse';
import { LlmProviderField } from '../src/pages/SettingsLlmProvider';
import { ModelField } from '../src/pages/SettingsModelField';
import { DangerZoneCard } from '../src/pages/SettingsDangerZone';
import { sortIpoOffers } from '../src/pages/Ipo';
import {
  IPO_VERDICT_HINT,
  IPO_VERDICT_TONE,
  expectedReturnClass,
  expectedReturnText,
  expectedReturnValue,
  expectedValueText,
  expectedValueValue,
  selectActionableIpoOffers,
  truncateText,
  verdictReasonText,
  winRateText,
  winRateValue,
} from '../src/pages/ipoView';
import { SchedulesCard } from '../src/pages/SettingsSchedules';
import {
  buildInput,
  newScheduleDraft,
  toDraft,
  toSchedulePayload,
  type Draft,
} from '../src/pages/settingsDraft';
import { selectResumableRuns } from '../src/components/InterruptedRunsAlert';

const ROUTES: { path: string; expect: string[] }[] = [
  { path: '/', expect: ['Dashboard'] },
  { path: '/assets', expect: ['我的资产'] },
  { path: '/watchlist', expect: ['我的标的'] },
  { path: '/compare', expect: ['选择对比标的', '财报对比'] },
  { path: '/advice', expect: ['AI 投资建议'] },
  { path: '/ipo', expect: ['新股打新', 'IPO Desk'] },
  { path: '/chat', expect: ['AI Chat'] },
  { path: '/activity', expect: ['活动与审计'] },
  { path: '/settings', expect: ['设置'] },
];

function render(path: string): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </MemoryRouter>,
  );
}

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Reads a file under `packages/web/src` (for wiring assertions). */
function readSource(...segments: string[]): string {
  return fs.readFileSync(path.join(SRC_DIR, ...segments), 'utf8');
}

for (const route of ROUTES) {
  test(`页面可无头渲染：${route.path}`, () => {
    const html = render(route.path);
    assert.ok(html.length > 300, `${route.path} 渲染结果过短（${html.length} 字符），可能页面为空`);
    for (const needle of route.expect) {
      assert.ok(html.includes(needle), `${route.path} 渲染结果缺少预期文本「${needle}」`);
    }
  });
}

test('未知路由回退到 Dashboard', () => {
  const html = render('/definitely-not-a-page');
  assert.ok(html.includes('Dashboard'), '未知路由未回退到 Dashboard');
});

test('侧边栏包含全部八个导航入口', () => {
  const html = render('/');
  for (const label of ['Dashboard', '我的资产', '我的标的', '新股打新', 'AI 投资建议', 'AI Chat', '活动与审计', '设置']) {
    assert.ok(html.includes(label), `侧边栏缺少导航项「${label}」`);
  }
});

/* ───────────────────── 左上角版本徽标 ───────────────────── */

/** 根 package.json 的版本号 —— 全站唯一来源。 */
function rootVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(SRC_DIR, '..', '..', '..', 'package.json'), 'utf8'));
  return pkg.version as string;
}

test('左上角显示版本徽标：版本号来自根 package.json，且在导航之前', () => {
  const html = render('/');
  const version = rootVersion();
  assert.ok(html.includes('version-badge'), '侧边栏品牌区缺少版本徽标');
  assert.ok(html.includes(`v${version}`), `版本徽标未显示根 package.json 的版本 v${version}`);
  assert.ok(!/version-badge-label">\s*(undefined|v—)/.test(html), '版本徽标必须渲染出真实版本号，不能是占位');
  assert.ok(html.includes('查看版本信息'), '版本徽标缺少无障碍名称（键盘/读屏拿不到详情）');

  // 「左上角」= 侧边栏品牌区，且必须排在导航之前（塞进页脚就是左下角了）。
  const brand = html.indexOf('sidebar-brand');
  const badge = html.indexOf('version-badge');
  const nav = html.indexOf('class="nav"');
  assert.ok(brand >= 0 && badge > brand, '版本徽标必须挂在左上角的侧边栏品牌区内');
  assert.ok(nav > badge, '版本徽标必须位于导航之前（左上角），不能挪到侧边栏页脚');
});

test('版本机制接线：前端构建期注入 + /api/version 服务端标识 + 不一致告警', () => {
  // 前端版本号不是手写的：由 rollup 从根 package.json 注入。
  const rollupConfig = fs.readFileSync(path.resolve(SRC_DIR, '..', 'rollup.config.mjs'), 'utf8');
  assert.ok(rollupConfig.includes('defineAppVersion'), '浏览器构建未注入版本号，前端版本会退化成 unknown');
  assert.ok(/__AIA_VERSION__/.test(readSource('version.ts')), '前端未读取构建期注入的版本号');

  const client = readSource('api', 'client.ts');
  assert.ok(/AppVersionPayload/.test(client) && /'\/version'/.test(client), 'client 缺少 GET /api/version');

  const badge = readSource('components', 'VersionBadge.tsx');
  assert.ok(/api\s*\.\s*version\(\)/.test(badge), '版本徽标必须拉取服务端版本');
  assert.ok(/isVersionMismatch/.test(badge), '前后端版本不一致时必须能告警（旧缓存 app.js 最难排查）');

  const layout = readSource('components', 'Layout.tsx');
  assert.ok(/<VersionBadge/.test(layout), 'Layout 未挂载版本徽标');

  // 服务端只有一个来源：config.version 镜像根 package.json（不再写死）。
  const serverConfig = fs.readFileSync(path.resolve(SRC_DIR, '..', '..', 'server', 'src', 'config.ts'), 'utf8');
  assert.ok(!/version:\s*'\d+\.\d+/.test(serverConfig), '服务端 config 又硬编码了版本号');
  assert.ok(/versionInfo/.test(serverConfig), '服务端 config 未暴露 versionInfo');
});

/* ─────────────── Dashboard「AI一键分析」= 完整流水线 ─────────────── */

test('Dashboard 工具栏提供「AI一键分析」，并走完整流水线（资产 → 标的 → 建议）', () => {
  const html = render('/');
  assert.ok(html.includes('AI一键分析'), 'Dashboard 工具栏缺少「AI一键分析」按钮');

  // 只跑资产分析（/assets/analyze）不会产出标的与建议，必须走 /agent/run-now：
  // 该端点在同一条 SSE 流里顺序执行 runFullPipeline（arch §4.3-3）。
  const source = readSource('pages', 'Dashboard.tsx');
  assert.ok(
    /path: '\/agent\/run-now'/.test(source),
    '「AI一键分析」必须调用 /agent/run-now，才能跑完资产分析 → 标的分析 → AI 投资建议',
  );
});

/* ─────────── 第一行：年化收益率 / 已实现年化收益率（XIRR） ─────────── */

test('Dashboard 第一行显示「年化收益率」「已实现年化收益率」，且在持仓统计卡片内', () => {
  const page = readSource('pages', 'Dashboard.tsx');
  // 标签由 returnCardView 决定（区间过短时会换成「累计收益率」），两种口径都要在文件里。
  for (const label of ["'年化收益率'", "'已实现年化收益率'", "'累计收益率'", "'已实现收益率'"]) {
    assert.ok(page.includes(label), `缺少标签 ${label}`);
  }

  // 位置：必须在第一行（title="持仓统计" 的卡片里），且在「计数与信号」之前。
  const firstRow = page.indexOf('title="持仓统计"');
  const secondCard = page.indexOf('title="计数与信号"');
  const annualized = page.indexOf('label={view.annualizedLabel}');
  const realized = page.indexOf('label={view.realizedLabel}');
  assert.ok(firstRow > 0 && secondCard > firstRow, '未找到持仓统计/计数与信号卡片');
  assert.ok(annualized > firstRow && annualized < secondCard, '「年化收益率」必须在第一行');
  assert.ok(realized > firstRow && realized < secondCard, '「已实现年化收益率」必须在第一行');
});

test('年化计数：绑定 XIRR 结果、写明口径、不可度量时显示 — 而不是 0', () => {
  const page = readSource('pages', 'Dashboard.tsx');
  assert.ok(/portfolio\.performance|perf = portfolio\?\.performance/.test(page), '数据必须来自 portfolio.performance');
  assert.ok(/perf\.annualizedPct/.test(page), '年化收益率必须绑定 annualizedPct');
  assert.ok(/perf\.realizedAnnualizedPct/.test(page), '已实现年化收益率必须绑定 realizedAnnualizedPct');
  assert.ok(/XIRR/.test(page), '副标题必须写明 XIRR 口径');
  assert.ok(/performanceHint/.test(page), '必须提供口径说明（期初/期末市值、降级原因）悬浮可查');
  assert.ok(/periodStart/.test(page) && /openingValue/.test(page), '口径说明必须包含起点与期初市值');
  // null（不可度量）必须如实显示 —，绝不用 0 顶替；fmtPct(null) 已经是 —。
  assert.ok(!/annualizedPct \?\? 0/.test(page), '不可度量不得用 0 顶替');
  assert.ok(!/realizedAnnualizedPct \?\? 0/.test(page), '不可度量不得用 0 顶替');
});

test('年化计数：区间不足 30 天不年化，卡片改用累计收益率（避免 −0.45% 显示成年化 −80%）', () => {
  const page = readSource('pages', 'Dashboard.tsx');
  // 展示口径集中在 returnCardView：年化为空时退回累计收益率，标签一起换。
  assert.ok(/function returnCardView/.test(page), '必须集中处理「年化 vs 累计」的展示口径');
  assert.ok(/annualized !== null \? '年化收益率'/.test(page), '年化可用时才用「年化收益率」标签');
  assert.ok(page.includes("'累计收益率'"), '区间过短时必须改显示「累计收益率」');
  assert.ok(page.includes("'已实现收益率'"), '已实现部分同理');
  assert.ok(/annualized \?\? perf\.cumulativePct/.test(page), '年化为空时取累计收益率');
  assert.ok(/annualizedReliable/.test(page), '副标题必须区分「已年化」与「不做年化」');
  assert.ok(/MIN_ANNUALIZE_DAYS/.test(page), '30 天门槛必须来自共享常量，不能各写一份');
  // 不能把年化数字直接写进卡片（那正是这次修掉的问题）。
  assert.ok(!/value=\{fmtPct\(perf\.annualizedPct\)\}/.test(page), '卡片值不得直接取 annualizedPct（会绕过 30 天门槛）');
  // 服务端口径与前端门槛必须同源。
  const types = fs.readFileSync(path.resolve(SRC_DIR, '..', '..', 'shared', 'src', 'types.ts'), 'utf8');
  for (const field of ['cumulativePct', 'annualizedReliable', 'cashFlowDays', 'realizedCumulativePct']) {
    assert.ok(new RegExp(`\\b${field}\\b`).test(types), `契约缺少 ${field}`);
  }
});

test('契约与接线：PortfolioPerformance 由服务端计算，dashboard 路由产出', () => {
  const types = fs.readFileSync(path.resolve(SRC_DIR, '..', '..', 'shared', 'src', 'types.ts'), 'utf8');
  assert.ok(/export interface PortfolioPerformance/.test(types), '缺少 PortfolioPerformance 契约');
  assert.ok(/performance: PortfolioPerformance/.test(types), 'DashboardPortfolio 未挂载 performance');
  for (const field of ['annualizedPct', 'realizedAnnualizedPct', 'sinceInceptionPct', 'openingValue', 'endingValue', 'netInvested', 'realizedPnl', 'notes']) {
    assert.ok(new RegExp(`\\b${field}\\b`).test(types), `契约缺少 ${field}`);
  }

  const route = fs.readFileSync(path.resolve(SRC_DIR, '..', '..', 'server', 'src', 'routes', 'dashboard.ts'), 'utf8');
  assert.ok(/buildPortfolioPerformance/.test(route), 'dashboard 路由未接入年化计算');
  const service = fs.readFileSync(path.resolve(SRC_DIR, '..', '..', 'server', 'src', 'services', 'performance.ts'), 'utf8');
  assert.ok(/export function solveXirr/.test(service), '年化必须由 XIRR 求解器算出');
  assert.ok(!/\/ 天数 \* 365|365 \/ days \* 100/.test(service), '禁止用「收益率 ÷ 天数 × 365」的线性外推冒充年化');
});

/* ─────────── 推理过程：右下角全局面板（切换页面不消失） ─────────── */

test('推理过程只在右下角全局面板渲染：页面不再内联 RunPanel', () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx$/.test(entry.name)) {
        const code = fs.readFileSync(full, 'utf8');
        if (/<RunPanel[\s/>]/.test(code)) offenders.push(path.relative(SRC_DIR, full));
      }
    }
  };
  walk(SRC_DIR);
  assert.deepEqual(offenders, [], `这些页面仍把推理过程内联在正文里（应改走右下角面板）：${offenders.join(', ')}`);
});

test('全局推理面板挂在 <Routes> 之外，路由切换不会卸载它', () => {
  const source = readSource('App.tsx');
  const routesClose = source.indexOf('</Routes>');
  const dock = source.indexOf('<AgentActivityDock');
  assert.ok(routesClose > 0, 'App.tsx 未找到 </Routes>');
  assert.ok(dock > routesClose, '推理面板必须渲染在 <Routes> 之外，否则切换页面会卸载并丢失推理过程');
  assert.ok(source.includes('<AgentActivityProvider>'), '全局 Provider 必须在路由之外持有 SSE 流');
});

test('全站 AI 入口统一通过全局 Provider 发起运行', () => {
  const pages = fs.readdirSync(path.join(SRC_DIR, 'pages'));
  const offenders: string[] = [];
  for (const name of pages) {
    const code = fs.readFileSync(path.join(SRC_DIR, 'pages', name), 'utf8');
    // Chat 是对话式 Agent（答复本身就是页面内容），仍保留自己的流。
    if (name === 'Chat.tsx') continue;
    if (/useAgentStream\(/.test(code)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `这些页面仍各自持有 SSE 流（切换页面会丢失推理过程）：${offenders.join(', ')}`);
});

/* ─────────────── 自选标的淘汰（在池 / 已退役 / 复活） ─────────────── */

test('我的标的页提供在池/已退役筛选、复活入口与持仓护栏说明', () => {
  const html = render('/watchlist');
  assert.ok(html.includes('在池（'), '缺少「在池」筛选');
  assert.ok(html.includes('已退役（'), '缺少「已退役」筛选');
  assert.ok(html.includes('有持仓的标的不进入淘汰流程'), '未在界面上说明持仓护栏');
  const source = readSource('pages', 'Watchlist.tsx');
  assert.ok(/api\.watchlist\.restore\(/.test(source), '已退役标的需要提供「复活」入口');
  assert.ok(/status: statusFilter/.test(source), '列表请求必须带上 status 筛选');
});

test('设置页可配置淘汰确认次数（0 = 只标记不删除）', () => {
  // 设置页在无头渲染时只输出 Loading（数据在 useEffect 里拉取），因此核对源码。
  const page = readSource('pages', 'Settings.tsx');
  assert.ok(page.includes('标的淘汰确认次数'), '设置页缺少淘汰确认次数输入');
  assert.ok(/watchlistRetireDeleteRuns/.test(page), '设置页未绑定 watchlistRetireDeleteRuns');
  const draft = readSource('pages', 'settingsDraft.ts');
  assert.ok(/watchlistRetireDeleteRuns/.test(draft), '设置草稿必须带上传淘汰确认次数');
});

/* ─────────────────── 设置页「一键清除所有数据」 ─────────────────── */

test('设置页提供「一键清除所有数据」，默认保留 AI 配置', () => {
  const html = renderToString(
    <ToastProvider>
      <DangerZoneCard />
    </ToastProvider>,
  );
  assert.ok(html.includes('危险操作'), '缺少危险操作区标题');
  assert.ok(html.includes('一键清除所有数据'), '危险操作区缺少一键清除按钮');
  assert.ok(html.includes('保留 AI 配置与 API Key'), '必须写明默认保留 AI 配置');
  assert.ok(html.includes('data/backups'), '必须说明服务端快照不受影响');

  const page = readSource('pages', 'Settings.tsx');
  assert.ok(page.includes('<DangerZoneCard'), '设置页未挂载危险操作区');
  const card = readSource('pages', 'SettingsDangerZone.tsx');
  assert.ok(/api\.backup\.clear\(/.test(card), '必须调用 POST /api/backup/clear');
  assert.ok(/keepSettings: !withSettings/.test(card), '只有勾选「清除 AI 配置」时才重置设置');
  const client = readSource('api', 'client.ts');
  assert.ok(/clear:/.test(client) && /\/backup\/clear/.test(client), 'client 缺少 backup.clear');
});

test('推理指标聚合：只按 done 事件累计用量，首字延迟取最快与最慢', () => {
  const event = (over: Partial<InferenceMetrics>): InferenceMetrics => ({
    phase: 'done',
    turn: 1,
    model: 'deepseek-v4.1-flash',
    ttftMs: null,
    latencyMs: null,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    tokensPerSecond: null,
    ...over,
  });
  const totals = summarizeMetrics([
    // first-token 事件只有计时，绝不能把用量算两次。
    event({ phase: 'first-token', turn: 1, ttftMs: 1200 }),
    event({ turn: 1, ttftMs: 1200, latencyMs: 3200, promptTokens: 1000, completionTokens: 200, cachedTokens: 800, tokensPerSecond: 100 }),
    event({ phase: 'first-token', turn: 2, ttftMs: 800 }),
    event({ turn: 2, ttftMs: 800, latencyMs: 2100, promptTokens: 500, completionTokens: 100, cachedTokens: 500, tokensPerSecond: 50 }),
  ]);
  assert.equal(totals.requests, 2, 'first-token 事件不应计入请求数');
  assert.equal(totals.promptTokens, 1500);
  assert.equal(totals.completionTokens, 300);
  assert.equal(totals.totalTokens, 1800);
  assert.equal(totals.cachedTokens, 1300);
  assert.ok(totals.cacheHitRate !== null && Math.abs(totals.cacheHitRate - 1300 / 1500) < 1e-9, '命中率 = 命中 / 输入');
  assert.equal(totals.tokensPerSecond, 50, '生成速度取最近一次完成请求');
  assert.equal(totals.bestTtftMs, 800);
  assert.equal(totals.worstTtftMs, 1200);
  assert.equal(totals.lastLatencyMs, 2100);
  assert.equal(totals.model, 'deepseek-v4.1-flash');
});

test('推理指标聚合：无数据与越界值都退化为「—」而不是假的 100%', () => {
  assert.deepEqual(summarizeMetrics([]), EMPTY_TOTALS);
  const noCache = summarizeMetrics([
    {
      phase: 'done',
      turn: 1,
      model: 'm',
      ttftMs: null,
      latencyMs: 900,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      tokensPerSecond: null,
    },
  ]);
  assert.equal(noCache.cacheHitRate, null, '没有输入 tokens 时不得报命中率');
  assert.equal(fmtCacheHitRate(noCache.cacheHitRate), '—');
  assert.equal(fmtCacheHitRate(2), '100.0%', '命中率上限 100%');
  assert.equal(fmtMilliseconds(null), '—');
  assert.equal(fmtSpeed(null), '—');
});

test('推理指标格式化：毫秒 / 秒 / 分钟与千分位', () => {
  assert.equal(fmtMilliseconds(450), '450ms');
  assert.equal(fmtMilliseconds(1250), '1.25s');
  assert.equal(fmtMilliseconds(84_000), '1m24s');
  assert.equal(fmtTokens(12_480), '12,480');
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtSpeed(42.06), '42.1 tok/s');
  assert.equal(fmtCacheHitRate(0.8734), '87.3%');
});

test('写入汇总按 实体 × 动作 计数', () => {
  assert.deepEqual(
    summarizeEntities([
      { action: 'created', entity: 'asset', id: '1', label: 'A' },
      { action: 'created', entity: 'asset', id: '2', label: 'B' },
      { action: 'updated', entity: 'watchlist', id: '3', label: 'C' },
      { action: 'deleted', entity: 'advice', id: '4', label: 'D' },
    ]),
    ['资产 +2', '标的 ~1', '建议 -1'],
  );
  assert.deepEqual(summarizeEntities([]), []);
});

test('页面不再使用占位 stub', () => {
  for (const route of ROUTES) {
    const html = render(route.path);
    assert.ok(!html.includes('尚未实现'), `${route.path} 仍是占位实现（stub），任务未完成`);
  }
});

/* ─────────────────────── LLM 供应商预设（设置页 AI 配置） ─────────────────── */

test('LLM 供应商预设表完整且自洽', () => {
  assert.ok(LLM_PROVIDER_PRESETS.length >= 45, `预设数量过少（${LLM_PROVIDER_PRESETS.length}），常用供应商覆盖不足`);
  const ids = new Set<string>();
  const regions = new Set<string>();
  for (const preset of LLM_PROVIDER_PRESETS) {
    assert.ok(!ids.has(preset.id), `预设 id 重复：${preset.id}`);
    ids.add(preset.id);
    regions.add(preset.region);
    assert.ok(preset.label.trim().length > 0, `${preset.id} 缺少名称`);
    assert.ok(preset.notes.trim().length > 0, `${preset.id} 缺少说明文案`);
    assert.ok(/^https?:\/\//.test(preset.baseUrl), `${preset.id} baseUrl 必须带协议`);
    assert.ok(
      !/\/+$/.test(preset.baseUrl),
      `${preset.id} baseUrl 不应以斜杠结尾（服务端会拼接 /chat/completions）`,
    );
    assert.ok(
      !/chat\/completions$/.test(preset.baseUrl),
      `${preset.id} baseUrl 不应包含 /chat/completions`,
    );
    assert.ok(preset.docsUrl.startsWith('https://'), `${preset.id} docsUrl 必须是 https`);
    if (preset.baseUrl.startsWith('http://')) {
      // 非 TLS 只允许用于本机自建服务（llama.cpp / GPUStack / One API 等）。
      assert.ok(preset.baseUrl.startsWith('http://localhost'), `${preset.id} 非 TLS 地址只能用于本机服务`);
    } else {
      assert.ok(preset.baseUrl.startsWith('https://'), `${preset.id} 必须使用 https 或 http://localhost`);
    }
  }
  for (const region of ['cn', 'global', 'gateway', 'local'] as const) {
    assert.ok(regions.has(region), `预设缺少分组：${region}`);
  }
  // 主地址与 aliases 必须全局唯一，否则按地址反查会指向错误的预设。
  const claimed = new Set<string>();
  for (const preset of LLM_PROVIDER_PRESETS) {
    for (const url of [preset.baseUrl, ...(preset.aliases ?? [])]) {
      const normalized = normalizeLlmBaseUrl(url);
      assert.ok(!claimed.has(normalized), `Base URL 或别名重复：${normalized}`);
      claimed.add(normalized);
    }
  }
  assert.equal(
    LLM_PROVIDER_PRESET_MAP.deepseek.baseUrl,
    DEFAULT_LLM.baseUrl,
    '默认供应商应与 DEFAULT_LLM.baseUrl 保持一致',
  );
  assert.ok(!LLM_PROVIDER_PRESET_MAP[LLM_PROVIDER_CUSTOM_ID], 'custom 是哨兵值，不应出现在预设表中');
});

test('按 Base URL 反查预设：容忍空白/大小写/尾部斜杠，未命中返回 undefined', () => {
  assert.equal(matchLlmProviderPreset('https://api.deepseek.com/v1/')?.id, 'deepseek');
  assert.equal(matchLlmProviderPreset('  HTTPS://API.DEEPSEEK.COM/v1  ')?.id, 'deepseek');
  assert.equal(matchLlmProviderPreset('https://api.deepseek.com/v1/chat/completions'), undefined);
  assert.equal(matchLlmProviderPreset(''), undefined);
  assert.equal(matchLlmProviderPreset('http://192.168.1.9:8000/v1'), undefined);
  // 等价地址（aliases）：OpenCode 的几种官方写法都要回显到正确预设，否则用户在
  // 按量付费入口用 Go 的 Key 时，界面只会显示「自定义」而看不到排错说明。
  assert.equal(matchLlmProviderPreset('https://opencode.ai/inference/openai/v1')?.id, 'opencode');
  assert.equal(matchLlmProviderPreset('https://opencode.ai/inference/go/v1')?.id, 'opencode-go');
  assert.equal(matchLlmProviderPreset('https://opencode.ai/inference/go/openai/v1')?.id, 'opencode-go');
});

test('供应商预设下拉可无头渲染：命中预设显示说明与申请链接', () => {
  const html = renderToString(
    <LlmProviderField baseUrl="https://api.deepseek.com/v1" onPick={() => undefined} />,
  );
  assert.ok(html.includes('供应商预设'), '下拉缺少标题');
  assert.ok(html.includes('DeepSeek 官方'), '下拉未列出预设供应商');
  assert.ok(html.includes('国内厂商'), '下拉缺少分组标题');
  assert.ok(html.includes('自定义'), '下拉缺少「自定义」选项');
  assert.ok(html.includes('https://platform.deepseek.com/api_keys'), '命中预设时未展示申请 Key 链接');

  const custom = renderToString(<LlmProviderField baseUrl="http://my-gateway.local/v1" onPick={() => undefined} />);
  assert.ok(custom.includes('自定义'), '自定义地址时应回退到自定义选项');
  assert.ok(!custom.includes('platform.deepseek.com'), '自定义地址不应展示 DeepSeek 说明');
});

test('模型输入框可无头渲染，未聚焦时不发请求', () => {
  const html = renderToString(
    <ModelField value="deepseek-flash" onChange={() => undefined} baseUrl="https://api.deepseek.com/v1" apiKey="" />,
  );
  assert.ok(html.includes('模型名'), '输入框缺少无障碍名称');
  assert.ok(html.includes('deepseek-flash'), '未回显当前模型名');
  assert.ok(html.includes('点击输入框自动拉取'), '未展示「聚焦即拉取」的提示');
  assert.ok(!html.includes('role="listbox"'), '未聚焦时不应渲染下拉');
});

/* ─────────────────── 自定义下拉（原生 <select> 画不出黑金弹层） ─────────────────── */

test('自定义 Dropdown 无头渲染：默认收起、分组与选中态都在', () => {
  const html = renderToString(
    <Dropdown
      value="cn-a"
      ariaLabel="测试下拉"
      onChange={() => undefined}
      items={[
        { value: 'custom', label: '自定义' },
        {
          group: '国内厂商',
          options: [
            { value: 'cn-a', label: '厂商 A' },
            { value: 'cn-b', label: '厂商 B' },
          ],
        },
      ]}
    />,
  );
  assert.ok(html.includes('aria-haspopup="listbox"'), '触发器缺少 listbox 语义');
  assert.ok(html.includes('aria-expanded="false"'), '下拉默认必须是收起状态');
  assert.ok(html.includes('hidden'), '收起时面板应带 hidden（服务端仍输出全部选项文案）');
  assert.ok(html.includes('国内厂商'), '分组标题缺失');
  assert.ok(html.includes('厂商 A') && html.includes('厂商 B'), '分组选项缺失');
  assert.ok(html.includes('aria-selected="true"'), '当前值未标记为选中');
});

test('全站不再使用原生 <select>', () => {
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        const code = fs
          .readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        if (/<select[\s>]/.test(code)) offenders.push(path.relative(srcDir, full));
      }
    }
  };
  walk(srcDir);
  assert.deepEqual(offenders, [], `仍在使用原生 <select>（弹层由系统绘制，做不出黑金）：${offenders.join(', ')}`);
});

/**
 * Browser-runtime guard for the *built* bundle.
 *
 * `renderToString` runs in Node, where a global `process` exists, so it can
 * never catch `process.env.NODE_ENV` leaking into the browser bundle — yet that
 * is exactly what blanks the page in a real browser (React/ReactDOM/ECharts
 * CommonJS entries branch on it, and `ReferenceError: process is not defined`
 * aborts the whole module, leaving `#root` empty). Verified against the real
 * failure on 2026-10-14; the build now rewrites it in
 * `packages/web/rollup.config.mjs` (`define-process-env`).
 */
test('构建产物不含浏览器无法解析的 process.env', (t) => {
  const bundlePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'assets', 'app.js');
  if (!fs.existsSync(bundlePath)) {
    t.skip('未找到 packages/web/dist/assets/app.js，请先运行 npm run build -w @aia/web');
    return;
  }
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  assert.ok(
    !/process\s*\.\s*env/.test(bundle),
    '打包产物仍引用 process.env：浏览器没有 process 全局，页面会整页空白。请让 packages/web/rollup.config.mjs 的 define-process-env 插件生效后重新构建。',
  );
});

/* ══════════════════ AI 输出：Markdown 渲染与响应式布局 ══════════════════ */

/** Fixture covering every syntax the renderer claims to support. */
const REPORT = [
  '## 一、组合简报',
  '',
  '**总市值** 1,280,000 元，当日 **+1.24%**。',
  '',
  '**结论**：入选。质量分 74，估值处于合理区间。',
  '',
  '- 估值分位：72%',
  '',
  '| 指标 | 数值 |',
  '| --- | --- |',
  '| 现价 | 22.18 CNY |',
  '| ROE | 18.2% |',
  '',
  '| 项目 | 2024 | 2025 |',
  '| --- | --- | --- |',
  '| 营收 | 100 | 140 |',
  '| 净利 | 20 | 30 |',
  '',
  '```metrics',
  '目标价 | 128.5 元 | 较现价 +12.4%',
  '```',
  '',
  '```chart',
  '{"type":"bar","title":"各市场预算","categories":["A股","港股"],"series":[{"name":"已用","data":[1200,800]}]}',
  '```',
].join('\n');

test('Markdown 渲染：标题徽标 / 指标条 / 指标卡 / 数据表 / 结论卡 / 涨跌胶囊 / 图表块', () => {
  const html = renderToString(<Markdown text={REPORT} />);
  // 标题：编号「一、」→ 徽标，正文里不再重复显示编号
  assert.ok(html.includes('md-h2'), '缺少标题层级');
  assert.ok(html.includes('md-h-badge'), '「一、」编号未渲染成徽标');
  assert.ok(!html.includes('一、组合简报'), '编号应从标题正文里剥掉');
  // 顶部指标条 + 迷你条
  assert.ok(html.includes('md-metrics'), '缺少自动提取的关键指标条');
  assert.ok(html.includes('md-mini-bar'), '百分比指标缺少迷你条');
  // 两列短值表格 → 指标卡面板（不再是表格）
  assert.ok(html.includes('md-kv-item'), '两列指标表未渲染成指标卡面板');
  assert.ok(html.includes('22.18 CNY'), '指标卡丢值');
  // 三列表格 → 数据表 + 内联柱
  assert.ok(html.includes('md-table'), '缺少数据表渲染');
  assert.ok(html.includes('md-bar-fill'), '数值列缺少内联柱状条');
  // 结论卡 + 判定胶囊
  assert.ok(html.includes('md-callout tone-verdict'), '「**结论**：」未渲染成结论卡');
  assert.ok(/md-verdict tone-buy/.test(html), '「入选」未渲染成判定胶囊');
  // 加粗涨跌幅 → 带底色的胶囊
  assert.ok(/md-chip tone-pos/.test(html), '**+1.24%** 未渲染成涨跌胶囊');
  assert.ok(html.includes('md-chart'), 'chart 代码块未渲染成图表');
  assert.ok(html.includes('各市场预算'), '图表标题丢失');
  assert.ok(html.includes('128.5 元'), 'metrics 代码块未进入指标条');
  assert.ok(html.includes('估值分位'), '冒号行里的指标未进入指标条');
});

test('表格对齐：表头与列同向（回归「浏览器默认居中 th」导致的错位）', () => {
  // 浏览器对 <th> 的默认 text-align 是 center，而 <td> 是 left：
  // 只要 .md-table th 漏写 text-align，表头就会和该列的数值对不齐。
  const css = readSource('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const thRule = /\.md-table th\s*\{[^}]*\}/.exec(css);
  assert.ok(thRule, '未找到 .md-table th 规则');
  assert.ok(
    /text-align:\s*left/.test(thRule![0]),
    '.md-table th 必须显式声明 text-align: left（浏览器默认居中，会造成表头与数值错位）',
  );
  for (const cls of ['align-left', 'align-right', 'align-center']) {
    assert.ok(new RegExp('\\.md-table th\\.' + cls).test(css), '表头缺少对齐规则：' + cls);
    assert.ok(new RegExp('\\.md-table td\\.' + cls).test(css), '数据单元格缺少对齐规则：' + cls);
  }
  // 渲染层面：逐列比对表头与数值的对齐 class，必须完全一致。
  const html = renderToString(
    <Markdown text={'| 名称 | 2024 | 2025 |\n| --- | ---: | --- |\n| A | 1 | 2 |'} metrics={false} />,
  );
  const headerAlign = [...html.matchAll(/<th class="(align-[a-z]+)"/g)].map((m) => m[1]);
  const bodyAlign = [...html.matchAll(/<td class="(align-[a-z]+)/g)].map((m) => m[1]);
  assert.deepEqual(
    headerAlign,
    bodyAlign,
    '表头与同列数值的对齐方式必须一致（错位 bug 的回归护栏）',
  );
  // 第 2 列显式右对齐；第 3 列是纯数值列 → 自动右对齐。
  assert.deepEqual(headerAlign, ['align-left', 'align-right', 'align-right']);
});

test('指标卡面板：两列表格不再渲染成表格，长值独占整行', () => {
  const html = renderToString(
    <Markdown
      text={'| 指标 | 数值 |\n| --- | --- |\n| 现价 | 22.18 CNY |\n| 分红 | 0.153 + 0.475 = 0.628 元/股，股息率约 2.83% |'}
      metrics={false}
    />,
  );
  assert.ok(html.includes('md-kv'), '两列指标表未渲染成指标卡面板');
  assert.ok(html.includes('md-kv-item-wide'), '长值未独占整行');
  assert.ok(!/<table/.test(html), '两列指标表不应再渲染成表格（表头错位的老问题就此消失）');
});

test('Markdown 一律转义：注入的 HTML 只能作为文本显示', () => {
  const html = renderToString(<Markdown text={'<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>'} metrics={false} />);
  assert.ok(!html.includes('<script>'), '脚本标签被当成 HTML 输出');
  assert.ok(html.includes('&lt;script&gt;'), '脚本标签应转义为文本');
  assert.ok(!/<img/i.test(html), 'img 标签不应被渲染');
});

test('Markdown 解析：块级结构、嵌套列表与未闭合围栏容错', () => {
  const blocks = parseMarkdown(
    [
      '# 标题',
      '',
      '- a',
      '- b',
      '   - b1',
      '',
      '> 风险提示',
      '',
      '| k | v |',
      '| --- | --- |',
      '| a | 1 |',
      '',
      '```json',
      '{"a":1}',
    ].join('\n'),
  );
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ['heading', 'list', 'quote', 'table', 'code'],
    '块级结构解析结果不符合预期',
  );
  const list = blocks[1]!;
  assert.equal(list.kind, 'list');
  if (list.kind === 'list') {
    assert.equal(list.items.length, 2);
    assert.equal(list.items[1]!.sub[0]?.kind, 'list', '缩进子列表未归入上一项');
  }
  const table = blocks[3]!;
  assert.equal(table.kind, 'table');
  if (table.kind === 'table') assert.deepEqual(table.numeric, [false, true], '数值列识别错误');
});

test('KPI 提取：冒号行与「标签 数值」片段都收，纯叙述留在正文', () => {
  // 两道扫描：①「标签：数值」整行；② 长句里「标签 数值」的完整短片段。
  // 旧文本（模型早期输出）常常是一整段叙述，没有冒号也没有表格，靠第②道兜底。
  const blocks = parseMarkdown(
    [
      '- 估值分位：72%',
      '- 目标价：128.5 元',
      '- 行业集中度：科技占比 42%',
      '- 结论：趋势向上，回调即是机会',
      '- 该标的 2026 年 8 月见顶后回落',
    ].join('\n'),
  );
  const metrics = extractMetrics(blocks);
  assert.deepEqual(
    metrics.map((item) => item.label),
    ['估值分位', '目标价', '科技占比'],
    'KPI 提取集合不符合预期（既不能漏掉叙述里的关键指标，也不能把整句当指标）',
  );
  assert.equal(metrics[0]!.pct, 72, '百分比未解析成进度条数值');
  assert.ok(!metrics.some((item) => /该标的/.test(item.label)), '整句叙述不应被当成 KPI');
});

test('chart 代码块：合法 JSON 解析成系列，非法 JSON 回退显示原文', () => {
  assert.equal(parseChartSpec('{ broken'), null, '非法 JSON 必须返回 null');
  const spec = parseChartSpec('{"type":"line","categories":["a","b"],"series":[{"name":"x","data":[1,2]}]}');
  assert.ok(spec);
  assert.equal(spec!.type, 'line');
  const html = renderToString(<Markdown text={'```chart\n{ broken json\n```'} metrics={false} />);
  assert.ok(html.includes('JSON 解析失败'), '非法 chart 应回退成原文，而不是整块消失');
});

test('HoverTip 无头渲染：默认收起，只输出触发区', () => {
  const html = renderToString(
    <HoverTip label="查看全文" content={<span>完整内容</span>}>
      <span>摘要</span>
    </HoverTip>,
  );
  assert.ok(html.includes('hovertip-trigger'), '缺少触发区');
  assert.ok(html.includes('aria-expanded="false"'), '浮窗默认必须是收起的');
  assert.ok(!html.includes('class="hovertip"'), '收起时不应渲染浮窗');
});

/* ───────────────────────── 响应式布局契约 ───────────────────────── */

test('主内容区铺满宽度：列表直接扩展、区块动态平铺', () => {
  // 去掉注释再断言：说明文字里会提到旧写法，不能算违规。
  const css = readSource('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/max-width:\s*1560px/.test(css), '.main 仍写死 max-width: 1560px，16:9 / 超宽屏右侧会留白');
  const mainRule = /\.main\s*\{[^}]*\}/.exec(css);
  assert.ok(mainRule, '未找到 .main 规则');
  assert.ok(!/max-width/.test(mainRule![0]), '.main 不应再限制最大宽度');
  assert.ok(/width:\s*100%/.test(mainRule![0]), '.main 应铺满可用宽度');
  assert.ok(/clamp\(/.test(mainRule![0]), '.main 的内边距应随视口自适应');
  // 栅格用 min(100%, …) 保证窄屏不会撑破容器。
  for (const guard of ['min(100%, 200px)', 'min(100%, 220px)', 'min(100%, 320px)']) {
    assert.ok(css.includes(guard), '栅格缺少防溢出保护：' + guard);
  }
});

test('响应式断点覆盖手机与超宽屏', () => {
  const css = readSource('styles.css');
  for (const query of ['@media (max-width: 900px)', '@media (max-width: 640px)', '@media (max-width: 420px)', '@media (min-width: 1700px)']) {
    assert.ok(css.includes(query), '缺少断点：' + query);
  }
  // 手机上表格改为横向滚动而不是把列压扁。
  const phone = /@media \(max-width: 640px\)\s*\{[\s\S]*?\n\}/.exec(css);
  assert.ok(phone, '未找到 640px 断点规则块');
  assert.ok(/table\.data-table\s*\{[^}]*min-width/.test(phone![0]), '手机上表格应保留最小可读列宽');
});

test('Dashboard：全球指数概览紧跟计数与信号，AI 简报走 Markdown', () => {
  const source = readSource('pages', 'Dashboard.tsx');
  const at = (needle: string): number => source.indexOf(needle);
  assert.ok(at('{/* ② 计数与信号 */}') > 0, '未找到「计数与信号」板块');
  assert.ok(
    at('{/* ③ 全球指数概览') > at('{/* ② 计数与信号 */}'),
    '全球指数概览必须放在「计数与信号」下面',
  );
  assert.ok(
    at('{/* ③ 全球指数概览') < at('{/* ④ 持仓排名前五'),
    '全球指数概览应排在持仓排名之前',
  );
  assert.ok(/<Markdown text=\{payload\.briefing\.text\}/.test(source), 'AI 简报必须以 Markdown 渲染');
  assert.ok(source.includes('{/* ⑥ 月度预算使用'), '月度预算应有独立板块并按市场动态平铺');
  assert.ok(!/whiteSpace: 'pre-wrap'/.test(source), '简报不应再退回 pre-wrap 纯文本');
});

test('AI 投资建议：理由列只显示摘要，悬浮查看全文', () => {
  const source = readSource('pages', 'Advice.tsx');
  assert.ok(/HoverTip/.test(source), '理由列必须用悬浮浮窗展示全文');
  assert.ok(/hovertip-clamp/.test(source), '摘要需要两行截断样式');
  assert.ok(!/'展开'/.test(source), '旧的「展开 / 收起」按钮应被移除');
  assert.ok(/variant="compact"/.test(source), '浮窗里的理由应以紧凑 Markdown 渲染');
  assert.ok(/summarizeReason/.test(source), '摘要应先剥离 Markdown 标记');
});

test('所有 AI 文本出口都走 Markdown 渲染', () => {
  const files: [string, string][] = [
    ['pages', 'Dashboard.tsx'],
    ['pages', 'AssetDetailDialog.tsx'],
    ['pages', 'WatchlistDetailDialog.tsx'],
    ['pages', 'Chat.tsx'],
    ['components', 'RunTimeline.tsx'],
  ];
  const offenders: string[] = [];
  for (const [dir, name] of files) {
    const source = readSource(dir, name);
    if (!source.includes('Markdown')) offenders.push(name);
    if (/whiteSpace: 'pre-wrap'/.test(source)) offenders.push(name + '(pre-wrap)');
  }
  assert.deepEqual(offenders, [], '这些 AI 文本出口仍在输出纯文本：' + offenders.join(', '));
});

/* ───────────────────────────── 财报三表面板 ─────────────────────────────── */

test('财报面板：多期科目转成「科目为行、报告期为列」，缺期补空值', () => {
  const rows = statementRows({
    kind: 'income',
    label: '利润表',
    available: true,
    periods: [
      {
        period: '2026中报',
        reportDate: '2026-06-30',
        reportType: '中报',
        currency: 'CNY',
        cumulative: true,
        lines: [
          { key: 'revenue', label: '营业总收入', value: 92278072083.21, unit: 'CNY', yoy: 1.3 },
          { key: 'parentNetProfit', label: '归母净利润', value: 44514000000, unit: 'CNY' },
        ],
      },
      {
        period: '2026一季报',
        reportDate: '2026-03-31',
        reportType: '一季报',
        currency: 'CNY',
        cumulative: true,
        lines: [{ key: 'revenue', label: '营业总收入', value: 54702912385.23, unit: 'CNY' }],
      },
    ],
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0]!.values, [92278072083.21, 54702912385.23]);
  assert.equal(rows[0]!.latestYoy, 1.3);
  assert.deepEqual(rows[1]!.values, [44514000000, null], '某期没有该科目必须是 null，不能补 0');
});

test('财报面板：金额走万/亿、比率带 %、每股保留小数、缺值显示 —', () => {
  assert.equal(formatFinancialValue(92278072083.21, 'CNY'), '922.78亿');
  assert.equal(formatFinancialValue(-1454367, 'CNY'), '-145.44万');
  assert.equal(formatFinancialValue(19.6, '%'), '19.60%');
  assert.equal(formatFinancialValue(1.473, 'CNY/股'), '1.473');
  assert.equal(formatFinancialValue(null, 'CNY'), '—');
});

test('财报面板：高亮比率解析成指标卡', () => {
  assert.deepEqual(parseHighlight('资产负债率=49.55%（2026中报）'), { label: '资产负债率', value: '49.55%（2026中报）' });
  assert.deepEqual(parseHighlight('无等号'), { label: '无等号', value: '' });
});

test('资产详情与标的详情都渲染了财报面板', () => {
  for (const file of ['AssetDetailDialog.tsx', 'WatchlistDetailDialog.tsx']) {
    const source = readSource('pages', file);
    assert.ok(source.includes("from '../components/FinancialsPanel'"), file + ' 未引入财报面板');
    assert.ok(source.includes('<FinancialsPanel'), file + ' 未渲染财报面板');
  }
});

test('财报面板 SSR：三表数值 / 同比 / 缺失原因 / ETF 不适用四种输出都正确', () => {
  const base = {
    code: '600519',
    market: 'CN' as const,
    name: '贵州茅台',
    currency: 'CNY',
    standard: '中国会计准则',
    highlights: ['毛利率=89.73%（2026中报）'],
    sources: ['eastmoney' as const],
    warnings: [],
  };
  const data = {
    ...base,
    applicable: true,
    statements: [
      {
        kind: 'income' as const,
        label: '利润表',
        available: true,
        periods: [
          {
            period: '2026中报',
            reportDate: '2026-06-30',
            reportType: '中报',
            currency: 'CNY',
            cumulative: true,
            lines: [{ key: 'revenue', label: '营业总收入', value: 92278072083.21, unit: 'CNY', yoy: 1.3 }],
          },
        ],
      },
      { kind: 'cashflow' as const, label: '现金流量表', available: false, reason: '上游无接口', periods: [] },
    ],
  };
  const html = renderToString(
    <FinancialsView data={data} periods="4" onPeriodsChange={() => {}} showPeriods />,
  );
  // renderToString 会在相邻文本节点间插入 <!-- --> 水合标记，断言前先剥掉。
  const text = html.replace(/<!--[^>]*-->/g, '');
  assert.ok(text.includes('922.78亿'), '金额必须走中文万/亿格式');
  assert.ok(text.includes('同比'), '最新一期同比要展示');
  assert.ok(text.includes('毛利率'), '派生比率要渲染成指标卡');
  assert.ok(text.includes('数据缺失：现金流量表'), '缺失的报表必须写明，不能静默留空');
  assert.ok(text.includes('上游无接口'), '缺失必须带原因');
  assert.ok(text.includes('年初至今累计'), '累计口径说明不能丢');

  const etf = renderToString(
    <FinancialsView
      data={{ ...base, applicable: false, statements: [], highlights: ['不应出现'] }}
      periods="4"
      onPeriodsChange={() => {}}
      showPeriods={false}
    />,
  );
  assert.ok(etf.includes('该标的没有公司财报'), 'ETF/基金要走「不适用」空状态');
  assert.ok(!etf.includes('不应出现'), '不适用时不应渲染指标卡');
});

/* ───────────────────────── 财报对比页（/compare） ───────────────────────── */

test('财报对比：指标并排、缺值留空而不是 0、ETF 与错期都要给出提示', () => {
  const cn = (over: Partial<FinancialsResponse> = {}): FinancialsResponse => ({
    code: '600519',
    market: 'CN',
    name: '贵州茅台',
    currency: 'CNY',
    standard: '中国会计准则',
    applicable: true,
    highlights: ['毛利率=89.73%（2026中报）', '资产负债率=15.19%（2026中报）'],
    sources: ['eastmoney'],
    warnings: [],
    statements: [
      {
        kind: 'income',
        label: '利润表',
        available: true,
        periods: [
          {
            period: '2026中报',
            reportDate: '2026-06-30',
            reportType: '中报',
            currency: 'CNY',
            cumulative: true,
            lines: [
              { key: 'revenue', label: '营业总收入', value: 92278072083.21, unit: 'CNY', yoy: 1.3 },
              { key: 'parentNetProfit', label: '归母净利润', value: 44514000000, unit: 'CNY', yoy: -1.95 },
            ],
          },
        ],
      },
      {
        kind: 'cashflow',
        label: '现金流量表',
        available: true,
        periods: [
          {
            period: '2026中报',
            reportDate: '2026-06-30',
            reportType: '中报',
            currency: 'CNY',
            cumulative: true,
            lines: [{ key: 'netcashOperate', label: '经营活动产生的现金流量净额', value: 70690750119.06, unit: 'CNY' }],
          },
        ],
      },
    ],
    ...over,
  });

  const table = buildComparison([
    { key: 'CN:600519:stock', name: '贵州茅台', market: 'CN', code: '600519', type: 'stock', group: '持仓', data: cn() },
    {
      key: 'US:AAPL:stock',
      name: '苹果',
      market: 'US',
      code: 'AAPL',
      type: 'stock',
      group: '标的',
      data: cn({
        code: 'AAPL',
        market: 'US',
        name: '苹果',
        currency: 'USD',
        highlights: ['毛利率=49.07%（2026年 三季报）'],
        statements: [
          {
            kind: 'income',
            label: '利润表',
            available: true,
            periods: [
              {
                period: '2026年 三季报',
                reportDate: '2026-06-27',
                reportType: '三季报',
                currency: 'USD',
                cumulative: true,
                lines: [{ key: 'revenue', label: '营业收入', value: 364357000000, unit: 'USD' }],
              },
            ],
          },
          { kind: 'cashflow', label: '现金流量表', available: false, reason: '上游无接口', periods: [] },
        ],
      }),
    },
    { key: 'US:SCHD:etf', name: 'SCHD', market: 'US', code: 'SCHD', type: 'etf', group: '标的', data: cn({ applicable: false, statements: [], highlights: [], code: 'SCHD', name: 'SCHD' }) },
  ]);

  const rowOf = (label: string) => table.rows.find((row) => row.label === label)!;
  assert.deepEqual(rowOf('营业总收入').values, ['922.78亿CNY', '3643.57亿USD', null], '缺值必须是 null（页面渲染成 —），不能补 0');
  assert.deepEqual(rowOf('营业总收入').tones, [null, null, null]);
  assert.deepEqual(rowOf('营业总收入同比').values, ['+1.30%', null, null], '只有茅台有同比');
  assert.equal(rowOf('营业总收入同比').tones[0], 1.3, '同比要带原始数值供着色');
  assert.equal(rowOf('毛利率').values[2], null, 'ETF 没有财报指标');
  assert.ok(table.rows.some((row) => row.label === '经营活动现金流量净额'));
  // 苹果现金流缺失 + ETF 无财报 + 报告期不同，三类提示都要有
  assert.ok(table.warnings.some((line) => line.includes('SCHD') && line.includes('没有公司财报')));
  assert.ok(table.warnings.some((line) => line.includes('苹果') && line.includes('数据缺失')));
  assert.ok(table.warnings.some((line) => line.includes('不同期')));
});

test('财报对比：路由 / 导航 / 标题三处都已接线', () => {
  const app = readSource('App.tsx');
  const layout = readSource('components', 'Layout.tsx');
  assert.ok(app.includes("path=\"/compare\""), 'App.tsx 缺少 /compare 路由');
  assert.ok(app.includes('FinancialComparePage'), 'App.tsx 未引入对比页');
  assert.ok(layout.includes("to: '/compare'"), '导航缺少财报对比入口');
  assert.ok(layout.includes("'/compare':"), '页头标题表缺少 /compare');
});

/* ═══════════ 我的标的：预期期限 / 行情刷新；建议：来源标注 ═══════════ */

test('我的标的：预期收益必须带「多久到达」，并可主动刷新行情', () => {
  const page = readSource('pages', 'Watchlist.tsx');
  assert.ok(/expectedReturnHorizon/.test(page), '列表必须展示预期收益的到达期限');
  assert.ok(/未标注期限/.test(page), '未填写期限时要有占位文案');
  assert.ok(/api\.watchlist\.refresh\(/.test(page), '需要刷新行情的入口');
  assert.ok(/5 \* 60_000/.test(page), '只在行情过期时自动刷新，避免每次进页面都打数据源');
  assert.ok(/刷新行情/.test(page), '工具栏缺少「刷新行情」按钮');
  assert.ok(/fmtDateTime\(quoteAt\)/.test(page), '要显示行情更新时间，用户才知道数据新旧');
  assert.ok(/CN \/ HK \/ US/.test(page), '页面要说明候选覆盖三个市场（不再只挖 A 股）');

  const client = readSource('api', 'client.ts');
  assert.ok(/refresh: \(\)/.test(client), 'client 缺少 watchlist.refresh');

  const dialog = readSource('pages', 'WatchlistDetailDialog.tsx');
  assert.ok(/expectedReturnHorizon/.test(dialog), '详情浮窗应能查看 / 修改期限');
  assert.ok(/预期期限/.test(dialog), '详情浮窗缺少「预期期限」字段标签');
});

test('AI 投资建议：每条建议标注来源，池外建议有专门解释', () => {
  const page = readSource('pages', 'Advice.tsx');
  assert.ok(/ORIGIN_LABEL/.test(page) && /ORIGIN_TONE/.test(page), '缺少来源映射');
  assert.ok(/来源：/.test(page), '列表必须显示来源徽标');
  assert.ok(/池外/.test(page), '必须有「池外」这一来源');
  assert.ok(/跳过/.test(page) && /候选池/.test(page), '池外建议要解释它跳过了候选池筛选');
});

test('契约：WatchItem 带预期期限字段，AdviceItem 带来源字段', () => {
  const types = fs.readFileSync(path.resolve(SRC_DIR, '..', '..', 'shared', 'src', 'types.ts'), 'utf8');
  assert.ok(/expectedReturnHorizon: string/.test(types), 'WatchItem 缺少 expectedReturnHorizon');
  assert.ok(/expectedReturnHorizon\?: string/.test(types), 'UpdateWatchItemInput 缺少 expectedReturnHorizon');
  assert.ok(/export type AdviceOrigin/.test(types), '缺少 AdviceOrigin 类型');
  assert.ok(/origin: AdviceOrigin/.test(types), 'AdviceItem 缺少 origin');
});

test('契约：建议结果追踪的共享类型存在（前端与后端同一份口径）', () => {
  const types = fs.readFileSync(path.resolve(SRC_DIR, '..', '..', 'shared', 'src', 'types.ts'), 'utf8');
  assert.ok(/export interface AdviceOutcome\b/.test(types), '缺少 AdviceOutcome');
  assert.ok(/export interface AdviceOutcomeStats/.test(types), '缺少 AdviceOutcomeStats');
  assert.ok(/export interface AdviceOutcomeTrackResult/.test(types), '缺少 AdviceOutcomeTrackResult');
  assert.ok(/adviceReturnPct: number/.test(types), 'AdviceOutcome 缺少方向调整收益');
  assert.ok(/unmeasured: number/.test(types), '统计必须显式暴露不可度量条数');
});

test('建议结果追踪：胜率口径可见，不可度量不被隐藏', () => {
  const page = readSource('pages', 'Advice.tsx');
  assert.ok(/api\.advice\.outcomes/.test(page), '必须读取追踪结果');
  assert.ok(/api\.advice\.trackOutcomes/.test(page), '必须能手动触发重算');
  assert.ok(/方向胜率/.test(page) && /跑赢基准/.test(page), '缺少胜率 / 跑赢率指标');
  assert.ok(/还不可度量/.test(page), '必须显示不可度量条数，否则胜率会虚高');
  assert.ok(/建议日之后第一个交易日/.test(page), '必须写明基准口径（无前视偏差）');
  assert.ok(/卖出建议看跌幅/.test(page), '必须写明卖出建议的方向调整规则');
  assert.ok(/已冻结/.test(page), '超出观测窗口的最终结果要可见');
  assert.ok(/不是你的真实盈亏/.test(page), '必须提醒这不是用户的真实盈亏');
});

/* ═════════ 市场色标 / 详情页签 / 财报排版 / 推理面板 ═════════ */

test('市场色标：A股 / 港股 / 美股 各自一个 color class', () => {
  assert.ok(/market-tag market-CN/.test(renderToString(<MarketTag market="CN" />)), 'A股色标 class 缺失');
  assert.ok(/market-tag market-HK/.test(renderToString(<MarketTag market="HK" />)), '港股色标 class 缺失');
  assert.ok(/market-tag market-US/.test(renderToString(<MarketTag market="US" />)), '美股色标 class 缺失');
  const us = renderToString(<MarketTag market="US" />);
  assert.ok(us.includes('美股'), '色标文案缺失');
  const css = readSource('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const market of ['CN', 'HK', 'US']) {
    assert.ok(new RegExp('\\.market-tag\\.market-' + market).test(css), '缺少配色规则：' + market);
  }
  // 至少三个列表页用上了色标
  for (const page of ['Assets.tsx', 'Watchlist.tsx', 'Dashboard.tsx']) {
    assert.ok(/<MarketTag/.test(readSource('pages', page)), page + ' 未使用市场色标');
  }
});

test('详情弹窗：AI 分析独立页签，财报默认折叠', () => {
  const tabs = renderToString(
    <Tabs
      value="overview"
      onChange={() => undefined}
      options={[
        { value: 'overview', label: '概览' },
        { value: 'ai', label: 'AI 分析' },
      ]}
    />,
  );
  assert.ok(tabs.includes('role="tablist"'), '页签缺少 tablist 语义');
  assert.ok(tabs.includes('aria-selected="true"'), '当前页签未标记');
  assert.ok(tabs.includes('AI 分析'), '页签文案缺失');

  const closed = renderToString(
    <Disclosure title="财务报表（三表）">
      <span>表格内容</span>
    </Disclosure>,
  );
  assert.ok(closed.includes('aria-expanded="false"'), '折叠区默认应收起');
  assert.ok(!closed.includes('表格内容'), '收起时不应渲染内容');

  for (const dialog of ['AssetDetailDialog.tsx', 'WatchlistDetailDialog.tsx']) {
    const code = readSource('pages', dialog);
    assert.ok(/<Tabs/.test(code), dialog + ' 缺少页签');
    assert.ok(/value === 'ai'|tab === 'overview'/.test(code), dialog + ' 未按页签切换内容');
    assert.ok(/<Disclosure/.test(code), dialog + ' 财报未折叠');
    assert.ok(/<FinancialsPanel/.test(code), dialog + ' 财报面板丢失');
  }
});

test('财报指标卡：长值换行不超框（回归 StatCard 25px 溢出）', () => {
  assert.deepEqual(splitHighlightValue('-1.6322亿CNY（2026中报）'), { main: '-1.6322亿CNY', hint: '2026中报' });
  assert.deepEqual(splitHighlightValue('4.0816%（2026中报）'), { main: '4.0816%', hint: '2026中报' });
  assert.deepEqual(splitHighlightValue('0.1924倍（2026中报）'), { main: '0.1924倍', hint: '2026中报' });
  assert.deepEqual(splitHighlightValue('25.34%'), { main: '25.34%', hint: '' });

  const css = readSource('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/\.fin-highlight-value\s*\{[^}]*overflow-wrap:\s*anywhere/.test(css), '财报指标卡数值必须能换行');
  assert.ok(/\.stat-value\s*\{[^}]*overflow-wrap:\s*anywhere/.test(css), '通用统计卡也要防溢出');
  const panel = readSource('components', 'FinancialsPanel.tsx').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/StatCard/.test(panel), '财报指标不应再用 StatCard（25px 字号 + 长值会溢出）');
});

test('右下角推理面板：只保留折叠按钮，没有关闭按钮', () => {
  const dock = readSource('components', 'AgentActivityDock.tsx');
  assert.ok(/setCollapsed\(true\)/.test(dock), '必须保留折叠按钮');
  assert.ok(!/dismiss\b/.test(dock), '关闭按钮（dismiss）应已移除');
  assert.ok(!/✕/.test(dock), '不应再有 ✕ 图标');
});

/* ═══════ 资产类型标签 / 买卖点悬浮面板 / 资产走势 ═══════ */

test('资产类型标签：股票 / 场内基金 / 场外基金 三态可辨', () => {
  const stock = renderToString(<InstrumentTypeTag type="stock" />);
  const etf = renderToString(<InstrumentTypeTag type="etf" />);
  const fund = renderToString(<InstrumentTypeTag type="fund" />);
  assert.ok(/type-tag type-stock/.test(stock), '股票标签 class 缺失');
  assert.ok(stock.includes('股票'), '股票标签文案缺失');
  assert.ok(/type-tag type-etf/.test(etf), '场内基金标签 class 缺失');
  assert.ok(etf.includes('场内基金'), '场内基金文案缺失');
  assert.ok(/type-tag type-fund/.test(fund), '场外基金标签 class 缺失');
  assert.ok(fund.includes('场外基金'), '场外基金文案缺失');

  const css = readSource('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const kind of ['stock', 'etf', 'fund']) {
    assert.ok(new RegExp('\\.type-tag\\.type-' + kind).test(css), '缺少类型配色：' + kind);
  }

  // 用户明确要求在「AI 投资建议」里能看到类型
  const advice = readSource('pages', 'Advice.tsx');
  assert.ok(/<InstrumentTypeTag type=\{item\.type\}/.test(advice), 'AI 投资建议必须标出资产类型（股票/场内基金/场外基金）');
  for (const page of ['Assets.tsx', 'Watchlist.tsx']) {
    assert.ok(/<InstrumentTypeTag/.test(readSource('pages', page)), page + ' 未使用类型标签');
  }
});

test('买卖点悬浮面板：成交明细、当天匹配、备注转义', () => {
  const markers = [
    { kind: 'buy' as const, date: '2026-10-14', price: 22.18, shares: 100, amount: 2218, fee: 5.5, note: '首次建仓 <加仓>' },
    { kind: 'sell' as const, date: '2026-10-16', price: 25, shares: 50 },
  ];
  assert.equal(markersOnDate(markers, '2026-10-14').length, 1);
  assert.equal(markersOnDate(markers, '2026-10-15').length, 0);

  const buy = markerTooltipBlock(markers[0]!, 'CNY');
  assert.ok(buy.includes('买入'), '缺少买入标签');
  assert.ok(buy.includes('100'), '缺少成交份额');
  assert.ok(buy.includes('22.18'), '缺少成交价格');
  assert.ok(buy.includes('费用'), '缺少费用行');
  assert.ok(!buy.includes('<加仓>'), '备注必须转义，不能原样注入 HTML');
  assert.ok(buy.includes('&lt;加仓&gt;'), '备注转义结果不对');
  assert.ok(markerTooltipBlock(markers[1]!, 'CNY').includes('卖出'), '缺少卖出标签');

  const points = [{ date: '2026-10-14', open: 22, high: 23, low: 21.5, close: 22.5, volume: 1000 }] as SeriesPoint[];
  const html = seriesTooltipFormatter({ points, markers, currency: 'CNY', kind: 'kline' })([{ dataIndex: 0 }]);
  assert.ok(html.includes('2026-10-14'), '缺少日期');
  assert.ok(html.includes('开盘') && html.includes('收盘'), '缺少 K 线明细');
  assert.ok(html.includes('买入'), 'axis tooltip 未带出当天的买卖点');
  // 越界 dataIndex 不能抛异常（空字符串 = 不显示面板）
  assert.equal(seriesTooltipFormatter({ points, markers, kind: 'nav' })([{ dataIndex: 99 }]), '');
  const nav = seriesTooltipFormatter({ points, markers, currency: 'CNY', kind: 'nav' })([{ dataIndex: 0 }]);
  assert.ok(nav.includes('单位净值'), '净值曲线缺少净值明细');
});

test('交易记录 → 买卖点：带上金额 / 费用 / 备注，零价格不进图', () => {
  const markers = markersFromTransactions([
    { kind: 'buy', tradeDate: '2026-10-14', price: 22.18, shares: 100, fee: 5, note: '建仓' },
    { kind: 'sell', tradeDate: '2026-10-15', price: 0, shares: 10 },
  ]);
  assert.equal(markers.length, 1, '价格为 0 的交易不应进入图表');
  assert.equal(markers[0]!.kind, 'buy');
  assert.equal(markers[0]!.date, '2026-10-14');
  assert.equal(markers[0]!.amount, 2218);
  assert.equal(markers[0]!.fee, 5);
  assert.equal(markers[0]!.note, '建仓');

  // 两个图表都要把 formatter 接上，净值图还要带上货币
  const kline = readSource('components', 'charts/KLineChart.tsx');
  const nav = readSource('components', 'charts/NavChart.tsx');
  assert.ok(/seriesTooltipFormatter/.test(kline), 'K 线未接入买卖点悬浮面板');
  assert.ok(/seriesTooltipFormatter/.test(nav), '净值曲线未接入买卖点悬浮面板');
  assert.ok(/currency=\{series\.currency\}/.test(readSource('components', 'InstrumentDetailSections.tsx')), '净值图未传货币');
});

test('我的资产：当前走势会自动补刷，不是一列空白', () => {
  const page = readSource('pages', 'Assets.tsx');
  assert.ok(/api\.assets\.refresh\(/.test(page), '缺少刷新行情的入口');
  assert.ok(/missingSpark/.test(page), '缺走势时应自动补刷价格序列');
  assert.ok(/ageMs > 5 \* 60_000/.test(page), '只在行情过期时才自动刷新');
  assert.ok(/待刷新/.test(page), '无走势时要有占位提示而不是空白');
});

/* ═══════════ 买卖点 pin 悬浮浮窗（回归：悬停标签没有任何浮窗） ═══════════ */

test('买卖点悬浮面板：markPoint 必须显式 trigger=item，否则被全局 axis 触发器吞掉', () => {
  const marker = {
    kind: 'buy' as const,
    date: '2026-10-14',
    price: 22.18,
    shares: 100,
    amount: 2218,
    fee: 5.5,
    note: '建仓 <加仓>',
  };
  const item = markerPointData(marker, 'CNY');
  assert.equal(item.coord[0], '2026-10-14', 'pin 必须落在成交日');
  assert.equal(item.coord[1], 22.18, 'pin 必须落在成交价');
  assert.equal(item.symbol, 'pin');
  // 关键：全局 tooltip 是 trigger:'axis'，而 ECharts 命中 markPoint 元素时走
  // TooltipView._showSeriesItemTooltip，它把 [数据项模型, markPoint 模型,
  // 坐标系模型] 与全局 tooltip 级联后判断 `trigger !== 'item' → return`。
  // 只写 formatter 时 trigger 会继承成 'axis'，pin 上永远弹不出浮窗。
  assert.equal(item.tooltip.trigger, 'item', 'markPoint 必须显式声明 tooltip.trigger = item');
  assert.equal(
    typeof item.tooltip.formatter,
    'function',
    'formatter 必须是函数（字符串会被当作 {a} 模板再走一遍 formatTpl）',
  );
  const panel = (item.tooltip.formatter as () => string)();
  for (const needle of ['买入', '100', '22.18', '费用', '备注']) {
    assert.ok(panel.includes(needle), `成交明细面板缺少「${needle}」`);
  }
  assert.ok(!panel.includes('<加仓>'), '备注必须转义，不能原样注入 HTML');
  assert.equal(markerPointData({ ...marker, kind: 'sell' }).tooltip.trigger, 'item', '卖出 pin 同样要 item');

  // 两个图表必须共用这个数据项工厂，且不允许再手写 markPoint 的 tooltip。
  for (const file of ['KLineChart.tsx', 'NavChart.tsx']) {
    const source = readSource('components', 'charts', file);
    assert.ok(/markerPointData\(marker, currency\)/.test(source), `${file} 未使用 markerPointData`);
    assert.ok(
      !/tooltip:\s*\{\s*formatter:/.test(source),
      `${file} 仍手写 markPoint tooltip：会继承全局 trigger:'axis'，悬停 pin 时没有浮窗`,
    );
  }
});

test('买卖点悬浮面板：pin 只在 tradeMarkers 里构造（避免再抄一份丢掉 trigger）', () => {
  const dir = path.join(SRC_DIR, 'components', 'charts');
  const offenders: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    if (name !== 'tradeMarkers.ts' && /symbol:\s*'pin'/.test(source)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `这些文件自己构造了买卖 pin（应走 markerPointData）：${offenders.join(', ')}`);
});

/* ═══════════ 我的资产：AI 建议列的视觉渲染 ═══════════ */

test('我的资产「AI 建议」：判定胶囊 + 纯文本摘要 + 悬浮全文 Markdown', () => {
  const page = readSource('pages', 'Assets.tsx');
  assert.ok(/markdownVerdict/.test(page), '判定（买入/入选/观望/回避）必须提取成胶囊');
  assert.ok(/markdownSummary/.test(page), '摘要必须先剥掉 Markdown 标记');
  assert.ok(/<HoverTip/.test(page), '全文必须放进悬浮浮窗（列表装不下整篇分析）');
  assert.ok(/content=\{<Markdown text=\{asset\.aiSummary\}/.test(page), '浮窗里的分析必须按 Markdown 渲染');
  assert.ok(/hovertip-clamp/.test(page), '列表里只留两行摘要');
  assert.ok(/md-verdict tone-/.test(page), '判定胶囊要用报告渲染器同一套 class');
  assert.ok(!/title=\{asset\.aiSummary/.test(page), '不应再把原始 Markdown 塞进 title 属性（等于没渲染）');
  assert.ok(!/asset\.aiSummary \|\| '—'/.test(page), '空分析要走独立的空状态，而不是直接输出原文');

  // 摘要：Markdown 标记必须全部消失
  const summary = markdownSummary('## 一、组合简报\n\n**结论**：入选。质量分 74，估值处于合理区间。', 80);
  assert.ok(!/[*#|]/.test(summary), `摘要里不能残留 Markdown 标记：${summary}`);
  assert.ok(summary.includes('入选') && summary.includes('质量分 74'), '摘要丢了正文内容');
  const truncated = markdownSummary('这是一段很长的结论文字，需要被截断成一行摘要以适配表格列宽', 10);
  assert.equal(truncated.length, 11, '超长摘要要按字数截断');
  assert.ok(truncated.endsWith('…'), '截断要有省略号');
  assert.equal(markdownSummary('   '), '', '空白分析返回空串');

  // 判定：结论标签拆开后匹配动词，风险段落不产生判定
  assert.deepEqual(markdownVerdict('**结论**：入选。质量分 74，估值处于合理区间。'), { text: '入选', tone: 'buy' });
  assert.deepEqual(markdownVerdict('**结论**：回避。估值过高。'), { text: '回避', tone: 'sell' });
  assert.deepEqual(markdownVerdict('**结论**：观望。等待回调。'), { text: '观望', tone: 'neutral' });
  assert.deepEqual(markdownVerdict('- 操作建议：增持，回调分批。'), { text: '增持', tone: 'buy' });
  assert.equal(markdownVerdict('**主要风险**：行业景气度下滑。'), null);
  assert.equal(markdownVerdict(''), null);

  // 渲染层：与报告渲染器一致（同一套 verdict class）
  const html = renderToString(<Markdown text={'**结论**：入选。'} variant="compact" />);
  assert.ok(/md-verdict tone-buy/.test(html), '判定胶囊 class 与报告渲染器不一致');

  // 单元格本身：判定胶囊 + 摘要 + 触发区；空分析走占位而不是「—」原文。
  const asset = {
    id: 'asset-1',
    name: '贵州茅台',
    code: '600519',
    market: 'CN',
    type: 'stock',
    source: 'manual',
    currency: 'CNY',
    price: 22.18,
    priceAt: null,
    marketValue: 2218,
    unrealizedPnl: 0,
    unrealizedPnlPct: 0,
    dayChange: 0,
    dayChangePct: 0,
    firstBuyAt: null,
    lastBuyAt: null,
    lastSellAt: null,
    note: '',
    aiSummary: '## 一、结论\n\n**结论**：入选。质量分 74，估值处于合理区间。',
    aiSummaryAt: '2026-10-15T02:00:00.000Z',
    spark: [],
    createdAt: '2026-10-15T02:00:00.000Z',
    closed: false,
  } as AssetSummary;
  const cell = renderToString(<AiAdviceCell asset={asset} />);
  assert.ok(/class="hovertip-trigger/.test(cell), 'AI 建议单元格缺少悬浮触发区');
  assert.ok(/md-verdict tone-buy/.test(cell), '单元格没有渲染判定胶囊');
  assert.ok(cell.includes('入选') && cell.includes('质量分 74'), '摘要丢了正文内容');
  assert.ok(!cell.includes('**'), '摘要里仍残留 Markdown 标记（回到「素的 Markdown」）');
  assert.ok(cell.includes('悬浮 / 点击查看全文'), '缺少「悬浮查看全文」提示');
  assert.ok(/aria-label="查看完整 AI 分析：贵州茅台"/.test(cell), '触发区缺少无障碍名称');
  const emptyCell = renderToString(<AiAdviceCell asset={{ ...asset, aiSummary: '' }} />);
  assert.ok(emptyCell.includes('—') && !emptyCell.includes('hovertip'), '没有 AI 分析时应走占位，而不是渲染空浮窗');
});

/* ═══════════ 推理进度：结束后必须收尾 ═══════════ */

function streamState(over: Partial<AgentStreamApi>): AgentStreamApi {
  return {
    running: false,
    runId: null,
    kind: null,
    title: '',
    steps: [],
    text: '',
    progress: null,
    entities: [],
    toolEvents: [],
    budget: null,
    metrics: null,
    metricsEvents: [],
    error: null,
    finished: null,
    start: async () => streamState({}),
    cancel: () => undefined,
    reset: () => undefined,
    ...over,
  };
}

test('推理进度：完成后不再显示「第 4/20 轮推理」，进度条满格转成功色', () => {
  const progress = { done: 4, total: 20, label: '第 4/20 轮推理' };

  const running = streamState({ running: true, progress });
  assert.equal(runTimelineState(running), 'running');
  assert.deepEqual(runProgressView(running), { label: '第 4/20 轮推理', meta: '4/20', value: 4, tone: 'default' });
  const runningHtml = renderToString(<RunTimeline stream={running} />);
  assert.ok(runningHtml.includes('第 4/20 轮推理'), '运行中要展示服务端的轮次标签');

  // 收敛式结束（第 4 轮得出结论）：最后一条 progress 就是 4/20，不能照搬成「还在跑」。
  const done = streamState({ progress, finished: { status: 'done', summary: '共 4 轮完成' } });
  assert.equal(runTimelineState(done), 'done');
  assert.deepEqual(runProgressView(done), { label: '分析完成', meta: '共 4 轮推理', value: 20, tone: 'ok' });
  const doneHtml = renderToString(<RunTimeline stream={done} />);
  assert.ok(doneHtml.includes('分析完成'), '完成后进度区必须给出终态文案');
  assert.ok(!doneHtml.includes('第 4/20 轮推理'), '完成后不能再显示「第 4/20 轮推理」');
  assert.ok(/progress progress-ok/.test(doneHtml), '完成后进度条应转成成功色');
  assert.ok(/width:100%/.test(doneHtml), '完成后进度条应满格');

  // 失败 / 中断同样要有终态，不能停在半路。
  const failed = streamState({ progress, error: '上游 502', finished: { status: 'error', summary: '上游 502' } });
  assert.equal(runTimelineState(failed), 'error');
  assert.deepEqual(runProgressView(failed), { label: '已失败', meta: '第 4/20 轮中断', value: 4, tone: 'error' });
  assert.ok(/progress progress-error/.test(renderToString(<RunTimeline stream={failed} />)), '失败要用红色进度条');

  const stopped = streamState({ progress });
  assert.equal(runTimelineState(stopped), 'stopped');
  assert.deepEqual(runProgressView(stopped), { label: '已中断', meta: '第 4/20 轮', value: 4, tone: 'muted' });
  assert.ok(/progress progress-muted/.test(renderToString(<RunTimeline stream={stopped} />)), '中断要用灰色进度条');

  // 没有进度事件时不能凭空造一条。
  assert.equal(runProgressView(streamState({ running: true })), null);

  // 右下角面板的元信息同理：结束后是「共 N 轮推理」；状态徽标也必须复用同一套终态。
  const dock = readSource('components', 'AgentActivityDock.tsx');
  assert.ok(
    /running \? `第 \$\{latest\.turn\} 轮推理` : `共 \$\{latest\.turn\} 轮推理`/.test(dock),
    '面板元信息在结束后必须改成总轮次',
  );
  assert.ok(/runTimelineState\(stream\)/.test(dock), '状态徽标必须复用 runTimelineState（中断不能算已完成）');
  assert.ok(/stopped: '已中断'/.test(dock), '缺少「已中断」状态文案');

  // 终态配色必须有对应 CSS，否则 tone 只是空 class。
  const css = readSource('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const tone of ['ok', 'error', 'muted']) {
    assert.ok(css.includes(`.progress-${tone} .progress-bar`), `缺少终态进度条配色：progress-${tone}`);
  }
});

/* ─────────── 未完成的运行：Dashboard 顶部提示 + 一键续跑 ─────────── */

test('selectResumableRuns：只挑 error 的 run，且尊重用户「忽略」', () => {
  const run = (id: string, status: AgentRunSummary['status']): AgentRunSummary => ({
    id,
    kind: 'asset-analysis',
    status,
    title: `run ${id}`,
    summary: '',
    error: status === 'error' ? '运行被中断（服务进程在本次分析结束前退出，重启后已标记为失败）。' : null,
    turns: 1,
    stepCount: 2,
    startedAt: '2026-10-15T10:01:57.734Z',
    finishedAt: '2026-10-15T10:04:36.834Z',
  });

  const runs = [run('a', 'error'), run('b', 'done'), run('c', 'error'), run('d', 'running')];
  assert.deepEqual(
    selectResumableRuns(runs, []).map((item) => item.id),
    ['a', 'c'],
    '只有 error 的 run 需要续跑（done 会被服务端 409 拒绝，running 还在跑）',
  );
  assert.deepEqual(
    selectResumableRuns(runs, ['a']).map((item) => item.id),
    ['c'],
    '被忽略的 run 不再提示',
  );
  assert.deepEqual(selectResumableRuns([], ['a']), []);
});

test('Dashboard 顶部挂载「未完成运行」提示条，并指向续跑接口', () => {
  const dashboard = readSource('pages', 'Dashboard.tsx');
  assert.ok(
    /<InterruptedRunsAlert \/>/.test(dashboard),
    'Dashboard 必须挂载未完成运行提示条（服务重启打断的分析要能一键续跑）',
  );

  const alert = readSource('components', 'InterruptedRunsAlert.tsx');
  assert.ok(/status === 'error'/.test(alert), '提示条只应基于 status=error 判定');
  assert.ok(
    /\/agent\/runs\/\$\{encodeURIComponent\(target\.id\)\}\/resume/.test(alert),
    '提示条必须调用 P1-3 的续跑接口 /api/agent/runs/:id/resume',
  );
  assert.ok(/api\.agent\.runs\(20\)/.test(alert), '提示条应复用现有的运行列表接口，不新增服务端接口');
});

/* ═════════════ 定时任务（数组：可添加多个） ═════════════ */

/** 建一个用于草稿测试的 Settings 桩（只填定时任务相关的字段）。 */
function settingsStub(schedules: Draft['schedules']): Parameters<typeof toDraft>[0] {
  return {
    persona: 'balanced',
    reportStyle: 'professional',
    llm: {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      temperature: 0,
      maxTokens: 0,
      fastModel: '',
      timeoutMs: 180_000,
      contextTokens: 48_000,
    },
    hasApiKey: false,
    apiKeyMasked: '',
    dataSources: {},
    budget: { CN: 5000, HK: 5000, US: 1000 },
    schedules: schedules.map((task) => ({
      id: task.id,
      name: task.name,
      enabled: task.enabled,
      mode: task.mode,
      intervalMinutes: Number(task.intervalMinutes) || 1440,
      dailyTime: task.dailyTime,
      runAssetAnalysis: task.runAssetAnalysis,
      runWatchlistAnalysis: task.runWatchlistAnalysis,
      runIpoAnalysis: task.runIpoAnalysis,
      runAdvice: task.runAdvice,
    })) as Parameters<typeof toDraft>[0]['schedules'],
    enforceBudget: true,
    watchlistCandidateLimit: 5,
    watchlistRetireDeleteRuns: 3,
    toolPolicy: { deny: [], requireWriteApproval: false },
    mcpServers: [],
    updatedAt: '2026-10-16T09:00:00.000+08:00',
  } as Parameters<typeof toDraft>[0];
}

test('设置页定时任务：展开后是紧凑三列表单（名称 / 触发方式 / 时间或间隔 + 步骤）', () => {
  const html = renderToString(
    <ToastProvider>
      <SchedulesCard
        value={[newScheduleDraft({ id: 'sched_a', name: '工作日盘前', dailyTime: '08:45' })]}
        onChange={() => undefined}
        defaultExpandedId="sched_a"
      />
    </ToastProvider>,
  );
  assert.ok(html.includes('sched-editor'), '展开后必须渲染编辑区');
  assert.ok(html.includes('sched-form'), '编辑区必须用紧凑栅格（不是整屏 form-grid）');
  for (const label of ['任务名称', '触发方式', '每天时间']) {
    assert.ok(html.includes(label), `展开后缺少「${label}」`);
  }
  assert.ok(html.includes('aria-haspopup="listbox"'), '触发方式用紧凑下拉，而不是占宽的分段控件');
  assert.ok(html.includes('资产分析') && html.includes('标的分析') && html.includes('投资建议'), '步骤勾选缺失');
  assert.ok(html.includes('收起'), '展开后按钮应变成「收起」');
});

test('定时任务草稿：新增/删除/改时间都能生成 schedules 补丁（整体替换）', () => {
  const base = toDraft(settingsStub([newScheduleDraft({ id: 'sched_a', name: '盘前' })]));
  assert.equal(base.schedules.length, 1, '服务端已有任务要进草稿');
  assert.equal(base.schedules[0]!.id, 'sched_a');

  // 没改动 → 不下发 schedules（避免覆盖服务端并发更新）。
  assert.equal(buildInput(base, base).schedules, undefined);

  // 新增一个任务 → 数组整体下发。
  const added: Draft = { ...base, schedules: [...base.schedules, newScheduleDraft({ id: 'sched_b', name: '周末' })] };
  const addedInput = buildInput(added, base);
  assert.equal(addedInput.schedules?.length, 2);
  assert.deepEqual(addedInput.schedules?.map((task) => task.id), ['sched_a', 'sched_b']);

  // 删除任务 → 空数组也要下发（否则服务端会保留旧任务）。
  const removed = buildInput({ ...base, schedules: [] }, base);
  assert.deepEqual(removed.schedules, []);

  // 改时间 / 改步骤 → 下发解析后的值。
  const edited: Draft = {
    ...base,
    schedules: [{ ...base.schedules[0]!, mode: 'interval', intervalMinutes: '90', runAdvice: false }],
  };
  const editedInput = buildInput(edited, base);
  assert.equal(editedInput.schedules?.[0]!.mode, 'interval');
  assert.equal(editedInput.schedules?.[0]!.intervalMinutes, 90);
  assert.equal(editedInput.schedules?.[0]!.runAdvice, false);
});

test('定时任务草稿：非法值在提交前就被拦下（时间 / 间隔 / 空步骤 / 空名称）', () => {
  const draft = newScheduleDraft({ name: '测试' });
  assert.throws(() => toSchedulePayload({ ...draft, dailyTime: '25:99' }), /HH:mm/);
  assert.throws(() => toSchedulePayload({ ...draft, mode: 'interval', intervalMinutes: '' }), /必须是有效数字/);
  assert.throws(() => toSchedulePayload({ ...draft, mode: 'interval', intervalMinutes: 'abc' }), /必须是有效数字/);
  // 四个步骤（含 2026-10 新增的打新分析）都不选才算空步骤。
  assert.throws(
    () =>
      toSchedulePayload({
        ...draft,
        runAssetAnalysis: false,
        runWatchlistAnalysis: false,
        runIpoAnalysis: false,
        runAdvice: false,
      }),
    /至少要选择一个/,
  );
  // 只勾「打新分析」是合法的：它是与资产/标的/建议并列的独立步骤。
  const ipoOnly = toSchedulePayload({
    ...draft,
    runAssetAnalysis: false,
    runWatchlistAnalysis: false,
    runIpoAnalysis: true,
    runAdvice: false,
  });
  assert.equal(ipoOnly.runIpoAnalysis, true);
  assert.equal(ipoOnly.runAssetAnalysis, false);
  assert.throws(() => toSchedulePayload({ ...draft, name: '   ' }), /名称/);

  // 合法值：切换触发方式不会把另一个模式的配置改成默认值。
  const payload = toSchedulePayload({ ...draft, mode: 'daily', dailyTime: '08:45', intervalMinutes: '45' });
  assert.equal(payload.mode, 'daily');
  assert.equal(payload.dailyTime, '08:45');
  assert.equal(payload.intervalMinutes, 45, 'daily 模式下也要保留用户填过的间隔');
});

test('设置页定时任务：紧凑列表（一行一个任务）默认收起，编辑才展开', () => {
  const html = renderToString(
    <ToastProvider>
      <SchedulesCard
        value={[newScheduleDraft({ id: 'sched_a', name: '工作日盘前', dailyTime: '08:45' })]}
        onChange={() => undefined}
        nextRuns={[{ id: 'sched_a', name: '工作日盘前', nextRunAt: '2026-10-17T00:45:00.000Z' }]}
      />
    </ToastProvider>,
  );
  assert.ok(html.includes('AI 定时任务'), '缺少定时任务卡片标题');
  assert.ok(html.includes('添加任务'), '必须能添加多个任务');
  // 一行内看全：名称 / 触发方式 / 步骤 / 下次运行。
  assert.ok(html.includes('工作日盘前'), '任务名未渲染');
  assert.ok(html.includes('每天 08:45'), '触发方式摘要未渲染');
  assert.ok(html.includes('资产·标的·打新·建议'), '步骤摘要未渲染');
  assert.ok(html.includes('sched-row'), '必须用紧凑行渲染（不是每条任务一整块表单）');
  assert.ok(html.includes('下次'), '必须显示服务端返回的下次运行时间');
  // 默认收起：编辑表单（任务名称 / 触发方式 / 间隔输入）不进首屏 DOM。
  assert.ok(!html.includes('sched-editor'), '默认不应展开编辑表单（否则又变成占地方的整块表单）');
  assert.ok(!html.includes('任务名称'), '默认不应展开编辑表单');
});

test('设置页定时任务：停用的任务压暗并标注「已停用」', () => {
  const html = renderToString(
    <ToastProvider>
      <SchedulesCard
        value={[
          newScheduleDraft({ id: 'sched_off', name: '周末挖标的', enabled: false, mode: 'interval', intervalMinutes: '360' }),
        ]}
        onChange={() => undefined}
        nextRuns={[]}
      />
    </ToastProvider>,
  );
  assert.ok(html.includes('is-off'), '停用任务必须有 is-off（压暗）样式');
  assert.ok(html.includes('每 360 分钟'), '按间隔的摘要未渲染');
  assert.ok(html.includes('已停用'), '停用状态必须写明');
  assert.ok(!html.includes('下次'), '停用任务不该显示下次运行时间');
});

test('设置页接线：定时任务走草稿 + 整体提交，Dashboard 徽标显示任务数量', () => {
  const page = readSource('pages', 'Settings.tsx');
  assert.ok(/<SchedulesCard/.test(page), '设置页未挂载定时任务卡片');
  assert.ok(/schedules: next/.test(page), '卡片改动必须写回草稿的 schedules');
  assert.ok(/signals\.nextRuns/.test(page), '每个任务的下次运行时间应来自 /api/dashboard 的 signs.nextRuns');
  assert.ok(!/scheduleMode/.test(page), '旧的单任务字段不应再出现在设置页');

  const card = readSource('pages', 'SettingsSchedules.tsx');
  assert.ok(/MAX_SCHEDULES/.test(card), '添加上限必须与共享常量一致');
  assert.ok(/props\.onChange\(\[\.\.\.tasks/.test(card), '添加任务 = 往数组里追加（数组形态的核心）');
  assert.ok(/tasks\.filter\(\(entry\) => entry\.id !== task\.id\)/.test(card), '删除任务必须按 id 从数组移除');

  const draft = readSource('pages', 'settingsDraft.ts');
  assert.ok(/schedules: ScheduleTaskDraft\[\]/.test(draft), '草稿必须用数组保存多个任务');
  assert.ok(/input\.schedules = draft\.schedules\.map\(toSchedulePayload\)/.test(draft), '保存时必须整体提交 schedules 数组');

  const dashboard = readSource('pages', 'Dashboard.tsx');
  assert.ok(/signals\.nextRuns/.test(dashboard), 'Dashboard 徽标应显示任务数量');
});

/* ───────────────────────── 新股打新（IPO）───────────────────────── */

/** 造一条最小的 IpoOffer，只填排序/展示断言用得到的字段。 */
function ipoOffer(over: Partial<IpoOffer> & { code: string; name: string }): IpoOffer {
  return {
    id: `ipo-${over.code}`,
    uid: `CN:${over.code}`,
    market: 'CN',
    subscribeCode: over.code,
    source: 'eastmoney-ipo',
    exchange: '',
    board: '',
    issuePrice: 0,
    priceLow: 0,
    priceHigh: 0,
    currency: 'CNY',
    lotSize: 0,
    maxShares: 0,
    subscribeStart: null,
    subscribeEnd: null,
    allotmentDate: null,
    listingDate: null,
    issueShares: 0,
    raiseAmount: 0,
    issuePe: 0,
    industryPe: 0,
    winningRate: 0,
    oversubscribe: 0,
    sponsor: '',
    industry: '',
    prospectusUrl: '',
    status: 'subscribing',
    advice: '',
    verdict: null,
    verdictReason: '',
    suggestedShares: 0,
    winProbability: 0,
    expectedReturn: 0,
    confidence: null,
    qualityScore: 0,
    adviceAt: null,
    adviceRunId: null,
    note: '',
    createdAt: '2026-10-16T09:00:00.000+08:00',
    updatedAt: '2026-10-16T09:00:00.000+08:00',
    subscription: null,
    ...over,
  } as IpoOffer;
}

test('打新列表排序：默认按申购截止日升序，缺截止日与已上市的排最后（不冒充机会）', () => {
  const soon = ipoOffer({ code: '000001', name: '明天截止', subscribeEnd: '2026-10-17' });
  const later = ipoOffer({ code: '000002', name: '下周截止', subscribeEnd: '2026-10-23' });
  const unknown = ipoOffer({ code: '000003', name: '上游没给日期', subscribeStart: null, subscribeEnd: null });
  const listed = ipoOffer({ code: '000004', name: '已经上市', subscribeEnd: '2026-10-01', status: 'listed' });

  const asc = sortIpoOffers([later, listed, unknown, soon], 'subscribeEnd', 'asc');
  assert.deepEqual(asc.map((offer) => offer.code), ['000001', '000002', '000003', '000004']);

  const desc = sortIpoOffers([soon, later], 'subscribeEnd', 'desc');
  assert.deepEqual(desc.map((offer) => offer.code), ['000002', '000001']);

  // AI 优质分默认从高到低（最值得看的排最前）。
  const scored = sortIpoOffers(
    [
      ipoOffer({ code: 'A', name: 'a', qualityScore: 30 }),
      ipoOffer({ code: 'B', name: 'b', qualityScore: 88 }),
      ipoOffer({ code: 'C', name: 'c', qualityScore: 60 }),
    ],
    'qualityScore',
    'desc',
  );
  assert.deepEqual(scored.map((offer) => offer.code), ['B', 'C', 'A']);

  // 原数组不能被原地改（否则 React state 会被悄悄改写）。
  const input = [later, soon];
  sortIpoOffers(input, 'subscribeEnd', 'asc');
  assert.deepEqual(input.map((offer) => offer.code), ['000002', '000001']);

  // 按上市日排序时，没给上市日的同样沉底。
  const byListing = sortIpoOffers(
    [
      ipoOffer({ code: 'X', name: 'x', listingDate: null }),
      ipoOffer({ code: 'Y', name: 'y', listingDate: '2026-10-20' }),
      ipoOffer({ code: 'Z', name: 'z', listingDate: '2026-10-18' }),
    ],
    'listingDate',
    'asc',
  );
  assert.deepEqual(byListing.map((offer) => offer.code), ['Z', 'Y', 'X']);

  // 已上市的一律沉底，即使它的申购截止日更早。
  const mixed = sortIpoOffers(
    [listed, ipoOffer({ code: 'N', name: '还没上市', subscribeEnd: '2026-11-30' })],
    'subscribeEnd',
    'desc',
  );
  assert.equal(mixed.at(-1)!.code, '000004');
});

test('打新接线：三个需求都在界面上有入口（收集 / AI 分析 / 中签入账）', () => {
  const app = readSource('App.tsx');
  assert.ok(/path="\/ipo"/.test(app) || /'\/ipo'/.test(app), 'App 必须注册 /ipo 路由');

  const layout = readSource('components', 'Layout.tsx');
  assert.ok(/新股打新/.test(layout), '侧边栏必须有「新股打新」入口');

  const page = readSource('pages', 'Ipo.tsx');
  assert.ok(/api\.ipo\.refresh/.test(page), '需求①：页面上必须能一键抓取三地新股');
  assert.ok(/\/ipo\/analyze/.test(page), '需求②：必须能触发 AI 打新分析（SSE）');
  assert.ok(/market === 'CN'|MARKETS/.test(page), '市场筛选要覆盖 A股/港股/美股');

  const detail = readSource('pages', 'IpoDetailDialog.tsx');
  assert.ok(/api\.ipo\.subscribe/.test(detail), '必须能登记「我申购了 N 股」');
  assert.ok(/api\.ipo\.allot/.test(detail), '需求③：必须能回报中签股数');
  assert.ok(/写入资产|入账/.test(detail), '中签入账必须在界面上说清楚会写进资产');

  const advice = readSource('pages', 'Advice.tsx');
  assert.ok(/api\.ipo\.list/.test(advice), 'AI 投资建议页要带上打新标的');
  assert.ok(/打新/.test(advice), 'AI 投资建议页要有打新板块');
});

test('打新建议配色：建议放弃必须是红色（警示），建议申购是绿色（值得下手）', () => {
  // 用户反馈：原来「放弃」是绿色（复用 badge-sell），读起来像好消息。颜色按风险语义定死。
  assert.equal(IPO_VERDICT_TONE.avoid, 'ipo-avoid', '建议放弃必须是警示色');
  assert.equal(IPO_VERDICT_TONE.subscribe, 'ipo-subscribe', '建议申购必须是机会色');
  assert.equal(IPO_VERDICT_TONE.neutral, 'default');

  const css = readSource('styles.css');
  const avoidRule = /\.badge-ipo-avoid\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  const subscribeRule = /\.badge-ipo-subscribe\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.ok(/rgba\(255,\s*90,\s*95/.test(avoidRule), '建议放弃要用红（--pos 系警示色）');
  assert.ok(/rgba\(47,\s*191,\s*143/.test(subscribeRule), '建议申购要用绿（--neg 系机会色）');
  // 不能再让「放弃」借用 badge-sell（那是行情里的卖出=绿）。
  const iconCss = /\.badge-ipo-avoid[^}]*\}/.exec(css)?.[0] ?? '';
  assert.ok(!/badge-sell/.test(iconCss));
  assert.ok(IPO_VERDICT_HINT.avoid.includes('风险提示'), '颜色语义要在 tooltip 里写明，避免被当成涨跌色');

  // 三个页面必须共用同一份口径，不能各写一份 VERDICT_TONE。
  for (const page of ['Ipo.tsx', 'IpoDetailDialog.tsx', 'Advice.tsx']) {
    const src = readSource('pages', page);
    assert.ok(/IPO_VERDICT_TONE/.test(src), `${page} 必须用共享的 IPO_VERDICT_TONE`);
    assert.ok(!/VERDICT_TONE\s*[:=]\s*\{/.test(src), `${page} 不得再自建一份 VERDICT_TONE`);
  }
});

test('打新建议信息完整：胜率与预期收益都要有数、要能看懂单位', () => {
  const offer = ipoOffer({ code: '09999', name: '测试标的', verdict: 'subscribe', winProbability: 0.65, expectedReturn: 18.5 });
  assert.equal(winRateText(offer), '胜率 65%');
  assert.equal(expectedReturnText(offer), '预期 +18.5%');
  assert.equal(expectedValueText(offer), '期望值 +12%', '期望值 = 胜率 × 预期收益（0.65 × 18.5 ≈ 12）');
  assert.equal(expectedReturnClass(offer), 'ipo-pos');

  // 预期破发：必须显示负号并给出风险色，不能显示成「+」。
  const bad = ipoOffer({ code: '09998', name: '破发标的', verdict: 'avoid', winProbability: 0.3, expectedReturn: -6 });
  assert.equal(expectedReturnText(bad), '预期 -6%');
  assert.equal(expectedReturnClass(bad), 'ipo-neg');

  // 没分析过的：如实说「待分析 / 未评估」，绝不拿 0 冒充结论。
  const fresh = ipoOffer({ code: '09997', name: '没分析' });
  assert.equal(winRateText(fresh), '待分析');
  assert.equal(expectedReturnText(fresh), '待分析');
  assert.equal(expectedValueText(fresh), '待分析');
  const analyzedNoNumbers = ipoOffer({ code: '09996', name: '旧结论', verdict: 'neutral' });
  assert.equal(winRateText(analyzedNoNumbers), '胜率未评估', '老库里的结论没有胜率 → 明确说未评估');
  assert.equal(expectedReturnText(analyzedNoNumbers), '预期收益未评估');
  assert.equal(expectedValueText(analyzedNoNumbers), '期望值未评估');
  // 详情卡用的是「只取值」版本（卡片自带标签），不能出现「胜率（AI 推算） 胜率未评估」这种重复。
  assert.equal(winRateValue(offer), '65%');
  assert.equal(expectedReturnValue(offer), '+18.5%');
  assert.equal(expectedValueValue(offer), '+12%');
  assert.equal(winRateValue(analyzedNoNumbers), '未评估');
  assert.equal(expectedReturnValue(analyzedNoNumbers), '未评估');

  // 三个页面都要把这两个数显示出来（列表列 / 详情卡 / 建议页列）。
  for (const page of ['Ipo.tsx', 'IpoDetailDialog.tsx', 'Advice.tsx']) {
    const src = readSource('pages', page);
    assert.ok(/winRate(Text|Value)/.test(src), `${page} 必须显示胜率`);
    assert.ok(/expectedReturn(Text|Value)/.test(src), `${page} 必须显示预期收益`);
  }
  // 中签率（上游）与胜率（AI 推算）必须分开表述，不能混为一谈。
  const page = readSource('pages', 'Ipo.tsx');
  assert.ok(/中签率.*回答「能不能买到」/.test(page), '界面要说明中签率与胜率的口径差异');
});

test('打新建议必须给出「简明理由」，并解释「高胜率为何本期不参与」', () => {
  // ① AI 写入的一句话理由优先展示。
  const stored = ipoOffer({
    code: '001381',
    name: '皇冠新材',
    verdict: 'neutral',
    winProbability: 0.75,
    expectedReturn: 25,
    verdictReason: '本月 A 股预算仅剩 734 元，一手 500 股 × 16.98 元 = 8,490 元打不起（标的本身不差）',
  });
  assert.equal(
    verdictReasonText(stored),
    '本月 A 股预算仅剩 734 元，一手 500 股 × 16.98 元 = 8,490 元打不起（标的本身不差）',
    '有归档理由时直接用，不能再截断或改写',
  );

  // ② 老数据（升级前写入的结论）没有该字段：从建议正文的「结论」首句提取，
  //    这样用户升级后立刻能看懂「胜率 75% 为什么不参与」——原因就写在结论里（预算不够）。
  const legacy = ipoOffer({
    code: '001381',
    name: '皇冠新材',
    verdict: 'neutral',
    winProbability: 0.75,
    advice:
      '**结论**：中性观察，本次 **不申购（0 股）**。两条硬约束：①深主板 **1 手 500 股×16.98 元=8,490 元**，远超 A 股当月预算剩余 **734 元**；②定价折价仅 6.4%。\n\n**① 发行定价**：……',
  });
  const legacyReason = verdictReasonText(legacy);
  assert.match(legacyReason, /中性观察/, '老数据要能从正文里提取结论');
  assert.match(legacyReason, /预算剩余/, '预算缺口必须能读出来 —— 这正是用户困惑的答案');
  assert.ok(!legacyReason.includes('**'), '提取时要剥掉 Markdown 加粗标记');
  assert.ok(!legacyReason.includes('\n'), '要压成一行，便于列表展示');

  // ③ 完全没有结论信息 → 空串（界面显示「—」），不编造理由。
  assert.equal(verdictReasonText(ipoOffer({ code: '000001', name: '没分析' })), '');

  // ④ 列表只放一行，完整内容在 title 里。
  assert.equal(truncateText('一二三四五六', 4), '一二三四…');
  assert.equal(truncateText('短理由', 10), '短理由');

  // ⑤ 三个页面都要显示这条理由（列表列 / 详情 / 建议页「推荐理由」列）。
  for (const page of ['Ipo.tsx', 'IpoDetailDialog.tsx', 'Advice.tsx']) {
    const src = readSource('pages', page);
    assert.ok(/verdictReasonText/.test(src), `${page} 必须显示一句话推荐理由`);
    assert.ok(/truncateText|推荐理由/.test(src), `${page} 的理由要简明（截断或单独成列）`);
  }
  const advicePage = readSource('pages', 'Advice.tsx');
  assert.ok(/推荐理由/.test(advicePage), '建议页要有「推荐理由」列');
  assert.ok(/本期该不该打/.test(advicePage), '要说明结论含预算约束，不是单纯看空');
  const detailPage = readSource('pages', 'IpoDetailDialog.tsx');
  assert.ok(/推荐理由/.test(detailPage), '详情里要写明推荐理由');
  // 口径提示：verdict 是「本期是否参与」，与「上市后涨不涨」是两件事。
  assert.ok(/胜率高但本期不申购|胜率高但显示中性观察|本期不申购/.test(readSource('pages', 'Ipo.tsx')));
});

test('AI 投资建议页：建议放弃的标的不再占位，只报个数', () => {  const subscribing = ipoOffer({ code: 'A1', name: '值得打', verdict: 'subscribe', winProbability: 0.7, expectedReturn: 20 });
  const neutral = ipoOffer({ code: 'A2', name: '中性', verdict: 'neutral' });
  const avoided = ipoOffer({ code: 'A3', name: '已放弃', verdict: 'avoid', winProbability: 0.2, expectedReturn: -8 });
  const fresh = ipoOffer({ code: 'A4', name: '刚刷新还没分析' });
  const listed = ipoOffer({ code: 'A5', name: '已上市', status: 'listed', verdict: 'subscribe' });

  const { actionable, avoided: avoidedList } = selectActionableIpoOffers([subscribing, neutral, avoided, fresh, listed]);
  const codes = actionable.map((offer) => offer.code);
  assert.deepEqual(codes, ['A1', 'A2', 'A4'], '建议放弃的不列进建议页；已上市的不是「还能下手的机会」');
  assert.deepEqual(
    avoidedList.map((offer) => offer.code),
    ['A3'],
    '放弃的标的要单独计数（页面上要说明「另有 N 只建议放弃」）',
  );

  // 建议页的登记入口：必须复用打新详情浮窗（同一套申购/中签校验），并直接滚到登记段。
  const advice = readSource('pages', 'Advice.tsx');
  assert.ok(/IpoDetailDialog/.test(advice), '建议页要能直接打开登记浮窗（需求：在建议页也能登记）');
  assert.ok(/focusRegister/.test(advice), '打开时必须定位到登记段，而不是让用户自己找');
  assert.ok(/setRegisterId/.test(advice), '每行都要有登记入口');
  assert.ok(/api\.ipo\.subscribe|IpoDetailDialog/.test(advice));

  const detail = readSource('pages', 'IpoDetailDialog.tsx');
  assert.ok(/focusRegister/.test(detail), '浮窗要支持 focusRegister');
  assert.ok(/scrollIntoView/.test(detail), 'focusRegister 要真的把视图带过去');
});
