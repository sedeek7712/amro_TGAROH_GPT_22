import React from 'react';
import type { ResolvedDocumentHeader } from '../../utils/documentBranding';
import type { DocumentPaperSize } from '../../utils/printDocument';
import { formatLocalDateTime } from '../../utils/localDate';
import { numberToArabicWords } from '../../../electron/sqlite/payment-allocation-engine.mjs';

interface DocumentHeaderProps {
  meta: ResolvedDocumentHeader;
  paperSize?: DocumentPaperSize;
  documentTitle: string;
  documentSubtitle?: string;
  documentNumber?: string;
  documentDate?: string;
  statusLabel?: string;
  statusTone?: 'neutral' | 'success' | 'warning' | 'danger';
  periodText?: string;
}

const STATUS_TONE_CLASSES: Record<NonNullable<DocumentHeaderProps['statusTone']>, string> = {
  neutral: 'bg-slate-100 text-slate-800 border-slate-300',
  success: 'bg-emerald-50 text-emerald-900 border-emerald-300',
  warning: 'bg-amber-50 text-amber-900 border-amber-300',
  danger: 'bg-rose-50 text-rose-900 border-rose-300',
};

export const DocumentHeader: React.FC<DocumentHeaderProps> = ({
  meta,
  paperSize = 'A4',
  documentTitle,
  documentSubtitle,
  documentNumber,
  documentDate,
  statusLabel,
  statusTone = 'neutral',
  periodText,
}) => {
  const issuedNow = formatLocalDateTime();
  const isThermal = paperSize === '80mm';

  if (isThermal) {
    return (
      <header className="border-b-2 border-slate-900 pb-2.5 mb-3 text-center space-y-1.5">
        {meta.hasLogo && meta.logoUrl && (
          <div className="flex justify-center pb-1">
            <img
              src={meta.logoUrl}
              alt={meta.companyNameAr}
              className="h-11 max-w-[140px] object-contain"
            />
          </div>
        )}
        <div className="text-[13px] font-black text-slate-900 leading-tight">
          {meta.companyNameAr}
        </div>
        {meta.companyNameEn && (
          <div dir="ltr" className="text-[10px] font-semibold text-slate-500">
            {meta.companyNameEn}
          </div>
        )}
        <div className="text-[10px] text-slate-600 leading-snug space-y-0.5">
          <div>الفرع: {meta.branchName}{meta.activityName ? ` — ${meta.activityName}` : ''}</div>
          {(meta.phone || meta.branchPhone) && (
            <div className="font-mono">هاتف: {meta.phone || meta.branchPhone}</div>
          )}
          {meta.taxNumber && <div className="font-mono">الرقم الضريبي: {meta.taxNumber}</div>}
          {meta.address && <div>{meta.address}</div>}
        </div>

        <div className="pt-1.5 mt-1 border-t border-dashed border-slate-300 space-y-1">
          <div className="inline-block px-2.5 py-0.5 bg-slate-900 text-white text-[11px] font-extrabold rounded">
            {documentTitle}
          </div>
          {documentSubtitle && (
            <div className="text-[10px] font-semibold text-slate-600">{documentSubtitle}</div>
          )}
          {statusLabel && (
            <div>
              <span
                className={`inline-block px-2 py-0.5 text-[10px] font-bold rounded border ${STATUS_TONE_CLASSES[statusTone]}`}
              >
                {statusLabel}
              </span>
            </div>
          )}
          {(documentNumber || documentDate) && (
            <div className="flex items-center justify-between text-[10px] pt-1 font-mono text-slate-700">
              <span dir="ltr">{documentNumber ? `#${documentNumber}` : ''}</span>
              <span dir="ltr">{documentDate || issuedNow.date}</span>
            </div>
          )}
          {periodText && <div className="text-[10px] text-slate-600">{periodText}</div>}
        </div>
      </header>
    );
  }

  return (
    <header className="border-b-2 border-slate-900 pb-4 mb-5 doc-break-inside-avoid">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        {/* Enterprise Identity Block (Strict CompanyProfile binding, no fake logo) */}
        <div className="flex items-start gap-3.5 min-w-0">
          {meta.hasLogo && meta.logoUrl && (
            <img
              src={meta.logoUrl}
              alt={meta.companyNameAr}
              className="w-16 h-16 object-contain rounded-lg border border-slate-200 bg-white p-1 shrink-0"
            />
          )}
          <div className="space-y-1 min-w-0">
            <h1 className="text-lg font-black text-slate-900 tracking-tight leading-snug">
              {meta.companyNameAr}
            </h1>
            {meta.companyNameEn && (
              <div dir="ltr" className="text-[11px] font-bold text-slate-500 tracking-wide text-right">
                {meta.companyNameEn}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-600">
              <span>
                <strong className="text-slate-800">الفرع:</strong> {meta.branchName}
              </span>
              {meta.activityName && (
                <span>
                  <strong className="text-slate-800">النشاط:</strong> {meta.activityName}
                </span>
              )}
              {(meta.phone || meta.branchPhone) && (
                <span className="font-mono">هاتف: {meta.phone || meta.branchPhone}</span>
              )}
              {meta.taxNumber && <span className="font-mono">الرقم الضريبي: {meta.taxNumber}</span>}
            </div>
            {(meta.address || meta.branchAddress || meta.email || meta.website) && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
                {(meta.address || meta.branchAddress) && (
                  <span>{meta.address || meta.branchAddress}</span>
                )}
                {meta.email && <span className="font-mono">{meta.email}</span>}
                {meta.website && <span className="font-mono">{meta.website}</span>}
              </div>
            )}
          </div>
        </div>

        {/* Document Classification & Numbering Box */}
        <div className="sm:text-left shrink-0 space-y-1.5">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 bg-slate-900 text-white rounded-md text-xs font-extrabold">
            <span>{documentTitle}</span>
          </div>
          {documentSubtitle && (
            <div className="text-[11px] font-bold text-slate-700">{documentSubtitle}</div>
          )}
          <div className="flex flex-wrap sm:justify-end items-center gap-2 text-[11px]">
            {documentNumber && (
              <span className="font-mono font-extrabold text-slate-900 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded">
                {documentNumber}
              </span>
            )}
            {statusLabel && (
              <span
                className={`px-2 py-0.5 rounded border font-bold text-[10px] ${STATUS_TONE_CLASSES[statusTone]}`}
              >
                {statusLabel}
              </span>
            )}
          </div>
          <div className="text-[10px] text-slate-500 font-mono tabular-nums space-y-0.5">
            {documentDate && <div>تاريخ المستند: {documentDate}</div>}
            <div>
              تاريخ الإصدار: {issuedNow.date} | {issuedNow.time}
            </div>
          </div>
          {periodText && (
            <div className="text-[10px] font-semibold text-slate-700 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded inline-block">
              {periodText}
            </div>
          )}
        </div>
      </div>

      {meta.headerNote && (
        <div className="mt-3 pt-2 border-t border-slate-200 text-[11px] font-semibold text-slate-600 text-center">
          {meta.headerNote}
        </div>
      )}
    </header>
  );
};

export interface MetaFieldItem {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  fullWidth?: boolean;
}

export const DocumentMetaGrid: React.FC<{
  fields: MetaFieldItem[];
  paperSize?: DocumentPaperSize;
  columns?: 2 | 3 | 4;
}> = ({ fields, paperSize = 'A4', columns = 3 }) => {
  const visible = fields.filter(
    (f) => f.value !== undefined && f.value !== null && f.value !== ''
  );
  if (visible.length === 0) return null;

  if (paperSize === '80mm') {
    return (
      <div className="bg-slate-50 border border-slate-200 rounded p-2 mb-3 text-[10px] space-y-1 doc-break-inside-avoid">
        {visible.map((f, idx) => (
          <div key={idx} className="flex items-start justify-between gap-2 border-b border-slate-100 last:border-b-0 pb-0.5 last:pb-0">
            <span className="text-slate-500 shrink-0">{f.label}:</span>
            <span className={`font-bold text-slate-900 text-left break-words ${f.mono ? 'font-mono tabular-nums' : ''}`}>
              {f.value}
            </span>
          </div>
        ))}
      </div>
    );
  }

  const gridColsClass =
    columns === 4
      ? 'grid-cols-2 sm:grid-cols-4'
      : columns === 2
      ? 'grid-cols-1 sm:grid-cols-2'
      : 'grid-cols-2 sm:grid-cols-3';

  return (
    <div
      className={`grid ${gridColsClass} gap-x-4 gap-y-2.5 bg-slate-50 border border-slate-200 rounded-lg p-3.5 mb-4 text-xs doc-break-inside-avoid`}
    >
      {visible.map((f, idx) => (
        <div key={idx} className={f.fullWidth ? 'col-span-full' : ''}>
          <div className="text-[10px] font-semibold text-slate-500 mb-0.5">{f.label}</div>
          <div
            className={`font-bold text-slate-900 break-words ${
              f.mono ? 'font-mono tabular-nums' : ''
            }`}
          >
            {f.value}
          </div>
        </div>
      ))}
    </div>
  );
};

export const DocumentAmountBanner: React.FC<{
  label: string;
  amount: number;
  currencySymbol: string;
  currencyNameAr: string;
  paperSize?: DocumentPaperSize;
  subLabel?: string;
}> = ({ label, amount, currencySymbol, currencyNameAr, paperSize = 'A4', subLabel }) => {
  const isThermal = paperSize === '80mm';
  const words = numberToArabicWords(amount, currencyNameAr);

  return (
    <div
      className={`bg-slate-900 text-white rounded-lg doc-break-inside-avoid ${
        isThermal ? 'p-2.5 my-2.5 text-center space-y-1' : 'p-4 my-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2'
      }`}
    >
      <div>
        <div className={`text-slate-300 font-semibold ${isThermal ? 'text-[10px]' : 'text-[11px]'}`}>
          {label}
        </div>
        <div className={`font-semibold text-emerald-300 mt-0.5 ${isThermal ? 'text-[10px]' : 'text-xs'}`}>
          {words}
        </div>
        {subLabel && <div className="text-[10px] text-slate-300 mt-0.5">{subLabel}</div>}
      </div>
      <div
        className={`font-mono tabular-nums font-black text-white shrink-0 ${
          isThermal ? 'text-base pt-0.5' : 'text-xl'
        }`}
      >
        {Number(amount || 0).toFixed(2)} <span className="text-xs font-bold text-slate-300">{currencySymbol}</span>
      </div>
    </div>
  );
};

export interface SignatureSlot {
  roleLabel: string;
  name?: string;
}

export const DocumentSignatures: React.FC<{
  slots: SignatureSlot[];
  paperSize?: DocumentPaperSize;
}> = ({ slots, paperSize = 'A4' }) => {
  if (slots.length === 0) return null;

  if (paperSize === '80mm') {
    return (
      <div className="grid grid-cols-2 gap-3 text-center text-[10px] pt-3 mt-3 border-t border-slate-300 doc-break-inside-avoid">
        {slots.slice(0, 2).map((s, idx) => (
          <div key={idx}>
            <div className="text-slate-600 font-semibold mb-4">{s.roleLabel}</div>
            {s.name && <div className="font-bold text-slate-900 truncate">{s.name}</div>}
            <div className="border-b border-slate-400 w-24 mx-auto mt-1.5" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className={`grid gap-6 text-center text-xs pt-6 mt-6 border-t border-slate-200 doc-break-inside-avoid ${
        slots.length >= 3 ? 'grid-cols-3' : 'grid-cols-2'
      }`}
    >
      {slots.map((s, idx) => (
        <div key={idx} className="space-y-1">
          <div className="text-slate-600 font-semibold mb-7">{s.roleLabel}</div>
          <div className="font-bold text-slate-900 min-h-[1rem]">{s.name || '........................'}</div>
          <div className="border-b border-slate-400 w-36 mx-auto pt-1" />
        </div>
      ))}
    </div>
  );
};

export const DocumentFooter: React.FC<{
  meta: ResolvedDocumentHeader;
  paperSize?: DocumentPaperSize;
  referenceText?: string;
}> = ({ meta, paperSize = 'A4', referenceText }) => {
  const issuedNow = formatLocalDateTime();
  const isThermal = paperSize === '80mm';

  return (
    <footer
      className={`border-t border-dashed border-slate-300 text-slate-500 doc-break-inside-avoid ${
        isThermal ? 'mt-3 pt-2 text-[9px] text-center space-y-0.5' : 'mt-6 pt-3 text-[10px] space-y-1'
      }`}
    >
      {meta.footerNote && (
        <div className="font-semibold text-slate-700 text-center">{meta.footerNote}</div>
      )}
      {isThermal ? (
        <div className="space-y-0.5 text-slate-500">
          <div>
            أعدّه: <strong className="text-slate-700">{meta.issuerName || 'النظام المحاسبي'}</strong>
          </div>
          <div>الفرع: {meta.branchName}</div>
          {referenceText && (
            <div dir="ltr" className="font-mono text-[8.5px]">
              {referenceText}
            </div>
          )}
          <div className="font-mono tabular-nums">
            طُبع: <span dir="ltr">{issuedNow.displayTabular}</span> (توقيت اليمن)
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 text-slate-500">
          <span>
            أعدّه: <strong className="text-slate-700">{meta.issuerName || 'النظام المحاسبي'}</strong>{' '}
            | الفرع: {meta.branchName}
          </span>
          {referenceText && (
            <span dir="ltr" className="font-mono">
              {referenceText}
            </span>
          )}
          <span className="font-mono tabular-nums">
            طُبع: <span dir="ltr">{issuedNow.displayTabular}</span> (توقيت اليمن)
          </span>
        </div>
      )}
    </footer>
  );
};
