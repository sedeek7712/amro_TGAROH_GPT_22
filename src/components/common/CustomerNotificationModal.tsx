/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * نافذة إرسال ومشاركة إشعارات السندات والفواتير للعملاء
 * تدعم:
 * 1. الإرسال المباشر عبر واتساب (WhatsApp Web / App)
 * 2. نسخ نص السند للحافظة بصياغة عربية مؤسسية منسقة
 * 3. المشاركة السريعة عبر تطبيقات الهاتف (Web Share API)
 * 4. الطباعة والحفظ كملف PDF
 */

import React, { useState, useEffect } from 'react';
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
  DollarSign,
  Calendar,
  Send,
  Building2,
  Download,
} from 'lucide-react';
import { storage } from '../../services/storageService';
import { getActiveCurrencyConfig } from '../../config/currency';

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

  const activeBranch = storage.getBranches().find((b) => b.id === storage.getActiveBranchId());
  const companyName = 'نظام الإدارة التجارية والمحاسبية المتكامل';
  const branchName = activeBranch ? activeBranch.nameAr : 'الفرع الرئيسي';
  const currencySymbol = getActiveCurrencyConfig().symbol;

  const docTypeLabels: Record<CustomerNotificationModalProps['documentType'], string> = {
    INVOICE: 'فاتورة مبيعات ضريبية',
    RECEIPT_VOUCHER: 'سند قبض نقدية رسمي',
    PAYMENT_VOUCHER: 'سند صرف نقدية',
    AMANAT_RECEIPT: 'سند إيداع أمانة رسمي',
    AMANAT_RETURN: 'سند تسليم وإبراء ذمة أمانة',
    STATEMENT: 'كشف حساب مالي تفصيلي',
  };

  const generateDefaultMessage = (): string => {
    const formattedDate = date || new Date().toISOString().split('T')[0];
    const typeLabel = docTypeLabels[documentType];

    let lines: string[] = [
      `السلام عليكم ورحمة الله وبركاته،`,
      `عزيزنا العميل: *${recipientName.trim()}* المحترم،`,
      ``,
      `نحيطكم علماً بصدور *${typeLabel}* برقم: *${documentNumber}*`,
      `📅 التاريخ: ${formattedDate}`,
      `🏢 المنشأة: ${companyName} - ${branchName}`,
    ];

    if (activityName) {
      lines.push(`🏷️ النشاط / القسم: ${activityName}`);
    }

    if (amount !== undefined && amount !== null) {
      lines.push(`💰 المبلغ: *${amount.toFixed(2)} ${currencySymbol}*`);
    }

    if (itemsSummary) {
      lines.push(`📦 البيان: ${itemsSummary}`);
    }

    if (balanceRemaining !== undefined && balanceRemaining !== null) {
      lines.push(`📊 الرصيد المتبقي بذمتكم: *${balanceRemaining.toFixed(2)} ${currencySymbol}*`);
    }

    if (notes && notes.trim()) {
      lines.push(`📝 ملاحظات: ${notes.trim()}`);
    }

    lines.push(``);
    lines.push(`نشكركم على ثقتكم وحسن تعاملكم معنا.`);
    lines.push(`لأي استفسار أو مراجعة، يسعدنا تواصلكم على هاتف الفرع.`);

    return lines.join('\n');
  };

  useEffect(() => {
    if (isOpen) {
      setPhone(recipientPhone || '');
      setCustomMessage(generateDefaultMessage());
      setCopied(false);
      setCanShare(typeof navigator !== 'undefined' && !!navigator.share);
    }
  }, [isOpen, recipientName, recipientPhone, documentNumber, amount, date]);

  if (!isOpen) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(customMessage);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // Fallback
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    }
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
    window.print();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto no-print">
      <div className="relative w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden border border-slate-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-slate-900 text-white">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-emerald-500/20 text-emerald-400 rounded-lg">
              <MessageSquare className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-sm">إرسال إشعار السند للعميل</h3>
              <p className="text-[11px] text-slate-400">
                {docTypeLabels[documentType]} رقم ({documentNumber})
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-4 text-xs">
          {/* Recipient Meta Inputs */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-slate-700 mb-1 flex items-center gap-1">
                <User className="w-3.5 h-3.5 text-slate-500" />
                <span>اسم العميل / المستلم</span>
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
                placeholder="05XXXXXXXX / 9665XXXXXXX"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono text-slate-900 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
          </div>

          {/* Quick Metrics Badge */}
          <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs">
            <div className="flex items-center gap-1.5 text-slate-600">
              <FileText className="w-4 h-4 text-blue-600" />
              <span>المستند: <strong className="text-slate-900 font-mono">{documentNumber}</strong></span>
            </div>
            {amount !== undefined && (
              <div className="flex items-center gap-1 text-emerald-800 font-bold">
                <span>المبلغ:</span>
                <span className="font-mono text-sm tabular-nums">{amount.toFixed(2)} {currencySymbol}</span>
              </div>
            )}
          </div>

          {/* Message Textarea */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="font-semibold text-slate-700">نص الرسالة والإشعار الرسمي (قابل للتعديل قبل الإرسال):</label>
              <button
                type="button"
                onClick={() => setCustomMessage(generateDefaultMessage())}
                className="text-[11px] text-blue-600 hover:underline"
              >
                إعادة التعيين للنص الافتراضي
              </button>
            </div>
            <textarea
              rows={8}
              value={customMessage}
              onChange={(e) => setCustomMessage(e.target.value)}
              className="w-full p-3 border border-slate-200 rounded-xl text-slate-800 font-sans leading-relaxed focus:outline-none focus:ring-2 focus:ring-emerald-500 text-xs"
            />
          </div>

          {/* Action Buttons */}
          <div className="space-y-2 pt-2 border-t border-slate-100">
            {/* Primary Action: WhatsApp */}
            <a
              href={buildWhatsAppUrl()}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl transition-all shadow-sm flex items-center justify-center gap-2 text-sm"
            >
              <Send className="w-4 h-4" />
              <span>إرسال إشعار عبر واتساب مباشرة (WhatsApp)</span>
            </a>

            {/* Secondary Actions: Copy & Native Share & Print */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <button
                type="button"
                onClick={handleCopy}
                className="py-2 px-3 border border-slate-300 hover:bg-slate-50 text-slate-700 font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                <span>{copied ? 'تم النسخ بنجاح!' : 'نسخ نص السند'}</span>
              </button>

              {canShare ? (
                <button
                  type="button"
                  onClick={handleShareNative}
                  className="py-2 px-3 border border-slate-300 hover:bg-slate-50 text-slate-700 font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5"
                >
                  <Share2 className="w-4 h-4 text-blue-600" />
                  <span>مشاركة عبر الجهاز</span>
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
      </div>
    </div>
  );
};
