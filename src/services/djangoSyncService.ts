/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * محول واجهة جانغو للربط والتزامن (Django REST API Adapter & Auto-Sync Engine)
 *
 * الإصلاحات المطبقة:
 * - SYNC-01 & SYN-03: توجيه UPDATE/DELETE إلى رابط السجل المحدد، وعدم اعتماد HTTP 2xx دون إقرار صريح من الخادم.
 * - SYNC-02: دعم الترقيم الكامل (Pagination via `next` / `page`) أثناء السحب التفاضلي.
 * - SYNC-03: تسجيل فشل نقاط النهاية ومؤشرات المزامنة المستقلة لكل جدول (tableCursors).
 * - SYNC-04: تضمين الحسابات (ACCOUNT) والصناديق (CASHBOX) في Pull و Push.
 * - SYNC-05: ربط معرف المؤسسة (X-Tenant-ID) بالجلسة الموثقة.
 * - SYNC-06: حجز العناصر ذرياً عبر claimReadyToSyncItems.
 */

import { storage } from './storageService';
import { db } from '../db/erpDatabase';
import {
  OutboxQueueItem,
  Branch,
  Account,
  CashBox,
  Product,
  Party,
  Invoice,
  JournalEntry,
  PaymentVoucher,
  AmanatRecord,
} from '../types/erp';
import { syncQueueService } from './syncQueueService';
import { networkMonitor } from './networkMonitor';
import { authService } from './authService';
import { desktopSession } from './desktopSession';

export interface DjangoSyncConfig {
  serverUrl: string;
  apiToken?: string;
  tenantId?: string;
  autoSync: boolean;
  lastSyncedAt: string | null;
  syncCursor?: string | null;
  tableCursors?: Record<string, string>;
  branchId: string;
  syncIntervalSeconds?: number;
}

export interface SyncProcessResult {
  processed: number;
  succeeded: number;
  failed: number;
  errors: string[];
}

export interface DjangoPullResult {
  pulled: number;
  conflicts: number;
  errors: string[];
  newCursor?: string;
}

const SYNC_CONFIG_KEY = 'multi_activity_erp_django_sync_config';
const LEGACY_SYNC_CONFIG_KEY = 'alharaj_erp_django_sync_config';

class DjangoSyncService {
  private isProcessing = false;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;
  private desktopConfigCache: DjangoSyncConfig | null = null;
  private workerId = `django_${Math.random().toString(36).slice(2, 10)}`;

  constructor() {
    this.initAutoSyncWorker();
  }

  public initAutoSyncWorker(): void {
    if (this.initialized || typeof window === 'undefined') return;

    networkMonitor.subscribe((isOnline) => {
      const config = this.getConfig();
      if (isOnline && config.autoSync && !this.isProcessing) {
        this.processOutboxQueue().catch((err) =>
          console.warn('[DjangoSync] Auto-sync error on reconnect:', err)
        );
      }
    });

    this.startPeriodicSyncTimer();
    this.initialized = true;
  }

  private startPeriodicSyncTimer(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    if (typeof window === 'undefined') return;
    const config = this.getConfig();
    if (!config.autoSync) return;

    this.syncTimer = setInterval(() => {
      const currentConfig = this.getConfig();
      if (currentConfig.autoSync && networkMonitor.isOnline() && !this.isProcessing) {
        this.processOutboxQueue().catch(() => {});
      }
    }, (config.syncIntervalSeconds || 30) * 1000);
  }

