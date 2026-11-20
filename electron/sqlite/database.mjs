import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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
  'outbox_queue', 'sync_conflicts', 'document_sequences',
];

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

export async function createSqliteBackup(database, backupDirectory, options = {}) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('A live SQLite DatabaseSync connection is required');
  }
  mkdirSync(backupDirectory, { recursive: true });
  const prefix = String(options.prefix || 'manual-backup').replace(/[^a-zA-Z0-9_-]/g, '-');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(backupDirectory, prefix + '-' + stamp + '-' + randomUUID() + '.sqlite');
  const sourceCounts = tableCounts(database);

  try {
    await backup(database, destination, { rate: 128 });
    const backupDb = new DatabaseSync(destination, { readOnly: true, timeout: 5000 });
    try {
      integrityCheck(backupDb, 'SQLite backup');
      const backupCounts = tableCounts(backupDb);
      if (JSON.stringify(sourceCounts) !== JSON.stringify(backupCounts)) {
        throw new Error('SQLite backup table counts do not match the source database');
      }
    } finally {
      backupDb.close();
    }
    if (statSync(destination).size <= 0) {
      throw new Error('SQLite backup file is empty');
    }
    return destination;
  } catch (error) {
    try { rmSync(destination, { force: true }); } catch {}
    throw error;
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
    for (const tableName of CORE_TABLES) {
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
    throw error;
  }
}
