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


### 2.16 前端体验迭代（P4：响应式 / Dashboard 顺序 / Markdown 渲染 / 建议理由浮窗）

**背景**：16:9 显示器上每页右侧大量留白；手机端未做专门适配；AI 输出在前端一直以 `white-space: pre-wrap` 纯文本渲染；AI 投资建议的理由列单行长文本把行高撑得很大。

| 需求 | 实现 | 验证 |
| --- | --- | --- |
| ① 分辨率自适应 | `styles.css`：**删除 `.main` 的 `max-width: 1560px`**（右侧留白的根因），改 `width: 100%` + `clamp()` 内边距；栅格统一 `minmax(min(100%, Npx), 1fr)` —— 列表（表格）铺满整行、区块随宽度增减列数；新增 ≥1700 / ≤1100 / ≤900 / ≤640 / ≤420 五档断点；手机侧边栏改为两行吸顶栏（品牌 + 可横滑导航），表格保留最小列宽**横向滚动**而不是把列压扁 | `render.test.tsx` 新增布局契约用例：`.main` 无 `max-width` 且有 `width:100%`、三处栅格防溢出保护、五个断点齐全、640 档表格 `min-width` |
| ② Dashboard 顺序 | 「全球指数概览」从底部双列栅格**上移到「计数与信号」下面**；底部「月度预算使用」独立成行并按市场 `grid-3` 动态平铺 | 源码顺序断言（② < ③ < ④）+ 7 条路由无头渲染 |
| ③ AI 输出 Markdown 化 | 新增零依赖 `components/markdown/{parse.ts,Markdown.tsx}`：标题分层 + 语义图标、**关键指标条**（百分比带迷你条）、GFM 表格**数值列内联柱**、```chart 渲染成真实 ECharts、```metrics 指标块、语义数字着色（红涨绿跌）、长报告超宽屏双栏；接入 Dashboard 简报 / 资产详情 / 标的详情 / Chat 气泡 / 右下角运行时间线。旧文本（整段叙述、没有冒号或表格）由**第二道「标签 数值」片段扫描**兜底提取 KPI | 6 项新单测（块级结构 + 嵌套列表 + 未闭合围栏容错、HTML 注入只作文本、KPI 双道扫描、chart 合法/非法 JSON）；对**线上真实数据**实测：954 字旧简报识别出 5 个伪标题（`**一、组合结构**` 等），建议理由提取出 `现价 22.18 CNY / PE 28.99 / PE(TTM) 21.21 / PB 3.50 / 股息率 2.83%` 等 8 个指标 |
| ④ 建议理由排版 | 理由列固定 268px、两行截断（摘要先剥掉 Markdown 标记），悬浮 / 聚焦 / 点击弹出 portal 浮窗展示完整 Markdown（含指标条）；删除旧的「展开 / 收起」按钮 | `HoverTip` 无头渲染断言（默认收起、只输出触发区）+ 源码断言（不再有「展开」按钮） |
| 提示词同步 | `agent/prompts.ts` 新增 `MARKDOWN_GUIDE`（分段 / 加粗 / 表格 / 引用 + `metrics`、`chart` 代码块语法），建议 `reason` 限 120 字；`services/analytics.ts` 资产分析目标同步要求 | 新增 `packages/server/test/prompt-markdown.test.ts`：示例 chart JSON 可 `JSON.parse` 且 `categories` 与 `series.data` 等长、metrics 行格式合法 |

**实测**：`npm run typecheck` ✅ / `npm test` ✅（server 125 + web 38 = **163 项全绿**）/ `npm run build` ✅ / `npm run check:deploy` ✅（全部通过）；8787 在线实例已返回新产物（`/assets/styles.css`、`/assets/app.js`，`Cache-Control: max-age=0`，普通刷新即生效）。

**仍未验证**：真实浏览器下的视觉与交互（本机无浏览器自动化工具，见 §5-3），需人工刷新确认观感。

### 2.17 报告渲染 v2：修复表格错位 + 富视觉元素（2026-10-15）

**用户反馈**：① 表格的列没对齐，尤其是**表头与该列的数值**；② 希望 AI 分析报告像其它 Agent 一样用更丰富的视觉元素渲染（不惜使用 HTML）。

