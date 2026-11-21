# تقرير الفحص الشامل للمرحلة الأولى (Phase 1 Audit Report)
**تاريخ الفحص:** 2026-11-21  
**الفرع:** `feature/windows-exe-sqlite`  
**المرجع الأساسي:** الوثيقة المرجعية الرئيسية لاستكمال نظام عمرو النماري (الإصدار 1.0)  
**آخر commit مبدئي مفحوص:** `3e92b437063c3f252c6c6b848e1759607e75b297`

---

## 1. ملخص الوضع عند استلام الفرع
- تم التحقق من جميع الفحوص الأساسية الموجودة في الفرع (`verify_sqlite_schema.py`, `verify_sqlite_runtime.mjs`, `verify_sqlite_auth.mjs`, `verify_sqlite_import.mjs`, `npm run verify`) ونجحت جميعها على Node `v22.23.2` عبر `node:sqlite`.
- توجد نواة Electron Main + Preload + SQLite + المصادقة المكتبية + مستورد النسخ القديمة JSON، لكن طبقة الخدمات التشغيلية والمالية في Windows غير متصلة بعد بـ SQLite، وشاشة التشغيل في `src/App.tsx` محجوبة عمدًا حتى إتمام النقل.

---

## 2. جرد الملفات ومصادر البيانات (Inventory)

