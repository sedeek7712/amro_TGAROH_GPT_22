import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.join(MODULE_DIR, 'migrations');
const MIGRATION_FILE_PATTERN = /^(\d{3,})_([a-z0-9_]+)\.sql$/i;
const CORE_TABLES = [
  'tenants', 'branches', 'activities', 'accounts', 'products',
  'product_batches', 'parties', 'invoices', 'invoice_items',
  'invoice_stock_deductions', 'journal_entries', 'journal_entry_lines',
  'cash_boxes', 'vouchers', 'amanat_records', 'users', 'audit_logs',
  'outbox_queue', 'sync_conflicts', 'document_sequences', 'legacy_imports',
];
const V2_TABLES = [
  'payment_allocations', 'party_advance_transactions', 'allocation_audits',
];
const V3_TABLES = ['product_images'];
const V4_TABLES = ['brands', 'product_families', 'product_catalog_meta'];

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function readMigrationFiles(migrationsDirectory) {
  const files = readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && MIGRATION_FILE_PATTERN.test(entry.name))
    .map((entry) => {
      const match = entry.name.match(MIGRATION_FILE_PATTERN);
      return {
        version: Number(match[1]),
        name: entry.name.replace(/\.sql$/i, ''),
        filename: entry.name,
        sql: readFileSync(path.join(migrationsDirectory, entry.name), 'utf8'),
      };
    })
    .sort((a, b) => a.version - b.version);

  for (let index = 1; index < files.length; index += 1) {
    if (files[index].version === files[index - 1].version) {
      throw new Error('Duplicate SQLite migration version: ' + files[index].version);
    }
  }
  return files;
}

function integrityCheck(database, label) {
  const result = database.prepare('PRAGMA integrity_check').all();
  if (result.length !== 1 || result[0].integrity_check !== 'ok') {
    throw new Error(label + ' failed SQLite integrity_check');
  }
  const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyErrors.length > 0) {
    throw new Error(label + ' contains foreign-key violations');
  }
}

function tableCounts(database) {
  const tables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all();
  const counts = {};
  for (const row of tables) {
    if (!/^[A-Za-z0-9_]+$/.test(row.name)) {
      throw new Error('Unexpected SQLite table identifier');
    }
    counts[row.name] = database.prepare('SELECT COUNT(*) AS count FROM "' + row.name + '"').get().count;
  }
  return counts;
}

export function verifySqliteFile(filePath, migrationsDirectory = DEFAULT_MIGRATIONS_DIR) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('مسار ملف النسخة الاحتياطية غير صالح.');
  }
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    throw new Error('ملف النسخة الاحتياطية غير موجود: ' + resolved);
  }
  const stat = statSync(resolved);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error('ملف النسخة الاحتياطية فارغ أو غير صالح.');
  }

  let candidateDb;
  try {
    candidateDb = new DatabaseSync(resolved, { readOnly: true, timeout: 5000 });
  } catch (err) {
    throw new Error('الملف المحدد ليس قاعدة بيانات SQLite صالحة: ' + (err?.message || ''));
  }

  try {
    integrityCheck(candidateDb, 'Backup SQLite file');

    const hasTableStmt = candidateDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    );
    if (!hasTableStmt.get('schema_migrations')) {
      throw new Error('النسخة الاحتياطية لا تحتوي جدول schema_migrations المعتمد.');
    }
    for (const tableName of CORE_TABLES) {
      if (!hasTableStmt.get(tableName)) {
        throw new Error('النسخة الاحتياطية تفتقر إلى جدول أساسي: ' + tableName);
      }
    }

    const migrationFiles = readMigrationFiles(migrationsDirectory);
    const byVersion = new Map(migrationFiles.map((m) => [m.version, m]));
    const appliedRows = candidateDb.prepare(
      'SELECT version, name, checksum_sha256 FROM schema_migrations ORDER BY version'
    ).all();
    if (appliedRows.length === 0) {
      throw new Error('النسخة الاحتياطية خالية من سجل الترحيلات.');
    }
    for (const row of appliedRows) {
      const file = byVersion.get(row.version);
      if (!file) {
        throw new Error('النسخة الاحتياطية تتطلب ترحيلاً أحدث غير موجود في هذا الإصدار: ' + row.name);
      }
      if (file.name !== row.name || sha256(file.sql) !== row.checksum_sha256) {
        throw new Error('تعارض checksum للترحيل داخل النسخة الاحتياطية: ' + row.name);
      }
    }

    const schemaVersion = appliedRows[appliedRows.length - 1].version;
    const hasV2PaymentMigration = migrationFiles.some((m) => m.filename === '002_payment_allocations_advances.sql');
    if (schemaVersion >= 2 && hasV2PaymentMigration) {
      for (const tableName of V2_TABLES) {
        if (!hasTableStmt.get(tableName)) {
          throw new Error('النسخة الاحتياطية تفتقر إلى جدول مطور (v2): ' + tableName);
        }
      }
    }

    const hasV3ProductMediaMigration = migrationFiles.some((m) => m.filename === '003_product_images.sql');
    if (schemaVersion >= 3 && hasV3ProductMediaMigration) {
      for (const tableName of V3_TABLES) {
        if (!hasTableStmt.get(tableName)) {
          throw new Error('النسخة الاحتياطية تفتقر إلى جدول صور الأصناف (v3): ' + tableName);
        }
      }
    }

    const hasV4ProductCatalogMigration = migrationFiles.some((m) => m.filename === '004_product_catalog_metadata.sql');
    if (schemaVersion >= 4 && hasV4ProductCatalogMigration) {
      for (const tableName of V4_TABLES) {
        if (!hasTableStmt.get(tableName)) {
          throw new Error('النسخة الاحتياطية تفتقر إلى جدول بيانات كتالوج المنتجات (v4): ' + tableName);
        }
      }
    }

    const counts = tableCounts(candidateDb);
    return {
      valid: true,
      path: resolved,
      sizeBytes: stat.size,
      schemaVersion,
      counts,
    };
  } finally {
    try { candidateDb.close(); } catch {}
  }
}

