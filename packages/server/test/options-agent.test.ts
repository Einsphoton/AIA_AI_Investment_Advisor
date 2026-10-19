/**
 * 期权卖权 Agent 层契约测试（task-7）。
 *
 * Owner: agent-engine. 覆盖四类「提示词写了、代码也必须管」的约束：
 *  ① 三个期权工具的注册 / 风险等级 / kind 过滤（漏注册 ⇒ 模型永远看不到）；
 *  ② `create_option_advice` 的**零歧义算术**硬拦：策略方向自洽、持股覆盖、现金担保、
 *     到期日必须在未来（担保数据由服务端从 repo 读，不信模型声明）；
 *  ③ 期权卖权建议**不进入**股票口径的结果追踪，且股票确认路径必须明确 400 分流；
 *  ④ 期权阶段的两道闸门：`skipOption`（定时任务跟随投资建议）× `settings.option.runWithPipeline`。
 *
 * 不跑 LLM、不访问网络：工具测试在联网前就应被拒绝；路由测试用 `buildApp` + stub agent。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';
import type { AdviceItem, OptionAdvicePlan, ScheduleTask } from '@aia/shared';
import { DEFAULT_SCHEDULE_TASK } from '@aia/shared';

import {
  TOOLS,
  checkOptionCoverage,
  executeTool,
  llmToolSchemas,
  optionMaxContracts,
  setToolInterceptor,
  toolDescriptors,
  type AllowWrite,
} from '../src/agent/tools.js';
import { createRepo } from '../src/db/repo.js';
import { getServices, setServices } from '../src/registry.js';
import { planPipeline } from '../src/services/advice.js';
import { optionAdviceGoal, optionAdviceScope, selectOptionPutUnderlyings } from '../src/services/analytics.js';
import { trackAdviceOutcomes } from '../src/services/advice-outcomes.js';
import { toAdviceItem } from '../src/services/portfolio.js';
import { mergeTaskFlags, taskStepLabels } from '../src/services/schedule.js';
import type { AgentRuntime, LoggerLike } from '../src/types/agent.js';
import type { Repo } from '../src/types/repo.js';

const silentLogger: LoggerLike = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function tempRepo(prefix = 'aia-options-agent'): { repo: Repo; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const repo = createRepo(path.join(dir, 'advisor.db'));
  repo.migrate();
  return { repo, dir };
}

function closeAndRemove(repo: Repo, dir: string): void {
  try {
    repo.close();
  } catch {
    /* already closed */
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp dir left behind: harmless */
  }
}

function toolCtx(repo: Repo, runId = 'run-options', allow: AllowWrite[] = ['advice']) {
  return {
    runId,
    kind: 'option-advice' as const,
    repo,
    logger: silentLogger,
    sink: () => undefined,
    allowWrites: new Set<AllowWrite>(allow),
    target: null,
    batchId: `batch-${runId}`,
  };
}

async function callTool(
  repo: Repo,
  tool: string,
  args: Record<string, unknown>,
  runId = 'run-options',
): Promise<{ ok: boolean; code: string; message: string; content: string; value: Record<string, any> }> {
  const result = await executeTool(tool, JSON.stringify(args), toolCtx(repo, runId));
  let payload: Record<string, any> = {};
  try {
    payload = JSON.parse(result.content.split('\n…')[0]!) as Record<string, any>;
  } catch {
    // payload 被截断时保留原始 content，断言会在 message 上失败
  }
  return { ok: result.ok, code: String(payload.error ?? ''), message: String(payload.message ?? ''), content: result.content, value: payload };
}

