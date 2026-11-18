/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * محرك طابور الإرسال والمزامنة (Offline Outbox & Sync Queue Service)
 * يضمن:
 * 1. عدم فقدان أي حركة مالية أو مخزنية أثناء انقطاع الإنترنت.
 * 2. ثبات معرفات UUID ومفاتيح منع التكرار (Idempotency Keys).
 * 3. عدم اعتماد المزامنة إلا بعد تأكيد الخادم الصريح (Server Confirmation).
 * 4. إعادة المحاولة مع التراجع الأسي (Exponential Backoff).
 * 5. عزل المؤسسات والمستأجرين (Multi-Tenancy).
 */

import { db } from '../db/erpDatabase';
import { OutboxQueueItem, SyncConflict } from '../types/erp';
import { storage } from './storageService';

export interface QueueStats {
  total: number;
  pending: number;
  syncing: number;
  synced: number;
  failed: number;
}

export type QueueSubscriber = (stats: QueueStats) => void;

class SyncQueueService {
  private subscribers: Set<QueueSubscriber> = new Set();
  private maxRetries = 5;
  private defaultTenantId = 'tenant_default';

  /**
   * الحصول على معرّف المؤسسة الحالي
   */
  public getCurrentTenantId(): string {
    const user = storage.getCurrentUser();
    return (user as { tenantId?: string }).tenantId || this.defaultTenantId;
  }

  /**
   * حساب الأولوية الافتراضية وفق معمارية Master-Data-First
   * تضمن إنشاء الحسابات والصناديق أولاً، ثم العملاء والموردين والأصناف، ثم الفواتير والسندات، وأخيراً القيود
   */
  public getDefaultPriority(entityType: OutboxQueueItem['entityType']): number {
    switch (entityType) {
      case 'BRANCH':
      case 'ACCOUNT':
      case 'CASHBOX':
        return 1; // أولوية قصوى: الفروع والحسابات والدفاتر والصناديق الأساسية
      case 'PARTY':
      case 'PRODUCT':
        return 2; // أولوية تأسيسية: أطراف التعامل (عملاء/موردين) والأصناف والمخزون
      case 'INVOICE':
      case 'VOUCHER':
      case 'AMANAT':
        return 3; // أولوية حركية: المستندات والفواتير والسندات
      case 'JOURNAL_ENTRY':
        return 4; // أولوية قيود: قيود اليومية العامة المترتبة
      default:
        return 3;
    }
  }

  /**
   * إضافة حركة جديدة إلى طابور Outbox مع ضمان حتمية مفتاح منع التكرار (Deterministic Idempotency)
   */
  public async enqueue(params: {
    entityType: OutboxQueueItem['entityType'];
    entityId: string;
    action: OutboxQueueItem['action'];
    payload: Record<string, unknown>;
    priority?: number;
    idempotencyKey?: string;
    tenantId?: string;
    dependsOn?: string[];
  }): Promise<OutboxQueueItem> {
    const tenantId = params.tenantId || this.getCurrentTenantId();

    // مفتاح حتمي ثابت ومستقر: يعتمد على المؤسسة، نوع الكيان، معرّفه الثابت والإجراء
    // لا يحتوي على أي قيم متغيرة كالتوقيت أو الأرقام العشوائية لضمان سلامة إعادة المحاولات
    const idempotencyKey =
      params.idempotencyKey ||
      `${tenantId}_${params.entityType}_${params.entityId}_${params.action}`;

    // فحص ما إذا كان هناك سجل سابق في الطابور بنفس المفتاح والمؤسسة
    const existing = await db.outbox
      .where('idempotencyKey')
      .equals(idempotencyKey)
      .filter((i) => i.tenantId === tenantId)
      .first();

    if (existing) {
      if (existing.status !== 'SYNCED') {
        // تحديث الحمولة والتبعيات دون تكرار العنصر في الطابور
        existing.payload = params.payload;
        if (params.dependsOn) existing.dependsOn = params.dependsOn;
        if (params.priority) existing.priority = params.priority;
        await db.outbox.put(existing);
      }
      return existing;
    }

    const id = storage.generateUUID();
    const createdAt = new Date().toISOString();
    const priority = params.priority || this.getDefaultPriority(params.entityType);

    const item: OutboxQueueItem = {
      id,
      tenantId,
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      payload: params.payload,
      createdAt,
      status: 'PENDING',
      idempotencyKey,
      retryCount: 0,
      priority,
      dependsOn: params.dependsOn && params.dependsOn.length > 0 ? params.dependsOn : undefined,
    };

    await db.outbox.put(item);
    this.notifySubscribers();
    return item;
  }

