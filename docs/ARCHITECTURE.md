# 架构说明（AI 投资顾问）

## 1. 技术选型与理由

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 运行时 | Node.js ≥ 22.5（Docker 镜像 `node:24-alpine`） | 与 DeepSeek Harness / opencode 同为 TS 生态，Agent Loop 可直接借鉴其设计；本机已具备 |
| 后端 | Fastify 5 + TypeScript (ESM) | 轻量、SSE 与流式友好、插件生态成熟 |
| 持久化 | 内置 `node:sqlite`（`DatabaseSync`） | **零原生依赖**，单文件数据库，轻量服务器友好；不需要 better-sqlite3 的编译链 |
| Agent | 自研 Agent Loop（`packages/server/src/agent`） | 参考 opencode / Harness 的「消息 → 工具调用 → 工具结果 → 再推理」循环，含会话、步骤时间线、token 统计、工具白名单与轮次上限 |
| LLM | 任意 OpenAI 兼容 `chat/completions` | 默认 DeepSeek，可切 OpenAI / Moonshot / Qwen / Ollama |
| 行情数据 | 东方财富 / 腾讯 / 天天基金 / Bing（全部零 Key） | 见 `docs/SOURCES.md`，实测可用；Key 型数据源作为可选增强 |
| 前端 | React 19 + React Router 7 + **Rollup 7 + TypeScript** + ECharts 6 | 图表（K 线/净值曲线）成熟；Rollup + tsc 均为纯 JS，构建产物由后端静态托管 |
| 构建 | `tsc`（Node 包）+ `Rollup`（前端，含 terser 压缩） | 纯 JS、零原生二进制：Windows/macOS/Linux/Alpine/受限 CI 行为一致（Vite/esbuild/tsx 会 spawn 原生子进程，在受限环境直接 EPERM） |
| 测试 | `node:test` + `scripts/run-tests.mjs`（同进程 import 编译产物） | 不用 `node --test <dir>`（它会为每个测试文件 spawn 子进程）；前端另有 `renderToString` 无头渲染测试 |
| 部署 | 单容器（API + 静态前端）+ docker-compose | 轻量服务器上 `docker compose pull && docker compose up -d` 直接拉 GHCR 预构建镜像（每次 push 由 Actions 自动发布多架构 amd64/arm64），或 `docker compose up -d --build` 本地构建；数据在命名卷 `/data` |

## 2. 目录结构与归属

```
AIInvestmentAdvisor/
├── package.json                # npm workspaces 根
├── tsconfig.base.json
├── Dockerfile                  # 多阶段：deps → build → runtime(非 root)
├── docker-compose.yml
├── .env.example / .npmrc / .dockerignore
├── .github/workflows/docker-publish.yml  # push 即构建多架构镜像并发布到 GHCR
├── scripts/
│   ├── dev.mjs                 # 跨平台并行启动 server+web（本地调试）
│   ├── dev.ps1 / dev.sh        # Windows / macOS 一键脚本
│   ├── build.ps1 / build.sh    # typecheck + build + test
│   ├── run-tests.mjs           # 同进程测试运行器（替代 node --test <dir>）
│   ├── smoke-api.mjs           # 端到端 API 冒烟（47 项断言）
│   ├── check-deploy.mjs        # compose/Dockerfile 校验 + 镜像 runtime 闭包复现
│   └── probe-sources.mjs       # 数据源连通性自检
├── docs/{ARCHITECTURE,API,SOURCES,VERIFY,VERIFY-REPORT}.md
├── packages/shared/            # 冻结契约：类型 + 常量（被 tsc 编译成 dist 供 Node 运行时加载）
│   └── src/{types.ts,constants.ts,index.ts}
├── packages/server/
│   ├── src/
│   │   ├── index.ts app.ts config.ts errors.ts registry.ts   # 启动 / 装配 / 进程配置 / 错误 / 服务定位
│   │   ├── types/{models.ts,repo.ts,agent.ts}                # 冻结的仓储与 Agent 接口
│   │   ├── db/{schema.ts,repo.ts,util.ts}
│   │   ├── datasources/{types.ts,http.ts,registry.ts,eastmoney.ts,tencent.ts,fund.ts,macro.ts,news.ts,websearch.ts,keyed.ts}
│   │   ├── agent/{loop.ts,llm.ts,tools.ts,prompts.ts,runtime.ts,budget.ts,positions.ts}
│   │   ├── services/{portfolio.ts,analytics.ts,briefing.ts,advice.ts,scheduler.ts,backup.ts,fx.ts}
│   │   └── routes/{index.ts,sse.ts,settings.ts,assets.ts,watchlist.ts,advice.ts,dashboard.ts,market.ts,chat.ts,agent.ts,backup.ts}
│   └── test/*.test.ts          # node:test（由 scripts/run-tests.mjs 同进程执行）
└── packages/web/
    ├── rollup.config.mjs index.html
    ├── test/render.test.tsx    # 无头渲染冒烟（renderToString）
    └── src/
        ├── main.tsx App.tsx styles.css format.ts
        ├── api/{client.ts,sse.ts,hooks.ts,agentActivity.tsx,agentMetrics.ts}
        ├── components/{Layout.tsx,ui.tsx,AgentActivityDock.tsx,RunTimeline.tsx,InstrumentDetailSections.tsx,charts/*,markdown/*}
        └── pages/{Dashboard,Assets,Watchlist,Advice,Chat,Settings}.tsx + 各页面子组件
```

