import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  classifyFsErrorStatus,
  executeCleanupShareTempFileIpc,
  executeExportPdfIpc,
  executeExportPngIpc,
  executeRunNativePrintIpc,
  openAllowedWhatsAppUrl,
  prepareShareTempFileOnDisk,
  purgeStaleShareTempFiles,
  resolveNativePrintOptions,
  resolvePrintCallbackOutcome,
  revealShareTempFileOnDisk,
  SHARE_TEMP_RETENTION_MS,
} from '../../electron/document-ipc-helpers.mjs';

function makeValidPdfBuffer() {
  const body =
    '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n' +
    'xref\n0 3\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n' +
    'trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n109\n%%EOF\n';
  return Buffer.from(body, 'ascii');
}

function makeValidPngBuffer() {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const payload = Buffer.alloc(64, 0x41);
  return Buffer.concat([header, payload]);
}

function createFakeLogger() {
  const logs = [];
  return {
    logs,
    log(level, scope, message, meta) {
      logs.push({ level, scope, message, meta });
    },
  };
}

test('DOC-004-02: resolveNativePrintOptions maps A4, 80mm, and 58mm to explicit Electron micron specs & margins', () => {
  const a4 = resolveNativePrintOptions({ pageSize: 'A4' });
  assert.equal(a4.pageSize, 'A4');
  assert.deepEqual(a4.margins, { marginType: 'default' });

  const thermal80 = resolveNativePrintOptions({ pageSize: '80mm', contentHeightMm: 140 });
  assert.deepEqual(thermal80.pageSize, { width: 80000, height: 155000 });
  assert.deepEqual(thermal80.margins, { marginType: 'none' });

  const thermal58 = resolveNativePrintOptions({ pageSize: '58mm', contentHeightMm: 70 });
  // 70 + 15 = 85 -> clamped to minimum 100mm = 100000 microns
  assert.deepEqual(thermal58.pageSize, { width: 58000, height: 100000 });
  assert.deepEqual(thermal58.margins, { marginType: 'none' });

  const thermalOverMax = resolveNativePrintOptions({ pageSize: '80mm', contentHeightMm: 3000 });
  assert.deepEqual(thermalOverMax.pageSize, { width: 80000, height: 2000000 });
});

test('DOC-004-02 & DOC-004-08: executeRunNativePrintIpc passes paper options & classifies sent/canceled/failed/unconfirmed/window-unavailable', async () => {
  const capturedCalls = [];
  const logger = createFakeLogger();

  const windowUnavailable = await executeRunNativePrintIpc({
    mainWindow: null,
    input: { pageSize: 'A4' },
    actor: { username: 'admin' },
    logger,
  });
  assert.equal(windowUnavailable.outcome, 'window-unavailable');
  assert.equal(windowUnavailable.printed, false);

  const mockWindow = {
    isDestroyed: () => false,
    webContents: {
      print(opts, cb) {
        capturedCalls.push(opts);
        if (opts.pageSize === 'A4') cb(true, '');
        else if (opts.pageSize.width === 80000) cb(false, 'cancelled');
        else if (opts.pageSize.width === 58000 && opts.pageSize.height === 120000) cb(false, 'Printer offline');
        else cb(false, '');
      },
    },
  };

  const sent = await executeRunNativePrintIpc({
    mainWindow: mockWindow,
    input: { pageSize: 'A4' },
    actor: { username: 'admin' },
    logger,
  });
  assert.equal(sent.outcome, 'sent');
  assert.equal(sent.printed, true);
  assert.equal(capturedCalls[0].pageSize, 'A4');

  const canceled = await executeRunNativePrintIpc({
    mainWindow: mockWindow,
    input: { pageSize: '80mm', contentHeightMm: 120 },
    actor: { username: 'admin' },
    logger,
  });
  assert.equal(canceled.outcome, 'canceled');
  assert.equal(canceled.canceled, true);
  assert.deepEqual(capturedCalls[1].pageSize, { width: 80000, height: 135000 });

  const failed = await executeRunNativePrintIpc({
    mainWindow: mockWindow,
    input: { pageSize: '58mm', contentHeightMm: 105 },
    actor: { username: 'admin' },
    logger,
  });
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.failureReason, 'Printer offline');

  const unconfirmed = await executeRunNativePrintIpc({
    mainWindow: mockWindow,
    input: { pageSize: '58mm', contentHeightMm: 150 },
    actor: { username: 'admin' },
    logger,
  });
  assert.equal(unconfirmed.outcome, 'unconfirmed');
  assert.equal(unconfirmed.printed, false);
  assert.equal(unconfirmed.canceled, false);
  assert.equal(resolvePrintCallbackOutcome(false, undefined).outcome, 'unconfirmed');
});

