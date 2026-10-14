#!/usr/bin/env bash
# AI 投资顾问 — macOS / Linux 生产构建
#   ./scripts/build.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -d "$ROOT/node_modules" ]; then
  echo "安装依赖…"
  npm install --ignore-scripts --no-audit --no-fund
fi

echo "类型检查…"
npm run typecheck

echo "构建 shared + server + web…"
npm run build

echo "运行测试…"
npm test

echo "构建完成：packages/server/dist 与 packages/web/dist"
echo "以生产模式启动：npm start（默认 http://127.0.0.1:8787）"
