#!/usr/bin/env bash
# macOS 可在 Finder 中双击本文件；它会自动准备环境并启动本地调试。
# 若提示权限不足，先执行一次： chmod +x start.command
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$HERE/scripts/bootstrap.sh" "$@"
