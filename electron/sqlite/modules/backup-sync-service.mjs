import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  backupSqliteToDestination,
  createSqliteBackup,
  listSqliteBackups,
} from '../database.mjs';
import {
  actualCounts,
  databaseFinancialTotals,
  ensureTenants,
  formatUnits,
  insertRows,
  legacyChecksum,
  parseLegacyBackup,
  sourceCounts,
  sourceFinancialTotals,
} from '../legacy-backup-importer.mjs';
import {
  assertBranchAccess,
  assertPermission,
  filterRecordsByBranchScope,
  getAuthorizedBranchIds,
} from '../rbac.mjs';
import {
  formatScaledInt,
  MONEY_SCALE,
  parseScaledInt,
  QTY_SCALE,
  unitsToNumber,
} from '../money.mjs';
import {
  enqueueOutboxTx,
  getAppSetting,
  parseRowJson,
  setAppSettingTx,
  writeAuditLogTx,
} from './core-service.mjs';

const DEFAULT_BACKUP_SETTINGS = Object.freeze({
  autoBackupOnExit: true,
  autoBackupIntervalHours: 24,
  maxRetainedBackups: 15,
  customBackupDirectory: '',
});

const IMMUTABLE_SYNC_ENTITIES = new Set([
  'INVOICE',
  'JOURNAL_ENTRY',
  'VOUCHER',
  'AMANAT',
  'PAYMENT_ALLOCATION',
  'PARTY_ADVANCE',
  'ALLOCATION_AUDIT',
]);
const VALID_CONFLICT_STATUSES = new Set([
  'PENDING_REVIEW',
  'RESOLVED_LOCAL',
  'RESOLVED_REMOTE',
  'RESOLVED_MERGED',
]);

function getDefaultPriority(entityType) {
  switch (entityType) {
    case 'BRANCH':
    case 'ACCOUNT':
    case 'CASHBOX':
      return 1;
    case 'PARTY':
    case 'PRODUCT':
    case 'PRODUCT_IMAGE':
      return 2;
    case 'INVOICE':
    case 'VOUCHER':
    case 'AMANAT':
      return 3;
    case 'JOURNAL_ENTRY':
    case 'PAYMENT_ALLOCATION':
    case 'PARTY_ADVANCE':
    case 'ALLOCATION_AUDIT':
      return 4;
    default:
      return 3;
  }
}

function normalizeOutboxRow(row) {
  const parsed = parseRowJson(row);
  let payload = {};
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : parsed.payload || {};
  } catch {
    payload = parsed.payload || {};
  }
  return {
    ...parsed,
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id || parsed.branchId || undefined,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    retryCount: Number(row.retry_count || 0),
    priority: Number(row.priority || getDefaultPriority(row.entity_type)),
    createdAt: row.created_at,
    nextRetryAt: row.next_retry_at || undefined,
    leaseOwner: row.lease_owner || undefined,
    leaseExpiresAt: row.lease_expires_at || undefined,
    payload,
  };
}

function normalizeConflictRow(row) {
  const parsed = parseRowJson(row);
  let localPayload = {};
  let remotePayload = {};
  try {
    localPayload = row.local_payload_json ? JSON.parse(row.local_payload_json) : parsed.localPayload || {};
  } catch {
    localPayload = parsed.localPayload || {};
  }
  try {
    remotePayload = row.remote_payload_json ? JSON.parse(row.remote_payload_json) : parsed.remotePayload || {};
  } catch {
    remotePayload = parsed.remotePayload || {};
  }
  return {
    ...parsed,
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id || parsed.branchId || undefined,
    entityType: row.entity_type,
    entityId: row.entity_id,
    status: row.status,
    detectedAt: row.detected_at,
    localPayload,
    remotePayload,
  };
}

function sanitizeBackupSettings(raw, backupDirectory) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const maxRetainedRaw = Number(obj.maxRetainedBackups ?? DEFAULT_BACKUP_SETTINGS.maxRetainedBackups);
  const intervalRaw = Number(obj.autoBackupIntervalHours ?? DEFAULT_BACKUP_SETTINGS.autoBackupIntervalHours);
  return {
    autoBackupOnExit: obj.autoBackupOnExit !== false,
    autoBackupIntervalHours: Number.isFinite(intervalRaw) && intervalRaw >= 0 ? Math.min(intervalRaw, 720) : 24,
    maxRetainedBackups: Number.isFinite(maxRetainedRaw)
      ? Math.max(1, Math.min(200, Math.round(maxRetainedRaw)))
      : DEFAULT_BACKUP_SETTINGS.maxRetainedBackups,
    customBackupDirectory:
      typeof obj.customBackupDirectory === 'string' ? obj.customBackupDirectory.trim() : '',
    defaultBackupDirectory: backupDirectory || '',
  };
}

export function pruneAutoBackups(directory, maxRetained, prefixes = ['auto-exit-', 'auto-scheduled-']) {
  if (!directory || !existsSync(directory)) return 0;
  const limit = Math.max(1, Number(maxRetained || 15));
  const files = listSqliteBackups(directory).filter((f) =>
    prefixes.some((prefix) => f.filename.startsWith(prefix))
  );
  let removed = 0;
  for (let i = limit; i < files.length; i += 1) {
    try {
      rmSync(files[i].path, { force: true });
      rmSync(files[i].path + '.media', { recursive: true, force: true });
      removed += 1;
    } catch {}
  }
  return removed;
}

export function pruneAutoExitBackups(directory, maxRetained) {
  return pruneAutoBackups(directory, maxRetained, ['auto-exit-']);
}

