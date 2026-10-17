/**
 * 新股打新数据源（A股 / 港股 / 美股）—— docs/SOURCES.md §8。
 *
 * 三个上游**全部实测可用且零 Key**（2026-10-16 本机验证）：
 *
 * | 市场 | 上游 | 形态 |
 * | --- | --- | --- |
 * | A股 | 东方财富数据中心 `RPTA_APP_IPOAPPLY` | JSON（字段最全：发行价/申购上限/中签率/募资额/保荐机构） |
 * | 港股① | 經濟通 etnet 新股日历 `listing_ipo_array` | 页面内嵌 JSON（招股中：招股价区间/招股起止日/公布结果日/每手/入场费） |
 * | 港股② | 东方财富港股新股列表 `hk.eastmoney.com/ipolist.html` | HTML 表格（已上市：招股价/招股数/募资额/招股开始日/上市日） |
 * | 港股③ | 阿斯達克 AAStocks 新股页 | HTML 表格（**按表头标签定位列**；补中签率与超购倍数） |
 * | 美股 | 纳斯达克官方 IPO 日历 `api.nasdaq.com/api/ipo/calendar` | JSON（priced / upcoming） |
 *
 * 设计纪律（与工程既有口径一致）：
 *  - **只采信上游真的给了的字段**：缺失一律 0 / null / 空串，绝不用 0 冒充「有数据」；
 *    界面与 AI 提示词据此把它们当「上游未提供」。
 *  - **单市场失败不拖垮整次刷新**：每个市场独立 try/catch，失败变成 warnings 里的具体原因；
 *    成功市场的记录照常返回（用户仍能打新，只是某个市场缺数据）。
 *  - **不猜语义**：拿不准的列宁可不要。例如 AAStocks 已上市表的「招股價」列对 A+H 标的口径
 *    无法核实，因此港股已上市新股**不填发行价**（在文档里写明原因）。
 *
 * Owner: agent-engine.
 */
import { IPO_REFRESH_LOOKBACK_DAYS } from '@aia/shared';
import type { Market, SourceId } from '@aia/shared';
import { DEFAULT_HEADERS, USER_AGENT, cacheGet, cacheSet, errorMessage, withLimit } from './http.js';
import type { IpoCollectResult, IpoOfferDraft } from './types.js';

/** 新股列表缓存 5 分钟：招股期内的数据一天最多变几次，刷新按钮不该打穿上游。 */
const IPO_CACHE_TTL_MS = 5 * 60_000;

export interface IpoCollectOptions {
  markets?: Market[];
  /** 每个市场最多返回多少条（默认 60）。 */
  limitPerMarket?: number;
  /** 回看/前瞻窗口（自然日）。 */
  lookbackDays?: number;
}

/** 收集入口：并发跑各市场，逐市场隔离失败。 */
export async function collectIpoOffers(options: IpoCollectOptions = {}): Promise<IpoCollectResult> {
  const markets = options.markets && options.markets.length > 0 ? options.markets : (['CN', 'HK', 'US'] as Market[]);
  const limit = Math.max(1, Math.min(options.limitPerMarket ?? 60, 500));
  const lookback = Math.max(0, options.lookbackDays ?? IPO_REFRESH_LOOKBACK_DAYS);

  const tasks: { market: Market; run: () => Promise<MarketCollected> }[] = [];
  if (markets.includes('CN')) tasks.push({ market: 'CN', run: () => fetchCnIpoOffers(limit, lookback) });
  if (markets.includes('HK')) tasks.push({ market: 'HK', run: () => fetchHkIpoOffers(limit) });
  if (markets.includes('US')) tasks.push({ market: 'US', run: () => fetchUsIpoOffers(limit, lookback) });

  // 三个市场互不依赖：并发抓取，但仍走全局 8 并发的礼貌上限。
  const settled = await Promise.all(
    tasks.map(async (task) => {
      try {
        const value = await withLimit(task.run);
        return { market: task.market, value, error: null as string | null };
      } catch (error) {
        return { market: task.market, value: null, error: errorMessage(error) };
      }
    }),
  );

  const offers: IpoOfferDraft[] = [];
  const warnings: string[] = [];
  const sources = new Set<SourceId>();
  const byMarket: IpoCollectResult['byMarket'] = [];

  for (const item of settled) {
    if (!item.value) {
      byMarket.push({ market: item.market, count: 0, sources: [] });
      warnings.push(`${marketLabel(item.market)}打新数据源不可用：${item.error ?? '未知错误'}`);
      continue;
    }
    for (const offer of item.value.offers) offers.push(offer);
    for (const source of item.value.sources) sources.add(source);
    for (const warning of item.value.warnings) warnings.push(`${marketLabel(item.market)}：${warning}`);
    byMarket.push({ market: item.market, count: item.value.offers.length, sources: item.value.sources });
    if (item.value.offers.length === 0) {
      warnings.push(`${marketLabel(item.market)}数据源本次没有返回任何新股`);
    }
  }

  return { offers, sources: [...sources], warnings, byMarket };
}

