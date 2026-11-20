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

  console.log('PASS: desktop PBKDF2 compatibility, setup, login, lockout, token and revocation');
} finally {
  rmSync(userDataPath, { recursive: true, force: true });
}
