import React, { useEffect, useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { productMediaService } from '../../services/productMediaService';

interface ProductPrimaryImageProps {
  productId: string;
  productName: string;
}

export const ProductPrimaryImage: React.FC<ProductPrimaryImageProps> = ({ productId, productName }) => {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
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
    return () => {
      active = false;
    };
  }, [productId]);

  return (
    <div className="mx-auto flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
      {src ? (
        <img src={src} alt={productName} loading="lazy" className="h-full w-full object-contain" />
      ) : (
        <ImageIcon className={`h-4 w-4 ${loading ? 'text-slate-200' : 'text-slate-300'}`} />
      )}
    </div>
  );
};
