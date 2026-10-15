# 数据源清单与实测结论（零 Key 优先）

> 实测时间：2026-10-14，实测网络：中国大陆家庭宽带（Node 24 `fetch`）。
> ✅ = 实测返回有效数据；❌ = 实测不可用（会作为降级链末端或干脆不启用）。

## 1. 行情 / K 线（股票、场内基金）

### 1.1 东方财富（首选，零 Key）

| 用途 | 端点 | 实测 |
| --- | --- | --- |
| 实时报价 | `https://push2.eastmoney.com/api/qt/stock/get?secid={secid}&fields=f43,f44,...` | ✅ |
| K 线 | `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={secid}&klt=101&fqt=1&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&beg={YYYYMMDD}&end=20500101&lmt=1000` | ✅ |
| 批量/指数 | `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=1.000001,100.HSI,100.NDX&fields=f1,f2,f3,f4,f12,f13,f14` | ✅ |
| 代码搜索 | `https://searchapi.eastmoney.com/api/suggest/get?input={kw}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=10` | ✅ |

**secid 规则**：`{market}.{code}`，market = `1`（沪/深 A 股、沪深300 等）、`116`（港股）、`105`（NASDAQ）、`106`（NYSE/AMEX）、`100`（国际指数，如 HSI/NDX/SPX/DJIA）。
沪深判别：6/5/9 开头 → `1.`；0/3/1/2 开头 → `0.`（深市），A 股用 `1.{code}` 对深市也可返回（东方财富对 A 股统一用 `1.` 亦可命中多数标的，但沪市用 1、深市用 0 更稳）。
港股补零为 5 位（`116.00700`）；美股用 `105.{TICKER}`，NYSE 标的回退 `106.{TICKER}`。

**klt**：`101`=日K，`102`=周K，`103`=月K。`fqt`：`1`=前复权（默认，画 K 线用），`0`=不复权。

**字段映射（`fields` 参数）**

| 字段 | 含义 | 字段 | 含义 |
| --- | --- | --- | --- |
| f43 | 最新价 | f60 | 昨收 |
| f44 | 最高 | f45 | 最低 |
| f46 | 今开 | f47 | 成交量（手） |
| f48 | 成交额 | f50 | 量比 |
| f57 | 代码 | f58 | 名称 |
| f84 | 总股本 | f85 | 流通股 |
| f86 | 每股收益 | f92 | 每股净资产 |
| f116 | 总市值 | f117 | 流通市值 |
| f127 | 行业 | f162/f163/f164 | PE（动/静/TTM） |
| f167 | 市净率 PB | f168 | 换手率 |
| f169/f170/f171 | 涨跌额/涨跌幅/振幅 | f172 | 币种（USD/HKD/CNY） |
| f173 | ROE(%) | f183 | 营业收入 |
| f188 | 净利率 | f189 | 上市日期 |

> 价格需要按 `decimal`（K 线响应里的字段）或固定 2/3 位小数还原：A 股报价 f43 为「分」的整数值 ×0.01（如 `128361` → 1283.61），美股/港股同样是整数化后的值 ×0.001 或 ×0.01。**实现时必须用同一响应里的 `f59`/`decimal` 或按市场固定精度处理**，K 线字符串已是十进制原值，无需还原。

### 1.2 腾讯行情（兜底，零 Key）

`https://qt.gtimg.cn/q=sh600519,hk00700,usAAPL` → GBK 编码的 `v_xxx="..."` 变长字段串，`~` 分隔。

- 索引 1=名称，2=代码，3=现价，4=昨收，5=今开，6=成交量，30=时间，31=涨跌，32=涨跌幅，33=最高，34=最低，36=成交量，37=成交额，39=PE，43=振幅，44=流通市值，45=总市值，46=PB，47=涨停价，48=跌停价，49=量比，**第 60 位起**为 ROE/净利率等扩展字段（美股/港股与 A 股位置略有差异）。
- 必须用 GBK 解码（`new TextDecoder('gbk')`，Node 自带 full-icu）。

### 1.3 其他（实测不可用 / 仅作链尾）

