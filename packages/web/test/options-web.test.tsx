/**
 * 期权卖权 UI 的渲染与接线断言（owner: web-options）。
 *
 * 为什么单独一个测试文件：`render.test.tsx` 是 Lead 的全站 smoke test，
 * 期权这块的验收要求（建议卡片讲清「安不安全」、最终确认弹窗可改价改期、
 * 待确认结算的确认 / 忽略、数据延迟口径显眼）需要断言具体字段，放在这里不污染主测试。
 *
 * 渲染方式与 `render.test.tsx` 完全一致：`react-dom/server` 的 `renderToString`，
 * 无 DOM、无真实服务端；弹窗正文单独成组件（portal 无法在无头环境渲染），
 * 所以这里断言的是弹窗正文 + 纯函数默认值。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type {
  AdviceItem,
  OptionAdvicePlan,
  OptionCandidatesResponse,
  OptionChainSnapshot,
  OptionPosition,
  OptionSettlement,
} from '@aia/shared';
import { App } from '../src/App';
import { ToastProvider } from '../src/components/ui';
import { AssetOptionPositions } from '../src/pages/AssetDetailDialog';
import {
  OptionConfirmFields,
  optionConfirmDraft,
  optionConfirmEconomics,
} from '../src/pages/ConfirmOptionAdviceDialog';
import { OptionAdviceCard } from '../src/pages/Advice';
import { OptionCandidatePanel, OptionChainPanel } from '../src/pages/OptionChainPanel';
import { OptionKpiGrid, OptionReadinessPanel, OptionSourceNotice, PendingSettlementsPanel } from '../src/pages/Options';
import { OptionSettingsCard } from '../src/pages/SettingsOption';
import { buildInput, toDraft } from '../src/pages/settingsDraft';
import {
  OPTION_SETTLEMENT_RULE_TEXT,
  assignmentProbabilityText,
  expiryCountdown,
  optionAssignmentConsequence,
  optionDataLine,
  optionPremiumIncome,
} from '../src/pages/optionView';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function readSource(...segments: string[]): string {
  return fs.readFileSync(path.join(SRC_DIR, ...segments), 'utf8');
}

function render(node: ReactElement): string {
  return renderToString(<ToastProvider>{node}</ToastProvider>);
}

/* ─────────────────────────────── fixtures ─────────────────────────────── */

/** 港股现金担保卖 Put（腾讯）：重点验证「被行权就是按行权价收股 + 占用现金」。 */
const hkPutPlan: OptionAdvicePlan = {
  strategy: 'cash_secured_put',
  optionType: 'put',
  optionCode: 'TCH-20261127-660-P',
  strike: 660,
  expiry: '2026-11-27',
  contracts: 2,
  multiplier: 100,
  currency: 'HKD',
  premium: 0.62,
  metrics: {
    premiumIncome: 112,
    staticYieldPct: 0.0848,
    annualizedYieldPct: 1.9,
    downsideProtectionPct: 3.5,
    collateral: 132_000,
    collateralKind: 'cash',
    maxProfit: 112,
    breakeven: 659.38,
    assignmentProbability: 0.125,
    liquidityScore: 72,
    requiredShares: 200,
  },
  underlyingPrice: 684.5,
  acceptAssignment: true,
  collateralNote: '现金担保：HKD 132,000（设置 → 期权卖权里的可用现金）',
  dataSource: 'hkex',
  dataAsOf: '2026-10-19T16:30:00+08:00',
  delayed: true,
  warnings: ['港股期权链为 HKEX 每日收市报告（收盘口径），盘中价格只能作为参考'],
};

const hkPutAdvice: AdviceItem = {
  id: 'adv_opt_hk_1',
  batchId: 'batch_opt_1',
  assetId: null,
  watchItemId: null,
  assetName: '腾讯控股',
  code: '00700',
  market: 'HK',
  type: 'stock',
  instrument: 'option',
  action: 'sell',
  origin: 'holding',
  targetShares: 200,
  targetPrice: 0.62,
  amount: 124,
  currency: 'HKD',
  reason: '**收权利金**：腾讯现价 684.5，行权价 660 有 3.5% 安全垫；被行权即按 660 收 200 股。',
  confidence: 0.72,
  status: 'pending',
  createdAt: '2026-10-19T09:00:00+08:00',
  decidedAt: null,
  executedShares: null,
  executedPrice: null,
  option: hkPutPlan,
};

/** 美股覆盖式卖 Call（苹果）：确认弹窗的默认值取自这里。 */
const usCallPlan: OptionAdvicePlan = {
  strategy: 'covered_call',
  optionType: 'call',
  optionCode: 'AAPL261120C00250000',
  strike: 250,
  expiry: '2026-11-20',
  contracts: 1,
  multiplier: 100,
  currency: 'USD',
  premium: 3.2,
  metrics: {
    premiumIncome: 320,
    staticYieldPct: 1.39,
    annualizedYieldPct: 15.87,
    downsideProtectionPct: 5.2,
    collateral: 23_000,
    collateralKind: 'shares',
    maxProfit: 320,
    breakeven: 253.2,
    assignmentProbability: 0.21,
    liquidityScore: 88,
    requiredShares: 100,
  },
  underlyingPrice: 230,
  acceptAssignment: true,
  collateralNote: '「我的资产」AAPL 持仓 100 股',
  dataSource: 'cboe',
  dataAsOf: '2026-10-19T03:55:00-04:00',
  delayed: true,
  warnings: [],
};

