import type { ProductFamilyOption } from '../types/erp';

export function normalizeBrandName(rawName: unknown): string {
  if (typeof rawName !== 'string') {
    throw new Error('اسم العلامة التجارية يجب أن يكون نصاً صالحاً.');
  }
  const normalized = rawName.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized) {
    throw new Error('اسم العلامة التجارية مطلوب.');
  }
  return normalized;
}

export function normalizeDisplayText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

export function normalizeOptionSchema(rawSchema: unknown): ProductFamilyOption[] {
  if (!Array.isArray(rawSchema) || rawSchema.length === 0) {
    throw new Error('مخطط خيارات مجموعة المنتجات يجب أن يحتوي على خيار واحد على الأقل.');
  }
  const seenKeys = new Set<string>();
  const normalized: ProductFamilyOption[] = rawSchema.map((rawOpt, index) => {
    if (!rawOpt || typeof rawOpt !== 'object') {
      throw new Error('تعريف خيار المتغير غير صالح.');
    }
    const opt = rawOpt as Partial<ProductFamilyOption>;
    const key = normalizeDisplayText(opt.key).toLowerCase();
    const labelAr = normalizeDisplayText(opt.labelAr);
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

    if (!Array.isArray(opt.values) || opt.values.length === 0) {
      throw new Error(`يجب تحديد قيمة واحدة على الأقل للخيار (${labelAr}).`);
    }
    const seenValues = new Set<string>();
    const cleanValues: string[] = [];
    for (const rawVal of opt.values) {
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
      typeof opt.sortOrder === 'number' && Number.isFinite(opt.sortOrder)
        ? Math.trunc(opt.sortOrder)
        : index + 1;

    return {
      key,
      labelAr,
      values: cleanValues,
      required: opt.required !== false,
      sortOrder,
    };
  });

  normalized.sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key, 'en'));
  return normalized;
}

export function computeCanonicalVariantKeyAndAttributes(
  optionSchema: ProductFamilyOption[],
  rawAttributes: unknown
): { variantKey: string; variantAttributes: Record<string, string> } {
  const schema = normalizeOptionSchema(optionSchema);
  if (!rawAttributes || typeof rawAttributes !== 'object' || Array.isArray(rawAttributes)) {
    throw new Error('سمات المتغير يجب أن تكون كائناً صالحاً.');
  }

  const schemaByKey = new Map(schema.map((opt) => [opt.key, opt]));
  const rawEntries = Object.entries(rawAttributes as Record<string, unknown>);
  const inputByNormalizedKey = new Map<string, string>();

  for (const [rawKey, rawVal] of rawEntries) {
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

  const canonicalAttributes: Record<string, string> = {};
  const keyParts: string[] = [];

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
