import { inventory } from '../services/inventoryService';
import type {
  Brand,
  CommercialActivityId,
  Product,
  ProductBatch,
  ProductCatalogEntry,
  ProductFamily,
  ProductFamilyOption,
} from '../types/erp';
import { formatLocalDate } from './localDate';
import {
  computeCanonicalVariantKeyAndAttributes,
  normalizeDisplayText,
  normalizeOptionSchema,
} from './productCatalog';

export interface ProductSpecializedFieldsInput {
  trackExpiry?: boolean;
  scientificName?: string;
  dosageForm?: string;
  oemNumber?: string;
  manufacturer?: string;
  compatibleModels?: string;
  equipmentType?: string;
  serialNumber?: string;
}

export type BatchExpiryStatus = 'EXPIRED' | 'EXPIRING_SOON' | 'VALID' | 'UNKNOWN';

/** Returns only specialized fields applicable to the given activity, preventing cross-activity leakage. */
export function sanitizeSpecializedFieldsForActivity(
  activityId: CommercialActivityId,
  input?: ProductSpecializedFieldsInput | null
): ProductSpecializedFieldsInput {
  const clean = (val?: string): string | undefined => {
    const trimmed = normalizeDisplayText(val || '');
    return trimmed || undefined;
  };
  if (activityId === 'pharmacy') {
    return {
      trackExpiry: true,
      scientificName: clean(input?.scientificName),
      dosageForm: clean(input?.dosageForm),
      oemNumber: undefined,
      manufacturer: undefined,
      compatibleModels: undefined,
      equipmentType: undefined,
      serialNumber: undefined,
    };
  }
  if (activityId === 'grocery') {
    return {
      trackExpiry: Boolean(input?.trackExpiry),
      scientificName: undefined,
      dosageForm: undefined,
      oemNumber: undefined,
      manufacturer: undefined,
      compatibleModels: undefined,
      equipmentType: undefined,
      serialNumber: undefined,
    };
  }
  if (activityId === 'bike_parts') {
    return {
      trackExpiry: false,
      scientificName: undefined,
      dosageForm: undefined,
      oemNumber: clean(input?.oemNumber),
      manufacturer: clean(input?.manufacturer),
      compatibleModels: clean(input?.compatibleModels),
      equipmentType: undefined,
      serialNumber: undefined,
    };
  }
  return {
    trackExpiry: false,
    scientificName: undefined,
    dosageForm: undefined,
    oemNumber: clean(input?.oemNumber),
    manufacturer: clean(input?.manufacturer),
    compatibleModels: clean(input?.compatibleModels),
    equipmentType: clean(input?.equipmentType),
    serialNumber: clean(input?.serialNumber),
  };
}

export function getBatchExpiryStatus(
  expiryDate?: string,
  todayDate: string = formatLocalDate(),
  warningDays = 60
): { status: BatchExpiryStatus; daysRemaining: number | null } {
  const clean = (expiryDate || '').trim();
  if (!clean) return { status: 'UNKNOWN', daysRemaining: null };
  const expMs = Date.parse(`${clean}T00:00:00Z`);
  const todayMs = Date.parse(`${todayDate}T00:00:00Z`);
  if (!Number.isFinite(expMs) || !Number.isFinite(todayMs)) {
    return { status: 'UNKNOWN', daysRemaining: null };
  }
  const daysRemaining = Math.round((expMs - todayMs) / (1000 * 60 * 60 * 24));
  if (daysRemaining < 0) return { status: 'EXPIRED', daysRemaining };
  if (daysRemaining <= warningDays) return { status: 'EXPIRING_SOON', daysRemaining };
  return { status: 'VALID', daysRemaining };
}

export function sortBatchesFefo<T extends Pick<ProductBatch, 'expiryDate' | 'batchNumber'>>(
  batches: T[]
): T[] {
  return [...batches].sort((a, b) => {
    const expA = (a.expiryDate || '').trim() || '9999-12-31';
    const expB = (b.expiryDate || '').trim() || '9999-12-31';
    if (expA !== expB) return expA.localeCompare(expB);
    return (a.batchNumber || '').localeCompare(b.batchNumber || '');
  });
}

