import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AmanatRecord, Invoice, PaymentVoucher, SystemUser } from '../types/erp';
import { resolveEnterpriseDocumentMeta } from '../utils/documentBranding';
import { buildAmanatNotificationPayload } from '../utils/documentNotifications';
import {
  buildAmanatDocumentSnapshot,
  buildCashVoucherDocumentSnapshot,
  buildInvoiceDocumentSnapshot,
  buildReportDocumentSnapshot,
  buildStructuredDocumentFilename,
  validateShareAuthorization,
} from '../services/documents/documentService';
import {
  buildPdfFromRasterPages,
  getPdfPageDimensionsPt,
  isValidPdfBytes,
} from '../services/documents/pdfContainer';
import { computeDocumentCanvasSpec } from '../services/documents/pngDocumentService';
import {
  clearDocumentOperationLogs,
  getDocumentOperationLogs,
  recordDocumentOperation,
  sanitizeLoggedFileName,
} from '../services/documents/notificationLogService';
import {
  buildWhatsAppLaunchUrl,
  formatWhatsAppPhone,
  supportsNativeFileShare,
} from '../services/documents/shareService';
import { getSaveStatusLabel } from '../utils/printDocument';
import { db } from '../db/erpDatabase';
import { dexieDataService } from '../services/dexieDataService';

const sampleMeta = resolveEnterpriseDocumentMeta({
  profile: {
    nameAr: 'مؤسسة عمرو النماري التجارية',
    nameEn: 'Amro Al-Namari Trading Est.',
    address: 'صنعاء - اليمن',
    phone: '777000111',
    currency: 'ريال يمني',
    currencyCode: 'YER',
    currencySymbol: 'ر.ي',
    currencyDecimalPlaces: 2,
  },
  issuerName: 'محاسب النظام',
});

test('DOC-OPS-001: Standardized safe filenames enforce prefix, clean doc number, date, and extension', () => {
  assert.equal(
    buildStructuredDocumentFilename({
      kind: 'RECEIPT_VOUCHER',
      documentNumber: '1025',
      date: '2026-11-23',
      ext: 'pdf',
    }),
    'RECEIPT-1025-2026-11-23.pdf'
  );
  assert.equal(
    buildStructuredDocumentFilename({
      kind: 'AMANAT_RETURN',
      documentNumber: 'AMN/101',
      date: '2026-11-23',
      ext: 'png',
    }),
    'AMANAT-AMN-101-2026-11-23.png'
  );
  assert.equal(
    buildStructuredDocumentFilename({
      kind: 'SALE',
      documentNumber: 'INV:204',
      date: '2026-11-23',
      ext: 'pdf',
    }),
    'SALES-INV-204-2026-11-23.pdf'
  );
  assert.equal(
    sanitizeLoggedFileName('C:\\Users\\Admin\\Desktop\\RECEIPT-1025-2026-11-23.pdf'),
    'RECEIPT-1025-2026-11-23.pdf'
  );
});

