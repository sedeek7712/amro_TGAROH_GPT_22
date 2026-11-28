import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AmanatDocument } from '../components/documents/AmanatDocument';
import { desktopSession } from '../services/desktopSession';
import {
  buildAmanatDocumentSnapshot,
  buildReportDocumentSnapshot,
} from '../services/documents/documentService';
import {
  clearDocumentOperationLogs,
  getDocumentOperationLogs,
} from '../services/documents/notificationLogService';
import {
  copyTextToClipboard,
  executeWhatsAppOrNativeShare,
  prepareSharePackage,
  supportsNativeFileShare,
} from '../services/documents/shareService';
import type { AmanatRecord } from '../types/erp';
import { resolveEnterpriseDocumentMeta } from '../utils/documentBranding';
import {
  buildAmanatNotificationPayload,
  validateAmanatDocumentState,
} from '../utils/documentNotifications';
import { exportDocumentPdf, triggerNativePrint } from '../utils/printDocument';

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

function installMockCanvasDom(options: { thermalHeightPx?: number } = {}) {
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
    querySelector(sel: string) {
      if (
        options.thermalHeightPx &&
        (sel === '.doc-sheet-80mm' || sel === '.doc-sheet-58mm' || sel === '.printable-area')
      ) {
        return {
          getBoundingClientRect() {
            return { height: options.thermalHeightPx };
          },
        };
      }
      return null;
    },
    createElement(tag: string) {
      if (tag === 'style') {
        return { id: '', textContent: '' };
      }
      if (tag === 'a') {
        return { href: '', download: '', rel: '', click() {} };
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
    print() {},
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
      } else {
        delete (globalThis as Record<string, unknown>).navigator;
      }
      (globalThis as Record<string, unknown>).URL = prevUrl;
      (globalThis as Record<string, unknown>).sessionStorage = prevSession;
    },
  };
}

test('DOC-004-01: Browser print timeout without afterprint logs PRINT_STATUS_UNKNOWN (never PRINT_DIALOG_CLOSED or PRINT_SENT)', async () => {
  clearDocumentOperationLogs();
  const snap = buildReportDocumentSnapshot({
    reportKey: 'doc004_01',
    reportTitle: 'اختبار حالة طباعة المتصفح',
    meta: sampleMeta,
    paperSize: 'A4',
    summaryRows: [{ label: 'الإجمالي', value: '100' }],
  });

  const env = installMockCanvasDom();
  try {
    // 1) Timeout when afterprint never fires -> PRINT_STATUS_UNKNOWN
    env.mockWindow.print = () => {
      // browser never dispatches afterprint
    };
    const unknownRes = await triggerNativePrint('A4', {
      snapshot: snap,
      afterPrintTimeoutMs: 20,
    });
    assert.equal(unknownRes.printed, false);
    assert.equal(unknownRes.canceled, false);
    assert.equal(unknownRes.dialogClosed, false);
    assert.equal(unknownRes.statusConfirmed, false);
    assert.equal(unknownRes.outcome, 'browser-unknown');
    assert.ok(unknownRes.message.includes('PRINT_STATUS_UNKNOWN'));

    const unknownLogs = await getDocumentOperationLogs({ operationType: 'PRINT' });
    assert.equal(unknownLogs[0].status, 'PRINT_STATUS_UNKNOWN');
    assert.equal(unknownLogs[1].status, 'PRINT_OPENED');
    assert.ok(!unknownLogs.some((l) => l.status === 'PRINT_DIALOG_CLOSED'));
    assert.ok(!unknownLogs.some((l) => l.status === 'PRINT_SENT'));

    // 2) afterprint fires -> PRINT_DIALOG_CLOSED
    clearDocumentOperationLogs();
    env.mockWindow.print = () => {
      setTimeout(() => env.mockWindow.dispatchEvent('afterprint'), 5);
    };
    const closedRes = await triggerNativePrint('A4', {
      snapshot: snap,
      afterPrintTimeoutMs: 80,
    });
    assert.equal(closedRes.dialogClosed, true);
    assert.equal(closedRes.statusConfirmed, false);
    assert.equal(closedRes.outcome, 'browser-closed');
    const closedLogs = await getDocumentOperationLogs({ operationType: 'PRINT' });
    assert.equal(closedLogs[0].status, 'PRINT_DIALOG_CLOSED');
  } finally {
    env.restore();
  }
});

