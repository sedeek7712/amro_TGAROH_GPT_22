import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
import {
  computeDocumentCanvasSpec,
  isValidPngBytes,
} from '../services/documents/pngDocumentService';
import {
  clearDocumentOperationLogs,
  getDocumentOperationLogs,
  recordDocumentOperation,
  sanitizeLoggedFileName,
} from '../services/documents/notificationLogService';
import {
  buildWhatsAppDesktopProtocolUrl,
  buildWhatsAppLaunchUrl,
  executeWhatsAppOrNativeShare,
  formatWhatsAppPhone,
  prepareSharePackage,
  supportsNativeFileShare,
} from '../services/documents/shareService';
import {
  exportDocumentPdf,
  exportDocumentPng,
  getSaveStatusLabel,
  triggerNativePrint,
} from '../utils/printDocument';
import { desktopSession } from '../services/desktopSession';
import { db } from '../db/erpDatabase';

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

const PNG_MOCK_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0xf3, 0xff, 0x61,
]);

const JPEG_MOCK_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
]);

function setMockNavigator(value: Record<string, unknown>) {
  Object.defineProperty(globalThis, 'navigator', {
    value,
    configurable: true,
    writable: true,
  });
}

function installMockCanvasDom(options: { onDownload?: (fileName: string) => void } = {}) {
  const prevWindow = (globalThis as Record<string, unknown>).window;
  const prevDocument = (globalThis as Record<string, unknown>).document;
  const prevNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const prevUrl = (globalThis as Record<string, unknown>).URL;
  const prevSession = (globalThis as Record<string, unknown>).sessionStorage;

  const store = new Map<string, string>();
  const listeners = new Map<string, Set<() => void>>();

  const mockCtx = {
    direction: 'rtl',
    textBaseline: 'top',
    textAlign: 'right',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '16px Cairo',
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    roundRect() {},
    rect() {},
    clip() {},
    save() {},
    restore() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    closePath() {},
    fill() {},
    stroke() {},
    fillText() {},
    setLineDash() {},
    drawImage() {},
    measureText(text: string) {
      return { width: String(text || '').length * 9 };
    },
  };

  const mockDocument = {
    documentElement: { dataset: {} as Record<string, string> },
    head: { appendChild() {} },
    body: {
      classList: { add() {}, remove() {} },
      appendChild() {},
      removeChild() {},
    },
    getElementById() {
      return null;
    },
    createElement(tag: string) {
      if (tag === 'style') {
        return { id: '', textContent: '' };
      }
      if (tag === 'a') {
        const anchor = {
          href: '',
          download: '',
          rel: '',
          click() {
            options.onDownload?.(anchor.download);
          },
        };
        return anchor;
      }
      if (tag === 'canvas') {
        return {
          width: 1240,
          height: 1754,
          getContext() {
            return mockCtx;
          },
          toBlob(cb: (blob: Blob | null) => void, mime = 'image/png') {
            const bytes = mime === 'image/jpeg' ? JPEG_MOCK_BYTES : PNG_MOCK_BYTES;
            cb(new Blob([bytes], { type: mime }));
          },
        };
      }
      return {};
    },
  };

  const mockWindow = {
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(type: string) {
      listeners.get(type)?.forEach((fn) => fn());
    },
    print() {
      // default browser print stub
    },
    setTimeout,
    clearTimeout,
  };

  (globalThis as Record<string, unknown>).document = mockDocument;
  (globalThis as Record<string, unknown>).window = mockWindow;
  (globalThis as Record<string, unknown>).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
  };
  (globalThis as Record<string, unknown>).URL = {
    createObjectURL: () => 'blob:mock-doc-url',
    revokeObjectURL: () => {},
  };

  return {
    mockWindow,
    restore() {
      (globalThis as Record<string, unknown>).window = prevWindow;
      (globalThis as Record<string, unknown>).document = prevDocument;
      if (prevNavigatorDesc) {
        Object.defineProperty(globalThis, 'navigator', prevNavigatorDesc);
      }
      (globalThis as Record<string, unknown>).URL = prevUrl;
      (globalThis as Record<string, unknown>).sessionStorage = prevSession;
    },
  };
}

