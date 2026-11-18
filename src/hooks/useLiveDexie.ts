/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * خطافات التفاعل المباشر مع قاعدة بيانات Dexie (Live Dexie Reactive Hooks)
 * تتيح لجميع شاشات ومكونات React القراءة المباشرة من IndexedDB عبر Dexie
 * مع دعم العرض الأولي الفوري (0ms Instant Render) والتحديث التفاعلي التلقائي عند أي تعديل
 */

import { useState, useEffect } from 'react';
import { liveQuery } from 'dexie';
import { db } from '../db/erpDatabase';
import { storage } from '../services/storageService';
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
} from '../types/erp';

/**
 * خطاف تجريدي لمراقبة استعلامات Dexie حياً وتحديث React State تلقائياً
 */
export function useLiveDexie<T>(
  querier: () => Promise<T> | T,
  initialValue: T,
  deps: unknown[] = []
): T {
  const [data, setData] = useState<T>(initialValue);

  useEffect(() => {
    // 1. تشغيل الاستعلام الأولي فوراً
    let isMounted = true;
    Promise.resolve(querier())
      .then((res) => {
        if (isMounted && res !== undefined && res !== null) {
          setData(res);
        }
      })
      .catch((err) => console.warn('[useLiveDexie] Initial query notice:', err));

    // 2. الاشتراك في مراقب Dexie الحي (Live Query Subscription)
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

/**
 * مراقبة الأصناف والمخزون مباشرة من Dexie
 */
export function useLiveProducts(activityId?: CommercialActivityId | 'all'): Product[] {
  const initial = storage.getProducts(activityId && activityId !== 'all' ? activityId : undefined);

  return useLiveDexie(
    async () => {
      if (activityId && activityId !== 'all') {
        const list = await db.products.where('activityId').equals(activityId).toArray();
        return list.length > 0 ? list : storage.getProducts(activityId);
      }
      const list = await db.products.toArray();
      return list.length > 0 ? list : storage.getProducts();
    },
    initial,
    [activityId]
  );
}

/**
 * مراقبة الفواتير مباشرة من Dexie
 */
export function useLiveInvoices(activityId?: CommercialActivityId | 'all'): Invoice[] {
  const initial = storage.getInvoices(activityId && activityId !== 'all' ? activityId : undefined);

  return useLiveDexie(
    async () => {
      let list: Invoice[];
      if (activityId && activityId !== 'all') {
        list = await db.invoices.where('activityId').equals(activityId).reverse().sortBy('date');
      } else {
        list = await db.invoices.toCollection().reverse().sortBy('date');
      }
      return list.length > 0 ? list : storage.getInvoices(activityId && activityId !== 'all' ? activityId : undefined);
    },
    initial,
    [activityId]
  );
}

/**
 * مراقبة دليل الحسابات وأرصدة الأستاذ مباشرة من Dexie
 */
export function useLiveAccounts(): Account[] {
  const initial = storage.getAccounts();

  return useLiveDexie(
    async () => {
      const list = await db.accounts.toArray();
      return list.length > 0 ? list : storage.getAccounts();
    },
    initial,
    []
  );
}

/**
 * مراقبة دفتر اليومية والقيود المحاسبية مباشرة من Dexie
 */
export function useLiveJournalEntries(costCenterId?: CostCenterId | 'all'): JournalEntry[] {
  const initial = storage.getJournalEntries(costCenterId && costCenterId !== 'all' ? costCenterId : undefined);

  return useLiveDexie(
    async () => {
      let list: JournalEntry[];
      if (costCenterId && costCenterId !== 'all') {
        list = await db.journalEntries.where('costCenterId').equals(costCenterId).reverse().sortBy('date');
      } else {
        list = await db.journalEntries.toCollection().reverse().sortBy('date');
      }
      return list.length > 0 ? list : storage.getJournalEntries(costCenterId && costCenterId !== 'all' ? costCenterId : undefined);
    },
    initial,
    [costCenterId]
  );
}

/**
 * مراقبة العملاء والموردين مباشرة من Dexie
 */
export function useLiveParties(type?: PartyType): Party[] {
  const initial = storage.getParties(type);

  return useLiveDexie(
    async () => {
      let list: Party[];
      if (type) {
        list = await db.parties.where('type').equals(type).toArray();
      } else {
        list = await db.parties.toArray();
      }
      return list.length > 0 ? list : storage.getParties(type);
    },
    initial,
    [type]
  );
}

/**
 * مراقبة الصناديق والبنوك مباشرة من Dexie
 */
export function useLiveCashBoxes(): CashBox[] {
  const initial = storage.getCashBoxes();

  return useLiveDexie(
    async () => {
      const list = await db.cashBoxes.toArray();
      return list.length > 0 ? list : storage.getCashBoxes();
    },
    initial,
    []
  );
}

/**
 * مراقبة سندات القبض والصرف مباشرة من Dexie
 */
export function useLiveVouchers(): PaymentVoucher[] {
  const initial = storage.getVouchers();

  return useLiveDexie(
    async () => {
      const list = await db.vouchers.toCollection().reverse().sortBy('date');
      return list.length > 0 ? list : storage.getVouchers();
    },
    initial,
    []
  );
}

/**
 * مراقبة سجلات الأمانات مباشرة من Dexie
 */
export function useLiveAmanatRecords(): AmanatRecord[] {
  const initial = storage.getAmanatRecords();

  return useLiveDexie(
    async () => {
      const list = await db.amanatRecords.toCollection().reverse().sortBy('receivedDate');
      return list.length > 0 ? list : storage.getAmanatRecords();
    },
    initial,
    []
  );
}

/**
 * مراقبة المستخدمين والصلاحيات مباشرة من Dexie
 */
export function useLiveUsers(): import('../types/erp').SystemUser[] {
  const initial = storage.getUsers();

  return useLiveDexie(
    async () => {
      const list = await db.users.toArray();
      return list.length > 0 ? list : storage.getUsers();
    },
    initial,
    []
  );
}

/**
 * مراقبة طابور الإرسال والمزامنة Outbox مباشرة من Dexie
 */
export function useLiveOutbox(statusFilter?: OutboxQueueItem['status'] | 'all'): OutboxQueueItem[] {
  return useLiveDexie(
    async () => {
      let items: OutboxQueueItem[];
      if (statusFilter && statusFilter !== 'all') {
        items = await db.outbox.where('status').equals(statusFilter).reverse().sortBy('createdAt');
      } else {
        items = await db.outbox.toCollection().reverse().sortBy('createdAt');
      }
      return items;
    },
    [],
    [statusFilter]
  );
}

/**
 * مراقبة إحصائيات طابور الإرسال حياً من Dexie
 */
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

/**
 * مراقبة سجل التعارضات المحاسبية والمخزنية حياً من Dexie
 */
export function useLiveConflicts(): SyncConflict[] {
  return useLiveDexie(
    async () => {
      return await db.syncConflicts.toCollection().reverse().sortBy('detectedAt');
    },
    [],
    []
  );
}

/**
 * مراقبة الفروع المسجلة حياً من Dexie
 */
export function useLiveBranches(): Branch[] {
  const initial = storage.getBranches();
  return useLiveDexie(
    async () => {
      const list = await db.branches.toArray();
      return list.length > 0 ? list : storage.getBranches();
    },
    initial,
    []
  );
}

