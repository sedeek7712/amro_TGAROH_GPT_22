import type {
  Invoice,
  Party,
  PartyAdvanceTransaction,
  PaymentAllocation,
  PaymentVoucher,
} from '../types/erp';

export interface PartyStatementRow {
  id: string;
  date: string;
  sortKey: string;
  type: string;
  docNumber: string;
  debit: number;
  credit: number;
  balanceAfter: number;
  memo: string;
  extraBadge?: string;
}

export interface PartyStatementSummary {
  party: Party;
  openingBalance: number;
  transactions: PartyStatementRow[];
  periodClosingBalance: number;
  finalBalance: number;
  advanceBalance: number;
  invoicesCount: number;
}

function roundMoney(value: number): number {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

export function buildPartyStatement(params: {
  party: Party;
  invoices: Invoice[];
  vouchers: PaymentVoucher[];
  paymentAllocations: PaymentAllocation[];
  partyAdvances: PartyAdvanceTransaction[];
  startDate?: string;
  endDate?: string;
}): PartyStatementSummary {
  const {
    party,
    invoices,
    vouchers,
    paymentAllocations,
    partyAdvances,
    startDate,
    endDate,
  } = params;

  const partyInvoices = invoices.filter(
    (inv) =>
      inv.partyId === party.id &&
      inv.status !== 'REVERSED' &&
      inv.status !== 'DRAFT' &&
      inv.status !== 'CANCELLED' &&
      inv.isPosted !== false
  );
  const partyVouchers = vouchers.filter(
    (v) =>
      v.partyId === party.id &&
      (v.status || 'POSTED') !== 'DRAFT' &&
      v.status !== 'CANCELLED'
  );
  const partyApplyAdvances = partyAdvances.filter(
    (tx) => tx.partyId === party.id && tx.type === 'APPLY_TO_INVOICE'
  );

  // FIN-02: Track active voucher allocations per invoice so inv.paidAmount on the invoice row
  // only reflects direct POS/checkout payments and NEVER double-counts subsequent voucher settlements.
  const activeVoucherAllocatedByInvoice = new Map<string, number>();
  for (const alloc of paymentAllocations) {
    if (
      alloc.status !== 'REVERSED' &&
      alloc.voucherId &&
      alloc.invoiceId
    ) {
      const prev = activeVoucherAllocatedByInvoice.get(alloc.invoiceId) || 0;
      activeVoucherAllocatedByInvoice.set(
        alloc.invoiceId,
        roundMoney(prev + Number(alloc.allocatedAmount || 0))
      );
    }
  }

  const rawRows: Array<{
    id: string;
    date: string;
    sortKey: string;
    type: string;
    docNumber: string;
    debit: number;
    credit: number;
    memo: string;
    extraBadge?: string;
  }> = [];

  for (const inv of partyInvoices) {
    const voucherAllocatedForInvoice = activeVoucherAllocatedByInvoice.get(inv.id) || 0;
    const directCashPaid = Math.max(
      0,
      roundMoney(
        Number(inv.paidAmount || 0) -
          Number(inv.advanceAppliedAmount || 0) -
          voucherAllocatedForInvoice
      )
    );

    if (party.type === 'CUSTOMER') {
      if (inv.type === 'RETURN_SALE') {
        const advCredited = Number(inv.advanceAppliedAmount || 0);
        rawRows.push({
          id: inv.id,
          date: inv.date,
          sortKey: `${inv.date}-1-${inv.invoiceNumber}`,
          type: 'مرتجع مبيعات',
          docNumber: inv.invoiceNumber,
          debit: roundMoney(Number(inv.paidAmount || 0) + advCredited),
          credit: roundMoney(inv.total),
          memo: `مرتجع مبيعات${inv.originalInvoiceNumber ? ` (فاتورة ${inv.originalInvoiceNumber})` : ''}`,
          extraBadge:
            advCredited > 0
              ? `تحويل للرصيد المقدم: ${advCredited.toFixed(2)}`
              : undefined,
        });
      } else {
        rawRows.push({
          id: inv.id,
          date: inv.date,
          sortKey: `${inv.date}-1-${inv.invoiceNumber}`,
          type: 'فاتورة مبيعات',
          docNumber: inv.invoiceNumber,
          debit: roundMoney(inv.total),
          credit: directCashPaid,
          memo: `فاتورة مبيعات (${inv.paymentMethod === 'CASH' ? 'نقدي' : inv.paymentMethod === 'BANK_TRANSFER' ? 'حوالة بنكية' : 'آجل'})`,
          extraBadge:
            (inv.advanceAppliedAmount || 0) > 0
              ? `خصم من الرصيد المقدم: ${Number(inv.advanceAppliedAmount).toFixed(2)}`
              : undefined,
        });
      }
    } else {
      if (inv.type === 'RETURN_PURCHASE') {
        const advCredited = Number(inv.advanceAppliedAmount || 0);
        rawRows.push({
          id: inv.id,
          date: inv.date,
          sortKey: `${inv.date}-1-${inv.invoiceNumber}`,
          type: 'مرتجع مشتريات',
          docNumber: inv.invoiceNumber,
          debit: roundMoney(inv.total),
          credit: roundMoney(Number(inv.paidAmount || 0) + advCredited),
          memo: `مرتجع مشتريات${inv.originalInvoiceNumber ? ` (فاتورة ${inv.originalInvoiceNumber})` : ''}`,
          extraBadge:
            advCredited > 0
              ? `إثبات سلفة مورد: ${advCredited.toFixed(2)}`
              : undefined,
        });
      } else {
        rawRows.push({
          id: inv.id,
          date: inv.date,
          sortKey: `${inv.date}-1-${inv.invoiceNumber}`,
          type: 'فاتورة مشتريات',
          docNumber: inv.invoiceNumber,
          debit: directCashPaid,
          credit: roundMoney(inv.total),
          memo: `فاتورة مشتريات (${inv.paymentMethod === 'CASH' ? 'نقدي' : inv.paymentMethod === 'BANK_TRANSFER' ? 'حوالة بنكية' : 'آجل'})`,
          extraBadge:
            (inv.advanceAppliedAmount || 0) > 0
              ? `خصم من سلفة المورد: ${Number(inv.advanceAppliedAmount).toFixed(2)}`
              : undefined,
        });
      }
    }
  }

  for (const v of partyVouchers) {
    const allocs = paymentAllocations.filter((a) => a.voucherId === v.id);
    const allocInfo =
      allocs.length > 0
        ? `تخصيص: ${allocs
            .map((a) => `${a.invoiceNumber || a.invoiceId} (${Number(a.allocatedAmount || 0).toFixed(2)})`)
            .join('، ')}`
        : undefined;
    const isReversed = v.status === 'REVERSED';
    const settledDebt = roundMoney(v.appliedToDebtAmount ?? v.amount);
    const badge = [
      allocInfo,
      (v.advanceAmount || 0) > 0
        ? party.type === 'CUSTOMER'
          ? `رصيد مقدم: ${Number(v.advanceAmount).toFixed(2)}`
          : `سلفة/مقدم: ${Number(v.advanceAmount).toFixed(2)}`
        : '',
    ]
      .filter(Boolean)
      .join(' | ');

    if (v.type === 'RECEIPT') {
      rawRows.push({
        id: v.id,
        date: v.date,
        sortKey: `${v.date}-2-${v.voucherNumber}`,
        type: isReversed ? 'سند قبض (معكوس)' : 'سند قبض',
        docNumber: v.voucherNumber,
        debit: 0,
        credit: settledDebt,
        memo: `سند قبض${isReversed ? ' (معكوس)' : ''}: ${v.description}`,
        extraBadge: badge || undefined,
      });
      if (isReversed) {
        rawRows.push({
          id: `${v.id}-rev`,
          date: v.date,
          sortKey: `${v.date}-3-${v.voucherNumber}-REV`,
          type: 'عكس سند قبض',
          docNumber: `${v.voucherNumber}-REV`,
          debit: settledDebt,
          credit: 0,
          memo: `عكس سند قبض ${v.voucherNumber}: ${v.reversalReason || 'عكس قيد وسند مالي'}`,
        });
      }
    } else {
      rawRows.push({
        id: v.id,
        date: v.date,
        sortKey: `${v.date}-2-${v.voucherNumber}`,
        type: isReversed ? 'سند صرف (معكوس)' : 'سند صرف',
        docNumber: v.voucherNumber,
        debit: settledDebt,
        credit: 0,
        memo: `سند صرف${isReversed ? ' (معكوس)' : ''}: ${v.description}`,
        extraBadge: badge || undefined,
      });
      if (isReversed) {
        rawRows.push({
          id: `${v.id}-rev`,
          date: v.date,
          sortKey: `${v.date}-3-${v.voucherNumber}-REV`,
          type: 'عكس سند صرف',
          docNumber: `${v.voucherNumber}-REV`,
          debit: 0,
          credit: settledDebt,
          memo: `عكس سند صرف ${v.voucherNumber}: ${v.reversalReason || 'عكس قيد وسند مالي'}`,
        });
      }
    }
  }

  for (const tx of partyApplyAdvances) {
    rawRows.push({
      id: tx.id,
      date: tx.date,
      sortKey: `${tx.date}-4-${tx.id}`,
      type: 'تسوية رصيد مقدم',
      docNumber: 'ADV-SET',
      debit: party.type === 'SUPPLIER' ? Math.abs(tx.amount) : 0,
      credit: party.type === 'CUSTOMER' ? Math.abs(tx.amount) : 0,
      memo: tx.description,
      extraBadge: `متبقي مقدم: ${Number(tx.balanceAfter || 0).toFixed(2)}`,
    });
  }

  rawRows.sort((a, b) => a.sortKey.localeCompare(b.sortKey, 'en'));

  let openingBalance = 0;
  let runningBalance = 0;
  const transactions: PartyStatementRow[] = [];

  for (const r of rawRows) {
    if (endDate && r.date > endDate) continue;
    const delta =
      party.type === 'CUSTOMER' ? r.debit - r.credit : r.credit - r.debit;
    if (startDate && r.date < startDate) {
      openingBalance = roundMoney(openingBalance + delta);
      runningBalance = openingBalance;
      continue;
    }
    runningBalance = roundMoney(runningBalance + delta);
    transactions.push({
      id: r.id,
      date: r.date,
      sortKey: r.sortKey,
      type: r.type,
      docNumber: r.docNumber,
      debit: r.debit,
      credit: r.credit,
      balanceAfter: runningBalance,
      memo: r.memo,
      extraBadge: r.extraBadge,
    });
  }

  return {
    party,
    openingBalance,
    transactions,
    periodClosingBalance: runningBalance,
    finalBalance: roundMoney(party.balance),
    advanceBalance: roundMoney(party.advanceBalance || 0),
    invoicesCount: partyInvoices.length,
  };
}
