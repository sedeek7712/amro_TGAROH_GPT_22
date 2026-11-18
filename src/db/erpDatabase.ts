/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * محرك قاعدة البيانات المحلية المتقدم (Dexie / IndexedDB Engine)
 * يوفر تخزيناً علائقياً مفهرساً عالي الأداء مع دعم المعاملات الذرية وطابور Outbox
 * يدعم الترحيل الآمن من قواعد البيانات والمفاتيح السابقة دون فقدان أي بيانات
 */

import Dexie, { type Table } from 'dexie';
import {
  CommercialActivity,
  Account,
  Product,
  ProductBatch,
  Party,
  Invoice,
  JournalEntry,
  CashBox,
  PaymentVoucher,
  AmanatRecord,
  SystemUser,
  SystemAuditLog,
  OutboxQueueItem,
  SyncConflict,
  Branch,
} from '../types/erp';

export class MultiActivityErpDatabase extends Dexie {
  activities!: Table<CommercialActivity, string>;
  accounts!: Table<Account, string>;
  products!: Table<Product, string>;
  productBatches!: Table<ProductBatch, string>;
  parties!: Table<Party, string>;
  invoices!: Table<Invoice, string>;
  journalEntries!: Table<JournalEntry, string>;
  cashBoxes!: Table<CashBox, string>;
  vouchers!: Table<PaymentVoucher, string>;
  amanatRecords!: Table<AmanatRecord, string>;
  users!: Table<SystemUser, string>;
  auditLogs!: Table<SystemAuditLog, string>;
  outbox!: Table<OutboxQueueItem, string>;
  syncConflicts!: Table<SyncConflict, string>;
  branches!: Table<Branch, string>;

  constructor() {
    super('MultiActivityErpDB');

    // تحديد المخطط العلائقي والفهارس (Schema v1)
    this.version(1).stores({
      activities: 'id, code, costCenterCode',
      accounts: 'code, type, parentCode, isLeaf',
      products: 'id, activityId, code, barcode, oemNumber, category',
      productBatches: 'id, productId, batchNumber, expiryDate',
      parties: 'id, type, nameAr, phone',
      invoices: 'id, invoiceNumber, type, activityId, partyId, date, paymentMethod',
      journalEntries: 'id, entryNumber, date, status, costCenterId, referenceType, referenceId',
      cashBoxes: 'id, code, accountCode',
      vouchers: 'id, voucherNumber, type, date, cashBoxId, partyId',
      amanatRecords: 'id, recordNumber, type, status, depositorName, receivedDate',
      users: 'id, username, role, active',
      auditLogs: 'id, timestamp, userId, action',
      outbox: 'id, entityType, entityId, status, createdAt, idempotencyKey',
    });

    // الترقية إلى Schema v2 لدعم عزل المؤسسات المتعددة (Multi-Tenancy) وترتيب الأولويات
    this.version(2).stores({
      outbox: 'id, tenantId, entityType, entityId, status, createdAt, idempotencyKey, priority',
    });

    // الترقية إلى Schema v3 لدعم إدارة وتوثيق التعارضات (Sync Conflicts) والتبعيات
    this.version(3).stores({
      outbox: 'id, tenantId, entityType, entityId, status, createdAt, idempotencyKey, priority',
      syncConflicts: 'id, tenantId, entityType, entityId, status, detectedAt',
    });

    // الترقية إلى Schema v4 لدعم تعدد الفروع ونقاط البيع والأجهزة (Multi-Branch Architecture)
    this.version(4).stores({
      branches: 'id, code, isMain, active',
      invoices: 'id, invoiceNumber, type, activityId, partyId, date, paymentMethod, branchId',
      journalEntries: 'id, entryNumber, date, status, costCenterId, referenceType, referenceId, branchId',
      vouchers: 'id, voucherNumber, type, date, cashBoxId, partyId, branchId',
      cashBoxes: 'id, code, accountCode, branchId',
      outbox: 'id, tenantId, entityType, entityId, status, createdAt, idempotencyKey, priority, branchId',
      syncConflicts: 'id, tenantId, entityType, entityId, status, detectedAt, branchId',
    }).upgrade(async (trans) => {
      // ترحيل آمن وتأسيس الفرع الرئيسي الافتراضي
      const branchesTable = trans.table('branches');
      const count = await branchesTable.count();
      if (count === 0) {
        await branchesTable.add({
          id: 'branch_main',
          code: 'BR01',
          nameAr: 'الفرع الرئيسي',
          isMain: true,
          active: true,
          createdAt: new Date().toISOString(),
        });
      }

      // إسناد معرف الفرع الرئيسي لجميع السجلات السابقة دون فقدان أي سجل
      const invoicesTable = trans.table('invoices');
      await invoicesTable.toCollection().modify((inv: Record<string, unknown>) => {
        if (!inv.branchId) inv.branchId = 'branch_main';
      });

      const journalsTable = trans.table('journalEntries');
      await journalsTable.toCollection().modify((je: Record<string, unknown>) => {
        if (!je.branchId) je.branchId = 'branch_main';
      });

      const vouchersTable = trans.table('vouchers');
      await vouchersTable.toCollection().modify((v: Record<string, unknown>) => {
        if (!v.branchId) v.branchId = 'branch_main';
      });

      const cashBoxesTable = trans.table('cashBoxes');
      await cashBoxesTable.toCollection().modify((cb: Record<string, unknown>) => {
        if (!cb.branchId) cb.branchId = 'branch_main';
      });
    });
  }
}

