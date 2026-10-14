# 验收与验证记录（docs/VERIFY.md）

> 本文件记录「如何验证」与 **Lead 实测结果**。独立验证者的结论见 `docs/VERIFY-REPORT.md`。
> 所有命令均在仓库根目录执行。

## 0. 验证原则

1. **可复现**：每条结论都对应一条可重跑的命令。
2. **不看代码猜结论**：类型检查、构建、单测、接口实测、无头渲染、部署闭包六类证据。
3. **降级可见**：数据源失败必须体现为 `warnings` / 明确错误，禁止静默返回 0 或假数据。
4. **独立复核**：由未参与实现的验证者按 `docs/API.md` 与需求清单逐项对照（task-5）。

## 1. 环境事实（实测）

| 项 | 实测值 | 说明 |
| --- | --- | --- |
| Node | v24.19.0 | 使用内置 `node:sqlite`（要求 ≥ 24，`engines` 已声明） |
| npm | 11.17.0 | 安装需 `--ignore-scripts`；`.npmrc` 把 cache 指到项目内 |
| OS | Windows 11（pwsh 7） | 另有 `scripts/dev.sh` / `build.sh` 覆盖 macOS/Linux |
| Docker | **本机未安装** | 本地无法执行 `docker build`，用 `npm run check:deploy -- --with-install` 做等价验证（见 §2.6）；**镜像构建/发布/启动已改由 GitHub Actions 真实验证（见 §6）** |
| 构建工具链 | `typescript 5.9.3` + `rollup 4.64.6` + `@rollup/plugin-terser` | 全部纯 JS |
| 前端产物 | `app.js` 1.44 MB（压缩后）、`styles.css` 20 KB、`index.html` 0.8 KB | 未压缩为 4.4 MB |

### 1.1 工具链选型验证（为什么不是 Vite / tsx / esbuild）

本机沙箱禁止「捕获子进程 stdio 的 spawn」。实测结论：

| 工具 | 结果 |
| --- | --- |
| `esbuild` JS API（`transformSync`） | ❌ `spawn EPERM` |
| `tsx`（内部依赖 esbuild） | ❌ `spawn EPERM` |
| `vite build` | ❌ `spawn EPERM`（`windowsSafeRealPathSync` → `exec('net use')`） |
| `node --test <dir>` | ❌ `spawn EPERM`（测试运行器逐文件 spawn） |
| `tsc` / `rollup` / `node`（`node:sqlite`） | ✅ 正常 |

因此项目采用 **tsc + Rollup + 自研 `scripts/run-tests.mjs`（同进程 import 测试文件）**：
同样的命令在 Windows、macOS、Linux、Alpine 容器与受限 CI 中行为一致，且不依赖任何原生二进制。

## 2. 验证命令与实测结果

一条命令跑完全部硬门禁：

```bash
npm run verify     # typecheck → build → test → check:deploy → probe:sources → smoke
```

| # | 命令 | 实测结果 |
| --- | --- | --- |
| V1 | `npm run typecheck` | ✅ 三个包全部零错误（`TYPECHECK_EXIT=0`） |
| V2 | `npm run build` | ✅ shared(tsc) → server(tsc) → web(rollup+terser) 全部成功 |
| V3 | `npm test` | ✅ server **48/48**、web 无头渲染 **9/9**（两轮修复共新增 20 个回归用例） |
| V3b | `npm run test -w @aia/web` | ✅ 6 个页面 `renderToString` 成功 + 未知路由回退 + 六导航 + **非 stub 断言** |
| V4 | `npm run probe:sources` | ✅ **13/14** 可用；仅 Yahoo Finance 403（本网络风控，环境限制） |
| V5 | `npm run check:deploy` | ✅ compose/Dockerfile 24 项断言全通过 |
| V6 | `npm run check:deploy -- --with-install` | ✅ 仅装生产依赖（84 包）即可启动、行情接口可用、静态前端可访问 |
| V7 | `npm run smoke` | ✅ **64/64** 端到端 API 检查通过（含 5 条密钥泄漏哨兵断言、6 条非法日期、账本一致性、汇率交叉校验、前端契约形状） |

### 2.1 `npm run smoke` 关键断言（64 项全绿）

真实数据样本（实测值）：

| 项目 | 实测 |
| --- | --- |
| A 股报价 `600519` | `1283.61` |
| 港股日 K `00700`（range=1y） | 248 个数据点 |
| 美股 `AAPL` profile | 200，含市值/PE/PB/ROE |
| 宏观快照 `/api/market/macro` | 200 |
| 组合汇率 `fxRates` | `{CNY:1, HKD:0.8526, USD:6.6915}`，隐含 USD/HKD = **7.848**（符合联系汇率） |
| 建仓 100@1500 → 卖 40@1600 | `shares=60`、`realizedPnl=4000`、`cost=90000` |
| 本月预算 `spent` | `150000`（**契约口径：本月买入成交额，卖出不释放预算**），`remaining=350000`、`usedPct=30`、`month=2026-10` |
| 无 Key 调 `POST /api/advice/generate` | **400 `NOT_CONFIGURED`**（不是 500、不挂起） |
| 备份导出 | 含 1 资产 + 2 交易，**不含 `apiKey`**；merge 导入 `skipped=3` |

### 2.2 关键 bug：汇率 100 倍精度错误（已修复并有回归护栏）

- **现象**：Dashboard 的 `fxRates.HKD = 85.26`（应为 0.8526），USD 退回内置 7.1（实际 6.69）。
- **根因**：东方财富外汇接口返回放大整数 + `f59`（小数位数）——`f43=8526, f59=4` → `0.8526`；实现按 2 位小数写死，放大了 100 倍。
- **修复**：`services/fx.ts` 改为 `f43 / 10^f59`，缓存键升为 `fx.rates.v2`，新增「USD/HKD 必须落在联系汇率区间」的自检；实测输出 `HKD=0.8526 / USD=6.6915`。
- **回归护栏**：`scripts/smoke-api.mjs` 增加了两条断言（汇率量级 + 隐含 USD/HKD ∈ 7.4~8.2），旧实现会被直接判失败；`packages/server/test/fx.test.ts` 亦有单测。

### 2.3 `scripts/run-tests.mjs`（同进程测试运行器）

