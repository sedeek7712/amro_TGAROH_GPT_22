/**
 * خدمة تجهيز المستندات الموحدة (DocumentService)
 * مصدر البيانات الوحيد المشترك بين المعاينة والطباعة وPDF وPNG والإشعارات
 * - قراءة فقط من البيانات المحاسبية المعتمدة دون أي تعديل على الأرصدة أو القيود.
 */

import type {
  AmanatRecord,
  AmanatReturnEvent,
  Invoice,
  JournalEntry,
  Party,
  PaymentAllocation,
  PaymentVoucher,
  SystemUser,
} from '../../types/erp';
import { roundMoney } from '../../config/currency';
import { hasPermission } from '../../config/rbac';
import { numberToArabicWords } from '../../../electron/sqlite/payment-allocation-engine.mjs';
import type { ResolvedDocumentHeader } from '../../utils/documentBranding';
import { formatLocalDate, formatLocalDateTime } from '../../utils/localDate';
import type { PartyStatementSummary } from '../../utils/partyStatement';
import {
  computeInvoiceOpenRemaining,
  validateAmanatDocumentState,
} from '../../utils/documentNotifications';

export type SupportedDocumentPaperSize = 'A4' | '80mm' | '58mm';

export type DocumentKind =
  | 'SALE'
  | 'RETURN_SALE'
  | 'PURCHASE'
  | 'RETURN_PURCHASE'
  | 'RECEIPT_VOUCHER'
  | 'PAYMENT_VOUCHER'
  | 'AMANAT_RECEIPT'
  | 'AMANAT_RETURN'
  | 'STATEMENT'
  | 'JOURNAL'
  | 'REPORT';

export interface DocumentSnapshotField {
  label: string;
  value: string;
}

export interface DocumentSnapshotTableColumn {
  label: string;
  align?: 'right' | 'center' | 'left';
  widthWeight?: number;
}

export interface DocumentSnapshotTable {
  columns: DocumentSnapshotTableColumn[];
  rows: string[][];
}

export interface DocumentSnapshot {
  documentId: string;
  documentNumber: string;
  documentKind: DocumentKind;
  documentTitle: string;
  documentSubtitle?: string;
  statusLabel?: string;
  statusTone?: 'neutral' | 'success' | 'warning' | 'danger';
  date: string;
  issuedAtTabular: string;
  paperSize: SupportedDocumentPaperSize;
  meta: ResolvedDocumentHeader;
  partyName?: string;
  partyPhone?: string;
  amount?: number;
  amountLabel?: string;
  amountInWords?: string;
  remainingBalance?: number;
  remainingLabel?: string;
  fields: DocumentSnapshotField[];
  table?: DocumentSnapshotTable;
  totalsRows?: Array<{ label: string; value: string; highlight?: boolean }>;
  notes?: string;
  referenceText: string;
  signatures?: Array<{ roleLabel: string; name?: string }>;
  isMultiPage: boolean;
  recommendedShareFormat: 'PNG' | 'PDF';
  officialFileBaseName: string;
}

const FILENAME_PREFIX_BY_KIND: Record<DocumentKind, string> = {
  SALE: 'SALES',
  RETURN_SALE: 'RETURN-SALE',
  PURCHASE: 'PURCHASE',
  RETURN_PURCHASE: 'RETURN-PURCHASE',
  RECEIPT_VOUCHER: 'RECEIPT',
  PAYMENT_VOUCHER: 'PAYMENT',
  AMANAT_RECEIPT: 'AMANAT',
  AMANAT_RETURN: 'AMANAT',
  STATEMENT: 'STATEMENT',
  JOURNAL: 'JOURNAL',
  REPORT: 'REPORT',
};

/**
 * توحيد أسماء الملفات الآمنة طبقاً للبند 5.2 من الوثيقة:
 * مثال: RECEIPT-1025-2026-11-23.pdf ، AMANAT-AMN-101-2026-11-23.pdf
 */
