import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openErpDatabase } from '../../electron/sqlite/database.mjs';
import { DesktopAuthenticationService } from '../../electron/security/authentication.mjs';
import { createDesktopBackend } from '../../electron/sqlite/desktop-backend.mjs';

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/7f8AAAAASUVORK5CYII=';

function isoDateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

test('PVAR-009 SQLite parity: specialized fields, per-SKU FEFO batches, expired blocking, and isolated SKU images', async () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-pvar009-sqlite-'));
  const mediaDirectory = path.join(userDataPath, 'ProductMedia');
  let runtime;
  try {
    runtime = await openErpDatabase({ userDataPath });
    const db = runtime.database;

    // Seed all 4 activities so RBAC & activity scopes pass cleanly
    const insertAct = db.prepare(
      'INSERT OR IGNORE INTO activities (tenant_id,id,code,data_json) VALUES (?,?,?,?)'
    );
    insertAct.run('tenant_main', 'pharmacy', 'PHARM', JSON.stringify({ id: 'pharmacy', nameAr: 'الصيدلية' }));
    insertAct.run('tenant_main', 'grocery', 'GROC', JSON.stringify({ id: 'grocery', nameAr: 'البقالة' }));
    insertAct.run('tenant_main', 'bike_parts', 'BIKE', JSON.stringify({ id: 'bike_parts', nameAr: 'قطع غيار الدراجات' }));
    insertAct.run('tenant_main', 'equipment_parts', 'EQUIP', JSON.stringify({ id: 'equipment_parts', nameAr: 'قطع غيار المعدات' }));

    const auth = new DesktopAuthenticationService(db);
    const backend = createDesktopBackend({
      database: db,
      backupDirectory: runtime.backupDirectory,
      mediaDirectory,
      authenticationService: auth,
    });

    auth.createInitialAdmin({
      username: 'pvar009_sqlite_admin',
      fullName: 'PVAR-009 SQLite Admin',
      password: 'Pvar009-Sqlite#2026',
    });
    const token = auth.authenticate({
      username: 'pvar009_sqlite_admin',
      password: 'Pvar009-Sqlite#2026',
    }).token;

    // Assert no separate product_family media table exists (images stay per-SKU in product_images)
    const familyMediaTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%family%image%'")
      .get();
    assert.equal(familyMediaTable, undefined);

    // 1. Specialized fields round-trip across all 4 activities
    const equipSku = backend.saveProductAtomic({
      token,
      product: {
        id: 'sq-eqp-1',
        activityId: 'equipment_parts',
        code: 'EQP-9001',
        nameAr: 'فلتر زيت معدة',
        category: 'فلاتر',
        unit: 'حبة',
        purchasePrice: 40,
        sellPrice: 60,
        currentStock: 5,
        minStockAlert: 1,
        oemNumber: '1R-0750',
        manufacturer: 'CAT',
        compatibleModels: '320D',
        equipmentType: 'حفارة',
        serialNumber: 'CAT-SN-10',
      },
      isUpdate: false,
    });
    assert.equal(equipSku.equipmentType, 'حفارة');
    assert.equal(equipSku.serialNumber, 'CAT-SN-10');

    const bikeSku = backend.saveProductAtomic({
      token,
      product: {
        id: 'sq-bike-1',
        activityId: 'bike_parts',
        code: 'MBK-9001',
        nameAr: 'سلسلة دراجة 428',
        category: 'نواقل حركة',
        unit: 'حبة',
        purchasePrice: 25,
        sellPrice: 40,
        currentStock: 8,
        minStockAlert: 2,
        oemNumber: '40530-KRM-861',
        manufacturer: 'DID',
        compatibleModels: 'CG150 / XL150',
      },
      isUpdate: false,
    });
    assert.equal(bikeSku.manufacturer, 'DID');
    assert.equal(bikeSku.equipmentType, undefined);

    const dryGrocSku = backend.saveProductAtomic({
      token,
      product: {
        id: 'sq-groc-dry',
        activityId: 'grocery',
        code: 'FOD-9001',
        nameAr: 'ملح طعام 500 جم',
        category: 'بهارات',
        unit: 'كيس',
        purchasePrice: 2,
        sellPrice: 3,
        currentStock: 20,
        minStockAlert: 5,
        trackExpiry: false,
      },
      isUpdate: false,
    });
    assert.equal(dryGrocSku.trackExpiry, false);

    // 2. Create pharmacy variant family with per-SKU batches (SKU-1 has 2 batches, SKU-2 has 1 expired batch)
    const soonDate = isoDateOffset(25);
    const laterDate = isoDateOffset(190);
    const pastDate = isoDateOffset(-7);

    const familyRes = backend.createProductFamilyWithSkusAtomic({
      token,
      input: {
        activityId: 'pharmacy',
        nameAr: 'باراسيتامول شراب',
        categorySnapshot: 'مسكنات',
        optionSchema: [{ key: 'size', labelAr: 'الحجم', values: ['60مل', '120مل'], required: true, sortOrder: 1 }],
        skus: [
        {
          product: {
            id: 'sq-pharm-sku-1',
            activityId: 'pharmacy',
            code: 'MED-9001-V01',
            nameAr: 'باراسيتامول شراب - 60مل',
            category: 'مسكنات',
            unit: 'علبة',
            purchasePrice: 8,
            sellPrice: 12,
            currentStock: 6,
            minStockAlert: 2,
            scientificName: 'Paracetamol',
            dosageForm: 'شراب',
            trackExpiry: true,
            batches: [
              {
                id: 'sq-b-soon',
                productId: 'sq-pharm-sku-1',
                batchNumber: 'SQ-SOON',
                expiryDate: soonDate,
                quantity: 2,
                costPrice: 8,
              },
              {
                id: 'sq-b-later',
                productId: 'sq-pharm-sku-1',
                batchNumber: 'SQ-LATER',
                expiryDate: laterDate,
                quantity: 4,
                costPrice: 8,
              },
            ],
          },
          variantAttributes: { size: '60مل' },
        },
        {
          product: {
            id: 'sq-pharm-sku-2',
            activityId: 'pharmacy',
            code: 'MED-9001-V02',
            nameAr: 'باراسيتامول شراب - 120مل',
            category: 'مسكنات',
            unit: 'علبة',
            purchasePrice: 14,
            sellPrice: 20,
            currentStock: 3,
            minStockAlert: 1,
            scientificName: 'Paracetamol',
            dosageForm: 'شراب',
            trackExpiry: true,
            batches: [
              {
                id: 'sq-b-exp',
                productId: 'sq-pharm-sku-2',
                batchNumber: 'SQ-EXPIRED',
                expiryDate: pastDate,
                quantity: 3,
                costPrice: 14,
              },
            ],
          },
          variantAttributes: { size: '120مل' },
        },
      ],
      },
    });
    assert.equal(familyRes.skus.length, 2);
    assert.equal(backend.getProductById({ token, id: 'sq-pharm-sku-1' })?.dosageForm, 'شراب');

    // Verify ProductBatch rows are linked strictly to SKU product_id
    const batchesSku1 = db.prepare('SELECT batch_number, quantity_decimal FROM product_batches WHERE product_id = ?').all('sq-pharm-sku-1');
    const batchesSku2 = db.prepare('SELECT batch_number, quantity_decimal FROM product_batches WHERE product_id = ?').all('sq-pharm-sku-2');
    assert.equal(batchesSku1.length, 2);
    assert.equal(batchesSku2.length, 1);

    const cashBox = backend.getCashBoxes({ token })[0];
    assert.ok(cashBox);

    // 3. Auto FEFO deduction deducts SQ-SOON first then SQ-LATER, without touching SKU-2
    backend.createSalesInvoiceAtomic({
      token,
      params: {
        invoice: {
          id: 'sq-inv-fefo',
          invoiceNumber: '',
          type: 'SALE',
          activityId: 'pharmacy',
          branchId: 'branch_main',
          partyName: 'عميل نقدي',
          date: isoDateOffset(0),
          items: [
            {
              id: 'sq-line-1',
              productId: 'sq-pharm-sku-1',
              productName: 'باراسيتامول شراب - 60مل',
              productCode: 'MED-9001-V01',
              unit: 'علبة',
              quantity: 3,
              unitPrice: 12,
              discount: 0,
              total: 36,
            },
          ],
          subtotal: 36,
          discount: 0,
          tax: 0,
          total: 36,
          paidAmount: 36,
          paymentMethod: 'CASH',
          cashBoxId: cashBox.id,
        },
        totalCogs: 24,
        stockDeductions: [{ invoiceItemId: 'sq-line-1', productId: 'sq-pharm-sku-1', quantity: 3 }],
      },
    });

    const sku1After = backend.getProductById({ token, id: 'sq-pharm-sku-1' });
    const soonRow = sku1After?.batches?.find((b) => b.batchNumber === 'SQ-SOON');
    const laterRow = sku1After?.batches?.find((b) => b.batchNumber === 'SQ-LATER');
    assert.equal(soonRow?.quantity, 0);
    assert.equal(laterRow?.quantity, 3);
    assert.equal(backend.getProductById({ token, id: 'sq-pharm-sku-2' })?.currentStock, 3);

    // 4. Selling SKU-2 whose only batch is expired MUST be rejected
    assert.throws(
      () =>
        backend.createSalesInvoiceAtomic({
          token,
          params: {
            invoice: {
              id: 'sq-inv-exp-fail',
              invoiceNumber: '',
              type: 'SALE',
              activityId: 'pharmacy',
              branchId: 'branch_main',
              partyName: 'عميل نقدي',
              date: isoDateOffset(0),
              items: [
                {
                  id: 'sq-line-exp',
                  productId: 'sq-pharm-sku-2',
                  productName: 'باراسيتامول شراب - 120مل',
                  productCode: 'MED-9001-V02',
                  unit: 'علبة',
                  quantity: 1,
                  unitPrice: 20,
                  discount: 0,
                  total: 20,
                },
              ],
              subtotal: 20,
              discount: 0,
              tax: 0,
              total: 20,
              paidAmount: 20,
              paymentMethod: 'CASH',
              cashBoxId: cashBox.id,
            },
            totalCogs: 14,
            stockDeductions: [{ invoiceItemId: 'sq-line-exp', productId: 'sq-pharm-sku-2', quantity: 1 }],
          },
        }),
      /منتهي|صلاحية/
    );

    // 5. Image attached to SKU-1 does not affect accounting or copy files to sibling SKU-2
    const journalCountBefore = db.prepare('SELECT COUNT(*) AS count FROM journal_entries').get().count;
    backend.addProductImage({
      token,
      input: {
        productId: 'sq-pharm-sku-1',
        originalDataUrl: PNG_1X1,
        thumbnailDataUrl: PNG_1X1,
        mimeType: 'image/png',
        width: 1,
        height: 1,
      },
    });
    assert.equal(backend.getProductImages({ token, productId: 'sq-pharm-sku-1' }).length, 1);
    assert.equal(backend.getProductImages({ token, productId: 'sq-pharm-sku-2' }).length, 0);
    const journalCountAfter = db.prepare('SELECT COUNT(*) AS count FROM journal_entries').get().count;
    assert.equal(journalCountAfter, journalCountBefore);
  } finally {
    try {
      runtime?.close();
    } catch {
      // ignore close errors
    }
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
