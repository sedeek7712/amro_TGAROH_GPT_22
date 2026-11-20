import React, { useEffect, useState } from 'react';
import { AlertCircle, Building2, Eye, EyeOff, KeyRound, Lock, LogIn, ShieldCheck } from 'lucide-react';
import { validatePasswordStrength } from '../../services/authService';
import { desktopAuthAdapter } from '../../services/desktopAuthAdapter';
import type { CommercialActivityId, SystemUser, UserRole } from '../../types/erp';

interface DesktopLoginScreenProps {
  onLogin: (user: SystemUser, token: string) => void;
}

type SetupStatus = { setupRequired: boolean; userCount: number };

function toSystemUser(user: NonNullable<Awaited<ReturnType<typeof desktopAuthAdapter.login>>['user']>): SystemUser {
  return {
    id: user.id,
    tenantId: user.tenantId,
    username: user.username,
    fullName: user.fullName,
    role: user.role as UserRole,
    allowedActivities: user.allowedActivities.filter(
      (value): value is CommercialActivityId =>
        ['pharmacy', 'grocery', 'bike_parts', 'equipment_parts'].includes(value)
    ),
    branchId: user.branchId,
    allowedBranches: [...user.allowedBranches],
    active: user.active,
    mustChangePassword: user.mustChangePassword,
    failedLoginAttempts: user.failedLoginAttempts,
  };
}