export function buildStructuredDocumentFilename(params: {
  kind: DocumentKind;
  documentNumber: string;
  date?: string;
  ext: 'pdf' | 'png';
}): string {
  const prefix = FILENAME_PREFIX_BY_KIND[params.kind] || 'DOC';
  const cleanDate = /^\d{4}-\d{2}-\d{2}$/.test(String(params.date || '').trim())
    ? String(params.date).trim()
    : formatLocalDate();

  const rawDoc = String(params.documentNumber || 'DOCUMENT')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);

  const upperDoc = rawDoc.toUpperCase();
  const baseWithPrefix = upperDoc.startsWith(`${prefix}-`)
    ? upperDoc
    : `${prefix}-${upperDoc || 'DOCUMENT'}`;

  const fullBase = baseWithPrefix.endsWith(`-${cleanDate}`)
    ? baseWithPrefix
    : `${baseWithPrefix}-${cleanDate}`;

  return `${fullBase}.${params.ext}`;
}

export function buildStructuredBaseName(params: {
  kind: DocumentKind;
  documentNumber: string;
  date?: string;
}): string {
  return buildStructuredDocumentFilename({ ...params, ext: 'pdf' }).replace(/\.pdf$/i, '');
}

/**
 * التحقق من صلاحية الاطلاع/المشاركة وبيانات المستلم (البند 11)
 */
export function validateShareAuthorization(params: {
  actor?: SystemUser | null;
  documentKind: DocumentKind;
  expectedPartyName?: string;
  actualRecipientName?: string;
}): { allowed: boolean; error?: string } {
  const { actor, documentKind, expectedPartyName, actualRecipientName } = params;
  if (actor) {
    if (documentKind === 'REPORT') {
      if (!hasPermission(actor, 'view:reports')) {
        return { allowed: false, error: 'ليست لديك صلاحية تصدير أو مشاركة هذا التقرير.' };
      }
    } else if (documentKind === 'JOURNAL') {
      if (!hasPermission(actor, 'view:accounting')) {
        return { allowed: false, error: 'ليست لديك صلاحية تصدير أو مشاركة القيود المحاسبية.' };
      }
    } else if (documentKind === 'AMANAT_RECEIPT' || documentKind === 'AMANAT_RETURN') {
      if (!hasPermission(actor, 'amanat:view')) {
        return { allowed: false, error: 'ليست لديك صلاحية مشاركة مستندات الأمانات.' };
      }
    }
  }

  if (
    expectedPartyName &&
    actualRecipientName &&
    expectedPartyName.trim() !== actualRecipientName.trim()
  ) {
    return {
      allowed: false,
      error: 'عدم تطابق اسم المستلم مع صاحب المستند؛ أوقفت المشاركة منعاً لتسريب بيانات عميل آخر.',
    };
  }

  return { allowed: true };
}

