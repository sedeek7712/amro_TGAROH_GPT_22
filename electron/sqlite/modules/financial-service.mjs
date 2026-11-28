import { randomUUID } from 'node:crypto';
import {
  assertActivityAccess,
  assertBranchAccess,
  assertPermission,
  filterRecordsByActivityScope,
  filterRecordsByBranchScope,
  hasPermission,
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
  computePurchaseBaseUnitCost,
  resolveUnitConversionToBase,
} from '../unit-conversion.mjs';
import { INITIAL_CHART_OF_ACCOUNTS } from '../seed-data.mjs';
import {
  SPECIAL_ACCOUNTS,
  resolveVoucherAccountingPlan,
} from '../payment-allocation-engine.mjs';
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
import {
  ACTIVITY_INVENTORY_ACCOUNTS,
  FinancialValidationError,
  accountBalanceDeltaUnitsByType,
  ensureCanonicalAccountTx,
  getTerminalCodeValue,
  insertJournalEntryTx,
  resolveBranchTx,
  updateAccountBalanceByLineTx,
  validateAndBuildJournalLines,
} from './accounting-tx-helpers.mjs';

export { FinancialValidationError };

const INVOICE_SELECT_COLUMNS =
  'tenant_id,id,branch_id,invoice_number,invoice_type,activity_id,party_id,invoice_date,due_date,payment_method,total_decimal,paid_amount_decimal,advance_applied_decimal,status,data_json';

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

const ACTIVITY_COGS_ACCOUNTS = {
  pharmacy: '5101',
  grocery: '5102',
  bike_parts: '5103',
  equipment_parts: '5104',
};

const ACTIVITY_SALES_RETURN_ACCOUNTS = {
  pharmacy: '4201',
  grocery: '4202',
  bike_parts: '4203',
  equipment_parts: '4204',
};