export function getFamilyFallbackProductIds(entries: ProductCatalogEntry[]): string[] {
  const active = entries.filter((e) => e.product.isActive !== false);
  const archived = entries.filter((e) => e.product.isActive === false);
  const inStock = active.filter((e) => Number(e.product.currentStock || 0) > 0);
  const outOfStock = active.filter((e) => Number(e.product.currentStock || 0) <= 0);
  return [...inStock, ...outOfStock, ...archived].map((e) => e.product.id);
}

export interface VariantSkuDraft {
  tempId: string;
  selected: boolean;
  variantAttributes: Record<string, string>;
  variantKey: string;
  nameAr: string;
  code: string;
  barcode: string;
  unit: string;
  purchasePrice: string;
  sellPrice: string;
  currentStock: string;
  minStockAlert: string;
  batchNumber: string;
  expiryDate: string;
}

export interface VariantOptionDraft {
  tempId: string;
  key: string;
  labelAr: string;
  valuesText: string;
}

export interface FamilyCatalogGroup {
  family: ProductFamily;
  brand?: Brand;
  entries: ProductCatalogEntry[];
  derivedTotalStock: number;
  activeSkuCount: number;
  archivedSkuCount: number;
}

const KNOWN_OPTION_KEY_MAP: Record<string, string> = {
  'اللون': 'color',
  'لون': 'color',
  'المقاس': 'size',
  'مقاس': 'size',
  'الحجم': 'volume',
  'حجم': 'volume',
  'السعة': 'capacity',
  'سعة': 'capacity',
  'الموديل': 'model',
  'موديل': 'model',
  'الوزن': 'weight',
  'وزن': 'weight',
  'النكهة': 'flavor',
  'نكهة': 'flavor',
  'التركيز': 'strength',
  'تركيز': 'strength',
};

export function buildOptionKeyFromLabel(
  labelAr: string,
  index: number,
  usedKeys?: Set<string>
): string {
  const clean = normalizeDisplayText(labelAr);
  const mapped = KNOWN_OPTION_KEY_MAP[clean] || KNOWN_OPTION_KEY_MAP[clean.toLowerCase()];
  const asciiSlug = clean
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const baseKey = mapped || asciiSlug || `opt_${index + 1}`;
  if (!usedKeys) return baseKey;
  let candidate = baseKey;
  let suffix = 2;
  while (usedKeys.has(candidate)) {
    candidate = `${baseKey}_${suffix}`;
    suffix++;
  }
  usedKeys.add(candidate);
  return candidate;
}

export function parseOptionValuesList(valuesText: string): string[] {
  const rawParts = valuesText
    .split(/[،,\n|/]+/g)
    .map((part) => normalizeDisplayText(part))
    .filter(Boolean);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const val of rawParts) {
    const lower = val.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      unique.push(val);
    }
  }
  return unique;
}

export function buildOptionSchemaFromDrafts(drafts: VariantOptionDraft[]): ProductFamilyOption[] {
  const usedKeys = new Set<string>();
  const raw: ProductFamilyOption[] = drafts.map((draft, index) => {
    const labelAr = normalizeDisplayText(draft.labelAr);
    const preferredKey = normalizeDisplayText(draft.key).toLowerCase();
    let key = preferredKey;
    if (!key) {
      key = buildOptionKeyFromLabel(labelAr, index, usedKeys);
    } else if (usedKeys.has(key)) {
      key = buildOptionKeyFromLabel(labelAr || key, index, usedKeys);
    } else {
      usedKeys.add(key);
    }
    return {
      key,
      labelAr,
      values: parseOptionValuesList(draft.valuesText),
      required: true,
      sortOrder: index + 1,
    };
  });
  return normalizeOptionSchema(raw);
}

