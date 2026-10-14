# 独立验证报告（docs/VERIFY-REPORT.md）

## 8. 最终复验（第三轮，2026-10-14）

> 执行人：`verifier`（task-14，最终定向复验）。执行时间：2026-10-14 13:39 – 14:00（Asia/Shanghai）。
> **方法**：不采信实现者自述。所有修复项均由本人重新构造场景复现；SSE/并发类结论一律走**真实 HTTP**（进程内 `app.listen` 于非默认端口 `8931` + 真 `fetch`），因为 `app.inject` 对 `reply.hijack()` 的流式响应**不还原 body**（本轮实测：同一场景 inject 返回的事件数为 0、而真实 HTTP 返回完整序列 —— 这是**我的工具差异**，非产品问题，记此以免误导后续验证者）；数据库结论用 `node:sqlite` 直读核对。
> **结论一句话**：**D1–D7 全部修复并复验通过（7/7）**，全部命令门禁为绿，S1/M1–M5/L2–L10 无回归；仅剩 4 项**低级**文字/清理类问题，不阻断交付。→ **最终结论：可交付。**

### 8.0 被验证版本

| 文件 | hash | mtime |
| --- | --- | --- |
| `packages/server/src/services/pipeline-lock.ts`（新增） | `FDE393220FA9` | 13:26:05 |
| `packages/server/src/services/scheduler.ts` | `A8B0D443136B` | 13:26:33 |
| `packages/server/src/services/portfolio.ts` | `BD856742CF0D` | 13:25:06 |
| `packages/server/src/services/fx.ts` | `9E2DA4BF012C` | 13:27:39 |
| `packages/server/src/routes/advice.ts` | `D7841CB30889` | 13:25:24 |
| `packages/server/src/routes/agent.ts` | `2744CA2D09D2` | 13:27:01 |
| `packages/server/src/routes/assets.ts`（Lead 去重复实现） | `0566E4A91BAB` | 13:33:36 |
| `packages/server/src/routes/settings.ts` | `DB6FDEEB5421` | 13:25:48 |
| `packages/shared/src/types.ts`（Lead 改） | `0EBBBDB97EA3` | 13:24:36 |

### 8.1 命令矩阵（第三轮实测）

| 命令 | 结果 | 关键数字 |
| --- | --- | --- |
| `npm run typecheck` | ✅ exit 0 | 三包 0 类型错误 |
| `npm run build` | ✅ exit 0 | `created dist/assets in 13.4s` |
| `npm test` | ✅ exit 0 | server **48 passed / 0 failed**、web **9 passed / 0 failed** |
| `npm run check:deploy` | ✅ exit 0 | 24/24 |
| `npm run smoke` | ✅ exit 0 | **64 项：通过 64，告警 0，失败 0**（含 5 条哨兵 Key 断言） |
| `npm run probe:sources` | ⚠️ 12/14 OK（exit 0） | FAIL：东财**报价**(A股)、Yahoo 403（均为环境侧） |
| smoke 后残留 | ✅ 0 个 | `.smoke-data-*` 无残留 |
| `api.test.ts` 编码完整性 | ✅ | `FFFD 0 roundtrip true`（无 U+FFFD，UTF-8 往返字节一致） |

### 8.2 逐条复验（D1–D7）

#### ✅ D1 —— advice confirm 接入同源账本校验（**通过**）

| 断言 | 实测 |
| --- | --- |
| 倒填卖出（买 2026-10-01 / 卖 2026-09-01） | **409 CONFLICT**，文本 `该卖出日期早于可用持仓形成时间（2026-09-01 卖出 1 份，当时仅有 0 份）` |
| 不落库 | `txs=1`（不变）、`shares=10`、`realizedPnl=0`；建议状态仍为 **pending**（无半写） |
| 超卖（持 10 卖 20） | **409 CONFLICT**（不再是 400），文本 `卖出份额 20 超过当前持仓 10` |
| 正常买入确认 | **200**，资产 `shares 10 → 15`，`advice.status=confirmed` |
| 与 assets 交易路径**逐字一致** | 倒填：两路径 message **完全相同**（`identical = true`）；超卖：两路径 message **完全相同**（`identical = true`）—— 证明 Lead 删除 `assets.ts` 内重复实现、统一 import 后两条写入路径行为一致 |

#### ✅ D2 —— 预算口径（`budget=0` 即「本月不投」）+ 买入门禁（**通过**）

全新数据库、干净市场实测（括号内为任务期望）：

| 场景 | 实测 |
| --- | --- |
| CN `budget=0`，无买入 | `budget=0 spent=0 remaining=0 exhausted=true usedPct=100`（期望 0/0/0/true/100）✅ |
| CN `budget=0`，买 10@10 | `0 / 100 / -100 / true / 100`（期望 0/100/-100/true/100）✅ |
| CN `budget=1000`，买 10@10 | `1000 / 100 / 900 / 10 / false`（期望一致）✅ |
| 再卖 5@200 | `spent` 保持 **100**（卖出不释放）✅ |
| CN `budget=50`，买 1000 | `50 / 1000 / -950 / true / 2000`（期望一致）✅ |
| `/api/budget` vs `/api/advice.budget` | 深度相等 **true** ✅ |

**买入建议门禁（用真实 `create_advice` tool handler 驱动，非读代码）**：
`CN budget=1000, spent=0` → `ok=true`（放行）；`HK budget=0` → `ok=false`，`summary="HK 预算已用尽，拒绝买入建议"`，`content.error=budget_exhausted`、文本「当月 HK 预算 0 HKD，已用 0，剩余 0。本市场不得再新增买入建议」；`HK budget=0` 的**卖出**建议 → `ok=true`（卖出不受限）。门禁确实由 `exhausted` 驱动且 `budget=0` 立即生效 ✅

#### ✅ D3 —— 流水线互斥下沉（**通过**，真实 HTTP SSE）

| 场景 | 实测 |
| --- | --- |
| 锁被他人持有时 `POST /api/agent/run-now` | HTTP 200，SSE 序列 = **`error > run-finished > done`**（**无 `run-started`**）；`agent_runs 0→0`、`advice 0→0`（**不写库**）；busy 文本含「已有 AI 流水线正在运行」 |
| 锁被持有时调度器 tick | 抛 **`PipelineBusyError`**（跳过本次 tick，不排队） |
| 串行两次手动 run | 两次都拿到锁，各自完整序列（19 事件）；`runs 0→3 → 6`，证明 **LLM 401 报错后锁已释放** |
| **并发**两次手动 run | A = `error>run-finished>done`（被拒），B = 完整 `run-started…run-finished>done`；`runs 6→9`，**增量 = 3（不是 6）** ✅ |
| 锁内抛异常 | 异常正常向外传播，且 `isPipelineRunning()=false`（`finally` 释放）✅ |
| 事件类型合规 | 全部落在 `AGENT_EVENT_TYPES` 内，`unknownTypes=[]`；单流多组 `run-started…run-finished` 与 `docs/API.md:28` 一致 |

#### ✅ D4 —— 字面量掩码被拒（**通过**）

`PUT /api/settings {dataSources:{stockUS:{apiKey:"****"}}}` → **400**，消息「掩码值不能作为 API Key 保存（请填写真实 Key，或省略该字段以保持不变）」；
**直读 SQLite**：拒绝后库内仍是原真 Key `sk-REAL-KEY-R3`（未被覆盖）；随后写入新真 Key → **200** 且库内更新为 `sk-REAL-KEY-R3-2`；响应 `apiKeyMasked="****"`、`hasApiKey=true`、无 `apiKey` 字段 ✅

#### ✅ D5 —— `DataSourceChoice` 类型同步（**通过**，含 1 项遗留见 E3）

`packages/shared/src/types.ts:84-98` 现声明 `apiKey?`(请求) + `hasApiKey?`/`apiKeyMasked?`(响应)；运行时槽位键 = **`["provider","enabled","hasApiKey","apiKeyMasked"]`**，与之逐字段一致；`npm run typecheck` 三包全过 ✅
（遗留：前端仍保留多余的本地类型与强转，见 **E3**，不影响类型检查与运行。）

#### ✅ D6 —— 回退汇率不落 kv、短 TTL 内恢复（**通过**）

| 步骤 | 实测 |
| --- | --- |
| 断网（两条腿都失败） | `source=fallback`，`rates={"CNY":1,"HKD":0.92,"USD":7.1}` |
| **直读 kv** | `kv = ""` → **fallback 未落库** ✅ |
| 恢复网络后立刻（0s，不重启、不手动 invalidate） | 仍 `fallback`（内存 TTL 生效，符合预期） |
| 恢复网络 **65s 后**（不重启、不手动 invalidate） | **`source=live`**，`rates={"CNY":1,"HKD":0.858,"USD":6.6914}` ✅（`FX_FALLBACK_TTL_MS=60s` 自行到期后重新取数） |
| 直读 kv（live 之后） | 存在 `{"source":"live",...}` → **只有 live 长缓存** ✅ |

#### ✅ D7 —— 执行期间 `nextRunAt` 永不过期（**通过**）

`intervalMinutes=1` 武装后，以 **250ms 间隔连续采样 `/api/dashboard` 的 `signals.nextRunAt` 共 341 次**，覆盖定时 tick 触发窗口：

```
samples=341  null=0  inThePast=0  min(nextRunAt-now)=+165ms  pastExamples=[]
D7 verdict: PASS — never a past time
auto-run: agent_runs 12 -> 15 (该 tick 真实产出一组流水线 = 3 条 run)
```

即：触发前冻结真实定时器值、运行中前向投影、运行后重新武装——三种状态**均未出现过期时间**；同时该 tick 真实跑完了一整条流水线（M1 的自动运行特性也未回归）。

### 8.3 回归抽查（本轮全部实跑）

