import type {
  Brand,
  Product,
  ProductCatalogEntry,
  ProductFamily,
  ProductFamilyOption,
  ProductUnit,
} from '../types/erp';
import { formatLocalDate } from './localDate';
import { formatVariantAttributesPairs, matchesCatalogEntrySearch } from './productCatalogUi';

export type PosSkuUnavailableReason = 'ARCHIVED' | 'OUT_OF_STOCK' | 'EXPIRED';

export interface PosSkuSaleability {
  sellable: boolean;
  reason?: PosSkuUnavailableReason;
  message?: string;
}

export interface PosScanResolution {
  entry: ProductCatalogEntry;
  matchedBy: 'BARCODE' | 'CODE' | 'UNIT_BARCODE';
  matchedUnitName?: string;
  matchedUnit?: ProductUnit;
  saleability: PosSkuSaleability;
}

export interface PosFamilyCard {
  family: ProductFamily;
  brand?: Brand;
  entries: ProductCatalogEntry[];
  activeEntries: ProductCatalogEntry[];
  sellableEntries: ProductCatalogEntry[];
  derivedActiveStock: number;
  minSellPrice: number;
  maxSellPrice: number;
}

export interface PosCatalogView {
  isSearching: boolean;
  familyCards: PosFamilyCard[];
  standaloneEntries: ProductCatalogEntry[];
  directSearchEntries: ProductCatalogEntry[];
}

export function isProductBatchExpired(expiryDate?: string, todayDate?: string): boolean {
  if (!expiryDate || !expiryDate.trim()) return false;
  const today = todayDate || formatLocalDate();
  return expiryDate.trim() < today;
}

export function hasSellableBatch(product: Product, todayDate?: string): boolean {
  if (!Array.isArray(product.batches) || product.batches.length === 0) {
    return Number(product.currentStock || 0) > 0;
  }
  return product.batches.some(
    (batch) => Number(batch.quantity || 0) > 0 && !isProductBatchExpired(batch.expiryDate, todayDate)
  );
}

export function getSkuSaleabilityStatus(
  entryOrProduct: ProductCatalogEntry | Product,
  todayDate?: string
): PosSkuSaleability {
  const product = 'product' in entryOrProduct ? entryOrProduct.product : entryOrProduct;
  if (product.isActive === false) {
    return {
      sellable: false,
      reason: 'ARCHIVED',
      message: `الصنف (${product.nameAr}) مؤرشف ومعطل ولا يمكن بيعه.`,
    };
  }
  if (Number(product.currentStock || 0) <= 0) {
    return {
      sellable: false,
      reason: 'OUT_OF_STOCK',
      message: `الصنف (${product.nameAr}) رصيده نافد بالمستودع.`,
    };
  }
  if (Array.isArray(product.batches) && product.batches.length > 0 && !hasSellableBatch(product, todayDate)) {
    return {
      sellable: false,
      reason: 'EXPIRED',
      message: `جميع التشغيلات المتوفرة من (${product.nameAr}) منتهية الصلاحية ومحظور بيعها.`,
    };
  }
  return { sellable: true };
}

export function formatVariantSummary(
  variantAttributes?: Record<string, string>,
  optionSchema?: ProductFamilyOption[]
): string {
  if (!variantAttributes || Object.keys(variantAttributes).length === 0) {
    return '';
  }
  const pairs = formatVariantAttributesPairs(variantAttributes, optionSchema);
  return pairs.map((pair) => `${pair.label}: ${pair.value}`).join(' · ');
}

export function buildVariantInvoiceItemSnapshot(entry?: ProductCatalogEntry): {
  familyId?: string;
  familyNameSnapshot?: string;
  brandNameSnapshot?: string;
  variantAttributesSnapshot?: Record<string, string>;
  variantSummary?: string;
} {
  if (!entry) return {};
  const attrs = entry.variantAttributes || {};
  const hasAttrs = Object.keys(attrs).length > 0;
  const variantSummary = hasAttrs
    ? formatVariantSummary(attrs, entry.family?.optionSchema)
    : '';

  return {
    ...(entry.family?.id || entry.meta?.familyId
      ? { familyId: entry.family?.id || entry.meta?.familyId }
      : {}),
    ...(entry.family?.nameAr ? { familyNameSnapshot: entry.family.nameAr } : {}),
    ...(entry.brand?.nameAr ? { brandNameSnapshot: entry.brand.nameAr } : {}),
    ...(hasAttrs ? { variantAttributesSnapshot: { ...attrs } } : {}),
    ...(variantSummary ? { variantSummary } : {}),
  };
}

export function matchesPosCatalogSearch(
  entry: ProductCatalogEntry,
  rawQuery: string
): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  if (matchesCatalogEntrySearch(entry, q)) return true;

  return (entry.units || []).some((unit) => {
    if (unit.isActive === false) return false;
    return (
      unit.code.toLowerCase().includes(q) ||
      unit.nameAr.toLowerCase().includes(q) ||
      Boolean(unit.barcode && unit.barcode.toLowerCase().includes(q)) ||
      Boolean(unit.normalizedBarcode && unit.normalizedBarcode.toLowerCase().includes(q))
    );
  });
}

