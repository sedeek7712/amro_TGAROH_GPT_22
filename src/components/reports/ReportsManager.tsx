/**
 * نظام الإدارة التجارية والمحاسبية المتكامل (multi_activity_erp)
 * وحدة التقارير المالية والإدارية الشاملة والمطبوعات المؤسسية (Reports & Analytics)
 * تدعم:
 * 1. قائمة الدخل والأرباح والخسائر للأنشطة الأربعة
 * 2. ميزان المراجعة الشامل وتطابق القيد المزدوج
 * 3. كشف حساب تفصيلي للعملاء والموردين مع إمكانية إرسال إشعار فوري عبر واتساب
 * 4. جرد وتقييم المخزون وتتبع صلاحيات التشغيلات (FEFO)
 * 5. كشف المبيعات والمشتريات حسب الفروع
 * 6. سجل الأمانات المستقل
 * 7. الطباعة المباشرة 🖨️ وحفظ ملفات PDF بمقاس A4 ومقاس إيصال 80mm
 */

import React, { useState, useMemo } from 'react';
import {
  BarChart3,
  Printer,
  Calendar,
  Filter,
  DollarSign,
  Package,
  TrendingUp,
  ShieldCheck,
  Building2,
  FileText,
  User,
  ArrowUpDown,
  Send,
  MessageSquare,
  FileCheck2,
  Search,
  CheckCircle2,
  AlertTriangle,
  Layers,
  ChevronDown,
} from 'lucide-react';
import { storage, OFFICIAL_ACTIVITIES } from '../../services/storageService';
import { desktopSession } from '../../services/desktopSession';
import { accounting } from '../../services/accountingEngine';
import {
  useLiveProducts,
  useLiveParties,
  useLiveInvoices,
  useLiveCashBoxes,
  useLiveAmanatRecords,
  useLiveAccounts,
  useLiveJournalEntries,
  useLiveBranches,
  useLiveVouchers,
  useLivePaymentAllocations,
  useLivePartyAdvances,
  useLiveAllocationAudits,
} from '../../hooks/useLiveDexie';
import { CommercialActivityId, Party, JournalEntry } from '../../types/erp';
import { CustomerNotificationModal } from '../common/CustomerNotificationModal';
import { authService } from '../../services/authService';
import { hasPermission } from '../../config/rbac';
import { getActiveCurrencyConfig, roundMoney } from '../../config/currency';
import { buildPartyStatement } from '../../utils/partyStatement';
import { getProductCostValue } from '../../utils/inventoryValuation';

type ReportTab =
  | 'activity_profits'
  | 'trial_balance'
  | 'balance_sheet'
  | 'customer_statement'
  | 'aging_advances'
  | 'stock_valuation'
  | 'sales_purchases'
  | 'amanat_custody'
  | 'audit_reconciliation';

