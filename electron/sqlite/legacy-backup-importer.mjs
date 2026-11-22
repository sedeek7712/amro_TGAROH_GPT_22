import { createHash, randomUUID } from 'node:crypto';
import { createSqliteBackup } from './database.mjs';

const DEFAULT_TENANT_ID = 'tenant_main';
const MAX_BACKUP_BYTES = 200 * 1024 * 1024;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('حقل مطلوب مفقود في النسخة الاحتياطية: ' + label);
  }
  return value.trim();
}

function decimal(value, label) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) {
    throw new Error('قيمة مالية أو كمية غير صالحة: ' + label);
  }
  return String(value ?? 0);
}

function boolInt(value) {
  return value === true || value === 1 ? 1 : 0;
}

function tenantIdOf(row) {
  return typeof row.tenantId === 'string' && row.tenantId.trim()
    ? row.tenantId.trim()
    : DEFAULT_TENANT_ID;
}

function safeJson(value) {
  return JSON.stringify(value);
}

function stripPasswordHash(user) {
  const copy = { ...user };
  delete copy.passwordHash;
  return copy;
}

export function legacyChecksum(data) {
  const serialized = JSON.stringify(data);
  let checksum = 0;
  for (let index = 0; index < serialized.length; index += 1) {
    checksum = (checksum + serialized.charCodeAt(index) * (index + 1)) % 1000000007;
  }
  return checksum.toString(16);
}

function financialUnits(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || Math.abs(number) > 9_000_000_000) {
    throw new Error('تعذر التحقق من إجمالي مالي خارج النطاق المسموح.');
  }
  return BigInt(Math.round(number * 1_000_000));
}

function sumUnits(values) {
  return values.reduce((total, value) => total + financialUnits(value), 0n);
}

export function formatUnits(units) {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / 1_000_000n;
  const fractional = String(absolute % 1_000_000n).padStart(6, '0');
  return (negative ? '-' : '') + whole.toString() + '.' + fractional;
}

function buildBatchList(data) {
  const byId = new Map();
  const insert = (batch, source) => {
    if (!isObject(batch)) throw new Error('يوجد سجل تشغيلة غير صالح داخل ' + source);
    const id = requiredString(batch.id, source + '.id');
    const normalized = safeJson(batch);
    const existing = byId.get(id);
    if (existing && existing.normalized !== normalized) {
      throw new Error('تعارض في بيانات تشغيلة المخزون ذات المعرف: ' + id);
    }
    if (!existing) byId.set(id, { value: batch, normalized });
  };

  for (const batch of data.productBatches) insert(batch, 'productBatches');
  for (const product of data.products) {
    if (Array.isArray(product.batches)) {
      for (const batch of product.batches) insert(batch, 'products.batches');
    }
  }
  return [...byId.values()].map((item) => item.value);
}

