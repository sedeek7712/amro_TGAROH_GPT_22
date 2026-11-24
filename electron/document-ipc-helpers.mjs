import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SHARE_TEMP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_SHARE_TEMP_FILE_BYTES = 32 * 1024 * 1024;

function isPathInsideDirectory(basePath, targetPath) {
  if (!basePath || !targetPath) return false;
  const relative = path.relative(path.resolve(basePath), path.resolve(targetPath));
  return Boolean(
    relative &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function classifyFsErrorStatus(error) {
  const code = error && typeof error === 'object' ? String(error.code || '') : '';
  if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EROFS', 'EBUSY', 'ENODEV'].includes(code)) {
    return 'PATH_UNREACHABLE';
  }
  return 'WRITE_FAILED';
}

export function normalizePaperSize(rawSize) {
  if (rawSize === '58mm' || rawSize === '80mm') {
    return rawSize;
  }
  return 'A4';
}

/**
 * Electron webContents.print pageSize custom dimensions are in microns (1mm = 1000 microns).
 */
export function resolveNativePrintOptions(input = {}) {
  const pageSizeMode = normalizePaperSize(input?.pageSize);
  if (pageSizeMode === 'A4') {
    return {
      silent: false,
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'default' },
    };
  }

  const widthMicrons = pageSizeMode === '58mm' ? 58000 : 80000;
  const rawHeightMm = Number(input?.contentHeightMm);
  const clampedHeightMm =
    Number.isFinite(rawHeightMm) && rawHeightMm > 0
      ? Math.max(100, Math.min(2000, Math.ceil(rawHeightMm + 15)))
      : 297;

  return {
    silent: false,
    printBackground: true,
    pageSize: {
      width: widthMicrons,
      height: clampedHeightMm * 1000,
    },
    margins: { marginType: 'none' },
  };
}

export function resolvePrintCallbackOutcome(success, failureReason) {
  const reason = failureReason ? String(failureReason).trim() : '';
  const lower = reason.toLowerCase();
  const canceled = lower === 'cancelled' || lower === 'canceled';

  if (canceled) {
    return {
      printed: false,
      canceled: true,
      outcome: 'canceled',
      failureReason: reason || 'cancelled',
    };
  }

  if (success === true) {
    return {
      printed: true,
      canceled: false,
      outcome: 'sent',
      failureReason: undefined,
    };
  }

  if (success === false && reason) {
    return {
      printed: false,
      canceled: false,
      outcome: 'failed',
      failureReason: reason,
    };
  }

  return {
    printed: false,
    canceled: false,
    outcome: 'unconfirmed',
    failureReason: 'لم يُرجع نظام الطباعة تأكيداً صريحاً لإرسال أو إلغاء المهمة.',
  };
}

export function hasValidPdfStructure(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 64) {
    return false;
  }
  if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    return false;
  }
  const tail = buffer.subarray(Math.max(0, buffer.length - 4096)).toString('latin1');
  return tail.includes('%%EOF') && tail.includes('trailer') && tail.includes('startxref');
}

export function hasValidPngHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length <= 32) {
    return false;
  }
  return (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  );
}

export function verifyAndWritePdfBuffer(filePath, pdfBuffer) {
  try {
    const parentDir = path.dirname(filePath);
    if (!existsSync(parentDir)) {
      return {
        canceled: false,
        status: 'PATH_UNREACHABLE',
        error: 'المجلد المحدد لحفظ الملف غير متاح.',
      };
    }
    writeFileSync(filePath, pdfBuffer);
    if (!existsSync(filePath)) {
      return {
        canceled: false,
        status: 'WRITE_FAILED',
        error: 'لم يتم العثور على الملف بعد محاولة الكتابة.',
      };
    }
    const stat = statSync(filePath);
    if (!stat || !stat.isFile() || stat.size <= 0) {
      return {
        canceled: false,
        status: 'WRITE_FAILED',
        error: 'حجم ملف PDF المكتوب غير صالح.',
      };
    }
    return {
      canceled: false,
      status: 'SAVED',
      path: filePath,
      filename: path.basename(filePath),
      sizeBytes: stat.size,
      source: 'SNAPSHOT_PDF',
    };
  } catch (err) {
    const writeStatus = classifyFsErrorStatus(err);
    const msg = err instanceof Error ? err.message : 'تعذر كتابة ملف PDF على القرص.';
    return {
      canceled: false,
      status: writeStatus,
      error: msg,
    };
  }
}