test('AMRO-DOC-OPS-003 Fix 1 & 2: Electron PDF passes snapshot pdfBase64 & logs SAVED, while browser PDF/PNG return DOWNLOAD_INITIATED', async () => {
  clearDocumentOperationLogs();
  const sampleVoucher: PaymentVoucher = {
    id: 'v-fix1',
    voucherNumber: 'RCT-3001',
    type: 'RECEIPT',
    date: '2026-11-24',
    amount: 12500,
    appliedToDebtAmount: 12500,
    advanceAmount: 0,
    cashBoxId: 'cb-1',
    accountCode: '1103',
    partyId: 'p-1',
    partyName: 'مؤسسة الفجر',
    description: 'دفعة حساب',
    costCenterId: 'grocery',
    branchId: 'branch_main',
    createdBy: 'u-1',
    status: 'POSTED',
  };
  const voucherSnap = buildCashVoucherDocumentSnapshot({
    voucher: sampleVoucher,
    meta: sampleMeta,
    paperSize: '80mm',
  });

  // 1) Browser PDF & PNG export -> DOWNLOAD_INITIATED (never SAVED)
  const downloaded: string[] = [];
  const env = installMockCanvasDom({ onDownload: (fn) => downloaded.push(fn) });
  try {
    const webPdfRes = await exportDocumentPdf({
      title: voucherSnap.officialFileBaseName,
      pageSize: '80mm',
      snapshot: voucherSnap,
    });
    assert.equal(webPdfRes.status, 'DOWNLOAD_INITIATED');
    assert.equal(webPdfRes.mode, 'WEB_PDF_DOWNLOAD');
    assert.ok(webPdfRes.sizeBytes && webPdfRes.sizeBytes > 32);

    const webPngRes = await exportDocumentPng({ snapshot: voucherSnap });
    assert.equal(webPngRes.status, 'DOWNLOAD_INITIATED');
    assert.equal(webPngRes.mode, 'WEB_PNG_DOWNLOAD');
    assert.equal(isValidPngBytes(PNG_MOCK_BYTES), true);
    assert.equal(downloaded.length, 2);

    const browserLogs = getDocumentOperationLogs({ documentNumber: 'RCT-3001' });
    assert.ok(browserLogs.some((l) => l.status === 'DOWNLOAD_INITIATED'));
    assert.ok(!browserLogs.some((l) => l.status === 'SAVED'));

    // 2) Electron PDF export -> must generate from Snapshot and pass pdfBase64 starting with %PDF-
    clearDocumentOperationLogs();
    desktopSession.setActorSession('desktop-test-token', {
      id: 'u-test',
      username: 'tester',
      fullName: 'محاسب الاختبار',
      role: 'ADMIN',
      allowedActivities: ['grocery'],
      branchId: 'branch_main',
      active: true,
    });
    let capturedPdfBase64 = '';
    (env.mockWindow as Record<string, unknown>).amroDesktop = {
      async exportDocumentPdf(input: { pdfBase64?: string; title?: string; pageSize?: string }) {
        capturedPdfBase64 = input.pdfBase64 || '';
        const decoded = Buffer.from(capturedPdfBase64, 'base64');
        assert.equal(isValidPdfBytes(decoded), true);
        return {
          canceled: false,
          status: 'SAVED',
          path: 'C:\\Exports\\RECEIPT-RCT-3001-2026-11-24.pdf',
          filename: 'RECEIPT-RCT-3001-2026-11-24.pdf',
          sizeBytes: decoded.length,
          source: 'SNAPSHOT_PDF',
        };
      },
    };

    const electronPdfRes = await exportDocumentPdf({
      title: voucherSnap.officialFileBaseName,
      pageSize: '80mm',
      snapshot: voucherSnap,
    });
    assert.ok(capturedPdfBase64.length > 20);
    assert.equal(electronPdfRes.status, 'SAVED');
    assert.equal(electronPdfRes.mode, 'ELECTRON_PDF');
    assert.ok(electronPdfRes.sizeBytes && electronPdfRes.sizeBytes > 32);

    const electronLogs = getDocumentOperationLogs({ documentNumber: 'RCT-3001' });
    assert.equal(electronLogs[0].status, 'SAVED');

    // 3) Multi-page REPORT snapshot exports valid multi-page PDF via Snapshot -> pdfBase64 (while PNG is blocked)
    const reportSnap = buildReportDocumentSnapshot({
      reportKey: 'ledger_multi',
      reportTitle: 'كشف أستاذ متعدد الصفحات',
      meta: sampleMeta,
      paperSize: 'A4',
      summaryRows: [{ label: 'الفرع', value: 'المركز الرئيسي' }],
      table: {
        columns: [{ label: 'البيان' }, { label: 'مدين' }, { label: 'دائن' }],
        rows: Array.from({ length: 42 }, (_, idx) => [`حركة ${idx + 1}`, '150.00', '0.00']),
      },
    });
    assert.equal(computeDocumentCanvasSpec(reportSnap).allowSinglePng, false);
    const reportPdfRes = await exportDocumentPdf({
      title: reportSnap.officialFileBaseName,
      pageSize: 'A4',
      snapshot: reportSnap,
    });
    assert.equal(reportPdfRes.status, 'SAVED');
    assert.ok(Buffer.from(capturedPdfBase64, 'base64').length > 100);
  } finally {
    desktopSession.clear();
    env.restore();
  }
});

