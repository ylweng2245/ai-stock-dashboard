@echo off
echo ========================================
echo  AI Stock Dashboard - Update
echo ========================================
echo.
cd /d "%~dp0"

echo [1/3] Pulling latest code from GitHub...
git fetch origin
git checkout -- . 2>nul
git pull origin main
if errorlevel 1 (
    echo ERROR: git pull failed
    pause
    exit /b 1
)

echo.
echo [2/3] Building...
call npm run build
if errorlevel 1 (
    echo ERROR: build failed
    pause
    exit /b 1
)

echo.
echo [3/3] Restarting server...
taskkill /F /IM node.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul
start "AI Stock Dashboard" /D "C:\ai-stock-dashboard" cmd /c "node dist\index.cjs > server.log 2>&1"

echo.
echo ========================================
echo  Done. Dashboard running at:
echo  http://192.168.0.114:5000
echo ========================================
echo.
timeout /t 3 /nobreak >nul
