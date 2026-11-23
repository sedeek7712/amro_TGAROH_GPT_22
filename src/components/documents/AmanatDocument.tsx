import React from 'react';
import type { AmanatRecord } from '../../types/erp';
import type { ResolvedDocumentHeader } from '../../utils/documentBranding';
import type { DocumentPaperSize } from '../../utils/printDocument';
import {
  DocumentAmountBanner,
  DocumentFooter,
  DocumentHeader,
  DocumentMetaGrid,
  DocumentSignatures,
} from './DocumentPrimitives';

interface AmanatDocumentProps {
  record: AmanatRecord;
  meta: ResolvedDocumentHeader;
  paperSize: DocumentPaperSize;
  cashBoxName?: string;
}

export const AmanatDocument: React.FC<AmanatDocumentProps> = ({
  record,
  meta,
  paperSize,
  cashBoxName,
}) => {
  const isThermal = paperSize === '80mm' || paperSize === '58mm';
  const dec = meta.currency.decimalPlaces ?? 2;
  const sym = meta.currency.symbol;
  const returnedAmt = Number(record.returnedAmount || 0);
  const remainingAmt =
    record.status === 'CANCELLED'
      ? 0
      : Number(
          record.remainingAmount ?? Math.max(0, Number(record.amount || 0) - returnedAmt)
        );

  const docTitle =
    record.status === 'RETURNED'
      ? 'سند تسليم وإبراء ذمة أمانة'
      : record.status === 'CANCELLED'
      ? 'سند أمانة ملغاة'
      : returnedAmt > 0
      ? 'سند أمانة (رد جزئي والباقي محفوظ)'
      : 'سند استلام وإيداع أمانة';

  const statusTone =
    record.status === 'RETURNED'
      ? 'success'
      : record.status === 'CANCELLED'
      ? 'danger'
      : returnedAmt > 0
      ? 'warning'
      : 'neutral';

  const statusLabel =
    record.status === 'RETURNED'
      ? 'تم الرد والإبراء'
      : record.status === 'CANCELLED'
      ? 'ملغاة'
      : returnedAmt > 0
      ? 'رد جزئي'
      : 'محفوظة في الأمانات';

  return (
    <div dir="rtl" className="text-slate-900">
      <DocumentHeader
        meta={meta}
        paperSize={paperSize}
        documentTitle={docTitle}
        documentSubtitle="وحدة الأمانات وحفظ أموال ومقتنيات الغير (2102)"
        documentNumber={record.recordNumber}
        documentDate={record.receivedDate}
        statusLabel={statusLabel}
        statusTone={statusTone}
      />

      <DocumentMetaGrid
        paperSize={paperSize}
        columns={3}
        fields={[
          { label: 'اسم المودع', value: record.depositorName },
          { label: 'رقم الهاتف', value: record.depositorPhone, mono: true },
          { label: 'رقم الهوية', value: record.depositorNationalId, mono: true },
          {
            label: 'طبيعة الأمانة',
            value: record.type === 'CASH' ? 'أمانة نقدية' : 'أمانة عينية',
          },
          { label: 'الصندوق / موقع الحفظ', value: cashBoxName || record.storageLocation },
          { label: 'تاريخ الاستلام', value: record.receivedDate, mono: true },
          { label: 'تاريخ الإرجاع المتوقع', value: record.expectedReturnDate, mono: true },
          { label: 'تاريخ التسليم النهائي', value: record.returnedDate, mono: true },
          { label: 'الموظف المستلم', value: record.receivedBy },
        ]}
      />

      {record.cancelledDate && (
        <div className="mb-3 rounded-lg border border-rose-300 bg-rose-50 p-2.5 text-xs text-rose-900 doc-break-inside-avoid">
          <div>
            <strong>تاريخ الإلغاء:</strong>{' '}
            <span className="font-mono font-bold">{record.cancelledDate}</span>
          </div>
          {record.cancelledReason && (
            <div className="mt-0.5">
              <strong>سبب الإلغاء:</strong> {record.cancelledReason}
            </div>
          )}
        </div>
      )}

      {record.type === 'CASH' ? (
        <>
          <DocumentAmountBanner
            label={
              record.status === 'RETURNED'
                ? 'إجمالي مبلغ الأمانة المسلم والمبرأ'
                : 'المبلغ الأصلي المودع بأمانة'
            }
            amount={Number(record.amount || 0)}
            currencySymbol={sym}
            currencyNameAr={meta.currency.nameAr}
            paperSize={paperSize}
          />

          {(returnedAmt > 0 || record.remainingAmount !== undefined) && (
            <div
              className={`grid ${
                isThermal ? 'grid-cols-1 gap-1.5 p-2 text-[10px]' : 'grid-cols-2 gap-3 p-2.5 text-xs'
              } rounded-lg border border-slate-200 bg-slate-50 mb-3 doc-break-inside-avoid`}
            >
              <div className="flex justify-between items-center bg-white border border-slate-200 rounded px-2.5 py-1.5">
                <span className="text-slate-600">إجمالي المبلغ المردود:</span>
                <span className="font-mono tabular-nums font-bold text-emerald-800">
                  {returnedAmt.toFixed(dec)} {sym}
                </span>
              </div>
              <div className="flex justify-between items-center bg-white border border-slate-200 rounded px-2.5 py-1.5">
                <span className="text-slate-600">الرصيد المتبقي بالأمانة:</span>
                <span className="font-mono tabular-nums font-bold text-amber-900">
                  {remainingAmt.toFixed(dec)} {sym}
                </span>
              </div>
            </div>
          )}
        </>
      ) : (
        <div
          className={`border border-slate-300 rounded-lg bg-slate-50 mb-3 doc-break-inside-avoid ${
            isThermal ? 'p-2.5 text-[10px] space-y-1' : 'p-4 text-xs space-y-2'
          }`}
        >
          <div className="font-bold text-slate-700">وصف الصنف العيني والمواصفات:</div>
          <div className="bg-white p-2.5 rounded border border-slate-200 font-semibold text-slate-900 leading-relaxed">
            {record.itemDescription || 'لا يوجد وصف تفصيلي'}
          </div>
          {record.itemSerial && (
            <div>
              <span className="text-slate-600">الرقم التسلسلي: </span>
              <span className="font-mono font-bold text-slate-900">{record.itemSerial}</span>
            </div>
          )}
        </div>
      )}

      {record.returnHistory && record.returnHistory.length > 0 && (
        <div className="border border-slate-300 rounded-lg overflow-hidden mb-3">
          <div
            className={`bg-slate-900 text-white font-bold ${
              isThermal ? 'px-2 py-1 text-[10px]' : 'px-3 py-2 text-xs'
            }`}
          >
            سجل دفعات الرد والتسليم
          </div>
          <table className={`w-full text-right ${isThermal ? 'text-[9.5px]' : 'text-xs'}`}>
            <thead>
              <tr className="bg-slate-100 text-slate-700 border-b border-slate-200 font-bold">
                <th className={isThermal ? 'py-1 px-1.5' : 'py-2 px-3'}>التاريخ</th>
                <th className={isThermal ? 'py-1 px-1 text-center' : 'py-2 px-3 text-center'}>
                  المبلغ المردود
                </th>
                <th className={isThermal ? 'py-1 px-1.5' : 'py-2 px-3'}>المستلم والملاحظات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {record.returnHistory.map((ev) => (
                <tr key={ev.id}>
                  <td className={`font-mono ${isThermal ? 'py-1 px-1.5' : 'py-2 px-3'}`}>
                    {ev.date}
                  </td>
                  <td
                    className={`text-center font-mono tabular-nums font-bold ${
                      isThermal ? 'py-1 px-1' : 'py-2 px-3'
                    }`}
                  >
                    {ev.amount > 0 ? `${Number(ev.amount).toFixed(dec)} ${sym}` : 'عيني'}
                  </td>
                  <td className={`text-slate-700 ${isThermal ? 'py-1 px-1.5' : 'py-2 px-3'}`}>
                    {ev.recipientSignatureName || '-'}
                    {ev.notes ? ` — ${ev.notes}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {record.notes && (
        <div
          className={`rounded-lg border border-slate-200 bg-slate-50 text-slate-700 mb-3 doc-break-inside-avoid ${
            isThermal ? 'p-2 text-[10px]' : 'p-3 text-xs'
          }`}
        >
          <strong>شروط وملاحظات الحفظ:</strong> {record.notes}
        </div>
      )}

      <div
        className={`border-t border-dashed border-slate-300 pt-2.5 text-slate-600 leading-relaxed doc-break-inside-avoid ${
          isThermal ? 'text-[9.5px]' : 'text-[11px]'
        }`}
      >
        إقرار: نقر باستلام الأمانة الموضحة أعلاه بحالتها الراهنة ونلتزم بحفظها وردها لصاحبها أو وكيله
        الشرعي بموجب هذا السند الأصلي وإثبات الشخصية.
      </div>

      <DocumentSignatures
        paperSize={paperSize}
        slots={[
          { roleLabel: 'المستلم (الموظف المختص)', name: record.receivedBy },
          { roleLabel: 'المودع / صاحب الأمانة', name: record.depositorName },
        ]}
      />

      <DocumentFooter
        meta={meta}
        paperSize={paperSize}
        referenceText={`REF: ${record.recordNumber}`}
      />
    </div>
  );
};
