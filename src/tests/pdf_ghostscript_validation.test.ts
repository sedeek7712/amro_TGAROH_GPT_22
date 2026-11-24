import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import {
  buildPdfFromRasterPages,
  getPdfPageDimensionsPt,
  isValidPdfBytes,
  type PdfRasterPageInput,
} from '../services/documents/pdfContainer';

const GS_BIN = '/usr/bin/gs';

async function createSampleJpeg(width: number, height: number, color: { r: number; g: number; b: number }) {
  const buf = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: color,
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  return new Uint8Array(buf);
}

function inspectPdfWithGhostscript(pdfPath: string, outPngPattern: string) {
  // 1) Structural + stream validation
  const nullPageOut = execFileSync(
    GS_BIN,
    ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=nullpage', pdfPath],
    { encoding: 'utf8' }
  );

  // 2) Exact page count
  const pageCountRaw = execFileSync(
    GS_BIN,
    [
      '-q',
      '-dNODISPLAY',
      '-dNOSAFER',
      '-c',
      `(${pdfPath}) (r) file runpdfbegin pdfpagecount = quit`,
    ],
    { encoding: 'utf8' }
  ).trim();
  const pageCount = Number.parseInt(pageCountRaw, 10);

  // 3) Exact MediaBox array in preserved coordinate order [x1 y1 x2 y2]
  const mediaBoxRaw = execFileSync(
    GS_BIN,
    [
      '-q',
      '-dNODISPLAY',
      '-dNOSAFER',
      '-c',
      `(${pdfPath}) (r) file runpdfbegin 1 pdfgetpage /MediaBox get { =only ( ) print } forall quit`,
    ],
    { encoding: 'utf8' }
  ).trim();
  const mediaBox = mediaBoxRaw.split(/\s+/).map(Number);

  // 4) Raster render to PNG
  execFileSync(GS_BIN, [
    '-q',
    '-dNOPAUSE',
    '-dBATCH',
    '-dSAFER',
    '-sDEVICE=png16m',
    '-r150',
    `-o`,
    outPngPattern,
    pdfPath,
  ]);

  return { nullPageOut, pageCount, mediaBox };
}

test('DOC-004-07: Independent GNU Ghostscript validation of A4, 80mm, 58mm, and multi-page PDF documents', async () => {
  assert.ok(existsSync(GS_BIN), 'GNU Ghostscript binary (/usr/bin/gs) must exist in container');
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'amro-gs-pdf-'));

  try {
    // 1) A4 single page PDF
    const a4Dims = getPdfPageDimensionsPt('A4');
    const a4Jpeg = await createSampleJpeg(620, 877, { r: 245, g: 248, b: 252 });
    const a4Pdf = buildPdfFromRasterPages([
      {
        jpegBytes: a4Jpeg,
        pixelWidth: 620,
        pixelHeight: 877,
        pageWidthPt: a4Dims.widthPt,
        pageHeightPt: a4Dims.heightPt,
      },
    ]);
    assert.equal(isValidPdfBytes(a4Pdf), true);
    const a4Path = path.join(tmpDir, 'test-a4.pdf');
    writeFileSync(a4Path, a4Pdf);
    const a4Gs = inspectPdfWithGhostscript(a4Path, path.join(tmpDir, 'a4-page-%d.png'));
    assert.equal(a4Gs.pageCount, 1);
    assert.equal(a4Gs.mediaBox.length, 4);
    assert.ok(Math.abs(a4Gs.mediaBox[2] - 595.28) < 0.05);
    assert.ok(Math.abs(a4Gs.mediaBox[3] - 841.89) < 0.05);
    const a4Meta = await sharp(path.join(tmpDir, 'a4-page-1.png')).metadata();
    assert.equal(a4Meta.format, 'png');
    assert.ok((a4Meta.width ?? 0) > 1000 && (a4Meta.height ?? 0) > 1400);

    // 2) 80mm thermal PDF
    const t80Dims = getPdfPageDimensionsPt('80mm', 900 / 620);
    const t80Jpeg = await createSampleJpeg(620, 900, { r: 255, g: 255, b: 255 });
    const t80Pdf = buildPdfFromRasterPages([
      {
        jpegBytes: t80Jpeg,
        pixelWidth: 620,
        pixelHeight: 900,
        pageWidthPt: t80Dims.widthPt,
        pageHeightPt: t80Dims.heightPt,
      },
    ]);
    const t80Path = path.join(tmpDir, 'test-80mm.pdf');
    writeFileSync(t80Path, t80Pdf);
    const t80Gs = inspectPdfWithGhostscript(t80Path, path.join(tmpDir, 't80-page-%d.png'));
    assert.equal(t80Gs.pageCount, 1);
    assert.ok(Math.abs(t80Gs.mediaBox[2] - 226.77) < 0.05);
    const t80Meta = await sharp(path.join(tmpDir, 't80-page-1.png')).metadata();
    assert.equal(t80Meta.format, 'png');
    assert.ok((t80Meta.width ?? 0) > 400);

    // 3) 58mm thermal PDF
    const t58Dims = getPdfPageDimensionsPt('58mm', 760 / 460);
    const t58Jpeg = await createSampleJpeg(460, 760, { r: 250, g: 250, b: 250 });
    const t58Pdf = buildPdfFromRasterPages([
      {
        jpegBytes: t58Jpeg,
        pixelWidth: 460,
        pixelHeight: 760,
        pageWidthPt: t58Dims.widthPt,
        pageHeightPt: t58Dims.heightPt,
      },
    ]);
    const t58Path = path.join(tmpDir, 'test-58mm.pdf');
    writeFileSync(t58Path, t58Pdf);
    const t58Gs = inspectPdfWithGhostscript(t58Path, path.join(tmpDir, 't58-page-%d.png'));
    assert.equal(t58Gs.pageCount, 1);
    assert.ok(Math.abs(t58Gs.mediaBox[2] - 164.41) < 0.05);

    // 4) Multi-page (3-page) A4 report PDF
    const multiPages: PdfRasterPageInput[] = [];
    for (let i = 0; i < 3; i++) {
      const jpegBytes = await createSampleJpeg(620, 877, { r: 240 - i * 10, g: 245, b: 250 });
      multiPages.push({
        jpegBytes,
        pixelWidth: 620,
        pixelHeight: 877,
        pageWidthPt: a4Dims.widthPt,
        pageHeightPt: a4Dims.heightPt,
      });
    }
    const multiPdf = buildPdfFromRasterPages(multiPages);
    const multiPath = path.join(tmpDir, 'test-multipage.pdf');
    writeFileSync(multiPath, multiPdf);
    const multiGs = inspectPdfWithGhostscript(multiPath, path.join(tmpDir, 'multi-page-%d.png'));
    assert.equal(multiGs.pageCount, 3);
    const renderedMultiPngs = readdirSync(tmpDir).filter((f) => f.startsWith('multi-page-') && f.endsWith('.png'));
    assert.equal(renderedMultiPngs.length, 3);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
