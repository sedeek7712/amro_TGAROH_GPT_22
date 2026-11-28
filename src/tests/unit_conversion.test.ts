import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePurchaseBaseUnitCost,
  computeSuggestedUnitPrice,
  formatUnitConversionSummary,
  resolveUnitConversionToBase,
} from '../../electron/sqlite/unit-conversion.mjs';

test('resolveUnitConversionToBase computes exact base quantities for whole and fractional units', () => {
  const carton = resolveUnitConversionToBase({
    quantity: 2,
    numerator: 24,
    denominator: 1,
    unitName: 'كرتون',
  });
  assert.equal(carton.enteredQuantity, 2);
  assert.equal(carton.baseQuantity, 48);

  const halfCarton = resolveUnitConversionToBase({
    quantity: 0.5,
    numerator: 24,
    denominator: 1,
    unitName: 'كرتون',
  });
  assert.equal(halfCarton.baseQuantity, 12);

  const quarterPack = resolveUnitConversionToBase({
    quantity: 3,
    numerator: 1,
    denominator: 4,
    unitName: 'ربع لتر',
  });
  assert.equal(quarterPack.baseQuantity, 0.75);

  const exactThirds = resolveUnitConversionToBase({
    quantity: 3,
    numerator: 1,
    denominator: 3,
    unitName: 'ثلث',
  });
  assert.equal(exactThirds.baseQuantity, 1);
});

test('resolveUnitConversionToBase rejects unsafe non-representable ratios and non-positive inputs', () => {
  assert.throws(
    () =>
      resolveUnitConversionToBase({
        quantity: 1,
        numerator: 1,
        denominator: 3,
        unitName: 'ثلث غير قابل للتمثيل',
      }),
    /بدقة مخزنية آمنة/
  );

  assert.throws(
    () =>
      resolveUnitConversionToBase({
        quantity: 0,
        numerator: 24,
        denominator: 1,
        unitName: 'كرتون',
      }),
    /أكبر من الصفر/
  );

  assert.throws(
    () =>
      resolveUnitConversionToBase({
        quantity: 1,
        numerator: 0,
        denominator: 1,
        unitName: 'كرتون',
      }),
    /عددين صحيحين موجبين/
  );
});

test('computeSuggestedUnitPrice scales base sell/purchase price accurately with HALF_UP', () => {
  assert.equal(
    computeSuggestedUnitPrice({ basePrice: 2.5, numerator: 24, denominator: 1, decimalPlaces: 2 }),
    60
  );
  assert.equal(
    computeSuggestedUnitPrice({ basePrice: 10.5, numerator: 1, denominator: 4, decimalPlaces: 2 }),
    2.63
  );
  assert.equal(
    computeSuggestedUnitPrice({ basePrice: 12.5, numerator: 1, denominator: 1, decimalPlaces: 2 }),
    12.5
  );
});

test('computePurchaseBaseUnitCost computes exact landed cost per base unit across tax/discount', () => {
  const simple = computePurchaseBaseUnitCost({
    enteredQuantity: 2,
    enteredCostPrice: 240,
    baseQuantity: 48,
    invoiceSubtotal: 480,
    invoiceTotal: 480,
  });
  assert.equal(simple.baseUnitCost, 10);

  const discounted = computePurchaseBaseUnitCost({
    enteredQuantity: 2,
    enteredCostPrice: 240,
    baseQuantity: 48,
    invoiceSubtotal: 480,
    invoiceTotal: 432,
  });
  assert.equal(discounted.baseUnitCost, 9);

  const fractional = computePurchaseBaseUnitCost({
    enteredQuantity: 1,
    enteredCostPrice: 100,
    baseQuantity: 24,
    invoiceSubtotal: 100,
    invoiceTotal: 100,
  });
  assert.equal(fractional.baseUnitCost, 4.1667);
});

test('formatUnitConversionSummary renders note for alternate units and null for base/legacy rows', () => {
  assert.equal(
    formatUnitConversionSummary({
      unitId: 'BASE',
      unit: 'حبة',
      baseQuantity: 5,
    }),
    null
  );
  assert.equal(
    formatUnitConversionSummary({
      unitId: 'u_carton',
      unitNameSnapshot: 'كرتون',
      baseUnitNameSnapshot: 'حبة',
      conversionNumeratorSnapshot: 24,
      conversionDenominatorSnapshot: 1,
      baseQuantity: 48,
    }),
    '1 كرتون = 24 حبة · الأساس: 48 حبة'
  );
});
