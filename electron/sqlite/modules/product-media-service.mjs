import { randomUUID } from 'node:crypto';
import { assertActivityAccess, assertPermission } from '../rbac.mjs';
import { enqueueOutboxTx, writeAuditLogTx } from './core-service.mjs';

const MAX_IMAGES_PER_PRODUCT = 6;

function mapRow(row) {
  if (!row) return undefined;
  let parsed = {};
  try { parsed = JSON.parse(row.data_json || '{}'); } catch {}
  return {
    ...parsed,
    id: row.id,
    tenantId: row.tenant_id,
    productId: row.product_id,
    activityId: row.activity_id,
    storageKey: row.storage_key,
    thumbnailStorageKey: row.thumbnail_storage_key,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    thumbnailSizeBytes: row.thumbnail_size_bytes,
    width: row.width,
    height: row.height,
    checksumSha256: row.checksum_sha256,
    isPrimary: row.is_primary === 1,
    sortOrder: row.sort_order,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncStatus: row.sync_status,
    isDeleted: row.is_deleted === 1,
  };
}

export function createProductMediaService(database, mediaStorage) {
  if (!database || !mediaStorage) throw new TypeError('database and mediaStorage are required');

  function loadProduct(actor, productId, actionLabel) {
    const row = database.prepare(
      'SELECT id, activity_id FROM products WHERE tenant_id = ? AND id = ?'
    ).get(actor.tenantId, String(productId || ''));
    if (!row) throw new Error('الصنف غير موجود.');
    assertActivityAccess(actor, row.activity_id, actionLabel);
    return row;
  }

  function loadImage(actor, imageId) {
    const row = database.prepare(
      'SELECT * FROM product_images WHERE tenant_id = ? AND id = ? AND is_deleted = 0'
    ).get(actor.tenantId, String(imageId || ''));
    if (!row) return undefined;
    loadProduct(actor, row.product_id, 'إدارة صور الصنف');
    return row;
  }

  function enqueue(actor, image, action, nowIso) {
    enqueueOutboxTx(database, actor, {
      entityType: 'PRODUCT_IMAGE',
      entityId: image.id,
      action,
      payload: image,
      priority: 2,
      dependsOn: [image.productId],
      idempotencyKey: `${actor.tenantId}_PRODUCT_IMAGE_${image.id}_${action}_${image.updatedAt}`,
      nowIso,
    });
  }

  return {
    getProductImages(actor, productId) {
      assertPermission(actor, 'inventory:view', 'عرض صور الأصناف');
      loadProduct(actor, productId, 'عرض صور الصنف');
      return database.prepare(
        'SELECT * FROM product_images WHERE tenant_id = ? AND product_id = ? AND is_deleted = 0 ORDER BY is_primary DESC, sort_order ASC, created_at ASC'
      ).all(actor.tenantId, productId).map(mapRow);
    },

    getProductImageRecord(actor, imageId) {
      assertPermission(actor, 'inventory:view', 'عرض صورة الصنف');
      const row = loadImage(actor, imageId);
      return row ? mapRow(row) : undefined;
    },

    getProductImageData(actor, imageId, variant = 'thumbnail') {
      assertPermission(actor, 'inventory:view', 'عرض صورة الصنف');
      const row = loadImage(actor, imageId);
      if (!row) return null;
      return mediaStorage.read(variant === 'original' ? row.storage_key : row.thumbnail_storage_key);
    },

    addProductImage(actor, input) {
      assertPermission(actor, 'inventory:media:manage', 'إرفاق صورة للصنف');
      if (!input || typeof input !== 'object') throw new Error('بيانات الصورة غير صالحة.');
      const product = loadProduct(actor, input.productId, 'إرفاق صورة للصنف');
      const count = database.prepare(
        'SELECT COUNT(*) AS count FROM product_images WHERE tenant_id = ? AND product_id = ? AND is_deleted = 0'
      ).get(actor.tenantId, input.productId).count;
      if (count >= MAX_IMAGES_PER_PRODUCT) {
        throw new Error('الحد الأقصى ست صور للصنف الواحد، تشمل الصورة الرئيسية.');
      }

      const imageId = randomUUID();
      const nowIso = new Date().toISOString();
      const stored = mediaStorage.store({
        tenantId: actor.tenantId,
        activityId: product.activity_id,
        productId: input.productId,
        imageId,
        mimeType: input.mimeType,
        width: input.width,
        height: input.height,
        originalDataUrl: input.originalDataUrl,
        thumbnailDataUrl: input.thumbnailDataUrl,
      });
      const record = {
        id: imageId,
        tenantId: actor.tenantId,
        productId: input.productId,
        activityId: product.activity_id,
        storageKey: stored.storageKey,
        thumbnailStorageKey: stored.thumbnailStorageKey,
        mimeType: input.mimeType,
        sizeBytes: stored.sizeBytes,
        thumbnailSizeBytes: stored.thumbnailSizeBytes,
        width: input.width,
        height: input.height,
        checksumSha256: stored.checksumSha256,
        isPrimary: count === 0,
        sortOrder: count,
        createdBy: actor.id,
        createdAt: nowIso,
        updatedAt: nowIso,
        syncStatus: 'PENDING_UPLOAD',
        isDeleted: false,
      };

      database.exec('BEGIN IMMEDIATE');
      try {
        const lockedCount = database.prepare(
          'SELECT COUNT(*) AS count FROM product_images WHERE tenant_id = ? AND product_id = ? AND is_deleted = 0'
        ).get(actor.tenantId, input.productId).count;
        if (lockedCount >= MAX_IMAGES_PER_PRODUCT) {
          throw new Error('الحد الأقصى ست صور للصنف الواحد، تشمل الصورة الرئيسية.');
        }
        record.isPrimary = lockedCount === 0;
        record.sortOrder = lockedCount;
        database.prepare(
          `INSERT INTO product_images
            (tenant_id,id,product_id,activity_id,storage_key,thumbnail_storage_key,mime_type,size_bytes,
             thumbnail_size_bytes,width,height,checksum_sha256,is_primary,sort_order,created_by,created_at,
             updated_at,sync_status,is_deleted,data_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          record.tenantId, record.id, record.productId, record.activityId, record.storageKey,
          record.thumbnailStorageKey, record.mimeType, record.sizeBytes, record.thumbnailSizeBytes,
          record.width, record.height, record.checksumSha256, record.isPrimary ? 1 : 0,
          record.sortOrder, record.createdBy, record.createdAt, record.updatedAt,
          record.syncStatus, 0, JSON.stringify(record)
        );
        enqueue(actor, record, 'CREATE', nowIso);
        writeAuditLogTx(database, actor, 'إرفاق صورة صنف', `إضافة صورة للصنف ${input.productId}`, nowIso, {
          entityType: 'PRODUCT_IMAGE', entityId: imageId, result: 'SUCCESS',
        });
        database.exec('COMMIT');
        return record;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        mediaStorage.remove([record.storageKey, record.thumbnailStorageKey]);
        throw error;
      }
    },

    setPrimaryProductImage(actor, imageId) {
      assertPermission(actor, 'inventory:media:manage', 'تغيير الصورة الرئيسية');
      const row = loadImage(actor, imageId);
      if (!row) throw new Error('الصورة غير موجودة.');
      const nowIso = new Date().toISOString();
      database.exec('BEGIN IMMEDIATE');
      try {
        // إلغاء الرئيسية الحالية أولاً لتجنب خرق القيد الفريد الجزئي.
        database.prepare(
          'UPDATE product_images SET is_primary = 0, updated_at = ?, data_json = json_set(data_json, \'$.isPrimary\', false, \'$.updatedAt\', ?) WHERE tenant_id = ? AND product_id = ? AND is_deleted = 0'
        ).run(nowIso, nowIso, actor.tenantId, row.product_id);
        database.prepare(
          'UPDATE product_images SET is_primary = 1, updated_at = ?, sync_status = \'PENDING_UPLOAD\', data_json = json_set(data_json, \'$.isPrimary\', true, \'$.updatedAt\', ?, \'$.syncStatus\', \'PENDING_UPLOAD\') WHERE tenant_id = ? AND id = ?'
        ).run(nowIso, nowIso, actor.tenantId, imageId);
        const rows = database.prepare(
          'SELECT * FROM product_images WHERE tenant_id = ? AND product_id = ? AND is_deleted = 0'
        ).all(actor.tenantId, row.product_id);
        for (const updatedRow of rows) enqueue(actor, mapRow(updatedRow), 'UPDATE', nowIso);
        writeAuditLogTx(database, actor, 'تغيير الصورة الرئيسية للصنف', `تعيين صورة رئيسية للصنف ${row.product_id}`, nowIso, {
          entityType: 'PRODUCT_IMAGE', entityId: imageId, result: 'SUCCESS',
        });
        database.exec('COMMIT');
        return mapRow(database.prepare('SELECT * FROM product_images WHERE tenant_id = ? AND id = ?').get(actor.tenantId, imageId));
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    deleteProductImage(actor, imageId) {
      assertPermission(actor, 'inventory:media:manage', 'حذف صورة الصنف');
      const row = loadImage(actor, imageId);
      if (!row) return;
      const current = mapRow(row);
      const nowIso = new Date().toISOString();
      const deleted = {
        ...current,
        isPrimary: false,
        isDeleted: true,
        syncStatus: 'PENDING_UPLOAD',
        updatedAt: nowIso,
      };

      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(
          `UPDATE product_images SET is_primary=0,is_deleted=1,sync_status='PENDING_UPLOAD',updated_at=?,data_json=?
           WHERE tenant_id=? AND id=?`
        ).run(nowIso, JSON.stringify(deleted), actor.tenantId, imageId);
        enqueue(actor, deleted, 'DELETE', nowIso);

        if (current.isPrimary) {
          const nextRow = database.prepare(
            'SELECT * FROM product_images WHERE tenant_id = ? AND product_id = ? AND is_deleted = 0 ORDER BY sort_order ASC, created_at ASC LIMIT 1'
          ).get(actor.tenantId, row.product_id);
          if (nextRow) {
            const promoted = {
              ...mapRow(nextRow),
              isPrimary: true,
              syncStatus: 'PENDING_UPLOAD',
              updatedAt: nowIso,
            };
            database.prepare(
              `UPDATE product_images
               SET is_primary=1,sync_status='PENDING_UPLOAD',updated_at=?,data_json=?
               WHERE tenant_id=? AND id=?`
            ).run(nowIso, JSON.stringify(promoted), actor.tenantId, promoted.id);
            enqueue(actor, promoted, 'UPDATE', nowIso);
          }
        }

        writeAuditLogTx(database, actor, 'حذف صورة صنف', `حذف صورة من الصنف ${row.product_id}`, nowIso, {
          entityType: 'PRODUCT_IMAGE', entityId: imageId, result: 'SUCCESS',
        });
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
      mediaStorage.remove([row.storage_key, row.thumbnail_storage_key]);
    },

    applyRemoteProductImageTombstone(actor, record) {
      assertPermission(actor, 'inventory:view', 'مزامنة حذف صورة صنف');
      if (!record || record.tenantId !== actor.tenantId) throw new Error('حظر عزل المؤسسات: حذف الصورة لا يطابق المؤسسة.');
      loadProduct(actor, record.productId, 'مزامنة حذف صورة صنف');
      const existing = database.prepare(
        'SELECT * FROM product_images WHERE tenant_id = ? AND id = ?'
      ).get(actor.tenantId, record.id);
      if (existing) {
        database.prepare('DELETE FROM product_images WHERE tenant_id = ? AND id = ?')
          .run(actor.tenantId, record.id);
        mediaStorage.remove([existing.storage_key, existing.thumbnail_storage_key]);
        if (existing.is_primary === 1) {
          const nextRow = database.prepare(
            'SELECT * FROM product_images WHERE tenant_id = ? AND product_id = ? AND is_deleted = 0 ORDER BY sort_order ASC, created_at ASC LIMIT 1'
          ).get(actor.tenantId, existing.product_id);
          if (nextRow) {
            const promoted = { ...mapRow(nextRow), isPrimary: true, syncStatus: 'SYNCED' };
            database.prepare(
              "UPDATE product_images SET is_primary=1,sync_status='SYNCED',data_json=? WHERE tenant_id=? AND id=?"
            ).run(JSON.stringify(promoted), actor.tenantId, promoted.id);
          }
        }
      }
    },

    cacheRemoteProductImage(actor, input) {
      assertPermission(actor, 'inventory:view', 'مزامنة صورة صنف');
      const record = input?.record;
      if (!record || record.tenantId !== actor.tenantId) throw new Error('حظر عزل المؤسسات: بيانات الصورة البعيدة غير مطابقة.');
      const product = loadProduct(actor, record.productId, 'مزامنة صورة صنف');
      if (product.activity_id !== record.activityId) throw new Error('النشاط التجاري للصورة لا يطابق الصنف.');
      const stored = mediaStorage.store({
        tenantId: actor.tenantId,
        activityId: record.activityId,
        productId: record.productId,
        imageId: record.id,
        mimeType: record.mimeType,
        width: record.width,
        height: record.height,
        originalDataUrl: input.originalDataUrl,
        thumbnailDataUrl: input.thumbnailDataUrl,
      });
      const clean = { ...record, storageKey: stored.storageKey, thumbnailStorageKey: stored.thumbnailStorageKey,
        sizeBytes: stored.sizeBytes, thumbnailSizeBytes: stored.thumbnailSizeBytes,
        checksumSha256: stored.checksumSha256, syncStatus: 'SYNCED' };
      if (clean.isPrimary) {
        database.prepare(
          "UPDATE product_images SET is_primary=0,data_json=json_set(data_json,'$.isPrimary',false) WHERE tenant_id=? AND product_id=? AND id<>? AND is_deleted=0"
        ).run(actor.tenantId, clean.productId, clean.id);
      }
      database.prepare(
        `INSERT INTO product_images
          (tenant_id,id,product_id,activity_id,storage_key,thumbnail_storage_key,mime_type,size_bytes,
           thumbnail_size_bytes,width,height,checksum_sha256,is_primary,sort_order,created_by,created_at,
           updated_at,sync_status,is_deleted,data_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id,id) DO UPDATE SET
          storage_key=excluded.storage_key,thumbnail_storage_key=excluded.thumbnail_storage_key,
          size_bytes=excluded.size_bytes,thumbnail_size_bytes=excluded.thumbnail_size_bytes,
          checksum_sha256=excluded.checksum_sha256,sync_status='SYNCED',is_deleted=excluded.is_deleted,
          data_json=excluded.data_json`
      ).run(
        clean.tenantId, clean.id, clean.productId, clean.activityId, clean.storageKey, clean.thumbnailStorageKey,
        clean.mimeType, clean.sizeBytes, clean.thumbnailSizeBytes, clean.width, clean.height, clean.checksumSha256,
        clean.isPrimary ? 1 : 0, clean.sortOrder, clean.createdBy, clean.createdAt, clean.updatedAt,
        clean.syncStatus, clean.isDeleted ? 1 : 0, JSON.stringify(clean)
      );
      return clean;
    },

    markProductImageSynced(actor, imageId) {
      assertPermission(actor, 'inventory:view', 'تأكيد مزامنة صورة الصنف');
      const row = database.prepare('SELECT * FROM product_images WHERE tenant_id = ? AND id = ?').get(actor.tenantId, imageId);
      if (!row) return;
      loadProduct(actor, row.product_id, 'تأكيد مزامنة صورة الصنف');
      const updated = { ...mapRow(row), syncStatus: 'SYNCED' };
      if (row.is_deleted === 1) {
        database.prepare('DELETE FROM product_images WHERE tenant_id = ? AND id = ?')
          .run(actor.tenantId, imageId);
        return updated;
      }
      database.prepare(
        "UPDATE product_images SET sync_status='SYNCED',data_json=json_set(data_json,'$.syncStatus','SYNCED') WHERE tenant_id=? AND id=?"
      ).run(actor.tenantId, imageId);
      return updated;
    },
  };
}