test('DOC-OPS-001 (DOC-01): Partial Amanat return calculates exact operation amount and cumulative remainder', () => {
  const depositOnly: AmanatRecord = {
    id: 'amn-1',
    recordNumber: 'AMN-2001',
    type: 'CASH',
    depositorName: 'عبدالله علي',
    depositorPhone: '771112233',
    amount: 50000,
    returnedAmount: 0,
    remainingAmount: 50000,
    receivedDate: '2026-11-20',
    receivedBy: 'الموظف',
    status: 'HELD',
    branchId: 'branch_main',
    returnHistory: [],
  };

  // إيداع أمانة أصلي
  const depPayload = buildAmanatNotificationPayload(depositOnly);
  assert.equal(depPayload.documentType, 'AMANAT_RECEIPT');
  assert.equal(depPayload.amount, 50000);
  assert.equal(depPayload.balanceRemaining, 50000);
  assert.equal(Boolean(depPayload.isPartialReturn), false);

  // رد جزئي أول بقيمة 20,000 من أصل 50,000 -> المتبقي 30,000
  const afterFirstPartial: AmanatRecord = {
    ...depositOnly,
    returnedAmount: 20000,
    remainingAmount: 30000,
    returnHistory: [
      {
        id: 'ev-1',
        date: '2026-11-22',
        amount: 20000,
        createdByName: 'الموظف',
        recipientSignatureName: 'عبدالله علي',
        notes: 'رد جزئي أول',
      },
    ],
  };

  const firstRet = buildAmanatNotificationPayload(afterFirstPartial);
  assert.equal(firstRet.documentType, 'AMANAT_RETURN');
  assert.equal(firstRet.amount, 20000);
  assert.equal(firstRet.balanceRemaining, 30000);
  assert.equal(firstRet.isPartialReturn, true);
  assert.equal(firstRet.error, undefined);

  // رد جزئي ثانٍ بقيمة 15,000 -> المتبقي 15,000، مع إمكانية اختيار حدث محدد من السجل
  const afterSecondPartial: AmanatRecord = {
    ...depositOnly,
    returnedAmount: 35000,
    remainingAmount: 15000,
    returnHistory: [
      ...afterFirstPartial.returnHistory!,
      {
        id: 'ev-2',
        date: '2026-11-23',
        amount: 15000,
        createdByName: 'الموظف',
        recipientSignatureName: 'عبدالله علي',
        notes: 'رد جزئي ثانٍ',
      },
    ],
  };

  const latestRet = buildAmanatNotificationPayload(afterSecondPartial);
  assert.equal(latestRet.amount, 15000);
  assert.equal(latestRet.balanceRemaining, 15000);
  assert.equal(latestRet.returnEventId, 'ev-2');

  const firstEventSelected = buildAmanatNotificationPayload(afterSecondPartial, {
    mode: 'RETURN',
    returnEventId: 'ev-1',
  });
  assert.equal(firstEventSelected.amount, 20000);
  assert.equal(firstEventSelected.balanceRemaining, 30000);

  // التحقق من طلب الإيداع الأصلي حتى مع وجود دفعات رد
  const depositExplicit = buildAmanatNotificationPayload(afterSecondPartial, { mode: 'DEPOSIT' });
  assert.equal(depositExplicit.documentType, 'AMANAT_RECEIPT');
  assert.equal(depositExplicit.amount, 50000);
  assert.equal(depositExplicit.balanceRemaining, 15000);

  // عند غياب سجل عملية الرد: يمنع تخمين المبلغ ويظهر خطأ واضح
  const corruptedPartial: AmanatRecord = {
    ...depositOnly,
    returnedAmount: 20000,
    remainingAmount: 30000,
    returnHistory: [],
  };
  const blocked = buildAmanatNotificationPayload(corruptedPartial, { mode: 'RETURN' });
  assert.equal(blocked.amount, undefined);
  assert.ok(blocked.error && blocked.error.includes('returnHistory'));
});

test('DOC-OPS-002: PNG renderer allows single-page vouchers/receipts and blocks multi-page/long reports', () => {
  const shortVoucher: PaymentVoucher = {
    id: 'v-1',
    voucherNumber: 'RCT-1025',
    type: 'RECEIPT',
    date: '2026-11-23',
    amount: 25000,
    appliedToDebtAmount: 25000,
    advanceAmount: 0,
    cashBoxId: 'cb-1',
    accountCode: '1103',
    partyId: 'p-1',
    partyName: 'عميل التجزئة',
    description: 'تحصيل دفعة',
    costCenterId: 'grocery',
    branchId: 'branch_main',
    createdBy: 'u-1',
    status: 'POSTED',
  };

  const voucherSnap = buildCashVoucherDocumentSnapshot({
    voucher: shortVoucher,
    meta: sampleMeta,
    paperSize: '80mm',
  });
  const shortSpec = computeDocumentCanvasSpec(voucherSnap);
  assert.equal(shortSpec.allowSinglePng, true);
  assert.equal(voucherSnap.recommendedShareFormat, 'PNG');

  const short58Spec = computeDocumentCanvasSpec({ ...voucherSnap, paperSize: '58mm' });
  assert.equal(short58Spec.canvasWidthPx, 460);
  assert.equal(short58Spec.allowSinglePng, true);

  const reportSnap = buildReportDocumentSnapshot({
    reportKey: 'trial_balance',
    reportTitle: 'ميزان المراجعة',
    meta: sampleMeta,
    paperSize: 'A4',
    summaryRows: [{ label: 'الحسابات', value: '50' }],
    table: {
      columns: [{ label: 'الحساب' }, { label: 'مدين' }, { label: 'دائن' }],
      rows: Array.from({ length: 40 }, (_, i) => [`حساب ${i + 1}`, '100', '100']),
    },
  });
  const reportSpec = computeDocumentCanvasSpec(reportSnap);
  assert.equal(reportSpec.allowSinglePng, false);
  assert.ok(reportSpec.rejectionReasonForPng && reportSpec.rejectionReasonForPng.length > 5);
  assert.equal(reportSnap.recommendedShareFormat, 'PDF');
});

