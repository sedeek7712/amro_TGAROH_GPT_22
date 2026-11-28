import 'fake-indexeddb/auto';

if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage) {
  const store: Record<string, string> = {};
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = String(value); },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { for (const key in store) delete store[key]; },
      key: (index: number) => Object.keys(store)[index] ?? null,
      get length() { return Object.keys(store).length; },
    },
    writable: true,
  });
}

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/erpDatabase';
import { dexieDataService } from '../services/dexieDataService';
import { authService, hashPassword } from '../services/authService';
import type { Product, SystemUser } from '../types/erp';

let adminUser: SystemUser;
let groceryKeeper: SystemUser;
let cashierUser: SystemUser;

async function loginAs(user: SystemUser, plainPassword: string) {
  authService.logout();
  const res = await authService.authenticate({
    username: user.username,
    password: plainPassword,
    users: [adminUser, groceryKeeper, cashierUser],
    onUserUpdated: async (updated) => { await db.users.put(updated); },
  });
  assert.equal(res.success, true);
}

before(async () => {
  localStorage.clear();
  authService.logout();
  dexieDataService.resetForTests();
  await db.open();
  await dexieDataService.initialize();

  adminUser = {
    id: 'pvar005-dx-admin',
    username: 'pvar005_dx_admin',
    fullName: 'PVAR-005 Dexie Admin',
    role: 'ADMIN',
    allowedActivities: ['pharmacy', 'grocery', 'bike_parts', 'equipment_parts'],
    branchId: 'branch_main',
    allowedBranches: ['branch_main'],
    tenantId: 'tenant_main',
    active: true,
    passwordHash: await hashPassword('Pvar005-Admin#2026'),
  };
  groceryKeeper = {
    id: 'pvar005-dx-keeper',
    username: 'pvar005_dx_keeper',
    fullName: 'PVAR-005 Grocery Keeper',
    role: 'INVENTORY_KEEPER',
    allowedActivities: ['grocery'],
    branchId: 'branch_main',
    allowedBranches: ['branch_main'],
    tenantId: 'tenant_main',
    active: true,
    passwordHash: await hashPassword('Pvar005-Keeper#2026'),
  };
  cashierUser = {
    id: 'pvar005-dx-cashier',
    username: 'pvar005_dx_cashier',
    fullName: 'PVAR-005 Cashier',
    role: 'CASHIER',
    allowedActivities: ['pharmacy', 'grocery'],
    branchId: 'branch_main',
    allowedBranches: ['branch_main'],
    tenantId: 'tenant_main',
    active: true,
    passwordHash: await hashPassword('Pvar005-Cashier#2026'),
  };

  await db.users.bulkPut([adminUser, groceryKeeper, cashierUser]);
  await loginAs(adminUser, 'Pvar005-Admin#2026');
});

after(async () => {
  authService.logout();
  dexieDataService.resetForTests();
  db.close();
  await db.delete();
});