**缺陷（真实根因，不是观感问题）**：`.md-table th` 只写了 `padding/background/font-size/...`，**漏写 `text-align`**。浏览器对 `<th>` 的默认值是 `center`，而 `<td>` 是 `left` —— 于是每一列都变成「表头居中、数值左对齐」；只有分隔行显式写了 `---:` 的列才偶然对齐，所以表现为「有的列对、有的列不对」。

| 修复 | 内容 |
| --- | --- |
| 显式对齐 | `.md-table th { text-align: left }`，并让 `th`/`td` 成对声明 `.align-left/.align-right/.align-center` |
| 数值列自动右对齐 | 内容全为数字的列自动右对齐（与站内 `.data-table` 的 `.num` 一致） |
| 内联柱不再破坏对齐 | 旧写法用块级 `.md-bar-cell` 包裹数值，会吃掉 `text-align`；改为绝对定位的 `.md-bar-fill` + `.md-cell`，装饰层不参与排版，并按对齐方向锚定左右 |
| 两列指标表改走卡片 | `| 指标 | 数值 |` 渲染成指标卡面板，**从根上不再产生表头**，这类报告不存在错位 |
| 回归护栏 | 新增用例逐列比对 `<th class="align-*">` 与同列 `<td class="align-*">` 必须一致，并断言 `.md-table th` 规则里存在 `text-align: left` |

**富视觉渲染（v2）**：渲染不再 1:1 对应 Markdown 语义，而是按最佳阅读形态重排。

| Markdown 写法 | 渲染结果 |
| --- | --- |
| `## 一、估值与价格` | 编号徽标（圆形「一」）+ 语义图标 + 分节标题 |
| `## 名称｜角色：稳健成长` | 主标题 + 副标题胶囊 |
| `**结论**：入选。…` | 结论卡（金色导轨 + ◆ 图标 + 自动提取的「入选」判定胶囊） |
| `**主要风险**：…` | 风险卡（红色导轨 + ⚠） |
| `**目标价**：25.00 CNY` | 目标卡（绿色导轨 + ◎） |
| `| 指标 | 数值 |`（两列） | 指标卡面板；百分比自动带进度条；长值独占整行 |
| `| a | b | c |`（≥三列） | 数据表：斑马纹、悬停高亮、数值右对齐、数值列内联柱、涨跌胶囊 |
| `> …` | 引用提示块（按关键词着色 + 图标） |
| `**+14.54%**` | 带底色的涨跌胶囊（红涨绿跌） |
| `- **组合角色**：…` | 列表项标签着色 |

**线上真实数据实测**（用真实渲染器 SSR 成 HTML 后统计，非估算）：
- 国电南瑞标的分析（1419 字）：1 个主标题 + 副标题胶囊、5 个分节标题、**4 张语义卡片**（结论 / 目标价与预期收益 / 主要风险与失效条件 / 数据缺失）、1 个 5 项指标卡面板、6 个顶部指标、5 个涨跌胶囊、34 处语义数字、1 个「入选」判定胶囊、1 个分隔线。
- Chat 分析报告（2829 字）：**6 个编号徽标、1 个 6 项指标卡面板（含 1 行长值独占整行）、1 张数据表（表头与数值逐列同向）、10 个列表标签、7 个涨跌胶囊、45 处语义数字**。
- 修复前后对照：真实两次报告渲染出的 `<th>`/`<td>` 对齐 class 由「表头 center / 数值 left」变为与列一致。

**验证**：`npm run typecheck` ✅ / `npm test` ✅（server 143 + web 40 = **183 项全绿**）/ `npm run build` ✅；8787 在线实例已返回新产物（`.md-table th` 含 `text-align: left`、含 `.md-kv-item`/`.md-callout`/`.md-chip`）。

**仍未验证**：真实浏览器观感（本机无浏览器自动化），需人工刷新确认。

### 2.18 财报（三表）纳入 AI 分析流程 + 详情页展示（2026-10-15）

**用户反馈**：「AI 分析标的和资产时，到底有没有分析过该资产的财报？任何一个券商软件，在每个股票页面都能看到财报。」

**核查结论（承认缺陷）**：原实现的 `get_fundamentals` 只是东方财富 F10 **主要财务指标的最新一期摘要**（营收/净利/ROE/毛利率/负债率 12 项）——没有三表、没有多期趋势；港美股更退化为纯估值比率。实跑库里 13 次 `get_fundamentals` 确实被用来打分与写结论，但**不是财报分析**。

