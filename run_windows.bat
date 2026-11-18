@echo off
chcp 65001 >nul
title Integrated Commercial & Accounting ERP - Local Launcher

echo ======================================================================
echo       Integrated Commercial & Accounting ERP System
echo             Automatic Local Launcher for Windows
echo ======================================================================
echo.

:: 1. Check for Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [X] Node.js is not found on your system!
    echo     Please download and install Node.js (LTS version) from:
    echo     https://nodejs.org/
    echo.
    echo Or access the online cloud version directly in your browser:
    echo https://ais-pre-whq6c7263bbvzvlv2i2kaa-364280012769.europe-west3.run.app
    echo.
    pause
    exit /b
)

echo [✓] Node.js detected successfully.

:: 2. Check if node_modules exists, install automatically if missing
if not exist "node_modules\" (
    echo.
    echo [*] Installing dependencies for the first time (npm install)...
    echo     Please wait, this is only needed once.
    echo.
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo.
        echo [!] Error occurred during npm install. Check your internet connection and try again.
        pause
        exit /b
    )
    echo [✓] Dependencies installed successfully.
)

:: 3. Launch browser and Vite dev server
echo.
echo [✓] Launching ERP Local Server...
echo [*] Your browser will open automatically at: http://localhost:3000
echo [*] To stop the server anytime, press Ctrl + C in this window.
echo ======================================================================
echo.

start "" http://localhost:3000
call npm run dev

pause