| 数据源 | 实测 | 处理 |
| --- | --- | --- |
| Yahoo Finance `query1/query2.finance.yahoo.com/v8/finance/chart/...` | ❌ 403（地区风控返回 HTML） | 保留实现，启用前先探测；失败即降级 |
| Stooq `stooq.com/q/d/l/?s=aapl.us&i=d` | ❌ 403 Access denied | 同上 |
| 新浪 `hq.sinajs.cn` | ❌ 403 Forbidden（需特定 Referer/UA） | 不实现，文档标注 |

## 2. 基本面 / 财务

### 2.1 A 股 F10（东方财富，零 Key）

| 用途 | 端点 | 实测 |
| --- | --- | --- |
| 主要财务指标 | `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=ALL&filter=(SECUCODE="{code}.SH")&pageNumber=1&pageSize=20&sortTypes=-1&sortColumns=REPORT_DATE&source=HSF10&client=PC` | ✅ |
| 利润表 | 见 §2.3：`RPT_F10_FINANCE_{T}INCOME`，`{T}` 按行业取 G/B/S/I | ✅ |
| 公司概况 | `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=SH600519` | ✅ |
| 分红送配 | `https://emweb.securities.eastmoney.com/PC_HSF10/BonusFinancing/PageAjax?code=SH600519` | ✅ |
| 历史分红（通用） | `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=(SECURITY_CODE="600519")&pageNumber=1&pageSize=20&sortColumns=REPORT_DATE&sortTypes=-1` | ✅ |
| 行业/主题板块 | `reportName=RPT_F10_CORETHEME_BOARDTYPE`（filter SECUCODE） | ✅ |
| 估值分析 | `reportName=RPT_VALUEANALYSIS_DET`（filter SECURITY_CODE） | ✅ |

> `SECUCODE` 后缀：沪市 `.SH`，深市 `.SZ`。`emweb...PageAjax?code=` 用 `SH600519` / `SZ000001`。
> ⚠️ `emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/MainTargetAjax` 实测返回「无F10资料」HTML，**不要用**。

### 2.2 港股 / 美股基本面
- 实测 `PC_HKF10` / `PC_USF10` 的 PageAjax 与 MainTargetAjax 均返回 **404 / 无F10资料** ❌。
- 可用替代：`push2` 报价接口已返回 PE/PB/ROE(f173)/营收(f183)/净利率(f188)/市值/行业 —— 作为港美股的**结构化基本面主源** ✅。
- 三表走 datacenter（见 §2.3）：港股 ✅ 利润表 + 资产负债表 + 主要指标；美股 ✅ 利润表 + 资产负债表。
- 更深入的内容（研报、财报解读、国际局势）走 `web_search` + `get_news` 由 Agent 汇总。

### 2.3 财报三表（东方财富 datacenter，零 Key）
实测 2026-10-15，全部返回 HTTP 200 + 业务 `result.data`。

**A 股：按行业分四套模板**（同一 `reportName` 前缀只差一个字母，取错模板会得到「返回数据为空」）：

| 行业模板 | `{T}` | 利润表 | 资产负债表 | 现金流量表 |
| --- | --- | --- | --- | --- |
| 通用（茅台等） | `G` | `RPT_F10_FINANCE_GINCOME` ✅ | `RPT_F10_FINANCE_GBALANCE` ✅ | `RPT_F10_FINANCE_GCASHFLOW` ✅ |
| 银行（工行/招行等） | `B` | `RPT_F10_FINANCE_BINCOME` ✅ | `RPT_F10_FINANCE_BBALANCE` ✅ | `RPT_F10_FINANCE_BCASHFLOW` ✅ |
| 证券（中信等） | `S` | `RPT_F10_FINANCE_SINCOME` ✅ | `RPT_F10_FINANCE_SBALANCE` ✅ | `RPT_F10_FINANCE_SCASHFLOW` ✅ |
| 保险（平安等） | `I` | `RPT_F10_FINANCE_IINCOME` ✅ | `RPT_F10_FINANCE_IBALANCE` ✅ | `RPT_F10_FINANCE_ICASHFLOW` ✅ |

