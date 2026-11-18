/**
 * نقطة البيع السريعة (Point of Sale - POS)
 * تدعم الأنشطة المتعددة، قارئ الباركود، اختيار التشغيلات، البيع النقدي والآجل
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  Search,
  ShoppingCart,
  Trash2,
  Plus,
  Minus,
  User,
  CreditCard,
  DollarSign,
  Barcode,
  Clock,
  AlertCircle,
  Tag,
  Check,
  Building2,
  X,
} from 'lucide-react';
import { storage } from '../../services/storageService';
import { inventory } from '../../services/inventoryService';
import { accounting } from '../../services/accountingEngine';
import { dexieDataService } from '../../services/dexieDataService';
import { useLiveProducts, useLiveParties, useLiveCashBoxes } from '../../hooks/useLiveDexie';
import { Product, ProductBatch, ActivityId, Invoice, InvoiceItem, PaymentMethod } from '../../types/erp';
import { ReceiptModal } from '../common/ReceiptModal';

interface POSProps {
  selectedActivity: ActivityId | 'all';
  setSelectedActivity: (activity: ActivityId | 'all') => void;
  onRefresh: () => void;
}

interface CartItem extends InvoiceItem {
  maxStock: number;
  availableBatches?: ProductBatch[];
}

export const PointOfSale: React.FC<POSProps> = ({
  selectedActivity,
  setSelectedActivity,
  onRefresh,
}) => {
  // النشاط الحالي للبيع (إذا كان all نحدد أول نشاط تجاري)
  const [currentActivity, setCurrentActivity] = useState<ActivityId>(
    selectedActivity === 'all' ? 'pharmacy' : selectedActivity
  );

  useEffect(() => {
    if (selectedActivity !== 'all') {
      setCurrentActivity(selectedActivity);
    }
  }, [selectedActivity]);

  const [searchQuery, setSearchQuery] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [customCustomerName, setCustomCustomerName] = useState<string>('عميل نقدي عام');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CASH');
  const [discountAmount, setDiscountAmount] = useState<number>(0);
  const [selectedCashBoxId, setSelectedCashBoxId] = useState<string>(
    () => storage.getCashBoxes()[0]?.id || ''
  );
  const [paidAmountInput, setPaidAmountInput] = useState<string>('');
  const [invoiceNotes, setInvoiceNotes] = useState<string>('');
  const [completedInvoice, setCompletedInvoice] = useState<Invoice | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [batchPickerProduct, setBatchPickerProduct] = useState<Product | null>(null);
  const [mobileTab, setMobileTab] = useState<'catalog' | 'cart'>('catalog');

  const searchInputRef = useRef<HTMLInputElement>(null);

  const products = useLiveProducts(currentActivity);
  const customers = useLiveParties('CUSTOMER');
  const cashBoxes = useLiveCashBoxes();
  const currentCashBox = cashBoxes.find((b) => b.id === selectedCashBoxId) || cashBoxes[0];

  // تصفية المنتجات حسب البحث
  const filteredProducts = products.filter((p) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      p.nameAr.toLowerCase().includes(q) ||
      p.code.toLowerCase().includes(q) ||
      (p.barcode && p.barcode.toLowerCase().includes(q)) ||
      (p.oemNumber && p.oemNumber.toLowerCase().includes(q))
    );
  });

  // إضافة صنف للسلة
  const addToCart = (product: Product, batch?: ProductBatch) => {
    if (product.currentStock <= 0) {
      setErrorMessage(`الصنف (${product.nameAr}) رصيده نافد بالمستودع.`);
      return;
    }

    setErrorMessage(null);

    setCart((prevCart) => {
      const existingIndex = prevCart.findIndex(
        (item) => item.productId === product.id && item.batchNumber === (batch ? batch.batchNumber : undefined)
      );

      if (existingIndex !== -1) {
        const item = prevCart[existingIndex];
        const newQty = item.quantity + 1;
        if (newQty > item.maxStock) {
          setErrorMessage(`الكمية القصوى المتاحة هي ${item.maxStock}`);
          return prevCart;
        }
        const updated = [...prevCart];
        updated[existingIndex] = {
          ...item,
          quantity: newQty,
          total: Number((newQty * item.unitPrice - item.discount).toFixed(2)),
        };
        return updated;
      }

      if (batch && inventory.isBatchExpired(batch.expiryDate)) {
        setErrorMessage(`محظور بيع التشغيلة (${batch.batchNumber}) لأنها منتهية الصلاحية بتاريخ ${batch.expiryDate}!`);
        return prevCart;
      }

      const availableStock = batch ? batch.quantity : product.currentStock;
      const newItem: CartItem = {
        id: storage.generateUUID(),
        productId: product.id,
        productName: product.nameAr,
        productCode: product.code,
        batchNumber: batch?.batchNumber,
        expiryDate: batch?.expiryDate,
        oemNumber: product.oemNumber,
        unit: product.unit,
        quantity: 1,
        unitPrice: product.sellPrice,
        discount: 0,
        total: product.sellPrice,
        maxStock: availableStock,
        availableBatches: product.batches,
      };

      return [...prevCart, newItem];
    });
  };

  // معالجة الضغط على Enter في حقل الباركود
  const handleBarcodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    // بحث بالمطابقة التامة للباركود أو الكود
    const match = products.find(
      (p) =>
        (p.barcode && p.barcode.toLowerCase() === searchQuery.trim().toLowerCase()) ||
        p.code.toLowerCase() === searchQuery.trim().toLowerCase()
    );

    if (match) {
      addToCart(match);
      setSearchQuery('');
    } else if (filteredProducts.length === 1) {
      addToCart(filteredProducts[0]);
      setSearchQuery('');
    }
  };

  const updateQuantity = (index: number, newQty: number) => {
    setCart((prev) => {
      const updated = [...prev];
      const item = updated[index];
      if (newQty <= 0) {
        return updated.filter((_, i) => i !== index);
      }
      if (newQty > item.maxStock) {
        setErrorMessage(`الكمية المتاحة في المخزن هي ${item.maxStock} فقط.`);
        return prev;
      }
      item.quantity = newQty;
      item.total = Number((newQty * item.unitPrice - item.discount).toFixed(2));
      return updated;
    });
  };

  const removeFromCart = (index: number) => {
    setCart((prev) => prev.filter((_, i) => i !== index));
  };

  // العمليات الحسابية للسلة
  const subtotal = cart.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const total = Math.max(0, Number((subtotal - discountAmount).toFixed(2)));

  // المبلغ المدفوع الافتراضي
  const actualPaidAmount =
    paymentMethod === 'CREDIT'
      ? Math.min(Number(paidAmountInput) || 0, total)
      : total;

  // إتمام البيع وإصدار الفاتورة والترحيل المحاسبي بالمعاملة الذرية
  const handleCheckout = async () => {
    if (cart.length === 0) {
      setErrorMessage('سلة البيع فارغة! يرجى اختيار صنف واحد على الأقل.');
      return;
    }

    if (paymentMethod === 'CREDIT' && !selectedCustomerId) {
      setErrorMessage('يجب تحديد عميل مسجل لإتمام عملية البيع الآجل (ذمم).');
      return;
    }

    setErrorMessage(null);

    // 1. حساب تكلفة البضاعة المباعة التقديرية
    let totalCogs = 0;
    for (const item of cart) {
      const prod = products.find((p) => p.id === item.productId);
      if (prod) {
        if (item.batchNumber && prod.batches) {
          const b = prod.batches.find((batch) => batch.batchNumber === item.batchNumber);
          totalCogs += item.quantity * (b?.costPrice || prod.purchasePrice);
        } else {
          totalCogs += item.quantity * prod.purchasePrice;
        }
      }
    }

    // 2. تجهيز كائن الفاتورة برقم تسلسلي مستقل لكل فرع ونقطة بيع لمنع التصادم
    const activeBranch = storage.getActiveBranch();
    const invNumber = storage.generateBranchInvoiceNumber('INV', activeBranch.code, storage.getTerminalCode());

    const selectedCust = customers.find((c) => c.id === selectedCustomerId);
    const finalPartyName = selectedCust ? selectedCust.nameAr : customCustomerName;

    const newInvoice: Invoice = {
      id: storage.generateUUID(),
      invoiceNumber: invNumber,
      type: 'SALE',
      activityId: currentActivity,
      branchId: activeBranch.id,
      partyId: selectedCustomerId || undefined,
      partyName: finalPartyName,
      date: new Date().toISOString().split('T')[0],
      items: cart,
      subtotal,
      discount: discountAmount,
      tax: 0,
      total,
      paidAmount: actualPaidAmount,
      paymentMethod,
      cashBoxId: selectedCashBoxId || cashBoxes[0]?.id || 'cb-1',
      notes: invoiceNotes,
    };

    try {
      // 3. التنفيذ الذري المركب في IndexedDB عبر DexieDataService
      await dexieDataService.createSalesInvoiceAtomic({
        invoice: newInvoice,
        totalCogs: Number(totalCogs.toFixed(2)),
        stockDeductions: cart.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          batchNumber: item.batchNumber,
        })),
      });

      // 4. فتح نافذة الإيصال وتصفير السلة
      setCompletedInvoice(newInvoice);
      setCart([]);
      setDiscountAmount(0);
      setPaidAmountInput('');
      setInvoiceNotes('');
      onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'حدث خطأ أثناء إتمام عملية البيع.';
      setErrorMessage(msg);
    }
  };

  const activities = [
    { id: 'pharmacy' as ActivityId, name: 'الصيدلية' },
    { id: 'grocery' as ActivityId, name: 'البقالة والأغذية' },
    { id: 'bike_parts' as ActivityId, name: 'قطع غيار الدراجات' },
    { id: 'equipment_parts' as ActivityId, name: 'قطع غيار المعدات' },
  ];

  return (
    <div className="p-2.5 sm:p-4 lg:p-6 h-[calc(100vh-3.5rem)] lg:h-[calc(100vh-4rem)] flex flex-col gap-3 sm:gap-4 max-w-[1600px] mx-auto overflow-hidden relative">
      {/* Activity selector tabs */}
      <div className="flex items-center justify-between bg-white p-2 rounded-xl border border-slate-200 shrink-0 gap-2">
        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
          {activities.map((act) => (
            <button
              key={act.id}
              onClick={() => {
                setCurrentActivity(act.id);
                setSelectedActivity(act.id);
              }}
              className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${
                currentActivity === act.id
                  ? 'bg-slate-900 text-white shadow-sm'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              {act.name}
            </button>
          ))}
        </div>
        <div className="text-xs text-slate-500 font-medium hidden sm:block shrink-0">
          أصناف المستودع: <span className="font-bold text-slate-800">{products.length}</span>
        </div>
      </div>

      {/* Mobile Catalog vs Cart Segmented Switcher (Visible on mobile only) */}
      <div className="lg:hidden flex rounded-lg bg-slate-200 p-1 shrink-0 text-xs font-bold">
        <button
          onClick={() => setMobileTab('catalog')}
          className={`flex-1 py-1.5 rounded-md transition-colors ${
            mobileTab === 'catalog'
              ? 'bg-white text-slate-900 shadow-xs'
              : 'text-slate-600'
          }`}
        >
          الأصناف ({filteredProducts.length})
        </button>
        <button
          onClick={() => setMobileTab('cart')}
          className={`flex-1 py-1.5 rounded-md transition-colors flex items-center justify-center gap-1.5 ${
            mobileTab === 'cart'
              ? 'bg-emerald-600 text-white shadow-xs'
              : 'text-slate-600'
          }`}
        >
          <span>سلة الفاتورة ({cart.length})</span>
          {cart.length > 0 && (
            <span className="font-mono text-[10px] bg-white/20 px-1.5 py-0.5 rounded-full">
              {total.toFixed(2)}
            </span>
          )}
        </button>
      </div>

      {/* Main POS Split Grid */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-3 sm:gap-4 min-h-0 overflow-hidden">
        {/* Products Search & Catalog: 7 Cols (On mobile, visible when tab is catalog) */}
        <div className={`lg:col-span-7 bg-white rounded-xl border border-slate-200 flex-col overflow-hidden shadow-xs ${
          mobileTab === 'catalog' ? 'flex flex-1' : 'hidden lg:flex'
        }`}>
          {/* Search Bar & Barcode Scanner Form */}
          <form onSubmit={handleBarcodeSubmit} className="p-3 border-b border-slate-200 flex gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute right-3 top-3" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="ابحث بالاسم، الباركود، أو رقم القطعة (اضغط Enter للإضافة السريعة)..."
                className="w-full pl-3 pr-9 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <button
              type="submit"
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors shrink-0"
            >
              <Barcode className="w-4 h-4" />
              <span className="hidden sm:inline">مسح / إضافة</span>
            </button>
          </form>

          {/* Products Grid */}
          <div className="flex-1 overflow-y-auto p-3">
            {filteredProducts.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-8 text-slate-400">
                <ShoppingCart className="w-10 h-10 mb-2 stroke-1 text-slate-300" />
                <p className="text-xs font-medium">لا توجد أصناف مطابقة في هذا النشاط</p>
                <p className="text-[11px] text-slate-400 mt-1">
                  يمكنك إضافة أصناف جديدة عبر وحدة «المخزون والأصناف»
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2.5">
                {filteredProducts.map((p) => {
                  const isOutOfStock = p.currentStock <= 0;
                  return (
                    <div
                      key={p.id}
                      onClick={() => {
                        if (isOutOfStock) return;
                        if (p.batches && p.batches.length > 1) {
                          setBatchPickerProduct(p);
                        } else if (p.batches && p.batches.length === 1) {
                          addToCart(p, p.batches[0]);
                        } else {
                          addToCart(p);
                        }
                      }}
                      className={`group p-3 rounded-lg border text-right transition-all flex flex-col justify-between select-none ${
                        isOutOfStock
                          ? 'bg-slate-50 border-slate-200 opacity-60 cursor-not-allowed'
                          : 'bg-white border-slate-200 hover:border-emerald-500 hover:shadow-sm cursor-pointer'
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between text-[10px] text-slate-400 mb-1">
                          <span className="font-mono">{p.code}</span>
                          <span
                            className={`px-1.5 py-0.5 rounded font-mono font-bold ${
                              isOutOfStock
                                ? 'bg-rose-50 text-rose-700'
                                : p.currentStock <= p.minStockAlert
                                ? 'bg-amber-50 text-amber-800'
                                : 'bg-slate-100 text-slate-700'
                            }`}
                          >
                            {p.currentStock} {p.unit}
                          </span>
                        </div>
                        <h4 className="font-bold text-xs text-slate-900 group-hover:text-emerald-700 transition-colors line-clamp-2">
                          {p.nameAr}
                        </h4>

                        {/* Special Details per activity */}
                        {p.oemNumber && (
                          <div className="text-[10px] text-slate-500 mt-1 font-mono truncate">
                            OEM: {p.oemNumber}
                          </div>
                        )}
                        {p.batches && p.batches.length > 0 && (
                          <div className="text-[10px] text-emerald-700 mt-1 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            <span>{p.batches.length} تشغيلة متاحة</span>
                          </div>
                        )}
                      </div>

                      <div className="mt-3 pt-2 border-t border-slate-100 flex items-center justify-between">
                        <span className="font-bold font-mono tabular-nums text-xs text-emerald-800">
                          {p.sellPrice.toFixed(2)} ر.س
                        </span>
                        <div className="w-6 h-6 rounded-md bg-slate-100 group-hover:bg-emerald-600 group-hover:text-white flex items-center justify-center text-slate-600 transition-colors">
                          <Plus className="w-3.5 h-3.5" />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Current Cart & Invoice Checkout: 5 Cols (Visible on mobile when tab is cart) */}
        <div className={`lg:col-span-5 bg-white rounded-xl border border-slate-200 flex-col overflow-hidden shadow-xs ${
          mobileTab === 'cart' ? 'flex flex-1' : 'hidden lg:flex'
        }`}>
          {/* Cart Header */}
          <div className="p-3 bg-slate-900 text-white flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShoppingCart className="w-4 h-4 text-emerald-400" />
              <span className="text-xs font-bold">فاتورة المبيعات الحالية</span>
            </div>
            <span className="text-xs font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300">
              {cart.length} أصناف
            </span>
          </div>

          {/* Customer Selection Bar */}
          <div className="p-3 border-b border-slate-200 bg-slate-50/50 space-y-2 text-xs">
            <div className="flex items-center gap-2">
              <User className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              <select
                value={selectedCustomerId}
                onChange={(e) => {
                  setSelectedCustomerId(e.target.value);
                  const cust = customers.find((c) => c.id === e.target.value);
                  if (cust) setCustomCustomerName(cust.nameAr);
                }}
                className="flex-1 py-1 px-2 bg-white border border-slate-200 rounded text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              >
                <option value="">عميل نقدي عام (افتراضي)</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nameAr} - رصيد: {c.balance.toFixed(2)} ر.س
                  </option>
                ))}
              </select>
            </div>

            {/* Cash Box selector */}
            <div className="flex items-center gap-2">
              <DollarSign className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              <select
                value={selectedCashBoxId}
                onChange={(e) => setSelectedCashBoxId(e.target.value)}
                className="flex-1 py-1 px-2 bg-white border border-slate-200 rounded text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              >
                {cashBoxes.map((b) => (
                  <option key={b.id} value={b.id}>
                    إيداع في: {b.nameAr} ({b.balance.toFixed(2)} ر.س)
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Cart Items List */}
          <div className="flex-1 overflow-y-auto p-3 divide-y divide-slate-100">
            {cart.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400">
                <p className="text-xs">السلة فارغة، اختر أصنافاً من القائمة أو امسح الباركود</p>
              </div>
            ) : (
              cart.map((item, index) => (
                <div key={item.id} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-slate-900 truncate">{item.productName}</div>
                    <div className="text-[11px] text-slate-500 font-mono">
                      {item.unitPrice.toFixed(2)} ر.س / {item.unit}
                      {item.batchNumber && (
                        <span className="text-emerald-700 mr-1.5 font-sans">
                          (تشغيلة: {item.batchNumber})
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Quantity Controller */}
                  <div className="flex items-center gap-1.5 shrink-0 bg-slate-100 p-1 rounded-lg">
                    <button
                      onClick={() => updateQuantity(index, item.quantity - 1)}
                      className="w-5 h-5 rounded bg-white hover:bg-slate-200 flex items-center justify-center text-slate-700 transition-colors"
                    >
                      <Minus className="w-3 h-3" />
                    </button>
                    <span className="font-mono font-bold w-7 text-center">{item.quantity}</span>
                    <button
                      onClick={() => updateQuantity(index, item.quantity + 1)}
                      className="w-5 h-5 rounded bg-white hover:bg-slate-200 flex items-center justify-center text-slate-700 transition-colors"
                    >
                      <Plus className="w-3 h-3" />
                    </button>
                  </div>

                  {/* Total item amount */}
                  <div className="w-16 text-left font-mono tabular-nums font-bold text-slate-900 shrink-0">
                    {item.total.toFixed(2)}
                  </div>

                  <button
                    onClick={() => removeFromCart(index)}
                    className="p-1 text-slate-400 hover:text-rose-600 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Error Message */}
          {errorMessage && (
            <div className="p-2.5 mx-3 mb-2 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Checkout Panel */}
          <div className="p-3 border-t border-slate-200 bg-slate-50 space-y-2 text-xs">
            {/* Payment Method Selector */}
            <div className="grid grid-cols-3 gap-1.5">
              <button
                type="button"
                onClick={() => setPaymentMethod('CASH')}
                className={`py-1.5 text-center rounded-lg font-bold transition-all ${
                  paymentMethod === 'CASH'
                    ? 'bg-emerald-600 text-white shadow-sm'
                    : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                }`}
              >
                نقداً
              </button>
              <button
                type="button"
                onClick={() => setPaymentMethod('CREDIT')}
                className={`py-1.5 text-center rounded-lg font-bold transition-all ${
                  paymentMethod === 'CREDIT'
                    ? 'bg-amber-600 text-white shadow-sm'
                    : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                }`}
              >
                آجل (ذمم)
              </button>
              <button
                type="button"
                onClick={() => setPaymentMethod('BANK_TRANSFER')}
                className={`py-1.5 text-center rounded-lg font-bold transition-all ${
                  paymentMethod === 'BANK_TRANSFER'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                }`}
              >
                تحويل بنكي
              </button>
            </div>

            {/* Calculations Row */}
            <div className="space-y-1 pt-1 border-t border-slate-200 text-slate-600">
              <div className="flex justify-between">
                <span>المجموع:</span>
                <span className="font-mono tabular-nums">{subtotal.toFixed(2)} ر.س</span>
              </div>
              <div className="flex justify-between items-center">
                <span>الخصم الممنوح:</span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={discountAmount || ''}
                  onChange={(e) => setDiscountAmount(Math.max(0, Number(e.target.value) || 0))}
                  placeholder="0.00"
                  className="w-20 px-2 py-0.5 text-left font-mono bg-white border border-slate-200 rounded text-xs text-rose-700 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>
              <div className="flex justify-between text-sm font-extrabold text-slate-900 pt-1 border-t border-slate-200">
                <span>الصافي المطلوب:</span>
                <span className="font-mono tabular-nums text-emerald-800">{total.toFixed(2)} ر.س</span>
              </div>

              {/* In Credit payment: Paid amount input */}
              {paymentMethod === 'CREDIT' && (
                <div className="flex justify-between items-center text-amber-800 pt-1">
                  <span>المبلغ المسدد الآن:</span>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={paidAmountInput}
                    onChange={(e) => setPaidAmountInput(e.target.value)}
                    placeholder="0.00"
                    className="w-24 px-2 py-0.5 text-left font-mono bg-white border border-amber-300 rounded text-xs font-bold text-amber-900 focus:outline-none"
                  />
                </div>
              )}
            </div>

            {/* Checkout Action Button */}
            <button
              onClick={handleCheckout}
              disabled={cart.length === 0}
              className={`w-full py-2.5 rounded-lg text-xs font-extrabold flex items-center justify-center gap-2 shadow-sm transition-all ${
                cart.length === 0
                  ? 'bg-slate-300 text-slate-500 cursor-not-allowed'
                  : 'bg-emerald-600 hover:bg-emerald-700 text-white'
              }`}
            >
              <Check className="w-4 h-4" />
              <span>إتمام البيع وحفظ الفاتورة ({total.toFixed(2)} ر.س)</span>
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Floating Cart Summary Button */}
      {cart.length > 0 && mobileTab === 'catalog' && (
        <div className="lg:hidden fixed bottom-18 inset-x-3 z-20">
          <button
            onClick={() => setMobileTab('cart')}
            className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3 px-4 rounded-xl shadow-xl flex items-center justify-between transition-transform active:scale-98"
          >
            <div className="flex items-center gap-2">
              <ShoppingCart className="w-5 h-5" />
              <span>عرض السلة ({cart.length} أصناف)</span>
            </div>
            <div className="font-mono tabular-nums text-sm bg-emerald-800/60 px-2.5 py-1 rounded-lg">
              {total.toFixed(2)} ر.س
            </div>
          </button>
        </div>
      )}

      {/* Batch Picker Modal */}
      {batchPickerProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="relative w-full max-w-md bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
            <div className="flex items-center justify-between px-5 py-3.5 bg-slate-900 text-white">
              <div>
                <h3 className="text-xs font-bold">{batchPickerProduct.nameAr}</h3>
                <p className="text-[10px] text-slate-400">اختر التشغيلة المطلوبة للبيع</p>
              </div>
              <button
                onClick={() => setBatchPickerProduct(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-2 max-h-72 overflow-y-auto text-xs">
              <button
                onClick={() => {
                  addToCart(batchPickerProduct);
                  setBatchPickerProduct(null);
                }}
                className="w-full p-2.5 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg text-emerald-900 font-bold text-right flex items-center justify-between transition-colors"
              >
                <span>صرف تلقائي حسب أقرب انتهاء (نظام FIFO)</span>
                <span className="font-mono text-xs">تلقائي</span>
              </button>

              <div className="text-[11px] font-semibold text-slate-500 pt-1">أو اختر تشغيلة محددة:</div>

              {batchPickerProduct.batches?.map((batch) => {
                const isExpired = inventory.isBatchExpired(batch.expiryDate);
                const isOutOfStock = batch.quantity <= 0;
                return (
                  <div
                    key={batch.id}
                    onClick={() => {
                      if (isExpired || isOutOfStock) return;
                      addToCart(batchPickerProduct, batch);
                      setBatchPickerProduct(null);
                    }}
                    className={`p-2.5 rounded-lg border text-right transition-all ${
                      isExpired
                        ? 'bg-rose-50 border-rose-200 text-rose-900 cursor-not-allowed opacity-75'
                        : isOutOfStock
                        ? 'bg-slate-50 border-slate-200 opacity-50 cursor-not-allowed'
                        : 'bg-white border-slate-200 hover:border-emerald-500 hover:bg-emerald-50/30 cursor-pointer'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-mono font-bold text-slate-900">تشغيلة: {batch.batchNumber}</div>
                        <div className="text-[10px] font-mono">
                          انتهاء: {batch.expiryDate}{' '}
                          {isExpired && <span className="font-bold text-rose-700 font-sans mr-1">(منتهية الصلاحية - محظور البيع)</span>}
                        </div>
                      </div>
                      <div className="text-left font-mono font-bold text-emerald-800">
                        {batch.quantity} {batchPickerProduct.unit}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Invoice Printable Receipt Modal */}
      <ReceiptModal
        invoice={completedInvoice}
        activity={storage.getActivities().find((a) => a.id === completedInvoice?.activityId)}
        onClose={() => setCompletedInvoice(null)}
      />
    </div>
  );
};