export function buildInvoiceDocumentSnapshot(params: {
  invoice: Invoice;
  meta: ResolvedDocumentHeader;
  paperSize?: SupportedDocumentPaperSize;
  partyPhone?: string;
}): DocumentSnapshot {
  const { invoice, meta, partyPhone } = params;
  const paperSize = params.paperSize || 'A4';
  const dec = meta.currency.decimalPlaces ?? 2;
  const sym = meta.currency.symbol;
  const isPurchase = invoice.type === 'PURCHASE' || invoice.type === 'RETURN_PURCHASE';
  const isReturn = invoice.type === 'RETURN_SALE' || invoice.type === 'RETURN_PURCHASE';
  const remaining = computeInvoiceOpenRemaining(invoice);

  const titleMap: Record<Invoice['type'], string> = {
    SALE: 'فاتورة مبيعات',
    RETURN_SALE: 'إشعار دائن / مرتجع مبيعات',
    PURCHASE: 'فاتورة مشتريات',
    RETURN_PURCHASE: 'إشعار مدين / مرتجع مشتريات',
  };

  const payLabels: Record<string, string> = {
    CASH: 'نقداً',
    CREDIT: 'آجل (ذمم)',
    BANK_TRANSFER: 'تحويل بنكي',
  };

  const itemCount = invoice.items.length;
  const isMultiPage = itemCount > 18;

  const totalsRows: Array<{ label: string; value: string; highlight?: boolean }> = [
    { label: 'المجموع الفرعي', value: `${Number(invoice.subtotal || 0).toFixed(dec)} ${sym}` },
  ];
  if (Number(invoice.discount || 0) > 0) {
    totalsRows.push({ label: 'الخصم', value: `-${Number(invoice.discount).toFixed(dec)} ${sym}` });
  }
  if (Number(invoice.tax || 0) > 0) {
    totalsRows.push({ label: 'الضريبة', value: `${Number(invoice.tax).toFixed(dec)} ${sym}` });
  }
  if (!isReturn && remaining > 0) {
    totalsRows.push({
      label: isPurchase ? 'المتبقي للمورد' : 'المتبقي على العميل',
      value: `${remaining.toFixed(dec)} ${sym}`,
      highlight: true,
    });
  }

  return {
    documentId: invoice.id,
    documentNumber: invoice.invoiceNumber,
    documentKind: invoice.type,
    documentTitle: titleMap[invoice.type],
    documentSubtitle: meta.activityName,
    statusLabel:
      invoice.status === 'REVERSED'
        ? 'معكوسة'
        : isReturn
        ? 'مرتجع معتمد'
        : remaining <= 0
        ? 'مسددة بالكامل'
        : 'مفتوحة / آجل',
    statusTone:
      invoice.status === 'REVERSED'
        ? 'danger'
        : isReturn
        ? 'warning'
        : remaining <= 0
        ? 'success'
        : 'neutral',
    date: invoice.date,
    issuedAtTabular: formatLocalDateTime().displayTabular,
    paperSize,
    meta,
    partyName: invoice.partyName || 'عميل نقدي',
    partyPhone,
    amount: Number(invoice.total || 0),
    amountLabel: isReturn ? 'صافي قيمة المرتجع' : 'الإجمالي النهائي',
    amountInWords: numberToArabicWords(Number(invoice.total || 0), meta.currency.nameAr),
    remainingBalance: isReturn ? undefined : remaining,
    remainingLabel: isPurchase ? 'المتبقي للمورد' : 'المتبقي ذمة',
    fields: [
      { label: isPurchase ? 'المورد' : 'العميل', value: invoice.partyName || 'عميل نقدي' },
      ...(partyPhone ? [{ label: 'الهاتف', value: partyPhone }] : []),
      { label: 'طريقة الدفع', value: payLabels[invoice.paymentMethod] || invoice.paymentMethod },
      ...(meta.activityName ? [{ label: 'النشاط', value: meta.activityName }] : []),
    ],
    table: {
      columns: [
        { label: 'الصنف', align: 'right', widthWeight: 3.4 },
        { label: 'الكمية', align: 'center', widthWeight: 1.1 },
        { label: 'السعر', align: 'center', widthWeight: 1.2 },
        { label: 'الإجمالي', align: 'left', widthWeight: 1.4 },
      ],
      rows: invoice.items.map((item) => [
        item.productName,
        `${item.quantity} ${item.unit || ''}`.trim(),
        Number(item.unitPrice || 0).toFixed(dec),
        Number(item.total || 0).toFixed(dec),
      ]),
    },
    totalsRows,
    notes: invoice.returnReason ? `سبب الإرجاع: ${invoice.returnReason}` : invoice.notes,
    referenceText: `REF: ${invoice.invoiceNumber}`,
    signatures: [
      { roleLabel: 'أعدّه / البائع', name: meta.issuerName },
      { roleLabel: isPurchase ? 'المورد' : 'العميل', name: invoice.partyName },
    ],
    isMultiPage,
    recommendedShareFormat: isMultiPage ? 'PDF' : 'PNG',
    officialFileBaseName: buildStructuredBaseName({
      kind: invoice.type,
      documentNumber: invoice.invoiceNumber,
      date: invoice.date,
    }),
  };
}

