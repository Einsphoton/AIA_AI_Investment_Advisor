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
    "runAssetAnalysis": true, "runWatchlistAnalysis": false, "runIpoAnalysis": true, "runAdvice": true },
  { "id": "sched_weekend", "name": "周末挖标的", "enabled": false, "mode": "interval",
    "intervalMinutes": 360, "dailyTime": "08:30",
    "runAssetAnalysis": false, "runWatchlistAnalysis": true, "runIpoAnalysis": false, "runAdvice": false }
]
```

| 规则 | 说明 |
| --- | --- |
| 替换语义 | `PUT /api/settings` 里 `schedules` **整体替换**（与 `mcpServers` 相同）；省略该字段 = 保持不变；`[]` = 删光所有任务并停止排程 |
| 每条任务 | `id`（稳定标识，`[A-Za-z0-9_-]{1,40}`，同一数组内不可重复）、`name`、`enabled`（停用后配置保留但不排程）、`mode`（`interval` \| `daily`，**没有** `off`）、`intervalMinutes`（≥1，从上次跑完起算）、`dailyTime`（`HH:mm` 本地时间）、四个步骤开关（资产 / 标的 / **打新** / 建议） |
| 校验 | `dailyTime` 必须是合法的 24 小时时间（`25:99` → 400）；四个步骤**至少选一个**（全关的任务没有任何意义 → 400）；`id` 重复 → 400；最多 20 个任务 |
| 生效 | 保存后调度器立即 `reload()`，无需重启；同一时刻到期的多个任务**合并成一次运行**（步骤取并集），跑完各自重排 |
| 旧库 / 旧备份 | 旧库的 `schedule_*` 单任务列在读取时迁移成「一个任务」（`mode='off'` → 空数组）；旧备份里的 `settings.schedule` 对象同样兼容；写回时旧列会同步第一个启用任务，方便回滚到旧版本 |
| 打新步骤默认开 | 旧任务/旧备份里没有 `runIpoAnalysis` 时按 **`true`** 补（多一步不破坏任何已有数据；只想省钱可在设置页关掉） |
| 观察 | `GET /api/dashboard` 的 `signals.scheduleEnabled`（是否至少有一个启用任务）、`signals.nextRunAt`（最近一次）与 `signals.nextRuns[]`（`{id,name,nextRunAt}`，按时间升序）来自**实时调度器**；设置页据此逐个任务显示下次运行时间 |
| **失败自动续跑** | 定时流水线失败后按错误类型决定是否续跑：可重试（429 / 5xx / 网络 / 超时 / 空回复 / 轮次上限 / 进程中断）自动从持久化轨迹续跑，第 1/2/3 次分别在 **约 2 / 10 / 30 分钟（±15% 抖动、下限 30 秒）**后，最多 **3 次**；不可重试（未配 Key、401/403/402、404、用户取消、无轨迹）不续跑。计划存 `kv`（`scheduler:autoRetry`），重启不丢，进程启动后 ~45 s 自愈被中断的定时流水线。因此 `signals.nextRunAt` / `nextRuns[]` 在有续跑待执行时**会包含合成项 `自动续跑 · 第 N/3 次`**（不是下个定时点）。查询接口 `GET /api/agent/retry`（§9.5）；**恒为开启、没有设置开关**。手动运行的失败语义不变 |

## 3. 仪表盘（/api/dashboard）

- `GET /api/dashboard` → `DashboardPayload`
  - `portfolio`：**第一板块**（总市值/总成本/浮动盈亏/已实现盈亏，统一折算为 CNY，`fxRates` 为折算率）
  - `portfolio.performance`（`PortfolioPerformance`）：**当年年化收益**，Dashboard 第一行的「年化收益率 / 已实现年化收益率」直接读它
    - `annualizedPct` = **XIRR（资金加权，实际天数/365）**：期初（上一年最后一天）持仓市值按各自 ≤ 该日的**最后收盘价**估值，
      叠加当年每笔买卖的真实现金流（买入含费 / 卖出扣费），期末取当前总市值。**不是**「收益率 ÷ 天数 × 365」的外推
    - `realizedAnnualizedPct` = 只算**当年卖出**部分：账面成本（移动加权平均，含分摊买入费用）锚定在这些份额的**加权平均买入日**
    - **不足 30 天（`MIN_ANNUALIZE_DAYS`）一律不年化**：几何年化对短区间极度敏感（持有 1 天亏 0.45% → 年化 −80%；涨 1% → 年化 +3678%），
      那不是收益，而是把一天的噪声外推成一年。此时 `annualizedPct = null`、`annualizedReliable = false`，改用
      `cumulativePct`（区间累计收益率 = `(期末市值 + 卖出净额 − 买入含费 − 期初市值) / (期初市值 + 买入含费)`）展示；
      `notes` 会同时写明「强行年化会是多少」。`cashFlowDays` = 当年**实际有资金**的天数（首笔 → 末笔现金流，不是自然年长度）。
      已实现部分同理：`realizedAnnualizedReliable === false` 时用 `realizedCumulativePct`（已实现累计收益率）兜底
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

**与打新的关系**：流水线多了一步「打新分析」（可在定时任务里单独开关，见 §2），并且汇总提示词里带上
当前在招的新股与用户已登记的申购，要求模型把「打新占用现金」与月度预算一起考虑。打新结论**不写成
`advice` 行**（建议确认会直接写资产，不适合承载「建议申购」这类尚未成交的标的），而是落在
`ipo_offers.advice / verdict / verdictReason / suggestedShares / winProbability / expectedReturn`，由 `/ipo` 页与建议页的
「打新建议」板块呈现（见 §12）。建议页只列**未被建议放弃**的在招标的（放弃的不会占用当月现金，
只报个数），并可从每行直接打开登记浮窗回报申购 / 中签；建议页与 `/ipo` 页都有「推荐理由」一列，
直接显示 AI 写的一句话理由（`verdictReason`），老数据自动从建议正文的结论首句提取。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/advice` | `{ items: AdviceItem[], budget: BudgetStatus }`；`?status=pending\|confirmed\|rejected` |
| POST | `/api/advice/generate` | **AI 投资建议**（SSE）：先跑资产分析 → 标的分析 → **打新分析** → 汇总生成建议（受预算约束） |
| POST | `/api/advice/:id/reject` | 驳回（本次不采纳）→ `AdviceItem`（`status=rejected`） |
| POST | `/api/advice/:id/confirm` | 入参 `ConfirmAdviceInput`（实际份额/单价/日期）→ `{ advice: AdviceItem, asset: AssetDetail }`，写入交易并更新持仓。**与 `/api/assets/:id/transactions` 同源校验**：卖出份额超过持仓、或卖出日期早于可用持仓形成时间 → **409 CONFLICT**。仅用于股票建议：`instrument='option'` 的建议一律 **400** 并指向下面的期权端点 |
| POST | `/api/advice/:id/confirm-option` | **期权建议专用**：入参 `ConfirmOptionAdviceInput`（张数/每股价权利金/到期日/行权价/费用/日期）→ `ConfirmOptionAdviceResult`，创建 `option_contracts` 合约。**不写股票流水**（权利金与交割体现见 §13） |
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
| GET | `/api/agent/retry` | **定时流水线自动续跑**的待执行状态：`{ pending: { kind, attempt, maxAttempts, nextRunAt, failedRunIds, taskNames, lastError } \| null, maxAttempts: 3 }`；无待执行续跑（或进程里没有调度器）时 `pending: null`。语义与失败分类见 §9.5 |

