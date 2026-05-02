@echo off
echo ========================================
echo  AI Stock Dashboard - Update
echo ========================================
echo.
cd /d "%~dp0"

echo [1/4] Pulling latest code from GitHub...
git rm --cached data.db >nul 2>&1
git fetch origin
git reset --hard origin/main
if errorlevel 1 (
    echo ERROR: git pull failed
    pause
    exit /b 1
)

echo.
echo [2/4] Installing dependencies...
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)

echo.
echo [3/4] Building...
call npm run build
if errorlevel 1 (
    echo ERROR: build failed
    pause
    exit /b 1
)

echo.
echo [4/4] Restarting server...
taskkill /F /IM node.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

REM Load .env file if it exists (pass as --env-file for Node.js native dotenv support)
if exist "%~dp0.env" (
    start "AI Stock Dashboard" /D "C:\ai-stock-dashboard" cmd /c "node --env-file=.env dist\index.cjs > server.log 2>&1"
) else (
    start "AI Stock Dashboard" /D "C:\ai-stock-dashboard" cmd /c "node dist\index.cjs > server.log 2>&1"
)

echo.
echo ========================================
echo  Done. Dashboard running at:
echo  http://192.168.0.114:5000
echo ========================================
echo.
timeout /t 3 /nobreak >nul