`node --test <dir>` 会为每个测试文件 spawn 子进程，在受限环境直接 EPERM。改为在同一进程内
`import` 所有 `dist-test/**/*.test.js`，由 `node:test` 自动执行：更快、无 spawn、退出码可依赖。
server 与 web 的 `npm test` 都走它。

### 2.4 无头渲染测试（前端唯一可自动化的渲染验证）

本机没有浏览器。`packages/web/test/render.test.tsx` 用 `react-dom/server` 的 `renderToString`
渲染全部 6 个路由 + 未知路由回退，断言页面骨架与非 stub。它能在**不启动浏览器**的前提下捕获：
跨模块导入错误、命名导出不一致、初始渲染路径崩溃、路由表缺失。

> 局限：不覆盖交互（拖拽缩放、弹窗、SSE 增量渲染），这部分依赖人工使用确认（见 §5）。

### 2.5 部署配置检查（`scripts/check-deploy.mjs`）

- `docker-compose.yml`：YAML 可解析、单服务、build 指向根 Dockerfile、端口映射、命名卷挂载 `/data`、
  healthcheck 调 `/api/health`、`restart: unless-stopped`、`DATA_DIR=/data`、LLM 环境变量可注入、日志轮转。
- `Dockerfile`：5 阶段（base/deps/build/prod-deps/runtime）、`USER node` 非 root、`HEALTHCHECK`、
  `VOLUME ["/data"]`、`npm ci --omit=dev --ignore-scripts`、构建期 `npm run typecheck` 门禁、
  `AIA_WEB_SOURCEMAP=0`、**复制 `packages/*/node_modules`**（`@fastify/static` 被 npm 放在工作区私有目录，
  这是很容易漏掉的一步）、`tini` 作为 init、入口指向 `packages/server/dist/index.js`。

### 2.6 镜像 runtime 阶段的等价验证（Docker 不可用时的替代）

`npm run check:deploy -- --with-install` 会在 `.runtime-check/` 里**完整复现镜像 runtime 阶段**：

1. 只复制清单文件（package.json / package-lock.json / .npmrc / 各 workspace 的 package.json）；
2. `npm ci --omit=dev --ignore-scripts`（实测 84 个包）；
3. 按 Dockerfile 的方式复制 `packages/*/dist`；
4. 用生产依赖启动服务并访问真实接口。

实测：`@fastify/static` 就位、`@aia/shared` 工作区链接就位、服务启动成功、
`/api/market/quote?market=CN&code=600519` 返回 `1283.61`、`/` 返回打包好的 `index.html`。
**结论**：生产依赖闭包完整，镜像不会因缺少依赖而在启动时崩溃。

### 2.7 AI 路径的验证方式：本地 mock LLM（没有真实 Key 也能验证 Agent Loop）

本机没有可用的 LLM API Key，因此 AI 路径采用**本地 OpenAI 兼容 mock 服务**验证（agent-engine 实现，
Lead 复核其结论与 `docs/API.md` §0 的一致性）：

| 场景 | 实测行为 |
| --- | --- |
| 无 Key 调 AI 写接口 | `POST /api/{assets/analyze,watchlist/analyze,advice/generate,agent/run-now}` 与 `chat/messages` 全部 **400 `NOT_CONFIGURED`**（带 `{}` body 与完全无 body 两种都验证），不是 500、不挂起 |
| 正常一轮 | `run-started → progress → step → step → step → tool-call → tool-result → … → entity → text → step → run-finished → done`（末两事件恒为 `run-finished → done`） |
| 一次 SSE 跑多条流水线 | `advice/generate` 在一条流里跑完 资产分析 → 标的分析 → 建议生成（3× `run-started…run-finished`），含 `budget` 事件与 `entity: created:advice` |
| 预算耗尽 | 工具 `create_advice` 返回 `{"error":"budget_exhausted"}`，run 仍以 `done` 收尾（工具异常不中断整轮） |
| 工具连续失败 3 次 | 3 次 `tool-result ok:false` 后仍给出结论，run=`done`，对应 step 标记 `error` |
| LLM 不可达 | `run-started → progress → step → step → error → run-finished(status=error) → done`，HTTP 始终 200、流必 close |

`GET /api/agent/tools` 返回 **19 个工具**（行情/序列/基本面/基金/分红/宏观/搜索/抓网页/资讯/持仓读取/写回分析/建标的/建建议/写简报/查预算/读性格…）。

### 2.8 第二轮：独立验证发现的缺陷与修复（全部已复验）

独立验证者（task-5）在 `docs/VERIFY-REPORT.md` 中判定「有条件可交付」，列出 **1 严重 + 5 中 + 10 低**。
Lead 逐条裁决并派单修复，**每一项都有测试或断言护栏**，防止回归：