### 9.1 AI 流水线互斥

调度器的定时 tick 与 5 条手动 SSE 入口（`POST /api/assets/analyze`、`POST /api/watchlist/analyze`、
`POST /api/ipo/analyze`、`POST /api/advice/generate`、`POST /api/agent/run-now`）共享同一把**非阻塞锁**
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
| POST | `/api/agent/runs/:id/resume` | **SSE**：从该 run 的持久化消息轨迹继续推理；`status==='done'` → 409；**已由系统自动续跑成功**的 run（`error` 带 `已自动续跑` 标记）同样 **409**，避免拿同一份轨迹重复烧 token |

每个 run 的完整消息序列（system/user/assistant/tool，含 tool_calls 与 tool_call_id）都持久化在
`agent_run_messages`，因此轨迹可回放、被中断或被轮次上限截断的 run 可以续跑（续跑会新开一条 run 行，
标题标注「（续跑 <原 runId 前 8 位>）」）。续跑同样受流水线互斥锁保护。

续跑默认拿到**与全新运行相同的轮次预算**（`AGENT_RESUME_TURNS` = `AGENT_MAX_TURNS`）。预算/步数真的用尽、
模型又一句话正文都没写出来时，循环会**追加一次不带任何工具的「收尾作答」调用**（步骤时间线里出现「收尾作答」）：
要求它基于已经拿到的工具结果直接输出结论。成功时 `status='done'`，`summary` 末尾标注
「本次运行已用尽推理预算（N/N 轮），结论由收尾作答给出，可能未完全收敛」；收尾仍拿不到正文时按失败收场，
错误文案区分「达到最大推理轮次」「达到步数上限」「模型返回了空结论」三种情况（不再把空结论误报成轮次上限）。

