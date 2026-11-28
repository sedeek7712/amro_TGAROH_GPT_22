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
import { inventory } from '../services/inventoryService';
import { productMediaService } from '../services/productMediaService';
import { storage } from '../services/storageService';
import { formatLocalDate } from '../utils/localDate';
import {
  buildOptionSchemaFromDrafts,
  buildSkuProductPayload,
  generateVariantCombinations,
  getBatchExpiryStatus,
  getFamilyFallbackProductIds,
  matchesCatalogEntrySearch,
  sanitizeSpecializedFieldsForActivity,
  sortBatchesFefo,
  validateFamilySkuDrafts,
} from '../utils/productCatalogUi';
import type { ProductCatalogEntry } from '../types/erp';

const WEBP_HEADER_BASE64 = Buffer.from([
  0x52, 0x49, 0x46, 0x46, // RIFF
  0x08, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, // WEBP
  0x56, 0x50, 0x38, 0x20,
]).toString('base64');
const VALID_WEBP_DATA_URL = `data:image/webp;base64,${WEBP_HEADER_BASE64}`;

function offsetDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return formatLocalDate(d);
}

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
  await db.productImages.clear();
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
    id: 'usr-pvar009-admin',
    username: 'pvar009_admin',
    fullName: 'PVAR-009 Admin',
    role: 'ADMIN' as const,
    allowedActivities: ['pharmacy', 'grocery', 'bike_parts', 'equipment_parts'] as const,
    branchId: 'branch_main',
    allowedBranches: ['branch_main'],
    tenantId: 'tenant_main',
    active: true,
    passwordHash: await hashPassword('Pvar009-Admin#2026'),
  };
  await db.users.put({ ...admin, allowedActivities: [...admin.allowedActivities] });
  const login = await authService.authenticate({
    username: admin.username,
    password: 'Pvar009-Admin#2026',
    users: [{ ...admin, allowedActivities: [...admin.allowedActivities] }],
    onUserUpdated: async (updated) => {
      await db.users.put(updated);
    },
  });
  assert.equal(login.success, true);
});

after(async () => {
  authService.logout();
  await db.close();
});

test('PVAR-009 pure logic: sanitizeSpecializedFieldsForActivity isolates fields per activity with zero leakage', () => {
  const polluted = {
    trackExpiry: true,
    scientificName: '  Amoxicillin  ',
    dosageForm: '  كبسولات ',
    oemNumber: ' 14100-KCW-000 ',
    manufacturer: ' Honda ',
    compatibleModels: ' CG150 ',
    equipmentType: ' مولد كهرباء ',
    serialNumber: ' SN-99 ',
  };

  const pharm = sanitizeSpecializedFieldsForActivity('pharmacy', polluted);
  assert.equal(pharm.trackExpiry, true);
  assert.equal(pharm.scientificName, 'Amoxicillin');
  assert.equal(pharm.dosageForm, 'كبسولات');
  assert.equal(pharm.oemNumber, undefined);
  assert.equal(pharm.manufacturer, undefined);
  assert.equal(pharm.compatibleModels, undefined);
  assert.equal(pharm.equipmentType, undefined);
  assert.equal(pharm.serialNumber, undefined);

  const grocDry = sanitizeSpecializedFieldsForActivity('grocery', { ...polluted, trackExpiry: false });
  assert.equal(grocDry.trackExpiry, false);
  assert.equal(grocDry.scientificName, undefined);
  assert.equal(grocDry.dosageForm, undefined);
  assert.equal(grocDry.oemNumber, undefined);
  assert.equal(grocDry.equipmentType, undefined);

  const bike = sanitizeSpecializedFieldsForActivity('bike_parts', polluted);
  assert.equal(bike.trackExpiry, false);
  assert.equal(bike.oemNumber, '14100-KCW-000');
  assert.equal(bike.manufacturer, 'Honda');
  assert.equal(bike.compatibleModels, 'CG150');
  assert.equal(bike.scientificName, undefined);
  assert.equal(bike.equipmentType, undefined);
  assert.equal(bike.serialNumber, undefined);

  const equip = sanitizeSpecializedFieldsForActivity('equipment_parts', polluted);
  assert.equal(equip.trackExpiry, false);
  assert.equal(equip.oemNumber, '14100-KCW-000');
  assert.equal(equip.manufacturer, 'Honda');
  assert.equal(equip.compatibleModels, 'CG150');
  assert.equal(equip.equipmentType, 'مولد كهرباء');
  assert.equal(equip.serialNumber, 'SN-99');
  assert.equal(equip.scientificName, undefined);
  assert.equal(equip.dosageForm, undefined);
});

