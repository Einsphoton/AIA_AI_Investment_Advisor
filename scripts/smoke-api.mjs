/**
 * End-to-end API acceptance smoke test (`npm run smoke`).
 *
 * Boots the built server on a throwaway port with a temporary DATA_DIR and
 * exercises the real HTTP surface: settings, assets + transactions, portfolio
 * math, budget, watchlist, advice, backup, and the "no API key" error path.
 *
 * Exits non-zero if any hard check fails. Network-dependent market checks are
 * reported as WARN instead of FAIL so the suite is usable offline.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 8899);
const BASE = `http://127.0.0.1:${PORT}`;
// Keep scratch data inside the workspace: sandboxes often deny writes/deletes
// outside it.
const dataDir = fs.mkdtempSync(path.join(root, '.smoke-data-'));
// Sweep scratch directories left behind by earlier (interrupted) runs.
for (const entry of fs.readdirSync(root)) {
  if (entry.startsWith('.smoke-data-') && path.join(root, entry) !== dataDir) {
    try {
      fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    } catch {
      /* still locked by another process; harmless */
    }
  }
}
/** Today's date in local time — budget checks are per calendar month. */
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

const results = [];
let failures = 0;

function record(name, status, detail = '') {
  results.push({ name, status, detail });
  const icon = status === 'PASS' ? '\x1b[32m✓\x1b[0m' : status === 'WARN' ? '\x1b[33m!\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${icon} ${name}${detail ? ` — ${detail}` : ''}`);
  if (status === 'FAIL') failures += 1;
}

function check(name, condition, detail = '') {
  record(name, condition ? 'PASS' : 'FAIL', condition ? detail : detail || '断言失败');
  return condition;
}

async function call(method, url, body) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw text */
  }
  return { status: response.status, json, text };
}

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

const server = spawn(
  process.execPath,
  ['--enable-source-maps', path.join(root, 'packages/server/dist/index.js')],
  {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'production', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'inherit', 'inherit'],
  },
);

let serverExit = null;
server.on('exit', (code) => {
  serverExit = code;
});

function shutdown(code) {
  try {
    server.kill();
  } catch {
    /* ignore */
  }
  // Best-effort cleanup: the server may still hold the SQLite WAL, and a denied
  // delete must never mask the test result. Retry a few times before giving up.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      break;
    } catch {
      sleepSync(150); // the server may still be releasing the SQLite WAL
    }
  }
  process.exit(code);
}

/** Blocking sleep for use in the exit path (no async plumbing available). */
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