### 写入边界（并行开发互不重叠）

| 归属 | 文件范围 |
| --- | --- |
| Lead | 根配置、`packages/shared/**`、`packages/server/src/{index,app,config}.ts`、`packages/server/src/routes/index.ts`、`packages/web/src/{main.tsx,App.tsx,styles.css}`、`packages/web/src/{api,components}/**`、Docker/scripts/docs |
| `server-core` | `packages/server/src/db/**`、`services/{portfolio,backup,fx}.ts`、`routes/{settings,assets,watchlist,advice,dashboard,backup}.ts`、`packages/server/test/**` |
| `agent-engine` | `packages/server/src/agent/**`、`datasources/**`、`services/{analytics,briefing,advice,scheduler}.ts`、`routes/{agent,chat,market}.ts` |
| `web-core-pages` | `packages/web/src/pages/{Dashboard,Assets}.tsx` |
| `web-ai-pages` | `packages/web/src/pages/{Watchlist,Advice,Chat,Settings}.tsx` |

> 任何跨边界修改必须先通知 Lead；共享类型只能由 Lead 修改。

## 3. 数据模型（SQLite）

```sql
settings(id INTEGER PRIMARY KEY CHECK (id = 1), persona TEXT, report_style TEXT,
         llm_base_url TEXT, llm_api_key TEXT, llm_model TEXT, llm_temperature REAL,
         llm_max_tokens INTEGER, llm_fast_model TEXT, llm_timeout_ms INTEGER,
         data_sources TEXT /*JSON*/, budget_cny REAL, budget_hkd REAL, budget_usd REAL,
         enforce_budget INTEGER, watchlist_candidate_limit INTEGER,
         schedule_mode TEXT, schedule_interval_minutes INTEGER, schedule_daily_time TEXT,
         schedule_run_asset INTEGER, schedule_run_watchlist INTEGER, schedule_run_advice INTEGER,
         schedules TEXT /*JSON：ScheduleTask[]，2026-10 起定时任务为数组；上面 schedule_* 列仅为
                          旧库迁移与回滚保留，写回时同步第一个启用任务*/,
         last_run_at TEXT, updated_at TEXT)

assets(id TEXT PRIMARY KEY, name TEXT, code TEXT, market TEXT, type TEXT, source TEXT,
       currency TEXT, note TEXT, ai_summary TEXT, ai_summary_at TEXT, thesis TEXT,
       quality_score REAL, target_price REAL, expected_return REAL,
       price REAL, price_at TEXT, price_prev_close REAL, day_change_pct REAL, spark TEXT /*JSON*/,
       created_at TEXT, updated_at TEXT)
       UNIQUE(code, market, type)

transactions(id TEXT PRIMARY KEY, asset_id TEXT, kind TEXT, shares REAL, price REAL, fee REAL,
             trade_date TEXT, note TEXT, source TEXT, created_at TEXT)
             FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE

watchlist(id TEXT PRIMARY KEY, name TEXT, code TEXT, market TEXT, type TEXT, source TEXT,
          quality_score REAL, target_price REAL, expected_return REAL,
          initial_price REAL, initial_price_at TEXT, price REAL, price_at TEXT,
          day_change_pct REAL, thesis TEXT, note TEXT, ai_summary TEXT, ai_summary_at TEXT,
          spark TEXT /*JSON*/, created_at TEXT, updated_at TEXT)
          UNIQUE(code, market, type)

advice(id TEXT PRIMARY KEY, batch_id TEXT, asset_id TEXT, watch_item_id TEXT,
       asset_name TEXT, code TEXT, market TEXT, type TEXT, action TEXT,
       target_shares REAL, target_price REAL, currency TEXT, reason TEXT, confidence REAL,
       status TEXT, executed_shares REAL, executed_price REAL, created_at TEXT, decided_at TEXT)

agent_runs(id TEXT PRIMARY KEY, kind TEXT, status TEXT, target TEXT, title TEXT, summary TEXT,
           error TEXT, turns INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER,
           started_at TEXT, finished_at TEXT)

agent_steps(id TEXT PRIMARY KEY, run_id TEXT, idx INTEGER, label TEXT, status TEXT, detail TEXT,
            tool_name TEXT, tool_args TEXT, tool_result TEXT, started_at TEXT, finished_at TEXT)

chat_sessions(id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT)
chat_messages(id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT,
              tool_call_id TEXT, run_id TEXT, created_at TEXT)

kv(key TEXT PRIMARY KEY, value TEXT)          -- 运行时缓存（FX 汇率、最近简报指针等）
```