test('PVAR-009 pure logic: date-safe FEFO sorting, expiry status, and timezone-neutral isBatchExpired', () => {
  const today = formatLocalDate();
  const yesterday = offsetDays(-1);
  const in20Days = offsetDays(20);
  const in120Days = offsetDays(120);

  // Today must NOT be treated as expired regardless of local timezone offset
  assert.equal(inventory.isBatchExpired(today, today), false);
  assert.equal(inventory.isBatchExpired(yesterday, today), true);

  assert.equal(getBatchExpiryStatus(yesterday, today).status, 'EXPIRED');
  assert.equal(getBatchExpiryStatus(today, today).status, 'EXPIRING_SOON');
  assert.equal(getBatchExpiryStatus(in20Days, today).status, 'EXPIRING_SOON');
  assert.equal(getBatchExpiryStatus(in120Days, today).status, 'VALID');

  const sorted = sortBatchesFefo([
    { batchNumber: 'B-LATE', expiryDate: in120Days },
    { batchNumber: 'B-EXP', expiryDate: yesterday },
    { batchNumber: 'B-SOON', expiryDate: in20Days },
  ]);
  assert.deepEqual(
    sorted.map((b) => b.batchNumber),
    ['B-EXP', 'B-SOON', 'B-LATE']
  );

  storage.saveProducts([
    {
      id: 'p-exp',
      code: 'MED-1',
      activityId: 'pharmacy',
      nameAr: 'دواء',
      category: 'أدوية',
      unit: 'علبة',
      purchasePrice: 5,
      sellPrice: 10,
      currentStock: 8,
      minStockAlert: 2,
      batches: [
        { id: 'b1', productId: 'p-exp', batchNumber: 'B-SOON', expiryDate: in20Days, quantity: 3, costPrice: 5 },
        { id: 'b2', productId: 'p-exp', batchNumber: 'B-LATE', expiryDate: in120Days, quantity: 5, costPrice: 5 },
      ],
    },
  ]);
  const expiringSoon = inventory.getExpiringSoonBatches(60, today);
  assert.equal(expiringSoon.length, 1);
  assert.equal(expiringSoon[0].batch.batchNumber, 'B-SOON');
});

