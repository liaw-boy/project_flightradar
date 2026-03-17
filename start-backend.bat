@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ===========================================
echo    AEROSTRAT Backend API Engine Starter
echo ===========================================
echo.
echo 正在強制關閉舊的後端 (Node) 程序...
taskkill /F /IM node.exe >nul 2>&1

echo 正在啟動後端伺服器 (Port 3000)...
echo 後端將負責每 30 秒自動抓取 OpenSky 全球資料並存入 DB。
echo.
echo ===========================================
npm run start
