import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { openErpDatabase, createSqliteBackup } from '../../electron/sqlite/database.mjs';
import { createDiagnosticLogger } from '../../electron/logging/diagnostic-logger.mjs';
import { DesktopAuthenticationService, verifyDesktopPassword } from '../../electron/security/authentication.mjs';
import { createBackupSyncService, pruneAutoBackups } from '../../electron/sqlite/modules/backup-sync-service.mjs';
import { createDesktopBackend } from '../../electron/sqlite/desktop-backend.mjs';
import { importLegacyBackup, legacyChecksum } from '../../electron/sqlite/legacy-backup-importer.mjs';

function makeTempDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function makeWebCryptoCompatibleHash(password, iterations = 100_000) {
  const salt = randomBytes(16);
  const derived = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  return `pbkdf2_sha256$${iterations}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

test('DiagnosticLogger redacts secrets, rotates logs cleanly, and exports report', () => {
  const dir = makeTempDir('amro-diag-test-');
  try {
    const logger = createDiagnosticLogger({
      logDirectory: dir,
      maxBytes: 4096,
      maxArchives: 2,
    });

    logger.log('ERROR', 'auth', 'Failed request with Bearer eyJhbGciOiJIUzI1NiJ9.secret and Token abc123', {
      password: 'MySuperSecretPassword1!',
      passwordHash: makeWebCryptoCompatibleHash('MySuperSecretPassword1!'),
      apiToken: 'tok_live_secret_xyz',
      safeField: 'branch_main',
    });

    // Write enough lines to force rotation
    for (let i = 0; i < 60; i += 1) {
      logger.log('INFO', 'backup', `Backup heartbeat iteration ${i} padding=${'x'.repeat(80)}`);
    }

    assert.equal(existsSync(logger.getLogFilePath()), true);
    assert.equal(existsSync(`${logger.getLogFilePath()}.1`), true);

    const recent = logger.readRecentEntries({ maxLines: 200 });
    assert.ok(recent.entries.length > 0);

    const reportPath = path.join(dir, 'exported-report.json');
    const exportResult = logger.exportDiagnosticsReport(reportPath, {
      appVersion: '1.0.0',
      token: 'should-be-redacted',
    });
    assert.equal(existsSync(exportResult.path), true);
    const rawReport = readFileSync(exportResult.path, 'utf8');
    assert.ok(!rawReport.includes('MySuperSecretPassword1!'));
    assert.ok(!rawReport.includes('tok_live_secret_xyz'));
    assert.ok(!rawReport.includes('should-be-redacted'));
    assert.ok(!rawReport.includes('eyJhbGciOiJIUzI1NiJ9.secret'));
    assert.ok(!rawReport.includes('abc123'));

    // Also verify raw active + rotated files have zero leaked secrets
    const combinedRaw = [
      readFileSync(logger.getLogFilePath(), 'utf8'),
      readFileSync(`${logger.getLogFilePath()}.1`, 'utf8'),
      existsSync(`${logger.getLogFilePath()}.2`) ? readFileSync(`${logger.getLogFilePath()}.2`, 'utf8') : '',
    ].join('\n');
    assert.ok(!combinedRaw.includes('MySuperSecretPassword1!'));
    assert.ok(!combinedRaw.includes('tok_live_secret_xyz'));
    assert.ok(!combinedRaw.includes('pbkdf2_sha256$'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Legacy Web PBKDF2 password hashes verify seamlessly after import into SQLite', async () => {
  const dir = makeTempDir('amro-legacy-auth-');
  let runtime = null;
  try {
    runtime = await openErpDatabase({ userDataPath: dir });
    const legacyAdminPass = 'LegacyAdmin#2026';
    const legacyCashierPass = 'CashierPass#99';
    const adminHash = makeWebCryptoCompatibleHash(legacyAdminPass, 100_000);
    const cashierHash = makeWebCryptoCompatibleHash(legacyCashierPass, 50_000);

    assert.equal(verifyDesktopPassword(legacyAdminPass, adminHash), true);
    assert.equal(verifyDesktopPassword(legacyCashierPass, cashierHash), true);

    const dataSection = {
        branches: [
          {
            id: 'branch_main',
            tenantId: 'tenant_main',
            code: 'BR01',
            nameAr: 'الفرع الرئيسي',
            isMain: true,
            active: true,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        accounts: [
          { code: '1101', nameAr: 'الصندوق', type: 'ASSET', isLeaf: true, balance: 0 },
        ],
        activities: [],
        products: [],
        productBatches: [],
        parties: [],
        invoices: [],
        journalEntries: [],
        cashBoxes: [],
        vouchers: [],
        amanat: [],
        users: [
          {
            id: 'u-admin-1',
            tenantId: 'tenant_main',
            username: 'legacyadmin',
            fullName: 'المدير المرحل',
            role: 'ADMIN',
            branchId: 'branch_main',
            allowedBranches: ['branch_main'],
            allowedActivities: ['pharmacy'],
            active: true,
            passwordHash: adminHash,
          },
          {
            id: 'u-cashier-1',
            tenantId: 'tenant_main',
            username: 'legacycashier',
            fullName: 'كاشير مرحل',
            role: 'CASHIER',
            branchId: 'branch_main',
            allowedBranches: ['branch_main'],
            allowedActivities: ['pharmacy'],
            active: true,
            passwordHash: cashierHash,
          },
        ],
        auditLogs: [],
        outbox: [],
        syncConflicts: [],
        sequences: [],
      };
    const legacyPayload = {
      systemIdentifier: 'multi_activity_erp',
      version: '2.2.0',
      exportedAt: '2026-11-20T00:00:00.000Z',
      checksum: legacyChecksum(dataSection),
      data: dataSection,
    };

    const imported = await importLegacyBackup(runtime.database, runtime.backupDirectory, JSON.stringify(legacyPayload));
    assert.equal(imported.success, true);

    const auth = new DesktopAuthenticationService(runtime.database);
    const setup = auth.getSetupStatus();
    assert.equal(setup.setupRequired, false);
    assert.equal(setup.userCount, 2);

    // Migrated Web admin must authenticate using exact Web PBKDF2 password hash
    const adminLogin = auth.authenticate({ username: 'legacyadmin', password: legacyAdminPass });
    assert.equal(adminLogin.success, true);
    assert.ok(adminLogin.token);

    // Migrated cashier (with custom iteration PBKDF2) must authenticate seamlessly too
    const cashierLogin = auth.authenticate({ username: 'legacycashier', password: legacyCashierPass });
    assert.equal(cashierLogin.success, true);
    assert.ok(cashierLogin.token);
  } finally {
    if (runtime) runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Auto-backup interval setting persists and pruneAutoBackups trims both auto-exit and auto-scheduled backups', async () => {
  const dir = makeTempDir('amro-backup-sched-');
  let runtime = null;
  try {
    runtime = await openErpDatabase({ userDataPath: dir });
    const auth = new DesktopAuthenticationService(runtime.database);
    auth.createInitialAdmin({
      username: 'admin1',
      fullName: 'مدير النظام',
      password: 'StrongPassword#123',
    });
    const login = auth.authenticate({ username: 'admin1', password: 'StrongPassword#123' });
    const backend = createDesktopBackend({
      database: runtime.database,
      backupDirectory: runtime.backupDirectory,
      authenticationService: auth,
    });

    const saved = backend.saveBackupSettings({
      token: login.token,
      settings: {
        autoBackupOnExit: true,
        autoBackupIntervalHours: 6,
        maxRetainedBackups: 2,
      },
    });
    assert.equal(saved.autoBackupIntervalHours, 6);
    assert.equal(saved.maxRetainedBackups, 2);

    const fetched = backend.getBackupSettings({ token: login.token });
    assert.equal(fetched.autoBackupIntervalHours, 6);

    await createSqliteBackup(runtime.database, runtime.backupDirectory, { prefix: 'auto-exit' });
    await createSqliteBackup(runtime.database, runtime.backupDirectory, { prefix: 'auto-scheduled' });
    await createSqliteBackup(runtime.database, runtime.backupDirectory, { prefix: 'auto-scheduled' });
    await createSqliteBackup(runtime.database, runtime.backupDirectory, { prefix: 'manual' });

    const service = createBackupSyncService(runtime.database, runtime.backupDirectory);
    const removed = pruneAutoBackups(runtime.backupDirectory, 2);
    assert.equal(removed, 1);

    const listed = service.listNativeBackups(backend.requireActor(login.token));
    const autoRemaining = listed.filter(
      (b) => b.filename.startsWith('auto-exit-') || b.filename.startsWith('auto-scheduled-')
    );
    const manualRemaining = listed.filter((b) => b.filename.startsWith('manual-'));
    assert.equal(autoRemaining.length, 2);
    assert.equal(manualRemaining.length, 1);
  } finally {
    if (runtime) runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Phase 7 Upgrade: creates pre-migration backup, preserves data across v1->v2 upgrade, rejects downgrade, and rolls back failed v3 upgrade', async () => {
  const dir = makeTempDir('amro-upgrade-test-');
  const migDirV1 = path.join(dir, 'mig_v1');
  const migDirV2 = path.join(dir, 'mig_v2');
  const migDirV3Broken = path.join(dir, 'mig_v3_broken');
  const appDataDir = path.join(dir, 'appData');
  const repoMigrationsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../electron/sqlite/migrations'
  );
  const initialSqlSrc = path.join(repoMigrationsDir, '001_initial.sql');

  for (const d of [migDirV1, migDirV2, migDirV3Broken]) {
    mkdirSync(d, { recursive: true });
    copyFileSync(initialSqlSrc, path.join(d, '001_initial.sql'));
  }
  const v2Sql = 'ALTER TABLE tenants ADD COLUMN upgrade_marker TEXT DEFAULT \'v2_ok\';';
  writeFileSync(path.join(migDirV2, '002_test_upgrade.sql'), v2Sql, 'utf8');
  writeFileSync(path.join(migDirV3Broken, '002_test_upgrade.sql'), v2Sql, 'utf8');
  writeFileSync(
    path.join(migDirV3Broken, '003_broken_upgrade.sql'),
    'SELECT 1; INVALID_SQL_SYNTAX_TRIGGER_ROLLBACK;',
    'utf8'
  );

  let runtime = null;
  try {
    // 1. Initialize v1 DB and create admin + party data
    runtime = await openErpDatabase({ userDataPath: appDataDir, migrationsDirectory: migDirV1 });
    const authV1 = new DesktopAuthenticationService(runtime.database);
    authV1.createInitialAdmin({
      username: 'upgradeadmin',
      fullName: 'مدير الترقية',
      password: 'UpgradePass#2026',
    });
    const loginV1 = authV1.authenticate({ username: 'upgradeadmin', password: 'UpgradePass#2026' });
    assert.equal(loginV1.success, true);
    const backendV1 = createDesktopBackend({
      database: runtime.database,
      backupDirectory: runtime.backupDirectory,
      authenticationService: authV1,
    });
    backendV1.savePartyAtomic({
      token: loginV1.token,
      party: {
        id: 'party-upgrade-1',
        type: 'CUSTOMER',
        nameAr: 'عميل اختبار الترقية',
        phone: '0500000001',
        balance: 250,
      },
      isUpdate: false,
    });
    runtime.close();
    runtime = null;

    // 2. Upgrade v1 -> v2 cleanly
    runtime = await openErpDatabase({ userDataPath: appDataDir, migrationsDirectory: migDirV2 });
    assert.deepEqual(runtime.appliedMigrations, [2]);
    assert.equal(runtime.preMigrationBackups.length, 1);
    assert.equal(existsSync(runtime.preMigrationBackups[0]), true);

    const tenantMarker = runtime.database.prepare('SELECT upgrade_marker FROM tenants WHERE id = ?').get('tenant_main');
    assert.equal(tenantMarker.upgrade_marker, 'v2_ok');

    const authV2 = new DesktopAuthenticationService(runtime.database);
    const loginV2 = authV2.authenticate({ username: 'upgradeadmin', password: 'UpgradePass#2026' });
    assert.equal(loginV2.success, true);
    const backendV2 = createDesktopBackend({
      database: runtime.database,
      backupDirectory: runtime.backupDirectory,
      authenticationService: authV2,
    });
    const preservedParty = backendV2.getPartyById({ token: loginV2.token, id: 'party-upgrade-1' });
    assert.equal(preservedParty?.balance, 250);
    runtime.close();
    runtime = null;

    // 3. Reject older v1 binary opening a v2 DB
    await assert.rejects(
      () => openErpDatabase({ userDataPath: appDataDir, migrationsDirectory: migDirV1 }),
      /Applied SQLite migration file is missing/
    );

    // 4. Failed v3 upgrade rolls back safely to pre-migration v2 backup without data loss
    await assert.rejects(
      () => openErpDatabase({ userDataPath: appDataDir, migrationsDirectory: migDirV3Broken })
    );

    runtime = await openErpDatabase({ userDataPath: appDataDir, migrationsDirectory: migDirV2 });
    const latestVersion = runtime.database.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
    assert.equal(latestVersion.v, 2);
    const authRecovered = new DesktopAuthenticationService(runtime.database);
    const loginRecovered = authRecovered.authenticate({ username: 'upgradeadmin', password: 'UpgradePass#2026' });
    assert.equal(loginRecovered.success, true);
    const backendRecovered = createDesktopBackend({
      database: runtime.database,
      backupDirectory: runtime.backupDirectory,
      authenticationService: authRecovered,
    });
    const recoveredParty = backendRecovered.getPartyById({ token: loginRecovered.token, id: 'party-upgrade-1' });
    assert.equal(recoveredParty?.balance, 250);
  } finally {
    if (runtime) runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
