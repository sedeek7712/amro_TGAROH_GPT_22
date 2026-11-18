/**
 * إدارة المشتريات وفواتير الموردين (Purchases Management)
 * تسجيل فواتير الشراء، تحديث المخزون والتشغيلات، وتوليد القيود المحاسبية آلياً
 */

import React, { useState } from 'react';
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
} from 'lucide-react';
import { storage } from '../../services/storageService';
import { inventory } from '../../services/inventoryService';
import { accounting } from '../../services/accountingEngine';
import { dexieDataService } from '../../services/dexieDataService';
import { useLiveInvoices, useLiveParties, useLiveCashBoxes, useLiveProducts } from '../../hooks/useLiveDexie';
import { Invoice, InvoiceItem, ActivityId, PaymentMethod } from '../../types/erp';

interface PurchasesManagerProps {
  onRefresh: () => void;
}

export const PurchasesManager: React.FC<PurchasesManagerProps> = ({ onRefresh }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // حقول نموذج فاتورة الشراء
  const [activityId, setActivityId] = useState<ActivityId>('pharmacy');
  const [supplierId, setSupplierId] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CASH');
  const [cashBoxId, setCashBoxId] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().split('T')[0]);
  const [paidAmountInput, setPaidAmountInput] = useState('');
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

  const allInvoices = useLiveInvoices();
  const invoices = allInvoices.filter((inv) => inv.type === 'PURCHASE');
  const suppliers = useLiveParties('SUPPLIER');
  const cashBoxes = useLiveCashBoxes();
  const products = useLiveProducts(activityId);

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
    const todayStr = new Date().toISOString().split('T')[0];

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

  const totalInvoice = items.reduce((sum, item) => sum + item.quantity * item.costPrice, 0);

  const handleSavePurchaseInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (items.length === 0) {
      setFormError('يجب إضافة صنف واحد على الأقل لفاتورة المشتريات.');
      return;
    }

    // تدقيق إضافي صارم لكافة بنود الأدوية بالصيدلية
    if (activityId === 'pharmacy') {
      const todayStr = new Date().toISOString().split('T')[0];
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

    const activeBranch = storage.getActiveBranch();
    const invoiceNumber = storage.generateBranchInvoiceNumber('PUR', activeBranch.code, storage.getTerminalCode());
    const selectedSupplier = suppliers.find((s) => s.id === supplierId);
    const finalPartyName = selectedSupplier ? selectedSupplier.nameAr : supplierName || 'مورد عام';

    const actualPaid =
      paymentMethod === 'CREDIT' ? Number(paidAmountInput) || 0 : totalInvoice;

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
      total: item.quantity * item.costPrice,
      batchNumber: item.batchNumber,
      expiryDate: item.expiryDate,
    }));

    // 2. إنشاء كائن الفاتورة
    const newInvoice: Invoice = {
      id: storage.generateUUID(),
      invoiceNumber,
      type: 'PURCHASE',
      activityId,
      branchId: activeBranch.id,
      partyId: supplierId || undefined,
      partyName: finalPartyName,
      date: invoiceDate,
      items: invoiceItems,
      subtotal: totalInvoice,
      discount: 0,
      tax: 0,
      total: totalInvoice,
      paidAmount: actualPaid,
      paymentMethod,
      cashBoxId: cashBoxId || cashBoxes[0]?.id || 'cb-1',
    };

    try {
      // 3. التنفيذ الذري المركب عبر DexieDataService (تحديث المخزون والتشغيلات والقيد المزدوج)
      await dexieDataService.createPurchaseInvoiceAtomic({
        invoice: newInvoice,
        itemsWithBatches: items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          costPrice: item.costPrice,
          batchNumber: item.batchNumber,
          expiryDate: item.expiryDate,
        })),
      });

      setIsAddModalOpen(false);
      setItems([]);
      setFormError(null);
      onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'حدث خطأ أثناء حفظ فاتورة المشتريات.';
      setFormError(msg);
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
                <th className="py-3 px-4 text-center">المدفوع</th>
                <th className="py-3 px-4 text-center">المتبقي آجل</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredInvoices.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-400">
                    <FileSpreadsheet className="w-8 h-8 mx-auto mb-2 text-slate-300 stroke-1" />
                    <p className="font-medium">لا توجد فواتير مشتريات مسجلة بعد</p>
                    <p className="text-[11px] text-slate-400 mt-1">اضغط على زر «تسجيل فاتورة شراء جديدة» لإدخال بضاعة للمستودع</p>
                  </td>
                </tr>
              ) : (
                filteredInvoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3 px-4 font-mono font-bold text-slate-900">{inv.invoiceNumber}</td>
                    <td className="py-3 px-4 font-mono text-slate-600">{inv.date}</td>
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
                      {inv.total.toFixed(2)} ر.س
                    </td>
                    <td className="py-3 px-4 text-center font-mono tabular-nums text-emerald-700 font-semibold">
                      {inv.paidAmount.toFixed(2)} ر.س
                    </td>
                    <td className="py-3 px-4 text-center font-mono tabular-nums text-rose-700 font-bold">
                      {(inv.total - inv.paidAmount).toFixed(2)} ر.س
                    </td>
                  </tr>
                ))
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
                    <option value="pharmacy">الصيدلية</option>
                    <option value="grocery">المواد الغذائية والبقالة</option>
                    <option value="bike_parts">قطع غيار الدراجات</option>
                    <option value="equipment_parts">قطع غيار المعدات</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">المورد *</label>
                  <select
                    value={supplierId}
                    onChange={(e) => {
                      setSupplierId(e.target.value);
                      const s = suppliers.find((sup) => sup.id === e.target.value);
                      if (s) setSupplierName(s.nameAr);
                    }}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none"
                  >
                    <option value="">-- اختر مورد مسجل أو اكتب اسمه --</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.nameAr}
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
                      {products.map((p) => (
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
                          min={new Date().toISOString().split('T')[0]}
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
                          {(item.quantity * item.costPrice).toFixed(2)} ر.س
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
                    value={paymentMethod === 'CREDIT' ? paidAmountInput : totalInvoice}
                    disabled={paymentMethod !== 'CREDIT'}
                    onChange={(e) => setPaidAmountInput(e.target.value)}
                    className="w-full px-3 py-1.5 border border-slate-200 rounded font-mono font-bold"
                  />
                </div>
              </div>

              <div className="flex justify-between items-center pt-3 border-t border-slate-200">
                <div className="text-sm font-extrabold text-slate-900">
                  إجمالي الفاتورة: <span className="text-emerald-700 font-mono">{totalInvoice.toFixed(2)} ر.س</span>
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
                    className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg flex items-center gap-1.5"
                  >
                    <Check className="w-4 h-4" />
                    <span>حفظ وترحيل الفاتورة</span>
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
