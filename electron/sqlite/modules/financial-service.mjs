import { randomUUID } from 'node:crypto';
import {
  assertBranchAccess,
  assertPermission,
  filterRecordsByBranchScope,
} from '../rbac.mjs';
import {
  MONEY_SCALE,
  QTY_SCALE,
  TOTALS_SCALE,
  divBigIntHalfUp,
  formatScaledInt,
  mulScaledHalfUp,
  parseScaledInt,
  unitsToNumber,
} from '../money.mjs';
import {
  allocateSequenceTx,
  enqueueOutboxTx,
  getAppSetting,
  parseRowJson,
  writeAuditLogTx,
} from './core-service.mjs';
import {
  loadProductWithBatches,
  syncProductAndBatchesTx,
} from './inventory-parties-service.mjs';

const CURRENCY_SYMBOLS = {
  YER: 'ر.ي',
  SAR: 'ر.س',
  USD: '$',
  AED: 'د.إ',
  EGP: 'ج.م',
  OMR: 'ر.ع',
  KWD: 'د.ك',
};

const ACTIVITY_REVENUE_ACCOUNTS = {
  pharmacy: '4101',
  grocery: '4102',
  bike_parts: '4103',
  equipment_parts: '4104',
};

const ACTIVITY_INVENTORY_ACCOUNTS = {
  pharmacy: '11041',
  grocery: '11042',
  bike_parts: '11043',
  equipment_parts: '11044',
};

const ACTIVITY_COGS_ACCOUNTS = {
  pharmacy: '5101',
  grocery: '5102',
  bike_parts: '5103',
  equipment_parts: '5104',
};

export class FinancialValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FinancialValidationError';
    this.code = 'FINANCIAL_VALIDATION_ERROR';
  }
}

function getCurrencySymbol(database, tenantId) {
  const profile = getAppSetting(database, tenantId, 'company_profile', null);
  if (profile && typeof profile.currencySymbol === 'string' && profile.currencySymbol.trim()) {
    return profile.currencySymbol.trim();
  }
  const code = profile && typeof profile.currencyCode === 'string' ? profile.currencyCode : 'YER';
  return CURRENCY_SYMBOLS[code] || 'ر.ي';
}

function getTerminalCodeValue(database, tenantId) {
  const saved = getAppSetting(database, tenantId, 'terminal_code', 'POS01');
  return typeof saved === 'string' && saved.trim() ? saved.trim() : 'POS01';
}

function resolveBranchTx(database, core, actor, requestedBranchId) {
  const candidate = requestedBranchId && String(requestedBranchId).trim()
    ? String(requestedBranchId).trim()
    : core.getActiveBranchId(actor);
  assertBranchAccess(actor, candidate);
  const row = database.prepare(
    'SELECT id, code, name_ar, active, data_json FROM branches WHERE tenant_id = ? AND id = ?'
  ).get(actor.tenantId, candidate);
  if (!row || row.active !== 1) {
    throw new FinancialValidationError('الفرع المحدد غير موجود أو غير نشط.');
  }
  return {
    ...parseRowJson(row),
    id: row.id,
    code: row.code,
    nameAr: row.name_ar,
    active: row.active === 1,
  };
}

function getCashBoxRowTx(database, tenantId, cashBoxId) {
  if (!cashBoxId || !String(cashBoxId).trim()) return undefined;
  const row = database.prepare(
    'SELECT tenant_id,id,branch_id,code,account_code,balance_decimal,data_json FROM cash_boxes WHERE tenant_id = ? AND id = ?'
  ).get(tenantId, String(cashBoxId).trim());
  if (!row) return undefined;
  const balUnits = parseScaledInt(row.balance_decimal, MONEY_SCALE, 'cashBoxBalance');
  return {
    ...parseRowJson(row),
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id || '',
    code: row.code,
    accountCode: row.account_code,
    balance: unitsToNumber(balUnits, MONEY_SCALE),
    _balanceUnits: balUnits,
  };
}

function assertCashBoxBranchAccessTx(actor, cashBox, targetBranchId) {
  if (!cashBox) {
    throw new FinancialValidationError('الصندوق المحدد غير موجود.');
  }
  if (cashBox.isCentral) {
    assertPermission(actor, 'cashbox:central_access', 'الوصول إلى الصندوق المركزي');
    return;
  }
  const boxBranchId = String(cashBox.branchId || '').trim();
  if (!boxBranchId) {
    throw new FinancialValidationError('الصندوق غير مربوط بفرع؛ يجب تصحيح ربطه قبل استخدامه.');
  }
  assertBranchAccess(actor, boxBranchId);
  if (boxBranchId !== targetBranchId) {
    throw new FinancialValidationError('لا يمكن تنفيذ حركة مالية على صندوق تابع لفرع آخر.');
  }
}

function updateAccountBalanceTx(database, tenantId, accountCode, deltaUnits) {
  const row = database.prepare(
    'SELECT code, balance_decimal, data_json FROM accounts WHERE tenant_id = ? AND code = ?'
  ).get(tenantId, accountCode);
  if (!row) return null;
  const currentUnits = parseScaledInt(row.balance_decimal, MONEY_SCALE, `accountBalance(${accountCode})`);
  const nextUnits = currentUnits + deltaUnits;
  const nextNum = unitsToNumber(nextUnits, MONEY_SCALE);
  const nextDec = formatScaledInt(nextUnits, MONEY_SCALE);
  const parsed = parseRowJson(row);
  parsed.code = row.code;
  parsed.balance = nextNum;
  database.prepare(
    'UPDATE accounts SET balance_decimal = ?, data_json = ? WHERE tenant_id = ? AND code = ?'
  ).run(nextDec, JSON.stringify(parsed), tenantId, accountCode);
  return { ...parsed, balance: nextNum };
}

function updatePartyBalanceTx(database, tenantId, partyId, deltaUnits) {
  if (!partyId) return null;
  const row = database.prepare(
    'SELECT id, balance_decimal, data_json FROM parties WHERE tenant_id = ? AND id = ?'
  ).get(tenantId, partyId);
  if (!row) return null;
  const currentUnits = parseScaledInt(row.balance_decimal, MONEY_SCALE, `partyBalance(${partyId})`);
  const nextUnits = currentUnits + deltaUnits;
  const nextNum = unitsToNumber(nextUnits, MONEY_SCALE);
  const nextDec = formatScaledInt(nextUnits, MONEY_SCALE);
  const parsed = parseRowJson(row);
  parsed.id = row.id;
  parsed.balance = nextNum;
  database.prepare(
    'UPDATE parties SET balance_decimal = ?, data_json = ? WHERE tenant_id = ? AND id = ?'
  ).run(nextDec, JSON.stringify(parsed), tenantId, partyId);
  return { ...parsed, balance: nextNum };
}

function updateCashBoxBalanceTx(database, tenantId, cashBoxId, deltaUnits, requireNonNegative = false) {
  const row = database.prepare(
    'SELECT id, branch_id, code, account_code, balance_decimal, data_json FROM cash_boxes WHERE tenant_id = ? AND id = ?'
  ).get(tenantId, cashBoxId);
  if (!row) {
    throw new FinancialValidationError(`الصندوق (${cashBoxId}) غير موجود.`);
  }
  const currentUnits = parseScaledInt(row.balance_decimal, MONEY_SCALE, `cashBoxBalance(${cashBoxId})`);
  const nextUnits = currentUnits + deltaUnits;
  if (requireNonNegative && nextUnits < 0n) {
    const parsed = parseRowJson(row);
    throw new FinancialValidationError(
      `رصيد الصندوق (${parsed.nameAr || row.code}: ${unitsToNumber(currentUnits, MONEY_SCALE)}) غير كافٍ للعملية.`
    );
  }
  const nextNum = unitsToNumber(nextUnits, MONEY_SCALE);
  const nextDec = formatScaledInt(nextUnits, MONEY_SCALE);
  const parsed = parseRowJson(row);
  parsed.id = row.id;
  parsed.balance = nextNum;
  database.prepare(
    'UPDATE cash_boxes SET balance_decimal = ?, data_json = ? WHERE tenant_id = ? AND id = ?'
  ).run(nextDec, JSON.stringify(parsed), tenantId, cashBoxId);
  return { ...parsed, balance: nextNum };
}

function validateAndBuildJournalLines(database, tenantId, lines) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new FinancialValidationError('يجب أن يحتوي القيد على طرفين على الأقل (طرف مدين وطرف دائن).');
  }
  const accountRows = database.prepare('SELECT code, data_json FROM accounts WHERE tenant_id = ?').all(tenantId);
  const validMap = new Map(accountRows.map((r) => [r.code, parseRowJson(r)]));

  let totalDebitUnits = 0n;
  let totalCreditUnits = 0n;
  const cleanLines = [];

  for (const rawLine of lines) {
    const accountCode = String(rawLine?.accountCode || '').trim();
    if (!accountCode) {
      throw new FinancialValidationError('جميع أسطر القيد يجب أن تحتوي على كود حساب صالح.');
    }
    const accountObj = validMap.get(accountCode);
    if (!accountObj) {
      throw new FinancialValidationError(`الحساب المحاسبي (${accountCode}) غير معرف في الدليل المحاسبي.`);
    }

    const debitUnits = parseScaledInt(rawLine.debit ?? 0, MONEY_SCALE, `debit(${accountCode})`);
    const creditUnits = parseScaledInt(rawLine.credit ?? 0, MONEY_SCALE, `credit(${accountCode})`);

    if (debitUnits < 0n || creditUnits < 0n) {
      throw new FinancialValidationError('لا يجوز أن تحتوي أسطر القيد على قيم سالبة أو غير صالحة.');
    }
    if (debitUnits > 0n && creditUnits > 0n) {
      throw new FinancialValidationError(`السطر للحساب (${accountCode}) لا يمكن أن يحمل مدين ودائن في آن واحد.`);
    }
    if (debitUnits === 0n && creditUnits === 0n) {
      throw new FinancialValidationError(`السطر للحساب (${accountCode}) لا يمكن أن يكون صفراً في الجانبين.`);
    }

    totalDebitUnits += debitUnits;
    totalCreditUnits += creditUnits;

    cleanLines.push({
      ...rawLine,
      id: String(rawLine.id || '').trim() || randomUUID(),
      accountCode,
      accountName: rawLine.accountName || accountObj.nameAr || accountCode,
      debit: unitsToNumber(debitUnits, MONEY_SCALE),
      credit: unitsToNumber(creditUnits, MONEY_SCALE),
      costCenterId: rawLine.costCenterId || 'general',
      memo: String(rawLine.memo || ''),
      _debitUnits: debitUnits,
      _creditUnits: creditUnits,
    });
  }

  if (totalDebitUnits <= 0n) {
    throw new FinancialValidationError('إجمالي القيد المحاسبي يجب أن يكون أكبر من الصفر.');
  }
  if (totalDebitUnits !== totalCreditUnits) {
    throw new FinancialValidationError(
      `القيد غير متوازن! إجمالي المدين (${formatScaledInt(totalDebitUnits, MONEY_SCALE)}) لا يساوي إجمالي الدائن (${formatScaledInt(totalCreditUnits, MONEY_SCALE)}).`
    );
  }

  return cleanLines;
}

