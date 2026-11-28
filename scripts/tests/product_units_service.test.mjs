import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openErpDatabase } from '../../electron/sqlite/database.mjs';
import { createProductUnitsService } from '../../electron/sqlite/modules/product-units-service.mjs';
import { createInventoryPartiesService } from '../../electron/sqlite/modules/inventory-parties-service.mjs';
import { createCoreService } from '../../electron/sqlite/modules/core-service.mjs';

test('PVAR-004B-2 SQLite alternate-unit management validates, persists and disables without deleting', async () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-product-unit-service-'));
  let runtime;
  try {
    runtime = await openErpDatabase({ userDataPath });
    const database = runtime.database;
    database.prepare(
      'INSERT INTO activities (tenant_id,id,code,data_json) VALUES (?,?,?,?)'
    ).run('tenant_main', 'unit-service-activity', 'UNIT_SERVICE', JSON.stringify({ id: 'unit-service-activity' }));
    database.prepare(
      'INSERT INTO products (tenant_id,id,activity_id,code,barcode,category,current_stock_decimal,data_json) VALUES (?,?,?,?,?,?,?,?)'
    ).run('tenant_main', 'unit-service-product', 'unit-service-activity', 'UNIT-SERVICE-SKU', null, 'اختبار', '5.0000', JSON.stringify({ id: 'unit-service-product' }));

    const actor = {
      id: 'unit-service-admin',
      tenantId: 'tenant_main',
      branchId: 'branch_main',
      role: 'ADMIN',
      active: true,
      allowedActivities: [],
    };
    const service = createProductUnitsService(database);
    assert.deepEqual(service.getProductUnits(actor, 'unit-service-product'), []);

    const created = service.saveProductUnit(actor, {
      productId: 'unit-service-product',
      code: 'BOX',
      nameAr: 'كرتون',
      baseUnitsNumerator: 24,
      baseUnitsDenominator: 2,
      barcode: '0001234567890',
    });
    assert.equal(created.baseUnitsNumerator, 12);
    assert.equal(created.baseUnitsDenominator, 1);
    assert.equal(created.barcode, '0001234567890');
    assert.equal(service.getProductUnits(actor, 'unit-service-product').length, 1);

    assert.throws(() => service.saveProductUnit(actor, {
      productId: 'unit-service-product', code: 'ZERO', nameAr: 'صفر',
      baseUnitsNumerator: 0, baseUnitsDenominator: 1,
    }), /موجبين/);
    assert.throws(() => service.saveProductUnit(actor, {
      productId: 'unit-service-product', code: 'BOX', nameAr: 'مكرر',
      baseUnitsNumerator: 24, baseUnitsDenominator: 1,
    }), /مستخدم بالفعل/);
    assert.throws(() => service.saveProductUnit(actor, {
      productId: 'missing-product', code: 'MISS', nameAr: 'غير موجود',
      baseUnitsNumerator: 1, baseUnitsDenominator: 1,
    }), /غير موجود/);

    const disabled = service.saveProductUnit(actor, { ...created, isActive: false });
    assert.equal(disabled.isActive, false);
    const editedDisabled = service.saveProductUnit(actor, {
      id: disabled.id,
      productId: disabled.productId,
      code: disabled.code,
      nameAr: 'كرتون معدل',
      baseUnitsNumerator: disabled.baseUnitsNumerator,
      baseUnitsDenominator: disabled.baseUnitsDenominator,
    });
    assert.equal(editedDisabled.isActive, false, 'editing a disabled unit must not reactivate it implicitly');
    assert.equal(service.getProductUnits(actor, 'unit-service-product').length, 1);
    const inventory = createInventoryPartiesService(database, createCoreService(database));
    assert.throws(() => inventory.saveProductAtomic(actor, {
      id: 'unit-service-product',
      activityId: 'unit-service-activity',
      code: 'UNIT-SERVICE-SKU',
      nameAr: 'صنف وحدات',
      category: 'اختبار',
      unit: 'كرتون',
      purchasePrice: 0,
      sellPrice: 0,
      currentStock: 5,
      minStockAlert: 0,
      batches: [],
    }, true), /لا يمكن تغيير وحدة المخزون الأساسية/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM product_units').get().count, 1);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    runtime?.close();
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
