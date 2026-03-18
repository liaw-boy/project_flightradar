@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0client"

echo ===========================================
echo    AEROSTRAT Frontend UI Starter
echo ===========================================
echo.
echo Starting Vite Dev Server (Port 5173)...
echo Please ensure backend is running via start-backend.bat
echo.
echo ===========================================
npm run dev
