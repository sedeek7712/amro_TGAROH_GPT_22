/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * خطافات التفاعل المباشر مع قاعدة بيانات Dexie (Live Dexie Reactive Hooks - DB-01 / DB-03)
 * تعتمد على Dexie كمصدر وحيد للحقيقة للكيانات التشغيلية دون العودة إلى localStorage عند خلو الجداول
 */

import { useState, useEffect } from 'react';
import { liveQuery } from 'dexie';
import { db } from '../db/erpDatabase';
import { dexieDataService, InitState } from '../services/dexieDataService';
import { authService } from '../services/authService';
import { filterAuditLogsForUser, filterRecordsByBranchScope, getAuthorizedBranchIds } from '../config/rbac';
import {
  Product,
  CommercialActivityId,
  Invoice,
  Account,
  JournalEntry,
  CostCenterId,
  Party,
  PartyType,
  CashBox,
  PaymentVoucher,
  AmanatRecord,
  OutboxQueueItem,
  SyncConflict,
  Branch,
  SystemUser,
  SystemAuditLog,
} from '../types/erp';

function currentActorKey(actor: SystemUser | null): string {
  return actor
    ? [actor.id, actor.tenantId || '', actor.role, actor.branchId || '', ...(actor.allowedBranches || [])].join('|')
    : 'anonymous';
}

function scopeBranchRows<T extends { branchId?: string; tenantId?: string }>(
  records: T[],
  actor: SystemUser | null,
  allowUnauthenticated = false
): T[] {
  if (!actor) return allowUnauthenticated ? records : [];
  const tenantId = actor.tenantId?.trim();
  if (!tenantId) return [];
  const tenantRows = records.filter((row) => !row.tenantId || row.tenantId === tenantId);
  return filterRecordsByBranchScope(tenantRows, actor);
}