| الملف | الوظيفة | مصدر البيانات الحالي | حالة النقل لـ SQLite | العوائق / الفجوات | الاختبارات المطلوبة |
|---|---|---|---|---|---|
| `electron/main.mjs` | العملية الرئيسية ونافذة Electron وحماية الإطار وقفل النسخة الواحدة | `node:sqlite` + الذاكرة | نواة جزئية (مصادقة وحالة فقط) | يفتقر لقنوات IPC للنطاقات التجارية والنسخ الاحتياطي والاستيراد والإعدادات | اختبارات IPC + التحقق من الجلسة والصلاحيات والفرع والمدخلات |
| `electron/preload.cjs` | جسر `contextBridge` المحدود (`window.amroDesktop`) | IPC إلى Main | نواة جزئية (7 دوال مصادقة وحالة) | يحتاج دوال النطاقات التشغيلية والمالية واشتراك تغير البيانات `onDataChanged` | اختبار عدم كشف `fs`/`sqlite`/Node |
| `electron/security/authentication.mjs` | المصادقة المكتبية PBKDF2، الجلسات في الذاكرة، القفل بعد 5 محاولات | SQLite `users` + `branches` | منقول جزئيًا | يحتاج `switchUser` و`adminResetUserPassword` والبذر التأسيسي المرجعي عند إنشاء المدير الأول فقط | اختبارات التبديل وتغيير كلمة المرور والقفل وعزل الفروع |
| `electron/sqlite/database.mjs` | فتح `erp.sqlite` في `appData/AmroAlnmaryERP/Database`، الترحيلات، WAL، Online Backup | `node:sqlite` | مكتمل للأساس | يحتاج آلية `restoreSqliteBackup` آمنة (فحص سلامة النسخة، أخذ نسخة قبل الاستبدال، إغلاق ثم استبدال ذري) | اختبارات النسخ والاستعادة الفعلية وفحص سلامة البيانات المستعادة |
| `electron/sqlite/legacy-backup-importer.mjs` | معاينة واستيراد نسخ JSON القديمة إلى SQLite فارغة | `node:sqlite` | مكتمل | غير مربوط بعد عبر IPC في `main.mjs` و`DesktopLoginScreen.tsx` | اختبار استيراد من واجهة IPC ورفض القاعدة غير الفارغة |
| `electron/sqlite/migrations/001_initial.sql` | مخطط الجداول المرجعية والمالية والتشغيلية | SQLite DDL | مكتمل للإصدار 1 | يجب الحفاظ على التطابق بين الأعمدة المفهرسة (`*_decimal`, جداول الأبناء) و`data_json` | فحص `integrity_check` و`foreign_key_check` |
| `src/types/desktop.d.ts` | عقود TypeScript لـ `window.amroDesktop` | Types | جزئي (المصادقة فقط) | توسعته ليشمل جميع عقود `sqliteDataService` والإعدادات والنسخ الاحتياطي | `tsc --noEmit` |
| `src/services/dataService.ts` | واجهة `IDataService` الموحدة ومزود البيانات | `dexieDataService` فقط | غير منقول | يصدر `dexieDataService` دائمًا في كل البيئات | التحقق من اختيار `sqliteDataService` على Electron و`dexieDataService` على الويب |
| `src/services/dexieDataService.ts` | تنفيذ `IDataService` للويب عبر Dexie | Dexie + `localStorage` | يخص الويب (يُحفظ كما هو) | يُترك للويب/PWA دون كسر مع التأكد من عدم استدعائه على Windows | استمرار نجاح `phase5` و`phase6` |
| `src/services/storageService.ts` | خدمة مساعدة قديمة مبنية على `localStorage` + ثوابت الشجرة والأنشطة | `localStorage` | لا يُنقل بل يُفصل عن Windows | `storage.initialize()` يعمل عند الاستيراد! يجب منعه من قراءة/كتابة `localStorage` على Windows وتوجيه الإعدادات/السياق لـ `desktopSession` | فحص عدم استخدام `localStorage` في بيئة Electron |
| `src/config/currency.ts` | تقريب وتنسيق العملة وإعدادات `CurrencyConfig` | `localStorage` | يحتاج ربطًا بذاكرة الجلسة | يقرأ/يكتب `multi_activity_erp_company_profile` من `localStorage` مباشرة | مزامنة ذاكرة العملة مع ملف الشركة من SQLite في Windows |
| `src/services/authService.ts` | مصادقة الويب و`validatePasswordStrength` وPBKDF2 | `localStorage` / Dexie | للويب فقط | فصل `getCurrentActorSync` بحيث يقرأ من `desktopSession` على Windows | فحص حدود المصادقة المكتبية |
| `src/services/desktopAuthAdapter.ts` | مهايئ المصادقة المكتبية | `window.amroDesktop` | جزئي | إضافة `switchUser`, `adminResetPassword`, `previewLegacyBackup`, `importLegacyBackup` | اختبارات المهايئ |
| `src/hooks/useLiveDexie.ts` | الخطافات الحية لكل الجداول وحالة التهيئة | Dexie `liveQuery` | معطل على Electron | يرجع `[]` عند وجود `window.amroDesktop`؛ يجب تحويله في Electron إلى قراءة عبر `dataService` + اشتراك حدث التحديث الفوري دون لمس `IndexedDB` | اختبار تحديث البيانات في الواجهة عند التعديل دون IndexedDB |
| `src/services/syncQueueService.ts` | إدارة طابور Outbox وتعارضات المزامنة | Dexie `outbox` / `syncConflicts` | غير منقول | يقرأ/يكتب `db.outbox` و`db.syncConflicts` مباشرة | نقل عمليات الطابور والتعارضات لتمر عبر `dataService` / SQLite في Electron |
| `src/services/djangoSyncService.ts` | إعدادات ومزامنة Django REST | `localStorage` + `db.*` | غير منقول | يقرأ/يكتب الإعدادات في `localStorage` والكيانات في `db` | قراءة/حفظ الإعدادات في `app_settings` بـ SQLite وتمرير البيانات عبر `dataService` |
| `src/services/supabaseSyncService.ts` | إعدادات ومزامنة Supabase | `localStorage` + `db.*` | غير منقول | يقرأ/يكتب الإعدادات و`deviceId` في `localStorage` والكيانات في `db` | حفظ `deviceId` وإعدادات المزامنة في SQLite (`app_settings` + `device_registrations`) وتمرير الكيانات عبر `dataService` |
| `src/db/erpDatabase.ts` | تعريف مخطط Dexie v5 والترحيل من IndexedDB القديم | IndexedDB / Dexie | للويب فقط | التأكد من عدم فتحه نهائيًا في Electron | فحص حدود `verify_desktop_auth_boundary.mjs` |
| `src/App.tsx` | المكون الجذري وإدارة الجلسة والعرض | `Desktop` محجوب / `Web` Dexie | محجوب عمدًا | يُرفع الحجب فقط بعد اكتمال D ونجاح كل الاختبارات؛ يحتاج تهيئة `desktopSession` وإدارة تبديل الفرع | اختبارات التكامل + Playwright |
| `src/components/auth/DesktopLoginScreen.tsx` | شاشة الدخول المكتبية وإعداد المدير الأول | Electron Auth IPC | جزئي | إضافة خيار استيراد نسخة JSON قديمة عند الإعداد الأولي (قبل إنشاء مدير) | اختبار الاستيراد الأولي وإعداد المدير |
| `src/components/pos/PointOfSale.tsx` | نقطة البيع | `dataService` + `storage` (لـ UUID/branch/activities/cashBoxes) | مرتبط بـ `dataService` | استبدال نداءات `storage` المباشرة بما يتوافق مع SQLite في Windows | اختبارات البيع والفاتورة وFEFO |
| `src/components/purchases/PurchasesManager.tsx` | فواتير المشتريات | `dataService` + `storage` | مرتبط بـ `dataService` | استبدال نداءات `storage` المباشرة | اختبارات الشراء والتكلفة والتشغيلات |
| `src/components/inventory/InventoryManager.tsx` | المخزون والأصناف | `dataService` + `storage.generateUUID` | مرتبط بـ `dataService` | استبدال `storage.generateUUID` | اختبارات حفظ الصنف وتعديل الرصيد |
| `src/components/accounting/AccountingModule.tsx` | الدليل المحاسبي والقيود | `dataService` + `storage` | مرتبط بـ `dataService` | استبدال `storage.getCurrentUser()` / `getActiveBranchId()` / `generateUUID()` | اختبارات القيد اليدوي والعكسي وميزان المراجعة |
| `src/components/cash/CashManager.tsx` | الصناديق وسندات القبض والصرف | `dataService` + `storage.generateUUID` | مرتبط بـ `dataService` | استبدال `storage.generateUUID` | اختبارات الصناديق ومنع السحب فوق الرصيد |
| `src/components/amanat/AmanatManager.tsx` | الأمانات النقدية والعينية | `dataService` + `storage` | مرتبط بـ `dataService` | استبدال `storage` | اختبارات إيداع ورد الأمانات |
| `src/components/parties/PartiesManager.tsx` | العملاء والموردون | `dataService` + `storage.generateUUID` | مرتبط بـ `dataService` | استبدال `storage.generateUUID` | اختبارات إضافة/تحديث الطرف |
| `src/components/users/UserPermissionsManager.tsx` | المستخدمون والصلاحيات | `dataService` + `authService` (`verifyPassword`/`hashPassword`) | جزئي | في Windows: `currentUser.passwordHash` غير موجود بالواجهة؛ يجب تمرير إنشاء المستخدم وإعادة تعيين كلمة المرور وتبديل المستخدم عبر Electron IPC | اختبارات الصلاحيات وتبديل المستخدم وإعادة تعيين كلمة المرور |
| `src/components/settings/CompanySettings.tsx` | إعدادات الشركة والعملة | `storage.getCompanyProfile()` / `saveCompanyProfile()` | غير منقول | يقرأ ويكتب في `localStorage` فقط؛ يجب ربطه بـ `dataService`/SQLite `app_settings` | اختبار حفظ واستمرار ملف الشركة والعملة |
| `src/components/sync/SyncBackupModal.tsx` | المزامنة والفروع والنسخ الاحتياطي | `dataService` + `storage` + `syncQueueService` + `djangoSyncService` + `supabaseSyncService` | جزئي | إضافة النسخ الاحتياطي والاستعادة لملفات SQLite في Windows + إزالة الاعتماد على `storage` | اختبارات النسخ والاستعادة وتبديل الفرع |
| `src/components/layout/TopBar.tsx` | الشريط العلوي واسم الفرع والشبكة | `storage.getActiveBranchId()` / `getActiveBranch()` | جزئي | قراءة الفرع النشط من سياق الجلسة الموحد و`useLiveBranches` | اختبار عرض الفرع الصحيح |
| `src/components/dashboard/ExecutiveDashboard.tsx` | لوحة التحكم | `useLive*` + `storage.getProducts()` | جزئي | استبدال `storage.getProducts().length === 0` بـ `liveProducts.length === 0` | اختبار عرض الأرصدة الحقيقية |
| `src/components/reports/ReportsManager.tsx` | التقارير المالية والمخزنية | `useLive*` + `storage` | جزئي | استبدال `storage` بسياق المستخدم/الفرع/الأنشطة الموحد | اختبار عدم اعتماد التقارير على `localStorage` |
| `src/components/common/CustomerNotificationModal.tsx` | نافذة إشعار واتساب | `storage.getBranches()` / `getActiveBranchId()` | جزئي | استخدام `useLiveBranches()` وسياق الفرع النشط | اختبار عرض بيانات الفرع |
| `src/components/common/ReceiptModal.tsx` | عرض وطباعة الإيصال | `getActiveCurrencyConfig()` | جاهز تقريبًا | يقرأ العملة النشطة من الذاكرة/ملف الشركة المحمّل من SQLite | اختبار العملة الصحيحة |

