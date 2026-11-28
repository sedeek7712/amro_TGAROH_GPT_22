import React, { useEffect, useState } from 'react';
import { AlertTriangle, Archive, Check, Edit2, Plus, RotateCcw, Tag, X } from 'lucide-react';
import { dataService } from '../../services/dataService';
import type { Brand } from '../../types/erp';

interface BrandManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onChanged: () => void;
  canWrite: boolean;
}

export const BrandManagerModal: React.FC<BrandManagerModalProps> = ({
  isOpen,
  onClose,
  onChanged,
  canWrite,
}) => {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [editingBrandId, setEditingBrandId] = useState<string>('');
  const [brandName, setBrandName] = useState('');

  const loadBrands = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await dataService.getBrands(true);
      setBrands(list);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل العلامات التجارية.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setEditingBrandId('');
      setBrandName('');
      void loadBrands();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const visibleBrands = showArchived ? brands : brands.filter((b) => b.isActive !== false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite || saving) return;
    setError(null);
    const trimmed = brandName.trim();
    if (!trimmed) {
      setError('أدخل اسم العلامة التجارية.');
      return;
    }

    setSaving(true);
    try {
      await dataService.saveBrandAtomic({
        ...(editingBrandId ? { id: editingBrandId } : {}),
        nameAr: trimmed,
      });
      setEditingBrandId('');
      setBrandName('');
      await loadBrands();
      onChanged();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر حفظ العلامة التجارية.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleArchive = async (brand: Brand) => {
    if (!canWrite || saving) return;
    setError(null);
    setSaving(true);
    try {
      if (brand.isActive !== false) {
        await dataService.archiveBrandAtomic(brand.id);
      } else {
        await dataService.saveBrandAtomic({
          id: brand.id,
          nameAr: brand.nameAr,
          isActive: true,
        });
      }
      await loadBrands();
      onChanged();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحديث حالة العلامة التجارية.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto"
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="brand-manager-title"
    >
      <div className="relative w-full max-w-lg bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
        <div className="flex items-center justify-between px-6 py-4 bg-slate-900 text-white">
          <div className="flex items-center gap-2">
            <Tag className="w-4 h-4 text-emerald-400" />
            <h3 id="brand-manager-title" className="text-sm font-bold">
              إدارة العلامات التجارية
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق نافذة العلامات التجارية"
            className="text-slate-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4 text-xs">
          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
              <span className="font-semibold">{error}</span>
            </div>
          )}

          {canWrite && (
            <form onSubmit={handleSave} className="space-y-2 pb-4 border-b border-slate-100">
              <label htmlFor="brand-name-input" className="block font-semibold text-slate-700">
                {editingBrandId ? 'تعديل اسم العلامة التجارية' : 'إضافة علامة تجارية جديدة'}
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="brand-name-input"
                  type="text"
                  value={brandName}
                  onChange={(e) => setBrandName(e.target.value)}
                  placeholder="مثال: بانادول / المراعي / هوندا / كاتربيلر..."
                  className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
                {editingBrandId && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingBrandId('');
                      setBrandName('');
                    }}
                    className="px-3 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0"
                  >
                    إلغاء
                  </button>
                )}
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-bold rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  {editingBrandId ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                  <span>{saving ? 'جارٍ الحفظ...' : editingBrandId ? 'تحديث' : 'إضافة'}</span>
                </button>
              </div>
            </form>
          )}

          <div className="flex items-center justify-between text-[11px] text-slate-500">
            <span>العلامات المسجلة ({visibleBrands.length})</span>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="rounded border-slate-300 text-emerald-600"
              />
              <span>إظهار المؤرشفة</span>
            </label>
          </div>

          <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-lg">
            {loading ? (
              <div className="py-8 text-center text-slate-400">جارٍ تحميل العلامات التجارية...</div>
            ) : visibleBrands.length === 0 ? (
              <div className="py-8 text-center text-slate-400">
                لا توجد علامات تجارية مسجلة بعد. العلامة التجارية اختيارية ويمكن إضافتها هنا عند الحاجة.
              </div>
            ) : (
              visibleBrands.map((brand) => {
                const isArchived = brand.isActive === false;
                return (
                  <div
                    key={brand.id}
                    className={`flex items-center justify-between gap-3 px-3.5 py-2.5 ${
                      isArchived ? 'bg-slate-50 text-slate-500' : 'bg-white text-slate-900'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="font-bold truncate">{brand.nameAr}</div>
                      <div className="text-[11px] text-slate-500">
                        {isArchived ? 'مؤرشفة (محفوظة للفواتير السابقة)' : 'نشطة'}
                      </div>
                    </div>

                    {canWrite && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingBrandId(brand.id);
                            setBrandName(brand.nameAr);
                            setError(null);
                          }}
                          aria-label={`تعديل العلامة التجارية ${brand.nameAr}`}
                          className="p-1.5 text-slate-500 hover:text-emerald-700 hover:bg-slate-100 rounded-md transition-colors"
                          title="تعديل"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void handleToggleArchive(brand)}
                          aria-label={
                            isArchived
                              ? `إعادة تفعيل العلامة التجارية ${brand.nameAr}`
                              : `أرشفة العلامة التجارية ${brand.nameAr}`
                          }
                          className={`p-1.5 rounded-md transition-colors ${
                            isArchived
                              ? 'text-emerald-600 hover:bg-emerald-50'
                              : 'text-slate-500 hover:text-amber-700 hover:bg-amber-50'
                          }`}
                          title={isArchived ? 'إعادة تفعيل' : 'أرشفة'}
                        >
                          {isArchived ? (
                            <RotateCcw className="w-3.5 h-3.5" />
                          ) : (
                            <Archive className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 font-semibold whitespace-nowrap shrink-0"
            >
              إغلاق
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
