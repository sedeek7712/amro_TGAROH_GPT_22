import 'fake-indexeddb/auto';

if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage) {
  const store: Record<string, string> = {};
  const mockStorage = {
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
  };
  Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true });
}

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/erpDatabase';
import { dexieDataService } from '../services/dexieDataService';
import { authService, hashPassword } from '../services/authService';
import {
  buildPosCatalogView,
  buildVariantInvoiceItemSnapshot,
  formatVariantSummary,
  getSkuSaleabilityStatus,
  matchesPosCatalogSearch,
  resolvePosScanTarget,
} from '../utils/posCatalog';
import { buildInvoiceNotificationPayload } from '../utils/documentNotifications';
import type { Brand, Invoice, ProductCatalogEntry, ProductFamily } from '../types/erp';

const sampleBrand: Brand = {
  id: 'brand-pos-1',
  tenantId: 'tenant_main',
  nameAr: 'النماري برو',
  normalizedName: 'النماري برو',
  isActive: true,
};

const sampleFamily: ProductFamily = {
  id: 'fam-pos-1',
  tenantId: 'tenant_main',
  activityId: 'grocery',
  nameAr: 'تيشيرت قطني',
  categorySnapshot: 'ملابس',
  brandId: sampleBrand.id,
  optionSchema: [
    { key: 'color', labelAr: 'اللون', values: ['أبيض', 'أسود'], required: true, sortOrder: 1 },
    { key: 'size', labelAr: 'المقاس', values: ['M', 'L'], required: true, sortOrder: 2 },
  ],
  isActive: true,
  createdAt: '2026-11-28T00:00:00.000Z',
  updatedAt: '2026-11-28T00:00:00.000Z',
};

const activeEntry: ProductCatalogEntry = {
  product: {
    id: 'sku-active-1',
    activityId: 'grocery',
    code: 'FOD-9001-V01',
    barcode: '6289000011111',
    nameAr: 'تيشيرت قطني - أبيض / M',
    category: 'ملابس',
    unit: 'حبة',
    purchasePrice: 20,
    sellPrice: 35,
    currentStock: 10,
    minStockAlert: 2,
    isActive: true,
  },
  meta: {
    productId: 'sku-active-1',
    tenantId: 'tenant_main',
    familyId: sampleFamily.id,
    variantKey: 'color=أبيض&size=m',
    variantAttributes: { color: 'أبيض', size: 'M' },
  },
  family: sampleFamily,
  brand: sampleBrand,
  variantAttributes: { color: 'أبيض', size: 'M' },
  units: [
    {
      id: 'unit-box-1',
      tenantId: 'tenant_main',
      productId: 'sku-active-1',
      code: 'BOX12',
      nameAr: 'كرتون 12',
      baseUnitsNumerator: 12,
      baseUnitsDenominator: 1,
      barcode: '6289000099999',
      normalizedBarcode: '6289000099999',
      isActive: true,
      createdAt: '2026-11-28T00:00:00.000Z',
      updatedAt: '2026-11-28T00:00:00.000Z',
    },
    {
      id: 'unit-old-disabled',
      tenantId: 'tenant_main',
      productId: 'sku-active-1',
      code: 'OLD',
      nameAr: 'قديم',
      baseUnitsNumerator: 6,
      baseUnitsDenominator: 1,
      barcode: '6289000088888',
      normalizedBarcode: '6289000088888',
      isActive: false,
      createdAt: '2026-11-28T00:00:00.000Z',
      updatedAt: '2026-11-28T00:00:00.000Z',
    },
  ],
};

const archivedEntry: ProductCatalogEntry = {
  product: {
    id: 'sku-archived-2',
    activityId: 'grocery',
    code: 'FOD-9001-V02',
    barcode: '6289000022222',
    nameAr: 'تيشيرت قطني - أسود / L',
    category: 'ملابس',
    unit: 'حبة',
    purchasePrice: 22,
    sellPrice: 38,
    currentStock: 6,
    minStockAlert: 2,
    isActive: false,
  },
  meta: {
    productId: 'sku-archived-2',
    tenantId: 'tenant_main',
    familyId: sampleFamily.id,
    variantKey: 'color=أسود&size=l',
    variantAttributes: { color: 'أسود', size: 'L' },
  },
  family: sampleFamily,
  brand: sampleBrand,
  variantAttributes: { color: 'أسود', size: 'L' },
  units: [],
};

