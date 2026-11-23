/**
 * إدارة العملاء والموردين وكشوف الحسابات (Customers & Suppliers Management)
 * سجل الديون والمستحقات، الأرصدة المقدمة، تسجيل السداد الفوري FIFO، وكشف حساب تفصيلي
 */

import React, { useMemo, useState } from 'react';
import {
  Users,
  Plus,
  Search,
  FileText,
  DollarSign,
  Printer,
  X,
  Check,
  AlertCircle,
  ShieldAlert,
} from 'lucide-react';
import { storage } from '../../services/storageService';
import { dataService } from '../../services/dataService';
import { authService } from '../../services/authService';
import { hasPermission } from '../../config/rbac';
import { getActiveCurrencyConfig, roundMoney } from '../../config/currency';
import {
  useLiveParties,
  useLiveInvoices,
  useLiveVouchers,
  useLiveCashBoxes,
  useLivePaymentAllocations,
  useLivePartyAdvances,
} from '../../hooks/useLiveDexie';
import {
  Party,
  PartyType,
  PaymentVoucher,
  VoucherPaymentMethod,
} from '../../types/erp';
import {
  SPECIAL_ACCOUNTS,
  sortOpenInvoicesFIFO,
  computeFifoAllocations,
  resolveVoucherAccountingPlan,
  getInvoiceRemainingAmount,
} from '../../../electron/sqlite/payment-allocation-engine.mjs';
import { buildPartyStatement } from '../../utils/partyStatement';
import { formatLocalDate } from '../../utils/localDate';
import { useDocumentContext } from '../../hooks/useDocumentContext';
import { DocumentPrintShell } from '../documents/DocumentPrintShell';
import { PartyStatementDocument } from '../documents/PartyStatementDocument';
import { CustomerNotificationModal } from '../common/CustomerNotificationModal';
import {
  buildPartyStatementDocumentSnapshot,
  buildStructuredBaseName,
} from '../../services/documents/documentService';

interface PartiesManagerProps {
  onRefresh: () => void;
}

