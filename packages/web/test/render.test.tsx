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
import {
  DEFAULT_LLM,
  LLM_PROVIDER_CUSTOM_ID,
  LLM_PROVIDER_PRESET_MAP,
  LLM_PROVIDER_PRESETS,
  matchLlmProviderPreset,
  normalizeLlmBaseUrl,
} from '@aia/shared';
import { App } from '../src/App';
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
