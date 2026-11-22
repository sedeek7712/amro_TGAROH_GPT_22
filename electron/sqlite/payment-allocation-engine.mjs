/**
 * Shared Pure Financial Allocation, Advance Settlement, Voucher Plan & Arabic Number-to-Words Engine.
 * Zero runtime dependencies on Node or Browser APIs so BOTH Dexie (Web) and SQLite (Desktop)
 * execute the exact same deterministic financial logic (integer cents arithmetic).
 */

export const PARTY_CONTROL_ACCOUNTS = new Set(['1103', '2101', '2103', '1105']);

export const SPECIAL_ACCOUNTS = {
  CUSTOMERS_AR: '1103',
  SUPPLIER_ADVANCES: '1105',
  SUPPLIERS_AP: '2101',
  AMANAT_LIABILITY: '2102',
  CUSTOMER_ADVANCES: '2103',
};

export function toCents(val) {
  const num = Number(val ?? 0);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100);
}

export function fromCents(cents) {
  return Math.round(cents) / 100;
}

export function roundMoney2(val) {
  return fromCents(toCents(val));
}

export function getInvoiceRemainingAmount(invoice) {
  if (!invoice || invoice.status === 'REVERSED') return 0;
  if (invoice.type === 'RETURN_SALE' || invoice.type === 'RETURN_PURCHASE') return 0;
  const remainingCents = Math.max(
    0,
    toCents(invoice.total) - toCents(invoice.paidAmount) - toCents(invoice.returnedAmount || 0)
  );
  return fromCents(remainingCents);
}

/**
 * Deterministic FIFO sort:
 * 1) Invoice date ascending
 * 2) Due date ascending (if set; undated bills go after dated bills on same invoice date)
 * 3) Invoice number ascending
 * 4) Invoice ID ascending
 * @param {any[]} invoices
 * @returns {any[]}
 */
export function sortOpenInvoicesFIFO(invoices) {
  if (!Array.isArray(invoices)) return [];
  return invoices
    .filter((inv) => inv && toCents(getInvoiceRemainingAmount(inv)) > 0)
    .slice()
    .sort((a, b) => {
      const dateA = String(a.date || '').trim();
      const dateB = String(b.date || '').trim();
      if (dateA !== dateB) return dateA.localeCompare(dateB, 'en');

      const dueA = String(a.dueDate || '').trim() || '9999-12-31';
      const dueB = String(b.dueDate || '').trim() || '9999-12-31';
      if (dueA !== dueB) return dueA.localeCompare(dueB, 'en');

      const numA = String(a.invoiceNumber || '').trim();
      const numB = String(b.invoiceNumber || '').trim();
      if (numA !== numB) return numA.localeCompare(numB, 'en');

      return String(a.id || '').localeCompare(String(b.id || ''), 'en');
    });
}

/**
 * @param {any[]} openInvoices
 * @param {number} paymentAmount
 */
export function computeFifoAllocations(openInvoices, paymentAmount) {
  const paymentCents = toCents(paymentAmount);
  if (paymentCents <= 0) {
    throw new Error('مبلغ الدفعة يجب أن يكون أكبر من الصفر.');
  }

  const sorted = sortOpenInvoicesFIFO(openInvoices);
  let remainingPaymentCents = paymentCents;
  const allocations = [];
  let totalAllocatedCents = 0;

  for (const inv of sorted) {
    if (remainingPaymentCents <= 0) break;
    const totalCentsVal = toCents(inv.total);
    const paidBeforeCents = toCents(inv.paidAmount);
    const remainingBeforeCents = toCents(getInvoiceRemainingAmount(inv));
    if (remainingBeforeCents <= 0) continue;

    const allocCents = Math.min(remainingPaymentCents, remainingBeforeCents);
    if (allocCents <= 0) continue;

    allocations.push({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber || inv.id,
      invoiceDate: inv.date || '',
      dueDate: inv.dueDate || undefined,
      invoiceTotal: fromCents(totalCentsVal),
      paidBefore: fromCents(paidBeforeCents),
      remainingBefore: fromCents(remainingBeforeCents),
      allocatedAmount: fromCents(allocCents),
      remainingAfter: fromCents(remainingBeforeCents - allocCents),
    });

    remainingPaymentCents -= allocCents;
    totalAllocatedCents += allocCents;
  }

  return {
    allocations,
    totalAllocatedAmount: fromCents(totalAllocatedCents),
    unallocatedAmount: fromCents(remainingPaymentCents),
  };
}

/**
 * @param {{ openInvoices: any[], paymentAmount: number, requestedAllocations: any[] }} params
 */
