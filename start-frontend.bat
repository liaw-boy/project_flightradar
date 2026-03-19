@echo off
title AEROSTRAT Frontend (Port 5173)
cd /d "%~dp0client"

echo.
echo  ==========================================
echo  AEROSTRAT Frontend UI v4.4.0
echo  Port 5173  /  Proxy to localhost:3000
echo  ==========================================
echo.

if not exist "node_modules" (
    echo  [SETUP] Installing dependencies...
    npm install
    echo.
)

echo  [INFO] Open browser: http://localhost:5173
echo  [INFO] Make sure backend is running first!
echo  [INFO] Press Ctrl+C to stop frontend only
echo.

npm run dev

echo.
echo  Frontend stopped. Backend is still running.
pause
