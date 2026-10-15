/**
 * 构建 / 测试前的守卫：本机正有 AI 流水线在跑时**拒绝重建后端产物**。
 *
 * 背景（真实事故）：开发模式下 `packages/server/dist` 由 `node --watch` 托管，
 * 编译产物一变服务就重启；AI 流水线跑在同一个进程里，于是「一边跑分析一边
 * `npm run build` / `npm test`」会把分析判成「运行被中断（服务进程在本次分析结束前退出）」，
 * 已经烧掉的 token 全白费。
 *
 * 本脚本挂在各 package.json 的 `pre*` 钩子上（prebuild / pretypecheck / pretest /
 * preverify / presmoke …），所以任何「会重写 dist」的常用入口都会先过这一关：
 *   · 服务没在监听 / 没有 running 的 run → 直接放行（CI 里也是这个分支，无副作用）；
 *   · 有流水线在跑 → 退出码 1 + 一段可操作的提示。
 *
 * 想强行继续（例如你确定要牺牲这次分析）：
 *   node scripts/guard-running-pipeline.mjs --force
 *   AIA_ALLOW_REBUILD_WHILE_RUNNING=1 npm run build
 * 换端口时用环境变量 PORT（默认 8787）指定。
 */

import { detectRunningPipeline, describeRun } from './lib/pipeline-state.mjs';

const port = Number.parseInt(process.env.PORT ?? '8787', 10) || 8787;
const force = process.argv.includes('--force') || process.env.AIA_ALLOW_REBUILD_WHILE_RUNNING === '1';

const { reachable, run } = await detectRunningPipeline(`http://127.0.0.1:${port}`);

if (!reachable || !run) {
  process.exit(0);
}

if (force) {
  console.warn(
    `[guard] ⚠️ 端口 ${port} 上有 AI 流水线正在运行（${describeRun(run)}），已按 --force / AIA_ALLOW_REBUILD_WHILE_RUNNING=1 继续。` +
      '重建后端产物会让开发模式的服务重启，该分析会被标记为「运行被中断」（可在活动页续跑）。',
  );
  process.exit(0);
}

console.error(
  [
    '',
    '──────────────────────────────────────────────────────────────────────',
    `[guard] 检测到端口 ${port} 上有 AI 流水线正在运行：${describeRun(run)}`,
    '',
    '重建后端产物（packages/server/dist）会让开发模式的服务自动重启（node --watch），',
    '正在跑的分析会被判为「运行被中断（服务进程在本次分析结束前退出）」，已消耗的 token 白费。',
    '因此本次命令已中止，没有改动任何文件。',
    '',
    '怎么办：',
    '  ① 推荐：等这次分析跑完（界面右下角推理面板显示进度），再重跑本命令；',
    '  ② 想立刻构建：先在界面中断该流水线（中断的 run 可在「活动与审计」页一键续跑）；',
    '  ③ 确定要牺牲这次分析：用环境变量放行 ——',
    '     AIA_ALLOW_REBUILD_WHILE_RUNNING=1 npm run build   （PowerShell: $env:AIA_ALLOW_REBUILD_WHILE_RUNNING=1; npm run build）',
    '  ④ 长期跑长任务（含定时分析）：用生产模式（npm run build && npm start / docker compose up -d），',
    '     没有 watcher，构建不会打断正在跑的分析。',
    '──────────────────────────────────────────────────────────────────────',
    '',
  ].join('\n'),
);
process.exit(1);
