/**
 * إدارة المخزون والأصناف متعددة الأنشطة (Inventory Management)
 * يدعم الصيدلية (تشغيلات وصلاحية)، البقالة (باركود)، وقطع الغيار (OEM وتوافقية)
 */

import React, { useState, useEffect } from 'react';
import {
  Package,
  Plus,
  Search,
  Filter,
  AlertTriangle,
  Clock,
  Wrench,
  Pill,
  ShoppingBag,
  Bike,
  Edit2,
  Trash2,
  X,
  Check,
  Tag,
  DollarSign,
  Layers,
  ArrowUpDown,
  Archive,
  RotateCcw,
  Images,
} from 'lucide-react';
import { storage } from '../../services/storageService';
import { inventory } from '../../services/inventoryService';
import { dataService } from '../../services/dataService';
import { authService } from '../../services/authService';
import { getAuthorizedActivityIds } from '../../config/rbac';
import { getActiveCurrencyConfig } from '../../config/currency';
import { useLiveProducts } from '../../hooks/useLiveDexie';
import { Product, ProductBatch, ActivityId } from '../../types/erp';
import { formatLocalDate } from '../../utils/localDate';
import { ProductMediaManager } from './ProductMediaManager';
import { ProductPrimaryImage } from './ProductPrimaryImage';

interface InventoryManagerProps {
  selectedActivity: ActivityId | 'all';
  setSelectedActivity: (activity: ActivityId | 'all') => void;
  onRefresh: () => void;
}