### 9.5 定时流水线自动续跑（失败自愈）

调度器触发的流水线（`POST /api/agent/run-now` 等**手动**入口不在此列）失败后不再只记一条日志、等下个定时点
（每日任务等于要等到第二天）：`services/auto-retry.ts` 会把可重试的失败转成一次续跑计划，持久化在 `kv`
（`scheduler:autoRetry`），并与手动「一键续跑」走**同一条 resume 路径** —— 从 `agent_run_messages` 的持久化
消息轨迹继续，**不重跑已完成的阶段**。

| 规则 | 说明 |
| --- | --- |
| 可重试 | LLM 429 / 5xx / 网络 / 超时 / 客户端内重试后仍空回复、轮次上限（`达到最大推理轮次`）、进程中断（`运行被中断…`）、未知瞬时错误 |
| 不重试 | 未配置 API Key（`未配置 API Key`）、401 / 403、402（余额与订阅）、模型或端点 404、用户取消（`已取消`）、没有持久化轨迹；**例外**：若整个续跑任务是 `resume` 且所有阶段都报无轨迹，调度器会改判为 `kind='pipeline'` 整条重跑一次，而不是就此停止 |
| 重试节奏 | 第 1 / 2 / 3 次分别在失败后 **约 2 / 10 / 30 分钟（±15% 抖动、下限 30 秒）**，最多 **3 次**；3 次用完即静默停止（只写日志），失败 run 仍显示在「活动与审计」页，手动续跑照旧可用 |
| 重启自愈 | 启动时 `failStaleRuns` 仍先把被进程退出打断的 run 标成 `error`（保留已花 token）；启动前标记在 `kv:scheduler:inFlight` 的定时流水线会在启动后 ~45 s 自愈 —— 有轨迹的 stale `error` run 直接续跑，并补跑这一轮未执行的阶段（已完成的阶段与续跑成功的阶段都会跳过），没有轨迹则整条流水线重跑一次（同样跳过已完成的阶段） |
| 计划可见 | `Scheduler.nextRunAt()` / `plan()` 在有续跑待执行时插入合成项 `自动续跑 · 第 N/3 次`，因此界面「下次运行」显示的是续跑时间而不是下个定时点（`/api/dashboard` 的 `signals.nextRunAt` / `nextRuns[]`、设置页列表一并生效） |
| 并发 | 续跑与手动流水线共用同一把非阻塞锁：到期时锁被占用则顺延 ~2 分钟，**不消耗重试次数** |
| 手动语义 | 手动入口失败**不会**自动续跑，仍旧 SSE `error` + `run-finished(status='error')` 直接报给用户，「一键续跑」仍要人工点；但自动续跑成功后，原失败 run 的 `error` 会被追加 `（已自动续跑：第 N/3 次，新运行 <8 位 id>）`（`status` 保持 `error`、已花 token 不回滚），此时 `POST /api/agent/runs/:id/resume` 对该 run 返回 **409**（`已由系统自动续跑成功，无需再次续跑`），前端「未完成」提示条也会过滤掉它、不再劝你重复续跑 |

