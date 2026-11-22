/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * محرك قاعدة البيانات المحلية المتقدم (Dexie / IndexedDB Engine)
 * يدعم المعاملات الذرية (ACID Transactions)، العدادات المتسلسلة الآمنة (FIN-01)،
 * وطابور Outbox مع حجز العاملين (SYNC-06).
 */

import Dexie, { type IndexableType, type Table } from 'dexie';
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
  DocumentSequence,
  PaymentAllocation,
  PartyAdvanceTransaction,
  AllocationAudit,
} from '../types/erp';

const CANONICAL_V6_ACCOUNTS: Account[] = [
  { code: '1105', nameAr: 'سلف الموردين (دفعات مقدمة للموردين)', type: 'ASSET', parentCode: '11', isLeaf: true, balance: 0 },
  { code: '2103', nameAr: 'دفعات مقدمة من العملاء', type: 'LIABILITY', parentCode: '21', isLeaf: true, balance: 0 },
  { code: '42', nameAr: 'مردودات ومسموحات المبيعات', type: 'REVENUE', parentCode: '4', isLeaf: false, balance: 0 },
  { code: '4201', nameAr: 'مردودات مبيعات الصيدلية', type: 'REVENUE', parentCode: '42', isLeaf: true, balance: 0, costCenterId: 'pharmacy' },
  { code: '4202', nameAr: 'مردودات مبيعات المواد الغذائية والبقالة', type: 'REVENUE', parentCode: '42', isLeaf: true, balance: 0, costCenterId: 'grocery' },
  { code: '4203', nameAr: 'مردودات مبيعات قطع غيار الدراجات', type: 'REVENUE', parentCode: '42', isLeaf: true, balance: 0, costCenterId: 'bike_parts' },
  { code: '4204', nameAr: 'مردودات مبيعات قطع غيار المعدات', type: 'REVENUE', parentCode: '42', isLeaf: true, balance: 0, costCenterId: 'equipment_parts' },
];

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
  sequences!: Table<DocumentSequence, string>;
  paymentAllocations!: Table<PaymentAllocation, string>;
  partyAdvanceTransactions!: Table<PartyAdvanceTransaction, string>;
  allocationAudits!: Table<AllocationAudit, string>;

  constructor() {
    super('MultiActivityErpDB');

    // Schema v1
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

    // Schema v2: Multi-Tenancy & Priority
    this.version(2).stores({
      outbox: 'id, tenantId, entityType, entityId, status, createdAt, idempotencyKey, priority',
    });

    // Schema v3: Sync Conflicts
    this.version(3).stores({
      outbox: 'id, tenantId, entityType, entityId, status, createdAt, idempotencyKey, priority',
      syncConflicts: 'id, tenantId, entityType, entityId, status, detectedAt',
    });

    // Schema v4: Multi-Branch
    this.version(4)
      .stores({
        branches: 'id, code, isMain, active',
        invoices: 'id, invoiceNumber, type, activityId, partyId, date, paymentMethod, branchId',
        journalEntries: 'id, entryNumber, date, status, costCenterId, referenceType, referenceId, branchId',
        vouchers: 'id, voucherNumber, type, date, cashBoxId, partyId, branchId',
        cashBoxes: 'id, code, accountCode, branchId',
        outbox: 'id, tenantId, entityType, entityId, status, createdAt, idempotencyKey, priority, branchId',
        syncConflicts: 'id, tenantId, entityType, entityId, status, detectedAt, branchId',
      })
      .upgrade(async (trans) => {
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

        const assignMainBranch = async (tableName: string) => {
          await trans
            .table(tableName)
            .toCollection()
            .modify((rec: Record<string, unknown>) => {
              if (!rec.branchId) rec.branchId = 'branch_main';
            });
        };
        await assignMainBranch('invoices');
        await assignMainBranch('journalEntries');
        await assignMainBranch('vouchers');
        await assignMainBranch('cashBoxes');
      });

    // Schema v5: عدادات متسلسلة ذرية (FIN-01) + فهارس المستخدمين والتدقيق (SEC-01/SEC-02/SYNC-05)
    this.version(5)
      .stores({
        sequences: 'key',
        users: 'id, username, role, active, tenantId, branchId',
        auditLogs: 'id, timestamp, userId, action, tenantId, branchId',
      })
      .upgrade(async (trans) => {
        await trans
          .table('users')
          .toCollection()
          .modify((u: Record<string, unknown>) => {
            if (!u.branchId) u.branchId = 'branch_main';
            if (!Array.isArray(u.allowedBranches) || u.allowedBranches.length === 0) {
              u.allowedBranches = [String(u.branchId || 'branch_main')];
            }
            if (!u.tenantId) u.tenantId = 'tenant_main';
          });
      });

    // Schema v6: تخصيص الدفعات FIFO، الأرصدة المقدمة (2103 / 1105)، دورة حياة السندات، وسجل تدقيق التعديل اليدوي
    this.version(6)
      .stores({
        vouchers: 'id, voucherNumber, type, date, cashBoxId, partyId, branchId, status',
        paymentAllocations: 'id, tenantId, branchId, voucherId, advanceTransactionId, partyId, invoiceId, status, createdAt',
        partyAdvanceTransactions: 'id, tenantId, branchId, partyId, type, voucherId, invoiceId, date, createdAt',
        allocationAudits: 'id, tenantId, branchId, voucherId, partyId, userId, timestamp',
      })
      .upgrade(async (trans) => {
        const accountsTable = trans.table('accounts');
        const accountCount = await accountsTable.count();
        if (accountCount > 0) {
          for (const acc of CANONICAL_V6_ACCOUNTS) {
            const exists = await accountsTable.get(acc.code);
            if (!exists) {
              await accountsTable.put({ ...acc });
            }
          }
        }

        await trans
          .table('vouchers')
          .toCollection()
          .modify((v: Record<string, unknown>) => {
            if (!v.status) v.status = 'POSTED';
          });

        await trans
          .table('parties')
          .toCollection()
          .modify((p: Record<string, unknown>) => {
            if (typeof p.advanceBalance !== 'number' || !Number.isFinite(p.advanceBalance)) {
              p.advanceBalance = 0;
            }
          });
      });
  }
}

export const db = new MultiActivityErpDatabase();
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
        const existingKeys = new Set(await newTable.toCollection().primaryKeys());
        const keyPath = newTable.schema.primKey.keyPath as string;
        const missingRecords = records.filter((r: Record<string, unknown>) => !existingKeys.has(r[keyPath] as IndexableType));
        if (missingRecords.length > 0) {
          await newTable.bulkPut(missingRecords);
          stats[tableName].migrated = missingRecords.length;
          anyMigrated = true;
        }
      }

      const finalCount = await newTable.count();
      if (finalCount < legacyCount) {
        allVerified = false;
      }
    }

    legacyDb.close();
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
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }
  return false;
}
