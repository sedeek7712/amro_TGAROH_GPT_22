/**
 * إدارة المشتريات وفواتير الموردين (Purchases Management)
 * تسجيل فواتير الشراء، تحديث المخزون والتشغيلات، وتوليد القيود المحاسبية آلياً
 */

import React, { useState, useEffect } from 'react';
import {
  FileSpreadsheet,
  Plus,
  Search,
  Truck,
  DollarSign,
  Package,
  Calendar,
  X,
  Check,
  Trash2,
  AlertCircle,
  Building2,
  RotateCcw,
  Printer,
} from 'lucide-react';
import { storage } from '../../services/storageService';
import { desktopSession } from '../../services/desktopSession';
import { dataService } from '../../services/dataService';
import { authService } from '../../services/authService';
import { hasPermission, getAuthorizedActivityIds } from '../../config/rbac';
import { getActiveCurrencyConfig, roundMoney } from '../../config/currency';
import { useLiveInvoices, useLiveParties, useLiveCashBoxes, useLiveProducts } from '../../hooks/useLiveDexie';
import { Invoice, InvoiceItem, ActivityId, PaymentMethod } from '../../types/erp';
import { ReceiptModal } from '../common/ReceiptModal';
import { formatLocalDate } from '../../utils/localDate';

interface PurchasesManagerProps {
  onRefresh: () => void;
}

