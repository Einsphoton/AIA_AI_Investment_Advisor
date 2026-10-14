@echo off
rem AI Investment Advisor - Windows local dev launcher.
rem ASCII-only on purpose: cmd.exe reads .cmd files with the OEM/ANSI code page,
rem so non-ASCII text here would be mangled and break batch parsing.
rem Usage: scripts\dev.cmd   (equivalent to: npm run dev)
setlocal
cd /d "%~dp0.."
chcp 65001 >nul

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found. Install Node.js 24 LTS: https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies ^(npm install --ignore-scripts^)...
  call npm install --ignore-scripts --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] dependency install failed
    pause
    exit /b 1
  )
)

node "%~dp0dev.mjs"
set EXITCODE=%errorlevel%
if not "%EXITCODE%"=="0" (
  echo.
  echo [HINT] start failed ^(exit %EXITCODE%^). Run "npm run doctor" to diagnose.
  pause
)
exit /b %EXITCODE%