export function buildCashVoucherDocumentSnapshot(params: {
  voucher: PaymentVoucher;
  meta: ResolvedDocumentHeader;
  paperSize?: SupportedDocumentPaperSize;
  cashBoxName?: string;
  allocations?: PaymentAllocation[];
  partyPhone?: string;
}): DocumentSnapshot {
  const { voucher, meta, cashBoxName, allocations = [], partyPhone } = params;
  const paperSize = params.paperSize || 'A4';
  const dec = meta.currency.decimalPlaces ?? 2;
  const sym = meta.currency.symbol;
  const isReceipt = voucher.type === 'RECEIPT';
  const kind: DocumentKind = isReceipt ? 'RECEIPT_VOUCHER' : 'PAYMENT_VOUCHER';
  const effectiveAllocations = allocations.length > 0 ? allocations : voucher.allocations || [];
  const docNum = voucher.voucherNumber || voucher.id.slice(0, 8);
  const isMultiPage = effectiveAllocations.length > 16;

  return {
    documentId: voucher.id,
    documentNumber: docNum,
    documentKind: kind,
    documentTitle: isReceipt ? 'سند قبض مالي' : 'سند صرف مالي',
    documentSubtitle:
      voucher.voucherMode === 'CUSTOMER_RECEIPT'
        ? 'تحصيل من عميل'
        : voucher.voucherMode === 'SUPPLIER_PAYMENT'
        ? 'سداد لمورد'
        : 'حركة نقدية / بنكية',
    statusLabel:
      voucher.status === 'DRAFT'
        ? 'مسودة'
        : voucher.status === 'REVERSED'
        ? 'معكوس'
        : voucher.status === 'CANCELLED'
        ? 'ملغى'
        : 'مرحّل قطعي',
    statusTone:
      voucher.status === 'REVERSED'
        ? 'danger'
        : voucher.status === 'DRAFT'
        ? 'warning'
        : voucher.status === 'CANCELLED'
        ? 'neutral'
        : 'success',
    date: voucher.date,
    issuedAtTabular: formatLocalDateTime().displayTabular,
    paperSize,
    meta,
    partyName: voucher.partyName,
    partyPhone,
    amount: Number(voucher.amount || 0),
    amountLabel: isReceipt ? 'إجمالي المبلغ المقبوض' : 'إجمالي المبلغ المصروف',
    amountInWords: numberToArabicWords(Number(voucher.amount || 0), meta.currency.nameAr),
    fields: [
      { label: isReceipt ? 'استلمنا من' : 'صرفنا إلى', value: voucher.partyName },
      { label: 'الصندوق / البنك', value: cashBoxName || voucher.cashBoxId },
      { label: 'الحساب المقابل', value: voucher.accountCode },
      { label: 'البيان', value: voucher.description || '-' },
    ],
    table:
      effectiveAllocations.length > 0
        ? {
            columns: [
              { label: 'رقم الفاتورة', align: 'right', widthWeight: 2.2 },
              { label: 'الطريقة', align: 'center', widthWeight: 1.1 },
              { label: 'المخصص', align: 'left', widthWeight: 1.5 },
            ],
            rows: effectiveAllocations.map((al) => [
              al.invoiceNumber || al.invoiceId,
              al.allocationMethod === 'MANUAL' ? 'يدوي' : 'FIFO',
              `${Number(al.allocatedAmount || 0).toFixed(dec)} ${sym}`,
            ]),
          }
        : undefined,
    totalsRows: [
      ...(Number(voucher.appliedToDebtAmount || 0) > 0
        ? [
            {
              label: 'المخصص لتسوية الذمم',
              value: `${Number(voucher.appliedToDebtAmount).toFixed(dec)} ${sym}`,
            },
          ]
        : []),
      ...(Number(voucher.advanceAmount || 0) > 0
        ? [
            {
              label: 'الرصيد المقدم / السلفة',
              value: `${Number(voucher.advanceAmount).toFixed(dec)} ${sym}`,
              highlight: true,
            },
          ]
        : []),
    ],
    notes: voucher.reversalReason || voucher.cancelledReason || voucher.overrideReason,
    referenceText: `REF: ${docNum}`,
    signatures: [
      { roleLabel: 'أمين الصندوق / المحاسب', name: voucher.createdByName || meta.issuerName },
      { roleLabel: isReceipt ? 'توقيع المودع' : 'توقيع المستلم', name: voucher.partyName },
    ],
    isMultiPage,
    recommendedShareFormat: isMultiPage ? 'PDF' : 'PNG',
    officialFileBaseName: buildStructuredBaseName({
      kind,
      documentNumber: docNum,
      date: voucher.date,
    }),
  };
}

