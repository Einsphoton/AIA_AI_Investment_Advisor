# HTTP API 契约（冻结版 v1）

> 所有接口前缀 `/api`，请求与响应均为 JSON（SSE 除外）。
> 类型定义以 `packages/shared/src/types.ts` 为准，本文件只描述路由语义。
> 错误响应统一为 `{ "error": { "code": string, "message": string, "details"?: unknown } }`，
> HTTP 状态码 400（参数错误）/ 404（不存在）/ 409（与账本或资源状态冲突，例如超卖、倒填卖出、重复标的）/ 413（请求体过大）/ 502（上游数据源失败）/ 500（未预期错误）。

## 0. 通用约定

| 约定 | 说明 |
| --- | --- |
| 金额精度 | 服务端保留 4 位小数，响应中为 `number`；前端负责展示格式化 |
| 日期 | 交易日 `YYYY-MM-DD`，且必须是**真实存在的日历日**（`2026-13-45`、`2026-02-30` 会被 400 拒绝）；时间戳为 ISO 8601 字符串（本地时区偏移） |
| 列表响应 | **需要筛选/排序的列表**（`/api/assets`、`/api/watchlist`）返回 `{ items, total }`；**枚举型列表**直接返回数组：`/api/agent/runs`、`/api/agent/tools`、`/api/chat/sessions`、`/api/market/{search,indices,news}`、`/api/backup/files`、`/api/settings/data-sources/probe` |
| 筛选 | querystring：`market`、`type`、`source`（`manual`/`ai`）、`q`（模糊搜索）、`sort`、`dir` |
| 排序字段 | `marketValue` \| `pnl` \| `changeSinceAdded` \| `qualityScore` \| `createdAt` \| `name`；`dir` 为 `asc`/`desc`，默认 `desc` |
| SSE | `Content-Type: text/event-stream`，事件格式 `event: <type>\ndata: <json>\n\n`，事件对象为 `AgentEvent` |
| 安全 | **任何接口都不返回明文 API Key**（`llm.apiKey` 与 `dataSources.*.apiKey` 一视同仁）：只返回 `hasApiKey` 与 `apiKeyMasked`；导出的备份/快照同样剔除 Key |

### SSE 事件序列（所有 AI 接口一致）

```
run-started  → ( step | progress | text | metrics | tool-call | tool-result | entity | budget )*  →  run-finished  →  done
```

任何阶段都可能插入 `error`；客户端必须容忍未知事件类型。

> `metrics` 事件携带**单次 LLM 请求**的推理指标（`InferenceMetrics`）：每个 agent 轮次发两条
> —— 首个 token 到达时 `phase='first-token'`（此时只有 `ttftMs`），请求结束时 `phase='done'`
> （`promptTokens` / `completionTokens` / `cachedTokens` / `tokensPerSecond` / `latencyMs` 齐备）。
> 计数口径是「单次请求」而不是累计值，整条流水线的合计由客户端把收到的 `done` 事件相加得到。
> `cachedTokens`（KV / prompt cache 命中）同时兼容三种厂商口径：
> OpenCode/OpenAI 的 `prompt_tokens_details.cached_tokens`、DeepSeek 的 `prompt_cache_hit_tokens`、
> Anthropic 风格的 `cache_read_input_tokens`；并已钳制到不超过 `promptTokens`。
> 前端把这些指标渲染在右下角可收起的全局推理面板里（`AgentActivityDock`）。

> `POST /api/advice/generate` 与 `POST /api/agent/run-now` 会在**同一条流**里顺序跑三条流水线
> （资产分析 → 标的分析 → 建议生成），因此流内会出现**多组** `run-started … run-finished`，
> 最后统一以 `done` 收尾。客户端应按 `runId` 分组渲染。
>
> AI 写接口在**未配置 API Key** 时不会开始流，而是直接返回 HTTP 400 + JSON
> `{"error":{"code":"NOT_CONFIGURED"}}`。

---

## 1. 健康检查与版本

