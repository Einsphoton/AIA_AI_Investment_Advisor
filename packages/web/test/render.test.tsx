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
import type { InferenceMetrics } from '@aia/shared';
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
import { Dropdown, ToastProvider } from '../src/components/ui';
import { LlmProviderField } from '../src/pages/SettingsLlmProvider';
import { ModelField } from '../src/pages/SettingsModelField';

const ROUTES: { path: string; expect: string[] }[] = [
  { path: '/', expect: ['Dashboard'] },
  { path: '/assets', expect: ['我的资产'] },
  { path: '/watchlist', expect: ['我的标的'] },
  { path: '/advice', expect: ['AI 投资建议'] },
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

test('侧边栏包含全部七个导航入口', () => {
  const html = render('/');
  for (const label of ['Dashboard', '我的资产', '我的标的', 'AI 投资建议', 'AI Chat', '活动与审计', '设置']) {
    assert.ok(html.includes(label), `侧边栏缺少导航项「${label}」`);
  }
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
