/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * خدمة البيانات المتقدمة عبر Dexie / IndexedDB (DexieDataService)
 * تطبق IDataService مع:
 * - آلة حالات التهيئة الصارمة (InitState: NOT_STARTED | INITIALIZING | READY | FAILED) (DB-03)
 * - ترحيل آمن وغير متلف من localStorage مع مقارنة الطوابع الزمنية ونسخة احتياطية مسبقة (DB-02)
 * - إنفاذ RBAC وعزل المؤسسات والفروع داخل طبقة الخدمات (SEC-02, SYNC-05)
 * - تسلسلات أرقام ذرية عبر جدول sequences (FIN-01)
 * - منع التكرار الإيدمبوتينت (Idempotency) والتحقق المالي الشامل (FIN-02, FIN-03)
 */

import { db, requestPersistentStorage, migrateLegacyIndexedDbIfNeeded } from '../db/erpDatabase';
import {
  CommercialActivity,
  CommercialActivityId,
  CompanyProfile,
  Account,
  AccountType,
  Product,
  ProductBatch,
  Party,
  Invoice,
  InvoiceItem,
  JournalEntry,
  JournalEntryLine,
  StockDeductionRecorded,
  CashBox,
  PaymentVoucher,
  PaymentAllocation,
  PartyAdvanceTransaction,
  AllocationAudit,
  VoucherManualAllocationInput,
  AmanatRecord,
  AmanatReturnEvent,
  SystemUser,
  SystemAuditLog,
  CostCenterId,
  OutboxQueueItem,
  Branch,
} from '../types/erp';
import { IDataService } from './dataService';
import { OFFICIAL_ACTIVITIES, INITIAL_CHART_OF_ACCOUNTS, storage } from './storageService';
import { syncQueueService } from './syncQueueService';
import { authService, hashPassword, validatePasswordStrength } from './authService';
import {
  Permission,
  assertActivityAccess,
  assertBranchAccess,
  assertPermission,
  filterAuditLogsForUser,
  filterRecordsByActivityScope,
  filterRecordsByBranchScope,
  hasPermission,
} from '../config/rbac';
import { getActiveCurrencyConfig, roundMoney } from '../config/currency';
import {
  FinancialValidationError,
  validateAmanatDepositInput,
  validateAmanatReturnInput,
  validateJournalEntryInput,
  validateProductStockConsistency,
  validatePurchaseInvoiceInput,
  validateSalesInvoiceInput,
  validateVoucherInput,
} from './financialValidation';
import {
  SPECIAL_ACCOUNTS,
  fromCents,
  getInvoiceRemainingAmount,
  resolveVoucherAccountingPlan,
  toCents,
} from '../../electron/sqlite/payment-allocation-engine.mjs';

function validateCatalogBackupData(data: Record<string, unknown>): void {
  const readRows = (key: string): Array<Record<string, unknown>> => {
    const value = data[key] ?? [];
    if (!Array.isArray(value) || !value.every((row) => Boolean(row) && typeof row === 'object' && !Array.isArray(row))) {
      throw new Error(`بيانات الكتالوج غير صالحة في النسخة الاحتياطية: ${key}.`);
    }
    return value as Array<Record<string, unknown>>;
  };

  const brands = readRows('brands');
  const families = readRows('productFamilies');
  const metadata = readRows('productCatalogMeta');
  const products = readRows('products');
  const brandByKey = new Map<string, Record<string, unknown>>();
  const familyByKey = new Map<string, Record<string, unknown>>();
  const productById = new Map<string, Record<string, unknown>>();
  const normalizedBrandNames = new Set<string>();

  for (const brand of brands) {
    const tenantId = String(brand.tenantId || '');
    const id = String(brand.id || '');
    const normalizedName = String(brand.normalizedName || '').trim();
    if (!tenantId || !id || !normalizedName) throw new Error('توجد علامة تجارية ناقصة البيانات في النسخة الاحتياطية.');
    const key = `${tenantId}:${id}`;
    const normalizedKey = `${tenantId}:${normalizedName}`;
    if (brandByKey.has(key) || normalizedBrandNames.has(normalizedKey)) {
      throw new Error('توجد علامة تجارية مكررة في النسخة الاحتياطية.');
    }
    brandByKey.set(key, brand);
    normalizedBrandNames.add(normalizedKey);
  }

  for (const family of families) {
    const tenantId = String(family.tenantId || '');
    const id = String(family.id || '');
    if (!tenantId || !id || !String(family.activityId || '') || !String(family.nameAr || '').trim()) {
      throw new Error('توجد مجموعة منتجات ناقصة البيانات في النسخة الاحتياطية.');
    }
    const key = `${tenantId}:${id}`;
    if (familyByKey.has(key)) throw new Error('معرّف مجموعة المنتجات مكرر في النسخة الاحتياطية.');
    if (family.brandId && !brandByKey.has(`${tenantId}:${String(family.brandId)}`)) {
      throw new Error('العلامة التجارية المرتبطة بمجموعة المنتجات غير موجودة في النسخة الاحتياطية.');
    }
    familyByKey.set(key, family);
  }

  for (const product of products) {
    const id = String(product.id || '');
    if (id) productById.set(id, product);
  }

  const variantKeys = new Set<string>();
  for (const meta of metadata) {
    const tenantId = String(meta.tenantId || '');
    const productId = String(meta.productId || '');
    const product = productById.get(productId);
    if (!tenantId || !product) throw new Error('بيانات كتالوج تشير إلى صنف غير موجود في النسخة الاحتياطية.');
    if (product.tenantId && String(product.tenantId) !== tenantId) {
      throw new Error('بيانات كتالوج الصنف لا تطابق المؤسسة التابعة له.');
    }

    if (meta.familyId) {
      const family = familyByKey.get(`${tenantId}:${String(meta.familyId)}`);
      const variantKey = String(meta.variantKey || '').trim();
      if (!family || !variantKey || meta.brandId) {
        throw new Error('بيانات متغير SKU أو مجموعة المنتج غير مكتملة.');
      }
      if (String(product.activityId || '') !== String(family.activityId || '')) {
        throw new Error('نشاط الصنف لا يطابق نشاط مجموعة المنتج.');
      }
      const optionSchema = Array.isArray(family.optionSchema)
        ? family.optionSchema as Array<Record<string, unknown>>
        : [];
      const attributes = meta.variantAttributes && typeof meta.variantAttributes === 'object' && !Array.isArray(meta.variantAttributes)
        ? meta.variantAttributes as Record<string, unknown>
        : null;
      if (!attributes) throw new Error('خصائص متغير SKU غير صالحة.');
      const allowedKeys = new Set<string>();
      for (const option of optionSchema) {
        const key = String(option.key || '').trim();
        const values = Array.isArray(option.values) ? option.values.map(String) : [];
        if (!key || allowedKeys.has(key) || values.length === 0) {
          throw new Error('مخطط خيارات مجموعة المنتج غير صالح.');
        }
        allowedKeys.add(key);
        const value = attributes[key];
        if (option.required === true && (typeof value !== 'string' || !value.trim())) {
          throw new Error('قيمة خيار مطلوبة مفقودة في متغير SKU.');
        }
        if (value !== undefined && (typeof value !== 'string' || !values.includes(value))) {
          throw new Error('قيمة متغير SKU غير موجودة ضمن خيارات المجموعة.');
        }
      }
      if (Object.keys(attributes).some((key) => !allowedKeys.has(key))) {
        throw new Error('متغير SKU يحتوي خيارًا غير معرّف في المجموعة.');
      }
      const uniqueKey = `${tenantId}:${String(meta.familyId)}:${variantKey}`;
      if (variantKeys.has(uniqueKey)) throw new Error('توجد تركيبة متغير مكررة داخل مجموعة المنتج.');
      variantKeys.add(uniqueKey);
    } else {
      if (!meta.brandId || !brandByKey.has(`${tenantId}:${String(meta.brandId)}`) || meta.variantKey) {
        throw new Error('بيانات العلامة التجارية للمنتج المستقل غير صالحة.');
      }
    }
  }
}

function accountBalanceDeltaByType(type: AccountType, debit: number, credit: number): number {
  if (type === 'LIABILITY' || type === 'EQUITY' || type === 'REVENUE') {
    return roundMoney(credit - debit);
  }
  return roundMoney(debit - credit);
}

const ACTIVITY_INVENTORY_ACCOUNTS: Record<CommercialActivityId, string> = {
  pharmacy: '11041',
  grocery: '11042',
  bike_parts: '11043',
  equipment_parts: '11044',
};

export type InitState = 'NOT_STARTED' | 'INITIALIZING' | 'READY' | 'FAILED';

export interface MigrationReport {
  executed: boolean;
  migratedCount: number;
  skippedCount: number;
  conflictCount: number;
  backupCreated: boolean;
  details: Record<string, { migrated: number; skipped: number; conflicts: number }>;
  timestamp: string;
}

const MIGRATION_V5_MARKER = 'multi_activity_erp_migration_v5_done';
const PRE_MIGRATION_BACKUP_KEY = 'multi_activity_erp_pre_migration_backup';

export class DexieDataService implements IDataService {
  private initState: InitState = 'NOT_STARTED';
  private initError: string | null = null;
  private initPromise: Promise<void> | null = null;

  public getInitState(): InitState {
    return this.initState;
  }

  public getInitError(): string | null {
    return this.initError;
  }

  /**
   * إعادة ضبط حالة التهيئة في بيئة الاختبارات فقط
   */
  public resetForTests(): void {
    this.initState = 'NOT_STARTED';
    this.initError = null;
    this.initPromise = null;
  }

  /**
   * ضمان جاهزية قاعدة البيانات قبل تنفيذ أي عملية تشغيلية أو مالية
   */
  private async ensureReady(): Promise<void> {
    if (this.initState === 'READY') return;
    if (this.initState === 'FAILED') {
      throw new Error(
        `تعذر تنفيذ العملية لأن تهيئة قاعدة البيانات فشلت: ${this.initError || 'خطأ غير معروف'}`
      );
    }
    await this.initialize();
    if ((this.initState as InitState) !== 'READY') {
      throw new Error(
        `قاعدة البيانات غير جاهزة (${this.initState}): ${this.initError || 'يرجى إعادة المحاولة'}`
      );
    }
  }