- `GET /api/health` → `{ ok, version, commit, builtAt, uptime, dataDir, webBuilt }`（`webBuilt` 表示前端产物是否存在；`commit`/`builtAt` 让部署核查一次请求就能确认「跑的是哪个 revision」）
- `GET /api/version` → `AppVersionPayload`：`{ ok, version, commit, branch, builtAt, environment, node, startedAt, uptimeSeconds }`
  - **版本号唯一来源是根 `package.json` 的 `version`**：服务端启动时解析，前端在构建期注入，任何一侧都不再写死
  - `commit` / `branch` 优先取 `AIA_GIT_COMMIT` / `AIA_GIT_BRANCH`（`GIT_COMMIT` / `GITHUB_SHA` / `GITHUB_REF_NAME` 亦可）；本地开发直接读 `.git`（不调用 `git` 子进程）；容器镜像里 `.git` 被排除，由 CI 通过 `--build-arg` 注入；读不到一律为 `unknown`
  - `builtAt` 取 `AIA_BUILD_TIME` → `SOURCE_DATE_EPOCH` → 运行产物 mtime；解析不到为 `''`
  - 前端左上角版本徽标同时显示「本次加载的前端版本」与「服务端版本」，两者不一致时高亮告警 —— 这是「浏览器缓存了旧 `app.js`、却配上新 API」唯一可见的信号

## 2. 设置（/api/settings）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/settings` | 返回 `Settings`；**API Key 一律只返回掩码**：`llm.hasApiKey`/`llm.apiKeyMasked`，以及每个数据源槽位的 `hasApiKey`/`apiKeyMasked`（槽位用全遮罩 `****`，不泄露任何密钥片段） |
| PUT | `/api/settings` | 入参 `SettingsInput`，返回更新后的 `Settings`；`apiKey` 三态：省略或 `''` = 不变，`null` = 清空，非空字符串 = 覆盖（`llm.apiKey` 与 `dataSources.*.apiKey` 同规则）。掩码串 `****` 会被 **400** 拒绝，避免把脱敏值存成假 Key |
| POST | `/api/settings/test-llm` | 用当前（或临时传入的）LLM 配置发一次最小请求，返回 `{ ok, model, latencyMs, message }` |
| POST | `/api/settings/llm-models` | 用当前（或临时传入的）LLM 配置请求 `GET {baseUrl}/models`，返回 `{ ok, models: string[], message }`；入参 `{ baseUrl?, apiKey?, llm? }`，省略 `apiKey` 时用已保存的 Key（**Key 只进不出**）。失败以 `ok:false` 返回并带上厂商原文，不抛 5xx，便于前端退回手填 |
| POST | `/api/settings/diagnose-llm` | 一键诊断：依次探测「配置 → `GET {baseUrl}/models` → `POST {baseUrl}/chat/completions` →（`opencode.ai` 域名时）`GET https://opencode.ai/console/api/v2/config` 检查工作区是否含 Go」，返回 `{ ok, verdict, steps: {id,label,ok,detail}[] }`；`verdict` 把 401（凭据）/ 402（余额与订阅）/ 404（入口或模型）区分为不同的处置建议 |
| GET | `/api/settings/data-sources` | 返回 `{ slots: {slot, market, kind, label, options: DataSourceCatalogueEntry[]}[], providers: DataSourceCatalogueEntry[] }` |
| POST | `/api/settings/data-sources/probe` | 对当前启用的数据源做一次可用性探测，返回 `{ provider, ok, latencyMs, message }[]` |

### 定时任务（`Settings.schedules`，数组）

2026-10 起定时任务是**数组**（旧版的单个 `Settings.schedule` + 全局 `mode='off'` 已移除）：

```jsonc
"schedules": [
  { "id": "sched_morning", "name": "工作日盘前", "enabled": true, "mode": "daily",
    "dailyTime": "08:45", "intervalMinutes": 1440,
    "runAssetAnalysis": true, "runWatchlistAnalysis": false, "runAdvice": true },
  { "id": "sched_weekend", "name": "周末挖标的", "enabled": false, "mode": "interval",
    "intervalMinutes": 360, "dailyTime": "08:30",
    "runAssetAnalysis": false, "runWatchlistAnalysis": true, "runAdvice": false }
]
```

