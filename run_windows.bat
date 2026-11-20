@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Integrated Commercial & Accounting ERP - Vite Local Web Launcher

echo ======================================================================
echo       Integrated Commercial & Accounting ERP System
echo       Local Vite + IndexedDB Offline-First Web Server (Windows)
echo ======================================================================
echo.

:: 1. Check for Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [X] Node.js is not found on your system!
    echo     Please download and install Node.js ^(LTS version 20+^) from:
    echo     https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo [OK] Node.js detected successfully.

:: 2. Check if node_modules exists, install automatically if missing
if not exist "node_modules\" (
    echo.
    echo [*] Installing dependencies for the first time ^(npm install^)...
    echo.
    if exist "package-lock.json" (
        call npm ci
    ) else (
        call npm install
    )
    if %ERRORLEVEL% neq 0 (
        echo.
        echo [!] Error occurred during npm install. Check your internet connection and try again.
        pause
        exit /b 1
    )
    echo [OK] Dependencies installed successfully.
)

:: 3. Launch browser and Vite local web server
echo.
echo [OK] Launching Vite Local Web Server on http://localhost:3000 ...
echo [*] Note: All operational data stays locally in browser IndexedDB ^(Dexie^).
echo [*] To stop the server anytime, press Ctrl + C in this window.
echo ======================================================================
echo.

start "" http://localhost:3000
call npm run dev

pause
