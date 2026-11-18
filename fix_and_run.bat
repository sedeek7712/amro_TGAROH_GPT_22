@echo off
chcp 65001 >nul
title Fix Packages and Run - Alharaj ERP

echo ======================================================================
echo       Integrated ERP System - Automatic Fix & Launcher
echo ======================================================================
echo.
echo Cleaning outdated rolldown bindings and reinstalling clean Vite 6...
echo.
echo [1/3] Removing old node_modules and package-lock.json...

if exist "package-lock.json" del /f /q "package-lock.json"
if exist "node_modules\" rmdir /s /q "node_modules"

echo [✓] Cleaned successfully.
echo.
echo [2/3] Reinstalling dependencies (npm install)...
call npm install

if %ERRORLEVEL% neq 0 (
    echo [X] Installation failed. Please check internet connection.
    pause
    exit /b
)

echo.
echo [✓] Installed successfully.
echo.
echo [3/3] Starting server at http://localhost:3000...
start "" http://localhost:3000
call npm run dev

pause