/** 单个市场的采集结果：可能来自多个上游（港股就有三个），因此是数组。 */
interface MarketCollected {
  offers: IpoOfferDraft[];
  sources: SourceId[];
  /** 局部失败原因（不致命，但要让用户看到「哪个源没取到」）。 */
  warnings: string[];
}

function marketLabel(market: Market): string {
  return market === 'CN' ? 'A股' : market === 'HK' ? '港股' : '美股';
}

/* ══════════════════════════════ A 股：东方财富 ═══════════════════════════════ */

interface EmEnvelope {
  success?: boolean;
  message?: string;
  result?: { data?: Record<string, unknown>[]; count?: number; pages?: number } | null;
}

/**
 * A股新股申购与中签（东方财富数据中心）。
 *
 * 报表 `RPTA_APP_IPOAPPLY` 一条记录 = 一只新股的整个发行周期。按 `APPLY_DATE` 倒序取
 * 最新 N 条即可覆盖「未来的申购日 → 最近的上市」，不需要服务端过滤（过滤语法随报表变化）。
 */
export async function fetchCnIpoOffers(limit: number, lookbackDays: number): Promise<MarketCollected> {
  const cacheKey = `ipo:cn:${limit}:${lookbackDays}`;
  const cached = cacheGet<Record<string, unknown>[]>(cacheKey);
  const rows = cached ?? (await requestCnRows(limit, lookbackDays));
  cacheSet(cacheKey, rows, IPO_CACHE_TTL_MS);

  const offers: IpoOfferDraft[] = [];
  for (const row of rows) {
    const draft = cnRowToDraft(row);
    if (draft) offers.push(draft);
  }
  const warnings: string[] = [];
  if (rows.length > 0 && offers.length === 0) warnings.push('上游返回了记录，但都缺少代码或名称，已跳过');
  return { offers, sources: ['eastmoney-ipo'], warnings };
}