/** N 天后的 YYYY-MM-DD（测试用的合法到期日）。 */
function futureDate(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function seedAsset(repo: Repo, code: string, market: 'HK' | 'US', shares = 100): string {
  const now = new Date().toISOString();
  const id = `asset-${code}`;
  repo.createAsset({
    id,
    name: `持仓${code}`,
    code,
    market,
    type: 'stock',
    source: 'manual',
    currency: market === 'US' ? 'USD' : 'HKD',
    note: '',
    price: 250,
    priceAt: now,
    prevClose: 248,
    dayChangePct: 0.8,
    spark: [],
    createdAt: now,
  });
  repo.addTransaction({
    id: `tx-${code}`,
    assetId: id,
    kind: 'buy',
    shares,
    price: 200,
    fee: 0,
    tradeDate: now.slice(0, 10),
    note: '',
    source: 'manual',
    createdAt: now,
  });
  return id;
}

/** 一条最小但合法的卖权方案（期权表/方案 JSON 的契约形状）。 */
function samplePlan(overrides: Partial<OptionAdvicePlan> = {}): OptionAdvicePlan {
  return {
    strategy: 'covered_call',
    optionType: 'call',
    optionCode: 'AAPL261120C00250000',
    strike: 250,
    expiry: futureDate(45),
    contracts: 1,
    multiplier: 100,
    currency: 'USD',
    premium: 1.2,
    metrics: {
      premiumIncome: 120,
      staticYieldPct: 0.48,
      annualizedYieldPct: 3.9,
      downsideProtectionPct: 4.2,
      collateral: 25000,
      collateralKind: 'shares',
      maxProfit: 120,
      breakeven: 251.2,
      assignmentProbability: 0.28,
      liquidityScore: 72,
      requiredShares: 100,
    },
    underlyingPrice: 240,
    acceptAssignment: true,
    collateralNote: '持仓 100 股',
    dataSource: 'CBOE 延迟行情',
    dataAsOf: new Date().toISOString(),
    delayed: true,
    warnings: [],
    ...overrides,
  };
}

function seedOptionAdvice(repo: Repo, plan: OptionAdvicePlan = samplePlan()): string {
  const now = new Date().toISOString();
  const row = repo.createAdvice({
    id: `advice-option-${Math.random().toString(16).slice(2)}`,
    batchId: 'batch-option',
    assetId: null,
    watchItemId: null,
    assetName: '苹果',
    code: 'AAPL',
    market: 'US',
    type: 'stock',
    instrument: 'option',
    optionPlan: plan,
    action: 'sell',
    targetShares: plan.multiplier * plan.contracts,
    targetPrice: plan.premium,
    currency: 'USD',
    reason: '收权利金',
    confidence: 0.6,
    status: 'pending',
    createdAt: now,
  });
  return row.id;
}

/* ─────────────── ① 工具注册 / 风险等级 / kind 过滤 ───────────────────────── */

test('期权工具：三个工具都注册进 TOOLS，且风险等级与 kind 过滤正确', () => {
  const names = TOOLS.map((tool) => tool.descriptor.name);
  for (const name of ['list_option_chain', 'screen_option_candidates', 'create_option_advice']) {
    assert.ok(names.includes(name), `TOOLS 缺少 ${name}（没注册 = 模型永远看不到）`);
  }

  // 风险等级由 requiresWrite 推导：写工具必须是 write（否则审批/deny/dedupe 全失效）。
  const catalogue = toolDescriptors();
  const byName = new Map(catalogue.map((tool) => [tool.name, tool]));
  assert.equal(byName.get('list_option_chain')?.risk, 'read');
  assert.equal(byName.get('screen_option_candidates')?.risk, 'read');
  assert.equal(byName.get('create_option_advice')?.risk, 'write');

  // 模型可见性：期权阶段能看到三个；股票建议阶段看不到 create_option_advice（kinds 限制）。
  const optionSchemas = llmToolSchemas('option-advice', ['advice']).map((schema) => schema.function.name);
  for (const name of ['list_option_chain', 'screen_option_candidates', 'create_option_advice']) {
    assert.ok(optionSchemas.includes(name), `option-advice 阶段应能看到 ${name}`);
  }
  const adviceSchemas = llmToolSchemas('advice', ['advice']).map((schema) => schema.function.name);
  assert.ok(!adviceSchemas.includes('create_option_advice'), 'create_option_advice 只应出现在期权阶段');
  // 写域仍是 'advice'：未授予 advice 写权限时工具本身会被 executeTool 拦掉。
  assert.ok(createDescriptor('create_option_advice')?.parameters.required?.includes('optionCode'));
});

function createDescriptor(name: string): { parameters: Record<string, any> } | undefined {
  return toolDescriptors().find((tool) => tool.name === name) as { parameters: Record<string, any> } | undefined;
}

/* ─────────────── ② 担保算术（纯函数，边界可直接造） ─────────────────────── */

test('checkOptionCoverage：持股不足返回最大可卖张数；刚好覆盖时通过', () => {
  const insufficient = checkOptionCoverage({
    strategy: 'covered_call',
    market: 'US',
    currency: 'USD',
    multiplier: 100,
    strike: 250,
    contracts: 2,
    heldShares: 150,
    availableCash: 0,
  });
  assert.equal(insufficient.ok, false);
  assert.equal(insufficient.code, 'insufficient_shares');
  assert.equal(insufficient.details?.requiredShares, 200);
  assert.equal(insufficient.details?.maxContracts, 1, '150 股只能覆盖 1 张（100 股/张）');
  assert.match(insufficient.message ?? '', /最多只能卖 1 张/);

  const exact = checkOptionCoverage({
    strategy: 'covered_call',
    market: 'US',
    currency: 'USD',
    multiplier: 100,
    strike: 250,
    contracts: 1,
    heldShares: 100,
    availableCash: 0,
  });
  assert.equal(exact.ok, true, '恰好 100 股覆盖 1 张是合法的');

  const noShare = checkOptionCoverage({
    strategy: 'covered_call',
    market: 'US',
    currency: 'USD',
    multiplier: 100,
    strike: 250,
    contracts: 1,
    heldShares: 0,
    availableCash: 0,
  });
  assert.equal(noShare.ok, false);
  assert.equal(noShare.details?.maxContracts, 0, '没有持股时最大张数是 0，不是负数');
});

test('checkOptionCoverage：现金担保（0 现金提示填写 / 不足给出最大张数 / 足额通过）', () => {
  const noCash = checkOptionCoverage({
    strategy: 'cash_secured_put',
    market: 'HK',
    currency: 'HKD',
    multiplier: 100,
    strike: 300,
    contracts: 1,
    heldShares: 0,
    availableCash: 0,
  });
  assert.equal(noCash.ok, false);
  assert.equal(noCash.code, 'no_cash');
  assert.match(noCash.message ?? '', /设置页/);

  const insufficient = checkOptionCoverage({
    strategy: 'cash_secured_put',
    market: 'US',
    currency: 'USD',
    multiplier: 100,
    strike: 250,
    contracts: 2,
    heldShares: 0,
    availableCash: 30_000,
  });
  assert.equal(insufficient.ok, false);
  assert.equal(insufficient.code, 'insufficient_cash');
  assert.equal(insufficient.details?.collateral, 50_000);
  assert.equal(insufficient.details?.maxContracts, 1);

  const exact = checkOptionCoverage({
    strategy: 'cash_secured_put',
    market: 'US',
    currency: 'USD',
    multiplier: 100,
    strike: 250,
    contracts: 2,
    heldShares: 0,
    availableCash: 50_000,
  });
  assert.equal(exact.ok, true, '担保额恰好等于可用现金是允许的');
});

/* ─────────────── ② 真实工具：参数/担保拒绝（都不该触网） ────────────────── */

test('create_option_advice：策略与方向矛盾、过期合约、非法张数、A 股市场都被直接拒绝', async () => {
  const { repo, dir } = tempRepo();
  setToolInterceptor(null);
  try {
    const base = {
      code: 'AAPL',
      market: 'US',
      strategy: 'covered_call',
      optionType: 'put',
      optionCode: 'AAPL261120C00250000',
      strike: 250,
      expiry: futureDate(45),
      contracts: 1,
      premium: 1.2,
      reason: '测试',
    };

    const mismatch = await callTool(repo, 'create_option_advice', base);
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.code, 'strategy_mismatch');
    assert.match(mismatch.message, /covered_call 只能卖 call/);

    const past = await callTool(repo, 'create_option_advice', {
      ...base,
      optionType: 'call',
      expiry: '2020-01-01',
    });
    assert.equal(past.ok, false);
    assert.equal(past.code, 'expiry_passed');
    assert.match(past.message, /未来日期/);

    const zeroContracts = await callTool(repo, 'create_option_advice', { ...base, optionType: 'call', contracts: 0 });
    assert.equal(zeroContracts.ok, false);
    assert.equal(zeroContracts.code, 'bad_request');

    const cnMarket = await callTool(repo, 'create_option_advice', { ...base, optionType: 'call', market: 'CN' });
    assert.equal(cnMarket.ok, false);
    assert.equal(cnMarket.code, 'unsupported_market');

    assert.equal(repo.listAdvice().length, 0, '被拒绝的建议绝不能落库');
  } finally {
    closeAndRemove(repo, dir);
  }
});