| 规则 | 说明 |
| --- | --- |
| 替换语义 | `PUT /api/settings` 里 `schedules` **整体替换**（与 `mcpServers` 相同）；省略该字段 = 保持不变；`[]` = 删光所有任务并停止排程 |
| 每条任务 | `id`（稳定标识，`[A-Za-z0-9_-]{1,40}`，同一数组内不可重复）、`name`、`enabled`（停用后配置保留但不排程）、`mode`（`interval` \| `daily`，**没有** `off`）、`intervalMinutes`（≥1，从上次跑完起算）、`dailyTime`（`HH:mm` 本地时间）、三个步骤开关 |
| 校验 | `dailyTime` 必须是合法的 24 小时时间（`25:99` → 400）；三个步骤**至少选一个**（全关的任务没有任何意义 → 400）；`id` 重复 → 400；最多 20 个任务 |
| 生效 | 保存后调度器立即 `reload()`，无需重启；同一时刻到期的多个任务**合并成一次运行**（步骤取并集），跑完各自重排 |
| 旧库 / 旧备份 | 旧库的 `schedule_*` 单任务列在读取时迁移成「一个任务」（`mode='off'` → 空数组）；旧备份里的 `settings.schedule` 对象同样兼容；写回时旧列会同步第一个启用任务，方便回滚到旧版本 |
| 观察 | `GET /api/dashboard` 的 `signals.scheduleEnabled`（是否至少有一个启用任务）、`signals.nextRunAt`（最近一次）与 `signals.nextRuns[]`（`{id,name,nextRunAt}`，按时间升序）来自**实时调度器**；设置页据此逐个任务显示下次运行时间 |

## 3. 仪表盘（/api/dashboard）

- `GET /api/dashboard` → `DashboardPayload`
  - `portfolio`：**第一板块**（总市值/总成本/浮动盈亏/已实现盈亏，统一折算为 CNY，`fxRates` 为折算率）
  - `portfolio.performance`（`PortfolioPerformance`）：**当年年化收益**，Dashboard 第一行的「年化收益率 / 已实现年化收益率」直接读它
    - `annualizedPct` = **XIRR（资金加权，实际天数/365）**：期初（上一年最后一天）持仓市值按各自 ≤ 该日的**最后收盘价**估值，
      叠加当年每笔买卖的真实现金流（买入含费 / 卖出扣费），期末取当前总市值。**不是**「收益率 ÷ 天数 × 365」的外推
    - `realizedAnnualizedPct` = 只算**当年卖出**部分：账面成本（移动加权平均，含分摊买入费用）锚定在这些份额的**加权平均买入日**
    - `sinceInceptionPct` = 全周期年化（首次买入 → 今天，同口径，仅需账本 + 期末市值）
    - 期初估值失败（缺历史收盘价 / 取数超时）时 `openingValue`、`annualizedPct` 一律为 `null`，`notes` 写明原因 —— **绝不用 0 或估算值冒充**；
      当年没有卖出时 `realizedAnnualizedPct` 同样为 `null`（不适用，而不是 0）
    - 期初收盘价按「标的 × 年度」缓存在 `kv`（`perf.openClose.<基准日>.<assetId>`），每年每个标的只取一次上游
    - 支持可选 `?asOf=YYYY-MM-DD`（未来日期夹到今天）把口径固定在某个估值日，便于复核：`GET /api/dashboard?asOf=2026-06-30`
  - `counts` + `signals`：**第二板块**（持仓数量、资产数量、标的变化、新建议）
  - `topHoldings`：**第三板块**（按市值 Top5，`AssetSummary[]`，含 `spark` 缩略走势）
  - `briefing`：**第四板块**（AI 针对持仓的分析简报，`null` 表示尚未生成）
  - `budget`、`indices`：额外上下文

## 4. 我的资产（/api/assets）

