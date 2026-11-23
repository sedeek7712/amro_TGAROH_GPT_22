/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * نافذة تجهيز وحفظ ومشاركة إشعارات السندات والفواتير (AMRO-DOC-OPS-001 & AMRO-DOC-OPS-002)
 * - تجهز المرفق (PNG النظيفة للسند القصير أو PDF الرسمي) والنص محلياً حتى عند انقطاع الإنترنت.
 * - تدعم مشاركة الملفات الأصلية عند توفر navigator.canShare({ files }) ومسار Windows/Desktop البديل الواضح.
 * - تسجل عمليات التحضير والطباعة والحفظ والمشاركة في NotificationLogService دون ادعاء التسليم (DELIVERED ممنوع).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  FileDown,
  FileText,
  Image as ImageIcon,
  MessageSquare,
  Phone,
  Printer,
  Send,
  Share2,
  User,
  WifiOff,
  X,
} from 'lucide-react';
import { useDocumentContext } from '../../hooks/useDocumentContext';
import { authService } from '../../services/authService';
import type { DocumentSnapshot } from '../../services/documents/documentService';
import { recordDocumentOperation } from '../../services/documents/notificationLogService';
import { computeDocumentCanvasSpec } from '../../services/documents/pngDocumentService';
import {
  cleanupShareTempFileIfAny,
  executeWhatsAppOrNativeShare,
  prepareSharePackage,
  supportsNativeFileShare,
} from '../../services/documents/shareService';
import { networkMonitor } from '../../services/networkMonitor';
import { storage } from '../../services/storageService';
import { formatLocalDate } from '../../utils/localDate';
import {
  exportDocumentPdf,
  exportDocumentPng,
  getSaveStatusLabel,
  triggerNativePrint,
  type SaveDocumentStatus,
} from '../../utils/printDocument';
import { DocumentFooter, DocumentHeader, DocumentMetaGrid } from '../documents/DocumentPrimitives';

export interface CustomerNotificationModalProps {
  isOpen: boolean;
  onClose: () => void;
  recipientName: string;
  recipientPhone?: string;
  documentType:
    | 'INVOICE'
    | 'RECEIPT_VOUCHER'
    | 'PAYMENT_VOUCHER'
    | 'AMANAT_RECEIPT'
    | 'AMANAT_RETURN'
    | 'STATEMENT';
  documentNumber: string;
  amount?: number;
  date?: string;
  notes?: string;
  activityName?: string;
  balanceRemaining?: number;
  itemsSummary?: string;
  snapshot?: DocumentSnapshot;
  notificationError?: string;
  isPartialReturn?: boolean;
  totalOriginalAmount?: number;
  cumulativeReturnedAmount?: number;
  returnEventSelector?: React.ReactNode;
}

const PORTAL_ROOT_ID = 'doc-print-portal';

function ensurePortalRoot(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  let root = document.getElementById(PORTAL_ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = PORTAL_ROOT_ID;
    document.body.appendChild(root);
  }
  return root;
}

