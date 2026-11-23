import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BUSINESS_TIMEZONE,
  formatLocalDate,
  formatLocalDateTime,
  formatLocalTime,
} from '../utils/localDate';
import { resolveEnterpriseDocumentMeta } from '../utils/documentBranding';
import {
  buildAmanatNotificationPayload,
  buildInvoiceNotificationPayload,
  computeInvoiceOpenRemaining,
} from '../utils/documentNotifications';
import { buildPrintPageCss } from '../utils/printDocument';
import { buildPartyStatement } from '../utils/partyStatement';
import type { AmanatRecord, Invoice, Party } from '../types/erp';

test('localDate formats Yemen Asia/Aden date without UTC off-by-one shift', () => {
  // 22:30 UTC on 2026-11-22 is 01:30 (+03:00) on 2026-11-23 in Asia/Aden
  const utcBoundary = '2026-11-22T22:30:00Z';
  assert.equal(DEFAULT_BUSINESS_TIMEZONE, 'Asia/Aden');
  assert.equal(formatLocalDate(utcBoundary), '2026-11-23');
  assert.equal(formatLocalTime(utcBoundary), '01:30');
  const full = formatLocalDateTime(utcBoundary);
  assert.equal(full.date, '2026-11-23');
  assert.equal(full.year, 2026);
  assert.equal(full.displayTabular, '2026-11-23 01:30');
});

test('resolveEnterpriseDocumentMeta binds strictly to CompanyProfile with no synthetic logo or vendor brand', () => {
  const withoutLogo = resolveEnterpriseDocumentMeta({
    profile: {
      nameAr: 'شركة النماري التجارية',
      nameEn: 'Al-Namari Trading Co.',
      address: 'صنعاء - شارع الستين',
      phone: '777111222',
      email: 'info@alnamari.example',
      taxNumber: '30011223344',
      logo: '',
      headerNote: 'ترويسة رسمية',
      footerNote: 'شكراً لتعاملكم',
      currency: 'ريال يمني',
      currencyCode: 'YER',
      currencySymbol: 'ر.ي',
      currencyDecimalPlaces: 2,
    },
    branch: {
      id: 'branch_main',
      nameAr: 'الفرع الرئيسي - صنعاء',
      code: 'BR-01',
      address: 'صنعاء',
      phone: '01222333',
      isMain: true,
      active: true,
      createdAt: '2026-01-01T00:00:00Z',
    },
    activity: {
      id: 'grocery',
      nameAr: 'تجارة المواد الغذائية',
      code: 'GR',
      descriptionAr: 'نشاط المواد الغذائية',
      costCenterCode: 'CC-GR',
      color: 'emerald',
      icon: 'Store',
      isInventoryManaged: true,
    },
    issuerName: 'عمرو النماري',
  });

  assert.equal(withoutLogo.hasLogo, false);
  assert.equal(withoutLogo.logoUrl, undefined);
  assert.equal(withoutLogo.companyNameAr, 'شركة النماري التجارية');
  assert.equal(withoutLogo.branchName, 'الفرع الرئيسي - صنعاء');
  assert.equal(withoutLogo.activityName, 'تجارة المواد الغذائية');
  assert.equal(withoutLogo.issuerName, 'عمرو النماري');
  assert.equal(withoutLogo.currency.symbol, 'ر.ي');
  assert.ok(!JSON.stringify(withoutLogo).includes('TOOFAN'));

  const withLogo = resolveEnterpriseDocumentMeta({
    profile: {
      nameAr: 'شركة النماري التجارية',
      address: '',
      phone: '',
      logo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
      currency: 'ريال يمني',
      currencySymbol: 'ر.ي',
    },
  });
  assert.equal(withLogo.hasLogo, true);
  assert.ok(withLogo.logoUrl?.startsWith('data:image/png;base64,'));
});

test('invoice notification payload deducts returnedAmount and omits balanceRemaining on returns', () => {
  const creditSale: Invoice = {
    id: 'inv-1',
    invoiceNumber: 'INV-1001',
    type: 'SALE',
    date: '2026-11-23',
    branchId: 'branch_main',
    activityId: 'grocery',
    partyId: 'p-1',
    partyName: 'عميل تجريبي',
    items: [
      {
        id: 'item-1',
        productId: 'pr-1',
        productCode: 'PR-001',
        productName: 'أرز بسمتي',
        quantity: 2,
        unit: 'كيس',
        unitPrice: 500,
        discount: 0,
        total: 1000,
      },
    ],
    subtotal: 1000,
    discount: 0,
    tax: 0,
    total: 1000,
    paidAmount: 400,
    returnedAmount: 150,
    paymentMethod: 'CREDIT',
    cashBoxId: 'cb-1',
    isPosted: true,
    status: 'POSTED',
  };

  assert.equal(computeInvoiceOpenRemaining(creditSale), 450);

  const salePayload = buildInvoiceNotificationPayload({
    invoice: creditSale,
    activityName: 'تجارة المواد الغذائية',
    recipientPhone: '777000999',
  });
  assert.equal(salePayload.documentType, 'INVOICE');
  assert.equal(salePayload.amount, 1000);
  assert.equal(salePayload.balanceRemaining, 450);
  assert.equal(salePayload.date, '2026-11-23');
  assert.ok(salePayload.itemsSummary?.includes('أرز بسمتي'));

  const returnSale: Invoice = {
    ...creditSale,
    id: 'ret-1',
    invoiceNumber: 'RET-1001',
    type: 'RETURN_SALE',
    total: 150,
    paidAmount: 0,
    returnedAmount: 0,
    originalInvoiceNumber: 'INV-1001',
    returnReason: 'تلف جزئي',
  };

  assert.equal(computeInvoiceOpenRemaining(returnSale), 0);
  const retPayload = buildInvoiceNotificationPayload({ invoice: returnSale });
  assert.equal(retPayload.balanceRemaining, undefined);
  assert.ok(retPayload.notes?.includes('INV-1001'));
});