export function parseLegacyBackup(rawBackup) {
  if (typeof rawBackup !== 'string' || rawBackup.length === 0) {
    throw new Error('لم يتم اختيار ملف نسخة احتياطية.');
  }
  if (Buffer.byteLength(rawBackup, 'utf8') > MAX_BACKUP_BYTES) {
    throw new Error('حجم ملف النسخة الاحتياطية يتجاوز الحد المسموح (200 ميجابايت).');
  }

  let backup;
  try {
    backup = JSON.parse(rawBackup);
  } catch {
    throw new Error('ملف النسخة الاحتياطية ليس JSON صالحاً.');
  }
  if (!isObject(backup) || !isObject(backup.data)) {
    throw new Error('بنية النسخة الاحتياطية غير مكتملة.');
  }
  if (
    backup.systemIdentifier !== 'multi_activity_erp' &&
    backup.systemIdentifier !== 'alharaj_erp'
  ) {
    throw new Error('النسخة لا تنتمي إلى نظام الإدارة المدعوم.');
  }
  if (typeof backup.checksum !== 'string' || legacyChecksum(backup.data) !== backup.checksum) {
    throw new Error('فشل التحقق من Checksum النسخة الاحتياطية؛ تم إيقاف الاستيراد.');
  }

  const keys = [
    'branches', 'accounts', 'activities', 'products', 'parties', 'invoices',
    'journalEntries', 'cashBoxes', 'vouchers', 'amanat', 'users', 'auditLogs',
    'outbox', 'syncConflicts', 'sequences',
  ];
  const data = {};
  for (const key of keys) {
    if (!Array.isArray(backup.data[key])) {
      throw new Error('النسخة الاحتياطية ناقصة: القائمة ' + key + ' غير موجودة.');
    }
    if (!backup.data[key].every(isObject)) {
      throw new Error('توجد سجلات غير صالحة في القائمة: ' + key);
    }
    data[key] = backup.data[key];
  }
  data.productBatches = Array.isArray(backup.data.productBatches)
    ? backup.data.productBatches
    : [];
  if (!data.productBatches.every(isObject)) {
    throw new Error('توجد سجلات تشغيلات غير صالحة.');
  }
  data.productBatches = buildBatchList(data);

  for (const optKey of ['paymentAllocations', 'partyAdvanceTransactions', 'allocationAudits']) {
    const rawList = backup.data[optKey];
    if (rawList !== undefined) {
      if (!Array.isArray(rawList) || !rawList.every(isObject)) {
        throw new Error('توجد سجلات غير صالحة في القائمة: ' + optKey);
      }
      data[optKey] = rawList;
    } else {
      data[optKey] = [];
    }
  }

  const tenantIds = new Set([DEFAULT_TENANT_ID]);
  for (const list of Object.values(data)) {
    for (const row of list) tenantIds.add(tenantIdOf(row));
  }

  return {
    backup,
    data,
    tenantIds: [...tenantIds],
    sourceChecksum: createHash('sha256').update(rawBackup, 'utf8').digest('hex'),
  };
}

function countRows(database, table, tenantId) {
  const allowedTables = new Set([
    'branches', 'accounts', 'activities', 'products', 'product_batches',
    'parties', 'invoices', 'journal_entries', 'cash_boxes', 'vouchers',
    'payment_allocations', 'party_advance_transactions', 'allocation_audits',
    'amanat_records', 'users', 'audit_logs', 'outbox_queue', 'sync_conflicts',
    'document_sequences',
  ]);
  if (!allowedTables.has(table)) throw new Error('Invalid table name');
  return database.prepare('SELECT COUNT(*) AS count FROM ' + table + ' WHERE tenant_id=?')
    .get(tenantId).count;
}

function assertEmptyDestination(database, tenantIds) {
  const protectedTables = [
    'accounts', 'activities', 'products', 'product_batches', 'parties',
    'invoices', 'invoice_items', 'invoice_stock_deductions',
    'journal_entries', 'journal_entry_lines', 'cash_boxes', 'vouchers',
    'payment_allocations', 'party_advance_transactions', 'allocation_audits',
    'amanat_records', 'users', 'audit_logs', 'outbox_queue', 'sync_conflicts',
    'document_sequences',
  ];
  for (const table of protectedTables) {
    const count = database.prepare('SELECT COUNT(*) AS count FROM ' + table).get().count;
    if (count > 0) {
      throw new Error('قاعدة SQLite تحتوي بيانات فعلية بالفعل (' + table + '). لن نستبدلها أو ندمجها تلقائياً.');
    }
  }

  // A fresh app database contains exactly the built-in main tenant and branch.
  const tenants = database.prepare('SELECT id FROM tenants ORDER BY id').all();
  if (tenants.length !== 1 || tenants[0].id !== DEFAULT_TENANT_ID) {
    throw new Error('قاعدة SQLite تحتوي منشآت قائمة؛ لن نستورد فوقها تلقائياً.');
  }
  const branches = database.prepare(
    'SELECT id FROM branches WHERE tenant_id=? ORDER BY id'
  ).all(DEFAULT_TENANT_ID);
  if (branches.length !== 1 || branches[0].id !== 'branch_main') {
    throw new Error('قاعدة SQLite تحتوي فروعاً قائمة؛ لن نستورد فوقها تلقائياً.');
  }

  const imports = database.prepare('SELECT COUNT(*) AS count FROM legacy_imports').get().count;
  if (imports > 0) throw new Error('سبق استيراد نسخة احتياطية إلى قاعدة البيانات هذه.');
  if (!Array.isArray(tenantIds) || !tenantIds.includes(DEFAULT_TENANT_ID)) {
    throw new Error('النسخة الاحتياطية لا تحتوي منشأة رئيسية معتمدة.');
  }
}
export function sourceCounts(data) {
  return {
    branches: data.branches.length,
    accounts: data.accounts.length,
    activities: data.activities.length,
    products: data.products.length,
    productBatches: data.productBatches.length,
    parties: data.parties.length,
    invoices: data.invoices.length,
    invoiceItems: data.invoices.reduce((n, row) => n + (Array.isArray(row.items) ? row.items.length : 0), 0),
    journalEntries: data.journalEntries.length,
    journalEntryLines: data.journalEntries.reduce((n, row) => n + (Array.isArray(row.lines) ? row.lines.length : 0), 0),
    cashBoxes: data.cashBoxes.length,
    vouchers: data.vouchers.length,
    paymentAllocations: (data.paymentAllocations || []).length,
    partyAdvanceTransactions: (data.partyAdvanceTransactions || []).length,
    allocationAudits: (data.allocationAudits || []).length,
    amanat: data.amanat.length,
    users: data.users.length,
    auditLogs: data.auditLogs.length,
    outbox: data.outbox.length,
    syncConflicts: data.syncConflicts.length,
    sequences: data.sequences.length,
  };
}

