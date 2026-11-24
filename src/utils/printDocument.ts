/**
 * محرك التحكم في مقاسات الطباعة (A4 / 80mm / 58mm)،
 * وحفظ PDF و PNG مع حالات التحقق السبعة الصريحة عبر المتصفح أو Electron
 */

import { desktopSession } from '../services/desktopSession';
import {
  buildStructuredDocumentFilename,
  type DocumentSnapshot,
  type SupportedDocumentPaperSize,
} from '../services/documents/documentService';
import { recordDocumentOperation } from '../services/documents/notificationLogService';
import { isValidPdfBytes } from '../services/documents/pdfContainer';
import {
  isValidPngBytes,
  renderDocumentToPdfBlob,
  renderDocumentToPngBlob,
} from '../services/documents/pngDocumentService';
import { triggerBrowserFileDownload } from '../services/documents/shareService';

export type DocumentPaperSize = SupportedDocumentPaperSize;

export type SaveDocumentStatus =
  | 'IDLE'
  | 'PREPARING'
  | 'SAVING'
  | 'SAVED'
  | 'DOWNLOAD_INITIATED'
  | 'CANCELED'
  | 'CREATE_FAILED'
  | 'WRITE_FAILED'
  | 'PATH_UNREACHABLE';

export interface SaveDocumentResult {
  status: SaveDocumentStatus;
  mode: 'ELECTRON_PDF' | 'ELECTRON_PNG' | 'WEB_PDF_DOWNLOAD' | 'WEB_PNG_DOWNLOAD' | 'WEB_PRINT';
  canceled: boolean;
  fileName: string;
  path?: string;
  sizeBytes?: number;
  message: string;
}

export interface PrintExecutionResult {
  printed: boolean;
  canceled: boolean;
  dialogClosed?: boolean;
  statusConfirmed?: boolean;
  outcome?:
    | 'sent'
    | 'canceled'
    | 'failed'
    | 'unconfirmed'
    | 'window-unavailable'
    | 'browser-closed'
    | 'browser-unknown';
  message: string;
  failureReason?: string;
}

const DYNAMIC_STYLE_ELEMENT_ID = 'erp-dynamic-print-page';

export function buildPrintPageCss(pageSize: DocumentPaperSize): string {
  if (pageSize === '58mm') {
    return `@page { size: 58mm 297mm; margin: 1.5mm; }`;
  }
  if (pageSize === '80mm') {
    return `@page { size: 80mm 297mm; margin: 2.5mm; }`;
  }
  return `@page {
    size: A4 portrait;
    margin: 10mm 11mm 14mm 11mm;
    @bottom-center {
      content: "صفحة " counter(page) " من " counter(pages);
      font-family: "Cairo", "Noto Sans Arabic", "Segoe UI", sans-serif;
      font-size: 8.5pt;
      color: #64748b;
    }
  }`;
}

export function applyPrintPageStyle(pageSize: DocumentPaperSize): void {
  if (typeof document === 'undefined') return;
  let styleEl = document.getElementById(DYNAMIC_STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = DYNAMIC_STYLE_ELEMENT_ID;
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = buildPrintPageCss(pageSize);
  document.documentElement.dataset.printSize = pageSize;
}

export function getSaveStatusLabel(status: SaveDocumentStatus): string {
  switch (status) {
    case 'PREPARING':
      return 'جاري التجهيز...';
    case 'SAVING':
      return 'جاري الحفظ والتحقق...';
    case 'SAVED':
      return 'تم الحفظ بنجاح';
    case 'DOWNLOAD_INITIATED':
      return 'بدأ تنزيل الملف من المتصفح';
    case 'CANCELED':
      return 'ألغى المستخدم الحفظ';
    case 'CREATE_FAILED':
      return 'فشل إنشاء الملف';
    case 'WRITE_FAILED':
      return 'فشل كتابة الملف';
    case 'PATH_UNREACHABLE':
      return 'المسار غير متاح';
    default:
      return '';
  }
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function schedulePrintFrame(cb: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(cb);
  } else {
    setTimeout(cb, 0);
  }
}

function estimatePrintContentHeightMm(pageSize: DocumentPaperSize): number | undefined {
  if (pageSize === 'A4') return undefined;
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
    return undefined;
  }
  const selector =
    pageSize === '58mm'
      ? '.doc-sheet-58mm'
      : pageSize === '80mm'
      ? '.doc-sheet-80mm'
      : '.printable-area';
  const el = document.querySelector(selector) || document.querySelector('.printable-area');
  if (!el || typeof el.getBoundingClientRect !== 'function') {
    return undefined;
  }
  const rect = el.getBoundingClientRect();
  if (!rect || !Number.isFinite(rect.height) || rect.height <= 0) {
    return undefined;
  }
  return Math.ceil(rect.height * (25.4 / 96));
}

