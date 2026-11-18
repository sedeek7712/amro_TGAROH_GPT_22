/**
 * سند / فاتورة مبيعات قابلة للطباعة بتصميم مؤسسي أنيق
 * متوافقة مع طابعات الإيصالات 80mm وطابعات A4/A5
 */

import React, { useState } from 'react';
import { Invoice, CommercialActivity } from '../../types/erp';
import { Printer, X, CheckCircle, MessageSquare } from 'lucide-react';
import { CustomerNotificationModal } from './CustomerNotificationModal';

interface ReceiptModalProps {
  invoice: Invoice | null;
  activity?: CommercialActivity;
  onClose: () => void;
}

export const ReceiptModal: React.FC<ReceiptModalProps> = ({ invoice, activity, onClose }) => {
  const [isNotificationOpen, setIsNotificationOpen] = useState(false);
  if (!invoice) return null;

  const handlePrint = () => {
    window.print();
  };

  const paymentMethodLabels: Record<string, string> = {
    CASH: 'نقداً',
    CREDIT: 'آجل (ذمم)',
    BANK_TRANSFER: 'تحويل بنكي',
  };

  const itemsSummary = invoice.items
    ? invoice.items.map((i) => `${i.productName} (${i.quantity} ${i.unit})`).join('، ')
    : '';

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto no-print">
        <div className="relative w-full max-w-md bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
          {/* Header Actions */}
          <div className="flex items-center justify-between px-5 py-4 bg-slate-900 text-white no-print">
            <div className="flex items-center gap-2">
              <CheckCircle className="w-5 h-5 text-emerald-400" />
              <span className="font-bold text-sm">تم حفظ الفاتورة بنجاح</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsNotificationOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg transition-colors"
                title="إرسال إشعار السند للعميل عبر واتساب"
              >
                <MessageSquare className="w-4 h-4" />
                <span>إشعار العميل</span>
              </button>
              <button
                onClick={handlePrint}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-xs font-semibold rounded-lg transition-colors"
              >
                <Printer className="w-4 h-4" />
                <span>طباعة</span>
              </button>
              <button
                onClick={onClose}
                className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

        {/* Printable Area */}
        <div className="p-6 text-slate-800 text-sm printable-area bg-white">
          {/* Header */}
          <div className="text-center border-b border-slate-200 pb-4 mb-4">
            <h2 className="text-lg font-extrabold text-slate-900 tracking-tight">
              نظام الإدارة التجارية والمحاسبية المتكامل
            </h2>
            <div className="text-xs font-semibold text-emerald-700 mt-1">
              قسم: {activity?.nameAr || 'المبيعات العامة'}
            </div>
            <p className="text-xs text-slate-500 mt-1">فاتورة مبيعات ضريبية مبسطة</p>
          </div>

          {/* Invoice Meta */}
          <div className="grid grid-cols-2 gap-2 text-xs border-b border-slate-100 pb-3 mb-3">
            <div>
              <span className="text-slate-500">رقم الفاتورة: </span>
              <span className="font-mono font-bold text-slate-900">{invoice.invoiceNumber}</span>
            </div>
            <div className="text-left">
              <span className="text-slate-500">التاريخ: </span>
              <span className="font-mono">{invoice.date}</span>
            </div>
            <div>
              <span className="text-slate-500">العميل: </span>
              <span className="font-semibold text-slate-900">{invoice.partyName}</span>
            </div>
            <div className="text-left">
              <span className="text-slate-500">طريقة الدفع: </span>
              <span className="font-semibold text-slate-900">
                {paymentMethodLabels[invoice.paymentMethod] || invoice.paymentMethod}
              </span>
            </div>
          </div>

          {/* Items Table */}
          <table className="w-full text-right text-xs mb-4">
            <thead>
              <tr className="border-b border-slate-300 text-slate-600 bg-slate-50">
                <th className="py-2 px-1">الصنف</th>
                <th className="py-2 px-1 text-center">الكمية</th>
                <th className="py-2 px-1 text-center">السعر</th>
                <th className="py-2 px-1 text-left">الإجمالي</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {invoice.items.map((item, idx) => (
                <tr key={idx} className="hover:bg-slate-50">
                  <td className="py-2 px-1">
                    <div className="font-semibold text-slate-900">{item.productName}</div>
                    {item.batchNumber && (
                      <div className="text-[10px] text-slate-500">
                        تشغيلة: {item.batchNumber} {item.expiryDate ? `| انتهاء: ${item.expiryDate}` : ''}
                      </div>
                    )}
                    {item.oemNumber && (
                      <div className="text-[10px] text-slate-500">رقم القطعة: {item.oemNumber}</div>
                    )}
                  </td>
                  <td className="py-2 px-1 text-center tabular-nums font-mono">
                    {item.quantity} {item.unit}
                  </td>
                  <td className="py-2 px-1 text-center tabular-nums font-mono">
                    {item.unitPrice.toFixed(2)}
                  </td>
                  <td className="py-2 px-1 text-left tabular-nums font-mono font-bold text-slate-900">
                    {item.total.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Totals */}
          <div className="border-t border-slate-200 pt-3 space-y-1.5 text-xs">
            <div className="flex justify-between text-slate-600">
              <span>المجموع الفرعي:</span>
              <span className="font-mono tabular-nums">{invoice.subtotal.toFixed(2)} ر.س</span>
            </div>
            {invoice.discount > 0 && (
              <div className="flex justify-between text-rose-600">
                <span>الخصم الممنوح:</span>
                <span className="font-mono tabular-nums">-{invoice.discount.toFixed(2)} ر.س</span>
              </div>
            )}
            <div className="flex justify-between text-base font-extrabold text-slate-900 border-t border-slate-200 pt-2">
              <span>الإجمالي النهائي:</span>
              <span className="font-mono tabular-nums text-emerald-700">{invoice.total.toFixed(2)} ر.س</span>
            </div>
            <div className="flex justify-between text-xs text-slate-600 pt-1">
              <span>المبلغ المسدد:</span>
              <span className="font-mono tabular-nums font-semibold">{invoice.paidAmount.toFixed(2)} ر.س</span>
            </div>
            {invoice.total - invoice.paidAmount > 0 && (
              <div className="flex justify-between text-xs text-rose-700 font-semibold">
                <span>المتبقي آجل على العميل:</span>
                <span className="font-mono tabular-nums">
                  {(invoice.total - invoice.paidAmount).toFixed(2)} ر.س
                </span>
              </div>
            )}
          </div>

          {/* Footer Note */}
          <div className="mt-6 pt-3 border-t border-dashed border-slate-300 text-center text-[11px] text-slate-500">
            <p>شكراً لتعاملكم معنا!</p>
            <p className="mt-0.5">البضاعة المباعة تخضع لسياسة الاستبدال والاسترجاع النظامية</p>
          </div>
        </div>

        {/* Modal Bottom Bar */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 flex justify-between items-center no-print">
          <button
            type="button"
            onClick={() => setIsNotificationOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 text-emerald-800 border border-emerald-300 hover:bg-emerald-100 rounded-lg text-xs font-bold transition-colors"
          >
            <MessageSquare className="w-4 h-4 text-emerald-600" />
            <span>إرسال سند الفاتورة للعميل (واتساب)</span>
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold rounded-lg transition-colors"
          >
            إغلاق ومتابعة البيع
          </button>
        </div>
      </div>
    </div>

    <CustomerNotificationModal
      isOpen={isNotificationOpen}
      onClose={() => setIsNotificationOpen(false)}
      recipientName={invoice.partyName}
      documentType="INVOICE"
      documentNumber={invoice.invoiceNumber}
      amount={invoice.total}
      date={invoice.date}
      activityName={activity?.nameAr}
      balanceRemaining={invoice.total - invoice.paidAmount}
      itemsSummary={itemsSummary}
    />
  </>
);
};
