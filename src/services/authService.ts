/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * خدمة المصادقة الآمنة وتجزئة كلمات المرور وإدارة الجلسات الموقعة (Auth Service)
 * تعالج SEC-01 و SEC-02 و SYNC-05:
 * - إزالة كلمة المرور الافتراضية '1234' بالكامل.
 * - اشتقاق وتخزين كلمات المرور عبر PBKDF2-SHA256 (100,000 تكرار + Salt عشوائي).
 * - قفل مؤقت للحساب بعد 5 محاولات فاشلة.
 * - جلسة موقعة بـ HMAC-SHA256 وتحقّق متقاطع ضد سجل المستخدم المعتمد في Dexie.
 */

import { AuthSession, SystemUser } from '../types/erp';

const AUTH_SESSION_KEY = 'multi_activity_erp_auth_session';
const SESSION_HMAC_KEY_STORAGE = 'multi_activity_erp_session_hmac_secret';
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
let inMemorySecret: string | null = null;

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

function getOrCreateHmacSecret(): string {
  if (inMemorySecret) return inMemorySecret;

  if (typeof localStorage !== 'undefined') {
    const existing = localStorage.getItem(SESSION_HMAC_KEY_STORAGE);
    if (existing && existing.length >= 32) {
      inMemorySecret = existing;
      return existing;
    }
  }

  const randomBytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(randomBytes);
  const generated = bytesToHex(randomBytes);
  inMemorySecret = generated;

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(SESSION_HMAC_KEY_STORAGE, generated);
  }
  return generated;
}

async function signPayload(payload: string): Promise<string> {
  const subtle = getSubtleCrypto();
  const enc = new TextEncoder();
  const key = await subtle.importKey(
    'raw',
    enc.encode(getOrCreateHmacSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await subtle.sign('HMAC', key, enc.encode(payload));
  return bytesToHex(new Uint8Array(sig));
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

  const subtle = getSubtleCrypto();
  const enc = new TextEncoder();
  const keyMaterial = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const derivedBits = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: hexToBytes(saltHex) as BufferSource,
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
   * إنشاء جلسة مصادق عليها وتوقيعها بـ HMAC-SHA256
   */
  public async createSession(
    user: SystemUser,
    tenantId?: string,
    ttlMs: number = DEFAULT_SESSION_TTL_MS
  ): Promise<AuthSession> {
    const resolvedTenantId = tenantId?.trim() || user.tenantId?.trim() || 'tenant_main';
    const resolvedBranchId = user.branchId?.trim() || user.allowedBranches?.[0] || 'branch_main';
    const allowedBranches =
      user.allowedBranches && user.allowedBranches.length > 0
        ? user.allowedBranches
        : [resolvedBranchId];

    const now = Date.now();
    const baseSession: Omit<AuthSession, 'signature'> = {
      userId: user.id,
      username: user.username,
      role: user.role,
      tenantId: resolvedTenantId,
      branchId: resolvedBranchId,
      allowedBranches,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };

    const signature = await signPayload(canonicalSessionPayload(baseSession));
    const fullSession: AuthSession = { ...baseSession, signature };

    inMemorySession = fullSession;
    inMemoryUser = {
      ...user,
      tenantId: resolvedTenantId,
      branchId: resolvedBranchId,
      allowedBranches,
    };

    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(fullSession));
    }

    return fullSession;
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

    const expectedSig = await signPayload(canonicalSessionPayload(rest));
    if (!constantTimeEqual(signature, expectedSig)) {
      this.logout();
      return { valid: false, reason: 'تم اكتشاف تعديل غير مصرح به في بيانات الجلسة.' };
    }

    // التحقق المتقاطع مع سجل المستخدم المعتمد في قاعدة البيانات
    const authoritativeUser = users.find((u) => u.id === rawSession!.userId);
    if (!authoritativeUser || !authoritativeUser.active) {
      this.logout();
      return { valid: false, reason: 'الحساب غير موجود أو تم إيقافه.' };
    }

    const dbTenant = authoritativeUser.tenantId?.trim() || 'tenant_main';
    if (
      authoritativeUser.role !== rawSession.role ||
      authoritativeUser.username !== rawSession.username ||
      dbTenant !== rawSession.tenantId
    ) {
      this.logout();
      return { valid: false, reason: 'بيانات الصلاحية في الجلسة لا تطابق السجل المعتمد.' };
    }

    inMemorySession = rawSession;
    inMemoryUser = {
      ...authoritativeUser,
      tenantId: dbTenant,
      branchId: authoritativeUser.branchId || rawSession.branchId,
      allowedBranches: authoritativeUser.allowedBranches || rawSession.allowedBranches,
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

    const cleanUser: SystemUser = {
      ...user,
      failedLoginAttempts: 0,
      lockedUntil: undefined,
      tenantId: user.tenantId || 'tenant_main',
      updatedAt: new Date(nowMs).toISOString(),
    };
    await onUserUpdated(cleanUser);

    const session = await this.createSession(cleanUser, cleanUser.tenantId);
    return { success: true, user: cleanUser, session };
  }

  public getCurrentSessionSync(): AuthSession | null {
    if (inMemorySession) {
      const exp = Date.parse(inMemorySession.expiresAt);
      if (Number.isFinite(exp) && Date.now() < exp) {
        return inMemorySession;
      }
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
    return inMemoryUser;
  }

  public setCurrentActorSync(user: SystemUser | null): void {
    inMemoryUser = user;
  }

  public getActiveTenantIdSync(): string | null {
    const sess = this.getCurrentSessionSync();
    if (sess?.tenantId) return sess.tenantId;
    if (inMemoryUser?.tenantId) return inMemoryUser.tenantId;
    return null;
  }

  /**
   * حقن جلسة مصادق عليها برمجياً لبيئات الاختبار والتشغيل المصرح
   */
  public async setAuthenticatedUserForSession(
    user: SystemUser,
    tenantId?: string
  ): Promise<AuthSession> {
    return await this.createSession(user, tenantId || user.tenantId || 'tenant_main');
  }

  public logout(): void {
    inMemorySession = null;
    inMemoryUser = null;
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(AUTH_SESSION_KEY);
      localStorage.removeItem('multi_activity_erp_current_user');
    }
  }
}

export const authService = new AuthService();