export function listSqliteBackups(backupDirectory) {
  if (!backupDirectory || !existsSync(backupDirectory)) {
    return [];
  }
  const entries = readdirSync(backupDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.sqlite$/i.test(entry.name))
    .map((entry) => {
      const fullPath = path.join(backupDirectory, entry.name);
      const stat = statSync(fullPath);
      return {
        filename: entry.name,
        path: fullPath,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        mtimeMs: stat.mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return entries.map(({ mtimeMs: _ignored, ...rest }) => rest);
}

export async function backupSqliteToDestination(database, destinationPath, migrationsDirectory = DEFAULT_MIGRATIONS_DIR) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('A live SQLite DatabaseSync connection is required');
  }
  if (!destinationPath || typeof destinationPath !== 'string' || !destinationPath.trim()) {
    throw new Error('مسار حفظ النسخة الاحتياطية مطلوب.');
  }
  const resolvedDest = path.resolve(destinationPath.trim());
  mkdirSync(path.dirname(resolvedDest), { recursive: true });
  const tempDest = resolvedDest + '.tmp-' + randomUUID();
  const sourceCounts = tableCounts(database);

  try {
    await backup(database, tempDest, { rate: 128 });
    const verification = verifySqliteFile(tempDest, migrationsDirectory);
    if (JSON.stringify(sourceCounts) !== JSON.stringify(verification.counts)) {
      throw new Error('SQLite backup table counts do not match the source database');
    }
    rmSync(resolvedDest, { force: true });
    renameSync(tempDest, resolvedDest);
    const stat = statSync(resolvedDest);
    return {
      path: resolvedDest,
      filename: path.basename(resolvedDest),
      sizeBytes: stat.size,
      schemaVersion: verification.schemaVersion,
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    try { rmSync(tempDest, { force: true }); } catch {}
    throw error;
  }
}

export async function createSqliteBackup(database, backupDirectory, options = {}) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('A live SQLite DatabaseSync connection is required');
  }
  mkdirSync(backupDirectory, { recursive: true });
  const prefix = String(options.prefix || 'manual-backup').replace(/[^a-zA-Z0-9_-]/g, '-');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(backupDirectory, prefix + '-' + stamp + '-' + randomUUID() + '.sqlite');
  const result = await backupSqliteToDestination(database, destination, options.migrationsDirectory);
  return result.path;
}

function removeWalSidecars(databasePath) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { rmSync(databasePath + suffix, { force: true }); } catch {}
  }
}