export function generateVariantCombinations(params: {
  familyName: string;
  activityId: CommercialActivityId;
  optionSchema: ProductFamilyOption[];
  defaults: {
    unit: string;
    purchasePrice: string;
    sellPrice: string;
    minStockAlert: string;
    currentStock: string;
    batchNumber: string;
    expiryDate: string;
  };
  existingDrafts?: VariantSkuDraft[];
  existingCodes?: string[];
  maxCombinations?: number;
}): VariantSkuDraft[] {
  const maxCombinations = params.maxCombinations ?? 64;
  const schema = normalizeOptionSchema(params.optionSchema);
  const cleanFamilyName = normalizeDisplayText(params.familyName) || 'صنف';

  let combinations: Array<Record<string, string>> = [{}];
  for (const opt of schema) {
    const next: Array<Record<string, string>> = [];
    for (const combo of combinations) {
      for (const value of opt.values) {
        next.push({ ...combo, [opt.key]: value });
        if (next.length > maxCombinations) {
          throw new Error(
            `عدد تركيبات المتغيرات تجاوز الحد المسموح للمعاينة (${maxCombinations} متغيراً). قلّص القيم أو أضف المتغيرات على دفعات.`
          );
        }
      }
    }
    combinations = next;
  }

  const existingByKey = new Map(
    (params.existingDrafts || []).map((draft) => [draft.variantKey, draft])
  );
  const usedCodes = new Set<string>(
    (params.existingCodes || []).map((code) => code.trim().toLowerCase()).filter(Boolean)
  );
  const activityPrefixMap: Record<CommercialActivityId, string> = {
    pharmacy: 'MED',
    grocery: 'FOD',
    bike_parts: 'MBK',
    equipment_parts: 'EQP',
  };
  const baseCodeSeed = params.existingCodes
    ? (() => {
        const prefix = activityPrefixMap[params.activityId] || 'ITM';
        let nextIndex = params.existingCodes.length + 1;
        let seed = `${prefix}-${String(nextIndex).padStart(4, '0')}`;
        while (
          usedCodes.has(seed.toLowerCase()) ||
          usedCodes.has(`${seed}-v01`.toLowerCase())
        ) {
          nextIndex++;
          seed = `${prefix}-${String(nextIndex).padStart(4, '0')}`;
        }
        return seed;
      })()
    : inventory.generateProductCode(params.activityId);

  return combinations.map((rawAttrs, index) => {
    const { variantKey, variantAttributes } = computeCanonicalVariantKeyAndAttributes(
      schema,
      rawAttrs
    );
    const existing = existingByKey.get(variantKey);
    if (existing) {
      usedCodes.add(existing.code.trim().toLowerCase());
      return existing;
    }

    const orderedValues = schema
      .map((opt) => variantAttributes[opt.key])
      .filter(Boolean);
    const suffix = String(index + 1).padStart(2, '0');
    let candidateCode = `${baseCodeSeed}-V${suffix}`;
    let bump = index + 1;
    while (usedCodes.has(candidateCode.toLowerCase())) {
      bump++;
      candidateCode = `${baseCodeSeed}-V${String(bump).padStart(2, '0')}`;
    }
    usedCodes.add(candidateCode.toLowerCase());

    return {
      tempId: `sku-draft-${index + 1}-${variantKey}`,
      selected: true,
      variantAttributes,
      variantKey,
      nameAr: `${cleanFamilyName} - ${orderedValues.join(' / ')}`,
      code: candidateCode,
      barcode: '',
      unit: params.defaults.unit || 'حبة',
      purchasePrice: params.defaults.purchasePrice,
      sellPrice: params.defaults.sellPrice,
      currentStock: params.defaults.currentStock || '0',
      minStockAlert: params.defaults.minStockAlert || '5',
      batchNumber: params.defaults.batchNumber || '',
      expiryDate: params.defaults.expiryDate || '',
    };
  });
}

