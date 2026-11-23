/**
 * خدمة إنشاء صورة المستند النظيفة (PngService) وتوليد صفحات PDF المحلية دون إنترنت
 * AMRO-DOC-OPS-002:
 * - تُنشأ الصورة حصراً من لقطة DocumentSnapshot المعتمدة (مصدر واحد مع PDF).
 * - ممنوع تصوير شاشة التطبيق أو تضمين أزرار أو قوائم التحكم.
 * - تدعم A4 و 80mm و 58mm، والخطوط العربية المحلية من اليمين إلى اليسار.
 * - تمنع تحويل المستندات والتقارير متعددة الصفحات إلى صورة PNG واحدة طويلة.
 */

import type { DocumentSnapshot, SupportedDocumentPaperSize } from './documentService';
import { buildStructuredDocumentFilename } from './documentService';
import {
  buildPdfFromRasterPages,
  getPdfPageDimensionsPt,
  isValidPdfBytes,
  type PdfRasterPageInput,
} from './pdfContainer';

export interface DocumentCanvasSpec {
  paperSize: SupportedDocumentPaperSize;
  canvasWidthPx: number;
  pageMaxHeightPx: number;
  paddingPx: number;
  baseFontPx: number;
  allowSinglePng: boolean;
  rejectionReasonForPng?: string;
}

export interface RenderedPngResult {
  blob: Blob;
  bytes: Uint8Array;
  fileName: string;
  width: number;
  height: number;
  mimeType: 'image/png';
}

export interface RenderedPdfResult {
  blob: Blob;
  bytes: Uint8Array;
  fileName: string;
  pageCount: number;
  mimeType: 'application/pdf';
}

const ARABIC_FONT_STACK =
  '"Cairo", "Noto Sans Arabic", "Segoe UI", "Tahoma", "Arial", sans-serif';
const MONO_FONT_STACK =
  '"JetBrains Mono", "DejaVu Sans Mono", "Courier New", monospace';