test('create_option_advice：持股不足被拒，并给出「最多 N 张」的可改正数字', async () => {
  const { repo, dir } = tempRepo();
  setToolInterceptor(null);
  try {
    seedAsset(repo, 'AAPL', 'US', 100);
    const result = await callTool(repo, 'create_option_advice', {
      code: 'AAPL',
      market: 'US',
      strategy: 'covered_call',
      optionType: 'call',
      optionCode: 'AAPL261120C00250000',
      strike: 250,
      expiry: futureDate(45),
      contracts: 2,
      premium: 1.2,
      reason: '测试',
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'insufficient_shares');
    assert.equal(result.value.details?.requiredShares, 200);
    assert.equal(result.value.details?.maxContracts, 1);
    assert.equal(result.value.details?.heldShares, 100);
    assert.match(result.message, /最多只能卖 1 张/);
    assert.equal(repo.listAdvice().length, 0);
  } finally {
    closeAndRemove(repo, dir);
  }
});

test('create_option_advice：可用现金为 0 提示去设置页；现金不足给出最大张数', async () => {
  const { repo, dir } = tempRepo();
  setToolInterceptor(null);
  try {
    const base = {
      code: 'AAPL',
      market: 'US',
      strategy: 'cash_secured_put',
      optionType: 'put',
      optionCode: 'AAPL261120P00250000',
      strike: 250,
      expiry: futureDate(45),
      contracts: 1,
      premium: 1.2,
      reason: '测试',
    };

    // 默认 cash.US = 0 → 视为「未填写」，必须提示用户去设置页，而不是当成没有风险。
    const noCash = await callTool(repo, 'create_option_advice', base);
    assert.equal(noCash.ok, false);
    assert.equal(noCash.code, 'no_cash');
    assert.match(noCash.message, /设置页/);

    repo.saveSettings({ option: { cash: { US: 1000 } } });
    const insufficient = await callTool(repo, 'create_option_advice', base);
    assert.equal(insufficient.ok, false);
    assert.equal(insufficient.code, 'insufficient_cash');
    assert.equal(insufficient.value.details?.collateral, 25_000);
    assert.equal(insufficient.value.details?.maxContracts, 0);
    assert.match(insufficient.message, /不足以按该行权价卖 1 张/);

    assert.equal(repo.listAdvice().length, 0);
  } finally {
    closeAndRemove(repo, dir);
  }
});

/* ─────────────── ③ 建议分流：不追踪期权、股票确认路径 400 ───────────────── */

test('期权建议不进入 advice_outcomes（股票口径的追踪必须跳过它）', async () => {
  const { repo, dir } = tempRepo();
  try {
    seedOptionAdvice(repo);
    // 只有期权建议时不需要任何行情序列：若没过滤，这里会去抓 AAPL 的日线（测试会因断网/超时暴露）。
    const result = await trackAdviceOutcomes({ repo, logger: silentLogger });
    assert.equal(result.tracked, 0, '期权卖权建议不得参与股票口径的结果追踪');
    assert.equal(repo.listAdviceOutcomes({ limit: 10 }).length, 0);
    assert.ok(result.warnings.every((warning) => !/AAPL/.test(warning)));

    // 行到接口的映射必须带上 instrument / option（否则前端会把期权当股票渲染）。
    const row = repo.listAdvice()[0]!;
    const item: AdviceItem = toAdviceItem(row);
    assert.equal(item.instrument, 'option');
    assert.ok(item.option, 'toAdviceItem 必须带回 option 方案');
    assert.equal(item.option?.optionCode, 'AAPL261120C00250000');
  } finally {
    closeAndRemove(repo, dir);
  }
});

test('POST /api/advice/:id/confirm 遇到期权建议返回明确 400 并指向 confirm-option', async () => {
  // 同一进程里 api.test 已初始化过服务；这里先备份，测试结束必须还原，避免污染后续测试文件。
  let previous: ReturnType<typeof getServices> | null = null;
  try {
    previous = getServices();
  } catch {
    previous = null;
  }
  const { repo, dir } = tempRepo('aia-options-route');
  let app: FastifyInstance | null = null;
  try {
    const stubAgent: AgentRuntime = {
      isConfigured: () => false,
      tools: () => toolDescriptors(),
      run: async () => {
        throw new Error('agent runtime stub');
      },
      resume: async () => {
        throw new Error('agent runtime stub');
      },
    };
    setServices({ repo, agent: stubAgent });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ serveWeb: false });

    const adviceId = seedOptionAdvice(repo);

    const res = await app.inject({
      method: 'POST',
      url: `/api/advice/${adviceId}/confirm`,
      payload: { shares: 100, price: 1.2 },
    });
    assert.equal(res.statusCode, 400, res.body);
    const body = JSON.parse(res.body) as { error: { code: string; message: string; details?: Record<string, unknown> } };
    assert.match(body.error.message, /期权/);
    assert.equal(body.error.details?.code, 'USE_CONFIRM_OPTION');
    assert.match(String(body.error.details?.endpoint), /\/confirm-option$/);
    // 拒绝必须发生在写账本之前：建议仍是 pending，且没有产生股票流水。
    assert.equal(repo.getAdvice(adviceId)?.status, 'pending');
    assert.equal(repo.listTransactions().length, 0);

    // GET /api/agent/tools 必须能列出三个新工具（设置页的禁用/分组靠它）。
    const toolsRes = await app.inject({ method: 'GET', url: '/api/agent/tools' });
    assert.equal(toolsRes.statusCode, 200);
    const tools = JSON.parse(toolsRes.body) as Array<{ name: string; risk: string }>;
    const listed = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of ['list_option_chain', 'screen_option_candidates', 'create_option_advice']) {
      assert.ok(listed.has(name), `GET /api/agent/tools 缺少 ${name}`);
    }
    assert.equal(listed.get('create_option_advice')?.risk, 'write');
  } finally {
    await app?.close();
    closeAndRemove(repo, dir);
    if (previous) setServices(previous);
  }
});