export async function restoreSqliteBackupFile({
  databasePath,
  backupDirectory,
  sourceBackupPath,
  currentDatabase,
  reopenOptions,
}) {
  if (!databasePath || !backupDirectory || !sourceBackupPath || !currentDatabase || !reopenOptions) {
    throw new TypeError('Missing required arguments for SQLite restore');
  }
  const resolvedSource = path.resolve(sourceBackupPath);
  const resolvedDbPath = path.resolve(databasePath);
  if (resolvedSource === resolvedDbPath) {
    throw new Error('لا يمكن استعادة ملف قاعدة البيانات النشط على نفسه.');
  }

  // 1. Verify candidate backup BEFORE modifying or closing anything.
  const migrationsDirectory = reopenOptions.migrationsDirectory || DEFAULT_MIGRATIONS_DIR;
  verifySqliteFile(resolvedSource, migrationsDirectory);

  // 2. Snapshot current live DB as safety pre-restore backup before replacing it.
  const safetyBackupPath = await createSqliteBackup(currentDatabase, backupDirectory, {
    prefix: 'pre-restore',
    migrationsDirectory,
  });

  // 3. Flush WAL and close live connection.
  try {
    currentDatabase.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {}
  currentDatabase.close();

  const tempTarget = resolvedDbPath + '.restore-tmp-' + randomUUID();
  try {
    copyFileSync(resolvedSource, tempTarget);
    removeWalSidecars(resolvedDbPath);
    rmSync(resolvedDbPath, { force: true });
    renameSync(tempTarget, resolvedDbPath);

    const reopenedRuntime = await openErpDatabase(reopenOptions);
    return {
      restoredFrom: resolvedSource,
      safetyBackupPath,
      databaseRuntime: reopenedRuntime,
    };
  } catch (error) {
    try { rmSync(tempTarget, { force: true }); } catch {}
    // Rollback to pre-restore safety backup!
    try {
      removeWalSidecars(resolvedDbPath);
      rmSync(resolvedDbPath, { force: true });
      copyFileSync(safetyBackupPath, resolvedDbPath);
      const rolledBackRuntime = await openErpDatabase(reopenOptions);
      const msg = error instanceof Error ? error.message : 'فشل التحقق بعد الاستعادة';
      const restoreErr = new Error('فشل استعادة النسخة الاحتياطية وتم التراجع تلقائياً إلى النسخة الآمنة: ' + msg);
      restoreErr.rolledBackRuntime = rolledBackRuntime;
      restoreErr.safetyBackupPath = safetyBackupPath;
      throw restoreErr;
    } catch (rollbackErr) {
      if (rollbackErr && rollbackErr.rolledBackRuntime) {
        throw rollbackErr;
      }
      throw error;
    }
  }
}

export async function openErpDatabase(options) {
  if (!options || typeof options.userDataPath !== 'string' || !options.userDataPath.trim()) {
    throw new TypeError('userDataPath is required; use Electron app.getPath("userData")');
  }

  const userDataPath = path.resolve(options.userDataPath);
  const dataDirectory = path.join(userDataPath, 'Database');
  const backupDirectory = path.join(userDataPath, 'Backups');
  const databasePath = path.join(dataDirectory, 'erp.sqlite');
  const migrationsDirectory = options.migrationsDirectory || DEFAULT_MIGRATIONS_DIR;
  mkdirSync(dataDirectory, { recursive: true });

  const database = new DatabaseSync(databasePath, { timeout: 5000 });
  const newlyApplied = [];
  const preMigrationBackups = [];

  try {
    database.exec([
      'PRAGMA foreign_keys = ON;',
      'PRAGMA journal_mode = WAL;',
      'PRAGMA synchronous = FULL;',
      'PRAGMA busy_timeout = 5000;',
    ].join('\n'));

    database.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (' +
      'version INTEGER PRIMARY KEY, name TEXT NOT NULL, ' +
      'checksum_sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)'
    );

    const migrationFiles = readMigrationFiles(migrationsDirectory);
    const appliedRows = database.prepare(
      'SELECT version, name, checksum_sha256 FROM schema_migrations ORDER BY version'
    ).all();
    const appliedByVersion = new Map(appliedRows.map((row) => [row.version, row]));
    const availableVersions = new Set(migrationFiles.map((file) => file.version));

    for (const row of appliedRows) {
      if (!availableVersions.has(row.version)) {
        throw new Error('Applied SQLite migration file is missing: ' + row.name);
      }
    }

    for (const migration of migrationFiles) {
      const checksum = sha256(migration.sql);
      const existing = appliedByVersion.get(migration.version);

      if (existing) {
        if (existing.name !== migration.name || existing.checksum_sha256 !== checksum) {
          throw new Error('Applied SQLite migration was changed: ' + migration.filename);
        }
        continue;
      }

      if (appliedRows.length > 0 || newlyApplied.length > 0) {
        const backupPath = await createSqliteBackup(database, backupDirectory, {
          prefix: 'pre-migration-v' + String(migration.version).padStart(3, '0'),
          migrationsDirectory,
        });
        preMigrationBackups.push(backupPath);
      }

      database.exec('BEGIN IMMEDIATE');
      try {
        database.exec(migration.sql);
        database.prepare(
          'INSERT INTO schema_migrations (version, name, checksum_sha256, applied_at) VALUES (?, ?, ?, ?)'
        ).run(migration.version, migration.name, checksum, new Date().toISOString());
        database.exec('COMMIT');
        newlyApplied.push(migration.version);
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    }

    integrityCheck(database, 'Application database');
    const required = database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    );
    const hasV2PaymentMigration = migrationFiles.some((m) => m.filename === '002_payment_allocations_advances.sql');
    const hasV3ProductMediaMigration = migrationFiles.some((m) => m.filename === '003_product_images.sql');
    const tablesToRequire = [
      ...CORE_TABLES,
      ...(hasV2PaymentMigration ? V2_TABLES : []),
      ...(hasV3ProductMediaMigration ? V3_TABLES : []),
    ];
    for (const tableName of tablesToRequire) {
      if (!required.get(tableName)) {
        throw new Error('Required ERP table is missing after migration: ' + tableName);
      }
    }

    return {
      database,
      databasePath,
      backupDirectory,
      appliedMigrations: newlyApplied,
      preMigrationBackups,
      close: () => database.close(),
    };
  } catch (error) {
    try { database.close(); } catch {}
    if (preMigrationBackups.length > 0 && existsSync(preMigrationBackups[0])) {
      try {
        removeWalSidecars(databasePath);
        rmSync(databasePath, { force: true });
        copyFileSync(preMigrationBackups[0], databasePath);
      } catch {}
    }
    throw error;
  }
}