- URL 形如 `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_{T}BALANCE&columns=ALL&filter=(SECUCODE="601398.SH")&pageNumber=1&pageSize=8&sortTypes=-1&sortColumns=REPORT_DATE&source=HSF10&client=PC`，需 `Referer: https://emweb.securities.eastmoney.com/`。
- **宽表**：一条记录一个报告期（200-320 列），`pages≈100`，即近 100 期；金额单位为元，字段带 `_YOY` 同比。命名规律 `{描述}_{YOY}`。
- 金融行业模板缺 `TOTAL_OPERATE_INCOME`（用 `OPERATE_INCOME` + `OPERATE_INCOME_YOY` 回退），也没有 `OPERATE_COST`/销售/管理/研发费用等通用科目 —— 缺失即不输出，不补 0。
- ⚠️ 以茅台实测时 `ASSET_BALANCE=0` 而 `TOTAL_ASSETS` 有值：同义字段必须按优先级取第一个非空**非零**值。

**港股：长表 + 主要指标**

| 用途 | `reportName` | 形状 | 实测 |
| --- | --- | --- | --- |
| 利润表 | `RPT_HKF10_FN_INCOME` | 长表（`STD_ITEM_CODE`/`ITEM_NAME`/`AMOUNT`/`YOY_RATIO`，约 27 科目/期） | ✅ |
| 资产负债表 | `RPT_HKF10_FN_BALANCE` | 长表（约 55 科目/期） | ✅ |
| 主要财务指标 | `RPT_HKF10_FN_MAININDICATOR` | 宽表（89 列，含 `NETCASH_OPERATE`/`NETCASH_INVEST`/`NETCASH_FINANCE`/`END_CASH`） | ✅ |
| 现金流量表明细 | `RPT_HKF10_FN_CASHFLOW*`（试了 20+ 命名） | — | ❌ 一律「报表配置不存在」 |

**美股：长表，`SECUCODE` 必须带交易所后缀**

| 用途 | `reportName` | 实测 |
| --- | --- | --- |
| 利润表 | `RPT_USF10_FN_INCOME` | ✅ `AAPL.O` |
| 资产负债表 | `RPT_USF10_FN_BALANCE` | ✅ `AAPL.O` |
| 现金流量表 | `RPT_USF10_FN_CASHFLOW*` | ❌ 全部「报表配置不存在」→ 改用 §2.4 SEC EDGAR |
| 主要财务指标 | `RPT_USF10_FN_MAININDICATOR` | ❌「报表配置不存在」 |

- 裸代码（如 `AAPL`、`BABA`）一律「返回数据为空」；`.O`=纳斯达克、`.N`=纽交所（实测 AAPL/TSLA/MSFT/NVDA/META/PDD → `.O`，BABA/KO/JPM → `.N`）。ETF（SPY/SCHD/VOO/AGG）无 F10 财报 → 返回空，属预期。
- ⚠️ **同一报告期有「单季报」与「累计季报」两套行**（数值不同，科目名/`STD_ITEM_CODE` 重复）。解析必须按 `REPORT_TYPE` 二选一（本项目取 `累计季报` 以对齐 A 股/港股口径），否则同一科目会出现两个互相矛盾的数值。
- ⚠️ 长表分页按 `STD_REPORT_DATE` 倒序；窗口被打满时最旧一组会缺科目（实测港股资产负债表出现「有总资产/没有流动资产」的半张表），必须整组丢弃。

**不可用时的口径**：美股现金流量表明细由 SEC EDGAR 提供（见 §2.4）；若 EDGAR 也没有该发行人数据，代码把该表标为 `available=false` + `reason`，由提示词要求 Agent 用 `web_search` 检索 10-K/10-Q 原文补足，并在结论中写明「数据缺失」。

### 2.4 美股现金流量表：SEC EDGAR XBRL（官方、零 Key）

实测 2026-10-15：

| 用途 | 端点 | 实测 |
| --- | --- | --- |
| ticker → CIK | `https://www.sec.gov/files/company_tickers.json`（约 1MB，24h 缓存） | ✅ |
| 按科目取全部报告期 | `https://data.sec.gov/api/xbrl/companyconcept/CIK{10 位}/us-gaap/{Tag}.json` | ✅ AAPL 134 个数据点 |
| IFRS 发行人回退 | 同上，taxonomy 换 `ifrs-full` | ✅（BABA 实测走 us-gaap 即可） |

