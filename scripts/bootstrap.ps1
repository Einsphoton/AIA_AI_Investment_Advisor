# AI 投资顾问 — Windows 一键启动引导（自动准备环境）
#
# 用户只需要运行一次：
#   start.cmd                （双击或命令行，等价于下一条）
#   powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap.ps1
#
# 它会自动完成：
#   1. 找一个可用的 Node（>= 22.5，优先 24）
#   2. 没有就自己装：先试 winget，失败则下载官方**便携版**到 .tools\（无需管理员权限）
#   3. 首次自动安装依赖（npm install --ignore-scripts）
#   4. 构建并启动开发模式，服务就绪后自动打开浏览器
#
# 可选参数：
#   -Prod            生产模式（构建后单端口启动）
#   -SkipInstall     跳过依赖检查
#   -ForcePortable   忽略系统 Node，强制下载便携版（用于验证自动安装逻辑）
#   -PrepareOnly     只准备环境（Node + 依赖），不启动服务（便于自检/CI）
#   -Port 8788       指定端口
#   -NoOpen          不自动打开浏览器

[CmdletBinding()]
param(
    [switch]$Prod,
    [switch]$SkipInstall,
    [switch]$ForcePortable,
    [switch]$PrepareOnly,
    [switch]$NoOpen,
    [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Info($message) { Write-Host "[启动] $message" -ForegroundColor Cyan }
function Warn($message) { Write-Host "[提示] $message" -ForegroundColor Yellow }
function Halt($message) {
    Write-Host "[错误] $message" -ForegroundColor Red
    Write-Host ""
    Write-Host "也可以手动处理：安装 Node.js 24 LTS（https://nodejs.org）后重开终端，再运行 start.cmd" -ForegroundColor Yellow
    Read-Host "按回车退出"
    exit 1
}

Write-Host "== AI 投资顾问 · 一键启动 ==" -ForegroundColor Cyan
Write-Host "项目目录: $root"

# ── 1. 可用的 Node？ ──────────────────────────────────────────────────────────
function Get-NodeVersion($exe) {
    try {
        $raw = & $exe -v
    } catch {
        return $null
    }
    if (-not $raw) { return $null }
    $clean = ([string]$raw).Trim().TrimStart('v')
    $parts = $clean.Split('.')
    if ($parts.Length -lt 2) { return $null }
    $major = 0; $minor = 0
    try { $major = [int]$parts[0]; $minor = [int]$parts[1] } catch { return $null }
    if ($major -gt 22) { return $clean }
    if ($major -eq 22 -and $minor -ge 5) { return $clean }
    return $null
}

$nodeExe = $null
$nodeVersion = $null

if (-not $ForcePortable) {
    $candidate = Get-Command node -ErrorAction SilentlyContinue
    if ($candidate) {
        $nodeVersion = Get-NodeVersion $candidate.Source
        if ($nodeVersion) {
            $nodeExe = $candidate.Source
            Write-Host "[启动] 使用系统已安装的 Node v$nodeVersion" -ForegroundColor Green
        } else {
            Warn "系统 Node 版本过低（$( & $candidate.Source -v )），需要 >= 22.5，准备自动安装。"
        }
    }
}

# ── 2. 没有就自动装 ──────────────────────────────────────────────────────────
if (-not $nodeExe -and -not $ForcePortable) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Warn "尝试用 winget 安装 Node LTS（可能需要 1-3 分钟）…"
        try {
            & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent | Write-Host
        } catch {
            Warn "winget 安装失败：$($_.Exception.Message)"
        }
        $after = Get-Command node -ErrorAction SilentlyContinue
        if ($after) {
            $nodeVersion = Get-NodeVersion $after.Source
            if ($nodeVersion) {
                $nodeExe = $after.Source
                Write-Host "[启动] winget 安装完成：Node v$nodeVersion" -ForegroundColor Green
            }
        }
    } else {
        Warn "未找到 winget，改用便携版（无需管理员权限）。"
    }
}