| 编号 | 严重度 | 缺陷 | 修复 | 回归护栏 |
| --- | --- | --- | --- | --- |
| S1 | 🔴 严重 | `dataSources.*.apiKey` 在 5 个出口明文外泄（settings / data-sources / 备份导出 / 快照下载 / 前端输入框回显） | 槽位一律只返回 `provider`/`enabled`/`hasApiKey`/`apiKeyMasked`（全遮罩）；备份与快照剔除 Key；前端改为「留空=不修改、不回显」 | `smoke` 5 条哨兵断言 + server 单测 |
| M1 | 🟠 中 | 定时任务保存后**永不运行**，界面却显示已排程 | 调度器接入服务定位器；`PUT /api/settings` 命中 `schedule` 即 `reload()`；`dashboard.signals` 改读**真实定时器** | 手动实测：`nextRunAt` 多次请求不变（frozen）、`intervalMinutes=1` 真的自动跑了 2 条完整流水线且无重叠 |
| M2 | 🟠 中 | 预算 `spent = buys − sells` → 卖出可**无限解锁**预算，`remaining` 超过月预算、`usedPct` 为负 | 改为契约口径：`spent`=本月买入 gross、卖出不释放、`remaining=budget−spent`（可为负）、`exhausted=budget>0 && spent>=budget` | `smoke` 断言 + server 单测（含 `budget=0` 边界） |
| M3 | 🟠 中 | `2026-13-45`/`2026-02-30` 等非法日期被接受并污染预算归月 | `isTradeDate()` 增加 `Date.UTC` 回环真实日历校验（含闰年），三个入口共用同一 schema | `smoke` 6 条非法日期 + 闰年正例 |
| M4 | 🟠 中 | 汇率**部分降级**混用实时与内置常量 → 隐含 USD/HKD=7.274，HKD 持仓高估约 7%，并让 `smoke` 间歇变红 | 任一条腿失败即**整表回退**；交叉校验无条件执行并告警；缓存键升 `fx.rates.v3`；缓存中的缺腿数据丢弃 | `smoke` 两条汇率量级/交叉汇率断言（连续 3 次全绿）+ 单测 |
| M5 | 🟠 中 | 删除买入交易会**静默吞掉已实现盈亏** | 删除前按日期重放剩余交易，任一时刻份额为负 → 409 并拒绝 | `smoke`「删交易被拒 + realizedPnl 保持 160」 |
| M5+ | 🟠 中 | 同类问题：**倒填日期的卖出**（卖在买之前）造成时间轴上为负的账本 | 卖出插入式重放校验 → 409；买入恒放行 | server 单测 + 场景 A/B/C 实测 |
| L2 | 🟡 低 | `dailyTime: "25:99"` 被接受后被调度器静默 clamp | 增加 00:00–23:59 范围校验 → 400 | 由 task-11 复验 |
| L3 | 🟡 低 | 同一上游失败返回 502/404/200 三种状态码 | 三态存在性探测：无内容 → 502、部分内容 → 200 + warnings、上游确认不存在 → 404 | task-11 复验 + 手工样例 |
| L4–L8 | 🟡 低 | 文档滞后（ARCHITECTURE 仍写 Vite/esbuild/tsx/`/api/portfolio`）、health 缺字段、列表形状/SSE 多批次/provider 降级语义未写明 | 全部按实际实现重写对齐（见 `docs/ARCHITECTURE.md` §1/§2/§5/§6 与 `docs/API.md` §0/§1/§6） | 人工复核 |
| L9 | 🟡 低 | `smoke` 的 Key 断言是**假阴性**（只测默认无 Key 配置） | 改为「写入哨兵 Key → 对 5 个出口全文搜索」的肯定式断言 | 断言本身即护栏（旧实现必红） |
| L10 | 🟡 低 | `smoke` 每次遗留 `.smoke-data-*` | 结束后重试清理，并在启动时清扫历史残留 | 运行后目录检查 |

另外两项收尾（由实现者主动发现、Lead 裁决修复）：
- **`fundInfo()` 把股票代码误判为基金**：`fundsuggest` 会把股票原样回显，所以「CODE 相等」不是基金确证。改为「pingzhongdata 有数据 **或** suggest 命中基金类别（`FundBaseInfo`/`CATEGORY=700`/含「基金」）」才构造 `FundInfo`，否则 `null` + warning。实测 `CN/600519&type=fund` → 502、`CN/000001&type=fund` → 200 且净值 243 点。
- **倒填卖出**（见 M5+）与 **超卖** 的状态码统一为 409 CONFLICT，已写入 `docs/API.md`。

> 第二轮复验由独立验证者执行，结论见 `docs/VERIFY-REPORT.md` §7。

### 2.9 第三轮：第二轮复验新发现的 D1–D7 与修复

第二轮复验（`docs/VERIFY-REPORT.md` §7）确认 S1/M1–M5/L2–L10 全部通过，但**新发现 3 个中级 + 4 个低级**，Lead 全部裁决修复：

| 编号 | 严重度 | 缺陷 | 修复 | 回归护栏 |
| --- | --- | --- | --- | --- |
| D1 | 🟠 中 | `POST /api/advice/:id/confirm` **未接入账本校验**：倒填卖出 → 200 落库并静默丢盈亏；超卖 → 400（契约是 409） | 确认路径复用同一套校验（合计超卖 + 插入式日期重放），两类冲突统一 **409** | `smoke` + server 单测（倒填/超卖/正常买入三场景） |
| D2 | 🟠 中 | `budget = 0` 被当作**无限预算**（`exhausted=false`、`usedPct=0`），0 预算市场仍产出买入建议 | 语义定稿：`remaining = budget − spent`、**`exhausted = remaining <= 0`**、`usedPct = budget>0 ? spent/budget×100 : 100` | 单测覆盖 `budget=0` 与 `spent=0` 边界；`smoke` 预算断言 |
| D3 | 🟠 中 | 流水线互斥**只覆盖调度器 tick**，4 条手动 AI 入口可与之并发 → 两批 advice、重复写 aiSummary、双份 token | 新增 `services/pipeline-lock.ts`（非阻塞 `runExclusive`），tick 与 4 条 SSE 共享同一把锁；锁被占用时手动入口立即 `error`+`run-finished(error)`+`done` 且**不写库**；异常路径必释放 | 新增 `test/pipeline-lock.test.ts`（6 个确定性用例，含并发/串行/异常释放） |
| D4 | 🟡 低 | 服务端接受字面量 `****` 作为槽位 Key，会把真 Key 覆盖成假值 | 写入前拒绝掩码串 → 400，不破坏已存 Key | 单测 + 手工验证（真 Key 未被覆盖） |
| D5 | 🟡 低 | 冻结契约 `DataSourceChoice` 未同步脱敏后的形状（缺 `hasApiKey`/`apiKeyMasked`，仍声明永不返回的 `apiKey`） | 类型改为 `apiKey?`（仅请求）+ `hasApiKey?`/`apiKeyMasked?`（仅响应） | `npm run typecheck` 三包零错误 |
| D6 | 🟡 低 | 失败/回退的汇率被写入 kv 并缓存满 1 小时，网络恢复后仍用内置常量折算 | 只有 `live` 才落 kv 长缓存；fallback 仅内存 60s TTL；读取时忽略非 live 条目 | 新增 `test/fx-fallback-cache.test.ts`；实测「+61s 未重启即恢复 live」 |
| D7 | 🟡 低 | tick 执行期间 `nextRunAt()` 返回**已触发**的时刻，界面短暂显示"下次 <已过去的时间>" | 已触发的时刻投影为下一次计划，运行期间永不过期 | 定时器插桩单测 + 运行期 6 次取样全 `future=true` |