export function validateFamilySkuDrafts(params: {
  activityId: CommercialActivityId;
  drafts: VariantSkuDraft[];
  todayDate: string;
  trackExpiry?: boolean;
}): VariantSkuDraft[] {
  const selected = params.drafts.filter((d) => d.selected);
  if (selected.length === 0) {
    throw new Error('اختر متغيراً واحداً (SKU) على الأقل لحفظ مجموعة المنتجات.');
  }

  const seenCodes = new Set<string>();
  const seenBarcodes = new Set<string>();

  for (const draft of selected) {
    const nameAr = normalizeDisplayText(draft.nameAr);
    const code = normalizeDisplayText(draft.code);
    const barcode = normalizeDisplayText(draft.barcode);
    if (!nameAr) {
      throw new Error('اسم كل متغير (SKU) مطلوب.');
    }
    if (!code) {
      throw new Error(`كود SKU مطلوب للمتغير (${nameAr}).`);
    }
    const codeKey = code.toLowerCase();
    if (seenCodes.has(codeKey)) {
      throw new Error(`كود الصنف (${code}) مكرر داخل قائمة المتغيرات.`);
    }
    seenCodes.add(codeKey);

    if (barcode) {
      if (seenBarcodes.has(barcode)) {
        throw new Error(`الباركود (${barcode}) مكرر داخل قائمة المتغيرات.`);
      }
      seenBarcodes.add(barcode);
    }

    const purchase = Number(draft.purchasePrice || 0);
    const sell = Number(draft.sellPrice || 0);
    const stock = Number(draft.currentStock || 0);
    const minAlert = Number(draft.minStockAlert || 0);
    if (!Number.isFinite(purchase) || purchase < 0 || !Number.isFinite(sell) || sell < 0) {
      throw new Error(`أسعار الشراء والبيع غير صالحة للمتغير (${nameAr}).`);
    }
    if (!Number.isFinite(stock) || stock < 0 || !Number.isFinite(minAlert) || minAlert < 0) {
      throw new Error(`الكمية أو حد التنبيه غير صالح للمتغير (${nameAr}).`);
    }

    const batchNo = normalizeDisplayText(draft.batchNumber);
    const expiry = normalizeDisplayText(draft.expiryDate);

    if (params.activityId === 'pharmacy') {
      if (!batchNo) {
        throw new Error(`رقم التشغيلة إجباري لأصناف الصيدلية (${nameAr}).`);
      }
      if (!expiry) {
        throw new Error(`تاريخ انتهاء الصلاحية إجباري لأصناف الصيدلية (${nameAr}).`);
      }
      if (expiry < params.todayDate) {
        throw new Error(`محظور تسجيل دواء منتهي الصلاحية (${nameAr}: ${expiry}).`);
      }
    } else if (params.activityId === 'grocery' && (batchNo || expiry)) {
      if (!batchNo || !expiry) {
        throw new Error(`عند إدخال تشغيلة للمتغير (${nameAr}) يجب تحديد رقم التشغيلة وتاريخ الصلاحية معاً.`);
      }
      if (expiry < params.todayDate) {
        throw new Error(`محظور تسجيل تشغيلة منتهية الصلاحية (${nameAr}: ${expiry}).`);
      }
    }
  }

  return selected;
}

export function buildSkuProductPayload(params: {
  draft: VariantSkuDraft;
  activityId: CommercialActivityId;
  categorySnapshot: string;
  generateId: () => string;
  specializedDefaults?: ProductSpecializedFieldsInput;
}): Product {
  const productId = params.generateId();
  const purchasePrice = Number(params.draft.purchasePrice || 0);
  const sellPrice = Number(params.draft.sellPrice || 0);
  const currentStock = Math.max(0, Number(params.draft.currentStock || 0));
  const minStockAlert = Math.max(0, Number(params.draft.minStockAlert || 0));
  const allowBatch = params.activityId === 'pharmacy' || params.activityId === 'grocery';
  const batchNumber = allowBatch ? normalizeDisplayText(params.draft.batchNumber) : '';
  const expiryDate = allowBatch ? normalizeDisplayText(params.draft.expiryDate) : '';
  const batches: ProductBatch[] = [];
  if (batchNumber && expiryDate) {
    batches.push({
      id: params.generateId(),
      productId,
      batchNumber,
      expiryDate,
      quantity: currentStock,
      costPrice: purchasePrice,
    });
  }

  const scoped = sanitizeSpecializedFieldsForActivity(params.activityId, {
    ...params.specializedDefaults,
    trackExpiry:
      params.activityId === 'pharmacy'
        ? true
        : params.activityId === 'grocery'
        ? Boolean(params.specializedDefaults?.trackExpiry || batches.length > 0)
        : false,
  });

  return {
    id: productId,
    code: normalizeDisplayText(params.draft.code),
    activityId: params.activityId,
    barcode: normalizeDisplayText(params.draft.barcode) || undefined,
    nameAr: normalizeDisplayText(params.draft.nameAr),
    category: normalizeDisplayText(params.categorySnapshot),
    unit: normalizeDisplayText(params.draft.unit) || 'حبة',
    purchasePrice,
    sellPrice,
    currentStock: batches.length > 0 ? batches.reduce((s, b) => s + b.quantity, 0) : currentStock,
    minStockAlert,
    ...scoped,
    ...(batches.length > 0 ? { batches } : {}),
  };
}

