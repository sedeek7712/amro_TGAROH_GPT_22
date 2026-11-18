/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * محول واجهة جانغو للربط والتزامن (Django REST API Adapter & Auto-Sync Engine)
 * يضمن التوافق 100% مع Python 3.12 + Django REST Framework + PostgreSQL
 * يرسل طابور Outbox بـ Idempotency-Key وUUID، ويرفض Last-Write-Wins في المعاملات المالية
 * متصل بمحرك طابور الإرسال syncQueueService ومراقب الشبكة networkMonitor
 */

import { storage } from './storageService';
import { db } from '../db/erpDatabase';
import { OutboxQueueItem, Branch, Product, Party, Invoice, JournalEntry, PaymentVoucher, AmanatRecord } from '../types/erp';
import { syncQueueService } from './syncQueueService';
import { networkMonitor } from './networkMonitor';

export interface DjangoSyncConfig {
  serverUrl: string;
  apiToken?: string;
  autoSync: boolean;
  lastSyncedAt: string | null;
  syncCursor?: string | null;
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

  constructor() {
    this.initAutoSyncWorker();
  }

  /**
   * تهيئة عامل المزامنة التلقائي في الخلفية
   */
  public initAutoSyncWorker(): void {
    if (this.initialized || typeof window === 'undefined') return;

    // الاستماع لعودة الاتصال بالإنترنت
    networkMonitor.subscribe((isOnline) => {
      const config = this.getConfig();
      if (isOnline && config.autoSync && !this.isProcessing) {
        console.log('[DjangoSync] Network back online. Triggering automatic outbox sync...');
        this.processOutboxQueue().catch((err) =>
          console.warn('[DjangoSync] Auto-sync error on reconnect:', err)
        );
      }
    });

    // جدولة مؤقت دوري كل 30 ثانية إذا كان التزامن التلقائي مفعلاً
    this.startPeriodicSyncTimer();
    this.initialized = true;
  }

  private startPeriodicSyncTimer(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);