| 交付 | 实现 | 验证 |
| --- | --- | --- |
| 三表数据源 | 新增 `datasources/financials.ts`：A 股宽表（G/B/S/I 行业模板自动探测）、港美股长表（科目为行）、同比字段回退、币种归一、派生比率与排雷信号 | 17 项离线单测（`test/financials.test.ts`） |
| Agent 工具 | 新增只读工具 `get_financials`（`periods` 1-8，默认 4；超 7000 字符自动降期数，绝不截半 JSON） | `toolDescriptors()` 断言 `risk:read` + 资产/标的分析工具表包含它；`smoke` 工具清单 22 个 |
| AI 流程 | 资产分析**预取 4 期三表**写入 brief；标的分析/建议/chat/scheduled 提示词要求逐标的核对最新财报并写跨期趋势 | `services/analytics.ts` + `agent/prompts.ts` 硬性规则 10（口径）与 11（缺失必须交代） |
| 详情页展示 | 新增 `GET /api/market/financials` + `components/FinancialsPanel.tsx`，挂到**资产详情**与**标的详情**两个弹窗：比率指标卡 + 三表多期表格（金额万/亿、比率 %、每股 3 位小数）+ 缺失原因红/黄条 | API 参数校验与 ETF「不适用」用例（server）；`statementRows/formatFinancialValue/parseHighlight` 纯函数用例 + 两个弹窗引用断言（web） |
| **美股现金流量表**（第二轮补齐） | 新增 `datasources/edgar.ts`：SEC EDGAR XBRL 官方口径（ticker→CIK 表 24h 缓存 + 按科目取数 6h 缓存），拼成与东财一致的「累计口径」多期期间；东财无该接口时自动回退 | 新增 `test/edgar.test.ts` 9 项纯函数用例（定期报告过滤 / 累计口径选取 / 重述取最新 / 时点事实 / 期间拼接 / 附加科目标签映射 / UA 含联系方式 / 空代码）；15 只大盘股实测 **13 只有数据** |
| **AI 报告嵌财报趋势图**（第三轮） | `prompts.ts` 两条流水线指令 + `analytics.ts` 目标第 6 条：财报 ≥3 期时必须用 ```chart 代码块给营收/归母净利/经营现金流趋势（JSON 合法、categories 与各 series.data 等长），期数不足则不画 | 新增提示词断言（两条流水线都含 ```chart、`categories` 与 `get_financials`）；前端 Markdown 渲染器对 chart 的解析已有既有用例覆盖 |
| **多标的财报对比页 `/compare`**（第三轮） | 新增 `pages/FinancialCompare.tsx`：候选来自「我的资产 + 我的标的」（上限 4 个），纯函数 `buildComparison` 组装「指标为行、标的为列」，缺失显示 `—`、不同报告期与缺失报表都会出提示；下方可展开任一标的复用 `FinancialsView` 看三表明细。抽出 `ComparisonTableView` 供预览复用 | 新增 2 项 web 用例（指标并排/缺值为 null 不补 0/三类提示；路由+导航+页头三处接线）；`/compare` 纳入无头渲染路由表；`preview:financials` 产物含对比表（12 项结构断言） |

**实测数据（2026-10-15，真实接口）**：

| 标的 | 结果 |
| --- | --- |
| 贵州茅台 600519（通用模板 G） | 三表全 ✅ 4 期；毛利率 89.73%、归母净利率 48.24%、资产负债率 15.19%、经营现金流/归母净利 1.588 倍 |
| 工商银行 601398（**银行模板 B**） | 三表全 ✅ 4 期；营收 4658.59 亿(+9.08%)、归母 1736.8 亿、资产负债率 92.37% |
| 中国平安 601318 / 中信证券 600030 | 模板 I / S 各自命中（探针验证） |
| 腾讯 00700（港股长表） | 利润表 + 资产负债表 ✅；现金流量表为「主要指标」总量口径并显式标注，经营现金流/归母净利 1.351 倍 |
| 苹果 AAPL（美股 `.O` 后缀） | 利润表 + 资产负债表 ✅；**现金流量表 ✅ 来自 SEC EDGAR**：OCF 117.00B、投资 -18.81B、筹资 -94.58B、资本开支 6.80B（FY2026 三季报累计），4 期 → 高亮 `经营现金流/归母净利润=1.1531 倍`、`自由现金流=1101.97 亿 USD` |
| SCHD（ETF） | `applicable:false`（200，非错误），UI 显示「该标的没有公司财报」 |