test('DOC-004-02: Electron triggerNativePrint passes pageSize & contentHeightMm and maps unconfirmed to PRINT_STATUS_UNKNOWN', async () => {
  clearDocumentOperationLogs();
  const snap = buildReportDocumentSnapshot({
    reportKey: 'doc004_02',
    reportTitle: 'اختبار طباعة Electron',
    meta: sampleMeta,
    paperSize: '80mm',
    summaryRows: [{ label: 'الإجمالي', value: '500' }],
  });

  const env = installMockCanvasDom({ thermalHeightPx: 480 });
  try {
    desktopSession.setActorSession('tok-print-402', {
      id: 'u-1',
      username: 'tester',
      fullName: 'فاحص',
      role: 'ADMIN',
      allowedActivities: ['grocery'],
      branchId: 'branch_main',
      active: true,
    });

    const sentInputs: Array<Record<string, unknown>> = [];
    (env.mockWindow as Record<string, unknown>).amroDesktop = {
      async runNativePrint(input: Record<string, unknown>) {
        sentInputs.push(input);
        return { printed: false, canceled: false, outcome: 'unconfirmed' };
      },
    };

    const res = await triggerNativePrint('80mm', { snapshot: snap });
    assert.equal(sentInputs[0].pageSize, '80mm');
    assert.ok(typeof sentInputs[0].contentHeightMm === 'number' && (sentInputs[0].contentHeightMm as number) > 100);
    assert.equal(res.outcome, 'unconfirmed');
    assert.equal(res.statusConfirmed, false);
    assert.equal(res.printed, false);
    assert.ok(res.message.includes('PRINT_STATUS_UNKNOWN'));

    const logs = await getDocumentOperationLogs({ operationType: 'PRINT' });
    assert.equal(logs[0].status, 'PRINT_STATUS_UNKNOWN');
  } finally {
    desktopSession.clear();
    env.restore();
  }
});

test('DOC-004-03: Clipboard failures are never falsified & modal ref fallback exists alongside shareService reveal diagnostics', async () => {
  clearDocumentOperationLogs();
  const prevNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  try {
    // 1) Unavailable clipboard API
    setMockNavigator({});
    const missingClip = await copyTextToClipboard('hello');
    assert.equal(missingClip.copied, false);
    assert.ok(missingClip.error);

    // 2) Rejected clipboard writeText
    setMockNavigator({
      clipboard: {
        async writeText() {
          throw new Error('Clipboard permission denied');
        },
      },
    });
    const rejectedClip = await copyTextToClipboard('hello');
    assert.equal(rejectedClip.copied, false);
    assert.ok(rejectedClip.error?.includes('Clipboard permission denied'));

    // 3) Success clipboard writeText
    let written = '';
    setMockNavigator({
      clipboard: {
        async writeText(val: string) {
          written = val;
        },
      },
    });
    const okClip = await copyTextToClipboard('إشعار رسمي');
    assert.equal(okClip.copied, true);
    assert.equal(written, 'إشعار رسمي');
  } finally {
    if (prevNav) {
      Object.defineProperty(globalThis, 'navigator', prevNav);
    } else {
      delete (globalThis as Record<string, unknown>).navigator;
    }
  }

  // 4) shareService Electron path exposes clipboardCopied:false + tempFileRevealed:false cleanly
  const env = installMockCanvasDom();
  try {
    setMockNavigator({
      onLine: true,
      clipboard: {
        async writeText() {
          throw new Error('NotAllowedError');
        },
      },
    });
    desktopSession.setActorSession('tok-share-403', {
      id: 'u-1',
      username: 'tester',
      fullName: 'فاحص',
      role: 'ADMIN',
      allowedActivities: ['grocery'],
      branchId: 'branch_main',
      active: true,
    });
    (env.mockWindow as Record<string, unknown>).amroDesktop = {
      async prepareShareTempFile(input: { fileName: string; bytesBase64: string }) {
        return {
          tempToken: 'tmp-403',
          fileName: input.fileName,
          sizeBytes: Buffer.from(input.bytesBase64, 'base64').length,
        };
      },
      async revealShareTempFile() {
        return { revealed: false, exists: false, error: 'الملف المؤقت مفقود' };
      },
      async openWhatsAppUrl() {
        return { opened: true };
      },
    };
    const snap = buildReportDocumentSnapshot({
      reportKey: 'share_403',
      reportTitle: 'اختبار مشاركة',
      meta: sampleMeta,
      paperSize: '80mm',
      summaryRows: [{ label: 'المبلغ', value: '100' }],
    });
    const pkg = await prepareSharePackage({
      snapshot: snap,
      preferredFormat: 'PDF',
      messageText: 'نص الإشعار',
      recipientPhone: '771112233',
      recipientName: snap.partyName || 'عميل الاختبار',
    actor: {
      id: 'u-test', username: 'tester', fullName: 'محاسب الاختبار', role: 'ADMIN',
      allowedActivities: ['grocery'], branchId: 'branch_main', active: true,
    },
    });
    const outcome = await executeWhatsAppOrNativeShare({
      snapshot: snap,
      pkg,
      recipientName: snap.partyName || 'عميل الاختبار',
    });
    assert.equal(outcome.clipboardCopied, false);
    assert.ok(outcome.clipboardError?.includes('NotAllowedError'));
    assert.equal(outcome.tempFileRevealed, false);
    assert.ok(outcome.revealError?.includes('مفقود'));
    assert.ok(!outcome.noticeMessage.includes('ونسخ النص'));

    const modalSource = readFileSync(
      path.resolve(process.cwd(), 'src/components/common/CustomerNotificationModal.tsx'),
      'utf8'
    );
    assert.ok(modalSource.includes('messageTextareaRef'));
    assert.ok(modalSource.includes('messageTextareaRef.current?.focus()'));
    assert.ok(modalSource.includes('messageTextareaRef.current?.select()'));
    assert.ok(modalSource.includes('if (!copyRes.copied)'));
  } finally {
    desktopSession.clear();
    env.restore();
  }
});

