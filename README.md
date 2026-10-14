# AI 投资顾问（AI Investment Advisor）

一个**自托管**的 AI 投资顾问应用：先设定你的投资性格，然后由内置的 **Agent Loop** 定期从公开股市数据源挖掘信息、筛选投资标的，逐一分析财报、基本面、宏观与微观信息，最后给出**买入 / 卖出建议**并落到你的持仓账本里。

- 🐳 **Docker 一键部署**：单容器（API + 前端静态资源），可跑在 1C1G 的轻量服务器上
- 💻 **本地调试**：Windows / macOS / Linux 一条脚本启动，无需 Docker、无需 Python
- 🤖 **真 Agent，不是套壳提示词**：多轮工具调用循环（搜索、抓网页、取行情、查财报、写库），带步骤时间线、轮次与 token 统计
- 🔓 **零 Key 数据源开箱可用**：东方财富 / 腾讯行情 / 天天基金 / Bing，全部为公开接口；也可在设置里换成 Tushare、Finnhub、Alpha Vantage、Tavily 等需 Key 的源
- 🔐 **数据自己拿着**：SQLite 单文件 + 一键导出/导入 JSON 备份

---

## 目录

- [功能总览](#功能总览)
- [快速开始（Docker）](#快速开始docker)
- [快速开始（本地调试）](#快速开始本地调试)
- [配置说明](#配置说明)
- [使用流程](#使用流程)
- [架构与目录](#架构与目录)
- [数据源](#数据源)
- [HTTP API](#http-api)
- [开发与测试](#开发与测试)
- [常见问题](#常见问题)
- [安全与免责声明](#安全与免责声明)

---

## 功能总览

| 页面 | 能力 |
| --- | --- |
| **Dashboard** | ① 持仓总市值/总成本/浮动盈亏/已实现盈亏 ② 持有标的数、购买资产数、是否有新的标的与建议 ③ 持仓 Top5 明细 ④ AI 针对持仓的分析简报；另含全球指数与预算概览 |
| **我的资产** | 完整持仓表格（名称/代码/类型/市场/建仓方/份额/成本/现价/市值/已实现盈亏/建仓与买卖日期/浮动盈亏/走势缩略图/AI 建议/备注）；筛选、排序、搜索、按市场或类型分列；添加资产、编辑（补录买卖）、删除；**查看详情**浮窗含 K 线 / 净值曲线（可拖动缩放、标注买卖点）、基本面、基金详情、分红、AI 分析总结、交易记录；**AI 资产分析**按钮逐项分析财报/基本面/宏观/微观/国际局势 |
| **我的标的** | 自选池表格（名称/代码/类型/市场/创建方/优质评估/目标价/预期收益/推荐后涨跌/走势）；添加标的、**清空标的**、**AI 标的分析**（按投资性格搜索候选、深度分析、创建或更新标的）、查看详情（同资产详情，含持仓对照） |
| **AI 投资建议** | 头部展示 A 股/港股/美股三个市场的月度预算与消耗进度（预算耗尽的市场不再推荐买入）；**AI 投资建议**按钮一键跑完资产分析 + 标的分析 + 建议生成；建议列表含目标份额、目标单价、理由、置信度、日期，支持**驳回**与**确认**（确认时填写实际成交份额与单价，直接从我的资产入账，并复用与手工录入相同的账本一致性校验） |
| **AI Chat** | 与 Agent 自由对话：问信息、聊持仓与标的、下达指令让它调用工具完成任务（新建标的、生成建议、查行情…），流式输出并展示工具调用时间线 |
| **活动与审计** | AI 运行记录列表（状态/轮次/步数/token）、**轨迹回放**（完整消息序列 + 步骤 + 审计 + 待审批）、被中断或被轮次上限截断的 run 可**一键续跑**；写入审计表（谁在何时改了什么）；全局**待审批**提示条（AI 写入等待你确认） |
| **设置** | AI API Key（任意 OpenAI 兼容接口）、投资性格（稳健/激进/价值/収息/均衡/短线）、报告风格（专业型/新手型）、数据源分配置、月投资预算（分市场币种）、**工具策略**（按工具禁用 / 写入需人工审批）、**MCP 服务器**（接入外部工具）、AI 定时任务（间隔 / 每日固定时间）、数据备份与恢复 |

---

## 快速开始（Docker）

前置：Docker 24+ 与 Docker Compose v2。

### 方式 A：拉取预构建镜像（推荐，无需 clone、无需本地构建）

每次 push 都会由 GitHub Actions 自动构建多架构镜像（`linux/amd64` + `linux/arm64`）并发布到
GitHub Container Registry，服务器上直接拉取即可：

```bash
mkdir -p ai-investment-advisor && cd ai-investment-advisor

# 只需要两个文件：compose 配置 + 环境变量模板
curl -fsSLO https://raw.githubusercontent.com/Einsphoton/AIA_AI_Investment_Advisor/main/docker-compose.yml
curl -fsSL  https://raw.githubusercontent.com/Einsphoton/AIA_AI_Investment_Advisor/main/.env.example -o .env

vi .env                       # 可选：填入 LLM_API_KEY（也可以启动后在设置页填）

docker compose pull           # 只拉镜像，不在服务器上构建
docker compose up -d

open http://127.0.0.1:8787    # 服务器上则用 http://<公网IP>:8787
```

**更新（有新提交时）**：

```bash
docker compose pull && docker compose up -d   # 拉最新镜像并重建容器，数据留在 advisor-data 卷里
```

不想用 compose 的话，一条 `docker run` 也能跑起来：

```bash
docker run -d --name ai-investment-advisor --restart unless-stopped \
  -p 8787:8787 -v advisor-data:/data \
  -e TZ=Asia/Shanghai -e LLM_API_KEY=sk-xxx \
  ghcr.io/einsphoton/aia_ai_investment_advisor:latest
```

镜像标签（`ghcr.io/einsphoton/aia_ai_investment_advisor`）：

| 标签 | 含义 |
| --- | --- |
| `latest` / `main` | main 分支最新一次构建成功 |
| `sha-1a2b3c4` | 每次提交一个不可变标签，便于回滚 / 固定版本 |
| `1.2.3`、`1.2`、`1` | 推送 `v1.2.3` 这类 tag 时自动生成 |
| `<分支名>` | 推送到其它分支时按分支名发布 |

> 镜像包是公开的，`docker pull` 不需要登录。若提示 `denied` / `unauthorized`，
> 到仓库的 **Packages** 页面把 `aia_ai_investment_advisor` 的可见性设为 Public。
> 国内服务器拉取 `ghcr.io` 慢或超时的话，给 Docker daemon 配代理 / 镜像加速即可。

### 方式 B：从源码构建

```bash
git clone https://github.com/Einsphoton/AIA_AI_Investment_Advisor.git ai-investment-advisor
cd ai-investment-advisor

cp .env.example .env          # 可选：填入 LLM_API_KEY（也可以启动后在设置页填）
docker compose up -d --build  # 首次构建约 2-4 分钟

open http://127.0.0.1:8787    # 服务器上则用 http://<公网IP>:8787
```

常用命令：

```bash
docker compose logs -f advisor     # 查看日志
docker compose restart advisor     # 重启
docker compose down                # 停止（数据保留在命名卷 advisor-data）
docker compose pull && docker compose up -d   # 更新到最新发布镜像
docker compose up -d --build       # 用当前源码重建（改了代码）
```

数据持久化：

- 默认使用命名卷 `advisor-data`，挂载到容器内 `/data`（SQLite 数据库 + 备份快照）。
- 想直接用宿主机目录：把 `docker-compose.yml` 里的 `advisor-data:/data` 换成 `./data:/data`
  （Linux 上先 `mkdir -p data && sudo chown 1000:1000 data`，容器以非 root 的 `node` 用户运行）。

镜像构建过程会执行 `npm run typecheck` 作为门禁：**类型错误会直接导致构建失败**，不会产出坏镜像。

### 镜像自动构建（GitHub Actions）

`.github/workflows/docker-publish.yml`：**每次 push 都会构建并发布镜像**（任意分支，以及 `v*` 标签），
所以服务器上永远只需要 `docker compose pull` 就能更新，不必在服务器上装 Node、也不必本地构建。

- **多架构**：`linux/amd64`（`ubuntu-latest`）与 `linux/arm64`（`ubuntu-24.04-arm`）各用对应架构的原生
  runner 并行构建，最后合并成 manifest list；`docker pull` 时按机器架构自动选择；
- **零配置**：使用仓库内置的 `GITHUB_TOKEN` 推送到 GHCR，不需要配置任何 Secret；
- **构建即校验**：`npm run typecheck` 是镜像构建的一部分，类型错误直接让构建失败；
- **发布即冒烟**：发布后 Actions 会真实拉取镜像、启动容器并请求 `/api/health`，不通过就标红；
- **固定版本**：在 `.env` 里写 `AIA_IMAGE=ghcr.io/einsphoton/aia_ai_investment_advisor:sha-1a2b3c4`
  即可锁定某次提交的镜像（默认跟 `:latest`）；
- **可回滚**：每次提交都有 `sha-xxxxxxx` 标签，改回上一个标签 + `docker compose up -d` 即可；
- 想同时发到 Docker Hub：在仓库 Secrets 里加 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`，再给
  workflow 增加一个 `docker/login-action` + 同名 tag 即可（当前只用 GHCR，保持零配置）。

---

## 快速开始（本地调试）

### 🚀 一键启动（推荐，什么都不用装）

| 系统 | 操作 |
| --- | --- |
| **Windows** | 双击 **`一键启动.cmd`**（或 `start.cmd`） |
| **macOS** | 双击 **`start.command`**（若提示权限不足，先执行一次 `chmod +x start.command`） |
| 任意系统 / 终端 | `npm run dev` |

脚本会**自己把环境准备好**，你不需要预先安装任何东西：

1. 找一个可用的 Node（≥ 22.5，优先 24）——**装了就用系统的**；
2. 没有就**自己装**：Windows 先试 `winget`，失败则下载官方**便携版**到 `.tools\`（**不需要管理员权限**）；macOS 先试 Homebrew，失败则下载官方 tar 包到 `.tools/`；
3. 首次自动安装依赖（`npm install --ignore-scripts`）；
4. 构建 + 启动，**服务就绪后自动打开浏览器**（http://127.0.0.1:8787）。

> 便携版会缓存在 `.tools/` 里，第二次启动是秒级的；该目录已被 `.gitignore` / `.dockerignore` 忽略。
> 不想自动开浏览器：`AIA_NO_OPEN=1`（Windows: `set AIA_NO_OPEN=1`）。
> 只准备环境不启动：`start.cmd -PrepareOnly`（Windows）/ `./scripts/bootstrap.sh --prepare-only`。

前置要求：**无**（脚本会自动装 Node）。手动方式则需要 **Node.js 24 LTS**（最低 22.5，因为使用了内置 `node:sqlite`）。

### Windows（手动方式）

```bat
scripts\dev.cmd            :: 不经过 PowerShell（避免执行策略/编码问题）
```

```powershell
.\scripts\dev.ps1                        # 兼容 Windows PowerShell 5.1 与 PowerShell 7+
powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1   # 若提示“禁止运行脚本”
```

> **遇到问题先自检**：`npm run doctor` 会一次性检查 Node 版本、`node:sqlite` 可用性、依赖与构建产物、
> 端口占用、数据目录可写性、LLM Key 配置，并给出具体处理建议。

### macOS / Linux

```bash
chmod +x scripts/*.sh start.command
./scripts/dev.sh
```

### 跨平台（任何系统）

```bash
npm install --ignore-scripts --no-audit --no-fund
npm run dev
```

启动后浏览器打开 **http://127.0.0.1:8787**（前端由后端托管，单端口，无跨域问题）。

开发模式的行为：

- `tsc --watch` 编译后端（`packages/server/dist`）
- `rollup --watch` 打包前端（`packages/web/dist`）
- `node --watch` 在编译产物变化时自动重启服务
- 启动前会**先探测端口**；被占用时直接给出处理方式，而不是等半分钟后报一个看不懂的错
- 按 Ctrl+C 会**连同子进程一起结束**（Windows 用 `taskkill /T`），不会残留进程占着 8787 端口
- 支持**路径含空格**（例如 `Documents\AI Project\…`）与**便携版 Node**（不需要 Node 在 PATH 里）

> 修改前端源码后**刷新浏览器**即可（本项目未使用 HMR 构建器，详见「架构与目录」中的工具链说明）。

### 生产模式本地运行

```powershell
.\scripts\build.ps1        # 类型检查 + 构建 + 测试
npm start                  # http://127.0.0.1:8787
```

```bash
./scripts/build.sh && npm start
```

### 数据源连通性自检

```bash
npm run probe:sources
```

会逐个探测东方财富（行情/K 线/F10/宏观/分红）、天天基金、腾讯行情、Bing 等端点并打印耗时与状态。
某些网络环境会屏蔽个别源（例如 Yahoo Finance 返回 403），应用会自动降级并在界面上标注数据来源。

---

## 配置说明

### 环境变量（`.env`）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | HTTP 端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data`（容器内 `/data`） | SQLite 与备份目录 |
| `LOG_LEVEL` | `info` | fatal/error/warn/info/debug/trace |
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` | 任意 OpenAI 兼容接口 |
| `LLM_API_KEY` | 空 | 留空则启动后在设置页填写（只存本地 SQLite） |
| `LLM_MODEL` | `deepseek-chat` | 模型名 |
| `LLM_TIMEOUT_MS` | `180000` | 单次 LLM 请求超时 |
| `TAVILY_API_KEY` / `SERPER_API_KEY` / `BRAVE_API_KEY` | 空 | 可选，配置后优先用于联网检索 |
| `FINNHUB_API_KEY` / `ALPHAVANTAGE_API_KEY` / `FMP_API_KEY` | 空 | 可选，美股/港股基本面增强 |

环境变量只提供**默认值**；同名配置在设置页修改后会写入 SQLite 并优先生效（API Key 在界面上始终以掩码显示）。

### 设置页

| 分组 | 说明 |
| --- | --- |
| AI 配置 | **供应商预设（50+ 家，分四组）**：国内厂商（DeepSeek / Kimi / 智谱 GLM / 通义千问 / 硅基流动 / 火山方舟 / 腾讯混元 / 讯飞星火 / MiniMax / 阶跃 / 美团 LongCat / 百度千帆…）、国际厂商（OpenAI / Anthropic / Gemini / xAI / Mistral / Groq / Perplexity / Cohere / Together / Cerebras / SambaNova / Nebius / Novita / Fireworks 等）、聚合网关（OpenCode Go / OpenCode Console / OpenRouter / Kilo / Vercel AI Gateway / Hugging Face / AiHubMix / 302.AI / 自建 One API）、本地推理（Ollama / vLLM / LM Studio / llama.cpp / Xinference / TextGen / GPUStack）。选中即自动填好 Base URL 与推荐模型，并显示该厂商的接入说明与申请 Key 链接；**模型输入框一获得焦点就会自动请求该厂商的 `/models`，并给出可输入关键字筛选的下拉**（拉取失败会自动退回手填）。日常只需要「Base URL + API Key + 模型」三项，**快速模型 / temperature / maxTokens / 超时都收进「高级设置」默认折叠**（折叠状态会显示当前值）；「测试连接」发一次最小请求并显示延迟。预设只是模板，任意 OpenAI 兼容地址都能用「自定义」填写 |
| 工具策略 | 按工具勾选允许/禁用（风险分级：只读 / 外部联网 / 写入）；可一键「只读 + 外部」；**写入需人工审批**开关（开启后 AI 的写操作进入待审批列表，批准后才落库） |
| MCP 服务器 | 添加 stdio 或 http 的 MCP 服务器（id/名称/命令/参数/环境变量/URL/启用），测试连接并查看其工具清单；其工具会以 `mcp__<server>__<tool>` 出现在 AI 工具表中（风险级别：外部） |
| 投资性格 | 6 种：稳健型、激进型、价值型、収息型、均衡型、短线交易型。每种性格都带一套筛选口径（估值门槛、仓位上限、关注指标），会注入 Agent 的系统提示词 |
| 报告风格 | 专业型（可用术语、结论密集）/ 新手型（先结论后解释、术语必须翻译成大白话） |
| 数据源配置 | A 股/港股/美股 × 股票/基金 六个槽位，以及网页搜索源；每个槽位可选择具体 Provider（标注是否需要 Key） |
| 月投资预算 | A 股(CNY)、港股(HKD)、美股(USD) 分别设置；预算是**当月买入成交额**（卖出不释放预算）；**预算耗尽的市场当月不再产生买入建议**，设为 `0` 表示该市场本月不投（想要"不限"就填一个很大的数） |
| AI 定时任务 | 关闭 / 间隔 N 分钟 / 每天固定时间；可分别开启资产分析、标的分析、建议生成 |
| 数据备份与恢复 | 一键导出全部数据为 JSON、导入（合并或覆盖）、在服务端生成快照文件 |

> **AI 配置里的「高级设置」（默认折叠）到底管什么？**
> - **快速模型**：摘要等轻量任务用的次要模型，留空＝复用主模型，不影响主分析质量。
> - **temperature（默认 0.3）**：只是随机性开关。0 ≈ 每次输出几乎一样，越高越发散；金融分析要稳定可复现，所以刻意偏低。**调高不会更聪明。**
> - **maxTokens（默认 8192）**：单次回复的长度上限，不是能力开关。太小会让长报告被截断，思考型模型（如 DeepSeek 思考模式）还会把思考过程算进去——**这个值确实不宜小于 4096**。
> - **超时 timeoutMs（默认 180000 ms）**：单次请求最长等待时间，深度分析或慢网络时调大。
> 绝大多数情况下保持默认即可，只有出现「回答被截断」或「总是超时」时才需要动。

---

## 使用流程

1. **设置页**选择「供应商预设」（覆盖 50+ 家国内外厂商、聚合网关与本地推理，一键填好 Base URL 与推荐模型）并填入 LLM API Key；任何 OpenAI 兼容接口都可用「自定义」接入。随后选择投资性格与报告风格，设置三个市场的月预算。
2. **我的资产** → 「添加资产」录入你现有的持仓（类型、市场、代码、份额、买入单价、买入日期），资产名称会根据代码自动补全。
3. **我的标的** → 「AI 标的分析」让 Agent 按你的投资性格去公开信息源挖掘候选标的，自动生成优质评估、目标价、预期收益与分析逻辑。
4. **AI 投资建议** → 点击主按钮：Agent 会先逐项分析你的持仓（财报/基本面/宏观/微观/国际局势），再刷新标的池，最后结合预算给出买入/卖出建议。
   - 「确认」→ 填写实际成交份额与单价，自动写入我的资产账本；
   - 「驳回」→ 本次不采纳。
5. **Dashboard** 查看汇总、Top5 持仓与 AI 简报。
6. **设置 → AI 定时任务** 打开后，应用会按规则自动跑完整流水线（建议 + 资产分析 + 标的分析）。
7. **AI Chat** 可以随时用自然语言追问，或直接下达指令（例如「把贵州茅台加入我的标的并给出目标价」）。

---

## 架构与目录

```
AIInvestmentAdvisor/
├── Dockerfile                  # 多阶段构建，非 root 运行，含 HEALTHCHECK
├── docker-compose.yml          # 一键部署（命名卷持久化 /data）
├── scripts/
│   ├── dev.ps1  dev.sh         # Windows / macOS 本地调试入口
│   ├── build.ps1 build.sh      # 生产构建 + 测试
│   ├── dev.mjs                 # 跨平台并行开发编排
│   └── probe-sources.mjs       # 数据源连通性自检
├── docs/
│   ├── ARCHITECTURE.md         # 架构、数据模型、Agent 与工具设计
│   ├── API.md                  # HTTP / SSE 契约（冻结版）
│   ├── SOURCES.md              # 数据源清单与实测结论（端点、字段映射）
│   └── VERIFY.md               # 验收与验证记录
├── packages/shared/            # 跨端冻结契约：类型 + 常量（无运行时依赖）
├── packages/server/            # Fastify + node:sqlite + Agent Loop + 数据源
└── packages/web/               # React 19 + React Router 7 + ECharts 6
```

### 技术选型要点

| 关注点 | 选择 | 理由 |
| --- | --- | --- |
| 运行时 | Node.js 24 | 内置 `node:sqlite`，**零原生依赖**；无需 Python 环境；与 opencode / DeepSeek Harness 同为 TS 生态 |
| 后端框架 | Fastify 5 | 轻量、原生 SSE/流式友好、插件生态成熟 |
| 数据库 | 内置 `node:sqlite`（单文件） | 轻量服务器零运维；WAL 模式；备份就是复制一个文件 |
| 构建工具 | `tsc` + `Rollup`（**纯 JS**） | 不依赖 esbuild/SWC 等会 spawn 原生子进程的工具，Windows/macOS/Linux/Alpine 行为一致；也便于在受限 CI 与沙箱中构建 |
| Agent | 自研 Agent Loop | 参考 opencode / Harness 的「消息 → 工具调用 → 工具结果 → 再推理」循环，含工具白名单、轮次上限、步骤时间线与 token 统计（见 `docs/ARCHITECTURE.md` §4） |
| LLM | 任意 OpenAI 兼容 `chat/completions` | 默认 DeepSeek，可换 OpenAI / Moonshot / Qwen / 本地 Ollama |

### 数据模型（SQLite）

`settings`（单行）、`assets`、`transactions`、`watchlist`、`advice`、`agent_runs`、`agent_steps`、`chat_sessions`、`chat_messages`、`kv`。

**持仓完全由交易流水推导**（移动加权平均成本法）：`shares = Σ买入 − Σ卖出`，卖出结算已实现盈亏，
浮动盈亏 = 市值 − 成本。DDL 见 `docs/ARCHITECTURE.md` §3。

---

## 数据源

默认链路**全部零 Key**，实测可用（2026-10 于中国大陆网络）：

| 类别 | 首选 | 兜底 |
| --- | --- | --- |
| A 股/港股/美股 行情与 K 线 | 东方财富（push2 / push2his） | 腾讯行情 `qt.gtimg.cn` |
| 估值与主要财务指标 | 东方财富报价字段（PE/PB/ROE/营收/市值/行业）+ A 股 F10 | 腾讯行情扩展字段 |
| 分红送配 | 东方财富 F10 / 数据中心 | 联网检索 |
| 场外基金 | 天天基金（净值曲线、累计净值、阶段涨幅、持仓、费率） | 联网检索 |
| 宏观 | 东方财富数据中心（CPI/PPI/GDP/PMI/M2）+ 全球指数 | 联网检索 |
| 资讯与研报 | 东方财富资讯搜索 | — |
| 网页检索 | Bing（HTML） | DuckDuckGo；或 Tavily / Serper / Brave（需 Key） |
| 汇率（组合折算） | 东方财富外汇 | 内置回退汇率（USD 7.1 / HKD 0.92） |

详见 [`docs/SOURCES.md`](docs/SOURCES.md)（含端点、参数、字段映射与实测不可用清单）。

---

## HTTP API

完整契约见 [`docs/API.md`](docs/API.md)。摘要：

```
GET    /api/health
GET    /api/dashboard
GET/PUT /api/settings                 POST /api/settings/test-llm
GET    /api/settings/data-sources     POST /api/settings/data-sources/probe
GET    /api/assets                    POST /api/assets
GET/PUT/DELETE /api/assets/:id
POST   /api/assets/:id/transactions   DELETE /api/assets/:id/transactions/:txId
POST   /api/assets/refresh            POST /api/assets/analyze      (SSE)
GET    /api/watchlist                 POST /api/watchlist          DELETE /api/watchlist
PATCH/DELETE /api/watchlist/:id       POST /api/watchlist/analyze   (SSE)
GET    /api/advice                    POST /api/advice/generate     (SSE)
POST   /api/advice/:id/reject         POST /api/advice/:id/confirm
GET    /api/budget
GET    /api/market/{search,quote,series,profile,detail,indices,macro,news}
GET    /api/chat/sessions             POST /api/chat/sessions
POST   /api/chat/sessions/:id/messages                                (SSE)
GET    /api/agent/{runs,runs/:id,tools}
GET    /api/backup/export             POST /api/backup/import
```

所有 AI 接口返回 **SSE**，事件序列为 `run-started → (step|progress|text|tool-call|tool-result|entity|budget)* → run-finished → done`。

---

## 开发与测试

```bash
npm run typecheck        # 三个包的类型检查
npm run build            # shared → server(tsc) → web(rollup + terser)
npm test                 # server 单测 + web 无头渲染测试（同进程运行器，不 spawn）
npm run smoke            # 端到端 API 冒烟：起临时服务跑 100+ 项断言（账本/预算/备份/行情/契约/治理）
npm run e2e:agent        # 用你配置的模型跑真实端到端（对话 + 工具调用；加 -- --pipeline 跑完整流水线）
npm run eval:agent       # 用固定 4 个场景给真实模型打分（工具选择 / 数字有据 / 数据缺失不编造）
npm run trace -- --list  # 列出最近运行；npm run trace -- <runId> 导出完整轨迹 JSON
npm run check:deploy     # docker-compose.yml 与 Dockerfile 静态校验
npm run check:deploy -- --with-install
                         # 额外复现镜像 runtime 阶段：只装生产依赖并真实启动
npm run probe:sources    # 数据源连通性自检（含响应体错误识别）
npm run doctor           # 本地环境自检（Node/端口/构建产物/数据目录/LLM Key）
npm run verify           # 一条命令跑完全部硬门禁（不含真实模型）
npm run clean            # 清理构建产物（不动 data/）
```

编码约定：

- Node 包（`shared`、`server`）使用 **NodeNext** 解析，相对导入必须带 `.js` 后缀（`import x from './y.js'`）。
- Web 包使用 **Bundler** 解析，相对导入不带后缀。
- 前后端共用类型只放在 `packages/shared/src/types.ts`（冻结契约），改动需同步 `docs/API.md`。

---

## 常见问题

### 本地调试起不来？按这个顺序排查

先跑一次 **`npm run doctor`** —— 它会把 Node 版本、`node:sqlite`、依赖与构建产物、端口、数据目录、LLM Key 一次性列出来并给出建议。常见原因：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `无法加载文件 … 因为在此系统上禁止运行脚本` | Windows 默认执行策略禁止 `.ps1` | 用 `scripts\dev.cmd`，或 `powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1`，或直接 `npm run dev` |
| `.ps1` 报语法/中文乱码（旧版本脚本） | PowerShell 5.1 按 ANSI 解码无 BOM 的 UTF-8，且旧脚本用了 PS7 专有的 `??` | **已修复**：脚本已改为 PS 5.1 兼容 + UTF-8 BOM；若你用的是旧副本，请重新拉取或直接用 `npm run dev` |
| 提示 `端口 8787 已被占用` | 上一次启动的进程没退干净 | ① `netstat -ano \| findstr :8787` 找到 PID → `taskkill /PID <pid> /F`；② 或换端口：`$env:PORT=8788; npm run dev`（开发模式现在会在构建前就报这个错，并在 Ctrl+C 时用 `taskkill /T` 清掉整棵进程树） |
| `未找到 node` / 版本过低 | 未安装或版本 < 22.5 | 安装 Node.js 24 LTS 后**重开终端**（PATH 才会生效）；`npm run doctor` 会显示实际版本 |
| 页面能打开但**空白** | ①（已修复，2026-10-14）前端产物里留了 React/ReactDOM 的 `process.env.NODE_ENV` 分支：浏览器没有 `process` 全局，`app.js` 第一行就抛 `ReferenceError: process is not defined`，`#root` 永远是空的 → 整页空白；②前端产物还没构建完，或浏览器缓存旧包 | ①重新构建后 **Ctrl+F5** 强制刷新：`npm run build`（构建配置会用 `define-process-env` 插件把 `process.env.NODE_ENV` 替换成字面量；`npm run doctor` 会直接报「前端产物 process.env」）；②等 `created dist/assets` 出现后再刷新 |
| `npm install` 失败（EPERM / 缓存报错） | 缓存目录不可写或杀软拦截 | 用 `npm install --ignore-scripts --no-audit --no-fund`；本项目 `.npmrc` 已把缓存指向仓库内 `.npm-cache` |
| 数据目录写不进去 | 目录只读 / 被 OneDrive 同步锁定 | 设置 `DATA_DIR` 指向可写目录：`$env:DATA_DIR='D:\aia-data'; npm run dev` |

> AI 相关的接口需要 LLM API Key（设置页填写或环境变量 `LLM_API_KEY`）；**没有 Key 时行情、持仓、标的、建议列表、备份全部可用**，只有「AI 分析 / 建议生成 / Chat」会返回明确的未配置提示。

**Q：为什么前端不用 Vite / esbuild？**
A：本项目的构建目标是「在 Windows、macOS、Linux、Alpine 容器、受限 CI/沙箱里行为完全一致」。Vite/esbuild 依赖会 spawn 原生子进程，在部分受限环境会直接失败。`tsc` + `Rollup` 是纯 JS 实现，构建结果一致，产物也足够小。代价是没有 HMR（改前端后刷新浏览器），而且**必须自己做 Node→浏览器 的常量替换**：Vite/webpack 会自动把 `process.env.NODE_ENV` 换成字面量，这里由 `packages/web/rollup.config.mjs` 里的 `define-process-env` 插件完成（漏掉它页面就是空白，`npm run doctor` 与 `packages/web/test/render.test.tsx` 都会报警）。

**Q：没有 Docker 能跑吗？**
A：可以。本地调试与生产模式都只需要 Node 24；Docker 只是部署方式之一。

**Q：AI 分析一直提示未配置 API Key？**
A：到「设置 → AI 配置」填写 Base URL 与 API Key（或在 `.env` 里设置 `LLM_API_KEY`），点「测试连接」确认可用。行情、标的列表、备份等功能不依赖 Key，可先离线使用。

**Q：某些行情/财务数据显示为空？**
A：运行 `npm run probe:sources` 看哪个源在当前网络不可用；界面上每处数据都会标注来源（`sources`）与提示（`warnings`），应用不会用 0 或假数据糊弄。港股/美股没有 F10 财报接口（东方财富未开放），Agent 会退化为「估值字段 + 联网检索研报」。

**Q：定时任务会跑多久、会不会重叠？**
A：单次流水线的时间取决于持仓/标的数量与 LLM 速度。调度器保证**同一时刻只有一个流水线在运行**：定时触发若上一次未结束会跳过本次；手动入口（AI 资产分析 / AI 标的分析 / AI 投资建议 / 手动运行）在锁被占用时会立即提示「已有 AI 流水线正在运行，请稍后再试」且不写入任何数据。唯一例外是 **AI Chat 有意不受这把锁保护**（交互对话不该被动辄数十秒的流水线阻塞），因此它与该批流水线可能并发写入 —— 单用户自托管场景可接受。

**Q：AI 会不会在我不知情的情况下改我的持仓？**
A：工具分三级风险：`read`（只读）、`external`（联网检索）、`write`（改库）。设置页的**工具策略**可以逐个禁用工具；打开**「写入需人工审批」**后，AI 的所有写入都不会直接落库，而是进入「待审批」，由你在全局提示条里逐条批准或驳回。无论是否开启审批，每次工具调用都会写入**审计流水**（活动与审计页可查）。

**Q：AI 长对话会不会爆上下文 / 我中断后会不会白跑？**
A：每轮推理前会做**上下文压缩**（保留最近若干轮原样、压缩更早的工具结果、必要时丢弃最老的整组并插入说明），预算在设置里配置（`contextTokens`，默认 48k）。中断（关闭页面或点停止）会**立刻停止**后续推理与工具调用以省 token，并把已经得到的部分结论保留在运行记录里；被中断或被轮次上限截断的 run 可以在「活动与审计」页**一键续跑**（从持久化的消息轨迹继续）。

**Q：数据存在哪里？怎么迁移？**
A：默认 `./data/advisor.db`（容器内 `/data/advisor.db`）。迁移 = 复制该文件，或在设置页「导出全部数据」得到 JSON 后在新机器导入。

---

## 安全与免责声明

- **API Key 只进不出**：`llm.apiKey` 与数据源（Tavily / Serper / Brave / Finnhub…）的 Key 只保存在本地 SQLite 或环境变量中；
  所有 HTTP 接口（`/api/settings`、`/api/settings/data-sources`）只返回 `hasApiKey` + 掩码，
  导出的备份与服务器快照同样剔除 Key，日志中也不会出现明文。
- 建议把服务部署在反向代理（HTTPS）之后，并限制访问来源；应用本身不含用户体系，请勿直接暴露到公网。
- 本项目所有输出（分析、目标价、买卖建议）均由大语言模型结合公开数据生成，**仅供研究参考，不构成任何投资建议**。市场有风险，决策与后果由使用者自行承担。
- 数据源均为公开可访问接口，请保持低频访问、遵守各站点的使用条款，不要用于商业转售。
