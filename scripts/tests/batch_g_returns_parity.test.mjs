import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openErpDatabase } from '../../electron/sqlite/database.mjs';
import { DesktopAuthenticationService } from '../../electron/security/authentication.mjs';
import { createDesktopBackend } from '../../electron/sqlite/desktop-backend.mjs';
import { MONEY_SCALE, parseScaledInt } from '../../electron/sqlite/money.mjs';

function assertTrialBalanceZero(database) {
  const rows = database.prepare('SELECT debit_decimal, credit_decimal FROM journal_entry_lines').all();
  let debit = 0n;
  let credit = 0n;
  for (const r of rows) {
    debit += parseScaledInt(r.debit_decimal, MONEY_SCALE, 'tbDebit');
    credit += parseScaledInt(r.credit_decimal, MONEY_SCALE, 'tbCredit');
  }
  assert.equal(debit, credit, `Trial balance mismatch: debit=${debit} vs credit=${credit}`);
  assert.ok(debit > 0n, 'Trial balance should be non-zero');
}

test('Batch G SQLite parity: Sales/Purchase Returns (Perpetual), Supplier Advances 1105, Amanat Partial Returns & Cancel, Branch CashBox', async () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-batch-g-ret-'));

  try {
    const rt = await openErpDatabase({ userDataPath });
    const auth = new DesktopAuthenticationService(rt.database);
    const backend = createDesktopBackend({
      database: rt.database,
      backupDirectory: rt.backupDirectory,
      authenticationService: auth,
    });

    auth.createInitialAdmin({
      username: 'admin',
      fullName: 'المدير العام',
      password: 'AdminPass#2026',
    });
    const adminToken = auth.authenticate({ username: 'admin', password: 'AdminPass#2026' }).token;

    backend.createUser({
      token: adminToken,
      input: {
        username: 'cashier_g',
        fullName: 'كاشير الصالة',
        role: 'CASHIER',
        allowedActivities: ['grocery'],
        branchId: 'branch_main',
        allowedBranches: ['branch_main'],
        plainPassword: 'CashierPass#2026',
      },
    });
    const cashierToken = auth.authenticate({ username: 'cashier_g', password: 'CashierPass#2026' }).token;

    backend.createUser({
      token: adminToken,
      input: {
        username: 'store_g',
        fullName: 'أمين المستودع',
        role: 'INVENTORY_KEEPER',
        allowedActivities: ['grocery'],
        branchId: 'branch_main',
        allowedBranches: ['branch_main'],
        plainPassword: 'StorePass#2026',
      },
    });
    const storeToken = auth.authenticate({ username: 'store_g', password: 'StorePass#2026' }).token;

    // Opening capital 300,000
    backend.createJournalEntryAtomic({
      token: adminToken,
      entry: {
        id: 'jv-g-ret-cap',
        date: '2026-11-01',
        description: 'رأس مال افتتاحي',
        costCenterId: 'general',
        branchId: 'branch_main',
        referenceType: 'MANUAL',
        lines: [
          { id: 'c1', accountCode: '1101', debit: 300000, credit: 0 },
          { id: 'c2', accountCode: '3101', debit: 0, credit: 300000 },
        ],
      },
    });

    backend.saveProductAtomic({
      token: adminToken,
      product: {
        id: 'prod-g-ret',
        activityId: 'grocery',
        code: 'GR-RET-1',
        nameAr: 'زيت طبخ 5 لتر',
        category: 'زيوت',
        unit: 'عبوة',
        purchasePrice: 400,
        sellPrice: 600,
        currentStock: 100,
        minStockAlert: 10,
      },
    });

    const cust = backend.savePartyAtomic({
      token: adminToken,
      party: { id: 'cust-g-ret', type: 'CUSTOMER', nameAr: 'عميل مرتجع', phone: '777111222', balance: 0, advanceBalance: 0 },
    });
    const sup = backend.savePartyAtomic({
      token: adminToken,
      party: { id: 'sup-g-ret', type: 'SUPPLIER', nameAr: 'مورد مرتجع', phone: '777333444', balance: 0, advanceBalance: 0 },
    });

    // -----------------------------------------------------------------
    // 1. Sales Return (AR_OFFSET, ADVANCE 2103, CASH) + RBAC guard
    // -----------------------------------------------------------------
    const creditSale = backend.createSalesInvoiceAtomic({
      token: adminToken,
      params: {
        invoice: {
          id: 'g-sale-ret-1',
          type: 'SALE',
          activityId: 'grocery',
          branchId: 'branch_main',
          partyId: cust.id,
          partyName: cust.nameAr,
          date: '2026-11-02',
          items: [
            { id: 's1', productId: 'prod-g-ret', productName: 'زيت طبخ 5 لتر', quantity: 10, unitPrice: 600, discount: 0, total: 6000 },
          ],
          subtotal: 6000,
          discount: 0,
          tax: 0,
          total: 6000,
          paidAmount: 0,
          paymentMethod: 'CREDIT',
          cashBoxId: 'cb-1',
        },
        totalCogs: 4000,
        stockDeductions: [{ productId: 'prod-g-ret', quantity: 10 }],
      },
    }).invoice;

    const retSaleAr = backend.createSalesReturnAtomic({
      token: adminToken,
      params: {
        originalInvoiceId: creditSale.id,
        items: [{ productId: 'prod-g-ret', quantity: 4 }],
        returnReason: 'تلف عبوات',
        refundMethod: 'AR_OFFSET',
        date: '2026-11-03',
      },
    });
    assert.equal(retSaleAr.invoice.type, 'RETURN_SALE');
    assert.equal(retSaleAr.invoice.total, 2400);
    assert.equal(backend.getPartyById({ token: adminToken, id: cust.id }).balance, 3600);
    assert.equal(backend.getProductById({ token: adminToken, id: 'prod-g-ret' }).currentStock, 94);
    assert.equal(backend.getInvoices({ token: adminToken }).find((x) => x.id === creditSale.id).returnedAmount, 2400);

    const ret4202 = retSaleAr.journalEntry.lines.find((l) => l.accountCode === '4202');
    const ret11042 = retSaleAr.journalEntry.lines.find((l) => l.accountCode === '11042');
    const ret5102 = retSaleAr.journalEntry.lines.find((l) => l.accountCode === '5102');
    assert.equal(ret4202?.debit, 2400);
    assert.equal(ret11042?.debit, 1600);
    assert.equal(ret5102?.credit, 1600);

    assert.throws(
      () =>
        backend.createSalesReturnAtomic({
          token: adminToken,
          params: {
            originalInvoiceId: creditSale.id,
            items: [{ productId: 'prod-g-ret', quantity: 7 }],
            returnReason: 'تجاوز الكمية',
            refundMethod: 'AUTO',
          },
        }),
      /تتجاوز الكمية المتاحة للإرجاع/
    );

    const paidSale = backend.createSalesInvoiceAtomic({
      token: adminToken,
      params: {
        invoice: {
          id: 'g-sale-paid-2',
          type: 'SALE',
          activityId: 'grocery',
          branchId: 'branch_main',
          partyId: cust.id,
          partyName: cust.nameAr,
          date: '2026-11-04',
          items: [
            { id: 's2', productId: 'prod-g-ret', productName: 'زيت طبخ 5 لتر', quantity: 5, unitPrice: 600, discount: 0, total: 3000 },
          ],
          subtotal: 3000,
          discount: 0,
          tax: 0,
          total: 3000,
          paidAmount: 3000,
          paymentMethod: 'CASH',
          cashBoxId: 'cb-1',
        },
        totalCogs: 2000,
        stockDeductions: [{ productId: 'prod-g-ret', quantity: 5 }],
      },
    }).invoice;

    const cbBeforeSaleRet = backend.getCashBoxes({ token: adminToken }).find((b) => b.id === 'cb-1').balance;
    const retSaleAdv = backend.createSalesReturnAtomic({
      token: adminToken,
      params: {
        originalInvoiceId: paidSale.id,
        items: [{ productId: 'prod-g-ret', quantity: 2 }],
        returnReason: 'تحويل لرصيد العميل',
        refundMethod: 'ADVANCE',
        date: '2026-11-05',
      },
    });
    assert.equal(retSaleAdv.invoice.advanceAppliedAmount, 1200);
    assert.equal(backend.getPartyById({ token: adminToken, id: cust.id }).advanceBalance, 1200);
    assert.equal(backend.getAccounts({ token: adminToken }).find((a) => a.code === '2103').balance, 1200);
    assert.equal(backend.getCashBoxes({ token: adminToken }).find((b) => b.id === 'cb-1').balance, cbBeforeSaleRet);

    const retSaleCash = backend.createSalesReturnAtomic({
      token: adminToken,
      params: {
        originalInvoiceId: paidSale.id,
        items: [{ productId: 'prod-g-ret', quantity: 1 }],
        returnReason: 'رد نقدي',
        refundMethod: 'CASH',
        cashBoxId: 'cb-1',
        date: '2026-11-05',
      },
    });
    assert.equal(retSaleCash.invoice.paidAmount, 600);
    assert.equal(backend.getCashBoxes({ token: adminToken }).find((b) => b.id === 'cb-1').balance, cbBeforeSaleRet - 600);

    assert.throws(
      () =>
        backend.createSalesReturnAtomic({
          token: storeToken,
          params: {
            originalInvoiceId: paidSale.id,
            items: [{ productId: 'prod-g-ret', quantity: 1 }],
            returnReason: 'غير مخول',
            refundMethod: 'CASH',
            cashBoxId: 'cb-1',
          },
        }),
      /مرتجع مبيعات|pos:return/
    );

    // -----------------------------------------------------------------
    // 2. Purchase Return (AP_OFFSET, ADVANCE 1105, variance 5102) & Purchase using Advance 1105
    // -----------------------------------------------------------------
    const purCredit = backend.createPurchaseInvoiceAtomic({
      token: adminToken,
      params: {
        invoice: {
          id: 'g-pur-ret-1',
          type: 'PURCHASE',
          activityId: 'grocery',
          branchId: 'branch_main',
          partyId: sup.id,
          partyName: sup.nameAr,
          date: '2026-11-02',
          items: [
            { id: 'p1', productId: 'prod-g-ret', productName: 'زيت طبخ 5 لتر', quantity: 20, unitPrice: 450, discount: 0, total: 9000 },
          ],
          subtotal: 9000,
          discount: 0,
          tax: 0,
          total: 9000,
          paidAmount: 0,
          paymentMethod: 'CREDIT',
          cashBoxId: 'cb-1',
        },
        itemsWithBatches: [{ productId: 'prod-g-ret', quantity: 20, costPrice: 450 }],
      },
    }).invoice;
    assert.equal(backend.getPartyById({ token: adminToken, id: sup.id }).balance, -9000);

    const retPurAp = backend.createPurchaseReturnAtomic({
      token: adminToken,
      params: {
        originalInvoiceId: purCredit.id,
        items: [{ productId: 'prod-g-ret', quantity: 10 }],
        returnReason: 'مرتجع للمورد',
        refundMethod: 'AP_OFFSET',
        date: '2026-11-03',
      },
    });
    assert.equal(retPurAp.invoice.total, 4500);
    assert.equal(backend.getPartyById({ token: adminToken, id: sup.id }).balance, -4500);
    assert.equal(backend.getInvoices({ token: adminToken }).find((x) => x.id === purCredit.id).returnedAmount, 4500);
    assert.ok(retPurAp.journalEntry.lines.find((l) => l.accountCode === '5102')?.credit > 400);

    const purCash = backend.createPurchaseInvoiceAtomic({
      token: adminToken,
      params: {
        invoice: {
          id: 'g-pur-cash-2',
          type: 'PURCHASE',
          activityId: 'grocery',
          branchId: 'branch_main',
          partyId: sup.id,
          partyName: sup.nameAr,
          date: '2026-11-04',
          items: [
            { id: 'p2', productId: 'prod-g-ret', productName: 'زيت طبخ 5 لتر', quantity: 10, unitPrice: 400, discount: 0, total: 4000 },
          ],
          subtotal: 4000,
          discount: 0,
          tax: 0,
          total: 4000,
          paidAmount: 4000,
          paymentMethod: 'CASH',
          cashBoxId: 'cb-1',
        },
        itemsWithBatches: [{ productId: 'prod-g-ret', quantity: 10, costPrice: 400 }],
      },
    }).invoice;

    const retPurAdv = backend.createPurchaseReturnAtomic({
      token: adminToken,
      params: {
        originalInvoiceId: purCash.id,
        items: [{ productId: 'prod-g-ret', quantity: 5 }],
        returnReason: 'تحويل لسلفة مورد 1105',
        refundMethod: 'ADVANCE',
        date: '2026-11-05',
      },
    });
    assert.equal(retPurAdv.invoice.advanceAppliedAmount, 2000);
    assert.equal(backend.getPartyById({ token: adminToken, id: sup.id }).advanceBalance, 2000);
    assert.equal(backend.getAccounts({ token: adminToken }).find((a) => a.code === '1105').balance, 2000);

    const cbBeforePurAdv = backend.getCashBoxes({ token: adminToken }).find((b) => b.id === 'cb-1').balance;
    const purUseAdv = backend.createPurchaseInvoiceAtomic({
      token: adminToken,
      params: {
        invoice: {
          id: 'g-pur-use-adv',
          type: 'PURCHASE',
          activityId: 'grocery',
          branchId: 'branch_main',
          partyId: sup.id,
          partyName: sup.nameAr,
          date: '2026-11-06',
          items: [
            { id: 'p3', productId: 'prod-g-ret', productName: 'زيت طبخ 5 لتر', quantity: 5, unitPrice: 400, discount: 0, total: 2000 },
          ],
          subtotal: 2000,
          discount: 0,
          tax: 0,
          total: 2000,
          paidAmount: 500,
          paymentMethod: 'CASH',
          cashBoxId: 'cb-1',
        },
        itemsWithBatches: [{ productId: 'prod-g-ret', quantity: 5, costPrice: 400 }],
        applyAdvanceAmount: 1500,
      },
    });
    assert.ok(purUseAdv.advanceJournalEntry);
    assert.equal(purUseAdv.advanceJournalEntry.referenceType, 'ADVANCE_SETTLEMENT');
    assert.equal(purUseAdv.invoice.paidAmount, 2000);
    assert.equal(purUseAdv.invoice.advanceAppliedAmount, 1500);
    assert.equal(backend.getCashBoxes({ token: adminToken }).find((b) => b.id === 'cb-1').balance, cbBeforePurAdv - 500);
    assert.equal(backend.getPartyById({ token: adminToken, id: sup.id }).advanceBalance, 500);
    assert.equal(backend.getAccounts({ token: adminToken }).find((a) => a.code === '1105').balance, 500);

    assert.throws(
      () =>
        backend.createPurchaseReturnAtomic({
          token: cashierToken,
          params: {
            originalInvoiceId: purCash.id,
            items: [{ productId: 'prod-g-ret', quantity: 1 }],
            returnReason: 'غير مخول',
            refundMethod: 'CASH',
            cashBoxId: 'cb-1',
          },
        }),
      /مرتجع مشتريات|purchase:return/
    );

    // -----------------------------------------------------------------
    // 3. Amanat partial return, cancel guard, cancel & Branch 2 CashBox resolution
    // -----------------------------------------------------------------
    backend.addBranch({
      token: adminToken,
      branch: {
        id: 'branch_2',
        tenantId: 'tenant_main',
        code: 'BR02',
        nameAr: 'فرع عدن',
        isMain: false,
        active: true,
        createdAt: '2026-11-01T00:00:00.000Z',
      },
    });
    backend.createCashBoxAtomic({
      token: adminToken,
      box: {
        id: 'cb-br2',
        code: 'CB-BR2',
        nameAr: 'صندوق فرع عدن',
        accountCode: '1101',
        balance: 0,
        isDefault: true,
        isCentral: false,
        branchId: 'branch_2',
      },
    });
    backend.setActiveBranchId({ token: adminToken, branchId: 'branch_2' });

    const depAmn = backend.createAmanatDepositAtomic({
      token: adminToken,
      params: {
        record: {
          id: 'g-amn-1',
          depositorName: 'ناصر علي',
          depositorPhone: '777555444',
          type: 'CASH',
          amount: 5000,
          status: 'HELD',
          receivedDate: '2026-11-06',
          receivedBy: 'المدير العام',
          branchId: 'branch_2',
        },
      },
    });
    assert.equal(depAmn.record.cashBoxId, 'cb-br2');
    assert.equal(depAmn.record.remainingAmount, 5000);
    assert.equal(backend.getCashBoxes({ token: adminToken }).find((b) => b.id === 'cb-br2').balance, 5000);

    const retAmn1 = backend.returnAmanatAtomic({
      token: adminToken,
      params: {
        recordId: depAmn.record.id,
        returnAmount: 2000,
        recipientSignatureName: 'ناصر علي',
        notes: 'استرداد جزئي',
      },
    });
    assert.equal(retAmn1.record.status, 'HELD');
    assert.equal(retAmn1.record.returnedAmount, 2000);
    assert.equal(retAmn1.record.remainingAmount, 3000);
    assert.equal(retAmn1.record.returnHistory.length, 1);

    assert.throws(
      () =>
        backend.cancelAmanatAtomic({
          token: adminToken,
          params: { recordId: depAmn.record.id, reason: 'محاولة إلغاء غير مسموحة' },
        }),
      /تم رد جزء منها مسبقاً/
    );

    const retAmn2 = backend.returnAmanatAtomic({
      token: adminToken,
      params: {
        recordId: depAmn.record.id,
        returnAmount: 3000,
        recipientSignatureName: 'ناصر علي',
        notes: 'استرداد نهائي',
      },
    });
    assert.equal(retAmn2.record.status, 'RETURNED');
    assert.equal(retAmn2.record.returnedAmount, 5000);
    assert.equal(retAmn2.record.remainingAmount, 0);
    assert.equal(retAmn2.record.returnHistory.length, 2);

    const depCancel = backend.createAmanatDepositAtomic({
      token: adminToken,
      params: {
        record: {
          id: 'g-amn-cancel',
          depositorName: 'ياسر قحطان',
          depositorPhone: '777111000',
          type: 'CASH',
          amount: 1500,
          status: 'HELD',
          receivedDate: '2026-11-06',
          receivedBy: 'المدير العام',
          branchId: 'branch_2',
        },
        cashBoxId: 'cb-br2',
      },
    });
    const cancelled = backend.cancelAmanatAtomic({
      token: adminToken,
      params: { recordId: depCancel.record.id, reason: 'إلغاء أمانة قبل الرد' },
    });
    assert.equal(cancelled.record.status, 'CANCELLED');
    assert.ok(cancelled.journalEntry);
    assert.equal(backend.getCashBoxes({ token: adminToken }).find((b) => b.id === 'cb-br2').balance, 0);
    assert.equal(backend.getAccounts({ token: adminToken }).find((a) => a.code === '2102').balance, 0);

    assertTrialBalanceZero(rt.database);
    rt.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('INV-01: SQLite allows returning the same product from two distinct sold batches', async () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-batch-split-return-'));
  try {
    const rt = await openErpDatabase({ userDataPath });
    const auth = new DesktopAuthenticationService(rt.database);
    const backend = createDesktopBackend({ database: rt.database, backupDirectory: rt.backupDirectory, authenticationService: auth });
    auth.createInitialAdmin({ username: 'admin', fullName: 'المدير العام', password: 'AdminPass#2026' });
    const token = auth.authenticate({ username: 'admin', password: 'AdminPass#2026' }).token;

    const product = backend.saveProductAtomic({
      token,
      product: {
        id: 'prod-split-batch-return',
        activityId: 'grocery',
        code: 'GR-SPLIT-RET',
        nameAr: 'صنف بتشغيلتين',
        category: 'اختبار',
        unit: 'علبة',
        purchasePrice: 10,
        sellPrice: 20,
        currentStock: 10,
        minStockAlert: 1,
        batches: [
          { id: 'batch-split-a', productId: 'prod-split-batch-return', batchNumber: 'BATCH-A', expiryDate: '2027-01-01', quantity: 5, costPrice: 10 },
          { id: 'batch-split-b', productId: 'prod-split-batch-return', batchNumber: 'BATCH-B', expiryDate: '2027-02-01', quantity: 5, costPrice: 10 },
        ],
      },
      isUpdate: false,
    });
    const customer = backend.savePartyAtomic({
      token,
      party: { id: 'cust-split-batch-return', type: 'CUSTOMER', nameAr: 'عميل اختبار التشغيلات', phone: '777111999', balance: 0, advanceBalance: 0 },
      isUpdate: false,
    });
    const sale = backend.createSalesInvoiceAtomic({
      token,
      params: {
        clientRequestId: 'sale-split-batch-return',
        invoice: {
          id: 'sale-split-batch-return',
          type: 'SALE',
          activityId: 'grocery',
          branchId: 'branch_main',
          partyId: customer.id,
          partyName: customer.nameAr,
          date: '2026-11-26',
          items: [
            { id: 'split-line-a', productId: product.id, productName: product.nameAr, quantity: 5, unitPrice: 20, discount: 0, total: 100, batchNumber: 'BATCH-A' },
            { id: 'split-line-b', productId: product.id, productName: product.nameAr, quantity: 5, unitPrice: 20, discount: 0, total: 100, batchNumber: 'BATCH-B' },
          ],
          subtotal: 200, discount: 0, tax: 0, total: 200, paidAmount: 0, paymentMethod: 'CREDIT',
        },
        totalCogs: 100,
        stockDeductions: [
          { productId: product.id, quantity: 5, batchNumber: 'BATCH-A' },
          { productId: product.id, quantity: 5, batchNumber: 'BATCH-B' },
        ],
      },
    }).invoice;

    const returnA = backend.createSalesReturnAtomic({
      token,
      params: {
        originalInvoiceId: sale.id,
        items: [{ productId: product.id, quantity: 5, batchNumber: 'BATCH-A' }],
        returnReason: 'اختبار إرجاع التشغيلة الأولى',
        refundMethod: 'AR_OFFSET',
        date: '2026-11-26',
      },
    });
    assert.equal(returnA.invoice.items[0].batchNumber, 'BATCH-A');

    const returnB = backend.createSalesReturnAtomic({
      token,
      params: {
        originalInvoiceId: sale.id,
        items: [{ productId: product.id, quantity: 5, batchNumber: 'BATCH-B' }],
        returnReason: 'اختبار إرجاع التشغيلة الثانية',
        refundMethod: 'AR_OFFSET',
        date: '2026-11-26',
      },
    });
    assert.equal(returnB.invoice.items[0].batchNumber, 'BATCH-B');
    assert.equal(backend.getProductById({ token, id: product.id }).currentStock, 10);
    assertTrialBalanceZero(rt.database);
    rt.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
