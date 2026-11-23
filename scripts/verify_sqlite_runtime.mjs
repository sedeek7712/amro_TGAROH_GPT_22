import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteBackup, openErpDatabase } from '../electron/sqlite/database.mjs';

const MIGRATIONS_DIR = path.resolve('electron/sqlite/migrations');
const expectedMigrationVersions = readdirSync(MIGRATIONS_DIR)
  .map((name) => name.match(/^(\d{3,})_([a-z0-9_]+)\.sql$/i))
  .filter(Boolean)
  .map((m) => Number(m[1]))
  .sort((a, b) => a - b);

const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-sqlite-runtime-'));

try {
  const firstOpen = await openErpDatabase({ userDataPath });
  assert.ok(expectedMigrationVersions.length >= 2, 'Expected at least 2 SQLite migrations');
  assert.deepEqual(firstOpen.appliedMigrations, expectedMigrationVersions);
  assert.equal(path.basename(firstOpen.databasePath), 'erp.sqlite');
  assert.equal(path.basename(path.dirname(firstOpen.databasePath)), 'Database');

  const db = firstOpen.database;
  const recordedVersions = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((r) => r.version);
  assert.deepEqual(recordedVersions, expectedMigrationVersions);

  for (const v2Table of ['payment_allocations', 'party_advance_transactions', 'allocation_audits']) {
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(v2Table);
    assert.ok(exists, `Expected v2 table to exist after migrations: ${v2Table}`);
  }

  db.prepare('INSERT INTO activities (tenant_id,id,code,data_json) VALUES (?,?,?,?)')
    .run('tenant_main', 'pharmacy', 'PH', '{"id":"pharmacy"}');

  db.prepare(
    'INSERT INTO products (tenant_id,id,activity_id,code,category,current_stock_decimal,data_json) VALUES (?,?,?,?,?,?,?)'
  ).run('tenant_main', 'product-1', 'pharmacy', 'P-001', 'general', '10',
        '{"id":"product-1","currentStock":10}');

  db.prepare(
    'INSERT INTO invoices (tenant_id,id,branch_id,invoice_number,invoice_type,activity_id,invoice_date,payment_method,total_decimal,paid_amount_decimal,data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run('tenant_main', 'invoice-1', 'branch_main', 'INV-001', 'SALE', 'pharmacy',
        '2026-11-20', 'CASH', '125.50', '125.50', '{"id":"invoice-1","total":125.5}');

  db.prepare(
    'INSERT INTO invoice_items (tenant_id,invoice_id,id,product_id,quantity_decimal,unit_price_decimal,total_decimal,data_json) VALUES (?,?,?,?,?,?,?,?)'
  ).run('tenant_main', 'invoice-1', 'line-1', 'product-1', '1', '125.50', '125.50',
        '{"id":"line-1","productId":"product-1"}');

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      "INSERT INTO invoices (tenant_id,id,branch_id,invoice_number,invoice_type,activity_id,invoice_date,payment_method,total_decimal,paid_amount_decimal,data_json) VALUES ('tenant_main','rollback-id','branch_main','ROLLBACK','SALE','pharmacy','2026-11-20','CASH','1','1','{}')"
    ).run();
    db.prepare(
      "INSERT INTO invoice_items (tenant_id,invoice_id,id,product_id,quantity_decimal,unit_price_decimal,total_decimal,data_json) VALUES ('tenant_main','rollback-id','rollback-line','product-1','1','1','1','{}')"
    ).run();
    db.exec('ROLLBACK');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM invoices WHERE id='rollback-id'").get().count, 0);

  const backupPath = await createSqliteBackup(db, firstOpen.backupDirectory, { prefix: 'runtime-test' });
  assert.ok(backupPath.endsWith('.sqlite'));
  firstOpen.close();

  const secondOpen = await openErpDatabase({ userDataPath });
  assert.deepEqual(secondOpen.appliedMigrations, []);
  assert.equal(
    secondOpen.database.prepare("SELECT total_decimal FROM invoices WHERE id='invoice-1'").get().total_decimal,
    '125.50'
  );
  secondOpen.close();

  const backupDb = new DatabaseSync(backupPath, { readOnly: true, timeout: 5000 });
  assert.equal(
    backupDb.prepare("SELECT COUNT(*) AS count FROM invoice_items WHERE invoice_id='invoice-1'").get().count,
    1
  );
  assert.equal(backupDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  backupDb.close();

  console.log('PASS: SQLite engine, checksum migrations, rollback, restart persistence and online backup');
} finally {
  rmSync(userDataPath, { recursive: true, force: true });
}
