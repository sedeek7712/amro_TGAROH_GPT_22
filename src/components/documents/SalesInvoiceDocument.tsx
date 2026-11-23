import React from 'react';
import type { Invoice, InvoiceType } from '../../types/erp';
import type { ResolvedDocumentHeader } from '../../utils/documentBranding';
import type { DocumentPaperSize } from '../../utils/printDocument';
import { computeInvoiceOpenRemaining } from '../../utils/documentNotifications';
import {
  DocumentAmountBanner,
  DocumentFooter,
  DocumentHeader,
  DocumentMetaGrid,
  DocumentSignatures,
} from './DocumentPrimitives';

interface SalesInvoiceDocumentProps {
  invoice: Invoice;
  meta: ResolvedDocumentHeader;
  paperSize: DocumentPaperSize;
  partyPhone?: string;
}

const DOC_TITLES: Record<InvoiceType, { title: string; subtitle: string }> = {
  SALE: { title: 'فاتورة مبيعات', subtitle: 'مستند مبيعات رسمي' },
  RETURN_SALE: { title: 'إشعار دائن / مرتجع مبيعات', subtitle: 'مستند مرتجع مبيعات معتمد' },
  PURCHASE: { title: 'فاتورة مشتريات', subtitle: 'مستند توريد ومشتريات رسمي' },
  RETURN_PURCHASE: { title: 'إشعار مدين / مرتجع مشتريات', subtitle: 'مستند مرتجع مشتريات معتمد' },
};

const PAYMENT_LABELS: Record<string, string> = {
  CASH: 'نقداً',
  CREDIT: 'آجل (ذمم)',
  BANK_TRANSFER: 'تحويل بنكي',
};

