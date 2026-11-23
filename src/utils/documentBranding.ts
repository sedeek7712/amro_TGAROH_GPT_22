/**
 * حل بيانات الترويسة والهوية المؤسسية للمستندات والتقارير
 * يربط المطبوعات حصراً ببيانات CompanyProfile الفعلية دون أي شعارات مصطنعة
 */

import type { Branch, CommercialActivity, CompanyProfile, CurrencyConfig } from '../types/erp';
import { getActiveCurrencyConfig } from '../config/currency';

export interface ResolvedDocumentHeader {
  companyNameAr: string;
  companyNameEn?: string;
  logoUrl?: string;
  hasLogo: boolean;
  address?: string;
  phone?: string;
  email?: string;
  taxNumber?: string;
  website?: string;
  headerNote?: string;
  footerNote?: string;
  branchName: string;
  branchAddress?: string;
  branchPhone?: string;
  activityName?: string;
  issuerName?: string;
  currency: CurrencyConfig;
}

export function resolveEnterpriseDocumentMeta(params: {
  profile?: CompanyProfile | null;
  branch?: Branch | null;
  branches?: Branch[];
  branchId?: string;
  activity?: CommercialActivity | null;
  activities?: CommercialActivity[];
  activityId?: string;
  issuerName?: string;
  currency?: CurrencyConfig;
}): ResolvedDocumentHeader {
  const profile = params.profile || undefined;
  const resolvedBranch =
    params.branch ||
    (params.branchId && params.branches
      ? params.branches.find((b) => b.id === params.branchId)
      : undefined) ||
    params.branches?.[0];

  const resolvedActivity =
    params.activity ||
    (params.activityId && params.activities
      ? params.activities.find((a) => a.id === params.activityId)
      : undefined);

  const logoTrimmed = typeof profile?.logo === 'string' ? profile.logo.trim() : '';
  const hasLogo = Boolean(logoTrimmed);

  const fallbackCurrency = getActiveCurrencyConfig();
  const currency: CurrencyConfig = params.currency || {
    code: profile?.currencyCode || fallbackCurrency.code,
    nameAr: profile?.currency || fallbackCurrency.nameAr,
    symbol: profile?.currencySymbol || fallbackCurrency.symbol,
    decimalPlaces:
      typeof profile?.currencyDecimalPlaces === 'number'
        ? profile.currencyDecimalPlaces
        : fallbackCurrency.decimalPlaces,
    roundingMode: 'HALF_UP',
  };

  return {
    companyNameAr: profile?.nameAr?.trim() || 'المؤسسة التجارية',
    companyNameEn: profile?.nameEn?.trim() || undefined,
    logoUrl: hasLogo ? logoTrimmed : undefined,
    hasLogo,
    address: profile?.address?.trim() || undefined,
    phone: profile?.phone?.trim() || undefined,
    email: profile?.email?.trim() || undefined,
    taxNumber: profile?.taxNumber?.trim() || undefined,
    website: profile?.website?.trim() || undefined,
    headerNote: profile?.headerNote?.trim() || undefined,
    footerNote: profile?.footerNote?.trim() || undefined,
    branchName: resolvedBranch?.nameAr?.trim() || 'الفرع الرئيسي',
    branchAddress: resolvedBranch?.address?.trim() || undefined,
    branchPhone: resolvedBranch?.phone?.trim() || undefined,
    activityName: resolvedActivity?.nameAr?.trim() || undefined,
    issuerName: params.issuerName?.trim() || undefined,
    currency,
  };
}