`GET /api/agent/retry`（只读）：

```json
{
  "pending": {
    "kind": "resume",
    "attempt": 1,
    "maxAttempts": 3,
    "nextRunAt": "2026-10-19T02:32:00.000Z",
    "failedRunIds": ["...uuid..."],
    "taskNames": ["工作日盘前"],
    "lastError": "..."
  },
  "maxAttempts": 3
}
```

- `pending` 为 **`null`** 表示当前没有排队的续跑；进程里没有调度器时同样返回 `{ "pending": null, "maxAttempts": 3 }`；
- `kind`：`resume`（从轨迹续跑失败的 run）或 `pipeline`（没有轨迹、整条流水线重跑）；
- `attempt` 是**即将执行**的那次（1-based，`1` 表示第 1/3 次）；`nextRunAt` 为 ISO 8601 字符串；
- `failedRunIds` 是被续跑/重跑的失败 run；`taskNames` 是触发它的定时任务名；`lastError` 是原始失败文案（可能为空）。

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

## 12. 新股打新（/api/ipo）

新股信息、AI 申购建议与「中签自动入账」的完整闭环（界面：`/ipo`）。数据来源与字段口径见
`docs/SOURCES.md §8`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/ipo?market=&status=&q=&limit=` | `IpoListResponse`：`{ items, total, counts, lastRefreshAt, warnings }` |
| POST | `/api/ipo/refresh` | 抓取 A股/港股/美股新股 → `IpoRefreshResult`；入参 `{ markets?: ('CN'\|'HK'\|'US')[], limitPerMarket? }` |
| POST | `/api/ipo` | 手工录入/修正一只新股 → `IpoOffer`（上游缺数据时的兜底） |
| GET | `/api/ipo/:id` | 详情 → `IpoOffer`（`:id` 可用内部 id 或 uid，如 `HK:06157`） |
| DELETE | `/api/ipo/:id` | 删除标的（连带删除申购登记，**不动**账本） |
| POST | `/api/ipo/:id/subscribe` | 登记「我申购了 N 股」→ `IpoOffer`；入参 `{ shares, price?, note?, appliedAt? }` |
| DELETE | `/api/ipo/:id/subscription` | 撤销登记 → `IpoOffer`（已中签入账的返回 **409**） |
| POST | `/api/ipo/:id/allot` | 登记中签结果 → `IpoAllotResult`；入参 `{ shares, price?, fee?, tradeDate?, note? }` |
| POST | `/api/ipo/analyze` | SSE：跑 `ipo-analysis` 流水线（AI 打新分析），事件与 `/api/assets/analyze` 同构 |
| GET | `/api/ipo/analyze/last` | 最近一次打新分析摘要（没有则 `null`） |

### 12.1 状态与结论口径

`IpoMarketStatus`（**由日期推导，不存「手选状态」**）：

| 值 | 含义 | 推导规则（`deriveIpoStatus`） |
| --- | --- | --- |
| `upcoming` | 待申购 | 有申购开始日且尚未到 |
| `subscribing` | 申购中 | 今天 ≤ 申购截止日 |
| `allotted` | 待上市 | 申购已截止但还没上市（有上市日/中签日即算） |
| `listed` | 已上市 | 上市日 ≤ 今天 |
| `unknown` | 状态未知 | 上游没给任何日期（不猜） |

`IpoOffer.verdict` 由 AI 打新分析写入，取值 `subscribe` / `neutral` / `avoid`，并附
`verdictReason`（一句话理由，8–80 字）、`suggestedShares`（必须是每手股数的整数倍）、`confidence`、
`qualityScore`、`advice`（Markdown）。

**`verdict` 是「本期该不该打」，不是「股票好不好」**（这是界面最容易误解的地方）：

| verdict | 含义 | `suggestedShares` |
| --- | --- | --- |
| `subscribe` | 标的值得 **且** 本期可执行（预算够、至少买得起一手） | 必须 ≥ 1 手 |
| `neutral` | 标的不算差、但本期不参与（**最常见：本月预算不足 / 一手入场费太贵**；也可能定价区间未收窄、等暗盘） | 恒为 0 |
| `avoid` | 标的不值得（定价 / 基本面 / 破发风险） | 恒为 0 |

因此「胜率 75% 却判 neutral」是合法组合 —— 但 `verdictReason` 必须写清绑定约束
（例：`本月 A 股预算仅剩 734 元，一手 500 股 × 16.98 元 = 8,490 元打不起（标的本身不差）`），
界面「推荐理由」列直接展示这句话，详情里有口径说明。`save_ipo_analysis` 会机械校验自洽性
（`bad_request`，避免出现用户无法理解的结论）：

1. `subscribe` 必须 `suggestedShares ≥ 1 手`，且 `winProbability ≥ 0.5`、`expectedReturn > 0`；
2. `neutral` / `avoid` 的 `suggestedShares` 必须为 `0`；
3. `avoid` 不允许出现在 `winProbability ≥ 0.6` 且 `expectedReturn > 0` 的标的上 —— 若因资金约束放弃，判 `neutral` 并写明缺口；若确实看空，把胜率/预期收益调到与结论同向；
4. `verdictReason` 必填（8–80 字，超长也拒绝）。

**建议必须给出胜率与预期收益**（`winProbability` / `expectedReturn`，两者都是 `save_ipo_analysis` 的必填参数，
缺失或 `advice` 正文里读不到这两个数会被驳回 `bad_request`）：

| 字段 | 单位 | 含义 | 与另一个指标的区别 |
| --- | --- | --- | --- |
| `winningRate` | % | 上游公告的**中签率** | 「能不能买到」——这是发行数据，随刷新更新 |
| `winProbability` | 0–1 | AI 推算的**胜率**（上市后正收益 / 不破发概率） | 「买到之后赚不赚」——这是结论，只由分析写入 |
| `expectedReturn` | % | AI 推算的**预期收益**（相对发行价的涨幅，可为负） | 破发预期写负数 |
| 期望值 | % | 界面派生：`winProbability × expectedReturn` | 只按「打中一手」算，**不含中签率**（避免被误读成每次申购的收益） |

三个结论字段（含 `verdictReason` / `suggestedShares`）都是**本地结论**：`POST /api/ipo/refresh` 只覆盖发行要素，
永远不会清空它们；未分析的标的返回 `0` / `''`，界面显示「未评估 / 待分析 / —」，不拿 0 冒充结论。
`save_ipo_analysis` 若收到 `winProbability = 65` 这类百分数写法，会折算为 `0.65` 并在返回里说明，
不会静默丢弃结论。

界面的打新颜色是**风险语义**（绿=值得下手、红=建议放弃），与行情「红涨绿跌」相反，
见 `styles.css` 的 `.badge-ipo-subscribe` / `.badge-ipo-avoid`。

「AI 投资建议」页（§5）的打新板块只列 `subscribing` / `upcoming` 且**未被建议放弃**的标的，
并支持直接打开登记浮窗回报申购 / 中签（复用 `/api/ipo/:id/subscribe`、`/api/ipo/:id/allot`）。

### 12.2 中签入账（`POST /api/ipo/:id/allot`）的关键约束

1. `shares > 0`：自动建（或复用）资产 + 写一笔 `kind='buy'`、`source='ipo'` 的流水，价格取入参
   `price`，缺省用发行价；`shares = 0` 记为 **未中签**，只改状态、**不写账本**。
2. **重复登记 = 修正**：删除上一次由打新流程写入的流水后按新股数重写（不会累加成两笔持仓）；
   若该资产期间已有卖出，返回 **409** 并提示先在「我的资产」里手工调整（避免账本出现无买入的卖出）。
3. 已按中签入账后再报 `shares = 0` 返回 **409**（必须先撤销资产，否则账本会凭空少一笔持仓）。
4. **不受预算闸门拦截**：中签缴款是已发生的真实现金支出，账必须记；只在超出该市场当月预算剩余时
   在 `warnings` 里提示。
5. 未定价（`issuePrice = 0` 且只有区间）时必须显式传 `price`，否则 **400** —— 绝不用 0 成本入账。
6. `subscription.assetId` 指向账本资产；`subscribeIpo` 拒绝已上市标的与超过申购上限的股数（**409**）。

## 13. 期权卖权（/api/options）

港股/美股**卖出期权收取权利金**的完整闭环（界面：`/options`）。数据来源与字段口径见 `docs/SOURCES.md §9`。

产品口径（顺序即优先级，写进了 `option-advice` 的系统提示词）：

1. **首要目标是安全地赚取权利金**：优先覆盖式卖 Call（用已持有的股票收租，不额外赌方向）；
2. **标的价格足够划算时才用现金担保卖 Put 收股**：被行权就是按行权价买入，必须真的是「愿意买的价格」；
3. 卖 Call 必须结合「我的资产」的实际持股与成本；
4. 到期后自动跟踪行权结果并更新「我的资产」——**结论明确才自动入账，存疑转「待确认」**。

架构定位：期权建议**复用 `advice` 表**（`instrument='option'`，方案细节存 `option_plan` JSON），
合约与到期结算另立 `option_contracts` / `option_settlements` 两张表。因此 `AdviceItem` 新增
`instrument` 与 `option` 两个必填字段，确认弹窗与入账路径按 `instrument` 分流。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/options/chain?market=&code=&maxExpiries=&refresh=` | `OptionChainSnapshot`：原始期权链（未经筛选），`asOf`/`delayed`/`source`/`warnings` 如实返回 |
| GET | `/api/options/candidates?market=&code=&limit=` | `OptionCandidatesResponse`：**确定性筛选**（不经过 LLM），含被挡掉的 `rejected` 与机器可读原因 |
| POST | `/api/options/analyze` | `202 {runId}`：跑 `option-advice` 阶段（AI 期权卖权建议）。**返回前会同步预取期权链**（港股每日报告 ≈ 6.7MB 约 30–60s；CBOE 单请求可达数分钟），期间请用「活动」页/`/api/agent/runs` 看进度；未配置 LLM 时 **400 `NOT_CONFIGURED`**。可分析范围 = 港股/美股持股（覆盖式卖 Call）∪ 任一市场有现金时的观察池标的（现金担保卖 Put，每市场最多 2 个）；请求体里的 `markets`/`codes` 只做校验与日志，**不改变范围** |
| GET | `/api/options/positions` | `OptionPositionsResponse`：在手合约 + 权利金/担保汇总 |
| GET | `/api/options/positions/:id` | `OptionPosition` |
| POST | `/api/options/positions` | 手工登记已成交的卖出合约（没有券商对接，计划外成交必须能补录） |
| POST | `/api/options/positions/:id/close` | 买平（平仓价/费用/日期/备注） |
| POST | `/api/options/positions/:id/settle` | 只评估该合约的到期结算 → `OptionSettlementRunResult` |
| GET | `/api/options/settlements?status=` | `OptionSettlementsResponse`（`pending_review` / `auto_settled` / `confirmed` / `dismissed`） |
| POST | `/api/options/settlements/scan` | 扫描全部已到期合约 → `OptionSettlementRunResult`；拿不到流水线锁时 **409** |
| POST | `/api/options/settlements/:id/confirm` | 人工确认判定（可改判 `assigned`/`otm_no_assignment` 并覆盖参考价）后入账 |
| POST | `/api/options/settlements/:id/dismiss` | 忽略该结算记录（不动账本） |
| POST | `/api/advice/:id/confirm-option` | 入参 `ConfirmOptionAdviceInput` → `ConfirmOptionAdviceResult`：创建合约，**不写股票流水** |

