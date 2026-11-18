/**
 * سند استلام / تسليم أمانة رسمي قابل للطباعة
 * مخصص لنظام الأمانات وحفظ أموال وأصناف الغير
 */

import React, { useState } from 'react';
import { AmanatRecord } from '../../types/erp';
import { Printer, X, ShieldCheck, MessageSquare } from 'lucide-react';
import { CustomerNotificationModal } from './CustomerNotificationModal';

interface AmanatReceiptModalProps {
  record: AmanatRecord | null;
  onClose: () => void;
}

export const AmanatReceiptModal: React.FC<AmanatReceiptModalProps> = ({ record, onClose }) => {
  const [isNotificationOpen, setIsNotificationOpen] = useState(false);
  if (!record) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto no-print">
        <div className="relative w-full max-w-lg bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
          {/* Actions Bar */}
          <div className="flex items-center justify-between px-5 py-4 bg-purple-900 text-white no-print">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-purple-300" />
              <span className="font-bold text-sm">سند أمانة رسمي</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsNotificationOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg transition-colors"
                title="إرسال إشعار السند للمودع عبر واتساب"
              >
                <MessageSquare className="w-4 h-4" />
                <span>إشعار المودع</span>
              </button>
              <button
                onClick={() => window.print()}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white text-xs font-semibold rounded-lg transition-colors"
              >
                <Printer className="w-4 h-4" />
                <span>طباعة السند</span>
              </button>
              <button
                onClick={onClose}
                className="p-1.5 text-purple-200 hover:text-white rounded-lg hover:bg-purple-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

        {/* Printable Voucher */}
        <div className="p-8 text-slate-800 printable-area bg-white text-sm">
          {/* Header */}
          <div className="text-center border-b-2 border-slate-800 pb-4 mb-5">
            <h1 className="text-xl font-extrabold text-slate-900">نظام الإدارة التجارية والمحاسبية المتكامل</h1>
            <p className="text-xs text-slate-600 mt-1">قسم إدارة الأمانات وحفظ ممتلكات وأموال الغير</p>
            <div className="inline-block mt-3 px-4 py-1 border border-slate-800 text-slate-900 font-bold rounded text-xs bg-slate-50">
              {record.status === 'HELD'
                ? 'سند استلام وإيداع أمانة'
                : record.status === 'RETURNED'
                ? 'سند تسليم وإبراء ذمة أمانة'
                : 'سند تصفية أمانة'}
            </div>
          </div>

          {/* Meta Info */}
          <div className="grid grid-cols-2 gap-4 text-xs mb-5 bg-slate-50 p-4 rounded-lg border border-slate-200">
            <div>
              <span className="text-slate-500 font-medium">رقم السند: </span>
              <span className="font-mono font-bold text-slate-900">{record.recordNumber}</span>
            </div>
            <div className="text-left">
              <span className="text-slate-500 font-medium">تاريخ الاستلام: </span>
              <span className="font-mono font-semibold">{record.receivedDate}</span>
            </div>
            <div>
              <span className="text-slate-500 font-medium">اسم المودع: </span>
              <span className="font-bold text-slate-900">{record.depositorName}</span>
            </div>
            <div className="text-left">
              <span className="text-slate-500 font-medium">رقم الهاتف: </span>
              <span className="font-mono font-semibold">{record.depositorPhone}</span>
            </div>
            {record.depositorNationalId && (
              <div>
                <span className="text-slate-500 font-medium">رقم الهوية: </span>
                <span className="font-mono">{record.depositorNationalId}</span>
              </div>
            )}
            {record.returnedDate && (
              <div className="text-left">
                <span className="text-slate-500 font-medium">تاريخ التسليم: </span>
                <span className="font-mono font-semibold text-emerald-700">{record.returnedDate}</span>
              </div>
            )}
          </div>

          {/* Details */}
          <div className="border border-slate-200 rounded-lg p-5 mb-5 space-y-3">
            <div className="flex justify-between items-center border-b border-slate-100 pb-2">
              <span className="text-slate-600 font-medium">طبيعة الأمانة:</span>
              <span className="font-bold text-slate-900">
                {record.type === 'CASH' ? 'أمانة نقدية (مبلغ مالي)' : 'أمانة عينية (أصناف ومقتنيات)'}
              </span>
            </div>

            {record.type === 'CASH' ? (
              <div className="flex justify-between items-center py-2 bg-purple-50 px-3 rounded text-purple-950 font-bold">
                <span>المبلغ المودع بأمانة:</span>
                <span className="text-base font-mono tabular-nums">{record.amount.toFixed(2)} ر.س</span>
              </div>
            ) : (
              <div>
                <div className="text-slate-600 font-medium mb-1">وصف الصنف العيني والمواصفات:</div>
                <div className="bg-slate-50 p-3 rounded text-slate-900 text-xs leading-relaxed border border-slate-200 font-mono">
                  {record.itemDescription || 'لا يوجد وصف تفصيلي'}
                </div>
                {record.itemSerial && (
                  <div className="text-xs text-slate-600 mt-2">
                    الرقم التسلسلي: <span className="font-mono font-bold">{record.itemSerial}</span>
                  </div>
                )}
              </div>
            )}

            {record.notes && (
              <div className="pt-2 text-xs text-slate-500 border-t border-slate-100">
                <span className="font-medium text-slate-700">شروط وملاحظات: </span>
                {record.notes}
              </div>
            )}
          </div>

          {/* Legal statement */}
          <div className="text-[11px] text-slate-500 leading-relaxed border-t border-dashed border-slate-300 pt-3 mb-6">
            <p>
              إقرار: نقر باستلام الأمانة الموضحة أعلاه بحالتها الراهنة ونلتزم بحفظها وردها لصاحبها أو وكيله الشرعي بموجب
              هذا السند الأصلي وإثبات الشخصية.
            </p>
          </div>

          {/* Signatures */}
          <div className="grid grid-cols-2 gap-8 text-center text-xs pt-4 border-t border-slate-200">
            <div>
              <div className="text-slate-600 mb-8">المستلم (الموظف المختص)</div>
              <div className="font-bold text-slate-900">{record.receivedBy}</div>
              <div className="border-b border-slate-400 w-32 mx-auto mt-2"></div>
            </div>
            <div>
              <div className="text-slate-600 mb-8">المودع / صاحب الأمانة</div>
              <div className="font-bold text-slate-900">{record.depositorName}</div>
              <div className="border-b border-slate-400 w-32 mx-auto mt-2"></div>
            </div>
          </div>
        </div>

        {/* Footer actions */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 flex justify-between items-center no-print">
          <button
            type="button"
            onClick={() => setIsNotificationOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 text-emerald-800 border border-emerald-300 hover:bg-emerald-100 rounded-lg text-xs font-bold transition-colors"
          >
            <MessageSquare className="w-4 h-4 text-emerald-600" />
            <span>إرسال سند الأمانة للمودع (واتساب)</span>
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold rounded-lg transition-colors"
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>

    <CustomerNotificationModal
      isOpen={isNotificationOpen}
      onClose={() => setIsNotificationOpen(false)}
      recipientName={record.depositorName}
      recipientPhone={record.depositorPhone}
      documentType={record.status === 'RETURNED' ? 'AMANAT_RETURN' : 'AMANAT_RECEIPT'}
      documentNumber={record.recordNumber}
      amount={record.type === 'CASH' ? record.amount : undefined}
      date={record.receivedDate}
      notes={record.notes}
      itemsSummary={record.type === 'ITEM' ? `${record.itemDescription} (رقم: ${record.itemSerial || 'بدون'})` : undefined}
    />
  </>
);
};
