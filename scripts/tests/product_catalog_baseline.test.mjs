import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openErpDatabase } from '../../electron/sqlite/database.mjs';
import { DesktopAuthenticationService } from '../../electron/security/authentication.mjs';
import { createDesktopBackend } from '../../electron/sqlite/desktop-backend.mjs';
import { PRODUCT_CATALOG_BASELINE_FIXTURES } from './fixtures/product-catalog-baseline.fixtures.mjs';

async function createRuntime(userDataPath, createAdmin = true) {
  const rt = await openErpDatabase({ userDataPath });
  const auth = new DesktopAuthenticationService(rt.database);
  const backend = createDesktopBackend({
    database: rt.database,
    backupDirectory: rt.backupDirectory,
    authenticationService: auth,
  });

  if (createAdmin) {
    auth.createInitialAdmin({
      username: 'pvar003_admin',
      fullName: 'PVAR-003 Test Admin',
      password: 'Pvar003-Test#2026',
    });
  }
  const token = auth.authenticate({
    username: 'pvar003_admin',
    password: 'Pvar003-Test#2026',
  }).token;

  return { rt, backend, token };
}

function snapshotAccounting(backend, token) {
  return {
    accounts: backend.getAccounts({ token }).map(({ code, balance }) => ({ code, balance })),
    cashBoxes: backend.getCashBoxes({ token }).map(({ id, balance }) => ({ id, balance })),
    journalEntries: backend.getJournalEntries({ token }).map(({ id, entryNumber, status }) => ({
      id,
      entryNumber,
      status,
    })),
  };
}

test('PVAR-003 SQLite baseline: product create/read/update survives reopen without accounting side effects', async () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-pvar003-products-'));
  let runtime;

  try {
    runtime = await createRuntime(userDataPath);
    const { backend, token } = runtime;
    const accountingBefore = snapshotAccounting(backend, token);

    for (const fixture of PRODUCT_CATALOG_BASELINE_FIXTURES) {
      const saved = backend.saveProductAtomic({
        token,
        product: { ...fixture },
      });
      assert.equal(saved.id, fixture.id);
      assert.equal(saved.activityId, fixture.activityId);

      const loaded = backend.getProductById({ token, id: fixture.id });
      assert.equal(loaded?.code, fixture.code);
      assert.equal(loaded?.barcode, fixture.barcode);
      assert.equal(loaded?.nameAr, fixture.nameAr);
      assert.equal(loaded?.currentStock, 0);

      if (fixture.scientificName) {
        assert.equal(loaded.scientificName, fixture.scientificName);
        assert.equal(loaded.dosageForm, fixture.dosageForm);
      }
      if (fixture.oemNumber) {
        assert.equal(loaded.oemNumber, fixture.oemNumber);
        assert.equal(loaded.manufacturer, fixture.manufacturer);
        assert.equal(loaded.compatibleModels, fixture.compatibleModels);
      }
      if (fixture.equipmentType) {
        assert.equal(loaded.equipmentType, fixture.equipmentType);
        assert.equal(loaded.serialNumber, fixture.serialNumber);
      }
    }

    const updatedFixture = PRODUCT_CATALOG_BASELINE_FIXTURES[1];
    const updated = backend.saveProductAtomic({
      token,
      isUpdate: true,
      product: {
        ...updatedFixture,
        nameAr: 'صنف بقالة اختباري بعد التعديل',
        sellPrice: 3.5,
      },
    });
    assert.equal(updated.nameAr, 'صنف بقالة اختباري بعد التعديل');
    assert.equal(updated.sellPrice, 3.5);

    assert.throws(
      () => backend.saveProductAtomic({
        token,
        product: {
          id: 'pvar003-invalid-product',
          activityId: 'grocery',
          code: '',
          nameAr: '',
          category: 'اختبارات PVAR',
          unit: 'قطعة',
          purchasePrice: 1,
          sellPrice: 2,
          currentStock: 0,
          minStockAlert: 0,
        },
      }),
      /اسم الصنف وكوده والنشاط التجاري حقول مطلوبة/
    );
    assert.equal(backend.getProductById({ token, id: 'pvar003-invalid-product' }), undefined);

    assert.deepEqual(snapshotAccounting(backend, token), accountingBefore);

    const products = backend.getProducts({ token, activityId: 'all' });
    for (const fixture of PRODUCT_CATALOG_BASELINE_FIXTURES) {
      assert.ok(products.some((product) => product.id === fixture.id));
    }

    runtime.rt.close();
    runtime = undefined;

    // Reopen the same isolated SQLite directory and verify persistence.
    runtime = await createRuntime(userDataPath, false);
    const reopened = runtime.backend;
    const reopenedProducts = reopened.getProducts({ token: runtime.token, activityId: 'all' });
    assert.equal(reopenedProducts.length, PRODUCT_CATALOG_BASELINE_FIXTURES.length);
    assert.equal(
      reopened.getProductById({ token: runtime.token, id: updatedFixture.id }).nameAr,
      'صنف بقالة اختباري بعد التعديل'
    );
    assert.deepEqual(snapshotAccounting(reopened, runtime.token), accountingBefore);
  } finally {
    runtime?.rt.close();
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