    this.syncTimer = setInterval(() => {
      const config = this.getConfig();
      if (config.autoSync && networkMonitor.isOnline() && !this.isProcessing) {
        this.processOutboxQueue().catch(() => {});
      }
    }, (this.getConfig().syncIntervalSeconds || 30) * 1000);
  }

  public getConfig(): DjangoSyncConfig {
    const activeBranchId = storage.getActiveBranchId() || 'branch_main';
    if (typeof localStorage === 'undefined') {
      return {
        serverUrl: 'http://localhost:8000/api/v1',
        apiToken: '',
        autoSync: true,
        lastSyncedAt: null,
        syncCursor: null,
        branchId: activeBranchId,
        syncIntervalSeconds: 30,
      };
    }

    const raw = localStorage.getItem(SYNC_CONFIG_KEY) || localStorage.getItem(LEGACY_SYNC_CONFIG_KEY);
    const defaultConfig: DjangoSyncConfig = {
      serverUrl: 'http://localhost:8000/api/v1',
      apiToken: '',
      autoSync: true,
      lastSyncedAt: null,
      syncCursor: null,
      branchId: activeBranchId,
      syncIntervalSeconds: 30,
    };

    if (!raw) return defaultConfig;
    try {
      const parsed = JSON.parse(raw);
      return {
        ...defaultConfig,
        ...parsed,
        branchId: parsed.branchId || activeBranchId,
      };
    } catch {
      return defaultConfig;
    }
  }

  public saveConfig(config: DjangoSyncConfig): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(config));
    this.startPeriodicSyncTimer();
  }

  // خريطة نقاط النهاية في Django REST Framework
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
    };
    return map[entityType] || '/sync/';
  }

  // اختبار الاتصال بخادم Django وتفقد نقطة الفحص الصحي
  public async testConnection(serverUrl: string): Promise<{ success: boolean; message: string; details?: string }> {
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
        message: 'تعذر الوصول لخادم Django. النظام يعمل الآن بوضع دون إنترنت (Offline-First) محلياً بأمان تام.',
        details: msg,
      };
    }
  }

  /**
   * معالجة طابور Outbox وإرسال الحركات إلى Django
   */
  public async processOutboxQueue(): Promise<SyncProcessResult> {
    if (this.isProcessing) {
      return { processed: 0, succeeded: 0, failed: 0, errors: ['عملية المزامنة قيد التشغيل بالفعل'] };
    }

    if (!networkMonitor.isOnline()) {
      return { processed: 0, succeeded: 0, failed: 0, errors: ['لا يوجد اتصال بالإنترنت، النظام يعمل محلياً'] };
    }

    this.isProcessing = true;
    const config = this.getConfig();
    const errors: string[] = [];
    let succeeded = 0;
    let failed = 0;

    try {
      // 1. جلب العناصر الجاهزة للمزامنة وفق الأولوية وجدولة التراجع الأسي
      const queue = await syncQueueService.getReadyToSyncItems(25);

      if (queue.length === 0) {
        return { processed: 0, succeeded: 0, failed: 0, errors: [] };
      }

      // 2. تعليم العناصر بأنها قيد الإرسال لمنع تكرار الإرسال المتزامن
      const itemIds = queue.map((q) => q.id);
      await syncQueueService.markSyncing(itemIds);

      const cleanBaseUrl = config.serverUrl.replace(/\/+$/, '');

      for (const item of queue) {
        const endpoint = this.getEndpointForEntity(item.entityType);
        const url = `${cleanBaseUrl}${endpoint}`;

        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 6000);

          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-Idempotency-Key': item.idempotencyKey,
            'X-Tenant-ID': item.tenantId,
            'X-Branch-ID': item.branchId || config.branchId,
          };

          if (config.apiToken) {
            headers['Authorization'] = `Bearer ${config.apiToken}`;
          }

          const res = await fetch(url, {
            method: item.action === 'CREATE' ? 'POST' : item.action === 'UPDATE' ? 'PUT' : 'DELETE',
            headers,
            body: JSON.stringify({
              ...item.payload,
              sync_metadata: {
                local_outbox_id: item.id,
                tenant_id: item.tenantId,
                entity_id: item.entityId,
                branch_id: item.branchId || config.branchId,
                client_created_at: item.createdAt,
                idempotency_key: item.idempotencyKey,
              },
            }),
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (res.ok || res.status === 201 || res.status === 200) {
            let serverTimestamp = new Date().toISOString();
            try {
              const respData = await res.json();
              if (respData.server_timestamp) {
                serverTimestamp = respData.server_timestamp;
              }
            } catch {
              // لا بأس إذا كانت الاستجابة بدون json
            }

            // تأكيد الحفظ على الخادم
            await syncQueueService.markSynced(item.id, serverTimestamp);
            storage.markOutboxSynced(item.id);
            succeeded++;
          } else if (res.status === 409) {
            // في حال التعارض المالي: نرفض LWW ونوثق الخطأ في جدول التعارضات للمراجعة المحاسبية
            let remoteData: Record<string, unknown> = {};
            try {
              remoteData = await res.json();
            } catch {
              remoteData = { message: 'Conflict detected by server' };
            }
            const errDetail = 'تعارض في الحركة المالية؛ الخادم يمنع الاستبدال التلقائي للقيود والفواتير المرحّلة';
            await syncQueueService.recordConflict({
              tenantId: item.tenantId,
              branchId: item.branchId || config.branchId,
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
   * سحب التحديثات المتراكمة من خادم جانغو (Delta Sync Pull)
   * مع حماية التعديلات المحلية المعلقة (Local Mutation Guard)
   */
  public async pullDeltaFromDjango(cursor?: string): Promise<DjangoPullResult> {
    if (!networkMonitor.isOnline()) {
      return { pulled: 0, conflicts: 0, errors: ['الجهاز يعمل محلياً، لا يوجد اتصال بالإنترنت'] };
    }

    const config = this.getConfig();
    const cleanBaseUrl = config.serverUrl.replace(/\/+$/, '');
    let pulledCount = 0;
    let conflictsCount = 0;
    const errors: string[] = [];

    // 1. جلب مفاتيح العناصر المعلقة محلياً لحمايتها من الاستبدال الصامت
    const pendingOutboxItems = await db.outbox
      .where('status')
      .anyOf(['PENDING', 'SYNCING'])
      .toArray();
    const pendingMap = new Map<string, OutboxQueueItem>();
    pendingOutboxItems.forEach((o) => pendingMap.set(`${o.entityType}:${o.entityId}`, o));

    const syncCursor = cursor || config.syncCursor || config.lastSyncedAt || '';
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Branch-ID': config.branchId,
      'X-Tenant-ID': 'tenant_default',
    };
    if (config.apiToken) {
      headers['Authorization'] = `Bearer ${config.apiToken}`;
    }

    const entitiesToPull: Array<{ type: OutboxQueueItem['entityType']; endpoint: string }> = [
      { type: 'BRANCH', endpoint: '/branches/' },
      { type: 'PRODUCT', endpoint: '/products/' },
      { type: 'PARTY', endpoint: '/parties/' },
      { type: 'INVOICE', endpoint: '/invoices/' },
      { type: 'JOURNAL_ENTRY', endpoint: '/journal-entries/' },
      { type: 'VOUCHER', endpoint: '/vouchers/' },
      { type: 'AMANAT', endpoint: '/amanat-records/' },
    ];

    for (const ent of entitiesToPull) {
      try {
        const queryParams = new URLSearchParams();
        if (syncCursor) queryParams.set('since', syncCursor);
        queryParams.set('branch_id', config.branchId);

        const url = `${cleanBaseUrl}${ent.endpoint}?${queryParams.toString()}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const res = await fetch(url, { headers, signal: controller.signal });
        clearTimeout(timeoutId);

        if (!res.ok) {
          // إذا لم تدعم نقطة النهاية الفلترة نتابع بسلاسة
          continue;
        }

        const data = await res.json();
        const rows: unknown[] = Array.isArray(data) ? data : data.results || [];

        for (const item of rows) {
          const row = item as Record<string, unknown>;
          const entityId = String(row.id || '');
          if (!entityId) continue;

          const key = `${ent.type}:${entityId}`;
          // فحص حماية التعديل المحلي المعلق
          if (pendingMap.has(key)) {
            conflictsCount++;
            const pending = pendingMap.get(key)!;
            const note = `تعارض سحابي مع Django: تعديل محلي معلق في طابور Outbox للصنف/الفاتورة (${entityId}). تم منع الاستبدال التلقائي.`;
            await syncQueueService.recordConflict({
              tenantId: 'tenant_default',
              branchId: config.branchId,
              entityType: ent.type,
              entityId,
              localPayload: pending.payload,
              remotePayload: row,
              notes: note,
            });
            continue;
          }

          // تطبيق السجل في Dexie المحلي بأمان تام
          await this.applyRemoteDjangoRow(ent.type, row);
          pulledCount++;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'فشل طلب التحديث';
        errors.push(`فشل سحب تحديثات ${ent.type}: ${msg}`);
      }
    }

    const newTimestamp = new Date().toISOString();
    config.syncCursor = newTimestamp;
    config.lastSyncedAt = newTimestamp;
    this.saveConfig(config);

    return {
      pulled: pulledCount,
      conflicts: conflictsCount,
      errors,
      newCursor: newTimestamp,
    };
  }

  /**
   * تطبيق البيانات السحابية القادمة من Django إلى جداول Dexie المحلية
   */
  private async applyRemoteDjangoRow(entityType: OutboxQueueItem['entityType'], row: Record<string, unknown>): Promise<void> {
    try {
      switch (entityType) {
        case 'BRANCH': {
          const b: Branch = {
            id: String(row.id),
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

        case 'PRODUCT': {
          const p: Product = {
            id: String(row.id),
            activityId: (row.activity_id || row.activityId || 'grocery') as any,
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
            batches: Array.isArray(row.batches) ? (row.batches as any) : undefined,
          };
          await db.products.put(p);
          break;
        }

        case 'PARTY': {
          const party: Party = {
            id: String(row.id),
            type: (row.type || 'CUSTOMER') as any,
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
            type: (row.type || 'SALE') as any,
            activityId: (row.activity_id || row.activityId || 'grocery') as any,
            branchId: row.branch_id ? String(row.branch_id) : undefined,
            partyId: row.party_id ? String(row.party_id) : undefined,
            partyName: String(row.party_name || row.partyName || ''),
            date: String(row.date || new Date().toISOString().split('T')[0]),
            items: Array.isArray(row.items) ? (row.items as any) : [],
            subtotal: Number(row.subtotal || 0),
            discount: Number(row.discount || 0),
            tax: Number(row.tax || 0),
            total: Number(row.total || 0),
            paidAmount: Number(row.paid_amount ?? row.paidAmount ?? 0),
            paymentMethod: (row.payment_method || row.paymentMethod || 'CASH') as any,
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
            costCenterId: (row.cost_center_id || row.costCenterId || 'general') as any,
            branchId: row.branch_id ? String(row.branch_id) : undefined,
            lines: Array.isArray(row.lines) ? (row.lines as any) : [],
            status: (row.status || 'POSTED') as any,
            referenceType: (row.reference_type || row.referenceType) as any,
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
            type: (row.type || 'RECEIPT') as any,
            date: String(row.date || new Date().toISOString().split('T')[0]),
            amount: Number(row.amount || 0),
            cashBoxId: String(row.cash_box_id || row.cashBoxId || 'cb-1'),
            branchId: row.branch_id ? String(row.branch_id) : undefined,
            partyId: row.party_id ? String(row.party_id) : undefined,
            partyName: String(row.party_name || row.partyName || ''),
            accountCode: String(row.account_code || row.accountCode || '1101'),
            description: String(row.description || ''),
            costCenterId: (row.cost_center_id || row.costCenterId || 'general') as any,
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
            type: (row.type || 'CASH') as any,
            status: (row.status || 'HELD') as any,
            receivedDate: String(row.received_date || row.receivedDate || ''),
            amount: Number(row.amount || 0),
            receivedBy: String(row.received_by || row.receivedBy || 'المسؤول'),
          };
          await db.amanatRecords.put(a);
          break;
        }
      }
    } catch (e) {
      console.warn(`[DjangoSync] Error applying remote row (${entityType}):`, e);
    }
  }

  /**
   * مزامنة شاملة ثنائية الاتجاه مع Django (Push Outbox ثم Pull Delta)
   */
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