  public async initialize(): Promise<void> {
    if (this.initState === 'READY') return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      this.initState = 'INITIALIZING';
      this.initError = null;

      try {
        // 1. ترحيل قاعدة البيانات القديمة AlharajErpDB إن وجدت دون مسحها
        const legacyCheck = await migrateLegacyIndexedDbIfNeeded();
        if (legacyCheck.legacyFound && !legacyCheck.verified) {
          throw new Error('فشل التحقق من سلامة ترحيل بيانات IndexedDB السابقة.');
        }

        // 2. طلب حماية التخزين الدائم
        await requestPersistentStorage();

        // 3. استعادة السجلات العالقة بحالة SYNCING جراء انقطاع المتصفح أو انتهاء المهلة
        await syncQueueService.recoverStuckSyncingItems();

        // 4. البذر التأسيسي للجداول المرجعية فقط عند خلوها التام
        const accountsCount = await db.accounts.count();
        if (accountsCount === 0) {
          const initialAccounts = storage.getAccounts();
          await db.accounts.bulkPut(
            initialAccounts.length > 0 ? initialAccounts : INITIAL_CHART_OF_ACCOUNTS
          );
        }

        const activitiesCount = await db.activities.count();
        if (activitiesCount === 0) {
          await db.activities.bulkPut(OFFICIAL_ACTIVITIES);
        }

        const cashBoxesCount = await db.cashBoxes.count();
        if (cashBoxesCount === 0) {
          const initialBoxes = storage.getCashBoxes();
          if (initialBoxes.length > 0) {
            await db.cashBoxes.bulkPut(initialBoxes);
          }
        }

        const usersCount = await db.users.count();
        if (usersCount === 0) {
          const initialUsers = storage.getUsers().map((u) => ({
            ...u,
            tenantId: u.tenantId || 'tenant_main',
            branchId: u.branchId || 'branch_main',
            allowedBranches: u.allowedBranches?.length ? u.allowedBranches : [u.branchId || 'branch_main'],
          }));
          if (initialUsers.length > 0) {
            await db.users.bulkPut(initialUsers);
          }
        }

        const branchesCount = await db.branches.count();
        if (branchesCount === 0) {
          const initialBranches = storage.getBranches();
          if (initialBranches.length > 0) {
            await db.branches.bulkPut(initialBranches);
          }
        }

        // 5. الترحيل الآمن غير المتلف من localStorage إلى Dexie (لمرة واحدة)
        await this.migrateLocalStorageToDexie(false);

        this.initState = 'READY';
      } catch (err: unknown) {
        this.initState = 'FAILED';
        this.initError = err instanceof Error ? err.message : 'فشل غير متوقع في تهيئة قاعدة البيانات.';
        console.error('[DexieDataService] Initialization FAILED:', err);
        throw err instanceof Error ? err : new Error(this.initError);
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  /**
   * استخراج الطابع الزمني للسجل لمقارنة الحداثة دون استبدال البيانات الأحدث
   */
  private extractRecordTimestamp(rec: Record<string, unknown> | undefined): number {
    if (!rec) return 0;
    const candidate =
      rec.updatedAt || rec.timestamp || rec.createdAt || rec.returnedDate || rec.receivedDate || rec.date;
    if (typeof candidate !== 'string' || !candidate) return 0;
    const parsed = Date.parse(candidate);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * ترحيل آمن وإضافي من localStorage إلى Dexie (DB-02)
   * - يحفظ نسخة احتياطية قبل الترحيل
   * - لا يستبدل أي سجل في Dexie إلا إذا كان سجل localStorage أحدث زمنياً بشكل قاطع
   * - يسجل تقريراً مفصلاً في auditLogs
   */
  public async migrateLocalStorageToDexie(force = false): Promise<MigrationReport> {
    const timestamp = new Date().toISOString();
    const emptyReport: MigrationReport = {
      executed: false,
      migratedCount: 0,
      skippedCount: 0,
      conflictCount: 0,
      backupCreated: false,
      details: {},
      timestamp,
    };

    if (typeof localStorage === 'undefined') {
      return emptyReport;
    }

    if (!force && localStorage.getItem(MIGRATION_V5_MARKER) === 'true') {
      return emptyReport;
    }

    // حفظ نسخة احتياطية استباقية لبيانات localStorage قبل أي دمج
    let backupCreated = false;
    try {
      if (!localStorage.getItem(PRE_MIGRATION_BACKUP_KEY)) {
        const snapshot = {
          capturedAt: timestamp,
          products: storage.getProducts(),
          parties: storage.getParties(),
          invoices: storage.getInvoices(),
          journalEntries: storage.getJournalEntries(),
          vouchers: storage.getVouchers(),
          amanat: storage.getAmanatRecords(),
          branches: storage.getBranches(),
          cashBoxes: storage.getCashBoxes(),
        };
        localStorage.setItem(PRE_MIGRATION_BACKUP_KEY, JSON.stringify(snapshot));
        backupCreated = true;
      }
    } catch {
      // في حال امتلاء حصة localStorage نكمل القراءة الحذرة دون فشل الترحيل
    }

    const tableEntries: Array<{
      name: string;
      keyField: string;
      localItems: Array<Record<string, unknown>>;
      table: {
        get: (key: string) => Promise<Record<string, unknown> | undefined>;
        put: (item: Record<string, unknown>) => Promise<unknown>;
      };
    }> = [
      {
        name: 'branches',
        keyField: 'id',
        localItems: storage.getBranches() as unknown as Array<Record<string, unknown>>,
        table: db.branches as unknown as {
          get: (key: string) => Promise<Record<string, unknown> | undefined>;
          put: (item: Record<string, unknown>) => Promise<unknown>;
        },
      },
      {
        name: 'products',
        keyField: 'id',
        localItems: storage.getProducts() as unknown as Array<Record<string, unknown>>,
        table: db.products as unknown as {
          get: (key: string) => Promise<Record<string, unknown> | undefined>;
          put: (item: Record<string, unknown>) => Promise<unknown>;
        },
      },
      {
        name: 'parties',
        keyField: 'id',
        localItems: storage.getParties() as unknown as Array<Record<string, unknown>>,
        table: db.parties as unknown as {
          get: (key: string) => Promise<Record<string, unknown> | undefined>;
          put: (item: Record<string, unknown>) => Promise<unknown>;
        },
      },
      {
        name: 'invoices',
        keyField: 'id',
        localItems: storage.getInvoices() as unknown as Array<Record<string, unknown>>,
        table: db.invoices as unknown as {
          get: (key: string) => Promise<Record<string, unknown> | undefined>;
          put: (item: Record<string, unknown>) => Promise<unknown>;
        },
      },
      {
        name: 'journalEntries',
        keyField: 'id',
        localItems: storage.getJournalEntries() as unknown as Array<Record<string, unknown>>,
        table: db.journalEntries as unknown as {
          get: (key: string) => Promise<Record<string, unknown> | undefined>;
          put: (item: Record<string, unknown>) => Promise<unknown>;
        },
      },
      {
        name: 'vouchers',
        keyField: 'id',
        localItems: storage.getVouchers() as unknown as Array<Record<string, unknown>>,
        table: db.vouchers as unknown as {
          get: (key: string) => Promise<Record<string, unknown> | undefined>;
          put: (item: Record<string, unknown>) => Promise<unknown>;
        },
      },
      {
        name: 'amanatRecords',
        keyField: 'id',
        localItems: storage.getAmanatRecords() as unknown as Array<Record<string, unknown>>,
        table: db.amanatRecords as unknown as {
          get: (key: string) => Promise<Record<string, unknown> | undefined>;
          put: (item: Record<string, unknown>) => Promise<unknown>;
        },
      },
    ];

    let migratedCount = 0;
    let skippedCount = 0;
    let conflictCount = 0;
    const details: MigrationReport['details'] = {};

    await db.transaction(
      'rw',
      [
        db.branches,
        db.products,
        db.parties,
        db.invoices,
        db.journalEntries,
        db.vouchers,
        db.amanatRecords,
        db.auditLogs,
      ],
      async () => {
        for (const entry of tableEntries) {
          let tblMigrated = 0;
          let tblSkipped = 0;
          let tblConflicts = 0;

          for (const localItem of entry.localItems) {
            const key = String(localItem[entry.keyField] || '').trim();
            if (!key) continue;

            const existing = await entry.table.get(key);
            if (!existing) {
              await entry.table.put(localItem);
              tblMigrated++;
              migratedCount++;
            } else {
              const dexieTs = this.extractRecordTimestamp(existing);
              const localTs = this.extractRecordTimestamp(localItem);

              if (localTs > 0 && dexieTs > 0 && localTs > dexieTs) {
                await entry.table.put(localItem);
                tblMigrated++;
                migratedCount++;
              } else {
                tblSkipped++;
                skippedCount++;
                if (JSON.stringify(existing) !== JSON.stringify(localItem)) {
                  tblConflicts++;
                  conflictCount++;
                }
              }
            }
          }

          details[entry.name] = {
            migrated: tblMigrated,
            skipped: tblSkipped,
            conflicts: tblConflicts,
          };
        }

        if (migratedCount > 0 || conflictCount > 0) {
          await db.auditLogs.put({
            id: storage.generateUUID(),
            timestamp,
            userId: 'system_migration',
            userName: 'نظام الترحيل الآمن',
            tenantId: 'tenant_main',
            branchId: storage.getActiveBranchId(),
            action: 'ترحيل بيانات محلي غير متلف',
            details: `تم دمج ${migratedCount} سجل، وتخطي ${skippedCount} سجل، وحفظ ${conflictCount} تعارض دون الكتابة فوق السجلات الأحدث.`,
          });
        }
      }
    );

    localStorage.setItem(MIGRATION_V5_MARKER, 'true');

    return {
      executed: true,
      migratedCount,
      skippedCount,
      conflictCount,
      backupCreated,
      details,
      timestamp,
    };
  }

  /**
   * التحقق الصارم من هوية الفاعل وصلاحياته وعزل الفرع داخل طبقة الخدمات (SEC-02)
   */
  private requireAuthorizedActor(
    permission: Permission,
    targetBranchId?: string
  ): { actor: SystemUser; tenantId: string; branchId: string } {
    const actor = authService.getCurrentActorSync();
    assertPermission(actor, permission);

    const session = authService.getCurrentSessionSync();
    if (!actor || !session || session.userId !== actor.id || session.role !== actor.role) {
      throw new Error('حظر أمني: لا توجد جلسة موثّقة وصالحة لتنفيذ العملية.');
    }

    const tenantId = actor.tenantId?.trim();
    if (!tenantId || session.tenantId !== tenantId) {
      throw new Error('حظر أمني: معرّف المؤسسة مفقود أو لا يطابق الجلسة.');
    }

    const branchId = targetBranchId?.trim() || storage.getActiveBranchId()?.trim() || actor.branchId?.trim() || '';
    if (!branchId) {
      throw new Error('حظر أمني: لا يوجد فرع محدد للعملية.');
    }
    assertBranchAccess(actor, branchId);
    return { actor, tenantId, branchId };
  }

  private assertCashBoxBranchAccess(
    actor: SystemUser,
    cashBox: CashBox | undefined,
    targetBranchId: string
  ): asserts cashBox is CashBox {
    if (!cashBox) throw new FinancialValidationError('الصندوق المحدد غير موجود.');
    const boxBranchId = cashBox.branchId?.trim();
    if (cashBox.isCentral) {
      assertPermission(actor, 'cashbox:central_access');
      return;
    }
    if (!boxBranchId) throw new FinancialValidationError('الصندوق غير مربوط بفرع؛ يجب تصحيح ربطه قبل استخدامه.');
    assertBranchAccess(actor, boxBranchId);
    if (boxBranchId !== targetBranchId) {
      throw new FinancialValidationError('لا يمكن تنفيذ حركة مالية على صندوق تابع لفرع آخر.');
    }
  }

  private async getValidAccountCodesSet(): Promise<Set<string>> {
    const accounts = await db.accounts.toArray();
    return new Set(accounts.map((a) => a.code));
  }

  private async getAccountsByCodeMap(): Promise<Map<string, Account>> {
    const accounts = await db.accounts.toArray();
    return new Map(accounts.map((a) => [a.code, a]));
  }

  private async ensureCanonicalAccountTx(code: string): Promise<Account | undefined> {
    const existing = await db.accounts.get(code);
    if (existing) return existing;
    const template = INITIAL_CHART_OF_ACCOUNTS.find((a) => a.code === code);
    if (!template) return undefined;
    if (template.parentCode) {
      await this.ensureCanonicalAccountTx(template.parentCode);
    }
    const created: Account = { ...template, balance: 0 };
    await db.accounts.put(created);
    return created;
  }

  private async resolveBranchDefaultCashBoxTx(branchId: string): Promise<CashBox> {
    const boxes = await db.cashBoxes.toArray();
    const branchBoxes = boxes.filter((b) => b.branchId === branchId && !b.isCentral);
    const chosen = branchBoxes.find((b) => b.isDefault) || branchBoxes[0];
    if (!chosen) {
      throw new FinancialValidationError('لا يوجد صندوق نقدي مربوط بالفرع المحدد؛ يرجى إنشاء صندوق للفرع أولاً.');
    }
    return chosen;
  }

  /**
   * توليد رقم تسلسلي ذري مضمون التفرد عبر جدول sequences (FIN-01)
   * يجب استدعاؤها من داخل معاملة Dexie تشمل db.sequences
   */
  private async allocateSequenceNumberAtomic(
    type: 'INV' | 'PUR' | 'RS' | 'RP' | 'RCT' | 'PAY' | 'JV' | 'REV' | 'AMN',
    branchCode: string,
    terminalCode: string,
    tenantId: string
  ): Promise<string> {
    const year = new Date().getFullYear();
    const normalizedBranch = branchCode.trim() || 'BR01';
    const normalizedTerminal = terminalCode.trim() || 'POS01';
    const key = `${tenantId}:${normalizedBranch}:${normalizedTerminal}:${type}:${year}`;

    const existing = await db.sequences.get(key);
    let baseline = existing?.lastSeq || 0;

    // التأكد من عدم التصادم مع أرقام قديمة قبل وجود جدول العدادات
    if (!existing) {
      const fullPrefix = `${type}-${normalizedBranch}-${normalizedTerminal}-${year}-`;
      const legacyPrefix = `${type}-${year}-`;
      if (type === 'JV' || type === 'REV') {
        const jvMatches = await db.journalEntries
          .filter((j) => Boolean(j.entryNumber && (j.entryNumber.startsWith(fullPrefix) || j.entryNumber.startsWith(legacyPrefix))))
          .count();
        baseline = Math.max(baseline, jvMatches);
      } else if (type === 'INV' || type === 'PUR' || type === 'RS' || type === 'RP') {
        const invMatches = await db.invoices
          .filter((i) => Boolean(i.invoiceNumber && i.invoiceNumber.startsWith(fullPrefix)))
          .count();
        baseline = Math.max(baseline, invMatches);
      } else if (type === 'RCT' || type === 'PAY') {
        const vMatches = await db.vouchers
          .filter((v) => Boolean(v.voucherNumber && v.voucherNumber.startsWith(fullPrefix)))
          .count();
        baseline = Math.max(baseline, vMatches);
      } else if (type === 'AMN') {
        const amnMatches = await db.amanatRecords
          .filter((a) => Boolean(a.recordNumber && (a.recordNumber.startsWith(fullPrefix) || a.recordNumber.startsWith(legacyPrefix))))
          .count();
        baseline = Math.max(baseline, amnMatches);
      }
    }

    const nextValue = baseline + 1;
    await db.sequences.put({
      key,
      lastSeq: nextValue,
      updatedAt: new Date().toISOString(),
    });

    const padded = String(nextValue).padStart(5, '0');
    return `${type}-${normalizedBranch}-${normalizedTerminal}-${year}-${padded}`;
  }

  // --- الفروع ونقاط البيع (Multi-Branch System) ---
  public async getBranches(): Promise<Branch[]> {
    await this.ensureReady();
    const { actor } = this.requireAuthorizedActor('branches:view');
    const rows = await db.branches.toArray();
    if (actor.role === 'ADMIN') return rows;
    const allowed = new Set(actor.allowedBranches || []);
    return rows.filter((branch) => allowed.has(branch.id));
  }

  public async getBranch(id: string): Promise<Branch | undefined> {
    await this.ensureReady();
    this.requireAuthorizedActor('branches:view', id);
    return await db.branches.get(id);
  }

  public async getActiveBranch(): Promise<Branch> {
    await this.ensureReady();
    const activeId = storage.getActiveBranchId();
    const branch = await db.branches.get(activeId);
    if (branch) return branch;
    const all = await db.branches.toArray();
    return all[0] || storage.getActiveBranch();
  }

  public async setActiveBranchId(branchId: string): Promise<void> {
    this.requireAuthorizedActor('branches:view', branchId);
    storage.setActiveBranchId(branchId);
  }

  public async addBranch(branch: Branch): Promise<void> {
    await this.ensureReady();
    const { actor, tenantId } = this.requireAuthorizedActor('branches:manage');
    if (!branch.id) branch.id = storage.generateUUID();

    await db.transaction('rw', [db.branches, db.outbox, db.auditLogs], async () => {
      await db.branches.put(branch);
      await syncQueueService.enqueue({
        tenantId,
        branchId: branch.id,
        entityType: 'BRANCH',
        entityId: branch.id,
        action: 'CREATE',
        payload: branch as unknown as Record<string, unknown>,
      });
      await db.auditLogs.put({
        id: storage.generateUUID(),
        timestamp: new Date().toISOString(),
        userId: actor.id,
        userName: actor.fullName,
        tenantId,
        branchId: branch.id,
        action: 'إضافة فرع',
        details: `تمت إضافة الفرع: ${branch.nameAr} (${branch.code})`,
      });
    });
  }

  public async updateBranch(branch: Branch): Promise<void> {
    await this.ensureReady();
    const { actor, tenantId } = this.requireAuthorizedActor('branches:manage', branch.id);
    assertBranchAccess(actor, branch.id);

    await db.transaction('rw', [db.branches, db.outbox, db.auditLogs], async () => {
      await db.branches.put(branch);
      await syncQueueService.enqueue({
        tenantId,
        branchId: branch.id,
        entityType: 'BRANCH',
        entityId: branch.id,
        action: 'UPDATE',
        payload: branch as unknown as Record<string, unknown>,
      });
      await db.auditLogs.put({
        id: storage.generateUUID(),
        timestamp: new Date().toISOString(),
        userId: actor.id,
        userName: actor.fullName,
        tenantId,
        branchId: branch.id,
        action: 'تعديل فرع',
        details: `تم تحديث بيانات الفرع: ${branch.nameAr}`,
      });
    });
  }

  public async generateBranchInvoiceNumber(
    type: 'INV' | 'PUR' | 'RS' | 'RP',
    branchCode?: string,
    terminalCode?: string
  ): Promise<string> {
    await this.ensureReady();
    const permission =
      type === 'INV'
        ? 'pos:sale'
        : type === 'RS'
        ? 'pos:return'
        : type === 'RP'
        ? 'purchase:return'
        : 'purchase:create';
    const { tenantId, branchId } = this.requireAuthorizedActor(permission);
    const activeBranch = await db.branches.get(branchId);
    if (!activeBranch) throw new FinancialValidationError('الفرع المحدد غير موجود.');
    if (branchCode && branchCode !== activeBranch.code) {
      throw new FinancialValidationError('رمز الفرع المطلوب لا يطابق الفرع المصرح به في الجلسة.');
    }
    const bCode = activeBranch.code || 'BR01';
    const tCode = terminalCode || storage.getTerminalCode();

    return await db.transaction('rw', [db.sequences, db.invoices], async () => {
      return await this.allocateSequenceNumberAtomic(type, bCode, tCode, tenantId);
    });
  }

  public async generateBranchVoucherNumber(
    type: 'RCT' | 'PAY',
    branchCode?: string,
    terminalCode?: string
  ): Promise<string> {
    await this.ensureReady();
    const permission = type === 'RCT' ? 'voucher:receipt' : 'voucher:payment';
    const { tenantId, branchId } = this.requireAuthorizedActor(permission);
    const activeBranch = await db.branches.get(branchId);
    if (!activeBranch) throw new FinancialValidationError('الفرع المحدد غير موجود.');
    if (branchCode && branchCode !== activeBranch.code) {
      throw new FinancialValidationError('رمز الفرع المطلوب لا يطابق الفرع المصرح به في الجلسة.');
    }
    const bCode = activeBranch.code || 'BR01';
    const tCode = terminalCode || storage.getTerminalCode();

    return await db.transaction('rw', [db.sequences, db.vouchers], async () => {
      return await this.allocateSequenceNumberAtomic(type, bCode, tCode, tenantId);
    });
  }

  // --- الأنشطة التجارية الأربعة ---
  public async getActivities(): Promise<CommercialActivity[]> {
    await this.ensureReady();
    const list = await db.activities.toArray();
    return list.length > 0 ? list : OFFICIAL_ACTIVITIES;
  }

  public async getCompanyProfile(): Promise<CompanyProfile> {
    return storage.getCompanyProfile();
  }

  public async saveCompanyProfile(profile: CompanyProfile): Promise<CompanyProfile> {
    this.requireAuthorizedActor('settings:manage');
    storage.saveCompanyProfile(profile);
    return storage.getCompanyProfile();
  }

  public async getTerminalCode(): Promise<string> {
    return storage.getTerminalCode();
  }

  public async setTerminalCode(terminalCode: string): Promise<string> {
    this.requireAuthorizedActor('settings:manage');
    storage.setTerminalCode(terminalCode);
    return storage.getTerminalCode();
  }

  // --- الدليل المحاسبي ---
  public async getAccounts(): Promise<Account[]> {
    await this.ensureReady();
    this.requireAuthorizedActor('view:accounting');
    return await db.accounts.toArray();
  }

  public async saveAccounts(accounts: Account[]): Promise<void> {
    await this.ensureReady();
    const { actor, tenantId, branchId } = this.requireAuthorizedActor('account:create');
    await db.transaction('rw', [db.accounts, db.outbox, db.auditLogs], async () => {
      await db.accounts.clear();
      await db.accounts.bulkPut(accounts);
      await db.auditLogs.put({
        id: storage.generateUUID(),
        timestamp: new Date().toISOString(),
        userId: actor.id,
        userName: actor.fullName,
        tenantId,
        branchId,
        action: 'تحديث الدليل المحاسبي',
        details: `حفظ ${accounts.length} حساباً في الدليل المحاسبي`,
      });
    });
  }

  public async createAccountAtomic(account: Account): Promise<Account> {
    await this.ensureReady();
    const { actor, tenantId, branchId } = this.requireAuthorizedActor('account:create');

    return await db.transaction('rw', [db.accounts, db.outbox, db.auditLogs], async () => {
      const existing = await db.accounts.get(account.code);
      if (existing) {
        throw new FinancialValidationError(`رمز الحساب (${account.code}) موجود مسبقاً في الدليل المحاسبي.`);
      }
      const cleanAccount: Account = {
        ...account,
        code: account.code.trim(),
        nameAr: account.nameAr.trim(),
        balance: roundMoney(account.balance || 0),
      };
      await db.accounts.put(cleanAccount);
      await syncQueueService.enqueue({
        tenantId,
        branchId,
        entityType: 'ACCOUNT',
        entityId: cleanAccount.code,
        action: 'CREATE',
        payload: cleanAccount as unknown as Record<string, unknown>,
      });
      await db.auditLogs.put({
        id: storage.generateUUID(),
        timestamp: new Date().toISOString(),
        userId: actor.id,
        userName: actor.fullName,
        tenantId,
        branchId,
        action: 'إضافة حساب محاسبي',
        details: `إضافة الحساب (${cleanAccount.code}) - ${cleanAccount.nameAr}`,
      });
      return cleanAccount;
    });
  }

  public async updateAccountBalance(code: string, deltaBalance: number): Promise<void> {
    await this.ensureReady();
    this.requireAuthorizedActor('journal:post');
    await db.transaction('rw', db.accounts, async () => {
      const acc = await db.accounts.get(code);
      if (acc) {
        acc.balance = roundMoney(acc.balance + deltaBalance);
        await db.accounts.put(acc);
      }
    });
  }

  // --- المخزون والأصناف ---
  public async getProducts(activityId?: CommercialActivityId): Promise<Product[]> {
    await this.ensureReady();
    const { actor } = this.requireAuthorizedActor('inventory:view');
    const rows =
      activityId && activityId !== ('all' as CommercialActivityId)
        ? await db.products.where('activityId').equals(activityId).toArray()
        : await db.products.toArray();
    return filterRecordsByActivityScope(rows, actor);
  }

  public async getProductById(id: string): Promise<Product | undefined> {
    await this.ensureReady();
    const { actor } = this.requireAuthorizedActor('inventory:view');
    const product = await db.products.get(id);
    if (!product) return undefined;
    return filterRecordsByActivityScope([product], actor)[0];
  }

  public async saveProductAtomic(product: Product, isUpdate = false): Promise<Product> {
    await this.ensureReady();
    const { actor, tenantId, branchId } = this.requireAuthorizedActor('inventory:write');
    assertActivityAccess(actor, product.activityId, isUpdate ? 'تعديل صنف' : 'إضافة صنف');

    if (!product.id) product.id = storage.generateUUID();
    if (product.batches && product.batches.length > 0 && product.currentStock === 0) {
      product.currentStock = roundMoney(
        product.batches.reduce((s, b) => s + (Number(b.quantity) || 0), 0),
        4
      );
    }
    product.isActive = product.isActive !== false;
    validateProductStockConsistency(product);

    const activeBranch = (await db.branches.get(branchId)) || (await this.getActiveBranch());
    const terminalCode = storage.getTerminalCode();
    const nowIso = new Date().toISOString();
    const todayDate = nowIso.split('T')[0];

    return await db.transaction(
      'rw',
      [db.products, db.journalEntries, db.accounts, db.branches, db.sequences, db.outbox, db.auditLogs],
      async () => {
        const existing = await db.products.get(product.id);
        if (existing?.activityId) {
          assertActivityAccess(actor, existing.activityId, 'تعديل صنف');
        }
        await db.products.put(product);
        await syncQueueService.enqueue({
          tenantId,
          branchId,
          entityType: 'PRODUCT',
          entityId: product.id,
          action: existing || isUpdate ? 'UPDATE' : 'CREATE',
          payload: product as unknown as Record<string, unknown>,
        });

        if (!existing && !isUpdate) {
          const openingValue = roundMoney(
            product.batches && product.batches.length > 0
              ? product.batches.reduce(
                  (sum, b) => sum + (Number(b.quantity) || 0) * (Number(b.costPrice ?? product.purchasePrice) || 0),
                  0
                )
              : (Number(product.currentStock) || 0) * (Number(product.purchasePrice) || 0)
          );
          if (openingValue > 0) {
            const invCode = ACTIVITY_INVENTORY_ACCOUNTS[product.activityId] || '11041';
            const invAcc = await this.ensureCanonicalAccountTx(invCode);
            const eqAcc = await this.ensureCanonicalAccountTx('3101');
            const entryNumber = await this.allocateSequenceNumberAtomic(
              'JV',
              activeBranch.code || 'BR01',
              terminalCode,
              tenantId
            );
            const openingJv: JournalEntry = {
              id: storage.generateUUID(),
              entryNumber,
              date: todayDate,
              description: `قيد رصيد افتتاحي للمخزون - ${product.nameAr} (${product.code})`,
              costCenterId: product.activityId,
              branchId: activeBranch.id,
              lines: [
                {
                  id: storage.generateUUID(),
                  accountCode: invCode,
                  accountName: invAcc?.nameAr || 'مخزون النشاط',
                  debit: openingValue,
                  credit: 0,
                  costCenterId: product.activityId,
                  memo: `إثبات رصيد افتتاحي: ${product.nameAr}`,
                },
                {
                  id: storage.generateUUID(),
                  accountCode: '3101',
                  accountName: eqAcc?.nameAr || 'رأس المال المخصص',
                  debit: 0,
                  credit: openingValue,
                  costCenterId: 'general',
                  memo: `مقابل رصيد مخزون افتتاحي: ${product.nameAr}`,
                },
              ],
              status: 'POSTED',
              referenceType: 'INVENTORY',
              referenceId: product.id,
              isAutoGenerated: true,
            };
            if (invAcc) {
              invAcc.balance = roundMoney(invAcc.balance + accountBalanceDeltaByType(invAcc.type, openingValue, 0));
              await db.accounts.put(invAcc);
            }
            if (eqAcc) {
              eqAcc.balance = roundMoney(eqAcc.balance + accountBalanceDeltaByType(eqAcc.type, 0, openingValue));
              await db.accounts.put(eqAcc);
            }
            await db.journalEntries.put(openingJv);
            await db.outbox.put({
              id: storage.generateUUID(),
              tenantId,
              branchId: activeBranch.id,
              entityType: 'JOURNAL_ENTRY',
              entityId: openingJv.id,
              action: 'CREATE',
              payload: openingJv as unknown as Record<string, unknown>,
              status: 'PENDING',
              retryCount: 0,
              priority: 4,
              dependsOn: [product.id],
              createdAt: nowIso,
              idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${openingJv.id}_CREATE`,
            });
          }
        }

        await db.auditLogs.put({
          id: storage.generateUUID(),
          timestamp: nowIso,
          userId: actor.id,
          userName: actor.fullName,
          tenantId,
          branchId,
          action: existing || isUpdate ? 'تعديل صنف' : 'إضافة صنف',
          details: `${existing || isUpdate ? 'تحديث' : 'إضافة'} الصنف ${product.nameAr} بكود ${product.code}`,
        });
        return product;
      }
    );
  }

  /**
   * تسوية جردية ذرية تحافظ على تطابق مجموع التشغيلات مع رصيد الصنف الإجمالي وتصدر القيد المحاسبي المقابل (INV-01, INV-07)
   */
  public async adjustProductStockAtomic(params: {
    productId: string;
    deltaQuantity: number;
    reason: string;
    batchNumber?: string;
    expiryDate?: string;
  }): Promise<Product> {
    await this.ensureReady();
    const { actor, tenantId, branchId } = this.requireAuthorizedActor('inventory:adjust');

    const { productId, deltaQuantity, reason, batchNumber, expiryDate } = params;
    if (!Number.isFinite(deltaQuantity) || deltaQuantity === 0) {
      throw new FinancialValidationError('كمية التسوية الجردية يجب أن تكون رقماً غير صفري.');
    }
    if (!reason || !reason.trim()) {
      throw new FinancialValidationError('سبب التسوية الجردية مطلوب رقابياً.');
    }

    const activeBranch = (await db.branches.get(branchId)) || (await this.getActiveBranch());
    const terminalCode = storage.getTerminalCode();
    const nowIso = new Date().toISOString();
    const todayDate = nowIso.split('T')[0];

    return await db.transaction(
      'rw',
      [db.products, db.journalEntries, db.accounts, db.branches, db.sequences, db.outbox, db.auditLogs],
      async () => {
        const product = await db.products.get(productId);
        if (!product) {
          throw new FinancialValidationError(`الصنف ذو المعرف ${productId} غير موجود.`);
        }
        assertActivityAccess(actor, product.activityId, 'تسوية مخزنية');

        const hasBatches = Boolean(product.batches && product.batches.length > 0);
        if (hasBatches) {
          validateProductStockConsistency(product);
        }

        let adjustmentCostRaw = 0;

        if (deltaQuantity < 0) {
          const deduct = Math.abs(deltaQuantity);
          if (product.currentStock < deduct) {
            throw new FinancialValidationError(
              `الرصيد المتاح (${product.currentStock}) أقل من كمية الخصم المطلوبة (${deduct}).`
            );
          }

          if (hasBatches && product.batches) {
            if (batchNumber) {
              const targetBatch = product.batches.find((b) => b.batchNumber === batchNumber);
              if (!targetBatch) {
                throw new FinancialValidationError(`التشغيلة (${batchNumber}) غير موجودة.`);
              }
              if (targetBatch.quantity < deduct) {
                throw new FinancialValidationError(
                  `الكمية المتاحة في التشغيلة (${batchNumber}) هي ${targetBatch.quantity} فقط.`
                );
              }
              targetBatch.quantity = roundMoney(targetBatch.quantity - deduct, 4);
              adjustmentCostRaw = deduct * (Number(targetBatch.costPrice ?? product.purchasePrice) || 0);
            } else {
              const totalAvailableInBatches = product.batches.reduce((s, b) => s + b.quantity, 0);
              if (totalAvailableInBatches + 0.0001 < deduct) {
                throw new FinancialValidationError(
                  `مجموع كميات التشغيلات (${totalAvailableInBatches}) غير كافٍ للخصم (${deduct}).`
                );
              }
              let remaining = deduct;
              const sorted = [...product.batches]
                .filter((b) => b.quantity > 0)
                .sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());
              for (const b of sorted) {
                if (remaining <= 0) break;
                const take = Math.min(b.quantity, remaining);
                b.quantity = roundMoney(b.quantity - take, 4);
                remaining = roundMoney(remaining - take, 4);
                adjustmentCostRaw += take * (Number(b.costPrice ?? product.purchasePrice) || 0);
              }
              if (remaining > 0.0001) {
                throw new FinancialValidationError('تعذر استيفاء كمية الخصم بالكامل من التشغيلات.');
              }
            }
            product.currentStock = roundMoney(
              product.batches.reduce((s, b) => s + b.quantity, 0),
              4
            );
          } else {
            product.currentStock = roundMoney(product.currentStock - deduct, 4);
            adjustmentCostRaw = deduct * (Number(product.purchasePrice) || 0);
          }
        } else {
          if (product.trackExpiry || hasBatches) {
            if (!batchNumber?.trim() || !expiryDate?.trim()) {
              throw new FinancialValidationError(
                'الأصناف المتتبعة بالتشغيلات تتطلب تحديد رقم تشغيلة وتاريخ صلاحية عند الزيادة الجردية.'
              );
            }
            if (!product.batches) product.batches = [];
            const existingBatch = product.batches.find((b) => b.batchNumber === batchNumber.trim());
            if (existingBatch) {
              existingBatch.quantity = roundMoney(existingBatch.quantity + deltaQuantity, 4);
              adjustmentCostRaw = deltaQuantity * (Number(existingBatch.costPrice ?? product.purchasePrice) || 0);
            } else {
              product.batches.push({
                id: storage.generateUUID(),
                productId: product.id,
                batchNumber: batchNumber.trim(),
                expiryDate: expiryDate.trim(),
                quantity: deltaQuantity,
                costPrice: product.purchasePrice,
              });
              adjustmentCostRaw = deltaQuantity * (Number(product.purchasePrice) || 0);
            }
            product.currentStock = roundMoney(
              product.batches.reduce((s, b) => s + b.quantity, 0),
              4
            );
          } else {
            product.currentStock = roundMoney(product.currentStock + deltaQuantity, 4);
            adjustmentCostRaw = deltaQuantity * (Number(product.purchasePrice) || 0);
          }
        }

        validateProductStockConsistency(product);
        await db.products.put(product);
        await syncQueueService.enqueue({
          tenantId,
          branchId,
          entityType: 'PRODUCT',
          entityId: product.id,
          action: 'UPDATE',
          payload: product as unknown as Record<string, unknown>,
        });

        const adjustmentValue = roundMoney(adjustmentCostRaw);
        if (adjustmentValue > 0) {
          const invCode = ACTIVITY_INVENTORY_ACCOUNTS[product.activityId] || '11041';
          const invAcc = await this.ensureCanonicalAccountTx(invCode);
          const adjExpAcc = await this.ensureCanonicalAccountTx('5205');
          const entryNumber = await this.allocateSequenceNumberAtomic(
            'JV',
            activeBranch.code || 'BR01',
            terminalCode,
            tenantId
          );
          const isShortage = deltaQuantity < 0;
          const adjLines: JournalEntryLine[] = isShortage
            ? [
                {
                  id: storage.generateUUID(),
                  accountCode: '5205',
                  accountName: adjExpAcc?.nameAr || 'فروقات وتسويات وتلف المخزون',
                  debit: adjustmentValue,
                  credit: 0,
                  costCenterId: product.activityId,
                  memo: `عجز/تلف تسوية مخزنية: ${product.nameAr} - ${reason}`,
                },
                {
                  id: storage.generateUUID(),
                  accountCode: invCode,
                  accountName: invAcc?.nameAr || 'مخزون النشاط',
                  debit: 0,
                  credit: adjustmentValue,
                  costCenterId: product.activityId,
                  memo: `تخفيض مخزون بالتسوية: ${product.nameAr}`,
                },
              ]
            : [
                {
                  id: storage.generateUUID(),
                  accountCode: invCode,
                  accountName: invAcc?.nameAr || 'مخزون النشاط',
                  debit: adjustmentValue,
                  credit: 0,
                  costCenterId: product.activityId,
                  memo: `زيادة جردية للمخزون: ${product.nameAr} - ${reason}`,
                },
                {
                  id: storage.generateUUID(),
                  accountCode: '5205',
                  accountName: adjExpAcc?.nameAr || 'فروقات وتسويات وتلف المخزون',
                  debit: 0,
                  credit: adjustmentValue,
                  costCenterId: product.activityId,
                  memo: `فائض تسوية جردية: ${product.nameAr}`,
                },
              ];

          const adjJv: JournalEntry = {
            id: storage.generateUUID(),
            entryNumber,
            date: todayDate,
            description: `قيد تسوية مخزنية (${isShortage ? 'نقص/تلف' : 'زيادة جردية'}) - ${product.nameAr}: ${reason}`,
            costCenterId: product.activityId,
            branchId: activeBranch.id,
            lines: adjLines,
            status: 'POSTED',
            referenceType: 'INVENTORY',
            referenceId: product.id,
            isAutoGenerated: true,
          };

          for (const line of adjLines) {
            const acc = await db.accounts.get(line.accountCode);
            if (acc) {
              acc.balance = roundMoney(acc.balance + accountBalanceDeltaByType(acc.type, line.debit, line.credit));
              await db.accounts.put(acc);
            }
          }
          await db.journalEntries.put(adjJv);
          await db.outbox.put({
            id: storage.generateUUID(),
            tenantId,
            branchId: activeBranch.id,
            entityType: 'JOURNAL_ENTRY',
            entityId: adjJv.id,
            action: 'CREATE',
            payload: adjJv as unknown as Record<string, unknown>,
            status: 'PENDING',
            retryCount: 0,
            priority: 4,
            dependsOn: [product.id],
            createdAt: nowIso,
            idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${adjJv.id}_CREATE`,
          });
        }

        await db.auditLogs.put({
          id: storage.generateUUID(),
          timestamp: nowIso,
          userId: actor.id,
          userName: actor.fullName,
          tenantId,
          branchId,
          action: 'تسوية مخزنية ذرية',
          details: `صنف ${product.nameAr}: تعديل (${deltaQuantity > 0 ? '+' : ''}${deltaQuantity})، السبب: ${reason}`,
        });
        return product;
      }
    );
  }

  public async addProduct(product: Product): Promise<void> {
    await this.saveProductAtomic(product, false);
  }

  public async updateProduct(product: Product): Promise<void> {
    await this.saveProductAtomic(product, true);
  }

  public async deleteProductAtomic(productId: string): Promise<void> {
    await this.ensureReady();
    const { actor, tenantId, branchId } = this.requireAuthorizedActor('inventory:delete');
    const activeBranch = (await db.branches.get(branchId)) || (await this.getActiveBranch());
    const terminalCode = storage.getTerminalCode();
    const nowIso = new Date().toISOString();

    await db.transaction(
      'rw',
      [db.products, db.productImages, db.invoices, db.journalEntries, db.accounts, db.branches, db.sequences, db.outbox, db.auditLogs],
      async () => {
        const existing = await db.products.get(productId);
        if (!existing) return;
        assertActivityAccess(actor, existing.activityId, 'حذف صنف');

        const linkedImages = await db.productImages
          .where('[tenantId+productId]')
          .equals([tenantId, productId])
          .count();
        if (linkedImages > 0) {
          throw new FinancialValidationError('لا يمكن حذف الصنف حتى تكتمل مزامنة حذف جميع صوره؛ تحقق من اتصال الإنترنت وحالة المزامنة.');
        }

        const invoices = await db.invoices.toArray();
        const usedInInvoices = invoices.some(
          (inv) =>
            (inv.items || []).some((item) => item.productId === productId) ||
            (inv.stockDeductionsRecorded || []).some((ded) => ded.productId === productId)
        );
        if (usedInInvoices) {
          throw new FinancialValidationError(
            'لا يمكن حذف صنف مرتبط بفواتير مرحلة حفاظاً على سلامة السجل المالي.'
          );
        }

        const remainingValue = roundMoney(
          existing.batches && existing.batches.length > 0
            ? existing.batches.reduce(
                (sum, b) => sum + (Number(b.quantity) || 0) * (Number(b.costPrice ?? existing.purchasePrice) || 0),
                0
              )
            : (Number(existing.currentStock) || 0) * (Number(existing.purchasePrice) || 0)
        );
        const hasInvJv =
          (await db.journalEntries
            .filter((j) => j.referenceType === 'INVENTORY' && j.referenceId === productId)
            .count()) > 0;

        if (remainingValue > 0 && hasInvJv) {
          const invCode = ACTIVITY_INVENTORY_ACCOUNTS[existing.activityId] || '11041';
          const invAcc = await this.ensureCanonicalAccountTx(invCode);
          const eqAcc = await this.ensureCanonicalAccountTx('3101');
          const entryNumber = await this.allocateSequenceNumberAtomic(
            'REV',
            activeBranch.code || 'BR01',
            terminalCode,
            tenantId
          );
          const delJv: JournalEntry = {
            id: storage.generateUUID(),
            entryNumber,
            date: nowIso.split('T')[0],
            description: `إلغاء أثر رصيد مخزون محذوف - ${existing.nameAr} (${existing.code})`,
            costCenterId: existing.activityId,
            branchId: activeBranch.id,
            lines: [
              {
                id: storage.generateUUID(),
                accountCode: '3101',
                accountName: eqAcc?.nameAr || 'رأس المال المخصص',
                debit: remainingValue,
                credit: 0,
                costCenterId: 'general',
                memo: `إلغاء رصيد صنف محذوف: ${existing.nameAr}`,
              },
              {
                id: storage.generateUUID(),
                accountCode: invCode,
                accountName: invAcc?.nameAr || 'مخزون النشاط',
                debit: 0,
                credit: remainingValue,
                costCenterId: existing.activityId,
                memo: `تخفيض مخزون صنف محذوف: ${existing.nameAr}`,
              },
            ],
            status: 'POSTED',
            referenceType: 'INVENTORY',
            referenceId: productId,
            isAutoGenerated: true,
          };
          for (const line of delJv.lines) {
            const acc = await db.accounts.get(line.accountCode);
            if (acc) {
              acc.balance = roundMoney(acc.balance + accountBalanceDeltaByType(acc.type, line.debit, line.credit));
              await db.accounts.put(acc);
            }
          }
          await db.journalEntries.put(delJv);
          await db.outbox.put({
            id: storage.generateUUID(),
            tenantId,
            branchId: activeBranch.id,
            entityType: 'JOURNAL_ENTRY',
            entityId: delJv.id,
            action: 'CREATE',
            payload: delJv as unknown as Record<string, unknown>,
            status: 'PENDING',
            retryCount: 0,
            priority: 4,
            createdAt: nowIso,
            idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${delJv.id}_CREATE`,
          });
        }

        await db.products.delete(productId);
        await syncQueueService.enqueue({
          tenantId,
          branchId,
          entityType: 'PRODUCT',
          entityId: productId,
          action: 'DELETE',
          payload: { id: productId },
        });
        await db.auditLogs.put({
          id: storage.generateUUID(),
          timestamp: nowIso,
          userId: actor.id,
          userName: actor.fullName,
          tenantId,
          branchId,
          action: 'حذف صنف',
          details: `تم حذف الصنف ${existing.nameAr} (${productId})`,
        });
      }
    );
  }

  public async deleteProduct(productId: string): Promise<void> {
    await this.deleteProductAtomic(productId);
  }

  // --- العملاء والموردون ---
  public async getParties(type?: 'CUSTOMER' | 'SUPPLIER'): Promise<Party[]> {
    await this.ensureReady();
    this.requireAuthorizedActor('party:view');
    if (type) {
      return await db.parties.where('type').equals(type).toArray();
    }
    return await db.parties.toArray();
  }

  public async getPartyById(id: string): Promise<Party | undefined> {
    await this.ensureReady();
    this.requireAuthorizedActor('party:view');
    return await db.parties.get(id);
  }

  public async savePartyAtomic(party: Party, isUpdate = false): Promise<Party> {
    await this.ensureReady();
    const requiredPermission: Permission = isUpdate ? 'party:write' : 'party:create';
    const { actor, tenantId, branchId } = this.requireAuthorizedActor(requiredPermission);

    if (!party.id) party.id = storage.generateUUID();
    if (!party.nameAr || !party.nameAr.trim()) {
      throw new FinancialValidationError('اسم العميل أو المورد مطلوب.');
    }

    return await db.transaction('rw', [db.parties, db.outbox, db.auditLogs], async () => {
      const existing = await db.parties.get(party.id);
      if (existing && !isUpdate) {
        throw new FinancialValidationError('لا يمكن لصلاحية الإضافة فقط تعديل عميل مسجل مسبقاً.');
      }
      const persistedParty: Party = {
        ...party,
        nameAr: party.nameAr.trim(),
        phone: String(party.phone || '').trim(),
        balance: existing ? existing.balance : roundMoney(party.balance || 0),
        advanceBalance: existing
          ? roundMoney(existing.advanceBalance || 0)
          : Math.max(0, roundMoney(party.advanceBalance || 0)),
      };
      await db.parties.put(persistedParty);
      await syncQueueService.enqueue({
        tenantId,
        branchId,
        entityType: 'PARTY',
        entityId: persistedParty.id,
        action: existing || isUpdate ? 'UPDATE' : 'CREATE',
        payload: persistedParty as unknown as Record<string, unknown>,
      });
      await db.auditLogs.put({
        id: storage.generateUUID(),
        timestamp: new Date().toISOString(),
        userId: actor.id,
        userName: actor.fullName,
        tenantId,
        branchId,
        action: `${existing || isUpdate ? 'تعديل' : 'إضافة'} ${persistedParty.type === 'CUSTOMER' ? 'عميل' : 'مورد'}`,
        details: `الطرف: ${persistedParty.nameAr}`,
      });
      return persistedParty;
    });
  }

  public async addParty(party: Party): Promise<void> {
    await this.savePartyAtomic(party, false);
  }

  public async updateParty(party: Party): Promise<void> {
    await this.savePartyAtomic(party, true);
  }

  public async updatePartyBalance(partyId: string, deltaBalance: number): Promise<void> {
    await this.ensureReady();
    this.requireAuthorizedActor('party:write');
    await db.transaction('rw', db.parties, async () => {
      const party = await db.parties.get(partyId);
      if (party) {
        party.balance = roundMoney(party.balance + deltaBalance);
        await db.parties.put(party);
      }
    });
  }

  // --- الفواتير ---
  public async getInvoices(activityId?: CommercialActivityId): Promise<Invoice[]> {
    await this.ensureReady();
    const { actor } = this.requireAuthorizedActor('invoices:view');
    const rows =
      activityId && activityId !== ('all' as CommercialActivityId)
        ? await db.invoices.where('activityId').equals(activityId).reverse().sortBy('date')
        : await db.invoices.toCollection().reverse().sortBy('date');
    return filterRecordsByActivityScope(filterRecordsByBranchScope(rows, actor), actor);
  }

  public async getInvoiceById(id: string): Promise<Invoice | undefined> {
    await this.ensureReady();
    const { actor } = this.requireAuthorizedActor('invoices:view');
    const invoice = await db.invoices.get(id);
    if (!invoice) return undefined;
    return filterRecordsByActivityScope(filterRecordsByBranchScope([invoice], actor), actor)[0];
  }

  public async addInvoice(invoice: Invoice): Promise<void> {
    await this.ensureReady();
    const { actor, tenantId, branchId } = this.requireAuthorizedActor('pos:sale', invoice.branchId);
    assertActivityAccess(actor, invoice.activityId, 'إصدار فاتورة');
    if (!invoice.id) invoice.id = storage.generateUUID();
    invoice.isPosted = true;

    await db.transaction('rw', [db.invoices, db.outbox, db.auditLogs], async () => {
      await db.invoices.put(invoice);
      await syncQueueService.enqueue({
        tenantId,
        branchId,
        entityType: 'INVOICE',
        entityId: invoice.id,
        action: 'CREATE',
        payload: invoice as unknown as Record<string, unknown>,
      });
      await db.auditLogs.put({
        id: storage.generateUUID(),
        timestamp: new Date().toISOString(),
        userId: actor.id,
        userName: actor.fullName,
        tenantId,
        branchId,
        action: `فاتورة ${invoice.type}`,
        details: `إصدار فاتورة رقم ${invoice.invoiceNumber} بقيمة ${invoice.total}`,
      });
    });
  }

  // --- القيود المحاسبية ---
  public async getJournalEntries(costCenterId?: CostCenterId): Promise<JournalEntry[]> {
    await this.ensureReady();
    const { actor } = this.requireAuthorizedActor('view:accounting');
    const rows = costCenterId
      ? await db.journalEntries.where('costCenterId').equals(costCenterId).reverse().sortBy('date')
      : await db.journalEntries.toCollection().reverse().sortBy('date');
    return filterRecordsByBranchScope(rows, actor);
  }

  public async getJournalEntryById(id: string): Promise<JournalEntry | undefined> {
    await this.ensureReady();
    const { actor } = this.requireAuthorizedActor('view:accounting');
    const entry = await db.journalEntries.get(id);
    if (!entry) return undefined;
    return filterRecordsByBranchScope([entry], actor)[0];
  }

  public async addJournalEntry(entry: JournalEntry): Promise<void> {
    await this.createJournalEntryAtomic(entry);
  }

  public async reverseJournalEntry(originalEntryId: string, reversalReason: string): Promise<JournalEntry> {
    return await this.reverseJournalEntryAtomic(originalEntryId, reversalReason);
  }

  // --- الصناديق والبنوك ---
  public async getCashBoxes(): Promise<CashBox[]> {
    await this.ensureReady();
    const { actor } = this.requireAuthorizedActor('cashbox:view');
    return filterRecordsByBranchScope(await db.cashBoxes.toArray(), actor);
  }

  public async createCashBoxAtomic(box: CashBox): Promise<CashBox> {
    await this.ensureReady();
    const { actor, tenantId, branchId } = this.requireAuthorizedActor('cashbox:create', box.branchId);
    if (!box.id) box.id = storage.generateUUID();
    if (!box.code?.trim() || !box.nameAr?.trim()) {
      throw new FinancialValidationError('رمز الصندوق واسمه مطلوبان.');
    }

    return await db.transaction('rw', [db.cashBoxes, db.accounts, db.outbox, db.auditLogs], async () => {
      const account = await db.accounts.get(box.accountCode);
      if (!account) {
        throw new FinancialValidationError(`الحساب المرتبط (${box.accountCode}) غير موجود في الدليل المحاسبي.`);
      }
      if (account.isLeaf === false) {
        throw new FinancialValidationError(`لا يجوز ربط الصندوق بالحساب التجميعي (${box.accountCode}).`);
      }
      const cleanBox: CashBox = {
        ...box,
        branchId: box.branchId || branchId,
        balance: roundMoney(box.balance || 0),
      };
      await db.cashBoxes.put(cleanBox);
      await syncQueueService.enqueue({
        tenantId,
        branchId: cleanBox.branchId,
        entityType: 'CASHBOX',
        entityId: cleanBox.id,
        action: 'CREATE',
        payload: cleanBox as unknown as Record<string, unknown>,
      });
      await db.auditLogs.put({
        id: storage.generateUUID(),
        timestamp: new Date().toISOString(),
        userId: actor.id,
        userName: actor.fullName,
        tenantId,
        branchId: cleanBox.branchId,
        action: 'إنشاء صندوق/حساب بنكي',
        details: `إنشاء ${cleanBox.nameAr} (${cleanBox.code})`,
      });
      return cleanBox;
    });
  }

  public async updateCashBoxBalance(id: string, deltaBalance: number): Promise<void> {
    await this.ensureReady();
    const { actor, branchId } = this.requireAuthorizedActor('journal:post');
    await db.transaction('rw', db.cashBoxes, async () => {
      const box = await db.cashBoxes.get(id);
      this.assertCashBoxBranchAccess(actor, box, branchId);
      if (box) {
        const nextBalance = roundMoney(box.balance + deltaBalance);
        if (nextBalance < 0) {
          throw new FinancialValidationError(`لا يجوز أن يصبح رصيد الصندوق (${box.nameAr}) سالباً.`);
        }
        box.balance = nextBalance;
        await db.cashBoxes.put(box);
      }
    });
  }

  // --- السندات الذرية (FIN-02) ودورة السداد المعتمدة ---
  public async getVouchers(): Promise<PaymentVoucher[]> {
    await this.ensureReady();
    const { actor } = this.requireAuthorizedActor('vouchers:view');
    return filterRecordsByBranchScope(await db.vouchers.toCollection().reverse().sortBy('date'), actor);
  }

  public async getPaymentAllocations(partyId?: string, voucherId?: string): Promise<PaymentAllocation[]> {
    await this.ensureReady();
    const { actor } = this.requireAuthorizedActor('vouchers:view');
    let rows: PaymentAllocation[];
    if (voucherId) {
      rows = await db.paymentAllocations.where('voucherId').equals(voucherId).toArray();
    } else if (partyId) {
      rows = await db.paymentAllocations.where('partyId').equals(partyId).toArray();
    } else {
      rows = await db.paymentAllocations.toArray();
    }
    if (partyId && voucherId) {
      rows = rows.filter((r) => r.partyId === partyId);
    }
    return filterRecordsByBranchScope(rows, actor).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  public async getPartyAdvanceTransactions(partyId?: string): Promise<PartyAdvanceTransaction[]> {
    await this.ensureReady();
    const { actor } = this.requireAuthorizedActor('party:view');
    const rows = partyId
      ? await db.partyAdvanceTransactions.where('partyId').equals(partyId).toArray()
      : await db.partyAdvanceTransactions.toArray();
    return filterRecordsByBranchScope(rows, actor).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  public async getAllocationAudits(voucherId?: string): Promise<AllocationAudit[]> {
    await this.ensureReady();
    const { actor } = this.requireAuthorizedActor('audit:allocation:view');
    const rows = voucherId
      ? await db.allocationAudits.where('voucherId').equals(voucherId).toArray()
      : await db.allocationAudits.toArray();
    return filterRecordsByBranchScope(rows, actor).sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  }

  private async postVoucherCoreTx(params: {
    voucher: PaymentVoucher;
    actor: SystemUser;
    tenantId: string;
    branchId: string;
    activeBranch: Branch;
    terminalCode: string;
    currencySymbol: string;
    manualAllocations?: VoucherManualAllocationInput[];
    overrideReason?: string;
    isPromotingDraft?: boolean;
  }): Promise<{
    success: boolean;
    voucher: PaymentVoucher;
    journalEntry: JournalEntry;
    allocations: PaymentAllocation[];
    advanceTransaction?: PartyAdvanceTransaction;
  }> {
    const {
      voucher,
      actor,
      tenantId,
      branchId,
      activeBranch,
      terminalCode,
      currencySymbol,
      manualAllocations,
      overrideReason,
      isPromotingDraft = false,
    } = params;

    const nowIso = new Date().toISOString();
    const cashBox = await db.cashBoxes.get(voucher.cashBoxId);
    this.assertCashBoxBranchAccess(actor, cashBox, branchId);

    const amount = roundMoney(voucher.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new FinancialValidationError('مبلغ السند المالي يجب أن يكون رقماً موجباً أكبر من الصفر.');
    }
    if (!voucher.description || !voucher.description.trim()) {
      throw new FinancialValidationError('وصف السند وسبب الحركة مطلوب محاسبياً.');
    }

    let party: Party | undefined;
    if (voucher.partyId) {
      party = await db.parties.get(voucher.partyId);
      if (!party) {
        throw new FinancialValidationError('العميل أو المورد المحدد غير موجود في قاعدة البيانات.');
      }
      if (voucher.voucherMode === 'CUSTOMER_RECEIPT' && (voucher.type !== 'RECEIPT' || party.type !== 'CUSTOMER')) {
        throw new FinancialValidationError('وضع تحصيل العميل يقتصر على سند قبض مرتبط بسجل عميل.');
      }
      if (voucher.voucherMode === 'SUPPLIER_PAYMENT' && (voucher.type !== 'PAYMENT' || party.type !== 'SUPPLIER')) {
        throw new FinancialValidationError('وضع سداد المورد يقتصر على سند صرف مرتبط بسجل مورد.');
      }
    } else if (voucher.voucherMode === 'CUSTOMER_RECEIPT' || voucher.voucherMode === 'SUPPLIER_PAYMENT') {
      throw new FinancialValidationError('يجب اختيار سجل عميل أو مورد حقيقي لتنفيذ تسوية الذمم.');
    }

    const partyInvoices = party
      ? filterRecordsByBranchScope(
          await db.invoices.where('partyId').equals(party.id).toArray(),
          actor
        )
      : [];

    const requestedAcc = voucher.accountCode ? await db.accounts.get(voucher.accountCode) : undefined;
    if (!party && !requestedAcc) {
      throw new FinancialValidationError(
        `الحساب المقابل (${voucher.accountCode || '-'}) غير موجود في الدليل المحاسبي.`
      );
    }

    let plan;
    try {
      plan = resolveVoucherAccountingPlan({
        voucherType: voucher.type,
        voucherMode: voucher.voucherMode,
        party,
        requestedAccountCode: voucher.accountCode,
        amount,
        openInvoices: partyInvoices,
        manualAllocations,
        hasOverridePermission: hasPermission(actor, 'payment:allocation:override'),
        overrideReason,
        hasSupplierAdvancePermission: hasPermission(actor, 'supplier:advance:approve'),
        targetAccountIsLeaf: requestedAcc ? requestedAcc.isLeaf !== false : false,
      });
    } catch (err) {
      throw new FinancialValidationError(err instanceof Error ? err.message : 'تعذر اعتماد خطة السند المالي.');
    }

    if (voucher.type === 'PAYMENT' && roundMoney(cashBox!.balance) + 0.001 < amount) {
      throw new FinancialValidationError(
        `رصيد الصندوق (${cashBox!.nameAr}: ${roundMoney(cashBox!.balance)}) غير كافٍ لصرف مبلغ ${amount}.`
      );
    }

    if (!voucher.voucherNumber || !voucher.voucherNumber.trim()) {
      voucher.voucherNumber = await this.allocateSequenceNumberAtomic(
        voucher.type === 'RECEIPT' ? 'RCT' : 'PAY',
        activeBranch.code || 'BR01',
        terminalCode,
        tenantId
      );
    }

    const voucherDate = voucher.date || nowIso.split('T')[0];
    const cashBoxAccount = cashBox!.accountCode;
    const cashBoxAccountRow = await db.accounts.get(cashBoxAccount);
    if (!cashBoxAccountRow) {
      throw new FinancialValidationError(`حساب الصندوق (${cashBoxAccount}) غير موجود في الدليل المحاسبي.`);
    }

    await this.ensureCanonicalAccountTx(SPECIAL_ACCOUNTS.CUSTOMER_ADVANCES);
    await this.ensureCanonicalAccountTx(SPECIAL_ACCOUNTS.SUPPLIER_ADVANCES);

    const lines: JournalEntryLine[] = [];
    if (voucher.type === 'RECEIPT') {
      lines.push({
        id: storage.generateUUID(),
        accountCode: cashBoxAccount,
        accountName: cashBoxAccountRow.nameAr || cashBox!.nameAr,
        debit: amount,
        credit: 0,
        costCenterId: voucher.costCenterId || 'general',
        memo: `سند قبض ${voucher.voucherNumber} - ${voucher.description}`,
      });
      for (const cLine of plan.creditLines) {
        const acc = await this.ensureCanonicalAccountTx(cLine.accountCode);
        if (!acc) {
          throw new FinancialValidationError(`الحساب المحاسبي (${cLine.accountCode}) غير معرف في الدليل المحاسبي.`);
        }
        lines.push({
          id: storage.generateUUID(),
          accountCode: cLine.accountCode,
          accountName: acc.nameAr,
          debit: 0,
          credit: cLine.amount,
          costCenterId: voucher.costCenterId || 'general',
          memo:
            cLine.accountCode === SPECIAL_ACCOUNTS.CUSTOMER_ADVANCES
              ? `دفعة مقدمة من العميل - سند ${voucher.voucherNumber}`
              : voucher.description,
        });
      }
    } else {
      for (const dLine of plan.debitLines) {
        const acc = await this.ensureCanonicalAccountTx(dLine.accountCode);
        if (!acc) {
          throw new FinancialValidationError(`الحساب المحاسبي (${dLine.accountCode}) غير معرف في الدليل المحاسبي.`);
        }
        lines.push({
          id: storage.generateUUID(),
          accountCode: dLine.accountCode,
          accountName: acc.nameAr,
          debit: dLine.amount,
          credit: 0,
          costCenterId: voucher.costCenterId || 'general',
          memo:
            dLine.accountCode === SPECIAL_ACCOUNTS.SUPPLIER_ADVANCES
              ? `دفعة مقدمة / سلفة مورد - سند ${voucher.voucherNumber}`
              : voucher.description,
        });
      }
      lines.push({
        id: storage.generateUUID(),
        accountCode: cashBoxAccount,
        accountName: cashBoxAccountRow.nameAr || cashBox!.nameAr,
        debit: 0,
        credit: amount,
        costCenterId: voucher.costCenterId || 'general',
        memo: `سند صرف ${voucher.voucherNumber} - ${voucher.description}`,
      });
    }

    const entryNumber = await this.allocateSequenceNumberAtomic(
      'JV',
      activeBranch.code || 'BR01',
      terminalCode,
      tenantId
    );
    const journalEntryId = storage.generateUUID();
    const journalEntry: JournalEntry = {
      id: journalEntryId,
      entryNumber,
      date: voucherDate,
      description: `${voucher.type === 'RECEIPT' ? 'سند قبض' : 'سند صرف'} ${voucher.voucherNumber}: ${party?.nameAr || voucher.partyName || ''} - ${voucher.description}`,
      costCenterId: voucher.costCenterId || 'general',
      branchId,
      lines,
      status: 'POSTED',
      referenceType: 'VOUCHER',
      referenceId: voucher.id,
      isAutoGenerated: true,
    };

    const accountsByCode = await this.getAccountsByCodeMap();
    validateJournalEntryInput({ entry: journalEntry, accountsByCode });

    // 1) تحديث الصندوق وأرصدة الحسابات حسب طبيعة الحساب
    const cashDelta = voucher.type === 'RECEIPT' ? amount : -amount;
    cashBox!.balance = roundMoney(cashBox!.balance + cashDelta);
    await db.cashBoxes.put(cashBox!);

    for (const line of journalEntry.lines) {
      const acc = await db.accounts.get(line.accountCode);
      if (acc) {
        acc.balance = roundMoney(acc.balance + accountBalanceDeltaByType(acc.type, line.debit, line.credit));
        await db.accounts.put(acc);
      }
    }

    // 2) تحديث الفواتير وإنشاء سجلات التخصيص
    const createdAllocations: PaymentAllocation[] = [];
    for (const alloc of plan.allocations) {
      const inv = await db.invoices.get(alloc.invoiceId);
      if (!inv) {
        throw new FinancialValidationError(`الفاتورة (${alloc.invoiceId}) غير موجودة أثناء التخصيص.`);
      }
      const nextPaid = fromCents(toCents(inv.paidAmount) + toCents(alloc.allocatedAmount));
      if (toCents(nextPaid) + toCents(inv.returnedAmount || 0) > toCents(inv.total)) {
        throw new FinancialValidationError(`تجاوز التخصيص صافي المتبقي من الفاتورة (${inv.invoiceNumber}) بعد المرتجعات.`);
      }
      inv.paidAmount = nextPaid;
      await db.invoices.put(inv);

      const allocRow: PaymentAllocation = {
        id: storage.generateUUID(),
        tenantId,
        branchId,
        voucherId: voucher.id,
        partyId: party!.id,
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        invoiceDate: inv.date,
        allocatedAmount: alloc.allocatedAmount,
        allocationMethod: plan.manualOverride ? 'MANUAL' : 'FIFO',
        status: 'ACTIVE',
        createdAt: nowIso,
        createdBy: actor.id,
      };
      createdAllocations.push(allocRow);
      await db.paymentAllocations.put(allocRow);

      await db.outbox.put({
        id: storage.generateUUID(),
        tenantId,
        branchId,
        entityType: 'PAYMENT_ALLOCATION',
        entityId: allocRow.id,
        action: 'CREATE',
        payload: allocRow as unknown as Record<string, unknown>,
        status: 'PENDING',
        retryCount: 0,
        priority: 4,
        dependsOn: [voucher.id, inv.id],
        createdAt: nowIso,
        idempotencyKey: `${tenantId}_PAYMENT_ALLOCATION_${allocRow.id}_CREATE`,
      });
    }

    // 3) سجل تدقيق التعديل اليدوي إن وجد
    if (plan.manualOverride && party) {
      const auditRow: AllocationAudit = {
        id: storage.generateUUID(),
        tenantId,
        branchId,
        voucherId: voucher.id,
        partyId: party.id,
        userId: actor.id,
        userName: actor.fullName,
        reason: plan.overrideReason || '',
        previousAllocations: plan.previousFifoAllocations.map((a) => ({
          invoiceId: a.invoiceId,
          invoiceNumber: a.invoiceNumber,
          allocatedAmount: a.allocatedAmount,
        })),
        newAllocations: plan.allocations.map((a) => ({
          invoiceId: a.invoiceId,
          invoiceNumber: a.invoiceNumber,
          allocatedAmount: a.allocatedAmount,
        })),
        timestamp: nowIso,
      };
      await db.allocationAudits.put(auditRow);
      await db.outbox.put({
        id: storage.generateUUID(),
        tenantId,
        branchId,
        entityType: 'ALLOCATION_AUDIT',
        entityId: auditRow.id,
        action: 'CREATE',
        payload: auditRow as unknown as Record<string, unknown>,
        status: 'PENDING',
        retryCount: 0,
        priority: 4,
        dependsOn: [voucher.id],
        createdAt: nowIso,
        idempotencyKey: `${tenantId}_ALLOCATION_AUDIT_${auditRow.id}_CREATE`,
      });
    }

    // 4) حركة الرصيد المقدم (2103 / 1105) وتحديث رصيد الطرف
    let createdAdvanceTx: PartyAdvanceTransaction | undefined;
    if (party) {
      const nextAdvanceBalance = roundMoney((party.advanceBalance || 0) + plan.partyAdvanceDelta);
      if (nextAdvanceBalance < 0) {
        throw new FinancialValidationError('لا يجوز أن يصبح الرصيد المقدم للطرف سالباً.');
      }

      if (plan.advanceDirection !== 'NONE' && plan.advanceAmount > 0) {
        const txType: PartyAdvanceTransaction['type'] =
          plan.advanceDirection === 'DEPOSIT_CUSTOMER'
            ? 'OVERPAYMENT_DEPOSIT'
            : plan.advanceDirection === 'DEPOSIT_SUPPLIER'
            ? 'PREPAYMENT_DEPOSIT'
            : 'REFUND';
        const signedAmt =
          plan.advanceDirection === 'REFUND_CUSTOMER' || plan.advanceDirection === 'REFUND_SUPPLIER'
            ? -plan.advanceAmount
            : plan.advanceAmount;

        createdAdvanceTx = {
          id: storage.generateUUID(),
          tenantId,
          branchId,
          partyId: party.id,
          partyType: party.type,
          type: txType,
          amount: signedAmt,
          balanceAfter: nextAdvanceBalance,
          voucherId: voucher.id,
          journalEntryId,
          date: voucherDate,
          description: voucher.description,
          createdBy: actor.id,
          createdAt: nowIso,
        };
        await db.partyAdvanceTransactions.put(createdAdvanceTx);
        await db.outbox.put({
          id: storage.generateUUID(),
          tenantId,
          branchId,
          entityType: 'PARTY_ADVANCE',
          entityId: createdAdvanceTx.id,
          action: 'CREATE',
          payload: createdAdvanceTx as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 4,
          dependsOn: [voucher.id],
          createdAt: nowIso,
          idempotencyKey: `${tenantId}_PARTY_ADVANCE_${createdAdvanceTx.id}_CREATE`,
        });
      }

      party.balance = roundMoney(party.balance + plan.partyDebtDelta);
      party.advanceBalance = nextAdvanceBalance;
      await db.parties.put(party);
    }

    const persistedMode: PaymentVoucher['voucherMode'] =
      plan.mode === 'GENERAL'
        ? 'GENERAL'
        : party?.type === 'CUSTOMER'
        ? 'CUSTOMER_RECEIPT'
        : 'SUPPLIER_PAYMENT';

    const persistedVoucher: PaymentVoucher = {
      ...voucher,
      branchId,
      amount,
      date: voucherDate,
      voucherMode: persistedMode,
      partyType: party?.type,
      partyName: party?.nameAr || voucher.partyName || '',
      accountCode: plan.primaryContraAccountCode,
      paymentMethod: voucher.paymentMethod || 'CASH',
      journalEntryId,
      status: 'POSTED',
      appliedToDebtAmount: plan.appliedToDebtAmount,
      advanceAmount: plan.advanceAmount,
      allocations: createdAllocations,
      manualOverride: plan.manualOverride,
      overrideReason: plan.overrideReason,
      createdBy: voucher.createdBy || actor.id,
      createdByName: voucher.createdByName || actor.fullName,
      createdAt: voucher.createdAt || nowIso,
    };

    await db.journalEntries.put(journalEntry);
    await db.vouchers.put(persistedVoucher);

    const deps: string[] = [cashBox!.id];
    if (persistedVoucher.partyId) deps.push(persistedVoucher.partyId);

    await db.outbox.put({
      id: storage.generateUUID(),
      tenantId,
      branchId,
      entityType: 'VOUCHER',
      entityId: persistedVoucher.id,
      action: isPromotingDraft ? 'UPDATE' : 'CREATE',
      payload: persistedVoucher as unknown as Record<string, unknown>,
      status: 'PENDING',
      retryCount: 0,
      priority: 3,
      dependsOn: deps,
      createdAt: nowIso,
      idempotencyKey: `${tenantId}_VOUCHER_${persistedVoucher.id}_${isPromotingDraft ? 'POST' : 'CREATE'}`,
    });

    await db.outbox.put({
      id: storage.generateUUID(),
      tenantId,
      branchId,
      entityType: 'JOURNAL_ENTRY',
      entityId: journalEntry.id,
      action: 'CREATE',
      payload: journalEntry as unknown as Record<string, unknown>,
      status: 'PENDING',
      retryCount: 0,
      priority: 4,
      dependsOn: [persistedVoucher.id],
      createdAt: nowIso,
      idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${journalEntry.id}_CREATE`,
    });

    await db.auditLogs.put({
      id: storage.generateUUID(),
      timestamp: nowIso,
      userId: actor.id,
      userName: actor.fullName,
      tenantId,
      branchId,
      action: `سند ${persistedVoucher.type === 'RECEIPT' ? 'قبض' : 'صرف'} مرحل`,
      details: `سند ${persistedVoucher.voucherNumber} بمبلغ ${amount} ${currencySymbol} وقيد ${journalEntry.entryNumber}${plan.advanceAmount > 0 ? ` (رصيد مقدم: ${plan.advanceAmount})` : ''}`,
    });

    return {
      success: true,
      voucher: persistedVoucher,
      journalEntry,
      allocations: createdAllocations,
      advanceTransaction: createdAdvanceTx,
    };
  }

  public async createCashVoucherAtomic(params: {
    voucher: PaymentVoucher;
    manualAllocations?: VoucherManualAllocationInput[];
    overrideReason?: string;
  }): Promise<{
    success: boolean;
    voucher: PaymentVoucher;
    journalEntry?: JournalEntry;
    allocations?: PaymentAllocation[];
    advanceTransaction?: PartyAdvanceTransaction;
  }> {
    await this.ensureReady();
    const { voucher, manualAllocations, overrideReason } = params;
    const perm: Permission = voucher.type === 'RECEIPT' ? 'voucher:receipt' : 'voucher:payment';
    const { actor, tenantId, branchId } = this.requireAuthorizedActor(perm, voucher.branchId);

    const activeBranch = (await db.branches.get(branchId)) || (await this.getActiveBranch());
    const terminalCode = storage.getTerminalCode();
    const currencySymbol = getActiveCurrencyConfig().symbol;

    return await db.transaction(
      'rw',
      [
        db.vouchers,
        db.journalEntries,
        db.cashBoxes,
        db.accounts,
        db.parties,
        db.invoices,
        db.paymentAllocations,
        db.partyAdvanceTransactions,
        db.allocationAudits,
        db.outbox,
        db.auditLogs,
        db.sequences,
      ],
      async () => {
        if (!voucher.id) voucher.id = storage.generateUUID();

        // منع التكرار Idempotency
        const existingVoucher = await db.vouchers.get(voucher.id);
        if (existingVoucher) {
          const existingAllocs = await db.paymentAllocations.where('voucherId').equals(existingVoucher.id).toArray();
          const existingAdv = await db.partyAdvanceTransactions.where('voucherId').equals(existingVoucher.id).first();
          if (existingVoucher.journalEntryId) {
            const existingJe = await db.journalEntries.get(existingVoucher.journalEntryId);
            if (existingJe) {
              return {
                success: true,
                voucher: existingVoucher,
                journalEntry: existingJe,
                allocations: existingAllocs,
                advanceTransaction: existingAdv,
              };
            }
          }
          if (existingVoucher.status === 'DRAFT' && voucher.status === 'DRAFT') {
            return { success: true, voucher: existingVoucher, allocations: [] };
          }
        }

        if (voucher.status === 'DRAFT') {
          const cashBox = await db.cashBoxes.get(voucher.cashBoxId);
          this.assertCashBoxBranchAccess(actor, cashBox, branchId);
          const party = voucher.partyId ? await db.parties.get(voucher.partyId) : undefined;
          if (voucher.partyId && !party) {
            throw new FinancialValidationError('العميل أو المورد المحدد غير موجود.');
          }
          const targetAccount = voucher.accountCode ? await db.accounts.get(voucher.accountCode) : undefined;
          const partyInvoices =
            party && Array.isArray(manualAllocations)
              ? (await db.invoices.where('partyId').equals(party.id).toArray()).filter(
                  (i) => i.branchId === branchId && i.status !== 'REVERSED'
                )
              : [];
          const previewPlan = resolveVoucherAccountingPlan({
            voucherType: voucher.type,
            voucherMode: voucher.voucherMode,
            party,
            requestedAccountCode: voucher.accountCode,
            amount: voucher.amount,
            openInvoices: partyInvoices,
            manualAllocations,
            hasOverridePermission: hasPermission(actor, 'payment:allocation:override'),
            overrideReason,
            hasSupplierAdvancePermission: hasPermission(actor, 'supplier:advance:approve'),
            targetAccountIsLeaf: targetAccount ? targetAccount.isLeaf !== false : false,
          });
          validateVoucherInput({
            voucher: { ...voucher, accountCode: previewPlan.primaryContraAccountCode, status: 'DRAFT' },
            cashBox,
            accountExists: Boolean(party || targetAccount),
            account: party ? undefined : targetAccount,
          });

          if (!voucher.voucherNumber || !voucher.voucherNumber.trim()) {
            voucher.voucherNumber = await this.allocateSequenceNumberAtomic(
              voucher.type === 'RECEIPT' ? 'RCT' : 'PAY',
              activeBranch.code || 'BR01',
              terminalCode,
              tenantId
            );
          }
          const nowIso = new Date().toISOString();
          const savedManualAllocations =
            previewPlan.manualOverride && Array.isArray(manualAllocations)
              ? manualAllocations.map((m) => ({
                  invoiceId: m.invoiceId,
                  allocatedAmount: roundMoney(m.allocatedAmount),
                }))
              : undefined;
          const draftVoucher: PaymentVoucher = {
            ...voucher,
            branchId,
            amount: roundMoney(voucher.amount),
            date: voucher.date || nowIso.split('T')[0],
            status: 'DRAFT',
            accountCode: previewPlan.primaryContraAccountCode,
            partyType: party?.type,
            partyName: party?.nameAr || voucher.partyName || '',
            paymentMethod: voucher.paymentMethod || 'CASH',
            manualOverride: previewPlan.manualOverride,
            overrideReason: previewPlan.overrideReason,
            ...(savedManualAllocations ? { manualAllocations: savedManualAllocations } : {}),
            createdBy: actor.id,
            createdByName: actor.fullName,
            createdAt: nowIso,
          };
          await db.vouchers.put(draftVoucher);
          await db.outbox.put({
            id: storage.generateUUID(),
            tenantId,
            branchId,
            entityType: 'VOUCHER',
            entityId: draftVoucher.id,
            action: 'CREATE',
            payload: draftVoucher as unknown as Record<string, unknown>,
            status: 'PENDING',
            retryCount: 0,
            priority: 3,
            createdAt: nowIso,
            idempotencyKey: `${tenantId}_VOUCHER_${draftVoucher.id}_DRAFT`,
          });
          await db.auditLogs.put({
            id: storage.generateUUID(),
            timestamp: nowIso,
            userId: actor.id,
            userName: actor.fullName,
            tenantId,
            branchId,
            action: `إنشاء مسودة سند ${draftVoucher.type === 'RECEIPT' ? 'قبض' : 'صرف'}`,
            details: `مسودة ${draftVoucher.voucherNumber} بمبلغ ${draftVoucher.amount} ${currencySymbol}`,
          });
          return { success: true, voucher: draftVoucher, allocations: [] };
        }

        return await this.postVoucherCoreTx({
          voucher,
          actor,
          tenantId,
          branchId,
          activeBranch,
          terminalCode,
          currencySymbol,
          manualAllocations,
          overrideReason,
          isPromotingDraft: false,
        });
      }
    );
  }

  public async postDraftCashVoucherAtomic(params: {
    voucherId: string;
    manualAllocations?: VoucherManualAllocationInput[];
    overrideReason?: string;
  }): Promise<{
    success: boolean;
    voucher: PaymentVoucher;
    journalEntry: JournalEntry;
    allocations: PaymentAllocation[];
    advanceTransaction?: PartyAdvanceTransaction;
  }> {
    await this.ensureReady();
    const { voucherId, manualAllocations, overrideReason } = params;
    const pre = await db.vouchers.get(voucherId);
    if (!pre) {
      throw new FinancialValidationError('السند المطلوب ترحيله غير موجود.');
    }
    const perm: Permission = pre.type === 'RECEIPT' ? 'voucher:receipt' : 'voucher:payment';
    const { actor, tenantId } = this.requireAuthorizedActor(perm, pre.branchId);
    const voucherBranchId = pre.branchId?.trim() || storage.getActiveBranchId();
    assertBranchAccess(actor, voucherBranchId, { requireTarget: true });
    const activeBranch = (await db.branches.get(voucherBranchId)) || (await this.getActiveBranch());
    const terminalCode = storage.getTerminalCode();
    const currencySymbol = getActiveCurrencyConfig().symbol;

    return await db.transaction(
      'rw',
      [
        db.vouchers,
        db.journalEntries,
        db.cashBoxes,
        db.accounts,
        db.parties,
        db.invoices,
        db.paymentAllocations,
        db.partyAdvanceTransactions,
        db.allocationAudits,
        db.outbox,
        db.auditLogs,
        db.sequences,
      ],
      async () => {
        const draft = await db.vouchers.get(voucherId);
        if (!draft) throw new FinancialValidationError('السند غير موجود.');
        if (draft.status !== 'DRAFT') {
          throw new FinancialValidationError('يمكن ترحيل السندات التي في حالة المسودة فقط.');
        }
        const effectiveManualAllocations =
          manualAllocations !== undefined ? manualAllocations : draft.manualAllocations;
        const effectiveOverrideReason =
          overrideReason !== undefined ? overrideReason : draft.overrideReason;
        return await this.postVoucherCoreTx({
          voucher: { ...draft, status: 'POSTED' },
          actor,
          tenantId,
          branchId: voucherBranchId,
          activeBranch,
          terminalCode,
          currencySymbol,
          manualAllocations: effectiveManualAllocations,
          overrideReason: effectiveOverrideReason,
          isPromotingDraft: true,
        });
      }
    );
  }

  public async cancelCashVoucherAtomic(params: {
    voucherId: string;
    reason: string;
  }): Promise<PaymentVoucher> {
    await this.ensureReady();
    const reason = String(params.reason || '').trim();
    if (!reason) {
      throw new FinancialValidationError('سبب إلغاء مسودة السند مطلوب.');
    }
    const pre = await db.vouchers.get(params.voucherId);
    if (!pre) {
      throw new FinancialValidationError('السند غير موجود.');
    }
    const { actor, tenantId } = this.requireAuthorizedActor('voucher:cancel', pre.branchId);

    return await db.transaction('rw', [db.vouchers, db.outbox, db.auditLogs], async () => {
      const voucher = await db.vouchers.get(params.voucherId);
      if (!voucher) throw new FinancialValidationError('السند غير موجود.');
      const targetBranch = voucher.branchId?.trim() || actor.branchId || storage.getActiveBranchId();
      assertBranchAccess(actor, targetBranch, { requireTarget: true });
      if ((voucher.status || 'POSTED') !== 'DRAFT') {
        throw new FinancialValidationError(
          'لا يجوز إلغاء أو حذف سند مالي مرحّل نهائياً؛ استخدم إجراء العكس المحاسبي الموثق.'
        );
      }

      const nowIso = new Date().toISOString();
      const cancelled: PaymentVoucher = {
        ...voucher,
        status: 'CANCELLED',
        cancelledReason: reason,
      };
      await db.vouchers.put(cancelled);
      await db.outbox.put({
        id: storage.generateUUID(),
        tenantId,
        branchId: targetBranch,
        entityType: 'VOUCHER',
        entityId: cancelled.id,
        action: 'UPDATE',
        payload: cancelled as unknown as Record<string, unknown>,
        status: 'PENDING',
        retryCount: 0,
        priority: 3,
        createdAt: nowIso,
        idempotencyKey: `${tenantId}_VOUCHER_${cancelled.id}_CANCEL`,
      });
      await db.auditLogs.put({
        id: storage.generateUUID(),
        timestamp: nowIso,
        userId: actor.id,
        userName: actor.fullName,
        tenantId,
        branchId: targetBranch,
        action: 'إلغاء مسودة سند',
        details: `إلغاء مسودة ${cancelled.voucherNumber} - السبب: ${reason}`,
      });
      return cancelled;
    });
  }

  public async reverseCashVoucherAtomic(params: {
    voucherId: string;
    reversalReason: string;
  }): Promise<{
    success: boolean;
    voucher: PaymentVoucher;
    reversalJournalEntry: JournalEntry;
  }> {
    await this.ensureReady();
    const reason = String(params.reversalReason || '').trim();
    if (!reason) {
      throw new FinancialValidationError('سبب عكس السند المالي مطلوب لتوثيق سجل التدقيق.');
    }
    const pre = await db.vouchers.get(params.voucherId);
    if (!pre) {
      throw new FinancialValidationError('السند المطلوب عكسه غير موجود.');
    }
    const { actor, tenantId } = this.requireAuthorizedActor('voucher:reverse', pre.branchId);
    const terminalCode = storage.getTerminalCode();

    return await db.transaction(
      'rw',
      [
        db.vouchers,
        db.journalEntries,
        db.cashBoxes,
        db.accounts,
        db.parties,
        db.invoices,
        db.paymentAllocations,
        db.partyAdvanceTransactions,
        db.outbox,
        db.auditLogs,
        db.sequences,
        db.branches,
      ],
      async () => {
        const voucher = await db.vouchers.get(params.voucherId);
        if (!voucher) throw new FinancialValidationError('السند غير موجود.');
        const voucherBranchId = voucher.branchId?.trim() || '';
        assertBranchAccess(actor, voucherBranchId, { requireTarget: true });
        if (!voucherBranchId) {
          throw new FinancialValidationError('السند غير مربوط بفرع؛ لا يمكن عكسه بأمان.');
        }
        const status = voucher.status || 'POSTED';
        if (status !== 'POSTED') {
          throw new FinancialValidationError('يمكن عكس السندات المرحّلة (POSTED) فقط.');
        }
        if (!voucher.journalEntryId) {
          throw new FinancialValidationError('السند لا يرتبط بقيد محاسبي مرحّل.');
        }

        const originalJe = await db.journalEntries.get(voucher.journalEntryId);
        if (!originalJe || originalJe.status === 'REVERSED') {
          throw new FinancialValidationError('تم عكس القيد المرتبط بهذا السند مسبقاً أو أنه غير موجود.');
        }

        const cashBox = await db.cashBoxes.get(voucher.cashBoxId);
        this.assertCashBoxBranchAccess(actor, cashBox, voucherBranchId);
        const amount = roundMoney(voucher.amount);
        if (voucher.type === 'RECEIPT' && roundMoney(cashBox!.balance) + 0.001 < amount) {
          throw new FinancialValidationError(
            `رصيد الصندوق (${cashBox!.nameAr}) غير كافٍ لعكس سند القبض بمبلغ ${amount}.`
          );
        }

        const origBranch = (await db.branches.get(voucherBranchId)) || (await this.getActiveBranch());
        const reversalNumber = await this.allocateSequenceNumberAtomic(
          'REV',
          origBranch.code || 'BR01',
          terminalCode,
          tenantId
        );
        const nowIso = new Date().toISOString();
        const reversalDate = nowIso.split('T')[0];
        const reversalId = storage.generateUUID();

        const reversedLines: JournalEntryLine[] = originalJe.lines.map((l) => ({
          id: storage.generateUUID(),
          accountCode: l.accountCode,
          accountName: l.accountName,
          debit: roundMoney(l.credit),
          credit: roundMoney(l.debit),
          costCenterId: l.costCenterId,
          memo: `عكس سند ${voucher.voucherNumber}: ${reason}`,
        }));

        const reversalEntry: JournalEntry = {
          id: reversalId,
          entryNumber: reversalNumber,
          date: reversalDate,
          description: `قيد عكسي للسند ${voucher.voucherNumber} (${originalJe.entryNumber}) - السبب: ${reason}`,
          costCenterId: originalJe.costCenterId,
          branchId: voucherBranchId,
          lines: reversedLines,
          status: 'POSTED',
          referenceType: 'VOUCHER_REVERSAL',
          referenceId: voucher.id,
          isAutoGenerated: true,
          reversedEntryId: originalJe.id,
          reversalReason: reason,
        };

        const accountsByCode = await this.getAccountsByCodeMap();
        validateJournalEntryInput({ entry: reversalEntry, accountsByCode });

        // 1) تحديث الصندوق وأرصدة الحسابات
        const cashDelta = voucher.type === 'RECEIPT' ? -amount : amount;
        cashBox!.balance = roundMoney(cashBox!.balance + cashDelta);
        await db.cashBoxes.put(cashBox!);

        for (const line of reversalEntry.lines) {
          const acc = await db.accounts.get(line.accountCode);
          if (acc) {
            acc.balance = roundMoney(acc.balance + accountBalanceDeltaByType(acc.type, line.debit, line.credit));
            await db.accounts.put(acc);
          }
        }

        // 2) عكس تخصيصات الفواتير النشطة
        const activeAllocs = (await db.paymentAllocations.where('voucherId').equals(voucher.id).toArray()).filter(
          (a) => a.status === 'ACTIVE'
        );
        for (const alloc of activeAllocs) {
          const inv = await db.invoices.get(alloc.invoiceId);
          if (inv) {
            inv.paidAmount = fromCents(Math.max(0, toCents(inv.paidAmount) - toCents(alloc.allocatedAmount)));
            await db.invoices.put(inv);
          }
          alloc.status = 'REVERSED';
          await db.paymentAllocations.put(alloc);
          await db.outbox.put({
            id: storage.generateUUID(),
            tenantId,
            branchId: voucherBranchId,
            entityType: 'PAYMENT_ALLOCATION',
            entityId: alloc.id,
            action: 'UPDATE',
            payload: alloc as unknown as Record<string, unknown>,
            status: 'PENDING',
            retryCount: 0,
            priority: 4,
            createdAt: nowIso,
            idempotencyKey: `${tenantId}_PAYMENT_ALLOCATION_${alloc.id}_REVERSED`,
          });
        }

        // 3) عكس حركات الأرصدة المقدمة ورصيد الطرف
        const advTxs = (await db.partyAdvanceTransactions.where('voucherId').equals(voucher.id).toArray()).filter(
          (t) => t.type !== 'REVERSAL'
        );
        if (voucher.partyId) {
          const party = await db.parties.get(voucher.partyId);
          if (party) {
            const netOrigAdv = roundMoney(advTxs.reduce((s, t) => s + Number(t.amount || 0), 0));
            const currentAdv = roundMoney(party.advanceBalance || 0);
            const nextAdv = roundMoney(currentAdv - netOrigAdv);
            if (nextAdv < -0.001) {
              throw new FinancialValidationError(
                'لا يمكن عكس هذا السند لأن الرصيد المقدم الناتج عنه قد استُخدم بالفعل في فواتير أو رد نقدي لاحق.'
              );
            }
            const cleanNextAdv = Math.max(0, nextAdv);
            if (Math.abs(netOrigAdv) > 0.001) {
              const revAdvTx: PartyAdvanceTransaction = {
                id: storage.generateUUID(),
                tenantId,
                branchId: voucherBranchId,
                partyId: party.id,
                partyType: party.type,
                type: 'REVERSAL',
                amount: roundMoney(-netOrigAdv),
                balanceAfter: cleanNextAdv,
                voucherId: voucher.id,
                journalEntryId: reversalEntry.id,
                date: reversalDate,
                description: `عكس رصيد مقدم لسند ${voucher.voucherNumber}: ${reason}`,
                createdBy: actor.id,
                createdAt: nowIso,
              };
              await db.partyAdvanceTransactions.put(revAdvTx);
              await db.outbox.put({
                id: storage.generateUUID(),
                tenantId,
                branchId: voucherBranchId,
                entityType: 'PARTY_ADVANCE',
                entityId: revAdvTx.id,
                action: 'CREATE',
                payload: revAdvTx as unknown as Record<string, unknown>,
                status: 'PENDING',
                retryCount: 0,
                priority: 4,
                createdAt: nowIso,
                idempotencyKey: `${tenantId}_PARTY_ADVANCE_${revAdvTx.id}_CREATE`,
              });
            }

            let debtRestoreDelta = 0;
            if (voucher.appliedToDebtAmount !== undefined) {
              debtRestoreDelta =
                party.type === 'CUSTOMER' && voucher.type === 'RECEIPT'
                  ? voucher.appliedToDebtAmount
                  : party.type === 'SUPPLIER' && voucher.type === 'PAYMENT'
                  ? -voucher.appliedToDebtAmount
                  : 0;
            } else if (activeAllocs.length === 0 && advTxs.length === 0) {
              debtRestoreDelta = voucher.type === 'RECEIPT' ? amount : -amount;
            }

            party.balance = roundMoney(party.balance + debtRestoreDelta);
            party.advanceBalance = cleanNextAdv;
            await db.parties.put(party);
          }
        }

        originalJe.status = 'REVERSED';
        originalJe.reversalReason = reason;
        originalJe.reversedEntryId = reversalEntry.id;
        await db.journalEntries.put(originalJe);
        await db.journalEntries.put(reversalEntry);

        const reversedVoucher: PaymentVoucher = {
          ...voucher,
          status: 'REVERSED',
          reversedByJournalId: reversalEntry.id,
          reversalReason: reason,
        };
        await db.vouchers.put(reversedVoucher);

        await db.outbox.put({
          id: storage.generateUUID(),
          tenantId,
          branchId: voucherBranchId,
          entityType: 'VOUCHER',
          entityId: reversedVoucher.id,
          action: 'UPDATE',
          payload: reversedVoucher as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 3,
          createdAt: nowIso,
          idempotencyKey: `${tenantId}_VOUCHER_${reversedVoucher.id}_REVERSED`,
        });
        await db.outbox.put({
          id: storage.generateUUID(),
          tenantId,
          branchId: voucherBranchId,
          entityType: 'JOURNAL_ENTRY',
          entityId: reversalEntry.id,
          action: 'CREATE',
          payload: reversalEntry as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 4,
          createdAt: nowIso,
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${reversalEntry.id}_CREATE`,
        });
        await db.outbox.put({
          id: storage.generateUUID(),
          tenantId,
          branchId: voucherBranchId,
          entityType: 'JOURNAL_ENTRY',
          entityId: originalJe.id,
          action: 'UPDATE',
          payload: originalJe as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 4,
          createdAt: nowIso,
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${originalJe.id}_REVERSED`,
        });
        await db.auditLogs.put({
          id: storage.generateUUID(),
          timestamp: nowIso,
          userId: actor.id,
          userName: actor.fullName,
          tenantId,
          branchId: voucherBranchId,
          action: 'عكس سند مالي',
          details: `عكس السند ${reversedVoucher.voucherNumber} بقيد ${reversalEntry.entryNumber} - السبب: ${reason}`,
        });

        return {
          success: true,
          voucher: reversedVoucher,
          reversalJournalEntry: reversalEntry,
        };
      }
    );
  }

  public async addVoucher(voucher: PaymentVoucher): Promise<void> {
    await this.createCashVoucherAtomic({ voucher });
  }

  // --- وحدة الأمانات المستقلة الذرية (FIN-02) ---
  public async getAmanatRecords(): Promise<AmanatRecord[]> {
    await this.ensureReady();
    const { actor } = this.requireAuthorizedActor('amanat:view');
    return filterRecordsByBranchScope(await db.amanatRecords.toCollection().reverse().sortBy('receivedDate'), actor);
  }

  public async getAmanatById(id: string): Promise<AmanatRecord | undefined> {
    await this.ensureReady();
    const { actor } = this.requireAuthorizedActor('amanat:view');
    const record = await db.amanatRecords.get(id);
    if (!record) return undefined;
    return filterRecordsByBranchScope([record], actor)[0];
  }

  public async createAmanatDepositAtomic(params: {
    record: AmanatRecord;
    cashBoxId?: string;
  }): Promise<{ success: boolean; record: AmanatRecord; journalEntry?: JournalEntry }> {
    await this.ensureReady();
    const { actor, tenantId, branchId } = this.requireAuthorizedActor('amanat:manage');

    const { record, cashBoxId } = params;
    const requestedCashBoxId = cashBoxId || record.cashBoxId;
    const activeBranch = (await db.branches.get(branchId)) || (await this.getActiveBranch());
    const terminalCode = storage.getTerminalCode();

    return await db.transaction(
      'rw',
      [db.amanatRecords, db.journalEntries, db.cashBoxes, db.accounts, db.outbox, db.auditLogs, db.sequences],
      async () => {
        if (!record.id) record.id = storage.generateUUID();

        const existing = await db.amanatRecords.get(record.id);
        if (existing) {
          const existingJe = existing.journalEntryId
            ? await db.journalEntries.get(existing.journalEntryId)
            : undefined;
          return { success: true, record: existing, journalEntry: existingJe };
        }

        const cashBox =
          record.type === 'CASH'
            ? requestedCashBoxId
              ? await db.cashBoxes.get(requestedCashBoxId)
              : await this.resolveBranchDefaultCashBoxTx(branchId)
            : undefined;
        if (record.type === 'CASH') this.assertCashBoxBranchAccess(actor, cashBox, branchId);
        validateAmanatDepositInput({ record, cashBox });

        if (!record.recordNumber || !record.recordNumber.trim()) {
          record.recordNumber = await this.allocateSequenceNumberAtomic(
            'AMN',
            activeBranch.code || 'BR01',
            terminalCode,
            tenantId
          );
        }

        let createdEntry: JournalEntry | undefined;
        const cashAmt = record.type === 'CASH' ? roundMoney(record.amount) : 0;
        const persistedRecord: AmanatRecord = {
          ...record,
          branchId,
          status: 'HELD',
          cashBoxId: record.type === 'CASH' ? cashBox!.id : undefined,
          amount: cashAmt,
          returnedAmount: 0,
          remainingAmount: cashAmt,
          returnHistory: [],
        };

        if (persistedRecord.type === 'CASH') {
          const amount = persistedRecord.amount;
          const boxAccCode = cashBox!.accountCode;
          const boxAcc = await db.accounts.get(boxAccCode);
          const amanatAcc = await db.accounts.get('2102');
          if (!amanatAcc) {
            throw new FinancialValidationError('حساب الأمانات للغير (2102) غير موجود في الدليل المحاسبي.');
          }

          const entryNumber = await this.allocateSequenceNumberAtomic(
            'JV',
            activeBranch.code || 'BR01',
            terminalCode,
            tenantId
          );
          const jeId = storage.generateUUID();
          createdEntry = {
            id: jeId,
            entryNumber,
            date: persistedRecord.receivedDate.split('T')[0],
            description: `إيداع أمانة نقدية رقم ${persistedRecord.recordNumber} - ${persistedRecord.depositorName}`,
            costCenterId: 'general',
            branchId,
            lines: [
              {
                id: storage.generateUUID(),
                accountCode: boxAccCode,
                accountName: boxAcc?.nameAr || cashBox!.nameAr,
                debit: amount,
                credit: 0,
                costCenterId: 'general',
                memo: `استلام أمانة نقدية سند رقم ${persistedRecord.recordNumber}`,
              },
              {
                id: storage.generateUUID(),
                accountCode: '2102',
                accountName: amanatAcc.nameAr,
                debit: 0,
                credit: amount,
                costCenterId: 'general',
                memo: `التزام أمانة للغير للمودع ${persistedRecord.depositorName}`,
              },
            ],
            status: 'POSTED',
            referenceType: 'AMANAT',
            referenceId: persistedRecord.id,
            isAutoGenerated: true,
          };

          const accountsByCode = await this.getAccountsByCodeMap();
          validateJournalEntryInput({ entry: createdEntry, accountsByCode });

          cashBox!.balance = roundMoney(cashBox!.balance + amount);
          await db.cashBoxes.put(cashBox!);
          if (boxAcc) {
            boxAcc.balance = roundMoney(boxAcc.balance + amount);
            await db.accounts.put(boxAcc);
          }
          amanatAcc.balance = roundMoney(amanatAcc.balance + amount);
          await db.accounts.put(amanatAcc);

          await db.journalEntries.put(createdEntry);
          persistedRecord.journalEntryId = createdEntry.id;
        }

        await db.amanatRecords.put(persistedRecord);

        await db.outbox.put({
          id: storage.generateUUID(),
          tenantId,
          branchId,
          entityType: 'AMANAT',
          entityId: persistedRecord.id,
          action: 'CREATE',
          payload: persistedRecord as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 3,
          dependsOn: persistedRecord.cashBoxId ? [persistedRecord.cashBoxId] : undefined,
          createdAt: new Date().toISOString(),
          idempotencyKey: `${tenantId}_AMANAT_${persistedRecord.id}_CREATE`,
        });

        if (createdEntry) {
          await db.outbox.put({
            id: storage.generateUUID(),
            tenantId,
            branchId,
            entityType: 'JOURNAL_ENTRY',
            entityId: createdEntry.id,
            action: 'CREATE',
            payload: createdEntry as unknown as Record<string, unknown>,
            status: 'PENDING',
            retryCount: 0,
            priority: 4,
            dependsOn: [persistedRecord.id],
            createdAt: new Date().toISOString(),
            idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${createdEntry.id}_CREATE`,
          });
        }

        await db.auditLogs.put({
          id: storage.generateUUID(),
          timestamp: new Date().toISOString(),
          userId: actor.id,
          userName: actor.fullName,
          tenantId,
          branchId,
          action: `إيداع أمانة ${persistedRecord.type === 'CASH' ? 'نقدية' : 'عينية'}`,
          details: `سند أمانة ${persistedRecord.recordNumber} للمودع ${persistedRecord.depositorName}`,
          entityType: 'AMANAT',
          entityId: persistedRecord.id,
          newValue: { status: persistedRecord.status, amount: persistedRecord.amount },
          result: 'SUCCESS',
        });

        return { success: true, record: persistedRecord, journalEntry: createdEntry };
      }
    );
  }

  public async returnAmanatAtomic(params: {
    recordId: string;
    cashBoxId?: string;
    returnAmount?: number;
    recipientSignatureName?: string;
    notes?: string;
  }): Promise<{ success: boolean; record: AmanatRecord; journalEntry?: JournalEntry }> {
    await this.ensureReady();
    const { actor, tenantId } = this.requireAuthorizedActor('amanat:manage');

    const terminalCode = storage.getTerminalCode();

    return await db.transaction(
      'rw',
      [db.amanatRecords, db.journalEntries, db.cashBoxes, db.accounts, db.outbox, db.auditLogs, db.sequences, db.branches],
      async () => {
        const record = await db.amanatRecords.get(params.recordId);
        if (!record) {
          throw new FinancialValidationError('سجل الأمانة المطلوب غير موجود.');
        }
        const recordBranchId = record.branchId?.trim();
        assertBranchAccess(actor, recordBranchId || '', { requireTarget: true });
        if (!recordBranchId) throw new FinancialValidationError('سجل الأمانة غير مربوط بفرع ولا يمكن إرجاعه بأمان.');
        const recordBranch = await db.branches.get(recordBranchId);
        if (!recordBranch) throw new FinancialValidationError('فرع سجل الأمانة غير موجود.');

        const requestedBoxId = params.cashBoxId || record.cashBoxId;
        const cashBox =
          record.type === 'CASH'
            ? requestedBoxId
              ? await db.cashBoxes.get(requestedBoxId)
              : await this.resolveBranchDefaultCashBoxTx(recordBranchId)
            : undefined;
        if (record.type === 'CASH') this.assertCashBoxBranchAccess(actor, cashBox, recordBranchId);
        validateAmanatReturnInput({ record, cashBox, returnAmount: params.returnAmount });

        const todayStr = new Date().toISOString().split('T')[0];
        const totalAmount = roundMoney(record.amount);
        const alreadyReturned = roundMoney(record.returnedAmount || 0);
        const remainingBefore =
          record.remainingAmount !== undefined
            ? roundMoney(record.remainingAmount)
            : roundMoney(Math.max(0, totalAmount - alreadyReturned));

        const effectiveReturn =
          record.type === 'CASH'
            ? params.returnAmount !== undefined
              ? roundMoney(params.returnAmount)
              : remainingBefore
            : 0;

        const nextReturned =
          record.type === 'CASH' ? roundMoney(alreadyReturned + effectiveReturn) : 0;
        const nextRemaining =
          record.type === 'CASH' ? roundMoney(Math.max(0, remainingBefore - effectiveReturn)) : 0;
        const isFullReturn = record.type === 'ITEM' || toCents(nextRemaining) === 0;

        let returnEntry: JournalEntry | undefined;
        const eventId = storage.generateUUID();
        if (record.type === 'CASH') {
          const boxAccCode = cashBox!.accountCode;
          const boxAcc = await db.accounts.get(boxAccCode);
          const amanatAcc = await db.accounts.get('2102');
          if (!amanatAcc) {
            throw new FinancialValidationError('حساب الأمانات للغير (2102) غير موجود.');
          }

          const entryNumber = await this.allocateSequenceNumberAtomic(
            'JV',
            recordBranch.code || 'BR01',
            terminalCode,
            tenantId
          );
          returnEntry = {
            id: storage.generateUUID(),
            entryNumber,
            date: todayStr,
            description: `${isFullReturn ? 'رد وتسليم' : 'رد جزئي لأمانة'} أمانة نقدية رقم ${record.recordNumber} - ${record.depositorName}`,
            costCenterId: 'general',
            branchId: recordBranchId,
            lines: [
              {
                id: storage.generateUUID(),
                accountCode: '2102',
                accountName: amanatAcc.nameAr,
                debit: effectiveReturn,
                credit: 0,
                costCenterId: 'general',
                memo: `تسوية وإبراء جزء من أمانة رقم ${record.recordNumber}`,
              },
              {
                id: storage.generateUUID(),
                accountCode: boxAccCode,
                accountName: boxAcc?.nameAr || cashBox!.nameAr,
                debit: 0,
                credit: effectiveReturn,
                costCenterId: 'general',
                memo: `صرف رد أمانة رقم ${record.recordNumber}`,
              },
            ],
            status: 'POSTED',
            referenceType: 'AMANAT',
            referenceId: record.id,
            isAutoGenerated: true,
          };

          const accountsByCode = await this.getAccountsByCodeMap();
          validateJournalEntryInput({ entry: returnEntry, accountsByCode });

          if (roundMoney(cashBox!.balance) + 0.001 < effectiveReturn) {
            throw new FinancialValidationError(
              `رصيد الصندوق (${cashBox!.nameAr}: ${roundMoney(cashBox!.balance)}) غير كافٍ لرد الأمانة بمبلغ ${effectiveReturn}.`
            );
          }
          cashBox!.balance = roundMoney(cashBox!.balance - effectiveReturn);
          await db.cashBoxes.put(cashBox!);
          if (boxAcc) {
            boxAcc.balance = roundMoney(boxAcc.balance - effectiveReturn);
            await db.accounts.put(boxAcc);
          }
          amanatAcc.balance = roundMoney(amanatAcc.balance - effectiveReturn);
          await db.accounts.put(amanatAcc);
          await db.journalEntries.put(returnEntry);
        }

        const returnEvent: AmanatReturnEvent = {
          id: eventId,
          date: todayStr,
          amount: effectiveReturn,
          cashBoxId: cashBox?.id,
          journalEntryId: returnEntry?.id,
          recipientSignatureName: params.recipientSignatureName || record.depositorName,
          notes: params.notes?.trim() || undefined,
          createdBy: actor.id,
          createdByName: actor.fullName,
        };

        const updatedRecord: AmanatRecord = {
          ...record,
          branchId: recordBranchId,
          status: isFullReturn ? 'RETURNED' : 'HELD',
          returnedAmount: nextReturned,
          remainingAmount: nextRemaining,
          returnHistory: [...(record.returnHistory || []), returnEvent],
          returnedDate: isFullReturn ? todayStr : record.returnedDate,
          recipientSignatureName: params.recipientSignatureName || record.recipientSignatureName || record.depositorName,
          returnJournalEntryId: returnEntry?.id || record.returnJournalEntryId,
        };

        await db.amanatRecords.put(updatedRecord);

        await db.outbox.put({
          id: storage.generateUUID(),
          tenantId,
          branchId: recordBranchId,
          entityType: 'AMANAT',
          entityId: updatedRecord.id,
          action: 'UPDATE',
          payload: updatedRecord as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 3,
          createdAt: new Date().toISOString(),
          idempotencyKey: `${tenantId}_AMANAT_${updatedRecord.id}_RETURN_${eventId}`,
        });

        if (returnEntry) {
          await db.outbox.put({
            id: storage.generateUUID(),
            tenantId,
            branchId: recordBranchId,
            entityType: 'JOURNAL_ENTRY',
            entityId: returnEntry.id,
            action: 'CREATE',
            payload: returnEntry as unknown as Record<string, unknown>,
            status: 'PENDING',
            retryCount: 0,
            priority: 4,
            dependsOn: [updatedRecord.id],
            createdAt: new Date().toISOString(),
            idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${returnEntry.id}_CREATE`,
          });
        }

        await db.auditLogs.put({
          id: storage.generateUUID(),
          timestamp: new Date().toISOString(),
          userId: actor.id,
          userName: actor.fullName,
          tenantId,
          branchId: recordBranchId,
          action: isFullReturn ? 'رد وتسليم أمانة' : 'رد جزئي لأمانة',
          details: `سند أمانة رقم ${updatedRecord.recordNumber} للمودع ${updatedRecord.depositorName} (المبلغ المردود: ${effectiveReturn}، المتبقي: ${nextRemaining})`,
          entityType: 'AMANAT',
          entityId: updatedRecord.id,
          previousValue: { status: record.status, returnedAmount: alreadyReturned, remainingAmount: remainingBefore },
          newValue: { status: updatedRecord.status, returnedAmount: nextReturned, remainingAmount: nextRemaining },
          reason: params.notes?.trim() || 'رد أمانة',
          result: 'SUCCESS',
        });

        return { success: true, record: updatedRecord, journalEntry: returnEntry };
      }
    );
  }

  public async cancelAmanatAtomic(params: {
    recordId: string;
    reason: string;
  }): Promise<{ success: boolean; record: AmanatRecord; journalEntry?: JournalEntry }> {
    await this.ensureReady();
    const { actor, tenantId } = this.requireAuthorizedActor('amanat:manage');

    const cleanReason = params.reason?.trim();
    if (!cleanReason) {
      throw new FinancialValidationError('سبب إلغاء الأمانة مطلوب لتوثيق سجل التدقيق.');
    }

    const terminalCode = storage.getTerminalCode();

    return await db.transaction(
      'rw',
      [db.amanatRecords, db.journalEntries, db.cashBoxes, db.accounts, db.outbox, db.auditLogs, db.sequences, db.branches],
      async () => {
        const record = await db.amanatRecords.get(params.recordId);
        if (!record) {
          throw new FinancialValidationError('سجل الأمانة المطلوب غير موجود.');
        }
        const recordBranchId = record.branchId?.trim();
        assertBranchAccess(actor, recordBranchId || '', { requireTarget: true });
        if (!recordBranchId) throw new FinancialValidationError('سجل الأمانة غير مربوط بفرع.');
        const recordBranch = await db.branches.get(recordBranchId);
        if (!recordBranch) throw new FinancialValidationError('فرع سجل الأمانة غير موجود.');

        if (record.status !== 'HELD') {
          throw new FinancialValidationError('لا يمكن إلغاء أمانة ليست في حالة الحفظ (HELD).');
        }
        if (record.type === 'CASH' && roundMoney(record.returnedAmount || 0) > 0) {
          throw new FinancialValidationError(
            'لا يمكن إلغاء أمانة تم رد جزء منها مسبقاً؛ يرجى إكمال رد المبلغ المتبقي فقط.'
          );
        }

        const todayStr = new Date().toISOString().split('T')[0];
        let cancelEntry: JournalEntry | undefined;

        if (record.type === 'CASH') {
          const amount = roundMoney(record.amount);
          const cashBox = record.cashBoxId
            ? await db.cashBoxes.get(record.cashBoxId)
            : await this.resolveBranchDefaultCashBoxTx(recordBranchId);
          this.assertCashBoxBranchAccess(actor, cashBox, recordBranchId);
          if (roundMoney(cashBox!.balance) + 0.001 < amount) {
            throw new FinancialValidationError(
              `رصيد الصندوق (${cashBox!.nameAr}: ${roundMoney(cashBox!.balance)}) غير كافٍ لعكس وإلغاء الأمانة النقدية (${amount}).`
            );
          }

          const boxAccCode = cashBox!.accountCode;
          const boxAcc = await db.accounts.get(boxAccCode);
          const amanatAcc = await db.accounts.get('2102');
          if (!amanatAcc) {
            throw new FinancialValidationError('حساب الأمانات للغير (2102) غير موجود.');
          }

          const entryNumber = await this.allocateSequenceNumberAtomic(
            'JV',
            recordBranch.code || 'BR01',
            terminalCode,
            tenantId
          );
          cancelEntry = {
            id: storage.generateUUID(),
            entryNumber,
            date: todayStr,
            description: `إلغاء وعكس أمانة نقدية رقم ${record.recordNumber} - ${cleanReason}`,
            costCenterId: 'general',
            branchId: recordBranchId,
            lines: [
              {
                id: storage.generateUUID(),
                accountCode: '2102',
                accountName: amanatAcc.nameAr,
                debit: amount,
                credit: 0,
                costCenterId: 'general',
                memo: `عكس التزام أمانة ملغاة رقم ${record.recordNumber}`,
              },
              {
                id: storage.generateUUID(),
                accountCode: boxAccCode,
                accountName: boxAcc?.nameAr || cashBox!.nameAr,
                debit: 0,
                credit: amount,
                costCenterId: 'general',
                memo: `عكس إيداع أمانة ملغاة رقم ${record.recordNumber}`,
              },
            ],
            status: 'POSTED',
            referenceType: 'AMANAT',
            referenceId: record.id,
            isAutoGenerated: true,
          };

          const accountsByCode = await this.getAccountsByCodeMap();
          validateJournalEntryInput({ entry: cancelEntry, accountsByCode });

          cashBox!.balance = roundMoney(cashBox!.balance - amount);
          await db.cashBoxes.put(cashBox!);
          if (boxAcc) {
            boxAcc.balance = roundMoney(boxAcc.balance - amount);
            await db.accounts.put(boxAcc);
          }
          amanatAcc.balance = roundMoney(amanatAcc.balance - amount);
          await db.accounts.put(amanatAcc);
          await db.journalEntries.put(cancelEntry);
        }

        const updatedRecord: AmanatRecord = {
          ...record,
          branchId: recordBranchId,
          status: 'CANCELLED',
          remainingAmount: 0,
          cancelledDate: todayStr,
          cancelledReason: cleanReason,
          returnJournalEntryId: cancelEntry?.id || record.returnJournalEntryId,
        };

        await db.amanatRecords.put(updatedRecord);

        await db.outbox.put({
          id: storage.generateUUID(),
          tenantId,
          branchId: recordBranchId,
          entityType: 'AMANAT',
          entityId: updatedRecord.id,
          action: 'UPDATE',
          payload: updatedRecord as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 3,
          createdAt: new Date().toISOString(),
          idempotencyKey: `${tenantId}_AMANAT_${updatedRecord.id}_CANCEL`,
        });

        if (cancelEntry) {
          await db.outbox.put({
            id: storage.generateUUID(),
            tenantId,
            branchId: recordBranchId,
            entityType: 'JOURNAL_ENTRY',
            entityId: cancelEntry.id,
            action: 'CREATE',
            payload: cancelEntry as unknown as Record<string, unknown>,
            status: 'PENDING',
            retryCount: 0,
            priority: 4,
            dependsOn: [updatedRecord.id],
            createdAt: new Date().toISOString(),
            idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${cancelEntry.id}_CREATE`,
          });
        }

        await db.auditLogs.put({
          id: storage.generateUUID(),
          timestamp: new Date().toISOString(),
          userId: actor.id,
          userName: actor.fullName,
          tenantId,
          branchId: recordBranchId,
          action: 'إلغاء أمانة',
          details: `إلغاء أمانة رقم ${updatedRecord.recordNumber} للمودع ${updatedRecord.depositorName} — السبب: ${cleanReason}`,
          entityType: 'AMANAT',
          entityId: updatedRecord.id,
          previousValue: { status: record.status, amount: record.amount },
          newValue: { status: 'CANCELLED', cancelledDate: todayStr },
          reason: cleanReason,
          result: 'SUCCESS',
        });

        return { success: true, record: updatedRecord, journalEntry: cancelEntry };
      }
    );
  }

  public async addAmanatRecord(record: AmanatRecord): Promise<void> {
    await this.createAmanatDepositAtomic({ record, cashBoxId: record.cashBoxId });
  }

  public async updateAmanatRecord(record: AmanatRecord): Promise<void> {
    await this.ensureReady();
    const { actor, tenantId } = this.requireAuthorizedActor('amanat:manage');
    await db.transaction('rw', [db.amanatRecords, db.outbox, db.auditLogs], async () => {
      const existing = await db.amanatRecords.get(record.id);
      if (!existing) throw new FinancialValidationError('سجل الأمانة المطلوب تحديثه غير موجود.');
      const targetBranchId = existing.branchId?.trim() || record.branchId?.trim() || '';
      assertBranchAccess(actor, targetBranchId, { requireTarget: true });
      if (!targetBranchId) throw new FinancialValidationError('سجل الأمانة غير مربوط بفرع.');
      const persistedRecord: AmanatRecord = { ...record, branchId: targetBranchId };
      await db.amanatRecords.put(persistedRecord);
      await syncQueueService.enqueue({
        tenantId,
        branchId: targetBranchId,
        entityType: 'AMANAT',
        entityId: persistedRecord.id,
        action: 'UPDATE',
        payload: persistedRecord as unknown as Record<string, unknown>,
      });
      await db.auditLogs.put({
        id: storage.generateUUID(),
        timestamp: new Date().toISOString(),
        userId: actor.id,
        userName: actor.fullName,
        tenantId,
        branchId: targetBranchId,
        action: 'تحديث أمانة',
        details: `تحديث سجل أمانة ${persistedRecord.recordNumber}`,
      });
    });
  }

  // --- المستخدمون والصلاحيات وسجل التدقيق ---
  public async getUsers(): Promise<SystemUser[]> {
    await this.ensureReady();
    const { actor, tenantId } = this.requireAuthorizedActor('users:read');
    const users = await db.users.where('tenantId').equals(tenantId).toArray();
    return filterRecordsByBranchScope(users, actor);
  }

  public async saveUserAtomic(user: SystemUser): Promise<SystemUser> {
    await this.ensureReady();
    const { actor, tenantId, branchId } = this.requireAuthorizedActor('users:manage');
    const cleanUser: SystemUser = {
      ...user,
      tenantId: user.tenantId || tenantId,
      branchId: user.branchId || branchId,
      allowedBranches:
        user.allowedBranches && user.allowedBranches.length > 0
          ? user.allowedBranches
          : [user.branchId || branchId],
      updatedAt: new Date().toISOString(),
    };

    await db.transaction('rw', [db.users, db.auditLogs], async () => {
      await db.users.put(cleanUser);
      await db.auditLogs.put({
        id: storage.generateUUID(),
        timestamp: new Date().toISOString(),
        userId: actor.id,
        userName: actor.fullName,
        tenantId,
        branchId,
        action: 'تحديث صلاحيات/بيانات مستخدم',
        details: `تحديث حساب المستخدم: ${cleanUser.fullName} (${cleanUser.username}) - الدور: ${cleanUser.role}`,
      });
    });

    return cleanUser;
  }

  public async createUserAtomic(params: {
    username: string;
    fullName: string;
    role: SystemUser['role'];
    allowedActivities: CommercialActivityId[];
    branchId: string;
    allowedBranches?: string[];
    plainPassword: string;
  }): Promise<SystemUser> {
    await this.ensureReady();
    const { actor, tenantId } = this.requireAuthorizedActor('users:manage');

    const normalizedUsername = params.username.trim().toLowerCase();
    if (!normalizedUsername || !params.fullName.trim()) {
      throw new FinancialValidationError('اسم المستخدم والاسم الكامل مطلوبان.');
    }

    const strength = validatePasswordStrength(params.plainPassword, normalizedUsername);
    if (!strength.valid) {
      throw new FinancialValidationError(strength.error || 'كلمة المرور ضعيفة.');
    }

    const existingUsers = await db.users.toArray();
    if (existingUsers.some((u) => u.username.toLowerCase() === normalizedUsername)) {
      throw new FinancialValidationError(`اسم المستخدم (${normalizedUsername}) مستخدم بالفعل.`);
    }

    const passwordHash = await hashPassword(params.plainPassword);
    const branchId = params.branchId || 'branch_main';
    const newUser: SystemUser = {
      id: storage.generateUUID(),
      tenantId,
      username: normalizedUsername,
      fullName: params.fullName.trim(),
      role: params.role,
      allowedActivities: params.allowedActivities,
      branchId,
      allowedBranches:
        params.allowedBranches && params.allowedBranches.length > 0
          ? params.allowedBranches
          : [branchId],
      active: true,
      passwordHash,
      mustChangePassword: true,
      failedLoginAttempts: 0,
      updatedAt: new Date().toISOString(),
    };

    await db.transaction('rw', [db.users, db.auditLogs], async () => {
      await db.users.put(newUser);
      await db.auditLogs.put({
        id: storage.generateUUID(),
        timestamp: new Date().toISOString(),
        userId: actor.id,
        userName: actor.fullName,
        tenantId,
        branchId,
        action: 'إنشاء حساب مستخدم',
        details: `إنشاء حساب ${newUser.fullName} (${newUser.username}) بدور ${newUser.role}`,
      });
    });

    return newUser;
  }

  public async getCurrentUser(): Promise<SystemUser> {
    const actor = authService.getCurrentActorSync();
    if (!actor || !authService.getCurrentSessionSync()) {
      throw new Error('لا يوجد مستخدم مسجل الدخول حالياً.');
    }
    return actor;
  }

  public async setCurrentUser(user: SystemUser): Promise<void> {
    const refreshed = await authService.refreshSelfProfile(user);
    if (!refreshed) {
      throw new Error('حظر أمني: لا يمكن تعيين مستخدم جديد دون تسجيل دخوله والتحقق منه.');
    }
    await storage.setCurrentUser(user);
  }

  public async getAuditLogs(): Promise<SystemAuditLog[]> {
    await this.ensureReady();
    const { actor } = this.requireAuthorizedActor('view:audit_logs');
    const allLogs = await db.auditLogs.toCollection().reverse().sortBy('timestamp');
    return filterAuditLogsForUser(allLogs, actor);
  }

  public async logAction(action: string, details: string): Promise<void> {
    const { actor, tenantId, branchId } = this.requireAuthorizedActor('view:dashboard');
    const log: SystemAuditLog = {
      id: storage.generateUUID(),
      timestamp: new Date().toISOString(),
      userId: actor.id,
      userName: actor.fullName,
      tenantId,
      branchId,
      action,
      details,
    };
    await db.auditLogs.put(log);
  }

  // --- طابور الإرسال Outbox ---
  public async getOutboxQueue(): Promise<OutboxQueueItem[]> {
    await this.ensureReady();
    const { actor, tenantId } = this.requireAuthorizedActor('sync:manage');
    const rows = await db.outbox.where('tenantId').equals(tenantId).sortBy('createdAt');
    return filterRecordsByBranchScope(rows, actor);
  }

  public async queueOutboxItem(
    item: Omit<OutboxQueueItem, 'id' | 'createdAt' | 'status' | 'retryCount' | 'idempotencyKey' | 'tenantId'> & {
      idempotencyKey?: string;
      tenantId?: string;
      priority?: number;
      dependsOn?: string[];
    }
  ): Promise<void> {
    const { tenantId, branchId } = this.requireAuthorizedActor('sync:manage', item.branchId);
    await syncQueueService.enqueue({ ...item, tenantId, branchId });
  }

  public async markOutboxSynced(id: string): Promise<void> {
    const { tenantId, actor } = this.requireAuthorizedActor('sync:manage');
    const item = await db.outbox.get(id);
    if (!item || item.tenantId !== tenantId) {
      throw new Error('حظر أمني: عنصر المزامنة غير موجود ضمن المؤسسة الحالية.');
    }
    assertBranchAccess(actor, item.branchId || actor.branchId || storage.getActiveBranchId());
    await syncQueueService.markSynced(id);
  }

  // --- النسخ الاحتياطي والاستعادة الذرية (DB-04) ---
  public async exportBackupJSON(): Promise<string> {
    await this.ensureReady();
    this.requireAuthorizedActor('backup:manage');

    const payload = {
      branches: await db.branches.toArray(),
      accounts: await db.accounts.toArray(),
      activities: await db.activities.toArray(),
      products: await db.products.toArray(),
      productBatches: await db.productBatches.toArray(),
      brands: await db.brands.toArray(),
      productFamilies: await db.productFamilies.toArray(),
      productCatalogMeta: await db.productCatalogMeta.toArray(),
      parties: await db.parties.toArray(),
      invoices: await db.invoices.toArray(),
      journalEntries: await db.journalEntries.toArray(),
      cashBoxes: await db.cashBoxes.toArray(),
      vouchers: await db.vouchers.toArray(),
      paymentAllocations: await db.paymentAllocations.toArray(),
      partyAdvanceTransactions: await db.partyAdvanceTransactions.toArray(),
      allocationAudits: await db.allocationAudits.toArray(),
      amanat: await db.amanatRecords.toArray(),
      users: await db.users.toArray(),
      auditLogs: await db.auditLogs.toArray(),
      outbox: await db.outbox.toArray(),
      syncConflicts: await db.syncConflicts.toArray(),
      sequences: await db.sequences.toArray(),
    };

    const serialized = JSON.stringify(payload);
    let checksum = 0;
    for (let i = 0; i < serialized.length; i++) {
      checksum = (checksum + serialized.charCodeAt(i) * (i + 1)) % 1000000007;
    }

    const backup = {
      app: 'نظام الإدارة التجارية والمحاسبية المتكامل',
      systemIdentifier: 'multi_activity_erp',
      version: '2.2.0',
      exportedAt: new Date().toISOString(),
      checksum: checksum.toString(16),
      data: payload,
    };

    return JSON.stringify(backup, null, 2);
  }

  public async importBackupJSON(jsonContent: string): Promise<{ success: boolean; error?: string }> {
    await this.ensureReady();
    this.requireAuthorizedActor('backup:manage');

    try {
      const parsed = JSON.parse(jsonContent);
      if (!parsed || typeof parsed !== 'object' || !parsed.data) {
        return {
          success: false,
          error: 'الملف غير مطابق لبنية النسخة الاحتياطية الرسمية: حقل البيانات مفقود.',
        };
      }

      if (
        parsed.systemIdentifier &&
        parsed.systemIdentifier !== 'multi_activity_erp' &&
        parsed.systemIdentifier !== 'alharaj_erp'
      ) {
        return {
          success: false,
          error: 'الملف ينتمي لنظام تجاري مختلف وغير متوافق مع قواعد بيانات هذا النظام.',
        };
      }

      if (parsed.checksum) {
        const serialized = JSON.stringify(parsed.data);
        let calculated = 0;
        for (let i = 0; i < serialized.length; i++) {
          calculated = (calculated + serialized.charCodeAt(i) * (i + 1)) % 1000000007;
        }
        if (calculated.toString(16) !== parsed.checksum) {
          return {
            success: false,
            error:
              'فشل التحقق من سلامة النسخة الاحتياطية (Checksum Mismatch)؛ الملف تالف أو تم تعديله خارج النظام، وتم حجب الاستعادة لحماية قواعد البيانات.',
          };
        }
      }

      const d = parsed.data;
      validateCatalogBackupData(d);
      const requiredKeys = [
        'accounts',
        'products',
        'parties',
        'invoices',
        'journalEntries',
        'cashBoxes',
        'vouchers',
        'users',
      ];
      for (const key of requiredKeys) {
        if (!Array.isArray(d[key])) {
          return {
            success: false,
            error: `النسخة الاحتياطية ناقصة: القائمة (${key}) غير موجودة أو غير صالحة.`,
          };
        }
        if (!d[key].every((row: unknown) => Boolean(row) && typeof row === 'object' && !Array.isArray(row))) {
          return {
            success: false,
            error: `توجد سجلات غير صالحة في القائمة (${key}) داخل النسخة الاحتياطية.`,
          };
        }
      }
      const batchMap = new Map<string, ProductBatch>();
      if (Array.isArray(d.productBatches)) {
        for (const b of d.productBatches as ProductBatch[]) {
          if (b && b.id) batchMap.set(b.id, b);
        }
      }
      if (Array.isArray(d.products)) {
        for (const p of d.products as Product[]) {
          if (Array.isArray(p?.batches)) {
            for (const b of p.batches) {
              if (b && b.id && !batchMap.has(b.id)) {
                batchMap.set(b.id, b);
              }
            }
          }
        }
      }
      const normalizedBatches = Array.from(batchMap.values());

      await db.transaction(
        'rw',
        [
          db.branches,
          db.accounts,
          db.activities,
          db.products,
          db.productBatches,
          db.brands,
          db.productFamilies,
          db.productCatalogMeta,
          db.parties,
          db.invoices,
          db.journalEntries,
          db.cashBoxes,
          db.vouchers,
          db.paymentAllocations,
          db.partyAdvanceTransactions,
          db.allocationAudits,
          db.amanatRecords,
          db.users,
          db.auditLogs,
          db.outbox,
          db.syncConflicts,
          db.sequences,
        ],
        async () => {
          if (Array.isArray(d.branches)) {
            await db.branches.clear();
            if (d.branches.length > 0) await db.branches.bulkPut(d.branches);
          }
          if (Array.isArray(d.accounts)) {
            await db.accounts.clear();
            if (d.accounts.length > 0) await db.accounts.bulkPut(d.accounts);
          }
          await db.activities.clear();
          const activitiesToLoad =
            Array.isArray(d.activities) && d.activities.length > 0
              ? d.activities
              : OFFICIAL_ACTIVITIES;
          await db.activities.bulkPut(activitiesToLoad);

          if (Array.isArray(d.products)) {
            await db.products.clear();
            if (d.products.length > 0) {
              await db.products.bulkPut(
                d.products.map((p: Product) => ({ ...p, isActive: p.isActive !== false }))
              );
            }
          }
          await db.productBatches.clear();
          if (normalizedBatches.length > 0) {
            await db.productBatches.bulkPut(normalizedBatches);
          }

          // Older backups do not contain catalog metadata; treat them as empty lists.
          await db.productCatalogMeta.clear();
          if (Array.isArray(d.productCatalogMeta) && d.productCatalogMeta.length > 0) {
            await db.productCatalogMeta.bulkPut(d.productCatalogMeta);
          }
          await db.productFamilies.clear();
          if (Array.isArray(d.productFamilies) && d.productFamilies.length > 0) {
            await db.productFamilies.bulkPut(d.productFamilies);
          }
          await db.brands.clear();
          if (Array.isArray(d.brands) && d.brands.length > 0) {
            await db.brands.bulkPut(d.brands);
          }
          if (Array.isArray(d.parties)) {
            await db.parties.clear();
            if (d.parties.length > 0) {
              await db.parties.bulkPut(
                d.parties.map((p: Party) => ({ ...p, advanceBalance: p.advanceBalance ?? 0 }))
              );
            }
          }
          if (Array.isArray(d.invoices)) {
            await db.invoices.clear();
            if (d.invoices.length > 0) {
              await db.invoices.bulkPut(
                d.invoices.map((inv: Invoice) => ({
                  ...inv,
                  advanceAppliedAmount: inv.advanceAppliedAmount ?? 0,
                  returnedAmount: inv.returnedAmount ?? 0,
                  status: inv.status || (inv.isPosted === false ? 'DRAFT' : 'POSTED'),
                }))
              );
            }
          }
          if (Array.isArray(d.journalEntries)) {
            await db.journalEntries.clear();
            if (d.journalEntries.length > 0) await db.journalEntries.bulkPut(d.journalEntries);
          }
          if (Array.isArray(d.cashBoxes)) {
            await db.cashBoxes.clear();
            if (d.cashBoxes.length > 0) await db.cashBoxes.bulkPut(d.cashBoxes);
          }
          if (Array.isArray(d.vouchers)) {
            await db.vouchers.clear();
            if (d.vouchers.length > 0) {
              await db.vouchers.bulkPut(
                d.vouchers.map((v: PaymentVoucher) => ({ ...v, status: v.status || 'POSTED' }))
              );
            }
          }
          await db.paymentAllocations.clear();
          if (Array.isArray(d.paymentAllocations) && d.paymentAllocations.length > 0) {
            await db.paymentAllocations.bulkPut(d.paymentAllocations);
          }
          await db.partyAdvanceTransactions.clear();
          if (Array.isArray(d.partyAdvanceTransactions) && d.partyAdvanceTransactions.length > 0) {
            await db.partyAdvanceTransactions.bulkPut(d.partyAdvanceTransactions);
          }
          await db.allocationAudits.clear();
          if (Array.isArray(d.allocationAudits) && d.allocationAudits.length > 0) {
            await db.allocationAudits.bulkPut(d.allocationAudits);
          }
          await db.amanatRecords.clear();
          if (Array.isArray(d.amanat) && d.amanat.length > 0) {
            await db.amanatRecords.bulkPut(d.amanat);
          }
          if (Array.isArray(d.users)) {
            await db.users.clear();
            if (d.users.length > 0) {
              await db.users.bulkPut(
                d.users.map((u: SystemUser) => ({
                  ...u,
                  allowedBranches: Array.isArray(u.allowedBranches)
                    ? u.allowedBranches
                    : u.branchId
                      ? [u.branchId]
                      : [],
                  allowedActivities: Array.isArray(u.allowedActivities)
                    ? u.allowedActivities
                    : [],
                }))
              );
            }
          }
          await db.auditLogs.clear();
          if (Array.isArray(d.auditLogs) && d.auditLogs.length > 0) {
            await db.auditLogs.bulkPut(d.auditLogs);
          }
          await db.outbox.clear();
          if (Array.isArray(d.outbox) && d.outbox.length > 0) {
            await db.outbox.bulkPut(d.outbox);
          }
          await db.syncConflicts.clear();
          if (Array.isArray(d.syncConflicts) && d.syncConflicts.length > 0) {
            await db.syncConflicts.bulkPut(d.syncConflicts);
          }
          await db.sequences.clear();
          if (Array.isArray(d.sequences) && d.sequences.length > 0) {
            await db.sequences.bulkPut(d.sequences);
          }
        }
      );

      await this.logAction('استعادة نسخة احتياطية', 'تمت استعادة قاعدة البيانات ذرياً والتحقق من السلامة.');
      return { success: true };
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'ملف النسخة الاحتياطية غير صالح أو تالف.',
      };
    }
  }

  public async resetToCleanBooks(): Promise<void> {
    await this.ensureReady();
    const { actor, tenantId, branchId } = this.requireAuthorizedActor('settings:manage');

    await db.transaction(
      'rw',
      [
        db.invoices,
        db.journalEntries,
        db.vouchers,
        db.paymentAllocations,
        db.partyAdvanceTransactions,
        db.allocationAudits,
        db.amanatRecords,
        db.accounts,
        db.cashBoxes,
        db.parties,
        db.outbox,
        db.auditLogs,
        db.sequences,
      ],
      async () => {
        await db.invoices.clear();
        await db.journalEntries.clear();
        await db.vouchers.clear();
        await db.paymentAllocations.clear();
        await db.partyAdvanceTransactions.clear();
        await db.allocationAudits.clear();
        await db.amanatRecords.clear();
        await db.outbox.clear();
        await db.sequences.clear();
        const accounts = await db.accounts.toArray();
        for (const acc of accounts) {
          if (acc.balance !== 0) {
            await db.accounts.put({ ...acc, balance: 0 });
          }
        }
        const boxes = await db.cashBoxes.toArray();
        for (const box of boxes) {
          if (box.balance !== 0) {
            await db.cashBoxes.put({ ...box, balance: 0 });
          }
        }
        const parties = await db.parties.toArray();
        for (const p of parties) {
          if (p.balance !== 0 || (p.advanceBalance || 0) !== 0) {
            await db.parties.put({ ...p, balance: 0, advanceBalance: 0 });
          }
        }
        await db.auditLogs.put({
          id: storage.generateUUID(),
          timestamp: new Date().toISOString(),
          userId: actor.id,
          userName: actor.fullName,
          tenantId,
          branchId,
          action: 'تصفير الدفاتر التشغيلية',
          details: 'تم بدء سنة مالية / دفتر نظيف مع الاحتفاظ بالحسابات والأصناف والمستخدمين وتصفير الأرصدة.',
        });
      }
    );
    storage.resetToCleanBooks();
  }

  // =========================================================================
  // المعاملات الذرية المركبة الحقيقية (ACID Multi-table Atomic Operations)
  // =========================================================================

  public async createSalesInvoiceAtomic(params: {
    invoice: Invoice;
    totalCogs: number;
    stockDeductions: Array<{ productId: string; quantity: number; batchNumber?: string }>;
    applyAdvanceAmount?: number;
    clientRequestId?: string;
  }): Promise<{ success: boolean; invoice: Invoice; journalEntry: JournalEntry; advanceJournalEntry?: JournalEntry }> {
    await this.ensureReady();
    const { invoice, totalCogs, stockDeductions, clientRequestId } = params;
    const applyAdvance = roundMoney(params.applyAdvanceAmount ?? 0);
    const { actor, tenantId, branchId } = this.requireAuthorizedActor('pos:sale', invoice.branchId);
    assertActivityAccess(actor, invoice.activityId, 'إصدار فاتورة مبيعات');
    if (applyAdvance > 0) {
      assertPermission(actor, 'party:advance:use');
    }
    const activeBranch = (await db.branches.get(branchId)) || (await this.getActiveBranch());
    const terminalCode = storage.getTerminalCode();
    const currencySymbol = getActiveCurrencyConfig().symbol;

    return await db.transaction(
      'rw',
      [
        db.invoices,
        db.journalEntries,
        db.products,
        db.cashBoxes,
        db.accounts,
        db.parties,
        db.paymentAllocations,
        db.partyAdvanceTransactions,
        db.outbox,
        db.auditLogs,
        db.sequences,
      ],
      async () => {
        if (!invoice.id) invoice.id = storage.generateUUID();

        // أ. فحص منع التكرار الإيدمبوتينت (Idempotency / Double-Submit Prevention)
        const existingInv = await db.invoices.get(invoice.id);
        if (existingInv && existingInv.journalEntryId) {
          const existingJe = await db.journalEntries.get(existingInv.journalEntryId);
          if (existingJe) {
            const existingAdvJe = await db.journalEntries
              .filter((j) => j.referenceType === 'ADVANCE_SETTLEMENT' && j.referenceId === existingInv.id)
              .first();
            return {
              success: true,
              invoice: existingInv,
              journalEntry: existingJe,
              advanceJournalEntry: existingAdvJe,
            };
          }
        }
        if (clientRequestId) {
          const dupOutbox = await db.outbox
            .where('idempotencyKey')
            .equals(`REQ_${tenantId}_${clientRequestId}`)
            .first();
          if (dupOutbox) {
            const dupInv = await db.invoices.get(dupOutbox.entityId);
            if (dupInv && dupInv.journalEntryId) {
              const dupJe = await db.journalEntries.get(dupInv.journalEntryId);
              if (dupJe) {
                const dupAdvJe = await db.journalEntries
                  .filter((j) => j.referenceType === 'ADVANCE_SETTLEMENT' && j.referenceId === dupInv.id)
                  .first();
                return {
                  success: true,
                  invoice: dupInv,
                  journalEntry: dupJe,
                  advanceJournalEntry: dupAdvJe,
                };
              }
            }
          }
        }

        const targetCashBox = invoice.cashBoxId ? await db.cashBoxes.get(invoice.cashBoxId) : undefined;
        if (invoice.paidAmount > 0) this.assertCashBoxBranchAccess(actor, targetCashBox, branchId);

        validateSalesInvoiceInput({
          invoice,
          totalCogs,
          stockDeductions,
          cashBox: targetCashBox,
          applyAdvanceAmount: applyAdvance,
        });

        let customer: Party | undefined;
        if (invoice.partyId) {
          customer = await db.parties.get(invoice.partyId);
          if (!customer) {
            throw new FinancialValidationError('العميل المحدد غير موجود في قاعدة البيانات.');
          }
        }
        if (applyAdvance > 0) {
          if (!customer || customer.type !== 'CUSTOMER') {
            throw new FinancialValidationError('تسوية الرصيد المقدم متاحة للعملاء المسجلين فقط.');
          }
          if (toCents(customer.advanceBalance ?? 0) < toCents(applyAdvance)) {
            throw new FinancialValidationError(
              `الرصيد المقدم المتاح للعميل (${roundMoney(customer.advanceBalance || 0)}) غير كافٍ لخصم ${applyAdvance}.`
            );
          }
        }

        // ب. التحقق من المخزون وتطبيق خصم التشغيلات وFEFO مع احتساب التكلفة من المصدر الفعلي
        const todayStr = new Date().toISOString().split('T')[0];
        let actualTotalCogs = 0;
        const recordedStockDeductions: StockDeductionRecorded[] = [];

        for (const deduction of stockDeductions) {
          const product = await db.products.get(deduction.productId);
          if (!product) {
            throw new FinancialValidationError(
              `الصنف ذو المعرف ${deduction.productId} غير موجود في المستودع.`
            );
          }

          if (product.batches && product.batches.length > 0) {
            validateProductStockConsistency(product);
          }

          if (product.currentStock < deduction.quantity) {
            throw new FinancialValidationError(
              `الرصيد المتاح من الصنف (${product.nameAr}) هو ${product.currentStock} فقط، المطلوب بيعه ${deduction.quantity}.`
            );
          }

          if (product.batches && product.batches.length > 0) {
            if (deduction.batchNumber) {
              const batch = product.batches.find((b) => b.batchNumber === deduction.batchNumber);
              if (!batch) {
                throw new FinancialValidationError(
                  `التشغيلة ${deduction.batchNumber} للصنف (${product.nameAr}) غير موجودة.`
                );
              }
              if (batch.expiryDate < todayStr) {
                throw new FinancialValidationError(
                  `محظور تماماً بيع التشغيلة (${batch.batchNumber}) لأنها منتهية الصلاحية بتاريخ ${batch.expiryDate}!`
                );
              }
              if (batch.quantity < deduction.quantity) {
                throw new FinancialValidationError(
                  `الكمية المتاحة في التشغيلة (${batch.batchNumber}) هي ${batch.quantity} فقط.`
                );
              }
              if (!Number.isFinite(batch.costPrice) || batch.costPrice < 0) {
                throw new FinancialValidationError(`تكلفة التشغيلة (${batch.batchNumber}) غير صالحة.`);
              }
              actualTotalCogs += deduction.quantity * batch.costPrice;
              recordedStockDeductions.push({
                productId: product.id,
                batchNumber: batch.batchNumber,
                expiryDate: batch.expiryDate,
                quantity: deduction.quantity,
                unitCost: batch.costPrice,
              });
              batch.quantity = roundMoney(batch.quantity - deduction.quantity, 4);
            } else {
              const validBatches = product.batches
                .filter((b) => b.quantity > 0 && b.expiryDate >= todayStr)
                .sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());

              const totalValidQty = validBatches.reduce((sum, b) => sum + b.quantity, 0);
              if (totalValidQty + 0.0001 < deduction.quantity) {
                throw new FinancialValidationError(
                  `لا توجد كمية سارية كافية من (${product.nameAr})! المتاح غير المنتهي هو ${totalValidQty} فقط.`
                );
              }

              let remainingToDeduct = deduction.quantity;
              for (const batch of validBatches) {
                if (remainingToDeduct <= 0) break;
                const deductFromThis = Math.min(batch.quantity, remainingToDeduct);
                if (!Number.isFinite(batch.costPrice) || batch.costPrice < 0) {
                  throw new FinancialValidationError(`تكلفة التشغيلة (${batch.batchNumber}) غير صالحة.`);
                }
                actualTotalCogs += deductFromThis * batch.costPrice;
                recordedStockDeductions.push({
                  productId: product.id,
                  batchNumber: batch.batchNumber,
                  expiryDate: batch.expiryDate,
                  quantity: deductFromThis,
                  unitCost: batch.costPrice,
                });
                batch.quantity = roundMoney(batch.quantity - deductFromThis, 4);
                remainingToDeduct = roundMoney(remainingToDeduct - deductFromThis, 4);
              }
            }

            product.currentStock = roundMoney(
              product.batches.reduce((sum, b) => sum + b.quantity, 0),
              4
            );
          } else {
            if (!Number.isFinite(product.purchasePrice) || product.purchasePrice < 0) {
              throw new FinancialValidationError(`تكلفة الصنف (${product.nameAr}) غير صالحة.`);
            }
            actualTotalCogs += deduction.quantity * product.purchasePrice;
            recordedStockDeductions.push({
              productId: product.id,
              quantity: deduction.quantity,
              unitCost: product.purchasePrice,
            });
            product.currentStock = roundMoney(product.currentStock - deduction.quantity, 4);
          }

          validateProductStockConsistency(product);
          await db.products.put(product);
        }

        const normalizedCogs = roundMoney(actualTotalCogs);
        invoice.totalCogs = normalizedCogs;
        invoice.stockDeductionsRecorded = recordedStockDeductions;

        // ج. تخصيص رقم الفاتورة إذا كان مفقوداً أو مكرراً
        const sameNumberInv = invoice.invoiceNumber
          ? await db.invoices
              .where('invoiceNumber')
              .equals(invoice.invoiceNumber)
              .filter((i) => i.id !== invoice.id)
              .first()
          : undefined;
        if (!invoice.invoiceNumber || !invoice.invoiceNumber.trim() || sameNumberInv) {
          invoice.invoiceNumber = await this.allocateSequenceNumberAtomic(
            'INV',
            activeBranch.code || 'BR01',
            terminalCode,
            tenantId
          );
        }

        // د. توليد القيد المحاسبي المزدوج المتوازن
        const journalLines: JournalEntryLine[] = [];
        const activityRevenueAccounts: Record<CommercialActivityId, string> = {
          pharmacy: '4101',
          grocery: '4102',
          bike_parts: '4103',
          equipment_parts: '4104',
        };
        const activityInventoryAccounts: Record<CommercialActivityId, string> = {
          pharmacy: '11041',
          grocery: '11042',
          bike_parts: '11043',
          equipment_parts: '11044',
        };
        const activityCogsAccounts: Record<CommercialActivityId, string> = {
          pharmacy: '5101',
          grocery: '5102',
          bike_parts: '5103',
          equipment_parts: '5104',
        };

        const revenueCode = activityRevenueAccounts[invoice.activityId] || '4101';
        const inventoryCode = activityInventoryAccounts[invoice.activityId] || '11041';
        const cogsCode = activityCogsAccounts[invoice.activityId] || '5101';

        const normalizedTotal = roundMoney(invoice.total);
        const cashPaid = roundMoney(invoice.paidAmount);
        if (cashPaid > 0 && targetCashBox) {
          const boxAccount = targetCashBox.accountCode;
          const acc = await db.accounts.get(boxAccount);
          journalLines.push({
            id: storage.generateUUID(),
            accountCode: boxAccount,
            accountName: acc?.nameAr || targetCashBox.nameAr,
            debit: cashPaid,
            credit: 0,
            costCenterId: invoice.activityId,
            memo: `تحصيل نقدي فاتورة مبيعات ${invoice.invoiceNumber}`,
          });

          targetCashBox.balance = roundMoney(targetCashBox.balance + cashPaid);
          await db.cashBoxes.put(targetCashBox);
          if (acc) {
            acc.balance = roundMoney(acc.balance + cashPaid);
            await db.accounts.put(acc);
          }
        }

        const grossCredit = roundMoney(normalizedTotal - cashPaid);
        if (grossCredit > 0) {
          const arAcc = await db.accounts.get('1103');
          journalLines.push({
            id: storage.generateUUID(),
            accountCode: '1103',
            accountName: `${arAcc?.nameAr || 'العملاء والمدينون'} - ${invoice.partyName}`,
            debit: grossCredit,
            credit: 0,
            costCenterId: invoice.activityId,
            memo: `ذمة فاتورة مبيعات ${invoice.invoiceNumber}`,
          });

          if (customer) {
            customer.balance = roundMoney(customer.balance + grossCredit);
            await db.parties.put(customer);
          }
          if (arAcc) {
            arAcc.balance = roundMoney(arAcc.balance + grossCredit);
            await db.accounts.put(arAcc);
          }
        }

        const revAcc = await db.accounts.get(revenueCode);
        journalLines.push({
          id: storage.generateUUID(),
          accountCode: revenueCode,
          accountName: revAcc ? revAcc.nameAr : 'إيرادات المبيعات',
          debit: 0,
          credit: normalizedTotal,
          costCenterId: invoice.activityId,
          memo: `إيراد مبيعات فاتورة ${invoice.invoiceNumber}`,
        });
        if (revAcc) {
          revAcc.balance = roundMoney(revAcc.balance + normalizedTotal);
          await db.accounts.put(revAcc);
        }

        if (normalizedCogs > 0) {
          const cogsAcc = await db.accounts.get(cogsCode);
          journalLines.push({
            id: storage.generateUUID(),
            accountCode: cogsCode,
            accountName: cogsAcc ? cogsAcc.nameAr : 'تكلفة المبيعات',
            debit: normalizedCogs,
            credit: 0,
            costCenterId: invoice.activityId,
            memo: `تكلفة مبيعات فاتورة ${invoice.invoiceNumber}`,
          });
          if (cogsAcc) {
            cogsAcc.balance = roundMoney(cogsAcc.balance + normalizedCogs);
            await db.accounts.put(cogsAcc);
          }

          const invAcc = await db.accounts.get(inventoryCode);
          journalLines.push({
            id: storage.generateUUID(),
            accountCode: inventoryCode,
            accountName: invAcc ? invAcc.nameAr : 'المخزون السلعي',
            debit: 0,
            credit: normalizedCogs,
            costCenterId: invoice.activityId,
            memo: `صرف مخزون مباع فاتورة ${invoice.invoiceNumber}`,
          });
          if (invAcc) {
            invAcc.balance = roundMoney(invAcc.balance - normalizedCogs);
            await db.accounts.put(invAcc);
          }
        }

        const entryNumber = await this.allocateSequenceNumberAtomic(
          'JV',
          activeBranch.code || 'BR01',
          terminalCode,
          tenantId
        );
        const journalEntryId = storage.generateUUID();

        const journalEntry: JournalEntry = {
          id: journalEntryId,
          entryNumber,
          date: invoice.date,
          description: `قيد مبيعات آلي للفاتورة ${invoice.invoiceNumber} - ${invoice.partyName}`,
          costCenterId: invoice.activityId,
          branchId,
          lines: journalLines,
          status: 'POSTED',
          referenceType: 'INVOICE',
          referenceId: invoice.id,
          isAutoGenerated: true,
        };

        const accountsByCode = await this.getAccountsByCodeMap();
        validateJournalEntryInput({ entry: journalEntry, accountsByCode });

        // هـ. تسوية الرصيد المقدم المستقلة إن وُجدت (Dr 2103 / Cr 1103)
        let advanceJournalEntry: JournalEntry | undefined;
        const nowIso = new Date().toISOString();
        if (applyAdvance > 0 && customer) {
          const advAcc = await this.ensureCanonicalAccountTx(SPECIAL_ACCOUNTS.CUSTOMER_ADVANCES);
          const arAcc = await db.accounts.get(SPECIAL_ACCOUNTS.CUSTOMERS_AR);
          if (!advAcc || !arAcc) {
            throw new FinancialValidationError('حساب دفعات العملاء المقدمة (2103) أو العملاء (1103) غير معرف.');
          }

          const advEntryNumber = await this.allocateSequenceNumberAtomic(
            'JV',
            activeBranch.code || 'BR01',
            terminalCode,
            tenantId
          );
          const advEntryId = storage.generateUUID();
          advanceJournalEntry = {
            id: advEntryId,
            entryNumber: advEntryNumber,
            date: invoice.date,
            description: `تسوية رصيد مقدم للعميل ${customer.nameAr} على فاتورة ${invoice.invoiceNumber}`,
            costCenterId: invoice.activityId,
            branchId,
            lines: [
              {
                id: storage.generateUUID(),
                accountCode: SPECIAL_ACCOUNTS.CUSTOMER_ADVANCES,
                accountName: advAcc.nameAr,
                debit: applyAdvance,
                credit: 0,
                costCenterId: invoice.activityId,
                memo: `استخدام رصيد مقدم لفاتورة ${invoice.invoiceNumber}`,
              },
              {
                id: storage.generateUUID(),
                accountCode: SPECIAL_ACCOUNTS.CUSTOMERS_AR,
                accountName: arAcc.nameAr,
                debit: 0,
                credit: applyAdvance,
                costCenterId: invoice.activityId,
                memo: `تخفيض ذمة العميل ${customer.nameAr} لفاتورة ${invoice.invoiceNumber}`,
              },
            ],
            status: 'POSTED',
            referenceType: 'ADVANCE_SETTLEMENT',
            referenceId: invoice.id,
            isAutoGenerated: true,
          };

          const advAccountsMap = await this.getAccountsByCodeMap();
          validateJournalEntryInput({ entry: advanceJournalEntry, accountsByCode: advAccountsMap });

          advAcc.balance = roundMoney(advAcc.balance + accountBalanceDeltaByType(advAcc.type, applyAdvance, 0));
          await db.accounts.put(advAcc);
          arAcc.balance = roundMoney(arAcc.balance + accountBalanceDeltaByType(arAcc.type, 0, applyAdvance));
          await db.accounts.put(arAcc);

          const nextAdvBal = roundMoney((customer.advanceBalance || 0) - applyAdvance);
          customer.advanceBalance = nextAdvBal;
          customer.balance = roundMoney(customer.balance - applyAdvance);
          await db.parties.put(customer);

          const advTx: PartyAdvanceTransaction = {
            id: storage.generateUUID(),
            tenantId,
            branchId,
            partyId: customer.id,
            partyType: 'CUSTOMER',
            type: 'APPLY_TO_INVOICE',
            amount: -applyAdvance,
            balanceAfter: nextAdvBal,
            invoiceId: invoice.id,
            journalEntryId: advanceJournalEntry.id,
            date: invoice.date,
            description: `تسوية رصيد مقدم على الفاتورة ${invoice.invoiceNumber}`,
            createdBy: actor.id,
            createdAt: nowIso,
          };
          await db.partyAdvanceTransactions.put(advTx);

          const advAlloc: PaymentAllocation = {
            id: storage.generateUUID(),
            tenantId,
            branchId,
            advanceTransactionId: advTx.id,
            partyId: customer.id,
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            invoiceDate: invoice.date,
            allocatedAmount: applyAdvance,
            allocationMethod: 'ADVANCE_SETTLEMENT',
            status: 'ACTIVE',
            createdAt: nowIso,
            createdBy: actor.id,
          };
          await db.paymentAllocations.put(advAlloc);
          await db.journalEntries.put(advanceJournalEntry);

          await db.outbox.put({
            id: storage.generateUUID(),
            tenantId,
            branchId,
            entityType: 'PARTY_ADVANCE',
            entityId: advTx.id,
            action: 'CREATE',
            payload: advTx as unknown as Record<string, unknown>,
            status: 'PENDING',
            retryCount: 0,
            priority: 4,
            dependsOn: [invoice.id],
            createdAt: nowIso,
            idempotencyKey: `${tenantId}_PARTY_ADVANCE_${advTx.id}_CREATE`,
          });
          await db.outbox.put({
            id: storage.generateUUID(),
            tenantId,
            branchId,
            entityType: 'PAYMENT_ALLOCATION',
            entityId: advAlloc.id,
            action: 'CREATE',
            payload: advAlloc as unknown as Record<string, unknown>,
            status: 'PENDING',
            retryCount: 0,
            priority: 4,
            dependsOn: [invoice.id, advTx.id],
            createdAt: nowIso,
            idempotencyKey: `${tenantId}_PAYMENT_ALLOCATION_${advAlloc.id}_CREATE`,
          });
          await db.outbox.put({
            id: storage.generateUUID(),
            tenantId,
            branchId,
            entityType: 'JOURNAL_ENTRY',
            entityId: advanceJournalEntry.id,
            action: 'CREATE',
            payload: advanceJournalEntry as unknown as Record<string, unknown>,
            status: 'PENDING',
            retryCount: 0,
            priority: 4,
            dependsOn: [invoice.id],
            createdAt: nowIso,
            idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${advanceJournalEntry.id}_CREATE`,
          });
        }

        invoice.branchId = branchId;
        invoice.journalEntryId = journalEntryId;
        invoice.isPosted = true;
        invoice.advanceAppliedAmount = applyAdvance;
        invoice.paidAmount = roundMoney(cashPaid + applyAdvance);

        await db.journalEntries.put(journalEntry);
        await db.invoices.put(invoice);

        const invoiceDependencies: string[] = [];
        if (invoice.partyId) invoiceDependencies.push(invoice.partyId);
        if (invoice.items) {
          invoice.items.forEach((it) => {
            if (it.productId && !invoiceDependencies.includes(it.productId)) {
              invoiceDependencies.push(it.productId);
            }
          });
        }

        const idemInvoiceKey = clientRequestId
          ? `REQ_${tenantId}_${clientRequestId}`
          : `${tenantId}_INVOICE_${invoice.id}_CREATE`;

        await db.outbox.put({
          id: storage.generateUUID(),
          tenantId,
          branchId,
          entityType: 'INVOICE',
          entityId: invoice.id,
          action: 'CREATE',
          payload: invoice as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 3,
          dependsOn: invoiceDependencies.length > 0 ? invoiceDependencies : undefined,
          createdAt: nowIso,
          idempotencyKey: idemInvoiceKey,
        });

        await db.outbox.put({
          id: storage.generateUUID(),
          tenantId,
          branchId,
          entityType: 'JOURNAL_ENTRY',
          entityId: journalEntry.id,
          action: 'CREATE',
          payload: journalEntry as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 4,
          dependsOn: [invoice.id],
          createdAt: nowIso,
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${journalEntry.id}_CREATE`,
        });

        await db.auditLogs.put({
          id: storage.generateUUID(),
          timestamp: nowIso,
          userId: actor.id,
          userName: actor.fullName,
          tenantId,
          branchId,
          action: 'إصدار فاتورة مبيعات ذرية',
          details: `فاتورة ${invoice.invoiceNumber} بقيمة ${invoice.total} ${currencySymbol} وقيد ${journalEntry.entryNumber}${applyAdvance > 0 ? ` (تسوية رصيد مقدم: ${applyAdvance})` : ''}`,
        });

        return { success: true, invoice, journalEntry, advanceJournalEntry };
      }
    );
  }

  public async createPurchaseInvoiceAtomic(params: {
    invoice: Invoice;
    itemsWithBatches: Array<{
      productId: string;
      quantity: number;
      costPrice: number;
      batchNumber?: string;
      expiryDate?: string;
    }>;
    applyAdvanceAmount?: number;
    clientRequestId?: string;
  }): Promise<{ success: boolean; invoice: Invoice; journalEntry: JournalEntry; advanceJournalEntry?: JournalEntry }> {
    await this.ensureReady();
    const { invoice, itemsWithBatches, clientRequestId } = params;
    const applyAdvance = roundMoney(params.applyAdvanceAmount || 0);
    if (applyAdvance < 0) {
      throw new FinancialValidationError('مبلغ التسوية من رصيد سلفة المورد لا يجوز أن يكون سالباً.');
    }
    const { actor, tenantId, branchId } = this.requireAuthorizedActor(
      'purchase:create',
      invoice.branchId
    );
    assertActivityAccess(actor, invoice.activityId, 'إصدار فاتورة مشتريات');
    if (applyAdvance > 0) {
      assertPermission(actor, 'party:advance:use', 'تسوية سلفة مورد على فاتورة المشتريات');
    }
    const activeBranch = (await db.branches.get(branchId)) || (await this.getActiveBranch());
    const terminalCode = storage.getTerminalCode();
    const currencySymbol = getActiveCurrencyConfig().symbol;

    return await db.transaction(
      'rw',
      [
        db.invoices,
        db.journalEntries,
        db.products,
        db.cashBoxes,
        db.accounts,
        db.parties,
        db.paymentAllocations,
        db.partyAdvanceTransactions,
        db.outbox,
        db.auditLogs,
        db.sequences,
      ],
      async () => {
        if (!invoice.id) invoice.id = storage.generateUUID();

        // فحص منع التكرار Idempotency
        const existingInv = await db.invoices.get(invoice.id);
        if (existingInv && existingInv.journalEntryId) {
          const existingJe = await db.journalEntries.get(existingInv.journalEntryId);
          if (existingJe) {
            const existingAdvJe = await db.journalEntries
              .filter((j) => j.referenceType === 'ADVANCE_SETTLEMENT' && j.referenceId === existingInv.id)
              .first();
            return {
              success: true,
              invoice: existingInv,
              journalEntry: existingJe,
              advanceJournalEntry: existingAdvJe,
            };
          }
        }
        if (clientRequestId) {
          const dupOutbox = await db.outbox
            .where('idempotencyKey')
            .equals(`REQ_${tenantId}_${clientRequestId}`)
            .first();
          if (dupOutbox) {
            const dupInv = await db.invoices.get(dupOutbox.entityId);
            if (dupInv && dupInv.journalEntryId) {
              const dupJe = await db.journalEntries.get(dupInv.journalEntryId);
              if (dupJe) {
                const dupAdvJe = await db.journalEntries
                  .filter((j) => j.referenceType === 'ADVANCE_SETTLEMENT' && j.referenceId === dupInv.id)
                  .first();
                return {
                  success: true,
                  invoice: dupInv,
                  journalEntry: dupJe,
                  advanceJournalEntry: dupAdvJe,
                };
              }
            }
          }
        }

        const targetCashBox = invoice.cashBoxId ? await db.cashBoxes.get(invoice.cashBoxId) : undefined;
        if (invoice.paidAmount > 0) this.assertCashBoxBranchAccess(actor, targetCashBox, branchId);

        validatePurchaseInvoiceInput({
          invoice,
          itemsWithBatches,
          cashBox: targetCashBox,
          applyAdvanceAmount: applyAdvance,
        });

        let supplier: Party | undefined;
        if (invoice.partyId) {
          supplier = await db.parties.get(invoice.partyId);
          if (!supplier) {
            throw new FinancialValidationError('المورد المحدد غير موجود في قاعدة البيانات.');
          }
        }
        if (applyAdvance > 0) {
          if (!supplier || supplier.type !== 'SUPPLIER') {
            throw new FinancialValidationError('تسوية سلف الموردين متاحة للموردين المسجلين فقط.');
          }
          if (toCents(supplier.advanceBalance ?? 0) < toCents(applyAdvance)) {
            throw new FinancialValidationError(
              `رصيد سلفة المورد المتاح (${roundMoney(supplier.advanceBalance || 0)}) غير كافٍ لخصم ${applyAdvance}.`
            );
          }
        }

        const todayStr = new Date().toISOString().split('T')[0];
        // تُوزع تعديلات الفاتورة (الخصم والضريبة) نسبياً على تكلفة التوريد حتى تطابق قيمة المخزون القيد المحاسبي.
        const inventoryCostFactor = invoice.subtotal > 0 ? invoice.total / invoice.subtotal : 1;

        // أ. فحص الأصناف وتحديث الأرصدة والتشغيلات
        for (const item of itemsWithBatches) {
          const product = await db.products.get(item.productId);
          if (!product) {
            throw new FinancialValidationError(`الصنف ذو المعرف ${item.productId} غير موجود.`);
          }

          if (product.batches && product.batches.length > 0) {
            validateProductStockConsistency(product);
          }

          if (invoice.activityId === 'pharmacy') {
            if (!item.batchNumber || !item.batchNumber.trim()) {
              throw new FinancialValidationError(
                `رقم التشغيلة إجباري لإدخال الدواء (${product.nameAr}) في فاتورة الشراء.`
              );
            }
            if (!item.expiryDate || !item.expiryDate.trim()) {
              throw new FinancialValidationError(
                `تاريخ انتهاء الصلاحية إجباري لإدخال الدواء (${product.nameAr}) في فاتورة الشراء.`
              );
            }
            if (item.expiryDate < todayStr) {
              throw new FinancialValidationError(
                `محظور تماماً شراء أو توريد دواء منتهي الصلاحية (${product.nameAr}) بتاريخ ${item.expiryDate}!`
              );
            }
          }

          const landedUnitCost = roundMoney(item.costPrice * inventoryCostFactor, 4);
          if (!Number.isFinite(landedUnitCost) || landedUnitCost < 0) {
            throw new FinancialValidationError(`تكلفة التوريد النهائية للصنف (${product.nameAr}) غير صالحة.`);
          }

          if (item.batchNumber && item.expiryDate) {
            if (!product.batches) product.batches = [];
            const existingBatch = product.batches.find((b) => b.batchNumber === item.batchNumber);
            if (existingBatch) {
              if (existingBatch.expiryDate !== item.expiryDate) {
                throw new FinancialValidationError(`رقم التشغيلة (${item.batchNumber}) مستخدم بتاريخ صلاحية مختلف.`);
              }
              const previousQuantity = existingBatch.quantity;
              const previousValue = previousQuantity * existingBatch.costPrice;
              const addedValue = item.quantity * landedUnitCost;
              const nextQuantity = roundMoney(previousQuantity + item.quantity, 4);
              existingBatch.costPrice = nextQuantity > 0
                ? roundMoney((previousValue + addedValue) / nextQuantity, 4)
                : landedUnitCost;
              existingBatch.quantity = nextQuantity;
            } else {
              product.batches.push({
                id: storage.generateUUID(),
                productId: product.id,
                batchNumber: item.batchNumber,
                expiryDate: item.expiryDate,
                quantity: item.quantity,
                costPrice: landedUnitCost,
              });
            }
            product.currentStock = roundMoney(
              product.batches.reduce((sum, b) => sum + b.quantity, 0),
              4
            );
            const inventoryValue = product.batches.reduce((sum, batch) => sum + batch.quantity * batch.costPrice, 0);
            product.purchasePrice = product.currentStock > 0
              ? roundMoney(inventoryValue / product.currentStock, 4)
              : landedUnitCost;
          } else {
            const previousQuantity = product.currentStock;
            const previousValue = previousQuantity * product.purchasePrice;
            const nextQuantity = roundMoney(previousQuantity + item.quantity, 4);
            product.purchasePrice = nextQuantity > 0
              ? roundMoney((previousValue + item.quantity * landedUnitCost) / nextQuantity, 4)
              : landedUnitCost;
            product.currentStock = nextQuantity;
          }
          validateProductStockConsistency(product);
          await db.products.put(product);
        }

        const sameNumberInv = invoice.invoiceNumber
          ? await db.invoices
              .where('invoiceNumber')
              .equals(invoice.invoiceNumber)
              .filter((i) => i.id !== invoice.id)
              .first()
          : undefined;
        if (!invoice.invoiceNumber || !invoice.invoiceNumber.trim() || sameNumberInv) {
          invoice.invoiceNumber = await this.allocateSequenceNumberAtomic(
            'PUR',
            activeBranch.code || 'BR01',
            terminalCode,
            tenantId
          );
        }

        // ب. قيد اليومية المزدوج
        const activityInventoryAccounts: Record<CommercialActivityId, string> = {
          pharmacy: '11041',
          grocery: '11042',
          bike_parts: '11043',
          equipment_parts: '11044',
        };
        const inventoryAccountCode = activityInventoryAccounts[invoice.activityId] || '11041';
        const invAccount = await db.accounts.get(inventoryAccountCode);

        const normalizedTotal = roundMoney(invoice.total);
        const cashPaid = roundMoney(invoice.paidAmount);
        const journalLines: JournalEntryLine[] = [
          {
            id: storage.generateUUID(),
            accountCode: inventoryAccountCode,
            accountName: invAccount ? invAccount.nameAr : 'المخزون السلعي',
            debit: normalizedTotal,
            credit: 0,
            costCenterId: invoice.activityId,
            memo: `شراء بضاعة فاتورة ${invoice.invoiceNumber} من ${invoice.partyName}`,
          },
        ];
        if (invAccount) {
          invAccount.balance = roundMoney(invAccount.balance + normalizedTotal);
          await db.accounts.put(invAccount);
        }

        if (cashPaid > 0 && targetCashBox) {
          const boxAccount = targetCashBox.accountCode;
          const acc = await db.accounts.get(boxAccount);
          journalLines.push({
            id: storage.generateUUID(),
            accountCode: boxAccount,
            accountName: acc?.nameAr || targetCashBox.nameAr,
            debit: 0,
            credit: cashPaid,
            costCenterId: invoice.activityId,
            memo: `سداد نقدي فاتورة مشتريات ${invoice.invoiceNumber}`,
          });

          targetCashBox.balance = roundMoney(targetCashBox.balance - cashPaid);
          await db.cashBoxes.put(targetCashBox);
          if (acc) {
            acc.balance = roundMoney(acc.balance - cashPaid);
            await db.accounts.put(acc);
          }
        }

        const grossCredit = roundMoney(normalizedTotal - cashPaid);
        if (grossCredit > 0) {
          const apAcc = await db.accounts.get('2101');
          journalLines.push({
            id: storage.generateUUID(),
            accountCode: '2101',
            accountName: `${apAcc?.nameAr || 'الموردون والدائنون'} - ${invoice.partyName}`,
            debit: 0,
            credit: grossCredit,
            costCenterId: invoice.activityId,
            memo: `مستحق آجل فاتورة مشتريات ${invoice.invoiceNumber}`,
          });

          if (supplier) {
            supplier.balance = roundMoney(supplier.balance - grossCredit);
            await db.parties.put(supplier);
          }
          if (apAcc) {
            apAcc.balance = roundMoney(apAcc.balance + grossCredit);
            await db.accounts.put(apAcc);
          }
        }

        const entryNumber = await this.allocateSequenceNumberAtomic(
          'JV',
          activeBranch.code || 'BR01',
          terminalCode,
          tenantId
        );
        const journalEntryId = storage.generateUUID();

        const journalEntry: JournalEntry = {
          id: journalEntryId,
          entryNumber,
          date: invoice.date,
          description: `قيد مشتريات آلي للفاتورة ${invoice.invoiceNumber} - ${invoice.partyName}`,
          costCenterId: invoice.activityId,
          branchId,
          lines: journalLines,
          status: 'POSTED',
          referenceType: 'INVOICE',
          referenceId: invoice.id,
          isAutoGenerated: true,
        };

        const accountsByCode = await this.getAccountsByCodeMap();
        validateJournalEntryInput({ entry: journalEntry, accountsByCode });

        // ج. تسوية سلفة المورد المستقلة إن وُجدت (Dr 2101 / Cr 1105)
        let advanceJournalEntry: JournalEntry | undefined;
        const nowIso = new Date().toISOString();
        if (applyAdvance > 0 && supplier) {
          const supAdvAcc = await this.ensureCanonicalAccountTx(SPECIAL_ACCOUNTS.SUPPLIER_ADVANCES);
          const apAcc = await db.accounts.get(SPECIAL_ACCOUNTS.SUPPLIERS_AP);
          if (!supAdvAcc || !apAcc) {
            throw new FinancialValidationError('حساب سلف الموردين (1105) أو الموردون (2101) غير معرف.');
          }

          const advEntryNumber = await this.allocateSequenceNumberAtomic(
            'JV',
            activeBranch.code || 'BR01',
            terminalCode,
            tenantId
          );
          const advEntryId = storage.generateUUID();
          advanceJournalEntry = {
            id: advEntryId,
            entryNumber: advEntryNumber,
            date: invoice.date,
            description: `تسوية سلفة مورد للمورد ${supplier.nameAr} على فاتورة ${invoice.invoiceNumber}`,
            costCenterId: invoice.activityId,
            branchId,
            lines: [
              {
                id: storage.generateUUID(),
                accountCode: SPECIAL_ACCOUNTS.SUPPLIERS_AP,
                accountName: apAcc.nameAr,
                debit: applyAdvance,
                credit: 0,
                costCenterId: invoice.activityId,
                memo: `تخفيض ذمة المورد ${supplier.nameAr} لفاتورة ${invoice.invoiceNumber}`,
              },
              {
                id: storage.generateUUID(),
                accountCode: SPECIAL_ACCOUNTS.SUPPLIER_ADVANCES,
                accountName: supAdvAcc.nameAr,
                debit: 0,
                credit: applyAdvance,
                costCenterId: invoice.activityId,
                memo: `استخدام سلفة مورد لفاتورة ${invoice.invoiceNumber}`,
              },
            ],
            status: 'POSTED',
            referenceType: 'ADVANCE_SETTLEMENT',
            referenceId: invoice.id,
            isAutoGenerated: true,
          };

          const advAccountsMap = await this.getAccountsByCodeMap();
          validateJournalEntryInput({ entry: advanceJournalEntry, accountsByCode: advAccountsMap });

          apAcc.balance = roundMoney(apAcc.balance + accountBalanceDeltaByType(apAcc.type, applyAdvance, 0));
          await db.accounts.put(apAcc);
          supAdvAcc.balance = roundMoney(supAdvAcc.balance + accountBalanceDeltaByType(supAdvAcc.type, 0, applyAdvance));
          await db.accounts.put(supAdvAcc);

          const nextAdvBal = roundMoney((supplier.advanceBalance || 0) - applyAdvance);
          supplier.advanceBalance = nextAdvBal;
          supplier.balance = roundMoney(supplier.balance + applyAdvance);
          await db.parties.put(supplier);

          const advTx: PartyAdvanceTransaction = {
            id: storage.generateUUID(),
            tenantId,
            branchId,
            partyId: supplier.id,
            partyType: 'SUPPLIER',
            type: 'APPLY_TO_INVOICE',
            amount: -applyAdvance,
            balanceAfter: nextAdvBal,
            invoiceId: invoice.id,
            journalEntryId: advanceJournalEntry.id,
            date: invoice.date,
            description: `تسوية سلفة مورد على الفاتورة ${invoice.invoiceNumber}`,
            createdBy: actor.id,
            createdAt: nowIso,
          };
          await db.partyAdvanceTransactions.put(advTx);

          const advAlloc: PaymentAllocation = {
            id: storage.generateUUID(),
            tenantId,
            branchId,
            advanceTransactionId: advTx.id,
            partyId: supplier.id,
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            invoiceDate: invoice.date,
            allocatedAmount: applyAdvance,
            allocationMethod: 'ADVANCE_SETTLEMENT',
            status: 'ACTIVE',
            createdAt: nowIso,
            createdBy: actor.id,
          };
          await db.paymentAllocations.put(advAlloc);
          await db.journalEntries.put(advanceJournalEntry);

          await db.outbox.put({
            id: storage.generateUUID(),
            tenantId,
            branchId,
            entityType: 'PARTY_ADVANCE',
            entityId: advTx.id,
            action: 'CREATE',
            payload: advTx as unknown as Record<string, unknown>,
            status: 'PENDING',
            retryCount: 0,
            priority: 4,
            dependsOn: [invoice.id],
            createdAt: nowIso,
            idempotencyKey: `${tenantId}_PARTY_ADVANCE_${advTx.id}_CREATE`,
          });
          await db.outbox.put({
            id: storage.generateUUID(),
            tenantId,
            branchId,
            entityType: 'PAYMENT_ALLOCATION',
            entityId: advAlloc.id,
            action: 'CREATE',
            payload: advAlloc as unknown as Record<string, unknown>,
            status: 'PENDING',
            retryCount: 0,
            priority: 4,
            dependsOn: [invoice.id, advTx.id],
            createdAt: nowIso,
            idempotencyKey: `${tenantId}_PAYMENT_ALLOCATION_${advAlloc.id}_CREATE`,
          });
          await db.outbox.put({
            id: storage.generateUUID(),
            tenantId,
            branchId,
            entityType: 'JOURNAL_ENTRY',
            entityId: advanceJournalEntry.id,
            action: 'CREATE',
            payload: advanceJournalEntry as unknown as Record<string, unknown>,
            status: 'PENDING',
            retryCount: 0,
            priority: 4,
            dependsOn: [invoice.id],
            createdAt: nowIso,
            idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${advanceJournalEntry.id}_CREATE`,
          });
        }

        invoice.branchId = branchId;
        invoice.journalEntryId = journalEntryId;
        invoice.isPosted = true;
        invoice.advanceAppliedAmount = applyAdvance;
        invoice.paidAmount = roundMoney(cashPaid + applyAdvance);

        await db.journalEntries.put(journalEntry);
        await db.invoices.put(invoice);

        const purchaseDependencies: string[] = [];
        if (invoice.partyId) purchaseDependencies.push(invoice.partyId);
        if (invoice.items) {
          invoice.items.forEach((it) => {
            if (it.productId && !purchaseDependencies.includes(it.productId)) {
              purchaseDependencies.push(it.productId);
            }
          });
        }

        const idemPurchaseKey = clientRequestId
          ? `REQ_${tenantId}_${clientRequestId}`
          : `${tenantId}_INVOICE_${invoice.id}_CREATE`;

        await db.outbox.put({
          id: storage.generateUUID(),
          tenantId,
          branchId,
          entityType: 'INVOICE',
          entityId: invoice.id,
          action: 'CREATE',
          payload: invoice as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 3,
          dependsOn: purchaseDependencies.length > 0 ? purchaseDependencies : undefined,
          createdAt: nowIso,
          idempotencyKey: idemPurchaseKey,
        });

        await db.outbox.put({
          id: storage.generateUUID(),
          tenantId,
          branchId,
          entityType: 'JOURNAL_ENTRY',
          entityId: journalEntry.id,
          action: 'CREATE',
          payload: journalEntry as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 4,
          dependsOn: [invoice.id],
          createdAt: nowIso,
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${journalEntry.id}_CREATE`,
        });

        await db.auditLogs.put({
          id: storage.generateUUID(),
          timestamp: nowIso,
          userId: actor.id,
          userName: actor.fullName,
          tenantId,
          branchId,
          action: 'إصدار فاتورة مشتريات ذرية',
          details: `فاتورة ${invoice.invoiceNumber} بقيمة ${invoice.total} ${currencySymbol} وقيد ${journalEntry.entryNumber}${applyAdvance > 0 ? ` (تسوية سلفة مورد: ${applyAdvance})` : ''}`,
          entityType: 'INVOICE',
          entityId: invoice.id,
          newValue: { total: invoice.total, paidAmount: invoice.paidAmount, advanceAppliedAmount: applyAdvance },
          result: 'SUCCESS',
        });

        return { success: true, invoice, journalEntry, advanceJournalEntry };
      }
    );
  }

  public async createSalesReturnAtomic(params: {
    originalInvoiceId: string;
    items: Array<{ productId: string; quantity: number; batchNumber?: string }>;
    returnReason: string;
    refundMethod: 'AUTO' | 'AR_OFFSET' | 'CASH' | 'ADVANCE';
    cashBoxId?: string;
    date?: string;
    clientRequestId?: string;
  }): Promise<{ success: boolean; invoice: Invoice; journalEntry: JournalEntry }> {
    await this.ensureReady();
    const { actor, tenantId } = this.requireAuthorizedActor('pos:return');
    const cleanReason = params.returnReason?.trim();
    if (!cleanReason) {
      throw new FinancialValidationError('سبب مرتجع المبيعات مطلوب لتوثيق القيد وسجل التدقيق.');
    }
    if (!params.items || params.items.length === 0) {
      throw new FinancialValidationError('يجب تحديد صنف واحد على الأقل لإتمام مرتجع المبيعات.');
    }

    const terminalCode = storage.getTerminalCode();
    const currencySymbol = getActiveCurrencyConfig().symbol;

    return await db.transaction(
      'rw',
      [
        db.invoices,
        db.journalEntries,
        db.products,
        db.cashBoxes,
        db.accounts,
        db.parties,
        db.partyAdvanceTransactions,
        db.outbox,
        db.auditLogs,
        db.sequences,
        db.branches,
      ],
      async () => {
        if (params.clientRequestId) {
          const dupOutbox = await db.outbox
            .where('idempotencyKey')
            .equals(`REQ_${tenantId}_${params.clientRequestId}`)
            .first();
          if (dupOutbox) {
            const dupInv = await db.invoices.get(dupOutbox.entityId);
            if (dupInv && dupInv.journalEntryId) {
              const dupJe = await db.journalEntries.get(dupInv.journalEntryId);
              if (dupJe) {
                return { success: true, invoice: dupInv, journalEntry: dupJe };
              }
            }
          }
        }

        const orig = await db.invoices.get(params.originalInvoiceId);
        if (!orig) {
          throw new FinancialValidationError('فاتورة المبيعات الأصلية غير موجودة.');
        }
        assertActivityAccess(actor, orig.activityId, 'إصدار مرتجع مبيعات');
        if (orig.type !== 'SALE') {
          throw new FinancialValidationError('يمكن إصدار مرتجع مبيعات لفواتير المبيعات (SALE) فقط.');
        }
        if (orig.status === 'REVERSED') {
          throw new FinancialValidationError('لا يمكن عمل مرتجع على فاتورة مبيعات معكوسة.');
        }

        const targetBranchId = orig.branchId?.trim() || '';
        assertBranchAccess(actor, targetBranchId, { requireTarget: true });
        const branch = await db.branches.get(targetBranchId);
        if (!branch) throw new FinancialValidationError('فرع الفاتورة الأصلية غير موجود.');

        const priorReturns = await db.invoices
          .filter(
            (i) =>
              i.type === 'RETURN_SALE' &&
              i.originalInvoiceId === orig.id &&
              i.status !== 'REVERSED'
          )
          .toArray();

        const returnedByProduct = new Map<string, number>();
        const returnedByProductBatch = new Map<string, number>();
        const returnedByDeductionKey = new Map<string, number>();
        for (const r of priorReturns) {
          for (const it of r.items || []) {
            returnedByProduct.set(
              it.productId,
              roundMoney((returnedByProduct.get(it.productId) || 0) + it.quantity, 4)
            );
            if (it.batchNumber) {
              const itemKey = `${it.productId}::${it.batchNumber}`;
              returnedByProductBatch.set(
                itemKey,
                roundMoney((returnedByProductBatch.get(itemKey) || 0) + it.quantity, 4)
              );
            }
          }
          for (const ded of r.stockDeductionsRecorded || []) {
            const dk = `${ded.productId}::${ded.batchNumber || ''}`;
            returnedByDeductionKey.set(
              dk,
              roundMoney((returnedByDeductionKey.get(dk) || 0) + ded.quantity, 4)
            );
          }
        }

        const netFactor = orig.subtotal > 0 ? orig.total / orig.subtotal : 1;
        const returnItems: InvoiceItem[] = [];
        const restoredDeductions: StockDeductionRecorded[] = [];
        let returnSubtotal = 0;
        let returnTotal = 0;
        let restoredCogs = 0;

        for (const reqItem of params.items) {
          if (!reqItem.productId || !Number.isFinite(reqItem.quantity) || reqItem.quantity <= 0) {
            throw new FinancialValidationError('كمية الصنف المرتجع يجب أن تكون أكبر من الصفر.');
          }
          const reqQty = roundMoney(reqItem.quantity, 4);
          const matchingOrigLines = (orig.items || []).filter(
            (it) =>
              it.productId === reqItem.productId &&
              (!reqItem.batchNumber || it.batchNumber === reqItem.batchNumber)
          );
          if (matchingOrigLines.length === 0) {
            throw new FinancialValidationError(`الصنف (${reqItem.productId}) غير موجود ضمن بنود الفاتورة الأصلية.`);
          }
          const soldQty = roundMoney(matchingOrigLines.reduce((s, l) => s + l.quantity, 0), 4);
          const batchKey = `${reqItem.productId}::${reqItem.batchNumber || ''}`;
          const alreadyRet = reqItem.batchNumber
            ? (returnedByDeductionKey.get(batchKey) || returnedByProductBatch.get(batchKey) || 0)
            : (returnedByProduct.get(reqItem.productId) || 0);
          const remainingReturnable = roundMoney(soldQty - alreadyRet, 4);
          if (reqQty > remainingReturnable + 0.0001) {
            throw new FinancialValidationError(
              `الكمية المطلوب إرجاعها للصنف (${matchingOrigLines[0].productName}) تتجاوز الكمية المتاحة للإرجاع (${remainingReturnable}).`
            );
          }
          returnedByProduct.set(reqItem.productId, roundMoney((returnedByProduct.get(reqItem.productId) || 0) + reqQty, 4));
          if (reqItem.batchNumber) {
            returnedByProductBatch.set(batchKey, roundMoney((returnedByProductBatch.get(batchKey) || 0) + reqQty, 4));
          }

          const avgLineNetUnit =
            matchingOrigLines.reduce((s, l) => s + l.total, 0) / soldQty;
          const lineNetTotal = roundMoney(reqQty * avgLineNetUnit * netFactor);
          returnSubtotal = roundMoney(returnSubtotal + roundMoney(reqQty * avgLineNetUnit));
          returnTotal = roundMoney(returnTotal + lineNetTotal);

          const product = await db.products.get(reqItem.productId);
          if (!product) {
            throw new FinancialValidationError(`الصنف (${reqItem.productId}) غير موجود في المستودع.`);
          }

          // استرداد الكمية والتكلفة من سجل خصم المخزون الأصلي (Perpetual Inventory Restoration)
          const matchingDeductions = (orig.stockDeductionsRecorded || []).filter(
            (d) =>
              d.productId === reqItem.productId &&
              (!reqItem.batchNumber || d.batchNumber === reqItem.batchNumber)
          );

          let qtyLeftToRestore = reqQty;
          if (matchingDeductions.length > 0) {
            for (const ded of matchingDeductions) {
              if (qtyLeftToRestore <= 0) break;
              const dk = `${ded.productId}::${ded.batchNumber || ''}`;
              const usedBefore = returnedByDeductionKey.get(dk) || 0;
              const availFromSlice = roundMoney(Math.max(0, ded.quantity - usedBefore), 4);
              if (availFromSlice <= 0) continue;
              const sliceQty = Math.min(qtyLeftToRestore, availFromSlice);
              returnedByDeductionKey.set(dk, roundMoney(usedBefore + sliceQty, 4));
              qtyLeftToRestore = roundMoney(qtyLeftToRestore - sliceQty, 4);

              const sliceUnitCost = Number.isFinite(ded.unitCost) ? ded.unitCost : product.purchasePrice;
              restoredCogs = roundMoney(restoredCogs + sliceQty * sliceUnitCost);
              restoredDeductions.push({
                productId: product.id,
                batchNumber: ded.batchNumber,
                expiryDate: ded.expiryDate,
                quantity: sliceQty,
                unitCost: sliceUnitCost,
              });

              if (ded.batchNumber) {
                if (!product.batches) product.batches = [];
                const targetBatch = product.batches.find((b) => b.batchNumber === ded.batchNumber);
                if (targetBatch) {
                  const prevQ = targetBatch.quantity;
                  const nextQ = roundMoney(prevQ + sliceQty, 4);
                  targetBatch.costPrice =
                    nextQ > 0
                      ? roundMoney((prevQ * targetBatch.costPrice + sliceQty * sliceUnitCost) / nextQ, 4)
                      : sliceUnitCost;
                  targetBatch.quantity = nextQ;
                } else {
                  product.batches.push({
                    id: storage.generateUUID(),
                    productId: product.id,
                    batchNumber: ded.batchNumber,
                    expiryDate: ded.expiryDate || new Date().toISOString().split('T')[0],
                    quantity: sliceQty,
                    costPrice: sliceUnitCost,
                  });
                }
                product.currentStock = roundMoney(
                  product.batches.reduce((s, b) => s + b.quantity, 0),
                  4
                );
                const val = product.batches.reduce((s, b) => s + b.quantity * b.costPrice, 0);
                product.purchasePrice =
                  product.currentStock > 0 ? roundMoney(val / product.currentStock, 4) : sliceUnitCost;
              } else {
                const prevQ = product.currentStock;
                const nextQ = roundMoney(prevQ + sliceQty, 4);
                product.purchasePrice =
                  nextQ > 0
                    ? roundMoney((prevQ * product.purchasePrice + sliceQty * sliceUnitCost) / nextQ, 4)
                    : sliceUnitCost;
                product.currentStock = nextQ;
              }
            }
          }

          if (qtyLeftToRestore > 0.0001) {
            const fallbackCost = product.purchasePrice;
            restoredCogs = roundMoney(restoredCogs + qtyLeftToRestore * fallbackCost);
            restoredDeductions.push({
              productId: product.id,
              quantity: qtyLeftToRestore,
              unitCost: fallbackCost,
            });
            product.currentStock = roundMoney(product.currentStock + qtyLeftToRestore, 4);
          }

          validateProductStockConsistency(product);
          await db.products.put(product);

          returnItems.push({
            id: storage.generateUUID(),
            productId: product.id,
            productName: matchingOrigLines[0].productName || product.nameAr,
            productCode: matchingOrigLines[0].productCode || product.code,
            batchNumber: reqItem.batchNumber || matchingOrigLines[0].batchNumber,
            unit: matchingOrigLines[0].unit || product.unit,
            quantity: reqQty,
            unitPrice: roundMoney(avgLineNetUnit * netFactor, 4),
            discount: 0,
            total: lineNetTotal,
          });
        }

        const returnDate = params.date || new Date().toISOString().split('T')[0];
        const customer = orig.partyId ? await db.parties.get(orig.partyId) : undefined;
        const origOpenRemaining = getInvoiceRemainingAmount(orig);

        let arCredited = 0;
        let cashRefund = 0;
        let advanceCredited = 0;

        if (params.refundMethod === 'AR_OFFSET') {
          if (!customer || customer.type !== 'CUSTOMER') {
            throw new FinancialValidationError('تخفيض ذمة العميل متاح للعملاء المسجلين فقط.');
          }
          if (toCents(returnTotal) > toCents(origOpenRemaining) + 1) {
            throw new FinancialValidationError(
              `مبلغ المرتجع (${returnTotal}) يتجاوز المتبقي المفتوح من الفاتورة (${origOpenRemaining})؛ استخدم التسوية التلقائية أو الرد النقدي/الرصيد المقدم.`
            );
          }
          arCredited = Math.min(returnTotal, origOpenRemaining);
        } else if (params.refundMethod === 'CASH') {
          if (toCents(origOpenRemaining) > 0 && toCents(returnTotal) > toCents(roundMoney(orig.total - origOpenRemaining)) + 1) {
            throw new FinancialValidationError(
              'الفاتورة تحتوي على ذمة آجلة غير مسددة؛ استخدم التسوية التلقائية لتخفيض الذمة أولاً قبل رد النقد.'
            );
          }
          cashRefund = returnTotal;
        } else if (params.refundMethod === 'ADVANCE') {
          if (!customer || customer.type !== 'CUSTOMER') {
            throw new FinancialValidationError('ترحيل قيمة المرتجع كرصيد مقدم متاح للعملاء المسجلين فقط.');
          }
          if (toCents(origOpenRemaining) > 0 && toCents(returnTotal) > toCents(roundMoney(orig.total - origOpenRemaining)) + 1) {
            throw new FinancialValidationError(
              'الفاتورة تحتوي على ذمة آجلة غير مسددة؛ استخدم التسوية التلقائية لتخفيض الذمة أولاً.'
            );
          }
          advanceCredited = returnTotal;
        } else {
          // AUTO
          arCredited = customer ? Math.min(returnTotal, origOpenRemaining) : 0;
          const excess = roundMoney(returnTotal - arCredited);
          if (excess > 0) {
            if (params.cashBoxId || !customer) {
              cashRefund = excess;
            } else {
              // تحقق من وجود دفع نقدي سابق إذا كانت الفاتورة مسددة
              cashRefund = orig.cashBoxId ? excess : 0;
              advanceCredited = cashRefund > 0 ? 0 : excess;
            }
          }
        }

        let targetCashBox: CashBox | undefined;
        if (cashRefund > 0) {
          const reqBoxId = params.cashBoxId || orig.cashBoxId;
          targetCashBox = reqBoxId
            ? await db.cashBoxes.get(reqBoxId)
            : await this.resolveBranchDefaultCashBoxTx(targetBranchId);
          this.assertCashBoxBranchAccess(actor, targetCashBox, targetBranchId);
          if (roundMoney(targetCashBox!.balance) + 0.001 < cashRefund) {
            throw new FinancialValidationError(
              `رصيد الصندوق (${targetCashBox!.nameAr}: ${roundMoney(targetCashBox!.balance)}) غير كافٍ لرد مبلغ ${cashRefund}.`
            );
          }
        }

        const returnNumber = await this.allocateSequenceNumberAtomic(
          'RS',
          branch.code || 'BR01',
          terminalCode,
          tenantId
        );
        const returnInvoiceId = storage.generateUUID();

        const salesReturnAccounts: Record<CommercialActivityId, string> = {
          pharmacy: '4201',
          grocery: '4202',
          bike_parts: '4203',
          equipment_parts: '4204',
        };
        const activityInventoryAccounts: Record<CommercialActivityId, string> = {
          pharmacy: '11041',
          grocery: '11042',
          bike_parts: '11043',
          equipment_parts: '11044',
        };
        const activityCogsAccounts: Record<CommercialActivityId, string> = {
          pharmacy: '5101',
          grocery: '5102',
          bike_parts: '5103',
          equipment_parts: '5104',
        };

        const contraRevCode = salesReturnAccounts[orig.activityId] || '4201';
        const invCode = activityInventoryAccounts[orig.activityId] || '11041';
        const cogsCode = activityCogsAccounts[orig.activityId] || '5101';

        const contraRevAcc = await this.ensureCanonicalAccountTx(contraRevCode);
        const invAcc = await db.accounts.get(invCode);
        const cogsAcc = await db.accounts.get(cogsCode);
        if (!contraRevAcc) {
          throw new FinancialValidationError(`حساب مردودات المبيعات (${contraRevCode}) غير معرف في الدليل.`);
        }

        const journalLines: JournalEntryLine[] = [
          {
            id: storage.generateUUID(),
            accountCode: contraRevCode,
            accountName: contraRevAcc.nameAr,
            debit: returnTotal,
            credit: 0,
            costCenterId: orig.activityId,
            memo: `مردودات مبيعات فاتورة ${returnNumber} (أصل ${orig.invoiceNumber})`,
          },
        ];
        contraRevAcc.balance = roundMoney(
          contraRevAcc.balance + accountBalanceDeltaByType(contraRevAcc.type, returnTotal, 0)
        );
        await db.accounts.put(contraRevAcc);

        if (arCredited > 0) {
          const arAcc = await db.accounts.get(SPECIAL_ACCOUNTS.CUSTOMERS_AR);
          if (!arAcc) throw new FinancialValidationError('حساب العملاء (1103) غير معرف.');
          journalLines.push({
            id: storage.generateUUID(),
            accountCode: SPECIAL_ACCOUNTS.CUSTOMERS_AR,
            accountName: `${arAcc.nameAr} - ${orig.partyName}`,
            debit: 0,
            credit: arCredited,
            costCenterId: orig.activityId,
            memo: `تخفيض ذمة العميل عن مرتجع ${returnNumber}`,
          });
          arAcc.balance = roundMoney(arAcc.balance + accountBalanceDeltaByType(arAcc.type, 0, arCredited));
          await db.accounts.put(arAcc);
          if (customer) {
            customer.balance = roundMoney(customer.balance - arCredited);
          }
          orig.returnedAmount = roundMoney((orig.returnedAmount || 0) + arCredited);
          await db.invoices.put(orig);
        }

        if (cashRefund > 0 && targetCashBox) {
          const boxAcc = await db.accounts.get(targetCashBox.accountCode);
          journalLines.push({
            id: storage.generateUUID(),
            accountCode: targetCashBox.accountCode,
            accountName: boxAcc?.nameAr || targetCashBox.nameAr,
            debit: 0,
            credit: cashRefund,
            costCenterId: orig.activityId,
            memo: `رد نقدي لمرتجع مبيعات ${returnNumber}`,
          });
          targetCashBox.balance = roundMoney(targetCashBox.balance - cashRefund);
          await db.cashBoxes.put(targetCashBox);
          if (boxAcc) {
            boxAcc.balance = roundMoney(boxAcc.balance + accountBalanceDeltaByType(boxAcc.type, 0, cashRefund));
            await db.accounts.put(boxAcc);
          }
        }

        let advTx: PartyAdvanceTransaction | undefined;
        const nowIso = new Date().toISOString();
        if (advanceCredited > 0 && customer) {
          const advAcc = await this.ensureCanonicalAccountTx(SPECIAL_ACCOUNTS.CUSTOMER_ADVANCES);
          if (!advAcc) throw new FinancialValidationError('حساب دفعات العملاء المقدمة (2103) غير معرف.');
          journalLines.push({
            id: storage.generateUUID(),
            accountCode: SPECIAL_ACCOUNTS.CUSTOMER_ADVANCES,
            accountName: advAcc.nameAr,
            debit: 0,
            credit: advanceCredited,
            costCenterId: orig.activityId,
            memo: `إيداع رصيد مقدم للعميل عن مرتجع مبيعات ${returnNumber}`,
          });
          advAcc.balance = roundMoney(advAcc.balance + accountBalanceDeltaByType(advAcc.type, 0, advanceCredited));
          await db.accounts.put(advAcc);
          const nextAdvBal = roundMoney((customer.advanceBalance || 0) + advanceCredited);
          customer.advanceBalance = nextAdvBal;
          advTx = {
            id: storage.generateUUID(),
            tenantId,
            branchId: targetBranchId,
            partyId: customer.id,
            partyType: 'CUSTOMER',
            type: 'OVERPAYMENT_DEPOSIT',
            amount: advanceCredited,
            balanceAfter: nextAdvBal,
            invoiceId: returnInvoiceId,
            date: returnDate,
            description: `رصيد مقدم ناتج عن مرتجع مبيعات ${returnNumber} (أصل ${orig.invoiceNumber})`,
            createdBy: actor.id,
            createdAt: nowIso,
          };
        }

        if (customer && (arCredited > 0 || advanceCredited > 0)) {
          await db.parties.put(customer);
        }

        if (restoredCogs > 0) {
          if (!invAcc || !cogsAcc) {
            throw new FinancialValidationError('حساب المخزون أو تكلفة المبيعات غير معرف.');
          }
          journalLines.push({
            id: storage.generateUUID(),
            accountCode: invCode,
            accountName: invAcc.nameAr,
            debit: restoredCogs,
            credit: 0,
            costCenterId: orig.activityId,
            memo: `إعادة بضاعة مرتجعة للمخزون ${returnNumber}`,
          });
          invAcc.balance = roundMoney(invAcc.balance + accountBalanceDeltaByType(invAcc.type, restoredCogs, 0));
          await db.accounts.put(invAcc);

          journalLines.push({
            id: storage.generateUUID(),
            accountCode: cogsCode,
            accountName: cogsAcc.nameAr,
            debit: 0,
            credit: restoredCogs,
            costCenterId: orig.activityId,
            memo: `تخفيض تكلفة البضاعة المباعة لمرتجع ${returnNumber}`,
          });
          cogsAcc.balance = roundMoney(cogsAcc.balance + accountBalanceDeltaByType(cogsAcc.type, 0, restoredCogs));
          await db.accounts.put(cogsAcc);
        }

        const entryNumber = await this.allocateSequenceNumberAtomic(
          'JV',
          branch.code || 'BR01',
          terminalCode,
          tenantId
        );
        const journalEntry: JournalEntry = {
          id: storage.generateUUID(),
          entryNumber,
          date: returnDate,
          description: `قيد مرتجع مبيعات ${returnNumber} (أصل ${orig.invoiceNumber}) - ${orig.partyName}`,
          costCenterId: orig.activityId,
          branchId: targetBranchId,
          lines: journalLines,
          status: 'POSTED',
          referenceType: 'INVOICE',
          referenceId: returnInvoiceId,
          isAutoGenerated: true,
        };

        const accountsByCode = await this.getAccountsByCodeMap();
        validateJournalEntryInput({ entry: journalEntry, accountsByCode });

        if (advTx) {
          advTx.journalEntryId = journalEntry.id;
          await db.partyAdvanceTransactions.put(advTx);
        }

        const returnInvoice: Invoice = {
          id: returnInvoiceId,
          invoiceNumber: returnNumber,
          type: 'RETURN_SALE',
          activityId: orig.activityId,
          branchId: targetBranchId,
          partyId: orig.partyId,
          partyName: orig.partyName,
          date: returnDate,
          items: returnItems,
          subtotal: returnTotal,
          discount: 0,
          tax: 0,
          total: returnTotal,
          paidAmount: cashRefund,
          advanceAppliedAmount: advanceCredited,
          paymentMethod: cashRefund > 0 ? 'CASH' : 'CREDIT',
          cashBoxId: targetCashBox?.id || orig.cashBoxId || '',
          notes: `مرتجع للفاتورة ${orig.invoiceNumber} — ${cleanReason}`,
          originalInvoiceId: orig.id,
          originalInvoiceNumber: orig.invoiceNumber,
          returnReason: cleanReason,
          journalEntryId: journalEntry.id,
          isPosted: true,
          status: 'POSTED',
          totalCogs: restoredCogs,
          stockDeductionsRecorded: restoredDeductions,
        };

        await db.journalEntries.put(journalEntry);
        await db.invoices.put(returnInvoice);

        const idemKey = params.clientRequestId
          ? `REQ_${tenantId}_${params.clientRequestId}`
          : `${tenantId}_INVOICE_${returnInvoice.id}_CREATE`;

        await db.outbox.put({
          id: storage.generateUUID(),
          tenantId,
          branchId: targetBranchId,
          entityType: 'INVOICE',
          entityId: returnInvoice.id,
          action: 'CREATE',
          payload: returnInvoice as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 3,
          dependsOn: [orig.id],
          createdAt: nowIso,
          idempotencyKey: idemKey,
        });
        await db.outbox.put({
          id: storage.generateUUID(),
          tenantId,
          branchId: targetBranchId,
          entityType: 'JOURNAL_ENTRY',
          entityId: journalEntry.id,
          action: 'CREATE',
          payload: journalEntry as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 4,
          dependsOn: [returnInvoice.id],
          createdAt: nowIso,
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${journalEntry.id}_CREATE`,
        });
        if (advTx) {
          await db.outbox.put({
            id: storage.generateUUID(),
            tenantId,
            branchId: targetBranchId,
            entityType: 'PARTY_ADVANCE',
            entityId: advTx.id,
            action: 'CREATE',
            payload: advTx as unknown as Record<string, unknown>,
            status: 'PENDING',
            retryCount: 0,
            priority: 4,
            dependsOn: [returnInvoice.id],
            createdAt: nowIso,
            idempotencyKey: `${tenantId}_PARTY_ADVANCE_${advTx.id}_CREATE`,
          });
        }

        await db.auditLogs.put({
          id: storage.generateUUID(),
          timestamp: nowIso,
          userId: actor.id,
          userName: actor.fullName,
          tenantId,
          branchId: targetBranchId,
          action: 'إصدار مرتجع مبيعات ذري',
          details: `مرتجع ${returnNumber} على الفاتورة ${orig.invoiceNumber} بقيمة ${returnTotal} ${currencySymbol} (تخفيض ذمة: ${arCredited}، رد نقدي: ${cashRefund}، رصيد مقدم: ${advanceCredited})`,
          entityType: 'INVOICE',
          entityId: returnInvoice.id,
          previousValue: { originalInvoiceId: orig.id, originalInvoiceNumber: orig.invoiceNumber },
          newValue: { total: returnTotal, arCredited, cashRefund, advanceCredited, restoredCogs },
          reason: cleanReason,
          result: 'SUCCESS',
        });

        return { success: true, invoice: returnInvoice, journalEntry };
      }
    );
  }

  public async createPurchaseReturnAtomic(params: {
    originalInvoiceId: string;
    items: Array<{ productId: string; quantity: number; batchNumber?: string }>;
    returnReason: string;
    refundMethod: 'AUTO' | 'AP_OFFSET' | 'CASH' | 'ADVANCE';
    cashBoxId?: string;
    date?: string;
    clientRequestId?: string;
  }): Promise<{ success: boolean; invoice: Invoice; journalEntry: JournalEntry }> {
    await this.ensureReady();
    const { actor, tenantId } = this.requireAuthorizedActor('purchase:return');
    const cleanReason = params.returnReason?.trim();
    if (!cleanReason) {
      throw new FinancialValidationError('سبب مرتجع المشتريات مطلوب لتوثيق القيد وسجل التدقيق.');
    }
    if (!params.items || params.items.length === 0) {
      throw new FinancialValidationError('يجب تحديد صنف واحد على الأقل لإتمام مرتجع المشتريات.');
    }

    const terminalCode = storage.getTerminalCode();
    const currencySymbol = getActiveCurrencyConfig().symbol;

    return await db.transaction(
      'rw',
      [
        db.invoices,
        db.journalEntries,
        db.products,
        db.cashBoxes,
        db.accounts,
        db.parties,
        db.partyAdvanceTransactions,
        db.outbox,
        db.auditLogs,
        db.sequences,
        db.branches,
      ],
      async () => {
        if (params.clientRequestId) {
          const dupOutbox = await db.outbox
            .where('idempotencyKey')
            .equals(`REQ_${tenantId}_${params.clientRequestId}`)
            .first();
          if (dupOutbox) {
            const dupInv = await db.invoices.get(dupOutbox.entityId);
            if (dupInv && dupInv.journalEntryId) {
              const dupJe = await db.journalEntries.get(dupInv.journalEntryId);
              if (dupJe) {
                return { success: true, invoice: dupInv, journalEntry: dupJe };
              }
            }
          }
        }

        const orig = await db.invoices.get(params.originalInvoiceId);
        if (!orig) {
          throw new FinancialValidationError('فاتورة المشتريات الأصلية غير موجودة.');
        }
        assertActivityAccess(actor, orig.activityId, 'إصدار مرتجع مشتريات');
        if (orig.type !== 'PURCHASE') {
          throw new FinancialValidationError('يمكن إصدار مرتجع مشتريات لفواتير المشتريات (PURCHASE) فقط.');
        }
        if (orig.status === 'REVERSED') {
          throw new FinancialValidationError('لا يمكن عمل مرتجع على فاتورة مشتريات معكوسة.');
        }

        const targetBranchId = orig.branchId?.trim() || '';
        assertBranchAccess(actor, targetBranchId, { requireTarget: true });
        const branch = await db.branches.get(targetBranchId);
        if (!branch) throw new FinancialValidationError('فرع الفاتورة الأصلية غير موجود.');

        const priorReturns = await db.invoices
          .filter(
            (i) =>
              i.type === 'RETURN_PURCHASE' &&
              i.originalInvoiceId === orig.id &&
              i.status !== 'REVERSED'
          )
          .toArray();

        const returnedByProductBatch = new Map<string, number>();
        for (const r of priorReturns) {
          for (const it of r.items || []) {
            const key = `${it.productId}::${it.batchNumber || ''}`;
            returnedByProductBatch.set(
              key,
              roundMoney((returnedByProductBatch.get(key) || 0) + it.quantity, 4)
            );
          }
        }

        const costFactor = orig.subtotal > 0 ? orig.total / orig.subtotal : 1;
        const returnItems: InvoiceItem[] = [];
        let returnTotal = 0;
        let inventoryCostDeducted = 0;

        for (const reqItem of params.items) {
          if (!reqItem.productId || !Number.isFinite(reqItem.quantity) || reqItem.quantity <= 0) {
            throw new FinancialValidationError('كمية الصنف المرتجع يجب أن تكون أكبر من الصفر.');
          }
          const reqQty = roundMoney(reqItem.quantity, 4);
          const matchingOrigLines = (orig.items || []).filter(
            (it) =>
              it.productId === reqItem.productId &&
              (!reqItem.batchNumber || it.batchNumber === reqItem.batchNumber)
          );
          if (matchingOrigLines.length === 0) {
            throw new FinancialValidationError(`الصنف (${reqItem.productId}) غير موجود ضمن بنود فاتورة الشراء الأصلية.`);
          }
          const batchKey = `${reqItem.productId}::${reqItem.batchNumber || matchingOrigLines[0].batchNumber || ''}`;
          const purchasedQty = roundMoney(matchingOrigLines.reduce((s, l) => s + l.quantity, 0), 4);
          const alreadyRet = returnedByProductBatch.get(batchKey) || 0;
          const remainingReturnable = roundMoney(purchasedQty - alreadyRet, 4);
          if (reqQty > remainingReturnable + 0.0001) {
            throw new FinancialValidationError(
              `الكمية المطلوب إرجاعها للمورد من (${matchingOrigLines[0].productName}) تتجاوز الكمية المتاحة (${remainingReturnable}).`
            );
          }
          returnedByProductBatch.set(batchKey, roundMoney(alreadyRet + reqQty, 4));

          const product = await db.products.get(reqItem.productId);
          if (!product) {
            throw new FinancialValidationError(`الصنف (${reqItem.productId}) غير موجود في المستودع.`);
          }
          if (product.batches && product.batches.length > 0) {
            validateProductStockConsistency(product);
          }
          if (product.currentStock + 0.0001 < reqQty) {
            throw new FinancialValidationError(
              `الرصيد المتاح بالمستودع من (${product.nameAr}) هو ${product.currentStock} فقط، ولا يكفي لإرجاع ${reqQty} للمورد.`
            );
          }

          const targetBatchNum = reqItem.batchNumber || matchingOrigLines[0].batchNumber;
          if (targetBatchNum && product.batches && product.batches.length > 0) {
            const batch = product.batches.find((b) => b.batchNumber === targetBatchNum);
            if (!batch) {
              throw new FinancialValidationError(`التشغيلة (${targetBatchNum}) للصنف (${product.nameAr}) غير موجودة.`);
            }
            if (batch.quantity + 0.0001 < reqQty) {
              throw new FinancialValidationError(
                `الكمية المتاحة في التشغيلة (${targetBatchNum}) هي ${batch.quantity} فقط.`
              );
            }
            inventoryCostDeducted = roundMoney(inventoryCostDeducted + reqQty * batch.costPrice);
            batch.quantity = roundMoney(batch.quantity - reqQty, 4);
            product.currentStock = roundMoney(
              product.batches.reduce((s, b) => s + b.quantity, 0),
              4
            );
            const totalVal = product.batches.reduce((s, b) => s + b.quantity * b.costPrice, 0);
            product.purchasePrice =
              product.currentStock > 0
                ? roundMoney(totalVal / product.currentStock, 4)
                : batch.costPrice;
          } else {
            inventoryCostDeducted = roundMoney(inventoryCostDeducted + reqQty * product.purchasePrice);
            product.currentStock = roundMoney(product.currentStock - reqQty, 4);
          }

          validateProductStockConsistency(product);
          await db.products.put(product);

          const avgPurchaseUnit = matchingOrigLines.reduce((s, l) => s + l.total, 0) / purchasedQty;
          const lineReturnVal = roundMoney(reqQty * avgPurchaseUnit * costFactor);
          returnTotal = roundMoney(returnTotal + lineReturnVal);

          returnItems.push({
            id: storage.generateUUID(),
            productId: product.id,
            productName: matchingOrigLines[0].productName || product.nameAr,
            productCode: matchingOrigLines[0].productCode || product.code,
            batchNumber: targetBatchNum,
            unit: matchingOrigLines[0].unit || product.unit,
            quantity: reqQty,
            unitPrice: roundMoney(avgPurchaseUnit * costFactor, 4),
            discount: 0,
            total: lineReturnVal,
          });
        }

        const returnDate = params.date || new Date().toISOString().split('T')[0];
        const supplier = orig.partyId ? await db.parties.get(orig.partyId) : undefined;
        const origOpenRemaining = getInvoiceRemainingAmount(orig);

        let apDebited = 0;
        let cashReceived = 0;
        let advanceCredited = 0;

        if (params.refundMethod === 'AP_OFFSET') {
          if (!supplier || supplier.type !== 'SUPPLIER') {
            throw new FinancialValidationError('تخفيض ذمة المورد متاح للموردين المسجلين فقط.');
          }
          if (toCents(returnTotal) > toCents(origOpenRemaining) + 1) {
            throw new FinancialValidationError(
              `قيمة المرتجع (${returnTotal}) تتجاوز المتبقي المستحق من الفاتورة (${origOpenRemaining})؛ استخدم التسوية التلقائية.`
            );
          }
          apDebited = Math.min(returnTotal, origOpenRemaining);
        } else if (params.refundMethod === 'CASH') {
          if (toCents(origOpenRemaining) > 0 && toCents(returnTotal) > toCents(roundMoney(orig.total - origOpenRemaining)) + 1) {
            throw new FinancialValidationError(
              'الفاتورة تحتوي على مستحقات آجلة للمورد؛ استخدم التسوية التلقائية لتخفيض ذمة المورد أولاً.'
            );
          }
          cashReceived = returnTotal;
        } else if (params.refundMethod === 'ADVANCE') {
          if (!supplier || supplier.type !== 'SUPPLIER') {
            throw new FinancialValidationError('تحويل المرتجع إلى سلفة مورد متاح للموردين المسجلين فقط.');
          }
          if (toCents(origOpenRemaining) > 0 && toCents(returnTotal) > toCents(roundMoney(orig.total - origOpenRemaining)) + 1) {
            throw new FinancialValidationError(
              'الفاتورة تحتوي على مستحقات آجلة للمورد؛ استخدم التسوية التلقائية لتخفيض ذمة المورد أولاً.'
            );
          }
          advanceCredited = returnTotal;
        } else {
          apDebited = supplier ? Math.min(returnTotal, origOpenRemaining) : 0;
          const excess = roundMoney(returnTotal - apDebited);
          if (excess > 0) {
            if (params.cashBoxId || !supplier) {
              cashReceived = excess;
            } else {
              cashReceived = orig.cashBoxId ? excess : 0;
              advanceCredited = cashReceived > 0 ? 0 : excess;
            }
          }
        }

        let targetCashBox: CashBox | undefined;
        if (cashReceived > 0) {
          const reqBoxId = params.cashBoxId || orig.cashBoxId;
          targetCashBox = reqBoxId
            ? await db.cashBoxes.get(reqBoxId)
            : await this.resolveBranchDefaultCashBoxTx(targetBranchId);
          this.assertCashBoxBranchAccess(actor, targetCashBox, targetBranchId);
        }

        const returnNumber = await this.allocateSequenceNumberAtomic(
          'RP',
          branch.code || 'BR01',
          terminalCode,
          tenantId
        );
        const returnInvoiceId = storage.generateUUID();

        const activityInventoryAccounts: Record<CommercialActivityId, string> = {
          pharmacy: '11041',
          grocery: '11042',
          bike_parts: '11043',
          equipment_parts: '11044',
        };
        const activityCogsAccounts: Record<CommercialActivityId, string> = {
          pharmacy: '5101',
          grocery: '5102',
          bike_parts: '5103',
          equipment_parts: '5104',
        };

        const invCode = activityInventoryAccounts[orig.activityId] || '11041';
        const cogsCode = activityCogsAccounts[orig.activityId] || '5101';
        const invAcc = await db.accounts.get(invCode);
        if (!invAcc) throw new FinancialValidationError(`حساب المخزون (${invCode}) غير معرف.`);

        const journalLines: JournalEntryLine[] = [];

        if (apDebited > 0) {
          const apAcc = await db.accounts.get(SPECIAL_ACCOUNTS.SUPPLIERS_AP);
          if (!apAcc) throw new FinancialValidationError('حساب الموردين (2101) غير معرف.');
          journalLines.push({
            id: storage.generateUUID(),
            accountCode: SPECIAL_ACCOUNTS.SUPPLIERS_AP,
            accountName: `${apAcc.nameAr} - ${orig.partyName}`,
            debit: apDebited,
            credit: 0,
            costCenterId: orig.activityId,
            memo: `تخفيض ذمة المورد عن مرتجع مشتريات ${returnNumber}`,
          });
          apAcc.balance = roundMoney(apAcc.balance + accountBalanceDeltaByType(apAcc.type, apDebited, 0));
          await db.accounts.put(apAcc);
          if (supplier) {
            supplier.balance = roundMoney(supplier.balance + apDebited);
          }
          orig.returnedAmount = roundMoney((orig.returnedAmount || 0) + apDebited);
          await db.invoices.put(orig);
        }

        if (cashReceived > 0 && targetCashBox) {
          const boxAcc = await db.accounts.get(targetCashBox.accountCode);
          journalLines.push({
            id: storage.generateUUID(),
            accountCode: targetCashBox.accountCode,
            accountName: boxAcc?.nameAr || targetCashBox.nameAr,
            debit: cashReceived,
            credit: 0,
            costCenterId: orig.activityId,
            memo: `استرداد نقدي من المورد عن مرتجع مشتريات ${returnNumber}`,
          });
          targetCashBox.balance = roundMoney(targetCashBox.balance + cashReceived);
          await db.cashBoxes.put(targetCashBox);
          if (boxAcc) {
            boxAcc.balance = roundMoney(boxAcc.balance + accountBalanceDeltaByType(boxAcc.type, cashReceived, 0));
            await db.accounts.put(boxAcc);
          }
        }

        let advTx: PartyAdvanceTransaction | undefined;
        const nowIso = new Date().toISOString();
        if (advanceCredited > 0 && supplier) {
          const supAdvAcc = await this.ensureCanonicalAccountTx(SPECIAL_ACCOUNTS.SUPPLIER_ADVANCES);
          if (!supAdvAcc) throw new FinancialValidationError('حساب سلف الموردين (1105) غير معرف.');
          journalLines.push({
            id: storage.generateUUID(),
            accountCode: SPECIAL_ACCOUNTS.SUPPLIER_ADVANCES,
            accountName: supAdvAcc.nameAr,
            debit: advanceCredited,
            credit: 0,
            costCenterId: orig.activityId,
            memo: `إثبات رصيد سلفة لدى المورد عن مرتجع مشتريات ${returnNumber}`,
          });
          supAdvAcc.balance = roundMoney(
            supAdvAcc.balance + accountBalanceDeltaByType(supAdvAcc.type, advanceCredited, 0)
          );
          await db.accounts.put(supAdvAcc);
          const nextAdvBal = roundMoney((supplier.advanceBalance || 0) + advanceCredited);
          supplier.advanceBalance = nextAdvBal;
          advTx = {
            id: storage.generateUUID(),
            tenantId,
            branchId: targetBranchId,
            partyId: supplier.id,
            partyType: 'SUPPLIER',
            type: 'PREPAYMENT_DEPOSIT',
            amount: advanceCredited,
            balanceAfter: nextAdvBal,
            invoiceId: returnInvoiceId,
            date: returnDate,
            description: `سلفة مورد ناتجة عن مرتجع مشتريات ${returnNumber} (أصل ${orig.invoiceNumber})`,
            createdBy: actor.id,
            createdAt: nowIso,
          };
        }

        if (supplier && (apDebited > 0 || advanceCredited > 0)) {
          await db.parties.put(supplier);
        }

        // دائن: المخزون بقيمة التكلفة المخزنية المخصومة (Perpetual Inventory)
        journalLines.push({
          id: storage.generateUUID(),
          accountCode: invCode,
          accountName: invAcc.nameAr,
          debit: 0,
          credit: inventoryCostDeducted,
          costCenterId: orig.activityId,
          memo: `صرف مرتجع مشتريات من المخزون ${returnNumber}`,
        });
        invAcc.balance = roundMoney(
          invAcc.balance + accountBalanceDeltaByType(invAcc.type, 0, inventoryCostDeducted)
        );
        await db.accounts.put(invAcc);

        // تسوية أي فرق طفيف بين متوسط تكلفة المخزون وسعر فاتورة الشراء الأصلية على حساب تكلفة المبيعات
        const costVariance = roundMoney(returnTotal - inventoryCostDeducted);
        if (Math.abs(costVariance) > 0.009) {
          const cogsAcc = await db.accounts.get(cogsCode);
          if (!cogsAcc) throw new FinancialValidationError(`حساب تكلفة المبيعات (${cogsCode}) غير معرف.`);
          if (costVariance > 0) {
            journalLines.push({
              id: storage.generateUUID(),
              accountCode: cogsCode,
              accountName: cogsAcc.nameAr,
              debit: 0,
              credit: costVariance,
              costCenterId: orig.activityId,
              memo: `تسوية فرق تكلفة مرتجع مشتريات ${returnNumber}`,
            });
            cogsAcc.balance = roundMoney(
              cogsAcc.balance + accountBalanceDeltaByType(cogsAcc.type, 0, costVariance)
            );
          } else {
            const absVar = Math.abs(costVariance);
            journalLines.push({
              id: storage.generateUUID(),
              accountCode: cogsCode,
              accountName: cogsAcc.nameAr,
              debit: absVar,
              credit: 0,
              costCenterId: orig.activityId,
              memo: `تسوية فرق تكلفة مرتجع مشتريات ${returnNumber}`,
            });
            cogsAcc.balance = roundMoney(
              cogsAcc.balance + accountBalanceDeltaByType(cogsAcc.type, absVar, 0)
            );
          }
          await db.accounts.put(cogsAcc);
        }

        const entryNumber = await this.allocateSequenceNumberAtomic(
          'JV',
          branch.code || 'BR01',
          terminalCode,
          tenantId
        );
        const journalEntry: JournalEntry = {
          id: storage.generateUUID(),
          entryNumber,
          date: returnDate,
          description: `قيد مرتجع مشتريات ${returnNumber} (أصل ${orig.invoiceNumber}) - ${orig.partyName}`,
          costCenterId: orig.activityId,
          branchId: targetBranchId,
          lines: journalLines,
          status: 'POSTED',
          referenceType: 'INVOICE',
          referenceId: returnInvoiceId,
          isAutoGenerated: true,
        };

        const accountsByCode = await this.getAccountsByCodeMap();
        validateJournalEntryInput({ entry: journalEntry, accountsByCode });

        if (advTx) {
          advTx.journalEntryId = journalEntry.id;
          await db.partyAdvanceTransactions.put(advTx);
        }

        const returnInvoice: Invoice = {
          id: returnInvoiceId,
          invoiceNumber: returnNumber,
          type: 'RETURN_PURCHASE',
          activityId: orig.activityId,
          branchId: targetBranchId,
          partyId: orig.partyId,
          partyName: orig.partyName,
          date: returnDate,
          items: returnItems,
          subtotal: returnTotal,
          discount: 0,
          tax: 0,
          total: returnTotal,
          paidAmount: cashReceived,
          advanceAppliedAmount: advanceCredited,
          paymentMethod: cashReceived > 0 ? 'CASH' : 'CREDIT',
          cashBoxId: targetCashBox?.id || orig.cashBoxId || '',
          notes: `مرتجع مشتريات للفاتورة ${orig.invoiceNumber} — ${cleanReason}`,
          originalInvoiceId: orig.id,
          originalInvoiceNumber: orig.invoiceNumber,
          returnReason: cleanReason,
          journalEntryId: journalEntry.id,
          isPosted: true,
          status: 'POSTED',
          totalCogs: inventoryCostDeducted,
        };

        await db.journalEntries.put(journalEntry);
        await db.invoices.put(returnInvoice);

        const idemKey = params.clientRequestId
          ? `REQ_${tenantId}_${params.clientRequestId}`
          : `${tenantId}_INVOICE_${returnInvoice.id}_CREATE`;

        await db.outbox.put({
          id: storage.generateUUID(),
          tenantId,
          branchId: targetBranchId,
          entityType: 'INVOICE',
          entityId: returnInvoice.id,
          action: 'CREATE',
          payload: returnInvoice as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 3,
          dependsOn: [orig.id],
          createdAt: nowIso,
          idempotencyKey: idemKey,
        });
        await db.outbox.put({
          id: storage.generateUUID(),
          tenantId,
          branchId: targetBranchId,
          entityType: 'JOURNAL_ENTRY',
          entityId: journalEntry.id,
          action: 'CREATE',
          payload: journalEntry as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 4,
          dependsOn: [returnInvoice.id],
          createdAt: nowIso,
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${journalEntry.id}_CREATE`,
        });
        if (advTx) {
          await db.outbox.put({
            id: storage.generateUUID(),
            tenantId,
            branchId: targetBranchId,
            entityType: 'PARTY_ADVANCE',
            entityId: advTx.id,
            action: 'CREATE',
            payload: advTx as unknown as Record<string, unknown>,
            status: 'PENDING',
            retryCount: 0,
            priority: 4,
            dependsOn: [returnInvoice.id],
            createdAt: nowIso,
            idempotencyKey: `${tenantId}_PARTY_ADVANCE_${advTx.id}_CREATE`,
          });
        }

        await db.auditLogs.put({
          id: storage.generateUUID(),
          timestamp: nowIso,
          userId: actor.id,
          userName: actor.fullName,
          tenantId,
          branchId: targetBranchId,
          action: 'إصدار مرتجع مشتريات ذري',
          details: `مرتجع ${returnNumber} على الفاتورة ${orig.invoiceNumber} بقيمة ${returnTotal} ${currencySymbol} (تخفيض ذمة: ${apDebited}، استرداد نقدي: ${cashReceived}، سلفة مورد: ${advanceCredited})`,
          entityType: 'INVOICE',
          entityId: returnInvoice.id,
          previousValue: { originalInvoiceId: orig.id, originalInvoiceNumber: orig.invoiceNumber },
          newValue: { total: returnTotal, apDebited, cashReceived, advanceCredited, inventoryCostDeducted },
          reason: cleanReason,
          result: 'SUCCESS',
        });

        return { success: true, invoice: returnInvoice, journalEntry };
      }
    );
  }

  public async createJournalEntryAtomic(entry: JournalEntry): Promise<JournalEntry> {
    await this.ensureReady();
    const { actor, tenantId, branchId } = this.requireAuthorizedActor(
      'journal:post',
      entry.branchId
    );
    const activeBranch = (await db.branches.get(branchId)) || (await this.getActiveBranch());
    const terminalCode = storage.getTerminalCode();

    return await db.transaction(
      'rw',
      [db.journalEntries, db.accounts, db.cashBoxes, db.outbox, db.auditLogs, db.sequences],
      async () => {
        const accountsByCode = await this.getAccountsByCodeMap();
        validateJournalEntryInput({ entry, accountsByCode });

        if (!entry.id) entry.id = storage.generateUUID();
        if (!entry.entryNumber || !entry.entryNumber.trim()) {
          entry.entryNumber = await this.allocateSequenceNumberAtomic(
            'JV',
            activeBranch.code || 'BR01',
            terminalCode,
            tenantId
          );
        }

        const resolvedLines: JournalEntryLine[] = [];
        for (const rawLine of entry.lines) {
          const acc = await db.accounts.get(rawLine.accountCode);
          if (acc) {
            const delta = accountBalanceDeltaByType(acc.type, Number(rawLine.debit) || 0, Number(rawLine.credit) || 0);
            acc.balance = roundMoney(acc.balance + delta);
            await db.accounts.put(acc);
          }

          const linkedBoxes = await db.cashBoxes.where('accountCode').equals(rawLine.accountCode).toArray();
          const requestedCashBoxId = rawLine.cashBoxId?.trim();
          let resolvedCashBoxId = requestedCashBoxId || undefined;

          if (requestedCashBoxId || linkedBoxes.length > 0) {
            let targetBox = requestedCashBoxId
              ? await db.cashBoxes.get(requestedCashBoxId)
              : undefined;

            if (requestedCashBoxId) {
              if (!targetBox) {
                throw new FinancialValidationError(`الصندوق المحدد (${requestedCashBoxId}) في سطر القيد غير موجود.`);
              }
              if (targetBox.accountCode !== rawLine.accountCode) {
                throw new FinancialValidationError(
                  `الصندوق (${targetBox.nameAr}) مرتبط بالحساب ${targetBox.accountCode} وليس بالحساب ${rawLine.accountCode}.`
                );
              }
              this.assertCashBoxBranchAccess(actor, targetBox, branchId);
            } else {
              const branchBoxes = linkedBoxes.filter((box) => box.branchId === branchId || box.isCentral);
              if (branchBoxes.length !== 1) {
                throw new FinancialValidationError(
                  `يرجى تحديد الصندوق الفعلي في سطر الحساب النقدي (${rawLine.accountCode})؛ يتطلب القيد النقدي تحديد صندوق واحد صريح.`
                );
              }
              targetBox = branchBoxes[0];
              this.assertCashBoxBranchAccess(actor, targetBox, branchId);
              resolvedCashBoxId = targetBox.id;
            }

            const cashFlowDelta = roundMoney((Number(rawLine.debit) || 0) - (Number(rawLine.credit) || 0));
            const nextCashBalance = roundMoney(targetBox.balance + cashFlowDelta);
            if (nextCashBalance < -0.001) {
              throw new FinancialValidationError(
                `رصيد الصندوق (${targetBox.nameAr}) غير كافٍ لإتمام القيد؛ الرصيد الحالي ${targetBox.balance}.`
              );
            }
            targetBox.balance = Math.max(0, nextCashBalance);
            await db.cashBoxes.put(targetBox);
          }

          resolvedLines.push({
            ...rawLine,
            ...(resolvedCashBoxId ? { cashBoxId: resolvedCashBoxId } : {}),
          });
        }

        const persistedEntry: JournalEntry = {
          ...entry,
          branchId,
          lines: resolvedLines,
          status: 'POSTED',
        };

        await db.journalEntries.put(persistedEntry);

        await db.outbox.put({
          id: storage.generateUUID(),
          tenantId,
          branchId,
          entityType: 'JOURNAL_ENTRY',
          entityId: persistedEntry.id,
          action: 'CREATE',
          payload: persistedEntry as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 1,
          createdAt: new Date().toISOString(),
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${persistedEntry.id}_CREATE`,
        });

        await db.auditLogs.put({
          id: storage.generateUUID(),
          timestamp: new Date().toISOString(),
          userId: actor.id,
          userName: actor.fullName,
          tenantId,
          branchId,
          action: 'ترحيل قيد يومية',
          details: `قيد رقم ${persistedEntry.entryNumber}: ${persistedEntry.description}`,
        });

        return persistedEntry;
      }
    );
  }

  public async reverseJournalEntryAtomic(
    originalEntryId: string,
    reversalReason: string
  ): Promise<JournalEntry> {
    await this.ensureReady();
    const { actor, tenantId, branchId } = this.requireAuthorizedActor('journal:reverse');
    const terminalCode = storage.getTerminalCode();

    if (!reversalReason || !reversalReason.trim()) {
      throw new FinancialValidationError('سبب القيد العكسي مطلوب لتوثيق مسار التدقيق.');
    }

    return await db.transaction(
      'rw',
      [db.journalEntries, db.accounts, db.cashBoxes, db.outbox, db.auditLogs, db.sequences, db.branches],
      async () => {
        const original = await db.journalEntries.get(originalEntryId);
        if (!original) {
          throw new FinancialValidationError('القيد الأصلي غير موجود.');
        }
        if (original.status === 'REVERSED') {
          throw new FinancialValidationError('تم عكس هذا القيد مسبقاً.');
        }
        const originalBranchId = original.branchId?.trim();
        assertBranchAccess(actor, originalBranchId || '', { requireTarget: true });
        if (!originalBranchId) throw new FinancialValidationError('القيد الأصلي غير مربوط بفرع؛ لا يمكن عكسه بأمان.');
        const originalBranch = await db.branches.get(originalBranchId);
        if (!originalBranch) throw new FinancialValidationError('فرع القيد الأصلي غير موجود.');
        if (original.isAutoGenerated || (original.referenceType && original.referenceType !== 'MANUAL')) {
          throw new FinancialValidationError(
            'لا يمكن عكس قيد ناتج عن فاتورة أو سند أو أمانة من شاشة القيود؛ اعكس المستند الأصلي من وحدته حتى تُعكس آثاره على المخزون والصندوق والأرصدة معاً.'
          );
        }

        const reversalNumber = await this.allocateSequenceNumberAtomic(
          'REV',
          originalBranch.code || 'BR01',
          terminalCode,
          tenantId
        );
        const reversalId = storage.generateUUID();

        original.status = 'REVERSED';
        original.reversalReason = reversalReason.trim();
        original.reversedEntryId = reversalId;
        await db.journalEntries.put(original);

        const reversedLines: JournalEntryLine[] = original.lines.map((l) => ({
          id: storage.generateUUID(),
          accountCode: l.accountCode,
          accountName: l.accountName,
          debit: roundMoney(l.credit),
          credit: roundMoney(l.debit),
          costCenterId: l.costCenterId,
          ...(l.cashBoxId ? { cashBoxId: l.cashBoxId } : {}),
          memo: `عكس لقيد ${original.entryNumber}: ${reversalReason}`,
        }));

        const reversalEntry: JournalEntry = {
          id: reversalId,
          entryNumber: reversalNumber,
          date: new Date().toISOString().split('T')[0],
          description: `قيد عكسي لتصحيح القيد ${original.entryNumber} - السبب: ${reversalReason}`,
          costCenterId: original.costCenterId,
          branchId: originalBranchId,
          lines: reversedLines,
          status: 'POSTED',
          referenceType: original.referenceType,
          referenceId: original.referenceId,
          isAutoGenerated: true,
          reversedEntryId: original.id,
          reversalReason: reversalReason.trim(),
        };

        const accountsByCode = await this.getAccountsByCodeMap();
        validateJournalEntryInput({ entry: reversalEntry, accountsByCode });

        for (const line of reversedLines) {
          const acc = await db.accounts.get(line.accountCode);
          const cashFlowDelta = roundMoney((Number(line.debit) || 0) - (Number(line.credit) || 0));
          if (acc) {
            const glDelta = accountBalanceDeltaByType(acc.type, Number(line.debit) || 0, Number(line.credit) || 0);
            acc.balance = roundMoney(acc.balance + glDelta);
            await db.accounts.put(acc);
          }

          const linkedBoxes = await db.cashBoxes.where('accountCode').equals(line.accountCode).toArray();
          const requestedCashBoxId = line.cashBoxId?.trim();
          if (requestedCashBoxId || linkedBoxes.length > 0) {
            let linkedBox = requestedCashBoxId
              ? await db.cashBoxes.get(requestedCashBoxId)
              : undefined;
            if (requestedCashBoxId) {
              if (!linkedBox) {
                throw new FinancialValidationError(`الصندوق المرتبط بالقيد الأصلي (${requestedCashBoxId}) غير موجود.`);
              }
              this.assertCashBoxBranchAccess(actor, linkedBox, originalBranchId);
            } else {
              const branchBoxes = linkedBoxes.filter((box) => box.branchId === originalBranchId || box.isCentral);
              if (branchBoxes.length !== 1) {
                throw new FinancialValidationError(
                  `لا يمكن عكس القيد بأمان: حساب الصندوق (${line.accountCode}) لا يرتبط بصندوق واحد محدد في الفرع الأصلي.`
                );
              }
              linkedBox = branchBoxes[0];
              if (linkedBox.isCentral) assertPermission(actor, 'cashbox:central_access');
              line.cashBoxId = linkedBox.id;
            }

            const nextCashBalance = roundMoney(linkedBox.balance + cashFlowDelta);
            if (nextCashBalance < -0.001) {
              throw new FinancialValidationError(
                `سيؤدي عكس القيد إلى جعل رصيد الصندوق (${linkedBox.nameAr}) سالباً؛ أُلغيت العملية بالكامل.`
              );
            }
            linkedBox.balance = Math.max(0, nextCashBalance);
            await db.cashBoxes.put(linkedBox);
          }
        }

        await db.journalEntries.put(reversalEntry);

        await db.outbox.put({
          id: storage.generateUUID(),
          tenantId,
          branchId: reversalEntry.branchId,
          entityType: 'JOURNAL_ENTRY',
          entityId: reversalEntry.id,
          action: 'CREATE',
          payload: reversalEntry as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 1,
          createdAt: new Date().toISOString(),
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${reversalEntry.id}_CREATE`,
        });

        await db.outbox.put({
          id: storage.generateUUID(),
          tenantId,
          branchId: originalBranchId,
          entityType: 'JOURNAL_ENTRY',
          entityId: original.id,
          action: 'UPDATE',
          payload: original as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 1,
          createdAt: new Date().toISOString(),
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${original.id}_REVERSED`,
        });

        await db.auditLogs.put({
          id: storage.generateUUID(),
          timestamp: new Date().toISOString(),
          userId: actor.id,
          userName: actor.fullName,
          tenantId,
          branchId: originalBranchId,
          action: 'عكس قيد محاسبي',
          details: `إنشاء القيد العكسي ${reversalNumber} لتصحيح ${original.entryNumber}`,
        });

        return reversalEntry;
      }
    );
  }
}

export const dexieDataService = new DexieDataService();
