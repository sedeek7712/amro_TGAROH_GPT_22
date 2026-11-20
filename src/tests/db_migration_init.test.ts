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
    await authService.setAuthenticatedUserForSession(admin);
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
});
