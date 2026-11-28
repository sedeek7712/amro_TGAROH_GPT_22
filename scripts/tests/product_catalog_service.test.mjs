import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openErpDatabase } from '../../electron/sqlite/database.mjs';
import { DesktopAuthenticationService } from '../../electron/security/authentication.mjs';
import { createDesktopBackend } from '../../electron/sqlite/desktop-backend.mjs';
import { createCoreService } from '../../electron/sqlite/modules/core-service.mjs';
import { createInventoryPartiesService } from '../../electron/sqlite/modules/inventory-parties-service.mjs';
import { createProductUnitsService } from '../../electron/sqlite/modules/product-units-service.mjs';
import {
  computeCanonicalVariantKeyAndAttributes,
  createProductCatalogService,
} from '../../electron/sqlite/modules/product-catalog-service.mjs';

test('PVAR-005 SQLite product catalog domain services, RBAC, isolation, and atomic rollback', async () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-pvar005-sqlite-'));
  let runtime;
  try {
    runtime = await openErpDatabase({ userDataPath });
    let db = runtime.database;

    // Seed activities (pharmacy & grocery) for tenant_main
    const insertAct = db.prepare(
      'INSERT OR IGNORE INTO activities (tenant_id,id,code,data_json) VALUES (?,?,?,?)'
    );
    insertAct.run('tenant_main', 'pharmacy', 'PHARM', JSON.stringify({ id: 'pharmacy', nameAr: 'الصيدلية' }));
    insertAct.run('tenant_main', 'grocery', 'GROC', JSON.stringify({ id: 'grocery', nameAr: 'المواد الغذائية' }));

    const admin = {
      id: 'pvar005-admin',
      tenantId: 'tenant_main',
      branchId: 'branch_main',
      role: 'ADMIN',
      active: true,
      fullName: 'PVAR-005 Admin',
      allowedActivities: ['pharmacy', 'grocery'],
    };
    const groceryKeeper = {
      id: 'pvar005-keeper',
      tenantId: 'tenant_main',
      branchId: 'branch_main',
      role: 'INVENTORY_KEEPER',
      active: true,
      fullName: 'PVAR-005 Grocery Keeper',
      allowedActivities: ['grocery'],
    };
    const cashier = {
      id: 'pvar005-cashier',
      tenantId: 'tenant_main',
      branchId: 'branch_main',
      role: 'CASHIER',
      active: true,
      fullName: 'PVAR-005 Cashier',
      allowedActivities: ['pharmacy', 'grocery'],
    };
    const otherTenantAdmin = {
      id: 'pvar005-other-admin',
      tenantId: 'tenant_other',
      branchId: 'branch_main',
      role: 'ADMIN',
      active: true,
      fullName: 'Other Tenant Admin',
      allowedActivities: ['pharmacy', 'grocery'],
    };

    const core = createCoreService(db);
    const inventory = createInventoryPartiesService(db, core);
    const units = createProductUnitsService(db);
    const catalog = createProductCatalogService(db, core);

    const accountsBefore = db.prepare('SELECT code, balance_decimal FROM accounts ORDER BY code').all();
    const cashBoxesBefore = db.prepare('SELECT id, balance_decimal FROM cash_boxes ORDER BY id').all();
    const journalCountBefore = db.prepare('SELECT COUNT(*) AS count FROM journal_entries').get().count;

    // 1. Standalone legacy product + alternate unit barcode (to test cross-table barcode uniqueness)
    const legacyProduct = inventory.saveProductAtomic(admin, {
      id: 'pvar005-legacy-sku',
      activityId: 'grocery',
      code: 'LEG-001',
      barcode: '629000500001',
      nameAr: 'منتج مستقل تقليدي',
      category: 'ألبان',
      unit: 'حبة',
      purchasePrice: 5,
      sellPrice: 7,
      currentStock: 0,
      minStockAlert: 0,
    }, false);
    units.saveProductUnit(admin, {
      productId: legacyProduct.id,
      code: 'BOX',
      nameAr: 'كرتون',
      baseUnitsNumerator: 12,
      baseUnitsDenominator: 1,
      barcode: '000999888777',
    });

    // 2. Brands CRUD + normalized uniqueness + archive
    const brand = catalog.saveBrandAtomic(admin, { nameAr: '  Almarai   Co  ' });
    assert.equal(brand.nameAr, 'Almarai Co');
    assert.equal(brand.normalizedName, 'almarai co');
    assert.equal(brand.isActive, true);

    assert.throws(
      () => catalog.saveBrandAtomic(admin, { nameAr: 'almarai co' }),
      /مسجلة بالفعل/
    );

    const tempBrand = catalog.saveBrandAtomic(admin, { nameAr: 'علامة مؤقتة' });
    const archivedBrand = catalog.archiveBrandAtomic(admin, tempBrand.id);
    assert.equal(archivedBrand.isActive, false);
    assert.equal(catalog.getBrands(admin, false).some((b) => b.id === tempBrand.id), false);
    assert.equal(catalog.getBrands(admin, true).some((b) => b.id === tempBrand.id), true);

    // 3. Assign brand to standalone product, verify hydration, then remove brand cleanly
    const assignedMeta = catalog.assignProductBrandAtomic(admin, {
      productId: legacyProduct.id,
      brandId: brand.id,
    });
    assert.equal(assignedMeta?.brandId, brand.id);
    const hydratedStandalone = catalog.getProductCatalogEntry(admin, legacyProduct.id);
    assert.equal(hydratedStandalone?.brand?.id, brand.id);
    assert.equal(hydratedStandalone?.units.length, 1);
    assert.deepEqual(hydratedStandalone?.variantAttributes, {});

    const clearedMeta = catalog.assignProductBrandAtomic(admin, {
      productId: legacyProduct.id,
      brandId: null,
    });
    assert.equal(clearedMeta, undefined);
    assert.equal(catalog.getProductCatalogEntry(admin, legacyProduct.id)?.meta, undefined);

    // Re-assign brand for reopen check
    catalog.assignProductBrandAtomic(admin, { productId: legacyProduct.id, brandId: brand.id });

    // 4. Canonical variantKey ignores caller key order/casing
    const optionSchema = [
      { key: 'size', labelAr: 'المقاس', values: ['M', 'L'], required: true, sortOrder: 2 },
      { key: 'color', labelAr: 'اللون', values: ['أبيض', 'أسود'], required: true, sortOrder: 1 },
    ];
    const v1 = computeCanonicalVariantKeyAndAttributes(optionSchema, { Size: 'm', COLOR: ' أبيض ' });
    const v2 = computeCanonicalVariantKeyAndAttributes(optionSchema, { color: 'أبيض', size: 'M' });
    assert.equal(v1.variantKey, v2.variantKey);
    assert.deepEqual(v1.variantAttributes, { color: 'أبيض', size: 'M' });

    // 5. Atomic rollback checks on createProductFamilyWithSkusAtomic
    const productsCountBeforeRollback = db.prepare('SELECT COUNT(*) AS count FROM products').get().count;
    const familiesCountBeforeRollback = db.prepare('SELECT COUNT(*) AS count FROM product_families').get().count;
    const metaCountBeforeRollback = db.prepare('SELECT COUNT(*) AS count FROM product_catalog_meta').get().count;

    // 5a. Duplicate variantKey inside batch -> full rollback
    assert.throws(() => catalog.createProductFamilyWithSkusAtomic(admin, {
      id: 'fam-rollback-dup',
      activityId: 'grocery',
      nameAr: 'تيشيرت رياضي',
      brandId: brand.id,
      optionSchema,
      skus: [
        {
          product: {
            id: 'sku-rb-1', activityId: 'grocery', code: 'RB-1', nameAr: 'تيشيرت أبيض M',
            category: 'ملابس', unit: 'حبة', purchasePrice: 10, sellPrice: 15, currentStock: 0, minStockAlert: 0,
          },
          variantAttributes: { color: 'أبيض', size: 'M' },
        },
        {
          product: {
            id: 'sku-rb-2', activityId: 'grocery', code: 'RB-2', nameAr: 'تيشيرت مكرر',
            category: 'ملابس', unit: 'حبة', purchasePrice: 10, sellPrice: 15, currentStock: 0, minStockAlert: 0,
          },
          variantAttributes: { color: 'أبيض', size: 'm' },
        },
      ],
    }), /مكررة/);

    // 5b. Second SKU collides with existing unit barcode -> full rollback (first SKU must NOT persist!)
    assert.throws(() => catalog.createProductFamilyWithSkusAtomic(admin, {
      id: 'fam-rollback-barcode',
      activityId: 'grocery',
      nameAr: 'تيشيرت رياضي',
      brandId: brand.id,
      optionSchema,
      skus: [
        {
          product: {
            id: 'sku-rb-3', activityId: 'grocery', code: 'RB-3', barcode: '629000599901',
            nameAr: 'تيشيرت أبيض M', category: 'ملابس', unit: 'حبة',
            purchasePrice: 10, sellPrice: 15, currentStock: 0, minStockAlert: 0,
          },
          variantAttributes: { color: 'أبيض', size: 'M' },
        },
        {
          product: {
            id: 'sku-rb-4', activityId: 'grocery', code: 'RB-4', barcode: '000999888777',
            nameAr: 'تيشيرت أسود L', category: 'ملابس', unit: 'حبة',
            purchasePrice: 10, sellPrice: 15, currentStock: 0, minStockAlert: 0,
          },
          variantAttributes: { color: 'أسود', size: 'L' },
        },
      ],
    }), /الباركود/);

    // 5c. Mismatched SKU activityId -> full rollback
    assert.throws(() => catalog.createProductFamilyWithSkusAtomic(admin, {
      id: 'fam-rollback-activity',
      activityId: 'grocery',
      nameAr: 'تيشيرت رياضي',
      optionSchema,
      skus: [
        {
          product: {
            id: 'sku-rb-5', activityId: 'pharmacy', code: 'RB-5', nameAr: 'تيشيرت خاطئ النشاط',
            category: 'ملابس', unit: 'حبة', purchasePrice: 10, sellPrice: 15, currentStock: 0, minStockAlert: 0,
          },
          variantAttributes: { color: 'أبيض', size: 'M' },
        },
      ],
    }), /نشاط المتغير/);

    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM products').get().count, productsCountBeforeRollback);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM product_families').get().count, familiesCountBeforeRollback);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM product_catalog_meta').get().count, metaCountBeforeRollback);

    // 6. Successful atomic creation of family + 2 SKUs
    const createdFamily = catalog.createProductFamilyWithSkusAtomic(admin, {
      id: 'fam-shirt-01',
      activityId: 'grocery',
      nameAr: 'قميص قطني',
      categorySnapshot: 'ملابس',
      brandId: brand.id,
      optionSchema,
      skus: [
        {
          product: {
            id: 'sku-shirt-white-m',
            activityId: 'grocery',
            code: 'SHIRT-W-M',
            barcode: '629000500101',
            nameAr: 'قميص قطني - أبيض - M',
            category: 'ملابس',
            unit: 'حبة',
            purchasePrice: 20,
            sellPrice: 35,
            currentStock: 0,
            minStockAlert: 2,
          },
          variantAttributes: { color: 'أبيض', size: 'M' },
        },
        {
          product: {
            id: 'sku-shirt-black-l',
            activityId: 'grocery',
            code: 'SHIRT-B-L',
            barcode: '629000500102',
            nameAr: 'قميص قطني - أسود - L',
            category: 'ملابس',
            unit: 'حبة',
            purchasePrice: 22,
            sellPrice: 38,
            currentStock: 0,
            minStockAlert: 2,
          },
          variantAttributes: { color: 'أسود', size: 'L' },
        },
      ],
    });
    assert.equal(createdFamily.family.id, 'fam-shirt-01');
    assert.equal(createdFamily.skus.length, 2);
    assert.equal(createdFamily.skus[0].brand?.id, brand.id);
    assert.equal(createdFamily.skus[0].meta?.familyId, 'fam-shirt-01');
    assert.equal(createdFamily.skus[0].meta?.brandId, undefined);

    // Cannot assign independent brand to a family SKU
    assert.throws(
      () => catalog.assignProductBrandAtomic(admin, { productId: 'sku-shirt-white-m', brandId: brand.id }),
      /تابع لمجموعة منتجات/
    );

    // 7. Update family: allow adding new value 'XL', reject removing used value 'M'
    const updatedFamily = catalog.updateProductFamilyAtomic(admin, {
      id: 'fam-shirt-01',
      nameAr: 'قميص قطني فاخر',
      optionSchema: [
        { key: 'color', labelAr: 'اللون', values: ['أبيض', 'أسود'], required: true, sortOrder: 1 },
        { key: 'size', labelAr: 'المقاس', values: ['M', 'L', 'XL'], required: true, sortOrder: 2 },
      ],
    });
    assert.equal(updatedFamily.nameAr, 'قميص قطني فاخر');
    assert.throws(
      () => catalog.updateProductFamilyAtomic(admin, {
        id: 'fam-shirt-01',
        nameAr: 'قميص قطني فاخر',
        optionSchema: [
          { key: 'color', labelAr: 'اللون', values: ['أبيض', 'أسود'], required: true, sortOrder: 1 },
          { key: 'size', labelAr: 'المقاس', values: ['L', 'XL'], required: true, sortOrder: 2 },
        ],
      }),
      /مرتبطة بمتغيرات/
    );

    // 8. RBAC + Activity + Tenant Isolation
    assert.throws(() => catalog.saveBrandAtomic(cashier, { nameAr: 'Blocked' }), /RBAC/);
    assert.throws(() => catalog.archiveBrandAtomic(cashier, brand.id), /RBAC/);
    assert.throws(() => catalog.createProductFamilyWithSkusAtomic(groceryKeeper, {
      activityId: 'pharmacy',
      nameAr: 'مجموعة صيدلية',
      optionSchema: [{ key: 'dose', labelAr: 'التركيز', values: ['500mg'], required: true, sortOrder: 1 }],
      skus: [{
        product: {
          id: 'sku-ph-deny', activityId: 'pharmacy', code: 'PH-D-1', nameAr: 'دواء',
          category: 'أدوية', unit: 'علبة', purchasePrice: 5, sellPrice: 8, currentStock: 0, minStockAlert: 0,
        },
        variantAttributes: { dose: '500mg' },
      }],
    }), /عزل الأنشطة/);

    // Pharmacy standalone item invisible to groceryKeeper
    inventory.saveProductAtomic(admin, {
      id: 'pvar005-ph-only',
      activityId: 'pharmacy',
      code: 'PH-ONLY-1',
      nameAr: 'صنف صيدلية',
      category: 'أدوية',
      unit: 'علبة',
      purchasePrice: 5,
      sellPrice: 8,
      currentStock: 0,
      minStockAlert: 0,
    }, false);
    const keeperCatalog = catalog.getProductCatalog(groceryKeeper);
    assert.equal(keeperCatalog.some((e) => e.product.activityId === 'pharmacy'), false);
    assert.equal(catalog.getProductCatalogEntry(groceryKeeper, 'pvar005-ph-only'), undefined);

    // Tenant isolation
    assert.equal(catalog.getBrands(otherTenantAdmin, true).length, 0);
    assert.equal(catalog.getProductFamilies(otherTenantAdmin, undefined, true).length, 0);

    // 9. Archive family (soft disable, keeps SKUs)
    const archivedFamily = catalog.archiveProductFamilyAtomic(admin, 'fam-shirt-01');
    assert.equal(archivedFamily.isActive, false);
    assert.equal(catalog.getProductFamilies(admin, 'grocery', false).length, 0);
    assert.equal(catalog.getProductFamilies(admin, 'grocery', true).length, 1);

    // 10. Reopen DB persistence & accounting invariance check
    runtime.close();
    runtime = await openErpDatabase({ userDataPath });
    db = runtime.database;
    const reopenedCatalog = createProductCatalogService(db, createCoreService(db));
    const entry = reopenedCatalog.getProductCatalogEntry(admin, 'sku-shirt-white-m');
    assert.equal(entry?.family?.nameAr, 'قميص قطني فاخر');
    assert.equal(entry?.family?.isActive, false);
    assert.equal(entry?.brand?.id, brand.id);
    assert.deepEqual(entry?.variantAttributes, { color: 'أبيض', size: 'M' });

    assert.deepEqual(db.prepare('SELECT code, balance_decimal FROM accounts ORDER BY code').all(), accountsBefore);
    assert.deepEqual(db.prepare('SELECT id, balance_decimal FROM cash_boxes ORDER BY id').all(), cashBoxesBefore);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM journal_entries').get().count, journalCountBefore);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    runtime?.close();
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('PVAR-007 SQLite sales parity: rejects archived SKU sales and persists variant snapshot across reopen', async () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-pvar007-sqlite-'));
  let runtime;
  try {
    runtime = await openErpDatabase({ userDataPath });
    const auth = new DesktopAuthenticationService(runtime.database);
    const backend = createDesktopBackend({
      database: runtime.database,
      backupDirectory: runtime.backupDirectory,
      authenticationService: auth,
    });
    auth.createInitialAdmin({
      username: 'pvar007_admin',
      fullName: 'PVAR-007 Admin',
      password: 'Pvar007-Admin#2026',
    });
    const token = auth.authenticate({ username: 'pvar007_admin', password: 'Pvar007-Admin#2026' }).token;

    const brand = backend.saveBrandAtomic({ token, input: { nameAr: 'علامة الصندوق' } });
    backend.createProductFamilyWithSkusAtomic({
      token,
      input: {
        id: 'sq-pos-fam',
        activityId: 'grocery',
        nameAr: 'تيشيرت قطني',
        categorySnapshot: 'ملابس',
        brandId: brand.id,
        optionSchema: [{ key: 'size', labelAr: 'المقاس', values: ['M', 'L'], required: true, sortOrder: 1 }],
        skus: [
          {
            product: {
              id: 'sq-sku-active',
              activityId: 'grocery',
              code: 'SQ-TSH-01',
              barcode: '628550001',
              nameAr: 'تيشيرت قطني - M',
              category: 'ملابس',
              unit: 'قطعة',
              purchasePrice: 25,
              sellPrice: 45,
              currentStock: 8,
              minStockAlert: 1,
              isActive: true,
            },
            variantAttributes: { size: 'M' },
          },
          {
            product: {
              id: 'sq-sku-archived',
              activityId: 'grocery',
              code: 'SQ-TSH-02',
              barcode: '628550002',
              nameAr: 'تيشيرت قطني - L',
              category: 'ملابس',
              unit: 'قطعة',
              purchasePrice: 25,
              sellPrice: 45,
              currentStock: 5,
              minStockAlert: 1,
              isActive: false,
            },
            variantAttributes: { size: 'L' },
          },
        ],
      },
    });

    const cashBoxId = backend.getCashBoxes({ token })[0].id;

    assert.throws(
      () =>
        backend.createSalesInvoiceAtomic({
          token,
          params: {
            invoice: {
              id: 'sq-inv-archived-deny',
              invoiceNumber: '',
              type: 'SALE',
              activityId: 'grocery',
              branchId: 'branch_main',
              partyName: 'عميل نقدي',
              date: '2026-11-28',
              items: [
                {
                  id: 'sq-item-arch',
                  productId: 'sq-sku-archived',
                  productName: 'تيشيرت قطني - L',
                  productCode: 'SQ-TSH-02',
                  unit: 'قطعة',
                  quantity: 1,
                  unitPrice: 45,
                  discount: 0,
                  total: 45,
                },
              ],
              subtotal: 45,
              discount: 0,
              tax: 0,
              total: 45,
              paidAmount: 45,
              paymentMethod: 'CASH',
              cashBoxId,
            },
            totalCogs: 25,
            stockDeductions: [{ productId: 'sq-sku-archived', quantity: 1 }],
          },
        }),
      /مؤرشف ومعطل ولا يمكن بيعه/
    );

    const res = backend.createSalesInvoiceAtomic({
      token,
      params: {
        invoice: {
          id: 'sq-inv-active-ok',
          invoiceNumber: '',
          type: 'SALE',
          activityId: 'grocery',
          branchId: 'branch_main',
          partyName: 'عميل نقدي',
          date: '2026-11-28',
          items: [
            {
              id: 'sq-item-ok',
              productId: 'sq-sku-active',
              productName: 'تيشيرت قطني - M',
              productCode: 'SQ-TSH-01',
              familyId: 'sq-pos-fam',
              familyNameSnapshot: 'تيشيرت قطني',
              brandNameSnapshot: 'علامة الصندوق',
              variantAttributesSnapshot: { size: 'M' },
              variantSummary: 'المقاس: M',
              unit: 'قطعة',
              quantity: 3,
              unitPrice: 45,
              discount: 0,
              total: 135,
            },
          ],
          subtotal: 135,
          discount: 0,
          tax: 0,
          total: 135,
          paidAmount: 135,
          paymentMethod: 'CASH',
          cashBoxId,
        },
        totalCogs: 75,
        stockDeductions: [{ productId: 'sq-sku-active', quantity: 3 }],
      },
    });

    assert.equal(res.invoice.items[0].variantSummary, 'المقاس: M');
    assert.equal(backend.getProductById({ token, id: 'sq-sku-active' }).currentStock, 5);
    assert.equal(backend.getProductById({ token, id: 'sq-sku-archived' }).currentStock, 5);

    runtime.close();
    runtime = await openErpDatabase({ userDataPath });
    const auth2 = new DesktopAuthenticationService(runtime.database);
    const backend2 = createDesktopBackend({
      database: runtime.database,
      backupDirectory: runtime.backupDirectory,
      authenticationService: auth2,
    });
    const token2 = auth2.authenticate({ username: 'pvar007_admin', password: 'Pvar007-Admin#2026' }).token;
    const reloaded = backend2.getInvoiceById({ token: token2, id: 'sq-inv-active-ok' });
    assert.equal(reloaded?.items?.[0]?.variantSummary, 'المقاس: M');
    assert.equal(reloaded?.items?.[0]?.familyId, 'sq-pos-fam');
  } finally {
    runtime?.close();
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
