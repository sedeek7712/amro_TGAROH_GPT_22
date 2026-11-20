/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * خطافات التفاعل المباشر مع قاعدة بيانات Dexie (Live Dexie Reactive Hooks - DB-01 / DB-03)
 * تعتمد على Dexie كمصدر وحيد للحقيقة للكيانات التشغيلية دون العودة إلى localStorage عند خلو الجداول
 */

import { useState, useEffect } from 'react';
import { liveQuery } from 'dexie';
import { db } from '../db/erpDatabase';
import { dexieDataService, InitState } from '../services/dexieDataService';
import { filterAuditLogsForUser } from '../config/rbac';
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
  return useLiveDexie(
    async () => {
      if (activityId && activityId !== 'all') {
        return await db.invoices.where('activityId').equals(activityId).reverse().sortBy('date');
      }
      return await db.invoices.toCollection().reverse().sortBy('date');
    },
    [],
    [activityId]
  );
}

export function useLiveAccounts(): Account[] {
  return useLiveDexie(async () => await db.accounts.toArray(), [], []);
}

export function useLiveJournalEntries(costCenterId?: CostCenterId | 'all'): JournalEntry[] {
  return useLiveDexie(
    async () => {
      if (costCenterId && costCenterId !== 'all') {
        return await db.journalEntries
          .where('costCenterId')
          .equals(costCenterId)
          .reverse()
          .sortBy('date');
      }
      return await db.journalEntries.toCollection().reverse().sortBy('date');
    },
    [],
    [costCenterId]
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
  return useLiveDexie(async () => await db.cashBoxes.toArray(), [], []);
}

export function useLiveVouchers(): PaymentVoucher[] {
  return useLiveDexie(
    async () => await db.vouchers.toCollection().reverse().sortBy('date'),
    [],
    []
  );
}

export function useLiveAmanatRecords(): AmanatRecord[] {
  return useLiveDexie(
    async () => await db.amanatRecords.toCollection().reverse().sortBy('receivedDate'),
    [],
    []
  );
}

export function useLiveUsers(): SystemUser[] {
  return useLiveDexie(async () => await db.users.toArray(), [], []);
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
  return useLiveDexie(
    async () => {
      if (statusFilter && statusFilter !== 'all') {
        return await db.outbox
          .where('status')
          .equals(statusFilter)
          .reverse()
          .sortBy('createdAt');
      }
      return await db.outbox.toCollection().reverse().sortBy('createdAt');
    },
    [],
    [statusFilter]
  );
}

export function useLiveOutboxStats(): {
  total: number;
  pending: number;
  syncing: number;
  synced: number;
  failed: number;
} {
  return useLiveDexie(
    async () => {
      const items = await db.outbox.toArray();
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
    []
  );
}

export function useLiveConflicts(): SyncConflict[] {
  return useLiveDexie(
    async () => await db.syncConflicts.toCollection().reverse().sortBy('detectedAt'),
    [],
    []
  );
}

export function useLiveBranches(): Branch[] {
  return useLiveDexie(async () => await db.branches.toArray(), [], []);
}
