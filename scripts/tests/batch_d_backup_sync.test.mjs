import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openErpDatabase, restoreSqliteBackupFile, verifySqliteFile } from '../../electron/sqlite/database.mjs';
import { DesktopAuthenticationService } from '../../electron/security/authentication.mjs';
import { createDesktopBackend } from '../../electron/sqlite/desktop-backend.mjs';
import { importLegacyBackup, legacyChecksum } from '../../electron/sqlite/legacy-backup-importer.mjs';

test('Batch D SQLite backup, native restore + rollback, JSON roundtrip preserving passwords/batches, outbox lease & sync conflicts', async () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-batch-d-'));
  const customBackupDir = mkdtempSync(path.join(os.tmpdir(), 'erp-batch-d-custom-'));
  const externalExportDir = mkdtempSync(path.join(os.tmpdir(), 'erp-batch-d-ext-'));

  try {
    const rt1 = await openErpDatabase({ userDataPath });
    const auth1 = new DesktopAuthenticationService(rt1.database);
    const backend1 = createDesktopBackend({
      database: rt1.database,
      backupDirectory: rt1.backupDirectory,
      authenticationService: auth1,
    });

    const setup = auth1.createInitialAdmin({
      username: 'admin',
      fullName: 'المدير العام',
      password: 'AdminPass#2026',
    });
    assert.equal(setup.success, true);

    const login = auth1.authenticate({ username: 'admin', password: 'AdminPass#2026' });
    assert.equal(login.success, true);
    const token = login.token;

    // Create cashier user & product with batch & cashbox seed
    const cashier = backend1.createUser({
      token,
      input: {
        username: 'cashier_d',
        fullName: 'كاشير النسخ',
        role: 'CASHIER',
        allowedActivities: ['pharmacy'],
        branchId: 'branch_main',
        allowedBranches: ['branch_main'],
        plainPassword: 'CashierD#2026',
      },
    });
    assert.ok(cashier.id);

    const prod = backend1.saveProductAtomic({
      token,
      product: {
        id: 'prod-d-1',
        activityId: 'pharmacy',
        code: 'PD-01',
        nameAr: 'دواء اختبار النسخ',
        category: 'أدوية',
        unit: 'علبة',
        purchasePrice: 10,
        sellPrice: 20,
        currentStock: 0,
        minStockAlert: 1,
        trackExpiry: true,
        batches: [],
      },
      isUpdate: false,
    });
    assert.equal(prod.id, 'prod-d-1');

    // Seed supplier + purchase 10 units @ 10 = 100 (CREDIT)
    const supplier = backend1.savePartyAtomic({
      token,
      party: {
        id: 'sup-d-1',
        type: 'SUPPLIER',
        nameAr: 'مورد النسخ',
        phone: '777000111',
        balance: 0,
      },
      isUpdate: false,
    });

    backend1.createPurchaseInvoiceAtomic({
      token,
      params: {
        clientRequestId: 'pur-d-1',
        invoice: {
          id: 'pur-d-1',
          type: 'PURCHASE',
          activityId: 'pharmacy',
          partyId: supplier.id,
          partyName: supplier.nameAr,
          date: '2026-11-20',
          items: [
            {
              id: 'pi-d-1',
              productId: prod.id,
              productName: prod.nameAr,
              quantity: 10,
              unitPrice: 10,
              discount: 0,
              total: 100,
            },
          ],
          subtotal: 100,
          discount: 0,
          tax: 0,
          total: 100,
          paymentMethod: 'CREDIT',
          paidAmount: 0,
        },
        itemsWithBatches: [
          {
            productId: prod.id,
            quantity: 10,
            costPrice: 10,
            batchNumber: 'BATCH-D1',
            expiryDate: '2027-12-31',
          },
        ],
      },
    });

    // Sell 2 units cash -> cashBox cb-1 balance becomes +40, stock becomes 8
    backend1.createSalesInvoiceAtomic({
      token,
      params: {
        clientRequestId: 'sale-d-before',
        invoice: {
          id: 'sale-d-before',
          type: 'SALE',
          activityId: 'pharmacy',
          partyName: 'عميل نقدي',
          date: '2026-11-20',
          items: [
            {
              id: 'si-d-1',
              productId: prod.id,
              productName: prod.nameAr,
              quantity: 2,
              unitPrice: 20,
              discount: 0,
              total: 40,
            },
          ],
          subtotal: 40,
          discount: 0,
          tax: 0,
          total: 40,
          paymentMethod: 'CASH',
          cashBoxId: 'cb-1',
          paidAmount: 40,
        },
        stockDeductions: [{ productId: prod.id, quantity: 2 }],
      },
    });

    // 1. Backup Settings & Native Backup Creation + Custom Directory Mirroring
    const updatedSettings = backend1.saveBackupSettings({
      token,
      settings: {
        autoBackupOnExit: true,
        autoBackupIntervalHours: 12,
        maxRetainedBackups: 2,
        customBackupDirectory: customBackupDir,
      },
    });
    assert.equal(updatedSettings.maxRetainedBackups, 2);

    const nativeBackup = await backend1.createNativeBackupNow({ token, prefix: 'manual-checkpoint' });
    assert.ok(existsSync(nativeBackup.path));
    assert.ok(nativeBackup.copiedToCustomPath && existsSync(nativeBackup.copiedToCustomPath));
    const verified = verifySqliteFile(nativeBackup.path);
    assert.equal(verified.valid, true);

    const externalPath = path.join(externalExportDir, 'external-copy.sqlite');
    const extRes = await backend1.exportNativeBackupToPath({ token, destinationPath: externalPath });
    assert.ok(existsSync(extRes.path));

    const listedBackups = backend1.listNativeBackups({ token });
    assert.ok(listedBackups.some((b) => b.filename === nativeBackup.filename));

    // Prune auto-exit backups to maxRetainedBackups=2
    await backend1.createNativeBackupNow({ token, prefix: 'auto-exit' });
    await backend1.createNativeBackupNow({ token, prefix: 'auto-exit' });
    await backend1.createNativeBackupNow({ token, prefix: 'auto-exit' });
    const autoExitCount = backend1
      .listNativeBackups({ token })
      .filter((b) => b.location === 'default' && b.filename.startsWith('auto-exit-')).length;
    assert.equal(autoExitCount, 2);

    // 2. JSON Export & Re-import roundtrip preserving productBatches and passwordHash
    const exportedJson = backend1.exportBackupJSON({ token });
    const parsedExport = JSON.parse(exportedJson);
    assert.equal(parsedExport.data.productBatches.length, 1);
    assert.equal(parsedExport.data.users.length, 2);
    assert.equal(Object.hasOwn(parsedExport.data.users[0], 'passwordHash'), false);

    // 3. Mutate state AFTER checkpoint backup, then verify native SQLite restore rolls state back!
    backend1.createSalesInvoiceAtomic({
      token,
      params: {
        clientRequestId: 'sale-d-after',
        invoice: {
          id: 'sale-d-after',
          type: 'SALE',
          activityId: 'pharmacy',
          partyName: 'عميل نقدي',
          date: '2026-11-20',
          items: [
            {
              id: 'si-d-2',
              productId: prod.id,
              productName: prod.nameAr,
              quantity: 3,
              unitPrice: 20,
              discount: 0,
              total: 60,
            },
          ],
          subtotal: 60,
          discount: 0,
          tax: 0,
          total: 60,
          paymentMethod: 'CASH',
          cashBoxId: 'cb-1',
          paidAmount: 60,
        },
        stockDeductions: [{ productId: prod.id, quantity: 3 }],
      },
    });
    assert.equal(backend1.getProductById({ token, id: prod.id }).currentStock, 5);
    assert.equal(backend1.getCashBoxes({ token }).find((c) => c.id === 'cb-1').balance, 100);

    // Reject corrupt sqlite restore BEFORE touching live DB
    const corruptPath = path.join(externalExportDir, 'corrupt.sqlite');
    writeFileSync(corruptPath, 'NOT A VALID SQLITE FILE', 'utf8');
    await assert.rejects(
      () =>
        restoreSqliteBackupFile({
          databasePath: rt1.databasePath,
          backupDirectory: rt1.backupDirectory,
          sourceBackupPath: corruptPath,
          currentDatabase: rt1.database,
          reopenOptions: { userDataPath },
        }),
      /database|SQLite/i
    );

    // Now perform real native SQLite restore from nativeBackup.path
    const restoreRes = await restoreSqliteBackupFile({
      databasePath: rt1.databasePath,
      backupDirectory: rt1.backupDirectory,
      sourceBackupPath: nativeBackup.path,
      currentDatabase: rt1.database,
      reopenOptions: { userDataPath },
    });
    assert.ok(existsSync(restoreRes.safetyBackupPath));

    const rt2 = restoreRes.databaseRuntime;
    const auth2 = new DesktopAuthenticationService(rt2.database);
    const backend2 = createDesktopBackend({
      database: rt2.database,
      backupDirectory: rt2.backupDirectory,
      authenticationService: auth2,
    });

    // Previous token from auth1 is NOT valid on auth2 (forces clean re-login)
    assert.equal(auth2.getActor(token), null);

    // Both admin and cashier credentials survived restore intact
    const relogin = auth2.authenticate({ username: 'admin', password: 'AdminPass#2026' });
    assert.equal(relogin.success, true);
    const cashierRelogin = auth2.authenticate({ username: 'cashier_d', password: 'CashierD#2026' });
    assert.equal(cashierRelogin.success, true);
    const token2 = relogin.token;

    // Verify balances & inventory reverted to exact checkpoint snapshot!
    assert.equal(backend2.getProductById({ token: token2, id: prod.id }).currentStock, 8);
    assert.equal(backend2.getCashBoxes({ token: token2 }).find((c) => c.id === 'cb-1').balance, 40);
    assert.equal(backend2.getInvoices({ token: token2 }).length, 2);

    // Also test JSON import over existing DB preserves passwords!
    const jsonImportRes = await backend2.importBackupJSON({ token: token2, rawJson: exportedJson });
    assert.equal(jsonImportRes.success, true);
    assert.equal(jsonImportRes.rowCounts.productBatches, 1);
    const loginAfterJson = auth2.authenticate({ username: 'cashier_d', password: 'CashierD#2026' });
    assert.equal(loginAfterJson.success, true);

    // 4. Outbox Queue lease, dependency ordering, retry backoff, sync & purge
    // Drain auto-generated items first to test cleanly
    let safetyBreak = 0;
    while (safetyBreak < 20) {
      safetyBreak += 1;
      const batch = backend2.claimReadyToSyncItems({ token: token2, workerId: 'drain', limit: 25, leaseMs: 60000 });
      if (batch.length === 0) break;
      for (const it of batch) {
        backend2.markOutboxSynced({ token: token2, id: it.id, serverTimestamp: '2025-01-01T00:00:00.000Z' });
      }
    }

    const parentItem = backend2.queueOutboxItem({
      token: token2,
      item: {
        entityType: 'PARTY',
        entityId: 'dep-party-1',
        action: 'CREATE',
        branchId: 'branch_main',
        payload: { id: 'dep-party-1', nameAr: 'عميل تزامن' },
      },
    });
    const childItem = backend2.queueOutboxItem({
      token: token2,
      item: {
        entityType: 'INVOICE',
        entityId: 'dep-inv-1',
        action: 'CREATE',
        branchId: 'branch_main',
        dependsOn: ['dep-party-1'],
        payload: { id: 'dep-inv-1', total: 50 },
      },
    });

    // Only parent should be claimed while child depends on unresolved parent
    const firstClaim = backend2.claimReadyToSyncItems({ token: token2, workerId: 'w1', limit: 10, leaseMs: 1200 });
    assert.equal(firstClaim.length, 1);
    assert.equal(firstClaim[0].id, parentItem.id);

    // Pending entity keys must reflect both unresolved items
    const pendingKeys = backend2.getPendingEntityKeys({ token: token2 });
    assert.ok(pendingKeys.includes('PARTY:dep-party-1'));
    assert.ok(pendingKeys.includes('INVOICE:dep-inv-1'));

    // Simulate permanent failure -> FAILED -> retry -> claim -> markSynced
    backend2.markOutboxFailed({ token: token2, id: parentItem.id, errorMessage: 'Simulated conflict', isPermanent: true });
    assert.equal(backend2.getOutboxStats({ token: token2 }).failed >= 1, true);
    assert.equal(backend2.retryFailedItems({ token: token2 }), 1);

    const reclaim = backend2.claimReadyToSyncItems({ token: token2, workerId: 'w2', limit: 10, leaseMs: 60000 });
    assert.equal(reclaim.length, 1);
    assert.equal(reclaim[0].id, parentItem.id);

    // Force lease expiry directly and test recoverStuckSyncingItems
    rt2.database
      .prepare("UPDATE outbox_queue SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?")
      .run(parentItem.id);
    assert.equal(backend2.recoverStuckSyncingItems({ token: token2, leaseTimeoutMinutes: 1 }), 1);

    const claimAfterRecover = backend2.claimReadyToSyncItems({ token: token2, workerId: 'w3', limit: 10 });
    assert.equal(claimAfterRecover[0].id, parentItem.id);
    backend2.markOutboxSynced({ token: token2, id: parentItem.id, serverTimestamp: '2025-01-01T00:00:00.000Z' });

    // Now childItem is unblocked!
    const childClaim = backend2.claimReadyToSyncItems({ token: token2, workerId: 'w3', limit: 10 });
    assert.equal(childClaim.length, 1);
    assert.equal(childClaim[0].id, childItem.id);
    backend2.markOutboxSynced({ token: token2, id: childItem.id, serverTimestamp: '2025-01-01T00:00:00.000Z' });

    const purged = backend2.purgeOldSyncedRecords({ token: token2, olderThanDays: 30 });
    assert.ok(purged >= 2);

    // 5. Sync conflicts & applyRemoteEntity (with immutable delete guard)
    const conflict = backend2.recordConflict({
      token: token2,
      params: {
        branchId: 'branch_main',
        entityType: 'INVOICE',
        entityId: 'inv-conflict-1',
        localPayload: { total: 40 },
        remotePayload: { total: 45 },
        notes: 'تعارض اختبار',
      },
    });
    assert.equal(conflict.status, 'PENDING_REVIEW');
    backend2.resolveConflict({ token: token2, conflictId: conflict.id, status: 'RESOLVED_LOCAL', notes: 'تم الاعتماد' });
    const conflicts = backend2.getConflicts({ token: token2 });
    assert.equal(conflicts.find((c) => c.id === conflict.id).status, 'RESOLVED_LOCAL');

    assert.throws(
      () =>
        backend2.applyRemoteEntity({
          token: token2,
          entityType: 'INVOICE',
          row: { id: 'inv-x', is_deleted: true },
        }),
      /ممنوع حذف السجل المالي/
    );

    backend2.applyRemoteEntity({
      token: token2,
      entityType: 'PRODUCT',
      row: {
        id: 'prod-remote-1',
        activity_id: 'grocery',
        code: 'REM-1',
        name_ar: 'صنف سحابي',
        unit: 'حبه',
        cost_price: 5,
        selling_price: 8,
        stock_quantity: 12,
        batches_data: [{ id: 'batch-rem-1', batchNumber: 'BR-1', expiryDate: '2028-01-01', quantity: 12, costPrice: 5 }],
      },
    });
    const syncedProd = backend2.getProductById({ token: token2, id: 'prod-remote-1' });
    assert.equal(syncedProd.currentStock, 12);
    assert.equal(syncedProd.batches.length, 1);

    // 6. SYNC-01 parity: applyRemoteEntity Pull for PAYMENT_ALLOCATION, PARTY_ADVANCE, ALLOCATION_AUDIT
    backend2.applyRemoteEntity({
      token: token2,
      entityType: 'PAYMENT_ALLOCATION',
      row: {
        id: 'alloc-rem-1',
        branch_id: 'branch_main',
        voucher_id: null,
        advance_transaction_id: 'adv-rem-1',
        party_id: supplier.id,
        invoice_id: 'pur-d-1',
        allocated_amount: 40,
        allocation_method: 'MANUAL',
        status: 'ACTIVE',
        created_at: '2026-11-22T10:00:00.000Z',
        created_by: 'admin',
        payload_data: { overrideReason: 'سحب سحابي' },
      },
    });
    const pulledAllocs = backend2.getPaymentAllocations({ token: token2, partyId: supplier.id });
    assert.ok(pulledAllocs.some((a) => a.id === 'alloc-rem-1' && a.allocatedAmount === 40));

    backend2.applyRemoteEntity({
      token: token2,
      entityType: 'PARTY_ADVANCE',
      row: {
        id: 'adv-rem-1',
        branch_id: 'branch_main',
        party_id: supplier.id,
        party_type: 'SUPPLIER',
        tx_type: 'OVERPAYMENT_DEPOSIT',
        amount: 40,
        balance_after: 40,
        tx_date: '2026-11-22',
        created_at: '2026-11-22T09:55:00.000Z',
      },
    });
    const pulledAdvs = backend2.getPartyAdvanceTransactions({ token: token2, partyId: supplier.id });
    assert.ok(pulledAdvs.some((a) => a.id === 'adv-rem-1' && a.amount === 40));

    backend2.applyRemoteEntity({
      token: token2,
      entityType: 'ALLOCATION_AUDIT',
      row: {
        id: 'aud-rem-1',
        branch_id: 'branch_main',
        voucher_id: 'v-rem-1',
        party_id: supplier.id,
        user_id: 'admin',
        user_name: 'المدير العام',
        audit_timestamp: '2026-11-22T10:01:00.000Z',
        action: 'OVERRIDE',
        reason: 'اختبار سحب تدقيق التخصيص',
      },
    });
    const pulledAudits = backend2.getAllocationAudits({ token: token2, voucherId: 'v-rem-1' });
    assert.ok(pulledAudits.some((a) => a.id === 'aud-rem-1' && a.voucherId === 'v-rem-1'));

    rt2.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
    rmSync(customBackupDir, { recursive: true, force: true });
    rmSync(externalExportDir, { recursive: true, force: true });
  }
});

