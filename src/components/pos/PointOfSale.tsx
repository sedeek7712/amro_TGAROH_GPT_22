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
  RotateCcw,
} from 'lucide-react';
import { storage, OFFICIAL_ACTIVITIES } from '../../services/storageService';
import { inventory } from '../../services/inventoryService';
import { dataService } from '../../services/dataService';
import { desktopSession } from '../../services/desktopSession';
import { authService } from '../../services/authService';
import { hasPermission, getAuthorizedActivityIds } from '../../config/rbac';
import { getActiveCurrencyConfig, roundMoney } from '../../config/currency';
import { useLiveProducts, useLiveParties, useLiveCashBoxes, useLiveInvoices } from '../../hooks/useLiveDexie';
import { Product, ProductBatch, Party, ActivityId, Invoice, InvoiceItem, PaymentMethod } from '../../types/erp';
import { ReceiptModal } from '../common/ReceiptModal';
import { ProductPrimaryImage } from '../inventory/ProductPrimaryImage';
import { formatLocalDate } from '../../utils/localDate';
import { searchCustomers } from '../../utils/customerSearch';

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
  const isDesktop = typeof window !== 'undefined' && Boolean(window.amroDesktop);
  const actor =
    authService.getCurrentActorSync() || (isDesktop ? null : storage.getCurrentUser());
  const authorizedActivityIds = getAuthorizedActivityIds(actor);
  const isActivityAllowed = (id: ActivityId) =>
    actor?.role === 'ADMIN' || authorizedActivityIds.has(id);
  const firstAllowedActivity: ActivityId =
    (['pharmacy', 'grocery', 'bike_parts', 'equipment_parts'] as ActivityId[]).find((id) =>
      isActivityAllowed(id)
    ) || 'pharmacy';

  // النشاط الحالي للبيع (إذا كان all نحدد أول نشاط تجاري مصرح به للمستخدم)
  const [currentActivity, setCurrentActivity] = useState<ActivityId>(
    selectedActivity !== 'all' && isActivityAllowed(selectedActivity)
      ? selectedActivity
      : firstAllowedActivity
  );

  useEffect(() => {
    if (selectedActivity !== 'all' && isActivityAllowed(selectedActivity)) {
      setCurrentActivity(selectedActivity);
    } else if (!isActivityAllowed(currentActivity)) {
      setCurrentActivity(firstAllowedActivity);
    }
  }, [selectedActivity, firstAllowedActivity]);

  const [searchQuery, setSearchQuery] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [customCustomerName, setCustomCustomerName] = useState<string>('عميل نقدي عام');
  const [customerSearchQuery, setCustomerSearchQuery] = useState('');
  const [isCustomerSearchOpen, setIsCustomerSearchOpen] = useState(false);
  const [isAddCustomerModalOpen, setIsAddCustomerModalOpen] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [newCustomerAddress, setNewCustomerAddress] = useState('');
  const [newCustomerError, setNewCustomerError] = useState<string | null>(null);
  const [isSavingNewCustomer, setIsSavingNewCustomer] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CASH');
  const [discountAmount, setDiscountAmount] = useState<number>(0);
  const [selectedCashBoxId, setSelectedCashBoxId] = useState<string>(() =>
    typeof window !== 'undefined' && window.amroDesktop ? '' : storage.getCashBoxes()[0]?.id || ''
  );
  const [paidAmountInput, setPaidAmountInput] = useState<string>('');
  const [applyAdvanceInput, setApplyAdvanceInput] = useState<string>('');
  const [dueDate, setDueDate] = useState<string>('');
  const [invoiceNotes, setInvoiceNotes] = useState<string>('');
  const [completedInvoice, setCompletedInvoice] = useState<Invoice | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [batchPickerProduct, setBatchPickerProduct] = useState<Product | null>(null);
  const [mobileTab, setMobileTab] = useState<'catalog' | 'cart'>('catalog');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [clientRequestId, setClientRequestId] = useState<string>(() => storage.generateUUID());

  // حالة نافذة مرتجع المبيعات
  const [isReturnModalOpen, setIsReturnModalOpen] = useState(false);
  const [returnSearchQuery, setReturnSearchQuery] = useState('');
  const [selectedReturnInvoiceId, setSelectedReturnInvoiceId] = useState('');
  const [returnQuantities, setReturnQuantities] = useState<Record<string, string>>({});
  const [returnRefundMethod, setReturnRefundMethod] = useState<'AUTO' | 'AR_OFFSET' | 'CASH' | 'ADVANCE'>('AUTO');
  const [returnCashBoxId, setReturnCashBoxId] = useState('');
  const [returnReason, setReturnReason] = useState('');
  const [returnError, setReturnError] = useState<string | null>(null);
  const [returnRequestId, setReturnRequestId] = useState<string>(() => storage.generateUUID());

  const searchInputRef = useRef<HTMLInputElement>(null);

  const canUseAdvance = hasPermission(actor, 'party:advance:use');
  const canCreateCustomer = hasPermission(actor, 'party:create');
  const canReturnSale = hasPermission(actor, 'pos:return');

  const products = useLiveProducts(currentActivity);
  const customers = useLiveParties('CUSTOMER');
  const matchedCustomers = searchCustomers(customers, customerSearchQuery).slice(0, 8);
  const cashBoxes = useLiveCashBoxes();
  const allInvoices = useLiveInvoices('all');
  const currencySymbol = getActiveCurrencyConfig().symbol;

  const defaultCashBoxId =
    cashBoxes.find((b) => !b.isCentral && b.isDefault)?.id ||
    cashBoxes.find((b) => !b.isCentral)?.id ||
    cashBoxes[0]?.id ||
    '';

  useEffect(() => {
    if (!selectedCashBoxId && defaultCashBoxId) {
      setSelectedCashBoxId(defaultCashBoxId);
    }
    if (!returnCashBoxId && defaultCashBoxId) {
      setReturnCashBoxId(defaultCashBoxId);
    }
  }, [defaultCashBoxId, selectedCashBoxId, returnCashBoxId]);

  const activeProducts = products.filter((p) => p.isActive !== false);

  // تصفية المنتجات حسب البحث
  const filteredProducts = activeProducts.filter((p) => {
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
    const match = activeProducts.find(
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

  // العمليات الحسابية للسلة وتطبيق الرصيد المقدم للعميل
  const subtotal = cart.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const total = Math.max(0, roundMoney(subtotal - discountAmount));
  const selectedCustomer = customers.find((c) => c.id === selectedCustomerId);
  const availableAdvanceBalance = selectedCustomer ? roundMoney(selectedCustomer.advanceBalance || 0) : 0;
  const maxApplicableAdvance =
    selectedCustomer && canUseAdvance ? roundMoney(Math.min(availableAdvanceBalance, total)) : 0;
  const appliedAdvanceAmount =
    selectedCustomer && canUseAdvance
      ? roundMoney(Math.min(Math.max(0, Number(applyAdvanceInput) || 0), maxApplicableAdvance))
      : 0;
  const netAfterAdvance = roundMoney(Math.max(0, total - appliedAdvanceAmount));

  // المبلغ النقدي المحصل في الصندوق فعلياً (بدون الرصيد المقدم)
  const actualPaidAmount =
    paymentMethod === 'CREDIT'
      ? roundMoney(Math.min(Math.max(0, Number(paidAmountInput) || 0), netAfterAdvance))
      : netAfterAdvance;
  const remainingCreditAmount = roundMoney(Math.max(0, netAfterAdvance - actualPaidAmount));

  const selectCustomer = (customer: Party | null) => {
    setSelectedCustomerId(customer?.id || '');
    setCustomCustomerName(customer?.nameAr || 'عميل نقدي عام');
    setApplyAdvanceInput('');
    setCustomerSearchQuery('');
    setIsCustomerSearchOpen(false);
  };

  const handleCreateCustomer = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreateCustomer || isSavingNewCustomer) return;
    const nameAr = newCustomerName.trim();
    const phone = newCustomerPhone.trim();
    if (!nameAr || !phone) {
      setNewCustomerError('اسم العميل ورقم الهاتف مطلوبان.');
      return;
    }
    setNewCustomerError(null);
    setIsSavingNewCustomer(true);
    const newParty: Party = {
      id: storage.generateUUID(),
      type: 'CUSTOMER',
      nameAr,
      phone,
      address: newCustomerAddress.trim() || undefined,
      balance: 0,
      advanceBalance: 0,
    };
    try {
      const savedCustomer = await dataService.savePartyAtomic(newParty, false);
      selectCustomer(savedCustomer);
      setIsAddCustomerModalOpen(false);
      onRefresh();
    } catch (error: unknown) {
      setNewCustomerError(error instanceof Error ? error.message : 'تعذر حفظ العميل. حاول مرة أخرى.');
    } finally {
      setIsSavingNewCustomer(false);
    }
  };

  // إتمام البيع وإصدار الفاتورة والترحيل المحاسبي بالمعاملة الذرية
  const handleCheckout = async () => {
    if (isSubmitting) return;
    if (cart.length === 0) {
      setErrorMessage('سلة البيع فارغة! يرجى اختيار صنف واحد على الأقل.');
      return;
    }

    if (paymentMethod === 'CREDIT' && !selectedCustomerId) {
      setErrorMessage('يجب تحديد عميل مسجل لإتمام عملية البيع الآجل (ذمم).');
      return;
    }

    if (appliedAdvanceAmount > 0 && (!selectedCustomerId || !canUseAdvance)) {
      setErrorMessage('استخدام الرصيد المقدم يتطلب تحديد عميل مسجل وتوفر الصلاحية.');
      return;
    }

    setErrorMessage(null);
    setIsSubmitting(true);

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

    const activeBranchId =
      typeof window !== 'undefined' && window.amroDesktop
        ? desktopSession.getActiveBranchId() || 'branch_main'
        : storage.getActiveBranch().id;
    const selectedCust = customers.find((c) => c.id === selectedCustomerId);
    const finalPartyName = selectedCust ? selectedCust.nameAr : customCustomerName;

    const newInvoice: Invoice = {
      id: storage.generateUUID(),
      invoiceNumber: '',
      type: 'SALE',
      activityId: currentActivity,
      branchId: activeBranchId,
      partyId: selectedCustomerId || undefined,
      partyName: finalPartyName,
      date: formatLocalDate(),
      dueDate: paymentMethod === 'CREDIT' && dueDate ? dueDate : undefined,
      items: cart,
      subtotal,
      discount: discountAmount,
      tax: 0,
      total,
      paidAmount: actualPaidAmount,
      paymentMethod,
      cashBoxId: selectedCashBoxId || defaultCashBoxId,
      notes: invoiceNotes,
    };

    try {
      // 3. التنفيذ الذري المركب عبر مزود البيانات الموحد مع ترقيم تسلسلي ومنع تكرار
      const res = await dataService.createSalesInvoiceAtomic({
        invoice: newInvoice,
        totalCogs: Number(totalCogs.toFixed(2)),
        stockDeductions: cart.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          batchNumber: item.batchNumber,
        })),
        applyAdvanceAmount: appliedAdvanceAmount > 0 ? appliedAdvanceAmount : undefined,
        clientRequestId,
      });

      // 4. فتح نافذة الإيصال وتصفير السلة وتدوير معرف الطلب
      setCompletedInvoice(res.invoice);
      setCart([]);
      setDiscountAmount(0);
      setPaidAmountInput('');
      setApplyAdvanceInput('');
      setDueDate('');
      setInvoiceNotes('');
      setClientRequestId(storage.generateUUID());
      onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'حدث خطأ أثناء إتمام عملية البيع.';
      setErrorMessage(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  // تجهيز فواتير المبيعات القابلة للإرجاع والبنود المتبقية
  const saleInvoicesForReturn = allInvoices
    .filter((inv) => inv.type === 'SALE' && inv.status !== 'REVERSED')
    .filter((inv) => {
      if (!returnSearchQuery.trim()) return true;
      const q = returnSearchQuery.toLowerCase();
      return (
        inv.invoiceNumber.toLowerCase().includes(q) ||
        inv.partyName.toLowerCase().includes(q) ||
        inv.date.includes(q)
      );
    });

  const selectedOriginalSale = allInvoices.find((inv) => inv.id === selectedReturnInvoiceId);

  const returnableLines = React.useMemo(() => {
    if (!selectedOriginalSale) return [];
    const priorReturns = allInvoices.filter(
      (i) =>
        i.type === 'RETURN_SALE' &&
        i.originalInvoiceId === selectedOriginalSale.id &&
        i.status !== 'REVERSED'
    );
    const returnedByKey = new Map<string, number>();
    const returnedByProduct = new Map<string, number>();
    for (const r of priorReturns) {
      for (const it of r.items || []) {
        const key = `${it.productId}::${it.batchNumber || ''}`;
        returnedByKey.set(key, roundMoney((returnedByKey.get(key) || 0) + it.quantity, 4));
        returnedByProduct.set(
          it.productId,
          roundMoney((returnedByProduct.get(it.productId) || 0) + it.quantity, 4)
        );
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
        soldQty: number;
        unitPrice: number;
        remainingQty: number;
      }
    >();

    for (const it of selectedOriginalSale.items || []) {
      const key = `${it.productId}::${it.batchNumber || ''}`;
      const prev = grouped.get(key);
      if (prev) {
        prev.soldQty = roundMoney(prev.soldQty + it.quantity, 4);
      } else {
        grouped.set(key, {
          key,
          productId: it.productId,
          productName: it.productName,
          batchNumber: it.batchNumber,
          unit: it.unit,
          soldQty: it.quantity,
          unitPrice: it.unitPrice,
          remainingQty: it.quantity,
        });
      }
    }

    return Array.from(grouped.values()).map((line) => {
      const usedKey = returnedByKey.get(line.key) || 0;
      const usedProd = returnedByProduct.get(line.productId) || 0;
      const alreadyReturned = Math.max(usedKey, line.batchNumber ? usedKey : usedProd);
      return {
        ...line,
        alreadyReturned,
        remainingQty: Math.max(0, roundMoney(line.soldQty - alreadyReturned, 4)),
      };
    });
  }, [selectedOriginalSale, allInvoices]);

  const openSalesReturnModal = () => {
    setReturnSearchQuery('');
    setSelectedReturnInvoiceId('');
    setReturnQuantities({});
    setReturnRefundMethod('AUTO');
    setReturnCashBoxId(defaultCashBoxId);
    setReturnReason('');
    setReturnError(null);
    setReturnRequestId(storage.generateUUID());
    setIsReturnModalOpen(true);
  };

  const handleSubmitSalesReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setReturnError(null);

    if (!selectedOriginalSale) {
      setReturnError('يرجى اختيار فاتورة المبيعات الأصلية أولاً.');
      return;
    }

    if (!returnReason.trim()) {
      setReturnError('يرجى إدخال سبب مرتجع المبيعات لتوثيقه في القيد وسجل التدقيق.');
      return;
    }

    const returnItemsPayload = returnableLines
      .map((line) => ({
        productId: line.productId,
        quantity: roundMoney(Number(returnQuantities[line.key]) || 0, 4),
        batchNumber: line.batchNumber,
        maxQty: line.remainingQty,
        productName: line.productName,
      }))
      .filter((x) => x.quantity > 0);

    if (returnItemsPayload.length === 0) {
      setReturnError('يرجى تحديد كمية أكبر من الصفر لصنف واحد على الأقل.');
      return;
    }

    for (const item of returnItemsPayload) {
      if (item.quantity > item.maxQty + 0.0001) {
        setReturnError(`الكمية المدخلة للصنف (${item.productName}) تتجاوز الكمية المتاحة للإرجاع (${item.maxQty}).`);
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const res = await dataService.createSalesReturnAtomic({
        originalInvoiceId: selectedOriginalSale.id,
        items: returnItemsPayload.map(({ productId, quantity, batchNumber }) => ({
          productId,
          quantity,
          batchNumber,
        })),
        returnReason: returnReason.trim(),
        refundMethod: returnRefundMethod,
        cashBoxId: returnRefundMethod === 'AR_OFFSET' || returnRefundMethod === 'ADVANCE'
          ? undefined
          : returnCashBoxId || defaultCashBoxId || undefined,
        clientRequestId: returnRequestId,
      });

      setIsReturnModalOpen(false);
      setCompletedInvoice(res.invoice);
      setReturnQuantities({});
      setReturnReason('');
      setReturnRequestId(storage.generateUUID());
      onRefresh();
    } catch (err: unknown) {
      setReturnError(err instanceof Error ? err.message : 'تعذر تسجيل مرتجع المبيعات.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const allActivities = [
    { id: 'pharmacy' as ActivityId, name: 'الصيدلية' },
    { id: 'grocery' as ActivityId, name: 'البقالة والأغذية' },
    { id: 'bike_parts' as ActivityId, name: 'قطع غيار الدراجات' },
    { id: 'equipment_parts' as ActivityId, name: 'قطع غيار المعدات' },
  ];
  const activities =
    actor?.role === 'ADMIN'
      ? allActivities
      : allActivities.filter((act) => authorizedActivityIds.has(act.id));

  return (
    <div className="app-pos-workspace p-2.5 sm:p-4 lg:p-6 h-[calc(100dvh-3.5rem)] lg:h-[calc(100dvh-4rem)] min-h-[520px] flex flex-col gap-3 sm:gap-4 max-w-[1600px] mx-auto overflow-hidden relative">
      {/* Activity selector tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between bg-white p-2.5 sm:p-3 rounded-2xl border border-slate-200 shadow-sm shrink-0 gap-2.5">
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar w-full sm:w-auto pb-0.5">
          {activities.map((act) => (
            <button
              key={act.id}
              onClick={() => {
                setCurrentActivity(act.id);
                setSelectedActivity(act.id);
              }}
              className={`px-3.5 sm:px-4 py-2 rounded-xl text-xs font-bold transition-all whitespace-nowrap ${
                currentActivity === act.id
                  ? 'bg-slate-900 text-white shadow-sm'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              {act.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {canReturnSale && (
            <button
              type="button"
              onClick={openSalesReturnModal}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 rounded-lg text-xs font-bold transition-colors whitespace-nowrap"
            >
              <RotateCcw className="w-3.5 h-3.5 text-amber-700" />
              <span>مرتجع مبيعات</span>
            </button>
          )}
          <div className="text-xs text-slate-500 font-medium hidden sm:block shrink-0">
            أصناف المستودع: <span className="font-bold text-slate-800">{activeProducts.length}</span>
          </div>
        </div>
      </div>

      {/* Mobile Catalog vs Cart Segmented Switcher (Visible on mobile only) */}
      <div className="lg:hidden flex rounded-xl bg-slate-100 border border-slate-200 p-1 shrink-0 text-xs font-bold">
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
        <div className={`lg:col-span-7 bg-white rounded-2xl border border-slate-200 flex-col overflow-hidden shadow-sm min-h-0 ${
          mobileTab === 'catalog' ? 'flex flex-1' : 'hidden lg:flex'
        }`}>
          {/* Search Bar & Barcode Scanner Form */}
          <form onSubmit={handleBarcodeSubmit} className="p-3 sm:p-4 border-b border-slate-200 flex gap-2 bg-white">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute right-3 top-3" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="ابحث بالاسم، الباركود، أو رقم القطعة (اضغط Enter للإضافة السريعة)..."
                className="w-full min-w-0 pl-3 pr-9 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
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
          <div className="flex-1 overflow-y-auto p-3 sm:p-4">
            {filteredProducts.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-8 text-slate-400">
                <ShoppingCart className="w-10 h-10 mb-2 stroke-1 text-slate-300" />
                <p className="text-xs font-medium">لا توجد أصناف مطابقة في هذا النشاط</p>
                <p className="text-[11px] text-slate-400 mt-1">
                  يمكنك إضافة أصناف جديدة عبر وحدة «المخزون والأصناف»
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
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
                      className={`group min-w-0 p-3.5 rounded-xl border text-right transition-all flex flex-col justify-between select-none active:scale-[0.99] ${
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
                        <ProductPrimaryImage
                          productId={p.id}
                          productName={p.nameAr}
                          displaySize="pos"
                        />
                        <h4 className="mt-2 font-bold text-xs text-slate-900 group-hover:text-emerald-700 transition-colors line-clamp-2">
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
                          {p.sellPrice.toFixed(2)} {currencySymbol}
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
          <div className="p-3.5 sm:p-4 bg-slate-950 text-white flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShoppingCart className="w-4 h-4 text-emerald-400" />
              <span className="text-xs font-bold">فاتورة المبيعات الحالية</span>
            </div>
            <span className="text-xs font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300">
              {cart.length} أصناف
            </span>
          </div>

          {/* Customer Selection Bar */}
          <div className="p-3.5 sm:p-4 border-b border-slate-200 bg-slate-50 space-y-3 text-xs">
            <div className="flex items-start gap-2">
              <User className="w-3.5 h-3.5 text-slate-500 shrink-0 mt-2" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="relative min-w-0 flex-1">
                    <Search className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
                    <input type="search" value={customerSearchQuery}
                      onFocus={() => setIsCustomerSearchOpen(true)}
                      onChange={(e) => { setCustomerSearchQuery(e.target.value); setIsCustomerSearchOpen(true); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setIsCustomerSearchOpen(false);
                        if (e.key === 'Enter' && matchedCustomers.length === 1) {
                          e.preventDefault();
                          selectCustomer(matchedCustomers[0]);
                        }
                      }}
                      placeholder="ابحث باسم العميل أو رقم الهاتف..."
                      aria-label="البحث عن عميل بالاسم أو رقم الهاتف"
                      className="w-full py-2 pr-8 pl-2 bg-white border border-slate-200 rounded-lg text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
                  </div>
                  {canCreateCustomer && (
                    <button type="button"
                      onClick={() => {
                        setNewCustomerName(''); setNewCustomerPhone(''); setNewCustomerAddress('');
                        setNewCustomerError(null); setIsCustomerSearchOpen(false); setIsAddCustomerModalOpen(true);
                      }}
                      className="shrink-0 inline-flex items-center gap-1 px-2.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold">
                      <Plus className="w-3.5 h-3.5" /><span>إضافة عميل</span>
                    </button>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg">
                  <div className="min-w-0">
                    <span className="text-[10px] text-slate-500 ml-1">العميل المحدد:</span>
                    <span className="font-bold text-slate-800 truncate">{selectedCustomer?.nameAr || customCustomerName}</span>
                    {selectedCustomer?.phone && <span className="block text-[10px] text-slate-500 font-mono" dir="ltr">{selectedCustomer.phone}</span>}
                  </div>
                  {selectedCustomerId && (
                    <button type="button" onClick={() => selectCustomer(null)}
                      className="shrink-0 text-[10px] font-bold text-rose-700 hover:underline">إلغاء التحديد</button>
                  )}
                </div>
                {isCustomerSearchOpen && (
                  <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-sm">
                    <button type="button" onClick={() => selectCustomer(null)}
                      className="w-full px-3 py-2 text-right border-b border-slate-100 hover:bg-slate-50 font-semibold text-slate-700">عميل نقدي عام (افتراضي)</button>
                    {matchedCustomers.length > 0 ? matchedCustomers.map((customer) => (
                      <button type="button" key={customer.id} onClick={() => selectCustomer(customer)}
                        className="w-full px-3 py-2 text-right border-b last:border-b-0 border-slate-100 hover:bg-emerald-50">
                        <span className="flex items-center justify-between gap-2">
                          <span className="font-bold text-slate-800">{customer.nameAr}</span>
                          <span className="text-[10px] text-slate-500 font-mono" dir="ltr">{customer.phone}</span>
                        </span>
                        <span className="flex flex-wrap gap-x-3 mt-1 text-[10px] text-slate-500">
                          <span>الرصيد: {customer.balance.toFixed(2)} {currencySymbol}</span>
                          <span>المقدم: {(customer.advanceBalance || 0).toFixed(2)} {currencySymbol}</span>
                        </span>
                      </button>
                    )) : <div className="px-3 py-3 text-center text-slate-500">لا توجد نتائج مطابقة للبحث.</div>}
                  </div>
                )}
              </div>
            </div>

            {selectedCustomer && availableAdvanceBalance > 0 && (
              <div className="flex items-center justify-between px-2.5 py-1.5 bg-indigo-50 border border-indigo-200 rounded-lg text-[11px] text-indigo-900">
                <span className="font-bold">رصيد مقدم متاح للعميل (2103):</span>
                <span className="font-mono font-extrabold">
                  {availableAdvanceBalance.toFixed(2)} {currencySymbol}
                </span>
              </div>
            )}

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
                    إيداع في: {b.nameAr} ({b.balance.toFixed(2)} {currencySymbol})
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
                      {item.unitPrice.toFixed(2)} {currencySymbol} / {item.unit}
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
          <div className="p-3.5 sm:p-4 border-t border-slate-200 bg-slate-50 space-y-3 text-xs">
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
                <span className="font-mono tabular-nums">{subtotal.toFixed(2)} {currencySymbol}</span>
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
                <span className="font-mono tabular-nums text-emerald-800">{total.toFixed(2)} {currencySymbol}</span>
              </div>

              {/* Customer Advance Settlement (2103 -> 1103) */}
              {selectedCustomer && availableAdvanceBalance > 0 && canUseAdvance && total > 0 && (
                <div className="p-2 bg-indigo-50/70 border border-indigo-200 rounded-lg space-y-1.5 text-indigo-950">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-[11px]">خصم من الرصيد المقدم:</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min="0"
                        max={maxApplicableAdvance}
                        step="any"
                        value={applyAdvanceInput}
                        onChange={(e) => setApplyAdvanceInput(e.target.value)}
                        placeholder="0.00"
                        className="w-20 px-2 py-0.5 text-left font-mono bg-white border border-indigo-300 rounded text-xs font-bold text-indigo-900 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setApplyAdvanceInput(String(maxApplicableAdvance))}
                        className="px-2 py-0.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-[10px] font-bold"
                      >
                        الحد الأقصى
                      </button>
                    </div>
                  </div>
                  {appliedAdvanceAmount > 0 && (
                    <div className="flex justify-between text-[11px] font-bold text-indigo-800">
                      <span>المتبقي بعد تسوية الرصيد المقدم:</span>
                      <span className="font-mono">
                        {netAfterAdvance.toFixed(2)} {currencySymbol}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* In Credit payment: Paid amount & due date */}
              {paymentMethod === 'CREDIT' && (
                <div className="space-y-1.5 pt-1">
                  <div className="flex justify-between items-center text-amber-800">
                    <span>المبلغ النقدي المسدد الآن:</span>
                    <input
                      type="number"
                      min="0"
                      max={netAfterAdvance}
                      step="any"
                      value={paidAmountInput}
                      onChange={(e) => setPaidAmountInput(e.target.value)}
                      placeholder="0.00"
                      className="w-24 px-2 py-0.5 text-left font-mono bg-white border border-amber-300 rounded text-xs font-bold text-amber-900 focus:outline-none"
                    />
                  </div>
                  <div className="flex justify-between items-center text-slate-600">
                    <span>تاريخ الاستحقاق (اختياري):</span>
                    <input
                      type="date"
                      value={dueDate}
                      onChange={(e) => setDueDate(e.target.value)}
                      className="px-2 py-0.5 bg-white border border-slate-300 rounded text-xs font-mono text-slate-900 focus:outline-none"
                    />
                  </div>
                  <div className="flex justify-between text-[11px] font-bold text-rose-700">
                    <span>المتبقي ذمة آجل على العميل:</span>
                    <span className="font-mono">
                      {remainingCreditAmount.toFixed(2)} {currencySymbol}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Checkout Action Button */}
            <button
              onClick={handleCheckout}
              disabled={cart.length === 0 || isSubmitting}
              className={`w-full py-2.5 rounded-lg text-xs font-extrabold flex items-center justify-center gap-2 shadow-sm transition-all ${
                cart.length === 0 || isSubmitting
                  ? 'bg-slate-300 text-slate-500 cursor-not-allowed'
                  : 'bg-emerald-600 hover:bg-emerald-700 text-white'
              }`}
            >
              <Check className="w-4 h-4" />
              <span>
                {isSubmitting ? 'جارٍ ترحيل الفاتورة...' : `إتمام البيع وحفظ الفاتورة (${total.toFixed(2)} ${currencySymbol})`}
              </span>
            </button>
          </div>
        </div>
      </div>

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

      {/* إضافة عميل من نقطة البيع */}
      {isAddCustomerModalOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4 overflow-y-auto">
          <div className="w-full max-w-md bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
            <div className="flex items-center justify-between px-4 py-3 bg-emerald-800 text-white">
              <div className="flex items-center gap-2"><User className="w-4 h-4" /><h3 className="text-sm font-bold">إضافة عميل جديد</h3></div>
              <button type="button" onClick={() => setIsAddCustomerModalOpen(false)}
                className="p-1 rounded hover:bg-white/10" aria-label="إغلاق نافذة إضافة العميل"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={handleCreateCustomer} className="p-4 space-y-3 text-xs">
              {newCustomerError && <div className="p-2.5 rounded-lg border border-rose-200 bg-rose-50 text-rose-800">{newCustomerError}</div>}
              <div>
                <label className="block mb-1 font-semibold text-slate-700">اسم العميل *</label>
                <input autoFocus required value={newCustomerName} onChange={(e) => setNewCustomerName(e.target.value)}
                  placeholder="أدخل اسم العميل" className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
              </div>
              <div>
                <label className="block mb-1 font-semibold text-slate-700">رقم الهاتف *</label>
                <input type="tel" required value={newCustomerPhone} onChange={(e) => setNewCustomerPhone(e.target.value)}
                  placeholder="أدخل رقم الهاتف" dir="ltr" className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-slate-900 font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500" />
              </div>
              <div>
                <label className="block mb-1 font-semibold text-slate-700">العنوان (اختياري)</label>
                <input value={newCustomerAddress} onChange={(e) => setNewCustomerAddress(e.target.value)}
                  placeholder="المدينة أو المنطقة" className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button type="button" disabled={isSavingNewCustomer} onClick={() => setIsAddCustomerModalOpen(false)}
                  className="px-3 py-2 border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-50 disabled:opacity-50">إلغاء</button>
                <button type="submit" disabled={isSavingNewCustomer}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg disabled:bg-slate-300">
                  {isSavingNewCustomer ? 'جارٍ الحفظ...' : 'حفظ واختيار العميل'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Sales Return Modal */}
      {isReturnModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto">
          <div className="relative w-full max-w-2xl bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200 my-6">
            <div className="flex items-center justify-between px-6 py-4 bg-amber-900 text-white">
              <div className="flex items-center gap-2">
                <RotateCcw className="w-4 h-4 text-amber-300" />
                <h3 className="text-sm font-bold">إصدار إشعار دائن / مرتجع مبيعات</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsReturnModalOpen(false)}
                className="text-amber-200 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmitSalesReturn} className="p-6 space-y-4 text-xs max-h-[82vh] overflow-y-auto">
              {returnError && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span className="font-semibold">{returnError}</span>
                </div>
              )}

              <div className="space-y-2">
                <label className="block font-bold text-slate-800">1. البحث واختيار فاتورة المبيعات الأصلية *</label>
                <input
                  type="text"
                  value={returnSearchQuery}
                  onChange={(e) => setReturnSearchQuery(e.target.value)}
                  placeholder="ابحث برقم الفاتورة أو اسم العميل أو التاريخ..."
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg bg-slate-50 text-slate-900 focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
                <select
                  value={selectedReturnInvoiceId}
                  onChange={(e) => {
                    setSelectedReturnInvoiceId(e.target.value);
                    setReturnQuantities({});
                    setReturnError(null);
                  }}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white text-slate-900 font-semibold focus:outline-none"
                >
                  <option value="">-- اختر فاتورة المبيعات --</option>
                  {saleInvoicesForReturn.map((inv) => (
                    <option key={inv.id} value={inv.id}>
                      {inv.invoiceNumber} | {inv.partyName} | {inv.date} | الإجمالي: {inv.total.toFixed(2)} {currencySymbol}
                    </option>
                  ))}
                </select>
              </div>

              {selectedOriginalSale && (
                <>
                  <div className="grid grid-cols-3 gap-2 bg-slate-50 p-3 rounded-lg border border-slate-200">
                    <div>
                      <div className="text-[10px] text-slate-500">العميل</div>
                      <div className="font-bold text-slate-900">{selectedOriginalSale.partyName}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-500">إجمالي الفاتورة / المسدد</div>
                      <div className="font-mono font-bold text-slate-900">
                        {selectedOriginalSale.total.toFixed(2)} / {selectedOriginalSale.paidAmount.toFixed(2)} {currencySymbol}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-500">المتبقي المفتوح</div>
                      <div className="font-mono font-bold text-amber-800">
                        {Math.max(0, roundMoney(selectedOriginalSale.total - selectedOriginalSale.paidAmount - (selectedOriginalSale.returnedAmount || 0))).toFixed(2)} {currencySymbol}
                      </div>
                    </div>
                  </div>

                  <div className="border border-slate-200 rounded-lg overflow-hidden">
                    <div className="bg-slate-100 px-3 py-2 font-bold text-slate-800">
                      2. تحديد الكميات المرتجعة من الفاتورة
                    </div>
                    <table className="w-full text-right text-xs">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                        <tr>
                          <th className="py-2 px-3">الصنف</th>
                          <th className="py-2 px-3 text-center">المباع</th>
                          <th className="py-2 px-3 text-center">مرتجع سابق</th>
                          <th className="py-2 px-3 text-center">المتاح للإرجاع</th>
                          <th className="py-2 px-3 text-center">الكمية المرتجعة</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {returnableLines.map((line) => (
                          <tr key={line.key}>
                            <td className="py-2 px-3">
                              <div className="font-bold text-slate-900">{line.productName}</div>
                              {line.batchNumber && (
                                <div className="text-[10px] font-mono text-slate-500">تشغيلة: {line.batchNumber}</div>
                              )}
                            </td>
                            <td className="py-2 px-3 text-center font-mono">
                              {line.soldQty} {line.unit}
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
                          setReturnRefundMethod(e.target.value as 'AUTO' | 'AR_OFFSET' | 'CASH' | 'ADVANCE')
                        }
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg bg-white text-slate-900"
                      >
                        <option value="AUTO">تلقائي (تخفيض الذمة المفتوحة ثم رد الباقي)</option>
                        <option value="AR_OFFSET">تخفيض ذمة العميل الآجلة فقط (1103)</option>
                        <option value="CASH">رد نقدي من الصندوق</option>
                        <option value="ADVANCE">ترحيل كرصيد مقدم للعميل (2103)</option>
                      </select>
                    </div>

                    {(returnRefundMethod === 'AUTO' || returnRefundMethod === 'CASH') && (
                      <div>
                        <label className="block font-semibold text-slate-700 mb-1">الصندوق المنصرف منه</label>
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
                      placeholder="مثال: تلف التغليف / خطأ في الصنف / عدم حاجة العميل..."
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900"
                    />
                  </div>
                </>
              )}

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsReturnModalOpen(false)}
                  className="px-4 py-2 border border-slate-200 rounded-lg hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !selectedOriginalSale}
                  className="px-5 py-2 bg-amber-600 hover:bg-amber-700 disabled:bg-slate-300 text-white font-bold rounded-lg flex items-center gap-1.5"
                >
                  <Check className="w-4 h-4" />
                  <span>{isSubmitting ? 'جارٍ اعتماد المرتجع...' : 'اعتماد وترحيل مرتجع المبيعات'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Invoice Printable Receipt Modal */}
      <ReceiptModal
        invoice={completedInvoice}
        activity={(typeof window !== 'undefined' && window.amroDesktop
          ? desktopSession.getActivitiesSnapshot().length > 0
            ? desktopSession.getActivitiesSnapshot()
            : OFFICIAL_ACTIVITIES
          : storage.getActivities()
        ).find((a) => a.id === completedInvoice?.activityId)}
        onClose={() => setCompletedInvoice(null)}
      />
    </div>
  );
};
