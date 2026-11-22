/**
 * إدارة الصناديق النقدية، البنوك، وسندات القبض والصرف (Cash & Vouchers Management)
 * ترحيل لحظي لقيود اليومية وتخصيص الفواتير (FIFO / يدوي) والأرصدة المقدمة
 */

import React, { useMemo, useState } from 'react';
import {
  Wallet,
  Plus,
  ArrowDownLeft,
  ArrowUpRight,
  FileText,
  Printer,
  X,
  Check,
  Share2,
  AlertCircle,
  RotateCcw,
  Ban,
  Send,
  ShieldAlert,
} from 'lucide-react';
import { storage } from '../../services/storageService';
import { dataService } from '../../services/dataService';
import { authService } from '../../services/authService';
import { hasPermission } from '../../config/rbac';
import { getActiveCurrencyConfig, roundMoney } from '../../config/currency';
import {
  useLiveCashBoxes,
  useLiveVouchers,
  useLiveAccounts,
  useLiveParties,
  useLiveInvoices,
  useLivePaymentAllocations,
  useLiveBranches,
} from '../../hooks/useLiveDexie';
import {
  CashBox,
  PaymentVoucher,
  VoucherType,
  VoucherAllocationMode,
  VoucherPaymentMethod,
  CostCenterId,
} from '../../types/erp';
import { CustomerNotificationModal } from '../common/CustomerNotificationModal';
import {
  PARTY_CONTROL_ACCOUNTS,
  SPECIAL_ACCOUNTS,
  sortOpenInvoicesFIFO,
  computeFifoAllocations,
  resolveVoucherAccountingPlan,
  numberToArabicWords,
  getInvoiceRemainingAmount,
  toCents,
  fromCents,
} from '../../../electron/sqlite/payment-allocation-engine.mjs';

interface CashManagerProps {
  onRefresh: () => void;
}

const VOUCHER_PAYMENT_METHOD_LABELS: Record<VoucherPaymentMethod, string> = {
  CASH: 'نقدي',
  BANK_TRANSFER: 'تحويل بنكي',
  CHECK: 'شيك',
};

const VOUCHER_MODE_LABELS: Record<VoucherAllocationMode, string> = {
  CUSTOMER_RECEIPT: 'تحصيل من عميل',
  SUPPLIER_PAYMENT: 'سداد لمورد',
  GENERAL: 'قبض / صرف عام',
};