> `assets` 与 `watchlist` 用同一张表的思路：二者都是「标的」，但资产需要交易记录与持仓计算，
> 标的需要 `initial_price`/`quality_score`/`target_price`。为避免歧义，这里采用两张表 + 共享
> 「标的元数据解析」逻辑（`datasources.registry.resolveInstrument`）。

## 4. Agent 设计（核心）

### 4.1 Loop

```
run(session, systemPrompt, userGoal)
  ├─ toolRegistry（JSON Schema 工具定义，白名单按 run.kind 过滤）
  ├─ while turns < AGENT_MAX_TURNS:
  │    ├─ llm.chat(messages, tools)         # OpenAI 兼容，支持 tool_calls
  │    ├─ 无 tool_calls → 收集最终文本 → 结束
  │    ├─ 对每个 tool_call：emit('tool-call') → 执行 → emit('tool-result') → 追加 tool 消息
  │    └─ 每步 emit('step')，写入 agent_steps（可被 UI 轮询/SSE 展示）
  ├─ 预算控制：估算 token、限制轮次与工具调用数
  ├─ 错误处理：工具异常转成结构化 tool 消息让模型自我纠正（最多 3 次同类失败）
  └─ 结束：写入 agent_runs.summary，emit('run-finished')
```

### 4.2 工具集（供 LLM 调用）