test('DOC-OPS-001/002: Offline pure binary PDF container builds valid %PDF-1.4 bytes for A4, 80mm, and 58mm', () => {
  const fakeJpegHeader = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

  for (const size of ['A4', '80mm', '58mm'] as const) {
    const dims = getPdfPageDimensionsPt(size, 1.4);
    const pdfBytes = buildPdfFromRasterPages([
      {
        jpegBytes: fakeJpegHeader,
        pixelWidth: 800,
        pixelHeight: 1120,
        pageWidthPt: dims.widthPt,
        pageHeightPt: dims.heightPt,
      },
      {
        jpegBytes: fakeJpegHeader,
        pixelWidth: 800,
        pixelHeight: 1120,
        pageWidthPt: dims.widthPt,
        pageHeightPt: dims.heightPt,
      },
    ]);
    assert.equal(isValidPdfBytes(pdfBytes), true);
    const ascii = new TextDecoder('latin1').decode(pdfBytes);
    assert.ok(ascii.startsWith('%PDF-1.4'));
    assert.ok(ascii.includes('/Count 2'));
    assert.ok(ascii.includes('%%EOF'));
  }
});

test('DOC-OPS-001: NotificationLogService records valid statuses, strips raw paths, and forbids DELIVERED', async () => {
  clearDocumentOperationLogs();

  await assert.rejects(async () => {
    await recordDocumentOperation({
      operationType: 'SHARE',
      // @ts-expect-error deliberate forbidden status check
      status: 'DELIVERED',
      documentId: 'doc-1',
      documentNumber: '1001',
      documentType: 'RECEIPT_VOUCHER',
    });
  });

  await recordDocumentOperation({
    operationType: 'PDF_EXPORT',
    status: 'SAVED',
    documentId: 'doc-1',
    documentNumber: '1001',
    documentType: 'RECEIPT_VOUCHER',
    fileName: 'C:\\Secret\\Users\\RECEIPT-1001-2026-11-23.pdf',
  });
  await recordDocumentOperation({
    operationType: 'SHARE',
    status: 'SHARE_OPENED',
    documentId: 'doc-1',
    documentNumber: '1001',
    documentType: 'RECEIPT_VOUCHER',
    recipientName: 'أحمد سعيد',
  });

  const logs = getDocumentOperationLogs();
  assert.equal(logs.length, 2);
  assert.equal(logs[0].status, 'SHARE_OPENED');
  assert.equal(logs[1].fileName, 'RECEIPT-1001-2026-11-23.pdf');
  assert.ok(!logs[1].fileName?.includes('C:\\Secret'));
  assert.ok(!logs.some((l) => (l.status as string) === 'DELIVERED'));
});