test('PVAR-005 Dexie catalog services, unified validation, RBAC, rollback, and SQLite parity', async () => {
  const accountsBefore = (await db.accounts.toArray()).map(({ code, balance }) => ({ code, balance }));
  const cashBoxesBefore = (await db.cashBoxes.toArray()).map(({ id, balance }) => ({ id, balance }));
  const journalCountBefore = await db.journalEntries.count();

  // 1. Unified saveProductAtomic validation parity (missing nameAr / code / activityId)
  await assert.rejects(
    () => dexieDataService.saveProductAtomic({
      id: 'dx-invalid-name',
      activityId: 'grocery',
      code: 'DX-INV-1',
      nameAr: '   ',
      category: 'اختبار',
      unit: 'حبة',
      purchasePrice: 5,
      sellPrice: 8,
      currentStock: 0,
      minStockAlert: 0,
    }, false),
    /حقول مطلوبة/
  );
  await assert.rejects(
    () => dexieDataService.saveProductAtomic({
      id: 'dx-invalid-code',
      activityId: 'grocery',
      code: '',
      nameAr: 'منتج بلا كود',
      category: 'اختبار',
      unit: 'حبة',
      purchasePrice: 5,
      sellPrice: 8,
      currentStock: 0,
      minStockAlert: 0,
    }, false),
    /حقول مطلوبة/
  );

  // 2. Standalone legacy product + alternate unit barcode
  const legacyProduct: Product = {
    id: 'dx-pvar005-legacy',
    activityId: 'grocery',
    code: 'DX-LEG-01',
    barcode: '629000600001',
    nameAr: 'صنف مستقل تقليدي',
    category: 'بقالة',
    unit: 'حبة',
    purchasePrice: 4,
    sellPrice: 6,
    currentStock: 0,
    minStockAlert: 0,
  };
  await dexieDataService.saveProductAtomic(legacyProduct, false);
  await dexieDataService.saveProductUnit({
    productId: legacyProduct.id,
    code: 'CTN',
    nameAr: 'كرتون',
    baseUnitsNumerator: 12,
    baseUnitsDenominator: 1,
    barcode: '000777666555',
  });

  // 3. Brands CRUD + normalized uniqueness + archive
  const brand = await dexieDataService.saveBrandAtomic({ nameAr: '  Almarai   Co ' });
  assert.equal(brand.normalizedName, 'almarai co');
  await assert.rejects(
    () => dexieDataService.saveBrandAtomic({ nameAr: 'almarai co' }),
    /مسجلة بالفعل/
  );
  const tempBrand = await dexieDataService.saveBrandAtomic({ nameAr: 'علامة للأرشفة' });
  const archivedBrand = await dexieDataService.archiveBrandAtomic(tempBrand.id);
  assert.equal(archivedBrand.isActive, false);
  assert.equal((await dexieDataService.getBrands(false)).some((b) => b.id === tempBrand.id), false);
  assert.equal((await dexieDataService.getBrands(true)).some((b) => b.id === tempBrand.id), true);

  // 4. Assign/remove brand on standalone product
  const metaAssigned = await dexieDataService.assignProductBrandAtomic({
    productId: legacyProduct.id,
    brandId: brand.id,
  });
  assert.equal(metaAssigned?.brandId, brand.id);
  assert.equal((await dexieDataService.getProductCatalogEntry(legacyProduct.id))?.brand?.id, brand.id);
  assert.equal(await dexieDataService.assignProductBrandAtomic({ productId: legacyProduct.id, brandId: null }), undefined);
  assert.equal((await dexieDataService.getProductCatalogEntry(legacyProduct.id))?.meta, undefined);
  await dexieDataService.assignProductBrandAtomic({ productId: legacyProduct.id, brandId: brand.id });

  // 5. Atomic rollback on createProductFamilyWithSkusAtomic
  const optionSchema = [
    { key: 'color', labelAr: 'اللون', values: ['أبيض', 'أسود'], required: true, sortOrder: 1 },
    { key: 'size', labelAr: 'المقاس', values: ['M', 'L'], required: true, sortOrder: 2 },
  ];
  const productsBefore = await db.products.count();
  const familiesBefore = await db.productFamilies.count();
  const metaBefore = await db.productCatalogMeta.count();

  await assert.rejects(
    () => dexieDataService.createProductFamilyWithSkusAtomic({
      id: 'dx-fam-rollback',
      activityId: 'grocery',
      nameAr: 'تيشيرت',
      brandId: brand.id,
      optionSchema,
      skus: [
        {
          product: {
            id: 'dx-rb-1', activityId: 'grocery', code: 'DX-RB-1', barcode: '629000699901',
            nameAr: 'تيشيرت أبيض M', category: 'ملابس', unit: 'حبة',
            purchasePrice: 10, sellPrice: 15, currentStock: 0, minStockAlert: 0,
          },
          variantAttributes: { color: 'أبيض', size: 'M' },
        },
        {
          product: {
            id: 'dx-rb-2', activityId: 'grocery', code: 'DX-RB-2', barcode: '000777666555',
            nameAr: 'تيشيرت أسود L', category: 'ملابس', unit: 'حبة',
            purchasePrice: 10, sellPrice: 15, currentStock: 0, minStockAlert: 0,
          },
          variantAttributes: { color: 'أسود', size: 'L' },
        },
      ],
    }),
    /الباركود/
  );
  assert.equal(await db.products.count(), productsBefore);
  assert.equal(await db.productFamilies.count(), familiesBefore);
  assert.equal(await db.productCatalogMeta.count(), metaBefore);

  // 6. Successful atomic creation
  const created = await dexieDataService.createProductFamilyWithSkusAtomic({
    id: 'dx-fam-shirt-01',
    activityId: 'grocery',
    nameAr: 'قميص قطني',
    categorySnapshot: 'ملابس',
    brandId: brand.id,
    optionSchema,
    skus: [
      {
        product: {
          id: 'dx-sku-white-m', activityId: 'grocery', code: 'DX-SH-WM', barcode: '629000600101',
          nameAr: 'قميص قطني - أبيض - M', category: 'ملابس', unit: 'حبة',
          purchasePrice: 20, sellPrice: 35, currentStock: 0, minStockAlert: 2,
        },
        variantAttributes: { Size: 'm', color: 'أبيض' },
      },
      {
        product: {
          id: 'dx-sku-black-l', activityId: 'grocery', code: 'DX-SH-BL', barcode: '629000600102',
          nameAr: 'قميص قطني - أسود - L', category: 'ملابس', unit: 'حبة',
          purchasePrice: 22, sellPrice: 38, currentStock: 0, minStockAlert: 2,
        },
        variantAttributes: { color: 'أسود', size: 'L' },
      },
    ],
  });
  assert.equal(created.skus.length, 2);
  assert.deepEqual(created.skus[0].variantAttributes, { color: 'أبيض', size: 'M' });

  await assert.rejects(
    () => dexieDataService.assignProductBrandAtomic({ productId: 'dx-sku-white-m', brandId: brand.id }),
    /تابع لمجموعة منتجات/
  );

  // 7. Update family schema rules + archive
  const updated = await dexieDataService.updateProductFamilyAtomic({
    id: 'dx-fam-shirt-01',
    nameAr: 'قميص قطني فاخر',
    optionSchema: [
      { key: 'color', labelAr: 'اللون', values: ['أبيض', 'أسود'], required: true, sortOrder: 1 },
      { key: 'size', labelAr: 'المقاس', values: ['M', 'L', 'XL'], required: true, sortOrder: 2 },
    ],
  });
  assert.equal(updated.nameAr, 'قميص قطني فاخر');

  await assert.rejects(
    () => dexieDataService.updateProductFamilyAtomic({
      id: 'dx-fam-shirt-01',
      nameAr: 'قميص قطني فاخر',
      optionSchema: [
        { key: 'color', labelAr: 'اللون', values: ['أبيض', 'أسود'], required: true, sortOrder: 1 },
        { key: 'size', labelAr: 'المقاس', values: ['L', 'XL'], required: true, sortOrder: 2 },
      ],
    }),
    /مرتبطة بمتغيرات/
  );

  // 8. RBAC & activity isolation
  await dexieDataService.saveProductAtomic({
    id: 'dx-ph-only',
    activityId: 'pharmacy',
    code: 'DX-PH-1',
    nameAr: 'دواء صيدلية',
    category: 'أدوية',
    unit: 'علبة',
    purchasePrice: 5,
    sellPrice: 8,
    currentStock: 0,
    minStockAlert: 0,
  }, false);

  await loginAs(cashierUser, 'Pvar005-Cashier#2026');
  await assert.rejects(() => dexieDataService.saveBrandAtomic({ nameAr: 'Cashier Blocked' }), /RBAC|صلاحيات/);

  await loginAs(groceryKeeper, 'Pvar005-Keeper#2026');
  assert.equal((await dexieDataService.getProductCatalog()).some((e) => e.product.activityId === 'pharmacy'), false);
  assert.equal(await dexieDataService.getProductCatalogEntry('dx-ph-only'), undefined);

  await loginAs(adminUser, 'Pvar005-Admin#2026');
  const archivedFamily = await dexieDataService.archiveProductFamilyAtomic('dx-fam-shirt-01');
  assert.equal(archivedFamily.isActive, false);
  assert.equal((await dexieDataService.getProductFamilies('grocery', false)).length, 0);
  assert.equal((await dexieDataService.getProductFamilies('grocery', true)).length, 1);

  // 9. Reopen & accounting invariance
  await db.close();
  await db.open();
  const entry = await dexieDataService.getProductCatalogEntry('dx-sku-white-m');
  assert.equal(entry?.family?.nameAr, 'قميص قطني فاخر');
  assert.equal(entry?.brand?.id, brand.id);
  assert.equal(entry?.meta?.variantKey, 'color=%D8%A3%D8%A8%D9%8A%D8%B6&size=m');

  assert.deepEqual((await db.accounts.toArray()).map(({ code, balance }) => ({ code, balance })), accountsBefore);
  assert.deepEqual((await db.cashBoxes.toArray()).map(({ id, balance }) => ({ id, balance })), cashBoxesBefore);
  assert.equal(await db.journalEntries.count(), journalCountBefore);
});