export function useLiveDexie<T>(
  querier: () => Promise<T> | T,
  initialValue: T,
  deps: unknown[] = []
): T {
  const [data, setData] = useState<T>(initialValue);

  useEffect(() => {
    let isMounted = true;
    Promise.resolve(querier())
      .then((res) => {
        if (isMounted && res !== undefined && res !== null) {
          setData(res);
        }
      })
      .catch((err) => console.warn('[useLiveDexie] Initial query notice:', err));

    const observable = liveQuery(querier);
    const subscription = observable.subscribe({
      next: (val) => {
        if (isMounted && val !== undefined && val !== null) {
          setData(val);
        }
      },
      error: (err) => {
        console.warn('[useLiveDexie] Subscription notice:', err);
      },
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return data;
}

export function useDexieInitStatus(): { state: InitState; error: string | null } {
  const [status, setStatus] = useState<{ state: InitState; error: string | null }>({
    state: dexieDataService.getInitState(),
    error: dexieDataService.getInitError(),
  });

  useEffect(() => {
    const timer = setInterval(() => {
      const nextState = dexieDataService.getInitState();
      const nextError = dexieDataService.getInitError();
      setStatus((prev) =>
        prev.state === nextState && prev.error === nextError
          ? prev
          : { state: nextState, error: nextError }
      );
      if (nextState === 'READY' || nextState === 'FAILED') {
        clearInterval(timer);
      }
    }, 50);

    return () => clearInterval(timer);
  }, []);

  return status;
}

export function useLiveProducts(activityId?: CommercialActivityId | 'all'): Product[] {
  return useLiveDexie(
    async () => {
      if (activityId && activityId !== 'all') {
        return await db.products.where('activityId').equals(activityId).toArray();
      }
      return await db.products.toArray();
    },
    [],
    [activityId]
  );
}

export function useLiveInvoices(activityId?: CommercialActivityId | 'all'): Invoice[] {
  const actor = authService.getCurrentActorSync();
  return useLiveDexie(
    async () => {
      const rows = activityId && activityId !== 'all'
        ? await db.invoices.where('activityId').equals(activityId).reverse().sortBy('date')
        : await db.invoices.toCollection().reverse().sortBy('date');
      return scopeBranchRows(rows, actor);
    },
    [],
    [activityId, currentActorKey(actor)]
  );
}

export function useLiveAccounts(): Account[] {
  return useLiveDexie(async () => await db.accounts.toArray(), [], []);
}

export function useLiveJournalEntries(costCenterId?: CostCenterId | 'all'): JournalEntry[] {
  const actor = authService.getCurrentActorSync();
  return useLiveDexie(
    async () => {
      const rows = costCenterId && costCenterId !== 'all'
        ? await db.journalEntries.where('costCenterId').equals(costCenterId).reverse().sortBy('date')
        : await db.journalEntries.toCollection().reverse().sortBy('date');
      return scopeBranchRows(rows, actor);
    },
    [],
    [costCenterId, currentActorKey(actor)]
  );
}

export function useLiveParties(type?: PartyType): Party[] {
  return useLiveDexie(
    async () => {
      if (type) {
        return await db.parties.where('type').equals(type).toArray();
      }
      return await db.parties.toArray();
    },
    [],
    [type]
  );
}

export function useLiveCashBoxes(): CashBox[] {
  const actor = authService.getCurrentActorSync();
  return useLiveDexie(async () => scopeBranchRows(await db.cashBoxes.toArray(), actor), [], [currentActorKey(actor)]);
}

export function useLiveVouchers(): PaymentVoucher[] {
  const actor = authService.getCurrentActorSync();
  return useLiveDexie(
    async () => scopeBranchRows(await db.vouchers.toCollection().reverse().sortBy('date'), actor),
    [],
    [currentActorKey(actor)]
  );
}

export function useLiveAmanatRecords(): AmanatRecord[] {
  const actor = authService.getCurrentActorSync();
  return useLiveDexie(
    async () => scopeBranchRows(await db.amanatRecords.toCollection().reverse().sortBy('receivedDate'), actor),
    [],
    [currentActorKey(actor)]
  );
}

export function useLiveUsers(): SystemUser[] {
  const actor = authService.getCurrentActorSync();
  return useLiveDexie(
    async () => scopeBranchRows(await db.users.toArray(), actor, true),
    [],
    [currentActorKey(actor)]
  );
}

export function useLiveAuditLogs(currentUser?: SystemUser | null): SystemAuditLog[] {
  return useLiveDexie(
    async () => {
      const allLogs = await db.auditLogs.toCollection().reverse().sortBy('timestamp');
      return filterAuditLogsForUser(allLogs, currentUser);
    },
    [],
    [currentUser?.id, currentUser?.role]
  );
}

export function useLiveOutbox(statusFilter?: OutboxQueueItem['status'] | 'all'): OutboxQueueItem[] {
  const actor = authService.getCurrentActorSync();
  return useLiveDexie(
    async () => {
      const rows = statusFilter && statusFilter !== 'all'
        ? await db.outbox.where('status').equals(statusFilter).reverse().sortBy('createdAt')
        : await db.outbox.toCollection().reverse().sortBy('createdAt');
      if (!actor?.tenantId) return [];
      return scopeBranchRows(rows.filter((row) => row.tenantId === actor.tenantId), actor);
    },
    [],
    [statusFilter, currentActorKey(actor)]
  );
}

export function useLiveOutboxStats(): {
  total: number;
  pending: number;
  syncing: number;
  synced: number;
  failed: number;
} {
  const actor = authService.getCurrentActorSync();
  return useLiveDexie(
    async () => {
      const allItems = await db.outbox.toArray();
      const items = actor?.tenantId
        ? scopeBranchRows(allItems.filter((row) => row.tenantId === actor.tenantId), actor)
        : [];
      const stats = { total: items.length, pending: 0, syncing: 0, synced: 0, failed: 0 };
      for (const item of items) {
        if (item.status === 'PENDING') stats.pending++;
        else if (item.status === 'SYNCING') stats.syncing++;
        else if (item.status === 'SYNCED') stats.synced++;
        else if (item.status === 'FAILED') stats.failed++;
      }
      return stats;
    },
    { total: 0, pending: 0, syncing: 0, synced: 0, failed: 0 },
    [currentActorKey(actor)]
  );
}

export function useLiveConflicts(): SyncConflict[] {
  const actor = authService.getCurrentActorSync();
  return useLiveDexie(
    async () => {
      if (!actor?.tenantId) return [];
      const rows = await db.syncConflicts.where('tenantId').equals(actor.tenantId).reverse().sortBy('detectedAt');
      return scopeBranchRows(rows, actor);
    },
    [],
    [currentActorKey(actor)]
  );
}

export function useLiveBranches(): Branch[] {
  const actor = authService.getCurrentActorSync();
  return useLiveDexie(
    async () => {
      const rows = await db.branches.toArray();
      if (!actor?.active || !actor.tenantId) return [];
      if (actor.role === 'ADMIN') return rows;
      const allowed = getAuthorizedBranchIds(actor);
      return rows.filter((branch) => allowed.has(branch.id));
    },
    [],
    [currentActorKey(actor)]
  );
}
