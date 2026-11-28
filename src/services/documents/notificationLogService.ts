/**
 * خدمة تسجيل ومتابعة عمليات المستندات (الحفظ، الطباعة، الإنشاء، والمشاركة)
 * NotificationLogService + DocumentAuditBridge
 * - على Windows/Electron: تستخدم SQLite (جدول audit_logs) كمصدر الحقيقة الوحيد دون الكتابة المزدوجة إلى localStorage.
 * - على الويب: تحافظ على مسار localStorage الحالي مع التزامن الاختياري لسجل الرقابة.
 * - تلتزم الصمت عن أي محتوى حساس ولا تكشف مسارات النظام لغير المصرح لهم.
 * - تمنع تسجيل 'DELIVERED' عند مجرد فتح واتساب أو قائمة المشاركة.
 */

import type { SystemAuditLog } from '../../types/erp';
import { formatLocalDateTime } from '../../utils/localDate';
import { dataService } from '../dataService';
import { sqliteDataService } from '../sqliteDataService';

export type DocumentOperationType = 'PDF_EXPORT' | 'PNG_EXPORT' | 'PRINT' | 'SHARE';

export type DocumentOperationStatus =
  | 'PREPARED'
  | 'SAVED'
  | 'DOWNLOAD_INITIATED'
  | 'CANCELED'
  | 'FAILED'
  | 'PRINT_OPENED'
  | 'PRINT_DIALOG_CLOSED'
  | 'PRINT_DIALOG_CLOSE_UNCONFIRMED'
  | 'PRINT_STATUS_UNKNOWN'
  | 'PRINT_SENT'
  | 'SHARE_OPENED'
  | 'FALLBACK_DOWNLOAD_AND_WA'
  | 'WHATSAPP_LAUNCHED'
  | 'USER_COPIED_TEXT'
  | 'USER_CONFIRMED_SEND';

export interface DocumentOperationLogEntry {
  id: string;
  operationType: DocumentOperationType;
  status: DocumentOperationStatus;
  documentId: string;
  documentNumber: string;
  documentType: string;
  userId: string;
  userName: string;
  branchId: string;
  branchName?: string;
  activityId?: string;
  activityName?: string;
  timestamp: string;
  localDateTime: string;
  fileName?: string;
  failureReason?: string;
  recipientName?: string;
  recipientPhoneMasked?: string;
  dispatchId?: string;
  channel?:
    | 'WHATSAPP'
    | 'WEB_SHARE'
    | 'ELECTRON_DIALOG'
    | 'BROWSER_DOWNLOAD'
    | 'NATIVE_PRINT'
    | 'CLIPBOARD';
}

export interface DocumentOperationAuditProvider {
  logAction(action: string, details: string): Promise<void>;
  getAuditLogs(): Promise<SystemAuditLog[]>;
}

export const DOCUMENT_OPERATION_AUDIT_ACTION = 'DOCUMENT_OPERATION_EVENT';
export const WHATSAPP_DISPATCH_AUDIT_ACTION = 'WHATSAPP_DISPATCH_EVENT';

const LOG_STORAGE_KEY = 'amro_doc_ops_logs_v1';
const MAX_STORED_LOGS = 300;
const inMemoryLogs: DocumentOperationLogEntry[] = [];
let customElectronAuditProvider: DocumentOperationAuditProvider | null = null;

export function setDocumentOperationAuditProviderForTest(
  provider: DocumentOperationAuditProvider | null
): void {
  customElectronAuditProvider = provider;
}

function resolveDocumentLogTarget(): {
  mode: 'SQLITE' | 'WEB';
  provider: DocumentOperationAuditProvider;
} {
  if (customElectronAuditProvider) {
    return { mode: 'SQLITE', provider: customElectronAuditProvider };
  }
  if (typeof window !== 'undefined') {
    const desktopBridge = (window as Window).amroDesktop;
    if (
      desktopBridge &&
      (typeof desktopBridge.logAction === 'function' ||
        typeof desktopBridge.getAuditLogs === 'function')
    ) {
      return { mode: 'SQLITE', provider: sqliteDataService };
    }
  }
  return { mode: 'WEB', provider: dataService };
}

