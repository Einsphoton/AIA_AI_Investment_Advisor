/**
 * 新股打新（IPO）测试：数据源解析 / 刷新写入 / 申购与中签入账 / 备份往返。
 *
 * 全部离线：行情网络层通过 stub `globalThis.fetch` 或注入 `collect` 假采集器替换，
 * 因此这些用例在断网与上游改版时都能给出确定的判断。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_BUDGET, type Market } from '@aia/shared';

import { executeTool, type AllowWrite, type ToolContext } from '../src/agent/tools.js';
import { createRepo } from '../src/db/repo.js';
import { clearHttpCache } from '../src/datasources/http.js';
import { collectIpoOffers } from '../src/datasources/ipo.js';
import type { IpoOfferDraft } from '../src/datasources/types.js';
import { AppError } from '../src/errors.js';
import {
  deriveIpoStatus,
  ipoOfferDetail,
  ipoUid,
  listIpoPayload,
  recordIpoAllotment,
  refreshIpoOffers,
  subscribeIpo,
  upsertManualIpoOffer,
} from '../src/services/ipo.js';
import { buildBackupPayload, importBackupPayload, validateBackupPayload } from '../src/services/backup.js';
import type { Repo } from '../src/types/repo.js';

function tempRepo(): { repo: Repo; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-ipo-'));
  const repo = createRepo(path.join(dir, 'advisor.db'));
  repo.migrate();
  return { repo, dir };
}

/**
 * 路由各上游主机；未匹配的一律当作上游故障（502）。
 *
 * 每个用例都必须用返回的 `restore()` 复原 —— 测试文件在同一个进程里顺序导入，
 * 泄漏出去会让后续用例（如 LLM 重试用例）拿到 502 而假性失败。
 */
function stubFetch(handler: (url: string) => Response | null): { urls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    const response = handler(url);
    if (response) return response;
    return new Response('<html><title>502 Bad Gateway</title></html>', { status: 502 });
  }) as unknown as typeof fetch;
  clearHttpCache();
  return {
    urls,
    restore: () => {
      globalThis.fetch = original;
      clearHttpCache();
    },
  };
}

const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
});

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/** 构造工具执行上下文：`kind` 决定「代签成交」白名单是否放行。 */
function toolCtx(repo: Repo, kind: ToolContext['kind']): ToolContext {
  return {
    runId: `run-${kind}`,
    kind,
    repo,
    logger: silentLogger as unknown as ToolContext['logger'],
    sink: () => undefined,
    allowWrites: new Set<AllowWrite>(['ipo']),
    target: null,
    batchId: `batch-${kind}`,
  };
}

/* ────────────────────────── A 股：东方财富报表 ────────────────────────── */

const CN_ROW = {
  SECURITY_CODE: '001381',
  APPLY_CODE: '001381',
  SECURITY_NAME_ABBR: '皇冠新材',
  ISSUE_PRICE: 16.98,
  ONLINE_APPLY_UPPER: 13500,
  EACHBALLOT_SHARES: '500',
  APPLY_DATE: '2026-10-19 00:00:00',
  BALLOT_NUM_DATE: '2026-10-21 00:00:00',
  LISTING_DATE: null,
  ISSUE_NUM: 5630.4768,
  TOTAL_RAISE_FUNDS: 9.56055,
  AFTER_ISSUE_PE: 25.87,
  INDUSTRY_PE_NEW: 27.65,
  ONLINE_ISSUE_LWR: 0.0302,
  RECOMMEND_ORG: '中国国际金融股份有限公司',
  INDUSTRY_NAME: '橡胶和塑料制品业',
  TRADE_MARKET: '深交所主板',
  INFO_CODE: 'AN202607181827095229',
};

