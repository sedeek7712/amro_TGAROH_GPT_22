/**
 * لوحة التحكم المركزية التنفيذية (Executive Dashboard)
 * تعرض ملخصاً شاملاً وفورياً للأداء المالي والمخزني للأنشطة التجارية الخمسة
 */

import React from 'react';
import {
  DollarSign,
  Package,
  TrendingUp,
  AlertTriangle,
  Clock,
  ShieldCheck,
  Pill,
  ShoppingBag,
  Bike,
  Wrench,
  ArrowUpRight,
  ArrowDownLeft,
  Wallet,
  PlusCircle,
  ShoppingCart,
  RefreshCw,
} from 'lucide-react';
import { SalesBarChart } from '../charts/SalesBarChart';
import { DonutChart } from '../charts/DonutChart';
import {
  useLiveInvoices,
  useLiveCashBoxes,
  useLiveParties,
  useLiveAmanatRecords,
  useLiveJournalEntries,
  useLiveProducts,
} from '../../hooks/useLiveDexie';
import { ActivityId } from '../../types/erp';
import { ActiveView } from '../layout/Sidebar';
import { getActiveCurrencyConfig } from '../../config/currency';
import { computeInventoryValuation } from '../../utils/inventoryValuation';

interface ExecutiveDashboardProps {
  setActiveView: (view: ActiveView) => void;
  setSelectedActivity: (activity: ActivityId | 'all') => void;
  onRefresh: () => void;
}

