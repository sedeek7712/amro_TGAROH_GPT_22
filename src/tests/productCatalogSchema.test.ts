import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/erpDatabase';

test('PVAR-004A Dexie v9 exposes catalog metadata and alternate unit stores without changing Product rows', async () => {
  try {
    await db.open();
    assert.equal(db.verno, 9);
    assert.ok(db.tables.some((table) => table.name === 'brands'));
    assert.ok(db.tables.some((table) => table.name === 'productFamilies'));
    assert.ok(db.tables.some((table) => table.name === 'productCatalogMeta'));
    assert.ok(db.tables.some((table) => table.name === 'productUnits'));
    await db.productUnits.add({
      id: 'unit-dexie-001',
      tenantId: 'tenant_main',
      productId: 'sku-dexie',
      code: 'BOX',
      nameAr: 'كرتون',
      baseUnitsNumerator: 12,
      baseUnitsDenominator: 1,
      barcode: '0012345000006',
      normalizedBarcode: '0012345000006',
      isActive: true,
      createdAt: '2026-11-28T00:00:00.000Z',
      updatedAt: '2026-11-28T00:00:00.000Z',
    });
    assert.equal((await db.productUnits.get('unit-dexie-001'))?.barcode, '0012345000006');

    await db.brands.add({
      id: 'brand-dexie',
      tenantId: 'tenant_main',
      nameAr: 'علامة تجريبية',
      normalizedName: 'علامة تجريبية',
      isActive: true,
    });
    await db.productFamilies.add({
      id: 'family-dexie',
      tenantId: 'tenant_main',
      activityId: 'grocery',
      nameAr: 'منتج متغير',
      categorySnapshot: 'اختبار',
      brandId: 'brand-dexie',
      optionSchema: [{ key: 'size', labelAr: 'المقاس', values: ['M', 'L'], required: true, sortOrder: 1 }],
      isActive: true,
      createdAt: '2026-11-28T00:00:00.000Z',
      updatedAt: '2026-11-28T00:00:00.000Z',
    });
    await db.productCatalogMeta.add({
      tenantId: 'tenant_main',
      productId: 'sku-dexie',
      familyId: 'family-dexie',
      variantKey: 'size=m',
      variantAttributes: { size: 'M' },
    });

    assert.equal((await db.productCatalogMeta.get(['tenant_main', 'sku-dexie']))?.familyId, 'family-dexie');
    assert.equal(await db.productFamilies.count(), 1);
    assert.equal(await db.brands.count(), 1);
  } finally {
    db.close();
    await db.delete();
  }
});

test('PVAR-004B-1 upgrades an existing Dexie v7 database to v9 without losing legacy products or batches', async () => {
  const legacy = new Dexie('MultiActivityErpDB');
  legacy.version(7).stores({
    activities: 'id, code, costCenterCode',
    accounts: 'code, type, parentCode, isLeaf',
    products: 'id, activityId, code, barcode, oemNumber, category',
    productBatches: 'id, productId, batchNumber, expiryDate',
    parties: 'id, type, nameAr, phone',
    invoices: 'id, invoiceNumber, type, activityId, partyId, date, paymentMethod, branchId',
    journalEntries: 'id, entryNumber, date, status, costCenterId, referenceType, referenceId, branchId',
    cashBoxes: 'id, code, accountCode, branchId',
    vouchers: 'id, voucherNumber, type, date, cashBoxId, partyId, branchId, status',
    amanatRecords: 'id, recordNumber, type, status, depositorName, receivedDate',
    users: 'id, username, role, active, tenantId, branchId',
    auditLogs: 'id, timestamp, userId, action, tenantId, branchId',
    outbox: 'id, tenantId, entityType, entityId, status, createdAt, idempotencyKey, priority, branchId',
    syncConflicts: 'id, tenantId, entityType, entityId, status, detectedAt, branchId',
    branches: 'id, code, isMain, active',
    sequences: 'key',
    paymentAllocations: 'id, tenantId, branchId, voucherId, advanceTransactionId, partyId, invoiceId, status, createdAt',
    partyAdvanceTransactions: 'id, tenantId, branchId, partyId, type, voucherId, invoiceId, date, createdAt',
    allocationAudits: 'id, tenantId, branchId, voucherId, partyId, userId, timestamp',
    productImages: 'id, tenantId, productId, activityId, isPrimary, syncStatus, updatedAt, [tenantId+productId], [tenantId+activityId]',
  });

  try {
    await legacy.open();
    const legacyProduct = {
      id: 'legacy-product-v7',
      activityId: 'grocery',
      code: 'OLD-007',
      nameAr: 'صنف قديم قبل الترقية',
      currentStock: 17,
    };
    const legacyBatch = {
      id: 'legacy-batch-v7',
      productId: legacyProduct.id,
      batchNumber: 'LOT-007',
      quantity: 17,
    };
    await legacy.table('products').add(legacyProduct);
    await legacy.table('productBatches').add(legacyBatch);
    legacy.close();

    await db.open();

    assert.equal(db.verno, 9);
    assert.deepEqual(await db.products.get(legacyProduct.id), legacyProduct);
    assert.deepEqual(await db.productBatches.get(legacyBatch.id), legacyBatch);
    assert.equal(await db.brands.count(), 0);
    assert.equal(await db.productFamilies.count(), 0);
    assert.equal(await db.productCatalogMeta.count(), 0);
    assert.equal(await db.productUnits.count(), 0);
  } finally {
    legacy.close();
    db.close();
    await db.delete();
  }
});