const usCallAdvice: AdviceItem = {
  ...hkPutAdvice,
  id: 'adv_opt_us_1',
  assetName: '苹果',
  code: 'AAPL',
  market: 'US',
  currency: 'USD',
  targetShares: 100,
  targetPrice: 3.2,
  amount: 320,
  option: usCallPlan,
};

const openPosition: OptionPosition = {
  id: 'pos_hk_1',
  adviceId: hkPutAdvice.id,
  strategy: 'cash_secured_put',
  market: 'HK',
  underlyingCode: '00700',
  underlyingName: '腾讯控股',
  underlyingAssetId: 'asset_tce',
  optionCode: 'TCH-20261127-660-P',
  optionType: 'put',
  strike: 660,
  expiry: '2026-11-27',
  contracts: 2,
  multiplier: 100,
  currency: 'HKD',
  premium: 0.62,
  fee: 12,
  premiumIncome: 112,
  collateralKind: 'cash',
  collateral: 132_000,
  underlyingPriceAtOpen: 684.5,
  status: 'open',
  openedAt: '2026-10-19T09:30:00+08:00',
  closedAt: null,
  closePrice: null,
  realizedPnl: null,
  unrealizedPnl: 36,
  daysToExpiry: 39,
  underlyingPrice: 684.5,
  moneyness: 'otm',
  settlement: null,
  note: '',
};

const coveredCallPosition: OptionPosition = {
  ...openPosition,
  id: 'pos_us_1',
  strategy: 'covered_call',
  market: 'US',
  underlyingCode: 'AAPL',
  underlyingName: '苹果',
  underlyingAssetId: 'asset_aapl',
  optionCode: 'AAPL261120C00250000',
  optionType: 'call',
  strike: 250,
  expiry: '2026-11-20',
  contracts: 1,
  currency: 'USD',
  premium: 3.2,
  fee: 1,
  premiumIncome: 319,
  collateralKind: 'shares',
  collateral: 23_000,
  unrealizedPnl: -20,
  moneyness: 'otm',
};

const pendingUncertain: OptionSettlement = {
  id: 'set_hk_1',
  contractId: openPosition.id,
  expiry: '2026-11-27',
  evaluatedAt: '2026-11-28T09:10:00+08:00',
  referencePrice: 659.5,
  priceSource: 'HKEX 每日收市报告（2026-11-27 收市价）',
  verdict: 'uncertain',
  itmAmount: 0.5,
  itmPct: 0.08,
  status: 'pending_review',
  action: 'pending',
  transactionId: null,
  assetId: null,
  realizedPnl: 0,
  note: '参考价 659.50 贴行权价 660.00（差 0.08% < 0.5%），结论可能翻面，转人工确认。',
  createdAt: '2026-11-28T09:10:00+08:00',
};

const pendingAssigned: OptionSettlement = {
  ...pendingUncertain,
  id: 'set_hk_2',
  referencePrice: 645.2,
  verdict: 'assigned',
  itmAmount: 14.8,
  itmPct: 2.24,
  note: '到期价 645.20 低于行权价 660.00（实值 2.24%），按行权价收股。',
};

const chainSnapshot: OptionChainSnapshot = {
  market: 'HK',
  code: '00700',
  name: '腾讯控股',
  underlyingPrice: 684.5,
  currency: 'HKD',
  asOf: '2026-10-19T16:30:00+08:00',
  delayed: true,
  source: 'hkex',
  expiries: [{ expiry: '2026-11-27', daysToExpiry: 39, contracts: 42, atmIv: 0.31 }],
  quotes: [
    {
      code: 'TCH-20261127-660-P',
      type: 'put',
      strike: 660,
      expiry: '2026-11-27',
      bid: 0.6,
      ask: 0.64,
      last: 0.62,
      settlement: 0.62,
      iv: 0.31,
      delta: -0.125,
      openInterest: 1200,
      volume: 168,
      multiplier: 100,
      mid: 0.62,
      spreadPct: 6.45,
    },
  ],
  warnings: ['港股期权链为 HKEX 每日收市报告（收盘口径）'],
};

const candidateResponse: OptionCandidatesResponse = {
  market: 'HK',
  code: '00700',
  currency: 'HKD',
  underlyingPrice: 684.5,
  asOf: '2026-10-19T16:30:00+08:00',
  delayed: true,
  source: 'hkex',
  candidates: [
    {
      strategy: 'cash_secured_put',
      quote: chainSnapshot.quotes[0]!,
      metrics: hkPutPlan.metrics,
    },
  ],
  rejected: [{ code: 'TCH-20261127-640-P', reason: 'DELTA_TOO_HIGH：|delta| 0.41 > 0.35，被行权概率过高' }],
  warnings: [],
};

/* ─────────────────────── ① 建议页：期权卡片 ─────────────────────── */