`POST /api/advice/:id/confirm`（股票路径）遇到 `instrument='option'` 的建议会返回 **400** 并指向
`/api/advice/:id/confirm-option`，绝不会把一张期权建议当股票买卖写进账本。

### 13.1 两个策略与担保口径

| 策略 | 含义 | 需要的担保 | 被行权后果 | 最坏情形 |
| --- | --- | --- | --- | --- |
| `covered_call` | 对已持有股票卖出 Call，收租 | 持仓股数 ≥ `乘数 × 张数`（美股 100/张；港股按合约规格） | 按行权价交出 `乘数 × 张数` 股 | 股票大涨被「卖飞」——仍拿到权利金 + 行权价的现金 |
| `cash_secured_put` | 用现金担保卖出 Put，愿意按行权价接货 | 可用现金 ≥ `行权价 × 乘数 × 张数`（原币） | 按行权价买入 `乘数 × 张数` 股 | 股价跌破行权价后浮亏，但成本已被权利金垫低 |

担保校验是**服务端硬拦**（`insufficient_shares` / `insufficient_cash` / `no_cash`），并且数字由服务端
自己从账本与设置里取，不采信模型或请求体里的声明。各市场可用现金由用户在设置页填写
（`settings.option.cash.HK/US`，填 0 时不会产出无法担保的卖 Put 建议，并明确提示去填写）。

