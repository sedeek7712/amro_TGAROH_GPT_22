import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/erpDatabase';

test('PVAR-004B-1 Dexie v9 stores alternate units without rewriting legacy products', async () => {
  try {
    await db.open();
    assert.equal(db.verno, 9);
    assert.ok(db.tables.some((table) => table.name === 'productUnits'));
    const product = {
      id: 'pvar-unit-product',
      activityId: 'grocery',
      code: 'PVAR-UNIT-001',
      nameAr: 'صنف اختبار',
      category: 'اختبار',
      unit: 'حبة',
      purchasePrice: 0,
      sellPrice: 0,
      currentStock: 7,
      minStockAlert: 0,
      isActive: true,
    };
    await db.products.add(product);
    await db.productUnits.add({
      id: 'pvar-unit-001',
      tenantId: 'tenant_main',
      productId: product.id,
      code: 'BOX',
      nameAr: 'كرتون',
      baseUnitsNumerator: 12,
      baseUnitsDenominator: 1,
      barcode: '0001234567890',
      normalizedBarcode: '0001234567890',
      isActive: true,
      createdAt: '2026-11-28T00:00:00.000Z',
      updatedAt: '2026-11-28T00:00:00.000Z',
    });
    assert.equal((await db.productUnits.get('pvar-unit-001'))?.barcode, '0001234567890');
    assert.deepEqual(await db.products.get(product.id), product);
    await assert.rejects(() => db.productUnits.add({
      id: 'pvar-unit-duplicate',
      tenantId: 'tenant_main',
      productId: product.id,
      code: 'BOX',
      nameAr: 'كرتون مكرر',
      baseUnitsNumerator: 24,
      baseUnitsDenominator: 1,
      isActive: true,
      createdAt: '2026-11-28T00:00:00.000Z',
      updatedAt: '2026-11-28T00:00:00.000Z',
    }));
  } finally {
    db.close();
    await db.delete();
  }
});
