@echo off
title ERP System - Starting...
cd /d "%~dp0"
start "" /B npm run dev > "%~dp0server.log" 2>&1
echo Starting server, please wait...
timeout /t 5 /nobreak >nul

:: Try port 3000 first, then 3001
curl -s http://localhost:3000/ >nul 2>&1
if %errorlevel%==0 (
    start "" "http://localhost:3000/"
) else (
    start "" "http://localhost:3001/"
)

echo.
echo ========================================
echo  System is running - Do NOT close this!
echo ========================================
echo.
echo Press any key to STOP the system...
pause >nul
taskkill /f /im node.exe >nul 2>&1
echo System stopped.
timeout /t 2 /nobreak >nul
