/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * نافذة إرسال ومشاركة إشعارات السندات والفواتير للعملاء والموردين والمودعين
 * تدعم:
 * 1. الإرسال المباشر عبر واتساب (WhatsApp Web / App)
 * 2. نسخ نص السند للحافظة بصياغة عربية مؤسسية منسقة
 * 3. المشاركة السريعة عبر تطبيقات الهاتف (Web Share API)
 * 4. الطباعة المباشرة لبطاقة الإشعار وتصديرها PDF
 */

import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  MessageSquare,
  Share2,
  Copy,
  Check,
  Printer,
  X,
  Phone,
  User,
  FileText,
  Send,
  FileDown,
} from 'lucide-react';
import { useDocumentContext } from '../../hooks/useDocumentContext';
import { formatLocalDate } from '../../utils/localDate';
import { exportDocumentPdf, triggerNativePrint } from '../../utils/printDocument';
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
}) => {
  const [phone, setPhone] = useState(recipientPhone);
  const [customMessage, setCustomMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const { resolveMeta } = useDocumentContext();
  const docMeta = resolveMeta();
  const companyName = docMeta.companyNameAr;
  const branchName = docMeta.branchName;
  const currencySymbol = docMeta.currency.symbol;

  const docTypeLabels: Record<CustomerNotificationModalProps['documentType'], string> = {
    INVOICE: 'فاتورة / مستند تجاري',
    RECEIPT_VOUCHER: 'سند قبض نقدية رسمي',
    PAYMENT_VOUCHER: 'سند صرف نقدية',
    AMANAT_RECEIPT: 'سند إيداع أمانة رسمي',
    AMANAT_RETURN: 'سند تسليم وإبراء ذمة أمانة',
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

    if (amount !== undefined && amount !== null) {
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
    if (isOpen) {
      setPhone(recipientPhone || '');
      setCustomMessage(generateDefaultMessage());
      setCopied(false);
      setCanShare(typeof navigator !== 'undefined' && !!navigator.share);
      document.body.classList.add('has-doc-print-modal');

      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') onClose();
      };
      window.addEventListener('keydown', onKeyDown);

      return () => {
        window.removeEventListener('keydown', onKeyDown);
        const portal = document.getElementById(PORTAL_ROOT_ID);
        // Only remove body lock if no other portal modal remains mounted after unmount tick
        requestAnimationFrame(() => {
          if (!portal || portal.childElementCount === 0) {
            document.body.classList.remove('has-doc-print-modal');
          }
        });
      };
    }
  }, [isOpen, recipientName, recipientPhone, documentType, documentNumber, amount, date, notes]);

  if (!isOpen) return null;

  const portalRoot = ensurePortalRoot();
  if (!portalRoot) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(customMessage);
    } catch {
      // Fallback ignored
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  const buildWhatsAppUrl = (): string => {
    let cleanPhone = phone.replace(/[^\d+]/g, '');
    if (cleanPhone.startsWith('05')) {
      cleanPhone = '966' + cleanPhone.slice(1);
    } else if (cleanPhone.startsWith('7') && cleanPhone.length === 9) {
      cleanPhone = '967' + cleanPhone;
    }

    const encoded = encodeURIComponent(customMessage);
    return cleanPhone
      ? `https://wa.me/${cleanPhone}?text=${encoded}`
      : `https://api.whatsapp.com/send?text=${encoded}`;
  };

  const handleShareNative = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `${docTypeLabels[documentType]} - ${documentNumber}`,
          text: customMessage,
        });
      } catch {
        // User cancelled share
      }
    }
  };

  const handlePrint = () => {
    triggerNativePrint('A4');
  };

  const handleExportPdf = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      await exportDocumentPdf({
        title: `NOTIFY_${documentNumber}`,
        pageSize: 'A4',
      });
    } finally {
      setIsExporting(false);
    }
  };

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
              <h3 className="font-bold text-sm">إرسال وطباعة إشعار المستند</h3>
              <p className="text-[11px] text-slate-400">
                {docTypeLabels[documentType]} رقم ({documentNumber})
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleExportPdf}
              disabled={isExporting}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-[11px] font-bold rounded-lg transition-colors"
            >
              <FileDown className="w-3.5 h-3.5" />
              <span>PDF</span>
            </button>
            <button
              type="button"
              onClick={handlePrint}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-white hover:bg-slate-100 text-slate-900 text-[11px] font-extrabold rounded-lg transition-colors"
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
        <div className="no-print p-5 space-y-4 text-xs border-b border-slate-200">
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

          <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs">
            <div className="flex items-center gap-1.5 text-slate-600">
              <FileText className="w-4 h-4 text-slate-700" />
              <span>
                المستند: <strong className="text-slate-900 font-mono">{documentNumber}</strong>
              </span>
            </div>
            {amount !== undefined && (
              <div className="flex items-center gap-1 text-emerald-800 font-bold">
                <span>المبلغ:</span>
                <span className="font-mono text-sm tabular-nums">
                  {amount.toFixed(2)} {currencySymbol}
                </span>
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="font-semibold text-slate-700">
                نص الإشعار الرسمي (قابل للتعديل):
              </label>
              <button
                type="button"
                onClick={() => setCustomMessage(generateDefaultMessage())}
                className="text-[11px] text-blue-600 hover:underline"
              >
                إعادة التعيين للنص الافتراضي
              </button>
            </div>
            <textarea
              rows={7}
              value={customMessage}
              onChange={(e) => setCustomMessage(e.target.value)}
              className="w-full p-3 border border-slate-200 rounded-xl text-slate-800 font-sans leading-relaxed focus:outline-none focus:ring-2 focus:ring-emerald-500 text-xs"
            />
          </div>

          <div className="space-y-2 pt-2 border-t border-slate-100">
            <a
              href={buildWhatsAppUrl()}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl transition-all shadow-sm flex items-center justify-center gap-2 text-sm"
            >
              <Send className="w-4 h-4" />
              <span>إرسال إشعار عبر واتساب مباشرة</span>
            </a>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <button
                type="button"
                onClick={handleCopy}
                className="py-2 px-3 border border-slate-300 hover:bg-slate-50 text-slate-700 font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                <span>{copied ? 'تم النسخ!' : 'نسخ النص'}</span>
              </button>

              {canShare ? (
                <button
                  type="button"
                  onClick={handleShareNative}
                  className="py-2 px-3 border border-slate-300 hover:bg-slate-50 text-slate-700 font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5"
                >
                  <Share2 className="w-4 h-4 text-blue-600" />
                  <span>مشاركة</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handlePrint}
                  className="py-2 px-3 border border-slate-300 hover:bg-slate-50 text-slate-700 font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5"
                >
                  <Printer className="w-4 h-4 text-slate-600" />
                  <span>طباعة فورية</span>
                </button>
              )}

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
                label: 'المبلغ',
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