test('AMRO-DOC-OPS-003 Fix 3: Browser print waits for afterprint -> PRINT_DIALOG_CLOSED (never PRINT_SENT), while Electron print classifies sent/canceled/failed', async () => {
  clearDocumentOperationLogs();
  const snap = buildReportDocumentSnapshot({
    reportKey: 'trial_balance',
    reportTitle: 'ميزان المراجعة',
    meta: sampleMeta,
    paperSize: 'A4',
    summaryRows: [{ label: 'إجمالي', value: '1000' }],
  });

  const env = installMockCanvasDom();
  try {
    // 1) Browser print path
    env.mockWindow.print = () => {
      env.mockWindow.dispatchEvent('beforeprint');
      setTimeout(() => env.mockWindow.dispatchEvent('afterprint'), 15);
    };
    const browserPrintRes = await triggerNativePrint('A4', {
      snapshot: snap,
      afterPrintTimeoutMs: 50,
    });
    assert.equal(browserPrintRes.printed, false);
    assert.equal(browserPrintRes.dialogClosed, true);
    assert.equal(
      browserPrintRes.message,
      'انتهت نافذة الطباعة. لا يمكن تأكيد خروج الورق من خلال المتصفح.'
    );
    const bLogs = getDocumentOperationLogs({ operationType: 'PRINT' });
    assert.equal(bLogs[0].status, 'PRINT_DIALOG_CLOSED');
    assert.equal(bLogs[1].status, 'PRINT_OPENED');
    assert.ok(!bLogs.some((l) => l.status === 'PRINT_SENT'));

    // 2) Electron print path: sent vs canceled vs failed
    clearDocumentOperationLogs();
    desktopSession.setActorSession('desktop-print-token', {
      id: 'u-test',
      username: 'tester',
      fullName: 'محاسب الاختبار',
      role: 'ADMIN',
      allowedActivities: ['grocery'],
      branchId: 'branch_main',
      active: true,
    });
    (env.mockWindow as Record<string, unknown>).amroDesktop = {
      async runNativePrint() {
        return { printed: true, canceled: false, outcome: 'sent' };
      },
    };
    const sentRes = await triggerNativePrint('80mm', { snapshot: snap });
    assert.equal(sentRes.printed, true);
    assert.equal(sentRes.message, 'تم إرسال مهمة الطباعة إلى الطابعة المحددة.');

    (env.mockWindow as Record<string, unknown>).amroDesktop = {
      async runNativePrint() {
        return { printed: false, canceled: true, outcome: 'canceled', failureReason: 'cancelled' };
      },
    };
    const cancelRes = await triggerNativePrint('80mm', { snapshot: snap });
    assert.equal(cancelRes.canceled, true);
    assert.equal(cancelRes.printed, false);

    (env.mockWindow as Record<string, unknown>).amroDesktop = {
      async runNativePrint() {
        return { printed: false, canceled: false, outcome: 'failed', failureReason: 'No printer' };
      },
    };
    const failRes = await triggerNativePrint('58mm', { snapshot: snap });
    assert.equal(failRes.printed, false);
    assert.equal(failRes.canceled, false);
    assert.equal(failRes.failureReason, 'No printer');
  } finally {
    desktopSession.clear();
    env.restore();
  }
});