export const DesktopLoginScreen: React.FC<DesktopLoginScreenProps> = ({ onLogin }) => {
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [username, setUsername] = useState('admin');
  const [fullName, setFullName] = useState('مدير النظام');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [limitedToken, setLimitedToken] = useState('');
  const [pendingUser, setPendingUser] = useState<SystemUser | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    desktopAuthAdapter.getSetupStatus()
      .then((status) => { if (active) setSetup(status); })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'تعذر فحص قاعدة SQLite.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const finishLogin = async (loginPassword: string) => {
    const result = await desktopAuthAdapter.login({ username, password: loginPassword });
    if (!result.success || !result.user || !result.token) {
      throw new Error(result.error || 'تعذر تسجيل الدخول.');
    }
    const user = toSystemUser(result.user);
    if (result.mustChangePassword || result.user.mustChangePassword) {
      setPendingUser(user);
      setLimitedToken(result.token);
      setNewPassword('');
      setConfirmPassword('');
      return;
    }
    onLogin(user, result.token);
  };

  const handleSetup = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    const strength = validatePasswordStrength(password, username);
    if (!strength.valid) {
      setError(strength.error || 'كلمة المرور غير كافية.');
      return;
    }
    if (password !== confirmPassword) {
      setError('كلمتا المرور غير متطابقتين.');
      return;
    }
    setLoading(true);
    try {
      await desktopAuthAdapter.createInitialAdmin({ username, fullName, password });
      await finishLogin(password);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر إعداد المدير الأولي.');
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      await finishLogin(password);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'حدث خطأ أثناء تسجيل الدخول.');
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordChange = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) {
      setError('كلمتا المرور غير متطابقتين.');
      return;
    }
    const strength = validatePasswordStrength(newPassword, pendingUser?.username);
    if (!strength.valid) {
      setError(strength.error || 'كلمة المرور غير كافية.');
      return;
    }
    setLoading(true);
    try {
      const result = await desktopAuthAdapter.completeMandatoryPasswordChange({
        token: limitedToken,
        newPassword,
      });
      if (!result.success || !result.user || !result.token) {
        throw new Error(result.error || 'تعذر إكمال تغيير كلمة المرور.');
      }
      onLogin(toSystemUser(result.user), result.token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر تحديث كلمة المرور.');
    } finally {
      setLoading(false);
    }
  };

  const inputClass = 'w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100';
  const isFirstSetup = setup?.setupRequired === true && setup.userCount === 0;

  return (
    <div dir="rtl" className="min-h-screen w-full flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-emerald-950 p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500 shadow-lg">
            <Building2 className="h-8 w-8 text-white" />
          </div>
          <h1 className="text-xl font-bold text-white">نظام عمرو النماري</h1>
          <p className="mt-1 text-xs text-slate-400">تسجيل دخول Windows — قاعدة SQLite المحلية</p>
        </div>
        <section className="space-y-4 rounded-2xl bg-white p-6 shadow-2xl">
          {loading && !setup ? (
            <p className="py-8 text-center text-sm text-slate-600">جارٍ الاتصال بقاعدة البيانات المحلية...</p>
          ) : pendingUser ? (
            <>
              <div className="text-center">
                <KeyRound className="mx-auto mb-2 h-8 w-8 text-emerald-600" />
                <h2 className="font-bold text-slate-900">تغيير كلمة المرور مطلوب</h2>
                <p className="mt-1 text-xs text-slate-500">يجب تعيين كلمة مرور جديدة قبل دخول النظام.</p>
              </div>
              <form onSubmit={handlePasswordChange} className="space-y-3">
                <input className={inputClass} type={showPassword ? 'text' : 'password'} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="كلمة المرور الجديدة" required autoComplete="new-password" />
                <input className={inputClass} type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="تأكيد كلمة المرور" required autoComplete="new-password" />
                <button type="button" onClick={() => setShowPassword((value) => !value)} className="text-xs text-slate-500">{showPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}</button>
                <button disabled={loading} className="w-full rounded-xl bg-emerald-600 py-3 text-sm font-bold text-white disabled:opacity-50">حفظ كلمة المرور والمتابعة</button>
              </form>
            </>
          ) : isFirstSetup ? (
            <>
              <div className="text-center">
                <ShieldCheck className="mx-auto mb-2 h-8 w-8 text-emerald-600" />
                <h2 className="font-bold text-slate-900">إعداد المدير الأول</h2>
                <p className="mt-1 text-xs text-slate-500">هذه قاعدة جديدة. أنشئ حساب المدير وكلمة مروره.</p>
              </div>
              <form onSubmit={handleSetup} className="space-y-3">
                <label className="block space-y-1 text-xs font-semibold text-slate-700">اسم المستخدم
                  <input className={inputClass} value={username} onChange={(event) => setUsername(event.target.value)} required minLength={3} maxLength={40} autoComplete="username" />
                </label>
                <label className="block space-y-1 text-xs font-semibold text-slate-700">اسم المدير
                  <input className={inputClass} value={fullName} onChange={(event) => setFullName(event.target.value)} required minLength={3} maxLength={100} />
                </label>
                <label className="block space-y-1 text-xs font-semibold text-slate-700">كلمة المرور (8 خانات فأكثر)
                  <input className={inputClass} type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="new-password" />
                </label>
                <label className="block space-y-1 text-xs font-semibold text-slate-700">تأكيد كلمة المرور
                  <input className={inputClass} type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required autoComplete="new-password" />
                </label>
                <button type="button" onClick={() => setShowPassword((value) => !value)} className="text-xs text-slate-500">{showPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}</button>
                <button disabled={loading} className="w-full rounded-xl bg-emerald-600 py-3 text-sm font-bold text-white disabled:opacity-50">إنشاء المدير والدخول</button>
              </form>
            </>
          ) : setup?.setupRequired && setup.userCount > 0 ? (
            <div className="py-3 text-center">
              <AlertCircle className="mx-auto mb-2 h-8 w-8 text-amber-600" />
              <h2 className="font-bold text-slate-900">تحتاج القاعدة إلى استيراد آمن</h2>
              <p className="mt-2 text-xs leading-6 text-slate-600">توجد حسابات مستخدمين في قاعدة SQLite لكنها غير مهيأة للمصادقة المكتبية. لن ننشئ مديرًا جديدًا فوقها. يلزم استيراد نسخة بيانات معتمدة أو معالجة حسابات المستخدمين أولًا.</p>
            </div>
          ) : (
            <>
              <div className="text-center">
                <Lock className="mx-auto mb-2 h-8 w-8 text-emerald-600" />
                <h2 className="font-bold text-slate-900">تسجيل الدخول</h2>
              </div>
              <form onSubmit={handleLogin} className="space-y-3">
                <label className="block space-y-1 text-xs font-semibold text-slate-700">اسم المستخدم
                  <input className={inputClass} value={username} onChange={(event) => setUsername(event.target.value)} required autoComplete="username" />
                </label>
                <label className="block space-y-1 text-xs font-semibold text-slate-700">كلمة المرور
                  <input className={inputClass} type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="current-password" />
                </label>
                <button type="button" onClick={() => setShowPassword((value) => !value)} className="text-xs text-slate-500">{showPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}</button>
                <button disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 text-sm font-bold text-white disabled:opacity-50"><LogIn className="h-4 w-4" />دخول للنظام</button>
              </form>
            </>
          )}
          {error && <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700"><AlertCircle className="h-4 w-4 shrink-0" /><span>{error}</span></div>}
          <p className="text-center text-[10px] text-slate-400">رمز الجلسة يبقى في ذاكرة التطبيق ولا يُحفظ في المتصفح.</p>
        </section>
      </div>
    </div>
  );
};
