import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Printer, FileDown, X, MessageSquare, FileText, Receipt } from 'lucide-react';
import {
  applyPrintPageStyle,
  exportDocumentPdf,
  triggerNativePrint,
  type DocumentPaperSize,
} from '../../utils/printDocument';

const PORTAL_ROOT_ID = 'doc-print-portal';

function ensurePortalRoot(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  let root = document.getElementById(PORTAL_ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = PORTAL_ROOT_ID;
    document.body.appendChild(root);
  }
  return root;
}

let activeModalCount = 0;

interface DocumentPrintShellProps {
  title: string;
  subtitle?: string;
  pdfTitle?: string;
  defaultSize?: DocumentPaperSize;
  allowThermal?: boolean;
  onClose: () => void;
  onNotify?: () => void;
  notifyLabel?: string;
  headerBadge?: React.ReactNode;
  children: (paperSize: DocumentPaperSize) => React.ReactNode;
}

export const DocumentPrintShell: React.FC<DocumentPrintShellProps> = ({
  title,
  subtitle,
  pdfTitle,
  defaultSize = 'A4',
  allowThermal = true,
  onClose,
  onNotify,
  notifyLabel = 'إشعار واتساب',
  headerBadge,
  children,
}) => {
  const [paperSize, setPaperSize] = useState<DocumentPaperSize>(defaultSize);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    setPaperSize(defaultSize);
  }, [defaultSize]);

  useEffect(() => {
    activeModalCount += 1;
    document.body.classList.add('has-doc-print-modal');
    applyPrintPageStyle(paperSize);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      activeModalCount = Math.max(0, activeModalCount - 1);
      if (activeModalCount === 0) {
        document.body.classList.remove('has-doc-print-modal');
      }
    };
  }, [onClose]);

  useEffect(() => {
    applyPrintPageStyle(paperSize);
  }, [paperSize]);

  const handlePrint = () => {
    triggerNativePrint(paperSize);
  };

  const handleExportPdf = async () => {
    if (isExporting) return;
    setExportStatus(null);
    setIsExporting(true);
    try {
      const res = await exportDocumentPdf({
        title: pdfTitle || title,
        pageSize: paperSize,
      });
      if (res.mode === 'ELECTRON_PDF' && !res.canceled && res.path) {
        setExportStatus(`تم حفظ ملف PDF بنجاح: ${res.path}`);
      }
    } catch (err: unknown) {
      setExportStatus(err instanceof Error ? err.message : 'تعذر تصدير ملف PDF');
    } finally {
      setIsExporting(false);
    }
  };

  const portalRoot = ensurePortalRoot();
  if (!portalRoot) return null;

  const isThermal = paperSize === '80mm';

  const modalContent = (
    <div
      className="doc-modal-layer fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 backdrop-blur-[1px] p-2 sm:p-5 overflow-y-auto"
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={`doc-modal-card relative w-full bg-white rounded-xl shadow-2xl border border-slate-200 my-2 sm:my-4 overflow-hidden print:shadow-none print:border-none print:max-w-none print:w-full print:my-0 print:rounded-none ${
          isThermal ? 'max-w-[390px]' : 'max-w-[920px]'
        }`}
      >
        {/* Modal Preview Toolbar (Hidden in print) */}
        <div className="no-print flex flex-wrap items-center justify-between gap-2 px-4 py-3 bg-slate-900 text-white border-b border-slate-800">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center shrink-0">
              <FileText className="w-4 h-4 text-slate-200" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-xs sm:text-sm font-bold text-white truncate">{title}</h2>
                {headerBadge}
              </div>
              {subtitle && <p className="text-[11px] text-slate-400 truncate">{subtitle}</p>}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {allowThermal && (
              <div className="inline-flex rounded-lg bg-slate-800 p-0.5 border border-slate-700">
                <button
                  type="button"
                  onClick={() => setPaperSize('A4')}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold transition-colors ${
                    paperSize === 'A4'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-300 hover:text-white'
                  }`}
                  title="معاينة وطباعة بمقاس A4 الرسمي"
                >
                  <FileText className="w-3 h-3" />
                  <span>A4</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPaperSize('80mm')}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold transition-colors ${
                    paperSize === '80mm'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-300 hover:text-white'
                  }`}
                  title="معاينة وطباعة بمقاس إيصال حراري 80mm"
                >
                  <Receipt className="w-3 h-3" />
                  <span>80mm</span>
                </button>
              </div>
            )}

            {onNotify && (
              <button
                type="button"
                onClick={onNotify}
                className="flex items-center gap-1 px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold rounded-lg transition-colors"
              >
                <MessageSquare className="w-3.5 h-3.5" />
                <span>{notifyLabel}</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleExportPdf}
              disabled={isExporting}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-[11px] font-bold rounded-lg transition-colors disabled:opacity-50"
              title="حفظ المستند بصيغة PDF"
            >
              <FileDown className="w-3.5 h-3.5" />
              <span>{isExporting ? 'جارٍ التصدير...' : 'حفظ PDF'}</span>
            </button>

            <button
              type="button"
              onClick={handlePrint}
              className="flex items-center gap-1 px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-900 text-[11px] font-extrabold rounded-lg transition-colors"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>طباعة ({paperSize})</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
              aria-label="إغلاق"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {exportStatus && (
          <div className="no-print px-4 py-2 bg-slate-100 border-b border-slate-200 text-[11px] font-semibold text-slate-800 flex items-center justify-between">
            <span>{exportStatus}</span>
            <button
              type="button"
              onClick={() => setExportStatus(null)}
              className="text-slate-500 hover:text-slate-900"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Preview Canvas */}
        <div className="bg-slate-100/70 p-2 sm:p-5 print:p-0 print:bg-white">
          <div
            className={`printable-area mx-auto bg-white text-slate-900 border border-slate-200 shadow-xs print:border-none print:shadow-none ${
              isThermal
                ? 'doc-sheet-80mm w-[76mm] max-w-full p-3 rounded-lg'
                : 'doc-sheet-a4 w-full p-5 sm:p-8 rounded-lg'
            }`}
          >
            {children(paperSize)}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, portalRoot);
};