export function sourceFinancialTotals(data) {
  return {
    invoiceTotal: sumUnits(data.invoices.map((row) => row.total)),
    invoicePaid: sumUnits(data.invoices.map((row) => row.paidAmount)),
    journalDebit: sumUnits(data.journalEntries.flatMap((row) => (row.lines || []).map((line) => line.debit))),
    journalCredit: sumUnits(data.journalEntries.flatMap((row) => (row.lines || []).map((line) => line.credit))),
    cashBoxes: sumUnits(data.cashBoxes.map((row) => row.balance)),
    partyBalances: sumUnits(data.parties.map((row) => row.balance)),
    accountBalances: sumUnits(data.accounts.map((row) => row.balance)),
    voucherAmounts: sumUnits(data.vouchers.map((row) => row.amount)),
    amanatAmounts: sumUnits(data.amanat.map((row) => row.amount)),
  };
}

export function databaseFinancialTotals(database, tenantIds) {
  const rows = (table, column) => {
    const result = [];
    for (const tenantId of tenantIds) {
      result.push(...database.prepare('SELECT ' + column + ' AS value FROM ' + table + ' WHERE tenant_id=?')
        .all(tenantId).map((row) => row.value));
    }
    return result;
  };
  return {
    invoiceTotal: sumUnits(rows('invoices', 'total_decimal')),
    invoicePaid: sumUnits(rows('invoices', 'paid_amount_decimal')),
    journalDebit: sumUnits(rows('journal_entry_lines', 'debit_decimal')),
    journalCredit: sumUnits(rows('journal_entry_lines', 'credit_decimal')),
    cashBoxes: sumUnits(rows('cash_boxes', 'balance_decimal')),
    partyBalances: sumUnits(rows('parties', 'balance_decimal')),
    accountBalances: sumUnits(rows('accounts', 'balance_decimal')),
    voucherAmounts: sumUnits(rows('vouchers', 'amount_decimal')),
    amanatAmounts: sumUnits(rows('amanat_records', 'amount_decimal')),
  };
}

export function ensureTenants(database, tenantIds) {
  const insert = database.prepare(
    'INSERT OR IGNORE INTO tenants (id,name,code,currency,is_active,data_json) VALUES (?,?,?,?,1,?)'
  );
  for (const tenantId of tenantIds) {
    const code = tenantId === DEFAULT_TENANT_ID
      ? 'MAIN'
      : 'T' + createHash('sha1').update(tenantId).digest('hex').slice(0, 18).toUpperCase();
    insert.run(
      tenantId,
      tenantId === DEFAULT_TENANT_ID ? 'المنشأة الرئيسية' : 'منشأة مستوردة ' + tenantId,
      code,
      'YER',
      safeJson({ id: tenantId, name: 'Imported tenant', code, currency: 'YER', isActive: true })
    );
  }
}

