import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { openErpDatabase } from '../../electron/sqlite/database.mjs';
import { DesktopAuthenticationService, hashPasswordForDesktop } from '../../electron/security/authentication.mjs';
import { createDesktopBackend } from '../../electron/sqlite/desktop-backend.mjs';
import { importLegacyBackup } from '../../electron/sqlite/legacy-backup-importer.mjs';
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

function legacyChecksum(data) {
  const serialized = JSON.stringify(data);
  let checksum = 0;
  for (let index = 0; index < serialized.length; index += 1) {
    checksum = (checksum + serialized.charCodeAt(index) * (index + 1)) % 1000000007;
  }
  return checksum.toString(16);
}

test('PVAR-008 SQLite migration 005->006 preserves NULL on historical invoice rows and supports legacy returns', async () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-pvar008-mig-'));
  try {
    const migrationsSource = fileURLToPath(new URL('../../electron/sqlite/migrations/', import.meta.url));
    const v5MigrationsDir = path.join(userDataPath, 'migrations-v5');
    mkdirSync(v5MigrationsDir, { recursive: true });
    for (const filename of readdirSync(migrationsSource).filter((name) => /^00[1-5]_.*\.sql$/.test(name))) {
      copyFileSync(path.join(migrationsSource, filename), path.join(v5MigrationsDir, filename));
    }

    const v5Runtime = await openErpDatabase({ userDataPath, migrationsDirectory: v5MigrationsDir });
    assert.equal(v5Runtime.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 5);
    const v5Auth = new DesktopAuthenticationService(v5Runtime.database);
    const v5Backend = createDesktopBackend({
      database: v5Runtime.database,
      backupDirectory: v5Runtime.backupDirectory,
      authenticationService: v5Auth,
    });
    v5Auth.createInitialAdmin({ username: 'admin', fullName: 'المدير العام', password: 'AdminPass#2026' });
    const v5Token = v5Auth.authenticate({ username: 'admin', password: 'AdminPass#2026' }).token;

    v5Backend.saveProductAtomic({
      token: v5Token,
      product: {
        id: 'legacy-prod-1',
        activityId: 'grocery',
        code: 'LEG-001',
        nameAr: 'صنف قديم',
        category: 'عام',
        unit: 'علبة',
        purchasePrice: 10,
        sellPrice: 15,
        currentStock: 20,
        minStockAlert: 2,
      },
    });
    const cust = v5Backend.savePartyAtomic({
      token: v5Token,
      party: { id: 'legacy-cust-1', type: 'CUSTOMER', nameAr: 'عميل قديم', phone: '777111000', balance: 0 },
    });

    // Seed pre-006 sale directly at SQL level
    v5Runtime.database.prepare(
      'INSERT INTO invoices (tenant_id,id,branch_id,invoice_number,invoice_type,activity_id,party_id,invoice_date,payment_method,total_decimal,paid_amount_decimal,status,data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      'tenant_main',
      'legacy-inv-1',
      'branch_main',
      'INV-LEG-1',
      'SALE',
      'grocery',
      cust.id,
      '2026-11-20',
      'CREDIT',
      '30.00',
      '0.00',
      'POSTED',
      JSON.stringify({
        id: 'legacy-inv-1',
        invoiceNumber: 'INV-LEG-1',
        type: 'SALE',
        activityId: 'grocery',
        branchId: 'branch_main',
        partyId: cust.id,
        partyName: cust.nameAr,
        date: '2026-11-20',
        items: [
          {
            id: 'legacy-line-1',
            productId: 'legacy-prod-1',
            productName: 'صنف قديم',
            unit: 'علبة',
            quantity: 2,
            unitPrice: 15,
            discount: 0,
            total: 30,
          },
        ],
        subtotal: 30,
        discount: 0,
        tax: 0,
        total: 30,
        paidAmount: 0,
        paymentMethod: 'CREDIT',
        status: 'POSTED',
        isPosted: true,
      })
    );
    v5Runtime.database.prepare(
      'INSERT INTO invoice_items (tenant_id,invoice_id,id,product_id,quantity_decimal,unit_price_decimal,total_decimal,data_json) VALUES (?,?,?,?,?,?,?,?)'
    ).run(
      'tenant_main',
      'legacy-inv-1',
      'legacy-line-1',
      'legacy-prod-1',
      '2.0000',
      '15.00',
      '30.00',
      JSON.stringify({ id: 'legacy-line-1', productId: 'legacy-prod-1', productName: 'صنف قديم', unit: 'علبة', quantity: 2, unitPrice: 15, discount: 0, total: 30 })
    );
    v5Runtime.database.prepare(
      'INSERT INTO invoice_stock_deductions (tenant_id,invoice_id,line_number,product_id,quantity_decimal,unit_cost_decimal,data_json) VALUES (?,?,?,?,?,?,?)'
    ).run(
      'tenant_main',
      'legacy-inv-1',
      0,
      'legacy-prod-1',
      '2.0000',
      '10.00',
      JSON.stringify({ productId: 'legacy-prod-1', quantity: 2, unitCost: 10 })
    );
    v5Runtime.close();

    // Upgrade to v6+
    const v6Runtime = await openErpDatabase({ userDataPath });
    const upgradedVersion = v6Runtime.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version;
    assert.ok(upgradedVersion >= 6, `Expected upgraded schema version >= 6, got ${upgradedVersion}`);
    assert.equal(v6Runtime.database.prepare('SELECT version FROM schema_migrations WHERE version=6').get()?.version, 6);

    const legacyItemRow = v6Runtime.database
      .prepare('SELECT base_quantity_decimal FROM invoice_items WHERE id=?')
      .get('legacy-line-1');
    assert.equal(legacyItemRow.base_quantity_decimal, null);
    const legacyDedRow = v6Runtime.database
      .prepare('SELECT invoice_item_id FROM invoice_stock_deductions WHERE invoice_id=?')
      .get('legacy-inv-1');
    assert.equal(legacyDedRow.invoice_item_id, null);

    // Returning from legacy invoice still works
    const v6Auth = new DesktopAuthenticationService(v6Runtime.database);
    const v6Backend = createDesktopBackend({
      database: v6Runtime.database,
      backupDirectory: v6Runtime.backupDirectory,
      authenticationService: v6Auth,
    });
    const v6Token = v6Auth.authenticate({ username: 'admin', password: 'AdminPass#2026' }).token;
    v6Backend.createJournalEntryAtomic({
      token: v6Token,
      entry: {
        id: 'jv-leg-init',
        date: '2026-11-20',
        description: 'قيد مبيعات سابقة',
        costCenterId: 'grocery',
        branchId: 'branch_main',
        referenceType: 'MANUAL',
        lines: [
          { id: 'l1', accountCode: '1103', debit: 30, credit: 0 },
          { id: 'l2', accountCode: '4101', debit: 0, credit: 30 },
        ],
      },
    });
    const legRet = v6Backend.createSalesReturnAtomic({
      token: v6Token,
      params: {
        originalInvoiceId: 'legacy-inv-1',
        items: [{ productId: 'legacy-prod-1', quantity: 1 }],
        returnReason: 'مرتجع فاتورة قديمة',
        refundMethod: 'AR_OFFSET',
        date: '2026-11-21',
      },
    });
    assert.equal(legRet.invoice.items[0].originalInvoiceItemId, 'legacy-line-1');
    assert.equal(v6Backend.getProductById({ token: v6Token, id: 'legacy-prod-1' }).currentStock, 21);

    assert.deepEqual(v6Runtime.database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(v6Runtime.database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    v6Runtime.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('PVAR-008 SQLite full parity: purchase/sale/return alternate units, dual lines, historical snapshot isolation, cross-tenant/activity guards & legacy importer', async () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-pvar008-ops-'));
  try {
    const rt = await openErpDatabase({ userDataPath });
    const auth = new DesktopAuthenticationService(rt.database);
    const backend = createDesktopBackend({
      database: rt.database,
      backupDirectory: rt.backupDirectory,
      authenticationService: auth,
    });

    auth.createInitialAdmin({ username: 'admin', fullName: 'المدير العام', password: 'AdminPass#2026' });
    const adminToken = auth.authenticate({ username: 'admin', password: 'AdminPass#2026' }).token;

    // Seed pharmacy-only cashier to verify activity isolation
    backend.createUser({
      token: adminToken,
      input: {
        username: 'ph_cashier',
        fullName: 'كاشير صيدلية',
        role: 'CASHIER',
        allowedActivities: ['pharmacy'],
        branchId: 'branch_main',
        allowedBranches: ['branch_main'],
        plainPassword: 'CashierPass#2026',
      },
    });
    const phCashierToken = auth.authenticate({ username: 'ph_cashier', password: 'CashierPass#2026' }).token;

    backend.createJournalEntryAtomic({
      token: adminToken,
      entry: {
        id: 'jv-pvar008-cap',
        date: '2026-11-01',
        description: 'رأس مال اختبار الوحدات',
        costCenterId: 'general',
        branchId: 'branch_main',
        referenceType: 'MANUAL',
        lines: [
          { id: 'c1', accountCode: '1101', debit: 100000, credit: 0 },
          { id: 'c2', accountCode: '3101', debit: 0, credit: 100000 },
        ],
      },
    });

    const prod = backend.saveProductAtomic({
      token: adminToken,
      product: {
        id: 'sq-u-prod-1',
        activityId: 'grocery',
        code: 'SQ-JUICE-01',
        barcode: '629900000001',
        nameAr: 'عصير معلب',
        category: 'مشروبات',
        unit: 'حبة',
        purchasePrice: 5,
        sellPrice: 8,
        currentStock: 0,
        minStockAlert: 5,
        isActive: true,
      },
    });

    const otherProd = backend.saveProductAtomic({
      token: adminToken,
      product: {
        id: 'sq-u-prod-2',
        activityId: 'grocery',
        code: 'SQ-OTHER-02',
        nameAr: 'بسكويت',
        category: 'حلويات',
        unit: 'حبة',
        purchasePrice: 2,
        sellPrice: 4,
        currentStock: 10,
        minStockAlert: 2,
        isActive: true,
      },
    });

    const unitCarton = backend.saveProductUnit({
      token: adminToken,
      unit: {
        id: 'sq-unit-carton',
        productId: prod.id,
        code: 'CTN24',
        nameAr: 'كرتون',
        baseUnitsNumerator: 24,
        baseUnitsDenominator: 1,
        barcode: '6299000011111',
        isActive: true,
      },
    });

    const unitThird = backend.saveProductUnit({
      token: adminToken,
      unit: {
        id: 'sq-unit-third',
        productId: prod.id,
        code: 'PART3',
        nameAr: 'ثلث',
        baseUnitsNumerator: 1,
        baseUnitsDenominator: 3,
        isActive: true,
      },
    });

    const unitOther = backend.saveProductUnit({
      token: adminToken,
      unit: {
        id: 'sq-unit-other',
        productId: otherProd.id,
        code: 'PACK10',
        nameAr: 'شدة',
        baseUnitsNumerator: 10,
        baseUnitsDenominator: 1,
        isActive: true,
      },
    });

    const supplier = backend.savePartyAtomic({
      token: adminToken,
      party: { id: 'sq-sup-1', type: 'SUPPLIER', nameAr: 'مورد', phone: '777100100', balance: 0 },
    });
    const customer = backend.savePartyAtomic({
      token: adminToken,
      party: { id: 'sq-cust-1', type: 'CUSTOMER', nameAr: 'عميل', phone: '777200200', balance: 0 },
    });

    // 1. Purchase 2 cartons (48 base) with tampered baseQuantity -> server enforces 48
    const purRes = backend.createPurchaseInvoiceAtomic({
      token: adminToken,
      params: {
        invoice: {
          id: 'sq-pur-1',
          type: 'PURCHASE',
          activityId: 'grocery',
          branchId: 'branch_main',
          partyId: supplier.id,
          partyName: supplier.nameAr,
          date: '2026-11-28',
          items: [
            {
              id: 'sq-pur-line-1',
              productId: prod.id,
              productName: prod.nameAr,
              productCode: prod.code,
              unit: unitCarton.nameAr,
              unitId: unitCarton.id,
              quantity: 2,
              baseQuantity: 5, // tampered
              unitPrice: 120,
              discount: 0,
              total: 240,
            },
          ],
          subtotal: 240,
          discount: 0,
          tax: 0,
          total: 240,
          paidAmount: 0,
          paymentMethod: 'CREDIT',
          cashBoxId: 'cb-1',
        },
        itemsWithBatches: [
          {
            invoiceItemId: 'sq-pur-line-1',
            productId: prod.id,
            unitId: unitCarton.id,
            quantity: 2,
            costPrice: 120,
          },
        ],
      },
    });
    assert.equal(purRes.invoice.items[0].baseQuantity, 48);
    assert.equal(backend.getProductById({ token: adminToken, id: prod.id }).currentStock, 48);
    const purItemDb = rt.database.prepare('SELECT base_quantity_decimal FROM invoice_items WHERE id=?').get('sq-pur-line-1');
    assert.equal(purItemDb.base_quantity_decimal, '48.0000');

    // 2. Reject cross-product unit, unsafe fractional unit, and unauthorized activity
    assert.throws(
      () =>
        backend.createSalesInvoiceAtomic({
          token: adminToken,
          params: {
            invoice: {
              id: 'sq-bad-unit',
              type: 'SALE',
              activityId: 'grocery',
              branchId: 'branch_main',
              partyName: 'عميل نقدي',
              date: '2026-11-28',
              items: [
                {
                  id: 'sq-bad-1',
                  productId: prod.id,
                  productName: prod.nameAr,
                  unit: 'شدة',
                  unitId: unitOther.id,
                  quantity: 1,
                  unitPrice: 80,
                  discount: 0,
                  total: 80,
                },
              ],
              subtotal: 80,
              discount: 0,
              tax: 0,
              total: 80,
              paidAmount: 80,
              paymentMethod: 'CASH',
              cashBoxId: 'cb-1',
            },
            totalCogs: 50,
            stockDeductions: [{ invoiceItemId: 'sq-bad-1', productId: prod.id, quantity: 10 }],
          },
        }),
      /لا تنتمي للصنف|لا تنتمي لهذا الصنف|غير صالحة|غير موجودة/
    );

    assert.throws(
      () =>
        backend.createSalesInvoiceAtomic({
          token: adminToken,
          params: {
            invoice: {
              id: 'sq-bad-frac',
              type: 'SALE',
              activityId: 'grocery',
              branchId: 'branch_main',
              partyName: 'عميل نقدي',
              date: '2026-11-28',
              items: [
                {
                  id: 'sq-bad-2',
                  productId: prod.id,
                  productName: prod.nameAr,
                  unit: 'ثلث',
                  unitId: unitThird.id,
                  quantity: 1,
                  unitPrice: 3,
                  discount: 0,
                  total: 3,
                },
              ],
              subtotal: 3,
              discount: 0,
              tax: 0,
              total: 3,
              paidAmount: 3,
              paymentMethod: 'CASH',
              cashBoxId: 'cb-1',
            },
            totalCogs: 1.67,
            stockDeductions: [{ invoiceItemId: 'sq-bad-2', productId: prod.id, quantity: 0.3333 }],
          },
        }),
      /بدقة مخزنية آمنة/
    );

    assert.throws(
      () =>
        backend.createSalesInvoiceAtomic({
          token: phCashierToken,
          params: {
            invoice: {
              id: 'sq-bad-act',
              type: 'SALE',
              activityId: 'grocery',
              branchId: 'branch_main',
              partyName: 'عميل نقدي',
              date: '2026-11-28',
              items: [
                {
                  id: 'sq-bad-3',
                  productId: prod.id,
                  productName: prod.nameAr,
                  unit: 'حبة',
                  unitId: 'BASE',
                  quantity: 1,
                  unitPrice: 8,
                  discount: 0,
                  total: 8,
                },
              ],
              subtotal: 8,
              discount: 0,
              tax: 0,
              total: 8,
              paidAmount: 8,
              paymentMethod: 'CASH',
              cashBoxId: 'cb-1',
            },
            totalCogs: 5,
            stockDeductions: [{ invoiceItemId: 'sq-bad-3', productId: prod.id, quantity: 1 }],
          },
        }),
      /النشاط|صلاحية/
    );

    // 3. Dual-unit sale on single invoice: 3 pieces + 1 carton (24) = 27 base -> stock 48 -> 21
    const saleRes = backend.createSalesInvoiceAtomic({
      token: adminToken,
      params: {
        invoice: {
          id: 'sq-sale-dual',
          type: 'SALE',
          activityId: 'grocery',
          branchId: 'branch_main',
          partyId: customer.id,
          partyName: customer.nameAr,
          date: '2026-11-28',
          items: [
            {
              id: 'sq-sale-line-base',
              productId: prod.id,
              productName: prod.nameAr,
              productCode: prod.code,
              unit: 'حبة',
              unitId: 'BASE',
              quantity: 3,
              unitPrice: 8,
              discount: 0,
              total: 24,
            },
            {
              id: 'sq-sale-line-carton',
              productId: prod.id,
              productName: prod.nameAr,
              productCode: prod.code,
              unit: unitCarton.nameAr,
              unitId: unitCarton.id,
              quantity: 1,
              baseQuantity: 2, // tampered
              unitPrice: 192,
              discount: 0,
              total: 192,
            },
          ],
          subtotal: 216,
          discount: 0,
          tax: 0,
          total: 216,
          paidAmount: 0,
          paymentMethod: 'CREDIT',
          cashBoxId: 'cb-1',
        },
        totalCogs: 135,
        stockDeductions: [
          { invoiceItemId: 'sq-sale-line-base', productId: prod.id, quantity: 3 },
          { invoiceItemId: 'sq-sale-line-carton', productId: prod.id, quantity: 24 },
        ],
      },
    });
    assert.equal(saleRes.invoice.items[0].baseQuantity, 3);
    assert.equal(saleRes.invoice.items[1].baseQuantity, 24);
    assert.equal(backend.getProductById({ token: adminToken, id: prod.id }).currentStock, 21);

    const dedRow = rt.database
      .prepare('SELECT invoice_item_id, quantity_decimal FROM invoice_stock_deductions WHERE invoice_id=? AND invoice_item_id=?')
      .get('sq-sale-dual', 'sq-sale-line-carton');
    assert.equal(dedRow.invoice_item_id, 'sq-sale-line-carton');
    assert.equal(dedRow.quantity_decimal, '24.0000');

    // 4. Mutate & deactivate carton unit, then return 1 carton using historical 24x snapshot
    backend.saveProductUnit({
      token: adminToken,
      unit: {
        id: unitCarton.id,
        productId: prod.id,
        code: 'CTN24',
        nameAr: 'كرتون معدل',
        baseUnitsNumerator: 10,
        baseUnitsDenominator: 1,
        isActive: false,
      },
    });

    const saleRet = backend.createSalesReturnAtomic({
      token: adminToken,
      params: {
        originalInvoiceId: saleRes.invoice.id,
        items: [{ originalInvoiceItemId: 'sq-sale-line-carton', productId: prod.id, quantity: 1 }],
        returnReason: 'إرجاع كرتون بعد تعديل الوحدة',
        refundMethod: 'AR_OFFSET',
        date: '2026-11-28',
      },
    });
    assert.equal(saleRet.invoice.items[0].originalInvoiceItemId, 'sq-sale-line-carton');
    assert.equal(saleRet.invoice.items[0].baseQuantity, 24);
    assert.equal(saleRet.invoice.items[0].conversionNumeratorSnapshot, 24);
    assert.equal(backend.getProductById({ token: adminToken, id: prod.id }).currentStock, 45);

    const purRet = backend.createPurchaseReturnAtomic({
      token: adminToken,
      params: {
        originalInvoiceId: purRes.invoice.id,
        items: [{ originalInvoiceItemId: 'sq-pur-line-1', productId: prod.id, quantity: 1 }],
        returnReason: 'إرجاع كرتون للمورد',
        refundMethod: 'AP_OFFSET',
        date: '2026-11-28',
      },
    });
    assert.equal(purRet.invoice.items[0].baseQuantity, 24);
    assert.equal(backend.getProductById({ token: adminToken, id: prod.id }).currentStock, 21);

    assertTrialBalanceZero(rt.database);
    assert.deepEqual(rt.database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(rt.database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    rt.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('PVAR-008 legacy backup importer preserves NULL on legacy rows and imports baseQuantity/invoiceItemId on unit-enabled backups', async () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-pvar008-imp-'));
  try {
    const rt = await openErpDatabase({ userDataPath });
    const data = {
      branches: [
        { id: 'branch_main', tenantId: 'tenant_main', code: 'BR01', nameAr: 'الفرع الرئيسي', isMain: true, active: true, createdAt: '2026-11-01T00:00:00.000Z' },
      ],
      activities: [
        { id: 'grocery', nameAr: 'البقالة', code: 'GR', descriptionAr: 'بقالة', costCenterCode: 'CC-GR', color: '#0f0', icon: 'box', isInventoryManaged: true },
      ],
      accounts: [
        { code: '1000', nameAr: 'الأصول', type: 'ASSET', parentCode: null, isLeaf: false, balance: 500 },
        { code: '1101', nameAr: 'الصندوق', type: 'ASSET', parentCode: '1000', isLeaf: true, balance: 500 },
        { code: '4101', nameAr: 'المبيعات', type: 'REVENUE', parentCode: null, isLeaf: true, balance: 28 },
      ],
      products: [
        { id: 'imp-p1', activityId: 'grocery', code: 'IMP-1', nameAr: 'ماء', category: 'عام', unit: 'حبة', purchasePrice: 1, sellPrice: 2, currentStock: 26, minStockAlert: 1 },
      ],
      productUnits: [
        { id: 'imp-u1', tenantId: 'tenant_main', productId: 'imp-p1', code: 'CTN', nameAr: 'كرتون', baseUnitsNumerator: 12, baseUnitsDenominator: 1, isActive: true, createdAt: '2026-11-28T00:00:00.000Z', updatedAt: '2026-11-28T00:00:00.000Z' },
      ],
      parties: [],
      cashBoxes: [
        { id: 'cash-main', code: 'CASH-MAIN', nameAr: 'الصندوق الرئيسي', accountCode: '1101', balance: 500, isDefault: true, branchId: 'branch_main' },
      ],
      vouchers: [],
      users: [
        {
          id: 'user-admin',
          tenantId: 'tenant_main',
          username: 'admin',
          fullName: 'مدير النظام',
          role: 'ADMIN',
          allowedActivities: ['grocery'],
          branchId: 'branch_main',
          allowedBranches: ['branch_main'],
          active: true,
          passwordHash: hashPasswordForDesktop('AdminPass#2026'),
          mustChangePassword: false,
          failedLoginAttempts: 0,
        },
      ],
      invoices: [
        {
          id: 'imp-inv-legacy',
          invoiceNumber: 'INV-L1',
          type: 'SALE',
          activityId: 'grocery',
          branchId: 'branch_main',
          partyName: 'عميل قديم',
          date: '2026-11-10',
          items: [
            { id: 'imp-line-leg', productId: 'imp-p1', productName: 'ماء', unit: 'حبة', quantity: 2, unitPrice: 2, discount: 0, total: 4 },
          ],
          subtotal: 4, discount: 0, tax: 0, total: 4, paidAmount: 4, paymentMethod: 'CASH', cashBoxId: 'cash-main', status: 'POSTED', isPosted: true,
          stockDeductionsRecorded: [{ productId: 'imp-p1', quantity: 2, unitCost: 1 }],
        },
        {
          id: 'imp-inv-unit',
          invoiceNumber: 'INV-U1',
          type: 'SALE',
          activityId: 'grocery',
          branchId: 'branch_main',
          partyName: 'عميل وحدة',
          date: '2026-11-28',
          items: [
            {
              id: 'imp-line-unit',
              productId: 'imp-p1',
              productName: 'ماء',
              unit: 'كرتون',
              unitId: 'imp-u1',
              unitNameSnapshot: 'كرتون',
              baseUnitNameSnapshot: 'حبة',
              conversionNumeratorSnapshot: 12,
              conversionDenominatorSnapshot: 1,
              baseQuantity: 12,
              quantity: 1,
              unitPrice: 24,
              discount: 0,
              total: 24,
            },
          ],
          subtotal: 24, discount: 0, tax: 0, total: 24, paidAmount: 24, paymentMethod: 'CASH', cashBoxId: 'cash-main', status: 'POSTED', isPosted: true,
          stockDeductionsRecorded: [{ invoiceItemId: 'imp-line-unit', productId: 'imp-p1', quantity: 12, unitCost: 1 }],
        },
      ],
      journalEntries: [
        {
          id: 'imp-je-1', entryNumber: 'JE-1', date: '2026-11-28', description: 'استيراد', costCenterId: 'grocery', branchId: 'branch_main', status: 'POSTED',
          lines: [
            { id: 'jd', accountCode: '1101', accountName: 'الصندوق', debit: 28, credit: 0 },
            { id: 'jc', accountCode: '4101', accountName: 'المبيعات', debit: 0, credit: 28 },
          ],
        },
      ],
    };
    const raw = JSON.stringify({
      app: 'نظام الإدارة التجارية والمحاسبية المتكامل',
      systemIdentifier: 'multi_activity_erp',
      version: '2.2.0',
      exportedAt: '2026-11-28T00:00:00.000Z',
      checksum: legacyChecksum(data),
      data,
    });
    const res = await importLegacyBackup(rt.database, rt.backupDirectory, raw);
    assert.equal(res.success, true);

    assert.equal(rt.database.prepare('SELECT base_quantity_decimal FROM invoice_items WHERE id=?').get('imp-line-leg').base_quantity_decimal, null);
    assert.equal(rt.database.prepare('SELECT base_quantity_decimal FROM invoice_items WHERE id=?').get('imp-line-unit').base_quantity_decimal, '12');
    assert.equal(rt.database.prepare('SELECT invoice_item_id FROM invoice_stock_deductions WHERE invoice_id=?').get('imp-inv-legacy').invoice_item_id, null);
    assert.equal(rt.database.prepare('SELECT invoice_item_id FROM invoice_stock_deductions WHERE invoice_id=?').get('imp-inv-unit').invoice_item_id, 'imp-line-unit');
    rt.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