test('期权建议卡片：策略 / 行权价 / 到期 / 年化 / 安全垫 / 被行权概率与「期权」徽标都在', () => {
  const html = render(<OptionAdviceCard item={hkPutAdvice} busyId={null} onConfirm={() => undefined} onReject={() => undefined} />);

  // 徽标：必须能一眼分清「这是期权」以及是哪一种卖权策略。
  assert.ok(html.includes('期权'), '卡片缺少「期权」徽标');
  assert.ok(html.includes('现金担保卖 Put'), '卡片缺少策略徽标（现金担保卖 Put）');
  assert.ok(html.includes('TCH-20261127-660-P'), '卡片缺少合约代码');
  assert.ok(html.includes('来源：持仓'), '期权建议同样要标注来源');

  // 安全相关的数字：行权价、到期与剩余天数、年化/静态收益率、安全垫、被行权概率。
  assert.ok(html.includes('HK$660.00'), '卡片缺少行权价');
  assert.ok(html.includes('2026-11-27'), '卡片缺少到期日');
  assert.ok(html.includes('剩余'), '卡片缺少剩余天数');
  assert.ok(html.includes('年化收益率') && html.includes('1.90%'), '卡片缺少年化收益率');
  assert.ok(html.includes('静态') && html.includes('0.08%'), '卡片缺少静态收益率');
  assert.ok(html.includes('安全垫') && html.includes('3.50%'), '卡片缺少安全垫');
  assert.ok(html.includes('被行权概率') && html.includes('12.5%'), '卡片缺少被行权概率');
  assert.ok(html.includes('估算'), '港股被行权概率必须标注是估算（只有平值系列有 IV/delta）');

  // 担保占用 / 流动性 / 数据口径（用户最担心「这价准不准」）。
  assert.ok(html.includes('担保占用（现金）') && html.includes('HK$132,000.00'), '卡片缺少担保占用');
  assert.ok(html.includes('流动性 72/100'), '卡片缺少流动性说明');
  assert.ok(html.includes('港交所每日收市报告'), '卡片缺少数据来源');
  assert.ok(html.includes('延迟'), '延迟口径必须显眼标注');
  assert.ok(html.includes('港股期权链为 HKEX 每日收市报告（收盘口径），盘中价格只能作为参考'), 'warnings 必须原样展示');

  // 操作：确认 / 驳回。
  assert.ok(html.includes('确认') && html.includes('驳回'), '卡片缺少确认 / 驳回按钮');
});

test('期权建议卡片：现金担保卖 Put 讲清「被行权就按行权价收股，收股数量与占用现金」', () => {
  const html = render(<OptionAdviceCard item={hkPutAdvice} busyId={null} onConfirm={() => undefined} onReject={() => undefined} />);
  assert.ok(html.includes('被行权：按行权价 HK$660.00 收到 200 股'), '卖 Put 必须写明按行权价收股与股数');
  assert.ok(html.includes('占用现金 HK$132,000.00'), '卖 Put 必须写明占用现金');

  const consequence = optionAssignmentConsequence({
    optionType: 'call',
    strike: 250,
    multiplier: 100,
    contracts: 1,
    currency: 'USD',
    collateralNote: '「我的资产」AAPL 持仓',
  });
  assert.ok(consequence.includes('交出 100 股'), '卖 Call 必须写明交出的股数');
  assert.ok(consequence.includes('$250.00'), '卖 Call 必须写明行权价');
});

test('期权卡片：覆盖式卖 Call 的策略目标与持股担保可见', () => {
  const html = render(<OptionAdviceCard item={usCallAdvice} busyId={null} onConfirm={() => undefined} onReject={() => undefined} />);
  assert.ok(html.includes('覆盖式卖 Call'), '缺少覆盖式卖 Call 徽标');
  assert.ok(html.includes('用已有持股做担保收权利金'), '必须说明覆盖式卖 Call 的策略目标');
  assert.ok(html.includes('担保占用（持股）'), '卖 Call 的担保物是持股');
  assert.ok(html.includes('需持股 100 股'), '必须写明需要多少股做担保');
  assert.ok(html.includes('|delta| 代理'), '美股被行权概率按 |delta| 代理，不需要「估算」标注');
});

test('期权口径函数：剩余天数 / 数据口径 / 被行权概率文案', () => {
  const now = new Date('2026-10-19T10:00:00+08:00');
  assert.equal(expiryCountdown('2026-11-20', now), '到期 2026-11-20 · 剩余 32 天');
  assert.equal(expiryCountdown('2026-10-18', now), '到期 2026-10-18 · 已过期 1 天');
  assert.ok(optionDataLine(hkPutPlan).includes('港交所每日收市报告'));
  assert.ok(optionDataLine(hkPutPlan).includes('延迟/收盘口径'));
  assert.equal(assignmentProbabilityText(0.125, 'HK'), '被行权概率 12.5% · 港股为估算（只覆盖平值系列的 IV/delta）');
  assert.equal(assignmentProbabilityText(0, 'US'), '被行权概率未评估');
});

/* ─────────────────── ② 最终确认弹窗（可改价 / 可改期） ─────────────────── */

