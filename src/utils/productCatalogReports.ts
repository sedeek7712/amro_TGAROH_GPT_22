import { roundMoney } from '../config/currency';
import { getProductCostValue } from './inventoryValuation';
import type {
  Brand,
  Product,
  ProductCatalogEntry,
  ProductFamily,
  ProductUnit,
} from '../types/erp';

export type StockValuationAggregationLevel = 'SKU' | 'FAMILY';

export interface StockValuationVariantPair {
  key: string;
  label: string;
  value: string;
}

export interface StockValuationSkuRow {
  entry: ProductCatalogEntry;
  product: Product;
  family?: ProductFamily;
  brand?: Brand;
  units: ProductUnit[];
  variantAttributes: Record<string, string>;
  variantPairs: StockValuationVariantPair[];
  variantLabel: string;
  qty: number;
  unitCost: number;
  costValue: number;
  retailValue: number;
  potentialProfit: number;
}

export interface StockValuationFamilyGroup {
  family: ProductFamily;
  brand?: Brand;
  skuRows: StockValuationSkuRow[];
  skuCount: number;
  activeSkuCount: number;
  archivedSkuCount: number;
  totalQty: number;
  totalCost: number;
  totalRetail: number;
  potentialProfit: number;
  derivedFromSkus: true;
}

export interface StockValuationSummary {
  totalSkuCount: number;
  activeSkuCount: number;
  archivedSkuCount: number;
  familyGroupCount: number;
  standaloneSkuCount: number;
  totalQty: number;
  totalCost: number;
  totalRetail: number;
  potentialProfit: number;
}

export interface StockValuationReport {
  aggregationNote: string;
  skuRows: StockValuationSkuRow[];
  familyGroups: StockValuationFamilyGroup[];
  standaloneRows: StockValuationSkuRow[];
  summary: StockValuationSummary;
}

export function getStockValuationLevelLabel(level: StockValuationAggregationLevel): string {
  return level === 'FAMILY'
    ? 'تجميع حسب المجموعة (مشتق من SKU التابعة دون احتساب مزدوج)'
    : 'SKU فردي (كل متغير/صنف على حدة)';
}

function buildVariantPairs(
  attributes: Record<string, string>,
  family?: ProductFamily
): StockValuationVariantPair[] {
  const keys = Object.keys(attributes || {}).filter((k) => String(attributes[k] || '').trim());
  if (keys.length === 0) return [];
  const labelByKey = new Map<string, string>();
  for (const opt of family?.optionSchema || []) {
    if (opt?.key) {
      labelByKey.set(opt.key, opt.labelAr || opt.key);
    }
  }
  return keys.map((key) => ({
    key,
    label: labelByKey.get(key) || key,
    value: String(attributes[key]).trim(),
  }));
}

function matchesSearchQuery(row: StockValuationSkuRow, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  const p = row.product;
  const haystacks: Array<string | undefined> = [
    p.nameAr,
    p.code,
    p.barcode,
    p.oemNumber,
    p.scientificName,
    p.dosageForm,
    p.manufacturer,
    p.compatibleModels,
    p.equipmentType,
    p.serialNumber,
    p.category,
    row.family?.nameAr,
    row.brand?.nameAr,
    row.variantLabel,
    ...row.units.flatMap((u) => [u.nameAr, u.code, u.barcode]),
  ];
  return haystacks.some((val) => Boolean(val && String(val).toLowerCase().includes(q)));
}

