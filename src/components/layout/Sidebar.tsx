/**
 * الشريط الجانبي للنظام (RTL Sidebar)
 * متجاوب 100% مع شاشات الهواتف والتابلت والكمبيوتر
 */

import React from 'react';
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  FileSpreadsheet,
  ShieldCheck,
  Calculator,
  Users,
  Wallet,
  BarChart3,
  UserCheck,
  RefreshCw,
  Settings2,
  Sparkles,
  ChevronLeft,
  Pill,
  ShoppingBag,
  Bike,
  Wrench,
  Shield,
  X,
  LogOut,
} from 'lucide-react';
import { ActivityId, SystemUser } from '../../types/erp';
import { ActiveView, ROLE_ALLOWED_VIEWS, getAuthorizedActivityIds } from '../../config/rbac';

export type { ActiveView };

interface SidebarProps {
  activeView: ActiveView;
  setActiveView: (view: ActiveView) => void;
  selectedActivity: ActivityId | 'all';
  setSelectedActivity: (activity: ActivityId | 'all') => void;
  currentUser: SystemUser;
  isMobileOpen: boolean;
  setIsMobileOpen: (open: boolean) => void;
  onLogout?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeView,
  setActiveView,
  selectedActivity,
  setSelectedActivity,
  currentUser,
  isMobileOpen,
  setIsMobileOpen,
  onLogout,
}) => {
  const allNavItems = [
    { id: 'dashboard' as ActiveView, label: 'لوحة التحكم المركزية', icon: LayoutDashboard },
    { id: 'pos' as ActiveView, label: 'نقطة البيع السريعة (POS)', icon: ShoppingCart },
    { id: 'inventory' as ActiveView, label: 'المخزون والأصناف', icon: Package },
    { id: 'purchases' as ActiveView, label: 'فواتير المشتريات', icon: FileSpreadsheet },
    { id: 'amanat' as ActiveView, label: 'سجل الأمانات', icon: ShieldCheck, badge: 'خاص' },
    { id: 'accounting' as ActiveView, label: 'المحاسبة والقيود', icon: Calculator },
    { id: 'parties' as ActiveView, label: 'العملاء والموردون', icon: Users },
    { id: 'cash' as ActiveView, label: 'الصناديق والسندات', icon: Wallet },
    { id: 'reports' as ActiveView, label: 'التقارير المالية والمخزنية', icon: BarChart3 },
    { id: 'users' as ActiveView, label: 'المستخدمون والصلاحيات', icon: UserCheck },
    { id: 'settings' as ActiveView, label: 'إعدادات الشركة', icon: Settings2 },
    { id: 'sync' as ActiveView, label: 'المزامنة والنسخ الاحتياطي', icon: RefreshCw },
  ];

  const allowedViews = ROLE_ALLOWED_VIEWS[currentUser?.role || 'CASHIER'] || ROLE_ALLOWED_VIEWS.CASHIER;
  const navItems = allNavItems.filter((item) => allowedViews.includes(item.id));

  const allActivities = [
    { id: 'all', label: 'كافة الأنشطة (مجمع)', icon: Sparkles, color: 'text-slate-400' },
    { id: 'pharmacy' as ActivityId, label: 'الصيدلية', icon: Pill, color: 'text-emerald-400' },
    { id: 'grocery' as ActivityId, label: 'البقالة والأغذية', icon: ShoppingBag, color: 'text-amber-400' },
    { id: 'bike_parts' as ActivityId, label: 'قطع غيار الدراجات', icon: Bike, color: 'text-blue-400' },
    { id: 'equipment_parts' as ActivityId, label: 'قطع غيار المعدات', icon: Wrench, color: 'text-indigo-400' },
  ];
  const authorizedActivities = getAuthorizedActivityIds(currentUser);
  const activities =
    currentUser?.role === 'ADMIN'
      ? allActivities
      : allActivities.filter((act) =>
          act.id === 'all' ? authorizedActivities.size > 1 : authorizedActivities.has(act.id)
        );

  const renderSidebarContent = (isMobile: boolean = false) => (
    <div className="flex flex-col h-full overflow-hidden select-none">
      {/* Brand Header */}
      <div className="p-4 border-b border-slate-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-emerald-600 flex items-center justify-center text-white font-extrabold text-lg shadow-sm">
              ح
            </div>
            <div className="flex flex-col overflow-hidden">
              <span className="font-bold text-sm text-white tracking-tight truncate">نظام الإدارة التجارية</span>
              <span className="text-[11px] text-emerald-400 font-medium">والمحاسبية المتكامل</span>
            </div>
          </div>

          {isMobile && (
            <button
              onClick={() => setIsMobileOpen(false)}
              className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
              aria-label="إغلاق القائمة"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* User Mini Bar */}
        <div className="mt-3 pt-3 border-t border-slate-900 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 truncate">
            <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
            <span className="text-slate-300 font-medium truncate">{currentUser.fullName}</span>
          </div>
          <span className="px-1.5 py-0.5 text-[10px] rounded bg-slate-800 text-slate-400 border border-slate-700">
            {currentUser.role === 'ADMIN'
              ? 'مدير عام'
              : currentUser.role === 'ACCOUNTANT'
              ? 'محاسب'
              : currentUser.role === 'CASHIER'
              ? 'كاشير'
              : 'أمين مخزن'}
          </span>
        </div>
      </div>

      {/* Activities Quick Filter */}
      <div className="p-3 border-b border-slate-900">
        <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2 px-1">
          النشاط التجاري النشط
        </div>
        <div className="space-y-1">
          {activities.map((act) => {
            const Icon = act.icon;
            const isSelected = selectedActivity === act.id;
            return (
              <button
                key={act.id}
                onClick={() => {
                  setSelectedActivity(act.id as ActivityId | 'all');
                  if (isMobile) setIsMobileOpen(false);
                }}
                className={`w-full flex items-center justify-between px-2.5 py-2 lg:py-1.5 rounded-lg text-xs font-medium transition-all ${
                  isSelected
                    ? 'bg-slate-800 text-white shadow-sm border border-slate-700'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                }`}
              >
                <div className="flex items-center gap-2 truncate">
                  <Icon className={`w-3.5 h-3.5 ${act.color}`} />
                  <span className="truncate">{act.label}</span>
                </div>
                {isSelected && <ChevronLeft className="w-3.5 h-3.5 text-emerald-400" />}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Nav Items */}
      <nav className="flex-1 overflow-y-auto p-3 space-y-1">
        <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2 px-1">
          الوحدات التشغيلية
        </div>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => {
                setActiveView(item.id);
                if (isMobile) setIsMobileOpen(false);
              }}
              className={`w-full flex items-center justify-between px-3 py-2.5 lg:py-2 rounded-lg text-xs font-semibold transition-all ${
                isActive
                  ? 'bg-emerald-600 text-white shadow-md'
                  : 'text-slate-300 hover:bg-slate-900 hover:text-white'
              }`}
            >
              <div className="flex items-center gap-2.5 truncate">
                <Icon className={`w-4 h-4 ${isActive ? 'text-white' : 'text-slate-400'}`} />
                <span className="truncate">{item.label}</span>
              </div>
              {item.badge && (
                <span className="px-1.5 py-0.5 text-[9px] rounded font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Footer System Status */}
      <div className="p-3 border-t border-slate-900 bg-slate-950/80 text-[11px] text-slate-400 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-slate-500">حالة الاتصال والمزامنة في الشريط العلوي</span>
          <span className="font-mono text-[10px] text-slate-500">v1.0.0</span>
        </div>
        {onLogout && (
          <button
            onClick={onLogout}
            className="w-full flex items-center justify-center gap-2 py-1.5 px-3 rounded-lg bg-rose-900/30 hover:bg-rose-900/60 text-rose-400 hover:text-rose-300 text-xs font-semibold transition-colors border border-rose-900/40"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>تسجيل الخروج</span>
          </button>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* 1. Mobile Overlay Drawer (Only rendered when open on mobile) */}
      {isMobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden app-chrome-only">
          {/* Backdrop */}
          <div
            onClick={() => setIsMobileOpen(false)}
            className="fixed inset-0 bg-black/75 backdrop-blur-xs transition-opacity animate-in fade-in"
          />

          {/* Drawer content */}
          <aside className="fixed inset-y-0 right-0 w-72 max-w-[85vw] bg-slate-950 text-slate-200 border-l border-slate-800 shadow-2xl flex flex-col z-50 animate-in slide-in-from-right">
            {renderSidebarContent(true)}
          </aside>
        </div>
      )}

      {/* 2. Desktop Permanent Sidebar (Hidden on screens < 1024px) */}
      <aside className="hidden lg:flex w-64 bg-slate-950 text-slate-200 border-l border-slate-800 flex-col shrink-0 app-chrome-only">
        {renderSidebarContent(false)}
      </aside>
    </>
  );
};