### 13.2 确定性指标（服务端算，AI 只能引用不能改写）

| 指标 | 口径 |
| --- | --- |
| `premiumIncome` | `每股价权利金 × 乘数 × 张数 − 费用`（原币） |
| `staticYieldPct` | `premiumIncome / collateral × 100`（collateral = 被占用的现金或持股市值） |
| `annualizedYieldPct` | `staticYieldPct × 365 / max(1, 剩余自然日)`；已到期返回 0 并给 warning，**不做除零/负年化** |
| 安全垫 | 卖 Call：`(行权价 − 现价)/现价 × 100`；卖 Put：`(现价 − 行权价)/现价 × 100`（正数=虚值=更安全） |
| `assignmentProbability` | 美股用 `abs(delta)`；港股上游**没有** delta，用虚值幅度 + IV 做正态近似，并在 `warnings` 明确标注「估算」 |
| `liquidityScore` | 0–100，由价差百分比、未平仓、成交量合成；bid/ask 缺失（上游为 0）时不给高分并给 warning |
| `breakeven` / `maxProfit` / `requiredShares` | 见 `packages/shared/src/types.ts` 的字段注释 |

筛选规则集中在 `OPTION_SCREEN_RULES`（剩余天数 7–75、`|delta|` 0.08–0.35、未平仓 ≥ 50、
价差 ≤ 20%、年化 ≥ 6%、每张权利金 ≥ 20、每个标的最多 6 个候选）。**筛选规则只用于候选推荐**；
写建议工具对「持股/现金不足、到期日已过」这类零歧义算术硬拦，对期限/权利金越界只给 `warnings`
（避免误杀「故意选近月高权利金」的合法建议）。