test('最终确认弹窗：默认值来自 AI 方案，合约价格与合约时间可编辑且实时重算权利金', () => {
  const draft = optionConfirmDraft(usCallAdvice);
  assert.equal(draft.premium, '3.2', '合约价格默认值必须来自建议里的每股价权利金');
  assert.equal(draft.expiry, '2026-11-20', '合约时间默认值必须来自建议里的到期日');
  assert.equal(draft.contracts, '1', '张数默认值来自建议');
  assert.equal(draft.strike, '250', '行权价默认值来自建议');

  const html = render(<OptionConfirmFields item={usCallAdvice} draft={draft} onChange={() => undefined} />);
  assert.ok(html.includes('合约价格（每股价权利金，USD）'), '缺少可编辑的「合约价格」字段');
  assert.ok(html.includes('合约时间（到期日）'), '缺少可编辑的「合约时间」字段');
  assert.ok(html.includes('value="3.2"'), '合约价格必须回填默认值（可编辑）');
  assert.ok(html.includes('value="2026-11-20"'), '合约时间必须回填默认值（可编辑）');
  assert.ok(html.includes('value="250"'), '行权价必须可编辑');
  assert.ok(html.includes('value="1"'), '张数必须可编辑');
  assert.ok(html.includes('最终确认'), '弹窗必须写明这是最终确认');
  assert.ok(html.includes('不能修改合约条件'), '必须写明提交后不可逆');
  assert.ok(html.includes('被行权后果（不可逆）'), '必须写明被行权后果');
  assert.ok(html.includes('交出 100 股'), '卖 Call 被行权要交出 multiplier × contracts 股');
  assert.ok(html.includes('到期自动结算规则'), '必须写明到期自动结算规则');
  assert.ok(html.includes(OPTION_SETTLEMENT_RULE_TEXT.slice(0, 20)), '结算规则的正文必须出现在弹窗里');
  assert.ok(html.includes('按最终条件重算'), '必须显示按最终条件重算的数字');
  assert.ok(html.includes('$320.00'), '权利金收入要按最终条件重算');
});

test('最终确认弹窗：港股卖 Put 的默认值与「占用现金」重算', () => {
  const draft = optionConfirmDraft(hkPutAdvice);
  assert.equal(draft.premium, '0.62');
  assert.equal(draft.expiry, '2026-11-27');

  const html = render(<OptionConfirmFields item={hkPutAdvice} draft={draft} onChange={() => undefined} />);
  assert.ok(html.includes('value="0.62"'), '合约价格默认值应来自建议（0.62）');
  assert.ok(html.includes('value="2026-11-27"'), '合约时间默认值应来自建议（2026-11-27）');
  assert.ok(html.includes('HK$124.00'), '权利金收入 = 0.62 × 100 × 2');
  assert.ok(html.includes('现金 = 行权价 × 100 × 2'), '卖 Put 的担保必须是「行权价 × 乘数 × 张数」的现金');
});

test('确认经济性重算：改价 / 改期 / 改张数后的权利金收入与年化都跟着变', () => {
  assert.equal(optionPremiumIncome(3.2, 100, 1, 0), 320);
  assert.equal(optionPremiumIncome(0.62, 100, 2, 12), 112);

  const base = optionConfirmEconomics({
    premium: 3.2,
    contracts: 1,
    strike: 250,
    fee: 1,
    multiplier: 100,
    collateralKind: 'shares',
    underlyingPrice: 230,
    expiry: '2026-11-20',
    now: new Date('2026-10-19T10:00:00+08:00'),
  });
  assert.equal(base.income, 319, '权利金收入 = 每股价 × 乘数 × 张数 − 费用');
  assert.equal(base.shares, 100);
  assert.equal(base.collateral, 23_000, '覆盖式卖 Call 的担保 = 对应股数市值');
  assert.ok(base.daysToExpiry > 0);
  assert.ok(base.annualizedYieldPct > base.staticYieldPct, '年化必须按剩余天数放大静态收益率');

  const repriced = optionConfirmEconomics({
    premium: 4.5,
    contracts: 2,
    strike: 250,
    fee: 1,
    multiplier: 100,
    collateralKind: 'shares',
    underlyingPrice: 230,
    expiry: '2026-11-20',
    now: new Date('2026-10-19T10:00:00+08:00'),
  });
  assert.equal(repriced.income, 899, '用户改价与张数后必须按新条件重算');
  assert.equal(repriced.shares, 200);
});

/* ─────────────── ③ 期权页：KPI / 待确认结算 / 延迟口径 ─────────────── */

test('期权页 KPI：在手合约、权利金收入、已实现、被行权次数、待确认结算、分市场担保占用', () => {
  const html = render(
    <OptionKpiGrid
      summary={{
        openContracts: 3,
        premiumIncome: 1280.5,
        realizedPremium: 742.25,
        assignedCount: 1,
        pendingSettlements: 2,
        collateralByMarket: [
          { market: 'HK', currency: 'HKD', amount: 132_000 },
          { market: 'US', currency: 'USD', amount: 23_000 },
        ],
      }}
    />,
  );
  for (const label of ['在手合约', '权利金总收入', '已实现权利金', '被行权次数', '待确认结算']) {
    assert.ok(html.includes(label), `KPI 缺少「${label}」`);
  }
  assert.ok(html.includes('担保占用 · 港股'), '缺少港股担保占用');
  assert.ok(html.includes('担保占用 · 美股'), '缺少美股担保占用');
  assert.ok(html.includes('HK$132,000'), '港股担保占用必须按 HKD 显示');
  assert.ok(html.includes('$23,000'), '美股担保占用必须按 USD 显示');
});

