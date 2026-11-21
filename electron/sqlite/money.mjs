export const MONEY_SCALE = 100n;
export const QTY_SCALE = 10000n;
export const TOTALS_SCALE = 1000000n;

function decimalsForScale(scale) {
  let s = BigInt(scale);
  let decimals = 0;
  while (s > 1n) {
    if (s % 10n !== 0n) {
      throw new Error('Scale must be a power of 10');
    }
    s /= 10n;
    decimals += 1;
  }
  return decimals;
}

/**
 * Parse a finite number or numeric string into scaled BigInt using Half-Up rounding.
 */
export function parseScaledInt(value, scale = MONEY_SCALE, label = 'value') {
  const bigScale = BigInt(scale);
  const targetDecimals = decimalsForScale(bigScale);

  if (typeof value === 'bigint') {
    throw new Error(`قيمة غير صالحة (${label}): استخدم unitsToNumber للوحدات الصغرى (BigInt) بدل parseScaledInt.`);
  }

  let str;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`قيمة غير صالحة (${label}): لا يقبل اللانهاية أو NaN.`);
    }
    str = value.toFixed(targetDecimals + 4);
  } else if (typeof value === 'string') {
    str = value.trim();
    if (!str) {
      throw new Error(`قيمة فارغة غير صالحة (${label}).`);
    }
  } else if (value === null || value === undefined) {
    return 0n;
  } else {
    throw new Error(`نوع قيمة غير مدعوم (${label}).`);
  }

  // Handle scientific notation if string had e/E
  if (/[eE]/.test(str)) {
    const num = Number(str);
    if (!Number.isFinite(num)) {
      throw new Error(`قيمة غير صالحة (${label}).`);
    }
    str = num.toFixed(targetDecimals + 4);
  }

  const match = str.match(/^([+-])?(\d+)(?:\.(\d+))?$/);
  if (!match) {
    throw new Error(`تنسيق رقمي غير صالح (${label}): ${str}`);
  }

  const sign = match[1] === '-' ? -1n : 1n;
  const wholePart = BigInt(match[2]);
  const fracRaw = match[3] || '';

  const padded = fracRaw.padEnd(targetDecimals + 1, '0');
  const mainFrac = targetDecimals > 0 ? BigInt(padded.slice(0, targetDecimals)) : 0n;
  const nextDigit = Number(padded[targetDecimals] || '0');

  let scaledAbs = wholePart * bigScale + mainFrac;
  if (nextDigit >= 5) {
    scaledAbs += 1n;
  }
  const result = sign * scaledAbs;
  return result === -0n ? 0n : result;
}

export function formatScaledInt(units, scale = MONEY_SCALE, { trimTrailingZeros = false } = {}) {
  const bigScale = BigInt(scale);
  const decimals = decimalsForScale(bigScale);
  const value = BigInt(units);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / bigScale;
  if (decimals === 0) {
    return (negative && abs > 0n ? '-' : '') + whole.toString();
  }
  let frac = String(abs % bigScale).padStart(decimals, '0');
  if (trimTrailingZeros) {
    frac = frac.replace(/0+$/, '');
    if (!frac) {
      return (negative && abs > 0n ? '-' : '') + whole.toString();
    }
  }
  return (negative && abs > 0n ? '-' : '') + whole.toString() + '.' + frac;
}

export function unitsToNumber(units, scale = MONEY_SCALE) {
  return Number(formatScaledInt(units, scale));
}

export function toMoneyNumber(value) {
  return unitsToNumber(parseScaledInt(value, MONEY_SCALE, 'money'), MONEY_SCALE);
}

export function toQtyNumber(value) {
  return unitsToNumber(parseScaledInt(value, QTY_SCALE, 'quantity'), QTY_SCALE);
}

export function divBigIntHalfUp(numerator, denominator) {
  const num = BigInt(numerator);
  const den = BigInt(denominator);
  if (den === 0n) {
    throw new Error('لا يمكن القسمة على صفر.');
  }
  const negative = (num < 0n) !== (den < 0n);
  const absNum = num < 0n ? -num : num;
  const absDen = den < 0n ? -den : den;
  const q = absNum / absDen;
  const r = absNum % absDen;
  const rounded = r * 2n >= absDen ? q + 1n : q;
  return negative && rounded > 0n ? -rounded : rounded;
}

/**
 * Multiply two scaled values (e.g. qty in QTY_SCALE * price in MONEY_SCALE) -> output in outScale.
 */
export function mulScaledHalfUp(aUnits, bUnits, aScale, bScale, outScale = MONEY_SCALE) {
  const product = BigInt(aUnits) * BigInt(bUnits) * BigInt(outScale);
  const denom = BigInt(aScale) * BigInt(bScale);
  return divBigIntHalfUp(product, denom);
}

/**
 * Divide numeratorUnits (at numScale) by denominatorUnits (at denScale) -> output in outScale.
 */
export function divScaledHalfUp(numUnits, denUnits, numScale, denScale, outScale = MONEY_SCALE) {
  const numerator = BigInt(numUnits) * BigInt(denScale) * BigInt(outScale);
  const denominator = BigInt(denUnits) * BigInt(numScale);
  return divBigIntHalfUp(numerator, denominator);
}

export function sumScaled(values, scale = MONEY_SCALE, label = 'sumItem') {
  let total = 0n;
  for (const val of values) {
    total += parseScaledInt(val, scale, label);
  }
  return total;
}
