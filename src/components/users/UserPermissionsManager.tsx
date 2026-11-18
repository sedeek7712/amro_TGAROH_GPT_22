/**
 * إدارة المستخدمين والصلاحيات والرقابة (User & Roles Management)
 * تحديد صلاحيات الوصول لكل نشاط تجاري ولكل دور وظيفي
 */

import React, { useState, useEffect } from 'react';
import {
  UserCheck,
  Plus,
  Shield,
  Key,
  Lock,
  CheckCircle,
  AlertCircle,
  X,
  Check,
  Users,
} from 'lucide-react';
import { storage } from '../../services/storageService';
import { useLiveUsers } from '../../hooks/useLiveDexie';
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
  const [users, setUsers] = useState<SystemUser[]>(liveUsers);

  useEffect(() => {
    setUsers(liveUsers);
  }, [liveUsers]);

  const [isAddUserModalOpen, setIsAddUserModalOpen] = useState(false);

  // حقول إضافة مستخدم
  const [newUsername, setNewUsername] = useState('');
  const [newFullName, setNewFullName] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('CASHIER');
  const [allowedActivities, setAllowedActivities] = useState<ActivityId[]>([
    'pharmacy',
    'grocery',
    'bike_parts',
    'equipment_parts',
  ]);

  const activities = storage.getActivities();

  const handleToggleActivity = (userId: string, activityId: ActivityId) => {
    const updated = users.map((u) => {
      if (u.id === userId) {
        const hasIt = u.allowedActivities.includes(activityId);
        const newActivities = hasIt
          ? u.allowedActivities.filter((a) => a !== activityId)
          : [...u.allowedActivities, activityId];
        return { ...u, allowedActivities: newActivities };
      }
      return u;
    });

    setUsers(updated);
    storage.saveUsers(updated);

    // إذا كان المستخدم الحالي تم تعديله نحدثه
    if (currentUser.id === userId) {
      const currentUpdated = updated.find((u) => u.id === userId);
      if (currentUpdated) setCurrentUser(currentUpdated);
    }
    onRefresh();
  };

  const handleSaveUser = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername.trim() || !newFullName.trim()) return;

    const newUser: SystemUser = {
      id: storage.generateUUID(),
      username: newUsername.trim().toLowerCase(),
      fullName: newFullName.trim(),
      role: newRole,
      allowedActivities,
      active: true,
    };

    const updated = [...users, newUser];
    setUsers(updated);
    storage.saveUsers(updated);
    setIsAddUserModalOpen(false);
    setNewUsername('');
    setNewFullName('');
    onRefresh();
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
            تطبيق أمان صارم: عزل الأنشطة التجارية وتحديد صلاحيات المحاسب والكاشير لحماية الأرباح
          </p>
        </div>

        <button
          onClick={() => setIsAddUserModalOpen(true)}
          className="flex items-center gap-1.5 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-bold transition-colors shrink-0"
        >
          <Plus className="w-4 h-4 text-emerald-400" />
          <span>إضافة مستخدم جديد</span>
        </button>
      </div>

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
          <span className="text-emerald-800 font-medium">تبديل المستخدم النشط (يتطلب مصادقة إدارية):</span>
          <select
            value={currentUser.id}
            onChange={(e) => {
              const targetId = e.target.value;
              if (targetId === currentUser.id) return;
              
              if (currentUser.role !== 'ADMIN') {
                alert('حظر أمني: لا يملك صلاحية تبديل المستخدمين إلا المدير العام للنظام.');
                return;
              }

              const pin = prompt('يرجى إدخال رمز التحقق الإداري (Master PIN) لتأكيد التبديل المصرح:');
              if (pin !== '1234' && pin !== 'admin') {
                alert('فشل التحقق الأمني: الرمز السري غير صحيح. تم حظر محاولة التبديل.');
                return;
              }

              const u = users.find((usr) => usr.id === targetId);
              if (u) {
                storage.setCurrentUser(u);
                setCurrentUser(u);
                alert(`تم التحقق بنجاح. تم تبديل الجلسة النشطة إلى: ${u.fullName} (${roleLabels[u.role]?.label})`);
                onRefresh();
              }
            }}
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
        {users.map((user) => (
          <div
            key={user.id}
            className={`bg-white rounded-xl border p-5 shadow-sm space-y-4 ${
              currentUser.id === user.id ? 'border-emerald-500 ring-2 ring-emerald-500/10' : 'border-slate-200'
            }`}
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-sm text-slate-900">{user.fullName}</h3>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${roleLabels[user.role]?.color}`}>
                    {roleLabels[user.role]?.label}
                  </span>
                </div>
                <div className="font-mono text-xs text-slate-500 mt-0.5">اسم الدخول: @{user.username}</div>
              </div>

              {currentUser.id === user.id && (
                <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-bold">
                  الجلسة النشطة
                </span>
              )}
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
          </div>
        ))}
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
                  placeholder="مثال: cashier1 / mohammed..."
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
                  placeholder="مثال: محمد بن خالد..."
                  className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">الدور الوظيفي والصلاحيات *</label>
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
    </div>
  );
};