export function isValidPngBytes(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < 24) return false;
  return (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

/**
 * حساب مواصفات اللوحة النظيفة وأهلية التحويل إلى PNG دون تحويل التقارير الطويلة لصورة واحدة
 */
export function computeDocumentCanvasSpec(snapshot: DocumentSnapshot): DocumentCanvasSpec {
  const rowCount = snapshot.table?.rows.length || 0;
  const isTooLongForPng =
    snapshot.isMultiPage ||
    snapshot.documentKind === 'REPORT' ||
    (snapshot.paperSize === 'A4' && rowCount > 18) ||
    (snapshot.paperSize !== 'A4' && rowCount > 24);

  if (snapshot.paperSize === '58mm') {
    return {
      paperSize: '58mm',
      canvasWidthPx: 460,
      pageMaxHeightPx: 1900,
      paddingPx: 18,
      baseFontPx: 14,
      allowSinglePng: !isTooLongForPng,
      rejectionReasonForPng: isTooLongForPng
        ? 'المستند طويل أو متعدد الصفحات؛ يُعتمد PDF للحفظ والمشاركة بدلاً من صورة واحدة.'
        : undefined,
    };
  }

  if (snapshot.paperSize === '80mm') {
    return {
      paperSize: '80mm',
      canvasWidthPx: 620,
      pageMaxHeightPx: 2200,
      paddingPx: 24,
      baseFontPx: 16,
      allowSinglePng: !isTooLongForPng,
      rejectionReasonForPng: isTooLongForPng
        ? 'المستند طويل أو متعدد الصفحات؛ يُعتمد PDF للحفظ والمشاركة بدلاً من صورة واحدة.'
        : undefined,
    };
  }

  // A4 at crisp 150 DPI equivalent (1240 x 1754)
  return {
    paperSize: 'A4',
    canvasWidthPx: 1240,
    pageMaxHeightPx: 1754,
    paddingPx: 54,
    baseFontPx: 18,
    allowSinglePng: !isTooLongForPng,
    rejectionReasonForPng: isTooLongForPng
      ? 'التقرير أو الكشف متعدد الصفحات؛ الصيغة الرسمية المعتمدة للحفظ والمشاركة هي PDF وليس صورة طويلة.'
      : undefined,
  };
}

function wrapTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const clean = String(text || '').trim();
  if (!clean) return [];
  const paragraphs = clean.split(/\r?\n/);
  const lines: string[] = [];

  for (const para of paragraphs) {
    const words = para.split(/\s+/);
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

async function loadImageSafe(src?: string): Promise<HTMLImageElement | null> {
  if (!src || typeof Image === 'undefined') return null;
  // تجنب أي تحميل عبر الشبكة عند العمل دون إنترنت إذا لم يكن data URL أو مساراً محلياً
  const trimmed = src.trim();
  if (!trimmed) return null;
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = trimmed;
  });
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fillStyle?: string,
  strokeStyle?: string
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  if (fillStyle) {
    ctx.fillStyle = fillStyle;
    ctx.fill();
  }
  if (strokeStyle) {
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  if (typeof document === 'undefined') {
    throw new Error('رسم المستند غير متاح خارج بيئة المتصفح أو Electron.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function drawHeaderOnCanvas(
  ctx: CanvasRenderingContext2D,
  snapshot: DocumentSnapshot,
  spec: DocumentCanvasSpec,
  logoImg: HTMLImageElement | null,
  pageIndex: number,
  totalPages: number
): number {
  const { canvasWidthPx: W, paddingPx: pad, baseFontPx: fs, paperSize } = spec;
  const isThermal = paperSize !== 'A4';
  const contentW = W - pad * 2;
  let y = pad;

  // White canvas background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, spec.pageMaxHeightPx * 2);

  ctx.textBaseline = 'top';
  ctx.direction = 'rtl';

  if (isThermal) {
    // Centered thermal header
    if (logoImg) {
      const logoH = paperSize === '58mm' ? 42 : 52;
      const logoW = Math.min(120, Math.round((logoImg.width / (logoImg.height || 1)) * logoH));
      ctx.drawImage(logoImg, (W - logoW) / 2, y, logoW, logoH);
      y += logoH + 8;
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = '#0f172a';
    ctx.font = `800 ${fs + 4}px ${ARABIC_FONT_STACK}`;
    ctx.fillText(snapshot.meta.companyNameAr, W / 2, y);
    y += fs + 10;

    if (snapshot.meta.companyNameEn) {
      ctx.fillStyle = '#64748b';
      ctx.font = `600 ${fs - 3}px ${ARABIC_FONT_STACK}`;
      ctx.fillText(snapshot.meta.companyNameEn, W / 2, y);
      y += fs + 3;
    }

    ctx.fillStyle = '#475569';
    ctx.font = `500 ${fs - 3}px ${ARABIC_FONT_STACK}`;
    ctx.fillText(`الفرع: ${snapshot.meta.branchName}`, W / 2, y);
    y += fs + 3;

    if (snapshot.meta.phone || snapshot.meta.branchPhone) {
      ctx.fillText(`هاتف: ${snapshot.meta.phone || snapshot.meta.branchPhone}`, W / 2, y);
      y += fs + 3;
    }

    y += 4;
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(W - pad, y);
    ctx.stroke();
    y += 10;

    drawRoundedRect(ctx, W / 2 - (contentW * 0.45), y, contentW * 0.9, fs + 14, 6, '#0f172a');
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 ${fs + 1}px ${ARABIC_FONT_STACK}`;
    ctx.fillText(snapshot.documentTitle, W / 2, y + 6);
    y += fs + 20;

    ctx.fillStyle = '#334155';
    ctx.font = `700 ${fs - 2}px ${MONO_FONT_STACK}`;
    ctx.textAlign = 'right';
    ctx.fillText(`#${snapshot.documentNumber}`, W - pad, y);
    ctx.textAlign = 'left';
    ctx.fillText(snapshot.date, pad, y);
    y += fs + 8;

    return y;
  }

  // A4 Official Header
  const rightX = W - pad;
  let leftBlockBottom = y;

  if (logoImg) {
    const logoSize = 84;
    ctx.drawImage(logoImg, rightX - logoSize, y, logoSize, logoSize);
  }
  const textRightX = logoImg ? rightX - 98 : rightX;

  ctx.textAlign = 'right';
  ctx.fillStyle = '#0f172a';
  ctx.font = `900 ${fs + 8}px ${ARABIC_FONT_STACK}`;
  ctx.fillText(snapshot.meta.companyNameAr, textRightX, y);

  let infoY = y + fs + 14;
  if (snapshot.meta.companyNameEn) {
    ctx.fillStyle = '#64748b';
    ctx.font = `700 ${fs - 3}px ${ARABIC_FONT_STACK}`;
    ctx.fillText(snapshot.meta.companyNameEn, textRightX, infoY);
    infoY += fs + 2;
  }

  ctx.fillStyle = '#475569';
  ctx.font = `600 ${fs - 3}px ${ARABIC_FONT_STACK}`;
  const subDetails = [
    `الفرع: ${snapshot.meta.branchName}`,
    snapshot.meta.activityName ? `النشاط: ${snapshot.meta.activityName}` : '',
    snapshot.meta.phone || snapshot.meta.branchPhone
      ? `هاتف: ${snapshot.meta.phone || snapshot.meta.branchPhone}`
      : '',
  ]
    .filter(Boolean)
    .join('  |  ');
  ctx.fillText(subDetails, textRightX, infoY);
  infoY += fs + 4;

  if (snapshot.meta.address || snapshot.meta.taxNumber) {
    const addrDetails = [
      snapshot.meta.address || '',
      snapshot.meta.taxNumber ? `الرقم الضريبي: ${snapshot.meta.taxNumber}` : '',
    ]
      .filter(Boolean)
      .join('  |  ');
    ctx.fillStyle = '#64748b';
    ctx.font = `500 ${fs - 4}px ${ARABIC_FONT_STACK}`;
    ctx.fillText(addrDetails, textRightX, infoY);
    infoY += fs + 4;
  }

  // Left side classification box
  const badgeW = 280;
  const badgeH = 38;
  drawRoundedRect(ctx, pad, y, badgeW, badgeH, 6, '#0f172a');
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 ${fs}px ${ARABIC_FONT_STACK}`;
  ctx.fillText(snapshot.documentTitle, pad + badgeW / 2, y + 9);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#0f172a';
  ctx.font = `700 ${fs - 2}px ${MONO_FONT_STACK}`;
  ctx.fillText(snapshot.documentNumber, pad, y + badgeH + 10);

  ctx.fillStyle = '#475569';
  ctx.font = `500 ${fs - 4}px ${ARABIC_FONT_STACK}`;
  ctx.fillText(`تاريخ المستند: ${snapshot.date}`, pad, y + badgeH + 34);
  if (totalPages > 1) {
    ctx.fillText(`صفحة ${pageIndex + 1} من ${totalPages}`, pad, y + badgeH + 54);
  }

  leftBlockBottom = y + badgeH + 74;
  const headerBottom = Math.max(infoY + 8, leftBlockBottom);

  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(pad, headerBottom);
  ctx.lineTo(W - pad, headerBottom);
  ctx.stroke();

  return headerBottom + 18;
}

function drawFooterOnCanvas(
  ctx: CanvasRenderingContext2D,
  snapshot: DocumentSnapshot,
  spec: DocumentCanvasSpec,
  yStart: number,
  pageIndex: number,
  totalPages: number
): number {
  const { canvasWidthPx: W, paddingPx: pad, baseFontPx: fs, paperSize } = spec;
  const isThermal = paperSize !== 'A4';
  let y = yStart + 10;

  ctx.strokeStyle = '#cbd5e1';
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(pad, y);
  ctx.lineTo(W - pad, y);
  ctx.stroke();
  ctx.setLineDash([]);
  y += 10;

  if (snapshot.meta.footerNote) {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#334155';
    ctx.font = `700 ${fs - 4}px ${ARABIC_FONT_STACK}`;
    ctx.fillText(snapshot.meta.footerNote, W / 2, y);
    y += fs + 2;
  }

  ctx.fillStyle = '#64748b';
  ctx.font = `500 ${isThermal ? fs - 4 : fs - 5}px ${ARABIC_FONT_STACK}`;
  if (isThermal) {
    ctx.textAlign = 'center';
    ctx.fillText(`أعدّه: ${snapshot.meta.issuerName || 'النظام'} | ${snapshot.referenceText}`, W / 2, y);
    y += fs;
    ctx.fillText(`طُبع: ${snapshot.issuedAtTabular} (توقيت اليمن)`, W / 2, y);
    y += fs + 6;
  } else {
    ctx.textAlign = 'right';
    ctx.fillText(
      `أعدّه: ${snapshot.meta.issuerName || 'النظام المحاسبي'} | الفرع: ${snapshot.meta.branchName}`,
      W - pad,
      y
    );
    ctx.textAlign = 'center';
    ctx.fillText(
      totalPages > 1 ? `${snapshot.referenceText} | صفحة ${pageIndex + 1}/${totalPages}` : snapshot.referenceText,
      W / 2,
      y
    );
    ctx.textAlign = 'left';
    ctx.fillText(`توقيت اليمن: ${snapshot.issuedAtTabular}`, pad, y);
    y += fs + 10;
  }

  return y;
}

/**
 * رسم صفحات المستند على لوحات Canvas2D نظيفة من لقطة DocumentSnapshot
 */
export async function renderDocumentPagesAsCanvases(
  snapshot: DocumentSnapshot
): Promise<HTMLCanvasElement[]> {
  const spec = computeDocumentCanvasSpec(snapshot);
  const { canvasWidthPx: W, paddingPx: pad, baseFontPx: fs, paperSize } = spec;
  const isThermal = paperSize !== 'A4';
  const contentW = W - pad * 2;
  const logoImg = snapshot.meta.hasLogo ? await loadImageSafe(snapshot.meta.logoUrl) : null;

  // حساب تقسيم الصفحات للجدول إذا وُجد
  const tableRows = snapshot.table?.rows || [];
  const rowH = isThermal ? fs + 16 : fs + 20;
  const maxRowsFirstPage = paperSize === 'A4' ? 16 : 22;
  const maxRowsFollowPage = paperSize === 'A4' ? 28 : 26;

  const pageRowSlices: string[][][] = [];
  if (tableRows.length === 0) {
    pageRowSlices.push([]);
  } else if (tableRows.length <= maxRowsFirstPage) {
    pageRowSlices.push(tableRows);
  } else {
    pageRowSlices.push(tableRows.slice(0, maxRowsFirstPage));
    let idx = maxRowsFirstPage;
    while (idx < tableRows.length) {
      pageRowSlices.push(tableRows.slice(idx, idx + maxRowsFollowPage));
      idx += maxRowsFollowPage;
    }
  }

  const totalPages = pageRowSlices.length;
  const canvases: HTMLCanvasElement[] = [];

  for (let pIdx = 0; pIdx < totalPages; pIdx++) {
    const tempCanvas = createCanvas(W, isThermal ? 3200 : spec.pageMaxHeightPx);
    const ctx = tempCanvas.getContext('2d');
    if (!ctx) {
      throw new Error('تعذر تهيئة سياق الرسم (Canvas 2D).');
    }

    let y = drawHeaderOnCanvas(ctx, snapshot, spec, logoImg, pIdx, totalPages);

    // الحقول التعريفية تظهر في الصفحة الأولى
    if (pIdx === 0 && snapshot.fields.length > 0) {
      const boxPadding = isThermal ? 10 : 16;
      const lineStep = fs + (isThermal ? 8 : 10);
      const cols = isThermal ? 1 : 2;
      const rowsNeeded = Math.ceil(snapshot.fields.length / cols);
      const boxH = boxPadding * 2 + rowsNeeded * lineStep;

      drawRoundedRect(ctx, pad, y, contentW, boxH, 8, '#f8fafc', '#e2e8f0');
      ctx.font = `600 ${fs - 2}px ${ARABIC_FONT_STACK}`;
      for (let i = 0; i < snapshot.fields.length; i++) {
        const f = snapshot.fields[i];
        const colIdx = isThermal ? 0 : i % 2;
        const rowIdx = isThermal ? i : Math.floor(i / 2);
        const cellXRight =
          cols === 1 ? W - pad - boxPadding : W - pad - boxPadding - colIdx * (contentW / 2);
        const cellY = y + boxPadding + rowIdx * lineStep;
        ctx.textAlign = 'right';
        ctx.fillStyle = '#64748b';
        const labelStr = `${f.label}: `;
        ctx.fillText(labelStr, cellXRight, cellY);
        const lw = ctx.measureText(labelStr).width;
        ctx.fillStyle = '#0f172a';
        ctx.font = `700 ${fs - 2}px ${ARABIC_FONT_STACK}`;
        ctx.fillText(f.value, cellXRight - lw - 4, cellY);
        ctx.font = `600 ${fs - 2}px ${ARABIC_FONT_STACK}`;
      }
      y += boxH + 14;
    }

    // جدول البنود أو الحركات
    const currentRows = pageRowSlices[pIdx];
    if (snapshot.table && currentRows.length > 0) {
      const columns = snapshot.table.columns;
      const totalWeight = columns.reduce((s, c) => s + (c.widthWeight || 1), 0);
      const colWidths = columns.map((c) => ((c.widthWeight || 1) / totalWeight) * contentW);

      const headerH = isThermal ? fs + 16 : fs + 20;
      drawRoundedRect(ctx, pad, y, contentW, headerH, 6, '#0f172a');
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${fs - 3}px ${ARABIC_FONT_STACK}`;

      let colCursorRight = W - pad;
      for (let cIdx = 0; cIdx < columns.length; cIdx++) {
        const col = columns[cIdx];
        const cw = colWidths[cIdx];
        const colLeft = colCursorRight - cw;
        if (col.align === 'left') {
          ctx.textAlign = 'left';
          ctx.fillText(col.label, colLeft + 8, y + 8);
        } else if (col.align === 'center') {
          ctx.textAlign = 'center';
          ctx.fillText(col.label, colLeft + cw / 2, y + 8);
        } else {
          ctx.textAlign = 'right';
          ctx.fillText(col.label, colCursorRight - 8, y + 8);
        }
        colCursorRight = colLeft;
      }
      y += headerH;

      for (let rIdx = 0; rIdx < currentRows.length; rIdx++) {
        const row = currentRows[rIdx];
        ctx.fillStyle = rIdx % 2 === 1 ? '#f8fafc' : '#ffffff';
        ctx.fillRect(pad, y, contentW, rowH);
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 1;
        ctx.strokeRect(pad, y, contentW, rowH);

        colCursorRight = W - pad;
        ctx.fillStyle = '#0f172a';
        ctx.font = `600 ${isThermal ? fs - 4 : fs - 3}px ${ARABIC_FONT_STACK}`;
        for (let cIdx = 0; cIdx < columns.length; cIdx++) {
          const col = columns[cIdx];
          const cw = colWidths[cIdx];
          const colLeft = colCursorRight - cw;
          const cellVal = String(row[cIdx] ?? '-').slice(0, isThermal ? 24 : 46);
          if (col.align === 'left') {
            ctx.textAlign = 'left';
            ctx.fillText(cellVal, colLeft + 8, y + 8);
          } else if (col.align === 'center') {
            ctx.textAlign = 'center';
            ctx.fillText(cellVal, colLeft + cw / 2, y + 8);
          } else {
            ctx.textAlign = 'right';
            ctx.fillText(cellVal, colCursorRight - 8, y + 8);
          }
          colCursorRight = colLeft;
        }
        y += rowH;
      }
      y += 14;
    }

    // الإجماليات وبانر المبلغ والملاحظات والتوقيعات على الصفحة الأخيرة
    if (pIdx === totalPages - 1) {
      if (snapshot.totalsRows && snapshot.totalsRows.length > 0) {
        const boxH = 16 + snapshot.totalsRows.length * (fs + 10);
        drawRoundedRect(ctx, pad, y, contentW, boxH, 8, '#f8fafc', '#cbd5e1');
        let ty = y + 10;
        for (const tr of snapshot.totalsRows) {
          ctx.textAlign = 'right';
          ctx.fillStyle = tr.highlight ? '#9f1239' : '#334155';
          ctx.font = `${tr.highlight ? '800' : '600'} ${fs - 2}px ${ARABIC_FONT_STACK}`;
          ctx.fillText(tr.label, W - pad - 12, ty);
          ctx.textAlign = 'left';
          ctx.fillText(tr.value, pad + 12, ty);
          ty += fs + 10;
        }
        y += boxH + 12;
      }

      if (snapshot.amount !== undefined) {
        const bannerH = isThermal ? 64 : 74;
        drawRoundedRect(ctx, pad, y, contentW, bannerH, 8, '#0f172a');
        ctx.textAlign = 'right';
        ctx.fillStyle = '#cbd5e1';
        ctx.font = `600 ${fs - 3}px ${ARABIC_FONT_STACK}`;
        ctx.fillText(snapshot.amountLabel || 'الإجمالي', W - pad - 14, y + 10);

        if (snapshot.amountInWords) {
          ctx.fillStyle = '#6ee7b7';
          ctx.font = `600 ${isThermal ? fs - 4 : fs - 2}px ${ARABIC_FONT_STACK}`;
          ctx.fillText(snapshot.amountInWords, W - pad - 14, y + 34);
        }

        ctx.textAlign = 'left';
        ctx.fillStyle = '#ffffff';
        ctx.font = `900 ${isThermal ? fs + 4 : fs + 8}px ${MONO_FONT_STACK}`;
        ctx.fillText(
          `${Number(snapshot.amount).toFixed(snapshot.meta.currency.decimalPlaces ?? 2)} ${
            snapshot.meta.currency.symbol
          }`,
          pad + 14,
          y + 20
        );
        y += bannerH + 14;
      }

      if (snapshot.notes) {
        ctx.font = `500 ${fs - 3}px ${ARABIC_FONT_STACK}`;
        const wrapped = wrapTextLines(ctx, `ملاحظات: ${snapshot.notes}`, contentW - 24);
        const noteH = 16 + wrapped.length * (fs + 6);
        drawRoundedRect(ctx, pad, y, contentW, noteH, 6, '#f8fafc', '#e2e8f0');
        ctx.textAlign = 'right';
        ctx.fillStyle = '#334155';
        let ny = y + 8;
        for (const line of wrapped) {
          ctx.fillText(line, W - pad - 12, ny);
          ny += fs + 6;
        }
        y += noteH + 12;
      }

      if (!isThermal && snapshot.signatures && snapshot.signatures.length > 0) {
        const sigCount = Math.min(3, snapshot.signatures.length);
        const slotW = contentW / sigCount;
        ctx.textAlign = 'center';
        for (let i = 0; i < sigCount; i++) {
          const sig = snapshot.signatures[i];
          const cx = W - pad - slotW * (i + 0.5);
          ctx.fillStyle = '#475569';
          ctx.font = `600 ${fs - 3}px ${ARABIC_FONT_STACK}`;
          ctx.fillText(sig.roleLabel, cx, y);
          ctx.fillStyle = '#0f172a';
          ctx.font = `700 ${fs - 2}px ${ARABIC_FONT_STACK}`;
          ctx.fillText(sig.name || '...................', cx, y + 34);
        }
        y += 68;
      }
    }

    const finalBottom = drawFooterOnCanvas(ctx, snapshot, spec, y, pIdx, totalPages);
    const finalHeight =
      paperSize === 'A4'
        ? Math.max(spec.pageMaxHeightPx, Math.min(spec.pageMaxHeightPx, finalBottom + pad))
        : Math.max(420, finalBottom + pad);

    // قص اللوحة للطول الفعلي الدقيق للمستند (دون مساحات فارغة زائدة في الإيصال الحراري)
    const cropped = createCanvas(W, finalHeight);
    const cCtx = cropped.getContext('2d');
    if (!cCtx) throw new Error('تعذر إخراج لوحة المستند النهائية.');
    cCtx.fillStyle = '#ffffff';
    cCtx.fillRect(0, 0, W, finalHeight);
    cCtx.drawImage(tempCanvas, 0, 0, W, finalHeight, 0, 0, W, finalHeight);

    canvases.push(cropped);
  }

  return canvases;
}

async function canvasToBytes(
  canvas: HTMLCanvasElement,
  mimeType: 'image/png' | 'image/jpeg',
  quality?: number
): Promise<{ blob: Blob; bytes: Uint8Array }> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (!b || b.size === 0) {
          reject(new Error(`فشل إنشاء بيانات الصورة (${mimeType}).`));
          return;
        }
        resolve(b);
      },
      mimeType,
      quality
    );
  });
  const buf = await blob.arrayBuffer();
  return { blob, bytes: new Uint8Array(buf) };
}

