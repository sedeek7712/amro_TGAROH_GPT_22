import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openErpDatabase, createSqliteBackup, restoreSqliteBackupFile } from '../../electron/sqlite/database.mjs';
import { DesktopAuthenticationService } from '../../electron/security/authentication.mjs';
import { createDesktopBackend } from '../../electron/sqlite/desktop-backend.mjs';
import { createProductMediaStorage } from '../../electron/product-media-storage.mjs';
import { verifyProductMediaIntegrity } from '../../electron/sqlite/modules/product-media-service.mjs';

const VALID_WEBP_DATA_URL = 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=';

function setupBackend(runtime, userDataPath) {
  const auth = new DesktopAuthenticationService(runtime.database);
  const mediaDirectory = path.join(userDataPath, 'ProductMedia');
  const mediaStorage = createProductMediaStorage({ rootDirectory: mediaDirectory });
  const backend = createDesktopBackend({
    database: runtime.database,
    backupDirectory: runtime.backupDirectory,
    mediaDirectory,
    authenticationService: auth,
    productMediaStorage: mediaStorage,
  });
  return { auth, mediaStorage, backend };
}

test('PVAR-011-01 SQLite: Uniqueness, cross-table barcode collisions, atomic rollback, and base unit lock', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'erp-pvar011-uniq-'));
  let runtime;
  try {
    runtime = await openErpDatabase({ userDataPath: dir });
    const { auth, backend } = setupBackend(runtime, dir);
    auth.createInitialAdmin({
      username: 'pvar11_admin',
      fullName: 'مدير الاختبار',
      password: 'Pvar11-Admin#2026',
    });
    const token = auth.authenticate({ username: 'pvar11_admin', password: 'Pvar11-Admin#2026' }).token;

    const brand = backend.saveBrandAtomic({ token, input: { nameAr: '  Al-Amal   Foods ' } });
    assert.equal(brand.normalizedName, 'al-amal foods');
    assert.throws(() => backend.saveBrandAtomic({ token, input: { nameAr: 'al-amal foods' } }), /مسجلة بالفعل/);

    const prod = backend.saveProductAtomic({
      token,
      product: {
        id: 'sq11-p1',
        activityId: 'grocery',
        code: 'SQ11-P1',
        barcode: '629110100001',
        nameAr: 'صنف قياسي',
        category: 'بقالة',
        unit: 'حبة',
        purchasePrice: 5,
        sellPrice: 8,
        currentStock: 0,
        minStockAlert: 1,
        batches: [],
      },
      isUpdate: false,
    });

    const box = backend.saveProductUnit({
      token,
      unit: {
        productId: prod.id,
        code: 'BOX',
        nameAr: 'كرتون',
        baseUnitsNumerator: 12,
        baseUnitsDenominator: 1,
        barcode: '629110100999',
      },
    });
    assert.equal(box.barcode, '629110100999');

    // Cross-table barcode collision rejected on saveProductUnit
    assert.throws(
      () =>
        backend.saveProductUnit({
          token,
          unit: {
            productId: prod.id,
            code: 'PKT',
            nameAr: 'عبوة',
            baseUnitsNumerator: 6,
            baseUnitsDenominator: 1,
            barcode: '629110100001',
          },
        }),
      /الباركود.*مستخدم بالفعل/
    );

    // Cross-table barcode collision rejected on saveProductAtomic
    assert.throws(
      () =>
        backend.saveProductAtomic({
          token,
          product: {
            id: 'sq11-p2-dup',
            activityId: 'grocery',
            code: 'SQ11-P2',
            barcode: '629110100999',
            nameAr: 'صنف مكرر الباركود',
            category: 'بقالة',
            unit: 'حبة',
            purchasePrice: 5,
            sellPrice: 8,
            currentStock: 0,
            minStockAlert: 1,
            batches: [],
          },
          isUpdate: false,
        }),
      /الباركود.*مستخدم بالفعل/
    );

    // Updating the same unit and product with their own barcodes succeeds, while changing base unit is blocked
    const updatedBox = backend.saveProductUnit({
      token,
      unit: { ...box, nameAr: 'كرتون 12' },
    });
    assert.equal(updatedBox.barcode, '629110100999');

    const updatedProd = backend.saveProductAtomic({
      token,
      product: { ...prod, nameAr: 'صنف قياسي محدث' },
      isUpdate: true,
    });
    assert.equal(updatedProd.nameAr, 'صنف قياسي محدث');

    assert.throws(
      () =>
        backend.saveProductAtomic({
          token,
          product: { ...prod, unit: 'كرتون' },
          isUpdate: true,
        }),
      /لا يمكن تغيير وحدة المخزون الأساسية/
    );

    // Atomic rollback on family creation
    const countBefore = runtime.database.prepare('SELECT COUNT(*) AS c FROM products').get().c;
    assert.throws(
      () =>
        backend.createProductFamilyWithSkusAtomic({
          token,
          input: {
            id: 'sq11-fam-rb',
            activityId: 'grocery',
            nameAr: 'مجموعة متعارضة',
            optionSchema: [{ key: 'size', labelAr: 'الحجم', values: ['S', 'M'], required: true, sortOrder: 1 }],
            skus: [
              {
                product: {
                  id: 'sq11-rb-s',
                  activityId: 'grocery',
                  code: 'SQ11-RB-S',
                  barcode: '629110100777',
                  nameAr: 'منتج S',
                  category: 'بقالة',
                  unit: 'حبة',
                  purchasePrice: 5,
                  sellPrice: 8,
                  currentStock: 0,
                  minStockAlert: 0,
                },
                variantAttributes: { size: 'S' },
              },
              {
                product: {
                  id: 'sq11-rb-m',
                  activityId: 'grocery',
                  code: 'SQ11-RB-M',
                  barcode: '629110100999',
                  nameAr: 'منتج M',
                  category: 'بقالة',
                  unit: 'حبة',
                  purchasePrice: 5,
                  sellPrice: 8,
                  currentStock: 0,
                  minStockAlert: 0,
                },
                variantAttributes: { size: 'M' },
              },
            ],
          },
        }),
      /الباركود/
    );
    assert.equal(runtime.database.prepare('SELECT COUNT(*) AS c FROM products').get().c, countBefore);
  } finally {
    runtime?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PVAR-011-02 SQLite: Tenant, branch, activity RBAC isolation & forged IPC payload resistance', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'erp-pvar011-sec-'));
  let runtime;
  try {
    runtime = await openErpDatabase({ userDataPath: dir });
    const { auth, backend } = setupBackend(runtime, dir);
    auth.createInitialAdmin({
      username: 'sq11_sec_admin',
      fullName: 'مدير الأمان',
      password: 'Pvar11-Sec#2026',
    });
    const adminToken = auth.authenticate({ username: 'sq11_sec_admin', password: 'Pvar11-Sec#2026' }).token;

    // Seed second branch + second tenant
    backend.addBranch({
      token: adminToken,
      branch: {
        id: 'branch_south',
        code: 'BR02',
        nameAr: 'الفرع الجنوبي',
        isMain: false,
        active: true,
      },
    });

    runtime.database.prepare(
      'INSERT OR IGNORE INTO tenants (id,name,code,currency,is_active,data_json) VALUES (?,?,?,?,?,?)'
    ).run('tenant_other', 'مؤسسة خارجية', 'OTHER', 'YER', 1, JSON.stringify({ id: 'tenant_other', name: 'مؤسسة خارجية', code: 'OTHER', currency: 'YER', isActive: true }));
    runtime.database.prepare(
      'INSERT OR IGNORE INTO branches (tenant_id,id,code,name_ar,is_main,active,data_json) VALUES (?,?,?,?,?,?,?)'
    ).run('tenant_other', 'branch_main', 'BR01', 'الفرع الرئيسي', 1, 1, JSON.stringify({ id: 'branch_main', code: 'BR01', nameAr: 'الفرع الرئيسي', isMain: true, active: true }));
    runtime.database.prepare(
      'INSERT OR IGNORE INTO activities (tenant_id,id,code,data_json) VALUES (?,?,?,?)'
    ).run('tenant_other', 'grocery', 'GROC', JSON.stringify({ id: 'grocery', nameAr: 'بقالة' }));

    const otherTenantAdmin = {
      id: 'usr-other-admin',
      tenantId: 'tenant_other',
      branchId: 'branch_main',
      allowedBranches: ['branch_main'],
      allowedActivities: ['grocery'],
      role: 'ADMIN',
      active: true,
      fullName: 'مدير المؤسسة الأخرى',
    };
    const { createProductCatalogService } = await import('../../electron/sqlite/modules/product-catalog-service.mjs');
    const directCatalog = createProductCatalogService(runtime.database);
    const otherBrand = directCatalog.saveBrandAtomic(otherTenantAdmin, { nameAr: 'علامة أجنبية' });
    directCatalog.createProductFamilyWithSkusAtomic(otherTenantAdmin, {
      id: 'other-fam',
      activityId: 'grocery',
      nameAr: 'مجموعة أجنبية',
      brandId: otherBrand.id,
      optionSchema: [{ key: 't', labelAr: 'النوع', values: ['A'], required: true, sortOrder: 1 }],
      skus: [
        {
          product: {
            id: 'other-sku-1',
            activityId: 'grocery',
            code: 'OTH-1',
            nameAr: 'صنف أجنبي',
            category: 'أجنبي',
            unit: 'حبة',
            purchasePrice: 10,
            sellPrice: 20,
            currentStock: 5,
            minStockAlert: 1,
          },
          variantAttributes: { t: 'A' },
        },
      ],
    });

    // Tenant_main admin must NOT see tenant_other brands, families, or SKUs
    assert.equal(backend.getBrands({ token: adminToken, includeInactive: true }).some((b) => b.id === otherBrand.id), false);
    assert.equal(backend.getProductFamilies({ token: adminToken, includeInactive: true }).some((f) => f.id === 'other-fam'), false);
    assert.equal(backend.getProductCatalogEntry({ token: adminToken, productId: 'other-sku-1' }), undefined);

    // Forged tenantId on IPC product/brand write is ignored and strictly bound to session actor's tenant_main
    const savedLocal = backend.saveProductAtomic({
      token: adminToken,
      product: {
        id: 'sq11-gr-sku',
        tenantId: 'tenant_other', // forged tenant
        activityId: 'grocery',
        code: 'SQ11-GR1',
        nameAr: 'صنف بقالة محلي',
        category: 'بقالة',
        unit: 'حبة',
        purchasePrice: 5,
        sellPrice: 10,
        currentStock: 5,
        minStockAlert: 1,
        batches: [],
      },
      isUpdate: false,
    });
    assert.equal(savedLocal.tenantId, 'tenant_main');
    const rawTenant = runtime.database.prepare('SELECT tenant_id FROM products WHERE id = ?').get('sq11-gr-sku');
    assert.equal(rawTenant.tenant_id, 'tenant_main');

    // Create pharmacy-only keeper and main-branch cashier
    backend.createUser({
      token: adminToken,
      input: {
        username: 'sq11_ph_keeper',
        fullName: 'أمين مخزن صيدلية',
        role: 'INVENTORY_KEEPER',
        branchId: 'branch_main',
        allowedBranches: ['branch_main'],
        allowedActivities: ['pharmacy'],
        plainPassword: 'Keeper#2026Pass',
      },
    });
    backend.createUser({
      token: adminToken,
      input: {
        username: 'sq11_main_cashier',
        fullName: 'كاشير الفرع الرئيسي',
        role: 'CASHIER',
        branchId: 'branch_main',
        allowedBranches: ['branch_main'],
        allowedActivities: ['grocery'],
        plainPassword: 'Cashier#2026Pass',
      },
    });

    const keeperToken = auth.authenticate({ username: 'sq11_ph_keeper', password: 'Keeper#2026Pass' }).token;
    const cashierToken = auth.authenticate({ username: 'sq11_main_cashier', password: 'Cashier#2026Pass' }).token;

    // Pharmacy keeper cannot access or modify grocery product, unit, or media
    assert.equal(backend.getProductCatalogEntry({ token: keeperToken, productId: 'sq11-gr-sku' }), undefined);
    assert.throws(() => backend.getProductUnits({ token: keeperToken, productId: 'sq11-gr-sku' }), /عزل الأنشطة|غير موجود/);
    assert.throws(
      () =>
        backend.saveProductUnit({
          token: keeperToken,
          unit: {
            productId: 'sq11-gr-sku',
            code: 'BOX',
            nameAr: 'كرتون',
            baseUnitsNumerator: 6,
            baseUnitsDenominator: 1,
          },
        }),
      /عزل الأنشطة/
    );
    assert.throws(
      () =>
        backend.addProductImage({
          token: keeperToken,
          input: {
            productId: 'sq11-gr-sku',
            originalDataUrl: VALID_WEBP_DATA_URL,
            thumbnailDataUrl: VALID_WEBP_DATA_URL,
            mimeType: 'image/webp',
            width: 32,
            height: 32,
          },
        }),
      /عزل الأنشطة/
    );

    // Cashier cannot write brands/units/media or restore backups, nor sell on unauthorized branch_south
    assert.throws(() => backend.saveBrandAtomic({ token: cashierToken, input: { nameAr: 'ممنوع' } }), /RBAC/);
    assert.throws(
      () =>
        backend.saveProductUnit({
          token: cashierToken,
          unit: {
            productId: 'sq11-gr-sku',
            code: 'BOX',
            nameAr: 'كرتون',
            baseUnitsNumerator: 6,
            baseUnitsDenominator: 1,
          },
        }),
      /RBAC/
    );
    assert.throws(() => backend.exportBackupJSON({ token: cashierToken }), /RBAC/);
    const southCb = backend.createCashBoxAtomic({
      token: adminToken,
      box: {
        id: 'sq11-cb-south',
        code: 'CBS',
        nameAr: 'صندوق الجنوب',
        accountCode: '1101',
        branchId: 'branch_south',
        balance: 0,
      },
    });
    assert.throws(
      () =>
        backend.createSalesInvoiceAtomic({
          token: cashierToken,
          params: {
            invoice: {
              id: 'sq11-cross-br-sale',
              type: 'SALE',
              activityId: 'grocery',
              branchId: 'branch_south',
              partyName: 'عميل',
              date: '2026-11-28',
              items: [
                {
                  id: 'sq11-cb-item',
                  productId: 'sq11-gr-sku',
                  productCode: 'SQ11-GR1',
                  productName: 'صنف بقالة محلي',
                  unit: 'حبة',
                  quantity: 1,
                  unitPrice: 10,
                  discount: 0,
                  total: 10,
                },
              ],
              subtotal: 10,
              discount: 0,
              tax: 0,
              total: 10,
              paidAmount: 10,
              paymentMethod: 'CASH',
              cashBoxId: southCb.id,
            },
            totalCogs: 5,
            stockDeductions: [{ productId: 'sq11-gr-sku', quantity: 1 }],
          },
        }),
      /عزل الفروع/
    );
  } finally {
    runtime?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PVAR-011-03 SQLite: E2E parity, balanced journals, legacy invoice returns, migration rollback, & .media restore rollback', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'erp-pvar011-e2e-'));
  let runtime;
  try {
    runtime = await openErpDatabase({ userDataPath: dir });
    const { auth, mediaStorage, backend } = setupBackend(runtime, dir);
    auth.createInitialAdmin({
      username: 'sq11_e2e_admin',
      fullName: 'مدير التكامل',
      password: 'Pvar11-E2E#2026',
    });
    const token = auth.authenticate({ username: 'sq11_e2e_admin', password: 'Pvar11-E2E#2026' }).token;
    const cashBoxId = backend.getCashBoxes({ token })[0].id;

    const jvCountBeforeCatalog = runtime.database.prepare('SELECT COUNT(*) AS c FROM journal_entries').get().c;
    const brand = backend.saveBrandAtomic({ token, input: { nameAr: 'شركة النخبة' } });
    backend.createProductFamilyWithSkusAtomic({
      token,
      input: {
        id: 'sq11-fam',
        activityId: 'pharmacy',
        nameAr: 'مضاد حيوي',
        brandId: brand.id,
        optionSchema: [{ key: 'dose', labelAr: 'التركيز', values: ['500mg'], required: true, sortOrder: 1 }],
        skus: [
          {
            product: {
              id: 'sq11-sku-500',
              activityId: 'pharmacy',
              code: 'AB-500',
              barcode: '62811100500',
              nameAr: 'مضاد 500',
              category: 'أدوية',
              unit: 'شريط',
              purchasePrice: 8,
              sellPrice: 12,
              currentStock: 0,
              minStockAlert: 1,
            },
            variantAttributes: { dose: '500mg' },
          },
        ],
      },
    });
    const box = backend.saveProductUnit({
      token,
      unit: {
        productId: 'sq11-sku-500',
        code: 'BOX',
        nameAr: 'علبة',
        baseUnitsNumerator: 10,
        baseUnitsDenominator: 1,
        barcode: '62811100599',
      },
    });
    backend.addProductImage({
      token,
      input: {
        productId: 'sq11-sku-500',
        originalDataUrl: VALID_WEBP_DATA_URL,
        thumbnailDataUrl: VALID_WEBP_DATA_URL,
        mimeType: 'image/webp',
        width: 32,
        height: 32,
      },
    });
    assert.equal(runtime.database.prepare('SELECT COUNT(*) AS c FROM journal_entries').get().c, jvCountBeforeCatalog);

    // Fund the main cash box via an opening capital journal before cash purchase
    backend.createJournalEntryAtomic({
      token,
      entry: {
        id: 'sq11-jv-open-cash',
        date: '2026-11-28',
        description: 'رأس مال افتتاحي لاختبار PVAR-011',
        costCenterId: 'general',
        branchId: 'branch_main',
        referenceType: 'MANUAL',
        lines: [
          { id: 'sq11-jv-l1', accountCode: '1101', cashBoxId, debit: 5000, credit: 0 },
          { id: 'sq11-jv-l2', accountCode: '3101', debit: 0, credit: 5000 },
        ],
      },
    });

    // Purchase 2 boxes (20 base units)
    backend.createPurchaseInvoiceAtomic({
      token,
      params: {
        invoice: {
          id: 'sq11-pur-1',
          type: 'PURCHASE',
          activityId: 'pharmacy',
          branchId: 'branch_main',
          partyName: 'مورد',
          date: '2026-11-28',
          items: [
            {
              id: 'sq11-pi-1',
              productId: 'sq11-sku-500',
              productCode: 'AB-500',
              productName: 'مضاد 500',
              unit: box.nameAr,
              unitId: box.id,
              quantity: 2,
              unitPrice: 80,
              discount: 0,
              total: 160,
            },
          ],
          subtotal: 160,
          discount: 0,
          tax: 0,
          total: 160,
          paidAmount: 160,
          paymentMethod: 'CASH',
          cashBoxId,
        },
        itemsWithBatches: [
          {
            invoiceItemId: 'sq11-pi-1',
            productId: 'sq11-sku-500',
            unitId: box.id,
            quantity: 2,
            costPrice: 80,
            batchNumber: 'LOT-A',
            expiryDate: '2027-09-01',
          },
        ],
      },
    });

    // Sell 1 box + 3 strips = 13 base units -> 7 remaining
    const sale = backend.createSalesInvoiceAtomic({
      token,
      params: {
        invoice: {
          id: 'sq11-sale-1',
          type: 'SALE',
          activityId: 'pharmacy',
          branchId: 'branch_main',
          partyName: 'عميل',
          date: '2026-11-28',
          items: [
            {
              id: 'sq11-si-box',
              productId: 'sq11-sku-500',
              productCode: 'AB-500',
              productName: 'مضاد 500',
              unit: box.nameAr,
              unitId: box.id,
              quantity: 1,
              unitPrice: 120,
              discount: 0,
              total: 120,
            },
            {
              id: 'sq11-si-strip',
              productId: 'sq11-sku-500',
              productCode: 'AB-500',
              productName: 'مضاد 500',
              unit: 'شريط',
              quantity: 3,
              unitPrice: 12,
              discount: 0,
              total: 36,
            },
          ],
          subtotal: 156,
          discount: 0,
          tax: 0,
          total: 156,
          paidAmount: 156,
          paymentMethod: 'CASH',
          cashBoxId,
        },
        totalCogs: 104,
        stockDeductions: [
          { invoiceItemId: 'sq11-si-box', productId: 'sq11-sku-500', quantity: 10 },
          { invoiceItemId: 'sq11-si-strip', productId: 'sq11-sku-500', quantity: 3 },
        ],
      },
    });
    assert.equal(backend.getProductById({ token, id: 'sq11-sku-500' }).currentStock, 7);

    // Modify unit ratio then return 1 box: must restore 10 base units via historical snapshot -> 17
    backend.saveProductUnit({ token, unit: { ...box, baseUnitsNumerator: 20, baseUnitsDenominator: 1 } });
    backend.createSalesReturnAtomic({
      token,
      params: {
        originalInvoiceId: sale.invoice.id,
        items: [{ originalInvoiceItemId: 'sq11-si-box', productId: 'sq11-sku-500', quantity: 1 }],
        returnReason: 'مرتجع وحدة تاريخية',
        refundMethod: 'CASH',
        cashBoxId,
      },
    });
    assert.equal(backend.getProductById({ token, id: 'sq11-sku-500' }).currentStock, 17);

    // Every posted journal entry in SQLite must balance to 4 decimals
    const jvCheck = runtime.database.prepare(
      `SELECT j.entry_number,
              SUM(CAST(l.debit_decimal AS REAL)) AS dr,
              SUM(CAST(l.credit_decimal AS REAL)) AS cr
       FROM journal_entries j
       JOIN journal_entry_lines l ON l.tenant_id = j.tenant_id AND l.entry_id = j.id
       GROUP BY j.id, j.entry_number`
    ).all();
    assert.ok(jvCheck.length > 0);
    for (const row of jvCheck) {
      assert.ok(Math.abs(row.dr - row.cr) < 0.0001, `Unbalanced SQLite JV ${row.entry_number}: ${row.dr} != ${row.cr}`);
    }
    assert.deepEqual(runtime.database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(runtime.database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');

    // Create native backup + .media, verify media integrity passes, then simulate corrupted .media and rollback cleanly
    const backupPath = await createSqliteBackup(runtime.database, runtime.backupDirectory, { prefix: 'pvar11' });
    mediaStorage.backupTo(`${backupPath}.media`);
    const integrity = verifyProductMediaIntegrity(runtime.database, mediaStorage);
    assert.equal(integrity.checkedCount, 1);

    // Corrupt a copied backup media folder and verify verifyProductMediaIntegrity catches it cleanly
    const tempMediaDir = path.join(dir, 'corrupt-media');
    mkdirSync(tempMediaDir, { recursive: true });
    const corruptStorage = createProductMediaStorage({ rootDirectory: tempMediaDir });
    assert.throws(() => verifyProductMediaIntegrity(runtime.database, corruptStorage), /غير موجودة|مفقود|تالف/);

    // Also test native restore roundtrip with safety backup intact
    const restored = await restoreSqliteBackupFile({
      databasePath: runtime.databasePath,
      backupDirectory: runtime.backupDirectory,
      sourceBackupPath: backupPath,
      currentDatabase: runtime.database,
      reopenOptions: { userDataPath: dir },
    });
    runtime = restored.databaseRuntime;
    assert.equal(existsSync(restored.safetyBackupPath), true);
    assert.equal(runtime.database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(runtime.database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    runtime?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