export function buildAmanatDocumentSnapshot(params: {
  record: AmanatRecord;
  meta: ResolvedDocumentHeader;
  paperSize?: SupportedDocumentPaperSize;
  cashBoxName?: string;
  returnEvent?: AmanatReturnEvent;
  returnEventId?: string;
  mode?: 'AUTO' | 'DEPOSIT' | 'RETURN';
}): DocumentSnapshot {
  const { record, meta, cashBoxName } = params;
  const paperSize = params.paperSize || 'A4';
  const dec = meta.currency.decimalPlaces ?? 2;
  const sym = meta.currency.symbol;
  const history = Array.isArray(record.returnHistory) ? record.returnHistory : [];

  const validation = validateAmanatDocumentState(record, {
    mode: params.mode,
    returnEventId: params.returnEventId,
    returnEvent: params.returnEvent,
  });
  if (!validation.valid) {
    throw new Error(
      validation.error ||
        'تعذر تحديد مبلغ عملية رد الأمانة من سجل العمليات (returnHistory).'
    );
  }

  const resolvedReturnEvent = validation.resolvedReturnEvent;

  let returnedTotal = roundMoney(Number(record.returnedAmount || 0));
  let remaining =
    record.status === 'CANCELLED'
      ? 0
      : roundMoney(
          record.remainingAmount !== undefined
            ? Number(record.remainingAmount)
            : Math.max(0, Number(record.amount || 0) - returnedTotal)
        );

  if (resolvedReturnEvent && record.type === 'CASH') {
    const idx = validation.resolvedReturnIndex;
    if (idx >= 0) {
      returnedTotal = roundMoney(
        history.slice(0, idx + 1).reduce((sum, ev) => sum + (Number(ev.amount) || 0), 0)
      );
      remaining = roundMoney(Math.max(0, Number(record.amount || 0) - returnedTotal));
    }
  }

  const isReturnDoc = validation.isReturnDocument;
  const kind: DocumentKind = isReturnDoc ? 'AMANAT_RETURN' : 'AMANAT_RECEIPT';

  const displayAmount =
    record.type === 'CASH'
      ? resolvedReturnEvent && params.mode !== 'DEPOSIT'
        ? roundMoney(Number(resolvedReturnEvent.amount || 0))
        : roundMoney(Number(record.amount || 0))
      : undefined;

  const isMultiPage = history.length > 12;

  return {
    documentId: record.id,
    documentNumber: record.recordNumber,
    documentKind: kind,
    documentTitle:
      resolvedReturnEvent && params.mode !== 'DEPOSIT'
        ? remaining <= 0.005
          ? 'سند تسليم وإبراء ذمة أمانة'
          : 'سند رد جزئي لأمانة نقدية'
        : record.status === 'RETURNED'
        ? 'سند تسليم وإبراء ذمة أمانة'
        : record.status === 'CANCELLED'
        ? 'سند أمانة ملغاة'
        : returnedTotal > 0 && params.mode !== 'DEPOSIT'
        ? 'سند رد جزئي لأمانة نقدية'
        : 'سند استلام وإيداع أمانة',
    documentSubtitle: 'وحدة الأمانات وحفظ أموال ومقتنيات الغير (2102)',
    statusLabel:
      resolvedReturnEvent && params.mode !== 'DEPOSIT'
        ? remaining <= 0.005
          ? 'تم الرد والإبراء'
          : 'رد جزئي'
        : record.status === 'RETURNED'
        ? 'تم الرد والإبراء'
        : record.status === 'CANCELLED'
        ? 'ملغاة'
        : returnedTotal > 0
        ? 'رد جزئي'
        : 'محفوظة في الأمانات',
    statusTone:
      record.status === 'CANCELLED'
        ? 'danger'
        : (resolvedReturnEvent ? remaining <= 0.005 : record.status === 'RETURNED')
        ? 'success'
        : returnedTotal > 0
        ? 'warning'
        : 'neutral',
    date:
      (params.mode !== 'DEPOSIT' ? resolvedReturnEvent?.date : undefined) ||
      (record.status === 'RETURNED' ? record.returnedDate : undefined) ||
      record.receivedDate,
    issuedAtTabular: formatLocalDateTime().displayTabular,
    paperSize,
    meta,
    partyName: record.depositorName,
    partyPhone: record.depositorPhone,
    amount: displayAmount,
    amountLabel:
      resolvedReturnEvent && params.mode !== 'DEPOSIT'
        ? 'مبلغ عملية الرد الحالية'
        : 'المبلغ الأصلي المودع بأمانة',
    amountInWords:
      displayAmount !== undefined
        ? numberToArabicWords(displayAmount, meta.currency.nameAr)
        : undefined,
    remainingBalance: record.type === 'CASH' ? remaining : undefined,
    remainingLabel: 'الرصيد المتبقي بالأمانة',
    fields: [
      { label: 'اسم المودع', value: record.depositorName },
      { label: 'رقم الهاتف', value: record.depositorPhone || '-' },
      { label: 'طبيعة الأمانة', value: record.type === 'CASH' ? 'أمانة نقدية' : 'أمانة عينية' },
      ...(cashBoxName || record.storageLocation
        ? [{ label: 'الصندوق / الحفظ', value: cashBoxName || record.storageLocation || '-' }]
        : []),
      ...(record.type === 'ITEM' && record.itemDescription
        ? [{ label: 'وصف الصنف العيني', value: record.itemDescription }]
        : []),
    ],
    totalsRows:
      record.type === 'CASH'
        ? [
            { label: 'أصل الأمانة', value: `${Number(record.amount || 0).toFixed(dec)} ${sym}` },
            { label: 'إجمالي المردود', value: `${returnedTotal.toFixed(dec)} ${sym}` },
            { label: 'الرصيد المتبقي', value: `${remaining.toFixed(dec)} ${sym}`, highlight: true },
          ]
        : undefined,
    notes: resolvedReturnEvent?.notes || record.notes || record.cancelledReason,
    referenceText: `REF: ${record.recordNumber}`,
    signatures: [
      { roleLabel: 'المستلم (الموظف)', name: record.receivedBy },
      { roleLabel: 'المودع / صاحب الأمانة', name: record.depositorName },
    ],
    isMultiPage,
    recommendedShareFormat: isMultiPage ? 'PDF' : 'PNG',
    officialFileBaseName: buildStructuredBaseName({
      kind,
      documentNumber: record.recordNumber,
      date: (params.mode !== 'DEPOSIT' ? resolvedReturnEvent?.date : undefined) || record.receivedDate,
    }),
  };
}

