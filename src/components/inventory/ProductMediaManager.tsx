import React, { useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, Star, Trash2, X, Loader2, CheckCircle2 } from 'lucide-react';
import { Product, ProductImage } from '../../types/erp';
import { productMediaService } from '../../services/productMediaService';
import { authService } from '../../services/authService';
import { hasPermission } from '../../config/rbac';

interface ProductMediaManagerProps {
  product: Product;
  onClose: () => void;
}

interface ProductImageView extends ProductImage {
  thumbnailDataUrl?: string | null;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('تعذر قراءة الصورة.'));
    reader.onerror = () => reject(reader.error || new Error('تعذر قراءة الصورة.'));
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('متصفحك لم يتمكن من ضغط الصورة.'));
      } else if (blob.type !== 'image/webp') {
        reject(new Error('هذا المتصفح لا يدعم حفظ صور الأصناف بصيغة WebP.'));
      } else {
        resolve(blob);
      }
    }, 'image/webp', quality);
  });
}

async function resizeImage(file: File, maxSide: number, quality: number): Promise<{ dataUrl: string; width: number; height: number }> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('الصيغ المدعومة JPG وPNG وWebP فقط.');
  }
  if (file.size <= 0 || file.size > 10 * 1024 * 1024) {
    throw new Error('حجم الصورة قبل الضغط يجب ألا يتجاوز 10 ميجابايت.');
  }
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) throw new Error('تعذر تجهيز الصورة للضغط.');
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvasToBlob(canvas, quality);
    return { dataUrl: await blobToDataUrl(blob), width, height };
  } finally {
    bitmap.close();
  }
}

