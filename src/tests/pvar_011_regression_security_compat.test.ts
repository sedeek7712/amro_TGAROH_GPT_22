import 'fake-indexeddb/auto';

if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage) {
  const store: Record<string, string> = {};
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = String(value);
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        for (const key in store) delete store[key];
      },
      key: (index: number) => Object.keys(store)[index] ?? null,
      get length() {
        return Object.keys(store).length;
      },
    },
    writable: true,
  });
}

import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/erpDatabase';
import { dexieDataService } from '../services/dexieDataService';
import { authService, hashPassword } from '../services/authService';
import { PermissionError } from '../config/rbac';
import { productMediaService } from '../services/productMediaService';
import { buildStockValuationReport } from '../utils/productCatalogReports';
import type { Brand, Invoice, Product, SystemUser } from '../types/erp';

const VALID_WEBP_DATA_URL = 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=';

let adminUser: SystemUser;
let pharmaKeeper: SystemUser;
let groceryCashier: SystemUser;
let southBranchCashier: SystemUser;
let allUsers: SystemUser[] = [];

async function loginAs(user: SystemUser, plainPassword: string) {
  authService.logout();
  const res = await authService.authenticate({
    username: user.username,
    password: plainPassword,
    users: allUsers,
    onUserUpdated: async (updated) => {
      await db.users.put(updated);
    },
  });
  assert.equal(res.success, true, `Login failed for ${user.username}`);
}

async function setupFreshDexie() {
  localStorage.clear();
  authService.logout();
  dexieDataService.resetForTests();
  await db.delete();
  await db.open();
  await dexieDataService.initialize();

  const existingUsers = await db.users.toArray();
  const baseAdmin = existingUsers.find((u) => u.role === 'ADMIN') || existingUsers[0];
  assert.ok(baseAdmin, 'Expected initial admin record');

  adminUser = {
    ...baseAdmin,
    passwordHash: await hashPassword('Admin#2026Pass'),
    mustChangePassword: false,
    active: true,
    tenantId: 'tenant_main',
    branchId: 'branch_main',
    allowedBranches: ['branch_main', 'branch_south'],
    allowedActivities: ['pharmacy', 'grocery', 'bike_parts', 'equipment_parts'],
  };

  pharmaKeeper = {
    id: 'pvar11-ph-keeper',
    username: 'pvar11_ph_keeper',
    fullName: 'أمين مخزن صيدلية',
    role: 'INVENTORY_KEEPER',
    tenantId: 'tenant_main',
    branchId: 'branch_main',
    allowedBranches: ['branch_main'],
    allowedActivities: ['pharmacy'],
    active: true,
    mustChangePassword: false,
    passwordHash: await hashPassword('Keeper#2026Pass'),
  };

  groceryCashier = {
    id: 'pvar11-gr-cashier',
    username: 'pvar11_gr_cashier',
    fullName: 'كاشير بقالة',
    role: 'CASHIER',
    tenantId: 'tenant_main',
    branchId: 'branch_main',
    allowedBranches: ['branch_main'],
    allowedActivities: ['grocery'],
    active: true,
    mustChangePassword: false,
    passwordHash: await hashPassword('Cashier#2026Pass'),
  };

  southBranchCashier = {
    id: 'pvar11-south-cashier',
    username: 'pvar11_south_cashier',
    fullName: 'كاشير فرع الجنوب',
    role: 'CASHIER',
    tenantId: 'tenant_main',
    branchId: 'branch_south',
    allowedBranches: ['branch_south'],
    allowedActivities: ['grocery'],
    active: true,
    mustChangePassword: false,
    passwordHash: await hashPassword('South#2026Pass'),
  };

  allUsers = [adminUser, pharmaKeeper, groceryCashier, southBranchCashier];
  await db.users.bulkPut(allUsers);
  await db.branches.put({
    id: 'branch_south',
    code: 'BR02',
    nameAr: 'فرع الجنوب',
    isMain: false,
    active: true,
    createdAt: '2026-11-01T00:00:00.000Z',
  });
  await db.cashBoxes.bulkPut([
    {
      id: 'cb-main-11',
      code: 'CB01',
      nameAr: 'الصندوق الرئيسي',
      accountCode: '1101',
      branchId: 'branch_main',
      balance: 10000,
      isDefault: true,
    },
    {
      id: 'cb-south-11',
      code: 'CB02',
      nameAr: 'صندوق الجنوب',
      accountCode: '1101',
      branchId: 'branch_south',
      balance: 2000,
      isDefault: false,
    },
  ]);

  await loginAs(adminUser, 'Admin#2026Pass');
}