export const ExecutiveDashboard: React.FC<ExecutiveDashboardProps> = ({
  setActiveView,
  setSelectedActivity,
  onRefresh,
}) => {
  const invoices = useLiveInvoices();
  const cashBoxes = useLiveCashBoxes();
  const customers = useLiveParties('CUSTOMER');
  const suppliers = useLiveParties('SUPPLIER');
  const amanatRecords = useLiveAmanatRecords();
  const journalEntries = useLiveJournalEntries();
  const liveProducts = useLiveProducts();
  const currencySymbol = getActiveCurrencyConfig().symbol;

  const valuation = computeInventoryValuation(liveProducts);

  const expiringAlerts = liveProducts.flatMap((p) =>
    (p.batches || [])
      .filter((b) => {
        const diff = Math.ceil((new Date(b.expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        return diff <= 60 && b.quantity > 0;
      })
      .map((b) => {
        const diff = Math.ceil((new Date(b.expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        return {
          product: p,
          batch: b,
          daysRemaining: diff,
          isExpired: diff <= 0,
        };
      })
  );

  const lowStockAlerts = liveProducts.filter((p) => p.currentStock <= p.minStockAlert);

  // حساب الإجماليات المالية الحقيقية
  const totalSales = invoices
    .filter((inv) => inv.type === 'SALE')
    .reduce((sum, inv) => sum + inv.total, 0);

  const totalCashInBoxes = cashBoxes.reduce((sum, b) => sum + b.balance, 0);

  // مديونيات العملاء (موجب)
  const totalReceivables = customers.reduce((sum, c) => sum + (c.balance > 0 ? c.balance : 0), 0);

  // مستحقات الموردين (سالب رصيد المورد يعني دائن علينا)
  const totalPayables = suppliers.reduce((sum, s) => sum + (s.balance < 0 ? Math.abs(s.balance) : 0), 0);

  // الأمانات النقدية المحفوظة حالياً
  const heldCashAmanat = amanatRecords
    .filter((r) => r.status === 'HELD' && r.type === 'CASH')
    .reduce((sum, r) => sum + r.amount, 0);

  // الأمانات العينية المحفوظة حالياً
  const heldItemAmanatCount = amanatRecords.filter((r) => r.status === 'HELD' && r.type === 'ITEM').length;

  // إحصائيات الأنشطة التجارية الأربعة المستقلة
  const activitiesConfig = [
    {
      id: 'pharmacy' as ActivityId,
      name: 'الصيدلية',
      icon: Pill,
      color: 'emerald',
      bgLight: 'bg-emerald-50',
      textDark: 'text-emerald-900',
      border: 'border-emerald-200',
      itemsCount: valuation.activityBreakdown.pharmacy.count,
      valuation: valuation.activityBreakdown.pharmacy.value,
      sales: invoices
        .filter((inv) => inv.activityId === 'pharmacy' && inv.type === 'SALE')
        .reduce((sum, inv) => sum + inv.total, 0),
      alertCount: expiringAlerts.filter((a) => a.product.activityId === 'pharmacy').length,
      alertLabel: 'تشغيلات قريبة الانتهاء',
    },
    {
      id: 'grocery' as ActivityId,
      name: 'المواد الغذائية والبقالة',
      icon: ShoppingBag,
      color: 'amber',
      bgLight: 'bg-amber-50',
      textDark: 'text-amber-900',
      border: 'border-amber-200',
      itemsCount: valuation.activityBreakdown.grocery.count,
      valuation: valuation.activityBreakdown.grocery.value,
      sales: invoices
        .filter((inv) => inv.activityId === 'grocery' && inv.type === 'SALE')
        .reduce((sum, inv) => sum + inv.total, 0),
      alertCount: lowStockAlerts.filter((p) => p.activityId === 'grocery').length,
      alertLabel: 'أصناف قاربت النفاد',
    },
    {
      id: 'bike_parts' as ActivityId,
      name: 'قطع غيار الدراجات النارية',
      icon: Bike,
      color: 'blue',
      bgLight: 'bg-blue-50',
      textDark: 'text-blue-900',
      border: 'border-blue-200',
      itemsCount: valuation.activityBreakdown.bike_parts.count,
      valuation: valuation.activityBreakdown.bike_parts.value,
      sales: invoices
        .filter((inv) => inv.activityId === 'bike_parts' && inv.type === 'SALE')
        .reduce((sum, inv) => sum + inv.total, 0),
      alertCount: lowStockAlerts.filter((p) => p.activityId === 'bike_parts').length,
      alertLabel: 'قطع تحت حد الطلب',
    },
    {
      id: 'equipment_parts' as ActivityId,
      name: 'قطع غيار المعدات',
      icon: Wrench,
      color: 'indigo',
      bgLight: 'bg-indigo-50',
      textDark: 'text-indigo-900',
      border: 'border-indigo-200',
      itemsCount: valuation.activityBreakdown.equipment_parts.count,
      valuation: valuation.activityBreakdown.equipment_parts.value,
      sales: invoices
        .filter((inv) => inv.activityId === 'equipment_parts' && inv.type === 'SALE')
        .reduce((sum, inv) => sum + inv.total, 0),
      alertCount: lowStockAlerts.filter((p) => p.activityId === 'equipment_parts').length,
      alertLabel: 'قطع تحت حد الطلب',
    },
  ];

  return (
    <div className="app-executive-dashboard p-3 sm:p-5 lg:p-7 space-y-5 sm:space-y-7 max-w-[1440px] mx-auto min-w-0">
      <section className="app-dashboard-header flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm">
        <div className="min-w-0">
          <p className="text-[11px] font-bold tracking-wide text-emerald-700 mb-1">نظام عمرو النماري</p>
          <h1 className="text-lg sm:text-xl font-extrabold text-slate-900">لوحة التحكم الرئيسية</h1>
          <p className="text-xs sm:text-sm text-slate-500 mt-1">نظرة موحدة على الأداء المالي والمخزون والأنشطة التجارية</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setActiveView('inventory')} className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 transition-colors"><Package className="w-4 h-4" /> المخزون</button>
          <button onClick={() => setActiveView('pos')} className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-700 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-800 transition-colors"><ShoppingCart className="w-4 h-4" /> نقطة البيع</button>
          <button onClick={onRefresh} className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 transition-colors"><RefreshCw className="w-4 h-4" /> تحديث البيانات</button>
        </div>
      </section>
      {/* KPI Top Strip - 2 Columns on Mobile, 3 on Tablet, 6 on Large Screens */}
      <div className="app-dashboard-kpis grid grid-cols-2 md:grid-cols-3 2xl:grid-cols-6 gap-3 sm:gap-4">
        {/* إجمالي المبيعات */}
        <div className="bg-white min-w-0 min-h-[112px] p-3.5 sm:p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between hover:border-slate-300 transition-colors">
          <div className="flex items-center justify-between text-slate-500 mb-1.5">
            <span className="text-[11px] sm:text-xs font-semibold truncate">إجمالي المبيعات</span>
            <TrendingUp className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-600 shrink-0" />
          </div>
          <div className="text-base sm:text-lg xl:text-xl font-extrabold font-mono tabular-nums text-slate-900 break-words">
            {totalSales.toFixed(2)} <span className="text-[10px] sm:text-xs font-normal text-slate-500">{currencySymbol}</span>
          </div>
          <div className="text-[10px] sm:text-[11px] text-slate-500 mt-1 truncate">
            {invoices.length} فاتورة مسجلة
          </div>
        </div>

        {/* السيولة النقدية بالصناديق */}
        <div className="bg-white min-w-0 min-h-[112px] p-3.5 sm:p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between hover:border-slate-300 transition-colors">
          <div className="flex items-center justify-between text-slate-500 mb-1.5">
            <span className="text-[11px] sm:text-xs font-semibold truncate">السيولة بالخزائن</span>
            <Wallet className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-blue-600 shrink-0" />
          </div>
          <div className="text-base sm:text-lg xl:text-xl font-extrabold font-mono tabular-nums text-slate-900 break-words">
            {totalCashInBoxes.toFixed(2)} <span className="text-[10px] sm:text-xs font-normal text-slate-500">{currencySymbol}</span>
          </div>
          <div className="text-[10px] sm:text-[11px] text-slate-500 mt-1 truncate">
            في {cashBoxes.length} خزائن وبنوك
          </div>
        </div>

        {/* قيمة المخزون السلعي */}
        <div className="bg-white min-w-0 min-h-[112px] p-3.5 sm:p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between hover:border-slate-300 transition-colors">
          <div className="flex items-center justify-between text-slate-500 mb-1.5">
            <span className="text-[11px] sm:text-xs font-semibold truncate">تقييم المخزون</span>
            <Package className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-amber-600 shrink-0" />
          </div>
          <div className="text-base sm:text-lg xl:text-xl font-extrabold font-mono tabular-nums text-slate-900 break-words">
            {valuation.totalValue.toFixed(2)} <span className="text-[10px] sm:text-xs font-normal text-slate-500">{currencySymbol}</span>
          </div>
          <div className="text-[10px] sm:text-[11px] text-slate-500 mt-1 truncate">
            {valuation.totalItemsCount} قطعة بالمستودعات
          </div>
        </div>

        {/* ديون العملاء */}
        <div className="bg-white min-w-0 min-h-[112px] p-3.5 sm:p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between hover:border-slate-300 transition-colors">
          <div className="flex items-center justify-between text-slate-500 mb-1.5">
            <span className="text-[11px] sm:text-xs font-semibold truncate">ديون العملاء (لنا)</span>
            <ArrowUpRight className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-600 shrink-0" />
          </div>
          <div className="text-base sm:text-lg xl:text-xl font-extrabold font-mono tabular-nums text-slate-900 break-words">
            {totalReceivables.toFixed(2)} <span className="text-[10px] sm:text-xs font-normal text-slate-500">{currencySymbol}</span>
          </div>
          <div className="text-[10px] sm:text-[11px] text-slate-500 mt-1 truncate">
            مستحقة لدى العملاء
          </div>
        </div>

        {/* مستحقات الموردين */}
        <div className="bg-white min-w-0 min-h-[112px] p-3.5 sm:p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between hover:border-slate-300 transition-colors">
          <div className="flex items-center justify-between text-slate-500 mb-1.5">
            <span className="text-[11px] sm:text-xs font-semibold truncate">الموردين (علينا)</span>
            <ArrowDownLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-rose-600 shrink-0" />
          </div>
          <div className="text-base sm:text-lg xl:text-xl font-extrabold font-mono tabular-nums text-rose-700 break-words">
            {totalPayables.toFixed(2)} <span className="text-[10px] sm:text-xs font-normal text-slate-500">{currencySymbol}</span>
          </div>
          <div className="text-[10px] sm:text-[11px] text-slate-500 mt-1 truncate">
            التزامات شراء آجلة
          </div>
        </div>

        {/* الأمانات النقدية المحفوظة */}
        <div className="bg-purple-50/60 min-w-0 min-h-[112px] p-3.5 sm:p-4 rounded-2xl border border-purple-200 shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 mb-1.5">
            <span className="text-[11px] sm:text-xs font-semibold text-purple-900 truncate">أمانات الغير</span>
            <ShieldCheck className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-purple-600 shrink-0" />
          </div>
          <div className="text-base sm:text-lg xl:text-xl font-extrabold font-mono tabular-nums text-purple-950 break-words">
            {heldCashAmanat.toFixed(2)} <span className="text-[10px] sm:text-xs font-normal text-slate-500">{currencySymbol}</span>
          </div>
          <div className="text-[10px] sm:text-[11px] text-purple-700 mt-1 truncate">
            معزولة + {heldItemAmanatCount} عينية
          </div>
        </div>
      </div>

      {/* Charts Section - رسوم بيانية تفاعلية متقدمة */}
      <div className="app-dashboard-charts grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* رسم بياني شريطي: مبيعات الأنشطة الأربعة */}
        <div className="bg-white rounded-2xl border border-slate-200/90 p-4 sm:p-5 shadow-xs hover:shadow-md transition-shadow">
          <SalesBarChart
            title="مبيعات الأنشطة التجارية"
            data={[
              {
                label: 'الصيدلية',
                value: invoices
                  .filter((inv) => inv.activityId === 'pharmacy' && inv.type === 'SALE')
                  .reduce((sum, inv) => sum + inv.total, 0),
                color: '#059669',
              },
              {
                label: 'البقالة',
                value: invoices
                  .filter((inv) => inv.activityId === 'grocery' && inv.type === 'SALE')
                  .reduce((sum, inv) => sum + inv.total, 0),
                color: '#d97706',
              },
              {
                label: 'الدراجات',
                value: invoices
                  .filter((inv) => inv.activityId === 'bike_parts' && inv.type === 'SALE')
                  .reduce((sum, inv) => sum + inv.total, 0),
                color: '#2563eb',
              },
              {
                label: 'المعدات',
                value: invoices
                  .filter((inv) => inv.activityId === 'equipment_parts' && inv.type === 'SALE')
                  .reduce((sum, inv) => sum + inv.total, 0),
                color: '#4f46e5',
              },
            ]}
          />
        </div>

        {/* رسم بياني دائري: توزيع قيمة المخزون */}
        <div className="bg-white rounded-2xl border border-slate-200/90 p-4 sm:p-5 shadow-xs hover:shadow-md transition-shadow">
          <DonutChart
            title="توزيع قيمة المخزون السلعي"
            centerLabel="إجمالي"
            centerValue={`${valuation.totalValue.toFixed(0)} ${currencySymbol}`}
            data={[
              {
                label: 'الصيدلية',
                value: valuation.activityBreakdown.pharmacy.value,
                color: '#059669',
              },
              {
                label: 'البقالة',
                value: valuation.activityBreakdown.grocery.value,
                color: '#d97706',
              },
              {
                label: 'الدراجات',
                value: valuation.activityBreakdown.bike_parts.value,
                color: '#2563eb',
              },
              {
                label: 'المعدات',
                value: valuation.activityBreakdown.equipment_parts.value,
                color: '#4f46e5',
              },
            ]}
          />
        </div>
      </div>

      {/* 4 Commercial Activities Cards */}
      <div className="app-dashboard-activities">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs sm:text-sm font-bold text-slate-900">مؤشرات الأنشطة التجارية الأربعة المستقلة</h2>
          <span className="text-[10px] sm:text-xs text-slate-500">مخزون تجاري مستقل ودليل محاسبي موحد</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-4 gap-3 sm:gap-4">
          {activitiesConfig.map((act) => {
            const Icon = act.icon;
            return (
              <div
                key={act.id}
                className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-sm hover:shadow-md hover:border-slate-300 transition-all flex flex-col justify-between min-w-0"
              >
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className={`p-2 rounded-lg ${act.bgLight} ${act.textDark}`}>
                        <Icon className="w-4 h-4" />
                      </div>
                      <h3 className="font-bold text-xs text-slate-900">{act.name}</h3>
                    </div>
                  </div>

                  <div className="space-y-2 text-xs border-t border-slate-100 pt-3">
                    <div className="flex justify-between text-slate-600">
                      <span>عدد الأصناف:</span>
                      <span className="font-mono font-bold text-slate-900">{act.itemsCount}</span>
                    </div>

                    <div className="flex justify-between text-slate-600">
                      <span>قيمة المخزون التجاري:</span>
                      <span className="font-mono tabular-nums font-semibold text-slate-900">
                        {act.valuation.toFixed(2)} {currencySymbol}
                      </span>
                    </div>

                    <div className="flex justify-between text-slate-600">
                      <span>إجمالي المبيعات:</span>
                      <span className="font-mono tabular-nums font-semibold text-emerald-700">
                        {act.sales.toFixed(2)} {currencySymbol}
                      </span>
                    </div>

                    {act.alertCount > 0 && (
                      <div className="flex items-center justify-between text-amber-700 bg-amber-50 px-2 py-1 rounded text-[11px] font-medium">
                        <span>{act.alertLabel}:</span>
                        <span className="font-bold font-mono">{act.alertCount}</span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-slate-100 flex items-center gap-2">
                  <button
                    onClick={() => {
                      setSelectedActivity(act.id);
                      setActiveView('inventory');
                    }}
                    className="flex-1 py-1.5 px-2 text-center text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg transition-colors"
                  >
                    إدارة المخزون
                  </button>
                  <button
                    onClick={() => {
                      setSelectedActivity(act.id);
                      setActiveView('pos');
                    }}
                    className="p-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors"
                    title="نقطة بيع سريعة لهذا النشاط"
                  >
                    <ShoppingCart className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Independent Amanat & Custody Banner */}
      <div className="app-dashboard-amanat bg-gradient-to-r from-purple-900 to-indigo-950 text-white rounded-xl p-4 shadow-sm border border-purple-800 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-700/50 flex items-center justify-center shrink-0 border border-purple-500/40">
            <ShieldCheck className="w-5 h-5 text-purple-200" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-xs sm:text-sm">وحدة الأمانات والودائع المستقلة</h3>
              <span className="text-[10px] bg-purple-500/30 text-purple-200 px-2 py-0.5 rounded-full border border-purple-400/30">
                أموال وأصناف الغير (خارج الميزانية)
              </span>
            </div>
            <p className="text-[11px] text-purple-200 mt-0.5">
              الأمانات النقدية التزام للغير (معزولة دفترياً) والأمانات العينية محفوظة بسجل رقابي دون مساس بأرباح أو مخزون المنشأة.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className="text-left font-mono tabular-nums">
            <div className="text-xs font-bold text-purple-100">{heldCashAmanat.toFixed(2)} {currencySymbol} نقدية</div>
            <div className="text-[10px] text-purple-300">{heldItemAmanatCount} صنف عيني محفوظ</div>
          </div>
          <button
            onClick={() => setActiveView('amanat')}
            className="px-3.5 py-2 bg-purple-500 hover:bg-purple-400 text-slate-950 rounded-lg text-xs font-bold shadow transition-colors whitespace-nowrap"
          >
            فتح سجل الأمانات
          </button>
        </div>
      </div>

      {/* Critical Stock & Expiry Alerts Strip */}
      {(expiringAlerts.length > 0 || lowStockAlerts.length > 0) && (
        <div className="app-dashboard-alerts grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* تنبيهات صلاحية الصيدلية والأغذية */}
          {expiringAlerts.length > 0 && (
            <div className="bg-white rounded-xl border border-amber-200 p-4 shadow-sm">
              <div className="flex items-center gap-2 text-amber-800 font-bold text-xs mb-3">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                <span>أصناف دوائية أو غذائية قريبة الانتهاء (أقل من 60 يوماً)</span>
              </div>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {expiringAlerts.slice(0, 5).map((alert, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between p-2 bg-amber-50/50 rounded-lg text-xs border border-amber-100"
                  >
                    <div>
                      <div className="font-semibold text-slate-900">{alert.product.nameAr}</div>
                      <div className="text-[11px] text-slate-500">
                        تشغيلة: <span className="font-mono">{alert.batch.batchNumber}</span> | الكمية:{' '}
                        <span className="font-bold">{alert.batch.quantity}</span>
                      </div>
                    </div>
                    <div className="text-left">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          alert.isExpired ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-900'
                        }`}
                      >
                        {alert.isExpired ? 'منتهي الصلاحية!' : `متبقي ${alert.daysRemaining} يوم`}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* تنبيهات نفاد الرصيد */}
          {lowStockAlerts.length > 0 && (
            <div className="bg-white rounded-xl border border-rose-200 p-4 shadow-sm">
              <div className="flex items-center gap-2 text-rose-800 font-bold text-xs mb-3">
                <AlertTriangle className="w-4 h-4 text-rose-600" />
                <span>أصناف وصلت أو قاربت حد إعادة الطلب الأدنى</span>
              </div>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {lowStockAlerts.slice(0, 5).map((p, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between p-2 bg-rose-50/50 rounded-lg text-xs border border-rose-100"
                  >
                    <div>
                      <div className="font-semibold text-slate-900">{p.nameAr}</div>
                      <div className="text-[11px] text-slate-500">
                        كود: <span className="font-mono">{p.code}</span> | حد الطلب:{' '}
                        <span className="font-bold">{p.minStockAlert}</span>
                      </div>
                    </div>
                    <div className="text-left">
                      <span className="text-xs font-mono font-bold text-rose-700">
                        الرصيد: {p.currentStock} {p.unit}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Zero Mock Operations State & System Welcome */}
      {invoices.length === 0 && liveProducts.length === 0 && (
        <div className="bg-slate-50 rounded-xl border-2 border-dashed border-slate-300 p-8 text-center max-w-2xl mx-auto">
          <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center mx-auto mb-3">
            <Package className="w-6 h-6" />
          </div>
          <h3 className="text-base font-bold text-slate-900 mb-1">الدفاتر بيضاء وجاهزة للعمل الفعلي الكامل</h3>
          <p className="text-xs text-slate-600 mb-5 leading-relaxed">
            تمت تهيئة الدليل المحاسبي الشجري، ومراكز التكلفة للأنشطة الخمسة، والصناديق الرئيسية بنجاح، دون تسجيل أية
            بيانات تجريبية أو قيود وهمية وفق توجيهاتك. يمكنك البدء الآن بإضافة أول صنف أو تسجيل أول عميل ومورد.
          </p>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={() => setActiveView('inventory')}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-sm transition-colors"
            >
              <PlusCircle className="w-4 h-4" />
              <span>إضافة أول صنف للمخزون</span>
            </button>
            <button
              onClick={() => setActiveView('parties')}
              className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-xs font-bold transition-colors"
            >
              <span>إضافة عميل أو مورد</span>
            </button>
          </div>
        </div>
      )}

      {/* Recent Activity Ledger Preview */}
      {journalEntries.length > 0 && (
        <div className="app-dashboard-journal bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold text-slate-900">سجل آخر الحركات والقيود المحاسبية المرحلة</h3>
            <button
              onClick={() => setActiveView('accounting')}
              className="text-xs text-emerald-700 hover:text-emerald-800 font-semibold"
            >
              عرض دفتر اليومية العامة الكامل &larr;
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 bg-slate-50/70">
                  <th className="py-2.5 px-3">رقم القيد</th>
                  <th className="py-2.5 px-3">التاريخ</th>
                  <th className="py-2.5 px-3">البيان والشرح</th>
                  <th className="py-2.5 px-3">مركز التكلفة</th>
                  <th className="py-2.5 px-3 text-center">المبلغ الإجمالي</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {journalEntries.slice(0, 5).map((entry) => {
                  const totalAmount = entry.lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
                  return (
                    <tr key={entry.id} className="hover:bg-slate-50">
                      <td className="py-2.5 px-3 font-mono font-bold text-slate-900">{entry.entryNumber}</td>
                      <td className="py-2.5 px-3 font-mono text-slate-600">{entry.date}</td>
                      <td className="py-2.5 px-3 font-medium text-slate-900">{entry.description}</td>
                      <td className="py-2.5 px-3">
                        <span className="px-2 py-0.5 rounded text-[11px] bg-slate-100 text-slate-700">
                          {entry.costCenterId === 'pharmacy'
                            ? 'الصيدلية'
                            : entry.costCenterId === 'grocery'
                            ? 'البقالة'
                            : entry.costCenterId === 'bike_parts'
                            ? 'قطع الدراجات'
                            : entry.costCenterId === 'equipment_parts'
                            ? 'قطع المعدات'
                            : 'الإدارة العامة'}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-center font-mono tabular-nums font-bold text-slate-900">
                        {totalAmount.toFixed(2)} {currencySymbol}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