export function buildPartyStatementDocumentSnapshot(params: {
  statement: PartyStatementSummary;
  meta: ResolvedDocumentHeader;
  paperSize?: SupportedDocumentPaperSize;
  startDate?: string;
  endDate?: string;
}): DocumentSnapshot {
  const { statement, meta } = params;
  const paperSize = params.paperSize || 'A4';
  const dec = meta.currency.decimalPlaces ?? 2;
  const sym = meta.currency.symbol;
  const isCustomer = statement.party.type === 'CUSTOMER';
  const docNum = `STMT-${statement.party.id.slice(0, 8).toUpperCase()}`;
  const isMultiPage = statement.transactions.length > 10;
  const today = formatLocalDate();

  return {
    documentId: statement.party.id,
    documentNumber: docNum,
    documentKind: 'STATEMENT',
    documentTitle: isCustomer ? 'كشف حساب عميل' : 'كشف حساب مورد',
    documentSubtitle:
      params.startDate || params.endDate
        ? `الفترة: ${params.startDate || 'البداية'} إلى ${params.endDate || 'تاريخه'}`
        : 'كشف حساب مالي تفصيلي',
    date: today,
    issuedAtTabular: formatLocalDateTime().displayTabular,
    paperSize,
    meta,
    partyName: statement.party.nameAr,
    partyPhone: statement.party.phone,
    amount: Math.abs(statement.periodClosingBalance),
    amountLabel: 'الرصيد الختامي المستحق',
    amountInWords: numberToArabicWords(Math.abs(statement.periodClosingBalance), meta.currency.nameAr),
    remainingBalance: statement.periodClosingBalance,
    fields: [
      { label: isCustomer ? 'العميل' : 'المورد', value: statement.party.nameAr },
      ...(statement.party.phone ? [{ label: 'الهاتف', value: statement.party.phone }] : []),
      { label: 'عدد الحركات', value: String(statement.transactions.length) },
    ],
    table: {
      columns: [
        { label: 'التاريخ', align: 'right', widthWeight: 1.2 },
        { label: 'المستند', align: 'right', widthWeight: 1.8 },
        { label: 'مدين', align: 'center', widthWeight: 1.1 },
        { label: 'دائن', align: 'center', widthWeight: 1.1 },
        { label: 'الرصيد', align: 'left', widthWeight: 1.3 },
      ],
      rows: statement.transactions.map((t) => [
        t.date,
        `${t.type} (${t.docNumber})`,
        t.debit > 0 ? t.debit.toFixed(dec) : '-',
        t.credit > 0 ? t.credit.toFixed(dec) : '-',
        `${t.balanceAfter.toFixed(dec)} ${sym}`,
      ]),
    },
    totalsRows: [
      { label: 'الرصيد الافتتاحي', value: `${statement.openingBalance.toFixed(dec)} ${sym}` },
      { label: 'الرصيد الختامي', value: `${statement.periodClosingBalance.toFixed(dec)} ${sym}`, highlight: true },
    ],
    referenceText: `PARTY: ${statement.party.id.slice(0, 8)}`,
    signatures: [
      { roleLabel: 'المحاسب المسؤول', name: meta.issuerName || 'الإدارة المالية' },
      { roleLabel: isCustomer ? 'مصادقة العميل' : 'مصادقة المورد', name: statement.party.nameAr },
    ],
    isMultiPage,
    recommendedShareFormat: isMultiPage ? 'PDF' : 'PNG',
    officialFileBaseName: buildStructuredBaseName({
      kind: 'STATEMENT',
      documentNumber: statement.party.nameAr || docNum,
      date: today,
    }),
  };
}