const expiredBatchEntry: ProductCatalogEntry = {
  product: {
    id: 'sku-expired-3',
    activityId: 'pharmacy',
    code: 'MED-9001',
    barcode: '6289000033333',
    nameAr: 'شراب منتهي',
    category: 'أدوية',
    unit: 'علبة',
    purchasePrice: 10,
    sellPrice: 15,
    currentStock: 4,
    minStockAlert: 1,
    isActive: true,
    batches: [
      {
        id: 'b-exp',
        productId: 'sku-expired-3',
        batchNumber: 'B-OLD',
        expiryDate: '2025-01-01',
        quantity: 4,
        costPrice: 10,
      },
    ],
  },
  variantAttributes: {},
  units: [],
};

const standaloneEntry: ProductCatalogEntry = {
  product: {
    id: 'sku-standalone-4',
    activityId: 'grocery',
    code: 'FOD-9002',
    barcode: '6289000044444',
    nameAr: 'حليب طازج',
    category: 'ألبان',
    unit: 'عبوة',
    purchasePrice: 4,
    sellPrice: 6,
    currentStock: 25,
    minStockAlert: 5,
    isActive: true,
  },
  variantAttributes: {},
  units: [],
};

test('PVAR-007 POS helpers resolve barcode/SKU/unit barcode scans and block archived or expired SKUs', () => {
  const entries = [activeEntry, archivedEntry, expiredBatchEntry, standaloneEntry];

  assert.equal(matchesPosCatalogSearch(activeEntry, 'أبيض'), true);
  assert.equal(matchesPosCatalogSearch(activeEntry, 'النماري'), true);
  assert.equal(matchesPosCatalogSearch(activeEntry, '6289000099999'), true);
  assert.equal(matchesPosCatalogSearch(activeEntry, '6289000088888'), false);

  const bySkuBarcode = resolvePosScanTarget(entries, '6289000011111', '2026-11-28');
  assert.equal(bySkuBarcode?.entry.product.id, 'sku-active-1');
  assert.equal(bySkuBarcode?.matchedBy, 'BARCODE');
  assert.equal(bySkuBarcode?.saleability.sellable, true);

  const bySkuCode = resolvePosScanTarget(entries, 'fod-9001-v01', '2026-11-28');
  assert.equal(bySkuCode?.entry.product.id, 'sku-active-1');
  assert.equal(bySkuCode?.matchedBy, 'CODE');

  const byUnitBarcode = resolvePosScanTarget(entries, '6289000099999', '2026-11-28');
  assert.equal(byUnitBarcode?.entry.product.id, 'sku-active-1');
  assert.equal(byUnitBarcode?.matchedBy, 'UNIT_BARCODE');
  assert.equal(byUnitBarcode?.matchedUnitName, 'كرتون 12');

  const disabledUnitScan = resolvePosScanTarget(entries, '6289000088888', '2026-11-28');
  assert.equal(disabledUnitScan, null);

  const archivedScan = resolvePosScanTarget(entries, '6289000022222', '2026-11-28');
  assert.equal(archivedScan?.saleability.sellable, false);
  assert.equal(archivedScan?.saleability.reason, 'ARCHIVED');

  const expiredStatus = getSkuSaleabilityStatus(expiredBatchEntry, '2026-11-28');
  assert.equal(expiredStatus.sellable, false);
  assert.equal(expiredStatus.reason, 'EXPIRED');
});

test('PVAR-007 POS catalog grouping keeps derived family stock accurate and surfaces SKUs on search', () => {
  const entries = [activeEntry, archivedEntry, standaloneEntry];

  const browseView = buildPosCatalogView({
    entries,
    families: [sampleFamily],
    brands: [sampleBrand],
    searchQuery: '',
    todayDate: '2026-11-28',
  });
  assert.equal(browseView.isSearching, false);
  assert.equal(browseView.familyCards.length, 1);
  assert.equal(browseView.familyCards[0].derivedActiveStock, 10);
  assert.equal(browseView.familyCards[0].activeEntries.length, 1);
  assert.equal(browseView.standaloneEntries.length, 1);

  const searchView = buildPosCatalogView({
    entries,
    families: [sampleFamily],
    brands: [sampleBrand],
    searchQuery: 'أبيض',
    todayDate: '2026-11-28',
  });
  assert.equal(searchView.isSearching, true);
  assert.equal(searchView.directSearchEntries.length, 1);
  assert.equal(searchView.directSearchEntries[0].product.id, 'sku-active-1');

  const archivedSearchView = buildPosCatalogView({
    entries,
    families: [sampleFamily],
    brands: [sampleBrand],
    searchQuery: 'أسود',
    todayDate: '2026-11-28',
  });
  assert.equal(archivedSearchView.directSearchEntries.length, 0);
});

