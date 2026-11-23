/**
 * محرك تغليف PDF قياسي (%PDF-1.4) دون اعتماديات خارجية أو اتصال بالإنترنت
 * يبني ملف PDF حقيقي صالح للفتح والطباعة والمشاركة من صفحات مرسومة عالية الدقة
 */

export interface PdfRasterPageInput {
  jpegBytes: Uint8Array;
  pixelWidth: number;
  pixelHeight: number;
  pageWidthPt: number;
  pageHeightPt: number;
}

export function getPdfPageDimensionsPt(
  paperSize: 'A4' | '80mm' | '58mm',
  aspectRatioHeightOverWidth?: number
): { widthPt: number; heightPt: number } {
  if (paperSize === '58mm') {
    const widthPt = 164.41; // 58mm * 72 / 25.4
    const heightPt = aspectRatioHeightOverWidth
      ? Math.max(200, Math.round(widthPt * aspectRatioHeightOverWidth))
      : 420;
    return { widthPt, heightPt };
  }
  if (paperSize === '80mm') {
    const widthPt = 226.77; // 80mm * 72 / 25.4
    const heightPt = aspectRatioHeightOverWidth
      ? Math.max(240, Math.round(widthPt * aspectRatioHeightOverWidth))
      : 560;
    return { widthPt, heightPt };
  }
  return { widthPt: 595.28, heightPt: 841.89 }; // A4 portrait
}

function encodeAscii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    out[i] = text.charCodeAt(i) & 0xff;
  }
  return out;
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * إنشاء مستند PDF-1.4 متعدد الصفحات والتحقق من صحة الترويسة (%PDF-) والبنية
 */
export function buildPdfFromRasterPages(pages: PdfRasterPageInput[]): Uint8Array {
  if (!pages || pages.length === 0) {
    throw new Error('تعذر إنشاء ملف PDF لعدم وجود صفحات صالحة.');
  }

  for (const p of pages) {
    if (!p.jpegBytes || p.jpegBytes.length < 4 || p.pixelWidth <= 0 || p.pixelHeight <= 0) {
      throw new Error('بيانات صفحة PDF غير مكتملة أو تالفة.');
    }
  }

  const objects: Array<{ id: number; chunks: Uint8Array[] }> = [];
  // 1: Catalog, 2: Pages
  const pageObjectIds: number[] = [];
  let nextObjId = 3;

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const imageObjId = nextObjId++;
    const contentObjId = nextObjId++;
    const pageObjId = nextObjId++;
    pageObjectIds.push(pageObjId);

    // Image XObject (DCTDecode)
    objects.push({
      id: imageObjId,
      chunks: [
        encodeAscii(
          `${imageObjId} 0 obj\n` +
            `<< /Type /XObject /Subtype /Image /Width ${Math.round(p.pixelWidth)} ` +
            `/Height ${Math.round(p.pixelHeight)} /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
            `/Filter /DCTDecode /Length ${p.jpegBytes.length} >>\nstream\n`
        ),
        p.jpegBytes,
        encodeAscii(`\nendstream\nendobj\n`),
      ],
    });

    // Draw image fitted cleanly to page box
    const drawStream = `q\n${p.pageWidthPt.toFixed(2)} 0 0 ${p.pageHeightPt.toFixed(2)} 0 0 cm\n/Im0 Do\nQ\n`;
    const drawBytes = encodeAscii(drawStream);

    objects.push({
      id: contentObjId,
      chunks: [
        encodeAscii(`${contentObjId} 0 obj\n<< /Length ${drawBytes.length} >>\nstream\n`),
        drawBytes,
        encodeAscii(`endstream\nendobj\n`),
      ],
    });

    objects.push({
      id: pageObjId,
      chunks: [
        encodeAscii(
          `${pageObjId} 0 obj\n` +
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.pageWidthPt.toFixed(2)} ${p.pageHeightPt.toFixed(2)}] ` +
            `/Resources << /XObject << /Im0 ${imageObjId} 0 R >> >> /Contents ${contentObjId} 0 R >>\n` +
            `endobj\n`
        ),
      ],
    });
  }

  const catalogObj = {
    id: 1,
    chunks: [encodeAscii(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`)],
  };
  const kidsRefs = pageObjectIds.map((id) => `${id} 0 R`).join(' ');
  const pagesObj = {
    id: 2,
    chunks: [
      encodeAscii(
        `2 0 obj\n<< /Type /Pages /Kids [${kidsRefs}] /Count ${pageObjectIds.length} >>\nendobj\n`
      ),
    ],
  };

  const orderedObjects = [catalogObj, pagesObj, ...objects].sort((a, b) => a.id - b.id);
  const header = encodeAscii(`%PDF-1.4\n%\xFF\xFF\xFF\xFF\n`);
  const bodyParts: Uint8Array[] = [header];
  const offsets: number[] = [0]; // obj 0

  let cursor = header.length;
  for (const obj of orderedObjects) {
    offsets[obj.id] = cursor;
    for (const chunk of obj.chunks) {
      bodyParts.push(chunk);
      cursor += chunk.length;
    }
  }

  const xrefOffset = cursor;
  const totalObjects = orderedObjects.length + 1;
  const xrefLines = [`xref\n0 ${totalObjects}\n`, `0000000000 65535 f \n`];
  for (let id = 1; id < totalObjects; id++) {
    const off = String(offsets[id] || 0).padStart(10, '0');
    xrefLines.push(`${off} 00000 n \n`);
  }
  const trailer =
    `trailer\n<< /Size ${totalObjects} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  bodyParts.push(encodeAscii(xrefLines.join('') + trailer));
  return concatUint8Arrays(bodyParts);
}

export function isValidPdfBytes(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < 32) return false;
  return (
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d // -
  );
}
