import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOptionKeyFromLabel,
  buildOptionSchemaFromDrafts,
  buildSkuProductPayload,
  formatVariantAttributesPairs,
  generateVariantCombinations,
  groupCatalogEntriesByFamily,
  matchesCatalogEntrySearch,
  parseOptionValuesList,
  validateFamilySkuDrafts,
} from '../utils/productCatalogUi';
import type { Brand, ProductCatalogEntry, ProductFamily } from '../types/erp';

test('parseOptionValuesList splits Arabic/English commas and deduplicates case-insensitively', () => {
  const values = parseOptionValuesList('أبيض، أسود, أبيض , XL | xl');
  assert.deepEqual(values, ['أبيض', 'أسود', 'XL']);
});

test('buildOptionKeyFromLabel maps known Arabic option names and guarantees uniqueness', () => {
  const used = new Set<string>();
  assert.equal(buildOptionKeyFromLabel('اللون', 0, used), 'color');
  assert.equal(buildOptionKeyFromLabel('المقاس', 1, used), 'size');
  assert.equal(buildOptionKeyFromLabel('اللون', 2, used), 'color_2');
});

test('generateVariantCombinations produces deterministic Cartesian SKUs and preserves edited drafts', () => {
  const optionSchema = buildOptionSchemaFromDrafts([
    { tempId: '1', key: '', labelAr: 'اللون', valuesText: 'أبيض، أسود' },
    { tempId: '2', key: '', labelAr: 'المقاس', valuesText: 'M، L' },
  ]);

  const initial = generateVariantCombinations({
    familyName: 'قميص رجالي',
    activityId: 'grocery',
    optionSchema,
    defaults: {
      unit: 'حبة',
      purchasePrice: '25',
      sellPrice: '40',
      minStockAlert: '5',
      currentStock: '0',
      batchNumber: '',
      expiryDate: '',
    },
  });

  assert.equal(initial.length, 4);
  assert.equal(new Set(initial.map((d) => d.code)).size, 4);
  assert.equal(new Set(initial.map((d) => d.variantKey)).size, 4);
  assert.equal(initial[0].nameAr, 'قميص رجالي - أبيض / M');

  // Edit first draft and regenerate with an added option value
  const edited = [...initial];
  edited[0] = { ...edited[0], sellPrice: '49', barcode: '628100001' };

  const expandedSchema = buildOptionSchemaFromDrafts([
    { tempId: '1', key: 'color', labelAr: 'اللون', valuesText: 'أبيض، أسود' },
    { tempId: '2', key: 'size', labelAr: 'المقاس', valuesText: 'M، L، XL' },
  ]);

  const regenerated = generateVariantCombinations({
    familyName: 'قميص رجالي',
    activityId: 'grocery',
    optionSchema: expandedSchema,
    defaults: {
      unit: 'حبة',
      purchasePrice: '25',
      sellPrice: '40',
      minStockAlert: '5',
      currentStock: '0',
      batchNumber: '',
      expiryDate: '',
    },
    existingDrafts: edited,
  });

  assert.equal(regenerated.length, 6);
  assert.equal(regenerated[0].sellPrice, '49');
  assert.equal(regenerated[0].barcode, '628100001');

  const withExistingCodes = generateVariantCombinations({
    familyName: 'قميص جديد',
    activityId: 'grocery',
    optionSchema,
    defaults: {
      unit: 'حبة',
      purchasePrice: '20',
      sellPrice: '35',
      minStockAlert: '5',
      currentStock: '0',
      batchNumber: '',
      expiryDate: '',
    },
    existingCodes: ['FOD-0001', 'FOD-0002-V01'],
  });
  assert.equal(withExistingCodes[0].code, 'FOD-0003-V01');
});

test('generateVariantCombinations rejects oversized matrix over maxCombinations', () => {
  const optionSchema = buildOptionSchemaFromDrafts([
    { tempId: '1', key: 'color', labelAr: 'اللون', valuesText: '1,2,3,4,5,6,7,8,9,10' },
    { tempId: '2', key: 'size', labelAr: 'المقاس', valuesText: 'A,B,C,D,E,F,G' },
  ]);
  assert.throws(
    () =>
      generateVariantCombinations({
        familyName: 'اختبار',
        activityId: 'grocery',
        optionSchema,
        defaults: {
          unit: 'حبة',
          purchasePrice: '10',
          sellPrice: '15',
          minStockAlert: '5',
          currentStock: '0',
          batchNumber: '',
          expiryDate: '',
        },
        maxCombinations: 64,
      }),
    /تجاوز الحد المسموح/
  );
});

