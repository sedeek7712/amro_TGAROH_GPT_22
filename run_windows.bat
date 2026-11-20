@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title نظام الإدارة التجارية والمحاسبية - تشغيل محلي

echo ================================================================
echo       نظام الإدارة التجارية والمحاسبية المتكامل
echo       Windows Local PWA - IndexedDB
echo ================================================================
echo.

:: تحقق من Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [X] لم يتم العثور على Node.js.
    echo     ثبت إصدار LTS 20 أو أحدث من:
    echo     https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo [OK] تم العثور على Node.js.

:: تثبيت الاعتماديات من ملف القفل عند أول تشغيل
if not exist "node_modules\" (
    echo.
    echo [*] تثبيت ملفات التشغيل لأول مرة...
    call npm ci
    if errorlevel 1 (
        echo [X] فشل تثبيت الاعتماديات. تحقق من اتصال الإنترنت ثم أعد المحاولة.
        pause
        exit /b 1
    )
)

:: بناء نسخة الإنتاج قبل التشغيل لضمان عدم تشغيل ملفات قديمة
echo.
echo [*] إنشاء نسخة الإنتاج...
call npm run build
if errorlevel 1 (
    echo [X] فشل البناء. لم يتم تشغيل النظام.
    pause
    exit /b 1
)

:: تشغيل نسخة الإنتاج على هذا الجهاز فقط
echo.
echo [OK] تم البناء بنجاح.
echo [OK] افتح النظام من:
echo     http://localhost:4173
echo.
echo [!] اترك هذه النافذة مفتوحة أثناء الاستخدام.
echo [!] بيانات التشغيل محفوظة محلياً في متصفح هذا الجهاز.
echo [!] لإيقاف النظام اضغط Ctrl + C.
echo ================================================================
echo.

start "" http://localhost:4173
call npm run preview -- --host 127.0.0.1 --port 4173 --strictPort

pause
endlocal
