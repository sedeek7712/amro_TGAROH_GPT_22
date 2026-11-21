import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openErpDatabase } from '../../electron/sqlite/database.mjs';
import { DesktopAuthenticationService } from '../../electron/security/authentication.mjs';
import { createDesktopBackend } from '../../electron/sqlite/desktop-backend.mjs';

test('Batch B backend: products, product_batches sync, FEFO adjustment, parties, RBAC, and restart persistence', async () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-batch-b-'));
  try {
    const rt1 = await openErpDatabase({ userDataPath });
    const auth1 = new DesktopAuthenticationService(rt1.database);
    const backend1 = createDesktopBackend({
      database: rt1.database,
      backupDirectory: rt1.backupDirectory,
      authenticationService: auth1,
    });

    auth1.createInitialAdmin({
      username: 'admin',
      fullName: 'المدير العام',
      password: 'AdminPass#2026',
    });
    const adminToken = auth1.authenticate({ username: 'admin', password: 'AdminPass#2026' }).token;

    const keeper = backend1.createUser({
      token: adminToken,
      input: {
        username: 'keeper1',
        fullName: 'أمين المخزن',
        role: 'INVENTORY_KEEPER',
        allowedActivities: ['pharmacy', 'grocery'],
        branchId: 'branch_main',
        allowedBranches: ['branch_main'],
        plainPassword: 'Keeper#2026',
      },
    });
    assert.ok(keeper.id);
    const keeperToken = auth1.authenticate({ username: 'keeper1', password: 'Keeper#2026' }).token;

    const cashier = backend1.createUser({
      token: adminToken,
      input: {
        username: 'cashier1',
        fullName: 'كاشير',
        role: 'CASHIER',
        allowedActivities: ['pharmacy'],
        branchId: 'branch_main',
        allowedBranches: ['branch_main'],
        plainPassword: 'Cashier#2026',
      },
    });
    assert.ok(cashier.id);
    const cashierToken = auth1.authenticate({ username: 'cashier1', password: 'Cashier#2026' }).token;

    // 1. Reject inconsistent batch stock sum
    assert.throws(
      () => backend1.saveProductAtomic({
        token: keeperToken,
        product: {
          id: 'prod-bad',
          activityId: 'pharmacy',
          code: 'MED-BAD',
          nameAr: 'دواء متعارض',
          category: 'مسكنات',
          unit: 'علبة',
          purchasePrice: 10,
          sellPrice: 15,
          currentStock: 99,
          minStockAlert: 5,
          trackExpiry: true,
          batches: [
            { id: 'b-1', productId: 'prod-bad', batchNumber: 'B1', expiryDate: '2027-06-01', quantity: 5, costPrice: 10 },
          ],
        },
      }),
      /تعارض كميات الصنف/
    );

    // 2. Save valid product with two expiry batches -> syncs both products & product_batches tables
    const savedProd = backend1.saveProductAtomic({
      token: keeperToken,
      product: {
        id: 'prod-1',
        activityId: 'pharmacy',
        code: 'MED-0001',
        nameAr: 'باراسيتامول 500 ملغ',
        category: 'مسكنات',
        unit: 'علبة',
        purchasePrice: 12.5,
        sellPrice: 18.75,
        currentStock: 0,
        minStockAlert: 3,
        trackExpiry: true,
        batches: [
          { id: 'batch-later', productId: 'prod-1', batchNumber: 'B-LATER', expiryDate: '2028-01-01', quantity: 10, costPrice: 12.5 },
          { id: 'batch-soon', productId: 'prod-1', batchNumber: 'B-SOON', expiryDate: '2027-02-01', quantity: 5, costPrice: 12.0 },
        ],
      },
    });
    assert.equal(savedProd.currentStock, 15);
    assert.equal(rt1.database.prepare('SELECT COUNT(*) AS c FROM product_batches WHERE product_id = ?').get('prod-1').c, 2);

    // 3. FEFO negative adjustment deducts B-SOON first
    const adj1 = backend1.adjustProductStockAtomic({
      token: keeperToken,
      params: { productId: 'prod-1', deltaQuantity: -6, reason: 'جرد وتلف تشغيلة قريبة' },
    });
    assert.equal(adj1.currentStock, 9);
    const soonAfter = adj1.batches.find((b) => b.batchNumber === 'B-SOON');
    const laterAfter = adj1.batches.find((b) => b.batchNumber === 'B-LATER');
    assert.equal(soonAfter.quantity, 0);
    assert.equal(laterAfter.quantity, 9);

    // 4. Over-deduction rejected and rolled back cleanly
    assert.throws(
      () => backend1.adjustProductStockAtomic({
        token: keeperToken,
        params: { productId: 'prod-1', deltaQuantity: -100, reason: 'خصم زائد' },
      }),
      /أقل من كمية الخصم/
    );
    assert.equal(backend1.getProductById({ token: keeperToken, id: 'prod-1' }).currentStock, 9);

    // 5. Positive adjustment on expiry-tracked product requires batch & expiry
    assert.throws(
      () => backend1.adjustProductStockAtomic({
        token: keeperToken,
        params: { productId: 'prod-1', deltaQuantity: 2, reason: 'زيادة بدون تشغيلة' },
      }),
      /تحديد رقم تشغيلة وتاريخ صلاحية/
    );
    const adj2 = backend1.adjustProductStockAtomic({
      token: keeperToken,
      params: { productId: 'prod-1', deltaQuantity: 2.5, reason: 'استلام زيادة جردية', batchNumber: 'B-NEW', expiryDate: '2028-05-15' },
    });
    assert.equal(adj2.currentStock, 11.5);
    assert.equal(adj2.batches.length, 3);

    // 6. RBAC checks: CASHIER cannot write products or parties; INVENTORY_KEEPER cannot delete products
    assert.throws(
      () => backend1.saveProductAtomic({
        token: cashierToken,
        product: { id: 'p2', activityId: 'pharmacy', code: 'P2', nameAr: 'ممنوع', category: '', unit: 'حبة', purchasePrice: 1, sellPrice: 2, currentStock: 1, minStockAlert: 0 },
      }),
      /RBAC/
    );
    assert.throws(
      () => backend1.deleteProductAtomic({ token: keeperToken, productId: 'prod-1' }),
      /RBAC/
    );

    // 7. Parties create & update preserves balance
    const cust = backend1.savePartyAtomic({
      token: adminToken,
      party: { id: 'cust-1', type: 'CUSTOMER', nameAr: 'صيدلية الشفاء', phone: '777111222', balance: 50 },
    });
    assert.equal(cust.balance, 50);
    const custEdited = backend1.savePartyAtomic({
      token: adminToken,
      party: { id: 'cust-1', type: 'CUSTOMER', nameAr: 'صيدلية الشفاء الحديثة', phone: '777111999', balance: 99999 },
      isUpdate: true,
    });
    // Direct savePartyAtomic update does NOT allow overwriting audited balance
    assert.equal(custEdited.balance, 50);
    assert.equal(custEdited.nameAr, 'صيدلية الشفاء الحديثة');

    assert.throws(
      () => backend1.savePartyAtomic({
        token: cashierToken,
        party: { id: 'cust-2', type: 'CUSTOMER', nameAr: 'عميل مرفوض', phone: '', balance: 0 },
      }),
      /RBAC/
    );

    // 8. Non-referenced temp product can be deleted by admin cleanly (including its batches)
    backend1.saveProductAtomic({
      token: adminToken,
      product: {
        id: 'prod-temp',
        activityId: 'grocery',
        code: 'GRO-TEMP',
        nameAr: 'صنف مؤقت',
        category: 'عام',
        unit: 'حبة',
        purchasePrice: 5,
        sellPrice: 7,
        currentStock: 0,
        minStockAlert: 1,
        batches: [{ id: 'bt-1', productId: 'prod-temp', batchNumber: 'GT-1', expiryDate: '2027-01-01', quantity: 4, costPrice: 5 }],
      },
    });
    backend1.deleteProductAtomic({ token: adminToken, productId: 'prod-temp' });
    assert.equal(backend1.getProductById({ token: adminToken, id: 'prod-temp' }), undefined);
    assert.equal(rt1.database.prepare('SELECT COUNT(*) AS c FROM product_batches WHERE product_id = ?').get('prod-temp').c, 0);

    rt1.close();

    // 9. Reopen DB and verify full persistence
    const rt2 = await openErpDatabase({ userDataPath });
    const auth2 = new DesktopAuthenticationService(rt2.database);
    const backend2 = createDesktopBackend({
      database: rt2.database,
      backupDirectory: rt2.backupDirectory,
      authenticationService: auth2,
    });
    const adminToken2 = auth2.authenticate({ username: 'admin', password: 'AdminPass#2026' }).token;
    const loadedProd = backend2.getProductById({ token: adminToken2, id: 'prod-1' });
    assert.equal(loadedProd.currentStock, 11.5);
    assert.equal(loadedProd.batches.length, 3);
    const loadedCust = backend2.getPartyById({ token: adminToken2, id: 'cust-1' });
    assert.equal(loadedCust.balance, 50);
    assert.equal(loadedCust.nameAr, 'صيدلية الشفاء الحديثة');
    rt2.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
