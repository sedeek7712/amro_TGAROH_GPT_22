import {
  createHash,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { seedReferenceDataIfEmpty } from '../sqlite/seed-data.mjs';
import { assertPermission } from '../sqlite/rbac.mjs';

const VALID_ROLES = new Set(['ADMIN', 'ACCOUNTANT', 'CASHIER', 'INVENTORY_KEEPER']);
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_MAX_VERIFY_ITERATIONS = 1_000_000;
const KEY_DERIVED_BYTES = 32;
const SALT_BYTES = 16;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const WEAK_PASSWORDS = new Set([
  '1234', '12345', '123456', '1234567', '12345678', '123456789',
  'admin', 'admin123', 'password', 'qwerty', '00000000', '11111111',
]);

function parseUserRow(row) {
  if (!row) return null;
  let payload;
  try {
    payload = JSON.parse(row.data_json);
  } catch {
    throw new Error('تعذر قراءة ملف المستخدم المخزن في قاعدة البيانات.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('سجل المستخدم المخزن غير صالح.');
  }
  return {
    ...payload,
    id: row.id,
    tenantId: row.tenant_id,
    username: row.username,
    role: row.role,
    active: row.active === 1,
    branchId: row.branch_id || payload.branchId || '',
    passwordHash: row.password_hash || undefined,
  };
}

function toStoredUser(user) {
  const copy = { ...user };
  delete copy.passwordHash;
  return JSON.stringify(copy);
}

function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return {
    ...safe,
    hasPassword: Boolean(passwordHash),
  };
}

function passwordError(password, username) {
  if (typeof password !== 'string' || !password.trim()) {
    return 'كلمة المرور مطلوبة ولا يجوز أن تكون فارغة.';
  }
  if (password.length < 8) return 'يجب أن تتكون كلمة المرور من 8 أحرف/أرقام على الأقل.';
  if (password.length > 128) return 'كلمة المرور طويلة جداً (الحد الأقصى 128 حرفاً).';
  const normalized = password.trim().toLowerCase();
  if (WEAK_PASSWORDS.has(normalized)) return 'كلمة المرور المدخلة ضعيفة وشائعة ومرفوضة أمنياً.';
  if (username && normalized === username.trim().toLowerCase()) {
    return 'لا يجوز أن تطابق كلمة المرور اسم المستخدم.';
  }
  const hasLetter = /[a-zA-Z\u0600-\u06FF]/.test(password);
  const hasDigitOrSymbol = /[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password);
  if (!hasLetter || !hasDigitOrSymbol) {
    return 'يجب أن تحتوي كلمة المرور على حروف وأرقام أو رموز لضمان الأمان.';
  }
  return null;
}

export function hashPasswordForDesktop(password) {
  const salt = randomBytes(SALT_BYTES);
  const derived = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_DERIVED_BYTES, 'sha256');
  return 'pbkdf2_sha256$' + PBKDF2_ITERATIONS + '$' + salt.toString('hex') + '$' + derived.toString('hex');
}