> **Agent 治理（P0/P1）**：`Settings` 额外提供
> - `llm.contextTokens`：上下文预算（token）。Agent 每轮推理前做三级**上下文压缩**：保留最近若干轮原样 →
>   更早的工具结果压到 ≤600 字 → 仍超预算则整组丢弃并插入 `[历史压缩]` 说明 → 最后对最大的消息**强制裁剪**。
>   若连系统提示本身都超过预算，服务端不会静默发送：会写一条 `error` 步骤并在日志中给出超出量
>   （此时应调大 `llm.contextTokens` 或减少持仓/标的数量）。压缩与强制裁剪都会写入 step。
> - `toolPolicy`（`deny` + `requireWriteApproval`）与 `mcpServers`，详见 §9.2 / §9.3。
>
> 所有 SSE 入口都支持**端到端取消**：客户端断开或主动中断时，服务端在**下一个轮次/工具边界**停止后续推理与
> 工具调用；**已在执行中的工具调用会跑完**（不会中途中断其 HTTP 请求）。已产生的部分结论仍会写入
> `run.summary`（`status='error'`、`error='已取消'`），已提交的写入不回滚；被中断的 run 可续跑（§9.4）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/assets` | `ListResponse<AssetSummary>`，支持筛选/排序/搜索 |
| POST | `/api/assets` | 入参 `CreateAssetInput`；`name` 缺省时由数据源自动补全；同时写入第一条 buy 交易 → 返回 `AssetDetail` |
| GET | `/api/assets/:id` | `AssetDetail`（含全部交易记录） |
| PUT | `/api/assets/:id` | 入参 `UpdateAssetInput`（名称/备注/市场/类型）→ `AssetDetail` |
| DELETE | `/api/assets/:id` | 同时删除其交易记录 → `{ ok: true }` |
| POST | `/api/assets/:id/transactions` | 入参 `CreateTransactionInput`（买入/卖出/份额/单价/日期/费用/备注）→ `AssetDetail`。**卖出会做两道账本一致性校验**：① 份额不得超过当前合计持仓；② 按 `tradeDate`（同日按 `createdAt`）重放后任一时刻累计份额不得为负（即不允许把卖出日期倒填到买入之前）。任一不满足返回 **409 CONFLICT**，错误文本区分两种情形；买入恒放行 |
| DELETE | `/api/assets/:id/transactions/:txId` | 删除一笔交易并重算持仓 → `AssetDetail`。若删除后会出现"没有对应买入的卖出"（任一时刻累计份额 < 0），返回 **409 CONFLICT** 并拒绝删除 |
| POST | `/api/assets/refresh` | 刷新所有持仓的最新价与 sparkline → `{ updated, failed }` |
| POST | `/api/assets/analyze` | **AI 资产分析**（SSE）：逐项分析每只持仓（财报/基本面/宏观/微观/国际局势…），写回 `aiSummary`，并生成 Dashboard 简报 |
| GET | `/api/assets/analyze/last` | 最近一次资产分析运行 `AgentRunSummary \| null` |

**持仓计算规则（服务端唯一实现）**：以 `transactions` 为准，采用移动加权平均成本法。
`shares = Σbuy.shares − Σsell.shares`；卖出时 `realizedPnl += (sell.price − avgCost) × sell.shares`；
`cost = shares × avgCost`；`marketValue = shares × price`；`unrealizedPnl = marketValue − cost`。
`firstBuyAt/lastBuyAt/lastSellAt` 取对应交易的 `tradeDate` 极值。`closed = shares <= 0`。

## 5. 我的标的（/api/watchlist）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/watchlist` | `WatchlistListResponse`（`{ items, total, counts: { active, retired } }`），支持筛选/排序/搜索；`?status=active\|retired\|all`，**默认 `active`** |
| POST | `/api/watchlist` | 入参 `CreateWatchItemInput`；自动补全名称并记录 `initialPrice` |
| GET | `/api/watchlist/:id` | `WatchlistDetail`（持仓信息、交易记录、分红） |
| PATCH | `/api/watchlist/:id` | 入参 `UpdateWatchItemInput`（备注/优质评估/目标价/预期收益/预期期限/逻辑） |
| POST | `/api/watchlist/refresh` | **刷新行情**：拉取池内标的的现价/昨收/当日涨跌/走势 → `{ updated, failed, warnings }`；行情源不可用时如实返回 `updated:0` + warning，不伪造数值 |
| DELETE | `/api/watchlist/:id` | `{ ok: true }`（用户手动删除不受淘汰护栏限制） |
| DELETE | `/api/watchlist` | **清空标的** → `{ ok: true, deleted: number }` |
| POST | `/api/watchlist/:id/restore` | **复活**：清空 `status/retiredReason/retiredAt/retireStreak` → `WatchItem` |
| POST | `/api/watchlist/analyze` | **AI 标的分析**（SSE）：按投资性格搜索/筛选/创建新标的，更新既有标的，并复核淘汰（见 §5.1） |
| GET | `/api/watchlist/analyze/last` | 最近一次标的分析运行 `AgentRunSummary \| null` |

### 5.1 自选标的淘汰（P3）

`WatchItem` 增加了四个字段：`status`（`active` 在池 / `retired` 已退役）、`retiredReason`、
`retiredAt`、`retireStreak`（连续被确认退役的次数）。

