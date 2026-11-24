import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import path from 'node:path';

const MAX_ORIGINAL_BYTES = 10 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 1024 * 1024;
const SAFE_PART = /^[A-Za-z0-9_-]{1,128}$/;

function decodeDataUrl(value, expectedMime, maxBytes) {
  if (typeof value !== 'string') throw new Error('ملف الصورة غير صالح.');
  const match = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match || match[1] !== expectedMime) throw new Error('صيغة الصورة غير معتمدة أو لا تطابق نوع الملف.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > maxBytes) throw new Error('حجم الصورة يتجاوز الحد المسموح.');
  if (bytes.toString('base64') !== match[2].replace(/=+$/, '').padEnd(Math.ceil(match[2].length / 4) * 4, '=')) {
    throw new Error('ترميز صورة غير صالح.');
  }
  return bytes;
}

function assertImageSignature(bytes, mimeType) {
  const valid = mimeType === 'image/jpeg'
    ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : mimeType === 'image/png'
      ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : mimeType === 'image/webp'
        ? bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
        : false;
  if (!valid) throw new Error('محتوى الملف لا يطابق توقيع صورة JPG أو PNG أو WebP.');
}

function assertDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) {
    throw new Error('أبعاد الصورة غير صالحة أو تتجاوز 4096 بكسل.');
  }
}

export function createProductMediaStorage({ rootDirectory }) {
  if (!rootDirectory || typeof rootDirectory !== 'string') {
    throw new TypeError('rootDirectory is required for product media storage');
  }
  const root = path.resolve(rootDirectory);

  function resolveKey(storageKey) {
    const clean = String(storageKey || '').replace(/\\/g, '/');
    const parts = clean.split('/');
    if (parts.length !== 5 || parts.some((part) => !SAFE_PART.test(part)) ||
        !['original.webp', 'thumbnail.webp', 'original.jpg', 'thumbnail.jpg', 'original.png', 'thumbnail.png'].includes(parts[4])) {
      throw new Error('مفتاح تخزين الصورة غير صالح.');
    }
    const target = path.resolve(root, ...parts);
    if (!target.startsWith(root + path.sep)) throw new Error('مسار الصورة خارج مجلد التخزين المسموح.');
    return target;
  }

  function makeKeys({ tenantId, activityId, productId, imageId, mimeType }) {
    const parts = [tenantId, activityId, productId, imageId];
    if (parts.some((part) => !SAFE_PART.test(String(part || '')))) {
      throw new Error('معرّفات المؤسسة أو النشاط أو الصنف أو الصورة غير صالحة.');
    }
    const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/png' ? 'png' : 'webp';
    return {
      original: [...parts, `original.${ext}`].join('/'),
      thumbnail: [...parts, `thumbnail.${ext}`].join('/'),
    };
  }

  function writeAtomic(target, bytes) {
    mkdirSync(path.dirname(target), { recursive: true });
    const temp = target + '.tmp-' + randomUUID();
    try {
      writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
      renameSync(temp, target);
    } catch (error) {
      try { rmSync(temp, { force: true }); } catch {}
      throw error;
    }
  }

  function store({ tenantId, activityId, productId, imageId, mimeType, width, height, originalDataUrl, thumbnailDataUrl }) {
    assertDimensions(width, height);
    const original = decodeDataUrl(originalDataUrl, mimeType, MAX_ORIGINAL_BYTES);
    const thumbnail = decodeDataUrl(thumbnailDataUrl, mimeType, MAX_THUMBNAIL_BYTES);
    assertImageSignature(original, mimeType);
    assertImageSignature(thumbnail, mimeType);
    const keys = makeKeys({ tenantId, activityId, productId, imageId, mimeType });
    writeAtomic(resolveKey(keys.original), original);
    try {
      writeAtomic(resolveKey(keys.thumbnail), thumbnail);
    } catch (error) {
      try { rmSync(resolveKey(keys.original), { force: true }); } catch {}
      throw error;
    }
    return {
      storageKey: keys.original,
      thumbnailStorageKey: keys.thumbnail,
      sizeBytes: original.length,
      thumbnailSizeBytes: thumbnail.length,
      checksumSha256: createHash('sha256').update(original).digest('hex'),
    };
  }

  function read(storageKey) {
    const target = resolveKey(storageKey);
    if (!existsSync(target)) return null;
    const extension = path.extname(target).toLowerCase();
    const mimeType = extension === '.jpg' ? 'image/jpeg' : extension === '.png' ? 'image/png' : 'image/webp';
    const bytes = readFileSync(target);
    assertImageSignature(bytes, mimeType);
    return `data:${mimeType};base64,${bytes.toString('base64')}`;
  }

  function remove(storageKeys) {
    for (const key of storageKeys || []) {
      if (!key) continue;
      const target = resolveKey(key);
      try { rmSync(target, { force: true }); } catch {}
      const parent = path.dirname(target);
      try {
        const entries = existsSync(parent) ? require('node:fs').readdirSync(parent) : [];
        if (entries.length === 0) rmSync(parent, { recursive: true, force: true });
      } catch {}
    }
  }

  function backupTo(destinationDirectory) {
    const destination = path.resolve(destinationDirectory);
    if (!destination.startsWith(path.dirname(root) + path.sep)) {
      // Backups may be on a separate disk; the caller controls the destination path.
      // The operation copies only the fixed source root and never accepts a source path from the renderer.
    }
    if (existsSync(root)) {
      rmSync(destination, { recursive: true, force: true });
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(root, destination, { recursive: true, errorOnExist: false, force: true });
    } else {
      rmSync(destination, { recursive: true, force: true });
      mkdirSync(destination, { recursive: true });
    }
    return destination;
  }

  function restoreFrom(sourceDirectory) {
    const source = path.resolve(sourceDirectory);
    if (!existsSync(source)) return false;
    const staging = root + '.restore-' + randomUUID();
    try {
      cpSync(source, staging, { recursive: true, errorOnExist: false, force: true });
      rmSync(root, { recursive: true, force: true });
      mkdirSync(path.dirname(root), { recursive: true });
      renameSync(staging, root);
      return true;
    } catch (error) {
      try { rmSync(staging, { recursive: true, force: true }); } catch {}
      throw error;
    }
  }

  return Object.freeze({ store, read, remove, backupTo, restoreFrom, rootDirectory: root });
}
