import { randomUUID } from 'node:crypto';
import {
  assertActivityAccess,
  assertPermission,
  filterRecordsByActivityScope,
} from '../rbac.mjs';
import { parseRowJson, writeAuditLogTx } from './core-service.mjs';
import {
  createInventoryPartiesService,
  persistProductWithinTx,
  validateAndNormalizeProductInput,
} from './inventory-parties-service.mjs';

export function normalizeBrandName(rawName) {
  if (typeof rawName !== 'string') {
    throw new Error('اسم العلامة التجارية يجب أن يكون نصاً صالحاً.');
  }
  const normalized = rawName.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized) {
    throw new Error('اسم العلامة التجارية مطلوب.');
  }
  return normalized;
}

export function normalizeDisplayText(raw) {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

export function normalizeOptionSchema(rawSchema) {
  if (!Array.isArray(rawSchema) || rawSchema.length === 0) {
    throw new Error('مخطط خيارات مجموعة المنتجات يجب أن يحتوي على خيار واحد على الأقل.');
  }
  const seenKeys = new Set();
  const normalized = rawSchema.map((rawOpt, index) => {
    if (!rawOpt || typeof rawOpt !== 'object') {
      throw new Error('تعريف خيار المتغير غير صالح.');
    }
    const key = normalizeDisplayText(rawOpt.key).toLowerCase();
    const labelAr = normalizeDisplayText(rawOpt.labelAr);
    if (!key) {
      throw new Error('مفتاح خيار المتغير مطلوب.');
    }
    if (!labelAr) {
      throw new Error(`اسم الخيار (${key}) مطلوب.`);
    }
    if (seenKeys.has(key)) {
      throw new Error(`مفتاح الخيار (${key}) مكرر داخل مخطط المجموعة.`);
    }
    seenKeys.add(key);

    if (!Array.isArray(rawOpt.values) || rawOpt.values.length === 0) {
      throw new Error(`يجب تحديد قيمة واحدة على الأقل للخيار (${labelAr}).`);
    }
    const seenValues = new Set();
    const cleanValues = [];
    for (const rawVal of rawOpt.values) {
      const val = normalizeDisplayText(rawVal);
      if (!val) {
        throw new Error(`توجد قيمة فارغة داخل الخيار (${labelAr}).`);
      }
      const normVal = val.toLowerCase();
      if (seenValues.has(normVal)) {
        throw new Error(`القيمة (${val}) مكررة داخل الخيار (${labelAr}).`);
      }
      seenValues.add(normVal);
      cleanValues.push(val);
    }

    const sortOrder =
      typeof rawOpt.sortOrder === 'number' && Number.isFinite(rawOpt.sortOrder)
        ? Math.trunc(rawOpt.sortOrder)
        : index + 1;

    return {
      key,
      labelAr,
      values: cleanValues,
      required: rawOpt.required !== false,
      sortOrder,
    };
  });

  normalized.sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key, 'en'));
  return normalized;
}

export function computeCanonicalVariantKeyAndAttributes(optionSchema, rawAttributes) {
  const schema = normalizeOptionSchema(optionSchema);
  if (!rawAttributes || typeof rawAttributes !== 'object' || Array.isArray(rawAttributes)) {
    throw new Error('سمات المتغير يجب أن تكون كائناً صالحاً.');
  }

  const schemaByKey = new Map(schema.map((opt) => [opt.key, opt]));
  const inputByNormalizedKey = new Map();

  for (const [rawKey, rawVal] of Object.entries(rawAttributes)) {
    const key = normalizeDisplayText(rawKey).toLowerCase();
    if (!key || !schemaByKey.has(key)) {
      throw new Error(`سمة متغير غير معرفة في مخطط المجموعة: ${rawKey}`);
    }
    if (rawVal !== undefined && rawVal !== null && typeof rawVal !== 'string') {
      throw new Error(`قيمة السمة (${rawKey}) يجب أن تكون نصاً.`);
    }
    const val = normalizeDisplayText(rawVal ?? '');
    if (inputByNormalizedKey.has(key)) {
      throw new Error(`تم تمرير السمة (${key}) أكثر من مرة.`);
    }
    inputByNormalizedKey.set(key, val);
  }

  const canonicalAttributes = {};
  const keyParts = [];

  for (const opt of schema) {
    const provided = inputByNormalizedKey.get(opt.key) || '';
    if (!provided) {
      if (opt.required) {
        throw new Error(`قيمة الخيار (${opt.labelAr}) مطلوبة لكل متغير.`);
      }
      continue;
    }
    const providedLower = provided.toLowerCase();
    const matchedOfficialValue = opt.values.find((v) => v.toLowerCase() === providedLower);
    if (!matchedOfficialValue) {
      throw new Error(`القيمة (${provided}) غير معرفة ضمن خيارات (${opt.labelAr}).`);
    }
    canonicalAttributes[opt.key] = matchedOfficialValue;
    keyParts.push(`${encodeURIComponent(opt.key)}=${encodeURIComponent(matchedOfficialValue.toLowerCase())}`);
  }

  if (keyParts.length === 0) {
    throw new Error('يجب تحديد قيمة متغير واحدة على الأقل لكل SKU داخل المجموعة.');
  }

  return {
    variantKey: keyParts.join('&'),
    variantAttributes: canonicalAttributes,
  };
}