test('A股新股：按 APPLY_DATE 过滤取数，单位（万股/亿元/股）必须换算正确', async (t) => {
  const { urls, restore } = stubFetch((url) => {
    if (url.includes('datacenter-web.eastmoney.com')) {
      return new Response(JSON.stringify({ success: true, result: { data: [CN_ROW, { SECURITY_CODE: '999999' }] } }), {
        status: 200,
      });
    }
    return null;
  });
  t.after(restore);
  const result = await collectIpoOffers({ markets: ['CN'], limitPerMarket: 5 });
  const offer = result.offers[0]!;

  assert.equal(result.offers.length, 1, '缺代码/名称的记录必须被跳过（不产生半条垃圾数据）');
  assert.equal(offer.market, 'CN');
  assert.equal(offer.code, '001381');
  assert.equal(offer.name, '皇冠新材');
  assert.equal(offer.source, 'eastmoney-ipo');
  assert.equal(offer.issuePrice, 16.98);
  assert.equal(offer.lotSize, 500, 'EACHBALLOT_SHARES 是每签股数（字符串）');
  assert.equal(offer.maxShares, 13500);
  assert.equal(offer.subscribeStart, '2026-10-19');
  assert.equal(offer.subscribeEnd, '2026-10-19', 'A股发行只有一天申购期：起止相同');
  assert.equal(offer.allotmentDate, '2026-10-21');
  assert.equal(offer.listingDate, null, '尚未上市：不能拿申购日冒充上市日');
  assert.equal(offer.issueShares, 56_304_768, 'ISSUE_NUM 单位是万股');
  assert.equal(offer.raiseAmount, 956_055_000, 'TOTAL_RAISE_FUNDS 单位是亿元');
  assert.equal(offer.issuePe, 25.87);
  assert.equal(offer.industryPe, 27.65);
  assert.equal(offer.winningRate, 0.0302, '中签率按上游给的百分比原值存');
  assert.equal(offer.sponsor, '中国国际金融股份有限公司');
  assert.equal(offer.prospectusUrl, 'https://data.eastmoney.com/notices/detail/001381/AN202607181827095229.html');
  assert.deepEqual(result.sources, ['eastmoney-ipo']);
  assert.deepEqual(result.warnings, []);

  const requested = decodeURIComponent(urls.find((url) => url.includes('datacenter-web.eastmoney.com'))!);
  assert.ok(requested.includes('reportName=RPTA_APP_IPOAPPLY'), '必须用实测可用的报表名');
  assert.ok(/filter=\(APPLY_DATE>=/.test(requested), '不过滤会返回 1991 年的老记录');
  assert.ok(requested.includes('sortColumns=APPLY_DATE'), '按申购日倒序才能拿到最新一只');
});

/* ────────────────────────────── 港股（三源合并） ────────────────────────────── */

const ETNET_HTML = `<script>var data = { listing_ipo_array:[
  {"stockcode":"06157","stocknametc":"瘦西湖文旅","offerpricefrom":"3.92","offerpriceto":"5.07",
   "applicationstart":"2026/10/14","applicationend":"2026/10/20","resultdate":"2026/10/22",
   "listdate":"2026/10/23","boardlot":"1,000","admissionfee":"$5,121.14","stage":1,"naturetc":"旅遊","sponsors":["48"]},
  {"stockcode":"06802","stocknametc":"歡創科技","offerpricefrom":"58.85","offerpriceto":"58.85",
   "applicationstart":"2026/09/22","applicationend":"2026/09/30","resultdate":"2026/09/30",
   "listdate":"2026/09/30","boardlot":"100","stage":1}
], ipoSetting:{}}</script>`;

const HK_EM_HTML = `<table><tbody>
  <tr><td>1</td><td>02636</td><td>傳音控股</td><td>35.30-38.80</td><td>8664.83万</td><td>30.59亿</td><td>2026-10-07</td><td>2026-10-15</td></tr>
  <tr><td>2</td><td>06802</td><td>歡創科技</td><td>58.85-58.85</td><td>1158.88万</td><td>6.82亿</td><td>2026-09-22</td><td>2026-09-30</td></tr>
</tbody></table>`;

const AASTOCKS_UPCOMING = `<table id="tblGMUpcoming"><thead><tr>
  <th></th><th>公司名稱 ▼ / 代號 ▼</th><th>行業</th><th>招股價</th><th>每手股數</th><th>入場費</th>
  <th>招股截止日</th><th>暗盤日期 ▼</th><th>上市日期 ▲</th></tr></thead><tbody>
  <tr><td>1</td><td><a href="/tc/stocks/quote/detail-quote.aspx?symbol=06157">瘦西湖文旅</a> 06157.HK</td>
  <td>旅遊</td><td>3.92-5.07</td><td>1,000</td><td>$5,121.14</td><td>2026/10/20</td><td>2026/10/22</td><td>2026/10/23</td></tr>
</tbody></table>`;

const AASTOCKS_LISTED = `<table class="dataTable"><thead><tr>
  <th></th><th>名稱 ▼ / 代號 ▼</th><th>上市日期 ▼</th><th>每手股數</th><th>上市市值(億元)</th><th>招股價</th>
  <th>上市價</th><th>超額 倍數 ▼</th><th>穩中 一手 ▼</th><th>中籤率 ▼</th><th>現價 1</th>
  <th>首日 2 表現 ▼</th><th>累積 表現 ▼</th></tr></thead><tbody>
  <tr><td>1</td><td>傳音控股 02636.HK<div>跌穿上市價</div></td><td>2026/10/15</td><td>100</td><td>120.5</td>
  <td>35.3</td><td>33.8</td><td>3.5</td><td>是</td><td>100.0%</td><td>33.80</td><td>-4.2%</td><td>-4.2%</td></tr>
</tbody></table>`;

function hkHosts(url: string): Response | null {
  if (url.includes('etnet.com.hk')) return new Response(ETNET_HTML, { status: 200 });
  if (url.includes('hk.eastmoney.com')) return new Response(HK_EM_HTML, { status: 200 });
  if (url.includes('aastocks.com')) {
    return new Response(url.includes('listedipo') ? AASTOCKS_LISTED : AASTOCKS_UPCOMING, { status: 200 });
  }
  return null;
}

test('港股新股：三源合并 —— 招股中取經濟通日期，已上市补东方财富募资与阿斯達克中签率', async (t) => {
  const { urls, restore } = stubFetch(hkHosts);
  t.after(restore);
  const result = await collectIpoOffers({ markets: ['HK'], limitPerMarket: 10 });
  const byCode = new Map(result.offers.map((offer) => [offer.code, offer]));

  // ① 招股中的那只：日期/每手来自經濟通（招股起止日 + 公布结果日 + 上市日）。
  const shy = byCode.get('06157')!;
  assert.ok(shy, '招股中的新股必须出现在结果里');
  assert.equal(shy.source, 'etnet', '优先级最高的源署名（合并时不被后来者改写）');
  assert.equal(shy.name, '瘦西湖文旅');
  assert.equal(shy.priceLow, 3.92);
  assert.equal(shy.priceHigh, 5.07);
  assert.equal(shy.issuePrice, 0, '区间未收窄成单一价 → 不冒充发行价');
  assert.equal(shy.lotSize, 1000);
  assert.equal(shy.subscribeStart, '2026-10-14');
  assert.equal(shy.subscribeEnd, '2026-10-20');
  assert.equal(shy.allotmentDate, '2026-10-22');
  assert.equal(shy.listingDate, '2026-10-23');
  assert.equal(shy.industry, '旅遊');
  assert.ok(shy.subscribeEnd, '合并后仍然保留截止日（高优先级源的值不被 0 覆盖）');

  // ② 同一代码在東方財富已上市表里也有：只补金融字段，不改日期与来源。
  const yc = byCode.get('02636')!;
  assert.equal(yc.source, 'eastmoney-ipo');
  assert.equal(yc.priceLow, 35.3);
  assert.equal(yc.priceHigh, 38.8);
  assert.equal(yc.issuePrice, 0);
  assert.equal(yc.subscribeEnd, null, '该列表只给招股开始日：不能拿上市日冒充截止日');
  assert.equal(yc.issueShares, 86_648_300, '招股数 8664.83万 股');
  assert.equal(yc.raiseAmount, 3_059_000_000, '募集资金 30.59亿 港元');
  assert.equal(yc.lotSize, 100, '每手股数由阿斯達克补上');
  assert.equal(yc.winningRate, 100, '阿斯達克的「中籤率 100.0%」');
  assert.equal(yc.oversubscribe, 3.5, '阿斯達克的超額倍數');
  assert.equal(yc.name, '傳音控股', '状态徽章（跌穿上市價）必须剥离，不能混进名称');

  // ③ 已定价的（低=高）才可以当发行价。
  assert.equal(byCode.get('06802')!.issuePrice, 58.85);

  assert.deepEqual(result.sources, ['etnet', 'eastmoney-ipo', 'aastocks']);
  assert.ok(result.byMarket[0]!.count >= 3);
  for (const host of ['etnet.com.hk', 'hk.eastmoney.com', 'aastocks.com']) {
    assert.ok(urls.some((url) => url.includes(host)), `必须真的请求过 ${host}`);
  }
});

test('港股新股：三个源全部不可用时给出「港股打新数据源不可用」，且不产生空记录', async (t) => {
  const { restore } = stubFetch(() => null); // 三个页面全部 502
  t.after(restore);
  const result = await collectIpoOffers({ markets: ['HK'], limitPerMarket: 10 });
  assert.equal(result.offers.length, 0);
  assert.equal(result.byMarket[0]!.count, 0);
  assert.ok(
    result.warnings.some((warning) => /港股打新数据源不可用/.test(warning)),
    `失败原因必须透出：${result.warnings.join(' | ')}`,
  );
});

test('港股新股：單个源失败不算整体失败（其余源照常返回，并在 warnings 里点名）', async (t) => {
  const { restore } = stubFetch((url) => (url.includes('aastocks.com') ? null : hkHosts(url)));
  t.after(restore);
  const result = await collectIpoOffers({ markets: ['HK'], limitPerMarket: 10 });
  assert.ok(result.offers.length > 0, '两个可用源必须照常出数据');
  assert.ok(
    result.warnings.some((warning) => /阿斯達克|招股中页面抓取失败|表格未找到/.test(warning)),
    `必须点名失败的是哪个源：${result.warnings.join(' | ')}`,
  );
});

/* ──────────────────────────────── 美股 ──────────────────────────────── */

function nasdaqBody(month: string): string {
  const rows: Record<string, Record<string, unknown>[]> = {
    '2026-10': [
      {
        dealID: '1',
        proposedTickerSymbol: 'CTY',
        companyName: 'City Therapeutics, Inc.',
        proposedExchange: 'NASDAQ',
        proposedSharePrice: '17.00-19.00',
        sharesOffered: '9,722,222',
        expectedPriceDate: '10/16/2026',
        dollarValueOfSharesOffered: '$212,430,545',
      },
    ],
    '2026-04': [
      {
        dealID: '2',
        proposedTickerSymbol: 'PS',
        companyName: 'PERSHING SQUARE INC.',
        proposedExchange: 'NYSE',
        proposedSharePrice: '50.00',
        sharesOffered: '40,516,960',
        pricedDate: '04/29/2026',
        dollarValueOfSharesOffered: '$2,025,848,000',
      },
    ],
  };
  return JSON.stringify({
    data: {
      priced: { rows: month === '2026-10' ? [] : month === '2026-04' ? rows['2026-04'] : [] },
      upcoming: month === '2026-10' ? { upcomingTable: { rows: rows['2026-10'] } } : null,
    },
  });
}

test('美股新股：只按纳斯达克日历取数，最新优先、limit 落在最新标的上', async (t) => {
  const { urls, restore } = stubFetch((url) =>
    url.includes('api.nasdaq.com') ? new Response(nasdaqBody(/(\d{4}-\d{2})/.exec(url)?.[1] ?? ''), { status: 200 }) : null,
  );
  t.after(restore);
  const result = await collectIpoOffers({ markets: ['US'], limitPerMarket: 1, lookbackDays: 180 });
  const offer = result.offers[0]!;

  assert.equal(result.offers.length, 1, 'limit 生效');
  assert.equal(offer.code, 'CTY', 'limit=1 必须落在最新的标的上（不能是几个月前的）');
  assert.equal(offer.source, 'nasdaq');
  assert.equal(offer.issuePrice, 0, 'upcoming 只有区间：不冒充发行价');
  assert.equal(offer.priceLow, 17);
  assert.equal(offer.priceHigh, 19);
  assert.equal(offer.lotSize, 1);
  assert.equal(offer.subscribeEnd, '2026-10-16', '定价日当作申购截止（美股没有公开申购期）');
  assert.equal(offer.listingDate, '2026-10-16');
  assert.equal(offer.exchange, 'NASDAQ');
  assert.equal(offer.issueShares, 9_722_222);
  assert.equal(offer.raiseAmount, 212_430_545);
  assert.ok(offer.prospectusUrl.includes('sec.gov'), '招股书指向 SEC EDGAR 检索页');
  assert.ok(urls.every((url) => url.includes('api.nasdaq.com')), '美股只打纳斯达克，不混用其它源');
  assert.ok(urls.length >= 4, '窗口覆盖多个月份（往回 3 个月 + 往前 2 个月）');
});

test('美股新股：一个月返回空段（code 1002）不算失败，全部月份失败才算', async (t) => {
  const { restore } = stubFetch((url) =>
    url.includes('api.nasdaq.com')
      ? new Response(JSON.stringify({ data: { priced: null, upcoming: null }, code: 1002 }), { status: 200 })
      : null,
  );
  t.after(restore);
  const result = await collectIpoOffers({ markets: ['US'], limitPerMarket: 5 });
  assert.equal(result.offers.length, 0, '没有新股时返回空数组，而不是抛错');
  assert.ok(
    result.warnings.some((warning) => /美股数据源本次没有返回任何新股/.test(warning)),
    '必须说明「本次没有新股」（与「数据源挂了」区分开）',
  );
});

/* ────────────────────────── 刷新 → 落库 → 状态推进 ────────────────────────── */

function draft(over: Partial<IpoOfferDraft> & { code: string }): IpoOfferDraft {
  return {
    market: 'CN' as Market,
    subscribeCode: over.code,
    name: `测试${over.code}`,
    source: 'eastmoney-ipo',
    exchange: '',
    board: '',
    issuePrice: 10,
    priceLow: 0,
    priceHigh: 0,
    currency: 'CNY',
    lotSize: 500,
    maxShares: 10_000,
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
    ...over,
  };
}

const fakeCollect = (offers: IpoOfferDraft[], warnings: string[] = []) => async () => ({
  offers,
  sources: ['eastmoney-ipo' as const],
  warnings,
  byMarket: [{ market: 'CN' as Market, count: offers.length, sources: ['eastmoney-ipo' as const] }],
});

test('刷新：新增/更新分离，重复刷新不产生重复行，并记录上次刷新时间与警告', async () => {
  const { repo, dir } = tempRepo();
  try {
    const first = await refreshIpoOffers(repo, {
      collect: fakeCollect([draft({ code: '001381', subscribeStart: '2026-10-19', subscribeEnd: '2026-10-19' })], ['A股：部分字段缺失']),
    });
    assert.equal(first.fetched, 1);
    assert.equal(first.inserted, 1);
    assert.equal(first.updated, 0);
    assert.deepEqual(listIpoPayload(repo, {}).warnings, ['A股：部分字段缺失'], '数据源警告要能传到界面');
    assert.ok(listIpoPayload(repo, {}).lastRefreshAt, '刷新时间必须落库（界面据此提示信息新鲜度）');

    const second = await refreshIpoOffers(repo, {
      collect: fakeCollect([draft({ code: '001381', issuePrice: 18.5 })]),
    });
    assert.equal(second.inserted, 0);
    assert.equal(second.updated, 1);
    assert.equal(repo.listIpoOffers({}).length, 1, '同一代码只保留一行');

    const payload = listIpoPayload(repo, {});
    assert.equal(payload.items[0]!.issuePrice, 18.5, '上游有值就覆盖');
    assert.equal(payload.items[0]!.subscribeStart, '2026-10-19', '上游没给的旧值不能被 0/空清掉');
    assert.deepEqual(payload.warnings, [], '第二次刷新没有警告 → 上一次的警告必须被覆盖（不能永远显示旧问题）');
    assert.equal(payload.counts.total, 1);
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('状态推进：即使某市场当天没刷新，已存行的阶段也会随日期自然迁移', async () => {
  const { repo, dir } = tempRepo();
  try {
    repo.createIpoOffer({
      id: crypto.randomUUID(),
      uid: 'CN:001381',
      market: 'CN',
      code: '001381',
      name: '皇冠新材',
      issuePrice: 16.98,
      currency: 'CNY',
      lotSize: 500,
      subscribeStart: '2000-01-01',
      subscribeEnd: '2000-01-01',
      listingDate: '2000-01-10',
      status: 'subscribing',
    });
    // 上游本次什么都没返回：状态仍必须按存库日期推进到「已上市」。
    await refreshIpoOffers(repo, { collect: fakeCollect([]) });
    assert.equal(ipoOfferDetail(repo, 'CN:001381').status, 'listed');
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('状态推导：上市日优先于申购期，日期缺失不猜', () => {
  const today = '2026-10-16';
  const base = { subscribeStart: null, subscribeEnd: null, allotmentDate: null, listingDate: null };
  assert.equal(deriveIpoStatus({ ...base, subscribeStart: '2026-10-19' }, today), 'upcoming');
  assert.equal(deriveIpoStatus({ ...base, subscribeStart: '2026-10-14', subscribeEnd: '2026-10-20' }, today), 'subscribing');
  assert.equal(deriveIpoStatus({ ...base, listingDate: '2026-10-23' }, today), 'allotted');
  assert.equal(deriveIpoStatus({ ...base, listingDate: '2026-10-15' }, today), 'listed');
  assert.equal(deriveIpoStatus(base, today), 'unknown');
});

/* ─────────────────────────── 申购登记与中签入账 ─────────────────────────── */

test('申购登记：拒绝已上市标的与超过申购上限的股数（错误必须是 409 而不是静默写入）', () => {
  const { repo, dir } = tempRepo();
  try {
    const listed = upsertManualIpoOffer(repo, {
      market: 'CN',
      code: '001381',
      name: '皇冠新材',
      issuePrice: 16.98,
      lotSize: 500,
      maxShares: 1000,
      subscribeStart: '2000-01-01',
      subscribeEnd: '2000-01-01',
      listingDate: '2000-01-10',
    });
    assert.throws(() => subscribeIpo(repo, listed.id, { shares: 500 }), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 409, '语义冲突必须是 409，前端才能给出「已上市」提示');
      assert.match(error.message, /已上市/);
      return true;
    });

    const live = upsertManualIpoOffer(repo, {
      market: 'HK',
      code: '06157',
      name: '瘦西湖文旅',
      issuePrice: 4.5,
      lotSize: 1000,
      maxShares: 5000,
      subscribeEnd: '2999-12-31',
    });
    assert.throws(() => subscribeIpo(repo, live.id, { shares: 9000 }), /超过该新股的申购上限/);

    const ok = subscribeIpo(repo, live.id, { shares: 2000 });
    assert.equal(ok.subscription?.status, 'applied');
    assert.equal(ok.subscription?.appliedShares, 2000);
    assert.equal(ok.subscription?.price, 4.5, '未传申购价时取发行价');
    assert.equal(ok.status, 'subscribing', '招股截止日在未来 → 仍在招股中');
    assert.equal(ipoUid('HK', '06157'), 'HK:06157');
    assert.ok(live.uid.startsWith('HK:'));
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('中签入账：建资产 + 写 ipo 买入流水；重复登记是修正而不是累加；未中签不写账本', () => {
  const { repo, dir } = tempRepo();
  try {
    const offer = upsertManualIpoOffer(repo, {
      market: 'CN',
      code: '001381',
      name: '皇冠新材',
      issuePrice: 16.98,
      lotSize: 500,
      maxShares: 1000,
      // 申购已截止（过去）但还没上市（未来）：中签缴款正是这个阶段。
      subscribeEnd: '2000-01-01',
      listingDate: '2999-01-01',
    });
    subscribeIpo(repo, offer.id, { shares: 500, appliedAt: '2026-10-19' });

    // 交易日取「今天」：预算按当月统计，写死日期会让这个断言在下个月失效。
    const today = new Date();
    const tradeDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const first = recordIpoAllotment(repo, offer.id, { shares: 500, tradeDate });
    assert.equal(first.assetCreated, true);
    assert.ok(first.asset, '中签必须产生资产');
    assert.equal(first.asset!.code, '001381');
    assert.equal(first.asset!.market, 'CN');
    const assetId = first.asset!.id;
    const txs = repo.listTransactions(assetId);
    assert.equal(txs.length, 1);
    assert.equal(txs[0]!.kind, 'buy');
    assert.equal(txs[0]!.shares, 500);
    assert.equal(txs[0]!.price, 16.98, '未传缴款价时取发行价');
    assert.equal(txs[0]!.source, 'ipo', '流水来源必须是 ipo（与人工买入区分）');
    assert.equal(first.offer.subscription?.status, 'allotted');
    assert.equal(first.offer.subscription?.assetId, assetId);
    assert.ok(
      first.warnings.some((warning) => /超出该市场当月预算剩余/.test(warning)),
      `缴款 8490 元超过默认 CN 预算 ${DEFAULT_BUDGET.CN} 时必须提示（但不阻断）：${first.warnings.join(' | ')}`,
    );

    // 修正：券商最终只中 200 股 → 覆盖上一次由打新写入的流水，而不是再买一笔。
    const corrected = recordIpoAllotment(repo, offer.id, {
      shares: 200,
      price: 16.98,
      fee: 5,
      tradeDate,
    });
    assert.equal(corrected.assetCreated, false, '第二次复用同一资产');
    assert.equal(corrected.asset!.id, assetId);
    const after = repo.listTransactions(assetId);
    assert.equal(after.length, 1, '必须删掉旧流水再写新的（否则持仓被累加两次）');
    assert.equal(after[0]!.shares, 200);
    assert.equal(after[0]!.fee, 5);
    assert.ok(corrected.warnings.some((warning) => /覆盖上一次/.test(warning)));

    // 未中签：只更新状态，不写账本。
    const missedOffer = upsertManualIpoOffer(repo, {
      market: 'HK',
      code: '06157',
      name: '瘦西湖文旅',
      issuePrice: 4.5,
      lotSize: 1000,
      subscribeEnd: '2999-12-31',
    });
    subscribeIpo(repo, missedOffer.id, { shares: 1000 });
    const missed = recordIpoAllotment(repo, missedOffer.id, { shares: 0, tradeDate });
    assert.equal(missed.asset, null);
    assert.equal(missed.offer.subscription?.status, 'missed');
    assert.equal(repo.findAsset('06157', 'HK', 'stock'), undefined, '未中签不得留下资产');

    // 已入账后再报「未中签」必须被拒绝（否则账本会凭空少一笔持仓）。
    assert.throws(() => recordIpoAllotment(repo, offer.id, { shares: 0 }), /已按中签入账/);
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('中签入账：尚未定价且未传缴款价时必须报错，不能用 0 成本入账', () => {
  const { repo, dir } = tempRepo();
  try {
    const offer = upsertManualIpoOffer(repo, { market: 'HK', code: '06157', name: '瘦西湖文旅', lotSize: 1000, priceLow: 3.92, priceHigh: 5.07 });
    assert.throws(() => recordIpoAllotment(repo, offer.id, { shares: 1000 }), /还没有发行价/);
    const withPrice = recordIpoAllotment(repo, offer.id, { shares: 1000, price: 5.07 });
    assert.equal(repo.listTransactions(withPrice.asset!.id)[0]!.price, 5.07);
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ─────────────────────── 工具层：禁止流水线代签成交 ─────────────────────── */

test('打新工具：自动化流水线不得代用户登记申购/中签，Chat 明确告知时才允许', async () => {
  const { repo, dir } = tempRepo();
  try {
    const offer = upsertManualIpoOffer(repo, {
      market: 'HK',
      code: '09988',
      name: '代签测试',
      issuePrice: 10,
      lotSize: 100,
      subscribeEnd: '2000-01-01',
      listingDate: '2999-01-01',
    });
    const args = JSON.stringify({ code: '09988', market: 'HK', shares: 100 });

    // 1) 打新分析流水线：即使模型被诱导调用，也必须被拒绝且不写任何数据。
    for (const kind of ['ipo-analysis', 'scheduled', 'advice'] as const) {
      const sub = await executeTool('record_ipo_subscription', args, toolCtx(repo, kind));
      assert.equal(sub.ok, false, `${kind} 不应允许登记申购`);
      assert.match(sub.content, /自动化流水线不代用户登记成交/);
      const allot = await executeTool('record_ipo_allotment', args, toolCtx(repo, kind));
      assert.equal(allot.ok, false, `${kind} 不应允许登记中签`);
    }
    assert.equal(ipoOfferDetail(repo, offer.id).subscription, null, '被拒绝的调用不得留下登记');
    assert.equal(repo.listAssets().length, 0, '被拒绝的调用不得写账本');

    // 2) 交互式 Chat（用户刚说「我已申购 100 股」）：允许登记，但不写账本。
    const chatSub = await executeTool('record_ipo_subscription', args, toolCtx(repo, 'chat'));
    assert.equal(chatSub.ok, true, chatSub.content);
    assert.equal(ipoOfferDetail(repo, offer.id).subscription?.status, 'applied');
    assert.equal(repo.listAssets().length, 0, '只登记不写账本');

    // 3) 交互式 Chat 报中签：建资产 + 写一笔 ipo 流水。
    const chatAllot = await executeTool(
      'record_ipo_allotment',
      JSON.stringify({ code: '09988', market: 'HK', shares: 100, price: 10, tradeDate: '2026-10-20' }),
      toolCtx(repo, 'chat'),
    );
    assert.equal(chatAllot.ok, true, chatAllot.content);
    const assets = repo.listAssets();
    assert.equal(assets.length, 1);
    const txs = repo.listTransactions(assets[0]!.id);
    assert.equal(txs.length, 1);
    assert.equal(txs[0]!.source, 'ipo');
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ───────────── 工具层：打新建议必须给出胜率与预期收益（信息完整） ───────────── */

test('save_ipo_analysis：胜率与预期收益必填，advice 正文也要能读到这两个数', async () => {
  const { repo, dir } = tempRepo();
  try {
    const offer = upsertManualIpoOffer(repo, {
      market: 'HK',
      code: '09999',
      name: '胜率测试',
      issuePrice: 8,
      lotSize: 500,
      subscribeEnd: '2000-01-01',
      listingDate: '2999-01-01',
    });
    const ctx = toolCtx(repo, 'ipo-analysis');
    const base = {
      code: '09999',
      market: 'HK',
      verdict: 'subscribe',
      verdictReason: '港股一手 4,000 港元、本月预算充足，胜率与折价均可，打 1 手',
      suggestedShares: 500,
    };
    // 完整建议：正文里同时写清胜率与预期收益（含口径）。
    const good =
      '**结论**：建议申购。胜率约 65%（依据：超购 320 倍、可比公司估值折价 22%），' +
      '预期收益约 +18.5%（依据：同业近三个月首日平均涨幅）。失效条件：暗盘跌破发行价即离场。';

    // 1) 缺胜率 → 拒绝，并且不能只怪模型「没说」：要告诉它怎么补。
    let res = await executeTool('save_ipo_analysis', JSON.stringify({ ...base, advice: good, expectedReturn: 18.5 }), ctx);
    assert.equal(res.ok, false, '缺 winProbability 必须拒绝');
    assert.match(res.content, /胜率/);

    // 2) 缺预期收益 → 拒绝。
    res = await executeTool('save_ipo_analysis', JSON.stringify({ ...base, advice: good, winProbability: 0.65 }), ctx);
    assert.equal(res.ok, false, '缺 expectedReturn 必须拒绝');
    assert.match(res.content, /预期收益/);

    // 3) 字段齐了但正文没写这两个数 → 仍拒绝（用户要的是「建议里能看到」）。
    res = await executeTool(
      'save_ipo_analysis',
      JSON.stringify({
        ...base,
        advice: '**结论**：建议申购。发行定价合理，基本面尚可，但风险偏高，注意控制仓位与缴款节奏。',
        winProbability: 0.65,
        expectedReturn: 18.5,
      }),
      ctx,
    );
    assert.equal(res.ok, false, '正文缺胜率/预期收益必须拒绝');
    assert.match(res.content, /结论缺少/);

    // 4) 胜率写成百分数（65）：折算成 0-1 并如实回报，不静默丢弃这条结论。
    res = await executeTool('save_ipo_analysis', JSON.stringify({ ...base, advice: good, winProbability: 65, expectedReturn: 18.5 }), ctx);
    assert.equal(res.ok, true, res.content);
    assert.match(res.content, /按百分比折算/, '折算必须如实回报，不能静默改数');

    let detail = ipoOfferDetail(repo, offer.id);
    assert.equal(detail.winProbability, 0.65, '百分数胜率要折算成 0-1 存储');
    assert.equal(detail.expectedReturn, 18.5, '预期收益按百分数原值存');
    assert.equal(detail.verdict, 'subscribe');
    assert.equal(detail.verdictReason, base.verdictReason, '一句话理由必须落库（界面「推荐理由」列直接用）');

    // 5) 明显越界的胜率（150）拒绝，且既有结论不被改动。
    res = await executeTool('save_ipo_analysis', JSON.stringify({ ...base, advice: good, winProbability: 150, expectedReturn: 18.5 }), ctx);
    assert.equal(res.ok, false);
    assert.match(res.content, /winProbability 需在 0-1 之间/);
    detail = ipoOfferDetail(repo, offer.id);
    assert.equal(detail.winProbability, 0.65, '被拒绝的调用不得改动已有结论');

    // 6) 预期收益可以为负（预期破发），不能被当成 0 漏掉。
    res = await executeTool(
      'save_ipo_analysis',
      JSON.stringify({
        code: '09999',
        market: 'HK',
        verdict: 'avoid',
        verdictReason: '暗盘已现破发、保荐人历史首日表现差，风险高于收益',
        suggestedShares: 0,
        winProbability: 0.3,
        expectedReturn: -6,
        advice: '**结论**：建议放弃。胜率约 30%（暗盘已现破发案例），预期收益约 -6%，中签即亏损。',
      }),
      ctx,
    );
    assert.equal(res.ok, true, res.content);
    detail = ipoOfferDetail(repo, offer.id);
    assert.equal(detail.expectedReturn, -6, '负数预期收益必须原样落库');
    assert.equal(detail.verdict, 'avoid');
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('save_ipo_analysis：结论必须自洽 —— 高胜率不能判放弃，本期不参与要给理由', async () => {
  const { repo, dir } = tempRepo();
  try {
    const offer = upsertManualIpoOffer(repo, {
      market: 'CN',
      code: '001381',
      name: '自洽测试',
      issuePrice: 16.98,
      lotSize: 500,
      subscribeEnd: '2000-01-01',
      listingDate: '2999-01-01',
    });
    const ctx = toolCtx(repo, 'ipo-analysis');
    const goodAdvice =
      '**结论**：见结论。胜率约 75%（主板破发率低），预期收益约 +25%（折价 6.4%）。失效条件：市场大幅回撤。';

    // 1) 缺一句话理由 → 拒绝（界面「推荐理由」列不能是空的）。
    let res = await executeTool(
      'save_ipo_analysis',
      JSON.stringify({ code: '001381', market: 'CN', verdict: 'subscribe', suggestedShares: 500, winProbability: 0.75, expectedReturn: 25, advice: goodAdvice }),
      ctx,
    );
    assert.equal(res.ok, false, '缺 verdictReason 必须拒绝');
    assert.match(res.content, /verdictReason（8-80 字）/);

    // 2) subscribe 却没给股数 → 拒绝（自相矛盾）。
    res = await executeTool(
      'save_ipo_analysis',
      JSON.stringify({ code: '001381', market: 'CN', verdict: 'subscribe', verdictReason: '标的与预算都支持打新', suggestedShares: 0, winProbability: 0.75, expectedReturn: 25, advice: goodAdvice }),
      ctx,
    );
    assert.equal(res.ok, false);
    assert.match(res.content, /verdict=subscribe 必须给出 suggestedShares/);

    // 3) neutral 却给了股数 → 拒绝。
    res = await executeTool(
      'save_ipo_analysis',
      JSON.stringify({ code: '001381', market: 'CN', verdict: 'neutral', verdictReason: '先观察定价收窄情况再定', suggestedShares: 500, winProbability: 0.7, expectedReturn: 20, advice: goodAdvice }),
      ctx,
    );
    assert.equal(res.ok, false);
    assert.match(res.content, /suggestedShares 必须是 0/);

    // 4) 胜率 75% + 预期收益 +25% 却判 avoid → 拒绝。
    //    这正是用户看到的困惑来源：「为什么胜率 75% 却不推荐」。要么是资金约束（判 neutral），要么是看空（数字同向下调）。
    res = await executeTool(
      'save_ipo_analysis',
      JSON.stringify({ code: '001381', market: 'CN', verdict: 'avoid', verdictReason: '本月预算不够，放弃', suggestedShares: 0, winProbability: 0.75, expectedReturn: 25, advice: goodAdvice }),
      ctx,
    );
    assert.equal(res.ok, false, '高胜率高预期收益不得判 avoid');
    assert.match(res.content, /结论是建议放弃，但胜率/);

    // 5) 反过来也不行：胜率不足 50% 却判 subscribe → 拒绝。
    res = await executeTool(
      'save_ipo_analysis',
      JSON.stringify({ code: '001381', market: 'CN', verdict: 'subscribe', verdictReason: '别人都说好，跟着打一手', suggestedShares: 500, winProbability: 0.4, expectedReturn: 20, advice: goodAdvice }),
      ctx,
    );
    assert.equal(res.ok, false);
    assert.match(res.content, /结论是建议申购，但胜率/);

    // 6) 用户的真实场景：胜率 75% 但本月预算只剩 734 元、一手要 8,490 元 → neutral + 写明缺口是**合法且必须能解释**的。
    const budgetReason = '本月 A 股预算仅剩 734 元，一手 500 股 × 16.98 元 = 8,490 元打不起（标的本身不差）';
    res = await executeTool(
      'save_ipo_analysis',
      JSON.stringify({ code: '001381', market: 'CN', verdict: 'neutral', verdictReason: budgetReason, suggestedShares: 0, winProbability: 0.75, expectedReturn: 25, advice: goodAdvice }),
      ctx,
    );
    assert.equal(res.ok, true, res.content);
    const detail = ipoOfferDetail(repo, offer.id);
    assert.equal(detail.verdict, 'neutral');
    assert.equal(detail.suggestedShares, 0, '本期不参与就不给股数');
    assert.equal(detail.verdictReason, budgetReason, '预算缺口必须能落到理由里，界面据此解释「高胜率为何不参与」');
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('刷新新股信息不得清空 AI 结论：胜率/预期收益只由 save_ipo_analysis 写', async () => {
  const { repo, dir } = tempRepo();
  try {
    const offer = upsertManualIpoOffer(repo, {
      market: 'CN',
      code: '001381',
      name: '合并测试',
      issuePrice: 16.98,
      lotSize: 500,
      subscribeEnd: '2000-01-01',
      listingDate: '2999-01-01',
    });
    const res = await executeTool(
      'save_ipo_analysis',
      JSON.stringify({
        code: '001381',
        market: 'CN',
        verdict: 'subscribe',
        verdictReason: '发行 PE 低于行业均值、破发率低，本月预算够打一手',
        suggestedShares: 500,
        winProbability: 0.72,
        expectedReturn: 44,
        advice: '**结论**：建议申购。胜率约 72%（近期同类破发率 12%），预期收益约 +44%（发行市盈率低于行业均值）。',
      }),
      toolCtx(repo, 'ipo-analysis'),
    );
    assert.equal(res.ok, true, res.content);

    // 上游刷新只带发行要素（甚至把发行价改了），结论字段必须纹丝不动。
    await refreshIpoOffers(repo, {
      collect: fakeCollect([draft({ code: '001381', issuePrice: 19.5, winningRate: 0.02 })]),
    });
    const after = ipoOfferDetail(repo, offer.id);
    assert.equal(after.issuePrice, 19.5, '发行要素照常被上游覆盖');
    assert.equal(after.winningRate, 0.02, '中签率是上游数据，随刷新更新');
    assert.equal(after.winProbability, 0.72, '胜率是 AI 结论，刷新不得清空');
    assert.equal(after.expectedReturn, 44, '预期收益是 AI 结论，刷新不得清空');
    assert.equal(after.verdictReason, '发行 PE 低于行业均值、破发率低，本月预算够打一手', '一句话理由也是 AI 结论，刷新不得清空');
    assert.equal(after.verdict, 'subscribe');
    assert.equal(after.suggestedShares, 500);
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ─────────────────────────── 备份 / 导出往返 ─────────────────────────── */

test('备份往返：打新标的中签入账后，导出→导入必须还原资产、流水与申购登记', async () => {
  const { repo: source, dir: dirA } = tempRepo();
  const { repo: target, dir: dirB } = tempRepo();
  try {
    const offer = upsertManualIpoOffer(source, {
      market: 'US',
      code: 'CTY',
      name: 'City Therapeutics, Inc.',
      issuePrice: 18,
      lotSize: 1,
      subscribeEnd: '2000-01-01',
      listingDate: '2999-01-01',
    });
    subscribeIpo(source, offer.id, { shares: 1000, appliedAt: '2026-10-16' });
    recordIpoAllotment(source, offer.id, { shares: 1000, tradeDate: '2026-10-20' });
    // 备份里也要带上 AI 结论（含胜率/预期收益），否则恢复后建议页会显示「待分析」。
    const saved = await executeTool(
      'save_ipo_analysis',
      JSON.stringify({
        code: 'CTY',
        market: 'US',
        verdict: 'subscribe',
        verdictReason: '发行折价 18%、同业首日平均 +25%，美股账户现金够打 1,000 股',
        suggestedShares: 1000,
        winProbability: 0.6,
        expectedReturn: 25,
        advice: '**结论**：建议申购。胜率约 60%，预期收益约 +25%，依据同业首日表现与发行折价。',
      }),
      toolCtx(source, 'ipo-analysis'),
    );
    assert.equal(saved.ok, true, saved.content);

    const payload = buildBackupPayload(source);
    assert.equal(payload.ipoOffers?.length, 1, '备份必须包含打新标的');
    assert.equal(payload.ipoSubscriptions?.length, 1, '备份必须包含申购/中签登记');

    // 校验器不得把这两组数组当成「未知字段」丢掉。
    const validated = validateBackupPayload(JSON.parse(JSON.stringify(payload)));
    assert.equal(validated.ipoOffers?.length, 1);
    assert.equal(validated.ipoSubscriptions?.length, 1);

    // 老备份（没有这两组数组）仍然可以导入：不能因为新增字段就拒绝历史备份。
    const legacy = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    delete legacy.ipoOffers;
    delete legacy.ipoSubscriptions;
    const legacyResult = importBackupPayload(target, legacy, 'replace');
    assert.equal(legacyResult.ipoOffers, 0);
    assert.equal(legacyResult.assets, 1, '老备份里的资产照常导入');

    const bundle = source.exportAll();
    assert.equal(bundle.ipoOffers.length, 1);
    assert.equal(bundle.ipoSubscriptions.length, 1);

    const imported = target.importAll(JSON.parse(JSON.stringify(bundle)), 'replace');
    assert.equal(imported.ipoOffers, 1);
    assert.equal(imported.ipoSubscriptions, 1);
    assert.equal(imported.assets, 1);
    assert.equal(imported.transactions, 1);

    const restored = listIpoPayload(target, {}).items[0]!;
    assert.equal(restored.code, 'CTY');
    assert.equal(restored.subscription?.status, 'allotted');
    assert.equal(restored.subscription?.allottedShares, 1000);
    assert.ok(restored.subscription?.assetId, '导入后仍指向账本资产');
    assert.ok(restored.adviceAt === null || typeof restored.adviceAt === 'string');
    assert.equal(restored.winProbability, 0.6, '胜率必须随备份往返');
    assert.equal(restored.expectedReturn, 25, '预期收益必须随备份往返');
    assert.equal(restored.verdictReason, '发行折价 18%、同业首日平均 +25%，美股账户现金够打 1,000 股', '一句话理由必须随备份往返');

    // 同一份再导入一次：按 id 去重，不会翻倍。
    const again = target.importAll(JSON.parse(JSON.stringify(bundle)), 'merge');
    assert.equal(again.ipoOffers, 0);
    assert.equal(again.ipoSubscriptions, 0);
  } finally {
    source.close();
    target.close();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});