export function validateManualAllocations({ openInvoices, paymentAmount, requestedAllocations }) {
  const paymentCents = toCents(paymentAmount);
  if (paymentCents <= 0) {
    throw new Error('مبلغ السند يجب أن يكون أكبر من الصفر.');
  }
  if (!Array.isArray(requestedAllocations)) {
    throw new Error('تفاصيل التخصيص اليدوي غير صالحة.');
  }

  const invoiceMap = new Map();
  for (const inv of sortOpenInvoicesFIFO(openInvoices)) {
    invoiceMap.set(inv.id, inv);
  }

  const seenIds = new Set();
  const allocations = [];
  let totalAllocatedCents = 0;

  for (const req of requestedAllocations) {
    const invoiceId = String(req?.invoiceId || '').trim();
    const allocCents = toCents(req?.allocatedAmount);
    if (allocCents === 0) continue;
    if (!invoiceId) {
      throw new Error('معرف الفاتورة مطلوب في كل سطر تخصيص.');
    }
    if (seenIds.has(invoiceId)) {
      throw new Error(`لا يمكن تكرار نفس الفاتورة (${invoiceId}) في التخصيص اليدوي.`);
    }
    seenIds.add(invoiceId);

    if (allocCents < 0) {
      throw new Error('مبلغ التخصيص للفاتورة لا يجوز أن يكون سالباً.');
    }

    const inv = invoiceMap.get(invoiceId);
    if (!inv) {
      throw new Error(`الفاتورة (${invoiceId}) غير موجودة ضمن الفواتير المفتوحة لهذا الطرف.`);
    }

    const totalCentsVal = toCents(inv.total);
    const paidBeforeCents = toCents(inv.paidAmount);
    const remainingBeforeCents = Math.max(0, totalCentsVal - paidBeforeCents);
    if (allocCents > remainingBeforeCents) {
      throw new Error(
        `المبلغ المخصص (${fromCents(allocCents)}) يتجاوز المتبقي من الفاتورة ${inv.invoiceNumber || inv.id} (${fromCents(remainingBeforeCents)}).`
      );
    }

    totalAllocatedCents += allocCents;
    allocations.push({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber || inv.id,
      invoiceDate: inv.date || '',
      dueDate: inv.dueDate || undefined,
      invoiceTotal: fromCents(totalCentsVal),
      paidBefore: fromCents(paidBeforeCents),
      remainingBefore: fromCents(remainingBeforeCents),
      allocatedAmount: fromCents(allocCents),
      remainingAfter: fromCents(remainingBeforeCents - allocCents),
    });
  }

  if (totalAllocatedCents > paymentCents) {
    throw new Error(
      `مجموع التخصيص اليدوي (${fromCents(totalAllocatedCents)}) يتجاوز مبلغ الدفعة النقدية (${fromCents(paymentCents)}).`
    );
  }

  return {
    allocations,
    totalAllocatedAmount: fromCents(totalAllocatedCents),
    unallocatedAmount: fromCents(paymentCents - totalAllocatedCents),
  };
}

/**
 * Resolves exact contra accounts, FIFO/Manual allocations, debt reduction, and advance deposit/refund
 * for any cash voucher (Customer Receipt, Supplier Payment, Party Advance Refund, or General Receipt/Payment).
 * @param {{
 *   voucherType: 'RECEIPT' | 'PAYMENT',
 *   voucherMode?: string,
 *   party?: any,
 *   requestedAccountCode?: string,
 *   amount: number,
 *   openInvoices?: any[],
 *   manualAllocations?: any[],
 *   hasOverridePermission?: boolean,
 *   overrideReason?: string,
 *   hasSupplierAdvancePermission?: boolean,
 *   targetAccountIsLeaf?: boolean,
 * }} params
 */
