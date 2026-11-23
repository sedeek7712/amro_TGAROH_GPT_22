/**
 * نافذة معاينة وطباعة سندات الأمانات (إيداع / رد جزئي / إبراء ذمة / ملغى)
 * مخصصة لنظام الأمانات وحفظ أموال وأصناف الغير (متوافقة مع DOC-01 و AMRO-DOC-OPS-001/002)
 */

import React, { useEffect, useState } from 'react';
import { AmanatRecord } from '../../types/erp';
import { CustomerNotificationModal } from './CustomerNotificationModal';
import { useDocumentContext } from '../../hooks/useDocumentContext';
import { useLiveCashBoxes } from '../../hooks/useLiveDexie';
import { buildAmanatNotificationPayload } from '../../utils/documentNotifications';
import {
  buildAmanatDocumentSnapshot,
  buildStructuredBaseName,
} from '../../services/documents/documentService';
import { DocumentPrintShell } from '../documents/DocumentPrintShell';
import { AmanatDocument } from '../documents/AmanatDocument';

interface AmanatReceiptModalProps {
  record: AmanatRecord | null;
  initialNotificationMode?: 'AUTO' | 'DEPOSIT' | 'RETURN';
  initialReturnEventId?: string;
  onClose: () => void;
}

export const AmanatReceiptModal: React.FC<AmanatReceiptModalProps> = ({
  record,
  initialNotificationMode = 'AUTO',
  initialReturnEventId,
  onClose,
}) => {
  const [isNotificationOpen, setIsNotificationOpen] = useState(false);
  const [notifyMode, setNotifyMode] = useState<'AUTO' | 'DEPOSIT' | 'RETURN'>(
    initialNotificationMode
  );
  const [selectedReturnEventId, setSelectedReturnEventId] = useState<string | undefined>(
    initialReturnEventId
  );

  const { resolveMeta } = useDocumentContext();
  const cashBoxes = useLiveCashBoxes();

  useEffect(() => {
    setNotifyMode(initialNotificationMode);
    setSelectedReturnEventId(initialReturnEventId);
  }, [record?.id, initialNotificationMode, initialReturnEventId]);

  if (!record) return null;

  const meta = resolveMeta({
    branchId: record.branchId,
    issuerName: record.receivedBy,
  });

  const cashBoxName = record.cashBoxId
    ? cashBoxes.find((b) => b.id === record.cashBoxId)?.nameAr
    : undefined;

  const notifyPayload = buildAmanatNotificationPayload(record, {
    mode: notifyMode,
    returnEventId: selectedReturnEventId,
  });

  const matchedReturnEvent =
    notifyPayload.documentType === 'AMANAT_RETURN'
      ? record.returnHistory?.find(
          (ev) => ev.id === (notifyPayload.returnEventId || selectedReturnEventId)
        ) || record.returnHistory?.[record.returnHistory.length - 1]
      : undefined;

  const dec = meta.currency.decimalPlaces ?? 2;
  const sym = meta.currency.symbol;

  const returnEventSelector =
    record.returnHistory && record.returnHistory.length > 0 ? (
      <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
        <label className="block text-[11px] font-bold text-slate-700">
          العملية المراد إشعار المودع بها:
        </label>
        <select
          value={notifyPayload.documentType === 'AMANAT_RECEIPT' ? '__DEPOSIT__' : notifyPayload.returnEventId || '__LATEST__'}
          onChange={(e) => {
            const val = e.target.value;
            if (val === '__DEPOSIT__') {
              setNotifyMode('DEPOSIT');
              setSelectedReturnEventId(undefined);
            } else {
              setNotifyMode('RETURN');
              setSelectedReturnEventId(val === '__LATEST__' ? undefined : val);
            }
          }}
          className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-semibold text-slate-900"
        >
          <option value="__DEPOSIT__">
            سند الإيداع الأصلي ({record.receivedDate}) — {Number(record.amount || 0).toFixed(dec)} {sym}
          </option>
          {record.returnHistory.map((ev, idx) => (
            <option key={ev.id} value={ev.id}>
              دفعة رد #{idx + 1} ({ev.date}) — مبلغ الرد: {Number(ev.amount || 0).toFixed(dec)} {sym}
            </option>
          ))}
        </select>
      </div>
    ) : undefined;

  const baseFileName = buildStructuredBaseName({
    kind: notifyPayload.documentType === 'AMANAT_RETURN' ? 'AMANAT_RETURN' : 'AMANAT_RECEIPT',
    documentNumber: record.recordNumber,
    date: notifyPayload.date || record.receivedDate,
  });

  const snapshotForNotification = buildAmanatDocumentSnapshot({
    record,
    meta,
    paperSize: 'A4',
    cashBoxName,
    returnEvent: matchedReturnEvent,
  });

  return (
    <>
      <DocumentPrintShell
        title={`سند أمانة رسمي (${record.recordNumber})`}
        subtitle={`${record.depositorName} — ${record.receivedDate}`}
        pdfTitle={baseFileName}
        defaultSize="A4"
        allowThermal={true}
        buildSnapshot={(paperSize) =>
          buildAmanatDocumentSnapshot({
            record,
            meta,
            paperSize,
            cashBoxName,
            returnEvent: matchedReturnEvent,
          })
        }
        onClose={onClose}
        onNotify={() => setIsNotificationOpen(true)}
        notifyLabel="إشعار ومشاركة"
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
        balanceRemaining={notifyPayload.balanceRemaining}
        notes={notifyPayload.notes}
        itemsSummary={notifyPayload.itemsSummary}
        snapshot={snapshotForNotification}
        notificationError={notifyPayload.error}
        isPartialReturn={notifyPayload.isPartialReturn}
        totalOriginalAmount={notifyPayload.totalOriginalAmount}
        cumulativeReturnedAmount={notifyPayload.cumulativeReturnedAmount}
        returnEventSelector={returnEventSelector}
      />
    </>
  );
};
