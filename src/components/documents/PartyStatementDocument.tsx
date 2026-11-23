import React from 'react';
import type { ResolvedDocumentHeader } from '../../utils/documentBranding';
import type { PartyStatementSummary } from '../../utils/partyStatement';
import type { DocumentPaperSize } from '../../utils/printDocument';
import {
  DocumentFooter,
  DocumentHeader,
  DocumentMetaGrid,
  DocumentSignatures,
} from './DocumentPrimitives';

interface PartyStatementDocumentProps {
  statement: PartyStatementSummary;
  meta: ResolvedDocumentHeader;
  paperSize: DocumentPaperSize;
  startDate?: string;
  endDate?: string;
}

export const PartyStatementDocument: React.FC<PartyStatementDocumentProps> = ({
  statement,
  meta,
  paperSize,
  startDate,
  endDate,
}) => {
  const isThermal = paperSize === '80mm' || paperSize === '58mm';
  const dec = meta.currency.decimalPlaces ?? 2;
  const sym = meta.currency.symbol;
  const isCustomer = statement.party.type === 'CUSTOMER';

  const totalDebit = statement.transactions.reduce((s, t) => s + Number(t.debit || 0), 0);
  const totalCredit = statement.transactions.reduce((s, t) => s + Number(t.credit || 0), 0);
  const periodText =
    startDate || endDate
      ? `الفترة: ${startDate || 'من البداية'} إلى ${endDate || 'حتى تاريخه'}`
      : 'كشف شامل لكافة الحركات';

  return (
    <div dir="rtl" className="text-slate-900">
      <DocumentHeader
        meta={meta}
        paperSize={paperSize}
        documentTitle={isCustomer ? 'كشف حساب عميل' : 'كشف حساب مورد'}
        documentSubtitle={isCustomer ? 'حساب العملاء والذمم المدينة (1103)' : 'حساب الموردين والذمم الدائنة (2101)'}
        documentNumber={`STMT-${statement.party.id.slice(0, 8).toUpperCase()}`}
        periodText={periodText}
      />

      <DocumentMetaGrid
        paperSize={paperSize}
        columns={3}
        fields={[
          { label: isCustomer ? 'اسم العميل' : 'اسم المورد', value: statement.party.nameAr },
          { label: 'رقم الهاتف', value: statement.party.phone || '-', mono: true },
          { label: 'العنوان', value: statement.party.address },
          { label: 'الرقم الضريبي', value: statement.party.taxNumber, mono: true },
          { label: 'عدد الفواتير المعتمدة', value: String(statement.invoicesCount), mono: true },
          {
            label: isCustomer ? 'الرصيد المقدم المتاح (2103)' : 'سلف المورد المتاحة (1105)',
            value: `${statement.advanceBalance.toFixed(dec)} ${sym}`,
            mono: true,
          },
        ]}
      />

      {/* KPI Summary Strip */}
      <div
        className={`grid ${
          isThermal
            ? 'grid-cols-2 gap-1.5 p-2 text-[10px]'
            : 'grid-cols-2 sm:grid-cols-4 gap-3 p-3.5 text-xs'
        } rounded-lg border border-slate-200 bg-slate-50 mb-4 doc-break-inside-avoid`}
      >
        <div>
          <div className="text-slate-500 text-[10px]">الرصيد الافتتاحي</div>
          <div className="font-mono tabular-nums font-bold text-slate-900">
            {statement.openingBalance.toFixed(dec)} {sym}
          </div>
        </div>
        <div>
          <div className="text-slate-500 text-[10px]">إجمالي المدين (+)</div>
          <div className="font-mono tabular-nums font-bold text-slate-900">
            {totalDebit.toFixed(dec)} {sym}
          </div>
        </div>
        <div>
          <div className="text-slate-500 text-[10px]">إجمالي الدائن (-)</div>
          <div className="font-mono tabular-nums font-bold text-emerald-800">
            {totalCredit.toFixed(dec)} {sym}
          </div>
        </div>
        <div>
          <div className="text-slate-500 text-[10px]">الرصيد الختامي</div>
          <div className="font-mono tabular-nums font-black text-slate-900 text-sm">
            {statement.periodClosingBalance.toFixed(dec)} {sym}
          </div>
        </div>
      </div>

      {isThermal ? (
        /* Concise 80mm Thermal Layout — zero horizontal clipping */
        <div className="space-y-1.5 mb-3">
          <div className="text-[10px] font-extrabold text-slate-900 border-b border-slate-900 pb-1">
            ملخص الحركات ({statement.transactions.length})
          </div>
          {statement.transactions.length === 0 ? (
            <div className="py-4 text-center text-[10px] text-slate-500 border border-dashed border-slate-300 rounded">
              لا توجد حركات خلال الفترة المحددة
            </div>
          ) : (
            <div className="divide-y divide-slate-200 border border-slate-200 rounded">
              {statement.transactions.map((row) => (
                <div key={row.id} className="p-1.5 text-[9.5px] space-y-0.5 doc-break-inside-avoid">
                  <div className="flex items-center justify-between font-bold text-slate-900">
                    <span className="font-mono">{row.docNumber}</span>
                    <span className="font-mono text-slate-500">{row.date}</span>
                  </div>
                  <div className="text-slate-700">{row.type}</div>
                  {row.extraBadge && (
                    <div className="text-[8.5px] text-indigo-800 font-semibold">{row.extraBadge}</div>
                  )}
                  <div className="flex items-center justify-between font-mono tabular-nums pt-0.5">
                    <span>
                      {row.debit > 0
                        ? `مدين: ${row.debit.toFixed(dec)}`
                        : `دائن: ${row.credit.toFixed(dec)}`}
                    </span>
                    <span className="font-bold text-slate-900">
                      رصيد: {row.balanceAfter.toFixed(dec)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        /* Full A4 Official Multi-Page Ledger Table */
        <div className="border border-slate-300 rounded-lg overflow-hidden mb-4">
          <table className="w-full text-right text-xs">
            <thead>
              <tr className="bg-slate-900 text-white font-bold">
                <th className="py-2.5 px-3">التاريخ</th>
                <th className="py-2.5 px-3">نوع الحركة</th>
                <th className="py-2.5 px-3">رقم المستند</th>
                <th className="py-2.5 px-3">البيان وتفاصيل التخصيص</th>
                <th className="py-2.5 px-3 text-center">مدين</th>
                <th className="py-2.5 px-3 text-center">دائن</th>
                <th className="py-2.5 px-3 text-left">الرصيد التراكمي</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {startDate && (
                <tr className="bg-slate-100/80 font-bold">
                  <td className="py-2 px-3 font-mono text-slate-600">{startDate}</td>
                  <td className="py-2 px-3 text-slate-800">رصيد أول المدة</td>
                  <td className="py-2 px-3 font-mono">-</td>
                  <td className="py-2 px-3 text-slate-700">الرصيد المرحل لما قبل {startDate}</td>
                  <td className="py-2 px-3 text-center font-mono">-</td>
                  <td className="py-2 px-3 text-center font-mono">-</td>
                  <td className="py-2 px-3 text-left font-mono tabular-nums font-extrabold text-slate-900">
                    {statement.openingBalance.toFixed(dec)} {sym}
                  </td>
                </tr>
              )}
              {statement.transactions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-400">
                    لا توجد حركات مسجلة خلال الفترة المحددة
                  </td>
                </tr>
              ) : (
                statement.transactions.map((tr, idx) => (
                  <tr key={tr.id} className={idx % 2 === 1 ? 'bg-slate-50/70' : 'bg-white'}>
                    <td className="py-2 px-3 font-mono text-slate-600 whitespace-nowrap">{tr.date}</td>
                    <td className="py-2 px-3 font-bold text-slate-800">{tr.type}</td>
                    <td className="py-2 px-3 font-mono font-bold text-slate-900 whitespace-nowrap">
                      {tr.docNumber}
                    </td>
                    <td className="py-2 px-3 text-slate-700">
                      <div>{tr.memo}</div>
                      {tr.extraBadge && (
                        <div className="text-[10px] text-indigo-800 font-semibold mt-0.5">
                          {tr.extraBadge}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-3 text-center font-mono tabular-nums text-slate-900">
                      {tr.debit > 0 ? tr.debit.toFixed(dec) : '-'}
                    </td>
                    <td className="py-2 px-3 text-center font-mono tabular-nums text-emerald-800 font-semibold">
                      {tr.credit > 0 ? tr.credit.toFixed(dec) : '-'}
                    </td>
                    <td className="py-2 px-3 text-left font-mono tabular-nums font-bold text-slate-900 whitespace-nowrap">
                      {tr.balanceAfter.toFixed(dec)} {sym}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-900 bg-slate-100 font-black text-xs text-slate-900">
                <td colSpan={4} className="py-2.5 px-3">
                  إجمالي حركات الفترة والرصيد الختامي:
                </td>
                <td className="py-2.5 px-3 text-center font-mono tabular-nums">
                  {totalDebit.toFixed(dec)}
                </td>
                <td className="py-2.5 px-3 text-center font-mono tabular-nums text-emerald-800">
                  {totalCredit.toFixed(dec)}
                </td>
                <td className="py-2.5 px-3 text-left font-mono tabular-nums text-sm">
                  {statement.periodClosingBalance.toFixed(dec)} {sym}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <DocumentSignatures
        paperSize={paperSize}
        slots={[
          { roleLabel: 'المحاسب المسؤول', name: meta.issuerName || 'الإدارة المالية' },
          { roleLabel: isCustomer ? 'مصادقة العميل' : 'مصادقة المورد', name: statement.party.nameAr },
        ]}
      />

      <DocumentFooter
        meta={meta}
        paperSize={paperSize}
        referenceText={`PARTY: ${statement.party.id.slice(0, 8)}`}
      />
    </div>
  );
};
