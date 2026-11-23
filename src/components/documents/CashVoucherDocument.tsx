import React from 'react';
import type { PaymentAllocation, PaymentVoucher } from '../../types/erp';
import type { ResolvedDocumentHeader } from '../../utils/documentBranding';
import type { DocumentPaperSize } from '../../utils/printDocument';
import {
  DocumentAmountBanner,
  DocumentFooter,
  DocumentHeader,
  DocumentMetaGrid,
  DocumentSignatures,
} from './DocumentPrimitives';

interface CashVoucherDocumentProps {
  voucher: PaymentVoucher;
  meta: ResolvedDocumentHeader;
  paperSize: DocumentPaperSize;
  cashBoxName?: string;
  allocations?: PaymentAllocation[];
}

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: 'نقدي',
  BANK_TRANSFER: 'تحويل بنكي',
  CHECK: 'شيك',
};

const STATUS_META: Record<
  NonNullable<PaymentVoucher['status']>,
  { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }
> = {
  POSTED: { label: 'مرحّل قطعي', tone: 'success' },
  DRAFT: { label: 'مسودة غير مرحلة', tone: 'warning' },
  REVERSED: { label: 'معكوس بقيد عكسي', tone: 'danger' },
  CANCELLED: { label: 'ملغى', tone: 'neutral' },
};

