@echo off
chcp 65001 >nul
cd /d "%~dp0"
title نظام الإدارة التجارية والمحاسبية المتكامل - خادم ويب محلي (Vite)

echo ======================================================================
echo       نظام الإدارة التجارية والمحاسبية المتكامل (ERP)
echo       التشغيل المحلي عبر Node.js وخادم Vite في المتصفح
echo ======================================================================
echo.

:: 1. التحقق من وجود Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [X] لم يتم العثور على Node.js على جهازك!
    echo     يرجى تحميل وتثبيت Node.js ^(الإصدار الموصى به LTS 20+^) من:
    echo     https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo [OK] تم التحقق من Node.js بنجاح.

:: 2. التحقق من وجود مجلد node_modules
if not exist "node_modules\" (
    echo.
    echo [*] جاري تثبيت الحزم والمكتبات لأول مرة ^(npm install^)...
    echo.
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo.
        echo [!] حدث خطأ أثناء تثبيت المكتبات. يرجى التأكد من اتصال الإنترنت ثم إعادة المحاولة.
        pause
        exit /b 1
    )
    echo [OK] تم تثبيت جميع المكتبات بنجاح.
)

:: 3. فتح المتصفح وتشغيل خادم Vite المحلي
echo.
echo [OK] جاري إطلاق خادم الويب المحلي على: http://localhost:3000
echo [*] ملاحظة: هذا التطبيق يعمل كتطبيق ويب تقدمي ^(PWA^) وتُحفظ بياناته محلياً في المتصفح ^(IndexedDB / Dexie^).
echo [*] لإيقاف الخادم لاحقاً، اضغط Ctrl + C في هذه النافذة.
echo ======================================================================
echo.

start "" http://localhost:3000
call npm run dev

pause