function hydrateBrandRow(row) {
  const parsed = parseRowJson(row);
  return {
    ...parsed,
    id: row.id,
    tenantId: row.tenant_id,
    nameAr: row.name_ar,
    normalizedName: row.normalized_name,
    isActive: row.is_active === 1,
  };
}

function hydrateProductFamilyRow(row) {
  const parsed = parseRowJson(row);
  let optionSchema = [];
  try {
    optionSchema = JSON.parse(row.option_schema_json || '[]');
  } catch {
    optionSchema = Array.isArray(parsed.optionSchema) ? parsed.optionSchema : [];
  }
  return {
    ...parsed,
    id: row.id,
    tenantId: row.tenant_id,
    activityId: row.activity_id,
    nameAr: row.name_ar,
    categorySnapshot: row.category_snapshot || parsed.categorySnapshot || '',
    ...(row.brand_id ? { brandId: row.brand_id } : {}),
    optionSchema,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hydrateCatalogMetaRow(row) {
  const parsed = parseRowJson(row);
  let variantAttributes = {};
  try {
    const parsedAttrs = JSON.parse(row.variant_attributes_json || '{}');
    if (parsedAttrs && typeof parsedAttrs === 'object' && !Array.isArray(parsedAttrs)) {
      variantAttributes = parsedAttrs;
    }
  } catch {
    variantAttributes = parsed.variantAttributes || {};
  }
  return {
    ...parsed,
    productId: row.product_id,
    tenantId: row.tenant_id,
    ...(row.family_id ? { familyId: row.family_id } : {}),
    ...(row.brand_id ? { brandId: row.brand_id } : {}),
    ...(row.variant_key ? { variantKey: row.variant_key } : {}),
    variantAttributes,
  };
}

function hydrateProductUnitRow(row) {
  const parsed = parseRowJson(row);
  return {
    ...parsed,
    id: row.id,
    tenantId: row.tenant_id,
    productId: row.product_id,
    code: row.code,
    nameAr: row.name_ar,
    ...(row.name_en ? { nameEn: row.name_en } : {}),
    baseUnitsNumerator: row.base_units_numerator,
    baseUnitsDenominator: row.base_units_denominator,
    ...(row.barcode ? { barcode: row.barcode } : {}),
    ...(row.normalized_barcode ? { normalizedBarcode: row.normalized_barcode } : {}),
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createProductCatalogService(database, core = null) {
  const inventoryParties = createInventoryPartiesService(database, core);

  return {
    getBrands(actor, includeInactive = false) {
      assertPermission(actor, 'inventory:view', 'عرض العلامات التجارية');
      const rows = includeInactive
        ? database.prepare(
            'SELECT tenant_id,id,name_ar,normalized_name,is_active,data_json FROM brands WHERE tenant_id = ? ORDER BY name_ar ASC, rowid ASC'
          ).all(actor.tenantId)
        : database.prepare(
            'SELECT tenant_id,id,name_ar,normalized_name,is_active,data_json FROM brands WHERE tenant_id = ? AND is_active = 1 ORDER BY name_ar ASC, rowid ASC'
          ).all(actor.tenantId);
      return rows.map(hydrateBrandRow);
    },

    saveBrandAtomic(actor, input) {
      assertPermission(actor, 'inventory:write', 'حفظ علامة تجارية');
      if (!input || typeof input !== 'object') {
        throw new Error('بيانات العلامة التجارية غير صالحة.');
      }
      if (input.isActive !== undefined && typeof input.isActive !== 'boolean') {
        throw new Error('حالة العلامة التجارية غير صالحة.');
      }
      if (input.id !== undefined && typeof input.id !== 'string') {
        throw new Error('معرف العلامة التجارية غير صالح.');
      }
      const normalizedName = normalizeBrandName(input.nameAr);
      const nameAr = normalizeDisplayText(input.nameAr);
      const id = String(input.id || '').trim() || randomUUID();
      const nowIso = new Date().toISOString();

      database.exec('BEGIN IMMEDIATE');
      try {
        const existingRow = database.prepare(
          'SELECT tenant_id,id,name_ar,normalized_name,is_active,data_json FROM brands WHERE tenant_id = ? AND id = ?'
        ).get(actor.tenantId, id);
        const existing = existingRow ? hydrateBrandRow(existingRow) : null;

        const duplicate = database.prepare(
          'SELECT 1 AS found FROM brands WHERE tenant_id = ? AND normalized_name = ? AND id <> ? LIMIT 1'
        ).get(actor.tenantId, normalizedName, id);
        if (duplicate) {
          throw new Error('العلامة التجارية مسجلة بالفعل.');
        }

        const isActive =
          input.isActive === undefined
            ? existing
              ? existing.isActive
              : true
            : input.isActive !== false;

        const brand = {
          id,
          tenantId: actor.tenantId,
          nameAr,
          normalizedName,
          isActive,
          createdAt: existing?.createdAt || nowIso,
          updatedAt: nowIso,
        };

        database.prepare(
          `INSERT INTO brands (tenant_id,id,name_ar,normalized_name,is_active,data_json)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(tenant_id,id) DO UPDATE SET
             name_ar=excluded.name_ar,
             normalized_name=excluded.normalized_name,
             is_active=excluded.is_active,
             data_json=excluded.data_json`
        ).run(actor.tenantId, id, nameAr, normalizedName, isActive ? 1 : 0, JSON.stringify(brand));

        writeAuditLogTx(
          database,
          actor,
          existing ? 'تعديل علامة تجارية' : 'إضافة علامة تجارية',
          `تم حفظ العلامة التجارية ${nameAr}`,
          nowIso
        );
        database.exec('COMMIT');
        return brand;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    archiveBrandAtomic(actor, brandId) {
      assertPermission(actor, 'inventory:write', 'أرشفة علامة تجارية');
      const id = String(brandId || '').trim();
      if (!id) {
        throw new Error('معرف العلامة التجارية مطلوب.');
      }
      const nowIso = new Date().toISOString();

      database.exec('BEGIN IMMEDIATE');
      try {
        const row = database.prepare(
          'SELECT tenant_id,id,name_ar,normalized_name,is_active,data_json FROM brands WHERE tenant_id = ? AND id = ?'
        ).get(actor.tenantId, id);
        if (!row) {
          throw new Error('العلامة التجارية غير موجودة.');
        }
        const existing = hydrateBrandRow(row);
        const archived = {
          ...existing,
          isActive: false,
          updatedAt: nowIso,
        };
        database.prepare(
          'UPDATE brands SET is_active = 0, data_json = ? WHERE tenant_id = ? AND id = ?'
        ).run(JSON.stringify(archived), actor.tenantId, id);

        writeAuditLogTx(
          database,
          actor,
          'أرشفة علامة تجارية',
          `تمت أرشفة العلامة التجارية ${archived.nameAr} (${id})`,
          nowIso
        );
        database.exec('COMMIT');
        return archived;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    getProductFamilies(actor, activityId, includeInactive = false) {
      assertPermission(actor, 'inventory:view', 'عرض مجموعات المنتجات');
      const conditions = ['tenant_id = ?'];
      const params = [actor.tenantId];
      if (activityId && activityId !== 'all') {
        conditions.push('activity_id = ?');
        params.push(String(activityId));
      }
      if (!includeInactive) {
        conditions.push('is_active = 1');
      }
      const rows = database.prepare(
        `SELECT tenant_id,id,activity_id,name_ar,category_snapshot,brand_id,option_schema_json,is_active,created_at,updated_at,data_json
         FROM product_families
         WHERE ${conditions.join(' AND ')}
         ORDER BY created_at ASC, rowid ASC`
      ).all(...params);
      const families = rows.map(hydrateProductFamilyRow);
      return filterRecordsByActivityScope(families, actor);
    },

    getProductFamilyById(actor, familyId) {
      assertPermission(actor, 'inventory:view', 'عرض مجموعة منتجات');
      const id = String(familyId || '').trim();
      if (!id) return undefined;
      const row = database.prepare(
        `SELECT tenant_id,id,activity_id,name_ar,category_snapshot,brand_id,option_schema_json,is_active,created_at,updated_at,data_json
         FROM product_families WHERE tenant_id = ? AND id = ?`
      ).get(actor.tenantId, id);
      if (!row) return undefined;
      return filterRecordsByActivityScope([hydrateProductFamilyRow(row)], actor)[0];
    },

    createProductFamilyWithSkusAtomic(actor, input) {
      assertPermission(actor, 'inventory:write', 'إنشاء مجموعة منتجات');
      if (!input || typeof input !== 'object') {
        throw new Error('بيانات مجموعة المنتجات غير صالحة.');
      }
      const activityId = String(input.activityId || '').trim();
      if (!activityId) {
        throw new Error('النشاط التجاري مطلوب لإنشاء مجموعة المنتجات.');
      }
      assertActivityAccess(actor, activityId, 'إنشاء مجموعة منتجات');

      const nameAr = normalizeDisplayText(input.nameAr);
      if (!nameAr) {
        throw new Error('اسم مجموعة المنتجات مطلوب.');
      }
      const categorySnapshot = normalizeDisplayText(input.categorySnapshot || '');
      const brandId = input.brandId ? String(input.brandId).trim() : undefined;
      const optionSchema = normalizeOptionSchema(input.optionSchema);

      if (!Array.isArray(input.skus) || input.skus.length === 0) {
        throw new Error('يجب إضافة متغير واحد (SKU) على الأقل عند إنشاء مجموعة المنتجات.');
      }

      const familyId = String(input.id || '').trim() || randomUUID();
      const nowIso = new Date().toISOString();

      database.exec('BEGIN IMMEDIATE');
      try {
        const actRow = database.prepare(
          'SELECT 1 FROM activities WHERE tenant_id = ? AND id = ?'
        ).get(actor.tenantId, activityId);
        if (!actRow) {
          throw new Error(`النشاط التجاري (${activityId}) غير موجود.`);
        }

        const existingFamily = database.prepare(
          'SELECT 1 FROM product_families WHERE tenant_id = ? AND id = ?'
        ).get(actor.tenantId, familyId);
        if (existingFamily) {
          throw new Error(`مجموعة المنتجات (${familyId}) موجودة بالفعل.`);
        }

        let brand = undefined;
        if (brandId) {
          const brandRow = database.prepare(
            'SELECT tenant_id,id,name_ar,normalized_name,is_active,data_json FROM brands WHERE tenant_id = ? AND id = ?'
          ).get(actor.tenantId, brandId);
          if (!brandRow || brandRow.is_active !== 1) {
            throw new Error('العلامة التجارية المحددة غير موجودة أو مؤرشفة.');
          }
          brand = hydrateBrandRow(brandRow);
        }

        const family = {
          id: familyId,
          tenantId: actor.tenantId,
          activityId,
          nameAr,
          categorySnapshot,
          ...(brandId ? { brandId } : {}),
          optionSchema,
          isActive: true,
          createdAt: nowIso,
          updatedAt: nowIso,
        };

        database.prepare(
          `INSERT INTO product_families (
             tenant_id,id,activity_id,name_ar,category_snapshot,brand_id,option_schema_json,is_active,created_at,updated_at,data_json
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          actor.tenantId,
          family.id,
          family.activityId,
          family.nameAr,
          family.categorySnapshot,
          brandId || null,
          JSON.stringify(family.optionSchema),
          1,
          family.createdAt,
          family.updatedAt,
          JSON.stringify(family)
        );

        const seenVariantKeys = new Set();
        const seenProductIds = new Set();
        const seenCodes = new Set();
        const seenBarcodes = new Set();
        const checkExistingProductId = database.prepare(
          'SELECT 1 FROM products WHERE tenant_id = ? AND id = ? LIMIT 1'
        );
        const checkExistingCode = database.prepare(
          'SELECT 1 FROM products WHERE tenant_id = ? AND LOWER(TRIM(code)) = ? LIMIT 1'
        );
        const checkExistingProductBarcode = database.prepare(
          'SELECT 1 FROM products WHERE tenant_id = ? AND TRIM(barcode) = ? LIMIT 1'
        );
        const checkExistingUnitBarcode = database.prepare(
          'SELECT 1 FROM product_units WHERE tenant_id = ? AND normalized_barcode = ? LIMIT 1'
        );
        const insertMetaStmt = database.prepare(
          `INSERT INTO product_catalog_meta (
             tenant_id,product_id,family_id,brand_id,variant_key,variant_attributes_json,data_json
           ) VALUES (?,?,?,?,?,?,?)`
        );

        const createdEntries = [];
        for (const skuInput of input.skus) {
          if (!skuInput || !skuInput.product || typeof skuInput.product !== 'object') {
            throw new Error('بيانات أحد المتغيرات (SKU) غير صالحة.');
          }
          const rawActivityId = skuInput.product.activityId
            ? String(skuInput.product.activityId).trim()
            : activityId;
          if (rawActivityId !== activityId) {
            throw new Error('نشاط المتغير (SKU) يجب أن يطابق نشاط مجموعة المنتجات.');
          }

          const normalizedProduct = validateAndNormalizeProductInput(
            database,
            actor,
            {
              ...skuInput.product,
              activityId,
              category: skuInput.product.category || categorySnapshot,
            },
            false
          );

          if (seenProductIds.has(normalizedProduct.id) || checkExistingProductId.get(actor.tenantId, normalizedProduct.id)) {
            throw new Error(`معرّف الصنف (${normalizedProduct.id}) مكرر أو موجود مسبقاً.`);
          }
          seenProductIds.add(normalizedProduct.id);

          const normalizedCodeKey = normalizedProduct.code.toLowerCase();
          if (seenCodes.has(normalizedCodeKey) || checkExistingCode.get(actor.tenantId, normalizedCodeKey)) {
            throw new Error(`كود الصنف (${normalizedProduct.code}) مستخدم بالفعل.`);
          }
          seenCodes.add(normalizedCodeKey);

          const cleanBarcode = normalizedProduct.barcode ? String(normalizedProduct.barcode).trim() : '';
          if (cleanBarcode) {
            if (
              seenBarcodes.has(cleanBarcode) ||
              checkExistingProductBarcode.get(actor.tenantId, cleanBarcode) ||
              checkExistingUnitBarcode.get(actor.tenantId, cleanBarcode)
            ) {
              throw new Error(`الباركود (${cleanBarcode}) مستخدم بالفعل لصنف أو وحدة أخرى.`);
            }
            seenBarcodes.add(cleanBarcode);
          }

          const { variantKey, variantAttributes } = computeCanonicalVariantKeyAndAttributes(
            optionSchema,
            skuInput.variantAttributes
          );
          if (seenVariantKeys.has(variantKey)) {
            throw new Error('توجد تركيبة متغير مكررة داخل مجموعة المنتجات.');
          }
          seenVariantKeys.add(variantKey);

          const persistedProduct = persistProductWithinTx(database, core, actor, normalizedProduct, {
            isUpdate: false,
            skipAuditLog: true,
            nowIso,
          });

          const meta = {
            productId: persistedProduct.id,
            tenantId: actor.tenantId,
            familyId: family.id,
            variantKey,
            variantAttributes,
          };

          insertMetaStmt.run(
            actor.tenantId,
            meta.productId,
            meta.familyId,
            null,
            meta.variantKey,
            JSON.stringify(meta.variantAttributes),
            JSON.stringify(meta)
          );

          createdEntries.push({
            product: persistedProduct,
            meta,
            family,
            ...(brand ? { brand } : {}),
            variantAttributes,
            units: [],
          });
        }

        writeAuditLogTx(
          database,
          actor,
          'إنشاء مجموعة منتجات',
          `إنشاء المجموعة ${family.nameAr} بعدد ${createdEntries.length} متغيرات (SKU)`,
          nowIso
        );
        database.exec('COMMIT');
        return { family, skus: createdEntries };
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    updateProductFamilyAtomic(actor, input) {
      assertPermission(actor, 'inventory:write', 'تعديل مجموعة منتجات');
      if (!input || typeof input !== 'object') {
        throw new Error('بيانات تحديث مجموعة المنتجات غير صالحة.');
      }
      const id = String(input.id || '').trim();
      if (!id) {
        throw new Error('معرف مجموعة المنتجات مطلوب.');
      }
      const nameAr = normalizeDisplayText(input.nameAr);
      if (!nameAr) {
        throw new Error('اسم مجموعة المنتجات مطلوب.');
      }
      if (input.isActive !== undefined && typeof input.isActive !== 'boolean') {
        throw new Error('حالة مجموعة المنتجات غير صالحة.');
      }
      const nowIso = new Date().toISOString();

      database.exec('BEGIN IMMEDIATE');
      try {
        const row = database.prepare(
          `SELECT tenant_id,id,activity_id,name_ar,category_snapshot,brand_id,option_schema_json,is_active,created_at,updated_at,data_json
           FROM product_families WHERE tenant_id = ? AND id = ?`
        ).get(actor.tenantId, id);
        if (!row) {
          throw new Error('مجموعة المنتجات غير موجودة.');
        }
        const existing = hydrateProductFamilyRow(row);
        assertActivityAccess(actor, existing.activityId, 'تعديل مجموعة منتجات');

        let nextBrandId = existing.brandId;
        if (input.brandId !== undefined) {
          if (input.brandId === null || String(input.brandId).trim() === '') {
            nextBrandId = undefined;
          } else {
            const candidateBrandId = String(input.brandId).trim();
            const brandRow = database.prepare(
              'SELECT is_active FROM brands WHERE tenant_id = ? AND id = ?'
            ).get(actor.tenantId, candidateBrandId);
            if (!brandRow || (candidateBrandId !== existing.brandId && brandRow.is_active !== 1)) {
              throw new Error('العلامة التجارية المحددة غير موجودة أو مؤرشفة.');
            }
            nextBrandId = candidateBrandId;
          }
        }

        let nextOptionSchema = existing.optionSchema;
        if (input.optionSchema !== undefined) {
          nextOptionSchema = normalizeOptionSchema(input.optionSchema);
          const linkedMetaRows = database.prepare(
            'SELECT product_id,variant_key,variant_attributes_json FROM product_catalog_meta WHERE tenant_id = ? AND family_id = ?'
          ).all(actor.tenantId, id);
          const seenKeys = new Set();
          for (const metaRow of linkedMetaRows) {
            let attrs = {};
            try {
              attrs = JSON.parse(metaRow.variant_attributes_json || '{}');
            } catch {
              attrs = {};
            }
            let recomputed;
            try {
              recomputed = computeCanonicalVariantKeyAndAttributes(nextOptionSchema, attrs);
            } catch {
              throw new Error('لا يمكن حذف أو تعديل خيارات مرتبطة بمتغيرات (SKU) قائمة داخل المجموعة.');
            }
            if (recomputed.variantKey !== metaRow.variant_key || seenKeys.has(recomputed.variantKey)) {
              throw new Error('لا يمكن تعديل مخطط الخيارات بما يغير أو يكرر مفاتيح المتغيرات القائمة.');
            }
            seenKeys.add(recomputed.variantKey);
          }
        }

        const nextCategorySnapshot =
          input.categorySnapshot !== undefined
            ? normalizeDisplayText(input.categorySnapshot)
            : existing.categorySnapshot;
        const nextIsActive =
          input.isActive === undefined ? existing.isActive : input.isActive !== false;

        const updated = {
          id: existing.id,
          tenantId: actor.tenantId,
          activityId: existing.activityId,
          nameAr,
          categorySnapshot: nextCategorySnapshot,
          ...(nextBrandId ? { brandId: nextBrandId } : {}),
          optionSchema: nextOptionSchema,
          isActive: nextIsActive,
          createdAt: existing.createdAt,
          updatedAt: nowIso,
        };

        database.prepare(
          `UPDATE product_families
           SET name_ar = ?, category_snapshot = ?, brand_id = ?, option_schema_json = ?, is_active = ?, updated_at = ?, data_json = ?
           WHERE tenant_id = ? AND id = ?`
        ).run(
          updated.nameAr,
          updated.categorySnapshot,
          nextBrandId || null,
          JSON.stringify(updated.optionSchema),
          updated.isActive ? 1 : 0,
          updated.updatedAt,
          JSON.stringify(updated),
          actor.tenantId,
          updated.id
        );

        writeAuditLogTx(
          database,
          actor,
          'تعديل مجموعة منتجات',
          `تحديث مجموعة المنتجات ${updated.nameAr} (${updated.id})`,
          nowIso
        );
        database.exec('COMMIT');
        return updated;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    archiveProductFamilyAtomic(actor, familyId) {
      assertPermission(actor, 'inventory:write', 'أرشفة مجموعة منتجات');
      const id = String(familyId || '').trim();
      if (!id) {
        throw new Error('معرف مجموعة المنتجات مطلوب.');
      }
      const nowIso = new Date().toISOString();

      database.exec('BEGIN IMMEDIATE');
      try {
        const row = database.prepare(
          `SELECT tenant_id,id,activity_id,name_ar,category_snapshot,brand_id,option_schema_json,is_active,created_at,updated_at,data_json
           FROM product_families WHERE tenant_id = ? AND id = ?`
        ).get(actor.tenantId, id);
        if (!row) {
          throw new Error('مجموعة المنتجات غير موجودة.');
        }
        const existing = hydrateProductFamilyRow(row);
        assertActivityAccess(actor, existing.activityId, 'أرشفة مجموعة منتجات');

        const archived = {
          ...existing,
          isActive: false,
          updatedAt: nowIso,
        };
        database.prepare(
          'UPDATE product_families SET is_active = 0, updated_at = ?, data_json = ? WHERE tenant_id = ? AND id = ?'
        ).run(nowIso, JSON.stringify(archived), actor.tenantId, id);

        writeAuditLogTx(
          database,
          actor,
          'أرشفة مجموعة منتجات',
          `تمت أرشفة مجموعة المنتجات ${archived.nameAr} (${id})`,
          nowIso
        );
        database.exec('COMMIT');
        return archived;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    assignProductBrandAtomic(actor, input) {
      assertPermission(actor, 'inventory:write', 'تعيين علامة تجارية للصنف');
      if (!input || typeof input !== 'object') {
        throw new Error('بيانات ربط العلامة التجارية غير صالحة.');
      }
      const productId = String(input.productId || '').trim();
      if (!productId) {
        throw new Error('معرف الصنف مطلوب.');
      }
      const brandId =
        input.brandId === null || input.brandId === undefined || String(input.brandId).trim() === ''
          ? null
          : String(input.brandId).trim();
      const nowIso = new Date().toISOString();

      database.exec('BEGIN IMMEDIATE');
      try {
        const productRow = database.prepare(
          'SELECT activity_id,data_json FROM products WHERE tenant_id = ? AND id = ?'
        ).get(actor.tenantId, productId);
        if (!productRow) {
          throw new Error('الصنف غير موجود.');
        }
        assertActivityAccess(actor, productRow.activity_id, 'تعيين علامة تجارية للصنف');

        const existingMetaRow = database.prepare(
          'SELECT tenant_id,product_id,family_id,brand_id,variant_key,variant_attributes_json,data_json FROM product_catalog_meta WHERE tenant_id = ? AND product_id = ?'
        ).get(actor.tenantId, productId);
        if (existingMetaRow && existingMetaRow.family_id) {
          throw new Error('لا يمكن تعيين علامة تجارية مستقلة لصنف تابع لمجموعة منتجات؛ تُدار العلامة من المجموعة نفسها.');
        }

        if (!brandId) {
          database.prepare(
            'DELETE FROM product_catalog_meta WHERE tenant_id = ? AND product_id = ? AND family_id IS NULL'
          ).run(actor.tenantId, productId);
          writeAuditLogTx(
            database,
            actor,
            'إزالة علامة تجارية لصنف',
            `تمت إزالة العلامة التجارية عن الصنف ${productId}`,
            nowIso
          );
          database.exec('COMMIT');
          return undefined;
        }

        const brandRow = database.prepare(
          'SELECT name_ar,is_active FROM brands WHERE tenant_id = ? AND id = ?'
        ).get(actor.tenantId, brandId);
        if (!brandRow || brandRow.is_active !== 1) {
          throw new Error('العلامة التجارية المحددة غير موجودة أو مؤرشفة.');
        }

        const meta = {
          productId,
          tenantId: actor.tenantId,
          brandId,
          variantAttributes: {},
        };
        database.prepare(
          `INSERT INTO product_catalog_meta (
             tenant_id,product_id,family_id,brand_id,variant_key,variant_attributes_json,data_json
           ) VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(tenant_id,product_id) DO UPDATE SET
             family_id=NULL,
             brand_id=excluded.brand_id,
             variant_key=NULL,
             variant_attributes_json='{}',
             data_json=excluded.data_json`
        ).run(actor.tenantId, productId, null, brandId, null, '{}', JSON.stringify(meta));

        writeAuditLogTx(
          database,
          actor,
          'تعيين علامة تجارية لصنف',
          `تم ربط الصنف ${productId} بالعلامة التجارية ${brandRow.name_ar}`,
          nowIso
        );
        database.exec('COMMIT');
        return meta;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    getProductCatalog(actor, activityId) {
      assertPermission(actor, 'inventory:view', 'عرض دليل المنتجات');
      const products = inventoryParties.getProducts(actor, activityId);
      if (products.length === 0) return [];

      const metaRows = database.prepare(
        'SELECT tenant_id,product_id,family_id,brand_id,variant_key,variant_attributes_json,data_json FROM product_catalog_meta WHERE tenant_id = ?'
      ).all(actor.tenantId);
      const familyRows = database.prepare(
        'SELECT tenant_id,id,activity_id,name_ar,category_snapshot,brand_id,option_schema_json,is_active,created_at,updated_at,data_json FROM product_families WHERE tenant_id = ?'
      ).all(actor.tenantId);
      const brandRows = database.prepare(
        'SELECT tenant_id,id,name_ar,normalized_name,is_active,data_json FROM brands WHERE tenant_id = ?'
      ).all(actor.tenantId);
      const unitRows = database.prepare(
        'SELECT tenant_id,id,product_id,code,name_ar,name_en,base_units_numerator,base_units_denominator,barcode,normalized_barcode,is_active,created_at,updated_at,data_json FROM product_units WHERE tenant_id = ? ORDER BY created_at ASC, rowid ASC'
      ).all(actor.tenantId);

      const metaByProduct = new Map(metaRows.map((r) => [r.product_id, hydrateCatalogMetaRow(r)]));
      const familyById = new Map(familyRows.map((r) => [r.id, hydrateProductFamilyRow(r)]));
      const brandById = new Map(brandRows.map((r) => [r.id, hydrateBrandRow(r)]));
      const unitsByProduct = new Map();
      for (const uRow of unitRows) {
        const list = unitsByProduct.get(uRow.product_id) || [];
        list.push(hydrateProductUnitRow(uRow));
        unitsByProduct.set(uRow.product_id, list);
      }

      return products.map((product) => {
        const meta = metaByProduct.get(product.id);
        const family = meta?.familyId ? familyById.get(meta.familyId) : undefined;
        const resolvedBrandId = meta?.brandId || family?.brandId;
        const brand = resolvedBrandId ? brandById.get(resolvedBrandId) : undefined;
        return {
          product,
          ...(meta ? { meta } : {}),
          ...(family ? { family } : {}),
          ...(brand ? { brand } : {}),
          variantAttributes: meta?.variantAttributes || {},
          units: unitsByProduct.get(product.id) || [],
        };
      });
    },

    getProductCatalogEntry(actor, productId) {
      assertPermission(actor, 'inventory:view', 'عرض تفاصيل الصنف في الدليل');
      const id = String(productId || '').trim();
      if (!id) return undefined;
      const product = inventoryParties.getProductById(actor, id);
      if (!product) return undefined;

      const metaRow = database.prepare(
        'SELECT tenant_id,product_id,family_id,brand_id,variant_key,variant_attributes_json,data_json FROM product_catalog_meta WHERE tenant_id = ? AND product_id = ?'
      ).get(actor.tenantId, id);
      const meta = metaRow ? hydrateCatalogMetaRow(metaRow) : undefined;

      let family = undefined;
      if (meta?.familyId) {
        const famRow = database.prepare(
          'SELECT tenant_id,id,activity_id,name_ar,category_snapshot,brand_id,option_schema_json,is_active,created_at,updated_at,data_json FROM product_families WHERE tenant_id = ? AND id = ?'
        ).get(actor.tenantId, meta.familyId);
        if (famRow) family = hydrateProductFamilyRow(famRow);
      }

      const resolvedBrandId = meta?.brandId || family?.brandId;
      let brand = undefined;
      if (resolvedBrandId) {
        const brandRow = database.prepare(
          'SELECT tenant_id,id,name_ar,normalized_name,is_active,data_json FROM brands WHERE tenant_id = ? AND id = ?'
        ).get(actor.tenantId, resolvedBrandId);
        if (brandRow) brand = hydrateBrandRow(brandRow);
      }

      const unitRows = database.prepare(
        'SELECT tenant_id,id,product_id,code,name_ar,name_en,base_units_numerator,base_units_denominator,barcode,normalized_barcode,is_active,created_at,updated_at,data_json FROM product_units WHERE tenant_id = ? AND product_id = ? ORDER BY created_at ASC, rowid ASC'
      ).all(actor.tenantId, id);

      return {
        product,
        ...(meta ? { meta } : {}),
        ...(family ? { family } : {}),
        ...(brand ? { brand } : {}),
        variantAttributes: meta?.variantAttributes || {},
        units: unitRows.map(hydrateProductUnitRow),
      };
    },
  };
}