export const SalesInvoiceDocument: React.FC<SalesInvoiceDocumentProps> = ({
  invoice,
  meta,
  paperSize,
  partyPhone,
}) => {
  const isThermal = paperSize === '80mm' || paperSize === '58mm';
  const isPurchase = invoice.type === 'PURCHASE' || invoice.type === 'RETURN_PURCHASE';
  const isReturn = invoice.type === 'RETURN_SALE' || invoice.type === 'RETURN_PURCHASE';
  const isReversed = invoice.status === 'REVERSED';
  const docLabel = DOC_TITLES[invoice.type] || DOC_TITLES.SALE;
  const dec = meta.currency.decimalPlaces ?? 2;
  const sym = meta.currency.symbol;

  const advAmount = Number(invoice.advanceAppliedAmount || 0);
  const directCashPortion = isReturn
    ? Number(invoice.paidAmount || 0)
    : Math.max(0, Number((Number(invoice.paidAmount || 0) - advAmount).toFixed(dec)));
  const remainingCredit = computeInvoiceOpenRemaining(invoice);

  const statusLabel = isReversed
    ? 'معكوسة / ملغاة'
    : invoice.isPosted === false
    ? 'مسودة'
    : isReturn
    ? 'مرتجع معتمد'
    : remainingCredit <= 0
    ? 'مسددة بالكامل'
    : 'مفتوحة / آجل';

  const statusTone = isReversed
    ? 'danger'
    : isReturn
    ? 'warning'
    : remainingCredit <= 0
    ? 'success'
    : 'neutral';

  const counterpartyLabel = isPurchase ? 'المورد' : 'العميل';

  return (
    <div dir="rtl" className="text-slate-900">
      <DocumentHeader
        meta={meta}
        paperSize={paperSize}
        documentTitle={docLabel.title}
        documentSubtitle={docLabel.subtitle}
        documentNumber={invoice.invoiceNumber}
        documentDate={invoice.date}
        statusLabel={statusLabel}
        statusTone={statusTone}
      />

      <DocumentMetaGrid
        paperSize={paperSize}
        columns={3}
        fields={[
          { label: counterpartyLabel, value: invoice.partyName || 'عميل نقدي' },
          { label: 'هاتف الطرف', value: partyPhone, mono: true },
          {
            label: 'طريقة الدفع',
            value: PAYMENT_LABELS[invoice.paymentMethod] || invoice.paymentMethod,
          },
          { label: 'النشاط التجاري', value: meta.activityName },
          { label: 'تاريخ الاستحقاق', value: invoice.dueDate, mono: true },
          { label: 'مرجع القيد المحاسبي', value: invoice.journalEntryId, mono: true },
        ]}
      />

      {isReturn && (invoice.originalInvoiceNumber || invoice.returnReason) && (
        <div
          className={`mb-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-950 doc-break-inside-avoid ${
            isThermal ? 'p-2 text-[10px] space-y-0.5' : 'p-3 text-xs space-y-1'
          }`}
        >
          {invoice.originalInvoiceNumber && (
            <div>
              <strong>مرجع الفاتورة الأصلية:</strong>{' '}
              <span className="font-mono font-bold">{invoice.originalInvoiceNumber}</span>
            </div>
          )}
          {invoice.returnReason && (
            <div>
              <strong>سبب الإرجاع:</strong> {invoice.returnReason}
            </div>
          )}
        </div>
      )}

      {isReversed && invoice.reversalReason && (
        <div className="mb-3 rounded-lg border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900 doc-break-inside-avoid">
          <strong>مستند معكوس:</strong> {invoice.reversalReason}
        </div>
      )}

      {/* Items Table */}
      <div className="border border-slate-300 rounded-lg overflow-hidden mb-3">
        <table className={`w-full text-right ${isThermal ? 'text-[10px]' : 'text-xs'}`}>
          <thead>
            <tr className="bg-slate-900 text-white font-bold">
              {!isThermal && <th className="py-2 px-2.5 text-center w-8">#</th>}
              <th className={isThermal ? 'py-1.5 px-1.5' : 'py-2 px-3'}>الصنف</th>
              <th className={isThermal ? 'py-1.5 px-1 text-center' : 'py-2 px-2.5 text-center'}>
                الكمية
              </th>
              <th className={isThermal ? 'py-1.5 px-1 text-center' : 'py-2 px-2.5 text-center'}>
                السعر
              </th>
              {!isThermal && <th className="py-2 px-2.5 text-center">الخصم</th>}
              <th className={isThermal ? 'py-1.5 px-1.5 text-left' : 'py-2 px-3 text-left'}>
                الإجمالي
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {invoice.items.map((item, idx) => (
              <tr key={item.id || idx} className={idx % 2 === 1 ? 'bg-slate-50/70' : 'bg-white'}>
                {!isThermal && (
                  <td className="py-2 px-2.5 text-center font-mono text-slate-500">{idx + 1}</td>
                )}
                <td className={isThermal ? 'py-1.5 px-1.5' : 'py-2 px-3'}>
                  <div className="font-bold text-slate-900">{item.productName}</div>
                  {(item.batchNumber || item.oemNumber || item.productCode) && (
                    <div
                      className={`text-slate-500 font-mono ${
                        isThermal ? 'text-[8.5px]' : 'text-[10px]'
                      }`}
                    >
                      {item.batchNumber ? `تشغيلة: ${item.batchNumber}` : ''}
                      {item.expiryDate ? ` | انتهاء: ${item.expiryDate}` : ''}
                      {item.oemNumber ? ` | OEM: ${item.oemNumber}` : ''}
                    </div>
                  )}
                </td>
                <td
                  className={`text-center font-mono tabular-nums ${
                    isThermal ? 'py-1.5 px-1' : 'py-2 px-2.5'
                  }`}
                >
                  {item.quantity} {isThermal ? '' : item.unit}
                </td>
                <td
                  className={`text-center font-mono tabular-nums ${
                    isThermal ? 'py-1.5 px-1' : 'py-2 px-2.5'
                  }`}
                >
                  {Number(item.unitPrice || 0).toFixed(dec)}
                </td>
                {!isThermal && (
                  <td className="py-2 px-2.5 text-center font-mono tabular-nums text-slate-600">
                    {Number(item.discount || 0) > 0 ? Number(item.discount).toFixed(dec) : '-'}
                  </td>
                )}
                <td
                  className={`text-left font-mono tabular-nums font-bold text-slate-900 ${
                    isThermal ? 'py-1.5 px-1.5' : 'py-2 px-3'
                  }`}
                >
                  {Number(item.total || 0).toFixed(dec)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Totals Breakdown */}
      <div
        className={`border border-slate-200 rounded-lg bg-slate-50 doc-break-inside-avoid ${
          isThermal ? 'p-2.5 text-[10px] space-y-1' : 'p-3.5 text-xs space-y-1.5'
        }`}
      >
        <div className="flex justify-between text-slate-600">
          <span>المجموع الفرعي:</span>
          <span className="font-mono tabular-nums font-semibold">
            {Number(invoice.subtotal || 0).toFixed(dec)} {sym}
          </span>
        </div>
        {Number(invoice.discount || 0) > 0 && (
          <div className="flex justify-between text-rose-700">
            <span>الخصم:</span>
            <span className="font-mono tabular-nums font-semibold">
              -{Number(invoice.discount).toFixed(dec)} {sym}
            </span>
          </div>
        )}
        {Number(invoice.tax || 0) > 0 && (
          <div className="flex justify-between text-slate-600">
            <span>الضريبة:</span>
            <span className="font-mono tabular-nums font-semibold">
              {Number(invoice.tax).toFixed(dec)} {sym}
            </span>
          </div>
        )}
        {Number(invoice.shippingCost || 0) > 0 && (
          <div className="flex justify-between text-slate-600">
            <span>الشحن / التوصيل:</span>
            <span className="font-mono tabular-nums font-semibold">
              {Number(invoice.shippingCost).toFixed(dec)} {sym}
            </span>
          </div>
        )}
        <div className="flex justify-between text-slate-700 border-t border-slate-200 pt-1.5">
          <span>
            {isReturn
              ? isPurchase
                ? 'المبلغ المسترد نقداً:'
                : 'المبلغ المردود نقداً:'
              : isPurchase
              ? 'المسدد عند الشراء:'
              : 'المسدد نقداً / بنكاً:'}
          </span>
          <span className="font-mono tabular-nums font-bold">
            {directCashPortion.toFixed(dec)} {sym}
          </span>
        </div>
        {advAmount > 0 && (
          <div className="flex justify-between text-indigo-800 font-semibold">
            <span>
              {isPurchase
                ? isReturn
                  ? 'مثبت في سلفة المورد (1105):'
                  : 'تسوية من سلفة المورد (1105):'
                : isReturn
                ? 'مرحّل للرصيد المقدم (2103):'
                : 'تسوية من الرصيد المقدم (2103):'}
            </span>
            <span className="font-mono tabular-nums">
              {advAmount.toFixed(dec)} {sym}
            </span>
          </div>
        )}
        {Number(invoice.returnedAmount || 0) > 0 && !isReturn && (
          <div className="flex justify-between text-amber-800 font-semibold">
            <span>قيمة مرتجعات معتمدة مخصومة:</span>
            <span className="font-mono tabular-nums">
              -{Number(invoice.returnedAmount).toFixed(dec)} {sym}
            </span>
          </div>
        )}
        {!isReturn && remainingCredit > 0 && (
          <div className="flex justify-between text-rose-800 font-bold">
            <span>{isPurchase ? 'المتبقي ذمة للمورد:' : 'المتبقي ذمة على العميل:'}</span>
            <span className="font-mono tabular-nums">
              {remainingCredit.toFixed(dec)} {sym}
            </span>
          </div>
        )}
      </div>

      <DocumentAmountBanner
        label={isReturn ? 'صافي قيمة المرتجع' : 'الإجمالي النهائي للمستند'}
        amount={Number(invoice.total || 0)}
        currencySymbol={sym}
        currencyNameAr={meta.currency.nameAr}
        paperSize={paperSize}
      />

      {invoice.notes && (
        <div
          className={`rounded-lg border border-slate-200 bg-slate-50 text-slate-700 doc-break-inside-avoid ${
            isThermal ? 'p-2 text-[10px] mb-2' : 'p-3 text-xs mb-4'
          }`}
        >
          <strong>ملاحظات:</strong> {invoice.notes}
        </div>
      )}

      {!isThermal && (
        <DocumentSignatures
          paperSize={paperSize}
          slots={[
            { roleLabel: 'أعدّه / البائع', name: meta.issuerName },
            { roleLabel: isPurchase ? 'المورد / المندوب' : 'توقيع العميل', name: invoice.partyName },
          ]}
        />
      )}

      <DocumentFooter
        meta={meta}
        paperSize={paperSize}
        referenceText={`REF: ${invoice.invoiceNumber}`}
      />
    </div>
  );
};