export function buildJournalVoucherDocumentSnapshot(params: {
  entry: JournalEntry;
  meta: ResolvedDocumentHeader;
  paperSize?: SupportedDocumentPaperSize;
}): DocumentSnapshot {
  const { entry, meta } = params;
  const paperSize = params.paperSize || 'A4';
  const dec = meta.currency.decimalPlaces ?? 2;
  const sym = meta.currency.symbol;
  const totalDebit = entry.lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const isMultiPage = entry.lines.length > 18;

  return {
    documentId: entry.id,
    documentNumber: entry.entryNumber,
    documentKind: 'JOURNAL',
    documentTitle: entry.isAutoGenerated ? 'سند قيد محاسبي آلي' : 'سند قيد يومية / تسوية',
    documentSubtitle: 'دفتر اليومية العامة',
    statusLabel: entry.status === 'REVERSED' ? 'معكوس' : entry.status === 'DRAFT' ? 'مسودة' : 'مرحّل قطعي',
    statusTone: entry.status === 'REVERSED' ? 'danger' : entry.status === 'DRAFT' ? 'warning' : 'success',
    date: entry.date,
    issuedAtTabular: formatLocalDateTime().displayTabular,
    paperSize,
    meta,
    amount: totalDebit,
    amountLabel: 'إجمالي القيد المتوازن',
    amountInWords: numberToArabicWords(totalDebit, meta.currency.nameAr),
    fields: [
      { label: 'رقم القيد', value: entry.entryNumber },
      { label: 'التاريخ', value: entry.date },
      { label: 'البيان العام', value: entry.description || '-' },
    ],
    table: {
      columns: [
        { label: 'الحساب', align: 'right', widthWeight: 3 },
        { label: 'مدين', align: 'center', widthWeight: 1.2 },
        { label: 'دائن', align: 'center', widthWeight: 1.2 },
      ],
      rows: entry.lines.map((l) => [
        `${l.accountCode} - ${l.accountName}`,
        Number(l.debit || 0) > 0 ? `${Number(l.debit).toFixed(dec)} ${sym}` : '-',
        Number(l.credit || 0) > 0 ? `${Number(l.credit).toFixed(dec)} ${sym}` : '-',
      ]),
    },
    notes: entry.reversalReason,
    referenceText: `JE: ${entry.entryNumber}`,
    signatures: [
      { roleLabel: 'أعدّ القيد', name: meta.issuerName },
      { roleLabel: 'المراجع المحاسبي' },
    ],
    isMultiPage,
    recommendedShareFormat: isMultiPage ? 'PDF' : 'PNG',
    officialFileBaseName: buildStructuredBaseName({
      kind: 'JOURNAL',
      documentNumber: entry.entryNumber,
      date: entry.date,
    }),
  };
}

