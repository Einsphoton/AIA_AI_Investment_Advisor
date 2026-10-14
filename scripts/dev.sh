#!/usr/bin/env bash
# AI 投资顾问 — macOS / Linux 本地调试入口
#
# 用法（仓库根目录）：
#   ./scripts/dev.sh              # 安装依赖（首次）并启动开发模式
#   ./scripts/dev.sh --no-build   # 构建后以生产模式启动（单端口）
#   ./scripts/build.sh            # 只做生产构建
#
# 只依赖 node / npm，不需要 Docker 或 Python。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="${1:-dev}"

echo "== AI 投资顾问 · 本地调试 =="
echo "仓库根目录: $ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 node，请先安装 Node.js 24 LTS（https://nodejs.org）" >&2
  exit 1
fi

NODE_VERSION="$(node -v)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "错误：Node 版本过低（当前 $NODE_VERSION），需要 >= 22.5（推荐 24 LTS）" >&2
  exit 1
fi
echo "Node 版本: $NODE_VERSION"

if [ ! -d "$ROOT/node_modules" ]; then
  echo "安装依赖（npm install --ignore-scripts）…"
  npm install --ignore-scripts --no-audit --no-fund
else
  echo "已存在 node_modules，跳过安装"
fi

PORT="${PORT:-8787}"

if [ "$MODE" = "--no-build" ] || [ "$MODE" = "prod" ]; then
  echo "构建 server + web …"
  npm run build
  echo "启动生产模式服务：http://127.0.0.1:${PORT}"
  npm start
else
  echo "启动开发模式（tsc --watch + rollup --watch + node --watch）…"
  echo "浏览器访问 http://127.0.0.1:${PORT}"
  npm run dev
fi