export function resolveVoucherAccountingPlan({
  voucherType,
  voucherMode,
  party,
  requestedAccountCode,
  amount,
  openInvoices = [],
  manualAllocations,
  hasOverridePermission = false,
  overrideReason = '',
  hasSupplierAdvancePermission = false,
  targetAccountIsLeaf = true,
}) {
  const amountCents = toCents(amount);
  if (amountCents <= 0) {
    throw new Error('مبلغ السند المالي يجب أن يكون أكبر من الصفر.');
  }

  if (party) {
    if (voucherMode === 'GENERAL') {
      throw new Error('لا يجوز اختيار طرف (عميل/مورد) في سند مصروف أو إيراد عام بدون ذمة؛ استخدم نمط تسوية الطرف.');
    }

    // 1. Customer Receipt (تحصيل من عميل -> 1103 للفواتير/الذمة، والزائد 2103 دفعة مقدمة)
    if (voucherType === 'RECEIPT' && party.type === 'CUSTOMER') {
      const sortedOpen = sortOpenInvoicesFIFO(openInvoices.filter((i) => i.type === 'SALE'));
      const openTotalCents = sortedOpen.reduce(
        (s, inv) => s + Math.max(0, toCents(inv.total) - toCents(inv.paidAmount)),
        0
      );
      const currentPartyReceivableCents = Math.max(0, toCents(party.balance));
      const uninvoicedDebtCents = Math.max(0, currentPartyReceivableCents - openTotalCents);

      let fifoPlan = computeFifoAllocations(sortedOpen, fromCents(amountCents));
      let activeAllocations = fifoPlan.allocations;
      let allocatedToInvoicesCents = toCents(fifoPlan.totalAllocatedAmount);
      let isManualOverride = false;

      if (Array.isArray(manualAllocations)) {
        if (!hasOverridePermission) {
          throw new Error('حظر صلاحيات: التعديل اليدوي لتخصيص الدفعات يتطلب صلاحية (payment:allocation:override).');
        }
        if (!String(overrideReason || '').trim()) {
          throw new Error('يجب إدخال سبب التعديل اليدوي لتوثيقه في سجل التدقيق.');
        }
        const manualPlan = validateManualAllocations({
          openInvoices: sortedOpen,
          paymentAmount: fromCents(amountCents),
          requestedAllocations: manualAllocations,
        });
        activeAllocations = manualPlan.allocations;
        allocatedToInvoicesCents = toCents(manualPlan.totalAllocatedAmount);
        isManualOverride = true;
      }

      const remainingAfterInvoicesCents = amountCents - allocatedToInvoicesCents;
      // Only settle uninvoiced legacy opening debt if not manually overriding away from open invoices,
      // or settle remaining against uninvoiced opening balance before recording customer advance (2103).
      const uninvoicedDebtSettledCents = isManualOverride
        ? 0
        : Math.min(remainingAfterInvoicesCents, uninvoicedDebtCents);

      const appliedToDebtCents = allocatedToInvoicesCents + uninvoicedDebtSettledCents;
      const advanceCreatedCents = amountCents - appliedToDebtCents;

      return {
        mode: 'CUSTOMER_RECEIPT',
        primaryContraAccountCode:
          appliedToDebtCents > 0 ? SPECIAL_ACCOUNTS.CUSTOMERS_AR : SPECIAL_ACCOUNTS.CUSTOMER_ADVANCES,
        creditLines: [
          ...(appliedToDebtCents > 0
            ? [{ accountCode: SPECIAL_ACCOUNTS.CUSTOMERS_AR, amount: fromCents(appliedToDebtCents) }]
            : []),
          ...(advanceCreatedCents > 0
            ? [{ accountCode: SPECIAL_ACCOUNTS.CUSTOMER_ADVANCES, amount: fromCents(advanceCreatedCents) }]
            : []),
        ],
        debitLines: [],
        allocations: activeAllocations,
        previousFifoAllocations: fifoPlan.allocations,
        appliedToDebtAmount: fromCents(appliedToDebtCents),
        advanceAmount: fromCents(advanceCreatedCents),
        advanceDirection: advanceCreatedCents > 0 ? 'DEPOSIT_CUSTOMER' : 'NONE',
        partyDebtDelta: -fromCents(appliedToDebtCents),
        partyAdvanceDelta: fromCents(advanceCreatedCents),
        manualOverride: isManualOverride,
        overrideReason: isManualOverride ? String(overrideReason).trim() : undefined,
      };
    }

    // 2. Supplier Payment (سداد لمورد -> 2101 للمستحق، والزائد 1105 سلف الموردين بموافقة)
    if (voucherType === 'PAYMENT' && party.type === 'SUPPLIER') {
      const sortedOpen = sortOpenInvoicesFIFO(openInvoices.filter((i) => i.type === 'PURCHASE'));
      const openTotalCents = sortedOpen.reduce(
        (s, inv) => s + Math.max(0, toCents(inv.total) - toCents(inv.paidAmount)),
        0
      );
      const currentPayableDebtCents = Math.max(0, -toCents(party.balance));
      const uninvoicedPayableCents = Math.max(0, currentPayableDebtCents - openTotalCents);

      let fifoPlan = computeFifoAllocations(sortedOpen, fromCents(amountCents));
      let activeAllocations = fifoPlan.allocations;
      let allocatedToInvoicesCents = toCents(fifoPlan.totalAllocatedAmount);
      let isManualOverride = false;

      if (Array.isArray(manualAllocations)) {
        if (!hasOverridePermission) {
          throw new Error('حظر صلاحيات: التعديل اليدوي لتخصيص دفعات الموردين يتطلب صلاحية (payment:allocation:override).');
        }
        if (!String(overrideReason || '').trim()) {
          throw new Error('يجب إدخال سبب التعديل اليدوي لتوثيقه في سجل التدقيق.');
        }
        const manualPlan = validateManualAllocations({
          openInvoices: sortedOpen,
          paymentAmount: fromCents(amountCents),
          requestedAllocations: manualAllocations,
        });
        activeAllocations = manualPlan.allocations;
        allocatedToInvoicesCents = toCents(manualPlan.totalAllocatedAmount);
        isManualOverride = true;
      }

      const remainingAfterInvoicesCents = amountCents - allocatedToInvoicesCents;
      const uninvoicedSettledCents = isManualOverride
        ? 0
        : Math.min(remainingAfterInvoicesCents, uninvoicedPayableCents);

      const appliedToDebtCents = allocatedToInvoicesCents + uninvoicedSettledCents;
      const supplierAdvanceCents = amountCents - appliedToDebtCents;

      if (supplierAdvanceCents > 0 && !hasSupplierAdvancePermission) {
        throw new Error(
          'حظر صلاحيات: صرف مبلغ يتجاوز فواتير المورد المستحقة يتطلب صلاحية اعتماد سلف الموردين (supplier:advance:approve).'
        );
      }

      return {
        mode: 'SUPPLIER_PAYMENT',
        primaryContraAccountCode:
          appliedToDebtCents > 0 ? SPECIAL_ACCOUNTS.SUPPLIERS_AP : SPECIAL_ACCOUNTS.SUPPLIER_ADVANCES,
        debitLines: [
          ...(appliedToDebtCents > 0
            ? [{ accountCode: SPECIAL_ACCOUNTS.SUPPLIERS_AP, amount: fromCents(appliedToDebtCents) }]
            : []),
          ...(supplierAdvanceCents > 0
            ? [{ accountCode: SPECIAL_ACCOUNTS.SUPPLIER_ADVANCES, amount: fromCents(supplierAdvanceCents) }]
            : []),
        ],
        creditLines: [],
        allocations: activeAllocations,
        previousFifoAllocations: fifoPlan.allocations,
        appliedToDebtAmount: fromCents(appliedToDebtCents),
        advanceAmount: fromCents(supplierAdvanceCents),
        advanceDirection: supplierAdvanceCents > 0 ? 'DEPOSIT_SUPPLIER' : 'NONE',
        partyDebtDelta: fromCents(appliedToDebtCents), // negative payable moves toward 0
        partyAdvanceDelta: fromCents(supplierAdvanceCents),
        manualOverride: isManualOverride,
        overrideReason: isManualOverride ? String(overrideReason).trim() : undefined,
      };
    }

    // 3. Refunding Customer Advance (صرف رد رصيد مقدم لعميل -> مدين 2103 / دائن الصندوق)
    if (voucherType === 'PAYMENT' && party.type === 'CUSTOMER') {
      const availableAdvCents = Math.max(0, toCents(party.advanceBalance));
      if (amountCents > availableAdvCents) {
        throw new Error(
          `لا يمكن رد مبلغ (${fromCents(amountCents)}) للعميل لأن رصيده المقدم المتاح (${fromCents(availableAdvCents)}) غير كافٍ.`
        );
      }
      return {
        mode: 'CUSTOMER_ADVANCE_REFUND',
        primaryContraAccountCode: SPECIAL_ACCOUNTS.CUSTOMER_ADVANCES,
        debitLines: [{ accountCode: SPECIAL_ACCOUNTS.CUSTOMER_ADVANCES, amount: fromCents(amountCents) }],
        creditLines: [],
        allocations: [],
        previousFifoAllocations: [],
        appliedToDebtAmount: 0,
        advanceAmount: fromCents(amountCents),
        advanceDirection: 'REFUND_CUSTOMER',
        partyDebtDelta: 0,
        partyAdvanceDelta: -fromCents(amountCents),
        manualOverride: false,
      };
    }

    // 4. Receiving Supplier Advance Refund (قبض استرداد سلفة من مورد -> مدين الصندوق / دائن 1105)
    if (voucherType === 'RECEIPT' && party.type === 'SUPPLIER') {
      const availableAdvCents = Math.max(0, toCents(party.advanceBalance));
      if (amountCents > availableAdvCents) {
        throw new Error(
          `لا يمكن استرداد مبلغ (${fromCents(amountCents)}) من المورد لأن رصيد السلف المتاح لديه (${fromCents(availableAdvCents)}) غير كافٍ.`
        );
      }
      return {
        mode: 'SUPPLIER_ADVANCE_REFUND',
        primaryContraAccountCode: SPECIAL_ACCOUNTS.SUPPLIER_ADVANCES,
        creditLines: [{ accountCode: SPECIAL_ACCOUNTS.SUPPLIER_ADVANCES, amount: fromCents(amountCents) }],
        debitLines: [],
        allocations: [],
        previousFifoAllocations: [],
        appliedToDebtAmount: 0,
        advanceAmount: fromCents(amountCents),
        advanceDirection: 'REFUND_SUPPLIER',
        partyDebtDelta: 0,
        partyAdvanceDelta: -fromCents(amountCents),
        manualOverride: false,
      };
    }
  }

  // No party selected -> must be a non-party General Voucher (e.g. Expense 5201..5204 or non-AR/AP account)
  const cleanAcc = String(requestedAccountCode || '').trim();
  if (!cleanAcc) {
    throw new Error('الحساب المقابل مطلوب لإتمام السند.');
  }
  if (PARTY_CONTROL_ACCOUNTS.has(cleanAcc)) {
    throw new Error(
      `لا يجوز الترحيل على حساب الرقابة (${cleanAcc}) دون اختيار سجل عميل أو مورد حقيقي مربوط بمعرّفه.`
    );
  }
  if (!targetAccountIsLeaf) {
    throw new Error(`لا يجوز الترحيل على الحساب التجميعي غير الفرعي (${cleanAcc}).`);
  }
  if (Array.isArray(manualAllocations) && manualAllocations.length > 0) {
    throw new Error('لا يمكن إرفاق تخصيص فواتير بسند غير مرتبط بطرف.');
  }

  return {
    mode: 'GENERAL',
    primaryContraAccountCode: cleanAcc,
    debitLines: voucherType === 'PAYMENT' ? [{ accountCode: cleanAcc, amount: fromCents(amountCents) }] : [],
    creditLines: voucherType === 'RECEIPT' ? [{ accountCode: cleanAcc, amount: fromCents(amountCents) }] : [],
    allocations: [],
    previousFifoAllocations: [],
    appliedToDebtAmount: 0,
    advanceAmount: 0,
    advanceDirection: 'NONE',
    partyDebtDelta: 0,
    partyAdvanceDelta: 0,
    manualOverride: false,
  };
}

