import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { openErpDatabase } from '../../electron/sqlite/database.mjs';

test('PVAR-004B-1 migrates SQLite v4 to v5 and enforces alternate-unit ownership and ratios', async () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-product-units-'));
  try {
    const migrationsSource = fileURLToPath(new URL('../../electron/sqlite/migrations/', import.meta.url));
    const legacyMigrationsDir = path.join(userDataPath, 'migrations-v4');
    mkdirSync(legacyMigrationsDir, { recursive: true });
    for (const filename of readdirSync(migrationsSource).filter((name) => /^00[1-4]_.*\.sql$/.test(name))) {
      copyFileSync(path.join(migrationsSource, filename), path.join(legacyMigrationsDir, filename));
    }

    const legacy = await openErpDatabase({ userDataPath, migrationsDirectory: legacyMigrationsDir });
    assert.equal(legacy.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 4);
    legacy.database.prepare(
      'INSERT INTO activities (tenant_id,id,code,data_json) VALUES (?,?,?,?)'
    ).run('tenant_main', 'units-activity', 'UNITS', JSON.stringify({ id: 'units-activity' }));
    legacy.database.prepare(
      'INSERT INTO products (tenant_id,id,activity_id,code,barcode,category,current_stock_decimal,data_json) VALUES (?,?,?,?,?,?,?,?)'
    ).run('tenant_main', 'units-product', 'units-activity', 'UNIT-SKU', null, 'اختبار', '8.5000', JSON.stringify({ id: 'units-product' }));
    legacy.close();

    const runtime = await openErpDatabase({ userDataPath });
    const database = runtime.database;
    assert.equal(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 5);
    const oldProduct = database.prepare(
      'SELECT code, current_stock_decimal FROM products WHERE tenant_id=? AND id=?'
    ).get('tenant_main', 'units-product');
    assert.deepEqual(oldProduct, { code: 'UNIT-SKU', current_stock_decimal: '8.5000' });

    const insertUnit = database.prepare(
      'INSERT INTO product_units (tenant_id,id,product_id,code,name_ar,name_en,base_units_numerator,base_units_denominator,barcode,normalized_barcode,is_active,created_at,updated_at,data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    insertUnit.run('tenant_main', 'unit-001', 'units-product', 'BOX', 'كرتون', null, 12, 1, '0012345000006', '0012345000006', 1,
      '2026-11-28T00:00:00.000Z', '2026-11-28T00:00:00.000Z', JSON.stringify({ id: 'unit-001' }));
    assert.equal(database.prepare('SELECT barcode FROM product_units WHERE id=?').get('unit-001').barcode, '0012345000006');

    assert.throws(() => insertUnit.run('tenant_main', 'unit-zero', 'units-product', 'ZERO', 'صفر', null, 0, 1, null, null, 1,
      '2026-11-28T00:00:00.000Z', '2026-11-28T00:00:00.000Z', '{}'));
    assert.throws(() => insertUnit.run('tenant_main', 'unit-missing', 'missing-product', 'MISSING', 'غير موجود', null, 1, 1, null, null, 1,
      '2026-11-28T00:00:00.000Z', '2026-11-28T00:00:00.000Z', '{}'));
    assert.throws(() => insertUnit.run('tenant_main', 'unit-duplicate', 'units-product', 'BOX', 'كرتون آخر', null, 24, 1, null, null, 1,
      '2026-11-28T00:00:00.000Z', '2026-11-28T00:00:00.000Z', '{}'));

    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM product_units').get().count, 1);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    runtime.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
