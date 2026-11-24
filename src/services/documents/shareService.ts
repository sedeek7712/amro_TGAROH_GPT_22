/**
 * خدمة المشاركة المؤسسية عبر واتساب والمنصة الأصلية (ShareService)
 * - تعمل محلياً عند انقطاع الإنترنت (تجهيز المرفق والنص وحفظ النسخة المؤقتة).
 * - تفحص navigator.canShare({ files }) قبل تمرير الملفات للمتصفح/Android.
 * - تدعم مسار Windows Electron الآمن (فتح WhatsApp الموثق + ملف مؤقت آمن مع تنظيف تلقائي).
 * - لا تعتبر فتح واتساب إرسالاً أو تسليماً (تُسجل SHARE_OPENED / USER_COPIED_TEXT فقط).
 */

import type { SystemUser } from '../../types/erp';
import { desktopSession } from '../desktopSession';
import { networkMonitor } from '../networkMonitor';
import {
  buildStructuredDocumentFilename,
  validateShareAuthorization,
  type DocumentSnapshot,
} from './documentService';
import { recordDocumentOperation } from './notificationLogService';
import { renderDocumentToPdfBlob, renderDocumentToPngBlob } from './pngDocumentService';

export type PreferredShareFormat = 'AUTO' | 'PNG' | 'PDF';

export interface PreparedSharePackage {
  format: 'PNG' | 'PDF';
  file: File;
  bytes: Uint8Array;
  fileName: string;
  sizeBytes: number;
  messageText: string;
  recipientPhone: string;
  whatsappUrl: string;
  whatsappProtocolUrl: string;
  isOffline: boolean;
  canShareFilesNatively: boolean;
  isDesktopElectron: boolean;
  tempToken?: string;
  dispatchId: string;
}

export interface ShareExecutionOutcome {
  status:
    | 'SHARE_OPENED'
    | 'WHATSAPP_LAUNCHED'
    | 'FALLBACK_DOWNLOAD_AND_WA'
    | 'CANCELED'
    | 'FAILED';
  format: 'PNG' | 'PDF';
  fileName: string;
  isOffline: boolean;
  sharedWithAttachment: boolean;
  usedFallbackCopyFlow: boolean;
  whatsappLaunched?: boolean;
  clipboardCopied?: boolean;
  clipboardError?: string;
  tempFileRevealed?: boolean;
  revealError?: string;
  tempToken?: string;
  noticeMessage: string;
  whatsappUrl: string;
  whatsappProtocolUrl: string;
}

export async function copyTextToClipboard(
  text: string
): Promise<{ copied: boolean; error?: string }> {
  if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
    return {
      copied: false,
      error: 'واجهة الحافظة (Clipboard API) غير متاحة؛ يرجى النسخ يدوياً من مربع النص.',
    };
  }
  try {
    await navigator.clipboard.writeText(text);
    return { copied: true };
  } catch (err: unknown) {
    return {
      copied: false,
      error:
        err instanceof Error && err.message
          ? `تعذر النسخ التلقائي للحافظة (${err.message})؛ يرجى النسخ يدوياً من مربع النص.`
          : 'تعذر النسخ التلقائي للحافظة؛ يرجى النسخ يدوياً من مربع النص.',
    };
  }
}

export function formatWhatsAppPhone(rawPhone: string): string {
  const raw = String(rawPhone || '').trim();
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (digits.startsWith('05') && digits.length === 10) {
    digits = '966' + digits.slice(1);
  } else if (digits.startsWith('5') && digits.length === 9) {
    digits = '966' + digits;
  } else if (digits.startsWith('7') && digits.length === 9) {
    digits = '967' + digits;
  }

  return /^[1-9]\d{7,14}$/.test(digits) ? digits : '';
}

export function maskWhatsAppPhone(rawPhone: string): string {
  const normalized = formatWhatsAppPhone(rawPhone);
  if (!normalized) return '';
  return `${normalized.slice(0, 3)}••••${normalized.slice(-4)}`;
}

function createDispatchId(): string {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `wa_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

export function buildWhatsAppLaunchUrl(phone: string, text: string): string {
  const cleanPhone = formatWhatsAppPhone(phone);
  if (!cleanPhone) throw new Error('رقم واتساب غير صالح؛ أدخل الرقم مع مفتاح الدولة.');
  return `https://wa.me/${cleanPhone}?text=${encodeURIComponent(text)}`;
}

export function buildWhatsAppDesktopProtocolUrl(phone: string, text: string): string {
  const cleanPhone = formatWhatsAppPhone(phone);
  if (!cleanPhone) throw new Error('رقم واتساب غير صالح؛ أدخل الرقم مع مفتاح الدولة.');
  return `whatsapp://send?phone=${cleanPhone}&text=${encodeURIComponent(text)}`;
}


