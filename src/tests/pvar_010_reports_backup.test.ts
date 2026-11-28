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
import { buildStockValuationReport, getStockValuationLevelLabel } from '../utils/productCatalogReports';
import { buildReportDocumentSnapshot } from '../services/documents/documentService';
import { resolveEnterpriseDocumentMeta } from '../utils/documentBranding';
import type { Brand, Product, ProductCatalogEntry, ProductFamily, ProductImageLocalAsset } from '../types/erp';

// Valid 1x1 lossless WebP bytes (RIFF....WEBPVP8L...)
const WEBP_1X1_BASE64 = 'UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=';
function makeWebpBlob(): Blob {
  const bytes = Uint8Array.from(Buffer.from(WEBP_1X1_BASE64, 'base64'));
  return new Blob([bytes], { type: 'image/webp' });
}

async function computeSha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function resetDexieAndSeedAdmin() {
  localStorage.clear();
  authService.logout();
  dexieDataService.resetForTests();
  await db.delete();
  await db.open();
  await dexieDataService.initialize();

  const users = await db.users.toArray();
  const baseAdmin = users.find((u) => u.role === 'ADMIN') || users[0];
  assert.ok(baseAdmin, 'Expected seeded admin user');
  const updatedAdmin = {
    ...baseAdmin,
    passwordHash: await hashPassword('Admin#2026'),
    mustChangePassword: false,
    active: true,
    tenantId: baseAdmin.tenantId || 'tenant_main',
    branchId: baseAdmin.branchId || 'branch_main',
    allowedBranches:
      Array.isArray(baseAdmin.allowedBranches) && baseAdmin.allowedBranches.length > 0
        ? baseAdmin.allowedBranches
        : ['branch_main'],
    allowedActivities: ['pharmacy', 'grocery', 'bike_parts', 'equipment_parts'] as const,
  };
  await db.users.put({ ...updatedAdmin, allowedActivities: [...updatedAdmin.allowedActivities] });
  const login = await authService.authenticate({
    username: updatedAdmin.username,
    password: 'Admin#2026',
    users: [{ ...updatedAdmin, allowedActivities: [...updatedAdmin.allowedActivities] }],
    onUserUpdated: async (u) => {
      await db.users.put(u);
    },
  });
  assert.equal(login.success, true);

  const cashBoxes = await db.cashBoxes.toArray();
  if (cashBoxes.length === 0) {
    await db.cashBoxes.put({
      id: 'cb-pvar10-main',
      code: 'CB01',
      nameAr: 'الصندوق الرئيسي',
      accountCode: '11011',
      branchId: 'branch_main',
      balance: 0,
      isDefault: true,
    });
  }
  return updatedAdmin;
}

before(async () => {
  await resetDexieAndSeedAdmin();
});

after(async () => {
  authService.logout();
  await db.delete();
});

