@echo off
title Push to GitHub
cd /d "%~dp0"

echo ====================================================
echo Starting Git Push to GitHub...
echo ====================================================
echo.

git init
git branch -M main
git remote remove origin >nul 2>&1
git remote add origin https://github.com/sedeek7712/amro_TGAROH_GPT_22.git

echo Adding files...
git add .

echo Committing files...
git commit -m "Update ERP System"

echo Pushing to GitHub...
git push -u origin main

echo.
echo ====================================================
echo Process complete.
echo ====================================================
pause