async function requestCnRows(limit: number, lookbackDays: number): Promise<Record<string, unknown>[]> {
  // 不带 filter 时该报表会把 1991 年的老股一起吐出来，所以显式限定「最近 N 天以来申购」；
  // 该窗口同时覆盖未来的申购日（A股新股会提前公布申购日）。
  const since = new Date(Date.now() - Math.max(1, lookbackDays) * 86_400_000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    sortColumns: 'APPLY_DATE',
    sortTypes: '-1',
    pageSize: String(Math.max(1, Math.min(limit, 200))),
    pageNumber: '1',
    reportName: 'RPTA_APP_IPOAPPLY',
    columns: 'ALL',
    filter: `(APPLY_DATE>='${since}')`,
    source: 'WEB',
    client: 'WEB',
  });
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?${params.toString()}`;
  const response = await fetch(url, {
    headers: { ...DEFAULT_HEADERS, Referer: 'https://data.eastmoney.com/xg/' },
  });
  if (!response.ok) throw new Error(`东方财富新股接口 HTTP ${response.status}`);
  const body = (await response.json()) as EmEnvelope;
  if (body.success === false) throw new Error(`东方财富新股接口返回失败：${body.message ?? '未知原因'}`);
  return body.result?.data ?? [];
}

function cnRowToDraft(row: Record<string, unknown>): IpoOfferDraft | null {
  const code = text(row.SECURITY_CODE) || text(row.SUBSCRIBE_CODE);
  const name = text(row.SECURITY_NAME_ABBR) || text(row.SECURITY_NAME);
  if (!code || !name) return null;
  const subscribeCode = text(row.APPLY_CODE) || code;
  const applyDate = dateOnly(row.APPLY_DATE);
  const listingDate = dateOnly(row.LISTING_DATE);
  const ballotDate = dateOnly(row.BALLOT_NUM_DATE) ?? dateOnly(row.ASSIGN_DATE);
  const issuePrice = number(row.ISSUE_PRICE);
  const predictPrice = number(row.PREDICT_ISSUE_PRICE);
  const predictLow = number(row.PREDICT_ISSUE_PRICE1);
  const predictHigh = number(row.PREDICT_ISSUE_PRICE2);
  // 未定价时上游给「预测发行价」；只在真有值时才放进区间，避免造出 0 元区间。
  const priceLow = predictLow > 0 ? predictLow : predictPrice > 0 ? predictPrice : 0;
  const priceHigh = predictHigh > 0 ? predictHigh : predictPrice > 0 ? predictPrice : 0;
  const issueNumWan = number(row.ISSUE_NUM); // 万股
  const raiseWan = number(row.TOTAL_RAISE_FUNDS) || number(row.PREDICT_RAISE_FUNDS); // 亿元

  return {
    market: 'CN',
    code,
    subscribeCode,
    name,
    source: 'eastmoney-ipo',
    exchange: text(row.TRADE_MARKET),
    board: text(row.MARKET) || text(row.MARKET_TYPE_NEW) || text(row.MARKET_TYPE),
    issuePrice,
    priceLow,
    priceHigh,
    currency: 'CNY',
    // EACHBALLOT_SHARES = 每中一签股数（沪市主板 1000、深市/科创 500），是打新的实际单位。
    lotSize: number(row.EACHBALLOT_SHARES),
    maxShares: number(row.ONLINE_APPLY_UPPER) || number(row.PREDICT_ONAPPLY_UPPER),
    subscribeStart: applyDate,
    // A 股网上申购只有一天：开始日 = 截止日，界面因此能直接显示「今天可申购」。
    subscribeEnd: applyDate,
    allotmentDate: ballotDate,
    listingDate,
    issueShares: Math.round(issueNumWan * 10_000),
    raiseAmount: Math.round(raiseWan * 100_000_000),
    issuePe: number(row.AFTER_ISSUE_PE),
    industryPe: number(row.INDUSTRY_PE_NEW) || number(row.INDUSTRY_PE_RATIO) || number(row.INDUSTRY_PE),
    winningRate: number(row.ONLINE_ISSUE_LWR),
    // 沪深的「超购倍数」上游没有等价字段，北交所的 ONLINE_VA_SHARES 口径也无法核实 →
    // 一律留 0（界面显示「—」），不拿 INITIAL_MULTIPLE（初步询价倍数）冒充。
    oversubscribe: 0,
    sponsor: text(row.RECOMMEND_ORG) || text(row.UNDERWRITER_ORG),
    industry: text(row.INDUSTRY_NAME),
    // INFO_CODE 是东财公告库里的招股/上市公告 ID，拼成公告详情页供 AI 深读。
    prospectusUrl: text(row.INFO_CODE)
      ? `https://data.eastmoney.com/notices/detail/${encodeURIComponent(code)}/${encodeURIComponent(text(row.INFO_CODE))}.html`
      : '',
  };
}

/* ═══════════════════════════ 港股：三个上游取并集 ═══════════════════════════ */

/**
 * 港股新股 = 經濟通（招股中，字段最全）+ 东方财富港股新股列表（已上市，价格/股数/募资额）
 * + 阿斯達克（补中签率与超购倍数）。
 *
 * 三者**独立容错**：任何一个挂掉只产生一条 warning，其余照常入库；只有三家全失败才抛错。
 * 合并时按优先级「先到者非空值优先」，所以 AAStocks 只负责它独有的中签率/超购倍数，
 * 不会用它口径可疑的「招股價」列覆盖東方財富的价格。
 */
export async function fetchHkIpoOffers(limit: number): Promise<MarketCollected> {
  const cacheKey = `ipo:hk:${limit}`;
  const cached = cacheGet<MarketCollected>(cacheKey);
  if (cached) return cached;

  const warnings: string[] = [];
  const collected: IpoOfferDraft[] = [];
  const sources: SourceId[] = [];
  const failures: string[] = [];

  const steps: { source: SourceId; label: string; run: () => Promise<IpoOfferDraft[]> }[] = [
    { source: 'etnet', label: '經濟通招股中列表', run: () => fetchHkEtnet() },
    { source: 'eastmoney-ipo', label: '东方财富港股新股列表', run: () => fetchHkEastmoneyList() },
    { source: 'aastocks', label: '阿斯達克新股列表', run: () => fetchHkAastocks() },
  ];

  for (const step of steps) {
    try {
      const rows = await step.run();
      if (rows.length === 0) {
        warnings.push(`${step.label}本次没有返回记录`);
        continue;
      }
      collected.push(...rows);
      sources.push(step.source);
    } catch (error) {
      failures.push(`${step.label}：${errorMessage(error)}`);
    }
  }

  if (collected.length === 0) {
    const detail = failures.length > 0 ? failures.join('；') : warnings.join('；') || '无记录';
    throw new Error(detail);
  }
  for (const failure of failures) warnings.push(`该来源本次不可用（${failure}）`);

  const merged = dedupeByCode(collected).slice(0, limit);
  const result: MarketCollected = { offers: merged, sources, warnings };
  cacheSet(cacheKey, result, IPO_CACHE_TTL_MS);
  return result;
}

