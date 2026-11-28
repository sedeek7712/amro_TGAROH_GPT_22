import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Check,
  Layers,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { dataService } from '../../services/dataService';
import { storage } from '../../services/storageService';
import { formatLocalDate } from '../../utils/localDate';
import {
  buildOptionSchemaFromDrafts,
  buildSkuProductPayload,
  generateVariantCombinations,
  parseOptionValuesList,
  validateFamilySkuDrafts,
  VariantOptionDraft,
  VariantSkuDraft,
} from '../../utils/productCatalogUi';
import type { ActivityId, Brand, ProductFamily } from '../../types/erp';

interface ProductFamilyModalProps {
  isOpen: boolean;
  activityId: ActivityId;
  activityLabel: string;
  editingFamily: ProductFamily | null;
  brands: Brand[];
  existingCodes?: string[];
  onClose: () => void;
  onSaved: () => void;
  onBrandsChanged: () => void;
}

const DEFAULT_OPTION_DRAFTS: VariantOptionDraft[] = [
  { tempId: 'opt-1', key: 'color', labelAr: 'اللون', valuesText: 'أبيض، أسود' },
  { tempId: 'opt-2', key: 'size', labelAr: 'المقاس', valuesText: 'M، L' },
];

export const ProductFamilyModal: React.FC<ProductFamilyModalProps> = ({
  isOpen,
  activityId,
  activityLabel,
  editingFamily,
  brands,
  existingCodes,
  onClose,
  onSaved,
  onBrandsChanged,
}) => {
  const isDesktop = typeof window !== 'undefined' && Boolean(window.amroDesktop);
  const [nameAr, setNameAr] = useState('');
  const [categorySnapshot, setCategorySnapshot] = useState('');
  const [brandId, setBrandId] = useState('');
  const [quickBrandName, setQuickBrandName] = useState('');
  const [showQuickBrand, setShowQuickBrand] = useState(false);

  const [optionDrafts, setOptionDrafts] = useState<VariantOptionDraft[]>(DEFAULT_OPTION_DRAFTS);

  // قيم افتراضية جماعية لتسهيل تعبئة متغيرات SKU
  const [defaultUnit, setDefaultUnit] = useState('حبة');
  const [defaultPurchasePrice, setDefaultPurchasePrice] = useState('');
  const [defaultSellPrice, setDefaultSellPrice] = useState('');
  const [defaultInitialStock, setDefaultInitialStock] = useState('0');
  const [defaultMinAlert, setDefaultMinAlert] = useState('5');
  const [defaultBatch, setDefaultBatch] = useState('');
  const [defaultExpiry, setDefaultExpiry] = useState('');
  const [defaultTrackExpiry, setDefaultTrackExpiry] = useState(false);
  const [defaultScientificName, setDefaultScientificName] = useState('');
  const [defaultDosageForm, setDefaultDosageForm] = useState('');
  const [defaultManufacturer, setDefaultManufacturer] = useState('');
  const [defaultCompatibleModels, setDefaultCompatibleModels] = useState('');
  const [defaultEquipmentType, setDefaultEquipmentType] = useState('');

  const [skuDrafts, setSkuDrafts] = useState<VariantSkuDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setShowQuickBrand(false);
    setQuickBrandName('');

    if (editingFamily) {
      setNameAr(editingFamily.nameAr);
      setCategorySnapshot(editingFamily.categorySnapshot || '');
      setBrandId(editingFamily.brandId || '');
      setOptionDrafts(
        editingFamily.optionSchema.map((opt, idx) => ({
          tempId: `edit-opt-${idx}-${opt.key}`,
          key: opt.key,
          labelAr: opt.labelAr,
          valuesText: opt.values.join('، '),
        }))
      );
      setSkuDrafts([]);
    } else {
      setNameAr('');
      setCategorySnapshot('');
      setBrandId('');
      setOptionDrafts([
        { tempId: 'opt-1', key: 'color', labelAr: 'اللون', valuesText: '' },
      ]);
      setDefaultUnit('حبة');
      setDefaultPurchasePrice('');
      setDefaultSellPrice('');
      setDefaultInitialStock('0');
      setDefaultMinAlert('5');
      setDefaultBatch('');
      setDefaultExpiry('');
      setDefaultTrackExpiry(false);
      setDefaultScientificName('');
      setDefaultDosageForm('');
      setDefaultManufacturer('');
      setDefaultCompatibleModels('');
      setDefaultEquipmentType('');
      setSkuDrafts([]);
    }
  }, [isOpen, editingFamily]);

  const activeBrands = useMemo(
    () => brands.filter((b) => b.isActive !== false || b.id === brandId),
    [brands, brandId]
  );

  if (!isOpen) return null;

  const handleQuickCreateBrand = async () => {
    const trimmed = quickBrandName.trim();
    if (!trimmed || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const saved = await dataService.saveBrandAtomic({ nameAr: trimmed });
      setBrandId(saved.id);
      setQuickBrandName('');
      setShowQuickBrand(false);
      onBrandsChanged();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر إضافة العلامة التجارية.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddOptionRow = () => {
    setOptionDrafts((prev) => [
      ...prev,
      {
        tempId: `opt-${Date.now()}-${prev.length}`,
        key: '',
        labelAr: '',
        valuesText: '',
      },
    ]);
  };

  const handleRemoveOptionRow = (tempId: string) => {
    setOptionDrafts((prev) => (prev.length <= 1 ? prev : prev.filter((item) => item.tempId !== tempId)));
  };

  const handleApplyPresetColorSize = () => {
    setOptionDrafts([
      { tempId: 'preset-color', key: 'color', labelAr: 'اللون', valuesText: 'أبيض، أسود' },
      { tempId: 'preset-size', key: 'size', labelAr: 'المقاس', valuesText: 'M، L' },
    ]);
    setError(null);
  };

  const handleGeneratePreview = () => {
    setError(null);
    try {
      if (!nameAr.trim()) {
        throw new Error('أدخل اسم مجموعة المنتجات أولًا قبل توليد معاينة المتغيرات.');
      }
      const schema = buildOptionSchemaFromDrafts(optionDrafts);
      const nextDrafts = generateVariantCombinations({
        familyName: nameAr.trim(),
        activityId,
        optionSchema: schema,
        defaults: {
          unit: defaultUnit,
          purchasePrice: defaultPurchasePrice,
          sellPrice: defaultSellPrice,
          minStockAlert: defaultMinAlert,
          currentStock: defaultInitialStock,
          batchNumber: defaultBatch,
          expiryDate: defaultExpiry,
        },
        existingDrafts: skuDrafts,
        existingCodes,
      });
      setSkuDrafts(nextDrafts);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر توليد معاينة المتغيرات.');
    }
  };

  const handleApplyDefaultsToSelected = () => {
    setSkuDrafts((prev) =>
      prev.map((row) =>
        row.selected
          ? {
              ...row,
              unit: defaultUnit,
              ...(defaultPurchasePrice !== '' ? { purchasePrice: defaultPurchasePrice } : {}),
              ...(defaultSellPrice !== '' ? { sellPrice: defaultSellPrice } : {}),
              ...(defaultMinAlert !== '' ? { minStockAlert: defaultMinAlert } : {}),
              ...(defaultInitialStock !== '' ? { currentStock: defaultInitialStock } : {}),
              ...(defaultBatch !== '' ? { batchNumber: defaultBatch } : {}),
              ...(defaultExpiry !== '' ? { expiryDate: defaultExpiry } : {}),
            }
          : row
      )
    );
  };

  const handleSubmitCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    try {
      const cleanName = nameAr.trim();
      if (!cleanName) {
        throw new Error('اسم مجموعة المنتجات مطلوب.');
      }
      const schema = buildOptionSchemaFromDrafts(optionDrafts);
      const activeDrafts =
        skuDrafts.length > 0
          ? skuDrafts
          : generateVariantCombinations({
              familyName: cleanName,
              activityId,
              optionSchema: schema,
              defaults: {
                unit: defaultUnit,
                purchasePrice: defaultPurchasePrice,
                sellPrice: defaultSellPrice,
                minStockAlert: defaultMinAlert,
                currentStock: defaultInitialStock,
                batchNumber: defaultBatch,
                expiryDate: defaultExpiry,
              },
              existingCodes: existingCodes ?? [],
            });

      if (skuDrafts.length === 0) {
        setSkuDrafts(activeDrafts);
      }

      const specializedDefaults =
        activityId === 'pharmacy'
          ? {
              trackExpiry: true,
              scientificName: defaultScientificName.trim() || undefined,
              dosageForm: defaultDosageForm.trim() || undefined,
            }
          : activityId === 'grocery'
          ? { trackExpiry: defaultTrackExpiry }
          : activityId === 'bike_parts'
          ? {
              manufacturer: defaultManufacturer.trim() || undefined,
              compatibleModels: defaultCompatibleModels.trim() || undefined,
            }
          : {
              manufacturer: defaultManufacturer.trim() || undefined,
              compatibleModels: defaultCompatibleModels.trim() || undefined,
              equipmentType: defaultEquipmentType.trim() || undefined,
            };

      const selectedDrafts = validateFamilySkuDrafts({
        activityId,
        drafts: activeDrafts,
        todayDate: formatLocalDate(),
        trackExpiry: activityId === 'pharmacy' || (activityId === 'grocery' && defaultTrackExpiry),
      });

      setSubmitting(true);
      await dataService.createProductFamilyWithSkusAtomic({
        activityId,
        nameAr: cleanName,
        categorySnapshot: categorySnapshot.trim(),
        ...(brandId ? { brandId } : {}),
        optionSchema: schema,
        skus: selectedDrafts.map((draft) => {
          const payload = buildSkuProductPayload({
            draft,
            activityId,
            categorySnapshot: categorySnapshot.trim(),
            generateId: () => storage.generateUUID(),
            specializedDefaults,
          });
          const useAtomicAutoCode = isDesktop && !draft.codeManuallyEdited;
          return {
            product: useAtomicAutoCode
              ? { ...payload, code: '', autoGenerateCode: true }
              : payload,
            variantAttributes: draft.variantAttributes,
          };
        }),
      });
      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر حفظ مجموعة المنتجات والمتغيرات.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingFamily || submitting) return;
    setError(null);
    try {
      const cleanName = nameAr.trim();
      if (!cleanName) {
        throw new Error('اسم مجموعة المنتجات مطلوب.');
      }
      const schema = buildOptionSchemaFromDrafts(optionDrafts);
      setSubmitting(true);
      await dataService.updateProductFamilyAtomic({
        id: editingFamily.id,
        nameAr: cleanName,
        categorySnapshot: categorySnapshot.trim(),
        brandId: brandId ? brandId : null,
        optionSchema: schema,
      });
      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحديث مجموعة المنتجات.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleArchiveFamily = async () => {
    if (!editingFamily || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      if (editingFamily.isActive !== false) {
        await dataService.archiveProductFamilyAtomic(editingFamily.id);
      } else {
        await dataService.updateProductFamilyAtomic({
          id: editingFamily.id,
          nameAr: editingFamily.nameAr,
          isActive: true,
        });
      }
      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحديث حالة أرشفة المجموعة.');
    } finally {
      setSubmitting(false);
    }
  };

  const selectedCount = skuDrafts.filter((d) => d.selected).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto"
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="product-family-modal-title"
    >
      <div className="relative w-full max-w-5xl bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200 my-auto max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 bg-slate-900 text-white shrink-0">
          <div className="flex items-center gap-2.5">
            <Layers className="w-4 h-4 text-emerald-400" />
            <div>
              <h3 id="product-family-modal-title" className="text-sm font-bold">
                {editingFamily
                  ? `تعديل مجموعة المنتجات: ${editingFamily.nameAr}`
                  : 'إضافة منتج بمتغيرات (مجموعة + وحدات SKU)'}
              </h3>
              <p className="text-[11px] text-slate-300">
                النشاط: {activityLabel} · المجموعة للتنظيم فقط والمخزون والبيع على مستوى كل SKU
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق نافذة مجموعة المنتجات"
            className="text-slate-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form
          onSubmit={editingFamily ? handleSubmitEdit : handleSubmitCreate}
          className="p-5 sm:p-6 space-y-5 text-xs overflow-y-auto flex-1"
        >
          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
              <span className="font-semibold">{error}</span>
            </div>
          )}

          {/* 1. بيانات المجموعة الأساسية */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label htmlFor="family-name-input" className="block font-semibold text-slate-700 mb-1">
                اسم المجموعة الأب *
              </label>
              <input
                id="family-name-input"
                type="text"
                required
                value={nameAr}
                onChange={(e) => setNameAr(e.target.value)}
                placeholder="مثال: قميص قطني / فلتر زيت / شراب فيتامين..."
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>

            <div>
              <label htmlFor="family-category-input" className="block font-semibold text-slate-700 mb-1">
                التصنيف
              </label>
              <input
                id="family-category-input"
                type="text"
                value={categorySnapshot}
                onChange={(e) => setCategorySnapshot(e.target.value)}
                placeholder="مثال: ملابس، فلاتر، مشروبات..."
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="family-brand-select" className="font-semibold text-slate-700">
                  العلامة التجارية (اختياري)
                </label>
                <button
                  type="button"
                  onClick={() => setShowQuickBrand((v) => !v)}
                  className="text-[11px] font-semibold text-emerald-700 hover:underline whitespace-nowrap"
                >
                  {showQuickBrand ? 'إخفاء' : '+ علامة جديدة'}
                </button>
              </div>
              <select
                id="family-brand-select"
                value={brandId}
                onChange={(e) => setBrandId(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-500"
              >
                <option value="">بدون علامة تجارية</option>
                {activeBrands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.nameAr}
                    {b.isActive === false ? ' (مؤرشفة)' : ''}
                  </option>
                ))}
              </select>

              {showQuickBrand && (
                <div className="mt-2 flex items-center gap-1.5">
                  <input
                    type="text"
                    value={quickBrandName}
                    onChange={(e) => setQuickBrandName(e.target.value)}
                    placeholder="اسم العلامة الجديدة..."
                    className="flex-1 px-2.5 py-1.5 border border-slate-200 rounded-lg bg-slate-50 text-slate-900"
                  />
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void handleQuickCreateBrand()}
                    className="px-2.5 py-1.5 bg-slate-900 text-white rounded-lg font-semibold whitespace-nowrap shrink-0"
                  >
                    حفظ
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* 2. خيارات المتغيرات */}
          <div className="p-4 rounded-lg border border-slate-200 bg-slate-50/70 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="font-bold text-slate-900">خيارات المتغيرات</h4>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  أضف سمات التمييز وقيمها مفصولة بفاصلة (مثل: أبيض، أسود).
                  {editingFamily
                    ? ' يمكن إضافة قيم جديدة دون حذف قيم مرتبطة بمتغيرات قائمة.'
                    : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {!editingFamily && (
                  <button
                    type="button"
                    onClick={handleApplyPresetColorSize}
                    className="px-3 py-1.5 border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 rounded-lg font-semibold whitespace-nowrap shrink-0"
                  >
                    نموذج: اللون والمقاس
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleAddOptionRow}
                  className="px-3 py-1.5 border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 rounded-lg font-semibold flex items-center gap-1 whitespace-nowrap shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>إضافة خيار</span>
                </button>
              </div>
            </div>

            <div className="space-y-2.5">
              {optionDrafts.map((opt, idx) => {
                const parsedCount = parseOptionValuesList(opt.valuesText).length;
                return (
                  <div
                    key={opt.tempId}
                    className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end bg-white p-2.5 rounded-lg border border-slate-200"
                  >
                    <div className="sm:col-span-4">
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        اسم الخيار #{idx + 1} *
                      </label>
                      <input
                        type="text"
                        value={opt.labelAr}
                        onChange={(e) => {
                          const val = e.target.value;
                          setOptionDrafts((prev) =>
                            prev.map((item) =>
                              item.tempId === opt.tempId ? { ...item, labelAr: val } : item
                            )
                          );
                        }}
                        placeholder="مثال: اللون، المقاس، السعة..."
                        className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-slate-900"
                      />
                    </div>

                    <div className="sm:col-span-7">
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-[11px] font-semibold text-slate-700">
                          القيم المتاحة *
                        </label>
                        <span className="text-[11px] text-slate-500 tabular-nums">
                          {parsedCount} قيم
                        </span>
                      </div>
                      <input
                        type="text"
                        value={opt.valuesText}
                        onChange={(e) => {
                          const val = e.target.value;
                          setOptionDrafts((prev) =>
                            prev.map((item) =>
                              item.tempId === opt.tempId ? { ...item, valuesText: val } : item
                            )
                          );
                        }}
                        placeholder="مثال: أبيض، أسود، أزرق"
                        className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-slate-900"
                      />
                    </div>

                    <div className="sm:col-span-1 flex justify-end">
                      <button
                        type="button"
                        disabled={optionDrafts.length <= 1}
                        onClick={() => handleRemoveOptionRow(opt.tempId)}
                        aria-label={`حذف الخيار ${opt.labelAr || idx + 1}`}
                        className="p-2 text-slate-400 hover:text-rose-600 disabled:opacity-30 rounded-lg"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 3. القيم الافتراضية ومعاينة تركيبات SKU (عند الإنشاء فقط) */}
          {!editingFamily && (
            <>
              <div className="p-4 rounded-lg border border-slate-200 bg-white space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h4 className="font-bold text-slate-900">القيم الافتراضية لتوليد المتغيرات</h4>
                    <p className="text-[11px] text-slate-500">
                      تُطبَّق تلقائيًا عند توليد المعاينة، ويمكنك تعديل كل متغير (SKU) لاحقًا بشكل مستقل.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {skuDrafts.length > 0 && (
                      <button
                        type="button"
                        onClick={handleApplyDefaultsToSelected}
                        className="px-3 py-1.5 border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-lg font-semibold whitespace-nowrap shrink-0"
                      >
                        تطبيق الافتراضيات على المحدد
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleGeneratePreview}
                      className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg font-bold whitespace-nowrap shrink-0"
                    >
                      {skuDrafts.length > 0 ? 'تحديث معاينة المتغيرات' : 'توليد معاينة المتغيرات'}
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                      وحدة الأساس
                    </label>
                    <select
                      value={defaultUnit}
                      onChange={(e) => setDefaultUnit(e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg bg-white text-slate-900"
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
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                      سعر الشراء الافتراضي
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={defaultPurchasePrice}
                      onChange={(e) => setDefaultPurchasePrice(e.target.value)}
                      placeholder="0.00"
                      className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg font-mono tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                      سعر البيع الافتراضي
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={defaultSellPrice}
                      onChange={(e) => setDefaultSellPrice(e.target.value)}
                      placeholder="0.00"
                      className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg font-mono tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                      الرصيد الافتتاحي
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={defaultInitialStock}
                      onChange={(e) => setDefaultInitialStock(e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg font-mono tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                      حد التنبيه
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={defaultMinAlert}
                      onChange={(e) => setDefaultMinAlert(e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg font-mono tabular-nums"
                    />
                  </div>
                </div>

                {activityId === 'pharmacy' && (
                  <div className="space-y-3 pt-2 border-t border-slate-100">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                          الاسم العلمي للمادة الفعالة (اختياري)
                        </label>
                        <input
                          type="text"
                          value={defaultScientificName}
                          onChange={(e) => setDefaultScientificName(e.target.value)}
                          placeholder="مثال: Paracetamol, Amoxicillin..."
                          className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                          الشكل الدوائي (اختياري)
                        </label>
                        <input
                          type="text"
                          value={defaultDosageForm}
                          onChange={(e) => setDefaultDosageForm(e.target.value)}
                          placeholder="مثال: أقراص، شراب، كبسولات..."
                          className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] font-semibold text-emerald-900 mb-1">
                          رقم التشغيلة الافتراضي لكل SKU (إجباري للصيدلية)
                        </label>
                        <input
                          type="text"
                          value={defaultBatch}
                          onChange={(e) => setDefaultBatch(e.target.value)}
                          placeholder="مثال: BTH-2026-01"
                          className="w-full px-2.5 py-1.5 border border-emerald-300 rounded-lg font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-emerald-900 mb-1">
                          تاريخ الصلاحية الافتراضي لكل SKU (إجباري للصيدلية)
                        </label>
                        <input
                          type="date"
                          min={formatLocalDate()}
                          value={defaultExpiry}
                          onChange={(e) => setDefaultExpiry(e.target.value)}
                          className="w-full px-2.5 py-1.5 border border-emerald-300 rounded-lg font-mono"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {activityId === 'grocery' && (
                  <div className="space-y-3 pt-2 border-t border-slate-100">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={defaultTrackExpiry}
                        onChange={(e) => setDefaultTrackExpiry(e.target.checked)}
                        className="w-4 h-4 rounded text-amber-600 focus:ring-amber-500"
                      />
                      <span className="text-[11px] font-bold text-amber-900">
                        تفعيل تتبع التشغيلات والصلاحية لمتغيرات هذا الصنف الغذائي (اختياري)
                      </span>
                    </label>
                    {defaultTrackExpiry && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] font-semibold text-amber-900 mb-1">
                            رقم التشغيلة الافتراضي (اختياري)
                          </label>
                          <input
                            type="text"
                            value={defaultBatch}
                            onChange={(e) => setDefaultBatch(e.target.value)}
                            placeholder="مثال: LOT-2026-01"
                            className="w-full px-2.5 py-1.5 border border-amber-300 rounded-lg font-mono"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-amber-900 mb-1">
                            تاريخ الصلاحية الافتراضي (اختياري)
                          </label>
                          <input
                            type="date"
                            min={formatLocalDate()}
                            value={defaultExpiry}
                            onChange={(e) => setDefaultExpiry(e.target.value)}
                            className="w-full px-2.5 py-1.5 border border-amber-300 rounded-lg font-mono"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {(activityId === 'bike_parts' || activityId === 'equipment_parts') && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-slate-100">
                    <div>
                      <label className="block text-[11px] font-semibold text-blue-900 mb-1">
                        الشركة المصنعة (اختياري)
                      </label>
                      <input
                        type="text"
                        value={defaultManufacturer}
                        onChange={(e) => setDefaultManufacturer(e.target.value)}
                        placeholder="مثال: Honda, Yamaha, CAT..."
                        className="w-full px-2.5 py-1.5 border border-blue-200 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-blue-900 mb-1">
                        الموديلات المتوافقة (اختياري)
                      </label>
                      <input
                        type="text"
                        value={defaultCompatibleModels}
                        onChange={(e) => setDefaultCompatibleModels(e.target.value)}
                        placeholder="مثال: 2020-2026..."
                        className="w-full px-2.5 py-1.5 border border-blue-200 rounded-lg"
                      />
                    </div>
                    {activityId === 'equipment_parts' && (
                      <div>
                        <label className="block text-[11px] font-semibold text-blue-900 mb-1">
                          نوع المعدة (اختياري)
                        </label>
                        <input
                          type="text"
                          value={defaultEquipmentType}
                          onChange={(e) => setDefaultEquipmentType(e.target.value)}
                          placeholder="مثال: مضخة مياه، مولد..."
                          className="w-full px-2.5 py-1.5 border border-blue-200 rounded-lg"
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* جدول المعاينة قبل الحفظ */}
              {skuDrafts.length > 0 && (
                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b border-slate-200">
                    <span className="font-bold text-slate-800">
                      معاينة المتغيرات القابلة للبيع (SKU): {selectedCount} من {skuDrafts.length} محدد
                    </span>
                    <span className="text-[11px] text-slate-500">
                      ألغِ تحديد أي تركيبة غير متوفرة قبل الحفظ
                    </span>
                  </div>
                  <div className="overflow-x-auto max-h-80">
                    <table className="w-full text-right text-[11px]">
                      <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 sticky top-0">
                        <tr>
                          <th className="py-2 px-2.5 text-center">إدراج</th>
                          <th className="py-2 px-2.5">تركيبة المتغير</th>
                          <th className="py-2 px-2.5">اسم SKU *</th>
                          <th className="py-2 px-2.5">كود SKU *</th>
                          <th className="py-2 px-2.5">الباركود</th>
                          <th className="py-2 px-2.5">الشراء</th>
                          <th className="py-2 px-2.5">البيع</th>
                          <th className="py-2 px-2.5">الرصيد</th>
                          {(activityId === 'pharmacy' || (activityId === 'grocery' && defaultTrackExpiry)) && (
                            <>
                              <th className="py-2 px-2.5">
                                {activityId === 'pharmacy' ? 'التشغيلة (لكل SKU) *' : 'التشغيلة (اختياري)'}
                              </th>
                              <th className="py-2 px-2.5">
                                {activityId === 'pharmacy' ? 'الصلاحية *' : 'الصلاحية'}
                              </th>
                            </>
                          )}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {skuDrafts.map((row) => {
                          const attrsSummary = Object.values(row.variantAttributes).join(' · ');
                          return (
                            <tr
                              key={row.tempId}
                              className={row.selected ? 'bg-white' : 'bg-slate-50/70 opacity-60'}
                            >
                              <td className="py-2 px-2.5 text-center">
                                <input
                                  type="checkbox"
                                  checked={row.selected}
                                  aria-label={`تضمين المتغير ${attrsSummary}`}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    setSkuDrafts((prev) =>
                                      prev.map((d) =>
                                        d.tempId === row.tempId ? { ...d, selected: checked } : d
                                      )
                                    );
                                  }}
                                />
                              </td>
                              <td className="py-2 px-2.5 font-semibold text-slate-700 whitespace-nowrap">
                                {attrsSummary}
                              </td>
                              <td className="py-1.5 px-2">
                                <input
                                  type="text"
                                  value={row.nameAr}
                                  disabled={!row.selected}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setSkuDrafts((prev) =>
                                      prev.map((d) =>
                                        d.tempId === row.tempId ? { ...d, nameAr: val } : d
                                      )
                                    );
                                  }}
                                  className="w-40 px-2 py-1 border border-slate-200 rounded bg-white text-slate-900"
                                />
                              </td>
                              <td className="py-1.5 px-2">
                                <input
                                  type="text"
                                  value={row.code}
                                  disabled={!row.selected}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setSkuDrafts((prev) =>
                                      prev.map((d) =>
                                        d.tempId === row.tempId
                                          ? { ...d, code: val, codeManuallyEdited: true }
                                          : d
                                      )
                                    );
                                  }}
                                  className="w-28 px-2 py-1 border border-slate-200 rounded bg-white font-mono text-slate-900"
                                />
                              </td>
                              <td className="py-1.5 px-2">
                                <input
                                  type="text"
                                  value={row.barcode}
                                  disabled={!row.selected}
                                  placeholder="اختياري"
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setSkuDrafts((prev) =>
                                      prev.map((d) =>
                                        d.tempId === row.tempId ? { ...d, barcode: val } : d
                                      )
                                    );
                                  }}
                                  className="w-28 px-2 py-1 border border-slate-200 rounded bg-white font-mono text-slate-900"
                                />
                              </td>
                              <td className="py-1.5 px-2">
                                <input
                                  type="number"
                                  min="0"
                                  step="any"
                                  value={row.purchasePrice}
                                  disabled={!row.selected}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setSkuDrafts((prev) =>
                                      prev.map((d) =>
                                        d.tempId === row.tempId ? { ...d, purchasePrice: val } : d
                                      )
                                    );
                                  }}
                                  className="w-20 px-2 py-1 border border-slate-200 rounded bg-white font-mono tabular-nums"
                                />
                              </td>
                              <td className="py-1.5 px-2">
                                <input
                                  type="number"
                                  min="0"
                                  step="any"
                                  value={row.sellPrice}
                                  disabled={!row.selected}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setSkuDrafts((prev) =>
                                      prev.map((d) =>
                                        d.tempId === row.tempId ? { ...d, sellPrice: val } : d
                                      )
                                    );
                                  }}
                                  className="w-20 px-2 py-1 border border-slate-200 rounded bg-white font-mono tabular-nums"
                                />
                              </td>
                              <td className="py-1.5 px-2">
                                <input
                                  type="number"
                                  min="0"
                                  step="any"
                                  value={row.currentStock}
                                  disabled={!row.selected}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setSkuDrafts((prev) =>
                                      prev.map((d) =>
                                        d.tempId === row.tempId ? { ...d, currentStock: val } : d
                                      )
                                    );
                                  }}
                                  className="w-16 px-2 py-1 border border-slate-200 rounded bg-white font-mono tabular-nums"
                                />
                              </td>
                              {(activityId === 'pharmacy' || (activityId === 'grocery' && defaultTrackExpiry)) && (
                                <>
                                  <td className="py-1.5 px-2">
                                    <input
                                      type="text"
                                      value={row.batchNumber}
                                      disabled={!row.selected}
                                      placeholder={activityId === 'grocery' ? 'اختياري' : ''}
                                      onChange={(e) => {
                                        const val = e.target.value;
                                        setSkuDrafts((prev) =>
                                          prev.map((d) =>
                                            d.tempId === row.tempId ? { ...d, batchNumber: val } : d
                                          )
                                        );
                                      }}
                                      className={`w-24 px-2 py-1 border rounded bg-white font-mono ${
                                        activityId === 'pharmacy' ? 'border-emerald-300' : 'border-amber-300'
                                      }`}
                                    />
                                  </td>
                                  <td className="py-1.5 px-2">
                                    <input
                                      type="date"
                                      min={formatLocalDate()}
                                      value={row.expiryDate}
                                      disabled={!row.selected}
                                      onChange={(e) => {
                                        const val = e.target.value;
                                        setSkuDrafts((prev) =>
                                          prev.map((d) =>
                                            d.tempId === row.tempId ? { ...d, expiryDate: val } : d
                                          )
                                        );
                                      }}
                                      className={`w-32 px-2 py-1 border rounded bg-white font-mono ${
                                        activityId === 'pharmacy' ? 'border-emerald-300' : 'border-amber-300'
                                      }`}
                                    />
                                  </td>
                                </>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}

          {/* شريط الإجراءات السفلي */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-slate-100">
            <div>
              {editingFamily && (
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void handleToggleArchiveFamily()}
                  className={`px-3.5 py-2 rounded-lg font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                    editingFamily.isActive !== false
                      ? 'border border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
                      : 'border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                  }`}
                >
                  {editingFamily.isActive !== false ? (
                    <>
                      <Archive className="w-4 h-4" />
                      <span>أرشفة المجموعة (مع حفظ SKUs)</span>
                    </>
                  ) : (
                    <>
                      <RotateCcw className="w-4 h-4" />
                      <span>إعادة تفعيل المجموعة</span>
                    </>
                  )}
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-bold rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <Check className="w-4 h-4" />
                <span>
                  {submitting
                    ? 'جارٍ الحفظ...'
                    : editingFamily
                    ? 'حفظ تعديلات المجموعة'
                    : 'حفظ المجموعة والمتغيرات'}
                </span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
