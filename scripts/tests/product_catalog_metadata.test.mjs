import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openErpDatabase } from '../../electron/sqlite/database.mjs';

test('PVAR-004A migration preserves legacy products and enforces catalog relationships', async () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-catalog-meta-'));
  try {
    const runtime = await openErpDatabase({ userDataPath });
    const database = runtime.database;

    assert.equal(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 4);
    for (const table of ['brands', 'product_families', 'product_catalog_meta']) {
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
    }

    database.prepare(
      'INSERT INTO activities (tenant_id,id,code,data_json) VALUES (?,?,?,?)'
    ).run('tenant_main', 'catalog_test_activity', 'CATALOG_TEST', JSON.stringify({ id: 'catalog_test_activity' }));

    const insertProduct = database.prepare(
      'INSERT INTO products (tenant_id,id,activity_id,code,barcode,category,current_stock_decimal,data_json) VALUES (?,?,?,?,?,?,?,?)'
    );
    insertProduct.run('tenant_main', 'catalog-sku-a', 'catalog_test_activity', 'CAT-A', 'CAT-BAR-A', 'ملابس', '12.5000', JSON.stringify({ id: 'catalog-sku-a' }));
    insertProduct.run('tenant_main', 'catalog-sku-b', 'catalog_test_activity', 'CAT-B', 'CAT-BAR-B', 'ملابس', '7.2500', JSON.stringify({ id: 'catalog-sku-b' }));

    database.prepare(
      'INSERT INTO brands (tenant_id,id,name_ar,normalized_name,is_active,data_json) VALUES (?,?,?,?,?,?)'
    ).run('tenant_main', 'brand-test', 'علامة الاختبار', 'علامة الاختبار', 1, JSON.stringify({ id: 'brand-test' }));

    database.prepare(
      'INSERT INTO product_families (tenant_id,id,activity_id,name_ar,category_snapshot,brand_id,option_schema_json,is_active,created_at,updated_at,data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      'tenant_main', 'family-test', 'catalog_test_activity', 'قميص اختبار', 'ملابس', 'brand-test',
      JSON.stringify([{ key: 'size', labelAr: 'المقاس', values: ['M', 'L'], required: true, sortOrder: 1 }]),
      1, '2026-11-28T00:00:00.000Z', '2026-11-28T00:00:00.000Z', JSON.stringify({ id: 'family-test' })
    );

    database.prepare(
      'INSERT INTO product_catalog_meta (tenant_id,product_id,family_id,brand_id,variant_key,variant_attributes_json,data_json) VALUES (?,?,?,?,?,?,?)'
    ).run('tenant_main', 'catalog-sku-a', 'family-test', null, 'size=m', JSON.stringify({ size: 'M' }), JSON.stringify({ productId: 'catalog-sku-a' }));

    database.prepare(
      'INSERT INTO product_catalog_meta (tenant_id,product_id,family_id,brand_id,variant_key,variant_attributes_json,data_json) VALUES (?,?,?,?,?,?,?)'
    ).run('tenant_main', 'catalog-sku-b', null, 'brand-test', null, '{}', JSON.stringify({ productId: 'catalog-sku-b' }));

    assert.throws(() => database.prepare(
      'INSERT INTO product_catalog_meta (tenant_id,product_id,family_id,brand_id,variant_key,variant_attributes_json,data_json) VALUES (?,?,?,?,?,?,?)'
    ).run('tenant_main', 'catalog-sku-b', 'family-test', null, 'size=m', JSON.stringify({ size: 'M' }), '{}'));

    assert.throws(() => database.prepare(
      'INSERT INTO brands (tenant_id,id,name_ar,normalized_name,is_active,data_json) VALUES (?,?,?,?,?,?)'
    ).run('tenant_main', 'brand-duplicate', 'علامة أخرى', 'علامة الاختبار', 1, '{}'));

    const legacyProduct = database.prepare(
      'SELECT current_stock_decimal, code FROM products WHERE tenant_id=? AND id=?'
    ).get('tenant_main', 'catalog-sku-a');
    assert.equal(legacyProduct.current_stock_decimal, '12.5000');
    assert.equal(legacyProduct.code, 'CAT-A');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM product_catalog_meta').get().count, 2);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(database.prepare('PRAGMA integrity_check').all(), [{ integrity_check: 'ok' }]);

    runtime.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