/** 經濟通港股新股日历：页面内嵌 `listing_ipo_array`（当前招股中的新股）。 */
async function fetchHkEtnet(): Promise<IpoOfferDraft[]> {
  const html = await requestText(
    'https://www.etnet.com.hk/www/tc/stocks/ipo-calendar.php',
    'https://www.etnet.com.hk/www/tc/stocks/ipo-calendar.php',
  );
  const match = /listing_ipo_array:(\[[\s\S]*?\]),\s*ipoSetting/.exec(html);
  if (!match) throw new Error('未找到内嵌的招股中数据（页面结构可能已变化）');
  const parsed = JSON.parse(match[1]) as Record<string, unknown>[];
  const offers: IpoOfferDraft[] = [];
  for (const item of parsed) {
    const code = digitsOnly(text(item.stockcode));
    const name = text(item.stocknametc) || text(item.stocknamesc) || text(item.stocknameeng);
    if (!code || !name) continue;
    const low = number(item.offerpricefrom);
    const high = number(item.offerpriceto);
    offers.push({
      market: 'HK',
      code,
      subscribeCode: code,
      name,
      source: 'etnet',
      exchange: '香港交易所',
      board: text(item.listmethod) === '2' ? 'GEM' : '主板',
      // 区间收窄成一个价（已定价）才算发行价，否则交给 priceLow/priceHigh 显示区间。
      issuePrice: low > 0 && low === high ? low : 0,
      priceLow: low,
      priceHigh: high,
      currency: text(item.currency) || 'HKD',
      lotSize: numberOnly(item.boardlot),
      maxShares: 0,
      subscribeStart: dateOnly(item.applicationstart),
      subscribeEnd: dateOnly(item.applicationend),
      // etnet 的 resultdate = 公布中签结果日，正是 allotmentDate 的语义。
      allotmentDate: dateOnly(item.resultdate),
      listingDate: dateOnly(item.listdate),
      issueShares: 0,
      raiseAmount: 0,
      issuePe: 0,
      industryPe: 0,
      winningRate: percent(item.onelotsuccessrate),
      oversubscribe: number(item.oversubscribtionrate),
      // sponsors/underwriters 是机构 ID（需再抓一个页面才能映射成名字），宁缺勿滥。
      sponsor: '',
      industry: text(item.naturetc) || text(item.natureeng),
      prospectusUrl: '',
    });
  }
  return offers;
}

/** 东方财富港股新股列表（已上市，50 条/页，倒序）。 */
async function fetchHkEastmoneyList(): Promise<IpoOfferDraft[]> {
  const html = await requestText('https://hk.eastmoney.com/ipolist.html', 'https://hk.eastmoney.com/ipolist.html');
  const offers: IpoOfferDraft[] = [];
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) =>
      decodeEntities(cell[1].replace(/<[^>]+>/g, ' ')),
    );
    // 列序：序号 | 代码 | 名称 | 招股价 | 招股数 | 募集资金 | 招股日期 | 上市日期
    if (cells.length < 8) continue;
    const code = digitsOnly(cells[1]);
    const name = cells[2];
    if (!code || !name) continue;
    const { low, high } = parsePriceRange(cells[3]);
    offers.push({
      market: 'HK',
      code,
      subscribeCode: code,
      name,
      source: 'eastmoney-ipo',
      exchange: '香港交易所',
      board: '',
      issuePrice: low > 0 && low === high ? low : 0,
      priceLow: low,
      priceHigh: high,
      currency: 'HKD',
      lotSize: 0,
      maxShares: 0,
      subscribeStart: dateOnly(cells[6]),
      // 该列表只给「招股日期」（开始日），没有截止日：不拿上市日冒充。
      subscribeEnd: null,
      allotmentDate: null,
      listingDate: dateOnly(cells[7]),
      // 页面单位是「万股」，募集资金是「亿港元」。
      issueShares: Math.round(chineseAmount(cells[4])),
      raiseAmount: Math.round(chineseAmount(cells[5])),
      issuePe: 0,
      industryPe: 0,
      winningRate: 0,
      oversubscribe: 0,
      sponsor: '',
      industry: '',
      prospectusUrl: '',
    });
  }
  return offers;
}

