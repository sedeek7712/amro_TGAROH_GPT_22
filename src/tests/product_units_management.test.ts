import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/erpDatabase';
import { dexieDataService } from '../services/dexieDataService';
import { authService, hashPassword } from '../services/authService';
import type { Product } from '../types/erp';

if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage) {
  const store: Record<string, string> = {};
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = String(value); },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { for (const key in store) delete store[key]; },
      key: (index: number) => Object.keys(store)[index] ?? null,
      get length() { return Object.keys(store).length; },
    },
    writable: true,
  });
}

test('PVAR-004B-2 Dexie alternate-unit management persists and disables records', async () => {
  try {
    localStorage.clear();
    authService.logout();
    dexieDataService.resetForTests();
    await db.open();
    await dexieDataService.initialize();

    const admin = {
      id: 'pvar004b2-dexie-admin',
      username: 'pvar004b2_dexie_admin',
      fullName: 'PVAR-004B-2 Test Admin',
      role: 'ADMIN' as const,
      allowedActivities: ['grocery'] as Product['activityId'][],
      branchId: 'branch_main',
      allowedBranches: ['branch_main'],
      tenantId: 'tenant_main',
      active: true,
      passwordHash: await hashPassword('Pvar004B2-Dexie#2026'),
    };
    await db.users.put(admin);
    const login = await authService.authenticate({
      username: admin.username,
      password: 'Pvar004B2-Dexie#2026',
      users: [admin],
      onUserUpdated: async (updated) => { await db.users.put(updated); },
    });
    assert.equal(login.success, true);

    const product: Product = {
      id: 'pvar004b2-dexie-product',
      activityId: 'grocery',
      code: 'PVAR004B2-SKU',
      nameAr: 'صنف وحدات تجريبي',
      category: 'اختبار',
      unit: 'حبة',
      purchasePrice: 0,
      sellPrice: 0,
      currentStock: 0,
      minStockAlert: 0,
      isActive: true,
    };
    await db.products.put(product);

    const created = await dexieDataService.saveProductUnit({
      productId: product.id,
      code: 'BOX',
      nameAr: 'كرتون',
      baseUnitsNumerator: 24,
      baseUnitsDenominator: 2,
      barcode: '0001234567890',
    });
    assert.equal(created.baseUnitsNumerator, 12);
    assert.equal(created.baseUnitsDenominator, 1);
    assert.equal(created.barcode, '0001234567890');
    assert.equal((await dexieDataService.getProductUnits(product.id)).length, 1);
    await assert.rejects(
      () => dexieDataService.saveProductAtomic({ ...product, unit: 'كرتون' }, true),
      /لا يمكن تغيير وحدة المخزون الأساسية/
    );

    await assert.rejects(() => dexieDataService.saveProductUnit({
      productId: product.id,
      code: 'BOX',
      nameAr: 'وحدة مكررة',
      baseUnitsNumerator: 24,
      baseUnitsDenominator: 1,
    }));
    await assert.rejects(() => dexieDataService.saveProductUnit({
      productId: product.id,
      code: 'ZERO',
      nameAr: 'صفر',
      baseUnitsNumerator: 0,
      baseUnitsDenominator: 1,
    }));

    const disabled = await dexieDataService.saveProductUnit({ ...created, isActive: false });
    assert.equal(disabled.isActive, false);
    const editedDisabled = await dexieDataService.saveProductUnit({
      id: disabled.id,
      productId: disabled.productId,
      code: disabled.code,
      nameAr: 'كرتون معدل',
      baseUnitsNumerator: disabled.baseUnitsNumerator,
      baseUnitsDenominator: disabled.baseUnitsDenominator,
    });
    assert.equal(editedDisabled.isActive, false, 'editing a disabled unit must not reactivate it implicitly');
    await db.close();
    await db.open();
    assert.equal((await db.productUnits.get(created.id))?.isActive, false);
  } finally {
    authService.logout();
    dexieDataService.resetForTests();
    db.close();
    await db.delete();
  }
});
