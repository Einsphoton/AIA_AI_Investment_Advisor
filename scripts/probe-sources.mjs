/**
 * Data-source connectivity self-check (`npm run probe:sources`).
 *
 * Verifies the zero-key public endpoints this app depends on, printing a table
 * with status, latency and a short body preview. Useful when a deployment
 * environment blocks some providers (the app degrades gracefully, but knowing
 * which source is unreachable explains missing data in the UI).
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const PROBES = [
  ['东方财富 报价(A股)', 'https://push2.eastmoney.com/api/qt/stock/get?secid=1.600519&fields=f43,f57,f58,f162,f163,f167,f173'],
  ['东方财富 报价(港股)', 'https://push2.eastmoney.com/api/qt/stock/get?secid=116.00700&fields=f43,f57,f58,f163,f167,f173'],
  ['东方财富 报价(美股)', 'https://push2.eastmoney.com/api/qt/stock/get?secid=105.AAPL&fields=f43,f57,f58,f163,f167,f173'],
  [
    '东方财富 K线',
    'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519&klt=101&fqt=1&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&beg=20240101&end=20500101&lmt=5',
  ],
  ['东方财富 搜索', 'https://searchapi.eastmoney.com/api/suggest/get?input=%E8%8C%85%E5%8F%B0&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=3'],
  ['东方财富 F10 财务', 'https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=ALL&filter=(SECUCODE%3D%22600519.SH%22)&pageNumber=1&pageSize=2&sortTypes=-1&sortColumns=REPORT_DATE&source=HSF10&client=PC'],
  // 财报三表：A 股按行业分模板（G 通用 / B 银行 / S 证券 / I 保险），港股/美股为长表。
  ['东财 F10 利润表(A股·通用)', 'https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_GINCOME&columns=ALL&filter=(SECUCODE%3D%22600519.SH%22)&pageNumber=1&pageSize=1&sortTypes=-1&sortColumns=REPORT_DATE&source=HSF10&client=PC'],
  ['东财 F10 资产负债表(A股·通用)', 'https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_GBALANCE&columns=ALL&filter=(SECUCODE%3D%22600519.SH%22)&pageNumber=1&pageSize=1&sortTypes=-1&sortColumns=REPORT_DATE&source=HSF10&client=PC'],
  ['东财 F10 现金流量表(A股·通用)', 'https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_GCASHFLOW&columns=ALL&filter=(SECUCODE%3D%22600519.SH%22)&pageNumber=1&pageSize=1&sortTypes=-1&sortColumns=REPORT_DATE&source=HSF10&client=PC'],
  ['东财 F10 资产负债表(A股·银行)', 'https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_BBALANCE&columns=ALL&filter=(SECUCODE%3D%22601398.SH%22)&pageNumber=1&pageSize=1&sortTypes=-1&sortColumns=REPORT_DATE&source=HSF10&client=PC'],
  ['东财 F10 利润表(港股)', 'https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_HKF10_FN_INCOME&columns=ALL&filter=(SECUCODE%3D%2200700.HK%22)&pageNumber=1&pageSize=60&sortTypes=-1&sortColumns=STD_REPORT_DATE&source=HSF10&client=PC'],
  ['东财 F10 资产负债表(港股)', 'https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_HKF10_FN_BALANCE&columns=ALL&filter=(SECUCODE%3D%2200700.HK%22)&pageNumber=1&pageSize=60&sortTypes=-1&sortColumns=STD_REPORT_DATE&source=HSF10&client=PC'],
  ['东财 F10 主要指标(港股·现金流兜底)', 'https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_HKF10_FN_MAININDICATOR&columns=ALL&filter=(SECUCODE%3D%2200700.HK%22)&pageNumber=1&pageSize=1&sortTypes=-1&sortColumns=STD_REPORT_DATE&source=HSF10&client=PC'],
  ['东财 F10 利润表(美股·须带后缀)', 'https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_USF10_FN_INCOME&columns=ALL&filter=(SECUCODE%3D%22AAPL.O%22)&pageNumber=1&pageSize=60&sortTypes=-1&sortColumns=REPORT_DATE&source=HSF10&client=PC'],
  ['东财 F10 资产负债表(美股·须带后缀)', 'https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_USF10_FN_BALANCE&columns=ALL&filter=(SECUCODE%3D%22AAPL.O%22)&pageNumber=1&pageSize=60&sortTypes=-1&sortColumns=REPORT_DATE&source=HSF10&client=PC'],
  // SEC EDGAR：美股现金流量表的零 Key 官方来源（UA 必须带联系方式，见 .env.example）。
  ['SEC EDGAR ticker→CIK', 'https://www.sec.gov/files/company_tickers.json', 'https://www.sec.gov/'],
  ['SEC EDGAR 现金流(AAPL)', 'https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/NetCashProvidedByUsedInOperatingActivities.json', 'https://www.sec.gov/'],
  ['东方财富 分红', 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=(SECURITY_CODE%3D%22600519%22)&pageNumber=1&pageSize=3&sortColumns=REPORT_DATE&sortTypes=-1'],
  ['东方财富 宏观 CPI', 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_ECONOMY_CPI&columns=ALL&pageNumber=1&pageSize=3&sortColumns=REPORT_DATE&sortTypes=-1'],
  ['东方财富 全球指数', 'https://push2.eastmoney.com/api/qt/ulist.np/get?secids=1.000001,100.HSI,100.NDX&fields=f2,f3,f12,f13,f14'],
  // 净值历史接口要求 Referer 为 fundf10.eastmoney.com，否则返回 ErrCode -999。
  ['天天基金 净值', 'https://api.fund.eastmoney.com/f10/lsjz?fundCode=000001&pageIndex=1&pageSize=3', 'https://fundf10.eastmoney.com/'],
  ['天天基金 详情JS', 'https://fund.eastmoney.com/pingzhongdata/000001.js'],
  ['腾讯行情(兜底)', 'https://qt.gtimg.cn/q=sh600519,hk00700,usAAPL'],
  ['Bing 搜索', 'https://cn.bing.com/search?q=%E8%B4%B5%E5%B7%9E%E8%8C%85%E5%8F%B0&count=10'],
  ['Yahoo Finance', 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=5d&interval=1d'],
];

async function probe([name, url, referer]) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: referer ?? 'https://quote.eastmoney.com/' },
      signal: controller.signal,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    let text = buffer.toString('utf8');
    if (text.includes('\uFFFD')) text = new TextDecoder('gbk').decode(buffer);
    // An HTTP 200 does not mean the upstream returned data: Eastmoney signals
    // failures inside the body (`"data":null`, `rc != 0`, `ErrCode < 0`).
    const rc = text.match(/"rc":\s*(-?\d+)/);
    const errCode = text.match(/"ErrCode":\s*(-?\d+)/);
    const emptyData = /"data"\s*:\s*(null|\{\s*\})/.test(text);
    const bodyOk = (rc === null || rc[1] === '0') && (errCode === null || Number(errCode[1]) >= 0) && !emptyData;
    return {
      name,
      ok: response.ok && bodyOk,
      status: response.status,
      ms: Date.now() - started,
      preview: `${bodyOk ? '' : '[body-error] '}${text.replace(/\s+/g, ' ').slice(0, 96)}`,
    };
  } catch (error) {
    return { name, ok: false, status: 0, ms: Date.now() - started, preview: error.message };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
for (const definition of PROBES) {
  results.push(await probe(definition));
}

const nameWidth = Math.max(...results.map((result) => result.name.length)) + 2;
console.log(`${'数据源'.padEnd(nameWidth)}状态  耗时    预览`);
console.log('-'.repeat(nameWidth + 60));
for (const result of results) {
  const flag = result.ok ? '\x1b[32mOK  \x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`${result.name.padEnd(nameWidth)}${flag}  ${String(result.status).padStart(3)}  ${String(result.ms).padStart(5)}ms  ${result.preview}`);
}

const failed = results.filter((result) => !result.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length > 0) {
  console.log('不可用的数据源：' + failed.map((result) => result.name).join('、'));
  console.log('提示：东方财富/腾讯/天天基金/Bing 为默认链路；缺失的源只影响对应数据丰富度，应用会自动降级。');
}
process.exit(failed.length === PROBES.length ? 1 : 0);