/* ─────────────── ④ 阶段闸门：skipOption × runWithPipeline ───────────────── */

test('planPipeline：期权阶段同时受 skipOption 与 settings.option.runWithPipeline 控制', () => {
  const on = { runWithPipeline: true };
  const off = { runWithPipeline: false };

  assert.equal(planPipeline({}, on).option, true, '默认随流水线跑');
  assert.equal(planPipeline({ skipOption: true }, on).option, false, '调用方跳过优先');
  assert.equal(planPipeline({}, off).option, false, '设置总开关关掉时整段不跑');
  assert.equal(planPipeline({ skipOption: true }, off).option, false);
  // 其它阶段不受期权开关影响（关掉期权仍要跑股票建议）。
  assert.equal(planPipeline({}, off).advice, true);
  assert.equal(planPipeline({ skipAdvice: true }, on).advice, false);
});

test('定时任务：期权卖权跟随「投资建议」步骤（不新增 ScheduleTask 字段）', () => {
  const task = (patch: Partial<ScheduleTask>): ScheduleTask => ({
    ...DEFAULT_SCHEDULE_TASK,
    id: 'task-1',
    ...patch,
  });

  assert.equal(mergeTaskFlags([task({ runAdvice: true })]).skipOption, false);
  assert.equal(mergeTaskFlags([task({ runAdvice: false })]).skipOption, true, '没勾投资建议就不跑期权');
  assert.equal(mergeTaskFlags([]).skipOption, false, '空集合保守全跑');
  // 多个任务到期取并集：任一任务要投资建议就跑期权。
  assert.equal(
    mergeTaskFlags([task({ id: 'a', runAdvice: false }), task({ id: 'b', runAdvice: true })]).skipOption,
    false,
  );

  assert.ok(taskStepLabels(task({ runAdvice: true })).includes('期权卖权'), '日志里必须能看出会跑期权阶段');
  assert.ok(!taskStepLabels(task({ runAdvice: false })).includes('期权卖权'));
  // 顺序：期权卖权在「投资建议」之前（与 runFullPipeline 的执行顺序一致）。
  const labels = taskStepLabels(task({ runAdvice: true }));
  assert.ok(labels.indexOf('期权卖权') < labels.indexOf('投资建议'));
});

