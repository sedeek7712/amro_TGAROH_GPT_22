import {
  MONEY_SCALE,
  QTY_SCALE,
  divBigIntHalfUp,
  parseScaledInt,
  unitsToNumber,
} from './money.mjs';

/**
 * Pure unit-conversion engine shared between SQLite backend and Dexie/UI layers.
 * Enforces exact BigInt arithmetic at QTY_SCALE (4 decimal places) with zero silent rounding drift.
 */

export function normalizePositiveRatio(numerator, denominator) {
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    throw new Error('معامل التحويل يجب أن يتكون من عددين صحيحين موجبين.');
  }
  return { numerator, denominator };
}

export function resolveUnitConversionToBase({
  quantity,
  numerator = 1,
  denominator = 1,
  unitName = 'الوحدة',
}) {
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(`الكمية المدخلة للوحدة (${unitName}) يجب أن تكون رقماً موجباً أكبر من الصفر.`);
  }
  normalizePositiveRatio(numerator, denominator);

  const enteredQtyUnits = parseScaledInt(quantity, QTY_SCALE, 'enteredQuantity');
  if (enteredQtyUnits <= 0n) {
    throw new Error(`الكمية المدخلة للوحدة (${unitName}) يجب أن تكون أكبر من الصفر.`);
  }

  const numBig = BigInt(numerator);
  const denBig = BigInt(denominator);
  const product = enteredQtyUnits * numBig;

  if (product % denBig !== 0n) {
    throw new Error(
      `تعذر تحويل الكمية (${quantity}) للوحدة (${unitName}) بمعامل (${numerator}/${denominator}) بدقة مخزنية آمنة (4 منازل عشرية).`
    );
  }

  const baseQtyUnits = product / denBig;
  if (baseQtyUnits <= 0n) {
    throw new Error(
      `الكمية الأساسية الناتجة عن تحويل (${quantity}) للوحدة (${unitName}) تساوي صفراً ولا يمكن اعتمادها.`
    );
  }

  return {
    enteredQtyUnits,
    enteredQuantity: unitsToNumber(enteredQtyUnits, QTY_SCALE),
    baseQtyUnits,
    baseQuantity: unitsToNumber(baseQtyUnits, QTY_SCALE),
    numerator,
    denominator,
  };
}

export function computeSuggestedUnitPrice({
  basePrice,
  numerator = 1,
  denominator = 1,
  decimalPlaces = 2,
}) {
  if (typeof basePrice !== 'number' || !Number.isFinite(basePrice) || basePrice < 0) {
    return 0;
  }
  normalizePositiveRatio(numerator, denominator);
  const clampedDecimals = Math.min(4, Math.max(0, Number.isInteger(decimalPlaces) ? decimalPlaces : 2));
  const outScale = 10n ** BigInt(clampedDecimals);
  const basePriceUnits = parseScaledInt(basePrice, QTY_SCALE, 'basePrice');
  const scaled = divBigIntHalfUp(
    basePriceUnits * BigInt(numerator) * outScale,
    BigInt(denominator) * QTY_SCALE
  );
  return unitsToNumber(scaled, outScale);
}

export function computePurchaseBaseUnitCost({
  enteredQuantity,
  enteredCostPrice,
  baseQuantity,
  invoiceSubtotal = 0,
  invoiceTotal = 0,
}) {
  const enteredQtyUnits = parseScaledInt(enteredQuantity, QTY_SCALE, 'purchase.enteredQuantity');
  const enteredCostUnits = parseScaledInt(enteredCostPrice, QTY_SCALE, 'purchase.enteredCostPrice');
  const baseQtyUnits = parseScaledInt(baseQuantity, QTY_SCALE, 'purchase.baseQuantity');
  if (enteredQtyUnits <= 0n || baseQtyUnits <= 0n) {
    throw new Error('كمية الشراء والكمية الأساسية يجب أن تكونا أكبر من الصفر.');
  }
  if (enteredCostUnits < 0n) {
    throw new Error('تكلفة الوحدة لا يجوز أن تكون سالبة.');
  }

  const subtotalUnits = parseScaledInt(invoiceSubtotal ?? 0, MONEY_SCALE, 'purchase.subtotal');
  const totalUnits = parseScaledInt(invoiceTotal ?? 0, MONEY_SCALE, 'purchase.total');

  const factorNum = subtotalUnits > 0n ? totalUnits : 1n;
  const factorDen = subtotalUnits > 0n ? subtotalUnits : 1n;

  const baseUnitCostUnits = divBigIntHalfUp(
    enteredQtyUnits * enteredCostUnits * factorNum,
    baseQtyUnits * factorDen
  );

  return {
    baseUnitCostUnits,
    baseUnitCost: unitsToNumber(baseUnitCostUnits, QTY_SCALE),
  };
}

export function formatRatioExpression(numerator, denominator) {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0) {
    return '';
  }
  return denominator === 1 ? String(numerator) : `${numerator}/${denominator}`;
}

export function formatUnitConversionSummary(item) {
  if (!item || !item.unitId || item.unitId === 'BASE') {
    return null;
  }
  const num = Number(item.conversionNumeratorSnapshot);
  const den = Number(item.conversionDenominatorSnapshot);
  const baseQty = Number(item.baseQuantity);
  const unitName = String(item.unitNameSnapshot || item.unit || '').trim();
  const baseUnitName = String(item.baseUnitNameSnapshot || '').trim();
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0 || !Number.isFinite(baseQty)) {
    return null;
  }
  if (num === 1 && den === 1) {
    return null;
  }
  const ratioText = formatRatioExpression(num, den);
  const baseLabel = baseUnitName ? ` ${baseUnitName}` : '';
  return `1 ${unitName} = ${ratioText}${baseLabel} · الأساس: ${baseQty}${baseLabel}`;
}
