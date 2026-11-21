import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const SENSITIVE_KEY_PATTERN =
  /password|passcode|passwd|secret|token|authorization|apikey|api_key|anonkey|service_role|servicerole|privatekey|passwordhash/i;

const STRING_SECRET_PATTERNS = [
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]'],
  [/Token\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Token [REDACTED]'],
  [/pbkdf2_sha256\$\d+\$[0-9a-f]+\$[0-9a-f]+/gi, '[REDACTED_PASSWORD_HASH]'],
];

export function redactDiagnosticString(value) {
  let out = String(value ?? '');
  for (const [pattern, replacement] of STRING_SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function sanitizeDiagnosticMeta(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 5) return '[Truncated]';
  if (typeof value === 'string') return redactDiagnosticString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactDiagnosticString(value.message),
      code: value.code ? String(value.code) : undefined,
      stack: typeof value.stack === 'string'
        ? redactDiagnosticString(value.stack.split('\n').slice(0, 8).join('\n'))
        : undefined,
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => sanitizeDiagnosticMeta(item, depth + 1));
  }
  if (typeof value === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        clean[k] = '[REDACTED]';
      } else {
        clean[k] = sanitizeDiagnosticMeta(v, depth + 1);
      }
    }
    return clean;
  }
  return redactDiagnosticString(String(value));
}

export function createDiagnosticLogger(options = {}) {
  const logDirectory = String(options.logDirectory || '').trim();
  if (!logDirectory) {
    throw new TypeError('logDirectory is required for diagnostic logger');
  }
  const filename = String(options.filename || 'desktop-diagnostics.log');
  const maxBytes = Math.max(4 * 1024, Number(options.maxBytes || 1024 * 1024));
  const maxArchives = Math.max(1, Math.min(10, Number(options.maxArchives || 3)));
  const logFilePath = path.join(logDirectory, filename);

  mkdirSync(logDirectory, { recursive: true });

  function rotateIfNeeded() {
    if (!existsSync(logFilePath)) return;
    let size = 0;
    try {
      size = statSync(logFilePath).size;
    } catch {
      return;
    }
    if (size < maxBytes) return;

    for (let i = maxArchives; i >= 1; i -= 1) {
      const src = i === 1 ? logFilePath : `${logFilePath}.${i - 1}`;
      const dst = `${logFilePath}.${i}`;
      if (existsSync(dst) && i === maxArchives) {
        try {
          rmSync(dst, { force: true });
        } catch {}
      }
      if (existsSync(src)) {
        try {
          renameSync(src, dst);
        } catch {}
      }
    }
  }

  function log(level, category, message, meta) {
    const normalizedLevel = ['INFO', 'WARN', 'ERROR'].includes(String(level || '').toUpperCase())
      ? String(level).toUpperCase()
      : 'INFO';
    const entry = {
      timestamp: new Date().toISOString(),
      level: normalizedLevel,
      category: String(category || 'app'),
      message: redactDiagnosticString(message),
      ...(meta !== undefined ? { meta: sanitizeDiagnosticMeta(meta) } : {}),
    };
    try {
      mkdirSync(logDirectory, { recursive: true });
      rotateIfNeeded();
      appendFileSync(logFilePath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // Never crash the main process because diagnostic logging failed
    }
    return entry;
  }

  function readRecentEntries({ maxLines = 200 } = {}) {
    const limit = Math.max(1, Math.min(1000, Number(maxLines || 200)));
    if (!existsSync(logFilePath)) {
      return { logFilePath, totalLines: 0, entries: [] };
    }
    const raw = readFileSync(logFilePath, 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    const tail = lines.slice(-limit);
    const entries = tail.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return {
          timestamp: '',
          level: 'INFO',
          category: 'raw',
          message: redactDiagnosticString(line),
        };
      }
    });
    return {
      logFilePath,
      totalLines: lines.length,
      entries: entries.reverse(),
    };
  }

  function exportDiagnosticsReport(destinationPath, extraContext = {}) {
    if (!destinationPath || typeof destinationPath !== 'string') {
      throw new TypeError('destinationPath is required');
    }
    const recent = readRecentEntries({ maxLines: 500 });
    const report = {
      exportedAt: new Date().toISOString(),
      context: sanitizeDiagnosticMeta(extraContext),
      logFilePath,
      totalEntriesInActiveLog: recent.totalLines,
      recentEntries: recent.entries,
    };
    mkdirSync(path.dirname(destinationPath), { recursive: true });
    writeFileSync(destinationPath, JSON.stringify(report, null, 2), 'utf8');
    return {
      path: destinationPath,
      filename: path.basename(destinationPath),
      entryCount: recent.entries.length,
    };
  }

  return {
    getLogFilePath: () => logFilePath,
    log,
    readRecentEntries,
    exportDiagnosticsReport,
  };
}