- Agent 通过 `retire_watch_item` **软淘汰**（必须给出原因），每次确认 `retireStreak += 1`；
  用 `upsert_watch_item` 重新写入分析结论即**自动复活**（`status=active`、次数清零）。
- 标的分析流水线在模型跑完后执行确定性清理：`retireStreak >= settings.watchlistRetireDeleteRuns`
  （默认 3，**0 = 只标记不删除**）时才通过系统工具 `delete_watch_item` 删除，且删除同样走
  工具策略（`toolPolicy.deny` / 写入审批）与审计。
- **永不自动删除**的三种情况：当前有持仓（净份额 > 0，且会自动复活）、`source=manual` 的人工录入、
  存在 `pending` 建议引用该标的。
- 退役标的不参与建议生成与候选挖掘（`listWatchlist()` 默认只返回在池标的）；
  备份/导出会带上退役记录，恢复后状态一致。


### 5.2 行情刷新与「推荐后涨跌」

`WatchItem.changeSinceAdded(Pct)` = 现价 − 推荐时价格。此前价格只在「AI 标的分析」开跑时顺带刷新，
两次分析之间该值恒为 0。现在：

- `POST /api/watchlist/refresh` 提供随取随新的入口（界面进页面时若行情超过 5 分钟未更新会自动调一次，
  也可以手动点「刷新行情」）；
- 列表展示「行情更新于 …」，用户能判断数据新旧；
- 离线（`AIA_OFFLINE=1`）或数据源不可用时返回 `failed=N` + warning，**不写任何价格**，
  「推荐后涨跌」保持 0 而不是编造数值。

### 5.3 候选覆盖度（CN / HK / US × 股票 / 场内基金 / 场外基金）

标的分析的提示词会带上**当前池子的市场与类型分布**，并明确要求补齐为 0 的市场与类型
（预算本就覆盖 CN/HK/US 三地）。跳过某个市场或类型时必须在报告里写明原因。

类型判定修正：东财 suggest 对场外基金返回 `SecurityTypeName='基金'`，旧代码一律判成 `etf`；
而 A 股同代码可能是股票（`000001` 场外基金「华夏成长」vs 股票「平安银行」），
按 `etf` 查报价会**静默命中股票**并写入错误价格。现在按 `Classify/JYS = 'OTCFUND'` 判为 `fund`。

## 6. AI 投资建议（/api/advice）

