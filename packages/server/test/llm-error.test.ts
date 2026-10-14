/**
 * 厂商错误体可读化测试 — owner: server-core.
 *
 * 401/403 的原始响应各家长得不一样（OpenAI 是 `{error:{message}}`，
 * OpenCode/Anthropic 还有 `{type,error:{message}}` 外层）。设置页的
 * 「测试连接」与模型列表都依赖 `providerMessage`，把 JSON 还原成一句人话，
 * 否则用户只会看到一坨原始 JSON。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_USER_AGENT, providerHeaders, providerMessage, readableHttpError } from '../src/agent/llm.js';

test('providerMessage 提取常见的错误体形状', () => {
  assert.equal(providerMessage('{"error":{"message":"Invalid credential"}}'), 'Invalid credential');
  assert.equal(
    providerMessage('{"type":"error","error":{"type":"FreeTierError","message":"free tier can only be used from within OpenCode"}}'),
    'free tier can only be used from within OpenCode',
  );
  assert.equal(providerMessage('{"message":"Missing API key."}'), 'Missing API key.');
  assert.equal(providerMessage('{"detail":"quota exceeded"}'), 'quota exceeded');
  assert.equal(providerMessage('{"error":"plain string error"}'), 'plain string error');
});

test('providerMessage 对非 JSON 与空值退化处理，并限制长度', () => {
  assert.equal(providerMessage(''), '');
  assert.equal(providerMessage('   '), '');
  assert.equal(providerMessage('<html>502 Bad Gateway</html>'), '<html>502 Bad Gateway</html>');
  assert.equal(providerMessage(JSON.stringify({ error: { message: 'x'.repeat(500) } })).length, 300);
});

test('providerHeaders：始终自报身份，OpenCode 域名额外带会话头', () => {
  const opencode = providerHeaders('https://opencode.ai/inference/go/v1', 'oc_sk_x', 'sess-1');
  assert.equal(opencode['user-agent'], APP_USER_AGENT);
  assert.equal(opencode.authorization, 'Bearer oc_sk_x');
  assert.equal(opencode['x-opencode-session'], 'sess-1');

  const other = providerHeaders('https://api.deepseek.com/v1', 'sk-x', 'sess-1');
  assert.equal(other['user-agent'], APP_USER_AGENT);
  assert.equal(other.authorization, 'Bearer sk-x');
  assert.equal('x-opencode-session' in other, false, '非 OpenCode 域名不应发送会话头');

  const anonymous = providerHeaders('https://opencode.ai/inference/go/v1', '   ', 'sess-2');
  assert.equal('authorization' in anonymous, false, '空 Key 不应发送 Authorization 头');
  assert.equal(anonymous['x-opencode-session'], 'sess-2');
});

test('providerHeaders：非法 Base URL 不抛异常，只保留通用头', () => {
  assert.deepEqual(providerHeaders('not-a-url', 'k', 's'), {
    'user-agent': APP_USER_AGENT,
    authorization: 'Bearer k',
  });
});

test('readableHttpError：402 归类为计费问题而不是 Key 问题', () => {
  const err = readableHttpError(402, '{"error":{"message":"Upstream request failed: Insufficient account funds"}}');
  assert.equal(err.code, 'LLM_PAYMENT');
  assert.equal(err.status, 402);
  assert.match(err.message, /402/);
  assert.match(err.message, /计费/);
  assert.match(err.message, /Insufficient account funds/);
});

test('readableHttpError：其余状态各自归类', () => {
  assert.equal(readableHttpError(401, '{"error":{"message":"Invalid credential"}}').code, 'LLM_AUTH');
  assert.equal(readableHttpError(403, '{"error":{"message":"Forbidden"}}').code, 'LLM_AUTH');
  assert.equal(readableHttpError(404, 'nope').code, 'LLM_NOT_FOUND');
  assert.equal(readableHttpError(429, 'slow down').code, 'LLM_RATE_LIMIT');
  assert.equal(readableHttpError(503, 'down').code, 'LLM_UPSTREAM');
});
