/**
 * شاشة تسجيل الدخول — نظام الإدارة التجارية والمحاسبية المتكامل
 */

import React, { useState } from 'react';
import { Building2, Eye, EyeOff, Lock, User, LogIn, AlertCircle } from 'lucide-react';
import { storage } from '../../services/storageService';
import { SystemUser } from '../../types/erp';

interface LoginScreenProps {
  onLogin: (user: SystemUser) => void;
}

const DEFAULT_PASSWORD = '1234';

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLogin }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    await new Promise((r) => setTimeout(r, 400));

    const users = storage.getUsers();
    const user = users.find((u) => u.username === username.trim());

    if (!user) {
      setError('اسم المستخدم غير موجود في النظام.');
      setLoading(false);
      return;
    }

    if (!user.active) {
      setError('هذا الحساب موقوف. تواصل مع المدير.');
      setLoading(false);
      return;
    }

    const expectedPassword = user.password || DEFAULT_PASSWORD;
    if (password !== expectedPassword) {
      setError('كلمة المرور غير صحيحة. حاول مرة أخرى.');
      setLoading(false);
      return;
    }

    storage.setCurrentUser(user);
    storage.logAction('تسجيل دخول', `دخول المستخدم ${user.fullName} (${user.role})`);
    onLogin(user);
  };

  const roleLabel: Record<string, string> = {
    ADMIN: 'مدير',
    ACCOUNTANT: 'محاسب',
    CASHIER: 'كاشير',
    INVENTORY_KEEPER: 'أمين مخزن',
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
                  placeholder="admin"
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
                  placeholder="••••••"
                  required
                  className="w-full pr-10 pl-10 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent bg-slate-50 text-slate-900"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
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

          {/* حسابات سريعة */}
          <div className="border-t border-slate-100 pt-4">
            <p className="text-[10px] text-slate-400 text-center mb-2">دخول سريع (كلمة المرور الافتراضية: 1234)</p>
            <div className="grid grid-cols-3 gap-1.5">
              {[
                { username: 'admin', role: 'ADMIN' },
                { username: 'accountant', role: 'ACCOUNTANT' },
                { username: 'cashier', role: 'CASHIER' },
              ].map((u) => (
                <button
                  key={u.username}
                  type="button"
                  onClick={() => { setUsername(u.username); setPassword(DEFAULT_PASSWORD); setError(null); }}
                  className="text-[10px] py-1.5 px-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors font-medium"
                >
                  {u.username}
                  <span className="block text-[9px] text-slate-500">{roleLabel[u.role]}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <p className="text-center text-xs text-slate-500 mt-6">نظام ERP متكامل · يعمل بدون إنترنت 🔒</p>
      </div>
    </div>
  );
};