test('amanat notification payload preserves AMANAT_RETURN, partial return event amount, and item details (DOC-01)', () => {
  const heldCashPartial: AmanatRecord = {
    id: 'am-1',
    recordNumber: 'AMN-101',
    type: 'CASH',
    depositorName: 'محمد صالح',
    depositorPhone: '771234567',
    amount: 50000,
    returnedAmount: 20000,
    remainingAmount: 30000,
    receivedDate: '2026-11-20',
    receivedBy: 'أمير',
    status: 'HELD',
    branchId: 'branch_main',
    returnHistory: [
      {
        id: 'ret-ev-1',
        date: '2026-11-23',
        amount: 20000,
        createdByName: 'أمير',
        recipientSignatureName: 'محمد صالح',
        notes: 'دفعة أولى',
      },
    ],
  };
  const partialPayload = buildAmanatNotificationPayload(heldCashPartial);
  assert.equal(partialPayload.documentType, 'AMANAT_RETURN');
  assert.equal(partialPayload.amount, 20000);
  assert.equal(partialPayload.balanceRemaining, 30000);
  assert.equal(partialPayload.isPartialReturn, true);
  assert.equal(partialPayload.error, undefined);

  const missingHistoryReturned: AmanatRecord = {
    ...heldCashPartial,
    returnedAmount: 50000,
    remainingAmount: 0,
    returnedDate: '2026-11-23',
    status: 'RETURNED',
    returnHistory: [],
  };
  const blockedPayload = buildAmanatNotificationPayload(missingHistoryReturned, { mode: 'RETURN' });
  assert.equal(blockedPayload.documentType, 'AMANAT_RETURN');
  assert.equal(blockedPayload.amount, undefined);
  assert.ok(blockedPayload.error && blockedPayload.error.length > 10);

  const itemAmanat: AmanatRecord = {
    id: 'am-2',
    recordNumber: 'AMN-102',
    type: 'ITEM',
    depositorName: 'خالد أحمد',
    depositorPhone: '773334445',
    amount: 0,
    itemDescription: 'صندوق مجوهرات مقفل',
    itemSerial: 'BOX-99',
    receivedDate: '2026-11-22',
    receivedBy: 'أمير',
    status: 'HELD',
    branchId: 'branch_main',
  };
  const itemPayload = buildAmanatNotificationPayload(itemAmanat);
  assert.equal(itemPayload.documentType, 'AMANAT_RECEIPT');
  assert.equal(itemPayload.amount, undefined);
  assert.ok(itemPayload.itemsSummary?.includes('BOX-99'));
});

test('buildPrintPageCss generates valid @page sizes for A4, 80mm, and 58mm thermal receipts', () => {
  const a4Css = buildPrintPageCss('A4');
  const thermal80Css = buildPrintPageCss('80mm');
  const thermal58Css = buildPrintPageCss('58mm');
  assert.ok(a4Css.includes('A4 portrait'));
  assert.ok(a4Css.includes('counter(page)'));
  assert.ok(thermal80Css.includes('80mm 297mm'));
  assert.ok(thermal58Css.includes('58mm 297mm'));
});

test('buildPartyStatement maintains non-duplication of voucher settlement against invoice paidAmount', () => {
  const party: Party = {
    id: 'cust-1',
    nameAr: 'مؤسسة الوفاء',
    type: 'CUSTOMER',
    phone: '777888999',
    balance: 600,
    advanceBalance: 0,
  };

  const stmt = buildPartyStatement({
    party,
    invoices: [
      {
        id: 'inv-100',
        invoiceNumber: 'SAL-100',
        type: 'SALE',
        date: '2026-11-20',
        branchId: 'branch_main',
        activityId: 'grocery',
        partyId: 'cust-1',
        partyName: 'مؤسسة الوفاء',
        items: [],
        subtotal: 1000,
        discount: 0,
        tax: 0,
        total: 1000,
        paidAmount: 400,
        paymentMethod: 'CREDIT',
        cashBoxId: 'cb-1',
        isPosted: true,
        status: 'POSTED',
      },
    ],
    vouchers: [
      {
        id: 'v-100',
        voucherNumber: 'REC-100',
        type: 'RECEIPT',
        date: '2026-11-21',
        amount: 400,
        appliedToDebtAmount: 400,
        advanceAmount: 0,
        cashBoxId: 'cb-1',
        accountCode: '1103',
        partyId: 'cust-1',
        partyName: 'مؤسسة الوفاء',
        description: 'سداد جزئي',
        costCenterId: 'grocery',
        branchId: 'branch_main',
        createdBy: 'u-1',
        status: 'POSTED',
      },
    ],
    paymentAllocations: [
      {
        id: 'al-100',
        voucherId: 'v-100',
        invoiceId: 'inv-100',
        invoiceNumber: 'SAL-100',
        allocatedAmount: 400,
        allocationMethod: 'FIFO',
        createdAt: '2026-11-21T10:00:00Z',
        partyId: 'cust-1',
        status: 'ACTIVE',
      },
    ],
    partyAdvances: [],
  });

  assert.equal(stmt.periodClosingBalance, 600);
  assert.equal(stmt.transactions.length, 2);
});
