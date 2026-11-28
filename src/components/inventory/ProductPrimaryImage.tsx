import React, { useEffect, useRef, useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { productMediaService } from '../../services/productMediaService';

interface ProductPrimaryImageProps {
  productId: string;
  productName: string;
  displaySize?: 'inventory' | 'pos';
  refreshKey?: number;
  fallbackProductIds?: string[];
}

export const ProductPrimaryImage: React.FC<ProductPrimaryImageProps> = ({
  productId,
  productName,
  displaySize = 'inventory',
  refreshKey = 0,
  fallbackProductIds,
}) => {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const fallbackKey = (fallbackProductIds || []).join(',');

  useEffect(() => {
    let active = true;
    setSrc(null);
    setLoading(true);
    const load = () => {
      const candidateIds = Array.from(
        new Set([productId, ...(fallbackProductIds || [])].filter(Boolean))
      );
      void (async () => {
        for (const candidateId of candidateIds) {
          if (!active) return;
          const images = await productMediaService.getProductImages(candidateId);
          const primary = images.find((image) => image.isPrimary) || images[0];
          if (primary) {
            const value = await productMediaService.getImageDataUrl(primary.id, 'thumbnail');
            if (value) {
              if (active) setSrc(value);
              return;
            }
          }
        }
        if (active) setSrc(null);
      })()
        .catch(() => {
          if (active) setSrc(null);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    };
    const node = rootRef.current;
    if (node && typeof IntersectionObserver !== 'undefined') {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          load();
        }
      }, { rootMargin: '120px' });
      observer.observe(node);
      return () => {
        active = false;
        observer.disconnect();
      };
    }
    load();
    return () => {
      active = false;
    };
  }, [productId, refreshKey, fallbackKey]);

  const frameClass =
    displaySize === 'pos'
      ? 'mx-auto flex h-24 w-full items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-50'
      : 'mx-auto flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50';

  return (
    <div ref={rootRef} className={frameClass}>
      {src ? (
        <img src={src} alt={productName} loading="lazy" className="h-full w-full object-contain" />
      ) : (
        <ImageIcon className={`h-4 w-4 ${loading ? 'text-slate-200' : 'text-slate-300'}`} />
      )}
    </div>
  );
};