test('AMRO-DOC-OPS-003 Fix 4 & 5: Windows Electron online/offline WhatsApp launch + Android NotAllowedError/AbortError handling + 7-day temp retention', async () => {
  clearDocumentOperationLogs();
  const voucherSnap = buildCashVoucherDocumentSnapshot({
    voucher: {
      id: 'v-share-1',
      voucherNumber: 'RCT-4001',
      type: 'RECEIPT',
      date: '2026-11-24',
      amount: 5000,
      appliedToDebtAmount: 5000,
      advanceAmount: 0,
      cashBoxId: 'cb-1',
      accountCode: '1103',
      partyId: 'p-1',
      partyName: 'سعيد محمد',
      description: 'تحصيل',
      costCenterId: 'grocery',
      branchId: 'branch_main',
      createdBy: 'u-1',
      status: 'POSTED',
    },
    meta: sampleMeta,
    paperSize: '80mm',
    partyPhone: '771112233',
  });

  // Verify protocol URL format
  const protoUrl = buildWhatsAppDesktopProtocolUrl('771112233', 'اختبار');
  assert.ok(protoUrl.startsWith('whatsapp://send?phone=967771112233'));

  // Check Electron main.mjs keeps 7-day retention and removes immediate before-quit wipe
  const electronMainSource = readFileSync(path.resolve(process.cwd(), 'electron/main.mjs'), 'utf8');
  assert.ok(electronMainSource.includes('7 * 24 * 60 * 60 * 1000'));
  assert.ok(!electronMainSource.includes('cleanupAllShareTempFiles()'));

  const modalSource = readFileSync(
    path.resolve(process.cwd(), 'src/components/common/CustomerNotificationModal.tsx'),
    'utf8'
  );
  assert.ok(modalSource.includes('حذف الملف المؤقت'));
  assert.ok(!modalSource.includes('activeTempTokenRef.current'));

  const env = installMockCanvasDom();
  try {
    let copiedText = '';
    const launchedUrls: string[] = [];

    setMockNavigator({
      onLine: true,
      clipboard: {
        async writeText(t: string) {
          copiedText = t;
        },
      },
    });
    desktopSession.setActorSession('desktop-share-token', {
      id: 'u-test',
      username: 'tester',
      fullName: 'محاسب الاختبار',
      role: 'ADMIN',
      allowedActivities: ['grocery'],
      branchId: 'branch_main',
      active: true,
    });
    (env.mockWindow as Record<string, unknown>).amroDesktop = {
      async prepareShareTempFile(input: { fileName: string; bytesBase64: string }) {
        return {
          tempToken: 'tmp-tok-1',
          fileName: input.fileName,
          sizeBytes: Buffer.from(input.bytesBase64, 'base64').length,
        };
      },
      async revealShareTempFile() {
        return { revealed: true };
      },
      async openWhatsAppUrl(input: { url: string }) {
        launchedUrls.push(input.url);
        return { opened: true };
      },
    };

    // Online Electron -> uses https://wa.me/... & records WHATSAPP_LAUNCHED
    const onlinePkg = await prepareSharePackage({
      snapshot: voucherSnap,
      preferredFormat: 'PNG',
      messageText: 'سند رقم RCT-4001',
      recipientPhone: '771112233',
      recipientName: 'سعيد محمد',
    });
    assert.equal(onlinePkg.tempToken, 'tmp-tok-1');
    const onlineOutcome = await executeWhatsAppOrNativeShare({
      snapshot: voucherSnap,
      pkg: onlinePkg,
      recipientName: 'سعيد محمد',
    });
    assert.equal(onlineOutcome.status, 'WHATSAPP_LAUNCHED');
    assert.ok(launchedUrls[0].startsWith('https://wa.me/'));
    assert.equal(copiedText, 'سند رقم RCT-4001');

    // Offline Electron -> uses whatsapp:// ONLY, handles open failure gracefully
    setMockNavigator({
      onLine: false,
      clipboard: { async writeText() {} },
    });
    (env.mockWindow as Record<string, unknown>).amroDesktop = {
      async prepareShareTempFile(input: { fileName: string; bytesBase64: string }) {
        return {
          tempToken: 'tmp-tok-2',
          fileName: input.fileName,
          sizeBytes: Buffer.from(input.bytesBase64, 'base64').length,
        };
      },
      async revealShareTempFile() {
        return { revealed: true };
      },
      async openWhatsAppUrl(input: { url: string }) {
        launchedUrls.push(input.url);
        return { opened: false, error: 'Protocol whatsapp:// not registered' };
      },
    };
    const offlinePkg = await prepareSharePackage({
      snapshot: voucherSnap,
      preferredFormat: 'PNG',
      messageText: 'رسالة أوفلاين',
      recipientPhone: '771112233',
      recipientName: 'سعيد محمد',
    });
    assert.equal(offlinePkg.isOffline, true);
    const offlineOutcome = await executeWhatsAppOrNativeShare({
      snapshot: voucherSnap,
      pkg: offlinePkg,
      recipientName: 'سعيد محمد',
    });
    assert.ok(launchedUrls[1].startsWith('whatsapp://'));
    assert.equal(offlineOutcome.status, 'FALLBACK_DOWNLOAD_AND_WA');
    assert.equal(offlineOutcome.whatsappLaunched, false);
    assert.ok(offlineOutcome.noticeMessage.includes('7 أيام'));

    // Mobile/Android Web Share -> AbortError -> CANCELED; NotAllowedError -> clean fallback
    delete (env.mockWindow as Record<string, unknown>).amroDesktop;
    setMockNavigator({
      onLine: true,
      clipboard: { async writeText() {} },
      canShare: () => true,
      async share() {
        const err = new Error('User cancelled');
        err.name = 'AbortError';
        throw err;
      },
    });
    const mobilePkg = await prepareSharePackage({
      snapshot: voucherSnap,
      preferredFormat: 'PNG',
      messageText: 'مشاركة أندرويد',
      recipientPhone: '771112233',
      recipientName: 'سعيد محمد',
    });
    const abortOutcome = await executeWhatsAppOrNativeShare({
      snapshot: voucherSnap,
      pkg: mobilePkg,
      recipientName: 'سعيد محمد',
    });
    assert.equal(abortOutcome.status, 'CANCELED');

    setMockNavigator({
      onLine: true,
      clipboard: { async writeText() {} },
      canShare: () => true,
      async share() {
        const err = new Error('Permission denied');
        err.name = 'NotAllowedError';
        throw err;
      },
    });
    const notAllowedOutcome = await executeWhatsAppOrNativeShare({
      snapshot: voucherSnap,
      pkg: mobilePkg,
      recipientName: 'سعيد محمد',
    });
    assert.equal(notAllowedOutcome.status, 'FALLBACK_DOWNLOAD_AND_WA');
    assert.ok(notAllowedOutcome.noticeMessage.includes('NotAllowedError'));

    const allShareLogs = getDocumentOperationLogs({ operationType: 'SHARE' });
    assert.ok(allShareLogs.some((l) => l.status === 'WHATSAPP_LAUNCHED'));
    assert.ok(allShareLogs.some((l) => l.status === 'CANCELED'));
    assert.ok(!allShareLogs.some((l) => (l.status as string) === 'DELIVERED'));
  } finally {
    desktopSession.clear();
    env.restore();
  }
});