**代码收敛（Lead 执行）**：删除 `routes/assets.ts` 内重复的 `findLedgerDeficit`，统一 import `services/portfolio.ts` 的单一实现，避免两份逻辑漂移。

> 第三轮最终复验由独立验证者执行，结论见 `docs/VERIFY-REPORT.md` §8。

### 2.10 收尾：第三轮复验的 4 项低级别项已落地 ＋ 最终复跑

第三轮复验（`docs/VERIFY-REPORT.md` §8.4）留下 4 项文字/清理类问题（E1–E4），均已修复：

| 项 | 修复 |
| --- | --- |
| E1 | `docs/API.md` 新增 **§9.1 AI 流水线互斥**：锁语义、busy 时手动入口 `error`+`run-finished(error)`+`done` 且不写库、tick 跳过本次、chat 免锁取舍 |
| E2 | `packages/server/src/services/portfolio.ts` 的 `computeBudgetStatus` JSDoc 与实现对齐（`exhausted = remaining <= 0`；预算为 0 时 `usedPct = 100`） |
| E3 | `packages/web/src/pages/SettingsDataSources.tsx` 删除读取 `hasApiKey`/`apiKeyMasked` 的多余类型断言（`DataSourceChoice` 已在 shared 中声明） |
| E4 | `docs/ARCHITECTURE.md` §5 新增「AI 流水线互斥」约定；`README.md` 常见问题补充同一取舍说明 |

**最终复跑（补丁落地后，工作区无其它改动）**：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ 三包 0 错误（exit 0） |
| `npm run build` | ✅ shared(tsc) → server(tsc) → web(rollup+terser)，`created dist/assets in 13.1s` |
| `npm test` | ✅ server **48/48** + web **9/9**，fail 0（exit 0） |
| `npm run smoke` | ✅ **64/64**，0 告警（exit 0） |
| `npm run check:deploy` | ✅ 全部通过（exit 0） |
| `node scripts/check-deploy.mjs --with-install` | ✅ 仅生产依赖即可启动、行情接口返回真实价（`price=1283`）、静态前端可访问（exit 0） |
| 仓库根残留 | ✅ 无 `.verify-*` / `.smoke-data-*` / `.runtime-check` / `dist-*` |

### 2.11 Harness 能力增强（P0 + P1，含验证）

在「可交付」之后，按 Lead 排定的 P0/P1 清单补齐了成熟 Harness 的六项能力（接口见 `docs/API.md` §9.2–§9.4，设计见 `docs/ARCHITECTURE.md` §4.4）：

| 能力 | 交付 | 验证 |
| --- | --- | --- |
| **P0-1 上下文治理** | `agent/context.ts`（308 行）：`estimateTokens` / `countMessagesTokens` / `compactContext`；Loop 每轮推理前压缩（保留最近 N 轮、压缩更早工具结果、必要时整组丢弃 + `[历史压缩]` 说明），预算取 `llm.contextTokens`（默认 48k）；**硬不变量：绝不产生孤儿 tool 消息** | 11 个单测（token 单调性、system 不变、最近 N 轮原样、配对完整性、预算内 `compacted=false`） |
| **P0-2 端到端取消** | `llm.ts` 的 `signal` 覆盖**流式读取全过程**；Loop 每轮/每次工具调用前检查 aborted；路由按请求建 `AbortController`（`reply.raw` 关闭触发，正常结束用 `finished` 标志防误触发） | 3 个单测（fake LLM 中途 abort → 立刻结束、`status=error`、`error` 含「已取消」、**部分结论保留**、轨迹可查） |
| **P1-1 工具策略 + 审计 + 人工审批** | `agent/policy.ts`（deny → 结构化拒绝；`write` + `requireWriteApproval` → 落 `pending_writes`；审批登记失败改为 deny，杜绝"审批被静默跳过"）+ `audit_log` + `routes/approval.ts`（audit/pending/approve/reject）+ 前端 `PendingWritesBar` | 15 个单测（deny/defer/bypass/审计落行/approve 真写库/reject 不写/409/404）+ `smoke` 断言 |
| **P1-2 MCP 接入** | `agent/mcp.ts`（JSON-RPC 2.0：initialize → tools/list → tools/call，**传输可注入**）+ `services/mcp-manager.ts`（失败按服务器隔离）+ `routes/mcp.ts` + 设置页 `McpServersCard` | 8 个单测（握手顺序、callTool 拼接/isError、超时、http 传输、provider 注册、`mcp__<id>__<tool>` 出现在工具表、失败隔离不抛）——**全部进程内 fake transport，不 spawn** |
| **P1-3 轨迹回放 + 续跑** | `agent_run_messages` 持久化每条消息；`GET /api/agent/runs/:id/trace`；`POST /api/agent/runs/:id/resume`（受流水线锁保护，`done` 拒绝续跑）+ 前端「活动与审计」页 | `smoke` 断言（trace 404 契约）+ 续跑单测 + 无头渲染覆盖 `/activity` |
| **前端装配** | 新增 `/activity` 路由与导航项、全局待审批提示条、设置页工具策略与 MCP 两个 Card | `npm run test -w @aia/web` **10/10**（含 `/activity` 渲染 + 七个导航项断言） |

**P0/P1 落地后的全量复跑（工作区无其它改动）**：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ 三包 0 错误 |
| `npm run build` | ✅ shared(tsc) → server(tsc) → web(rollup+terser) |
| `npm test` | ✅ server **87/87** + web **10/10**（新增 29 个用例） |
| `npm run smoke` | ✅ **72/72**（新增治理断言：上下文预算字段、工具风险分级、audit/pending 裸数组、MCP 列表与 reload、工具策略写入、trace 404） |
| `npm run check:deploy` | ✅ 全部通过 |
| `node scripts/check-deploy.mjs --with-install` | ✅ 仅生产依赖即可启动、行情可用（`price=1285.57`）、静态前端可访问 |
| `npm run probe:sources` | ✅ 12/14（东财全球指数瞬时失败、Yahoo 403 —— 均为网络侧，有降级与 warnings） |
| 仓库根残留 | ✅ 无临时目录 |

