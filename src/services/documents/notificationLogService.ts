/**
 * خدمة تسجيل ومتابعة عمليات المستندات (الحفظ، الطباعة، الإنشاء، والمشاركة)
 * NotificationLogService + DocumentAuditBridge
 * - تلتزم الصمت عن أي محتوى حساس ولا تكشف مسارات النظام لغير المصرح لهم.
 * - تمنع تسجيل 'DELIVERED' عند مجرد فتح واتساب أو قائمة المشاركة.
 */

import { formatLocalDateTime } from '../../utils/localDate';
import { dataService } from '../dataService';

export type DocumentOperationType = 'PDF_EXPORT' | 'PNG_EXPORT' | 'PRINT' | 'SHARE';

export type DocumentOperationStatus =
  | 'PREPARED'
  | 'SAVED'
  | 'CANCELED'
  | 'FAILED'
  | 'PRINT_OPENED'
  | 'PRINT_SENT'
  | 'SHARE_OPENED'
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
  channel?:
    | 'WHATSAPP'
    | 'WEB_SHARE'
    | 'ELECTRON_DIALOG'
    | 'BROWSER_DOWNLOAD'
    | 'NATIVE_PRINT'
    | 'CLIPBOARD';
}

const LOG_STORAGE_KEY = 'amro_doc_ops_logs_v1';
const MAX_STORED_LOGS = 300;
const inMemoryLogs: DocumentOperationLogEntry[] = [];

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
  SAVED: 'تم الحفظ بنجاح',
  CANCELED: 'ألغاه المستخدم',
  FAILED: 'فشلت العملية',
  PRINT_OPENED: 'فتح معاينة الطباعة',
  PRINT_SENT: 'أُرسلت مهمة الطباعة',
  SHARE_OPENED: 'فُتحت نافذة المشاركة',
  USER_COPIED_TEXT: 'نسخ المستخدم النص',
  USER_CONFIRMED_SEND: 'أكّد المستخدم الإرسال',
};

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
    channel: params.channel,
  };

  const existing = readPersistedLogs();
  writePersistedLogs([entry, ...existing]);

  if (params.syncAudit !== false && typeof window !== 'undefined') {
    const parts = [
      `المستند: ${entry.documentNumber} (${entry.documentType})`,
      `الحالة: ${STATUS_LABELS[entry.status]}`,
    ];
    if (entry.fileName) parts.push(`الملف: ${entry.fileName}`);
    if (entry.recipientName) parts.push(`المستلم: ${entry.recipientName}`);
    if (entry.failureReason) parts.push(`السبب: ${entry.failureReason}`);

    try {
      await dataService.logAction(ACTION_LABELS[entry.operationType], parts.join(' | '));
    } catch {
      // قد يكون الاستدعاء قبل اكتمال الجلسة أو من اختبار وحدة؛ لا نعطل عملية العرض/الحفظ
    }
  }

  return entry;
}

export function getDocumentOperationLogs(filter?: {
  documentNumber?: string;
  operationType?: DocumentOperationType;
}): DocumentOperationLogEntry[] {
  const all = readPersistedLogs();
  return all.filter((item) => {
    if (filter?.documentNumber && item.documentNumber !== filter.documentNumber) return false;
    if (filter?.operationType && item.operationType !== filter.operationType) return false;
    return true;
  });
}

export function clearDocumentOperationLogs(): void {
  inMemoryLogs.length = 0;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(LOG_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}