/**
 * فحص صارم لدعم مشاركة الملفات فعلياً (البند 7.3)
 */
export function supportsNativeFileShare(sampleMime: string = 'image/png'): boolean {
  if (
    typeof navigator === 'undefined' ||
    typeof navigator.share !== 'function' ||
    typeof navigator.canShare !== 'function' ||
    typeof File === 'undefined'
  ) {
    return false;
  }
  try {
    const ext = sampleMime === 'application/pdf' ? 'pdf' : 'png';
    const magicBytes =
      sampleMime === 'application/pdf'
        ? new Uint8Array([0x25, 0x50, 0x44, 0x46])
        : new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const probe = new File([magicBytes], `probe.${ext}`, {
      type: sampleMime,
    });
    return Boolean(navigator.canShare({ files: [probe] }));
  } catch {
    return false;
  }
}

export function triggerBrowserFileDownload(blob: Blob, fileName: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * تجهيز حزمة المشاركة (المرفق + النص + الرابط) محلياً دون الحاجة للإنترنت
 */
export async function prepareSharePackage(params: {
  snapshot: DocumentSnapshot;
  preferredFormat?: PreferredShareFormat;
  messageText: string;
  recipientPhone: string;
  recipientName: string;
  actor: SystemUser | null;
}): Promise<PreparedSharePackage> {
  const { snapshot, preferredFormat = 'AUTO', messageText, recipientPhone, recipientName, actor } =
    params;
  if (!actor || !actor.active) {
    throw new Error('لا يمكن تجهيز مشاركة المستند دون مستخدم نشط ومصادق عليه.');
  }
  const normalizedPhone = formatWhatsAppPhone(recipientPhone);
  if (!normalizedPhone) throw new Error('رقم واتساب غير صالح؛ تحقق من الرقم ومفتاح الدولة.');
  if (!String(messageText || '').trim()) throw new Error('نص رسالة واتساب فارغ.');
  if (!String(recipientName || '').trim()) throw new Error('اسم مستلم المستند غير محدد.');

  const authCheck = validateShareAuthorization({
    actor,
    documentKind: snapshot.documentKind,
    expectedPartyName: snapshot.partyName,
    actualRecipientName: recipientName,
  });
  if (!authCheck.allowed) {
    throw new Error(authCheck.error || 'غير مصرح بمشاركة هذا المستند.');
  }

  const dispatchId = createDispatchId();

  let targetFormat: 'PNG' | 'PDF';
  if (preferredFormat === 'PDF' || snapshot.isMultiPage || snapshot.documentKind === 'REPORT') {
    targetFormat = 'PDF';
  } else if (preferredFormat === 'PNG') {
    targetFormat = 'PNG';
  } else {
    targetFormat = snapshot.recommendedShareFormat;
  }

  let file: File;
  let bytes: Uint8Array;
  let fileName: string;

  if (targetFormat === 'PNG') {
    try {
      const png = await renderDocumentToPngBlob(snapshot);
      bytes = png.bytes;
      fileName = png.fileName;
      file = new File([png.blob], fileName, { type: 'image/png' });
    } catch {
      // التراجع الآمن إلى PDF إذا كان المستند أطول من صفحة واحدة
      targetFormat = 'PDF';
      const pdf = await renderDocumentToPdfBlob(snapshot);
      bytes = pdf.bytes;
      fileName = pdf.fileName;
      file = new File([pdf.blob], fileName, { type: 'application/pdf' });
    }
  } else {
    const pdf = await renderDocumentToPdfBlob(snapshot);
    bytes = pdf.bytes;
    fileName = pdf.fileName;
    file = new File([pdf.blob], fileName, { type: 'application/pdf' });
  }

  if (file.size <= 0 || bytes.length <= 0) {
    throw new Error('فشل التحقق من حجم ملف المشاركة المنشأ.');
  }

  const isDesktopElectron = typeof window !== 'undefined' && Boolean(window.amroDesktop);
  let tempToken: string | undefined;

  if (isDesktopElectron && window.amroDesktop?.prepareShareTempFile) {
    const token = desktopSession.requireToken();
    const prep = await window.amroDesktop.prepareShareTempFile({
      token,
      documentKind: snapshot.documentKind,
      fileName,
      bytesBase64: uint8ToBase64(bytes),
      mimeType: file.type,
    });
    if (prep.sizeBytes <= 0) {
      throw new Error('تعذر كتابة ملف المشاركة المؤقت.');
    }
    tempToken = prep.tempToken;
  }

  await recordDocumentOperation({
    operationType: 'SHARE',
    status: 'PREPARED',
    documentId: snapshot.documentId,
    documentNumber: snapshot.documentNumber,
    documentType: snapshot.documentKind,
    dispatchId,
    recipientPhoneMasked: maskWhatsAppPhone(normalizedPhone),
    userId: actor.id,
    userName: actor.fullName || snapshot.meta.issuerName,
    branchId: actor.branchId || 'branch_main',
    branchName: snapshot.meta.branchName,
    activityName: snapshot.meta.activityName,
    fileName,
    recipientName,
    channel: isDesktopElectron ? 'ELECTRON_DIALOG' : 'WEB_SHARE',
  });

  return {
    format: targetFormat,
    file,
    bytes,
    fileName,
    sizeBytes: file.size,
    messageText,
    recipientPhone: normalizedPhone,
    dispatchId,
    whatsappUrl: buildWhatsAppLaunchUrl(normalizedPhone, messageText),
    whatsappProtocolUrl: buildWhatsAppDesktopProtocolUrl(normalizedPhone, messageText),
    isOffline: !networkMonitor.isOnline(),
    canShareFilesNatively: supportsNativeFileShare(file.type),
    isDesktopElectron,
    tempToken,
  };
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

/**
 * تنفيذ مشاركة واتساب أو آلية المنصة مع السلوك البديل الواضح والعمل دون إنترنت
 */
export async function executeWhatsAppOrNativeShare(params: {
  snapshot: DocumentSnapshot;
  pkg: PreparedSharePackage;
  actor?: SystemUser | null;
  recipientName: string;
}): Promise<ShareExecutionOutcome> {
  const { snapshot, pkg, actor, recipientName } = params;
  const offlineWarning = pkg.isOffline
    ? ' تم تجهيز الملف والنص محلياً بدون إنترنت؛ يلزم الاتصال بالإنترنت لإتمام إرسال الرسالة للمستلم.'
    : '';

  let nativeShareFailureNote: string | undefined;

  // 1. مسار Android / المتصفح الداعم لمشاركة الملفات والنص معاً
  if (!pkg.isDesktopElectron && pkg.canShareFilesNatively) {
    try {
      await navigator.share({
        title: `${snapshot.documentTitle} - ${snapshot.documentNumber}`,
        text: pkg.messageText,
        files: [pkg.file],
      });

      await recordDocumentOperation({
        operationType: 'SHARE',
        status: 'SHARE_OPENED',
        documentId: snapshot.documentId,
        documentNumber: snapshot.documentNumber,
        documentType: snapshot.documentKind,
        dispatchId: pkg.dispatchId,
        recipientPhoneMasked: maskWhatsAppPhone(pkg.recipientPhone),
        userId: actor?.id,
        userName: actor?.fullName,

        branchId: actor?.branchId || 'branch_main',

        branchName: snapshot.meta.branchName,
        fileName: pkg.fileName,
        recipientName,
        channel: 'WEB_SHARE',
      });

      return {
        status: 'SHARE_OPENED',
        format: pkg.format,
        fileName: pkg.fileName,
        isOffline: pkg.isOffline,
        sharedWithAttachment: true,
        usedFallbackCopyFlow: false,
        whatsappUrl: pkg.whatsappUrl,
        whatsappProtocolUrl: pkg.whatsappProtocolUrl,
        noticeMessage:
          `تم فتح قائمة المشاركة الأصلية مع مرفق (${pkg.fileName}) ونص الإشعار.${offlineWarning}`,
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        await recordDocumentOperation({
          operationType: 'SHARE',
          status: 'CANCELED',
          documentId: snapshot.documentId,
          documentNumber: snapshot.documentNumber,
          documentType: snapshot.documentKind,
        dispatchId: pkg.dispatchId,
        recipientPhoneMasked: maskWhatsAppPhone(pkg.recipientPhone),
          userId: actor?.id,
          userName: actor?.fullName,

          branchId: actor?.branchId || 'branch_main',

          branchName: snapshot.meta.branchName,
          fileName: pkg.fileName,
          recipientName,
          channel: 'WEB_SHARE',
        });
        return {
          status: 'CANCELED',
          format: pkg.format,
          fileName: pkg.fileName,
          isOffline: pkg.isOffline,
          sharedWithAttachment: false,
          usedFallbackCopyFlow: false,
          whatsappUrl: pkg.whatsappUrl,
          whatsappProtocolUrl: pkg.whatsappProtocolUrl,
          noticeMessage: 'ألغى المستخدم نافذة المشاركة قبل الاختيار.',
        };
      }
      if (err instanceof Error && err.name === 'NotAllowedError') {
        nativeShareFailureNote =
          'تعذر فتح قائمة المشاركة الأصلية تلقائياً (NotAllowedError: انتهت صلاحية التفاعل المباشر أو حظر المتصفح النافذة)؛ تم الانتقال للتنزيل المباشر ونسخ النص.';
      } else if (err instanceof Error && err.message) {
        nativeShareFailureNote = `تعذر إتمام مشاركة النظام (${err.message})؛ تم تجهيز الملف ونسخ النص كبديل.`;
      }
    }
  }

  // 2. مسار Windows Electron أو المتصفحات التي لا تدعم navigator.canShare({ files })
  try {
    const clipResult = await copyTextToClipboard(pkg.messageText);
    const clipboardCopied = clipResult.copied;

    if (pkg.isDesktopElectron && window.amroDesktop) {
      const token = desktopSession.requireToken();
      let tempFileRevealed: boolean | undefined;
      let revealError: string | undefined;
      if (pkg.tempToken && window.amroDesktop.revealShareTempFile) {
        const revealRes = await window.amroDesktop.revealShareTempFile({
          token,
          tempToken: pkg.tempToken,
        });
        tempFileRevealed = Boolean(revealRes?.revealed);
        if (!revealRes?.revealed) {
          revealError = revealRes?.error || 'تعذر فتح مجلد الملف المؤقت.';
        }
      }

      const targetUrl = pkg.isOffline ? pkg.whatsappProtocolUrl : pkg.whatsappUrl;
      let waOpenResult: { opened: boolean; error?: string } = { opened: false };
      if (window.amroDesktop.openWhatsAppUrl) {
        waOpenResult = await window.amroDesktop.openWhatsAppUrl({ token, url: targetUrl });
      }

      await recordDocumentOperation({
        operationType: 'SHARE',
        status: waOpenResult.opened ? 'WHATSAPP_LAUNCHED' : 'FAILED',
        documentId: snapshot.documentId,
        documentNumber: snapshot.documentNumber,
        documentType: snapshot.documentKind,
        dispatchId: pkg.dispatchId,
        recipientPhoneMasked: maskWhatsAppPhone(pkg.recipientPhone),
        userId: actor?.id,
        userName: actor?.fullName,

        branchId: actor?.branchId || 'branch_main',

        branchName: snapshot.meta.branchName,
        fileName: pkg.fileName,
        recipientName,
        failureReason: waOpenResult.opened ? undefined : waOpenResult.error,
        channel: waOpenResult.opened ? 'WHATSAPP' : 'ELECTRON_DIALOG',
      });

      const copySegment = clipboardCopied
        ? 'ونسخ النص'
        : `وتعذر النسخ التلقائي للحافظة (${clipResult.error || 'انسخ النص يدوياً'})`;
      const revealSegment =
        tempFileRevealed === true
          ? 'وإظهاره في المجلد'
          : revealError
          ? `(تعذر إظهار المجلد: ${revealError})`
          : '';

      const noticeMessage = pkg.isOffline
        ? waOpenResult.opened
          ? `وضع عدم الاتصال: تم حفظ المرفق المؤقت (${pkg.fileName}) ${revealSegment} ${copySegment} وفتح تطبيق واتساب عبر البروتوكول المحلي؛ أرفق الملف يدوياً داخل المحادثة (الإرسال الفعلي ينتظر عودة الإنترنت).`
          : `وضع عدم الاتصال: تم حفظ المرفق المؤقت (${pkg.fileName}) ${revealSegment} ${copySegment}، وتعذر فتح تطبيق واتساب تلقائياً (${waOpenResult.error || 'تطبيق WhatsApp Desktop غير متاح'}). يمكنك إرفاق الملف يدوياً عند عودة الإنترنت (يُحتفظ بالملف 7 أيام).`
        : waOpenResult.opened
        ? `تم تجهيز المرفق (${pkg.fileName}) ${revealSegment} ${copySegment} وفتح واتساب. لأن روابط واتساب لا ترفق الملفات تلقائياً، يرجى سحب/إرفاق الملف يدوياً داخل المحادثة ثم تأكيد الإرسال.`
        : `تم تجهيز المرفق (${pkg.fileName}) ${revealSegment} ${copySegment}، لكن تعذر فتح رابط واتساب تلقائياً (${waOpenResult.error || 'تحقق من المتصفح أو تطبيق واتساب'}).`;

      return {
        status: waOpenResult.opened ? 'WHATSAPP_LAUNCHED' : 'FALLBACK_DOWNLOAD_AND_WA',
        format: pkg.format,
        fileName: pkg.fileName,
        isOffline: pkg.isOffline,
        sharedWithAttachment: false,
        usedFallbackCopyFlow: true,
        whatsappLaunched: waOpenResult.opened,
        clipboardCopied,
        clipboardError: clipResult.error,
        tempFileRevealed,
        revealError,
        tempToken: pkg.tempToken,
        whatsappUrl: pkg.whatsappUrl,
        whatsappProtocolUrl: pkg.whatsappProtocolUrl,
        noticeMessage: noticeMessage.replace(/\s+/g, ' ').trim(),
      };
    }

    // مسار المتصفح العادي: تنزيل الملف محلياً مع النسخ الصادق للنص
    triggerBrowserFileDownload(pkg.file, pkg.fileName);

    await recordDocumentOperation({
      operationType: 'SHARE',
      status: 'SHARE_OPENED',
      documentId: snapshot.documentId,
      documentNumber: snapshot.documentNumber,
      documentType: snapshot.documentKind,
        dispatchId: pkg.dispatchId,
        recipientPhoneMasked: maskWhatsAppPhone(pkg.recipientPhone),
      userId: actor?.id,
      userName: actor?.fullName,

      branchId: actor?.branchId || 'branch_main',

      branchName: snapshot.meta.branchName,
      fileName: pkg.fileName,
      recipientName,
      failureReason: nativeShareFailureNote || clipResult.error,
      channel: 'WHATSAPP',
    });

    const browserCopyNotice = clipboardCopied
      ? 'وتم نسخ النص إلى الحافظة'
      : 'وتعذر نسخ النص تلقائياً — يرجى نسخه يدوياً من مربع النص';

    return {
      status: 'FALLBACK_DOWNLOAD_AND_WA',
      format: pkg.format,
      fileName: pkg.fileName,
      isOffline: pkg.isOffline,
      sharedWithAttachment: false,
      usedFallbackCopyFlow: true,
      whatsappLaunched: false,
      clipboardCopied,
      clipboardError: clipResult.error,
      whatsappUrl: pkg.whatsappUrl,
      whatsappProtocolUrl: pkg.whatsappProtocolUrl,
      noticeMessage:
        nativeShareFailureNote ||
        (pkg.isOffline
          ? `الجهاز غير متصل بالإنترنت: بدأ تنزيل المرفق (${pkg.fileName}) ${browserCopyNotice}. عند عودة الإنترنت افتح واتساب وألصق النص وأرفق الملف.`
          : `بدأ تنزيل المرفق (${pkg.fileName}) ${browserCopyNotice} لأن المنصة لا تدعم إرفاق الملف مباشرة داخل رابط واتساب؛ يرجى إرفاق الملف داخل محادثة واتساب ولصق النص.`),
    };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : 'تعذر تجهيز المشاركة.';
    await recordDocumentOperation({
      operationType: 'SHARE',
      status: 'FAILED',
      documentId: snapshot.documentId,
      documentNumber: snapshot.documentNumber,
      documentType: snapshot.documentKind,
      dispatchId: pkg.dispatchId,
      recipientPhoneMasked: maskWhatsAppPhone(pkg.recipientPhone),
      userId: actor?.id,
      userName: actor?.fullName,

      branchId: actor?.branchId || 'branch_main',

      branchName: snapshot.meta.branchName,
      fileName: pkg.fileName,
      failureReason: reason,
      recipientName,
    });
    return {
      status: 'FAILED',
      format: pkg.format,
      fileName: pkg.fileName,
      isOffline: pkg.isOffline,
      sharedWithAttachment: false,
      usedFallbackCopyFlow: true,
      whatsappLaunched: false,
      whatsappUrl: pkg.whatsappUrl,
      whatsappProtocolUrl: pkg.whatsappProtocolUrl,
      noticeMessage: `فشل تجهيز المشاركة: ${reason}`,
    };
  }
}

export async function cleanupShareTempFileIfAny(tempToken?: string): Promise<void> {
  if (!tempToken || typeof window === 'undefined' || !window.amroDesktop?.cleanupShareTempFile) {
    return;
  }
  try {
    const token = desktopSession.requireToken();
    await window.amroDesktop.cleanupShareTempFile({ token, tempToken });
  } catch {
    // non-fatal cleanup
  }
}

export function getSuggestedFilenameForKind(params: {
  kind: DocumentSnapshot['documentKind'];
  documentNumber: string;
  date?: string;
  ext: 'pdf' | 'png';
}): string {
  return buildStructuredDocumentFilename(params);
}
