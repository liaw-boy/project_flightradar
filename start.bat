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
    echo [ERROR] Node.js is not installed!
    pause
    exit /b 1
)

:: [Step 1] Backend Dependencies
echo [1/5] Checking Backend Dependencies...
if not exist "node_modules\" (
    echo [INFO] Missing node_modules, running npm install...
    call npm install
)

:: [Step 2] Frontend Dependencies
echo [2/5] Checking Frontend Dependencies...
if not exist "client\node_modules\" (
    echo [INFO] Missing client/node_modules, running npm install...
    if exist "client\" (
        pushd client
        call npm install
        popd
    ) else (
        echo [WARN] client directory not found.
    )
)

:: [Step 3] MongoDB Service Check
echo [3/5] Checking MongoDB Status...
sc query MongoDB >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [WARN] MongoDB service is NOT installed locally.
    echo        Ensure your .env MONGODB_URI points to a valid instance.
) else (
    sc query MongoDB | findstr RUNNING >nul
    if %ERRORLEVEL% NEQ 0 (
        echo [INFO] MongoDB is installed but NOT running.
        echo        Attempting to start MongoDB service...
        net start MongoDB >nul 2>&1
        if !ERRORLEVEL! NEQ 0 (
            echo [WARN] Failed to start MongoDB service. Please run as ADMIN if needed.
        ) else (
            echo [OK] MongoDB started successfully.
        )
    ) else (
        echo [OK] MongoDB is running.
    )
)

:: [Step 4] Build Client
echo [4/5] Building Client UI...
if exist "client\" (
    pushd client
    call npm run build
    if !ERRORLEVEL! NEQ 0 (
        echo [ERROR] Client build failed!
        popd
        pause
        exit /b !ERRORLEVEL!
    )
    popd
)

:: [Step 5] Start Server
echo [5/5] Starting Aerostrat Server (v4.2.1)...
echo ===========================================
npm start