beforeEach(async () => {
  await setupFreshDexie();
});

after(async () => {
  authService.logout();
  dexieDataService.resetForTests();
  db.close();
  await db.delete();
});

test('PVAR-011-01 Dexie: Uniqueness, cross-table barcode collisions, option schema guard, and atomic family rollback', async () => {
  const brand = await dexieDataService.saveBrandAtomic({ nameAr: '  Noor   Pharma  ' });
  assert.equal(brand.normalizedName, 'noor pharma');
  await assert.rejects(() => dexieDataService.saveBrandAtomic({ nameAr: 'noor pharma' }), /مسجلة بالفعل/);

  const standalone: Product = {
    id: 'dx11-standalone',
    activityId: 'grocery',
    code: 'DX11-LEG-1',
    barcode: '629110000001',
    nameAr: 'عصير تقليدي',
    category: 'مشروبات',
    unit: 'حبة',
    purchasePrice: 5,
    sellPrice: 8,
    currentStock: 0,
    minStockAlert: 1,
    isActive: true,
  };
  await dexieDataService.saveProductAtomic(standalone, false);

  const unitBox = await dexieDataService.saveProductUnit({
    productId: standalone.id,
    code: 'BOX',
    nameAr: 'كرتون',
    baseUnitsNumerator: 12,
    baseUnitsDenominator: 1,
    barcode: '629110000999',
  });

  // Cross-table barcode collisions must be rejected cleanly
  await assert.rejects(
    () =>
      dexieDataService.saveProductUnit({
        productId: standalone.id,
        code: 'PKT',
        nameAr: 'عبوة',
        baseUnitsNumerator: 6,
        baseUnitsDenominator: 1,
        barcode: '629110000001', // collides with product barcode
      }),
    /الباركود.*مستخدم بالفعل/
  );

  await assert.rejects(
    () =>
      dexieDataService.saveProductAtomic(
        {
          id: 'dx11-collide-unit',
          activityId: 'grocery',
          code: 'DX11-COL-U',
          barcode: '629110000999', // collides with unit barcode
          nameAr: 'صنف متعارض الباركود',
          category: 'مشروبات',
          unit: 'حبة',
          purchasePrice: 5,
          sellPrice: 8,
          currentStock: 0,
          minStockAlert: 0,
        },
        false
      ),
    /الباركود.*مستخدم بالفعل/
  );

  // Self-update keeping same barcode succeeds
  const updatedUnit = await dexieDataService.saveProductUnit({
    ...unitBox,
    nameAr: 'كرتون 12 حبة',
  });
  assert.equal(updatedUnit.barcode, '629110000999');

  // Cannot mutate base unit after alternate units exist
  await assert.rejects(
    () => dexieDataService.saveProductAtomic({ ...standalone, unit: 'كرتون' }, true),
    /لا يمكن تغيير وحدة المخزون الأساسية/
  );

  // Family atomic rollback when second SKU collides on barcode
  const productsBefore = await db.products.count();
  const familiesBefore = await db.productFamilies.count();
  await assert.rejects(
    () =>
      dexieDataService.createProductFamilyWithSkusAtomic({
        id: 'dx11-fam-rb',
        activityId: 'grocery',
        nameAr: 'حليب عائلي',
        brandId: brand.id,
        optionSchema: [{ key: 'Size', labelAr: 'الحجم', values: ['1L', '2L'], required: true, sortOrder: 1 }],
        skus: [
          {
            product: {
              id: 'dx11-rb-1',
              activityId: 'grocery',
              code: 'DX11-RB-1',
              barcode: '629110000501',
              nameAr: 'حليب 1L',
              category: 'ألبان',
              unit: 'حبة',
              purchasePrice: 4,
              sellPrice: 6,
              currentStock: 0,
              minStockAlert: 1,
            },
            variantAttributes: { size: '1l' },
          },
          {
            product: {
              id: 'dx11-rb-2',
              activityId: 'grocery',
              code: 'DX11-RB-2',
              barcode: '629110000999', // collides with unit barcode
              nameAr: 'حليب 2L',
              category: 'ألبان',
              unit: 'حبة',
              purchasePrice: 7,
              sellPrice: 10,
              currentStock: 0,
              minStockAlert: 1,
            },
            variantAttributes: { size: '2L' },
          },
        ],
      }),
    /الباركود/
  );
  assert.equal(await db.products.count(), productsBefore);
  assert.equal(await db.productFamilies.count(), familiesBefore);
});