test('validateFamilySkuDrafts enforces unique codes, barcodes, and pharmacy expiry', () => {
  const optionSchema = buildOptionSchemaFromDrafts([
    { tempId: '1', key: 'size', labelAr: 'الحجم', valuesText: '100مل، 200مل' },
  ]);
  const drafts = generateVariantCombinations({
    familyName: 'شراب أطفال',
    activityId: 'pharmacy',
    optionSchema,
    defaults: {
      unit: 'علبة',
      purchasePrice: '12',
      sellPrice: '18',
      minStockAlert: '5',
      currentStock: '10',
      batchNumber: 'B-100',
      expiryDate: '2027-06-01',
    },
  });

  const valid = validateFamilySkuDrafts({
    activityId: 'pharmacy',
    drafts,
    todayDate: '2026-11-28',
  });
  assert.equal(valid.length, 2);

  // Duplicate code should throw
  assert.throws(
    () =>
      validateFamilySkuDrafts({
        activityId: 'pharmacy',
        drafts: [drafts[0], { ...drafts[1], code: drafts[0].code }],
        todayDate: '2026-11-28',
      }),
    /مكرر/
  );

  // Expired pharmacy batch should throw
  assert.throws(
    () =>
      validateFamilySkuDrafts({
        activityId: 'pharmacy',
        drafts: [drafts[0], { ...drafts[1], expiryDate: '2025-01-01' }],
        todayDate: '2026-11-28',
      }),
    /منتهي الصلاحية/
  );

  // Build product payload attaches initial batch cleanly
  const payload = buildSkuProductPayload({
    draft: drafts[0],
    activityId: 'pharmacy',
    categorySnapshot: 'أدوية أطفال',
    generateId: () => 'prod-1',
  });
  assert.equal(payload.trackExpiry, true);
  assert.equal(payload.batches?.length, 1);
  assert.equal(payload.batches?.[0].quantity, 10);
});

test('groupCatalogEntriesByFamily computes derived family stock without mutating SKU inventory', () => {
  const brand: Brand = {
    id: 'brand-1',
    tenantId: 't1',
    nameAr: 'النماري سبورت',
    normalizedName: 'النماري سبورت',
    isActive: true,
  };
  const family: ProductFamily = {
    id: 'fam-1',
    tenantId: 't1',
    activityId: 'grocery',
    nameAr: 'تيشيرت رياضي',
    categorySnapshot: 'ملابس',
    brandId: brand.id,
    optionSchema: [
      { key: 'color', labelAr: 'اللون', values: ['أبيض', 'أسود'], required: true, sortOrder: 1 },
    ],
    isActive: true,
    createdAt: '2026-11-28T00:00:00.000Z',
    updatedAt: '2026-11-28T00:00:00.000Z',
  };

  const sku1: ProductCatalogEntry = {
    product: {
      id: 'p1',
      code: 'GRC-001',
      activityId: 'grocery',
      nameAr: 'تيشيرت رياضي - أبيض',
      category: 'ملابس',
      unit: 'حبة',
      purchasePrice: 20,
      sellPrice: 35,
      currentStock: 12,
      minStockAlert: 5,
      isActive: true,
    },
    family,
    brand,
    variantAttributes: { color: 'أبيض' },
    units: [],
  };

  const sku2: ProductCatalogEntry = {
    product: {
      id: 'p2',
      code: 'GRC-002',
      activityId: 'grocery',
      nameAr: 'تيشيرت رياضي - أسود',
      category: 'ملابس',
      unit: 'حبة',
      purchasePrice: 20,
      sellPrice: 35,
      currentStock: 8,
      minStockAlert: 5,
      isActive: false,
    },
    family,
    brand,
    variantAttributes: { color: 'أسود' },
    units: [],
  };

  const standalone: ProductCatalogEntry = {
    product: {
      id: 'p3',
      code: 'GRC-003',
      activityId: 'grocery',
      nameAr: 'سكر ناعم 1 كجم',
      category: 'مواد غذائية',
      unit: 'كيلو',
      purchasePrice: 4,
      sellPrice: 6,
      currentStock: 50,
      minStockAlert: 10,
      isActive: true,
    },
    variantAttributes: {},
    units: [],
  };

  const grouped = groupCatalogEntriesByFamily([sku1, sku2, standalone], [family], [brand]);
  assert.equal(grouped.familyGroups.length, 1);
  assert.equal(grouped.familyGroups[0].derivedTotalStock, 20);
  assert.equal(grouped.familyGroups[0].activeSkuCount, 1);
  assert.equal(grouped.familyGroups[0].archivedSkuCount, 1);
  assert.equal(grouped.standaloneEntries.length, 1);

  assert.equal(matchesCatalogEntrySearch(sku1, 'النماري'), true);
  assert.equal(matchesCatalogEntrySearch(sku1, 'أبيض'), true);
  assert.equal(matchesCatalogEntrySearch(sku1, 'سكر'), false);

  const pairs = formatVariantAttributesPairs(sku1.variantAttributes, family.optionSchema);
  assert.deepEqual(pairs, [{ key: 'color', label: 'اللون', value: 'أبيض' }]);
});
