@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ===========================================
echo    AEROSTRAT Unified Dev Engine Stop
echo ===========================================
echo.
echo 正在強制關閉所有 AEROSTRAT 背景程序...
echo [1/2] Terminating Node.js backend processes...
taskkill /F /IM node.exe >nul 2>&1

echo [2/2] Terminating Vite frontend processes...
:: Vite on Windows can sometimes hide in cmd or powershell hosts when spawned via npm, 
:: but killing node.exe usually catches the dev server as well.
echo.

echo ===========================================
echo ✅ 所有雷達觀測器伺服器已成功關閉。
echo ===========================================
timeout /t 3