`AdviceItem` 增加 `origin`（`holding` 持仓 / `watchlist` 我的标的 / `external` 池外）：
由 `assetId`/`watchItemId` 推导，写入时 `create_advice` 会按 `code+market+type` 反查回填链接，
因此「池外」意味着该建议**跳过了「AI 标的分析」的质量分门槛**，界面据此提示用户先复核。
标的的 `expectedReturn` 旁边新增 `expectedReturnHorizon`（预期多久到达，自由文本，≤40 字）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/advice` | `{ items: AdviceItem[], budget: BudgetStatus }`；`?status=pending\|confirmed\|rejected` |
| POST | `/api/advice/generate` | **AI 投资建议**（SSE）：先跑资产分析 → 标的分析 → 汇总生成建议（受预算约束） |
| POST | `/api/advice/:id/reject` | 驳回（本次不采纳）→ `AdviceItem`（`status=rejected`） |
| POST | `/api/advice/:id/confirm` | 入参 `ConfirmAdviceInput`（实际份额/单价/日期）→ `{ advice: AdviceItem, asset: AssetDetail }`，写入交易并更新持仓。**与 `/api/assets/:id/transactions` 同源校验**：卖出份额超过持仓、或卖出日期早于可用持仓形成时间 → **409 CONFLICT** |
| GET | `/api/advice/last` | 最近一次建议生成运行 `AgentRunSummary \| null` |
| GET | `/api/advice/outcomes` | **建议结果追踪**（只读）：`{ items: AdviceOutcome[], stats: AdviceOutcomeStats }` |
| POST | `/api/advice/outcomes/track` | 重算一次追踪 → `{ items, stats, tracked: AdviceOutcomeTrackResult }` |
| GET | `/api/budget` | 当月各市场预算使用情况 `BudgetStatus` |

### 6.1 建议结果追踪（确定性，不经过 LLM）

回答「AI 的建议到底对不对」，口径必须可核对（`services/advice-outcomes.ts`，物化在 `advice_outcomes` 表，
**可随时删表重建，结果一致**）：

| 口径 | 规则 |
| --- | --- |
| 基准价 | **建议日之后第一个交易日**的收盘价。刻意跳过建议当日，避免用当日收盘造成前视偏差 |
| 方向调整收益 `adviceReturnPct` | 买入=涨幅，卖出=**跌幅**（正数代表「建议方向对」）。它衡量模型方向准确度，**不等于用户真实盈亏**（用户可能没执行） |
| 超额 `excessPct` | `adviceReturnPct − benchmarkChangePct`，基准与标的用同一锚定规则、同一段序列 |
| 基准 | A股 `000300` 沪深300；港股 `02800` 盈富基金（恒生指数 ETF）；美股 `SPY`（标普500 ETF）。港股/美股上游指数序列不可用（实测 HSI 502、SPX 404），故用跟踪同一指数的 ETF 代理，界面如实标注 |
| 可度量门槛 | `samples >= 2`（至少一个「之后」的交易日）。不足者计入 `unmeasured`，**不进胜率分母** |
| 观测窗口 | 90 自然日，到期冻结为 `status='expired'`，不再随行情漂移 |
| 触发 | 界面「刷新追踪」按钮，或调度器 tick（`mode != off` 时每次顺带跑一次）。失败只降级为 `warnings`，不 5xx |

**预算规则**（2026-10 修订，口径唯一）：
- `spent` = 该市场**本月买入成交额**（gross，不含手续费，按市场本位币计）。
- **卖出不释放预算**：否则同月内可通过反复买卖无限"解锁"预算，预算约束形同虚设。
- `remaining = budget − spent`，**可以为负**（前端负责把进度条 clamp 到 0–100%）。
- **`exhausted = remaining <= 0`**：因此 `budget = 0` 立即视为「本月不投」（想要"不限"请填一个很大的数），已超支的市场同样为 `true`。
- `usedPct = budget > 0 ? spent / budget × 100 : 100`。
- `exhausted` 的市场，服务端在生成建议时**不再产出该市场的买入建议**（卖出建议不受限）。
- `enforceBudget=false` 时仅关闭"拒绝买入建议"的门槛，数字口径不变。

## 7. AI Chat（/api/chat）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/chat/sessions` | `ChatSession[]` |
| POST | `/api/chat/sessions` | 创建会话 → `ChatSession` |
| DELETE | `/api/chat/sessions/:id` | 删除会话及其消息 |
| GET | `/api/chat/sessions/:id/messages` | `ChatMessage[]` |
| POST | `/api/chat/sessions/:id/messages` | 入参 `{ content: string }`，**SSE 流式响应**：`text` 增量 + `tool-call`/`tool-result` + `run-finished`。AI 可通过工具读写资产、标的、建议、设置 |

## 8. 行情与信息（/api/market）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/market/search?q=&market=` | `InstrumentSearchResult[]`（代码→名称自动补全） |
| GET | `/api/market/quote?market=&code=` | `Quote` |
| GET | `/api/market/series?market=&code=&type=&range=&interval=` | `SeriesResponse`（股票/场内基金 K 线；场外基金净值曲线） |
| GET | `/api/market/profile?market=&code=&type=` | `ProfileResponse`（行情 + 基本面 + 基金详情 + 分红） |
| GET | `/api/market/financials?market=&code=&type=&periods=` | `FinancialsResponse`：财报三表多期（`periods` 1-8，默认 4）。ETF/基金返回 `applicable:false`（200，不是错误）；股票取不到任何报表才 404/502。报表级缺失用 `statements[].available=false` + `reason` 表达 |
| GET | `/api/market/detail?market=&code=&type=&range=&interval=` | 上面三者的聚合（详情浮窗一次拉全），`{ series, profile }` |
| GET | `/api/market/indices` | 全球指数快照 `Quote[]` |
| GET | `/api/market/macro` | 宏观 + 指数 + 要闻 `MacroSnapshot` |
| GET | `/api/market/news?q=` | `NewsItem[]` |

## 9. Agent 运行记录（/api/agent）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/agent/runs?limit=20&kind=` | `AgentRunSummary[]` |
| GET | `/api/agent/runs/:id` | `AgentRun`（含步骤时间线） |
| GET | `/api/agent/tools` | 已注册工具清单 `{ name, description, parameters }[]` |
| POST | `/api/agent/run-now` | 手动触发一次完整流水线（SSE，等价于 advice/generate） |