test('PVAR-011-02 Dexie: E2E units conversion, FEFO, expired/archived blocking, historical return, and double-entry balance', async () => {
  const journalCountBaseline = await db.journalEntries.count();
  const brand = await dexieDataService.saveBrandAtomic({ nameAr: 'شركة الدواء الحديثة' });
  const fam = await dexieDataService.createProductFamilyWithSkusAtomic({
    id: 'dx11-ph-fam',
    activityId: 'pharmacy',
    nameAr: 'دواء شراب',
    categorySnapshot: 'أدوية',
    brandId: brand.id,
    optionSchema: [{ key: 'vol', labelAr: 'الحجم', values: ['100ml', '200ml'], required: true, sortOrder: 1 }],
    skus: [
      {
        product: {
          id: 'dx11-sku-100',
          activityId: 'pharmacy',
          code: 'PH11-100',
          barcode: '62811000101',
          nameAr: 'دواء شراب 100مل',
          category: 'أدوية',
          unit: 'عبوة',
          purchasePrice: 10,
          sellPrice: 18,
          currentStock: 0,
          minStockAlert: 2,
          isActive: true,
        },
        variantAttributes: { vol: '100ml' },
      },
      {
        product: {
          id: 'dx11-sku-200',
          activityId: 'pharmacy',
          code: 'PH11-200',
          barcode: '62811000102',
          nameAr: 'دواء شراب 200مل',
          category: 'أدوية',
          unit: 'عبوة',
          purchasePrice: 15,
          sellPrice: 25,
          currentStock: 0,
          minStockAlert: 2,
          isActive: true,
        },
        variantAttributes: { vol: '200ml' },
      },
    ],
  });
  assert.equal(fam.skus.length, 2);

  const cartonUnit = await dexieDataService.saveProductUnit({
    productId: 'dx11-sku-100',
    code: 'CTN',
    nameAr: 'كرتون',
    baseUnitsNumerator: 12,
    baseUnitsDenominator: 1,
    barcode: '62811000888',
  });

  await productMediaService.addProductImage({
    productId: 'dx11-sku-100',
    originalDataUrl: VALID_WEBP_DATA_URL,
    thumbnailDataUrl: VALID_WEBP_DATA_URL,
    mimeType: 'image/webp',
    width: 32,
    height: 32,
  });

  // Catalog setup with 0 stock + unit + media must create zero unintended accounting journals
  assert.equal(await db.journalEntries.count(), journalCountBaseline);

  // Purchase 2 cartons (24 base units) into soon-to-expire batch
  await dexieDataService.createPurchaseInvoiceAtomic({
    invoice: {
      id: 'dx11-pur-1',
      invoiceNumber: '',
      type: 'PURCHASE',
      activityId: 'pharmacy',
      branchId: 'branch_main',
      partyName: 'مورد دوائي',
      date: '2026-11-28',
      items: [
        {
          id: 'dx11-pi-1',
          productId: 'dx11-sku-100',
          productCode: 'PH11-100',
          productName: 'دواء شراب 100مل',
          unit: cartonUnit.nameAr,
          unitId: cartonUnit.id,
          quantity: 2,
          unitPrice: 120, // 10 per base unit
          discount: 0,
          total: 240,
        },
      ],
      subtotal: 240,
      discount: 0,
      tax: 0,
      total: 240,
      paidAmount: 240,
      paymentMethod: 'CASH',
      cashBoxId: 'cb-main-11',
    },
    itemsWithBatches: [
      {
        invoiceItemId: 'dx11-pi-1',
        productId: 'dx11-sku-100',
        unitId: cartonUnit.id,
        quantity: 2,
        costPrice: 120,
        batchNumber: 'BATCH-SOON',
        expiryDate: '2027-06-01',
      },
    ],
  });

  // Seed an expired batch on dx11-sku-200 and verify sale is blocked
  await dexieDataService.saveProductAtomic(
    {
      ...(await dexieDataService.getProductById('dx11-sku-200'))!,
      currentStock: 4,
      batches: [
        {
          id: 'dx11-exp-b1',
          productId: 'dx11-sku-200',
          batchNumber: 'BATCH-EXPIRED',
          expiryDate: '2023-01-01',
          quantity: 4,
          costPrice: 15,
        },
      ],
    },
    true
  );

  await assert.rejects(
    () =>
      dexieDataService.createSalesInvoiceAtomic({
        invoice: {
          id: 'dx11-sale-exp-deny',
          invoiceNumber: '',
          type: 'SALE',
          activityId: 'pharmacy',
          branchId: 'branch_main',
          partyName: 'عميل',
          date: '2026-11-28',
          items: [
            {
              id: 'dx11-si-exp',
              productId: 'dx11-sku-200',
              productCode: 'PH11-200',
              productName: 'دواء شراب 200مل',
              unit: 'عبوة',
              quantity: 1,
              unitPrice: 25,
              discount: 0,
              total: 25,
            },
          ],
          subtotal: 25,
          discount: 0,
          tax: 0,
          total: 25,
          paidAmount: 25,
          paymentMethod: 'CASH',
          cashBoxId: 'cb-main-11',
        },
        totalCogs: 15,
        stockDeductions: [{ invoiceItemId: 'dx11-si-exp', productId: 'dx11-sku-200', quantity: 1 }],
      }),
    /منتهية الصلاحية|غير المنتهي/
  );

  // Sell 1 carton (tampered baseQuantity ignored) + 2 base units from dx11-sku-100 (total 14 deducted -> 10 remaining)
  const sale = await dexieDataService.createSalesInvoiceAtomic({
    invoice: {
      id: 'dx11-sale-1',
      invoiceNumber: '',
      type: 'SALE',
      activityId: 'pharmacy',
      branchId: 'branch_main',
      partyName: 'عميل صيدلية',
      date: '2026-11-28',
      items: [
        {
          id: 'dx11-si-ctn',
          productId: 'dx11-sku-100',
          productCode: 'PH11-100',
          productName: 'دواء شراب 100مل',
          unit: cartonUnit.nameAr,
          unitId: cartonUnit.id,
          baseQuantity: 999, // forged client value must be recomputed to 12
          quantity: 1,
          unitPrice: 200,
          discount: 0,
          total: 200,
        },
        {
          id: 'dx11-si-base',
          productId: 'dx11-sku-100',
          productCode: 'PH11-100',
          productName: 'دواء شراب 100مل',
          unit: 'عبوة',
          quantity: 2,
          unitPrice: 18,
          discount: 0,
          total: 36,
        },
      ],
      subtotal: 236,
      discount: 0,
      tax: 0,
      total: 236,
      paidAmount: 236,
      paymentMethod: 'CASH',
      cashBoxId: 'cb-main-11',
    },
    totalCogs: 140,
    stockDeductions: [
      { invoiceItemId: 'dx11-si-ctn', productId: 'dx11-sku-100', quantity: 12 },
      { invoiceItemId: 'dx11-si-base', productId: 'dx11-sku-100', quantity: 2 },
    ],
  });

  assert.equal(sale.invoice.items[0].baseQuantity, 12);
  assert.equal((await dexieDataService.getProductById('dx11-sku-100'))?.currentStock, 10);

  // Archive SKU and modify unit ratio; historical sale return must still restore 12 base units via snapshot and future sale must fail
  await dexieDataService.saveProductUnit({
    ...cartonUnit,
    baseUnitsNumerator: 24,
    baseUnitsDenominator: 1,
  });
  await dexieDataService.saveProductAtomic(
    { ...(await dexieDataService.getProductById('dx11-sku-100'))!, isActive: false },
    true
  );

  await assert.rejects(
    () =>
      dexieDataService.createSalesInvoiceAtomic({
        invoice: {
          id: 'dx11-sale-archived-deny',
          invoiceNumber: '',
          type: 'SALE',
          activityId: 'pharmacy',
          branchId: 'branch_main',
          partyName: 'عميل',
          date: '2026-11-28',
          items: [
            {
              id: 'dx11-si-arch',
              productId: 'dx11-sku-100',
              productCode: 'PH11-100',
              productName: 'دواء شراب 100مل',
              unit: 'عبوة',
              quantity: 1,
              unitPrice: 18,
              discount: 0,
              total: 18,
            },
          ],
          subtotal: 18,
          discount: 0,
          tax: 0,
          total: 18,
          paidAmount: 18,
          paymentMethod: 'CASH',
          cashBoxId: 'cb-main-11',
        },
        totalCogs: 10,
        stockDeductions: [{ invoiceItemId: 'dx11-si-arch', productId: 'dx11-sku-100', quantity: 1 }],
      }),
    /مؤرشف/
  );

  await dexieDataService.createSalesReturnAtomic({
    originalInvoiceId: sale.invoice.id,
    items: [{ originalInvoiceItemId: 'dx11-si-ctn', productId: 'dx11-sku-100', quantity: 1 }],
    returnReason: 'إرجاع كرتون بالسعر واللقطة التاريخية',
    refundMethod: 'CASH',
    cashBoxId: 'cb-main-11',
  });

  // 10 + 12 (snapshot, NOT 24) = 22
  assert.equal((await dexieDataService.getProductById('dx11-sku-100'))?.currentStock, 22);

  // Every posted journal entry must remain strictly balanced
  const journals = await db.journalEntries.toArray();
  assert.ok(journals.length > journalCountBaseline);
  for (const jv of journals) {
    const dr = jv.lines.reduce((s, l) => s + l.debit, 0);
    const cr = jv.lines.reduce((s, l) => s + l.credit, 0);
    assert.ok(Math.abs(dr - cr) < 0.001, `Unbalanced journal ${jv.entryNumber}: Dr=${dr} Cr=${cr}`);
  }
});