test('待确认结算：判定 / 参考价与来源 / 实值 / 原因 + 「确认并入账」「忽略」按钮', () => {
  const positionById = new Map<string, OptionPosition>([[openPosition.id, openPosition]]);
  const html = render(
    <PendingSettlementsPanel
      items={[pendingUncertain, pendingAssigned]}
      positionById={positionById}
      busyId={null}
      onConfirm={() => undefined}
      onDismiss={() => undefined}
    />,
  );

  assert.ok(html.includes('判定存疑·待确认'), '待确认区必须显示判定结论');
  assert.ok(html.includes('实值到期·已行权'), '实值行权结论必须可见');
  assert.ok(html.includes('参考价'), '必须显示结算参考价');
  assert.ok(html.includes('HKEX 每日收市报告（2026-11-27 收市价）'), '必须显示参考价来源口径');
  assert.ok(html.includes('实值 HK$0.50'), '必须显示实值金额');
  assert.ok(html.includes('原因说明'), '必须显示为什么转人工确认');
  assert.ok(html.includes('确认并入账'), '缺少「确认并入账」按钮');
  assert.ok(html.includes('忽略'), '缺少「忽略」按钮');
  assert.ok(html.includes('实值行权（交股 / 收股）'), '必须可把最终判定切换为 assigned');
  assert.ok(html.includes('虚值落袋（权利金归我）'), '必须可把最终判定切换为 otm_no_assignment');
  assert.ok(html.includes('覆盖参考价'), '必须可覆盖参考价');
  assert.ok(html.includes('settle-card'), '待确认结算必须用醒目的卡片样式');
});

test('待确认结算为空时给出「为什么没有」的解释', () => {
  const html = render(
    <PendingSettlementsPanel items={[]} positionById={new Map()} busyId={null} onConfirm={() => undefined} onDismiss={() => undefined} />,
  );
  assert.ok(html.includes('没有待确认的结算'), '空态必须说明当前没有待确认记录');
  assert.ok(html.includes('自动入账'), '空态要说明明确结论会自动入账');
});

test('数据来源与延迟口径：来源名 / 延迟标记 / 警告原样展示', () => {
  const html = render(<OptionSourceNotice warnings={['港股期权链为 T+1 收盘口径，盘中不更新']} />);
  assert.ok(html.includes('数据来源与口径'), '缺少数据来源口径卡片');
  assert.ok(html.includes('港交所每日收市报告'), '必须写明港股来源');
  assert.ok(html.includes('CBOE'), '必须写明美股来源');
  assert.ok(html.includes('延迟'), '必须写明延迟口径');
  assert.ok(html.includes('港股期权链为 T+1 收盘口径，盘中不更新'), 'warnings 必须原样展示');
});

test('期权链快照：现价 / 来源 / 抓取时间 / 延迟标记 / 价差与 IV 都可见', () => {
  const html = render(<OptionChainPanel snapshot={chainSnapshot} />);
  assert.ok(html.includes('期权链快照'), '缺少期权链标题');
  assert.ok(html.includes('HK$684.50'), '期权链必须显示标的现价');
  assert.ok(html.includes('延迟 / 收盘口径（非实时）'), '延迟标记必须显眼');
  assert.ok(html.includes('港交所每日收市报告'), '必须显示价格来源');
  assert.ok(html.includes('价差%'), '必须展示买卖价差（流动性）');
  assert.ok(html.includes('6.5%'), '价差百分比必须可见');
  assert.ok(html.includes('31.0%'), '平值 IV 必须可见');
});

test('卖权候选：安全门槛的解释（年化 / 安全垫 / 被行权概率 / 被挡掉的原因）', () => {
  const html = render(<OptionCandidatePanel data={candidateResponse} />);
  assert.ok(html.includes('卖权候选（确定性筛选）'), '缺少候选区标题');
  assert.ok(html.includes('现金担保卖 Put'), '候选卡片缺少策略徽标');
  assert.ok(html.includes('年化'), '候选卡片缺少年化收益率');
  assert.ok(html.includes('安全垫'), '候选卡片缺少安全垫');
  assert.ok(html.includes('被行权概率'), '候选卡片缺少被行权概率');
  assert.ok(html.includes('被安全门槛挡掉'), '必须解释为什么有些合约没被推荐');
  assert.ok(html.includes('DELTA_TOO_HIGH'), '被挡掉的原因必须原样展示');
});

/* ───────────── ④ 资产详情：覆盖式卖 Call 与持仓联动 ───────────── */