try {
  if (!(await waitForHealth())) {
    record('服务启动 /api/health', 'FAIL', serverExit === null ? '30s 内未就绪' : `进程已退出（code ${serverExit}）`);
    shutdown(1);
  }
  check('服务启动 /api/health', true, BASE);

  /* ── 设置 ─────────────────────────────────────────────────────────────── */
  const settings = await call('GET', '/api/settings');
  check('GET /api/settings 返回 200', settings.status === 200, `status=${settings.status}`);
  const settingsBody = settings.json ?? {};
  check('设置包含 6 项数据源槽位', Boolean(settingsBody.dataSources?.stockCN && settingsBody.dataSources?.fundUS && settingsBody.dataSources?.webSearch));
  check('默认投资性格为 balanced', settingsBody.persona === 'balanced', `persona=${settingsBody.persona}`);
  check('API Key 不明文返回', !settingsBody.llm?.apiKey && settingsBody.hasApiKey === false);

  const updated = await call('PUT', '/api/settings', { persona: 'value', reportStyle: 'beginner', budget: { CN: 123456 } });
  check('PUT /api/settings 更新性格与预算', updated.status === 200 && updated.json?.persona === 'value' && updated.json?.budget?.CN === 123456, `status=${updated.status}`);
  const reread = await call('GET', '/api/settings');
  check('设置可持久化回读', reread.json?.persona === 'value' && reread.json?.budget?.CN === 123456);
  await call('PUT', '/api/settings', { budget: { CN: 500000 } });

  /* ── 资产与持仓数学 ───────────────────────────────────────────────────── */
  const created = await call('POST', '/api/assets', {
    code: '600519',
    market: 'CN',
    type: 'stock',
    shares: 100,
    price: 1500,
    tradeDate: today,
    note: 'smoke 建仓',
  });
  if (!check('POST /api/assets 建仓', created.status === 200 && Boolean(created.json?.id), `status=${created.status} body=${created.text.slice(0, 120)}`)) {
    shutdown(1);
  }
  const assetId = created.json.id;
  check('建仓后份额/成本正确', created.json.shares === 100 && created.json.cost === 150000 && created.json.avgCost === 1500, `shares=${created.json.shares} cost=${created.json.cost}`);
  check('资产名称自动补全', typeof created.json.name === 'string' && created.json.name.length > 0, `name=${created.json.name}`);
  check('首笔交易已写入', Array.isArray(created.json.transactions) && created.json.transactions.length === 1 && created.json.transactions[0].kind === 'buy');

  const sold = await call('POST', `/api/assets/${assetId}/transactions`, {
    kind: 'sell',
    shares: 40,
    price: 1600,
    tradeDate: today,
    fee: 5,
  });
  const soldBody = sold.json ?? {};
  check('部分卖出后份额=60', soldBody.shares === 60, `shares=${soldBody.shares}`);
  check('已实现盈亏=4000', Math.abs((soldBody.realizedPnl ?? -1) - 4000) < 0.01, `realizedPnl=${soldBody.realizedPnl}`);
  check('剩余成本=90000', Math.abs((soldBody.cost ?? -1) - 90000) < 0.01, `cost=${soldBody.cost}`);

  const asset = await call('GET', `/api/assets/${assetId}`);
  check('GET /api/assets/:id 返回交易记录', asset.status === 200 && asset.json?.transactions?.length === 2);

  /* ── 输入校验：非法日历日期必须 400（回归护栏） ─────────────────────────── */
  const badDates = ['2026-13-45', '2026-02-30', '2026-04-31', '2026-00-00', '2026-99-99', '2026-02-29'];
  for (const badDate of badDates) {
    const response = await call('POST', '/api/assets', {
      code: 'BADDATE',
      market: 'CN',
      type: 'stock',
      shares: 1,
      price: 10,
      tradeDate: badDate,
    });
    check(`非法交易日 ${badDate} 被拒绝`, response.status === 400, `status=${response.status}`);
  }
  const leapOk = await call('POST', '/api/assets', {
    code: 'LEAPDAY',
    market: 'CN',
    type: 'stock',
    shares: 1,
    price: 10,
    tradeDate: '2028-02-29',
  });
  check('闰年 2028-02-29 被接受', leapOk.status === 200, `status=${leapOk.status}`);
  if (leapOk.json?.id) await call('DELETE', `/api/assets/${leapOk.json.id}`);

  /* ── 账本一致性：删除买入交易不得产生"无对手方的卖出" ─────────────────── */
  const guardAsset = await call('POST', '/api/assets', {
    code: 'GUARD',
    market: 'CN',
    type: 'stock',
    shares: 10,
    price: 100,
    tradeDate: today,
  });
  const guardId = guardAsset.json?.id;
  const guardBuyId = guardAsset.json?.transactions?.[0]?.id;
  if (guardId && guardBuyId) {
    await call('POST', `/api/assets/${guardId}/transactions`, { kind: 'sell', shares: 8, price: 120, tradeDate: today });
    const blocked = await call('DELETE', `/api/assets/${guardId}/transactions/${guardBuyId}`);
    check('删除被卖出覆盖的买入交易被拒绝（409）', blocked.status === 409, `status=${blocked.status} body=${blocked.text.slice(0, 120)}`);
    const after = await call('GET', `/api/assets/${guardId}`);
    check(
      '拒绝后账本未被破坏（realizedPnl 保持 160）',
      Math.abs((after.json?.realizedPnl ?? -1) - 160) < 0.01 && after.json?.transactions?.length === 2,
      `realizedPnl=${after.json?.realizedPnl} txs=${after.json?.transactions?.length}`,
    );
    await call('DELETE', `/api/assets/${guardId}`);
  } else {
    check('账本一致性用例可执行', false, `guardId=${guardId} buyId=${guardBuyId}`);
  }

  const list = await call('GET', '/api/assets?market=CN&type=stock&q=600519');
  check('资产列表支持筛选/搜索', list.status === 200 && list.json?.items?.length === 1, `total=${list.json?.total}`);

  /* ── 预算 ─────────────────────────────────────────────────────────────── */
  const budget = await call('GET', '/api/budget');
  const cn = budget.json?.markets?.find((entry) => entry.market === 'CN');
  check('预算按市场返回', budget.status === 200 && Boolean(cn), `status=${budget.status}`);
  const expectedSpent = 150000; // 契约口径：spent = 本月买入成交额（gross，卖出不释放预算）
  check(
    `预算统计（本月买入成交额 = ${expectedSpent}）`,
    cn ? Math.abs(cn.spent - expectedSpent) < 0.01 : false,
    cn ? `spent=${cn.spent} remaining=${cn.remaining} usedPct=${cn.usedPct} budget=${cn.budget} month=${budget.json?.month}` : '缺少 CN 预算项',
  );
  check(
    '卖出不释放预算（remaining = budget − spent）',
    cn ? Math.abs(cn.remaining - (cn.budget - expectedSpent)) < 0.01 : false,
    cn ? `remaining=${cn.remaining}` : '缺少 CN 预算项',
  );

  /* ── 仪表盘 ───────────────────────────────────────────────────────────── */
  const dashboard = await call('GET', '/api/dashboard');
  const portfolio = dashboard.json?.portfolio ?? {};
  check('GET /api/dashboard 结构完整', dashboard.status === 200 && Array.isArray(dashboard.json?.topHoldings) && Boolean(dashboard.json?.counts));
  check('仪表盘成本=90000', Math.abs((portfolio.cost ?? -1) - 90000) < 0.01, `cost=${portfolio.cost}`);
  check('仪表盘已实现盈亏=4000', Math.abs((portfolio.realizedPnl ?? -1) - 4000) < 0.01, `realizedPnl=${portfolio.realizedPnl}`);
  check('仪表盘含汇率折算信息', typeof portfolio.fxRates === 'object' && portfolio.fxRates !== null, JSON.stringify(portfolio.fxRates));
  // 回归护栏：东方财富外汇报价是放大整数（f43 / 10^f59），曾出现过 100 倍精度错误。
  const hkd = portfolio.fxRates?.HKD;
  const usd = portfolio.fxRates?.USD;
  check(
    '汇率量级合理（HKD/CNY 0.7~1.2，USD/CNY 5~9）',
    Number.isFinite(hkd) && hkd > 0.7 && hkd < 1.2 && Number.isFinite(usd) && usd > 5 && usd < 9,
    `HKD=${hkd} USD=${usd}`,
  );
  check(
    'USD/HKD 隐含汇率符合联系汇率（7.4~8.2）',
    Number.isFinite(hkd) && Number.isFinite(usd) && usd / hkd > 7.4 && usd / hkd < 8.2,
    `USD/HKD=${Number.isFinite(hkd) && hkd ? (usd / hkd).toFixed(3) : 'n/a'}`,
  );

  /* ── 标的 ─────────────────────────────────────────────────────────────── */
  const watch = await call('POST', '/api/watchlist', { code: '00700', market: 'HK', type: 'stock' });
  check('POST /api/watchlist 添加标的', watch.status === 200 && Boolean(watch.json?.id), `status=${watch.status} body=${watch.text.slice(0, 120)}`);
  const watchDetail = watch.json?.id ? await call('GET', `/api/watchlist/${watch.json.id}`) : { status: 0 };
  check('标的详情可选返回持仓对照', watchDetail.status === 200);
  const cleared = await call('DELETE', '/api/watchlist');
  check('DELETE /api/watchlist 清空标的', cleared.status === 200 && cleared.json?.ok === true, `deleted=${cleared.json?.deleted}`);

  /* ── 建议 ─────────────────────────────────────────────────────────────── */
  const advice = await call('GET', '/api/advice');
  check('GET /api/advice 返回列表与预算', advice.status === 200 && Array.isArray(advice.json?.items) && Boolean(advice.json?.budget));
  const generate = await call('POST', '/api/advice/generate');
  check(
    '无 API Key 时 AI 接口返回 400 NOT_CONFIGURED',
    generate.status === 400 && generate.json?.error?.code === 'NOT_CONFIGURED',
    `status=${generate.status} code=${generate.json?.error?.code ?? generate.text.slice(0, 80)}`,
  );

  /* ── 备份 ─────────────────────────────────────────────────────────────── */
  const exported = await call('GET', '/api/backup/export');
  check('GET /api/backup/export 含资产与交易', exported.status === 200 && exported.json?.assets?.length === 1 && exported.json?.transactions?.length === 2);
  check('导出内容不含 API Key', !JSON.stringify(exported.json ?? {}).includes('"apiKey"'));
  const imported = await call('POST', '/api/backup/import', { data: exported.json, mode: 'merge' });
  check('POST /api/backup/import 合并导入', imported.status === 200 && imported.json?.skipped >= 1, JSON.stringify(imported.json));

  /* ── 前端依赖端点契约（形状必须与 docs/API.md / client.ts 一致） ────────── */
  const catalogue = await call('GET', '/api/settings/data-sources');
  check(
    'GET /api/settings/data-sources 形状',
    catalogue.status === 200 && Array.isArray(catalogue.json?.slots) && catalogue.json.slots.length === 6 && Array.isArray(catalogue.json?.providers),
    `slots=${catalogue.json?.slots?.length} providers=${catalogue.json?.providers?.length}`,
  );
  const probe = await call('POST', '/api/settings/data-sources/probe');
  check(
    'POST /api/settings/data-sources/probe 返回数组（契约 §2）',
    probe.status === 200 && Array.isArray(probe.json),
    `isArray=${Array.isArray(probe.json)} keys=${Array.isArray(probe.json) ? '' : Object.keys(probe.json ?? {}).join(',')}`,
  );
  const tools = await call('GET', '/api/agent/tools');
  check('GET /api/agent/tools 返回工具数组', tools.status === 200 && Array.isArray(tools.json) && tools.json.length > 0, `n=${Array.isArray(tools.json) ? tools.json.length : 'n/a'}`);
  const runs = await call('GET', '/api/agent/runs?limit=3');
  check('GET /api/agent/runs 返回数组', runs.status === 200 && Array.isArray(runs.json));
  const sessions = await call('GET', '/api/chat/sessions');
  check('GET /api/chat/sessions 返回数组', sessions.status === 200 && Array.isArray(sessions.json));
  const newSession = await call('POST', '/api/chat/sessions', { title: 'smoke' });
  check(
    'POST /api/chat/sessions 返回 ChatSession',
    newSession.status === 200 && typeof newSession.json?.id === 'string' && 'messageCount' in (newSession.json ?? {}),
    JSON.stringify(newSession.json).slice(0, 120),
  );
  const detail = await call('GET', '/api/market/detail?market=CN&code=600519&type=stock&range=1y&interval=day');
  check(
    'GET /api/market/detail 聚合 series+profile',
    detail.status === 200 && Boolean(detail.json?.series) && (detail.json?.series?.points?.length ?? 0) > 20 && Boolean(detail.json?.profile),
    `points=${detail.json?.series?.points?.length}`,
  );
  const backupFiles = await call('GET', '/api/backup/files');
  check('GET /api/backup/files 返回数组', backupFiles.status === 200 && Array.isArray(backupFiles.json));
  const unknown = await call('GET', '/api/definitely-not-an-endpoint');
  check(
    '未知路由返回 404 + 统一错误体',
    unknown.status === 404 && typeof unknown.json?.error?.code === 'string',
    `status=${unknown.status} body=${unknown.text.slice(0, 90)}`,
  );

  /* ── P0/P1 治理能力（上下文预算 / 策略 / 审计 / 审批 / MCP / 轨迹） ─────── */
  check(
    '设置含上下文预算与治理字段',
    typeof settingsBody.llm?.contextTokens === 'number' &&
      settingsBody.llm.contextTokens > 0 &&
      Array.isArray(settingsBody.toolPolicy?.deny) &&
      Array.isArray(settingsBody.mcpServers),
    `contextTokens=${settingsBody.llm?.contextTokens} deny=${JSON.stringify(settingsBody.toolPolicy?.deny)} mcp=${settingsBody.mcpServers?.length}`,
  );

  const toolsWithRisk = await call('GET', '/api/agent/tools');
  const risks = new Set((toolsWithRisk.json ?? []).map((tool) => String(tool.risk)));
  check(
    '工具清单带风险分级（read/external/write 且无未知值）',
    toolsWithRisk.status === 200 &&
      (toolsWithRisk.json ?? []).length > 0 &&
      [...risks].every((risk) => ['read', 'external', 'write'].includes(risk)) &&
      risks.has('write') &&
      risks.has('read'),
    `n=${toolsWithRisk.json?.length} risks=${[...risks].join(',')}`,
  );

  const auditList = await call('GET', '/api/agent/audit?limit=10');
  check('GET /api/agent/audit 返回裸数组', auditList.status === 200 && Array.isArray(auditList.json), `status=${auditList.status}`);
  const pendingList = await call('GET', '/api/agent/pending?status=pending');
  check('GET /api/agent/pending 返回裸数组', pendingList.status === 200 && Array.isArray(pendingList.json), `status=${pendingList.status}`);
  const mcpServers = await call('GET', '/api/mcp/servers');
  check('GET /api/mcp/servers 返回裸数组', mcpServers.status === 200 && Array.isArray(mcpServers.json), `status=${mcpServers.status}`);
  const mcpReload = await call('POST', '/api/mcp/reload');
  check('POST /api/mcp/reload 可用', mcpReload.status === 200 && typeof mcpReload.json?.reloaded === 'number', JSON.stringify(mcpReload.json).slice(0, 90));

  const policyRoundTrip = await call('PUT', '/api/settings', {
    toolPolicy: { deny: ['non_existent_tool'], requireWriteApproval: false },
  });
  check(
    'PUT /api/settings 可写入工具策略',
    policyRoundTrip.status === 200 && (policyRoundTrip.json?.toolPolicy?.deny ?? []).includes('non_existent_tool'),
    JSON.stringify(policyRoundTrip.json?.toolPolicy),
  );
  await call('PUT', '/api/settings', { toolPolicy: { deny: [], requireWriteApproval: false } });

  const traceMissing = await call('GET', '/api/agent/runs/does-not-exist/trace');
  check('未知 run 的 trace 返回 404', traceMissing.status === 404, `status=${traceMissing.status}`);


  /* ── 行情（依赖网络，失败仅告警） ─────────────────────────────────────── */
  const quote = await call('GET', '/api/market/quote?market=CN&code=600519');
  record('GET /api/market/quote 真实报价', quote.status === 200 && quote.json?.price > 0 ? 'PASS' : 'WARN', `status=${quote.status} price=${quote.json?.price}`);
  const series = await call('GET', '/api/market/series?market=HK&code=00700&type=stock&range=1y&interval=day');
  record('GET /api/market/series 日K序列', series.status === 200 && (series.json?.points?.length ?? 0) > 20 ? 'PASS' : 'WARN', `points=${series.json?.points?.length}`);
  const profile = await call('GET', '/api/market/profile?market=US&code=AAPL&type=stock');
  record('GET /api/market/profile 基本面', profile.status === 200 && Boolean(profile.json?.quote) ? 'PASS' : 'WARN', `status=${profile.status}`);
  // 财报三表：A 股应能拿到利润表 + 资产负债表 + 现金流量表。
  const financials = await call('GET', '/api/market/financials?market=CN&code=600519&type=stock&periods=4');
  const available = (financials.json?.statements ?? []).filter((statement) => statement.available);
  record(
    'GET /api/market/financials 三表',
    financials.status === 200 && available.length === 3 && (available[0]?.periods?.length ?? 0) >= 2 ? 'PASS' : 'WARN',
    `status=${financials.status} 可用表=${available.length} 期数=${available[0]?.periods?.length ?? 0} 高亮=${(financials.json?.highlights ?? []).length}`,
  );
  const etfFinancials = await call('GET', '/api/market/financials?market=US&code=SCHD&type=etf');
  check(
    'ETF 财报走「不适用」而不是报错',
    etfFinancials.status === 200 && etfFinancials.json?.applicable === false,
    `status=${etfFinancials.status} applicable=${etfFinancials.json?.applicable}`,
  );
  const macro = await call('GET', '/api/market/macro');
  record('GET /api/market/macro 宏观', macro.status === 200 ? 'PASS' : 'WARN', `status=${macro.status}`);

  /* ── 删除级联 ─────────────────────────────────────────────────────────── */
  const removed = await call('DELETE', `/api/assets/${assetId}`);
  check('DELETE /api/assets/:id', removed.status === 200 && removed.json?.ok === true);
  const afterDelete = await call('GET', '/api/assets');
  check('删除后列表为空', afterDelete.json?.items?.length === 0, `items=${afterDelete.json?.items?.length}`);

  /* ── 安全：任何出口都不得出现明文 API Key（哨兵值，放最后避免污染其它断言） ── */
  const SENTINEL_LLM = 'sk-TEST-LEAK-123456';
  const SENTINEL_SLOT = 'sk-SLOT-LEAK-999';
  const SENTINEL_SEARCH = 'tvly-SEARCH-LEAK';
  const wrote = await call('PUT', '/api/settings', {
    llm: { apiKey: SENTINEL_LLM },
    dataSources: {
      stockUS: { provider: 'finnhub', enabled: true, apiKey: SENTINEL_SLOT },
      webSearch: { provider: 'tavily', enabled: true, apiKey: SENTINEL_SEARCH },
    },
  });
  check('哨兵 Key 写入成功', wrote.status === 200, `status=${wrote.status}`);

  const leaks = [];
  const settingsAfter = await call('GET', '/api/settings');
  leaks.push(['GET /api/settings', settingsAfter.text]);
  leaks.push(['GET /api/settings/data-sources', (await call('GET', '/api/settings/data-sources')).text]);
  leaks.push(['GET /api/backup/export', (await call('GET', '/api/backup/export')).text]);
  const snapshot = await call('POST', '/api/backup/files', {});
  leaks.push(['POST /api/backup/files 响应', snapshot.text]);
  if (snapshot.json?.name) {
    leaks.push([
      'GET /api/backup/files/:name',
      (await call('GET', `/api/backup/files/${encodeURIComponent(snapshot.json.name)}`)).text,
    ]);
  }
  const sentinels = [SENTINEL_LLM, SENTINEL_SLOT, SENTINEL_SEARCH];
  for (const [where, body] of leaks) {
    const hit = sentinels.find((sentinel) => body.includes(sentinel));
    check(`明文 Key 未从「${where}」泄漏`, hit === undefined, hit ? `命中 ${hit}` : '');
  }
  check(
    '仍提供掩码与 hasApiKey（不是一刀切删掉）',
    settingsAfter.json?.hasApiKey === true && typeof settingsAfter.json?.apiKeyMasked === 'string',
    `hasApiKey=${settingsAfter.json?.hasApiKey} masked=${settingsAfter.json?.apiKeyMasked}`,
  );

  /* ── 一键清除（设置页「危险操作」）：放最后，避免影响上面的数据断言 ────── */
  const clearedAll = await call('POST', '/api/backup/clear', {});
  check(
    'POST /api/backup/clear 清空数据并给出逐表计数',
    clearedAll.status === 200 && typeof clearedAll.json?.deleted === 'number' && clearedAll.json.deleted >= 0 && clearedAll.json.settingsReset === false,
    JSON.stringify(clearedAll.json).slice(0, 180),
  );
  const assetsAfterClear = await call('GET', '/api/assets');
  check('清除后资产列表为空', assetsAfterClear.json?.items?.length === 0, `items=${assetsAfterClear.json?.items?.length}`);
  const settingsAfterClear = await call('GET', '/api/settings');
  check(
    '默认保留 AI 配置与 API Key',
    settingsAfterClear.json?.hasApiKey === true,
    `hasApiKey=${settingsAfterClear.json?.hasApiKey}`,
  );
  const resetAll = await call('POST', '/api/backup/clear', { keepSettings: false });
  const afterReset = await call('GET', '/api/settings');
  check(
    'keepSettings:false 恢复出厂设置（清空 Key、定时任务关闭）',
    resetAll.status === 200 &&
      resetAll.json?.settingsReset === true &&
      afterReset.json?.hasApiKey === false &&
      afterReset.json?.schedule?.mode === 'off',
    `status=${resetAll.status} hasApiKey=${afterReset.json?.hasApiKey} mode=${afterReset.json?.schedule?.mode}`,
  );
} catch (error) {
  record('未预期异常', 'FAIL', error.stack ?? String(error));
} finally {
  const passed = results.filter((entry) => entry.status === 'PASS').length;
  const warned = results.filter((entry) => entry.status === 'WARN').length;
  console.log(`\n合计 ${results.length} 项：通过 ${passed}，告警 ${warned}，失败 ${failures}`);
  console.log(`临时数据目录：${dataDir}`);
  shutdown(failures === 0 ? 0 : 1);
}