| 工具 | 作用 |
| --- | --- |
| `market_search` | 关键词/代码 → 标的候选（跨 A股/港股/美股） |
| `get_quote` | 实时报价与估值（PE/PB/ROE/市值/换手） |
| `get_series` | K 线 / 净值曲线（指定区间与粒度） |
| `get_fundamentals` | 财务与基本面指标（A股走 F10 主要指标；美股/港股走估值） |
| `get_financials` | **财报三表多期**（利润表/资产负债表/现金流量表，1-8 期）。A股按行业模板 G/B/S/I 取完整三表；港股为利润表+资产负债表+主要指标口径现金流总量；美股为利润表+资产负债表（东方财富）+ **现金流量表来自 SEC EDGAR XBRL**（官方口径，零 Key）。同时用 `GET /api/market/financials` 供详情页展示 |
| `get_fund_info` | 场外基金详情（净值、阶段涨幅、持仓、资产配置） |
| `get_dividends` | 分红送配 |
| `get_macro` | CPI/PPI/GDP/PMI/M2 + 全球指数 |
| `web_search` | 联网检索（Bing/DDG/Tavily/Serper/Brave） |
| `fetch_url` | 抓取指定网页正文并抽取文本 |
| `get_news` | 按关键词检索财经资讯 |
| `list_assets` / `get_asset` | 读取用户持仓与交易记录 |
| `list_watchlist` | 读取自选标的（含 `status` / `retiredReason` / `retireStreak`，默认返回全部） |
| `save_asset_analysis` | 写回 `assets.ai_summary` |
| `upsert_watch_item` | 新建/更新标的（优质评估、目标价、预期收益、分析总结）；更新退役标的会自动复活 |
| `retire_watch_item` | **软淘汰**：标记不再适合继续跟踪的标的，写回原因并累计 `retireStreak`（有持仓时直接拒绝） |
| `create_advice` | 生成买入/卖出建议（受预算约束） |
| `save_dashboard_briefing` | 写回 Dashboard 的 AI 简报 |
| `get_budget` | 查询当月预算剩余 |
| `get_settings_profile` | 读取投资性格/报告风格与淘汰阈值，用于调整分析口径 |
| `delete_watch_item` | **系统工具（`systemOnly`，不发给模型）**：按淘汰规则真正删除已退役标的 |

### 4.3 三条流水线（对应 UI 按钮）

1. **AI 资产分析**（`POST /api/assets/analyze`）：逐个持仓 → 并行抓取行情/K线/基本面/**财报三表（4 期）**/基金详情/分红/新闻 → LLM 深度分析（必含财报跨期趋势）→ 写回 `ai_summary` → 汇总成组合简报（Dashboard 第四板块）。
2. **AI 标的分析**（`POST /api/watchlist/analyze`）：按投资性格从信息源搜索候选 → 初筛（代码/流动性/匹配度）→ 深度分析 → `upsert_watch_item`（含优质评估、目标价、预期收益、逻辑）→ 同时刷新既有标的的估值与结论。
3. **AI 投资建议**（`POST /api/advice/generate`）：先跑 1 与 2 → 结合持仓、预算、性格 → 生成买/卖建议（`create_advice`）→ 写入 `advice` 表，`status=pending`。

三条流水线共用同一个 Loop 与工具集，仅系统提示词与目标不同；调度器（interval/daily）复用 `POST /api/agent/run-now`。

### 4.3.2 自选标的淘汰（P3：软标记 → 计数 → 删除）

「我的标的」不再只增不减。模型只负责**判断**，清理由代码按规则执行：

| 阶段 | 执行者 | 行为 |
| --- | --- | --- |
| 软淘汰 | 模型（`retire_watch_item`） | 写入 `status='retired'` + `retiredReason`，并把 `retireStreak + 1`（每次分析确认一次） |
| 复活 | 模型（`upsert_watch_item`）/ 用户（`POST /api/watchlist/:id/restore`） | 清空退役状态与次数；**退役后又买入**的标的在下次分析时自动复活 |
| 清理 | 流水线（`sweepRetiredWatchItems`，确定性） | `retireStreak >= settings.watchlistRetireDeleteRuns`（默认 3，0 = 只标记）时经 `delete_watch_item` 删除 |

护栏（任一命中即**永不自动删除**）：

- **有持仓**（净份额 > 0）：淘汰只作用于候选池。用户可能持续加仓，`retire_watch_item` 直接拒绝，
  `delete_watch_item` 也会二次兜底；买入后该标的自动回到在池状态。
- `source === 'manual'`：人工录入的标的需要用户自己清理。
- 存在 `status='pending'` 的建议引用它：等建议处理完再清理。

