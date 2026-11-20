@echo off
chcp 65001 >nul
title Safe GitHub Sync (No Force Push)
cd /d "%~dp0"

echo ====================================================
echo Checking Repository Status...
echo ====================================================
echo.

where git >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [X] Git is not installed on this machine.
    pause
    exit /b 1
)

if exist ".git\index.lock" (
    echo [!] Active Git lock detected (.git\index.lock).
    echo     Close other Git processes before continuing. Aborting safely.
    pause
    exit /b 1
)

git status -s
echo.
set /p COMMIT_MSG="Enter commit message (or press Enter for default): "
if "%COMMIT_MSG%"=="" set COMMIT_MSG=Update ERP System

git add .
git commit -m "%COMMIT_MSG%"
if %ERRORLEVEL% neq 0 (
    echo [!] No new changes committed or commit aborted.
)

echo Rebasing with origin/main...
git pull --rebase origin main
if %ERRORLEVEL% neq 0 (
    echo [X] Rebase conflict or remote error. Resolve conflicts manually before pushing.
    pause
    exit /b 1
)

echo Pushing to origin/main...
git push -u origin main
if %ERRORLEVEL% neq 0 (
    echo [X] Push failed. Please inspect Git error above.
    pause
    exit /b 1
)

echo.
echo ====================================================
echo Safe sync complete.
echo ====================================================
pause