| 项 | 结果 |
| --- | --- |
| **S1** 明文 Key | 10 个出口（settings / PUT 响应 / data-sources / backup 导出 / 快照响应 / 快照内容 / 错误体 / dashboard / runs / chat）**leaks=0** ✅ |
| **M1** 定时任务 | 值稳定且恒为未来（341 次采样 0 过期）、1 分钟 tick 真实执行 ✅ |
| **M2** 预算 | 干净市场逐项符合；卖出不释放（4800→4800）✅ |
| **M3** 非法日期 | `2026-13-45`/`2026-02-30`/`2026-02-29`→400；`2028-02-29`/`2026-02-28`→200（5/5）✅ |
| **M4** 汇率 | 整表回退 + 仅 live 落 kv + 交叉校验（第二轮 5 场景）+ 本轮 fallback/live/kv 行为 ✅ |
| **M5** 账本 | 删买入→**409** 且 `realizedPnl=160` 保持；超卖→**409** ✅ |
| **L2** `dailyTime` | `25:99`/`08:60`→400；`23:59`/`00:00`→200 ✅ |
| **L3** 状态码 | 股票当基金→**502**；真基金→200（`kind=nav`，243 点）；不存在→**404**；参数错→**400** ✅ |
| **L9/L10** | smoke 64/64（5 条哨兵断言）+ 运行后 0 残留 ✅ |
| 端点全量抽查 | 30/30 符合预期（含 watchlist 增删清空、chat 会话增删、backup 导出/快照/列表、agent runs/tools、market 全系列、`/api/nope`→404）✅ |
| 测试编码完整性 | `api.test.ts` `FFFD 0`、UTF-8 往返一致 ✅ |
| **chat 与流水线并发写同一份数据** | **会**：持锁期间以 chat 语义调用 `create_advice` **成功写入** `advice` 行（2→3）；`loop.ts:36` 给 chat 授予 `["asset","watchlist","advice","briefing"]` 写权限，故 chat 写入**不受流水线互斥保护** —— 属 Lead 明示的设计取舍，见 **E4**（低） |

### 8.4 仍存在 / 新发现的问题（全部低，不阻断）

| # | 标题 | 现象与证据 | 涉及文件:行号 |
| --- | --- | --- | --- |
| E1 | `docs/API.md` 未记录流水线互斥语义 | 实测手动入口在锁被占用时返回 **200 + SSE `error`/`run-finished(error)`/`done` 且不写库**，但 §4/§6/§9 只写「手动触发一次完整流水线」，未写"与定时 tick 互斥、被拒时的表现"。建议补一句（含 busy 文案） | `docs/API.md:143`、`packages/server/src/services/pipeline-lock.ts:30` |
| E2 | `portfolio.ts` 的 JSDoc 仍是旧口径 | 同文件 `:339-340` 注释写 `exhausted = budget > 0 && spent >= budget`／`usedPct = ... : 0`，而 `:379-380` 的实现与 `docs/API.md:108-109` 已改为 `remaining <= 0`／`... : 100` | `packages/server/src/services/portfolio.ts:339-340` |
| E3 | 前端残留多余的本地类型 + 强转 | `types.ts:94-97` 已声明 `hasApiKey?`/`apiKeyMasked?`，但 `SettingsDataSources.tsx` 仍定义 `SlotKeyFields` 并 `choice as DataSourceChoice & SlotKeyFields`，属 dead workaround（不影响 typecheck/运行） | `packages/web/src/pages/SettingsDataSources.tsx:33-35,55` |
| E4 | chat 写入不受流水线互斥保护（已知设计） | 复现：`runExclusive('holder', sleep)` 持锁期间调用 chat 语义 `create_advice` → `ok=true` 且 `advice` 行 2→3。后果有界：新增一条独立 `batchId` 的 pending 建议、`aiSummary`/简报为最后写入者覆盖。建议在文档或代码注释中显式写明该取舍 | `packages/server/src/agent/loop.ts:36`、`packages/server/src/routes/chat.ts`（不在锁内） |

**已修复项复核**：第二轮 §7.4 的 D1–D7 **全部确认修复**；第一轮 S1–M5 与 L1–L10 亦全部保持修复状态（L1 仍为 `docs/VERIFY.md:205` 记录的已知未修项，不属本轮范围）。

### 8.5 最终交付结论

### 最终结论：**可交付**

**理由**：
1. 三轮验证的**全部阻断项与中级别缺陷均已闭环**：第一轮 S1（密钥明文外泄）/M1（定时任务不生效），第二轮 D1（confirm 漏账本校验）/D2（预算 0 无限买入）/D3（手动入口并发），本轮均由我独立构造场景复现并确认修复，且**修复不引入回归**。
2. **工程门禁全绿且数字可复现**：`typecheck` 0 错误、`build` 成功、`npm test` server **48/48** + web **9/9**、`check:deploy` **24/24**、`npm run smoke` **64/64**、`probe:sources` 12/14（余 2 项为网络环境）、仓库无临时残留、测试文件无编码损坏。
3. **安全边界经对抗验证**：本轮 10 个出口（第二轮 11 个出口）0 明文命中（含备份导出与快照文件）、槽位全遮罩、DB 真 Key 不被掩码覆盖、掩码回填被 400 拒绝、目录逃逸 12 种 payload 全部 4xx。
4. **账本与预算正确性经双路径一致性与干净场景验证**：assets 交易与 advice 确认两种写入路径冲突消息逐字一致；预算 `budget=0` 语义与买入门禁一致；卖出不再释放预算。
5. 仅剩 4 项低级文字/清理类问题（E1–E4），**不影响功能、安全与数值正确性**，可在后续维护中顺手清理。

**仍需在真实环境验证的事项（本机无法验证，非缺陷）**：
1. **Docker 镜像本身**：本机无 Docker，`docker build` / `docker compose up` 未执行；已用「Dockerfile/compose 静态检查 24/24 + 运行期依赖闭包复现（`npm ci --omit=dev` 后仅用生产依赖真实启动并返回行情与 `index.html`）」作等价证据。仍需在真机验证：镜像构建、Alpine(musl) 运行、`tini` 信号转发、`/data` 卷持久化、非 root 文件权限、HEALTHCHECK 生效。
2. **真实 LLM 成功路径**：本轮仅用无效 Key 验证失败路径与 SSE 事件契约（401 快速失败 + 锁释放 + 事件序列合规）。真实模型的工具调用闭环、建议写入、`aiSummary` 质量未验证。
3. **被本网络屏蔽的数据源**：Yahoo(403)、Stooq、新浪、DuckDuckGo；东财 push2 报价在本网络部分时段返回 502（网关侧）——对应 Provider 只能在其他网络验证。
4. **多副本/多容器部署**：`pipeline-lock` 是**进程内**互斥（`pipeline-lock.ts:17` 已注明），多副本同时跑流水线时互斥失效；当前部署模型为单容器 + 单文件 SQLite，符合设计前提，如需水平扩展需改为数据库级锁。
5. **浏览器交互**：拖拽缩放、弹窗等前端交互仍只有无头渲染 + 打包验证，无真机浏览器操作验证。

---

> ⚠️ **第 7 节（第二轮）及第 1–6 节（第一轮）为历史记录，保留备查**：
> §7.4 的 **D1–D7 已在第三轮修复并复验（见 §8.2）**；§7 结论「有条件可交付」与 §6 结论均已由 **§8.5 的「可交付」** 取代。
> §7.2 中 **M5「部分通过」** 的缺口（advice confirm 路径）已由 D1 修复并在 §8.2 复验为**通过**。

---

## 7. 复验（第二轮，2026-10-14）

> 执行人：`verifier`（task-11，定向复验）。执行时间：2026-10-14 13:14 – 13:33（Asia/Shanghai）。
> **方法**：不采信实现者自述，全部结论由本人重跑命令 / 重打接口 / 直读 SQLite 得出；关键结论在「真实 HTTP」与「进程内 Fastify `app.inject`（当前 dist）」两路互验。
> **结论一句话**：第一轮的 1 严重（S1）+ 1 核心功能失效（M1）**已修复并复验通过**，M2/M3/M4/L2–L10 亦通过；
> 但复验新发现 **3 个中级缺陷**（D1 建议确认路径未接入账本校验、D2 预算=0 变成"无限预算"、D3 手动 AI 入口绕过流水线互斥）与 4 个低级别项，故更新为 **有条件可交付**。

### 7.0 复验版本与被验证文件

验证期间实现者已停止改动，dist 由本轮 `npm test`/`npm run smoke` 重建；下表为被验证源码的 SHA256 前 12 位。

| 文件 | hash | mtime |
| --- | --- | --- |
| `packages/server/src/routes/settings.ts` | `F56C903B88E5` | 13:03:24 |
| `packages/server/src/routes/assets.ts` | `1919DA8BB4BA` | 12:50:24 |
| `packages/server/src/routes/advice.ts` | `CA0C9C8B300E` | 12:46:11 |
| `packages/server/src/routes/dashboard.ts` | `40E98E8E39B6` | 12:41:51 |
| `packages/server/src/routes/market.ts` | `D2194505B07C` | 12:48:42 |
| `packages/server/src/db/util.ts` | `9BF333D73130` | 12:43:21 |
| `packages/server/src/services/portfolio.ts` | `0A3C3A0FD96D` | 12:41:02 |
| `packages/server/src/services/fx.ts` | `15EBA60B68E2` | 12:43:05 |
| `packages/server/src/services/scheduler.ts` | `7BEBDB2FF4CA` | 12:40:55 |
| `packages/server/src/registry.ts` / `index.ts` | `38FDFF482C75` / `8754C588C1F0` | 12:37:58 |
| `scripts/smoke-api.mjs` | `4A4F3F07CD39` | 12:40:20 |

### 7.1 命令矩阵（第二轮实测）

| 命令 | 结果 | 关键数字 |
| --- | --- | --- |
| `npm run typecheck` | ✅ exit 0 | 三包 0 类型错误 |
| `npm run build` | ✅ exit 0 | `created dist/assets in 13.3s` |
| `npm test` | ✅ exit 0 | server **39 passed / 0 failed**（与 Lead 一致）、web **9 passed / 0 failed** |
| `npm run check:deploy` | ✅ exit 0 | 24/24 通过 |
| `npm run smoke` | ✅ exit 0 | **合计 64 项：通过 64，告警 0，失败 0** |
| `npm run probe:sources` | ⚠️ 10/14 OK（exit 0） | OK：东财 K线/搜索/F10/分红/宏观/指数、天天基金净值+详情JS、腾讯、Bing；FAIL：东财**报价**(A/港/美) 返回 502 Bad Gateway（网关侧，环境）、Yahoo 403 |
| smoke 后残留目录 | ✅ 0 个 | 第一轮遗留的 `.smoke-data-6PUpfg`/`.smoke-data-qucVgB` 已被清扫 |

