@echo off
title Push to GitHub
cd /d "%~dp0"

echo ====================================================
echo Cleaning Git Locks and Preparing Push...
echo ====================================================
echo.

:: حذف ملف القفل العالق إن وجد
if exist ".git\index.lock" del /f /q ".git\index.lock"

:: ضبط الفرع والرابط
git remote remove origin >nul 2>&1
git remote add origin https://github.com/sedeek7712/amro_TGAROH_GPT_22.git

echo Adding files...
git add .

echo Committing files...
git commit -m "Update ERP System"

echo Setting branch to main...
git branch -M main

echo Pushing to GitHub...
git push -u origin main --force

echo.
echo ====================================================
echo Process complete.
echo ====================================================
pause