test('PVAR-010 Reports: family valuation aggregates from child SKUs without double-counting and exposes aggregation level', () => {
  const brand: Brand = {
    id: 'br-1',
    tenantId: 'tenant_main',
    nameAr: 'المراعي',
    normalizedName: 'المراعي',
    isActive: true,
    createdAt: '2026-11-27T10:00:00Z',
    updatedAt: '2026-11-27T10:00:00Z',
  };
  const family: ProductFamily = {
    id: 'fam-1',
    tenantId: 'tenant_main',
    activityId: 'grocery',
    nameAr: 'حليب طازج',
    categorySnapshot: 'ألبان',
    brandId: brand.id,
    optionSchema: [{ key: 'size', labelAr: 'الحجم', values: ['1 لتر', '500 مل'], required: true, sortOrder: 0 }],
    isActive: true,
    createdAt: '2026-11-27T10:00:00Z',
    updatedAt: '2026-11-27T10:00:00Z',
  };

  const sku1: Product = {
    id: 'sku-milk-1l',
    activityId: 'grocery',
    code: 'MILK-1L',
    nameAr: 'حليب طازج - 1 لتر',
    category: 'ألبان',
    unit: 'عبوة',
    purchasePrice: 400,
    sellPrice: 500,
    currentStock: 10,
    minStockAlert: 2,
    isActive: true,
  };
  const sku2Archived: Product = {
    id: 'sku-milk-500ml',
    activityId: 'grocery',
    code: 'MILK-500',
    nameAr: 'حليب طازج - 500 مل',
    category: 'ألبان',
    unit: 'عبوة',
    purchasePrice: 200,
    sellPrice: 260,
    currentStock: 5,
    minStockAlert: 1,
    isActive: false,
  };
  const standalonePharmacy: Product = {
    id: 'sku-pharma-1',
    activityId: 'pharmacy',
    code: 'PH-001',
    nameAr: 'دواء شراب',
    category: 'أدوية',
    unit: 'زجاجة',
    purchasePrice: 999, // Batch cost below must take precedence over flat purchasePrice
    sellPrice: 300,
    currentStock: 12,
    minStockAlert: 2,
    trackExpiry: true,
    batches: [
      { id: 'b1', productId: 'sku-pharma-1', batchNumber: 'B1', expiryDate: '2027-06-01', quantity: 7, costPrice: 100 },
      { id: 'b2', productId: 'sku-pharma-1', batchNumber: 'B2', expiryDate: '2027-09-01', quantity: 5, costPrice: 120 },
    ],
    isActive: true,
  };

  const entries: ProductCatalogEntry[] = [
    {
      product: sku1,
      family,
      brand,
      variantAttributes: { size: '1 لتر' },
      units: [],
    },
    {
      product: sku2Archived,
      family,
      brand,
      variantAttributes: { size: '500 مل' },
      units: [],
    },
    {
      product: standalonePharmacy,
      brand,
      variantAttributes: {},
      units: [],
    },
  ];

  const report = buildStockValuationReport({
    entries,
    products: [sku1, sku2Archived, standalonePharmacy],
    families: [family],
    brands: [brand],
    activityFilter: 'ALL',
    searchQuery: '',
  });

  // Check family derived totals = sku1 + sku2 only
  assert.equal(report.familyGroups.length, 1);
  const group = report.familyGroups[0];
  assert.equal(group.derivedFromSkus, true);
  assert.equal(group.skuCount, 2);
  assert.equal(group.activeSkuCount, 1);
  assert.equal(group.archivedSkuCount, 1);
  assert.equal(group.totalQty, 15);
  assert.equal(group.totalCost, 10 * 400 + 5 * 200); // 5000
  assert.equal(group.totalRetail, 10 * 500 + 5 * 260); // 6300

  // Check batch-accurate valuation on standalone pharmacy product
  assert.equal(report.standaloneRows.length, 1);
  assert.equal(report.standaloneRows[0].costValue, 7 * 100 + 5 * 120); // 1300

  // Total across report must NEVER double-count family + SKUs
  assert.equal(report.summary.totalSkuCount, 3);
  assert.equal(report.summary.familyGroupCount, 1);
  assert.equal(report.summary.standaloneSkuCount, 1);
  assert.equal(report.summary.totalQty, 27);
  assert.equal(report.summary.totalCost, 5000 + 1300); // 6300
  assert.equal(report.summary.totalRetail, 6300 + 12 * 300); // 9900

  // Search by variant attribute / brand / family name
  const variantFiltered = buildStockValuationReport({
    entries,
    families: [family],
    brands: [brand],
    searchQuery: '500 مل',
  });
  assert.equal(variantFiltered.skuRows.length, 1);
  assert.equal(variantFiltered.skuRows[0].product.id, 'sku-milk-500ml');

  const brandFiltered = buildStockValuationReport({
    entries,
    families: [family],
    brands: [brand],
    searchQuery: 'المراعي',
  });
  assert.equal(brandFiltered.skuRows.length, 3);

  // Explicit aggregation level labels and DocumentSnapshot integration
  assert.match(getStockValuationLevelLabel('SKU'), /SKU فردي/);
  assert.match(getStockValuationLevelLabel('FAMILY'), /مشتق من SKU/);

  const docMeta = resolveEnterpriseDocumentMeta({
    profile: { nameAr: 'شركة النماري', currency: 'YER', currencySymbol: 'ر.ي' },
    branch: { id: 'branch_main', code: 'BR01', nameAr: 'الفرع الرئيسي', isMain: true, active: true, createdAt: '' },
  });
  const snap = buildReportDocumentSnapshot({
    reportKey: 'stock_valuation',
    reportTitle: 'تقرير جرد وتقييم المخزون',
    reportSubtitle: `جميع الأنشطة — مستوى التجميع: ${getStockValuationLevelLabel('FAMILY')}`,
    meta: docMeta,
    paperSize: 'A4',
    date: '2026-11-27',
    summaryRows: [
      { label: 'مستوى التجميع', value: getStockValuationLevelLabel('FAMILY') },
      { label: 'إجمالي التكلفة', value: `${report.summary.totalCost.toFixed(2)} ر.ي` },
    ],
  });
  assert.match(snap.documentSubtitle || '', /مستوى التجميع/);
  assert.equal(snap.fields.some((r) => r.label === 'مستوى التجميع'), true);
});

