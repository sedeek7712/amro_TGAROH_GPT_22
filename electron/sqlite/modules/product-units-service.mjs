import { randomUUID } from 'node:crypto';
import { assertActivityAccess, assertPermission } from '../rbac.mjs';
import { parseRowJson, writeAuditLogTx } from './core-service.mjs';

function normalizeRatio(numerator, denominator) {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0) {
    throw new Error('معامل التحويل يجب أن يتكون من عددين صحيحين موجبين.');
  }
  let a = BigInt(numerator);
  let b = BigInt(denominator);
  let x = a;
  let y = b;
  while (y !== 0n) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  a /= x;
  b /= x;
  if (a > BigInt(Number.MAX_SAFE_INTEGER) || b > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('معامل التحويل أكبر من الحد المسموح.');
  }
  return { numerator: Number(a), denominator: Number(b) };
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
    nameEn: row.name_en || undefined,
    baseUnitsNumerator: row.base_units_numerator,
    baseUnitsDenominator: row.base_units_denominator,
    barcode: row.barcode || undefined,
    normalizedBarcode: row.normalized_barcode || undefined,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createProductUnitsService(database) {
  return {
    getProductUnits(actor, productId) {
      assertPermission(actor, 'inventory:view', 'عرض وحدات الصنف');
      const id = String(productId || '').trim();
      if (!id) throw new Error('معرف الصنف مطلوب.');
      const product = database.prepare(
        'SELECT activity_id FROM products WHERE tenant_id = ? AND id = ?'
      ).get(actor.tenantId, id);
      if (!product) throw new Error('الصنف غير موجود أو لا تملك صلاحية الوصول إليه.');
      assertActivityAccess(actor, product.activity_id, 'عرض وحدات الصنف');
      const rows = database.prepare(
        'SELECT tenant_id,id,product_id,code,name_ar,name_en,base_units_numerator,base_units_denominator,barcode,normalized_barcode,is_active,created_at,updated_at,data_json FROM product_units WHERE tenant_id = ? AND product_id = ? ORDER BY created_at ASC, rowid ASC'
      ).all(actor.tenantId, id);
      return rows.map(hydrateProductUnitRow);
    },

    saveProductUnit(actor, input) {
      assertPermission(actor, 'inventory:write', 'إدارة وحدات الصنف');
      if (!input || typeof input !== 'object') throw new Error('بيانات الوحدة البديلة غير صالحة.');

      if (typeof input.productId !== 'string' || typeof input.code !== 'string' || typeof input.nameAr !== 'string') {
        throw new Error('بيانات الصنف ورمز الوحدة واسمها يجب أن تكون نصوصًا صحيحة.');
      }
      const productId = input.productId.trim();
      const code = input.code.trim();
      const nameAr = input.nameAr.trim();
      if (!productId || !code || !nameAr) {
        throw new Error('الصنف ورمز الوحدة واسم الوحدة حقول مطلوبة.');
      }
      const ratio = normalizeRatio(input.baseUnitsNumerator, input.baseUnitsDenominator);
      if (input.barcode !== undefined && input.barcode !== null && typeof input.barcode !== 'string') {
        throw new Error('باركود الوحدة يجب أن يكون نصًا.');
      }
      if (input.id !== undefined && typeof input.id !== 'string') {
        throw new Error('معرف الوحدة غير صالح.');
      }
      if (input.isActive !== undefined && typeof input.isActive !== 'boolean') {
        throw new Error('حالة الوحدة غير صالحة.');
      }
      const barcode = String(input.barcode || '').trim();
      const id = String(input.id || '').trim() || randomUUID();
      const nowIso = new Date().toISOString();

      database.exec('BEGIN IMMEDIATE');
      try {
        const product = database.prepare(
          'SELECT activity_id FROM products WHERE tenant_id = ? AND id = ?'
        ).get(actor.tenantId, productId);
        if (!product) throw new Error('الصنف غير موجود أو لا تملك صلاحية الوصول إليه.');
        assertActivityAccess(actor, product.activity_id, 'إدارة وحدات الصنف');

        const existing = database.prepare(
          'SELECT tenant_id,id,product_id,code,name_ar,name_en,base_units_numerator,base_units_denominator,barcode,normalized_barcode,is_active,created_at,updated_at,data_json FROM product_units WHERE tenant_id = ? AND id = ?'
        ).get(actor.tenantId, id);
        if (existing && existing.product_id !== productId) {
          throw new Error('لا يمكن نقل الوحدة البديلة إلى صنف آخر.');
        }
        const duplicate = database.prepare(
          'SELECT 1 AS found FROM product_units WHERE tenant_id = ? AND product_id = ? AND code = ? AND id <> ? LIMIT 1'
        ).get(actor.tenantId, productId, code, id);
        if (duplicate) throw new Error('رمز الوحدة مستخدم بالفعل لهذا الصنف.');

        if (barcode) {
          const dupUnitBarcode = database.prepare(
            'SELECT 1 AS found FROM product_units WHERE tenant_id = ? AND normalized_barcode = ? AND id <> ? LIMIT 1'
          ).get(actor.tenantId, barcode, id);
          const dupProductBarcode = database.prepare(
            'SELECT 1 AS found FROM products WHERE tenant_id = ? AND TRIM(barcode) = ? LIMIT 1'
          ).get(actor.tenantId, barcode);
          if (dupUnitBarcode || dupProductBarcode) {
            throw new Error(`الباركود (${barcode}) مستخدم بالفعل لصنف أو وحدة أخرى.`);
          }
        }

        const unit = {
          id,
          tenantId: actor.tenantId,
          productId,
          code,
          nameAr,
          ...((String(input.nameEn || '').trim() || existing?.name_en) ? { nameEn: String(input.nameEn || existing?.name_en || '').trim() } : {}),
          baseUnitsNumerator: ratio.numerator,
          baseUnitsDenominator: ratio.denominator,
          ...(barcode ? { barcode, normalizedBarcode: barcode } : {}),
          isActive: input.isActive === undefined ? (existing ? existing.is_active === 1 : true) : input.isActive !== false,
          createdAt: existing?.created_at || nowIso,
          updatedAt: nowIso,
        };
        database.prepare(
          `INSERT INTO product_units (
            tenant_id,id,product_id,code,name_ar,name_en,base_units_numerator,base_units_denominator,
            barcode,normalized_barcode,is_active,created_at,updated_at,data_json
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(tenant_id,id) DO UPDATE SET
            code=excluded.code,name_ar=excluded.name_ar,name_en=excluded.name_en,
            base_units_numerator=excluded.base_units_numerator,base_units_denominator=excluded.base_units_denominator,
            barcode=excluded.barcode,normalized_barcode=excluded.normalized_barcode,
            is_active=excluded.is_active,updated_at=excluded.updated_at,data_json=excluded.data_json`
        ).run(
          actor.tenantId,id,productId,code,nameAr,unit.nameEn || null,
          ratio.numerator,ratio.denominator,barcode || null,barcode || null,
          unit.isActive ? 1 : 0,unit.createdAt,unit.updatedAt,JSON.stringify(unit)
        );
        writeAuditLogTx(database, actor, existing ? 'تعديل وحدة بديلة' : 'إضافة وحدة بديلة', `تم حفظ الوحدة ${nameAr} (${code}) للصنف ${productId}`, nowIso);
        database.exec('COMMIT');
        return unit;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },
  };
}
