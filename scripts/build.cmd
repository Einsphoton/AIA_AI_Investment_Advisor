@echo off
rem AI Investment Advisor - Windows production build launcher.
rem ASCII-only on purpose (see dev.cmd).
rem Usage: scripts\build.cmd
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
  echo Installing dependencies...
  call npm install --ignore-scripts --no-audit --no-fund
  if errorlevel 1 exit /b 1
)

call npm run typecheck || exit /b 1
call npm run build     || exit /b 1
call npm test          || exit /b 1

echo.
echo Build finished: packages/server/dist and packages/web/dist
echo Start in production mode: npm start  (http://127.0.0.1:8787)
exit /b 0
