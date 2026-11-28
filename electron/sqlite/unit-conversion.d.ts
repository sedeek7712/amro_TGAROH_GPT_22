import type { InvoiceItem } from '../../src/types/erp';

export interface UnitConversionResolution {
  enteredQtyUnits: bigint;
  enteredQuantity: number;
  baseQtyUnits: bigint;
  baseQuantity: number;
  numerator: number;
  denominator: number;
}

export function normalizePositiveRatio(
  numerator: number,
  denominator: number
): { numerator: number; denominator: number };

export function resolveUnitConversionToBase(params: {
  quantity: number;
  numerator?: number;
  denominator?: number;
  unitName?: string;
}): UnitConversionResolution;

export function computeSuggestedUnitPrice(params: {
  basePrice: number;
  numerator?: number;
  denominator?: number;
  decimalPlaces?: number;
}): number;

export function computePurchaseBaseUnitCost(params: {
  enteredQuantity: number;
  enteredCostPrice: number;
  baseQuantity: number;
  invoiceSubtotal?: number;
  invoiceTotal?: number;
}): {
  baseUnitCostUnits: bigint;
  baseUnitCost: number;
};

export function formatRatioExpression(numerator: number, denominator: number): string;

export function formatUnitConversionSummary(
  item?: Partial<
    Pick<
      InvoiceItem,
      | 'unitId'
      | 'unit'
      | 'unitNameSnapshot'
      | 'baseUnitNameSnapshot'
      | 'conversionNumeratorSnapshot'
      | 'conversionDenominatorSnapshot'
      | 'baseQuantity'
    >
  > | null
): string | null;
