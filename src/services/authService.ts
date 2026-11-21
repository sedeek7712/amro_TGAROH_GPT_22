/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * خدمة المصادقة الآمنة وتجزئة كلمات المرور وإدارة الجلسات الموقعة (Auth Service)
 * تعالج SEC-01, SEC-05, SEC-07:
 * - عدم تخزين أي سر أو مفتاح HMAC خام في localStorage (استخدام CryptoKey غير قابل للاستخراج مخزن في IndexedDB).
 * - منع إنشاء جلسة مصادق عليها بدون التحقق من بيانات الاعتماد أو تدفق الإعداد الأولي/تغيير كلمة المرور الإلزامي.
 * - اشتقاق وتخزين كلمات المرور عبر PBKDF2-SHA256 (100,000 تكرار + Salt عشوائي).
 * - قفل مؤقت للحساب بعد 5 محاولات فاشلة.
 * - توقيع والتحقق من سلامة النسخ الاحتياطية عبر HMAC-SHA256.
 */

import { AuthSession, SystemUser } from '../types/erp';
import { desktopSession } from './desktopSession';

const AUTH_SESSION_KEY = 'multi_activity_erp_auth_session';
const KEYSTORE_DB_NAME = 'multi_activity_erp_keystore';
const KEYSTORE_STORE_NAME = 'keys';
const SESSION_KEY_ID = 'session_hmac_key';
const BACKUP_KEY_ID = 'backup_hmac_key';

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 ساعة
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 دقائق
const PBKDF2_ITERATIONS = 100_000;

const WEAK_PASSWORDS = new Set([
  '1234',
  '12345',
  '123456',
  '1234567',
  '12345678',
  '123456789',
  'admin',
  'admin123',
  'password',
  'qwerty',
  '00000000',
  '11111111',
]);

let inMemorySession: AuthSession | null = null;
let inMemoryUser: SystemUser | null = null;
const inMemoryCryptoKeys = new Map<string, CryptoKey>();