  /**
   * جلب العناصر الجاهزة للمزامنة مع التحقق الصارم من التبعيات (Dependency-Aware Sync)
   * يضمن:
   * 1. عدم إرسال الفاتورة أو السند قبل اكتمال مزامنة العميل أو الصنف التابع له.
   * 2. عدم تعطيل حركات مستقلة في حال فشل أو تعثر حركة أخرى غير مرتبطة بها.
   */
  public async getReadyToSyncItems(limit = 50): Promise<OutboxQueueItem[]> {
    const now = new Date().toISOString();
    const allItems = await db.outbox.toArray();

    // حصر الكيانات التي لا تزال معلقة أو قيد المزامنة أو فاشلة حالياً
    const unSyncedEntityIds = new Set<string>();
    for (const item of allItems) {
      if (item.status === 'PENDING' || item.status === 'SYNCING' || item.status === 'FAILED') {
        unSyncedEntityIds.add(item.entityId);
      }
    }

    const allPending = allItems.filter((i) => i.status === 'PENDING');

    // تصفية العناصر الجاهزة زمنياً وفق سياسة Exponential Backoff والواعية بالتبعيات
    const readyItems = allPending.filter((item) => {
      // 1. فحص توقيت إعادة المحاولة
      if (item.nextRetryAt && item.nextRetryAt > now) {
        return false;
      }

      // 2. فحص التبعيات: إذا كان العنصر يعتمد على كيانات لم تُزامن بعد، يتم تعليقه
      if (item.dependsOn && item.dependsOn.length > 0) {
        const hasUnresolvedDependency = item.dependsOn.some((depId) => unSyncedEntityIds.has(depId));
        if (hasUnresolvedDependency) {
          // يتم تخطي هذا العنصر حتى تكتمل مزامنة أصله، دون حجب العناصر المستقلة الأخرى
          return false;
        }
      }

      return true;
    });

    // ترتيب العناصر بحسب الأسبقية الهندسية:
    // 1: الحسابات والصناديق أولاً
    // 2: العملاء والأصناف ثانياً
    // 3: الفواتير والسندات ثالثاً
    // 4: القيود المحاسبية رابعاً
    // ثم بحسب الأقدمية الزمنية (FIFO)
    readyItems.sort((a, b) => {
      const pA = a.priority ?? this.getDefaultPriority(a.entityType);
      const pB = b.priority ?? this.getDefaultPriority(b.entityType);
      const pDiff = pA - pB;
      if (pDiff !== 0) return pDiff;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    return readyItems.slice(0, limit);
  }

  /**
   * تعليم مجموعة عناصر بأنها قيد المزامنة حالياً لمنع التكرار
   */
  public async markSyncing(ids: string[]): Promise<void> {
    const now = new Date().toISOString();
    await db.transaction('rw', db.outbox, async () => {
      for (const id of ids) {
        const item = await db.outbox.get(id);
        if (item && item.status === 'PENDING') {
          item.status = 'SYNCING';
          item.lastAttemptAt = now;
          await db.outbox.put(item);
        }
      }
    });
    this.notifySubscribers();
  }

  /**
   * استعادة السجلات العالقة بحالة SYNCING عند تشغيل التطبيق أو بعد انقطاع الاتصال المفاجئ
   * إذا تجاوزت المدة منذ محاولة الإرسال السابقة مهلة القفل (leaseTimeoutMinutes)، يتم إرجاعها إلى PENDING
   */
  public async recoverStuckSyncingItems(leaseTimeoutMinutes = 2): Promise<number> {
    const cutoffTime = new Date(Date.now() - leaseTimeoutMinutes * 60 * 1000).toISOString();
    const stuckItems = await db.outbox
      .where('status')
      .equals('SYNCING')
      .filter((item) => !item.lastAttemptAt || item.lastAttemptAt < cutoffTime)
      .toArray();

    if (stuckItems.length === 0) return 0;

    let recovered = 0;
    await db.transaction('rw', db.outbox, async () => {
      for (const item of stuckItems) {
        item.status = 'PENDING';
        item.nextRetryAt = undefined;
        await db.outbox.put(item);
        recovered++;
      }
    });

    console.warn(`[SyncQueue] Recovered ${recovered} stuck SYNCING items back to PENDING queue.`);
    this.notifySubscribers();
    return recovered;
  }

  /**
   * تأكيد نجاح المزامنة بعد استلام استجابة مؤكدة من الخادم
   */
  public async markSynced(id: string, serverTimestamp?: string): Promise<void> {
    const item = await db.outbox.get(id);
    if (item) {
      item.status = 'SYNCED';
      item.syncedAt = serverTimestamp || new Date().toISOString();
      item.errorMessage = undefined;
      await db.outbox.put(item);
      this.notifySubscribers();
    }
  }

  /**
   * تسجيل فشل المزامنة وتطبيق خوارزمية التراجع الأسي (Exponential Backoff)
   */
  public async markFailed(id: string, errorMessage: string, isPermanent = false): Promise<void> {
    const item = await db.outbox.get(id);
    if (!item) return;

    item.retryCount = (item.retryCount || 0) + 1;
    item.errorMessage = errorMessage;
    item.lastAttemptAt = new Date().toISOString();

    if (isPermanent || item.retryCount >= this.maxRetries) {
      item.status = 'FAILED';
      item.nextRetryAt = undefined;
      console.warn(`[SyncQueue] Item ${id} (${item.entityType}) marked permanently FAILED after ${item.retryCount} attempts: ${errorMessage}`);
    } else {
      // حساب التراجع الأسي: 1s, 2s, 4s, 8s, 16s... بحد أقصى 60 ثانية
      const backoffMs = Math.min(1000 * Math.pow(2, item.retryCount), 60000);
      const nextDate = new Date(Date.now() + backoffMs);
      item.nextRetryAt = nextDate.toISOString();
      item.status = 'PENDING';
      console.log(`[SyncQueue] Item ${id} scheduled for retry #${item.retryCount} at ${item.nextRetryAt} (+${backoffMs / 1000}s)`);
    }

    await db.outbox.put(item);
    this.notifySubscribers();
  }

  /**
   * إعادة ضبط العناصر الفاشلة للتمكن من إعادة محاولتها يدوياً
   */
  public async retryFailedItems(): Promise<number> {
    const failedItems = await db.outbox.where('status').equals('FAILED').toArray();
    let count = 0;
    for (const item of failedItems) {
      item.status = 'PENDING';
      item.nextRetryAt = undefined;
      item.errorMessage = undefined;
      await db.outbox.put(item);
      count++;
    }
    this.notifySubscribers();
    return count;
  }

  /**
   * إحصائيات حية لطابور الإرسال
   */
  public async getStats(): Promise<QueueStats> {
    const items = await db.outbox.toArray();
    const stats: QueueStats = {
      total: items.length,
      pending: 0,
      syncing: 0,
      synced: 0,
      failed: 0,
    };

    for (const it of items) {
      if (it.status === 'PENDING') stats.pending++;
      else if (it.status === 'SYNCING') stats.syncing++;
      else if (it.status === 'SYNCED') stats.synced++;
      else if (it.status === 'FAILED') stats.failed++;
    }

    return stats;
  }

  /**
   * تنظيف السجلات المؤكدة بنجاح فقط والقديمة أكثر من مدة معينة لمنع تضخم القاعدة
   * تحذير: لا يمس السجلات المعلقة أو الفاشلة مطلقاً!
   */
  public async purgeOldSyncedRecords(olderThanDays = 30): Promise<number> {
    const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const oldSynced = await db.outbox
      .where('status')
      .equals('SYNCED')
      .filter((item) => (item.syncedAt ? item.syncedAt < cutoffDate : false))
      .toArray();

    const idsToDelete = oldSynced.map((i) => i.id);
    if (idsToDelete.length > 0) {
      await db.outbox.bulkDelete(idsToDelete);
      this.notifySubscribers();
    }
    return idsToDelete.length;
  }

  /**
   * تسجيل تعارض مزامنة جديد في قاعدة بيانات Dexie للمراجعة المحاسبية
   */
  public async recordConflict(params: {
    tenantId?: string;
    branchId?: string;
    entityType: OutboxQueueItem['entityType'];
    entityId: string;
    localPayload: Record<string, unknown>;
    remotePayload: Record<string, unknown>;
    notes?: string;
  }): Promise<SyncConflict> {
    const tenantId = params.tenantId || this.getCurrentTenantId();
    const conflict: SyncConflict = {
      id: storage.generateUUID(),
      tenantId,
      branchId: params.branchId,
      entityType: params.entityType,
      entityId: params.entityId,
      localPayload: params.localPayload,
      remotePayload: params.remotePayload,
      detectedAt: new Date().toISOString(),
      status: 'PENDING_REVIEW',
      notes: params.notes || 'تم اكتشاف تعارض في البيانات بين الجهاز والخادم السحابي.',
    };

    await db.syncConflicts.put(conflict);
    console.warn(`[SyncQueue] Conflict recorded for ${params.entityType} (${params.entityId}):`, params.notes);
    return conflict;
  }

  /**
   * استرجاع كافة التعارضات المسجلة
   */
  public async getConflicts(): Promise<SyncConflict[]> {
    return await db.syncConflicts.toCollection().reverse().sortBy('detectedAt');
  }

  /**
   * تسوية تعارض محاسبي أو مخزني
   */
  public async resolveConflict(
    conflictId: string,
    status: SyncConflict['status'],
    notes?: string
  ): Promise<void> {
    const conflict = await db.syncConflicts.get(conflictId);
    if (conflict) {
      conflict.status = status;
      conflict.resolvedAt = new Date().toISOString();
      if (notes) conflict.notes = (conflict.notes ? conflict.notes + ' | ' : '') + notes;
      await db.syncConflicts.put(conflict);
    }
  }

  /**
   * الاشتراك في تحديثات الطابور
   */
  public subscribe(callback: QueueSubscriber): () => void {
    this.subscribers.add(callback);
    this.getStats().then((s) => callback(s));
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private notifySubscribers() {
    this.getStats().then((stats) => {
      this.subscribers.forEach((cb) => {
        try {
          cb(stats);
        } catch (err) {
          console.error('[SyncQueue] Subscriber notification error:', err);
        }
      });
    });
  }
}

export const syncQueueService = new SyncQueueService();
