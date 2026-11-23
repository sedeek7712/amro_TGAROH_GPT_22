/**
 * حزمة اختبارات التهيئة، الترحيل الآمن من localStorage، النسخ الاحتياطي الذري، والعملة (DB-01..04, CFG-01, DATA-02)
 */

import 'fake-indexeddb/auto';

if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage) {
  const store: Record<string, string> = {};
  const mockStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => {
      store[key] = String(val);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      for (const k in store) delete store[k];
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true });
}

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { db } from '../db/erpDatabase';
import { dexieDataService } from '../services/dexieDataService';
import { authService, hashPassword } from '../services/authService';
import { getActiveCurrencyConfig, setActiveCurrencyConfig, formatMoney, roundMoney } from '../config/currency';
import { Product } from '../types/erp';

describe('DB InitState, Non-Destructive Migration, Atomic Backup & Currency Tests', () => {
  beforeEach(async () => {
    localStorage.clear();
    authService.logout();
    dexieDataService.resetForTests();
    await db.products.clear();
    await db.accounts.clear();
    await db.cashBoxes.clear();
    await db.users.clear();
    await db.branches.clear();
    await db.auditLogs.clear();
    await db.sequences.clear();
    await dexieDataService.initialize();

    const admin = {
      id: 'usr-admin-db',
      username: 'admin',
      fullName: 'مدير النظام',
      role: 'ADMIN' as const,
      allowedActivities: ['pharmacy', 'grocery', 'bike_parts', 'equipment_parts'] as ('pharmacy' | 'grocery' | 'bike_parts' | 'equipment_parts')[],
      branchId: 'branch_main',
      allowedBranches: ['branch_main'],
      tenantId: 'tenant_main',
      active: true,
      passwordHash: await hashPassword('Admin#DbTest2026'),
    };
    await db.users.put(admin);
    const login = await authService.authenticate({
      username: admin.username,
      password: 'Admin#DbTest2026',
      users: [admin],
      onUserUpdated: async (updated) => { await db.users.put(updated); },
    });
    assert.equal(login.success, true);
  });

  test('T-04 / DB-02 / DB-03: InitState transitions cleanly and migration preserves newer Dexie records & pre-migration backup', async () => {
    assert.equal(dexieDataService.getInitState(), 'READY');

    const newerDexieProduct: Product = {
      id: 'prod-conflict-1',
      activityId: 'grocery',
      code: 'G-100',
      nameAr: 'نسخة Dexie الأحدث',
      category: 'مواد غذائية',
      unit: 'كيس',
      purchasePrice: 40,
      sellPrice: 55,
      currentStock: 25,
      minStockAlert: 5,
      updatedAt: '2026-11-19T12:00:00.000Z',
    };
    await db.products.put(newerDexieProduct);

    const olderLocalProduct: Product = {
      ...newerDexieProduct,
      nameAr: 'نسخة localStorage الأقدم',
      currentStock: 10,
      updatedAt: '2026-11-18T12:00:00.000Z',
    };
    const newLocalOnlyProduct: Product = {
      id: 'prod-local-only',
      activityId: 'pharmacy',
      code: 'P-200',
      nameAr: 'صنف جديد من localStorage',
      category: 'أدوية',
      unit: 'علبة',
      purchasePrice: 12,
      sellPrice: 18,
      currentStock: 15,
      minStockAlert: 3,
      updatedAt: '2026-11-19T11:00:00.000Z',
    };

    localStorage.setItem(
      'multi_activity_erp_products',
      JSON.stringify([olderLocalProduct, newLocalOnlyProduct])
    );

    const report = await dexieDataService.migrateLocalStorageToDexie(true);
    assert.equal(report.executed, true);
    assert.ok(localStorage.getItem('multi_activity_erp_pre_migration_backup'), 'Pre-migration backup must be stored');

    const retained = await db.products.get('prod-conflict-1');
    assert.equal(retained?.nameAr, 'نسخة Dexie الأحدث', 'Newer Dexie record must NOT be overwritten');
    assert.equal(retained?.currentStock, 25);

    const migrated = await db.products.get('prod-local-only');
    assert.equal(migrated?.nameAr, 'صنف جديد من localStorage', 'Missing localStorage record must be migrated');
  });

  test('T-05 / T-18: Atomic backup export/restore preserves sequences & checksum rejects tampering without modifying live DB', async () => {
    const box = await db.cashBoxes.get('cb-1');
    assert.ok(box, 'Default cash box cb-1 must exist after initialize');
    const cleanBox = { ...box, balance: 7500 };
    await db.cashBoxes.put(cleanBox);

    const backupJson = await dexieDataService.exportBackupJSON();
    const parsed = JSON.parse(backupJson);
    assert.ok(parsed.checksum);
    assert.ok(Array.isArray(parsed.data.sequences));

    // Mutate DB state, then attempt tampered restore (wrong checksum)
    await db.cashBoxes.update('cb-1', { balance: 1234 });
    const tampered = JSON.parse(backupJson);
    tampered.data.cashBoxes[0].balance = 999999;

    const failRes = await dexieDataService.importBackupJSON(JSON.stringify(tampered));
    assert.equal(failRes.success, false);
    assert.equal((await db.cashBoxes.get('cb-1'))?.balance, 1234, 'Failed restore must leave live DB untouched');

    // Valid restore restores exact balance
    const okRes = await dexieDataService.importBackupJSON(backupJson);
    assert.equal(okRes.success, true);
    assert.equal((await db.cashBoxes.get('cb-1'))?.balance, 7500);
  });

  test('T-16 / CFG-01: Dynamic currency config and precise money rounding', () => {
    setActiveCurrencyConfig({
      code: 'YER',
      symbol: 'ر.ي',
      nameAr: 'الريال اليمني',
      decimals: 2,
    });

    const cfg = getActiveCurrencyConfig();
    assert.equal(cfg.code, 'YER');
    assert.equal(cfg.symbol, 'ر.ي');
    assert.equal(formatMoney(150.5), '150.50 ر.ي');
    assert.equal(roundMoney(0.1 + 0.2), 0.3);
  });

  test('DATA-02: .gitignore excludes runtime sqlite, wal, shm, data/, and backups/', () => {
    const gitignore = fs.readFileSync(path.resolve(process.cwd(), '.gitignore'), 'utf8');
    for (const pattern of ['data/', '*.sqlite', '*.sqlite-wal', '*.sqlite-shm', '*-wal', '*-shm']) {
      assert.ok(gitignore.includes(pattern), `.gitignore missing exclusion rule: ${pattern}`);
    }
  });

  test('BKP-01: Dexie importBackupJSON restores legacy v2.0 backup omitting newer tables, extracts embedded batches, and clears stale rows', async () => {
    await db.outbox.put({
      id: 'stale-outbox-1',
      tenantId: 'tenant_main',
      branchId: 'branch_main',
      entityType: 'PRODUCT',
      entityId: 'stale-p',
      action: 'CREATE',
      payload: {},
      status: 'PENDING',
      retryCount: 0,
      createdAt: '2026-11-20T00:00:00.000Z',
      idempotencyKey: 'stale-key-1',
    });

    const embeddedBatch = {
      id: 'legacy-batch-1',
      productId: 'legacy-prod-1',
      batchNumber: 'LB-01',
      expiryDate: '2028-06-30',
      quantity: 12,
      costPrice: 15,
    };
    const legacyData = {
      branches: await db.branches.toArray(),
      accounts: await db.accounts.toArray(),
      products: [
        {
          id: 'legacy-prod-1',
          activityId: 'pharmacy',
          code: 'LEG-1',
          nameAr: 'صنف أرشيفي قديم',
          category: 'أدوية',
          unit: 'علبة',
          purchasePrice: 15,
          sellPrice: 25,
          currentStock: 12,
          minStockAlert: 2,
          batches: [embeddedBatch],
        },
      ],
      parties: [
        { id: 'leg-cust-1', type: 'CUSTOMER', nameAr: 'عميل قديم', phone: '700111222', balance: 50 },
      ],
      invoices: [
        {
          id: 'leg-inv-1',
          invoiceNumber: 'INV-OLD-1',
          type: 'SALE',
          activityId: 'pharmacy',
          branchId: 'branch_main',
          partyId: 'leg-cust-1',
          partyName: 'عميل قديم',
          date: '2026-10-01',
          items: [],
          subtotal: 50,
          discount: 0,
          tax: 0,
          total: 50,
          paidAmount: 0,
          paymentMethod: 'CREDIT',
        },
      ],
      journalEntries: [],
      cashBoxes: await db.cashBoxes.toArray(),
      vouchers: [],
      users: await db.users.toArray(),
      // Intentionally omit: activities, productBatches, outbox, syncConflicts, sequences,
      // paymentAllocations, partyAdvanceTransactions, allocationAudits, amanat, auditLogs
    };
    const serialized = JSON.stringify(legacyData);
    let checksum = 0;
    for (let i = 0; i < serialized.length; i++) {
      checksum = (checksum + serialized.charCodeAt(i) * (i + 1)) % 1000000007;
    }
    const legacyBackup = {
      app: 'نظام الإدارة التجارية والمحاسبية المتكامل',
      systemIdentifier: 'multi_activity_erp',
      version: '2.0.0',
      exportedAt: '2026-10-01T12:00:00.000Z',
      checksum: checksum.toString(16),
      data: legacyData,
    };

    const res = await dexieDataService.importBackupJSON(JSON.stringify(legacyBackup));
    assert.equal(res.success, true, `Legacy import failed: ${res.error}`);
    assert.equal(await db.outbox.count(), 0, 'Stale outbox rows must be cleared when absent in backup');
    assert.equal((await db.activities.toArray()).length, 4, 'Official activities must be restored when omitted');
    const restoredBatch = await db.productBatches.get('legacy-batch-1');
    assert.equal(restoredBatch?.quantity, 12, 'Embedded product batch must populate productBatches table');
    const restoredProd = await db.products.get('legacy-prod-1');
    assert.equal(restoredProd?.isActive, true);
    const restoredParty = await db.parties.get('leg-cust-1');
    assert.equal(restoredParty?.advanceBalance, 0);
    const restoredInv = await db.invoices.get('leg-inv-1');
    assert.equal(restoredInv?.status, 'POSTED');
    assert.equal(restoredInv?.advanceAppliedAmount, 0);

    // Incomplete backup missing required core tables (e.g. accounts) must fail without wiping live DB
    const incompleteData = { products: [], parties: [] };
    const incSer = JSON.stringify(incompleteData);
    let incChecksum = 0;
    for (let i = 0; i < incSer.length; i++) {
      incChecksum = (incChecksum + incSer.charCodeAt(i) * (i + 1)) % 1000000007;
    }
    const incompleteRes = await dexieDataService.importBackupJSON(
      JSON.stringify({
        systemIdentifier: 'multi_activity_erp',
        version: '2.0.0',
        checksum: incChecksum.toString(16),
        data: incompleteData,
      })
    );
    assert.equal(incompleteRes.success, false);
    assert.equal((await db.products.get('legacy-prod-1'))?.id, 'legacy-prod-1');
  });
});