**踩到并修掉的上游坑（都是必现，不是偶发）**：

1. **A 股按行业分四套模板**：`RPT_F10_FINANCE_GBALANCE` 对银行/证券/保险一律「返回数据为空」，必须换 `BBALANCE`/`SBALANCE`/`IBALANCE`（工行一开始只有利润表，资产负债表+现金流量表整体缺失）。金融模板还缺 `TOTAL_OPERATE_INCOME`，需回退 `OPERATE_INCOME` + 换标签。
2. **美股 `SECUCODE` 必须带交易所后缀**：裸 `AAPL` 一律空；`.O`=纳斯达克、`.N`=纽交所（实测 13 个代码）。ETF 无 F10 财报（属预期）。
3. **同一报告期两套口径**：美股同期同时有「单季报」与「累计季报」，科目名/`STD_ITEM_CODE` 重复且数值不同；必须二选一（本项目取累计季报对齐 A 股/港股）。
4. **长表分页窗口截断**：窗口打满时最旧一组会缺科目（港股资产负债表出现「有总资产、没有流动资产」的半张表）→ 窗口饱和即整组丢弃。
5. **0 占位字段**：茅台 `ASSET_BALANCE=0` 而 `TOTAL_ASSETS` 有值 → 同义字段取第一个非空**非零**。
6. **缓存键必须带 pageSize**（真实模型跑出来的 bug）：`http.ts` 按 key 缓存整段响应，而同一标的 4 期/8 期的响应体不同；早期缓存键漏了期数，**先取 4 期再请 8 期会命中脏缓存**——模型因此在报告里写下「请求 8 期上游只返 4 期」。修复后同一进程内 4/6/8 期分别返回 4/6/8 期，并加单测锁死缓存键随 pageSize/模板/标的区分。
7. **跨表比率必须同期**（第二轮发现的真错值）：美股现金流量表来自 SEC EDGAR、利润表来自东财，两者报告期可能对不齐（拼多多实测：EDGAR 现金流是 `2025年 年报`，东财利润表是 `2026年 中报`），早期实现直接相除得到「经营现金流/归母净利润=**0.38 倍**」这种把全年现金流除以半年利润的错值。修复为：**只有报告期一致（归一空格后）才算比率，不同期只给绝对额**；同期判定覆盖「2026年 中报」vs「2026年中报」这种标签差异。已加两条单测（不同期只出绝对额 + 空格差异视为同期）。
8. **SEC 拒绝只带网址的 User-Agent**：`+https://…` 与 `(https://…)` 两种写法实测全部 **403**；带 `contact: xxx@example.com` 或浏览器式 UA 才 200（ticker 表与 concept 接口一致）。默认 UA 已改为带联系邮箱样式，未设置 `AIA_EDGAR_USER_AGENT` 时会在 `warnings` 里提示用户填真实邮箱。
9. **EDGAR 附加科目的键名用错**（第三轮实跑抓出）：`capex`/`depreciation` 的 Tag 与站内指标键不同名，早期代码拿输出键（`constructLongAsset`）去查 Tag 表，**静默取不到资本开支**，导致美股永远算不出「自由现金流」。修复后 AAPL 得到 `自由现金流=1101.97亿USD（2026年 三季报）`；已加单测锁死 Tag → 指标键的映射，避免再次静默失败。同轮还修掉 route 层 warnings 去重（registry 与 value 同源导致同一条警告出现两次）。

**真实模型端到端验证（`npm run e2e:agent -- --pipeline`，用户配置的 `deepseek-v4.1-flash`）**：