/**
 * Arabic number-to-words helper for official receipt printing ("المبلغ رقماً وكتابة").
 */
const ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة'];
const TEENS = [
  'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر',
  'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر',
];
const TENS = ['', 'عشرة', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];

function convertHundreds(n) {
  const parts = [];
  const h = Math.floor(n / 100);
  const rem = n % 100;
  if (h > 0) parts.push(HUNDREDS[h]);
  if (rem > 0) {
    if (rem < 10) {
      parts.push(ONES[rem]);
    } else if (rem < 20) {
      parts.push(TEENS[rem - 10]);
    } else {
      const u = rem % 10;
      const t = Math.floor(rem / 10);
      if (u > 0) parts.push(`${ONES[u]} و${TENS[t]}`);
      else parts.push(TENS[t]);
    }
  }
  return parts.join(' و');
}

function convertIntegerToArabic(num) {
  if (num === 0) return 'صفر';
  const scales = [
    { divisor: 1000000000, singular: 'مليار', dual: 'ملياران', plural: 'مليارات' },
    { divisor: 1000000, singular: 'مليون', dual: 'مليونان', plural: 'ملايين' },
    { divisor: 1000, singular: 'ألف', dual: 'ألفان', plural: 'آلاف' },
  ];
  let rem = Math.floor(num);
  const segments = [];
  for (const s of scales) {
    if (rem >= s.divisor) {
      const q = Math.floor(rem / s.divisor);
      rem %= s.divisor;
      if (q === 1) segments.push(s.singular);
      else if (q === 2) segments.push(s.dual);
      else if (q >= 3 && q <= 10) segments.push(`${convertHundreds(q)} ${s.plural}`);
      else segments.push(`${convertHundreds(q)} ${s.singular}`);
    }
  }
  if (rem > 0) segments.push(convertHundreds(rem));
  return segments.join(' و');
}

export function numberToArabicWords(amount, currencyName = 'ريال') {
  const cents = Math.abs(toCents(amount));
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  const wholeWords = convertIntegerToArabic(whole);
  if (frac > 0) {
    const fracWords = convertIntegerToArabic(frac);
    return `فقط ${wholeWords} ${currencyName} و${fracWords} هللة لا غير`;
  }
  return `فقط ${wholeWords} ${currencyName} لا غير`;
}