export function buildReportDocumentSnapshot(params: {
  reportKey: string;
  reportTitle: string;
  reportSubtitle?: string;
  meta: ResolvedDocumentHeader;
  paperSize?: SupportedDocumentPaperSize;
  date?: string;
  summaryRows: Array<{ label: string; value: string }>;
  table?: DocumentSnapshotTable;
}): DocumentSnapshot {
  const today = params.date || formatLocalDate();
  return {
    documentId: params.reportKey,
    documentNumber: `RPT-${params.reportKey.toUpperCase()}`,
    documentKind: 'REPORT',
    documentTitle: params.reportTitle,
    documentSubtitle: params.reportSubtitle,
    date: today,
    issuedAtTabular: formatLocalDateTime().displayTabular,
    paperSize: params.paperSize || 'A4',
    meta: params.meta,
    fields: params.summaryRows.map((r) => ({ label: r.label, value: r.value })),
    table: params.table,
    referenceText: `RPT-${params.reportKey.toUpperCase()}`,
    isMultiPage: true, // التقارير الرسمية تُعامل كمستندات متعددة الصفحات: PDF هو المعتمد
    recommendedShareFormat: 'PDF',
    officialFileBaseName: buildStructuredBaseName({
      kind: 'REPORT',
      documentNumber: params.reportKey.toUpperCase(),
      date: today,
    }),
  };
}
