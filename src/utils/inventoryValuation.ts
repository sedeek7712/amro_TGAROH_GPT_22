import { CommercialActivityId, Product } from '../types/erp';
import { roundMoney } from '../config/currency';

/**
 * حساب قيمة تكلفة الصنف باستخدام تكلفة التشغيلات الفعلية عند توفرها
 * لضمان تطابق تقارير المخزون ولوحة التحكم مع خدمة تقييم المخزون (INV-02).
 */
export function getProductCostValue(
  product: Pick<Product, 'currentStock' | 'purchasePrice' | 'batches'>
): number {
  if (Array.isArray(product.batches) && product.batches.length > 0) {
    const batchSum = product.batches.reduce(
      (sum, b) => sum + (Number(b.quantity) || 0) * (Number(b.costPrice) || 0),
      0
    );
    return roundMoney(batchSum);
  }
  return roundMoney((Number(product.currentStock) || 0) * (Number(product.purchasePrice) || 0));
}

export function getProductRetailValue(
  product: Pick<Product, 'currentStock' | 'sellPrice'>
): number {
  return roundMoney((Number(product.currentStock) || 0) * (Number(product.sellPrice) || 0));
}

export function computeInventoryValuation(
  products: Product[],
  activityId?: CommercialActivityId
): {
  totalValue: number;
  totalItemsCount: number;
  totalQuantity: number;
  totalCostValue: number;
  totalRetailValue: number;
  activityBreakdown: Record<CommercialActivityId, { count: number; itemsCount: number; value: number }>;
} {
  let totalCostValue = 0;
  let totalRetailValue = 0;
  let totalQuantity = 0;
  let totalItemsCount = 0;

  const activityBreakdown: Record<
    CommercialActivityId,
    { count: number; itemsCount: number; value: number }
  > = {
    pharmacy: { count: 0, itemsCount: 0, value: 0 },
    grocery: { count: 0, itemsCount: 0, value: 0 },
    bike_parts: { count: 0, itemsCount: 0, value: 0 },
    equipment_parts: { count: 0, itemsCount: 0, value: 0 },
  };

  for (const p of products) {
    if (activityId && p.activityId !== activityId) continue;

    const itemCost = getProductCostValue(p);
    const itemRetail = getProductRetailValue(p);
    const qty = Number(p.currentStock) || 0;

    totalCostValue = roundMoney(totalCostValue + itemCost);
    totalRetailValue = roundMoney(totalRetailValue + itemRetail);
    totalQuantity += qty;
    totalItemsCount += 1;

    if (activityBreakdown[p.activityId]) {
      activityBreakdown[p.activityId].count += 1;
      activityBreakdown[p.activityId].itemsCount += qty;
      activityBreakdown[p.activityId].value = roundMoney(
        activityBreakdown[p.activityId].value + itemCost
      );
    }
  }

  return {
    totalValue: totalCostValue,
    totalItemsCount,
    totalQuantity,
    totalCostValue,
    totalRetailValue,
    activityBreakdown,
  };
}
