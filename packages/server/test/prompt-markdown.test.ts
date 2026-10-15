/**
 * 提示词 ←→ 前端渲染的契约测试。owner: agent-engine / Lead.
 *
 * AI 写回的长文本由 packages/web/src/components/markdown 渲染：prompts.ts 里
 * 教给模型的语法（metrics / chart 代码块）必须与解析器支持的一致。这里不跑
 * LLM，只校验示例本身是合法、可解析的，防止改提示词时把前端渲染悄悄改坏。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MARKDOWN_GUIDE, buildSystemPrompt } from '../src/agent/prompts.js';

test('系统提示包含 Markdown 输出规范，并要求结构化分段', () => {
  const prompt = buildSystemPrompt({ persona: 'balanced', reportStyle: 'professional', kind: 'asset-analysis' });
  assert.ok(prompt.includes('【输出格式：Markdown】'), '系统提示缺少 Markdown 输出规范');
  assert.ok(prompt.includes('**加粗**'), '缺少关键数字加粗的要求');
  assert.ok(prompt.includes('Markdown 表格'), '缺少表格要求');
  assert.ok(prompt.includes('`## 小标题`'), '缺少小标题分段要求');
});

test('metrics 代码块示例：每行都是「标签 | 数值 [| 说明]」', () => {
  const fence = /```metrics\n([\s\S]*?)\n\s*```/.exec(MARKDOWN_GUIDE);
  assert.ok(fence, '提示词里缺少 metrics 示例');
  const rows = fence![1]!.trim().split('\n');
  assert.ok(rows.length >= 2, 'metrics 示例至少要有两行');
  for (const row of rows) {
    const cells = row.split('|').map((cell) => cell.trim());
    assert.ok(cells.length >= 2 && cells[0] && cells[1], 'metrics 行格式错误：' + row);
  }
  // 第一行带说明列，第二行不带宽——两种写法渲染器都要支持。
  assert.equal(rows[0]!.split('|').length, 3);
  assert.equal(rows[1]!.split('|').length, 2);
});

test('chart 代码块示例是合法 JSON，且 categories 与 data 等长', () => {
  const fence = /```chart\n([\s\S]*?)\n\s*```/.exec(MARKDOWN_GUIDE);
  assert.ok(fence, '提示词里缺少 chart 示例');
  const spec = JSON.parse(fence![1]!.trim()) as {
    type: string;
    categories: string[];
    series: { name: string; data: number[] }[];
  };
  assert.ok(spec.type === 'bar' || spec.type === 'line', 'chart type 只支持 bar / line');
  assert.ok(spec.categories.length > 0);
  assert.ok(spec.series.length > 0);
  for (const series of spec.series) {
    assert.equal(series.data.length, spec.categories.length, 'categories 与 series.data 必须等长');
  }
});

test('建议生成要求理由精简为 Markdown（列表页只显示两行摘要）', () => {
  const prompt = buildSystemPrompt({ persona: 'steady', reportStyle: 'beginner', kind: 'advice' });
  assert.ok(prompt.includes('reason 用 Markdown'), '建议理由缺少 Markdown 格式要求');
  assert.ok(prompt.includes('120 字以内'), '建议理由缺少篇幅约束');
});
