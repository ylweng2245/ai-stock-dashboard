@echo off
echo ========================================
echo  AI Stock Dashboard - Setup
echo ========================================
echo.

cd /d "%~dp0"

echo [1/3] Running npm install (skip native compile)...
call npm install --ignore-scripts
if errorlevel 1 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)

echo.
echo [2/3] Copying Windows SQLite binary...
if not exist "node_modules\better-sqlite3\build\Release" (
    mkdir "node_modules\better-sqlite3\build\Release"
)
copy /y "prebuilds\win32-x64\better_sqlite3.node" "node_modules\better-sqlite3\build\Release\better_sqlite3.node"
if errorlevel 1 (
    echo ERROR: Failed to copy binary
    pause
    exit /b 1
)

echo.
echo [3/3] Setup complete! Run start.bat to launch.
echo.
pause