function insertJournalEntryTx(database, tenantId, entry) {
  if (!entry.description || !String(entry.description).trim()) {
    throw new FinancialValidationError('شرح وبيان القيد المحاسبي مطلوب.');
  }
  const cleanLinesWithUnits = validateAndBuildJournalLines(database, tenantId, entry.lines);
  const publicLines = cleanLinesWithUnits.map(({ _debitUnits, _creditUnits, ...rest }) => rest);
  const entryId = String(entry.id || '').trim() || randomUUID();
  const persisted = {
    ...entry,
    id: entryId,
    tenantId,
    description: String(entry.description).trim(),
    costCenterId: entry.costCenterId || 'general',
    status: entry.status || 'POSTED',
    lines: publicLines,
  };

  database.prepare(
    `INSERT INTO journal_entries
      (tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    tenantId,
    persisted.id,
    persisted.branchId || null,
    persisted.entryNumber,
    persisted.date,
    persisted.costCenterId,
    persisted.status,
    persisted.referenceType || null,
    persisted.referenceId || null,
    JSON.stringify(persisted)
  );

  const lineStmt = database.prepare(
    `INSERT INTO journal_entry_lines
      (tenant_id,entry_id,id,account_code,debit_decimal,credit_decimal,data_json)
     VALUES (?,?,?,?,?,?,?)`
  );
  for (let i = 0; i < cleanLinesWithUnits.length; i += 1) {
    const raw = cleanLinesWithUnits[i];
    const pub = publicLines[i];
    lineStmt.run(
      tenantId,
      persisted.id,
      pub.id,
      pub.accountCode,
      formatScaledInt(raw._debitUnits, MONEY_SCALE),
      formatScaledInt(raw._creditUnits, MONEY_SCALE),
      JSON.stringify(pub)
    );
  }

  return { persisted, linesWithUnits: cleanLinesWithUnits };
}

function hydrateJournalEntryRow(database, tenantId, row) {
  if (!row) return undefined;
  const parsed = parseRowJson(row);
  const lineRows = database.prepare(
    'SELECT id, account_code, debit_decimal, credit_decimal, data_json FROM journal_entry_lines WHERE tenant_id = ? AND entry_id = ? ORDER BY rowid ASC'
  ).all(tenantId, row.id);
  const lines = lineRows.length > 0
    ? lineRows.map((lr) => ({
        ...parseRowJson(lr),
        id: lr.id,
        accountCode: lr.account_code,
        debit: unitsToNumber(parseScaledInt(lr.debit_decimal, MONEY_SCALE, 'dbLineDebit'), MONEY_SCALE),
        credit: unitsToNumber(parseScaledInt(lr.credit_decimal, MONEY_SCALE, 'dbLineCredit'), MONEY_SCALE),
      }))
    : (Array.isArray(parsed.lines) ? parsed.lines : []);
  return {
    ...parsed,
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id || parsed.branchId || '',
    entryNumber: row.entry_number,
    date: row.entry_date,
    costCenterId: row.cost_center_id,
    status: row.status,
    referenceType: row.reference_type ?? parsed.referenceType,
    referenceId: row.reference_id ?? parsed.referenceId,
    lines,
  };
}

function hydrateInvoiceRow(database, tenantId, row) {
  if (!row) return undefined;
  const parsed = parseRowJson(row);
  const itemRows = database.prepare(
    'SELECT id, product_id, quantity_decimal, unit_price_decimal, total_decimal, data_json FROM invoice_items WHERE tenant_id = ? AND invoice_id = ? ORDER BY rowid ASC'
  ).all(tenantId, row.id);
  const deductionRows = database.prepare(
    'SELECT line_number, product_id, batch_number, quantity_decimal, unit_cost_decimal, data_json FROM invoice_stock_deductions WHERE tenant_id = ? AND invoice_id = ? ORDER BY line_number ASC'
  ).all(tenantId, row.id);

  const items = itemRows.length > 0
    ? itemRows.map((ir) => ({
        ...parseRowJson(ir),
        id: ir.id,
        productId: ir.product_id,
        quantity: unitsToNumber(parseScaledInt(ir.quantity_decimal, QTY_SCALE, 'dbInvItemQty'), QTY_SCALE),
        unitPrice: unitsToNumber(parseScaledInt(ir.unit_price_decimal, MONEY_SCALE, 'dbInvItemPrice'), MONEY_SCALE),
        total: unitsToNumber(parseScaledInt(ir.total_decimal, MONEY_SCALE, 'dbInvItemTotal'), MONEY_SCALE),
      }))
    : (Array.isArray(parsed.items) ? parsed.items : []);

  const stockDeductionsRecorded = deductionRows.length > 0
    ? deductionRows.map((dr) => ({
        ...parseRowJson(dr),
        productId: dr.product_id,
        batchNumber: dr.batch_number ?? undefined,
        quantity: unitsToNumber(parseScaledInt(dr.quantity_decimal, QTY_SCALE, 'dbDedQty'), QTY_SCALE),
        unitCost: unitsToNumber(parseScaledInt(dr.unit_cost_decimal, QTY_SCALE, 'dbDedCost'), QTY_SCALE),
      }))
    : parsed.stockDeductionsRecorded;

  return {
    ...parsed,
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id || parsed.branchId || '',
    invoiceNumber: row.invoice_number,
    type: row.invoice_type,
    activityId: row.activity_id,
    partyId: row.party_id ?? parsed.partyId,
    date: row.invoice_date,
    paymentMethod: row.payment_method,
    total: unitsToNumber(parseScaledInt(row.total_decimal, MONEY_SCALE, 'dbInvTotal'), MONEY_SCALE),
    paidAmount: unitsToNumber(parseScaledInt(row.paid_amount_decimal, MONEY_SCALE, 'dbInvPaid'), MONEY_SCALE),
    status: row.status,
    items,
    ...(stockDeductionsRecorded ? { stockDeductionsRecorded } : {}),
  };
}

function insertInvoiceTx(database, tenantId, invoice) {
  const totalUnits = parseScaledInt(invoice.total, MONEY_SCALE, 'invoice.total');
  const paidUnits = parseScaledInt(invoice.paidAmount ?? 0, MONEY_SCALE, 'invoice.paidAmount');

  const persisted = {
    ...invoice,
    tenantId,
    total: unitsToNumber(totalUnits, MONEY_SCALE),
    paidAmount: unitsToNumber(paidUnits, MONEY_SCALE),
    status: invoice.status || (invoice.isPosted === false ? 'DRAFT' : 'POSTED'),
  };

  database.prepare(
    `INSERT INTO invoices
      (tenant_id,id,branch_id,invoice_number,invoice_type,activity_id,party_id,invoice_date,payment_method,total_decimal,paid_amount_decimal,status,data_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    tenantId,
    persisted.id,
    persisted.branchId || null,
    persisted.invoiceNumber,
    persisted.type,
    persisted.activityId,
    persisted.partyId || null,
    persisted.date,
    persisted.paymentMethod,
    formatScaledInt(totalUnits, MONEY_SCALE),
    formatScaledInt(paidUnits, MONEY_SCALE),
    persisted.status,
    JSON.stringify(persisted)
  );

  const itemStmt = database.prepare(
    `INSERT INTO invoice_items
      (tenant_id,invoice_id,id,product_id,quantity_decimal,unit_price_decimal,total_decimal,data_json)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  for (const item of persisted.items || []) {
    const qtyUnits = parseScaledInt(item.quantity, QTY_SCALE, 'item.quantity');
    const unitPriceUnits = parseScaledInt(item.unitPrice ?? 0, MONEY_SCALE, 'item.unitPrice');
    const lineTotalUnits = parseScaledInt(item.total ?? 0, MONEY_SCALE, 'item.total');
    const cleanItem = {
      ...item,
      id: String(item.id || '').trim() || randomUUID(),
      quantity: unitsToNumber(qtyUnits, QTY_SCALE),
      unitPrice: unitsToNumber(unitPriceUnits, MONEY_SCALE),
      total: unitsToNumber(lineTotalUnits, MONEY_SCALE),
    };
    itemStmt.run(
      tenantId,
      persisted.id,
      cleanItem.id,
      cleanItem.productId,
      formatScaledInt(qtyUnits, QTY_SCALE),
      formatScaledInt(unitPriceUnits, MONEY_SCALE),
      formatScaledInt(lineTotalUnits, MONEY_SCALE),
      JSON.stringify(cleanItem)
    );
  }

  const dedStmt = database.prepare(
    `INSERT INTO invoice_stock_deductions
      (tenant_id,invoice_id,line_number,product_id,batch_number,quantity_decimal,unit_cost_decimal,data_json)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  const deductions = Array.isArray(persisted.stockDeductionsRecorded) ? persisted.stockDeductionsRecorded : [];
  for (let idx = 0; idx < deductions.length; idx += 1) {
    const ded = deductions[idx];
    const dQtyUnits = parseScaledInt(ded.quantity, QTY_SCALE, 'ded.quantity');
    const dCostUnits = parseScaledInt(ded.unitCost ?? 0, QTY_SCALE, 'ded.unitCost');
    const cleanDed = {
      ...ded,
      quantity: unitsToNumber(dQtyUnits, QTY_SCALE),
      unitCost: unitsToNumber(dCostUnits, QTY_SCALE),
    };
    dedStmt.run(
      tenantId,
      persisted.id,
      idx,
      cleanDed.productId,
      cleanDed.batchNumber || null,
      formatScaledInt(dQtyUnits, QTY_SCALE),
      formatScaledInt(dCostUnits, QTY_SCALE),
      JSON.stringify(cleanDed)
    );
  }

  return persisted;
}

export function createFinancialService(database, core) {
  if (!database || !core) {
    throw new TypeError('database and core service are required');
  }

  return {
    // --- الفواتير (Invoices) ---
    getInvoices(actor, activityId) {
      assertPermission(actor, 'invoices:view', 'عرض الفواتير');
      const rows = activityId && activityId !== 'all'
        ? database.prepare(
            'SELECT tenant_id,id,branch_id,invoice_number,invoice_type,activity_id,party_id,invoice_date,payment_method,total_decimal,paid_amount_decimal,status,data_json FROM invoices WHERE tenant_id = ? AND activity_id = ? ORDER BY invoice_date DESC, rowid DESC'
          ).all(actor.tenantId, String(activityId))
        : database.prepare(
            'SELECT tenant_id,id,branch_id,invoice_number,invoice_type,activity_id,party_id,invoice_date,payment_method,total_decimal,paid_amount_decimal,status,data_json FROM invoices WHERE tenant_id = ? ORDER BY invoice_date DESC, rowid DESC'
          ).all(actor.tenantId);

      const hydrated = rows.map((r) => hydrateInvoiceRow(database, actor.tenantId, r));
      return filterRecordsByBranchScope(hydrated, actor);
    },

    getInvoiceById(actor, id) {
      assertPermission(actor, 'invoices:view', 'عرض تفاصيل الفاتورة');
      if (!id) return undefined;
      const row = database.prepare(
        'SELECT tenant_id,id,branch_id,invoice_number,invoice_type,activity_id,party_id,invoice_date,payment_method,total_decimal,paid_amount_decimal,status,data_json FROM invoices WHERE tenant_id = ? AND id = ?'
      ).get(actor.tenantId, String(id));
      if (!row) return undefined;
      const hydrated = hydrateInvoiceRow(database, actor.tenantId, row);
      return filterRecordsByBranchScope([hydrated], actor)[0];
    },

    createSalesInvoiceAtomic(actor, params) {
      if (!params || typeof params !== 'object' || !params.invoice) {
        throw new FinancialValidationError('بيانات فاتورة المبيعات غير مكتملة.');
      }
      assertPermission(actor, 'pos:sale', 'إصدار فاتورة مبيعات');
      const rawInvoice = params.invoice;
      const stockDeductions = Array.isArray(params.stockDeductions) ? params.stockDeductions : [];
      const clientRequestId = params.clientRequestId ? String(params.clientRequestId).trim() : '';

      const tenantId = actor.tenantId;
      const activeBranch = resolveBranchTx(database, core, actor, rawInvoice.branchId);
      const branchId = activeBranch.id;
      const terminalCode = getTerminalCodeValue(database, tenantId);
      const currencySymbol = getCurrencySymbol(database, tenantId);
      const nowIso = new Date().toISOString();

      database.exec('BEGIN IMMEDIATE');
      try {
        const invoice = {
          ...rawInvoice,
          items: Array.isArray(rawInvoice.items) ? rawInvoice.items.map((it) => ({ ...it })) : [],
        };
        if (!invoice.id || !String(invoice.id).trim()) {
          invoice.id = randomUUID();
        } else {
          invoice.id = String(invoice.id).trim();
        }

        // 1. Idempotency check by invoice.id or clientRequestId
        const existingInvRow = database.prepare(
          'SELECT tenant_id,id,branch_id,invoice_number,invoice_type,activity_id,party_id,invoice_date,payment_method,total_decimal,paid_amount_decimal,status,data_json FROM invoices WHERE tenant_id = ? AND id = ?'
        ).get(tenantId, invoice.id);
        if (existingInvRow) {
          const existingInv = hydrateInvoiceRow(database, tenantId, existingInvRow);
          if (existingInv.journalEntryId) {
            const existingJeRow = database.prepare(
              'SELECT tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json FROM journal_entries WHERE tenant_id = ? AND id = ?'
            ).get(tenantId, existingInv.journalEntryId);
            if (existingJeRow) {
              const existingJe = hydrateJournalEntryRow(database, tenantId, existingJeRow);
              database.exec('COMMIT');
              return { success: true, invoice: existingInv, journalEntry: existingJe };
            }
          }
        }
        if (clientRequestId) {
          const dupOutbox = database.prepare(
            'SELECT entity_id FROM outbox_queue WHERE tenant_id = ? AND idempotency_key = ?'
          ).get(tenantId, `REQ_${tenantId}_${clientRequestId}`);
          if (dupOutbox) {
            const dupInvRow = database.prepare(
              'SELECT tenant_id,id,branch_id,invoice_number,invoice_type,activity_id,party_id,invoice_date,payment_method,total_decimal,paid_amount_decimal,status,data_json FROM invoices WHERE tenant_id = ? AND id = ?'
            ).get(tenantId, dupOutbox.entity_id);
            if (dupInvRow) {
              const dupInv = hydrateInvoiceRow(database, tenantId, dupInvRow);
              if (dupInv.journalEntryId) {
                const dupJeRow = database.prepare(
                  'SELECT tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json FROM journal_entries WHERE tenant_id = ? AND id = ?'
                ).get(tenantId, dupInv.journalEntryId);
                if (dupJeRow) {
                  const dupJe = hydrateJournalEntryRow(database, tenantId, dupJeRow);
                  database.exec('COMMIT');
                  return { success: true, invoice: dupInv, journalEntry: dupJe };
                }
              }
            }
          }
        }

        // 2. Validate structural & exact monetary inputs
        if (!invoice.items || invoice.items.length === 0) {
          throw new FinancialValidationError('فاتورة المبيعات يجب أن تحتوي على صنف واحد على الأقل.');
        }
        if (stockDeductions.length === 0) {
          throw new FinancialValidationError('بنود خصم المخزون مطلوبة لإتمام فاتورة المبيعات.');
        }

        const itemQtyByProduct = new Map();
        for (const item of invoice.items) {
          const qtyUnits = parseScaledInt(item.quantity, QTY_SCALE, 'item.quantity');
          if (qtyUnits <= 0n) {
            throw new FinancialValidationError(`كمية الصنف (${item.productName}) يجب أن تكون أكبر من الصفر.`);
          }
          const priceUnits = parseScaledInt(item.unitPrice ?? 0, MONEY_SCALE, 'item.unitPrice');
          const discUnits = parseScaledInt(item.discount ?? 0, MONEY_SCALE, 'item.discount');
          if (priceUnits < 0n || discUnits < 0n) {
            throw new FinancialValidationError(`السعر والخصم للصنف (${item.productName}) يجب ألا يكونا قيمتين سالبتين.`);
          }
          const lineGrossUnits = mulScaledHalfUp(qtyUnits, priceUnits, QTY_SCALE, MONEY_SCALE, MONEY_SCALE);
          if (discUnits > lineGrossUnits + 1n) {
            throw new FinancialValidationError(`خصم الصنف (${item.productName}) يتجاوز قيمته.`);
          }
          itemQtyByProduct.set(item.productId, (itemQtyByProduct.get(item.productId) || 0n) + qtyUnits);
        }

        const dedQtyByProduct = new Map();
        for (const ded of stockDeductions) {
          if (!ded || !ded.productId) {
            throw new FinancialValidationError('معرف الصنف في خصم المخزون مطلوب.');
          }
          const dQtyUnits = parseScaledInt(ded.quantity, QTY_SCALE, 'ded.quantity');
          if (dQtyUnits <= 0n) {
            throw new FinancialValidationError('كمية خصم المخزون يجب أن تكون رقماً موجباً أكبر من الصفر.');
          }
          dedQtyByProduct.set(ded.productId, (dedQtyByProduct.get(ded.productId) || 0n) + dQtyUnits);
        }

        if (itemQtyByProduct.size !== dedQtyByProduct.size) {
          throw new FinancialValidationError('بنود الفاتورة لا تطابق بنود خصم المخزون.');
        }
        for (const [prodId, qtyUnits] of itemQtyByProduct) {
          const dUnits = dedQtyByProduct.get(prodId) || 0n;
          const diff = qtyUnits > dUnits ? qtyUnits - dUnits : dUnits - qtyUnits;
          if (diff > 1n) {
            throw new FinancialValidationError(`كمية الصنف (${prodId}) لا تطابق كمية خصم المخزون.`);
          }
        }

        const subtotalUnits = parseScaledInt(invoice.subtotal ?? 0, MONEY_SCALE, 'invoice.subtotal');
        const discountUnits = parseScaledInt(invoice.discount ?? 0, MONEY_SCALE, 'invoice.discount');
        const taxUnits = parseScaledInt(invoice.tax ?? 0, MONEY_SCALE, 'invoice.tax');
        const totalUnits = parseScaledInt(invoice.total ?? 0, MONEY_SCALE, 'invoice.total');
        const paidUnits = parseScaledInt(invoice.paidAmount ?? 0, MONEY_SCALE, 'invoice.paidAmount');

        if (subtotalUnits < 0n || discountUnits < 0n || taxUnits < 0n || totalUnits < 0n || paidUnits < 0n) {
          throw new FinancialValidationError('مبالغ الفاتورة والتكلفة لا يجوز أن تكون سالبة أو غير صالحة.');
        }
        if (discountUnits > subtotalUnits + 1n) {
          throw new FinancialValidationError('الخصم الإجمالي للفاتورة يتجاوز المجموع الفرعي.');
        }
        const expectedTotalUnits = subtotalUnits - discountUnits + taxUnits;
        const totalDiff = expectedTotalUnits > totalUnits ? expectedTotalUnits - totalUnits : totalUnits - expectedTotalUnits;
        if (totalDiff > 2n) {
          throw new FinancialValidationError(
            `إجمالي الفاتورة (${unitsToNumber(totalUnits, MONEY_SCALE)}) لا يطابق الصافي المحسوب (${unitsToNumber(expectedTotalUnits, MONEY_SCALE)}).`
          );
        }
        if (paidUnits > totalUnits + 1n) {
          throw new FinancialValidationError(
            `المبلغ المدفوع (${unitsToNumber(paidUnits, MONEY_SCALE)}) لا يمكن أن يتجاوز إجمالي الفاتورة (${unitsToNumber(totalUnits, MONEY_SCALE)}).`
          );
        }

        let targetCashBox;
        if (paidUnits > 0n) {
          if (!invoice.cashBoxId || !String(invoice.cashBoxId).trim()) {
            throw new FinancialValidationError('يجب تحديد صندوق نقدي/بنكي صالح لتحصيل المبلغ المدفوع.');
          }
          targetCashBox = getCashBoxRowTx(database, tenantId, invoice.cashBoxId);
          assertCashBoxBranchAccessTx(actor, targetCashBox, branchId);
        }

        const unpaidUnits = totalUnits - paidUnits;
        if (invoice.paymentMethod === 'CREDIT' && unpaidUnits > 0n && !invoice.partyId) {
          throw new FinancialValidationError('يجب تحديد عميل مسجل عند البيع الآجل لتسجيل الذمة المدينة.');
        }
        if (invoice.partyId) {
          const partyExists = database.prepare('SELECT 1 FROM parties WHERE tenant_id = ? AND id = ?').get(tenantId, invoice.partyId);
          if (!partyExists) {
            throw new FinancialValidationError('العميل المحدد غير موجود في قاعدة البيانات.');
          }
        }

        // 3. Atomic inventory deduction & exact BigInt FEFO + COGS calculation
        const todayStr = nowIso.split('T')[0];
        let totalCogsRawUnits = 0n; // accumulated at TOTALS_SCALE (1000000n)
        const recordedStockDeductions = [];

        for (const ded of stockDeductions) {
          const product = loadProductWithBatches(database, tenantId, ded.productId);
          if (!product) {
            throw new FinancialValidationError(`الصنف ذو المعرف ${ded.productId} غير موجود في المستودع.`);
          }

          const dedQtyUnits = parseScaledInt(ded.quantity, QTY_SCALE, 'deduction.quantity');
          const productStockUnits = parseScaledInt(product.currentStock, QTY_SCALE, 'product.currentStock');
          if (productStockUnits < dedQtyUnits) {
            throw new FinancialValidationError(
              `الرصيد المتاح من الصنف (${product.nameAr}) هو ${product.currentStock} فقط، المطلوب بيعه ${unitsToNumber(dedQtyUnits, QTY_SCALE)}.`
            );
          }

          const batches = Array.isArray(product.batches)
            ? product.batches.map((b) => ({
                ...b,
                _qtyUnits: parseScaledInt(b.quantity, QTY_SCALE, 'batch.quantity'),
                _costUnits: parseScaledInt(b.costPrice, QTY_SCALE, 'batch.costPrice'),
              }))
            : [];

          if (batches.length > 0) {
            const batchSumUnits = batches.reduce((s, b) => s + b._qtyUnits, 0n);
            if (batchSumUnits !== productStockUnits) {
              throw new FinancialValidationError(
                `تعارض في مخزون الصنف (${product.nameAr}): الرصيد (${product.currentStock}) لا يساوي مجموع التشغيلات (${unitsToNumber(batchSumUnits, QTY_SCALE)}).`
              );
            }

            if (ded.batchNumber) {
              const target = batches.find((b) => b.batchNumber === ded.batchNumber);
              if (!target) {
                throw new FinancialValidationError(`التشغيلة ${ded.batchNumber} للصنف (${product.nameAr}) غير موجودة.`);
              }
              if (target.expiryDate && target.expiryDate < todayStr) {
                throw new FinancialValidationError(
                  `محظور تماماً بيع التشغيلة (${target.batchNumber}) لأنها منتهية الصلاحية بتاريخ ${target.expiryDate}!`
                );
              }
              if (target._qtyUnits < dedQtyUnits) {
                throw new FinancialValidationError(
                  `الكمية المتاحة في التشغيلة (${target.batchNumber}) هي ${unitsToNumber(target._qtyUnits, QTY_SCALE)} فقط.`
                );
              }
              if (target._costUnits < 0n) {
                throw new FinancialValidationError(`تكلفة التشغيلة (${target.batchNumber}) غير صالحة.`);
              }
              totalCogsRawUnits += mulScaledHalfUp(dedQtyUnits, target._costUnits, QTY_SCALE, QTY_SCALE, TOTALS_SCALE);
              recordedStockDeductions.push({
                productId: product.id,
                batchNumber: target.batchNumber,
                expiryDate: target.expiryDate,
                quantity: unitsToNumber(dedQtyUnits, QTY_SCALE),
                unitCost: unitsToNumber(target._costUnits, QTY_SCALE),
              });
              target._qtyUnits -= dedQtyUnits;
            } else {
              const validBatches = batches
                .filter((b) => b._qtyUnits > 0n && (!b.expiryDate || b.expiryDate >= todayStr))
                .sort((a, b) => String(a.expiryDate || '9999-12-31').localeCompare(String(b.expiryDate || '9999-12-31')));

              const totalValidUnits = validBatches.reduce((s, b) => s + b._qtyUnits, 0n);
              if (totalValidUnits < dedQtyUnits) {
                throw new FinancialValidationError(
                  `لا توجد كمية سارية كافية من (${product.nameAr})! المتاح غير المنتهي هو ${unitsToNumber(totalValidUnits, QTY_SCALE)} فقط.`
                );
              }

              let remaining = dedQtyUnits;
              for (const batch of validBatches) {
                if (remaining === 0n) break;
                const take = batch._qtyUnits < remaining ? batch._qtyUnits : remaining;
                if (batch._costUnits < 0n) {
                  throw new FinancialValidationError(`تكلفة التشغيلة (${batch.batchNumber}) غير صالحة.`);
                }
                totalCogsRawUnits += mulScaledHalfUp(take, batch._costUnits, QTY_SCALE, QTY_SCALE, TOTALS_SCALE);
                recordedStockDeductions.push({
                  productId: product.id,
                  batchNumber: batch.batchNumber,
                  expiryDate: batch.expiryDate,
                  quantity: unitsToNumber(take, QTY_SCALE),
                  unitCost: unitsToNumber(batch._costUnits, QTY_SCALE),
                });
                batch._qtyUnits -= take;
                remaining -= take;
              }
            }

            const nextStockUnits = batches.reduce((s, b) => s + b._qtyUnits, 0n);
            product.batches = batches.map(({ _qtyUnits, _costUnits, ...rest }) => ({
              ...rest,
              quantity: unitsToNumber(_qtyUnits, QTY_SCALE),
            }));
            product.currentStock = unitsToNumber(nextStockUnits, QTY_SCALE);
          } else {
            const costUnits = parseScaledInt(product.purchasePrice ?? 0, QTY_SCALE, 'product.purchasePrice');
            if (costUnits < 0n) {
              throw new FinancialValidationError(`تكلفة الصنف (${product.nameAr}) غير صالحة.`);
            }
            totalCogsRawUnits += mulScaledHalfUp(dedQtyUnits, costUnits, QTY_SCALE, QTY_SCALE, TOTALS_SCALE);
            recordedStockDeductions.push({
              productId: product.id,
              quantity: unitsToNumber(dedQtyUnits, QTY_SCALE),
              unitCost: unitsToNumber(costUnits, QTY_SCALE),
            });
            product.currentStock = unitsToNumber(productStockUnits - dedQtyUnits, QTY_SCALE);
          }

          syncProductAndBatchesTx(database, tenantId, product);
        }

        const cogsUnits = divBigIntHalfUp(totalCogsRawUnits * MONEY_SCALE, TOTALS_SCALE);
        invoice.totalCogs = unitsToNumber(cogsUnits, MONEY_SCALE);
        invoice.stockDeductionsRecorded = recordedStockDeductions;

        // 4. Invoice number uniqueness / sequence allocation
        const dupNumber = invoice.invoiceNumber && String(invoice.invoiceNumber).trim()
          ? database.prepare(
              'SELECT 1 FROM invoices WHERE tenant_id = ? AND invoice_number = ? AND id <> ?'
            ).get(tenantId, String(invoice.invoiceNumber).trim(), invoice.id)
          : null;
        if (!invoice.invoiceNumber || !String(invoice.invoiceNumber).trim() || dupNumber) {
          invoice.invoiceNumber = allocateSequenceTx(database, tenantId, 'INV', activeBranch.code, terminalCode, nowIso);
        } else {
          invoice.invoiceNumber = String(invoice.invoiceNumber).trim();
        }

        // 5. Build balanced double-entry journal lines & update balances
        const revenueCode = ACTIVITY_REVENUE_ACCOUNTS[invoice.activityId] || '4101';
        const inventoryCode = ACTIVITY_INVENTORY_ACCOUNTS[invoice.activityId] || '11041';
        const cogsCode = ACTIVITY_COGS_ACCOUNTS[invoice.activityId] || '5101';
        const journalLines = [];

        if (paidUnits > 0n && targetCashBox) {
          const updatedBox = updateCashBoxBalanceTx(database, tenantId, targetCashBox.id, paidUnits, false);
          const boxAcc = updateAccountBalanceTx(database, tenantId, targetCashBox.accountCode, paidUnits);
          journalLines.push({
            id: randomUUID(),
            accountCode: targetCashBox.accountCode,
            accountName: boxAcc?.nameAr || updatedBox.nameAr,
            debit: unitsToNumber(paidUnits, MONEY_SCALE),
            credit: 0,
            costCenterId: invoice.activityId,
            memo: `تحصيل نقدي فاتورة مبيعات ${invoice.invoiceNumber}`,
          });
        }

        if (unpaidUnits > 0n) {
          const arAcc = updateAccountBalanceTx(database, tenantId, '1103', unpaidUnits);
          if (invoice.partyId) {
            updatePartyBalanceTx(database, tenantId, invoice.partyId, unpaidUnits);
          }
          journalLines.push({
            id: randomUUID(),
            accountCode: '1103',
            accountName: `${arAcc?.nameAr || 'العملاء والمدينون'} - ${invoice.partyName || ''}`.trim(),
            debit: unitsToNumber(unpaidUnits, MONEY_SCALE),
            credit: 0,
            costCenterId: invoice.activityId,
            memo: `مبيعات آجلة فاتورة ${invoice.invoiceNumber}`,
          });
        }

        const revAcc = updateAccountBalanceTx(database, tenantId, revenueCode, totalUnits);
        journalLines.push({
          id: randomUUID(),
          accountCode: revenueCode,
          accountName: revAcc?.nameAr || 'إيرادات المبيعات',
          debit: 0,
          credit: unitsToNumber(totalUnits, MONEY_SCALE),
          costCenterId: invoice.activityId,
          memo: `إيراد مبيعات فاتورة ${invoice.invoiceNumber}`,
        });

        if (cogsUnits > 0n) {
          const cogsAcc = updateAccountBalanceTx(database, tenantId, cogsCode, cogsUnits);
          const invAcc = updateAccountBalanceTx(database, tenantId, inventoryCode, -cogsUnits);
          journalLines.push({
            id: randomUUID(),
            accountCode: cogsCode,
            accountName: cogsAcc?.nameAr || 'تكلفة المبيعات',
            debit: unitsToNumber(cogsUnits, MONEY_SCALE),
            credit: 0,
            costCenterId: invoice.activityId,
            memo: `تكلفة مبيعات فاتورة ${invoice.invoiceNumber}`,
          });
          journalLines.push({
            id: randomUUID(),
            accountCode: inventoryCode,
            accountName: invAcc?.nameAr || 'المخزون السلعي',
            debit: 0,
            credit: unitsToNumber(cogsUnits, MONEY_SCALE),
            costCenterId: invoice.activityId,
            memo: `صرف مخزون مباع فاتورة ${invoice.invoiceNumber}`,
          });
        }

        const entryNumber = allocateSequenceTx(database, tenantId, 'JV', activeBranch.code, terminalCode, nowIso);
        const journalEntryId = randomUUID();
        const { persisted: journalEntry } = insertJournalEntryTx(database, tenantId, {
          id: journalEntryId,
          entryNumber,
          date: invoice.date || todayStr,
          description: `قيد مبيعات آلي للفاتورة ${invoice.invoiceNumber} - ${invoice.partyName || 'عميل نقدي'}`,
          costCenterId: invoice.activityId,
          branchId,
          lines: journalLines,
          status: 'POSTED',
          referenceType: 'INVOICE',
          referenceId: invoice.id,
          isAutoGenerated: true,
        });

        invoice.branchId = branchId;
        invoice.journalEntryId = journalEntry.id;
        invoice.isPosted = true;
        invoice.status = 'POSTED';
        invoice.type = invoice.type || 'SALE';
        invoice.date = invoice.date || todayStr;

        const persistedInvoice = insertInvoiceTx(database, tenantId, invoice);

        const deps = [];
        if (persistedInvoice.partyId) deps.push(persistedInvoice.partyId);
        for (const it of persistedInvoice.items || []) {
          if (it.productId && !deps.includes(it.productId)) deps.push(it.productId);
        }
        const idemKey = clientRequestId
          ? `REQ_${tenantId}_${clientRequestId}`
          : `${tenantId}_INVOICE_${persistedInvoice.id}_CREATE`;

        enqueueOutboxTx(database, actor, {
          entityType: 'INVOICE',
          entityId: persistedInvoice.id,
          action: 'CREATE',
          payload: persistedInvoice,
          priority: 3,
          dependsOn: deps,
          idempotencyKey: idemKey,
          branchId,
          nowIso,
        });
        enqueueOutboxTx(database, actor, {
          entityType: 'JOURNAL_ENTRY',
          entityId: journalEntry.id,
          action: 'CREATE',
          payload: journalEntry,
          priority: 4,
          dependsOn: [persistedInvoice.id],
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${journalEntry.id}_CREATE`,
          branchId,
          nowIso,
        });
        writeAuditLogTx(
          database,
          { ...actor, branchId },
          'إصدار فاتورة مبيعات ذرية',
          `فاتورة ${persistedInvoice.invoiceNumber} بقيمة ${persistedInvoice.total} ${currencySymbol} وقيد ${journalEntry.entryNumber}`,
          nowIso
        );

        database.exec('COMMIT');
        return { success: true, invoice: persistedInvoice, journalEntry };
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    createPurchaseInvoiceAtomic(actor, params) {
      if (!params || typeof params !== 'object' || !params.invoice) {
        throw new FinancialValidationError('بيانات فاتورة المشتريات غير مكتملة.');
      }
      assertPermission(actor, 'purchase:create', 'إصدار فاتورة مشتريات');
      const rawInvoice = params.invoice;
      const itemsWithBatches = Array.isArray(params.itemsWithBatches) ? params.itemsWithBatches : [];
      const clientRequestId = params.clientRequestId ? String(params.clientRequestId).trim() : '';

      const tenantId = actor.tenantId;
      const activeBranch = resolveBranchTx(database, core, actor, rawInvoice.branchId);
      const branchId = activeBranch.id;
      const terminalCode = getTerminalCodeValue(database, tenantId);
      const currencySymbol = getCurrencySymbol(database, tenantId);
      const nowIso = new Date().toISOString();

      database.exec('BEGIN IMMEDIATE');
      try {
        const invoice = {
          ...rawInvoice,
          items: Array.isArray(rawInvoice.items) ? rawInvoice.items.map((it) => ({ ...it })) : [],
        };
        if (!invoice.id || !String(invoice.id).trim()) {
          invoice.id = randomUUID();
        } else {
          invoice.id = String(invoice.id).trim();
        }

        // 1. Idempotency check
        const existingInvRow = database.prepare(
          'SELECT tenant_id,id,branch_id,invoice_number,invoice_type,activity_id,party_id,invoice_date,payment_method,total_decimal,paid_amount_decimal,status,data_json FROM invoices WHERE tenant_id = ? AND id = ?'
        ).get(tenantId, invoice.id);
        if (existingInvRow) {
          const existingInv = hydrateInvoiceRow(database, tenantId, existingInvRow);
          if (existingInv.journalEntryId) {
            const existingJeRow = database.prepare(
              'SELECT tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json FROM journal_entries WHERE tenant_id = ? AND id = ?'
            ).get(tenantId, existingInv.journalEntryId);
            if (existingJeRow) {
              const existingJe = hydrateJournalEntryRow(database, tenantId, existingJeRow);
              database.exec('COMMIT');
              return { success: true, invoice: existingInv, journalEntry: existingJe };
            }
          }
        }
        if (clientRequestId) {
          const dupOutbox = database.prepare(
            'SELECT entity_id FROM outbox_queue WHERE tenant_id = ? AND idempotency_key = ?'
          ).get(tenantId, `REQ_${tenantId}_${clientRequestId}`);
          if (dupOutbox) {
            const dupInvRow = database.prepare(
              'SELECT tenant_id,id,branch_id,invoice_number,invoice_type,activity_id,party_id,invoice_date,payment_method,total_decimal,paid_amount_decimal,status,data_json FROM invoices WHERE tenant_id = ? AND id = ?'
            ).get(tenantId, dupOutbox.entity_id);
            if (dupInvRow) {
              const dupInv = hydrateInvoiceRow(database, tenantId, dupInvRow);
              if (dupInv.journalEntryId) {
                const dupJeRow = database.prepare(
                  'SELECT tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json FROM journal_entries WHERE tenant_id = ? AND id = ?'
                ).get(tenantId, dupInv.journalEntryId);
                if (dupJeRow) {
                  const dupJe = hydrateJournalEntryRow(database, tenantId, dupJeRow);
                  database.exec('COMMIT');
                  return { success: true, invoice: dupInv, journalEntry: dupJe };
                }
              }
            }
          }
        }

        // 2. Validate purchase lines & amounts
        if (itemsWithBatches.length === 0) {
          throw new FinancialValidationError('فاتورة المشتريات يجب أن تحتوي على صنف واحد على الأقل.');
        }

        let computedLinesUnits = 0n;
        const parsedPurchaseLines = [];
        for (const item of itemsWithBatches) {
          if (!item || !item.productId) {
            throw new FinancialValidationError('معرف الصنف في فاتورة المشتريات مطلوب.');
          }
          const qtyUnits = parseScaledInt(item.quantity, QTY_SCALE, 'purchaseItem.quantity');
          if (qtyUnits <= 0n) {
            throw new FinancialValidationError('كمية الشراء لكل صنف يجب أن تكون رقماً موجباً أكبر من الصفر.');
          }
          const costUnits = parseScaledInt(item.costPrice, QTY_SCALE, 'purchaseItem.costPrice');
          if (costUnits < 0n) {
            throw new FinancialValidationError('سعر التكلفة في فاتورة المشتريات لا يجوز أن يكون سالباً.');
          }
          const lineTotalUnits = mulScaledHalfUp(qtyUnits, costUnits, QTY_SCALE, QTY_SCALE, MONEY_SCALE);
          computedLinesUnits += lineTotalUnits;
          parsedPurchaseLines.push({
            ...item,
            _qtyUnits: qtyUnits,
            _costUnits: costUnits,
          });
        }

        const subtotalUnits = parseScaledInt(invoice.subtotal ?? 0, MONEY_SCALE, 'purchase.subtotal');
        const discountUnits = parseScaledInt(invoice.discount ?? 0, MONEY_SCALE, 'purchase.discount');
        const taxUnits = parseScaledInt(invoice.tax ?? 0, MONEY_SCALE, 'purchase.tax');
        const totalUnits = parseScaledInt(invoice.total ?? 0, MONEY_SCALE, 'purchase.total');
        const paidUnits = parseScaledInt(invoice.paidAmount ?? 0, MONEY_SCALE, 'purchase.paidAmount');

        if (subtotalUnits < 0n || discountUnits < 0n || taxUnits < 0n || totalUnits < 0n || paidUnits < 0n) {
          throw new FinancialValidationError('مبالغ فاتورة المشتريات لا يجوز أن تكون سالبة أو غير صالحة.');
        }
        if (discountUnits > subtotalUnits + 1n) {
          throw new FinancialValidationError('خصم فاتورة المشتريات يتجاوز المجموع الفرعي.');
        }
        const expectedTotalUnits = subtotalUnits - discountUnits + taxUnits;
        const totalDiff = expectedTotalUnits > totalUnits ? expectedTotalUnits - totalUnits : totalUnits - expectedTotalUnits;
        if (totalDiff > 2n) {
          throw new FinancialValidationError(
            `إجمالي فاتورة المشتريات (${unitsToNumber(totalUnits, MONEY_SCALE)}) لا يطابق الصافي المحسوب (${unitsToNumber(expectedTotalUnits, MONEY_SCALE)}).`
          );
        }
        const linesDiff = computedLinesUnits > subtotalUnits ? computedLinesUnits - subtotalUnits : subtotalUnits - computedLinesUnits;
        if (linesDiff > 5n) {
          throw new FinancialValidationError(
            `مجموع بنود المشتريات (${unitsToNumber(computedLinesUnits, MONEY_SCALE)}) لا يطابق المجموع الفرعي للفاتورة (${unitsToNumber(subtotalUnits, MONEY_SCALE)}).`
          );
        }
        if (paidUnits > totalUnits + 1n) {
          throw new FinancialValidationError(
            `المبلغ المدفوع (${unitsToNumber(paidUnits, MONEY_SCALE)}) لا يمكن أن يتجاوز إجمالي فاتورة المشتريات (${unitsToNumber(totalUnits, MONEY_SCALE)}).`
          );
        }

        let targetCashBox;
        if (paidUnits > 0n) {
          if (!invoice.cashBoxId || !String(invoice.cashBoxId).trim()) {
            throw new FinancialValidationError('يجب تحديد صندوق نقدي صالح لسداد فاتورة المشتريات.');
          }
          targetCashBox = getCashBoxRowTx(database, tenantId, invoice.cashBoxId);
          assertCashBoxBranchAccessTx(actor, targetCashBox, branchId);
          if (targetCashBox._balanceUnits < paidUnits) {
            throw new FinancialValidationError(
              `رصيد الصندوق (${targetCashBox.nameAr}: ${targetCashBox.balance}) غير كافٍ لسداد مبلغ ${unitsToNumber(paidUnits, MONEY_SCALE)}.`
            );
          }
        }

        // 3. Apply inventory increases, batch upserts, landed cost factor & weighted-avg purchasePrice
        const todayStr = nowIso.split('T')[0];

        for (const item of parsedPurchaseLines) {
          const product = loadProductWithBatches(database, tenantId, item.productId);
          if (!product) {
            throw new FinancialValidationError(`الصنف ذو المعرف ${item.productId} غير موجود.`);
          }

          if (invoice.activityId === 'pharmacy') {
            if (!item.batchNumber || !String(item.batchNumber).trim()) {
              throw new FinancialValidationError(
                `رقم التشغيلة إجباري لإدخال الدواء (${product.nameAr}) في فاتورة الشراء.`
              );
            }
            if (!item.expiryDate || !String(item.expiryDate).trim()) {
              throw new FinancialValidationError(
                `تاريخ انتهاء الصلاحية إجباري لإدخال الدواء (${product.nameAr}) في فاتورة الشراء.`
              );
            }
            if (String(item.expiryDate).trim() < todayStr) {
              throw new FinancialValidationError(
                `محظور تماماً شراء أو توريد دواء منتهي الصلاحية (${product.nameAr}) بتاريخ ${item.expiryDate}!`
              );
            }
          }

          const landedCostUnits = subtotalUnits > 0n
            ? divBigIntHalfUp(item._costUnits * totalUnits, subtotalUnits)
            : item._costUnits;
          if (landedCostUnits < 0n) {
            throw new FinancialValidationError(`تكلفة التوريد النهائية للصنف (${product.nameAr}) غير صالحة.`);
          }

          const batchNumber = item.batchNumber ? String(item.batchNumber).trim() : '';
          const expiryDate = item.expiryDate ? String(item.expiryDate).trim() : '';

          if (batchNumber && expiryDate) {
            const batches = Array.isArray(product.batches)
              ? product.batches.map((b) => ({
                  ...b,
                  _qtyUnits: parseScaledInt(b.quantity, QTY_SCALE, 'batch.quantity'),
                  _costUnits: parseScaledInt(b.costPrice, QTY_SCALE, 'batch.costPrice'),
                }))
              : [];

            const existingBatch = batches.find((b) => b.batchNumber === batchNumber);
            if (existingBatch) {
              if (existingBatch.expiryDate !== expiryDate) {
                throw new FinancialValidationError(`رقم التشغيلة (${batchNumber}) مستخدم بتاريخ صلاحية مختلف.`);
              }
              const nextBatchQty = existingBatch._qtyUnits + item._qtyUnits;
              const prevValue = existingBatch._qtyUnits * existingBatch._costUnits;
              const addedValue = item._qtyUnits * landedCostUnits;
              existingBatch._costUnits = nextBatchQty > 0n
                ? divBigIntHalfUp(prevValue + addedValue, nextBatchQty)
                : landedCostUnits;
              existingBatch._qtyUnits = nextBatchQty;
            } else {
              batches.push({
                id: randomUUID(),
                productId: product.id,
                batchNumber,
                expiryDate,
                quantity: unitsToNumber(item._qtyUnits, QTY_SCALE),
                costPrice: unitsToNumber(landedCostUnits, QTY_SCALE),
                _qtyUnits: item._qtyUnits,
                _costUnits: landedCostUnits,
              });
            }

            const totalQtyUnits = batches.reduce((s, b) => s + b._qtyUnits, 0n);
            const totalVal = batches.reduce((s, b) => s + b._qtyUnits * b._costUnits, 0n);
            const avgCostUnits = totalQtyUnits > 0n
              ? divBigIntHalfUp(totalVal, totalQtyUnits)
              : landedCostUnits;

            product.batches = batches.map(({ _qtyUnits, _costUnits, ...rest }) => ({
              ...rest,
              quantity: unitsToNumber(_qtyUnits, QTY_SCALE),
              costPrice: unitsToNumber(_costUnits, QTY_SCALE),
            }));
            product.currentStock = unitsToNumber(totalQtyUnits, QTY_SCALE);
            product.purchasePrice = unitsToNumber(avgCostUnits, QTY_SCALE);
          } else {
            const prevQtyUnits = parseScaledInt(product.currentStock ?? 0, QTY_SCALE, 'prevStock');
            const prevCostUnits = parseScaledInt(product.purchasePrice ?? 0, QTY_SCALE, 'prevCost');
            const nextQtyUnits = prevQtyUnits + item._qtyUnits;
            const prevValue = prevQtyUnits * prevCostUnits;
            const addedValue = item._qtyUnits * landedCostUnits;
            const nextCostUnits = nextQtyUnits > 0n
              ? divBigIntHalfUp(prevValue + addedValue, nextQtyUnits)
              : landedCostUnits;

            product.currentStock = unitsToNumber(nextQtyUnits, QTY_SCALE);
            product.purchasePrice = unitsToNumber(nextCostUnits, QTY_SCALE);
          }

          syncProductAndBatchesTx(database, tenantId, product);
        }

        // 4. Purchase invoice number & GL journal entry
        const dupNumber = invoice.invoiceNumber && String(invoice.invoiceNumber).trim()
          ? database.prepare(
              'SELECT 1 FROM invoices WHERE tenant_id = ? AND invoice_number = ? AND id <> ?'
            ).get(tenantId, String(invoice.invoiceNumber).trim(), invoice.id)
          : null;
        if (!invoice.invoiceNumber || !String(invoice.invoiceNumber).trim() || dupNumber) {
          invoice.invoiceNumber = allocateSequenceTx(database, tenantId, 'PUR', activeBranch.code, terminalCode, nowIso);
        } else {
          invoice.invoiceNumber = String(invoice.invoiceNumber).trim();
        }

        const inventoryCode = ACTIVITY_INVENTORY_ACCOUNTS[invoice.activityId] || '11041';
        const invAcc = updateAccountBalanceTx(database, tenantId, inventoryCode, totalUnits);

        const journalLines = [
          {
            id: randomUUID(),
            accountCode: inventoryCode,
            accountName: invAcc?.nameAr || 'المخزون السلعي',
            debit: unitsToNumber(totalUnits, MONEY_SCALE),
            credit: 0,
            costCenterId: invoice.activityId,
            memo: `شراء بضاعة فاتورة ${invoice.invoiceNumber} من ${invoice.partyName || ''}`.trim(),
          },
        ];

        if (paidUnits > 0n && targetCashBox) {
          const updatedBox = updateCashBoxBalanceTx(database, tenantId, targetCashBox.id, -paidUnits, true);
          const boxAcc = updateAccountBalanceTx(database, tenantId, targetCashBox.accountCode, -paidUnits);
          journalLines.push({
            id: randomUUID(),
            accountCode: targetCashBox.accountCode,
            accountName: boxAcc?.nameAr || updatedBox.nameAr,
            debit: 0,
            credit: unitsToNumber(paidUnits, MONEY_SCALE),
            costCenterId: invoice.activityId,
            memo: `سداد نقدي فاتورة مشتريات ${invoice.invoiceNumber}`,
          });
        }

        const unpaidUnits = totalUnits - paidUnits;
        if (unpaidUnits > 0n) {
          const apAcc = updateAccountBalanceTx(database, tenantId, '2101', unpaidUnits);
          if (invoice.partyId) {
            updatePartyBalanceTx(database, tenantId, invoice.partyId, -unpaidUnits);
          }
          journalLines.push({
            id: randomUUID(),
            accountCode: '2101',
            accountName: `${apAcc?.nameAr || 'الموردون والدائنون'} - ${invoice.partyName || ''}`.trim(),
            debit: 0,
            credit: unitsToNumber(unpaidUnits, MONEY_SCALE),
            costCenterId: invoice.activityId,
            memo: `مستحق آجل فاتورة مشتريات ${invoice.invoiceNumber}`,
          });
        }

        const entryNumber = allocateSequenceTx(database, tenantId, 'JV', activeBranch.code, terminalCode, nowIso);
        const { persisted: journalEntry } = insertJournalEntryTx(database, tenantId, {
          id: randomUUID(),
          entryNumber,
          date: invoice.date || todayStr,
          description: `قيد مشتريات آلي للفاتورة ${invoice.invoiceNumber} - ${invoice.partyName || ''}`.trim(),
          costCenterId: invoice.activityId,
          branchId,
          lines: journalLines,
          status: 'POSTED',
          referenceType: 'INVOICE',
          referenceId: invoice.id,
          isAutoGenerated: true,
        });

        if (!invoice.items || invoice.items.length === 0) {
          invoice.items = itemsWithBatches.map((it) => {
            const qty = parseScaledInt(it.quantity, QTY_SCALE, 'qty');
            const cost = parseScaledInt(it.costPrice, QTY_SCALE, 'cost');
            return {
              id: randomUUID(),
              productId: it.productId,
              productName: it.productId,
              quantity: unitsToNumber(qty, QTY_SCALE),
              unitPrice: unitsToNumber(cost, QTY_SCALE),
              discount: 0,
              total: unitsToNumber(mulScaledHalfUp(qty, cost, QTY_SCALE, QTY_SCALE, MONEY_SCALE), MONEY_SCALE),
              batchNumber: it.batchNumber,
              expiryDate: it.expiryDate,
            };
          });
        }

        invoice.branchId = branchId;
        invoice.journalEntryId = journalEntry.id;
        invoice.isPosted = true;
        invoice.status = 'POSTED';
        invoice.type = invoice.type || 'PURCHASE';
        invoice.date = invoice.date || todayStr;

        const persistedInvoice = insertInvoiceTx(database, tenantId, invoice);

        const deps = [];
        if (persistedInvoice.partyId) deps.push(persistedInvoice.partyId);
        for (const it of persistedInvoice.items || []) {
          if (it.productId && !deps.includes(it.productId)) deps.push(it.productId);
        }
        const idemKey = clientRequestId
          ? `REQ_${tenantId}_${clientRequestId}`
          : `${tenantId}_INVOICE_${persistedInvoice.id}_CREATE`;

        enqueueOutboxTx(database, actor, {
          entityType: 'INVOICE',
          entityId: persistedInvoice.id,
          action: 'CREATE',
          payload: persistedInvoice,
          priority: 3,
          dependsOn: deps,
          idempotencyKey: idemKey,
          branchId,
          nowIso,
        });
        enqueueOutboxTx(database, actor, {
          entityType: 'JOURNAL_ENTRY',
          entityId: journalEntry.id,
          action: 'CREATE',
          payload: journalEntry,
          priority: 4,
          dependsOn: [persistedInvoice.id],
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${journalEntry.id}_CREATE`,
          branchId,
          nowIso,
        });
        writeAuditLogTx(
          database,
          { ...actor, branchId },
          'إصدار فاتورة مشتريات ذرية',
          `فاتورة ${persistedInvoice.invoiceNumber} بقيمة ${persistedInvoice.total} ${currencySymbol} وقيد ${journalEntry.entryNumber}`,
          nowIso
        );

        database.exec('COMMIT');
        return { success: true, invoice: persistedInvoice, journalEntry };
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    // --- الصناديق والبنوك (Cash Boxes) ---
    getCashBoxes(actor) {
      assertPermission(actor, 'cashbox:view', 'عرض الصناديق والبنوك');
      const rows = database.prepare(
        'SELECT tenant_id,id,branch_id,code,account_code,balance_decimal,data_json FROM cash_boxes WHERE tenant_id = ? ORDER BY rowid ASC'
      ).all(actor.tenantId);
      const boxes = rows.map((row) => ({
        ...parseRowJson(row),
        id: row.id,
        tenantId: row.tenant_id,
        branchId: row.branch_id || '',
        code: row.code,
        accountCode: row.account_code,
        balance: unitsToNumber(parseScaledInt(row.balance_decimal, MONEY_SCALE, 'cashBoxBalance'), MONEY_SCALE),
      }));
      return filterRecordsByBranchScope(boxes, actor);
    },

    createCashBoxAtomic(actor, box) {
      if (!box || typeof box !== 'object') {
        throw new FinancialValidationError('بيانات الصندوق غير صالحة.');
      }
      assertPermission(actor, 'cashbox:create', 'إنشاء صندوق أو حساب بنكي');
      if (box.isCentral) {
        assertPermission(actor, 'cashbox:central_access', 'إنشاء صندوق مركزي');
      }
      const code = String(box.code || '').trim().toUpperCase();
      const nameAr = String(box.nameAr || '').trim();
      const accountCode = String(box.accountCode || '').trim();
      if (!code || !nameAr || !accountCode) {
        throw new FinancialValidationError('رمز الصندوق واسمه والحساب المحاسبي المرتبط حقول مطلوبة.');
      }

      const tenantId = actor.tenantId;
      const activeBranch = resolveBranchTx(database, core, actor, box.branchId);
      const branchId = activeBranch.id;
      const nowIso = new Date().toISOString();

      database.exec('BEGIN IMMEDIATE');
      try {
        const accountRow = database.prepare(
          'SELECT 1 FROM accounts WHERE tenant_id = ? AND code = ?'
        ).get(tenantId, accountCode);
        if (!accountRow) {
          throw new FinancialValidationError(`الحساب المرتبط (${accountCode}) غير موجود في الدليل المحاسبي.`);
        }

        const dupCode = database.prepare(
          'SELECT 1 FROM cash_boxes WHERE tenant_id = ? AND upper(code) = upper(?)'
        ).get(tenantId, code);
        if (dupCode) {
          throw new FinancialValidationError(`رمز الصندوق (${code}) مستخدم مسبقاً.`);
        }

        const balanceUnits = parseScaledInt(box.balance ?? 0, MONEY_SCALE, 'cashBox.balance');
        if (balanceUnits < 0n) {
          throw new FinancialValidationError('رصيد الصندوق الافتتاحي لا يجوز أن يكون سالباً.');
        }

        const id = String(box.id || '').trim() || randomUUID();
        const cleanBox = {
          ...box,
          id,
          tenantId,
          branchId,
          code,
          nameAr,
          accountCode,
          balance: unitsToNumber(balanceUnits, MONEY_SCALE),
          isCentral: Boolean(box.isCentral),
          isDefault: Boolean(box.isDefault),
        };

        database.prepare(
          `INSERT INTO cash_boxes (tenant_id,id,branch_id,code,account_code,balance_decimal,data_json)
           VALUES (?,?,?,?,?,?,?)`
        ).run(
          tenantId,
          cleanBox.id,
          cleanBox.branchId,
          cleanBox.code,
          cleanBox.accountCode,
          formatScaledInt(balanceUnits, MONEY_SCALE),
          JSON.stringify(cleanBox)
        );

        enqueueOutboxTx(database, actor, {
          entityType: 'CASHBOX',
          entityId: cleanBox.id,
          action: 'CREATE',
          payload: cleanBox,
          priority: 2,
          branchId,
          nowIso,
        });
        writeAuditLogTx(
          database,
          { ...actor, branchId },
          'إنشاء صندوق/حساب بنكي',
          `إنشاء ${cleanBox.nameAr} (${cleanBox.code})`,
          nowIso
        );

        database.exec('COMMIT');
        return cleanBox;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    // --- السندات النقدية الذرية (Vouchers) ---
    getVouchers(actor) {
      assertPermission(actor, 'vouchers:view', 'عرض السندات المالية');
      const rows = database.prepare(
        'SELECT tenant_id,id,branch_id,voucher_number,voucher_type,voucher_date,amount_decimal,cash_box_id,party_id,data_json FROM vouchers WHERE tenant_id = ? ORDER BY voucher_date DESC, rowid DESC'
      ).all(actor.tenantId);
      const vouchers = rows.map((row) => ({
        ...parseRowJson(row),
        id: row.id,
        tenantId: row.tenant_id,
        branchId: row.branch_id || '',
        voucherNumber: row.voucher_number,
        type: row.voucher_type,
        date: row.voucher_date,
        amount: unitsToNumber(parseScaledInt(row.amount_decimal, MONEY_SCALE, 'voucherAmount'), MONEY_SCALE),
        cashBoxId: row.cash_box_id,
        partyId: row.party_id ?? undefined,
      }));
      return filterRecordsByBranchScope(vouchers, actor);
    },

    createCashVoucherAtomic(actor, params) {
      if (!params || typeof params !== 'object' || !params.voucher) {
        throw new FinancialValidationError('بيانات السند المالي غير مكتملة.');
      }
      const rawVoucher = params.voucher;
      if (!['RECEIPT', 'PAYMENT'].includes(rawVoucher.type)) {
        throw new FinancialValidationError('نوع السند يجب أن يكون RECEIPT أو PAYMENT.');
      }
      assertPermission(
        actor,
        rawVoucher.type === 'RECEIPT' ? 'voucher:receipt' : 'voucher:payment',
        rawVoucher.type === 'RECEIPT' ? 'إصدار سند قبض' : 'إصدار سند صرف'
      );

      const tenantId = actor.tenantId;
      const activeBranch = resolveBranchTx(database, core, actor, rawVoucher.branchId);
      const branchId = activeBranch.id;
      const terminalCode = getTerminalCodeValue(database, tenantId);
      const currencySymbol = getCurrencySymbol(database, tenantId);
      const nowIso = new Date().toISOString();

      database.exec('BEGIN IMMEDIATE');
      try {
        const voucher = { ...rawVoucher };
        if (!voucher.id || !String(voucher.id).trim()) {
          voucher.id = randomUUID();
        } else {
          voucher.id = String(voucher.id).trim();
        }

        // Idempotency
        const existingVoucherRow = database.prepare(
          'SELECT tenant_id,id,branch_id,voucher_number,voucher_type,voucher_date,amount_decimal,cash_box_id,party_id,data_json FROM vouchers WHERE tenant_id = ? AND id = ?'
        ).get(tenantId, voucher.id);
        if (existingVoucherRow) {
          const existingVoucher = {
            ...parseRowJson(existingVoucherRow),
            id: existingVoucherRow.id,
            branchId: existingVoucherRow.branch_id || '',
            voucherNumber: existingVoucherRow.voucher_number,
            type: existingVoucherRow.voucher_type,
            date: existingVoucherRow.voucher_date,
            amount: unitsToNumber(parseScaledInt(existingVoucherRow.amount_decimal, MONEY_SCALE, 'voucherAmount'), MONEY_SCALE),
            cashBoxId: existingVoucherRow.cash_box_id,
            partyId: existingVoucherRow.party_id ?? undefined,
          };
          if (existingVoucher.journalEntryId) {
            const existingJeRow = database.prepare(
              'SELECT tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json FROM journal_entries WHERE tenant_id = ? AND id = ?'
            ).get(tenantId, existingVoucher.journalEntryId);
            if (existingJeRow) {
              const existingJe = hydrateJournalEntryRow(database, tenantId, existingJeRow);
              database.exec('COMMIT');
              return { success: true, voucher: existingVoucher, journalEntry: existingJe };
            }
          }
        }

        const amountUnits = parseScaledInt(voucher.amount, MONEY_SCALE, 'voucher.amount');
        if (amountUnits <= 0n) {
          throw new FinancialValidationError('مبلغ السند المالي يجب أن يكون رقماً موجباً أكبر من الصفر.');
        }
        const cashBox = getCashBoxRowTx(database, tenantId, voucher.cashBoxId);
        if (!voucher.cashBoxId || !cashBox) {
          throw new FinancialValidationError(`الصندوق المحدد (${voucher.cashBoxId || '-'}) غير موجود أو غير نشط.`);
        }
        assertCashBoxBranchAccessTx(actor, cashBox, branchId);

        const targetAccCode = String(voucher.accountCode || '').trim();
        const targetAccRow = targetAccCode
          ? database.prepare('SELECT code, data_json FROM accounts WHERE tenant_id = ? AND code = ?').get(tenantId, targetAccCode)
          : null;
        if (!targetAccCode || !targetAccRow) {
          throw new FinancialValidationError(`الحساب المقابل (${voucher.accountCode || '-'}) غير موجود في الدليل المحاسبي.`);
        }
        if (!voucher.description || !String(voucher.description).trim()) {
          throw new FinancialValidationError('وصف السند وسبب الحركة مطلوب محاسبياً.');
        }
        if (voucher.type === 'PAYMENT' && cashBox._balanceUnits < amountUnits) {
          throw new FinancialValidationError(
            `رصيد الصندوق (${cashBox.nameAr}: ${cashBox.balance}) غير كافٍ لصرف مبلغ ${unitsToNumber(amountUnits, MONEY_SCALE)}.`
          );
        }

        if (!voucher.voucherNumber || !String(voucher.voucherNumber).trim()) {
          voucher.voucherNumber = allocateSequenceTx(
            database,
            tenantId,
            voucher.type === 'RECEIPT' ? 'RCT' : 'PAY',
            activeBranch.code,
            terminalCode,
            nowIso
          );
        } else {
          voucher.voucherNumber = String(voucher.voucherNumber).trim();
        }

        const amountNum = unitsToNumber(amountUnits, MONEY_SCALE);
        const voucherDate = voucher.date || nowIso.split('T')[0];
        const cashDeltaUnits = voucher.type === 'RECEIPT' ? amountUnits : -amountUnits;

        const updatedBox = updateCashBoxBalanceTx(database, tenantId, cashBox.id, cashDeltaUnits, voucher.type === 'PAYMENT');
        const cashBoxAcc = updateAccountBalanceTx(database, tenantId, cashBox.accountCode, cashDeltaUnits);
        const targetAccDelta = voucher.type === 'RECEIPT' ? -amountUnits : amountUnits;
        const targetAcc = updateAccountBalanceTx(database, tenantId, targetAccCode, targetAccDelta);

        if (voucher.partyId) {
          updatePartyBalanceTx(database, tenantId, voucher.partyId, voucher.type === 'RECEIPT' ? -amountUnits : amountUnits);
        }

        const lines = voucher.type === 'RECEIPT'
          ? [
              {
                id: randomUUID(),
                accountCode: cashBox.accountCode,
                accountName: cashBoxAcc?.nameAr || updatedBox.nameAr,
                debit: amountNum,
                credit: 0,
                costCenterId: voucher.costCenterId || 'general',
                memo: `سند قبض ${voucher.voucherNumber} - ${voucher.description}`,
              },
              {
                id: randomUUID(),
                accountCode: targetAccCode,
                accountName: targetAcc?.nameAr || parseRowJson(targetAccRow).nameAr || targetAccCode,
                debit: 0,
                credit: amountNum,
                costCenterId: voucher.costCenterId || 'general',
                memo: String(voucher.description),
              },
            ]
          : [
              {
                id: randomUUID(),
                accountCode: targetAccCode,
                accountName: targetAcc?.nameAr || parseRowJson(targetAccRow).nameAr || targetAccCode,
                debit: amountNum,
                credit: 0,
                costCenterId: voucher.costCenterId || 'general',
                memo: String(voucher.description),
              },
              {
                id: randomUUID(),
                accountCode: cashBox.accountCode,
                accountName: cashBoxAcc?.nameAr || updatedBox.nameAr,
                debit: 0,
                credit: amountNum,
                costCenterId: voucher.costCenterId || 'general',
                memo: `سند صرف ${voucher.voucherNumber} - ${voucher.description}`,
              },
            ];

        const entryNumber = allocateSequenceTx(database, tenantId, 'JV', activeBranch.code, terminalCode, nowIso);
        const { persisted: journalEntry } = insertJournalEntryTx(database, tenantId, {
          id: randomUUID(),
          entryNumber,
          date: voucherDate,
          description: `${voucher.type === 'RECEIPT' ? 'سند قبض' : 'سند صرف'} ${voucher.voucherNumber}: ${voucher.partyName || ''} - ${voucher.description}`,
          costCenterId: voucher.costCenterId || 'general',
          branchId,
          lines,
          status: 'POSTED',
          referenceType: 'VOUCHER',
          referenceId: voucher.id,
          isAutoGenerated: true,
        });

        const persistedVoucher = {
          ...voucher,
          tenantId,
          branchId,
          amount: amountNum,
          date: voucherDate,
          cashBoxId: cashBox.id,
          accountCode: targetAccCode,
          journalEntryId: journalEntry.id,
        };

        database.prepare(
          `INSERT INTO vouchers
            (tenant_id,id,branch_id,voucher_number,voucher_type,voucher_date,amount_decimal,cash_box_id,party_id,data_json)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).run(
          tenantId,
          persistedVoucher.id,
          branchId,
          persistedVoucher.voucherNumber,
          persistedVoucher.type,
          persistedVoucher.date,
          formatScaledInt(amountUnits, MONEY_SCALE),
          persistedVoucher.cashBoxId,
          persistedVoucher.partyId || null,
          JSON.stringify(persistedVoucher)
        );

        const deps = [cashBox.id];
        if (persistedVoucher.partyId) deps.push(persistedVoucher.partyId);

        enqueueOutboxTx(database, actor, {
          entityType: 'VOUCHER',
          entityId: persistedVoucher.id,
          action: 'CREATE',
          payload: persistedVoucher,
          priority: 3,
          dependsOn: deps,
          idempotencyKey: `${tenantId}_VOUCHER_${persistedVoucher.id}_CREATE`,
          branchId,
          nowIso,
        });
        enqueueOutboxTx(database, actor, {
          entityType: 'JOURNAL_ENTRY',
          entityId: journalEntry.id,
          action: 'CREATE',
          payload: journalEntry,
          priority: 4,
          dependsOn: [persistedVoucher.id],
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${journalEntry.id}_CREATE`,
          branchId,
          nowIso,
        });
        writeAuditLogTx(
          database,
          { ...actor, branchId },
          `سند ${persistedVoucher.type === 'RECEIPT' ? 'قبض' : 'صرف'} ذري`,
          `سند ${persistedVoucher.voucherNumber} بمبلغ ${amountNum} ${currencySymbol} وقيد ${journalEntry.entryNumber}`,
          nowIso
        );

        database.exec('COMMIT');
        return { success: true, voucher: persistedVoucher, journalEntry };
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    // --- الأمانات المستقلة (Amanat Custody) ---
    getAmanatRecords(actor) {
      assertPermission(actor, 'amanat:view', 'عرض سجلات الأمانات');
      const rows = database.prepare(
        'SELECT tenant_id,id,branch_id,record_number,amanat_type,status,amount_decimal,received_date,data_json FROM amanat_records WHERE tenant_id = ? ORDER BY received_date DESC, rowid DESC'
      ).all(actor.tenantId);
      const records = rows.map((row) => ({
        ...parseRowJson(row),
        id: row.id,
        tenantId: row.tenant_id,
        branchId: row.branch_id || '',
        recordNumber: row.record_number,
        type: row.amanat_type,
        status: row.status,
        amount: unitsToNumber(parseScaledInt(row.amount_decimal, MONEY_SCALE, 'amanatAmount'), MONEY_SCALE),
        receivedDate: row.received_date,
      }));
      return filterRecordsByBranchScope(records, actor);
    },

    getAmanatById(actor, id) {
      assertPermission(actor, 'amanat:view', 'عرض سجل أمانة');
      if (!id) return undefined;
      const row = database.prepare(
        'SELECT tenant_id,id,branch_id,record_number,amanat_type,status,amount_decimal,received_date,data_json FROM amanat_records WHERE tenant_id = ? AND id = ?'
      ).get(actor.tenantId, String(id));
      if (!row) return undefined;
      const record = {
        ...parseRowJson(row),
        id: row.id,
        tenantId: row.tenant_id,
        branchId: row.branch_id || '',
        recordNumber: row.record_number,
        type: row.amanat_type,
        status: row.status,
        amount: unitsToNumber(parseScaledInt(row.amount_decimal, MONEY_SCALE, 'amanatAmount'), MONEY_SCALE),
        receivedDate: row.received_date,
      };
      return filterRecordsByBranchScope([record], actor)[0];
    },

    createAmanatDepositAtomic(actor, params) {
      if (!params || typeof params !== 'object' || !params.record) {
        throw new FinancialValidationError('بيانات سجل الأمانة غير مكتملة.');
      }
      assertPermission(actor, 'amanat:manage', 'استلام أمانة');
      const rawRecord = params.record;
      if (!['CASH', 'ITEM'].includes(rawRecord.type)) {
        throw new FinancialValidationError('نوع الأمانة يجب أن يكون CASH أو ITEM.');
      }

      const tenantId = actor.tenantId;
      const activeBranch = resolveBranchTx(database, core, actor, rawRecord.branchId);
      const branchId = activeBranch.id;
      const terminalCode = getTerminalCodeValue(database, tenantId);
      const nowIso = new Date().toISOString();
      const effectiveCashBoxId = params.cashBoxId || rawRecord.cashBoxId || 'cb-1';

      database.exec('BEGIN IMMEDIATE');
      try {
        const record = { ...rawRecord };
        if (!record.id || !String(record.id).trim()) {
          record.id = randomUUID();
        } else {
          record.id = String(record.id).trim();
        }

        const existingRow = database.prepare(
          'SELECT tenant_id,id,branch_id,record_number,amanat_type,status,amount_decimal,received_date,data_json FROM amanat_records WHERE tenant_id = ? AND id = ?'
        ).get(tenantId, record.id);
        if (existingRow) {
          const existing = {
            ...parseRowJson(existingRow),
            id: existingRow.id,
            branchId: existingRow.branch_id || '',
            recordNumber: existingRow.record_number,
            type: existingRow.amanat_type,
            status: existingRow.status,
            amount: unitsToNumber(parseScaledInt(existingRow.amount_decimal, MONEY_SCALE, 'amanatAmount'), MONEY_SCALE),
            receivedDate: existingRow.received_date,
          };
          const existingJe = existing.journalEntryId
            ? hydrateJournalEntryRow(
                database,
                tenantId,
                database.prepare('SELECT tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json FROM journal_entries WHERE tenant_id = ? AND id = ?').get(tenantId, existing.journalEntryId)
              )
            : undefined;
          database.exec('COMMIT');
          return { success: true, record: existing, journalEntry: existingJe };
        }

        if (!String(record.depositorName || '').trim() || !String(record.depositorPhone || '').trim()) {
          throw new FinancialValidationError('اسم المودع ورقم الهاتف مطلوبان لتسجيل الأمانة.');
        }

        let cashBox;
        let amountUnits = 0n;
        if (record.type === 'CASH') {
          amountUnits = parseScaledInt(record.amount, MONEY_SCALE, 'amanat.amount');
          if (amountUnits <= 0n) {
            throw new FinancialValidationError('مبلغ الأمانة النقدية يجب أن يكون أكبر من الصفر.');
          }
          cashBox = getCashBoxRowTx(database, tenantId, effectiveCashBoxId);
          if (!cashBox) {
            throw new FinancialValidationError('يجب تحديد صندوق نقدي صالح لاستلام الأمانة النقدية.');
          }
          assertCashBoxBranchAccessTx(actor, cashBox, branchId);
        } else if (!String(record.itemDescription || '').trim()) {
          throw new FinancialValidationError('وصف الصنف العيني مطلوب لتسجيل الأمانة العينية.');
        }

        if (!record.recordNumber || !String(record.recordNumber).trim()) {
          record.recordNumber = allocateSequenceTx(database, tenantId, 'AMN', activeBranch.code, terminalCode, nowIso);
        } else {
          record.recordNumber = String(record.recordNumber).trim();
        }

        const receivedDate = record.receivedDate || nowIso.split('T')[0];
        const persistedRecord = {
          ...record,
          tenantId,
          branchId,
          status: 'HELD',
          receivedDate,
          cashBoxId: record.type === 'CASH' ? cashBox.id : undefined,
          amount: record.type === 'CASH' ? unitsToNumber(amountUnits, MONEY_SCALE) : 0,
        };

        let createdEntry;
        if (persistedRecord.type === 'CASH') {
          const amanatAccRow = database.prepare(
            'SELECT code FROM accounts WHERE tenant_id = ? AND code = ?'
          ).get(tenantId, '2102');
          if (!amanatAccRow) {
            throw new FinancialValidationError('حساب الأمانات للغير (2102) غير موجود في الدليل المحاسبي.');
          }

          const updatedBox = updateCashBoxBalanceTx(database, tenantId, cashBox.id, amountUnits, false);
          const boxAcc = updateAccountBalanceTx(database, tenantId, cashBox.accountCode, amountUnits);
          const amanatAcc = updateAccountBalanceTx(database, tenantId, '2102', amountUnits);

          const entryNumber = allocateSequenceTx(database, tenantId, 'JV', activeBranch.code, terminalCode, nowIso);
          const amtNum = unitsToNumber(amountUnits, MONEY_SCALE);
          const jeResult = insertJournalEntryTx(database, tenantId, {
            id: randomUUID(),
            entryNumber,
            date: String(receivedDate).split('T')[0],
            description: `إيداع أمانة نقدية رقم ${persistedRecord.recordNumber} - ${persistedRecord.depositorName}`,
            costCenterId: 'general',
            branchId,
            lines: [
              {
                id: randomUUID(),
                accountCode: cashBox.accountCode,
                accountName: boxAcc?.nameAr || updatedBox.nameAr,
                debit: amtNum,
                credit: 0,
                costCenterId: 'general',
                memo: `استلام أمانة نقدية سند رقم ${persistedRecord.recordNumber}`,
              },
              {
                id: randomUUID(),
                accountCode: '2102',
                accountName: amanatAcc?.nameAr || 'أمانات وعهد نقدية للغير',
                debit: 0,
                credit: amtNum,
                costCenterId: 'general',
                memo: `التزام أمانة للغير للمودع ${persistedRecord.depositorName}`,
              },
            ],
            status: 'POSTED',
            referenceType: 'AMANAT',
            referenceId: persistedRecord.id,
            isAutoGenerated: true,
          });
          createdEntry = jeResult.persisted;
          persistedRecord.journalEntryId = createdEntry.id;
        }

        database.prepare(
          `INSERT INTO amanat_records
            (tenant_id,id,branch_id,record_number,amanat_type,status,amount_decimal,received_date,data_json)
           VALUES (?,?,?,?,?,?,?,?,?)`
        ).run(
          tenantId,
          persistedRecord.id,
          branchId,
          persistedRecord.recordNumber,
          persistedRecord.type,
          persistedRecord.status,
          formatScaledInt(amountUnits, MONEY_SCALE),
          persistedRecord.receivedDate,
          JSON.stringify(persistedRecord)
        );

        enqueueOutboxTx(database, actor, {
          entityType: 'AMANAT',
          entityId: persistedRecord.id,
          action: 'CREATE',
          payload: persistedRecord,
          priority: 3,
          dependsOn: persistedRecord.cashBoxId ? [persistedRecord.cashBoxId] : undefined,
          idempotencyKey: `${tenantId}_AMANAT_${persistedRecord.id}_CREATE`,
          branchId,
          nowIso,
        });
        if (createdEntry) {
          enqueueOutboxTx(database, actor, {
            entityType: 'JOURNAL_ENTRY',
            entityId: createdEntry.id,
            action: 'CREATE',
            payload: createdEntry,
            priority: 4,
            dependsOn: [persistedRecord.id],
            idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${createdEntry.id}_CREATE`,
            branchId,
            nowIso,
          });
        }
        writeAuditLogTx(
          database,
          { ...actor, branchId },
          `إيداع أمانة ${persistedRecord.type === 'CASH' ? 'نقدية' : 'عينية'}`,
          `سند أمانة ${persistedRecord.recordNumber} للمودع ${persistedRecord.depositorName}`,
          nowIso
        );

        database.exec('COMMIT');
        return { success: true, record: persistedRecord, journalEntry: createdEntry };
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    returnAmanatAtomic(actor, params) {
      if (!params || typeof params !== 'object' || !params.recordId) {
        throw new FinancialValidationError('معرف سجل الأمانة مطلوب.');
      }
      assertPermission(actor, 'amanat:manage', 'رد وتسليم أمانة');

      const tenantId = actor.tenantId;
      const terminalCode = getTerminalCodeValue(database, tenantId);
      const nowIso = new Date().toISOString();
      const todayStr = nowIso.split('T')[0];

      database.exec('BEGIN IMMEDIATE');
      try {
        const row = database.prepare(
          'SELECT tenant_id,id,branch_id,record_number,amanat_type,status,amount_decimal,received_date,data_json FROM amanat_records WHERE tenant_id = ? AND id = ?'
        ).get(tenantId, String(params.recordId));
        if (!row) {
          throw new FinancialValidationError('سجل الأمانة المطلوب غير موجود.');
        }

        const record = {
          ...parseRowJson(row),
          id: row.id,
          tenantId: row.tenant_id,
          branchId: row.branch_id || '',
          recordNumber: row.record_number,
          type: row.amanat_type,
          status: row.status,
          amount: unitsToNumber(parseScaledInt(row.amount_decimal, MONEY_SCALE, 'amanatAmount'), MONEY_SCALE),
          receivedDate: row.received_date,
        };
        const recordBranchId = String(record.branchId || '').trim();
        assertBranchAccess(actor, recordBranchId);
        if (record.status !== 'HELD') {
          throw new FinancialValidationError('لا يمكن رد أمانة ليست في حالة الحفظ (HELD).');
        }
        const branchRow = database.prepare('SELECT id, code FROM branches WHERE tenant_id = ? AND id = ?').get(tenantId, recordBranchId);
        if (!branchRow) {
          throw new FinancialValidationError('فرع سجل الأمانة غير موجود.');
        }

        let cashBox;
        let returnEntry;
        const updatedRecord = {
          ...record,
          branchId: recordBranchId,
          status: 'RETURNED',
          returnedDate: todayStr,
          recipientSignatureName: params.recipientSignatureName || record.depositorName,
        };

        if (updatedRecord.type === 'CASH') {
          const amountUnits = parseScaledInt(updatedRecord.amount, MONEY_SCALE, 'amanat.amount');
          if (amountUnits <= 0n) {
            throw new FinancialValidationError('مبلغ الأمانة النقدية غير صالح للرد.');
          }
          const effectiveBoxId = params.cashBoxId || record.cashBoxId || 'cb-1';
          cashBox = getCashBoxRowTx(database, tenantId, effectiveBoxId);
          if (!cashBox) {
            throw new FinancialValidationError('الصندوق النقدي المحدد لرد الأمانة غير موجود.');
          }
          assertCashBoxBranchAccessTx(actor, cashBox, recordBranchId);
          if (cashBox._balanceUnits < amountUnits) {
            throw new FinancialValidationError(
              `رصيد الصندوق (${cashBox.nameAr}: ${cashBox.balance}) غير كافٍ لرد الأمانة النقدية (${updatedRecord.amount}).`
            );
          }

          const amanatAccRow = database.prepare('SELECT code FROM accounts WHERE tenant_id = ? AND code = ?').get(tenantId, '2102');
          if (!amanatAccRow) {
            throw new FinancialValidationError('حساب الأمانات للغير (2102) غير موجود.');
          }

          const updatedBox = updateCashBoxBalanceTx(database, tenantId, cashBox.id, -amountUnits, true);
          const boxAcc = updateAccountBalanceTx(database, tenantId, cashBox.accountCode, -amountUnits);
          const amanatAcc = updateAccountBalanceTx(database, tenantId, '2102', -amountUnits);

          const amtNum = unitsToNumber(amountUnits, MONEY_SCALE);
          const entryNumber = allocateSequenceTx(database, tenantId, 'JV', branchRow.code || 'BR01', terminalCode, nowIso);
          const jeResult = insertJournalEntryTx(database, tenantId, {
            id: randomUUID(),
            entryNumber,
            date: todayStr,
            description: `رد وتسليم أمانة نقدية رقم ${updatedRecord.recordNumber} - ${updatedRecord.depositorName}`,
            costCenterId: 'general',
            branchId: recordBranchId,
            lines: [
              {
                id: randomUUID(),
                accountCode: '2102',
                accountName: amanatAcc?.nameAr || 'أمانات وعهد نقدية للغير',
                debit: amtNum,
                credit: 0,
                costCenterId: 'general',
                memo: `إبراء ذمة ورد أمانة رقم ${updatedRecord.recordNumber}`,
              },
              {
                id: randomUUID(),
                accountCode: cashBox.accountCode,
                accountName: boxAcc?.nameAr || updatedBox.nameAr,
                debit: 0,
                credit: amtNum,
                costCenterId: 'general',
                memo: `صرف رد أمانة رقم ${updatedRecord.recordNumber}`,
              },
            ],
            status: 'POSTED',
            referenceType: 'AMANAT',
            referenceId: updatedRecord.id,
            isAutoGenerated: true,
          });
          returnEntry = jeResult.persisted;
          updatedRecord.returnJournalEntryId = returnEntry.id;
        }

        database.prepare(
          'UPDATE amanat_records SET status = ?, data_json = ? WHERE tenant_id = ? AND id = ?'
        ).run(updatedRecord.status, JSON.stringify(updatedRecord), tenantId, updatedRecord.id);

        enqueueOutboxTx(database, actor, {
          entityType: 'AMANAT',
          entityId: updatedRecord.id,
          action: 'UPDATE',
          payload: updatedRecord,
          priority: 3,
          idempotencyKey: `${tenantId}_AMANAT_${updatedRecord.id}_RETURN`,
          branchId: recordBranchId,
          nowIso,
        });
        if (returnEntry) {
          enqueueOutboxTx(database, actor, {
            entityType: 'JOURNAL_ENTRY',
            entityId: returnEntry.id,
            action: 'CREATE',
            payload: returnEntry,
            priority: 4,
            dependsOn: [updatedRecord.id],
            idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${returnEntry.id}_CREATE`,
            branchId: recordBranchId,
            nowIso,
          });
        }
        writeAuditLogTx(
          database,
          { ...actor, branchId: recordBranchId },
          'رد وتسليم أمانة',
          `رد أمانة رقم ${updatedRecord.recordNumber} للمودع ${updatedRecord.depositorName}`,
          nowIso
        );

        database.exec('COMMIT');
        return { success: true, record: updatedRecord, journalEntry: returnEntry };
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    updateAmanatRecord(actor, record) {
      if (!record || !record.id) {
        throw new FinancialValidationError('معرف سجل الأمانة مطلوب للتحديث.');
      }
      assertPermission(actor, 'amanat:manage', 'تحديث سجل أمانة');
      const tenantId = actor.tenantId;
      const nowIso = new Date().toISOString();

      database.exec('BEGIN IMMEDIATE');
      try {
        const row = database.prepare(
          'SELECT tenant_id,id,branch_id,record_number,amanat_type,status,amount_decimal,received_date,data_json FROM amanat_records WHERE tenant_id = ? AND id = ?'
        ).get(tenantId, String(record.id));
        if (!row) {
          throw new FinancialValidationError('سجل الأمانة المطلوب تحديثه غير موجود.');
        }
        const targetBranchId = String(row.branch_id || record.branchId || '').trim();
        assertBranchAccess(actor, targetBranchId);

        // Preserve audited financial fields (type, amount, status); only metadata like notes can update safely
        const existing = parseRowJson(row);
        const persistedRecord = {
          ...existing,
          notes: record.notes ?? existing.notes,
          itemDescription: row.amanat_type === 'ITEM' ? (record.itemDescription ?? existing.itemDescription) : existing.itemDescription,
          depositorPhone: record.depositorPhone ?? existing.depositorPhone,
          branchId: targetBranchId,
        };

        database.prepare(
          'UPDATE amanat_records SET data_json = ? WHERE tenant_id = ? AND id = ?'
        ).run(JSON.stringify(persistedRecord), tenantId, row.id);

        enqueueOutboxTx(database, actor, {
          entityType: 'AMANAT',
          entityId: persistedRecord.id,
          action: 'UPDATE',
          payload: persistedRecord,
          branchId: targetBranchId,
          nowIso,
        });
        writeAuditLogTx(
          database,
          { ...actor, branchId: targetBranchId },
          'تحديث أمانة',
          `تحديث سجل أمانة ${row.record_number}`,
          nowIso
        );
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    // --- القيود المحاسبية اليدوية والقيود العكسية (Journal Entries & Reversals) ---
    getJournalEntries(actor, costCenterId) {
      assertPermission(actor, 'view:accounting', 'عرض القيود المحاسبية');
      const rows = costCenterId
        ? database.prepare(
            'SELECT tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json FROM journal_entries WHERE tenant_id = ? AND cost_center_id = ? ORDER BY entry_date DESC, rowid DESC'
          ).all(actor.tenantId, String(costCenterId))
        : database.prepare(
            'SELECT tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json FROM journal_entries WHERE tenant_id = ? ORDER BY entry_date DESC, rowid DESC'
          ).all(actor.tenantId);

      const entries = rows.map((row) => hydrateJournalEntryRow(database, actor.tenantId, row));
      return filterRecordsByBranchScope(entries, actor);
    },

    getJournalEntryById(actor, id) {
      assertPermission(actor, 'view:accounting', 'عرض تفاصيل قيد محاسبي');
      if (!id) return undefined;
      const row = database.prepare(
        'SELECT tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json FROM journal_entries WHERE tenant_id = ? AND id = ?'
      ).get(actor.tenantId, String(id));
      if (!row) return undefined;
      const hydrated = hydrateJournalEntryRow(database, actor.tenantId, row);
      return filterRecordsByBranchScope([hydrated], actor)[0];
    },

    createJournalEntryAtomic(actor, entry) {
      if (!entry || typeof entry !== 'object') {
        throw new FinancialValidationError('بيانات القيد المحاسبي غير صالحة.');
      }
      assertPermission(actor, 'journal:post', 'ترحيل قيد يومية يدوي');
      if (entry.isAutoGenerated || (entry.referenceType && entry.referenceType !== 'MANUAL')) {
        throw new FinancialValidationError('لا يمكن إنشاء قيود آلية مرتبطة بفواتير أو سندات من واجهة القيود اليدوية.');
      }

      const tenantId = actor.tenantId;
      const activeBranch = resolveBranchTx(database, core, actor, entry.branchId);
      const branchId = activeBranch.id;
      const terminalCode = getTerminalCodeValue(database, tenantId);
      const nowIso = new Date().toISOString();

      database.exec('BEGIN IMMEDIATE');
      try {
        const entryNumber = entry.entryNumber && String(entry.entryNumber).trim()
          ? String(entry.entryNumber).trim()
          : allocateSequenceTx(database, tenantId, 'JV', activeBranch.code, terminalCode, nowIso);

        const { persisted, linesWithUnits } = insertJournalEntryTx(database, tenantId, {
          ...entry,
          id: entry.id || randomUUID(),
          entryNumber,
          date: entry.date || nowIso.split('T')[0],
          branchId,
          status: 'POSTED',
          referenceType: 'MANUAL',
          isAutoGenerated: false,
        });

        for (const line of linesWithUnits) {
          const deltaUnits = line._debitUnits - line._creditUnits;
          updateAccountBalanceTx(database, tenantId, line.accountCode, deltaUnits);

          const linkedBoxes = database.prepare(
            'SELECT id, branch_id, account_code, data_json FROM cash_boxes WHERE tenant_id = ? AND account_code = ?'
          ).all(tenantId, line.accountCode);
          if (linkedBoxes.length > 0) {
            const branchBoxes = linkedBoxes.filter((b) => {
              const parsed = parseRowJson(b);
              return b.branch_id === branchId || Boolean(parsed.isCentral);
            });
            if (branchBoxes.length === 1) {
              const parsed = parseRowJson(branchBoxes[0]);
              if (parsed.isCentral) {
                assertPermission(actor, 'cashbox:central_access', 'قيد يدوي على الصندوق المركزي');
              }
              updateCashBoxBalanceTx(database, tenantId, branchBoxes[0].id, deltaUnits, true);
            }
          }
        }

        enqueueOutboxTx(database, actor, {
          entityType: 'JOURNAL_ENTRY',
          entityId: persisted.id,
          action: 'CREATE',
          payload: persisted,
          priority: 1,
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${persisted.id}_CREATE`,
          branchId,
          nowIso,
        });
        writeAuditLogTx(
          database,
          { ...actor, branchId },
          'ترحيل قيد يومية',
          `قيد رقم ${persisted.entryNumber}: ${persisted.description}`,
          nowIso
        );

        database.exec('COMMIT');
        return persisted;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    reverseJournalEntryAtomic(actor, originalEntryId, reversalReason) {
      assertPermission(actor, 'journal:reverse', 'عكس قيد محاسبي');
      if (!reversalReason || !String(reversalReason).trim()) {
        throw new FinancialValidationError('سبب القيد العكسي مطلوب لتوثيق مسار التدقيق.');
      }
      if (!originalEntryId) {
        throw new FinancialValidationError('معرف القيد الأصلي مطلوب.');
      }

      const tenantId = actor.tenantId;
      const terminalCode = getTerminalCodeValue(database, tenantId);
      const nowIso = new Date().toISOString();
      const reason = String(reversalReason).trim();

      database.exec('BEGIN IMMEDIATE');
      try {
        const origRow = database.prepare(
          'SELECT tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json FROM journal_entries WHERE tenant_id = ? AND id = ?'
        ).get(tenantId, String(originalEntryId));
        if (!origRow) {
          throw new FinancialValidationError('القيد الأصلي غير موجود.');
        }

        const original = hydrateJournalEntryRow(database, tenantId, origRow);
        if (original.status === 'REVERSED') {
          throw new FinancialValidationError('تم عكس هذا القيد مسبقاً.');
        }
        if (original.status === 'DRAFT') {
          throw new FinancialValidationError('لا يمكن عكس قيد مسودة غير مرحل.');
        }

        const originalBranchId = String(original.branchId || '').trim();
        assertBranchAccess(actor, originalBranchId);
        const origBranchRow = database.prepare(
          'SELECT id, code FROM branches WHERE tenant_id = ? AND id = ?'
        ).get(tenantId, originalBranchId);
        if (!origBranchRow) {
          throw new FinancialValidationError('فرع القيد الأصلي غير موجود.');
        }

        if (original.isAutoGenerated || (original.referenceType && original.referenceType !== 'MANUAL')) {
          throw new FinancialValidationError(
            'لا يمكن عكس قيد ناتج عن فاتورة أو سند أو أمانة من شاشة القيود؛ اعكس المستند الأصلي من وحدته حتى تُعكس آثاره على المخزون والصندوق والأرصدة معاً.'
          );
        }

        const reversalNumber = allocateSequenceTx(database, tenantId, 'REV', origBranchRow.code || 'BR01', terminalCode, nowIso);
        const reversalId = randomUUID();

        const reversedLines = original.lines.map((l) => ({
          id: randomUUID(),
          accountCode: l.accountCode,
          accountName: l.accountName,
          debit: l.credit,
          credit: l.debit,
          costCenterId: l.costCenterId,
          memo: `عكس لقيد ${original.entryNumber}: ${reason}`,
        }));

        const { persisted: reversalEntry, linesWithUnits } = insertJournalEntryTx(database, tenantId, {
          id: reversalId,
          entryNumber: reversalNumber,
          date: nowIso.split('T')[0],
          description: `قيد عكسي لتصحيح القيد ${original.entryNumber} - السبب: ${reason}`,
          costCenterId: original.costCenterId,
          branchId: originalBranchId,
          lines: reversedLines,
          status: 'POSTED',
          referenceType: original.referenceType,
          referenceId: original.referenceId,
          isAutoGenerated: true,
          reversedEntryId: original.id,
          reversalReason: reason,
        });

        for (const line of linesWithUnits) {
          const deltaUnits = line._debitUnits - line._creditUnits;
          updateAccountBalanceTx(database, tenantId, line.accountCode, deltaUnits);

          const linkedBoxes = database.prepare(
            'SELECT id, branch_id, account_code, data_json FROM cash_boxes WHERE tenant_id = ? AND account_code = ?'
          ).all(tenantId, line.accountCode);
          if (linkedBoxes.length > 0) {
            const branchBoxes = linkedBoxes.filter((b) => {
              const parsed = parseRowJson(b);
              return b.branch_id === originalBranchId || Boolean(parsed.isCentral);
            });
            if (branchBoxes.length !== 1) {
              throw new FinancialValidationError(
                `لا يمكن عكس القيد بأمان: حساب الصندوق (${line.accountCode}) لا يرتبط بصندوق واحد محدد في الفرع الأصلي.`
              );
            }
            const parsedBox = parseRowJson(branchBoxes[0]);
            if (parsedBox.isCentral) {
              assertPermission(actor, 'cashbox:central_access', 'عكس قيد على الصندوق المركزي');
            }
            updateCashBoxBalanceTx(database, tenantId, branchBoxes[0].id, deltaUnits, true);
          }
        }

        const updatedOriginal = {
          ...original,
          status: 'REVERSED',
          reversalReason: reason,
          reversedEntryId: reversalEntry.id,
        };
        database.prepare(
          'UPDATE journal_entries SET status = ?, data_json = ? WHERE tenant_id = ? AND id = ?'
        ).run('REVERSED', JSON.stringify(updatedOriginal), tenantId, original.id);

        enqueueOutboxTx(database, actor, {
          entityType: 'JOURNAL_ENTRY',
          entityId: reversalEntry.id,
          action: 'CREATE',
          payload: reversalEntry,
          priority: 1,
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${reversalEntry.id}_CREATE`,
          branchId: originalBranchId,
          nowIso,
        });
        enqueueOutboxTx(database, actor, {
          entityType: 'JOURNAL_ENTRY',
          entityId: updatedOriginal.id,
          action: 'UPDATE',
          payload: updatedOriginal,
          priority: 1,
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${updatedOriginal.id}_REVERSED`,
          branchId: originalBranchId,
          nowIso,
        });
        writeAuditLogTx(
          database,
          { ...actor, branchId: originalBranchId },
          'عكس قيد محاسبي',
          `إنشاء القيد العكسي ${reversalNumber} لتصحيح ${original.entryNumber}`,
          nowIso
        );

        database.exec('COMMIT');
        return reversalEntry;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },
  };
}
