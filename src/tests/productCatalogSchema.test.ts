import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/erpDatabase';

test('PVAR-004A Dexie v8 exposes isolated catalog metadata stores without changing Product rows', async () => {
  try {
    await db.open();
    assert.equal(db.verno, 8);
    assert.ok(db.tables.some((table) => table.name === 'brands'));
    assert.ok(db.tables.some((table) => table.name === 'productFamilies'));
    assert.ok(db.tables.some((table) => table.name === 'productCatalogMeta'));

    await db.brands.add({
      id: 'brand-dexie',
      tenantId: 'tenant_main',
      nameAr: 'علامة تجريبية',
      normalizedName: 'علامة تجريبية',
      isActive: true,
    });
    await db.productFamilies.add({
      id: 'family-dexie',
      tenantId: 'tenant_main',
      activityId: 'grocery',
      nameAr: 'منتج متغير',
      categorySnapshot: 'اختبار',
      brandId: 'brand-dexie',
      optionSchema: [{ key: 'size', labelAr: 'المقاس', values: ['M', 'L'], required: true, sortOrder: 1 }],
      isActive: true,
      createdAt: '2026-11-28T00:00:00.000Z',
      updatedAt: '2026-11-28T00:00:00.000Z',
    });
    await db.productCatalogMeta.add({
      tenantId: 'tenant_main',
      productId: 'sku-dexie',
      familyId: 'family-dexie',
      variantKey: 'size=m',
      variantAttributes: { size: 'M' },
    });

    assert.equal((await db.productCatalogMeta.get(['tenant_main', 'sku-dexie']))?.familyId, 'family-dexie');
    assert.equal(await db.productFamilies.count(), 1);
    assert.equal(await db.brands.count(), 1);
  } finally {
    db.close();
    await db.delete();
  }
});
