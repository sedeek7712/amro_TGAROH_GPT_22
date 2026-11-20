import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openErpDatabase } from '../electron/sqlite/database.mjs';
import {
  DesktopAuthenticationService,
  hashPasswordForDesktop,
  verifyDesktopPassword,
} from '../electron/security/authentication.mjs';

const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-sqlite-auth-'));
let now = Date.parse('2026-11-20T00:00:00.000Z');

try {
  const runtime = await openErpDatabase({ userDataPath });
  const auth = new DesktopAuthenticationService(runtime.database, { now: () => now });

  // Existing Dexie first-run state: the default admin row exists without a password.
  runtime.database.prepare(
    'INSERT INTO users (tenant_id,id,branch_id,username,role,active,password_hash,data_json) VALUES (?,?,?,?,?,?,?,?)'
  ).run('tenant_main','user-admin','branch_main','admin','ADMIN',1,null,
        JSON.stringify({
          id:'user-admin',tenantId:'tenant_main',username:'admin',
          fullName:'المدير الأول',role:'ADMIN',branchId:'branch_main',
          allowedBranches:['branch_main'],allowedActivities:['pharmacy'],
          active:true,mustChangePassword:true
        }));

  assert.equal(auth.getSetupStatus().setupRequired, true);
  assert.throws(
    () => auth.createInitialAdmin({username:'admin',fullName:'مدير النظام',password:'admin123'}),
    /ضعيفة/
  );
  const setup = auth.createInitialAdmin({
    username: 'admin',
    fullName: 'مدير النظام',
    password: 'SecurePass#2026',
  });
  assert.equal(setup.success, true);
  assert.equal(setup.user.id, 'user-admin');
  assert.equal(setup.user.role, 'ADMIN');
  assert.equal(Object.hasOwn(setup.user, 'passwordHash'), false);
  assert.equal(auth.getSetupStatus().setupRequired, false);
  assert.throws(
    () => auth.createInitialAdmin({username:'otheradmin',fullName:'مدير ثان',password:'SecurePass#2027'}),
    /بالفعل/
  );

  const storedHash = runtime.database.prepare(
    'SELECT password_hash FROM users WHERE username = ?'
  ).get('admin').password_hash;
  assert.equal(verifyDesktopPassword('SecurePass#2026', storedHash), true);
  assert.equal(verifyDesktopPassword('WrongPass#2026', storedHash), false);
  assert.equal(verifyDesktopPassword('SecurePass#2026', hashPasswordForDesktop('SecurePass#2026')), true);

  const login = auth.authenticate({username:'ADMIN',password:'SecurePass#2026'});
  assert.equal(login.success, true);
  assert.ok(login.token);
  const actor = auth.getActor(login.token, 'branch_main');
  assert.equal(actor.username, 'admin');
  assert.equal(actor.role, 'ADMIN');
  assert.equal(actor.tenantId, 'tenant_main');
  assert.equal(Object.hasOwn(actor, 'passwordHash'), false);

  // Forced password change receives a limited token, never a business actor.
  const cashier = {
    id:'user-cashier',tenantId:'tenant_main',username:'cashier',
    fullName:'أمين نقطة البيع',role:'CASHIER',branchId:'branch_main',
    allowedBranches:['branch_main'],allowedActivities:['pharmacy'],
    active:true,mustChangePassword:true,failedLoginAttempts:0
  };
  runtime.database.prepare(
    'INSERT INTO users (tenant_id,id,branch_id,username,role,active,password_hash,data_json) VALUES (?,?,?,?,?,?,?,?)'
  ).run('tenant_main',cashier.id,cashier.branchId,cashier.username,cashier.role,1,
        hashPasswordForDesktop('TempPass#2026'),JSON.stringify(cashier));
  const forced = auth.authenticate({username:'cashier',password:'TempPass#2026'});
  assert.equal(forced.success, true);
  assert.equal(forced.mustChangePassword, true);
  assert.equal(auth.getActor(forced.token), null);
  const completed = auth.completeMandatoryPasswordChange({
    token:forced.token,newPassword:'NewPass#2026'
  });
  assert.equal(completed.success, true);
  const cashierActor = auth.getActor(completed.token);
  assert.equal(cashierActor.username, 'cashier');
  assert.equal(cashierActor.mustChangePassword, false);

  auth.logout(login.token);
  assert.equal(auth.getActor(login.token), null);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = auth.authenticate({username:'admin',password:'BadPassword#2026'});
    assert.equal(failed.success, false);
  }
  const locked = auth.authenticate({username:'admin',password:'SecurePass#2026'});
  assert.equal(locked.success, false);
  assert.ok(locked.lockedUntil);

  now += 5 * 60 * 1000 + 1;
  const unlocked = auth.authenticate({username:'admin',password:'SecurePass#2026'});
  assert.equal(unlocked.success, true);
  assert.ok(unlocked.token);

  runtime.database.prepare(
    'UPDATE users SET active=0 WHERE tenant_id=? AND username=?'
  ).run('tenant_main','admin');
  assert.equal(auth.getActor(unlocked.token), null);
  runtime.close();

  console.log('PASS: PBKDF2 compatibility, legacy admin setup, limited password-change token, lockout and revocation');
} finally {
  rmSync(userDataPath, { recursive: true, force: true });
}
