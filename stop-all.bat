@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ===========================================
echo    AEROSTRAT Unified Dev Engine Stop
echo ===========================================
echo.
echo Stopping all AEROSTRAT background processes...
echo [1/2] Terminating Node.js background processes...
taskkill /F /IM node.exe >nul 2>&1

echo [2/2] Terminating Vite frontend processes...
echo.

echo ===========================================
echo All radar observer servers successfully closed.
echo ===========================================
timeout /t 3
