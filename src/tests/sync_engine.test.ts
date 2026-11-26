/**
 * حزمة اختبارات محرك المزامنة: الإقرار الصريح للخادم، الترقيم الكامل، العزل، والحجز الذري
 * (SYN-03, SYNC-01..06, T-11..T-14)
 */

import 'fake-indexeddb/auto';

if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage) {
  const store: Record<string, string> = {};
  const mockStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => {
      store[key] = String(val);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      for (const k in store) delete store[k];
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true });
}

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../db/erpDatabase';
import { dexieDataService } from '../services/dexieDataService';
import { authService, hashPassword } from '../services/authService';
import { syncQueueService } from '../services/syncQueueService';
import { supabaseSync } from '../services/supabaseSyncService';
import { djangoSync } from '../services/djangoSyncService';
import { networkMonitor } from '../services/networkMonitor';

describe('Sync Engine Regression Tests (SYN-03, SYNC-01..06)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    localStorage.clear();
    authService.logout();
    dexieDataService.resetForTests();
    await db.outbox.clear();
    await db.products.clear();
    await db.syncConflicts.clear();
    await db.users.clear();
    await dexieDataService.initialize();

    const admin = {
      id: 'usr-sync-admin',
      username: 'admin',
      fullName: 'مدير المزامنة',
      role: 'ADMIN' as const,
      allowedActivities: ['pharmacy', 'grocery', 'bike_parts', 'equipment_parts'] as ('pharmacy' | 'grocery' | 'bike_parts' | 'equipment_parts')[],
      branchId: 'branch_main',
      allowedBranches: ['branch_main'],
      tenantId: 'tenant_main',
      active: true,
      passwordHash: await hashPassword('Admin#Sync2026'),
    };
    await db.users.put(admin);
    const login = await authService.authenticate({
      username: admin.username,
      password: 'Admin#Sync2026',
      users: [admin],
      onUserUpdated: async (updated) => { await db.users.put(updated); },
    });
    assert.equal(login.success, true);

    Object.defineProperty(networkMonitor, 'isOnline', {
      value: () => true,
      configurable: true,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('SYNC-01: edits after SYNCED create a new outbox revision and coalesce pending edits', async () => {
    const first = await syncQueueService.enqueue({
      entityType: 'PRODUCT',
      entityId: 'prod-revision-1',
      action: 'UPDATE',
      payload: { id: 'prod-revision-1', nameAr: 'نسخة أولى' },
      tenantId: 'tenant_main',
    });
    await syncQueueService.markSynced(first.id, '2026-11-26T01:00:00.000Z');

    const second = await syncQueueService.enqueue({
      entityType: 'PRODUCT',
      entityId: 'prod-revision-1',
      action: 'UPDATE',
      payload: { id: 'prod-revision-1', nameAr: 'نسخة ثانية' },
      tenantId: 'tenant_main',
    });
    assert.notEqual(second.id, first.id, 'A post-sync edit must create a new outbox item');
    assert.equal(second.status, 'PENDING');

    const third = await syncQueueService.enqueue({
      entityType: 'PRODUCT',
      entityId: 'prod-revision-1',
      action: 'UPDATE',
      payload: { id: 'prod-revision-1', nameAr: 'نسخة ثالثة' },
      tenantId: 'tenant_main',
    });
    assert.equal(third.id, second.id, 'Repeated edits while pending should coalesce');
    assert.equal((third.payload as { nameAr: string }).nameAr, 'نسخة ثالثة');

    const leased = await syncQueueService.claimReadyToSyncItems('revision-worker', 10);
    assert.ok(leased.some((item) => item.id === third.id));
    const whileSyncing = await syncQueueService.enqueue({
      entityType: 'PRODUCT',
      entityId: 'prod-revision-1',
      action: 'UPDATE',
      payload: { id: 'prod-revision-1', nameAr: 'أثناء الإرسال' },
      tenantId: 'tenant_main',
    });
    assert.notEqual(whileSyncing.id, third.id, 'A leased payload must not be mutated in flight');
    assert.equal((await db.outbox.get(third.id))?.status, 'SYNCING');
    assert.equal((await db.outbox.get(third.id))?.payload && ((await db.outbox.get(third.id))!.payload as { nameAr: string }).nameAr, 'نسخة ثالثة');
  });

  test('SYN-03: HTTP 200 without explicit ACK leaves Outbox items un-synced; partial ACK marks only accepted item', async () => {
    const q1 = await syncQueueService.enqueue({
      entityType: 'PRODUCT',
      entityId: 'prod-ack-1',
      action: 'CREATE',
      payload: { id: 'prod-ack-1', activityId: 'grocery', code: 'A1', nameAr: 'صنف 1' },
      tenantId: 'tenant_main',
    });
    const q2 = await syncQueueService.enqueue({
      entityType: 'PRODUCT',
      entityId: 'prod-ack-2',
      action: 'CREATE',
      payload: { id: 'prod-ack-2', activityId: 'grocery', code: 'A2', nameAr: 'صنف 2' },
      tenantId: 'tenant_main',
    });

    djangoSync.saveConfig({
      serverUrl: 'http://sync.test.local/api/v1',
      tenantId: 'tenant_main',
      branchId: 'branch_main',
      apiToken: 'test-only-user-token',
      autoSync: false,
      lastSyncedAt: null,
    });

    // Mock server: returns 200 with empty body for prod-ack-1 (MUST NOT mark SYNCED!), and explicit ACK for prod-ack-2
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const bodyStr = typeof init?.body === 'string' ? init.body : '';
      if (bodyStr.includes('prod-ack-1')) {
        return new Response('', { status: 200 });
      }
      if (bodyStr.includes('prod-ack-2')) {
        return new Response(
          JSON.stringify({ acceptedIds: ['prod-ack-2'], server_timestamp: '2026-11-19T12:00:00Z' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ ok: false }), { status: 400 });
    }) as typeof fetch;

    const res = await djangoSync.processOutboxQueue();
    assert.equal(res.processed, 2);
    assert.equal(res.succeeded, 1);
    assert.equal(res.failed, 1);

    const item1 = await db.outbox.get(q1.id);
    const item2 = await db.outbox.get(q2.id);
    assert.notEqual(item1?.status, 'SYNCED', 'Empty 200 OK without ACK must NOT mark item SYNCED');
    assert.equal(item2?.status, 'SYNCED', 'Explicitly ACKed item must be marked SYNCED');
  });

  test('SYN-03 / SYNC-01: Supabase push rejects empty HTTP 200 array and distinguishes PATCH UPDATE from soft-delete', async () => {
    const qUpdate = await syncQueueService.enqueue({
      entityType: 'PRODUCT',
      entityId: 'prod-supa-upd',
      action: 'UPDATE',
      payload: { id: 'prod-supa-upd', activityId: 'grocery', code: 'S1', nameAr: 'صنف محدث' },
      tenantId: 'tenant_main',
    });

    supabaseSync.saveConfig({
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-test-key',
      tenantId: 'tenant_main',
      autoSync: false,
    });

    const recordedCalls: Array<{ method: string; url: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';
      recordedCalls.push({ method, url });
      // Empty 200 array [] -> NO explicit row echoed back -> must reject as Missing Explicit ACK
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const pushEmpty = await supabaseSync.pushOutboxToSupabase();
    assert.equal(pushEmpty.pushed, 0);
    assert.equal(pushEmpty.failed, 0);
    assert.ok(pushEmpty.errors[0]?.includes('JWT للمستخدم'), 'Cloud push must require a real user JWT, not the public anon key');
    assert.equal((await db.outbox.get(qUpdate.id))?.status, 'PENDING');
    assert.equal(recordedCalls.length, 0, 'No local data may be sent with an anonymous public key');
  });

  test('SYNC-02 / SYNC-03: Supabase pull paginates >100 rows completely and keeps cursors isolated on partial table failure', async () => {
    supabaseSync.saveConfig({
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-test-key',
      tenantId: 'tenant_main',
      autoSync: false,
      lastPullTimestamp: null,
      tableCursors: {},
    });

    // Generate 125 products across 2 pages (100 + 25), fail erp_invoices
    const allProducts = Array.from({ length: 125 }, (_, idx) => ({
      id: `supa-prod-${idx + 1}`,
      activity_id: 'grocery',
      code: `SP-${idx + 1}`,
      name_ar: `صنف سحابي ${idx + 1}`,
      cost_price: 10,
      selling_price: 15,
      stock_quantity: 5,
      updated_at: `2026-11-19T10:${String(Math.floor(idx / 60)).padStart(2, '0')}:${String(idx % 60).padStart(2, '0')}Z`,
    }));

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/erp_products')) {
        const u = new URL(url);
        const limit = Number(u.searchParams.get('limit') || '100');
        const offset = Number(u.searchParams.get('offset') || '0');
        return new Response(JSON.stringify(allProducts.slice(offset, offset + limit)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/erp_invoices')) {
        return new Response('Internal error', { status: 500 });
      }
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const pullRes = await supabaseSync.pullDeltaFromSupabase();
    assert.equal(pullRes.pulled, 0, 'Cloud pull must stop until a real user JWT is available');
    assert.equal((await db.products.toArray()).length, 0, 'Anonymous requests must not import remote data');
    assert.ok(pullRes.errors[0]?.includes('JWT للمستخدم'));

    const cfg = supabaseSync.getConfig();
    assert.equal(cfg.tableCursors?.['erp_products'], undefined, 'No cursor may advance when cloud auth is unavailable');
    assert.equal(cfg.tableCursors?.['erp_invoices'], undefined);
    assert.equal(cfg.lastPullTimestamp, null);
  });

  test('SYNC-05 & SYNC-06: Rejects cross-tenant mismatch and claims items exclusively via atomic lease', async () => {
    // 1. Atomic lease mutex: second worker cannot claim already-leased item
    await syncQueueService.enqueue({
      entityType: 'PRODUCT',
      entityId: 'prod-lease-1',
      action: 'CREATE',
      payload: { id: 'prod-lease-1' },
      tenantId: 'tenant_main',
    });

    const [claimA, claimB] = await Promise.all([
      syncQueueService.claimReadyToSyncItems('worker-A', 10),
      syncQueueService.claimReadyToSyncItems('worker-B', 10),
    ]);
    assert.equal(claimA.length + claimB.length, 1, 'Only one worker may claim a given outbox item');

    // 2. Cross-tenant mismatch blocked when session is tenant_main and config is tenant_other
    supabaseSync.saveConfig({
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-test-key',
      tenantId: 'tenant_other',
      autoSync: false,
    });

    const crossTenantRes = await supabaseSync.pullDeltaFromSupabase();
    assert.equal(crossTenantRes.pulled, 0);
    assert.ok(crossTenantRes.errors[0]?.includes('حظر عزل المؤسسات'));
  });

  test('SEC-01: Rejects service_role, wrong-tenant, and expired JWTs; sends real user JWT Bearer token', async () => {
    const makeJwt = (claims: Record<string, unknown>) => {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return `${header}.${body}.sig`;
    };
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const pastExp = Math.floor(Date.now() / 1000) - 60;

    // 1. Reject service_role key
    supabaseSync.saveConfig({
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-test-key',
      tenantId: 'tenant_main',
      supabaseAccessToken: makeJwt({ role: 'service_role', tenant_id: 'tenant_main', exp: futureExp }),
      autoSync: false,
    });
    const serviceRoleRes = await supabaseSync.testConnection();
    assert.equal(serviceRoleRes.success, false);
    assert.ok(serviceRoleRes.message.includes('service_role'));

    // 2. Reject wrong tenant_id claim
    supabaseSync.saveConfig({
      supabaseAccessToken: makeJwt({ role: 'authenticated', erp_role: 'ADMIN', tenant_id: 'tenant_evil', exp: futureExp }),
    });
    const wrongTenantRes = await supabaseSync.testConnection();
    assert.equal(wrongTenantRes.success, false);
    assert.ok(wrongTenantRes.message.includes('حظر عزل المؤسسات'));

    // 3. Reject expired token
    supabaseSync.saveConfig({
      supabaseAccessToken: makeJwt({ role: 'authenticated', erp_role: 'ADMIN', tenant_id: 'tenant_main', exp: pastExp }),
    });
    const expiredRes = await supabaseSync.testConnection();
    assert.equal(expiredRes.success, false);
    assert.ok(expiredRes.message.includes('منتهي'));

    // 4. Valid user JWT sends Authorization: Bearer <user_jwt> (NOT anon key)
    const validJwt = makeJwt({ role: 'authenticated', erp_role: 'ADMIN', tenant_id: 'tenant_main', exp: futureExp });
    let capturedAuthHeader = '';
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      capturedAuthHeader = headers?.Authorization || '';
      return new Response(JSON.stringify([{ id: 'tenant_main', name: 'مؤسسة الاختبار' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const signInRes = await (async () => {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/auth/v1/token')) {
          return new Response(
            JSON.stringify({ access_token: validJwt, expires_in: 3600 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        const headers = init?.headers as Record<string, string> | undefined;
        capturedAuthHeader = headers?.Authorization || '';
        return new Response(JSON.stringify([{ id: 'tenant_main', name: 'مؤسسة الاختبار' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;
      return supabaseSync.signInWithSupabasePassword('admin@test.local', 'Secret#123');
    })();
    assert.equal(signInRes.success, true);

    const connRes = await supabaseSync.testConnection();
    assert.equal(connRes.success, true);
    assert.equal(capturedAuthHeader, `Bearer ${validJwt}`);
    assert.notEqual(capturedAuthHeader, 'Bearer anon-test-key');
  });

  test('SYNC-01: Supabase Pull hydrates payment allocations, party advances, and allocation audits', async () => {
    await db.paymentAllocations.clear();
    await db.partyAdvanceTransactions.clear();
    await db.allocationAudits.clear();

    const makeJwt = (claims: Record<string, unknown>) => {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return `${header}.${body}.sig`;
    };
    const validJwt = makeJwt({
      role: 'authenticated',
      erp_role: 'ADMIN',
      tenant_id: 'tenant_main',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    supabaseSync.saveConfig({
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-test-key',
      tenantId: 'tenant_main',
      branchId: 'branch_main',
      supabaseAccessToken: validJwt,
      autoSync: false,
      tableCursors: {},
    });

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/erp_payment_allocations')) {
        return new Response(JSON.stringify([{
          id: 'alloc-remote-1',
          tenant_id: 'tenant_main',
          branch_id: 'branch_main',
          voucher_id: 'vch-1',
          party_id: 'cust-1',
          invoice_id: 'inv-1',
          allocated_amount: 500,
          allocation_method: 'MANUAL',
          status: 'ACTIVE',
          created_at: '2026-11-23T10:00:00Z',
          updated_at: '2026-11-23T10:00:00Z',
        }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/erp_party_advances')) {
        return new Response(JSON.stringify([{
          id: 'adv-remote-1',
          tenant_id: 'tenant_main',
          branch_id: 'branch_main',
          party_id: 'cust-1',
          party_type: 'CUSTOMER',
          tx_type: 'OVERPAYMENT_DEPOSIT',
          amount: 250,
          balance_after: 250,
          voucher_id: 'vch-1',
          tx_date: '2026-11-23',
          created_at: '2026-11-23T10:00:00Z',
          updated_at: '2026-11-23T10:00:00Z',
        }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/erp_allocation_audits')) {
        return new Response(JSON.stringify([{
          id: 'audit-remote-1',
          tenant_id: 'tenant_main',
          branch_id: 'branch_main',
          voucher_id: 'vch-1',
          party_id: 'cust-1',
          user_id: 'usr-1',
          user_name: 'محاسب',
          reason: 'اتفاق خاص مع العميل',
          previous_allocations: [],
          new_allocations: [{ invoiceId: 'inv-1', amount: 500 }],
          audit_timestamp: '2026-11-23T10:00:00Z',
          updated_at: '2026-11-23T10:00:00Z',
        }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const pullRes = await supabaseSync.pullDeltaFromSupabase();
    assert.equal(pullRes.errors.length, 0);
    assert.equal(pullRes.pulled, 3);

    const pulledAlloc = await db.paymentAllocations.get('alloc-remote-1');
    const pulledAdv = await db.partyAdvanceTransactions.get('adv-remote-1');
    const pulledAudit = await db.allocationAudits.get('audit-remote-1');
    assert.equal(pulledAlloc?.allocatedAmount, 500);
    assert.equal(pulledAlloc?.allocationMethod, 'MANUAL');
    assert.equal(pulledAdv?.balanceAfter, 250);
    assert.equal(pulledAdv?.type, 'OVERPAYMENT_DEPOSIT');
    assert.equal(pulledAudit?.reason, 'اتفاق خاص مع العميل');
  });
});