- ⚠️ **User-Agent 必须带联系方式**：只带网址的 UA 实测一律 **403**（`+https://…` 与 `(https://…)` 都被拒）；带 `contact: xxx@example.com` 或浏览器式 UA 才 200。默认值见 `datasources/edgar.ts`，建议用 `AIA_EDGAR_USER_AGENT` 填自己的邮箱（见 `.env.example`）。
- 使用的 Tag：`NetCashProvidedByUsedInOperatingActivities` / `…InvestingActivities` / `…FinancingActivities`、`PaymentsToAcquirePropertyPlantAndEquipment`、`PaymentsOfDividendsCommonStock`、`DepreciationDepletionAndAmortization`、`CashAndCashEquivalentsAtCarryingValue`；IFRS 回退 `CashFlowsFromUsedInOperatingActivities` 等。
- 口径：同一 `end` 同时存在「单季」与「年初至今」两种 duration，取**最长（≤400 天）**= 累计口径，与 A 股/港股对齐；`≥300 天` 标为年报，其余按 `fp` 标一季报/中报/三季报；同期限取最近申报（处理重述）；只接受 `10-K/10-Q/20-F/40-F`。
- 覆盖实测：15 只大盘股中 **13 只有数据**（AAPL/MSFT/XOM/JNJ/WMT/PG/JPM/NVDA/TSLA/META/GOOGL/BABA/NKE）。**KO（可口可乐）与 V（Visa）在 companyconcept 里返回空的 `units.USD`**（同一 Tag 在 companyfacts 里有 155 个事实，属带维度事实未被该接口暴露的情形），`frames` 接口同样取不到 → 这两类标的按「数据缺失」处理。用 `companyfacts`（单只 10MB+）兜底不划算，未采纳。

## 3. 场外基金（天天基金，零 Key）

| 用途 | 端点 | 实测 |
| --- | --- | --- |
| 基金详情 + 净值曲线 | `https://fund.eastmoney.com/pingzhongdata/{code}.js` | ✅ |
| 净值历史（分页） | `https://api.fund.eastmoney.com/f10/lsjz?fundCode={code}&pageIndex=1&pageSize=20`，**Referer 必须是 `https://fundf10.eastmoney.com/`** | ✅ |
| 基金搜索 | `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key={kw}` | ✅ |
| 分红 | `api.fund.eastmoney.com/f10/fhsp?fundCode=...` | ❌ 404，改用 web_search 兜底 |
| 基金基础信息 | `fundmobapi.eastmoney.com/...` | ❌ 返回「网络繁忙」错误码，**不要用** |

**`pingzhongdata/{code}.js` 可解析的变量**（实测完整列表）：
`fS_name`（名称）、`fS_code`、`fund_sourceRate`（原费率）、`fund_Rate`（现费率）、`fund_minsg`（最小申购额）、`stockCodes`/`stockCodesNew`（持仓股票代码）、`zqCodes`/`zqCodesNew`（持仓债券）、`syl_1n`/`syl_6y`/`syl_3y`/`syl_1y`（近1年/6月/3月/1月收益）、`Data_fundSharesPositions`（股票仓位%）、`Data_netWorthTrend`（单位净值：`[{x: 毫秒时间戳, y: 净值, equityReturn: 日涨跌%, unitMoney: 分红}]`）、`Data_ACWorthTrend`（累计净值 `[[ts, val], ...]`）、`Data_grandTotal`、`Data_rateInSimilarType`/`Data_rateInSimilarPersent`（同类排名）、`Data_fluctuationScale`（规模变动）、`Data_holderStructure`（持有人结构）、`Data_assetAllocation`（资产配置）、`Data_performanceEvaluation`（五维评价）、`Data_currentFundManager`（基金经理）、`Data_buySedemption`（申赎状态）。

## 4. 宏观与资讯

