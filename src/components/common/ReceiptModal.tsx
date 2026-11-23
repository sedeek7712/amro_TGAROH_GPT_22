/**
 * نافذة معاينة وطباعة الفواتير والمرتجعات (مبيعات / مشتريات)
 * متوافقة مع طابعات الإيصالات 58mm و 80mm وطابعات A4 الرسمية وتصدير PDF/PNG والمشاركة
 */

import React, { useMemo, useState } from 'react';
import { Invoice, CommercialActivity } from '../../types/erp';
import { CustomerNotificationModal } from './CustomerNotificationModal';
import { useDocumentContext } from '../../hooks/useDocumentContext';
import { useLiveParties } from '../../hooks/useLiveDexie';
import {
  buildInvoiceDocumentSnapshot,
  buildStructuredBaseName,
} from '../../services/documents/documentService';
import { buildInvoiceNotificationPayload } from '../../utils/documentNotifications';
import { DocumentPrintShell } from '../documents/DocumentPrintShell';
import { SalesInvoiceDocument } from '../documents/SalesInvoiceDocument';
import type { DocumentPaperSize } from '../../utils/printDocument';

interface ReceiptModalProps {
  invoice: Invoice | null;
  activity?: CommercialActivity;
  partyPhone?: string;
  defaultSize?: DocumentPaperSize;
  onClose: () => void;
}

export const ReceiptModal: React.FC<ReceiptModalProps> = ({
  invoice,
  activity,
  partyPhone,
  defaultSize,
  onClose,
}) => {
  const [isNotificationOpen, setIsNotificationOpen] = useState(false);
  const { resolveMeta, activities } = useDocumentContext();
  const parties = useLiveParties();

  const resolvedActivity = useMemo(
    () =>
      activity ||
      (invoice ? activities.find((a) => a.id === invoice.activityId) : undefined),
    [activity, activities, invoice]
  );

  const resolvedPhone = useMemo(() => {
    if (partyPhone) return partyPhone;
    if (!invoice?.partyId) return undefined;
    return parties.find((p) => p.id === invoice.partyId)?.phone;
  }, [partyPhone, invoice, parties]);

  if (!invoice) return null;

  const isPurchase = invoice.type === 'PURCHASE' || invoice.type === 'RETURN_PURCHASE';
  const isReturn = invoice.type === 'RETURN_SALE' || invoice.type === 'RETURN_PURCHASE';

  const initialSize: DocumentPaperSize =
    defaultSize || (isPurchase ? 'A4' : '80mm');

  const meta = resolveMeta({
    branchId: invoice.branchId,
    activity: resolvedActivity,
    activityId: invoice.activityId,
  });

  const titleByType: Record<Invoice['type'], string> = {
    SALE: `فاتورة مبيعات (${invoice.invoiceNumber})`,
    RETURN_SALE: `إشعار دائن / مرتجع مبيعات (${invoice.invoiceNumber})`,
    PURCHASE: `فاتورة مشتريات (${invoice.invoiceNumber})`,
    RETURN_PURCHASE: `إشعار مدين / مرتجع مشتريات (${invoice.invoiceNumber})`,
  };

  const notifyPayload = buildInvoiceNotificationPayload({
    invoice,
    activityName: resolvedActivity?.nameAr,
    recipientPhone: resolvedPhone,
  });

  const baseFileName = buildStructuredBaseName({
    kind: invoice.type,
    documentNumber: invoice.invoiceNumber,
    date: invoice.date,
  });

  const shareSnapshot = buildInvoiceDocumentSnapshot({
    invoice,
    meta,
    paperSize: initialSize,
    partyPhone: resolvedPhone,
  });

  return (
    <>
      <DocumentPrintShell
        title={titleByType[invoice.type]}
        subtitle={`${invoice.partyName} — ${invoice.date}`}
        pdfTitle={baseFileName}
        defaultSize={initialSize}
        allowThermal={true}
        buildSnapshot={(paperSize) =>
          buildInvoiceDocumentSnapshot({
            invoice,
            meta,
            paperSize,
            partyPhone: resolvedPhone,
          })
        }
        onClose={onClose}
        onNotify={() => setIsNotificationOpen(true)}
        notifyLabel={isPurchase ? 'إشعار ومشاركة للمورد' : 'إشعار ومشاركة للعميل'}
        headerBadge={
          isReturn ? (
            <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-200 border border-amber-400/40 text-[10px] font-bold">
              مرتجع
            </span>
          ) : undefined
        }
      >
        {(paperSize) => (
          <SalesInvoiceDocument
            invoice={invoice}
            meta={meta}
            paperSize={paperSize}
            partyPhone={resolvedPhone}
          />
        )}
      </DocumentPrintShell>

      <CustomerNotificationModal
        isOpen={isNotificationOpen}
        onClose={() => setIsNotificationOpen(false)}
        recipientName={notifyPayload.recipientName}
        recipientPhone={notifyPayload.recipientPhone}
        documentType={notifyPayload.documentType}
        documentNumber={notifyPayload.documentNumber}
        amount={notifyPayload.amount}
        date={notifyPayload.date}
        activityName={notifyPayload.activityName}
        balanceRemaining={notifyPayload.balanceRemaining}
        itemsSummary={notifyPayload.itemsSummary}
        notes={notifyPayload.notes}
        snapshot={shareSnapshot}
      />
    </>
  );
};
