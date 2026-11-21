# وثيقة الإصدار وتقرير التحقق والاختبارات — نظام عمرو النماري متعدد الأنشطة (نسخة Windows / SQLite + Web/PWA)

**التاريخ:** 21 نوفمبر 2026  
**المستودع الرسمي:** `https://github.com/sedeek7712/amro_TGAROH_GPT_22`  
**الفرع المستهدف:** `feature/windows-exe-sqlite` (طلب الدمج المفتوح PR #2 — غير مدمج)

---

## 1. ملخص البنية الهندسية المعتمدة

### أ. نسخة سطح المكتب (Windows Electron + SQLite)
- **محرك التخزين الفعلي:** قاعدة بيانات SQLite محلية حقيقية عبر `node:sqlite` (`DatabaseSync`) في مسار مستقل عن مجلد التثبيت:
  `%APPDATA%\AmroAlnmaryERP\Database\erp.sqlite`
- **عزل العمليات والأمان (`IPC` + `RBAC`):**
  - `contextIsolation: true`، `nodeIntegration: false`، `sandbox: true`، منع التنقل والنوافذ المنبثقة غير الموثوقة.
  - في البناء المعبّأ (`app.isPackaged`): حجب `DevTools`، تعطيل قائمة التطبيق الافتراضية، ومنع اختصارات `F12` و`Ctrl+Shift+I/J/C`.
  - تمرير جميع عمليات القراءة والكتابة المالية عبر `electron/preload.cjs` -> `electron/main.mjs` (`assertTrustedMainFrame` + `handleTrustedIpc`) -> `electron/sqlite/desktop-backend.mjs`.
  - التحقق الصارم من الجلسة، المؤسسة (`tenantId`)، الفرع (`branchId`)، وصلاحيات الدور (`rbac.mjs`) داخل العملية الرئيسية قبل أي معاملة.
- **سلامة العمليات المالية (`money.mjs` + معاملات SQLite الذرية):**
  - حسابات مالية دقيقة بوحدات صغرى صحيحة (`MONEY_SCALE = 100`، `QTY_SCALE = 10000`) دون أخطاء الفاصلة العائمة.
  - تنفيذ فواتير المبيعات (FEFO للصيدلية)، المشتريات (التكلفة المحملة)، السندات، الأمانات النقدية والعينية، والقيود اليومية المتوازنة والقيود العكسية داخل `BEGIN IMMEDIATE ... COMMIT / ROLLBACK` مع مفاتيح منع التكرار `idempotency_key`.
- **ترحيل البيانات القديمة وتوافق كلمات المرور:**
  - معاينة واستيراد نسخ Dexie JSON القديمة (`legacy-backup-importer.mjs`) مع فحص Checksum ومقارنة أعداد السجلات والمجاميع المالية والحفاظ على تجزئات كلمات المرور (`pbkdf2_sha256`).
- **النسخ الاحتياطي، الترقية الآمنة، وسجل التشخيص:**
  - نسخ احتياطي مباشر عبر SQLite Online Backup API مع التحقق عبر `PRAGMA integrity_check` و`PRAGMA foreign_key_check`.
  - دعم النسخ اليدوي، النسخ التلقائي عند الإغلاق (`autoBackupOnExit`)، النسخ الدوري المجدول (`autoBackupIntervalHours`)، التصدير إلى قرص خارجي، والاستعادة الآمنة مع نسخة أمان تلقائية وتراجع آلي عند الفشل.
  - ترقية المخطط بالترتيب مع Checksum وإنشاء نسخة أمان قبل الترحيل والتراجع التلقائي عند فشل الترقية (`openErpDatabase`).
  - سجل تشخيص وأخطاء دوّار (`electron/logging/diagnostic-logger.mjs`) داخل `%APPDATA%\AmroAlnmaryERP\Logs\desktop-diagnostics.log` مع تنقيح كلمات المرور والمفاتيح وإمكانية الاستعراض والتصدير.

### ب. نسخة الويب وPWA
- تستمر الواجهة الموحدة عبر `IDataService` (`src/services/dataService.ts`) باستخدام `dexieDataService` ومصادقة WebCrypto في المتصفح وPWA دون كسر ودون أي استدعاء إجباري لـ Electron.

---

## 2. سجل الاختبارات الآلية والتحقق المنفذة

| الفحص / الحزمة | الأمر المنفذ | النتيجة |
|---|---|---|
| فحص صياغة وحدات Electron | `node --check electron/main.mjs electron/preload.cjs electron/security/authentication.mjs electron/logging/diagnostic-logger.mjs` | ناجح |
| فحص مخطط SQLite بلغة Python | `python3 scripts/verify_sqlite_schema.py` | ناجح |
| اختبار التشغيل والاستمرارية والترحيلات | `node scripts/verify_sqlite_runtime.mjs` | ناجح |
| اختبار المصادقة والقفل (5 محاولات) | `node scripts/verify_sqlite_auth.mjs` | ناجح |
| اختبار استيراد نسخ Dexie والمطابقة المالية | `node scripts/verify_sqlite_import.mjs` | ناجح |
| فحص حدود المعمارية (UI + Auth) | `npm run verify:architecture` | ناجح |
| فحص TypeScript | `npm run lint` (`tsc --noEmit`) | ناجح |
| اختبارات الوحدة والانحدار (`node:test`) | `npm test` | 16 / 16 ناجحة |
| اختبارات SQLite الخلفية (`Batch A..F + money`) | `npm run test:sqlite` | 10 / 10 ناجحة |
| اختبارات المرحلتين 5 و6 | `npm run test:legacy` | 10 / 10 + 10 / 10 ناجحة |
| بناء الإنتاج والـ PWA | `npm run build` | ناجح |
| التحقق التفاعلي في المتصفح (`Chromium`) | `playwright-cli` على `http://localhost:3000` (1440×900 و390×844) | ناجح (0 أخطاء Console) |

---

## 3. قائمة التحقق الميداني الإلزامية على Windows الفعلي (قبل اعتماد الإنتاج)

تُنفذ البنود التالية بعد رفع التغييرات إلى فرع `feature/windows-exe-sqlite` وإنتاج المثبت من مسار `windows-exe-preview` في GitHub Actions:

- [ ] تشغيل سير عمل CI (`verify`، `sqlite-electron-runtime`، `windows-exe-preview`) على أحدث commit والتحقق من نجاحها.
- [ ] تنزيل حزمة المثبت `amro-erp-shell-*-x64.exe` وتثبيتها على جهاز Windows x64 فعلي.
- [ ] التحقق من ظهور الاختصار على سطح المكتب وقائمة ابدأ بالأيقونة الرسمية وعدم ظهور `DevTools`.
- [ ] إنشاء حساب المدير الأول، تسجيل الدخول، وإنشاء فواتير وسندات وحركات فعلية.
- [ ] إغلاق البرنامج وإعادة تشغيل نظام Windows بالكامل ثم التحقق من بقاء الأرصدة والسجلات.
- [ ] إنشاء نسخة احتياطية SQLite (محلياً وعلى قرص خارجي) واستعادتها والتحقق من تطابق الأرصدة والمستخدمين.
- [ ] تثبيت نسخة محدثة فوق النسخة المثبتة مسبقاً والتحقق من بقاء البيانات في `%APPDATA%\AmroAlnmaryERP`.