---

## 3. مقارنة مخطط Dexie ومخطط SQLite
- **الجداول المتطابقة في SQLite (`001_initial.sql`):**
  `tenants`, `branches`, `activities`, `accounts`, `products`, `product_batches`, `parties`, `invoices`, `invoice_items`, `invoice_stock_deductions`, `journal_entries`, `journal_entry_lines`, `cash_boxes`, `vouchers`, `amanat_records`, `users`, `audit_logs`, `outbox_queue`, `sync_conflicts`, `document_sequences`, `pos_terminals`, `device_registrations`, `legacy_imports`, `app_settings`.
- **نقاط الحرج المعماري المكتشفة:**
  1. **التخزين المزدوج المتزامن:** تعتمد `legacy-backup-importer.mjs` وفحوص الترحيل على أعمدة `*_decimal` وجداول الأبناء (`product_batches`, `invoice_items`, `invoice_stock_deductions`, `journal_entry_lines`) بجانب `data_json`. لذا فإن أي عملية SQLite تكتب أو تعدل فاتورة أو قيدًا أو صنفًا **يجب** أن تحدث الأعمدة وجداول الأبناء و`data_json` معًا داخل نفس المعاملة الذرية `BEGIN IMMEDIATE`.
  2. **البذر المرجعي مقابل الاستيراد القديم:** تفرض `assertEmptyDestination` في `legacy-backup-importer.mjs` أن تكون جداول `accounts`, `activities`, `cash_boxes`, `users` وغيرها فارغة عند الاستيراد. لذلك يجب عدم بذر الحسابات والأنشطة والصناديق عند فتح SQLite فارغة، بل بذرها فقط عند `createInitialAdmin` (أو دالة بذر صريحة بعد اعتماد إنشاء مدير أول جديد بدون استيراد).
  3. **كلمات المرور والمصادقة:** صيغة `pbkdf2_sha256$100000$<salt>$<hash>` متطابقة حرفيًا بين `authService.ts` و`authentication.mjs`. لا تُرسل `passwordHash` إلى واجهة Windows، وتتم عمليات إنشاء المستخدمين وتبديلهم وإعادة تعيين كلمات المرور داخل `electron/security/authentication.mjs`.
  4. **التمثيل النقدي الدقيق:** استخدام وحدات عددية صحيحة (`BigInt`) بمقياس `100n` (هللتين/قرشين) للمبالغ المالية، و`10000n` للكميات وتكاليف الوحدة، و`1000000n` لمطابقة تقارير المجاميع في المستورد القديم، مع التقريب بنمط `HALF_UP`.