test('DOC-004-04: All 8 Amanat return validation & SSR rendering cases prevent original-amount fallback and lock DocumentPrintShell', () => {
  const baseHeld: AmanatRecord = {
    id: 'amn-404',
    recordNumber: 'AMN-4004',
    type: 'CASH',
    depositorName: 'علي حسن',
    depositorPhone: '771234567',
    amount: 50000,
    returnedAmount: 0,
    remainingAmount: 50000,
    receivedDate: '2026-11-20',
    receivedBy: 'أمين الصندوق',
    status: 'HELD',
    branchId: 'branch_main',
    returnHistory: [],
  };

  // Case 1: Normal HELD deposit
  assert.equal(validateAmanatDocumentState(baseHeld).valid, true);
  const heldHtml = renderToStaticMarkup(
    React.createElement(AmanatDocument, {
      record: baseHeld,
      meta: sampleMeta,
      paperSize: 'A4',
    })
  );
  assert.ok(heldHtml.includes('50000.00'));
  assert.ok(!heldHtml.includes('role="alert"'));

  // Case 2: Corrupted RETURNED CASH with empty returnHistory
  const corruptEmpty: AmanatRecord = {
    ...baseHeld,
    status: 'RETURNED',
    returnedAmount: 50000,
    remainingAmount: 0,
    returnHistory: [],
  };
  assert.equal(validateAmanatDocumentState(corruptEmpty).valid, false);
  assert.throws(() => buildAmanatDocumentSnapshot({ record: corruptEmpty, meta: sampleMeta }));
  assert.ok(buildAmanatNotificationPayload(corruptEmpty).error);
  const corruptEmptyHtml = renderToStaticMarkup(
    React.createElement(AmanatDocument, {
      record: corruptEmpty,
      meta: sampleMeta,
      paperSize: 'A4',
    })
  );
  assert.ok(corruptEmptyHtml.includes('role="alert"'));
  assert.ok(!corruptEmptyHtml.includes('50000.00'));

  // Case 3: RETURNED CASH with zero-amount return event
  const zeroEvent: AmanatRecord = {
    ...corruptEmpty,
    returnHistory: [
      {
        id: 'ev-zero',
        date: '2026-11-21',
        amount: 0,
        createdByName: 'موظف',
      },
    ],
  };
  assert.equal(validateAmanatDocumentState(zeroEvent).valid, false);
  const zeroHtml = renderToStaticMarkup(
    React.createElement(AmanatDocument, {
      record: zeroEvent,
      meta: sampleMeta,
      paperSize: 'A4',
    })
  );
  assert.ok(zeroHtml.includes('role="alert"'));
  assert.ok(!zeroHtml.includes('50000.00'));

  // Case 4: RETURNED CASH with negative-amount return event
  const negativeEvent: AmanatRecord = {
    ...corruptEmpty,
    returnHistory: [
      {
        id: 'ev-neg',
        date: '2026-11-21',
        amount: -250,
        createdByName: 'موظف',
      },
    ],
  };
  assert.equal(validateAmanatDocumentState(negativeEvent).valid, false);
  const negHtml = renderToStaticMarkup(
    React.createElement(AmanatDocument, {
      record: negativeEvent,
      meta: sampleMeta,
      paperSize: 'A4',
    })
  );
  assert.ok(negHtml.includes('role="alert"'));
  assert.ok(!negHtml.includes('50000.00'));

  // Case 5: Partial return HELD with valid event (20000 -> remaining 30000)
  const partialHeld: AmanatRecord = {
    ...baseHeld,
    status: 'HELD',
    returnedAmount: 20000,
    remainingAmount: 30000,
    returnHistory: [
      {
        id: 'ev-1',
        date: '2026-11-21',
        amount: 20000,
        createdByName: 'موظف',
      },
    ],
  };
  assert.equal(validateAmanatDocumentState(partialHeld).valid, true);
  const partialHtml = renderToStaticMarkup(
    React.createElement(AmanatDocument, {
      record: partialHeld,
      meta: sampleMeta,
      paperSize: 'A4',
    })
  );
  assert.ok(partialHtml.includes('20000.00'));
  assert.ok(partialHtml.includes('30000.00'));
  assert.ok(!partialHtml.includes('role="alert"'));

  // Case 6: Multi-event selection ev-1 vs ev-2 vs nonexistent returnEventId
  const multiReturn: AmanatRecord = {
    ...baseHeld,
    status: 'HELD',
    returnedAmount: 35000,
    remainingAmount: 15000,
    returnHistory: [
      { id: 'ev-1', date: '2026-11-21', amount: 20000, createdByName: 'موظف' },
      { id: 'ev-2', date: '2026-11-22', amount: 15000, createdByName: 'موظف' },
    ],
  };
  const ev1Html = renderToStaticMarkup(
    React.createElement(AmanatDocument, {
      record: multiReturn,
      meta: sampleMeta,
      paperSize: 'A4',
      returnEventId: 'ev-1',
    })
  );
  assert.ok(ev1Html.includes('30000.00'));
  const ev2Html = renderToStaticMarkup(
    React.createElement(AmanatDocument, {
      record: multiReturn,
      meta: sampleMeta,
      paperSize: 'A4',
      returnEventId: 'ev-2',
    })
  );
  assert.ok(ev2Html.includes('15000.00'));
  assert.equal(
    validateAmanatDocumentState(multiReturn, { returnEventId: 'missing-ev' }).valid,
    false
  );
  const missingEvHtml = renderToStaticMarkup(
    React.createElement(AmanatDocument, {
      record: multiReturn,
      meta: sampleMeta,
      paperSize: 'A4',
      returnEventId: 'missing-ev',
    })
  );
  assert.ok(missingEvHtml.includes('role="alert"'));

  // Case 7: Explicit mode: 'DEPOSIT' on returned record remains valid & shows 50000.00
  const depositCheck = validateAmanatDocumentState(multiReturn, { mode: 'DEPOSIT' });
  assert.equal(depositCheck.valid, true);
  assert.equal(depositCheck.isReturnDocument, false);
  const depositHtml = renderToStaticMarkup(
    React.createElement(AmanatDocument, {
      record: multiReturn,
      meta: sampleMeta,
      paperSize: 'A4',
      mode: 'DEPOSIT',
    })
  );
  assert.ok(depositHtml.includes('50000.00'));
  assert.ok(!depositHtml.includes('role="alert"'));

  // Case 8: ITEM custody remains valid even when RETURNED with empty returnHistory
  const itemReturned: AmanatRecord = {
    ...baseHeld,
    id: 'amn-item-404',
    recordNumber: 'AMN-ITEM-1',
    type: 'ITEM',
    amount: 0,
    returnedAmount: 0,
    remainingAmount: 0,
    itemDescription: 'صك عقاري أصلي',
    status: 'RETURNED',
    returnHistory: [],
  };
  assert.equal(validateAmanatDocumentState(itemReturned).valid, true);
  const itemHtml = renderToStaticMarkup(
    React.createElement(AmanatDocument, {
      record: itemReturned,
      meta: sampleMeta,
      paperSize: 'A4',
    })
  );
  assert.ok(!itemHtml.includes('role="alert"'));
  assert.ok(itemHtml.includes('صك عقاري أصلي'));

  // Verify DocumentPrintShell & AmanatReceiptModal wire blockedReason & disabled actions
  const printShellSource = readFileSync(
    path.resolve(process.cwd(), 'src/components/documents/DocumentPrintShell.tsx'),
    'utf8'
  );
  assert.ok(printShellSource.includes('const isBlocked = Boolean(blockedReason);'));
  assert.ok(printShellSource.includes('if (isBusy || isBlocked) return;'));
  assert.ok(printShellSource.includes('disabled={isBlocked}'));
  assert.ok(printShellSource.includes('disabled={isBusy || isBlocked}'));
  assert.ok(printShellSource.includes('role="alert"'));

  const modalSource = readFileSync(
    path.resolve(process.cwd(), 'src/components/common/AmanatReceiptModal.tsx'),
    'utf8'
  );
  assert.ok(modalSource.includes('blockedReason={blockedReason}'));
});

