import {
  createHash,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

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
  return safe;
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
    const count = this.database.prepare(
      'SELECT COUNT(*) AS count FROM users WHERE tenant_id = ?'
    ).get(this.tenantId).count;
    return { setupRequired: count === 0, userCount: count };
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

    const branch = this.database.prepare(
      'SELECT id FROM branches WHERE tenant_id = ? AND id = ? AND active = 1'
    ).get(this.tenantId, 'branch_main');
    if (!branch) throw new Error('الفرع الرئيسي غير موجود أو غير نشط. تعذر إعداد المدير.');

    const user = {
      id: randomUUID(),
      tenantId: this.tenantId,
      username,
      fullName,
      role: 'ADMIN',
      allowedActivities: ['pharmacy', 'grocery', 'bike_parts', 'equipment_parts'],
      branchId: 'branch_main',
      allowedBranches: ['branch_main'],
      active: true,
      mustChangePassword: false,
      failedLoginAttempts: 0,
      updatedAt: new Date(this.now()).toISOString(),
    };
    const passwordHash = hashPasswordForDesktop(password);
    this.database.prepare(
      'INSERT INTO users (tenant_id,id,branch_id,username,role,active,password_hash,data_json) VALUES (?,?,?,?,?,?,?,?)'
    ).run(
      this.tenantId, user.id, user.branchId, user.username, user.role, 1,
      passwordHash, toStoredUser(user)
    );
    return { success: true, user: sanitizeUser(user) };
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
      return { success: true, mustChangePassword: true, user: sanitizeUser(cleanUser) };
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
    const actor = this.getActor(input && input.token);
    if (!actor) throw new Error('انتهت الجلسة أو لم تعد صالحة.');
    const row = this.database.prepare(
      'SELECT tenant_id,id,branch_id,username,role,active,password_hash,data_json FROM users WHERE tenant_id = ? AND id = ?'
    ).get(actor.tenantId, actor.id);
    const user = parseUserRow(row);
    if (!user || !user.mustChangePassword) {
      throw new Error('هذا الحساب ليس في وضع تغيير كلمة المرور الإلزامي.');
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
    this.sessions.delete(input.token);
    return this.issueSession(updated);
  }

  logout(token) {
    if (typeof token === 'string') this.sessions.delete(token);
    return { success: true };
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
