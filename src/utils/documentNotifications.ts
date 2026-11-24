/**
 * تجهيز بيانات إشعارات العملاء والموردين والمودعين بدقة مالية متسقة
 * دون تعديل أي معادلات محاسبية في المحرك
 * يعالج خلل DOC-01:
 * - إشعار الرد الجزئي يعرض مبلغ العملية الحالية المحددة وليس المتبقي أو التراكمي.
 * - التمييز الصريح بين سند الإيداع وسند الرد.
 * - ربط الإشعار بحدث returnHistory المحدد عند تعدد الدفعات.
 * - إيقاف إنشاء إشعار المبلغ عند تعذر تحديد مبلغ العملية بدلاً من اختراع رقم مضلل.
 */

import { roundMoney } from '../config/currency';
import type { AmanatRecord, Invoice } from '../types/erp';

export interface NotificationPayload {
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
  documentId?: string;
  amount?: number;
  date?: string;
  activityName?: string;
  balanceRemaining?: number;
  itemsSummary?: string;
  notes?: string;
  isPartialReturn?: boolean;
  returnEventId?: string;
  totalOriginalAmount?: number;
  cumulativeReturnedAmount?: number;
  error?: string;
}

export interface AmanatNotificationOptions {
  mode?: 'AUTO' | 'DEPOSIT' | 'RETURN';
  returnEventId?: string;
  returnEvent?: import('../types/erp').AmanatReturnEvent;
}

export interface AmanatValidationResult {
  valid: boolean;
  isReturnDocument: boolean;
  resolvedReturnEvent?: NonNullable<AmanatRecord['returnHistory']>[number];
  resolvedReturnIndex: number;
  error?: string;
}

export function validateAmanatDocumentState(
  record: AmanatRecord,
  options?: AmanatNotificationOptions
): AmanatValidationResult {
  const history = Array.isArray(record.returnHistory) ? record.returnHistory : [];
  const mode = options?.mode || 'AUTO';
  const hasReturnedActivity =
    record.status === 'RETURNED' ||
    Number(record.returnedAmount || 0) > 0 ||
    history.length > 0;

  // صريح: وضع الإيداع يُظهر أصل الإيداع ما لم يطلب حدث رد محدد
  if (mode === 'DEPOSIT' && !options?.returnEvent && !options?.returnEventId) {
    return {
      valid: true,
      isReturnDocument: false,
      resolvedReturnEvent: undefined,
      resolvedReturnIndex: -1,
    };
  }

  const isReturnDocument =
    Boolean(options?.returnEvent || options?.returnEventId) ||
    mode === 'RETURN' ||
    (record.status !== 'CANCELLED' && hasReturnedActivity);

  if (record.type === 'CASH' && isReturnDocument) {
    if (options?.returnEvent) {
      const idx = history.findIndex((ev) => ev.id === options.returnEvent!.id);
      const evAmt = roundMoney(Number(options.returnEvent.amount || 0));
      if (idx < 0 || !Number.isFinite(evAmt) || evAmt <= 0) {
        return {
          valid: false,
          isReturnDocument: true,
          resolvedReturnEvent: undefined,
          resolvedReturnIndex: -1,
          error:
            'تعذر التحقق من حدث رد الأمانة النقدية أو أن قيمته غير موجبة في سجل العمليات (returnHistory)؛ تم إيقاف عرض المستند منعاً لعرض أصل المبلغ بالخطأ.',
        };
      }
      return {
        valid: true,
        isReturnDocument: true,
        resolvedReturnEvent: history[idx],
        resolvedReturnIndex: idx,
      };
    }

    if (options?.returnEventId) {
      const idx = history.findIndex((ev) => ev.id === options.returnEventId);
      const found = idx >= 0 ? history[idx] : undefined;
      const evAmt = found ? roundMoney(Number(found.amount || 0)) : 0;
      if (!found || !Number.isFinite(evAmt) || evAmt <= 0) {
        return {
          valid: false,
          isReturnDocument: true,
          resolvedReturnEvent: undefined,
          resolvedReturnIndex: -1,
          error: `تعذر العثور على عملية الرد المحددة (${options.returnEventId}) أو أن قيمتها غير صالحة في سجل عمليات الأمانة (returnHistory).`,
        };
      }
      return {
        valid: true,
        isReturnDocument: true,
        resolvedReturnEvent: found,
        resolvedReturnIndex: idx,
      };
    }

    const latestIdx = history.length - 1;
    const latest = latestIdx >= 0 ? history[latestIdx] : undefined;
    const latestAmt = latest ? roundMoney(Number(latest.amount || 0)) : 0;
    if (!latest || !Number.isFinite(latestAmt) || latestAmt <= 0) {
      return {
        valid: false,
        isReturnDocument: true,
        resolvedReturnEvent: undefined,
        resolvedReturnIndex: -1,
        error:
          'تعذر تحديد مبلغ عملية رد الأمانة المحددة من سجل العمليات (returnHistory)؛ تم إيقاف إنشاء إشعار وسند الرد منعاً لعرض أصل المبلغ أو رقم غير دقيق.',
      };
    }
    return {
      valid: true,
      isReturnDocument: true,
      resolvedReturnEvent: latest,
      resolvedReturnIndex: latestIdx,
    };
  }

  return {
    valid: true,
    isReturnDocument,
    resolvedReturnEvent: undefined,
    resolvedReturnIndex: -1,
  };
}