### 7.2 逐条复验结论（10 项）

#### ① S1 数据源 Key 明文外泄 —— ✅ **通过（0 命中）**

写入哨兵 `llm.apiKey=sk-LLMLEAK-R2-ABCD1234`、`stockUS.apiKey=sk-SLOTLEAK-R2-1111`、`webSearch.apiKey=tvly-WEBLEAK-R2-2222` 后，对 **11 个出口**全文搜索**全部 clean**：
`PUT /api/settings`、`GET /api/settings`、`GET /api/settings/data-sources`、`GET /api/backup/export`、`POST /api/backup/files` 响应、`GET /api/backup/files/:name`、错误响应体、`POST /api/settings/test-llm`、`/api/chat/sessions`、`/api/dashboard`、`/api/agent/runs`（另加服务端 stdout 由 smoke 断言覆盖）。
响应形状：`llm.apiKey=""` + `apiKeyMasked="sk-****1234"`；槽位 `{"provider":"finnhub","enabled":true,"hasApiKey":true,"apiKeyMasked":"****"}`（**全遮罩，符合 Lead 批准的设计**，6/6 槽位与 webSearch 均无 `apiKey` 字段）。

**DB 未被污染 + Key 不丢**（直读 SQLite 核对）：`llm_api_key`/`stockUS.apiKey`/`webSearch.apiKey` 三者均等于哨兵原文；
`PUT` 仅换 provider（不带 apiKey）→ Key 保留 ✅；`PUT apiKey:""` → 保留 ✅；`PUT apiKey:null` → 清空 ✅。
`POST /api/backup/files` 快照与 `/api/backup/export` 均不含哨兵 ✅。

#### ② M1 定时任务 —— ✅ **通过（含真实自动运行）**

以 `mode=off` 启动：`scheduleEnabled=false` / `nextRunAt=null` ✅。
`PUT` 打开 `interval=5`：`scheduler.nextRunAt()=2026-10-14T05:24:15.209Z`，**连续 3 次 `/api/dashboard` 读取完全一致**且**等于真实定时器值**、且为未来时间 ✅（证明读的是定时器而非每次以 now 重算）。
改回 `off` → 双双 `null` ✅。改为 `daily 08:30` → `2026-10-15T00:30:00.000Z`，与本地"下一个 08:30"逐毫秒相符、多次读取稳定 ✅。
`intervalMinutes=1`：武装后 **60 秒真实自动跑了一次**（`/api/agent/runs` 从 0→1，新记录 `kind=asset-analysis, status=running`），并已重新武装 ✅。

#### ③ M2 预算口径 —— ✅ **通过**

`budget=1000` + 买 10@10 → `spent=100 / remaining=900 / usedPct=10 / exhausted=false` ✅；
再卖 5@200 → **仍为 `spent=100 / remaining=900`（卖出不释放预算）** ✅；
`budget=50`（已花 100）→ `remaining=-50 / usedPct=200 / exhausted=true` ✅；再买 1000 → `spent=1100 / remaining=-1050 / exhausted=true` ✅；
`/api/budget` 与 `/api/advice.budget` **深度相等 = true** ✅。
（`budget=0` 例外见 D2。）

#### ④ M3 非法日期 —— ✅ **通过**

`assets` / `assets/:id/transactions` / `advice/:id/confirm` **三条路径**均：`2026-13-45`、`2026-02-30`、`2026-04-31`、`2026-00-00`、`2026-99-99`、`2026-10-32`、`2026-02-29`(非闰年) → **全部 400**；`2028-02-29`(闰年)、`2026-02-28`、`2026-12-31` → **全部 200**（共 30 次断言，0 例外）✅。

#### ⑤ M4 汇率整表回退 —— ✅ **通过（5 场景）**

用桩替换 FX 取数，精确构造"只失败一条腿"：**A** USD 实时 6.6914 + HKD 抛错 → 返回**整表内置** `{USD:7.1, HKD:0.92}`（**未混用**），warning 明写"未混用实时与内置值" ✅；
**B** 两条腿都"成功"但 HKD 误标为 1.0 → 交叉校验捕获 `USD/HKD=6.6914` → 整表回退 + 异常告警 ✅；
**C/E** 两条腿合理（6.6914/0.858、6.5/0.8333）→ **正确采用实时值**（证明实时路径未被误杀）✅；
**D** HKD=0.5 → 告警 + 整表回退 ✅。隐含 USD/HKD 实测始终为 **7.717（回退）或 7.799/7.800（实时）**，全部落在 7.4–8.2 ✅。
（我的首轮桩脚本曾误清 `fx.rates.v2` 而缓存键已升为 `fx.rates.v3`，导致假阴性；已修正键名后重跑，上表为修正后结果。）

#### ⑥ M5 账本一致性 + 同类问题 —— ⚠️ **部分通过（assets 路径通过，confirm 路径未覆盖 → D1）**

① 买 10@100 → 卖 8@120（realizedPnl=160）→ **删除那笔买入：409**，`realizedPnl` 保持 **160**、交易数保持 **2** ✅；
② 倒填卖出（买 10-10、卖 10-05）→ **409 CONFLICT**「早于可用持仓形成时间」✅；
③ 同日 买10 → 卖5 → 卖5 → 再卖1 → **200/200/409** ✅；
④ 先删卖出（200）再删买入（200）✅；超卖（持 10 卖 11）→ **409** ✅（语义统一已生效）。
**未通过**：`POST /api/advice/:id/confirm` 路径**未接入**上述任一道校验 → 见 **D1**。

#### ⑦ L2 `dailyTime` 范围 —— ✅ **通过**

`25:99`→400、`08:60`→400、`12:60`→400、`12:5`→400、`""`→400、`abc`→400；`23:59`/`00:00`→200。错误信息为「需为合法的 24 小时时间（00:00–23:59）」✅。

#### ⑧ L3 状态码统一 —— ✅ **通过**

股票代码当基金 `CN/600519&type=fund` → **502 UPSTREAM_ERROR**（`/api/market/profile` 与 `/api/market/detail` 一致），`details` 列出原因（`场外基金详情不可用（pingzhongdata 无数据）`）✅；
真基金 `CN/000001&type=fund` → **200**，`fundInfo.nav=1.161`、`series.kind=nav`、`points=243` ✅；不存在的代码 → **404 NOT_FOUND** ✅；参数错误 → **400 BAD_REQUEST** ✅。
说明：502 响应体采用 §0 统一错误信封（原因在 `details`），而非 200 响应里的 `fundInfo=null + warnings`；两者均符合 `docs/API.md` §0/§8。

#### ⑨ L4–L8 文档对齐 —— ✅ **通过**

`docs/ARCHITECTURE.md` 已无 Vite/esbuild/tsx/`/api/portfolio`/`vite.config.ts`/`agent/sessions.ts`/`db/index.ts`，改为 `tsc + Rollup`、`scripts/run-tests.mjs`（§1/§2/§6），并新增 §5：pin = **优先 + 不可用自动降级**、汇率**整表回退**、`llm.apiKey` 与 `dataSources.*.apiKey` 一视同仁脱敏 ✅。
`docs/API.md`：§1 `health` 含 `webBuilt`(39)、§0 枚举型列表裸数组 vs `{items,total}`(14)、§0 单流多组 `run-started…run-finished`(29)、§0/§2 明文 Key 永不返回(18/45)、§6 预算新口径 5 条(105–109)、§4 卖出两类 409(69/70)、§2 `probe` 返回裸数组(49) 均已写明 ✅。
设置页 UI 文案也已从「只使用该数据源」改为「优先使用…不可用会自动降级」（`SettingsDataSources.tsx:116`）✅。

#### ⑩ L9/L10 —— ✅ **通过**

`npm run smoke` 现有 **5 条肯定式断言**：「哨兵 Key 写入成功」+「明文 Key 未从 GET /api/settings / data-sources / backup/export / POST backup/files 响应 / GET backup/files/:name 泄漏」→ 64/64 全绿（第一轮那种"只测默认无 Key"的假阴性已消除）✅。
smoke 结束后仓库根 **零 `.smoke-data-*` 残留**，且第一轮遗留的两个目录也被清掉 ✅。

### 7.3 回归抽查面

| 抽查项 | 结果 |
| --- | --- |
| `docs/API.md` 端点全量重打（26 条，含 `/api/watchlist`、`/api/backup/*`、`/api/agent/*`、`/api/chat/*`） | 全部符合预期：24×200 + `/api/nope`→404 + `quote?market=CN`(缺 code)→400，无回归 ✅ |
| 脱敏后设置页保存数据源三种情形（provider 切换 / 留空 / 清空） | 换 provider 不带 key → Key 保留；`""` → 保留；`null` → 清空 ✅ |
| `slots[].current` 是否仍可被前端消费 | 仍提供 `provider`/`enabled`/`hasApiKey`/`apiKeyMasked`，前端 `SettingsDataSources.tsx:48-58` 正是按此消费（含旧响应兜底）✅ |
| 备份导入恢复非敏感设置 | 导入后 `persona`/`budget.CN` 回到备份值（`aggressive/4321` → 备份内 `balanced/50`）✅；且导入不会带回任何明文 Key ✅ |
| watchlist CRUD / 清空 | POST 200（名称补全「腾讯控股」、`initialPrice` 有值）、PATCH 200、GET 200、DELETE `{ok:true,deleted:n}` ✅ |
| chat 会话 CRUD / agent tools / assets refresh / 行情全系列 | 全部 200；`/api/agent/tools` 仍 19 个 ✅ |
| 单测由 28 → **39** | 新增 11 条覆盖本轮修复（日期、账本 409、密钥脱敏、汇率、基金判定）✅ |

### 7.4 新增缺陷（第二轮发现）

#### 🟠 中

