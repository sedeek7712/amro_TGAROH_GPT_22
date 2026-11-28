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
  FolderTree,
} from 'lucide-react';
import { storage } from '../../services/storageService';
import { inventory } from '../../services/inventoryService';
import { dataService } from '../../services/dataService';
import { authService } from '../../services/authService';
import { getAuthorizedActivityIds, hasPermission } from '../../config/rbac';
import { getActiveCurrencyConfig } from '../../config/currency';
import { useLiveProducts } from '../../hooks/useLiveDexie';
import {
  Product,
  ProductBatch,
  ProductUnit,
  ActivityId,
  Brand,
  ProductFamily,
  ProductCatalogEntry,
} from '../../types/erp';
import { formatLocalDate } from '../../utils/localDate';
import {
  formatVariantAttributesPairs,
  groupCatalogEntriesByFamily,
  matchesCatalogEntrySearch,
} from '../../utils/productCatalogUi';
import { ProductMediaManager } from './ProductMediaManager';
import { ProductPrimaryImage } from './ProductPrimaryImage';
import { BrandManagerModal } from './BrandManagerModal';
import { ProductFamilyModal } from './ProductFamilyModal';

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

  const canWriteInventory = hasPermission(actor, 'inventory:write');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'low_stock' | 'expiring'>('all');
  const [viewMode, setViewMode] = useState<'skus' | 'families'>('skus');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isBrandModalOpen, setIsBrandModalOpen] = useState(false);
  const [isFamilyModalOpen, setIsFamilyModalOpen] = useState(false);
  const [editingFamily, setEditingFamily] = useState<ProductFamily | null>(null);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editingCatalogEntry, setEditingCatalogEntry] = useState<ProductCatalogEntry | null>(null);
  const [managingImagesProduct, setManagingImagesProduct] = useState<Product | null>(null);
  const [productUnits, setProductUnits] = useState<ProductUnit[]>([]);
  const [unitDraft, setUnitDraft] = useState({ id: '', code: '', nameAr: '', numerator: '1', denominator: '1', barcode: '' });
  const [unitError, setUnitError] = useState<string | null>(null);
  const [isSavingUnit, setIsSavingUnit] = useState(false);
  const [isLoadingUnits, setIsLoadingUnits] = useState(false);

  const [catalogEntries, setCatalogEntries] = useState<ProductCatalogEntry[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [families, setFamilies] = useState<ProductFamily[]>([]);
  const [catalogRefreshNonce, setCatalogRefreshNonce] = useState(0);

  // حقول نموذج الإضافة والتعديل
  const [formNameAr, setFormNameAr] = useState('');
  const [formBarcode, setFormBarcode] = useState('');
  const [formCategory, setFormCategory] = useState('');
  const [formBrandId, setFormBrandId] = useState('');
  const [initialFormBrandId, setInitialFormBrandId] = useState('');
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

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      dataService.getProductCatalog(activeTab),
      dataService.getBrands(true),
      dataService.getProductFamilies(activeTab, true),
    ])
      .then(([entries, brandList, familyList]) => {
        if (cancelled) return;
        setCatalogEntries(entries);
        setBrands(brandList);
        setFamilies(familyList);
      })
      .catch((err) => {
        if (cancelled) return;
        setTableError(err instanceof Error ? err.message : 'تعذر تحميل بيانات دليل المنتجات.');
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, products, catalogRefreshNonce]);

  const triggerCatalogRefresh = () => {
    setCatalogRefreshNonce((n) => n + 1);
    onRefresh();
  };

  // دمج reactive products مع بيانات الكتالوج (المجموعات والعلامات والمتغيرات)
  const effectiveCatalogEntries: ProductCatalogEntry[] = (() => {
    const entryByProductId = new Map(catalogEntries.map((e) => [e.product.id, e]));
    return products.map((p) => {
      const existing = entryByProductId.get(p.id);
      if (existing) {
        return { ...existing, product: p };
      }
      return {
        product: p,
        variantAttributes: {},
        units: [],
      };
    });
  })();

  // تصفية الأصناف
  const filteredEntries = effectiveCatalogEntries.filter((entry) => {
    const p = entry.product;
    if (!matchesCatalogEntrySearch(entry, searchQuery)) return false;

    if (filterType === 'low_stock') {
      return p.currentStock <= p.minStockAlert;
    }
    if (filterType === 'expiring') {
      return (
        p.batches &&
        p.batches.some((b) => {
          const diff = Math.ceil((new Date(b.expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
          return diff <= 60 && b.quantity > 0;
        })
      );
    }

    return true;
  });

  const groupedCatalog = groupCatalogEntriesByFamily(filteredEntries, families, brands);

  const resetForm = () => {
    setFormNameAr('');
    setFormBarcode('');
    setFormCategory('');
    setFormBrandId('');
    setInitialFormBrandId('');
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
    setEditingCatalogEntry(null);
    setProductUnits([]);
    setUnitDraft({ id: '', code: '', nameAr: '', numerator: '1', denominator: '1', barcode: '' });
    setUnitError(null);
    setIsLoadingUnits(false);
  };

  const openAddModal = () => {
    resetForm();
    setIsAddModalOpen(true);
  };

  const loadProductUnits = async (productId: string) => {
    setUnitError(null);
    setIsLoadingUnits(true);
    try {
      setProductUnits(await dataService.getProductUnits(productId));
    } catch (err: unknown) {
      setUnitError(err instanceof Error ? err.message : 'تعذر تحميل الوحدات البديلة.');
    } finally {
      setIsLoadingUnits(false);
    }
  };

  const handleSaveProductUnit = async () => {
    if (!editingProduct || isSavingUnit) return;
    setUnitError(null);
    if (formUnit !== editingProduct.unit) {
      setUnitError('احفظ الصنف أولًا، ولا تغيّر وحدة المخزون الأساسية مع وجود وحدات بديلة.');
      return;
    }
    const numerator = Number(unitDraft.numerator);
    const denominator = Number(unitDraft.denominator);
    if (!unitDraft.code.trim() || !unitDraft.nameAr.trim()) {
      setUnitError('أدخل رمز الوحدة واسمها.');
      return;
    }
    if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0) {
      setUnitError('أدخل معامل تحويل صحيحًا موجبًا، مثل 24 إلى 1.');
      return;
    }
    setIsSavingUnit(true);
    try {
      await dataService.saveProductUnit({
        ...(unitDraft.id ? { id: unitDraft.id } : {}),
        productId: editingProduct.id,
        code: unitDraft.code.trim(),
        nameAr: unitDraft.nameAr.trim(),
        baseUnitsNumerator: numerator,
        baseUnitsDenominator: denominator,
        ...(unitDraft.barcode.trim() ? { barcode: unitDraft.barcode.trim() } : {}),
      });
      setUnitDraft({ id: '', code: '', nameAr: '', numerator: '1', denominator: '1', barcode: '' });
      await loadProductUnits(editingProduct.id);
    } catch (err: unknown) {
      setUnitError(err instanceof Error ? err.message : 'تعذر حفظ الوحدة البديلة.');
    } finally {
      setIsSavingUnit(false);
    }
  };

  const startEditProductUnit = (unit: ProductUnit) => {
    setUnitDraft({
      id: unit.id,
      code: unit.code,
      nameAr: unit.nameAr,
      numerator: String(unit.baseUnitsNumerator),
      denominator: String(unit.baseUnitsDenominator),
      barcode: unit.barcode || '',
    });
    setUnitError(null);
  };

  const handleToggleProductUnit = async (unit: ProductUnit) => {
    if (isSavingUnit) return;
    setUnitError(null);
    setIsSavingUnit(true);
    try {
      await dataService.saveProductUnit({
        id: unit.id,
        productId: unit.productId,
        code: unit.code,
        nameAr: unit.nameAr,
        baseUnitsNumerator: unit.baseUnitsNumerator,
        baseUnitsDenominator: unit.baseUnitsDenominator,
        barcode: unit.barcode,
        isActive: !unit.isActive,
      });
      await loadProductUnits(unit.productId);
    } catch (err: unknown) {
      setUnitError(err instanceof Error ? err.message : 'تعذر تحديث حالة الوحدة.');
    } finally {
      setIsSavingUnit(false);
    }
  };

  const openEditModal = (entry: ProductCatalogEntry) => {
    const product = entry.product;
    setProductUnits([]);
    setUnitDraft({ id: '', code: '', nameAr: '', numerator: '1', denominator: '1', barcode: '' });
    void loadProductUnits(product.id);
    setEditingProduct(product);
    setEditingCatalogEntry(entry);
    const currentStandaloneBrandId = entry.family ? '' : entry.meta?.brandId || '';
    setFormBrandId(currentStandaloneBrandId);
    setInitialFormBrandId(currentStandaloneBrandId);
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
    setFormError(null);
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
    if (editingProduct && isLoadingUnits) {
      setFormError('انتظر حتى يكتمل تحميل الوحدات البديلة.');
      return;
    }
    if (editingProduct && formUnit !== editingProduct.unit && (productUnits.length > 0 || unitError)) {
      setFormError('لا يمكن تغيير وحدة المخزون الأساسية بعد تعريف وحدات بديلة. راجع الوحدات أولًا في مرحلة مستقلة.');
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
        const saved = await dataService.saveProductAtomic(updated, true);
        if (!editingCatalogEntry?.family && formBrandId !== initialFormBrandId) {
          await dataService.assignProductBrandAtomic({
            productId: saved.id,
            brandId: formBrandId ? formBrandId : null,
          });
        }
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
        const saved = await dataService.saveProductAtomic(newProduct, false);
        if (formBrandId) {
          await dataService.assignProductBrandAtomic({
            productId: saved.id,
            brandId: formBrandId,
          });
        }
      }

      setIsAddModalOpen(false);
      resetForm();
      triggerCatalogRefresh();
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
      triggerCatalogRefresh();
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
      triggerCatalogRefresh();
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
      triggerCatalogRefresh();
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

  const activeActivityLabel =
    allActivities.find((a) => a.id === activeTab)?.name || 'النشاط';

  const renderProductRow = (
    entry: ProductCatalogEntry,
    options?: { hideFamilyAndBrandMeta?: boolean }
  ) => {
    const p = entry.product;
    const isLow = p.currentStock <= p.minStockAlert;
    const isArchived = p.isActive === false;
    const variantPairs = formatVariantAttributesPairs(
      entry.variantAttributes,
      entry.family?.optionSchema
    );
    const metaParts: string[] = [];
    if (entry.family && !options?.hideFamilyAndBrandMeta) {
      metaParts.push(
        `المجموعة: ${entry.family.nameAr}${entry.family.isActive === false ? ' (مؤرشفة)' : ''}`
      );
    }
    for (const pair of variantPairs) {
      metaParts.push(`${pair.label}: ${pair.value}`);
    }
    if (entry.brand && !options?.hideFamilyAndBrandMeta) {
      metaParts.push(`العلامة: ${entry.brand.nameAr}`);
    }
    if (p.barcode) {
      metaParts.push(`باركود: ${p.barcode}`);
    }
    if (p.storageLocation) {
      metaParts.push(`موقع: ${p.storageLocation}`);
    }

    return (
      <tr
        key={p.id}
        className={`transition-colors ${
          isArchived ? 'bg-slate-50/80 opacity-75 hover:bg-slate-100/70' : 'hover:bg-slate-50/80'
        }`}
      >
        <td className="py-2 px-3 text-center">
          <ProductPrimaryImage productId={p.id} productName={p.nameAr} />
        </td>
        <td className="py-3 px-4 font-mono font-bold text-slate-900 tabular-nums whitespace-nowrap">
          {p.code}
        </td>
        <td className="py-3 px-4 min-w-[210px]">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-slate-900">{p.nameAr}</span>
            {isArchived && (
              <span className="text-[11px] font-semibold text-amber-700">· مؤرشف</span>
            )}
          </div>
          {metaParts.length > 0 && (
            <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
              {metaParts.map((part, idx) => (
                <React.Fragment key={`${p.id}-meta-${idx}`}>
                  {idx > 0 && <span aria-hidden="true">·</span>}
                  <span>{part}</span>
                </React.Fragment>
              ))}
            </div>
          )}
        </td>
        <td className="py-3 px-4 text-slate-600">
          {p.category || entry.family?.categorySnapshot || '-'}
        </td>
        <td className="py-3 px-4 text-center">
          <span
            className={`inline-block px-2 py-0.5 rounded-md font-mono font-bold tabular-nums whitespace-nowrap ${
              isLow ? 'bg-rose-50 text-rose-800 border border-rose-200' : 'bg-emerald-50 text-emerald-800 border border-emerald-200'
            }`}
          >
            {p.currentStock} {p.unit}
          </span>
        </td>
        <td className="py-3 px-4 text-center font-mono tabular-nums text-slate-700 whitespace-nowrap">
          {p.purchasePrice.toFixed(2)} {currencySymbol}
        </td>
        <td className="py-3 px-4 text-center font-mono tabular-nums font-bold text-emerald-700 whitespace-nowrap">
          {p.sellPrice.toFixed(2)} {currencySymbol}
        </td>
        <td className="py-3 px-4 text-center">
          {p.batches && p.batches.length > 0 ? (
            <div className="text-[11px] text-slate-600 tabular-nums">
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
          <div className="flex items-center justify-center gap-1">
            <button
              type="button"
              onClick={() => {
                setAdjustError(null);
                setAdjustDelta('');
                setAdjustReason('');
                setAdjustBatch(p.batches?.[0]?.batchNumber || '');
                setAdjustExpiry('');
                setAdjustProduct(p);
              }}
              aria-label={`تسوية جردية للصنف ${p.nameAr}`}
              className="p-1.5 text-slate-500 hover:text-blue-700 hover:bg-blue-50 rounded-md transition-colors"
              title="تسوية جردية"
            >
              <ArrowUpDown className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => openEditModal(entry)}
              aria-label={`تعديل الصنف ${p.nameAr}`}
              className="p-1.5 text-slate-500 hover:text-emerald-700 hover:bg-slate-100 rounded-md transition-colors"
              title="تعديل بيانات الصنف"
            >
              <Edit2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setManagingImagesProduct(p)}
              aria-label={`إدارة صور الصنف ${p.nameAr}`}
              className="p-1.5 text-slate-500 hover:text-indigo-700 hover:bg-indigo-50 rounded-md transition-colors"
              title="إدارة صور الصنف"
            >
              <Images className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => handleToggleArchiveProduct(p)}
              disabled={isSubmitting}
              aria-label={isArchived ? `إعادة تفعيل الصنف ${p.nameAr}` : `أرشفة الصنف ${p.nameAr}`}
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
              type="button"
              onClick={() => setDeleteConfirmProduct(p)}
              aria-label={`حذف الصنف ${p.nameAr}`}
              className="p-1.5 text-slate-500 hover:text-rose-700 hover:bg-rose-50 rounded-md transition-colors"
              title="حذف الصنف"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </td>
      </tr>
    );
  };

  return (
    <div className="p-3.5 sm:p-5 lg:p-6 space-y-4 sm:space-y-6 max-w-7xl mx-auto">
      {/* Activity Navigation Tabs & Primary Catalog Actions */}
      <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between bg-white p-2.5 sm:p-3 rounded-xl border border-slate-200 gap-3">
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1 lg:pb-0">
          {activities.map((act) => {
            const Icon = act.icon;
            const isActive = activeTab === act.id;
            return (
              <button
                key={act.id}
                type="button"
                onClick={() => {
                  setActiveTab(act.id);
                  setSelectedActivity(act.id);
                }}
                className={`flex items-center gap-1.5 px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap shrink-0 ${
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

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setIsBrandModalOpen(true)}
            className="flex items-center justify-center gap-1.5 px-3 py-2 border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 rounded-lg text-xs font-bold transition-colors whitespace-nowrap shrink-0"
          >
            <Tag className="w-3.5 h-3.5 text-slate-500" />
            <span>العلامات التجارية</span>
          </button>
          {canWriteInventory && (
            <>
              <button
                type="button"
                onClick={() => {
                  setEditingFamily(null);
                  setIsFamilyModalOpen(true);
                }}
                className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-bold shadow-sm transition-colors whitespace-nowrap shrink-0"
              >
                <Layers className="w-3.5 h-3.5 text-emerald-400" />
                <span>مجموعة بمتغيرات</span>
              </button>
              <button
                type="button"
                onClick={openAddModal}
                className="flex items-center justify-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-sm transition-colors whitespace-nowrap shrink-0"
              >
                <Plus className="w-4 h-4" />
                <span>إضافة صنف بسيط</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Search, Filter & View Mode Toolbar */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
        <div className="relative w-full lg:w-96">
          <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="بحث بالاسم، الكود، الباركود، العلامة، المجموعة، أو رقم القطعة..."
            aria-label="بحث في دليل المنتجات"
            className="w-full pl-3 pr-9 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between lg:justify-end gap-2">
          <div className="flex items-center gap-1.5 overflow-x-auto">
            <button
              type="button"
              onClick={() => setFilterType('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap shrink-0 ${
                filterType === 'all'
                  ? 'bg-slate-800 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              كافة الأصناف ({products.length})
            </button>
            <button
              type="button"
              onClick={() => setFilterType('low_stock')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap shrink-0 ${
                filterType === 'low_stock'
                  ? 'bg-rose-700 text-white'
                  : 'bg-rose-50 text-rose-800 hover:bg-rose-100'
              }`}
            >
              منخفض الرصيد
            </button>
            {(activeTab === 'pharmacy' || activeTab === 'grocery') && (
              <button
                type="button"
                onClick={() => setFilterType('expiring')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap shrink-0 ${
                  filterType === 'expiring'
                    ? 'bg-amber-700 text-white'
                    : 'bg-amber-50 text-amber-800 hover:bg-amber-100'
                }`}
              >
                قريب الانتهاء
              </button>
            )}
          </div>

          {/* Segmented View Mode Toggle: Flat SKU List vs Family Grouping */}
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg shrink-0">
            <button
              type="button"
              onClick={() => setViewMode('skus')}
              className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                viewMode === 'skus'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              عرض كل SKU
            </button>
            <button
              type="button"
              onClick={() => setViewMode('families')}
              className={`flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                viewMode === 'families'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <FolderTree className="w-3.5 h-3.5" />
              <span>تجميع حسب المجموعة</span>
            </button>
          </div>
        </div>
      </div>

      {tableError && (
        <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 text-xs flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{tableError}</span>
          </div>
          <button type="button" onClick={() => setTableError(null)} className="text-rose-600 hover:text-rose-900">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Products Table / Grouped Families View */}
      {viewMode === 'skus' ? (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-right text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 bg-slate-50">
                  <th className="py-3 px-3 text-center">الصورة</th>
                  <th className="py-3 px-4">كود الصنف (SKU)</th>
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
                {filteredEntries.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-12 text-center text-slate-400">
                      <Package className="w-8 h-8 mx-auto mb-2 text-slate-300 stroke-1" />
                      <p className="font-medium">لا توجد أصناف مسجلة في هذا القسم بعد</p>
                      <p className="text-[11px] text-slate-400 mt-1">
                        اضغط على «إضافة صنف بسيط» لصنف مستقل أو «مجموعة بمتغيرات» لصنف متعدد الخيارات
                      </p>
                    </td>
                  </tr>
                ) : (
                  filteredEntries.map((entry) => renderProductRow(entry))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {groupedCatalog.familyGroups.length === 0 && groupedCatalog.standaloneEntries.length === 0 ? (
            <div className="bg-white rounded-xl border border-slate-200 py-12 text-center text-slate-400 text-xs">
              <Package className="w-8 h-8 mx-auto mb-2 text-slate-300 stroke-1" />
              <p className="font-medium">لا توجد مجموعات أو أصناف مطابقة للبحث الحالي</p>
            </div>
          ) : (
            <>
              {groupedCatalog.familyGroups.map((group) => (
                <div
                  key={group.family.id}
                  className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm"
                >
                  <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Layers className="w-4 h-4 text-emerald-700 shrink-0" />
                        <span className="font-bold text-sm text-slate-900">{group.family.nameAr}</span>
                        {group.family.isActive === false && (
                          <span className="text-[11px] font-semibold text-amber-700">· مجموعة مؤرشفة</span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 flex items-center gap-1.5 flex-wrap">
                        {group.brand && <span>العلامة: {group.brand.nameAr}</span>}
                        {group.brand && <span aria-hidden="true">·</span>}
                        <span>
                          الخيارات: {group.family.optionSchema.map((o) => o.labelAr).join('، ')}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">
                          {group.activeSkuCount} متغير نشط
                          {group.archivedSkuCount > 0 ? ` (${group.archivedSkuCount} مؤرشف)` : ''}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-semibold text-slate-700 tabular-nums">
                          مجموع أرصدة المتغيرات (مشتق للعرض): {group.derivedTotalStock}
                        </span>
                      </div>
                    </div>

                    {canWriteInventory && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingFamily(group.family);
                          setIsFamilyModalOpen(true);
                        }}
                        className="px-3 py-1.5 border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                        <span>تعديل المجموعة</span>
                      </button>
                    )}
                  </div>

                  {group.entries.length === 0 ? (
                    <div className="p-6 text-center text-xs text-slate-400">
                      لا توجد متغيرات (SKU) مطابقة للفلاتر داخل هذه المجموعة.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[860px] text-right text-xs">
                        <thead>
                          <tr className="border-b border-slate-100 text-slate-500 bg-white">
                            <th className="py-2.5 px-3 text-center">الصورة</th>
                            <th className="py-2.5 px-4">كود SKU</th>
                            <th className="py-2.5 px-4">المتغير والتفاصيل</th>
                            <th className="py-2.5 px-4">التصنيف</th>
                            <th className="py-2.5 px-4 text-center">الرصيد</th>
                            <th className="py-2.5 px-4 text-center">الشراء</th>
                            <th className="py-2.5 px-4 text-center">البيع</th>
                            <th className="py-2.5 px-4 text-center">التشغيلات / التوافق</th>
                            <th className="py-2.5 px-4 text-center">الإجراءات</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {group.entries.map((entry) =>
                            renderProductRow(entry, { hideFamilyAndBrandMeta: true })
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}

              {groupedCatalog.standaloneEntries.length > 0 && (
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
                  <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Package className="w-4 h-4 text-slate-600" />
                      <span className="font-bold text-sm text-slate-900">
                        الأصناف البسيطة المستقلة ({groupedCatalog.standaloneEntries.length})
                      </span>
                    </div>
                    <span className="text-[11px] text-slate-500">أصناف مستقلة غير تابعة لمجموعة متغيرات</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[860px] text-right text-xs">
                      <thead>
                        <tr className="border-b border-slate-100 text-slate-500 bg-white">
                          <th className="py-2.5 px-3 text-center">الصورة</th>
                          <th className="py-2.5 px-4">كود الصنف</th>
                          <th className="py-2.5 px-4">اسم الصنف والتفاصيل</th>
                          <th className="py-2.5 px-4">التصنيف</th>
                          <th className="py-2.5 px-4 text-center">الرصيد المتاح</th>
                          <th className="py-2.5 px-4 text-center">سعر الشراء</th>
                          <th className="py-2.5 px-4 text-center">سعر البيع</th>
                          <th className="py-2.5 px-4 text-center">التشغيلات / التوافق</th>
                          <th className="py-2.5 px-4 text-center">الإجراءات</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {groupedCatalog.standaloneEntries.map((entry) => renderProductRow(entry))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Add / Edit Product Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto">
          <div className="relative w-full max-w-2xl bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
            <div className="flex items-center justify-between px-6 py-4 bg-slate-900 text-white">
              <h3 className="text-sm font-bold">
                {editingProduct
                  ? editingCatalogEntry?.family
                    ? `تعديل متغير (SKU): ${editingProduct.nameAr}`
                    : 'تعديل بيانات الصنف'
                  : 'إضافة صنف بسيط للمستودع'}
              </h3>
              <button
                type="button"
                onClick={() => setIsAddModalOpen(false)}
                aria-label="إغلاق نافذة الصنف"
                className="text-slate-400 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveProduct} className="p-6 space-y-4 text-xs max-h-[85vh] overflow-y-auto">
              {formError && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span className="font-semibold">{formError}</span>
                </div>
              )}

              {editingProduct && editingCatalogEntry?.family && (
                <div className="p-3 rounded-lg border border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2">
                  <div className="space-y-0.5">
                    <div className="font-bold text-slate-900">
                      متغير ضمن المجموعة: {editingCatalogEntry.family.nameAr}
                    </div>
                    <div className="text-[11px] text-slate-600 flex items-center gap-1.5 flex-wrap">
                      {formatVariantAttributesPairs(
                        editingCatalogEntry.variantAttributes,
                        editingCatalogEntry.family.optionSchema
                      ).map((pair, idx) => (
                        <React.Fragment key={pair.key}>
                          {idx > 0 && <span aria-hidden="true">·</span>}
                          <span>
                            {pair.label}: <strong>{pair.value}</strong>
                          </span>
                        </React.Fragment>
                      ))}
                      {editingCatalogEntry.brand && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>العلامة (من المجموعة): {editingCatalogEntry.brand.nameAr}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const fam = editingCatalogEntry.family!;
                      setIsAddModalOpen(false);
                      setEditingFamily(fam);
                      setIsFamilyModalOpen(true);
                    }}
                    className="px-3 py-1.5 border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 rounded-lg font-semibold whitespace-nowrap shrink-0"
                  >
                    تعديل المجموعة
                  </button>
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
                  <label className="block font-semibold text-slate-700 mb-1">التصنيف</label>
                  <input
                    type="text"
                    value={formCategory}
                    onChange={(e) => setFormCategory(e.target.value)}
                    placeholder="مثال: مسكنات، معلبات، فلاتر، محركات..."
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                {!editingCatalogEntry?.family && (
                  <div>
                    <label htmlFor="simple-product-brand" className="block font-semibold text-slate-700 mb-1">
                      العلامة التجارية (اختياري)
                    </label>
                    <select
                      id="simple-product-brand"
                      value={formBrandId}
                      onChange={(e) => setFormBrandId(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    >
                      <option value="">بدون علامة تجارية</option>
                      {brands
                        .filter((b) => b.isActive !== false || b.id === formBrandId)
                        .map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.nameAr}
                            {b.isActive === false ? ' (مؤرشفة)' : ''}
                          </option>
                        ))}
                    </select>
                  </div>
                )}

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

              {/* إدارة الوحدات البديلة — تعريف فقط دون حركة مخزون أو أسعار */}
              <div className="p-3 rounded-lg border border-indigo-100 bg-indigo-50/40 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-bold text-slate-900">الوحدات البديلة</div>
                    <p className="text-[11px] text-slate-600 mt-1">
                      وحدة المخزون الأساسية لهذا الصنف هي: <strong>{editingProduct?.unit || formUnit}</strong>. معامل الوحدة البديلة يُحسب بالنسبة إليها.
                    </p>
                  </div>
                  <span className="text-[10px] text-indigo-700 bg-indigo-100 px-2 py-1 rounded">تعريف فقط</span>
                </div>
                {!editingProduct ? (
                  <p className="text-[11px] text-slate-600 bg-white rounded-lg p-2 border border-slate-200">
                    احفظ الصنف أولًا، ثم افتح «تعديل بيانات الصنف» لإضافة وحداته البديلة. لن يتغير المخزون عند تعريف الوحدة.
                  </p>
                ) : (
                  <>
                    {unitError && <div className="text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2">{unitError}</div>}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <label className="block text-slate-700 mb-1">رمز الوحدة *</label>
                        <input value={unitDraft.code} onChange={(e) => setUnitDraft((v) => ({ ...v, code: e.target.value }))} placeholder="CARTON" className="w-full px-3 py-2 border border-slate-200 rounded-lg bg-white font-mono" />
                      </div>
                      <div>
                        <label className="block text-slate-700 mb-1">اسم الوحدة *</label>
                        <input value={unitDraft.nameAr} onChange={(e) => setUnitDraft((v) => ({ ...v, nameAr: e.target.value }))} placeholder="كرتون" className="w-full px-3 py-2 border border-slate-200 rounded-lg bg-white" />
                      </div>
                      <div>
                        <label className="block text-slate-700 mb-1">عدد وحدات الأساس *</label>
                        <input type="number" min="1" step="1" value={unitDraft.numerator} onChange={(e) => setUnitDraft((v) => ({ ...v, numerator: e.target.value }))} className="w-full px-3 py-2 border border-slate-200 rounded-lg bg-white font-mono" />
                      </div>
                      <div>
                        <label className="block text-slate-700 mb-1">على عدد *</label>
                        <input type="number" min="1" step="1" value={unitDraft.denominator} onChange={(e) => setUnitDraft((v) => ({ ...v, denominator: e.target.value }))} className="w-full px-3 py-2 border border-slate-200 rounded-lg bg-white font-mono" />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-slate-700 mb-1">باركود الوحدة (اختياري)</label>
                        <input value={unitDraft.barcode} onChange={(e) => setUnitDraft((v) => ({ ...v, barcode: e.target.value }))} placeholder="يُحفظ كنص للمحافظة على الأصفار الأولى" className="w-full px-3 py-2 border border-slate-200 rounded-lg bg-white font-mono" />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      {unitDraft.id && <button type="button" onClick={() => setUnitDraft({ id: '', code: '', nameAr: '', numerator: '1', denominator: '1', barcode: '' })} className="px-3 py-1.5 border border-slate-200 bg-white rounded-lg text-slate-600">إلغاء التعديل</button>}
                      <button type="button" disabled={isSavingUnit} onClick={() => void handleSaveProductUnit()} className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white rounded-lg font-bold">
                        {isSavingUnit ? 'جارٍ الحفظ...' : unitDraft.id ? 'حفظ تعديل الوحدة' : 'إضافة الوحدة'}
                      </button>
                    </div>
                    <div className="space-y-2">
                      {isLoadingUnits ? (
                        <p className="text-[11px] text-slate-500 text-center py-2">جارٍ تحميل الوحدات البديلة...</p>
                      ) : productUnits.length === 0 ? (
                        <p className="text-[11px] text-slate-500 text-center py-2">لا توجد وحدات بديلة لهذا الصنف.</p>
                      ) : productUnits.map((unit) => (
                        <div key={unit.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-white border border-slate-200 rounded-lg p-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <strong className="text-slate-900">{unit.nameAr}</strong>
                              <span className="font-mono text-[10px] text-slate-500">{unit.code}</span>
                              <span className={unit.isActive ? 'text-[10px] text-emerald-700' : 'text-[10px] text-slate-500'}>{unit.isActive ? 'نشطة' : 'معطلة'}</span>
                            </div>
                            <p className="text-[11px] text-slate-600 mt-1">
                              {unit.baseUnitsNumerator}/{unit.baseUnitsDenominator} من وحدة الأساس {editingProduct.unit}
                              {unit.barcode ? <span className="font-mono"> · باركود: {unit.barcode}</span> : null}
                            </p>
                          </div>
                          <div className="flex gap-1 shrink-0">
                            <button type="button" onClick={() => startEditProductUnit(unit)} className="px-2 py-1 text-[11px] text-indigo-700 bg-indigo-50 rounded">تعديل</button>
                            <button type="button" disabled={isSavingUnit} onClick={() => void handleToggleProductUnit(unit)} className="px-2 py-1 text-[11px] text-slate-700 bg-slate-100 rounded">{unit.isActive ? 'تعطيل' : 'تفعيل'}</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
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
                  disabled={isSubmitting || isLoadingUnits}
                  className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-bold rounded-lg transition-colors flex items-center gap-1.5"
                >
                  <Check className="w-4 h-4" />
                  <span>{isLoadingUnits ? 'جارٍ تحميل الوحدات...' : isSubmitting ? 'جارٍ الحفظ...' : 'حفظ الصنف'}</span>
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

      <BrandManagerModal
        isOpen={isBrandModalOpen}
        onClose={() => setIsBrandModalOpen(false)}
        onChanged={triggerCatalogRefresh}
        canWrite={canWriteInventory}
      />

      <ProductFamilyModal
        isOpen={isFamilyModalOpen}
        activityId={activeTab}
        activityLabel={activeActivityLabel}
        editingFamily={editingFamily}
        brands={brands}
        existingCodes={products.map((p) => p.code)}
        onClose={() => {
          setIsFamilyModalOpen(false);
          setEditingFamily(null);
        }}
        onSaved={triggerCatalogRefresh}
        onBrandsChanged={triggerCatalogRefresh}
      />
    </div>
  );
};