export const CashVoucherDocument: React.FC<CashVoucherDocumentProps> = ({
  voucher,
  meta,
  paperSize,
  cashBoxName,
  allocations = [],
}) => {
  const isThermal = paperSize === '80mm';
  const isReceipt = voucher.type === 'RECEIPT';
  const statusKey = voucher.status || 'POSTED';
  const statusInfo = STATUS_META[statusKey] || STATUS_META.POSTED;
  const dec = meta.currency.decimalPlaces ?? 2;
  const sym = meta.currency.symbol;

  const effectiveAllocations =
    allocations.length > 0 ? allocations : voucher.allocations || [];

  return (
    <div dir="rtl" className="text-slate-900">
      <DocumentHeader
        meta={meta}
        paperSize={paperSize}
        documentTitle={isReceipt ? 'سند قبض مالي' : 'سند صرف مالي'}
        documentSubtitle={
          voucher.voucherMode === 'CUSTOMER_RECEIPT'
            ? 'تحصيل من عميل'
            : voucher.voucherMode === 'SUPPLIER_PAYMENT'
            ? 'سداد لمورد'
            : isReceipt
            ? 'قبض عام'
            : 'صرف عام'
        }
        documentNumber={voucher.voucherNumber || 'مسودة'}
        documentDate={voucher.date}
        statusLabel={statusInfo.label}
        statusTone={statusInfo.tone}
      />

      <DocumentMetaGrid
        paperSize={paperSize}
        columns={3}
        fields={[
          {
            label: isReceipt ? 'استلمنا من' : 'صُرف إلى',
            value: voucher.partyName || '-',
          },
          {
            label: 'الصندوق / الحساب البنكي',
            value: cashBoxName || voucher.cashBoxId || '-',
          },
          {
            label: 'وسيلة الدفع',
            value: `${PAYMENT_METHOD_LABELS[voucher.paymentMethod || 'CASH'] || 'نقدي'}${
              voucher.externalRef ? ` (${voucher.externalRef})` : ''
            }`,
          },
          { label: 'الحساب المقابل', value: voucher.accountCode, mono: true },
          {
            label: 'مرجع القيد المحاسبي',
            value: voucher.journalEntryId || 'غير مرحل بعد',
            mono: true,
          },
          {
            label: 'حرر بواسطة',
            value: voucher.createdByName || meta.issuerName,
          },
          { label: 'البيان / الشرح', value: voucher.description, fullWidth: true },
        ]}
      />

      {voucher.reversalReason && (
        <div className="mb-3 rounded-lg border border-rose-300 bg-rose-50 p-2.5 text-xs text-rose-900 doc-break-inside-avoid">
          <strong>سبب العكس الموثق:</strong> {voucher.reversalReason}
          {voucher.reversedByJournalId && (
            <span className="block font-mono text-[10px] mt-0.5">
              القيد العكسي: {voucher.reversedByJournalId}
            </span>
          )}
        </div>
      )}

      {voucher.cancelledReason && (
        <div className="mb-3 rounded-lg border border-slate-300 bg-slate-100 p-2.5 text-xs text-slate-800 doc-break-inside-avoid">
          <strong>سبب إلغاء المسودة:</strong> {voucher.cancelledReason}
        </div>
      )}

      <DocumentAmountBanner
        label={isReceipt ? 'إجمالي المبلغ المقبوض' : 'إجمالي المبلغ المصروف'}
        amount={Number(voucher.amount || 0)}
        currencySymbol={sym}
        currencyNameAr={meta.currency.nameAr}
        paperSize={paperSize}
      />

      {((voucher.appliedToDebtAmount || 0) > 0 || (voucher.advanceAmount || 0) > 0) && (
        <div
          className={`grid ${
            isThermal ? 'grid-cols-1 gap-1.5 p-2 text-[10px]' : 'grid-cols-2 gap-3 p-2.5 text-xs'
          } rounded-lg border border-slate-200 bg-slate-50 mb-3 doc-break-inside-avoid`}
        >
          <div className="flex justify-between items-center bg-white border border-slate-200 rounded px-2.5 py-1.5">
            <span className="text-slate-600">المخصص لتسوية الذمم:</span>
            <span className="font-mono tabular-nums font-bold text-slate-900">
              {Number(voucher.appliedToDebtAmount || 0).toFixed(dec)} {sym}
            </span>
          </div>
          <div className="flex justify-between items-center bg-white border border-slate-200 rounded px-2.5 py-1.5">
            <span className="text-slate-600">الرصيد المقدم / السلفة الناتجة:</span>
            <span className="font-mono tabular-nums font-bold text-indigo-800">
              {Number(voucher.advanceAmount || 0).toFixed(dec)} {sym}
            </span>
          </div>
        </div>
      )}

      {voucher.manualOverride && (
        <div className="mb-3 rounded-lg border border-purple-200 bg-purple-50 px-3 py-2 text-[11px] text-purple-950 doc-break-inside-avoid">
          <strong>تخصيص يدوي معتمد:</strong>{' '}
          {voucher.overrideReason || 'تجاوز آلية FIFO بصلاحية مشرف'}
        </div>
      )}

      {effectiveAllocations.length > 0 && (
        <div className="border border-slate-300 rounded-lg overflow-hidden mb-3">
          <div
            className={`bg-slate-900 text-white font-bold ${
              isThermal ? 'px-2 py-1 text-[10px]' : 'px-3 py-2 text-xs'
            }`}
          >
            تفاصيل تخصيص الفواتير
          </div>
          <table className={`w-full text-right ${isThermal ? 'text-[9.5px]' : 'text-xs'}`}>
            <thead>
              <tr className="bg-slate-100 text-slate-700 border-b border-slate-200 font-bold">
                <th className={isThermal ? 'py-1 px-1.5' : 'py-2 px-3'}>رقم الفاتورة</th>
                {!isThermal && <th className="py-2 px-3">التاريخ</th>}
                <th className={isThermal ? 'py-1 px-1' : 'py-2 px-3'}>الطريقة</th>
                <th className={isThermal ? 'py-1 px-1.5 text-left' : 'py-2 px-3 text-left'}>
                  المخصص
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {effectiveAllocations.map((alloc) => (
                <tr key={alloc.id}>
                  <td
                    className={`font-mono font-bold text-slate-900 ${
                      isThermal ? 'py-1 px-1.5' : 'py-2 px-3'
                    }`}
                  >
                    {alloc.invoiceNumber || alloc.invoiceId}
                  </td>
                  {!isThermal && (
                    <td className="py-2 px-3 font-mono text-slate-600">
                      {alloc.invoiceDate || '-'}
                    </td>
                  )}
                  <td className={isThermal ? 'py-1 px-1' : 'py-2 px-3'}>
                    {alloc.allocationMethod === 'MANUAL' ? 'يدوي' : 'FIFO'}
                    {alloc.status === 'REVERSED' ? ' (معكوس)' : ''}
                  </td>
                  <td
                    className={`text-left font-mono tabular-nums font-bold ${
                      isThermal ? 'py-1 px-1.5' : 'py-2 px-3'
                    }`}
                  >
                    {Number(alloc.allocatedAmount || 0).toFixed(dec)} {sym}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <DocumentSignatures
        paperSize={paperSize}
        slots={[
          { roleLabel: 'أمين الصندوق / المحاسب', name: voucher.createdByName || meta.issuerName },
          { roleLabel: isReceipt ? 'توقيع المودع' : 'توقيع المستلم', name: voucher.partyName },
          { roleLabel: 'اعتماد الإدارة المالية' },
        ]}
      />

      <DocumentFooter
        meta={meta}
        paperSize={paperSize}
        referenceText={`REF: ${voucher.voucherNumber || voucher.id.slice(0, 8)}`}
      />
    </div>
  );
};