---

## 4. تصنيف العمليات من حيث الاتصال بالإنترنت والمزامنة
1. **عمليات محلية بالكامل (تعمل دون إنترنت وتُحفظ في SQLite فورًا):**
   - المصادقة المكتبية، إنشاء وتبديل المستخدمين محليًا (حسب صلاحيات الدور)، نقاط البيع، المشتريات، إدارة المخزون والتشغيلات، سندات القبض والصرف، الأمانات، القيود اليومية والعكسية، التقارير، النسخ الاحتياطي والاستعادة لملفات SQLite.
   - تسجيل حدث ذري في `outbox_queue` ضمن نفس معاملة العملية المالية بـ `idempotency_key` ثابت (`<entityType>:<id>:<action>`).
2. **عمليات تتطلب اتصالاً بالإنترنت (اختيارية عند التفعيل السحابي):**
   - فحص الاتصال بخادم Django REST أو Supabase، سحب التحديثات السحابية (`Delta Pull`)، رفع عناصر `outbox_queue` بحجز مؤقت (`SYNCING` + `leaseExpiresAt`)، وحل التعارضات مع الاحتفاظ بالبيانات المحلية ومنع LWW الأعمى على السجلات المرحلة.
3. **عمليات تتطلب صلاحية مدير عام وموافقة إدارية:**
   - إنشاء الحسابات، تغيير الصلاحيات، تبديل الفرع الرئيسي غير المصرح به للآخرين، تصفير الدفاتر (`resetToCleanBooks`)، استعادة نسخة احتياطية (`restoreSqliteBackup`)، واستيراد نسخة JSON قديمة.

