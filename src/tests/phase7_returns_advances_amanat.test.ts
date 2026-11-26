/**
 * اختبارات المرحلة السابعة الشاملة (Dexie):
 * 1. مرتجعات المبيعات (AR_OFFSET, CASH, ADVANCE, AUTO) + حظر تجاوز الكمية المباعة + استعادة COGS والمخزون (Perpetual 1104x/510x) + حساب 420x + تقليص متبقي الفاتورة.
 * 2. فواتير الشراء مع تطبيق سلف الموردين (1105) + صلاحية party:advance:use.
 * 3. مرتجعات المشتريات (AP_OFFSET, CASH, ADVANCE, AUTO) + تخفيض المخزون 1104x وتسوية فروق التكلفة 510x + حظر تجاوز الرصيد أو الكمية.
 * 4. دورة الأمانات النقدية والعينية: الرد الجزئي للأمانة النقدية + منع الإلغاء بعد رد جزئي + الإلغاء الكامل لأمانة نقدية/عينية غير مستردة.
 * 5. حوكمة الصلاحيات (pos:return, purchase:return, supplier:advance:approve) وحل الصندوق الافتراضي لفرع جديد دون الاعتماد على cb-1.
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
import { FinancialValidationError } from '../services/financialValidation';
import { authService, hashPassword } from '../services/authService';
import { getInvoiceRemainingAmount } from '../../electron/sqlite/payment-allocation-engine.mjs';
import { Product, Party, SystemUser, CashBox, Branch } from '../types/erp';

async function loginAs(user: SystemUser, plainPassword: string) {
  const res = await authService.authenticate({
    username: user.username,
    password: plainPassword,
    users: await db.users.toArray(),
    onUserUpdated: async (u) => {
      await db.users.put(u);
    },
  });
  assert.equal(res.success, true, `Login failed for ${user.username}: ${res.error}`);
}

async function assertTrialBalanceBalanced() {
  const entries = await db.journalEntries.toArray();
  let totalDebit = 0;
  let totalCredit = 0;
  for (const e of entries) {
    let eDebit = 0;
    let eCredit = 0;
    for (const l of e.lines) {
      eDebit += Number(l.debit || 0);
      eCredit += Number(l.credit || 0);
    }
    assert.ok(Math.abs(eDebit - eCredit) < 0.01, `Unbalanced JV ${e.entryNumber}: ${eDebit} != ${eCredit}`);
    totalDebit += eDebit;
    totalCredit += eCredit;
  }
  assert.ok(Math.abs(totalDebit - totalCredit) < 0.02, `Overall Trial Balance mismatch: ${totalDebit} vs ${totalCredit}`);
}

describe('Phase 7 Dexie: Sales/Purchase Returns (Perpetual), Supplier Advances 1105, Amanat Partial/Cancel & Branch CashBoxes', () => {
  let adminUser: SystemUser;
  let cashierUser: SystemUser;
  let storeKeeperUser: SystemUser;
  let prod: Product;

  beforeEach(async () => {
    localStorage.clear();
    authService.logout();
    dexieDataService.resetForTests();

    await Promise.all([
      db.invoices.clear(),
      db.journalEntries.clear(),
      db.vouchers.clear(),
      db.paymentAllocations.clear(),
      db.partyAdvanceTransactions.clear(),
      db.allocationAudits.clear(),
      db.amanatRecords.clear(),
      db.products.clear(),
      db.cashBoxes.clear(),
      db.accounts.clear(),
      db.parties.clear(),
      db.branches.clear(),
      db.outbox.clear(),
      db.sequences.clear(),
      db.auditLogs.clear(),
    ]);

    await dexieDataService.initialize();
    await db.users.clear();

    adminUser = {
      id: 'usr-admin-p7',
      username: 'admin',
      fullName: 'المدير العام',
      role: 'ADMIN',
      allowedActivities: ['pharmacy', 'grocery', 'bike_parts', 'equipment_parts'],
      branchId: 'branch_main',
      allowedBranches: ['branch_main'],
      tenantId: 'tenant_main',
      active: true,
      passwordHash: await hashPassword('Admin#P72026!'),
    };
    cashierUser = {
      id: 'usr-cashier-p7',
      username: 'cashier_p7',
      fullName: 'كاشير الفرع',
      role: 'CASHIER',
      allowedActivities: ['grocery'],
      branchId: 'branch_main',
      allowedBranches: ['branch_main'],
      tenantId: 'tenant_main',
      active: true,
      passwordHash: await hashPassword('Cashier#P72026!'),
    };
    storeKeeperUser = {
      id: 'usr-store-p7',
      username: 'store_p7',
      fullName: 'أمين المستودع',
      role: 'INVENTORY_KEEPER',
      allowedActivities: ['grocery'],
      branchId: 'branch_main',
      allowedBranches: ['branch_main'],
      tenantId: 'tenant_main',
      active: true,
      passwordHash: await hashPassword('Store#P72026!'),
    };

    await db.users.bulkPut([adminUser, cashierUser, storeKeeperUser]);
    await loginAs(adminUser, 'Admin#P72026!');

    // رأس مال افتتاحي متوازن 300,000 في cb-1 + 100,000 في cb-br2 للتحقق من الفروع
    await dexieDataService.createJournalEntryAtomic({
      id: 'jv-p7-cap',
      entryNumber: '',
      date: '2026-11-01',
      description: 'رأس مال افتتاحي للاختبارات',
      costCenterId: 'general',
      branchId: 'branch_main',
      status: 'POSTED',
      referenceType: 'MANUAL',
      isAutoGenerated: false,
      lines: [
        { id: 'cap-d', accountCode: '1101', accountName: 'الصندوق', debit: 300000, credit: 0 },
        { id: 'cap-c', accountCode: '3101', accountName: 'رأس المال', debit: 0, credit: 300000 },
      ],
    });
    await db.cashBoxes.update('cb-1', { balance: 300000 });

    prod = {
      id: 'prod-p7-groc',
      activityId: 'grocery',
      code: 'GR-P7-01',
      nameAr: 'زيت طبخ 5 لتر',
      category: 'زيوت',
      unit: 'عبوة',
      purchasePrice: 400,
      sellPrice: 600,
      currentStock: 100,
      minStockAlert: 10,
    };
    await dexieDataService.saveProductAtomic(prod);
  });

  test('Sales Return lifecycle: AR_OFFSET, CASH, ADVANCE, over-return guard, Perpetual COGS (11042/5102) & Contra-Revenue (4202)', async () => {
    const cust: Party = {
      id: 'cust-p7-ret',
      type: 'CUSTOMER',
      nameAr: 'عميل مرتجعات المبيعات',
      phone: '777123456',
      balance: 0,
      advanceBalance: 0,
    };
    await dexieDataService.savePartyAtomic(cust);

    // 1. بيع آجل لـ 10 عبوات بسعر 600 = 6000 (التكلفة 10 * 400 = 4000)
    const saleCredit = await dexieDataService.createSalesInvoiceAtomic({
      invoice: {
        id: 'sale-p7-credit',
        invoiceNumber: '',
        type: 'SALE',
        activityId: 'grocery',
        branchId: 'branch_main',
        partyId: cust.id,
        partyName: cust.nameAr,
        date: '2026-11-02',
        items: [
          {
            id: 'sl-1',
            productId: prod.id,
            productName: prod.nameAr,
            productCode: prod.code,
            unit: prod.unit,
            quantity: 10,
            unitPrice: 600,
            discount: 0,
            total: 6000,
          },
        ],
        subtotal: 6000,
        discount: 0,
        tax: 0,
        total: 6000,
        paidAmount: 0,
        paymentMethod: 'CREDIT',
        cashBoxId: 'cb-1',
        isPosted: true,
      },
      totalCogs: 4000,
      stockDeductions: [{ productId: prod.id, quantity: 10 }],
    });
    assert.equal(saleCredit.success, true);
    assert.equal((await db.products.get(prod.id))?.currentStock, 90);
    assert.equal((await db.parties.get(cust.id))?.balance, 6000);

    // 2. مرتجع مبيعات 4 عبوات (2400) بطريقة AR_OFFSET
    const retAr = await dexieDataService.createSalesReturnAtomic({
      originalInvoiceId: saleCredit.invoice.id,
      items: [{ productId: prod.id, quantity: 4 }],
      returnReason: 'تلف تغليف جزئي',
      refundMethod: 'AR_OFFSET',
      date: '2026-11-03',
    });
    assert.equal(retAr.invoice.type, 'RETURN_SALE');
    assert.equal(retAr.invoice.total, 2400);
    assert.equal(retAr.invoice.paidAmount, 0);

    // التحقق من القيد المحاسبي: Dr 4202 (2400) / Cr 1103 (2400) + Dr 11042 (1600) / Cr 5102 (1600)
    const drContra = retAr.journalEntry.lines.find((l) => l.accountCode === '4202');
    const crAr = retAr.journalEntry.lines.find((l) => l.accountCode === '1103');
    const drInv = retAr.journalEntry.lines.find((l) => l.accountCode === '11042');
    const crCogs = retAr.journalEntry.lines.find((l) => l.accountCode === '5102');
    assert.equal(drContra?.debit, 2400);
    assert.equal(crAr?.credit, 2400);
    assert.equal(drInv?.debit, 1600);
    assert.equal(crCogs?.credit, 1600);

    const updatedOrigAfterAr = await db.invoices.get(saleCredit.invoice.id);
    assert.equal(updatedOrigAfterAr?.returnedAmount, 2400);
    assert.equal(getInvoiceRemainingAmount(updatedOrigAfterAr!), 3600);
    assert.equal((await db.parties.get(cust.id))?.balance, 3600);
    assert.equal((await db.products.get(prod.id))?.currentStock, 94);

    // 3. منع إرجاع كمية أكبر من المتبقي القابل للإرجاع (المتبقي 6 عبوات -> طلب 7 يجب أن يفشل)
    await assert.rejects(
      () =>
        dexieDataService.createSalesReturnAtomic({
          originalInvoiceId: saleCredit.invoice.id,
          items: [{ productId: prod.id, quantity: 7 }],
          returnReason: 'تجاوز الكمية المباعة',
          refundMethod: 'AUTO',
        }),
      /تتجاوز الكمية المتاحة للإرجاع/
    );

    // 4. منع رد نقدي إذا كانت الفاتورة تحتوي على ذمة مفتوحة غير مسددة (CASH على فاتورة آجلة)
    await assert.rejects(
      () =>
        dexieDataService.createSalesReturnAtomic({
          originalInvoiceId: saleCredit.invoice.id,
          items: [{ productId: prod.id, quantity: 6 }],
          returnReason: 'محاولة رد نقدي قبل تسوية الذمة',
          refundMethod: 'CASH',
          cashBoxId: 'cb-1',
        }),
      /ذمة آجلة غير مسددة/
    );

    // 5. بيع نقدي مسدد بالكامل للعميل (5 عبوات = 3000) ثم مرتجع 2 منها لـ ADVANCE (1200) ومرتجع 1 لـ CASH (600)
    const salePaid = await dexieDataService.createSalesInvoiceAtomic({
      invoice: {
        id: 'sale-p7-paid',
        invoiceNumber: '',
        type: 'SALE',
        activityId: 'grocery',
        branchId: 'branch_main',
        partyId: cust.id,
        partyName: cust.nameAr,
        date: '2026-11-04',
        items: [
          {
            id: 'sl-2',
            productId: prod.id,
            productName: prod.nameAr,
            productCode: prod.code,
            unit: prod.unit,
            quantity: 5,
            unitPrice: 600,
            discount: 0,
            total: 3000,
          },
        ],
        subtotal: 3000,
        discount: 0,
        tax: 0,
        total: 3000,
        paidAmount: 3000,
        paymentMethod: 'CASH',
        cashBoxId: 'cb-1',
        isPosted: true,
      },
      totalCogs: 2000,
      stockDeductions: [{ productId: prod.id, quantity: 5 }],
    });
    assert.equal(salePaid.success, true);

    const cbBeforeAdvRet = (await db.cashBoxes.get('cb-1'))!.balance;
    const retAdv = await dexieDataService.createSalesReturnAtomic({
      originalInvoiceId: salePaid.invoice.id,
      items: [{ productId: prod.id, quantity: 2 }],
      returnReason: 'إرجاع لرصيد العميل المقدم',
      refundMethod: 'ADVANCE',
      date: '2026-11-05',
    });
    assert.equal(retAdv.invoice.advanceAppliedAmount, 1200);
    assert.equal(retAdv.invoice.paidAmount, 0);
    assert.equal((await db.parties.get(cust.id))?.advanceBalance, 1200);
    assert.equal((await db.accounts.get('2103'))?.balance, 1200);
    assert.equal((await db.cashBoxes.get('cb-1'))!.balance, cbBeforeAdvRet);

    const retCash = await dexieDataService.createSalesReturnAtomic({
      originalInvoiceId: salePaid.invoice.id,
      items: [{ productId: prod.id, quantity: 1 }],
      returnReason: 'رد نقدي لعميل مسدد',
      refundMethod: 'CASH',
      cashBoxId: 'cb-1',
      date: '2026-11-05',
    });
    assert.equal(retCash.invoice.paidAmount, 600);
    assert.equal((await db.cashBoxes.get('cb-1'))!.balance, cbBeforeAdvRet - 600);

    // 6. اختبار صلاحية pos:return — أمين المستودع ممنوع من مرتجع المبيعات
    await loginAs(storeKeeperUser, 'Store#P72026!');
    await assert.rejects(
      () =>
        dexieDataService.createSalesReturnAtomic({
          originalInvoiceId: salePaid.invoice.id,
          items: [{ productId: prod.id, quantity: 1 }],
          returnReason: 'محاولة غير مخولة',
          refundMethod: 'CASH',
          cashBoxId: 'cb-1',
        }),
      /صلاحية/
    );

    await loginAs(adminUser, 'Admin#P72026!');
    await assertTrialBalanceBalanced();
  });

  test('Purchase Return (Perpetual 1104x credit + AP_OFFSET + ADVANCE 1105 + Cost Variance 510x) & Purchase with Supplier Advance 1105', async () => {
    const sup: Party = {
      id: 'sup-p7-1',
      type: 'SUPPLIER',
      nameAr: 'شركة الموردين الوطنية',
      phone: '777888999',
      balance: 0,
      advanceBalance: 0,
    };
    await dexieDataService.savePartyAtomic(sup);

    // 1. شراء آجل 20 عبوة بسعر 450 = 9000 -> المخزون يرتفع من 100@400 إلى 120 بمتوسط تكلفة (40000+9000)/120 = 408.3333
    const purCredit = await dexieDataService.createPurchaseInvoiceAtomic({
      invoice: {
        id: 'pur-p7-1',
        invoiceNumber: '',
        type: 'PURCHASE',
        activityId: 'grocery',
        branchId: 'branch_main',
        partyId: sup.id,
        partyName: sup.nameAr,
        date: '2026-11-02',
        items: [
          {
            id: 'pl-1',
            productId: prod.id,
            productName: prod.nameAr,
            productCode: prod.code,
            unit: prod.unit,
            quantity: 20,
            unitPrice: 450,
            discount: 0,
            total: 9000,
          },
        ],
        subtotal: 9000,
        discount: 0,
        tax: 0,
        total: 9000,
        paidAmount: 0,
        paymentMethod: 'CREDIT',
        cashBoxId: 'cb-1',
        isPosted: true,
      },
      itemsWithBatches: [{ productId: prod.id, quantity: 20, costPrice: 450 }],
    });
    assert.equal(purCredit.success, true);
    assert.equal((await db.parties.get(sup.id))?.balance, -9000);
    assert.equal((await db.products.get(prod.id))?.currentStock, 120);

    // 2. مرتجع مشتريات 10 عبوات (قيمة المرتجع 4500) بطريقة AP_OFFSET
    // لاحظ: قيمة المخزون المخصومة بمتوسط التكلفة (408.3333 * 10 = 4083.33) مقابل 4500 -> الفرق 416.67 يرحل إلى 5102!
    const retPurAp = await dexieDataService.createPurchaseReturnAtomic({
      originalInvoiceId: purCredit.invoice.id,
      items: [{ productId: prod.id, quantity: 10 }],
      returnReason: 'اختلاف المواصفات',
      refundMethod: 'AP_OFFSET',
      date: '2026-11-03',
    });
    assert.equal(retPurAp.invoice.type, 'RETURN_PURCHASE');
    assert.equal(retPurAp.invoice.total, 4500);
    assert.equal((await db.parties.get(sup.id))?.balance, -4500);
    assert.equal((await db.invoices.get(purCredit.invoice.id))?.returnedAmount, 4500);
    assert.equal(getInvoiceRemainingAmount((await db.invoices.get(purCredit.invoice.id))!), 4500);
    assert.equal((await db.products.get(prod.id))?.currentStock, 110);

    const apDr = retPurAp.journalEntry.lines.find((l) => l.accountCode === '2101');
    const invCr = retPurAp.journalEntry.lines.find((l) => l.accountCode === '11042');
    const varCr = retPurAp.journalEntry.lines.find((l) => l.accountCode === '5102');
    assert.equal(apDr?.debit, 4500);
    assert.ok((invCr?.credit || 0) > 4000);
    assert.ok((varCr?.credit || 0) > 400, 'Should record perpetual inventory cost variance in 5102');

    // 3. شراء نقدي مسدد (10 * 400 = 4000) ثم مرتجع 5 عبوات -> 2000 سلفة مورد (ADVANCE 1105)
    const purCash = await dexieDataService.createPurchaseInvoiceAtomic({
      invoice: {
        id: 'pur-p7-cash',
        invoiceNumber: '',
        type: 'PURCHASE',
        activityId: 'grocery',
        branchId: 'branch_main',
        partyId: sup.id,
        partyName: sup.nameAr,
        date: '2026-11-04',
        items: [
          {
            id: 'pl-2',
            productId: prod.id,
            productName: prod.nameAr,
            productCode: prod.code,
            unit: prod.unit,
            quantity: 10,
            unitPrice: 400,
            discount: 0,
            total: 4000,
          },
        ],
        subtotal: 4000,
        discount: 0,
        tax: 0,
        total: 4000,
        paidAmount: 4000,
        paymentMethod: 'CASH',
        cashBoxId: 'cb-1',
        isPosted: true,
      },
      itemsWithBatches: [{ productId: prod.id, quantity: 10, costPrice: 400 }],
    });

    const retPurAdv = await dexieDataService.createPurchaseReturnAtomic({
      originalInvoiceId: purCash.invoice.id,
      items: [{ productId: prod.id, quantity: 5 }],
      returnReason: 'إيداع كسلفة لدى المورد للشراء القادم',
      refundMethod: 'ADVANCE',
      date: '2026-11-05',
    });
    assert.equal(retPurAdv.invoice.advanceAppliedAmount, 2000);
    assert.equal((await db.parties.get(sup.id))?.advanceBalance, 2000);
    assert.equal((await db.accounts.get('1105'))?.balance, 2000);

    // 4. استخدام 1500 من سلفة المورد (1105) عند إنشاء فاتورة مشتريات جديدة + سداد 500 نقداً (إجمالي 2000)
    const cbBeforePurAdv = (await db.cashBoxes.get('cb-1'))!.balance;
    const purUsingAdv = await dexieDataService.createPurchaseInvoiceAtomic({
      invoice: {
        id: 'pur-p7-use-adv',
        invoiceNumber: '',
        type: 'PURCHASE',
        activityId: 'grocery',
        branchId: 'branch_main',
        partyId: sup.id,
        partyName: sup.nameAr,
        date: '2026-11-06',
        items: [
          {
            id: 'pl-3',
            productId: prod.id,
            productName: prod.nameAr,
            productCode: prod.code,
            unit: prod.unit,
            quantity: 5,
            unitPrice: 400,
            discount: 0,
            total: 2000,
          },
        ],
        subtotal: 2000,
        discount: 0,
        tax: 0,
        total: 2000,
        paidAmount: 500, // النقد المدفوع
        paymentMethod: 'CASH',
        cashBoxId: 'cb-1',
        isPosted: true,
      },
      itemsWithBatches: [{ productId: prod.id, quantity: 5, costPrice: 400 }],
      applyAdvanceAmount: 1500,
    });
    assert.ok(purUsingAdv.advanceJournalEntry);
    assert.equal(purUsingAdv.advanceJournalEntry!.referenceType, 'ADVANCE_SETTLEMENT');
    assert.equal(purUsingAdv.invoice.paidAmount, 2000);
    assert.equal(purUsingAdv.invoice.advanceAppliedAmount, 1500);
    assert.equal((await db.cashBoxes.get('cb-1'))!.balance, cbBeforePurAdv - 500);
    assert.equal((await db.parties.get(sup.id))?.advanceBalance, 500);
    assert.equal((await db.accounts.get('1105'))?.balance, 500);

    // 5. صلاحية purchase:return — الكاشير ممنوع من مرتجع المشتريات
    await loginAs(cashierUser, 'Cashier#P72026!');
    await assert.rejects(
      () =>
        dexieDataService.createPurchaseReturnAtomic({
          originalInvoiceId: purCash.invoice.id,
          items: [{ productId: prod.id, quantity: 1 }],
          returnReason: 'محاولة غير مخولة',
          refundMethod: 'CASH',
          cashBoxId: 'cb-1',
        }),
      /صلاحية/
    );

    await loginAs(adminUser, 'Admin#P72026!');
    await assertTrialBalanceBalanced();
  });

  test('Amanat partial cash returns, cancel-after-partial-return guard, full cancellation & multi-branch default CashBox without cb-1', async () => {
    // 1. اختبار فرع ثانٍ بصندوق مستقل (عدم الاعتماد على cb-1)
    const branch2: Branch = {
      id: 'branch_2',
      code: 'BR02',
      nameAr: 'فرع عدن التجاري',
      isMain: false,
      active: true,
      createdAt: '2026-11-01T00:00:00.000Z',
    };
    await dexieDataService.addBranch(branch2);
    const box2: CashBox = {
      id: 'cb-br2',
      code: 'CB-BR2',
      nameAr: 'صندوق فرع عدن',
      accountCode: '1101',
      balance: 0,
      isDefault: true,
      isCentral: false,
      branchId: 'branch_2',
    };
    await dexieDataService.createCashBoxAtomic(box2);

    // تعيين فرع العمل النشط إلى branch_2
    await dexieDataService.setActiveBranchId('branch_2');

    // إيداع أمانة نقدية 5000 في الفرع الثاني دون تمرير cashBoxId صريح -> يجب أن يختار cb-br2 وليس cb-1
    const cashAmanat = await dexieDataService.createAmanatDepositAtomic({
      record: {
        id: 'amn-p7-partial',
        recordNumber: '',
        depositorName: 'ناصر بن علي',
        depositorPhone: '777555444',
        type: 'CASH',
        amount: 5000,
        status: 'HELD',
        receivedDate: '2026-11-06',
        receivedBy: 'المدير العام',
        branchId: 'branch_2',
        notes: 'أمانة تجريبية للرد الجزئي',
      },
    });
    assert.equal(cashAmanat.record.cashBoxId, 'cb-br2');
    assert.equal(cashAmanat.record.remainingAmount, 5000);
    assert.equal((await db.cashBoxes.get('cb-br2'))?.balance, 5000);

    // FIN-04: simulate cash already spent; an amanat refund must not overdraw the branch cash box.
    const cashAccountBefore = await db.accounts.get('1101');
    assert.ok(cashAccountBefore);
    await db.cashBoxes.update('cb-br2', { balance: 1000 });
    await db.accounts.update('1101', { balance: cashAccountBefore.balance - 4000 });
    await assert.rejects(
      () => dexieDataService.returnAmanatAtomic({
        recordId: cashAmanat.record.id,
        returnAmount: 2000,
        recipientSignatureName: 'ناصر بن علي',
      }),
      (err: unknown) => err instanceof FinancialValidationError
    );
    assert.equal((await db.cashBoxes.get('cb-br2'))?.balance, 1000);
    assert.equal((await db.amanatRecords.get(cashAmanat.record.id))?.returnedAmount || 0, 0);
    await db.cashBoxes.update('cb-br2', { balance: 5000 });
    await db.accounts.update('1101', { balance: cashAccountBefore.balance });

    // رد جزئي بمبلغ 2000
    const partial1 = await dexieDataService.returnAmanatAtomic({
      recordId: cashAmanat.record.id,
      returnAmount: 2000,
      recipientSignatureName: 'ناصر بن علي',
      notes: 'دفعة استرداد أولى',
    });
    assert.equal(partial1.record.status, 'HELD');
    assert.equal(partial1.record.returnedAmount, 2000);
    assert.equal(partial1.record.remainingAmount, 3000);
    assert.equal(partial1.record.returnHistory?.length, 1);
    assert.equal((await db.cashBoxes.get('cb-br2'))?.balance, 3000);
    assert.equal((await db.accounts.get('2102'))?.balance, 3000);

    // محاولة إلغاء أمانة تم رد جزء منها -> يجب رفضها
    await assert.rejects(
      () =>
        dexieDataService.cancelAmanatAtomic({
          recordId: cashAmanat.record.id,
          reason: 'محاولة إلغاء بعد رد جزئي',
        }),
      /تم رد جزء منها مسبقاً/
    );

    // إكمال رد المتبقي (3000) -> يجب أن تتحول الحالة إلى RETURNED
    const partial2 = await dexieDataService.returnAmanatAtomic({
      recordId: cashAmanat.record.id,
      returnAmount: 3000,
      recipientSignatureName: 'ناصر بن علي',
      notes: 'دفعة استرداد نهائية',
    });
    assert.equal(partial2.record.status, 'RETURNED');
    assert.equal(partial2.record.returnedAmount, 5000);
    assert.equal(partial2.record.remainingAmount, 0);
    assert.equal(partial2.record.returnHistory?.length, 2);
    assert.equal((await db.cashBoxes.get('cb-br2'))?.balance, 0);
    assert.equal((await db.accounts.get('2102'))?.balance, 0);

    // إيداع أمانة نقدية جديدة 1500 ثم إلغاؤها بالكامل قبل أي رد -> يجب أن تتحول لـ CANCELLED ويعكس القيد 2102/1101
    const unreturnedCash = await dexieDataService.createAmanatDepositAtomic({
      record: {
        id: 'amn-p7-cancel-cash',
        recordNumber: '',
        depositorName: 'ياسر قحطان',
        depositorPhone: '777333222',
        type: 'CASH',
        amount: 1500,
        status: 'HELD',
        receivedDate: '2026-11-06',
        receivedBy: 'المدير العام',
        branchId: 'branch_2',
      },
      cashBoxId: 'cb-br2',
    });
    assert.equal((await db.accounts.get('2102'))?.balance, 1500);

    const cancelledCash = await dexieDataService.cancelAmanatAtomic({
      recordId: unreturnedCash.record.id,
      reason: 'إدخال خاطئ للمبلغ',
    });
    assert.equal(cancelledCash.record.status, 'CANCELLED');
    assert.ok(cancelledCash.journalEntry);
    assert.equal((await db.cashBoxes.get('cb-br2'))?.balance, 0);
    assert.equal((await db.accounts.get('2102'))?.balance, 0);

    // إيداع أمانة عينية وإلغاؤها دون قيد محاسبي
    const jvCountBeforeItem = (await db.journalEntries.toArray()).length;
    const itemAmanat = await dexieDataService.createAmanatDepositAtomic({
      record: {
        id: 'amn-p7-cancel-item',
        recordNumber: '',
        depositorName: 'سالم عوض',
        depositorPhone: '777000888',
        type: 'ITEM',
        amount: 0,
        itemDescription: 'ساعة يد ذهبية في صندوق الأمانات',
        status: 'HELD',
        receivedDate: '2026-11-06',
        receivedBy: 'المدير العام',
        branchId: 'branch_2',
      },
    });
    const cancelledItem = await dexieDataService.cancelAmanatAtomic({
      recordId: itemAmanat.record.id,
      reason: 'عدم استلام العينة فعلياً',
    });
    assert.equal(cancelledItem.record.status, 'CANCELLED');
    assert.equal(cancelledItem.journalEntry, undefined);
    assert.equal((await db.journalEntries.toArray()).length, jvCountBeforeItem);

    await dexieDataService.setActiveBranchId('branch_main');
    await assertTrialBalanceBalanced();
  });
});