/* ───── ⑤ 可分析范围：卖 Put 的担保物是现金，不是持股（真实回归） ───── */

/**
 * 回归的是用户的真实场景：他把「期权可用现金」填成 50000 HKD 之后重跑，
 * 阶段仍然注入「没有可用于担保的港股/美股持仓，因此本次没有可分析的标的」，
 * 与同一段话里打印的 HK 50000 自相矛盾 ⇒ 模型只写「先去建仓」的总结，0 条建议。
 * 卖 Put 的担保物是现金，所以「有现金」就等于「有可分析标的」。
 */
test('optionAdviceScope：只有港股现金、没有持股时，卖 Put 仍有担保物', () => {
  const watchlist = [
    { market: 'HK', code: '01093', name: '石药集团', type: 'stock', qualityScore: 70, expectedReturn: 18, price: 8.88 },
    { market: 'HK', code: '00941', name: '中国移动', type: 'stock', qualityScore: 82, expectedReturn: 12, price: 71.2 },
    { market: 'HK', code: '00883', name: '中国海洋石油', type: 'stock', qualityScore: 74, expectedReturn: 15, price: 17.3 },
    { market: 'HK', code: '01810', name: '小米集团', type: 'stock', qualityScore: 68, expectedReturn: 20, price: 24.1 },
    { market: 'US', code: 'C', name: '花旗集团', type: 'stock', qualityScore: 71, expectedReturn: 16, price: 92.5 },
    { market: 'CN', code: '600036', name: '招商银行', type: 'stock', qualityScore: 90, expectedReturn: 25, price: 42.5 },
  ];

  // 用户的实际数据：没有港股/美股持股，港股现金 50000，美股 0。
  const scope = optionAdviceScope({ holdings: [], watchlist, cash: { HK: 50_000, US: 0 } });
  assert.equal(scope.hasCollateral, true, '有现金就构成卖 Put 的担保物，不能判定为「没有可分析的标的」');
  assert.equal(scope.coveredCodes.length, 0, '没有持股就没有覆盖式卖 Call');
  assert.ok(scope.putUnderlyings.length > 0, '必须给出观察池里的卖 Put 标的');
  assert.ok(scope.putUnderlyings.every((item) => item.market === 'HK'), '美股现金为 0，不能选美股标的');
  assert.ok(!scope.putUnderlyings.some((item) => item.code === '600036'), 'A 股没有个股期权，不能进候选');
  assert.equal(scope.putUnderlyings[0]!.code, '00941', '按优质分降序取（82 分优先）');
  assert.equal(scope.putUnderlyings[0]!.price, 71.2, '池内现价必须带过去（避免预取时再拉一次行情）');
  assert.ok(scope.putUnderlyings.length <= 3, '每市场限流，期权链很重');

  // 两边都没钱、也没持股 → 才是真的没有担保物。
  const empty = optionAdviceScope({ holdings: [], watchlist, cash: { HK: 0, US: 0 } });
  assert.equal(empty.hasCollateral, false, '现金与持股都没有时才允许报「没有可分析的标的」');
  assert.equal(empty.putUnderlyings.length, 0);

  // 有持股、没现金 → 只有覆盖式卖 Call（老行为不能退化）。
  const coveredOnly = optionAdviceScope({
    holdings: [{ market: 'HK', code: '00700', type: 'stock' }],
    watchlist,
    cash: { HK: 0, US: 0 },
  });
  assert.equal(coveredOnly.hasCollateral, true, '持股本身就是担保物');
  assert.deepEqual(coveredOnly.coveredCodes, ['00700']);
  assert.equal(coveredOnly.putUnderlyings.length, 0, '现金为 0 时不做卖 Put');

  // 美股现金 → 只选美股标的。
  const us = optionAdviceScope({ holdings: [], watchlist, cash: { HK: 0, US: 20_000 } });
  assert.deepEqual(us.putUnderlyings.map((item) => item.market), ['US']);
  assert.equal(us.putUnderlyings[0]!.code, 'C');
});