test('AMRO-DOC-OPS-003 Fix 6 (DOC-01): buildAmanatDocumentSnapshot blocks nonexistent returnEventId & empty returnHistory without fallback, and matches event cumulative balances', () => {
  const rec: AmanatRecord = {
    id: 'amn-doc-01',
    recordNumber: 'AMN-9001',
    type: 'CASH',
    depositorName: 'فهد سالم',
    depositorPhone: '770001122',
    amount: 50000,
    returnedAmount: 35000,
    remainingAmount: 15000,
    receivedDate: '2026-11-20',
    receivedBy: 'الموظف',
    status: 'HELD',
    branchId: 'branch_main',
    returnHistory: [
      {
        id: 'ev-1',
        date: '2026-11-21',
        amount: 20000,
        createdByName: 'الموظف',
        recipientSignatureName: 'فهد سالم',
      },
      {
        id: 'ev-2',
        date: '2026-11-22',
        amount: 15000,
        createdByName: 'الموظف',
        recipientSignatureName: 'فهد سالم',
      },
    ],
  };

  // Selecting Event 1 from multi-return record must reflect Event 1 cumulative (20,000) and remaining (30,000)
  const ev1Snap = buildAmanatDocumentSnapshot({
    record: rec,
    meta: sampleMeta,
    returnEvent: rec.returnHistory![0],
  });
  assert.equal(ev1Snap.documentKind, 'AMANAT_RETURN');
  assert.equal(ev1Snap.amount, 20000);
  assert.equal(ev1Snap.remainingBalance, 30000);

  // Nonexistent returnEventId MUST throw rather than falling back to ev-2 or 50,000
  assert.throws(() => {
    buildAmanatDocumentSnapshot({
      record: rec,
      meta: sampleMeta,
      returnEventId: 'missing-event',
    });
  });

  // Corrupted RETURNED cash record with empty returnHistory MUST throw instead of displaying 50,000 as return
  const corruptedReturned: AmanatRecord = {
    ...rec,
    status: 'RETURNED',
    returnedAmount: 50000,
    remainingAmount: 0,
    returnHistory: [],
  };
  assert.throws(() => {
    buildAmanatDocumentSnapshot({
      record: corruptedReturned,
      meta: sampleMeta,
      mode: 'RETURN',
    });
  });

  const corruptedPayload = buildAmanatNotificationPayload(corruptedReturned);
  assert.equal(corruptedPayload.amount, undefined);
  assert.ok(corruptedPayload.error && corruptedPayload.error.length > 10);

  assert.equal(getSaveStatusLabel('DOWNLOAD_INITIATED'), 'بدأ تنزيل الملف من المتصفح');
});
