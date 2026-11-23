/**
 * محرك التحكم في مقاس الطباعة (A4 / 80mm) وتصدير PDF عبر المتصفح أو Electron
 */

import { desktopSession } from '../services/desktopSession';

export type DocumentPaperSize = 'A4' | '80mm';

const DYNAMIC_STYLE_ELEMENT_ID = 'erp-dynamic-print-page';

export function buildPrintPageCss(pageSize: DocumentPaperSize): string {
  if (pageSize === '80mm') {
    return `@page { size: 80mm 297mm; margin: 2.5mm; }`;
  }
  return `@page { size: A4 portrait; margin: 10mm 11mm 12mm 11mm; }`;
}

export function applyPrintPageStyle(pageSize: DocumentPaperSize): void {
  if (typeof document === 'undefined') return;
  let styleEl = document.getElementById(DYNAMIC_STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = DYNAMIC_STYLE_ELEMENT_ID;
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = buildPrintPageCss(pageSize);
  document.documentElement.dataset.printSize = pageSize;
}

export function triggerNativePrint(pageSize: DocumentPaperSize): void {
  applyPrintPageStyle(pageSize);
  if (typeof window === 'undefined') return;
  requestAnimationFrame(() => {
    setTimeout(() => {
      window.print();
    }, 60);
  });
}

export async function exportDocumentPdf(options: {
  title: string;
  pageSize: DocumentPaperSize;
}): Promise<{
  mode: 'ELECTRON_PDF' | 'WEB_PRINT';
  canceled?: boolean;
  path?: string;
}> {
  applyPrintPageStyle(options.pageSize);

  if (typeof window !== 'undefined' && window.amroDesktop?.exportDocumentPdf) {
    const token = desktopSession.requireToken();
    const res = await window.amroDesktop.exportDocumentPdf({
      token,
      title: options.title,
      pageSize: options.pageSize,
    });
    return {
      mode: 'ELECTRON_PDF',
      canceled: res.canceled,
      path: res.path,
    };
  }

  triggerNativePrint(options.pageSize);
  return { mode: 'WEB_PRINT' };
}
