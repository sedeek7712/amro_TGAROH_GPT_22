/**
 * PVAR-003 product baseline tests for the Dexie / IndexedDB provider.
 * Synthetic products have zero opening stock to avoid creating inventory JVs.
 */
import 'fake-indexeddb/auto';

if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage) {
  const store: Record<string, string> = {};
  const mockStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = String(value); },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { for (const key in store) delete store[key]; },
    key: (index: number) => Object.keys(store)[index] ?? null,
    get length() { return Object.keys(store).length; },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true });
}

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/erpDatabase';
import { dexieDataService } from '../services/dexieDataService';
import { authService, hashPassword } from '../services/authService';
import type { Product } from '../types/erp';

const fixtures: Product[] = [
  {
    id: 'pvar003-dexie-pharmacy', activityId: 'pharmacy', code: 'PVAR-DX-PH',
    barcode: '6290000002001', nameAr: 'منتج صيدلية تجريبي', category: 'PVAR-003',
    unit: 'علبة', purchasePrice: 10, sellPrice: 14, currentStock: 0, minStockAlert: 0,
    trackExpiry: true, scientificName: 'Syntheticus', dosageForm: 'أقراص',
  },
  {
    id: 'pvar003-dexie-grocery', activityId: 'grocery', code: 'PVAR-DX-GR',
    barcode: '6290000002002', nameAr: 'منتج بقالة تجريبي', category: 'PVAR-003',
    unit: 'قطعة', purchasePrice: 2, sellPrice: 3, currentStock: 0, minStockAlert: 0,
  },
  {
    id: 'pvar003-dexie-bike', activityId: 'bike_parts', code: 'PVAR-DX-BK',
    barcode: '6290000002003', nameAr: 'قطعة دراجة تجريبية', category: 'PVAR-003',
    unit: 'قطعة', purchasePrice: 20, sellPrice: 28, currentStock: 0, minStockAlert: 0,
    oemNumber: 'PVAR-OEM', manufacturer: 'Synthetic Parts', compatibleModels: 'TEST-MODEL',
  },
  {
    id: 'pvar003-dexie-equipment', activityId: 'equipment_parts', code: 'PVAR-DX-EQ',
    barcode: '6290000002004', nameAr: 'قطعة معدات تجريبية', category: 'PVAR-003',
    unit: 'قطعة', purchasePrice: 30, sellPrice: 42, currentStock: 0, minStockAlert: 0,
    equipmentType: 'معدات تجريبية', serialNumber: 'PVAR-SERIAL',
  },
];

before(async () => {
  localStorage.clear();
  authService.logout();
  dexieDataService.resetForTests();
  await db.invoices.clear();
  await db.journalEntries.clear();
  await db.vouchers.clear();
  await db.products.clear();
  await db.productBatches.clear();
  await db.cashBoxes.clear();
  await db.accounts.clear();
  await db.parties.clear();
  await db.outbox.clear();
  await db.sequences.clear();
  await db.auditLogs.clear();
  await db.users.clear();
  await db.open();
  await dexieDataService.initialize();

  const admin = {
    id: 'usr-pvar003-dexie-admin',
    username: 'pvar003_dexie_admin',
    fullName: 'PVAR-003 Dexie Test Admin',
    role: 'ADMIN' as const,
    allowedActivities: ['pharmacy', 'grocery', 'bike_parts', 'equipment_parts'] as Product['activityId'][],
    branchId: 'branch_main',
    allowedBranches: ['branch_main'],
    tenantId: 'tenant_main',
    active: true,
    passwordHash: await hashPassword('Pvar003-Dexie#2026'),
  };
  await db.users.put(admin);
  const login = await authService.authenticate({
    username: admin.username,
    password: 'Pvar003-Dexie#2026',
    users: [admin],
    onUserUpdated: async (updated) => { await db.users.put(updated); },
  });
  assert.equal(login.success, true);
});

after(async () => {
  authService.logout();
  dexieDataService.resetForTests();
  db.close();
});

test('PVAR-003 Dexie baseline: product create/read/update persists without accounting side effects', async () => {
  const accountsBefore = (await db.accounts.toArray())
    .map(({ code, balance }) => ({ code, balance }));
  const cashBoxesBefore = (await db.cashBoxes.toArray())
    .map(({ id, balance }) => ({ id, balance }));
  const journalEntriesBefore = (await db.journalEntries.toArray())
    .map(({ id, entryNumber, status }) => ({ id, entryNumber, status }));

  for (const fixture of fixtures) {
    const saved = await dexieDataService.saveProductAtomic({ ...fixture }, false);
    assert.equal(saved.id, fixture.id);
    const loaded = await dexieDataService.getProductById(fixture.id);
    assert.equal(loaded?.activityId, fixture.activityId);
    assert.equal(loaded?.barcode, fixture.barcode);
    assert.equal(loaded?.currentStock, 0);
    if (fixture.scientificName) assert.equal(loaded?.scientificName, fixture.scientificName);
    if (fixture.oemNumber) assert.equal(loaded?.oemNumber, fixture.oemNumber);
    if (fixture.equipmentType) assert.equal(loaded?.equipmentType, fixture.equipmentType);
  }

  const grocery = fixtures[1];
  const updated = await dexieDataService.saveProductAtomic({
    ...grocery,
    nameAr: 'منتج بقالة بعد التعديل',
    sellPrice: 3.5,
  }, true);
  assert.equal(updated.nameAr, 'منتج بقالة بعد التعديل');
  assert.equal(updated.sellPrice, 3.5);

  await assert.rejects(
    () => dexieDataService.saveProductAtomic({
      ...grocery,
      id: 'pvar003-dexie-invalid-stock',
      currentStock: -1,
    }, false)
  );
  assert.equal(await db.products.get('pvar003-dexie-invalid-stock'), undefined);

  await db.close();
  await db.open();
  const reopened = await dexieDataService.getProductById(grocery.id);
  assert.equal(reopened?.nameAr, 'منتج بقالة بعد التعديل');

  assert.deepEqual(
    (await db.accounts.toArray()).map(({ code, balance }) => ({ code, balance })),
    accountsBefore
  );
  assert.deepEqual(
    (await db.cashBoxes.toArray()).map(({ id, balance }) => ({ id, balance })),
    cashBoxesBefore
  );
  assert.deepEqual(
    (await db.journalEntries.toArray()).map(({ id, entryNumber, status }) => ({ id, entryNumber, status })),
    journalEntriesBefore
  );
});