test('selectOptionPutUnderlyings：排除已持股标的、只看股票与 ETF、限流可配', () => {
  const watchlist = [
    { market: 'HK', code: '00700', name: '腾讯控股', type: 'stock', qualityScore: 99, expectedReturn: 30, price: 417.8 },
    { market: 'HK', code: '02800', name: '盈富基金', type: 'etf', qualityScore: 60, expectedReturn: 8, price: 21.3 },
    { market: 'HK', code: '01093', name: '石药集团', type: 'stock', qualityScore: 70, expectedReturn: 18, price: 8.88 },
    { market: 'HK', code: 'IPO-1', name: '未上市', type: 'ipo', qualityScore: 100, expectedReturn: 50, price: 0 },
  ];
  const picked = selectOptionPutUnderlyings({
    watchlist,
    cash: { HK: 50_000, US: 0 },
    excludeCodes: ['00700'],
    perMarket: 2,
  });
  assert.deepEqual(picked.map((item) => item.code), ['01093', '02800'], '排除已持股的 00700、跳过非股票/ETF、按优质分降序且限 2 个');

  // 同分时按预期收益降序；缺字段按 0 处理不抛错。
  const tie = selectOptionPutUnderlyings({
    watchlist: [
      { market: 'US', code: 'AAA', name: 'A', type: 'stock', qualityScore: 50, expectedReturn: 5 },
      { market: 'US', code: 'BBB', name: 'B', type: 'stock', qualityScore: 50, expectedReturn: 25 },
      { market: 'US', code: 'CCC', name: 'C', type: 'stock' },
    ],
    cash: { HK: 0, US: 10_000 },
    perMarket: 3,
  });
  assert.deepEqual(tie.map((item) => item.code), ['BBB', 'AAA', 'CCC']);
});