export function insertRows(database, data, options = {}) {
  const preservedHashes = options?.preservedHashes || null;
  const run = (sql, args) => database.prepare(sql).run(...args);

  for (const row of data.branches) {
    const tenantId = tenantIdOf(row);
    run(
      'INSERT INTO branches (tenant_id,id,code,name_ar,is_main,active,data_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET code=excluded.code,name_ar=excluded.name_ar,is_main=excluded.is_main,active=excluded.active,data_json=excluded.data_json',
      [tenantId, requiredString(row.id,'branch.id'), requiredString(row.code,'branch.code'),
       requiredString(row.nameAr,'branch.nameAr'), boolInt(row.isMain), boolInt(row.active), safeJson(row)]
    );
  }

  for (const row of data.activities) {
    const tenantId = tenantIdOf(row);
    run(
      'INSERT INTO activities (tenant_id,id,code,data_json) VALUES (?,?,?,?)',
      [tenantId, requiredString(row.id,'activity.id'), requiredString(row.code,'activity.code'), safeJson(row)]
    );
  }

  for (const row of data.accounts) {
    const tenantId = tenantIdOf(row);
    const code = requiredString(row.code,'account.code');
    const type = requiredString(row.type,'account.type');
    if (!['ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE'].includes(type)) {
      throw new Error('نوع حساب غير مدعوم في النسخة: ' + type);
    }
    run(
      'INSERT INTO accounts (tenant_id,code,account_type,parent_code,is_leaf,balance_decimal,data_json) VALUES (?,?,?,?,?,?,?)',
      [tenantId, code, type, null, boolInt(row.isLeaf), decimal(row.balance,'account.balance'), safeJson(row)]
    );
  }
  for (const row of data.accounts) {
    if (row.parentCode) {
      run(
        'UPDATE accounts SET parent_code=? WHERE tenant_id=? AND code=?',
        [String(row.parentCode), tenantIdOf(row), requiredString(row.code,'account.code')]
      );
    }
  }

  for (const row of data.products) {
    run(
      'INSERT INTO products (tenant_id,id,activity_id,code,barcode,category,current_stock_decimal,data_json) VALUES (?,?,?,?,?,?,?,?)',
      [tenantIdOf(row), requiredString(row.id,'product.id'), requiredString(row.activityId,'product.activityId'),
       requiredString(row.code,'product.code'), row.barcode || null, String(row.category || ''),
       decimal(row.currentStock,'product.currentStock'), safeJson(row)]
    );
  }

  for (const row of data.productBatches) {
    run(
      'INSERT INTO product_batches (tenant_id,id,product_id,batch_number,expiry_date,quantity_decimal,cost_price_decimal,data_json) VALUES (?,?,?,?,?,?,?,?)',
      [tenantIdOf(row), requiredString(row.id,'productBatch.id'), requiredString(row.productId,'productBatch.productId'),
       requiredString(row.batchNumber,'productBatch.batchNumber'), String(row.expiryDate || ''),
       decimal(row.quantity,'productBatch.quantity'), decimal(row.costPrice,'productBatch.costPrice'), safeJson(row)]
    );
  }

  for (const row of data.parties) {
    if (!['CUSTOMER','SUPPLIER'].includes(row.type)) throw new Error('نوع طرف غير مدعوم.');
    const normalizedParty = { ...row, advanceBalance: Number(row.advanceBalance ?? 0) };
    run(
      'INSERT INTO parties (tenant_id,id,party_type,name_ar,phone,balance_decimal,advance_balance_decimal,data_json) VALUES (?,?,?,?,?,?,?,?)',
      [tenantIdOf(row), requiredString(row.id,'party.id'), row.type, requiredString(row.nameAr,'party.nameAr'),
       String(row.phone || ''), decimal(row.balance,'party.balance'), decimal(row.advanceBalance ?? 0,'party.advanceBalance'), safeJson(normalizedParty)]
    );
  }

  for (const row of data.invoices) {
    if (!['SALE','PURCHASE','RETURN_SALE','RETURN_PURCHASE'].includes(row.type)) {
      throw new Error('نوع فاتورة غير مدعوم: ' + String(row.type));
    }
    if (!['CASH','CREDIT','BANK_TRANSFER'].includes(row.paymentMethod)) {
      throw new Error('طريقة سداد غير مدعومة في الفاتورة: ' + String(row.paymentMethod));
    }
    const tenantId = tenantIdOf(row);
    const invoiceId = requiredString(row.id,'invoice.id');
    run(
      'INSERT INTO invoices (tenant_id,id,branch_id,invoice_number,invoice_type,activity_id,party_id,invoice_date,due_date,payment_method,total_decimal,paid_amount_decimal,advance_applied_decimal,status,data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [tenantId, invoiceId, row.branchId || null, requiredString(row.invoiceNumber,'invoice.invoiceNumber'),
       row.type, requiredString(row.activityId,'invoice.activityId'), row.partyId || null,
       requiredString(row.date,'invoice.date'), row.dueDate || null, row.paymentMethod, decimal(row.total,'invoice.total'),
       decimal(row.paidAmount,'invoice.paidAmount'), decimal(row.advanceAppliedAmount ?? 0,'invoice.advanceAppliedAmount'),
       row.status || (row.isPosted === false ? 'DRAFT' : 'POSTED'), safeJson(row)]
    );
    for (const item of row.items || []) {
      run(
        'INSERT INTO invoice_items (tenant_id,invoice_id,id,product_id,quantity_decimal,unit_price_decimal,total_decimal,data_json) VALUES (?,?,?,?,?,?,?,?)',
        [tenantId, invoiceId, requiredString(item.id,'invoiceItem.id'), requiredString(item.productId,'invoiceItem.productId'),
         decimal(item.quantity,'invoiceItem.quantity'), decimal(item.unitPrice,'invoiceItem.unitPrice'),
         decimal(item.total,'invoiceItem.total'), safeJson(item)]
      );
    }
    for (let index = 0; index < (row.stockDeductionsRecorded || []).length; index += 1) {
      const deduction = row.stockDeductionsRecorded[index];
      run(
        'INSERT INTO invoice_stock_deductions (tenant_id,invoice_id,line_number,product_id,batch_number,quantity_decimal,unit_cost_decimal,data_json) VALUES (?,?,?,?,?,?,?,?)',
        [tenantId, invoiceId, index, requiredString(deduction.productId,'stockDeduction.productId'),
         deduction.batchNumber || null, decimal(deduction.quantity,'stockDeduction.quantity'),
         decimal(deduction.unitCost,'stockDeduction.unitCost'), safeJson(deduction)]
      );
    }
  }

  for (const row of data.journalEntries) {
    if (!['DRAFT','POSTED','REVERSED'].includes(row.status)) {
      throw new Error('حالة قيد غير مدعومة: ' + String(row.status));
    }
    const tenantId = tenantIdOf(row);
    const entryId = requiredString(row.id,'journalEntry.id');
    run(
      'INSERT INTO journal_entries (tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [tenantId, entryId, row.branchId || null, requiredString(row.entryNumber,'journalEntry.entryNumber'),
       requiredString(row.date,'journalEntry.date'), requiredString(row.costCenterId,'journalEntry.costCenterId'),
       row.status, row.referenceType || null, row.referenceId || null, safeJson(row)]
    );
    for (const line of row.lines || []) {
      run(
        'INSERT INTO journal_entry_lines (tenant_id,entry_id,id,account_code,debit_decimal,credit_decimal,data_json) VALUES (?,?,?,?,?,?,?)',
        [tenantId, entryId, requiredString(line.id,'journalEntryLine.id'),
         requiredString(line.accountCode,'journalEntryLine.accountCode'),
         decimal(line.debit,'journalEntryLine.debit'), decimal(line.credit,'journalEntryLine.credit'), safeJson(line)]
      );
    }
  }

  for (const row of data.cashBoxes) {
    run(
      'INSERT INTO cash_boxes (tenant_id,id,branch_id,code,account_code,balance_decimal,data_json) VALUES (?,?,?,?,?,?,?)',
      [tenantIdOf(row), requiredString(row.id,'cashBox.id'), row.branchId || null,
       requiredString(row.code,'cashBox.code'), requiredString(row.accountCode,'cashBox.accountCode'),
       decimal(row.balance,'cashBox.balance'), safeJson(row)]
    );
  }

  for (const row of data.vouchers) {
    if (!['RECEIPT','PAYMENT'].includes(row.type)) throw new Error('نوع سند غير مدعوم.');
    const normalizedVoucher = { ...row, status: row.status || 'POSTED' };
    run(
      'INSERT INTO vouchers (tenant_id,id,branch_id,voucher_number,voucher_type,voucher_date,amount_decimal,cash_box_id,party_id,data_json) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [tenantIdOf(row), requiredString(row.id,'voucher.id'), row.branchId || null,
       requiredString(row.voucherNumber,'voucher.voucherNumber'), row.type,
       requiredString(row.date,'voucher.date'), decimal(row.amount,'voucher.amount'),
       requiredString(row.cashBoxId,'voucher.cashBoxId'), row.partyId || null, safeJson(normalizedVoucher)]
    );
  }

  for (const row of data.paymentAllocations || []) {
    run(
      'INSERT INTO payment_allocations (tenant_id,id,branch_id,voucher_id,advance_transaction_id,party_id,invoice_id,allocated_decimal,allocation_method,status,created_at,created_by,data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [tenantIdOf(row), requiredString(row.id,'paymentAllocation.id'), row.branchId || null,
       row.voucherId || null, row.advanceTransactionId || null,
       requiredString(row.partyId,'paymentAllocation.partyId'), requiredString(row.invoiceId,'paymentAllocation.invoiceId'),
       decimal(row.allocatedAmount,'paymentAllocation.allocatedAmount'),
       String(row.allocationMethod || 'FIFO'), String(row.status || 'ACTIVE'),
       requiredString(row.createdAt,'paymentAllocation.createdAt'), row.createdBy || null, safeJson(row)]
    );
  }

  for (const row of data.partyAdvanceTransactions || []) {
    run(
      'INSERT INTO party_advance_transactions (tenant_id,id,branch_id,party_id,party_type,tx_type,amount_decimal,balance_after_decimal,voucher_id,invoice_id,journal_entry_id,tx_date,created_at,data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [tenantIdOf(row), requiredString(row.id,'partyAdvance.id'), row.branchId || null,
       requiredString(row.partyId,'partyAdvance.partyId'), String(row.partyType || 'CUSTOMER'),
       requiredString(row.type,'partyAdvance.type'), decimal(row.amount,'partyAdvance.amount'),
       decimal(row.balanceAfter,'partyAdvance.balanceAfter'), row.voucherId || null, row.invoiceId || null,
       row.journalEntryId || null, requiredString(row.date,'partyAdvance.date'),
       requiredString(row.createdAt,'partyAdvance.createdAt'), safeJson(row)]
    );
  }

  for (const row of data.allocationAudits || []) {
    run(
      'INSERT INTO allocation_audits (tenant_id,id,branch_id,voucher_id,party_id,user_id,audit_timestamp,data_json) VALUES (?,?,?,?,?,?,?,?)',
      [tenantIdOf(row), requiredString(row.id,'allocationAudit.id'), row.branchId || null,
       requiredString(row.voucherId,'allocationAudit.voucherId'), requiredString(row.partyId,'allocationAudit.partyId'),
       requiredString(row.userId,'allocationAudit.userId'), requiredString(row.timestamp,'allocationAudit.timestamp'), safeJson(row)]
    );
  }

  for (const row of data.amanat) {
    if (!['CASH','ITEM'].includes(row.type)) throw new Error('نوع أمانة غير مدعوم.');
    if (!['HELD','RETURNED','CANCELLED'].includes(row.status)) throw new Error('حالة أمانة غير مدعومة.');
    run(
      'INSERT INTO amanat_records (tenant_id,id,branch_id,record_number,amanat_type,status,amount_decimal,received_date,data_json) VALUES (?,?,?,?,?,?,?,?,?)',
      [tenantIdOf(row), requiredString(row.id,'amanat.id'), row.branchId || null,
       requiredString(row.recordNumber,'amanat.recordNumber'), row.type, row.status,
       decimal(row.amount,'amanat.amount'), requiredString(row.receivedDate,'amanat.receivedDate'), safeJson(row)]
    );
  }

  for (const row of data.users) {
    if (!['ADMIN','ACCOUNTANT','CASHIER','INVENTORY_KEEPER'].includes(row.role)) {
      throw new Error('دور مستخدم غير مدعوم: ' + String(row.role));
    }
    const tenantId = tenantIdOf(row);
    const uid = requiredString(row.id, 'user.id');
    const uname = requiredString(row.username, 'user.username');
    const preservedHash = preservedHashes
      ? (preservedHashes.byId.get(`${tenantId}:${uid}`) || preservedHashes.byUsername.get(`${tenantId}:${uname.toLowerCase()}`) || null)
      : null;
    const finalHash = row.passwordHash || preservedHash || null;
    run(
      'INSERT INTO users (tenant_id,id,branch_id,username,role,active,password_hash,data_json) VALUES (?,?,?,?,?,?,?,?)',
      [tenantId, uid, row.branchId || null,
       uname, row.role, boolInt(row.active),
       finalHash, safeJson(stripPasswordHash(row))]
    );
  }

  for (const row of data.auditLogs) {
    run(
      'INSERT INTO audit_logs (tenant_id,id,branch_id,timestamp,user_id,action,details,data_json) VALUES (?,?,?,?,?,?,?,?)',
      [tenantIdOf(row), requiredString(row.id,'auditLog.id'), row.branchId || null,
       requiredString(row.timestamp,'auditLog.timestamp'), requiredString(row.userId,'auditLog.userId'),
       requiredString(row.action,'auditLog.action'), String(row.details || ''), safeJson(row)]
    );
  }

  for (const row of data.outbox) {
    run(
      'INSERT INTO outbox_queue (tenant_id,id,branch_id,entity_type,entity_id,action,status,idempotency_key,retry_count,priority,created_at,next_retry_at,lease_owner,lease_expires_at,payload_json,data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [tenantIdOf(row), requiredString(row.id,'outbox.id'), row.branchId || null,
       requiredString(row.entityType,'outbox.entityType'), requiredString(row.entityId,'outbox.entityId'),
       row.action, row.status, requiredString(row.idempotencyKey,'outbox.idempotencyKey'),
       Number.isInteger(row.retryCount) ? row.retryCount : 0,
       Number.isInteger(row.priority) ? row.priority : 3,
       requiredString(row.createdAt,'outbox.createdAt'), row.nextRetryAt || null,
       row.leaseOwner || null, row.leaseExpiresAt || null,
       safeJson(row.payload || {}), safeJson(row)]
    );
  }

  for (const row of data.syncConflicts) {
    run(
      'INSERT INTO sync_conflicts (tenant_id,id,branch_id,entity_type,entity_id,status,detected_at,local_payload_json,remote_payload_json,data_json) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [tenantIdOf(row), requiredString(row.id,'syncConflict.id'), row.branchId || null,
       requiredString(row.entityType,'syncConflict.entityType'), requiredString(row.entityId,'syncConflict.entityId'),
       row.status, requiredString(row.detectedAt,'syncConflict.detectedAt'),
       safeJson(row.localPayload || {}), safeJson(row.remotePayload || {}), safeJson(row)]
    );
  }

  for (const row of data.sequences) {
    run(
      'INSERT INTO document_sequences (tenant_id,sequence_key,last_seq,updated_at) VALUES (?,?,?,?)',
      [tenantIdOf(row), requiredString(row.key,'sequence.key'),
       Number.isSafeInteger(row.lastSeq) ? row.lastSeq : 0,
       requiredString(row.updatedAt,'sequence.updatedAt')]
    );
  }
}