export async function triggerNativePrint(
  pageSize: DocumentPaperSize,
  options?: {
    snapshot?: DocumentSnapshot;
    userId?: string;
    userName?: string;
    afterPrintTimeoutMs?: number;
  }
): Promise<PrintExecutionResult> {
  applyPrintPageStyle(pageSize);
  const snap = options?.snapshot;

  if (snap) {
    await recordDocumentOperation({
      operationType: 'PRINT',
      status: 'PRINT_OPENED',
      documentId: snap.documentId,
      documentNumber: snap.documentNumber,
      documentType: snap.documentKind,
      userId: options?.userId,
      userName: options?.userName || snap.meta.issuerName,
      branchId: snap.meta.branchName,
      activityName: snap.meta.activityName,
      channel: 'NATIVE_PRINT',
    });
  }

  if (typeof window === 'undefined') {
    return {
      printed: false,
      canceled: false,
      statusConfirmed: false,
      outcome: 'window-unavailable',
      message: 'بيئة العرض غير متاحة للطباعة.',
    };
  }

  if (window.amroDesktop?.runNativePrint) {
    try {
      const token = desktopSession.requireToken();
      await new Promise((r) => schedulePrintFrame(() => setTimeout(r, 40)));
      const contentHeightMm = estimatePrintContentHeightMm(pageSize);
      const res = await window.amroDesktop.runNativePrint({
        token,
        pageSize,
        ...(contentHeightMm ? { contentHeightMm } : {}),
      });
      const isUnconfirmed =
        res.outcome === 'unconfirmed' || (!res.canceled && !res.printed && !res.failureReason);
      if (snap) {
        await recordDocumentOperation({
          operationType: 'PRINT',
          status: res.canceled
            ? 'CANCELED'
            : res.printed
            ? 'PRINT_SENT'
            : isUnconfirmed
            ? 'PRINT_STATUS_UNKNOWN'
            : 'FAILED',
          documentId: snap.documentId,
          documentNumber: snap.documentNumber,
          documentType: snap.documentKind,
          userId: options?.userId,
          userName: options?.userName || snap.meta.issuerName,
          failureReason: res.failureReason,
          channel: 'NATIVE_PRINT',
        });
      }
      if (res.canceled) {
        return {
          printed: false,
          canceled: true,
          statusConfirmed: true,
          outcome: 'canceled',
          message: 'ألغى المستخدم نافذة الطباعة.',
        };
      }
      if (res.printed) {
        return {
          printed: true,
          canceled: false,
          statusConfirmed: true,
          outcome: 'sent',
          message: 'تم إرسال مهمة الطباعة إلى الطابعة المحددة.',
        };
      }
      if (isUnconfirmed) {
        return {
          printed: false,
          canceled: false,
          dialogClosed: false,
          statusConfirmed: false,
          outcome: 'unconfirmed',
          failureReason: res.failureReason,
          message:
            res.failureReason ||
            'انتهى أمر الطباعة دون تأكيد من نظام الطباعة (PRINT_STATUS_UNKNOWN)؛ تعذر التحقق من الإرسال أو الإلغاء.',
        };
      }
      return {
        printed: false,
        canceled: false,
        statusConfirmed: res.outcome !== 'window-unavailable',
        outcome: res.outcome || 'failed',
        failureReason: res.failureReason,
        message: res.failureReason
          ? `تعذر إرسال الطباعة: ${res.failureReason}`
          : 'تعذر إتمام أمر الطباعة.',
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'فشل تنفيذ الطباعة.';
      if (snap) {
        await recordDocumentOperation({
          operationType: 'PRINT',
          status: 'FAILED',
          documentId: snap.documentId,
          documentNumber: snap.documentNumber,
          documentType: snap.documentKind,
          userId: options?.userId,
          userName: options?.userName || snap.meta.issuerName,
          failureReason: reason,
          channel: 'NATIVE_PRINT',
        });
      }
      return {
        printed: false,
        canceled: false,
        statusConfirmed: false,
        outcome: 'failed',
        failureReason: reason,
        message: reason,
      };
    }
  }

  const afterPrintTimeoutMs = options?.afterPrintTimeoutMs ?? 300;
  let beforePrintFired = false;
  let afterPrintFired = false;
  let settled = false;

  await new Promise<void>((resolve) => {
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    const onBeforePrint = () => {
      beforePrintFired = true;
    };
    const onAfterPrint = () => {
      afterPrintFired = true;
      finish();
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      window.removeEventListener?.('beforeprint', onBeforePrint);
      window.removeEventListener?.('afterprint', onAfterPrint);
      resolve();
    };

    window.addEventListener?.('beforeprint', onBeforePrint);
    window.addEventListener?.('afterprint', onAfterPrint);

    schedulePrintFrame(() => {
      setTimeout(() => {
        try {
          window.print();
        } finally {
          if (afterPrintFired) {
            finish();
          } else {
            const waitMs = beforePrintFired
              ? Math.max(afterPrintTimeoutMs, 1200)
              : afterPrintTimeoutMs;
            fallbackTimer = setTimeout(finish, waitMs);
          }
        }
      }, 40);
    });
  });

  if (afterPrintFired) {
    if (snap) {
      await recordDocumentOperation({
        operationType: 'PRINT',
        status: 'PRINT_DIALOG_CLOSED',
        documentId: snap.documentId,
        documentNumber: snap.documentNumber,
        documentType: snap.documentKind,
        userId: options?.userId,
        userName: options?.userName || snap.meta.issuerName,
        channel: 'NATIVE_PRINT',
      });
    }

    return {
      printed: false,
      canceled: false,
      dialogClosed: true,
      statusConfirmed: false,
      outcome: 'browser-closed',
      message: 'انتهت نافذة الطباعة. لا يمكن تأكيد خروج الورق من خلال المتصفح.',
    };
  }

  if (snap) {
    await recordDocumentOperation({
      operationType: 'PRINT',
      status: 'PRINT_STATUS_UNKNOWN',
      documentId: snap.documentId,
      documentNumber: snap.documentNumber,
      documentType: snap.documentKind,
      userId: options?.userId,
      userName: options?.userName || snap.meta.issuerName,
      failureReason: 'لم يطلق المتصفح حدث afterprint قبل انتهاء المهلة.',
      channel: 'NATIVE_PRINT',
    });
  }

  return {
    printed: false,
    canceled: false,
    dialogClosed: false,
    statusConfirmed: false,
    outcome: 'browser-unknown',
    failureReason: 'لم يُطلق حدث afterprint قبل انتهاء المهلة.',
    message:
      'انتهت مهلة انتظار إغلاق نافذة الطباعة دون تأكيد من المتصفح (PRINT_STATUS_UNKNOWN)؛ تعذر التحقق مما إذا كانت الطباعة قد أُرسلت أم أُلغيت.',
  };
}

export async function exportDocumentPdf(options: {
  title: string;
  pageSize: DocumentPaperSize;
  snapshot?: DocumentSnapshot;
  userId?: string;
  userName?: string;
  onStatusChange?: (status: SaveDocumentStatus) => void;
}): Promise<SaveDocumentResult> {
  const { title, pageSize, snapshot, userId, userName, onStatusChange } = options;

  applyPrintPageStyle(pageSize);
  onStatusChange?.('PREPARING');

  const safeBaseName =
    snapshot?.officialFileBaseName ||
    String(title || 'document')
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\.pdf$/i, '')
      .slice(0, 96) ||
    'document';
  const targetFileName = snapshot
    ? buildStructuredDocumentFilename({
        kind: snapshot.documentKind,
        documentNumber: snapshot.documentNumber,
        date: snapshot.date,
        ext: 'pdf',
      })
    : `${safeBaseName}.pdf`;

  if (snapshot) {
    await recordDocumentOperation({
      operationType: 'PDF_EXPORT',
      status: 'PREPARED',
      documentId: snapshot.documentId,
      documentNumber: snapshot.documentNumber,
      documentType: snapshot.documentKind,
      userId,
      userName: userName || snapshot.meta.issuerName,
      fileName: targetFileName,
      channel:
        typeof window !== 'undefined' && window.amroDesktop?.exportDocumentPdf
          ? 'ELECTRON_DIALOG'
          : 'BROWSER_DOWNLOAD',
    });
  }

  if (!snapshot) {
    onStatusChange?.('CREATE_FAILED');
    return {
      status: 'CREATE_FAILED',
      mode:
        typeof window !== 'undefined' && window.amroDesktop?.exportDocumentPdf
          ? 'ELECTRON_PDF'
          : 'WEB_PDF_DOWNLOAD',
      canceled: false,
      fileName: targetFileName,
      message:
        'تعذر إنشاء ملف PDF لعدم توفر بيانات المستند المعتمدة (DocumentSnapshot)؛ تم إيقاف التراجع الصامت.',
    };
  }

  if (typeof window !== 'undefined' && window.amroDesktop?.exportDocumentPdf) {
    try {
      const rendered = await renderDocumentToPdfBlob(snapshot);
      if (!isValidPdfBytes(rendered.bytes) || rendered.blob.size <= 0) {
        onStatusChange?.('CREATE_FAILED');
        await recordDocumentOperation({
          operationType: 'PDF_EXPORT',
          status: 'FAILED',
          documentId: snapshot.documentId,
          documentNumber: snapshot.documentNumber,
          documentType: snapshot.documentKind,
          userId,
          userName: userName || snapshot.meta.issuerName,
          fileName: rendered.fileName,
          failureReason: 'فشل توليد ملف PDF صالح (%PDF-) من Snapshot.',
          channel: 'ELECTRON_DIALOG',
        });
        return {
          status: 'CREATE_FAILED',
          mode: 'ELECTRON_PDF',
          canceled: false,
          fileName: rendered.fileName,
          message: 'فشل إنشاء ملف PDF صالح (%PDF-).',
        };
      }
      const pdfBase64 = uint8ToBase64(rendered.bytes);

      onStatusChange?.('SAVING');
      const token = desktopSession.requireToken();
      const res = await window.amroDesktop.exportDocumentPdf({
        token,
        title: safeBaseName,
        pageSize,
        pdfBase64,
      });

      const resolvedStatus: SaveDocumentStatus = res.canceled
        ? 'CANCELED'
        : res.status || 'SAVED';
      onStatusChange?.(resolvedStatus);

      if (snapshot) {
        await recordDocumentOperation({
          operationType: 'PDF_EXPORT',
          status:
            resolvedStatus === 'SAVED'
              ? 'SAVED'
              : resolvedStatus === 'CANCELED'
              ? 'CANCELED'
              : 'FAILED',
          documentId: snapshot.documentId,
          documentNumber: snapshot.documentNumber,
          documentType: snapshot.documentKind,
          userId,
          userName: userName || snapshot.meta.issuerName,
          fileName: res.filename || targetFileName,
          failureReason: res.error,
          channel: 'ELECTRON_DIALOG',
        });
      }

      if (res.canceled) {
        return {
          status: 'CANCELED',
          mode: 'ELECTRON_PDF',
          canceled: true,
          fileName: targetFileName,
          message: 'ألغى المستخدم حفظ ملف PDF.',
        };
      }

      if (resolvedStatus !== 'SAVED' || !res.sizeBytes || res.sizeBytes <= 0) {
        return {
          status: resolvedStatus === 'SAVED' ? 'WRITE_FAILED' : resolvedStatus,
          mode: 'ELECTRON_PDF',
          canceled: false,
          fileName: res.filename || targetFileName,
          message: res.error || 'لم يثبت حفظ ملف PDF بحجم صالح.',
        };
      }

      return {
        status: 'SAVED',
        mode: 'ELECTRON_PDF',
        canceled: false,
        fileName: res.filename || targetFileName,
        path: res.path,
        sizeBytes: res.sizeBytes,
        message: `تم حفظ ملف PDF والتحقق منه على القرص (${res.filename || targetFileName}).`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'فشل إنشاء ملف PDF.';
      onStatusChange?.('CREATE_FAILED');
      if (snapshot) {
        await recordDocumentOperation({
          operationType: 'PDF_EXPORT',
          status: 'FAILED',
          documentId: snapshot.documentId,
          documentNumber: snapshot.documentNumber,
          documentType: snapshot.documentKind,
          userId,
          userName: userName || snapshot.meta.issuerName,
          fileName: targetFileName,
          failureReason: msg,
          channel: 'ELECTRON_DIALOG',
        });
      }
      return {
        status: 'CREATE_FAILED',
        mode: 'ELECTRON_PDF',
        canceled: false,
        fileName: targetFileName,
        message: msg,
      };
    }
  }

  // مسار المتصفح / PWA: توليد ملف PDF ثنائي حقيقي محلياً دون إنترنت من Snapshot
  try {
    const rendered = await renderDocumentToPdfBlob(snapshot);
    if (!isValidPdfBytes(rendered.bytes) || rendered.blob.size <= 0) {
      onStatusChange?.('CREATE_FAILED');
      return {
        status: 'CREATE_FAILED',
        mode: 'WEB_PDF_DOWNLOAD',
        canceled: false,
        fileName: rendered.fileName,
        message: 'فشل إنشاء ملف PDF صالح (%PDF-).',
      };
    }

    onStatusChange?.('SAVING');
    triggerBrowserFileDownload(rendered.blob, rendered.fileName);
    onStatusChange?.('DOWNLOAD_INITIATED');

    await recordDocumentOperation({
      operationType: 'PDF_EXPORT',
      status: 'DOWNLOAD_INITIATED',
      documentId: snapshot.documentId,
      documentNumber: snapshot.documentNumber,
      documentType: snapshot.documentKind,
      userId,
      userName: userName || snapshot.meta.issuerName,
      fileName: rendered.fileName,
      channel: 'BROWSER_DOWNLOAD',
    });

    return {
      status: 'DOWNLOAD_INITIATED',
      mode: 'WEB_PDF_DOWNLOAD',
      canceled: false,
      fileName: rendered.fileName,
      sizeBytes: rendered.blob.size,
      message: `بدأ تنزيل الملف من المتصفح (${rendered.fileName}) بعدد ${rendered.pageCount} صفحة.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'تعذر توليد ملف PDF في المتصفح.';
    onStatusChange?.('CREATE_FAILED');
    await recordDocumentOperation({
      operationType: 'PDF_EXPORT',
      status: 'FAILED',
      documentId: snapshot.documentId,
      documentNumber: snapshot.documentNumber,
      documentType: snapshot.documentKind,
      userId,
      userName: userName || snapshot.meta.issuerName,
      fileName: targetFileName,
      failureReason: msg,
      channel: 'BROWSER_DOWNLOAD',
    });
    return {
      status: 'CREATE_FAILED',
      mode: 'WEB_PDF_DOWNLOAD',
      canceled: false,
      fileName: targetFileName,
      message: msg,
    };
  }
}

export async function exportDocumentPng(options: {
  snapshot: DocumentSnapshot;
  userId?: string;
  userName?: string;
  onStatusChange?: (status: SaveDocumentStatus) => void;
}): Promise<SaveDocumentResult> {
  const { snapshot, userId, userName, onStatusChange } = options;
  onStatusChange?.('PREPARING');

  const expectedFileName = buildStructuredDocumentFilename({
    kind: snapshot.documentKind,
    documentNumber: snapshot.documentNumber,
    date: snapshot.date,
    ext: 'png',
  });

  try {
    const rendered = await renderDocumentToPngBlob(snapshot);
    if (!isValidPngBytes(rendered.bytes) || rendered.blob.size <= 0) {
      onStatusChange?.('CREATE_FAILED');
      return {
        status: 'CREATE_FAILED',
        mode: 'WEB_PNG_DOWNLOAD',
        canceled: false,
        fileName: expectedFileName,
        message: 'فشل إنشاء صورة PNG صالحة.',
      };
    }

    onStatusChange?.('SAVING');

    if (typeof window !== 'undefined' && window.amroDesktop?.exportDocumentPng) {
      const token = desktopSession.requireToken();
      const res = await window.amroDesktop.exportDocumentPng({
        token,
        title: rendered.fileName.replace(/\.png$/i, ''),
        bytesBase64: uint8ToBase64(rendered.bytes),
      });
      const resolvedStatus: SaveDocumentStatus = res.canceled
        ? 'CANCELED'
        : res.status || 'SAVED';
      onStatusChange?.(resolvedStatus);

      await recordDocumentOperation({
        operationType: 'PNG_EXPORT',
        status:
          resolvedStatus === 'SAVED'
            ? 'SAVED'
            : resolvedStatus === 'CANCELED'
            ? 'CANCELED'
            : 'FAILED',
        documentId: snapshot.documentId,
        documentNumber: snapshot.documentNumber,
        documentType: snapshot.documentKind,
        userId,
        userName: userName || snapshot.meta.issuerName,
        fileName: res.filename || rendered.fileName,
        failureReason: res.error,
        channel: 'ELECTRON_DIALOG',
      });

      if (res.canceled) {
        return {
          status: 'CANCELED',
          mode: 'ELECTRON_PNG',
          canceled: true,
          fileName: rendered.fileName,
          message: 'ألغى المستخدم حفظ صورة PNG.',
        };
      }
      if (resolvedStatus !== 'SAVED' || !res.sizeBytes) {
        return {
          status: resolvedStatus,
          mode: 'ELECTRON_PNG',
          canceled: false,
          fileName: res.filename || rendered.fileName,
          message: res.error || 'لم يتم حفظ صورة PNG.',
        };
      }
      return {
        status: 'SAVED',
        mode: 'ELECTRON_PNG',
        canceled: false,
        fileName: res.filename || rendered.fileName,
        path: res.path,
        sizeBytes: res.sizeBytes,
        message: `تم حفظ صورة المستند PNG (${res.filename || rendered.fileName}).`,
      };
    }

    triggerBrowserFileDownload(rendered.blob, rendered.fileName);
    onStatusChange?.('DOWNLOAD_INITIATED');

    await recordDocumentOperation({
      operationType: 'PNG_EXPORT',
      status: 'DOWNLOAD_INITIATED',
      documentId: snapshot.documentId,
      documentNumber: snapshot.documentNumber,
      documentType: snapshot.documentKind,
      userId,
      userName: userName || snapshot.meta.issuerName,
      fileName: rendered.fileName,
      channel: 'BROWSER_DOWNLOAD',
    });

    return {
      status: 'DOWNLOAD_INITIATED',
      mode: 'WEB_PNG_DOWNLOAD',
      canceled: false,
      fileName: rendered.fileName,
      sizeBytes: rendered.blob.size,
      message: `بدأ تنزيل صورة PNG النظيفة من المتصفح (${rendered.fileName}).`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'تعذر تصدير صورة PNG.';
    onStatusChange?.('CREATE_FAILED');
    await recordDocumentOperation({
      operationType: 'PNG_EXPORT',
      status: 'FAILED',
      documentId: snapshot.documentId,
      documentNumber: snapshot.documentNumber,
      documentType: snapshot.documentKind,
      userId,
      userName: userName || snapshot.meta.issuerName,
      fileName: expectedFileName,
      failureReason: msg,
      channel: 'BROWSER_DOWNLOAD',
    });
    return {
      status: 'CREATE_FAILED',
      mode: 'WEB_PNG_DOWNLOAD',
      canceled: false,
      fileName: expectedFileName,
      message: msg,
    };
  }
}