test('资产详情：已卖出的 Call 显示行权价 / 到期 / 张数 / 权利金，并核对持股够不够担保', () => {
  const html = render(<AssetOptionPositions items={[coveredCallPosition]} shares={50} currency="USD" />);
  assert.ok(html.includes('AAPL261120C00250000'), '缺少合约代码');
  assert.ok(html.includes('覆盖式卖 Call'), '缺少策略');
  assert.ok(html.includes('$250.00'), '缺少行权价');
  assert.ok(html.includes('2026-11-20'), '缺少到期日');
  assert.ok(html.includes('$3.200'), '缺少每股价权利金');
  assert.ok(html.includes('$319.00'), '缺少权利金收入');
  assert.ok(html.includes('需持股 100 / 现有 50 股'), '必须把需要的担保股数与现有持股并排显示');
  assert.ok(html.includes('持股缺口 50 股'), '持股不足时必须明确告警');
  assert.ok(html.includes('裸卖 Call'), '必须说明持股不足时被行权会变成裸卖 Call');

  const empty = render(<AssetOptionPositions items={[]} shares={0} currency="USD" />);
  assert.ok(empty.includes('没有在手的卖出合约'), '没有合约时必须给出解释而不是空白');
});

/* ───────────────── ⑤ 设置页：期权卖权卡片与草稿不被重置 ───────────────── */

test('设置页期权卡片：可用现金 / 结算模式 / 是否随流水线跑', () => {
  const html = render(
    <OptionSettingsCard
      value={{ cashHK: '132000', cashUS: '23000', settlementMode: 'auto', runWithPipeline: true }}
      onChange={() => undefined}
    />,
  );
  assert.ok(html.includes('期权卖权'), '缺少期权卖权卡片标题');
  assert.ok(html.includes('港股可用现金（HKD）'), '缺少港股可用现金');
  assert.ok(html.includes('美股可用现金（USD）'), '缺少美股可用现金');
  assert.ok(html.includes('value="132000"'), '现金必须回填草稿值');
  assert.ok(html.includes('明确自动入账 · 存疑待确认'), '缺少 auto 模式说明');
  assert.ok(html.includes('全部待确认'), '缺少 manual 模式');
  assert.ok(html.includes('随「AI 投资建议」流水线一起跑期权卖权分析'), '缺少随流水线开关');
  assert.ok(html.includes('可覆盖'), '必须给出「这些现金能覆盖多大合约」的口径');
});

test('settingsDraft：期权设置默认值完整，保存时不会被重置，只下发变化的字段', () => {
  const settings = {
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
    schedules: [],
    enforceBudget: true,
    watchlistCandidateLimit: 5,
    watchlistRetireDeleteRuns: 3,
    toolPolicy: { deny: [], requireWriteApproval: false },
    mcpServers: [],
    option: { cash: { HK: 132_000, US: 23_000 }, settlementMode: 'manual' as const, runWithPipeline: false },
    updatedAt: '2026-10-19T09:00:00+08:00',
  } as Parameters<typeof toDraft>[0];

  const draft = toDraft(settings);
  assert.deepEqual(draft.option, { cashHK: '132000', cashUS: '23000', settlementMode: 'manual', runWithPipeline: false });
  assert.deepEqual(buildInput(draft, draft), {}, '没有改动时不能下发任何期权字段（否则会把服务端设置重置）');

  // 服务端没返回 option（老版本 / 精简 payload）时回退默认值，而不是把设置保存成空。
  const legacy = { ...settings, option: undefined } as unknown as Parameters<typeof toDraft>[0];
  const legacyDraft = toDraft(legacy);
  assert.deepEqual(legacyDraft.option, { cashHK: '0', cashUS: '0', settlementMode: 'auto', runWithPipeline: true });

  // 只改港股现金：必须只带 cash，且两个市场都给出完整值（契约要求）。
  const cashInput = buildInput({ ...draft, option: { ...draft.option, cashHK: '150000' } }, draft);
  assert.deepEqual(cashInput.option, { cash: { HK: 150_000, US: 23_000 } });

  // 只改结算模式：不带 cash。
  const modeInput = buildInput({ ...draft, option: { ...draft.option, settlementMode: 'auto' } }, draft);
  assert.deepEqual(modeInput.option, { settlementMode: 'auto' });

  // 只改流水线开关：不带 cash / 模式。
  const pipelineInput = buildInput({ ...draft, option: { ...draft.option, runWithPipeline: true } }, draft);
  assert.deepEqual(pipelineInput.option, { runWithPipeline: true });

  // 现金填成非数字要在保存前报错，而不是静默写成 0。
  assert.throws(() => buildInput({ ...draft, option: { ...draft.option, cashHK: 'abc' } }, draft), /港股可用现金/);
});

/* ─────────────────── ⑥ 页面接线（路由 / 导航 / API） ─────────────────── */