test('DOC-004-05 & DOC-004-08: executeExportPdfIpc & executeExportPngIpc real FS outcomes and no silent printToPDF fallback', async () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'amro-doc-ipc-'));
  const logger = createFakeLogger();
  let printToPdfInvoked = false;
  const mockWindow = {
    webContents: {
      async printToPDF() {
        printToPdfInvoked = true;
        return makeValidPdfBuffer();
      },
    },
  };

  try {
    // 1) Missing pdfBase64 -> CREATE_FAILED without calling printToPDF
    const missingPayload = await executeExportPdfIpc({
      mainWindow: mockWindow,
      dialog: { async showSaveDialog() { throw new Error('Should not open save dialog'); } },
      input: { title: 'INV-1', pageSize: 'A4' },
      actor: { username: 'admin' },
      logger,
    });
    assert.equal(missingPayload.status, 'CREATE_FAILED');
    assert.equal(printToPdfInvoked, false);

    // 2) Corrupt PDF bytes -> CREATE_FAILED
    const invalidBytes = await executeExportPdfIpc({
      mainWindow: mockWindow,
      dialog: { async showSaveDialog() { throw new Error('Should not open save dialog'); } },
      input: {
        title: 'INV-BAD',
        pdfBase64: Buffer.from('not a pdf document at all').toString('base64'),
      },
      actor: { username: 'admin' },
      logger,
    });
    assert.equal(invalidBytes.status, 'CREATE_FAILED');

    // 3) User cancels dialog -> CANCELED
    const pdfB64 = makeValidPdfBuffer().toString('base64');
    const canceledRes = await executeExportPdfIpc({
      mainWindow: mockWindow,
      dialog: { async showSaveDialog() { return { canceled: true }; } },
      input: { title: 'INV-CANCEL', pdfBase64: pdfB64 },
      actor: { username: 'admin' },
      logger,
    });
    assert.equal(canceledRes.status, 'CANCELED');
    assert.equal(canceledRes.canceled, true);

    // 4) Missing parent directory -> PATH_UNREACHABLE
    const missingParent = path.join(workDir, 'nonexistent-folder', 'doc.pdf');
    const unreachableRes = await executeExportPdfIpc({
      mainWindow: mockWindow,
      dialog: { async showSaveDialog() { return { canceled: false, filePath: missingParent }; } },
      input: { title: 'INV-UNREACH', pdfBase64: pdfB64 },
      actor: { username: 'admin' },
      logger,
    });
    assert.equal(unreachableRes.status, 'PATH_UNREACHABLE');

    // 5) Target is a directory (EISDIR) -> WRITE_FAILED
    const dirTarget = path.join(workDir, 'is-a-directory');
    mkdirSync(dirTarget);
    const eisdirRes = await executeExportPdfIpc({
      mainWindow: mockWindow,
      dialog: { async showSaveDialog() { return { canceled: false, filePath: dirTarget }; } },
      input: { title: 'INV-EISDIR', pdfBase64: pdfB64 },
      actor: { username: 'admin' },
      logger,
    });
    assert.equal(eisdirRes.status, 'WRITE_FAILED');

    // 6) Valid save -> SAVED with real size & content on disk
    const validOut = path.join(workDir, 'INV-SAVED.pdf');
    const savedRes = await executeExportPdfIpc({
      mainWindow: mockWindow,
      dialog: { async showSaveDialog() { return { canceled: false, filePath: validOut }; } },
      input: { title: 'INV-SAVED', pdfBase64: pdfB64 },
      actor: { username: 'admin' },
      logger,
    });
    assert.equal(savedRes.status, 'SAVED');
    assert.equal(savedRes.source, 'SNAPSHOT_PDF');
    assert.ok(existsSync(validOut));
    assert.equal(readFileSync(validOut).subarray(0, 5).toString('ascii'), '%PDF-');

    // 7) PNG export invalid vs valid save
    const badPng = await executeExportPngIpc({
      mainWindow: mockWindow,
      dialog: { async showSaveDialog() { return { canceled: false, filePath: path.join(workDir, 'bad.png') }; } },
      input: { title: 'bad', bytesBase64: Buffer.from('plain text').toString('base64') },
      actor: { username: 'admin' },
      logger,
    });
    assert.equal(badPng.status, 'CREATE_FAILED');

    const pngOut = path.join(workDir, 'ok.png');
    const goodPng = await executeExportPngIpc({
      mainWindow: mockWindow,
      dialog: { async showSaveDialog() { return { canceled: false, filePath: pngOut }; } },
      input: { title: 'ok', bytesBase64: makeValidPngBuffer().toString('base64') },
      actor: { username: 'admin' },
      logger,
    });
    assert.equal(goodPng.status, 'SAVED');
    assert.ok(goodPng.sizeBytes > 32);

    assert.equal(classifyFsErrorStatus({ code: 'EACCES' }), 'PATH_UNREACHABLE');
    assert.equal(classifyFsErrorStatus({ code: 'EIO' }), 'WRITE_FAILED');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('DOC-004-06 & DOC-004-03 & DOC-004-08: 7-day temp retention cleanup, reveal containment & shell error handling, and WhatsApp URL allowlist', async () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'amro-share-temp-'));
  const tempDir = path.join(workDir, 'AmroErpShareTemp');
  const outsideFile = path.join(workDir, 'outside-secret.txt');
  writeFileSync(outsideFile, 'keep-me');
  const shareTempFiles = new Map();
  const logger = createFakeLogger();

  try {
    // Missing dir should not throw
    const emptyCleanup = purgeStaleShareTempFiles({
      tempDir,
      shareTempFiles,
      retentionMs: SHARE_TEMP_RETENTION_MS,
    });
    assert.equal(emptyCleanup.removedFiles, 0);

    // Reject malformed payloads and MIME/extension mismatches before writing to disk.
    assert.throws(
      () => prepareShareTempFileOnDisk({
        tempDir,
        shareTempFiles,
        input: { fileName: 'bad.pdf', bytesBase64: '%%%%' },
      }),
      /Base64/
    );
    assert.throws(
      () => prepareShareTempFileOnDisk({
        tempDir,
        shareTempFiles,
        input: {
          fileName: 'wrong.pdf',
          bytesBase64: makeValidPdfBuffer().toString('base64'),
          mimeType: 'image/png',
        },
      }),
      /PNG/
    );

    // Prepare real temp file
    const prepared = prepareShareTempFileOnDisk({
      tempDir,
      shareTempFiles,
      input: {
        fileName: '../../evil/INV-77.pdf',
        bytesBase64: makeValidPdfBuffer().toString('base64'),
      },
    });
    assert.equal(prepared.fileName, 'INV-77.pdf');
    assert.ok(prepared.sizeBytes > 64);

    // Reveal valid file
    let shownPath = '';
    const revealOk = revealShareTempFileOnDisk({
      tempDir,
      shareTempFiles,
      shell: { showItemInFolder: (p) => { shownPath = p; } },
      tempToken: prepared.tempToken,
    });
    assert.equal(revealOk.revealed, true);
    assert.equal(revealOk.exists, true);
    assert.ok(shownPath.startsWith(tempDir));

    // Reveal catches shell.showItemInFolder error cleanly
    const revealThrow = revealShareTempFileOnDisk({
      tempDir,
      shareTempFiles,
      shell: { showItemInFolder: () => { throw new Error('Explorer failed'); } },
      tempToken: prepared.tempToken,
    });
    assert.equal(revealThrow.revealed, false);
    assert.equal(revealThrow.exists, true);
    assert.ok(revealThrow.error.includes('Explorer failed'));

    // Reveal blocks path traversal outside tempDir
    shareTempFiles.set('evil-token', {
      path: outsideFile,
      fileName: 'outside.txt',
      createdAt: Date.now(),
    });
    const revealBlocked = revealShareTempFileOnDisk({
      tempDir,
      shareTempFiles,
      shell: { showItemInFolder: () => { throw new Error('Must not be called'); } },
      tempToken: 'evil-token',
    });
    assert.equal(revealBlocked.revealed, false);
    assert.equal(revealBlocked.exists, false);
    const cleanupBlocked = executeCleanupShareTempFileIpc({
      tempDir,
      shareTempFiles,
      tempToken: 'evil-token',
    });
    assert.equal(cleanupBlocked.cleaned, true);
    assert.equal(existsSync(outsideFile), true);

    // Backdated (> 7 days) vs fresh file + active-session expiry + subdirectory + symlink safety
    const stalePath = path.join(tempDir, 'stale-old.pdf');
    const freshPath = path.join(tempDir, 'fresh-new.pdf');
    const subDir = path.join(tempDir, 'nested-dir');
    const symlinkPath = path.join(tempDir, 'link-to-outside.txt');
    writeFileSync(stalePath, 'old-data');
    writeFileSync(freshPath, 'fresh-data');
    mkdirSync(subDir);
    symlinkSync(outsideFile, symlinkPath);

    const nowMs = Date.now();
    const eightDaysAgoSec = (nowMs - 8 * 24 * 60 * 60 * 1000) / 1000;
    const twoDaysAgoSec = (nowMs - 2 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(stalePath, eightDaysAgoSec, eightDaysAgoSec);
    utimesSync(freshPath, twoDaysAgoSec, twoDaysAgoSec);
    const activePath = shareTempFiles.get(prepared.tempToken).path;
    utimesSync(activePath, eightDaysAgoSec, eightDaysAgoSec);
    shareTempFiles.get(prepared.tempToken).createdAt = nowMs - 8 * 24 * 60 * 60 * 1000;

    const purged = purgeStaleShareTempFiles({
      tempDir,
      shareTempFiles,
      retentionMs: SHARE_TEMP_RETENTION_MS,
      nowMs,
    });
    assert.equal(purged.removedFiles, 2);
    assert.equal(existsSync(stalePath), false);
    assert.equal(existsSync(freshPath), true);
    assert.equal(existsSync(activePath), false);
    assert.equal(shareTempFiles.has(prepared.tempToken), false);
    assert.equal(existsSync(subDir), true);
    assert.equal(existsSync(outsideFile), true);

    // Explicit cleanup deletes temp file & map entry
    const cleanupRes = executeCleanupShareTempFileIpc({
      tempDir,
      shareTempFiles,
      tempToken: prepared.tempToken,
    });
    assert.equal(cleanupRes.cleaned, true);
    const revealAfterDelete = revealShareTempFileOnDisk({
      tempDir,
      shareTempFiles,
      shell: { showItemInFolder: () => {} },
      tempToken: prepared.tempToken,
    });
    assert.equal(revealAfterDelete.revealed, false);
    assert.equal(revealAfterDelete.exists, false);

    // WhatsApp URL allowlist
    await assert.rejects(
      () => openAllowedWhatsAppUrl({ shell: { openExternal: async () => {} }, url: 'javascript:alert(1)', logger }),
      /يُسمح فقط بروابط WhatsApp/
    );
    await assert.rejects(
      () => openAllowedWhatsAppUrl({ shell: { openExternal: async () => {} }, url: 'https://evil.example/wa', logger }),
      /يُسمح فقط بروابط WhatsApp/
    );
    await assert.rejects(
      () => openAllowedWhatsAppUrl({ shell: { openExternal: async () => {} }, url: 'https://wa.me.attacker.example/967771112233', logger }),
      /يُسمح فقط بروابط WhatsApp/
    );
    await assert.rejects(
      () => openAllowedWhatsAppUrl({ shell: { openExternal: async () => {} }, url: 'https://wa.me@evil.example/967771112233', logger }),
      /يُسمح فقط بروابط WhatsApp/
    );
    const waOk = await openAllowedWhatsAppUrl({
      shell: { openExternal: async () => {} },
      url: 'https://wa.me/967771112233?text=hi',
      logger,
    });
    assert.equal(waOk.opened, true);
    const waFail = await openAllowedWhatsAppUrl({
      shell: { openExternal: async () => { throw new Error('No handler'); } },
      url: 'whatsapp://send?phone=967771112233',
      logger,
    });
    assert.equal(waFail.opened, false);
    assert.ok(waFail.error.includes('No handler'));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