| 观察项 | 结果 |
| --- | --- |
| 模型是否调用财报工具 | ✅ 资产分析流水线中出现 **`get_financials`** 调用（两次运行分别调用 2 次 / 1 次，共 10 次/8 次工具调用） |
| AI 写回的 `ai_summary`（1292 字） | ✅ 有独立的「**三、财报（累计口径）**」小节，引用跨期数字：2026 中报营收 **922.78 亿(+1.30%)**、归母 **445.17 亿(-1.95%)**、扣非 444.64 亿、毛利率 **89.56%**、净利率 50.75%；2025 全年营收 1720.54 亿/归母 823.20 亿；经营现金流净额 **706.91 亿 = 归母净利的 1.588 倍**、收现比 106.7%；负债率 15.19%；并且**自己用「中报 − 一季报」算出 Q2 单季**（证明累计口径规则生效） |
| 排雷项 | ✅ 主动做跨期对比发现 **合同负债 31.78 亿 vs 2025 年报 80.07 亿 显著回落**（渠道回款走弱）；商誉无科目时明确写「报表未列示商誉科目」 |
| 缺失如实交代 | ✅ 写明「三表跨期仅 4 期（请求 8 期上游只返 4 期），无法做更长年度对比」——这正是上面第 6 条 bug 的现场证据，修复后已可给到 8 期 |
| 其余检查 | ✅ run status=done、Dashboard 简报 1026 字、轨迹 14 条可回放、写入审计 10 条 |

**界面观感验证（第三轮补做）**：先把「无浏览器自动化」这个笼统限制查清楚——本机**有** Edge 与 Chrome，但无头模式在沙箱里都起不来（`--headless --screenshot` 退出码 13，`--user-data-dir` 建出来是空的），根因是沙箱禁止其 IPC/命名管道，不是缺浏览器。于是改用**真实数据 + 真实组件**的结构化验证：

| 手段 | 内容 | 结果 |
| --- | --- | --- |
| `npm run preview:financials`（新增） | 新增 `rollup.preview.config.mjs` + `test/preview-financials.tsx`：用 `emFinancials()` 取真实数据，`renderToStaticMarkup` 渲染 `FinancialsView` **与 `/compare` 的 `ComparisonTableView`**，产出**自包含** HTML（内联应用样式表、可离线打开） | 5 个标的（A股 / 港股 / 美股 / 缺失 / ETF）+ 1 个对比视图全部渲染成功，产物 98KB |
| 产物结构断言 12 项 | 表格数（3/3/3/2/0）、表头列数（1 科目 + 4 期）、数据行数（茅台 18 行）、`922.78亿` 万/亿格式、同比、自由现金流、"数据缺失：现金流量表 + 原因"、ETF 空状态、对比表 1+4 列 / 10 个指标行 / 带币种 / 提示不同期、样式内联、无 `<script>` 注入 | **12/12 通过** |
| 永久 SSR 回归用例（`render.test.tsx`） | `FinancialsView` 三表 / 同比 / 缺失原因 / ETF 不适用四态断言（注意：`renderToString` 会插入 `<!-- -->` 水合标记，断言前需剥离——首版就是踩了这个）；`buildComparison` 缺值不补 0、三类提示；`/compare` 纳入无头渲染路由表 | web 测试 **54/54 全绿** |

> 结论：**结构与数据绑定已可自动回归**；像素级观感仍需人工——现在有一条命令即可在浏览器打开真实渲染结果（`preview-financials-panel.html`），比截图更能随时复核。

**回归验证（最终一次实测）**：`npm run typecheck` ✅ / `npm test` ✅（server **216** + web **54** = **270 项全绿**；并发会话也在持续加用例，该数字为本次实测值）/ `npm run build` ✅ / `npm run check:deploy` ✅ / `npm run smoke` **78/78** / `npm run preview:financials` ✅（12 项结构断言全过）/ `npm run probe:sources` 新增 9 条财报端点 + 2 条 EDGAR 端点**全部 200 有数据**（25 项中 20 项通过，失败的 5 项为既有/瞬时 quote、K线、Yahoo 网络问题）/ `GET /api/market/financials` 对 CN（通用+银行）/HK/US（含 EDGAR 现金流）/KO 缺失/ETF 不适用 与 3 类非法参数逐一实测通过。