test('期权卖权页：路由 / 导航 / 标题三处都已接线，且能无头渲染', () => {
  const app = readSource('App.tsx');
  assert.ok(app.includes('path="/options"'), 'App.tsx 缺少 /options 路由');
  assert.ok(app.includes('OptionsPage'), 'App.tsx 未引入期权卖权页');

  const layout = readSource('components', 'Layout.tsx');
  assert.ok(layout.includes("to: '/options'"), '导航缺少期权卖权入口');
  assert.ok(layout.includes("'/options':"), '页头标题表缺少 /options');

  const html = renderToString(
    <MemoryRouter initialEntries={['/options']}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </MemoryRouter>,
  );
  assert.ok(html.includes('期权卖权'), '期权卖权页渲染结果缺少页面标题');
  assert.ok(html.includes('Premium Desk'), '期权卖权页缺少页头 eyebrow');
  assert.ok(html.includes('待确认结算'), '期权卖权页缺少「待确认结算」区');
  assert.ok(html.includes('数据来源与口径'), '期权卖权页缺少数据口径说明');
  assert.ok(html.includes('卖权前置条件自检'), '期权卖权页缺少「为什么这里是空的」自检区块');
});

test('API 客户端：期权接口与 confirm-option 全部按冻结契约接线', () => {
  const client = readSource('api', 'client.ts');
  for (const fragment of [
    '/options/chain',
    '/options/candidates',
    '/options/analyze',
    '/options/positions',
    '/close',
    '/settle',
    '/options/settlements',
    '/settlements/scan',
    '/settlements/${encodeURIComponent(id)}/confirm',
    '/settlements/${encodeURIComponent(id)}/dismiss',
    '/confirm-option',
  ]) {
    assert.ok(client.includes(fragment), `client.ts 缺少期权接口片段「${fragment}」`);
  }
  assert.ok(/positions: \(\) =>/.test(client), 'client 缺少 options.positions');
  assert.ok(/confirmOption:/.test(client), 'client 缺少 advice.confirmOption');
});

test('建议页接线：期权卡片走独立确认弹窗，且现有断言结构未被破坏', () => {
  const advice = readSource('pages', 'Advice.tsx');
  assert.ok(advice.includes('ConfirmOptionAdviceDialog'), '建议页必须挂载期权最终确认弹窗');
  assert.ok(advice.includes("item.instrument === 'option'"), '期权建议必须与股票建议分开渲染');
  assert.ok(advice.includes("'/options/analyze'"), '建议页需要能单独跑「AI 期权卖权建议」');
  const dialog = readSource('pages', 'ConfirmOptionAdviceDialog.tsx');
  assert.ok(dialog.includes('api.advice.confirmOption'), '最终确认弹窗必须调用 POST /api/advice/:id/confirm-option');
  // 不能破坏 Lead 在 render.test.tsx 里的源码级断言。
  assert.ok(advice.includes('<InstrumentTypeTag type={item.type}'), '股票建议行仍必须渲染 InstrumentTypeTag');
  assert.ok(advice.includes('IpoDetailDialog') && advice.includes('setRegisterId'), '打新登记入口不能被改动');
  assert.ok(advice.includes("'/ipo/analyze'"), '打新分析按钮不能被改动');
  assert.ok(advice.includes('推荐理由'), '打新表格的「推荐理由」列不能被改动');
});

test('建议页分区顺序：正股买卖 → 打新 → 期权卖权（预算卡仍在最上方）', () => {
  const advice = readSource('pages', 'Advice.tsx');
  const lines = advice.split('\n');
  const lineOf = (title: string): number => {
    const index = lines.findIndex((line) => line.trim() === title || (title === '建议列表（' && line.trim().startsWith('建议列表（')));
    assert.ok(index >= 0, `Advice.tsx 缺少标题行「${title}」`);
    return index;
  };

  const budget = lineOf('本月投资预算');
  const stock = lineOf('建议列表（');
  const ipo = lineOf('打新建议');
  const option = lineOf('期权卖权建议');

  assert.ok(budget < stock, '预算卡（含「AI 投资建议」按钮）必须仍在最上方');
  assert.ok(stock < ipo, '正股买卖建议必须排在打新建议之前');
  assert.ok(ipo < option, '打新建议必须排在期权卖权建议之前');

  // 位置变了，跨区引用也要跟着改：正股卡现在在期权卡**上方**。
  assert.ok(advice.includes('已在下方「期权卖权建议」卡片里逐条展开'), '正股卡里的跨区指引必须改成「下方」');
  assert.ok(!advice.includes('已在上方「期权卖权建议」卡片里逐条展开'), '不能留下指向错误方向的旧文案');

  // 三块内容都还在（顺序调整不能丢内容）。
  assert.ok(advice.includes('<IpoDetailDialog'), '打新登记浮窗必须保留');
  assert.ok(advice.includes('OptionAdviceCard'), '期权建议卡片必须保留');
});