test('PVAR-009 pure logic: family SKU builder attaches batches strictly to SKU, handles grocery optionality, and searches specialized fields', () => {
  const schema = buildOptionSchemaFromDrafts([
    { tempId: '1', key: 'size', labelAr: 'العبوة', valuesText: '100مل، 200مل' },
  ]);

  // Dry grocery without batch/expiry succeeds
  const dryDrafts = generateVariantCombinations({
    familyName: 'أرز بسمتي',
    activityId: 'grocery',
    optionSchema: schema,
    defaults: {
      unit: 'كيلو',
      purchasePrice: '8',
      sellPrice: '12',
      minStockAlert: '5',
      currentStock: '10',
      batchNumber: '',
      expiryDate: '',
    },
  });
  const validatedDry = validateFamilySkuDrafts({
    activityId: 'grocery',
    drafts: dryDrafts,
    todayDate: '2026-11-28',
    trackExpiry: false,
  });
  assert.equal(validatedDry.length, 2);

  // Partial grocery batch without expiry fails
  assert.throws(
    () =>
      validateFamilySkuDrafts({
        activityId: 'grocery',
        drafts: [{ ...dryDrafts[0], batchNumber: 'LOT-1', expiryDate: '' }, dryDrafts[1]],
        todayDate: '2026-11-28',
        trackExpiry: true,
      }),
    /رقم التشغيلة وتاريخ الصلاحية معاً/
  );

  // Pharmacy payload scopes specialized fields and attaches batch strictly to SKU id
  const pharmDrafts = generateVariantCombinations({
    familyName: 'أموكسيسيلين',
    activityId: 'pharmacy',
    optionSchema: schema,
    defaults: {
      unit: 'علبة',
      purchasePrice: '10',
      sellPrice: '15',
      minStockAlert: '3',
      currentStock: '6',
      batchNumber: 'PH-101',
      expiryDate: '2027-08-01',
    },
  });
  let seq = 0;
  const skuPayload = buildSkuProductPayload({
    draft: pharmDrafts[0],
    activityId: 'pharmacy',
    categorySnapshot: 'مضادات حيوية',
    generateId: () => `sku-gen-${++seq}`,
    specializedDefaults: {
      scientificName: 'Amoxicillin',
      dosageForm: 'شراب',
      oemNumber: 'SHOULD_BE_STRIPPED',
    },
  });
  assert.equal(skuPayload.id, 'sku-gen-1');
  assert.equal(skuPayload.scientificName, 'Amoxicillin');
  assert.equal(skuPayload.dosageForm, 'شراب');
  assert.equal(skuPayload.oemNumber, undefined);
  assert.equal(skuPayload.batches?.[0]?.productId, 'sku-gen-1');

  const equipEntry: ProductCatalogEntry = {
    product: {
      id: 'eq-1',
      code: 'EQP-1',
      activityId: 'equipment_parts',
      nameAr: 'فلتر ديزل',
      category: 'فلاتر',
      unit: 'حبة',
      purchasePrice: 30,
      sellPrice: 45,
      currentStock: 4,
      minStockAlert: 1,
      oemNumber: 'CAT-1R0750',
      manufacturer: 'Caterpillar',
      compatibleModels: 'D8R / 330D',
      equipmentType: 'حفارات',
      serialNumber: 'SN-8801',
    },
    variantAttributes: {},
    units: [],
  };
  assert.equal(matchesCatalogEntrySearch(equipEntry, 'Caterpillar'), true);
  assert.equal(matchesCatalogEntrySearch(equipEntry, 'حفارات'), true);
  assert.equal(matchesCatalogEntrySearch(equipEntry, 'SN-8801'), true);

  const fallbackIds = getFamilyFallbackProductIds([
    { ...equipEntry, product: { ...equipEntry.product, id: 'sku-arch', isActive: false, currentStock: 5 } },
    { ...equipEntry, product: { ...equipEntry.product, id: 'sku-zero', isActive: true, currentStock: 0 } },
    { ...equipEntry, product: { ...equipEntry.product, id: 'sku-stock', isActive: true, currentStock: 4 } },
  ]);
  assert.deepEqual(fallbackIds, ['sku-stock', 'sku-zero', 'sku-arch']);
});