  public getConfig(): DjangoSyncConfig {
    const isDesktop = typeof window !== 'undefined' && Boolean(window.amroDesktop);
    const activeBranchId =
      (isDesktop ? desktopSession.getActiveBranchId() : storage.getActiveBranchId()) || 'branch_main';
    const activeTenantId = authService.getActiveTenantIdSync() || 'tenant_main';
    const defaultConfig: DjangoSyncConfig = {
      serverUrl: 'http://localhost:8000/api/v1',
      apiToken: '',
      tenantId: activeTenantId,
      autoSync: false,
      lastSyncedAt: null,
      syncCursor: null,
      tableCursors: {},
      branchId: activeBranchId,
      syncIntervalSeconds: 30,
    };

    if (isDesktop) {
      const cached = this.desktopConfigCache;
      if (!cached) return defaultConfig;
      return {
        ...defaultConfig,
        ...cached,
        branchId: cached.branchId || activeBranchId,
        tenantId: cached.tenantId || activeTenantId,
        tableCursors: cached.tableCursors || {},
      };
    }

    if (typeof localStorage === 'undefined') {
      return defaultConfig;
    }

    const raw =
      localStorage.getItem(SYNC_CONFIG_KEY) || localStorage.getItem(LEGACY_SYNC_CONFIG_KEY);
    if (!raw) return defaultConfig;

    try {
      const parsed = JSON.parse(raw);
      return {
        ...defaultConfig,
        ...parsed,
        branchId: parsed.branchId || activeBranchId,
        tenantId: parsed.tenantId || activeTenantId,
        tableCursors: parsed.tableCursors || {},
      };
    } catch {
      return defaultConfig;
    }
  }

  public async refreshConfigFromDesktop(): Promise<DjangoSyncConfig> {
    if (typeof window !== 'undefined' && window.amroDesktop && desktopSession.getToken()) {
      const remote = await window.amroDesktop.getSyncConfig({
        token: desktopSession.requireToken(),
        kind: 'django',
      });
      if (remote && typeof remote === 'object') {
        this.desktopConfigCache = {
          ...this.getConfig(),
          ...(remote as Partial<DjangoSyncConfig>),
        };
      }
      this.startPeriodicSyncTimer();
    }
    return this.getConfig();
  }

