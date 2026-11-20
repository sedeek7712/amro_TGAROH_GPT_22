/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * المصدر المركزي الموحد لإعدادات العملة والتقريب المالي (CFG-01)
 */

import { CurrencyConfig } from '../types/erp';

export const DEFAULT_CURRENCY_CONFIG: CurrencyConfig = {
  code: 'SAR',
  nameAr: 'ريال سعودي',
  symbol: 'ر.س',
  decimalPlaces: 2,
  roundingMode: 'HALF_UP',
};

export type SupportedCurrencyCode = 'SAR' | 'YER' | 'AED' | 'USD' | 'EGP';

export const CURRENCY_PRESETS: Record<SupportedCurrencyCode, CurrencyConfig> = {
  SAR: DEFAULT_CURRENCY_CONFIG,
  YER: {
    code: 'YER',
    nameAr: 'ريال يمني',
    symbol: 'ر.ي',
    decimalPlaces: 2,
    roundingMode: 'HALF_UP',
  },
  AED: {
    code: 'AED',
    nameAr: 'درهم إماراتي',
    symbol: 'د.إ',
    decimalPlaces: 2,
    roundingMode: 'HALF_UP',
  },
  USD: {
    code: 'USD',
    nameAr: 'دولار أمريكي',
    symbol: '$',
    decimalPlaces: 2,
    roundingMode: 'HALF_UP',
  },
  EGP: {
    code: 'EGP',
    nameAr: 'جنيه مصري',
    symbol: 'ج.م',
    decimalPlaces: 2,
    roundingMode: 'HALF_UP',
  },
};

const COMPANY_PROFILE_STORAGE_KEY = 'multi_activity_erp_company_profile';

/**
 * تقريب مالي موحد بنمط Half-Up يمنع تراكم فروقات الفاصلة العائمة
 */
export function roundMoney(
  value: number,
  decimalPlaces: number = DEFAULT_CURRENCY_CONFIG.decimalPlaces
): number {
  if (!Number.isFinite(value)) return 0;
  const factor = Math.pow(10, decimalPlaces);
  const sign = value < 0 ? -1 : 1;
  const rounded = (sign * Math.round(Math.abs(value) * factor + 1e-9)) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * قراءة إعدادات العملة المركزية المعتمدة من ملف الشركة
 */
export function getActiveCurrencyConfig(): CurrencyConfig {
  try {
    if (typeof localStorage === 'undefined') {
      return DEFAULT_CURRENCY_CONFIG;
    }
    const raw = localStorage.getItem(COMPANY_PROFILE_STORAGE_KEY);
    if (!raw) return DEFAULT_CURRENCY_CONFIG;
    const parsed = JSON.parse(raw) as Partial<{
      currencyCode: string;
      currency: string;
      currencySymbol: string;
      currencyDecimalPlaces: number;
    }>;

    const matchedPreset = Object.values(CURRENCY_PRESETS).find(
      (c) =>
        (parsed.currencyCode && c.code === parsed.currencyCode) ||
        (parsed.currency && c.nameAr === parsed.currency) ||
        (parsed.currencySymbol && c.symbol === parsed.currencySymbol)
    );

    return {
      code: parsed.currencyCode || matchedPreset?.code || DEFAULT_CURRENCY_CONFIG.code,
      nameAr: parsed.currency?.trim() || matchedPreset?.nameAr || DEFAULT_CURRENCY_CONFIG.nameAr,
      symbol: parsed.currencySymbol?.trim() || matchedPreset?.symbol || DEFAULT_CURRENCY_CONFIG.symbol,
      decimalPlaces:
        typeof parsed.currencyDecimalPlaces === 'number'
          ? parsed.currencyDecimalPlaces
          : (matchedPreset?.decimalPlaces ?? DEFAULT_CURRENCY_CONFIG.decimalPlaces),
      roundingMode: 'HALF_UP',
    };
  } catch {
    return DEFAULT_CURRENCY_CONFIG;
  }
}

/**
 * تحديث إعدادات العملة المعتمدة في ملف الشركة
 */
export function setActiveCurrencyConfig(
  config: Partial<CurrencyConfig> & { decimals?: number }
): CurrencyConfig {
  const current = getActiveCurrencyConfig();
  const nextDecimalPlaces =
    typeof config.decimalPlaces === 'number'
      ? config.decimalPlaces
      : typeof config.decimals === 'number'
        ? config.decimals
        : current.decimalPlaces;

  const updated: CurrencyConfig = {
    code: config.code?.trim() || current.code,
    nameAr: config.nameAr?.trim() || current.nameAr,
    symbol: config.symbol?.trim() || current.symbol,
    decimalPlaces: nextDecimalPlaces,
    roundingMode: 'HALF_UP',
  };

  if (typeof localStorage !== 'undefined') {
    let existingProfile: Record<string, unknown> = { nameAr: 'نظام الإدارة التجارية' };
    try {
      const raw = localStorage.getItem(COMPANY_PROFILE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          existingProfile = parsed as Record<string, unknown>;
        }
      }
    } catch {
      // ignore malformed profile
    }
    localStorage.setItem(
      COMPANY_PROFILE_STORAGE_KEY,
      JSON.stringify({
        ...existingProfile,
        currencyCode: updated.code,
        currency: updated.nameAr,
        currencySymbol: updated.symbol,
        currencyDecimalPlaces: updated.decimalPlaces,
      })
    );
  }

  return updated;
}

/**
 * تنسيق المبلغ بالعملة المعتمدة
 */
export function formatMoney(
  amount: number,
  config?: Partial<CurrencyConfig>,
  includeSymbol: boolean = true
): string {
  const active = { ...getActiveCurrencyConfig(), ...config };
  const normalized = roundMoney(Number(amount) || 0, active.decimalPlaces);
  const formatted = normalized.toFixed(active.decimalPlaces);
  return includeSymbol ? `${formatted} ${active.symbol}` : formatted;
}