**D1. `POST /api/advice/:id/confirm` 未接入 M5 的账本一致性校验（倒填卖出被接受；超卖状态码与契约不符）**
- **现象**：`/api/assets/:id/transactions` 已按契约做两道校验（合计超卖 → 409；按 `tradeDate` 重放后任一时刻为负 → 409），但**建议确认写入交易**的路径完全没有这两道闸，且仍用旧状态码。
- **复现**（进程内 `app.inject` 或真实 HTTP 均可）：
  1. `POST /api/assets {code:"DCONF",market:"CN",type:"stock",shares:10,price:100,tradeDate:"2026-10-01"}`
  2. 直接落一条 `action='sell'` 的 pending 建议（`repo.createAdvice`，或由 AI 生成）
  3. `POST /api/advice/<id>/confirm {shares:1,price:100,tradeDate:"2026-09-01"}` → **200**（期望 409）
  4. `POST /api/advice/<id2>/confirm {shares:20,...}`（持仓仅 10）→ **400 BAD_REQUEST**（`docs/API.md:6` 与 assets 路径均为 **409**）
- **实测原始输出**：
  ```
  confirm sell 20 (held 10) -> 400 code=BAD_REQUEST msg=卖出份额 20 超过当前持仓 10     (docs 409)
  confirm back-dated sell (2026-09-01 < buy 2026-10-01) -> 200 (expect 409) realizedPnl=0 shares=10
  ledger now: txs=2 shares=10 realizedPnl=0
     txs=[["sell","2026-09-01",1],["buy","2026-10-01",10]]
  ```
- **期望 vs 实际**：期望与 assets 路径同源校验并统一 409；实际 200/400，且账本出现"2026-09-01 卖出 1 份（当时 0 份持有）"，该笔卖出的盈亏被静默丢弃（`realizedPnl=0`）——与第一轮 M5 同类后果。
- **涉及文件:行号**：`packages/server/src/routes/advice.ts:104-109`（仍是旧的 `computePosition` 合计判断 + `badRequest`，未调用 `replayLedger`/`conflict`）；对照实现 `packages/server/src/routes/assets.ts:288-320,343-355`；契约 `docs/API.md:69-70,100`（confirm 行未声明校验，建议一并写明）。

**D2. 预算 = 0 的市场被当作"无限预算"（`exhausted=false`、`usedPct=0`），且相对第一轮是行为回归**
- **现象**：`exhausted = budget > 0 && spent >= budget`，于是 `budget=0` 时**永远不 exhausted**，`usedPct` 也恒为 0；而买入建议的门禁（`tools.ts:722`）只判 `exhausted` → 0 预算市场会继续产出买入建议。
- **复现**：`PUT /api/settings {budget:{HK:0}}` → 买 `HK 10@10` → `GET /api/budget`：
  ```
  HK budget=0, spent=100 -> remaining=-100 exhausted=false usedPct=0
  ```
- **期望 vs 实际**：`remaining=-100`（已超支）却 `exhausted=false`、消耗 0% —— 用户把某市场预算设为 0（"这个月不投"）反而得到"无限制买入 + 0% 消耗"的显示；第一轮的 `exhausted = rawRemaining <= 0` 在 budget=0 时是 `true`，所以这是本轮引入的回归（虽然 `docs/API.md:108` 已按新行为改写，但 §6 §109 与 README 的"预算耗尽不再产生买入建议"目的相冲突）。
- **涉及文件:行号**：`packages/server/src/services/portfolio.ts:340`（`exhausted` 定义）、`:341`（`usedPct`）、`packages/server/src/agent/tools.ts:722`（门禁只看 `exhausted`）、`docs/API.md:108`。建议改为 `exhausted = budget > 0 ? spent >= budget : spent > 0`（或门禁改判 `remaining <= 0`）。

**D3. 流水线互斥只覆盖调度器 tick，4 条手动 AI 入口可与之并发执行**
- **现象**：单飞保护只存在于 `scheduler.runPipeline()`；`/api/agent/run-now`、`/api/advice/generate`、`/api/assets/analyze`、`/api/watchlist/analyze` 直接调用流水线，互不排斥，可与定时任务同时写库。
- **复现（并发实测）**：
  ```
  scheduler.runPipeline() x2 concurrently : runs 0 -> 3   (delta 3  = 复用同一 in-flight run，互斥生效)
  POST /api/agent/run-now x2 concurrently : runs 3 -> 9   (delta 6  = 两个独立流水线同时跑了)
  scheduled tick + POST /api/advice/generate concurrently : runs 9 -> 15 (delta 6)
  ```
- **期望 vs 实际**：期望"同一时刻只有一个流水线"（README:300 的语义、避免重复建议与双份 token 消耗）；实际手动入口可并发 → 会产生**两批 advice 记录**（batchId 不同，界面出现重复建议）与重复 `aiSummary` 写入。
- **涉及文件:行号**：`packages/server/src/routes/agent.ts:70-84`（4 条路由直连 `runXxx`/`runFullPipeline`）、`packages/server/src/services/scheduler.ts:96-101,124-128`（互斥仅在此）；建议把互斥下沉到 `runFullPipeline`/`runAssetAnalysis` 或提供 `scheduler.runPipeline()` 统一入口。

#### 🟡 低

| # | 标题 | 现象 / 复现 | 涉及文件:行号 |
| --- | --- | --- | --- |
| D4 | 服务端未拦截字面量掩码 `****` 作为槽位 Key | `PUT /api/settings {dataSources:{stockUS:{apiKey:"****"}}}` → 200 且**库内真的存入 `"****"`**（把已存真 Key 覆盖成假 Key）。当前前端不会发送（读取时 `delete apiKey`、保存时仅在本地输入非空才下发），故仅为加固项：建议服务端拒绝等于掩码串的值 | `packages/server/src/routes/settings.ts:357-358`；前端 `Settings.tsx:32-57`、`SettingsDataSources.tsx:87-91` |
| D5 | 冻结契约 `types.ts` 未同步脱敏后的槽位形状 | 运行时 `dataSources.stockCN = {provider,enabled,hasApiKey,apiKeyMasked}`，但 `packages/shared/src/types.ts:84-103` 的 `DataSourceChoice` 仍是 `{provider?, apiKey?, enabled?}`：既声明了永不返回的 `apiKey`，又缺少实际存在的 `hasApiKey`/`apiKeyMasked` → 前端被迫自造类型并强转 | `packages/shared/src/types.ts:84-103,147`；前端兜底 `packages/web/src/pages/SettingsDataSources.tsx:34-35,55` |
| D6 | 失败/回退的汇率被写入 kv 并缓存满 1 小时 | 一次取数失败后 `{source:'fallback',USD:7.1,HKD:0.92}` 落 kv；实测**网络恢复后仍返回内置常量**（`invalidateFxCache()` 后仅内存失效，kv 仍命中）→ 最长 1 小时用陈旧汇率折算。非本轮引入（TTL 逻辑沿用），但首轮未记录 | `packages/server/src/services/fx.ts:23-24,84-92,126-133` |
| D7 | tick 执行期间 `nextRunAt()` 返回已触发的时刻 | `arm()` 在 `tick()` 的 `finally` 里、即流水线**结束后**才重新武装；期间 `scheduler.nextRunAt()` 仍是本次触发时刻（实测 `re-arm 后 future=false`），`/api/dashboard` 会短暂显示"下次 <已过去的时间>"（时长≈流水线耗时） | `packages/server/src/services/scheduler.ts:104-117,160-164` |

**第一轮遗留（未在本轮修复清单内，属已知）**：`L1` `AIA_OFFLINE=1` 仍不覆盖 `/api/market/*`（只影响仓储侧软桥）。第二轮实测依旧（离线时 `/api/market/quote|indices|macro|search` 仍走网络返回实时数据），实现者已在 `docs/VERIFY.md:205` 明确记为"已知，未修"——本轮不再计为新缺陷。

### 7.5 更新后的交付结论

**结论：有条件可交付（接近可交付）。**

- 第一轮的两个阻断项均已消除并独立复验：**S1 明文 Key 泄漏（11 个出口 0 命中 + DB 保留真 Key + 快照/导出剔除）** 与 **M1 定时任务静默失效（真实定时器驱动、值稳定可信、1 分钟实测真跑）**；M2/M3/M4 与 L2–L10 亦全部通过，工程门禁全绿（typecheck 0 / build OK / 37→**48** 个测试全绿 / deploy 24/24 / smoke 64/64）。
- 当前**无严重（阻断）缺陷**；仍存 3 个中级：**D1**（建议确认路径漏校验 → 可造出"无对手方卖出"并静默丢盈亏、超卖 400≠契约 409）、**D2**（预算 0 = 无限买入 + 0% 消耗显示）、**D3**（手动 AI 入口与定时任务可并发 → 重复建议）。三者都有明确修复点（D1 复用 `replayLedger`+`conflict`，约 10 行；D2 改一处 `exhausted` 定义/门禁，约 1–3 行；D3 把互斥下沉到流水线入口），改完可升为**可交付**。
- 若产品接受"把 D2 视为设计口径（已有 `docs/API.md:108` 明文）、D3 记为已知限制"，则在补齐 D1 后即可交付；但**建议在交付前至少修掉 D1**，因为它破坏了本轮刚建立的账本一致性保证。
- 仍未验证项（环境限制，非缺陷）：`docker build` / `docker compose up`（本机无 Docker，仅静态检查 + runtime 依赖闭包等价复现）、Yahoo 及相关被屏蔽数据源、真实 LLM 输出质量（本轮用无效 Key 只验证了失败路径与事件契约）。

---

> ⚠️ **第一轮（task-5）原始记录，保留备查**：以下第 1–6 节为 2026-10-14 12:19–12:36 的第一轮结论。
> 其中 **S1、M1、M2、M3、M4、M5、L2、L3、L4、L5、L6、L7、L8、L9、L10 已在第二轮修复并复验（见上方 §7）**；
> **L1 仍未修**（已在 `docs/VERIFY.md:205` 记为已知）；第二轮新发现 **D1–D7**（见 §7.4）。下方 §6 的"有条件可交付"结论已被 §7.5 取代。

---

