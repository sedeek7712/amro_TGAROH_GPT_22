import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openErpDatabase } from '../../electron/sqlite/database.mjs';
import { DesktopAuthenticationService } from '../../electron/security/authentication.mjs';
import { createDesktopBackend } from '../../electron/sqlite/desktop-backend.mjs';
import {
  MONEY_SCALE,
  QTY_SCALE,
  divScaledHalfUp,
  formatScaledInt,
  mulScaledHalfUp,
  parseScaledInt,
  toMoneyNumber,
  unitsToNumber,
} from '../../electron/sqlite/money.mjs';

test('money.mjs exact minor-unit arithmetic avoids float drift', () => {
  const a = parseScaledInt('0.10', MONEY_SCALE);
  const b = parseScaledInt('0.20', MONEY_SCALE);
  assert.equal(formatScaledInt(a + b, MONEY_SCALE), '0.30');
  assert.equal(unitsToNumber(a + b, MONEY_SCALE), 0.3);
  assert.equal(toMoneyNumber(0.1 + 0.2), 0.3);
  assert.throws(() => parseScaledInt(a, MONEY_SCALE), /BigInt/);

  const qty = parseScaledInt('1.3335', QTY_SCALE);
  const price = parseScaledInt('12.55', MONEY_SCALE);
  const total = mulScaledHalfUp(qty, price, QTY_SCALE, MONEY_SCALE, MONEY_SCALE);
  // 1.3335 * 12.55 = 16.735425 -> Half-Up to 16.74
  assert.equal(formatScaledInt(total, MONEY_SCALE), '16.74');

  const split = divScaledHalfUp(parseScaledInt('10.00', MONEY_SCALE), parseScaledInt('3', QTY_SCALE), MONEY_SCALE, QTY_SCALE, MONEY_SCALE);
  assert.equal(formatScaledInt(split, MONEY_SCALE), '3.33');
});