export function createBackupSyncService(database, backupDirectory) {
  return {
    // --- إعدادات النسخ الاحتياطي والنسخ المجدول ---
    getBackupSettings(actor) {
      assertPermission(actor, 'backup:manage', 'عرض إعدادات النسخ الاحتياطي');
      const saved = getAppSetting(database, actor.tenantId, 'backup_settings', DEFAULT_BACKUP_SETTINGS);
      return sanitizeBackupSettings(saved, backupDirectory);
    },

    saveBackupSettings(actor, settings) {
      assertPermission(actor, 'backup:manage', 'تحديث إعدادات النسخ الاحتياطي');
      const clean = sanitizeBackupSettings(settings, backupDirectory);
      const persistable = {
        autoBackupOnExit: clean.autoBackupOnExit,
        autoBackupIntervalHours: clean.autoBackupIntervalHours,
        maxRetainedBackups: clean.maxRetainedBackups,
        customBackupDirectory: clean.customBackupDirectory,
      };
      const nowIso = new Date().toISOString();
      database.exec('BEGIN IMMEDIATE');
      try {
        setAppSettingTx(database, actor.tenantId, 'backup_settings', persistable, nowIso);
        writeAuditLogTx(
          database,
          actor,
          'تحديث إعدادات النسخ الاحتياطي',
          `نسخ تلقائي عند الإغلاق: ${persistable.autoBackupOnExit ? 'مفعل' : 'معطل'} | الحد المحتفظ به: ${persistable.maxRetainedBackups}`,
          nowIso
        );
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return clean;
    },

    listNativeBackups(actor) {
      assertPermission(actor, 'backup:manage', 'استعراض النسخ الاحتياطية');
      const settings = this.getBackupSettings(actor);
      const seen = new Set();
      const items = [];

      for (const entry of listSqliteBackups(backupDirectory)) {
        seen.add(path.resolve(entry.path));
        items.push({ ...entry, location: 'default' });
      }
      if (settings.customBackupDirectory && existsSync(settings.customBackupDirectory)) {
        for (const entry of listSqliteBackups(settings.customBackupDirectory)) {
          const resolved = path.resolve(entry.path);
          if (!seen.has(resolved)) {
            seen.add(resolved);
            items.push({ ...entry, location: 'custom' });
          }
        }
      }
      items.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
      return items;
    },

    async createNativeBackupNow(actor, prefix = 'manual-backup') {
      assertPermission(actor, 'backup:export', 'إنشاء نسخة احتياطية SQLite');
      if (!backupDirectory) {
        throw new Error('مجلد النسخ الاحتياطية غير مهيأ.');
      }
      const settings = this.getBackupSettings(actor);
      const createdPath = await createSqliteBackup(database, backupDirectory, { prefix });
      let copiedToCustomPath = null;

      if (
        settings.customBackupDirectory &&
        path.resolve(settings.customBackupDirectory) !== path.resolve(backupDirectory)
      ) {
        mkdirSync(settings.customBackupDirectory, { recursive: true });
        const customDest = path.join(settings.customBackupDirectory, path.basename(createdPath));
        const customResult = await backupSqliteToDestination(database, customDest);
        copiedToCustomPath = customResult.path;
      }

      if (prefix === 'auto-exit') {
        pruneAutoExitBackups(backupDirectory, settings.maxRetainedBackups);
        if (settings.customBackupDirectory) {
          pruneAutoExitBackups(settings.customBackupDirectory, settings.maxRetainedBackups);
        }
      }

      const listed = listSqliteBackups(backupDirectory).find(
        (item) => path.resolve(item.path) === path.resolve(createdPath)
      );

      writeAuditLogTx(
        database,
        actor,
        'إنشاء نسخة احتياطية SQLite',
        `تم إنشاء وفحص النسخة الاحتياطية: ${path.basename(createdPath)}`
      );

      return {
        path: createdPath,
        filename: path.basename(createdPath),
        sizeBytes: listed?.sizeBytes || 0,
        modifiedAt: listed?.modifiedAt || new Date().toISOString(),
        copiedToCustomPath,
      };
    },

    async exportNativeBackupToPath(actor, destinationPath) {
      assertPermission(actor, 'backup:export', 'تصدير نسخة احتياطية SQLite إلى مسار خارجي');
      const result = await backupSqliteToDestination(database, destinationPath);
      writeAuditLogTx(
        database,
        actor,
        'تصدير نسخة SQLite خارجية',
        `تم تصدير النسخة وفحصها: ${result.filename}`
      );
      return result;
    },

    // --- النسخ الاحتياطي بصيغة JSON المتوافقة كلياً مع Dexie ---
    exportBackupJSON(actor) {
      assertPermission(actor, 'backup:export', 'تصدير نسخة احتياطية JSON');
      const tenantId = actor.tenantId;

      const branches = database.prepare(
        'SELECT id, code, name_ar, is_main, active, data_json FROM branches WHERE tenant_id = ? ORDER BY is_main DESC, code ASC'
      ).all(tenantId).map((row) => ({
        ...parseRowJson(row),
        tenantId,
        id: row.id,
        code: row.code,
        nameAr: row.name_ar,
        isMain: row.is_main === 1,
        active: row.active === 1,
      }));

      const activities = database.prepare(
        'SELECT id, code, data_json FROM activities WHERE tenant_id = ? ORDER BY rowid'
      ).all(tenantId).map((row) => ({
        ...parseRowJson(row),
        tenantId,
        id: row.id,
        code: row.code,
      }));

      const accounts = database.prepare(
        'SELECT code, account_type, parent_code, is_leaf, balance_decimal, data_json FROM accounts WHERE tenant_id = ? ORDER BY code'
      ).all(tenantId).map((row) => ({
        ...parseRowJson(row),
        tenantId,
        code: row.code,
        type: row.account_type,
        parentCode: row.parent_code ?? null,
        isLeaf: row.is_leaf === 1,
        balance: unitsToNumber(parseScaledInt(row.balance_decimal, MONEY_SCALE, 'accountBalance'), MONEY_SCALE),
      }));

      const batchRows = database.prepare(
        'SELECT id, product_id, batch_number, expiry_date, quantity_decimal, cost_price_decimal, data_json FROM product_batches WHERE tenant_id = ? ORDER BY product_id, expiry_date, id'
      ).all(tenantId);

      // Construct each batch once so productBatches[i] and products[j].batches[k] are identical JSON
      const productBatches = [];
      const batchesByProduct = new Map();
      for (const row of batchRows) {
        const parsed = parseRowJson(row);
        const batchObj = {
          ...parsed,
          id: row.id,
          tenantId,
          productId: row.product_id,
          batchNumber: row.batch_number,
          expiryDate: row.expiry_date || '',
          quantity: unitsToNumber(parseScaledInt(row.quantity_decimal, QTY_SCALE, 'batchQty'), QTY_SCALE),
          costPrice: unitsToNumber(parseScaledInt(row.cost_price_decimal, MONEY_SCALE, 'batchCost'), MONEY_SCALE),
        };
        productBatches.push(batchObj);
        if (!batchesByProduct.has(row.product_id)) {
          batchesByProduct.set(row.product_id, []);
        }
        batchesByProduct.get(row.product_id).push(batchObj);
      }

      const products = database.prepare(
        'SELECT id, activity_id, code, barcode, category, current_stock_decimal, data_json FROM products WHERE tenant_id = ? ORDER BY code'
      ).all(tenantId).map((row) => ({
        ...parseRowJson(row),
        id: row.id,
        tenantId,
        activityId: row.activity_id,
        code: row.code,
        barcode: row.barcode || undefined,
        category: row.category || '',
        currentStock: unitsToNumber(parseScaledInt(row.current_stock_decimal, QTY_SCALE, 'productStock'), QTY_SCALE),
        batches: batchesByProduct.get(row.id) || [],
      }));

      const parties = database.prepare(
        'SELECT id, party_type, name_ar, phone, balance_decimal, advance_balance_decimal, data_json FROM parties WHERE tenant_id = ? ORDER BY name_ar'
      ).all(tenantId).map((row) => ({
        ...parseRowJson(row),
        id: row.id,
        tenantId,
        type: row.party_type,
        nameAr: row.name_ar,
        phone: row.phone || '',
        balance: unitsToNumber(parseScaledInt(row.balance_decimal, MONEY_SCALE, 'partyBalance'), MONEY_SCALE),
        advanceBalance: unitsToNumber(
          parseScaledInt(row.advance_balance_decimal ?? '0', MONEY_SCALE, 'partyAdvance'),
          MONEY_SCALE
        ),
      }));

      const invoices = database.prepare(
        'SELECT id, branch_id, invoice_number, invoice_type, activity_id, party_id, invoice_date, due_date, payment_method, total_decimal, paid_amount_decimal, advance_applied_decimal, status, data_json FROM invoices WHERE tenant_id = ? ORDER BY invoice_date, id'
      ).all(tenantId).map((row) => {
        const parsed = parseRowJson(row);
        const dueDate = row.due_date || parsed.dueDate || undefined;
        const advanceAppliedAmount = unitsToNumber(
          parseScaledInt(row.advance_applied_decimal ?? '0', MONEY_SCALE, 'invoiceAdvApplied'),
          MONEY_SCALE
        );
        return {
          ...parsed,
          id: row.id,
          tenantId,
          branchId: row.branch_id || undefined,
          invoiceNumber: row.invoice_number,
          type: row.invoice_type,
          activityId: row.activity_id,
          partyId: row.party_id || undefined,
          date: row.invoice_date,
          ...(dueDate ? { dueDate } : {}),
          paymentMethod: row.payment_method,
          total: unitsToNumber(parseScaledInt(row.total_decimal, MONEY_SCALE, 'invoiceTotal'), MONEY_SCALE),
          paidAmount: unitsToNumber(parseScaledInt(row.paid_amount_decimal, MONEY_SCALE, 'invoicePaid'), MONEY_SCALE),
          advanceAppliedAmount,
          status: row.status,
        };
      });

      const journalEntries = database.prepare(
        'SELECT id, branch_id, entry_number, entry_date, cost_center_id, status, reference_type, reference_id, data_json FROM journal_entries WHERE tenant_id = ? ORDER BY entry_date, id'
      ).all(tenantId).map((row) => ({
        ...parseRowJson(row),
        id: row.id,
        tenantId,
        branchId: row.branch_id || undefined,
        entryNumber: row.entry_number,
        date: row.entry_date,
        costCenterId: row.cost_center_id,
        status: row.status,
        referenceType: row.reference_type || undefined,
        referenceId: row.reference_id || undefined,
      }));

      const cashBoxes = database.prepare(
        'SELECT id, branch_id, code, account_code, balance_decimal, data_json FROM cash_boxes WHERE tenant_id = ? ORDER BY code'
      ).all(tenantId).map((row) => ({
        ...parseRowJson(row),
        id: row.id,
        tenantId,
        branchId: row.branch_id || undefined,
        code: row.code,
        accountCode: row.account_code,
        balance: unitsToNumber(parseScaledInt(row.balance_decimal, MONEY_SCALE, 'cashBoxBalance'), MONEY_SCALE),
      }));

      const vouchers = database.prepare(
        'SELECT id, branch_id, voucher_number, voucher_type, voucher_date, amount_decimal, cash_box_id, party_id, data_json FROM vouchers WHERE tenant_id = ? ORDER BY voucher_date, id'
      ).all(tenantId).map((row) => {
        const parsed = parseRowJson(row);
        return {
          ...parsed,
          id: row.id,
          tenantId,
          branchId: row.branch_id || undefined,
          voucherNumber: row.voucher_number,
          type: row.voucher_type,
          date: row.voucher_date,
          amount: unitsToNumber(parseScaledInt(row.amount_decimal, MONEY_SCALE, 'voucherAmount'), MONEY_SCALE),
          cashBoxId: row.cash_box_id,
          partyId: row.party_id || undefined,
          status: parsed.status || 'POSTED',
        };
      });

      const paymentAllocations = database.prepare(
        'SELECT tenant_id, id, branch_id, voucher_id, advance_transaction_id, party_id, invoice_id, allocated_decimal, allocation_method, status, created_at, created_by, data_json FROM payment_allocations WHERE tenant_id = ? ORDER BY created_at, id'
      ).all(tenantId).map((row) => ({
        ...parseRowJson(row),
        id: row.id,
        tenantId,
        branchId: row.branch_id || undefined,
        voucherId: row.voucher_id || undefined,
        advanceTransactionId: row.advance_transaction_id || undefined,
        partyId: row.party_id,
        invoiceId: row.invoice_id,
        allocatedAmount: unitsToNumber(parseScaledInt(row.allocated_decimal, MONEY_SCALE, 'allocAmount'), MONEY_SCALE),
        allocationMethod: row.allocation_method,
        status: row.status,
        createdAt: row.created_at,
        createdBy: row.created_by || undefined,
      }));

      const partyAdvanceTransactions = database.prepare(
        'SELECT tenant_id, id, branch_id, party_id, party_type, tx_type, amount_decimal, balance_after_decimal, voucher_id, invoice_id, journal_entry_id, tx_date, created_at, data_json FROM party_advance_transactions WHERE tenant_id = ? ORDER BY created_at, id'
      ).all(tenantId).map((row) => ({
        ...parseRowJson(row),
        id: row.id,
        tenantId,
        branchId: row.branch_id || undefined,
        partyId: row.party_id,
        partyType: row.party_type,
        type: row.tx_type,
        amount: unitsToNumber(parseScaledInt(row.amount_decimal, MONEY_SCALE, 'advAmount'), MONEY_SCALE),
        balanceAfter: unitsToNumber(parseScaledInt(row.balance_after_decimal, MONEY_SCALE, 'advAfter'), MONEY_SCALE),
        voucherId: row.voucher_id || undefined,
        invoiceId: row.invoice_id || undefined,
        journalEntryId: row.journal_entry_id || undefined,
        date: row.tx_date,
        createdAt: row.created_at,
      }));

      const allocationAudits = database.prepare(
        'SELECT tenant_id, id, branch_id, voucher_id, party_id, user_id, audit_timestamp, data_json FROM allocation_audits WHERE tenant_id = ? ORDER BY audit_timestamp, id'
      ).all(tenantId).map((row) => ({
        ...parseRowJson(row),
        id: row.id,
        tenantId,
        branchId: row.branch_id || undefined,
        voucherId: row.voucher_id,
        partyId: row.party_id,
        userId: row.user_id,
        timestamp: row.audit_timestamp,
      }));

      const amanat = database.prepare(
        'SELECT id, branch_id, record_number, amanat_type, status, amount_decimal, received_date, data_json FROM amanat_records WHERE tenant_id = ? ORDER BY received_date, id'
      ).all(tenantId).map((row) => ({
        ...parseRowJson(row),
        id: row.id,
        tenantId,
        branchId: row.branch_id || undefined,
        recordNumber: row.record_number,
        type: row.amanat_type,
        status: row.status,
        amount: unitsToNumber(parseScaledInt(row.amount_decimal, MONEY_SCALE, 'amanatAmount'), MONEY_SCALE),
        receivedDate: row.received_date,
      }));

      const users = database.prepare(
        'SELECT tenant_id, id, branch_id, username, role, active, password_hash, data_json FROM users WHERE tenant_id = ? ORDER BY username'
      ).all(tenantId).map((row) => {
        const parsed = parseRowJson(row);
        delete parsed.passwordHash;
        return {
          ...parsed,
          id: row.id,
          tenantId: row.tenant_id,
          branchId: row.branch_id || parsed.branchId || undefined,
          username: row.username,
          role: row.role,
          active: row.active === 1,
          hasPassword: Boolean(row.password_hash),
        };
      });

      const auditLogs = database.prepare(
        'SELECT id, tenant_id, branch_id, timestamp, user_id, action, details, data_json FROM audit_logs WHERE tenant_id = ? ORDER BY timestamp DESC'
      ).all(tenantId).map((row) => ({
        ...parseRowJson(row),
        id: row.id,
        tenantId: row.tenant_id,
        branchId: row.branch_id || undefined,
        timestamp: row.timestamp,
        userId: row.user_id,
        action: row.action,
        details: row.details,
      }));

      const outbox = database.prepare(
        'SELECT * FROM outbox_queue WHERE tenant_id = ? ORDER BY created_at'
      ).all(tenantId).map(normalizeOutboxRow);

      const syncConflicts = database.prepare(
        'SELECT * FROM sync_conflicts WHERE tenant_id = ? ORDER BY detected_at DESC'
      ).all(tenantId).map(normalizeConflictRow);

      const sequences = database.prepare(
        'SELECT sequence_key, last_seq, updated_at FROM document_sequences WHERE tenant_id = ? ORDER BY sequence_key'
      ).all(tenantId).map((row) => ({
        tenantId,
        key: row.sequence_key,
        lastSeq: row.last_seq,
        updatedAt: row.updated_at,
      }));

      const productImageCount = Number(database.prepare(
        'SELECT COUNT(*) AS count FROM product_images WHERE tenant_id = ? AND is_deleted = 0'
      ).get(tenantId)?.count || 0);

      const payload = {
        mediaManifest: {
          productImageCount,
          mediaIncluded: false,
        },
        branches,
        accounts,
        activities,
        products,
        productBatches,
        parties,
        invoices,
        journalEntries,
        cashBoxes,
        vouchers,
        paymentAllocations,
        partyAdvanceTransactions,
        allocationAudits,
        amanat,
        users,
        auditLogs,
        outbox,
        syncConflicts,
        sequences,
      };

      const backup = {
        app: 'نظام الإدارة التجارية والمحاسبية المتكامل',
        systemIdentifier: 'multi_activity_erp',
        version: '2.2.0',
        exportedAt: new Date().toISOString(),
        checksum: legacyChecksum(payload),
        data: payload,
      };

      writeAuditLogTx(
        database,
        actor,
        'تصدير نسخة احتياطية JSON',
        `تم تصدير ${invoices.length} فاتورة و ${journalEntries.length} قيد محاسبي.`
      );

      return JSON.stringify(backup, null, 2);
    },

    async importBackupJSON(actor, rawJson) {
      assertPermission(actor, 'backup:restore', 'استعادة نسخة احتياطية JSON');
      const tenantId = actor.tenantId;

      try {
        const parsed = parseLegacyBackup(rawJson);
        if (!parsed.tenantIds.every((id) => id === tenantId)) {
          return {
            success: false,
            error: 'حظر عزل المؤسسات: النسخة الاحتياطية تحتوي على سجلات لمؤسسة أخرى غير المؤسسة الحالية.',
          };
        }
        if (parsed.data.branches.length === 0) {
          return {
            success: false,
            error: 'النسخة الاحتياطية لا تحتوي على أي فروع؛ أوقفت الاستعادة لحماية النظام.',
          };
        }
        if (!parsed.data.users.some((u) => u.role === 'ADMIN' && u.active !== false)) {
          return {
            success: false,
            error: 'النسخة الاحتياطية لا تحتوي على أي حساب مدير عام (ADMIN) نشط.',
          };
        }

        const currentProductImageCount = Number(database.prepare(
          'SELECT COUNT(*) AS count FROM product_images WHERE tenant_id = ? AND is_deleted = 0'
        ).get(tenantId)?.count || 0);
        const backupProductImageCount = Number(parsed.data.mediaManifest?.productImageCount || 0);
        if (currentProductImageCount > 0 || backupProductImageCount > 0 || parsed.data.mediaManifest?.mediaIncluded === false && backupProductImageCount > 0) {
          return {
            success: false,
            error: 'أوقفت استعادة JSON لحماية صور الأصناف: صيغة JSON لا تتضمن ملفات الصور. استخدم النسخة الاحتياطية الأصلية SQLite مع مجلد الصور المرفق (.media)، ثم أعد المحاولة.',
          };
        }

        const expectedCounts = sourceCounts(parsed.data);
        const expectedTotals = sourceFinancialTotals(parsed.data);
        const safetyBackupPath = await createSqliteBackup(database, backupDirectory, {
          prefix: 'pre-json-restore',
        });
        const safetyFilename = path.basename(safetyBackupPath);
        const importId = randomUUID();
        const importedAt = new Date().toISOString();

        // Preserve existing SQLite password hashes when JSON backup omitted passwordHash
        const existingUsers = database.prepare(
          'SELECT tenant_id, id, username, password_hash FROM users WHERE tenant_id = ?'
        ).all(tenantId);
        const preservedHashes = {
          byId: new Map(),
          byUsername: new Map(),
        };
        for (const u of existingUsers) {
          if (u.password_hash) {
            preservedHashes.byId.set(`${u.tenant_id}:${u.id}`, u.password_hash);
            preservedHashes.byUsername.set(`${u.tenant_id}:${String(u.username || '').toLowerCase()}`, u.password_hash);
          }
        }

        database.exec('BEGIN IMMEDIATE');
        try {
          // Clear tenant operational tables in strict FK-dependency order
          database.prepare('DELETE FROM payment_allocations WHERE tenant_id = ?').run(tenantId);
          database.prepare('DELETE FROM party_advance_transactions WHERE tenant_id = ?').run(tenantId);
          database.prepare('DELETE FROM allocation_audits WHERE tenant_id = ?').run(tenantId);
          database.prepare('DELETE FROM invoice_stock_deductions WHERE tenant_id = ?').run(tenantId);
          database.prepare('DELETE FROM invoice_items WHERE tenant_id = ?').run(tenantId);
          database.prepare('DELETE FROM invoices WHERE tenant_id = ?').run(tenantId);
          database.prepare('DELETE FROM journal_entry_lines WHERE tenant_id = ?').run(tenantId);
          database.prepare('DELETE FROM journal_entries WHERE tenant_id = ?').run(tenantId);
          database.prepare('DELETE FROM vouchers WHERE tenant_id = ?').run(tenantId);
          database.prepare('DELETE FROM amanat_records WHERE tenant_id = ?').run(tenantId);
          database.prepare('DELETE FROM product_batches WHERE tenant_id = ?').run(tenantId);
          database.prepare('DELETE FROM products WHERE tenant_id = ?').run(tenantId);
          database.prepare('DELETE FROM cash_boxes WHERE tenant_id = ?').run(tenantId);
          database.prepare('DELETE FROM parties WHERE tenant_id = ?').run(tenantId);
          database.prepare('UPDATE accounts SET parent_code = NULL WHERE tenant_id = ?').run(tenantId);
          database.prepare('DELETE FROM accounts WHERE tenant_id = ?').run(tenantId);
          database.prepare('DELETE FROM activities WHERE tenant_id = ?').run(tenantId);
          database.prepare('DELETE FROM users WHERE tenant_id = ?').run(tenantId);
          database.prepare('DELETE FROM branches WHERE tenant_id = ?').run(tenantId);
          database.prepare('DELETE FROM audit_logs WHERE tenant_id = ?').run(tenantId);
          database.prepare('DELETE FROM outbox_queue WHERE tenant_id = ?').run(tenantId);
          database.prepare('DELETE FROM sync_conflicts WHERE tenant_id = ?').run(tenantId);
          database.prepare('DELETE FROM document_sequences WHERE tenant_id = ?').run(tenantId);

          ensureTenants(database, [tenantId]);
          insertRows(database, parsed.data, { preservedHashes });

          const fkErrors = database.prepare('PRAGMA foreign_key_check').all();
          if (fkErrors.length > 0) {
            throw new Error('النسخة المستعادة تحتوي على أخطاء في العلاقات المرجعية (Foreign Key Violation).');
          }

          const resultingCounts = actualCounts(database, [tenantId]);
          for (const [key, expected] of Object.entries(expectedCounts)) {
            if (resultingCounts[key] !== expected) {
              throw new Error(
                `تباين في عدد السجلات بعد الاستعادة (${key}): المتوقع ${expected} والفعلي ${resultingCounts[key]}.`
              );
            }
          }

          const resultingTotals = databaseFinancialTotals(database, [tenantId]);
          for (const [key, expected] of Object.entries(expectedTotals)) {
            if (resultingTotals[key] !== expected) {
              throw new Error(`تباين في المجموع المالي بعد الاستعادة (${key}).`);
            }
          }

          database.prepare(
            'INSERT INTO legacy_imports (id,tenant_id,source_system,source_version,source_checksum,imported_at,row_counts_json,financial_totals_json,backup_filename) VALUES (?,?,?,?,?,?,?,?,?)'
          ).run(
            importId,
            tenantId,
            parsed.backup.systemIdentifier,
            String(parsed.backup.version || 'unknown'),
            parsed.sourceChecksum,
            importedAt,
            JSON.stringify(resultingCounts),
            JSON.stringify(
              Object.fromEntries(
                Object.entries(resultingTotals).map(([key, value]) => [key, formatUnits(value)])
              )
            ),
            safetyFilename
          );

          writeAuditLogTx(
            database,
            actor,
            'استعادة نسخة احتياطية JSON',
            `تمت الاستعادة بعد حفظ نسخة أمان (${safetyFilename}) بعدد ${resultingCounts.invoices} فاتورة و ${resultingCounts.journalEntries} قيد.`,
            importedAt
          );

          database.exec('COMMIT');

          return {
            success: true,
            importId,
            backupFilename: safetyFilename,
            rowCounts: resultingCounts,
          };
        } catch (txError) {
          try { database.exec('ROLLBACK'); } catch {}
          throw txError;
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'فشلت استعادة النسخة الاحتياطية.',
        };
      }
    },

    // --- طابور الإرسال (SQLite Outbox Queue) ---
    getOutboxQueue(actor, statusFilter = 'all', sortDir = 'desc') {
      assertPermission(actor, 'sync:manage', 'عرض طابور المزامنة');
      const order = sortDir === 'asc' ? 'ASC' : 'DESC';
      let rows;
      if (statusFilter && statusFilter !== 'all') {
        rows = database.prepare(
          `SELECT * FROM outbox_queue WHERE tenant_id = ? AND status = ? ORDER BY created_at ${order}`
        ).all(actor.tenantId, statusFilter);
      } else {
        rows = database.prepare(
          `SELECT * FROM outbox_queue WHERE tenant_id = ? ORDER BY created_at ${order}`
        ).all(actor.tenantId);
      }
      return filterRecordsByBranchScope(rows.map(normalizeOutboxRow), actor);
    },

    getOutboxStats(actor) {
      assertPermission(actor, 'sync:manage', 'إحصائيات طابور المزامنة');
      const items = this.getOutboxQueue(actor, 'all', 'desc');
      const stats = { total: items.length, pending: 0, syncing: 0, synced: 0, failed: 0 };
      for (const item of items) {
        if (item.status === 'PENDING') stats.pending += 1;
        else if (item.status === 'SYNCING') stats.syncing += 1;
        else if (item.status === 'SYNCED') stats.synced += 1;
        else if (item.status === 'FAILED') stats.failed += 1;
      }
      return stats;
    },

    getPendingEntityKeys(actor) {
      assertPermission(actor, 'sync:manage', 'فحص السجلات المعلقة قبل السحب');
      const rows = database.prepare(
        "SELECT entity_type, entity_id, branch_id FROM outbox_queue WHERE tenant_id = ? AND status IN ('PENDING', 'SYNCING')"
      ).all(actor.tenantId);
      const scoped = filterRecordsByBranchScope(
        rows.map((r) => ({ ...r, branchId: r.branch_id })),
        actor
      );
      return scoped.map((r) => `${r.entity_type}:${r.entity_id}`);
    },

    queueOutboxItem(actor, params) {
      assertPermission(actor, 'sync:manage', 'إضافة عنصر لطابور المزامنة');
      if (!params || !params.entityType || !params.entityId || !params.action) {
        throw new Error('بيانات عنصر المزامنة ناقصة.');
      }
      if (params.tenantId && params.tenantId !== actor.tenantId) {
        throw new Error('حظر عزل المؤسسات: لا يمكن إضافة عنصر لمؤسسة أخرى.');
      }
      const targetBranchId = String(params.branchId || actor.branchId || '').trim();
      assertBranchAccess(actor, targetBranchId);

      let itemId;
      database.exec('BEGIN IMMEDIATE');
      try {
        itemId = enqueueOutboxTx(database, actor, {
          entityType: params.entityType,
          entityId: params.entityId,
          action: params.action,
          payload: params.payload || {},
          priority: params.priority ?? getDefaultPriority(params.entityType),
          dependsOn: params.dependsOn,
          idempotencyKey: params.idempotencyKey,
          branchId: targetBranchId,
        });
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }

      const row = database.prepare('SELECT * FROM outbox_queue WHERE tenant_id = ? AND id = ?').get(actor.tenantId, itemId);
      return row ? normalizeOutboxRow(row) : null;
    },

    claimReadyToSyncItems(actor, workerId = 'worker_default', limit = 25, leaseMs = 180_000) {
      assertPermission(actor, 'sync:manage', 'حجز عناصر المزامنة الجاهزة');
      const owner = String(workerId || '').trim() || 'worker_default';
      const cap = Math.max(1, Math.min(200, Number(limit || 25)));
      const leaseDuration = Math.max(1000, Number(leaseMs || 180_000));
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const leaseExpiresAt = new Date(nowMs + leaseDuration).toISOString();
      const allowedBranches = actor.role === 'ADMIN' ? null : getAuthorizedBranchIds(actor);

      database.exec('BEGIN IMMEDIATE');
      try {
        // 1. Release expired leases
        const expired = database.prepare(
          "SELECT id, data_json FROM outbox_queue WHERE tenant_id = ? AND status = 'SYNCING' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?"
        ).all(actor.tenantId, nowIso);
        const releaseStmt = database.prepare(
          "UPDATE outbox_queue SET status = 'PENDING', lease_owner = NULL, lease_expires_at = NULL, data_json = ? WHERE tenant_id = ? AND id = ?"
        );
        for (const r of expired) {
          const obj = parseRowJson(r);
          obj.status = 'PENDING';
          delete obj.leaseOwner;
          delete obj.leaseExpiresAt;
          releaseStmt.run(JSON.stringify(obj), actor.tenantId, r.id);
        }

        // 2. Inspect unresolved entityIds in tenant
        const allRows = database.prepare(
          'SELECT * FROM outbox_queue WHERE tenant_id = ?'
        ).all(actor.tenantId);

        const unSyncedEntityIds = new Set();
        for (const r of allRows) {
          if (r.status === 'PENDING' || r.status === 'SYNCING' || r.status === 'FAILED') {
            unSyncedEntityIds.add(r.entity_id);
          }
        }

        const candidates = allRows
          .map(normalizeOutboxRow)
          .filter((item) => {
            if (item.status !== 'PENDING') return false;
            if (allowedBranches && (!item.branchId || !allowedBranches.has(item.branchId))) {
              return false;
            }
            if (item.nextRetryAt && item.nextRetryAt > nowIso) {
              return false;
            }
            if (Array.isArray(item.dependsOn) && item.dependsOn.length > 0) {
              if (item.dependsOn.some((depId) => unSyncedEntityIds.has(depId))) {
                return false;
              }
            }
            return true;
          })
          .sort((a, b) => {
            const pDiff = (a.priority ?? getDefaultPriority(a.entityType)) - (b.priority ?? getDefaultPriority(b.entityType));
            if (pDiff !== 0) return pDiff;
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          })
          .slice(0, cap);

        const claimStmt = database.prepare(
          "UPDATE outbox_queue SET status = 'SYNCING', lease_owner = ?, lease_expires_at = ?, data_json = ? WHERE tenant_id = ? AND id = ? AND status = 'PENDING'"
        );
        const claimed = [];
        for (const cand of candidates) {
          const updated = {
            ...cand,
            status: 'SYNCING',
            leaseOwner: owner,
            leaseExpiresAt,
            lastAttemptAt: nowIso,
          };
          const info = claimStmt.run(owner, leaseExpiresAt, JSON.stringify(updated), actor.tenantId, cand.id);
          if (info.changes > 0) {
            claimed.push(updated);
          }
        }

        database.exec('COMMIT');
        return claimed;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    markOutboxSynced(actor, id, serverTimestamp) {
      assertPermission(actor, 'sync:manage', 'تأكيد مزامنة عنصر');
      const row = database.prepare(
        'SELECT * FROM outbox_queue WHERE tenant_id = ? AND id = ?'
      ).get(actor.tenantId, id);
      if (!row) {
        throw new Error('عنصر المزامنة غير موجود ضمن المؤسسة الحالية.');
      }
      assertBranchAccess(actor, row.branch_id || actor.branchId);
      const item = normalizeOutboxRow(row);
      const syncedAt = serverTimestamp || new Date().toISOString();
      const updated = {
        ...item,
        status: 'SYNCED',
        syncedAt,
      };
      delete updated.errorMessage;
      delete updated.leaseOwner;
      delete updated.leaseExpiresAt;
      delete updated.nextRetryAt;

      database.prepare(
        "UPDATE outbox_queue SET status = 'SYNCED', next_retry_at = NULL, lease_owner = NULL, lease_expires_at = NULL, data_json = ? WHERE tenant_id = ? AND id = ?"
      ).run(JSON.stringify(updated), actor.tenantId, id);
    },

    markOutboxFailed(actor, id, errorMessage, isPermanent = false) {
      assertPermission(actor, 'sync:manage', 'تسجيل فشل مزامنة عنصر');
      const row = database.prepare(
        'SELECT * FROM outbox_queue WHERE tenant_id = ? AND id = ?'
      ).get(actor.tenantId, id);
      if (!row) return;
      assertBranchAccess(actor, row.branch_id || actor.branchId);

      const item = normalizeOutboxRow(row);
      const nextRetryCount = Number(item.retryCount || 0) + 1;
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const maxRetries = 5;

      const updated = {
        ...item,
        retryCount: nextRetryCount,
        errorMessage: String(errorMessage || 'خطأ مزامنة غير محدد'),
        lastAttemptAt: nowIso,
      };
      delete updated.leaseOwner;
      delete updated.leaseExpiresAt;

      let nextStatus = 'PENDING';
      let nextRetryAt = null;
      if (isPermanent || nextRetryCount >= maxRetries) {
        nextStatus = 'FAILED';
        delete updated.nextRetryAt;
      } else {
        const backoffMs = Math.min(1000 * (2 ** nextRetryCount), 60000);
        nextRetryAt = new Date(nowMs + backoffMs).toISOString();
        updated.nextRetryAt = nextRetryAt;
      }
      updated.status = nextStatus;

      database.prepare(
        'UPDATE outbox_queue SET status = ?, retry_count = ?, next_retry_at = ?, lease_owner = NULL, lease_expires_at = NULL, data_json = ? WHERE tenant_id = ? AND id = ?'
      ).run(nextStatus, nextRetryCount, nextRetryAt, JSON.stringify(updated), actor.tenantId, id);
    },

    retryFailedItems(actor) {
      assertPermission(actor, 'sync:manage', 'إعادة جدولة العناصر الفاشلة');
      const allowedBranches = actor.role === 'ADMIN' ? null : getAuthorizedBranchIds(actor);
      const failedRows = database.prepare(
        "SELECT * FROM outbox_queue WHERE tenant_id = ? AND status = 'FAILED'"
      ).all(actor.tenantId);

      let updatedCount = 0;
      database.exec('BEGIN IMMEDIATE');
      try {
        const stmt = database.prepare(
          "UPDATE outbox_queue SET status = 'PENDING', next_retry_at = NULL, lease_owner = NULL, lease_expires_at = NULL, data_json = ? WHERE tenant_id = ? AND id = ?"
        );
        for (const row of failedRows) {
          if (allowedBranches && (!row.branch_id || !allowedBranches.has(row.branch_id))) {
            continue;
          }
          const obj = normalizeOutboxRow(row);
          obj.status = 'PENDING';
          delete obj.nextRetryAt;
          delete obj.errorMessage;
          delete obj.leaseOwner;
          delete obj.leaseExpiresAt;
          stmt.run(JSON.stringify(obj), actor.tenantId, row.id);
          updatedCount += 1;
        }
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return updatedCount;
    },

    purgeOldSyncedRecords(actor, olderThanDays = 30) {
      assertPermission(actor, 'sync:manage', 'تنظيف سجلات المزامنة المؤكدة القديمة');
      const days = Math.max(0, Number(olderThanDays ?? 30));
      const cutoffIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const allowedBranches = actor.role === 'ADMIN' ? null : getAuthorizedBranchIds(actor);
      const syncedRows = database.prepare(
        "SELECT id, branch_id, data_json FROM outbox_queue WHERE tenant_id = ? AND status = 'SYNCED'"
      ).all(actor.tenantId);

      let deleted = 0;
      database.exec('BEGIN IMMEDIATE');
      try {
        const delStmt = database.prepare(
          "DELETE FROM outbox_queue WHERE tenant_id = ? AND id = ? AND status = 'SYNCED'"
        );
        for (const row of syncedRows) {
          if (allowedBranches && (!row.branch_id || !allowedBranches.has(row.branch_id))) {
            continue;
          }
          const obj = parseRowJson(row);
          if (obj.syncedAt && String(obj.syncedAt) < cutoffIso) {
            const info = delStmt.run(actor.tenantId, row.id);
            deleted += info.changes;
          }
        }
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return deleted;
    },

    recoverStuckSyncingItems(actor, leaseTimeoutMinutes = 2) {
      assertPermission(actor, 'sync:manage', 'استعادة العناصر العالقة');
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const cutoffIso = new Date(nowMs - Math.max(0, Number(leaseTimeoutMinutes ?? 2)) * 60 * 1000).toISOString();
      const allowedBranches = actor.role === 'ADMIN' ? null : getAuthorizedBranchIds(actor);

      const syncingRows = database.prepare(
        "SELECT * FROM outbox_queue WHERE tenant_id = ? AND status = 'SYNCING'"
      ).all(actor.tenantId);

      let recovered = 0;
      database.exec('BEGIN IMMEDIATE');
      try {
        const updStmt = database.prepare(
          "UPDATE outbox_queue SET status = 'PENDING', next_retry_at = NULL, lease_owner = NULL, lease_expires_at = NULL, data_json = ? WHERE tenant_id = ? AND id = ?"
        );
        for (const row of syncingRows) {
          if (allowedBranches && (!row.branch_id || !allowedBranches.has(row.branch_id))) {
            continue;
          }
          const obj = normalizeOutboxRow(row);
          const expired =
            (obj.leaseExpiresAt && obj.leaseExpiresAt < nowIso) ||
            (!obj.lastAttemptAt || obj.lastAttemptAt < cutoffIso);
          if (!expired) continue;

          obj.status = 'PENDING';
          delete obj.nextRetryAt;
          delete obj.leaseOwner;
          delete obj.leaseExpiresAt;
          updStmt.run(JSON.stringify(obj), actor.tenantId, row.id);
          recovered += 1;
        }
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return recovered;
    },

    // --- تعارضات المزامنة (SQLite Sync Conflicts) ---
    getConflicts(actor) {
      assertPermission(actor, 'sync:manage', 'عرض تعارضات المزامنة');
      const rows = database.prepare(
        'SELECT * FROM sync_conflicts WHERE tenant_id = ? ORDER BY detected_at DESC'
      ).all(actor.tenantId);
      return filterRecordsByBranchScope(rows.map(normalizeConflictRow), actor);
    },

    recordConflict(actor, params) {
      assertPermission(actor, 'sync:manage', 'تسجيل تعارض مزامنة');
      if (!params || !params.entityType || !params.entityId) {
        throw new Error('بيانات تعارض المزامنة ناقصة.');
      }
      if (params.tenantId && params.tenantId !== actor.tenantId) {
        throw new Error('حظر عزل المؤسسات: لا يمكن تسجيل تعارض لمؤسسة أخرى.');
      }
      const targetBranchId = String(params.branchId || actor.branchId || '').trim();
      assertBranchAccess(actor, targetBranchId);

      const id = randomUUID();
      const detectedAt = new Date().toISOString();
      const conflict = {
        id,
        tenantId: actor.tenantId,
        branchId: targetBranchId,
        entityType: params.entityType,
        entityId: String(params.entityId),
        localPayload: params.localPayload || {},
        remotePayload: params.remotePayload || {},
        detectedAt,
        status: 'PENDING_REVIEW',
        notes: params.notes || 'تم اكتشاف تعارض في البيانات بين الجهاز والخادم السحابي.',
      };

      database.prepare(
        'INSERT INTO sync_conflicts (tenant_id,id,branch_id,entity_type,entity_id,status,detected_at,local_payload_json,remote_payload_json,data_json) VALUES (?,?,?,?,?,?,?,?,?,?)'
      ).run(
        actor.tenantId,
        conflict.id,
        conflict.branchId,
        conflict.entityType,
        conflict.entityId,
        conflict.status,
        conflict.detectedAt,
        JSON.stringify(conflict.localPayload),
        JSON.stringify(conflict.remotePayload),
        JSON.stringify(conflict)
      );

      return conflict;
    },

    resolveConflict(actor, conflictId, status, notes) {
      assertPermission(actor, 'sync:manage', 'تسوية تعارض مزامنة');
      if (!VALID_CONFLICT_STATUSES.has(status)) {
        throw new Error('حالة تسوية التعارض غير صالحة.');
      }
      const row = database.prepare(
        'SELECT * FROM sync_conflicts WHERE tenant_id = ? AND id = ?'
      ).get(actor.tenantId, conflictId);
      if (!row) return;

      assertBranchAccess(actor, row.branch_id || actor.branchId);
      const conflict = normalizeConflictRow(row);
      conflict.status = status;
      conflict.resolvedAt = new Date().toISOString();
      if (notes) {
        conflict.notes = (conflict.notes ? conflict.notes + ' | ' : '') + String(notes);
      }

      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(
          'UPDATE sync_conflicts SET status = ?, data_json = ? WHERE tenant_id = ? AND id = ?'
        ).run(status, JSON.stringify(conflict), actor.tenantId, conflictId);
        writeAuditLogTx(
          database,
          actor,
          'تسوية تعارض مزامنة',
          `تم اعتماد (${status}) للتعارض ${conflict.entityType}:${conflict.entityId}`
        );
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    // --- تطبيق التحديثات المسحوبة من الخادم البعيد على SQLite ---
    applyRemoteEntity(actor, entityType, row) {
      assertPermission(actor, 'sync:manage', 'تطبيق بيانات مسحوبة من السحابة');
      if (!row || typeof row !== 'object') throw new Error('سجل مزامنة غير صالح.');

      const tenantId = actor.tenantId;
      const isDeleted = row.is_deleted === true;
      const remoteBranchId = row.branch_id ? String(row.branch_id) : (row.branchId ? String(row.branchId) : null);
      if (remoteBranchId) {
        assertBranchAccess(actor, remoteBranchId);
      }
      const fallbackBranchId = remoteBranchId || actor.branchId || 'branch_main';

      if (isDeleted && IMMUTABLE_SYNC_ENTITIES.has(entityType)) {
        throw new Error(`رفض أمني: ممنوع حذف السجل المالي (${entityType}) عبر المزامنة.`);
      }

      database.exec('BEGIN IMMEDIATE');
      try {
        switch (entityType) {
          case 'BRANCH': {
            const id = String(row.id || '');
            if (!id) throw new Error('معرف الفرع مفقود.');
            if (isDeleted) {
              database.prepare('UPDATE branches SET active = 0 WHERE tenant_id = ? AND id = ?').run(tenantId, id);
            } else {
              const branch = {
                id,
                tenantId,
                code: String(row.code || 'BR01'),
                nameAr: String(row.name_ar || row.nameAr || 'فرع'),
                isMain: Boolean(row.is_main ?? row.isMain),
                address: row.address ? String(row.address) : undefined,
                phone: row.phone ? String(row.phone) : undefined,
                active: Boolean(row.is_active ?? row.active ?? true),
                createdAt: String(row.created_at || row.createdAt || new Date().toISOString()),
              };
              database.prepare(
                `INSERT INTO branches (tenant_id,id,code,name_ar,is_main,active,data_json)
                 VALUES (?,?,?,?,?,?,?)
                 ON CONFLICT(tenant_id,id) DO UPDATE SET code=excluded.code, name_ar=excluded.name_ar, is_main=excluded.is_main, active=excluded.active, data_json=excluded.data_json`
              ).run(tenantId, branch.id, branch.code, branch.nameAr, branch.isMain ? 1 : 0, branch.active ? 1 : 0, JSON.stringify(branch));
            }
            break;
          }

          case 'ACCOUNT': {
            const code = String(row.code || row.id || '');
            if (!code) throw new Error('كود الحساب مفقود.');
            if (isDeleted) {
              // Preserve accounting integrity if referenced; reject destructive wipe silently or leave untouched
              break;
            }
            const balUnits = parseScaledInt(row.balance ?? 0, MONEY_SCALE, 'remoteAccountBalance');
            const balDec = formatScaledInt(balUnits, MONEY_SCALE);
            const acc = {
              tenantId,
              code,
              nameAr: String(row.name_ar || row.nameAr || ''),
              type: String(row.type || 'ASSET'),
              parentCode: row.parent_code ? String(row.parent_code) : row.parentCode ? String(row.parentCode) : null,
              isLeaf: (row.is_leaf ?? row.isLeaf) !== false,
              balance: unitsToNumber(balUnits, MONEY_SCALE),
              costCenterId: row.cost_center_id || row.costCenterId || undefined,
            };
            database.prepare(
              `INSERT INTO accounts (tenant_id,code,account_type,parent_code,is_leaf,balance_decimal,data_json)
               VALUES (?,?,?,?,?,?,?)
               ON CONFLICT(tenant_id,code) DO UPDATE SET account_type=excluded.account_type, parent_code=excluded.parent_code, is_leaf=excluded.is_leaf, balance_decimal=excluded.balance_decimal, data_json=excluded.data_json`
            ).run(tenantId, acc.code, acc.type, acc.parentCode, acc.isLeaf ? 1 : 0, balDec, JSON.stringify(acc));
            break;
          }

          case 'CASHBOX': {
            const id = String(row.id || '');
            if (!id) throw new Error('معرف الصندوق مفقود.');
            if (isDeleted) {
              database.prepare('DELETE FROM cash_boxes WHERE tenant_id = ? AND id = ?').run(tenantId, id);
            } else {
              const balUnits = parseScaledInt(row.balance ?? 0, MONEY_SCALE, 'remoteCashBoxBalance');
              const balDec = formatScaledInt(balUnits, MONEY_SCALE);
              const box = {
                id,
                tenantId,
                branchId: fallbackBranchId,
                code: String(row.code || 'CASH'),
                nameAr: String(row.name_ar || row.nameAr || ''),
                accountCode: String(row.account_code || row.accountCode || '1101'),
                balance: unitsToNumber(balUnits, MONEY_SCALE),
                isDefault: Boolean(row.is_default ?? row.isDefault),
              };
              database.prepare(
                `INSERT INTO cash_boxes (tenant_id,id,branch_id,code,account_code,balance_decimal,data_json)
                 VALUES (?,?,?,?,?,?,?)
                 ON CONFLICT(tenant_id,id) DO UPDATE SET branch_id=excluded.branch_id, code=excluded.code, account_code=excluded.account_code, balance_decimal=excluded.balance_decimal, data_json=excluded.data_json`
              ).run(tenantId, box.id, box.branchId, box.code, box.accountCode, balDec, JSON.stringify(box));
            }
            break;
          }

          case 'PRODUCT': {
            const id = String(row.id || '');
            if (!id) throw new Error('معرف الصنف مفقود.');
            if (isDeleted) {
              const linkedImages = database.prepare(
                'SELECT COUNT(*) AS count FROM product_images WHERE tenant_id = ? AND product_id = ?'
              ).get(tenantId, id).count;
              if (linkedImages > 0) {
                throw new Error('تأجيل حذف الصنف البعيد: توجد صور مرتبطة لم تتم مزامنة حذفها بعد.');
              }
              database.prepare('DELETE FROM product_batches WHERE tenant_id = ? AND product_id = ?').run(tenantId, id);
              database.prepare('DELETE FROM products WHERE tenant_id = ? AND id = ?').run(tenantId, id);
            } else {
              const stockUnits = parseScaledInt(row.stock_quantity ?? row.current_stock ?? row.currentStock ?? 0, QTY_SCALE, 'remoteStock');
              const stockDec = formatScaledInt(stockUnits, QTY_SCALE);
              const batchesRaw = Array.isArray(row.batches_data) ? row.batches_data : (Array.isArray(row.batches) ? row.batches : []);
              const batches = batchesRaw.map((b) => ({
                ...b,
                id: String(b.id || randomUUID()),
                productId: id,
                tenantId,
              }));
              const product = {
                id,
                tenantId,
                activityId: String(row.activity_id || row.activityId || 'grocery'),
                code: String(row.code || ''),
                barcode: row.barcode ? String(row.barcode) : undefined,
                nameAr: String(row.name_ar || row.nameAr || ''),
                category: String(row.category || 'عام'),
                unit: String(row.unit || 'حبه'),
                purchasePrice: Number(row.cost_price ?? row.purchase_price ?? row.purchasePrice ?? 0),
                sellPrice: Number(row.selling_price ?? row.sell_price ?? row.sellPrice ?? 0),
                currentStock: unitsToNumber(stockUnits, QTY_SCALE),
                minStockAlert: Number(row.min_limit ?? row.min_stock_alert ?? row.minStockAlert ?? 0),
                storageLocation: row.storage_location ? String(row.storage_location) : undefined,
                trackExpiry: Boolean(row.track_expiry ?? row.trackExpiry),
                oemNumber: row.oem_number ? String(row.oem_number) : undefined,
                isActive: row.is_active !== false && row.isActive !== false,
                batches,
              };
              database.prepare(
                `INSERT INTO products (tenant_id,id,activity_id,code,barcode,category,current_stock_decimal,data_json)
                 VALUES (?,?,?,?,?,?,?,?)
                 ON CONFLICT(tenant_id,id) DO UPDATE SET activity_id=excluded.activity_id, code=excluded.code, barcode=excluded.barcode, category=excluded.category, current_stock_decimal=excluded.current_stock_decimal, data_json=excluded.data_json`
              ).run(tenantId, product.id, product.activityId, product.code, product.barcode || null, product.category, stockDec, JSON.stringify(product));

              database.prepare('DELETE FROM product_batches WHERE tenant_id = ? AND product_id = ?').run(tenantId, product.id);
              const batchStmt = database.prepare(
                'INSERT INTO product_batches (tenant_id,id,product_id,batch_number,expiry_date,quantity_decimal,cost_price_decimal,data_json) VALUES (?,?,?,?,?,?,?,?)'
              );
              for (const b of batches) {
                const qDec = formatScaledInt(parseScaledInt(b.quantity ?? 0, QTY_SCALE, 'remoteBatchQty'), QTY_SCALE);
                const cDec = formatScaledInt(parseScaledInt(b.costPrice ?? product.purchasePrice, MONEY_SCALE, 'remoteBatchCost'), MONEY_SCALE);
                batchStmt.run(tenantId, b.id, product.id, String(b.batchNumber || ''), String(b.expiryDate || ''), qDec, cDec, JSON.stringify(b));
              }
            }
            break;
          }

          case 'PARTY': {
            const id = String(row.id || '');
            if (!id) throw new Error('معرف الطرف مفقود.');
            if (isDeleted) {
              database.prepare('DELETE FROM parties WHERE tenant_id = ? AND id = ?').run(tenantId, id);
            } else {
              const balUnits = parseScaledInt(row.balance ?? 0, MONEY_SCALE, 'remotePartyBalance');
              const balDec = formatScaledInt(balUnits, MONEY_SCALE);
              const advUnits = parseScaledInt(row.advance_balance ?? row.advanceBalance ?? 0, MONEY_SCALE, 'remotePartyAdvance');
              const advDec = formatScaledInt(advUnits, MONEY_SCALE);
              const party = {
                id,
                tenantId,
                type: String(row.type || 'CUSTOMER'),
                nameAr: String(row.name_ar || row.nameAr || ''),
                phone: String(row.phone || ''),
                address: row.address ? String(row.address) : undefined,
                taxNumber: row.tax_number ? String(row.tax_number) : undefined,
                balance: unitsToNumber(balUnits, MONEY_SCALE),
                advanceBalance: unitsToNumber(advUnits, MONEY_SCALE),
                creditLimit: row.credit_limit ? Number(row.credit_limit) : undefined,
                notes: row.notes ? String(row.notes) : undefined,
              };
              database.prepare(
                `INSERT INTO parties (tenant_id,id,party_type,name_ar,phone,balance_decimal,advance_balance_decimal,data_json)
                 VALUES (?,?,?,?,?,?,?,?)
                 ON CONFLICT(tenant_id,id) DO UPDATE SET party_type=excluded.party_type, name_ar=excluded.name_ar, phone=excluded.phone, balance_decimal=excluded.balance_decimal, advance_balance_decimal=excluded.advance_balance_decimal, data_json=excluded.data_json`
              ).run(tenantId, party.id, party.type, party.nameAr, party.phone, balDec, advDec, JSON.stringify(party));
            }
            break;
          }

          case 'INVOICE': {
            const id = String(row.id || '');
            if (!id) throw new Error('معرف الفاتورة مفقود.');
            const totalUnits = parseScaledInt(row.total ?? 0, MONEY_SCALE, 'remoteInvTotal');
            const paidUnits = parseScaledInt(row.paid_amount ?? row.paidAmount ?? 0, MONEY_SCALE, 'remoteInvPaid');
            const advAppliedUnits = parseScaledInt(
              row.advance_applied_amount ?? row.advanceAppliedAmount ?? 0,
              MONEY_SCALE,
              'remoteInvAdvApplied'
            );
            const dueDate = row.due_date ? String(row.due_date) : row.dueDate ? String(row.dueDate) : undefined;
            const inv = {
              id,
              tenantId,
              branchId: fallbackBranchId,
              invoiceNumber: String(row.invoice_number || row.invoiceNumber || ''),
              type: String(row.type || 'SALE'),
              activityId: String(row.activity_id || row.activityId || 'grocery'),
              partyId: row.party_id ? String(row.party_id) : (row.partyId ? String(row.partyId) : undefined),
              partyName: String(row.party_name || row.partyName || 'نقدي'),
              date: String(row.date || new Date().toISOString().split('T')[0]),
              ...(dueDate ? { dueDate } : {}),
              items: Array.isArray(row.items) ? row.items : [],
              subtotal: Number(row.subtotal || 0),
              discount: Number(row.discount || 0),
              tax: Number(row.tax || 0),
              total: unitsToNumber(totalUnits, MONEY_SCALE),
              paidAmount: unitsToNumber(paidUnits, MONEY_SCALE),
              returnedAmount: Number(row.returned_amount ?? row.returnedAmount ?? 0),
              advanceAppliedAmount: unitsToNumber(advAppliedUnits, MONEY_SCALE),
              paymentMethod: String(row.payment_method || row.paymentMethod || 'CASH'),
              cashBoxId: String(row.cash_box_id || row.cashBoxId || 'cb-1'),
              journalEntryId: row.journal_entry_id ? String(row.journal_entry_id) : undefined,
              isPosted: row.is_posted !== false,
              status: String(row.status || 'POSTED'),
              notes: row.notes ? String(row.notes) : undefined,
            };
            database.prepare(
              `INSERT INTO invoices (tenant_id,id,branch_id,invoice_number,invoice_type,activity_id,party_id,invoice_date,due_date,payment_method,total_decimal,paid_amount_decimal,advance_applied_decimal,status,data_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(tenant_id,id) DO UPDATE SET due_date=excluded.due_date, paid_amount_decimal=excluded.paid_amount_decimal, advance_applied_decimal=excluded.advance_applied_decimal, status=excluded.status, data_json=excluded.data_json`
            ).run(
              tenantId, inv.id, inv.branchId, inv.invoiceNumber, inv.type, inv.activityId,
              inv.partyId || null, inv.date, inv.dueDate || null, inv.paymentMethod,
              formatScaledInt(totalUnits, MONEY_SCALE), formatScaledInt(paidUnits, MONEY_SCALE),
              formatScaledInt(advAppliedUnits, MONEY_SCALE), inv.status, JSON.stringify(inv)
            );
            database.prepare('DELETE FROM invoice_items WHERE tenant_id = ? AND invoice_id = ?').run(tenantId, inv.id);
            const itemStmt = database.prepare(
              'INSERT INTO invoice_items (tenant_id,invoice_id,id,product_id,quantity_decimal,unit_price_decimal,total_decimal,data_json) VALUES (?,?,?,?,?,?,?,?)'
            );
            for (const it of inv.items) {
              const qDec = formatScaledInt(parseScaledInt(it.quantity ?? 0, QTY_SCALE, 'remoteItemQty'), QTY_SCALE);
              const uDec = formatScaledInt(parseScaledInt(it.unitPrice ?? 0, MONEY_SCALE, 'remoteItemPrice'), MONEY_SCALE);
              const tDec = formatScaledInt(parseScaledInt(it.total ?? 0, MONEY_SCALE, 'remoteItemTotal'), MONEY_SCALE);
              itemStmt.run(tenantId, inv.id, String(it.id || randomUUID()), String(it.productId || ''), qDec, uDec, tDec, JSON.stringify(it));
            }
            break;
          }

          case 'JOURNAL_ENTRY': {
            const id = String(row.id || '');
            if (!id) throw new Error('معرف القيد مفقود.');
            const je = {
              id,
              tenantId,
              branchId: fallbackBranchId,
              entryNumber: String(row.entry_number || row.entryNumber || ''),
              date: String(row.date || new Date().toISOString().split('T')[0]),
              description: String(row.description || ''),
              costCenterId: String(row.cost_center_id || row.costCenterId || 'general'),
              lines: Array.isArray(row.lines) ? row.lines : [],
              status: String(row.status || 'POSTED'),
              referenceType: row.reference_type || row.referenceType || undefined,
              referenceId: row.reference_id ? String(row.reference_id) : undefined,
              reversedEntryId: row.reversed_entry_id ? String(row.reversed_entry_id) : undefined,
              reversalReason: row.reversal_reason ? String(row.reversal_reason) : undefined,
              isAutoGenerated: Boolean(row.is_auto_generated ?? row.isAutoGenerated),
            };
            database.prepare(
              `INSERT INTO journal_entries (tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json)
               VALUES (?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(tenant_id,id) DO UPDATE SET status=excluded.status, data_json=excluded.data_json`
            ).run(
              tenantId, je.id, je.branchId, je.entryNumber, je.date, je.costCenterId,
              je.status, je.referenceType || null, je.referenceId || null, JSON.stringify(je)
            );
            database.prepare('DELETE FROM journal_entry_lines WHERE tenant_id = ? AND entry_id = ?').run(tenantId, je.id);
            const lineStmt = database.prepare(
              'INSERT INTO journal_entry_lines (tenant_id,entry_id,id,account_code,debit_decimal,credit_decimal,data_json) VALUES (?,?,?,?,?,?,?)'
            );
            for (const l of je.lines) {
              const dDec = formatScaledInt(parseScaledInt(l.debit ?? 0, MONEY_SCALE, 'remoteLineDebit'), MONEY_SCALE);
              const cDec = formatScaledInt(parseScaledInt(l.credit ?? 0, MONEY_SCALE, 'remoteLineCredit'), MONEY_SCALE);
              lineStmt.run(tenantId, je.id, String(l.id || randomUUID()), String(l.accountCode || ''), dDec, cDec, JSON.stringify(l));
            }
            break;
          }

          case 'VOUCHER': {
            const id = String(row.id || '');
            if (!id) throw new Error('معرف السند مفقود.');
            const amtUnits = parseScaledInt(row.amount ?? 0, MONEY_SCALE, 'remoteVoucherAmount');
            const v = {
              id,
              tenantId,
              branchId: fallbackBranchId,
              voucherNumber: String(row.voucher_number || row.voucherNumber || ''),
              type: String(row.type || 'RECEIPT'),
              date: String(row.date || new Date().toISOString().split('T')[0]),
              amount: unitsToNumber(amtUnits, MONEY_SCALE),
              cashBoxId: String(row.cash_box_id || row.cashBoxId || 'cb-1'),
              partyId: row.party_id ? String(row.party_id) : undefined,
              partyName: String(row.party_name || row.partyName || ''),
              accountCode: String(row.account_code || row.accountCode || '1101'),
              description: String(row.description || ''),
              costCenterId: String(row.cost_center_id || row.costCenterId || 'general'),
              journalEntryId: row.journal_entry_id ? String(row.journal_entry_id) : undefined,
              status: String(row.status || 'POSTED'),
              appliedToDebtAmount: Number(row.applied_to_debt_amount ?? row.appliedToDebtAmount ?? 0),
              advanceAmount: Number(row.advance_amount ?? row.advanceAmount ?? 0),
              manualOverride: Boolean(row.manual_override ?? row.manualOverride),
              overrideReason: row.override_reason ? String(row.override_reason) : row.overrideReason ? String(row.overrideReason) : undefined,
              manualAllocations: Array.isArray(row.manual_allocations)
                ? row.manual_allocations
                : Array.isArray(row.manualAllocations)
                ? row.manualAllocations
                : undefined,
              allocations: Array.isArray(row.allocations) ? row.allocations : undefined,
            };
            database.prepare(
              `INSERT INTO vouchers (tenant_id,id,branch_id,voucher_number,voucher_type,voucher_date,amount_decimal,cash_box_id,party_id,data_json)
               VALUES (?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(tenant_id,id) DO UPDATE SET data_json=excluded.data_json`
            ).run(
              tenantId, v.id, v.branchId, v.voucherNumber, v.type, v.date,
              formatScaledInt(amtUnits, MONEY_SCALE), v.cashBoxId, v.partyId || null, JSON.stringify(v)
            );
            break;
          }

          case 'PAYMENT_ALLOCATION': {
            const id = String(row.id || '');
            if (!id) throw new Error('معرف التخصيص مفقود.');
            const allocUnits = parseScaledInt(row.allocated_amount ?? row.allocatedAmount ?? 0, MONEY_SCALE, 'remoteAllocAmount');
            const alloc = {
              id,
              tenantId,
              branchId: fallbackBranchId,
              voucherId: row.voucher_id ? String(row.voucher_id) : row.voucherId ? String(row.voucherId) : undefined,
              advanceTransactionId: row.advance_transaction_id ? String(row.advance_transaction_id) : row.advanceTransactionId ? String(row.advanceTransactionId) : undefined,
              partyId: String(row.party_id || row.partyId || ''),
              invoiceId: String(row.invoice_id || row.invoiceId || ''),
              invoiceNumber: row.invoice_number ? String(row.invoice_number) : row.invoiceNumber ? String(row.invoiceNumber) : undefined,
              invoiceDate: row.invoice_date ? String(row.invoice_date) : row.invoiceDate ? String(row.invoiceDate) : undefined,
              allocatedAmount: unitsToNumber(allocUnits, MONEY_SCALE),
              allocationMethod: String(row.allocation_method || row.allocationMethod || 'FIFO'),
              status: String(row.status || 'ACTIVE'),
              createdAt: String(row.created_at || row.createdAt || new Date().toISOString()),
              createdBy: row.created_by ? String(row.created_by) : row.createdBy ? String(row.createdBy) : undefined,
            };
            database.prepare(
              `INSERT INTO payment_allocations (tenant_id,id,branch_id,voucher_id,advance_transaction_id,party_id,invoice_id,allocated_decimal,allocation_method,status,created_at,created_by,data_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(tenant_id,id) DO UPDATE SET status=excluded.status, data_json=excluded.data_json`
            ).run(
              tenantId, alloc.id, alloc.branchId, alloc.voucherId || null, alloc.advanceTransactionId || null,
              alloc.partyId, alloc.invoiceId, formatScaledInt(allocUnits, MONEY_SCALE),
              alloc.allocationMethod, alloc.status, alloc.createdAt, alloc.createdBy || null, JSON.stringify(alloc)
            );
            break;
          }

          case 'PARTY_ADVANCE': {
            const id = String(row.id || '');
            if (!id) throw new Error('معرف السلفة مفقود.');
            const amtUnits = parseScaledInt(row.amount ?? 0, MONEY_SCALE, 'remoteAdvAmount');
            const afterUnits = parseScaledInt(row.balance_after ?? row.balanceAfter ?? 0, MONEY_SCALE, 'remoteAdvAfter');
            const adv = {
              id,
              tenantId,
              branchId: fallbackBranchId,
              partyId: String(row.party_id || row.partyId || ''),
              partyType: String(row.party_type || row.partyType || 'CUSTOMER'),
              type: String(row.tx_type || row.type || 'OVERPAYMENT_DEPOSIT'),
              amount: unitsToNumber(amtUnits, MONEY_SCALE),
              balanceAfter: unitsToNumber(afterUnits, MONEY_SCALE),
              voucherId: row.voucher_id ? String(row.voucher_id) : row.voucherId ? String(row.voucherId) : undefined,
              invoiceId: row.invoice_id ? String(row.invoice_id) : row.invoiceId ? String(row.invoiceId) : undefined,
              journalEntryId: row.journal_entry_id ? String(row.journal_entry_id) : row.journalEntryId ? String(row.journalEntryId) : undefined,
              date: String(row.tx_date || row.date || new Date().toISOString().split('T')[0]),
              description: String(row.description || ''),
              createdBy: row.created_by ? String(row.created_by) : row.createdBy ? String(row.createdBy) : undefined,
              createdAt: String(row.created_at || row.createdAt || new Date().toISOString()),
            };
            database.prepare(
              `INSERT INTO party_advance_transactions (tenant_id,id,branch_id,party_id,party_type,tx_type,amount_decimal,balance_after_decimal,voucher_id,invoice_id,journal_entry_id,tx_date,created_at,data_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(tenant_id,id) DO UPDATE SET data_json=excluded.data_json`
            ).run(
              tenantId, adv.id, adv.branchId, adv.partyId, adv.partyType, adv.type,
              formatScaledInt(amtUnits, MONEY_SCALE), formatScaledInt(afterUnits, MONEY_SCALE),
              adv.voucherId || null, adv.invoiceId || null, adv.journalEntryId || null,
              adv.date, adv.createdAt, JSON.stringify(adv)
            );
            break;
          }

          case 'ALLOCATION_AUDIT': {
            const id = String(row.id || '');
            if (!id) throw new Error('معرف تدقيق التخصيص مفقود.');
            const audit = {
              id,
              tenantId,
              branchId: fallbackBranchId,
              voucherId: String(row.voucher_id || row.voucherId || ''),
              partyId: String(row.party_id || row.partyId || ''),
              userId: String(row.user_id || row.userId || ''),
              userName: String(row.user_name || row.userName || ''),
              reason: String(row.reason || ''),
              previousAllocations: Array.isArray(row.previous_allocations)
                ? row.previous_allocations
                : Array.isArray(row.previousAllocations)
                ? row.previousAllocations
                : [],
              newAllocations: Array.isArray(row.new_allocations)
                ? row.new_allocations
                : Array.isArray(row.newAllocations)
                ? row.newAllocations
                : [],
              timestamp: String(row.audit_timestamp || row.timestamp || new Date().toISOString()),
            };
            database.prepare(
              `INSERT INTO allocation_audits (tenant_id,id,branch_id,voucher_id,party_id,user_id,audit_timestamp,data_json)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(tenant_id,id) DO UPDATE SET data_json=excluded.data_json`
            ).run(
              tenantId, audit.id, audit.branchId, audit.voucherId, audit.partyId,
              audit.userId, audit.timestamp, JSON.stringify(audit)
            );
            break;
          }

          case 'AMANAT': {
            const id = String(row.id || '');
            if (!id) throw new Error('معرف الأمانة مفقود.');
            const amtUnits = parseScaledInt(row.amount ?? 0, MONEY_SCALE, 'remoteAmanatAmount');
            const a = {
              id,
              tenantId,
              branchId: fallbackBranchId,
              recordNumber: String(row.record_number || row.recordNumber || ''),
              type: String(row.type || 'CASH'),
              depositorName: String(row.depositor_name || row.depositorName || ''),
              depositorPhone: String(row.depositor_phone || row.depositorPhone || ''),
              status: String(row.status || 'HELD'),
              receivedDate: String(row.received_date || row.receivedDate || ''),
              expectedReturnDate: row.expected_return_date ? String(row.expected_return_date) : undefined,
              amount: unitsToNumber(amtUnits, MONEY_SCALE),
              cashBoxId: row.cash_box_id ? String(row.cash_box_id) : undefined,
              itemDescription: row.item_description ? String(row.item_description) : undefined,
              itemSerial: row.serial_number ? String(row.serial_number) : undefined,
              receivedBy: String(row.received_by || row.receivedBy || 'المسؤول'),
              recipientSignatureName: row.recipient_signature_name ? String(row.recipient_signature_name) : undefined,
              notes: row.notes ? String(row.notes) : undefined,
              journalEntryId: row.journal_entry_id ? String(row.journal_entry_id) : undefined,
            };
            database.prepare(
              `INSERT INTO amanat_records (tenant_id,id,branch_id,record_number,amanat_type,status,amount_decimal,received_date,data_json)
               VALUES (?,?,?,?,?,?,?,?,?)
               ON CONFLICT(tenant_id,id) DO UPDATE SET status=excluded.status, data_json=excluded.data_json`
            ).run(
              tenantId, a.id, a.branchId, a.recordNumber, a.type, a.status,
              formatScaledInt(amtUnits, MONEY_SCALE), a.receivedDate, JSON.stringify(a)
            );
            break;
          }

          default:
            throw new Error(`نوع كيان مزامنة غير مدعوم: ${entityType}`);
        }

        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },
  };
}
