import { randomUUID } from 'node:crypto';
import {
  assertBranchAccess,
  assertPermission,
  filterAuditLogsForUser,
  filterRecordsByBranchScope,
  getAuthorizedBranchIds,
} from '../rbac.mjs';
import { formatScaledInt, MONEY_SCALE, parseScaledInt, unitsToNumber } from '../money.mjs';
import { DEFAULT_COMPANY_PROFILE, OFFICIAL_ACTIVITIES } from '../seed-data.mjs';

const VALID_ACCOUNT_TYPES = new Set(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']);

export function parseRowJson(row, fallback = {}) {
  if (!row || !row.data_json) return { ...fallback };
  return JSON.parse(row.data_json);
}

export function writeAuditLogTx(database, actor, action, details, nowIso = new Date().toISOString()) {
  const id = randomUUID();
  const tenantId = actor?.tenantId || 'tenant_main';
  const branchId = actor?.branchId || 'branch_main';
  const entry = {
    id,
    tenantId,
    branchId,
    timestamp: nowIso,
    userId: actor?.id || 'system',
    userName: actor?.fullName || actor?.username || 'النظام',
    action: String(action || ''),
    details: String(details || ''),
  };
  database.prepare(
    'INSERT INTO audit_logs (tenant_id,id,branch_id,timestamp,user_id,action,details,data_json) VALUES (?,?,?,?,?,?,?,?)'
  ).run(tenantId, id, branchId, entry.timestamp, entry.userId, entry.action, entry.details, JSON.stringify(entry));
  return entry;
}

export function enqueueOutboxTx(database, actor, {
  entityType,
  entityId,
  action,
  payload,
  priority = 3,
  dependsOn,
  idempotencyKey,
  branchId,
  nowIso = new Date().toISOString(),
}) {
  const tenantId = actor?.tenantId || 'tenant_main';
  const resolvedBranchId = branchId || actor?.branchId || 'branch_main';
  const key = idempotencyKey || `${entityType}:${entityId}:${action}`;
  const safePayload = payload && typeof payload === 'object' ? { ...payload } : {};
  delete safePayload.passwordHash;

  const cleanDependsOn = Array.isArray(dependsOn) && dependsOn.length > 0
    ? [...new Set(dependsOn.map((d) => String(d).trim()).filter(Boolean))]
    : undefined;

  const existing = database.prepare(
    'SELECT id, status, data_json FROM outbox_queue WHERE tenant_id = ? AND idempotency_key = ?'
  ).get(tenantId, key);
  if (existing) {
    if (existing.status !== 'SYNCED') {
      let existingObj = {};
      try { existingObj = JSON.parse(existing.data_json); } catch {}
      const updatedItem = {
        ...existingObj,
        id: existing.id,
        tenantId,
        branchId: resolvedBranchId,
        entityType,
        entityId,
        action,
        payload: safePayload,
        priority: Number.isFinite(priority) ? priority : (existingObj.priority || 3),
        ...(cleanDependsOn ? { dependsOn: cleanDependsOn } : {}),
      };
      database.prepare(
        'UPDATE outbox_queue SET branch_id = ?, priority = ?, payload_json = ?, data_json = ? WHERE tenant_id = ? AND id = ?'
      ).run(
        resolvedBranchId,
        updatedItem.priority,
        JSON.stringify(safePayload),
        JSON.stringify(updatedItem),
        tenantId,
        existing.id
      );
    }
    return existing.id;
  }

  const id = randomUUID();
  const item = {
    id,
    tenantId,
    branchId: resolvedBranchId,
    entityType,
    entityId,
    action,
    payload: safePayload,
    createdAt: nowIso,
    status: 'PENDING',
    idempotencyKey: key,
    retryCount: 0,
    priority,
    ...(cleanDependsOn ? { dependsOn: cleanDependsOn } : {}),
  };
  database.prepare(
    'INSERT INTO outbox_queue (tenant_id,id,branch_id,entity_type,entity_id,action,status,idempotency_key,retry_count,priority,created_at,next_retry_at,lease_owner,lease_expires_at,payload_json,data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    tenantId,
    id,
    resolvedBranchId,
    entityType,
    entityId,
    action,
    'PENDING',
    key,
    0,
    priority,
    nowIso,
    null,
    null,
    null,
    JSON.stringify(safePayload),
    JSON.stringify(item)
  );
  return id;
}

export function allocateSequenceTx(database, tenantId, type, branchCode, terminalCode, nowIso = new Date().toISOString()) {
  const year = new Date(nowIso).getFullYear();
  const safeBranchCode = String(branchCode || 'BR01').trim() || 'BR01';
  const safeTermCode = String(terminalCode || 'POS01').trim() || 'POS01';
  const sequenceKey = `${tenantId}:${safeBranchCode}:${safeTermCode}:${type}:${year}`;

  const existing = database.prepare(
    'SELECT last_seq FROM document_sequences WHERE tenant_id = ? AND sequence_key = ?'
  ).get(tenantId, sequenceKey);
  const nextSeq = (existing ? Number(existing.last_seq) : 0) + 1;

  if (existing) {
    database.prepare(
      'UPDATE document_sequences SET last_seq = ?, updated_at = ? WHERE tenant_id = ? AND sequence_key = ?'
    ).run(nextSeq, nowIso, tenantId, sequenceKey);
  } else {
    database.prepare(
      'INSERT INTO document_sequences (tenant_id,sequence_key,last_seq,updated_at) VALUES (?,?,?,?)'
    ).run(tenantId, sequenceKey, nextSeq, nowIso);
  }

  return `${type}-${safeBranchCode}-${safeTermCode}-${year}-${String(nextSeq).padStart(5, '0')}`;
}

export function getAppSetting(database, tenantId, settingKey, fallbackValue = null) {
  const row = database.prepare(
    'SELECT value_json FROM app_settings WHERE tenant_id = ? AND setting_key = ?'
  ).get(tenantId, settingKey);
  if (!row) return fallbackValue;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return fallbackValue;
  }
}

