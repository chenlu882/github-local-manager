@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ is required. Install Node.js LTS from https://nodejs.org/
  pause
  exit /b 1
)
node "%~dp0dist\launcher.js" --connect
pause