test('DOC-OPS-001: Share authorization, phone normalization, native share probe, and 7 save states behave strictly', () => {
  assert.equal(formatWhatsAppPhone('0551234567'), '966551234567');
  assert.equal(formatWhatsAppPhone('771234567'), '967771234567');
  assert.ok(buildWhatsAppLaunchUrl('771234567', 'مرحبا').startsWith('https://wa.me/967771234567'));
  assert.equal(supportsNativeFileShare('image/png'), false);

  const cashier: SystemUser = {
    id: 'u-cashier',
    username: 'cashier1',
    fullName: 'أمين صندوق',
    role: 'CASHIER',
    allowedActivities: ['grocery'],
    branchId: 'branch_main',
    active: true,
  };
  const blockedReportShare = validateShareAuthorization({
    actor: cashier,
    documentKind: 'REPORT',
  });
  assert.equal(blockedReportShare.allowed, false);

  const mismatchedParty = validateShareAuthorization({
    actor: cashier,
    documentKind: 'RECEIPT_VOUCHER',
    expectedPartyName: 'عميل أ',
    actualRecipientName: 'عميل ب',
  });
  assert.equal(mismatchedParty.allowed, false);

  for (const st of [
    'PREPARING',
    'SAVING',
    'SAVED',
    'CANCELED',
    'CREATE_FAILED',
    'WRITE_FAILED',
    'PATH_UNREACHABLE',
  ] as const) {
    assert.ok(getSaveStatusLabel(st).length > 0);
  }
});

test('Zero Accounting Impact Invariance: Generating snapshots, notifications, PDFs, and logs does not alter balances or numbers', async () => {
  await db.open();

  const beforeParties = await db.parties.toArray();
  const beforeCashBoxes = await db.cashBoxes.toArray();
  const beforeProducts = await db.products.toArray();
  const beforeAmanat = await db.amanatRecords.toArray();
  const beforeInvoices = await db.invoices.toArray();
  const beforeJournals = await db.journalEntries.toArray();

  const snapBefore = JSON.stringify({
    parties: beforeParties.map((p) => [p.id, p.balance, p.advanceBalance]),
    cashBoxes: beforeCashBoxes.map((b) => [b.id, b.balance]),
    products: beforeProducts.map((pr) => [pr.id, pr.currentStock, pr.purchasePrice]),
    amanat: beforeAmanat.map((a) => [a.id, a.amount, a.returnedAmount, a.remainingAmount, a.recordNumber]),
    invoices: beforeInvoices.map((i) => [i.id, i.invoiceNumber, i.total, i.paidAmount]),
    journals: beforeJournals.map((j) => [j.id, j.entryNumber, j.lines.length]),
  });

  // Execute document preparation flows
  const testInvoice: Invoice = beforeInvoices[0] || {
    id: 'inv-sim',
    invoiceNumber: 'INV-SIM-1',
    type: 'SALE',
    date: '2026-11-23',
    branchId: 'branch_main',
    activityId: 'grocery',
    partyId: beforeParties[0]?.id || 'cust-sim',
    partyName: beforeParties[0]?.nameAr || 'عميل',
    items: [],
    subtotal: 100,
    discount: 0,
    tax: 0,
    total: 100,
    paidAmount: 0,
    paymentMethod: 'CREDIT',
    cashBoxId: beforeCashBoxes[0]?.id || 'cb-1',
    isPosted: true,
    status: 'POSTED',
  };

  buildInvoiceDocumentSnapshot({ invoice: testInvoice, meta: sampleMeta, paperSize: '58mm' });
  await recordDocumentOperation({
    operationType: 'PDF_EXPORT',
    status: 'SAVED',
    documentId: testInvoice.id,
    documentNumber: testInvoice.invoiceNumber,
    documentType: 'INVOICE',
    fileName: 'SALES-INV-SIM-1-2026-11-23.pdf',
  });

  const afterParties = await db.parties.toArray();
  const afterCashBoxes = await db.cashBoxes.toArray();
  const afterProducts = await db.products.toArray();
  const afterAmanat = await db.amanatRecords.toArray();
  const afterInvoices = await db.invoices.toArray();
  const afterJournals = await db.journalEntries.toArray();

  const snapAfter = JSON.stringify({
    parties: afterParties.map((p) => [p.id, p.balance, p.advanceBalance]),
    cashBoxes: afterCashBoxes.map((b) => [b.id, b.balance]),
    products: afterProducts.map((pr) => [pr.id, pr.currentStock, pr.purchasePrice]),
    amanat: afterAmanat.map((a) => [a.id, a.amount, a.returnedAmount, a.remainingAmount, a.recordNumber]),
    invoices: afterInvoices.map((i) => [i.id, i.invoiceNumber, i.total, i.paidAmount]),
    journals: afterJournals.map((j) => [j.id, j.entryNumber, j.lines.length]),
  });

  assert.equal(snapAfter, snapBefore);
});
