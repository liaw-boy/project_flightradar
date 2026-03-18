@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ===========================================
echo    AEROSTRAT Frontend Stopper
echo ===========================================
echo.
echo Stopping Vite (Frontend) development server...

:: Kill node processes running Vite specifically
for /f "tokens=2" %%a in ('tasklist /nh /fi "imagename eq node.exe" /v ^| findstr /i "vite"') do (
    echo Killing Vite Dev Server PID %%a
    taskkill /F /PID %%a >nul 2>&1
)

:: Extra forceful clean up for stubborn react dev servers
taskkill /F /IM cmd.exe /FI "WINDOWTITLE eq AEROSTRAT Frontend UI Starter" >nul 2>&1

echo.
echo ===========================================
echo Frontend stopped successfully.
echo Backend data engine is STILL RUNNING.
echo ===========================================
timeout /t 3