> 执行人：`verifier`（independent / adversarial verifier，task-5）
> 执行时间：2026-10-14 12:19 – 12:36（Asia/Shanghai）
> 结论一句话：**有条件可交付** —— 工程骨架与契约一致性非常好（命令全绿、DTO 零偏差、目录逃逸/无 Key 路径/账本数学/XSS 均通过），
> 但存在 **1 个严重安全问题（数据源 API Key 明文外泄）** 与 **1 个核心功能静默失效（定时任务）**，必须修复后再交付。

---

## 1. 环境与被验证版本

| 项 | 值 |
| --- | --- |
| 工作目录 | `C:\Users\renjiangfeng\Documents\AI Project\AIInvestmentAdvisor`（无 `.git`，非 Git 仓库，故用文件哈希固化版本） |
| Node / npm | v24.19.0 / 11.17.0 |
| Docker | **本机未安装，`docker build` / `docker compose up` 未执行**（见 §2.5） |
| 网络 | 东方财富(K线/搜索/F10/分红/宏观/指数)、腾讯、Bing 可用；**东方财富 push2 报价、天天基金净值、Yahoo、Stooq、新浪、DuckDuckGo 本次不可用** |

**被验证的源码版本（SHA256 前 12 位 / 最后修改时间）**：验证期间实现者仍在改文件（12:24:54 `web/src/api/client.ts`、12:25:16 `server/src/routes/settings.ts`，dist 于 12:25:50 与 12:33:25 两次重建）。因此所有对抗性结论都在 **12:25:16 之后的当前版本** 上重跑过一次。

| 文件 | hash | mtime |
| --- | --- | --- |
| `packages/server/src/routes/assets.ts` | `F15119333673` | 12:11:43 |
| `packages/server/src/routes/settings.ts` | `4BA3BA21AD1F` | 12:25:16 |
| `packages/server/src/routes/advice.ts` | `942BD9B8F800` | 12:12:06 |
| `packages/server/src/db/util.ts` | `37E9A1817BDE` | 12:16:52 |
| `packages/server/src/services/portfolio.ts` | `136443B7E65B` | 11:58:45 |
| `packages/server/src/services/backup.ts` | `EBD47A90437D` | 12:08:48 |
| `packages/server/src/services/fx.ts` | `B4AC1AA1CE63` | 12:14:58 |
| `packages/server/src/services/scheduler.ts` | `6484F85A5D2F` | 12:08:38 |
| `packages/shared/src/types.ts` | `2B3226862472` | 11:45:08 |
| `packages/web/src/pages/SettingsDataSources.tsx` | `ADD8C8E553E6` | 12:12:02 |

**验证方法**：① 真实 HTTP（自起临时服务 `PORT=8901`、`DATA_DIR=./.verify-data`，全程未触碰默认 `data/` 与他人进程）；② 当前 dist 的进程内 Fastify `app.inject()` 复核（沙箱会回收后台进程，故关键结论两路互验）；③ 直接用 `node:sqlite` 读临时库核对落库。

---

## 2. 命令原始输出摘要

| # | 命令 | 结果 | 关键数字 |
| --- | --- | --- | --- |
| 1 | `npm run typecheck` | ✅ exit 0 | shared/server/web 三包 **0 类型错误**（12:20 与 12:34 两次） |
| 2 | `npm run build` | ✅ exit 0 | shared→server(tsc)→web(rollup)，`created dist/assets in 13.9s / 13s` |
| 3 | `npm test` | ✅ exit 0 | server **28 passed / 0 failed**（550ms）；web 无头渲染 **9 passed / 0 failed**；合计 **37/37** |
| 4 | `npm run check:deploy` | ✅ exit 0 | compose 11 项 + Dockerfile 11 项 + .dockerignore 3 项 = **24/24 通过** |
| 5 | `npm run check:deploy -- --with-install` | ⚠️ **exit 1（4 项失败）** | 见 §2.5：**环境成因，非产品缺陷** |
| 5b | `node scripts/check-deploy.mjs --with-install`（绕开 npm script 包装） | ✅ exit 0 | 「部署配置检查全部通过」：`npm ci --omit=dev` 成功、`@fastify/static` 就位、`@aia/shared` 工作区链接就位、**仅生产依赖即可启动并返回 `/api/health`+真实行情+`index.html`** |
| 6 | `npm run smoke` | ⚠️ **首次 46 通过 / 0 告警 / 1 失败；复跑 47/0/0** | 失败项：`USD/HKD 隐含汇率符合联系汇率（7.4~8.2） — USD/HKD=7.274`（§3-中5） |
| 7 | `npm run probe:sources` | ⚠️ 9/14 OK（exit 0，仅供诊断） | OK：东财 K线/搜索/F10/分红/宏观/指数、天天基金详情JS、腾讯、Bing；FAIL：东财报价(A/港/美) `fetch failed`、天天基金净值 `fetch failed`(10.2s)、Yahoo 403 |

### 2.5 `check:deploy --with-install` 失败的成因隔离（重要，勿误判为缺陷）

`npm run` 版本必失败：

```
npm error code EALLOWSCRIPTS
npm error --allow-scripts is not allowed in project-scoped installs.
```

`node scripts/check-deploy.mjs --with-install` 直接运行则 **全部通过**。原因已定位到**本机 DSH 宿主配置**：

- `~/.npmrc`（用户级，非本项目）含 `allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs`；
- `npm run` 会把解析后的配置以 `npm_config_*` 注入脚本进程环境，npm 内部的 `resolveAllowScripts()` 把「来自 cli/env 的 allow-scripts」在**项目级安装**中直接判错（`Program Files\nodejs\node_modules\npm\lib\utils\resolve-allow-scripts.js:107-125`）。

项目自身 `.npmrc` 与 `Dockerfile` 都没有 `allow-scripts`，容器内（`node:24-alpine`，无该用户 npmrc）不会触发。
**结论：部署配置本身正确，镜像 runtime 依赖闭包已被等价复现通过；但 Docker 本身仍未验证。**

---

## 3. 缺陷清单

> 复现命令统一约定（先起临时实例，勿动默认 `data/`）：
> ```powershell
> $env:PORT='8901'; $env:HOST='127.0.0.1'; $env:DATA_DIR='./.verify-data'; npm start
> # 另一个终端（curl.exe 在 Windows 自带）
> ```

### 🔴 严重

#### S1. 数据源槽位 API Key 明文外泄（HTTP 响应 + 导出备份 + 快照文件 + 前端输入框回显）

**现象**：`llm.apiKey` 被正确掩码，但 `dataSources` 六个槽位与 `webSearch` 的 `apiKey` **原样返回**。命中面：

- `GET /api/settings` → 明文
- `PUT /api/settings` 响应 → 明文
- `GET /api/settings/data-sources` → `slots[].current.apiKey` 明文
- `GET /api/backup/export` → 明文（导出的 JSON 可被分享/上传）
- `GET /api/backup/files/:name`（服务端快照）→ 明文

**复现**：
```powershell
curl.exe -s -X PUT http://127.0.0.1:8901/api/settings -H "content-type: application/json" `
  -d "{\"dataSources\":{\"stockUS\":{\"provider\":\"finnhub\",\"enabled\":true,\"apiKey\":\"sk-SLOT-LEAK-999\"},\"webSearch\":{\"provider\":\"tavily\",\"enabled\":true,\"apiKey\":\"tvly-SEARCH-LEAK\"}}}"
