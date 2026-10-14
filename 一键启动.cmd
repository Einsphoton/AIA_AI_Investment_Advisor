@echo off
rem Shortcut with a Chinese filename. Content must stay ASCII-only (see start.cmd).
rem Double-clicking this file behaves exactly like double-clicking start.cmd.
call "%~dp0start.cmd" %*
exit /b %errorlevel%
