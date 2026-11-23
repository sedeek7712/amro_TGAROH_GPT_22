/**
 * تجهيز بيانات إشعارات العملاء والموردين والمودعين بدقة مالية متسقة
 * دون تعديل أي معادلات محاسبية في المحرك
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
  amount?: number;
  date?: string;
  activityName?: string;
  balanceRemaining?: number;
  itemsSummary?: string;
  notes?: string;
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
    amount: invoice.total,
    date: invoice.date,
    activityName,
    balanceRemaining: isReturn ? undefined : remaining,
    itemsSummary,
    notes,
  };
}

export function buildAmanatNotificationPayload(record: AmanatRecord): NotificationPayload {
  const isReturned = record.status === 'RETURNED';
  const hasPartialReturn = record.status === 'HELD' && Number(record.returnedAmount || 0) > 0;
  const latestReturnEvent =
    record.returnHistory && record.returnHistory.length > 0
      ? record.returnHistory[record.returnHistory.length - 1]
      : undefined;

  let amount: number | undefined;
  if (record.type === 'CASH') {
    if (isReturned) {
      amount = roundMoney(
        latestReturnEvent?.amount && record.returnHistory && record.returnHistory.length > 1
          ? Number(record.returnedAmount || latestReturnEvent.amount)
          : Number(record.returnedAmount || record.amount || 0)
      );
    } else if (hasPartialReturn) {
      amount = roundMoney(
        record.remainingAmount ?? Math.max(0, record.amount - (record.returnedAmount || 0))
      );
    } else {
      amount = roundMoney(record.amount);
    }
  }

  const date = isReturned
    ? record.returnedDate || latestReturnEvent?.date || record.receivedDate
    : hasPartialReturn && latestReturnEvent?.date
    ? latestReturnEvent.date
    : record.receivedDate;

  const notesParts: string[] = [];
  if (record.type === 'ITEM' && record.itemDescription) {
    notesParts.push(`أمانة عينية: ${record.itemDescription}`);
  } else if (record.type === 'CASH') {
    if (isReturned) {
      notesParts.push('تم تسليم الأمانة النقدية وإبراء الذمة');
    } else if (hasPartialReturn) {
      notesParts.push(
        `إجمالي المودع: ${record.amount.toFixed(2)} | المردود: ${Number(record.returnedAmount || 0).toFixed(2)}`
      );
    } else if (record.status === 'CANCELLED') {
      notesParts.push(`أمانة ملغاة${record.cancelledReason ? `: ${record.cancelledReason}` : ''}`);
    } else {
      notesParts.push('أمانة نقدية محفوظة');
    }
  }
  if (record.notes) notesParts.push(record.notes);

  return {
    recipientName: record.depositorName,
    recipientPhone: record.depositorPhone,
    documentType: isReturned ? 'AMANAT_RETURN' : 'AMANAT_RECEIPT',
    documentNumber: record.recordNumber,
    amount,
    date,
    itemsSummary:
      record.type === 'ITEM'
        ? `${record.itemDescription || 'أمانة عينية'}${record.itemSerial ? ` (رقم: ${record.itemSerial})` : ''}`
        : undefined,
    notes: notesParts.filter(Boolean).join(' — '),
  };
}
