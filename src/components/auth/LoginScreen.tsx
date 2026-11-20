/**
 * شاشة تسجيل الدخول والإعداد الأمني الأولي — نظام الإدارة التجارية والمحاسبية المتكامل
 * تعالج SEC-01:
 * - إزالة كلمة المرور الافتراضية '1234' وأزرار الدخول السريع بالكامل.
 * - إلزام تهيئة كلمة مرور قوية للمدير العام عند أول تشغيل للنظام.
 * - التحقق عبر PBKDF2-SHA256 وقفل الحساب بعد 5 محاولات فاشلة.
 * - فرض تغيير كلمة المرور للمستخدمين المعينين حديثاً (mustChangePassword).
 */

import React, { useState } from 'react';
import {
  Building2,
  Eye,
  EyeOff,
  Lock,
  User,
  LogIn,
  AlertCircle,
  ShieldCheck,
  RefreshCw,
} from 'lucide-react';
import { db } from '../../db/erpDatabase';
import {
  authService,
  needsInitialAdminSetup,
  validatePasswordStrength,
} from '../../services/authService';
import { dexieDataService } from '../../services/dexieDataService';
import { dataService } from '../../services/dataService';
import { storage } from '../../services/storageService';
import { useDexieInitStatus, useLiveUsers } from '../../hooks/useLiveDexie';
import { SystemUser } from '../../types/erp';

