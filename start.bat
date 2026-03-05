:: Change to script directory
cd /d "%~dp0"

echo [1/2] Building Client...
cd client
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Build failed!
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [2/2] Starting Server...
cd ..
npm start