test('PVAR-011-03 Dexie: RBAC, activity/branch isolation on catalog/units/media/backups, and UI dataService boundary', async () => {
  await dexieDataService.createProductFamilyWithSkusAtomic({
    id: 'dx11-gr-fam',
    activityId: 'grocery',
    nameAr: 'زيت بقالة',
    optionSchema: [{ key: 'vol', labelAr: 'الحجم', values: ['1L'], required: true, sortOrder: 1 }],
    skus: [
      {
        product: {
          id: 'dx11-gr-sku1',
          activityId: 'grocery',
          code: 'GR11-1L',
          barcode: '62911900001',
          nameAr: 'زيت 1 لتر',
          category: 'زيوت',
          unit: 'حبة',
          purchasePrice: 10,
          sellPrice: 15,
          currentStock: 5,
          minStockAlert: 1,
        },
        variantAttributes: { vol: '1L' },
      },
    ],
  });

  // Pharmacy-only keeper must neither read nor mutate grocery families, SKUs, units, or images
  await loginAs(pharmaKeeper, 'Keeper#2026Pass');
  assert.equal((await dexieDataService.getProductFamilies(undefined, true)).some((f) => f.id === 'dx11-gr-fam'), false);
  assert.equal(await dexieDataService.getProductCatalogEntry('dx11-gr-sku1'), undefined);
  await assert.rejects(
    () =>
      dexieDataService.saveProductUnit({
        productId: 'dx11-gr-sku1',
        code: 'BOX',
        nameAr: 'كرتون',
        baseUnitsNumerator: 6,
        baseUnitsDenominator: 1,
      }),
    (err: unknown) => err instanceof PermissionError
  );
  await assert.rejects(
    () =>
      productMediaService.addProductImage({
        productId: 'dx11-gr-sku1',
        originalDataUrl: VALID_WEBP_DATA_URL,
        thumbnailDataUrl: VALID_WEBP_DATA_URL,
        mimeType: 'image/webp',
        width: 32,
        height: 32,
      }),
    (err: unknown) => err instanceof PermissionError || (err instanceof Error && /خارج الأنشطة|عزل الأنشطة/.test(err.message))
  );
  await assert.rejects(
    () => dexieDataService.importBackupJSON('{}'),
    (err: unknown) => err instanceof PermissionError
  );

  // Cashier cannot manage brands, families, units, images, or export backups
  await loginAs(groceryCashier, 'Cashier#2026Pass');
  await assert.rejects(
    () => dexieDataService.saveBrandAtomic({ nameAr: 'ممنوع' }),
    (err: unknown) => err instanceof PermissionError
  );
  await assert.rejects(
    () =>
      dexieDataService.saveProductUnit({
        productId: 'dx11-gr-sku1',
        code: 'BOX',
        nameAr: 'كرتون',
        baseUnitsNumerator: 6,
        baseUnitsDenominator: 1,
      }),
    (err: unknown) => err instanceof PermissionError
  );
  await assert.rejects(
    () => dexieDataService.exportBackupJSON(),
    (err: unknown) => err instanceof PermissionError
  );

  // Branch isolation: main-branch cashier blocked from selling on branch_south
  await assert.rejects(
    () =>
      dexieDataService.createSalesInvoiceAtomic({
        invoice: {
          id: 'dx11-cross-branch',
          invoiceNumber: '',
          type: 'SALE',
          activityId: 'grocery',
          branchId: 'branch_south',
          partyName: 'عميل',
          date: '2026-11-28',
          items: [
            {
              id: 'dx11-cb-1',
              productId: 'dx11-gr-sku1',
              productCode: 'GR11-1L',
              productName: 'زيت 1 لتر',
              unit: 'حبة',
              quantity: 1,
              unitPrice: 15,
              discount: 0,
              total: 15,
            },
          ],
          subtotal: 15,
          discount: 0,
          tax: 0,
          total: 15,
          paidAmount: 15,
          paymentMethod: 'CASH',
          cashBoxId: 'cb-south-11',
        },
        totalCogs: 10,
        stockDeductions: [{ invoiceItemId: 'dx11-cb-1', productId: 'dx11-gr-sku1', quantity: 1 }],
      }),
    (err: unknown) => err instanceof PermissionError
  );

  // Architectural boundary: operational UI modules must use dataService, never dexieDataService directly
  const operationalDirs = [
    'inventory',
    'pos',
    'purchases',
    'reports',
    'accounting',
    'cash',
    'amanat',
    'parties',
    'users',
    'sync',
  ];
  const walk = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
    }
    return out;
  };
  for (const folder of operationalDirs) {
    for (const file of walk(path.resolve(process.cwd(), 'src/components', folder))) {
      const content = fs.readFileSync(file, 'utf8');
      assert.equal(
        /from\s+['"][^'"]*services\/dexieDataService['"]/.test(content),
        false,
        `Operational UI component must not import dexieDataService directly: ${file}`
      );
    }
  }
});