> 接线说明：`routes/index.ts`（注册 approval/mcp/runs 三组路由）、`src/index.ts`（`installToolInterceptor` + `initMcp`/`reloadMcpServers`/`shutdownMcp`）、`App.tsx`/`Layout.tsx`（`/activity` 路由与导航、待审批条）由 Lead 在集成阶段完成；`/api/agent/tools` 的 `risk`/`source` 透传亦由 Lead 修正（原路由映射漏字段，`smoke` 捕获）。

### 2.12 P0/P1 的独立验证（第三轮）与缺陷修复

P0/P1 落地后交由**独立验证者**做对抗性复核（含 15 组极端上下文输入、真实服务 + stub LLM 的流中途取消、直查 SQLite 核对审批/审计、MCP 失败隔离等）。基线声明全部属实；另发现 **3 中级 + 4 低级**，Lead 已全部修复并补了回归测试：

| 编号 | 严重度 | 缺陷（验证者复现） | 修复 | 回归护栏 |
| --- | --- | --- | --- | --- |
| D1 | 🟠 中 | **审批门/deny 被流水线兜底写入旁路**：`runAssetAnalysis` 在 run 结束后直接 `writeBriefing()→setKv('dashboard.briefing')`，审批模式下模型调用已挂起（pending 行在、审计 deferred），简报却照样落库；`deny` 时同样 | 兜底写入改为**经由 `executeTool('save_dashboard_briefing')`**，与模型调用走同一道策略/审批/审计 | 新增 `test/briefing-gate.test.ts` 3 个用例：deny → 不落库 + 审计 `denied`；审批模式 → 进 pending 且不落库；放行 → 正常写入 + 审计 `executed` |
| D2 | 🟠 中 | **一次人工 approve 写两条 `executed` 审计**：`executeTool→interceptor.after` 与 `routes/approval.ts` 各记一条（实现者的测试因未安装拦截器而假绿） | 删除 approve 路径里重复的 `recordAudit`（拦截器是唯一审计出口）；测试改为**在测试内安装拦截器**（模拟 `index.ts` 真实装配） | `approval.test.ts` 的 audit 断言现在依赖真实拦截器 |
| D3 | 🟠 中 | **「请求不超过 contextTokens」非硬保证且无信号**：压缩后仍 72700 tokens 也照发，无 warning；文档与 `loop.ts` 头注释却称"保证不超过" | ① 新增第三级**硬裁剪**（只作用于保护窗口之外的正文，绝不改最近 N 轮与 system）；② `CompactResult.overflowTokens`/`hardTrimmedMessages`；③ 超预算时 **logger.warn + 写一条 `error` 步骤**给出超出量与建议；④ 文档改为「三级压缩 + 超预算告警」，并订正"已在执行中的工具调用会跑完（不会中途中断其 HTTP 请求）" | 新增 2 个用例：极小预算 → `overflowTokens>0` 且 `afterTokens` 自洽、最近 4 轮逐字节不变；预算充足 → 不压缩不溢出 |
| D4 | 🟡 低 | 取消后 `assistant.tool_calls` 有调用无结果，`repairOrphanTools` 只单向修，resume 会发出非法配对 | 双向修复：缺失结果的调用补 `[已取消] 该工具调用未执行…` 占位（按 id，插入在 assistant 消息之后） | 新增 D4 用例：2 calls/1 tool → 补齐为 2 且已有结果原样保留 |
| D5 | 🟡 低 | `trace.pendingWrites` 先分页再按 runId 过滤，表变大后老 run 静默返回 0 行 | 新增 `Repo.listPendingWritesByRun(runId, limit)`，**在 SQL 里过滤** | `runs.ts` 改用新方法；approval/trace 用例覆盖 |
| D6 | 🟡 低 | 长 `serverId` 使 `mcp__<id>__<tool>` 被整体截断、结构消失 | 改为**分段截断**（id 与 tool 各留一半空间）保住结构；设置 schema 限制 `id ≤ 24` 且仅 `[A-Za-z0-9_-]` | `mcp.test.ts` 的 ≤64 与不重名断言 |
| D7 | 🟡 低 | `agent_run_messages.content` 无上限、无轨迹清理；`AGENT_COMPACT_TRIGGER_RATIO` 是死常量 | ① 单条消息落库截断到 20k 字符（带标记）；② 新增 `Repo.pruneRunData(keepRuns)`，启动时保留最新 200 条 run 的轨迹/步骤/审计；③ 删除未使用的常量 | `pruneRunData` 由服务启动路径（`smoke` 会真实启动）覆盖；截断在 repo 层 |

**修复后的全量复跑**：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ 三包 0 错误 |
| `npm run build` | ✅ 全链路成功 |
| `npm test` | ✅ server **93/93** + web **10/10**（含 D1/D3/D4 新增回归测试） |
| `npm run smoke` | ✅ **72/72**（真实启动服务，覆盖 D7 的启动期 prune 与 D1 的写入路径） |
| `npm run check:deploy` | ✅ 全部通过 |
| `npm run probe:sources` | ✅ 仅 Yahoo 403（网络侧，有降级提示） |

> 验证者同时确认**未回归**：S1（含新增 `mcpServers.env` 的密钥检查）、M2（预算口径）、M5（账本 409）、孤儿 tool 硬不变量（15 组极端输入）、ALS 并发隔离、MCP 失败隔离、trace/resume 锁与 409/404 契约。

### 2.13 本地调试脚本不可用的修复（实测复现 → 修复 → 复验）

用户反馈「无法运行脚本进行本地调试」。**实测复现并定位到两个真实根因**（本机 shell 为 **Windows PowerShell 5.1**，无 pwsh 7）：