export function setAppSettingTx(database, tenantId, settingKey, value, nowIso = new Date().toISOString()) {
  database.prepare(
    `INSERT INTO app_settings (tenant_id,setting_key,value_json,updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT(tenant_id,setting_key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`
  ).run(tenantId, settingKey, JSON.stringify(value), nowIso);
}

export function createCoreService(database) {
  return {
    // --- الأنشطة التجارية ---
    getActivities(actor) {
      assertPermission(actor, 'view:dashboard', 'عرض الأنشطة التجارية');
      const rows = database.prepare(
        'SELECT id, code, data_json FROM activities WHERE tenant_id = ? ORDER BY rowid'
      ).all(actor.tenantId);
      if (rows.length === 0) return OFFICIAL_ACTIVITIES;
      return rows.map((row) => parseRowJson(row));
    },

    // --- الفروع وإدارة الفرع النشط ---
    getBranches(actor) {
      assertPermission(actor, 'branches:view', 'عرض الفروع');
      const rows = database.prepare(
        'SELECT id, code, name_ar, is_main, active, data_json FROM branches WHERE tenant_id = ? ORDER BY is_main DESC, code ASC'
      ).all(actor.tenantId);
      const branches = rows.map((row) => ({
        ...parseRowJson(row),
        id: row.id,
        code: row.code,
        nameAr: row.name_ar,
        isMain: row.is_main === 1,
        active: row.active === 1,
      }));
      if (actor.role === 'ADMIN') return branches;
      const allowed = getAuthorizedBranchIds(actor);
      return branches.filter((b) => allowed.has(b.id));
    },

    getBranch(actor, branchId) {
      assertPermission(actor, 'branches:view', 'عرض بيانات فرع');
      assertBranchAccess(actor, branchId);
      const row = database.prepare(
        'SELECT id, code, name_ar, is_main, active, data_json FROM branches WHERE tenant_id = ? AND id = ?'
      ).get(actor.tenantId, branchId);
      if (!row) return undefined;
      return {
        ...parseRowJson(row),
        id: row.id,
        code: row.code,
        nameAr: row.name_ar,
        isMain: row.is_main === 1,
        active: row.active === 1,
      };
    },

    addBranch(actor, branch) {
      assertPermission(actor, 'branches:manage', 'إضافة فرع جديد');
      if (!branch || typeof branch !== 'object') throw new Error('بيانات الفرع غير صالحة.');
      const code = String(branch.code || '').trim().toUpperCase();
      const nameAr = String(branch.nameAr || '').trim();
      if (!code || !nameAr) throw new Error('كود الفرع واسمه مطلوبان.');

      const dup = database.prepare(
        'SELECT 1 FROM branches WHERE tenant_id = ? AND upper(code) = upper(?)'
      ).get(actor.tenantId, code);
      if (dup) throw new Error(`كود الفرع (${code}) مسجل مسبقاً.`);

      const nowIso = new Date().toISOString();
      const id = String(branch.id || '').trim() || randomUUID();
      const clean = {
        ...branch,
        id,
        tenantId: actor.tenantId,
        code,
        nameAr,
        isMain: Boolean(branch.isMain),
        active: branch.active !== false,
        createdAt: branch.createdAt || nowIso,
      };

      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(
          'INSERT INTO branches (tenant_id,id,code,name_ar,is_main,active,data_json) VALUES (?,?,?,?,?,?,?)'
        ).run(actor.tenantId, clean.id, clean.code, clean.nameAr, clean.isMain ? 1 : 0, clean.active ? 1 : 0, JSON.stringify(clean));
        enqueueOutboxTx(database, actor, {
          entityType: 'BRANCH',
          entityId: clean.id,
          action: 'CREATE',
          payload: clean,
          branchId: clean.id,
          nowIso,
        });
        writeAuditLogTx(database, actor, 'إضافة فرع', `تمت إضافة الفرع: ${clean.nameAr} (${clean.code})`, nowIso);
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return clean;
    },

    updateBranch(actor, branch) {
      assertPermission(actor, 'branches:manage', 'تعديل فرع');
      if (!branch || !branch.id) throw new Error('معرف الفرع مطلوب للتعديل.');
      assertBranchAccess(actor, branch.id);
      const existing = database.prepare(
        'SELECT id, code, name_ar, is_main, active, data_json FROM branches WHERE tenant_id = ? AND id = ?'
      ).get(actor.tenantId, branch.id);
      if (!existing) throw new Error('الفرع المحدد غير موجود.');

      const nowIso = new Date().toISOString();
      const clean = {
        ...parseRowJson(existing),
        ...branch,
        id: existing.id,
        tenantId: actor.tenantId,
        code: String(branch.code || existing.code).trim().toUpperCase(),
        nameAr: String(branch.nameAr || existing.name_ar).trim(),
        isMain: branch.isMain !== undefined ? Boolean(branch.isMain) : existing.is_main === 1,
        active: branch.active !== undefined ? Boolean(branch.active) : existing.active === 1,
      };

      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(
          'UPDATE branches SET code = ?, name_ar = ?, is_main = ?, active = ?, data_json = ? WHERE tenant_id = ? AND id = ?'
        ).run(clean.code, clean.nameAr, clean.isMain ? 1 : 0, clean.active ? 1 : 0, JSON.stringify(clean), actor.tenantId, clean.id);
        enqueueOutboxTx(database, actor, {
          entityType: 'BRANCH',
          entityId: clean.id,
          action: 'UPDATE',
          payload: clean,
          branchId: clean.id,
          nowIso,
        });
        writeAuditLogTx(database, actor, 'تعديل فرع', `تم تحديث بيانات الفرع: ${clean.nameAr}`, nowIso);
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return clean;
    },

    getActiveBranchId(actor) {
      if (!actor || !actor.active) throw new Error('الجلسة غير صالحة.');
      const saved = getAppSetting(database, actor.tenantId, 'active_branch_id', null);
      const candidate = typeof saved === 'string' && saved.trim() ? saved.trim() : actor.branchId;
      const allowed = getAuthorizedBranchIds(actor);
      const branchRow = database.prepare(
        'SELECT id FROM branches WHERE tenant_id = ? AND id = ? AND active = 1'
      ).get(actor.tenantId, candidate);
      if (branchRow && (actor.role === 'ADMIN' || allowed.has(candidate))) {
        return candidate;
      }
      return actor.branchId || 'branch_main';
    },

    setActiveBranchId(actor, branchId) {
      assertPermission(actor, 'branches:view', 'تبديل الفرع النشط');
      assertBranchAccess(actor, branchId);
      const branchRow = database.prepare(
        'SELECT id FROM branches WHERE tenant_id = ? AND id = ? AND active = 1'
      ).get(actor.tenantId, branchId);
      if (!branchRow) throw new Error('الفرع المحدد غير موجود أو غير نشط.');
      setAppSettingTx(database, actor.tenantId, 'active_branch_id', branchId);
      return branchId;
    },

    getTerminalCode(actor) {
      if (!actor || !actor.active) throw new Error('الجلسة غير صالحة.');
      const saved = getAppSetting(database, actor.tenantId, 'terminal_code', 'POS01');
      return typeof saved === 'string' && saved.trim() ? saved.trim() : 'POS01';
    },

    setTerminalCode(actor, terminalCode) {
      assertPermission(actor, 'settings:manage', 'تعديل رمز نقطة البيع');
      const clean = String(terminalCode || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
      if (!clean) throw new Error('رمز نقطة البيع غير صالح.');
      setAppSettingTx(database, actor.tenantId, 'terminal_code', clean);
      return clean;
    },

    // --- الدليل المحاسبي ---
    getAccounts(actor) {
      assertPermission(actor, 'view:accounting', 'عرض الدليل المحاسبي');
      const rows = database.prepare(
        'SELECT code, account_type, parent_code, is_leaf, balance_decimal, data_json FROM accounts WHERE tenant_id = ? ORDER BY code'
      ).all(actor.tenantId);
      return rows.map((row) => ({
        ...parseRowJson(row),
        code: row.code,
        type: row.account_type,
        parentCode: row.parent_code ?? null,
        isLeaf: row.is_leaf === 1,
        balance: unitsToNumber(parseScaledInt(row.balance_decimal, MONEY_SCALE, 'accountBalance'), MONEY_SCALE),
      }));
    },

    createAccountAtomic(actor, account) {
      assertPermission(actor, 'account:create', 'إضافة حساب محاسبي');
      if (!account || typeof account !== 'object') throw new Error('بيانات الحساب غير صالحة.');
      const code = String(account.code || '').trim();
      const nameAr = String(account.nameAr || '').trim();
      const type = String(account.type || '').trim();
      if (!code || !nameAr) throw new Error('كود الحساب واسمه مطلوبان.');
      if (!VALID_ACCOUNT_TYPES.has(type)) throw new Error('نوع الحساب المحاسبي غير صالح.');

      const existing = database.prepare(
        'SELECT 1 FROM accounts WHERE tenant_id = ? AND code = ?'
      ).get(actor.tenantId, code);
      if (existing) {
        throw new Error(`رمز الحساب (${code}) موجود مسبقاً في الدليل المحاسبي.`);
      }

      const parentCode = account.parentCode ? String(account.parentCode).trim() : null;
      if (parentCode) {
        const parentExists = database.prepare(
          'SELECT 1 FROM accounts WHERE tenant_id = ? AND code = ?'
        ).get(actor.tenantId, parentCode);
        if (!parentExists) {
          throw new Error(`الحساب الأب (${parentCode}) غير موجود في الدليل المحاسبي.`);
        }
      }

      const balanceUnits = parseScaledInt(account.balance ?? 0, MONEY_SCALE, 'initialAccountBalance');
      const balanceNum = unitsToNumber(balanceUnits, MONEY_SCALE);
      const balanceDec = formatScaledInt(balanceUnits, MONEY_SCALE);
      const nowIso = new Date().toISOString();

      const cleanAccount = {
        ...account,
        tenantId: actor.tenantId,
        code,
        nameAr,
        type,
        parentCode,
        isLeaf: account.isLeaf !== false,
        balance: balanceNum,
      };

      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(
          'INSERT INTO accounts (tenant_id,code,account_type,parent_code,is_leaf,balance_decimal,data_json) VALUES (?,?,?,?,?,?,?)'
        ).run(actor.tenantId, cleanAccount.code, cleanAccount.type, cleanAccount.parentCode, cleanAccount.isLeaf ? 1 : 0, balanceDec, JSON.stringify(cleanAccount));
        enqueueOutboxTx(database, actor, {
          entityType: 'ACCOUNT',
          entityId: cleanAccount.code,
          action: 'CREATE',
          payload: cleanAccount,
          nowIso,
        });
        writeAuditLogTx(database, actor, 'إضافة حساب محاسبي', `إضافة الحساب (${cleanAccount.code}) - ${cleanAccount.nameAr}`, nowIso);
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }

      return cleanAccount;
    },

    saveAccounts(actor, accounts) {
      assertPermission(actor, 'account:create', 'تحديث الدليل المحاسبي');
      if (!Array.isArray(accounts) || accounts.length === 0) {
        throw new Error('قائمة الحسابات غير صالحة.');
      }

      const nowIso = new Date().toISOString();
      database.exec('BEGIN IMMEDIATE');
      try {
        const upsertStmt = database.prepare(
          `INSERT INTO accounts (tenant_id,code,account_type,parent_code,is_leaf,balance_decimal,data_json)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(tenant_id,code) DO UPDATE SET
             account_type=excluded.account_type,
             parent_code=excluded.parent_code,
             is_leaf=excluded.is_leaf,
             data_json=excluded.data_json`
        );
        const existingStmt = database.prepare(
          'SELECT balance_decimal FROM accounts WHERE tenant_id = ? AND code = ?'
        );
        // Sort shallower codes first so parent_code FK constraints always resolve cleanly
        const sorted = [...accounts].sort((a, b) => String(a.code).length - String(b.code).length);
        for (const acc of sorted) {
          const code = String(acc.code || '').trim();
          const nameAr = String(acc.nameAr || '').trim();
          const type = String(acc.type || '').trim();
          if (!code || !nameAr || !VALID_ACCOUNT_TYPES.has(type)) {
            throw new Error(`بيانات حساب غير صالحة: ${code || '?'}`);
          }
          const existing = existingStmt.get(actor.tenantId, code);
          const balUnits = existing
            ? parseScaledInt(existing.balance_decimal, MONEY_SCALE, 'existingBalance')
            : parseScaledInt(acc.balance ?? 0, MONEY_SCALE, 'newAccountBalance');
          const balNum = unitsToNumber(balUnits, MONEY_SCALE);
          const balDec = formatScaledInt(balUnits, MONEY_SCALE);
          const clean = {
            ...acc,
            tenantId: actor.tenantId,
            code,
            nameAr,
            type,
            parentCode: acc.parentCode ? String(acc.parentCode).trim() : null,
            isLeaf: acc.isLeaf !== false,
            balance: balNum,
          };
          upsertStmt.run(actor.tenantId, clean.code, clean.type, clean.parentCode, clean.isLeaf ? 1 : 0, balDec, JSON.stringify(clean));
        }
        writeAuditLogTx(database, actor, 'تحديث الدليل المحاسبي', `تم تحديث ${accounts.length} حساباً في الدليل المحاسبي.`, nowIso);
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    // --- المستخدمون وسجلات التدقيق ---
    getUsers(actor) {
      assertPermission(actor, 'users:read', 'عرض المستخدمين');
      const rows = database.prepare(
        'SELECT tenant_id,id,branch_id,username,role,active,password_hash,data_json FROM users WHERE tenant_id = ? ORDER BY username'
      ).all(actor.tenantId);
      const users = rows.map((row) => {
        const parsed = parseRowJson(row);
        delete parsed.passwordHash;
        return {
          ...parsed,
          id: row.id,
          tenantId: row.tenant_id,
          branchId: row.branch_id || parsed.branchId || '',
          username: row.username,
          role: row.role,
          active: row.active === 1,
          hasPassword: Boolean(row.password_hash),
        };
      });
      return filterRecordsByBranchScope(users, actor);
    },

    getAuditLogs(actor) {
      assertPermission(actor, 'view:audit_logs', 'عرض سجلات الرقابة');
      const rows = database.prepare(
        'SELECT id, tenant_id, branch_id, timestamp, user_id, action, details, data_json FROM audit_logs WHERE tenant_id = ? ORDER BY timestamp DESC LIMIT 1000'
      ).all(actor.tenantId);
      const logs = rows.map((row) => ({
        ...parseRowJson(row),
        id: row.id,
        tenantId: row.tenant_id,
        branchId: row.branch_id,
        timestamp: row.timestamp,
        userId: row.user_id,
        action: row.action,
        details: row.details,
      }));
      return filterAuditLogsForUser(logs, actor);
    },

    logAction(actor, action, details) {
      if (!actor || !actor.active) throw new Error('الجلسة غير صالحة لتسجيل حدث.');
      return writeAuditLogTx(database, actor, action, details);
    },

    // --- العدادات التلقائية وأرقام المستندات ---
    generateBranchInvoiceNumber(actor, type, branchCode, terminalCode) {
      const permission = type === 'INV' ? 'pos:sale' : 'purchase:create';
      assertPermission(actor, permission, 'توليد رقم فاتورة');
      const activeBranchId = this.getActiveBranchId(actor);
      assertBranchAccess(actor, activeBranchId);
      const branch = this.getBranch(actor, activeBranchId);
      if (!branch) throw new Error('الفرع النشط غير موجود.');
      if (branchCode && branchCode !== branch.code) {
        throw new Error('رمز الفرع المطلوب لا يطابق الفرع المصرح به في الجلسة.');
      }
      const term = terminalCode || this.getTerminalCode(actor);
      let generated;
      database.exec('BEGIN IMMEDIATE');
      try {
        generated = allocateSequenceTx(database, actor.tenantId, type, branch.code, term);
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return generated;
    },

    generateBranchVoucherNumber(actor, type, branchCode, terminalCode) {
      const permission = type === 'RCT' ? 'voucher:receipt' : 'voucher:payment';
      assertPermission(actor, permission, 'توليد رقم سند');
      const activeBranchId = this.getActiveBranchId(actor);
      assertBranchAccess(actor, activeBranchId);
      const branch = this.getBranch(actor, activeBranchId);
      if (!branch) throw new Error('الفرع النشط غير موجود.');
      if (branchCode && branchCode !== branch.code) {
        throw new Error('رمز الفرع المطلوب لا يطابق الفرع المصرح به في الجلسة.');
      }
      const term = terminalCode || this.getTerminalCode(actor);
      let generated;
      database.exec('BEGIN IMMEDIATE');
      try {
        generated = allocateSequenceTx(database, actor.tenantId, type, branch.code, term);
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return generated;
    },

    // --- إعدادات الشركة والمزامنة والأجهزة ---
    getCompanyProfile(actor) {
      if (!actor || !actor.active) throw new Error('الجلسة غير صالحة.');
      return getAppSetting(database, actor.tenantId, 'company_profile', DEFAULT_COMPANY_PROFILE);
    },

    saveCompanyProfile(actor, profile) {
      assertPermission(actor, 'settings:manage', 'تعديل بيانات الشركة والعملة');
      if (!profile || typeof profile !== 'object' || !String(profile.nameAr || '').trim()) {
        throw new Error('اسم الشركة بالعربية مطلوب.');
      }
      const nowIso = new Date().toISOString();
      const current = this.getCompanyProfile(actor);
      const updated = {
        ...current,
        ...profile,
        nameAr: String(profile.nameAr).trim(),
      };
      database.exec('BEGIN IMMEDIATE');
      try {
        setAppSettingTx(database, actor.tenantId, 'company_profile', updated, nowIso);
        writeAuditLogTx(database, actor, 'تعديل بيانات الشركة', `تم تحديث بيانات الشركة: ${updated.nameAr}`, nowIso);
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return updated;
    },

    getSyncConfig(actor, kind) {
      if (!actor || !actor.active) throw new Error('الجلسة غير صالحة.');
      const key = kind === 'django' ? 'django_sync_config' : 'supabase_sync_config';
      return getAppSetting(database, actor.tenantId, key, null);
    },

    saveSyncConfig(actor, kind, config) {
      assertPermission(actor, 'sync:manage', 'حفظ إعدادات المزامنة');
      const key = kind === 'django' ? 'django_sync_config' : 'supabase_sync_config';
      const nowIso = new Date().toISOString();
      database.exec('BEGIN IMMEDIATE');
      try {
        setAppSettingTx(database, actor.tenantId, key, config, nowIso);
        if (kind === 'supabase' && config && config.deviceId) {
          database.prepare(
            `INSERT INTO device_registrations (tenant_id,device_id,branch_id,device_name,device_type,is_active,data_json)
             VALUES (?,?,?,?,?,1,?)
             ON CONFLICT(tenant_id,device_id) DO UPDATE SET branch_id=excluded.branch_id, device_name=excluded.device_name, data_json=excluded.data_json`
          ).run(
            actor.tenantId,
            String(config.deviceId),
            actor.branchId || 'branch_main',
            String(config.deviceName || 'Windows Desktop'),
            'DESKTOP',
            JSON.stringify({
              deviceId: config.deviceId,
              deviceName: config.deviceName || 'Windows Desktop',
              branchId: actor.branchId || 'branch_main',
              updatedAt: nowIso,
            })
          );
        }
        writeAuditLogTx(database, actor, 'تحديث إعدادات المزامنة', `تم تحديث إعدادات المزامنة (${kind}).`, nowIso);
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return config;
    },

    // --- تصفير الدفاتر التشغيلية (Clean Books) ---
    resetToCleanBooks(actor) {
      assertPermission(actor, 'settings:manage', 'تصفير الدفاتر التشغيلية');
      const nowIso = new Date().toISOString();
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare('DELETE FROM payment_allocations WHERE tenant_id = ?').run(actor.tenantId);
        database.prepare('DELETE FROM party_advance_transactions WHERE tenant_id = ?').run(actor.tenantId);
        database.prepare('DELETE FROM allocation_audits WHERE tenant_id = ?').run(actor.tenantId);
        database.prepare('DELETE FROM invoice_stock_deductions WHERE tenant_id = ?').run(actor.tenantId);
        database.prepare('DELETE FROM invoice_items WHERE tenant_id = ?').run(actor.tenantId);
        database.prepare('DELETE FROM invoices WHERE tenant_id = ?').run(actor.tenantId);
        database.prepare('DELETE FROM journal_entry_lines WHERE tenant_id = ?').run(actor.tenantId);
        database.prepare('DELETE FROM journal_entries WHERE tenant_id = ?').run(actor.tenantId);
        database.prepare('DELETE FROM vouchers WHERE tenant_id = ?').run(actor.tenantId);
        database.prepare('DELETE FROM amanat_records WHERE tenant_id = ?').run(actor.tenantId);
        database.prepare('DELETE FROM outbox_queue WHERE tenant_id = ?').run(actor.tenantId);
        database.prepare('DELETE FROM sync_conflicts WHERE tenant_id = ?').run(actor.tenantId);
        database.prepare('DELETE FROM document_sequences WHERE tenant_id = ?').run(actor.tenantId);

        const accRows = database.prepare('SELECT code, data_json FROM accounts WHERE tenant_id = ?').all(actor.tenantId);
        const updAcc = database.prepare('UPDATE accounts SET balance_decimal = ?, data_json = ? WHERE tenant_id = ? AND code = ?');
        for (const r of accRows) {
          const obj = parseRowJson(r);
          obj.balance = 0;
          updAcc.run('0.00', JSON.stringify(obj), actor.tenantId, r.code);
        }

        const cbRows = database.prepare('SELECT id, data_json FROM cash_boxes WHERE tenant_id = ?').all(actor.tenantId);
        const updCb = database.prepare('UPDATE cash_boxes SET balance_decimal = ?, data_json = ? WHERE tenant_id = ? AND id = ?');
        for (const r of cbRows) {
          const obj = parseRowJson(r);
          obj.balance = 0;
          updCb.run('0.00', JSON.stringify(obj), actor.tenantId, r.id);
        }

        const partyRows = database.prepare('SELECT id, data_json FROM parties WHERE tenant_id = ?').all(actor.tenantId);
        const updParty = database.prepare(
          'UPDATE parties SET balance_decimal = ?, advance_balance_decimal = ?, data_json = ? WHERE tenant_id = ? AND id = ?'
        );
        for (const r of partyRows) {
          const obj = parseRowJson(r);
          obj.balance = 0;
          obj.advanceBalance = 0;
          updParty.run('0.00', '0.00', JSON.stringify(obj), actor.tenantId, r.id);
        }

        writeAuditLogTx(
          database,
          actor,
          'تصفير الدفاتر التشغيلية',
          'تم بدء سنة مالية / دفتر نظيف مع الاحتفاظ بالحسابات والأصناف والمستخدمين وتصفير الأرصدة.',
          nowIso
        );
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },
  };
}