export const InventoryManager: React.FC<InventoryManagerProps> = ({
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

  const [activeTab, setActiveTab] = useState<ActivityId>(
    selectedActivity !== 'all' && isActivityAllowed(selectedActivity)
      ? selectedActivity
      : firstAllowedActivity
  );

  useEffect(() => {
    if (selectedActivity !== 'all' && isActivityAllowed(selectedActivity)) {
      setActiveTab(selectedActivity);
    } else if (!isActivityAllowed(activeTab)) {
      setActiveTab(firstAllowedActivity);
    }
  }, [selectedActivity, firstAllowedActivity]);

  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'low_stock' | 'expiring'>('all');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [managingImagesProduct, setManagingImagesProduct] = useState<Product | null>(null);

  // حقول نموذج الإضافة والتعديل
  const [formNameAr, setFormNameAr] = useState('');
  const [formBarcode, setFormBarcode] = useState('');
  const [formCategory, setFormCategory] = useState('');
  const [formUnit, setFormUnit] = useState('حبة');
  const [formPurchasePrice, setFormPurchasePrice] = useState<string>('');
  const [formSellPrice, setFormSellPrice] = useState<string>('');
  const [formMinAlert, setFormMinAlert] = useState<string>('5');
  const [formLocation, setFormLocation] = useState('');
  const [formOemNumber, setFormOemNumber] = useState('');
  const [formManufacturer, setFormManufacturer] = useState('');
  const [formCompatibility, setFormCompatibility] = useState('');
  const [formEquipmentType, setFormEquipmentType] = useState('');
  const [formSerialNumber, setFormSerialNumber] = useState('');
  const [formScientificName, setFormScientificName] = useState('');
  const [formTrackExpiry, setFormTrackExpiry] = useState(false);
  // حقول التشغيلة الأولية للصيدلية والغذاء
  const [formInitialBatch, setFormInitialBatch] = useState('');
  const [formExpiryDate, setFormExpiryDate] = useState('');
  const [formInitialQty, setFormInitialQty] = useState<string>('0');
  const [formError, setFormError] = useState<string | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // نافذة تأكيد الحذف والتسوية الجردية (INV-07)
  const [deleteConfirmProduct, setDeleteConfirmProduct] = useState<Product | null>(null);
  const [adjustProduct, setAdjustProduct] = useState<Product | null>(null);
  const [adjustDelta, setAdjustDelta] = useState<string>('');
  const [adjustReason, setAdjustReason] = useState<string>('');
  const [adjustBatch, setAdjustBatch] = useState<string>('');
  const [adjustExpiry, setAdjustExpiry] = useState<string>('');
  const [adjustError, setAdjustError] = useState<string | null>(null);

  const currencySymbol = getActiveCurrencyConfig().symbol;
  const products = useLiveProducts(activeTab);
  const expiringAlerts = products.flatMap((p) =>
    (p.batches || [])
      .filter((b) => {
        const diff = Math.ceil((new Date(b.expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        return diff <= 60 && b.quantity > 0;
      })
      .map((b) => ({
        product: p,
        batch: b,
        daysRemaining: Math.ceil((new Date(b.expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
      }))
  );

  // تصفية الأصناف
  const filteredProducts = products.filter((p) => {
    const q = searchQuery.toLowerCase();
    const matchesSearch =
      !searchQuery.trim() ||
      p.nameAr.toLowerCase().includes(q) ||
      p.code.toLowerCase().includes(q) ||
      (p.barcode && p.barcode.toLowerCase().includes(q)) ||
      (p.oemNumber && p.oemNumber.toLowerCase().includes(q));

    if (!matchesSearch) return false;

    if (filterType === 'low_stock') {
      return p.currentStock <= p.minStockAlert;
    }
    if (filterType === 'expiring') {
      return p.batches && p.batches.some((b) => {
        const diff = Math.ceil((new Date(b.expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        return diff <= 60 && b.quantity > 0;
      });
    }

    return true;
  });

  const resetForm = () => {
    setFormNameAr('');
    setFormBarcode('');
    setFormCategory('');
    setFormUnit('حبة');
    setFormPurchasePrice('');
    setFormSellPrice('');
    setFormMinAlert('5');
    setFormLocation('');
    setFormOemNumber('');
    setFormManufacturer('');
    setFormCompatibility('');
    setFormEquipmentType('');
    setFormSerialNumber('');
    setFormScientificName('');
    setFormTrackExpiry(false);
    setFormInitialBatch('');
    setFormExpiryDate('');
    setFormInitialQty('0');
    setFormError(null);
    setEditingProduct(null);
  };

  const openAddModal = () => {
    resetForm();
    setIsAddModalOpen(true);
  };

  const openEditModal = (product: Product) => {
    setEditingProduct(product);
    setFormNameAr(product.nameAr);
    setFormBarcode(product.barcode || '');
    setFormCategory(product.category || '');
    setFormUnit(product.unit);
    setFormPurchasePrice(String(product.purchasePrice));
    setFormSellPrice(String(product.sellPrice));
    setFormMinAlert(String(product.minStockAlert));
    setFormLocation(product.storageLocation || '');
    setFormOemNumber(product.oemNumber || '');
    setFormManufacturer(product.manufacturer || '');
    setFormCompatibility(product.compatibleModels || '');
    setFormEquipmentType(product.equipmentType || '');
    setFormSerialNumber(product.serialNumber || '');
    setFormScientificName(product.scientificName || '');
    setFormTrackExpiry(Boolean(product.trackExpiry));
    setIsAddModalOpen(true);
  };

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setFormError(null);

    if (!formNameAr.trim()) {
      setFormError('يرجى إدخال اسم الصنف التجاري.');
      return;
    }

    const purchase = Number(formPurchasePrice) || 0;
    const sell = Number(formSellPrice) || 0;
    const minAlert = Number(formMinAlert) || 0;
    const initialQty = Math.max(0, Number(formInitialQty) || 0);
    const todayStr = formatLocalDate();

    // الفحص الصارم لبيانات تشغيلات وصلاحية الأدوية بالصيدلية
    if (activeTab === 'pharmacy' && !editingProduct) {
      if (!formInitialBatch.trim()) {
        setFormError('رقم التشغيلة (Batch #) إجباري لكافة أدوية الصيدلية لضمان سلامة المرضى وتطبيق نظام FEFO.');
        return;
      }
      if (!formExpiryDate.trim()) {
        setFormError('تاريخ انتهاء الصلاحية إجباري لكافة أدوية الصيدلية وفق لوائح الرقابة الدوائية.');
        return;
      }
      if (formExpiryDate < todayStr) {
        setFormError(`محظور تماماً تسجيل دواء منتهي الصلاحية! تاريخ الانتهاء (${formExpiryDate}) قد انقضى.`);
        return;
      }
    }

    setIsSubmitting(true);
    try {
      if (editingProduct) {
        const updated: Product = {
          ...editingProduct,
          nameAr: formNameAr.trim(),
          barcode: formBarcode.trim() || undefined,
          category: formCategory.trim(),
          unit: formUnit,
          purchasePrice: purchase,
          sellPrice: sell,
          minStockAlert: minAlert,
          storageLocation: formLocation.trim() || undefined,
          oemNumber: formOemNumber.trim() || undefined,
          manufacturer: formManufacturer.trim() || undefined,
          compatibleModels: formCompatibility.trim() || undefined,
          equipmentType: formEquipmentType.trim() || undefined,
          serialNumber: formSerialNumber.trim() || undefined,
          scientificName: formScientificName.trim() || undefined,
          trackExpiry: activeTab === 'pharmacy' ? true : formTrackExpiry,
        };
        await dataService.saveProductAtomic(updated, true);
      } else {
        const newProductId = storage.generateUUID();
        const batches: ProductBatch[] = [];
        if (formInitialBatch.trim() && formExpiryDate.trim()) {
          batches.push({
            id: storage.generateUUID(),
            productId: newProductId,
            batchNumber: formInitialBatch.trim(),
            expiryDate: formExpiryDate.trim(),
            quantity: initialQty,
            costPrice: purchase,
          });
        }

        const totalStock =
          batches.length > 0
            ? batches.reduce((s, b) => s + b.quantity, 0)
            : initialQty;

        const newProduct: Product = {
          id: newProductId,
          code: inventory.generateProductCode(activeTab),
          activityId: activeTab,
          barcode: formBarcode.trim() || undefined,
          nameAr: formNameAr.trim(),
          category: formCategory.trim(),
          unit: formUnit,
          purchasePrice: purchase,
          sellPrice: sell,
          currentStock: totalStock,
          minStockAlert: minAlert,
          storageLocation: formLocation.trim() || undefined,
          oemNumber: formOemNumber.trim() || undefined,
          manufacturer: formManufacturer.trim() || undefined,
          compatibleModels: formCompatibility.trim() || undefined,
          equipmentType: formEquipmentType.trim() || undefined,
          serialNumber: formSerialNumber.trim() || undefined,
          scientificName: formScientificName.trim() || undefined,
          trackExpiry: activeTab === 'pharmacy' ? true : formTrackExpiry,
          batches: batches.length > 0 ? batches : undefined,
        };
        await dataService.saveProductAtomic(newProduct, false);
      }

      setIsAddModalOpen(false);
      resetForm();
      onRefresh();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'تعذر حفظ الصنف.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const confirmDeleteProduct = async () => {
    if (!deleteConfirmProduct || isSubmitting) return;
    setTableError(null);
    setIsSubmitting(true);
    try {
      await dataService.deleteProductAtomic(deleteConfirmProduct.id);
      setDeleteConfirmProduct(null);
      onRefresh();
    } catch (err: unknown) {
      setTableError(err instanceof Error ? err.message : 'تعذر حذف الصنف.');
      setDeleteConfirmProduct(null);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggleArchiveProduct = async (product: Product) => {
    if (isSubmitting) return;
    setTableError(null);
    setIsSubmitting(true);
    try {
      const nextActive = product.isActive === false;
      await dataService.saveProductAtomic(
        {
          ...product,
          isActive: nextActive,
        },
        true
      );
      onRefresh();
    } catch (err: unknown) {
      setTableError(err instanceof Error ? err.message : 'تعذر تحديث حالة أرشفة الصنف.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSaveAdjustment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjustProduct || isSubmitting) return;
    setAdjustError(null);

    const delta = Number(adjustDelta);
    if (!Number.isFinite(delta) || delta === 0) {
      setAdjustError('أدخل كمية تسوية صالحة (+ للزيادة أو - للنقصان).');
      return;
    }

    setIsSubmitting(true);
    try {
      await dataService.adjustProductStockAtomic({
        productId: adjustProduct.id,
        deltaQuantity: delta,
        reason: adjustReason.trim(),
        batchNumber: adjustBatch.trim() || undefined,
        expiryDate: adjustExpiry.trim() || undefined,
      });
      setAdjustProduct(null);
      setAdjustDelta('');
      setAdjustReason('');
      setAdjustBatch('');
      setAdjustExpiry('');
      onRefresh();
    } catch (err: unknown) {
      setAdjustError(err instanceof Error ? err.message : 'تعذر تنفيذ التسوية الجردية.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const allActivities = [
    { id: 'pharmacy' as ActivityId, name: 'الصيدلية', icon: Pill, color: 'text-emerald-600' },
    { id: 'grocery' as ActivityId, name: 'المواد الغذائية والبقالة', icon: ShoppingBag, color: 'text-amber-600' },
    { id: 'bike_parts' as ActivityId, name: 'قطع غيار الدراجات', icon: Bike, color: 'text-blue-600' },
    { id: 'equipment_parts' as ActivityId, name: 'قطع غيار المعدات', icon: Wrench, color: 'text-indigo-600' },
  ];
  const activities =
    actor?.role === 'ADMIN'
      ? allActivities
      : allActivities.filter((act) => authorizedActivityIds.has(act.id));

  return (
    <div className="p-3.5 sm:p-5 lg:p-6 space-y-4 sm:space-y-6 max-w-7xl mx-auto">
      {/* Activity Navigation Tabs */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between bg-white p-2.5 sm:p-3 rounded-xl border border-slate-200 gap-3">
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1 sm:pb-0">
          {activities.map((act) => {
            const Icon = act.icon;
            const isActive = activeTab === act.id;
            return (
              <button
                key={act.id}
                onClick={() => {
                  setActiveTab(act.id);
                  setSelectedActivity(act.id);
                }}
                className={`flex items-center gap-1.5 px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${
                  isActive
                    ? 'bg-slate-900 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-emerald-400' : act.color}`} />
                <span>{act.name}</span>
              </button>
            );
          })}
        </div>

        <button
          onClick={openAddModal}
          className="flex items-center justify-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-sm transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" />
          <span>إضافة صنف جديد</span>
        </button>
      </div>

      {/* Search & Filter Toolbar */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="بحث بالاسم، الباركود، أو رقم القطعة..."
            className="w-full pl-3 pr-9 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto overflow-x-auto">
          <button
            onClick={() => setFilterType('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              filterType === 'all'
                ? 'bg-slate-800 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            كافة الأصناف ({products.length})
          </button>
          <button
            onClick={() => setFilterType('low_stock')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              filterType === 'low_stock'
                ? 'bg-rose-700 text-white'
                : 'bg-rose-50 text-rose-800 hover:bg-rose-100'
            }`}
          >
            منخفض الرصيد
          </button>
          {(activeTab === 'pharmacy' || activeTab === 'grocery') && (
            <button
              onClick={() => setFilterType('expiring')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                filterType === 'expiring'
                  ? 'bg-amber-700 text-white'
                  : 'bg-amber-50 text-amber-800 hover:bg-amber-100'
              }`}
            >
              قريب الانتهاء
            </button>
          )}
        </div>
      </div>

      {tableError && (
        <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 text-xs flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{tableError}</span>
          </div>
          <button onClick={() => setTableError(null)} className="text-rose-600 hover:text-rose-900">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Products Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500 bg-slate-50">
                <th className="py-3 px-3 text-center">الصورة</th>
                <th className="py-3 px-4">كود الصنف</th>
                <th className="py-3 px-4">اسم الصنف والتفاصيل</th>
                <th className="py-3 px-4">التصنيف</th>
                <th className="py-3 px-4 text-center">الرصيد المتاح</th>
                <th className="py-3 px-4 text-center">سعر الشراء</th>
                <th className="py-3 px-4 text-center">سعر البيع</th>
                <th className="py-3 px-4 text-center">التشغيلات / التوافق</th>
                <th className="py-3 px-4 text-center">الإجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredProducts.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-400">
                    <Package className="w-8 h-8 mx-auto mb-2 text-slate-300 stroke-1" />
                    <p className="font-medium">لا توجد أصناف مسجلة في هذا القسم بعد</p>
                    <p className="text-[11px] text-slate-400 mt-1">اضغط على «إضافة صنف جديد» لتسجيل بضائع حقيقية</p>
                  </td>
                </tr>
              ) : (
                filteredProducts.map((p) => {
                  const isLow = p.currentStock <= p.minStockAlert;
                  const isArchived = p.isActive === false;
                  return (
                    <tr
                      key={p.id}
                      className={`transition-colors ${
                        isArchived ? 'bg-slate-50/80 opacity-70 hover:bg-slate-100/70' : 'hover:bg-slate-50/80'
                      }`}
                    >
                      <td className="py-2 px-3 text-center"><ProductPrimaryImage productId={p.id} productName={p.nameAr} /></td>
                      <td className="py-3 px-4 font-mono font-bold text-slate-900">{p.code}</td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-bold text-slate-900">{p.nameAr}</span>
                          {isArchived && (
                            <span className="px-1.5 py-0.5 text-[10px] font-bold bg-slate-200 text-slate-700 rounded">
                              مؤرشف
                            </span>
                          )}
                        </div>
                        {p.barcode && (
                          <div className="text-[10px] text-slate-400 font-mono">باركود: {p.barcode}</div>
                        )}
                        {p.storageLocation && (
                          <div className="text-[10px] text-slate-500">موقع: {p.storageLocation}</div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-slate-600">{p.category || '-'}</td>
                      <td className="py-3 px-4 text-center">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full font-mono font-bold tabular-nums ${
                            isLow ? 'bg-rose-100 text-rose-800' : 'bg-emerald-100 text-emerald-800'
                          }`}
                        >
                          {p.currentStock} {p.unit}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-center font-mono tabular-nums text-slate-700">
                        {p.purchasePrice.toFixed(2)} {currencySymbol}
                      </td>
                      <td className="py-3 px-4 text-center font-mono tabular-nums font-bold text-emerald-700">
                        {p.sellPrice.toFixed(2)} {currencySymbol}
                      </td>
                      <td className="py-3 px-4 text-center">
                        {p.batches && p.batches.length > 0 ? (
                          <div className="text-[11px] text-slate-600">
                            {p.batches.map((b, i) => (
                              <div key={i} className="font-mono text-[10px]">
                                {b.batchNumber}: {b.quantity} (انتهاء: {b.expiryDate})
                              </div>
                            ))}
                          </div>
                        ) : p.oemNumber ? (
                          <div className="text-[10px] text-slate-600">
                            <span className="font-mono font-semibold">OEM: {p.oemNumber}</span>
                            {p.compatibleModels && <div>{p.compatibleModels}</div>}
                          </div>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            onClick={() => {
                              setAdjustError(null);
                              setAdjustDelta('');
                              setAdjustReason('');
                              setAdjustBatch(p.batches?.[0]?.batchNumber || '');
                              setAdjustExpiry('');
                              setAdjustProduct(p);
                            }}
                            className="p-1.5 text-slate-500 hover:text-blue-700 hover:bg-blue-50 rounded-md transition-colors"
                            title="تسوية جردية"
                          >
                            <ArrowUpDown className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => openEditModal(p)}
                            className="p-1.5 text-slate-500 hover:text-emerald-700 hover:bg-slate-100 rounded-md transition-colors"
                            title="تعديل بيانات الصنف"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => setManagingImagesProduct(p)}
                            className="p-1.5 text-slate-500 hover:text-indigo-700 hover:bg-indigo-50 rounded-md transition-colors"
                            title="إدارة صور الصنف"
                          >
                            <Images className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleToggleArchiveProduct(p)}
                            disabled={isSubmitting}
                            className={`p-1.5 rounded-md transition-colors ${
                              isArchived
                                ? 'text-emerald-600 hover:text-emerald-800 hover:bg-emerald-50'
                                : 'text-slate-500 hover:text-amber-700 hover:bg-amber-50'
                            }`}
                            title={isArchived ? 'إعادة تفعيل الصنف' : 'أرشفة الصنف وتعطيله'}
                          >
                            {isArchived ? <RotateCcw className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
                          </button>
                          <button
                            onClick={() => setDeleteConfirmProduct(p)}
                            className="p-1.5 text-slate-500 hover:text-rose-700 hover:bg-rose-50 rounded-md transition-colors"
                            title="حذف الصنف"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
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

      {/* Add / Edit Product Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto">
          <div className="relative w-full max-w-2xl bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
            <div className="flex items-center justify-between px-6 py-4 bg-slate-900 text-white">
              <h3 className="text-sm font-bold">
                {editingProduct ? 'تعديل بيانات الصنف' : 'إضافة صنف جديد للمستودع'}
              </h3>
              <button
                onClick={() => setIsAddModalOpen(false)}
                className="text-slate-400 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveProduct} className="p-6 space-y-4 text-xs">
              {formError && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span className="font-semibold">{formError}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">اسم الصنف التجاري *</label>
                  <input
                    type="text"
                    required
                    value={formNameAr}
                    onChange={(e) => setFormNameAr(e.target.value)}
                    placeholder="مثال: باراسيتامول 500 ملغ / أرز بسمتي 5 كجم / جنزير دراجة 428..."
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">الباركود (إن وجد)</label>
                  <input
                    type="text"
                    value={formBarcode}
                    onChange={(e) => setFormBarcode(e.target.value)}
                    placeholder="امسح الباركود أو أدخل رقمه..."
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">التصنيف / العائلة</label>
                  <input
                    type="text"
                    value={formCategory}
                    onChange={(e) => setFormCategory(e.target.value)}
                    placeholder="مثال: مسكنات، معلبات، فلاتر، محركات..."
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">وحدة القياس</label>
                  <select
                    value={formUnit}
                    onChange={(e) => setFormUnit(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  >
                    <option value="حبة">حبة</option>
                    <option value="علبة">علبة / باكت</option>
                    <option value="كرتون">كرتون</option>
                    <option value="طقم">طقم</option>
                    <option value="شريط">شريط</option>
                    <option value="كيلو">كيلوغرام</option>
                    <option value="لتر">لتر</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">سعر الشراء (التكلفة) *</label>
                  <input
                    type="number"
                    step="any"
                    required
                    value={formPurchasePrice}
                    onChange={(e) => setFormPurchasePrice(e.target.value)}
                    placeholder="0.00"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">سعر البيع الافتراضي *</label>
                  <input
                    type="number"
                    step="any"
                    required
                    value={formSellPrice}
                    onChange={(e) => setFormSellPrice(e.target.value)}
                    placeholder="0.00"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">حد الطلب الأدنى (للتنبيه)</label>
                  <input
                    type="number"
                    value={formMinAlert}
                    onChange={(e) => setFormMinAlert(e.target.value)}
                    placeholder="5"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">موقع التخزين / الرف</label>
                  <input
                    type="text"
                    value={formLocation}
                    onChange={(e) => setFormLocation(e.target.value)}
                    placeholder="مثال: رف أ-1، درج 4..."
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>
              </div>

              {/* حقول تخصصية للصيدلية */}
              {activeTab === 'pharmacy' && (
                <div className="p-3 bg-emerald-50/50 rounded-lg border border-emerald-100 space-y-3">
                  <div className="font-bold text-emerald-900">بيانات الصيدلية والدواء (اختياري)</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-700 mb-1">الاسم العلمي للمادة الفعالة</label>
                      <input
                        type="text"
                        value={formScientificName}
                        onChange={(e) => setFormScientificName(e.target.value)}
                        placeholder="مثال: Paracetamol, Amoxicillin..."
                        className="w-full px-3 py-1.5 border border-slate-200 rounded bg-white text-slate-900 focus:outline-none"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* خيار تتبع الصلاحية للمواد الغذائية */}
              {activeTab === 'grocery' && (
                <div className="p-3 bg-amber-50/50 rounded-lg border border-amber-100 space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formTrackExpiry}
                      onChange={(e) => setFormTrackExpiry(e.target.checked)}
                      className="w-4 h-4 rounded text-amber-600 focus:ring-amber-500"
                    />
                    <span className="font-bold text-xs text-amber-900">تفعيل تتبع التشغيلات والصلاحية لهذا الصنف الغذائي</span>
                  </label>
                  <p className="text-[11px] text-slate-500">
                    فعّل هذا الخيار للأغذية والمشروبات سريعة التلف (مثل الألبان والمخبوزات)، أو اتركه معطلاً للسلع الجافة والمنظفات.
                  </p>
                </div>
              )}

              {/* حقول تخصصية لقطع الغيار والمعدات */}
              {(activeTab === 'bike_parts' || activeTab === 'equipment_parts') && (
                <div className="p-3 bg-blue-50/50 rounded-lg border border-blue-100 space-y-3">
                  <div className="font-bold text-blue-900">
                    بيانات {activeTab === 'bike_parts' ? 'قطع غيار الدراجات' : 'قطع غيار المعدات'}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-700 mb-1">رقم القطعة الأصلي (OEM Number)</label>
                      <input
                        type="text"
                        value={formOemNumber}
                        onChange={(e) => setFormOemNumber(e.target.value)}
                        placeholder="مثال: 14100-KCW-000"
                        className="w-full px-3 py-1.5 border border-slate-200 rounded bg-white font-mono text-slate-900 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-700 mb-1">الشركة المصنعة / الماركة</label>
                      <input
                        type="text"
                        value={formManufacturer}
                        onChange={(e) => setFormManufacturer(e.target.value)}
                        placeholder="مثال: Honda, Yamaha, Bosch, CAT..."
                        className="w-full px-3 py-1.5 border border-slate-200 rounded bg-white text-slate-900 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-700 mb-1">الموديلات المتوافقة وسنوات الصنع</label>
                      <input
                        type="text"
                        value={formCompatibility}
                        onChange={(e) => setFormCompatibility(e.target.value)}
                        placeholder="مثال: هوندا 150cc، سوزوكي، ياماها..."
                        className="w-full px-3 py-1.5 border border-slate-200 rounded bg-white text-slate-900 focus:outline-none"
                      />
                    </div>
                    {activeTab === 'equipment_parts' && (
                      <>
                        <div>
                          <label className="block text-slate-700 mb-1">نوع المعدة / الاستخدام</label>
                          <input
                            type="text"
                            value={formEquipmentType}
                            onChange={(e) => setFormEquipmentType(e.target.value)}
                            placeholder="مثال: مضخة مياه، مولد، حراثة..."
                            className="w-full px-3 py-1.5 border border-slate-200 rounded bg-white text-slate-900 focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-slate-700 mb-1">الرقم التسلسلي للقطعة (إن وجد)</label>
                          <input
                            type="text"
                            value={formSerialNumber}
                            onChange={(e) => setFormSerialNumber(e.target.value)}
                            placeholder="مثال: S/N: 984210"
                            className="w-full px-3 py-1.5 border border-slate-200 rounded bg-white font-mono text-slate-900 focus:outline-none"
                          />
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* حقول التشغيلة والصلاحية الأولية (للصيدلية أو الأغذية المفعّل لها التتبع) */}
              {!editingProduct && (activeTab === 'pharmacy' || (activeTab === 'grocery' && formTrackExpiry)) && (
                <div className={`p-3 rounded-lg border space-y-3 ${
                  activeTab === 'pharmacy' ? 'bg-emerald-50/80 border-emerald-300 shadow-xs' : 'bg-emerald-50/50 border-emerald-100'
                }`}>
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-xs text-emerald-950 flex items-center gap-1.5">
                      <Clock className="w-4 h-4 text-emerald-700" />
                      {activeTab === 'pharmacy' ? 'بيانات تشغيلة الدواء وصلاحيته (نظام FEFO الإلزامي)' : 'بيانات التشغيلة والصلاحية'}
                    </span>
                    {activeTab === 'pharmacy' ? (
                      <span className="text-[10px] font-bold text-rose-700 bg-rose-50 px-2.5 py-0.5 rounded border border-rose-300 shadow-xs">
                        * إجباري لكافة أصناف الصيدلية
                      </span>
                    ) : (
                      <span className="text-[10px] text-slate-500">(اختياري حسب طبيعة الصنف)</span>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-slate-700 mb-1 font-semibold text-xs">
                        رقم التشغيلة (Batch #) {activeTab === 'pharmacy' && <span className="text-rose-600 font-bold">*</span>}
                      </label>
                      <input
                        type="text"
                        required={activeTab === 'pharmacy'}
                        value={formInitialBatch}
                        onChange={(e) => setFormInitialBatch(e.target.value)}
                        placeholder="مثال: BTH-2026-01"
                        className={`w-full px-3 py-1.5 border rounded bg-white font-mono text-slate-900 focus:outline-none focus:ring-1 ${
                          activeTab === 'pharmacy' ? 'border-emerald-400 focus:ring-emerald-500' : 'border-slate-200'
                        }`}
                      />
                    </div>
                    <div>
                      <label className="block text-slate-700 mb-1 font-semibold text-xs">
                        تاريخ انتهاء الصلاحية {activeTab === 'pharmacy' && <span className="text-rose-600 font-bold">*</span>}
                      </label>
                      <input
                        type="date"
                        required={activeTab === 'pharmacy'}
                        min={activeTab === 'pharmacy' ? formatLocalDate() : undefined}
                        value={formExpiryDate}
                        onChange={(e) => setFormExpiryDate(e.target.value)}
                        className={`w-full px-3 py-1.5 border rounded bg-white font-mono text-slate-900 focus:outline-none focus:ring-1 ${
                          activeTab === 'pharmacy' ? 'border-emerald-400 focus:ring-emerald-500' : 'border-slate-200'
                        }`}
                      />
                    </div>
                    <div>
                      <label className="block text-slate-700 mb-1 font-semibold text-xs">الرصيد الأولي لهذه التشغيلة</label>
                      <input
                        type="number"
                        min="0"
                        value={formInitialQty}
                        onChange={(e) => setFormInitialQty(e.target.value)}
                        placeholder="0"
                        className="w-full px-3 py-1.5 border border-slate-200 rounded bg-white font-mono text-slate-900 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      />
                    </div>
                  </div>
                  {activeTab === 'pharmacy' && (
                    <div className="text-[11px] text-emerald-800 bg-emerald-100/60 p-2 rounded border border-emerald-200">
                      يتم تقييد رقم التشغيلة وتاريخ الصلاحية لضمان تتبع المستحضر وتطبيق خروج الأقرب انتهاءً أولاً (FEFO) ومنع بيع أي دواء منتهي.
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-4 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition-colors"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-bold rounded-lg transition-colors flex items-center gap-1.5"
                >
                  <Check className="w-4 h-4" />
                  <span>{isSubmitting ? 'جارٍ الحفظ...' : 'حفظ الصنف'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-5 space-y-4">
            <div className="flex items-center gap-2 text-rose-700">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <h4 className="text-sm font-bold text-slate-900">تأكيد حذف الصنف</h4>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              هل أنت متأكد من حذف الصنف{' '}
              <strong className="text-slate-900">{deleteConfirmProduct.nameAr}</strong>{' '}
              (<span className="font-mono">{deleteConfirmProduct.code}</span>)؟
            </p>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setDeleteConfirmProduct(null)}
                className="px-4 py-1.5 border border-slate-200 rounded-lg text-xs text-slate-600 hover:bg-slate-50"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={confirmDeleteProduct}
                className="px-4 py-1.5 bg-rose-600 hover:bg-rose-700 disabled:bg-slate-300 text-white rounded-lg text-xs font-bold"
              >
                {isSubmitting ? 'جارٍ الحذف...' : 'تأكيد الحذف'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stock Count Adjustment Modal (INV-07) */}
      {adjustProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full overflow-hidden border border-slate-200">
            <div className="flex items-center justify-between px-5 py-3.5 bg-slate-900 text-white">
              <h4 className="text-xs font-bold">تسوية جردية ذرية: {adjustProduct.nameAr}</h4>
              <button onClick={() => setAdjustProduct(null)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveAdjustment} className="p-5 space-y-3 text-xs">
              {adjustError && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{adjustError}</span>
                </div>
              )}
              <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg flex justify-between">
                <span className="text-slate-600">الرصيد الدفتري الحالي:</span>
                <span className="font-mono font-bold text-slate-900">
                  {adjustProduct.currentStock} {adjustProduct.unit}
                </span>
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">كمية التسوية (+ زيادة / - خصم) *</label>
                <input
                  type="number"
                  step="any"
                  required
                  value={adjustDelta}
                  onChange={(e) => setAdjustDelta(e.target.value)}
                  placeholder="مثال: -2 أو 5"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg font-mono"
                />
              </div>
              {(adjustProduct.trackExpiry || (adjustProduct.batches && adjustProduct.batches.length > 0)) && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">رقم التشغيلة</label>
                    <input
                      type="text"
                      value={adjustBatch}
                      onChange={(e) => setAdjustBatch(e.target.value)}
                      placeholder="BTH-01"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">تاريخ الانتهاء (للزيادة)</label>
                    <input
                      type="date"
                      value={adjustExpiry}
                      onChange={(e) => setAdjustExpiry(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg font-mono"
                    />
                  </div>
                </div>
              )}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">سبب التسوية الجردية *</label>
                <input
                  type="text"
                  required
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  placeholder="مثال: جرد دوري / تالف / عجز مخزني"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setAdjustProduct(null)}
                  className="px-4 py-1.5 border border-slate-200 rounded-lg text-slate-600"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-bold rounded-lg"
                >
                  {isSubmitting ? 'جارٍ الاعتماد...' : 'اعتماد التسوية'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {managingImagesProduct && (
        <ProductMediaManager
          product={managingImagesProduct}
          onClose={() => setManagingImagesProduct(null)}
        />
      )}
    </div>
  );
};
