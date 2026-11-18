/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * محرك مزامنة السحابة وتعدد الأجهزة وعزل المؤسسات
 * Supabase & PostgreSQL Multi-Device Bi-Directional Sync Service
 * 
 * - يحافظ على ثبات UUIDs ولا يُنشئ معرفات جديدة أثناء المزامنة.
 * - يضمن العزل التام للمؤسسات عبر ترويسات وقيم tenant_id.
 * - يمنع التكرار (Idempotency) باستخدام Idempotency-Key في كل حركة مالية ومخزنية.
 * - يدعم المزامنة ثنائية الاتجاه (Push Outbox + Pull Delta) دون الكتابة فوق التعديلات المحلية المعلقة.
 * - يضمن عدم اعتبار أي عملية مرفوعة إلا بعد تأكيد خادم Supabase برمز نجاح حقيقي.
 */

import { db } from '../db/erpDatabase';
import { syncQueueService } from './syncQueueService';
import { networkMonitor } from './networkMonitor';
import {
  SupabaseSyncConfig,
  CloudSyncResult,
  OutboxQueueItem,
  Product,
  Party,
  Invoice,
  JournalEntry,
  PaymentVoucher,
  AmanatRecord,
  Branch,
} from '../types/erp';

const SUPABASE_CONFIG_KEY = 'multi_activity_erp_supabase_sync_config';
const DEVICE_ID_KEY = 'multi_activity_erp_device_id';
const DEVICE_NAME_KEY = 'multi_activity_erp_device_name';

export class SupabaseSyncService {
  private isSyncing = false;
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  constructor() {
    this.initAutoSyncWorker();
  }

  /**
   * توليد أو استرجاع معرف فريد وثابت للجهاز الحالي (Device UUID)
   */
  public getOrCreateDeviceId(): string {
    if (typeof localStorage === 'undefined') return 'device_server_runtime';
    let deviceId = localStorage.getItem(DEVICE_ID_KEY);
    if (!deviceId) {
      deviceId = `dev_${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15)}`;
      localStorage.setItem(DEVICE_ID_KEY, deviceId);
    }
    return deviceId;
  }

  public getDeviceName(): string {
    if (typeof localStorage === 'undefined') return 'جهاز المتصفح';
    return localStorage.getItem(DEVICE_NAME_KEY) || 'نقطة بيع رئيسية';
  }

