@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有找到 node。
  echo   请先安装 Node.js 22 或更新版本： https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动 网易云 163key 标签工具 ...
echo   浏览器会自动打开；关掉这个窗口就是退出。
echo.

node server.mjs
pause