test('PVAR-007 variant snapshot formats cleanly for cart, invoice, and notification summaries', () => {
  assert.equal(
    formatVariantSummary(activeEntry.variantAttributes, sampleFamily.optionSchema),
    'اللون: أبيض · المقاس: M'
  );

  const snapshot = buildVariantInvoiceItemSnapshot(activeEntry);
  assert.equal(snapshot.familyId, sampleFamily.id);
  assert.equal(snapshot.familyNameSnapshot, 'تيشيرت قطني');
  assert.equal(snapshot.brandNameSnapshot, 'النماري برو');
  assert.deepEqual(snapshot.variantAttributesSnapshot, { color: 'أبيض', size: 'M' });
  assert.equal(snapshot.variantSummary, 'اللون: أبيض · المقاس: M');

  const invoice: Invoice = {
    id: 'inv-var-1',
    invoiceNumber: 'INV-100',
    type: 'SALE',
    activityId: 'grocery',
    partyName: 'عميل نقدي',
    date: '2026-11-28',
    items: [
      {
        id: 'item-1',
        productId: activeEntry.product.id,
        productName: activeEntry.product.nameAr,
        productCode: activeEntry.product.code,
        ...snapshot,
        unit: activeEntry.product.unit,
        quantity: 2,
        unitPrice: 35,
        discount: 0,
        total: 70,
      },
    ],
    subtotal: 70,
    discount: 0,
    tax: 0,
    total: 70,
    paidAmount: 70,
    paymentMethod: 'CASH',
    cashBoxId: 'cb-1',
  };

  const notif = buildInvoiceNotificationPayload({ invoice, activityName: 'البقالة والأغذية' });
  assert.ok(notif.itemsSummary?.includes('اللون: أبيض · المقاس: M'));
});

before(async () => {
  localStorage.clear();
  authService.logout();
  dexieDataService.resetForTests();
  await db.invoices.clear();
  await db.journalEntries.clear();
  await db.products.clear();
  await db.productBatches.clear();
  await db.productFamilies.clear();
  await db.productCatalogMeta.clear();
  await db.brands.clear();
  await db.productUnits.clear();
  await db.cashBoxes.clear();
  await db.accounts.clear();
  await db.parties.clear();
  await db.outbox.clear();
  await db.sequences.clear();
  await db.auditLogs.clear();
  await db.users.clear();
  await db.open();
  await dexieDataService.initialize();

  const admin = {
    id: 'usr-pvar007-admin',
    username: 'pvar007_admin',
    fullName: 'PVAR-007 Admin',
    role: 'ADMIN' as const,
    allowedActivities: ['pharmacy', 'grocery', 'bike_parts', 'equipment_parts'] as const,
    branchId: 'branch_main',
    allowedBranches: ['branch_main'],
    tenantId: 'tenant_main',
    active: true,
    passwordHash: await hashPassword('Pvar007-Admin#2026'),
  };
  await db.users.put({ ...admin, allowedActivities: [...admin.allowedActivities] });
  const login = await authService.authenticate({
    username: admin.username,
    password: 'Pvar007-Admin#2026',
    users: [{ ...admin, allowedActivities: [...admin.allowedActivities] }],
    onUserUpdated: async (updated) => {
      await db.users.put(updated);
    },
  });
  assert.equal(login.success, true);
});

after(async () => {
  authService.logout();
  dexieDataService.resetForTests();
  db.close();
});