/** 阿斯達克（补中签率/超购倍数；招股中表也能独立提供价格区间）。 */
async function fetchHkAastocks(): Promise<IpoOfferDraft[]> {
  const pages: { url: string; kind: 'upcoming' | 'listed' }[] = [
    { url: 'https://www.aastocks.com/tc/stocks/market/ipo/upcomingipo.aspx', kind: 'upcoming' },
    { url: 'https://www.aastocks.com/tc/stocks/market/ipo/listedipo.aspx', kind: 'listed' },
  ];
  const offers: IpoOfferDraft[] = [];
  const errors: string[] = [];
  for (const page of pages) {
    try {
      const html = await requestText(page.url, 'https://www.aastocks.com/tc/stocks/market/ipo/upcomingipo.aspx');
      const table = findTable(html, page.kind === 'upcoming' ? 'tblGMUpcoming' : 'dataTable');
      if (!table) {
        errors.push(`${page.kind === 'upcoming' ? '招股中' : '已上市'}表格未找到（页面结构可能已变化）`);
        continue;
      }
      const columns = mapHeaderColumns(table.thead);
      for (const cells of table.rows) {
        const draft = hkRowToDraft(cells, columns, page.kind);
        if (draft) offers.push(draft);
      }
    } catch (error) {
      errors.push(`${page.kind === 'upcoming' ? '招股中' : '已上市'}页面抓取失败：${errorMessage(error)}`);
    }
  }
  // 该源是「加分项」：拿到多少算多少，但一页都没解析出来时明确报错，避免被当成「今天没有新股」。
  if (offers.length === 0 && errors.length > 0) throw new Error(errors.join('；'));
  return offers;
}

interface ParsedTable {
  /** 表头标签（已去掉排序箭头等装饰）。 */
  thead: string[];
  /** 每个 `<tr>` 的单元格纯文本。 */
  rows: string[][];
}

/** 从 HTML 里抽出某张表（优先按 id/class 精确匹配）。 */
function findTable(html: string, marker: string): ParsedTable | null {
  const openTag = new RegExp(`<table[^>]*(?:id|class)="[^"]*${marker}[^"]*"[^>]*>`, 'i');
  const match = openTag.exec(html);
  if (!match || match.index === undefined) return null;
  const start = match.index;
  const end = html.indexOf('</table>', start);
  if (end < 0) return null;
  const table = html.slice(start, end);

  const theadMatch = /<thead>[\s\S]*?<\/thead>/i.exec(table);
  const head = theadMatch?.[0] ?? '';
  // 表头单元格：AAStocks 用 <th>，个别页面用 <td>；取到就用，取不到才退回列序兜底
  // （这里的 `th`/`td` 写错会让 mapHeaderColumns 永远拿到空表头，从而静默改用硬编码列序）。
  const headerCells = extractCells(head, 'th');
  const thead = headerCells.length > 0 ? headerCells : extractCells(head, 'td');
  const body = theadMatch ? table.slice(theadMatch[0].length) : table;
  const rows = [...body.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/gi)]
    .map((row) => extractCells(row[0], 'td'))
    .filter((cells) => cells.length > 0);
  return { thead, rows };
}