export function buildStockValuationReport(params: {
  entries?: ProductCatalogEntry[];
  products?: Product[];
  families?: ProductFamily[];
  brands?: Brand[];
  activityFilter?: string;
  searchQuery?: string;
  includeArchived?: boolean;
}): StockValuationReport {
  const {
    entries = [],
    products = [],
    families = [],
    brands = [],
    activityFilter = 'ALL',
    searchQuery = '',
    includeArchived = true,
  } = params;

  const productById = new Map<string, Product>();
  for (const prod of products) {
    if (prod?.id) productById.set(prod.id, prod);
  }
  const familyById = new Map<string, ProductFamily>();
  for (const fam of families) {
    if (fam?.id) familyById.set(fam.id, fam);
  }
  const brandById = new Map<string, Brand>();
  for (const br of brands) {
    if (br?.id) brandById.set(br.id, br);
  }

  // Deduplicate by product.id so parent/child rows can never be counted twice.
  const entryByProductId = new Map<string, ProductCatalogEntry>();
  for (const entry of entries) {
    const p = entry?.product;
    if (!p?.id) continue;
    const productFromList = productById.get(p.id);
    const mergedProduct: Product = {
      ...(productFromList || p),
      ...p,
      batches:
        Array.isArray(p.batches) && p.batches.length > 0
          ? p.batches
          : productFromList?.batches || [],
    };
    const resolvedFamily =
      entry.family || (entry.meta?.familyId ? familyById.get(entry.meta.familyId) : undefined);
    const resolvedBrandId = entry.meta?.brandId || resolvedFamily?.brandId;
    const resolvedBrand =
      entry.brand || (resolvedBrandId ? brandById.get(resolvedBrandId) : undefined);
    entryByProductId.set(p.id, {
      product: mergedProduct,
      ...(entry.meta ? { meta: entry.meta } : {}),
      ...(resolvedFamily ? { family: resolvedFamily } : {}),
      ...(resolvedBrand ? { brand: resolvedBrand } : {}),
      variantAttributes: entry.variantAttributes || entry.meta?.variantAttributes || {},
      units: Array.isArray(entry.units) ? entry.units : [],
    });
  }

  for (const prod of products) {
    if (!prod?.id || entryByProductId.has(prod.id)) continue;
    entryByProductId.set(prod.id, {
      product: prod,
      variantAttributes: {},
      units: [],
    });
  }

  const allSkuRows: StockValuationSkuRow[] = [];
  for (const entry of entryByProductId.values()) {
    const product = entry.product;
    if (!includeArchived && product.isActive === false) continue;
    if (activityFilter !== 'ALL' && product.activityId !== activityFilter) continue;

    const variantAttributes = entry.variantAttributes || {};
    const variantPairs = buildVariantPairs(variantAttributes, entry.family);
    const variantLabel = variantPairs.map((pair) => `${pair.label}: ${pair.value}`).join(' • ');
    const qty = Number(product.currentStock || 0);
    const costValue = roundMoney(getProductCostValue(product));
    const retailValue = roundMoney(qty * Number(product.sellPrice || 0));
    const potentialProfit = roundMoney(retailValue - costValue);
    const unitCost = qty > 0 ? roundMoney(costValue / qty) : roundMoney(Number(product.purchasePrice || 0));

    const row: StockValuationSkuRow = {
      entry,
      product,
      family: entry.family,
      brand: entry.brand,
      units: entry.units || [],
      variantAttributes,
      variantPairs,
      variantLabel,
      qty,
      unitCost,
      costValue,
      retailValue,
      potentialProfit,
    };
    if (matchesSearchQuery(row, searchQuery)) {
      allSkuRows.push(row);
    }
  }

  allSkuRows.sort((a, b) => a.product.nameAr.localeCompare(b.product.nameAr, 'ar'));

  const groupMap = new Map<string, StockValuationFamilyGroup>();
  const standaloneRows: StockValuationSkuRow[] = [];

  for (const row of allSkuRows) {
    if (row.family) {
      const existingGroup = groupMap.get(row.family.id);
      if (existingGroup) {
        existingGroup.skuRows.push(row);
        existingGroup.skuCount += 1;
        if (row.product.isActive === false) {
          existingGroup.archivedSkuCount += 1;
        } else {
          existingGroup.activeSkuCount += 1;
        }
        existingGroup.totalQty += row.qty;
        existingGroup.totalCost = roundMoney(existingGroup.totalCost + row.costValue);
        existingGroup.totalRetail = roundMoney(existingGroup.totalRetail + row.retailValue);
        existingGroup.potentialProfit = roundMoney(
          existingGroup.totalRetail - existingGroup.totalCost
        );
      } else {
        const brand = row.brand || (row.family.brandId ? brandById.get(row.family.brandId) : undefined);
        groupMap.set(row.family.id, {
          family: row.family,
          brand,
          skuRows: [row],
          skuCount: 1,
          activeSkuCount: row.product.isActive === false ? 0 : 1,
          archivedSkuCount: row.product.isActive === false ? 1 : 0,
          totalQty: row.qty,
          totalCost: row.costValue,
          totalRetail: row.retailValue,
          potentialProfit: row.potentialProfit,
          derivedFromSkus: true,
        });
      }
    } else {
      standaloneRows.push(row);
    }
  }

  const familyGroups = Array.from(groupMap.values()).sort((a, b) =>
    a.family.nameAr.localeCompare(b.family.nameAr, 'ar')
  );

  // Summary totals strictly sum unique SKU rows once — never family groups + SKUs.
  const totalCost = roundMoney(allSkuRows.reduce((sum, r) => sum + r.costValue, 0));
  const totalRetail = roundMoney(allSkuRows.reduce((sum, r) => sum + r.retailValue, 0));
  const totalQty = allSkuRows.reduce((sum, r) => sum + r.qty, 0);
  const activeSkuCount = allSkuRows.filter((r) => r.product.isActive !== false).length;
  const archivedSkuCount = allSkuRows.length - activeSkuCount;

  return {
    aggregationNote:
      'الإجماليات المحاسبية والمخزنية محسوبة من وحدات SKU الفعلية مرة واحدة فقط؛ المجموعات هي تجميع اشتقاقي للعرض.',
    skuRows: allSkuRows,
    familyGroups,
    standaloneRows,
    summary: {
      totalSkuCount: allSkuRows.length,
      activeSkuCount,
      archivedSkuCount,
      familyGroupCount: familyGroups.length,
      standaloneSkuCount: standaloneRows.length,
      totalQty,
      totalCost,
      totalRetail,
      potentialProfit: roundMoney(totalRetail - totalCost),
    },
  };
}