function pickPreferredCatalogEntry(candidates: ProductCatalogEntry[]): ProductCatalogEntry | undefined {
  if (candidates.length === 0) return undefined;
  return candidates.find((entry) => entry.product.isActive !== false) || candidates[0];
}

export function resolvePosScanTarget(
  entries: ProductCatalogEntry[],
  rawInput: string,
  todayDate?: string
): PosScanResolution | null {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;
  const q = trimmed.toLowerCase();

  const barcodeMatches = entries.filter(
    (entry) => entry.product.barcode && entry.product.barcode.trim().toLowerCase() === q
  );
  const barcodeHit = pickPreferredCatalogEntry(barcodeMatches);
  if (barcodeHit) {
    return {
      entry: barcodeHit,
      matchedBy: 'BARCODE',
      saleability: getSkuSaleabilityStatus(barcodeHit, todayDate),
    };
  }

  const codeMatches = entries.filter(
    (entry) => entry.product.code.trim().toLowerCase() === q
  );
  const codeHit = pickPreferredCatalogEntry(codeMatches);
  if (codeHit) {
    return {
      entry: codeHit,
      matchedBy: 'CODE',
      saleability: getSkuSaleabilityStatus(codeHit, todayDate),
    };
  }

  const unitMatches: Array<{ entry: ProductCatalogEntry; unit: ProductUnit }> = [];
  for (const entry of entries) {
    const matchedUnit = (entry.units || []).find((unit) => {
      if (unit.isActive === false) return false;
      const ub = (unit.normalizedBarcode || unit.barcode || '').trim().toLowerCase();
      return Boolean(ub && ub === q);
    });
    if (matchedUnit) {
      unitMatches.push({ entry, unit: matchedUnit });
    }
  }
  const preferredUnitHit =
    unitMatches.find((m) => m.entry.product.isActive !== false) || unitMatches[0];
  if (preferredUnitHit) {
    return {
      entry: preferredUnitHit.entry,
      matchedBy: 'UNIT_BARCODE',
      matchedUnitName: preferredUnitHit.unit.nameAr,
      matchedUnit: preferredUnitHit.unit,
      saleability: getSkuSaleabilityStatus(preferredUnitHit.entry, todayDate),
    };
  }

  return null;
}

export function buildPosCatalogView(params: {
  entries: ProductCatalogEntry[];
  families: ProductFamily[];
  brands: Brand[];
  searchQuery: string;
  todayDate?: string;
}): PosCatalogView {
  const { entries, families, brands, searchQuery, todayDate } = params;
  const brandById = new Map(brands.map((b) => [b.id, b]));
  const familyById = new Map(families.map((f) => [f.id, f]));
  const trimmedQuery = searchQuery.trim();
  const isSearching = trimmedQuery.length > 0;

  if (isSearching) {
    const directSearchEntries = entries.filter(
      (entry) => entry.product.isActive !== false && matchesPosCatalogSearch(entry, trimmedQuery)
    );
    return {
      isSearching: true,
      familyCards: [],
      standaloneEntries: [],
      directSearchEntries,
    };
  }

  const entriesByFamilyId = new Map<string, ProductCatalogEntry[]>();
  const standaloneEntries: ProductCatalogEntry[] = [];

  for (const entry of entries) {
    const famId = entry.family?.id || entry.meta?.familyId;
    if (famId) {
      const list = entriesByFamilyId.get(famId) || [];
      list.push(entry);
      entriesByFamilyId.set(famId, list);
    } else if (entry.product.isActive !== false) {
      standaloneEntries.push(entry);
    }
  }

  const familyCards: PosFamilyCard[] = [];
  for (const [famId, familyEntries] of entriesByFamilyId.entries()) {
    const family = familyById.get(famId) || familyEntries[0]?.family;
    if (!family || family.isActive === false) continue;

    const activeEntries = familyEntries.filter((e) => e.product.isActive !== false);
    if (activeEntries.length === 0) continue;

    const sellableEntries = activeEntries.filter(
      (e) => getSkuSaleabilityStatus(e, todayDate).sellable
    );
    const derivedActiveStock = activeEntries.reduce(
      (sum, e) => sum + (Number(e.product.currentStock) || 0),
      0
    );
    const prices = activeEntries.map((e) => Number(e.product.sellPrice) || 0);
    const minSellPrice = Math.min(...prices);
    const maxSellPrice = Math.max(...prices);
    const brand = family.brandId
      ? brandById.get(family.brandId)
      : activeEntries[0]?.brand;

    familyCards.push({
      family,
      brand,
      entries: familyEntries,
      activeEntries,
      sellableEntries,
      derivedActiveStock,
      minSellPrice,
      maxSellPrice,
    });
  }

  familyCards.sort((a, b) => a.family.nameAr.localeCompare(b.family.nameAr, 'ar'));

  return {
    isSearching: false,
    familyCards,
    standaloneEntries,
    directSearchEntries: [],
  };
}