| 根因 | 证据 | 修复 |
| --- | --- | --- |
| `scripts/dev.ps1` 使用 **PS7 专有语法** `$($env:PORT ?? '8787')` | `powershell.exe` 解析：`PARSE ERROR: Unexpected token '??'` | 重写为 PS 5.1 兼容（去掉 `??`、加 `$LASTEXITCODE` 检查、端口占用提示、`-Prod` 取代含糊的 `-NoBuild`） |
| 两个 `.ps1` **无 UTF-8 BOM**，PS 5.1 按 ANSI 解码 → 中文串被破坏、解析失败 | `build.ps1`：`ERROR: The string is missing the terminator`；`dev.ps1`：`Unexpected token 'Node'` | 重写后写回 **UTF-8 with BOM**；复验 `powershell.exe` 解析 **两个脚本均 OK** |
| `scripts/dev.cmd`（新增）内含中文，而 **cmd.exe 以 OEM/ANSI 代码页读取 .cmd** → 批处理解析失败 | 实测输出 `'渚濊禆瀹夎澶辫触' 不是内部或外部命令` | 两个 `.cmd` 改为**纯 ASCII**（非 ASCII 字节数实测 = 0），并 `chcp 65001` 让子进程日志正常显示 |
| 退出后残留进程占住 8787，导致下次启动报 EADDRINUSE | 设计缺陷 | `dev.mjs` 的 Ctrl+C 改为 **`taskkill /PID <pid> /T /F`**（杀整棵 npm→node 进程树）；启动前**先探测端口**并给出处理方式 |

**新增能力**：`npm run doctor` 一次性自检 Node 版本、`node:sqlite` 可用性、依赖与三个构建产物、端口占用、数据目录可写性、LLM Key 配置，并输出可执行建议。

**修复后的实测证据**：

| 验证 | 结果 |
| --- | --- |
| PS 5.1 解析 `scripts/*.ps1` | ✅ 两个脚本均 `OK`（BOM=True） |
| `npm run doctor` | ✅ 11 项检查通过，退出码 0 |
| 端口占用分支：占住 8787 后跑 `dev.mjs` | ✅ 一条清晰报错（含两条处理方式）+ `exit 1`，不再等构建完才崩 |
| 完整开发流程（`scripts/dev.cmd`） | ✅ 构建 → 启动 → `GET /api/health` 返回 `{ok:true,webBuilt:true}` → 首页 200 且含 `id="root"` / `/assets/app.js` / `/assets/styles.css` |
| 进程树清理 | ✅ `taskkill /T` 一次终止 13 个进程，**端口验证为已释放** |
| 回归 | ✅ `typecheck` 0 错误、`build` 成功、`test` server 93/93 + web 10/10 |

> 说明：本机无 bash，`scripts/*.sh` 仍为逐行审查（未实机执行）；`cmd.exe` 与 PowerShell 的编码差异已在 `README.md`「常见问题 → 本地调试排错」中写成排查表。

### 2.14 一键启动（脚本自行准备环境）的实测

需求：「Windows / macOS 各一个脚本，用户不管环境，缺什么脚本自己装。」

**交付**：
- Windows：`start.cmd`（ASCII 内容 + `-ExecutionPolicy Bypass`）、中文名快捷方式 `一键启动.cmd`、实现体 `scripts/bootstrap.ps1`
- macOS：`start.command`（可在 Finder 双击）、实现体 `scripts/bootstrap.sh`
- 引导逻辑：找 Node(≥22.5) → 有就用；没有则 **Windows 先试 winget、失败下载官方便携版到 `.tools\`（无需管理员权限）**；**macOS 先试 Homebrew、失败下载官方 tar 包到 `.tools/`** → 首次 `npm install --ignore-scripts` → 构建启动 → **自动打开浏览器**
- 便携版缓存复用（第二次启动秒级）；`-PrepareOnly` / `--prepare-only` 只准备环境不启动，便于自检

**实测证据（Windows，本机）**：

| 场景 | 结果 |
| --- | --- |
| 系统已有 Node 24 | ✅ 直接用系统 Node 启动，`/api/health` 返回 `{ok:true,webBuilt:true}` |
| **强制走自动安装**（`-ForcePortable -PrepareOnly`） | ✅ 查询官方版本列表 → 下载 **Node v24.21.0** zip → 解压到 `.tools\` → `node -v` = `v24.21.0`（**全程无需管理员权限**） |
| **完全模拟"用户机器什么都没装"**：把 node 从 PATH 移除 + **路径含空格**（`Documents\AI Project\…`）+ 仅用便携版 Node | ✅ 复用便携版 → 构建 → 启动 → `/api/health` = `{ok:true,webBuilt:true}`；杀进程后**端口已释放** |
| 中文名快捷方式 `一键启动.cmd` | ✅ 正常调用引导脚本（exit 0） |
| 便携版被 PATH 之外的 npm 调用 | ✅ `dev.mjs` 改为用 `node <npm-cli.js>`（不经 shell）——同时修掉了**路径含空格导致 `spawn(shell:true)` 断词**的 Windows 经典坑 |
| `.ps1` 在 PS 5.1 下解析 | ✅ 三个脚本均 `OK`（UTF-8 BOM） |
| `.cmd` 编码安全 | ✅ 4 个 `.cmd` 非 ASCII 字节数均为 **0** |
| 回归 | ✅ `typecheck` 0 错误、`build` 成功、`test` server 93/93 + web 10/10、`smoke` 72/72 |

> macOS 侧的 `start.command` / `bootstrap.sh` 逻辑与 Windows 对称（`uname` 判平台与架构 → brew 或官方 tar → 缓存复用），但**本机无 macOS/bash，未实机执行**，仅逐行审查；`bash -n` 亦无法运行。







## 3. 数据源实测矩阵（2026-10-14，`npm run probe:sources`）

| 数据源 | 结果 | 备注 |
| --- | --- | --- |
| 东方财富 报价（A股/港股/美股） | ✅ 200 | A股 99ms / 港股 18ms / 美股 24ms |
| 东方财富 K 线 | ✅ 200 | 需 `beg`/`end`/`lmt` 参数 |
| 东方财富 搜索 / F10 财务 / 分红 / 宏观 / 全球指数 | ✅ 200 | |
| 天天基金 净值历史 | ✅ 200 | **必须** Referer `https://fundf10.eastmoney.com/`，否则 `ErrCode -999` |
| 天天基金 基金详情 JS | ✅ 200 | `pingzhongdata/{code}.js` |
| 腾讯行情（GBK 兜底） | ✅ 200 | |
| Bing 搜索 | ✅ 200 | Agent 联网检索默认源 |
| Yahoo Finance | ❌ 403 | 本网络风控；代码保留该 Provider 并在失败时降级 |
| Stooq / 新浪行情 / DuckDuckGo | ❌ 403 / ECONNRESET | 不启用；DuckDuckGo 作为备用搜索源 |
| 东方财富 US/HK F10 | ❌ 404 | 港美股基本面退化为「报价估值字段 + 联网检索」 |

