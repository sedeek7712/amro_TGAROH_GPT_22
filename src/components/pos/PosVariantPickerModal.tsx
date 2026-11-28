import React, { useMemo, useState } from 'react';
import { X, AlertCircle, Clock, Layers } from 'lucide-react';
import type { ProductCatalogEntry } from '../../types/erp';
import { ProductPrimaryImage } from '../inventory/ProductPrimaryImage';
import {
  formatVariantSummary,
  getSkuSaleabilityStatus,
  PosFamilyCard,
} from '../../utils/posCatalog';

interface PosVariantPickerModalProps {
  familyCard: PosFamilyCard | null;
  currencySymbol: string;
  onSelectEntry: (entry: ProductCatalogEntry) => void;
  onClose: () => void;
}

export const PosVariantPickerModal: React.FC<PosVariantPickerModalProps> = ({
  familyCard,
  currencySymbol,
  onSelectEntry,
  onClose,
}) => {
  const [selectedFilters, setSelectedFilters] = useState<Record<string, string>>({});

  const optionFilters = useMemo(() => {
    if (!familyCard) return [];
    return familyCard.family.optionSchema || [];
  }, [familyCard]);

  const filteredEntries = useMemo(() => {
    if (!familyCard) return [];
    return familyCard.entries.filter((entry) => {
      for (const [key, val] of Object.entries(selectedFilters)) {
        if (!val) continue;
        if ((entry.variantAttributes?.[key] || '').toLowerCase() !== val.toLowerCase()) {
          return false;
        }
      }
      return true;
    });
  }, [familyCard, selectedFilters]);

  if (!familyCard) return null;

  const { family, brand, derivedActiveStock } = familyCard;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pos-variant-picker-title"
    >
      <div className="relative w-full max-w-2xl bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200 flex flex-col max-h-[85vh]">
        <div className="flex items-start justify-between gap-4 px-5 py-4 bg-slate-950 text-white shrink-0">
          <div className="min-w-0">
            <h3 id="pos-variant-picker-title" className="text-sm font-bold text-white truncate">
              {family.nameAr}
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-300">
              {brand?.nameAr && <span>{brand.nameAr}</span>}
              {brand?.nameAr && family.categorySnapshot && <span aria-hidden="true">·</span>}
              {family.categorySnapshot && <span>{family.categorySnapshot}</span>}
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                مجموع مخزون المتغيرات النشطة: {derivedActiveStock}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق نافذة اختيار المتغير"
            className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {optionFilters.length > 0 && (
          <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 space-y-2.5 shrink-0 text-xs">
            {optionFilters.map((opt) => {
              const activeVal = selectedFilters[opt.key] || '';
              return (
                <div key={opt.key} className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-bold text-slate-600 min-w-[64px]">
                    {opt.labelAr}:
                  </span>
                  <div className="flex flex-wrap items-center gap-1 p-0.5 bg-white border border-slate-200 rounded-lg">
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedFilters((prev) => ({ ...prev, [opt.key]: '' }))
                      }
                      className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors whitespace-nowrap ${
                        !activeVal
                          ? 'bg-slate-900 text-white'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      الكل
                    </button>
                    {opt.values.map((val) => (
                      <button
                        type="button"
                        key={val}
                        onClick={() =>
                          setSelectedFilters((prev) => ({
                            ...prev,
                            [opt.key]: activeVal === val ? '' : val,
                          }))
                        }
                        className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors whitespace-nowrap ${
                          activeVal === val
                            ? 'bg-emerald-600 text-white'
                            : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                        }`}
                      >
                        {val}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="p-4 overflow-y-auto space-y-2 text-xs">
          {filteredEntries.length === 0 ? (
            <div className="py-10 text-center text-slate-500">
              <Layers className="w-8 h-8 mx-auto mb-2 text-slate-300 stroke-1" />
              <p className="font-semibold">لا توجد متغيرات مطابقة للخيارات المحددة</p>
            </div>
          ) : (
            filteredEntries.map((entry) => {
              const p = entry.product;
              const saleability = getSkuSaleabilityStatus(entry);
              const variantSummary = formatVariantSummary(
                entry.variantAttributes,
                family.optionSchema
              );
              const isDisabled = !saleability.sellable;

              return (
                <button
                  type="button"
                  key={p.id}
                  disabled={isDisabled}
                  onClick={() => {
                    if (isDisabled) return;
                    onSelectEntry(entry);
                  }}
                  aria-label={`اختيار ${p.nameAr}`}
                  className={`w-full p-3 rounded-xl border text-right transition-all flex items-center justify-between gap-3 ${
                    isDisabled
                      ? 'bg-slate-50 border-slate-200 opacity-65 cursor-not-allowed'
                      : 'bg-white border-slate-200 hover:border-emerald-500 hover:bg-emerald-50/30 cursor-pointer'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="shrink-0">
                      <ProductPrimaryImage
                        productId={p.id}
                        productName={p.nameAr}
                        displaySize="inventory"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-bold text-slate-900 truncate">
                        {variantSummary || p.nameAr}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                        <span className="font-mono">{p.code}</span>
                        {p.barcode && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono" dir="ltr">{p.barcode}</span>
                          </>
                        )}
                        {p.batches && p.batches.length > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="inline-flex items-center gap-1 text-emerald-700">
                              <Clock className="w-3 h-3" />
                              <span>{p.batches.length} تشغيلة</span>
                            </span>
                          </>
                        )}
                      </div>
                      {!saleability.sellable && saleability.message && (
                        <div className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-rose-700">
                          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                          <span>
                            {saleability.reason === 'ARCHIVED'
                              ? 'مؤرشف ومعطل عن البيع'
                              : saleability.reason === 'EXPIRED'
                              ? 'منتهي الصلاحية - محظور البيع'
                              : 'نافد المخزون'}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="shrink-0 text-left space-y-0.5">
                    <div className="font-mono tabular-nums font-bold text-sm text-emerald-800">
                      {p.sellPrice.toFixed(2)} {currencySymbol}
                    </div>
                    <div
                      className={`font-mono tabular-nums text-[11px] font-semibold ${
                        saleability.sellable ? 'text-slate-600' : 'text-rose-700'
                      }`}
                    >
                      {p.currentStock} {p.unit}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
