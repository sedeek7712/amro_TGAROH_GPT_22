/**
 * نافذة معاينة وطباعة سندات الأمانات (إيداع / رد جزئي / إبراء ذمة / ملغى)
 * مخصصة لنظام الأمانات وحفظ أموال وأصناف الغير
 */

import React, { useState } from 'react';
import { AmanatRecord } from '../../types/erp';
import { CustomerNotificationModal } from './CustomerNotificationModal';
import { useDocumentContext } from '../../hooks/useDocumentContext';
import { useLiveCashBoxes } from '../../hooks/useLiveDexie';
import { buildAmanatNotificationPayload } from '../../utils/documentNotifications';
import { DocumentPrintShell } from '../documents/DocumentPrintShell';
import { AmanatDocument } from '../documents/AmanatDocument';

interface AmanatReceiptModalProps {
  record: AmanatRecord | null;
  onClose: () => void;
}

export const AmanatReceiptModal: React.FC<AmanatReceiptModalProps> = ({ record, onClose }) => {
  const [isNotificationOpen, setIsNotificationOpen] = useState(false);
  const { resolveMeta } = useDocumentContext();
  const cashBoxes = useLiveCashBoxes();

  if (!record) return null;

  const meta = resolveMeta({
    branchId: record.branchId,
    issuerName: record.receivedBy,
  });

  const cashBoxName = record.cashBoxId
    ? cashBoxes.find((b) => b.id === record.cashBoxId)?.nameAr
    : undefined;

  const notifyPayload = buildAmanatNotificationPayload(record);

  return (
    <>
      <DocumentPrintShell
        title={`سند أمانة رسمي (${record.recordNumber})`}
        subtitle={`${record.depositorName} — ${record.receivedDate}`}
        pdfTitle={`AMANAT_${record.recordNumber}`}
        defaultSize="A4"
        allowThermal={true}
        onClose={onClose}
        onNotify={() => setIsNotificationOpen(true)}
        notifyLabel="إشعار المودع"
      >
        {(paperSize) => (
          <AmanatDocument
            record={record}
            meta={meta}
            paperSize={paperSize}
            cashBoxName={cashBoxName}
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
        notes={notifyPayload.notes}
        itemsSummary={notifyPayload.itemsSummary}
      />
    </>
  );
};
