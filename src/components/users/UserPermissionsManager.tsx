/**
 * إدارة المستخدمين والصلاحيات والرقابة (User & Roles Management)
 * متكاملة مع Dexie و PBKDF2 وعزل الفروع والأنشطة دون أي كلمات مرور ثابتة أو alert/prompt
 */

import React, { useState, useEffect } from 'react';
import {
  Plus,
  Key,
  Lock,
  CheckCircle,
  AlertCircle,
  X,
  Building2,
  Power,
} from 'lucide-react';
import { storage } from '../../services/storageService';
import { dataService } from '../../services/dataService';
import { hashPassword, validatePasswordStrength, verifyPassword } from '../../services/authService';
import { useLiveBranches, useLiveUsers } from '../../hooks/useLiveDexie';
import { SystemUser, UserRole, ActivityId } from '../../types/erp';

interface UserPermissionsManagerProps {
  currentUser: SystemUser;
  setCurrentUser: (user: SystemUser) => void;
  onRefresh: () => void;
}

export const UserPermissionsManager: React.FC<UserPermissionsManagerProps> = ({
  currentUser,
  setCurrentUser,
  onRefresh,
}) => {
  const liveUsers = useLiveUsers();
  const branches = useLiveBranches();
  const [users, setUsers] = useState<SystemUser[]>(liveUsers);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    setUsers(liveUsers);
  }, [liveUsers]);

  const [isAddUserModalOpen, setIsAddUserModalOpen] = useState(false);

  // حقول إضافة مستخدم
  const [newUsername, setNewUsername] = useState('');
  const [newFullName, setNewFullName] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('CASHIER');
  const [newPassword, setNewPassword] = useState('');
  const [newBranchId, setNewBranchId] = useState('branch_main');
  const [newAllowedBranches, setNewAllowedBranches] = useState<string[]>(['branch_main']);
  const [allowedActivities, setAllowedActivities] = useState<ActivityId[]>([
    'pharmacy',
    'grocery',
    'bike_parts',
    'equipment_parts',
  ]);

  // نافذة تأكيد تبديل الجلسة بكلمة مرور المدير
  const [switchTargetUser, setSwitchTargetUser] = useState<SystemUser | null>(null);
  const [adminVerifyPassword, setAdminVerifyPassword] = useState('');
  const [switchError, setSwitchError] = useState<string | null>(null);

  // نافذة تعيين / تغيير كلمة المرور لمستخدم
  const [passwordTargetUser, setPasswordTargetUser] = useState<SystemUser | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState('');
  const [resetPasswordConfirm, setResetPasswordConfirm] = useState('');
  const [resetPasswordError, setResetPasswordError] = useState<string | null>(null);

  const activities = storage.getActivities();

  const handleToggleActivity = async (userId: string, activityId: ActivityId) => {
    setStatusMessage(null);
    const target = users.find((u) => u.id === userId);
    if (!target) return;

    const hasIt = target.allowedActivities.includes(activityId);
    const newActivities = hasIt
      ? target.allowedActivities.filter((a) => a !== activityId)
      : [...target.allowedActivities, activityId];

    const updatedUser: SystemUser = { ...target, allowedActivities: newActivities };
    try {
      const saved = await dataService.saveUserAtomic(updatedUser);
      if (currentUser.id === userId) {
        await dataService.setCurrentUser(saved);
        setCurrentUser(saved);
      }
      setStatusMessage({ type: 'success', text: `تم تحديث الأنشطة المصرحة للحساب (@${saved.username}).` });
      onRefresh();
    } catch (err: unknown) {
      setStatusMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'فشل تحديث صلاحيات المستخدم.',
      });
    }
  };

  const handleToggleUserBranch = async (userId: string, branchId: string) => {
    setStatusMessage(null);
    const target = users.find((u) => u.id === userId);
    if (!target) return;

    const currentAllowed = target.allowedBranches && target.allowedBranches.length > 0
      ? target.allowedBranches
      : [target.branchId || 'branch_main'];
    const exists = currentAllowed.includes(branchId);
    const nextAllowed = exists
      ? currentAllowed.filter((b) => b !== branchId)
      : [...currentAllowed, branchId];

    if (nextAllowed.length === 0) {
      setStatusMessage({ type: 'error', text: 'يجب أن يبقى للمستخدم فرع واحد مصرح به على الأقل.' });
      return;
    }

    const updatedUser: SystemUser = {
      ...target,
      branchId: nextAllowed.includes(target.branchId || '') ? target.branchId : nextAllowed[0],
      allowedBranches: nextAllowed,
    };

    try {
      const saved = await dataService.saveUserAtomic(updatedUser);
      if (currentUser.id === userId) {
        await dataService.setCurrentUser(saved);
        setCurrentUser(saved);
      }
      setStatusMessage({ type: 'success', text: `تم تحديث الفروع المصرحة للحساب (@${saved.username}).` });
      onRefresh();
    } catch (err: unknown) {
      setStatusMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'فشل تحديث الفروع المصرحة.',
      });
    }
  };

  const handleToggleActive = async (user: SystemUser) => {
    setStatusMessage(null);
    if (user.id === currentUser.id) {
      setStatusMessage({ type: 'error', text: 'لا يمكنك إيقاف حسابك النشط حالياً.' });
      return;
    }
    try {
      await dataService.saveUserAtomic({ ...user, active: !user.active });
      setStatusMessage({
        type: 'success',
        text: user.active ? `تم إيقاف الحساب (@${user.username}).` : `تم تفعيل الحساب (@${user.username}).`,
      });
      onRefresh();
    } catch (err: unknown) {
      setStatusMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'فشل تغيير حالة الحساب.',
      });
    }
  };

  const handleSaveUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMessage(null);

    try {
      const created = await dataService.createUserAtomic({
        username: newUsername,
        fullName: newFullName,
        role: newRole,
        allowedActivities,
        branchId: newBranchId || branches[0]?.id || 'branch_main',
        allowedBranches:
          newAllowedBranches.length > 0
            ? newAllowedBranches
            : [newBranchId || branches[0]?.id || 'branch_main'],
        plainPassword: newPassword,
      });

      setIsAddUserModalOpen(false);
      setNewUsername('');
      setNewFullName('');
      setNewPassword('');
      setStatusMessage({
        type: 'success',
        text: `تم إنشاء حساب (${created.fullName}) بنجاح بتشفير PBKDF2-SHA256.`,
      });
      onRefresh();
    } catch (err: unknown) {
      setStatusMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'تعذر إنشاء المستخدم.',
      });
    }
  };

  const handleRequestSwitchUser = (targetId: string) => {
    if (targetId === currentUser.id) return;
    setStatusMessage(null);
    if (currentUser.role !== 'ADMIN') {
      setStatusMessage({ type: 'error', text: 'حظر أمني: لا يملك صلاحية تبديل المستخدمين إلا المدير العام للنظام.' });
      return;
    }
    const target = users.find((u) => u.id === targetId);
    if (!target) return;
    if (!target.active) {
      setStatusMessage({ type: 'error', text: 'لا يمكن التبديل إلى حساب موقوف.' });
      return;
    }
    setSwitchError(null);
    setAdminVerifyPassword('');
    setSwitchTargetUser(target);
  };

  const handleConfirmSwitchUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!switchTargetUser) return;
    setSwitchError(null);

    const isValidAdminPass = await verifyPassword(adminVerifyPassword, currentUser.passwordHash);
    if (!isValidAdminPass) {
      setSwitchError('كلمة مرور المدير العام غير صحيحة. تم حظر التبديل.');
      return;
    }

    try {
      await dataService.setCurrentUser(switchTargetUser);
      await dataService.logAction(
        'تبديل جلسة إداري',
        `قام المدير (${currentUser.username}) بتبديل الجلسة إلى (${switchTargetUser.username})`
      );
      setCurrentUser(switchTargetUser);
      setSwitchTargetUser(null);
      setAdminVerifyPassword('');
      setStatusMessage({
        type: 'success',
        text: `تم التحقق وتبديل الجلسة النشطة إلى: ${switchTargetUser.fullName}.`,
      });
      onRefresh();
    } catch (err: unknown) {
      setSwitchError(err instanceof Error ? err.message : 'فشل تبديل الجلسة.');
    }
  };

  const handleConfirmResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordTargetUser) return;
    setResetPasswordError(null);

    const strength = validatePasswordStrength(resetPasswordValue, passwordTargetUser.username);
    if (!strength.valid) {
      setResetPasswordError(strength.error || 'كلمة المرور ضعيفة.');
      return;
    }
    if (resetPasswordValue !== resetPasswordConfirm) {
      setResetPasswordError('كلمتا المرور غير متطابقتين.');
      return;
    }

    try {
      const passwordHash = await hashPassword(resetPasswordValue);
      const updated = await dataService.saveUserAtomic({
        ...passwordTargetUser,
        passwordHash,
        mustChangePassword: false,
        failedLoginAttempts: 0,
        lockedUntil: undefined,
      });
      if (currentUser.id === updated.id) {
        await dataService.setCurrentUser(updated);
        setCurrentUser(updated);
      }
      setPasswordTargetUser(null);
      setResetPasswordValue('');
      setResetPasswordConfirm('');
      setStatusMessage({
        type: 'success',
        text: `تم تعيين كلمة مرور جديدة ومشفرة للحساب (@${updated.username}).`,
      });
      onRefresh();
    } catch (err: unknown) {
      setResetPasswordError(err instanceof Error ? err.message : 'فشل تحديث كلمة المرور.');
    }
  };

  const roleLabels: Record<UserRole, { label: string; desc: string; color: string }> = {
    ADMIN: { label: 'مدير عام', desc: 'صلاحيات كاملة وغير مقيدة على كافة الأنشطة والحسابات والتقارير', color: 'bg-rose-100 text-rose-800' },
    ACCOUNTANT: { label: 'محاسب مالي', desc: 'الوصول للدفاتر المحاسبية، السندات، القيود، والقوائم المالية', color: 'bg-blue-100 text-blue-800' },
    CASHIER: { label: 'كاشير نقطة بيع', desc: 'إصدار فواتير البيع دون صلاحية الوصول للأرباح أو القيود الدفترية', color: 'bg-emerald-100 text-emerald-800' },
    INVENTORY_KEEPER: { label: 'أمين مستودع', desc: 'إدارة المخزون والتشغيلات والاستلام دون الاطلاع على الأرباح والماليات', color: 'bg-amber-100 text-amber-800' },
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Top Header */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold text-slate-900">إدارة المستخدمين ومصفوفة الصلاحيات (RBAC)</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            تطبيق أمان صارم: تشفير كلمات المرور PBKDF2 وعزل الفروع والأنشطة التجارية
          </p>
        </div>

        <button
          onClick={() => {
            setStatusMessage(null);
            setIsAddUserModalOpen(true);
          }}
          className="flex items-center gap-1.5 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-bold transition-colors shrink-0"
        >
          <Plus className="w-4 h-4 text-emerald-400" />
          <span>إضافة مستخدم جديد</span>
        </button>
      </div>

      {/* Inline Feedback Banner */}
      {statusMessage && (
        <div
          className={`p-3 rounded-xl border text-xs flex items-center justify-between gap-2 ${
            statusMessage.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          <div className="flex items-center gap-2">
            {statusMessage.type === 'success' ? (
              <CheckCircle className="w-4 h-4 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0" />
            )}
            <span className="font-semibold">{statusMessage.text}</span>
          </div>
          <button onClick={() => setStatusMessage(null)} className="text-slate-500 hover:text-slate-800">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Current Active User Switcher Bar */}
      <div className="bg-emerald-50 border border-emerald-200 p-4 rounded-xl flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2">
          <Key className="w-4 h-4 text-emerald-700" />
          <span className="text-emerald-900 font-bold">المستخدم المسجل حالياً بالجلسة:</span>
          <span className="font-extrabold text-slate-900 bg-white px-2.5 py-1 rounded border border-emerald-300">
            {currentUser.fullName} ({roleLabels[currentUser.role]?.label})
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-emerald-800 font-medium">تبديل الجلسة (يتطلب كلمة مرور المدير):</span>
          <select
            value={currentUser.id}
            onChange={(e) => handleRequestSwitchUser(e.target.value)}
            className="px-3 py-1.5 bg-white border border-emerald-300 rounded-lg text-xs font-bold text-slate-900 focus:outline-none"
          >
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName} ({roleLabels[u.role]?.label})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Users Cards & Permissions Matrix */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {users.map((user) => {
          const userBranches =
            user.allowedBranches && user.allowedBranches.length > 0
              ? user.allowedBranches
              : [user.branchId || 'branch_main'];
          return (
            <div
              key={user.id}
              className={`bg-white rounded-xl border p-5 shadow-sm space-y-4 ${
                currentUser.id === user.id ? 'border-emerald-500 ring-2 ring-emerald-500/10' : 'border-slate-200'
              } ${!user.active ? 'opacity-70' : ''}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-bold text-sm text-slate-900">{user.fullName}</h3>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${roleLabels[user.role]?.color}`}>
                      {roleLabels[user.role]?.label}
                    </span>
                    {!user.active && (
                      <span className="px-2 py-0.5 rounded bg-slate-200 text-slate-700 text-[10px] font-bold">
                        موقوف
                      </span>
                    )}
                    {!user.passwordHash && (
                      <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold">
                        بدون كلمة مرور
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-xs text-slate-500 mt-0.5">اسم الدخول: @{user.username}</div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {currentUser.id === user.id && (
                    <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-bold">
                      الجلسة النشطة
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setResetPasswordError(null);
                      setResetPasswordValue('');
                      setResetPasswordConfirm('');
                      setPasswordTargetUser(user);
                    }}
                    className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-bold flex items-center gap-1"
                    title="تعيين / تغيير كلمة المرور"
                  >
                    <Lock className="w-3 h-3" />
                    <span>كلمة المرور</span>
                  </button>
                  {user.id !== currentUser.id && (
                    <button
                      type="button"
                      onClick={() => handleToggleActive(user)}
                      className={`p-1 rounded text-[11px] font-bold ${
                        user.active
                          ? 'bg-rose-50 hover:bg-rose-100 text-rose-700'
                          : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700'
                      }`}
                      title={user.active ? 'إيقاف الحساب' : 'تفعيل الحساب'}
                    >
                      <Power className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              <p className="text-[11px] text-slate-600 bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                {roleLabels[user.role]?.desc}
              </p>

              {/* Allowed Commercial Activities */}
              <div>
                <div className="text-xs font-semibold text-slate-700 mb-2">
                  الأنشطة التجارية المصرح له بإدارتها:
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {activities.map((act) => {
                    const isChecked = user.allowedActivities.includes(act.id);
                    return (
                      <label
                        key={act.id}
                        className={`flex items-center gap-2 p-2 rounded-lg border text-xs cursor-pointer transition-all select-none ${
                          isChecked
                            ? 'bg-slate-50 border-slate-300 text-slate-900 font-semibold'
                            : 'bg-white border-slate-100 text-slate-400 opacity-60'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={user.role === 'ADMIN'}
                          onChange={() => handleToggleActivity(user.id, act.id)}
                          className="rounded text-emerald-600 focus:ring-emerald-500"
                        />
                        <span>{act.nameAr}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Allowed Branches */}
              {branches.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-slate-700 mb-2 flex items-center gap-1.5">
                    <Building2 className="w-3.5 h-3.5 text-slate-500" />
                    <span>الفروع المصرح بها:</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {branches.map((br) => {
                      const isAllowed = user.role === 'ADMIN' || userBranches.includes(br.id);
                      return (
                        <label
                          key={br.id}
                          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] cursor-pointer select-none ${
                            isAllowed
                              ? 'bg-emerald-50/70 border-emerald-300 text-emerald-900 font-semibold'
                              : 'bg-white border-slate-200 text-slate-400'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isAllowed}
                            disabled={user.role === 'ADMIN'}
                            onChange={() => handleToggleUserBranch(user.id, br.id)}
                            className="rounded text-emerald-600 focus:ring-emerald-500"
                          />
                          <span>{br.nameAr}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Modal: New User */}
      {isAddUserModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="relative w-full max-w-md bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
            <div className="flex items-center justify-between px-5 py-4 bg-slate-900 text-white">
              <h3 className="text-xs font-bold">إضافة مستخدم جديد للنظام</h3>
              <button onClick={() => setIsAddUserModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveUser} className="p-5 space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">اسم المستخدم للدخول (Username) *</label>
                <input
                  type="text"
                  required
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  placeholder="مثال: cashier1 / mohammed"
                  className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900 font-mono"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">الاسم الكامل للموظف *</label>
                <input
                  type="text"
                  required
                  value={newFullName}
                  onChange={(e) => setNewFullName(e.target.value)}
                  placeholder="مثال: محمد بن خالد"
                  className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">كلمة المرور الأولية (8 خانات فأكثر: حروف + أرقام) *</label>
                <input
                  type="password"
                  required
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="StrongPass#2026"
                  className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">الدور الوظيفي *</label>
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as UserRole)}
                    className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900 font-semibold"
                  >
                    <option value="CASHIER">كاشير نقطة بيع (POS)</option>
                    <option value="ACCOUNTANT">محاسب مالي عام</option>
                    <option value="INVENTORY_KEEPER">أمين مستودع ومخزون</option>
                    <option value="ADMIN">مدير عام للنظام</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">الفرع الأساسي *</label>
                  <select
                    value={newBranchId}
                    onChange={(e) => {
                      setNewBranchId(e.target.value);
                      if (!newAllowedBranches.includes(e.target.value)) {
                        setNewAllowedBranches([...newAllowedBranches, e.target.value]);
                      }
                    }}
                    className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900 font-semibold"
                  >
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.nameAr}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">الأنشطة المصرحة للمستخدم:</label>
                <div className="grid grid-cols-2 gap-1.5">
                  {activities.map((act) => {
                    const checked = allowedActivities.includes(act.id);
                    return (
                      <label key={act.id} className="flex items-center gap-1.5 p-1.5 border border-slate-200 rounded cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setAllowedActivities((prev) =>
                              checked ? prev.filter((id) => id !== act.id) : [...prev, act.id]
                            )
                          }
                        />
                        <span>{act.nameAr}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsAddUserModalOpen(false)}
                  className="px-3 py-1.5 border border-slate-200 rounded"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded"
                >
                  حفظ المستخدم
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Verify Admin Password Before Switching User */}
      {switchTargetUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="relative w-full max-w-sm bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
            <div className="flex items-center justify-between px-5 py-3.5 bg-slate-900 text-white">
              <h3 className="text-xs font-bold">مصادقة المدير لتبديل الجلسة</h3>
              <button onClick={() => setSwitchTargetUser(null)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleConfirmSwitchUser} className="p-5 space-y-3 text-xs">
              <p className="text-slate-700">
                أدخل كلمة مرور المدير العام (<span className="font-mono font-bold">{currentUser.username}</span>) لتأكيد التبديل إلى الحساب <span className="font-bold">{switchTargetUser.fullName}</span>:
              </p>
              <input
                type="password"
                required
                autoFocus
                value={adminVerifyPassword}
                onChange={(e) => setAdminVerifyPassword(e.target.value)}
                placeholder="كلمة مرور المدير"
                className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900"
              />
              {switchError && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 rounded text-rose-700 flex items-center gap-1.5">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{switchError}</span>
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setSwitchTargetUser(null)}
                  className="px-3 py-1.5 border border-slate-200 rounded"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded"
                >
                  تأكيد التبديل
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Reset / Set User Password */}
      {passwordTargetUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="relative w-full max-w-sm bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
            <div className="flex items-center justify-between px-5 py-3.5 bg-slate-900 text-white">
              <h3 className="text-xs font-bold">تعيين كلمة مرور للحساب (@{passwordTargetUser.username})</h3>
              <button onClick={() => setPasswordTargetUser(null)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleConfirmResetPassword} className="p-5 space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">كلمة المرور الجديدة *</label>
                <input
                  type="password"
                  required
                  autoFocus
                  value={resetPasswordValue}
                  onChange={(e) => setResetPasswordValue(e.target.value)}
                  placeholder="8 خانات فأكثر (حروف + أرقام)"
                  className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">تأكيد كلمة المرور *</label>
                <input
                  type="password"
                  required
                  value={resetPasswordConfirm}
                  onChange={(e) => setResetPasswordConfirm(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900"
                />
              </div>
              {resetPasswordError && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 rounded text-rose-700 flex items-center gap-1.5">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{resetPasswordError}</span>
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setPasswordTargetUser(null)}
                  className="px-3 py-1.5 border border-slate-200 rounded"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded"
                >
                  حفظ كلمة المرور
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