export const ProductMediaManager: React.FC<ProductMediaManagerProps> = ({ product, onClose }) => {
  const [images, setImages] = useState<ProductImageView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const actor = authService.getCurrentActorSync();
  const canManage = hasPermission(actor, 'inventory:media:manage');
  const remaining = Math.max(0, 6 - images.length);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const records = await productMediaService.getProductImages(product.id);
      const views = await Promise.all(records.map(async (record) => ({
        ...record,
        thumbnailDataUrl: await productMediaService.getImageDataUrl(record.id, 'thumbnail'),
      })));
      setImages(views);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل صور الصنف.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // The modal is scoped to one product; reload when that product changes.
  }, [product.id]);

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length || busy) return;
    setError(null);
    const selected = Array.from(files).slice(0, remaining);
    if (files.length > remaining) {
      setError('تم اختيار ملفات أكثر من المتاح. يمكن إرفاق ست صور كحد أقصى للصنف.');
    }
    setBusy(true);
    try {
      for (const file of selected) {
        const original = await resizeImage(file, 1600, 0.84);
        const thumbnail = await resizeImage(file, 360, 0.78);
        await productMediaService.addProductImage({
          productId: product.id,
          originalDataUrl: original.dataUrl,
          thumbnailDataUrl: thumbnail.dataUrl,
          mimeType: 'image/webp',
          width: original.width,
          height: original.height,
          originalName: file.name,
        });
      }
      await reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'تعذر إرفاق الصورة.';
      await reload();
      setError(message);
    } finally {
      setBusy(false);
      if (galleryInput.current) galleryInput.current.value = '';
      if (cameraInput.current) cameraInput.current.value = '';
    }
  };

  const openPreview = async (image: ProductImageView) => {
    try {
      const original = await productMediaService.getImageDataUrl(image.id, 'original');
      setPreview(original || image.thumbnailDataUrl || null);
    } catch {
      setPreview(image.thumbnailDataUrl || null);
    }
  };

  const setPrimary = async (image: ProductImageView) => {
    if (!canManage || busy || image.isPrimary) return;
    setBusy(true);
    setError(null);
    try {
      await productMediaService.setPrimaryImage(image.id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تغيير الصورة الرئيسية.');
    } finally {
      setBusy(false);
    }
  };

  const removeImage = async (image: ProductImageView) => {
    if (!canManage || busy) return;
    if (!window.confirm('هل تريد حذف هذه الصورة من الصنف؟')) return;
    setBusy(true);
    setError(null);
    try {
      await productMediaService.deleteImage(image.id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر حذف الصورة.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-3 sm:p-5" dir="rtl">
      <div className="w-full max-w-4xl max-h-[92vh] overflow-hidden rounded-2xl bg-white shadow-2xl flex flex-col">
        <div className="flex items-center justify-between gap-3 bg-slate-900 px-5 py-4 text-white">
          <div>
            <h3 className="text-sm font-bold">صور الصنف</h3>
            <p className="mt-1 text-xs text-slate-300">{product.nameAr} · {product.code}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-300 hover:bg-white/10 hover:text-white" aria-label="إغلاق">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-slate-500">
              صورة رئيسية واحدة، وإجمالي الصور لا يتجاوز ست صور للصنف.
              <span className="mr-2 font-semibold text-slate-700">المتاح: {remaining}</span>
            </div>
            {canManage && remaining > 0 && (
              <div className="flex flex-wrap gap-2">
                <input ref={cameraInput} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="hidden" onChange={(e) => void handleFiles(e.target.files)} />
                <input ref={galleryInput} type="file" accept="image/jpeg,image/png,image/webp" multiple className="hidden" onChange={(e) => void handleFiles(e.target.files)} />
                <button type="button" disabled={busy} onClick={() => cameraInput.current?.click()} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  <Camera className="h-4 w-4" /> الكاميرا
                </button>
                <button type="button" disabled={busy} onClick={() => galleryInput.current?.click()} className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">
                  <ImagePlus className="h-4 w-4" /> اختيار من الصور
                </button>
              </div>
            )}
          </div>

          {error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</div>}

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500"><Loader2 className="h-5 w-5 animate-spin" /> جارٍ تحميل الصور...</div>
          ) : images.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed border-slate-200 py-16 text-center">
              <ImagePlus className="mx-auto h-10 w-10 text-slate-300" />
              <p className="mt-3 text-sm font-semibold text-slate-700">لا توجد صور لهذا الصنف</p>
              <p className="mt-1 text-xs text-slate-500">أضف صورة واضحة للعبوة أو القطعة أو الملصق التعريفي.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {images.map((image) => (
                <div key={image.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                  <button type="button" onClick={() => void openPreview(image)} className="relative block aspect-square w-full bg-slate-50">
                    {image.thumbnailDataUrl ? <img src={image.thumbnailDataUrl} alt={product.nameAr} className="h-full w-full object-contain" loading="lazy" /> : <div className="flex h-full items-center justify-center text-xs text-slate-400">الصورة غير متاحة محلياً</div>}
                    {image.isPrimary && <span className="absolute right-2 top-2 rounded-full bg-emerald-700 px-2 py-1 text-[10px] font-bold text-white">الرئيسية</span>}
                  </button>
                  <div className="space-y-2 p-2.5">
                    <div className="flex items-center justify-between gap-2 text-[10px] text-slate-500">
                      <span>{image.width} × {image.height}</span>
                      <span>{image.syncStatus === 'SYNCED' ? <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="h-3 w-3" /> متزامنة</span> : 'بانتظار المزامنة'}</span>
                    </div>
                    {canManage && (
                      <div className="flex items-center gap-1">
                        <button type="button" disabled={busy || image.isPrimary} onClick={() => void setPrimary(image)} className="flex-1 inline-flex items-center justify-center gap-1 rounded-md border border-slate-200 py-1.5 text-[10px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">
                          <Star className="h-3 w-3" /> رئيسية
                        </button>
                        <button type="button" disabled={busy} onClick={() => void removeImage(image)} className="rounded-md border border-rose-100 p-1.5 text-rose-600 hover:bg-rose-50 disabled:opacity-40" aria-label="حذف الصورة">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {busy && <div className="flex items-center gap-2 text-xs text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> يتم تنفيذ العملية...</div>}
        </div>

        <div className="flex justify-end border-t border-slate-200 px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-lg bg-slate-800 px-5 py-2 text-xs font-semibold text-white hover:bg-slate-900">إغلاق</button>
        </div>
      </div>

      {preview && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/85 p-4" onClick={() => setPreview(null)}>
          <button type="button" onClick={() => setPreview(null)} className="absolute left-4 top-4 rounded-full bg-white/15 p-2 text-white" aria-label="إغلاق الصورة"><X className="h-5 w-5" /></button>
          <img src={preview} alt={product.nameAr} className="max-h-[88vh] max-w-[94vw] object-contain" />
        </div>
      )}
    </div>
  );
};
