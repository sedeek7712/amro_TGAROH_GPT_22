import { db } from '../db/erpDatabase';
import { Product, ProductImage, ProductImageLocalAsset } from '../types/erp';
import { authService } from './authService';
import { storage } from './storageService';
import { syncQueueService } from './syncQueueService';
import {
  assertActivityAccess,
  assertPermission,
  filterRecordsByActivityScope,
} from '../config/rbac';

const MAX_IMAGES_PER_PRODUCT = 6;
const MAX_ORIGINAL_BYTES = 10 * 1024 * 1024;

function desktopBridge() {
  return typeof window !== 'undefined' ? window.amroDesktop : undefined;
}

function fileToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('تعذر قراءة الصورة.'));
    reader.onerror = () => reject(reader.error || new Error('تعذر قراءة الصورة.'));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(value: string, expectedMime: string, maxBytes: number): Blob {
  const match = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(value || '');
  if (!match || match[1] !== expectedMime) throw new Error('صيغة الصورة غير صالحة.');
  const raw = atob(match[2]);
  if (!raw.length || raw.length > maxBytes) throw new Error('حجم الصورة يتجاوز الحد المسموح.');
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const valid = expectedMime === 'image/jpeg'
    ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : expectedMime === 'image/png'
      ? Array.from(bytes.slice(0,8)).join(',') === '137,80,78,71,13,10,26,10'
      : bytes.length >= 12 && String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP';
  if (!valid) throw new Error('محتوى الملف لا يطابق صيغة الصورة المعلنة.');
  return new Blob([bytes], { type: expectedMime });
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) {
    throw new Error('أبعاد الصورة غير صالحة.');
  }
}

export class ProductMediaService {
  private requireProductAccess(productId: string, permission: 'inventory:view' | 'inventory:media:manage') {
    const actor = authService.getCurrentActorSync();
    assertPermission(actor, permission, 'إدارة صور الأصناف');
    return actor!;
  }

  public async getProductImages(productId: string): Promise<ProductImage[]> {
    const bridge = desktopBridge();
    if (bridge) return await bridge.getProductImages({ token: authService.requireDesktopToken(), productId });
    const actor = this.requireProductAccess(productId, 'inventory:view');
    const product = await db.products.get(productId);
    if (!product || !filterRecordsByActivityScope([product], actor)[0]) return [];
    return await db.productImages
      .where('[tenantId+productId]')
      .equals([actor.tenantId || '', productId])
      .filter((item) => !item.isDeleted)
      .sortBy('sortOrder');
  }

  public async getImageDataUrl(imageId: string, variant: 'original' | 'thumbnail' = 'thumbnail'): Promise<string | null> {
    const bridge = desktopBridge();
    if (bridge) return await bridge.getProductImageData({ token: authService.requireDesktopToken(), imageId, variant });
    const actor = authService.getCurrentActorSync();
    assertPermission(actor, 'inventory:view', 'عرض صورة الصنف');
    const record = await db.productImages.get(imageId);
    if (!record || record.tenantId !== actor?.tenantId || record.isDeleted ||
        !filterRecordsByActivityScope([{ activityId: record.activityId } as Product], actor)[0]) return null;
    const asset = record as ProductImageLocalAsset;
    const blob = variant === 'original' ? asset.originalBlob : asset.thumbnailBlob;
    if (!blob) return null;
    return await fileToDataUrl(blob);
  }

