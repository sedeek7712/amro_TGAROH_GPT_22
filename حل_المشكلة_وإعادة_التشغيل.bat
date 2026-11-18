@echo off
chcp 65001 >nul
title إصلاح الحزم وتشغيل النظام - Alharaj ERP

echo ======================================================================
echo       نظام الإدارة التجارية والمحاسبية المتكامل (ERP)
echo             معالج الإصلاح التلقائي وإعادة التشغيل
echo ======================================================================
echo.
echo سبب المشكلة:
echo قام مدير الحزم npm بتحميل نسخة تجريبية غير متوافقة مع نظام Windows (rolldown).
echo سيقوم هذا الملف بحذف المجلد القديم وتثبيت النسخة المستقرة Vite 6 تلقائياً.
echo.
echo [1/3] جاري تنظيف الحزم القديمة و package-lock.json...

if exist "package-lock.json" del /f /q "package-lock.json"
if exist "node_modules\" rmdir /s /q "node_modules"

echo [✓] تم التنظيف بنجاح.
echo.
echo [2/3] جاري إعادة التثبيت النظيف (npm install)... يرجى الانتظار دقيقة...
call npm install

if %ERRORLEVEL% neq 0 (
    echo.
    echo [X] حدث خطأ أثناء التثبيت. تأكد من اتصالك بالإنترنت ثم حاول مجدداً.
    pause
    exit /b
)

echo.
echo [✓] تم تثبيت الحزم المتوافقة بنجاح!
echo.
echo [3/3] جاري إطلاق النظام وفتح المتصفح...
start "" http://localhost:3000
call npm run dev

pause
