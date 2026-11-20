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
  Account,
  Product,
  Party,
  Invoice,
  JournalEntry,
  JournalEntryLine,
  CashBox,
  PaymentVoucher,
  AmanatRecord,
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
  assertBranchAccess,
  assertPermission,
  filterAuditLogsForUser,
  filterRecordsByBranchScope,
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

  private async getValidAccountCodesSet(): Promise<Set<string>> {
    const accounts = await db.accounts.toArray();
    return new Set(accounts.map((a) => a.code));
  }

  /**
   * توليد رقم تسلسلي ذري مضمون التفرد عبر جدول sequences (FIN-01)
   * يجب استدعاؤها من داخل معاملة Dexie تشمل db.sequences
   */
  private async allocateSequenceNumberAtomic(
    type: 'INV' | 'PUR' | 'RCT' | 'PAY' | 'JV' | 'REV' | 'AMN',
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
      if (type === 'JV' || type === 'REV') {
        const prefix = `${type}-${year}-`;
        const jvMatches = await db.journalEntries
          .filter((j) => Boolean(j.entryNumber && j.entryNumber.startsWith(prefix)))
          .count();
        baseline = Math.max(baseline, jvMatches);
      } else if (type === 'INV' || type === 'PUR') {
        const prefix = `${type}-${normalizedBranch}-${normalizedTerminal}-${year}-`;
        const invMatches = await db.invoices
          .filter((i) => Boolean(i.invoiceNumber && i.invoiceNumber.startsWith(prefix)))
          .count();
        baseline = Math.max(baseline, invMatches);
      } else if (type === 'RCT' || type === 'PAY') {
        const prefix = `${type}-${normalizedBranch}-${normalizedTerminal}-${year}-`;
        const vMatches = await db.vouchers
          .filter((v) => Boolean(v.voucherNumber && v.voucherNumber.startsWith(prefix)))
          .count();
        baseline = Math.max(baseline, vMatches);
      } else if (type === 'AMN') {
        const prefix = `AMN-${year}-`;
        const amnMatches = await db.amanatRecords
          .filter((a) => Boolean(a.recordNumber && a.recordNumber.startsWith(prefix)))
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
    if (type === 'JV' || type === 'REV' || type === 'AMN') {
      return `${type}-${year}-${padded}`;
    }
    return `${type}-${normalizedBranch}-${normalizedTerminal}-${year}-${padded}`;
  }

  // --- الفروع ونقاط البيع (Multi-Branch System) ---
  public async getBranches(): Promise<Branch[]> {
    await this.ensureReady();
    return await db.branches.toArray();
  }

  public async getBranch(id: string): Promise<Branch | undefined> {
    await this.ensureReady();
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
    const actor = authService.getCurrentActorSync();
    if (actor) {
      assertBranchAccess(actor, branchId);
    }
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
    const { actor, tenantId } = this.requireAuthorizedActor('branches:manage');

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
    type: 'INV' | 'PUR',
    branchCode?: string,
    terminalCode?: string
  ): Promise<string> {
    await this.ensureReady();
    const tenantId = syncQueueService.getCurrentTenantId(false);
    const activeBranch = await this.getActiveBranch();
    const bCode = branchCode || activeBranch.code || 'BR01';
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
    const tenantId = syncQueueService.getCurrentTenantId(false);
    const activeBranch = await this.getActiveBranch();
    const bCode = branchCode || activeBranch.code || 'BR01';
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

  // --- الدليل المحاسبي ---
  public async getAccounts(): Promise<Account[]> {
    await this.ensureReady();
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
    if (activityId) {
      return await db.products.where('activityId').equals(activityId).toArray();
    }
    return await db.products.toArray();
  }

  public async getProductById(id: string): Promise<Product | undefined> {
    await this.ensureReady();
    this.requireAuthorizedActor('inventory:view');
    return await db.products.get(id);
  }

  public async saveProductAtomic(product: Product, isUpdate = false): Promise<Product> {
    await this.ensureReady();
    const { actor, tenantId, branchId } = this.requireAuthorizedActor('inventory:write');

    if (!product.id) product.id = storage.generateUUID();
    if (product.batches && product.batches.length > 0 && product.currentStock === 0) {
      product.currentStock = roundMoney(
        product.batches.reduce((s, b) => s + (Number(b.quantity) || 0), 0),
        4
      );
    }
    validateProductStockConsistency(product);

    return await db.transaction('rw', [db.products, db.outbox, db.auditLogs], async () => {
      await db.products.put(product);
      await syncQueueService.enqueue({
        tenantId,
        branchId,
        entityType: 'PRODUCT',
        entityId: product.id,
        action: isUpdate ? 'UPDATE' : 'CREATE',
        payload: product as unknown as Record<string, unknown>,
      });
      await db.auditLogs.put({
        id: storage.generateUUID(),
        timestamp: new Date().toISOString(),
        userId: actor.id,
        userName: actor.fullName,
        tenantId,
        branchId,
        action: isUpdate ? 'تعديل صنف' : 'إضافة صنف',
        details: `${isUpdate ? 'تحديث' : 'إضافة'} الصنف ${product.nameAr} بكود ${product.code}`,
      });
      return product;
    });
  }

  /**
   * تسوية جردية ذرية تحافظ على تطابق مجموع التشغيلات مع رصيد الصنف الإجمالي (INV-07)
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

    return await db.transaction('rw', [db.products, db.outbox, db.auditLogs], async () => {
      const product = await db.products.get(productId);
      if (!product) {
        throw new FinancialValidationError(`الصنف ذو المعرف ${productId} غير موجود.`);
      }

      const hasBatches = Boolean(product.batches && product.batches.length > 0);
      if (hasBatches) {
        validateProductStockConsistency(product);
      }

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
          } else {
            product.batches.push({
              id: storage.generateUUID(),
              productId: product.id,
              batchNumber: batchNumber.trim(),
              expiryDate: expiryDate.trim(),
              quantity: deltaQuantity,
              costPrice: product.purchasePrice,
            });
          }
          product.currentStock = roundMoney(
            product.batches.reduce((s, b) => s + b.quantity, 0),
            4
          );
        } else {
          product.currentStock = roundMoney(product.currentStock + deltaQuantity, 4);
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
      await db.auditLogs.put({
        id: storage.generateUUID(),
        timestamp: new Date().toISOString(),
        userId: actor.id,
        userName: actor.fullName,
        tenantId,
        branchId,
        action: 'تسوية مخزنية ذرية',
        details: `صنف ${product.nameAr}: تعديل (${deltaQuantity > 0 ? '+' : ''}${deltaQuantity})، السبب: ${reason}`,
      });
      return product;
    });
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

    await db.transaction('rw', [db.products, db.outbox, db.auditLogs], async () => {
      const existing = await db.products.get(productId);
      if (!existing) return;
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
        timestamp: new Date().toISOString(),
        userId: actor.id,
        userName: actor.fullName,
        tenantId,
        branchId,
        action: 'حذف صنف',
        details: `تم حذف الصنف ${existing.nameAr} (${productId})`,
      });
    });
  }

  public async deleteProduct(productId: string): Promise<void> {
    await this.deleteProductAtomic(productId);
  }

  // --- العملاء والموردون ---
  public async getParties(type?: 'CUSTOMER' | 'SUPPLIER'): Promise<Party[]> {
    await this.ensureReady();
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
    const { actor, tenantId, branchId } = this.requireAuthorizedActor('party:write');

    if (!party.id) party.id = storage.generateUUID();
    if (!party.nameAr || !party.nameAr.trim()) {
      throw new FinancialValidationError('اسم العميل أو المورد مطلوب.');
    }

    return await db.transaction('rw', [db.parties, db.outbox, db.auditLogs], async () => {
      await db.parties.put(party);
      await syncQueueService.enqueue({
        tenantId,
        branchId,
        entityType: 'PARTY',
        entityId: party.id,
        action: isUpdate ? 'UPDATE' : 'CREATE',
        payload: party as unknown as Record<string, unknown>,
      });
      await db.auditLogs.put({
        id: storage.generateUUID(),
        timestamp: new Date().toISOString(),
        userId: actor.id,
        userName: actor.fullName,
        tenantId,
        branchId,
        action: `${isUpdate ? 'تعديل' : 'إضافة'} ${party.type === 'CUSTOMER' ? 'عميل' : 'مورد'}`,
        details: `الطرف: ${party.nameAr}`,
      });
      return party;
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
    const rows = activityId
      ? await db.invoices.where('activityId').equals(activityId).reverse().sortBy('date')
      : await db.invoices.toCollection().reverse().sortBy('date');
    return filterRecordsByBranchScope(rows, actor);
  }

  public async getInvoiceById(id: string): Promise<Invoice | undefined> {
    await this.ensureReady();
    const { actor } = this.requireAuthorizedActor('invoices:view');
    const invoice = await db.invoices.get(id);
    if (!invoice) return undefined;
    return filterRecordsByBranchScope([invoice], actor)[0];
  }

  public async addInvoice(invoice: Invoice): Promise<void> {
    await this.ensureReady();
    const { actor, tenantId, branchId } = this.requireAuthorizedActor('pos:sale', invoice.branchId);
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
    this.requireAuthorizedActor('journal:post');
    await db.transaction('rw', db.cashBoxes, async () => {
      const box = await db.cashBoxes.get(id);
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

  // --- السندات الذرية (FIN-02) ---
  public async getVouchers(): Promise<PaymentVoucher[]> {
    await this.ensureReady();
    const { actor } = this.requireAuthorizedActor('vouchers:view');
    return filterRecordsByBranchScope(await db.vouchers.toCollection().reverse().sortBy('date'), actor);
  }

  public async createCashVoucherAtomic(params: {
    voucher: PaymentVoucher;
  }): Promise<{ success: boolean; voucher: PaymentVoucher; journalEntry: JournalEntry }> {
    await this.ensureReady();
    const { voucher } = params;
    const perm: Permission = voucher.type === 'RECEIPT' ? 'voucher:receipt' : 'voucher:payment';
    const { actor, tenantId, branchId } = this.requireAuthorizedActor(perm, voucher.branchId);

    const activeBranch = (await db.branches.get(branchId)) || (await this.getActiveBranch());
    const terminalCode = storage.getTerminalCode();
    const currencySymbol = getActiveCurrencyConfig().symbol;

    return await db.transaction(
      'rw',
      [db.vouchers, db.journalEntries, db.cashBoxes, db.accounts, db.parties, db.outbox, db.auditLogs, db.sequences],
      async () => {
        if (!voucher.id) voucher.id = storage.generateUUID();

        // منع التكرار Idempotency
        const existingVoucher = await db.vouchers.get(voucher.id);
        if (existingVoucher && existingVoucher.journalEntryId) {
          const existingJe = await db.journalEntries.get(existingVoucher.journalEntryId);
          if (existingJe) {
            return { success: true, voucher: existingVoucher, journalEntry: existingJe };
          }
        }

        const cashBox = await db.cashBoxes.get(voucher.cashBoxId);
        const targetAccount = await db.accounts.get(voucher.accountCode);

        validateVoucherInput({
          voucher,
          cashBox,
          accountExists: Boolean(targetAccount),
        });

        // تعيين رقم سند فريد ذرياً إذا لم يُحدد أو عند التعارض
        if (!voucher.voucherNumber || !voucher.voucherNumber.trim()) {
          voucher.voucherNumber = await this.allocateSequenceNumberAtomic(
            voucher.type === 'RECEIPT' ? 'RCT' : 'PAY',
            activeBranch.code || 'BR01',
            terminalCode,
            tenantId
          );
        }

        const amount = roundMoney(voucher.amount);
        const cashBoxAccount = cashBox!.accountCode;
        const cashBoxAccountRow = await db.accounts.get(cashBoxAccount);
        const voucherDate = voucher.date || new Date().toISOString().split('T')[0];

        const lines: JournalEntryLine[] =
          voucher.type === 'RECEIPT'
            ? [
                {
                  id: storage.generateUUID(),
                  accountCode: cashBoxAccount,
                  accountName: cashBoxAccountRow?.nameAr || cashBox!.nameAr,
                  debit: amount,
                  credit: 0,
                  costCenterId: voucher.costCenterId,
                  memo: `سند قبض ${voucher.voucherNumber} - ${voucher.description}`,
                },
                {
                  id: storage.generateUUID(),
                  accountCode: voucher.accountCode,
                  accountName: targetAccount!.nameAr,
                  debit: 0,
                  credit: amount,
                  costCenterId: voucher.costCenterId,
                  memo: voucher.description,
                },
              ]
            : [
                {
                  id: storage.generateUUID(),
                  accountCode: voucher.accountCode,
                  accountName: targetAccount!.nameAr,
                  debit: amount,
                  credit: 0,
                  costCenterId: voucher.costCenterId,
                  memo: voucher.description,
                },
                {
                  id: storage.generateUUID(),
                  accountCode: cashBoxAccount,
                  accountName: cashBoxAccountRow?.nameAr || cashBox!.nameAr,
                  debit: 0,
                  credit: amount,
                  costCenterId: voucher.costCenterId,
                  memo: `سند صرف ${voucher.voucherNumber} - ${voucher.description}`,
                },
              ];

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
          description: `${voucher.type === 'RECEIPT' ? 'سند قبض' : 'سند صرف'} ${voucher.voucherNumber}: ${voucher.partyName || ''} - ${voucher.description}`,
          costCenterId: voucher.costCenterId,
          branchId,
          lines,
          status: 'POSTED',
          referenceType: 'VOUCHER',
          referenceId: voucher.id,
          isAutoGenerated: true,
        };

        const validCodes = await this.getValidAccountCodesSet();
        validateJournalEntryInput({ entry: journalEntry, validAccountCodes: validCodes });

        // تحديث الصندوق والحسابات والذمة
        const cashDelta = voucher.type === 'RECEIPT' ? amount : -amount;
        cashBox!.balance = roundMoney(cashBox!.balance + cashDelta);
        await db.cashBoxes.put(cashBox!);

        if (cashBoxAccountRow) {
          cashBoxAccountRow.balance = roundMoney(cashBoxAccountRow.balance + cashDelta);
          await db.accounts.put(cashBoxAccountRow);
        }

        targetAccount!.balance = roundMoney(
          targetAccount!.balance + (voucher.type === 'RECEIPT' ? -amount : amount)
        );
        await db.accounts.put(targetAccount!);

        if (voucher.partyId) {
          const party = await db.parties.get(voucher.partyId);
          if (party) {
            party.balance = roundMoney(
              party.balance + (voucher.type === 'RECEIPT' ? -amount : amount)
            );
            await db.parties.put(party);
          }
        }

        const persistedVoucher: PaymentVoucher = {
          ...voucher,
          branchId,
          amount,
          date: voucherDate,
          journalEntryId,
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
          action: 'CREATE',
          payload: persistedVoucher as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 3,
          dependsOn: deps,
          createdAt: new Date().toISOString(),
          idempotencyKey: `${tenantId}_VOUCHER_${persistedVoucher.id}_CREATE`,
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
          createdAt: new Date().toISOString(),
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${journalEntry.id}_CREATE`,
        });

        await db.auditLogs.put({
          id: storage.generateUUID(),
          timestamp: new Date().toISOString(),
          userId: actor.id,
          userName: actor.fullName,
          tenantId,
          branchId,
          action: `سند ${persistedVoucher.type === 'RECEIPT' ? 'قبض' : 'صرف'} ذري`,
          details: `سند ${persistedVoucher.voucherNumber} بمبلغ ${amount} ${currencySymbol} وقيد ${journalEntry.entryNumber}`,
        });

        return { success: true, voucher: persistedVoucher, journalEntry };
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
    const effectiveCashBoxId = cashBoxId || record.cashBoxId || 'cb-1';
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

        const cashBox = record.type === 'CASH' ? await db.cashBoxes.get(effectiveCashBoxId) : undefined;
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
        const persistedRecord: AmanatRecord = {
          ...record,
          status: 'HELD',
          cashBoxId: record.type === 'CASH' ? cashBox!.id : undefined,
          amount: record.type === 'CASH' ? roundMoney(record.amount) : 0,
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

          const validCodes = await this.getValidAccountCodesSet();
          validateJournalEntryInput({ entry: createdEntry, validAccountCodes: validCodes });

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
        });

        return { success: true, record: persistedRecord, journalEntry: createdEntry };
      }
    );
  }

  public async returnAmanatAtomic(params: {
    recordId: string;
    cashBoxId?: string;
    recipientSignatureName?: string;
  }): Promise<{ success: boolean; record: AmanatRecord; journalEntry?: JournalEntry }> {
    await this.ensureReady();
    const { actor, tenantId, branchId } = this.requireAuthorizedActor('amanat:manage');

    const activeBranch = (await db.branches.get(branchId)) || (await this.getActiveBranch());
    const terminalCode = storage.getTerminalCode();

    return await db.transaction(
      'rw',
      [db.amanatRecords, db.journalEntries, db.cashBoxes, db.accounts, db.outbox, db.auditLogs, db.sequences],
      async () => {
        const record = await db.amanatRecords.get(params.recordId);
        if (!record) {
          throw new FinancialValidationError('سجل الأمانة المطلوب غير موجود.');
        }

        const effectiveBoxId = params.cashBoxId || record.cashBoxId || 'cb-1';
        const cashBox = record.type === 'CASH' ? await db.cashBoxes.get(effectiveBoxId) : undefined;
        validateAmanatReturnInput({ record, cashBox });

        const updatedRecord: AmanatRecord = {
          ...record,
          status: 'RETURNED',
          returnedDate: new Date().toISOString().split('T')[0],
          recipientSignatureName: params.recipientSignatureName || record.depositorName,
        };

        let returnEntry: JournalEntry | undefined;
        if (updatedRecord.type === 'CASH') {
          const amount = roundMoney(updatedRecord.amount);
          const boxAccCode = cashBox!.accountCode;
          const boxAcc = await db.accounts.get(boxAccCode);
          const amanatAcc = await db.accounts.get('2102');
          if (!amanatAcc) {
            throw new FinancialValidationError('حساب الأمانات للغير (2102) غير موجود.');
          }

          const entryNumber = await this.allocateSequenceNumberAtomic(
            'JV',
            activeBranch.code || 'BR01',
            terminalCode,
            tenantId
          );
          returnEntry = {
            id: storage.generateUUID(),
            entryNumber,
            date: updatedRecord.returnedDate!,
            description: `رد وتسليم أمانة نقدية رقم ${updatedRecord.recordNumber} - ${updatedRecord.depositorName}`,
            costCenterId: 'general',
            branchId,
            lines: [
              {
                id: storage.generateUUID(),
                accountCode: '2102',
                accountName: amanatAcc.nameAr,
                debit: amount,
                credit: 0,
                costCenterId: 'general',
                memo: `إبراء ذمة ورد أمانة رقم ${updatedRecord.recordNumber}`,
              },
              {
                id: storage.generateUUID(),
                accountCode: boxAccCode,
                accountName: boxAcc?.nameAr || cashBox!.nameAr,
                debit: 0,
                credit: amount,
                costCenterId: 'general',
                memo: `صرف رد أمانة رقم ${updatedRecord.recordNumber}`,
              },
            ],
            status: 'POSTED',
            referenceType: 'AMANAT',
            referenceId: updatedRecord.id,
            isAutoGenerated: true,
          };

          const validCodes = await this.getValidAccountCodesSet();
          validateJournalEntryInput({ entry: returnEntry, validAccountCodes: validCodes });

          cashBox!.balance = roundMoney(cashBox!.balance - amount);
          await db.cashBoxes.put(cashBox!);
          if (boxAcc) {
            boxAcc.balance = roundMoney(boxAcc.balance - amount);
            await db.accounts.put(boxAcc);
          }
          amanatAcc.balance = roundMoney(amanatAcc.balance - amount);
          await db.accounts.put(amanatAcc);
          await db.journalEntries.put(returnEntry);
        }

        await db.amanatRecords.put(updatedRecord);

        await db.outbox.put({
          id: storage.generateUUID(),
          tenantId,
          branchId,
          entityType: 'AMANAT',
          entityId: updatedRecord.id,
          action: 'UPDATE',
          payload: updatedRecord as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 3,
          createdAt: new Date().toISOString(),
          idempotencyKey: `${tenantId}_AMANAT_${updatedRecord.id}_RETURN`,
        });

        if (returnEntry) {
          await db.outbox.put({
            id: storage.generateUUID(),
            tenantId,
            branchId,
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
          branchId,
          action: 'رد وتسليم أمانة',
          details: `رد أمانة رقم ${updatedRecord.recordNumber} للمودع ${updatedRecord.depositorName}`,
        });

        return { success: true, record: updatedRecord, journalEntry: returnEntry };
      }
    );
  }

  public async addAmanatRecord(record: AmanatRecord): Promise<void> {
    await this.createAmanatDepositAtomic({ record, cashBoxId: record.cashBoxId });
  }

  public async updateAmanatRecord(record: AmanatRecord): Promise<void> {
    await this.ensureReady();
    const { actor, tenantId, branchId } = this.requireAuthorizedActor('amanat:manage');
    await db.transaction('rw', [db.amanatRecords, db.outbox, db.auditLogs], async () => {
      await db.amanatRecords.put(record);
      await syncQueueService.enqueue({
        tenantId,
        branchId,
        entityType: 'AMANAT',
        entityId: record.id,
        action: 'UPDATE',
        payload: record as unknown as Record<string, unknown>,
      });
      await db.auditLogs.put({
        id: storage.generateUUID(),
        timestamp: new Date().toISOString(),
        userId: actor.id,
        userName: actor.fullName,
        tenantId,
        branchId,
        action: 'تحديث أمانة',
        details: `تحديث سجل أمانة ${record.recordNumber}`,
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
      parties: await db.parties.toArray(),
      invoices: await db.invoices.toArray(),
      journalEntries: await db.journalEntries.toArray(),
      cashBoxes: await db.cashBoxes.toArray(),
      vouchers: await db.vouchers.toArray(),
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
      await db.transaction(
        'rw',
        [
          db.branches,
          db.accounts,
          db.activities,
          db.products,
          db.parties,
          db.invoices,
          db.journalEntries,
          db.cashBoxes,
          db.vouchers,
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
          if (Array.isArray(d.activities)) {
            await db.activities.clear();
            if (d.activities.length > 0) await db.activities.bulkPut(d.activities);
          }
          if (Array.isArray(d.products)) {
            await db.products.clear();
            if (d.products.length > 0) await db.products.bulkPut(d.products);
          }
          if (Array.isArray(d.parties)) {
            await db.parties.clear();
            if (d.parties.length > 0) await db.parties.bulkPut(d.parties);
          }
          if (Array.isArray(d.invoices)) {
            await db.invoices.clear();
            if (d.invoices.length > 0) await db.invoices.bulkPut(d.invoices);
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
            if (d.vouchers.length > 0) await db.vouchers.bulkPut(d.vouchers);
          }
          if (Array.isArray(d.amanat)) {
            await db.amanatRecords.clear();
            if (d.amanat.length > 0) await db.amanatRecords.bulkPut(d.amanat);
          }
          if (Array.isArray(d.users)) {
            await db.users.clear();
            if (d.users.length > 0) await db.users.bulkPut(d.users);
          }
          if (Array.isArray(d.auditLogs)) {
            await db.auditLogs.clear();
            if (d.auditLogs.length > 0) await db.auditLogs.bulkPut(d.auditLogs);
          }
          if (Array.isArray(d.outbox)) {
            await db.outbox.clear();
            if (d.outbox.length > 0) await db.outbox.bulkPut(d.outbox);
          }
          if (Array.isArray(d.syncConflicts)) {
            await db.syncConflicts.clear();
            if (d.syncConflicts.length > 0) await db.syncConflicts.bulkPut(d.syncConflicts);
          }
          if (Array.isArray(d.sequences)) {
            await db.sequences.clear();
            if (d.sequences.length > 0) await db.sequences.bulkPut(d.sequences);
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
      [db.invoices, db.journalEntries, db.vouchers, db.amanatRecords, db.outbox, db.auditLogs, db.sequences],
      async () => {
        await db.invoices.clear();
        await db.journalEntries.clear();
        await db.vouchers.clear();
        await db.amanatRecords.clear();
        await db.outbox.clear();
        await db.sequences.clear();
        await db.auditLogs.put({
          id: storage.generateUUID(),
          timestamp: new Date().toISOString(),
          userId: actor.id,
          userName: actor.fullName,
          tenantId,
          branchId,
          action: 'تصفير الدفاتر التشغيلية',
          details: 'تم بدء سنة مالية / دفتر نظيف مع الاحتفاظ بالحسابات والأصناف والمستخدمين.',
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
    clientRequestId?: string;
  }): Promise<{ success: boolean; invoice: Invoice; journalEntry: JournalEntry }> {
    await this.ensureReady();
    const { invoice, totalCogs, stockDeductions, clientRequestId } = params;
    const { actor, tenantId, branchId } = this.requireAuthorizedActor('pos:sale', invoice.branchId);
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
            return { success: true, invoice: existingInv, journalEntry: existingJe };
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
                return { success: true, invoice: dupInv, journalEntry: dupJe };
              }
            }
          }
        }

        const targetCashBox =
          invoice.paidAmount > 0 && invoice.cashBoxId
            ? await db.cashBoxes.get(invoice.cashBoxId)
            : invoice.cashBoxId
            ? await db.cashBoxes.get(invoice.cashBoxId)
            : undefined;

        validateSalesInvoiceInput({
          invoice,
          totalCogs,
          stockDeductions,
          cashBox: targetCashBox,
        });

        // ب. التحقق من المخزون وتطبيق خصم التشغيلات وFEFO
        const todayStr = new Date().toISOString().split('T')[0];

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
                batch.quantity = roundMoney(batch.quantity - deductFromThis, 4);
                remainingToDeduct = roundMoney(remainingToDeduct - deductFromThis, 4);
              }
            }

            product.currentStock = roundMoney(
              product.batches.reduce((sum, b) => sum + b.quantity, 0),
              4
            );
          } else {
            product.currentStock = roundMoney(product.currentStock - deduction.quantity, 4);
          }

          validateProductStockConsistency(product);
          await db.products.put(product);
        }

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
        const normalizedPaid = roundMoney(invoice.paidAmount);
        const normalizedCogs = roundMoney(totalCogs);

        if (normalizedPaid > 0 && targetCashBox) {
          const boxAccount = targetCashBox.accountCode;
          const acc = await db.accounts.get(boxAccount);
          journalLines.push({
            id: storage.generateUUID(),
            accountCode: boxAccount,
            accountName: acc?.nameAr || targetCashBox.nameAr,
            debit: normalizedPaid,
            credit: 0,
            costCenterId: invoice.activityId,
            memo: `تحصيل نقدي فاتورة مبيعات ${invoice.invoiceNumber}`,
          });

          targetCashBox.balance = roundMoney(targetCashBox.balance + normalizedPaid);
          await db.cashBoxes.put(targetCashBox);
          if (acc) {
            acc.balance = roundMoney(acc.balance + normalizedPaid);
            await db.accounts.put(acc);
          }
        }

        const unpaid = roundMoney(normalizedTotal - normalizedPaid);
        if (unpaid > 0) {
          const arAcc = await db.accounts.get('1103');
          journalLines.push({
            id: storage.generateUUID(),
            accountCode: '1103',
            accountName: `${arAcc?.nameAr || 'العملاء والمدينون'} - ${invoice.partyName}`,
            debit: unpaid,
            credit: 0,
            costCenterId: invoice.activityId,
            memo: `مبيعات آجلة فاتورة ${invoice.invoiceNumber}`,
          });

          if (invoice.partyId) {
            const customer = await db.parties.get(invoice.partyId);
            if (customer) {
              customer.balance = roundMoney(customer.balance + unpaid);
              await db.parties.put(customer);
            }
          }
          if (arAcc) {
            arAcc.balance = roundMoney(arAcc.balance + unpaid);
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

        const validCodes = await this.getValidAccountCodesSet();
        validateJournalEntryInput({ entry: journalEntry, validAccountCodes: validCodes });

        invoice.branchId = branchId;
        invoice.journalEntryId = journalEntryId;
        invoice.isPosted = true;

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
          createdAt: new Date().toISOString(),
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
          createdAt: new Date().toISOString(),
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${journalEntry.id}_CREATE`,
        });

        await db.auditLogs.put({
          id: storage.generateUUID(),
          timestamp: new Date().toISOString(),
          userId: actor.id,
          userName: actor.fullName,
          tenantId,
          branchId,
          action: 'إصدار فاتورة مبيعات ذرية',
          details: `فاتورة ${invoice.invoiceNumber} بقيمة ${invoice.total} ${currencySymbol} وقيد ${journalEntry.entryNumber}`,
        });

        return { success: true, invoice, journalEntry };
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
    clientRequestId?: string;
  }): Promise<{ success: boolean; invoice: Invoice; journalEntry: JournalEntry }> {
    await this.ensureReady();
    const { invoice, itemsWithBatches, clientRequestId } = params;
    const { actor, tenantId, branchId } = this.requireAuthorizedActor(
      'purchase:create',
      invoice.branchId
    );
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
            return { success: true, invoice: existingInv, journalEntry: existingJe };
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
                return { success: true, invoice: dupInv, journalEntry: dupJe };
              }
            }
          }
        }

        const targetCashBox =
          invoice.paidAmount > 0 && invoice.cashBoxId
            ? await db.cashBoxes.get(invoice.cashBoxId)
            : invoice.cashBoxId
            ? await db.cashBoxes.get(invoice.cashBoxId)
            : undefined;

        validatePurchaseInvoiceInput({
          invoice,
          itemsWithBatches,
          cashBox: targetCashBox,
        });

        const todayStr = new Date().toISOString().split('T')[0];

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

          if (item.batchNumber && item.expiryDate) {
            if (!product.batches) product.batches = [];
            const existingBatch = product.batches.find(
              (b) => b.batchNumber === item.batchNumber
            );
            if (existingBatch) {
              existingBatch.quantity = roundMoney(existingBatch.quantity + item.quantity, 4);
              existingBatch.costPrice = item.costPrice;
            } else {
              product.batches.push({
                id: storage.generateUUID(),
                productId: product.id,
                batchNumber: item.batchNumber,
                expiryDate: item.expiryDate,
                quantity: item.quantity,
                costPrice: item.costPrice,
              });
            }
            product.currentStock = roundMoney(
              product.batches.reduce((sum, b) => sum + b.quantity, 0),
              4
            );
          } else {
            product.currentStock = roundMoney(product.currentStock + item.quantity, 4);
          }

          product.purchasePrice = item.costPrice;
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
        const normalizedPaid = roundMoney(invoice.paidAmount);

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

        if (normalizedPaid > 0 && targetCashBox) {
          const boxAccount = targetCashBox.accountCode;
          const acc = await db.accounts.get(boxAccount);
          journalLines.push({
            id: storage.generateUUID(),
            accountCode: boxAccount,
            accountName: acc?.nameAr || targetCashBox.nameAr,
            debit: 0,
            credit: normalizedPaid,
            costCenterId: invoice.activityId,
            memo: `سداد نقدي فاتورة مشتريات ${invoice.invoiceNumber}`,
          });

          targetCashBox.balance = roundMoney(targetCashBox.balance - normalizedPaid);
          await db.cashBoxes.put(targetCashBox);
          if (acc) {
            acc.balance = roundMoney(acc.balance - normalizedPaid);
            await db.accounts.put(acc);
          }
        }

        const unpaid = roundMoney(normalizedTotal - normalizedPaid);
        if (unpaid > 0) {
          const apAcc = await db.accounts.get('2101');
          journalLines.push({
            id: storage.generateUUID(),
            accountCode: '2101',
            accountName: `${apAcc?.nameAr || 'الموردون والدائنون'} - ${invoice.partyName}`,
            debit: 0,
            credit: unpaid,
            costCenterId: invoice.activityId,
            memo: `مستحق آجل فاتورة مشتريات ${invoice.invoiceNumber}`,
          });

          if (invoice.partyId) {
            const supplier = await db.parties.get(invoice.partyId);
            if (supplier) {
              supplier.balance = roundMoney(supplier.balance - unpaid);
              await db.parties.put(supplier);
            }
          }
          if (apAcc) {
            apAcc.balance = roundMoney(apAcc.balance + unpaid);
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

        const validCodes = await this.getValidAccountCodesSet();
        validateJournalEntryInput({ entry: journalEntry, validAccountCodes: validCodes });

        invoice.branchId = branchId;
        invoice.journalEntryId = journalEntryId;
        invoice.isPosted = true;

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
          createdAt: new Date().toISOString(),
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
          createdAt: new Date().toISOString(),
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${journalEntry.id}_CREATE`,
        });

        await db.auditLogs.put({
          id: storage.generateUUID(),
          timestamp: new Date().toISOString(),
          userId: actor.id,
          userName: actor.fullName,
          tenantId,
          branchId,
          action: 'إصدار فاتورة مشتريات ذرية',
          details: `فاتورة ${invoice.invoiceNumber} بقيمة ${invoice.total} ${currencySymbol} وقيد ${journalEntry.entryNumber}`,
        });

        return { success: true, invoice, journalEntry };
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
      [db.journalEntries, db.accounts, db.outbox, db.auditLogs, db.sequences],
      async () => {
        const validCodes = await this.getValidAccountCodesSet();
        validateJournalEntryInput({ entry, validAccountCodes: validCodes });

        if (!entry.id) entry.id = storage.generateUUID();
        if (!entry.entryNumber || !entry.entryNumber.trim()) {
          entry.entryNumber = await this.allocateSequenceNumberAtomic(
            'JV',
            activeBranch.code || 'BR01',
            terminalCode,
            tenantId
          );
        }

        const persistedEntry: JournalEntry = {
          ...entry,
          branchId,
          status: 'POSTED',
        };

        for (const line of persistedEntry.lines) {
          const acc = await db.accounts.get(line.accountCode);
          if (acc) {
            const delta = roundMoney((Number(line.debit) || 0) - (Number(line.credit) || 0));
            acc.balance = roundMoney(acc.balance + delta);
            await db.accounts.put(acc);
          }
        }

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
    const activeBranch = (await db.branches.get(branchId)) || (await this.getActiveBranch());
    const terminalCode = storage.getTerminalCode();

    if (!reversalReason || !reversalReason.trim()) {
      throw new FinancialValidationError('سبب القيد العكسي مطلوب لتوثيق مسار التدقيق.');
    }

    return await db.transaction(
      'rw',
      [db.journalEntries, db.accounts, db.outbox, db.auditLogs, db.sequences],
      async () => {
        const original = await db.journalEntries.get(originalEntryId);
        if (!original) {
          throw new FinancialValidationError('القيد الأصلي غير موجود.');
        }
        if (original.status === 'REVERSED') {
          throw new FinancialValidationError('تم عكس هذا القيد مسبقاً.');
        }
        assertBranchAccess(actor, original.branchId || '', { requireTarget: true });
        if (original.isAutoGenerated || (original.referenceType && original.referenceType !== 'MANUAL')) {
          throw new FinancialValidationError(
            'لا يمكن عكس قيد ناتج عن فاتورة أو سند أو أمانة من شاشة القيود؛ اعكس المستند الأصلي من وحدته حتى تُعكس آثاره على المخزون والصندوق والأرصدة معاً.'
          );
        }

        const reversalNumber = await this.allocateSequenceNumberAtomic(
          'REV',
          activeBranch.code || 'BR01',
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
          memo: `عكس لقيد ${original.entryNumber}: ${reversalReason}`,
        }));

        const reversalEntry: JournalEntry = {
          id: reversalId,
          entryNumber: reversalNumber,
          date: new Date().toISOString().split('T')[0],
          description: `قيد عكسي لتصحيح القيد ${original.entryNumber} - السبب: ${reversalReason}`,
          costCenterId: original.costCenterId,
          branchId: original.branchId || branchId,
          lines: reversedLines,
          status: 'POSTED',
          referenceType: original.referenceType,
          referenceId: original.referenceId,
          isAutoGenerated: true,
          reversedEntryId: original.id,
          reversalReason: reversalReason.trim(),
        };

        const validCodes = await this.getValidAccountCodesSet();
        validateJournalEntryInput({ entry: reversalEntry, validAccountCodes: validCodes });

        for (const line of reversedLines) {
          const acc = await db.accounts.get(line.accountCode);
          if (acc) {
            const delta = roundMoney((Number(line.debit) || 0) - (Number(line.credit) || 0));
            acc.balance = roundMoney(acc.balance + delta);
            await db.accounts.put(acc);
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
          branchId: original.branchId || branchId,
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
          branchId,
          action: 'عكس قيد محاسبي',
          details: `إنشاء القيد العكسي ${reversalNumber} لتصحيح ${original.entryNumber}`,
        });

        return reversalEntry;
      }
    );
  }
}

export const dexieDataService = new DexieDataService();
