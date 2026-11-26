import React, { useEffect, useRef, useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { productMediaService } from '../../services/productMediaService';

interface ProductPrimaryImageProps {
  productId: string;
  productName: string;
  displaySize?: 'inventory' | 'pos';
}

export const ProductPrimaryImage: React.FC<ProductPrimaryImageProps> = ({
  productId,
  productName,
  displaySize = 'inventory',
}) => {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const load = () => {
      void productMediaService.getProductImages(productId)
        .then(async (images) => {
          const primary = images.find((image) => image.isPrimary) || images[0];
          const value = primary ? await productMediaService.getImageDataUrl(primary.id, 'thumbnail') : null;
          if (active) setSrc(value);
        })
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
  }, [productId]);

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