export const CustomerNotificationModal: React.FC<CustomerNotificationModalProps> = ({
  isOpen,
  onClose,
  recipientName,
  recipientPhone = '',
  documentType,
  documentNumber,
  amount,
  date,
  notes,
  activityName,
  balanceRemaining,
  itemsSummary,
  snapshot,
  notificationError,
  isPartialReturn,
  totalOriginalAmount,
  cumulativeReturnedAmount,
  returnEventSelector,
}) => {
  const [phone, setPhone] = useState(recipientPhone);
  const [customMessage, setCustomMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const [shareFormat, setShareFormat] = useState<'PNG' | 'PDF'>('PNG');
  const [isOnline, setIsOnline] = useState<boolean>(() => networkMonitor.isOnline());
  const [saveState, setSaveState] = useState<SaveDocumentStatus>('IDLE');
  const [statusFeedback, setStatusFeedback] = useState<{
    tone: 'info' | 'success' | 'warning' | 'error';
    text: string;
  } | null>(null);
  const [shareOpenedOnce, setShareOpenedOnce] = useState(false);
  const [confirmedSend, setConfirmedSend] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const activeTempTokenRef = useRef<string | undefined>(undefined);

  const isDesktop = typeof window !== 'undefined' && Boolean(window.amroDesktop);
  const actor =
    authService.getCurrentActorSync() || (isDesktop ? null : storage.getCurrentUser());

  const { resolveMeta } = useDocumentContext();
  const docMeta = resolveMeta();
  const companyName = docMeta.companyNameAr;
  const branchName = docMeta.branchName;
  const currencySymbol = docMeta.currency.symbol;

  const pngSpec = useMemo(() => {
    return snapshot ? computeDocumentCanvasSpec(snapshot) : null;
  }, [snapshot]);
  const allowPngFormat = Boolean(snapshot && (!pngSpec || pngSpec.allowSinglePng));

  const docTypeLabels: Record<CustomerNotificationModalProps['documentType'], string> = {
    INVOICE: 'فاتورة / مستند تجاري',
    RECEIPT_VOUCHER: 'سند قبض نقدية رسمي',
    PAYMENT_VOUCHER: 'سند صرف نقدية',
    AMANAT_RECEIPT: 'سند إيداع أمانة رسمي',
    AMANAT_RETURN: isPartialReturn ? 'إشعار رد جزئي لأمانة' : 'سند تسليم وإبراء ذمة أمانة',
    STATEMENT: 'كشف حساب مالي تفصيلي',
  };

  const generateDefaultMessage = (): string => {
    const formattedDate = date || formatLocalDate();
    const typeLabel = docTypeLabels[documentType];

    const lines: string[] = [
      `السلام عليكم ورحمة الله وبركاته،`,
      `عزيزنا: *${recipientName.trim()}* المحترم،`,
      ``,
      `نحيطكم علماً بصدور *${typeLabel}* برقم: *${documentNumber}*`,
      `التاريخ: ${formattedDate}`,
      `المنشأة: ${companyName} - ${branchName}`,
    ];

    if (activityName) {
      lines.push(`النشاط / القسم: ${activityName}`);
    }

    if (documentType === 'AMANAT_RETURN' && amount !== undefined && amount !== null) {
      lines.push(`مبلغ الرد الحالي: *${amount.toFixed(2)} ${currencySymbol}*`);
      if (totalOriginalAmount !== undefined) {
        lines.push(`إجمالي الأمانة الأصلية: ${totalOriginalAmount.toFixed(2)} ${currencySymbol}`);
      }
      if (cumulativeReturnedAmount !== undefined && isPartialReturn) {
        lines.push(`إجمالي المردود حتى تاريخه: ${cumulativeReturnedAmount.toFixed(2)} ${currencySymbol}`);
      }
    } else if (amount !== undefined && amount !== null) {
      lines.push(`المبلغ: *${amount.toFixed(2)} ${currencySymbol}*`);
    }

    if (itemsSummary) {
      lines.push(`البيان: ${itemsSummary}`);
    }

    if (balanceRemaining !== undefined && balanceRemaining !== null) {
      lines.push(`الرصيد المتبقي: *${balanceRemaining.toFixed(2)} ${currencySymbol}*`);
    }

    if (notes && notes.trim()) {
      lines.push(`ملاحظات: ${notes.trim()}`);
    }

    lines.push(``);
    lines.push(`نشكركم على ثقتكم وحسن تعاملكم معنا.`);
    if (docMeta.phone || docMeta.branchPhone) {
      lines.push(`للتواصل: ${docMeta.phone || docMeta.branchPhone}`);
    }

    return lines.join('\n');
  };

  useEffect(() => {
    const unsub = networkMonitor.subscribe((online) => setIsOnline(online));
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!isOpen) {
      if (activeTempTokenRef.current) {
        cleanupShareTempFileIfAny(activeTempTokenRef.current);
        activeTempTokenRef.current = undefined;
      }
      return;
    }

    setPhone(recipientPhone || '');
    setCustomMessage(generateDefaultMessage());
    setCopied(false);
    setSaveState('IDLE');
    setStatusFeedback(null);
    setShareOpenedOnce(false);
    setConfirmedSend(false);

    if (snapshot) {
      setShareFormat(allowPngFormat ? snapshot.recommendedShareFormat : 'PDF');
    } else {
      setShareFormat('PDF');
    }

    document.body.classList.add('has-doc-print-modal');

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (activeTempTokenRef.current) {
        cleanupShareTempFileIfAny(activeTempTokenRef.current);
        activeTempTokenRef.current = undefined;
      }
      const portal = document.getElementById(PORTAL_ROOT_ID);
      requestAnimationFrame(() => {
        if (!portal || portal.childElementCount === 0) {
          document.body.classList.remove('has-doc-print-modal');
        }
      });
    };
  }, [
    isOpen,
    recipientName,
    recipientPhone,
    documentType,
    documentNumber,
    amount,
    balanceRemaining,
    date,
    notes,
    itemsSummary,
    isPartialReturn,
    allowPngFormat,
  ]);

  if (!isOpen) return null;

  const portalRoot = ensurePortalRoot();
  if (!portalRoot) return null;

  const isBlocked = Boolean(notificationError);
  const canShareFilesNatively = supportsNativeFileShare(
    shareFormat === 'PNG' ? 'image/png' : 'application/pdf'
  );

  const handleCopy = async () => {
    if (isBlocked) return;
    try {
      await navigator.clipboard.writeText(customMessage);
    } catch {
      // ignore clipboard fallback error
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
    await recordDocumentOperation({
      operationType: 'SHARE',
      status: 'USER_COPIED_TEXT',
      documentId: snapshot?.documentId || documentNumber,
      documentNumber,
      documentType,
      userId: actor?.id,
      userName: actor?.fullName,
      recipientName,
      channel: 'CLIPBOARD',
    });
    setStatusFeedback({
      tone: 'info',
      text: 'تم نسخ نص الإشعار للحافظة ويمكنك لصقه في محادثة واتساب.',
    });
  };

  const handlePrint = async () => {
    if (isBlocked || isBusy) return;
    setIsBusy(true);
    try {
      const res = await triggerNativePrint('A4', {
        snapshot,
        userId: actor?.id,
        userName: actor?.fullName,
      });
      setStatusFeedback({
        tone: res.canceled ? 'warning' : res.printed ? 'success' : 'error',
        text: res.message,
      });
    } finally {
      setIsBusy(false);
    }
  };

  const handleExportPdf = async () => {
    if (isBlocked || isBusy) return;
    setIsBusy(true);
    setSaveState('PREPARING');
    try {
      const res = await exportDocumentPdf({
        title: snapshot?.officialFileBaseName || `NOTIFY-${documentNumber}`,
        pageSize: snapshot?.paperSize || 'A4',
        snapshot,
        userId: actor?.id,
        userName: actor?.fullName,
        onStatusChange: setSaveState,
      });
      setSaveState(res.status);
      setStatusFeedback({
        tone: res.status === 'SAVED' ? 'success' : res.status === 'CANCELED' ? 'warning' : 'error',
        text: res.message,
      });
    } finally {
      setIsBusy(false);
    }
  };

  const handleExportPng = async () => {
    if (isBlocked || isBusy || !snapshot || !allowPngFormat) return;
    setIsBusy(true);
    setSaveState('PREPARING');
    try {
      const res = await exportDocumentPng({
        snapshot,
        userId: actor?.id,
        userName: actor?.fullName,
        onStatusChange: setSaveState,
      });
      setSaveState(res.status);
      setStatusFeedback({
        tone: res.status === 'SAVED' ? 'success' : res.status === 'CANCELED' ? 'warning' : 'error',
        text: res.message,
      });
    } finally {
      setIsBusy(false);
    }
  };

  const handleShareWhatsApp = async () => {
    if (isBlocked || isBusy) return;
    if (!snapshot) {
      //Fallback URL only if legacy caller did not supply snapshot
      await handleCopy();
      return;
    }

    setIsBusy(true);
    setStatusFeedback({ tone: 'info', text: 'جاري تجهيز المرفق ونص الإشعار محلياً...' });
    try {
      if (activeTempTokenRef.current) {
        await cleanupShareTempFileIfAny(activeTempTokenRef.current);
        activeTempTokenRef.current = undefined;
      }

      const pkg = await prepareSharePackage({
        snapshot,
        preferredFormat: shareFormat,
        messageText: customMessage,
        recipientPhone: phone,
        recipientName,
        actor,
      });
      if (pkg.tempToken) {
        activeTempTokenRef.current = pkg.tempToken;
      }

      const outcome = await executeWhatsAppOrNativeShare({
        snapshot,
        pkg,
        actor,
        recipientName,
      });

      setShareOpenedOnce(
        outcome.status === 'SHARE_OPENED' || outcome.status === 'FALLBACK_DOWNLOAD_AND_WA'
      );
      setStatusFeedback({
        tone:
          outcome.status === 'FAILED'
            ? 'error'
            : outcome.status === 'CANCELED' || outcome.isOffline
            ? 'warning'
            : 'success',
        text: outcome.noticeMessage,
      });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : 'تعذر تجهيز المشاركة.';
      setStatusFeedback({ tone: 'error', text: reason });
    } finally {
      setIsBusy(false);
    }
  };

  const handleConfirmUserSent = async () => {
    await recordDocumentOperation({
      operationType: 'SHARE',
      status: 'USER_CONFIRMED_SEND',
      documentId: snapshot?.documentId || documentNumber,
      documentNumber,
      documentType,
      userId: actor?.id,
      userName: actor?.fullName,
      recipientName,
      channel: 'WHATSAPP',
    });
    setConfirmedSend(true);
    setStatusFeedback({
      tone: 'success',
      text: 'تم توثيق تأكيد المستخدم للإرسال في سجل العمليات (USER_CONFIRMED_SEND).',
    });
  };

  const feedbackBoxColors =
    statusFeedback?.tone === 'success'
      ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
      : statusFeedback?.tone === 'warning'
      ? 'bg-amber-50 border-amber-200 text-amber-900'
      : statusFeedback?.tone === 'error'
      ? 'bg-rose-50 border-rose-200 text-rose-900'
      : 'bg-slate-100 border-slate-200 text-slate-800';

  const modalContent = (
    <div
      className="doc-modal-layer fixed inset-0 z-[60] flex items-start justify-center bg-slate-950/70 backdrop-blur-[1px] p-3 sm:p-5 overflow-y-auto"
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-label="إرسال إشعار المستند"
    >
      <div className="doc-modal-card relative w-full max-w-xl bg-white rounded-2xl shadow-2xl overflow-hidden border border-slate-200 my-4">
        {/* Interactive Modal Header (Hidden on print) */}
        <div className="no-print flex items-center justify-between px-5 py-3.5 bg-slate-900 text-white">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-emerald-500/20 text-emerald-400 rounded-lg">
              <MessageSquare className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm">حفظ ومشاركة إشعار المستند</h3>
              <p className="text-[11px] text-slate-400">
                {docTypeLabels[documentType]} رقم ({documentNumber})
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {snapshot && allowPngFormat && (
              <button
                type="button"
                onClick={handleExportPng}
                disabled={isBusy || isBlocked}
                className="flex items-center gap-1 px-2.5 py-1.5 bg-indigo-700 hover:bg-indigo-600 text-white text-[11px] font-bold rounded-lg transition-colors disabled:opacity-45"
                title="حفظ المستند كصورة PNG نظيفة"
              >
                <ImageIcon className="w-3.5 h-3.5" />
                <span>PNG</span>
              </button>
            )}
            <button
              type="button"
              onClick={handleExportPdf}
              disabled={isBusy || isBlocked}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-[11px] font-bold rounded-lg transition-colors disabled:opacity-45"
            >
              <FileDown className="w-3.5 h-3.5" />
              <span>PDF</span>
            </button>
            <button
              type="button"
              onClick={handlePrint}
              disabled={isBusy || isBlocked}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-white hover:bg-slate-100 text-slate-900 text-[11px] font-extrabold rounded-lg transition-colors disabled:opacity-45"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>طباعة</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
              aria-label="إغلاق"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Interactive Form Controls (Hidden on print) */}
        <div className="no-print p-5 space-y-3.5 text-xs border-b border-slate-200">
          {!isOnline && (
            <div className="p-3 rounded-xl border border-amber-300 bg-amber-50 text-amber-950 flex items-start gap-2.5">
              <WifiOff className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
              <div className="leading-relaxed">
                <strong>وضع عدم الاتصال بالإنترنت:</strong> يمكن تجهيز ملف المستند (PNG/PDF) وحفظه
                ونسخ نص الإشعار محلياً دون إنترنت، بينما يحتاج إرسال الرسالة عبر واتساب للاتصال
                بالإنترنت.
              </div>
            </div>
          )}

          {notificationError && (
            <div className="p-3.5 rounded-xl border border-rose-300 bg-rose-50 text-rose-950 flex items-start gap-2.5">
              <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
              <div className="leading-relaxed font-semibold">{notificationError}</div>
            </div>
          )}

          {returnEventSelector}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-slate-700 mb-1 flex items-center gap-1">
                <User className="w-3.5 h-3.5 text-slate-500" />
                <span>اسم المستلم</span>
              </label>
              <input
                type="text"
                readOnly
                value={recipientName}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg font-bold text-slate-800 focus:outline-none"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1 flex items-center gap-1">
                <Phone className="w-3.5 h-3.5 text-emerald-600" />
                <span>رقم هاتف الواتساب</span>
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="77XXXXXXX / 05XXXXXXXX"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono text-slate-900 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs">
            <div className="flex items-center gap-1.5 text-slate-600">
              <FileText className="w-4 h-4 text-slate-700" />
              <span>
                المستند: <strong className="text-slate-900 font-mono">{documentNumber}</strong>
              </span>
            </div>
            {!isBlocked && amount !== undefined && (
              <div className="flex flex-wrap items-center gap-3 text-emerald-800 font-bold">
                <span>
                  {documentType === 'AMANAT_RETURN' ? 'مبلغ الرد الحالي:' : 'المبلغ:'}{' '}
                  <span className="font-mono text-sm tabular-nums">
                    {amount.toFixed(2)} {currencySymbol}
                  </span>
                </span>
                {balanceRemaining !== undefined && (
                  <span className="text-slate-700">
                    المتبقي:{' '}
                    <span className="font-mono tabular-nums">
                      {balanceRemaining.toFixed(2)} {currencySymbol}
                    </span>
                  </span>
                )}
              </div>
            )}
          </div>

          {snapshot && (
            <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 bg-slate-50 border border-slate-200 rounded-xl">
              <span className="font-semibold text-slate-700">صيغة المرفق عند المشاركة:</span>
              <div className="inline-flex rounded-lg bg-slate-200/70 p-0.5">
                <button
                  type="button"
                  disabled={!allowPngFormat}
                  onClick={() => setShareFormat('PNG')}
                  className={`px-3 py-1 rounded-md text-[11px] font-bold transition-colors ${
                    shareFormat === 'PNG' && allowPngFormat
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 disabled:opacity-40 disabled:cursor-not-allowed'
                  }`}
                  title={
                    allowPngFormat
                      ? 'صورة PNG نظيفة ومختصرة للسند'
                      : pngSpec?.rejectionReasonForPng
                  }
                >
                  صورة PNG نظيفة
                </button>
                <button
                  type="button"
                  onClick={() => setShareFormat('PDF')}
                  className={`px-3 py-1 rounded-md text-[11px] font-bold transition-colors ${
                    shareFormat === 'PDF' || !allowPngFormat
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600'
                  }`}
                >
                  ملف PDF الرسمي
                </button>
              </div>
              {!allowPngFormat && pngSpec?.rejectionReasonForPng && (
                <div className="w-full text-[11px] text-amber-800 font-semibold">
                  {pngSpec.rejectionReasonForPng}
                </div>
              )}
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="font-semibold text-slate-700">
                نص الإشعار الرسمي (قابل للتعديل):
              </label>
              <button
                type="button"
                disabled={isBlocked}
                onClick={() => setCustomMessage(generateDefaultMessage())}
                className="text-[11px] text-blue-600 hover:underline disabled:opacity-40"
              >
                إعادة التعيين للنص الافتراضي
              </button>
            </div>
            <textarea
              rows={6}
              disabled={isBlocked}
              value={customMessage}
              onChange={(e) => setCustomMessage(e.target.value)}
              className="w-full p-3 border border-slate-200 rounded-xl text-slate-800 font-sans leading-relaxed focus:outline-none focus:ring-2 focus:ring-emerald-500 text-xs disabled:bg-slate-100"
            />
          </div>

          {(statusFeedback || saveState !== 'IDLE') && (
            <div className={`p-3 rounded-xl border text-[11px] font-semibold ${feedbackBoxColors}`}>
              {saveState !== 'IDLE' && (
                <span className="inline-block ml-2 px-2 py-0.5 rounded bg-white/80 font-extrabold">
                  {getSaveStatusLabel(saveState)}
                </span>
              )}
              <span>{statusFeedback?.text || getSaveStatusLabel(saveState)}</span>
            </div>
          )}

          <div className="space-y-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={handleShareWhatsApp}
              disabled={isBlocked || isBusy}
              className="w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-bold rounded-xl transition-all shadow-sm flex items-center justify-center gap-2 text-sm"
            >
              {canShareFilesNatively && !isDesktop ? (
                <Share2 className="w-4 h-4" />
              ) : (
                <Send className="w-4 h-4" />
              )}
              <span>
                {isBusy
                  ? 'جاري تجهيز الملف...'
                  : canShareFilesNatively && !isDesktop
                  ? `مشاركة ${shareFormat} والنص عبر واتساب / النظام`
                  : `تجهيز ${shareFormat} وفتح واتساب (نسخ + مرفق)`}
              </span>
            </button>

            {shareOpenedOnce && !confirmedSend && (
              <button
                type="button"
                onClick={handleConfirmUserSent}
                className="w-full py-2 px-4 bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 text-emerald-900 font-bold rounded-xl flex items-center justify-center gap-2 text-xs"
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-700" />
                <span>تأكيد: تم إرسال الرسالة والمرفق عبر واتساب</span>
              </button>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <button
                type="button"
                disabled={isBlocked}
                onClick={handleCopy}
                className="py-2 px-3 border border-slate-300 hover:bg-slate-50 disabled:opacity-45 text-slate-700 font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                <span>{copied ? 'تم النسخ!' : 'نسخ النص'}</span>
              </button>

              <button
                type="button"
                disabled={isBlocked || isBusy}
                onClick={handleExportPdf}
                className="py-2 px-3 border border-slate-300 hover:bg-slate-50 disabled:opacity-45 text-slate-700 font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5"
              >
                <FileDown className="w-4 h-4 text-blue-700" />
                <span>حفظ PDF</span>
              </button>

              <button
                type="button"
                onClick={onClose}
                className="py-2 px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-lg transition-colors text-center"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>

        {/* Dedicated Printable Official Slip (Visible in print, cleanly hidden inside screen modal via hidden print:block) */}
        <div className="hidden print:block printable-area doc-sheet-a4 p-6 bg-white text-slate-900">
          <DocumentHeader
            meta={docMeta}
            paperSize="A4"
            documentTitle="إشعار معاملة مالية رسمي"
            documentSubtitle={docTypeLabels[documentType]}
            documentNumber={documentNumber}
            documentDate={date || formatLocalDate()}
          />
          <DocumentMetaGrid
            paperSize="A4"
            columns={3}
            fields={[
              { label: 'الطرف / المستلم', value: recipientName },
              { label: 'رقم الهاتف', value: phone || '-', mono: true },
              {
                label: documentType === 'AMANAT_RETURN' ? 'مبلغ الرد الحالي' : 'المبلغ',
                value:
                  amount !== undefined ? `${amount.toFixed(2)} ${currencySymbol}` : undefined,
                mono: true,
              },
              {
                label: 'الرصيد المتبقي',
                value:
                  balanceRemaining !== undefined
                    ? `${balanceRemaining.toFixed(2)} ${currencySymbol}`
                    : undefined,
                mono: true,
              },
              { label: 'القسم / النشاط', value: activityName },
            ]}
          />
          <div className="border border-slate-300 rounded-lg p-4 bg-slate-50 text-xs leading-loose whitespace-pre-wrap text-slate-900 mb-4">
            {customMessage.replace(/\*/g, '')}
          </div>
          <DocumentFooter meta={docMeta} paperSize="A4" referenceText={`NOTIFY: ${documentNumber}`} />
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, portalRoot);
};
