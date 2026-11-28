import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openErpDatabase, restoreSqliteBackupFile, verifySqliteFile } from '../../electron/sqlite/database.mjs';
import { DesktopAuthenticationService } from '../../electron/security/authentication.mjs';
import { createDesktopBackend } from '../../electron/sqlite/desktop-backend.mjs';
import { createProductMediaStorage } from '../../electron/product-media-storage.mjs';
import { verifyProductMediaIntegrity } from '../../electron/sqlite/modules/product-media-service.mjs';
import { databaseFinancialTotals } from '../../electron/sqlite/legacy-backup-importer.mjs';

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/7f8AAAAASUVORK5CYII=';

test('PVAR-010 SQLite Native Backup & Restore: preserves catalog, units, invoice snapshots, and verifies .media + SHA-256 + references', async () => {
  const dir1 = mkdtempSync(path.join(os.tmpdir(), 'erp-pvar10-src-'));
  const dir2 = mkdtempSync(path.join(os.tmpdir(), 'erp-pvar10-dst-'));
  try {
    const rt1 = await openErpDatabase({ userDataPath: dir1 });
    const auth1 = new DesktopAuthenticationService(rt1.database);
    const mediaDir1 = path.join(dir1, 'ProductMedia');
    const backend1 = createDesktopBackend({
      database: rt1.database,
      backupDirectory: rt1.backupDirectory,
      mediaDirectory: mediaDir1,
      authenticationService: auth1,
    });

    auth1.createInitialAdmin({
      username: 'admin10',
      fullName: 'مدير اختبار PVAR-010',
      password: 'AdminPvar10#2026',
    });
    const token1 = auth1.authenticate({ username: 'admin10', password: 'AdminPvar10#2026' }).token;

    const brand = backend1.saveBrandAtomic({ token: token1, input: { nameAr: 'علامة PVAR-010' } });
    const familyRes = backend1.createProductFamilyWithSkusAtomic({
      token: token1,
      input: {
        activityId: 'grocery',
        nameAr: 'بن محمص',
        brandId: brand.id,
        optionSchema: [{ key: 'weight', labelAr: 'الوزن', values: ['250 جم', '500 جم'], required: true }],
        skus: [
          {
            product: {
              id: 'sql-sku-250',
              activityId: 'grocery',
              code: 'COF-250',
              nameAr: 'بن محمص - 250 جم',
              category: 'قهوة',
              unit: 'كيس',
              purchasePrice: 500,
              sellPrice: 700,
              currentStock: 20,
              minStockAlert: 3,
            },
            variantAttributes: { weight: '250 جم' },
          },
          {
            product: {
              id: 'sql-sku-500',
              activityId: 'grocery',
              code: 'COF-500',
              nameAr: 'بن محمص - 500 جم',
              category: 'قهوة',
              unit: 'كيس',
              purchasePrice: 950,
              sellPrice: 1300,
              currentStock: 10,
              minStockAlert: 2,
            },
            variantAttributes: { weight: '500 جم' },
          },
        ],
      },
    });
    assert.equal(familyRes.skus.length, 2);

    backend1.saveProductUnit({
      token: token1,
      unit: {
        productId: 'sql-sku-250',
        nameAr: 'شدة 6 أكياس',
        code: 'PACK6',
        baseUnitsNumerator: 6,
        baseUnitsDenominator: 1,
        barcode: '0011223344',
        defaultSellPrice: 4100,
        isActive: true,
      },
    });

    const img = backend1.addProductImage({
      token: token1,
      input: {
        productId: 'sql-sku-250',
        originalDataUrl: PNG_1X1,
        thumbnailDataUrl: PNG_1X1,
        mimeType: 'image/png',
        width: 1,
        height: 1,
      },
    });

    const cashBoxes1 = backend1.getCashBoxes({ token: token1 });
    backend1.createSalesInvoiceAtomic({
      token: token1,
      params: {
        invoice: {
          id: 'sql-inv-10',
          invoiceNumber: 'INV-SQL-10',
          date: '2026-11-27',
          type: 'SALE',
          activityId: 'grocery',
          branchId: 'branch_main',
          paymentMethod: 'CASH',
          cashBoxId: cashBoxes1[0].id,
          subtotal: 4100,
          discount: 0,
          tax: 0,
          total: 4100,
          paidAmount: 4100,
          status: 'POSTED',
          isPosted: true,
          createdAt: '2026-11-27T11:00:00Z',
          items: [
            {
              id: 'sql-item-10',
              productId: 'sql-sku-250',
              productCode: 'COF-250',
              productName: 'بن محمص - 250 جم',
              quantity: 1,
              unit: 'شدة 6 أكياس',
              unitId: rt1.database
                .prepare('SELECT id FROM product_units WHERE product_id = ?')
                .get('sql-sku-250').id,
              unitCode: 'PACK6',
              baseUnitName: 'كيس',
              baseQuantity: 6,
              conversionNumeratorSnapshot: 6,
              conversionDenominatorSnapshot: 1,
              unitPrice: 4100,
              discount: 0,
              total: 4100,
            },
          ],
        },
        totalCogs: 3000,
        stockDeductions: [
          {
            invoiceItemId: 'sql-item-10',
            productId: 'sql-sku-250',
            quantity: 6,
          },
        ],
      },
    });

    const expectedTotals = databaseFinancialTotals(rt1.database, 'tenant_main');
    const createdBackup = await backend1.createNativeBackupNow({ token: token1, prefix: 'pvar10' });
    assert.equal(existsSync(createdBackup.path), true);
    assert.equal(existsSync(createdBackup.path + '.media'), true);

    const listedBackups = backend1.listNativeBackups({ token: token1 });
    const foundListed = listedBackups.find((b) => b.filename === createdBackup.filename);
    assert.equal(foundListed?.hasMediaSidecar, true);

    rt1.close();

    // Restore into a separate SQLite environment and verify DB + media + references
    const rt2 = await openErpDatabase({ userDataPath: dir2 });
    const restored = await restoreSqliteBackupFile({
      databasePath: rt2.databasePath,
      backupDirectory: rt2.backupDirectory,
      sourceBackupPath: createdBackup.path,
      currentDatabase: rt2.database,
      reopenOptions: { userDataPath: dir2 },
    });
    const mediaDir2 = path.join(dir2, 'ProductMedia');
    const mediaStorage2 = createProductMediaStorage({ rootDirectory: mediaDir2 });
    assert.equal(mediaStorage2.restoreFrom(createdBackup.path + '.media'), true);

    const fileCheck = verifySqliteFile(restored.databaseRuntime.databasePath);
    assert.equal(fileCheck.valid, true);

    const mediaCheck = verifyProductMediaIntegrity(restored.databaseRuntime.database, mediaStorage2);
    assert.equal(mediaCheck.valid, true);
    assert.equal(mediaCheck.checkedCount, 1);

    const restoredTotals = databaseFinancialTotals(restored.databaseRuntime.database, 'tenant_main');
    assert.deepEqual(restoredTotals, expectedTotals);

    const itemRow = restored.databaseRuntime.database
      .prepare('SELECT base_quantity_decimal FROM invoice_items WHERE id = ?')
      .get('sql-item-10');
    assert.equal(Number(itemRow.base_quantity_decimal), 6);

    const deductionRow = restored.databaseRuntime.database
      .prepare('SELECT invoice_item_id FROM invoice_stock_deductions WHERE invoice_id = ?')
      .get('sql-inv-10');
    assert.equal(deductionRow.invoice_item_id, 'sql-item-10');

    // Negative check 1: corrupt image bytes -> verifyProductMediaIntegrity MUST throw
    const origPath = path.join(mediaDir2, ...img.storageKey.split('/'));
    writeFileSync(origPath, Buffer.from('corrupt-image-bytes'));
    assert.throws(() => verifyProductMediaIntegrity(restored.databaseRuntime.database, mediaStorage2));

    // Negative check 2: missing image file -> verifyProductMediaIntegrity MUST throw
    rmSync(origPath, { force: true });
    assert.throws(
      () => verifyProductMediaIntegrity(restored.databaseRuntime.database, mediaStorage2),
      /مفقود/
    );

    restored.databaseRuntime.close();
  } finally {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('PVAR-010 SQLite JSON Backup & Legacy Import: roundtrips catalog/units/snapshots and accepts legacy v2.0 omitting them', async () => {
  const dirSrc = mkdtempSync(path.join(os.tmpdir(), 'erp-pvar10-json-src-'));
  const dirDst = mkdtempSync(path.join(os.tmpdir(), 'erp-pvar10-json-dst-'));
  const dirLegacy = mkdtempSync(path.join(os.tmpdir(), 'erp-pvar10-json-leg-'));
  try {
    const rtSrc = await openErpDatabase({ userDataPath: dirSrc });
    const authSrc = new DesktopAuthenticationService(rtSrc.database);
    const backendSrc = createDesktopBackend({
      database: rtSrc.database,
      backupDirectory: rtSrc.backupDirectory,
      mediaDirectory: path.join(dirSrc, 'ProductMedia'),
      authenticationService: authSrc,
    });
    authSrc.createInitialAdmin({
      username: 'admin_json',
      fullName: 'مدير JSON',
      password: 'AdminJson#2026',
    });
    const tokenSrc = authSrc.authenticate({ username: 'admin_json', password: 'AdminJson#2026' }).token;

    const brand = backendSrc.saveBrandAtomic({ token: tokenSrc, input: { nameAr: 'براند التصدير' } });
    backendSrc.createProductFamilyWithSkusAtomic({
      token: tokenSrc,
      input: {
        activityId: 'grocery',
        nameAr: 'شاي أخضر',
        brandId: brand.id,
        optionSchema: [{ key: 'pack', labelAr: 'العبوة', values: ['25 ظرف'], required: true }],
        skus: [
          {
            product: {
              id: 'json-sku-1',
              activityId: 'grocery',
              code: 'TEA-25',
              nameAr: 'شاي أخضر - 25 ظرف',
              category: 'مشروبات',
              unit: 'علبة',
              purchasePrice: 300,
              sellPrice: 450,
              currentStock: 10,
              minStockAlert: 2,
            },
            variantAttributes: { pack: '25 ظرف' },
          },
        ],
      },
    });
    backendSrc.saveProductUnit({
      token: tokenSrc,
      unit: {
        productId: 'json-sku-1',
        nameAr: 'ربطة 4 علب',
        code: 'BND4',
        baseUnitsNumerator: 4,
        baseUnitsDenominator: 1,
        defaultSellPrice: 1700,
        isActive: true,
      },
    });

    const exportedJson = backendSrc.exportBackupJSON({ token: tokenSrc });
    rtSrc.close();

    // Restore exported JSON into clean SQLite destination
    const rtDst = await openErpDatabase({ userDataPath: dirDst });
    const authDst = new DesktopAuthenticationService(rtDst.database);
    const backendDst = createDesktopBackend({
      database: rtDst.database,
      backupDirectory: rtDst.backupDirectory,
      mediaDirectory: path.join(dirDst, 'ProductMedia'),
      authenticationService: authDst,
    });
    const importRes = await backendDst.importLegacyBackup({ rawJson: exportedJson });
    assert.equal(importRes.success, true);
    assert.equal(rtDst.database.prepare('SELECT COUNT(*) AS count FROM brands').get().count, 1);
    assert.equal(rtDst.database.prepare('SELECT COUNT(*) AS count FROM product_families').get().count, 1);
    assert.equal(rtDst.database.prepare('SELECT COUNT(*) AS count FROM product_catalog_meta').get().count, 1);
    assert.equal(rtDst.database.prepare('SELECT COUNT(*) AS count FROM product_units').get().count, 1);
    rtDst.close();

    // Verify legacy backup omitting catalog/units/media still imports cleanly into fresh SQLite
    const parsed = JSON.parse(exportedJson);
    delete parsed.data.brands;
    delete parsed.data.productFamilies;
    delete parsed.data.productCatalogMeta;
    delete parsed.data.productUnits;
    delete parsed.data.mediaManifest;
    const legacySerialized = JSON.stringify(parsed.data);
    let legacyChecksum = 0;
    for (let i = 0; i < legacySerialized.length; i++) {
      legacyChecksum = (legacyChecksum + legacySerialized.charCodeAt(i) * (i + 1)) % 1000000007;
    }
    parsed.checksum = legacyChecksum.toString(16);
    const rtLeg = await openErpDatabase({ userDataPath: dirLegacy });
    const authLeg = new DesktopAuthenticationService(rtLeg.database);
    const backendLeg = createDesktopBackend({
      database: rtLeg.database,
      backupDirectory: rtLeg.backupDirectory,
      mediaDirectory: path.join(dirLegacy, 'ProductMedia'),
      authenticationService: authLeg,
    });
    const legacyRes = await backendLeg.importLegacyBackup({ rawJson: JSON.stringify(parsed) });
    assert.equal(legacyRes.success, true);
    assert.equal(rtLeg.database.prepare('SELECT COUNT(*) AS count FROM products').get().count, 1);
    assert.equal(rtLeg.database.prepare('SELECT COUNT(*) AS count FROM brands').get().count, 0);
    assert.equal(rtLeg.database.prepare('SELECT COUNT(*) AS count FROM product_units').get().count, 0);
    rtLeg.close();
  } finally {
    rmSync(dirSrc, { recursive: true, force: true });
    rmSync(dirDst, { recursive: true, force: true });
    rmSync(dirLegacy, { recursive: true, force: true });
  }
});
