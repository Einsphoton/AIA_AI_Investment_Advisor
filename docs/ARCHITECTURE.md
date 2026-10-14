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
        ├── api/{client.ts,sse.ts,hooks.ts}
        ├── components/{Layout.tsx,ui.tsx,RunPanel.tsx,InstrumentDetailSections.tsx,charts/*}
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
| `get_fundamentals` | 财务与基本面指标（A股走 F10，美股/港股走估值+网络检索） |
| `get_fund_info` | 场外基金详情（净值、阶段涨幅、持仓、资产配置） |
| `get_dividends` | 分红送配 |
| `get_macro` | CPI/PPI/GDP/PMI/M2 + 全球指数 |
| `web_search` | 联网检索（Bing/DDG/Tavily/Serper/Brave） |
| `fetch_url` | 抓取指定网页正文并抽取文本 |
| `get_news` | 按关键词检索财经资讯 |
| `list_assets` / `get_asset` | 读取用户持仓与交易记录 |
| `list_watchlist` | 读取自选标的 |
| `save_asset_analysis` | 写回 `assets.ai_summary` |
| `upsert_watch_item` | 新建/更新标的（优质评估、目标价、预期收益、分析总结） |
| `create_advice` | 生成买入/卖出建议（受预算约束） |
| `save_dashboard_briefing` | 写回 Dashboard 的 AI 简报 |
| `get_budget` | 查询当月预算剩余 |
| `get_settings_profile` | 读取投资性格/报告风格，用于调整分析口径 |

### 4.3 三条流水线（对应 UI 按钮）

1. **AI 资产分析**（`POST /api/assets/analyze`）：逐个持仓 → 并行抓取行情/K线/基本面/基金详情/分红/新闻 → LLM 深度分析 → 写回 `ai_summary` → 汇总成组合简报（Dashboard 第四板块）。
2. **AI 标的分析**（`POST /api/watchlist/analyze`）：按投资性格从信息源搜索候选 → 初筛（代码/流动性/匹配度）→ 深度分析 → `upsert_watch_item`（含优质评估、目标价、预期收益、逻辑）→ 同时刷新既有标的的估值与结论。
3. **AI 投资建议**（`POST /api/advice/generate`）：先跑 1 与 2 → 结合持仓、预算、性格 → 生成买/卖建议（`create_advice`）→ 写入 `advice` 表，`status=pending`。

三条流水线共用同一个 Loop 与工具集，仅系统提示词与目标不同；调度器（interval/daily）复用 `POST /api/agent/run-now`。

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
| **可观测与评测（P2）** | `scripts/{export-trace,e2e-agent,eval-agent}.mjs` | `npm run trace` 离线导出任意 run 的轨迹 JSON；`npm run e2e:agent` 真实模型端到端冒烟（对话 / 工具 / 流水线）；`npm run eval:agent` 用固定 4 场景给**真实模型**打分（工具选择、数字有据、数据缺失是否如实说明而非编造） |

设计取舍：`/api/chat/*` 不参与流水线互斥（交互对话不该被长流水线阻塞）；取消不回滚已写入的数据（保证"已确认的信息不丢"）。

## 5. 关键约定

- **零 Key 优先**：默认链路 `东方财富 → 腾讯 → Yahoo/Stooq`；搜索默认 `Bing`（DDG 在部分网络被阻断）。设置里 pin 某个 provider 表示**优先**，不可用时自动降级到其它可用源（结果用 `sources`/`warnings` 标注实际来源）。
- **降级可观测**：所有响应带 `sources` / `warnings`，UI 明确标注数据来源与缺失项，绝不静默给 0。汇率任一条腿取数失败即**整表回退**内置表，避免实时值与离线常量混用导致交叉汇率失真。
- **Agent 必须有据可依**：工具返回的数值才能进入结论；`save_asset_analysis` / `create_advice` 要求引用工具事实，提示词强制「无数据时说明数据缺失，不得编造」。
- **可中断（P0-2 起为真取消）**：客户端断开或用户主动中断 → `AbortController` 贯穿到 `fetch`，**立刻停止**后续推理与工具调用（省 token）；已产生的部分结论写入 `run.summary`（`status='error'`、`error='已取消'`），**已提交的写入不回滚**；被中断或被轮次上限截断的 run 可用 `POST /api/agent/runs/:id/resume` 从持久化轨迹续跑。
- **不落敏感数据（对外）**：`llm.apiKey` 与 `dataSources.*.apiKey` 只存本地 SQLite；HTTP 层永远只返回 `hasApiKey` + `apiKeyMasked`，导出的备份/快照同样剔除 Key。
- **账本一致性**：持仓完全由交易流水推导；删除交易前重放校验，禁止出现"没有对应买入的卖出"（409 拒绝）。
- **定时任务可信**：`PUT /api/settings` 命中 `schedule` 时立即 `scheduler.reload()`；`/api/dashboard` 的 `nextRunAt` 读调度器真实计划，而不是自行推算。
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
