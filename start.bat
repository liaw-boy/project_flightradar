@echo off
setlocal enabledelayedexpansion

:: Change to script directory
cd /d "%~dp0"

echo ===========================================
echo    AEROSTRAT System Startup Optimizer
echo ===========================================
echo.

:: [Step 0] Node.js Check
echo [0/5] Checking Environment...
node -v >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Node.js is not installed! Please install it from https://nodejs.org/
    pause
    exit /b 1
)

:: [Step 1] Backend Dependencies
echo [1/5] Checking Backend Dependencies...
if not exist "node_modules\" (
    echo 📦 Missing node_modules, running npm install...
    call npm install
)

:: [Step 2] Frontend Dependencies
echo [2/5] Checking Frontend Dependencies...
if not exist "client\node_modules\" (
    echo 📦 Missing client/node_modules, running npm install...
    if exist "client\" (
        cd client
        call npm install
        cd ..
    ) else (
        echo ⚠️  Warning: client directory not found.
    )
)

:: [Step 3] MongoDB Service Check
echo [3/5] Checking MongoDB Status...
sc query MongoDB >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ⚠️  MongoDB service is NOT installed!
    echo    Please install MongoDB 5.0+ from:
    echo    https://www.mongodb.com/try/download/community
    echo.
    echo    Note: You can still run the server, but tracks won't be saved.
) else (
    :: Check if running
    sc query MongoDB | findstr RUNNING >nul
    if %ERRORLEVEL% NEQ 0 (
        echo ⚠️  MongoDB is installed but NOT running.
        echo    Attempting to start MongoDB service...
        net start MongoDB >nul 2>&1
        if !ERRORLEVEL! NEQ 0 (
            echo ❌ Failed to start MongoDB. Please run this script as ADMIN or start it manually.
        ) else (
            echo ✅ MongoDB started successfully.
        )
    ) else (
        echo ✅ MongoDB is running.
    )
)

:: [Step 4] Build Client
echo.
echo [4/5] Building Client UI...
if exist "client\" (
    cd client
    call npm run build
    if !ERRORLEVEL! NEQ 0 (
        echo ❌ Build failed!
        pause
        exit /b !ERRORLEVEL!
    )
    cd ..
)

:: [Step 5] Start Server
echo.
echo [5/5] Starting Aerostrat Server (v4.2.1)...
echo ===========================================
npm start
