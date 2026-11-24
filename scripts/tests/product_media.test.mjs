import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openErpDatabase } from '../../electron/sqlite/database.mjs';
import { DesktopAuthenticationService } from '../../electron/security/authentication.mjs';
import { createDesktopBackend } from '../../electron/sqlite/desktop-backend.mjs';

const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/7f8AAAAASUVORK5CYII=';

test('Product media: private files, primary lifecycle, RBAC, audit, finance isolation and backup sidecar', async () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-product-media-'));
  const mediaDirectory = path.join(userDataPath, 'ProductMedia');
  try {
    const runtime = await openErpDatabase({ userDataPath });
    const auth = new DesktopAuthenticationService(runtime.database);
    const backend = createDesktopBackend({
      database: runtime.database,
      backupDirectory: runtime.backupDirectory,
      mediaDirectory,
      authenticationService: auth,
    });

    auth.createInitialAdmin({
      username: 'admin_media',
      fullName: 'مدير اختبار الصور',
      password: 'AdminMedia#2026',
    });
    const adminToken = auth.authenticate({
      username: 'admin_media',
      password: 'AdminMedia#2026',
    }).token;

    const product = backend.saveProductAtomic({
      token: adminToken,
      product: {
        id: 'product-media-001',
        activityId: 'grocery',
        code: 'GRO-MEDIA-001',
        nameAr: 'منتج اختبار الصور',
        category: 'مواد غذائية',
        unit: 'حبة',
        purchasePrice: 5,
        sellPrice: 8,
        currentStock: 0,
        minStockAlert: 1,
      },
      isUpdate: false,
    });

    const productBeforeImages = backend.getProductById({ token: adminToken, id: product.id });
    const accountCountBefore = runtime.database.prepare('SELECT COUNT(*) AS count FROM accounts').get().count;
    const journalCountBefore = runtime.database.prepare('SELECT COUNT(*) AS count FROM journal_entries').get().count;
    const auditCountBefore = runtime.database.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count;

    const first = backend.addProductImage({
      token: adminToken,
      input: {
        productId: product.id,
        originalDataUrl: PNG_1X1,
        thumbnailDataUrl: PNG_1X1,
        mimeType: 'image/png',
        width: 1,
        height: 1,
      },
    });
    assert.equal(first.isPrimary, true);
    assert.equal(first.syncStatus, 'PENDING_UPLOAD');

    const second = backend.addProductImage({
      token: adminToken,
      input: {
        productId: product.id,
        originalDataUrl: PNG_1X1,
        thumbnailDataUrl: PNG_1X1,
        mimeType: 'image/png',
        width: 1,
        height: 1,
      },
    });
    assert.equal(second.isPrimary, false);

    const firstFile = path.join(mediaDirectory, ...first.storageKey.split('/'));
    const firstThumb = path.join(mediaDirectory, ...first.thumbnailStorageKey.split('/'));
    assert.ok(existsSync(firstFile));
    assert.ok(existsSync(firstThumb));
    assert.ok(readFileSync(firstFile).subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));

    const mediaBackup = await backend.createNativeBackupNow({ token: adminToken, prefix: 'manual-media-check' });
    assert.ok(existsSync(mediaBackup.path));
    assert.ok(existsSync(mediaBackup.path + '.media'));
    assert.ok(existsSync(path.join(mediaBackup.path + '.media', ...first.storageKey.split('/'))));
    rmSync(firstFile, { force: true });
    assert.equal(existsSync(firstFile), false);
    assert.equal(backend.productMediaStorage.restoreFrom(mediaBackup.path + '.media'), true);
    assert.ok(existsSync(firstFile));

    // Switching the main image must leave exactly one active primary image.
    const selectedPrimary = backend.setPrimaryProductImage({ token: adminToken, imageId: second.id });
    assert.equal(selectedPrimary.isPrimary, true);
    assert.equal(
      runtime.database.prepare(
        'SELECT COUNT(*) AS count FROM product_images WHERE tenant_id = ? AND product_id = ? AND is_primary = 1 AND is_deleted = 0'
      ).get(product.tenantId || 'tenant_main', product.id).count,
      1
    );

    // Deleting the current primary automatically promotes the next active image.
    backend.deleteProductImage({ token: adminToken, imageId: second.id });
    const remaining = backend.getProductImages({ token: adminToken, productId: product.id });
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, first.id);
    assert.equal(remaining[0].isPrimary, true);
    assert.equal(backend.getProductImageData({ token: adminToken, imageId: second.id, variant: 'original' }), null);
    backend.markProductImageSynced({ token: adminToken, imageId: second.id });

    // A cashier may view inventory but must not attach or alter product images.
    backend.createUser({
      token: adminToken,
      input: {
        username: 'cashier_media',
        fullName: 'كاشير اختبار الصور',
        role: 'CASHIER',
        allowedActivities: ['grocery'],
        branchId: 'branch_main',
        allowedBranches: ['branch_main'],
        plainPassword: 'CashierMedia#2026',
      },
    });
    const cashierToken = auth.authenticate({
      username: 'cashier_media',
      password: 'CashierMedia#2026',
    }).token;
    assert.equal(backend.getProductImages({ token: cashierToken, productId: product.id }).length, 1);
    assert.throws(() => backend.addProductImage({
      token: cashierToken,
      input: {
        productId: product.id,
        originalDataUrl: PNG_1X1,
        thumbnailDataUrl: PNG_1X1,
        mimeType: 'image/png',
        width: 1,
        height: 1,
      },
    }), /RBAC/);

    const productAfterImages = backend.getProductById({ token: adminToken, id: product.id });

    // Reject MIME spoofing before creating a DB row or file.
    assert.throws(() => backend.addProductImage({
      token: adminToken,
      input: {
        productId: product.id,
        originalDataUrl: PNG_1X1,
        thumbnailDataUrl: PNG_1X1,
        mimeType: 'image/webp',
        width: 1,
        height: 1,
      },
    }), /صيغة الصورة/);

    // A deleted image must be acknowledged by sync before its product can be removed.
    assert.throws(
      () => backend.deleteProductAtomic({ token: adminToken, productId: product.id }),
      /مزامنة حذف جميع صوره/
    );
    assert.ok(backend.getProductById({ token: adminToken, id: product.id }));

    backend.deleteProductImage({ token: adminToken, imageId: first.id });
    assert.equal(backend.getProductImages({ token: adminToken, productId: product.id }).length, 0);
    assert.throws(
      () => backend.deleteProductAtomic({ token: adminToken, productId: product.id }),
      /مزامنة حذف جميع صوره/
    );
    backend.markProductImageSynced({ token: adminToken, imageId: first.id });
    assert.equal(
      runtime.database.prepare('SELECT COUNT(*) AS count FROM product_images WHERE tenant_id = ? AND product_id = ?')
        .get('tenant_main', product.id).count,
      0
    );
    backend.deleteProductAtomic({ token: adminToken, productId: product.id });
    assert.equal(backend.getProductById({ token: adminToken, id: product.id }), undefined);

    assert.equal(productAfterImages.currentStock, productBeforeImages.currentStock);
    assert.equal(productAfterImages.purchasePrice, productBeforeImages.purchasePrice);
    assert.equal(productAfterImages.sellPrice, productBeforeImages.sellPrice);
    assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, accountCountBefore);
    assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM journal_entries').get().count, journalCountBefore);
    assert.ok(runtime.database.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count > auditCountBefore);
    assert.ok(runtime.database.prepare(
      "SELECT COUNT(*) AS count FROM outbox_queue WHERE entity_type = 'PRODUCT_IMAGE'"
    ).get().count >= 3);

    runtime.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