  public setDeviceName(name: string): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(DEVICE_NAME_KEY, name.trim());
    }
  }

  /**
   * استرجاع إعدادات الربط السحابي مع Supabase
   */
  public getConfig(): SupabaseSyncConfig {
    const deviceId = this.getOrCreateDeviceId();
    const deviceName = this.getDeviceName();

    const defaultConfig: SupabaseSyncConfig = {
      supabaseUrl: '',
      supabaseAnonKey: '',
      tenantId: 'tenant_default',
      deviceId,
      deviceName,
      autoSync: false,
      lastPullTimestamp: null,
      lastPushTimestamp: null,
      syncIntervalSeconds: 30,
    };

    if (typeof localStorage === 'undefined') return defaultConfig;

    const raw = localStorage.getItem(SUPABASE_CONFIG_KEY);
    if (!raw) return defaultConfig;

    try {
      const parsed = JSON.parse(raw);
      return {
        ...defaultConfig,
        ...parsed,
        deviceId, // الحفاظ دائماً على معرف الجهاز الفعلي
      };
    } catch {
      return defaultConfig;
    }
  }

  /**
   * حفظ إعدادات الربط السحابي
   */
  public saveConfig(newConfig: Partial<SupabaseSyncConfig>): void {
    if (typeof localStorage === 'undefined') return;
    const current = this.getConfig();
    const merged: SupabaseSyncConfig = {
      ...current,
      ...newConfig,
      tenantId: newConfig.tenantId?.trim() || current.tenantId || 'tenant_default',
    };
    localStorage.setItem(SUPABASE_CONFIG_KEY, JSON.stringify(merged));

    if (newConfig.deviceName) {
      this.setDeviceName(newConfig.deviceName);
    }

    if (newConfig.autoSync !== undefined) {
      this.restartAutoSyncTimer();
    }
  }

  /**
   * تهيئة عامل المزامنة التلقائية عند عودة الاتصال أو بجدولة زمنية
   */
  public initAutoSyncWorker(): void {
    if (this.initialized || typeof window === 'undefined') return;

    // استماع لعودة الاتصال
    networkMonitor.subscribe((isOnline) => {
      const config = this.getConfig();
      if (isOnline && config.autoSync && config.supabaseUrl && !this.isSyncing) {
        console.log('[SupabaseSync] Network online. Triggering cloud bi-directional sync...');
        this.performFullBiDirectionalSync().catch((err) =>
          console.warn('[SupabaseSync] Auto-sync on reconnect error:', err)
        );
      }
    });

    this.restartAutoSyncTimer();
    this.initialized = true;
  }

  private restartAutoSyncTimer(): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }

    const config = this.getConfig();
    if (config.autoSync && config.supabaseUrl) {
      const intervalMs = Math.max(10, config.syncIntervalSeconds || 30) * 1000;
      this.autoSyncTimer = setInterval(() => {
        if (!this.isSyncing && networkMonitor.isOnline()) {
          this.performFullBiDirectionalSync().catch(() => {});
        }
      }, intervalMs);
    }
  }

  /**
   * فحص الاتصال بالخادم وقياس زمن الاستجابة (Latency)
   */
  public async testConnection(): Promise<{ success: boolean; message: string; latencyMs: number }> {
    const config = this.getConfig();
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      return {
        success: false,
        message: 'يرجى إدخال رابط مشروع Supabase ومفتاح الوصول (Anon Key) أولاً.',
        latencyMs: 0,
      };
    }

    if (!networkMonitor.isOnline()) {
      return {
        success: false,
        message: 'الجهاز غير متصل بالإنترنت حالياً (Offline). تحقق من اتصال الشبكة.',
        latencyMs: 0,
      };
    }

    const startTime = performance.now();
    try {
      const cleanUrl = config.supabaseUrl.replace(/\/+$/, '');
      const testEndpoint = `${cleanUrl}/rest/v1/erp_tenants?select=id,name&id=eq.${encodeURIComponent(config.tenantId)}&limit=1`;

      const res = await fetch(testEndpoint, {
        method: 'GET',
        headers: {
          apikey: config.supabaseAnonKey,
          Authorization: `Bearer ${config.supabaseAnonKey}`,
          'Content-Type': 'application/json',
          'x-tenant-id': config.tenantId,
          'x-device-id': config.deviceId,
        },
      });

      const latencyMs = Math.round(performance.now() - startTime);

      if (res.ok) {
        const data = await res.json();
        const tenantFound = Array.isArray(data) && data.length > 0;
        return {
          success: true,
          message: tenantFound
            ? `الاتصال ناجح تماماً! تم التحقق من المؤسسة [${data[0].name || config.tenantId}] (${latencyMs}ms).`
            : `تم الاتصال بقاعدة البيانات بنجاح، لكن معرّف المؤسسة (${config.tenantId}) لم يتم تسجيله بعد بالسحابة (${latencyMs}ms). سيتم تسجيله تلقائياً.`,
          latencyMs,
        };
      }

      const errText = await res.text().catch(() => '');
      return {
        success: false,
        message: `استجاب خادم Supabase برمز الخطأ ${res.status}: ${errText.slice(0, 150) || res.statusText}`,
        latencyMs,
      };
    } catch (err: unknown) {
      const latencyMs = Math.round(performance.now() - startTime);
      const msg = err instanceof Error ? err.message : 'خطأ غير معروف';
      return {
        success: false,
        message: `تعذر الوصول لخادم Supabase: ${msg}`,
        latencyMs,
      };
    }
  }

  /**
   * تسجيل أو تحديث نبض الجهاز في السحابة (Device Heartbeat & Registration)
   */
  public async heartbeatDevice(): Promise<void> {
    const config = this.getConfig();
    if (!config.supabaseUrl || !config.supabaseAnonKey || !networkMonitor.isOnline()) return;

    try {
      const cleanUrl = config.supabaseUrl.replace(/\/+$/, '');
      const endpoint = `${cleanUrl}/rest/v1/erp_devices`;

      const devicePayload = {
        device_id: config.deviceId,
        tenant_id: config.tenantId,
        device_name: config.deviceName,
        device_type: 'WEB',
        last_pull_at: config.lastPullTimestamp,
        last_push_at: config.lastPushTimestamp,
        is_active: true,
      };

      await fetch(endpoint, {
        method: 'POST',
        headers: {
          apikey: config.supabaseAnonKey,
          Authorization: `Bearer ${config.supabaseAnonKey}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
          'x-tenant-id': config.tenantId,
          'x-device-id': config.deviceId,
        },
        body: JSON.stringify(devicePayload),
      });
    } catch {
      // إخفاق نبض الجهاز غير معطل لعمليات المزامنة الأساسية
    }
  }

  /**
   * رفع حركات طابور Outbox إلى Supabase مع ضمان عدم التكرار (Push Outbox)
   */
  public async pushOutboxToSupabase(): Promise<{ pushed: number; failed: number; errors: string[] }> {
    const config = this.getConfig();
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      return { pushed: 0, failed: 0, errors: ['إعدادات خادم Supabase غير مكتملة'] };
    }

    if (!networkMonitor.isOnline()) {
      return { pushed: 0, failed: 0, errors: ['الجهاز غير متصل بالإنترنت'] };
    }

    const cleanUrl = config.supabaseUrl.replace(/\/+$/, '');
    const items = await syncQueueService.getReadyToSyncItems(25);
    if (items.length === 0) {
      return { pushed: 0, failed: 0, errors: [] };
    }

    let pushed = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const item of items) {
      await syncQueueService.markSyncing([item.id]);

      try {
        const tableMap: Record<OutboxQueueItem['entityType'], string> = {
          BRANCH: 'erp_branches',
          PRODUCT: 'erp_products',
          PARTY: 'erp_parties',
          INVOICE: 'erp_invoices',
          JOURNAL_ENTRY: 'erp_journal_entries',
          VOUCHER: 'erp_payment_vouchers',
          AMANAT: 'erp_amanat_items',
          CASHBOX: 'erp_cash_boxes',
          ACCOUNT: 'erp_accounts',
        };

        const targetTable = tableMap[item.entityType as OutboxQueueItem['entityType']];
        if (!targetTable) {
          throw new Error(`نوع السجل غير مدعوم في السحابة: ${item.entityType}`);
        }

        const endpoint = `${cleanUrl}/rest/v1/${targetTable}`;
        const transformedPayload = this.transformPayloadForSupabase(item, config.tenantId);

        // إرسال السجل إلى جدول الأعمال في Supabase مع دمج التكرارات عبر المفتاح الأساسي (tenant_id, id)
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            apikey: config.supabaseAnonKey,
            Authorization: `Bearer ${config.supabaseAnonKey}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=representation',
            'x-tenant-id': config.tenantId,
            'x-device-id': config.deviceId,
            'x-idempotency-key': item.idempotencyKey,
          },
          body: JSON.stringify(transformedPayload),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(`خادم Supabase (${res.status}): ${errText.slice(0, 200) || res.statusText}`);
        }

        // توثيق نجاح الحركة في جدول منع التكرار (Idempotency Log) على السحابة
        try {
          await fetch(`${cleanUrl}/rest/v1/erp_outbox_sync_log`, {
            method: 'POST',
            headers: {
              apikey: config.supabaseAnonKey,
              Authorization: `Bearer ${config.supabaseAnonKey}`,
              'Content-Type': 'application/json',
              Prefer: 'resolution=ignore-duplicates',
              'x-tenant-id': config.tenantId,
              'x-device-id': config.deviceId,
            },
            body: JSON.stringify({
              tenant_id: config.tenantId,
              device_id: config.deviceId,
              idempotency_key: item.idempotencyKey,
              entity_type: item.entityType,
              entity_id: item.entityId,
              action: item.action,
              status: 'PROCESSED',
            }),
          });
        } catch {
          // استمرار حتى لو كان سجل منع التكرار موجوداً مسبقاً
        }

        // تم تأكيد الحفظ بنجاح من الخادم -> تحديث حالة السجل المحلي إلى SYNCED
        await syncQueueService.markSynced(item.id);
        pushed++;
      } catch (err: unknown) {
        failed++;
        const msg = err instanceof Error ? err.message : 'خطأ غير متوقع';
        errors.push(`السجل [${item.entityType}:${item.entityId}]: ${msg}`);
        await syncQueueService.markFailed(item.id, msg);
      }
    }

    if (pushed > 0) {
      this.saveConfig({ lastPushTimestamp: new Date().toISOString() });
    }

    return { pushed, failed, errors };
  }

  /**
   * تحويل حمولة البيانات المحلية لتناسب أعمدة وتسميات PostgreSQL في Supabase
   */
  private transformPayloadForSupabase(item: OutboxQueueItem, tenantId: string): Record<string, unknown> {
    const raw = item.payload as Record<string, unknown>;

    switch (item.entityType) {
      case 'BRANCH': {
        const b = raw as unknown as Branch;
        return {
          id: b.id,
          tenant_id: tenantId,
          code: b.code || 'BR01',
          name_ar: b.nameAr || 'فرع',
          is_main: Boolean(b.isMain),
          address: b.address || null,
          phone: b.phone || null,
          is_active: Boolean(b.active ?? true),
        };
      }

      case 'PRODUCT': {
        const p = raw as unknown as Product;
        return {
          id: p.id,
          tenant_id: tenantId,
          activity_id: p.activityId,
          code: p.code,
          name_ar: p.nameAr,
          category: p.category || '',
          unit: p.unit || 'حبه',
          cost_price: p.purchasePrice || 0,
          selling_price: p.sellPrice || 0,
          stock_quantity: p.currentStock || 0,
          min_limit: p.minStockAlert || 0,
          barcode: p.barcode || null,
          oem_number: p.oemNumber || null,
          batches_data: p.batches || [],
          is_active: true,
        };
      }

      case 'PARTY': {
        const c = raw as unknown as Party;
        return {
          id: c.id,
          tenant_id: tenantId,
          type: c.type,
          name_ar: c.nameAr,
          phone: c.phone || '',
          address: c.address || null,
          tax_number: c.taxNumber || null,
          balance: c.balance || 0,
          credit_limit: c.creditLimit || 0,
          notes: c.notes || null,
        };
      }

      case 'INVOICE': {
        const inv = raw as unknown as Invoice;
        return {
          id: inv.id,
          tenant_id: tenantId,
          invoice_number: inv.invoiceNumber,
          type: inv.type,
          activity_id: inv.activityId,
          party_id: inv.partyId || null,
          party_name: inv.partyName || 'نقدي',
          date: inv.date,
          items: inv.items || [],
          subtotal: inv.subtotal || 0,
          discount: inv.discount || 0,
          tax: inv.tax || 0,
          total: inv.total || 0,
          paid_amount: inv.paidAmount || 0,
          payment_method: inv.paymentMethod || 'CASH',
          cash_box_id: inv.cashBoxId || null,
          journal_entry_id: inv.journalEntryId || null,
          is_posted: inv.isPosted ?? true,
          notes: inv.notes || null,
        };
      }

      case 'JOURNAL_ENTRY': {
        const j = raw as unknown as JournalEntry;
        const lines = j.lines || [];
        const totalDebit = lines.reduce((sum, l) => sum + (Number(l.debit) || 0), 0);
        const totalCredit = lines.reduce((sum, l) => sum + (Number(l.credit) || 0), 0);

        return {
          id: j.id,
          tenant_id: tenantId,
          entry_number: j.entryNumber,
          date: j.date,
          description: j.description || '',
          status: j.status || 'POSTED',
          cost_center_id: j.costCenterId || null,
          reference_type: j.referenceType || null,
          reference_id: j.referenceId || null,
          lines: lines,
          total_debit: totalDebit,
          total_credit: totalCredit,
        };
      }

      case 'VOUCHER': {
        const v = raw as unknown as PaymentVoucher;
        return {
          id: v.id,
          tenant_id: tenantId,
          voucher_number: v.voucherNumber,
          type: v.type,
          date: v.date,
          amount: v.amount || 0,
          cash_box_id: v.cashBoxId,
          party_id: v.partyId || null,
          party_name: v.partyName || '',
          account_code: v.accountCode,
          description: v.description || '',
          cost_center_id: v.costCenterId,
          journal_entry_id: v.journalEntryId || null,
        };
      }

      case 'AMANAT': {
        const a = raw as unknown as AmanatRecord;
        return {
          id: a.id,
          tenant_id: tenantId,
          record_number: a.recordNumber,
          type: a.type,
          depositor_name: a.depositorName,
          depositor_phone: a.depositorPhone,
          status: a.status,
          received_date: a.receivedDate,
          expected_return_date: a.expectedReturnDate || null,
          amount: a.amount || 0,
          currency: 'YER',
          cash_box_id: a.cashBoxId || null,
          item_description: a.itemDescription || null,
          serial_number: a.itemSerial || null,
          received_by: a.receivedBy,
          recipient_signature_name: a.recipientSignatureName || null,
          notes: a.notes || null,
          journal_entry_id: a.journalEntryId || null,
        };
      }

      default:
        return {
          ...raw,
          id: item.entityId,
          tenant_id: tenantId,
        };
    }
  }

  /**
   * تنزيل التحديثات السحابية للأجهزة الأخرى (Pull Delta Changes)
   * يضمن عدم استبدال أي سجل محلي لديه تعديلات معلقة في طابور Outbox
   */
  public async pullDeltaFromSupabase(): Promise<{
    pulled: number;
    conflicts: number;
    errors: string[];
  }> {
    const config = this.getConfig();
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      return { pulled: 0, conflicts: 0, errors: ['إعدادات خادم Supabase غير مكتملة'] };
    }

    if (!networkMonitor.isOnline()) {
      return { pulled: 0, conflicts: 0, errors: ['الجهاز غير متصل بالإنترنت'] };
    }

    const cleanUrl = config.supabaseUrl.replace(/\/+$/, '');
    let pulledCount = 0;
    let conflictsCount = 0;
    const errors: string[] = [];

    // استعلام التغييرات منذ آخر عملية تنزيل ناجحة
    const timestampFilter = config.lastPullTimestamp
      ? `&updated_at=gt.${encodeURIComponent(config.lastPullTimestamp)}`
      : '';

    const tablesToPull = [
      { name: 'erp_branches', entityType: 'BRANCH' },
      { name: 'erp_products', entityType: 'PRODUCT' },
      { name: 'erp_parties', entityType: 'PARTY' },
      { name: 'erp_invoices', entityType: 'INVOICE' },
      { name: 'erp_journal_entries', entityType: 'JOURNAL_ENTRY' },
      { name: 'erp_payment_vouchers', entityType: 'VOUCHER' },
      { name: 'erp_amanat_items', entityType: 'AMANAT' },
    ];

    // جلب معرفات السجلات التي لديها حركات معلقة في الـ Outbox المحلي لمنع الكتابة فوقها
    const pendingOutboxItems = await db.outbox
      .where('status')
      .anyOf(['PENDING', 'SYNCING'])
      .toArray();
    const pendingEntityIds = new Set(pendingOutboxItems.map((o) => `${o.entityType}:${o.entityId}`));

    for (const table of tablesToPull) {
      try {
        const url = `${cleanUrl}/rest/v1/${table.name}?tenant_id=eq.${encodeURIComponent(config.tenantId)}${timestampFilter}&order=updated_at.asc&limit=100`;

        const res = await fetch(url, {
          method: 'GET',
          headers: {
            apikey: config.supabaseAnonKey,
            Authorization: `Bearer ${config.supabaseAnonKey}`,
            'Content-Type': 'application/json',
            'x-tenant-id': config.tenantId,
            'x-device-id': config.deviceId,
          },
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          errors.push(`فشل جلب جدول ${table.name} (${res.status}): ${errText.slice(0, 100)}`);
          continue;
        }

        const remoteRows = await res.json();
        if (!Array.isArray(remoteRows) || remoteRows.length === 0) continue;

        for (const row of remoteRows) {
          const entityKey = `${table.entityType}:${row.id}`;

          // فحص التعارض: إذا كان السجل المحلي قيد التعديل محلياً ولم يُرفع بعد، نمنع استبداله
          if (pendingEntityIds.has(entityKey)) {
            conflictsCount++;
            console.warn(`[SupabaseSync] Conflict detected on ${entityKey}: Local edits pending. Preserving local record.`);
            continue;
          }

          // تطبيق التعديل السحابي مباشرة في قاعدة Dexie المحلية بالمعرّف الأصلي الثابت
          await this.applyRemoteRowToLocalDexie(table.entityType, row);
          pulledCount++;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'خطأ غير معروف';
        errors.push(`جدول ${table.name}: ${msg}`);
      }
    }

    if (errors.length === 0) {
      this.saveConfig({ lastPullTimestamp: new Date().toISOString() });
    }

    return { pulled: pulledCount, conflicts: conflictsCount, errors };
  }

  /**
   * إدراج السجل الوارد من السحابة إلى جداول Dexie المحلية دون تغيير UUID
   */
  private async applyRemoteRowToLocalDexie(entityType: string, row: Record<string, unknown>): Promise<void> {
    switch (entityType) {
      case 'BRANCH': {
        const branch: Branch = {
          id: String(row.id),
          code: String(row.code || 'BR01'),
          nameAr: String(row.name_ar || 'فرع'),
          isMain: Boolean(row.is_main),
          address: row.address ? String(row.address) : undefined,
          phone: row.phone ? String(row.phone) : undefined,
          active: Boolean(row.is_active ?? true),
          createdAt: String(row.created_at || new Date().toISOString()),
        };
        await db.branches.put(branch);
        break;
      }

      case 'PRODUCT': {
        const product: Product = {
          id: String(row.id),
          activityId: (row.activity_id as any) || 'pharmacy',
          code: String(row.code),
          nameAr: String(row.name_ar),
          category: String(row.category || ''),
          unit: String(row.unit || 'حبه'),
          purchasePrice: Number(row.cost_price || 0),
          sellPrice: Number(row.selling_price || 0),
          currentStock: Number(row.stock_quantity || 0),
          minStockAlert: Number(row.min_limit || 0),
          barcode: row.barcode ? String(row.barcode) : undefined,
          oemNumber: row.oem_number ? String(row.oem_number) : undefined,
          batches: Array.isArray(row.batches_data) ? (row.batches_data as any) : [],
        };
        await db.products.put(product);
        break;
      }

      case 'PARTY': {
        const party: Party = {
          id: String(row.id),
          type: (row.type as any) || 'CUSTOMER',
          nameAr: String(row.name_ar),
          phone: String(row.phone || ''),
          address: row.address ? String(row.address) : undefined,
          taxNumber: row.tax_number ? String(row.tax_number) : undefined,
          balance: Number(row.balance || 0),
          creditLimit: row.credit_limit ? Number(row.credit_limit) : undefined,
          notes: row.notes ? String(row.notes) : undefined,
        };
        await db.parties.put(party);
        break;
      }

      case 'INVOICE': {
        const invoice: Invoice = {
          id: String(row.id),
          invoiceNumber: String(row.invoice_number),
          type: (row.type as any) || 'SALE',
          activityId: (row.activity_id as any) || 'pharmacy',
          partyId: row.party_id ? String(row.party_id) : undefined,
          partyName: String(row.party_name || 'عميل نقدي'),
          date: String(row.date),
          items: Array.isArray(row.items) ? (row.items as any) : [],
          subtotal: Number(row.subtotal || 0),
          discount: Number(row.discount || 0),
          tax: Number(row.tax || 0),
          total: Number(row.total || 0),
          paidAmount: Number(row.paid_amount || 0),
          paymentMethod: (row.payment_method as any) || 'CASH',
          cashBoxId: String(row.cash_box_id || 'box_main'),
          journalEntryId: row.journal_entry_id ? String(row.journal_entry_id) : undefined,
          isPosted: row.is_posted !== false,
          notes: row.notes ? String(row.notes) : undefined,
        };
        await db.invoices.put(invoice);
        break;
      }

      case 'JOURNAL_ENTRY': {
        const entry: JournalEntry = {
          id: String(row.id),
          entryNumber: String(row.entry_number),
          date: String(row.date),
          description: String(row.description || ''),
          status: (row.status as any) || 'POSTED',
          costCenterId: (row.cost_center_id as any) || 'cc_pharmacy',
          referenceType: (row.reference_type as any) || undefined,
          referenceId: row.reference_id ? String(row.reference_id) : undefined,
          lines: Array.isArray(row.lines) ? (row.lines as any) : [],
          isAutoGenerated: false,
        };
        await db.journalEntries.put(entry);
        break;
      }

      case 'VOUCHER': {
        const voucher: PaymentVoucher = {
          id: String(row.id),
          voucherNumber: String(row.voucher_number),
          type: (row.type as any) || 'RECEIPT',
          date: String(row.date),
          amount: Number(row.amount || 0),
          cashBoxId: String(row.cash_box_id),
          partyId: row.party_id ? String(row.party_id) : undefined,
          partyName: String(row.party_name || ''),
          accountCode: String(row.account_code),
          description: String(row.description || ''),
          costCenterId: (row.cost_center_id as any) || 'cc_pharmacy',
          journalEntryId: row.journal_entry_id ? String(row.journal_entry_id) : undefined,
        };
        await db.vouchers.put(voucher);
        break;
      }

      case 'AMANAT': {
        const amanat: AmanatRecord = {
          id: String(row.id),
          recordNumber: String(row.record_number),
          type: (row.type as any) || 'CASH',
          depositorName: String(row.depositor_name),
          depositorPhone: String(row.depositor_phone),
          status: (row.status as any) || 'HELD',
          receivedDate: String(row.received_date),
          expectedReturnDate: row.expected_return_date ? String(row.expected_return_date) : undefined,
          amount: Number(row.amount || 0),
          cashBoxId: row.cash_box_id ? String(row.cash_box_id) : undefined,
          itemDescription: row.item_description ? String(row.item_description) : undefined,
          itemSerial: row.serial_number ? String(row.serial_number) : undefined,
          receivedBy: String(row.received_by || 'المسؤول'),
          recipientSignatureName: row.recipient_signature_name ? String(row.recipient_signature_name) : undefined,
          notes: row.notes ? String(row.notes) : undefined,
          journalEntryId: row.journal_entry_id ? String(row.journal_entry_id) : undefined,
        };
        await db.amanatRecords.put(amanat);
        break;
      }
    }
  }

  /**
   * تشغيل المزامنة الشاملة ثنائية الاتجاه (Push Outbox + Pull Delta + Heartbeat)
   */
  public async performFullBiDirectionalSync(): Promise<CloudSyncResult> {
    if (this.isSyncing) {
      return {
        pushedCount: 0,
        pulledCount: 0,
        conflictsCount: 0,
        errors: ['عملية المزامنة قيد التشغيل بالفعل'],
        durationMs: 0,
        timestamp: new Date().toISOString(),
      };
    }

    this.isSyncing = true;
    const startTime = performance.now();
    const result: CloudSyncResult = {
      pushedCount: 0,
      pulledCount: 0,
      conflictsCount: 0,
      errors: [],
      durationMs: 0,
      timestamp: new Date().toISOString(),
    };

    try {
      // 1. تسجيل نبض الجهاز
      await this.heartbeatDevice();

      // 2. رفع الحركات المحلية أولاً (Outbox Push)
      const pushRes = await this.pushOutboxToSupabase();
      result.pushedCount = pushRes.pushed;
      result.errors.push(...pushRes.errors);

      // 3. تنزيل التحديثات السحابية للأجهزة الأخرى (Delta Pull)
      const pullRes = await this.pullDeltaFromSupabase();
      result.pulledCount = pullRes.pulled;
      result.conflictsCount = pullRes.conflicts;
      result.errors.push(...pullRes.errors);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'خطأ أثناء المزامنة';
      result.errors.push(msg);
    } finally {
      result.durationMs = Math.round(performance.now() - startTime);
      this.isSyncing = false;
    }

    return result;
  }

  public isBusy(): boolean {
    return this.isSyncing;
  }
}

export const supabaseSync = new SupabaseSyncService();