curl.exe -s http://127.0.0.1:8901/api/settings                 | findstr SLOT-LEAK   # 命中
curl.exe -s http://127.0.0.1:8901/api/settings/data-sources    | findstr SLOT-LEAK   # 命中
curl.exe -s http://127.0.0.1:8901/api/backup/export            | findstr SLOT-LEAK   # 命中
curl.exe -s -X POST http://127.0.0.1:8901/api/backup/files -H "content-type: application/json" -d "{}"
curl.exe -s http://127.0.0.1:8901/api/backup/files/<上一步的 name> | findstr SLOT-LEAK   # 命中
```

**期望 vs 实际**：期望与 `llm.apiKey` 同等对待（只给 `hasKey`/掩码）；实际 5 个出口全部明文。
`README.md:309`「API Key 只保存在本地 SQLite / 环境变量中，**HTTP 接口永远只返回掩码**；导出的备份默认不含 Key」与 `docs/ARCHITECTURE.md:171` 均被违反。

**涉及文件:行号**：
- `packages/server/src/routes/settings.ts:104`（`toSettingsDto` 直接 `dataSources: stored.dataSources` 透传）
- `packages/server/src/routes/settings.ts:275`（`current: stored.dataSources[slot.slot]`）、`:280`（`webSearch: stored.dataSources.webSearch`）
- `packages/server/src/services/backup.ts:91`（`settingsForBackup` 透传 `dataSources`）
- `packages/web/src/pages/SettingsDataSources.tsx:142-144`（前端注释明确假设「`GET /api/settings` 不回传明文 apiKey」）、`:184`（`value={choice.apiKey ?? ''}` 把服务端返回的 Key 直接回显到输入框）

**为什么现有验证没发现**：`scripts/smoke-api.mjs:113` 与 `:210` 的「API Key 不明文返回 / 导出内容不含 API Key」断言只覆盖**默认配置**（默认槽位 `auto`、无 Key），因此永远通过 —— 属**假阴性断言**（见低 L9）。

**风险**：Tavily/Serper/Brave/Finnhub/AlphaVantage/FMP 的 Key 是真实凭证，任何能访问该服务的人（README 建议的反代/内网场景）都能拿到；备份 JSON 通常会被下载、转移、上传，泄露面更大。**必须修**。

---

### 🟠 中

#### M1. AI 定时任务保存后不生效（`scheduler.reload()` 是死代码，界面却显示已排程）

**现象**：默认 `mode=off`；用户到设置页打开「间隔/每日」并保存（`PUT /api/settings` 返回 200、SQLite 已更新），但运行中的调度器**从不重新装载**，`nextRunAt()` 仍为 `null`，流水线在**进程重启前永不运行**；与此同时 `/api/dashboard` 的 `signals` 却报告 `scheduleEnabled=true` 与一个具体的 `nextRunAt`，界面因此「骗」了用户。

**复现（进程内，一次输出即结论）**：
```powershell
# 1) 默认 mode=off 启动服务（index.ts 只调用 scheduler.start()）
# 2) PUT /api/settings {"schedule":{"mode":"interval","intervalMinutes":5,"runAdvice":true}}
# 3) 观察：scheduler.nextRunAt() === null   ← 永不排程
#          /api/dashboard signals.nextRunAt === "2026-10-14T04:38:09.888Z"  ← 界面说已排程
```
实测输出：
```
scheduler.nextRunAt() after start (mode=off)      = null
PUT /api/settings schedule -> 200   stored.mode=interval
scheduler.nextRunAt() AFTER enabling interval     = null        <-- 永不运行
dashboard.signals.scheduleEnabled=true nextRunAt=2026-10-14T04:38:09.888Z  <-- UI 声称已排程
PUT daily -> 200   scheduler.nextRunAt()          = null
```

**期望 vs 实际**：期望保存后重载（`Scheduler.reload()` 的契约注释就是「applies new settings without a restart」）；实际无任何调用方。

**涉及文件:行号**：
- `packages/server/src/services/scheduler.ts:134-138`（`reload()` 实现存在，全仓仅此一处出现，无调用者）
- `packages/server/src/routes/settings.ts:193-225`（`PUT /api/settings` 未通知调度器）
- `packages/server/src/index.ts:37-41`（`scheduler` 未注册进 `setServices`，路由层拿不到）
- `packages/server/src/routes/dashboard.ts:43,128`（`computeNextRunAt` 自己算，与实际调度器状态脱钩）

**影响**：README「功能总览/使用流程 第 6 步」的核心能力（定时自动跑完整流水线）在**唯一可行的操作路径**下静默失效。

#### M2. 预算口径与 `docs/API.md` 冲突：卖出会「回冲」预算，`remaining` 可超过月预算、`usedPct` 为负

**现象**：`spent = buys − sells`、`remaining = budget − buys + sells`，而契约写的是「按自然月统计各市场**买入**成交额」。

**复现**：
```powershell
curl.exe -s -X PUT .../api/settings -H "content-type: application/json" -d "{\"budget\":{\"CN\":1000}}"
curl.exe -s -X POST .../api/assets -d "{\"code\":\"BUD\",\"market\":\"CN\",\"type\":\"stock\",\"shares\":10,\"price\":10,\"tradeDate\":\"2026-10-01\"}"   # 买 100
curl.exe -s .../api/budget     # CN: spent=100  remaining=900   usedPct=10     ✅ 合理
curl.exe -s -X POST .../api/assets/<id>/transactions -d "{\"kind\":\"sell\",\"shares\":5,\"price\":200,\"tradeDate\":\"2026-10-05\"}"   # 卖 5@200 = 1000
curl.exe -s .../api/budget     # CN: spent=-849 remaining=1849 usedPct=-84.9    ❌
```

**期望 vs 实际**：契约要求 `spent` = 本月买入成交额（100）；实际 `spent=-849`、`remaining=1849 > 预算 1000`、`usedPct=-84.9`。
后果不只是显示难看：**同月内可以通过卖出无限「解锁」预算**，`exhausted` 永远为 false，预算约束形同虚设（前端进度条也会显示负消费）。

**涉及文件:行号**：`packages/server/src/services/portfolio.ts:333-343`、`packages/server/src/routes/advice.ts:8-9`（注释自述「buys consume the budget and sells release it」，与 `docs/API.md:96-97` 冲突）。

> 注：实现者可能是有意设计（净买入口径）。但既然 `docs/API.md` 是「冻结契约」，二者必须其一对齐；且**净卖出解锁预算**这一点无论哪种口径都不应无限放大可用预算。

#### M3. 非法日历日期被接受并落库（`2026-13-45` / `2026-02-30` / `2026-04-31` / `2026-99-99` …）

**现象**：`tradeDate` 只做正则形状校验 `^\d{4}-\d{2}-\d{2}$`，不校验月/日取值范围，6 种非法值全部 200 并持久化。

**复现**：
```powershell
curl.exe -s -X POST http://127.0.0.1:8901/api/assets -H "content-type: application/json" `
  -d "{\"code\":\"T5\",\"market\":\"CN\",\"type\":\"stock\",\"shares\":5,\"price\":10,\"tradeDate\":\"2026-13-45\"}"
# 实测：200，firstBuyAt = "2026-13-45"
```
实测 6/6 被接受：`2026-13-45`、`2026-02-30`、`2026-04-31`、`2026-00-00`、`2026-99-99`、`2026-10-32`；同样适用于
`POST /api/assets/:id/transactions`（200，落库 `tradeDate=2026-13-45`）与 `POST /api/advice/:id/confirm`（200，落库）。

**期望 vs 实际**：契约 §0「交易日 `YYYY-MM-DD`」+ 任务清单要求 400；实际 200 落库。
**连带影响（实测）**：预算按 `tradeDate.startsWith(month)` 归月，`2026-10-32` 这种「十月三十二日」会被**计入 2026-10 预算** —— 实测某次 CN `spent=151` 中即包含该笔，等于用非法日期绕过/污染预算统计。

**涉及文件:行号**：`packages/server/src/routes/assets.ts:49`、`:66`；`packages/server/src/routes/advice.ts:34`；`packages/server/src/db/util.ts:119-123`（`isTradeDate`）、`:332`（`tradeDateSchema`）。

#### M4. 汇率「部分降级」混用实时与内置常量，交叉汇率失真，且 `npm run smoke` 间歇性失败

**现象**：当只有一条腿失败时（本次实测 HKD/CNH 失败、USD/CNH 成功），返回 `{USD: 6.6917(实时), HKD: 0.92(内置)}`，隐含 USD/HKD = **7.274**，明显偏离联系汇率带 7.4–8.2；`crossCheck()` 只在 `failures.length === 0` 时执行，因此**没有告警**。

**复现**：连跑两次 `npm run smoke`（同一代码、同一机器）：
```
第 1 次：✗ USD/HKD 隐含汇率符合联系汇率（7.4~8.2） — USD/HKD=7.274
        合计 47 项：通过 46，告警 0，失败 1     EXIT=1
第 2 次：（两条腿都失败 → 全回退）✓ USD/HKD=7.717
        合计 47 项：通过 47，告警 0，失败 0     EXIT=0