export function verifyAndWritePngBuffer(filePath, pngBuffer) {
  try {
    const parentDir = path.dirname(filePath);
    if (!existsSync(parentDir)) {
      return {
        canceled: false,
        status: 'PATH_UNREACHABLE',
        error: 'المسار المحدد لحفظ الصورة غير متاح.',
      };
    }
    writeFileSync(filePath, pngBuffer);
    const stat = existsSync(filePath) ? statSync(filePath) : null;
    if (!stat || !stat.isFile() || stat.size <= 0) {
      return {
        canceled: false,
        status: 'WRITE_FAILED',
        error: 'تعذر التحقق من حفظ ملف PNG على القرص.',
      };
    }
    return {
      canceled: false,
      status: 'SAVED',
      path: filePath,
      filename: path.basename(filePath),
      sizeBytes: stat.size,
    };
  } catch (err) {
    const writeStatus = classifyFsErrorStatus(err);
    return {
      canceled: false,
      status: writeStatus,
      error: err instanceof Error ? err.message : 'تعذر حفظ صورة PNG.',
    };
  }
}

export async function executeExportPdfIpc({ mainWindow, dialog, input, actor, logger }) {
  const rawTitle = String(input?.title || 'document').trim() || 'document';
  const safeTitle =
    rawTitle.replace(/[\\/:*?"<>|]+/g, '-').replace(/\.pdf$/i, '').slice(0, 96) || 'document';
  const pageSizeMode = normalizePaperSize(input?.pageSize);

  const pdfBase64 = typeof input?.pdfBase64 === 'string' ? input.pdfBase64.trim() : '';
  if (!pdfBase64) {
    return {
      canceled: false,
      status: 'CREATE_FAILED',
      error: 'بيانات ملف PDF المطلوبة من Snapshot غير متوفرة؛ تم منع التصدير الصامت.',
    };
  }

  let pdfBuffer;
  try {
    pdfBuffer = Buffer.from(pdfBase64, 'base64');
    if (!hasValidPdfStructure(pdfBuffer)) {
      return {
        canceled: false,
        status: 'CREATE_FAILED',
        error: 'تعذر التحقق من سلامة بنية PDF (%PDF- / trailer / %%EOF).',
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'فشل قراءة بيانات PDF.';
    logger?.log?.('ERROR', 'print', 'PDF decode failed', { message: msg });
    return { canceled: false, status: 'CREATE_FAILED', error: msg };
  }

  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'حفظ المستند بصيغة PDF',
    defaultPath: `${safeTitle}.pdf`,
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) {
    return { canceled: true, status: 'CANCELED' };
  }

  const writeResult = verifyAndWritePdfBuffer(res.filePath, pdfBuffer);
  if (writeResult.status === 'SAVED') {
    logger?.log?.('INFO', 'print', 'Document exported and verified as PDF', {
      filename: writeResult.filename,
      pageSize: pageSizeMode,
      sizeBytes: writeResult.sizeBytes,
      source: 'SNAPSHOT_PDF',
      exportedBy: actor?.username,
    });
  } else {
    logger?.log?.('ERROR', 'print', 'PDF write failed', {
      writeStatus: writeResult.status,
      message: writeResult.error,
    });
  }
  return writeResult;
}

export async function executeExportPngIpc({ mainWindow, dialog, input, actor, logger }) {
  const rawTitle = String(input?.title || 'document').trim() || 'document';
  const safeTitle =
    rawTitle.replace(/[\\/:*?"<>|]+/g, '-').replace(/\.png$/i, '').slice(0, 96) || 'document';
  const bytesBase64 = typeof input?.bytesBase64 === 'string' ? input.bytesBase64 : '';
  if (!bytesBase64) {
    return {
      canceled: false,
      status: 'CREATE_FAILED',
      error: 'بيانات صورة PNG فارغة.',
    };
  }

  let pngBuffer;
  try {
    pngBuffer = Buffer.from(bytesBase64, 'base64');
    if (!hasValidPngHeader(pngBuffer)) {
      return {
        canceled: false,
        status: 'CREATE_FAILED',
        error: 'البيانات المرسلة ليست صورة PNG صالحة.',
      };
    }
  } catch (err) {
    return {
      canceled: false,
      status: 'CREATE_FAILED',
      error: err instanceof Error ? err.message : 'تعذر فك ترميز صورة PNG.',
    };
  }

  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'حفظ المستند كصورة PNG',
    defaultPath: `${safeTitle}.png`,
    filters: [{ name: 'PNG Images', extensions: ['png'] }],
  });
  if (res.canceled || !res.filePath) {
    return { canceled: true, status: 'CANCELED' };
  }

  const writeResult = verifyAndWritePngBuffer(res.filePath, pngBuffer);
  if (writeResult.status === 'SAVED') {
    logger?.log?.('INFO', 'print', 'Document exported and verified as PNG', {
      filename: writeResult.filename,
      sizeBytes: writeResult.sizeBytes,
      exportedBy: actor?.username,
    });
  } else {
    logger?.log?.('ERROR', 'print', 'PNG write failed', {
      writeStatus: writeResult.status,
      message: writeResult.error,
    });
  }
  return writeResult;
}

export async function executeRunNativePrintIpc({ mainWindow, input, actor, logger }) {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) {
    return {
      printed: false,
      canceled: false,
      outcome: 'window-unavailable',
      failureReason: 'النافذة غير متاحة للطباعة.',
    };
  }

  const pageSizeMode = normalizePaperSize(input?.pageSize);
  const printOptions = resolveNativePrintOptions(input);

  return await new Promise((resolve) => {
    try {
      mainWindow.webContents.print(printOptions, (success, failureReason) => {
        const result = resolvePrintCallbackOutcome(success, failureReason);
        logger?.log?.('INFO', 'print', 'Native print command finished', {
          outcome: result.outcome,
          printed: result.printed,
          canceled: result.canceled,
          pageSize: pageSizeMode,
          failureReason: result.failureReason || null,
          actor: actor?.username,
        });
        resolve(result);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'فشل استدعاء نظام الطباعة.';
      logger?.log?.('ERROR', 'print', 'Native print threw error', { message: msg });
      resolve({
        printed: false,
        canceled: false,
        outcome: 'failed',
        failureReason: msg,
      });
    }
  });
}

export function purgeStaleShareTempFiles({
  tempDir,
  shareTempFiles,
  retentionMs = SHARE_TEMP_RETENTION_MS,
  nowMs = Date.now(),
}) {
  let removedFiles = 0;
  let keptFiles = 0;
  try {
    if (!tempDir || !existsSync(tempDir)) {
      return { removedFiles, keptFiles };
    }
    const resolvedBase = path.resolve(tempDir);
    const cutoff = nowMs - retentionMs;
    const activePaths = new Map();
    if (shareTempFiles instanceof Map) {
      for (const info of shareTempFiles.values()) {
        if (info?.active === true && info.path) {
          activePaths.set(path.resolve(info.path), Number(info.createdAt) || 0);
        }
      }
    }

    for (const entry of readdirSync(resolvedBase, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.isDirectory() || !entry.isFile()) {
        continue;
      }
      const fullPath = path.resolve(resolvedBase, entry.name);
      if (!fullPath.startsWith(resolvedBase + path.sep)) {
        continue;
      }
      try {
        const st = statSync(fullPath);
        if (!st.isFile()) continue;
        // Files prepared in this running session remain pinned until explicit
        // cleanup or process restart; orphaned files still obey 7-day retention.
        const activeCreatedAt = activePaths.get(fullPath);
        if (activeCreatedAt && activeCreatedAt >= cutoff) {
          keptFiles += 1;
          continue;
        }
        if (st.mtimeMs < cutoff || (activePaths.has(fullPath) && activeCreatedAt < cutoff)) {
          rmSync(fullPath, { force: true });
          removedFiles += 1;
        } else {
          keptFiles += 1;
        }
      } catch {
        // ignore per-file cleanup issues
      }
    }

    if (shareTempFiles instanceof Map) {
      for (const [token, info] of shareTempFiles.entries()) {
        const resolvedInfoPath = info?.path ? path.resolve(info.path) : '';
        const insideDir = isPathInsideDirectory(resolvedBase, resolvedInfoPath);
        if (
          !insideDir ||
          !existsSync(resolvedInfoPath) ||
          (Number(info?.createdAt) > 0 && Number(info.createdAt) < cutoff)
        ) {
          shareTempFiles.delete(token);
        }
      }
    }
  } catch {
    // non-fatal
  }
  return { removedFiles, keptFiles };
}

export function prepareShareTempFileOnDisk({ tempDir, shareTempFiles, input }) {
  const rawName = path.basename(String(input?.fileName || 'document.pdf').trim());
  const safeName = rawName.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 96) || 'document.pdf';
  const bytesBase64 = typeof input?.bytesBase64 === 'string' ? input.bytesBase64 : '';
  if (!bytesBase64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bytesBase64)) {
    throw new Error('بيانات الملف المؤقت ليست Base64 صالحة.');
  }
  if (bytesBase64.length > Math.ceil(MAX_SHARE_TEMP_FILE_BYTES / 3) * 4) {
    throw new Error('حجم ملف المشاركة يتجاوز الحد المسموح به.');
  }
  const buffer = Buffer.from(bytesBase64, 'base64');
  if (buffer.length <= 0 || buffer.toString('base64') !== bytesBase64) {
    throw new Error('الملف المؤقت فارغ أو بياناته غير صالحة.');
  }
  if (buffer.length > MAX_SHARE_TEMP_FILE_BYTES) {
    throw new Error('حجم ملف المشاركة يتجاوز الحد المسموح به.');
  }

  const extension = path.extname(safeName).toLowerCase();
  const mimeType = String(input?.mimeType || (extension === '.png' ? 'image/png' : 'application/pdf')).toLowerCase();
  if (mimeType === 'application/pdf') {
    if (extension !== '.pdf' || !hasValidPdfStructure(buffer)) {
      throw new Error('محتوى ملف المشاركة لا يطابق مستند PDF صالحاً.');
    }
  } else if (mimeType === 'image/png') {
    if (extension !== '.png' || !hasValidPngHeader(buffer)) {
      throw new Error('محتوى ملف المشاركة لا يطابق صورة PNG صالحة.');
    }
  } else {
    throw new Error('نوع ملف المشاركة غير مسموح؛ يُقبل PDF أو PNG فقط.');
  }

  mkdirSync(tempDir, { recursive: true });
  const uniqueToken = randomUUID();
  const tempFilePath = path.join(tempDir, uniqueToken.slice(0, 8) + '-' + safeName);
  writeFileSync(tempFilePath, buffer, { flag: 'wx', mode: 0o600 });
  const stat = statSync(tempFilePath);
  if (!stat || !stat.isFile() || stat.size <= 0 || stat.size !== buffer.length) {
    rmSync(tempFilePath, { force: true });
    throw new Error('تعذر التحقق من كتابة الملف المؤقت.');
  }

  shareTempFiles?.set?.(uniqueToken, {
    path: tempFilePath,
    fileName: safeName,
    createdAt: Date.now(),
    active: true,
  });

  return {
    tempToken: uniqueToken,
    fileName: safeName,
    sizeBytes: stat.size,
  };
}
export function revealShareTempFileOnDisk({ tempDir, shareTempFiles, shell, tempToken }) {
  const tokenKey = String(tempToken || '');
  const entry = shareTempFiles?.get?.(tokenKey);
  if (!entry?.path || !tempDir) {
    return {
      revealed: false,
      exists: false,
      error: 'الملف المؤقت غير موجود أو انتهت صلاحيته.',
    };
  }

  const resolvedBase = path.resolve(tempDir);
  const resolvedPath = path.resolve(entry.path);
  if (!isPathInsideDirectory(resolvedBase, resolvedPath) || !existsSync(resolvedPath)) {
    return {
      revealed: false,
      exists: false,
      error: 'الملف المؤقت غير موجود أو انتهت صلاحيته.',
    };
  }

  let st;
  try {
    st = statSync(resolvedPath);
  } catch {
    return {
      revealed: false,
      exists: false,
      error: 'تعذر قراءة بيانات الملف المؤقت على القرص.',
    };
  }

  if (!st.isFile() || st.size <= 0) {
    return {
      revealed: false,
      exists: false,
      error: 'الملف المؤقت تالف أو فارغ.',
    };
  }

  try {
    shell.showItemInFolder(resolvedPath);
    return { revealed: true, exists: true };
  } catch (err) {
    return {
      revealed: false,
      exists: true,
      error: err instanceof Error ? err.message : 'تعذر فتح مستعرض الملفات لعرض المرفق المؤقت.',
    };
  }
}

/**
 * Copy a prepared PNG invoice to the operating-system clipboard without opening a browser
 * or exposing an arbitrary file path to the renderer. The text is written as a secondary
 * clipboard format; WhatsApp Desktop can paste the image, while the protocol URL pre-fills
 * the message text in the selected chat.
 */
export function copyShareTempPngToClipboardOnDisk({
  tempDir,
  shareTempFiles,
  clipboard,
  nativeImage,
  ClipboardItemCtor,
  BlobCtor,
  tempToken,
  messageText,
}) {
  const entry = shareTempFiles?.get?.(String(tempToken || ''));
  if (!entry?.path || !tempDir) {
    return { copied: false, error: 'ملف صورة الفاتورة المؤقت غير موجود أو انتهت صلاحيته.' };
  }

  const resolvedBase = path.resolve(tempDir);
  const resolvedPath = path.resolve(entry.path);
  if (!isPathInsideDirectory(resolvedBase, resolvedPath) || !existsSync(resolvedPath)) {
    return { copied: false, error: 'مسار صورة الفاتورة المؤقت غير صالح.' };
  }

  try {
    const stat = statSync(resolvedPath);
    if (!stat.isFile() || stat.size <= 32 || stat.size > MAX_SHARE_TEMP_FILE_BYTES) {
      return { copied: false, error: 'حجم صورة الفاتورة غير صالح.' };
    }
    if (path.extname(resolvedPath).toLowerCase() !== '.png') {
      return { copied: false, error: 'اللصق المباشر يدعم صورة PNG فقط؛ استخدم الملف المؤقت لإرفاق PDF.' };
    }

    const bytes = readFileSync(resolvedPath);
    if (!hasValidPngHeader(bytes)) {
      return { copied: false, error: 'محتوى المرفق ليس صورة PNG صالحة.' };
    }

    const image = nativeImage?.createFromPath?.(resolvedPath);
    if (!image || image.isEmpty?.()) {
      return { copied: false, error: 'تعذر تحميل صورة الفاتورة إلى حافظة Windows.' };
    }

    if (typeof ClipboardItemCtor !== 'function' || typeof BlobCtor !== 'function') {
      return { copied: false, error: 'واجهة الحافظة الحديثة غير متاحة في إصدار سطح المكتب.' };
    }

    const pngBytes = image.toPNG();
    if (!pngBytes || pngBytes.length <= 32) {
      return { copied: false, error: 'تعذر قراءة بيانات صورة الفاتورة.' };
    }
    const clipboardItem = new ClipboardItemCtor({
      'text/plain': String(messageText || ''),
      'image/png': new BlobCtor([new Uint8Array(pngBytes)], { type: 'image/png' }),
    });
    clipboard.write([clipboardItem]);
    return { copied: true, imageCopied: true, sizeBytes: stat.size };
  } catch (error) {
    return {
      copied: false,
      error: error instanceof Error ? error.message : 'تعذر نسخ صورة الفاتورة إلى الحافظة.',
    };
  }
}

export function executeCleanupShareTempFileIpc({ tempDir, shareTempFiles, tempToken }) {
  const tokenKey = String(tempToken || '');
  const entry = shareTempFiles?.get?.(tokenKey);
  if (entry) {
    try {
      const resolvedBase = tempDir ? path.resolve(tempDir) : '';
      const resolvedPath = entry.path ? path.resolve(entry.path) : '';
      const isContained = isPathInsideDirectory(resolvedBase, resolvedPath);
      if (isContained && resolvedPath && existsSync(resolvedPath)) {
        rmSync(resolvedPath, { force: true });
      }
    } finally {
      shareTempFiles.delete(tokenKey);
    }
  }
  return { cleaned: true };
}

export function isAllowedWhatsAppUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 12000) return false;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.port || parsed.hash) return false;
  const keys = [...parsed.searchParams.keys()];
  if (keys.some((key) => !['phone', 'text'].includes(key))) return false;
  if (parsed.searchParams.getAll('phone').length > 1 || parsed.searchParams.getAll('text').length > 1) return false;

  const isValidPhone = (value) => /^[1-9]\d{7,14}$/.test(String(value || ''));
  if (parsed.protocol === 'https:' && parsed.hostname === 'wa.me') {
    const phone = parsed.pathname.match(/^\/([1-9]\d{7,14})$/)?.[1];
    return Boolean(phone && keys.every((key) => key === 'text'));
  }
  if (parsed.protocol === 'https:' && parsed.hostname === 'api.whatsapp.com') {
    return parsed.pathname === '/send' && isValidPhone(parsed.searchParams.get('phone'));
  }
  if (parsed.protocol === 'whatsapp:' && parsed.hostname === 'send' && ['', '/'].includes(parsed.pathname)) {
    return isValidPhone(parsed.searchParams.get('phone'));
  }
  return false;
}

export async function openAllowedWhatsAppUrl({ shell, url, logger }) {
  const rawUrl = String(url || '').trim();
  if (!isAllowedWhatsAppUrl(rawUrl)) {
    throw new Error('تم حظر الرابط: يُسمح فقط بروابط WhatsApp الموثقة.');
  }
  try {
    await shell.openExternal(rawUrl);
    return { opened: true };
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : 'تعذر فتح تطبيق واتساب على هذا الجهاز.';
    logger?.log?.('WARN', 'share', 'WhatsApp launch failed', {
      protocol: rawUrl.startsWith('whatsapp://') ? 'whatsapp://' : 'https://',
      message: msg,
    });
    return { opened: false, error: msg };
  }
}