test('PVAR-009 Dexie E2E: specialized fields, per-SKU FEFO batches, expired blocking, and isolated SKU images', async () => {
  const futureSoon = offsetDays(40);
  const futureLater = offsetDays(180);
  const expiredDate = offsetDays(-5);

  // 1. Save specialized products for all 4 activities without cross-activity leakage
  const savedEquip = await dexieDataService.saveProductAtomic(
    {
      id: 'dex-eqp-1',
      code: 'EQP-009-1',
      activityId: 'equipment_parts',
      nameAr: 'طرمبة ديزل ثقيلة',
      category: 'معدات',
      unit: 'حبة',
      purchasePrice: 200,
      sellPrice: 280,
      currentStock: 3,
      minStockAlert: 1,
      oemNumber: '320-0677',
      manufacturer: 'Perkins',
      compatibleModels: '1104D',
      equipmentType: 'مولد كهربائي',
      serialNumber: 'PRK-771',
    },
    false
  );
  assert.equal(savedEquip.equipmentType, 'مولد كهربائي');
  assert.equal(savedEquip.serialNumber, 'PRK-771');

  const savedBike = await dexieDataService.saveProductAtomic(
    {
      id: 'dex-bike-1',
      code: 'MBK-009-1',
      activityId: 'bike_parts',
      nameAr: 'طقم كلتش دراجة',
      category: 'دراجات',
      unit: 'طقم',
      purchasePrice: 40,
      sellPrice: 65,
      currentStock: 5,
      minStockAlert: 1,
      oemNumber: '22201-KYA-601',
      manufacturer: 'Honda',
      compatibleModels: 'CB150',
    },
    false
  );
  assert.equal(savedBike.oemNumber, '22201-KYA-601');
  assert.equal(savedBike.equipmentType, undefined);

  // Dry grocery without expiry works cleanly
  const dryGrocery = await dexieDataService.saveProductAtomic(
    {
      id: 'dex-groc-dry',
      code: 'FOD-009-1',
      activityId: 'grocery',
      nameAr: 'شاي أحمر 400 جم',
      category: 'مشروبات',
      unit: 'علبة',
      purchasePrice: 10,
      sellPrice: 14,
      currentStock: 10,
      minStockAlert: 2,
      trackExpiry: false,
    },
    false
  );
  assert.equal(dryGrocery.trackExpiry, false);

  // 2. Pharmacy family with 2 SKUs — batches stay strictly per-SKU
  const famResult = await dexieDataService.createProductFamilyWithSkusAtomic({
    activityId: 'pharmacy',
    nameAr: 'شراب بانادول للأطفال',
    categorySnapshot: 'مسكنات',
    optionSchema: [{ key: 'size', labelAr: 'الحجم', values: ['60مل', '120مل'], required: true, sortOrder: 1 }],
    skus: [
      {
        product: {
          id: 'dex-pharm-sku-1',
          code: 'MED-009-V01',
          activityId: 'pharmacy',
          nameAr: 'شراب بانادول - 60مل',
          category: 'مسكنات',
          unit: 'علبة',
          purchasePrice: 10,
          sellPrice: 15,
          currentStock: 5,
          minStockAlert: 2,
          scientificName: 'Paracetamol',
          dosageForm: 'شراب',
          trackExpiry: true,
          batches: [
            {
              id: 'dex-b-soon',
              productId: 'dex-pharm-sku-1',
              batchNumber: 'B-SOON',
              expiryDate: futureSoon,
              quantity: 2,
              costPrice: 10,
            },
            {
              id: 'dex-b-later',
              productId: 'dex-pharm-sku-1',
              batchNumber: 'B-LATER',
              expiryDate: futureLater,
              quantity: 3,
              costPrice: 10,
            },
          ],
        },
        variantAttributes: { size: '60مل' },
      },
      {
        product: {
          id: 'dex-pharm-sku-2',
          code: 'MED-009-V02',
          activityId: 'pharmacy',
          nameAr: 'شراب بانادول - 120مل',
          category: 'مسكنات',
          unit: 'علبة',
          purchasePrice: 16,
          sellPrice: 24,
          currentStock: 4,
          minStockAlert: 2,
          scientificName: 'Paracetamol',
          dosageForm: 'شراب',
          trackExpiry: true,
          batches: [
            {
              id: 'dex-b-sku2-exp',
              productId: 'dex-pharm-sku-2',
              batchNumber: 'B-EXP-ONLY',
              expiryDate: expiredDate,
              quantity: 4,
              costPrice: 16,
            },
          ],
        },
        variantAttributes: { size: '120مل' },
      },
    ],
  });
  assert.equal(famResult.skus.length, 2);

  // Verify batches belong only to their respective SKUs
  const sku1Saved = await db.products.get('dex-pharm-sku-1');
  const sku2Saved = await db.products.get('dex-pharm-sku-2');
  assert.equal(sku1Saved?.batches?.length, 2);
  assert.equal(sku1Saved?.dosageForm, 'شراب');
  assert.equal(sku2Saved?.batches?.length, 1);

  const cashBox = (await db.cashBoxes.toArray())[0];
  assert.ok(cashBox);

  // 3. Auto FEFO sale on SKU-1 deducts B-SOON (2) first, then B-LATER (1), leaving SKU-2 untouched
  await dexieDataService.createSalesInvoiceAtomic({
    invoice: {
      id: 'inv-fefo-1',
      invoiceNumber: '',
      type: 'SALE',
      activityId: 'pharmacy',
      branchId: 'branch_main',
      partyName: 'عميل نقدي',
      date: formatLocalDate(),
      items: [
        {
          id: 'line-fefo-1',
          productId: 'dex-pharm-sku-1',
          productName: 'شراب بانادول - 60مل',
          productCode: 'MED-009-V01',
          unit: 'علبة',
          quantity: 3,
          unitPrice: 15,
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
      cashBoxId: cashBox.id,
    },
    totalCogs: 30,
    stockDeductions: [{ invoiceItemId: 'line-fefo-1', productId: 'dex-pharm-sku-1', quantity: 3 }],
  });

  const sku1After = await db.products.get('dex-pharm-sku-1');
  const soonAfter = sku1After?.batches?.find((b) => b.batchNumber === 'B-SOON');
  const laterAfter = sku1After?.batches?.find((b) => b.batchNumber === 'B-LATER');
  assert.equal(soonAfter?.quantity, 0);
  assert.equal(laterAfter?.quantity, 2);
  assert.equal(sku1After?.currentStock, 2);

  // SKU-2 remained completely isolated
  const sku2After = await db.products.get('dex-pharm-sku-2');
  assert.equal(sku2After?.currentStock, 4);

  // 4. Selling SKU-2 (whose only batch is expired) MUST be blocked
  await assert.rejects(
    () =>
      dexieDataService.createSalesInvoiceAtomic({
        invoice: {
          id: 'inv-exp-block',
          invoiceNumber: '',
          type: 'SALE',
          activityId: 'pharmacy',
          branchId: 'branch_main',
          partyName: 'عميل نقدي',
          date: formatLocalDate(),
          items: [
            {
              id: 'line-exp-block',
              productId: 'dex-pharm-sku-2',
              productName: 'شراب بانادول - 120مل',
              productCode: 'MED-009-V02',
              unit: 'علبة',
              quantity: 1,
              unitPrice: 24,
              discount: 0,
              total: 24,
            },
          ],
          subtotal: 24,
          discount: 0,
          tax: 0,
          total: 24,
          paidAmount: 24,
          paymentMethod: 'CASH',
          cashBoxId: cashBox.id,
        },
        totalCogs: 16,
        stockDeductions: [{ invoiceItemId: 'line-exp-block', productId: 'dex-pharm-sku-2', quantity: 1 }],
      }),
    /منتهي|صلاحية/
  );

  // 5. Image attachment attaches ONLY to SKU-1 and does not duplicate binaries to SKU-2
  const img = await productMediaService.addProductImage({
    productId: 'dex-pharm-sku-1',
    originalDataUrl: VALID_WEBP_DATA_URL,
    thumbnailDataUrl: VALID_WEBP_DATA_URL,
    mimeType: 'image/webp',
    width: 64,
    height: 64,
  });
  assert.equal(img.productId, 'dex-pharm-sku-1');
  assert.equal((await productMediaService.getProductImages('dex-pharm-sku-1')).length, 1);
  assert.equal((await productMediaService.getProductImages('dex-pharm-sku-2')).length, 0);
});
