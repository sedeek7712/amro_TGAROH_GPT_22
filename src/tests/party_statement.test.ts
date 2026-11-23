import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPartyStatement } from '../utils/partyStatement';
import type { Invoice, Party, PartyAdvanceTransaction, PaymentAllocation, PaymentVoucher } from '../types/erp';

describe('FIN-02 Party Statement Single-Source Calculation Tests', () => {
  test('100,000 credit sale + 40,000 voucher settlement produces 60,000 balance (no double payment deduction)', () => {
    const customer: Party = {
      id: 'cust-1',
      type: 'CUSTOMER',
      nameAr: 'شركة النجم التجاري',
      phone: '777000111',
      balance: 60000,
      advanceBalance: 0,
    };

    const invoices: Invoice[] = [
      {
        id: 'inv-1',
        invoiceNumber: 'INV-1001',
        type: 'SALE',
        activityId: 'grocery',
        branchId: 'branch_main',
        partyId: 'cust-1',
        partyName: customer.nameAr,
        date: '2026-11-01',
        items: [],
        subtotal: 100000,
        discount: 0,
        tax: 0,
        total: 100000,
        // Financial engine updates inv.paidAmount when allocating the 40,000 voucher!
        paidAmount: 40000,
        paymentMethod: 'CREDIT',
        cashBoxId: 'cb-1',
        isPosted: true,
        status: 'POSTED',
      },
    ];

    const vouchers: PaymentVoucher[] = [
      {
        id: 'v-1',
        voucherNumber: 'RV-1001',
        type: 'RECEIPT',
        voucherMode: 'CUSTOMER_RECEIPT',
        status: 'POSTED',
        date: '2026-11-05',
        amount: 40000,
        appliedToDebtAmount: 40000,
        advanceAmount: 0,
        cashBoxId: 'cb-1',
        partyId: 'cust-1',
        partyName: customer.nameAr,
        accountCode: '1103',
        costCenterId: 'general',
        description: 'سداد جزئي على الفاتورة',
      },
    ];

    const paymentAllocations: PaymentAllocation[] = [
      {
        id: 'alloc-1',
        tenantId: 'tenant_main',
        branchId: 'branch_main',
        voucherId: 'v-1',
        partyId: 'cust-1',
        invoiceId: 'inv-1',
        invoiceNumber: 'INV-1001',
        invoiceDate: '2026-11-01',
        allocatedAmount: 40000,
        allocationMethod: 'FIFO',
        status: 'ACTIVE',
        createdAt: '2026-11-05T10:00:00Z',
      },
    ];

    const statement = buildPartyStatement({
      party: customer,
      invoices,
      vouchers,
      paymentAllocations,
      partyAdvances: [],
    });

    assert.equal(statement.transactions.length, 2);
    // Invoice row must NOT repeat the 40,000 voucher payment
    assert.equal(statement.transactions[0].docNumber, 'INV-1001');
    assert.equal(statement.transactions[0].debit, 100000);
    assert.equal(statement.transactions[0].credit, 0);
    assert.equal(statement.transactions[0].balanceAfter, 100000);

    // Voucher row appears once with 40,000 credit and allocation reference
    assert.equal(statement.transactions[1].docNumber, 'RV-1001');
    assert.equal(statement.transactions[1].credit, 40000);
    assert.equal(statement.transactions[1].balanceAfter, 60000);
    assert.match(statement.transactions[1].extraBadge || '', /INV-1001 \(40000\.00\)/);
    assert.equal(statement.periodClosingBalance, 60000);
  });

  test('Preserves direct POS downpayment separately from voucher allocation & advance settlement, and handles reversed vouchers', () => {
    const customer: Party = {
      id: 'cust-2',
      type: 'CUSTOMER',
      nameAr: 'عميل متعدد الحركات',
      phone: '777000222',
      balance: 25000,
      advanceBalance: 0,
    };

    const invoices: Invoice[] = [
      {
        id: 'inv-2',
        invoiceNumber: 'INV-2001',
        type: 'SALE',
        activityId: 'grocery',
        branchId: 'branch_main',
        partyId: 'cust-2',
        partyName: customer.nameAr,
        date: '2026-11-01',
        items: [],
        subtotal: 100000,
        discount: 0,
        tax: 0,
        total: 100000,
        // 30,000 paid at POS checkout + 20,000 from advance + 25,000 active voucher allocation = 75,000
        paidAmount: 75000,
        advanceAppliedAmount: 20000,
        paymentMethod: 'CASH',
        cashBoxId: 'cb-1',
        isPosted: true,
        status: 'POSTED',
      },
    ];

    const vouchers: PaymentVoucher[] = [
      {
        id: 'v-active',
        voucherNumber: 'RV-2001',
        type: 'RECEIPT',
        status: 'POSTED',
        date: '2026-11-03',
        amount: 25000,
        appliedToDebtAmount: 25000,
        cashBoxId: 'cb-1',
        partyId: 'cust-2',
        partyName: customer.nameAr,
        accountCode: '1103',
        costCenterId: 'general',
        description: 'سند قبض نشط',
      },
      {
        id: 'v-rev',
        voucherNumber: 'RV-2002',
        type: 'RECEIPT',
        status: 'REVERSED',
        date: '2026-11-04',
        amount: 10000,
        appliedToDebtAmount: 10000,
        cashBoxId: 'cb-1',
        partyId: 'cust-2',
        partyName: customer.nameAr,
        accountCode: '1103',
        costCenterId: 'general',
        description: 'سند قبض معكوس',
        reversalReason: 'شيك مرتجع',
      },
    ];

    const paymentAllocations: PaymentAllocation[] = [
      {
        id: 'a-active',
        tenantId: 'tenant_main',
        branchId: 'branch_main',
        voucherId: 'v-active',
        partyId: 'cust-2',
        invoiceId: 'inv-2',
        invoiceNumber: 'INV-2001',
        invoiceDate: '2026-11-01',
        allocatedAmount: 25000,
        allocationMethod: 'FIFO',
        status: 'ACTIVE',
        createdAt: '2026-11-03T10:00:00Z',
      },
      {
        id: 'a-rev',
        tenantId: 'tenant_main',
        branchId: 'branch_main',
        voucherId: 'v-rev',
        partyId: 'cust-2',
        invoiceId: 'inv-2',
        invoiceNumber: 'INV-2001',
        invoiceDate: '2026-11-01',
        allocatedAmount: 10000,
        allocationMethod: 'FIFO',
        status: 'REVERSED',
        createdAt: '2026-11-04T10:00:00Z',
      },
    ];

    const partyAdvances: PartyAdvanceTransaction[] = [
      {
        id: 'adv-1',
        tenantId: 'tenant_main',
        branchId: 'branch_main',
        partyId: 'cust-2',
        partyType: 'CUSTOMER',
        type: 'APPLY_TO_INVOICE',
        amount: -20000,
        balanceAfter: 0,
        invoiceId: 'inv-2',
        date: '2026-11-02',
        description: 'تسوية من الرصيد المقدم',
        createdAt: '2026-11-02T10:00:00Z',
      },
    ];

    const statement = buildPartyStatement({
      party: customer,
      invoices,
      vouchers,
      paymentAllocations,
      partyAdvances,
    });

    // Invoice row only counts direct cash paid (100000 -> paid 30000 at POS => 70000 left)
    assert.equal(statement.transactions[0].credit, 30000);
    assert.equal(statement.transactions[0].balanceAfter, 70000);
    // Closing balance matches exact party balance (70000 - 20000 advance - 25000 active - 10000 + 10000 rev = 25000)
    assert.equal(statement.periodClosingBalance, 25000);
  });

  test('Supplier purchase + payment voucher matches payable balance cleanly without doubling', () => {
    const supplier: Party = {
      id: 'sup-1',
      type: 'SUPPLIER',
      nameAr: 'مؤسسة التوريدات الطبية',
      phone: '777000333',
      balance: -60000,
      advanceBalance: 0,
    };

    const invoices: Invoice[] = [
      {
        id: 'pur-1',
        invoiceNumber: 'PUR-1001',
        type: 'PURCHASE',
        activityId: 'pharmacy',
        branchId: 'branch_main',
        partyId: 'sup-1',
        partyName: supplier.nameAr,
        date: '2026-11-01',
        items: [],
        subtotal: 100000,
        discount: 0,
        tax: 0,
        total: 100000,
        paidAmount: 40000,
        paymentMethod: 'CREDIT',
        cashBoxId: 'cb-1',
        isPosted: true,
        status: 'POSTED',
      },
    ];

    const vouchers: PaymentVoucher[] = [
      {
        id: 'pv-1',
        voucherNumber: 'PV-1001',
        type: 'PAYMENT',
        status: 'POSTED',
        date: '2026-11-05',
        amount: 40000,
        appliedToDebtAmount: 40000,
        cashBoxId: 'cb-1',
        partyId: 'sup-1',
        partyName: supplier.nameAr,
        accountCode: '2101',
        costCenterId: 'general',
        description: 'دفعة للمورد',
      },
    ];

    const paymentAllocations: PaymentAllocation[] = [
      {
        id: 'p-alloc-1',
        tenantId: 'tenant_main',
        branchId: 'branch_main',
        voucherId: 'pv-1',
        partyId: 'sup-1',
        invoiceId: 'pur-1',
        invoiceNumber: 'PUR-1001',
        invoiceDate: '2026-11-01',
        allocatedAmount: 40000,
        allocationMethod: 'FIFO',
        status: 'ACTIVE',
        createdAt: '2026-11-05T10:00:00Z',
      },
    ];

    const statement = buildPartyStatement({
      party: supplier,
      invoices,
      vouchers,
      paymentAllocations,
      partyAdvances: [],
    });

    assert.equal(statement.transactions[0].debit, 0);
    assert.equal(statement.transactions[0].credit, 100000);
    assert.equal(statement.transactions[1].debit, 40000);
    assert.equal(statement.periodClosingBalance, 60000);
  });
});