test('PVAR-010 Dexie Backup: exports and restores catalog, units, invoice snapshots, and product images with post-restore integrity check, and handles legacy backups cleanly', async () => {
  const admin = await resetDexieAndSeedAdmin();

  const brand = await dexieDataService.saveBrandAtomic({ nameAr: 'شركة الجودة' });
  const familyResult = await dexieDataService.createProductFamilyWithSkusAtomic({
    activityId: 'grocery',
    nameAr: 'عصير طبيعي',
    brandId: brand.id,
    optionSchema: [{ key: 'flavor', labelAr: 'النكهة', values: ['مانجو', 'تفاح'], required: true, sortOrder: 0 }],
    skus: [
      {
        product: {
          id: 'pvar10-sku-mango',
          activityId: 'grocery',
          code: 'JUICE-MNG',
          nameAr: 'عصير طبيعي - مانجو',
          category: 'عصائر',
          unit: 'حبة',
          purchasePrice: 100,
          sellPrice: 150,
          currentStock: 24,
          minStockAlert: 5,
        },
        variantAttributes: { flavor: 'مانجو' },
      },
      {
        product: {
          id: 'pvar10-sku-apple',
          activityId: 'grocery',
          code: 'JUICE-APL',
          nameAr: 'عصير طبيعي - تفاح',
          category: 'عصائر',
          unit: 'حبة',
          purchasePrice: 100,
          sellPrice: 150,
          currentStock: 12,
          minStockAlert: 5,
        },
        variantAttributes: { flavor: 'تفاح' },
      },
    ],
  });
  assert.equal(familyResult.skus.length, 2);

  const unitCarton = await dexieDataService.saveProductUnit({
    productId: 'pvar10-sku-mango',
    nameAr: 'كرتون 12 حبة',
    code: 'CTN12',
    baseUnitsNumerator: 12,
    baseUnitsDenominator: 1,
    barcode: '009988776655',
    isActive: true,
  });

  // Persist a local WebP product image in db.productImages
  const origBlob = makeWebpBlob();
  const thumbBlob = makeWebpBlob();
  const checksumSha256 = await computeSha256(origBlob);
  const imageRecord: ProductImageLocalAsset = {
    id: 'img-pvar10-1',
    tenantId: admin.tenantId || 'tenant_main',
    productId: 'pvar10-sku-mango',
    activityId: 'grocery',
    storageKey: 'tenant_main/grocery/pvar10-sku-mango/img-pvar10-1/original.webp',
    thumbnailStorageKey: 'tenant_main/grocery/pvar10-sku-mango/img-pvar10-1/thumbnail.webp',
    mimeType: 'image/webp',
    sizeBytes: origBlob.size,
    thumbnailSizeBytes: thumbBlob.size,
    width: 1,
    height: 1,
    checksumSha256,
    isPrimary: true,
    sortOrder: 0,
    createdBy: admin.id,
    createdAt: '2026-11-27T10:00:00Z',
    updatedAt: '2026-11-27T10:00:00Z',
    syncStatus: 'LOCAL_ONLY',
    isDeleted: false,
    originalBlob: origBlob,
    thumbnailBlob: thumbBlob,
  };
  await db.productImages.put(imageRecord);

  // Create a sale invoice with unit conversion snapshot
  const cashBoxes = await dexieDataService.getCashBoxes();
  await dexieDataService.createSalesInvoiceAtomic({
    invoice: {
      id: 'inv-pvar10-1',
      invoiceNumber: 'INV-PVAR10-001',
      date: '2026-11-27',
      type: 'SALE',
      activityId: 'grocery',
      branchId: 'branch_main',
      partyName: 'عميل نقدي',
      paymentMethod: 'CASH',
      cashBoxId: cashBoxes[0].id,
      subtotal: 1750,
      discount: 0,
      tax: 0,
      total: 1750,
      paidAmount: 1750,
      status: 'POSTED',
      isPosted: true,
      items: [
        {
          id: 'line-pvar10-1',
          productId: 'pvar10-sku-mango',
          productCode: 'JUICE-MNG',
          productName: 'عصير طبيعي - مانجو',
          quantity: 1,
          unit: unitCarton.nameAr,
          unitId: unitCarton.id,
          baseUnitNameSnapshot: 'حبة',
          baseQuantity: 12,
          conversionNumeratorSnapshot: 12,
          conversionDenominatorSnapshot: 1,
          unitPrice: 1750,
          discount: 0,
          total: 1750,
        },
      ],
    },
    totalCogs: 1200,
    stockDeductions: [
      {
        invoiceItemId: 'line-pvar10-1',
        productId: 'pvar10-sku-mango',
        quantity: 12,
      },
    ],
  });

  const exportedRaw = await dexieDataService.exportBackupJSON();
  const exportedParsed = JSON.parse(exportedRaw);
  assert.equal(exportedParsed.data.brands.length, 1);
  assert.equal(exportedParsed.data.productFamilies.length, 1);
  assert.equal(exportedParsed.data.productCatalogMeta.length, 2);
  assert.equal(exportedParsed.data.productUnits.length, 1);
  assert.equal(exportedParsed.data.productImages.length, 1);
  assert.equal(exportedParsed.data.mediaManifest.mediaIncluded, true);
  assert.equal(exportedParsed.data.mediaManifest.productImageCount, 1);

  // Tamper image SHA-256 and recompute payload checksum -> import must reject!
  const tamperedPayload = structuredClone(exportedParsed);
  tamperedPayload.data.productImages[0].checksumSha256 = '0'.repeat(64);
  const ser = JSON.stringify(tamperedPayload.data);
  let cs = 0;
  for (let i = 0; i < ser.length; i++) cs = (cs + ser.charCodeAt(i) * (i + 1)) % 1000000007;
  tamperedPayload.checksum = cs.toString(16);
  const tamperedRes = await dexieDataService.importBackupJSON(JSON.stringify(tamperedPayload));
  assert.equal(tamperedRes.success, false);
  assert.match(tamperedRes.error || '', /SHA-256/);

  // Wipe tables cleanly and restore valid backup
  await db.productImages.clear();
  await db.productUnits.clear();
  await db.productCatalogMeta.clear();
  await db.productFamilies.clear();
  await db.brands.clear();
  await db.invoices.clear();

  const restoreRes = await dexieDataService.importBackupJSON(exportedRaw);
  assert.equal(restoreRes.success, true, restoreRes.error);

  const mediaVerify = await dexieDataService.verifyProductImagesIntegrity();
  assert.equal(mediaVerify.valid, true);
  assert.equal(mediaVerify.checkedCount, 1);

  const restoredImg = await db.productImages.get('img-pvar10-1');
  assert.ok(restoredImg?.originalBlob instanceof Blob);
  assert.ok(restoredImg?.thumbnailBlob instanceof Blob);
  assert.equal(await computeSha256(restoredImg.originalBlob), checksumSha256);

  const restoredInv = await db.invoices.get('inv-pvar10-1');
  assert.equal(restoredInv?.items[0].baseQuantity, 12);
  assert.equal(restoredInv?.items[0].unitId, unitCarton.id);
  assert.equal(restoredInv?.stockDeductionsRecorded?.[0]?.invoiceItemId, 'line-pvar10-1');

  // Legacy backup (omits brands, productFamilies, productCatalogMeta, productUnits, productImages, mediaManifest)
  // must succeed and clear stale new-table rows cleanly
  const legacyBackup = {
    app: 'نظام الإدارة التجارية والمحاسبية المتكامل',
    systemIdentifier: 'multi_activity_erp',
    version: '2.0.0',
    exportedAt: '2026-01-01T00:00:00.000Z',
    data: {
      branches: exportedParsed.data.branches,
      accounts: exportedParsed.data.accounts,
      activities: exportedParsed.data.activities,
      products: [
        {
          id: 'legacy-p-1',
          activityId: 'grocery',
          code: 'LEG-1',
          nameAr: 'صنف قديم',
          category: 'عام',
          unit: 'حبة',
          purchasePrice: 10,
          sellPrice: 15,
          currentStock: 4,
          minStockAlert: 1,
        },
      ],
      productBatches: [],
      parties: [],
      invoices: [],
      journalEntries: [],
      cashBoxes: exportedParsed.data.cashBoxes,
      vouchers: [],
      users: exportedParsed.data.users,
    },
  };
  const legacyRes = await dexieDataService.importBackupJSON(JSON.stringify(legacyBackup));
  assert.equal(legacyRes.success, true, legacyRes.error);
  assert.equal(await db.brands.count(), 0);
  assert.equal(await db.productFamilies.count(), 0);
  assert.equal(await db.productCatalogMeta.count(), 0);
  assert.equal(await db.productUnits.count(), 0);
  assert.equal(await db.productImages.count(), 0);
  assert.equal(await db.products.count(), 1);
});