/**
 * تصدير المستند القصير كصورة PNG نظيفة (AMRO-DOC-OPS-002)
 */
export async function renderDocumentToPngBlob(
  snapshot: DocumentSnapshot
): Promise<RenderedPngResult> {
  const spec = computeDocumentCanvasSpec(snapshot);
  if (!spec.allowSinglePng) {
    throw new Error(
      spec.rejectionReasonForPng ||
        'هذا المستند متعدد الصفحات؛ يرجى استخدام صيغة PDF الرسمية بدلاً من صورة PNG واحدة.'
    );
  }

  const canvases = await renderDocumentPagesAsCanvases(snapshot);
  if (canvases.length !== 1) {
    throw new Error(
      'امتد المستند لأكثر من صفحة واحدة؛ تم إيقاف التحويل إلى صورة PNG طويلة لصالح صيغة PDF.'
    );
  }

  const target = canvases[0];
  const { blob, bytes } = await canvasToBytes(target, 'image/png');
  if (!isValidPngBytes(bytes)) {
    throw new Error('فشل التحقق من سلامة ملف PNG المنشأ.');
  }

  const fileName = buildStructuredDocumentFilename({
    kind: snapshot.documentKind,
    documentNumber: snapshot.documentNumber,
    date: snapshot.date,
    ext: 'png',
  });

  return {
    blob,
    bytes,
    fileName,
    width: target.width,
    height: target.height,
    mimeType: 'image/png',
  };
}