export function verifyDesktopPassword(password, encodedHash) {
  if (typeof password !== 'string' || typeof encodedHash !== 'string') return false;
  const parts = encodedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 10_000 || iterations > PBKDF2_MAX_VERIFY_ITERATIONS) {
    return false;
  }
  if (!/^[0-9a-f]{32}$/i.test(parts[2]) || !/^[0-9a-f]{64}$/i.test(parts[3])) {
    return false;
  }
  const salt = Buffer.from(parts[2], 'hex');
  const expected = Buffer.from(parts[3], 'hex');
  const actual = pbkdf2Sync(password, salt, iterations, KEY_DERIVED_BYTES, 'sha256');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class DesktopAuthenticationService {
  constructor(database, options = {}) {
    if (!database || typeof database.prepare !== 'function') {
      throw new TypeError('A live SQLite database connection is required');
    }
    this.database = database;
    this.tenantId = String(options.tenantId || 'tenant_main');
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.sessions = new Map();
  }

  getSetupStatus() {
    const status = this.database.prepare(
      "SELECT COUNT(*) AS user_count, COALESCE(SUM(CASE WHEN role='ADMIN' AND active=1 AND COALESCE(password_hash,'')<>'' THEN 1 ELSE 0 END),0) AS configured_admins FROM users WHERE tenant_id = ?"
    ).get(this.tenantId);
    return {
      setupRequired: status.configured_admins === 0,
      userCount: status.user_count,
    };
  }

  createInitialAdmin(input) {
    if (!input || typeof input !== 'object') throw new TypeError('بيانات المدير غير صالحة.');
    const status = this.getSetupStatus();
    if (!status.setupRequired) throw new Error('تم إعداد مستخدمين للنظام بالفعل؛ لا يمكن إنشاء مدير أولي جديد.');
    const username = String(input.username || '').trim();
    const fullName = String(input.fullName || '').trim();
    const password = input.password;
    if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) {
      throw new Error('اسم المستخدم يجب أن يكون من 3 إلى 40 حرفاً أو رقماً.');
    }
    if (fullName.length < 3 || fullName.length > 100) {
      throw new Error('يرجى إدخال اسم المدير بشكل صحيح.');
    }
    const passwordIssue = passwordError(password, username);
    if (passwordIssue) throw new Error(passwordIssue);

    const existingAdminRow = this.database.prepare(
      "SELECT tenant_id,id,branch_id,username,role,active,password_hash,data_json FROM users WHERE tenant_id=? AND role='ADMIN' AND active=1 AND COALESCE(password_hash,'')='' ORDER BY id LIMIT 1"
    ).get(this.tenantId);

    if (!existingAdminRow && status.userCount > 0) {
      throw new Error('توجد حسابات مستخدمين ولكن لا يوجد مدير عام غير مهيأ. يلزم استيراد نسخة صحيحة أو مراجعة المدير قبل الإعداد.');
    }

    const branchId = existingAdminRow?.branch_id || 'branch_main';
    const branch = this.database.prepare(
      'SELECT id FROM branches WHERE tenant_id = ? AND id = ? AND active = 1'
    ).get(this.tenantId, branchId);
    if (!branch) throw new Error('فرع المدير غير موجود أو غير نشط. تعذر إعداد المدير.');

    const existingAdmin = parseUserRow(existingAdminRow);
    const nowIso = new Date(this.now()).toISOString();
    const user = {
      ...(existingAdmin || {}),
      id: existingAdmin?.id || randomUUID(),
      tenantId: this.tenantId,
      username,
      fullName: existingAdmin?.fullName || fullName,
      role: 'ADMIN',
      allowedActivities: existingAdmin?.allowedActivities || ['pharmacy', 'grocery', 'bike_parts', 'equipment_parts'],
      branchId,
      allowedBranches: Array.isArray(existingAdmin?.allowedBranches) && existingAdmin.allowedBranches.length
        ? existingAdmin.allowedBranches
        : [branchId],
      active: true,
      mustChangePassword: false,
      failedLoginAttempts: 0,
      lockedUntil: undefined,
      updatedAt: nowIso,
    };
    const passwordHash = hashPasswordForDesktop(password);

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = existingAdmin
        ? this.database.prepare(
            'UPDATE users SET branch_id=?,username=?,role=?,active=1,password_hash=?,data_json=? WHERE tenant_id=? AND id=?'
          ).run(branchId, username, 'ADMIN', passwordHash, toStoredUser(user), this.tenantId, user.id)
        : this.database.prepare(
            'INSERT INTO users (tenant_id,id,branch_id,username,role,active,password_hash,data_json) VALUES (?,?,?,?,?,?,?,?)'
          ).run(this.tenantId, user.id, branchId, username, 'ADMIN', 1, passwordHash, toStoredUser(user));
      if (existingAdmin && result.changes !== 1) {
        throw new Error('تعذر تحديث حساب المدير الأولي.');
      }
      seedReferenceDataIfEmpty(this.database, this.tenantId, nowIso);
      this.writeAuditLog(user, 'تهيئة أمنية أولى', `تم تعيين المدير العام الأولي (${user.username}).`, nowIso);
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }

    return { success: true, user: sanitizeUser({ ...user, passwordHash }) };
  }

  authenticate(input) {
    if (!input || typeof input !== 'object') throw new TypeError('بيانات تسجيل الدخول غير صالحة.');
    const username = String(input.username || '').trim();
    const password = input.password;
    if (!username || typeof password !== 'string' || !password) {
      return { success: false, error: 'يرجى إدخال اسم المستخدم وكلمة المرور.' };
    }

    const row = this.database.prepare(
      'SELECT tenant_id,id,branch_id,username,role,active,password_hash,data_json FROM users WHERE tenant_id = ? AND username = ? COLLATE NOCASE'
    ).get(this.tenantId, username);
    const user = parseUserRow(row);
    if (!user || !user.active) {
      return { success: false, error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' };
    }

    if (user.lockedUntil) {
      const lockExpiry = Date.parse(user.lockedUntil);
      if (Number.isFinite(lockExpiry) && this.now() < lockExpiry) {
        const remaining = Math.ceil((lockExpiry - this.now()) / 1000);
        return {
          success: false,
          error: 'الحساب مقفل مؤقتاً بسبب محاولات دخول فاشلة متكررة. حاول بعد ' + remaining + ' ثانية.',
          lockedUntil: user.lockedUntil,
        };
      }
    }
    if (!user.passwordHash) {
      return { success: false, error: 'لم يتم تعيين كلمة مرور لهذا الحساب بعد. يرجى ضبط كلمة مرور من مدير النظام.' };
    }

    if (!verifyDesktopPassword(password, user.passwordHash)) {
      const attempts = (Number(user.failedLoginAttempts) || 0) + 1;
      const lockedUntil = attempts >= MAX_FAILED_ATTEMPTS
        ? new Date(this.now() + LOCKOUT_MS).toISOString()
        : undefined;
      const updated = {
        ...user,
        failedLoginAttempts: attempts,
        lockedUntil,
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.saveUser(updated);
      if (lockedUntil) {
        return {
          success: false,
          error: 'تم تجاوز الحد الأقصى للمحاولات الفاشلة (5 محاولات). تم قفل الحساب لمدة 5 دقائق.',
          lockedUntil,
        };
      }
      return {
        success: false,
        error: 'كلمة المرور غير صحيحة. المحاولات المتبقية قبل القفل: ' + (MAX_FAILED_ATTEMPTS - attempts) + '.',
      };
    }

    const tenantId = user.tenantId && user.tenantId.trim();
    const branchId = user.branchId && user.branchId.trim();
    if (!tenantId || tenantId !== this.tenantId || !branchId) {
      return { success: false, error: 'حظر أمني: حساب المستخدم يفتقر إلى ربط المؤسسة أو الفرع.' };
    }
    const allowedBranches = Array.isArray(user.allowedBranches) && user.allowedBranches.length
      ? [...new Set(user.allowedBranches.map((value) => String(value).trim()).filter(Boolean))]
      : [branchId];
    if (!allowedBranches.includes(branchId)) allowedBranches.push(branchId);

    const cleanUser = {
      ...user,
      tenantId,
      branchId,
      allowedBranches,
      failedLoginAttempts: 0,
      lockedUntil: undefined,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.saveUser(cleanUser);

    if (cleanUser.mustChangePassword) {
      const token = randomBytes(32).toString('base64url');
      const expiresAt = this.now() + 10 * 60 * 1000;
      this.sessions.set(token, {
        userId: cleanUser.id,
        tenantId: cleanUser.tenantId,
        issuedAt: this.now(),
        expiresAt,
        passwordChangeOnly: true,
      });
      return {
        success: true,
        mustChangePassword: true,
        token,
        expiresAt: new Date(expiresAt).toISOString(),
        user: sanitizeUser(cleanUser),
      };
    }
    return this.issueSession(cleanUser);
  }

  issueSession(user) {
    const token = randomBytes(32).toString('base64url');
    const issuedAt = this.now();
    const expiresAt = issuedAt + SESSION_TTL_MS;
    this.sessions.set(token, {
      userId: user.id,
      tenantId: user.tenantId,
      issuedAt,
      expiresAt,
      passwordChangeOnly: false,
    });
    return {
      success: true,
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      user: sanitizeUser(user),
    };
  }

  getActor(token, requestedBranchId) {
    if (typeof token !== 'string' || token.length < 40 || token.length > 200) return null;
    const session = this.sessions.get(token);
    if (!session || this.now() >= session.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    if (session.passwordChangeOnly) return null;
    const row = this.database.prepare(
      'SELECT tenant_id,id,branch_id,username,role,active,password_hash,data_json FROM users WHERE tenant_id = ? AND id = ?'
    ).get(session.tenantId, session.userId);
    const user = parseUserRow(row);
    if (!user || !user.active || user.tenantId !== session.tenantId || user.tenantId !== this.tenantId) {
      this.sessions.delete(token);
      return null;
    }
    const allowed = Array.isArray(user.allowedBranches) ? user.allowedBranches : [];
    const branchId = String(requestedBranchId || user.branchId || '').trim();
    if (!branchId) return null;
    const branch = this.database.prepare(
      'SELECT id FROM branches WHERE tenant_id = ? AND id = ? AND active = 1'
    ).get(user.tenantId, branchId);
    if (!branch) return null;
    if (user.role !== 'ADMIN' && !allowed.includes(branchId) && user.branchId !== branchId) return null;
    return {
      ...sanitizeUser(user),
      tenantId: user.tenantId,
      branchId,
      allowedBranches: allowed,
      sessionIssuedAt: new Date(session.issuedAt).toISOString(),
      sessionExpiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  completeMandatoryPasswordChange(input) {
    const token = input && input.token;
    const session = typeof token === 'string' ? this.sessions.get(token) : null;
    if (!session || !session.passwordChangeOnly || this.now() >= session.expiresAt) {
      this.sessions.delete(token);
      throw new Error('انتهت مهلة تغيير كلمة المرور أو أن الرمز غير صالح.');
    }
    const row = this.database.prepare(
      'SELECT tenant_id,id,branch_id,username,role,active,password_hash,data_json FROM users WHERE tenant_id = ? AND id = ?'
    ).get(session.tenantId, session.userId);
    const user = parseUserRow(row);
    if (!user || !user.active || user.tenantId !== this.tenantId || !user.mustChangePassword) {
      this.sessions.delete(token);
      throw new Error('هذا الحساب لم يعد مخولاً لتغيير كلمة المرور.');
    }
    const passwordIssue = passwordError(input.newPassword, user.username);
    if (passwordIssue) throw new Error(passwordIssue);

    const updated = {
      ...user,
      passwordHash: hashPasswordForDesktop(input.newPassword),
      mustChangePassword: false,
      failedLoginAttempts: 0,
      lockedUntil: undefined,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.saveUser(updated);
    this.sessions.delete(token);
    return this.issueSession(updated);
  }

  logout(token) {
    if (typeof token === 'string') this.sessions.delete(token);
    return { success: true };
  }

  revokeUserSessions(userId) {
    for (const [token, session] of this.sessions.entries()) {
      if (session.userId === userId) {
        this.sessions.delete(token);
      }
    }
  }

  writeAuditLog(actor, action, details, nowIso = new Date(this.now()).toISOString()) {
    const id = randomUUID();
    const record = {
      id,
      tenantId: actor?.tenantId || this.tenantId,
      branchId: actor?.branchId || 'branch_main',
      timestamp: nowIso,
      userId: actor?.id || 'system',
      userName: actor?.fullName || actor?.username || 'النظام',
      action: String(action || ''),
      details: String(details || ''),
    };
    this.database.prepare(
      'INSERT INTO audit_logs (tenant_id,id,branch_id,timestamp,user_id,action,details,data_json) VALUES (?,?,?,?,?,?,?,?)'
    ).run(
      record.tenantId,
      record.id,
      record.branchId,
      record.timestamp,
      record.userId,
      record.action,
      record.details,
      JSON.stringify(record)
    );
  }

  createUser({ token, input }) {
    const actor = this.getActor(token);
    assertPermission(actor, 'users:manage', 'إنشاء مستخدم جديد');

    if (!input || typeof input !== 'object') throw new Error('بيانات المستخدم غير صالحة.');
    const username = String(input.username || '').trim();
    const fullName = String(input.fullName || '').trim();
    const role = String(input.role || '').trim();
    const plainPassword = input.plainPassword;

    if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) {
      throw new Error('اسم المستخدم يجب أن يكون 3 إلى 40 حرفاً/رقماً بالإنجليزية.');
    }
    if (fullName.length < 2 || fullName.length > 120) {
      throw new Error('الاسم الكامل مطلوب.');
    }
    if (!VALID_ROLES.has(role)) {
      throw new Error('الدور الوظيفي المحدد غير صالح.');
    }
    const pwdIssue = passwordError(plainPassword, username);
    if (pwdIssue) throw new Error(pwdIssue);

    const existing = this.database.prepare(
      'SELECT 1 FROM users WHERE tenant_id = ? AND lower(username) = lower(?)'
    ).get(this.tenantId, username);
    if (existing) {
      throw new Error(`اسم المستخدم (${username}) مسجل مسبقاً.`);
    }

    const branchId = String(input.branchId || actor.branchId || 'branch_main').trim();
    const rawAllowedBranches = Array.isArray(input.allowedBranches) && input.allowedBranches.length
      ? input.allowedBranches.map((b) => String(b).trim()).filter(Boolean)
      : [branchId];
    if (!rawAllowedBranches.includes(branchId)) rawAllowedBranches.unshift(branchId);
    const allowedBranches = [...new Set(rawAllowedBranches)];

    const checkBranchStmt = this.database.prepare(
      'SELECT id FROM branches WHERE tenant_id = ? AND id = ? AND active = 1'
    );
    for (const bId of allowedBranches) {
      if (!checkBranchStmt.get(this.tenantId, bId)) {
        throw new Error(`الفرع المحدد (${bId}) غير موجود أو غير نشط.`);
      }
    }

    const allowedActivities = Array.isArray(input.allowedActivities)
      ? input.allowedActivities.map((a) => String(a).trim()).filter(Boolean)
      : ['pharmacy', 'grocery', 'bike_parts', 'equipment_parts'];

    const nowIso = new Date(this.now()).toISOString();
    const newUser = {
      id: randomUUID(),
      tenantId: this.tenantId,
      username,
      fullName,
      role,
      allowedActivities,
      branchId,
      allowedBranches,
      active: true,
      mustChangePassword: Boolean(input.mustChangePassword),
      failedLoginAttempts: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const passwordHash = hashPasswordForDesktop(plainPassword);

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(
        'INSERT INTO users (tenant_id,id,branch_id,username,role,active,password_hash,data_json) VALUES (?,?,?,?,?,?,?,?)'
      ).run(this.tenantId, newUser.id, branchId, username, role, 1, passwordHash, toStoredUser(newUser));
      this.writeAuditLog(
        actor,
        'إضافة مستخدم جديد',
        `تم إنشاء المستخدم (${fullName} - ${username}) بدور ${role}.`,
        nowIso
      );
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }

    return sanitizeUser({ ...newUser, passwordHash });
  }

  saveUserProfile({ token, user }) {
    const actor = this.getActor(token);
    assertPermission(actor, 'users:manage', 'تعديل بيانات المستخدم');
    if (!user || typeof user !== 'object' || !user.id) {
      throw new Error('بيانات المستخدم المراد تعديلها غير مكتملة.');
    }

    const row = this.database.prepare(
      'SELECT tenant_id,id,branch_id,username,role,active,password_hash,data_json FROM users WHERE tenant_id = ? AND id = ?'
    ).get(this.tenantId, String(user.id));
    if (!row) {
      throw new Error('المستخدم غير موجود في قاعدة البيانات.');
    }
    const existing = parseUserRow(row);
    const nextRole = VALID_ROLES.has(user.role) ? user.role : existing.role;
    const nextActive = typeof user.active === 'boolean' ? user.active : existing.active;

    if (existing.id === actor.id && !nextActive) {
      throw new Error('لا يمكنك إيقاف حسابك النشط حالياً.');
    }
    if (existing.role === 'ADMIN' && existing.active && (nextRole !== 'ADMIN' || !nextActive)) {
      const otherActiveAdmins = this.database.prepare(
        "SELECT COUNT(*) AS count FROM users WHERE tenant_id = ? AND id <> ? AND role = 'ADMIN' AND active = 1"
      ).get(this.tenantId, existing.id).count;
      if (otherActiveAdmins === 0) {
        throw new Error('حظر أمني: يجب الإبقاء على مدير عام نشط واحد على الأقل في النظام.');
      }
    }

    const rawAllowed = Array.isArray(user.allowedBranches) && user.allowedBranches.length
      ? user.allowedBranches.map((b) => String(b).trim()).filter(Boolean)
      : existing.allowedBranches || [existing.branchId || 'branch_main'];
    const allowedBranches = [...new Set(rawAllowed)];
    if (allowedBranches.length === 0) {
      throw new Error('يجب تحديد فرع واحد مصرح به على الأقل.');
    }
    const nextBranchId = allowedBranches.includes(String(user.branchId || '').trim())
      ? String(user.branchId).trim()
      : allowedBranches[0];

    const checkBranchStmt = this.database.prepare(
      'SELECT id FROM branches WHERE tenant_id = ? AND id = ? AND active = 1'
    );
    for (const bId of allowedBranches) {
      if (!checkBranchStmt.get(this.tenantId, bId)) {
        throw new Error(`الفرع المحدد (${bId}) غير موجود أو غير نشط.`);
      }
    }

    const nowIso = new Date(this.now()).toISOString();
    const updated = {
      ...existing,
      fullName: typeof user.fullName === 'string' && user.fullName.trim() ? user.fullName.trim() : existing.fullName,
      role: nextRole,
      allowedActivities: Array.isArray(user.allowedActivities)
        ? [...new Set(user.allowedActivities.map((a) => String(a).trim()).filter(Boolean))]
        : existing.allowedActivities,
      branchId: nextBranchId,
      allowedBranches,
      active: nextActive,
      updatedAt: nowIso,
    };

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.saveUser(updated);
      this.writeAuditLog(
        actor,
        'تعديل صلاحيات مستخدم',
        `تم تحديث بيانات/صلاحيات المستخدم (${updated.username}) — الحالة: ${updated.active ? 'نشط' : 'موقوف'}.`,
        nowIso
      );
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }

    if (!updated.active || updated.role !== existing.role) {
      this.revokeUserSessions(updated.id);
    }
    return sanitizeUser(updated);
  }

  adminResetPassword({ token, targetUserId, newPassword }) {
    const actor = this.getActor(token);
    assertPermission(actor, 'users:manage', 'تغيير كلمة مرور مستخدم');

    const row = this.database.prepare(
      'SELECT tenant_id,id,branch_id,username,role,active,password_hash,data_json FROM users WHERE tenant_id = ? AND id = ?'
    ).get(this.tenantId, String(targetUserId || ''));
    const target = parseUserRow(row);
    if (!target) {
      throw new Error('المستخدم المحدد غير موجود.');
    }
    const pwdIssue = passwordError(newPassword, target.username);
    if (pwdIssue) throw new Error(pwdIssue);

    const nowIso = new Date(this.now()).toISOString();
    const updated = {
      ...target,
      passwordHash: hashPasswordForDesktop(newPassword),
      mustChangePassword: false,
      failedLoginAttempts: 0,
      lockedUntil: undefined,
      updatedAt: nowIso,
    };

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.saveUser(updated);
      this.writeAuditLog(
        actor,
        'إعادة تعيين كلمة مرور',
        `قام المدير (${actor.username}) بتحديث كلمة مرور المستخدم (${target.username}).`,
        nowIso
      );
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }

    if (target.id !== actor.id) {
      this.revokeUserSessions(target.id);
    }
    return sanitizeUser(updated);
  }

  switchUser({ token, adminPassword, targetUserId }) {
    const actor = this.getActor(token);
    if (!actor || !actor.active || actor.role !== 'ADMIN') {
      throw new Error('حظر أمني: لا يملك صلاحية تبديل المستخدمين إلا المدير العام.');
    }
    const adminRow = this.database.prepare(
      'SELECT password_hash FROM users WHERE tenant_id = ? AND id = ?'
    ).get(this.tenantId, actor.id);
    if (!adminRow || !verifyDesktopPassword(adminPassword, adminRow.password_hash)) {
      return { success: false, error: 'كلمة مرور المدير العام غير صحيحة. تم حظر التبديل.' };
    }

    const targetRow = this.database.prepare(
      'SELECT tenant_id,id,branch_id,username,role,active,password_hash,data_json FROM users WHERE tenant_id = ? AND id = ?'
    ).get(this.tenantId, String(targetUserId || ''));
    const target = parseUserRow(targetRow);
    if (!target || !target.active) {
      return { success: false, error: 'المستخدم المطلوب غير موجود أو موقوف.' };
    }
    if (!target.branchId || !String(target.branchId).trim()) {
      return { success: false, error: 'المستخدم المطلوب غير مرتبط بفرع صالح.' };
    }

    this.sessions.delete(token);
    this.writeAuditLog(
      actor,
      'تبديل جلسة إداري',
      `قام المدير (${actor.username}) بتبديل الجلسة إلى (${target.username}).`
    );
    return this.issueSession(target);
  }

  saveUser(user) {
    const result = this.database.prepare(
      'UPDATE users SET branch_id = ?, username = ?, role = ?, active = ?, password_hash = ?, data_json = ? WHERE tenant_id = ? AND id = ?'
    ).run(
      user.branchId || null,
      user.username,
      user.role,
      user.active ? 1 : 0,
      user.passwordHash || null,
      toStoredUser(user),
      user.tenantId,
      user.id
    );
    if (result.changes !== 1) throw new Error('تعذر حفظ تحديثات حساب المستخدم في قاعدة البيانات.');
  }
}