test('DOC-004-05: exportDocumentPdf refuses silent printDialog/printToPDF fallback when snapshot is missing', async () => {
  const env = installMockCanvasDom();
  let browserPrintCalled = false;
  let electronExportCalled = false;
  env.mockWindow.print = () => {
    browserPrintCalled = true;
  };

  try {
    const browserMissing = await exportDocumentPdf({
      title: 'missing-snap',
      pageSize: 'A4',
    });
    assert.equal(browserMissing.status, 'CREATE_FAILED');
    assert.equal(browserPrintCalled, false);

    desktopSession.setActorSession('tok-405', {
      id: 'u-1',
      username: 'tester',
      fullName: 'فاحص',
      role: 'ADMIN',
      allowedActivities: ['grocery'],
      branchId: 'branch_main',
      active: true,
    });
    (env.mockWindow as Record<string, unknown>).amroDesktop = {
      async exportDocumentPdf() {
        electronExportCalled = true;
        return { canceled: false, status: 'SAVED', sizeBytes: 100 };
      },
    };
    const electronMissing = await exportDocumentPdf({
      title: 'missing-snap-electron',
      pageSize: 'A4',
    });
    assert.equal(electronMissing.status, 'CREATE_FAILED');
    assert.equal(electronExportCalled, false);

    const printDocSource = readFileSync(
      path.resolve(process.cwd(), 'src/utils/printDocument.ts'),
      'utf8'
    );
    assert.ok(!printDocSource.includes('fallbackToPrintDialog'));
    const ipcHelperSource = readFileSync(
      path.resolve(process.cwd(), 'electron/document-ipc-helpers.mjs'),
      'utf8'
    );
    assert.ok(!ipcHelperSource.includes('printToPDF'));
  } finally {
    desktopSession.clear();
    env.restore();
  }
});

