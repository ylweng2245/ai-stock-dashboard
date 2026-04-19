@echo off
echo ========================================
echo  AI Stock Dashboard - Update
echo ========================================
echo.
cd /d "%~dp0"

echo [1/3] Pulling latest code from GitHub...
git pull
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
echo [3/3] Update complete! Please restart start.bat.
echo.
pause