> `probe-sources.mjs` 不仅看 HTTP 状态码，还会识别响应体里的 `"data":null` / `rc != 0` / `ErrCode < 0`，
> 避免把「200 但无数据」误报为可用。

## 4. 需求覆盖对照表（Lead 侧自检）

| 需求 | 落点 | 状态 |
| --- | --- | --- |
| Docker 部署（轻量服务器） | `Dockerfile`、`docker-compose.yml`、`.github/workflows/docker-publish.yml` | ✅ 配置检查（34/34）+ runtime 闭包等价验证；**镜像已由 CI 在 amd64/arm64 真实构建、发布到 GHCR 并真实启动容器**（见 §6） |
| Windows 本地调试脚本 | `scripts/dev.ps1`、`scripts/dev.mjs` | ✅ 结构审查通过；脚本逻辑已审阅（本机为 Windows 可直接跑 `npm run dev`） |
| macOS/Linux 本地调试脚本 | `scripts/dev.sh`、`scripts/build.sh` | ⚠️ 无法在本机（Windows）执行，已逐行审查 |
| Agent Loop + 工具调用 | `packages/server/src/agent/*` | ✅ 19 个工具注册；SSE 序列经本地 mock LLM 端到端验证（见 §2.7） |
| Dashboard 四板块 | `pages/Dashboard.tsx` | ✅ 无头渲染 + 需求文本断言 |
| 我的资产全功能 | `pages/Assets.tsx` + 两个 Dialog | ✅ 无头渲染 + 无头断言 |
| 我的标的全功能 | `pages/Watchlist.tsx` + Dialog | ✅ 无头渲染 |
| AI 投资建议（预算/建议/驳回/确认） | `pages/Advice.tsx` | ✅ 无头渲染 |
| AI Chat | `pages/Chat.tsx` | ✅ 无头渲染 |
| 设置（Key/性格/风格/数据源/预算/定时/备份） | `pages/Settings*.tsx` | ✅ 无头渲染 |
| 后端账本与预算正确性 | `services/portfolio.ts` | ✅ 64 项冒烟 + 39 项后端单测 |
| 数据源零 Key 开箱可用 | `datasources/*` | ✅ 13/14 探测通过（Yahoo 因网络风控不可用） |
| 备份与恢复 | `services/backup.ts`、`routes/backup.ts` | ✅ 导出不含 Key、导入去重、快照可读回 |
| 安全（Key 永不回传） | `routes/settings.ts`、`services/backup.ts` | ✅ 哨兵 Key 对 5 个出口全文搜索 0 命中（`npm run smoke` 断言） |
| 定时任务 | `services/scheduler.ts`、`routes/dashboard.ts` | ✅ `nextRunAt` 读真实定时器；`intervalMinutes=1` 实测自动执行且不重叠 |

### 2.15 Harness 完善第三阶段（P2）＋ 真实模型验证

**背景**：用户配置了真实 API（`opencode.ai/inference/go/v1` + `deepseek-v4.1-flash`）；其间另有进展：新增「LLM 供应商/模型选择」（`LlmProviderPreset` 目录、`SettingsLlmProvider.tsx`、`SettingsModelField.tsx` 及测试）。本轮在其之上继续补齐 P2 能力。

| 能力 | 实现 | 验证 |
| --- | --- | --- |
| **并行工具执行** | `agent/loop.ts`：同一条 assistant 消息里的 `read`/`external` 工具并发（`AGENT_TOOL_CONCURRENCY=4`），`write` 工具作**屏障**串行；结果按模型给的顺序落库 | 新增 `test/agent-parallel.test.ts`：两个 400ms 读工具执行区间**重叠**（跨度 < 700ms，串行会 ≥800ms）、写工具必须在两个读之后才启动、写之后的读必须等写结束、4 条 tool 消息顺序与模型调用一致 |
| **上游失败重试** | `agent/llm.ts`：429/408/5xx/网络错误指数退避 + 抖动（`LLM_MAX_RETRIES=3`），尊重 `Retry-After`（≤30s）；取消与确定性 4xx 永不重试 | 与既有 `llm-error` 测试兼容，111 项全绿 |
| **提示注入加固** | `agent/tools.ts`：所有 `external` 工具（含 MCP）返回正文包进 `<<UNTRUSTED_WEB_CONTENT>>…<</UNTRUSTED_WEB_CONTENT>>`，命中注入模式额外 ⚠️ 告警；`agent/prompts.ts` 新增第 8/9 条硬性规则 | `looksLikePromptInjection`/`wrapUntrustedContent` 单测 + 端到端断言（注入文本被围栏且被点名）；MCP 用例同步改为「内容保留 + 必须被围栏」 |
| **轨迹导出** | `scripts/export-trace.mjs` + `npm run trace`：离线（可停服）读库，列出最近运行 / 导出任意 run 的完整轨迹 JSON | 实测列出 4 次运行（turns/steps/tokens/耗时），导出 11.5KB JSON；修掉一个 off-by-one（`--out` 缺席时首个 run id 被吞） |
| **真实模型评测集** | `scripts/eval-agent.mjs` + `npm run eval:agent`：固定 4 场景对真实模型打分 | 实测 **4/4 通过** |
| **真实端到端冒烟** | `scripts/e2e-agent.mjs` + `npm run e2e:agent`：克隆数据库 → 起服务 → 对话 / 工具 / 完整流水线 | 实测全绿 |

**真实模型实测（本机）**：

| 测试 | 结果 |
| --- | --- |
| `e2e:agent` 对话 + 工具 | ✅ 对话 3s/117 字；模型真实调用 `get_quote` 并给出「贵州茅台 1286.00 元，+0.87%，PE(TTM) 19.74、PB 6.4」 |
| `e2e:agent --pipeline` 完整资产分析 | ✅ **11 次工具调用**（quote/series/fundamentals/dividends/news/macro/list_assets/web_search/save_asset_analysis/save_dashboard_briefing）、4 轮 15 步、写回 **889 字**分析 + **1125 字**简报、轨迹 16 条、审计 10 条；简报中模型主动指出「资产记录 price 仍为缓存值，与实时报价不一致」——grounding 规则生效 |
| `eval:agent` 4 场景 | ✅ **4/4**：S1 上证指数（7 次工具，引用数字）；S2 先 `market_search` 核实再 `get_quote`；S3 **不存在的 ZZZZQQ 明确说明数据缺失、未编造价格**；S4 `list_assets` + `get_budget` 预算感知回答 |

