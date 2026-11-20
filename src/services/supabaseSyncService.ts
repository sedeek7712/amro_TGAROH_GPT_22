/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * محرك مزامنة السحابة وتعدد الأجهزة وعزل المؤسسات
 * Supabase & PostgreSQL Multi-Device Bi-Directional Sync Service
 *
 * الإصلاحات المطبقة:
 * - SYNC-01 & SYN-03: التمييز بين CREATE/UPDATE/DELETE وعدم اعتماد HTTP 2xx دون إقرار صريح (Explicit Server ACK).
 * - SYNC-02: ترقيم الصفحات الكامل (Full Pagination Loop) عند السحب التفاضلي.
 * - SYNC-03: مؤشرات مزامنة مستقلة لكل جدول (tableCursors) لا تتقدم عند فشل الجدول.
 * - SYNC-04: شمول الحسابات (ACCOUNT) والصناديق (CASHBOX) في Pull و Push.
 * - SYNC-05: التحقق من عزل المؤسسة وربطها بالجلسة الموثقة.
 * - SYNC-06: حجز عناصر Outbox ذرياً عبر claimReadyToSyncItems.
 * - CFG-01: استخدام العملة المركزية المعتمدة بدلاً من العملة الثابتة.
 */

import { db } from '../db/erpDatabase';
import { syncQueueService } from './syncQueueService';
import { networkMonitor } from './networkMonitor';
import { authService } from './authService';
import { getActiveCurrencyConfig } from '../config/currency';
import {
  SupabaseSyncConfig,
  CloudSyncResult,
  OutboxQueueItem,
  Account,
  CashBox,
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

  public getConfig(): SupabaseSyncConfig {
    const deviceId = this.getOrCreateDeviceId();
    const deviceName = this.getDeviceName();
    const activeTenant = authService.getActiveTenantIdSync() || '';

    const defaultConfig: SupabaseSyncConfig = {
      supabaseUrl: '',
      supabaseAnonKey: '',
      tenantId: activeTenant,
      deviceId,
      deviceName,
      autoSync: false,
      lastPullTimestamp: null,
      lastPushTimestamp: null,
      tableCursors: {},
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
        deviceId,
        tableCursors: parsed.tableCursors || {},
      };
    } catch {
      return defaultConfig;
    }
  }

  public saveConfig(newConfig: Partial<SupabaseSyncConfig>): void {
    if (typeof localStorage === 'undefined') return;
    const current = this.getConfig();
    const merged: SupabaseSyncConfig = {
      ...current,
      ...newConfig,
      tenantId: newConfig.tenantId?.trim() || current.tenantId || '',
      tableCursors: newConfig.tableCursors ?? current.tableCursors ?? {},
    };
    localStorage.setItem(SUPABASE_CONFIG_KEY, JSON.stringify(merged));

    if (newConfig.deviceName) {
      this.setDeviceName(newConfig.deviceName);
    }

    if (newConfig.autoSync !== undefined) {
      this.restartAutoSyncTimer();
    }
  }

  public initAutoSyncWorker(): void {
    if (this.initialized || typeof window === 'undefined') return;

    networkMonitor.subscribe((isOnline) => {
      const config = this.getConfig();
      if (isOnline && config.autoSync && config.supabaseUrl && !this.isSyncing) {
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
   * التحقق من تطابق معرف المؤسسة مع الجلسة المصادق عليها (SYNC-05)
   */
  private resolveEffectiveTenant(config: SupabaseSyncConfig): { ok: boolean; tenantId: string; error?: string } {
    const session = authService.getCurrentSessionSync();
    const authTenant = authService.getActiveTenantIdSync()?.trim();
    const configured = config.tenantId?.trim();
    if (!session || !authTenant) {
      return { ok: false, tenantId: '', error: 'المزامنة السحابية متوقفة: يلزم تسجيل دخول موثق مرتبط بمؤسسة.' };
    }
    if (configured && configured !== authTenant) {
      return {
        ok: false,
        tenantId: authTenant,
        error: `حظر عزل المؤسسات: المؤسسة المضبوطة (${configured}) لا تطابق مؤسسة الجلسة المصادق عليها (${authTenant}).`,
      };
    }
    // المفتاح العام ليس JWT لمستخدم ولا يحمل مطالبات المؤسسة والدور المطلوبة بواسطة سياسات قاعدة البيانات.
    // لا يوجد حالياً تكامل مصادقة سحابي يوفر JWT مستخدم؛ لا نرسل بيانات محلية بهوية مجهولة.
    return {
      ok: false,
      tenantId: authTenant,
      error: 'المزامنة السحابية معطلة بأمان: يلزم ربط مصادقة سحابية حقيقية وإرسال JWT للمستخدم؛ المفتاح العام وحده لا يكفي.',
    };
  }

  private resolveEffectiveBranch(config: SupabaseSyncConfig): { ok: boolean; branchId: string; error?: string } {
    const session = authService.getCurrentSessionSync();
    const branchId = config.branchId?.trim() || session?.branchId?.trim() || '';
    if (!session || !branchId) return { ok: false, branchId: '', error: 'لا يوجد فرع موثق للمزامنة السحابية.' };
    if (session.role !== 'ADMIN' && !(session.allowedBranches || []).includes(branchId)) {
      return { ok: false, branchId: '', error: 'فرع المزامنة السحابية غير مصرح به للمستخدم الحالي.' };
    }
    return { ok: true, branchId };
  }

  /**
   * التحقق الصارم من وجود إقرار قبول صريح من خادم Supabase (SYN-03 & SYNC-01)
   */
  private isExplicitServerAck(
    respBody: unknown,
    item: OutboxQueueItem
  ): { accepted: boolean; serverTimestamp?: string } {
    if (Array.isArray(respBody)) {
      if (respBody.length === 0) return { accepted: false };
      const matched = respBody.find((row) => {
        if (!row || typeof row !== 'object') return false;
        const r = row as Record<string, unknown>;
        const pk = item.entityType === 'ACCOUNT' ? r.code ?? r.id : r.id;
        return pk === undefined || String(pk) === item.entityId;
      });
      if (!matched) return { accepted: false };
      const m = matched as Record<string, unknown>;
      return {
        accepted: true,
        serverTimestamp: typeof m.updated_at === 'string' ? m.updated_at : undefined,
      };
    }

    if (respBody && typeof respBody === 'object') {
      const obj = respBody as Record<string, unknown>;
      if (obj.accepted === true || obj.status === 'ACCEPTED' || obj.status === 'PROCESSED') {
        return {
          accepted: true,
          serverTimestamp:
            typeof obj.processed_at === 'string'
              ? obj.processed_at
              : typeof obj.server_timestamp === 'string'
              ? obj.server_timestamp
              : undefined,
        };
      }
      if (Array.isArray(obj.ackKeys) && obj.ackKeys.includes(item.idempotencyKey)) {
        return { accepted: true };
      }
      if (Array.isArray(obj.acceptedIds) && obj.acceptedIds.includes(item.entityId)) {
        return { accepted: true };
      }
      const pk = item.entityType === 'ACCOUNT' ? obj.code ?? obj.id : obj.id;
      if (pk !== undefined && String(pk) === item.entityId) {
        return {
          accepted: true,
          serverTimestamp: typeof obj.updated_at === 'string' ? obj.updated_at : undefined,
        };
      }
    }

    return { accepted: false };
  }

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

    const tenantResolution = this.resolveEffectiveTenant(config);
    if (!tenantResolution.ok) {
      return {
        success: false,
        message: tenantResolution.error || 'خطأ في تطابق المؤسسة.',
        latencyMs: 0,
      };
    }

    const startTime = performance.now();
    try {
      const cleanUrl = config.supabaseUrl.replace(/\/+$/, '');
      const testEndpoint = `${cleanUrl}/rest/v1/erp_tenants?select=id,name&id=eq.${encodeURIComponent(
        tenantResolution.tenantId
      )}&limit=1`;

      const res = await fetch(testEndpoint, {
        method: 'GET',
        headers: {
          apikey: config.supabaseAnonKey,
          Authorization: `Bearer ${config.supabaseAnonKey}`,
          'Content-Type': 'application/json',
          'x-tenant-id': tenantResolution.tenantId,
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
            ? `الاتصال ناجح تماماً! تم التحقق من المؤسسة [${data[0].name || tenantResolution.tenantId}] (${latencyMs}ms).`
            : `تم الاتصال بالخادم، لكن معرّف المؤسسة (${tenantResolution.tenantId}) غير مسجل بعد (${latencyMs}ms).`,
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

  public async heartbeatDevice(): Promise<void> {
    const config = this.getConfig();
    if (!config.supabaseUrl || !config.supabaseAnonKey || !networkMonitor.isOnline()) return;

    const tenantResolution = this.resolveEffectiveTenant(config);
    if (!tenantResolution.ok) return;
    const branchResolution = this.resolveEffectiveBranch(config);
    if (!branchResolution.ok) return;

    try {
      const cleanUrl = config.supabaseUrl.replace(/\/+$/, '');
      const endpoint = `${cleanUrl}/rest/v1/erp_devices`;

      const devicePayload = {
        device_id: config.deviceId,
        tenant_id: tenantResolution.tenantId,
        branch_id: branchResolution.branchId,
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
          'x-tenant-id': tenantResolution.tenantId,
          'x-device-id': config.deviceId,
        },
        body: JSON.stringify(devicePayload),
      });
    } catch {
      // نبض الجهاز اختياري ولا يعطل المزامنة
    }
  }

  /**
   * رفع حركات طابور Outbox إلى Supabase مع حجز ذري وإقرار صريح وتفريق CREATE/UPDATE/DELETE
   */
  public async pushOutboxToSupabase(): Promise<{ pushed: number; failed: number; errors: string[] }> {
    const config = this.getConfig();
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      return { pushed: 0, failed: 0, errors: ['إعدادات خادم Supabase غير مكتملة'] };
    }

    if (!networkMonitor.isOnline()) {
      return { pushed: 0, failed: 0, errors: ['الجهاز غير متصل بالإنترنت'] };
    }

    const tenantResolution = this.resolveEffectiveTenant(config);
    if (!tenantResolution.ok) {
      return { pushed: 0, failed: 0, errors: [tenantResolution.error!] };
    }
    const effectiveTenantId = tenantResolution.tenantId;
    const branchResolution = this.resolveEffectiveBranch(config);
    if (!branchResolution.ok) return { pushed: 0, failed: 0, errors: [branchResolution.error || 'فرع غير مصرح به'] };

    const cleanUrl = config.supabaseUrl.replace(/\/+$/, '');
    const items = await syncQueueService.claimReadyToSyncItems(config.deviceId, 25);
    if (items.length === 0) {
      return { pushed: 0, failed: 0, errors: [] };
    }

    let pushed = 0;
    let failed = 0;
    const errors: string[] = [];

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

    const immutableFinancialTypes = new Set<OutboxQueueItem['entityType']>([
      'INVOICE',
      'JOURNAL_ENTRY',
      'VOUCHER',
      'AMANAT',
    ]);

    for (const item of items) {
      try {
        const targetTable = tableMap[item.entityType];
        if (!targetTable) {
          throw new Error(`نوع السجل غير مدعوم في السحابة: ${item.entityType}`);
        }

        const itemTenant = item.tenantId?.trim() || '';
        const itemBranchId = item.branchId?.trim() || branchResolution.branchId;
        if (itemTenant !== effectiveTenantId) {
          throw new Error(
            `حظر عزل المؤسسات: السجل (${item.entityId}) ينتمي للمؤسسة (${itemTenant}) وليس (${effectiveTenantId}).`
          );
        }

        const session = authService.getCurrentSessionSync();
        if (!session || (session.role !== 'ADMIN' && !(session.allowedBranches || []).includes(itemBranchId))) {
          throw new Error('حظر عزل الفروع: عنصر المزامنة تابع لفرع غير مصرح به.');
        }
        const pkColumn = item.entityType === 'ACCOUNT' ? 'code' : 'id';
        let method: 'POST' | 'PATCH' = 'POST';
        let endpoint = `${cleanUrl}/rest/v1/${targetTable}`;
        let preferHeader = 'resolution=merge-duplicates,return=representation';
        let requestBody: Record<string, unknown>;

        if (item.action === 'DELETE') {
          if (immutableFinancialTypes.has(item.entityType)) {
            await syncQueueService.markFailed(
              item.id,
              `ممنوع حذف السجل المالي المرحّل (${item.entityType})؛ يجب استخدام القيد العكسي.`,
              true
            );
            failed++;
            errors.push(`رفض حذف ${item.entityType}:${item.entityId}`);
            continue;
          }

          method = 'PATCH';
          endpoint = `${cleanUrl}/rest/v1/${targetTable}?${pkColumn}=eq.${encodeURIComponent(
            item.entityId
          )}&tenant_id=eq.${encodeURIComponent(effectiveTenantId)}`;
          preferHeader = 'return=representation';
          requestBody =
            item.entityType === 'PARTY' || item.entityType === 'ACCOUNT'
              ? { is_deleted: true }
              : { is_deleted: true, is_active: false };
        } else if (item.action === 'UPDATE') {
          method = 'PATCH';
          endpoint = `${cleanUrl}/rest/v1/${targetTable}?${pkColumn}=eq.${encodeURIComponent(
            item.entityId
          )}&tenant_id=eq.${encodeURIComponent(effectiveTenantId)}`;
          preferHeader = 'return=representation';
          requestBody = this.transformPayloadForSupabase(item, effectiveTenantId);
        } else {
          method = 'POST';
          requestBody = this.transformPayloadForSupabase(item, effectiveTenantId);
        }

        const res = await fetch(endpoint, {
          method,
          headers: {
            apikey: config.supabaseAnonKey,
            Authorization: `Bearer ${config.supabaseAnonKey}`,
            'Content-Type': 'application/json',
            Prefer: preferHeader,
            'x-tenant-id': effectiveTenantId,
            'x-device-id': config.deviceId,
            'x-idempotency-key': item.idempotencyKey,
          },
          body: JSON.stringify(requestBody),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(`خادم Supabase (${res.status}): ${errText.slice(0, 200) || res.statusText}`);
        }

        // عدم قبول HTTP 2xx الفارغ كإثبات نجاح — التحقق الإلزامي من وجود إقرار صريح (SYN-03 / SYNC-01)
        const rawText = await res.text().catch(() => '');
        let parsedBody: unknown = null;
        if (rawText && rawText.trim().length > 0) {
          try {
            parsedBody = JSON.parse(rawText);
          } catch {
            parsedBody = null;
          }
        }

        const ackCheck = this.isExplicitServerAck(parsedBody, item);
        if (!ackCheck.accepted) {
          throw new Error(
            'لم يُعد الخادم إقراراً صريحاً بقبول العملية (Missing Explicit Server ACK)، تبقى العملية معلقة في Outbox.'
          );
        }

        // توثيق في سجل منع التكرار السحابي
        try {
          await fetch(`${cleanUrl}/rest/v1/erp_outbox_sync_log`, {
            method: 'POST',
            headers: {
              apikey: config.supabaseAnonKey,
              Authorization: `Bearer ${config.supabaseAnonKey}`,
              'Content-Type': 'application/json',
              Prefer: 'resolution=ignore-duplicates',
              'x-tenant-id': effectiveTenantId,
              'x-device-id': config.deviceId,
            },
            body: JSON.stringify({
              tenant_id: effectiveTenantId,
              device_id: config.deviceId,
              idempotency_key: item.idempotencyKey,
              entity_type: item.entityType,
              entity_id: item.entityId,
              action: item.action,
              status: 'PROCESSED',
            }),
          });
        } catch {
          // عدم تعطيل التأكيد الأساسي إذا كان سجل Idempotency موجوداً مسبقاً
        }

        await syncQueueService.markSynced(item.id, ackCheck.serverTimestamp);
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

  private transformPayloadForSupabase(item: OutboxQueueItem, tenantId: string): Record<string, unknown> {
    const raw = item.payload as Record<string, unknown>;
    const defaultBranchId = item.branchId || 'branch_main';
    const activeCurrencyCode = getActiveCurrencyConfig().code;

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
          is_deleted: false,
        };
      }

      case 'ACCOUNT': {
        const acc = raw as unknown as Account;
        return {
          code: acc.code,
          tenant_id: tenantId,
          name_ar: acc.nameAr,
          type: acc.type,
          parent_code: acc.parentCode || null,
          is_leaf: Boolean(acc.isLeaf),
          cost_center_id: acc.costCenterId || null,
          balance: acc.balance || 0,
          is_deleted: false,
        };
      }

      case 'CASHBOX': {
        const box = raw as unknown as CashBox;
        return {
          id: box.id,
          tenant_id: tenantId,
          branch_id: box.branchId || defaultBranchId,
          code: box.code,
          name_ar: box.nameAr,
          account_code: box.accountCode,
          balance: box.balance || 0,
          is_default: Boolean(box.isDefault),
          is_active: true,
          is_deleted: false,
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
          is_deleted: false,
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
          is_deleted: false,
        };
      }

      case 'INVOICE': {
        const inv = raw as unknown as Invoice;
        return {
          id: inv.id,
          tenant_id: tenantId,
          branch_id: inv.branchId || defaultBranchId,
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
          is_deleted: false,
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
          branch_id: j.branchId || defaultBranchId,
          entry_number: j.entryNumber,
          date: j.date,
          description: j.description || '',
          status: j.status || 'POSTED',
          cost_center_id: j.costCenterId || null,
          reference_type: j.referenceType || null,
          reference_id: j.referenceId || null,
          reversed_entry_id: j.reversedEntryId || null,
          reversal_reason: j.reversalReason || null,
          lines,
          total_debit: totalDebit,
          total_credit: totalCredit,
          is_deleted: false,
        };
      }

      case 'VOUCHER': {
        const v = raw as unknown as PaymentVoucher;
        return {
          id: v.id,
          tenant_id: tenantId,
          branch_id: v.branchId || defaultBranchId,
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
          is_deleted: false,
        };
      }

      case 'AMANAT': {
        const a = raw as unknown as AmanatRecord;
        return {
          id: a.id,
          tenant_id: tenantId,
          branch_id: a.branchId || defaultBranchId,
          record_number: a.recordNumber,
          type: a.type,
          depositor_name: a.depositorName,
          depositor_phone: a.depositorPhone,
          status: a.status,
          received_date: a.receivedDate,
          expected_return_date: a.expectedReturnDate || null,
          amount: a.amount || 0,
          currency: activeCurrencyCode,
          cash_box_id: a.cashBoxId || null,
          item_description: a.itemDescription || null,
          serial_number: a.itemSerial || null,
          received_by: a.receivedBy,
          recipient_signature_name: a.recipientSignatureName || null,
          notes: a.notes || null,
          journal_entry_id: a.journalEntryId || null,
          is_deleted: false,
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
   * تنزيل التحديثات السحابية مع ترقيم صفحات كامل (SYNC-02) ومؤشرات مستقلة لكل جدول (SYNC-03) وشمول الحسابات والصناديق (SYNC-04)
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

    const tenantResolution = this.resolveEffectiveTenant(config);
    if (!tenantResolution.ok) {
      return { pulled: 0, conflicts: 0, errors: [tenantResolution.error!] };
    }
    const effectiveTenantId = tenantResolution.tenantId;
    const branchResolution = this.resolveEffectiveBranch(config);
    if (!branchResolution.ok) return { pulled: 0, conflicts: 0, errors: [branchResolution.error || 'فرع غير مصرح به'] };

    const cleanUrl = config.supabaseUrl.replace(/\/+$/, '');
    let pulledCount = 0;
    let conflictsCount = 0;
    const errors: string[] = [];

    const tablesToPull: Array<{ name: string; entityType: OutboxQueueItem['entityType']; pkField: 'id' | 'code' }> = [
      { name: 'erp_branches', entityType: 'BRANCH', pkField: 'id' },
      { name: 'erp_accounts', entityType: 'ACCOUNT', pkField: 'code' },
      { name: 'erp_cash_boxes', entityType: 'CASHBOX', pkField: 'id' },
      { name: 'erp_products', entityType: 'PRODUCT', pkField: 'id' },
      { name: 'erp_parties', entityType: 'PARTY', pkField: 'id' },
      { name: 'erp_invoices', entityType: 'INVOICE', pkField: 'id' },
      { name: 'erp_journal_entries', entityType: 'JOURNAL_ENTRY', pkField: 'id' },
      { name: 'erp_payment_vouchers', entityType: 'VOUCHER', pkField: 'id' },
      { name: 'erp_amanat_items', entityType: 'AMANAT', pkField: 'id' },
    ];

    const pendingOutboxItems = await db.outbox
      .where('status')
      .anyOf(['PENDING', 'SYNCING'])
      .toArray();
    const pendingMap = new Map<string, OutboxQueueItem>();
    pendingOutboxItems.forEach((o) => pendingMap.set(`${o.entityType}:${o.entityId}`, o));

    const nextCursors: Record<string, string> = { ...(config.tableCursors || {}) };
    const pageSize = 100;

    for (const table of tablesToPull) {
      const tableSince = nextCursors[table.name] || null;
      const timestampFilter = tableSince
        ? `&updated_at=gt.${encodeURIComponent(tableSince)}`
        : '';

      let offset = 0;
      let tableSucceeded = true;
      let maxUpdatedAtInTable: string | null = tableSince;

      try {
        while (true) {
          const branchScopedTables = new Set(['erp_branches', 'erp_devices', 'erp_cash_boxes', 'erp_invoices', 'erp_journal_entries', 'erp_payment_vouchers', 'erp_amanat_items']);
          const branchFilter = branchScopedTables.has(table.name)
            ? `&branch_id=eq.${encodeURIComponent(branchResolution.branchId)}`
            : '';
          const url = `${cleanUrl}/rest/v1/${table.name}?tenant_id=eq.${encodeURIComponent(
            effectiveTenantId
          )}${branchFilter}${timestampFilter}&order=updated_at.asc&limit=${pageSize}&offset=${offset}`;

          const res = await fetch(url, {
            method: 'GET',
            headers: {
              apikey: config.supabaseAnonKey,
              Authorization: `Bearer ${config.supabaseAnonKey}`,
              'Content-Type': 'application/json',
              'x-tenant-id': effectiveTenantId,
              'x-device-id': config.deviceId,
            },
          });

          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            errors.push(`فشل جلب جدول ${table.name} (${res.status}): ${errText.slice(0, 100)}`);
            tableSucceeded = false;
            break;
          }

          const remoteRows = await res.json();
          if (!Array.isArray(remoteRows)) {
            errors.push(`استجابة غير صالحة من جدول ${table.name}`);
            tableSucceeded = false;
            break;
          }

          if (remoteRows.length === 0) break;

          for (const row of remoteRows) {
            const rec = row as Record<string, unknown>;
            const pk = String(rec[table.pkField] || rec.id || '');
            if (!pk) continue;

            const entityKey = `${table.entityType}:${pk}`;
            const pendingItem = pendingMap.get(entityKey);
            if (pendingItem) {
              conflictsCount++;
              await syncQueueService.recordConflict({
                tenantId: effectiveTenantId,
                branchId: typeof rec.branch_id === 'string' ? rec.branch_id : undefined,
                entityType: table.entityType,
                entityId: pk,
                localPayload: pendingItem.payload,
                remotePayload: rec,
                notes: `تعارض سحب سحابي: السجل (${entityKey}) لديه تعديل محلي معلق في Outbox.`,
              });
              continue;
            }

            await this.applyRemoteRowToLocalDexie(table.entityType, rec);
            pulledCount++;

            if (typeof rec.updated_at === 'string') {
              if (!maxUpdatedAtInTable || rec.updated_at > maxUpdatedAtInTable) {
                maxUpdatedAtInTable = rec.updated_at;
              }
            }
          }

          if (remoteRows.length < pageSize) break;
          offset += pageSize;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'خطأ غير معروف';
        errors.push(`جدول ${table.name}: ${msg}`);
        tableSucceeded = false;
      }

      if (tableSucceeded && maxUpdatedAtInTable) {
        nextCursors[table.name] = maxUpdatedAtInTable;
      }
    }

    const updatedConfig: Partial<SupabaseSyncConfig> = {
      tableCursors: nextCursors,
    };
    if (errors.length === 0) {
      updatedConfig.lastPullTimestamp = new Date().toISOString();
    }
    this.saveConfig(updatedConfig);

    return { pulled: pulledCount, conflicts: conflictsCount, errors };
  }

  private async applyRemoteRowToLocalDexie(
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
        const branch: Branch = {
          id,
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

      case 'ACCOUNT': {
        const code = String(row.code);
        if (isDeleted) {
          await db.accounts.delete(code);
          return;
        }
        const account: Account = {
          code,
          nameAr: String(row.name_ar || ''),
          type: (row.type as Account['type']) || 'ASSET',
          parentCode: row.parent_code ? String(row.parent_code) : null,
          isLeaf: row.is_leaf !== false,
          balance: Number(row.balance || 0),
          costCenterId: row.cost_center_id ? (row.cost_center_id as Account['costCenterId']) : undefined,
        };
        await db.accounts.put(account);
        break;
      }

      case 'CASHBOX': {
        const id = String(row.id);
        if (isDeleted) {
          await db.cashBoxes.delete(id);
          return;
        }
        const cashBox: CashBox = {
          id,
          code: String(row.code || 'CASH'),
          nameAr: String(row.name_ar || ''),
          accountCode: String(row.account_code || '1101'),
          balance: Number(row.balance || 0),
          isDefault: Boolean(row.is_default),
          branchId: row.branch_id ? String(row.branch_id) : 'branch_main',
        };
        await db.cashBoxes.put(cashBox);
        break;
      }

      case 'PRODUCT': {
        const id = String(row.id);
        if (isDeleted) {
          await db.products.delete(id);
          return;
        }
        const product: Product = {
          id,
          activityId: (row.activity_id as Product['activityId']) || 'pharmacy',
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
          batches: Array.isArray(row.batches_data) ? (row.batches_data as Product['batches']) : [],
        };
        await db.products.put(product);
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
          type: (row.type as Party['type']) || 'CUSTOMER',
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
          type: (row.type as Invoice['type']) || 'SALE',
          activityId: (row.activity_id as Invoice['activityId']) || 'pharmacy',
          branchId: row.branch_id ? String(row.branch_id) : undefined,
          partyId: row.party_id ? String(row.party_id) : undefined,
          partyName: String(row.party_name || 'عميل نقدي'),
          date: String(row.date),
          items: Array.isArray(row.items) ? (row.items as Invoice['items']) : [],
          subtotal: Number(row.subtotal || 0),
          discount: Number(row.discount || 0),
          tax: Number(row.tax || 0),
          total: Number(row.total || 0),
          paidAmount: Number(row.paid_amount || 0),
          paymentMethod: (row.payment_method as Invoice['paymentMethod']) || 'CASH',
          cashBoxId: String(row.cash_box_id || 'cb-1'),
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
          status: (row.status as JournalEntry['status']) || 'POSTED',
          costCenterId: (row.cost_center_id as JournalEntry['costCenterId']) || 'general',
          branchId: row.branch_id ? String(row.branch_id) : undefined,
          referenceType: (row.reference_type as JournalEntry['referenceType']) || undefined,
          referenceId: row.reference_id ? String(row.reference_id) : undefined,
          reversedEntryId: row.reversed_entry_id ? String(row.reversed_entry_id) : undefined,
          reversalReason: row.reversal_reason ? String(row.reversal_reason) : undefined,
          lines: Array.isArray(row.lines) ? (row.lines as JournalEntry['lines']) : [],
          isAutoGenerated: false,
        };
        await db.journalEntries.put(entry);
        break;
      }

      case 'VOUCHER': {
        const voucher: PaymentVoucher = {
          id: String(row.id),
          voucherNumber: String(row.voucher_number),
          type: (row.type as PaymentVoucher['type']) || 'RECEIPT',
          date: String(row.date),
          amount: Number(row.amount || 0),
          cashBoxId: String(row.cash_box_id),
          branchId: row.branch_id ? String(row.branch_id) : undefined,
          partyId: row.party_id ? String(row.party_id) : undefined,
          partyName: String(row.party_name || ''),
          accountCode: String(row.account_code),
          description: String(row.description || ''),
          costCenterId: (row.cost_center_id as PaymentVoucher['costCenterId']) || 'general',
          journalEntryId: row.journal_entry_id ? String(row.journal_entry_id) : undefined,
        };
        await db.vouchers.put(voucher);
        break;
      }

      case 'AMANAT': {
        const amanat: AmanatRecord = {
          id: String(row.id),
          branchId: row.branch_id ? String(row.branch_id) : undefined,
          recordNumber: String(row.record_number),
          type: (row.type as AmanatRecord['type']) || 'CASH',
          depositorName: String(row.depositor_name),
          depositorPhone: String(row.depositor_phone),
          status: (row.status as AmanatRecord['status']) || 'HELD',
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
      await this.heartbeatDevice();

      const pushRes = await this.pushOutboxToSupabase();
      result.pushedCount = pushRes.pushed;
      result.errors.push(...pushRes.errors);

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
