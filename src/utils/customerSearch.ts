import type { Party } from '../types/erp';

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export function normalizeCustomerSearchValue(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[٠-٩]/g, (digit) => String(ARABIC_DIGITS.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(PERSIAN_DIGITS.indexOf(digit)))
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/\u0640/g, '')
    .toLowerCase()
    .trim();
}

export function searchCustomers(customers: Party[], query: string): Party[] {
  const normalizedQuery = normalizeCustomerSearchValue(query);
  if (!normalizedQuery) return customers;

  const phoneQuery = normalizedQuery.replace(/[^0-9]/g, '');
  return customers.filter((customer) => {
    const normalizedName = normalizeCustomerSearchValue(customer.nameAr);
    const normalizedPhone = normalizeCustomerSearchValue(customer.phone).replace(/[^0-9]/g, '');
    return (
      normalizedName.includes(normalizedQuery) ||
      (phoneQuery.length > 0 && normalizedPhone.includes(phoneQuery))
    );
  });
}