  public saveConfig(config: DjangoSyncConfig): void {
    if (typeof window !== 'undefined' && window.amroDesktop) {
      this.desktopConfigCache = {
        ...this.getConfig(),
        ...config,
      };
      const token = desktopSession.getToken();
      if (token) {
        window.amroDesktop
          .saveSyncConfig({
            token,
            kind: 'django',
            config: this.desktopConfigCache,
          })
          .catch((err) => console.error('[DjangoSync] Failed to persist desktop config:', err));
      }
      this.startPeriodicSyncTimer();
      return;
    }
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(config));
    this.startPeriodicSyncTimer();
  }

  private getEndpointForEntity(entityType: OutboxQueueItem['entityType']): string {
    const map: Record<OutboxQueueItem['entityType'], string> = {
      INVOICE: '/invoices/',
      JOURNAL_ENTRY: '/journal-entries/',
      PRODUCT: '/products/',
      AMANAT: '/amanat-records/',
      VOUCHER: '/vouchers/',
      PARTY: '/parties/',
      ACCOUNT: '/accounts/',
      CASHBOX: '/cash-boxes/',
      BRANCH: '/branches/',
      PAYMENT_ALLOCATION: '/payment-allocations/',
      PARTY_ADVANCE: '/party-advances/',
      ALLOCATION_AUDIT: '/allocation-audits/',
    };
    return map[entityType] || '/sync/';
  }

  private resolveEffectiveBranch(config: DjangoSyncConfig): string {
    const session = authService.getCurrentSessionSync();
    const branchId = config.branchId?.trim() || session?.branchId?.trim() || '';
    if (!session || !branchId) throw new Error('حظر أمني: لا يوجد فرع موثّق للمزامنة.');
    if (session.role !== 'ADMIN' && !(session.allowedBranches || []).includes(branchId)) {
      throw new Error('حظر عزل الفروع: فرع المزامنة غير مصرح به للمستخدم الحالي.');
    }
    return branchId;
  }

  private resolveEffectiveTenant(config: DjangoSyncConfig): string {
    const authenticatedTenant = authService.getActiveTenantIdSync()?.trim();
    const configuredTenant = config.tenantId?.trim();
    if (!authenticatedTenant) {
      throw new Error('حظر أمني: يجب تسجيل الدخول قبل تشغيل المزامنة؛ لا يُسمح باستخدام مؤسسة افتراضية.');
    }
    if (configuredTenant && configuredTenant !== authenticatedTenant) {
      throw new Error('حظر عزل المؤسسات: إعداد المزامنة لا يطابق المؤسسة المسجلة في الجلسة.');
    }
    return authenticatedTenant;
  }

  /**
   * التحقق الصارم من وجود إقرار قبول صريح في استجابة Django REST (SYN-03)
   */
  private verifyDjangoAck(
    respBody: unknown,
    item: OutboxQueueItem,
    status: number
  ): { accepted: boolean; serverTimestamp?: string } {
    if (status === 204 && item.action === 'DELETE') {
      return { accepted: true, serverTimestamp: new Date().toISOString() };
    }
    if (!respBody || typeof respBody !== 'object') {
      return { accepted: false };
    }
    const obj = respBody as Record<string, unknown>;
    if (Array.isArray(obj.ackKeys) && obj.ackKeys.includes(item.idempotencyKey)) {
      return {
        accepted: true,
        serverTimestamp: typeof obj.server_timestamp === 'string' ? obj.server_timestamp : undefined,
      };
    }
    if (Array.isArray(obj.acceptedIds) && obj.acceptedIds.includes(item.entityId)) {
      return {
        accepted: true,
        serverTimestamp: typeof obj.server_timestamp === 'string' ? obj.server_timestamp : undefined,
      };
    }
    if (
      obj.accepted === true ||
      obj.status === 'ACCEPTED' ||
      obj.status === 'PROCESSED' ||
      obj.status === 'ok'
    ) {
      return {
        accepted: true,
        serverTimestamp: typeof obj.server_timestamp === 'string' ? obj.server_timestamp : undefined,
      };
    }
    const returnedId = item.entityType === 'ACCOUNT' ? obj.code ?? obj.id : obj.id;
    if (returnedId !== undefined && String(returnedId) === item.entityId) {
      return {
        accepted: true,
        serverTimestamp: typeof obj.server_timestamp === 'string' ? obj.server_timestamp : undefined,
      };
    }
    return { accepted: false };
  }

  public async testConnection(
    serverUrl: string
  ): Promise<{ success: boolean; message: string; details?: string }> {
    try {
      const cleanUrl = serverUrl.replace(/\/+$/, '');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      const res = await fetch(`${cleanUrl}/health/`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (res.ok) {
        return {
          success: true,
          message: 'تم الاتصال بخادم Django بنجاح! بيئة العمل متصلة بمركز البيانات السحابي.',
        };
      }

      return {
        success: false,
        message: `استجاب خادم Django برمز الخطأ: HTTP ${res.status}`,
        details: res.statusText,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'فشل الاتصال';
      return {
        success: false,
        message:
          'تعذر الوصول لخادم Django. النظام يعمل الآن بوضع دون إنترنت (Offline-First) محلياً بأمان تام.',
        details: msg,
      };
    }
  }

  /**
   * معالجة طابور Outbox وإرسال الحركات إلى Django مع الحجز الذري والإقرار الصريح
   */
  public async processOutboxQueue(): Promise<SyncProcessResult> {
    if (this.isProcessing) {
      return { processed: 0, succeeded: 0, failed: 0, errors: ['عملية المزامنة قيد التشغيل بالفعل'] };
    }

    if (!networkMonitor.isOnline()) {
      return {
        processed: 0,
        succeeded: 0,
        failed: 0,
        errors: ['لا يوجد اتصال بالإنترنت، النظام يعمل محلياً'],
      };
    }

    this.isProcessing = true;
    const errors: string[] = [];
    let succeeded = 0;
    let failed = 0;

    try {
      const config = this.getConfig();
      const effectiveTenantId = this.resolveEffectiveTenant(config);
      const effectiveBranchId = this.resolveEffectiveBranch(config);
      const session = authService.getCurrentSessionSync();
      if (!config.apiToken?.trim()) {
        throw new Error('المزامنة متوقفة بأمان: لم يتم إعداد رمز مصادقة الخادم.');
      }
      const queue = await syncQueueService.claimReadyToSyncItems(this.workerId, 25);

      if (queue.length === 0) {
        return { processed: 0, succeeded: 0, failed: 0, errors: [] };
      }

      const cleanBaseUrl = config.serverUrl.replace(/\/+$/, '');

      for (const item of queue) {
        const endpoint = this.getEndpointForEntity(item.entityType);
        const targetUrl =
          item.action === 'CREATE'
            ? `${cleanBaseUrl}${endpoint}`
            : `${cleanBaseUrl}${endpoint}${encodeURIComponent(item.entityId)}/`;

        const itemTenant = item.tenantId?.trim() || '';
        const itemBranchId = item.branchId?.trim() || effectiveBranchId;
        if (itemTenant !== effectiveTenantId) {
          const message = 'تم حجب عنصر مزامنة لا يطابق مؤسسة الجلسة الحالية.';
          await syncQueueService.markFailed(item.id, message, true);
          errors.push(`حظر عنصر ${item.entityType} (${item.entityId}): ${message}`);
          failed++;
          continue;
        }
        if (!session || (session.role !== 'ADMIN' && !(session.allowedBranches || []).includes(itemBranchId))) {
          const message = 'تم حجب عنصر مزامنة تابع لفرع غير مصرح به.';
          await syncQueueService.markFailed(item.id, message, true);
          errors.push(`حظر عنصر ${item.entityType} (${item.entityId}): ${message}`);
          failed++;
          continue;
        }

        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 6000);

          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-Idempotency-Key': item.idempotencyKey,
            'X-Tenant-ID': itemTenant,
            'X-Branch-ID': itemBranchId,
          };

          if (config.apiToken) {
            headers['Authorization'] = `Bearer ${config.apiToken}`;
          }

          const method = item.action === 'CREATE' ? 'POST' : item.action === 'UPDATE' ? 'PATCH' : 'DELETE';

          const res = await fetch(targetUrl, {
            method,
            headers,
            body:
              method === 'DELETE'
                ? undefined
                : JSON.stringify({
                    ...item.payload,
                    sync_metadata: {
                      local_outbox_id: item.id,
                      tenant_id: itemTenant,
                      entity_id: item.entityId,
                      branch_id: itemBranchId,
                      client_created_at: item.createdAt,
                      idempotency_key: item.idempotencyKey,
                    },
                  }),
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (res.ok) {
            let parsedBody: unknown = null;
            const rawText = await res.text().catch(() => '');
            if (rawText && rawText.trim().length > 0) {
              try {
                parsedBody = JSON.parse(rawText);
              } catch {
                parsedBody = null;
              }
            }

            const ack = this.verifyDjangoAck(parsedBody, item, res.status);
            if (!ack.accepted) {
              const missingAckErr =
                'استجابة 2xx بدون إقرار صريح بقبول المعاملة من خادم Django (Missing Explicit ACK)';
              await syncQueueService.markFailed(item.id, missingAckErr, false);
              errors.push(`فشل تأكيد ${item.entityType} (${item.entityId}): ${missingAckErr}`);
              failed++;
              continue;
            }

            await syncQueueService.markSynced(item.id, ack.serverTimestamp);
            succeeded++;
          } else if (res.status === 409) {
            let remoteData: Record<string, unknown> = {};
            try {
              remoteData = await res.json();
            } catch {
              remoteData = { message: 'Conflict detected by server' };
            }
            const errDetail =
              'تعارض في الحركة المالية؛ الخادم يمنع الاستبدال التلقائي للقيود والفواتير المرحّلة';
            await syncQueueService.recordConflict({
              tenantId: itemTenant,
              branchId: itemBranchId,
              entityType: item.entityType,
              entityId: item.entityId,
              localPayload: item.payload,
              remotePayload: remoteData,
              notes: errDetail,
            });
            await syncQueueService.markFailed(item.id, errDetail, true);
            errors.push(`فشل مزامنة ${item.entityType} (${item.entityId}): ${errDetail}`);
            failed++;
          } else {
            const errText = `استجابة غير متوقعة من الخادم: HTTP ${res.status} ${res.statusText}`;
            await syncQueueService.markFailed(item.id, errText, false);
            errors.push(`فشل الإرسال إلى ${endpoint}: ${errText}`);
            failed++;
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'خطأ انقطاع اتصال';
          await syncQueueService.markFailed(item.id, msg, false);
          errors.push(`خطأ شبكة عند إرسال ${item.entityType}: ${msg}`);
          failed++;
        }
      }

      if (succeeded > 0) {
        config.lastSyncedAt = new Date().toISOString();
        this.saveConfig(config);
      }

      return {
        processed: queue.length,
        succeeded,
        failed,
        errors,
      };
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * سحب التحديثات المتراكمة من خادم جانغو مع ترقيم الصفحات الكامل ومؤشرات مستقلة لكل جدول
   */
  public async pullDeltaFromDjango(cursor?: string): Promise<DjangoPullResult> {
    if (!networkMonitor.isOnline()) {
      return {
        pulled: 0,
        conflicts: 0,
        errors: ['الجهاز يعمل محلياً، لا يوجد اتصال بالإنترنت'],
      };
    }

    const config = this.getConfig();
    const effectiveTenantId = this.resolveEffectiveTenant(config);
    const effectiveBranchId = this.resolveEffectiveBranch(config);
    if (!config.apiToken?.trim()) {
      throw new Error('المزامنة متوقفة بأمان: لم يتم إعداد رمز مصادقة الخادم.');
    }
    const cleanBaseUrl = config.serverUrl.replace(/\/+$/, '');
    let pulledCount = 0;
    let conflictsCount = 0;
    const errors: string[] = [];

    const bridge = typeof window !== 'undefined' ? window.amroDesktop : undefined;
    const pendingOutboxItems = bridge
      ? (
          await bridge.getOutboxQueue({
            token: desktopSession.requireToken(),
            statusFilter: 'all',
            sortDir: 'asc',
          })
        ).filter((o) => o.status === 'PENDING' || o.status === 'SYNCING')
      : await db.outbox.where('status').anyOf(['PENDING', 'SYNCING']).toArray();
    const pendingMap = new Map<string, OutboxQueueItem>();
    pendingOutboxItems.forEach((o) => pendingMap.set(`${o.entityType}:${o.entityId}`, o));

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Branch-ID': effectiveBranchId,
      'X-Tenant-ID': effectiveTenantId,
    };
    if (config.apiToken) {
      headers['Authorization'] = `Bearer ${config.apiToken}`;
    }

    const entitiesToPull: Array<{ type: OutboxQueueItem['entityType']; endpoint: string }> = [
      { type: 'BRANCH', endpoint: '/branches/' },
      { type: 'ACCOUNT', endpoint: '/accounts/' },
      { type: 'CASHBOX', endpoint: '/cash-boxes/' },
      { type: 'PRODUCT', endpoint: '/products/' },
      { type: 'PARTY', endpoint: '/parties/' },
      { type: 'INVOICE', endpoint: '/invoices/' },
      { type: 'JOURNAL_ENTRY', endpoint: '/journal-entries/' },
      { type: 'VOUCHER', endpoint: '/vouchers/' },
      { type: 'AMANAT', endpoint: '/amanat-records/' },
    ];

    const nextCursors: Record<string, string> = { ...(config.tableCursors || {}) };

    for (const ent of entitiesToPull) {
      const entitySince = cursor || nextCursors[ent.type] || '';
      let maxServerTimestamp: string | null = entitySince || null;
      const queryParams = new URLSearchParams();
      if (entitySince) queryParams.set('since', entitySince);
      queryParams.set('branch_id', effectiveBranchId);
      queryParams.set('page_size', '100');

      let nextUrl: string | null = `${cleanBaseUrl}${ent.endpoint}?${queryParams.toString()}`;
      let entitySucceeded = true;

      try {
        while (nextUrl) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 6000);

          const res: Response = await fetch(nextUrl, { headers, signal: controller.signal });
          clearTimeout(timeoutId);

          if (!res.ok) {
            errors.push(`فشل سحب ${ent.type} (HTTP ${res.status}): ${res.statusText}`);
            entitySucceeded = false;
            break;
          }

          const data: unknown = await res.json();
          const dataObj = !Array.isArray(data) && data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
          const rows: unknown[] = Array.isArray(data) ? data : (Array.isArray(dataObj?.results) ? dataObj.results : []);

          const responseServerTimestamp =
            typeof dataObj?.server_timestamp === 'string' ? dataObj.server_timestamp :
            typeof dataObj?.next_cursor === 'string' ? dataObj.next_cursor : null;
          if (responseServerTimestamp && (!maxServerTimestamp || responseServerTimestamp > maxServerTimestamp)) {
            maxServerTimestamp = responseServerTimestamp;
          }

          for (const item of rows) {
            const row = item as Record<string, unknown>;
            const rowTimestamp = typeof row.updated_at === 'string' ? row.updated_at :
              typeof row.updatedAt === 'string' ? row.updatedAt : null;
            if (rowTimestamp && (!maxServerTimestamp || rowTimestamp > maxServerTimestamp)) {
              maxServerTimestamp = rowTimestamp;
            }
            const entityId = String(ent.type === 'ACCOUNT' ? row.code || row.id || '' : row.id || '');
            if (!entityId) continue;

            const key = `${ent.type}:${entityId}`;
            if (pendingMap.has(key)) {
              conflictsCount++;
              const pending = pendingMap.get(key)!;
              const note = `تعارض سحابي مع Django: تعديل محلي معلق في طابور Outbox للكيان (${entityId}). تم منع الاستبدال التلقائي.`;
              await syncQueueService.recordConflict({
                tenantId: effectiveTenantId,
                branchId: effectiveBranchId,
                entityType: ent.type,
                entityId,
                localPayload: pending.payload,
                remotePayload: row,
                notes: note,
              });
              continue;
            }

            if (bridge) {
              await bridge.applyRemoteSyncEntity({
                token: desktopSession.requireToken(),
                entityType: ent.type,
                row,
              });
            } else {
              await this.applyRemoteDjangoRow(ent.type, row);
            }
            pulledCount++;
          }

          nextUrl = typeof dataObj?.next === 'string' && dataObj.next ? dataObj.next : null;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'فشل طلب التحديث';
        errors.push(`فشل سحب تحديثات ${ent.type}: ${msg}`);
        entitySucceeded = false;
      }

      if (entitySucceeded && maxServerTimestamp) {
        nextCursors[ent.type] = maxServerTimestamp;
      }
    }

    config.tableCursors = nextCursors;
    const serverCursors = Object.values(nextCursors).filter((value) => Boolean(value)).sort();
    const latestServerCursor = serverCursors.length > 0 ? serverCursors[serverCursors.length - 1] : undefined;
    if (errors.length === 0 && latestServerCursor) {
      config.syncCursor = latestServerCursor;
      config.lastSyncedAt = latestServerCursor;
    }
    this.saveConfig(config);
    if (bridge && pulledCount > 0) {
      desktopSession.notifyChanged(['all']);
    }

    return {
      pulled: pulledCount,
      conflicts: conflictsCount,
      errors,
      newCursor: errors.length === 0 ? latestServerCursor : undefined,
    };
  }

  private async applyRemoteDjangoRow(
    entityType: OutboxQueueItem['entityType'],
    row: Record<string, unknown>
  ): Promise<void> {
    const isDeleted = row.is_deleted === true;

    switch (entityType) {
      case 'BRANCH': {
        const id = String(row.id);
        if (isDeleted) {
          await db.branches.delete(id);
          return;
        }
        const b: Branch = {
          id,
          code: String(row.code || 'BR01'),
          nameAr: String(row.name_ar || row.nameAr || 'فرع'),
          isMain: Boolean(row.is_main ?? row.isMain),
          address: row.address ? String(row.address) : undefined,
          phone: row.phone ? String(row.phone) : undefined,
          active: Boolean(row.active ?? true),
          createdAt: String(row.created_at || row.createdAt || new Date().toISOString()),
        };
        await db.branches.put(b);
        break;
      }

      case 'ACCOUNT': {
        const code = String(row.code || row.id);
        if (isDeleted) {
          await db.accounts.delete(code);
          return;
        }
        const acc: Account = {
          code,
          nameAr: String(row.name_ar || row.nameAr || ''),
          type: (row.type as Account['type']) || 'ASSET',
          parentCode: row.parent_code ? String(row.parent_code) : row.parentCode ? String(row.parentCode) : null,
          isLeaf: Boolean(row.is_leaf ?? row.isLeaf ?? true),
          balance: Number(row.balance || 0),
          costCenterId: (row.cost_center_id || row.costCenterId) as Account['costCenterId'],
        };
        await db.accounts.put(acc);
        break;
      }

      case 'CASHBOX': {
        const id = String(row.id);
        if (isDeleted) {
          await db.cashBoxes.delete(id);
          return;
        }
        const box: CashBox = {
          id,
          code: String(row.code || 'CASH'),
          nameAr: String(row.name_ar || row.nameAr || ''),
          accountCode: String(row.account_code || row.accountCode || '1101'),
          balance: Number(row.balance || 0),
          isDefault: Boolean(row.is_default ?? row.isDefault),
          branchId: row.branch_id ? String(row.branch_id) : 'branch_main',
        };
        await db.cashBoxes.put(box);
        break;
      }

      case 'PRODUCT': {
        const id = String(row.id);
        if (isDeleted) {
          await db.products.delete(id);
          return;
        }
        const p: Product = {
          id,
          activityId: (row.activity_id || row.activityId || 'grocery') as Product['activityId'],
          code: String(row.code || ''),
          barcode: row.barcode ? String(row.barcode) : undefined,
          nameAr: String(row.name_ar || row.nameAr || ''),
          category: String(row.category || 'عام'),
          unit: String(row.unit || 'حبه'),
          purchasePrice: Number(row.purchase_price ?? row.purchasePrice ?? 0),
          sellPrice: Number(row.sell_price ?? row.sellPrice ?? 0),
          currentStock: Number(row.current_stock ?? row.currentStock ?? 0),
          minStockAlert: Number(row.min_stock_alert ?? row.minStockAlert ?? 0),
          storageLocation: row.storage_location ? String(row.storage_location) : undefined,
          trackExpiry: Boolean(row.track_expiry ?? row.trackExpiry),
          batches: Array.isArray(row.batches) ? (row.batches as Product['batches']) : undefined,
        };
        await db.products.put(p);
        break;
      }

      case 'PARTY': {
        const id = String(row.id);
        if (isDeleted) {
          await db.parties.delete(id);
          return;
        }
        const party: Party = {
          id,
          type: (row.type || 'CUSTOMER') as Party['type'],
          nameAr: String(row.name_ar || row.nameAr || ''),
          phone: String(row.phone || ''),
          address: row.address ? String(row.address) : undefined,
          balance: Number(row.balance || 0),
        };
        await db.parties.put(party);
        break;
      }

      case 'INVOICE': {
        const inv: Invoice = {
          id: String(row.id),
          invoiceNumber: String(row.invoice_number || row.invoiceNumber || ''),
          type: (row.type || 'SALE') as Invoice['type'],
          activityId: (row.activity_id || row.activityId || 'grocery') as Invoice['activityId'],
          branchId: row.branch_id ? String(row.branch_id) : undefined,
          partyId: row.party_id ? String(row.party_id) : undefined,
          partyName: String(row.party_name || row.partyName || ''),
          date: String(row.date || new Date().toISOString().split('T')[0]),
          items: Array.isArray(row.items) ? (row.items as Invoice['items']) : [],
          subtotal: Number(row.subtotal || 0),
          discount: Number(row.discount || 0),
          tax: Number(row.tax || 0),
          total: Number(row.total || 0),
          paidAmount: Number(row.paid_amount ?? row.paidAmount ?? 0),
          paymentMethod: (row.payment_method || row.paymentMethod || 'CASH') as Invoice['paymentMethod'],
          cashBoxId: String(row.cash_box_id || row.cashBoxId || 'cb-1'),
          isPosted: Boolean(row.is_posted ?? true),
        };
        await db.invoices.put(inv);
        break;
      }

      case 'JOURNAL_ENTRY': {
        const je: JournalEntry = {
          id: String(row.id),
          entryNumber: String(row.entry_number || row.entryNumber || ''),
          date: String(row.date || new Date().toISOString().split('T')[0]),
          description: String(row.description || ''),
          costCenterId: (row.cost_center_id || row.costCenterId || 'general') as JournalEntry['costCenterId'],
          branchId: row.branch_id ? String(row.branch_id) : undefined,
          lines: Array.isArray(row.lines) ? (row.lines as JournalEntry['lines']) : [],
          status: (row.status || 'POSTED') as JournalEntry['status'],
          referenceType: (row.reference_type || row.referenceType) as JournalEntry['referenceType'],
          referenceId: row.reference_id ? String(row.reference_id) : undefined,
          isAutoGenerated: Boolean(row.is_auto_generated ?? row.isAutoGenerated),
        };
        await db.journalEntries.put(je);
        break;
      }

      case 'VOUCHER': {
        const v: PaymentVoucher = {
          id: String(row.id),
          voucherNumber: String(row.voucher_number || row.voucherNumber || ''),
          type: (row.type || 'RECEIPT') as PaymentVoucher['type'],
          date: String(row.date || new Date().toISOString().split('T')[0]),
          amount: Number(row.amount || 0),
          cashBoxId: String(row.cash_box_id || row.cashBoxId || 'cb-1'),
          branchId: row.branch_id ? String(row.branch_id) : undefined,
          partyId: row.party_id ? String(row.party_id) : undefined,
          partyName: String(row.party_name || row.partyName || ''),
          accountCode: String(row.account_code || row.accountCode || '1101'),
          description: String(row.description || ''),
          costCenterId: (row.cost_center_id || row.costCenterId || 'general') as PaymentVoucher['costCenterId'],
          journalEntryId: row.journal_entry_id ? String(row.journal_entry_id) : undefined,
        };
        await db.vouchers.put(v);
        break;
      }

      case 'AMANAT': {
        const a: AmanatRecord = {
          id: String(row.id),
          recordNumber: String(row.record_number || row.recordNumber || ''),
          depositorName: String(row.depositor_name || row.depositorName || ''),
          depositorPhone: String(row.depositor_phone || row.depositorPhone || ''),
          type: (row.type || 'CASH') as AmanatRecord['type'],
          status: (row.status || 'HELD') as AmanatRecord['status'],
          receivedDate: String(row.received_date || row.receivedDate || ''),
          amount: Number(row.amount || 0),
          receivedBy: String(row.received_by || row.receivedBy || 'المسؤول'),
          branchId: row.branch_id ? String(row.branch_id) : undefined,
        };
        await db.amanatRecords.put(a);
        break;
      }
    }
  }

  public async syncAll(): Promise<{
    pushed: number;
    pulled: number;
    conflicts: number;
    errors: string[];
  }> {
    const pushRes = await this.processOutboxQueue();
    const pullRes = await this.pullDeltaFromDjango();

    return {
      pushed: pushRes.succeeded,
      pulled: pullRes.pulled,
      conflicts: pullRes.conflicts,
      errors: [...pushRes.errors, ...pullRes.errors],
    };
  }

  public getIsProcessing(): boolean {
    return this.isProcessing;
  }
}

export const djangoSync = new DjangoSyncService();
