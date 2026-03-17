@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0client"

echo ===========================================
echo    AEROSTRAT Frontend UI Starter
echo ===========================================
echo.
echo 正在啟動前端 Vite 開發伺服器 (Port 5173)...
echo 請確保您的後端已經透過 start-backend.bat 啟動，否則地圖將沒有資料。
echo.
echo ===========================================
npm run dev