**仍未验证 / 未覆盖**：
1. **美股现金流量表的个别发行人**：SEC EDGAR 只对「无维度事实」暴露 companyconcept；可口可乐（KO）、Visa（V）这类把现金流科目以**带维度事实**申报的发行人返回空 `units.USD`（同一 Tag 在 companyfacts 里确有 155 条事实），`frames` 接口也取不到。用 companyfacts（单只 10MB+）兜底不划算故未采纳 —— 这两类标的仍按「数据缺失」处理，Agent 会改用 `web_search` 查原文。实测覆盖 13/15 只大盘股（AAPL/MSFT/XOM/JNJ/WMT/PG/JPM/NVDA/TSLA/META/GOOGL/BABA/NKE）。
2. **港股现金流量表明细**：上游无明细接口，目前只有总量口径（经营/投资/筹资净额 + 期末现金）。试过的替代：雪球 `stock.xueqiu.com/v5/stock/finance/hk/cash_flow.json` 需登录（`error_code 400016`）；新浪港股财务页是 GB2312 的 HTML 表格（76 行），爬取太脆弱、不符合「优先稳定 JSON 源」的取舍；同花顺港股财务页为 JS 渲染，实测 HTML 里没有现金流字段。**唯一稳的路子**：接一个带 Key 的成熟源（FMP / EODHD / Infoway 等，项目的数据源目录里已预留 `fmp` 槽位），或用港交所披露易的结构化文件——两者都未实施。
3. **像素级观感**：无头浏览器在本沙箱不可用（见上表），窄屏横向滚动与配色对比度需人工打开 `preview-financials-panel.html`（含对比视图）或应用页面确认。
4. **`/compare` 的真实交互**：页面取数、勾选、展开明细只做了无头渲染 + 纯函数断言，未在浏览器里点过（同上原因）。

### 2.19 标的预期期限 / 行情刷新 / 候选覆盖度 / 建议来源（2026-10-15）

**用户反馈四条**：① 预期收益要写清楚「多久能到」；② 「推荐后涨跌」恒为 0；③ 推荐全是 A 股股票，没有港股/美股/场内基金/场外基金；④ 建议里的标的是「我的标的」里没见过的，不确定合不合理。

| # | 现象与根因 | 修复 | 验证 |
| --- | --- | --- | --- |
| ① | 标的只有 `expected_return`，没有期限 | `watchlist` 新增 `expected_return_horizon`（含老库 `ensureColumn` 迁移）；类型/仓储/工具/路由/界面全链路打通；详情浮窗可人工修正 | repo 往返 + PATCH 接口 + 超长 400 + Web 源码断言 |
| ② | `changeSinceAdded = 现价 − 推荐时价格`，而**价格只在「AI 标的分析」开跑时顺带刷新**，两次分析之间永远是 0 | 新增 `POST /api/watchlist/refresh`；列表进页面时若行情超过 5 分钟未更新自动补刷，也可手动「刷新行情」；列表显示「行情更新于 …」 | 接口契约测试（离线：`updated:0` + warning、不写任何价格）+ **线上实测**：修复前 5 条全是 `0.0000`，刷新后为 `+0.50% / +1.54% / +0.05% / -2.20% / +0.12%` |
| ③ | 提示词没有跨市场/跨类型要求，模型锚定已有池子（5 个全是 A 股股票）；更要命的是**场外基金被判成 `etf`**：`000001` 场外基金用 `type=etf` 查报价会**静默命中股票「平安银行」**，模型发现名称对不上后直接放弃场外基金 | ① 提示词带上当前池子的市场/类型分布，明确要求补齐为 0 的市场与类型（预算本就覆盖 CN/HK/US）；② `suggestType` 按东财 `Classify/JYS = 'OTCFUND'` 判为 `fund`，`suggestMarket` 显式识别 `MktNum=150/MarketType=6`；③ 提示词补充类型判定与名称复核规则 | 新增 `search-type.test.ts`（fixture 全部取自 2026-10-15 真实 suggest 响应）+ 线上探测：`CN/fund 000001` → 净值 1.126「华夏成长混合」；`CN/etf 000001` → 11.39「平安银行」（错误命中的证据） |
| ④ | 建议确实**结合了持仓与「我的标的」**（`runAdvice` 的 goal 里带持仓与自选标的 JSON），但没有强制链接，也没有把「池外」显示出来，用户无从判断 | `create_advice` 按 `code+market+type` 反查回填 `assetId`/`watchItemId`；`AdviceItem.origin` 推导为 持仓 / 我的标的 / 池外；建议列表显示来源徽标，池外建议明确提示「跳过了候选池的质量分门槛」；提示词加入来源纪律（卖出必须来自持仓、买入优先来自候选池，池外必须在理由开头写明并解释） | 新增 `advice-origin.test.ts`：工具 schema 契约、按 code 回填 watchItemId（watchlist）、持仓优先（holding）、池外保持 external |