> 复核记录（2026-10-15）：此前把 LPR 也列进「报表不存在」是**错的** —— LPR 走 `RPTA_WEB_RATE`
> （页面 `data.eastmoney.com/cjsj/globalRateLPR.html` 的 JS 里写明），已接入 `macro.ts`。
> 社会融资规模确实没有可用零 Key 报表（对 `RPT_ECONOMY_*` / `RPTA_WEB_*` 共 48 种命名做了穷举探测）。

| 用途 | 端点 | 实测 |
| --- | --- | --- |
| CPI | `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_ECONOMY_CPI&columns=ALL&pageNumber=1&pageSize=12&sortColumns=REPORT_DATE&sortTypes=-1` | ✅ |
| PPI | `reportName=RPT_ECONOMY_PPI` | ✅ |
| GDP | `reportName=RPT_ECONOMY_GDP` | ✅ |
| PMI | `reportName=RPT_ECONOMY_PMI` | ✅ |
| 货币供应 M2 | `reportName=RPT_ECONOMY_CURRENCY_SUPPLY` | ✅ |
| 全球指数 | `push2.eastmoney.com/api/qt/ulist.np/get?secids=1.000001,1.000300,0.399001,100.HSI,100.NDX,100.DJIA,100.SPX` | ✅ |
| 财经资讯搜索 | `https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param={JSON}`（JSONP，需剥壳；`type:["cmsArticleWebOld"]`，`sort:"time"`） | ✅ |
| **LPR（贷款市场报价利率）** | `reportName=RPTA_WEB_RATE&columns=ALL&sortColumns=TRADE_DATE&sortTypes=-1`（**注意排序字段是 TRADE_DATE**，没有 REPORT_DATE；无需 token） | ✅ 2026-10-15 实测：`LPR1Y=3`、`LPR5Y=3.5`、`RATE_1=4.35`、`RATE_2=4.9` @2026-09-20 |
| 社会融资规模 | `RPT_ECONOMY_LPR` / `RPT_ECONOMY_TOTAL_SOCIETY_FINANCE` / `RPTA_WEB_SHRZGM` 等 48 种命名 | ❌ 2026-10-15 复核：报表均不存在；维持 web_search 兜底 |

## 5. 网页检索（Agent 挖掘信息用）

| 数据源 | 端点 | 实测 | 备注 |
| --- | --- | --- | --- |
| Bing | `https://cn.bing.com/search?q={q}&count=20` | ✅ 200，HTML 可解析 | **默认搜索源**，需带 `User-Agent`，解析 `li.b_algo` / `<h2><a href>` / `.b_caption` |
| DuckDuckGo | `https://html.duckduckgo.com/html/?q=`、`lite.duckduckgo.com` | ❌ ECONNRESET | 作为备用，运行时探测 |
| Tavily | `https://api.tavily.com/search` | 需 Key | 有 Key 时优先级最高 |
| Serper | `https://google.serper.dev/search` | 需 Key | |
| Brave | `https://api.search.brave.com/res/v1/web/search` | 需 Key | |

## 6. 汇率（组合折算）

- 东方财富外汇：`https://push2.eastmoney.com/api/qt/stock/get?secid=133.USDCNH&fields=f43,f58`，`133.HKDCNH`。实测外汇 secid 可用；若失败回退到 `@aia/shared` 的 `FX_FALLBACK_INTO_CNY`（HKD 0.92、USD 7.1）并在响应 `warnings` 中标注。

## 7. 通用实现要求

1. **UA**：所有请求带 `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36`。
2. **编码**：腾讯行情、部分老接口为 GBK，需 `TextDecoder('gbk')` 探测解码（出现 `\uFFFD` 即切换）。
3. **超时与重试**：单请求 20s 超时，最多重试 2 次（指数退避），失败抛出可读错误，由 registry 降级到下一个 provider。
4. **缓存**：报价 TTL 60s、K 线/净值 TTL 5min、宏观 TTL 30min，进程内 Map + LRU 上限。
5. **绝不静默给 0**：数据缺失时把原因写入 `warnings[]`，UI 与 Agent 都要能看到。
6. **合规**：仅使用公开可访问的数据接口，请求频率保持低频（避免被限流），带正常 UA，不绕过登录/付费墙。
