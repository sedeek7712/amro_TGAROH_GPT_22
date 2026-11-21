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
import { authService } from './authService';
import { desktopSession } from './desktopSession';
import { PermissionError } from '../config/rbac';
import { storage } from './storageService';

function getDesktopBridge() {
  return typeof window !== 'undefined' ? window.amroDesktop : undefined;
}

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
  /**
   * الحصول على معرّف المؤسسة الحالي من الجلسة الموثقة
   */
  public getCurrentTenantId(requireAuth = true): string {
    const authTenant = authService.getActiveTenantIdSync()?.trim();
    if (authTenant) return authTenant;
    if (requireAuth) {
      throw new PermissionError('حظر أمني: لا يمكن تنفيذ المزامنة دون جلسة مستخدم مصادق عليها ومرتبطة بمؤسسة.', 'sync:manage');
    }
    throw new PermissionError('حظر أمني: لا توجد مؤسسة افتراضية مسموح باستخدامها للمزامنة.', 'sync:manage');
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
    branchId?: string;
    dependsOn?: string[];
  }): Promise<OutboxQueueItem> {
    const authenticatedTenantId = this.getCurrentTenantId(true);
    const requestedTenantId = params.tenantId?.trim();
    if (requestedTenantId && requestedTenantId !== authenticatedTenantId) {
      throw new PermissionError('حظر عزل المؤسسات: لا يمكن إنشاء عنصر مزامنة لمؤسسة أخرى.', 'tenant:access');
    }
    const session = authService.getCurrentSessionSync();
    const branchId = params.branchId?.trim() || session?.branchId?.trim() || '';
    if (!session || !branchId) {
      throw new PermissionError('حظر عزل الفروع: عنصر المزامنة يجب أن يحمل فرعاً موثقاً.', 'branch:required');
    }
    if (session.role !== 'ADMIN' && !(session.allowedBranches || []).includes(branchId)) {
      throw new PermissionError('حظر عزل الفروع: لا يمكن إنشاء عنصر لفرع غير مصرح به.', 'branch:access');
    }
    const tenantId = authenticatedTenantId;

    const bridge = getDesktopBridge();
    if (bridge) {
      const item = await bridge.queueOutboxItem({
        token: desktopSession.requireToken(),
        item: {
          entityType: params.entityType,
          entityId: params.entityId,
          action: params.action,
          payload: params.payload,
          priority: params.priority,
          idempotencyKey: params.idempotencyKey,
          tenantId,
          branchId,
          dependsOn: params.dependsOn,
        },
      });
      if (!item) {
        throw new Error('تعذر تسجيل عنصر المزامنة في قاعدة بيانات SQLite.');
      }
      desktopSession.notifyChanged(['outbox']);
      this.notifySubscribers();
      return item;
    }

    // مفتاح حتمي ثابت ومستقر: يعتمد على المؤسسة، نوع الكيان، معرّفه الثابت والإجراء
    const idempotencyKey =
      params.idempotencyKey ||
      `${tenantId}_${params.entityType}_${params.entityId}_${params.action}`;

    const saved = await db.transaction('rw', db.outbox, async () => {
      const existing = await db.outbox
        .where('idempotencyKey')
        .equals(idempotencyKey)
        .filter((i) => i.tenantId === tenantId)
        .first();

      if (existing) {
        if (existing.status !== 'SYNCED') {
          existing.payload = params.payload;
          if (params.dependsOn) existing.dependsOn = params.dependsOn;
          if (params.priority) existing.priority = params.priority;
          if (params.branchId) existing.branchId = params.branchId;
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
        branchId,
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
      return item;
    });

    this.notifySubscribers();
    return saved;
  }

  /**
   * فرز وتصفية العناصر الجاهزة للمزامنة دون تعديل الحالة
   */
  private filterAndSortReadyItems(allItems: OutboxQueueItem[], nowIso: string, limit: number): OutboxQueueItem[] {
    const unSyncedEntityIds = new Set<string>();
    for (const item of allItems) {
      if (item.status === 'PENDING' || item.status === 'SYNCING' || item.status === 'FAILED') {
        unSyncedEntityIds.add(item.entityId);
      }
    }

    const readyItems = allItems.filter((item) => {
      if (item.status !== 'PENDING') return false;
      if (item.nextRetryAt && item.nextRetryAt > nowIso) {
        return false;
      }
      if (item.dependsOn && item.dependsOn.length > 0) {
        const hasUnresolvedDependency = item.dependsOn.some((depId) => unSyncedEntityIds.has(depId));
        if (hasUnresolvedDependency) {
          return false;
        }
      }
      return true;
    });

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
   * جلب العناصر الجاهزة للمزامنة مع التحقق الصارم من التبعيات (Dependency-Aware Sync)
   */
  public async getReadyToSyncItems(limit = 50): Promise<OutboxQueueItem[]> {
    const nowIso = new Date().toISOString();
    const bridge = getDesktopBridge();
    if (bridge) {
      const allItems = await bridge.getOutboxQueue({
        token: desktopSession.requireToken(),
        statusFilter: 'all',
        sortDir: 'asc',
      });
      return this.filterAndSortReadyItems(allItems, nowIso, limit);
    }
    const allItems = await db.outbox.toArray();
    return this.filterAndSortReadyItems(allItems, nowIso, limit);
  }

  /**
   * حجز العناصر الجاهزة ذرياً لعامل مزامنة محدد (Atomic Lease Claim - SYNC-06)
   * يمنع تسابق العمال أو تكرار سحب نفس العنصر عند تزامن دورتين متقاربتين
   */
  public async claimReadyToSyncItems(
    workerId: string,
    limit = 25,
    leaseMs = 180_000
  ): Promise<OutboxQueueItem[]> {
    const owner = workerId.trim() || 'worker_default';
    const bridge = getDesktopBridge();
    if (bridge) {
      const claimed = await bridge.claimReadyToSyncItems({
        token: desktopSession.requireToken(),
        workerId: owner,
        limit,
        leaseMs,
      });
      if (claimed.length > 0) {
        desktopSession.notifyChanged(['outbox']);
        this.notifySubscribers();
      }
      return claimed;
    }
    const claimed = await db.transaction('rw', db.outbox, async () => {
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();

      const allItems = await db.outbox.toArray();

      // تحرير أي حجز منتهي الصلاحية قبل الاستعلام
      for (const item of allItems) {
        if (item.status === 'SYNCING' && item.leaseExpiresAt && item.leaseExpiresAt < nowIso) {
          item.status = 'PENDING';
          item.leaseOwner = undefined;
          item.leaseExpiresAt = undefined;
          await db.outbox.put(item);
        }
      }

      const candidates = this.filterAndSortReadyItems(allItems, nowIso, limit);
      const result: OutboxQueueItem[] = [];

      for (const candidate of candidates) {
        const current = await db.outbox.get(candidate.id);
        if (!current || current.status !== 'PENDING') continue;

        const updated: OutboxQueueItem = {
          ...current,
          status: 'SYNCING',
          leaseOwner: owner,
          leaseExpiresAt,
          lastAttemptAt: nowIso,
        };
        await db.outbox.put(updated);
        result.push({ ...updated });
      }

      return result;
    });

    if (claimed.length > 0) {
      this.notifySubscribers();
    }
    return claimed;
  }

  /**
   * تعليم مجموعة عناصر بأنها قيد المزامنة حالياً لمنع التكرار
   */
  public async markSyncing(ids: string[], workerId = 'worker_default', leaseMs = 180_000): Promise<void> {
    if (getDesktopBridge()) {
      return;
    }
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
    await db.transaction('rw', db.outbox, async () => {
      for (const id of ids) {
        const item = await db.outbox.get(id);
        if (item && item.status === 'PENDING') {
          item.status = 'SYNCING';
          item.lastAttemptAt = now;
          item.leaseOwner = workerId;
          item.leaseExpiresAt = leaseExpiresAt;
          await db.outbox.put(item);
        }
      }
    });
    this.notifySubscribers();
  }

  /**
   * استعادة السجلات العالقة بحالة SYNCING عند تشغيل التطبيق أو انتهاء مهلة الحجز (Lease Expiry)
   */
  public async recoverStuckSyncingItems(leaseTimeoutMinutes = 2): Promise<number> {
    const bridge = getDesktopBridge();
    if (bridge) {
      if (!desktopSession.getToken()) return 0;
      const recovered = await bridge.recoverStuckSyncingItems({
        token: desktopSession.requireToken(),
        leaseTimeoutMinutes,
      });
      if (recovered > 0) {
        desktopSession.notifyChanged(['outbox']);
        this.notifySubscribers();
      }
      return recovered;
    }
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const cutoffTime = new Date(nowMs - leaseTimeoutMinutes * 60 * 1000).toISOString();

    const stuckItems = await db.outbox
      .where('status')
      .equals('SYNCING')
      .filter((item) => {
        if (item.leaseExpiresAt && item.leaseExpiresAt < nowIso) return true;
        return !item.lastAttemptAt || item.lastAttemptAt < cutoffTime;
      })
      .toArray();

    if (stuckItems.length === 0) return 0;

    let recovered = 0;
    await db.transaction('rw', db.outbox, async () => {
      for (const item of stuckItems) {
        item.status = 'PENDING';
        item.nextRetryAt = undefined;
        item.leaseOwner = undefined;
        item.leaseExpiresAt = undefined;
        await db.outbox.put(item);
        recovered++;
      }
    });

    console.warn(`[SyncQueue] Recovered ${recovered} stuck SYNCING items back to PENDING queue.`);
    this.notifySubscribers();
    return recovered;
  }

  /**
   * تأكيد نجاح المزامنة بعد استلام إقرار مؤكد وصريح من الخادم
   */
  public async markSynced(id: string, serverTimestamp?: string): Promise<void> {
    const bridge = getDesktopBridge();
    if (bridge) {
      await bridge.markOutboxSynced({
        token: desktopSession.requireToken(),
        id,
        serverTimestamp,
      });
      desktopSession.notifyChanged(['outbox']);
      this.notifySubscribers();
      return;
    }
    await db.transaction('rw', db.outbox, async () => {
      const item = await db.outbox.get(id);
      if (item) {
        item.status = 'SYNCED';
        item.syncedAt = serverTimestamp || new Date().toISOString();
        item.errorMessage = undefined;
        item.leaseOwner = undefined;
        item.leaseExpiresAt = undefined;
        await db.outbox.put(item);
      }
    });
    this.notifySubscribers();
  }

  /**
   * تسجيل فشل المزامنة وتطبيق خوارزمية التراجع الأسي (Exponential Backoff)
   */
  public async markFailed(id: string, errorMessage: string, isPermanent = false): Promise<void> {
    const bridge = getDesktopBridge();
    if (bridge) {
      await bridge.markOutboxFailed({
        token: desktopSession.requireToken(),
        id,
        errorMessage,
        isPermanent,
      });
      desktopSession.notifyChanged(['outbox']);
      this.notifySubscribers();
      return;
    }
    await db.transaction('rw', db.outbox, async () => {
      const item = await db.outbox.get(id);
      if (!item) return;

      item.retryCount = (item.retryCount || 0) + 1;
      item.errorMessage = errorMessage;
      item.lastAttemptAt = new Date().toISOString();
      item.leaseOwner = undefined;
      item.leaseExpiresAt = undefined;

      if (isPermanent || item.retryCount >= this.maxRetries) {
        item.status = 'FAILED';
        item.nextRetryAt = undefined;
        console.warn(`[SyncQueue] Item ${id} (${item.entityType}) marked permanently FAILED after ${item.retryCount} attempts: ${errorMessage}`);
      } else {
        const backoffMs = Math.min(1000 * Math.pow(2, item.retryCount), 60000);
        const nextDate = new Date(Date.now() + backoffMs);
        item.nextRetryAt = nextDate.toISOString();
        item.status = 'PENDING';
        console.log(`[SyncQueue] Item ${id} scheduled for retry #${item.retryCount} at ${item.nextRetryAt} (+${backoffMs / 1000}s)`);
      }

      await db.outbox.put(item);
    });
    this.notifySubscribers();
  }

  /**
   * إعادة ضبط العناصر الفاشلة للتمكن من إعادة محاولتها يدوياً
   */
  public async retryFailedItems(): Promise<number> {
    const bridge = getDesktopBridge();
    if (bridge) {
      const count = await bridge.retryFailedItems({ token: desktopSession.requireToken() });
      if (count > 0) {
        desktopSession.notifyChanged(['outbox']);
        this.notifySubscribers();
      }
      return count;
    }
    const count = await db.transaction('rw', db.outbox, async () => {
      const failedItems = await db.outbox.where('status').equals('FAILED').toArray();
      let updatedCount = 0;
      for (const item of failedItems) {
        item.status = 'PENDING';
        item.nextRetryAt = undefined;
        item.errorMessage = undefined;
        item.leaseOwner = undefined;
        item.leaseExpiresAt = undefined;
        await db.outbox.put(item);
        updatedCount++;
      }
      return updatedCount;
    });
    this.notifySubscribers();
    return count;
  }

  /**
   * إحصائيات حية لطابور الإرسال
   */
  public async getStats(): Promise<QueueStats> {
    const bridge = getDesktopBridge();
    if (bridge) {
      const token = desktopSession.getToken();
      if (!token) return { total: 0, pending: 0, syncing: 0, synced: 0, failed: 0 };
      return await bridge.getOutboxStats({ token });
    }
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
    const bridge = getDesktopBridge();
    if (bridge) {
      const count = await bridge.purgeOldSyncedRecords({
        token: desktopSession.requireToken(),
        olderThanDays,
      });
      if (count > 0) {
        desktopSession.notifyChanged(['outbox']);
        this.notifySubscribers();
      }
      return count;
    }
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
    const tenantId = this.getCurrentTenantId(true);
    if (params.tenantId && params.tenantId !== tenantId) {
      throw new PermissionError('حظر عزل المؤسسات: لا يمكن تسجيل تعارض لمؤسسة أخرى.', 'tenant:access');
    }
    const session = authService.getCurrentSessionSync();
    const branchId = params.branchId?.trim() || session?.branchId?.trim() || '';
    if (!session || !branchId) throw new PermissionError('حظر عزل الفروع: يجب تحديد فرع للتعارض.', 'branch:required');
    if (session.role !== 'ADMIN' && !(session.allowedBranches || []).includes(branchId)) {
      throw new PermissionError('حظر عزل الفروع: التعارض تابع لفرع غير مصرح به.', 'branch:access');
    }
    const bridge = getDesktopBridge();
    if (bridge) {
      const conflict = await bridge.recordConflict({
        token: desktopSession.requireToken(),
        params: {
          tenantId,
          branchId,
          entityType: params.entityType,
          entityId: params.entityId,
          localPayload: params.localPayload,
          remotePayload: params.remotePayload,
          notes: params.notes,
        },
      });
      desktopSession.notifyChanged(['syncConflicts']);
      return conflict;
    }

    const conflict: SyncConflict = {
      id: storage.generateUUID(),
      tenantId,
      branchId,
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
    const bridge = getDesktopBridge();
    if (bridge) {
      return await bridge.getConflicts({ token: desktopSession.requireToken() });
    }
    const tenantId = this.getCurrentTenantId(true);
    const session = authService.getCurrentSessionSync();
    if (!session) throw new PermissionError('حظر أمني: يلزم تسجيل الدخول لعرض التعارضات.', 'sync:manage');
    const rows = await db.syncConflicts.where('tenantId').equals(tenantId).reverse().sortBy('detectedAt');
    return session.role === 'ADMIN'
      ? rows
      : rows.filter((item) => Boolean(item.branchId && session.allowedBranches.includes(item.branchId)));
  }

  /**
   * تسوية تعارض محاسبي أو مخزني
   */
  public async resolveConflict(
    conflictId: string,
    status: SyncConflict['status'],
    notes?: string
  ): Promise<void> {
    const bridge = getDesktopBridge();
    if (bridge) {
      await bridge.resolveConflict({
        token: desktopSession.requireToken(),
        conflictId,
        status,
        notes,
      });
      desktopSession.notifyChanged(['syncConflicts', 'auditLogs']);
      return;
    }
    const tenantId = this.getCurrentTenantId(true);
    const session = authService.getCurrentSessionSync();
    if (!session) throw new PermissionError('حظر أمني: يلزم تسجيل الدخول لتسوية التعارض.', 'sync:manage');
    const conflict = await db.syncConflicts.get(conflictId);
    if (conflict && conflict.tenantId === tenantId) {
      if (!conflict.branchId || (session.role !== 'ADMIN' && !session.allowedBranches.includes(conflict.branchId))) {
        throw new PermissionError('حظر عزل الفروع: لا يمكن تسوية تعارض فرع غير مصرح به.', 'branch:access');
      }
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
    this.getStats().then((s) => callback(s)).catch(() => {});
    const unsubDesktop = getDesktopBridge()
      ? desktopSession.subscribe((domains) => {
          if (domains.includes('outbox') || domains.includes('all') || domains.includes('session')) {
            this.getStats().then((s) => callback(s)).catch(() => {});
          }
        })
      : null;
    return () => {
      this.subscribers.delete(callback);
      if (unsubDesktop) unsubDesktop();
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