**顺手修掉的真缺陷**：`npm run dev` 的开发服务用的是 `npm run start`（`node dist/index.js`）——**没有 `--watch`**，后端改完不会自动重启（与 README 描述不符）。已新增 `start:watch`（`node --watch …`）并让 `dev.mjs` 使用；实测改动源码后服务 PID 47332 → 50328 且 `/api/health` 正常。

> ⚠️ **操作事故（如实记录）**：验证自动重启后用 `taskkill /T` 清理测试实例时，命令行匹配命中了用户当时正在运行的 8787 dev 会话，把它一并结束了。已告知用户重启。教训：清理前必须按**端口 + 完整命令行**双重确认目标属于本次测试。


## 5. 已知限制（诚实声明）

1. **`tini` 信号转发与 `/data` 卷持久化未验证**：镜像构建（amd64/arm64）、Alpine(musl) 运行、容器启动与 `/api/health` 已由 GitHub Actions 真实验证（原「本机无 Docker」的限制已消除，见 §6）。仍未验证：`tini` 的 SIGTERM 转发、命名卷跨容器重建后的数据持久化、非 root uid 的独立核对。
2. **macOS/Linux 脚本未实机执行**：本机为 Windows；`.sh` 脚本已逐行审查（`set -euo pipefail`、Node 版本校验、依赖安装、构建/启动分支）。
3. **前端交互未做浏览器实测**：仅无头渲染 + 打包验证。图表拖拽缩放、弹窗、SSE 增量渲染需人工确认。
4. **真实模型已验证（2026-10-14 更新）**：用用户配置的 `deepseek-v4.1-flash` 跑通「对话 / 工具调用 / 完整资产分析流水线」并完成 4 场景评测（见 §2.15）。仍未覆盖：**长周期成本**（单次流水线约 27k+2k token）、**多市场大批量持仓**（>10 只）下的稳定性、以及其它供应商/模型（OpenAI / Qwen / Ollama 等）的兼容性 —— 需按实际使用逐步观察。
5. **部分数据源在本网络不可达**（Yahoo/Stooq/新浪/DuckDuckGo），对应 Provider 只能在其他网络验证。东方财富报价接口在频繁探测时会短暂限流，应用会降级并写 warning。
6. **无鉴权**：应用按「自托管在内网/反代之后」设计，`/api/*` 全部无认证，请勿直接暴露公网。
7. **`AIA_OFFLINE=1` 只影响仓储侧的行情软桥，不覆盖 `/api/market/*`**（该开关是测试/离线降级用，不是用户功能）。已知，未修。
8. **搜索自动补全的类型分类**：东方财富 suggest 把「华夏成长混合」这类场外基金归为 `etf`（因为 EM 不区分场内/场外，而 `InstrumentType` 只有 stock/etf/fund）。添加资产/标的时**类型由用户自己在下拉框选择**，自动补全只填名称，因此影响很小；来自 `fundsuggest` 的搜索结果类型正确。

---

## 6. Docker 镜像构建与发布（2026-10-14 补充：已由 CI 真实验证）

**背景**：§5-1 原记录「本机没有 Docker，`docker build` / `docker compose up` 未执行」。本轮新增
`.github/workflows/docker-publish.yml`，把镜像构建搬到 GitHub Actions：**每次 push 都会真实构建**
（任意分支 + `v*` 标签），此前无法执行的验证因此闭环。

**首次真实构建暴露并修复的两个必然失败缺陷**（不是偶发，静态检查发现不了）：

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | `[runtime 2/14] chown -R node:node /data /app` → `chown: /app: No such file or directory`（exit 1） | runtime 阶段从 `node:24-alpine` 起、**不继承** base 阶段的 `WORKDIR /app`，而 `WORKDIR /app` 写在 `RUN` 之后 | `mkdir -p /data/backups /app` 之后再 chown |
| 2 | `npm run typecheck` → 满屏 `TS2307 Cannot find module '@aia/shared'` + 级联 `TS7006` | `@aia/shared` 的类型只经 `packages/shared/dist/index.d.ts` 暴露（无 TS `paths` 映射），而 `dist` 是构建产物且被 ignore | root `typecheck` 先 `build -w @aia/shared`（本地移走 `dist` 已 1:1 复现；修复后 exit 0，重生成产物逐文件一致） |

**可复现的命令与实测结果**：

```bash
npm run check:deploy    # 34/34 通过（含 9 项 CI 一致性断言）
npm run typecheck       # 移走 packages/shared/dist 后仍 exit 0
git log --oneline -4    # f3f6f10 / 7b943ea / e37f9bb / 6fa363d
```

| 验证项 | 结果 | 证据 |
| --- | --- | --- |
| 多架构镜像真实构建 | ✅ `linux/amd64`（ubuntu-latest）与 `linux/arm64`（ubuntu-24.04-arm）原生 runner 并行，约 2 分钟（含 gha 缓存） | run 38563387605：4 个 job 全 success |
| 公网匿名拉取 | ✅ GHCR 匿名 token（**未携带任何登录凭据**）+ `tags/list` = `main, latest, sha-6fa363d` | `docker pull` 无需登录 |
| manifest list | ✅ OCI image index，含 `linux/amd64`、`linux/arm64`（另 2 条 `unknown/unknown` 为 BuildKit provenance 证明） | GHCR v2 `manifests/latest` |
| 容器真实可启动 | ✅ CI 内 `docker pull ghcr.io/einsphoton/aia_ai_investment_advisor:main` → `docker run` → `curl /api/health` 第 2 次尝试通过 | 冒烟 job 日志 |
| digest 可追溯 | `sha256:20144c7c7dff…`（`latest` / `main` / `sha-6fa363d` 指向同一 index） | 同上 |

**仍未验证**：`tini` 的 SIGTERM 转发、命名卷 `/data` 跨容器重建的持久化、非 root uid 的独立核对。
