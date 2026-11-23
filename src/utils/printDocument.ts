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

export async function triggerNativePrint(
  pageSize: DocumentPaperSize,
  options?: {
    snapshot?: DocumentSnapshot;
    userId?: string;
    userName?: string;
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
    return { printed: false, canceled: false, message: 'بيئة العرض غير متاحة للطباعة.' };
  }

  if (window.amroDesktop?.runNativePrint) {
    try {
      const token = desktopSession.requireToken();
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60)));
      const res = await window.amroDesktop.runNativePrint({ token });
      if (snap) {
        await recordDocumentOperation({
          operationType: 'PRINT',
          status: res.canceled ? 'CANCELED' : res.printed ? 'PRINT_SENT' : 'FAILED',
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
          message: 'ألغى المستخدم نافذة الطباعة.',
        };
      }
      if (res.printed) {
        return {
          printed: true,
          canceled: false,
          message: 'تم إرسال أمر الطباعة إلى الطابعة المحددة (حالة خروج الورق تعتمد على الطابعة).',
        };
      }
      return {
        printed: false,
        canceled: false,
        failureReason: res.failureReason,
        message: res.failureReason ? `تعذر إرسال الطباعة: ${res.failureReason}` : 'تعذر إتمام أمر الطباعة.',
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
      return { printed: false, canceled: false, failureReason: reason, message: reason };
    }
  }

  requestAnimationFrame(() => {
    setTimeout(() => {
      window.print();
    }, 60);
  });

  if (snap) {
    await recordDocumentOperation({
      operationType: 'PRINT',
      status: 'PRINT_SENT',
      documentId: snap.documentId,
      documentNumber: snap.documentNumber,
      documentType: snap.documentKind,
      userId: options?.userId,
      userName: options?.userName || snap.meta.issuerName,
      channel: 'NATIVE_PRINT',
    });
  }

  return {
    printed: true,
    canceled: false,
    message: 'تم فتح نافذة الطباعة في المتصفح (تحقق من اختيار الطابعة).',
  };
}

export async function exportDocumentPdf(options: {
  title: string;
  pageSize: DocumentPaperSize;
  snapshot?: DocumentSnapshot;
  userId?: string;
  userName?: string;
  onStatusChange?: (status: SaveDocumentStatus) => void;
  fallbackToPrintDialog?: boolean;
}): Promise<SaveDocumentResult> {
  const { title, pageSize, snapshot, userId, userName, onStatusChange, fallbackToPrintDialog } =
    options;

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

  if (typeof window !== 'undefined' && window.amroDesktop?.exportDocumentPdf) {
    onStatusChange?.('SAVING');
    try {
      const token = desktopSession.requireToken();
      const res = await window.amroDesktop.exportDocumentPdf({
        token,
        title: safeBaseName,
        pageSize,
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
        message: `تم حفظ ملف PDF والتحقق منه (${res.filename || targetFileName}).`,
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

  // مسار المتصفح / PWA: توليد ملف PDF ثنائي حقيقي محلياً دون إنترنت عند توفر Snapshot
  if (snapshot && !fallbackToPrintDialog) {
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
      onStatusChange?.('SAVED');

      await recordDocumentOperation({
        operationType: 'PDF_EXPORT',
        status: 'SAVED',
        documentId: snapshot.documentId,
        documentNumber: snapshot.documentNumber,
        documentType: snapshot.documentKind,
        userId,
        userName: userName || snapshot.meta.issuerName,
        fileName: rendered.fileName,
        channel: 'BROWSER_DOWNLOAD',
      });

      return {
        status: 'SAVED',
        mode: 'WEB_PDF_DOWNLOAD',
        canceled: false,
        fileName: rendered.fileName,
        sizeBytes: rendered.blob.size,
        message: `تم إنشاء وتنزيل ملف PDF (${rendered.fileName}) بعدد ${rendered.pageCount} صفحة.`,
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

  // التراجع إلى نافذة الطباعة فقط إذا لم يتوفر Snapshot أو طُلب ذلك صراحةً
  await triggerNativePrint(pageSize, { snapshot, userId, userName });
  onStatusChange?.('SAVED');
  return {
    status: 'SAVED',
    mode: 'WEB_PRINT',
    canceled: false,
    fileName: targetFileName,
    message: 'تم فتح حوار الطباعة بالمتصفح (اختر Save as PDF للحفظ).',
  };
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
    onStatusChange?.('SAVED');

    await recordDocumentOperation({
      operationType: 'PNG_EXPORT',
      status: 'SAVED',
      documentId: snapshot.documentId,
      documentNumber: snapshot.documentNumber,
      documentType: snapshot.documentKind,
      userId,
      userName: userName || snapshot.meta.issuerName,
      fileName: rendered.fileName,
      channel: 'BROWSER_DOWNLOAD',
    });

    return {
      status: 'SAVED',
      mode: 'WEB_PNG_DOWNLOAD',
      canceled: false,
      fileName: rendered.fileName,
      sizeBytes: rendered.blob.size,
      message: `تم إنشاء وتنزيل صورة PNG النظيفة (${rendered.fileName}).`,
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