/** 取出单元格并清洗成纯文本（含 &nbsp; / 箭头 / 多余空白）。 */
function extractCells(fragment: string, tag: 'td' | 'th'): string[] {
  return [...fragment.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map((cell) =>
    decodeEntities(cell[1].replace(/<[^>]+>/g, ' ')),
  );
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 表头标签 → 列下标（标签里可能带 "▼" 等装饰与 "名稱 / 代號" 这种复合标题）。 */
function mapHeaderColumns(thead: string[]): Record<string, number> {
  const columns: Record<string, number> = {};
  thead.forEach((label, index) => {
    const clean = label.replace(/[▲▼\s]/g, '');
    if (!clean) return;
    const rules: [RegExp, string][] = [
      [/公司名稱|名稱/, 'name'],
      [/代號|代码|代碼/, 'code'],
      [/行業/, 'industry'],
      [/招股價|招股价/, 'price'],
      [/每手股數|每手股数/, 'lotSize'],
      [/入場費|入场费/, 'entryFee'],
      [/招股截止日|招股截止/, 'subscribeEnd'],
      [/招股日期|招股開始|招股开始/, 'subscribeStart'],
      [/暗盤日期|暗盘日期/, 'greyDate'],
      [/上市日期/, 'listingDate'],
      [/超額|超额/, 'oversubscribe'],
      [/中籤率|中签率/, 'winningRate'],
      [/穩中|稳中/, 'stableLot'],
      [/上市價|上市价/, 'listingPrice'],
      [/現價|现价/, 'currentPrice'],
    ];
    for (const [pattern, key] of rules) {
      if (pattern.test(clean) && columns[key] === undefined) columns[key] = index;
    }
  });
  return columns;
}

/** AAStocks 名称单元格里会附带状态徽章（跌穿上市價 / 半新股…），必须剥掉再存名字。 */
const HK_NAME_BADGES =
  /跌穿上市價|升穿上市價|已上市|半新股|延遲上市|Sink Below Listing Price|Rose Above Listing Price|New Listing|Listed/g;

/** 表格单元格 → 干净的「名称」。 */
function hkName(raw: string): string {
  return raw.replace(/\d{4,5}\s*\.HK/g, '').replace(HK_NAME_BADGES, '').trim();
}

function hkRowToDraft(cells: string[], columns: Record<string, number>, kind: 'upcoming' | 'listed'): IpoOfferDraft | null {
  /**
   * 取值顺序：表头标签定位 → （表头没解析出来时）已知列序兜底。
   *
   * 表头解析成功时**绝不**用列序兜底：列序兜底只在 AAStocks 改版把 thead 结构改坏、
   * 而正文列序恰好没变的极端情况下生效，避免把「行业」当成「招股价」写进库。
   */
  const parsed = Object.keys(columns).length > 0;
  const raw = (key: string, fallbackIndex: number): string => {
    const index = columns[key];
    if (index !== undefined) return cells[index] ?? '';
    return parsed ? '' : (cells[fallbackIndex] ?? '');
  };

  // 代码既可能出现在独立列（代號），也可能和名称挤在同一格（"名稱 / 代號" 复合表头）。
  const combined = cells.join(' ');
  const codeMatch = /(\d{4,5})\s*\.HK/.exec(combined) ?? /symbol=(\d{4,5})/.exec(combined);
  const code = codeMatch ? codeMatch[1].padStart(5, '0') : digitsOnly(raw('code', 1));
  const nameCell = hkName(raw('name', 1)) || hkName(cells[1] ?? '');
  if (!code || !nameCell) return null;

  const priceText = raw('price', kind === 'upcoming' ? 3 : 5);
  const { low, high } = parsePriceRange(priceText);
  const listingDate =
    dateOnly(raw('listingDate', kind === 'upcoming' ? 8 : 2)) ?? null;
  const lotSize = numberOnly(raw('lotSize', 3));

  if (kind === 'upcoming') {
    return {
      market: 'HK',
      code,
      subscribeCode: code,
      name: nameCell,
      source: 'aastocks',
      exchange: '香港交易所',
      board: '主板/GEM',
      // 招股價是**区间**：仅当区间收窄成一个价（已定价）时才当发行价，否则留 0 让 UI 显示区间。
      issuePrice: low > 0 && low === high ? low : 0,
      priceLow: low,
      priceHigh: high,
      currency: 'HKD',
      lotSize,
      maxShares: 0,
      subscribeStart: dateOnly(raw('subscribeStart', 6)),
      subscribeEnd: dateOnly(raw('subscribeEnd', 6)),
      // 暗盤日期（上市前一日）与「中签公布」不是同一件事，不冒充 allotmentDate。
      allotmentDate: null,
      listingDate,
      issueShares: 0,
      raiseAmount: 0,
      issuePe: 0,
      industryPe: 0,
      winningRate: 0,
      oversubscribe: 0,
      sponsor: '',
      industry: raw('industry', 2),
      prospectusUrl: '',
    };
  }

  return {
    market: 'HK',
    code,
    subscribeCode: code,
    name: nameCell,
    source: 'aastocks',
    exchange: '香港交易所',
    board: '主板/GEM',
    // 已上市行的「招股價」列对 A+H 标的口径无法核实（同一格可能显示 A 股价格），
    // 宁可留空也不写错价格 —— 见本文件头部纪律说明。
    issuePrice: 0,
    priceLow: 0,
    priceHigh: 0,
    currency: 'HKD',
    lotSize,
    maxShares: 0,
    subscribeStart: null,
    subscribeEnd: null,
    allotmentDate: null,
    listingDate,
    issueShares: 0,
    raiseAmount: 0,
    issuePe: 0,
    industryPe: 0,
    winningRate: percent(raw('winningRate', 9)),
    oversubscribe: numberOnly(raw('oversubscribe', 7)),
    sponsor: '',
    industry: '',
    prospectusUrl: '',
  };
}

/* ═══════════════════════════ 美股：纳斯达克官方日历 ═════════════════════════ */

/**
 * 美股 IPO（纳斯达克官方 `api/ipo/calendar`）。
 *
 * 只取 `priced`（已定价/已上市）与 `upcoming`（预计定价）两段：
 * `filed` 段绝大多数是还没有交易代码的 SPAC（`proposedTickerSymbol: null`），
 * 既无法生成稳定的 uid 也没有申购动作，因此不采集（AI 需要时可查 EDGAR）。
 * 日历按自然月查询，所以取「上月 / 本月 / 下月 / 下下月」四个月覆盖窗口。
 */
export async function fetchUsIpoOffers(limit: number, lookbackDays: number): Promise<MarketCollected> {
  const cacheKey = `ipo:us:${limit}:${lookbackDays}`;
  const cached = cacheGet<MarketCollected>(cacheKey);
  if (cached) return cached;

  const months = monthWindow(new Date(), lookbackDays);
  const drafts: IpoOfferDraft[] = [];
  const errors: string[] = [];
  for (const month of months) {
    try {
      const body = await requestJson<NasdaqCalendar>(`https://api.nasdaq.com/api/ipo/calendar?date=${month}`, 'https://www.nasdaq.com/market-activity/ipos');
      for (const row of body?.data?.priced?.rows ?? []) {
        const draft = usRowToDraft(row, 'priced');
        if (draft) drafts.push(draft);
      }
      for (const row of body?.data?.upcoming?.upcomingTable?.rows ?? []) {
        const draft = usRowToDraft(row, 'upcoming');
        if (draft) drafts.push(draft);
      }
    } catch (error) {
      errors.push(`${month}：${errorMessage(error)}`);
    }
  }

  // 空月份（纳斯达克返回 null 段并带 code:1002）是正常情况，不算失败；
  // 只有「一个月都没抓成」才抛错，让上层把它记成「美股数据源不可用」。
  if (drafts.length === 0 && errors.length === months.length) throw new Error(errors.join('；'));
  const warnings = errors.length > 0 ? [`部分月份未取到：${errors.join('；')}`] : [];
  // 按日期从新到旧排：`limit` 截断必须落在最新的新股上，否则旧月份会挤掉当期标的。
  const ordered = drafts.sort((a, b) => (b.listingDate ?? '').localeCompare(a.listingDate ?? ''));
  const deduped = dedupeByCode(ordered).slice(0, limit);
  const result: MarketCollected = { offers: deduped, sources: ['nasdaq'], warnings };
  cacheSet(cacheKey, result, IPO_CACHE_TTL_MS);
  return result;
}

interface NasdaqCalendar {
  data?: {
    priced?: { rows?: NasdaqRow[] | null };
    upcoming?: { upcomingTable?: { rows?: NasdaqRow[] | null } | null } | null;
  } | null;
}

type NasdaqRow = Record<string, unknown>;

function usRowToDraft(row: NasdaqRow, kind: 'priced' | 'upcoming'): IpoOfferDraft | null {
  const code = text(row.proposedTickerSymbol).toUpperCase();
  const name = text(row.companyName);
  if (!code || !name) return null;

  const priceText = text(row.proposedSharePrice);
  const { low, high } = parsePriceRange(priceText);
  const pricedDate = dateOnly(row.pricedDate);
  const expectedDate = dateOnly(row.expectedPriceDate);
  const shares = numberOnly(row.sharesOffered);
  const dollars = money(row.dollarValueOfSharesOffered);

  return {
    market: 'US',
    code,
    subscribeCode: code,
    name,
    source: 'nasdaq',
    exchange: text(row.proposedExchange),
    board: '',
    issuePrice: kind === 'priced' ? low : 0,
    priceLow: low,
    priceHigh: high,
    currency: 'USD',
    // 美股最小交易单位为 1 股（券商打新/认购也多以 1 股起）。
    lotSize: 1,
    maxShares: 0,
    subscribeStart: null,
    // 美股没有公开「申购期」：把预计/实际定价日作为截止日，界面据此排序与判断阶段。
    subscribeEnd: expectedDate ?? pricedDate,
    allotmentDate: pricedDate ?? expectedDate,
    listingDate: pricedDate ?? expectedDate,
    issueShares: shares,
    raiseAmount: dollars,
    issuePe: 0,
    industryPe: 0,
    winningRate: 0,
    // 上游不给超额认购倍数；不拿募资额反推算充。
    oversubscribe: 0,
    sponsor: '',
    industry: '',
    // 用 EDGAR 公司检索页作为招股书入口（浏览器可开，AI 也能 fetch_url 后跟进 424B4/S-1）。
    prospectusUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(name)}&type=424B4&dateb=&owner=include&count=10`,
  };
}

/**
 * 需要查询的自然月：往回最多 3 个月（打新列表只关心近期与未来，翻太远只会把当期标的挤掉），
 * 往前 2 个月覆盖已排期的上市。
 */
function monthWindow(from: Date, lookbackDays: number): string[] {
  const months: string[] = [];
  const back = Math.min(3, Math.max(1, Math.ceil(lookbackDays / 30)));
  for (let i = -back; i <= 2; i += 1) {
    const date = new Date(from.getFullYear(), from.getMonth() + i, 1);
    months.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

/* ═══════════════════════════════ HTTP helpers ══════════════════════════════ */

async function requestText(url: string, referer: string): Promise<string> {
  const response = await fetch(url, { headers: { ...DEFAULT_HEADERS, Accept: 'text/html,application/json,*/*', Referer: referer } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function requestJson<T>(url: string, referer: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      ...DEFAULT_HEADERS,
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      Referer: referer,
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

/* ═══════════════════════════════ parsing utils ═════════════════════════════ */

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim();
}

function number(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(text(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** `"7,500,000"` / `"500"` → 数字；取不到给 0。 */
function numberOnly(value: unknown): number {
  const match = /-?\d[\d,]*(?:\.\d+)?/.exec(text(value));
  if (!match) return 0;
  const parsed = Number(match[0].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** `"$75,000,000"` / `"9.56亿"` / `"8664.83万"` → 原币金额或股数（绝对数值）。 */
function money(value: unknown): number {
  const raw = text(value);
  const parsed = numberOnly(raw);
  if (parsed === 0) return 0;
  if (/亿/.test(raw)) return parsed * 100_000_000;
  if (/万/.test(raw)) return parsed * 10_000;
  return parsed;
}

/** 港股的「招股数/募集资金」列用中文单位（万股 / 亿港元），语义同 `money`。 */
function chineseAmount(value: unknown): number {
  return money(value);
}

/** `"100.0%"` / `"0.027"` → 百分数（不乘 100）。 */
function percent(value: unknown): number {
  const raw = text(value);
  if (!raw) return 0;
  const parsed = numberOnly(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function digitsOnly(value: string): string {
  const match = /\d{4,6}/.exec(value.replace(/,/g, ''));
  return match ? match[0] : '';
}

/** `"3.92-5.07"` / `"17.00-19.00"` / `"10.00"` → 区间。 */
function parsePriceRange(value: string): { low: number; high: number } {
  const matches = value.match(/\d+(?:\.\d+)?/g) ?? [];
  if (matches.length === 0) return { low: 0, high: 0 };
  const numbers = matches.map(Number).filter((item) => Number.isFinite(item) && item > 0);
  if (numbers.length === 0) return { low: 0, high: 0 };
  if (numbers.length === 1) return { low: numbers[0], high: numbers[0] };
  return { low: Math.min(...numbers), high: Math.max(...numbers) };
}

/** `"2026/10/15"` / `"10/14/2026"` / `"2026-10-19 00:00:00"` → `YYYY-MM-DD`；解析不出给 null。 */
function dateOnly(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = /(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(raw);
  if (slash) return `${slash[1]}-${slash[2].padStart(2, '0')}-${slash[3].padStart(2, '0')}`;
  // 美股日历用 m/d/yyyy（未补零）。
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return null;
}

/** 同一市场内按代码去重（后者优先，因为先抓到的往往是更细的招股中数据）。 */
function dedupeByCode(offers: IpoOfferDraft[]): IpoOfferDraft[] {
  const map = new Map<string, IpoOfferDraft>();
  for (const offer of offers) {
    const key = `${offer.market}:${(offer.code || offer.subscribeCode).toUpperCase()}`;
    const previous = map.get(key);
    map.set(key, previous ? { ...previous, ...stripEmpty(offer) } : offer);
  }
  return [...map.values()];
}

/** 合并同代码记录时，不让「空值」覆盖已经拿到的值，也不让低优先级源改写数据来源。 */
function stripEmpty(offer: IpoOfferDraft): Partial<IpoOfferDraft> {
  const out: Partial<IpoOfferDraft> = {};
  for (const [key, value] of Object.entries(offer) as [keyof IpoOfferDraft, unknown][]) {
    // `source` 保留先到（优先级更高）的上游，避免价格来自東方財富、署名却是阿斯達克。
    if (key === 'source') continue;
    if (value === '' || value === null || value === 0) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}