export const PartiesManager: React.FC<PartiesManagerProps> = ({ onRefresh }) => {
  const [activeTab, setActiveTab] = useState<PartyType>('CUSTOMER');
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [selectedPartyForStatement, setSelectedPartyForStatement] = useState<Party | null>(null);
  const [settlementParty, setSettlementParty] = useState<Party | null>(null);
  const [bannerMessage, setBannerMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // حقول نموذج إضافة طرف
  const [formName, setFormName] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formAddress, setFormAddress] = useState('');
  const [formTaxNumber, setFormTaxNumber] = useState('');
  const [formCreditLimit, setFormCreditLimit] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // حقول نموذج تسجيل السداد / التحصيل
  const [settleAmount, setSettleAmount] = useState('');
  const [settleDate, setSettleDate] = useState(() => formatLocalDate());
  const [settleCashBoxId, setSettleCashBoxId] = useState('');
  const [settlePaymentMethod, setSettlePaymentMethod] = useState<VoucherPaymentMethod>('CASH');
  const [settleExternalRef, setSettleExternalRef] = useState('');
  const [settleDescription, setSettleDescription] = useState('');
  const [isAdvanceRefund, setIsAdvanceRefund] = useState(false);
  const [useManualOverride, setUseManualOverride] = useState(false);
  const [manualAmounts, setManualAmounts] = useState<Record<string, string>>({});
  const [overrideReason, setOverrideReason] = useState('');
  const [settleError, setSettleError] = useState<string | null>(null);
  const [isStatementNotifyOpen, setIsStatementNotifyOpen] = useState(false);
  const { resolveMeta } = useDocumentContext();

  const isDesktop = typeof window !== 'undefined' && Boolean(window.amroDesktop);
  const actor =
    authService.getCurrentActorSync() || (isDesktop ? null : storage.getCurrentUser());
  const canOverrideAllocation = hasPermission(actor, 'payment:allocation:override');
  const canApproveSupplierAdvance = hasPermission(actor, 'supplier:advance:approve');

  const allParties = useLiveParties();
  const parties = allParties.filter((p) => p.type === activeTab);
  const customersCount = allParties.filter((p) => p.type === 'CUSTOMER').length;
  const suppliersCount = allParties.filter((p) => p.type === 'SUPPLIER').length;
  const allInvoices = useLiveInvoices();
  const allVouchers = useLiveVouchers();
  const cashBoxes = useLiveCashBoxes();
  const defaultCashBoxId =
    cashBoxes.find((b) => !b.isCentral && b.isDefault)?.id ||
    cashBoxes.find((b) => !b.isCentral)?.id ||
    cashBoxes[0]?.id ||
    '';
  const statementAllocations = useLivePaymentAllocations(selectedPartyForStatement?.id);
  const statementAdvances = useLivePartyAdvances(selectedPartyForStatement?.id);
  const currencySymbol = getActiveCurrencyConfig().symbol;

  const filteredParties = parties.filter((p) => {
    const q = searchQuery.toLowerCase();
    return (
      !searchQuery.trim() ||
      p.nameAr.toLowerCase().includes(q) ||
      (p.phone && p.phone.includes(q)) ||
      (p.address && p.address.toLowerCase().includes(q))
    );
  });

  const getPartyOpenInvoices = (party: Party) => {
    const targetType = party.type === 'CUSTOMER' ? 'SALE' : 'PURCHASE';
    return sortOpenInvoicesFIFO(
      allInvoices.filter((inv) => inv.partyId === party.id && inv.type === targetType)
    );
  };

  const settlementOpenInvoices = useMemo(() => {
    if (!settlementParty) return [];
    return getPartyOpenInvoices(settlementParty);
  }, [settlementParty, allInvoices]);

  const settlementPlanPreview = useMemo(() => {
    if (!settlementParty) return null;
    const amt = Number(settleAmount) || 0;
    if (amt <= 0) return null;

    const voucherType = isAdvanceRefund
      ? settlementParty.type === 'CUSTOMER'
        ? 'PAYMENT'
        : 'RECEIPT'
      : settlementParty.type === 'CUSTOMER'
      ? 'RECEIPT'
      : 'PAYMENT';

    try {
      const manualInput =
        !isAdvanceRefund && useManualOverride
          ? settlementOpenInvoices.map((inv) => ({
              invoiceId: inv.id,
              allocatedAmount: Number(manualAmounts[inv.id]) || 0,
            }))
          : undefined;

      const plan = resolveVoucherAccountingPlan({
        voucherType,
        voucherMode: settlementParty.type === 'CUSTOMER' ? 'CUSTOMER_RECEIPT' : 'SUPPLIER_PAYMENT',
        party: settlementParty,
        amount: amt,
        openInvoices: settlementOpenInvoices,
        manualAllocations: manualInput,
        hasOverridePermission: canOverrideAllocation,
        overrideReason: useManualOverride ? overrideReason : '',
        hasSupplierAdvancePermission: canApproveSupplierAdvance,
        targetAccountIsLeaf: true,
      });
      return { ok: true as const, plan };
    } catch (err: unknown) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : 'تعذر احتساب التخصيص.',
      };
    }
  }, [
    settlementParty,
    settleAmount,
    isAdvanceRefund,
    useManualOverride,
    manualAmounts,
    overrideReason,
    settlementOpenInvoices,
    canOverrideAllocation,
    canApproveSupplierAdvance,
  ]);

  const handleOpenSettlementModal = (party: Party) => {
    const open = getPartyOpenInvoices(party);
    const defaultDebt =
      party.type === 'CUSTOMER'
        ? Math.max(0, party.balance)
        : Math.max(0, -party.balance);
    const openTotal = open.reduce((s, inv) => s + getInvoiceRemainingAmount(inv), 0);
    const suggested = openTotal > 0 ? openTotal : defaultDebt;

    setSettlementParty(party);
    setSettleAmount(suggested > 0 ? String(roundMoney(suggested)) : '');
    setSettleDate(formatLocalDate());
    setSettleCashBoxId(defaultCashBoxId);
    setSettlePaymentMethod('CASH');
    setSettleExternalRef('');
    setSettleDescription(
      party.type === 'CUSTOMER'
        ? `تحصيل سداد من العميل ${party.nameAr}`
        : `سداد مستحقات للمورد ${party.nameAr}`
    );
    setIsAdvanceRefund(false);
    setUseManualOverride(false);
    setManualAmounts({});
    setOverrideReason('');
    setSettleError(null);
  };

  const handleToggleManualOverride = (checked: boolean) => {
    setUseManualOverride(checked);
    const amt = Number(settleAmount) || 0;
    if (checked && amt > 0 && settlementOpenInvoices.length > 0) {
      try {
        const fifo = computeFifoAllocations(settlementOpenInvoices, amt);
        const initMap: Record<string, string> = {};
        for (const a of fifo.allocations) {
          initMap[a.invoiceId] = String(a.allocatedAmount);
        }
        setManualAmounts(initMap);
      } catch {
        setManualAmounts({});
      }
    }
  };

  const handleSubmitSettlement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settlementParty || isSubmitting) return;
    setSettleError(null);

    const amt = Number(settleAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setSettleError('يرجى إدخال مبلغ صحيح أكبر من الصفر.');
      return;
    }

    if (!settleDescription.trim()) {
      setSettleError('البيان مطلوب.');
      return;
    }

    if (!isAdvanceRefund && useManualOverride && !overrideReason.trim()) {
      setSettleError('سبب التعديل اليدوي مطلوب لتوثيقه في سجل التدقيق.');
      return;
    }

    const voucherType = isAdvanceRefund
      ? settlementParty.type === 'CUSTOMER'
        ? 'PAYMENT'
        : 'RECEIPT'
      : settlementParty.type === 'CUSTOMER'
      ? 'RECEIPT'
      : 'PAYMENT';

    const voucherMode =
      settlementParty.type === 'CUSTOMER' ? 'CUSTOMER_RECEIPT' : 'SUPPLIER_PAYMENT';

    const manualPayload =
      !isAdvanceRefund && useManualOverride
        ? settlementOpenInvoices
            .map((inv) => ({
              invoiceId: inv.id,
              allocatedAmount: roundMoney(Number(manualAmounts[inv.id]) || 0),
            }))
            .filter((x) => x.allocatedAmount > 0)
        : undefined;

    setIsSubmitting(true);
    try {
      const activeBranch = await dataService.getActiveBranch();
      const voucher: PaymentVoucher = {
        id: storage.generateUUID(),
        voucherNumber: '',
        type: voucherType,
        voucherMode,
        date: settleDate,
        amount: roundMoney(amt),
        cashBoxId: settleCashBoxId || defaultCashBoxId,
        branchId: activeBranch.id,
        partyId: settlementParty.id,
        partyType: settlementParty.type,
        partyName: settlementParty.nameAr,
        accountCode: isAdvanceRefund
          ? settlementParty.type === 'CUSTOMER'
            ? SPECIAL_ACCOUNTS.CUSTOMER_ADVANCES
            : SPECIAL_ACCOUNTS.SUPPLIER_ADVANCES
          : settlementParty.type === 'CUSTOMER'
          ? SPECIAL_ACCOUNTS.CUSTOMERS_AR
          : SPECIAL_ACCOUNTS.SUPPLIERS_AP,
        paymentMethod: settlePaymentMethod,
        externalRef: settleExternalRef.trim() || undefined,
        description: settleDescription.trim(),
        costCenterId: 'general',
        status: 'POSTED',
      };

      const res = await dataService.createCashVoucherAtomic({
        voucher,
        manualAllocations: manualPayload,
        overrideReason: useManualOverride ? overrideReason.trim() : undefined,
      });

      setSettlementParty(null);
      setBannerMessage({
        type: 'success',
        text: `تم تسجيل السند (${res.voucher.voucherNumber}) للطرف (${settlementParty.nameAr}) وتحديث الفواتير والأرصدة بنجاح.`,
      });
      onRefresh();
    } catch (err: unknown) {
      setSettleError(err instanceof Error ? err.message : 'فشل تسجيل السند.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSaveParty = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setFormError(null);
    if (!formName.trim() || !formPhone.trim()) {
      setFormError('الاسم ورقم الهاتف مطلوبان.');
      return;
    }

    const newParty: Party = {
      id: storage.generateUUID(),
      type: activeTab,
      nameAr: formName.trim(),
      phone: formPhone.trim(),
      address: formAddress.trim() || undefined,
      taxNumber: formTaxNumber.trim() || undefined,
      balance: 0,
      advanceBalance: 0,
      creditLimit: Number(formCreditLimit) || undefined,
    };

    setIsSubmitting(true);
    try {
      await dataService.savePartyAtomic(newParty, false);
      setIsAddModalOpen(false);
      setFormName('');
      setFormPhone('');
      setFormAddress('');
      setFormTaxNumber('');
      setFormCreditLimit('');
      setFormError(null);
      onRefresh();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'تعذر حفظ البيانات.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // استخراج كشف الحساب الموحد للطرف المحدد
  const selectedPartyStatement = useMemo(() => {
    if (!selectedPartyForStatement) return null;
    return buildPartyStatement({
      party: selectedPartyForStatement,
      invoices: allInvoices,
      vouchers: allVouchers,
      paymentAllocations: statementAllocations,
      partyAdvances: statementAdvances,
    });
  }, [
    selectedPartyForStatement,
    allInvoices,
    allVouchers,
    statementAllocations,
    statementAdvances,
  ]);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {bannerMessage && (
        <div
          className={`p-3.5 rounded-xl border text-xs flex items-center justify-between gap-2 ${
            bannerMessage.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-rose-50 border-rose-200 text-rose-900'
          }`}
        >
          <span className="font-semibold">{bannerMessage.text}</span>
          <button onClick={() => setBannerMessage(null)}>
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Tabs and Toolbar */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('CUSTOMER')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'CUSTOMER'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            العملاء والمدينون ({customersCount})
          </button>
          <button
            onClick={() => setActiveTab('SUPPLIER')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'SUPPLIER'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            الموردون والدائنون ({suppliersCount})
          </button>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-72">
            <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={`بحث باسم أو هاتف ${activeTab === 'CUSTOMER' ? 'العميل' : 'المورد'}...`}
              className="w-full pl-3 pr-9 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none"
            />
          </div>

          <button
            onClick={() => setIsAddModalOpen(true)}
            className="flex items-center gap-1.5 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-bold transition-colors shrink-0"
          >
            <Plus className="w-4 h-4 text-emerald-400" />
            <span>إضافة {activeTab === 'CUSTOMER' ? 'عميل' : 'مورد'} جديد</span>
          </button>
        </div>
      </div>

      {/* Parties Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500 bg-slate-50">
                <th className="py-3 px-4">الاسم الكامل</th>
                <th className="py-3 px-4">رقم الهاتف</th>
                <th className="py-3 px-4">العنوان / المدينة</th>
                <th className="py-3 px-4 text-center">فواتير مفتوحة</th>
                <th className="py-3 px-4 text-center">الرصيد والأرصدة المقدمة</th>
                <th className="py-3 px-4 text-center">الإجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredParties.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-400">
                    <Users className="w-8 h-8 mx-auto mb-2 text-slate-300 stroke-1" />
                    <p className="font-semibold">
                      لا يوجد {activeTab === 'CUSTOMER' ? 'عملاء' : 'موردون'} مسجلون
                    </p>
                    <p className="text-[11px] text-slate-400 mt-1">
                      اضغط على زر الإضافة لتسجيل البيانات
                    </p>
                  </td>
                </tr>
              ) : (
                filteredParties.map((party) => {
                  const openCount = getPartyOpenInvoices(party).length;
                  const advBal = Number(party.advanceBalance || 0);
                  return (
                    <tr key={party.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-3 px-4">
                        <div className="font-bold text-slate-900">{party.nameAr}</div>
                        <div className="text-[10px] font-mono text-slate-400">ID: {party.id.slice(0, 8)}</div>
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-600">{party.phone}</td>
                      <td className="py-3 px-4 text-slate-600">{party.address || '-'}</td>
                      <td className="py-3 px-4 text-center">
                        <span
                          className={`inline-block px-2 py-0.5 rounded font-mono font-bold text-[11px] ${
                            openCount > 0
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          {openCount} فاتورة
                        </span>
                      </td>
                      <td className="py-3 px-4 text-center space-y-1">
                        <div>
                          <span
                            className={`inline-block px-2.5 py-0.5 rounded-full font-mono font-bold tabular-nums text-xs ${
                              party.balance > 0
                                ? 'bg-emerald-100 text-emerald-800'
                                : party.balance < 0
                                ? 'bg-rose-100 text-rose-800'
                                : 'bg-slate-100 text-slate-700'
                            }`}
                          >
                            {party.balance.toFixed(2)} {currencySymbol}
                          </span>
                        </div>
                        {advBal > 0 && (
                          <div>
                            <span className="inline-block px-2 py-0.5 rounded-full font-mono font-bold text-[10px] bg-indigo-100 text-indigo-800">
                              رصيد مقدم: {advBal.toFixed(2)} {currencySymbol}
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            onClick={() => handleOpenSettlementModal(party)}
                            className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold text-[11px] flex items-center gap-1 transition-colors"
                          >
                            <DollarSign className="w-3 h-3" />
                            <span>{party.type === 'CUSTOMER' ? 'تسجيل سداد' : 'سداد لمورد'}</span>
                          </button>
                          <button
                            onClick={() => setSelectedPartyForStatement(party)}
                            className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded font-semibold text-[11px] flex items-center gap-1 transition-colors"
                          >
                            <FileText className="w-3 h-3 text-slate-600" />
                            <span>كشف حساب</span>
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
      </div>

      {/* Settlement Modal (تسجيل سداد عميل / مورد) */}
      {settlementParty && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto">
          <div className="relative w-full max-w-2xl bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200 my-6">
            <div className="flex items-center justify-between px-6 py-4 bg-slate-900 text-white">
              <div>
                <h3 className="text-sm font-bold flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-emerald-400" />
                  <span>
                    {settlementParty.type === 'CUSTOMER'
                      ? `تسجيل سداد / تحصيل من العميل: ${settlementParty.nameAr}`
                      : `تسجيل سداد مستحقات للمورد: ${settlementParty.nameAr}`}
                  </span>
                </h3>
                <p className="text-[10px] text-slate-400 font-mono">ID: {settlementParty.id}</p>
              </div>
              <button
                onClick={() => setSettlementParty(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form
              onSubmit={handleSubmitSettlement}
              className="p-6 space-y-4 text-xs max-h-[82vh] overflow-y-auto"
            >
              {settleError && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{settleError}</span>
                </div>
              )}

              {/* Summary Strip */}
              <div className="grid grid-cols-3 gap-3 bg-slate-50 p-3 rounded-lg border border-slate-200">
                <div>
                  <div className="text-[10px] text-slate-500">رصيد الذمة الحالي</div>
                  <div className="font-mono font-bold text-sm text-slate-900">
                    {settlementParty.balance.toFixed(2)} {currencySymbol}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-500">الرصيد المقدم المتاح</div>
                  <div className="font-mono font-bold text-sm text-indigo-700">
                    {Number(settlementParty.advanceBalance || 0).toFixed(2)} {currencySymbol}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-500">الفواتير المفتوحة</div>
                  <div className="font-mono font-bold text-sm text-amber-800">
                    {settlementOpenInvoices.length}
                  </div>
                </div>
              </div>

              {Number(settlementParty.advanceBalance || 0) > 0 && (
                <label className="flex items-center gap-2 p-2.5 bg-indigo-50 border border-indigo-200 rounded-lg text-indigo-900 font-bold cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isAdvanceRefund}
                    onChange={(e) => {
                      setIsAdvanceRefund(e.target.checked);
                      if (e.target.checked) {
                        setUseManualOverride(false);
                        setSettleAmount(String(Number(settlementParty.advanceBalance || 0)));
                        setSettleDescription(
                          settlementParty.type === 'CUSTOMER'
                            ? `رد رصيد مقدم للعميل ${settlementParty.nameAr}`
                            : `استرداد سلفة من المورد ${settlementParty.nameAr}`
                        );
                      }
                    }}
                  />
                  <span>
                    {settlementParty.type === 'CUSTOMER'
                      ? 'رد رصيد مقدم نقدي للعميل (من حساب 2103)'
                      : 'قبض استرداد سلفة نقدية من المورد (من حساب 1105)'}
                  </span>
                </label>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    المبلغ ({currencySymbol}) *
                  </label>
                  <input
                    type="number"
                    step="any"
                    min="0.01"
                    required
                    value={settleAmount}
                    onChange={(e) => setSettleAmount(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded font-mono font-bold text-sm"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">التاريخ *</label>
                  <input
                    type="date"
                    required
                    value={settleDate}
                    onChange={(e) => setSettleDate(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">طريقة الدفع *</label>
                  <select
                    value={settlePaymentMethod}
                    onChange={(e) => setSettlePaymentMethod(e.target.value as VoucherPaymentMethod)}
                    className="w-full px-3 py-2 border border-slate-200 rounded"
                  >
                    <option value="CASH">نقدي</option>
                    <option value="BANK_TRANSFER">تحويل بنكي</option>
                    <option value="CHECK">شيك</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">المرجع الخارجي</label>
                  <input
                    type="text"
                    value={settleExternalRef}
                    onChange={(e) => setSettleExternalRef(e.target.value)}
                    placeholder="رقم مرجع..."
                    className="w-full px-3 py-2 border border-slate-200 rounded font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">الصندوق / الحساب البنكي *</label>
                <select
                  value={settleCashBoxId}
                  onChange={(e) => setSettleCashBoxId(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded"
                >
                  {cashBoxes.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.nameAr} ({b.balance.toFixed(2)} {currencySymbol})
                    </option>
                  ))}
                </select>
              </div>

              {/* Open Invoices & FIFO Allocation Table */}
              {!isAdvanceRefund && (
                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <div className="bg-slate-100 px-3 py-2 flex items-center justify-between">
                    <span className="font-bold text-slate-800">
                      الفواتير المفتوحة وتوزيع الدفعة (FIFO — الأقدم أولاً)
                    </span>
                    {canOverrideAllocation && settlementOpenInvoices.length > 0 && (
                      <label className="flex items-center gap-1.5 text-[11px] font-bold text-purple-900 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={useManualOverride}
                          onChange={(e) => handleToggleManualOverride(e.target.checked)}
                        />
                        <span>تعديل التخصيص يدوياً</span>
                      </label>
                    )}
                  </div>
                  {settlementOpenInvoices.length === 0 ? (
                    <div className="p-3 text-center text-slate-500">
                      لا توجد فواتير مفتوحة لهذا الطرف.
                    </div>
                  ) : (
                    <div className="max-h-44 overflow-y-auto">
                      <table className="w-full text-right text-[11px]">
                        <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                          <tr>
                            <th className="py-1.5 px-2.5">الفاتورة</th>
                            <th className="py-1.5 px-2.5">التاريخ / الاستحقاق</th>
                            <th className="py-1.5 px-2.5 text-center">الأصل / المسدد</th>
                            <th className="py-1.5 px-2.5 text-center">المتبقي</th>
                            <th className="py-1.5 px-2.5 text-center">التخصيص</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {settlementOpenInvoices.map((inv) => {
                            const rem = getInvoiceRemainingAmount(inv);
                            const previewAlloc =
                              settlementPlanPreview?.ok
                                ? settlementPlanPreview.plan.allocations.find(
                                    (a) => a.invoiceId === inv.id
                                  )?.allocatedAmount || 0
                                : 0;
                            return (
                              <tr key={inv.id}>
                                <td className="py-1.5 px-2.5 font-mono font-bold">
                                  {inv.invoiceNumber}
                                </td>
                                <td className="py-1.5 px-2.5 font-mono text-slate-600">
                                  {inv.date}
                                  {inv.dueDate ? ` (استحقاق: ${inv.dueDate})` : ''}
                                </td>
                                <td className="py-1.5 px-2.5 text-center font-mono text-slate-500">
                                  {inv.total.toFixed(2)} / {inv.paidAmount.toFixed(2)}
                                </td>
                                <td className="py-1.5 px-2.5 text-center font-mono font-bold">
                                  {rem.toFixed(2)}
                                </td>
                                <td className="py-1.5 px-2.5 text-center">
                                  {useManualOverride ? (
                                    <input
                                      type="number"
                                      min="0"
                                      max={rem}
                                      step="any"
                                      value={manualAmounts[inv.id] ?? ''}
                                      onChange={(e) =>
                                        setManualAmounts((prev) => ({
                                          ...prev,
                                          [inv.id]: e.target.value,
                                        }))
                                      }
                                      className="w-20 px-1.5 py-0.5 border border-purple-300 rounded font-mono text-center"
                                    />
                                  ) : (
                                    <span className="font-mono font-bold text-emerald-700">
                                      {previewAlloc.toFixed(2)}
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {useManualOverride && (
                    <div className="p-2.5 bg-purple-50 border-t border-purple-200 space-y-1">
                      <label className="block font-bold text-purple-900 text-[11px]">
                        سبب التعديل اليدوي (إلزامي لسجل التدقيق) *
                      </label>
                      <input
                        type="text"
                        value={overrideReason}
                        onChange={(e) => setOverrideReason(e.target.value)}
                        placeholder="سبب التعديل اليدوي..."
                        className="w-full px-2.5 py-1.5 border border-purple-300 rounded bg-white"
                      />
                    </div>
                  )}

                  {settlementPlanPreview && !settlementPlanPreview.ok && (
                    <div className="p-2.5 bg-rose-50 border-t border-rose-200 text-rose-800 flex items-center gap-1.5 text-[11px]">
                      <ShieldAlert className="w-4 h-4 shrink-0" />
                      <span>{settlementPlanPreview.error}</span>
                    </div>
                  )}

                  {settlementPlanPreview?.ok && settlementPlanPreview.plan.advanceAmount > 0 && (
                    <div className="p-2.5 bg-indigo-50 border-t border-indigo-200 text-indigo-900 text-[11px] font-semibold">
                      {settlementParty.type === 'CUSTOMER'
                        ? `المبلغ الزائد (${settlementPlanPreview.plan.advanceAmount.toFixed(2)} ${currencySymbol}) سيُسجل رصيداً مقدماً للعميل في حساب (2103).`
                        : `المبلغ الزائد (${settlementPlanPreview.plan.advanceAmount.toFixed(2)} ${currencySymbol}) سيُسجل في حساب سلف الموردين (1105).`}
                    </div>
                  )}
                </div>
              )}

              <div>
                <label className="block font-semibold text-slate-700 mb-1">البيان *</label>
                <input
                  type="text"
                  required
                  value={settleDescription}
                  onChange={(e) => setSettleDescription(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setSettlementParty(null)}
                  className="px-4 py-2 border border-slate-200 rounded-lg hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || Boolean(settlementPlanPreview && !settlementPlanPreview.ok)}
                  className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-bold rounded-lg flex items-center gap-1.5"
                >
                  <Check className="w-4 h-4" />
                  <span>{isSubmitting ? 'جارٍ التسجيل...' : 'اعتماد وترحيل السند'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="relative w-full max-w-md bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
            <div className="flex items-center justify-between px-5 py-4 bg-slate-900 text-white">
              <h3 className="text-xs font-bold">
                تسجيل {activeTab === 'CUSTOMER' ? 'عميل' : 'مورد'} جديد
              </h3>
              <button onClick={() => setIsAddModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveParty} className="p-5 space-y-3 text-xs">
              {formError && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  الاسم التجاري أو الشخصي *
                </label>
                <input
                  type="text"
                  required
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="مثال: شركة النور للتوزيع / أحمد محمد..."
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">رقم الهاتف *</label>
                <input
                  type="tel"
                  required
                  value={formPhone}
                  onChange={(e) => setFormPhone(e.target.value)}
                  placeholder="05XXXXXXXX"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 font-mono focus:outline-none"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">العنوان / المدينة</label>
                <input
                  type="text"
                  value={formAddress}
                  onChange={(e) => setFormAddress(e.target.value)}
                  placeholder="مثال: الرياض - شارع الملك فهد..."
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">الرقم الضريبي</label>
                  <input
                    type="text"
                    value={formTaxNumber}
                    onChange={(e) => setFormTaxNumber(e.target.value)}
                    placeholder="اختياري..."
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 font-mono focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    سقف الائتمان (الحد الأقصى للديون)
                  </label>
                  <input
                    type="number"
                    value={formCreditLimit}
                    onChange={(e) => setFormCreditLimit(e.target.value)}
                    placeholder="0.00"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 font-mono focus:outline-none"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-3 py-1.5 border border-slate-200 rounded-lg hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-bold rounded-lg"
                >
                  {isSubmitting ? 'جارٍ الحفظ...' : 'حفظ وتسجيل'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Statement of Account Modal (Unified DocumentPrintShell + PartyStatementDocument) */}
      {selectedPartyForStatement && selectedPartyStatement && (
        <DocumentPrintShell
          title={`كشف حساب: ${selectedPartyForStatement.nameAr}`}
          subtitle={selectedPartyForStatement.type === 'CUSTOMER' ? 'حساب عميل' : 'حساب مورد'}
          pdfTitle={buildStructuredBaseName({
            kind: 'STATEMENT',
            documentNumber: selectedPartyForStatement.nameAr || selectedPartyForStatement.id.slice(0, 8),
          })}
          defaultSize="A4"
          allowThermal={true}
          buildSnapshot={(paperSize) =>
            buildPartyStatementDocumentSnapshot({
              statement: selectedPartyStatement,
              meta: resolveMeta(),
              paperSize,
            })
          }
          onClose={() => setSelectedPartyForStatement(null)}
          onNotify={() => setIsStatementNotifyOpen(true)}
          notifyLabel="مشاركة وإشعار واتساب"
        >
          {(paperSize) => (
            <PartyStatementDocument
              statement={selectedPartyStatement}
              meta={resolveMeta()}
              paperSize={paperSize}
            />
          )}
        </DocumentPrintShell>
      )}

      {selectedPartyForStatement && (
        <CustomerNotificationModal
          isOpen={isStatementNotifyOpen}
          onClose={() => setIsStatementNotifyOpen(false)}
          recipientName={selectedPartyForStatement.nameAr}
          recipientPhone={selectedPartyForStatement.phone || ''}
          documentType="STATEMENT"
          documentNumber={`STMT-${selectedPartyForStatement.id.slice(0, 8).toUpperCase()}`}
          amount={Math.abs(selectedPartyForStatement.balance)}
          balanceRemaining={selectedPartyForStatement.balance}
          notes={`كشف حساب مالي صادر من ${resolveMeta().branchName}`}
          snapshot={
            selectedPartyStatement
              ? buildPartyStatementDocumentSnapshot({
                  statement: selectedPartyStatement,
                  meta: resolveMeta(),
                  paperSize: 'A4',
                })
              : undefined
          }
        />
      )}
    </div>
  );
};

