/**
 * `/models` 归一化测试 — owner: server-core.
 *
 * 设置页的模型下拉依赖 `parseModelIds`：各厂商返回形状不同（OpenAI 的
 * `{data:[{id}]}`、Google 的 `{models:[{name}]}`、少数网关的裸数组），
 * 解析错了下拉就会空，因此这里把三种形状与脏数据都钉住。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseConsoleProviderEntries,
  parseConsoleProviders,
  parseModelIds,
  summariseLlmDiagnosis,
  type DiagnosisStep,
} from '../src/routes/settings.js';

test('parseModelIds 支持 OpenAI / Google / 裸数组三种形状', () => {
  assert.deepEqual(parseModelIds({ object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }), [
    'deepseek-flash',
    'deepseek-v4-pro',
  ]);
  assert.deepEqual(parseModelIds({ models: [{ name: 'gemini-3.8-flash' }, { id: 'gpt-6.1-sol' }] }), [
    'gemini-3.8-flash',
    'gpt-6.1-sol',
  ]);
  assert.deepEqual(parseModelIds(['z-model', 'a-model', 'z-model']), ['a-model', 'z-model']);
});

test('parseModelIds 去重排序并忽略无效项', () => {
  assert.deepEqual(parseModelIds({ data: [{ id: '  b  ' }, { id: 'a' }, { id: 'b' }] }), ['a', 'b']);
  assert.deepEqual(parseModelIds({ data: [{ id: '   ' }, { display_name: '只有展示名' }, null, 42, { id: 'ok' }] }), [
    'ok',
  ]);
  assert.deepEqual(parseModelIds({}), []);
  assert.deepEqual(parseModelIds(null), []);
  assert.deepEqual(parseModelIds('not-an-object'), []);
});

test('parseModelIds 中 id 优先于 name / model 字段', () => {
  assert.deepEqual(parseModelIds({ data: [{ name: '展示名', id: 'real-id' }] }), ['real-id']);
  assert.deepEqual(parseModelIds({ data: [{ model: 'm-1' }] }), ['m-1']);
});

/* ───────────────────────────── 一键诊断 ───────────────────────────── */

const step = (id: string, ok: boolean, detail: string): DiagnosisStep => ({ id, label: id, ok, detail });

test('parseConsoleProviders：从 config 响应里取出 provider 键', () => {
  assert.deepEqual(parseConsoleProviders({ providers: { opencode: {}, 'opencode-go': {} } }), ['opencode', 'opencode-go']);
  assert.deepEqual(parseConsoleProviders({ providers: {} }), []);
  assert.deepEqual(parseConsoleProviders({}), []);
  assert.deepEqual(parseConsoleProviders(null), []);
  assert.deepEqual(parseConsoleProviders('nope'), []);
});

test('parseConsoleProviderEntries：统计每个 provider 的模型数量', () => {
  assert.deepEqual(
    parseConsoleProviderEntries({
      providers: {
        'opencode-go': { models: { 'kimi-k3': {}, 'glm-5.3': {} } },
        opencode: { models: {} },
      },
    }),
    [
      { id: 'opencode', modelCount: 0 },
      { id: 'opencode-go', modelCount: 2 },
    ],
  );
  assert.deepEqual(parseConsoleProviderEntries({ providers: { weird: 'not-an-object' } }), [
    { id: 'weird', modelCount: 0 },
  ]);
  assert.deepEqual(parseConsoleProviderEntries(null), []);
});

test('summariseLlmDiagnosis：按失败原因给出不同结论', () => {
  assert.match(summariseLlmDiagnosis([step('chat', true, 'HTTP 200（10ms）')]), /配置可用/);
  assert.match(
    summariseLlmDiagnosis([step('chat', true, 'HTTP 200'), step('models', false, 'HTTP 404：')]),
    /不提供 \/models/,
  );
  // 402 + 套餐步骤显示「未列出 Go」→ 直接指出工作区没有 Go 订阅。
  assert.match(
    summariseLlmDiagnosis([
      step('chat', false, 'HTTP 402：Upstream request failed: Insufficient account funds'),
      step('opencode-plan', false, '可用 provider：opencode（未列出 Go）'),
    ]),
    /未开通 Go 订阅/,
  );
  // 402 但没有套餐信息 → 只提示额度/余额。
  assert.match(
    summariseLlmDiagnosis([step('chat', false, 'HTTP 402：Upstream request failed: Insufficient account funds')]),
    /额度|余额/,
  );
  // 402 且套餐步骤通过（工作区确实有 Go）→ 说明这次请求没落在 Go 额度内。
  assert.match(
    summariseLlmDiagnosis([
      step('chat', false, 'HTTP 402：Upstream request failed: Insufficient account funds'),
      step('opencode-plan', true, '可用 provider：opencode（1 个模型） / opencode-go（31 个模型）'),
    ]),
    /已开通 Go/,
  );
  assert.match(summariseLlmDiagnosis([step('chat', false, 'HTTP 401：Invalid credential')]), /凭据被拒/);
  assert.match(summariseLlmDiagnosis([step('chat', false, 'HTTP 404：not found')]), /入口或模型不对/);
  assert.match(summariseLlmDiagnosis([step('config', false, '未配置 API Key')]), /尚未发起对话请求/);
});