test('PVAR-007 Dexie sales checkout rejects archived SKUs and persists variant identity on active SKU invoice items', async () => {
  const cashBoxes = await dexieDataService.getCashBoxes();
  const cashBoxId = cashBoxes[0].id;

  const brand = await dexieDataService.saveBrandAtomic({ nameAr: 'ماركة نقاط البيع' });
  const created = await dexieDataService.createProductFamilyWithSkusAtomic({
    id: 'dx-pos-fam-1',
    activityId: 'grocery',
    nameAr: 'جاكيت شتوي',
    categorySnapshot: 'ملابس',
    brandId: brand.id,
    optionSchema: [
      { key: 'color', labelAr: 'اللون', values: ['كحلي', 'أسود'], required: true, sortOrder: 1 },
    ],
    skus: [
      {
        product: {
          id: 'dx-pos-sku-active',
          activityId: 'grocery',
          code: 'POS-JKT-01',
          barcode: '6287700001',
          nameAr: 'جاكيت شتوي - كحلي',
          category: 'ملابس',
          unit: 'قطعة',
          purchasePrice: 50,
          sellPrice: 90,
          currentStock: 5,
          minStockAlert: 1,
          isActive: true,
        },
        variantAttributes: { color: 'كحلي' },
      },
      {
        product: {
          id: 'dx-pos-sku-archived',
          activityId: 'grocery',
          code: 'POS-JKT-02',
          barcode: '6287700002',
          nameAr: 'جاكيت شتوي - أسود',
          category: 'ملابس',
          unit: 'قطعة',
          purchasePrice: 50,
          sellPrice: 90,
          currentStock: 4,
          minStockAlert: 1,
          isActive: false,
        },
        variantAttributes: { color: 'أسود' },
      },
    ],
  });

  const activeCatalogEntry = created.skus.find((s) => s.product.id === 'dx-pos-sku-active')!;
  const snapshot = buildVariantInvoiceItemSnapshot(activeCatalogEntry);

  // Archived SKU must be rejected atomically
  await assert.rejects(
    () =>
      dexieDataService.createSalesInvoiceAtomic({
        invoice: {
          id: 'inv-archived-fail',
          invoiceNumber: '',
          type: 'SALE',
          activityId: 'grocery',
          branchId: 'branch_main',
          partyName: 'عميل نقدي',
          date: '2026-11-28',
          items: [
            {
              id: 'item-arch',
              productId: 'dx-pos-sku-archived',
              productName: 'جاكيت شتوي - أسود',
              productCode: 'POS-JKT-02',
              unit: 'قطعة',
              quantity: 1,
              unitPrice: 90,
              discount: 0,
              total: 90,
            },
          ],
          subtotal: 90,
          discount: 0,
          tax: 0,
          total: 90,
          paidAmount: 90,
          paymentMethod: 'CASH',
          cashBoxId,
        },
        totalCogs: 50,
        stockDeductions: [{ productId: 'dx-pos-sku-archived', quantity: 1 }],
      }),
    /مؤرشف ومعطل ولا يمكن بيعه/
  );

  // Active SKU checkout deducts only the exact SKU stock and persists variant snapshot
  const saleResult = await dexieDataService.createSalesInvoiceAtomic({
    invoice: {
      id: 'inv-pos-variant-ok',
      invoiceNumber: '',
      type: 'SALE',
      activityId: 'grocery',
      branchId: 'branch_main',
      partyName: 'عميل نقدي',
      date: '2026-11-28',
      items: [
        {
          id: 'item-ok-1',
          productId: 'dx-pos-sku-active',
          productName: 'جاكيت شتوي - كحلي',
          productCode: 'POS-JKT-01',
          ...snapshot,
          unit: 'قطعة',
          quantity: 2,
          unitPrice: 90,
          discount: 0,
          total: 180,
        },
      ],
      subtotal: 180,
      discount: 0,
      tax: 0,
      total: 180,
      paidAmount: 180,
      paymentMethod: 'CASH',
      cashBoxId,
    },
    totalCogs: 100,
    stockDeductions: [{ productId: 'dx-pos-sku-active', quantity: 2 }],
  });

  assert.equal(saleResult.invoice.items[0].productId, 'dx-pos-sku-active');
  assert.equal(saleResult.invoice.items[0].variantSummary, 'اللون: كحلي');
  assert.equal((await dexieDataService.getProductById('dx-pos-sku-active'))?.currentStock, 3);
  assert.equal((await dexieDataService.getProductById('dx-pos-sku-archived'))?.currentStock, 4);
});