export function computeInvoiceOpenRemaining(invoice: Invoice): number {
  if (invoice.type === 'RETURN_SALE' || invoice.type === 'RETURN_PURCHASE') {
    return 0;
  }
  return Math.max(
    0,
    roundMoney(
      Number(invoice.total || 0) -
        Number(invoice.paidAmount || 0) -
        Number(invoice.returnedAmount || 0)
    )
  );
}

export function buildInvoiceNotificationPayload(params: {
  invoice: Invoice;
  activityName?: string;
  recipientPhone?: string;
}): NotificationPayload {
  const { invoice, activityName, recipientPhone } = params;
  const itemsSummary = invoice.items
    ? invoice.items.map((i) => `${i.productName} (${i.quantity} ${i.unit})`).join('، ')
    : undefined;

  const isReturn = invoice.type === 'RETURN_SALE' || invoice.type === 'RETURN_PURCHASE';
  const remaining = computeInvoiceOpenRemaining(invoice);

  let notes = invoice.notes;
  if (isReturn) {
    const returnNote = [
      invoice.type === 'RETURN_SALE' ? 'إشعار دائن / مرتجع مبيعات' : 'إشعار مدين / مرتجع مشتريات',
      invoice.originalInvoiceNumber ? `مرجع الفاتورة: ${invoice.originalInvoiceNumber}` : '',
      invoice.returnReason ? `السبب: ${invoice.returnReason}` : '',
    ]
      .filter(Boolean)
      .join(' — ');
    notes = returnNote || notes;
  }

  return {
    recipientName: invoice.partyName,
    recipientPhone: recipientPhone || '',
    documentType: 'INVOICE',
    documentNumber: invoice.invoiceNumber,
    documentId: invoice.id,
    amount: invoice.total,
    date: invoice.date,
    activityName,
    balanceRemaining: isReturn ? undefined : remaining,
    itemsSummary,
    notes,
  };
}