// الاسم المعياري الجديد لقاعدة البيانات
export const db = new MultiActivityErpDatabase();

// الحفاظ على الاسم القديم كاسم بديل للتوافق البرمجي دون كسر أي مراجع
export { MultiActivityErpDatabase as AlharajErpDatabase };

/**
 * فحص وترحيل البيانات من قاعدة البيانات القديمة إن وجدت دون حذف الأصل القديم
 */
export async function migrateLegacyIndexedDbIfNeeded(): Promise<{
  migrated: boolean;
  legacyFound: boolean;
  verified: boolean;
  stats: Record<string, { before: number; migrated: number }>;
}> {
  const stats: Record<string, { before: number; migrated: number }> = {};
  if (typeof indexedDB === 'undefined') {
    return { migrated: false, legacyFound: false, verified: true, stats };
  }

  try {
    const legacyExists = await Dexie.exists('AlharajErpDB');
    if (!legacyExists) {
      return { migrated: false, legacyFound: false, verified: true, stats };
    }

    console.log('[Migration] Legacy database AlharajErpDB found. Starting safe non-destructive migration...');
    const legacyDb = new Dexie('AlharajErpDB');
    legacyDb.version(1).stores({
      activities: 'id, code, costCenterCode',
      accounts: 'code, type, parentCode, isLeaf',
      products: 'id, activityId, code, barcode, oemNumber, category',
      productBatches: 'id, productId, batchNumber, expiryDate',
      parties: 'id, type, nameAr, phone',
      invoices: 'id, invoiceNumber, type, activityId, partyId, date, paymentMethod',
      journalEntries: 'id, entryNumber, date, status, costCenterId, referenceType, referenceId',
      cashBoxes: 'id, code, accountCode',
      vouchers: 'id, voucherNumber, type, date, cashBoxId, partyId',
      amanatRecords: 'id, recordNumber, type, status, depositorName, receivedDate',
      users: 'id, username, role, active',
      auditLogs: 'id, timestamp, userId, action',
      outbox: 'id, entityType, entityId, status, createdAt, idempotencyKey',
    });

    await legacyDb.open();
    const tableNames = [
      'activities',
      'accounts',
      'products',
      'productBatches',
      'parties',
      'invoices',
      'journalEntries',
      'cashBoxes',
      'vouchers',
      'amanatRecords',
      'users',
      'auditLogs',
      'outbox',
    ] as const;

    let anyMigrated = false;
    let allVerified = true;

    for (const tableName of tableNames) {
      const legacyTable = legacyDb.table(tableName);
      const newTable = db.table(tableName);

      const legacyCount = await legacyTable.count();
      const currentNewCount = await newTable.count();

      stats[tableName] = { before: legacyCount, migrated: 0 };

      if (legacyCount > 0 && currentNewCount < legacyCount) {
        const records = await legacyTable.toArray();
        await newTable.bulkPut(records);
        stats[tableName].migrated = records.length;
        anyMigrated = true;
      }

      // التحقق من سلامة وأعداد السجلات بعد الترحيل
      const finalCount = await newTable.count();
      if (finalCount < legacyCount) {
        allVerified = false;
        console.error(`[Migration] Verification failed for table ${tableName}: legacy=${legacyCount}, new=${finalCount}`);
      }
    }

    legacyDb.close();
    console.log('[Migration] Migration completed. Database AlharajErpDB remains preserved and intact.', stats);
    return { migrated: anyMigrated, legacyFound: true, verified: allVerified, stats };
  } catch (err) {
    console.warn('[Migration] Error checking or migrating legacy IndexedDB:', err);
    return { migrated: false, legacyFound: false, verified: false, stats };
  }
}

/**
 * طلب حماية التخزين المحلي من الحذف التلقائي من المتصفح (Persistent Storage)
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
    try {
      const isPersisted = await navigator.storage.persist();
      console.log(`[Storage] Persistent storage granted: ${isPersisted}`);
      return isPersisted;
    } catch (err) {
      console.warn('[Storage] Could not request persistent storage:', err);
      return false;
    }
  }
  return false;
}