export const PurchasesManager: React.FC<PurchasesManagerProps> = ({ onRefresh }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const isDesktop = typeof window !== 'undefined' && Boolean(window.amroDesktop);
  const actor =
    authService.getCurrentActorSync() || (isDesktop ? null : storage.getCurrentUser());
  const authorizedActivityIds = getAuthorizedActivityIds(actor);
  const allActivities: Array<{ id: ActivityId; name: string }> = [
    { id: 'pharmacy', name: 'الصيدلية' },
    { id: 'grocery', name: 'المواد الغذائية والبقالة' },
    { id: 'bike_parts', name: 'قطع غيار الدراجات' },
    { id: 'equipment_parts', name: 'قطع غيار المعدات' },
  ];
  const allowedActivityOptions =
    actor?.role === 'ADMIN'
      ? allActivities
      : allActivities.filter((a) => authorizedActivityIds.has(a.id));

  // حقول نموذج فاتورة الشراء
  const [activityId, setActivityId] = useState<ActivityId>(
    allowedActivityOptions[0]?.id || 'pharmacy'
  );
  const [supplierId, setSupplierId] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CASH');
  const [cashBoxId, setCashBoxId] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(() => formatLocalDate());
  const [dueDate, setDueDate] = useState('');
  const [printableInvoice, setPrintableInvoice] = useState<Invoice | null>(null);
  const [paidAmountInput, setPaidAmountInput] = useState('');
  const [applyAdvanceInput, setApplyAdvanceInput] = useState('');
  const [items, setItems] = useState<
    Array<{
      productId: string;
      productName: string;
      quantity: number;
      costPrice: number;
      batchNumber?: string;
      expiryDate?: string;
      unit: string;
    }>
  >([]);

  // حقول إضافة سطر صنف للفاتورة
  const [selectedProductId, setSelectedProductId] = useState('');
  const [itemQty, setItemQty] = useState('1');
  const [itemCost, setItemCost] = useState('');
  const [itemBatch, setItemBatch] = useState('');
  const [itemExpiry, setItemExpiry] = useState('');

  // حقول مرتجع المشتريات
  const [returnSourceInvoice, setReturnSourceInvoice] = useState<Invoice | null>(null);
  const [returnQuantities, setReturnQuantities] = useState<Record<string, string>>({});
  const [returnRefundMethod, setReturnRefundMethod] = useState<'AUTO' | 'AP_OFFSET' | 'CASH' | 'ADVANCE'>('AUTO');
  const [returnCashBoxId, setReturnCashBoxId] = useState('');
  const [returnReason, setReturnReason] = useState('');
  const [returnError, setReturnError] = useState<string | null>(null);
  const [returnRequestId, setReturnRequestId] = useState<string>(() => storage.generateUUID());

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [clientRequestId, setClientRequestId] = useState<string>(() => storage.generateUUID());

  const canUseAdvance = hasPermission(actor, 'party:advance:use');
  const canReturnPurchase = hasPermission(actor, 'purchase:return');

  const allInvoices = useLiveInvoices();
  const invoices = allInvoices.filter(
    (inv) => inv.type === 'PURCHASE' || inv.type === 'RETURN_PURCHASE'
  );
  const suppliers = useLiveParties('SUPPLIER');
  const cashBoxes = useLiveCashBoxes();
  const products = useLiveProducts(activityId);
  const currencySymbol = getActiveCurrencyConfig().symbol;

  const defaultCashBoxId =
    cashBoxes.find((b) => !b.isCentral && b.isDefault)?.id ||
    cashBoxes.find((b) => !b.isCentral)?.id ||
    cashBoxes[0]?.id ||
    '';

  useEffect(() => {
    if (!cashBoxId && defaultCashBoxId) {
      setCashBoxId(defaultCashBoxId);
    }
    if (!returnCashBoxId && defaultCashBoxId) {
      setReturnCashBoxId(defaultCashBoxId);
    }
  }, [defaultCashBoxId, cashBoxId, returnCashBoxId]);

  // تصفية الفواتير
  const filteredInvoices = invoices.filter((inv) => {
    const q = searchQuery.toLowerCase();
    return (
      !searchQuery.trim() ||
      inv.invoiceNumber.toLowerCase().includes(q) ||
      inv.partyName.toLowerCase().includes(q)
    );
  });

  const handleAddItemToInvoice = () => {
    setFormError(null);
    const product = products.find((p) => p.id === selectedProductId);
    if (!product) return;

    const qty = Number(itemQty) || 1;
    const cost = Number(itemCost) || product.purchasePrice;
    const todayStr = formatLocalDate();

    // الفحص الصارم للأدوية بالصيدلية
    if (activityId === 'pharmacy') {
      if (!itemBatch.trim()) {
        setFormError(`رقم التشغيلة إجباري لإدراج الدواء (${product.nameAr}) في فاتورة المشتريات.`);
        return;
      }
      if (!itemExpiry.trim()) {
        setFormError(`تاريخ انتهاء الصلاحية إجباري لإدراج الدواء (${product.nameAr}) في فاتورة المشتريات.`);
        return;
      }
      if (itemExpiry < todayStr) {
        setFormError(`محظور تماماً استلام دواء منتهي الصلاحية! تاريخ الانتهاء ${itemExpiry} قد انقضى.`);
        return;
      }
    }

    setItems((prev) => [
      ...prev,
      {
        productId: product.id,
        productName: product.nameAr,
        quantity: qty,
        costPrice: cost,
        batchNumber: itemBatch.trim() || undefined,
        expiryDate: itemExpiry.trim() || undefined,
        unit: product.unit,
      },
    ]);

    setSelectedProductId('');
    setItemQty('1');
    setItemCost('');
    setItemBatch('');
    setItemExpiry('');
    setFormError(null);
  };

  const handleRemoveItem = (index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  const totalInvoice = roundMoney(items.reduce((sum, item) => sum + item.quantity * item.costPrice, 0));
  const selectedSupplierObj = suppliers.find((s) => s.id === supplierId);
  const availableSupplierAdvance = selectedSupplierObj
    ? roundMoney(selectedSupplierObj.advanceBalance || 0)
    : 0;
  const maxApplicableAdvance =
    selectedSupplierObj && canUseAdvance
      ? roundMoney(Math.min(availableSupplierAdvance, totalInvoice))
      : 0;
  const appliedAdvanceAmount =
    selectedSupplierObj && canUseAdvance
      ? roundMoney(Math.min(Math.max(0, Number(applyAdvanceInput) || 0), maxApplicableAdvance))
      : 0;
  const netAfterAdvance = roundMoney(Math.max(0, totalInvoice - appliedAdvanceAmount));
  const actualCashPaid =
    paymentMethod === 'CREDIT'
      ? roundMoney(Math.min(Math.max(0, Number(paidAmountInput) || 0), netAfterAdvance))
      : netAfterAdvance;
  const remainingCreditPayable = roundMoney(Math.max(0, netAfterAdvance - actualCashPaid));

  const handleSavePurchaseInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setFormError(null);

    if (items.length === 0) {
      setFormError('يجب إضافة صنف واحد على الأقل لفاتورة المشتريات.');
      return;
    }

    // تدقيق إضافي صارم لكافة بنود الأدوية بالصيدلية
    if (activityId === 'pharmacy') {
      const todayStr = formatLocalDate();
      for (const item of items) {
        if (!item.batchNumber || !item.batchNumber.trim()) {
          setFormError(`الدواء (${item.productName}) يفتقر إلى رقم تشغيلة إلزامي.`);
          return;
        }
        if (!item.expiryDate || !item.expiryDate.trim()) {
          setFormError(`الدواء (${item.productName}) يفتقر إلى تاريخ صلاحية إلزامي.`);
          return;
        }
        if (item.expiryDate < todayStr) {
          setFormError(`محظور حفظ الفاتورة: الدواء (${item.productName}) منتهي الصلاحية (${item.expiryDate})!`);
          return;
        }
      }
    }

    const activeBranchId = isDesktop
      ? desktopSession.getActiveBranchId() || 'branch_main'
      : storage.getActiveBranch().id;
    const selectedSupplier = suppliers.find((s) => s.id === supplierId);
    const finalPartyName = selectedSupplier ? selectedSupplier.nameAr : supplierName || 'مورد عام';

    if (appliedAdvanceAmount > 0 && (!supplierId || !canUseAdvance)) {
      setFormError('استخدام رصيد سلفة المورد يتطلب اختيار مورد مسجل وتوفر الصلاحية.');
      return;
    }

    if ((paymentMethod === 'CREDIT' || remainingCreditPayable > 0) && !supplierId) {
      setFormError('يجب اختيار مورد مسجل من القائمة عند تسجيل فاتورة شراء آجلة أو مسددة جزئياً.');
      return;
    }

    // 1. تجهيز سطور الفاتورة
    const invoiceItems: InvoiceItem[] = items.map((item) => ({
      id: storage.generateUUID(),
      productId: item.productId,
      productName: item.productName,
      productCode: '',
      unit: item.unit,
      quantity: item.quantity,
      unitPrice: item.costPrice,
      discount: 0,
      total: roundMoney(item.quantity * item.costPrice),
      batchNumber: item.batchNumber,
      expiryDate: item.expiryDate,
    }));

    // 2. إنشاء كائن الفاتورة
    const newInvoice: Invoice = {
      id: storage.generateUUID(),
      invoiceNumber: '',
      type: 'PURCHASE',
      activityId,
      branchId: activeBranchId,
      partyId: supplierId || undefined,
      partyName: finalPartyName,
      date: invoiceDate,
      dueDate: paymentMethod === 'CREDIT' && dueDate ? dueDate : undefined,
      items: invoiceItems,
      subtotal: totalInvoice,
      discount: 0,
      tax: 0,
      total: totalInvoice,
      paidAmount: actualCashPaid,
      paymentMethod,
      cashBoxId: cashBoxId || defaultCashBoxId,
    };

    setIsSubmitting(true);
    try {
      // 3. التنفيذ الذري المركب عبر مزود البيانات الموحد (تحديث المخزون والتشغيلات والقيد المزدوج ومنع التكرار)
      const created = await dataService.createPurchaseInvoiceAtomic({
        invoice: newInvoice,
        itemsWithBatches: items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          costPrice: item.costPrice,
          batchNumber: item.batchNumber,
          expiryDate: item.expiryDate,
        })),
        applyAdvanceAmount: appliedAdvanceAmount > 0 ? appliedAdvanceAmount : undefined,
        clientRequestId,
      });

      setIsAddModalOpen(false);
      setPrintableInvoice(created.invoice);
      setItems([]);
      setSupplierId('');
      setSupplierName('');
      setPaidAmountInput('');
      setApplyAdvanceInput('');
      setDueDate('');
      setFormError(null);
      setClientRequestId(storage.generateUUID());
      onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'حدث خطأ أثناء حفظ فاتورة المشتريات.';
      setFormError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  // حساب بنود مرتجع المشتريات المتاحة
  const purchaseReturnableLines = React.useMemo(() => {
    if (!returnSourceInvoice) return [];
    const priorReturns = allInvoices.filter(
      (i) =>
        i.type === 'RETURN_PURCHASE' &&
        i.originalInvoiceId === returnSourceInvoice.id &&
        i.status !== 'REVERSED'
    );
    const returnedByKey = new Map<string, number>();
    for (const r of priorReturns) {
      for (const it of r.items || []) {
        const key = `${it.productId}::${it.batchNumber || ''}`;
        returnedByKey.set(key, roundMoney((returnedByKey.get(key) || 0) + it.quantity, 4));
      }
    }

    const grouped = new Map<
      string,
      {
        key: string;
        productId: string;
        productName: string;
        batchNumber?: string;
        unit: string;
        purchasedQty: number;
        unitPrice: number;
      }
    >();
    for (const it of returnSourceInvoice.items || []) {
      const key = `${it.productId}::${it.batchNumber || ''}`;
      const prev = grouped.get(key);
      if (prev) {
        prev.purchasedQty = roundMoney(prev.purchasedQty + it.quantity, 4);
      } else {
        grouped.set(key, {
          key,
          productId: it.productId,
          productName: it.productName,
          batchNumber: it.batchNumber,
          unit: it.unit,
          purchasedQty: it.quantity,
          unitPrice: it.unitPrice,
        });
      }
    }

    return Array.from(grouped.values()).map((line) => {
      const alreadyReturned = returnedByKey.get(line.key) || 0;
      return {
        ...line,
        alreadyReturned,
        remainingQty: Math.max(0, roundMoney(line.purchasedQty - alreadyReturned, 4)),
      };
    });
  }, [returnSourceInvoice, allInvoices]);

  const openPurchaseReturnModal = (inv: Invoice) => {
    setReturnSourceInvoice(inv);
    setReturnQuantities({});
    setReturnRefundMethod('AUTO');
    setReturnCashBoxId(inv.cashBoxId || defaultCashBoxId);
    setReturnReason('');
    setReturnError(null);
    setReturnRequestId(storage.generateUUID());
  };

  const handleSubmitPurchaseReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!returnSourceInvoice || isSubmitting) return;
    setReturnError(null);

    if (!returnReason.trim()) {
      setReturnError('يرجى إدخال سبب مرتجع المشتريات لتوثيقه في القيد وسجل التدقيق.');
      return;
    }

    const itemsPayload = purchaseReturnableLines
      .map((line) => ({
        productId: line.productId,
        quantity: roundMoney(Number(returnQuantities[line.key]) || 0, 4),
        batchNumber: line.batchNumber,
        maxQty: line.remainingQty,
        productName: line.productName,
      }))
      .filter((x) => x.quantity > 0);

    if (itemsPayload.length === 0) {
      setReturnError('يرجى تحديد كمية أكبر من الصفر لصنف واحد على الأقل.');
      return;
    }

    for (const item of itemsPayload) {
      if (item.quantity > item.maxQty + 0.0001) {
        setReturnError(`الكمية المدخلة للصنف (${item.productName}) تتجاوز الكمية المتاحة (${item.maxQty}).`);
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const createdReturn = await dataService.createPurchaseReturnAtomic({
        originalInvoiceId: returnSourceInvoice.id,
        items: itemsPayload.map(({ productId, quantity, batchNumber }) => ({
          productId,
          quantity,
          batchNumber,
        })),
        returnReason: returnReason.trim(),
        refundMethod: returnRefundMethod,
        cashBoxId:
          returnRefundMethod === 'AP_OFFSET' || returnRefundMethod === 'ADVANCE'
            ? undefined
            : returnCashBoxId || defaultCashBoxId || undefined,
        clientRequestId: returnRequestId,
      });
      setReturnSourceInvoice(null);
      setPrintableInvoice(createdReturn.invoice);
      setReturnQuantities({});
      setReturnReason('');
      setReturnRequestId(storage.generateUUID());
      onRefresh();
    } catch (err: unknown) {
      setReturnError(err instanceof Error ? err.message : 'تعذر تسجيل مرتجع المشتريات.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header and Toolbar */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="بحث برقم الفاتورة أو اسم المورد..."
            className="w-full pl-3 pr-9 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>

        <button
          onClick={() => {
            setItems([]);
            setSupplierId('');
            setSupplierName('');
            setPaidAmountInput('');
            setApplyAdvanceInput('');
            setDueDate('');
            setFormError(null);
            setIsAddModalOpen(true);
          }}
          className="flex items-center gap-1.5 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-bold shadow-sm transition-colors shrink-0"
        >
          <Plus className="w-4 h-4 text-emerald-400" />
          <span>تسجيل فاتورة شراء جديدة</span>
        </button>
      </div>

      {/* Invoices Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500 bg-slate-50">
                <th className="py-3 px-4">رقم الفاتورة</th>
                <th className="py-3 px-4">التاريخ</th>
                <th className="py-3 px-4">المورد</th>
                <th className="py-3 px-4">النشاط المستهدف</th>
                <th className="py-3 px-4 text-center">طريقة الدفع</th>
                <th className="py-3 px-4 text-center">إجمالي الفاتورة</th>
                <th className="py-3 px-4 text-center">المدفوع / المسوّى</th>
                <th className="py-3 px-4 text-center">المتبقي آجل</th>
                <th className="py-3 px-4 text-center">الإجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredInvoices.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-400">
                    <FileSpreadsheet className="w-8 h-8 mx-auto mb-2 text-slate-300 stroke-1" />
                    <p className="font-medium">لا توجد فواتير مشتريات مسجلة بعد</p>
                    <p className="text-[11px] text-slate-400 mt-1">اضغط على زر «تسجيل فاتورة شراء جديدة» لإدخال بضاعة للمستودع</p>
                  </td>
                </tr>
              ) : (
                filteredInvoices.map((inv) => {
                  const isReturn = inv.type === 'RETURN_PURCHASE';
                  const openRemaining = isReturn
                    ? 0
                    : Math.max(0, roundMoney(inv.total - inv.paidAmount - (inv.returnedAmount || 0)));
                  return (
                    <tr key={inv.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-3 px-4 font-mono font-bold text-slate-900">
                        <div>{inv.invoiceNumber}</div>
                        {isReturn && (
                          <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-sans font-bold">
                            مرتجع ({inv.originalInvoiceNumber || '-'})
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-600">
                        <div>{inv.date}</div>
                        {inv.dueDate && (
                          <div className="text-[10px] text-amber-700">استحقاق: {inv.dueDate}</div>
                        )}
                      </td>
                      <td className="py-3 px-4 font-bold text-slate-900">{inv.partyName}</td>
                      <td className="py-3 px-4 text-slate-700">
                        {inv.activityId === 'pharmacy'
                          ? 'الصيدلية'
                          : inv.activityId === 'grocery'
                          ? 'البقالة'
                          : inv.activityId === 'bike_parts'
                          ? 'قطع الدراجات'
                          : 'قطع المعدات'}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <span className="px-2 py-0.5 rounded text-[10px] bg-slate-100 font-semibold text-slate-700">
                          {inv.paymentMethod === 'CASH'
                            ? 'نقداً'
                            : inv.paymentMethod === 'CREDIT'
                            ? 'آجل'
                            : 'تحويل بنكي'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-center font-mono tabular-nums font-bold text-slate-900">
                        {inv.total.toFixed(2)} {currencySymbol}
                      </td>
                      <td className="py-3 px-4 text-center font-mono tabular-nums text-emerald-700 font-semibold">
                        <div>{inv.paidAmount.toFixed(2)} {currencySymbol}</div>
                        {(inv.advanceAppliedAmount || 0) > 0 && (
                          <div className="text-[10px] text-indigo-700">
                            {isReturn ? 'سلفة: ' : 'مقدم: '}
                            {Number(inv.advanceAppliedAmount).toFixed(2)}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-center font-mono tabular-nums text-rose-700 font-bold">
                        {openRemaining.toFixed(2)} {currencySymbol}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <div className="flex items-center justify-center gap-1.5 flex-wrap">
                          <button
                            type="button"
                            onClick={() => setPrintableInvoice(inv)}
                            className="p-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded transition-colors"
                            title="طباعة وتصدير PDF"
                          >
                            <Printer className="w-3.5 h-3.5" />
                          </button>
                          {!isReturn && inv.status !== 'REVERSED' && canReturnPurchase && (
                            <button
                              type="button"
                              onClick={() => openPurchaseReturnModal(inv)}
                              className="px-2.5 py-1 bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 rounded font-bold text-[11px] inline-flex items-center gap-1 transition-colors"
                            >
                              <RotateCcw className="w-3 h-3" />
                              <span>مرتجع مشتريات</span>
                            </button>
                          )}
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

      {/* New Purchase Invoice Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto">
          <div className="relative w-full max-w-3xl bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
            <div className="flex items-center justify-between px-6 py-4 bg-slate-900 text-white">
              <h3 className="text-sm font-bold flex items-center gap-2">
                <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
                <span>تسجيل فاتورة شراء بضاعة من مورد</span>
              </h3>
              <button
                onClick={() => setIsAddModalOpen(false)}
                className="text-slate-400 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSavePurchaseInvoice} className="p-6 space-y-4 text-xs">
              {formError && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span className="font-semibold">{formError}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">النشاط المستهدف *</label>
                  <select
                    value={activityId}
                    onChange={(e) => {
                      setActivityId(e.target.value as ActivityId);
                      setItems([]);
                      setFormError(null);
                    }}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none"
                  >
                    {allowedActivityOptions.map((act) => (
                      <option key={act.id} value={act.id}>
                        {act.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">المورد *</label>
                  <select
                    value={supplierId}
                    onChange={(e) => {
                      setSupplierId(e.target.value);
                      setApplyAdvanceInput('');
                      const s = suppliers.find((sup) => sup.id === e.target.value);
                      if (s) setSupplierName(s.nameAr);
                    }}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none"
                  >
                    <option value="">-- اختر مورد مسجل أو اكتب اسمه --</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.nameAr}
                        {(s.advanceBalance || 0) > 0
                          ? ` | سلفة متاحة: ${Number(s.advanceBalance).toFixed(2)}`
                          : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">تاريخ الفاتورة</label>
                  <input
                    type="date"
                    value={invoiceDate}
                    onChange={(e) => setInvoiceDate(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 font-mono focus:outline-none"
                  />
                </div>
              </div>

              {/* Items Entry Bar */}
              <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-900">إضافة أصناف للفاتورة:</span>
                  {activityId === 'pharmacy' && (
                    <span className="text-[11px] font-bold text-rose-700 bg-rose-50 px-2 py-0.5 rounded border border-rose-200">
                      * إلزامي إدخال رقم التشغيلة وتاريخ الانتهاء الساري للأدوية
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                  <div className="sm:col-span-2">
                    <select
                      value={selectedProductId}
                      onChange={(e) => {
                        setSelectedProductId(e.target.value);
                        const p = products.find((prod) => prod.id === e.target.value);
                        if (p) setItemCost(String(p.purchasePrice));
                      }}
                      className="w-full px-3 py-1.5 border border-slate-200 rounded bg-white text-slate-900"
                    >
                      <option value="">-- اختر الصنف من المستودع --</option>
                      {products
                        .filter((p) => p.isActive !== false)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.nameAr} ({p.code})
                          </option>
                        ))}
                    </select>
                  </div>

                  <div>
                    <input
                      type="number"
                      min="1"
                      value={itemQty}
                      onChange={(e) => setItemQty(e.target.value)}
                      placeholder="الكمية"
                      className="w-full px-3 py-1.5 border border-slate-200 rounded bg-white font-mono text-center"
                    />
                  </div>

                  <div>
                    <input
                      type="number"
                      step="any"
                      value={itemCost}
                      onChange={(e) => setItemCost(e.target.value)}
                      placeholder="سعر التكلفة"
                      className="w-full px-3 py-1.5 border border-slate-200 rounded bg-white font-mono text-center"
                    />
                  </div>
                </div>

                {activityId === 'pharmacy' && (
                  <div className="p-2.5 bg-emerald-50 rounded-lg border border-emerald-300 space-y-1.5 pt-2">
                    <div className="flex items-center justify-between text-[11px] font-bold text-emerald-950">
                      <span className="flex items-center gap-1">
                        <AlertCircle className="w-3.5 h-3.5 text-rose-600 inline" />
                        بيانات التشغيلة والصلاحية للدواء (FEFO)
                      </span>
                      <span className="text-[10px] text-rose-700 bg-rose-50 px-2 py-0.5 rounded border border-rose-200">
                        * كلاهما إجباري
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <input
                          type="text"
                          required
                          value={itemBatch}
                          onChange={(e) => setItemBatch(e.target.value)}
                          placeholder="رقم التشغيلة (Batch #) *"
                          className="w-full px-3 py-1.5 border border-emerald-400 rounded bg-white font-mono text-slate-900 text-xs focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <input
                          type="date"
                          required
                          min={formatLocalDate()}
                          value={itemExpiry}
                          onChange={(e) => setItemExpiry(e.target.value)}
                          className="w-full px-3 py-1.5 border border-emerald-400 rounded bg-white font-mono text-slate-900 text-xs focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {activityId === 'grocery' && (
                  <div className="p-2 bg-amber-50/60 rounded-lg border border-amber-200 space-y-1 pt-1.5">
                    <div className="text-[11px] font-semibold text-amber-900">
                      بيانات التشغيلة والصلاحية للمادة الغذائية (اختياري)
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <input
                          type="text"
                          value={itemBatch}
                          onChange={(e) => setItemBatch(e.target.value)}
                          placeholder="رقم التشغيلة (إن وجد)"
                          className="w-full px-3 py-1.5 border border-amber-200 rounded bg-white font-mono text-slate-900 text-xs"
                        />
                      </div>
                      <div>
                        <input
                          type="date"
                          value={itemExpiry}
                          onChange={(e) => setItemExpiry(e.target.value)}
                          className="w-full px-3 py-1.5 border border-amber-200 rounded bg-white font-mono text-slate-900 text-xs"
                        />
                      </div>
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleAddItemToInvoice}
                  disabled={!selectedProductId}
                  className={`w-full py-1.5 rounded font-bold text-xs flex items-center justify-center gap-1.5 ${
                    !selectedProductId
                      ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                      : 'bg-emerald-600 hover:bg-emerald-700 text-white'
                  }`}
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>إدراج الصنف في الفاتورة</span>
                </button>
              </div>

              {/* Items List Table */}
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-right text-xs">
                  <thead className="bg-slate-100 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="py-2 px-3">الصنف</th>
                      <th className="py-2 px-3 text-center">الكمية</th>
                      <th className="py-2 px-3 text-center">سعر الوحدة</th>
                      <th className="py-2 px-3 text-center">الإجمالي</th>
                      <th className="py-2 px-3 text-center">حذف</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map((item, i) => (
                      <tr key={i}>
                        <td className="py-2 px-3">
                          <div className="font-bold">{item.productName}</div>
                          {item.batchNumber && (
                            <div className="text-[10px] text-slate-500 font-mono">
                              تشغيلة: {item.batchNumber} {item.expiryDate ? `| انتهاء: ${item.expiryDate}` : ''}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-3 text-center font-mono font-bold">
                          {item.quantity} {item.unit}
                        </td>
                        <td className="py-2 px-3 text-center font-mono">{item.costPrice.toFixed(2)}</td>
                        <td className="py-2 px-3 text-center font-mono font-bold text-slate-900">
                          {(item.quantity * item.costPrice).toFixed(2)} {currencySymbol}
                        </td>
                        <td className="py-2 px-3 text-center">
                          <button
                            type="button"
                            onClick={() => handleRemoveItem(i)}
                            className="text-rose-600 hover:text-rose-800"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Supplier Advance Settlement (1105) */}
              {selectedSupplierObj && availableSupplierAdvance > 0 && canUseAdvance && totalInvoice > 0 && (
                <div className="p-3 bg-indigo-50/80 border border-indigo-200 rounded-lg space-y-2 text-indigo-950">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold">
                      رصيد سلفة مورد متاح (1105):{' '}
                      <span className="font-mono">
                        {availableSupplierAdvance.toFixed(2)} {currencySymbol}
                      </span>
                    </span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-semibold">خصم من السلفة:</span>
                      <input
                        type="number"
                        min="0"
                        max={maxApplicableAdvance}
                        step="any"
                        value={applyAdvanceInput}
                        onChange={(e) => setApplyAdvanceInput(e.target.value)}
                        placeholder="0.00"
                        className="w-24 px-2 py-1 text-left font-mono bg-white border border-indigo-300 rounded text-xs font-bold text-indigo-900 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setApplyAdvanceInput(String(maxApplicableAdvance))}
                        className="px-2 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-[10px] font-bold"
                      >
                        الحد الأقصى
                      </button>
                    </div>
                  </div>
                  {appliedAdvanceAmount > 0 && (
                    <div className="text-[11px] font-bold text-indigo-800">
                      الصافي المطلوب سداده بعد خصم السلفة:{' '}
                      <span className="font-mono">
                        {netAfterAdvance.toFixed(2)} {currencySymbol}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Payment Details */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-slate-200">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">طريقة السداد</label>
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                    className="w-full px-3 py-1.5 border border-slate-200 rounded"
                  >
                    <option value="CASH">نقداً من الخزينة</option>
                    <option value="CREDIT">آجل (ذمم على الحساب)</option>
                    <option value="BANK_TRANSFER">تحويل بنكي</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">الخزينة المنفق منها</label>
                  <select
                    value={cashBoxId}
                    onChange={(e) => setCashBoxId(e.target.value)}
                    className="w-full px-3 py-1.5 border border-slate-200 rounded"
                  >
                    {cashBoxes.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.nameAr}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">المبلغ المسدد نقداً</label>
                  <input
                    type="number"
                    step="any"
                    max={netAfterAdvance}
                    value={paymentMethod === 'CREDIT' ? paidAmountInput : netAfterAdvance}
                    disabled={paymentMethod !== 'CREDIT'}
                    onChange={(e) => setPaidAmountInput(e.target.value)}
                    className="w-full px-3 py-1.5 border border-slate-200 rounded font-mono font-bold"
                  />
                </div>
              </div>

              {paymentMethod === 'CREDIT' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">تاريخ الاستحقاق (اختياري للآجل)</label>
                    <input
                      type="date"
                      value={dueDate}
                      onChange={(e) => setDueDate(e.target.value)}
                      className="w-full px-3 py-1.5 border border-slate-200 rounded font-mono"
                    />
                  </div>
                  <div className="flex items-end pb-1 text-xs font-bold text-rose-700">
                    المتبقي ذمة للمورد:{' '}
                    <span className="font-mono mr-1">
                      {remainingCreditPayable.toFixed(2)} {currencySymbol}
                    </span>
                  </div>
                </div>
              )}

              <div className="flex justify-between items-center pt-3 border-t border-slate-200">
                <div className="text-sm font-extrabold text-slate-900">
                  إجمالي الفاتورة: <span className="text-emerald-700 font-mono">{totalInvoice.toFixed(2)} {currencySymbol}</span>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setIsAddModalOpen(false)}
                    className="px-4 py-2 border border-slate-200 rounded-lg hover:bg-slate-50"
                  >
                    إلغاء
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-bold rounded-lg flex items-center gap-1.5"
                  >
                    <Check className="w-4 h-4" />
                    <span>{isSubmitting ? 'جارٍ الترحيل...' : 'حفظ وترحيل الفاتورة'}</span>
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Purchase Return Modal */}
      {returnSourceInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto">
          <div className="relative w-full max-w-2xl bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200 my-6">
            <div className="flex items-center justify-between px-6 py-4 bg-amber-900 text-white">
              <div className="flex items-center gap-2">
                <RotateCcw className="w-4 h-4 text-amber-300" />
                <h3 className="text-sm font-bold">
                  إصدار مرتجع مشتريات للفاتورة ({returnSourceInvoice.invoiceNumber})
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setReturnSourceInvoice(null)}
                className="text-amber-200 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmitPurchaseReturn} className="p-6 space-y-4 text-xs max-h-[82vh] overflow-y-auto">
              {returnError && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span className="font-semibold">{returnError}</span>
                </div>
              )}

              <div className="grid grid-cols-3 gap-2 bg-slate-50 p-3 rounded-lg border border-slate-200">
                <div>
                  <div className="text-[10px] text-slate-500">المورد</div>
                  <div className="font-bold text-slate-900">{returnSourceInvoice.partyName}</div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-500">إجمالي الفاتورة / المسدد</div>
                  <div className="font-mono font-bold text-slate-900">
                    {returnSourceInvoice.total.toFixed(2)} / {returnSourceInvoice.paidAmount.toFixed(2)} {currencySymbol}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-500">المتبقي المفتوح</div>
                  <div className="font-mono font-bold text-amber-800">
                    {Math.max(0, roundMoney(returnSourceInvoice.total - returnSourceInvoice.paidAmount - (returnSourceInvoice.returnedAmount || 0))).toFixed(2)} {currencySymbol}
                  </div>
                </div>
              </div>

              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <div className="bg-slate-100 px-3 py-2 font-bold text-slate-800">
                  تحديد الكميات المرتجعة للمورد
                </div>
                <table className="w-full text-right text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="py-2 px-3">الصنف</th>
                      <th className="py-2 px-3 text-center">المشترى</th>
                      <th className="py-2 px-3 text-center">مرتجع سابق</th>
                      <th className="py-2 px-3 text-center">المتاح للإرجاع</th>
                      <th className="py-2 px-3 text-center">الكمية المرتجعة</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {purchaseReturnableLines.map((line) => (
                      <tr key={line.key}>
                        <td className="py-2 px-3">
                          <div className="font-bold text-slate-900">{line.productName}</div>
                          {line.batchNumber && (
                            <div className="text-[10px] font-mono text-slate-500">تشغيلة: {line.batchNumber}</div>
                          )}
                        </td>
                        <td className="py-2 px-3 text-center font-mono">
                          {line.purchasedQty} {line.unit}
                        </td>
                        <td className="py-2 px-3 text-center font-mono text-slate-500">
                          {line.alreadyReturned}
                        </td>
                        <td className="py-2 px-3 text-center font-mono font-bold text-emerald-700">
                          {line.remainingQty}
                        </td>
                        <td className="py-2 px-3 text-center">
                          <input
                            type="number"
                            min="0"
                            max={line.remainingQty}
                            step="any"
                            disabled={line.remainingQty <= 0}
                            value={returnQuantities[line.key] ?? ''}
                            onChange={(e) =>
                              setReturnQuantities((prev) => ({
                                ...prev,
                                [line.key]: e.target.value,
                              }))
                            }
                            placeholder="0"
                            className="w-20 px-2 py-1 border border-slate-300 rounded font-mono text-center bg-white"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">طريقة تسوية قيمة المرتجع *</label>
                  <select
                    value={returnRefundMethod}
                    onChange={(e) =>
                      setReturnRefundMethod(e.target.value as 'AUTO' | 'AP_OFFSET' | 'CASH' | 'ADVANCE')
                    }
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg bg-white text-slate-900"
                  >
                    <option value="AUTO">تلقائي (تخفيض ذمة المورد ثم استرداد الفائض)</option>
                    <option value="AP_OFFSET">تخفيض ذمة المورد الآجلة فقط (2101)</option>
                    <option value="CASH">استرداد نقدي إلى الصندوق</option>
                    <option value="ADVANCE">إثبات رصيد سلفة لدى المورد (1105)</option>
                  </select>
                </div>

                {(returnRefundMethod === 'AUTO' || returnRefundMethod === 'CASH') && (
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">الصندوق المستلم للنقد</label>
                    <select
                      value={returnCashBoxId}
                      onChange={(e) => setReturnCashBoxId(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg bg-white text-slate-900"
                    >
                      {cashBoxes.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.nameAr} ({b.balance.toFixed(2)} {currencySymbol})
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">سبب المرتجع (إلزامي لسجل التدقيق) *</label>
                <input
                  type="text"
                  required
                  value={returnReason}
                  onChange={(e) => setReturnReason(e.target.value)}
                  placeholder="مثال: بضاعة غير مطابقة للمواصفات / قرب انتهاء الصلاحية..."
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setReturnSourceInvoice(null)}
                  className="px-4 py-2 border border-slate-200 rounded-lg hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 bg-amber-600 hover:bg-amber-700 disabled:bg-slate-300 text-white font-bold rounded-lg flex items-center gap-1.5"
                >
                  <Check className="w-4 h-4" />
                  <span>{isSubmitting ? 'جارٍ الترحيل...' : 'اعتماد وترحيل مرتجع المشتريات'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ReceiptModal
        invoice={printableInvoice}
        defaultSize="A4"
        onClose={() => setPrintableInvoice(null)}
      />
    </div>
  );
};