### 9.1 AI 流水线互斥

调度器的定时 tick 与 4 条手动 SSE 入口（`POST /api/assets/analyze`、`POST /api/watchlist/analyze`、
`POST /api/advice/generate`、`POST /api/agent/run-now`）共享同一把**非阻塞锁**
（`packages/server/src/services/pipeline-lock.ts`）。同一时刻只允许**一条**流水线运行：

- 锁被占用时，手动入口**立即**返回 `error`（消息含「已有 AI 流水线正在运行，请稍后再试」）
  + `run-finished(status="error")` + `done`，且**不写库、不新建 run**；
- 调度器的定时触发在锁被占用时**跳过本次**（记日志，不排队）；
- `/api/chat/*` 有意**不在**锁内：交互式对话不应被动辄数十秒的流水线阻塞；
  其写操作仍受工具白名单与账本一致性校验约束，但可能与该批次流水线并发写入
  —— 单用户自托管场景可接受。

### 9.2 工具策略、写入审计与人工审批（P1-1）

工具按风险分级：`read`（只读本地数据）、`external`（访问公网：`web_search`/`fetch_url`/`get_news`/MCP 工具）、`write`（改库）。
`GET /api/agent/tools` 的每一项都带 `risk`，MCP 工具额外带 `source`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/agent/audit?limit=&risk=&outcome=&runId=` | 写入/执行审计流水（**裸数组** `AuditEntry[]`，默认 100，上限 500） |
| GET | `/api/agent/pending?status=` | 待审批的写入（裸数组 `PendingWrite[]`） |
| POST | `/api/agent/pending/:id/approve` | 真正执行该写入 → `{ pending, result }`；未知 id → 404，非 pending → 409 |
| POST | `/api/agent/pending/:id/reject` | 入参 `{ reason? }`，标记驳回（不执行）→ `{ pending }` |

设置项（`Settings.toolPolicy`）：
- `deny: string[]` —— 被禁用的工具；模型调用时得到结构化拒绝（`policy_denied`），不会执行。
- `requireWriteApproval: boolean` —— 打开后，**所有 `write` 级工具调用不会立即落库**，而是写入 `pending_writes`
  并告诉模型"已提交人工审批"；由用户在界面批准后才真正执行（批准会写审计，`outcome=executed`）。

审计字段：`at / runId / sessionId / tool / risk / outcome(executed|denied|deferred|failed) / entity / entityId / summary / args`。

### 9.3 MCP 服务器（P1-2）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/mcp/servers` | 裸数组：`{ id, name, transport, enabled, connected, toolCount, tools[], error }` |
| POST | `/api/mcp/servers/:id/test` | 用当前配置现场连接并 `tools/list` → `{ ok, toolCount, tools, error }` |
| POST | `/api/mcp/reload` | 全部重连 → `{ reloaded, failed }` |

设置项 `Settings.mcpServers: McpServerConfig[]`（`transport: 'stdio' | 'http'`）。
MCP 工具以 **`mcp__<serverId>__<toolName>`** 命名并自动出现在 LLM 工具表中，风险级别 `external`。
`GET /api/settings` 与备份导出会把每个 server 的 `env` **值置空**（键名保留），避免把令牌带出去。

### 9.4 轨迹回放与续跑（P1-3）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/agent/runs/:id/trace` | `AgentTrace`：`{ run, messages, steps, audit, pendingWrites }` |
| POST | `/api/agent/runs/:id/resume` | **SSE**：从该 run 的持久化消息轨迹继续推理；`status==='done'` → 409 |

每个 run 的完整消息序列（system/user/assistant/tool，含 tool_calls 与 tool_call_id）都持久化在
`agent_run_messages`，因此轨迹可回放、被中断或被轮次上限截断的 run 可以续跑（续跑会新开一条 run 行，
标题标注「（续跑 <原 runId 前 8 位>）」）。续跑同样受流水线互斥锁保护。