系统工具 `delete_watch_item` 标记为 `systemOnly`：不出现在发给模型的工具表里（`llmToolSchemas` 过滤），
但 `executeTool` 仍可执行，因此 `toolPolicy.deny`、写入审批（挂起为 `pending_writes`）与审计全部照常生效。


### 4.3.1 前端推理面板（全局 · 不随路由卸载）

四类 AI 入口（Dashboard「AI一键分析」、资产分析、标的分析、投资建议）与活动页「续跑」**不再**
在页面内联渲染推理过程，而是共用 `api/agentActivity.tsx` 提供的全局 Provider：

- Provider 位于 `<Routes>` **之外**（`App.tsx`），因此切换页面不会卸载 SSE 流，推理继续、面板不消失；
- 面板 `components/AgentActivityDock.tsx` 固定在右下角，可**收起**为一条状态小条（收起状态存 `localStorage`）；
- 面板内的指标来自 `metrics` 事件（每个 LLM 请求两条：`first-token` / `done`）：
  **首字延迟 TTFT**、**生成速度 tok/s**、**Token 用量（入/出）**、**KV Cache 命中率**，以及轮次、请求数、
  已运行时长、模型名与「本次写入了什么」汇总；纯计算与格式化在 `api/agentMetrics.ts`（有单测）。
- 页面只通过 `useAgentRefresh(reload)` 订阅「写入事件 + 运行结束」来刷新自己的列表，
  不再各自持有流；`/chat` 保持内联（对话答复本身就是页面内容）。

### 4.4 Harness 治理能力（P0/P1）

在基础 Loop 之上补了成熟 Harness 必需的六项能力，全部有单测/回归护栏：