**实测（8787 在线实例）**：`POST /api/watchlist/refresh` → `{"updated":5,"failed":0}`；`GET /api/watchlist` 返回 `expectedReturnHorizon` 字段，5 条标的的「推荐后涨跌」不再是 0。

**验证**：`npm run typecheck` ✅ / `npm run build` ✅ / Web 47 项全绿；Server 新增 8 项全绿（同工作区另有并发任务在改 `edgar/financials`，其 2 项测试当时为红，与本轮改动无关；该并发任务随后已修复并全绿，见 §2.18）。

**结论（回答「这样合不合理」）**：合理的部分是「允许池外机会」——真正的投资机会不总是先出现在自选池里；不合理的是**默认把池外建议混在一起、不告诉用户**。现在三类来源一眼可辨，池外建议会明确标注并建议先复核。

### 2.19 市场色标 / 财报排版 / 详情页签 / 推理面板 / 宏观 LPR（2026-10-15）

**用户反馈五条**：① 资产、标的列表的市场（A股/美股/港股）要用不同颜色标注；② AI 简报报「LPR 与社会融资规模暂不可得」；③ 标的/资产详情的 AI 分析单独做 Tab、财报折叠；④ 财报里归母净利润同比、资产负债率等数值超框；⑤ 右下角 AI 面板不要关闭按钮，只要折叠。

