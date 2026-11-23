import { randomUUID } from 'node:crypto';
import { assertBranchAccess } from '../rbac.mjs';
import {
  formatScaledInt,
  MONEY_SCALE,
  parseScaledInt,
  unitsToNumber,
} from '../money.mjs';
import { INITIAL_CHART_OF_ACCOUNTS } from '../seed-data.mjs';
import { getAppSetting, parseRowJson } from './core-service.mjs';

export const ACTIVITY_INVENTORY_ACCOUNTS = {
  pharmacy: '11041',
  grocery: '11042',
  bike_parts: '11043',
  equipment_parts: '11044',
};

export class FinancialValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FinancialValidationError';
    this.code = 'FINANCIAL_VALIDATION_ERROR';
  }
}

export function getTerminalCodeValue(database, tenantId) {
  const saved = getAppSetting(database, tenantId, 'terminal_code', 'POS01');
  return typeof saved === 'string' && saved.trim() ? saved.trim() : 'POS01';
}

export function resolveBranchTx(database, core, actor, requestedBranchId) {
  let candidate = requestedBranchId && String(requestedBranchId).trim()
    ? String(requestedBranchId).trim()
    : '';
  if (!candidate) {
    if (core && typeof core.getActiveBranchId === 'function') {
      candidate = core.getActiveBranchId(actor);
    } else {
      const saved = getAppSetting(database, actor.tenantId, 'active_branch_id', null);
      candidate = typeof saved === 'string' && saved.trim()
        ? saved.trim()
        : actor.branchId || 'branch_main';
    }
  }
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

export function accountBalanceDeltaUnitsByType(accountType, debitUnits, creditUnits) {
  if (accountType === 'LIABILITY' || accountType === 'EQUITY' || accountType === 'REVENUE') {
    return creditUnits - debitUnits;
  }
  return debitUnits - creditUnits;
}

export function ensureCanonicalAccountTx(database, tenantId, accountCode) {
  const existing = database.prepare(
    'SELECT code, account_type, is_leaf, balance_decimal, data_json FROM accounts WHERE tenant_id = ? AND code = ?'
  ).get(tenantId, accountCode);
  if (existing) {
    const parsed = parseRowJson(existing);
    return {
      ...parsed,
      code: existing.code,
      type: existing.account_type || parsed.type,
      isLeaf: existing.is_leaf === 1 && parsed.isLeaf !== false,
    };
  }
  const template = INITIAL_CHART_OF_ACCOUNTS.find((a) => a.code === accountCode);
  if (!template) return null;
  if (template.parentCode) {
    ensureCanonicalAccountTx(database, tenantId, template.parentCode);
  }
  const accObj = { ...template, balance: 0, tenantId };
  database.prepare(
    'INSERT OR IGNORE INTO accounts (tenant_id,code,account_type,parent_code,is_leaf,balance_decimal,data_json) VALUES (?,?,?,?,?,?,?)'
  ).run(
    tenantId,
    accObj.code,
    accObj.type,
    accObj.parentCode ?? null,
    accObj.isLeaf ? 1 : 0,
    '0.00',
    JSON.stringify(accObj)
  );
  return accObj;
}

export function updateAccountBalanceByLineTx(database, tenantId, accountCode, debitUnits, creditUnits) {
  const row = database.prepare(
    'SELECT code, account_type, balance_decimal, data_json FROM accounts WHERE tenant_id = ? AND code = ?'
  ).get(tenantId, accountCode);
  if (!row) return null;
  const parsed = parseRowJson(row);
  const accType = row.account_type || parsed.type || 'ASSET';
  const deltaUnits = accountBalanceDeltaUnitsByType(accType, debitUnits, creditUnits);
  const currentUnits = parseScaledInt(row.balance_decimal, MONEY_SCALE, `accountBalance(${accountCode})`);
  const nextUnits = currentUnits + deltaUnits;
  const nextNum = unitsToNumber(nextUnits, MONEY_SCALE);
  const nextDec = formatScaledInt(nextUnits, MONEY_SCALE);
  parsed.code = row.code;
  parsed.balance = nextNum;
  database.prepare(
    'UPDATE accounts SET balance_decimal = ?, data_json = ? WHERE tenant_id = ? AND code = ?'
  ).run(nextDec, JSON.stringify(parsed), tenantId, accountCode);
  return { ...parsed, balance: nextNum };
}

export function validateAndBuildJournalLines(database, tenantId, lines) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new FinancialValidationError('يجب أن يحتوي القيد على طرفين على الأقل (طرف مدين وطرف دائن).');
  }
  const accountRows = database.prepare('SELECT code, is_leaf, data_json FROM accounts WHERE tenant_id = ?').all(tenantId);
  const validMap = new Map(
    accountRows.map((r) => {
      const parsed = parseRowJson(r);
      return [r.code, { ...parsed, _isLeaf: r.is_leaf === 1 && parsed.isLeaf !== false }];
    })
  );

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
    if (!accountObj._isLeaf) {
      throw new FinancialValidationError(`لا يجوز القيد على الحساب التجميعي غير الفرعي (${accountCode}).`);
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

export function insertJournalEntryTx(database, tenantId, entry) {
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