export const CashManager: React.FC<CashManagerProps> = ({ onRefresh }) => {
  const currencyConfig = getActiveCurrencyConfig();
  const currencySymbol = currencyConfig.symbol;
  const isDesktop = typeof window !== 'undefined' && Boolean(window.amroDesktop);
  const actor =
    authService.getCurrentActorSync() || (isDesktop ? null : storage.getCurrentUser());

  const canOverrideAllocation = hasPermission(actor, 'payment:allocation:override');
  const canApproveSupplierAdvance = hasPermission(actor, 'supplier:advance:approve');
  const canReverseVoucher = hasPermission(actor, 'voucher:reverse');
  const canCancelVoucher = hasPermission(actor, 'voucher:cancel');

  const [activeTab, setActiveTab] = useState<'boxes' | 'receipts' | 'payments'>('boxes');
  const [isVoucherModalOpen, setIsVoucherModalOpen] = useState(false);
  const [voucherType, setVoucherType] = useState<VoucherType>('RECEIPT');
  const [voucherMode, setVoucherMode] = useState<VoucherAllocationMode>('CUSTOMER_RECEIPT');
  const [voucherError, setVoucherError] = useState<string | null>(null);
  const [actionBanner, setActionBanner] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
  const [boxError, setBoxError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [printableVoucher, setPrintableVoucher] = useState<PaymentVoucher | null>(null);

  // حقول نموذج السند
  const [voucherAmount, setVoucherAmount] = useState('');
  const [voucherDate, setVoucherDate] = useState(new Date().toISOString().split('T')[0]);
  const [voucherCashBoxId, setVoucherCashBoxId] = useState('');
  const [voucherAccountCode, setVoucherAccountCode] = useState('5204');
  const [voucherPartyId, setVoucherPartyId] = useState('');
  const [voucherPartyName, setVoucherPartyName] = useState('');
  const [voucherDescription, setVoucherDescription] = useState('');
  const [voucherCostCenter, setVoucherCostCenter] = useState<CostCenterId>('general');
  const [voucherPaymentMethod, setVoucherPaymentMethod] = useState<VoucherPaymentMethod>('CASH');
  const [voucherExternalRef, setVoucherExternalRef] = useState('');
  const [useManualOverride, setUseManualOverride] = useState(false);
  const [manualAmounts, setManualAmounts] = useState<Record<string, string>>({});
  const [overrideReason, setOverrideReason] = useState('');

  // نوافذ الإلغاء والعكس الداخلية
  const [cancelModalVoucher, setCancelModalVoucher] = useState<PaymentVoucher | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelError, setCancelError] = useState<string | null>(null);

  const [reverseModalVoucher, setReverseModalVoucher] = useState<PaymentVoucher | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [reverseError, setReverseError] = useState<string | null>(null);

  // نافذة إشعار العميل / المستفيد
  const [notificationData, setNotificationData] = useState<{
    isOpen: boolean;
    recipientName: string;
    recipientPhone?: string;
    documentType: 'RECEIPT_VOUCHER' | 'PAYMENT_VOUCHER';
    documentNumber: string;
    amount?: number;
    notes?: string;
  }>({
    isOpen: false,
    recipientName: '',
    documentType: 'RECEIPT_VOUCHER',
    documentNumber: '',
  });

  // نموذج إضافة صندوق / بنك
  const [isAddBoxModalOpen, setIsAddBoxModalOpen] = useState(false);
  const [boxCode, setBoxCode] = useState('');
  const [boxName, setBoxName] = useState('');

  const cashBoxes = useLiveCashBoxes();
  const defaultCashBoxId =
    cashBoxes.find((b) => !b.isCentral && b.isDefault)?.id ||
    cashBoxes.find((b) => !b.isCentral)?.id ||
    cashBoxes[0]?.id ||
    '';
  const vouchers = useLiveVouchers();
  const accounts = useLiveAccounts();
  const customers = useLiveParties('CUSTOMER');
  const suppliers = useLiveParties('SUPPLIER');
  const invoices = useLiveInvoices();
  const branches = useLiveBranches();
  const printableAllocations = useLivePaymentAllocations(
    undefined,
    printableVoucher?.id
  );

  const filteredVouchers = vouchers.filter((v) => {
    if (activeTab === 'receipts') return v.type === 'RECEIPT';
    if (activeTab === 'payments') return v.type === 'PAYMENT';
    return true;
  });

  const generalLeafAccounts = useMemo(
    () =>
      accounts.filter(
        (a) => a.isLeaf !== false && !PARTY_CONTROL_ACCOUNTS.has(a.code)
      ),
    [accounts]
  );

  const selectedParty = useMemo(() => {
    if (voucherMode === 'CUSTOMER_RECEIPT') {
      return customers.find((c) => c.id === voucherPartyId);
    }
    if (voucherMode === 'SUPPLIER_PAYMENT') {
      return suppliers.find((s) => s.id === voucherPartyId);
    }
    return undefined;
  }, [voucherMode, voucherPartyId, customers, suppliers]);

  const partyOpenInvoices = useMemo(() => {
    if (!selectedParty) return [];
    const targetType = voucherMode === 'CUSTOMER_RECEIPT' ? 'SALE' : 'PURCHASE';
    return sortOpenInvoicesFIFO(
      invoices.filter((inv) => inv.partyId === selectedParty.id && inv.type === targetType)
    );
  }, [selectedParty, voucherMode, invoices]);

  const amountNum = Number(voucherAmount) || 0;

  const livePlanPreview = useMemo(() => {
    if (voucherMode === 'GENERAL' || !selectedParty || amountNum <= 0) {
      return null;
    }
    try {
      const manualInput = useManualOverride
        ? partyOpenInvoices.map((inv) => ({
            invoiceId: inv.id,
            allocatedAmount: Number(manualAmounts[inv.id]) || 0,
          }))
        : undefined;
      const plan = resolveVoucherAccountingPlan({
        voucherType,
        voucherMode,
        party: selectedParty,
        amount: amountNum,
        openInvoices: partyOpenInvoices,
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
        error: err instanceof Error ? err.message : 'تعذر احتساب التوزيع.',
      };
    }
  }, [
    voucherMode,
    voucherType,
    selectedParty,
    amountNum,
    partyOpenInvoices,
    useManualOverride,
    manualAmounts,
    overrideReason,
    canOverrideAllocation,
    canApproveSupplierAdvance,
  ]);

  const handleModeChange = (mode: VoucherAllocationMode) => {
    setVoucherMode(mode);
    setVoucherError(null);
    setVoucherPartyId('');
    setVoucherPartyName('');
    setUseManualOverride(false);
    setManualAmounts({});
    setOverrideReason('');

    if (mode === 'CUSTOMER_RECEIPT') {
      setVoucherType('RECEIPT');
      setVoucherAccountCode(SPECIAL_ACCOUNTS.CUSTOMERS_AR);
    } else if (mode === 'SUPPLIER_PAYMENT') {
      setVoucherType('PAYMENT');
      setVoucherAccountCode(SPECIAL_ACCOUNTS.SUPPLIERS_AP);
    } else {
      const fallback =
        voucherType === 'RECEIPT'
          ? generalLeafAccounts.find((a) => a.type === 'REVENUE')?.code ||
            generalLeafAccounts[0]?.code ||
            ''
          : generalLeafAccounts.find((a) => a.code === '5204')?.code ||
            generalLeafAccounts.find((a) => a.type === 'EXPENSE')?.code ||
            generalLeafAccounts[0]?.code ||
            '';
      setVoucherAccountCode(fallback);
    }
  };

  const handleOpenVoucherModal = (type: VoucherType, presetCashBoxId?: string) => {
    setVoucherType(type);
    setVoucherAmount('');
    setVoucherDescription('');
    setVoucherPartyId('');
    setVoucherPartyName('');
    setVoucherCostCenter('general');
    setVoucherPaymentMethod('CASH');
    setVoucherExternalRef('');
    setUseManualOverride(false);
    setManualAmounts({});
    setOverrideReason('');
    setVoucherError(null);

    if (type === 'RECEIPT') {
      setVoucherMode('CUSTOMER_RECEIPT');
      setVoucherAccountCode(SPECIAL_ACCOUNTS.CUSTOMERS_AR);
    } else {
      setVoucherMode('SUPPLIER_PAYMENT');
      setVoucherAccountCode(SPECIAL_ACCOUNTS.SUPPLIERS_AP);
    }
    setVoucherCashBoxId(presetCashBoxId || voucherCashBoxId || defaultCashBoxId);
    setIsVoucherModalOpen(true);
  };

  const handleToggleManualOverride = (checked: boolean) => {
    setUseManualOverride(checked);
    if (checked && amountNum > 0 && partyOpenInvoices.length > 0) {
      try {
        const fifo = computeFifoAllocations(partyOpenInvoices, amountNum);
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

  const handleNotifyVoucher = (v: PaymentVoucher) => {
    const isReceipt = v.type === 'RECEIPT';
    const foundParty = [...customers, ...suppliers].find(
      (p) => p.id === v.partyId || p.nameAr === v.partyName
    );
    const box = cashBoxes.find((b) => b.id === v.cashBoxId);

    setNotificationData({
      isOpen: true,
      recipientName: v.partyName,
      recipientPhone: foundParty?.phone || '',
      documentType: isReceipt ? 'RECEIPT_VOUCHER' : 'PAYMENT_VOUCHER',
      documentNumber: v.voucherNumber,
      amount: v.amount,
      notes: `${v.description} - حساب: ${box?.nameAr || 'الخزينة'}`,
    });
  };

  const handlePrintVoucher = (v: PaymentVoucher) => {
    setPrintableVoucher(v);
  };

  const submitVoucher = async (targetStatus: 'DRAFT' | 'POSTED') => {
    if (isSubmitting) return;
    setVoucherError(null);

    const amt = Number(voucherAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setVoucherError('يرجى إدخال مبلغ مالي صحيح أكبر من الصفر.');
      return;
    }

    if (voucherMode !== 'GENERAL' && !voucherPartyId) {
      setVoucherError(
        voucherMode === 'CUSTOMER_RECEIPT'
          ? 'يجب اختيار عميل مسجل من القائمة لإتمام سند التحصيل.'
          : 'يجب اختيار مورد مسجل من القائمة لإتمام سند السداد.'
      );
      return;
    }

    if (voucherMode === 'GENERAL' && !voucherAccountCode) {
      setVoucherError('يرجى اختيار الحساب المقابل في الدليل المحاسبي.');
      return;
    }

    if (!voucherDescription.trim()) {
      setVoucherError('يرجى إدخال وصف السند وسبب الحركة.');
      return;
    }

    const manualPayload =
      voucherMode !== 'GENERAL' && useManualOverride
        ? partyOpenInvoices
            .map((inv) => ({
              invoiceId: inv.id,
              allocatedAmount: roundMoney(Number(manualAmounts[inv.id]) || 0),
            }))
            .filter((x) => x.allocatedAmount > 0)
        : undefined;

    if (voucherMode !== 'GENERAL' && useManualOverride && targetStatus === 'POSTED') {
      if (!overrideReason.trim()) {
        setVoucherError('يجب كتابة سبب التعديل اليدوي لتوثيقه في سجل التدقيق.');
        return;
      }
    }

    const activeBranch = await dataService.getActiveBranch();
    const resolvedAccount =
      voucherMode === 'CUSTOMER_RECEIPT'
        ? SPECIAL_ACCOUNTS.CUSTOMERS_AR
        : voucherMode === 'SUPPLIER_PAYMENT'
        ? SPECIAL_ACCOUNTS.SUPPLIERS_AP
        : voucherAccountCode;

    const newVoucher: PaymentVoucher = {
      id: storage.generateUUID(),
      voucherNumber: '',
      type: voucherType,
      voucherMode,
      date: voucherDate,
      amount: roundMoney(amt),
      cashBoxId: voucherCashBoxId || defaultCashBoxId,
      branchId: activeBranch.id,
      partyId: voucherMode === 'GENERAL' ? undefined : voucherPartyId,
      partyType: selectedParty?.type,
      partyName:
        voucherMode === 'GENERAL'
          ? voucherPartyName.trim() || (voucherType === 'RECEIPT' ? 'إيداع / قبض عام' : 'مستفيد / مصروف عام')
          : selectedParty?.nameAr || '',
      accountCode: resolvedAccount,
      paymentMethod: voucherPaymentMethod,
      externalRef: voucherExternalRef.trim() || undefined,
      description: voucherDescription.trim(),
      costCenterId: voucherCostCenter,
      status: targetStatus,
    };

    setIsSubmitting(true);
    try {
      const result = await dataService.createCashVoucherAtomic({
        voucher: newVoucher,
        manualAllocations: manualPayload,
        overrideReason: useManualOverride ? overrideReason.trim() : undefined,
      });
      setIsVoucherModalOpen(false);
      setActionBanner({
        type: 'success',
        text:
          targetStatus === 'DRAFT'
            ? `تم حفظ مسودة السند (${result.voucher.voucherNumber}) دون ترحيل مالي بعد.`
            : `تم ترحيل السند (${result.voucher.voucherNumber}) وتحديث الأرصدة والقيود بنجاح.`,
      });
      onRefresh();
      if (targetStatus === 'POSTED') {
        handleNotifyVoucher(result.voucher);
      }
    } catch (err: unknown) {
      setVoucherError(err instanceof Error ? err.message : 'فشل معالجة السند المالي.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSaveVoucher = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitVoucher('POSTED');
  };

  const handlePostDraftVoucher = async (v: PaymentVoucher) => {
    if (isSubmitting) return;
    setActionBanner(null);
    setIsSubmitting(true);
    try {
      const res = await dataService.postDraftCashVoucherAtomic({ voucherId: v.id });
      setActionBanner({
        type: 'success',
        text: `تم ترحيل المسودة (${res.voucher.voucherNumber}) وإصدار القيد المحاسبي وتحديث الذمم بنجاح.`,
      });
      onRefresh();
    } catch (err: unknown) {
      setActionBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'تعذر ترحيل المسودة.',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmCancelDraft = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cancelModalVoucher || isSubmitting) return;
    setCancelError(null);
    if (!cancelReason.trim()) {
      setCancelError('سبب إلغاء المسودة مطلوب.');
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await dataService.cancelCashVoucherAtomic({
        voucherId: cancelModalVoucher.id,
        reason: cancelReason.trim(),
      });
      setCancelModalVoucher(null);
      setCancelReason('');
      setActionBanner({
        type: 'success',
        text: `تم إلغاء المسودة (${res.voucherNumber}) وتوثيق السبب.`,
      });
      onRefresh();
    } catch (err: unknown) {
      setCancelError(err instanceof Error ? err.message : 'تعذر إلغاء المسودة.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmReverseVoucher = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reverseModalVoucher || isSubmitting) return;
    setReverseError(null);
    if (!reverseReason.trim()) {
      setReverseError('سبب عكس السند المرحل مطلوب لتوثيقه في سجل التدقيق.');
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await dataService.reverseCashVoucherAtomic({
        voucherId: reverseModalVoucher.id,
        reversalReason: reverseReason.trim(),
      });
      setReverseModalVoucher(null);
      setReverseReason('');
      setActionBanner({
        type: 'success',
        text: `تم عكس السند (${res.voucher.voucherNumber}) بالقيد العكسي (${res.reversalJournalEntry.entryNumber}) واستعادة الأرصدة بنجاح.`,
      });
      onRefresh();
    } catch (err: unknown) {
      setReverseError(err instanceof Error ? err.message : 'تعذر عكس السند المالي.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSaveNewCashBox = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setBoxError(null);

    if (!boxName.trim() || !boxCode.trim()) {
      setBoxError('يرجى إدخال اسم الصندوق والكود التعريفي.');
      return;
    }

    const activeBranch = await dataService.getActiveBranch();
    const newBox: CashBox = {
      id: storage.generateUUID(),
      code: boxCode.trim(),
      nameAr: boxName.trim(),
      accountCode: '1101',
      branchId: activeBranch.id,
      balance: 0,
      isDefault: false,
    };

    setIsSubmitting(true);
    try {
      await dataService.createCashBoxAtomic(newBox);
      setIsAddBoxModalOpen(false);
      setBoxCode('');
      setBoxName('');
      onRefresh();
    } catch (err: unknown) {
      setBoxError(err instanceof Error ? err.message : 'تعذر إضافة الصندوق النقدي.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderStatusBadge = (status?: PaymentVoucher['status']) => {
    const s = status || 'POSTED';
    if (s === 'DRAFT') {
      return (
        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">
          مسودة
        </span>
      );
    }
    if (s === 'CANCELLED') {
      return (
        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-200 text-slate-700">
          ملغى
        </span>
      );
    }
    if (s === 'REVERSED') {
      return (
        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-800 border border-rose-200">
          معكوس
        </span>
      );
    }
    return (
      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">
        مرحّل
      </span>
    );
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Banner feedback */}
      {actionBanner && (
        <div
          className={`p-3.5 rounded-xl border text-xs flex items-center justify-between gap-2 ${
            actionBanner.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-rose-50 border-rose-200 text-rose-900'
          }`}
        >
          <div className="flex items-center gap-2 font-semibold">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{actionBanner.text}</span>
          </div>
          <button onClick={() => setActionBanner(null)} className="opacity-60 hover:opacity-100">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Navigation tabs & action buttons */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setActiveTab('boxes')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'boxes'
                ? 'bg-slate-900 text-white shadow-sm'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            الخزائن والحسابات البنكية ({cashBoxes.length})
          </button>
          <button
            onClick={() => setActiveTab('receipts')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'receipts'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            سندات القبض ({vouchers.filter((v) => v.type === 'RECEIPT').length})
          </button>
          <button
            onClick={() => setActiveTab('payments')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'payments'
                ? 'bg-rose-600 text-white shadow-sm'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            سندات الصرف ({vouchers.filter((v) => v.type === 'PAYMENT').length})
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => handleOpenVoucherModal('RECEIPT')}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition-colors shrink-0"
          >
            <ArrowDownLeft className="w-4 h-4" />
            <span>+ سند قبض جديد</span>
          </button>
          <button
            onClick={() => handleOpenVoucherModal('PAYMENT')}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold transition-colors shrink-0"
          >
            <ArrowUpRight className="w-4 h-4" />
            <span>- سند صرف جديد</span>
          </button>
          <button
            onClick={() => setIsAddBoxModalOpen(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-xs font-bold transition-colors shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span>إضافة صندوق / بنك</span>
          </button>
        </div>
      </div>

      {/* VIEW 1: الخزائن والصناديق والبنوك */}
      {activeTab === 'boxes' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {cashBoxes.map((box) => (
            <div
              key={box.id}
              className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center">
                      <Wallet className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="font-bold text-xs text-slate-900">{box.nameAr}</h4>
                      <span className="font-mono text-[10px] text-slate-400">{box.code}</span>
                    </div>
                  </div>
                  {box.isDefault && (
                    <span className="px-2 py-0.5 rounded text-[10px] bg-slate-100 text-slate-600 font-semibold">
                      الخزينة الافتراضية
                    </span>
                  )}
                </div>

                <div className="mt-4 pt-4 border-t border-slate-100">
                  <div className="text-[11px] text-slate-500 mb-1">الرصيد النقدي الفعلي المتاح:</div>
                  <div className="text-2xl font-bold font-mono tabular-nums text-slate-900">
                    {box.balance.toFixed(2)}{' '}
                    <span className="text-xs font-normal text-slate-500">{currencySymbol}</span>
                  </div>
                </div>
              </div>

              <div className="mt-5 pt-3 border-t border-slate-100 flex gap-2">
                <button
                  onClick={() => handleOpenVoucherModal('RECEIPT', box.id)}
                  className="flex-1 py-1.5 px-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 rounded font-semibold text-xs transition-colors"
                >
                  إيداع / قبض
                </button>
                <button
                  onClick={() => handleOpenVoucherModal('PAYMENT', box.id)}
                  className="flex-1 py-1.5 px-2 bg-rose-50 hover:bg-rose-100 text-rose-800 rounded font-semibold text-xs transition-colors"
                >
                  صرف نقدية
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* VIEW 2 & 3: جدول السندات (قبض وصرف) */}
      {(activeTab === 'receipts' || activeTab === 'payments') && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 bg-slate-50">
                  <th className="py-3 px-4">رقم السند</th>
                  <th className="py-3 px-4">التاريخ</th>
                  <th className="py-3 px-4">الحالة</th>
                  <th className="py-3 px-4">الطرف المعني</th>
                  <th className="py-3 px-4">الشرح والتخصيص</th>
                  <th className="py-3 px-4">الوسيلة / الصندوق</th>
                  <th className="py-3 px-4 text-center">المبلغ</th>
                  <th className="py-3 px-4 text-center">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredVouchers.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-slate-400">
                      <FileText className="w-8 h-8 mx-auto mb-2 text-slate-300 stroke-1" />
                      <p className="font-semibold">
                        لا توجد سندات {activeTab === 'receipts' ? 'قبض' : 'صرف'} مسجلة بعد
                      </p>
                    </td>
                  </tr>
                ) : (
                  filteredVouchers.map((v) => {
                    const box = cashBoxes.find((b) => b.id === v.cashBoxId);
                    const status = v.status || 'POSTED';
                    const methodLabel =
                      VOUCHER_PAYMENT_METHOD_LABELS[v.paymentMethod || 'CASH'] || 'نقدي';
                    return (
                      <tr key={v.id} className="hover:bg-slate-50/80 transition-colors">
                        <td className="py-3 px-4">
                          <div className="font-mono font-bold text-slate-900">{v.voucherNumber}</div>
                          {v.manualOverride && (
                            <span className="inline-block mt-0.5 text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 font-semibold">
                              تخصيص يدوي
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-600">{v.date}</td>
                        <td className="py-3 px-4">{renderStatusBadge(status)}</td>
                        <td className="py-3 px-4">
                          <div className="font-semibold text-slate-900">{v.partyName}</div>
                          <div className="text-[10px] text-slate-500">
                            {v.partyId ? 'طرف مسجل' : `حساب ${v.accountCode}`}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-slate-700">
                          <div>{v.description}</div>
                          {(v.appliedToDebtAmount || 0) > 0 || (v.advanceAmount || 0) > 0 ? (
                            <div className="text-[10px] text-slate-500 mt-0.5 font-mono">
                              {(v.appliedToDebtAmount || 0) > 0 &&
                                `تسوية ذمة: ${Number(v.appliedToDebtAmount).toFixed(2)} `}
                              {(v.advanceAmount || 0) > 0 &&
                                `| رصيد مقدم: ${Number(v.advanceAmount).toFixed(2)}`}
                            </div>
                          ) : null}
                          {v.reversalReason && (
                            <div className="text-[10px] text-rose-700 mt-0.5">
                              سبب العكس: {v.reversalReason}
                            </div>
                          )}
                          {v.cancelledReason && (
                            <div className="text-[10px] text-slate-500 mt-0.5">
                              سبب الإلغاء: {v.cancelledReason}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-600">
                          <div>{box?.nameAr || '-'}</div>
                          <div className="text-[10px] text-slate-400">
                            {methodLabel}
                            {v.externalRef ? ` (${v.externalRef})` : ''}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-center font-mono tabular-nums font-bold text-slate-900">
                          {v.amount.toFixed(2)} {currencySymbol}
                        </td>
                        <td className="py-3 px-4 text-center">
                          <div className="flex items-center justify-center gap-1 flex-wrap">
                            {status === 'DRAFT' && (
                              <>
                                <button
                                  onClick={() => handlePostDraftVoucher(v)}
                                  disabled={isSubmitting}
                                  title="ترحيل المسودة نهائياً"
                                  className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold flex items-center gap-1"
                                >
                                  <Send className="w-3 h-3" />
                                  <span>ترحيل</span>
                                </button>
                                {canCancelVoucher && (
                                  <button
                                    onClick={() => {
                                      setCancelModalVoucher(v);
                                      setCancelReason('');
                                      setCancelError(null);
                                    }}
                                    title="إلغاء المسودة"
                                    className="px-2 py-1 rounded bg-slate-200 hover:bg-slate-300 text-slate-800 text-[10px] font-bold flex items-center gap-1"
                                  >
                                    <Ban className="w-3 h-3" />
                                    <span>إلغاء</span>
                                  </button>
                                )}
                              </>
                            )}

                            {status === 'POSTED' && canReverseVoucher && (
                              <button
                                onClick={() => {
                                  setReverseModalVoucher(v);
                                  setReverseReason('');
                                  setReverseError(null);
                                }}
                                title="عكس السند بقيد عكسي"
                                className="px-2 py-1 rounded bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-200 text-[10px] font-bold flex items-center gap-1"
                              >
                                <RotateCcw className="w-3 h-3" />
                                <span>عكس</span>
                              </button>
                            )}

                            <button
                              onClick={() => handleNotifyVoucher(v)}
                              title="إشعار الطرف بالواتساب والمشاركة"
                              className="p-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 transition-colors"
                            >
                              <Share2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handlePrintVoucher(v)}
                              title="طباعة السند رسمياً"
                              className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
                            >
                              <Printer className="w-3.5 h-3.5" />
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
      )}

      {/* Modal: New Voucher */}
      {isVoucherModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto">
          <div className="relative w-full max-w-2xl bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200 my-6">
            <div
              className={`flex items-center justify-between px-6 py-4 text-white ${
                voucherType === 'RECEIPT' ? 'bg-emerald-800' : 'bg-rose-800'
              }`}
            >
              <h3 className="text-sm font-bold flex items-center gap-2">
                {voucherType === 'RECEIPT' ? (
                  <ArrowDownLeft className="w-5 h-5" />
                ) : (
                  <ArrowUpRight className="w-5 h-5" />
                )}
                <span>
                  {voucherType === 'RECEIPT' ? 'تحرير سند قبض نقدي / بنكي' : 'تحرير سند صرف نقدي / بنكي'}
                </span>
              </h3>
              <button
                onClick={() => setIsVoucherModalOpen(false)}
                className="text-white/80 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveVoucher} className="p-6 space-y-4 text-xs max-h-[82vh] overflow-y-auto">
              {voucherError && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0" />
                  <span>{voucherError}</span>
                </div>
              )}

              {/* Operation Mode Selector */}
              <div>
                <label className="block font-semibold text-slate-700 mb-1.5">نوع العملية المحاسبية *</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['CUSTOMER_RECEIPT', 'SUPPLIER_PAYMENT', 'GENERAL'] as VoucherAllocationMode[]).map(
                    (mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => handleModeChange(mode)}
                        className={`py-2 px-3 rounded-lg border font-bold text-center transition-all ${
                          voucherMode === mode
                            ? 'bg-slate-900 text-white border-slate-900 shadow-sm'
                            : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        {VOUCHER_MODE_LABELS[mode]}
                      </button>
                    )
                  )}
                </div>
              </div>

              {voucherMode === 'GENERAL' && (
                <div className="flex items-center gap-2 bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <span className="font-semibold text-slate-600">اتجاه الحركة العامة:</span>
                  <button
                    type="button"
                    onClick={() => setVoucherType('RECEIPT')}
                    className={`px-3 py-1 rounded font-bold ${
                      voucherType === 'RECEIPT'
                        ? 'bg-emerald-600 text-white'
                        : 'bg-white text-slate-700 border border-slate-200'
                    }`}
                  >
                    قبض عام (إيراد غير مخزني / إيداع)
                  </button>
                  <button
                    type="button"
                    onClick={() => setVoucherType('PAYMENT')}
                    className={`px-3 py-1 rounded font-bold ${
                      voucherType === 'PAYMENT'
                        ? 'bg-rose-600 text-white'
                        : 'bg-white text-slate-700 border border-slate-200'
                    }`}
                  >
                    صرف عام (مصروف تشغيلي)
                  </button>
                </div>
              )}

              {/* Party Dropdown when CUSTOMER_RECEIPT or SUPPLIER_PAYMENT */}
              {voucherMode !== 'GENERAL' ? (
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 space-y-2">
                  <label className="block font-semibold text-slate-800">
                    {voucherMode === 'CUSTOMER_RECEIPT' ? 'اختر العميل المسجل *' : 'اختر المورد المسجل *'}
                  </label>
                  <select
                    required
                    value={voucherPartyId}
                    onChange={(e) => {
                      setVoucherPartyId(e.target.value);
                      setUseManualOverride(false);
                      setManualAmounts({});
                    }}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white text-slate-900 font-semibold focus:outline-none"
                  >
                    <option value="">
                      -- اختر {voucherMode === 'CUSTOMER_RECEIPT' ? 'العميل' : 'المورد'} بمعرفه المسجل --
                    </option>
                    {(voucherMode === 'CUSTOMER_RECEIPT' ? customers : suppliers).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nameAr} | ذمة: {p.balance.toFixed(2)} {currencySymbol}
                        {(p.advanceBalance || 0) > 0
                          ? ` | رصيد مقدم: ${Number(p.advanceBalance).toFixed(2)}`
                          : ''}
                      </option>
                    ))}
                  </select>

                  {selectedParty && (
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] pt-1 text-slate-600">
                      <span>
                        الحساب المقابل المقفل تلقائياً:{' '}
                        <strong className="font-mono text-slate-900">
                          {voucherMode === 'CUSTOMER_RECEIPT'
                            ? '1103 العملاء (والفائض → 2103 دفعات مقدمة)'
                            : '2101 الموردون (والزائد → 1105 سلف الموردين)'}
                        </strong>
                      </span>
                      <span>
                        رصيد مقدم متاح:{' '}
                        <strong className="font-mono text-indigo-700">
                          {Number(selectedParty.advanceBalance || 0).toFixed(2)} {currencySymbol}
                        </strong>
                      </span>
                    </div>
                  )}
                </div>
              ) : null}

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    المبلغ المالي ({currencySymbol}) *
                  </label>
                  <input
                    type="number"
                    step="any"
                    min="0.01"
                    required
                    value={voucherAmount}
                    onChange={(e) => setVoucherAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full px-3 py-2 border border-slate-200 rounded font-mono font-bold text-sm text-slate-900 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">التاريخ *</label>
                  <input
                    type="date"
                    required
                    value={voucherDate}
                    onChange={(e) => setVoucherDate(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded font-mono text-slate-900 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">طريقة الدفع *</label>
                  <select
                    value={voucherPaymentMethod}
                    onChange={(e) => setVoucherPaymentMethod(e.target.value as VoucherPaymentMethod)}
                    className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900 focus:outline-none"
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
                    value={voucherExternalRef}
                    onChange={(e) => setVoucherExternalRef(e.target.value)}
                    placeholder="رقم شيك / حوالة..."
                    className="w-full px-3 py-2 border border-slate-200 rounded font-mono text-slate-900 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    {voucherType === 'RECEIPT' ? 'إيداع في الصندوق / البنك:' : 'الصرف من الصندوق / البنك:'}
                  </label>
                  <select
                    value={voucherCashBoxId}
                    onChange={(e) => setVoucherCashBoxId(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900 focus:outline-none"
                  >
                    {cashBoxes.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.nameAr} ({b.balance.toFixed(2)} {currencySymbol})
                      </option>
                    ))}
                  </select>
                </div>

                {voucherMode === 'GENERAL' ? (
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">
                      الحساب المقابل (حسابات فرعية غير ذمم) *
                    </label>
                    <select
                      value={voucherAccountCode}
                      onChange={(e) => setVoucherAccountCode(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900 focus:outline-none"
                    >
                      {generalLeafAccounts.map((a) => (
                        <option key={a.code} value={a.code}>
                          {a.code} - {a.nameAr}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">مركز التكلفة المحاسبي *</label>
                    <select
                      value={voucherCostCenter}
                      onChange={(e) => setVoucherCostCenter(e.target.value as CostCenterId)}
                      className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900 focus:outline-none font-medium"
                    >
                      <option value="general">CC-100 - الإدارة العامة</option>
                      <option value="pharmacy">CC-101 - الصيدلية</option>
                      <option value="grocery">CC-102 - المواد الغذائية والبقالة</option>
                      <option value="bike_parts">CC-103 - قطع غيار الدراجات النارية</option>
                      <option value="equipment_parts">CC-104 - قطع غيار المعدات</option>
                    </select>
                  </div>
                )}
              </div>

              {voucherMode === 'GENERAL' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">
                      {voucherType === 'RECEIPT' ? 'المودع / الجهة:' : 'المستفيد / المصروف له:'}
                    </label>
                    <input
                      type="text"
                      value={voucherPartyName}
                      onChange={(e) => setVoucherPartyName(e.target.value)}
                      placeholder="اسم الجهة أو المستفيد..."
                      className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">مركز التكلفة المحاسبي *</label>
                    <select
                      value={voucherCostCenter}
                      onChange={(e) => setVoucherCostCenter(e.target.value as CostCenterId)}
                      className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900 focus:outline-none font-medium"
                    >
                      <option value="general">CC-100 - الإدارة العامة</option>
                      <option value="pharmacy">CC-101 - الصيدلية</option>
                      <option value="grocery">CC-102 - المواد الغذائية والبقالة</option>
                      <option value="bike_parts">CC-103 - قطع غيار الدراجات النارية</option>
                      <option value="equipment_parts">CC-104 - قطع غيار المعدات</option>
                    </select>
                  </div>
                </div>
              )}

              {/* FIFO / Manual Invoice Allocation Preview */}
              {voucherMode !== 'GENERAL' && selectedParty && (
                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <div className="bg-slate-100 px-3 py-2 flex items-center justify-between gap-2">
                    <div className="font-bold text-slate-800">
                      معاينة تخصيص الفواتير المفتوحة (FIFO — الأقدم أولاً) ({partyOpenInvoices.length})
                    </div>
                    {canOverrideAllocation && partyOpenInvoices.length > 0 && (
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

                  {partyOpenInvoices.length === 0 ? (
                    <div className="p-3 text-slate-500 text-center">
                      لا توجد فواتير مفتوحة مسجلة لهذا الطرف؛ أي مبلغ إضافي سيُعالج وفق الرصيد المقدم أو الذمة السابقة.
                    </div>
                  ) : (
                    <div className="max-h-44 overflow-y-auto">
                      <table className="w-full text-right text-[11px]">
                        <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                          <tr>
                            <th className="py-1.5 px-2.5">رقم الفاتورة</th>
                            <th className="py-1.5 px-2.5">التاريخ</th>
                            <th className="py-1.5 px-2.5 text-center">المتبقي</th>
                            <th className="py-1.5 px-2.5 text-center">المخصص من السند</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {partyOpenInvoices.map((inv) => {
                            const rem = getInvoiceRemainingAmount(inv);
                            const previewAlloc =
                              livePlanPreview?.ok
                                ? livePlanPreview.plan.allocations.find((a) => a.invoiceId === inv.id)
                                    ?.allocatedAmount || 0
                                : 0;
                            return (
                              <tr key={inv.id}>
                                <td className="py-1.5 px-2.5 font-mono font-bold text-slate-900">
                                  {inv.invoiceNumber}
                                </td>
                                <td className="py-1.5 px-2.5 font-mono text-slate-600">{inv.date}</td>
                                <td className="py-1.5 px-2.5 text-center font-mono">
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
                                      placeholder="0.00"
                                      className="w-24 px-2 py-0.5 border border-purple-300 rounded font-mono text-center bg-white"
                                    />
                                  ) : (
                                    <span className="font-mono font-bold text-emerald-700">
                                      {previewAlloc.toFixed(2)} {currencySymbol}
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
                    <div className="p-2.5 bg-purple-50 border-t border-purple-200 space-y-1.5">
                      <label className="block font-bold text-purple-900 text-[11px]">
                        سبب التعديل اليدوي للتخصيص (إلزامي لسجل التدقيق) *
                      </label>
                      <input
                        type="text"
                        value={overrideReason}
                        onChange={(e) => setOverrideReason(e.target.value)}
                        placeholder="مثال: سداد فاتورة محددة بطلب العميل / تسوية نزاع..."
                        className="w-full px-2.5 py-1.5 border border-purple-300 rounded bg-white text-slate-900"
                      />
                    </div>
                  )}

                  {livePlanPreview && !livePlanPreview.ok && (
                    <div className="p-2.5 bg-rose-50 border-t border-rose-200 text-rose-800 flex items-center gap-1.5 text-[11px]">
                      <ShieldAlert className="w-4 h-4 shrink-0" />
                      <span>{livePlanPreview.error}</span>
                    </div>
                  )}

                  {livePlanPreview?.ok && livePlanPreview.plan.advanceAmount > 0 && (
                    <div className="p-2.5 bg-indigo-50 border-t border-indigo-200 text-indigo-900 text-[11px] font-semibold">
                      {voucherMode === 'CUSTOMER_RECEIPT'
                        ? `تنبيه محاسبي: يوجد فائض قدره ${livePlanPreview.plan.advanceAmount.toFixed(2)} ${currencySymbol} بعد تسوية الديون؛ سيُرحّل كالتزام رصيد مقدم للعميل في حساب (2103) ولن يُسجّل إيراداً.`
                        : `تنبيه محاسبي: المبلغ الزائد قدره ${livePlanPreview.plan.advanceAmount.toFixed(2)} ${currencySymbol} سيُرحّل إلى حساب سلف الموردين (1105).`}
                    </div>
                  )}
                </div>
              )}

              <div>
                <label className="block font-semibold text-slate-700 mb-1">البيان والشرح التفصيلي *</label>
                <textarea
                  rows={2}
                  required
                  value={voucherDescription}
                  onChange={(e) => setVoucherDescription(e.target.value)}
                  placeholder="سبب القبض أو الصرف (مثال: تحصيل دفعة فواتير، سداد لمورد، مصروف صيانة...)"
                  className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900 focus:outline-none"
                />
              </div>

              <div className="flex flex-wrap justify-between items-center gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsVoucherModalOpen(false)}
                  className="px-4 py-2 border border-slate-200 rounded-lg hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => submitVoucher('DRAFT')}
                    className="px-4 py-2 border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-900 font-bold rounded-lg transition-colors disabled:opacity-50"
                  >
                    حفظ كمسودة
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting || Boolean(livePlanPreview && !livePlanPreview.ok)}
                    className={`px-5 py-2 font-bold text-white rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50 ${
                      voucherType === 'RECEIPT'
                        ? 'bg-emerald-600 hover:bg-emerald-700'
                        : 'bg-rose-600 hover:bg-rose-700'
                    }`}
                  >
                    <Check className="w-4 h-4" />
                    <span>{isSubmitting ? 'جارٍ الترحيل...' : 'ترحيل وإصدار السند'}</span>
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Cancel Draft Voucher */}
      {cancelModalVoucher && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="relative w-full max-w-md bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
            <div className="flex items-center justify-between px-5 py-3.5 bg-slate-900 text-white">
              <h3 className="text-xs font-bold">إلغاء مسودة السند ({cancelModalVoucher.voucherNumber})</h3>
              <button onClick={() => setCancelModalVoucher(null)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleConfirmCancelDraft} className="p-5 space-y-3 text-xs">
              {cancelError && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 rounded text-rose-800">
                  {cancelError}
                </div>
              )}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">سبب الإلغاء *</label>
                <textarea
                  rows={3}
                  required
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  placeholder="اذكر سبب إلغاء المسودة..."
                  className="w-full p-2.5 border border-slate-200 rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setCancelModalVoucher(null)}
                  className="px-3 py-1.5 border border-slate-200 rounded-lg"
                >
                  تراجع
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-1.5 bg-slate-900 text-white font-bold rounded-lg disabled:opacity-50"
                >
                  تأكيد الإلغاء
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Reverse Posted Voucher */}
      {reverseModalVoucher && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="relative w-full max-w-md bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
            <div className="flex items-center justify-between px-5 py-3.5 bg-rose-900 text-white">
              <h3 className="text-xs font-bold">عكس السند المرحل ({reverseModalVoucher.voucherNumber})</h3>
              <button onClick={() => setReverseModalVoucher(null)} className="text-white/80 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleConfirmReverseVoucher} className="p-5 space-y-3 text-xs">
              {reverseError && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 rounded text-rose-800">
                  {reverseError}
                </div>
              )}
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-900 leading-relaxed">
                لا يُحذف السند المرحّل نهائياً؛ سيتم إنشاء قيد عكسي، وإلغاء تخصيص الفواتير المرتبطة، واستعادة رصيد الصندوق والطرف بدقة.
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">سبب العكس المحاسبي *</label>
                <textarea
                  rows={3}
                  required
                  value={reverseReason}
                  onChange={(e) => setReverseReason(e.target.value)}
                  placeholder="اذكر سبب عكس السند..."
                  className="w-full p-2.5 border border-slate-200 rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setReverseModalVoucher(null)}
                  className="px-3 py-1.5 border border-slate-200 rounded-lg"
                >
                  تراجع
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-1.5 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-lg disabled:opacity-50"
                >
                  تأكيد العكس والترحيل
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: New Cash Box */}
      {isAddBoxModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="relative w-full max-w-sm bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
            <div className="flex items-center justify-between px-5 py-3.5 bg-slate-900 text-white">
              <h3 className="text-xs font-bold">إضافة صندوق / حساب بنكي جديد</h3>
              <button onClick={() => setIsAddBoxModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveNewCashBox} className="p-5 space-y-3 text-xs">
              {boxError && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 flex items-center gap-1.5">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{boxError}</span>
                </div>
              )}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">اسم الصندوق أو البنك *</label>
                <input
                  type="text"
                  required
                  value={boxName}
                  onChange={(e) => setBoxName(e.target.value)}
                  placeholder="مثال: خزينة الصيدلية، بنك الإنماء..."
                  className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">الكود التعريفي *</label>
                <input
                  type="text"
                  required
                  value={boxCode}
                  onChange={(e) => setBoxCode(e.target.value)}
                  placeholder="مثال: CASH-PHARM / BANK-02..."
                  className="w-full px-3 py-2 border border-slate-200 rounded font-mono text-slate-900"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsAddBoxModalOpen(false)}
                  className="px-3 py-1.5 border border-slate-200 rounded"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded font-bold disabled:opacity-50"
                >
                  إضافة
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Printable Voucher Preview Modal (No window.open) */}
      {printableVoucher && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto no-print">
          <div className="relative w-full max-w-lg bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
            <div className="flex items-center justify-between px-5 py-3.5 bg-slate-900 text-white no-print">
              <span className="font-bold text-xs">
                {printableVoucher.type === 'RECEIPT' ? 'سند قبض مالي' : 'سند صرف مالي'} —{' '}
                {printableVoucher.voucherNumber}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="flex items-center gap-1 px-3 py-1 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>طباعة</span>
                </button>
                <button
                  onClick={() => setPrintableVoucher(null)}
                  className="text-slate-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="p-6 text-xs text-slate-800 space-y-4 printable-area bg-white">
              <div className="text-center border-b-2 border-slate-900 pb-3">
                <h2 className="text-base font-extrabold text-slate-900">
                  نظام عمرو النماري للإدارة التجارية المتعددة الأنشطة
                </h2>
                <div className="flex items-center justify-center gap-2 mt-2">
                  <span
                    className={`px-3 py-1 rounded font-bold ${
                      printableVoucher.type === 'RECEIPT'
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-rose-100 text-rose-800'
                    }`}
                  >
                    {printableVoucher.type === 'RECEIPT' ? 'سند قبض مالي رسمي' : 'سند صرف مالي رسمي'}
                  </span>
                  {renderStatusBadge(printableVoucher.status)}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 bg-slate-50 p-3 rounded-lg border border-slate-200">
                <div>
                  <strong>رقم السند:</strong>{' '}
                  <span className="font-mono">{printableVoucher.voucherNumber}</span>
                </div>
                <div>
                  <strong>التاريخ:</strong>{' '}
                  <span className="font-mono">{printableVoucher.date}</span>
                </div>
                <div>
                  <strong>{printableVoucher.type === 'RECEIPT' ? 'المستلم منه:' : 'المصروف له:'}</strong>{' '}
                  {printableVoucher.partyName}
                </div>
                <div>
                  <strong>معرف الطرف:</strong>{' '}
                  <span className="font-mono text-[10px]">{printableVoucher.partyId || 'عام'}</span>
                </div>
                <div>
                  <strong>الصندوق:</strong>{' '}
                  {cashBoxes.find((b) => b.id === printableVoucher.cashBoxId)?.nameAr || '-'}
                </div>
                <div>
                  <strong>طريقة الدفع:</strong>{' '}
                  {VOUCHER_PAYMENT_METHOD_LABELS[printableVoucher.paymentMethod || 'CASH']}
                  {printableVoucher.externalRef ? ` (${printableVoucher.externalRef})` : ''}
                </div>
                <div>
                  <strong>الفرع:</strong>{' '}
                  {branches.find((br) => br.id === printableVoucher.branchId)?.nameAr ||
                    printableVoucher.branchId ||
                    '-'}
                </div>
                <div>
                  <strong>الموظف:</strong> {printableVoucher.createdByName || '-'}
                </div>
                <div>
                  <strong>القيد المحاسبي:</strong>{' '}
                  <span className="font-mono text-[10px]">
                    {printableVoucher.journalEntryId || 'غير مرحل بعد'}
                  </span>
                </div>
                <div>
                  <strong>الحساب المقابل:</strong>{' '}
                  <span className="font-mono">{printableVoucher.accountCode}</span>
                </div>
                <div className="col-span-2">
                  <strong>البيان:</strong> {printableVoucher.description}
                </div>
              </div>

              <div className="text-center bg-slate-900 text-white py-3 px-4 rounded-lg space-y-1">
                <div className="text-base font-extrabold font-mono">
                  المبلغ: {printableVoucher.amount.toFixed(2)} {currencySymbol}
                </div>
                <div className="text-[11px] text-emerald-300 font-semibold">
                  {numberToArabicWords(printableVoucher.amount, currencyConfig.nameAr)}
                </div>
              </div>

              {((printableVoucher.appliedToDebtAmount || 0) > 0 ||
                (printableVoucher.advanceAmount || 0) > 0) && (
                <div className="grid grid-cols-2 gap-2 p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-[11px]">
                  <div>
                    <strong>المخصص لتسوية الذمم:</strong>{' '}
                    <span className="font-mono font-bold">
                      {Number(printableVoucher.appliedToDebtAmount || 0).toFixed(2)} {currencySymbol}
                    </span>
                  </div>
                  <div>
                    <strong>الرصيد المقدم الناتج:</strong>{' '}
                    <span className="font-mono font-bold text-indigo-700">
                      {Number(printableVoucher.advanceAmount || 0).toFixed(2)} {currencySymbol}
                    </span>
                  </div>
                </div>
              )}

              {printableAllocations.length > 0 && (
                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <div className="bg-slate-100 px-3 py-1.5 font-bold text-slate-700 text-[11px]">
                    تفاصيل تخصيص الفواتير
                  </div>
                  <table className="w-full text-right text-[11px]">
                    <thead className="bg-slate-50 border-b border-slate-200">
                      <tr>
                        <th className="py-1.5 px-2">رقم الفاتورة</th>
                        <th className="py-1.5 px-2">التاريخ</th>
                        <th className="py-1.5 px-2">الطريقة</th>
                        <th className="py-1.5 px-2 text-center">المخصص</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {printableAllocations.map((alloc) => (
                        <tr key={alloc.id}>
                          <td className="py-1.5 px-2 font-mono font-bold">
                            {alloc.invoiceNumber || alloc.invoiceId}
                          </td>
                          <td className="py-1.5 px-2 font-mono">{alloc.invoiceDate || '-'}</td>
                          <td className="py-1.5 px-2">
                            {alloc.allocationMethod === 'MANUAL' ? 'يدوي' : 'FIFO'}
                            {alloc.status === 'REVERSED' ? ' (معكوس)' : ''}
                          </td>
                          <td className="py-1.5 px-2 text-center font-mono font-bold">
                            {alloc.allocatedAmount.toFixed(2)} {currencySymbol}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Customer Notification Modal for WhatsApp, Print & Native Share */}
      <CustomerNotificationModal
        isOpen={notificationData.isOpen}
        onClose={() => setNotificationData((prev) => ({ ...prev, isOpen: false }))}
        recipientName={notificationData.recipientName}
        recipientPhone={notificationData.recipientPhone}
        documentType={notificationData.documentType}
        documentNumber={notificationData.documentNumber}
        amount={notificationData.amount}
        notes={notificationData.notes}
      />
    </div>
  );
};