```

**期望 vs 实际**：期望部分失败也做交叉校验、或干脆整表回退（避免混用）；实际混用且无告警。
**影响**：① HKD 持仓折 CNY 高估约 7%（内置 0.92 相对当日实时 USDCNH 6.6917 的隐含 HKD≈0.858）；② 项目自己的验收门禁 `npm run smoke` 会随网络抖动变红，CI 不可信。

**涉及文件:行号**：`packages/server/src/services/fx.ts:129-159`（部分失败分支不做 crossCheck、且仍标 `source:'fallback'`）；`packages/shared/src/constants.ts` 的 `FX_FALLBACK_INTO_CNY`；`scripts/smoke-api.mjs:183-187`。

#### M5. 删除「买入」交易会静默吞掉已实现盈亏（无一致性校验）

**现象**：先卖后删买入 → 卖出的成交所得从账本里凭空消失，接口返回 200 且无任何提示。

**复现**：
```powershell
# 1) POST /api/assets            {shares:10, price:100}          -> shares=10
# 2) POST /api/assets/<id>/transactions {kind:sell, shares:8, price:120}   -> realizedPnl=160
# 3) DELETE /api/assets/<id>/transactions/<那笔 buy 的 id>
# 实测返回：200 { shares:0, cost:0, marketValue:0, realizedPnl:0, closed:true }
#           ↑ realizedPnl 由 160 静默变为 0，960 元卖出所得不再出现在任何字段
```

**期望 vs 实际**：期望拒绝（删除后会出现「没有对手方的卖出」）或至少返回警告/标记数据不一致；实际 200 静默重算。
**涉及文件:行号**：`packages/server/src/routes/assets.ts:309-319`（无校验）、`packages/server/src/services/portfolio.ts:70-78`（超出持仓的卖出份额被 `Math.min` + 归零静默丢弃）。

---

### 🟡 低

| # | 标题 | 现象 / 复现 | 涉及文件:行号 |
| --- | --- | --- | --- |
| L1 | `AIA_OFFLINE=1` 对 `/api/market/*` 无效 | 设 `AIA_OFFLINE=1` 后 `/api/market/quote|indices|macro|search|detail` 仍走网络返回实时数据（3193ms/7 个指数/11 条宏观）。该开关只作用于 `loadMarketBridge()`，`routes/market.ts` 直接走 `datasources/registry` | `packages/server/src/db/util.ts:199-208` vs `packages/server/src/routes/market.ts` |
| L2 | `schedule.dailyTime` 只校验格式不校验范围 | `PUT /api/settings {"schedule":{"dailyTime":"25:99"}}` → **200**，库内存 `"25:99"`，调度器 clamp 成 23:59（显示值 ≠ 生效值） | `packages/server/src/routes/settings.ts:84`；`packages/server/src/services/scheduler.ts:18-24` |
| L3 | 同一上游失败在不同接口返回不同状态码 | 同一「取不到报价」：`/api/market/quote`→**502 UPSTREAM_ERROR**；`/api/market/series`→**404**；`/api/market/profile`→**200**（空 quote + warnings） | `packages/server/src/routes/market.ts` |
| L4 | `docs/ARCHITECTURE.md` 严重滞后（会误导后续维护） | §1 写「React 19 + **Vite 7**」；§2 目录列出**不存在的** `packages/server/scripts/build.mjs（esbuild 单文件打包）`、`packages/web/vite.config.ts`、`agent/sessions.ts`、`db/index.ts`；§6 写 `tsx --test` 与 **`POST /api/portfolio`**（实际是 `/api/dashboard`，无该端点）。项目实际为 tsc + rollup + `scripts/run-tests.mjs` | `docs/ARCHITECTURE.md:13,34,39,42,44,177-178` |
| L5 | `GET /api/health` 多返回未在契约中的字段 | 实际 `{ok,version,uptime,dataDir,**webBuilt**}`；`docs/API.md:31` 只列前四个 | `packages/server/src/app.ts:61-67` |
| L6 | §0 列表约定与分节自相矛盾 | §0 写「列表接口响应为 `{items,total}`」，但 `/api/backup/files`、`/api/agent/runs`、`/api/agent/tools`、`/api/chat/sessions`、`/api/market/search|indices|news` 返回裸数组（与各自分节描述一致，是 §0 过宽） | `docs/API.md:14` vs §8/§9/§10 |
| L7 | SSE 单次序列约定与实际不符 | `POST /api/advice/generate`、`/api/agent/run-now` 实测在**同一流内发出 3 组** `run-started…run-finished`（asset-analysis→watchlist-analysis→advice，n=19），而 §0 描述单组；前端 `sse.ts` 容忍，但契约需写明 | `docs/API.md:19-23` vs `packages/server/src/routes/agent.ts` |
| L8 | 显式 pin 的 provider 仍会回退到其它源 | 把 `stockUS` pin 成 `yahoo`（本网络 403）后 `/api/market/quote?market=US&code=AAPL` 仍 200 返回真实价格（3315ms）；而设置页文案称「指定 provider 后该槽位**只使用**该数据源」 | `packages/web/src/pages/SettingsDataSources.tsx:72`；`packages/server/src/datasources/registry.ts` |
| L9 | 冒烟测试的安全断言是假阴性 | `scripts/smoke-api.mjs:113`（只判 `llm.apiKey`）与 `:210`（默认配置下导出根本不含 `"apiKey"`）→ S1 这类泄漏永远测不出来；建议改为「写入哨兵 Key + 全出口全文搜索」 | `scripts/smoke-api.mjs:113,210` |
| L10 | `npm run smoke` 每次遗留 `.smoke-data-*` 目录 | 连跑两次 smoke 后仓库根残留 `.smoke-data-6PUpfg`、`.smoke-data-qucVgB`（各含 453KB WAL）；`fs.rmSync` 失败被静默吞掉 | `scripts/smoke-api.mjs:92-95` |

---

## 4. 对抗性测试：已验证通过的类别（无缺陷也留证据）

### A. 持仓与账本 ✅（除 M3/M5）

| 用例 | 结果 |
| --- | --- |
| `shares:"abc"` / 负份额 / 0 份额 / 负单价 / 负 fee / 缺 `tradeDate` / `market:"XX"` / `type:"crypto"` | 全部 **400**，`details[].path` 定位准确 |
| 移动加权平均：买 100@10 + 买 100@20 | shares=200 **avgCost=15** cost=3000 ✅ |
| 部分卖出：卖 50@30 | shares=150 avgCost=15 **realizedPnl=750** closed=false ✅ |
| 清仓：卖 150@30 | shares=0 cost=0 closed=true realizedPnl=3000（=750+2250）✅ |
| 清仓后再买入 10@99 | shares=10 **avgCost=99**（成本重置）closed=false ✅ |
| 超卖（持仓 0 时卖 1） | **400**，且交易条数 4→4 **未落库** ✅ |
| 重复 `(code,market,type)` | **409 CONFLICT**；同 code 不同 type 允许 ✅ |
| 删除资产级联 | API 404；**直查 SQLite**：asset 行消失、`transactions` 孤儿 0 条、全库孤儿 0 条、`PRAGMA foreign_keys=1` ✅ |
| 交易乱序输入 | 按 `tradeDate` 排序计算 ✅ |

### B. 预算 ✅（除 M2）

| 用例 | 结果 |
| --- | --- |
| 上月交易（`2026-09-15`）不计入本月 | CN spent 保持 0 ✅ |
| 本月买入 10@10 | spent=100 remaining=900 usedPct=10 ✅ |
| 手续费不计入成交额 | HK 买 1@1000 fee=999 → **spent=1000**（非 1999）✅ |
| 预算耗尽 | budget=50、买入 1000 → **remaining=0, exhausted=true, usedPct=200** ✅ |
| `/api/budget` 与 `/api/advice.budget` 逐字段一致 | `JSON.stringify` 深度相等 = **true** ✅ |
| 跨市场币种 | CN=CNY / HK=HKD / US=USD 各自本位币 ✅ |

### C. 安全与健壮性 ✅（除 S1）

| 用例 | 结果 |
| --- | --- |
| `llm.apiKey` = `sk-TEST-LEAK-123456` → `GET /api/settings` / `PUT` 响应 / `/api/backup/export` / 错误响应体 / **服务端 stdout 全文** | 全部 **搜不到明文**；只回 `hasApiKey=true` + `apiKeyMasked="sk-****3456"`，`llm.apiKey=""` ✅（日志 9.3KB 全文 0 命中） |
| 目录逃逸 12 种 payload | `..%2f..%2fpackage.json`、`..%2F..%2F`、`%2e%2e%5c`、`..%5c..%5c`、`..%2f`、`..%2f..%2f.env`、`%00x.json`、`advisor.db` → **400**；`....//package.json` → **404**；`package.json`/`nope.json` → **404**；4000 字符名 → **414**。**全部未返回任何仓库文件内容**（对 `workspaces`/`devDependencies`/`LLM_API_KEY` 等特征串 0 命中）✅ |
| 快照正常路径 | `POST /api/backup/files` → 200；`GET` 列表 → 200；`GET /api/backup/files/<name>` → 200 ✅ |
| 畸形 JSON（带 `content-type: application/json`） | **400**「Body is not valid JSON…」，非 500 ✅ |
| 超大 body | 33MB → **413**「Request body is too large」，**8ms** 返回，无 OOM/挂起；1MB → 200 ✅ |
| 空 body + JSON content-type | 400（Fastify 语义，可接受）✅ |
| XSS | `grep` 全 `packages/web/src`：`dangerouslySetInnerHTML` / `innerHTML` / `outerHTML` / `insertAdjacentHTML` **0 命中**；AI 文本走 React 文本节点，图表走 ECharts/SVG ✅ |
| 注入式查询参数 | `q=%27×50`、`limit=99999999&page=-1`、`limit=abc`、`limit=-5` → 均 200 且安全忽略 ✅ |
| 非法枚举 | `?market=ZZ`、`?dir=bogus`、`?status=bogus` → **400** ✅ |
| 契约密钥：SQLite 存储方式 | `data/*.db`（含 `-wal`）中 `llm_api_key` 与 `data_sources.apiKey` **均为明文**（`settings` 单行）。**这是设计允许的**（README §安全写明只存本地 SQLite），但需明确风险：库文件/WAL/快照一旦被复制即等同交出全部 Key；建议至少在启动时提示文件权限，或对 Key 做静态加密。本环境 `DATA_DIR` 内实测可读出明文。 |

### D. 契约一致性 ✅（差异已全部登记为 M1–M5 / L5–L8）

- **逐条打点**：`docs/API.md` §1–§10 全部 **58 条**（含 404/400 分支）实测，**无「契约写了但未实现」的端点**（`/api/assets/analyze`、`/api/watchlist/analyze`、`/api/advice/generate`、`/api/agent/run-now`、`/api/backup/files*` 等全部存在）。
- **DTO 逐字段比对**：27 个形状（`Settings`+4 子对象、`AssetSummary/AssetDetail/Transaction`、`WatchItem/WatchlistDetail`、`AdviceItem`、`BudgetStatus/MarketBudgetStatus`、`DashboardPayload`+3 子对象、`Quote`、`SeriesResponse/SeriesPoint`、`ProfileResponse/Fundamentals`、`MacroSnapshot`、`NewsItem`、`InstrumentSearchResult`、`AgentRunSummary/AgentRun/AgentStep`、`ChatSession`、`ImportResult`、`BackupPayload`）与 `packages/shared/src/types.ts` 比对：**missing=[] 全部**，唯一 extra 是 `Health.webBuilt`（L5）。`Settings.llm` 响应中 `apiKey` 为 `""`（符合「永不返回明文」）。
- **SSE**：事件类型全部落在 `AGENT_EVENT_TYPES` 内（unknown=[]）；序列 `run-started(0) → progress → step → step → error → run-finished → done(last)` **order_ok=true**；流内**无 API Key**。
- **无 Key 路径**：`POST /api/assets/analyze|watchlist/analyze|advice/generate|agent/run-now` 与 `POST /api/chat/sessions/:id/messages` 全部 **400 `application/json` + `NOT_CONFIGURED`**（不是挂起的 SSE 流）；`/api/agent/runs|tools`、`/api/advice`、`/api/dashboard`、`/api/budget` 在无 Key 时均 200 ✅。
- **工具集**：`/api/agent/tools` 19 个工具与 `docs/ARCHITECTURE.md §4.2` **19/19 完全一致**（missing=[] extra=[]）。
- **配置校验**：`persona`/`reportStyle`/`temperature>2`/`maxTokens<0`/`apiKey` 非串/负预算/预算传串/`schedule.mode` 非法/`intervalMinutes<1`/`watchlistCandidateLimit>100`/provider 非枚举/槽位 apiKey 非串 → **全部 400**；`PATCH /api/watchlist` 的 `qualityScore 200/-5`、`targetPrice -1`、`expectedReturn:"abc"` → **全部 400** ✅。

### E. 降级与可观测 ✅（含 L1/L3/L8）

- `AIA_OFFLINE=1`：`/api/dashboard` 200（indices 降级为空 + 汇率带 warning）、`/api/assets/refresh` 200 `{updated:0,failed:1,warnings:["行情数据源不可用…"]}`、新建资产名称回退为 code —— **无 500、无挂起**。
- 上游不可用：`/api/market/profile?market=US&code=AAPL` 返回可读 `warnings`（`finnhub 未返回报价`、`港美股分红源不可用…`）且不崩；`/api/market/quote` 不可用时 **502 UPSTREAM_ERROR**；港美股基本面自动退化为「估值字段 + 联网检索」符合 `docs/SOURCES.md`。
- 汇率失败：日志有明确 warning 并标注回退（但见 M4 的混用问题）。

---

## 5. 需求覆盖对照表

> 依据 `README.md`「功能总览」（第 31–38 行）与使用流程逐条核对；前端结论均由 `grep` 落在具体文件行号，非仅 UI 存在。

### Dashboard
| 需求 | 结论 | 证据 |
| --- | --- | --- |
| ① 总市值/总成本/浮动盈亏/已实现盈亏 | 通过 | `Dashboard.tsx:106,114,116,122` ← `api.dashboard()`:`21` |
| ② 持有标的数、购买资产数、新标的/新建议信号 | 通过 | `Dashboard.tsx:133,134,139,148,157-163` |
| ③ 持仓 Top5 明细（含 spark） | 通过 | `Dashboard.tsx:178,205,223` |
| ④ AI 持仓简报 | 通过 | `Dashboard.tsx:233-266`；`briefing` 来自 `DashboardPayload` |
| 附：全球指数 + 预算概览 | 通过 | `Dashboard.tsx:272-311`（`api.market.indices` 失败静默回退 payload） |

### 我的资产
| 需求 | 结论 | 证据 |
| --- | --- | --- |
| 19 列表格 | **通过（实测 19 列）** | `Assets.tsx:282-302` 计数：名称/代码/类型/市场/建仓来源/份额/买入单价/当前单价/当日涨跌/当前市值/已实现盈亏/建仓日期/最新买入/最新卖出/浮动盈亏/当前走势/AI 建议/用户备注/操作 = 19 |
| 筛选（市场/类型/来源）+ 搜索 | 通过 | `Assets.tsx:89-92,105,199-206` |
| 排序（表头点击） | 通过 | `Assets.tsx:282,292,293,298`（`SortHeader`） |
| 按市场/类型分列 | 通过 | `Assets.tsx:215-223,308-313`（`groupMode`） |
| 添加资产 | 通过 | `Assets.tsx:227,271` → `AssetFormDialog` → `api.assets.create` |
| 编辑（含补录买卖） | 通过 | `Assets.tsx:361`；`AssetFormDialog.tsx:371,403` → `api.assets.addTransaction` / `removeTransaction` |
| 删除 | 通过 | `Assets.tsx:162,364,400` → `api.assets.remove` |
| 详情浮窗：K 线（可拖动缩放） | 通过 | `KLineChart.tsx:103`（`dataZoom`）、`InstrumentDetailSections.tsx:55` |
| 详情浮窗：买卖点标注 | 通过 | `KLineChart.tsx:130`、`NavChart.tsx:86`（`markPoint`）、`AssetDetailDialog.tsx:165` |
| 详情浮窗：净值曲线 | 通过 | `NavChart.tsx:48-91`、`InstrumentDetailSections.tsx:55` |
| 详情浮窗：基本面 / 基金详情 / 分红 | 通过 | `InstrumentDetailSections.tsx:120,144,198,249` |
| 详情浮窗：AI 分析总结 | 通过 | `AssetDetailDialog.tsx:173,183` |
| 详情浮窗：交易记录（含删单） | 通过 | `AssetDetailDialog.tsx:188`、`:110`（删除后重算） |
| AI 资产分析按钮（财报/基本面/宏观/微观/国际局势） | 通过 | `Assets.tsx:228-236`（`stream.start('/assets/analyze')`）、`:240` |

### 我的标的
| 需求 | 结论 | 证据 |
| --- | --- | --- |
| 列表列（名称/代码/类型/市场/创建方/优质评估/目标价/预期收益/推荐后涨跌/走势） | **通过（附注）** | `Watchlist.tsx:243-252` 为 **10 列表头**（末列为「操作」）；README 列举的 10 项数据字段全部呈现，但**走势不是独立列**，缩略图渲染在「推荐后涨跌」单元格内（`Watchlist.tsx:285-288`）。任务清单写的「11 列」以 10 列实现 → 属结构差异，非功能缺失 |
| 添加 / 清空 / 删除 | 通过 | `Watchlist.tsx:227,121,106` → `api.watchlist.create/clear/remove` |
| 查看详情（同资产详情 + 持仓对照） | 通过 | `WatchlistDetailDialog.tsx:148,188,249`（含 K线/净值/基本面/分红/AI 总结）、`:5` 复用 `InstrumentDetailSections` |
| AI 标的分析按钮 | 通过 | `Watchlist.tsx:149,230`（`stream.start('/watchlist/analyze')`） |

### AI 投资建议
| 需求 | 结论 | 证据 |
| --- | --- | --- |
| 头部三市场币种预算 + 消耗进度 | 通过 | `Advice.tsx:118-130`、`api.advice.list` 的 `budget` 字段 |
| 预算耗尽提示 | 通过 | `Advice.tsx:127,138`（`exhausted` → 「预算耗尽」Badge） |
| 建议生成 | 通过 | `Advice.tsx:99`（`stream.start('/advice/generate')`） |
| 驳回 | 通过 | `Advice.tsx:69,237` → `api.advice.reject` |
| 确认（填实际份额/单价，写回资产） | 通过 | `Advice.tsx:261,306` → `api.advice.confirm`；服务端实测生成 `source='ai'` 资产 + `source='advice'` 交易 ✅ |
| 列表含目标份额/单价/理由/置信度/日期 | 通过 | 服务端 `AdviceItem` 20 字段齐全（§4 D） |

### AI Chat
| 需求 | 结论 | 证据 |
| --- | --- | --- |
| 会话管理（列表/新建/删除） | 通过 | `Chat.tsx:34,58,84,98,120` → `api.chat.sessions/createSession/removeSession/messages` |
| 流式输出 | 通过 | `Chat.tsx:39,129,222-228`（`stream.text` + typing 动画） |
| 工具调用展示 | 通过 | `Chat.tsx:230-242`（`toolEvents` → `ToolTimeline`）、`:353` |

### 设置
| 需求 | 结论 | 证据 |
| --- | --- | --- |
| AI API Key / Base URL / 模型 / 温度 / maxTokens / 超时 + 测试连接 | 通过 | `Settings.tsx:99,156,160,166` → `api.settings.testLlm` |
| 6 种投资性格 | 通过 | `Settings.tsx:211`（`PERSONAS`）；`shared/constants.ts:81,91,101,111,121,131` 恰好 6 个 |
| 报告风格（专业型/新手型） | 通过 | `Settings.tsx:248`；`constants.ts:155` |
| 六槽数据源 + 网页搜索 | 通过 | `Settings.tsx:276`；`SettingsDataSources.tsx:29,54,170,184`；`constants.ts:396-402`（6 槽）+ `webSearch` |
| 三币种月预算 | 通过 | `Settings.tsx:281,284,287` |
| 定时任务（关闭/间隔/每日 + 三个开关） | **未通过（功能不生效）** | UI 齐全 `Settings.tsx:303-343`；但服务端保存后不重载调度器 → **M1** |
| 备份导出 / 导入（合并·替换）/ 服务端快照 | 通过 | `SettingsBackup.tsx:34,73,90,107,132,146` → `api.backup.exportAll/import/snapshot/files` |

---

## 6. 独立结论

### 能不能交付？→ **有条件可交付（当前状态不建议直接交付）**

**理由（正）**：工程底座质量高于预期——`typecheck`/`build`/`test` 全绿（37/37）、静态部署检查 24/24、生产依赖闭包可真实启动并服务行情与前端、58 条端点全部实现、27 个 DTO 与冻结契约**零字段偏差**、目录逃逸 12 种 payload 无一穿透、无 Key 路径全部 400 JSON、账本数学与级联删除（SQL 级）正确、无 XSS 落点、19 个工具与文档一致、六个页面均有真实 `api.*` 接线而非空壳。

**理由（反，阻断项）**：
1. **S1 是安全缺陷**：第三方数据源 Key 在 5 个出口明文外泄，且与 README/ARCHITECTURE 的安全承诺直接矛盾，属于「把用户凭证泄露出去」的级别，不可带着上线。
2. **M1 是核心功能静默失效**：默认配置下按 UI 正常操作启用定时任务**永远不会运行**，而界面反而显示已排程——用户无法自救。
3. M2–M5 会造成「预算约束被绕过 / 非法日期污染账本与预算 / 汇率偏高 7% / 账本金额静默丢失」，属于会产出**错误投资数字**的问题，对「投资顾问」类应用不可接受。
4. 项目自己的验收门禁 `npm run smoke` 会随网络抖动变红（M4），CI 不可信；其安全断言本身是假阴性（L9），说明现有验证覆盖不足。
5. `docker build` 本机无法执行（无 Docker），镜像正确性仍是「等价复现」而非直接证据 —— 需在具备 Docker 的环境补一次真实构建。

### 最关键的 3 条改进建议（按影响排序）

1. **彻底切断数据源 Key 的明文出口（修 S1）**：统一走一个 `toPublicSettings()`（对 `llm.apiKey` 与 `dataSources.*.apiKey` 一视同仁：只回 `hasKey` + 掩码），`/api/settings`、`/api/settings/data-sources`、`/api/backup/export`、`/api/backup/files` 全部复用；前端 `SettingsDataSources.tsx` 改为「占位符 + 留空表示不修改」；并把 `smoke-api.mjs:113/210` 改成「写入哨兵 Key → 对 5 个出口全文搜索该串」的**肯定式**断言，防止回归。
2. **让定时任务真正生效并让状态可信（修 M1）**：把 `scheduler` 注册进服务定位器（`index.ts` → `setServices`），在 `PUT /api/settings` 命中 `schedule` 时调用 `scheduler.reload()`；`/api/dashboard` 的 `signals.nextRunAt` 改为读调度器真实值而非自行推算，避免「界面说已排程、实际没有」。
3. **修正会产出错误数字的三处口径（修 M2/M3/M4）**：① 预算 `spent` 按契约改为「本月买入成交额」（若确要保留净额口径，必须改 `docs/API.md` 并给 `remaining` 设上限、`usedPct` 设下限 0）；② `tradeDate` 增加真实日历校验（`2026-13-45`/`2026-02-30` 一律 400，可用 `Date` 回环比对），并给 `DELETE .../transactions/:txId` 加「删除后不得出现无对手方卖出」的一致性校验；③ 汇率任一条腿失败即整表回退（或对混用结果也执行 `crossCheck` 并告警），避免 7% 级别的折价误差与 CI 抖动。

---

*报告完毕。本文件是验证者唯一写入的文件；未修改 `packages/**`、`docs/API.md` 或任何根配置。临时数据目录 `.verify-data*` / `.verify-runtime` 已自行清理；`.smoke-data-6PUpfg`、`.smoke-data-qucVgB` 由 `npm run smoke` 自身遗留（缺陷 L10），保留作为证据。*
