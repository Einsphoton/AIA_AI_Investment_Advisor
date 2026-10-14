#!/usr/bin/env bash
# ============================================================================
#  AI 投资顾问 — macOS / Linux 一键启动引导（自动准备环境）
#
#  用法：
#    ./start.command            # macOS 可在 Finder 里双击
#    ./scripts/bootstrap.sh     # 等价
#    ./scripts/bootstrap.sh --prod        # 生产模式
#    ./scripts/bootstrap.sh --port 8788   # 指定端口
#    ./scripts/bootstrap.sh --force-portable   # 忽略系统 Node，强制下载便携版
#
#  自动完成：找 Node（>=22.5）→ 没有就装（brew，或下载官方便携版到 .tools/）
#           → 首次自动 npm install → 构建并启动 → 自动打开浏览器
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROD=0
SKIP_INSTALL=0
FORCE_PORTABLE=0
NO_OPEN=0
PREPARE_ONLY=0
PORT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --prod) PROD=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --force-portable) FORCE_PORTABLE=1 ;;
    --prepare-only) PREPARE_ONLY=1 ;;
    --no-open) NO_OPEN=1 ;;
    --port) shift; PORT="${1:-}" ;;
    *) echo "[提示] 未知参数：$1" ;;
  esac
  shift || true
done

info() { printf '\033[36m[启动]\033[0m %s\n' "$1"; }
warn() { printf '\033[33m[提示]\033[0m %s\n' "$1"; }
halt() {
  printf '\033[31m[错误]\033[0m %s\n' "$1"
  echo ""
  echo "也可以手动处理：安装 Node.js 24 LTS（https://nodejs.org）后重开终端，再运行 ./start.command"
  exit 1
}

echo "== AI 投资顾问 · 一键启动 =="
echo "项目目录: $ROOT"

# ── 1. 可用的 Node？ ────────────────────────────────────────────────────────
node_ok() {
  command -v "$1" >/dev/null 2>&1 || [ -x "$1" ] || return 1
  local raw
  raw="$("$1" -v 2>/dev/null || true)"
  [ -n "$raw" ] || return 1
  local clean="${raw#v}"
  local major minor
  major="$(echo "$clean" | cut -d. -f1)"
  minor="$(echo "$clean" | cut -d. -f2)"
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  if [ "$major" -gt 22 ]; then return 0; fi
  if [ "$major" -eq 22 ] && [ "$minor" -ge 5 ]; then return 0; fi
  return 1
}

NODE_BIN=""
if [ "$FORCE_PORTABLE" -eq 0 ] && command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE_BIN="$(command -v node)"
  info "使用系统已安装的 Node $("$NODE_BIN" -v)"
elif [ "$FORCE_PORTABLE" -eq 0 ] && command -v node >/dev/null 2>&1; then
  warn "系统 Node 版本过低（$(node -v)），需要 >= 22.5，准备自动安装。"
fi

# ── 2. 没有就自动装（brew 优先，其次官方便携版，均不需要 sudo 之外的操作）────
if [ -z "$NODE_BIN" ] && [ "$FORCE_PORTABLE" -eq 0 ] && command -v brew >/dev/null 2>&1; then
  warn "尝试用 Homebrew 安装 node（可能需要几分钟）…"
  if brew install node >/dev/null 2>&1 || brew upgrade node >/dev/null 2>&1; then
    if command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
      NODE_BIN="$(command -v node)"
      info "Homebrew 安装完成：Node $("$NODE_BIN" -v)"
    fi
  else
    warn "Homebrew 安装失败，改用便携版。"
  fi
fi

if [ -z "$NODE_BIN" ]; then
  TOOLS_DIR="$ROOT/.tools"
  mkdir -p "$TOOLS_DIR"

  # 复用上次下载的便携版（重复启动更快）
  for candidate in $(ls -d "$TOOLS_DIR"/node-v*-"$(uname -s | tr 'A-Z' 'a-z')"-* 2>/dev/null | sort -r || true); do
    if [ -x "$candidate/bin/node" ] && node_ok "$candidate/bin/node"; then
      NODE_BIN="$candidate/bin/node"
      info "复用已下载的便携版：Node $("$NODE_BIN" -v)"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  TOOLS_DIR="$ROOT/.tools"
  mkdir -p "$TOOLS_DIR"

  os_name="$(uname -s)"
  case "$os_name" in
    Darwin) platform="darwin" ;;
    Linux) platform="linux" ;;
    *) platform="linux" ;;
  esac
  arch_raw="$(uname -m)"
  case "$arch_raw" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) arch="x64" ;;
  esac

  info "查询 Node 最新 v24 版本 …"
  version=""
  if command -v curl >/dev/null 2>&1; then
    version="$(curl -fsSL https://nodejs.org/dist/index.json 2>/dev/null | tr ',' '\n' | grep -o '"version":"v24[^"]*"' | head -1 | cut -d'"' -f4 || true)"
  fi
  [ -n "$version" ] || version="v24.10.0"

  folder="node-${version}-${platform}-${arch}"
  tarball="${folder}.tar.gz"
  url="https://nodejs.org/dist/${version}/${tarball}"

  info "下载便携版 Node ${version}（约 40MB，写入 .tools/）…"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 -o "$TOOLS_DIR/$tarball" "$url" || halt "下载失败：$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$TOOLS_DIR/$tarball" "$url" || halt "下载失败：$url"
  else
    halt "系统没有 curl/wget，无法自动下载 Node。请手动安装 Node.js 24 LTS。"
  fi

  info "解压 …"
  rm -rf "$TOOLS_DIR/$folder"
  tar -xzf "$TOOLS_DIR/$tarball" -C "$TOOLS_DIR" || halt "解压失败"
  rm -f "$TOOLS_DIR/$tarball"

  NODE_BIN="$TOOLS_DIR/$folder/bin/node"
  [ -x "$NODE_BIN" ] || halt "解压后未找到可执行文件：$NODE_BIN"
  node_ok "$NODE_BIN" || halt "便携版 Node 不可用"
  info "便携版已就绪：Node $("$NODE_BIN" -v)（$TOOLS_DIR/$folder）"
fi

NODE_DIR="$(cd "$(dirname "$NODE_BIN")" && pwd)"
export PATH="$NODE_DIR:$PATH"

NPM_CMD="npm"
if [ -x "$NODE_DIR/npm" ]; then NPM_CMD="$NODE_DIR/npm"; fi

# ── 3. 依赖 ─────────────────────────────────────────────────────────────────
if [ "$SKIP_INSTALL" -eq 0 ]; then
  if [ ! -d "$ROOT/node_modules" ]; then
    info "首次运行，安装依赖（约 1-3 分钟）…"
    "$NPM_CMD" install --ignore-scripts --no-audit --no-fund || halt "依赖安装失败"
  else
    info "依赖已存在，跳过安装"
  fi
fi

[ -n "$PORT" ] && export PORT="$PORT"
[ "$NO_OPEN" -eq 1 ] && export AIA_NO_OPEN=1

if [ "$PREPARE_ONLY" -eq 1 ]; then
  info "环境准备完成（未启动服务）。node: $NODE_BIN"
  exit 0
fi

# ── 4. 启动 ─────────────────────────────────────────────────────────────────
if [ "$PROD" -eq 1 ]; then
  info "生产构建 …"
  "$NPM_CMD" run build || halt "构建失败"
  info "启动生产模式服务 …"
  exec "$NPM_CMD" start
else
  info "启动开发模式（首次会先构建一次，随后自动打开浏览器）…"
  exec "$NODE_BIN" "$ROOT/scripts/dev.mjs"
fi