  public async addProductImage(input: {
    productId: string;
    originalDataUrl: string;
    thumbnailDataUrl: string;
    mimeType: 'image/webp' | 'image/jpeg' | 'image/png';
    width: number;
    height: number;
    originalName?: string;
  }): Promise<ProductImage> {
    const bridge = desktopBridge();
    if (bridge) {
      return await bridge.addProductImage({
        token: authService.requireDesktopToken(),
        input,
      });
    }

    const actor = this.requireProductAccess(input.productId, 'inventory:media:manage');
    const product = await db.products.get(input.productId);
    if (!product || !filterRecordsByActivityScope([product], actor)[0]) {
      throw new Error('الصنف غير موجود أو خارج الأنشطة المصرح بها.');
    }
    assertActivityAccess(actor, product.activityId, 'إرفاق صورة للصنف');
    assertDimensions(input.width, input.height);

    const originalBlob = dataUrlToBlob(input.originalDataUrl, input.mimeType, MAX_ORIGINAL_BYTES);
    const thumbnailBlob = dataUrlToBlob(input.thumbnailDataUrl, input.mimeType, 1024 * 1024);
    if (originalBlob.size > MAX_ORIGINAL_BYTES) throw new Error('حجم الصورة الأصلية يتجاوز 10 ميجابايت.');
    const checksumSha256 = await sha256(originalBlob);
    const id = storage.generateUUID();
    const now = new Date().toISOString();
    const current = await db.productImages
      .where('[tenantId+productId]')
      .equals([actor.tenantId || '', product.id])
      .filter((item) => !item.isDeleted)
      .toArray();
    if (current.length >= MAX_IMAGES_PER_PRODUCT) {
      throw new Error('الحد الأقصى ست صور للصنف الواحد، تشمل الصورة الرئيسية.');
    }

    const record: ProductImage = {
      id,
      tenantId: actor.tenantId || 'tenant_main',
      productId: product.id,
      activityId: product.activityId,
      storageKey: `${actor.tenantId}/${product.activityId}/${product.id}/${id}/original.webp`,
      thumbnailStorageKey: `${actor.tenantId}/${product.activityId}/${product.id}/${id}/thumbnail.webp`,
      mimeType: input.mimeType,
      sizeBytes: originalBlob.size,
      thumbnailSizeBytes: thumbnailBlob.size,
      width: input.width,
      height: input.height,
      checksumSha256,
      isPrimary: current.length === 0,
      sortOrder: current.length,
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
      syncStatus: 'PENDING_UPLOAD',
      isDeleted: false,
    };

    await db.transaction('rw', [db.productImages, db.outbox, db.auditLogs], async () => {
      await db.productImages.add({ ...record, originalBlob, thumbnailBlob });
      await syncQueueService.enqueue({
        tenantId: record.tenantId,
        branchId: actor.branchId,
        entityType: 'PRODUCT_IMAGE',
        entityId: record.id,
        action: 'CREATE',
        payload: record as unknown as Record<string, unknown>,
        priority: 2,
        dependsOn: [product.id],
      });
      await db.auditLogs.add({
        id: storage.generateUUID(),
        tenantId: record.tenantId,
        branchId: actor.branchId,
        timestamp: now,
        userId: actor.id,
        userName: actor.fullName,
        action: 'إرفاق صورة صنف',
        details: `إضافة صورة للصنف ${product.nameAr} (${product.code})`,
        entityType: 'PRODUCT_IMAGE',
        entityId: record.id,
      });
    });
    return record;
  }

  public async setPrimaryImage(imageId: string): Promise<ProductImage> {
    const bridge = desktopBridge();
    if (bridge) return await bridge.setPrimaryProductImage({ token: authService.requireDesktopToken(), imageId });
    const actor = this.requireProductAccess(imageId, 'inventory:media:manage');
    const current = await db.productImages.get(imageId);
    if (!current || current.tenantId !== actor.tenantId || current.isDeleted) throw new Error('الصورة غير موجودة.');
    assertActivityAccess(actor, current.activityId, 'تغيير الصورة الرئيسية');

    const now = new Date().toISOString();
    let saved: ProductImage | undefined;
    await db.transaction('rw', [db.productImages, db.outbox, db.auditLogs], async () => {
      const siblings = await db.productImages
        .where('[tenantId+productId]')
        .equals([current.tenantId, current.productId])
        .filter((item) => !item.isDeleted)
        .toArray();
      for (const item of siblings) {
        const next = { ...item, isPrimary: item.id === imageId, updatedAt: now };
        await db.productImages.put(next);
        await syncQueueService.enqueue({
          tenantId: item.tenantId,
          branchId: actor.branchId,
          entityType: 'PRODUCT_IMAGE',
          entityId: item.id,
          action: 'UPDATE',
          payload: this.toMetadata(next) as unknown as Record<string, unknown>,
          priority: 2,
          dependsOn: [item.productId],
        });
        if (item.id === imageId) saved = this.toMetadata(next);
      }
      await db.auditLogs.add({
        id: storage.generateUUID(), tenantId: actor.tenantId, branchId: actor.branchId,
        timestamp: now, userId: actor.id, userName: actor.fullName,
        action: 'تغيير الصورة الرئيسية للصنف', details: `تعيين صورة رئيسية للصنف ${current.productId}`,
        entityType: 'PRODUCT_IMAGE', entityId: imageId,
      });
    });
    return saved!;
  }