| 能力 | 实现位置 | 说明 |
| --- | --- | --- |
| **上下文治理** | `agent/context.ts` + `loop.ts` | token 估算（CJK≈1/字）、每轮推理前 `compactContext()`：保留最近 N 轮原样 → 压缩更早工具结果 → 必要时丢弃最老整组并插入 `[历史压缩]` 说明；**永不破坏 assistant↔tool 配对**；预算取自 `llm.contextTokens`（默认 48k） |
| **端到端取消** | `llm.ts`(`signal`) + `loop.ts` + `routes/{agent,chat}.ts` | SSE 断开/用户中断 → AbortController 透传到 `fetch`；立即停止后续推理与工具调用，**保留已产生的部分结论**（`status='error'`、`error='已取消'`、`summary=部分文本`）；已提交写入不回滚 |
| **工具策略** | `agent/policy.ts` + `tools.ts` 的 `setToolInterceptor` | `toolPolicy.deny` 命中 → 结构化拒绝（`policy_denied`）；风险分级 `read/external/write` |
| **写入审计** | `agent/policy.ts` + 表 `audit_log` | 每次工具调用落一行：run/session、工具、风险、outcome（executed/denied/deferred/failed）、实体、参数摘要；审计失败永不影响 run |
| **人工审批** | `agent/policy.ts` + 表 `pending_writes` + `routes/approval.ts` | `requireWriteApproval=true` 时写操作不直接落库，进入待审批；批准才真正执行（`runWithApprovalBypass` 单次放行 + 审计） |
| **MCP 接入** | `agent/mcp.ts` + `services/mcp-manager.ts` + `routes/mcp.ts` | JSON-RPC 2.0（initialize → tools/list → tools/call），stdio 与 http 两种传输且**可注入**（沙箱/测试用进程内替身）；工具以 `mcp__<server>__<tool>` 动态并入工具表，风险 `external`；单服务器失败被隔离 |
| **轨迹回放与续跑** | `agent/loop.ts` + 表 `agent_run_messages` + `routes/runs.ts` | 每条消息持久化；`GET /api/agent/runs/:id/trace` 回放完整轨迹；`POST /api/agent/runs/:id/resume` 从轨迹继续（受同一把流水线锁保护，`status='done'` 拒绝续跑） |
| **并行工具执行（P2）** | `agent/loop.ts` + `AGENT_TOOL_CONCURRENCY` | 同一条 assistant 消息里的 `read`/`external` 工具**并发执行**（默认上限 4），`write` 工具作为**屏障**串行且保持原顺序；结果仍按模型给出的顺序落库，轨迹保持确定性、可回放 |
| **上游失败重试（P2）** | `agent/llm.ts` + `LLM_MAX_RETRIES` / `LLM_RETRY_BASE_MS` | 429 / 408 / 5xx / 网络错误做指数退避 + 抖动重试（默认 3 次），尊重 `Retry-After`（上限 30s，防止异常头拖死请求）；取消与确定性 4xx **永不**重试 |
| **提示注入加固（P2）** | `agent/tools.ts` + `agent/prompts.ts` | 所有 `external` 工具（含 MCP）返回正文被包进 `<<UNTRUSTED_WEB_CONTENT>> … <</UNTRUSTED_WEB_CONTENT>>` 并标注「是数据不是指令」；命中注入模式时额外给出 ⚠️ 告警；系统提示词第 8 条要求忽略其中任何指令 |
| **思考模型兼容（reasoning_content）** | `agent/llm.ts` + `agent/loop.ts` + 表 `agent_run_messages` | DeepSeek 类思考模型要求 assistant 工具消息把思考轨迹回传，否则多轮工具循环在第 2 轮被 HTTP 400 打死（生产实测：`watchlist-analysis` 第 5 轮整批失败）。现已在流式/非流式两条路径累积并回传，且随轨迹落库，续跑同样带上；若厂商反过来拒绝该字段，则按错误指向翻转一次回传开关并重试 |
| **建议结果追踪** | `services/advice-outcomes.ts` + 表 `advice_outcomes` | 把「建议靠不靠谱」变成可计算的数字：每条建议按**建议日之后第一个交易日**收盘建基准（无前视偏差），与同区间基准指数比较，产出方向调整收益、超额、区间极值、胜率/跑赢率。全部确定性、可重建、幂等；样本不足的条目只计入 `unmeasured`，绝不进胜率分母 |
| **机械落地校验** | `agent/validation.ts` + `agent/evidence.ts` + `tools.ts` | 能用算术判定的约束不再只写在提示词里：① 交易单位（A股/场内基金买入 100 股整数倍、科创板 ≥200、卖出可清零股，港美股不校验）**硬拦**；② 单笔买入金额 ≤ 当月预算剩余**硬拦**（与「是否用尽」互补）；③ 质量分/预期收益/目标价范围与「目标价↑但预期收益为负」这类自相矛盾**硬拦**；④ 正文里 5 位以上有效数字能否在**本次 run 的工具返回**里找到出处 —— 只**告警**不拦截（派生值、四舍五入、7000 字符截断都会造成合理的"找不到"，宁可提示不可误杀）。证据在 `executeTool` 内即时累积（同批工具结果尚未落库，读库会漏证据），run 结束释放 |
| **可观测与评测（P2）** | `scripts/{export-trace,e2e-agent,eval-agent}.mjs` | `npm run trace` 离线导出任意 run 的轨迹 JSON；`npm run e2e:agent` 真实模型端到端冒烟（对话 / 工具 / 流水线）；`npm run eval:agent` 用固定 4 场景给**真实模型**打分（工具选择、数字有据、数据缺失是否如实说明而非编造） |

设计取舍：`/api/chat/*` 不参与流水线互斥（交互对话不该被长流水线阻塞）；取消不回滚已写入的数据（保证"已确认的信息不丢"）。

## 5. 关键约定

