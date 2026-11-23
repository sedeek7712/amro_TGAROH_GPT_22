/**
 * حزمة اختبارات الأمان والصلاحيات وعزل الفروع والمؤسسات (SEC-01..07, RBAC-08)
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
import {
  authService,
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  needsInitialAdminSetup,
} from '../services/authService';
import {
  canAccessView,
  hasPermission,
  assertPermission,
  assertBranchAccess,
  filterAuditLogsForUser,
  PermissionError,
} from '../config/rbac';
import { EXPECTED_SUPABASE_TABLES, SUPABASE_RLS_SQL } from '../db/supabaseRlsPolicies';
import { SystemUser } from '../types/erp';

function makeUser(overrides: Partial<SystemUser> = {}): SystemUser {
  return {
    id: 'user-test',
    username: 'tester',
    fullName: 'مستخدم اختبار',
    role: 'ADMIN',
    allowedActivities: ['pharmacy', 'grocery', 'bike_parts', 'equipment_parts'],
    branchId: 'branch_main',
    allowedBranches: ['branch_main'],
    tenantId: 'tenant_main',
    active: true,
    ...overrides,
  };
}

describe('Security, Password Hashing, RBAC & RLS Regression Tests (SEC-07, RBAC-08)', () => {
  beforeEach(async () => {
    localStorage.clear();
    authService.logout();
    dexieDataService.resetForTests();
    await db.users.clear();
    await db.auditLogs.clear();
    await db.vouchers.clear();
    await db.journalEntries.clear();
    await db.products.clear();
    await db.cashBoxes.clear();
    await db.accounts.clear();
    await dexieDataService.initialize();
  });

  test('T-01: Rejects weak passwords & hardcoded 1234 and hashes with PBKDF2-SHA256', async () => {
    assert.equal(validatePasswordStrength('1234', 'admin').valid, false);
    assert.equal(validatePasswordStrength('admin123', 'admin').valid, false);
    assert.equal(validatePasswordStrength('onlyletters', 'user1').valid, false);
    assert.equal(validatePasswordStrength('Strong#2026Pass', 'admin').valid, true);

    const hash = await hashPassword('Strong#2026Pass');
    assert.ok(hash.startsWith('pbkdf2_sha256$100000$'));
    assert.equal(await verifyPassword('Strong#2026Pass', hash), true);
    assert.equal(await verifyPassword('1234', hash), false);
    assert.equal(await verifyPassword('1234', undefined), false);

    // Default initial admin requires first-run password setup (no default password hash)
    const users = await db.users.toArray();
    assert.equal(needsInitialAdminSetup(users), true);
  });

  test('T-02: Locks account after 5 consecutive failed logins and detects tampered session signature', async () => {
    const adminHash = await hashPassword('Admin#Secure2026');
    let persistedAdmin = makeUser({
      id: 'usr-admin-1',
      username: 'admin',
      role: 'ADMIN',
      passwordHash: adminHash,
      failedLoginAttempts: 0,
    });
    await db.users.put(persistedAdmin);

    for (let i = 1; i <= 4; i++) {
      const res = await authService.authenticate({
        username: 'admin',
        password: 'WrongPassword123',
        users: [persistedAdmin],
        onUserUpdated: async (updated) => {
          persistedAdmin = updated;
          await db.users.put(updated);
        },
      });
      assert.equal(res.success, false);
      assert.equal(persistedAdmin.failedLoginAttempts, i);
      assert.equal(res.lockedUntil, undefined);
    }

    // 5th attempt triggers 5-minute lock
    const fifth = await authService.authenticate({
      username: 'admin',
      password: 'WrongPassword123',
      users: [persistedAdmin],
      onUserUpdated: async (updated) => {
        persistedAdmin = updated;
        await db.users.put(updated);
      },
    });
    assert.equal(fifth.success, false);
    assert.ok(fifth.lockedUntil, '5th failed login must set lockedUntil');

    // Even the correct password is blocked while locked
    const duringLock = await authService.authenticate({
      username: 'admin',
      password: 'Admin#Secure2026',
      users: [persistedAdmin],
      onUserUpdated: async (updated) => {
        persistedAdmin = updated;
      },
    });
    assert.equal(duringLock.success, false);

    // Tampered session is rejected by validateSession
    const cleanAdmin = makeUser({ id: 'usr-admin-2', username: 'admin2', role: 'ADMIN', passwordHash: adminHash });
    await db.users.put(cleanAdmin);
    const cleanLogin = await authService.authenticate({
      username: cleanAdmin.username,
      password: 'Admin#Secure2026',
      users: [cleanAdmin],
      onUserUpdated: async (updated) => { await db.users.put(updated); },
    });
    assert.equal(cleanLogin.success, true);

    const rawSession = JSON.parse(localStorage.getItem('multi_activity_erp_auth_session')!);
    rawSession.role = 'ADMIN';
    rawSession.userId = 'spoofed-user';
    localStorage.setItem('multi_activity_erp_auth_session', JSON.stringify(rawSession));

    const check = await authService.validateSession([cleanAdmin]);
    assert.equal(check.valid, false);
  });

  test('T-03 / RBAC-08 / SEC-07: Enforces server/service RBAC, profit isolation, branch access, and audit log filtering', async () => {
    const cashier = makeUser({
      id: 'usr-cashier-1',
      username: 'cashier1',
      role: 'CASHIER',
      branchId: 'branch_main',
      allowedBranches: ['branch_main'],
      passwordHash: await hashPassword('Cashier#Secure2026'),
    });
    await db.users.put(cashier);
    const cashierLogin = await authService.authenticate({
      username: cashier.username,
      password: 'Cashier#Secure2026',
      users: [cashier],
      onUserUpdated: async (updated) => { await db.users.put(updated); },
    });
    assert.equal(cashierLogin.success, true);

    // Cashier allowed views & permissions
    assert.equal(canAccessView('CASHIER', 'pos'), true);
    assert.equal(canAccessView('CASHIER', 'accounting'), false);
    assert.equal(canAccessView('CASHIER', 'reports'), false);
    assert.equal(canAccessView('CASHIER', 'users'), false);
    assert.equal(hasPermission(cashier, 'pos:sale'), true);
    assert.equal(hasPermission(cashier, 'view:profits'), false);
    assert.equal(hasPermission(cashier, 'voucher:payment'), false);
    assert.equal(hasPermission(cashier, 'journal:post'), false);
    assert.equal(hasPermission(cashier, 'inventory:adjust'), false);
    assert.equal(hasPermission(cashier, 'users:manage'), false);

    // Cashier blocked in service layer even if calling service API directly
    await assert.rejects(
      () =>
        dexieDataService.createCashVoucherAtomic({
          voucher: {
            id: 'v-forbidden',
            voucherNumber: '',
            type: 'PAYMENT',
            date: '2026-11-19',
            amount: 100,
            cashBoxId: 'cb-1',
            partyName: 'مورد',
            accountCode: '2101',
            description: 'محاولة غير مصرح بها',
            costCenterId: 'general',
          },
        }),
      (err: unknown) => err instanceof PermissionError
    );

    await assert.rejects(
      () =>
        dexieDataService.adjustProductStockAtomic({
          productId: 'p1',
          deltaQuantity: -1,
          reason: 'تسوية غير مصرح بها',
        }),
      (err: unknown) => err instanceof PermissionError
    );

    await assert.rejects(
      () =>
        dexieDataService.createUserAtomic({
          username: 'hacker',
          fullName: 'Hacker',
          role: 'ADMIN',
          allowedActivities: ['pharmacy'],
          branchId: 'branch_main',
          plainPassword: 'Strong#Password1',
        }),
      (err: unknown) => err instanceof PermissionError
    );

    // Missing target branch and cross-branch access must both be rejected.
    assert.throws(
      () => assertBranchAccess(cashier),
      (err: unknown) => err instanceof PermissionError
    );
    assert.throws(
      () => assertBranchAccess(cashier, 'branch_south'),
      (err: unknown) => err instanceof PermissionError
    );

    // Audit log filtering hides other users' sensitive logs from cashier
    const logs = [
      { id: '1', timestamp: '2026-11-19T10:00:00Z', userId: 'usr-admin', userName: 'Admin', action: 'User Create', details: 'Secret' },
      { id: '2', timestamp: '2026-11-19T10:05:00Z', userId: 'usr-cashier-1', userName: 'Cashier', action: 'Sale', details: 'Own sale' },
    ];
    const cashierFiltered = filterAuditLogsForUser(logs, cashier);
    assert.equal(cashierFiltered.length, 1);
    assert.equal(cashierFiltered[0].id, '2');

    // Unauthenticated actor gets empty logs and PermissionError on write
    authService.logout();
    await assert.rejects(
      () => dexieDataService.getAuditLogs(),
      (err: unknown) => err instanceof PermissionError
    );
    assert.throws(() => assertPermission(null, 'pos:sale'), (err: unknown) => err instanceof PermissionError);
  });

  test('SEC-03 / SEC-04 / DB-04: Supabase RLS SQL denies by default via JWT only and matches SQL/TS single source of truth', () => {
    const sqlWithoutComments = SUPABASE_RLS_SQL.replace(/--.*$/gm, '');
    assert.equal(sqlWithoutComments.includes('request.headers'), false, 'RLS SQL must never trust spoofable request.headers');
    assert.equal(SUPABASE_RLS_SQL.includes("RETURN 'DENIED'"), true, 'RLS role fallback must return DENIED');
    assert.equal(SUPABASE_RLS_SQL.includes('current_app_branch_id() IS NOT NULL'), true, 'Cashier branch check must require explicit JWT branch_id');

    for (const table of EXPECTED_SUPABASE_TABLES) {
      assert.ok(
        SUPABASE_RLS_SQL.includes(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`),
        `Missing RLS enablement for ${table}`
      );
    }

    const sqlFileContent = fs.readFileSync(
      path.resolve(process.cwd(), 'src/db/supabaseRlsPolicies.sql'),
      'utf8'
    );
    assert.equal(sqlFileContent.trim(), SUPABASE_RLS_SQL.trim(), 'SQL file and TS constant must stay in exact parity');
  });

  test('ACT-01: Enforces allowedActivities on Dexie product/invoice reads and writes', async () => {
    const admin = makeUser({
      id: 'usr-admin-act',
      username: 'admin_act',
      role: 'ADMIN',
      passwordHash: await hashPassword('Admin#Act2026'),
    });
    const pharmacyCashier = makeUser({
      id: 'usr-cashier-pharma',
      username: 'cashier_pharma',
      role: 'CASHIER',
      allowedActivities: ['pharmacy'],
      passwordHash: await hashPassword('Cashier#Act2026'),
    });
    const groceryKeeper = makeUser({
      id: 'usr-keeper-groc',
      username: 'keeper_groc',
      role: 'INVENTORY_KEEPER',
      allowedActivities: ['grocery'],
      passwordHash: await hashPassword('Keeper#Act2026'),
    });
    await db.users.bulkPut([admin, pharmacyCashier, groceryKeeper]);

    // Admin seeds products and invoices in both pharmacy and grocery
    const adminLogin = await authService.authenticate({
      username: admin.username,
      password: 'Admin#Act2026',
      users: [admin, pharmacyCashier, groceryKeeper],
      onUserUpdated: async (u) => { await db.users.put(u); },
    });
    assert.equal(adminLogin.success, true);

    await dexieDataService.saveProductAtomic({
      id: 'prod-act-pharma',
      activityId: 'pharmacy',
      code: 'PH-ACT-1',
      nameAr: 'دواء مصرح',
      category: 'أدوية',
      unit: 'علبة',
      purchasePrice: 10,
      sellPrice: 20,
      currentStock: 5,
      minStockAlert: 1,
      batches: [
        { id: 'b-act-1', productId: 'prod-act-pharma', batchNumber: 'B1', expiryDate: '2028-01-01', quantity: 5, costPrice: 10 },
      ],
    });
    await dexieDataService.saveProductAtomic({
      id: 'prod-act-groc',
      activityId: 'grocery',
      code: 'GR-ACT-1',
      nameAr: 'سلعة بقالة',
      category: 'أغذية',
      unit: 'حبة',
      purchasePrice: 5,
      sellPrice: 8,
      currentStock: 10,
      minStockAlert: 1,
    });
    await dexieDataService.createSalesInvoiceAtomic({
      invoice: {
        id: 'inv-act-pharma',
        invoiceNumber: 'INV-ACT-P1',
        type: 'SALE',
        activityId: 'pharmacy',
        branchId: 'branch_main',
        partyName: 'عميل نقدي',
        date: '2026-11-22',
        items: [{ id: 'ii-p1', productId: 'prod-act-pharma', productName: 'دواء مصرح', quantity: 1, unitPrice: 20, discount: 0, total: 20 }],
        subtotal: 20,
        discount: 0,
        tax: 0,
        total: 20,
        paymentMethod: 'CASH',
        cashBoxId: 'cb-1',
        paidAmount: 20,
        isPosted: true,
      },
      totalCogs: 10,
      stockDeductions: [{ productId: 'prod-act-pharma', quantity: 1, batchNumber: 'B1' }],
    });
    await dexieDataService.createSalesInvoiceAtomic({
      invoice: {
        id: 'inv-act-groc',
        invoiceNumber: 'INV-ACT-G1',
        type: 'SALE',
        activityId: 'grocery',
        branchId: 'branch_main',
        partyName: 'عميل نقدي',
        date: '2026-11-22',
        items: [{ id: 'ii-g1', productId: 'prod-act-groc', productName: 'سلعة بقالة', quantity: 1, unitPrice: 8, discount: 0, total: 8 }],
        subtotal: 8,
        discount: 0,
        tax: 0,
        total: 8,
        paymentMethod: 'CASH',
        cashBoxId: 'cb-1',
        paidAmount: 8,
        isPosted: true,
      },
      totalCogs: 5,
      stockDeductions: [{ productId: 'prod-act-groc', quantity: 1 }],
    });

    // Switch to pharmacy-only cashier
    authService.logout();
    const cashierLogin = await authService.authenticate({
      username: pharmacyCashier.username,
      password: 'Cashier#Act2026',
      users: [admin, pharmacyCashier, groceryKeeper],
      onUserUpdated: async (u) => { await db.users.put(u); },
    });
    assert.equal(cashierLogin.success, true);

    const cashierProducts = await dexieDataService.getProducts();
    assert.deepEqual(cashierProducts.map((p) => p.id), ['prod-act-pharma']);
    assert.equal(await dexieDataService.getProductById('prod-act-groc'), undefined);

    const cashierInvoices = await dexieDataService.getInvoices();
    assert.deepEqual(cashierInvoices.map((i) => i.id), ['inv-act-pharma']);
    assert.equal(await dexieDataService.getInvoiceById('inv-act-groc'), undefined);

    await assert.rejects(
      () =>
        dexieDataService.createSalesInvoiceAtomic({
          invoice: {
            id: 'inv-forbidden-groc',
            invoiceNumber: 'INV-FORB-1',
            type: 'SALE',
            activityId: 'grocery',
            branchId: 'branch_main',
            partyName: 'عميل نقدي',
            date: '2026-11-22',
            items: [{ id: 'ii-f1', productId: 'prod-act-groc', productName: 'سلعة بقالة', quantity: 1, unitPrice: 8, discount: 0, total: 8 }],
            subtotal: 8,
            discount: 0,
            tax: 0,
            total: 8,
            paymentMethod: 'CASH',
            cashBoxId: 'cb-1',
            paidAmount: 8,
            isPosted: true,
          },
          totalCogs: 5,
          stockDeductions: [{ productId: 'prod-act-groc', quantity: 1 }],
        }),
      (err: unknown) => err instanceof PermissionError
    );

    await assert.rejects(
      () =>
        dexieDataService.createSalesReturnAtomic({
          originalInvoiceId: 'inv-act-groc',
          items: [{ productId: 'prod-act-groc', quantity: 1 }],
          returnReason: 'محاولة إرجاع نشاط غير مصرح',
          refundMethod: 'CASH',
          cashBoxId: 'cb-1',
        }),
      (err: unknown) => err instanceof PermissionError
    );

    // Switch to grocery-only inventory keeper
    authService.logout();
    const keeperLogin = await authService.authenticate({
      username: groceryKeeper.username,
      password: 'Keeper#Act2026',
      users: [admin, pharmacyCashier, groceryKeeper],
      onUserUpdated: async (u) => { await db.users.put(u); },
    });
    assert.equal(keeperLogin.success, true);

    await assert.rejects(
      () =>
        dexieDataService.saveProductAtomic({
          id: 'prod-forbid-pharma',
          activityId: 'pharmacy',
          code: 'PH-FORB',
          nameAr: 'صنف صيدلية محظور',
          category: 'أدوية',
          unit: 'علبة',
          purchasePrice: 10,
          sellPrice: 15,
          currentStock: 1,
          minStockAlert: 1,
        }),
      (err: unknown) => err instanceof PermissionError
    );

    await assert.rejects(
      () =>
        dexieDataService.adjustProductStockAtomic({
          productId: 'prod-act-pharma',
          deltaQuantity: -1,
          reason: 'تعديل صنف نشاط غير مصرح',
        }),
      (err: unknown) => err instanceof PermissionError
    );
  });
});

