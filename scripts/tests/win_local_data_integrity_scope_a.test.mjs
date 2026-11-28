import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openErpDatabase } from '../../electron/sqlite/database.mjs';
import { createDesktopBackend } from '../../electron/sqlite/desktop-backend.mjs';
import { DesktopAuthenticationService } from '../../electron/security/authentication.mjs';

function setupCleanBackend() {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-wo-scope-a-'));
  return { userDataPath };
}

async function createAuthedBackend(userDataPath) {
  const runtime = await openErpDatabase({ userDataPath });
  const auth = new DesktopAuthenticationService(runtime.database);
  const setup = auth.createInitialAdmin({
    username: 'admin',
    fullName: 'المدير العام',
    password: 'AdminStrong#2026',
  });
  assert.equal(setup.success, true);
  const backend = createDesktopBackend({
    database: runtime.database,
    backupDirectory: runtime.backupDirectory,
    authenticationService: auth,
  });
  const login = auth.authenticate({ username: 'admin', password: 'AdminStrong#2026' });
  assert.equal(login.success, true);
  return { runtime, auth, backend, token: login.token };
}

test('WO-SCOPE-A-01: Sequential, concurrent, deleted-highest-code, cross-activity, and tenant isolation on SQLite product codes', async () => {
  const { userDataPath } = setupCleanBackend();
  try {
    const { runtime, auth, backend, token } = await createAuthedBackend(userDataPath);

    // 1. Sequential standalone products per activity preserve official prefixes
    const p1 = backend.saveProductAtomic({
      token,
      product: {
        id: 'p-med-1',
        activityId: 'pharmacy',
        code: '',
        autoGenerateCode: true,
        nameAr: 'دواء 1',
        category: 'أدوية',
        unit: 'علبة',
        purchasePrice: 10,
        sellPrice: 15,
        currentStock: 0,
        minStockAlert: 2,
      },
    });
    const p2 = backend.saveProductAtomic({
      token,
      product: {
        id: 'p-med-2',
        activityId: 'pharmacy',
        code: '',
        autoGenerateCode: true,
        nameAr: 'دواء 2',
        category: 'أدوية',
        unit: 'علبة',
        purchasePrice: 10,
        sellPrice: 15,
        currentStock: 0,
        minStockAlert: 2,
      },
    });
    const pGroc = backend.saveProductAtomic({
      token,
      product: {
        id: 'p-fod-1',
        activityId: 'grocery',
        code: '',
        autoGenerateCode: true,
        nameAr: 'غذاء 1',
        category: 'بقالة',
        unit: 'حبة',
        purchasePrice: 5,
        sellPrice: 8,
        currentStock: 0,
        minStockAlert: 2,
      },
    });
    const pBike = backend.saveProductAtomic({
      token,
      product: {
        id: 'p-mbk-1',
        activityId: 'bike_parts',
        code: '',
        autoGenerateCode: true,
        nameAr: 'قطعة دراجة 1',
        category: 'دراجات',
        unit: 'حبة',
        purchasePrice: 20,
        sellPrice: 30,
        currentStock: 0,
        minStockAlert: 1,
      },
    });
    const pEquip = backend.saveProductAtomic({
      token,
      product: {
        id: 'p-eqp-1',
        activityId: 'equipment_parts',
        code: '',
        autoGenerateCode: true,
        nameAr: 'قطعة معدة 1',
        category: 'معدات',
        unit: 'حبة',
        purchasePrice: 50,
        sellPrice: 75,
        currentStock: 0,
        minStockAlert: 1,
      },
    });

    assert.equal(p1.code, 'MED-0001');
    assert.equal(p2.code, 'MED-0002');
    assert.equal(pGroc.code, 'FOD-0001');
    assert.equal(pBike.code, 'MBK-0001');
    assert.equal(pEquip.code, 'EQP-0001');
    assert.equal(p1.autoGenerateCode, undefined);

    // 2. Concurrent-style microtask creations on SQLite never collide
    const [c1, c2] = await Promise.all([
      Promise.resolve().then(() =>
        backend.saveProductAtomic({
          token,
          product: {
            id: 'p-med-conc-1',
            activityId: 'pharmacy',
            code: '',
            autoGenerateCode: true,
            nameAr: 'دواء متزامن أ',
            category: 'أدوية',
            unit: 'علبة',
            purchasePrice: 12,
            sellPrice: 18,
            currentStock: 0,
            minStockAlert: 2,
          },
        })
      ),
      Promise.resolve().then(() =>
        backend.saveProductAtomic({
          token,
          product: {
            id: 'p-med-conc-2',
            activityId: 'pharmacy',
            code: '',
            autoGenerateCode: true,
            nameAr: 'دواء متزامن ب',
            category: 'أدوية',
            unit: 'علبة',
            purchasePrice: 12,
            sellPrice: 18,
            currentStock: 0,
            minStockAlert: 2,
          },
        })
      ),
    ]);
    assert.notEqual(c1.code, c2.code);
    assert.deepEqual([c1.code, c2.code].sort(), ['MED-0003', 'MED-0004']);

    // 3. Delete highest allocated product -> MED-0004 must NOT be reused
    backend.deleteProductAtomic({ token, productId: c2.id });
    const afterDelete = backend.saveProductAtomic({
      token,
      product: {
        id: 'p-med-after-del',
        activityId: 'pharmacy',
        code: '',
        autoGenerateCode: true,
        nameAr: 'دواء بعد الحذف',
        category: 'أدوية',
        unit: 'علبة',
        purchasePrice: 12,
        sellPrice: 18,
        currentStock: 0,
        minStockAlert: 2,
      },
    });
    assert.equal(afterDelete.code, 'MED-0005');

    // 4. Clean books reset preserves product sequence monotonicity
    backend.resetToCleanBooks({ token });
    const afterCleanBooks = backend.saveProductAtomic({
      token,
      product: {
        id: 'p-med-after-clean',
        activityId: 'pharmacy',
        code: '',
        autoGenerateCode: true,
        nameAr: 'دواء بعد تصفير الدفاتر',
        category: 'أدوية',
        unit: 'علبة',
        purchasePrice: 12,
        sellPrice: 18,
        currentStock: 0,
        minStockAlert: 2,
      },
    });
    assert.equal(afterCleanBooks.code, 'MED-0006');

    // 5. ProductFamily + SKU variants with autoGenerateCode allocate cleanly & never collide with standalone
    const famResult = backend.createProductFamilyWithSkusAtomic({
      token,
      input: {
        id: 'fam-med-1',
        activityId: 'pharmacy',
        nameAr: 'شراب فيتامين',
        categorySnapshot: 'أدوية',
        optionSchema: [
          { key: 'size', labelAr: 'الحجم', values: ['100مل', '200مل'], required: true, sortOrder: 1 },
        ],
        skus: [
          {
            product: {
              id: 'sku-med-1',
              activityId: 'pharmacy',
              code: '',
              autoGenerateCode: true,
              nameAr: 'شراب فيتامين - 100مل',
              category: 'أدوية',
              unit: 'علبة',
              purchasePrice: 15,
              sellPrice: 22,
              currentStock: 0,
              minStockAlert: 2,
              trackExpiry: true,
            },
            variantAttributes: { size: '100مل' },
          },
          {
            product: {
              id: 'sku-med-2',
              activityId: 'pharmacy',
              code: '',
              autoGenerateCode: true,
              nameAr: 'شراب فيتامين - 200مل',
              category: 'أدوية',
              unit: 'علبة',
              purchasePrice: 20,
              sellPrice: 30,
              currentStock: 0,
              minStockAlert: 2,
              trackExpiry: true,
            },
            variantAttributes: { size: '200مل' },
          },
        ],
      },
    });
    assert.equal(famResult.skus[0].product.code, 'MED-0007-V01');
    assert.equal(famResult.skus[1].product.code, 'MED-0007-V02');

    // Next standalone gets MED-0008
    const afterFam = backend.saveProductAtomic({
      token,
      product: {
        id: 'p-med-8',
        activityId: 'pharmacy',
        code: '',
        autoGenerateCode: true,
        nameAr: 'دواء بعد المجموعة',
        category: 'أدوية',
        unit: 'علبة',
        purchasePrice: 10,
        sellPrice: 15,
        currentStock: 0,
        minStockAlert: 2,
      },
    });
    assert.equal(afterFam.code, 'MED-0008');

    // 6. Reject manual normalized duplicates across standalone and SKU (case + whitespace)
    assert.throws(
      () =>
        backend.saveProductAtomic({
          token,
          product: {
            id: 'p-dup-standalone',
            activityId: 'grocery',
            code: '  med-0001  ',
            nameAr: 'تكرار مع صيدلية',
            category: 'بقالة',
            unit: 'حبة',
            purchasePrice: 5,
            sellPrice: 9,
            currentStock: 0,
            minStockAlert: 1,
          },
        }),
      /مستخدم بالفعل/
    );
    assert.throws(
      () =>
        backend.saveProductAtomic({
          token,
          product: {
            id: 'p-dup-sku',
            activityId: 'pharmacy',
            code: ' med-0007-v01 ',
            nameAr: 'تكرار مع متغير',
            category: 'أدوية',
            unit: 'علبة',
            purchasePrice: 5,
            sellPrice: 9,
            currentStock: 0,
            minStockAlert: 1,
          },
        }),
      /مستخدم بالفعل/
    );
    assert.throws(
      () =>
        backend.createProductFamilyWithSkusAtomic({
          token,
          input: {
            id: 'fam-dup-sku',
            activityId: 'pharmacy',
            nameAr: 'مجموعة متعارضة',
            optionSchema: [
              { key: 'size', labelAr: 'الحجم', values: ['صغير'], required: true, sortOrder: 1 },
            ],
            skus: [
              {
                product: {
                  id: 'sku-dup-standalone',
                  activityId: 'pharmacy',
                  code: ' MED-0001 ',
                  nameAr: 'متغير متعارض',
                  category: 'أدوية',
                  unit: 'علبة',
                  purchasePrice: 5,
                  sellPrice: 9,
                  currentStock: 0,
                  minStockAlert: 1,
                },
                variantAttributes: { size: 'صغير' },
              },
            ],
          },
        }),
      /مستخدم بالفعل/
    );

    // 7. Tenant isolation: second tenant keeps independent sequence starting at MED-0001
    runtime.database.prepare(
      'INSERT INTO tenants (id,name,code,currency,is_active,data_json) VALUES (?,?,?,?,1,?)'
    ).run('tenant_b', 'مؤسسة ب', 'TB', 'YER', JSON.stringify({ id: 'tenant_b', name: 'مؤسسة ب' }));
    runtime.database.prepare(
      'INSERT INTO branches (tenant_id,id,code,name_ar,is_main,active,data_json) VALUES (?,?,?,?,1,1,?)'
    ).run('tenant_b', 'branch_b', 'BRB1', 'فرع ب', JSON.stringify({ id: 'branch_b', code: 'BRB1', nameAr: 'فرع ب', isMain: true, active: true }));
    runtime.database.prepare(
      'INSERT INTO activities (tenant_id,id,code,data_json) VALUES (?,?,?,?)'
    ).run('tenant_b', 'pharmacy', 'PH', JSON.stringify({ id: 'pharmacy', nameAr: 'الصيدلية', code: 'PH' }));
    const { hashPasswordForDesktop } = await import('../../electron/security/authentication.mjs');
    runtime.database.prepare(
      'INSERT INTO users (tenant_id,id,branch_id,username,role,active,password_hash,data_json) VALUES (?,?,?,?,?,1,?,?)'
    ).run(
      'tenant_b',
      'user-b',
      'branch_b',
      'admin_b',
      'ADMIN',
      hashPasswordForDesktop('TenantBStrong#2026'),
      JSON.stringify({
        id: 'user-b',
        tenantId: 'tenant_b',
        branchId: 'branch_b',
        allowedBranches: ['branch_b'],
        allowedActivities: ['pharmacy'],
        username: 'admin_b',
        fullName: 'مدير ب',
        role: 'ADMIN',
        active: true,
      })
    );
    const authB = new DesktopAuthenticationService(runtime.database, { tenantId: 'tenant_b' });
    const backendB = createDesktopBackend({
      database: runtime.database,
      backupDirectory: runtime.backupDirectory,
      authenticationService: authB,
    });
    const loginB = authB.authenticate({ username: 'admin_b', password: 'TenantBStrong#2026' });
    assert.equal(loginB.success, true);
    const tenantBProduct = backendB.saveProductAtomic({
      token: loginB.token,
      product: {
        id: 'tb-p1',
        activityId: 'pharmacy',
        code: '',
        autoGenerateCode: true,
        nameAr: 'دواء مؤسسة ب',
        category: 'أدوية',
        unit: 'علبة',
        purchasePrice: 10,
        sellPrice: 15,
        currentStock: 0,
        minStockAlert: 1,
      },
    });
    assert.equal(tenantBProduct.code, 'MED-0001');

    assert.equal(runtime.database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(runtime.database.prepare('PRAGMA foreign_key_check').all().length, 0);
    runtime.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('WO-SCOPE-A-02: Failed product or family transaction rolls back without leaking product sequence numbers', async () => {
  const { userDataPath } = setupCleanBackend();
  try {
    const { runtime, backend, token } = await createAuthedBackend(userDataPath);

    // Existing product MED-0001
    const first = backend.saveProductAtomic({
      token,
      product: {
        id: 'rb-ok-1',
        activityId: 'pharmacy',
        code: '',
        autoGenerateCode: true,
        nameAr: 'صنف صالح',
        category: 'أدوية',
        unit: 'علبة',
        purchasePrice: 10,
        sellPrice: 15,
        currentStock: 0,
        minStockAlert: 1,
        barcode: '999000111',
      },
    });
    assert.equal(first.code, 'MED-0001');

    // Failing standalone save (duplicate barcode) -> allocates inside tx then rolls back cleanly
    assert.throws(
      () =>
        backend.saveProductAtomic({
          token,
          product: {
            id: 'rb-fail-barcode',
            activityId: 'pharmacy',
            code: '',
            autoGenerateCode: true,
            nameAr: 'صنف بباركود مكرر',
            category: 'أدوية',
            unit: 'علبة',
            purchasePrice: 10,
            sellPrice: 15,
            currentStock: 0,
            minStockAlert: 1,
            barcode: '999000111',
          },
        }),
      /الباركود/
    );

    // Failing family batch (2nd SKU collides with barcode) -> must roll back sequence AND family!
    assert.throws(
      () =>
        backend.createProductFamilyWithSkusAtomic({
          token,
          input: {
            id: 'fam-rb-seq',
            activityId: 'pharmacy',
            nameAr: 'مجموعة فاشلة',
            optionSchema: [
              { key: 'size', labelAr: 'الحجم', values: ['S', 'M'], required: true, sortOrder: 1 },
            ],
            skus: [
              {
                product: {
                  id: 'fam-rb-sku-1',
                  activityId: 'pharmacy',
                  code: '',
                  autoGenerateCode: true,
                  nameAr: 'S',
                  category: 'أدوية',
                  unit: 'علبة',
                  purchasePrice: 10,
                  sellPrice: 15,
                  currentStock: 0,
                  minStockAlert: 1,
                },
                variantAttributes: { size: 'S' },
              },
              {
                product: {
                  id: 'fam-rb-sku-2',
                  activityId: 'pharmacy',
                  code: '',
                  autoGenerateCode: true,
                  nameAr: 'M',
                  category: 'أدوية',
                  unit: 'علبة',
                  purchasePrice: 10,
                  sellPrice: 15,
                  currentStock: 0,
                  minStockAlert: 1,
                  barcode: '999000111',
                },
                variantAttributes: { size: 'M' },
              },
            ],
          },
        }),
      /الباركود/
    );

    // Next valid save MUST get MED-0002 (zero leaked sequence numbers!)
    const retryOk = backend.saveProductAtomic({
      token,
      product: {
        id: 'rb-retry-ok',
        activityId: 'pharmacy',
        code: '',
        autoGenerateCode: true,
        nameAr: 'صنف بعد التراجع',
        category: 'أدوية',
        unit: 'علبة',
        purchasePrice: 10,
        sellPrice: 15,
        currentStock: 0,
        minStockAlert: 1,
      },
    });
    assert.equal(retryOk.code, 'MED-0002');
    assert.equal(runtime.database.prepare('SELECT COUNT(*) AS c FROM product_families').get().c, 0);
    runtime.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('WO-SCOPE-A-03: Migration 007 preserves legacy duplicate codes, allows non-code edits on them, and blocks new normalized duplicates', async () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-wo-legacy-mig7-'));
  try {
    const migrationsDir = path.resolve('electron/sqlite/migrations');
    const pre007Migrations = readdirSync(migrationsDir)
      .map((name) => name.match(/^(\d{3,})_([a-z0-9_]+)\.sql$/i))
      .filter((m) => m && Number(m[1]) <= 6)
      .sort((a, b) => Number(a[1]) - Number(b[1]));

    const dbFolder = path.join(userDataPath, 'Database');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dbFolder, { recursive: true });
    const dbPath = path.join(dbFolder, 'erp.sqlite');

    // Create synthetic pre-007 database containing historical duplicate product codes
    const preDb = new DatabaseSync(dbPath);
    preDb.exec('PRAGMA foreign_keys = ON;');
    for (const m of pre007Migrations) {
      const sql = readFileSync(path.join(migrationsDir, m[0]), 'utf8');
      preDb.exec(sql);
      const checksum = createHash('sha256').update(sql, 'utf8').digest('hex');
      preDb.prepare(
        'INSERT INTO schema_migrations (version,name,checksum_sha256,applied_at) VALUES (?,?,?,?)'
      ).run(Number(m[1]), m[0].replace(/\.sql$/i, ''), checksum, '2026-11-20T00:00:00.000Z');
    }

    preDb.prepare('INSERT OR IGNORE INTO tenants (id,name,code,currency,is_active,data_json) VALUES (?,?,?,?,1,?)').run(
      'tenant_main',
      'المؤسسة',
      'MAIN',
      'YER',
      JSON.stringify({ id: 'tenant_main', name: 'المؤسسة' })
    );
    preDb.prepare('INSERT OR IGNORE INTO activities (tenant_id,id,code,data_json) VALUES (?,?,?,?)').run(
      'tenant_main',
      'pharmacy',
      'PH',
      JSON.stringify({ id: 'pharmacy', nameAr: 'الصيدلية', code: 'PH' })
    );
    preDb.prepare(
      'INSERT INTO products (tenant_id,id,activity_id,code,barcode,category,current_stock_decimal,data_json) VALUES (?,?,?,?,?,?,?,?)'
    ).run(
      'tenant_main',
      'hist-dup-1',
      'pharmacy',
      'MED-0005',
      null,
      'قديم',
      '4',
      JSON.stringify({
        id: 'hist-dup-1',
        activityId: 'pharmacy',
        code: 'MED-0005',
        nameAr: 'صنف تاريخي مكرر 1',
        category: 'قديم',
        unit: 'علبة',
        purchasePrice: 10,
        sellPrice: 15,
        currentStock: 4,
        minStockAlert: 1,
        isActive: true,
      })
    );
    preDb.prepare(
      'INSERT INTO products (tenant_id,id,activity_id,code,barcode,category,current_stock_decimal,data_json) VALUES (?,?,?,?,?,?,?,?)'
    ).run(
      'tenant_main',
      'hist-dup-2',
      'pharmacy',
      ' med-0005 ',
      null,
      'قديم',
      '2',
      JSON.stringify({
        id: 'hist-dup-2',
        activityId: 'pharmacy',
        code: ' med-0005 ',
        nameAr: 'صنف تاريخي مكرر 2',
        category: 'قديم',
        unit: 'علبة',
        purchasePrice: 10,
        sellPrice: 15,
        currentStock: 2,
        minStockAlert: 1,
        isActive: true,
      })
    );
    preDb.close();

    // Reopen with openErpDatabase -> applies migration 007 without failing on duplicates!
    const runtime = await openErpDatabase({ userDataPath });
    assert.ok(runtime.appliedMigrations.includes(7));

    // Historical duplicates remain untouched
    const rowsBefore = runtime.database.prepare(
      'SELECT id, code FROM products WHERE tenant_id = ? ORDER BY id'
    ).all('tenant_main').map((r) => ({ id: r.id, code: r.code }));
    assert.deepEqual(rowsBefore, [
      { id: 'hist-dup-1', code: 'MED-0005' },
      { id: 'hist-dup-2', code: ' med-0005 ' },
    ]);

    const auth = new DesktopAuthenticationService(runtime.database);
    const setupRes = auth.createInitialAdmin({
      username: 'admin',
      fullName: 'المدير',
      password: 'AdminStrong#2026',
    });
    assert.equal(setupRes.success, true);
    const backend = createDesktopBackend({
      database: runtime.database,
      backupDirectory: runtime.backupDirectory,
      authenticationService: auth,
    });
    const loginRes = auth.authenticate({ username: 'admin', password: 'AdminStrong#2026' });
    assert.equal(loginRes.success, true);
    const { token } = loginRes;

    // Non-code edit on a historical duplicate row MUST succeed!
    const existingDup = backend.getProductById({ token, id: 'hist-dup-1' });
    const editedDup = backend.saveProductAtomic({
      token,
      isUpdate: true,
      product: {
        ...existingDup,
        nameAr: 'صنف تاريخي مكرر 1 - محدث السعر',
        sellPrice: 18,
      },
    });
    assert.equal(editedDup.code, 'MED-0005');
    assert.equal(editedDup.sellPrice, 18);

    // Auto-generated code lazily seeds past MED-0005 -> MED-0006
    const nextAuto = backend.saveProductAtomic({
      token,
      product: {
        id: 'post-007-auto',
        activityId: 'pharmacy',
        code: '',
        autoGenerateCode: true,
        nameAr: 'صنف جديد بعد الترحيل',
        category: 'أدوية',
        unit: 'علبة',
        purchasePrice: 10,
        sellPrice: 15,
        currentStock: 0,
        minStockAlert: 1,
      },
    });
    assert.equal(nextAuto.code, 'MED-0006');

    // New duplicate insertion rejected by service & SQLite trigger
    assert.throws(
      () =>
        backend.saveProductAtomic({
          token,
          product: {
            id: 'new-dup-attempt',
            activityId: 'pharmacy',
            code: 'MED-0005',
            nameAr: 'محاولة تكرار جديدة',
            category: 'أدوية',
            unit: 'علبة',
            purchasePrice: 10,
            sellPrice: 15,
            currentStock: 0,
            minStockAlert: 1,
          },
        }),
      /مستخدم بالفعل/
    );

    assert.throws(
      () =>
        runtime.database.prepare(
          'INSERT INTO products (tenant_id,id,activity_id,code,category,current_stock_decimal,data_json) VALUES (?,?,?,?,?,?,?)'
        ).run('tenant_main', 'raw-dup-attempt', 'pharmacy', '  med-0006  ', 'أدوية', '0', '{}'),
      /كود الصنف مستخدم بالفعل/
    );

    assert.equal(runtime.database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(runtime.database.prepare('PRAGMA foreign_key_check').all().length, 0);
    runtime.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