if (-not $nodeExe) {
    # 复用上次下载的便携版：重复启动保持秒级
    $toolsDir = Join-Path $root '.tools'
    if (Test-Path $toolsDir) {
        $existing = Get-ChildItem -Path $toolsDir -Directory -Filter 'node-v*-win-*' -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending
        foreach ($dir in $existing) {
            $candidate = Join-Path $dir.FullName 'node.exe'
            if (Test-Path $candidate) {
                $existingVersion = Get-NodeVersion $candidate
                if ($existingVersion) {
                    $nodeExe = $candidate
                    $nodeVersion = $existingVersion
                    Write-Host "[启动] 复用已下载的便携版：Node v$nodeVersion" -ForegroundColor Green
                    break
                }
            }
        }
    }
}

if (-not $nodeExe) {
    $toolsDir = Join-Path $root '.tools'
    New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

    $arch = 'x64'
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }

    Info "查询 Node 最新 v24 版本 …"
    $version = $null
    try {
        $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
        $entry = $index | Where-Object { $_.version -like 'v24.*' } | Select-Object -First 1
        if ($entry) { $version = $entry.version }
    } catch {
        Warn "版本列表获取失败：$($_.Exception.Message)"
    }
    if (-not $version) { $version = 'v24.10.0' }

    $folder = "node-$version-win-$arch"
    $zipName = "$folder.zip"
    $url = "https://nodejs.org/dist/$version/$zipName"
    $zipPath = Join-Path $toolsDir $zipName

    Info "下载便携版 Node $version（约 30MB，写入 .tools\）…"
    try {
        Invoke-WebRequest -Uri $url -OutFile $zipPath -TimeoutSec 900
    } catch {
        Halt "下载失败：$($_.Exception.Message)"
    }

    Info "解压 …"
    $target = Join-Path $toolsDir $folder
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    try {
        Expand-Archive -Path $zipPath -DestinationPath $toolsDir -Force
    } catch {
        Halt "解压失败：$($_.Exception.Message)"
    }
    Remove-Item -Force $zipPath -ErrorAction SilentlyContinue

    $nodeExe = Join-Path $target 'node.exe'
    if (-not (Test-Path $nodeExe)) { Halt "解压后未找到 node.exe（$target）" }
    $nodeVersion = Get-NodeVersion $nodeExe
    if (-not $nodeVersion) { Halt "便携版 Node 不可用：$nodeExe" }
    Write-Host "[启动] 便携版已就绪：Node v$nodeVersion（$target）" -ForegroundColor Green
}

$nodeDir = Split-Path -Parent $nodeExe
$env:PATH = "$nodeDir;$env:PATH"

$npmCmd = Join-Path $nodeDir 'npm.cmd'
if (-not (Test-Path $npmCmd)) { $npmCmd = 'npm' }

# ── 3. 依赖 ──────────────────────────────────────────────────────────────────
if (-not $SkipInstall) {
    if (-not (Test-Path (Join-Path $root 'node_modules'))) {
        Info "首次运行，安装依赖（约 1-3 分钟）…"
        & $npmCmd install --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { Halt "依赖安装失败（exit $LASTEXITCODE）。可重试：npm install --ignore-scripts" }
    } else {
        Info "依赖已存在，跳过安装"
    }
}

if ($Port -gt 0) { $env:PORT = "$Port" }
if ($NoOpen) { $env:AIA_NO_OPEN = '1' }

if ($PrepareOnly) {
    Write-Host "[启动] 环境准备完成（未启动服务）。node: $nodeExe" -ForegroundColor Green
    exit 0
}

# ── 4. 启动 ──────────────────────────────────────────────────────────────────
if ($Prod) {
    Info "生产构建 …"
    & $npmCmd run build
    if ($LASTEXITCODE -ne 0) { Halt "构建失败（exit $LASTEXITCODE）" }
    Info "启动生产模式服务 …"
    & $npmCmd start
} else {
    Info "启动开发模式（首次会先构建一次，随后自动打开浏览器）…"
    & $nodeExe (Join-Path $root 'scripts\dev.mjs')
}
