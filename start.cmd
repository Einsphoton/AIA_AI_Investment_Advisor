@echo off
rem ============================================================================
rem  AI Investment Advisor - one-click launcher for Windows
rem
rem  Double-click this file, or run:  start.cmd
rem
rem  It prepares everything by itself:
rem    1. finds a usable Node (>= 22.5, prefers 24)
rem    2. if missing, installs it (winget, or a portable copy in .tools\)
rem    3. installs npm dependencies on first run
rem    4. builds + starts the dev server and opens the browser
rem
rem  ASCII-only on purpose: cmd.exe reads .cmd files with the OEM/ANSI code
rem  page, so non-ASCII text here would be mangled and break the batch parser.
rem ============================================================================
setlocal
cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Windows PowerShell not found. Install Node.js 24 LTS manually: https://nodejs.org
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1" %*
set EXITCODE=%errorlevel%
if not "%EXITCODE%"=="0" (
  echo.
  echo [HINT] launcher exited with code %EXITCODE%.
  echo        Diagnostics: npm run doctor
)
exit /b %EXITCODE%
