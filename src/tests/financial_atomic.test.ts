/**
 * حزمة اختبارات العمليات المالية الذرية، السندات، القيود المتوازنة، والمخزون والتشغيلات (ACC-07, INV-07, FIN-01..03)
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
import { FinancialValidationError } from '../services/financialValidation';
import { Product } from '../types/erp';

describe('Financial Atomicity, Cash Vouchers + JVs, Stock Batch Integrity & Idempotency Tests (ACC-07, INV-07)', () => {
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
      id: 'usr-admin-fin',
      username: 'admin',
      fullName: 'المدير المالي',
      role: 'ADMIN' as const,
      allowedActivities: ['pharmacy', 'grocery', 'bike_parts', 'equipment_parts'] as ('pharmacy' | 'grocery' | 'bike_parts' | 'equipment_parts')[],
      branchId: 'branch_main',
      allowedBranches: ['branch_main'],
      tenantId: 'tenant_main',
      active: true,
      passwordHash: await hashPassword('Admin#Fin2026!'),
    };
    await db.users.put(admin);
    const login = await authService.authenticate({
      username: admin.username,
      password: 'Admin#Fin2026!',
      users: [admin],
      onUserUpdated: async (updated) => { await db.users.put(updated); },
    });
    assert.equal(login.success, true);

    // تمويل الصندوق cb-1 برصيد افتتاحي معلوم للاختبارات المالية
    await db.cashBoxes.update('cb-1', { balance: 10000 });
  });

  test('T-06 / FIN-01: Concurrent branch invoice/voucher sequence allocation never collides', async () => {
    const numbers = await Promise.all([
      dexieDataService.generateBranchInvoiceNumber('INV', 'BR01', 'POS01'),
      dexieDataService.generateBranchInvoiceNumber('INV', 'BR01', 'POS01'),
      dexieDataService.generateBranchInvoiceNumber('INV', 'BR01', 'POS01'),
      dexieDataService.generateBranchInvoiceNumber('INV', 'BR01', 'POS01'),
      dexieDataService.generateBranchInvoiceNumber('INV', 'BR01', 'POS01'),
    ]);
    assert.equal(new Set(numbers).size, 5, 'All 5 sequence numbers must be strictly unique');
  });

  test('T-07 / ACC-07: Cash receipt/payment vouchers link to balanced JournalEntry and roll back fully on invalid account', async () => {
    const res = await dexieDataService.createCashVoucherAtomic({
      voucher: {
        id: 'voucher-acc07-1',
        voucherNumber: '',
        type: 'PAYMENT',
        date: '2026-11-19',
        amount: 450,
        cashBoxId: 'cb-1',
        partyName: 'شركة الكهرباء',
        accountCode: '5201',
        description: 'سداد فاتورة كهرباء',
        costCenterId: 'general',
      },
    });

    assert.ok(res.voucher.journalEntryId, 'Voucher must have journalEntryId linked');
    assert.equal(res.voucher.journalEntryId, res.journalEntry.id);

    const totalDr = res.journalEntry.lines.reduce((s, l) => s + l.debit, 0);
    const totalCr = res.journalEntry.lines.reduce((s, l) => s + l.credit, 0);
    assert.equal(totalDr, 450);
    assert.equal(totalCr, 450);
    assert.equal((await db.cashBoxes.get('cb-1'))?.balance, 9550);

    // Invalid contra account must fail AND leave cash box + vouchers + JVs untouched (full rollback)
    const beforeVouchers = await db.vouchers.count();
    const beforeJVs = await db.journalEntries.count();

    await assert.rejects(
      () =>
        dexieDataService.createCashVoucherAtomic({
          voucher: {
            id: 'voucher-acc07-bad',
            voucherNumber: '',
            type: 'PAYMENT',
            date: '2026-11-19',
            amount: 500,
            cashBoxId: 'cb-1',
            partyName: 'حساب وهمي',
            accountCode: '999999',
            description: 'اختبار فشل الحساب المقابل',
            costCenterId: 'general',
          },
        }),
      (err: unknown) => err instanceof FinancialValidationError
    );

    assert.equal((await db.cashBoxes.get('cb-1'))?.balance, 9550, 'Cash box balance must roll back');
    assert.equal(await db.vouchers.count(), beforeVouchers, 'No orphan voucher may be persisted');
    assert.equal(await db.journalEntries.count(), beforeJVs, 'No partial journal entry may be persisted');
  });

  test('T-08 / T-09 / FIN-02 / FIN-03: Sales idempotency prevents duplicate deduction and invalid inputs roll back cleanly', async () => {
    const prod: Product = {
      id: 'prod-groc-1',
      activityId: 'grocery',
      code: 'GR-01',
      nameAr: 'سكر ناعم 5 كجم',
      category: 'أغذية',
      unit: 'كيس',
      purchasePrice: 20,
      sellPrice: 30,
      currentStock: 10,
      minStockAlert: 2,
    };
    await dexieDataService.saveProductAtomic(prod);

    // 1. Idempotency with same clientRequestId
    const reqId = 'req-pos-submit-001';
    const first = await dexieDataService.createSalesInvoiceAtomic({
      clientRequestId: reqId,
      invoice: {
        id: 'inv-idem-1',
        invoiceNumber: '',
        type: 'SALE',
        activityId: 'grocery',
        partyName: 'عميل نقدي',
        date: '2026-11-19',
        items: [{ id: 'l1', productId: prod.id, productName: prod.nameAr, productCode: prod.code, unit: 'كيس', quantity: 2, unitPrice: 30, discount: 0, total: 60 }],
        subtotal: 60,
        discount: 0,
        tax: 0,
        total: 60,
        paidAmount: 60,
        paymentMethod: 'CASH',
        cashBoxId: 'cb-1',
        isPosted: true,
      },
      totalCogs: 999,
      stockDeductions: [{ productId: prod.id, quantity: 2 }],
    });

    const duplicate = await dexieDataService.createSalesInvoiceAtomic({
      clientRequestId: reqId,
      invoice: {
        id: 'inv-idem-2-different-id',
        invoiceNumber: '',
        type: 'SALE',
        activityId: 'grocery',
        partyName: 'عميل نقدي',
        date: '2026-11-19',
        items: [{ id: 'l1', productId: prod.id, productName: prod.nameAr, productCode: prod.code, unit: 'كيس', quantity: 2, unitPrice: 30, discount: 0, total: 60 }],
        subtotal: 60,
        discount: 0,
        tax: 0,
        total: 60,
        paidAmount: 60,
        paymentMethod: 'CASH',
        cashBoxId: 'cb-1',
        isPosted: true,
      },
      totalCogs: 40,
      stockDeductions: [{ productId: prod.id, quantity: 2 }],
    });

    assert.equal(duplicate.invoice.id, first.invoice.id, 'Duplicate clientRequestId must return original invoice');
    assert.equal(first.invoice.totalCogs, 40, 'COGS must be recalculated from product purchase cost, not trusted from the UI');
    assert.equal(first.invoice.stockDeductionsRecorded?.[0]?.unitCost, 20, 'The actual unit cost must be persisted with the invoice');
    assert.equal((await db.products.get(prod.id))?.currentStock, 8, 'Stock must only be deducted once');
    assert.equal((await db.cashBoxes.get('cb-1'))?.balance, 10060, 'Cash box must only be credited once');

    await assert.rejects(
      () => dexieDataService.createSalesInvoiceAtomic({
        invoice: {
          ...first.invoice,
          id: 'inv-mismatched-deduction',
          invoiceNumber: '',
          items: [{ ...first.invoice.items[0], id: 'line-mismatch', quantity: 1, total: 30 }],
          subtotal: 30,
          total: 30,
          paidAmount: 0,
          cashBoxId: '',
        },
        totalCogs: 0,
        stockDeductions: [{ productId: prod.id, quantity: 2 }],
      }),
      (err: unknown) => err instanceof FinancialValidationError
    );
    assert.equal((await db.products.get(prod.id))?.currentStock, 8, 'A mismatched deduction must roll back without changing stock');

    // 2. Insufficient cash box funds for purchase must throw & leave stock untouched
    await assert.rejects(
      () =>
        dexieDataService.createPurchaseInvoiceAtomic({
          invoice: {
            id: 'inv-pur-overbudget',
            invoiceNumber: '',
            type: 'PURCHASE',
            activityId: 'grocery',
            partyName: 'مورد',
            date: '2026-11-19',
            items: [{ id: 'p1', productId: prod.id, productName: prod.nameAr, productCode: prod.code, unit: 'كيس', quantity: 1000, unitPrice: 50, discount: 0, total: 50000 }],
            subtotal: 50000,
            discount: 0,
            tax: 0,
            total: 50000,
            paidAmount: 50000,
            paymentMethod: 'CASH',
            cashBoxId: 'cb-1',
            isPosted: true,
          },
          itemsWithBatches: [{ productId: prod.id, quantity: 1000, costPrice: 50 }],
        }),
      (err: unknown) => err instanceof FinancialValidationError
    );

    assert.equal((await db.products.get(prod.id))?.currentStock, 8);
    assert.equal((await db.cashBoxes.get('cb-1'))?.balance, 10060);
  });

  test('INV-07: Stock adjustment maintains sum(batches) === currentStock and rejects over-deduction atomically', async () => {
    const pharmaProd: Product = {
      id: 'prod-inv07',
      activityId: 'pharmacy',
      code: 'PH-07',
      nameAr: 'أموكسيسيلين',
      category: 'مضادات حيوية',
      unit: 'علبة',
      purchasePrice: 15,
      sellPrice: 25,
      currentStock: 12,
      minStockAlert: 3,
      trackExpiry: true,
      batches: [
        { id: 'b1', productId: 'prod-inv07', batchNumber: 'B-EARLY', expiryDate: '2027-01-01', quantity: 5, costPrice: 15 },
        { id: 'b2', productId: 'prod-inv07', batchNumber: 'B-LATE', expiryDate: '2028-01-01', quantity: 7, costPrice: 15 },
      ],
    };
    await dexieDataService.saveProductAtomic(pharmaProd);

    // Deduct 8 units via FEFO across batches (5 from B-EARLY + 3 from B-LATE)
    const adjusted = await dexieDataService.adjustProductStockAtomic({
      productId: pharmaProd.id,
      deltaQuantity: -8,
      reason: 'جرد دوري - تالف',
    });

    assert.equal(adjusted.currentStock, 4);
    const batchSum = (adjusted.batches || []).reduce((s, b) => s + b.quantity, 0);
    assert.equal(batchSum, 4);
    assert.equal(adjusted.batches?.find((b) => b.batchNumber === 'B-EARLY')?.quantity, 0);
    assert.equal(adjusted.batches?.find((b) => b.batchNumber === 'B-LATE')?.quantity, 4);

    // Reject over-deduction (-10 when only 4 available)
    await assert.rejects(
      () =>
        dexieDataService.adjustProductStockAtomic({
          productId: pharmaProd.id,
          deltaQuantity: -10,
          reason: 'خصم زائد خاطئ',
        }),
      (err: unknown) => err instanceof FinancialValidationError
    );

    const reloaded = await db.products.get(pharmaProd.id);
    assert.equal(reloaded?.currentStock, 4);
    assert.equal((reloaded?.batches || []).reduce((s, b) => s + b.quantity, 0), 4);

    // Require batchNumber + expiryDate when increasing batch-tracked stock
    await assert.rejects(
      () =>
        dexieDataService.adjustProductStockAtomic({
          productId: pharmaProd.id,
          deltaQuantity: 5,
          reason: 'زيادة دون تشغيلة',
        }),
      (err: unknown) => err instanceof FinancialValidationError
    );

    const increased = await dexieDataService.adjustProductStockAtomic({
      productId: pharmaProd.id,
      deltaQuantity: 5,
      reason: 'فائض جردي بتشغيلة محددة',
      batchNumber: 'B-NEW-2029',
      expiryDate: '2029-06-01',
    });
    assert.equal(increased.currentStock, 9);
    assert.equal((increased.batches || []).reduce((s, b) => s + b.quantity, 0), 9);
  });
});
