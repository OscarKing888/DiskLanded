@echo off
setlocal EnableExtensions
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
    echo Error: install Node.js 22 or newer to use bump-version.
    exit /b 1
)
node scripts/bump-version.js %*
exit /b %errorlevel%