export function actualCounts(database, tenantIds) {
  const result = {};
  const mapping = {
    branches: 'branches',
    accounts: 'accounts',
    activities: 'activities',
    products: 'products',
    productBatches: 'product_batches',
    parties: 'parties',
    invoices: 'invoices',
    journalEntries: 'journal_entries',
    cashBoxes: 'cash_boxes',
    vouchers: 'vouchers',
    paymentAllocations: 'payment_allocations',
    partyAdvanceTransactions: 'party_advance_transactions',
    allocationAudits: 'allocation_audits',
    amanat: 'amanat_records',
    users: 'users',
    auditLogs: 'audit_logs',
    outbox: 'outbox_queue',
    syncConflicts: 'sync_conflicts',
    sequences: 'document_sequences',
  };
  for (const [key, table] of Object.entries(mapping)) {
    result[key] = tenantIds.reduce((sum, tenantId) => sum + countRows(database, table, tenantId), 0);
  }
  result.invoiceItems = tenantIds.reduce((sum, tenantId) =>
    sum + database.prepare('SELECT COUNT(*) AS count FROM invoice_items WHERE tenant_id=?').get(tenantId).count, 0);
  result.journalEntryLines = tenantIds.reduce((sum, tenantId) =>
    sum + database.prepare('SELECT COUNT(*) AS count FROM journal_entry_lines WHERE tenant_id=?').get(tenantId).count, 0);
  return result;
}