test('Batch A backend: initial setup seeding, RBAC, user management, branch isolation, and restart persistence', async () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-batch-a-'));
  try {
    const rt1 = await openErpDatabase({ userDataPath });
    const auth1 = new DesktopAuthenticationService(rt1.database);
    const changes = [];
    const backend1 = createDesktopBackend({
      database: rt1.database,
      backupDirectory: rt1.backupDirectory,
      authenticationService: auth1,
      onDataChanged: (domains) => changes.push(domains),
    });

    assert.deepEqual(auth1.getSetupStatus(), { setupRequired: true, userCount: 0 });
    assert.equal(rt1.database.prepare('SELECT COUNT(*) AS c FROM activities').get().c, 0);

    const setup = auth1.createInitialAdmin({
      username: 'admin',
      fullName: 'المدير العام',
      password: 'AdminPass#2026',
    });
    assert.equal(setup.success, true);

    assert.equal(rt1.database.prepare('SELECT COUNT(*) AS c FROM activities').get().c, 4);
    assert.ok(rt1.database.prepare('SELECT COUNT(*) AS c FROM accounts').get().c >= 20);
    assert.ok(rt1.database.prepare("SELECT 1 FROM accounts WHERE code='1106'").get());
    assert.equal(rt1.database.prepare('SELECT COUNT(*) AS c FROM cash_boxes').get().c, 2);

    const adminLogin = auth1.authenticate({ username: 'admin', password: 'AdminPass#2026' });
    assert.equal(adminLogin.success, true);
    const adminToken = adminLogin.token;

    // Add second branch
    const branch2 = backend1.addBranch({
      token: adminToken,
      branch: { id: 'branch_aden', code: 'AD01', nameAr: 'فرع عدن', isMain: false, active: true },
    });
    assert.equal(branch2.code, 'AD01');

    // Create restricted cashier on branch_main only
    const cashier = backend1.createUser({
      token: adminToken,
      input: {
        username: 'cashier1',
        fullName: 'كاشير الفرع الرئيسي',
        role: 'CASHIER',
        allowedActivities: ['pharmacy'],
        branchId: 'branch_main',
        allowedBranches: ['branch_main'],
        plainPassword: 'Cashier#2026',
      },
    });
    assert.equal(Object.hasOwn(cashier, 'passwordHash'), false);

    // Log in as cashier and verify RBAC & branch isolation
    const cashierLogin = auth1.authenticate({ username: 'cashier1', password: 'Cashier#2026' });
    assert.equal(cashierLogin.success, true);
    const cashierToken = cashierLogin.token;

    assert.throws(
      () => backend1.createAccountAtomic({
        token: cashierToken,
        account: { code: '9999', nameAr: 'حساب مرفوض', type: 'EXPENSE', isLeaf: true, balance: 0 },
      }),
      /RBAC/
    );
    assert.throws(
      () => backend1.getUsers({ token: cashierToken }),
      /RBAC/
    );
    assert.throws(
      () => backend1.setActiveBranchId({ token: cashierToken, branchId: 'branch_aden' }),
      /عزل الفروع/
    );
    assert.throws(
      () => backend1.addBranch({
        token: cashierToken,
        branch: { id: 'branch_x', code: 'BX', nameAr: 'فرع غير مصرح' },
      }),
      /RBAC/
    );

    // Admin creates account, updates company profile, allocates sequences
    const createdAcc = backend1.createAccountAtomic({
      token: adminToken,
      account: { code: '1109', nameAr: 'بنك عدن', type: 'ASSET', parentCode: '11', isLeaf: true, balance: 150.25 },
    });
    assert.equal(createdAcc.balance, 150.25);

    const savedProfile = backend1.saveCompanyProfile({
      token: adminToken,
      profile: {
        nameAr: 'مؤسسة النماري التجارية',
        currencyCode: 'YER',
        currency: 'ريال يمني',
        currencySymbol: 'ر.ي',
        currencyDecimalPlaces: 2,
      },
    });
    assert.equal(savedProfile.currencyCode, 'YER');

    const inv1 = backend1.generateBranchInvoiceNumber({ token: cashierToken, type: 'INV' });
    const inv2 = backend1.generateBranchInvoiceNumber({ token: cashierToken, type: 'INV' });
    assert.match(inv1, /^INV-BR01-POS01-\d{4}-00001$/);
    assert.match(inv2, /^INV-BR01-POS01-\d{4}-00002$/);

    // Protect last active admin from self-deactivation or demotion
    assert.throws(
      () => backend1.saveUserProfile({
        token: adminToken,
        user: { ...setup.user, active: false },
      }),
      /إيقاف حسابك/
    );
    assert.throws(
      () => backend1.saveUserProfile({
        token: adminToken,
        user: { ...setup.user, role: 'CASHIER' },
      }),
      /مدير عام نشط واحد/
    );

    // Admin password reset revokes target user's active session
    backend1.adminResetPassword({
      token: adminToken,
      targetUserId: cashier.id,
      newPassword: 'CashierNew#2026',
    });
    assert.throws(
      () => backend1.getActivities({ token: cashierToken }),
      /انتهت الجلسة/
    );

    // Switch user requires valid admin password
    const badSwitch = backend1.switchUser({
      token: adminToken,
      adminPassword: 'WrongAdminPassword!',
      targetUserId: cashier.id,
    });
    assert.equal(badSwitch.success, false);

    const goodSwitch = backend1.switchUser({
      token: adminToken,
      adminPassword: 'AdminPass#2026',
      targetUserId: cashier.id,
    });
    assert.equal(goodSwitch.success, true);
    assert.equal(goodSwitch.user.username, 'cashier1');
    assert.equal(auth1.getActor(adminToken), null);

    // Verify clean books reset keeps reference data and zeroes balances
    const adminReLogin = auth1.authenticate({ username: 'admin', password: 'AdminPass#2026' });
    backend1.resetToCleanBooks({ token: adminReLogin.token });
    const postResetAccounts = backend1.getAccounts({ token: adminReLogin.token });
    const acc1109 = postResetAccounts.find((a) => a.code === '1109');
    assert.equal(acc1109.balance, 0);
    assert.ok(changes.length > 0);
    rt1.close();

    // Restart DB and confirm persistence across reopen
    const rt2 = await openErpDatabase({ userDataPath });
    const auth2 = new DesktopAuthenticationService(rt2.database);
    const backend2 = createDesktopBackend({
      database: rt2.database,
      backupDirectory: rt2.backupDirectory,
      authenticationService: auth2,
    });
    const login2 = auth2.authenticate({ username: 'admin', password: 'AdminPass#2026' });
    assert.equal(login2.success, true);
    const profile2 = backend2.getCompanyProfile({ token: login2.token });
    assert.equal(profile2.nameAr, 'مؤسسة النماري التجارية');
    assert.equal(profile2.currencyCode, 'YER');
    const branches2 = backend2.getBranches({ token: login2.token });
    assert.equal(branches2.length, 2);
    const inv3 = backend2.generateBranchInvoiceNumber({ token: login2.token, type: 'INV' });
    // After resetToCleanBooks, sequences restarted cleanly from 00001
    assert.match(inv3, /^INV-BR01-POS01-\d{4}-00001$/);
    rt2.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