test('期权页使用全局 Agent Provider（不自己开 SSE）并订阅 entity 事件刷新', () => {
  const options = readSource('pages', 'Options.tsx');
  assert.ok(options.includes('useAgentActivity'), '期权页必须走全局 Agent Provider');
  assert.ok(options.includes('useAgentRefresh'), '期权页必须订阅 entity 事件刷新');
  assert.ok(!/[^a-zA-Z]useAgentStream\(/.test(options), '期权页不得自己开 SSE 流');
  assert.ok(options.includes('api.options.scanSettlements'), '缺少「立即扫描到期结算」');
  assert.ok(options.includes('api.options.confirmSettlement'), '缺少确认结算调用');
  assert.ok(options.includes('api.options.dismissSettlement'), '缺少忽略结算调用');
  assert.ok(options.includes('api.options.settlePosition'), '缺少单个合约结算入口');
  assert.ok(options.includes('api.options.positions'), '缺少在手合约读取');
  assert.ok(options.includes('api.options.settlements'), '缺少结算记录读取');
  assert.ok(options.includes('OptionCreateDialog'), '缺少手工登记卖出合约弹窗');
  assert.ok(options.includes('OptionCloseDialog'), '缺少买平弹窗');

  const create = readSource('pages', 'OptionCreateDialog.tsx');
  assert.ok(create.includes('api.options.createPosition'), '手工登记必须调用 POST /api/options/positions');
  const close = readSource('pages', 'OptionCloseDialog.tsx');
  assert.ok(close.includes('api.options.closePosition'), '买平必须调用 POST /api/options/positions/:id/close');
});

test('活动页：期权卖权与打新分析的运行类型都可筛选', () => {
  const activity = readSource('pages', 'Activity.tsx');
  assert.ok(activity.includes("'option-advice'"), '活动页缺少 option-advice 过滤项');
  assert.ok(activity.includes("'ipo-analysis'"), '活动页缺少 ipo-analysis 过滤项（此前缺失）');
});

/* ═════════ 前置条件自检：回答「为什么期权卖权页什么都没有」 ═════════ */

function renderWithRouter(node: ReactElement): string {
  return renderToString(
    <MemoryRouter>
      <ToastProvider>{node}</ToastProvider>
    </MemoryRouter>,
  );
}

test('前置条件自检：没有任何担保物时必须说清「不是故障」，并给出可操作出口', () => {
  const html = renderWithRouter(
    <OptionReadinessPanel holdings={[]} cash={{ HK: 0, US: 0 }} pendingAdvice={0} />,
  );
  assert.ok(html.includes('卖权前置条件自检'), '缺少自检区块标题');
  assert.ok(html.includes('当前没有可卖权的担保物'), '没有担保物时必须显式告警');
  assert.ok(html.includes('不会产生任何建议，这不是故障'), '必须说明空结果是预期行为而不是故障');
  assert.ok(html.includes('没有港股/美股持仓'), '必须点明缺的是港股/美股持仓');
  assert.ok(html.includes('A 股没有个股期权'), '必须说明 A 股持股不能用于覆盖式卖 Call');
  assert.ok(html.includes('这不影响现金担保卖 Put'), '必须说清「没有持股」不挡卖 Put（担保物是现金）');
  assert.ok(html.includes('两项都是 0'), '现金为 0 时必须点明现金担保卖 Put 不会出候选');
  assert.ok(html.includes('去设置页填写'), '必须给出「去设置页填写可用现金」的出口');
  assert.ok(html.includes('当前没有待处理的期权卖权建议'), '必须说明当前没有建议');
  assert.ok(html.includes('本页只管理'), '必须说明本页只管理已确认合约与到期结算');
  assert.ok(html.includes('AI 投资建议'), '必须指向建议所在的页面');
});

test('前置条件自检：有担保物时给出正面结论与建议去向（不改算张数）', () => {
  const html = renderWithRouter(
    <OptionReadinessPanel
      holdings={[{ code: '00700', name: '腾讯控股', market: 'HK', shares: 500 }]}
      cash={{ HK: 50_000, US: 0 }}
      pendingAdvice={2}
    />,
  );
  assert.ok(!html.includes('当前没有可卖权的担保物'), '有担保物时不得再显示无担保告警');
  assert.ok(html.includes('港股 00700 腾讯控股 500 股'), '必须列出可用于覆盖的持股');
  assert.ok(html.includes('HK$50,000.00'), '必须显示该市场的期权可用现金');
  assert.ok(html.includes('已有 2 条期权卖权建议'), '必须告诉用户建议在建议页等着确认');
  assert.ok(html.includes('合约乘数'), '张数必须说明由服务端按合约乘数校验（港股乘数 ≠ 每手股数）');
  assert.ok(!html.includes('最多能卖'), '前端不得自己推算可卖张数');
});

test('期权卖权页：自检已挂到页面上，且不再声称未实测的「延迟约 15 分钟」', () => {
  const options = readSource('pages', 'Options.tsx');
  assert.ok(options.includes('<OptionReadinessPanel'), '自检区块必须挂到期权卖权页');
  assert.ok(options.includes('api.assets.list'), '自检必须读取真实持仓');
  assert.ok(options.includes('api.settings.get'), '自检必须读取期权可用现金设置');
  assert.ok(options.includes('api.advice.list'), '自检必须读取待处理的期权建议');
  assert.ok(options.includes("to=\"/advice\""), '自检必须能跳到「AI 投资建议」页');
  // CBOE 响应体里没有延迟时长字段，数据源已明确「不声称具体分钟数」：
  // 页面文案不得给出未经证实的「约 15 分钟」。
  assert.ok(!options.includes('约 15 分钟'), '页面不得声称未经实测的延迟分钟数');
  assert.ok(options.includes('上游响应体未标注延迟时长'), '页面必须如实说明延迟口径未知');
});