| # | 现象与根因 | 修复 | 验证 |
| --- | --- | --- | --- |
| ① | 列表里市场只是纯文本 \`MARKET_LABELS\` | 新增 \`MarketTag\` + \`.market-tag.market-CN/HK/US\`（金 / 青 / 紫）。**分类编码刻意避开红涨绿跌**，否则 A股 会被误读成「涨」。用于我的资产 / 我的标的 / Dashboard 持仓与预算 / 建议列表 / 两个详情弹窗 | 无头渲染断言三个 color class + 三个列表页源码断言 + CSS 配色规则断言 |
| ② | 老注释断言「上游没有 LPR 报表」，于是 \`get_macro\` 恒返回 warning，模型只能报「数据缺失」 | **结论是错的**：LPR 走 \`RPTA_WEB_RATE\`（页面 JS 里写明，排序字段是 \`TRADE_DATE\`），实测 \`LPR1Y=3 / LPR5Y=3.5\` @2026-09-20。已接入 \`macro.ts\`（新增 \`lpr_1y\` / \`lpr_5y\` 两项）；社会融资规模对 \`RPT_ECONOMY_*\`/\`RPTA_WEB_*\` **共 48 种命名做了穷举探测**，确实不存在，warning 文案改成「无零 Key 报表 + 请用 web_search 并注明来源与日期」 | 新增 \`macro.test.ts\`（\`periodOf\` 优先级、LPR 字段映射、缺失字段返回 null 不编造 0）；**线上实测** \`/api/market/macro\` 已返回 LPR，warning 只剩社融一条 |
| ③ | 两个详情弹窗把「基本信息 / 行情 / 基本面 / 财报 / AI 分析 / 交易 / 分红」堆成一长条 | 新增 \`Tabs\` 与 \`Disclosure\`：**AI 分析独立成页签**（带「已生成」徽标），概览页里的**财报默认折叠**；标的详情把「人工修正」表单从 AI 卡片里拆出来放回概览 | 无头渲染（tablist 语义 / 默认收起不渲染内容）+ 两个弹窗源码断言（\`<Tabs>\` / \`<Disclosure>\` / 仍保留 \`<FinancialsPanel>\`） |
| ④ | 财报指标复用 \`StatCard\`（\`font-size: 25px\`），而 highlight 是 \`-1.6322亿CNY（2026中报）\` 这种长串 → **溢出卡片边框** | 新增 \`fin-highlight\` 指标卡：把「期间」拆成独立一行、数值允许换行，并只对「同比/环比/增长」这类方向性指标着色（\`资产负债率 40.42%\` 不再被误标成「涨」）；同时给通用 \`.stat-value\` 补 \`overflow-wrap: anywhere\` 兜底 | \`splitHighlightValue\` 单测（含 \`（2026中报）\` 拆分）+ CSS 断言（两处 \`overflow-wrap\`）+ 断言财报面板不再使用 \`StatCard\` |
| ⑤ | 推理面板同时有「收起」和「✕ 关闭」两个出口，语义重复 | 删掉 \`dismiss\` 按钮，只保留「收起」（收起后是右下角小条，点击可再展开） | 源码断言：保留 \`setCollapsed(true)\`、不再出现 \`dismiss\`/✕ |

**验证**：\`npm run typecheck\` ✅ / \`npm run build\` ✅ / \`npm test\` ✅（server 219 + web 58 = **277 项全绿**）/ \`npm run check:deploy\` ✅。
**线上（8787）**：\`/api/market/macro\` 返回 \`lpr_1y=3%\`、\`lpr_5y=3.5%\` @2026-09-20，warnings 仅剩社会融资规模一条；服务端产物含 \`.market-tag.market-CN/HK/US\`、\`.fin-highlight-value\`、\`.disclosure-head\`。

**仍未验证**：真实浏览器观感（本机无浏览器自动化），需人工刷新确认色标对比度、页签切换与折叠交互。

### 2.20 资产类型标签 / 图表买卖点面板 / 我的资产走势（2026-10-15）

**用户反馈三条**：① AI 投资建议要列明股票 / 场内基金 / 场外基金；② K 线或净值曲线上的买卖标签要有悬浮面板显示具体信息；③ 我的资产列表「当前走势」列没有内容。

| # | 现象与根因 | 修复 | 验证 |
| --- | --- | --- | --- |
| ① | 建议列表只显示 \`市场 · 代码\`，类型只在详情弹窗里有 | 新增 \`InstrumentTypeTag\`（**空心 + 彩色圆点**，与实心市场色标外形区分）：股票银 / 场内基金金 / 场外基金粉。用于 AI 投资建议列表 + 我的资产 / 我的标的的类型列 | 无头渲染断言三种 class 与文案 + CSS 配色断言 + 三个页面源码断言（建议列表明确断言 \`<InstrumentTypeTag type={item.type}>\`） |
| ② | K 线 / 净值曲线都是 \`trigger: 'axis'\`，鼠标落在买卖 pin 上时只弹坐标轴提示，看不到成交明细 | 新增 \`charts/tradeMarkers.ts\`：把当天买卖点**合并进坐标轴面板**（份额 / 价格 / 金额 / 费用 / 备注），pin 自身也保留 tooltip；\`markersFromTransactions\` 补上 amount / fee / note；净值图补 \`currency\` prop。用 \`params[0].dataIndex\` 回查原始点（不解析 ECharts 的 data 形状，避免 candlestick 数组差异） | 单测：当天匹配、买入/卖出文案、费用行、**备注 HTML 转义**、越界 dataIndex 返回空串、净值分支；源码断言两个图表都接上 formatter 且净值图传了货币 |
| ③ | 「当前走势」取 \`asset.spark\`，它**只在刷新行情时写入**；若某次刷新时序列接口失败，价格会更新而 spark 仍为空 —— 那一列就一直是空白 | 我的资产页对齐我的标的页：进页面时若**缺走势或行情超过 5 分钟**自动补刷一次（\`autoRefreshed\` 防重入），保留手动「刷新行情」；无走势时显示「待刷新」占位而不是空白 | 源码断言（\`missingSpark\` / 5 分钟阈值 / 占位文案）；**线上实测**：4 个资产的 \`spark\` 从 \`[]\` 变为 18–23 个点 |

**顺带修掉的自身缺陷**：\`tradeMarkers.ts\` 初版有一处模板字符串写坏（\`「D»\` 未还原成 \`$\`），备注那一行渲染成字面量 \`{escapeHtml(marker.note)}\` —— **备注转义单测当场抓到**，已修复并复验。

**验证**：\`npm run typecheck\` ✅ / \`npm run build\` ✅ / \`npm test\` ✅（server 219 + web 62 = **281 项全绿**）。
**线上（8787）**：产物含 \`.type-tag.type-stock/etf/fund\`、买卖点面板 HTML（「成交份额」「成交金额」）、「待刷新」占位；\`/api/assets\` 的 4 个资产 spark 均已有 18–23 个点。

**仍未验证**：真实浏览器观感（ECharts 悬浮面板的实际排版、标签与 pin 的重叠），需人工确认。

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