### 13.3 到期结算与自动入账

| 环节 | 规则 |
| --- | --- |
| 扫描范围 | `status='open'` 且 `到期日 ≤ 今天` 的合约；定时器（启动后 ~30s，之后每 6h）与手工 `scan` 共用同一实现 |
| 参考价 | 美股：到期日（或之后第一个交易日）收盘价，取自既有行情源；港股：优先 HKEX 当日报告的官方**收市价**，取不到回退日线并给 warning。取不到任何价 → `uncertain` |
| 判定 | 实值额 `call = 参考价 − 行权价` / `put = 行权价 − 参考价`；`< minItmAmount`（0.01）→ `otm_no_assignment`；否则 `assigned`；`|参考价 − 行权价| / 行权价 × 100 < 0.5%` → `uncertain` + `pending_review` |
| 结算模式 | `settings.option.settlementMode`。`auto`=结论明确才自动入账；`manual`=全部转待确认（界面逐条确认） |
| 自动入账 | `covered_call` 被行权 → 写 `kind='sell'`、`source='option'`、价=行权价、股数=`乘数 × 张数` 的股票流水；`cash_secured_put` 被行权 → 写 `kind='buy'`、`source='option'`（真实现金支出，**不受当月预算闸门拦截**，与打新中签入账同理）。持股不足以交割时**不写流水**，转 `pending_review` 并写明缺口 |
| 幂等 | `option_settlements.contract_id` 唯一；重复扫描/重复确认不会重复写流水。判定与写入在同一 `repo.transaction` 内完成（中间无 `await`），定时扫描整体持流水线锁 |
| 记录可核对 | 每条结算记录都带 `referencePrice` + `priceSource` + 可读 `note`（判定依据），界面原样展示 |