## 10. 备份与恢复（/api/backup）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/backup/export` | 返回 `BackupPayload`，并带 `Content-Disposition: attachment` |
| POST | `/api/backup/import` | 入参 `{ data: BackupPayload, mode?: 'merge' \| 'replace' }` → `ImportResult` |
| GET | `/api/backup/files` | 服务端 `data/backups` 下的导出列表 |
| POST | `/api/backup/files` | 在服务端生成一份快照文件 → `{ name, size, createdAt }` |
| GET | `/api/backup/files/:name` | 下载指定快照 |
| POST | `/api/backup/clear` | **一键清除所有数据**（设置页「危险操作」）→ `ClearDataResult`；入参 `{ keepSettings?: boolean }`（默认 `true`）；AI 流水线运行中返回 **409** |

### 10.1 一键清除所有数据

`POST /api/backup/clear` 在**单个事务**内清空 `assets / transactions / watchlist / advice /
advice_outcomes / agent_runs / agent_steps / agent_run_messages / chat_sessions / chat_messages /
audit_log / pending_writes / kv`，返回逐表删除行数（`ClearDataResult`，另含总行数 `deleted`）。

- `keepSettings` 省略或 `true`：设置行完全不动 —— LLM / 数据源 API Key、投资性格、预算与定时任务都保留，清完可立即继续使用；
- `keepSettings: false`：设置恢复为**出厂默认**（等价于全新数据库：清空全部 Key、投资性格与预算回默认、定时任务清空为 `[]`），并刷新数据源缓存与调度器；
- 两种情况下 `last_run_at` 都会被清空（它指向的 run 已不存在）；
- AI 流水线正在运行时拒绝执行（**409**），否则 run 结束后会把数据重新写回来；
- 磁盘上的备份快照（`data/backups`）**不删除**，这是不可撤销操作的恢复后路。

## 11. 远程诊断（/api/diagnostics）

远程部署（NAS 等无法随手进容器看日志的环境）用这两个接口把「现场」一次取走：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/diagnostics/logs?limit=200&level=warn` | `{ count, records: LogRecord[] }`；`level` 可选，按 `trace/debug/info/warn/error/fatal` 下限过滤 |
| GET | `/api/diagnostics/report?logs=100&probe=1&runs=10&providers=eastmoney,tencent` | 完整现场（见下） |

`LogRecord` = `{ seq, at, level, msg, raw }`，来自进程内的**日志环形缓冲**（最多 1000 条）：
`buildApp()` 把 pino 输出同时写 stdout 与这个缓冲区，所以即使 Docker 的 json-file 日志
（10MB × 3）已经轮转掉，最近日志仍在。`LOG_LEVEL=silent` 时缓冲区为空。

`GET /api/diagnostics/report` 返回：

| 字段 | 内容 |
| --- | --- |
| `app` | version / uptimeSec / node / platform / timezone / logLevel / dataDir / dbPath / webBuilt |
| `llm` | `baseUrlHost`（只给 host，避免 query 里的 token 泄漏）、`model`、`keyConfigured`、`keySource` |
| `sources` | **实时探测**结果 `ProbeResult[]`（默认探测零 Key 核心链路：eastmoney / tencent / eastmoney-macro / eastmoney-news / eastmoney-fund / bing），`?probe=0` 可跳过 |
| `indices` | `{ count, sources, warnings }` —— 与 `get_macro` **同一条代码路径**（东财优先、腾讯兜底），失败原因（HTTP 502 / 超时 / 连接重置）在这里可见 |
| `macro` | `{ itemCount, indexCount, warnings, notes }`；`warnings` 是真实故障/降级，`notes` 是已知覆盖缺口（如社会融资规模无零 Key 上游） |
| `runs` | 最近 run 摘要 + `trace` 路径（`GET /api/agent/runs/:id/trace` 取完整轨迹） |
| `logs` | 最近日志（同 `/api/diagnostics/logs`） |

**不返回任何 API Key**：LLM 与数据源 Key 只报「是否已配置」。每条链路独立降级，
一次探测失败不会把整份报告变成 500。

## 12. 前端路由

| 路径 | 页面 |
| --- | --- |
| `/` | Dashboard |
| `/assets` | 我的资产 |
| `/watchlist` | 我的标的 |
| `/compare` | 财报对比（2-4 个标的并排看关键财务指标 + 三表明细） |
| `/advice` | AI 投资建议 |
| `/chat` | AI Chat |
| `/activity` | 活动与审计 |
| `/settings` | 设置 |

生产模式下由服务端 `@fastify/static` 提供 `packages/web/dist`，并对非 `/api` 的 404 回退到 `index.html`。
