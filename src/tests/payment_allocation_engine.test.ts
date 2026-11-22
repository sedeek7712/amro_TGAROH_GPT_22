/**
 * اختبارات محرك تخصيص الدفعات (FIFO)، التعديل اليدوي، الرصيد المقدم (2103 / 1105)، وتفقيط المبالغ بالعربية
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPECIAL_ACCOUNTS,
  computeFifoAllocations,
  numberToArabicWords,
  resolveVoucherAccountingPlan,
  sortOpenInvoicesFIFO,
  validateManualAllocations,
} from '../../electron/sqlite/payment-allocation-engine.mjs';

describe('Payment Allocation & Advance Engine Unit Tests', () => {
  test('FIFO sorting orders by date ASC, then dueDate ASC (undated last), then invoiceNumber ASC', () => {
    const sorted = sortOpenInvoicesFIFO([
      { id: 'inv-4', date: '2026-11-05', invoiceNumber: 'INV-004', total: 100, paidAmount: 0 },
      { id: 'inv-3', date: '2026-11-02', invoiceNumber: 'INV-003', total: 100, paidAmount: 0 },
      { id: 'inv-2', date: '2026-11-02', dueDate: '2026-11-15', invoiceNumber: 'INV-002', total: 100, paidAmount: 0 },
      { id: 'inv-1', date: '2026-11-02', dueDate: '2026-11-10', invoiceNumber: 'INV-001', total: 100, paidAmount: 0 },
      { id: 'inv-rev', date: '2026-11-01', invoiceNumber: 'INV-000', total: 100, paidAmount: 0, status: 'REVERSED' },
      { id: 'inv-paid', date: '2026-11-01', invoiceNumber: 'INV-000B', total: 100, paidAmount: 100 },
    ]);

    assert.deepEqual(
      sorted.map((i) => i.id),
      ['inv-1', 'inv-2', 'inv-3', 'inv-4']
    );
  });

  test('Master Doc Section 16 FIFO example: 50,000 + 40,000 + 30,000 with 100,000 payment', () => {
    const openInvoices = [
      { id: 'i1', date: '2026-11-01', invoiceNumber: '001', total: 50000, paidAmount: 0 },
      { id: 'i2', date: '2026-11-02', invoiceNumber: '002', total: 40000, paidAmount: 0 },
      { id: 'i3', date: '2026-11-03', invoiceNumber: '003', total: 30000, paidAmount: 0 },
    ];

    const res = computeFifoAllocations(openInvoices, 100000);
    assert.equal(res.totalAllocatedAmount, 100000);
    assert.equal(res.unallocatedAmount, 0);
    assert.deepEqual(
      res.allocations.map((a) => ({
        invoiceNumber: a.invoiceNumber,
        allocatedAmount: a.allocatedAmount,
        remainingAfter: a.remainingAfter,
      })),
      [
        { invoiceNumber: '001', allocatedAmount: 50000, remainingAfter: 0 },
        { invoiceNumber: '002', allocatedAmount: 40000, remainingAfter: 0 },
        { invoiceNumber: '003', allocatedAmount: 10000, remainingAfter: 20000 },
      ]
    );
  });

  test('Customer overpayment posts excess to 2103 CUSTOMER_ADVANCES (never revenue)', () => {
    const plan = resolveVoucherAccountingPlan({
      voucherType: 'RECEIPT',
      voucherMode: 'CUSTOMER_RECEIPT',
      party: { id: 'c1', type: 'CUSTOMER', nameAr: 'عميل 1', balance: 800, advanceBalance: 0 },
      amount: 1000,
      openInvoices: [
        { id: 'i1', type: 'SALE', date: '2026-11-01', invoiceNumber: 'INV-1', total: 800, paidAmount: 0 },
      ],
    });

    assert.equal(plan.appliedToDebtAmount, 800);
    assert.equal(plan.advanceAmount, 200);
    assert.equal(plan.advanceDirection, 'DEPOSIT_CUSTOMER');
    assert.equal(plan.partyDebtDelta, -800);
    assert.equal(plan.partyAdvanceDelta, 200);
    assert.deepEqual(plan.creditLines, [
      { accountCode: SPECIAL_ACCOUNTS.CUSTOMERS_AR, amount: 800 },
      { accountCode: SPECIAL_ACCOUNTS.CUSTOMER_ADVANCES, amount: 200 },
    ]);
  });

  test('Manual allocation override enforces RBAC, reason, remaining cap, and total payment cap', () => {
    const openInvoices = [
      { id: 'i1', type: 'SALE' as const, date: '2026-11-01', invoiceNumber: 'INV-1', total: 500, paidAmount: 0 },
      { id: 'i2', type: 'SALE' as const, date: '2026-11-02', invoiceNumber: 'INV-2', total: 400, paidAmount: 0 },
    ];
    const party = { id: 'c1', type: 'CUSTOMER' as const, nameAr: 'عميل', balance: 900, advanceBalance: 0 };

    // Missing permission rejected
    assert.throws(
      () =>
        resolveVoucherAccountingPlan({
          voucherType: 'RECEIPT',
          voucherMode: 'CUSTOMER_RECEIPT',
          party,
          amount: 400,
          openInvoices,
          manualAllocations: [{ invoiceId: 'i2', allocatedAmount: 400 }],
          hasOverridePermission: false,
          overrideReason: 'تخصيص خاص',
        }),
      /payment:allocation:override/
    );

    // Missing reason rejected
    assert.throws(
      () =>
        resolveVoucherAccountingPlan({
          voucherType: 'RECEIPT',
          voucherMode: 'CUSTOMER_RECEIPT',
          party,
          amount: 400,
          openInvoices,
          manualAllocations: [{ invoiceId: 'i2', allocatedAmount: 400 }],
          hasOverridePermission: true,
          overrideReason: '   ',
        }),
      /سبب التعديل اليدوي/
    );

    // Over-allocating beyond invoice remaining rejected
    assert.throws(
      () =>
        validateManualAllocations({
          openInvoices,
          paymentAmount: 600,
          requestedAllocations: [{ invoiceId: 'i2', allocatedAmount: 450 }],
        }),
      /يتجاوز المتبقي/
    );

    // Over-allocating beyond voucher amount rejected
    assert.throws(
      () =>
        validateManualAllocations({
          openInvoices,
          paymentAmount: 500,
          requestedAllocations: [
            { invoiceId: 'i1', allocatedAmount: 300 },
            { invoiceId: 'i2', allocatedAmount: 300 },
          ],
        }),
      /يتجاوز مبلغ الدفعة/
    );

    // Valid override records previous FIFO vs new manual allocations
    const valid = resolveVoucherAccountingPlan({
      voucherType: 'RECEIPT',
      voucherMode: 'CUSTOMER_RECEIPT',
      party,
      amount: 400,
      openInvoices,
      manualAllocations: [{ invoiceId: 'i2', allocatedAmount: 400 }],
      hasOverridePermission: true,
      overrideReason: 'طلب العميل تسوية الفاتورة الثانية أولاً',
    });

    assert.equal(valid.manualOverride, true);
    assert.equal(valid.previousFifoAllocations[0].invoiceId, 'i1');
    assert.equal(valid.allocations[0].invoiceId, 'i2');
    assert.equal(valid.allocations[0].allocatedAmount, 400);
  });

  test('Supplier payment routes debt to 2101 and excess to 1105 only with permission', () => {
    const supplier = { id: 's1', type: 'SUPPLIER' as const, nameAr: 'مورد', balance: -600, advanceBalance: 0 };
    const openInvoices = [
      { id: 'p1', type: 'PURCHASE' as const, date: '2026-11-01', invoiceNumber: 'PUR-1', total: 600, paidAmount: 0 },
    ];

    assert.throws(
      () =>
        resolveVoucherAccountingPlan({
          voucherType: 'PAYMENT',
          voucherMode: 'SUPPLIER_PAYMENT',
          party: supplier,
          amount: 1000,
          openInvoices,
          hasSupplierAdvancePermission: false,
        }),
      /supplier:advance:approve/
    );

    const approved = resolveVoucherAccountingPlan({
      voucherType: 'PAYMENT',
      voucherMode: 'SUPPLIER_PAYMENT',
      party: supplier,
      amount: 1000,
      openInvoices,
      hasSupplierAdvancePermission: true,
    });
    assert.equal(approved.appliedToDebtAmount, 600);
    assert.equal(approved.advanceAmount, 400);
    assert.equal(approved.advanceDirection, 'DEPOSIT_SUPPLIER');
    assert.deepEqual(approved.debitLines, [
      { accountCode: SPECIAL_ACCOUNTS.SUPPLIERS_AP, amount: 600 },
      { accountCode: SPECIAL_ACCOUNTS.SUPPLIER_ADVANCES, amount: 400 },
    ]);
  });

  test('Advance refunds enforce available advanceBalance and GENERAL mode blocks party/control/non-leaf accounts', () => {
    assert.throws(
      () =>
        resolveVoucherAccountingPlan({
          voucherType: 'PAYMENT',
          party: { id: 'c1', type: 'CUSTOMER', nameAr: 'عميل', balance: 0, advanceBalance: 100 },
          amount: 150,
        }),
      /غير كافٍ/
    );

    assert.throws(
      () =>
        resolveVoucherAccountingPlan({
          voucherType: 'PAYMENT',
          voucherMode: 'GENERAL',
          party: { id: 'c1', type: 'CUSTOMER', nameAr: 'عميل', balance: 0, advanceBalance: 100 },
          requestedAccountCode: '5204',
          amount: 50,
        }),
      /لا يجوز اختيار طرف/
    );

    assert.throws(
      () =>
        resolveVoucherAccountingPlan({
          voucherType: 'RECEIPT',
          voucherMode: 'GENERAL',
          requestedAccountCode: '1103',
          amount: 50,
        }),
      /حساب الرقابة/
    );

    assert.throws(
      () =>
        resolveVoucherAccountingPlan({
          voucherType: 'PAYMENT',
          voucherMode: 'GENERAL',
          requestedAccountCode: '5200',
          amount: 50,
          targetAccountIsLeaf: false,
        }),
      /التجميعي/
    );
  });

  test('numberToArabicWords formats integer and decimal halalas accurately', () => {
    assert.equal(numberToArabicWords(100, 'ريال'), 'فقط مائة ريال لا غير');
    assert.equal(numberToArabicWords(2500.5, 'ريال'), 'فقط ألفان وخمسمائة ريال وخمسون هللة لا غير');
  });
});
