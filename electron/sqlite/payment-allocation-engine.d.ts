import type {
  Invoice,
  Party,
  PartyType,
  PaymentVoucher,
  VoucherAllocationMode,
  VoucherManualAllocationInput,
} from '../../src/types/erp';

export const PARTY_CONTROL_ACCOUNTS: ReadonlySet<string>;
export const SPECIAL_ACCOUNTS: {
  CUSTOMERS_AR: string;
  SUPPLIER_ADVANCES: string;
  SUPPLIERS_AP: string;
  AMANAT_LIABILITY: string;
  CUSTOMER_ADVANCES: string;
};

export interface ComputedInvoiceAllocation {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate?: string;
  invoiceTotal: number;
  paidBefore: number;
  remainingBefore: number;
  allocatedAmount: number;
  remainingAfter: number;
}

export interface VoucherAccountingPlan {
  mode: VoucherAllocationMode | 'CUSTOMER_ADVANCE_REFUND' | 'SUPPLIER_ADVANCE_REFUND';
  primaryContraAccountCode: string;
  debitLines: Array<{ accountCode: string; amount: number }>;
  creditLines: Array<{ accountCode: string; amount: number }>;
  allocations: ComputedInvoiceAllocation[];
  previousFifoAllocations: ComputedInvoiceAllocation[];
  appliedToDebtAmount: number;
  advanceAmount: number;
  advanceDirection:
    | 'DEPOSIT_CUSTOMER'
    | 'DEPOSIT_SUPPLIER'
    | 'REFUND_CUSTOMER'
    | 'REFUND_SUPPLIER'
    | 'NONE';
  partyDebtDelta: number;
  partyAdvanceDelta: number;
  manualOverride: boolean;
  overrideReason?: string;
}

export function toCents(val: unknown): number;
export function fromCents(cents: number): number;
export function roundMoney2(val: unknown): number;
export function getInvoiceRemainingAmount(invoice: Pick<Invoice, 'total' | 'paidAmount' | 'status'>): number;
export function sortOpenInvoicesFIFO<T extends Pick<Invoice, 'id' | 'date' | 'dueDate' | 'invoiceNumber' | 'total' | 'paidAmount' | 'status'>>(invoices: T[]): T[];
export function computeFifoAllocations(
  openInvoices: Array<Pick<Invoice, 'id' | 'date' | 'dueDate' | 'invoiceNumber' | 'total' | 'paidAmount' | 'status'>>,
  paymentAmount: number
): {
  allocations: ComputedInvoiceAllocation[];
  totalAllocatedAmount: number;
  unallocatedAmount: number;
};
export function validateManualAllocations(params: {
  openInvoices: Array<Pick<Invoice, 'id' | 'date' | 'dueDate' | 'invoiceNumber' | 'total' | 'paidAmount' | 'status'>>;
  paymentAmount: number;
  requestedAllocations: VoucherManualAllocationInput[];
}): {
  allocations: ComputedInvoiceAllocation[];
  totalAllocatedAmount: number;
  unallocatedAmount: number;
};
export function resolveVoucherAccountingPlan(params: {
  voucherType: PaymentVoucher['type'];
  voucherMode?: VoucherAllocationMode;
  party?: Pick<Party, 'id' | 'type' | 'nameAr' | 'balance' | 'advanceBalance'> | null;
  requestedAccountCode?: string;
  amount: number;
  openInvoices?: Array<Pick<Invoice, 'id' | 'type' | 'date' | 'dueDate' | 'invoiceNumber' | 'total' | 'paidAmount' | 'status'>>;
  manualAllocations?: VoucherManualAllocationInput[];
  hasOverridePermission?: boolean;
  overrideReason?: string;
  hasSupplierAdvancePermission?: boolean;
  targetAccountIsLeaf?: boolean;
}): VoucherAccountingPlan;
export function numberToArabicWords(amount: number, currencyName?: string): string;