test('DOC-004-09: Android Web Share API MIME probes, AbortError CANCELED, and NotAllowedError fallback behave accurately', async () => {
  const probedMimes: string[] = [];
  const env = installMockCanvasDom();

  try {
    setMockNavigator({
      onLine: true,
      canShare(data?: { files?: File[] }) {
        if (data?.files?.[0]) {
          probedMimes.push(data.files[0].type);
        }
        return data?.files?.[0]?.type === 'image/png' || data?.files?.[0]?.type === 'application/pdf';
      },
      async share() {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      },
    });

    assert.equal(supportsNativeFileShare('image/png'), true);
    assert.equal(supportsNativeFileShare('application/pdf'), true);
    assert.ok(probedMimes.includes('image/png'));
    assert.ok(probedMimes.includes('application/pdf'));

    const snap = buildReportDocumentSnapshot({
      reportKey: 'android_409',
      reportTitle: 'اختبار أندرويد',
      meta: sampleMeta,
      paperSize: '80mm',
      summaryRows: [{ label: 'الإجمالي', value: '250' }],
    });
    const pkg = await prepareSharePackage({
      snapshot: snap,
      preferredFormat: 'PDF',
      messageText: 'مشاركة',
      recipientPhone: '770001122',
      recipientName: snap.partyName || 'عميل الاختبار',
    actor: {
      id: 'u-test', username: 'tester', fullName: 'محاسب الاختبار', role: 'ADMIN',
      allowedActivities: ['grocery'], branchId: 'branch_main', active: true,
    },
    });
    const abortOutcome = await executeWhatsAppOrNativeShare({
      snapshot: snap,
      pkg,
      recipientName: snap.partyName || 'عميل الاختبار',
    });
    assert.equal(abortOutcome.status, 'CANCELED');

    setMockNavigator({
      onLine: true,
      canShare: () => true,
      clipboard: {
        async writeText() {},
      },
      async share() {
        const err = new Error('Not allowed');
        err.name = 'NotAllowedError';
        throw err;
      },
    });
    const notAllowedOutcome = await executeWhatsAppOrNativeShare({
      snapshot: snap,
      pkg,
      recipientName: snap.partyName || 'عميل الاختبار',
    });
    assert.equal(notAllowedOutcome.status, 'FALLBACK_DOWNLOAD_AND_WA');
    assert.ok(notAllowedOutcome.noticeMessage.includes('NotAllowedError'));
  } finally {
    env.restore();
  }
});