interface LoginScreenProps {
  onLogin: (user: SystemUser) => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLogin }) => {
  const initStatus = useDexieInitStatus();
  const liveUsers = useLiveUsers();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingPasswordChangeUser, setPendingPasswordChangeUser] = useState<SystemUser | null>(null);

  const isDbReady = initStatus.state === 'READY';
  const isFirstSetup = isDbReady && needsInitialAdminSetup(liveUsers);

  const handleInitialSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const adminUser = liveUsers.find((u) => u.role === 'ADMIN' && u.active);
    if (!adminUser) {
      setError('لا يوجد حساب مدير عام نشط في قاعدة البيانات لإتمام التهيئة.');
      return;
    }

    const strength = validatePasswordStrength(newPassword, adminUser.username);
    if (!strength.valid) {
      setError(strength.error || 'كلمة المرور لا تستوفي متطلبات الأمان.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('كلمتا المرور غير متطابقتين.');
      return;
    }

    setLoading(true);
    try {
      const { user: updatedAdmin } = await authService.completeInitialAdminSetup({
        users: liveUsers,
        newPassword,
        onSaveAdmin: async (updated) => {
          await db.users.put(updated);
        },
      });
      await storage.setCurrentUser(updatedAdmin);
      await dataService.logAction(
        'تهيئة أمنية أولى',
        `تم تعيين كلمة مرور المدير العام (${updatedAdmin.username}) لأول مرة.`
      );
      onLogin(updatedAdmin);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر حفظ كلمة المرور الأولية.');
    } finally {
      setLoading(false);
    }
  };

  const handleMandatoryPasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingPasswordChangeUser) return;
    setError(null);

    const strength = validatePasswordStrength(newPassword, pendingPasswordChangeUser.username);
    if (!strength.valid) {
      setError(strength.error || 'كلمة المرور لا تستوفي متطلبات الأمان.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('كلمتا المرور غير متطابقتين.');
      return;
    }

    setLoading(true);
    try {
      const { user: updatedUser } = await authService.completeMandatoryPasswordChange({
        user: pendingPasswordChangeUser,
        newPassword,
        onSaveUser: async (updated) => {
          await db.users.put(updated);
        },
      });
      await storage.setCurrentUser(updatedUser);
      await dataService.logAction(
        'تغيير كلمة مرور إلزامي',
        `تم تحديث كلمة المرور للمستخدم (${updatedUser.username}).`
      );
      setPendingPasswordChangeUser(null);
      onLogin(updatedUser);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحديث كلمة المرور.');
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isDbReady) return;

    setError(null);
    setLoading(true);

    try {
      const result = await authService.authenticate({
        username,
        password,
        users: liveUsers,
        onUserUpdated: async (updatedUser) => {
          await db.users.put(updatedUser);
        },
      });

      if (!result.success || !result.user) {
        setError(result.error || 'فشل تسجيل الدخول.');
        return;
      }

      if (result.user.mustChangePassword) {
        setPendingPasswordChangeUser(result.user);
        setNewPassword('');
        setConfirmPassword('');
        return;
      }

      await storage.setCurrentUser(result.user);
      await dataService.logAction(
        'تسجيل دخول',
        `دخول المستخدم ${result.user.fullName} (${result.user.role})`
      );
      onLogin(result.user);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'حدث خطأ غير متوقع أثناء المصادقة.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen w-full flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-emerald-900 p-4"
      dir="rtl"
    >
      <div className="w-full max-w-sm">
        {/* الشعار والعنوان */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-500 shadow-lg shadow-emerald-500/30 mb-4">
            <Building2 className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-xl font-bold text-white mb-1">نظام الإدارة التجارية</h1>
          <p className="text-sm text-slate-400">والمحاسبية المتكامل — ERP</p>
        </div>

        {/* بطاقة الدخول */}
        <div className="bg-white rounded-2xl shadow-2xl p-6 space-y-5">
          {initStatus.state === 'FAILED' ? (
            <div className="text-center space-y-4 py-2">
              <div className="w-12 h-12 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center mx-auto">
                <AlertCircle className="w-6 h-6" />
              </div>
              <h2 className="text-sm font-bold text-slate-900">فشل تهيئة قاعدة البيانات المحلية</h2>
              <p className="text-xs text-slate-600">{initStatus.error || 'يرجى إعادة المحاولة.'}</p>
              <button
                type="button"
                onClick={() => {
                  dexieDataService.resetForTests();
                  dexieDataService.initialize().catch(() => {});
                }}
                className="w-full flex items-center justify-center gap-2 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                <span>إعادة المحاولة</span>
              </button>
            </div>
          ) : !isDbReady ? (
            <div className="text-center py-8 space-y-3">
              <div className="w-8 h-8 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin mx-auto" />
              <p className="text-xs font-semibold text-slate-600">جارٍ تهيئة قاعدة البيانات المحاسبية الآمنة...</p>
            </div>
          ) : isFirstSetup ? (
            <>
              <div className="text-center border-b border-slate-100 pb-4 space-y-1">
                <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-emerald-100 text-emerald-700 mb-1">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <h2 className="text-base font-bold text-slate-900">تهيئة كلمة مرور المدير العام</h2>
                <p className="text-[11px] text-slate-500">
                  التشغيل الأول: أدخل كلمة مرور قوية لحساب المدير (<span className="font-mono font-bold">admin</span>)
                </p>
              </div>

              <form onSubmit={handleInitialSetup} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700 block">كلمة المرور الجديدة (8 خانات فأكثر، حروف + أرقام)</label>
                  <div className="relative">
                    <Lock className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="مثال: StrongPass#2026"
                      required
                      autoFocus
                      className="w-full pr-10 pl-10 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-slate-50 text-slate-900"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                      tabIndex={-1}
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700 block">تأكيد كلمة المرور</label>
                  <div className="relative">
                    <Lock className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="أعد كتابة كلمة المرور"
                      required
                      className="w-full pr-10 pl-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-slate-50 text-slate-900"
                    />
                  </div>
                </div>

                {error && (
                  <div className="flex items-center gap-2 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl px-3 py-2.5">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-2 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white text-sm font-bold rounded-xl transition-colors shadow-sm"
                >
                  <ShieldCheck className="w-4 h-4" />
                  <span>{loading ? 'جارٍ الحفظ...' : 'اعتماد كلمة المرور والدخول'}</span>
                </button>
              </form>
            </>
          ) : pendingPasswordChangeUser ? (
            <>
              <div className="text-center border-b border-slate-100 pb-4 space-y-1">
                <h2 className="text-base font-bold text-slate-900">تحديث كلمة المرور الإلزامي</h2>
                <p className="text-[11px] text-slate-500">
                  يرجى تعيين كلمة مرور جديدة خاصة بالحساب (@{pendingPasswordChangeUser.username}) قبل المتابعة
                </p>
              </div>

              <form onSubmit={handleMandatoryPasswordChange} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700 block">كلمة المرور الجديدة</label>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    autoFocus
                    className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-slate-50 text-slate-900"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700 block">تأكيد كلمة المرور</label>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-slate-50 text-slate-900"
                  />
                </div>

                {error && (
                  <div className="flex items-center gap-2 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl px-3 py-2.5">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-2 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold rounded-xl transition-colors"
                >
                  <span>{loading ? 'جارٍ التحديث...' : 'حفظ ودخول للنظام'}</span>
                </button>
              </form>
            </>
          ) : (
            <>
              <h2 className="text-base font-bold text-slate-900 text-center border-b border-slate-100 pb-4">
                تسجيل الدخول
              </h2>

              <form onSubmit={handleLogin} className="space-y-4">
                {/* اسم المستخدم */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700 block">اسم المستخدم</label>
                  <div className="relative">
                    <User className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="اسم المستخدم"
                      required
                      autoFocus
                      className="w-full pr-10 pl-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent bg-slate-50 text-slate-900 placeholder-slate-400"
                    />
                  </div>
                </div>

                {/* كلمة المرور */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700 block">كلمة المرور</label>
                  <div className="relative">
                    <Lock className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      required
                      className="w-full pr-10 pl-10 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent bg-slate-50 text-slate-900"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                      tabIndex={-1}
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* رسالة الخطأ */}
                {error && (
                  <div className="flex items-center gap-2 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl px-3 py-2.5">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                {/* زر الدخول */}
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-2 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white text-sm font-bold rounded-xl transition-colors shadow-sm"
                >
                  {loading ? (
                    <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                    </svg>
                  ) : (
                    <LogIn className="w-4 h-4" />
                  )}
                  {loading ? 'جارٍ التحقق...' : 'دخول للنظام'}
                </button>
              </form>
            </>
          )}
        </div>

        <p className="text-center text-xs text-slate-500 mt-6">نظام ERP متكامل · مصادقة آمنة ويعمل بدون إنترنت 🔒</p>
      </div>
    </div>
  );
};
