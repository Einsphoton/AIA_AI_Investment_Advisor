# AI 投资顾问 — Windows 本地调试入口
# 兼容 Windows PowerShell 5.1（默认）与 PowerShell 7+，脚本内不使用 PS7 专有语法。
#
# 用法（仓库根目录）：
#   npm run dev                                  # 推荐：不经过 PowerShell 语义，任何终端都可用
#   .\scripts\dev.cmd                            # 等价包装（自动绕过执行策略）
#   powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1
#   .\scripts\dev.ps1 -Prod                      # 生产构建后单端口启动
#   .\scripts\dev.ps1 -SkipInstall               # 跳过依赖检查
#
# 只调用 node / npm，不依赖 Docker 或 Python。

[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$Prod
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "== AI 投资顾问 · 本地调试 ==" -ForegroundColor Cyan
Write-Host "仓库根目录: $root"

# ── node 检查（需要 22.5+，推荐 24：使用了内置 node:sqlite） ────────────────────
$nodeVersion = $null
try { $nodeVersion = (& node -v) } catch { $nodeVersion = $null }
if (-not $nodeVersion) {
    throw "未找到 node。请安装 Node.js 24 LTS：https://nodejs.org（安装后重开终端）"
}

$clean = $nodeVersion.TrimStart('v')
$major = 0
try { $major = [int]($clean.Split('.')[0]) } catch { $major = 0 }
if ($major -lt 22) {
    throw "Node 版本过低（当前 $nodeVersion），需要 >= 22.5（推荐 24 LTS）"
}
Write-Host "Node 版本: $nodeVersion" -ForegroundColor Green
if ($major -lt 24) {
    Write-Host "提示：本项目使用内置 node:sqlite，建议升级到 Node 24 LTS。" -ForegroundColor Yellow
}

# ── 依赖 ──────────────────────────────────────────────────────────────────────
if (-not $SkipInstall) {
    if (-not (Test-Path (Join-Path $root 'node_modules'))) {
        Write-Host "安装依赖（npm install --ignore-scripts）…" -ForegroundColor Yellow
        & npm install --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install 失败（exit $LASTEXITCODE）" }
    } else {
        Write-Host "已存在 node_modules，跳过安装（可加 -SkipInstall 显式跳过）" -ForegroundColor DarkGray
    }
}

# ── 端口占用提示 ──────────────────────────────────────────────────────────────
$port = '8787'
if ($env:PORT) { $port = $env:PORT }
$portInUse = $false
try {
    $listeners = Get-NetTCPConnection -LocalPort ([int]$port) -State Listen -ErrorAction SilentlyContinue
    if ($listeners) { $portInUse = $true }
} catch {
    $portInUse = $false
}
if ($portInUse) {
    Write-Host "警告：端口 $port 已被占用。先关闭占用进程，或设置环境变量 PORT 换一个端口。" -ForegroundColor Yellow
}

# ── 启动 ──────────────────────────────────────────────────────────────────────
if ($Prod) {
    Write-Host "生产构建 + 单端口启动（http://127.0.0.1:$port）…" -ForegroundColor Yellow
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "构建失败（exit $LASTEXITCODE）" }
    & npm start
} else {
    Write-Host "开发模式（tsc --watch + rollup --watch + node --watch）…" -ForegroundColor Yellow
    Write-Host "浏览器访问 http://127.0.0.1:$port" -ForegroundColor Green
    Write-Host "排查环境问题可先运行：npm run doctor" -ForegroundColor DarkGray
    & npm run dev
}