export function formatVariantAttributesPairs(
  variantAttributes: Record<string, string>,
  optionSchema?: ProductFamilyOption[]
): Array<{ key: string; label: string; value: string }> {
  const entries = Object.entries(variantAttributes || {});
  if (entries.length === 0) return [];
  const schemaMap = new Map((optionSchema || []).map((opt) => [opt.key, opt]));
  const orderedKeys = optionSchema
    ? [
        ...optionSchema.map((opt) => opt.key).filter((k) => k in variantAttributes),
        ...entries.map(([k]) => k).filter((k) => !schemaMap.has(k)),
      ]
    : entries.map(([k]) => k);

  return orderedKeys.map((key) => ({
    key,
    label: schemaMap.get(key)?.labelAr || key,
    value: variantAttributes[key],
  }));
}

export function matchesCatalogEntrySearch(
  entry: ProductCatalogEntry,
  rawQuery: string
): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  const p = entry.product;
  if (
    p.nameAr.toLowerCase().includes(q) ||
    p.code.toLowerCase().includes(q) ||
    (p.barcode && p.barcode.toLowerCase().includes(q)) ||
    (p.oemNumber && p.oemNumber.toLowerCase().includes(q)) ||
    (p.scientificName && p.scientificName.toLowerCase().includes(q)) ||
    (p.dosageForm && p.dosageForm.toLowerCase().includes(q)) ||
    (p.manufacturer && p.manufacturer.toLowerCase().includes(q)) ||
    (p.compatibleModels && p.compatibleModels.toLowerCase().includes(q)) ||
    (p.equipmentType && p.equipmentType.toLowerCase().includes(q)) ||
    (p.serialNumber && p.serialNumber.toLowerCase().includes(q)) ||
    (p.category && p.category.toLowerCase().includes(q))
  ) {
    return true;
  }
  if (entry.family?.nameAr.toLowerCase().includes(q)) return true;
  if (entry.brand?.nameAr.toLowerCase().includes(q)) return true;
  return Object.values(entry.variantAttributes || {}).some((val) =>
    String(val).toLowerCase().includes(q)
  );
}

export function groupCatalogEntriesByFamily(
  entries: ProductCatalogEntry[],
  families: ProductFamily[],
  brands: Brand[]
): {
  familyGroups: FamilyCatalogGroup[];
  standaloneEntries: ProductCatalogEntry[];
} {
  const brandById = new Map(brands.map((b) => [b.id, b]));
  const entriesByFamilyId = new Map<string, ProductCatalogEntry[]>();
  const standaloneEntries: ProductCatalogEntry[] = [];

  for (const entry of entries) {
    const famId = entry.family?.id || entry.meta?.familyId;
    if (famId) {
      const list = entriesByFamilyId.get(famId) || [];
      list.push(entry);
      entriesByFamilyId.set(famId, list);
    } else {
      standaloneEntries.push(entry);
    }
  }

  const familyGroups: FamilyCatalogGroup[] = [];
  const seenFamilyIds = new Set<string>();

  for (const family of families) {
    const familyEntries = entriesByFamilyId.get(family.id) || [];
    if (familyEntries.length === 0 && family.isActive === false) continue;
    seenFamilyIds.add(family.id);
    const derivedTotalStock = familyEntries.reduce(
      (sum, item) => sum + (Number(item.product.currentStock) || 0),
      0
    );
    const activeSkuCount = familyEntries.filter((e) => e.product.isActive !== false).length;
    const archivedSkuCount = familyEntries.length - activeSkuCount;
    familyGroups.push({
      family,
      brand: family.brandId ? brandById.get(family.brandId) : familyEntries[0]?.brand,
      entries: familyEntries,
      derivedTotalStock,
      activeSkuCount,
      archivedSkuCount,
    });
  }

  for (const [familyId, familyEntries] of entriesByFamilyId.entries()) {
    if (seenFamilyIds.has(familyId)) continue;
    const family = familyEntries[0]?.family;
    if (!family) continue;
    const derivedTotalStock = familyEntries.reduce(
      (sum, item) => sum + (Number(item.product.currentStock) || 0),
      0
    );
    const activeSkuCount = familyEntries.filter((e) => e.product.isActive !== false).length;
    familyGroups.push({
      family,
      brand: family.brandId ? brandById.get(family.brandId) : familyEntries[0]?.brand,
      entries: familyEntries,
      derivedTotalStock,
      activeSkuCount,
      archivedSkuCount: familyEntries.length - activeSkuCount,
    });
  }

  return { familyGroups, standaloneEntries };
}
