import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openErpDatabase } from '../../electron/sqlite/database.mjs';
import { DesktopAuthenticationService, hashPasswordForDesktop } from '../../electron/security/authentication.mjs';
import { createDesktopBackend } from '../../electron/sqlite/desktop-backend.mjs';
import { MONEY_SCALE, parseScaledInt } from '../../electron/sqlite/money.mjs';
import { importLegacyBackup, legacyChecksum } from '../../electron/sqlite/legacy-backup-importer.mjs';

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

test('Batch G SQLite parity: FIFO allocations, 2103/1105 advances, POS settlement, override RBAC, voucher lifecycle & v2.2.0 import', async () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-batch-g-'));
  const legacyImportPath = mkdtempSync(path.join(os.tmpdir(), 'erp-batch-g-legacy-'));

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
        username: 'acc1',
        fullName: 'المحاسب المالي',
        role: 'ACCOUNTANT',
        allowedActivities: ['grocery'],
        branchId: 'branch_main',
        allowedBranches: ['branch_main'],
        plainPassword: 'Accountant#2026',
      },
    });
    const accToken = auth.authenticate({ username: 'acc1', password: 'Accountant#2026' }).token;

    // Seed opening capital (200,000) & product
    backend.createJournalEntryAtomic({
      token: adminToken,
      entry: {
        id: 'jv-g-cap',
        date: '2026-11-01',
        description: 'رأس مال افتتاحي',
        costCenterId: 'general',
        branchId: 'branch_main',
        referenceType: 'MANUAL',
        lines: [
          { id: 'c1', accountCode: '1101', debit: 200000, credit: 0 },
          { id: 'c2', accountCode: '3101', debit: 0, credit: 200000 },
        ],
      },
    });

    backend.saveProductAtomic({
      token: adminToken,
      product: {
        id: 'prod-g-1',
        activityId: 'grocery',
        code: 'GR-G-1',
        nameAr: 'دقيق فاخر',
        category: 'أغذية',
        unit: 'كيس',
        purchasePrice: 500,
        sellPrice: 1000,
        currentStock: 500,
        minStockAlert: 10,
      },
    });

    const cust = backend.savePartyAtomic({
      token: adminToken,
      party: { id: 'cust-g-1', type: 'CUSTOMER', nameAr: 'عميل باريتي', phone: '777111000', balance: 0, advanceBalance: 0 },
    });
    const sup = backend.savePartyAtomic({
      token: adminToken,
      party: { id: 'sup-g-1', type: 'SUPPLIER', nameAr: 'مورد باريتي', phone: '777222000', balance: 0, advanceBalance: 0 },
    });

    const createSale = (id, date, qty) =>
      backend.createSalesInvoiceAtomic({
        token: adminToken,
        params: {
          invoice: {
            id,
            type: 'SALE',
            activityId: 'grocery',
            partyId: cust.id,
            partyName: cust.nameAr,
            date,
            items: [{ id: `${id}-l`, productId: 'prod-g-1', productName: 'دقيق فاخر', quantity: qty, unitPrice: 1000, discount: 0, total: qty * 1000 }],
            subtotal: qty * 1000,
            discount: 0,
            tax: 0,
            total: qty * 1000,
            paidAmount: 0,
            paymentMethod: 'CREDIT',
            cashBoxId: 'cb-1',
          },
          totalCogs: qty * 500,
          stockDeductions: [{ productId: 'prod-g-1', quantity: qty }],
        },
      }).invoice;

    const i1 = createSale('g-s1', '2026-11-01', 50); // 50,000
    const i2 = createSale('g-s2', '2026-11-02', 40); // 40,000
    const i3 = createSale('g-s3', '2026-11-03', 30); // 30,000
    assert.equal(backend.getPartyById({ token: adminToken, id: cust.id }).balance, 120000);

    // 1. FIFO receipt 100,000
    const vFifo = backend.createCashVoucherAtomic({
      token: adminToken,
      params: {
        voucher: {
          id: 'g-v-fifo',
          type: 'RECEIPT',
          voucherMode: 'CUSTOMER_RECEIPT',
          date: '2026-11-05',
          amount: 100000,
          cashBoxId: 'cb-1',
          partyId: cust.id,
          partyType: 'CUSTOMER',
          partyName: cust.nameAr,
          accountCode: '1103',
          paymentMethod: 'CASH',
          description: 'تحصيل FIFO 100 ألف',
          costCenterId: 'general',
          status: 'POSTED',
        },
      },
    });
    assert.equal(vFifo.voucher.appliedToDebtAmount, 100000);
    assert.equal(vFifo.voucher.advanceAmount, 0);
    assert.equal(backend.getPartyById({ token: adminToken, id: cust.id }).balance, 20000);

    const invListAfterFifo = backend.getInvoices({ token: adminToken });
    assert.equal(invListAfterFifo.find((x) => x.id === i1.id).paidAmount, 50000);
    assert.equal(invListAfterFifo.find((x) => x.id === i2.id).paidAmount, 40000);
    assert.equal(invListAfterFifo.find((x) => x.id === i3.id).paidAmount, 10000);

    // 2. Overpayment 50,000 -> 20,000 settles i3 + 30,000 to Customer Advance (2103)
    const vOver = backend.createCashVoucherAtomic({
      token: adminToken,
      params: {
        voucher: {
          id: 'g-v-over',
          type: 'RECEIPT',
          voucherMode: 'CUSTOMER_RECEIPT',
          date: '2026-11-06',
          amount: 50000,
          cashBoxId: 'cb-1',
          partyId: cust.id,
          partyType: 'CUSTOMER',
          partyName: cust.nameAr,
          accountCode: '1103',
          paymentMethod: 'BANK_TRANSFER',
          externalRef: 'BNK-99',
          description: 'دفعة زائدة 2103',
          costCenterId: 'general',
          status: 'POSTED',
        },
      },
    });
    assert.equal(vOver.voucher.appliedToDebtAmount, 20000);
    assert.equal(vOver.voucher.advanceAmount, 30000);
    assert.equal(backend.getPartyById({ token: adminToken, id: cust.id }).balance, 0);
    assert.equal(backend.getPartyById({ token: adminToken, id: cust.id }).advanceBalance, 30000);
    assert.equal(backend.getAccounts({ token: adminToken }).find((a) => a.code === '2103').balance, 30000);

    // 3. POS Sale applying 15,000 from advance + 10,000 cash -> standalone ADVANCE_SETTLEMENT JE
    const cbBefore = backend.getCashBoxes({ token: adminToken }).find((b) => b.id === 'cb-1').balance;
    const advSale = backend.createSalesInvoiceAtomic({
      token: adminToken,
      params: {
        invoice: {
          id: 'g-inv-adv',
          type: 'SALE',
          activityId: 'grocery',
          partyId: cust.id,
          partyName: cust.nameAr,
          date: '2026-11-07',
          items: [{ id: 'al1', productId: 'prod-g-1', productName: 'دقيق فاخر', quantity: 25, unitPrice: 1000, discount: 0, total: 25000 }],
          subtotal: 25000,
          discount: 0,
          tax: 0,
          total: 25000,
          paidAmount: 10000,
          paymentMethod: 'CASH',
          cashBoxId: 'cb-1',
        },
        totalCogs: 12500,
        stockDeductions: [{ productId: 'prod-g-1', quantity: 25 }],
        applyAdvanceAmount: 15000,
      },
    });
    assert.ok(advSale.advanceJournalEntry);
    assert.equal(advSale.advanceJournalEntry.referenceType, 'ADVANCE_SETTLEMENT');
    assert.equal(advSale.invoice.paidAmount, 25000);
    assert.equal(advSale.invoice.advanceAppliedAmount, 15000);
    assert.equal(backend.getCashBoxes({ token: adminToken }).find((b) => b.id === 'cb-1').balance, cbBefore + 10000);
    assert.equal(backend.getPartyById({ token: adminToken, id: cust.id }).advanceBalance, 15000);
    assert.equal(backend.getAccounts({ token: adminToken }).find((a) => a.code === '2103').balance, 15000);

    // Block reversal when advance was already spent
    assert.throws(
      () =>
        backend.reverseCashVoucherAtomic({
          token: adminToken,
          params: { voucherId: vOver.voucher.id, reversalReason: 'محاولة عكس غير مسموحة' },
        }),
      /قد استُخدم بالفعل/
    );

    // 4. Accountant manual override blocked, Admin draft->post override creates audit & reversal restores cleanly
    const sA = createSale('g-sa', '2026-11-08', 10);
    const sB = createSale('g-sb', '2026-11-09', 10);
    assert.throws(
      () =>
        backend.createCashVoucherAtomic({
          token: accToken,
          params: {
            voucher: {
              id: 'g-v-acc-fail',
              type: 'RECEIPT',
              voucherMode: 'CUSTOMER_RECEIPT',
              date: '2026-11-10',
              amount: 5000,
              cashBoxId: 'cb-1',
              partyId: cust.id,
              partyType: 'CUSTOMER',
              partyName: cust.nameAr,
              accountCode: '1103',
              description: 'محاولة تجاوز',
              costCenterId: 'general',
            },
            manualAllocations: [{ invoiceId: sB.id, allocatedAmount: 5000 }],
            overrideReason: 'اختبار',
          },
        }),
      /payment:allocation:override/
    );

    const draftVoucher = backend.createCashVoucherAtomic({
      token: adminToken,
      params: {
        voucher: {
          id: 'g-v-draft',
          type: 'RECEIPT',
          voucherMode: 'CUSTOMER_RECEIPT',
          date: '2026-11-10',
          amount: 5000,
          cashBoxId: 'cb-1',
          partyId: cust.id,
          partyType: 'CUSTOMER',
          partyName: cust.nameAr,
          accountCode: '1103',
          description: 'مسودة سند قبض',
          costCenterId: 'general',
          status: 'DRAFT',
        },
      },
    });
    assert.equal(draftVoucher.voucher.status, 'DRAFT');

    const postedDraft = backend.postDraftCashVoucherAtomic({
      token: adminToken,
      params: {
        voucherId: draftVoucher.voucher.id,
        manualAllocations: [{ invoiceId: sB.id, allocatedAmount: 5000 }],
        overrideReason: 'اعتماد تخصيص sB',
      },
    });
    assert.equal(postedDraft.voucher.status, 'POSTED');
    assert.equal(backend.getAllocationAudits({ token: adminToken, voucherId: postedDraft.voucher.id }).length, 1);

    assert.throws(
      () =>
        backend.cancelCashVoucherAtomic({
          token: adminToken,
          params: { voucherId: postedDraft.voucher.id, reason: 'محاولة إلغاء سند مرحل' },
        }),
      /إلغاء أو حذف سند مالي مرحّل/
    );

    const revOk = backend.reverseCashVoucherAtomic({
      token: adminToken,
      params: { voucherId: postedDraft.voucher.id, reversalReason: 'عكس موثق' },
    });
    assert.equal(revOk.voucher.status, 'REVERSED');
    assert.equal(backend.getInvoices({ token: adminToken }).find((x) => x.id === sB.id).paidAmount, 0);

    // FIN-04 SQLite parity: DRAFT persists manualAllocations & overrideReason and honors them on post({ voucherId })
    const manualDraft = backend.createCashVoucherAtomic({
      token: adminToken,
      params: {
        voucher: {
          id: 'g-v-draft-fin04',
          type: 'RECEIPT',
          voucherMode: 'CUSTOMER_RECEIPT',
          date: '2026-11-10',
          amount: 4000,
          cashBoxId: 'cb-1',
          partyId: cust.id,
          partyType: 'CUSTOMER',
          partyName: cust.nameAr,
          accountCode: '1103',
          description: 'مسودة بتخصيص يدوي محفوظ',
          costCenterId: 'general',
          status: 'DRAFT',
        },
        manualAllocations: [{ invoiceId: sB.id, allocatedAmount: 4000 }],
        overrideReason: 'تخصيص يدوي محفوظ داخل المسودة',
      },
    });
    assert.equal(manualDraft.voucher.manualOverride, true);
    assert.deepEqual(manualDraft.voucher.manualAllocations, [{ invoiceId: sB.id, allocatedAmount: 4000 }]);
    const postedFin04 = backend.postDraftCashVoucherAtomic({
      token: adminToken,
      params: { voucherId: manualDraft.voucher.id },
    });
    assert.equal(postedFin04.voucher.manualOverride, true);
    assert.equal(postedFin04.allocations.length, 1);
    assert.equal(postedFin04.allocations[0].invoiceId, sB.id);
    assert.equal(backend.getInvoices({ token: adminToken }).find((x) => x.id === sB.id).paidAmount, 4000);
    assert.equal(backend.getAllocationAudits({ token: adminToken, voucherId: manualDraft.voucher.id }).length, 1);
    backend.reverseCashVoucherAtomic({
      token: adminToken,
      params: { voucherId: manualDraft.voucher.id, reversalReason: 'إرجاع الحالة بعد اختبار FIN-04' },
    });

    // 5. Supplier purchase + FIFO payment + 1105 advance + block 5204 with supplier partyId
    backend.createPurchaseInvoiceAtomic({
      token: adminToken,
      params: {
        invoice: {
          id: 'g-pur-1',
          type: 'PURCHASE',
          activityId: 'grocery',
          partyId: sup.id,
          partyName: sup.nameAr,
          date: '2026-11-01',
          items: [{ id: 'gp1', productId: 'prod-g-1', productName: 'دقيق فاخر', quantity: 10, unitPrice: 500, discount: 0, total: 5000 }],
          subtotal: 5000,
          discount: 0,
          tax: 0,
          total: 5000,
          paidAmount: 0,
          paymentMethod: 'CREDIT',
          cashBoxId: 'cb-1',
        },
        itemsWithBatches: [{ productId: 'prod-g-1', quantity: 10, costPrice: 500 }],
      },
    });

    assert.throws(
      () =>
        backend.createCashVoucherAtomic({
          token: adminToken,
          params: {
            voucher: {
              id: 'g-sup-5204',
              type: 'PAYMENT',
              voucherMode: 'GENERAL',
              date: '2026-11-11',
              amount: 1000,
              cashBoxId: 'cb-1',
              partyId: sup.id,
              partyType: 'SUPPLIER',
              partyName: sup.nameAr,
              accountCode: '5204',
              description: 'محاولة خاطئة على 5204',
              costCenterId: 'general',
            },
          },
        }),
      /لا يجوز اختيار طرف/
    );

    const supPay = backend.createCashVoucherAtomic({
      token: adminToken,
      params: {
        voucher: {
          id: 'g-sup-pay',
          type: 'PAYMENT',
          voucherMode: 'SUPPLIER_PAYMENT',
          date: '2026-11-11',
          amount: 7000,
          cashBoxId: 'cb-1',
          partyId: sup.id,
          partyType: 'SUPPLIER',
          partyName: sup.nameAr,
          accountCode: '2101',
          description: 'سداد فاتورة + سلفة 1105',
          costCenterId: 'general',
        },
      },
    });
    assert.equal(supPay.voucher.appliedToDebtAmount, 5000);
    assert.equal(supPay.voucher.advanceAmount, 2000);
    assert.equal(backend.getPartyById({ token: adminToken, id: sup.id }).advanceBalance, 2000);
    assert.equal(backend.getAccounts({ token: adminToken }).find((a) => a.code === '1105').balance, 2000);

    // FIN-03 SQLite parity: enforce explicit cashBoxId when 2 boxes share 1101 & verify exact reversal
    backend.createCashBoxAtomic({
      token: adminToken,
      box: {
        id: 'cb-g-pos2',
        code: 'CB-G-2',
        type: 'CASH',
        nameAr: 'صندوق إضافي',
        accountCode: '1101',
        balance: 500,
        currency: 'YER',
        branchId: 'branch_main',
      },
    });
    assert.throws(
      () =>
        backend.createJournalEntryAtomic({
          token: adminToken,
          entry: {
            id: 'jv-g-ambig',
            date: '2026-11-12',
            description: 'قيد غامض بدون تحديد صندوق',
            costCenterId: 'general',
            branchId: 'branch_main',
            referenceType: 'MANUAL',
            lines: [
              { id: 'la1', accountCode: '5201', debit: 100, credit: 0 },
              { id: 'la2', accountCode: '1101', debit: 0, credit: 100 },
            ],
          },
        }),
      /تحديد الصندوق الفعلي/
    );
    const jvG = backend.createJournalEntryAtomic({
      token: adminToken,
      entry: {
        id: 'jv-g-ok',
        date: '2026-11-12',
        description: 'صرف نثري من الصندوق الإضافي',
        costCenterId: 'general',
        branchId: 'branch_main',
        referenceType: 'MANUAL',
        lines: [
          { id: 'lo1', accountCode: '5201', debit: 100, credit: 0 },
          { id: 'lo2', accountCode: '1101', cashBoxId: 'cb-g-pos2', debit: 0, credit: 100 },
        ],
      },
    });
    assert.equal(jvG.lines[1].cashBoxId, 'cb-g-pos2');
    assert.equal(backend.getCashBoxes({ token: adminToken }).find((b) => b.id === 'cb-g-pos2').balance, 400);
    const jvGRev = backend.reverseJournalEntryAtomic({
      token: adminToken,
      originalEntryId: jvG.id,
      reversalReason: 'اختبار عكس الصندوق المحدد',
    });
    assert.equal(jvGRev.lines[1].cashBoxId, 'cb-g-pos2');
    assert.equal(backend.getCashBoxes({ token: adminToken }).find((b) => b.id === 'cb-g-pos2').balance, 500);

    assertTrialBalanceZero(rt.database);
    rt.close();

    // 6. Verify backward-compatible import of v2.2.0 legacy backup JSON into fresh SQLite DB
    const rtLegacy = await openErpDatabase({ userDataPath: legacyImportPath, skipSeed: true });
    const legacyData = {
      branches: [
        { id: 'branch_main', tenantId: 'tenant_main', code: 'BR01', nameAr: 'الفرع الرئيسي', isMain: true, active: true, createdAt: '2026-11-01T00:00:00.000Z' },
      ],
      accounts: [
        { code: '1', nameAr: 'الأصول', type: 'ASSET', isLeaf: false, balance: 0 },
        { code: '11', nameAr: 'الأصول المتداولة', type: 'ASSET', parentCode: '1', isLeaf: false, balance: 0 },
        { code: '1101', nameAr: 'الصندوق', type: 'ASSET', parentCode: '11', isLeaf: true, balance: 500 },
        { code: '1103', nameAr: 'العملاء والمدينون', type: 'ASSET', parentCode: '11', isLeaf: true, balance: 200 },
      ],
      activities: [
        { id: 'grocery', nameAr: 'البقالة', code: 'GR', descriptionAr: 'البقالة', costCenterCode: 'CC-102', color: '#0f0', icon: 'cart', isInventoryManaged: true },
      ],
      products: [
        { id: 'p-leg', activityId: 'grocery', code: 'P-1', nameAr: 'صنف قديم', category: 'عام', unit: 'حبة', purchasePrice: 50, sellPrice: 100, currentStock: 10, minStockAlert: 1 },
      ],
      productBatches: [],
      parties: [
        // v2.2.0 party without advanceBalance field
        { id: 'c-leg', type: 'CUSTOMER', nameAr: 'عميل قديم', phone: '777000111', balance: 200 },
      ],
      invoices: [
        // v2.2.0 invoice without status / advanceAppliedAmount / dueDate
        {
          id: 'inv-leg',
          invoiceNumber: 'INV-OLD-1',
          type: 'SALE',
          activityId: 'grocery',
          branchId: 'branch_main',
          partyId: 'c-leg',
          partyName: 'عميل قديم',
          date: '2026-10-15',
          items: [{ id: 'il1', productId: 'p-leg', productName: 'صنف قديم', productCode: 'P-1', unit: 'حبة', quantity: 2, unitPrice: 100, discount: 0, total: 200 }],
          subtotal: 200,
          discount: 0,
          tax: 0,
          total: 200,
          paidAmount: 0,
          paymentMethod: 'CREDIT',
          cashBoxId: 'cb-1',
        },
      ],
      journalEntries: [],
      cashBoxes: [
        { id: 'cb-1', code: 'CB-1', nameAr: 'الصندوق الرئيسي', accountCode: '1101', balance: 500, isDefault: true, branchId: 'branch_main' },
      ],
      vouchers: [
        // v2.2.0 voucher without voucherMode / status
        {
          id: 'v-leg',
          voucherNumber: 'RCT-OLD-1',
          type: 'RECEIPT',
          date: '2026-10-16',
          amount: 100,
          cashBoxId: 'cb-1',
          branchId: 'branch_main',
          partyId: 'c-leg',
          partyName: 'عميل قديم',
          accountCode: '1103',
          description: 'سند قديم',
          costCenterId: 'general',
        },
      ],
      amanat: [],
      users: [
        {
          id: 'u-leg-admin',
          tenantId: 'tenant_main',
          username: 'admin',
          fullName: 'مدير',
          role: 'ADMIN',
          allowedActivities: ['grocery'],
          branchId: 'branch_main',
          allowedBranches: ['branch_main'],
          active: true,
          passwordHash: hashPasswordForDesktop('LegacyPass#2026'),
          mustChangePassword: false,
          failedLoginAttempts: 0,
        },
      ],
      auditLogs: [],
      outbox: [],
      syncConflicts: [],
      sequences: [],
    };
    const legacyPayload = {
      systemIdentifier: 'multi_activity_erp',
      version: '2.2.0',
      schemaVersion: '2.2.0',
      exportedAt: '2026-10-20T00:00:00.000Z',
      checksum: legacyChecksum(legacyData),
      data: legacyData,
    };

    const impRes = await importLegacyBackup(
      rtLegacy.database,
      rtLegacy.backupDirectory,
      JSON.stringify(legacyPayload)
    );
    assert.equal(impRes.success, true);

    const authLeg = new DesktopAuthenticationService(rtLegacy.database);
    const backendLeg = createDesktopBackend({
      database: rtLegacy.database,
      backupDirectory: rtLegacy.backupDirectory,
      authenticationService: authLeg,
    });
    const legToken = authLeg.authenticate({ username: 'admin', password: 'LegacyPass#2026' }).token;
    const importedParty = backendLeg.getPartyById({ token: legToken, id: 'c-leg' });
    assert.equal(importedParty.advanceBalance, 0);
    const importedVoucher = backendLeg.getVouchers({ token: legToken }).find((v) => v.id === 'v-leg');
    assert.equal(importedVoucher.status, 'POSTED');
    rtLegacy.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
    rmSync(legacyImportPath, { recursive: true, force: true });
  }
});

