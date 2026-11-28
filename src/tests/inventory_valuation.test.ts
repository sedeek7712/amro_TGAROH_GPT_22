/**
 * اختبارات توحيد تقييم المخزون (INV-02)، القيود المحاسبية للافتتاح والتسويات (INV-01)،
 * وحماية الحذف والأرشفة (INV-03) على Dexie
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

import { db } from '../db/erpDatabase';
import { dexieDataService } from '../services/dexieDataService';
import { authService, hashPassword } from '../services/authService';
import {
  getProductCostValue,
  getProductRetailValue,
  computeInventoryValuation,
} from '../utils/inventoryValuation';
import { Product } from '../types/erp';

describe('Inventory Valuation (INV-02), Opening/Adjustment JVs (INV-01) & Archive/Delete Parity (INV-03)', () => {
  beforeEach(async () => {
    localStorage.clear();
    authService.logout();
    dexieDataService.resetForTests();
    await db.invoices.clear();
    await db.journalEntries.clear();
    await db.vouchers.clear();
    await db.products.clear();
    await db.cashBoxes.clear();
    await db.accounts.clear();
    await db.parties.clear();
    await db.outbox.clear();
    await db.sequences.clear();
    await db.auditLogs.clear();
    await dexieDataService.initialize();

    const admin = {
      id: 'usr-admin-inv',
      username: 'admin',
      fullName: 'مدير النظام',
      role: 'ADMIN' as const,
      allowedActivities: ['pharmacy', 'grocery', 'bike_parts', 'equipment_parts'] as (
        | 'pharmacy'
        | 'grocery'
        | 'bike_parts'
        | 'equipment_parts'
      )[],
      branchId: 'branch_main',
      allowedBranches: ['branch_main'],
      tenantId: 'tenant_main',
      active: true,
      passwordHash: await hashPassword('Admin#Inv2026!'),
    };
    await db.users.put(admin);
    const login = await authService.authenticate({
      username: admin.username,
      password: 'Admin#Inv2026!',
      users: [admin],
      onUserUpdated: async (updated) => {
        await db.users.put(updated);
      },
    });
    assert.equal(login.success, true);
  });

  test('INV-02: Valuation uses batch costPrice sum when batches exist and falls back to purchasePrice otherwise', () => {
    const batchProduct: Product = {
      id: 'val-1',
      activityId: 'pharmacy',
      code: 'MED-VAL-1',
      nameAr: 'دواء متعدد التشغيلات',
      category: 'مسكنات',
      unit: 'علبة',
      purchasePrice: 10,
      sellPrice: 20,
      currentStock: 15,
      minStockAlert: 3,
      trackExpiry: true,
      batches: [
        { id: 'b1', productId: 'val-1', batchNumber: 'B1', expiryDate: '2027-01-01', quantity: 5, costPrice: 12 },
        { id: 'b2', productId: 'val-1', batchNumber: 'B2', expiryDate: '2028-01-01', quantity: 10, costPrice: 15 },
      ],
    };

    const nonBatchProduct: Product = {
      id: 'val-2',
      activityId: 'grocery',
      code: 'GRO-VAL-2',
      nameAr: 'صنف بدون تشغيلات',
      category: 'معلبات',
      unit: 'حبة',
      purchasePrice: 8.5,
      sellPrice: 12,
      currentStock: 4,
      minStockAlert: 2,
    };

    assert.equal(getProductCostValue(batchProduct), 210); // 5*12 + 10*15, NOT 15*10=150
    assert.equal(getProductRetailValue(batchProduct), 300);
    assert.equal(getProductCostValue(nonBatchProduct), 34);

    const summary = computeInventoryValuation([batchProduct, nonBatchProduct]);
    assert.equal(summary.totalValue, 244);
    assert.equal(summary.totalCostValue, 244);
    assert.equal(summary.totalRetailValue, 348);
    assert.equal(summary.totalItemsCount, 2);
  });

  test('INV-01: Opening stock and stock adjustments generate balanced GL JournalEntries matching batch costs', async () => {
    const prod = await dexieDataService.saveProductAtomic(
      {
        id: 'inv01-p1',
        activityId: 'pharmacy',
        code: 'MED-INV01',
        nameAr: 'أموكسيسيلين',
        category: 'مضادات',
        unit: 'علبة',
        purchasePrice: 12.5,
        sellPrice: 19,
        currentStock: 0,
        minStockAlert: 2,
        trackExpiry: true,
        batches: [
          { id: 'ib-1', productId: 'inv01-p1', batchNumber: 'B-SOON', expiryDate: '2027-02-01', quantity: 5, costPrice: 12 },
          { id: 'ib-2', productId: 'inv01-p1', batchNumber: 'B-LATER', expiryDate: '2028-01-01', quantity: 10, costPrice: 12.5 },
        ],
      },
      false
    );
    assert.equal(prod.currentStock, 15);

    const jvsAfterOpen = await db.journalEntries.where('referenceId').equals('inv01-p1').toArray();
    assert.equal(jvsAfterOpen.length, 1);
    assert.equal(jvsAfterOpen[0].referenceType, 'INVENTORY');
    assert.equal(
      jvsAfterOpen[0].lines.find((l) => l.accountCode === '11041')?.debit,
      185
    );
    assert.equal(
      jvsAfterOpen[0].lines.find((l) => l.accountCode === '3101')?.credit,
      185
    );
    assert.equal((await db.accounts.get('11041'))?.balance, 185);
    assert.equal((await db.accounts.get('3101'))?.balance, 185);

    // FEFO Shortage: -6 => 5*12 + 1*12.5 = 72.5 (Dr 5205 / Cr 11041)
    await dexieDataService.adjustProductStockAtomic({
      productId: 'inv01-p1',
      deltaQuantity: -6,
      reason: 'تلف تشغيلة قريبة الانتهاء',
    });

    const jvsAfterShort = await db.journalEntries.where('referenceId').equals('inv01-p1').toArray();
    assert.equal(jvsAfterShort.length, 2);
    const shortJv = jvsAfterShort.find((j) => j.description.includes('نقص/تلف'));
    assert.ok(shortJv);
    assert.equal(shortJv.lines.find((l) => l.accountCode === '5205')?.debit, 72.5);
    assert.equal(shortJv.lines.find((l) => l.accountCode === '11041')?.credit, 72.5);
    assert.equal((await db.accounts.get('11041'))?.balance, 112.5);
    assert.equal((await db.accounts.get('5205'))?.balance, 72.5);

    // Positive Surplus: +2 at purchasePrice (12.5) = 25 (Dr 11041 / Cr 5205)
    await dexieDataService.adjustProductStockAtomic({
      productId: 'inv01-p1',
      deltaQuantity: 2,
      reason: 'فائض جرد سنوي',
      batchNumber: 'B-EXTRA',
      expiryDate: '2028-06-01',
    });

    const updatedProd = await db.products.get('inv01-p1');
    assert.ok(updatedProd);
    assert.equal(getProductCostValue(updatedProd), 137.5);
    assert.equal((await db.accounts.get('11041'))?.balance, 137.5);
    assert.equal((await db.accounts.get('5205'))?.balance, 47.5);

    // Verify full double-entry balance across all JVs
    const allJvs = await db.journalEntries.toArray();
    for (const jv of allJvs) {
      const dr = jv.lines.reduce((s, l) => s + l.debit, 0);
      const cr = jv.lines.reduce((s, l) => s + l.credit, 0);
      assert.equal(Number(dr.toFixed(2)), Number(cr.toFixed(2)));
    }
  });

  test('INV-03: Dexie blocks deletion of invoiced products, allows unreferenced deletion with GL reversal, and supports archiving', async () => {
    const prod = await dexieDataService.saveProductAtomic(
      {
        id: 'inv03-p1',
        activityId: 'grocery',
        code: 'GRO-INV03',
        nameAr: 'زيت زيتون',
        category: 'زيوت',
        unit: 'علبة',
        purchasePrice: 20,
        sellPrice: 30,
        currentStock: 10,
        minStockAlert: 2,
      },
      false
    );
    assert.equal((await db.accounts.get('11042'))?.balance, 200);

    // Archive and restore preserves data cleanly
    const archived = await dexieDataService.saveProductAtomic({ ...prod, isActive: false }, true);
    assert.equal(archived.isActive, false);
    const restored = await dexieDataService.saveProductAtomic({ ...archived, isActive: true }, true);
    assert.equal(restored.isActive, true);

    // Create temp unreferenced product and verify deletion reverses its opening JV
    await dexieDataService.saveProductAtomic(
      {
        id: 'inv03-temp',
        activityId: 'grocery',
        code: 'GRO-TMP',
        nameAr: 'صنف مؤقت',
        category: 'عام',
        unit: 'حبة',
        purchasePrice: 5,
        sellPrice: 8,
        currentStock: 4,
        minStockAlert: 1,
      },
      false
    );
    assert.equal((await db.accounts.get('11042'))?.balance, 220);

    await dexieDataService.deleteProductAtomic('inv03-temp');
    assert.equal(await db.products.get('inv03-temp'), undefined);
    assert.equal((await db.accounts.get('11042'))?.balance, 200);

    // Create invoice referencing inv03-p1 -> deletion must throw parity error
    await dexieDataService.createSalesInvoiceAtomic({
      invoice: {
        id: 'inv-sale-lock',
        invoiceNumber: '',
        type: 'SALE',
        activityId: 'grocery',
        date: '2026-11-22',
        partyName: 'عميل نقدي',
        items: [
          {
            id: 'item-inv03-lock-1',
            productId: 'inv03-p1',
            productCode: 'GRO-P1',
            productName: 'زيت زيتون',
            quantity: 1,
            unitPrice: 30,
            discount: 0,
            total: 30,
            unit: 'علبة',
          },
        ],
        subtotal: 30,
        discount: 0,
        tax: 0,
        total: 30,
        paidAmount: 30,
        paymentMethod: 'CASH',
        cashBoxId: 'cb-1',
      },
      stockDeductions: [{ productId: 'inv03-p1', quantity: 1 }],
      totalCogs: 20,
    });

    await assert.rejects(
      dexieDataService.deleteProductAtomic('inv03-p1'),
      /لا يمكن حذف صنف مرتبط بفواتير مرحلة/
    );
  });
});
