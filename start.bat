@echo off
echo Starting AI Stock Dashboard...
cd /d "%~dp0"
set NODE_ENV=production
node dist\index.cjs
pause
