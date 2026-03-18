@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0backend"

echo ===========================================
echo    AEROSTRAT Backend API Engine Starter
echo ===========================================
echo.
echo Stopping old backend Node processes...
taskkill /F /IM node.exe >nul 2>&1

echo Starting backend server (Port 3000)...
echo Backend will fetch OpenSky global data every 30 seconds.
echo.
echo ===========================================
npm run start