  public async deleteImage(imageId: string): Promise<void> {
    const bridge = desktopBridge();
    if (bridge) return await bridge.deleteProductImage({ token: authService.requireDesktopToken(), imageId });
    const actor = this.requireProductAccess(imageId, 'inventory:media:manage');
    const current = await db.productImages.get(imageId);
    if (!current || current.tenantId !== actor.tenantId || current.isDeleted) return;
    assertActivityAccess(actor, current.activityId, 'حذف صورة الصنف');
    const now = new Date().toISOString();
    const next = { ...current, isDeleted: true, isPrimary: false, syncStatus: 'PENDING_UPLOAD' as const, updatedAt: now };
    await db.transaction('rw', [db.productImages, db.outbox, db.auditLogs], async () => {
      await db.productImages.put({ ...next, originalBlob: undefined, thumbnailBlob: undefined } as ProductImageLocalAsset);
      await syncQueueService.enqueue({
        tenantId: current.tenantId,
        branchId: actor.branchId,
        entityType: 'PRODUCT_IMAGE',
        entityId: imageId,
        action: 'DELETE',
        payload: this.toMetadata(next) as unknown as Record<string, unknown>,
        priority: 2,
        dependsOn: [current.productId],
      });
      await db.auditLogs.add({
        id: storage.generateUUID(), tenantId: actor.tenantId, branchId: actor.branchId,
        timestamp: now, userId: actor.id, userName: actor.fullName,
        action: 'حذف صورة صنف', details: `حذف صورة من الصنف ${current.productId}`,
        entityType: 'PRODUCT_IMAGE', entityId: imageId,
      });
    });
  }

  public toMetadata(record: ProductImage): ProductImage {
    const { originalBlob: _originalBlob, thumbnailBlob: _thumbnailBlob, ...metadata } = record as ProductImageLocalAsset;
    return metadata;
  }

  public async cacheRemoteImage(record: ProductImage, originalDataUrl: string, thumbnailDataUrl: string): Promise<void> {
    const bridge = desktopBridge();
    if (bridge) {
      await bridge.cacheRemoteProductImage({
        token: authService.requireDesktopToken(),
        input: { record, originalDataUrl, thumbnailDataUrl },
      });
      return;
    }
    const originalBlob = dataUrlToBlob(originalDataUrl, record.mimeType, MAX_ORIGINAL_BYTES);
    const thumbnailBlob = dataUrlToBlob(thumbnailDataUrl, record.mimeType, 1024 * 1024);
    const local = { ...record, syncStatus: 'SYNCED' as const, originalBlob, thumbnailBlob };
    await db.transaction('rw', db.productImages, async () => {
      const existing = await db.productImages.get(record.id);
      if (existing && existing.tenantId !== record.tenantId) throw new Error('حظر عزل المؤسسات: الصورة البعيدة لا تطابق المؤسسة.');
      await db.productImages.put(local);
    });
  }

  public async markSynced(imageId: string): Promise<void> {
    const bridge = desktopBridge();
    if (bridge) {
      await bridge.markProductImageSynced({ token: authService.requireDesktopToken(), imageId });
      return;
    }
    const record = await db.productImages.get(imageId);
    if (!record) return;
    await db.productImages.update(imageId, { syncStatus: 'SYNCED' });
  }

  public async getLocalImageRecord(imageId: string): Promise<ProductImage | undefined> {
    const bridge = desktopBridge();
    if (bridge) return await bridge.getProductImageRecord({ token: authService.requireDesktopToken(), imageId });
    const record = await db.productImages.get(imageId);
    if (!record) return undefined;
    const actor = authService.getCurrentActorSync();
    if (record.tenantId !== actor?.tenantId || !filterRecordsByActivityScope([{ activityId: record.activityId } as Product], actor)[0]) return undefined;
    return this.toMetadata(record);
  }
}

export const productMediaService = new ProductMediaService();
