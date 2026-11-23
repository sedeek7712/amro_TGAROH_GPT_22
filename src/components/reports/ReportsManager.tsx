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
 * 7. الطباعة المباشرة وحفظ ملفات PDF بمقاس A4 ومقاس إيصال 80mm عبر نظام المستندات الموحد
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  FileDown,
  MessageSquare,
  Printer,
  Search,
  Send,
  User,
} from 'lucide-react';
import { storage, OFFICIAL_ACTIVITIES } from '../../services/storageService';
import { desktopSession } from '../../services/desktopSession';
import { accounting } from '../../services/accountingEngine';
import {
  useLiveAccounts,
  useLiveAllocationAudits,
  useLiveAmanatRecords,
  useLiveBranches,
  useLiveInvoices,
  useLiveJournalEntries,
  useLiveParties,
  useLivePartyAdvances,
  useLivePaymentAllocations,
  useLiveProducts,
  useLiveVouchers,
} from '../../hooks/useLiveDexie';
import type { AmanatRecord, Invoice, Party } from '../../types/erp';
import { CustomerNotificationModal } from '../common/CustomerNotificationModal';
import { ReceiptModal } from '../common/ReceiptModal';
import { AmanatReceiptModal } from '../common/AmanatReceiptModal';
import { authService } from '../../services/authService';
import { hasPermission } from '../../config/rbac';
import { getActiveCurrencyConfig, roundMoney } from '../../config/currency';
import { buildPartyStatement } from '../../utils/partyStatement';
import { getProductCostValue } from '../../utils/inventoryValuation';
import { useDocumentContext } from '../../hooks/useDocumentContext';
import { formatLocalDate, formatLocalDateTime } from '../../utils/localDate';
import {
  applyPrintPageStyle,
  exportDocumentPdf,
  getSaveStatusLabel,
  triggerNativePrint,
  type DocumentPaperSize,
  type SaveDocumentStatus,
} from '../../utils/printDocument';
import {
  buildAmanatNotificationPayload,
  buildInvoiceNotificationPayload,
  computeInvoiceOpenRemaining,
  type NotificationPayload,
} from '../../utils/documentNotifications';
import {
  buildAmanatDocumentSnapshot,
  buildInvoiceDocumentSnapshot,
  buildPartyStatementDocumentSnapshot,
  buildReportDocumentSnapshot,
  buildStructuredBaseName,
  type DocumentSnapshot,
} from '../../services/documents/documentService';
import {
  DocumentFooter,
  DocumentHeader,
  DocumentSignatures,
} from '../documents/DocumentPrimitives';
import { PartyStatementDocument } from '../documents/PartyStatementDocument';

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
  const yemenNow = formatLocalDateTime();
  const todayLocal = formatLocalDate();

  const [activeTab, setActiveTab] = useState<ReportTab>(
    canViewProfits ? 'activity_profits' : 'trial_balance'
  );
  const [printSize, setPrintSize] = useState<DocumentPaperSize>('A4');
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [pdfSaveState, setPdfSaveState] = useState<SaveDocumentStatus>('IDLE');
  const [reportActionNotice, setReportActionNotice] = useState<string | null>(null);

  // فلاتر كشف الحساب وأعمار الديون
  const [selectedPartyId, setSelectedPartyId] = useState<string>('');
  const [partyTypeFilter, setPartyTypeFilter] = useState<'CUSTOMER' | 'SUPPLIER'>('CUSTOMER');
  const [agingPartyType, setAgingPartyType] = useState<'CUSTOMER' | 'SUPPLIER'>('CUSTOMER');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');

  // فلاتر المخزون والمبيعات
  const [activityFilter, setActivityFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // معاينات الطباعة المستقلة من التقارير
  const [printableInvoice, setPrintableInvoice] = useState<Invoice | null>(null);
  const [printableAmanat, setPrintableAmanat] = useState<AmanatRecord | null>(null);

  // نافذة إرسال الإشعار للعميل/المورد/المودع/التقرير
  const [notificationState, setNotificationState] = useState<
    NotificationPayload & { isOpen: boolean; snapshot?: DocumentSnapshot }
  >({
    isOpen: false,
    recipientName: '',
    recipientPhone: '',
    documentNumber: '',
    documentType: 'STATEMENT',
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
  const liveVouchers = useLiveVouchers();
  const livePaymentAllocations = useLivePaymentAllocations();
  const livePartyAdvances = useLivePartyAdvances();
  const liveAllocationAudits = useLiveAllocationAudits();
  const liveAmanat = useLiveAmanatRecords();
  const liveBranches = useLiveBranches();

  const { activeBranch, resolveMeta } = useDocumentContext();
  const docMeta = useMemo(
    () =>
      resolveMeta({
        activityId: activityFilter !== 'ALL' ? activityFilter : undefined,
      }),
    [resolveMeta, activityFilter]
  );

  // Sync dynamic @page style whenever printSize changes
  useEffect(() => {
    applyPrintPageStyle(printSize);
  }, [printSize]);

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
    const totalRetail = roundMoney(
      filtered.reduce((s, p) => s + (p.currentStock || 0) * (p.sellPrice || 0), 0)
    );
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
      rows: Array.from(accountsMap.values()).filter(
        (r) => r.debit > 0 || r.credit > 0 || r.balance !== 0
      ),
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

  const buildActiveReportSnapshot = (size: DocumentPaperSize = printSize): DocumentSnapshot => {
    const dec = docMeta.currency.decimalPlaces ?? 2;
    if (activeTab === 'customer_statement' && statementData) {
      return buildPartyStatementDocumentSnapshot({
        statement: statementData,
        meta: docMeta,
        paperSize: size,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      });
    }

    if (activeTab === 'trial_balance') {
      return buildReportDocumentSnapshot({
        reportKey: 'trial_balance',
        reportTitle: 'ميزان المراجعة الشامل',
        reportSubtitle: `السنة المالية ${yemenNow.year}`,
        meta: docMeta,
        paperSize: size,
        date: todayLocal,
        summaryRows: [
          { label: 'إجمالي المدين', value: `${trialBalanceData.totalDebit.toFixed(dec)} ${currencySymbol}` },
          { label: 'إجمالي الدائن', value: `${trialBalanceData.totalCredit.toFixed(dec)} ${currencySymbol}` },
          { label: 'التطابق', value: trialBalanceData.isBalanced ? 'متوازن' : 'يوجد فرق' },
        ],
        table: {
          columns: [
            { label: 'الحساب', align: 'right', widthWeight: 2.8 },
            { label: 'مدين', align: 'center', widthWeight: 1.2 },
            { label: 'دائن', align: 'center', widthWeight: 1.2 },
          ],
          rows: trialBalanceData.rows.slice(0, 80).map((r) => [
            `${r.code} - ${r.nameAr}`,
            r.debit > 0 ? r.debit.toFixed(dec) : '-',
            r.credit > 0 ? r.credit.toFixed(dec) : '-',
          ]),
        },
      });
    }

    if (activeTab === 'balance_sheet') {
      return buildReportDocumentSnapshot({
        reportKey: 'balance_sheet',
        reportTitle: 'الميزانية العمومية (المركز المالي)',
        reportSubtitle: `بتاريخ ${todayLocal}`,
        meta: docMeta,
        paperSize: size,
        date: todayLocal,
        summaryRows: [
          { label: 'إجمالي الأصول', value: `${balanceSheetData.totalAssets.toFixed(dec)} ${currencySymbol}` },
          {
            label: 'الالتزامات وحقوق الملكية',
            value: `${(balanceSheetData.totalLiabilities + balanceSheetData.totalEquity + balanceSheetData.netProfit).toFixed(dec)} ${currencySymbol}`,
          },
        ],
      });
    }

    if (activeTab === 'stock_valuation') {
      return buildReportDocumentSnapshot({
        reportKey: 'stock_valuation',
        reportTitle: 'تقرير جرد وتقييم المخزون',
        reportSubtitle: activityFilter === 'ALL' ? 'جميع الأنشطة' : activityFilter,
        meta: docMeta,
        paperSize: size,
        date: todayLocal,
        summaryRows: [
          { label: 'عدد الأصناف', value: String(stockValuation.filtered.length) },
          { label: 'إجمالي التكلفة', value: `${stockValuation.totalCost.toFixed(dec)} ${currencySymbol}` },
          { label: 'القيمة البيعية', value: `${stockValuation.totalRetail.toFixed(dec)} ${currencySymbol}` },
        ],
        table: {
          columns: [
            { label: 'الصنف', align: 'right', widthWeight: 2.8 },
            { label: 'الكمية', align: 'center', widthWeight: 1.0 },
            { label: 'التكلفة', align: 'left', widthWeight: 1.3 },
          ],
          rows: stockValuation.filtered.slice(0, 80).map((p) => [
            p.nameAr,
            String(p.currentStock),
            getProductCostValue(p).toFixed(dec),
          ]),
        },
      });
    }

    return buildReportDocumentSnapshot({
      reportKey: activeTab,
      reportTitle: `تقرير (${activeTab})`,
      reportSubtitle: `السنة المالية ${yemenNow.year}`,
      meta: docMeta,
      paperSize: size,
      date: todayLocal,
      summaryRows: [
        { label: 'الفرع', value: docMeta.branchName },
        { label: 'تاريخ الإصدار', value: todayLocal },
      ],
    });
  };

  const handlePrint = async (mode: DocumentPaperSize = printSize) => {
    setPrintSize(mode);
    applyPrintPageStyle(mode);
    const snap = buildActiveReportSnapshot(mode);
    const res = await triggerNativePrint(mode, {
      snapshot: snap,
      userId: actor?.id,
      userName: actor?.fullName,
    });
    setReportActionNotice(res.message);
  };

  const handleExportPdf = async () => {
    if (isExportingPdf) return;
    setIsExportingPdf(true);
    setPdfSaveState('PREPARING');
    setReportActionNotice(null);
    try {
      const snap = buildActiveReportSnapshot(printSize);
      const res = await exportDocumentPdf({
        title: buildStructuredBaseName({
          kind: 'REPORT',
          documentNumber: activeTab.toUpperCase(),
          date: todayLocal,
        }),
        pageSize: printSize,
        snapshot: snap,
        userId: actor?.id,
        userName: actor?.fullName,
        onStatusChange: setPdfSaveState,
      });
      setPdfSaveState(res.status);
      setReportActionNotice(res.message);
    } finally {
      setIsExportingPdf(false);
    }
  };

  const handleShareActiveReportPdf = () => {
    const snap = buildActiveReportSnapshot(printSize);
    setNotificationState({
      isOpen: true,
      recipientName: snap.partyName || docMeta.companyNameAr,
      recipientPhone: snap.partyPhone || '',
      documentNumber: snap.documentNumber,
      documentType: 'STATEMENT',
      amount: snap.amount,
      date: todayLocal,
      balanceRemaining: snap.remainingBalance,
      notes: `${snap.documentTitle} - ${snap.documentSubtitle || ''}`.trim(),
      snapshot: snap,
    });
  };

  const openNotificationForParty = (party: Party, docNum?: string, amount?: number) => {
    const snap =
      statementData && statementData.party.id === party.id
        ? buildPartyStatementDocumentSnapshot({
            statement: statementData,
            meta: docMeta,
            paperSize: 'A4',
            startDate: startDate || undefined,
            endDate: endDate || undefined,
          })
        : undefined;
    setNotificationState({
      isOpen: true,
      recipientName: party.nameAr,
      recipientPhone: party.phone || '',
      documentNumber: docNum || `STMT-${party.id.slice(0, 8)}`,
      documentType: 'STATEMENT',
      amount: amount !== undefined ? amount : Math.abs(party.balance),
      date: todayLocal,
      balanceRemaining: party.balance,
      notes: `كشف حساب مالي صادر من ${activeBranch?.nameAr || docMeta.branchName}`,
      snapshot: snap,
    });
  };

  const is58 = printSize === '58mm';
  const isThermal = printSize === '80mm' || is58;
  const sheetContainerClass = is58
    ? 'bg-white border border-slate-300 p-2 shadow-sm printable-area doc-sheet-58mm max-w-[56mm] mx-auto rounded-lg'
    : isThermal
    ? 'bg-white border border-slate-300 p-3 shadow-sm printable-area doc-sheet-80mm max-w-[80mm] mx-auto rounded-lg'
    : 'bg-white rounded-2xl border border-slate-200 p-6 shadow-sm printable-area doc-sheet-a4';

  const activityFilterLabel =
    activityFilter === 'ALL'
      ? 'جميع الأنشطة التجارية'
      : activities.find((a) => a.id === activityFilter)?.nameAr || activityFilter;

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-7xl mx-auto">
      {/* Top Header & Actions Bar (No Print) */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm space-y-3 no-print">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-blue-50 text-blue-700 rounded-xl">
              <BarChart3 className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-base font-extrabold text-slate-900">
                التقارير المالية والمحاسبية والمطبوعات
              </h1>
              <p className="text-xs text-slate-500">
                المنشأة: <span className="font-bold text-slate-800">{docMeta.companyNameAr}</span> |
                الفرع: <span className="font-bold text-slate-800">{docMeta.branchName}</span> | السنة
                المالية: <span className="font-mono font-bold text-slate-800">{yemenNow.year}</span>
              </p>
            </div>
          </div>

          {/* Print Size Selector + Print, PDF & Share Strip */}
          <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
            <div
              className="inline-flex rounded-xl bg-slate-100 p-1 text-xs font-bold border border-slate-200"
              role="group"
              aria-label="مقاس ورقة التقرير"
            >
              <button
                type="button"
                onClick={() => setPrintSize('A4')}
                className={`px-2.5 py-1.5 rounded-lg transition-all ${
                  printSize === 'A4'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                معاينة A4
              </button>
              <button
                type="button"
                onClick={() => setPrintSize('80mm')}
                className={`px-2.5 py-1.5 rounded-lg transition-all ${
                  printSize === '80mm'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                معاينة 80mm
              </button>
              <button
                type="button"
                onClick={() => setPrintSize('58mm')}
                className={`px-2.5 py-1.5 rounded-lg transition-all ${
                  printSize === '58mm'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                معاينة 58mm
              </button>
            </div>

            <button
              type="button"
              onClick={handleExportPdf}
              disabled={isExportingPdf}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-900 border border-slate-300 rounded-xl text-xs font-bold transition-all shrink-0 disabled:opacity-60"
              title="حفظ التقرير بصيغة PDF بالمقاس المحدد"
            >
              <FileDown className="w-4 h-4 text-blue-700" />
              <span>
                {isExportingPdf ? getSaveStatusLabel(pdfSaveState) || 'جاري الحفظ...' : 'حفظ PDF'}
              </span>
            </button>

            <button
              type="button"
              onClick={handleShareActiveReportPdf}
              className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition-all shrink-0"
              title="مشاركة التقرير الرسمي بصيغة PDF عبر واتساب"
            >
              <Send className="w-4 h-4" />
              <span>مشاركة PDF</span>
            </button>

            <button
              type="button"
              onClick={() => handlePrint('A4')}
              className="flex items-center gap-1.5 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition-all shadow-sm shrink-0"
              title="طباعة التقرير بحجم صفحة A4 القياسية"
            >
              <Printer className="w-4 h-4 text-emerald-400" />
              <span>طباعة تقرير A4</span>
            </button>

            <button
              type="button"
              onClick={() => handlePrint('80mm')}
              className="flex items-center gap-1.5 px-3 py-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-300 rounded-xl text-xs font-bold transition-all shrink-0"
              title="طباعة ملخص حراري لطابعات نقاط البيع 80mm"
            >
              <Printer className="w-4 h-4 text-emerald-600" />
              <span>طابعة 80mm</span>
            </button>

            <button
              type="button"
              onClick={() => handlePrint('58mm')}
              className="flex items-center gap-1.5 px-3 py-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-300 rounded-xl text-xs font-bold transition-all shrink-0"
              title="طباعة ملخص حراري لطابعات نقاط البيع 58mm"
            >
              <Printer className="w-4 h-4 text-emerald-600" />
              <span>طابعة 58mm</span>
            </button>
          </div>
        </div>

        {(reportActionNotice || (pdfSaveState !== 'IDLE' && getSaveStatusLabel(pdfSaveState))) && (
          <div className="px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-[11px] font-semibold text-slate-800 flex items-center justify-between">
            <span>
              {pdfSaveState !== 'IDLE' && (
                <strong className="ml-2 text-blue-800">[{getSaveStatusLabel(pdfSaveState)}]</strong>
              )}
              {reportActionNotice}
            </span>
            <button
              type="button"
              onClick={() => {
                setReportActionNotice(null);
                setPdfSaveState('IDLE');
              }}
              className="text-slate-500 hover:text-slate-900"
            >
              إخفاء
            </button>
          </div>
        )}
      </div>

      {/* Tabs Navigation (No Print) */}
      <div className="bg-slate-100 p-1.5 rounded-xl flex items-center gap-1 overflow-x-auto no-print text-xs font-bold text-slate-600">
        {canViewProfits && (
          <button
            type="button"
            onClick={() => setActiveTab('activity_profits')}
            className={`px-3.5 py-2 rounded-lg transition-all whitespace-nowrap ${
              activeTab === 'activity_profits'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'hover:bg-slate-200/70'
            }`}
          >
            أرباح وخسائر الأنشطة
          </button>
        )}
        <button
          type="button"
          onClick={() => setActiveTab('trial_balance')}
          className={`px-3.5 py-2 rounded-lg transition-all whitespace-nowrap ${
            activeTab === 'trial_balance'
              ? 'bg-white text-slate-900 shadow-sm'
              : 'hover:bg-slate-200/70'
          }`}
        >
          ميزان المراجعة الشامل
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('balance_sheet')}
          className={`px-3.5 py-2 rounded-lg transition-all whitespace-nowrap ${
            activeTab === 'balance_sheet'
              ? 'bg-white text-slate-900 shadow-sm'
              : 'hover:bg-slate-200/70'
          }`}
        >
          الميزانية العمومية
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('customer_statement')}
          className={`px-3.5 py-2 rounded-lg transition-all whitespace-nowrap ${
            activeTab === 'customer_statement'
              ? 'bg-white text-slate-900 shadow-sm'
              : 'hover:bg-slate-200/70'
          }`}
        >
          كشف حساب عميل / مورد
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('aging_advances')}
          className={`px-3.5 py-2 rounded-lg transition-all whitespace-nowrap ${
            activeTab === 'aging_advances'
              ? 'bg-white text-slate-900 shadow-sm'
              : 'hover:bg-slate-200/70'
          }`}
        >
          أعمار الديون والأرصدة المقدمة
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('stock_valuation')}
          className={`px-3.5 py-2 rounded-lg transition-all whitespace-nowrap ${
            activeTab === 'stock_valuation'
              ? 'bg-white text-slate-900 shadow-sm'
              : 'hover:bg-slate-200/70'
          }`}
        >
          جرد المخزون وصلاحيات FEFO
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('sales_purchases')}
          className={`px-3.5 py-2 rounded-lg transition-all whitespace-nowrap ${
            activeTab === 'sales_purchases'
              ? 'bg-white text-slate-900 shadow-sm'
              : 'hover:bg-slate-200/70'
          }`}
        >
          سجل المبيعات والمشتريات
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('amanat_custody')}
          className={`px-3.5 py-2 rounded-lg transition-all whitespace-nowrap ${
            activeTab === 'amanat_custody'
              ? 'bg-purple-900 text-white shadow-sm'
              : 'text-purple-900 hover:bg-purple-100'
          }`}
        >
          سجل الأمانات المعزول
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('audit_reconciliation')}
          className={`px-3.5 py-2 rounded-lg transition-all whitespace-nowrap ${
            activeTab === 'audit_reconciliation'
              ? 'bg-indigo-900 text-white shadow-sm'
              : 'text-indigo-900 hover:bg-indigo-100'
          }`}
        >
          التدقيق والمطابقة مع الرقابة
        </button>
      </div>

      {/* ========================================================================= */}
      {/* 1. تقرير أرباح وخسائر الأنشطة التجارية الأربعة ومراكز التكلفة */}
      {/* ========================================================================= */}
      {activeTab === 'activity_profits' && canViewProfits && (
        <div className={sheetContainerClass}>
          <DocumentHeader
            meta={docMeta}
            paperSize={printSize}
            documentTitle="قائمة الدخل وأرباح الأنشطة"
            documentSubtitle="مقارنة أداء وربحية الأنشطة التجارية الأربعة ومراكز التكلفة"
            documentDate={todayLocal}
            periodText={`السنة المالية: ${yemenNow.year}`}
          />

          {/* Interactive summary cards (Screen only when A4) */}
          {!isThermal && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6 no-print">
              {activities.map((act) => {
                const income = accounting.getIncomeStatement(
                  act.id,
                  liveAccounts,
                  liveJournalEntries
                );
                return (
                  <div
                    key={act.id}
                    className="p-4 bg-slate-50 rounded-xl border border-slate-200"
                  >
                    <div className="text-xs font-bold text-slate-700">{act.nameAr}</div>
                    <div className="text-[11px] font-mono text-slate-500">
                      {act.costCenterCode}
                    </div>
                    <div className="text-base font-black font-mono tabular-nums text-emerald-800 mt-2">
                      {income.netProfit.toFixed(2)}{' '}
                      <span className="text-[10px] font-normal text-slate-500">
                        {currencySymbol}
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-500 mt-1">
                      مبيعات: {income.totalRevenue.toFixed(2)} {currencySymbol}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {isThermal ? (
            <div className="space-y-2 text-[10px]">
              {activities.map((act) => {
                const income = accounting.getIncomeStatement(
                  act.id,
                  liveAccounts,
                  liveJournalEntries
                );
                return (
                  <div
                    key={act.id}
                    className="p-2 border border-slate-200 rounded space-y-0.5 doc-break-inside-avoid"
                  >
                    <div className="flex justify-between font-bold text-slate-900">
                      <span>{act.nameAr}</span>
                      <span className="font-mono text-slate-500">{act.costCenterCode}</span>
                    </div>
                    <div className="flex justify-between font-mono tabular-nums">
                      <span className="text-slate-600">الإيرادات:</span>
                      <span>{income.totalRevenue.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between font-mono tabular-nums">
                      <span className="text-slate-600">التكلفة والمصروفات:</span>
                      <span className="text-rose-800">{income.totalExpenses.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between font-mono tabular-nums font-black border-t border-slate-100 pt-0.5">
                      <span>صافي الربح:</span>
                      <span className="text-emerald-800">
                        {income.netProfit.toFixed(2)} {currencySymbol}
                      </span>
                    </div>
                  </div>
                );
              })}
              <div className="p-2 bg-slate-900 text-white rounded font-bold flex justify-between font-mono tabular-nums">
                <span>صافي ربح المنشأة:</span>
                <span>
                  {activities
                    .reduce(
                      (s, a) =>
                        s +
                        accounting.getIncomeStatement(a.id, liveAccounts, liveJournalEntries)
                          .netProfit,
                      0
                    )
                    .toFixed(2)}{' '}
                  {currencySymbol}
                </span>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto border border-slate-200 rounded-xl">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="border-b border-slate-300 text-white bg-slate-900 font-extrabold">
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
                    const income = accounting.getIncomeStatement(
                      act.id,
                      liveAccounts,
                      liveJournalEntries
                    );
                    const itemsCount = liveProducts.filter((p) => p.activityId === act.id).length;
                    return (
                      <tr key={act.id} className="hover:bg-slate-50">
                        <td className="py-3 px-4 font-bold text-slate-900">{act.nameAr}</td>
                        <td className="py-3 px-4 text-center font-mono font-bold text-slate-600">
                          {act.costCenterCode}
                        </td>
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
                    <td colSpan={3} className="py-3 px-4 text-left">
                      الإجمالي العام للمنشأة:
                    </td>
                    <td className="py-3 px-4 text-center font-mono tabular-nums">
                      {activities
                        .reduce(
                          (s, a) =>
                            s +
                            accounting.getIncomeStatement(a.id, liveAccounts, liveJournalEntries)
                              .totalRevenue,
                          0
                        )
                        .toFixed(2)}{' '}
                      {currencySymbol}
                    </td>
                    <td className="py-3 px-4 text-center font-mono tabular-nums text-rose-800">
                      {activities
                        .reduce(
                          (s, a) =>
                            s +
                            accounting.getIncomeStatement(a.id, liveAccounts, liveJournalEntries)
                              .totalExpenses,
                          0
                        )
                        .toFixed(2)}{' '}
                      {currencySymbol}
                    </td>
                    <td className="py-3 px-4 text-center font-mono tabular-nums text-emerald-800 text-sm">
                      {activities
                        .reduce(
                          (s, a) =>
                            s +
                            accounting.getIncomeStatement(a.id, liveAccounts, liveJournalEntries)
                              .netProfit,
                          0
                        )
                        .toFixed(2)}{' '}
                      {currencySymbol}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          <DocumentSignatures
            paperSize={printSize}
            slots={[
              {
                roleLabel: 'المحاسب المالي المسؤول',
                name: actor?.fullName || 'المحاسب المعتمد',
              },
              { roleLabel: 'اعتماد المدير العام', name: 'إدارة المنشأة' },
            ]}
          />
          <DocumentFooter
            meta={docMeta}
            paperSize={printSize}
            referenceText="RPT-INCOME-ACTIVITIES"
          />
        </div>
      )}

      {/* ========================================================================= */}
      {/* 2. ميزان المراجعة الشامل (Trial Balance) */}
      {/* ========================================================================= */}
      {activeTab === 'trial_balance' && (
        <div className={sheetContainerClass}>
          <DocumentHeader
            meta={docMeta}
            paperSize={printSize}
            documentTitle="ميزان المراجعة بالأرصدة"
            documentSubtitle="مطابقة القيد المزدوج (يشمل القيود المرحلة والمعكوسة)"
            documentDate={todayLocal}
            statusLabel={
              trialBalanceData.isBalanced
                ? 'متوازن تماماً (مدين = دائن)'
                : `يوجد فارق (${trialBalanceData.diff.toFixed(2)})`
            }
            statusTone={trialBalanceData.isBalanced ? 'success' : 'danger'}
          />

          {isThermal ? (
            <div className="space-y-1.5 text-[9.5px]">
              {trialBalanceData.rows.map((row) => (
                <div
                  key={row.code}
                  className="p-1.5 border border-slate-200 rounded space-y-0.5 doc-break-inside-avoid"
                >
                  <div className="flex justify-between font-bold text-slate-900">
                    <span>{row.nameAr}</span>
                    <span className="font-mono text-slate-500">{row.code}</span>
                  </div>
                  <div className="flex justify-between font-mono tabular-nums text-slate-700">
                    <span>مدين: {row.debit.toFixed(2)}</span>
                    <span>دائن: {row.credit.toFixed(2)}</span>
                    <span className="font-bold text-slate-900">رصيد: {row.balance.toFixed(2)}</span>
                  </div>
                </div>
              ))}
              <div className="p-2 bg-slate-900 text-white rounded font-mono tabular-nums space-y-0.5">
                <div className="flex justify-between">
                  <span>إجمالي المدين:</span>
                  <span>
                    {trialBalanceData.totalDebit.toFixed(2)} {currencySymbol}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>إجمالي الدائن:</span>
                  <span>
                    {trialBalanceData.totalCredit.toFixed(2)} {currencySymbol}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto border border-slate-200 rounded-xl">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="border-b border-slate-300 bg-slate-900 font-extrabold text-white">
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
                        {row.debit > 0 ? `${row.debit.toFixed(2)} ${currencySymbol}` : '-'}
                      </td>
                      <td className="py-2.5 px-3 text-center font-mono tabular-nums">
                        {row.credit > 0 ? `${row.credit.toFixed(2)} ${currencySymbol}` : '-'}
                      </td>
                      <td className="py-2.5 px-3 text-center font-mono tabular-nums font-bold text-slate-900">
                        {row.balance.toFixed(2)} {currencySymbol}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-800 bg-slate-50 font-black text-xs">
                    <td colSpan={3} className="py-3 px-3">
                      إجمالي حركات ميزان المراجعة:
                    </td>
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
          )}

          <DocumentSignatures
            paperSize={printSize}
            slots={[
              { roleLabel: 'إعداد المحاسب', name: actor?.fullName || 'المحاسب المسؤول' },
              { roleLabel: 'مراجعة واعتماد', name: 'الإدارة المالية' },
            ]}
          />
          <DocumentFooter meta={docMeta} paperSize={printSize} referenceText="RPT-TRIAL-BALANCE" />
        </div>
      )}

      {/* ========================================================================= */}
      {/* 2B. الميزانية العمومية (Balance Sheet) */}
      {/* ========================================================================= */}
      {activeTab === 'balance_sheet' && (
        <div className={`${sheetContainerClass} space-y-5`}>
          <DocumentHeader
            meta={docMeta}
            paperSize={printSize}
            documentTitle="قائمة المركز المالي"
            documentSubtitle="الميزانية العمومية (الأصول = الخصوم + حقوق الملكية)"
            documentDate={todayLocal}
            statusLabel={
              balanceSheetData.isBalanced
                ? 'متوازنة تماماً'
                : `يوجد فارق (${balanceSheetData.diff.toFixed(2)} ${currencySymbol})`
            }
            statusTone={balanceSheetData.isBalanced ? 'success' : 'danger'}
          />

          <div
            className={`grid ${
              isThermal ? 'grid-cols-1 gap-3 text-[10px]' : 'grid-cols-1 lg:grid-cols-2 gap-6 text-xs'
            }`}
          >
            {/* الأصول */}
            <div className="border border-slate-200 rounded-xl overflow-hidden doc-break-inside-avoid">
              <div className="px-4 py-2.5 bg-blue-900 text-white font-extrabold flex justify-between">
                <span>الأصول (Assets)</span>
                <span className="font-mono">
                  {balanceSheetData.totalAssets.toFixed(2)} {currencySymbol}
                </span>
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
                        <td className="py-2 px-3 font-mono text-slate-500 w-16">{row.code}</td>
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
              <div className="border border-slate-200 rounded-xl overflow-hidden doc-break-inside-avoid">
                <div className="px-4 py-2.5 bg-purple-900 text-white font-extrabold flex justify-between">
                  <span>الخصوم والالتزامات (Liabilities)</span>
                  <span className="font-mono">
                    {balanceSheetData.totalLiabilities.toFixed(2)} {currencySymbol}
                  </span>
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
                          <td className="py-2 px-3 font-mono text-slate-500 w-16">{row.code}</td>
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

              <div className="border border-slate-200 rounded-xl overflow-hidden doc-break-inside-avoid">
                <div className="px-4 py-2.5 bg-amber-800 text-white font-extrabold flex justify-between">
                  <span>حقوق الملكية وصافي الربح (Equity)</span>
                  <span className="font-mono">
                    {balanceSheetData.totalEquity.toFixed(2)} {currencySymbol}
                  </span>
                </div>
                <table className="w-full text-right">
                  <tbody className="divide-y divide-slate-100">
                    {balanceSheetData.equity.map((row) => (
                      <tr key={row.code} className="hover:bg-slate-50">
                        <td className="py-2 px-3 font-mono text-slate-500 w-16">{row.code}</td>
                        <td className="py-2 px-3 font-semibold text-slate-900">{row.nameAr}</td>
                        <td className="py-2 px-3 font-mono font-bold text-left text-slate-900">
                          {row.amount.toFixed(2)} {currencySymbol}
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-emerald-50/50">
                      <td className="py-2 px-3 font-mono text-emerald-700 w-16">P&amp;L</td>
                      <td className="py-2 px-3 font-bold text-emerald-900">
                        صافي ربح / خسارة الفترة الحالية
                      </td>
                      <td className="py-2 px-3 font-mono font-extrabold text-left text-emerald-800">
                        {balanceSheetData.netProfit.toFixed(2)} {currencySymbol}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="p-3 bg-slate-900 text-white rounded-xl flex items-center justify-between font-extrabold doc-break-inside-avoid">
                <span>إجمالي الخصوم + حقوق الملكية:</span>
                <span className="font-mono text-sm text-emerald-400">
                  {balanceSheetData.totalLiabilitiesAndEquity.toFixed(2)} {currencySymbol}
                </span>
              </div>
            </div>
          </div>

          <DocumentSignatures
            paperSize={printSize}
            slots={[
              { roleLabel: 'المحاسب المالي', name: actor?.fullName || 'المحاسب المعتمد' },
              { roleLabel: 'اعتماد الإدارة العليا', name: 'المدير العام' },
            ]}
          />
          <DocumentFooter meta={docMeta} paperSize={printSize} referenceText="RPT-BALANCE-SHEET" />
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
                  type="button"
                  onClick={() => {
                    setPartyTypeFilter('CUSTOMER');
                    setSelectedPartyId('');
                  }}
                  className={`px-3 py-1.5 rounded-md transition-all ${
                    partyTypeFilter === 'CUSTOMER'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600'
                  }`}
                >
                  العملاء
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPartyTypeFilter('SUPPLIER');
                    setSelectedPartyId('');
                  }}
                  className={`px-3 py-1.5 rounded-md transition-all ${
                    partyTypeFilter === 'SUPPLIER'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600'
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
                  <option value="">
                    -- اختر {partyTypeFilter === 'CUSTOMER' ? 'العميل' : 'المورد'} لعرض كشف الحساب
                    --
                  </option>
                  {liveParties
                    .filter((p) => p.type === partyTypeFilter)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nameAr} ({p.phone || 'بدون هاتف'}) - الرصيد: {p.balance.toFixed(2)}{' '}
                        {currencySymbol}
                        {(p.advanceBalance || 0) > 0
                          ? ` | مقدم: ${(p.advanceBalance || 0).toFixed(2)}`
                          : ''}
                      </option>
                    ))}
                </select>
              </div>

              {statementData && (
                <button
                  type="button"
                  onClick={() => openNotificationForParty(statementData.party)}
                  className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold transition-all shrink-0 shadow-sm"
                >
                  <MessageSquare className="w-4 h-4" />
                  <span>إرسال كشف الحساب (واتساب)</span>
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
                  type="button"
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

          {statementData ? (
            <div className={sheetContainerClass}>
              <PartyStatementDocument
                statement={statementData}
                meta={docMeta}
                paperSize={printSize}
                startDate={startDate}
                endDate={endDate}
              />
            </div>
          ) : (
            <div className="p-12 text-center bg-white rounded-2xl border border-dashed border-slate-300 text-slate-500">
              <User className="w-10 h-10 mx-auto text-slate-400 mb-2" />
              <p className="font-bold">
                يرجى اختيار عميل أو مورد من القائمة أعلاه لعرض كشف الحساب وطباعته أو إرساله عبر
                واتساب.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* 3B. أعمار الديون والفواتير المفتوحة والأرصدة المقدمة (Aging & Advances) */}
      {/* ========================================================================= */}
      {activeTab === 'aging_advances' && (
        <div className={`${sheetContainerClass} space-y-5`}>
          <DocumentHeader
            meta={docMeta}
            paperSize={printSize}
            documentTitle="تقرير أعمار الديون والأرصدة المقدمة"
            documentSubtitle={
              agingPartyType === 'CUSTOMER'
                ? 'تصنيف الفواتير المفتوحة للعملاء والأرصدة المقدمة (2103)'
                : 'تصنيف مستحقات الموردين وسلف الموردين (1105)'
            }
            documentDate={todayLocal}
            periodText="التصنيف الزمني: 0-30 / 31-60 / 61-90 / +90 يوم"
          />

          <div className="flex justify-end no-print">
            <div className="flex rounded-lg bg-slate-100 p-1 text-xs font-bold">
              <button
                type="button"
                onClick={() => setAgingPartyType('CUSTOMER')}
                className={`px-3 py-1.5 rounded-md transition-all ${
                  agingPartyType === 'CUSTOMER'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600'
                }`}
              >
                ذمم العملاء وأرصدة 2103
              </button>
              <button
                type="button"
                onClick={() => setAgingPartyType('SUPPLIER')}
                className={`px-3 py-1.5 rounded-md transition-all ${
                  agingPartyType === 'SUPPLIER'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600'
                }`}
              >
                مستحقات الموردين وسلف 1105
              </button>
            </div>
          </div>

          {isThermal ? (
            <div className="space-y-1.5 text-[9.5px]">
              {agingData.rows.length === 0 ? (
                <div className="py-4 text-center text-slate-400">لا توجد سجلات أطراف مطابقة</div>
              ) : (
                agingData.rows.map((r) => (
                  <div
                    key={r.partyId}
                    className="p-2 border border-slate-200 rounded space-y-0.5 doc-break-inside-avoid"
                  >
                    <div className="flex justify-between font-bold text-slate-900">
                      <span>{r.partyName}</span>
                      <span className="font-mono">({r.openInvoicesCount}) فاتورة</span>
                    </div>
                    <div className="flex justify-between font-mono tabular-nums">
                      <span>مفتوح: {r.totalOpenBalance.toFixed(2)}</span>
                      <span className="text-rose-700">+90 يوم: {r.over90.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between font-mono tabular-nums text-indigo-800">
                      <span>الرصيد المقدم:</span>
                      <span>
                        {r.advanceBalance.toFixed(2)} {currencySymbol}
                      </span>
                    </div>
                  </div>
                ))
              )}
              <div className="p-2 bg-slate-900 text-white rounded font-mono tabular-nums space-y-0.5">
                <div className="flex justify-between font-bold">
                  <span>إجمالي المفتوح:</span>
                  <span>
                    {agingData.totals.totalOpenBalance.toFixed(2)} {currencySymbol}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>إجمالي المقدم:</span>
                  <span>
                    {agingData.totals.totalAdvanceBalance.toFixed(2)} {currencySymbol}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto border border-slate-200 rounded-xl">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="border-b border-slate-300 bg-slate-900 text-white font-bold">
                    <th className="py-2.5 px-3">
                      {agingPartyType === 'CUSTOMER' ? 'العميل' : 'المورد'}
                    </th>
                    <th className="py-2.5 px-3 text-center">فواتير مفتوحة</th>
                    <th className="py-2.5 px-3 text-center">0 - 30 يوم</th>
                    <th className="py-2.5 px-3 text-center">31 - 60 يوم</th>
                    <th className="py-2.5 px-3 text-center">61 - 90 يوم</th>
                    <th className="py-2.5 px-3 text-center">+90 يوم</th>
                    <th className="py-2.5 px-3 text-center">إجمالي المفتوح</th>
                    <th className="py-2.5 px-3 text-center">
                      {agingPartyType === 'CUSTOMER'
                        ? 'الرصيد المقدم (2103)'
                        : 'سلف الموردين (1105)'}
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
                        <td className="py-2.5 px-3 text-center font-mono">
                          {r.current0to30.toFixed(2)}
                        </td>
                        <td className="py-2.5 px-3 text-center font-mono">
                          {r.days31to60.toFixed(2)}
                        </td>
                        <td className="py-2.5 px-3 text-center font-mono">
                          {r.days61to90.toFixed(2)}
                        </td>
                        <td className="py-2.5 px-3 text-center font-mono text-rose-700 font-bold">
                          {r.over90.toFixed(2)}
                        </td>
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
                    <td colSpan={2} className="py-3 px-3">
                      الإجمالي:
                    </td>
                    <td className="py-3 px-3 text-center font-mono">
                      {agingData.totals.current0to30.toFixed(2)}
                    </td>
                    <td className="py-3 px-3 text-center font-mono">
                      {agingData.totals.days31to60.toFixed(2)}
                    </td>
                    <td className="py-3 px-3 text-center font-mono">
                      {agingData.totals.days61to90.toFixed(2)}
                    </td>
                    <td className="py-3 px-3 text-center font-mono text-rose-700">
                      {agingData.totals.over90.toFixed(2)}
                    </td>
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
          )}

          <DocumentFooter meta={docMeta} paperSize={printSize} referenceText="RPT-AGING-ADVANCES" />
        </div>
      )}

      {/* ========================================================================= */}
      {/* 4. جرد وتقييم المخزون وصلاحيات التشغيلات FEFO */}
      {/* ========================================================================= */}
      {activeTab === 'stock_valuation' && (
        <div className={sheetContainerClass}>
          <DocumentHeader
            meta={docMeta}
            paperSize={printSize}
            documentTitle="تقرير جرد وتقييم المخزون"
            documentSubtitle="تقييم الأرصدة الدفترية وتتبع تشغيلات الصلاحية (FEFO)"
            documentDate={todayLocal}
            periodText={`${activityFilterLabel}${
              searchQuery.trim() ? ` | بحث: ${searchQuery.trim()}` : ''
            }`}
          />

          <div
            className={`grid ${
              isThermal ? 'grid-cols-1 gap-1.5 text-[10px]' : 'grid-cols-3 gap-3 text-xs'
            } p-3 rounded-xl border border-slate-200 bg-slate-50 mb-4 doc-break-inside-avoid`}
          >
            <div>
              <span className="text-slate-500">إجمالي الكميات: </span>
              <strong className="font-mono text-slate-900">{stockValuation.totalQty}</strong>
            </div>
            <div>
              <span className="text-slate-500">قيمة التكلفة الدفترية: </span>
              <strong className="font-mono text-slate-900">
                {stockValuation.totalCost.toFixed(2)} {currencySymbol}
              </strong>
            </div>
            <div>
              <span className="text-slate-500">قيمة البيع المتوقعة: </span>
              <strong className="font-mono text-emerald-800">
                {stockValuation.totalRetail.toFixed(2)} {currencySymbol}
              </strong>
            </div>
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

          {isThermal ? (
            <div className="space-y-1.5 text-[9.5px]">
              {stockValuation.filtered.length === 0 ? (
                <div className="py-4 text-center text-slate-400">لا توجد أصناف مطابقة</div>
              ) : (
                stockValuation.filtered.map((prod) => {
                  const totalCost = getProductCostValue(prod);
                  return (
                    <div
                      key={prod.id}
                      className="p-1.5 border border-slate-200 rounded space-y-0.5 doc-break-inside-avoid"
                    >
                      <div className="flex justify-between font-bold text-slate-900">
                        <span>{prod.nameAr}</span>
                        <span className="font-mono text-slate-500">{prod.code}</span>
                      </div>
                      <div className="flex justify-between font-mono tabular-nums">
                        <span>
                          الرصيد: {prod.currentStock} {prod.unit}
                        </span>
                        <span className="font-bold">
                          التكلفة: {totalCost.toFixed(2)} {currencySymbol}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          ) : (
            <div className="overflow-x-auto border border-slate-200 rounded-xl">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="border-b border-slate-300 bg-slate-900 text-white font-extrabold">
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

                      return (
                        <tr key={prod.id} className="hover:bg-slate-50">
                          <td className="py-2.5 px-3 font-semibold text-slate-600">
                            {activities.find((a) => a.id === prod.activityId)?.nameAr ||
                              prod.activityId}
                          </td>
                          <td className="py-2.5 px-3 font-mono font-bold text-slate-900">
                            {prod.code}
                          </td>
                          <td className="py-2.5 px-3">
                            <div className="font-bold text-slate-900">{prod.nameAr}</div>
                            {prod.oemNumber && (
                              <div className="text-[10px] text-blue-700 font-mono">
                                OEM: {prod.oemNumber}
                              </div>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-center font-mono font-bold text-slate-900">
                            {prod.currentStock} {prod.unit}
                          </td>
                          <td className="py-2.5 px-3 text-center">
                            {prod.batches && prod.batches.length > 0 ? (
                              <div className="space-y-0.5">
                                {prod.batches.map((b) => {
                                  const isExpired = b.expiryDate < todayLocal;
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
                    <td colSpan={3} className="py-3 px-3">
                      إجمالي قيمة المخزون الدفتري:
                    </td>
                    <td className="py-3 px-3 text-center font-mono tabular-nums">
                      {stockValuation.totalQty}
                    </td>
                    <td colSpan={3}></td>
                    <td className="py-3 px-3 text-center font-mono tabular-nums text-sm text-slate-900 font-extrabold">
                      {stockValuation.totalCost.toFixed(2)} {currencySymbol}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          <DocumentSignatures
            paperSize={printSize}
            slots={[
              { roleLabel: 'أمين المخزن', name: 'مسؤول المستودع' },
              { roleLabel: 'المراجع المالي', name: actor?.fullName || 'المحاسب المسؤول' },
            ]}
          />
          <DocumentFooter meta={docMeta} paperSize={printSize} referenceText="RPT-STOCK-FEFO" />
        </div>
      )}

      {/* ========================================================================= */}
      {/* 5. سجل المبيعات والمشتريات التفصيلي */}
      {/* ========================================================================= */}
      {activeTab === 'sales_purchases' && (
        <div className={sheetContainerClass}>
          <DocumentHeader
            meta={docMeta}
            paperSize={printSize}
            documentTitle="سجل الفواتير الصادرة والواردة"
            documentSubtitle="كشف فواتير المبيعات والمشتريات والمرتجعات"
            documentDate={todayLocal}
            periodText={`إجمالي المستندات: ${liveInvoices.length}`}
          />

          {isThermal ? (
            <div className="space-y-1.5 text-[9.5px]">
              {liveInvoices.length === 0 ? (
                <div className="py-4 text-center text-slate-400">لا توجد فواتير مسجلة</div>
              ) : (
                liveInvoices.map((inv) => {
                  const remaining = computeInvoiceOpenRemaining(inv);
                  return (
                    <div
                      key={inv.id}
                      className="p-1.5 border border-slate-200 rounded space-y-0.5 doc-break-inside-avoid"
                    >
                      <div className="flex justify-between font-bold text-slate-900">
                        <span className="font-mono">{inv.invoiceNumber}</span>
                        <span className="font-mono text-slate-500">{inv.date}</span>
                      </div>
                      <div className="text-slate-700">{inv.partyName}</div>
                      <div className="flex justify-between font-mono tabular-nums">
                        <span>
                          الإجمالي: {inv.total.toFixed(2)} {currencySymbol}
                        </span>
                        {remaining > 0 && (
                          <span className="text-rose-800">متبقي: {remaining.toFixed(2)}</span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          ) : (
            <div className="overflow-x-auto border border-slate-200 rounded-xl">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="border-b border-slate-300 bg-slate-900 text-white font-bold">
                    <th className="py-2.5 px-3">رقم الفاتورة</th>
                    <th className="py-2.5 px-3">النوع</th>
                    <th className="py-2.5 px-3">النشاط</th>
                    <th className="py-2.5 px-3">العميل / المورد</th>
                    <th className="py-2.5 px-3 text-center">التاريخ</th>
                    <th className="py-2.5 px-3 text-center">الإجمالي</th>
                    <th className="py-2.5 px-3 text-center">المدفوع</th>
                    <th className="py-2.5 px-3 text-center">المتبقي</th>
                    <th className="py-2.5 px-3 text-center no-print">طباعة / إشعار</th>
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
                      const actName =
                        activities.find((a) => a.id === inv.activityId)?.nameAr || inv.activityId;
                      const remaining = computeInvoiceOpenRemaining(inv);

                      return (
                        <tr key={inv.id} className="hover:bg-slate-50">
                          <td className="py-2.5 px-3 font-mono font-bold text-slate-900">
                            {inv.invoiceNumber}
                          </td>
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
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => setPrintableInvoice(inv)}
                                className="p-1.5 text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                                title={`طباعة المستند ${inv.invoiceNumber}`}
                              >
                                <Printer className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  const party = liveParties.find((p) => p.id === inv.partyId);
                                  const payload = buildInvoiceNotificationPayload({
                                    invoice: inv,
                                    activityName: actName,
                                    recipientPhone: party?.phone,
                                  });
                                  const snap = buildInvoiceDocumentSnapshot({
                                    invoice: inv,
                                    meta: resolveMeta({ branchId: inv.branchId, activityId: inv.activityId }),
                                    paperSize: 'A4',
                                    partyPhone: party?.phone,
                                  });
                                  setNotificationState({ isOpen: true, ...payload, snapshot: snap });
                                }}
                                className="p-1.5 text-emerald-700 hover:bg-emerald-50 rounded-lg transition-colors"
                                title={`إرسال إشعار ${inv.invoiceNumber}`}
                              >
                                <Send className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          <DocumentFooter
            meta={docMeta}
            paperSize={printSize}
            referenceText="RPT-SALES-PURCHASES"
          />
        </div>
      )}

      {/* ========================================================================= */}
      {/* 6. سجل الأمانات المستقل */}
      {/* ========================================================================= */}
      {activeTab === 'amanat_custody' && (
        <div className={sheetContainerClass}>
          <DocumentHeader
            meta={docMeta}
            paperSize={printSize}
            documentTitle="سجل الأمانات المحفوظة للغير"
            documentSubtitle="الأمانات النقدية (2102) والأمانات العينية المعزولة محاسبياً"
            documentDate={todayLocal}
            periodText={`عدد السجلات: ${liveAmanat.length}`}
          />

          {isThermal ? (
            <div className="space-y-1.5 text-[9.5px]">
              {liveAmanat.length === 0 ? (
                <div className="py-4 text-center text-slate-400">لا توجد أمانات مسجلة</div>
              ) : (
                liveAmanat.map((r) => (
                  <div
                    key={r.id}
                    className="p-1.5 border border-purple-200 rounded space-y-0.5 doc-break-inside-avoid"
                  >
                    <div className="flex justify-between font-bold text-purple-950">
                      <span className="font-mono">{r.recordNumber}</span>
                      <span>{r.type === 'CASH' ? 'نقدية' : 'عينية'}</span>
                    </div>
                    <div className="font-bold text-slate-900">{r.depositorName}</div>
                    <div className="flex justify-between font-mono text-slate-700">
                      <span>
                        {r.type === 'CASH'
                          ? `${r.amount.toFixed(2)} ${currencySymbol}`
                          : r.itemDescription}
                      </span>
                      <span>
                        {r.status === 'RETURNED'
                          ? 'مُبرأة'
                          : r.status === 'CANCELLED'
                          ? 'ملغاة'
                          : 'محفوظة'}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="overflow-x-auto border border-purple-200 rounded-xl">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="border-b border-purple-200 bg-purple-950 font-bold text-white">
                    <th className="py-2.5 px-3">رقم سند الأمانة</th>
                    <th className="py-2.5 px-3">اسم المودع</th>
                    <th className="py-2.5 px-3">هاتف المودع</th>
                    <th className="py-2.5 px-3">النوع</th>
                    <th className="py-2.5 px-3">القيمة / الوصف</th>
                    <th className="py-2.5 px-3 text-center">تاريخ الإيداع</th>
                    <th className="py-2.5 px-3 text-center">الحالة</th>
                    <th className="py-2.5 px-3 text-center no-print">طباعة / إشعار</th>
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
                        <td className="py-2.5 px-3 font-mono font-bold text-purple-950">
                          {r.recordNumber}
                        </td>
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
                                  متبقي:{' '}
                                  {Math.max(
                                    0,
                                    roundMoney(r.amount - (r.returnedAmount || 0))
                                  ).toFixed(2)}{' '}
                                  {currencySymbol}
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
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => setPrintableAmanat(r)}
                              className="p-1.5 text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                              title={`طباعة سند الأمانة ${r.recordNumber}`}
                            >
                              <Printer className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                const payload = buildAmanatNotificationPayload(r);
                                const matchedEv = r.returnHistory?.find((ev) => ev.id === payload.returnEventId);
                                const snap = buildAmanatDocumentSnapshot({
                                  record: r,
                                  meta: resolveMeta({ branchId: r.branchId, issuerName: r.receivedBy }),
                                  paperSize: 'A4',
                                  returnEvent: payload.documentType === 'AMANAT_RETURN' ? matchedEv : undefined,
                                });
                                setNotificationState({ isOpen: true, ...payload, snapshot: snap });
                              }}
                              className="p-1.5 text-purple-700 hover:bg-purple-100 rounded-lg transition-colors"
                              title={`إرسال إشعار الأمانة ${r.recordNumber}`}
                            >
                              <Send className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          <DocumentFooter
            meta={docMeta}
            paperSize={printSize}
            referenceText="RPT-AMANAT-CUSTODY"
          />
        </div>
      )}

      {/* ========================================================================= */}
      {/* 7. تقرير المطابقة مع حسابات الرقابة والتعديلات اليدوية والقيود المعكوسة */}
      {/* ========================================================================= */}
      {activeTab === 'audit_reconciliation' && (
        <div className={`${sheetContainerClass} space-y-6`}>
          <DocumentHeader
            meta={docMeta}
            paperSize={printSize}
            documentTitle="تقرير التدقيق ومطابقة الرقابة"
            documentSubtitle="مطابقة حسابات الرقابة (1103 / 2101 / 2103 / 1105) وسجلات التجاوز والعكس"
            documentDate={todayLocal}
          />

          {isThermal ? (
            <div className="space-y-2 text-[9.5px]">
              {reconciliationRows.map((r) => (
                <div
                  key={r.key}
                  className="p-1.5 border border-slate-200 rounded space-y-0.5 doc-break-inside-avoid"
                >
                  <div className="flex justify-between font-bold text-slate-900">
                    <span>{r.label}</span>
                    <span className="font-mono">{r.controlAccountCode}</span>
                  </div>
                  <div className="flex justify-between font-mono">
                    <span>فرعي: {r.subledgerTotal.toFixed(2)}</span>
                    <span>أستاذ: {r.glAccountBalance.toFixed(2)}</span>
                    <span className={r.isMatched ? 'text-emerald-800 font-bold' : 'text-rose-700 font-bold'}>
                      {r.isMatched ? 'متطابق' : `فارق ${r.diff.toFixed(2)}`}
                    </span>
                  </div>
                </div>
              ))}
              <div className="p-2 bg-slate-100 border border-slate-200 rounded space-y-0.5 font-semibold">
                <div>تجاوزات التخصيص اليدوي: {liveAllocationAudits.length}</div>
                <div>السندات المعكوسة: {reversedVouchers.length}</div>
                <div>القيود المعكوسة: {reversedJournalEntries.length}</div>
              </div>
            </div>
          ) : (
            <>
              {/* 1. مطابقة أرصدة الأطراف مع حسابات الرقابة */}
              <div className="border border-slate-200 rounded-xl p-4 space-y-3 doc-break-inside-avoid">
                <div className="border-b border-slate-200 pb-2">
                  <h3 className="text-sm font-black text-slate-900">
                    1. المطابقة بين أرصدة الأطراف التفصيلية وحسابات الرقابة (GL)
                  </h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-right text-xs">
                    <thead>
                      <tr className="border-b border-slate-300 bg-slate-900 text-white font-bold">
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
                          <td className="py-2.5 px-3 text-center font-mono font-bold text-slate-700">
                            {r.controlAccountCode}
                          </td>
                          <td className="py-2.5 px-3 text-center font-mono font-bold">
                            {r.subledgerTotal.toFixed(2)} {currencySymbol}
                          </td>
                          <td className="py-2.5 px-3 text-center font-mono font-bold">
                            {r.glAccountBalance.toFixed(2)} {currencySymbol}
                          </td>
                          <td className="py-2.5 px-3 text-center font-mono font-bold">
                            {r.diff.toFixed(2)} {currencySymbol}
                          </td>
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
              <div className="border border-slate-200 rounded-xl p-4 space-y-3 doc-break-inside-avoid">
                <div className="border-b border-slate-200 pb-2 flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-black text-slate-900">
                      2. التعديلات اليدوية على تخصيص الدفعات (تجاوز FIFO)
                    </h3>
                  </div>
                  <span className="font-mono text-xs font-bold bg-indigo-50 text-indigo-800 px-2.5 py-1 rounded">
                    {liveAllocationAudits.length} تعديل
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-right text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-100 text-slate-700 font-bold">
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
                            <td className="py-2 px-3 font-mono text-[11px]">
                              {formatLocalDateTime(a.timestamp).displayTabular}
                            </td>
                            <td className="py-2 px-3 font-mono font-bold">
                              {liveVouchers.find((v) => v.id === a.voucherId)?.voucherNumber ||
                                a.voucherId}
                            </td>
                            <td className="py-2 px-3 font-semibold">{a.userName}</td>
                            <td className="py-2 px-3 text-slate-700">{a.reason}</td>
                            <td className="py-2 px-3 font-mono text-[11px]">
                              {a.previousAllocations
                                .map((p) => `${p.invoiceNumber || p.invoiceId}: ${p.allocatedAmount}`)
                                .join(' | ') || '-'}
                            </td>
                            <td className="py-2 px-3 font-mono text-[11px] font-bold text-indigo-800">
                              {a.newAllocations
                                .map((n) => `${n.invoiceNumber || n.invoiceId}: ${n.allocatedAmount}`)
                                .join(' | ') || '-'}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* 3. تقرير السندات والقيود المعكوسة */}
              <div className="border border-slate-200 rounded-xl p-4 space-y-3 doc-break-inside-avoid">
                <div className="border-b border-slate-200 pb-2">
                  <h3 className="text-sm font-black text-slate-900">
                    3. القيود والسندات المعكوسة
                  </h3>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
                  <div>
                    <h4 className="font-bold text-slate-800 mb-2">
                      السندات المعكوسة ({reversedVouchers.length})
                    </h4>
                    <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                      {reversedVouchers.length === 0 ? (
                        <div className="p-4 text-center text-slate-400">لا توجد سندات معكوسة</div>
                      ) : (
                        reversedVouchers.map((v) => (
                          <div key={v.id} className="p-2.5 space-y-0.5">
                            <div className="flex justify-between font-bold">
                              <span className="font-mono">
                                {v.voucherNumber} ({v.partyName})
                              </span>
                              <span className="font-mono text-rose-700">
                                {v.amount.toFixed(2)} {currencySymbol}
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-600">
                              السبب: {v.reversalReason || '-'}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div>
                    <h4 className="font-bold text-slate-800 mb-2">
                      القيود المعكوسة ({reversedJournalEntries.length})
                    </h4>
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
                            <div className="text-[11px] text-rose-700">
                              السبب: {j.reversalReason || '-'}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          <DocumentSignatures
            paperSize={printSize}
            slots={[
              { roleLabel: 'المراقب المالي', name: actor?.fullName || 'مسؤول التدقيق' },
              { roleLabel: 'اعتماد الإدارة', name: 'المدير العام' },
            ]}
          />
          <DocumentFooter
            meta={docMeta}
            paperSize={printSize}
            referenceText="RPT-AUDIT-RECONCILIATION"
          />
        </div>
      )}

      {/* Independent Document Modals from Reports */}
      <ReceiptModal
        invoice={printableInvoice}
        defaultSize={
          printableInvoice &&
          (printableInvoice.type === 'PURCHASE' || printableInvoice.type === 'RETURN_PURCHASE')
            ? 'A4'
            : printSize
        }
        onClose={() => setPrintableInvoice(null)}
      />

      <AmanatReceiptModal
        record={printableAmanat}
        onClose={() => setPrintableAmanat(null)}
      />

      <CustomerNotificationModal
        isOpen={notificationState.isOpen}
        onClose={() => setNotificationState((prev) => ({ ...prev, isOpen: false }))}
        recipientName={notificationState.recipientName}
        recipientPhone={notificationState.recipientPhone}
        documentType={notificationState.documentType}
        documentNumber={notificationState.documentNumber}
        amount={notificationState.amount}
        date={notificationState.date}
        balanceRemaining={notificationState.balanceRemaining}
        activityName={notificationState.activityName}
        itemsSummary={notificationState.itemsSummary}
        notes={notificationState.notes}
        snapshot={notificationState.snapshot}
        notificationError={notificationState.error}
        isPartialReturn={notificationState.isPartialReturn}
        totalOriginalAmount={notificationState.totalOriginalAmount}
        cumulativeReturnedAmount={notificationState.cumulativeReturnedAmount}
      />
    </div>
  );
};