test('DOC-004-05: RETURNED cash Amanat requires all documented return events to equal the original amount', () => {
  const base: AmanatRecord = {
    id: 'amn-full-return-005',
    recordNumber: 'AMN-5005',
    type: 'CASH',
    depositorName: 'محمد علي',
    depositorPhone: '771000555',
    amount: 50000,
    returnedAmount: 50000,
    remainingAmount: 0,
    receivedDate: '2026-11-20',
    returnedDate: '2026-11-22',
    receivedBy: 'أمين الصندوق',
    status: 'RETURNED',
    branchId: 'branch_main',
    returnHistory: [
      { id: 'ev-20', date: '2026-11-21', amount: 20000, createdByName: 'موظف' },
      { id: 'ev-30', date: '2026-11-22', amount: 30000, createdByName: 'موظف' },
    ],
  };

  // Exact complete return: accepted, including a selected earlier event.
  assert.equal(validateAmanatDocumentState(base).valid, true);
  assert.equal(
    validateAmanatDocumentState(base, { returnEventId: 'ev-20' }).valid,
    true
  );

  // Incomplete, excessive, and malformed return totals must not issue a full-discharge voucher.
  const incomplete: AmanatRecord = {
    ...base,
    returnHistory: [base.returnHistory![0], { ...base.returnHistory![1], amount: 15000 }],
  };
  assert.equal(validateAmanatDocumentState(incomplete).valid, false);
  assert.throws(() => buildAmanatDocumentSnapshot({ record: incomplete, meta: sampleMeta }));
  assert.equal(buildAmanatNotificationPayload(incomplete).amount, undefined);
  assert.ok(buildAmanatNotificationPayload(incomplete).error);
  const incompleteHtml = renderToStaticMarkup(
    React.createElement(AmanatDocument, {
      record: incomplete,
      meta: sampleMeta,
      paperSize: 'A4',
    })
  );
  assert.ok(incompleteHtml.includes('role="alert"'));
  assert.ok(!incompleteHtml.includes('50000.00'));

  const excessive: AmanatRecord = {
    ...base,
    returnHistory: [base.returnHistory![0], { ...base.returnHistory![1], amount: 30001 }],
  };
  assert.equal(validateAmanatDocumentState(excessive).valid, false);

  const malformed: AmanatRecord = {
    ...base,
    returnHistory: [base.returnHistory![0], { ...base.returnHistory![1], amount: Number.NaN }],
  };
  assert.equal(validateAmanatDocumentState(malformed).valid, false);

  // Explicit deposit view continues to show the original deposit and is not a return voucher.
  assert.equal(validateAmanatDocumentState(incomplete, { mode: 'DEPOSIT' }).valid, true);
});