/**
 * إنشاء ملف PDF متعدد الصفحات محلياً دون إنترنت من نفس لقطة المستند
 */
export async function renderDocumentToPdfBlob(
  snapshot: DocumentSnapshot
): Promise<RenderedPdfResult> {
  const canvases = await renderDocumentPagesAsCanvases(snapshot);
  const pages: PdfRasterPageInput[] = [];

  for (const canvas of canvases) {
    const { bytes } = await canvasToBytes(canvas, 'image/jpeg', 0.94);
    const dims = getPdfPageDimensionsPt(snapshot.paperSize, canvas.height / canvas.width);
    pages.push({
      jpegBytes: bytes,
      pixelWidth: canvas.width,
      pixelHeight: canvas.height,
      pageWidthPt: dims.widthPt,
      pageHeightPt: dims.heightPt,
    });
  }

  const pdfBytes = buildPdfFromRasterPages(pages);
  if (!isValidPdfBytes(pdfBytes)) {
    throw new Error('فشل التحقق من بنية ملف PDF المحلي.');
  }

  const fileName = buildStructuredDocumentFilename({
    kind: snapshot.documentKind,
    documentNumber: snapshot.documentNumber,
    date: snapshot.date,
    ext: 'pdf',
  });

  const pdfBufferCopy = new ArrayBuffer(pdfBytes.byteLength);
  new Uint8Array(pdfBufferCopy).set(pdfBytes);

  return {
    blob: new Blob([pdfBufferCopy], { type: 'application/pdf' }),
    bytes: pdfBytes,
    fileName,
    pageCount: pages.length,
    mimeType: 'application/pdf',
  };
}