export function buildAmanatNotificationPayload(
  record: AmanatRecord,
  options?: AmanatNotificationOptions
): NotificationPayload {
  const history = Array.isArray(record.returnHistory) ? record.returnHistory : [];
  const validation = validateAmanatDocumentState(record, options);

  if (!validation.valid) {
    return {
      recipientName: record.depositorName,
      recipientPhone: record.depositorPhone,
      documentType: 'AMANAT_RETURN',
      documentNumber: record.recordNumber,
      documentId: record.id,
      amount: undefined,
      balanceRemaining: undefined,
      date: record.returnedDate || record.receivedDate,
      totalOriginalAmount: roundMoney(Number(record.amount || 0)),
      error:
        validation.error ||
        'تعذر تحديد مبلغ عملية رد الأمانة المحددة من سجل العمليات (returnHistory)؛ تم إيقاف إنشاء إشعار المبلغ منعاً لعرض رقم غير دقيق.',
    };
  }

  const mode = options?.mode || 'AUTO';
  if (record.type === 'CASH' && validation.isReturnDocument && validation.resolvedReturnEvent) {
    const targetEvent = validation.resolvedReturnEvent;
    const targetIndex = validation.resolvedReturnIndex;
    const eventAmount = roundMoney(Number(targetEvent.amount || 0));

    // حساب إجمالي المردود حتى هذا الحدث بدقة عند تعدد عمليات الرد
    const cumulativeUpToEvent = roundMoney(
      history
        .slice(0, targetIndex + 1)
        .reduce((sum, ev) => sum + (Number(ev.amount) || 0), 0)
    );
    const remainingAfterEvent = roundMoney(
      Math.max(0, Number(record.amount || 0) - cumulativeUpToEvent)
    );
    const isPartial = remainingAfterEvent > 0.005;

    const notesParts: string[] = [
      isPartial
        ? `رد جزئي من الأمانة النقدية — أصل الأمانة: ${Number(record.amount || 0).toFixed(2)} | إجمالي المردود حتى تاريخه: ${cumulativeUpToEvent.toFixed(2)}`
        : 'تم تسليم الأمانة النقدية وإبراء الذمة بالكامل',
    ];
    if (targetEvent.notes) notesParts.push(targetEvent.notes);
    if (record.notes) notesParts.push(record.notes);

    return {
      recipientName: record.depositorName,
      recipientPhone: record.depositorPhone,
      documentType: 'AMANAT_RETURN',
      documentNumber: record.recordNumber,
      documentId: record.id,
      amount: eventAmount,
      balanceRemaining: remainingAfterEvent,
      date: targetEvent.date || record.returnedDate || record.receivedDate,
      isPartialReturn: isPartial,
      returnEventId: targetEvent.id,
      totalOriginalAmount: roundMoney(Number(record.amount || 0)),
      cumulativeReturnedAmount: cumulativeUpToEvent,
      notes: notesParts.filter(Boolean).join(' — '),
    };
  }

  // سند إيداع أمانة نقدية / أمانة عينية / رد أمانة عينية / ملغاة
  const isItemReturn =
    record.type === 'ITEM' && (record.status === 'RETURNED' || mode === 'RETURN');
  const latestEvent = history.length > 0 ? history[history.length - 1] : undefined;

  const notesParts: string[] = [];
  if (record.type === 'ITEM') {
    notesParts.push(
      isItemReturn
        ? `تم تسليم الأمانة العينية وإبراء الذمة: ${record.itemDescription || 'أمانة عينية'}`
        : `أمانة عينية محفوظة: ${record.itemDescription || 'أمانة عينية'}`
    );
  } else if (record.status === 'CANCELLED') {
    notesParts.push(`أمانة ملغاة${record.cancelledReason ? `: ${record.cancelledReason}` : ''}`);
  } else {
    notesParts.push('إيداع أمانة نقدية محفوظة في السجل المستقل');
  }
  if (record.notes) notesParts.push(record.notes);

  return {
    recipientName: record.depositorName,
    recipientPhone: record.depositorPhone,
    documentType: isItemReturn ? 'AMANAT_RETURN' : 'AMANAT_RECEIPT',
    documentNumber: record.recordNumber,
    documentId: record.id,
    amount: record.type === 'CASH' ? roundMoney(Number(record.amount || 0)) : undefined,
    balanceRemaining:
      record.type === 'CASH' && record.status !== 'CANCELLED'
        ? record.remainingAmount !== undefined
          ? roundMoney(Math.max(0, Number(record.remainingAmount)))
          : roundMoney(
              Math.max(0, Number(record.amount || 0) - Number(record.returnedAmount || 0))
            )
        : undefined,
    date: isItemReturn
      ? record.returnedDate || latestEvent?.date || record.receivedDate
      : record.receivedDate,
    itemsSummary:
      record.type === 'ITEM'
        ? `${record.itemDescription || 'أمانة عينية'}${record.itemSerial ? ` (رقم: ${record.itemSerial})` : ''}`
        : undefined,
    notes: notesParts.filter(Boolean).join(' — '),
  };
}