test('PVAR-011-04 Dexie: Legacy invoice return + legacy v2.0 backup restore + valuation report non-double-counting', async () => {
  // Seed legacy product + legacy invoice (no unitId / baseQuantity / familyId / brandId)
  const legacyProd: Product = {
    id: 'dx11-legacy-p',
    activityId: 'grocery',
    code: 'LEG11-01',
    nameAr: 'سكر قديم',
    category: 'أساسيات',
    unit: 'كيس',
    purchasePrice: 20,
    sellPrice: 30,
    currentStock: 8,
    minStockAlert: 1,
  };
  await dexieDataService.saveProductAtomic(legacyProd, false);
  const legacyInvoice: Invoice = {
    id: 'dx11-leg-inv-1',
    invoiceNumber: 'INV-LEG-11',
    type: 'SALE',
    activityId: 'grocery',
    branchId: 'branch_main',
    partyName: 'عميل قديم',
    date: '2026-11-15',
    items: [
      {
        id: 'dx11-leg-ii-1',
        productId: legacyProd.id,
        productCode: legacyProd.code,
        productName: legacyProd.nameAr,
        unit: 'كيس',
        quantity: 2,
        unitPrice: 30,
        discount: 0,
        total: 60,
      },
    ],
    subtotal: 60,
    discount: 0,
    tax: 0,
    total: 60,
    paidAmount: 60,
    paymentMethod: 'CASH',
    cashBoxId: 'cb-main-11',
    isPosted: true,
  };
  await db.invoices.put(legacyInvoice);

  // Returning against legacy invoice (omitting unitId/baseQuantity) works seamlessly
  await dexieDataService.createSalesReturnAtomic({
    originalInvoiceId: legacyInvoice.id,
    items: [{ productId: legacyProd.id, quantity: 1 }],
    returnReason: 'مرتجع فاتورة تاريخية',
    refundMethod: 'CASH',
    cashBoxId: 'cb-main-11',
  });
  assert.equal((await dexieDataService.getProductById(legacyProd.id))?.currentStock, 9);

  // Check report aggregation combining family SKUs + legacy standalone item
  const famBrand: Brand = await dexieDataService.saveBrandAtomic({ nameAr: 'علامة تقرير' });
  const famCreated = await dexieDataService.createProductFamilyWithSkusAtomic({
    id: 'dx11-rep-fam',
    activityId: 'grocery',
    nameAr: 'أرز بسمتي',
    brandId: famBrand.id,
    optionSchema: [{ key: 'w', labelAr: 'الوزن', values: ['5kg', '10kg'], required: true, sortOrder: 1 }],
    skus: [
      {
        product: {
          id: 'dx11-rep-5',
          activityId: 'grocery',
          code: 'RICE-5',
          nameAr: 'أرز 5 كجم',
          category: 'أرز',
          unit: 'كيس',
          purchasePrice: 25,
          sellPrice: 35,
          currentStock: 4,
          minStockAlert: 1,
        },
        variantAttributes: { w: '5kg' },
      },
      {
        product: {
          id: 'dx11-rep-10',
          activityId: 'grocery',
          code: 'RICE-10',
          nameAr: 'أرز 10 كجم',
          category: 'أرز',
          unit: 'كيس',
          purchasePrice: 48,
          sellPrice: 65,
          currentStock: 2,
          minStockAlert: 1,
        },
        variantAttributes: { w: '10kg' },
      },
    ],
  });

  const entries = await dexieDataService.getProductCatalog();
  const stockReport = buildStockValuationReport({ entries, families: [famCreated.family], brands: [famBrand] });
  const groupedQty =
    stockReport.familyGroups.reduce((s, g) => s + g.totalQty, 0) +
    stockReport.standaloneRows.reduce((s, r) => s + r.qty, 0);
  const groupedCost =
    stockReport.familyGroups.reduce((s, g) => s + g.totalCost, 0) +
    stockReport.standaloneRows.reduce((s, r) => s + r.costValue, 0);
  assert.equal(groupedQty, stockReport.summary.totalQty);
  assert.equal(groupedCost, stockReport.summary.totalCost);
  assert.equal(stockReport.summary.totalQty, 15); // 9 + 4 + 2
  assert.equal(stockReport.summary.totalCost, 9 * 20 + 4 * 25 + 2 * 48); // 376

  // Legacy v2.0 backup (no catalog/units/images keys) restores cleanly without leaving stale catalog/media
  const fullJson = await dexieDataService.exportBackupJSON();
  const parsed = JSON.parse(fullJson);
  parsed.version = '2.0';
  delete parsed.data.brands;
  delete parsed.data.productFamilies;
  delete parsed.data.productCatalogMeta;
  delete parsed.data.productUnits;
  delete parsed.data.productImages;
  delete parsed.data.mediaManifest;
  const serialized = JSON.stringify(parsed.data);
  let calc = 0;
  for (let i = 0; i < serialized.length; i += 1) {
    calc = (calc + serialized.charCodeAt(i) * (i + 1)) % 1000000007;
  }
  parsed.checksum = calc.toString(16);
  const importRes = await dexieDataService.importBackupJSON(JSON.stringify(parsed));
  assert.equal(importRes.success, true, importRes.error);

  assert.equal((await db.brands.count()), 0);
  assert.equal((await db.productFamilies.count()), 0);
  assert.equal((await db.productCatalogMeta.count()), 0);
  assert.equal((await db.productUnits.count()), 0);
  assert.equal((await db.productImages.count()), 0);
  assert.equal((await db.products.get(legacyProd.id))?.currentStock, 9);
});
