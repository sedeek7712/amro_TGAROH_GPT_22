/**
 * شريط العنوان العلوي (TopBar)
 * يدعم فتح القائمة بالهاتف وزر البيع السريع ورصيد الخزينة
 */

import React from 'react';
import {
  ShoppingCart,
  ShieldCheck,
  Wallet,
  Building2,
  Clock,
  Menu,
  Smartphone,
  Wifi,
  WifiOff,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { ActivityId, SystemUser, CashBox } from '../../types/erp';
import { ActiveView } from './Sidebar';
import { useNetworkStatus } from '../../services/networkMonitor';
import { useLiveOutboxStats, useLiveBranches } from '../../hooks/useLiveDexie';
import { storage } from '../../services/storageService';

interface TopBarProps {
  activeView: ActiveView;
  setActiveView: (view: ActiveView) => void;
  selectedActivity: ActivityId | 'all';
  currentUser: SystemUser;
  cashBoxes: CashBox[];
  onOpenMobileMenu: () => void;
  onOpenInstallModal: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  activeView,
  setActiveView,
  selectedActivity,
  currentUser,
  cashBoxes,
  onOpenMobileMenu,
  onOpenInstallModal,
}) => {
  const { isOnline } = useNetworkStatus();
  const outboxStats = useLiveOutboxStats();
  const branches = useLiveBranches();
  const activeBranchId = storage.getActiveBranchId();
  const activeBranch = branches.find((b) => b.id === activeBranchId) || branches[0] || storage.getActiveBranch();

  const viewTitles: Record<ActiveView, string> = {
    dashboard: 'لوحة التحكم المركزية',
    pos: 'نقطة البيع (POS)',
    inventory: 'المخزون والأصناف',
    purchases: 'فواتير المشتريات',
    amanat: 'سجل الأمانات',
    accounting: 'المحاسبة والقيود',
    parties: 'العملاء والموردون',
    cash: 'الصناديق والسندات',
    reports: 'التقارير المالية',
    users: 'المستخدمون والصلاحيات',
    sync: 'المزامنة والنسخ',
    settings: 'إعدادات الشركة',
  };

  const activityLabels: Record<ActivityId | 'all', string> = {
    all: 'كافة الأنشطة',
    pharmacy: 'الصيدلية',
    grocery: 'البقالة',
    bike_parts: 'قطع الدراجات',
    equipment_parts: 'قطع المعدات',
  };

  const mainBox = cashBoxes.find((b) => b.isDefault) || cashBoxes[0];
  const currentTime = new Date().toLocaleDateString('ar-SA', {
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
  });

  return (
    <header className="h-14 lg:h-16 bg-white border-b border-slate-200 px-3 lg:px-6 flex items-center justify-between gap-2 lg:gap-6 shrink-0 z-10 select-none">
      {/* Right / Start: Mobile Menu Toggle & Title */}
      <div className="flex items-center gap-2 min-w-0">
        <button
          onClick={onOpenMobileMenu}
          className="lg:hidden p-2 text-slate-700 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors shrink-0"
          title="فتح القائمة الرئيسية"
        >
          <Menu className="w-5 h-5" />
        </button>

        <h1 className="text-xs sm:text-sm lg:text-base font-bold text-slate-900 tracking-tight truncate">
          {viewTitles[activeView]}
        </h1>

        <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-700 border border-slate-200 shrink-0">
          <Building2 className="w-3 h-3 text-emerald-600" />
          <span>{activityLabels[selectedActivity]}</span>
        </span>

        <span
          onClick={() => setActiveView('sync')}
          className="hidden md:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-teal-50 text-teal-800 border border-teal-200 shrink-0 cursor-pointer hover:bg-teal-100"
          title="الفرع النشط الحالي - انقر لإدارة الفروع ونقاط البيع"
        >
          <Building2 className="w-3 h-3 text-teal-600" />
          <span>{activeBranch.nameAr} ({activeBranch.code})</span>
        </span>
      </div>

      {/* Left / End: Actions & Quick Info */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Network & Live Outbox Status Badge */}
        <button
          type="button"
          onClick={() => setActiveView('sync')}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all ${
            !isOnline
              ? 'bg-amber-50 border-amber-200 text-amber-900 hover:bg-amber-100'
              : outboxStats.failed > 0
              ? 'bg-rose-50 border-rose-200 text-rose-800 hover:bg-rose-100'
              : outboxStats.syncing > 0
              ? 'bg-blue-50 border-blue-200 text-blue-800 hover:bg-blue-100'
              : outboxStats.pending > 0
              ? 'bg-teal-50 border-teal-200 text-teal-800 hover:bg-teal-100'
              : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
          }`}
          title="عرض حالة الشبكة وطابور المزامنة Outbox"
        >
          {!isOnline ? (
            <>
              <WifiOff className="w-3.5 h-3.5 text-amber-600 shrink-0" />
              <span className="hidden sm:inline">دون إنترنت (محلي)</span>
              {outboxStats.pending > 0 && (
                <span className="px-1.5 py-0.2 bg-amber-200 text-amber-900 rounded-full text-[10px] font-bold">
                  {outboxStats.pending}
                </span>
              )}
            </>
          ) : outboxStats.syncing > 0 ? (
            <>
              <RefreshCw className="w-3.5 h-3.5 text-blue-600 animate-spin shrink-0" />
              <span className="hidden sm:inline">جارٍ المزامنة...</span>
            </>
          ) : outboxStats.failed > 0 ? (
            <>
              <AlertTriangle className="w-3.5 h-3.5 text-rose-600 shrink-0" />
              <span>{outboxStats.failed} متعثر</span>
            </>
          ) : outboxStats.pending > 0 ? (
            <>
              <RefreshCw className="w-3.5 h-3.5 text-teal-600 shrink-0" />
              <span>{outboxStats.pending} بانتظار الرفع</span>
            </>
          ) : (
            <>
              <Wifi className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
              <span className="hidden md:inline text-emerald-800">متصل ومتزامن</span>
            </>
          )}
        </button>

        {/* Main Cash Balance Badge */}
        {mainBox && (
          <div className="hidden md:flex items-center gap-1.5 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-lg text-xs">
            <Wallet className="w-3.5 h-3.5 text-emerald-700" />
            <span className="text-emerald-800 font-medium">{mainBox.nameAr}:</span>
            <span className="font-mono tabular-nums font-bold text-emerald-950">
              {mainBox.balance.toFixed(2)} ر.س
            </span>
          </div>
        )}

        {/* Install Mobile App Button */}
        <button
          onClick={onOpenInstallModal}
          className="flex items-center gap-1 px-2.5 py-1.5 bg-gradient-to-r from-teal-600 to-emerald-600 hover:from-teal-700 hover:to-emerald-700 text-white rounded-lg text-xs font-semibold shadow-sm transition-all whitespace-nowrap border border-emerald-500/30"
          title="تثبيت التطبيق على الهاتف الذكي"
        >
          <Smartphone className="w-3.5 h-3.5 text-emerald-200" />
          <span className="hidden sm:inline">تثبيت التطبيق</span>
          <span className="sm:hidden">تطبيق</span>
        </button>

        {/* Quick POS Button */}
        <button
          onClick={() => setActiveView('pos')}
          className="flex items-center gap-1 px-2.5 py-1.5 lg:px-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold shadow-sm transition-colors whitespace-nowrap"
        >
          <ShoppingCart className="w-3.5 h-3.5" />
          <span className="hidden xs:inline">بيع سريع</span>
        </button>

        {/* Quick Amanat Button */}
        <button
          onClick={() => setActiveView('amanat')}
          className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-semibold shadow-sm transition-colors whitespace-nowrap"
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          <span>إيداع أمانة</span>
        </button>

        {/* Date Display */}
        <div className="hidden xl:flex items-center gap-1.5 text-xs text-slate-500 border-r border-slate-200 pr-3">
          <Clock className="w-3.5 h-3.5" />
          <span>{currentTime}</span>
        </div>
      </div>
    </header>
  );
};