export function previewLegacyBackup(rawBackup) {
  const parsed = parseLegacyBackup(rawBackup);
  const counts = sourceCounts(parsed.data);
  const totals = sourceFinancialTotals(parsed.data);
  return {
    sourceSystem: parsed.backup.systemIdentifier,
    sourceVersion: String(parsed.backup.version || 'unknown'),
    exportedAt: parsed.backup.exportedAt || null,
    tenants: parsed.tenantIds.length,
    sourceChecksum: parsed.sourceChecksum,
    rowCounts: counts,
    financialTotals: Object.fromEntries(
      Object.entries(totals).map(([key, value]) => [key, formatUnits(value)])
    ),
  };
}

export async function importLegacyBackup(database, backupDirectory, rawBackup) {
  const parsed = parseLegacyBackup(rawBackup);
  assertEmptyDestination(database, parsed.tenantIds);
  const beforeBackupPath = await createSqliteBackup(database, backupDirectory, {
    prefix: 'before-legacy-import',
  });

  const expectedCounts = sourceCounts(parsed.data);
  const expectedTotals = sourceFinancialTotals(parsed.data);
  const importId = randomUUID();
  const importedAt = new Date().toISOString();

  database.exec('BEGIN IMMEDIATE');
  try {
    ensureTenants(database, parsed.tenantIds);
    insertRows(database, parsed.data);

    const resultingCounts = actualCounts(database, parsed.tenantIds);
    for (const [key, expected] of Object.entries(expectedCounts)) {
      if (resultingCounts[key] !== expected) {
        throw new Error('عدد السجلات بعد الاستيراد غير مطابق في ' + key +
          ' (النسخة: ' + expected + '، قاعدة البيانات: ' + resultingCounts[key] + ').');
      }
    }

    const resultingTotals = databaseFinancialTotals(database, parsed.tenantIds);
    for (const [key, expected] of Object.entries(expectedTotals)) {
      if (resultingTotals[key] !== expected) {
        throw new Error('الإجمالي المالي بعد الاستيراد غير مطابق في ' + key + '.');
      }
    }

    database.prepare(
      'INSERT INTO legacy_imports (id,tenant_id,source_system,source_version,source_checksum,imported_at,row_counts_json,financial_totals_json,backup_filename) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(
      importId,
      parsed.tenantIds[0] || DEFAULT_TENANT_ID,
      parsed.backup.systemIdentifier,
      String(parsed.backup.version || 'unknown'),
      parsed.sourceChecksum,
      importedAt,
      safeJson(resultingCounts),
      safeJson(Object.fromEntries(Object.entries(resultingTotals).map(([key, value]) => [key, formatUnits(value)]))),
      beforeBackupPath.split(/[\\/]/).pop()
    );

    database.exec('COMMIT');
    return {
      success: true,
      importId,
      importedAt,
      backupFilename: beforeBackupPath.split(/[\\/]/).pop(),
      rowCounts: resultingCounts,
      financialTotals: Object.fromEntries(
        Object.entries(resultingTotals).map(([key, value]) => [key, formatUnits(value)])
      ),
    };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
