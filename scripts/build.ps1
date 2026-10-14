# AI 投资顾问 — Windows 生产构建
# 兼容 Windows PowerShell 5.1 与 PowerShell 7+。
#
#   .\scripts\build.ps1
#   .\scripts\build.ps1 -SkipInstall
#   npm run verify            # 等价：typecheck + build + test + 部署检查

[CmdletBinding()]
param([switch]$SkipInstall)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $SkipInstall -and -not (Test-Path (Join-Path $root 'node_modules'))) {
    Write-Host "安装依赖…" -ForegroundColor Yellow
    & npm install --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install 失败（exit $LASTEXITCODE）" }
}

Write-Host "类型检查…" -ForegroundColor Yellow
& npm run typecheck
if ($LASTEXITCODE -ne 0) { throw "类型检查失败（exit $LASTEXITCODE）" }

Write-Host "构建 shared + server + web…" -ForegroundColor Yellow
& npm run build
if ($LASTEXITCODE -ne 0) { throw "构建失败（exit $LASTEXITCODE）" }

Write-Host "运行测试…" -ForegroundColor Yellow
& npm test
if ($LASTEXITCODE -ne 0) { throw "测试失败（exit $LASTEXITCODE）" }

Write-Host "构建完成：packages/server/dist 与 packages/web/dist" -ForegroundColor Green
Write-Host "以生产模式启动：npm start（默认 http://127.0.0.1:8787）" -ForegroundColor Green