**权利金与股票账本是两条线**（本应用没有现金账户，必须说清，否则用户会以为「收了权利金但资产没变」是 bug）：

| 事件 | 落到哪里 |
| --- | --- |
| 卖出开仓收到权利金 | 只记在 `option_contracts.premium_income`，由「期权卖权」页统计「权利金总收入 / 已实现权利金」。**不写 `transactions`**（没有现金账户，凭空写一笔股票流水会污染持仓） |
| 虚值到期（未被行权） | 权利金转为已实现（`realized_pnl = premium_income`），股票账本无变化 |
| 实值被行权（覆盖式卖 Call） | 写一笔 `kind='sell'`、`source='option'`、`price=行权价`、`shares=乘数×张数` 的股票流水 →「我的资产」持仓减少，`realized_pnl = 权利金 + 股票交割盈亏` |
| 实值被行权（现金担保卖 Put） | 写一笔 `kind='buy'`、`source='option'`、`price=行权价` 的股票流水（必要时自动建仓）→「我的资产」持仓增加，`realized_pnl = 权利金`（收股成本就是行权价） |
| 合约乘数缺失/为 0 | **不判定、不入账**，转「待确认」——交割股数算不出来时绝不猜 |

**「自动更新我的资产」的准确度边界**（必须让用户看到，不做过度承诺）：

1. 行情是**延迟/收盘**口径（CBOE 延迟链、HKEX 每日报告），不是券商实时结算价；
2. 没有券商接口，**系统不知道你是否真的被指派行权**——它按「实值 ≥ 0.01 即会被行权」的规则推算，
   真实结果以券商对账单为准（所以存疑会转「待确认」，并且可以手工改判/覆盖参考价）；
3. 美股期权是**美式**，存在到期前被提前行权的可能；港股实物交割，公司行动（拆股/合股）会改变合约规格；
4. 港股合约乘数只有核对过官方合约规格的标的才写进 `HK_OPTION_MULTIPLIERS`，其余按 100 估算并**明确 warning**。

## 14. 前端路由

| 路径 | 页面 |
| --- | --- |
| `/` | Dashboard |
| `/assets` | 我的资产 |
| `/watchlist` | 我的标的 |
| `/compare` | 财报对比（2-4 个标的并排看关键财务指标 + 三表明细） |
| `/advice` | AI 投资建议 |
| `/options` | 期权卖权（在手合约 · 权利金 · 到期结算） |
| `/ipo` | 新股打新（三地新股 · AI 申购建议 · 中签自动入账） |
| `/chat` | AI Chat |
| `/activity` | 活动与审计 |
| `/settings` | 设置 |

生产模式下由服务端 `@fastify/static` 提供 `packages/web/dist`，并对非 `/api` 的 404 回退到 `index.html`。