---

## 5. ترتيب الدفعات التنفيذية وخطة التحقق
1. **الدفعة أ (Batch A):** وحدة الحساب الدقيق `money.mjs` + البذر المرجعي `seed-data.mjs` + خدمة الأساسيات (`core-service.mjs`: المنشآت، الفروع، الأنشطة، الحسابات، المستخدمين، الإعدادات، التدقيق، العدادات، تصفير الدفاتر) + تحديث المصادقة (`switchUser`, `adminResetUserPassword`, `createInitialAdmin` مع البذر) + ربط استيراد JSON القديم بـ IPC وشاشة الدخول + `desktopSession.ts` + تفعيل `useLiveDexie.ts` عبر IPC وحدث تغير البيانات + اختبارات Node شاملة.
2. **الدفعة ب (Batch B):** خدمة المخزون والأطراف (`inventory-parties-service.mjs` مع تزامن `products` و`product_batches` وخصم FEFO ومنع المنتهي) + اختبارات Node شاملة.
3. **الدفعة ج (Batch C):** المحرك المالي الذري في SQLite (`financial-service.mjs`: فواتير البيع، فواتير الشراء، الصناديق والسندات، الأمانات النقدية والعينية، القيود اليدوية والعكسية داخل `BEGIN IMMEDIATE` وحسابات `BigInt`) + اختبارات سلامة مالية وتراجع وتزامن شاملة.
4. **الدفعة د (Batch D):** النسخ الاحتياطي والاستعادة لـ SQLite عبر حوار النظام والنسخ الآلي الموثق، وطابور `outbox_queue` و`sync_conflicts` في SQLite، وإزالة اعتماد `localStorage` في المكونات والخدمات (`currency.ts`, `storageService.ts`, `syncQueueService.ts`, `djangoSyncService.ts`, `supabaseSyncService.ts`, `CompanySettings`, `UserPermissionsManager`, `SyncBackupModal`, إلخ) + اختبارات شاملة.
5. **الدفعة هـ (Batch E):** تبديل `src/services/dataService.ts` لاستخدام `sqliteDataService` في Electron و`dexieDataService` في الويب، إزالة الحجب المؤقت في `src/App.tsx`، تحديث فحوص الحدود المعمارية، تشغيل كامل حزمة الاختبارات والتحقق في المتصفح (`playwright-cli`) والفحوص النهائية.