function getCurrencySymbol(database, tenantId) {
  const profile = getAppSetting(database, tenantId, 'company_profile', null);
  if (profile && typeof profile.currencySymbol === 'string' && profile.currencySymbol.trim()) {
    return profile.currencySymbol.trim();
  }
  const code = profile && typeof profile.currencyCode === 'string' ? profile.currencyCode : 'YER';
  return CURRENCY_SYMBOLS[code] || 'ر.ي';
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

function resolveBranchDefaultCashBoxTx(database, tenantId, branchId) {
  const rows = database.prepare(
    'SELECT tenant_id,id,branch_id,code,account_code,balance_decimal,data_json FROM cash_boxes WHERE tenant_id = ? AND branch_id = ?'
  ).all(tenantId, branchId);
  const candidates = rows
    .map((row) => ({ ...parseRowJson(row), id: row.id }))
    .filter((b) => !b.isCentral);
  const chosen = candidates.find((b) => b.isDefault) || candidates[0];
  if (!chosen) {
    throw new FinancialValidationError('لا يوجد صندوق نقدي مربوط بالفرع المحدد؛ يرجى إنشاء صندوق للفرع أولاً.');
  }
  return getCashBoxRowTx(database, tenantId, chosen.id);
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

function updatePartyBalancesTx(database, tenantId, partyId, debtDeltaUnits, advanceDeltaUnits = 0n) {
  if (!partyId) return null;
  const row = database.prepare(
    'SELECT id, balance_decimal, advance_balance_decimal, data_json FROM parties WHERE tenant_id = ? AND id = ?'
  ).get(tenantId, partyId);
  if (!row) return null;
  const currentBalUnits = parseScaledInt(row.balance_decimal, MONEY_SCALE, `partyBalance(${partyId})`);
  const currentAdvUnits = parseScaledInt(row.advance_balance_decimal ?? 0, MONEY_SCALE, `partyAdvance(${partyId})`);
  const nextBalUnits = currentBalUnits + debtDeltaUnits;
  const nextAdvUnits = currentAdvUnits + advanceDeltaUnits;
  if (nextAdvUnits < 0n) {
    throw new FinancialValidationError('لا يجوز أن يصبح الرصيد المقدم للطرف سالباً.');
  }
  const nextBalNum = unitsToNumber(nextBalUnits, MONEY_SCALE);
  const nextAdvNum = unitsToNumber(nextAdvUnits, MONEY_SCALE);
  const parsed = parseRowJson(row);
  parsed.id = row.id;
  parsed.balance = nextBalNum;
  parsed.advanceBalance = nextAdvNum;
  database.prepare(
    'UPDATE parties SET balance_decimal = ?, advance_balance_decimal = ?, data_json = ? WHERE tenant_id = ? AND id = ?'
  ).run(
    formatScaledInt(nextBalUnits, MONEY_SCALE),
    formatScaledInt(nextAdvUnits, MONEY_SCALE),
    JSON.stringify(parsed),
    tenantId,
    partyId
  );
  return { ...parsed, balance: nextBalNum, advanceBalance: nextAdvNum };
}

function updatePartyBalanceTx(database, tenantId, partyId, deltaUnits) {
  return updatePartyBalancesTx(database, tenantId, partyId, deltaUnits, 0n);
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

function resolveInvoiceItemUnitTx(database, tenantId, product, requestedUnitId) {
  const unitId = requestedUnitId !== undefined && requestedUnitId !== null
    ? String(requestedUnitId).trim()
    : '';
  if (!unitId || unitId === 'BASE') {
    return {
      unitId: 'BASE',
      unit: product.unit,
      unitNameSnapshot: product.unit,
      baseUnitNameSnapshot: product.unit,
      conversionNumeratorSnapshot: 1,
      conversionDenominatorSnapshot: 1,
    };
  }
  const unitRow = database.prepare(
    'SELECT tenant_id,id,product_id,code,name_ar,base_units_numerator,base_units_denominator,is_active FROM product_units WHERE tenant_id = ? AND id = ?'
  ).get(tenantId, unitId);
  if (!unitRow || unitRow.product_id !== product.id) {
    throw new FinancialValidationError(`الوحدة البديلة المحددة غير صالحة أو لا تنتمي للصنف (${product.nameAr}).`);
  }
  if (unitRow.is_active !== 1) {
    throw new FinancialValidationError(
      `الوحدة البديلة (${unitRow.name_ar}) للصنف (${product.nameAr}) معطلة ولا يمكن استخدامها في فواتير جديدة.`
    );
  }
  return {
    unitId: unitRow.id,
    unit: unitRow.name_ar,
    unitNameSnapshot: unitRow.name_ar,
    baseUnitNameSnapshot: product.unit,
    conversionNumeratorSnapshot: unitRow.base_units_numerator,
    conversionDenominatorSnapshot: unitRow.base_units_denominator,
  };
}

function resolveOriginalInvoiceLineForReturn(origItems, reqItem, docLabel) {
  const reqItemId = reqItem.originalInvoiceItemId ? String(reqItem.originalInvoiceItemId).trim() : '';
  if (reqItemId) {
    const exact = origItems.find((it) => it.id === reqItemId);
    if (!exact || exact.productId !== reqItem.productId) {
      throw new FinancialValidationError(`بند الفاتورة الأصلية (${reqItemId}) غير موجود أو لا يطابق الصنف.`);
    }
    if (reqItem.batchNumber && exact.batchNumber && exact.batchNumber !== reqItem.batchNumber) {
      throw new FinancialValidationError(`رقم التشغيلة (${reqItem.batchNumber}) لا يطابق بند الفاتورة الأصلية المحدد.`);
    }
    return exact;
  }
  const matchingOrigLines = origItems.filter(
    (it) =>
      it.productId === reqItem.productId &&
      (!reqItem.batchNumber || it.batchNumber === reqItem.batchNumber)
  );
  if (matchingOrigLines.length === 0) {
    throw new FinancialValidationError(`الصنف (${reqItem.productId}) غير موجود ضمن بنود ${docLabel}.`);
  }
  if (matchingOrigLines.length > 1) {
    throw new FinancialValidationError(
      `توجد عدة أسطر للصنف (${matchingOrigLines[0].productName || reqItem.productId}) في ${docLabel}؛ يجب تحديد السطر المطلوب إرجاعه.`
    );
  }
  return matchingOrigLines[0];
}

function hydrateInvoiceRow(database, tenantId, row) {
  if (!row) return undefined;
  const parsed = parseRowJson(row);
  const itemRows = database.prepare(
    'SELECT id, product_id, quantity_decimal, base_quantity_decimal, unit_price_decimal, total_decimal, data_json FROM invoice_items WHERE tenant_id = ? AND invoice_id = ? ORDER BY rowid ASC'
  ).all(tenantId, row.id);
  const deductionRows = database.prepare(
    'SELECT line_number, invoice_item_id, product_id, batch_number, quantity_decimal, unit_cost_decimal, data_json FROM invoice_stock_deductions WHERE tenant_id = ? AND invoice_id = ? ORDER BY line_number ASC'
  ).all(tenantId, row.id);

  const items = itemRows.length > 0
    ? itemRows.map((ir) => {
        const parsedItem = parseRowJson(ir);
        const baseQuantity = ir.base_quantity_decimal != null
          ? unitsToNumber(parseScaledInt(ir.base_quantity_decimal, QTY_SCALE, 'dbInvItemBaseQty'), QTY_SCALE)
          : parsedItem.baseQuantity;
        return {
          ...parsedItem,
          id: ir.id,
          productId: ir.product_id,
          quantity: unitsToNumber(parseScaledInt(ir.quantity_decimal, QTY_SCALE, 'dbInvItemQty'), QTY_SCALE),
          ...(baseQuantity !== undefined ? { baseQuantity } : {}),
          unitPrice: unitsToNumber(parseScaledInt(ir.unit_price_decimal, MONEY_SCALE, 'dbInvItemPrice'), MONEY_SCALE),
          total: unitsToNumber(parseScaledInt(ir.total_decimal, MONEY_SCALE, 'dbInvItemTotal'), MONEY_SCALE),
        };
      })
    : (Array.isArray(parsed.items) ? parsed.items : []);

  const stockDeductionsRecorded = deductionRows.length > 0
    ? deductionRows.map((dr) => {
        const parsedDed = parseRowJson(dr);
        const invoiceItemId = dr.invoice_item_id || parsedDed.invoiceItemId;
        return {
          ...parsedDed,
          ...(invoiceItemId ? { invoiceItemId } : {}),
          productId: dr.product_id,
          batchNumber: dr.batch_number ?? undefined,
          quantity: unitsToNumber(parseScaledInt(dr.quantity_decimal, QTY_SCALE, 'dbDedQty'), QTY_SCALE),
          unitCost: unitsToNumber(parseScaledInt(dr.unit_cost_decimal, QTY_SCALE, 'dbDedCost'), QTY_SCALE),
        };
      })
    : parsed.stockDeductionsRecorded;

  const advAppliedUnits = parseScaledInt(row.advance_applied_decimal ?? parsed.advanceAppliedAmount ?? 0, MONEY_SCALE, 'dbInvAdvApplied');
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
    dueDate: row.due_date ?? parsed.dueDate,
    paymentMethod: row.payment_method,
    total: unitsToNumber(parseScaledInt(row.total_decimal, MONEY_SCALE, 'dbInvTotal'), MONEY_SCALE),
    paidAmount: unitsToNumber(parseScaledInt(row.paid_amount_decimal, MONEY_SCALE, 'dbInvPaid'), MONEY_SCALE),
    advanceAppliedAmount: unitsToNumber(advAppliedUnits, MONEY_SCALE),
    status: row.status,
    items,
    ...(stockDeductionsRecorded ? { stockDeductionsRecorded } : {}),
  };
}

function insertInvoiceTx(database, tenantId, invoice) {
  const totalUnits = parseScaledInt(invoice.total, MONEY_SCALE, 'invoice.total');
  const paidUnits = parseScaledInt(invoice.paidAmount ?? 0, MONEY_SCALE, 'invoice.paidAmount');
  const advAppliedUnits = parseScaledInt(invoice.advanceAppliedAmount ?? 0, MONEY_SCALE, 'invoice.advanceAppliedAmount');

  const persisted = {
    ...invoice,
    tenantId,
    total: unitsToNumber(totalUnits, MONEY_SCALE),
    paidAmount: unitsToNumber(paidUnits, MONEY_SCALE),
    advanceAppliedAmount: unitsToNumber(advAppliedUnits, MONEY_SCALE),
    dueDate: invoice.dueDate ? String(invoice.dueDate).trim() : undefined,
    status: invoice.status || (invoice.isPosted === false ? 'DRAFT' : 'POSTED'),
  };

  database.prepare(
    `INSERT INTO invoices
      (tenant_id,id,branch_id,invoice_number,invoice_type,activity_id,party_id,invoice_date,due_date,payment_method,total_decimal,paid_amount_decimal,advance_applied_decimal,status,data_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    tenantId,
    persisted.id,
    persisted.branchId || null,
    persisted.invoiceNumber,
    persisted.type,
    persisted.activityId,
    persisted.partyId || null,
    persisted.date,
    persisted.dueDate || null,
    persisted.paymentMethod,
    formatScaledInt(totalUnits, MONEY_SCALE),
    formatScaledInt(paidUnits, MONEY_SCALE),
    formatScaledInt(advAppliedUnits, MONEY_SCALE),
    persisted.status,
    JSON.stringify(persisted)
  );

  const itemStmt = database.prepare(
    `INSERT INTO invoice_items
      (tenant_id,invoice_id,id,product_id,quantity_decimal,base_quantity_decimal,unit_price_decimal,total_decimal,data_json)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  for (const item of persisted.items || []) {
    const qtyUnits = parseScaledInt(item.quantity, QTY_SCALE, 'item.quantity');
    const baseQtyUnits =
      item.baseQuantity !== undefined && item.baseQuantity !== null
        ? parseScaledInt(item.baseQuantity, QTY_SCALE, 'item.baseQuantity')
        : null;
    const unitPriceUnits = parseScaledInt(item.unitPrice ?? 0, MONEY_SCALE, 'item.unitPrice');
    const lineTotalUnits = parseScaledInt(item.total ?? 0, MONEY_SCALE, 'item.total');
    const cleanItem = {
      ...item,
      id: String(item.id || '').trim() || randomUUID(),
      quantity: unitsToNumber(qtyUnits, QTY_SCALE),
      ...(baseQtyUnits !== null ? { baseQuantity: unitsToNumber(baseQtyUnits, QTY_SCALE) } : {}),
      unitPrice: unitsToNumber(unitPriceUnits, MONEY_SCALE),
      total: unitsToNumber(lineTotalUnits, MONEY_SCALE),
    };
    itemStmt.run(
      tenantId,
      persisted.id,
      cleanItem.id,
      cleanItem.productId,
      formatScaledInt(qtyUnits, QTY_SCALE),
      baseQtyUnits !== null ? formatScaledInt(baseQtyUnits, QTY_SCALE) : null,
      formatScaledInt(unitPriceUnits, MONEY_SCALE),
      formatScaledInt(lineTotalUnits, MONEY_SCALE),
      JSON.stringify(cleanItem)
    );
  }

  const dedStmt = database.prepare(
    `INSERT INTO invoice_stock_deductions
      (tenant_id,invoice_id,line_number,invoice_item_id,product_id,batch_number,quantity_decimal,unit_cost_decimal,data_json)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  const deductions = Array.isArray(persisted.stockDeductionsRecorded) ? persisted.stockDeductionsRecorded : [];
  for (let idx = 0; idx < deductions.length; idx += 1) {
    const ded = deductions[idx];
    const dQtyUnits = parseScaledInt(ded.quantity, QTY_SCALE, 'ded.quantity');
    const dCostUnits = parseScaledInt(ded.unitCost ?? 0, QTY_SCALE, 'ded.unitCost');
    const cleanDed = {
      ...ded,
      ...(ded.invoiceItemId ? { invoiceItemId: String(ded.invoiceItemId) } : {}),
      quantity: unitsToNumber(dQtyUnits, QTY_SCALE),
      unitCost: unitsToNumber(dCostUnits, QTY_SCALE),
    };
    dedStmt.run(
      tenantId,
      persisted.id,
      idx,
      cleanDed.invoiceItemId || null,
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
            `SELECT ${INVOICE_SELECT_COLUMNS} FROM invoices WHERE tenant_id = ? AND activity_id = ? ORDER BY invoice_date DESC, rowid DESC`
          ).all(actor.tenantId, String(activityId))
        : database.prepare(
            `SELECT ${INVOICE_SELECT_COLUMNS} FROM invoices WHERE tenant_id = ? ORDER BY invoice_date DESC, rowid DESC`
          ).all(actor.tenantId);

      const hydrated = rows.map((r) => hydrateInvoiceRow(database, actor.tenantId, r));
      return filterRecordsByActivityScope(filterRecordsByBranchScope(hydrated, actor), actor);
    },

    getInvoiceById(actor, id) {
      assertPermission(actor, 'invoices:view', 'عرض تفاصيل الفاتورة');
      if (!id) return undefined;
      const row = database.prepare(
        `SELECT ${INVOICE_SELECT_COLUMNS} FROM invoices WHERE tenant_id = ? AND id = ?`
      ).get(actor.tenantId, String(id));
      if (!row) return undefined;
      const hydrated = hydrateInvoiceRow(database, actor.tenantId, row);
      return filterRecordsByActivityScope(filterRecordsByBranchScope([hydrated], actor), actor)[0];
    },

    createSalesInvoiceAtomic(actor, params) {
      if (!params || typeof params !== 'object' || !params.invoice) {
        throw new FinancialValidationError('بيانات فاتورة المبيعات غير مكتملة.');
      }
      assertPermission(actor, 'pos:sale', 'إصدار فاتورة مبيعات');
      const rawInvoice = params.invoice;
      assertActivityAccess(actor, rawInvoice.activityId, 'إصدار فاتورة مبيعات');
      const stockDeductions = Array.isArray(params.stockDeductions) ? params.stockDeductions : [];
      const clientRequestId = params.clientRequestId ? String(params.clientRequestId).trim() : '';
      const applyAdvanceUnits = parseScaledInt(params.applyAdvanceAmount ?? 0, MONEY_SCALE, 'applyAdvanceAmount');
      if (applyAdvanceUnits < 0n) {
        throw new FinancialValidationError('مبلغ التسوية من الرصيد المقدم لا يجوز أن يكون سالباً.');
      }
      if (applyAdvanceUnits > 0n) {
        assertPermission(actor, 'party:advance:use', 'تسوية الرصيد المقدم على فاتورة المبيعات');
      }

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
          `SELECT ${INVOICE_SELECT_COLUMNS} FROM invoices WHERE tenant_id = ? AND id = ?`
        ).get(tenantId, invoice.id);
        if (existingInvRow) {
          const existingInv = hydrateInvoiceRow(database, tenantId, existingInvRow);
          if (existingInv.journalEntryId) {
            const existingJeRow = database.prepare(
              'SELECT tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json FROM journal_entries WHERE tenant_id = ? AND id = ?'
            ).get(tenantId, existingInv.journalEntryId);
            const advJeRow = database.prepare(
              "SELECT tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json FROM journal_entries WHERE tenant_id = ? AND reference_type = 'ADVANCE_SETTLEMENT' AND reference_id = ?"
            ).get(tenantId, existingInv.id);
            if (existingJeRow) {
              const existingJe = hydrateJournalEntryRow(database, tenantId, existingJeRow);
              const advanceJournalEntry = advJeRow ? hydrateJournalEntryRow(database, tenantId, advJeRow) : undefined;
              database.exec('COMMIT');
              return { success: true, invoice: existingInv, journalEntry: existingJe, advanceJournalEntry };
            }
          }
        }
        if (clientRequestId) {
          const dupOutbox = database.prepare(
            'SELECT entity_id FROM outbox_queue WHERE tenant_id = ? AND idempotency_key = ?'
          ).get(tenantId, `REQ_${tenantId}_${clientRequestId}`);
          if (dupOutbox) {
            const dupInvRow = database.prepare(
              `SELECT ${INVOICE_SELECT_COLUMNS} FROM invoices WHERE tenant_id = ? AND id = ?`
            ).get(tenantId, dupOutbox.entity_id);
            if (dupInvRow) {
              const dupInv = hydrateInvoiceRow(database, tenantId, dupInvRow);
              if (dupInv.journalEntryId) {
                const dupJeRow = database.prepare(
                  'SELECT tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json FROM journal_entries WHERE tenant_id = ? AND id = ?'
                ).get(tenantId, dupInv.journalEntryId);
                const advJeRow = database.prepare(
                  "SELECT tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json FROM journal_entries WHERE tenant_id = ? AND reference_type = 'ADVANCE_SETTLEMENT' AND reference_id = ?"
                ).get(tenantId, dupInv.id);
                if (dupJeRow) {
                  const dupJe = hydrateJournalEntryRow(database, tenantId, dupJeRow);
                  const advanceJournalEntry = advJeRow ? hydrateJournalEntryRow(database, tenantId, advJeRow) : undefined;
                  database.exec('COMMIT');
                  return { success: true, invoice: dupInv, journalEntry: dupJe, advanceJournalEntry };
                }
              }
            }
          }
        }

        // 2. Validate structural & exact monetary inputs + authoritative unit conversion
        if (!invoice.items || invoice.items.length === 0) {
          throw new FinancialValidationError('فاتورة المبيعات يجب أن تحتوي على صنف واحد على الأقل.');
        }
        if (stockDeductions.length === 0) {
          throw new FinancialValidationError('بنود خصم المخزون مطلوبة لإتمام فاتورة المبيعات.');
        }

        const itemQtyByProduct = new Map();
        const itemLineBaseMap = new Map();
        for (const item of invoice.items) {
          item.id = String(item.id || '').trim() || randomUUID();
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

          const lineProduct = loadProductWithBatches(database, tenantId, item.productId);
          if (!lineProduct) {
            throw new FinancialValidationError(`الصنف ذو المعرف ${item.productId} غير موجود في المستودع.`);
          }
          if (lineProduct.isActive === false) {
            throw new FinancialValidationError(`الصنف (${lineProduct.nameAr}) مؤرشف ومعطل ولا يمكن بيعه.`);
          }
          const resolvedUnit = resolveInvoiceItemUnitTx(database, tenantId, lineProduct, item.unitId);
          let conversion;
          try {
            conversion = resolveUnitConversionToBase({
              quantity: unitsToNumber(qtyUnits, QTY_SCALE),
              numerator: resolvedUnit.conversionNumeratorSnapshot,
              denominator: resolvedUnit.conversionDenominatorSnapshot,
              unitName: resolvedUnit.unitNameSnapshot,
            });
          } catch (err) {
            throw new FinancialValidationError(err instanceof Error ? err.message : 'تعذر تحويل وحدة الصنف.');
          }

          item.unitId = resolvedUnit.unitId;
          item.unit = resolvedUnit.unit;
          item.unitNameSnapshot = resolvedUnit.unitNameSnapshot;
          item.baseUnitNameSnapshot = resolvedUnit.baseUnitNameSnapshot;
          item.conversionNumeratorSnapshot = resolvedUnit.conversionNumeratorSnapshot;
          item.conversionDenominatorSnapshot = resolvedUnit.conversionDenominatorSnapshot;
          item.baseQuantity = conversion.baseQuantity;

          itemQtyByProduct.set(item.productId, (itemQtyByProduct.get(item.productId) || 0n) + conversion.baseQtyUnits);
          itemLineBaseMap.set(item.id, { productId: item.productId, baseQtyUnits: conversion.baseQtyUnits });
        }

        const dedQtyByProduct = new Map();
        const dedQtyByItemId = new Map();
        for (const ded of stockDeductions) {
          if (!ded || !ded.productId) {
            throw new FinancialValidationError('معرف الصنف في خصم المخزون مطلوب.');
          }
          const dQtyUnits = parseScaledInt(ded.quantity, QTY_SCALE, 'ded.quantity');
          if (dQtyUnits <= 0n) {
            throw new FinancialValidationError('كمية خصم المخزون يجب أن تكون رقماً موجباً أكبر من الصفر.');
          }
          dedQtyByProduct.set(ded.productId, (dedQtyByProduct.get(ded.productId) || 0n) + dQtyUnits);
          if (ded.invoiceItemId) {
            const lineEntry = itemLineBaseMap.get(String(ded.invoiceItemId));
            if (!lineEntry || lineEntry.productId !== ded.productId) {
              throw new FinancialValidationError('معرف سطر الفاتورة في خصم المخزون لا يطابق بنود الفاتورة.');
            }
            dedQtyByItemId.set(String(ded.invoiceItemId), (dedQtyByItemId.get(String(ded.invoiceItemId)) || 0n) + dQtyUnits);
          }
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
        if (dedQtyByItemId.size > 0) {
          for (const [itemId, lineEntry] of itemLineBaseMap) {
            const dUnits = dedQtyByItemId.get(itemId);
            if (dUnits !== undefined) {
              const diff = lineEntry.baseQtyUnits > dUnits ? lineEntry.baseQtyUnits - dUnits : dUnits - lineEntry.baseQtyUnits;
              if (diff > 1n) {
                throw new FinancialValidationError(`كمية السطر (${itemId}) لا تطابق كمية خصم المخزون.`);
              }
            }
          }
        }

        const subtotalUnits = parseScaledInt(invoice.subtotal ?? 0, MONEY_SCALE, 'invoice.subtotal');
        const discountUnits = parseScaledInt(invoice.discount ?? 0, MONEY_SCALE, 'invoice.discount');
        const taxUnits = parseScaledInt(invoice.tax ?? 0, MONEY_SCALE, 'invoice.tax');
        const totalUnits = parseScaledInt(invoice.total ?? 0, MONEY_SCALE, 'invoice.total');
        const cashPaidUnits = parseScaledInt(invoice.paidAmount ?? 0, MONEY_SCALE, 'invoice.paidAmount');

        if (subtotalUnits < 0n || discountUnits < 0n || taxUnits < 0n || totalUnits < 0n || cashPaidUnits < 0n) {
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
        const totalSettledUnits = cashPaidUnits + applyAdvanceUnits;
        if (totalSettledUnits > totalUnits + 1n) {
          throw new FinancialValidationError(
            `مجموع المدفوع نقداً والمخصوم من الرصيد المقدم (${unitsToNumber(totalSettledUnits, MONEY_SCALE)}) لا يمكن أن يتجاوز إجمالي الفاتورة (${unitsToNumber(totalUnits, MONEY_SCALE)}).`
          );
        }

        let targetCashBox;
        if (cashPaidUnits > 0n) {
          if (!invoice.cashBoxId || !String(invoice.cashBoxId).trim()) {
            throw new FinancialValidationError('يجب تحديد صندوق نقدي/بنكي صالح لتحصيل المبلغ المدفوع.');
          }
          targetCashBox = getCashBoxRowTx(database, tenantId, invoice.cashBoxId);
          assertCashBoxBranchAccessTx(actor, targetCashBox, branchId);
        }

        if (applyAdvanceUnits > 0n && !invoice.partyId) {
          throw new FinancialValidationError('استخدام الرصيد المقدم يتطلب اختيار عميل مسجل.');
        }

        const netUnpaidUnits = totalUnits - totalSettledUnits;
        if (invoice.paymentMethod === 'CREDIT' && netUnpaidUnits > 0n && !invoice.partyId) {
          throw new FinancialValidationError('يجب تحديد عميل مسجل عند البيع الآجل لتسجيل الذمة المدينة.');
        }
        let customerRow = null;
        if (invoice.partyId) {
          customerRow = database.prepare(
            'SELECT id, party_type, balance_decimal, advance_balance_decimal, data_json FROM parties WHERE tenant_id = ? AND id = ?'
          ).get(tenantId, invoice.partyId);
          if (!customerRow) {
            throw new FinancialValidationError('العميل المحدد غير موجود في قاعدة البيانات.');
          }
        }
        if (applyAdvanceUnits > 0n) {
          if (!customerRow || customerRow.party_type !== 'CUSTOMER') {
            throw new FinancialValidationError('تسوية الرصيد المقدم متاحة للعملاء المسجلين فقط.');
          }
          const availAdvUnits = parseScaledInt(customerRow.advance_balance_decimal ?? 0, MONEY_SCALE, 'customer.advanceBalance');
          if (availAdvUnits < applyAdvanceUnits) {
            throw new FinancialValidationError(
              `الرصيد المقدم المتاح للعميل (${unitsToNumber(availAdvUnits, MONEY_SCALE)}) غير كافٍ لخصم ${unitsToNumber(applyAdvanceUnits, MONEY_SCALE)}.`
            );
          }
        }

        // 3. Atomic inventory deduction & exact BigInt FEFO + COGS calculation
        const todayStr = nowIso.split('T')[0];
        let totalCogsRawUnits = 0n; // accumulated at TOTALS_SCALE (1000000n)
        const recordedStockDeductions = [];

        for (const ded of stockDeductions) {
          const dedItemId = ded.invoiceItemId ? String(ded.invoiceItemId) : undefined;
          const product = loadProductWithBatches(database, tenantId, ded.productId);
          if (!product) {
            throw new FinancialValidationError(`الصنف ذو المعرف ${ded.productId} غير موجود في المستودع.`);
          }
          if (product.isActive === false) {
            throw new FinancialValidationError(`الصنف (${product.nameAr}) مؤرشف ومعطل ولا يمكن بيعه.`);
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
                ...(dedItemId ? { invoiceItemId: dedItemId } : {}),
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
                  ...(dedItemId ? { invoiceItemId: dedItemId } : {}),
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
              ...(dedItemId ? { invoiceItemId: dedItemId } : {}),
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

        if (cashPaidUnits > 0n && targetCashBox) {
          const updatedBox = updateCashBoxBalanceTx(database, tenantId, targetCashBox.id, cashPaidUnits, false);
          const boxAcc = updateAccountBalanceByLineTx(database, tenantId, targetCashBox.accountCode, cashPaidUnits, 0n);
          journalLines.push({
            id: randomUUID(),
            accountCode: targetCashBox.accountCode,
            accountName: boxAcc?.nameAr || updatedBox.nameAr,
            debit: unitsToNumber(cashPaidUnits, MONEY_SCALE),
            credit: 0,
            costCenterId: invoice.activityId,
            memo: `تحصيل نقدي فاتورة مبيعات ${invoice.invoiceNumber}`,
          });
        }

        const grossCreditUnits = totalUnits - cashPaidUnits;
        if (grossCreditUnits > 0n) {
          const arAcc = updateAccountBalanceByLineTx(database, tenantId, '1103', grossCreditUnits, 0n);
          if (invoice.partyId) {
            updatePartyBalancesTx(database, tenantId, invoice.partyId, grossCreditUnits, 0n);
          }
          journalLines.push({
            id: randomUUID(),
            accountCode: '1103',
            accountName: `${arAcc?.nameAr || 'العملاء والمدينون'} - ${invoice.partyName || ''}`.trim(),
            debit: unitsToNumber(grossCreditUnits, MONEY_SCALE),
            credit: 0,
            costCenterId: invoice.activityId,
            memo: `ذمة فاتورة مبيعات ${invoice.invoiceNumber}`,
          });
        }

        const revAcc = updateAccountBalanceByLineTx(database, tenantId, revenueCode, 0n, totalUnits);
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
          const cogsAcc = updateAccountBalanceByLineTx(database, tenantId, cogsCode, cogsUnits, 0n);
          const invAcc = updateAccountBalanceByLineTx(database, tenantId, inventoryCode, 0n, cogsUnits);
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

        // 5b. Standalone Advance Settlement Entry (Dr 2103 / Cr 1103) if applying customer advance
        let advanceJournalEntry;
        const invoiceDate = invoice.date || todayStr;
        if (applyAdvanceUnits > 0n && customerRow) {
          const advNum = unitsToNumber(applyAdvanceUnits, MONEY_SCALE);
          const advAcc = ensureCanonicalAccountTx(database, tenantId, SPECIAL_ACCOUNTS.CUSTOMER_ADVANCES);
          const arAcc = ensureCanonicalAccountTx(database, tenantId, SPECIAL_ACCOUNTS.CUSTOMERS_AR);
          if (!advAcc || !arAcc) {
            throw new FinancialValidationError('حساب دفعات العملاء المقدمة (2103) أو العملاء (1103) غير معرف.');
          }

          const advEntryNumber = allocateSequenceTx(database, tenantId, 'JV', activeBranch.code, terminalCode, nowIso);
          const advJeRes = insertJournalEntryTx(database, tenantId, {
            id: randomUUID(),
            entryNumber: advEntryNumber,
            date: invoiceDate,
            description: `تسوية رصيد مقدم للعميل ${parseRowJson(customerRow).nameAr || invoice.partyName || ''} على فاتورة ${invoice.invoiceNumber}`,
            costCenterId: invoice.activityId,
            branchId,
            lines: [
              {
                id: randomUUID(),
                accountCode: SPECIAL_ACCOUNTS.CUSTOMER_ADVANCES,
                accountName: advAcc.nameAr,
                debit: advNum,
                credit: 0,
                costCenterId: invoice.activityId,
                memo: `استخدام رصيد مقدم لفاتورة ${invoice.invoiceNumber}`,
              },
              {
                id: randomUUID(),
                accountCode: SPECIAL_ACCOUNTS.CUSTOMERS_AR,
                accountName: arAcc.nameAr,
                debit: 0,
                credit: advNum,
                costCenterId: invoice.activityId,
                memo: `تخفيض ذمة العميل لفاتورة ${invoice.invoiceNumber}`,
              },
            ],
            status: 'POSTED',
            referenceType: 'ADVANCE_SETTLEMENT',
            referenceId: invoice.id,
            isAutoGenerated: true,
          });
          advanceJournalEntry = advJeRes.persisted;

          updateAccountBalanceByLineTx(database, tenantId, SPECIAL_ACCOUNTS.CUSTOMER_ADVANCES, applyAdvanceUnits, 0n);
          updateAccountBalanceByLineTx(database, tenantId, SPECIAL_ACCOUNTS.CUSTOMERS_AR, 0n, applyAdvanceUnits);
          const updatedParty = updatePartyBalancesTx(database, tenantId, customerRow.id, -applyAdvanceUnits, -applyAdvanceUnits);

          const advTx = {
            id: randomUUID(),
            tenantId,
            branchId,
            partyId: customerRow.id,
            partyType: 'CUSTOMER',
            type: 'APPLY_TO_INVOICE',
            amount: -advNum,
            balanceAfter: updatedParty.advanceBalance,
            invoiceId: invoice.id,
            journalEntryId: advanceJournalEntry.id,
            date: invoiceDate,
            description: `تسوية رصيد مقدم على الفاتورة ${invoice.invoiceNumber}`,
            createdBy: actor.id,
            createdAt: nowIso,
          };
          database.prepare(
            `INSERT INTO party_advance_transactions
              (tenant_id,id,branch_id,party_id,party_type,tx_type,amount_decimal,balance_after_decimal,voucher_id,invoice_id,journal_entry_id,tx_date,created_at,data_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).run(
            tenantId,
            advTx.id,
            branchId,
            advTx.partyId,
            advTx.partyType,
            advTx.type,
            formatScaledInt(-applyAdvanceUnits, MONEY_SCALE),
            formatScaledInt(parseScaledInt(advTx.balanceAfter, MONEY_SCALE, 'advBalAfter'), MONEY_SCALE),
            null,
            advTx.invoiceId,
            advTx.journalEntryId,
            advTx.date,
            advTx.createdAt,
            JSON.stringify(advTx)
          );

          const advAlloc = {
            id: randomUUID(),
            tenantId,
            branchId,
            advanceTransactionId: advTx.id,
            partyId: customerRow.id,
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            invoiceDate,
            allocatedAmount: advNum,
            allocationMethod: 'ADVANCE_SETTLEMENT',
            status: 'ACTIVE',
            createdAt: nowIso,
            createdBy: actor.id,
          };
          database.prepare(
            `INSERT INTO payment_allocations
              (tenant_id,id,branch_id,voucher_id,advance_transaction_id,party_id,invoice_id,allocated_decimal,allocation_method,status,created_at,created_by,data_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).run(
            tenantId,
            advAlloc.id,
            branchId,
            null,
            advTx.id,
            advAlloc.partyId,
            advAlloc.invoiceId,
            formatScaledInt(applyAdvanceUnits, MONEY_SCALE),
            advAlloc.allocationMethod,
            advAlloc.status,
            advAlloc.createdAt,
            advAlloc.createdBy,
            JSON.stringify(advAlloc)
          );

          enqueueOutboxTx(database, actor, {
            entityType: 'PARTY_ADVANCE',
            entityId: advTx.id,
            action: 'CREATE',
            payload: advTx,
            priority: 4,
            dependsOn: [invoice.id],
            idempotencyKey: `${tenantId}_PARTY_ADVANCE_${advTx.id}_CREATE`,
            branchId,
            nowIso,
          });
          enqueueOutboxTx(database, actor, {
            entityType: 'PAYMENT_ALLOCATION',
            entityId: advAlloc.id,
            action: 'CREATE',
            payload: advAlloc,
            priority: 4,
            dependsOn: [invoice.id, advTx.id],
            idempotencyKey: `${tenantId}_PAYMENT_ALLOCATION_${advAlloc.id}_CREATE`,
            branchId,
            nowIso,
          });
          enqueueOutboxTx(database, actor, {
            entityType: 'JOURNAL_ENTRY',
            entityId: advanceJournalEntry.id,
            action: 'CREATE',
            payload: advanceJournalEntry,
            priority: 4,
            dependsOn: [invoice.id],
            idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${advanceJournalEntry.id}_CREATE`,
            branchId,
            nowIso,
          });
        }

        invoice.branchId = branchId;
        invoice.journalEntryId = journalEntry.id;
        invoice.isPosted = true;
        invoice.status = 'POSTED';
        invoice.type = invoice.type || 'SALE';
        invoice.date = invoiceDate;
        invoice.advanceAppliedAmount = unitsToNumber(applyAdvanceUnits, MONEY_SCALE);
        invoice.paidAmount = unitsToNumber(cashPaidUnits + applyAdvanceUnits, MONEY_SCALE);

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
          `فاتورة ${persistedInvoice.invoiceNumber} بقيمة ${persistedInvoice.total} ${currencySymbol} وقيد ${journalEntry.entryNumber}${applyAdvanceUnits > 0n ? ` (تسوية رصيد مقدم: ${unitsToNumber(applyAdvanceUnits, MONEY_SCALE)})` : ''}`,
          nowIso
        );

        database.exec('COMMIT');
        return { success: true, invoice: persistedInvoice, journalEntry, advanceJournalEntry };
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
      assertActivityAccess(actor, rawInvoice.activityId, 'إصدار فاتورة مشتريات');
      const itemsWithBatches = Array.isArray(params.itemsWithBatches) ? params.itemsWithBatches : [];
      const clientRequestId = params.clientRequestId ? String(params.clientRequestId).trim() : '';
      const applyAdvanceUnits = parseScaledInt(params.applyAdvanceAmount ?? 0, MONEY_SCALE, 'applyAdvanceAmount');
      if (applyAdvanceUnits < 0n) {
        throw new FinancialValidationError('مبلغ التسوية من رصيد سلفة المورد لا يجوز أن يكون سالباً.');
      }
      if (applyAdvanceUnits > 0n) {
        assertPermission(actor, 'party:advance:use', 'تسوية سلفة مورد على فاتورة المشتريات');
      }

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
          `SELECT ${INVOICE_SELECT_COLUMNS} FROM invoices WHERE tenant_id = ? AND id = ?`
        ).get(tenantId, invoice.id);
        if (existingInvRow) {
          const existingInv = hydrateInvoiceRow(database, tenantId, existingInvRow);
          if (existingInv.journalEntryId) {
            const existingJeRow = database.prepare(
              'SELECT tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json FROM journal_entries WHERE tenant_id = ? AND id = ?'
            ).get(tenantId, existingInv.journalEntryId);
            const advJeRow = database.prepare(
              "SELECT tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json FROM journal_entries WHERE tenant_id = ? AND reference_type = 'ADVANCE_SETTLEMENT' AND reference_id = ?"
            ).get(tenantId, existingInv.id);
            if (existingJeRow) {
              const existingJe = hydrateJournalEntryRow(database, tenantId, existingJeRow);
              const advanceJournalEntry = advJeRow ? hydrateJournalEntryRow(database, tenantId, advJeRow) : undefined;
              database.exec('COMMIT');
              return { success: true, invoice: existingInv, journalEntry: existingJe, advanceJournalEntry };
            }
          }
        }
        if (clientRequestId) {
          const dupOutbox = database.prepare(
            'SELECT entity_id FROM outbox_queue WHERE tenant_id = ? AND idempotency_key = ?'
          ).get(tenantId, `REQ_${tenantId}_${clientRequestId}`);
          if (dupOutbox) {
            const dupInvRow = database.prepare(
              `SELECT ${INVOICE_SELECT_COLUMNS} FROM invoices WHERE tenant_id = ? AND id = ?`
            ).get(tenantId, dupOutbox.entity_id);
            if (dupInvRow) {
              const dupInv = hydrateInvoiceRow(database, tenantId, dupInvRow);
              if (dupInv.journalEntryId) {
                const dupJeRow = database.prepare(
                  'SELECT tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json FROM journal_entries WHERE tenant_id = ? AND id = ?'
                ).get(tenantId, dupInv.journalEntryId);
                const advJeRow = database.prepare(
                  "SELECT tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json FROM journal_entries WHERE tenant_id = ? AND reference_type = 'ADVANCE_SETTLEMENT' AND reference_id = ?"
                ).get(tenantId, dupInv.id);
                if (dupJeRow) {
                  const dupJe = hydrateJournalEntryRow(database, tenantId, dupJeRow);
                  const advanceJournalEntry = advJeRow ? hydrateJournalEntryRow(database, tenantId, advJeRow) : undefined;
                  database.exec('COMMIT');
                  return { success: true, invoice: dupInv, journalEntry: dupJe, advanceJournalEntry };
                }
              }
            }
          }
        }

        // 2. Validate purchase lines, pair with invoice.items, & resolve authoritative unit conversions
        if (itemsWithBatches.length === 0) {
          throw new FinancialValidationError('فاتورة المشتريات يجب أن تحتوي على صنف واحد على الأقل.');
        }

        for (const invItem of invoice.items) {
          invItem.id = String(invItem.id || '').trim() || randomUUID();
        }
        const invoiceItemsById = new Map(invoice.items.map((it) => [it.id, it]));
        const matchedInvItemIds = new Set();

        let computedLinesUnits = 0n;
        const parsedPurchaseLines = [];
        for (let idx = 0; idx < itemsWithBatches.length; idx += 1) {
          const item = itemsWithBatches[idx];
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

          let pairedInvItem;
          if (invoice.items.length > 0) {
            if (item.invoiceItemId) {
              pairedInvItem = invoiceItemsById.get(String(item.invoiceItemId));
              if (!pairedInvItem || matchedInvItemIds.has(pairedInvItem.id)) {
                throw new FinancialValidationError('معرف سطر الفاتورة في بنود الشراء غير صالح أو مكرر.');
              }
            } else if (invoice.items.length === itemsWithBatches.length && !matchedInvItemIds.has(invoice.items[idx].id)) {
              pairedInvItem = invoice.items[idx];
            } else {
              pairedInvItem = invoice.items.find(
                (it) =>
                  !matchedInvItemIds.has(it.id) &&
                  it.productId === item.productId &&
                  Math.abs(Number(it.quantity) - Number(item.quantity)) <= 0.0001
              );
            }
            if (!pairedInvItem) {
              throw new FinancialValidationError('بنود فاتورة المشتريات لا تطابق بنود التوريد.');
            }
            if (pairedInvItem.productId !== item.productId || Math.abs(Number(pairedInvItem.quantity) - Number(item.quantity)) > 0.0001) {
              throw new FinancialValidationError('بيانات الصنف أو الكمية في بنود التوريد لا تطابق بنود فاتورة المشتريات.');
            }
            if (item.unitId && pairedInvItem.unitId && String(item.unitId).trim() !== String(pairedInvItem.unitId).trim()) {
              throw new FinancialValidationError('وحدة بند التوريد لا تطابق وحدة السطر في فاتورة المشتريات.');
            }
            matchedInvItemIds.add(pairedInvItem.id);
          }

          parsedPurchaseLines.push({
            ...item,
            _pairedInvItem: pairedInvItem,
            _requestedUnitId: item.unitId ?? pairedInvItem?.unitId,
            _qtyUnits: qtyUnits,
            _costUnits: costUnits,
          });
        }
        if (invoice.items.length > 0 && matchedInvItemIds.size !== invoice.items.length) {
          throw new FinancialValidationError('بنود فاتورة المشتريات لا تطابق بنود التوريد المخزني.');
        }

        const subtotalUnits = parseScaledInt(invoice.subtotal ?? 0, MONEY_SCALE, 'purchase.subtotal');
        const discountUnits = parseScaledInt(invoice.discount ?? 0, MONEY_SCALE, 'purchase.discount');
        const taxUnits = parseScaledInt(invoice.tax ?? 0, MONEY_SCALE, 'purchase.tax');
        const totalUnits = parseScaledInt(invoice.total ?? 0, MONEY_SCALE, 'purchase.total');
        const cashPaidUnits = parseScaledInt(invoice.paidAmount ?? 0, MONEY_SCALE, 'purchase.paidAmount');

        if (subtotalUnits < 0n || discountUnits < 0n || taxUnits < 0n || totalUnits < 0n || cashPaidUnits < 0n) {
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
        const totalSettledUnits = cashPaidUnits + applyAdvanceUnits;
        if (totalSettledUnits > totalUnits + 1n) {
          throw new FinancialValidationError(
            `مجموع المدفوع نقداً والمخصوم من سلفة المورد (${unitsToNumber(totalSettledUnits, MONEY_SCALE)}) لا يمكن أن يتجاوز إجمالي فاتورة المشتريات (${unitsToNumber(totalUnits, MONEY_SCALE)}).`
          );
        }

        let targetCashBox;
        if (cashPaidUnits > 0n) {
          if (!invoice.cashBoxId || !String(invoice.cashBoxId).trim()) {
            throw new FinancialValidationError('يجب تحديد صندوق نقدي صالح لسداد فاتورة المشتريات.');
          }
          targetCashBox = getCashBoxRowTx(database, tenantId, invoice.cashBoxId);
          assertCashBoxBranchAccessTx(actor, targetCashBox, branchId);
          if (targetCashBox._balanceUnits < cashPaidUnits) {
            throw new FinancialValidationError(
              `رصيد الصندوق (${targetCashBox.nameAr}: ${targetCashBox.balance}) غير كافٍ لسداد مبلغ ${unitsToNumber(cashPaidUnits, MONEY_SCALE)}.`
            );
          }
        }

        if (applyAdvanceUnits > 0n && !invoice.partyId) {
          throw new FinancialValidationError('استخدام رصيد سلفة المورد يتطلب اختيار مورد مسجل.');
        }
        let supplierRow = null;
        if (invoice.partyId) {
          supplierRow = database.prepare(
            'SELECT id, party_type, balance_decimal, advance_balance_decimal, data_json FROM parties WHERE tenant_id = ? AND id = ?'
          ).get(tenantId, invoice.partyId);
          if (!supplierRow) {
            throw new FinancialValidationError('المورد المحدد غير موجود في قاعدة البيانات.');
          }
        }
        if (applyAdvanceUnits > 0n) {
          if (!supplierRow || supplierRow.party_type !== 'SUPPLIER') {
            throw new FinancialValidationError('تسوية سلف الموردين متاحة للموردين المسجلين فقط.');
          }
          const availAdvUnits = parseScaledInt(supplierRow.advance_balance_decimal ?? 0, MONEY_SCALE, 'supplier.advanceBalance');
          if (availAdvUnits < applyAdvanceUnits) {
            throw new FinancialValidationError(
              `رصيد سلفة المورد المتاح (${unitsToNumber(availAdvUnits, MONEY_SCALE)}) غير كافٍ لخصم ${unitsToNumber(applyAdvanceUnits, MONEY_SCALE)}.`
            );
          }
        }

        // 3. Apply inventory increases in base units, batch upserts, landed base cost & weighted-avg purchasePrice
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

          const resolvedUnit = resolveInvoiceItemUnitTx(database, tenantId, product, item._requestedUnitId);
          let conversion;
          try {
            conversion = resolveUnitConversionToBase({
              quantity: unitsToNumber(item._qtyUnits, QTY_SCALE),
              numerator: resolvedUnit.conversionNumeratorSnapshot,
              denominator: resolvedUnit.conversionDenominatorSnapshot,
              unitName: resolvedUnit.unitNameSnapshot,
            });
          } catch (err) {
            throw new FinancialValidationError(err instanceof Error ? err.message : 'تعذر تحويل وحدة الصنف.');
          }

          const baseCostRes = computePurchaseBaseUnitCost({
            enteredQuantity: conversion.enteredQuantity,
            enteredCostPrice: unitsToNumber(item._costUnits, QTY_SCALE),
            baseQuantity: conversion.baseQuantity,
            invoiceSubtotal: unitsToNumber(subtotalUnits, MONEY_SCALE),
            invoiceTotal: unitsToNumber(totalUnits, MONEY_SCALE),
          });
          const landedCostUnits = baseCostRes.baseUnitCostUnits;
          if (landedCostUnits < 0n) {
            throw new FinancialValidationError(`تكلفة التوريد النهائية للصنف (${product.nameAr}) غير صالحة.`);
          }

          if (item._pairedInvItem) {
            item._pairedInvItem.unitId = resolvedUnit.unitId;
            item._pairedInvItem.unit = resolvedUnit.unit;
            item._pairedInvItem.unitNameSnapshot = resolvedUnit.unitNameSnapshot;
            item._pairedInvItem.baseUnitNameSnapshot = resolvedUnit.baseUnitNameSnapshot;
            item._pairedInvItem.conversionNumeratorSnapshot = resolvedUnit.conversionNumeratorSnapshot;
            item._pairedInvItem.conversionDenominatorSnapshot = resolvedUnit.conversionDenominatorSnapshot;
            item._pairedInvItem.baseQuantity = conversion.baseQuantity;
          }

          const addedBaseQtyUnits = conversion.baseQtyUnits;
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
              const nextBatchQty = existingBatch._qtyUnits + addedBaseQtyUnits;
              const prevValue = existingBatch._qtyUnits * existingBatch._costUnits;
              const addedValue = addedBaseQtyUnits * landedCostUnits;
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
                quantity: unitsToNumber(addedBaseQtyUnits, QTY_SCALE),
                costPrice: unitsToNumber(landedCostUnits, QTY_SCALE),
                _qtyUnits: addedBaseQtyUnits,
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
            const nextQtyUnits = prevQtyUnits + addedBaseQtyUnits;
            const prevValue = prevQtyUnits * prevCostUnits;
            const addedValue = addedBaseQtyUnits * landedCostUnits;
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
        const invAcc = updateAccountBalanceByLineTx(database, tenantId, inventoryCode, totalUnits, 0n);

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

        if (cashPaidUnits > 0n && targetCashBox) {
          const updatedBox = updateCashBoxBalanceTx(database, tenantId, targetCashBox.id, -cashPaidUnits, true);
          const boxAcc = updateAccountBalanceByLineTx(database, tenantId, targetCashBox.accountCode, 0n, cashPaidUnits);
          journalLines.push({
            id: randomUUID(),
            accountCode: targetCashBox.accountCode,
            accountName: boxAcc?.nameAr || updatedBox.nameAr,
            debit: 0,
            credit: unitsToNumber(cashPaidUnits, MONEY_SCALE),
            costCenterId: invoice.activityId,
            memo: `سداد نقدي فاتورة مشتريات ${invoice.invoiceNumber}`,
          });
        }

        const grossCreditUnits = totalUnits - cashPaidUnits;
        if (grossCreditUnits > 0n) {
          const apAcc = updateAccountBalanceByLineTx(database, tenantId, SPECIAL_ACCOUNTS.SUPPLIERS_AP, 0n, grossCreditUnits);
          if (invoice.partyId) {
            updatePartyBalancesTx(database, tenantId, invoice.partyId, -grossCreditUnits, 0n);
          }
          journalLines.push({
            id: randomUUID(),
            accountCode: SPECIAL_ACCOUNTS.SUPPLIERS_AP,
            accountName: `${apAcc?.nameAr || 'الموردون والدائنون'} - ${invoice.partyName || ''}`.trim(),
            debit: 0,
            credit: unitsToNumber(grossCreditUnits, MONEY_SCALE),
            costCenterId: invoice.activityId,
            memo: `مستحق آجل فاتورة مشتريات ${invoice.invoiceNumber}`,
          });
        }

        const invoiceDate = invoice.date || todayStr;
        const entryNumber = allocateSequenceTx(database, tenantId, 'JV', activeBranch.code, terminalCode, nowIso);
        const { persisted: journalEntry } = insertJournalEntryTx(database, tenantId, {
          id: randomUUID(),
          entryNumber,
          date: invoiceDate,
          description: `قيد مشتريات آلي للفاتورة ${invoice.invoiceNumber} - ${invoice.partyName || ''}`.trim(),
          costCenterId: invoice.activityId,
          branchId,
          lines: journalLines,
          status: 'POSTED',
          referenceType: 'INVOICE',
          referenceId: invoice.id,
          isAutoGenerated: true,
        });

        // 4b. Standalone Supplier Advance Settlement Entry (Dr 2101 / Cr 1105) if applying supplier advance
        let advanceJournalEntry;
        if (applyAdvanceUnits > 0n && supplierRow) {
          const advNum = unitsToNumber(applyAdvanceUnits, MONEY_SCALE);
          const supAdvAcc = ensureCanonicalAccountTx(database, tenantId, SPECIAL_ACCOUNTS.SUPPLIER_ADVANCES);
          const apAcc = ensureCanonicalAccountTx(database, tenantId, SPECIAL_ACCOUNTS.SUPPLIERS_AP);
          if (!supAdvAcc || !apAcc) {
            throw new FinancialValidationError('حساب سلف الموردين (1105) أو الموردون (2101) غير معرف.');
          }
          const supplierName = parseRowJson(supplierRow).nameAr || invoice.partyName || '';
          const advEntryNumber = allocateSequenceTx(database, tenantId, 'JV', activeBranch.code, terminalCode, nowIso);
          const advJeRes = insertJournalEntryTx(database, tenantId, {
            id: randomUUID(),
            entryNumber: advEntryNumber,
            date: invoiceDate,
            description: `تسوية سلفة مورد للمورد ${supplierName} على فاتورة ${invoice.invoiceNumber}`,
            costCenterId: invoice.activityId,
            branchId,
            lines: [
              {
                id: randomUUID(),
                accountCode: SPECIAL_ACCOUNTS.SUPPLIERS_AP,
                accountName: apAcc.nameAr,
                debit: advNum,
                credit: 0,
                costCenterId: invoice.activityId,
                memo: `تخفيض ذمة المورد ${supplierName} لفاتورة ${invoice.invoiceNumber}`,
              },
              {
                id: randomUUID(),
                accountCode: SPECIAL_ACCOUNTS.SUPPLIER_ADVANCES,
                accountName: supAdvAcc.nameAr,
                debit: 0,
                credit: advNum,
                costCenterId: invoice.activityId,
                memo: `استخدام سلفة مورد لفاتورة ${invoice.invoiceNumber}`,
              },
            ],
            status: 'POSTED',
            referenceType: 'ADVANCE_SETTLEMENT',
            referenceId: invoice.id,
            isAutoGenerated: true,
          });
          advanceJournalEntry = advJeRes.persisted;

          updateAccountBalanceByLineTx(database, tenantId, SPECIAL_ACCOUNTS.SUPPLIERS_AP, applyAdvanceUnits, 0n);
          updateAccountBalanceByLineTx(database, tenantId, SPECIAL_ACCOUNTS.SUPPLIER_ADVANCES, 0n, applyAdvanceUnits);
          const updatedParty = updatePartyBalancesTx(database, tenantId, supplierRow.id, applyAdvanceUnits, -applyAdvanceUnits);

          const advTx = {
            id: randomUUID(),
            tenantId,
            branchId,
            partyId: supplierRow.id,
            partyType: 'SUPPLIER',
            type: 'APPLY_TO_INVOICE',
            amount: -advNum,
            balanceAfter: updatedParty.advanceBalance,
            invoiceId: invoice.id,
            journalEntryId: advanceJournalEntry.id,
            date: invoiceDate,
            description: `تسوية سلفة مورد على الفاتورة ${invoice.invoiceNumber}`,
            createdBy: actor.id,
            createdAt: nowIso,
          };
          database.prepare(
            `INSERT INTO party_advance_transactions
              (tenant_id,id,branch_id,party_id,party_type,tx_type,amount_decimal,balance_after_decimal,voucher_id,invoice_id,journal_entry_id,tx_date,created_at,data_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).run(
            tenantId,
            advTx.id,
            branchId,
            advTx.partyId,
            advTx.partyType,
            advTx.type,
            formatScaledInt(-applyAdvanceUnits, MONEY_SCALE),
            formatScaledInt(parseScaledInt(advTx.balanceAfter, MONEY_SCALE, 'advBalAfter'), MONEY_SCALE),
            null,
            advTx.invoiceId,
            advTx.journalEntryId,
            advTx.date,
            advTx.createdAt,
            JSON.stringify(advTx)
          );

          const advAlloc = {
            id: randomUUID(),
            tenantId,
            branchId,
            advanceTransactionId: advTx.id,
            partyId: supplierRow.id,
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            invoiceDate,
            allocatedAmount: advNum,
            allocationMethod: 'ADVANCE_SETTLEMENT',
            status: 'ACTIVE',
            createdAt: nowIso,
            createdBy: actor.id,
          };
          database.prepare(
            `INSERT INTO payment_allocations
              (tenant_id,id,branch_id,voucher_id,advance_transaction_id,party_id,invoice_id,allocated_decimal,allocation_method,status,created_at,created_by,data_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).run(
            tenantId,
            advAlloc.id,
            branchId,
            null,
            advTx.id,
            advAlloc.partyId,
            advAlloc.invoiceId,
            formatScaledInt(applyAdvanceUnits, MONEY_SCALE),
            advAlloc.allocationMethod,
            advAlloc.status,
            advAlloc.createdAt,
            advAlloc.createdBy,
            JSON.stringify(advAlloc)
          );

          enqueueOutboxTx(database, actor, {
            entityType: 'PARTY_ADVANCE',
            entityId: advTx.id,
            action: 'CREATE',
            payload: advTx,
            priority: 4,
            dependsOn: [invoice.id],
            idempotencyKey: `${tenantId}_PARTY_ADVANCE_${advTx.id}_CREATE`,
            branchId,
            nowIso,
          });
          enqueueOutboxTx(database, actor, {
            entityType: 'PAYMENT_ALLOCATION',
            entityId: advAlloc.id,
            action: 'CREATE',
            payload: advAlloc,
            priority: 4,
            dependsOn: [invoice.id, advTx.id],
            idempotencyKey: `${tenantId}_PAYMENT_ALLOCATION_${advAlloc.id}_CREATE`,
            branchId,
            nowIso,
          });
          enqueueOutboxTx(database, actor, {
            entityType: 'JOURNAL_ENTRY',
            entityId: advanceJournalEntry.id,
            action: 'CREATE',
            payload: advanceJournalEntry,
            priority: 4,
            dependsOn: [invoice.id],
            idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${advanceJournalEntry.id}_CREATE`,
            branchId,
            nowIso,
          });
        }

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
        invoice.date = invoiceDate;
        invoice.advanceAppliedAmount = unitsToNumber(applyAdvanceUnits, MONEY_SCALE);
        invoice.paidAmount = unitsToNumber(cashPaidUnits + applyAdvanceUnits, MONEY_SCALE);

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
          `فاتورة ${persistedInvoice.invoiceNumber} بقيمة ${persistedInvoice.total} ${currencySymbol} وقيد ${journalEntry.entryNumber}${applyAdvanceUnits > 0n ? ` (تسوية سلفة مورد: ${unitsToNumber(applyAdvanceUnits, MONEY_SCALE)})` : ''}`,
          nowIso,
          {
            entityType: 'INVOICE',
            entityId: persistedInvoice.id,
            newValue: {
              total: persistedInvoice.total,
              paidAmount: persistedInvoice.paidAmount,
              advanceAppliedAmount: persistedInvoice.advanceAppliedAmount,
            },
            result: 'SUCCESS',
          }
        );

        database.exec('COMMIT');
        return { success: true, invoice: persistedInvoice, journalEntry, advanceJournalEntry };
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    createSalesReturnAtomic(actor, params) {
      if (!params || typeof params !== 'object' || !params.originalInvoiceId) {
        throw new FinancialValidationError('معرف فاتورة المبيعات الأصلية مطلوب.');
      }
      assertPermission(actor, 'pos:return', 'إصدار مرتجع مبيعات');
      const cleanReason = String(params.returnReason || '').trim();
      if (!cleanReason) {
        throw new FinancialValidationError('سبب مرتجع المبيعات مطلوب لتوثيق القيد وسجل التدقيق.');
      }
      if (!Array.isArray(params.items) || params.items.length === 0) {
        throw new FinancialValidationError('يجب تحديد صنف واحد على الأقل لإتمام مرتجع المبيعات.');
      }

      const tenantId = actor.tenantId;
      const terminalCode = getTerminalCodeValue(database, tenantId);
      const currencySymbol = getCurrencySymbol(database, tenantId);
      const nowIso = new Date().toISOString();
      const todayStr = nowIso.split('T')[0];
      const clientRequestId = params.clientRequestId ? String(params.clientRequestId).trim() : '';

      database.exec('BEGIN IMMEDIATE');
      try {
        if (clientRequestId) {
          const dupOutbox = database.prepare(
            'SELECT entity_id FROM outbox_queue WHERE tenant_id = ? AND idempotency_key = ?'
          ).get(tenantId, `REQ_${tenantId}_${clientRequestId}`);
          if (dupOutbox) {
            const dupInvRow = database.prepare(
              `SELECT ${INVOICE_SELECT_COLUMNS} FROM invoices WHERE tenant_id = ? AND id = ?`
            ).get(tenantId, dupOutbox.entity_id);
            if (dupInvRow) {
              const dupInv = hydrateInvoiceRow(database, tenantId, dupInvRow);
              if (dupInv.journalEntryId) {
                const dupJeRow = database.prepare(
                  'SELECT tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json FROM journal_entries WHERE tenant_id = ? AND id = ?'
                ).get(tenantId, dupInv.journalEntryId);
                if (dupJeRow) {
                  database.exec('COMMIT');
                  return { success: true, invoice: dupInv, journalEntry: hydrateJournalEntryRow(database, tenantId, dupJeRow) };
                }
              }
            }
          }
        }

        const origRow = database.prepare(
          `SELECT ${INVOICE_SELECT_COLUMNS} FROM invoices WHERE tenant_id = ? AND id = ?`
        ).get(tenantId, String(params.originalInvoiceId));
        if (!origRow) {
          throw new FinancialValidationError('فاتورة المبيعات الأصلية غير موجودة.');
        }
        const orig = hydrateInvoiceRow(database, tenantId, origRow);
        assertActivityAccess(actor, orig.activityId, 'إصدار مرتجع مبيعات');
        if (orig.type !== 'SALE') {
          throw new FinancialValidationError('يمكن إصدار مرتجع مبيعات لفواتير المبيعات (SALE) فقط.');
        }
        if (orig.status === 'REVERSED') {
          throw new FinancialValidationError('لا يمكن عمل مرتجع على فاتورة مبيعات معكوسة.');
        }

        const targetBranchId = String(orig.branchId || '').trim();
        assertBranchAccess(actor, targetBranchId);
        const branchRow = database.prepare(
          'SELECT id, code, name_ar, active FROM branches WHERE tenant_id = ? AND id = ?'
        ).get(tenantId, targetBranchId);
        if (!branchRow) {
          throw new FinancialValidationError('فرع الفاتورة الأصلية غير موجود.');
        }

        const allInvRows = database.prepare(
          `SELECT ${INVOICE_SELECT_COLUMNS} FROM invoices WHERE tenant_id = ? AND invoice_type = 'RETURN_SALE'`
        ).all(tenantId);
        const priorReturns = allInvRows
          .map((r) => hydrateInvoiceRow(database, tenantId, r))
          .filter((i) => i.originalInvoiceId === orig.id && i.status !== 'REVERSED');

        const returnedByLineId = new Map();
        const legacyReturnedByProduct = new Map();
        const legacyReturnedByProductBatch = new Map();
        const returnedByDeductionLineKey = new Map();
        const returnedByDeductionKey = new Map();
        for (const r of priorReturns) {
          for (const it of r.items || []) {
            const qU = parseScaledInt(it.quantity, QTY_SCALE, 'priorRetItem.qty');
            if (it.originalInvoiceItemId) {
              returnedByLineId.set(it.originalInvoiceItemId, (returnedByLineId.get(it.originalInvoiceItemId) || 0n) + qU);
            } else {
              legacyReturnedByProduct.set(it.productId, (legacyReturnedByProduct.get(it.productId) || 0n) + qU);
              if (it.batchNumber) {
                const itemKey = `${it.productId}::${it.batchNumber}`;
                legacyReturnedByProductBatch.set(itemKey, (legacyReturnedByProductBatch.get(itemKey) || 0n) + qU);
              }
            }
          }
          for (const ded of r.stockDeductionsRecorded || []) {
            const dU = parseScaledInt(ded.quantity, QTY_SCALE, 'priorRetDed.qty');
            const dk = `${ded.productId}::${ded.batchNumber || ''}`;
            returnedByDeductionKey.set(dk, (returnedByDeductionKey.get(dk) || 0n) + dU);
            if (ded.invoiceItemId) {
              const dlk = `${ded.invoiceItemId}::${ded.batchNumber || ''}`;
              returnedByDeductionLineKey.set(dlk, (returnedByDeductionLineKey.get(dlk) || 0n) + dU);
            }
          }
        }

        const origSubtotalUnits = parseScaledInt(orig.subtotal ?? 0, MONEY_SCALE, 'orig.subtotal');
        const origTotalUnits = parseScaledInt(orig.total ?? 0, MONEY_SCALE, 'orig.total');

        const returnItems = [];
        const restoredDeductions = [];
        let returnTotalUnits = 0n;
        let restoredCogsRawUnits = 0n;

        for (const reqItem of params.items) {
          if (!reqItem || !reqItem.productId) {
            throw new FinancialValidationError('معرف الصنف المرتجع مطلوب.');
          }
          const reqQtyUnits = parseScaledInt(reqItem.quantity, QTY_SCALE, 'retItem.quantity');
          if (reqQtyUnits <= 0n) {
            throw new FinancialValidationError('كمية الصنف المرتجع يجب أن تكون أكبر من الصفر.');
          }

          const origLine = resolveOriginalInvoiceLineForReturn(orig.items || [], reqItem, 'الفاتورة الأصلية');
          const soldQtyUnits = parseScaledInt(origLine.quantity, QTY_SCALE, 'origLine.qty');
          const batchKey = `${reqItem.productId}::${reqItem.batchNumber || ''}`;
          const sameProductLines = (orig.items || []).filter(
            (it) => it.productId === reqItem.productId && (!reqItem.batchNumber || it.batchNumber === reqItem.batchNumber)
          );
          const legacyAlreadyRet = sameProductLines.length === 1
            ? (reqItem.batchNumber
                ? (legacyReturnedByProductBatch.get(batchKey) || 0n)
                : (legacyReturnedByProduct.get(reqItem.productId) || 0n))
            : 0n;
          const alreadyRetUnits = (returnedByLineId.get(origLine.id) || 0n) + legacyAlreadyRet;
          const remainingRetUnits = soldQtyUnits - alreadyRetUnits;
          if (reqQtyUnits > remainingRetUnits + 1n) {
            throw new FinancialValidationError(
              `الكمية المطلوب إرجاعها للصنف (${origLine.productName}) تتجاوز الكمية المتاحة للإرجاع (${unitsToNumber(remainingRetUnits, QTY_SCALE)}).`
            );
          }
          returnedByLineId.set(origLine.id, (returnedByLineId.get(origLine.id) || 0n) + reqQtyUnits);

          const hasUnitSnapshot =
            origLine.unitId !== undefined ||
            origLine.conversionNumeratorSnapshot !== undefined ||
            origLine.baseQuantity !== undefined;
          const snapNum = origLine.conversionNumeratorSnapshot ?? 1;
          const snapDen = origLine.conversionDenominatorSnapshot ?? 1;
          let returnConversion;
          try {
            returnConversion = resolveUnitConversionToBase({
              quantity: unitsToNumber(reqQtyUnits, QTY_SCALE),
              numerator: snapNum,
              denominator: snapDen,
              unitName: origLine.unitNameSnapshot || origLine.unit || 'الوحدة',
            });
          } catch (err) {
            throw new FinancialValidationError(err instanceof Error ? err.message : 'تعذر تحويل وحدة المرتجع.');
          }
          const returnBaseQtyUnits = returnConversion.baseQtyUnits;

          const origLineSumUnits = parseScaledInt(origLine.total ?? 0, MONEY_SCALE, 'origLine.total');
          const lineNetTotalUnits = origSubtotalUnits > 0n
            ? divBigIntHalfUp(reqQtyUnits * origLineSumUnits * origTotalUnits, soldQtyUnits * origSubtotalUnits)
            : divBigIntHalfUp(reqQtyUnits * origLineSumUnits, soldQtyUnits);
          returnTotalUnits += lineNetTotalUnits;

          const product = loadProductWithBatches(database, tenantId, reqItem.productId);
          if (!product) {
            throw new FinancialValidationError(`الصنف (${reqItem.productId}) غير موجود في المستودع.`);
          }

          const lineDeductions = (orig.stockDeductionsRecorded || []).filter(
            (d) =>
              d.invoiceItemId === origLine.id &&
              (!reqItem.batchNumber || d.batchNumber === reqItem.batchNumber)
          );
          const matchingDeductions = lineDeductions.length > 0
            ? lineDeductions
            : (orig.stockDeductionsRecorded || []).filter(
                (d) =>
                  d.productId === reqItem.productId &&
                  (!reqItem.batchNumber || d.batchNumber === reqItem.batchNumber)
              );

          const batches = Array.isArray(product.batches)
            ? product.batches.map((b) => ({
                ...b,
                _qtyUnits: parseScaledInt(b.quantity, QTY_SCALE, 'batch.quantity'),
                _costUnits: parseScaledInt(b.costPrice, QTY_SCALE, 'batch.costPrice'),
              }))
            : [];
          let productStockUnits = parseScaledInt(product.currentStock ?? 0, QTY_SCALE, 'product.currentStock');
          let productCostUnits = parseScaledInt(product.purchasePrice ?? 0, QTY_SCALE, 'product.purchasePrice');

          const returnItemId = randomUUID();
          let qtyLeftUnits = returnBaseQtyUnits;
          if (matchingDeductions.length > 0) {
            for (const ded of matchingDeductions) {
              if (qtyLeftUnits <= 0n) break;
              const useLineTracking = Boolean(ded.invoiceItemId);
              const dlk = `${ded.invoiceItemId || ''}::${ded.batchNumber || ''}`;
              const dk = `${ded.productId}::${ded.batchNumber || ''}`;
              const usedBeforeUnits = useLineTracking
                ? (returnedByDeductionLineKey.get(dlk) || 0n)
                : (returnedByDeductionKey.get(dk) || 0n);
              const dedQtyUnits = parseScaledInt(ded.quantity, QTY_SCALE, 'ded.quantity');
              const availSliceUnits = dedQtyUnits > usedBeforeUnits ? dedQtyUnits - usedBeforeUnits : 0n;
              if (availSliceUnits <= 0n) continue;
              const sliceQtyUnits = qtyLeftUnits < availSliceUnits ? qtyLeftUnits : availSliceUnits;
              if (useLineTracking) {
                returnedByDeductionLineKey.set(dlk, usedBeforeUnits + sliceQtyUnits);
              }
              returnedByDeductionKey.set(dk, (returnedByDeductionKey.get(dk) || 0n) + sliceQtyUnits);
              qtyLeftUnits -= sliceQtyUnits;

              const sliceUnitCostUnits = ded.unitCost !== undefined && Number.isFinite(Number(ded.unitCost))
                ? parseScaledInt(ded.unitCost, QTY_SCALE, 'ded.unitCost')
                : productCostUnits;
              restoredCogsRawUnits += mulScaledHalfUp(sliceQtyUnits, sliceUnitCostUnits, QTY_SCALE, QTY_SCALE, TOTALS_SCALE);
              restoredDeductions.push({
                invoiceItemId: returnItemId,
                productId: product.id,
                batchNumber: ded.batchNumber,
                expiryDate: ded.expiryDate,
                quantity: unitsToNumber(sliceQtyUnits, QTY_SCALE),
                unitCost: unitsToNumber(sliceUnitCostUnits, QTY_SCALE),
              });

              if (ded.batchNumber) {
                const targetBatch = batches.find((b) => b.batchNumber === ded.batchNumber);
                if (targetBatch) {
                  const nextQ = targetBatch._qtyUnits + sliceQtyUnits;
                  targetBatch._costUnits = nextQ > 0n
                    ? divBigIntHalfUp(targetBatch._qtyUnits * targetBatch._costUnits + sliceQtyUnits * sliceUnitCostUnits, nextQ)
                    : sliceUnitCostUnits;
                  targetBatch._qtyUnits = nextQ;
                } else {
                  batches.push({
                    id: randomUUID(),
                    productId: product.id,
                    batchNumber: ded.batchNumber,
                    expiryDate: ded.expiryDate || todayStr,
                    quantity: unitsToNumber(sliceQtyUnits, QTY_SCALE),
                    costPrice: unitsToNumber(sliceUnitCostUnits, QTY_SCALE),
                    _qtyUnits: sliceQtyUnits,
                    _costUnits: sliceUnitCostUnits,
                  });
                }
                const totalQ = batches.reduce((s, b) => s + b._qtyUnits, 0n);
                const totalV = batches.reduce((s, b) => s + b._qtyUnits * b._costUnits, 0n);
                productStockUnits = totalQ;
                productCostUnits = totalQ > 0n ? divBigIntHalfUp(totalV, totalQ) : sliceUnitCostUnits;
              } else {
                const nextQ = productStockUnits + sliceQtyUnits;
                productCostUnits = nextQ > 0n
                  ? divBigIntHalfUp(productStockUnits * productCostUnits + sliceQtyUnits * sliceUnitCostUnits, nextQ)
                  : sliceUnitCostUnits;
                productStockUnits = nextQ;
              }
            }
          }

          if (qtyLeftUnits > 1n) {
            restoredCogsRawUnits += mulScaledHalfUp(qtyLeftUnits, productCostUnits, QTY_SCALE, QTY_SCALE, TOTALS_SCALE);
            restoredDeductions.push({
              invoiceItemId: returnItemId,
              productId: product.id,
              quantity: unitsToNumber(qtyLeftUnits, QTY_SCALE),
              unitCost: unitsToNumber(productCostUnits, QTY_SCALE),
            });
            productStockUnits += qtyLeftUnits;
          }

          if (batches.length > 0) {
            product.batches = batches.map(({ _qtyUnits, _costUnits, ...rest }) => ({
              ...rest,
              quantity: unitsToNumber(_qtyUnits, QTY_SCALE),
              costPrice: unitsToNumber(_costUnits, QTY_SCALE),
            }));
          }
          product.currentStock = unitsToNumber(productStockUnits, QTY_SCALE);
          product.purchasePrice = unitsToNumber(productCostUnits, QTY_SCALE);
          syncProductAndBatchesTx(database, tenantId, product);

          const lineUnitPriceUnits = divBigIntHalfUp(lineNetTotalUnits * QTY_SCALE, reqQtyUnits);
          returnItems.push({
            id: returnItemId,
            originalInvoiceItemId: origLine.id,
            productId: product.id,
            productName: origLine.productName || product.nameAr,
            productCode: origLine.productCode || product.code,
            batchNumber: reqItem.batchNumber || origLine.batchNumber,
            unit: origLine.unit || product.unit,
            ...(hasUnitSnapshot
              ? {
                  unitId: origLine.unitId ?? 'BASE',
                  unitNameSnapshot: origLine.unitNameSnapshot || origLine.unit || product.unit,
                  baseUnitNameSnapshot: origLine.baseUnitNameSnapshot || product.unit,
                  conversionNumeratorSnapshot: snapNum,
                  conversionDenominatorSnapshot: snapDen,
                  baseQuantity: returnConversion.baseQuantity,
                }
              : {}),
            quantity: unitsToNumber(reqQtyUnits, QTY_SCALE),
            unitPrice: unitsToNumber(lineUnitPriceUnits, MONEY_SCALE),
            discount: 0,
            total: unitsToNumber(lineNetTotalUnits, MONEY_SCALE),
          });
        }

        const returnTotalNum = unitsToNumber(returnTotalUnits, MONEY_SCALE);
        const restoredCogsUnits = divBigIntHalfUp(restoredCogsRawUnits * MONEY_SCALE, TOTALS_SCALE);
        const restoredCogsNum = unitsToNumber(restoredCogsUnits, MONEY_SCALE);

        const returnDate = params.date || todayStr;
        const customerRow = orig.partyId
          ? database.prepare(
              'SELECT id, party_type, balance_decimal, advance_balance_decimal, data_json FROM parties WHERE tenant_id = ? AND id = ?'
            ).get(tenantId, orig.partyId)
          : null;
        const origPaidUnits = parseScaledInt(orig.paidAmount ?? 0, MONEY_SCALE, 'orig.paidAmount');
        const origReturnedUnits = parseScaledInt(orig.returnedAmount ?? 0, MONEY_SCALE, 'orig.returnedAmount');
        const origOpenRemUnits = origTotalUnits > (origPaidUnits + origReturnedUnits)
          ? origTotalUnits - origPaidUnits - origReturnedUnits
          : 0n;
        const origSettledUnits = origTotalUnits - origOpenRemUnits;

        let arCreditedUnits = 0n;
        let cashRefundUnits = 0n;
        let advanceCreditedUnits = 0n;

        if (params.refundMethod === 'AR_OFFSET') {
          if (!customerRow || customerRow.party_type !== 'CUSTOMER') {
            throw new FinancialValidationError('تخفيض ذمة العميل متاح للعملاء المسجلين فقط.');
          }
          if (returnTotalUnits > origOpenRemUnits + 1n) {
            throw new FinancialValidationError(
              `مبلغ المرتجع (${returnTotalNum}) يتجاوز المتبقي المفتوح من الفاتورة (${unitsToNumber(origOpenRemUnits, MONEY_SCALE)})؛ استخدم التسوية التلقائية أو الرد النقدي/الرصيد المقدم.`
            );
          }
          arCreditedUnits = returnTotalUnits < origOpenRemUnits ? returnTotalUnits : origOpenRemUnits;
        } else if (params.refundMethod === 'CASH') {
          if (origOpenRemUnits > 0n && returnTotalUnits > origSettledUnits + 1n) {
            throw new FinancialValidationError(
              'الفاتورة تحتوي على ذمة آجلة غير مسددة؛ استخدم التسوية التلقائية لتخفيض الذمة أولاً قبل رد النقد.'
            );
          }
          cashRefundUnits = returnTotalUnits;
        } else if (params.refundMethod === 'ADVANCE') {
          if (!customerRow || customerRow.party_type !== 'CUSTOMER') {
            throw new FinancialValidationError('ترحيل قيمة المرتجع كرصيد مقدم متاح للعملاء المسجلين فقط.');
          }
          if (origOpenRemUnits > 0n && returnTotalUnits > origSettledUnits + 1n) {
            throw new FinancialValidationError(
              'الفاتورة تحتوي على ذمة آجلة غير مسددة؛ استخدم التسوية التلقائية لتخفيض الذمة أولاً.'
            );
          }
          advanceCreditedUnits = returnTotalUnits;
        } else {
          arCreditedUnits = customerRow
            ? (returnTotalUnits < origOpenRemUnits ? returnTotalUnits : origOpenRemUnits)
            : 0n;
          const excessUnits = returnTotalUnits - arCreditedUnits;
          if (excessUnits > 0n) {
            if (params.cashBoxId || !customerRow) {
              cashRefundUnits = excessUnits;
            } else if (orig.cashBoxId) {
              cashRefundUnits = excessUnits;
            } else {
              advanceCreditedUnits = excessUnits;
            }
          }
        }

        let targetCashBox;
        if (cashRefundUnits > 0n) {
          const reqBoxId = params.cashBoxId || orig.cashBoxId;
          targetCashBox = reqBoxId
            ? getCashBoxRowTx(database, tenantId, reqBoxId)
            : resolveBranchDefaultCashBoxTx(database, tenantId, targetBranchId);
          assertCashBoxBranchAccessTx(actor, targetCashBox, targetBranchId);
          if (targetCashBox._balanceUnits < cashRefundUnits) {
            throw new FinancialValidationError(
              `رصيد الصندوق (${targetCashBox.nameAr}: ${targetCashBox.balance}) غير كافٍ لرد مبلغ ${unitsToNumber(cashRefundUnits, MONEY_SCALE)}.`
            );
          }
        }

        const returnNumber = allocateSequenceTx(database, tenantId, 'RS', branchRow.code || 'BR01', terminalCode, nowIso);
        const returnInvoiceId = randomUUID();

        const contraRevCode = ACTIVITY_SALES_RETURN_ACCOUNTS[orig.activityId] || '4201';
        const invCode = ACTIVITY_INVENTORY_ACCOUNTS[orig.activityId] || '11041';
        const cogsCode = ACTIVITY_COGS_ACCOUNTS[orig.activityId] || '5101';

        const contraRevAcc = ensureCanonicalAccountTx(database, tenantId, contraRevCode);
        if (!contraRevAcc) {
          throw new FinancialValidationError(`حساب مردودات المبيعات (${contraRevCode}) غير معرف في الدليل.`);
        }

        const journalLines = [
          {
            id: randomUUID(),
            accountCode: contraRevCode,
            accountName: contraRevAcc.nameAr,
            debit: returnTotalNum,
            credit: 0,
            costCenterId: orig.activityId,
            memo: `مردودات مبيعات فاتورة ${returnNumber} (أصل ${orig.invoiceNumber})`,
          },
        ];
        updateAccountBalanceByLineTx(database, tenantId, contraRevCode, returnTotalUnits, 0n);

        if (arCreditedUnits > 0n) {
          const arAcc = ensureCanonicalAccountTx(database, tenantId, SPECIAL_ACCOUNTS.CUSTOMERS_AR);
          if (!arAcc) throw new FinancialValidationError('حساب العملاء (1103) غير معرف.');
          const arNum = unitsToNumber(arCreditedUnits, MONEY_SCALE);
          journalLines.push({
            id: randomUUID(),
            accountCode: SPECIAL_ACCOUNTS.CUSTOMERS_AR,
            accountName: `${arAcc.nameAr} - ${orig.partyName || ''}`.trim(),
            debit: 0,
            credit: arNum,
            costCenterId: orig.activityId,
            memo: `تخفيض ذمة العميل عن مرتجع ${returnNumber}`,
          });
          updateAccountBalanceByLineTx(database, tenantId, SPECIAL_ACCOUNTS.CUSTOMERS_AR, 0n, arCreditedUnits);
          if (customerRow) {
            updatePartyBalancesTx(database, tenantId, customerRow.id, -arCreditedUnits, 0n);
          }
          const updatedOrig = {
            ...orig,
            returnedAmount: unitsToNumber(origReturnedUnits + arCreditedUnits, MONEY_SCALE),
          };
          database.prepare('UPDATE invoices SET data_json = ? WHERE tenant_id = ? AND id = ?')
            .run(JSON.stringify(updatedOrig), tenantId, orig.id);
        }

        if (cashRefundUnits > 0n && targetCashBox) {
          const cashNum = unitsToNumber(cashRefundUnits, MONEY_SCALE);
          const updatedBox = updateCashBoxBalanceTx(database, tenantId, targetCashBox.id, -cashRefundUnits, true);
          const boxAcc = updateAccountBalanceByLineTx(database, tenantId, targetCashBox.accountCode, 0n, cashRefundUnits);
          journalLines.push({
            id: randomUUID(),
            accountCode: targetCashBox.accountCode,
            accountName: boxAcc?.nameAr || updatedBox.nameAr,
            debit: 0,
            credit: cashNum,
            costCenterId: orig.activityId,
            memo: `رد نقدي لمرتجع مبيعات ${returnNumber}`,
          });
        }

        let advTx;
        if (advanceCreditedUnits > 0n && customerRow) {
          const advAcc = ensureCanonicalAccountTx(database, tenantId, SPECIAL_ACCOUNTS.CUSTOMER_ADVANCES);
          if (!advAcc) throw new FinancialValidationError('حساب دفعات العملاء المقدمة (2103) غير معرف.');
          const advNum = unitsToNumber(advanceCreditedUnits, MONEY_SCALE);
          journalLines.push({
            id: randomUUID(),
            accountCode: SPECIAL_ACCOUNTS.CUSTOMER_ADVANCES,
            accountName: advAcc.nameAr,
            debit: 0,
            credit: advNum,
            costCenterId: orig.activityId,
            memo: `إيداع رصيد مقدم للعميل عن مرتجع مبيعات ${returnNumber}`,
          });
          updateAccountBalanceByLineTx(database, tenantId, SPECIAL_ACCOUNTS.CUSTOMER_ADVANCES, 0n, advanceCreditedUnits);
          const updatedParty = updatePartyBalancesTx(database, tenantId, customerRow.id, 0n, advanceCreditedUnits);
          advTx = {
            id: randomUUID(),
            tenantId,
            branchId: targetBranchId,
            partyId: customerRow.id,
            partyType: 'CUSTOMER',
            type: 'OVERPAYMENT_DEPOSIT',
            amount: advNum,
            balanceAfter: updatedParty.advanceBalance,
            invoiceId: returnInvoiceId,
            date: returnDate,
            description: `رصيد مقدم ناتج عن مرتجع مبيعات ${returnNumber} (أصل ${orig.invoiceNumber})`,
            createdBy: actor.id,
            createdAt: nowIso,
          };
        }

        if (restoredCogsUnits > 0n) {
          const invAcc = ensureCanonicalAccountTx(database, tenantId, invCode);
          const cogsAcc = ensureCanonicalAccountTx(database, tenantId, cogsCode);
          if (!invAcc || !cogsAcc) {
            throw new FinancialValidationError('حساب المخزون أو تكلفة المبيعات غير معرف.');
          }
          journalLines.push({
            id: randomUUID(),
            accountCode: invCode,
            accountName: invAcc.nameAr,
            debit: restoredCogsNum,
            credit: 0,
            costCenterId: orig.activityId,
            memo: `إعادة بضاعة مرتجعة للمخزون ${returnNumber}`,
          });
          updateAccountBalanceByLineTx(database, tenantId, invCode, restoredCogsUnits, 0n);

          journalLines.push({
            id: randomUUID(),
            accountCode: cogsCode,
            accountName: cogsAcc.nameAr,
            debit: 0,
            credit: restoredCogsNum,
            costCenterId: orig.activityId,
            memo: `تخفيض تكلفة البضاعة المباعة لمرتجع ${returnNumber}`,
          });
          updateAccountBalanceByLineTx(database, tenantId, cogsCode, 0n, restoredCogsUnits);
        }

        const entryNumber = allocateSequenceTx(database, tenantId, 'JV', branchRow.code || 'BR01', terminalCode, nowIso);
        const { persisted: journalEntry } = insertJournalEntryTx(database, tenantId, {
          id: randomUUID(),
          entryNumber,
          date: returnDate,
          description: `قيد مرتجع مبيعات ${returnNumber} (أصل ${orig.invoiceNumber}) - ${orig.partyName || ''}`.trim(),
          costCenterId: orig.activityId,
          branchId: targetBranchId,
          lines: journalLines,
          status: 'POSTED',
          referenceType: 'INVOICE',
          referenceId: returnInvoiceId,
          isAutoGenerated: true,
        });

        if (advTx) {
          advTx.journalEntryId = journalEntry.id;
          database.prepare(
            `INSERT INTO party_advance_transactions
              (tenant_id,id,branch_id,party_id,party_type,tx_type,amount_decimal,balance_after_decimal,voucher_id,invoice_id,journal_entry_id,tx_date,created_at,data_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).run(
            tenantId,
            advTx.id,
            targetBranchId,
            advTx.partyId,
            advTx.partyType,
            advTx.type,
            formatScaledInt(advanceCreditedUnits, MONEY_SCALE),
            formatScaledInt(parseScaledInt(advTx.balanceAfter, MONEY_SCALE, 'advBalAfter'), MONEY_SCALE),
            null,
            advTx.invoiceId,
            advTx.journalEntryId,
            advTx.date,
            advTx.createdAt,
            JSON.stringify(advTx)
          );
        }

        const persistedReturnInvoice = insertInvoiceTx(database, tenantId, {
          id: returnInvoiceId,
          invoiceNumber: returnNumber,
          type: 'RETURN_SALE',
          activityId: orig.activityId,
          branchId: targetBranchId,
          partyId: orig.partyId,
          partyName: orig.partyName,
          date: returnDate,
          items: returnItems,
          subtotal: returnTotalNum,
          discount: 0,
          tax: 0,
          total: returnTotalNum,
          paidAmount: unitsToNumber(cashRefundUnits, MONEY_SCALE),
          advanceAppliedAmount: unitsToNumber(advanceCreditedUnits, MONEY_SCALE),
          paymentMethod: cashRefundUnits > 0n ? 'CASH' : 'CREDIT',
          cashBoxId: targetCashBox?.id || orig.cashBoxId || '',
          notes: `مرتجع للفاتورة ${orig.invoiceNumber} — ${cleanReason}`,
          originalInvoiceId: orig.id,
          originalInvoiceNumber: orig.invoiceNumber,
          returnReason: cleanReason,
          journalEntryId: journalEntry.id,
          isPosted: true,
          status: 'POSTED',
          totalCogs: restoredCogsNum,
          stockDeductionsRecorded: restoredDeductions,
        });

        const idemKey = clientRequestId
          ? `REQ_${tenantId}_${clientRequestId}`
          : `${tenantId}_INVOICE_${persistedReturnInvoice.id}_CREATE`;

        enqueueOutboxTx(database, actor, {
          entityType: 'INVOICE',
          entityId: persistedReturnInvoice.id,
          action: 'CREATE',
          payload: persistedReturnInvoice,
          priority: 3,
          dependsOn: [orig.id],
          idempotencyKey: idemKey,
          branchId: targetBranchId,
          nowIso,
        });
        enqueueOutboxTx(database, actor, {
          entityType: 'JOURNAL_ENTRY',
          entityId: journalEntry.id,
          action: 'CREATE',
          payload: journalEntry,
          priority: 4,
          dependsOn: [persistedReturnInvoice.id],
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${journalEntry.id}_CREATE`,
          branchId: targetBranchId,
          nowIso,
        });
        if (advTx) {
          enqueueOutboxTx(database, actor, {
            entityType: 'PARTY_ADVANCE',
            entityId: advTx.id,
            action: 'CREATE',
            payload: advTx,
            priority: 4,
            dependsOn: [persistedReturnInvoice.id],
            idempotencyKey: `${tenantId}_PARTY_ADVANCE_${advTx.id}_CREATE`,
            branchId: targetBranchId,
            nowIso,
          });
        }
        writeAuditLogTx(
          database,
          { ...actor, branchId: targetBranchId },
          'إصدار مرتجع مبيعات ذري',
          `مرتجع ${returnNumber} على الفاتورة ${orig.invoiceNumber} بقيمة ${returnTotalNum} ${currencySymbol} (تخفيض ذمة: ${unitsToNumber(arCreditedUnits, MONEY_SCALE)}، رد نقدي: ${unitsToNumber(cashRefundUnits, MONEY_SCALE)}، رصيد مقدم: ${unitsToNumber(advanceCreditedUnits, MONEY_SCALE)})`,
          nowIso,
          {
            entityType: 'INVOICE',
            entityId: persistedReturnInvoice.id,
            previousValue: { originalInvoiceId: orig.id, originalInvoiceNumber: orig.invoiceNumber },
            newValue: {
              total: returnTotalNum,
              arCredited: unitsToNumber(arCreditedUnits, MONEY_SCALE),
              cashRefund: unitsToNumber(cashRefundUnits, MONEY_SCALE),
              advanceCredited: unitsToNumber(advanceCreditedUnits, MONEY_SCALE),
              restoredCogs: restoredCogsNum,
            },
            reason: cleanReason,
            result: 'SUCCESS',
          }
        );

        database.exec('COMMIT');
        return { success: true, invoice: persistedReturnInvoice, journalEntry };
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    createPurchaseReturnAtomic(actor, params) {
      if (!params || typeof params !== 'object' || !params.originalInvoiceId) {
        throw new FinancialValidationError('معرف فاتورة المشتريات الأصلية مطلوب.');
      }
      assertPermission(actor, 'purchase:return', 'إصدار مرتجع مشتريات');
      const cleanReason = String(params.returnReason || '').trim();
      if (!cleanReason) {
        throw new FinancialValidationError('سبب مرتجع المشتريات مطلوب لتوثيق القيد وسجل التدقيق.');
      }
      if (!Array.isArray(params.items) || params.items.length === 0) {
        throw new FinancialValidationError('يجب تحديد صنف واحد على الأقل لإتمام مرتجع المشتريات.');
      }

      const tenantId = actor.tenantId;
      const terminalCode = getTerminalCodeValue(database, tenantId);
      const currencySymbol = getCurrencySymbol(database, tenantId);
      const nowIso = new Date().toISOString();
      const todayStr = nowIso.split('T')[0];
      const clientRequestId = params.clientRequestId ? String(params.clientRequestId).trim() : '';

      database.exec('BEGIN IMMEDIATE');
      try {
        if (clientRequestId) {
          const dupOutbox = database.prepare(
            'SELECT entity_id FROM outbox_queue WHERE tenant_id = ? AND idempotency_key = ?'
          ).get(tenantId, `REQ_${tenantId}_${clientRequestId}`);
          if (dupOutbox) {
            const dupInvRow = database.prepare(
              `SELECT ${INVOICE_SELECT_COLUMNS} FROM invoices WHERE tenant_id = ? AND id = ?`
            ).get(tenantId, dupOutbox.entity_id);
            if (dupInvRow) {
              const dupInv = hydrateInvoiceRow(database, tenantId, dupInvRow);
              if (dupInv.journalEntryId) {
                const dupJeRow = database.prepare(
                  'SELECT tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json FROM journal_entries WHERE tenant_id = ? AND id = ?'
                ).get(tenantId, dupInv.journalEntryId);
                if (dupJeRow) {
                  database.exec('COMMIT');
                  return { success: true, invoice: dupInv, journalEntry: hydrateJournalEntryRow(database, tenantId, dupJeRow) };
                }
              }
            }
          }
        }

        const origRow = database.prepare(
          `SELECT ${INVOICE_SELECT_COLUMNS} FROM invoices WHERE tenant_id = ? AND id = ?`
        ).get(tenantId, String(params.originalInvoiceId));
        if (!origRow) {
          throw new FinancialValidationError('فاتورة المشتريات الأصلية غير موجودة.');
        }
        const orig = hydrateInvoiceRow(database, tenantId, origRow);
        assertActivityAccess(actor, orig.activityId, 'إصدار مرتجع مشتريات');
        if (orig.type !== 'PURCHASE') {
          throw new FinancialValidationError('يمكن إصدار مرتجع مشتريات لفواتير المشتريات (PURCHASE) فقط.');
        }
        if (orig.status === 'REVERSED') {
          throw new FinancialValidationError('لا يمكن عمل مرتجع على فاتورة مشتريات معكوسة.');
        }

        const targetBranchId = String(orig.branchId || '').trim();
        assertBranchAccess(actor, targetBranchId);
        const branchRow = database.prepare(
          'SELECT id, code, name_ar, active FROM branches WHERE tenant_id = ? AND id = ?'
        ).get(tenantId, targetBranchId);
        if (!branchRow) {
          throw new FinancialValidationError('فرع الفاتورة الأصلية غير موجود.');
        }

        const allInvRows = database.prepare(
          `SELECT ${INVOICE_SELECT_COLUMNS} FROM invoices WHERE tenant_id = ? AND invoice_type = 'RETURN_PURCHASE'`
        ).all(tenantId);
        const priorReturns = allInvRows
          .map((r) => hydrateInvoiceRow(database, tenantId, r))
          .filter((i) => i.originalInvoiceId === orig.id && i.status !== 'REVERSED');

        const returnedByLineId = new Map();
        const legacyReturnedByProductBatch = new Map();
        for (const r of priorReturns) {
          for (const it of r.items || []) {
            const qU = parseScaledInt(it.quantity, QTY_SCALE, 'priorRetItem.qty');
            if (it.originalInvoiceItemId) {
              returnedByLineId.set(it.originalInvoiceItemId, (returnedByLineId.get(it.originalInvoiceItemId) || 0n) + qU);
            } else {
              const key = `${it.productId}::${it.batchNumber || ''}`;
              legacyReturnedByProductBatch.set(key, (legacyReturnedByProductBatch.get(key) || 0n) + qU);
            }
          }
        }

        const origSubtotalUnits = parseScaledInt(orig.subtotal ?? 0, MONEY_SCALE, 'orig.subtotal');
        const origTotalUnits = parseScaledInt(orig.total ?? 0, MONEY_SCALE, 'orig.total');

        const returnItems = [];
        let returnTotalUnits = 0n;
        let invCostRawUnits = 0n;

        for (const reqItem of params.items) {
          if (!reqItem || !reqItem.productId) {
            throw new FinancialValidationError('معرف الصنف المرتجع مطلوب.');
          }
          const reqQtyUnits = parseScaledInt(reqItem.quantity, QTY_SCALE, 'retItem.quantity');
          if (reqQtyUnits <= 0n) {
            throw new FinancialValidationError('كمية الصنف المرتجع يجب أن تكون أكبر من الصفر.');
          }
          const origLine = resolveOriginalInvoiceLineForReturn(orig.items || [], reqItem, 'فاتورة الشراء الأصلية');

          const targetBatchNum = reqItem.batchNumber || origLine.batchNumber || '';
          const batchKey = `${reqItem.productId}::${targetBatchNum}`;
          const sameProductLines = (orig.items || []).filter(
            (it) => it.productId === reqItem.productId && (!reqItem.batchNumber || it.batchNumber === reqItem.batchNumber)
          );
          const legacyAlreadyRet = sameProductLines.length === 1
            ? (legacyReturnedByProductBatch.get(batchKey) || 0n)
            : 0n;
          const purchasedQtyUnits = parseScaledInt(origLine.quantity, QTY_SCALE, 'origLine.qty');
          const alreadyRetUnits = (returnedByLineId.get(origLine.id) || 0n) + legacyAlreadyRet;
          const remainingRetUnits = purchasedQtyUnits - alreadyRetUnits;
          if (reqQtyUnits > remainingRetUnits + 1n) {
            throw new FinancialValidationError(
              `الكمية المطلوب إرجاعها للمورد من (${origLine.productName}) تتجاوز الكمية المتاحة (${unitsToNumber(remainingRetUnits, QTY_SCALE)}).`
            );
          }
          returnedByLineId.set(origLine.id, (returnedByLineId.get(origLine.id) || 0n) + reqQtyUnits);

          const hasUnitSnapshot =
            origLine.unitId !== undefined ||
            origLine.conversionNumeratorSnapshot !== undefined ||
            origLine.baseQuantity !== undefined;
          const snapNum = origLine.conversionNumeratorSnapshot ?? 1;
          const snapDen = origLine.conversionDenominatorSnapshot ?? 1;
          let returnConversion;
          try {
            returnConversion = resolveUnitConversionToBase({
              quantity: unitsToNumber(reqQtyUnits, QTY_SCALE),
              numerator: snapNum,
              denominator: snapDen,
              unitName: origLine.unitNameSnapshot || origLine.unit || 'الوحدة',
            });
          } catch (err) {
            throw new FinancialValidationError(err instanceof Error ? err.message : 'تعذر تحويل وحدة مرتجع الشراء.');
          }
          const returnBaseQtyUnits = returnConversion.baseQtyUnits;

          const product = loadProductWithBatches(database, tenantId, reqItem.productId);
          if (!product) {
            throw new FinancialValidationError(`الصنف (${reqItem.productId}) غير موجود في المستودع.`);
          }
          const productStockUnits = parseScaledInt(product.currentStock ?? 0, QTY_SCALE, 'product.currentStock');
          if (productStockUnits + 1n < returnBaseQtyUnits) {
            throw new FinancialValidationError(
              `الرصيد المتاح بالمستودع من (${product.nameAr}) هو ${product.currentStock} فقط، ولا يكفي لإرجاع ${unitsToNumber(returnBaseQtyUnits, QTY_SCALE)} للمورد.`
            );
          }

          const batches = Array.isArray(product.batches)
            ? product.batches.map((b) => ({
                ...b,
                _qtyUnits: parseScaledInt(b.quantity, QTY_SCALE, 'batch.quantity'),
                _costUnits: parseScaledInt(b.costPrice, QTY_SCALE, 'batch.costPrice'),
              }))
            : [];

          if (targetBatchNum && batches.length > 0) {
            const batch = batches.find((b) => b.batchNumber === targetBatchNum);
            if (!batch) {
              throw new FinancialValidationError(`التشغيلة (${targetBatchNum}) للصنف (${product.nameAr}) غير موجودة.`);
            }
            if (batch._qtyUnits + 1n < returnBaseQtyUnits) {
              throw new FinancialValidationError(
                `الكمية المتاحة في التشغيلة (${targetBatchNum}) هي ${unitsToNumber(batch._qtyUnits, QTY_SCALE)} فقط.`
              );
            }
            invCostRawUnits += mulScaledHalfUp(returnBaseQtyUnits, batch._costUnits, QTY_SCALE, QTY_SCALE, TOTALS_SCALE);
            batch._qtyUnits = batch._qtyUnits > returnBaseQtyUnits ? batch._qtyUnits - returnBaseQtyUnits : 0n;
            const totalQ = batches.reduce((s, b) => s + b._qtyUnits, 0n);
            const totalV = batches.reduce((s, b) => s + b._qtyUnits * b._costUnits, 0n);
            product.batches = batches.map(({ _qtyUnits, _costUnits, ...rest }) => ({
              ...rest,
              quantity: unitsToNumber(_qtyUnits, QTY_SCALE),
            }));
            product.currentStock = unitsToNumber(totalQ, QTY_SCALE);
            product.purchasePrice = totalQ > 0n
              ? unitsToNumber(divBigIntHalfUp(totalV, totalQ), QTY_SCALE)
              : unitsToNumber(batch._costUnits, QTY_SCALE);
          } else {
            const costUnits = parseScaledInt(product.purchasePrice ?? 0, QTY_SCALE, 'product.purchasePrice');
            invCostRawUnits += mulScaledHalfUp(returnBaseQtyUnits, costUnits, QTY_SCALE, QTY_SCALE, TOTALS_SCALE);
            const nextStockUnits = productStockUnits > returnBaseQtyUnits ? productStockUnits - returnBaseQtyUnits : 0n;
            product.currentStock = unitsToNumber(nextStockUnits, QTY_SCALE);
          }

          syncProductAndBatchesTx(database, tenantId, product);

          const origLineSumUnits = parseScaledInt(origLine.total ?? 0, MONEY_SCALE, 'origLine.total');
          const lineReturnUnits = origSubtotalUnits > 0n
            ? divBigIntHalfUp(reqQtyUnits * origLineSumUnits * origTotalUnits, purchasedQtyUnits * origSubtotalUnits)
            : divBigIntHalfUp(reqQtyUnits * origLineSumUnits, purchasedQtyUnits);
          returnTotalUnits += lineReturnUnits;

          const lineUnitPriceUnits = divBigIntHalfUp(lineReturnUnits * QTY_SCALE, reqQtyUnits);
          returnItems.push({
            id: randomUUID(),
            originalInvoiceItemId: origLine.id,
            productId: product.id,
            productName: origLine.productName || product.nameAr,
            productCode: origLine.productCode || product.code,
            batchNumber: targetBatchNum || undefined,
            unit: origLine.unit || product.unit,
            ...(hasUnitSnapshot
              ? {
                  unitId: origLine.unitId ?? 'BASE',
                  unitNameSnapshot: origLine.unitNameSnapshot || origLine.unit || product.unit,
                  baseUnitNameSnapshot: origLine.baseUnitNameSnapshot || product.unit,
                  conversionNumeratorSnapshot: snapNum,
                  conversionDenominatorSnapshot: snapDen,
                  baseQuantity: returnConversion.baseQuantity,
                }
              : {}),
            quantity: unitsToNumber(reqQtyUnits, QTY_SCALE),
            unitPrice: unitsToNumber(lineUnitPriceUnits, MONEY_SCALE),
            discount: 0,
            total: unitsToNumber(lineReturnUnits, MONEY_SCALE),
          });
        }

        const returnTotalNum = unitsToNumber(returnTotalUnits, MONEY_SCALE);
        const invCostDeductedUnits = divBigIntHalfUp(invCostRawUnits * MONEY_SCALE, TOTALS_SCALE);
        const invCostDeductedNum = unitsToNumber(invCostDeductedUnits, MONEY_SCALE);

        const returnDate = params.date || todayStr;
        const supplierRow = orig.partyId
          ? database.prepare(
              'SELECT id, party_type, balance_decimal, advance_balance_decimal, data_json FROM parties WHERE tenant_id = ? AND id = ?'
            ).get(tenantId, orig.partyId)
          : null;
        const origPaidUnits = parseScaledInt(orig.paidAmount ?? 0, MONEY_SCALE, 'orig.paidAmount');
        const origReturnedUnits = parseScaledInt(orig.returnedAmount ?? 0, MONEY_SCALE, 'orig.returnedAmount');
        const origOpenRemUnits = origTotalUnits > (origPaidUnits + origReturnedUnits)
          ? origTotalUnits - origPaidUnits - origReturnedUnits
          : 0n;
        const origSettledUnits = origTotalUnits - origOpenRemUnits;

        let apDebitedUnits = 0n;
        let cashReceivedUnits = 0n;
        let advanceCreditedUnits = 0n;

        if (params.refundMethod === 'AP_OFFSET') {
          if (!supplierRow || supplierRow.party_type !== 'SUPPLIER') {
            throw new FinancialValidationError('تخفيض ذمة المورد متاح للموردين المسجلين فقط.');
          }
          if (returnTotalUnits > origOpenRemUnits + 1n) {
            throw new FinancialValidationError(
              `قيمة المرتجع (${returnTotalNum}) تتجاوز المتبقي المستحق من الفاتورة (${unitsToNumber(origOpenRemUnits, MONEY_SCALE)})؛ استخدم التسوية التلقائية.`
            );
          }
          apDebitedUnits = returnTotalUnits < origOpenRemUnits ? returnTotalUnits : origOpenRemUnits;
        } else if (params.refundMethod === 'CASH') {
          if (origOpenRemUnits > 0n && returnTotalUnits > origSettledUnits + 1n) {
            throw new FinancialValidationError(
              'الفاتورة تحتوي على مستحقات آجلة للمورد؛ استخدم التسوية التلقائية لتخفيض ذمة المورد أولاً.'
            );
          }
          cashReceivedUnits = returnTotalUnits;
        } else if (params.refundMethod === 'ADVANCE') {
          if (!supplierRow || supplierRow.party_type !== 'SUPPLIER') {
            throw new FinancialValidationError('تحويل المرتجع إلى سلفة مورد متاح للموردين المسجلين فقط.');
          }
          if (origOpenRemUnits > 0n && returnTotalUnits > origSettledUnits + 1n) {
            throw new FinancialValidationError(
              'الفاتورة تحتوي على مستحقات آجلة للمورد؛ استخدم التسوية التلقائية لتخفيض ذمة المورد أولاً.'
            );
          }
          advanceCreditedUnits = returnTotalUnits;
        } else {
          apDebitedUnits = supplierRow
            ? (returnTotalUnits < origOpenRemUnits ? returnTotalUnits : origOpenRemUnits)
            : 0n;
          const excessUnits = returnTotalUnits - apDebitedUnits;
          if (excessUnits > 0n) {
            if (params.cashBoxId || !supplierRow) {
              cashReceivedUnits = excessUnits;
            } else if (orig.cashBoxId) {
              cashReceivedUnits = excessUnits;
            } else {
              advanceCreditedUnits = excessUnits;
            }
          }
        }

        let targetCashBox;
        if (cashReceivedUnits > 0n) {
          const reqBoxId = params.cashBoxId || orig.cashBoxId;
          targetCashBox = reqBoxId
            ? getCashBoxRowTx(database, tenantId, reqBoxId)
            : resolveBranchDefaultCashBoxTx(database, tenantId, targetBranchId);
          assertCashBoxBranchAccessTx(actor, targetCashBox, targetBranchId);
        }

        const returnNumber = allocateSequenceTx(database, tenantId, 'RP', branchRow.code || 'BR01', terminalCode, nowIso);
        const returnInvoiceId = randomUUID();

        const invCode = ACTIVITY_INVENTORY_ACCOUNTS[orig.activityId] || '11041';
        const cogsCode = ACTIVITY_COGS_ACCOUNTS[orig.activityId] || '5101';
        const invAcc = ensureCanonicalAccountTx(database, tenantId, invCode);
        if (!invAcc) throw new FinancialValidationError(`حساب المخزون (${invCode}) غير معرف.`);

        const journalLines = [];

        if (apDebitedUnits > 0n) {
          const apAcc = ensureCanonicalAccountTx(database, tenantId, SPECIAL_ACCOUNTS.SUPPLIERS_AP);
          if (!apAcc) throw new FinancialValidationError('حساب الموردين (2101) غير معرف.');
          const apNum = unitsToNumber(apDebitedUnits, MONEY_SCALE);
          journalLines.push({
            id: randomUUID(),
            accountCode: SPECIAL_ACCOUNTS.SUPPLIERS_AP,
            accountName: `${apAcc.nameAr} - ${orig.partyName || ''}`.trim(),
            debit: apNum,
            credit: 0,
            costCenterId: orig.activityId,
            memo: `تخفيض ذمة المورد عن مرتجع مشتريات ${returnNumber}`,
          });
          updateAccountBalanceByLineTx(database, tenantId, SPECIAL_ACCOUNTS.SUPPLIERS_AP, apDebitedUnits, 0n);
          if (supplierRow) {
            updatePartyBalancesTx(database, tenantId, supplierRow.id, apDebitedUnits, 0n);
          }
          const updatedOrig = {
            ...orig,
            returnedAmount: unitsToNumber(origReturnedUnits + apDebitedUnits, MONEY_SCALE),
          };
          database.prepare('UPDATE invoices SET data_json = ? WHERE tenant_id = ? AND id = ?')
            .run(JSON.stringify(updatedOrig), tenantId, orig.id);
        }

        if (cashReceivedUnits > 0n && targetCashBox) {
          const cashNum = unitsToNumber(cashReceivedUnits, MONEY_SCALE);
          const updatedBox = updateCashBoxBalanceTx(database, tenantId, targetCashBox.id, cashReceivedUnits, false);
          const boxAcc = updateAccountBalanceByLineTx(database, tenantId, targetCashBox.accountCode, cashReceivedUnits, 0n);
          journalLines.push({
            id: randomUUID(),
            accountCode: targetCashBox.accountCode,
            accountName: boxAcc?.nameAr || updatedBox.nameAr,
            debit: cashNum,
            credit: 0,
            costCenterId: orig.activityId,
            memo: `استرداد نقدي من المورد عن مرتجع مشتريات ${returnNumber}`,
          });
        }

        let advTx;
        if (advanceCreditedUnits > 0n && supplierRow) {
          const supAdvAcc = ensureCanonicalAccountTx(database, tenantId, SPECIAL_ACCOUNTS.SUPPLIER_ADVANCES);
          if (!supAdvAcc) throw new FinancialValidationError('حساب سلف الموردين (1105) غير معرف.');
          const advNum = unitsToNumber(advanceCreditedUnits, MONEY_SCALE);
          journalLines.push({
            id: randomUUID(),
            accountCode: SPECIAL_ACCOUNTS.SUPPLIER_ADVANCES,
            accountName: supAdvAcc.nameAr,
            debit: advNum,
            credit: 0,
            costCenterId: orig.activityId,
            memo: `إثبات رصيد سلفة لدى المورد عن مرتجع مشتريات ${returnNumber}`,
          });
          updateAccountBalanceByLineTx(database, tenantId, SPECIAL_ACCOUNTS.SUPPLIER_ADVANCES, advanceCreditedUnits, 0n);
          const updatedParty = updatePartyBalancesTx(database, tenantId, supplierRow.id, 0n, advanceCreditedUnits);
          advTx = {
            id: randomUUID(),
            tenantId,
            branchId: targetBranchId,
            partyId: supplierRow.id,
            partyType: 'SUPPLIER',
            type: 'PREPAYMENT_DEPOSIT',
            amount: advNum,
            balanceAfter: updatedParty.advanceBalance,
            invoiceId: returnInvoiceId,
            date: returnDate,
            description: `سلفة مورد ناتجة عن مرتجع مشتريات ${returnNumber} (أصل ${orig.invoiceNumber})`,
            createdBy: actor.id,
            createdAt: nowIso,
          };
        }

        journalLines.push({
          id: randomUUID(),
          accountCode: invCode,
          accountName: invAcc.nameAr,
          debit: 0,
          credit: invCostDeductedNum,
          costCenterId: orig.activityId,
          memo: `صرف مرتجع مشتريات من المخزون ${returnNumber}`,
        });
        updateAccountBalanceByLineTx(database, tenantId, invCode, 0n, invCostDeductedUnits);

        const costVarianceUnits = returnTotalUnits - invCostDeductedUnits;
        if (costVarianceUnits !== 0n) {
          const cogsAcc = ensureCanonicalAccountTx(database, tenantId, cogsCode);
          if (!cogsAcc) throw new FinancialValidationError(`حساب تكلفة المبيعات (${cogsCode}) غير معرف.`);
          if (costVarianceUnits > 0n) {
            const varNum = unitsToNumber(costVarianceUnits, MONEY_SCALE);
            journalLines.push({
              id: randomUUID(),
              accountCode: cogsCode,
              accountName: cogsAcc.nameAr,
              debit: 0,
              credit: varNum,
              costCenterId: orig.activityId,
              memo: `تسوية فرق تكلفة مرتجع مشتريات ${returnNumber}`,
            });
            updateAccountBalanceByLineTx(database, tenantId, cogsCode, 0n, costVarianceUnits);
          } else {
            const absVarUnits = -costVarianceUnits;
            const varNum = unitsToNumber(absVarUnits, MONEY_SCALE);
            journalLines.push({
              id: randomUUID(),
              accountCode: cogsCode,
              accountName: cogsAcc.nameAr,
              debit: varNum,
              credit: 0,
              costCenterId: orig.activityId,
              memo: `تسوية فرق تكلفة مرتجع مشتريات ${returnNumber}`,
            });
            updateAccountBalanceByLineTx(database, tenantId, cogsCode, absVarUnits, 0n);
          }
        }

        const entryNumber = allocateSequenceTx(database, tenantId, 'JV', branchRow.code || 'BR01', terminalCode, nowIso);
        const { persisted: journalEntry } = insertJournalEntryTx(database, tenantId, {
          id: randomUUID(),
          entryNumber,
          date: returnDate,
          description: `قيد مرتجع مشتريات ${returnNumber} (أصل ${orig.invoiceNumber}) - ${orig.partyName || ''}`.trim(),
          costCenterId: orig.activityId,
          branchId: targetBranchId,
          lines: journalLines,
          status: 'POSTED',
          referenceType: 'INVOICE',
          referenceId: returnInvoiceId,
          isAutoGenerated: true,
        });

        if (advTx) {
          advTx.journalEntryId = journalEntry.id;
          database.prepare(
            `INSERT INTO party_advance_transactions
              (tenant_id,id,branch_id,party_id,party_type,tx_type,amount_decimal,balance_after_decimal,voucher_id,invoice_id,journal_entry_id,tx_date,created_at,data_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).run(
            tenantId,
            advTx.id,
            targetBranchId,
            advTx.partyId,
            advTx.partyType,
            advTx.type,
            formatScaledInt(advanceCreditedUnits, MONEY_SCALE),
            formatScaledInt(parseScaledInt(advTx.balanceAfter, MONEY_SCALE, 'advBalAfter'), MONEY_SCALE),
            null,
            advTx.invoiceId,
            advTx.journalEntryId,
            advTx.date,
            advTx.createdAt,
            JSON.stringify(advTx)
          );
        }

        const persistedReturnInvoice = insertInvoiceTx(database, tenantId, {
          id: returnInvoiceId,
          invoiceNumber: returnNumber,
          type: 'RETURN_PURCHASE',
          activityId: orig.activityId,
          branchId: targetBranchId,
          partyId: orig.partyId,
          partyName: orig.partyName,
          date: returnDate,
          items: returnItems,
          subtotal: returnTotalNum,
          discount: 0,
          tax: 0,
          total: returnTotalNum,
          paidAmount: unitsToNumber(cashReceivedUnits, MONEY_SCALE),
          advanceAppliedAmount: unitsToNumber(advanceCreditedUnits, MONEY_SCALE),
          paymentMethod: cashReceivedUnits > 0n ? 'CASH' : 'CREDIT',
          cashBoxId: targetCashBox?.id || orig.cashBoxId || '',
          notes: `مرتجع مشتريات للفاتورة ${orig.invoiceNumber} — ${cleanReason}`,
          originalInvoiceId: orig.id,
          originalInvoiceNumber: orig.invoiceNumber,
          returnReason: cleanReason,
          journalEntryId: journalEntry.id,
          isPosted: true,
          status: 'POSTED',
          totalCogs: invCostDeductedNum,
        });

        const idemKey = clientRequestId
          ? `REQ_${tenantId}_${clientRequestId}`
          : `${tenantId}_INVOICE_${persistedReturnInvoice.id}_CREATE`;

        enqueueOutboxTx(database, actor, {
          entityType: 'INVOICE',
          entityId: persistedReturnInvoice.id,
          action: 'CREATE',
          payload: persistedReturnInvoice,
          priority: 3,
          dependsOn: [orig.id],
          idempotencyKey: idemKey,
          branchId: targetBranchId,
          nowIso,
        });
        enqueueOutboxTx(database, actor, {
          entityType: 'JOURNAL_ENTRY',
          entityId: journalEntry.id,
          action: 'CREATE',
          payload: journalEntry,
          priority: 4,
          dependsOn: [persistedReturnInvoice.id],
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${journalEntry.id}_CREATE`,
          branchId: targetBranchId,
          nowIso,
        });
        if (advTx) {
          enqueueOutboxTx(database, actor, {
            entityType: 'PARTY_ADVANCE',
            entityId: advTx.id,
            action: 'CREATE',
            payload: advTx,
            priority: 4,
            dependsOn: [persistedReturnInvoice.id],
            idempotencyKey: `${tenantId}_PARTY_ADVANCE_${advTx.id}_CREATE`,
            branchId: targetBranchId,
            nowIso,
          });
        }
        writeAuditLogTx(
          database,
          { ...actor, branchId: targetBranchId },
          'إصدار مرتجع مشتريات ذري',
          `مرتجع ${returnNumber} على الفاتورة ${orig.invoiceNumber} بقيمة ${returnTotalNum} ${currencySymbol} (تخفيض ذمة: ${unitsToNumber(apDebitedUnits, MONEY_SCALE)}، استرداد نقدي: ${unitsToNumber(cashReceivedUnits, MONEY_SCALE)}، سلفة مورد: ${unitsToNumber(advanceCreditedUnits, MONEY_SCALE)})`,
          nowIso,
          {
            entityType: 'INVOICE',
            entityId: persistedReturnInvoice.id,
            previousValue: { originalInvoiceId: orig.id, originalInvoiceNumber: orig.invoiceNumber },
            newValue: {
              total: returnTotalNum,
              apDebited: unitsToNumber(apDebitedUnits, MONEY_SCALE),
              cashReceived: unitsToNumber(cashReceivedUnits, MONEY_SCALE),
              advanceCredited: unitsToNumber(advanceCreditedUnits, MONEY_SCALE),
              inventoryCostDeducted: invCostDeductedNum,
            },
            reason: cleanReason,
            result: 'SUCCESS',
          }
        );

        database.exec('COMMIT');
        return { success: true, invoice: persistedReturnInvoice, journalEntry };
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
          'SELECT code, is_leaf, data_json FROM accounts WHERE tenant_id = ? AND code = ?'
        ).get(tenantId, accountCode);
        if (!accountRow) {
          throw new FinancialValidationError(`الحساب المرتبط (${accountCode}) غير موجود في الدليل المحاسبي.`);
        }
        if (accountRow.is_leaf === 0 || parseRowJson(accountRow).isLeaf === false) {
          throw new FinancialValidationError(`لا يجوز ربط الصندوق بالحساب التجميعي (${accountCode}).`);
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

    // --- السندات النقدية الذرية والتخصيص والأرصدة المقدمة (Vouchers, Allocations & Advances) ---
    getVouchers(actor) {
      assertPermission(actor, 'vouchers:view', 'عرض السندات المالية');
      const rows = database.prepare(
        'SELECT tenant_id,id,branch_id,voucher_number,voucher_type,voucher_date,amount_decimal,cash_box_id,party_id,data_json FROM vouchers WHERE tenant_id = ? ORDER BY voucher_date DESC, rowid DESC'
      ).all(actor.tenantId);
      const vouchers = rows.map((row) => ({
        status: 'POSTED',
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

    getPaymentAllocations(actor, partyId, voucherId) {
      assertPermission(actor, 'vouchers:view', 'عرض تخصيصات الدفعات');
      let sql = 'SELECT tenant_id,id,branch_id,voucher_id,advance_transaction_id,party_id,invoice_id,allocated_decimal,allocation_method,status,created_at,created_by,data_json FROM payment_allocations WHERE tenant_id = ?';
      const args = [actor.tenantId];
      if (partyId) {
        sql += ' AND party_id = ?';
        args.push(String(partyId));
      }
      if (voucherId) {
        sql += ' AND voucher_id = ?';
        args.push(String(voucherId));
      }
      sql += ' ORDER BY created_at DESC, rowid DESC';
      const rows = database.prepare(sql).all(...args).map((r) => ({
        ...parseRowJson(r),
        id: r.id,
        tenantId: r.tenant_id,
        branchId: r.branch_id || '',
        voucherId: r.voucher_id ?? undefined,
        advanceTransactionId: r.advance_transaction_id ?? undefined,
        partyId: r.party_id,
        invoiceId: r.invoice_id,
        allocatedAmount: unitsToNumber(parseScaledInt(r.allocated_decimal, MONEY_SCALE, 'allocAmount'), MONEY_SCALE),
        allocationMethod: r.allocation_method,
        status: r.status,
        createdAt: r.created_at,
        createdBy: r.created_by ?? undefined,
      }));
      return filterRecordsByBranchScope(rows, actor);
    },

    getPartyAdvanceTransactions(actor, partyId) {
      assertPermission(actor, 'party:view', 'عرض حركات الأرصدة المقدمة');
      let sql = 'SELECT tenant_id,id,branch_id,party_id,party_type,tx_type,amount_decimal,balance_after_decimal,voucher_id,invoice_id,journal_entry_id,tx_date,created_at,data_json FROM party_advance_transactions WHERE tenant_id = ?';
      const args = [actor.tenantId];
      if (partyId) {
        sql += ' AND party_id = ?';
        args.push(String(partyId));
      }
      sql += ' ORDER BY created_at DESC, rowid DESC';
      const rows = database.prepare(sql).all(...args).map((r) => ({
        ...parseRowJson(r),
        id: r.id,
        tenantId: r.tenant_id,
        branchId: r.branch_id || '',
        partyId: r.party_id,
        partyType: r.party_type,
        type: r.tx_type,
        amount: unitsToNumber(parseScaledInt(r.amount_decimal, MONEY_SCALE, 'advAmount'), MONEY_SCALE),
        balanceAfter: unitsToNumber(parseScaledInt(r.balance_after_decimal, MONEY_SCALE, 'advBalAfter'), MONEY_SCALE),
        voucherId: r.voucher_id ?? undefined,
        invoiceId: r.invoice_id ?? undefined,
        journalEntryId: r.journal_entry_id ?? undefined,
        date: r.tx_date,
        createdAt: r.created_at,
      }));
      return filterRecordsByBranchScope(rows, actor);
    },

    getAllocationAudits(actor, voucherId) {
      assertPermission(actor, 'audit:allocation:view', 'عرض سجل تدقيق تخصيصات الدفعات');
      let sql = 'SELECT tenant_id,id,branch_id,voucher_id,party_id,user_id,audit_timestamp,data_json FROM allocation_audits WHERE tenant_id = ?';
      const args = [actor.tenantId];
      if (voucherId) {
        sql += ' AND voucher_id = ?';
        args.push(String(voucherId));
      }
      sql += ' ORDER BY audit_timestamp DESC, rowid DESC';
      const rows = database.prepare(sql).all(...args).map((r) => ({
        ...parseRowJson(r),
        id: r.id,
        tenantId: r.tenant_id,
        branchId: r.branch_id || '',
        voucherId: r.voucher_id,
        partyId: r.party_id,
        userId: r.user_id,
        timestamp: r.audit_timestamp,
      }));
      return filterRecordsByBranchScope(rows, actor);
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

      const hydrateVoucherRow = (row) => ({
        status: 'POSTED',
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
      });

      const postVoucherCoreTx = ({ voucher, targetBranch, isPromotingDraft = false }) => {
        const cashBox = getCashBoxRowTx(database, tenantId, voucher.cashBoxId);
        if (!voucher.cashBoxId || !cashBox) {
          throw new FinancialValidationError(`الصندوق المحدد (${voucher.cashBoxId || '-'}) غير موجود أو غير نشط.`);
        }
        assertCashBoxBranchAccessTx(actor, cashBox, targetBranch.id);

        const amountUnits = parseScaledInt(voucher.amount, MONEY_SCALE, 'voucher.amount');
        if (amountUnits <= 0n) {
          throw new FinancialValidationError('مبلغ السند المالي يجب أن يكون رقماً موجباً أكبر من الصفر.');
        }
        if (!voucher.description || !String(voucher.description).trim()) {
          throw new FinancialValidationError('وصف السند وسبب الحركة مطلوب محاسبياً.');
        }
        const amountNum = unitsToNumber(amountUnits, MONEY_SCALE);

        let partyObj = null;
        if (voucher.partyId) {
          const pRow = database.prepare(
            'SELECT tenant_id,id,party_type,balance_decimal,advance_balance_decimal,data_json FROM parties WHERE tenant_id = ? AND id = ?'
          ).get(tenantId, String(voucher.partyId));
          if (!pRow) {
            throw new FinancialValidationError('العميل أو المورد المحدد غير موجود في قاعدة البيانات.');
          }
          partyObj = {
            ...parseRowJson(pRow),
            id: pRow.id,
            type: pRow.party_type,
            balance: unitsToNumber(parseScaledInt(pRow.balance_decimal, MONEY_SCALE, 'pBal'), MONEY_SCALE),
            advanceBalance: unitsToNumber(parseScaledInt(pRow.advance_balance_decimal ?? 0, MONEY_SCALE, 'pAdv'), MONEY_SCALE),
          };
          if (voucher.voucherMode === 'CUSTOMER_RECEIPT' && (voucher.type !== 'RECEIPT' || partyObj.type !== 'CUSTOMER')) {
            throw new FinancialValidationError('وضع تحصيل العميل يقتصر على سند قبض مرتبط بسجل عميل.');
          }
          if (voucher.voucherMode === 'SUPPLIER_PAYMENT' && (voucher.type !== 'PAYMENT' || partyObj.type !== 'SUPPLIER')) {
            throw new FinancialValidationError('وضع سداد المورد يقتصر على سند صرف مرتبط بسجل مورد.');
          }
        } else if (voucher.voucherMode === 'CUSTOMER_RECEIPT' || voucher.voucherMode === 'SUPPLIER_PAYMENT') {
          throw new FinancialValidationError('يجب اختيار سجل عميل أو مورد حقيقي لتنفيذ تسوية الذمم.');
        }

        const partyInvoices = partyObj
          ? filterRecordsByBranchScope(
              database
                .prepare(`SELECT ${INVOICE_SELECT_COLUMNS} FROM invoices WHERE tenant_id = ? AND party_id = ?`)
                .all(tenantId, partyObj.id)
                .map((r) => hydrateInvoiceRow(database, tenantId, r)),
              actor
            )
          : [];

        const reqAccCode = String(voucher.accountCode || '').trim();
        const reqAccRow = reqAccCode
          ? database.prepare('SELECT code, is_leaf, data_json FROM accounts WHERE tenant_id = ? AND code = ?').get(tenantId, reqAccCode)
          : null;
        if (!partyObj && !reqAccRow) {
          throw new FinancialValidationError(`الحساب المقابل (${voucher.accountCode || '-'}) غير موجود في الدليل المحاسبي.`);
        }
        const reqAccIsLeaf = reqAccRow ? reqAccRow.is_leaf === 1 && parseRowJson(reqAccRow).isLeaf !== false : false;

        let plan;
        try {
          plan = resolveVoucherAccountingPlan({
            voucherType: voucher.type,
            voucherMode: voucher.voucherMode,
            party: partyObj,
            requestedAccountCode: reqAccCode,
            amount: amountNum,
            openInvoices: partyInvoices,
            manualAllocations: params.manualAllocations,
            hasOverridePermission: hasPermission(actor, 'payment:allocation:override'),
            overrideReason: params.overrideReason,
            hasSupplierAdvancePermission: hasPermission(actor, 'supplier:advance:approve'),
            targetAccountIsLeaf: reqAccIsLeaf,
          });
        } catch (err) {
          throw new FinancialValidationError(err instanceof Error ? err.message : 'تعذر اعتماد خطة السند المالي.');
        }

        if (voucher.type === 'PAYMENT' && cashBox._balanceUnits < amountUnits) {
          throw new FinancialValidationError(
            `رصيد الصندوق (${cashBox.nameAr}: ${cashBox.balance}) غير كافٍ لصرف مبلغ ${amountNum}.`
          );
        }

        if (!voucher.voucherNumber || !String(voucher.voucherNumber).trim()) {
          voucher.voucherNumber = allocateSequenceTx(
            database,
            tenantId,
            voucher.type === 'RECEIPT' ? 'RCT' : 'PAY',
            targetBranch.code,
            terminalCode,
            nowIso
          );
        } else {
          voucher.voucherNumber = String(voucher.voucherNumber).trim();
        }

        const voucherDate = voucher.date || nowIso.split('T')[0];
        const cashBoxAccRow = database.prepare(
          'SELECT code, data_json FROM accounts WHERE tenant_id = ? AND code = ?'
        ).get(tenantId, cashBox.accountCode);
        if (!cashBoxAccRow) {
          throw new FinancialValidationError(`حساب الصندوق (${cashBox.accountCode}) غير موجود في الدليل المحاسبي.`);
        }
        const cashBoxAccName = parseRowJson(cashBoxAccRow).nameAr || cashBox.nameAr;

        ensureCanonicalAccountTx(database, tenantId, SPECIAL_ACCOUNTS.CUSTOMER_ADVANCES);
        ensureCanonicalAccountTx(database, tenantId, SPECIAL_ACCOUNTS.SUPPLIER_ADVANCES);

        const lines = [];
        if (voucher.type === 'RECEIPT') {
          lines.push({
            id: randomUUID(),
            accountCode: cashBox.accountCode,
            accountName: cashBoxAccName,
            debit: amountNum,
            credit: 0,
            costCenterId: voucher.costCenterId || 'general',
            memo: `سند قبض ${voucher.voucherNumber} - ${voucher.description}`,
          });
          for (const cLine of plan.creditLines) {
            const acc = ensureCanonicalAccountTx(database, tenantId, cLine.accountCode);
            if (!acc) {
              throw new FinancialValidationError(`الحساب المحاسبي (${cLine.accountCode}) غير معرف في الدليل المحاسبي.`);
            }
            lines.push({
              id: randomUUID(),
              accountCode: cLine.accountCode,
              accountName: acc.nameAr,
              debit: 0,
              credit: cLine.amount,
              costCenterId: voucher.costCenterId || 'general',
              memo:
                cLine.accountCode === SPECIAL_ACCOUNTS.CUSTOMER_ADVANCES
                  ? `دفعة مقدمة من العميل - سند ${voucher.voucherNumber}`
                  : String(voucher.description),
            });
          }
        } else {
          for (const dLine of plan.debitLines) {
            const acc = ensureCanonicalAccountTx(database, tenantId, dLine.accountCode);
            if (!acc) {
              throw new FinancialValidationError(`الحساب المحاسبي (${dLine.accountCode}) غير معرف في الدليل المحاسبي.`);
            }
            lines.push({
              id: randomUUID(),
              accountCode: dLine.accountCode,
              accountName: acc.nameAr,
              debit: dLine.amount,
              credit: 0,
              costCenterId: voucher.costCenterId || 'general',
              memo:
                dLine.accountCode === SPECIAL_ACCOUNTS.SUPPLIER_ADVANCES
                  ? `دفعة مقدمة / سلفة مورد - سند ${voucher.voucherNumber}`
                  : String(voucher.description),
            });
          }
          lines.push({
            id: randomUUID(),
            accountCode: cashBox.accountCode,
            accountName: cashBoxAccName,
            debit: 0,
            credit: amountNum,
            costCenterId: voucher.costCenterId || 'general',
            memo: `سند صرف ${voucher.voucherNumber} - ${voucher.description}`,
          });
        }

        const entryNumber = allocateSequenceTx(database, tenantId, 'JV', targetBranch.code, terminalCode, nowIso);
        const { persisted: journalEntry, linesWithUnits } = insertJournalEntryTx(database, tenantId, {
          id: randomUUID(),
          entryNumber,
          date: voucherDate,
          description: `${voucher.type === 'RECEIPT' ? 'سند قبض' : 'سند صرف'} ${voucher.voucherNumber}: ${partyObj?.nameAr || voucher.partyName || ''} - ${voucher.description}`,
          costCenterId: voucher.costCenterId || 'general',
          branchId: targetBranch.id,
          lines,
          status: 'POSTED',
          referenceType: 'VOUCHER',
          referenceId: voucher.id,
          isAutoGenerated: true,
        });

        // 1) Update CashBox & Accounts using account type polarity
        const cashDeltaUnits = voucher.type === 'RECEIPT' ? amountUnits : -amountUnits;
        updateCashBoxBalanceTx(database, tenantId, cashBox.id, cashDeltaUnits, voucher.type === 'PAYMENT');
        for (const line of linesWithUnits) {
          updateAccountBalanceByLineTx(database, tenantId, line.accountCode, line._debitUnits, line._creditUnits);
        }

        // 2) Update Invoices & insert payment_allocations
        const createdAllocations = [];
        for (const alloc of plan.allocations) {
          const invRow = database.prepare(
            `SELECT ${INVOICE_SELECT_COLUMNS} FROM invoices WHERE tenant_id = ? AND id = ?`
          ).get(tenantId, alloc.invoiceId);
          if (!invRow) {
            throw new FinancialValidationError(`الفاتورة (${alloc.invoiceId}) غير موجودة أثناء التخصيص.`);
          }
          const invObj = hydrateInvoiceRow(database, tenantId, invRow);
          const allocUnits = parseScaledInt(alloc.allocatedAmount, MONEY_SCALE, 'allocAmount');
          const invTotalUnits = parseScaledInt(invRow.total_decimal, MONEY_SCALE, 'invTotal');
          const invPaidUnits = parseScaledInt(invRow.paid_amount_decimal, MONEY_SCALE, 'invPaid');
          const invReturnedUnits = parseScaledInt(invObj.returnedAmount || 0, MONEY_SCALE, 'invReturned');
          const nextPaidUnits = invPaidUnits + allocUnits;
          if (nextPaidUnits + invReturnedUnits > invTotalUnits) {
            throw new FinancialValidationError(`تجاوز التخصيص صافي المتبقي من الفاتورة (${invObj.invoiceNumber}) بعد المرتجعات.`);
          }
          const nextPaidNum = unitsToNumber(nextPaidUnits, MONEY_SCALE);
          invObj.paidAmount = nextPaidNum;
          database.prepare(
            'UPDATE invoices SET paid_amount_decimal = ?, data_json = ? WHERE tenant_id = ? AND id = ?'
          ).run(formatScaledInt(nextPaidUnits, MONEY_SCALE), JSON.stringify(invObj), tenantId, invObj.id);

          const allocRow = {
            id: randomUUID(),
            tenantId,
            branchId: targetBranch.id,
            voucherId: voucher.id,
            partyId: partyObj.id,
            invoiceId: invObj.id,
            invoiceNumber: invObj.invoiceNumber,
            invoiceDate: invObj.date,
            allocatedAmount: alloc.allocatedAmount,
            allocationMethod: plan.manualOverride ? 'MANUAL' : 'FIFO',
            status: 'ACTIVE',
            createdAt: nowIso,
            createdBy: actor.id,
          };
          createdAllocations.push(allocRow);
          database.prepare(
            `INSERT INTO payment_allocations
              (tenant_id,id,branch_id,voucher_id,advance_transaction_id,party_id,invoice_id,allocated_decimal,allocation_method,status,created_at,created_by,data_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).run(
            tenantId,
            allocRow.id,
            allocRow.branchId,
            allocRow.voucherId,
            null,
            allocRow.partyId,
            allocRow.invoiceId,
            formatScaledInt(allocUnits, MONEY_SCALE),
            allocRow.allocationMethod,
            allocRow.status,
            allocRow.createdAt,
            allocRow.createdBy,
            JSON.stringify(allocRow)
          );
          enqueueOutboxTx(database, actor, {
            entityType: 'PAYMENT_ALLOCATION',
            entityId: allocRow.id,
            action: 'CREATE',
            payload: allocRow,
            priority: 4,
            dependsOn: [voucher.id, invObj.id],
            idempotencyKey: `${tenantId}_PAYMENT_ALLOCATION_${allocRow.id}_CREATE`,
            branchId: targetBranch.id,
            nowIso,
          });
        }

        // 3) Allocation audit if manually overridden
        if (plan.manualOverride && partyObj) {
          const auditRow = {
            id: randomUUID(),
            tenantId,
            branchId: targetBranch.id,
            voucherId: voucher.id,
            partyId: partyObj.id,
            userId: actor.id,
            userName: actor.fullName,
            reason: plan.overrideReason || '',
            previousAllocations: plan.previousFifoAllocations.map((a) => ({
              invoiceId: a.invoiceId,
              invoiceNumber: a.invoiceNumber,
              allocatedAmount: a.allocatedAmount,
            })),
            newAllocations: plan.allocations.map((a) => ({
              invoiceId: a.invoiceId,
              invoiceNumber: a.invoiceNumber,
              allocatedAmount: a.allocatedAmount,
            })),
            timestamp: nowIso,
          };
          database.prepare(
            `INSERT INTO allocation_audits
              (tenant_id,id,branch_id,voucher_id,party_id,user_id,audit_timestamp,data_json)
             VALUES (?,?,?,?,?,?,?,?)`
          ).run(
            tenantId,
            auditRow.id,
            auditRow.branchId,
            auditRow.voucherId,
            auditRow.partyId,
            auditRow.userId,
            auditRow.timestamp,
            JSON.stringify(auditRow)
          );
          enqueueOutboxTx(database, actor, {
            entityType: 'ALLOCATION_AUDIT',
            entityId: auditRow.id,
            action: 'CREATE',
            payload: auditRow,
            priority: 4,
            dependsOn: [voucher.id],
            idempotencyKey: `${tenantId}_ALLOCATION_AUDIT_${auditRow.id}_CREATE`,
            branchId: targetBranch.id,
            nowIso,
          });
        }

        // 4) Party balance + advance ledger transaction
        let createdAdvanceTx;
        if (partyObj) {
          const debtDeltaUnits = parseScaledInt(plan.partyDebtDelta, MONEY_SCALE, 'partyDebtDelta');
          const advDeltaUnits = parseScaledInt(plan.partyAdvanceDelta, MONEY_SCALE, 'partyAdvanceDelta');
          const updatedParty = updatePartyBalancesTx(database, tenantId, partyObj.id, debtDeltaUnits, advDeltaUnits);

          if (plan.advanceDirection !== 'NONE' && plan.advanceAmount > 0) {
            const txType =
              plan.advanceDirection === 'DEPOSIT_CUSTOMER'
                ? 'OVERPAYMENT_DEPOSIT'
                : plan.advanceDirection === 'DEPOSIT_SUPPLIER'
                ? 'PREPAYMENT_DEPOSIT'
                : 'REFUND';
            const signedAmt =
              plan.advanceDirection === 'REFUND_CUSTOMER' || plan.advanceDirection === 'REFUND_SUPPLIER'
                ? -plan.advanceAmount
                : plan.advanceAmount;
            createdAdvanceTx = {
              id: randomUUID(),
              tenantId,
              branchId: targetBranch.id,
              partyId: partyObj.id,
              partyType: partyObj.type,
              type: txType,
              amount: signedAmt,
              balanceAfter: updatedParty.advanceBalance,
              voucherId: voucher.id,
              journalEntryId: journalEntry.id,
              date: voucherDate,
              description: String(voucher.description),
              createdBy: actor.id,
              createdAt: nowIso,
            };
            database.prepare(
              `INSERT INTO party_advance_transactions
                (tenant_id,id,branch_id,party_id,party_type,tx_type,amount_decimal,balance_after_decimal,voucher_id,invoice_id,journal_entry_id,tx_date,created_at,data_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
            ).run(
              tenantId,
              createdAdvanceTx.id,
              createdAdvanceTx.branchId,
              createdAdvanceTx.partyId,
              createdAdvanceTx.partyType,
              createdAdvanceTx.type,
              formatScaledInt(parseScaledInt(signedAmt, MONEY_SCALE, 'signedAdvAmt'), MONEY_SCALE),
              formatScaledInt(parseScaledInt(updatedParty.advanceBalance, MONEY_SCALE, 'advBalAfter'), MONEY_SCALE),
              createdAdvanceTx.voucherId,
              null,
              createdAdvanceTx.journalEntryId,
              createdAdvanceTx.date,
              createdAdvanceTx.createdAt,
              JSON.stringify(createdAdvanceTx)
            );
            enqueueOutboxTx(database, actor, {
              entityType: 'PARTY_ADVANCE',
              entityId: createdAdvanceTx.id,
              action: 'CREATE',
              payload: createdAdvanceTx,
              priority: 4,
              dependsOn: [voucher.id],
              idempotencyKey: `${tenantId}_PARTY_ADVANCE_${createdAdvanceTx.id}_CREATE`,
              branchId: targetBranch.id,
              nowIso,
            });
          }
        }

        const persistedMode =
          plan.mode === 'GENERAL'
            ? 'GENERAL'
            : partyObj?.type === 'CUSTOMER'
            ? 'CUSTOMER_RECEIPT'
            : 'SUPPLIER_PAYMENT';

        const persistedVoucher = {
          ...voucher,
          tenantId,
          branchId: targetBranch.id,
          amount: amountNum,
          date: voucherDate,
          voucherMode: persistedMode,
          partyType: partyObj?.type,
          partyName: partyObj?.nameAr || voucher.partyName || '',
          cashBoxId: cashBox.id,
          accountCode: plan.primaryContraAccountCode,
          paymentMethod: voucher.paymentMethod || 'CASH',
          journalEntryId: journalEntry.id,
          status: 'POSTED',
          appliedToDebtAmount: plan.appliedToDebtAmount,
          advanceAmount: plan.advanceAmount,
          allocations: createdAllocations,
          manualOverride: plan.manualOverride,
          overrideReason: plan.overrideReason,
          createdBy: voucher.createdBy || actor.id,
          createdByName: voucher.createdByName || actor.fullName,
          createdAt: voucher.createdAt || nowIso,
        };

        if (isPromotingDraft) {
          database.prepare(
            `UPDATE vouchers
             SET voucher_number = ?, voucher_date = ?, amount_decimal = ?, cash_box_id = ?, party_id = ?, data_json = ?
             WHERE tenant_id = ? AND id = ?`
          ).run(
            persistedVoucher.voucherNumber,
            persistedVoucher.date,
            formatScaledInt(amountUnits, MONEY_SCALE),
            persistedVoucher.cashBoxId,
            persistedVoucher.partyId || null,
            JSON.stringify(persistedVoucher),
            tenantId,
            persistedVoucher.id
          );
        } else {
          database.prepare(
            `INSERT INTO vouchers
              (tenant_id,id,branch_id,voucher_number,voucher_type,voucher_date,amount_decimal,cash_box_id,party_id,data_json)
             VALUES (?,?,?,?,?,?,?,?,?,?)`
          ).run(
            tenantId,
            persistedVoucher.id,
            targetBranch.id,
            persistedVoucher.voucherNumber,
            persistedVoucher.type,
            persistedVoucher.date,
            formatScaledInt(amountUnits, MONEY_SCALE),
            persistedVoucher.cashBoxId,
            persistedVoucher.partyId || null,
            JSON.stringify(persistedVoucher)
          );
        }

        const deps = [cashBox.id];
        if (persistedVoucher.partyId) deps.push(persistedVoucher.partyId);

        enqueueOutboxTx(database, actor, {
          entityType: 'VOUCHER',
          entityId: persistedVoucher.id,
          action: isPromotingDraft ? 'UPDATE' : 'CREATE',
          payload: persistedVoucher,
          priority: 3,
          dependsOn: deps,
          idempotencyKey: `${tenantId}_VOUCHER_${persistedVoucher.id}_${isPromotingDraft ? 'POST' : 'CREATE'}`,
          branchId: targetBranch.id,
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
          branchId: targetBranch.id,
          nowIso,
        });
        writeAuditLogTx(
          database,
          { ...actor, branchId: targetBranch.id },
          `سند ${persistedVoucher.type === 'RECEIPT' ? 'قبض' : 'صرف'} مرحل`,
          `سند ${persistedVoucher.voucherNumber} بمبلغ ${amountNum} ${currencySymbol} وقيد ${journalEntry.entryNumber}${plan.advanceAmount > 0 ? ` (رصيد مقدم: ${plan.advanceAmount})` : ''}`,
          nowIso
        );

        return {
          success: true,
          voucher: persistedVoucher,
          journalEntry,
          allocations: createdAllocations,
          advanceTransaction: createdAdvanceTx,
        };
      };

      database.exec('BEGIN IMMEDIATE');
      try {
        const voucher = { ...rawVoucher };
        if (!voucher.id || !String(voucher.id).trim()) {
          voucher.id = randomUUID();
        } else {
          voucher.id = String(voucher.id).trim();
        }

        // Idempotency check
        const existingVoucherRow = database.prepare(
          'SELECT tenant_id,id,branch_id,voucher_number,voucher_type,voucher_date,amount_decimal,cash_box_id,party_id,data_json FROM vouchers WHERE tenant_id = ? AND id = ?'
        ).get(tenantId, voucher.id);
        if (existingVoucherRow) {
          const existingVoucher = hydrateVoucherRow(existingVoucherRow);
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
          if (existingVoucher.status === 'DRAFT' && voucher.status === 'DRAFT') {
            database.exec('COMMIT');
            return { success: true, voucher: existingVoucher, allocations: [] };
          }
        }

        if (voucher.status === 'DRAFT') {
          const cashBox = getCashBoxRowTx(database, tenantId, voucher.cashBoxId);
          if (!voucher.cashBoxId || !cashBox) {
            throw new FinancialValidationError(`الصندوق المحدد (${voucher.cashBoxId || '-'}) غير موجود أو غير نشط.`);
          }
          assertCashBoxBranchAccessTx(actor, cashBox, branchId);
          const amountUnits = parseScaledInt(voucher.amount, MONEY_SCALE, 'voucher.amount');
          if (amountUnits <= 0n) {
            throw new FinancialValidationError('مبلغ السند المالي يجب أن يكون رقماً موجباً أكبر من الصفر.');
          }
          if (!voucher.description || !String(voucher.description).trim()) {
            throw new FinancialValidationError('وصف السند وسبب الحركة مطلوب محاسبياً.');
          }

          let partyObj = null;
          if (voucher.partyId) {
            const pRow = database.prepare(
              'SELECT id, party_type, balance_decimal, advance_balance_decimal, data_json FROM parties WHERE tenant_id = ? AND id = ?'
            ).get(tenantId, String(voucher.partyId));
            if (!pRow) {
              throw new FinancialValidationError('العميل أو المورد المحدد غير موجود.');
            }
            partyObj = {
              ...parseRowJson(pRow),
              id: pRow.id,
              type: pRow.party_type,
              balance: unitsToNumber(parseScaledInt(pRow.balance_decimal, MONEY_SCALE, 'pBal'), MONEY_SCALE),
              advanceBalance: unitsToNumber(parseScaledInt(pRow.advance_balance_decimal ?? 0, MONEY_SCALE, 'pAdv'), MONEY_SCALE),
            };
          }
          const reqAccCode = String(voucher.accountCode || '').trim();
          const reqAccRow = reqAccCode
            ? database.prepare('SELECT code, is_leaf, data_json FROM accounts WHERE tenant_id = ? AND code = ?').get(tenantId, reqAccCode)
            : null;
          if (!partyObj && !reqAccRow) {
            throw new FinancialValidationError(`الحساب المقابل (${voucher.accountCode || '-'}) غير موجود في الدليل المحاسبي.`);
          }
          const reqAccIsLeaf = reqAccRow ? reqAccRow.is_leaf === 1 && parseRowJson(reqAccRow).isLeaf !== false : false;
          const partyInvoices =
            partyObj && Array.isArray(params.manualAllocations)
              ? filterRecordsByBranchScope(
                  database
                    .prepare(`SELECT ${INVOICE_SELECT_COLUMNS} FROM invoices WHERE tenant_id = ? AND party_id = ?`)
                    .all(tenantId, partyObj.id)
                    .map((r) => hydrateInvoiceRow(database, tenantId, r)),
                  actor
                )
              : [];
          const previewPlan = resolveVoucherAccountingPlan({
            voucherType: voucher.type,
            voucherMode: voucher.voucherMode,
            party: partyObj,
            requestedAccountCode: reqAccCode,
            amount: unitsToNumber(amountUnits, MONEY_SCALE),
            openInvoices: partyInvoices,
            manualAllocations: params.manualAllocations,
            hasOverridePermission: hasPermission(actor, 'payment:allocation:override'),
            overrideReason: params.overrideReason,
            hasSupplierAdvancePermission: hasPermission(actor, 'supplier:advance:approve'),
            targetAccountIsLeaf: reqAccIsLeaf,
          });

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

          const savedManualAllocations =
            previewPlan.manualOverride && Array.isArray(params.manualAllocations)
              ? params.manualAllocations.map((m) => ({
                  invoiceId: String(m.invoiceId || '').trim(),
                  allocatedAmount: unitsToNumber(parseScaledInt(m.allocatedAmount, MONEY_SCALE, 'manualAlloc'), MONEY_SCALE),
                }))
              : undefined;

          const draftVoucher = {
            ...voucher,
            tenantId,
            branchId,
            amount: unitsToNumber(amountUnits, MONEY_SCALE),
            date: voucher.date || nowIso.split('T')[0],
            status: 'DRAFT',
            accountCode: previewPlan.primaryContraAccountCode,
            partyType: partyObj?.type,
            partyName: partyObj?.nameAr || voucher.partyName || '',
            paymentMethod: voucher.paymentMethod || 'CASH',
            manualOverride: previewPlan.manualOverride,
            overrideReason: previewPlan.overrideReason,
            ...(savedManualAllocations ? { manualAllocations: savedManualAllocations } : {}),
            createdBy: actor.id,
            createdByName: actor.fullName,
            createdAt: nowIso,
          };

          database.prepare(
            `INSERT INTO vouchers
              (tenant_id,id,branch_id,voucher_number,voucher_type,voucher_date,amount_decimal,cash_box_id,party_id,data_json)
             VALUES (?,?,?,?,?,?,?,?,?,?)`
          ).run(
            tenantId,
            draftVoucher.id,
            branchId,
            draftVoucher.voucherNumber,
            draftVoucher.type,
            draftVoucher.date,
            formatScaledInt(amountUnits, MONEY_SCALE),
            draftVoucher.cashBoxId,
            draftVoucher.partyId || null,
            JSON.stringify(draftVoucher)
          );
          enqueueOutboxTx(database, actor, {
            entityType: 'VOUCHER',
            entityId: draftVoucher.id,
            action: 'CREATE',
            payload: draftVoucher,
            priority: 3,
            idempotencyKey: `${tenantId}_VOUCHER_${draftVoucher.id}_DRAFT`,
            branchId,
            nowIso,
          });
          writeAuditLogTx(
            database,
            { ...actor, branchId },
            `إنشاء مسودة سند ${draftVoucher.type === 'RECEIPT' ? 'قبض' : 'صرف'}`,
            `مسودة ${draftVoucher.voucherNumber} بمبلغ ${draftVoucher.amount} ${currencySymbol}`,
            nowIso
          );
          database.exec('COMMIT');
          return { success: true, voucher: draftVoucher, allocations: [] };
        }

        const result = postVoucherCoreTx({ voucher, targetBranch: activeBranch, isPromotingDraft: false });
        database.exec('COMMIT');
        return result;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    postDraftCashVoucherAtomic(actor, params) {
      if (!params || !params.voucherId) {
        throw new FinancialValidationError('معرف السند المطلوب ترحيله مطلوب.');
      }
      const tenantId = actor.tenantId;
      const terminalCode = getTerminalCodeValue(database, tenantId);
      const currencySymbol = getCurrencySymbol(database, tenantId);
      const nowIso = new Date().toISOString();

      database.exec('BEGIN IMMEDIATE');
      try {
        const vRow = database.prepare(
          'SELECT tenant_id,id,branch_id,voucher_number,voucher_type,voucher_date,amount_decimal,cash_box_id,party_id,data_json FROM vouchers WHERE tenant_id = ? AND id = ?'
        ).get(tenantId, String(params.voucherId));
        if (!vRow) {
          throw new FinancialValidationError('السند المطلوب ترحيله غير موجود.');
        }
        const draft = {
          status: 'POSTED',
          ...parseRowJson(vRow),
          id: vRow.id,
          tenantId: vRow.tenant_id,
          branchId: vRow.branch_id || '',
          voucherNumber: vRow.voucher_number,
          type: vRow.voucher_type,
          date: vRow.voucher_date,
          amount: unitsToNumber(parseScaledInt(vRow.amount_decimal, MONEY_SCALE, 'voucherAmount'), MONEY_SCALE),
          cashBoxId: vRow.cash_box_id,
          partyId: vRow.party_id ?? undefined,
        };
        assertPermission(
          actor,
          draft.type === 'RECEIPT' ? 'voucher:receipt' : 'voucher:payment',
          'ترحيل مسودة السند'
        );
        const targetBranch = resolveBranchTx(database, core, actor, draft.branchId);
        if (draft.status !== 'DRAFT') {
          throw new FinancialValidationError('يمكن ترحيل السندات التي في حالة المسودة فقط.');
        }

        const cashBox = getCashBoxRowTx(database, tenantId, draft.cashBoxId);
        if (!draft.cashBoxId || !cashBox) {
          throw new FinancialValidationError(`الصندوق المحدد (${draft.cashBoxId || '-'}) غير موجود أو غير نشط.`);
        }
        assertCashBoxBranchAccessTx(actor, cashBox, targetBranch.id);
        const amountUnits = parseScaledInt(draft.amount, MONEY_SCALE, 'voucher.amount');
        const amountNum = unitsToNumber(amountUnits, MONEY_SCALE);

        let partyObj = null;
        if (draft.partyId) {
          const pRow = database.prepare(
            'SELECT id, party_type, balance_decimal, advance_balance_decimal, data_json FROM parties WHERE tenant_id = ? AND id = ?'
          ).get(tenantId, String(draft.partyId));
          if (!pRow) throw new FinancialValidationError('العميل أو المورد المحدد غير موجود.');
          partyObj = {
            ...parseRowJson(pRow),
            id: pRow.id,
            type: pRow.party_type,
            balance: unitsToNumber(parseScaledInt(pRow.balance_decimal, MONEY_SCALE, 'pBal'), MONEY_SCALE),
            advanceBalance: unitsToNumber(parseScaledInt(pRow.advance_balance_decimal ?? 0, MONEY_SCALE, 'pAdv'), MONEY_SCALE),
          };
        }
        const partyInvoices = partyObj
          ? filterRecordsByBranchScope(
              database
                .prepare(`SELECT ${INVOICE_SELECT_COLUMNS} FROM invoices WHERE tenant_id = ? AND party_id = ?`)
                .all(tenantId, partyObj.id)
                .map((r) => hydrateInvoiceRow(database, tenantId, r)),
              actor
            )
          : [];
        const reqAccCode = String(draft.accountCode || '').trim();
        const reqAccRow = reqAccCode
          ? database.prepare('SELECT code, is_leaf, data_json FROM accounts WHERE tenant_id = ? AND code = ?').get(tenantId, reqAccCode)
          : null;
        const reqAccIsLeaf = reqAccRow ? reqAccRow.is_leaf === 1 && parseRowJson(reqAccRow).isLeaf !== false : false;

        const effectiveManualAllocations =
          params.manualAllocations !== undefined ? params.manualAllocations : draft.manualAllocations;
        const effectiveOverrideReason =
          params.overrideReason !== undefined ? params.overrideReason : draft.overrideReason;

        const plan = resolveVoucherAccountingPlan({
          voucherType: draft.type,
          voucherMode: draft.voucherMode,
          party: partyObj,
          requestedAccountCode: reqAccCode,
          amount: amountNum,
          openInvoices: partyInvoices,
          manualAllocations: effectiveManualAllocations,
          hasOverridePermission: hasPermission(actor, 'payment:allocation:override'),
          overrideReason: effectiveOverrideReason,
          hasSupplierAdvancePermission: hasPermission(actor, 'supplier:advance:approve'),
          targetAccountIsLeaf: reqAccIsLeaf,
        });

        if (draft.type === 'PAYMENT' && cashBox._balanceUnits < amountUnits) {
          throw new FinancialValidationError(
            `رصيد الصندوق (${cashBox.nameAr}: ${cashBox.balance}) غير كافٍ لصرف مبلغ ${amountNum}.`
          );
        }

        const voucherDate = draft.date || nowIso.split('T')[0];
        const cashBoxAccRow = database.prepare('SELECT code, data_json FROM accounts WHERE tenant_id = ? AND code = ?').get(tenantId, cashBox.accountCode);
        const cashBoxAccName = cashBoxAccRow ? parseRowJson(cashBoxAccRow).nameAr || cashBox.nameAr : cashBox.nameAr;

        ensureCanonicalAccountTx(database, tenantId, SPECIAL_ACCOUNTS.CUSTOMER_ADVANCES);
        ensureCanonicalAccountTx(database, tenantId, SPECIAL_ACCOUNTS.SUPPLIER_ADVANCES);

        const lines = [];
        if (draft.type === 'RECEIPT') {
          lines.push({
            id: randomUUID(),
            accountCode: cashBox.accountCode,
            accountName: cashBoxAccName,
            debit: amountNum,
            credit: 0,
            costCenterId: draft.costCenterId || 'general',
            memo: `سند قبض ${draft.voucherNumber} - ${draft.description}`,
          });
          for (const cLine of plan.creditLines) {
            const acc = ensureCanonicalAccountTx(database, tenantId, cLine.accountCode);
            lines.push({
              id: randomUUID(),
              accountCode: cLine.accountCode,
              accountName: acc.nameAr,
              debit: 0,
              credit: cLine.amount,
              costCenterId: draft.costCenterId || 'general',
              memo: String(draft.description),
            });
          }
        } else {
          for (const dLine of plan.debitLines) {
            const acc = ensureCanonicalAccountTx(database, tenantId, dLine.accountCode);
            lines.push({
              id: randomUUID(),
              accountCode: dLine.accountCode,
              accountName: acc.nameAr,
              debit: dLine.amount,
              credit: 0,
              costCenterId: draft.costCenterId || 'general',
              memo: String(draft.description),
            });
          }
          lines.push({
            id: randomUUID(),
            accountCode: cashBox.accountCode,
            accountName: cashBoxAccName,
            debit: 0,
            credit: amountNum,
            costCenterId: draft.costCenterId || 'general',
            memo: `سند صرف ${draft.voucherNumber} - ${draft.description}`,
          });
        }

        const entryNumber = allocateSequenceTx(database, tenantId, 'JV', targetBranch.code, terminalCode, nowIso);
        const { persisted: journalEntry, linesWithUnits } = insertJournalEntryTx(database, tenantId, {
          id: randomUUID(),
          entryNumber,
          date: voucherDate,
          description: `${draft.type === 'RECEIPT' ? 'سند قبض' : 'سند صرف'} ${draft.voucherNumber}: ${partyObj?.nameAr || draft.partyName || ''} - ${draft.description}`,
          costCenterId: draft.costCenterId || 'general',
          branchId: targetBranch.id,
          lines,
          status: 'POSTED',
          referenceType: 'VOUCHER',
          referenceId: draft.id,
          isAutoGenerated: true,
        });

        const cashDeltaUnits = draft.type === 'RECEIPT' ? amountUnits : -amountUnits;
        updateCashBoxBalanceTx(database, tenantId, cashBox.id, cashDeltaUnits, draft.type === 'PAYMENT');
        for (const line of linesWithUnits) {
          updateAccountBalanceByLineTx(database, tenantId, line.accountCode, line._debitUnits, line._creditUnits);
        }

        const createdAllocations = [];
        for (const alloc of plan.allocations) {
          const invRow = database.prepare(`SELECT ${INVOICE_SELECT_COLUMNS} FROM invoices WHERE tenant_id = ? AND id = ?`).get(tenantId, alloc.invoiceId);
          const invObj = hydrateInvoiceRow(database, tenantId, invRow);
          const allocUnits = parseScaledInt(alloc.allocatedAmount, MONEY_SCALE, 'allocAmount');
          const invReturnedUnits = parseScaledInt(invObj.returnedAmount || 0, MONEY_SCALE, 'invReturned');
          const nextPaidUnits = parseScaledInt(invRow.paid_amount_decimal, MONEY_SCALE, 'invPaid') + allocUnits;
          if (nextPaidUnits + invReturnedUnits > parseScaledInt(invRow.total_decimal, MONEY_SCALE, 'invTotal')) {
            throw new FinancialValidationError(`تجاوز التخصيص صافي المتبقي من الفاتورة (${invObj.invoiceNumber}) بعد المرتجعات.`);
          }
          invObj.paidAmount = unitsToNumber(nextPaidUnits, MONEY_SCALE);
          database.prepare('UPDATE invoices SET paid_amount_decimal = ?, data_json = ? WHERE tenant_id = ? AND id = ?')
            .run(formatScaledInt(nextPaidUnits, MONEY_SCALE), JSON.stringify(invObj), tenantId, invObj.id);

          const allocRow = {
            id: randomUUID(),
            tenantId,
            branchId: targetBranch.id,
            voucherId: draft.id,
            partyId: partyObj.id,
            invoiceId: invObj.id,
            invoiceNumber: invObj.invoiceNumber,
            invoiceDate: invObj.date,
            allocatedAmount: alloc.allocatedAmount,
            allocationMethod: plan.manualOverride ? 'MANUAL' : 'FIFO',
            status: 'ACTIVE',
            createdAt: nowIso,
            createdBy: actor.id,
          };
          createdAllocations.push(allocRow);
          database.prepare(
            `INSERT INTO payment_allocations
              (tenant_id,id,branch_id,voucher_id,advance_transaction_id,party_id,invoice_id,allocated_decimal,allocation_method,status,created_at,created_by,data_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).run(
            tenantId, allocRow.id, allocRow.branchId, allocRow.voucherId, null, allocRow.partyId, allocRow.invoiceId,
            formatScaledInt(allocUnits, MONEY_SCALE), allocRow.allocationMethod, allocRow.status, allocRow.createdAt, allocRow.createdBy, JSON.stringify(allocRow)
          );
          enqueueOutboxTx(database, actor, {
            entityType: 'PAYMENT_ALLOCATION',
            entityId: allocRow.id,
            action: 'CREATE',
            payload: allocRow,
            priority: 4,
            dependsOn: [draft.id, invObj.id],
            idempotencyKey: `${tenantId}_PAYMENT_ALLOCATION_${allocRow.id}_CREATE`,
            branchId: targetBranch.id,
            nowIso,
          });
        }

        if (plan.manualOverride && partyObj) {
          const auditRow = {
            id: randomUUID(),
            tenantId,
            branchId: targetBranch.id,
            voucherId: draft.id,
            partyId: partyObj.id,
            userId: actor.id,
            userName: actor.fullName,
            reason: plan.overrideReason || '',
            previousAllocations: plan.previousFifoAllocations.map((a) => ({ invoiceId: a.invoiceId, invoiceNumber: a.invoiceNumber, allocatedAmount: a.allocatedAmount })),
            newAllocations: plan.allocations.map((a) => ({ invoiceId: a.invoiceId, invoiceNumber: a.invoiceNumber, allocatedAmount: a.allocatedAmount })),
            timestamp: nowIso,
          };
          database.prepare(
            'INSERT INTO allocation_audits (tenant_id,id,branch_id,voucher_id,party_id,user_id,audit_timestamp,data_json) VALUES (?,?,?,?,?,?,?,?)'
          ).run(tenantId, auditRow.id, auditRow.branchId, auditRow.voucherId, auditRow.partyId, auditRow.userId, auditRow.timestamp, JSON.stringify(auditRow));
          enqueueOutboxTx(database, actor, {
            entityType: 'ALLOCATION_AUDIT',
            entityId: auditRow.id,
            action: 'CREATE',
            payload: auditRow,
            priority: 4,
            dependsOn: [draft.id],
            idempotencyKey: `${tenantId}_ALLOCATION_AUDIT_${auditRow.id}_CREATE`,
            branchId: targetBranch.id,
            nowIso,
          });
        }

        let createdAdvanceTx;
        if (partyObj) {
          const debtDeltaUnits = parseScaledInt(plan.partyDebtDelta, MONEY_SCALE, 'partyDebtDelta');
          const advDeltaUnits = parseScaledInt(plan.partyAdvanceDelta, MONEY_SCALE, 'partyAdvanceDelta');
          const updatedParty = updatePartyBalancesTx(database, tenantId, partyObj.id, debtDeltaUnits, advDeltaUnits);
          if (plan.advanceDirection !== 'NONE' && plan.advanceAmount > 0) {
            const txType =
              plan.advanceDirection === 'DEPOSIT_CUSTOMER'
                ? 'OVERPAYMENT_DEPOSIT'
                : plan.advanceDirection === 'DEPOSIT_SUPPLIER'
                ? 'PREPAYMENT_DEPOSIT'
                : 'REFUND';
            const signedAmt =
              plan.advanceDirection === 'REFUND_CUSTOMER' || plan.advanceDirection === 'REFUND_SUPPLIER'
                ? -plan.advanceAmount
                : plan.advanceAmount;
            createdAdvanceTx = {
              id: randomUUID(),
              tenantId,
              branchId: targetBranch.id,
              partyId: partyObj.id,
              partyType: partyObj.type,
              type: txType,
              amount: signedAmt,
              balanceAfter: updatedParty.advanceBalance,
              voucherId: draft.id,
              journalEntryId: journalEntry.id,
              date: voucherDate,
              description: String(draft.description),
              createdBy: actor.id,
              createdAt: nowIso,
            };
            database.prepare(
              `INSERT INTO party_advance_transactions
                (tenant_id,id,branch_id,party_id,party_type,tx_type,amount_decimal,balance_after_decimal,voucher_id,invoice_id,journal_entry_id,tx_date,created_at,data_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
            ).run(
              tenantId, createdAdvanceTx.id, createdAdvanceTx.branchId, createdAdvanceTx.partyId, createdAdvanceTx.partyType,
              createdAdvanceTx.type, formatScaledInt(parseScaledInt(signedAmt, MONEY_SCALE, 'signedAmt'), MONEY_SCALE),
              formatScaledInt(parseScaledInt(updatedParty.advanceBalance, MONEY_SCALE, 'advBalAfter'), MONEY_SCALE),
              createdAdvanceTx.voucherId, null, createdAdvanceTx.journalEntryId, createdAdvanceTx.date, createdAdvanceTx.createdAt, JSON.stringify(createdAdvanceTx)
            );
            enqueueOutboxTx(database, actor, {
              entityType: 'PARTY_ADVANCE',
              entityId: createdAdvanceTx.id,
              action: 'CREATE',
              payload: createdAdvanceTx,
              priority: 4,
              dependsOn: [draft.id],
              idempotencyKey: `${tenantId}_PARTY_ADVANCE_${createdAdvanceTx.id}_CREATE`,
              branchId: targetBranch.id,
              nowIso,
            });
          }
        }

        const persistedVoucher = {
          ...draft,
          branchId: targetBranch.id,
          amount: amountNum,
          date: voucherDate,
          voucherMode: plan.mode === 'GENERAL' ? 'GENERAL' : partyObj?.type === 'CUSTOMER' ? 'CUSTOMER_RECEIPT' : 'SUPPLIER_PAYMENT',
          partyType: partyObj?.type,
          partyName: partyObj?.nameAr || draft.partyName || '',
          accountCode: plan.primaryContraAccountCode,
          journalEntryId: journalEntry.id,
          status: 'POSTED',
          appliedToDebtAmount: plan.appliedToDebtAmount,
          advanceAmount: plan.advanceAmount,
          allocations: createdAllocations,
          manualOverride: plan.manualOverride,
          overrideReason: plan.overrideReason,
        };
        database.prepare('UPDATE vouchers SET data_json = ? WHERE tenant_id = ? AND id = ?')
          .run(JSON.stringify(persistedVoucher), tenantId, persistedVoucher.id);

        enqueueOutboxTx(database, actor, {
          entityType: 'VOUCHER',
          entityId: persistedVoucher.id,
          action: 'UPDATE',
          payload: persistedVoucher,
          priority: 3,
          idempotencyKey: `${tenantId}_VOUCHER_${persistedVoucher.id}_POST`,
          branchId: targetBranch.id,
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
          branchId: targetBranch.id,
          nowIso,
        });
        writeAuditLogTx(
          database,
          { ...actor, branchId: targetBranch.id },
          `ترحيل مسودة سند ${persistedVoucher.type === 'RECEIPT' ? 'قبض' : 'صرف'}`,
          `سند ${persistedVoucher.voucherNumber} بمبلغ ${amountNum} ${currencySymbol}`,
          nowIso
        );

        database.exec('COMMIT');
        return {
          success: true,
          voucher: persistedVoucher,
          journalEntry,
          allocations: createdAllocations,
          advanceTransaction: createdAdvanceTx,
        };
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    cancelCashVoucherAtomic(actor, params) {
      assertPermission(actor, 'voucher:cancel', 'إلغاء مسودة سند');
      const reason = String(params?.reason || '').trim();
      if (!reason) {
        throw new FinancialValidationError('سبب إلغاء مسودة السند مطلوب.');
      }
      if (!params?.voucherId) {
        throw new FinancialValidationError('معرف السند مطلوب.');
      }
      const tenantId = actor.tenantId;
      const nowIso = new Date().toISOString();

      database.exec('BEGIN IMMEDIATE');
      try {
        const row = database.prepare(
          'SELECT tenant_id,id,branch_id,voucher_number,voucher_type,voucher_date,amount_decimal,cash_box_id,party_id,data_json FROM vouchers WHERE tenant_id = ? AND id = ?'
        ).get(tenantId, String(params.voucherId));
        if (!row) {
          throw new FinancialValidationError('السند غير موجود.');
        }
        const voucher = { status: 'POSTED', ...parseRowJson(row), id: row.id, branchId: row.branch_id || '' };
        assertBranchAccess(actor, voucher.branchId || actor.branchId);
        if ((voucher.status || 'POSTED') !== 'DRAFT') {
          throw new FinancialValidationError(
            'لا يجوز إلغاء أو حذف سند مالي مرحّل نهائياً؛ استخدم إجراء العكس المحاسبي الموثق.'
          );
        }

        const cancelled = {
          ...voucher,
          status: 'CANCELLED',
          cancelledReason: reason,
        };
        database.prepare('UPDATE vouchers SET data_json = ? WHERE tenant_id = ? AND id = ?')
          .run(JSON.stringify(cancelled), tenantId, cancelled.id);

        enqueueOutboxTx(database, actor, {
          entityType: 'VOUCHER',
          entityId: cancelled.id,
          action: 'UPDATE',
          payload: cancelled,
          priority: 3,
          idempotencyKey: `${tenantId}_VOUCHER_${cancelled.id}_CANCEL`,
          branchId: voucher.branchId,
          nowIso,
        });
        writeAuditLogTx(
          database,
          { ...actor, branchId: voucher.branchId },
          'إلغاء مسودة سند',
          `إلغاء مسودة ${cancelled.voucherNumber} - السبب: ${reason}`,
          nowIso
        );
        database.exec('COMMIT');
        return cancelled;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    reverseCashVoucherAtomic(actor, params) {
      assertPermission(actor, 'voucher:reverse', 'عكس سند مالي');
      const reason = String(params?.reversalReason || '').trim();
      if (!reason) {
        throw new FinancialValidationError('سبب عكس السند المالي مطلوب لتوثيق سجل التدقيق.');
      }
      if (!params?.voucherId) {
        throw new FinancialValidationError('معرف السند المطلوب عكسه مطلوب.');
      }
      const tenantId = actor.tenantId;
      const terminalCode = getTerminalCodeValue(database, tenantId);
      const nowIso = new Date().toISOString();
      const reversalDate = nowIso.split('T')[0];

      database.exec('BEGIN IMMEDIATE');
      try {
        const vRow = database.prepare(
          'SELECT tenant_id,id,branch_id,voucher_number,voucher_type,voucher_date,amount_decimal,cash_box_id,party_id,data_json FROM vouchers WHERE tenant_id = ? AND id = ?'
        ).get(tenantId, String(params.voucherId));
        if (!vRow) {
          throw new FinancialValidationError('السند المطلوب عكسه غير موجود.');
        }
        const voucher = {
          status: 'POSTED',
          ...parseRowJson(vRow),
          id: vRow.id,
          tenantId: vRow.tenant_id,
          branchId: vRow.branch_id || '',
          voucherNumber: vRow.voucher_number,
          type: vRow.voucher_type,
          date: vRow.voucher_date,
          amount: unitsToNumber(parseScaledInt(vRow.amount_decimal, MONEY_SCALE, 'voucherAmount'), MONEY_SCALE),
          cashBoxId: vRow.cash_box_id,
          partyId: vRow.party_id ?? undefined,
        };
        const voucherBranchId = String(voucher.branchId || '').trim();
        assertBranchAccess(actor, voucherBranchId);
        if ((voucher.status || 'POSTED') !== 'POSTED') {
          throw new FinancialValidationError('يمكن عكس السندات المرحّلة (POSTED) فقط.');
        }
        if (!voucher.journalEntryId) {
          throw new FinancialValidationError('السند لا يرتبط بقيد محاسبي مرحّل.');
        }

        const origJeRow = database.prepare(
          'SELECT tenant_id,id,branch_id,entry_number,entry_date,cost_center_id,status,reference_type,reference_id,data_json FROM journal_entries WHERE tenant_id = ? AND id = ?'
        ).get(tenantId, voucher.journalEntryId);
        if (!origJeRow) {
          throw new FinancialValidationError('القيد المرتبط بهذا السند غير موجود.');
        }
        const originalJe = hydrateJournalEntryRow(database, tenantId, origJeRow);
        if (originalJe.status === 'REVERSED') {
          throw new FinancialValidationError('تم عكس القيد المرتبط بهذا السند مسبقاً.');
        }

        const cashBox = getCashBoxRowTx(database, tenantId, voucher.cashBoxId);
        assertCashBoxBranchAccessTx(actor, cashBox, voucherBranchId);
        const amountUnits = parseScaledInt(voucher.amount, MONEY_SCALE, 'voucher.amount');
        if (voucher.type === 'RECEIPT' && cashBox._balanceUnits < amountUnits) {
          throw new FinancialValidationError(
            `رصيد الصندوق (${cashBox.nameAr}) غير كافٍ لعكس سند القبض بمبلغ ${voucher.amount}.`
          );
        }

        const origBranchRow = database.prepare('SELECT id, code FROM branches WHERE tenant_id = ? AND id = ?').get(tenantId, voucherBranchId);
        const reversalNumber = allocateSequenceTx(database, tenantId, 'REV', origBranchRow?.code || 'BR01', terminalCode, nowIso);
        const reversedLines = originalJe.lines.map((l) => ({
          id: randomUUID(),
          accountCode: l.accountCode,
          accountName: l.accountName,
          debit: l.credit,
          credit: l.debit,
          costCenterId: l.costCenterId,
          memo: `عكس سند ${voucher.voucherNumber}: ${reason}`,
        }));

        const { persisted: reversalEntry, linesWithUnits } = insertJournalEntryTx(database, tenantId, {
          id: randomUUID(),
          entryNumber: reversalNumber,
          date: reversalDate,
          description: `قيد عكسي للسند ${voucher.voucherNumber} (${originalJe.entryNumber}) - السبب: ${reason}`,
          costCenterId: originalJe.costCenterId,
          branchId: voucherBranchId,
          lines: reversedLines,
          status: 'POSTED',
          referenceType: 'VOUCHER_REVERSAL',
          referenceId: voucher.id,
          isAutoGenerated: true,
          reversedEntryId: originalJe.id,
          reversalReason: reason,
        });

        const cashDeltaUnits = voucher.type === 'RECEIPT' ? -amountUnits : amountUnits;
        updateCashBoxBalanceTx(database, tenantId, cashBox.id, cashDeltaUnits, voucher.type === 'RECEIPT');
        for (const line of linesWithUnits) {
          updateAccountBalanceByLineTx(database, tenantId, line.accountCode, line._debitUnits, line._creditUnits);
        }

        const activeAllocs = database.prepare(
          "SELECT tenant_id,id,branch_id,voucher_id,advance_transaction_id,party_id,invoice_id,allocated_decimal,allocation_method,status,created_at,created_by,data_json FROM payment_allocations WHERE tenant_id = ? AND voucher_id = ? AND status = 'ACTIVE'"
        ).all(tenantId, voucher.id);
        for (const aRow of activeAllocs) {
          const allocUnits = parseScaledInt(aRow.allocated_decimal, MONEY_SCALE, 'allocUnits');
          const invRow = database.prepare(`SELECT ${INVOICE_SELECT_COLUMNS} FROM invoices WHERE tenant_id = ? AND id = ?`).get(tenantId, aRow.invoice_id);
          if (invRow) {
            const invObj = hydrateInvoiceRow(database, tenantId, invRow);
            const curPaid = parseScaledInt(invRow.paid_amount_decimal, MONEY_SCALE, 'invPaid');
            const nextPaid = curPaid > allocUnits ? curPaid - allocUnits : 0n;
            invObj.paidAmount = unitsToNumber(nextPaid, MONEY_SCALE);
            database.prepare('UPDATE invoices SET paid_amount_decimal = ?, data_json = ? WHERE tenant_id = ? AND id = ?')
              .run(formatScaledInt(nextPaid, MONEY_SCALE), JSON.stringify(invObj), tenantId, invObj.id);
          }
          const allocObj = { ...parseRowJson(aRow), id: aRow.id, status: 'REVERSED' };
          database.prepare("UPDATE payment_allocations SET status = 'REVERSED', data_json = ? WHERE tenant_id = ? AND id = ?")
            .run(JSON.stringify(allocObj), tenantId, aRow.id);
          enqueueOutboxTx(database, actor, {
            entityType: 'PAYMENT_ALLOCATION',
            entityId: allocObj.id,
            action: 'UPDATE',
            payload: allocObj,
            priority: 4,
            idempotencyKey: `${tenantId}_PAYMENT_ALLOCATION_${allocObj.id}_REVERSED`,
            branchId: voucherBranchId,
            nowIso,
          });
        }

        const advTxRows = database.prepare(
          "SELECT tenant_id,id,amount_decimal,data_json FROM party_advance_transactions WHERE tenant_id = ? AND voucher_id = ? AND tx_type <> 'REVERSAL'"
        ).all(tenantId, voucher.id);

        if (voucher.partyId) {
          const pRow = database.prepare(
            'SELECT id, party_type, balance_decimal, advance_balance_decimal, data_json FROM parties WHERE tenant_id = ? AND id = ?'
          ).get(tenantId, voucher.partyId);
          if (pRow) {
            let netOrigAdvUnits = 0n;
            for (const txR of advTxRows) {
              netOrigAdvUnits += parseScaledInt(txR.amount_decimal, MONEY_SCALE, 'advTxAmt');
            }
            const currentAdvUnits = parseScaledInt(pRow.advance_balance_decimal ?? 0, MONEY_SCALE, 'partyAdv');
            const nextAdvUnits = currentAdvUnits - netOrigAdvUnits;
            if (nextAdvUnits < 0n) {
              throw new FinancialValidationError(
                'لا يمكن عكس هذا السند لأن الرصيد المقدم الناتج عنه قد استُخدم بالفعل في فواتير أو رد نقدي لاحق.'
              );
            }

            let debtRestoreUnits = 0n;
            if (voucher.appliedToDebtAmount !== undefined) {
              const appliedUnits = parseScaledInt(voucher.appliedToDebtAmount, MONEY_SCALE, 'appliedDebt');
              if (pRow.party_type === 'CUSTOMER' && voucher.type === 'RECEIPT') debtRestoreUnits = appliedUnits;
              else if (pRow.party_type === 'SUPPLIER' && voucher.type === 'PAYMENT') debtRestoreUnits = -appliedUnits;
            } else if (activeAllocs.length === 0 && advTxRows.length === 0) {
              debtRestoreUnits = voucher.type === 'RECEIPT' ? amountUnits : -amountUnits;
            }

            const updatedParty = updatePartyBalancesTx(database, tenantId, pRow.id, debtRestoreUnits, -netOrigAdvUnits);

            if (netOrigAdvUnits !== 0n) {
              const revAdvAmt = unitsToNumber(-netOrigAdvUnits, MONEY_SCALE);
              const revAdvTx = {
                id: randomUUID(),
                tenantId,
                branchId: voucherBranchId,
                partyId: pRow.id,
                partyType: pRow.party_type,
                type: 'REVERSAL',
                amount: revAdvAmt,
                balanceAfter: updatedParty.advanceBalance,
                voucherId: voucher.id,
                journalEntryId: reversalEntry.id,
                date: reversalDate,
                description: `عكس رصيد مقدم لسند ${voucher.voucherNumber}: ${reason}`,
                createdBy: actor.id,
                createdAt: nowIso,
              };
              database.prepare(
                `INSERT INTO party_advance_transactions
                  (tenant_id,id,branch_id,party_id,party_type,tx_type,amount_decimal,balance_after_decimal,voucher_id,invoice_id,journal_entry_id,tx_date,created_at,data_json)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
              ).run(
                tenantId, revAdvTx.id, revAdvTx.branchId, revAdvTx.partyId, revAdvTx.partyType,
                revAdvTx.type, formatScaledInt(-netOrigAdvUnits, MONEY_SCALE),
                formatScaledInt(parseScaledInt(updatedParty.advanceBalance, MONEY_SCALE, 'advBalAfter'), MONEY_SCALE),
                revAdvTx.voucherId, null, revAdvTx.journalEntryId, revAdvTx.date, revAdvTx.createdAt, JSON.stringify(revAdvTx)
              );
              enqueueOutboxTx(database, actor, {
                entityType: 'PARTY_ADVANCE',
                entityId: revAdvTx.id,
                action: 'CREATE',
                payload: revAdvTx,
                priority: 4,
                idempotencyKey: `${tenantId}_PARTY_ADVANCE_${revAdvTx.id}_CREATE`,
                branchId: voucherBranchId,
                nowIso,
              });
            }
          }
        }

        const updatedOriginalJe = {
          ...originalJe,
          status: 'REVERSED',
          reversalReason: reason,
          reversedEntryId: reversalEntry.id,
        };
        database.prepare('UPDATE journal_entries SET status = ?, data_json = ? WHERE tenant_id = ? AND id = ?')
          .run('REVERSED', JSON.stringify(updatedOriginalJe), tenantId, originalJe.id);

        const reversedVoucher = {
          ...voucher,
          status: 'REVERSED',
          reversedByJournalId: reversalEntry.id,
          reversalReason: reason,
        };
        database.prepare('UPDATE vouchers SET data_json = ? WHERE tenant_id = ? AND id = ?')
          .run(JSON.stringify(reversedVoucher), tenantId, reversedVoucher.id);

        enqueueOutboxTx(database, actor, {
          entityType: 'VOUCHER',
          entityId: reversedVoucher.id,
          action: 'UPDATE',
          payload: reversedVoucher,
          priority: 3,
          idempotencyKey: `${tenantId}_VOUCHER_${reversedVoucher.id}_REVERSED`,
          branchId: voucherBranchId,
          nowIso,
        });
        enqueueOutboxTx(database, actor, {
          entityType: 'JOURNAL_ENTRY',
          entityId: reversalEntry.id,
          action: 'CREATE',
          payload: reversalEntry,
          priority: 4,
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${reversalEntry.id}_CREATE`,
          branchId: voucherBranchId,
          nowIso,
        });
        enqueueOutboxTx(database, actor, {
          entityType: 'JOURNAL_ENTRY',
          entityId: updatedOriginalJe.id,
          action: 'UPDATE',
          payload: updatedOriginalJe,
          priority: 4,
          idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${updatedOriginalJe.id}_REVERSED`,
          branchId: voucherBranchId,
          nowIso,
        });
        writeAuditLogTx(
          database,
          { ...actor, branchId: voucherBranchId },
          'عكس سند مالي',
          `عكس السند ${reversedVoucher.voucherNumber} بقيد ${reversalEntry.entryNumber} - السبب: ${reason}`,
          nowIso
        );

        database.exec('COMMIT');
        return {
          success: true,
          voucher: reversedVoucher,
          reversalJournalEntry: reversalEntry,
        };
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
      const requestedCashBoxId = params.cashBoxId || rawRecord.cashBoxId;

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
          cashBox = requestedCashBoxId
            ? getCashBoxRowTx(database, tenantId, requestedCashBoxId)
            : resolveBranchDefaultCashBoxTx(database, tenantId, branchId);
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
        const amtNum = record.type === 'CASH' ? unitsToNumber(amountUnits, MONEY_SCALE) : 0;
        const persistedRecord = {
          ...record,
          tenantId,
          branchId,
          status: 'HELD',
          receivedDate,
          cashBoxId: record.type === 'CASH' ? cashBox.id : undefined,
          amount: amtNum,
          returnedAmount: 0,
          remainingAmount: amtNum,
          returnHistory: [],
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
          nowIso,
          {
            entityType: 'AMANAT',
            entityId: persistedRecord.id,
            newValue: { status: persistedRecord.status, amount: persistedRecord.amount },
            result: 'SUCCESS',
          }
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

        const totalUnits = parseScaledInt(record.amount, MONEY_SCALE, 'amanat.amount');
        const alreadyRetUnits = parseScaledInt(record.returnedAmount ?? 0, MONEY_SCALE, 'amanat.returnedAmount');
        const remBeforeUnits = record.remainingAmount !== undefined
          ? parseScaledInt(record.remainingAmount, MONEY_SCALE, 'amanat.remainingAmount')
          : (totalUnits > alreadyRetUnits ? totalUnits - alreadyRetUnits : 0n);

        let effectiveRetUnits = 0n;
        let cashBox;
        if (record.type === 'CASH') {
          if (remBeforeUnits <= 0n) {
            throw new FinancialValidationError('تم رد كامل قيمة هذه الأمانة مسبقاً.');
          }
          effectiveRetUnits = params.returnAmount !== undefined
            ? parseScaledInt(params.returnAmount, MONEY_SCALE, 'returnAmount')
            : remBeforeUnits;
          if (effectiveRetUnits <= 0n) {
            throw new FinancialValidationError('مبلغ الرد يجب أن يكون أكبر من الصفر.');
          }
          if (effectiveRetUnits > remBeforeUnits) {
            throw new FinancialValidationError(
              `مبلغ الرد المطلوب (${unitsToNumber(effectiveRetUnits, MONEY_SCALE)}) يتجاوز الرصيد المتبقي للأمانة (${unitsToNumber(remBeforeUnits, MONEY_SCALE)}).`
            );
          }
          const reqBoxId = params.cashBoxId || record.cashBoxId;
          cashBox = reqBoxId
            ? getCashBoxRowTx(database, tenantId, reqBoxId)
            : resolveBranchDefaultCashBoxTx(database, tenantId, recordBranchId);
          if (!cashBox) {
            throw new FinancialValidationError('الصندوق النقدي المحدد لرد الأمانة غير موجود.');
          }
          assertCashBoxBranchAccessTx(actor, cashBox, recordBranchId);
          if (cashBox._balanceUnits < effectiveRetUnits) {
            throw new FinancialValidationError(
              `رصيد الصندوق (${cashBox.nameAr}: ${cashBox.balance}) غير كافٍ لرد مبلغ الأمانة (${unitsToNumber(effectiveRetUnits, MONEY_SCALE)}).`
            );
          }
        }

        const nextReturnedUnits = record.type === 'CASH' ? alreadyRetUnits + effectiveRetUnits : 0n;
        const nextRemainingUnits = record.type === 'CASH'
          ? (remBeforeUnits > effectiveRetUnits ? remBeforeUnits - effectiveRetUnits : 0n)
          : 0n;
        const isFullReturn = record.type === 'ITEM' || nextRemainingUnits === 0n;

        const effectiveRetNum = unitsToNumber(effectiveRetUnits, MONEY_SCALE);
        const nextReturnedNum = unitsToNumber(nextReturnedUnits, MONEY_SCALE);
        const nextRemainingNum = unitsToNumber(nextRemainingUnits, MONEY_SCALE);

        let returnEntry;
        const eventId = randomUUID();
        if (record.type === 'CASH') {
          const amanatAccRow = database.prepare('SELECT code FROM accounts WHERE tenant_id = ? AND code = ?').get(tenantId, '2102');
          if (!amanatAccRow) {
            throw new FinancialValidationError('حساب الأمانات للغير (2102) غير موجود.');
          }

          const updatedBox = updateCashBoxBalanceTx(database, tenantId, cashBox.id, -effectiveRetUnits, true);
          const boxAcc = updateAccountBalanceTx(database, tenantId, cashBox.accountCode, -effectiveRetUnits);
          const amanatAcc = updateAccountBalanceTx(database, tenantId, '2102', -effectiveRetUnits);

          const entryNumber = allocateSequenceTx(database, tenantId, 'JV', branchRow.code || 'BR01', terminalCode, nowIso);
          const jeResult = insertJournalEntryTx(database, tenantId, {
            id: randomUUID(),
            entryNumber,
            date: todayStr,
            description: `${isFullReturn ? 'رد وتسليم' : 'رد جزئي لأمانة'} أمانة نقدية رقم ${record.recordNumber} - ${record.depositorName}`,
            costCenterId: 'general',
            branchId: recordBranchId,
            lines: [
              {
                id: randomUUID(),
                accountCode: '2102',
                accountName: amanatAcc?.nameAr || 'أمانات وعهد نقدية للغير',
                debit: effectiveRetNum,
                credit: 0,
                costCenterId: 'general',
                memo: `تسوية وإبراء جزء من أمانة رقم ${record.recordNumber}`,
              },
              {
                id: randomUUID(),
                accountCode: cashBox.accountCode,
                accountName: boxAcc?.nameAr || updatedBox.nameAr,
                debit: 0,
                credit: effectiveRetNum,
                costCenterId: 'general',
                memo: `صرف رد أمانة رقم ${record.recordNumber}`,
              },
            ],
            status: 'POSTED',
            referenceType: 'AMANAT',
            referenceId: record.id,
            isAutoGenerated: true,
          });
          returnEntry = jeResult.persisted;
        }

        const returnEvent = {
          id: eventId,
          date: todayStr,
          amount: effectiveRetNum,
          cashBoxId: cashBox?.id,
          journalEntryId: returnEntry?.id,
          recipientSignatureName: params.recipientSignatureName || record.depositorName,
          notes: params.notes ? String(params.notes).trim() : undefined,
          createdBy: actor.id,
          createdByName: actor.fullName,
        };

        const updatedRecord = {
          ...record,
          branchId: recordBranchId,
          status: isFullReturn ? 'RETURNED' : 'HELD',
          returnedAmount: nextReturnedNum,
          remainingAmount: nextRemainingNum,
          returnHistory: [...(Array.isArray(record.returnHistory) ? record.returnHistory : []), returnEvent],
          returnedDate: isFullReturn ? todayStr : record.returnedDate,
          recipientSignatureName: params.recipientSignatureName || record.recipientSignatureName || record.depositorName,
          returnJournalEntryId: returnEntry?.id || record.returnJournalEntryId,
        };

        database.prepare(
          'UPDATE amanat_records SET status = ?, data_json = ? WHERE tenant_id = ? AND id = ?'
        ).run(updatedRecord.status, JSON.stringify(updatedRecord), tenantId, updatedRecord.id);

        enqueueOutboxTx(database, actor, {
          entityType: 'AMANAT',
          entityId: updatedRecord.id,
          action: 'UPDATE',
          payload: updatedRecord,
          priority: 3,
          idempotencyKey: `${tenantId}_AMANAT_${updatedRecord.id}_RETURN_${eventId}`,
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
          isFullReturn ? 'رد وتسليم أمانة' : 'رد جزئي لأمانة',
          `سند أمانة رقم ${updatedRecord.recordNumber} للمودع ${updatedRecord.depositorName} (المبلغ المردود: ${effectiveRetNum}، المتبقي: ${nextRemainingNum})`,
          nowIso,
          {
            entityType: 'AMANAT',
            entityId: updatedRecord.id,
            previousValue: {
              status: record.status,
              returnedAmount: unitsToNumber(alreadyRetUnits, MONEY_SCALE),
              remainingAmount: unitsToNumber(remBeforeUnits, MONEY_SCALE),
            },
            newValue: {
              status: updatedRecord.status,
              returnedAmount: nextReturnedNum,
              remainingAmount: nextRemainingNum,
            },
            reason: params.notes ? String(params.notes).trim() : 'رد أمانة',
            result: 'SUCCESS',
          }
        );

        database.exec('COMMIT');
        return { success: true, record: updatedRecord, journalEntry: returnEntry };
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    cancelAmanatAtomic(actor, params) {
      if (!params || typeof params !== 'object' || !params.recordId) {
        throw new FinancialValidationError('معرف سجل الأمانة مطلوب.');
      }
      assertPermission(actor, 'amanat:manage', 'إلغاء أمانة');
      const cleanReason = String(params.reason || '').trim();
      if (!cleanReason) {
        throw new FinancialValidationError('سبب إلغاء الأمانة مطلوب لتوثيق سجل التدقيق.');
      }

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
        const branchRow = database.prepare('SELECT id, code FROM branches WHERE tenant_id = ? AND id = ?').get(tenantId, recordBranchId);
        if (!branchRow) {
          throw new FinancialValidationError('فرع سجل الأمانة غير موجود.');
        }

        if (record.status !== 'HELD') {
          throw new FinancialValidationError('لا يمكن إلغاء أمانة ليست في حالة الحفظ (HELD).');
        }
        const alreadyRetUnits = parseScaledInt(record.returnedAmount ?? 0, MONEY_SCALE, 'amanat.returnedAmount');
        if (record.type === 'CASH' && alreadyRetUnits > 0n) {
          throw new FinancialValidationError(
            'لا يمكن إلغاء أمانة تم رد جزء منها مسبقاً؛ يرجى إكمال رد المبلغ المتبقي فقط.'
          );
        }

        let cancelEntry;
        if (record.type === 'CASH') {
          const amountUnits = parseScaledInt(record.amount, MONEY_SCALE, 'amanat.amount');
          const cashBox = record.cashBoxId
            ? getCashBoxRowTx(database, tenantId, record.cashBoxId)
            : resolveBranchDefaultCashBoxTx(database, tenantId, recordBranchId);
          assertCashBoxBranchAccessTx(actor, cashBox, recordBranchId);
          if (cashBox._balanceUnits < amountUnits) {
            throw new FinancialValidationError(
              `رصيد الصندوق (${cashBox.nameAr}: ${cashBox.balance}) غير كافٍ لعكس وإلغاء الأمانة النقدية (${record.amount}).`
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
            description: `إلغاء وعكس أمانة نقدية رقم ${record.recordNumber} - ${cleanReason}`,
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
                memo: `عكس التزام أمانة ملغاة رقم ${record.recordNumber}`,
              },
              {
                id: randomUUID(),
                accountCode: cashBox.accountCode,
                accountName: boxAcc?.nameAr || updatedBox.nameAr,
                debit: 0,
                credit: amtNum,
                costCenterId: 'general',
                memo: `عكس إيداع أمانة ملغاة رقم ${record.recordNumber}`,
              },
            ],
            status: 'POSTED',
            referenceType: 'AMANAT',
            referenceId: record.id,
            isAutoGenerated: true,
          });
          cancelEntry = jeResult.persisted;
        }

        const updatedRecord = {
          ...record,
          branchId: recordBranchId,
          status: 'CANCELLED',
          remainingAmount: 0,
          cancelledDate: todayStr,
          cancelledReason: cleanReason,
          returnJournalEntryId: cancelEntry?.id || record.returnJournalEntryId,
        };

        database.prepare(
          'UPDATE amanat_records SET status = ?, data_json = ? WHERE tenant_id = ? AND id = ?'
        ).run('CANCELLED', JSON.stringify(updatedRecord), tenantId, updatedRecord.id);

        enqueueOutboxTx(database, actor, {
          entityType: 'AMANAT',
          entityId: updatedRecord.id,
          action: 'UPDATE',
          payload: updatedRecord,
          priority: 3,
          idempotencyKey: `${tenantId}_AMANAT_${updatedRecord.id}_CANCEL`,
          branchId: recordBranchId,
          nowIso,
        });
        if (cancelEntry) {
          enqueueOutboxTx(database, actor, {
            entityType: 'JOURNAL_ENTRY',
            entityId: cancelEntry.id,
            action: 'CREATE',
            payload: cancelEntry,
            priority: 4,
            dependsOn: [updatedRecord.id],
            idempotencyKey: `${tenantId}_JOURNAL_ENTRY_${cancelEntry.id}_CREATE`,
            branchId: recordBranchId,
            nowIso,
          });
        }
        writeAuditLogTx(
          database,
          { ...actor, branchId: recordBranchId },
          'إلغاء أمانة',
          `إلغاء أمانة رقم ${updatedRecord.recordNumber} للمودع ${updatedRecord.depositorName} — السبب: ${cleanReason}`,
          nowIso,
          {
            entityType: 'AMANAT',
            entityId: updatedRecord.id,
            previousValue: { status: record.status, amount: record.amount },
            newValue: { status: 'CANCELLED', cancelledDate: todayStr },
            reason: cleanReason,
            result: 'SUCCESS',
          }
        );

        database.exec('COMMIT');
        return { success: true, record: updatedRecord, journalEntry: cancelEntry };
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

        const resolvedInputLines = [];
        for (const rawLine of Array.isArray(entry.lines) ? entry.lines : []) {
          const requestedCashBoxId = rawLine?.cashBoxId ? String(rawLine.cashBoxId).trim() : '';
          const linkedBoxes = database.prepare(
            'SELECT id, branch_id, account_code, data_json FROM cash_boxes WHERE tenant_id = ? AND account_code = ?'
          ).all(tenantId, String(rawLine?.accountCode || '').trim());

          let targetBox = null;
          if (requestedCashBoxId) {
            targetBox = getCashBoxRowTx(database, tenantId, requestedCashBoxId);
            if (targetBox.accountCode !== String(rawLine.accountCode || '').trim()) {
              throw new FinancialValidationError(
                `الصندوق (${targetBox.nameAr}) مرتبط بالحساب ${targetBox.accountCode} وليس بالحساب ${rawLine.accountCode}.`
              );
            }
            assertCashBoxBranchAccessTx(actor, targetBox, branchId);
          } else if (linkedBoxes.length > 0) {
            const branchBoxes = linkedBoxes.filter((b) => {
              const parsed = parseRowJson(b);
              return b.branch_id === branchId || Boolean(parsed.isCentral);
            });
            if (branchBoxes.length !== 1) {
              throw new FinancialValidationError(
                `يرجى تحديد الصندوق الفعلي في سطر الحساب النقدي (${rawLine.accountCode})؛ يتطلب القيد النقدي تحديد صندوق واحد صريح.`
              );
            }
            targetBox = getCashBoxRowTx(database, tenantId, branchBoxes[0].id);
            assertCashBoxBranchAccessTx(actor, targetBox, branchId);
          }

          resolvedInputLines.push({
            ...rawLine,
            ...(targetBox ? { cashBoxId: targetBox.id } : {}),
          });
        }

        const { persisted, linesWithUnits } = insertJournalEntryTx(database, tenantId, {
          ...entry,
          id: entry.id || randomUUID(),
          entryNumber,
          date: entry.date || nowIso.split('T')[0],
          branchId,
          lines: resolvedInputLines,
          status: 'POSTED',
          referenceType: 'MANUAL',
          isAutoGenerated: false,
        });

        for (const line of linesWithUnits) {
          updateAccountBalanceByLineTx(database, tenantId, line.accountCode, line._debitUnits, line._creditUnits);
          const cashDeltaUnits = line._debitUnits - line._creditUnits;
          if (line.cashBoxId) {
            updateCashBoxBalanceTx(database, tenantId, line.cashBoxId, cashDeltaUnits, true);
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

        const reversedLines = [];
        for (const l of original.lines) {
          let resolvedCashBoxId = l.cashBoxId ? String(l.cashBoxId).trim() : '';
          const linkedBoxes = database.prepare(
            'SELECT id, branch_id, account_code, data_json FROM cash_boxes WHERE tenant_id = ? AND account_code = ?'
          ).all(tenantId, l.accountCode);
          if (resolvedCashBoxId) {
            const box = getCashBoxRowTx(database, tenantId, resolvedCashBoxId);
            assertCashBoxBranchAccessTx(actor, box, originalBranchId);
          } else if (linkedBoxes.length > 0) {
            const branchBoxes = linkedBoxes.filter((b) => {
              const parsed = parseRowJson(b);
              return b.branch_id === originalBranchId || Boolean(parsed.isCentral);
            });
            if (branchBoxes.length !== 1) {
              throw new FinancialValidationError(
                `لا يمكن عكس القيد بأمان: حساب الصندوق (${l.accountCode}) لا يرتبط بصندوق واحد محدد في الفرع الأصلي.`
              );
            }
            const box = getCashBoxRowTx(database, tenantId, branchBoxes[0].id);
            assertCashBoxBranchAccessTx(actor, box, originalBranchId);
            resolvedCashBoxId = box.id;
          }
          reversedLines.push({
            id: randomUUID(),
            accountCode: l.accountCode,
            accountName: l.accountName,
            debit: l.credit,
            credit: l.debit,
            costCenterId: l.costCenterId,
            ...(resolvedCashBoxId ? { cashBoxId: resolvedCashBoxId } : {}),
            memo: `عكس لقيد ${original.entryNumber}: ${reason}`,
          });
        }

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
          updateAccountBalanceByLineTx(database, tenantId, line.accountCode, line._debitUnits, line._creditUnits);
          const cashDeltaUnits = line._debitUnits - line._creditUnits;
          if (line.cashBoxId) {
            updateCashBoxBalanceTx(database, tenantId, line.cashBoxId, cashDeltaUnits, true);
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