export const ReportsManager: React.FC = () => {
  const isDesktop = typeof window !== 'undefined' && Boolean(window.amroDesktop);
  const actor =
    authService.getCurrentActorSync() || (isDesktop ? null : storage.getCurrentUser());
  const canViewProfits = hasPermission(actor, 'view:profits');
  const currencySymbol = getActiveCurrencyConfig().symbol;
  const [activeTab, setActiveTab] = useState<ReportTab>(
    canViewProfits ? 'activity_profits' : 'trial_balance'
  );
  const [printSize, setPrintSize] = useState<'A4' | '80mm'>('A4');

  // فلاتر كشف الحساب وأعمار الديون
  const [selectedPartyId, setSelectedPartyId] = useState<string>('');
  const [partyTypeFilter, setPartyTypeFilter] = useState<'CUSTOMER' | 'SUPPLIER'>('CUSTOMER');
  const [agingPartyType, setAgingPartyType] = useState<'CUSTOMER' | 'SUPPLIER'>('CUSTOMER');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');

  // فلاتر المخزون والمبيعات
  const [activityFilter, setActivityFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // نافذة إرسال الإشعار للعميل
  const [notificationModalData, setNotificationModalData] = useState<{
    isOpen: boolean;
    name: string;
    phone: string;
    docNumber: string;
    docType: 'STATEMENT' | 'INVOICE' | 'RECEIPT_VOUCHER';
    amount?: number;
    balanceRemaining?: number;
    activityName?: string;
    notes?: string;
  }>({
    isOpen: false,
    name: '',
    phone: '',
    docNumber: '',
    docType: 'STATEMENT',
  });

  const desktopActivities = desktopSession.getActivitiesSnapshot();
  const activities = isDesktop
    ? desktopActivities.length > 0
      ? desktopActivities
      : OFFICIAL_ACTIVITIES
    : storage.getActivities();
  const liveProducts = useLiveProducts();
  const liveAccounts = useLiveAccounts();
  const liveJournalEntries = useLiveJournalEntries();
  const liveInvoices = useLiveInvoices();
  const liveParties = useLiveParties();
  const liveCashBoxes = useLiveCashBoxes();
  const liveVouchers = useLiveVouchers();
  const livePaymentAllocations = useLivePaymentAllocations();
  const livePartyAdvances = useLivePartyAdvances();
  const liveAllocationAudits = useLiveAllocationAudits();
  const liveAmanat = useLiveAmanatRecords();
  const liveBranches = useLiveBranches();

  const activeBranchId = isDesktop
    ? desktopSession.getActiveBranchId() || liveBranches[0]?.id || 'branch_main'
    : storage.getActiveBranchId();
  const activeBranch = liveBranches.find((b) => b.id === activeBranchId) || liveBranches[0];
  const currentUser = actor;

  // 1. تقييم المخزون العام
  const stockValuation = useMemo(() => {
    let filtered = liveProducts;
    if (activityFilter !== 'ALL') {
      filtered = filtered.filter((p) => p.activityId === activityFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (p) =>
          p.nameAr.toLowerCase().includes(q) ||
          p.code.toLowerCase().includes(q) ||
          (p.barcode && p.barcode.includes(q)) ||
          (p.oemNumber && p.oemNumber.toLowerCase().includes(q))
      );
    }

    const totalCost = roundMoney(filtered.reduce((s, p) => s + getProductCostValue(p), 0));
    const totalRetail = roundMoney(filtered.reduce((s, p) => s + (p.currentStock || 0) * (p.sellPrice || 0), 0));
    const totalQty = filtered.reduce((s, p) => s + (p.currentStock || 0), 0);

    return {
      filtered,
      totalCost,
      totalRetail,
      totalQty,
      itemsCount: filtered.length,
      potentialProfit: totalRetail - totalCost,
    };
  }, [liveProducts, activityFilter, searchQuery]);

  // 2. كشف حساب الطرف المختار (عميل / مورد) من المصدر الموحد دون تكرار احتساب السداد
  const statementData = useMemo(() => {
    if (!selectedPartyId) return null;
    const party = liveParties.find((p) => p.id === selectedPartyId);
    if (!party) return null;

    return buildPartyStatement({
      party,
      invoices: liveInvoices,
      vouchers: liveVouchers,
      paymentAllocations: livePaymentAllocations,
      partyAdvances: livePartyAdvances,
      startDate,
      endDate,
    });
  }, [
    selectedPartyId,
    liveParties,
    liveInvoices,
    liveVouchers,
    livePaymentAllocations,
    livePartyAdvances,
    startDate,
    endDate,
  ]);

  // 3. ميزان المراجعة وتوازن القيد المزدوج (يشمل القيود المرحلة والمعكوسة ويستبعد المسودات)
  const trialBalanceData = useMemo(() => {
    let totalDebit = 0;
    let totalCredit = 0;

    const accountsMap = new Map<
      string,
      { code: string; nameAr: string; type: string; debit: number; credit: number; balance: number }
    >();

    for (const acc of liveAccounts) {
      accountsMap.set(acc.code, {
        code: acc.code,
        nameAr: acc.nameAr,
        type: acc.type,
        debit: 0,
        credit: 0,
        balance: acc.balance || 0,
      });
    }

    for (const entry of liveJournalEntries) {
      if (entry.status === 'DRAFT') continue;
      for (const line of entry.lines) {
        const accItem = accountsMap.get(line.accountCode);
        if (accItem) {
          accItem.debit = roundMoney(accItem.debit + (Number(line.debit) || 0));
          accItem.credit = roundMoney(accItem.credit + (Number(line.credit) || 0));
        }
        totalDebit = roundMoney(totalDebit + (Number(line.debit) || 0));
        totalCredit = roundMoney(totalCredit + (Number(line.credit) || 0));
      }
    }

    const diff = roundMoney(Math.abs(totalDebit - totalCredit));
    const isBalanced = diff <= 0.02;

    return {
      rows: Array.from(accountsMap.values()).filter((r) => r.debit > 0 || r.credit > 0 || r.balance !== 0),
      totalDebit,
      totalCredit,
      diff,
      isBalanced,
    };
  }, [liveAccounts, liveJournalEntries]);

  const balanceSheetData = useMemo(
    () => accounting.getBalanceSheet({ accounts: liveAccounts, entries: liveJournalEntries }),
    [liveAccounts, liveJournalEntries]
  );

  const agingData = useMemo(
    () =>
      accounting.getAgingReport({
        parties: liveParties,
        invoices: liveInvoices,
        partyType: agingPartyType,
      }),
    [liveParties, liveInvoices, agingPartyType]
  );

  const reconciliationRows = useMemo(
    () => accounting.getControlReconciliation({ parties: liveParties, accounts: liveAccounts }),
    [liveParties, liveAccounts]
  );

  const reversedVouchers = useMemo(
    () => liveVouchers.filter((v) => v.status === 'REVERSED'),
    [liveVouchers]
  );

  const reversedJournalEntries = useMemo(
    () => liveJournalEntries.filter((j) => j.status === 'REVERSED'),
    [liveJournalEntries]
  );

  // تشغيل الطباعة
  const handlePrint = (mode: 'A4' | '80mm' = 'A4') => {
    setPrintSize(mode);
    setTimeout(() => {
      window.print();
    }, 100);
  };

  // فتح نافذة إشعار العميل بالسند أو كشف الحساب
  const openNotificationForParty = (party: Party, docNum?: string, amount?: number) => {
    setNotificationModalData({
      isOpen: true,
      name: party.nameAr,
      phone: party.phone || '',
      docNumber: docNum || `STMT-${party.id.slice(0, 8)}`,
      docType: 'STATEMENT',
      amount: amount !== undefined ? amount : Math.abs(party.balance),
      balanceRemaining: party.balance,
      notes: `كشف حساب مالي صادر من ${activeBranch?.nameAr || 'الفرع الرئيسي'}`,
    });
  };

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-7xl mx-auto">
      {/* Top Header & Actions Bar (No Print) */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-4 no-print">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-blue-50 text-blue-700 rounded-xl">
            <BarChart3 className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-base font-extrabold text-slate-900">التقارير المالية والمحاسبية والمطبوعات</h1>
            <p className="text-xs text-slate-500">
              الفرع: <span className="font-bold text-slate-800">{activeBranch?.nameAr}</span> | السنة المالية:{' '}
              <span className="font-mono font-bold text-slate-800">{new Date().getFullYear()}</span>
            </p>
          </div>
        </div>

        {/* Print Buttons Strip */}
        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
          <button
            onClick={() => handlePrint('A4')}
            className="flex items-center gap-1.5 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition-all shadow-sm shrink-0"
            title="طباعة التقرير بحجم صفحة A4 القياسية أو حفظه كـ PDF"
          >
            <Printer className="w-4 h-4 text-emerald-400" />
            <span>طباعة تقرير A4 (أو PDF)</span>
          </button>

          <button
            onClick={() => handlePrint('80mm')}
            className="flex items-center gap-1.5 px-3 py-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-300 rounded-xl text-xs font-bold transition-all shrink-0"
            title="طباعة إيصال سريع لطابعات نقاط البيع الحرارية 80mm"
          >
            <Printer className="w-4 h-4 text-emerald-600" />
            <span>طابعة إيصالات 80mm</span>
          </button>
        </div>
      </div>

      {/* Tabs Navigation (No Print) */}
      <div className="bg-slate-100 p-1.5 rounded-xl flex items-center gap-1 overflow-x-auto no-print text-xs font-bold text-slate-600">
        {canViewProfits && (
          <button
            onClick={() => setActiveTab('activity_profits')}
            className={`px-3.5 py-2 rounded-lg transition-all whitespace-nowrap ${
              activeTab === 'activity_profits' ? 'bg-white text-slate-900 shadow-sm' : 'hover:bg-slate-200/70'
            }`}
          >
            أرباح وخسائر الأنشطة
          </button>
        )}
        <button
          onClick={() => setActiveTab('trial_balance')}
          className={`px-3.5 py-2 rounded-lg transition-all whitespace-nowrap ${
            activeTab === 'trial_balance' ? 'bg-white text-slate-900 shadow-sm' : 'hover:bg-slate-200/70'
          }`}
        >
          ميزان المراجعة الشامل
        </button>
        <button
          onClick={() => setActiveTab('balance_sheet')}
          className={`px-3.5 py-2 rounded-lg transition-all whitespace-nowrap ${
            activeTab === 'balance_sheet' ? 'bg-white text-slate-900 shadow-sm' : 'hover:bg-slate-200/70'
          }`}
        >
          الميزانية العمومية
        </button>
        <button
          onClick={() => setActiveTab('customer_statement')}
          className={`px-3.5 py-2 rounded-lg transition-all whitespace-nowrap ${
            activeTab === 'customer_statement' ? 'bg-white text-slate-900 shadow-sm' : 'hover:bg-slate-200/70'
          }`}
        >
          كشف حساب عميل / مورد
        </button>
        <button
          onClick={() => setActiveTab('aging_advances')}
          className={`px-3.5 py-2 rounded-lg transition-all whitespace-nowrap ${
            activeTab === 'aging_advances' ? 'bg-white text-slate-900 shadow-sm' : 'hover:bg-slate-200/70'
          }`}
        >
          أعمار الديون والأرصدة المقدمة
        </button>
        <button
          onClick={() => setActiveTab('stock_valuation')}
          className={`px-3.5 py-2 rounded-lg transition-all whitespace-nowrap ${
            activeTab === 'stock_valuation' ? 'bg-white text-slate-900 shadow-sm' : 'hover:bg-slate-200/70'
          }`}
        >
          جرد المخزون وصلاحيات FEFO
        </button>
        <button
          onClick={() => setActiveTab('sales_purchases')}
          className={`px-3.5 py-2 rounded-lg transition-all whitespace-nowrap ${
            activeTab === 'sales_purchases' ? 'bg-white text-slate-900 shadow-sm' : 'hover:bg-slate-200/70'
          }`}
        >
          سجل المبيعات والمشتريات
        </button>
        <button
          onClick={() => setActiveTab('amanat_custody')}
          className={`px-3.5 py-2 rounded-lg transition-all whitespace-nowrap ${
            activeTab === 'amanat_custody' ? 'bg-purple-900 text-white shadow-sm' : 'text-purple-900 hover:bg-purple-100'
          }`}
        >
          سجل الأمانات المعزول
        </button>
        <button
          onClick={() => setActiveTab('audit_reconciliation')}
          className={`px-3.5 py-2 rounded-lg transition-all whitespace-nowrap ${
            activeTab === 'audit_reconciliation' ? 'bg-indigo-900 text-white shadow-sm' : 'text-indigo-900 hover:bg-indigo-100'
          }`}
        >
          التدقيق والمطابقة مع الرقابة
        </button>
      </div>

      {/* ========================================================================= */}
      {/* 1. تقرير أرباح وخسائر الأنشطة التجارية الأربعة ومراكز التكلفة */}
      {/* ========================================================================= */}
      {activeTab === 'activity_profits' && canViewProfits && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm printable-area">
          {/* Header */}
          <div className="border-b-2 border-slate-800 pb-4 mb-6 text-center">
            <h2 className="text-lg font-black text-slate-900">نظام الإدارة التجارية والمحاسبية المتكامل</h2>
            <div className="text-xs font-semibold text-slate-600 mt-1">
              فرع: {activeBranch?.nameAr} | السنة المالية: {new Date().getFullYear()}
            </div>
            <h3 className="text-base font-bold text-emerald-800 mt-2">
              قائمة الدخل ومقارنة أداء وربحية الأنشطة التجارية الأربعة
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              تاريخ الطباعة: {new Date().toLocaleDateString('ar-SA')} - {new Date().toLocaleTimeString('ar-SA')}
            </p>
          </div>

          {/* Cards metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6 no-print">
            {activities.map((act) => {
              const income = accounting.getIncomeStatement(act.id, liveAccounts, liveJournalEntries);
              return (
                <div key={act.id} className="p-4 bg-slate-50 rounded-xl border border-slate-200">
                  <div className="text-xs font-bold text-slate-700">{act.nameAr}</div>
                  <div className="text-[11px] font-mono text-slate-500">{act.costCenterCode}</div>
                  <div className="text-base font-black font-mono tabular-nums text-emerald-800 mt-2">
                    {income.netProfit.toFixed(2)} <span className="text-[10px] font-normal text-slate-500">{currencySymbol}</span>
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1">
                    مبيعات: {income.totalRevenue.toFixed(2)} {currencySymbol}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Detailed Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-300 text-slate-700 bg-slate-100 font-extrabold">
                  <th className="py-3 px-4">النشاط التجاري المستقل</th>
                  <th className="py-3 px-4 text-center">مركز التكلفة</th>
                  <th className="py-3 px-4 text-center">عدد الأصناف</th>
                  <th className="py-3 px-4 text-center">إجمالي الإيرادات (4)</th>
                  <th className="py-3 px-4 text-center">تكلفة المبيعات والمصروفات (5)</th>
                  <th className="py-3 px-4 text-center">صافي الربح المحقق</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium">
                {activities.map((act) => {
                  const income = accounting.getIncomeStatement(act.id, liveAccounts, liveJournalEntries);
                  const itemsCount = liveProducts.filter((p) => p.activityId === act.id).length;
                  return (
                    <tr key={act.id} className="hover:bg-slate-50">
                      <td className="py-3 px-4 font-bold text-slate-900">{act.nameAr}</td>
                      <td className="py-3 px-4 text-center font-mono font-bold text-slate-600">{act.costCenterCode}</td>
                      <td className="py-3 px-4 text-center font-mono">{itemsCount}</td>
                      <td className="py-3 px-4 text-center font-mono tabular-nums font-bold text-slate-900">
                        {income.totalRevenue.toFixed(2)} {currencySymbol}
                      </td>
                      <td className="py-3 px-4 text-center font-mono tabular-nums text-rose-800">
                        {income.totalExpenses.toFixed(2)} {currencySymbol}
                      </td>
                      <td className="py-3 px-4 text-center font-mono tabular-nums font-black text-emerald-800 text-sm">
                        {income.netProfit.toFixed(2)} {currencySymbol}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-800 bg-slate-50 font-black text-slate-900 text-xs">
                  <td colSpan={3} className="py-3 px-4 text-left">الإجمالي العام للمنشأة:</td>
                  <td className="py-3 px-4 text-center font-mono tabular-nums">
                    {activities.reduce((s, a) => s + accounting.getIncomeStatement(a.id, liveAccounts, liveJournalEntries).totalRevenue, 0).toFixed(2)} {currencySymbol}
                  </td>
                  <td className="py-3 px-4 text-center font-mono tabular-nums text-rose-800">
                    {activities.reduce((s, a) => s + accounting.getIncomeStatement(a.id, liveAccounts, liveJournalEntries).totalExpenses, 0).toFixed(2)} {currencySymbol}
                  </td>
                  <td className="py-3 px-4 text-center font-mono tabular-nums text-emerald-800 text-sm">
                    {activities.reduce((s, a) => s + accounting.getIncomeStatement(a.id, liveAccounts, liveJournalEntries).netProfit, 0).toFixed(2)} {currencySymbol}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Official Signatures Strip */}
          <div className="grid grid-cols-2 gap-8 text-center text-xs pt-12 mt-8 border-t border-slate-200">
            <div>
              <div className="text-slate-600 mb-6">المحاسب المالي المسؤول</div>
              <div className="font-bold text-slate-900">{currentUser?.fullName || 'المحاسب المعتمد'}</div>
              <div className="border-b border-slate-400 w-36 mx-auto mt-2"></div>
            </div>
            <div>
              <div className="text-slate-600 mb-6">اعتماد المدير العام</div>
              <div className="font-bold text-slate-900">إدارة المنشأة</div>
              <div className="border-b border-slate-400 w-36 mx-auto mt-2"></div>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 2. ميزان المراجعة الشامل (Trial Balance) */}
      {/* ========================================================================= */}
      {activeTab === 'trial_balance' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm printable-area">
          <div className="border-b-2 border-slate-800 pb-4 mb-6 text-center">
            <h2 className="text-lg font-black text-slate-900">نظام الإدارة التجارية والمحاسبية المتكامل</h2>
            <h3 className="text-base font-bold text-blue-900 mt-1">ميزان المراجعة بالأرصدة ومطابقة القيد المزدوج</h3>
            <p className="text-xs text-slate-500 mt-1">
              حالة التوازن: {trialBalanceData.isBalanced ? (
                <span className="font-bold text-emerald-700">متوازن تماماً (مدين = دائن) ✅</span>
              ) : (
                <span className="font-bold text-rose-700">يوجد فارق قدره ({trialBalanceData.diff.toFixed(2)}) ⚠️</span>
              )}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-300 bg-slate-100 font-extrabold text-slate-700">
                  <th className="py-2.5 px-3">رقم الحساب</th>
                  <th className="py-2.5 px-3">اسم الحساب الدفتري</th>
                  <th className="py-2.5 px-3">النوع</th>
                  <th className="py-2.5 px-3 text-center">إجمالي المدين</th>
                  <th className="py-2.5 px-3 text-center">إجمالي الدائن</th>
                  <th className="py-2.5 px-3 text-center">صافي الرصيد</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {trialBalanceData.rows.map((row) => (
                  <tr key={row.code} className="hover:bg-slate-50">
                    <td className="py-2.5 px-3 font-mono font-bold text-slate-800">{row.code}</td>
                    <td className="py-2.5 px-3 font-bold text-slate-900">{row.nameAr}</td>
                    <td className="py-2.5 px-3 text-slate-500 text-[11px]">{row.type}</td>
                    <td className="py-2.5 px-3 text-center font-mono tabular-nums">
                      {row.debit > 0 ? `${row.debit.toFixed(2)} {currencySymbol}` : '-'}
                    </td>
                    <td className="py-2.5 px-3 text-center font-mono tabular-nums">
                      {row.credit > 0 ? `${row.credit.toFixed(2)} {currencySymbol}` : '-'}
                    </td>
                    <td className="py-2.5 px-3 text-center font-mono tabular-nums font-bold text-slate-900">
                      {row.balance.toFixed(2)} {currencySymbol}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-800 bg-slate-50 font-black text-xs">
                  <td colSpan={3} className="py-3 px-3">إجمالي حركات ميزان المراجعة:</td>
                  <td className="py-3 px-3 text-center font-mono tabular-nums text-emerald-800 text-sm">
                    {trialBalanceData.totalDebit.toFixed(2)} {currencySymbol}
                  </td>
                  <td className="py-3 px-3 text-center font-mono tabular-nums text-emerald-800 text-sm">
                    {trialBalanceData.totalCredit.toFixed(2)} {currencySymbol}
                  </td>
                  <td className="py-3 px-3 text-center font-mono tabular-nums font-bold">
                    {trialBalanceData.diff.toFixed(2)} {currencySymbol}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 2B. الميزانية العمومية (Balance Sheet) */}
      {/* ========================================================================= */}
      {activeTab === 'balance_sheet' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm printable-area space-y-6">
          <div className="border-b-2 border-slate-800 pb-4 text-center">
            <h2 className="text-lg font-black text-slate-900">نظام الإدارة التجارية والمحاسبية المتكامل</h2>
            <h3 className="text-base font-bold text-blue-900 mt-1">قائمة المركز المالي (الميزانية العمومية)</h3>
            <p className="text-xs text-slate-500 mt-1">
              تطابق المعادلة المحاسبية (الأصول = الخصوم + حقوق الملكية):{' '}
              {balanceSheetData.isBalanced ? (
                <span className="font-bold text-emerald-700">متوازنة تماماً</span>
              ) : (
                <span className="font-bold text-rose-700">يوجد فارق ({balanceSheetData.diff.toFixed(2)} {currencySymbol})</span>
              )}
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 text-xs">
            {/* الأصول */}
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 bg-blue-900 text-white font-extrabold flex justify-between">
                <span>الأصول (Assets)</span>
                <span className="font-mono">{balanceSheetData.totalAssets.toFixed(2)} {currencySymbol}</span>
              </div>
              <table className="w-full text-right">
                <tbody className="divide-y divide-slate-100">
                  {balanceSheetData.assets.length === 0 ? (
                    <tr>
                      <td className="py-6 text-center text-slate-400">لا توجد أرصدة أصول مسجلة</td>
                    </tr>
                  ) : (
                    balanceSheetData.assets.map((row) => (
                      <tr key={row.code} className="hover:bg-slate-50">
                        <td className="py-2 px-3 font-mono text-slate-500 w-20">{row.code}</td>
                        <td className="py-2 px-3 font-semibold text-slate-900">{row.nameAr}</td>
                        <td className="py-2 px-3 font-mono font-bold text-left text-slate-900">
                          {row.amount.toFixed(2)} {currencySymbol}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* الخصوم وحقوق الملكية */}
            <div className="space-y-4">
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 bg-purple-900 text-white font-extrabold flex justify-between">
                  <span>الخصوم والالتزامات (Liabilities)</span>
                  <span className="font-mono">{balanceSheetData.totalLiabilities.toFixed(2)} {currencySymbol}</span>
                </div>
                <table className="w-full text-right">
                  <tbody className="divide-y divide-slate-100">
                    {balanceSheetData.liabilities.length === 0 ? (
                      <tr>
                        <td className="py-6 text-center text-slate-400">لا توجد التزامات مسجلة</td>
                      </tr>
                    ) : (
                      balanceSheetData.liabilities.map((row) => (
                        <tr key={row.code} className="hover:bg-slate-50">
                          <td className="py-2 px-3 font-mono text-slate-500 w-20">{row.code}</td>
                          <td className="py-2 px-3 font-semibold text-slate-900">{row.nameAr}</td>
                          <td className="py-2 px-3 font-mono font-bold text-left text-slate-900">
                            {row.amount.toFixed(2)} {currencySymbol}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 bg-amber-800 text-white font-extrabold flex justify-between">
                  <span>حقوق الملكية وصافي الربح (Equity)</span>
                  <span className="font-mono">{balanceSheetData.totalEquity.toFixed(2)} {currencySymbol}</span>
                </div>
                <table className="w-full text-right">
                  <tbody className="divide-y divide-slate-100">
                    {balanceSheetData.equity.map((row) => (
                      <tr key={row.code} className="hover:bg-slate-50">
                        <td className="py-2 px-3 font-mono text-slate-500 w-20">{row.code}</td>
                        <td className="py-2 px-3 font-semibold text-slate-900">{row.nameAr}</td>
                        <td className="py-2 px-3 font-mono font-bold text-left text-slate-900">
                          {row.amount.toFixed(2)} {currencySymbol}
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-emerald-50/50">
                      <td className="py-2 px-3 font-mono text-emerald-700 w-20">P&amp;L</td>
                      <td className="py-2 px-3 font-bold text-emerald-900">صافي ربح / خسارة الفترة الحالية</td>
                      <td className="py-2 px-3 font-mono font-extrabold text-left text-emerald-800">
                        {balanceSheetData.netProfit.toFixed(2)} {currencySymbol}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="p-3 bg-slate-900 text-white rounded-xl flex items-center justify-between font-extrabold">
                <span>إجمالي الخصوم + حقوق الملكية:</span>
                <span className="font-mono text-sm text-emerald-400">
                  {balanceSheetData.totalLiabilitiesAndEquity.toFixed(2)} {currencySymbol}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 3. كشف حساب تفصيلي للعميل / المورد مع إشعار واتساب */}
      {/* ========================================================================= */}
      {activeTab === 'customer_statement' && (
        <div className="space-y-6">
          {/* Party Selection & Date Filter (No Print) */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-4 no-print text-xs">
            <div className="flex flex-col sm:flex-row items-center gap-3">
              <div className="flex rounded-lg bg-slate-100 p-1 font-bold">
                <button
                  onClick={() => {
                    setPartyTypeFilter('CUSTOMER');
                    setSelectedPartyId('');
                  }}
                  className={`px-3 py-1.5 rounded-md transition-all ${
                    partyTypeFilter === 'CUSTOMER' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                  }`}
                >
                  العملاء
                </button>
                <button
                  onClick={() => {
                    setPartyTypeFilter('SUPPLIER');
                    setSelectedPartyId('');
                  }}
                  className={`px-3 py-1.5 rounded-md transition-all ${
                    partyTypeFilter === 'SUPPLIER' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                  }`}
                >
                  الموردون
                </button>
              </div>

              <div className="flex-1 w-full">
                <select
                  value={selectedPartyId}
                  onChange={(e) => setSelectedPartyId(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-slate-900 font-bold focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">-- اختر {partyTypeFilter === 'CUSTOMER' ? 'العميل' : 'المورد'} لعرض كشف الحساب --</option>
                  {liveParties
                    .filter((p) => p.type === partyTypeFilter)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nameAr} ({p.phone || 'بدون هاتف'}) - الرصيد: {p.balance.toFixed(2)} {currencySymbol}
                        {(p.advanceBalance || 0) > 0 ? ` | مقدم: ${(p.advanceBalance || 0).toFixed(2)}` : ''}
                      </option>
                    ))}
                </select>
              </div>

              {statementData && (
                <button
                  onClick={() => openNotificationForParty(statementData.party)}
                  className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold transition-all shrink-0 shadow-sm"
                >
                  <MessageSquare className="w-4 h-4" />
                  <span>إرسال كشف الحساب للعميل (واتساب)</span>
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-4 text-slate-600">
              <div className="flex items-center gap-2">
                <span>من تاريخ:</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="px-2.5 py-1.5 border border-slate-300 rounded-lg text-slate-900 font-mono"
                />
              </div>
              <div className="flex items-center gap-2">
                <span>إلى تاريخ:</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="px-2.5 py-1.5 border border-slate-300 rounded-lg text-slate-900 font-mono"
                />
              </div>
              {(startDate || endDate) && (
                <button
                  onClick={() => {
                    setStartDate('');
                    setEndDate('');
                  }}
                  className="text-blue-600 hover:underline"
                >
                  إعادة تعيين الفترة
                </button>
              )}
            </div>
          </div>

          {/* Statement Printable Sheet */}
          {statementData ? (
            <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-sm printable-area">
              <div className="border-b-2 border-slate-800 pb-4 mb-6">
                <div className="flex justify-between items-start">
                  <div>
                    <h2 className="text-lg font-black text-slate-900">نظام الإدارة التجارية والمحاسبية المتكامل</h2>
                    <p className="text-xs text-slate-600">الفرع: {activeBranch?.nameAr}</p>
                  </div>
                  <div className="text-left">
                    <span className="inline-block px-3 py-1 bg-slate-900 text-white font-bold text-xs rounded-md">
                      كشف حساب مالي تفصيلي
                    </span>
                    <p className="text-[11px] text-slate-500 font-mono mt-1">
                      التاريخ: {new Date().toISOString().split('T')[0]}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-4 p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs">
                  <div>
                    <span className="text-slate-500">اسم الطرف: </span>
                    <strong className="text-slate-900">{statementData.party.nameAr}</strong>
                  </div>
                  <div>
                    <span className="text-slate-500">الهاتف: </span>
                    <span className="font-mono text-slate-900">{statementData.party.phone || '-'}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">الصفة: </span>
                    <span className="font-semibold text-slate-900">
                      {statementData.party.type === 'CUSTOMER' ? 'عميل مدين' : 'مورد دائن'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500">الرصيد الختامي (نهاية الفترة): </span>
                    <span className="font-mono font-bold text-sm text-emerald-800">
                      {statementData.periodClosingBalance.toFixed(2)} {currencySymbol}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500">
                      {statementData.party.type === 'CUSTOMER' ? 'الرصيد المقدم (2103): ' : 'سلف المورد (1105): '}
                    </span>
                    <span className="font-mono font-bold text-sm text-indigo-800">
                      {statementData.advanceBalance.toFixed(2)} {currencySymbol}
                    </span>
                  </div>
                </div>
              </div>

              {/* Transactions Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-right text-xs">
                  <thead>
                    <tr className="border-b border-slate-300 bg-slate-100 text-slate-700 font-bold">
                      <th className="py-2.5 px-3">التاريخ</th>
                      <th className="py-2.5 px-3">نوع الحركة</th>
                      <th className="py-2.5 px-3">رقم المستند</th>
                      <th className="py-2.5 px-3">البيان والتخصيص</th>
                      <th className="py-2.5 px-3 text-center">مدين (+)</th>
                      <th className="py-2.5 px-3 text-center">دائن (-)</th>
                      <th className="py-2.5 px-3 text-center">الرصيد التراكمي</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {startDate && (
                      <tr className="bg-slate-50/70 font-bold">
                        <td className="py-2 px-3 font-mono text-slate-600">{startDate}</td>
                        <td className="py-2 px-3 text-slate-700">رصيد أول المدة</td>
                        <td className="py-2 px-3 font-mono">-</td>
                        <td className="py-2 px-3 text-slate-600">الرصيد المرحل لما قبل {startDate}</td>
                        <td className="py-2 px-3 text-center font-mono">-</td>
                        <td className="py-2 px-3 text-center font-mono">-</td>
                        <td className="py-2 px-3 text-center font-mono font-extrabold text-slate-900">
                          {statementData.openingBalance.toFixed(2)} {currencySymbol}
                        </td>
                      </tr>
                    )}
                    {statementData.transactions.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-400">
                          لا توجد حركات مسجلة خلال الفترة المحددة
                        </td>
                      </tr>
                    ) : (
                      statementData.transactions.map((tr) => (
                        <tr key={tr.id} className="hover:bg-slate-50">
                          <td className="py-2.5 px-3 font-mono text-slate-600">{tr.date}</td>
                          <td className="py-2.5 px-3 font-bold text-slate-800">{tr.type}</td>
                          <td className="py-2.5 px-3 font-mono font-bold text-slate-900">{tr.docNumber}</td>
                          <td className="py-2.5 px-3 text-slate-700">
                            <div>{tr.memo}</div>
                            {tr.extraBadge && (
                              <div className="text-[10px] text-indigo-700 font-semibold mt-0.5">{tr.extraBadge}</div>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-center font-mono tabular-nums text-slate-900">
                            {tr.debit > 0 ? tr.debit.toFixed(2) : '-'}
                          </td>
                          <td className="py-2.5 px-3 text-center font-mono tabular-nums text-emerald-700 font-semibold">
                            {tr.credit > 0 ? tr.credit.toFixed(2) : '-'}
                          </td>
                          <td className="py-2.5 px-3 text-center font-mono tabular-nums font-bold text-slate-900">
                            {tr.balanceAfter.toFixed(2)} {currencySymbol}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-800 bg-slate-50 font-black text-xs">
                      <td colSpan={4} className="py-3 px-3">رصيد نهاية الفترة (حسب مجموع الحركات):</td>
                      <td colSpan={3} className="py-3 px-3 text-center font-mono tabular-nums text-sm text-emerald-800">
                        {statementData.periodClosingBalance.toFixed(2)} {currencySymbol}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Signatures */}
              <div className="grid grid-cols-2 gap-8 text-center text-xs pt-10 mt-8 border-t border-slate-200">
                <div>
                  <div className="text-slate-600 mb-6">توقيع وختم الإدارة المالية</div>
                  <div className="font-bold text-slate-900">{currentUser?.fullName || 'المحاسب المسؤول'}</div>
                  <div className="border-b border-slate-400 w-36 mx-auto mt-2"></div>
                </div>
                <div>
                  <div className="text-slate-600 mb-6">مصادقة وتوقيع العميل / المورد</div>
                  <div className="font-bold text-slate-900">{statementData.party.nameAr}</div>
                  <div className="border-b border-slate-400 w-36 mx-auto mt-2"></div>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-12 text-center bg-white rounded-2xl border border-dashed border-slate-300 text-slate-500">
              <User className="w-10 h-10 mx-auto text-slate-400 mb-2" />
              <p className="font-bold">يرجى اختيار عميل أو مورد من القائمة أعلاه لعرض كشف الحساب وطباعته أو إرساله عبر واتساب.</p>
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* 3B. أعمار الديون والفواتير المفتوحة والأرصدة المقدمة (Aging & Advances) */}
      {/* ========================================================================= */}
      {activeTab === 'aging_advances' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm printable-area space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b-2 border-slate-800 pb-4">
            <div>
              <h2 className="text-base font-black text-slate-900">تقرير أعمار الديون والمستحقات والأرصدة المقدمة</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                متابعة الفواتير المفتوحة مصنفة زمنياً (0-30 / 31-60 / 61-90 / +90 يوم) مع الأرصدة المقدمة
              </p>
            </div>
            <div className="flex rounded-lg bg-slate-100 p-1 text-xs font-bold no-print">
              <button
                onClick={() => setAgingPartyType('CUSTOMER')}
                className={`px-3 py-1.5 rounded-md transition-all ${
                  agingPartyType === 'CUSTOMER' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                ذمم العملاء وأرصدة 2103
              </button>
              <button
                onClick={() => setAgingPartyType('SUPPLIER')}
                className={`px-3 py-1.5 rounded-md transition-all ${
                  agingPartyType === 'SUPPLIER' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                مستحقات الموردين وسلف 1105
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-300 bg-slate-100 text-slate-700 font-bold">
                  <th className="py-2.5 px-3">{agingPartyType === 'CUSTOMER' ? 'العميل' : 'المورد'}</th>
                  <th className="py-2.5 px-3 text-center">فواتير مفتوحة</th>
                  <th className="py-2.5 px-3 text-center">0 - 30 يوم</th>
                  <th className="py-2.5 px-3 text-center">31 - 60 يوم</th>
                  <th className="py-2.5 px-3 text-center">61 - 90 يوم</th>
                  <th className="py-2.5 px-3 text-center">+90 يوم</th>
                  <th className="py-2.5 px-3 text-center">إجمالي المفتوح</th>
                  <th className="py-2.5 px-3 text-center">
                    {agingPartyType === 'CUSTOMER' ? 'الرصيد المقدم (2103)' : 'سلف الموردين (1105)'}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {agingData.rows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-slate-400">
                      لا توجد سجلات أطراف مطابقة
                    </td>
                  </tr>
                ) : (
                  agingData.rows.map((r) => (
                    <tr key={r.partyId} className="hover:bg-slate-50">
                      <td className="py-2.5 px-3 font-bold text-slate-900">
                        <div>{r.partyName}</div>
                        <div className="text-[10px] font-mono text-slate-500">{r.phone}</div>
                      </td>
                      <td className="py-2.5 px-3 text-center font-mono">{r.openInvoicesCount}</td>
                      <td className="py-2.5 px-3 text-center font-mono">{r.current0to30.toFixed(2)}</td>
                      <td className="py-2.5 px-3 text-center font-mono">{r.days31to60.toFixed(2)}</td>
                      <td className="py-2.5 px-3 text-center font-mono">{r.days61to90.toFixed(2)}</td>
                      <td className="py-2.5 px-3 text-center font-mono text-rose-700 font-bold">{r.over90.toFixed(2)}</td>
                      <td className="py-2.5 px-3 text-center font-mono font-extrabold text-slate-900">
                        {r.totalOpenBalance.toFixed(2)} {currencySymbol}
                      </td>
                      <td className="py-2.5 px-3 text-center font-mono font-bold text-indigo-800">
                        {r.advanceBalance.toFixed(2)} {currencySymbol}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-800 bg-slate-50 font-black">
                  <td colSpan={2} className="py-3 px-3">الإجمالي:</td>
                  <td className="py-3 px-3 text-center font-mono">{agingData.totals.current0to30.toFixed(2)}</td>
                  <td className="py-3 px-3 text-center font-mono">{agingData.totals.days31to60.toFixed(2)}</td>
                  <td className="py-3 px-3 text-center font-mono">{agingData.totals.days61to90.toFixed(2)}</td>
                  <td className="py-3 px-3 text-center font-mono text-rose-700">{agingData.totals.over90.toFixed(2)}</td>
                  <td className="py-3 px-3 text-center font-mono text-slate-900">
                    {agingData.totals.totalOpenBalance.toFixed(2)} {currencySymbol}
                  </td>
                  <td className="py-3 px-3 text-center font-mono text-indigo-900">
                    {agingData.totals.totalAdvanceBalance.toFixed(2)} {currencySymbol}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 4. جرد وتقييم المخزون وصلاحيات التشغيلات FEFO */}
      {/* ========================================================================= */}
      {activeTab === 'stock_valuation' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm printable-area">
          <div className="border-b-2 border-slate-800 pb-4 mb-6 text-center">
            <h2 className="text-lg font-black text-slate-900">نظام الإدارة التجارية والمحاسبية المتكامل</h2>
            <h3 className="text-base font-bold text-slate-800 mt-1">تقرير جرد المخزون السلعي وتقييم الأرصدة وتواريخ الصلاحية</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              إجمالي قيمة التكلفة: <strong className="text-slate-900 font-mono">{stockValuation.totalCost.toFixed(2)} {currencySymbol}</strong> | 
              قيمة البيع المتوقعة: <strong className="text-emerald-800 font-mono">{stockValuation.totalRetail.toFixed(2)} {currencySymbol}</strong>
            </p>
          </div>

          {/* Filter Bar (No Print) */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mb-4 no-print text-xs">
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <span className="font-bold text-slate-700">تصفية النشاط:</span>
              <select
                value={activityFilter}
                onChange={(e) => setActivityFilter(e.target.value)}
                className="px-3 py-1.5 border border-slate-300 rounded-lg text-slate-900 font-semibold focus:outline-none"
              >
                <option value="ALL">جميع الأنشطة الأربعة</option>
                {activities.map((act) => (
                  <option key={act.id} value={act.id}>
                    {act.nameAr}
                  </option>
                ))}
              </select>
            </div>

            <div className="relative w-full sm:w-64">
              <Search className="w-4 h-4 absolute right-3 top-2.5 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="بحث بالصنف، الباركود، OEM..."
                className="w-full pr-9 pl-3 py-1.5 border border-slate-300 rounded-lg focus:outline-none"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-300 bg-slate-100 text-slate-700 font-extrabold">
                  <th className="py-2.5 px-3">النشاط</th>
                  <th className="py-2.5 px-3">كود الصنف</th>
                  <th className="py-2.5 px-3">اسم الصنف والمواصفات</th>
                  <th className="py-2.5 px-3 text-center">الرصيد المتاح</th>
                  <th className="py-2.5 px-3 text-center">التشغيلات والصلاحية (FEFO)</th>
                  <th className="py-2.5 px-3 text-center">سعر التكلفة</th>
                  <th className="py-2.5 px-3 text-center">سعر البيع</th>
                  <th className="py-2.5 px-3 text-center">إجمالي التكلفة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {stockValuation.filtered.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-slate-400">
                      لا توجد أصناف مطابقة للبحث
                    </td>
                  </tr>
                ) : (
                  stockValuation.filtered.map((prod) => {
                    const totalCost = getProductCostValue(prod);
                    const todayStr = new Date().toISOString().split('T')[0];

                    return (
                      <tr key={prod.id} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3 font-semibold text-slate-600">
                          {activities.find((a) => a.id === prod.activityId)?.nameAr || prod.activityId}
                        </td>
                        <td className="py-2.5 px-3 font-mono font-bold text-slate-900">{prod.code}</td>
                        <td className="py-2.5 px-3">
                          <div className="font-bold text-slate-900">{prod.nameAr}</div>
                          {prod.oemNumber && (
                            <div className="text-[10px] text-blue-700 font-mono">OEM: {prod.oemNumber}</div>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-center font-mono font-bold text-slate-900">
                          {prod.currentStock} {prod.unit}
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          {prod.batches && prod.batches.length > 0 ? (
                            <div className="space-y-0.5">
                              {prod.batches.map((b) => {
                                const isExpired = b.expiryDate < todayStr;
                                return (
                                  <div
                                    key={b.id}
                                    className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                                      isExpired
                                        ? 'bg-rose-100 text-rose-800 font-bold'
                                        : 'bg-emerald-50 text-emerald-800'
                                    }`}
                                  >
                                    {b.batchNumber}: {b.quantity} حبة (ينتهي: {b.expiryDate})
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <span className="text-slate-400 text-[11px]">-</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-center font-mono tabular-nums">
                          {prod.purchasePrice.toFixed(2)}
                        </td>
                        <td className="py-2.5 px-3 text-center font-mono tabular-nums">
                          {prod.sellPrice.toFixed(2)}
                        </td>
                        <td className="py-2.5 px-3 text-center font-mono tabular-nums font-bold text-slate-900">
                          {totalCost.toFixed(2)} {currencySymbol}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-800 bg-slate-50 font-black text-xs">
                  <td colSpan={3} className="py-3 px-3">إجمالي قيمة المخزون الدفتري:</td>
                  <td className="py-3 px-3 text-center font-mono tabular-nums">{stockValuation.totalQty}</td>
                  <td colSpan={3}></td>
                  <td className="py-3 px-3 text-center font-mono tabular-nums text-sm text-slate-900 font-extrabold">
                    {stockValuation.totalCost.toFixed(2)} {currencySymbol}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 5. سجل المبيعات والمشتريات التفصيلي */}
      {/* ========================================================================= */}
      {activeTab === 'sales_purchases' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm printable-area">
          <div className="border-b-2 border-slate-800 pb-4 mb-6 text-center">
            <h2 className="text-lg font-black text-slate-900">نظام الإدارة التجارية والمحاسبية المتكامل</h2>
            <h3 className="text-base font-bold text-slate-800 mt-1">كشف وسجل الفواتير الصادرة والواردة</h3>
            <p className="text-xs text-slate-500 mt-0.5">عدد الفواتير المسجلة: {liveInvoices.length}</p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-300 bg-slate-100 text-slate-700 font-bold">
                  <th className="py-2.5 px-3">رقم الفاتورة</th>
                  <th className="py-2.5 px-3">النوع</th>
                  <th className="py-2.5 px-3">النشاط</th>
                  <th className="py-2.5 px-3">العميل / المورد</th>
                  <th className="py-2.5 px-3 text-center">التاريخ</th>
                  <th className="py-2.5 px-3 text-center">الإجمالي</th>
                  <th className="py-2.5 px-3 text-center">المدفوع</th>
                  <th className="py-2.5 px-3 text-center">المتبقي</th>
                  <th className="py-2.5 px-3 text-center no-print">إشعار العميل</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {liveInvoices.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-8 text-center text-slate-400">
                      لا توجد فواتير مسجلة حالياً
                    </td>
                  </tr>
                ) : (
                  liveInvoices.map((inv) => {
                    const actName = activities.find((a) => a.id === inv.activityId)?.nameAr || inv.activityId;
                    const isReturn = inv.type === 'RETURN_SALE' || inv.type === 'RETURN_PURCHASE';
                    const remaining = isReturn
                      ? 0
                      : Math.max(0, roundMoney(inv.total - inv.paidAmount - (inv.returnedAmount || 0)));

                    return (
                      <tr key={inv.id} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3 font-mono font-bold text-slate-900">{inv.invoiceNumber}</td>
                        <td className="py-2.5 px-3 font-semibold">
                          {inv.type === 'SALE' ? (
                            <span className="text-emerald-700">مبيعات</span>
                          ) : inv.type === 'PURCHASE' ? (
                            <span className="text-blue-700">مشتريات</span>
                          ) : inv.type === 'RETURN_SALE' ? (
                            <span className="text-amber-700">مرتجع مبيعات</span>
                          ) : (
                            <span className="text-amber-700">مرتجع مشتريات</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-slate-600">{actName}</td>
                        <td className="py-2.5 px-3 font-bold text-slate-900">{inv.partyName}</td>
                        <td className="py-2.5 px-3 text-center font-mono">{inv.date}</td>
                        <td className="py-2.5 px-3 text-center font-mono tabular-nums font-bold text-slate-900">
                          {inv.total.toFixed(2)} {currencySymbol}
                        </td>
                        <td className="py-2.5 px-3 text-center font-mono tabular-nums text-emerald-800">
                          {inv.paidAmount.toFixed(2)} {currencySymbol}
                        </td>
                        <td className="py-2.5 px-3 text-center font-mono tabular-nums text-rose-800">
                          {remaining > 0 ? `${remaining.toFixed(2)} ${currencySymbol}` : '-'}
                        </td>
                        <td className="py-2.5 px-3 text-center no-print">
                          <button
                            onClick={() => {
                              const party = liveParties.find((p) => p.id === inv.partyId);
                              setNotificationModalData({
                                isOpen: true,
                                name: inv.partyName,
                                phone: party?.phone || '',
                                docNumber: inv.invoiceNumber,
                                docType: 'INVOICE',
                                amount: inv.total,
                                balanceRemaining: remaining,
                                activityName: actName,
                                notes: `فاتورة ${actName} رقم ${inv.invoiceNumber}`,
                              });
                            }}
                            className="p-1.5 text-emerald-700 hover:bg-emerald-50 rounded-lg transition-colors"
                            title="إرسال سند الفاتورة للعميل عبر واتساب"
                          >
                            <Send className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 6. سجل الأمانات المستقل */}
      {/* ========================================================================= */}
      {activeTab === 'amanat_custody' && (
        <div className="bg-white rounded-2xl border border-purple-200 p-6 shadow-sm printable-area">
          <div className="border-b-2 border-purple-900 pb-4 mb-6 text-center">
            <h2 className="text-lg font-black text-slate-900">نظام الإدارة التجارية والمحاسبية المتكامل</h2>
            <h3 className="text-base font-bold text-purple-950 mt-1">
              تقرير وسجل الأمانات المحفوظة للغير (معزولة محاسبياً ورقابياً)
            </h3>
            <p className="text-xs text-purple-700 mt-1">
              الأمانات النقدية التزام متداول (2102) | الأمانات العينية سجل حفظ رقابي خارج المخزون
            </p>
          </div>

          <table className="w-full text-right text-xs">
            <thead>
              <tr className="border-b border-purple-200 bg-purple-50/60 font-bold text-purple-950">
                <th className="py-2.5 px-3">رقم سند الأمانة</th>
                <th className="py-2.5 px-3">اسم المودع</th>
                <th className="py-2.5 px-3">هاتف المودع</th>
                <th className="py-2.5 px-3">النوع</th>
                <th className="py-2.5 px-3">القيمة / الوصف</th>
                <th className="py-2.5 px-3 text-center">تاريخ الإيداع</th>
                <th className="py-2.5 px-3 text-center">الحالة</th>
                <th className="py-2.5 px-3 text-center no-print">إشعار</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {liveAmanat.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-slate-400">
                    لا توجد أمانات مسجلة
                  </td>
                </tr>
              ) : (
                liveAmanat.map((r) => (
                  <tr key={r.id} className="hover:bg-purple-50/20">
                    <td className="py-2.5 px-3 font-mono font-bold text-purple-950">{r.recordNumber}</td>
                    <td className="py-2.5 px-3 font-bold text-slate-900">{r.depositorName}</td>
                    <td className="py-2.5 px-3 font-mono">{r.depositorPhone}</td>
                    <td className="py-2.5 px-3 font-semibold">
                      {r.type === 'CASH' ? 'أمانة نقدية' : 'أمانة عينية'}
                    </td>
                    <td className="py-2.5 px-3 font-bold text-slate-900">
                      {r.type === 'CASH' ? (
                        <div>
                          <span>{`${r.amount.toFixed(2)} ${currencySymbol}`}</span>
                          {(r.returnedAmount || 0) > 0 && r.status === 'HELD' && (
                            <span className="block text-[10px] text-amber-700 font-semibold">
                              متبقي: {Math.max(0, roundMoney(r.amount - (r.returnedAmount || 0))).toFixed(2)} {currencySymbol}
                            </span>
                          )}
                        </div>
                      ) : (
                        r.itemDescription
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-center font-mono">{r.receivedDate}</td>
                    <td className="py-2.5 px-3 text-center font-bold">
                      {r.status === 'HELD' ? (
                        <span className="px-2 py-0.5 bg-amber-100 text-amber-900 rounded-full text-[10px]">
                          {(r.returnedAmount || 0) > 0 ? 'مرتجع جزئياً' : 'محفوظة في الحرز'}
                        </span>
                      ) : r.status === 'CANCELLED' ? (
                        <span className="px-2 py-0.5 bg-rose-100 text-rose-900 rounded-full text-[10px]">
                          ملغاة
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 bg-emerald-100 text-emerald-900 rounded-full text-[10px]">
                          تم الرد والإبراء
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-center no-print">
                      <button
                        onClick={() => {
                          setNotificationModalData({
                            isOpen: true,
                            name: r.depositorName,
                            phone: r.depositorPhone,
                            docNumber: r.recordNumber,
                            docType: r.status === 'RETURNED' ? 'STATEMENT' : 'RECEIPT_VOUCHER',
                            amount: r.type === 'CASH' ? r.amount : undefined,
                            notes: r.type === 'ITEM' ? `أمانة عينية: ${r.itemDescription}` : 'أمانة نقدية محفوظة',
                          });
                        }}
                        className="p-1.5 text-purple-700 hover:bg-purple-100 rounded-lg transition-colors"
                        title="إرسال إشعار السند للمودع عبر واتساب"
                      >
                        <Send className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 7. تقرير المطابقة مع حسابات الرقابة والتعديلات اليدوية والقيود المعكوسة */}
      {/* ========================================================================= */}
      {activeTab === 'audit_reconciliation' && (
        <div className="space-y-6 printable-area">
          {/* 1. مطابقة أرصدة الأطراف مع حسابات الرقابة */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-4">
            <div className="border-b border-slate-200 pb-3">
              <h3 className="text-base font-black text-slate-900">تقرير المطابقة بين أرصدة الأطراف التفصيلية وحسابات الرقابة (GL)</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                يتحقق تلقائياً من تطابق مجموع ذمم وأرصدة العملاء والموردين مع الحسابات الرقابية 1103، 2101، 2103، 1105
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="border-b border-slate-300 bg-slate-100 text-slate-700 font-bold">
                    <th className="py-2.5 px-3">البند الرقابي</th>
                    <th className="py-2.5 px-3 text-center">كود الحساب</th>
                    <th className="py-2.5 px-3 text-center">إجمالي سجل الأطراف</th>
                    <th className="py-2.5 px-3 text-center">رصيد دفتر الأستاذ</th>
                    <th className="py-2.5 px-3 text-center">الفارق</th>
                    <th className="py-2.5 px-3 text-center">الحالة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {reconciliationRows.map((r) => (
                    <tr key={r.key} className="hover:bg-slate-50">
                      <td className="py-2.5 px-3 font-bold text-slate-900">{r.label}</td>
                      <td className="py-2.5 px-3 text-center font-mono font-bold text-slate-700">{r.controlAccountCode}</td>
                      <td className="py-2.5 px-3 text-center font-mono font-bold">{r.subledgerTotal.toFixed(2)} {currencySymbol}</td>
                      <td className="py-2.5 px-3 text-center font-mono font-bold">{r.glAccountBalance.toFixed(2)} {currencySymbol}</td>
                      <td className="py-2.5 px-3 text-center font-mono font-bold">{r.diff.toFixed(2)} {currencySymbol}</td>
                      <td className="py-2.5 px-3 text-center">
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            r.isMatched
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-rose-100 text-rose-800'
                          }`}
                        >
                          {r.isMatched ? 'متطابق' : 'يوجد فارق'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 2. سجل التعديلات اليدوية لتخصيص الدفعات */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-4">
            <div className="border-b border-slate-200 pb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-black text-slate-900">تقرير التعديلات اليدوية على تخصيص الدفعات</h3>
                <p className="text-xs text-slate-500">سجل تدقيق غير قابل للتعديل لتجاوزات FIFO بصلاحية payment:allocation:override</p>
              </div>
              <span className="font-mono text-xs font-bold bg-indigo-50 text-indigo-800 px-2.5 py-1 rounded">
                {liveAllocationAudits.length} تعديل
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-700 font-bold">
                    <th className="py-2 px-3">التاريخ والوقت</th>
                    <th className="py-2 px-3">السند</th>
                    <th className="py-2 px-3">المستخدم</th>
                    <th className="py-2 px-3">السبب</th>
                    <th className="py-2 px-3">التوزيع السابق (FIFO)</th>
                    <th className="py-2 px-3">التوزيع المعتمد الجديد</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {liveAllocationAudits.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-slate-400">
                        لا توجد تعديلات يدوية على تخصيص الدفعات مسجلة
                      </td>
                    </tr>
                  ) : (
                    liveAllocationAudits.map((a) => (
                      <tr key={a.id}>
                        <td className="py-2 px-3 font-mono text-[11px]">{a.timestamp.replace('T', ' ').slice(0, 19)}</td>
                        <td className="py-2 px-3 font-mono font-bold">
                          {liveVouchers.find((v) => v.id === a.voucherId)?.voucherNumber || a.voucherId}
                        </td>
                        <td className="py-2 px-3 font-semibold">{a.userName}</td>
                        <td className="py-2 px-3 text-slate-700">{a.reason}</td>
                        <td className="py-2 px-3 font-mono text-[11px]">
                          {a.previousAllocations.map((p) => `${p.invoiceNumber || p.invoiceId}: ${p.allocatedAmount}`).join(' | ') || '-'}
                        </td>
                        <td className="py-2 px-3 font-mono text-[11px] font-bold text-indigo-800">
                          {a.newAllocations.map((n) => `${n.invoiceNumber || n.invoiceId}: ${n.allocatedAmount}`).join(' | ') || '-'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* 3. تقرير السندات والقيود المعكوسة */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-4">
            <div className="border-b border-slate-200 pb-3">
              <h3 className="text-sm font-black text-slate-900">تقرير القيود والسندات المعكوسة</h3>
              <p className="text-xs text-slate-500">كافة المستندات التي خضعت لإجراء عكسي موثق مع مرجع القيد العكسي والسبب</p>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
              <div>
                <h4 className="font-bold text-slate-800 mb-2">السندات المعكوسة ({reversedVouchers.length})</h4>
                <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                  {reversedVouchers.length === 0 ? (
                    <div className="p-4 text-center text-slate-400">لا توجد سندات معكوسة</div>
                  ) : (
                    reversedVouchers.map((v) => (
                      <div key={v.id} className="p-2.5 space-y-0.5">
                        <div className="flex justify-between font-bold">
                          <span className="font-mono">{v.voucherNumber} ({v.partyName})</span>
                          <span className="font-mono text-rose-700">{v.amount.toFixed(2)} {currencySymbol}</span>
                        </div>
                        <div className="text-[11px] text-slate-600">السبب: {v.reversalReason || '-'}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div>
                <h4 className="font-bold text-slate-800 mb-2">القيود المعكوسة ({reversedJournalEntries.length})</h4>
                <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                  {reversedJournalEntries.length === 0 ? (
                    <div className="p-4 text-center text-slate-400">لا توجد قيود معكوسة</div>
                  ) : (
                    reversedJournalEntries.map((j) => (
                      <div key={j.id} className="p-2.5 space-y-0.5">
                        <div className="flex justify-between font-bold">
                          <span className="font-mono">{j.entryNumber}</span>
                          <span className="font-mono text-slate-500">{j.date}</span>
                        </div>
                        <div className="text-[11px] text-slate-700">{j.description}</div>
                        <div className="text-[11px] text-rose-700">السبب: {j.reversalReason || '-'}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Reusable Customer Notification Modal */}
      <CustomerNotificationModal
        isOpen={notificationModalData.isOpen}
        onClose={() => setNotificationModalData((prev) => ({ ...prev, isOpen: false }))}
        recipientName={notificationModalData.name}
        recipientPhone={notificationModalData.phone}
        documentType={notificationModalData.docType}
        documentNumber={notificationModalData.docNumber}
        amount={notificationModalData.amount}
        balanceRemaining={notificationModalData.balanceRemaining}
        activityName={notificationModalData.activityName}
        notes={notificationModalData.notes}
      />
    </div>
  );
};