test('BKP-01: SQLite importLegacyBackup handles older v2.0 JSON backups omitting optional tables/fields', async () => {
  const legacyDir = mkdtempSync(path.join(os.tmpdir(), 'erp-bkp01-'));
  let runtime = null;
  try {
    runtime = await openErpDatabase({ userDataPath: legacyDir });
    const legacyData = {
      accounts: [
        { code: '1101', nameAr: 'الصندوق', type: 'ASSET', parentCode: null, isLeaf: true, balance: 500 },
      ],
      products: [
        {
          id: 'old-p-1',
          activityId: 'pharmacy',
          code: 'OLD-1',
          nameAr: 'دواء قديم',
          category: 'أدوية',
          unit: 'علبة',
          purchasePrice: 10,
          sellPrice: 20,
          currentStock: 5,
          minStockAlert: 1,
          batches: [
            { id: 'old-b-1', productId: 'old-p-1', batchNumber: 'OB1', expiryDate: '2028-01-01', quantity: 5, costPrice: 10 },
          ],
        },
      ],
      parties: [
        { id: 'old-c-1', type: 'CUSTOMER', nameAr: 'عميل قديم', phone: '700', balance: 100 },
      ],
      invoices: [
        {
          id: 'old-inv-1',
          invoiceNumber: 'INV-OLD-1',
          type: 'SALE',
          activityId: 'pharmacy',
          partyId: 'old-c-1',
          partyName: 'عميل قديم',
          date: '2026-09-01',
          items: [],
          total: 100,
          paidAmount: 0,
          paymentMethod: 'CREDIT',
        },
      ],
      journalEntries: [],
      cashBoxes: [
        { id: 'cb-old', code: 'CB-1', nameAr: 'الصندوق', accountCode: '1101', balance: 500, branchId: 'branch_main' },
      ],
      vouchers: [],
      users: [
        {
          id: 'u-old-admin',
          username: 'oldadmin',
          fullName: 'مدير قديم',
          role: 'ADMIN',
          branchId: 'branch_main',
          active: true,
        },
      ],
    };
    const raw = JSON.stringify({
      systemIdentifier: 'multi_activity_erp',
      version: '2.0.0',
      exportedAt: '2026-09-01T00:00:00.000Z',
      checksum: legacyChecksum(legacyData),
      data: legacyData,
    });
    const res = await importLegacyBackup(runtime.database, runtime.backupDirectory, raw);
    assert.equal(res.success, true);
    assert.equal(res.rowCounts.activities, 4);
    assert.equal(res.rowCounts.productBatches, 1);
    assert.equal(res.rowCounts.branches, 1);
    assert.equal(res.financialTotals.invoiceTotal, '100.000000');
  } finally {
    if (runtime) runtime.close();
    rmSync(legacyDir, { recursive: true, force: true });
  }
});