function getSubtleCrypto(): SubtleCrypto {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  throw new Error('WebCrypto SubtleCrypto غير متاح في بيئة التشغيل الحالية.');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    return new Uint8Array(0);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function openKeystoreDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(KEYSTORE_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(KEYSTORE_STORE_NAME)) {
          db.createObjectStore(KEYSTORE_STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function readKeyFromIdb(db: IDBDatabase, keyId: string): Promise<CryptoKey | null> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(KEYSTORE_STORE_NAME, 'readonly');
      const store = tx.objectStore(KEYSTORE_STORE_NAME);
      const req = store.get(keyId);
      req.onsuccess = () => {
        const val = req.result;
        if (val && typeof val === 'object' && 'algorithm' in val && 'type' in val) {
          resolve(val as CryptoKey);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function writeKeyToIdb(db: IDBDatabase, keyId: string, key: CryptoKey): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(KEYSTORE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(KEYSTORE_STORE_NAME);
      const req = store.put(key, keyId);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/**
 * الحصول على أو توليد مفتاح HMAC غير قابل للاستخراج (extractable: false) وحفظه في IndexedDB
 * بدون لمس localStorage أو كشف بايتات المفتاح الخام لسكربتات الواجهة.
 */
async function getOrCreateNonExtractableHmacKey(keyId: string): Promise<CryptoKey> {
  const cached = inMemoryCryptoKeys.get(keyId);
  if (cached) return cached;

  const subtle = getSubtleCrypto();
  const idb = await openKeystoreDb();

  if (idb) {
    try {
      const stored = await readKeyFromIdb(idb, keyId);
      if (stored) {
        inMemoryCryptoKeys.set(keyId, stored);
        idb.close();
        return stored;
      }
    } catch {
      // متابعة التوليد
    }
  }

  const generated = (await subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false, // غير قابل للاستخراج (SEC-01)
    ['sign', 'verify']
  )) as CryptoKey;

  inMemoryCryptoKeys.set(keyId, generated);

  if (idb) {
    await writeKeyToIdb(idb, keyId, generated);
    idb.close();
  }

  return generated;
}

async function signWithKey(keyId: string, payload: string): Promise<string> {
  const subtle = getSubtleCrypto();
  const key = await getOrCreateNonExtractableHmacKey(keyId);
  const enc = new TextEncoder();
  const sig = await subtle.sign('HMAC', key, enc.encode(payload));
  return bytesToHex(new Uint8Array(sig));
}

async function verifyWithKey(keyId: string, payload: string, signatureHex: string): Promise<boolean> {
  const sigBytes = hexToBytes(signatureHex);
  if (sigBytes.length === 0) return false;
  const subtle = getSubtleCrypto();
  const key = await getOrCreateNonExtractableHmacKey(keyId);
  const enc = new TextEncoder();
  return await subtle.verify('HMAC', key, sigBytes as BufferSource, enc.encode(payload));
}

function canonicalSessionPayload(session: Omit<AuthSession, 'signature'>): string {
  return JSON.stringify({
    userId: session.userId,
    username: session.username,
    role: session.role,
    tenantId: session.tenantId,
    branchId: session.branchId,
    allowedBranches: [...session.allowedBranches].sort(),
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
  });
}

/**
 * التحقق من قوة كلمة المرور قبل قبولها
 */
export function validatePasswordStrength(
  password: string,
  username?: string
): { valid: boolean; error?: string } {
  if (typeof password !== 'string' || password.trim().length === 0) {
    return { valid: false, error: 'كلمة المرور مطلوبة ولا يجوز أن تكون فارغة.' };
  }
  if (password.length < 8) {
    return { valid: false, error: 'يجب أن تتكون كلمة المرور من 8 أحرف/أرقام على الأقل.' };
  }
  if (password.length > 128) {
    return { valid: false, error: 'كلمة المرور طويلة جداً (الحد الأقصى 128 حرفاً).' };
  }
  const lower = password.trim().toLowerCase();
  if (WEAK_PASSWORDS.has(lower)) {
    return { valid: false, error: 'كلمة المرور المدخلة ضعيفة وشائعة ومرفوضة أمنياً.' };
  }
  if (username && lower === username.trim().toLowerCase()) {
    return { valid: false, error: 'لا يجوز أن تطابق كلمة المرور اسم المستخدم.' };
  }
  const hasLetter = /[a-zA-Z\u0600-\u06FF]/.test(password);
  const hasDigitOrSymbol = /[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password);
  if (!hasLetter || !hasDigitOrSymbol) {
    return { valid: false, error: 'يجب أن تحتوي كلمة المرور على حروف وأرقام أو رموز لضمان الأمان.' };
  }
  return { valid: true };
}

/**
 * اشتقاق كلمة المرور باستخدام PBKDF2-SHA256 مع Salt عشوائي
 */
export async function hashPassword(password: string): Promise<string> {
  const subtle = getSubtleCrypto();
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);

  const enc = new TextEncoder();
  const keyMaterial = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const derivedBits = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  const hashHex = bytesToHex(new Uint8Array(derivedBits));
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${bytesToHex(salt)}$${hashHex}`;
}

/**
 * التحقق من كلمة المرور مقابل القيمة المشتقة المخزنة (دون أي كلمة مرور افتراضية!)
 */
export async function verifyPassword(password: string, storedHash?: string): Promise<boolean> {
  if (!password || !storedHash || typeof storedHash !== 'string') {
    return false;
  }
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') {
    return false;
  }
  const iterations = Number(parts[1]);
  const saltHex = parts[2];
  const expectedHex = parts[3];
  if (!Number.isFinite(iterations) || iterations < 10_000 || !saltHex || !expectedHex) {
    return false;
  }

  const saltBytes = hexToBytes(saltHex);
  if (saltBytes.length === 0) return false;

  const subtle = getSubtleCrypto();
  const enc = new TextEncoder();
  const keyMaterial = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const derivedBits = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  const actualHex = bytesToHex(new Uint8Array(derivedBits));
  return constantTimeEqual(actualHex, expectedHex);
}

/**
 * فحص ما إذا كان النظام يحتاج تعيين كلمة مرور المدير العام لأول مرة
 */
export function needsInitialAdminSetup(users: SystemUser[]): boolean {
  const activeAdmins = users.filter((u) => u.role === 'ADMIN' && u.active);
  if (activeAdmins.length === 0) return true;
  return activeAdmins.every((admin) => !admin.passwordHash);
}

export function resolveUserTenantId(user?: SystemUser | null): string | null {
  if (!user) return null;
  if (user.tenantId && user.tenantId.trim()) return user.tenantId.trim();
  return null;
}

class AuthService {
  /**
   * إصدار جلسة موقعة داخلياً فقط بعد تحقق كامل من بيانات الاعتماد أو الإعداد الأولي (SEC-05)
   */
  private async issueSignedSession(
    user: SystemUser,
    tenantId?: string,
    ttlMs: number = DEFAULT_SESSION_TTL_MS
  ): Promise<AuthSession> {
    if (!user.active) {
      throw new Error('حظر أمني: لا يمكن إنشاء جلسة لحساب موقوف.');
    }

    const resolvedTenantId = tenantId?.trim() || user.tenantId?.trim() || '';
    if (!resolvedTenantId) {
      throw new Error('حظر أمني: يجب ارتباط المستخدم بمؤسسة (tenantId) صالحة لإنشاء الجلسة.');
    }

    const explicitBranch = user.branchId?.trim() || '';
    const allowedList = (user.allowedBranches || []).map((b) => b.trim()).filter(Boolean);
    const resolvedBranchId = explicitBranch || allowedList[0] || '';
    if (!resolvedBranchId) {
      throw new Error('حظر أمني: يجب ارتباط المستخدم بفرع (branchId) صالح لإنشاء الجلسة.');
    }

    const normalizedAllowed = Array.from(new Set([...allowedList, resolvedBranchId]));

    const now = Date.now();
    const baseSession: Omit<AuthSession, 'signature'> = {
      userId: user.id,
      username: user.username,
      role: user.role,
      tenantId: resolvedTenantId,
      branchId: resolvedBranchId,
      allowedBranches: normalizedAllowed,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };

    const signature = await signWithKey(SESSION_KEY_ID, canonicalSessionPayload(baseSession));
    const fullSession: AuthSession = { ...baseSession, signature };

    inMemorySession = fullSession;
    inMemoryUser = {
      ...user,
      tenantId: resolvedTenantId,
      branchId: resolvedBranchId,
      allowedBranches: normalizedAllowed,
    };

    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(fullSession));
    }

    return fullSession;
  }

  /**
   * إكمال الإعداد الأمني الأولي للمدير العام فقط عندما لا توجد كلمة مرور لأي مدير
   */
  public async completeInitialAdminSetup(params: {
    users: SystemUser[];
    newPassword: string;
    onSaveAdmin: (updatedAdmin: SystemUser) => Promise<void> | void;
  }): Promise<{ user: SystemUser; session: AuthSession }> {
    const { users, newPassword, onSaveAdmin } = params;
    if (!needsInitialAdminSetup(users)) {
      throw new Error('حظر أمني: الإعداد الأولي للنظام مكتمل مسبقاً. يرجى تسجيل الدخول بكلمة المرور.');
    }

    const adminUser = users.find((u) => u.role === 'ADMIN' && u.active);
    if (!adminUser) {
      throw new Error('لا يوجد حساب مدير عام نشط في قاعدة البيانات.');
    }

    const strength = validatePasswordStrength(newPassword, adminUser.username);
    if (!strength.valid) {
      throw new Error(strength.error || 'كلمة المرور لا تستوفي متطلبات الأمان.');
    }

    const passwordHash = await hashPassword(newPassword);
    const tenantId = adminUser.tenantId?.trim() || 'tenant_main';
    const branchId = adminUser.branchId?.trim() || adminUser.allowedBranches?.[0]?.trim() || 'branch_main';
    const allowedBranches =
      adminUser.allowedBranches && adminUser.allowedBranches.length > 0
        ? adminUser.allowedBranches
        : [branchId];

    const updatedAdmin: SystemUser = {
      ...adminUser,
      passwordHash,
      mustChangePassword: false,
      failedLoginAttempts: 0,
      lockedUntil: undefined,
      tenantId,
      branchId,
      allowedBranches,
      updatedAt: new Date().toISOString(),
    };

    await onSaveAdmin(updatedAdmin);
    const session = await this.issueSignedSession(updatedAdmin, tenantId);
    return { user: updatedAdmin, session };
  }

  /**
   * إكمال تغيير كلمة المرور الإلزامي لمستخدم تم التحقق من هويته حديثاً (mustChangePassword)
   */
  public async completeMandatoryPasswordChange(params: {
    user: SystemUser;
    newPassword: string;
    onSaveUser: (updatedUser: SystemUser) => Promise<void> | void;
  }): Promise<{ user: SystemUser; session: AuthSession }> {
    const { user, newPassword, onSaveUser } = params;
    if (!user.mustChangePassword) {
      throw new Error('حظر أمني: الحساب ليس في وضع تغيير كلمة المرور الإلزامي.');
    }
    const actor = this.getCurrentActorSync();
    if (!actor || actor.id !== user.id) {
      throw new Error('حظر أمني: يجب التحقق من كلمة المرور الحالية أولاً قبل إتمام التغيير الإلزامي.');
    }

    const strength = validatePasswordStrength(newPassword, user.username);
    if (!strength.valid) {
      throw new Error(strength.error || 'كلمة المرور لا تستوفي متطلبات الأمان.');
    }

    const passwordHash = await hashPassword(newPassword);
    const updatedUser: SystemUser = {
      ...user,
      passwordHash,
      mustChangePassword: false,
      failedLoginAttempts: 0,
      lockedUntil: undefined,
      updatedAt: new Date().toISOString(),
    };

    await onSaveUser(updatedUser);
    const session = await this.issueSignedSession(updatedUser, updatedUser.tenantId);
    return { user: updatedUser, session };
  }

  /**
   * تبديل الجلسة من مدير عام مصادق عليه فقط وبعد التحقق الفعلي من كلمة مرور المدير (SEC-05)
   */
  public async switchUserWithAdminPassword(params: {
    adminPassword: string;
    targetUser: SystemUser;
    authoritativeUsers: SystemUser[];
  }): Promise<{ user: SystemUser; session: AuthSession }> {
    const currentActor = this.getCurrentActorSync();
    const currentSession = this.getCurrentSessionSync();
    if (!currentActor || !currentSession || currentActor.role !== 'ADMIN' || !currentActor.active) {
      throw new Error('حظر أمني: تبديل الجلسة متاح للمدير العام النشط المصادق عليه فقط.');
    }

    const freshAdmin = params.authoritativeUsers.find((u) => u.id === currentActor.id);
    if (!freshAdmin || freshAdmin.role !== 'ADMIN' || !freshAdmin.active) {
      throw new Error('حظر أمني: حساب المدير العام غير نشط أو تم سحب صلاحيته.');
    }

    const isValid = await verifyPassword(params.adminPassword, freshAdmin.passwordHash);
    if (!isValid) {
      throw new Error('كلمة مرور المدير العام غير صحيحة. تم حظر تبديل الجلسة.');
    }

    const freshTarget = params.authoritativeUsers.find((u) => u.id === params.targetUser.id);
    if (!freshTarget || !freshTarget.active) {
      throw new Error('لا يمكن التبديل إلى حساب غير موجود أو موقوف.');
    }

    const adminTenantId = freshAdmin.tenantId?.trim();
    const targetTenantId = freshTarget.tenantId?.trim();
    if (!adminTenantId || !targetTenantId || targetTenantId !== adminTenantId) {
      throw new Error('حظر عزل المؤسسات: يجب أن يكون للمستخدمين معرّف مؤسسة صريح ومتطابق.');
    }

    const session = await this.issueSignedSession(freshTarget, freshTarget.tenantId);
    return { user: freshTarget, session };
  }

  /**
   * تحديث بيانات جلسة المستخدم الحالي ذاتياً دون رفع الصلاحية أو تغيير الدور/المؤسسة
   */
  public async refreshSelfProfile(updatedUser: SystemUser): Promise<AuthSession | null> {
    if (!inMemoryUser || inMemoryUser.id !== updatedUser.id) {
      return null;
    }
    if (
      inMemoryUser.role !== updatedUser.role ||
      (inMemoryUser.tenantId || '') !== (updatedUser.tenantId || '')
    ) {
      throw new Error('حظر أمني: لا يمكن تغيير الدور أو المؤسسة عبر تحديث الجلسة الذاتي.');
    }
    if (!updatedUser.active) {
      this.logout();
      return null;
    }
    return await this.issueSignedSession(updatedUser, updatedUser.tenantId);
  }

  /**
   * قراءة الجلسة من الذاكرة أو localStorage والتحقق من توقيعها وصلاحيتها ضد سجل المستخدم الحقيقي
   */
  public async validateSession(
    users: SystemUser[],
    nowMs: number = Date.now()
  ): Promise<{ valid: boolean; user?: SystemUser; session?: AuthSession; reason?: string }> {
    let rawSession: AuthSession | null = null;

    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(AUTH_SESSION_KEY);
      if (raw) {
        try {
          rawSession = JSON.parse(raw) as AuthSession;
        } catch {
          this.logout();
          return { valid: false, reason: 'تنسيق الجلسة غير صالح.' };
        }
      }
    } else {
      rawSession = inMemorySession;
    }

    if (!rawSession) {
      return { valid: false, reason: 'لا توجد جلسة نشطة.' };
    }

    const expiresMs = Date.parse(rawSession.expiresAt);
    if (!Number.isFinite(expiresMs) || nowMs >= expiresMs) {
      this.logout();
      return { valid: false, reason: 'انتهت صلاحية الجلسة، يرجى إعادة تسجيل الدخول.' };
    }

    const { signature, ...rest } = rawSession;
    if (!signature) {
      this.logout();
      return { valid: false, reason: 'الجلسة غير موقعة.' };
    }

    const isSigValid = await verifyWithKey(
      SESSION_KEY_ID,
      canonicalSessionPayload(rest),
      signature
    );
    if (!isSigValid) {
      this.logout();
      return { valid: false, reason: 'تم اكتشاف تعديل غير مصرح به في بيانات الجلسة.' };
    }

    // التحقق المتقاطع مع سجل المستخدم المعتمد في قاعدة البيانات
    const authoritativeUser = users.find((u) => u.id === rawSession!.userId);
    if (!authoritativeUser || !authoritativeUser.active) {
      this.logout();
      return { valid: false, reason: 'الحساب غير موجود أو تم إيقافه.' };
    }

    const dbTenant = authoritativeUser.tenantId?.trim() || '';
    if (
      !dbTenant ||
      authoritativeUser.role !== rawSession.role ||
      authoritativeUser.username !== rawSession.username ||
      dbTenant !== rawSession.tenantId
    ) {
      this.logout();
      return { valid: false, reason: 'بيانات الصلاحية في الجلسة لا تطابق السجل المعتمد.' };
    }

    const resolvedBranch =
      authoritativeUser.branchId?.trim() ||
      authoritativeUser.allowedBranches?.[0]?.trim() ||
      rawSession.branchId;
    const resolvedAllowedBranches =
      authoritativeUser.allowedBranches && authoritativeUser.allowedBranches.length > 0
        ? authoritativeUser.allowedBranches
        : [resolvedBranch];

    inMemorySession = rawSession;
    inMemoryUser = {
      ...authoritativeUser,
      tenantId: dbTenant,
      branchId: resolvedBranch,
      allowedBranches: resolvedAllowedBranches,
    };

    return { valid: true, user: inMemoryUser, session: rawSession };
  }

  /**
   * مصادقة تسجيل الدخول مع قفل مؤقت عند تكرار المحاولات الفاشلة
   */
  public async authenticate(params: {
    username: string;
    password: string;
    users: SystemUser[];
    onUserUpdated: (updatedUser: SystemUser) => Promise<void> | void;
    nowMs?: number;
  }): Promise<{
    success: boolean;
    user?: SystemUser;
    session?: AuthSession;
    error?: string;
    lockedUntil?: string;
  }> {
    const { username, password, users, onUserUpdated } = params;
    const nowMs = params.nowMs ?? Date.now();
    const normalizedUsername = username.trim().toLowerCase();

    if (!normalizedUsername || !password) {
      return { success: false, error: 'يرجى إدخال اسم المستخدم وكلمة المرور.' };
    }

    const user = users.find((u) => u.username.toLowerCase() === normalizedUsername);
    if (!user) {
      return { success: false, error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' };
    }

    if (!user.active) {
      return { success: false, error: 'هذا الحساب موقوف. تواصل مع المدير العام.' };
    }

    if (user.lockedUntil) {
      const lockExpiry = Date.parse(user.lockedUntil);
      if (Number.isFinite(lockExpiry) && nowMs < lockExpiry) {
        const remainingSec = Math.ceil((lockExpiry - nowMs) / 1000);
        return {
          success: false,
          error: `الحساب مقفل مؤقتاً بسبب محاولات دخول فاشلة متكررة. حاول بعد ${remainingSec} ثانية.`,
          lockedUntil: user.lockedUntil,
        };
      }
    }

    // رفض الحسابات التي لا تملك كلمة مرور مضبوطة قطعياً
    if (!user.passwordHash) {
      return {
        success: false,
        error: 'لم يتم تعيين كلمة مرور لهذا الحساب بعد. يرجى ضبط كلمة مرور من مدير النظام.',
      };
    }

    const isMatch = await verifyPassword(password, user.passwordHash);
    if (!isMatch) {
      const attempts = (user.failedLoginAttempts || 0) + 1;
      const shouldLock = attempts >= MAX_FAILED_ATTEMPTS;
      const lockedUntil = shouldLock ? new Date(nowMs + LOCKOUT_DURATION_MS).toISOString() : undefined;

      const updated: SystemUser = {
        ...user,
        failedLoginAttempts: attempts,
        lockedUntil,
        updatedAt: new Date(nowMs).toISOString(),
      };
      await onUserUpdated(updated);

      if (shouldLock) {
        return {
          success: false,
          error: 'تم تجاوز الحد الأقصى للمحاولات الفاشلة (5 محاولات). تم قفل الحساب لمدة 5 دقائق.',
          lockedUntil,
        };
      }

      return {
        success: false,
        error: `كلمة المرور غير صحيحة. المحاولات المتبقية قبل القفل: ${MAX_FAILED_ATTEMPTS - attempts}.`,
      };
    }

    const resolvedTenant = user.tenantId?.trim() || '';
    const resolvedBranch = user.branchId?.trim() || user.allowedBranches?.[0]?.trim() || '';
    if (!resolvedTenant || !resolvedBranch) {
      return {
        success: false,
        error: 'حظر أمني: حساب المستخدم يفتقر إلى ربط المؤسسة أو الفرع.',
      };
    }

    const cleanUser: SystemUser = {
      ...user,
      failedLoginAttempts: 0,
      lockedUntil: undefined,
      tenantId: resolvedTenant,
      branchId: resolvedBranch,
      allowedBranches:
        user.allowedBranches && user.allowedBranches.length > 0
          ? user.allowedBranches
          : [resolvedBranch],
      updatedAt: new Date(nowMs).toISOString(),
    };
    await onUserUpdated(cleanUser);

    if (cleanUser.mustChangePassword) {
      // في وضع التغيير الإلزامي، نحفظ هوية المستخدم فقط لتسجيل التغيير ولا نمنح جلسة كاملة قبل التحديث
      inMemoryUser = cleanUser;
      return { success: true, user: cleanUser };
    }

    const session = await this.issueSignedSession(cleanUser, cleanUser.tenantId);
    return { success: true, user: cleanUser, session };
  }

  /**
   * توقيع ملف النسخة الاحتياطية بـ HMAC-SHA256 (SEC-07)
   */
  public async signBackupPayload(canonicalJson: string): Promise<string> {
    return await signWithKey(BACKUP_KEY_ID, canonicalJson);
  }

  /**
   * التحقق الصارم من توقيع النسخة الاحتياطية بـ HMAC-SHA256 (SEC-07)
   */
  public async verifyBackupPayload(canonicalJson: string, hmacHex: string): Promise<boolean> {
    if (!hmacHex || typeof hmacHex !== 'string') return false;
    return await verifyWithKey(BACKUP_KEY_ID, canonicalJson, hmacHex);
  }

  public getCurrentSessionSync(): AuthSession | null {
    if (typeof window !== 'undefined' && window.amroDesktop) {
      const actor = desktopSession.getActor();
      const token = desktopSession.getToken();
      if (!actor || !token) return null;
      const activeBranch = desktopSession.getActiveBranchId() || actor.branchId || 'branch_main';
      return {
        userId: actor.id,
        username: actor.username,
        role: actor.role,
        tenantId: actor.tenantId?.trim() || 'tenant_main',
        branchId: activeBranch,
        allowedBranches:
          actor.allowedBranches && actor.allowedBranches.length > 0
            ? actor.allowedBranches
            : [activeBranch],
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        signature: 'electron_main_process_session',
      };
    }
    if (inMemorySession) {
      const exp = Date.parse(inMemorySession.expiresAt);
      if (Number.isFinite(exp) && Date.now() < exp) {
        return inMemorySession;
      }
      inMemorySession = null;
    }
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(AUTH_SESSION_KEY);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as AuthSession;
          const exp = Date.parse(parsed.expiresAt);
          if (Number.isFinite(exp) && Date.now() < exp && parsed.signature) {
            inMemorySession = parsed;
            return parsed;
          }
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  public getCurrentActorSync(): SystemUser | null {
    if (typeof window !== 'undefined' && window.amroDesktop) {
      return desktopSession.getActor();
    }
    return inMemoryUser;
  }

  public getActiveTenantIdSync(): string | null {
    if (typeof window !== 'undefined' && window.amroDesktop) {
      return desktopSession.getActor()?.tenantId?.trim() || null;
    }
    const sess = this.getCurrentSessionSync();
    if (sess?.tenantId?.trim()) return sess.tenantId.trim();
    if (inMemoryUser?.tenantId?.trim()) return inMemoryUser.tenantId.trim();
    return null;
  }

  public logout(): void {
    inMemorySession = null;
    inMemoryUser = null;
    if (typeof window !== 'undefined' && window.amroDesktop) {
      desktopSession.clear();
      return;
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(AUTH_SESSION_KEY);
      localStorage.removeItem('multi_activity_erp_current_user');
    }
  }
}

export const authService = new AuthService();