- **零 Key 优先**：默认链路 `东方财富 → 腾讯 → Yahoo/Stooq`；搜索默认 `Bing`（DDG 在部分网络被阻断）。设置里 pin 某个 provider 表示**优先**，不可用时自动降级到其它可用源（结果用 `sources`/`warnings` 标注实际来源）。
- **降级可观测**：所有响应带 `sources` / `warnings`，UI 明确标注数据来源与缺失项，绝不静默给 0。汇率任一条腿取数失败即**整表回退**内置表，避免实时值与离线常量混用导致交叉汇率失真。
- **Agent 必须有据可依**：工具返回的数值才能进入结论；`save_asset_analysis` / `create_advice` 要求引用工具事实，提示词强制「无数据时说明数据缺失，不得编造」。
- **可中断（P0-2 起为真取消）**：客户端断开或用户主动中断 → `AbortController` 贯穿到 `fetch`，**立刻停止**后续推理与工具调用（省 token）；已产生的部分结论写入 `run.summary`（`status='error'`、`error='已取消'`），**已提交的写入不回滚**；被中断或被轮次上限截断的 run 可用 `POST /api/agent/runs/:id/resume` 从持久化轨迹续跑。
- **不落敏感数据（对外）**：`llm.apiKey` 与 `dataSources.*.apiKey` 只存本地 SQLite；HTTP 层永远只返回 `hasApiKey` + `apiKeyMasked`，导出的备份/快照同样剔除 Key。
- **账本一致性**：持仓完全由交易流水推导；删除交易前重放校验，禁止出现"没有对应买入的卖出"（409 拒绝）。
- **定时任务可信（数组：可并存多个）**：`Settings.schedules: ScheduleTask[]`，每个任务自带触发方式（`interval` / `daily`）与要跑的步骤，停用用任务自己的 `enabled`；`PUT /api/settings` 命中 `schedules`（整体替换）时立即 `scheduler.reload()`；调度器只维护一个定时器，指向所有启用任务里最近的一次触发，同一时刻到期的多个任务**合并成一次运行**（步骤取并集）后各自重排；`/api/dashboard` 的 `nextRunAt` / `nextRuns[]` 读调度器真实计划，而不是自行推算。
- **AI 长文本 = Markdown（提示词与渲染器同源）**：`ai_summary` / 简报 / `reason` / `thesis` 一律按 Markdown 书写，前端用 `components/markdown/*` 渲染。渲染**不 1:1 对应 Markdown 语义**，而是按最佳阅读形态重排：`## 一、标题` → 编号徽标 + 图标；`**结论**：…` / `**主要风险**：…` / `**目标价**：…` → 带导轨与判定胶囊的语义卡片；两列 `| 指标 | 数值 |` → 指标卡面板（该形状不再走表格）；≥三列表格 → 斑马纹数据表（数值列右对齐 + 内联柱）；`**+14.5%**` → 涨跌胶囊；```chart → 真实 ECharts。语法契约写在 `agent/prompts.ts` 的 `MARKDOWN_GUIDE`（分段 / 加粗 / 两列指标表 / 对比表 / 加粗标签起句 / `metrics`、`chart` 代码块）；**改语法必须同时改解析器**，`packages/server/test/prompt-markdown.test.ts` 会校验示例仍是合法可解析的。渲染器不产出 HTML 字符串，模型输出里的标签只会作为文本显示。
- **建议必须可追溯来源**：`create_advice` 按 `code+market+type` 反查回填 `assetId`/`watchItemId`，`AdviceItem.origin` 由此推导为 持仓 / 我的标的 / 池外。买入建议优先来自持仓（加仓）或「我的标的」；池外建议是允许的（可能确实有更好的机会），但界面必须标出来 —— 它等于跳过了「AI 标的分析」的质量分门槛。
- **候选池要跨市场、跨类型**：标的分析提示词带上当前池子的市场/类型分布并优先补齐缺口（预算覆盖 CN/HK/US）。场外基金的类型判定以东财 `Classify/JYS = 'OTCFUND'` 为准，误判成 `etf` 会命中同代码股票并写入错误价格。
- **报告表格必须显式声明表头对齐**：浏览器对 `<th>` 的默认 `text-align` 是 `center`、`<td>` 是 `left`，漏写就会「表头居中、数值左对齐」。`.md-table th` 必须保留 `text-align: left`，`th`/`td` 成对声明 `.align-*`；内联柱用绝对定位（不参与排版）。`render.test.tsx` 会逐列比对表头与数值的对齐 class。
- **渲染层不依赖外部 CSS/JS 库**：Markdown 解析、指标条、表格柱状条、浮窗全部自研（纯 TS + 内联 SVG），与「Rollup + tsc 纯 JS 工具链、可在受限/离线环境构建」的约束一致。
- **列表里的市场用色标而不是文字**：A股（金）/ 港股（青）/ 美股（紫）分别用 `.market-tag.market-CN|HK|US`。这是**分类编码**，刻意避开红涨绿跌那套语义色，长列表里扫一眼就能分市场。
- **市场与类型是两个正交维度，标签外形要能区分**：市场用**实心**色标（`MarketTag`，A股金 / 港股青 / 美股紫），资产类型用**空心 + 彩色圆点**的 `InstrumentTypeTag`（股票银 / 场内基金金 / 场外基金粉）。两者常并排出现，只靠颜色区分会混淆。
- **图表买卖点必须能查到成交明细**：K 线与净值曲线都用 `trigger: 'axis'`，markPoint 自带的 tooltip 看不到；`charts/tradeMarkers.ts` 把当天买卖点合并进坐标轴面板（份额 / 价格 / 金额 / 费用 / 备注，备注转义），并用 `params[0].dataIndex` 回查原始点而不是解析 ECharts 的 data 形状。
- **详情弹窗用页签 + 折叠区分层**：AI 分析结论独立成页签（`Tabs`），体积大但不常看的财报放进默认收起的 `Disclosure`，避免弹窗被拉成一条长滚动。
- **大字号统计卡必须能换行**：`StatCard` 是 25px 大字号，遇到「-1.6322亿CNY（2026中报）」这类长值会溢出边框；`.stat-value` / `.fin-highlight-value` 必须保留 `overflow-wrap: anywhere`（财报指标改用专用的 `fin-highlight` 卡片，把期间拆成单独一行）。
- **响应式布局约定**：主内容区不设最大宽度（列表类直接铺满整行；区块类用 `repeat(auto-fit, minmax(min(100%, Npx), 1fr))` 随宽度增减列数）。改动 `styles.css` 时保留 ≥1700 / ≤1100 / ≤900 / ≤640 / ≤420 五档断点语义，并由 `render.test.tsx` 的布局契约用例守住「不再写死宽度」。
- **AI 流水线互斥**：调度器 tick 与 4 条手动 SSE 入口共享同一把非阻塞锁（`services/pipeline-lock.ts`），同一时刻只跑一条流水线；锁被占用时手动入口立即 `error` + `run-finished(status="error")` + `done` 且不写库，tick 跳过本次。`/api/chat/*` 有意不在锁内（交互对话不应被长流水线阻塞），可能与该批次流水线并发写入 —— 单用户自托管场景可接受。

## 6. 验证方式（详见 docs/VERIFY.md 与 docs/VERIFY-REPORT.md）

一条命令跑完全部硬门禁：`npm run verify`

1. `npm run typecheck` —— 三个包零类型错误
2. `npm run build` —— shared/server 走 `tsc`，web 走 `rollup + terser`
3. `npm test` —— server 单测 + web 无头渲染测试（`scripts/run-tests.mjs` 同进程运行，不 spawn）
4. `npm run check:deploy` —— compose / Dockerfile / .dockerignore 断言；加 `-- --with-install` 还会复现镜像 runtime 依赖闭包并真实启动服务（Docker 不可用时的等价证据）
5. `npm run probe:sources` —— 数据源连通性（含响应体错误识别）
6. `npm run smoke` —— 端到端 API 冒烟：起临时服务，覆盖账本数学、预算、备份脱敏、目录逃逸、行情、契约形状与错误分支
7. 独立验证：由未参与实现的验证者按 `docs/API.md` 与需求清单做对抗性测试，结论写入 `docs/VERIFY-REPORT.md`