test('optionMaxContracts：卖 Put 按现金、卖 Call 按持股，且不超过张数上限', () => {
  // 港股 50000 HKD、行权价 8.00、乘数 100 → 每张担保 800 → 62 张。
  assert.equal(optionMaxContracts({ strategy: 'cash_secured_put', multiplier: 100, strike: 8, heldShares: 0, availableCash: 50_000 }), 50, '受 OPTION_CONTRACT_LIMIT=50 约束');
  assert.equal(optionMaxContracts({ strategy: 'cash_secured_put', multiplier: 100, strike: 40, heldShares: 0, availableCash: 50_000 }), 12);
  assert.equal(optionMaxContracts({ strategy: 'cash_secured_put', multiplier: 500, strike: 111, heldShares: 0, availableCash: 50_000 }), 0, '乘数 500 的港股一张就超出现金 → 0 张');
  assert.equal(optionMaxContracts({ strategy: 'covered_call', multiplier: 100, strike: 425, heldShares: 500, availableCash: 0 }), 5);
  assert.equal(optionMaxContracts({ strategy: 'covered_call', multiplier: 100, strike: 425, heldShares: 99, availableCash: 0 }), 0, '不足 1 张覆盖量');
  assert.equal(optionMaxContracts({ strategy: 'covered_call', multiplier: 0, strike: 10, heldShares: 500, availableCash: 0 }), 0, '乘数缺失不能算成 1 张');
  assert.equal(optionMaxContracts({ strategy: 'cash_secured_put', multiplier: 100, strike: 8, heldShares: 0, availableCash: 0 }), 0);
});

test('optionAdviceGoal：通过门槛就必须写建议，不得用买股门槛否决卖 Put，张数按 maxContracts 给足', () => {
  const goal = optionAdviceGoal({
    personaLabel: '价值型',
    personaGuidance: '只在明显低估（安全边际 > 20%）时给出买入建议。',
    cash: { HK: 50_000, US: 0 },
    coveredCount: 0,
    putCount: 2,
    payloadJson: '{}',
    macroJson: '{}',
  });
  assert.ok(goal.includes('只做现金担保卖 Put'), '没有持股时必须明确只做卖 Put，而不是说「没有可分析的标的」');
  assert.ok(goal.includes('投资性格里的估值门槛') && goal.includes('不得用来否决卖 Put'), '必须禁止用买股的估值门槛否决卖 Put');
  assert.ok(goal.includes('只要有候选通过服务端门槛，就必须至少写入 1 条建议'), '有候选却 0 建议就是本次的故障');
  assert.ok(goal.includes('不构成') && goal.includes('绝对金额小'), '必须堵住「每张权利金太小」这个不写的借口');
  assert.ok(goal.includes('maxContracts'), '张数必须引用服务端算好的 maxContracts');
  assert.ok(goal.includes('不要默认只卖 1 张'), '默认 1 张会把收入算小');
  // 有持股时不再出现「只做现金担保卖 Put」的唯一路径说法。
  const covered = optionAdviceGoal({
    personaLabel: '价值型',
    personaGuidance: 'g',
    cash: { HK: 0, US: 0 },
    coveredCount: 2,
    putCount: 0,
    payloadJson: '{}',
    macroJson: '{}',
  });
  assert.ok(covered.includes('2 个港股/美股持股标的'), '有持股时要如实说明两种策略范围');
  assert.ok(!covered.includes('只做现金担保卖 Put'));
});