function createEventId(): string {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `docop_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * استخراج اسم ملف آمن دون تسريب مسار النظام الكامل (C:\Users\...) في السجلات
 */
export function sanitizeLoggedFileName(rawName?: string): string | undefined {
  if (!rawName) return undefined;
  const trimmed = String(rawName).trim();
  if (!trimmed) return undefined;
  const base = trimmed.split(/[\\/]/).pop() || trimmed;
  return base.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 140);
}

function readPersistedLogs(): DocumentOperationLogEntry[] {
  if (typeof localStorage === 'undefined') {
    return [...inMemoryLogs];
  }
  try {
    const raw = localStorage.getItem(LOG_STORAGE_KEY);
    if (!raw) return [...inMemoryLogs];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as DocumentOperationLogEntry[];
    }
  } catch {
    // fallback to memory buffer
  }
  return [...inMemoryLogs];
}

function writePersistedLogs(entries: DocumentOperationLogEntry[]): void {
  const capped = entries.slice(0, MAX_STORED_LOGS);
  inMemoryLogs.length = 0;
  inMemoryLogs.push(...capped);

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(capped));
    } catch {
      // ignore storage quota errors
    }
  }
}

const ACTION_LABELS: Record<DocumentOperationType, string> = {
  PDF_EXPORT: 'تصدير مستند PDF',
  PNG_EXPORT: 'تصدير صورة مستند PNG',
  PRINT: 'طباعة مستند',
  SHARE: 'مشاركة / إشعار مستند',
};

const STATUS_LABELS: Record<DocumentOperationStatus, string> = {
  PREPARED: 'تم التجهيز',
  SAVED: 'تم الحفظ والتحقق على القرص',
  DOWNLOAD_INITIATED: 'بدأ تنزيل الملف من المتصفح',
  CANCELED: 'ألغاه المستخدم',
  FAILED: 'فشلت العملية',
  PRINT_OPENED: 'فتح معاينة الطباعة',
  PRINT_DIALOG_CLOSED: 'أُغلق حوار الطباعة في المتصفح',
  PRINT_DIALOG_CLOSE_UNCONFIRMED: 'انتهت مهلة انتظار إغلاق حوار الطباعة بالمتصفح',
  PRINT_STATUS_UNKNOWN: 'حالة الطباعة غير مؤكدة من النظام',
  PRINT_SENT: 'أُرسلت مهمة الطباعة',
  SHARE_OPENED: 'فُتحت نافذة المشاركة',
  FALLBACK_DOWNLOAD_AND_WA: 'تم تجهيز المرفق والنص للتنزيل دون فتح واتساب',
  WHATSAPP_LAUNCHED: 'تم فتح واتساب',
  USER_COPIED_TEXT: 'نسخ المستخدم النص',
  USER_CONFIRMED_SEND: 'أكّد الموظف أنه ضغط زر الإرسال',
};

function parseDocumentOperationAuditRow(row: SystemAuditLog): DocumentOperationLogEntry | null {
  if (
    row.action !== WHATSAPP_DISPATCH_AUDIT_ACTION &&
    row.action !== DOCUMENT_OPERATION_AUDIT_ACTION
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(row.details) as {
      schemaVersion?: number;
      event?: DocumentOperationLogEntry;
    };
    const event = payload.event;
    if (payload.schemaVersion !== 1 || !event || !event.operationType || !event.status) {
      return null;
    }
    if (row.action === WHATSAPP_DISPATCH_AUDIT_ACTION) {
      if (event.operationType !== 'SHARE' || !event.dispatchId) {
        return null;
      }
    }
    return event;
  } catch {
    return null;
  }
}

function matchesLogFilter(
  item: DocumentOperationLogEntry,
  filter?: {
    documentNumber?: string;
    operationType?: DocumentOperationType;
    dispatchId?: string;
  }
): boolean {
  if (filter?.documentNumber && item.documentNumber !== filter.documentNumber) return false;
  if (filter?.operationType && item.operationType !== filter.operationType) return false;
  if (filter?.dispatchId && item.dispatchId !== filter.dispatchId) return false;
  return true;
}

export async function recordDocumentOperation(params: {
  operationType: DocumentOperationType;
  status: DocumentOperationStatus;
  documentId: string;
  documentNumber: string;
  documentType: string;
  userId?: string;
  userName?: string;
  branchId?: string;
  branchName?: string;
  activityId?: string;
  activityName?: string;
  fileName?: string;
  failureReason?: string;
  recipientName?: string;
  recipientPhoneMasked?: string;
  dispatchId?: string;
  channel?: DocumentOperationLogEntry['channel'];
  syncAudit?: boolean;
}): Promise<DocumentOperationLogEntry> {
  // حماية صارمة: لا يُسمح مطلقاً بتسجيل DELIVERED لأن التسليم لم يؤكده مصدر موثوق
  const rawStatus = params.status as string;
  if (rawStatus === 'DELIVERED') {
    throw new Error('غير مسموح بتسجيل حالة DELIVERED دون تأكيد موثوق من الخادم.');
  }

  const nowLocal = formatLocalDateTime();
  const safeFile = sanitizeLoggedFileName(params.fileName);

  const entry: DocumentOperationLogEntry = {
    id: createEventId(),
    operationType: params.operationType,
    status: params.status,
    documentId: String(params.documentId || params.documentNumber || 'UNKNOWN'),
    documentNumber: String(params.documentNumber || 'N/A'),
    documentType: String(params.documentType || 'DOCUMENT'),
    userId: String(params.userId || 'system'),
    userName: String(params.userName || 'مستخدم النظام'),
    branchId: String(params.branchId || 'branch_main'),
    branchName: params.branchName,
    activityId: params.activityId,
    activityName: params.activityName,
    timestamp: new Date().toISOString(),
    localDateTime: nowLocal.displayTabular,
    fileName: safeFile,
    failureReason: params.failureReason ? String(params.failureReason).slice(0, 240) : undefined,
    recipientName: params.recipientName ? String(params.recipientName).slice(0, 120) : undefined,
    recipientPhoneMasked: params.recipientPhoneMasked ? String(params.recipientPhoneMasked).slice(0, 32) : undefined,
    dispatchId: params.dispatchId ? String(params.dispatchId).slice(0, 80) : params.operationType === 'SHARE' ? createEventId() : undefined,
    channel: params.channel,
  };

  const parts = [
    `المستند: ${entry.documentNumber} (${entry.documentType})`,
    `الحالة: ${STATUS_LABELS[entry.status]}`,
  ];
  if (entry.fileName) parts.push(`الملف: ${entry.fileName}`);
  if (entry.recipientName) parts.push(`المستلم: ${entry.recipientName}`);
  if (entry.failureReason) parts.push(`السبب: ${entry.failureReason}`);

  const target = resolveDocumentLogTarget();

  if (target.mode === 'SQLITE') {
    if (params.syncAudit === false) {
      throw new Error('لا يمكن تعطيل حفظ سجل عمليات المستندات في SQLite على نظام Windows.');
    }
    const auditAction =
      entry.operationType === 'SHARE'
        ? WHATSAPP_DISPATCH_AUDIT_ACTION
        : DOCUMENT_OPERATION_AUDIT_ACTION;
    const auditDetails =
      entry.operationType === 'SHARE'
        ? JSON.stringify({ schemaVersion: 1, event: entry })
        : JSON.stringify({
            schemaVersion: 1,
            label: ACTION_LABELS[entry.operationType],
            summary: parts.join(' | '),
            event: entry,
          });
    await target.provider.logAction(auditAction, auditDetails);
    return entry;
  }

  const existing = readPersistedLogs();
  writePersistedLogs([entry, ...existing]);

  if (params.syncAudit !== false && typeof window !== 'undefined') {
    try {
      if (entry.operationType === 'SHARE') {
        await target.provider.logAction(
          WHATSAPP_DISPATCH_AUDIT_ACTION,
          JSON.stringify({ schemaVersion: 1, event: entry })
        );
      } else {
        await target.provider.logAction(ACTION_LABELS[entry.operationType], parts.join(' | '));
      }
    } catch {
      // على الويب قد يكون الاستدعاء قبل اكتمال الجلسة أو من اختبار وحدة؛ السجل محفوظ في localStorage
    }
  }

  return entry;
}

export async function getDocumentOperationLogs(filter?: {
  documentNumber?: string;
  operationType?: DocumentOperationType;
  dispatchId?: string;
}): Promise<DocumentOperationLogEntry[]> {
  const target = resolveDocumentLogTarget();
  if (target.mode === 'SQLITE') {
    const auditRows = await target.provider.getAuditLogs();
    const events = auditRows
      .map(parseDocumentOperationAuditRow)
      .filter((item): item is DocumentOperationLogEntry => item !== null)
      .filter((item) => matchesLogFilter(item, filter))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return events;
  }

  const all = readPersistedLogs();
  return all.filter((item) => matchesLogFilter(item, filter));
}

export async function getWhatsAppDispatchAuditTrail(filter?: {
  documentNumber?: string;
  dispatchId?: string;
}): Promise<DocumentOperationLogEntry[]> {
  const target = resolveDocumentLogTarget();
  const auditRows = await target.provider.getAuditLogs();
  const events = auditRows.flatMap((row) => {
    if (row.action !== WHATSAPP_DISPATCH_AUDIT_ACTION) return [];
    const parsed = parseDocumentOperationAuditRow(row);
    if (!parsed || parsed.operationType !== 'SHARE' || !parsed.dispatchId) return [];
    return [parsed];
  });
  return events
    .filter((event) => !filter?.documentNumber || event.documentNumber === filter.documentNumber)
    .filter((event) => !filter?.dispatchId || event.dispatchId === filter.dispatchId)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export function clearDocumentOperationLogs(): void {
  inMemoryLogs.length = 0;
  const target = resolveDocumentLogTarget();
  if (target.mode === 'SQLITE') {
    return;
  }
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(LOG_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}
