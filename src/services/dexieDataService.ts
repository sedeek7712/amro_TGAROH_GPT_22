/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * خدمة البيانات المتقدمة عبر Dexie / IndexedDB (DexieDataService)
 * تطبق IDataService مع دعم المعاملات الذرية (ACID Transactions)
 * وعزل الأنشطة الأربعة ووحدة الأمانات وطابور Outbox المتوافق مع Django REST Framework
 */

import { db, requestPersistentStorage, migrateLegacyIndexedDbIfNeeded } from '../db/erpDatabase';
import {
  CommercialActivity,
  CommercialActivityId,
  Account,
  Product,
  ProductBatch,
  Party,
  Invoice,
  JournalEntry,
  JournalEntryLine,
  CashBox,
  PaymentVoucher,
  AmanatRecord,
  SystemUser,
  SystemAuditLog,
  CostCenterId,
  OutboxQueueItem,
  Branch,
} from '../types/erp';
import { IDataService } from './dataService';
import { OFFICIAL_ACTIVITIES, INITIAL_CHART_OF_ACCOUNTS, INITIAL_BRANCHES, storage } from './storageService';
import { syncQueueService } from './syncQueueService';

export class DexieDataService implements IDataService {
  private initialized = false;

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // 1. ترحيل البيانات القديمة إن وجدت دون فقدان أي بيانات
      await migrateLegacyIndexedDbIfNeeded();

      // 2. طلب حماية التخزين الدائم
      await requestPersistentStorage();

      // 3. استعادة السجلات العالقة بحالة SYNCING جراء انقطاع المتصفح أو الشبكة
      await syncQueueService.recoverStuckSyncingItems();

      // 3. التحقق من وجود الحسابات والأنشطة والصناديق والمستخدمين
      const accountsCount = await db.accounts.count();
      if (accountsCount === 0) {
        console.log('[DexieDataService] Seeding initial chart of accounts into IndexedDB...');
        const initialAccounts = storage.getAccounts();
        if (initialAccounts.length > 0) {
          await db.accounts.bulkPut(initialAccounts);
        } else {
          await db.accounts.bulkPut(INITIAL_CHART_OF_ACCOUNTS);
        }
      }

      const activitiesCount = await db.activities.count();
      if (activitiesCount === 0) {
        await db.activities.bulkPut(OFFICIAL_ACTIVITIES);
      }

      const cashBoxesCount = await db.cashBoxes.count();
      if (cashBoxesCount === 0) {
        const initialBoxes = storage.getCashBoxes();
        if (initialBoxes.length > 0) {
          await db.cashBoxes.bulkPut(initialBoxes);
        }
      }

      const usersCount = await db.users.count();
      if (usersCount === 0) {
        const initialUsers = storage.getUsers();
        if (initialUsers.length > 0) {
          await db.users.bulkPut(initialUsers);
        }
      }

      const branchesCount = await db.branches.count();
      if (branchesCount === 0) {
        const initialBranches = storage.getBranches();
        if (initialBranches.length > 0) {
          await db.branches.bulkPut(initialBranches);
        }
      }

      // 4. مزامنة البيانات الموجودة في التخزين المحلي إن كانت أكثر حداثة
      await this.syncFromLocalStorageIfNeeded();

      this.initialized = true;
      console.log('[DexieDataService] Initialized successfully with Dexie IndexedDB engine.');
    } catch (err) {
      console.warn('[DexieDataService] Initialization notice:', err);
      this.initialized = true;
    }
  }

  /**
   * مزامنة تكميلية للبيانات من الذاكرة المحلية إذا كانت قاعدة Dexie فارغة
   */
  private async syncFromLocalStorageIfNeeded(): Promise<void> {
    try {
      // 1. مزامنة تكاملية تضمن إدراج أي سجلات من localStorage إلى Dexie دون مسح البيانات الحالية
      const localProducts = storage.getProducts();
      if (localProducts.length > 0) {
        await db.products.bulkPut(localProducts);
      }

      const localParties = storage.getParties();
      if (localParties.length > 0) {
        await db.parties.bulkPut(localParties);
      }

      const localInvoices = storage.getInvoices();
      if (localInvoices.length > 0) {
        await db.invoices.bulkPut(localInvoices);
      }

      const localEntries = storage.getJournalEntries();
      if (localEntries.length > 0) {
        await db.journalEntries.bulkPut(localEntries);
      }

      const localAmanat = storage.getAmanatRecords();
      if (localAmanat.length > 0) {
        await db.amanatRecords.bulkPut(localAmanat);
      }

      const localBranches = storage.getBranches();
      if (localBranches.length > 0) {
        await db.branches.bulkPut(localBranches);
      }

      // 2. مزامنة بالاتجاه المعاكس: إذا كانت Dexie تحتوي على سجلات إضافية، نقوم بتحديث الذاكرة المؤقتة التزامنية
      const dexieProducts = await db.products.toArray();
      if (dexieProducts.length > localProducts.length) {
        storage.saveProducts(dexieProducts);
      }

      const dexieInvoices = await db.invoices.toArray();
      if (dexieInvoices.length > localInvoices.length) {
        storage.saveInvoices(dexieInvoices);
      }

      const dexieParties = await db.parties.toArray();
      if (dexieParties.length > localParties.length) {
        storage.saveParties(dexieParties);
      }

      const dexieBranches = await db.branches.toArray();
      if (dexieBranches.length > localBranches.length) {
        storage.saveBranches(dexieBranches);
      }
    } catch (err) {
      console.warn('[DexieDataService] Two-way reconciliation notice:', err);
    }
  }

  // --- الفروع ونقاط البيع (Multi-Branch System) ---
  public async getBranches(): Promise<Branch[]> {
    const list = await db.branches.toArray();
    return list.length > 0 ? list : storage.getBranches();
  }

  public async getBranch(id: string): Promise<Branch | undefined> {
    return await db.branches.get(id);
  }

  public async getActiveBranch(): Promise<Branch> {
    const activeId = storage.getActiveBranchId();
    const branch = await db.branches.get(activeId);
    return branch || storage.getActiveBranch();
  }

  public async setActiveBranchId(branchId: string): Promise<void> {
    storage.setActiveBranchId(branchId);
  }

  public async addBranch(branch: Branch): Promise<void> {
    if (!branch.id) branch.id = storage.generateUUID();
    await db.branches.put(branch);
    storage.addBranch(branch);
    await this.queueOutboxItem({
      entityType: 'BRANCH',
      entityId: branch.id,
      action: 'CREATE',
      payload: branch as unknown as Record<string, unknown>,
    });
    await this.logAction('إضافة فرع', `تمت إضافة الفرع: ${branch.nameAr} (${branch.code})`);
  }

  public async updateBranch(branch: Branch): Promise<void> {
    await db.branches.put(branch);
    storage.updateBranch(branch);
    await this.queueOutboxItem({
      entityType: 'BRANCH',
      entityId: branch.id,
      action: 'UPDATE',
      payload: branch as unknown as Record<string, unknown>,
    });
    await this.logAction('تعديل فرع', `تم تحديث بيانات الفرع: ${branch.nameAr}`);
  }

  public async generateBranchInvoiceNumber(type: 'INV' | 'PUR', branchCode?: string, terminalCode?: string): Promise<string> {
    return storage.generateBranchInvoiceNumber(type, branchCode, terminalCode);
  }

  public async generateBranchVoucherNumber(type: 'RCT' | 'PAY', branchCode?: string, terminalCode?: string): Promise<string> {
    return storage.generateBranchVoucherNumber(type, branchCode, terminalCode);
  }

  // --- الأنشطة التجارية الأربعة ---
  public async getActivities(): Promise<CommercialActivity[]> {
    const list = await db.activities.toArray();
    return list.length > 0 ? list : OFFICIAL_ACTIVITIES;
  }

  // --- الدليل المحاسبي ---
  public async getAccounts(): Promise<Account[]> {
    const list = await db.accounts.toArray();
    if (list.length === 0) {
      return INITIAL_CHART_OF_ACCOUNTS;
    }
    return list;
  }

  public async saveAccounts(accounts: Account[]): Promise<void> {
    await db.accounts.clear();
    await db.accounts.bulkPut(accounts);
    storage.saveAccounts(accounts);
  }

  public async updateAccountBalance(code: string, deltaBalance: number): Promise<void> {
    const acc = await db.accounts.get(code);
    if (acc) {
      acc.balance = Number((acc.balance + deltaBalance).toFixed(2));
      await db.accounts.put(acc);
      storage.updateAccountBalance(code, deltaBalance);
    }
  }

  // --- المخزون والأصناف ---
  public async getProducts(activityId?: CommercialActivityId): Promise<Product[]> {
    if (activityId) {
      return await db.products.where('activityId').equals(activityId).toArray();
    }
    return await db.products.toArray();
  }

  public async getProductById(id: string): Promise<Product | undefined> {
    return await db.products.get(id);
  }

  public async addProduct(product: Product): Promise<void> {
    if (!product.id) product.id = storage.generateUUID();
    await db.products.put(product);
    await this.queueOutboxItem({
      entityType: 'PRODUCT',
      entityId: product.id,
      action: 'CREATE',
      payload: product as unknown as Record<string, unknown>,
    });
    await this.logAction('إضافة صنف', `تمت إضافة الصنف ${product.nameAr} بكود ${product.code}`);
    storage.addProduct(product);
  }

  public async updateProduct(product: Product): Promise<void> {
    await db.products.put(product);
    await this.queueOutboxItem({
      entityType: 'PRODUCT',
      entityId: product.id,
      action: 'UPDATE',
      payload: product as unknown as Record<string, unknown>,
    });
    await this.logAction('تعديل صنف', `تم تحديث بيانات الصنف ${product.nameAr}`);
    storage.updateProduct(product);
  }

  public async deleteProduct(productId: string): Promise<void> {
    await db.products.delete(productId);
    await this.queueOutboxItem({
      entityType: 'PRODUCT',
      entityId: productId,
      action: 'DELETE',
      payload: { id: productId },
    });
    await this.logAction('حذف صنف', `تم حذف الصنف ذو المعرف ${productId}`);
    storage.deleteProduct(productId);
  }

  // --- العملاء والموردون ---
  public async getParties(type?: 'CUSTOMER' | 'SUPPLIER'): Promise<Party[]> {
    if (type) {
      return await db.parties.where('type').equals(type).toArray();
    }
    return await db.parties.toArray();
  }

  public async getPartyById(id: string): Promise<Party | undefined> {
    return await db.parties.get(id);
  }

  public async addParty(party: Party): Promise<void> {
    if (!party.id) party.id = storage.generateUUID();
    await db.parties.put(party);
    await this.queueOutboxItem({
      entityType: 'PARTY',
      entityId: party.id,
      action: 'CREATE',
      payload: party as unknown as Record<string, unknown>,
    });
    await this.logAction(`إضافة ${party.type === 'CUSTOMER' ? 'عميل' : 'مورد'}`, `تسجيل ${party.nameAr}`);
    storage.addParty(party);
  }

  public async updateParty(party: Party): Promise<void> {
    await db.parties.put(party);
    await this.queueOutboxItem({
      entityType: 'PARTY',
      entityId: party.id,
      action: 'UPDATE',
      payload: party as unknown as Record<string, unknown>,
    });
    storage.updateParty(party);
  }

  public async updatePartyBalance(partyId: string, deltaBalance: number): Promise<void> {
    const party = await db.parties.get(partyId);
    if (party) {
      party.balance = Number((party.balance + deltaBalance).toFixed(2));
      await db.parties.put(party);
      storage.updatePartyBalance(partyId, deltaBalance);
    }
  }

  // --- الفواتير ---
  public async getInvoices(activityId?: CommercialActivityId): Promise<Invoice[]> {
    if (activityId) {
      return await db.invoices.where('activityId').equals(activityId).reverse().sortBy('date');
    }
    return await db.invoices.toCollection().reverse().sortBy('date');
  }

  public async getInvoiceById(id: string): Promise<Invoice | undefined> {
    return await db.invoices.get(id);
  }

  public async addInvoice(invoice: Invoice): Promise<void> {
    if (!invoice.id) invoice.id = storage.generateUUID();
    invoice.isPosted = true;
    await db.invoices.put(invoice);
    await this.queueOutboxItem({
      entityType: 'INVOICE',
      entityId: invoice.id,
      action: 'CREATE',
      payload: invoice as unknown as Record<string, unknown>,
    });
    await this.logAction(`فاتورة ${invoice.type}`, `إصدار فاتورة رقم ${invoice.invoiceNumber} بقيمة ${invoice.total}`);
    storage.addInvoice(invoice);
  }

  // --- القيود المحاسبية ---
  public async getJournalEntries(costCenterId?: CostCenterId): Promise<JournalEntry[]> {
    if (costCenterId) {
      return await db.journalEntries.where('costCenterId').equals(costCenterId).reverse().sortBy('date');
    }
    return await db.journalEntries.toCollection().reverse().sortBy('date');
  }

  public async getJournalEntryById(id: string): Promise<JournalEntry | undefined> {
    return await db.journalEntries.get(id);
  }

  public async addJournalEntry(entry: JournalEntry): Promise<void> {
    if (!entry.id) entry.id = storage.generateUUID();
    if (!entry.status) entry.status = 'POSTED';
    await db.journalEntries.put(entry);
    await this.queueOutboxItem({
      entityType: 'JOURNAL_ENTRY',
      entityId: entry.id,
      action: 'CREATE',
      payload: entry as unknown as Record<string, unknown>,
    });
    await this.logAction('قيد محاسبي', `ترحيل القيد رقم ${entry.entryNumber}: ${entry.description}`);
    storage.addJournalEntry(entry);
  }

  public async reverseJournalEntry(originalEntryId: string, reversalReason: string): Promise<JournalEntry> {
    const res = await this.reverseJournalEntryAtomic(originalEntryId, reversalReason);
    return res;
  }

  // --- الصناديق والبنوك ---
  public async getCashBoxes(): Promise<CashBox[]> {
    const list = await db.cashBoxes.toArray();
    return list.length > 0 ? list : storage.getCashBoxes();
  }

  public async updateCashBoxBalance(id: string, deltaBalance: number): Promise<void> {
    const box = await db.cashBoxes.get(id);
    if (box) {
      box.balance = Number((box.balance + deltaBalance).toFixed(2));
      await db.cashBoxes.put(box);
      storage.updateCashBoxBalance(id, deltaBalance);
    }
  }

  // --- السندات ---
  public async getVouchers(): Promise<PaymentVoucher[]> {
    return await db.vouchers.toCollection().reverse().sortBy('date');
  }

  public async addVoucher(voucher: PaymentVoucher): Promise<void> {
    if (!voucher.id) voucher.id = storage.generateUUID();
    await db.vouchers.put(voucher);
    await this.queueOutboxItem({
      entityType: 'VOUCHER',
      entityId: voucher.id,
      action: 'CREATE',
      payload: voucher as unknown as Record<string, unknown>,
    });
    await this.logAction(`سند ${voucher.type === 'RECEIPT' ? 'قبض' : 'صرف'}`, `رقم ${voucher.voucherNumber} بمبلغ ${voucher.amount}`);
    storage.addVoucher(voucher);
  }

  // --- وحدة الأمانات المستقلة ---
  public async getAmanatRecords(): Promise<AmanatRecord[]> {
    return await db.amanatRecords.toCollection().reverse().sortBy('receivedDate');
  }

  public async getAmanatById(id: string): Promise<AmanatRecord | undefined> {
    return await db.amanatRecords.get(id);
  }

  public async addAmanatRecord(record: AmanatRecord): Promise<void> {
    if (!record.id) record.id = storage.generateUUID();
    await db.amanatRecords.put(record);
    await this.queueOutboxItem({
      entityType: 'AMANAT',
      entityId: record.id,
      action: 'CREATE',
      payload: record as unknown as Record<string, unknown>,
    });
    await this.logAction(`سند أمانة ${record.type === 'CASH' ? 'نقدية' : 'عينية'}`, `رقم ${record.recordNumber} للمودع ${record.depositorName}`);
    storage.addAmanatRecord(record);
  }

  public async updateAmanatRecord(record: AmanatRecord): Promise<void> {
    await db.amanatRecords.put(record);
    await this.queueOutboxItem({
      entityType: 'AMANAT',
      entityId: record.id,
      action: 'UPDATE',
      payload: record as unknown as Record<string, unknown>,
    });
    storage.updateAmanatRecord(record);
  }

  // --- المستخدمون وسجل التدقيق ---
  public async getUsers(): Promise<SystemUser[]> {
    const list = await db.users.toArray();
    return list.length > 0 ? list : storage.getUsers();
  }

  public async getCurrentUser(): Promise<SystemUser> {
    return storage.getCurrentUser();
  }

  public async setCurrentUser(user: SystemUser): Promise<void> {
    await storage.setCurrentUser(user);
  }

  public async getAuditLogs(): Promise<SystemAuditLog[]> {
    return await db.auditLogs.toCollection().reverse().sortBy('timestamp');
  }

  public async logAction(action: string, details: string): Promise<void> {
    const currentUser = storage.getCurrentUser();
    const log: SystemAuditLog = {
      id: storage.generateUUID(),
      timestamp: new Date().toISOString(),
      userId: currentUser.id,
      userName: currentUser.fullName,
      action,
      details,
    };
    await db.auditLogs.put(log);
    storage.logAction(action, details);
  }

  // --- طابور الإرسال Outbox ---
  public async getOutboxQueue(): Promise<OutboxQueueItem[]> {
    return await db.outbox.orderBy('createdAt').toArray();
  }

  public async queueOutboxItem(
    item: Omit<OutboxQueueItem, 'id' | 'createdAt' | 'status' | 'retryCount' | 'idempotencyKey' | 'tenantId'> & {
      idempotencyKey?: string;
      tenantId?: string;
      priority?: number;
      dependsOn?: string[];
    }
  ): Promise<void> {
    const tenantId = item.tenantId || 'tenant_default';
    const idempotencyKey =
      item.idempotencyKey || `${tenantId}_${item.entityType}_${item.entityId}_${item.action}`;

    // فحص عدم تكرار السجل المعلق
    const existing = await db.outbox
      .where('idempotencyKey')
      .equals(idempotencyKey)
      .filter((i) => i.tenantId === tenantId && (i.status === 'PENDING' || i.status === 'SYNCING'))
      .first();

    if (existing) {
      existing.payload = item.payload;
      if (item.dependsOn) existing.dependsOn = item.dependsOn;
      await db.outbox.put(existing);
      return;
    }

    let defaultPriority = 3;
    if (['ACCOUNT', 'CASHBOX'].includes(item.entityType)) defaultPriority = 1;
    else if (['PARTY', 'PRODUCT'].includes(item.entityType)) defaultPriority = 2;
    else if (['INVOICE', 'VOUCHER', 'AMANAT'].includes(item.entityType)) defaultPriority = 3;
    else if (item.entityType === 'JOURNAL_ENTRY') defaultPriority = 4;

    const queueItem: OutboxQueueItem = {
      ...item,
      tenantId,
      id: storage.generateUUID(),
      createdAt: new Date().toISOString(),
      status: 'PENDING',
      retryCount: 0,
      priority: item.priority || defaultPriority,
      idempotencyKey,
      dependsOn: item.dependsOn && item.dependsOn.length > 0 ? item.dependsOn : undefined,
    };
    await db.outbox.put(queueItem);
  }

  public async markOutboxSynced(id: string): Promise<void> {
    const item = await db.outbox.get(id);
    if (item) {
      item.status = 'SYNCED';
      item.syncedAt = new Date().toISOString();
      await db.outbox.put(item);
    }
  }

  // --- النسخ الاحتياطي والاستعادة ---
  public async exportBackupJSON(): Promise<string> {
    return storage.exportFullBackupJSON();
  }

  public async importBackupJSON(jsonContent: string): Promise<{ success: boolean; error?: string }> {
    const result = storage.importBackupJSON(jsonContent);
    if (result.success) {
      await this.syncFromLocalStorageIfNeeded();
    }
    return result;
  }

  public async resetToCleanBooks(): Promise<void> {
    await db.invoices.clear();
    await db.journalEntries.clear();
    await db.vouchers.clear();
    await db.amanatRecords.clear();
    await db.outbox.clear();
    await db.auditLogs.clear();
    storage.resetToCleanBooks();
  }

  // =========================================================================
  // المعاملات الذرية المركبة الحقيقية (ACID Multi-table Atomic Operations)
  // =========================================================================

  /**
   * إنشاء وترحيل فاتورة مبيعات ذرية:
   * 1. فحص وتحديث المخزون والتشغيلات (FEFO) مع منع بيع الأدوية المنتهية.
   * 2. توليد وفحص توازن القيد المحاسبي المزدوج.
   * 3. تحديث أرصدة الحسابات والصناديق أو ذمم العملاء.
   * 4. إدراج الفاتورة والقيد في قاعدة البيانات وطابور Outbox وسجل التدقيق.
   * يتم كل ذلك داخل معاملة IndexedDB واحدة لا تقبل التجزئة!
   */
  public async createSalesInvoiceAtomic(params: {
    invoice: Invoice;
    totalCogs: number;
    stockDeductions: Array<{ productId: string; quantity: number; batchNumber?: string }>;
  }): Promise<{ success: boolean; invoice: Invoice; journalEntry: JournalEntry }> {
    const { invoice, totalCogs, stockDeductions } = params;

    return await db.transaction(
      'rw',
      [db.invoices, db.journalEntries, db.products, db.cashBoxes, db.accounts, db.parties, db.outbox, db.auditLogs],
      async () => {
        // أ. التحقق من المخزون وتطبيق خصم التشغيلات وFEFO
        const todayStr = new Date().toISOString().split('T')[0];
        const updatedProducts: Product[] = [];

        for (const deduction of stockDeductions) {
          const product = await db.products.get(deduction.productId);
          if (!product) {
            throw new Error(`الصنف ذو المعرف ${deduction.productId} غير موجود في المستودع.`);
          }

          if (product.currentStock < deduction.quantity) {
            throw new Error(`الرصيد المتاح من الصنف (${product.nameAr}) هو ${product.currentStock} فقط، المطلوب بيعه ${deduction.quantity}.`);
          }

          if (product.batches && product.batches.length > 0) {
            if (deduction.batchNumber) {
              const batch = product.batches.find((b) => b.batchNumber === deduction.batchNumber);
              if (!batch) {
                throw new Error(`التشغيلة ${deduction.batchNumber} للصنف (${product.nameAr}) غير موجودة.`);
              }
              if (batch.expiryDate < todayStr) {
                throw new Error(`محظور تماماً بيع التشغيلة (${batch.batchNumber}) لأنها منتهية الصلاحية بتاريخ ${batch.expiryDate}!`);
              }
              if (batch.quantity < deduction.quantity) {
                throw new Error(`الكمية المتاحة في التشغيلة (${batch.batchNumber}) هي ${batch.quantity} فقط.`);
              }
              batch.quantity -= deduction.quantity;
            } else {
              // FEFO: الصرف من التشغيلة السارية الأقرب للانتهاء
              const validBatches = product.batches
                .filter((b) => b.quantity > 0 && b.expiryDate >= todayStr)
                .sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());

              const totalValidQty = validBatches.reduce((sum, b) => sum + b.quantity, 0);
              if (totalValidQty < deduction.quantity) {
                throw new Error(`لا توجد كمية سارية كافية من (${product.nameAr})! المتاح غير المنتهي هو ${totalValidQty} فقط.`);
              }

              let remainingToDeduct = deduction.quantity;
              for (const batch of validBatches) {
                if (remainingToDeduct <= 0) break;
                const deductFromThis = Math.min(batch.quantity, remainingToDeduct);
                batch.quantity -= deductFromThis;
                remainingToDeduct -= deductFromThis;
              }
            }

            product.currentStock = product.batches.reduce((sum, b) => sum + b.quantity, 0);
          } else {
            product.currentStock -= deduction.quantity;
          }

          updatedProducts.push(product);
          await db.products.put(product);
        }

        // ب. توليد القيد المحاسبي المزدوج المتوازن
        const journalLines: JournalEntryLine[] = [];
        const activityRevenueAccounts: Record<CommercialActivityId, string> = {
          pharmacy: '4101',
          grocery: '4102',
          bike_parts: '4103',
          equipment_parts: '4104',
        };
        const activityInventoryAccounts: Record<CommercialActivityId, string> = {
          pharmacy: '11041',
          grocery: '11042',
          bike_parts: '11043',
          equipment_parts: '11044',
        };
        const activityCogsAccounts: Record<CommercialActivityId, string> = {
          pharmacy: '5101',
          grocery: '5102',
          bike_parts: '5103',
          equipment_parts: '5104',
        };

        const revenueCode = activityRevenueAccounts[invoice.activityId] || '4101';
        const inventoryCode = activityInventoryAccounts[invoice.activityId] || '11041';
        const cogsCode = activityCogsAccounts[invoice.activityId] || '5101';

        // 1. الطرف المدين: الصندوق النقدي أو ذمة العميل الآجل
        if (invoice.paidAmount > 0) {
          const cashBox = (await db.cashBoxes.get(invoice.cashBoxId)) || (await db.cashBoxes.toCollection().first());
          const boxAccount = cashBox ? cashBox.accountCode : '1101';
          const boxName = cashBox ? cashBox.nameAr : 'الصندوق الرئيسي';

          journalLines.push({
            id: storage.generateUUID(),
            accountCode: boxAccount,
            accountName: boxName,
            debit: invoice.paidAmount,
            credit: 0,
            costCenterId: invoice.activityId,
            memo: `تحصيل نقدي فاتورة مبيعات ${invoice.invoiceNumber}`,
          });

          if (cashBox) {
            cashBox.balance = Number((cashBox.balance + invoice.paidAmount).toFixed(2));
            await db.cashBoxes.put(cashBox);
          }
          const acc = await db.accounts.get(boxAccount);
          if (acc) {
            acc.balance = Number((acc.balance + invoice.paidAmount).toFixed(2));
            await db.accounts.put(acc);
          }
        }

        const unpaid = Number((invoice.total - invoice.paidAmount).toFixed(2));
        if (unpaid > 0) {
          journalLines.push({
            id: storage.generateUUID(),
            accountCode: '1103',
            accountName: `العملاء والمدينون - ${invoice.partyName}`,
            debit: unpaid,
            credit: 0,
            costCenterId: invoice.activityId,
            memo: `مبيعات آجلة فاتورة ${invoice.invoiceNumber}`,
          });

          if (invoice.partyId) {
            const customer = await db.parties.get(invoice.partyId);
            if (customer) {
              customer.balance = Number((customer.balance + unpaid).toFixed(2));
              await db.parties.put(customer);
            }
          }
          const arAcc = await db.accounts.get('1103');
          if (arAcc) {
            arAcc.balance = Number((arAcc.balance + unpaid).toFixed(2));
            await db.accounts.put(arAcc);
          }
        }

        // 2. الطرف الدائن: إيرادات المبيعات
        const revAcc = await db.accounts.get(revenueCode);
        journalLines.push({
          id: storage.generateUUID(),
          accountCode: revenueCode,
          accountName: revAcc ? revAcc.nameAr : 'إيرادات المبيعات',
          debit: 0,
          credit: invoice.total,
          costCenterId: invoice.activityId,
          memo: `إيراد مبيعات فاتورة ${invoice.invoiceNumber}`,
        });
        if (revAcc) {
          revAcc.balance = Number((revAcc.balance + invoice.total).toFixed(2));
          await db.accounts.put(revAcc);
        }

        // 3. قيد تكلفة البضاعة المباعة والمخزون
        if (totalCogs > 0) {
          const cogsAcc = await db.accounts.get(cogsCode);
          journalLines.push({
            id: storage.generateUUID(),
            accountCode: cogsCode,
            accountName: cogsAcc ? cogsAcc.nameAr : 'تكلفة المبيعات',
            debit: totalCogs,
            credit: 0,
            costCenterId: invoice.activityId,
            memo: `تكلفة مبيعات فاتورة ${invoice.invoiceNumber}`,
          });
          if (cogsAcc) {
            cogsAcc.balance = Number((cogsAcc.balance + totalCogs).toFixed(2));
            await db.accounts.put(cogsAcc);
          }

          const invAcc = await db.accounts.get(inventoryCode);
          journalLines.push({
            id: storage.generateUUID(),
            accountCode: inventoryCode,
            accountName: invAcc ? invAcc.nameAr : 'المخزون السلعي',
            debit: 0,
            credit: totalCogs,
            costCenterId: invoice.activityId,
            memo: `صرف مخزون مباع فاتورة ${invoice.invoiceNumber}`,
          });
          if (invAcc) {
            invAcc.balance = Number((invAcc.balance - totalCogs).toFixed(2));
            await db.accounts.put(invAcc);
          }
        }

        // ج. فحص توازن القيد الصارم (المدين = الدائن)
        const totalDebit = journalLines.reduce((sum, l) => sum + l.debit, 0);
        const totalCredit = journalLines.reduce((sum, l) => sum + l.credit, 0);
        const diff = Math.abs(totalDebit - totalCredit);
        if (diff > 0.009) {
          throw new Error(`خطأ فادح: القيد المحاسبي غير متوازن! مدين=${totalDebit.toFixed(2)}, دائن=${totalCredit.toFixed(2)}, فارق=${diff.toFixed(2)}`);
        }

        // د. حفظ القيد والفاتورة
        const activeBranchId = invoice.branchId || storage.getActiveBranchId();
        invoice.branchId = activeBranchId;

        const entriesCount = await db.journalEntries.count();
        const entryNumber = `JV-${new Date().getFullYear()}-${String(entriesCount + 1).padStart(5, '0')}`;
        const journalEntryId = storage.generateUUID();

        const journalEntry: JournalEntry = {
          id: journalEntryId,
          entryNumber,
          date: invoice.date,
          description: `قيد مبيعات آلي للفاتورة ${invoice.invoiceNumber} - ${invoice.partyName}`,
          costCenterId: invoice.activityId,
          branchId: activeBranchId,
          lines: journalLines,
          status: 'POSTED',
          referenceType: 'INVOICE',
          referenceId: invoice.id,
          isAutoGenerated: true,
        };

        await db.journalEntries.put(journalEntry);

        invoice.journalEntryId = journalEntryId;
        invoice.isPosted = true;
        await db.invoices.put(invoice);

        // هـ. طابور Outbox وسجل التدقيق (مع التبعيات الدقيقة وحتمية منع التكرار)
        const invoiceDependencies: string[] = [];
        if (invoice.partyId) invoiceDependencies.push(invoice.partyId);
        if (invoice.items) {
          invoice.items.forEach((it) => {
            if (it.productId && !invoiceDependencies.includes(it.productId)) {
              invoiceDependencies.push(it.productId);
            }
          });
        }

        const outboxItemInvoice: OutboxQueueItem = {
          id: storage.generateUUID(),
          tenantId: 'tenant_default',
          branchId: activeBranchId,
          entityType: 'INVOICE',
          entityId: invoice.id,
          action: 'CREATE',
          payload: invoice as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 3, // P3: فواتير بعد الأطراف والأصناف
          dependsOn: invoiceDependencies.length > 0 ? invoiceDependencies : undefined,
          createdAt: new Date().toISOString(),
          idempotencyKey: `INV_SALE_${invoice.id}_${invoice.invoiceNumber}`,
        };
        await db.outbox.put(outboxItemInvoice);

        const outboxItemJournal: OutboxQueueItem = {
          id: storage.generateUUID(),
          tenantId: 'tenant_default',
          branchId: activeBranchId,
          entityType: 'JOURNAL_ENTRY',
          entityId: journalEntry.id,
          action: 'CREATE',
          payload: journalEntry as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 4, // P4: القيود المحاسبية
          dependsOn: [invoice.id], // القيد معتمد صراحة على الفاتورة
          createdAt: new Date().toISOString(),
          idempotencyKey: `JV_${journalEntry.id}_${journalEntry.entryNumber}`,
        };
        await db.outbox.put(outboxItemJournal);

        const auditLog: SystemAuditLog = {
          id: storage.generateUUID(),
          timestamp: new Date().toISOString(),
          userId: 'system',
          userName: 'نقطة البيع الذرية',
          action: 'إصدار فاتورة مبيعات ذرية',
          details: `فاتورة ${invoice.invoiceNumber} بقيمة ${invoice.total} ر.س وقيد ${journalEntry.entryNumber}`,
        };
        await db.auditLogs.put(auditLog);

        // و. مزامنة الذاكرة المؤقتة التوافقية (مع منع تكرار إدراج Outbox المزدوج)
        storage.addInvoice(invoice, true);
        storage.addJournalEntry(journalEntry, true);
        for (const p of updatedProducts) {
          storage.updateProduct(p);
        }

        return { success: true, invoice, journalEntry };
      }
    );
  }

  /**
   * إنشاء وترحيل فاتورة مشتريات ذرية:
   * 1. التحقق الإلزامي من تشغيلات وصلاحية الأدوية.
   * 2. تحديث أرصدة الأصناف والتشغيلات.
   * 3. توليد وقيد المحاسبة المزدوج المتوازن (مدين المخزون / دائن النقدية أو الموردين).
   * 4. إدراج الفاتورة والقيد وطابور Outbox وسجل التدقيق ذرياً.
   */
  public async createPurchaseInvoiceAtomic(params: {
    invoice: Invoice;
    itemsWithBatches: Array<{
      productId: string;
      quantity: number;
      costPrice: number;
      batchNumber?: string;
      expiryDate?: string;
    }>;
  }): Promise<{ success: boolean; invoice: Invoice; journalEntry: JournalEntry }> {
    const { invoice, itemsWithBatches } = params;

    return await db.transaction(
      'rw',
      [db.invoices, db.journalEntries, db.products, db.cashBoxes, db.accounts, db.parties, db.outbox, db.auditLogs],
      async () => {
        const todayStr = new Date().toISOString().split('T')[0];
        const updatedProducts: Product[] = [];

        // أ. فحص الأصناف وتحديث الأرصدة والتشغيلات
        for (const item of itemsWithBatches) {
          const product = await db.products.get(item.productId);
          if (!product) {
            throw new Error(`الصنف ذو المعرف ${item.productId} غير موجود.`);
          }

          // التحقق الإلزامي للصيدلية
          if (invoice.activityId === 'pharmacy') {
            if (!item.batchNumber || !item.batchNumber.trim()) {
              throw new Error(`رقم التشغيلة إجباري لإدخال الدواء (${product.nameAr}) في فاتورة الشراء.`);
            }
            if (!item.expiryDate || !item.expiryDate.trim()) {
              throw new Error(`تاريخ انتهاء الصلاحية إجباري لإدخال الدواء (${product.nameAr}) في فاتورة الشراء.`);
            }
            if (item.expiryDate < todayStr) {
              throw new Error(`محظور تماماً شراء أو توريد دواء منتهي الصلاحية (${product.nameAr}) بتاريخ ${item.expiryDate}!`);
            }
          }

          if (item.batchNumber && item.expiryDate) {
            if (!product.batches) product.batches = [];
            const existingBatch = product.batches.find((b) => b.batchNumber === item.batchNumber);
            if (existingBatch) {
              existingBatch.quantity += item.quantity;
              existingBatch.costPrice = item.costPrice;
            } else {
              product.batches.push({
                id: storage.generateUUID(),
                productId: product.id,
                batchNumber: item.batchNumber,
                expiryDate: item.expiryDate,
                quantity: item.quantity,
                costPrice: item.costPrice,
              });
            }
            product.currentStock = product.batches.reduce((sum, b) => sum + b.quantity, 0);
          } else {
            product.currentStock += item.quantity;
          }

          product.purchasePrice = item.costPrice;
          updatedProducts.push(product);
          await db.products.put(product);
        }

        // ب. قيد اليومية المزدوج
        const activityInventoryAccounts: Record<CommercialActivityId, string> = {
          pharmacy: '11041',
          grocery: '11042',
          bike_parts: '11043',
          equipment_parts: '11044',
        };
        const inventoryAccountCode = activityInventoryAccounts[invoice.activityId] || '11041';
        const invAccount = await db.accounts.get(inventoryAccountCode);

        const journalLines: JournalEntryLine[] = [];

        // 1. الطرف المدين: المخزون السلعي
        journalLines.push({
          id: storage.generateUUID(),
          accountCode: inventoryAccountCode,
          accountName: invAccount ? invAccount.nameAr : 'المخزون السلعي',
          debit: invoice.total,
          credit: 0,
          costCenterId: invoice.activityId,
          memo: `شراء بضاعة فاتورة ${invoice.invoiceNumber} من ${invoice.partyName}`,
        });
        if (invAccount) {
          invAccount.balance = Number((invAccount.balance + invoice.total).toFixed(2));
          await db.accounts.put(invAccount);
        }

        // 2. الطرف الدائن: الصندوق النقدي و/أو الموردون
        if (invoice.paidAmount > 0) {
          const cashBox = (await db.cashBoxes.get(invoice.cashBoxId)) || (await db.cashBoxes.toCollection().first());
          const boxAccount = cashBox ? cashBox.accountCode : '1101';
          const boxName = cashBox ? cashBox.nameAr : 'الصندوق الرئيسي';

          journalLines.push({
            id: storage.generateUUID(),
            accountCode: boxAccount,
            accountName: boxName,
            debit: 0,
            credit: invoice.paidAmount,
            costCenterId: invoice.activityId,
            memo: `سداد نقدي فاتورة مشتريات ${invoice.invoiceNumber}`,
          });

          if (cashBox) {
            cashBox.balance = Number((cashBox.balance - invoice.paidAmount).toFixed(2));
            await db.cashBoxes.put(cashBox);
          }
          const acc = await db.accounts.get(boxAccount);
          if (acc) {
            acc.balance = Number((acc.balance - invoice.paidAmount).toFixed(2));
            await db.accounts.put(acc);
          }
        }

        const unpaid = Number((invoice.total - invoice.paidAmount).toFixed(2));
        if (unpaid > 0) {
          journalLines.push({
            id: storage.generateUUID(),
            accountCode: '2101',
            accountName: `الموردون والدائنون - ${invoice.partyName}`,
            debit: 0,
            credit: unpaid,
            costCenterId: invoice.activityId,
            memo: `مستحق آجل فاتورة مشتريات ${invoice.invoiceNumber}`,
          });

          if (invoice.partyId) {
            const supplier = await db.parties.get(invoice.partyId);
            if (supplier) {
              supplier.balance = Number((supplier.balance - unpaid).toFixed(2));
              await db.parties.put(supplier);
            }
          }
          const apAcc = await db.accounts.get('2101');
          if (apAcc) {
            apAcc.balance = Number((apAcc.balance + unpaid).toFixed(2));
            await db.accounts.put(apAcc);
          }
        }

        // ج. فحص التوازن
        const totalDebit = journalLines.reduce((sum, l) => sum + l.debit, 0);
        const totalCredit = journalLines.reduce((sum, l) => sum + l.credit, 0);
        const diff = Math.abs(totalDebit - totalCredit);
        if (diff > 0.009) {
          throw new Error(`خطأ فادح: قيد المشتريات غير متوازن! مدين=${totalDebit.toFixed(2)}, دائن=${totalCredit.toFixed(2)}`);
        }

        // د. حفظ القيد والفاتورة
        const activeBranchId = invoice.branchId || storage.getActiveBranchId();
        invoice.branchId = activeBranchId;

        const entriesCount = await db.journalEntries.count();
        const entryNumber = `JV-${new Date().getFullYear()}-${String(entriesCount + 1).padStart(5, '0')}`;
        const journalEntryId = storage.generateUUID();

        const journalEntry: JournalEntry = {
          id: journalEntryId,
          entryNumber,
          date: invoice.date,
          description: `قيد مشتريات آلي للفاتورة ${invoice.invoiceNumber} - ${invoice.partyName}`,
          costCenterId: invoice.activityId,
          branchId: activeBranchId,
          lines: journalLines,
          status: 'POSTED',
          referenceType: 'INVOICE',
          referenceId: invoice.id,
          isAutoGenerated: true,
        };

        await db.journalEntries.put(journalEntry);

        invoice.journalEntryId = journalEntryId;
        invoice.isPosted = true;
        await db.invoices.put(invoice);

        // هـ. طابور Outbox وسجل التدقيق (مع التبعيات الدقيقة وحتمية منع التكرار)
        const purchaseDependencies: string[] = [];
        if (invoice.partyId) purchaseDependencies.push(invoice.partyId);
        if (invoice.items) {
          invoice.items.forEach((it) => {
            if (it.productId && !purchaseDependencies.includes(it.productId)) {
              purchaseDependencies.push(it.productId);
            }
          });
        }

        await db.outbox.put({
          id: storage.generateUUID(),
          tenantId: 'tenant_default',
          branchId: activeBranchId,
          entityType: 'INVOICE',
          entityId: invoice.id,
          action: 'CREATE',
          payload: invoice as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 3, // P3: فواتير بعد الأطراف والأصناف
          dependsOn: purchaseDependencies.length > 0 ? purchaseDependencies : undefined,
          createdAt: new Date().toISOString(),
          idempotencyKey: `INV_PUR_${invoice.id}_${invoice.invoiceNumber}`,
        });

        await db.outbox.put({
          id: storage.generateUUID(),
          tenantId: 'tenant_default',
          branchId: activeBranchId,
          entityType: 'JOURNAL_ENTRY',
          entityId: journalEntry.id,
          action: 'CREATE',
          payload: journalEntry as unknown as Record<string, unknown>,
          status: 'PENDING',
          retryCount: 0,
          priority: 4, // P4: القيود المحاسبية
          dependsOn: [invoice.id], // القيد معتمد صراحة على الفاتورة
          createdAt: new Date().toISOString(),
          idempotencyKey: `JV_${journalEntry.id}_${journalEntry.entryNumber}`,
        });

        await db.auditLogs.put({
          id: storage.generateUUID(),
          timestamp: new Date().toISOString(),
          userId: 'system',
          userName: 'نظام المشتريات الذري',
          action: 'إصدار فاتورة مشتريات ذرية',
          details: `فاتورة ${invoice.invoiceNumber} بقيمة ${invoice.total} ر.س وقيد ${journalEntry.entryNumber}`,
        });

        // و. مزامنة الذاكرة المؤقتة التوافقية (مع منع تكرار إدراج Outbox المزدوج)
        storage.addInvoice(invoice, true);
        storage.addJournalEntry(journalEntry, true);
        for (const p of updatedProducts) {
          storage.updateProduct(p);
        }

        return { success: true, invoice, journalEntry };
      }
    );
  }

  /**
   * ترحيل قيد يومية عام ذرياً مع تحديث أرصدة الحسابات
   */
  public async createJournalEntryAtomic(entry: JournalEntry): Promise<JournalEntry> {
    return await db.transaction('rw', [db.journalEntries, db.accounts, db.outbox, db.auditLogs], async () => {
      if (!entry.lines || entry.lines.length < 2) {
        throw new Error('يجب أن يحتوي القيد على طرفين على الأقل (طرف مدين وطرف دائن).');
      }

      const totalDebit = entry.lines.reduce((sum, l) => sum + (Number(l.debit) || 0), 0);
      const totalCredit = entry.lines.reduce((sum, l) => sum + (Number(l.credit) || 0), 0);
      const diff = Math.abs(totalDebit - totalCredit);
      if (diff > 0.009) {
        throw new Error(`القيد غير متوازن! إجمالي المدين (${totalDebit.toFixed(2)}) لا يساوي إجمالي الدائن (${totalCredit.toFixed(2)}).`);
      }

      if (!entry.id) entry.id = storage.generateUUID();
      entry.status = 'POSTED';

      // تحديث أرصدة الحسابات
      for (const line of entry.lines) {
        const acc = await db.accounts.get(line.accountCode);
        if (acc) {
          const delta = (Number(line.debit) || 0) - (Number(line.credit) || 0);
          acc.balance = Number((acc.balance + delta).toFixed(2));
          await db.accounts.put(acc);
        }
      }

      await db.journalEntries.put(entry);

      await db.outbox.put({
        id: storage.generateUUID(),
        tenantId: 'tenant_default',
        entityType: 'JOURNAL_ENTRY',
        entityId: entry.id,
        action: 'CREATE',
        payload: entry as unknown as Record<string, unknown>,
        status: 'PENDING',
        retryCount: 0,
        priority: 1,
        createdAt: new Date().toISOString(),
        idempotencyKey: `JV_MANUAL_${entry.id}_${entry.entryNumber}`,
      });

      await db.auditLogs.put({
        id: storage.generateUUID(),
        timestamp: new Date().toISOString(),
        userId: 'system',
        userName: 'محرك القيود الذرية',
        action: 'ترحيل قيد يومية',
        details: `قيد رقم ${entry.entryNumber}: ${entry.description}`,
      });

      storage.addJournalEntry(entry);
      return entry;
    });
  }

  /**
   * عكس قيد مرحل ذرياً دون المساس بالقيد الأصلي
   */
  public async reverseJournalEntryAtomic(originalEntryId: string, reversalReason: string): Promise<JournalEntry> {
    return await db.transaction('rw', [db.journalEntries, db.accounts, db.outbox, db.auditLogs], async () => {
      const original = await db.journalEntries.get(originalEntryId);
      if (!original) {
        throw new Error('القيد الأصلي غير موجود.');
      }
      if (original.status === 'REVERSED') {
        throw new Error('تم عكس هذا القيد مسبقاً.');
      }

      // تعليم القيد الأصلي بأنه معكوس
      original.status = 'REVERSED';
      original.reversalReason = reversalReason;

      const entriesCount = await db.journalEntries.count();
      const reversalNumber = `REV-${new Date().getFullYear()}-${String(entriesCount + 1).padStart(5, '0')}`;
      const reversalId = storage.generateUUID();

      original.reversedEntryId = reversalId;
      await db.journalEntries.put(original);

      // إنشاء أطراف القيد المعكوس (عكس المدين والدائن)
      const reversedLines: JournalEntryLine[] = original.lines.map((l) => ({
        id: storage.generateUUID(),
        accountCode: l.accountCode,
        accountName: l.accountName,
        debit: l.credit,
        credit: l.debit,
        costCenterId: l.costCenterId,
        memo: `عكس لقيد ${original.entryNumber}: ${reversalReason}`,
      }));

      const reversalEntry: JournalEntry = {
        id: reversalId,
        entryNumber: reversalNumber,
        date: new Date().toISOString().split('T')[0],
        description: `قيد عكسي لتصحيح القيد ${original.entryNumber} - السبب: ${reversalReason}`,
        costCenterId: original.costCenterId,
        lines: reversedLines,
        status: 'POSTED',
        referenceType: original.referenceType,
        referenceId: original.referenceId,
        isAutoGenerated: true,
        reversedEntryId: original.id,
        reversalReason,
      };

      // تطبيق الأثر العكسي على أرصدة الحسابات
      for (const line of reversedLines) {
        const acc = await db.accounts.get(line.accountCode);
        if (acc) {
          const delta = (Number(line.debit) || 0) - (Number(line.credit) || 0);
          acc.balance = Number((acc.balance + delta).toFixed(2));
          await db.accounts.put(acc);
        }
      }

      await db.journalEntries.put(reversalEntry);

      await db.outbox.put({
        id: storage.generateUUID(),
        tenantId: 'tenant_default',
        entityType: 'JOURNAL_ENTRY',
        entityId: reversalEntry.id,
        action: 'CREATE',
        payload: reversalEntry as unknown as Record<string, unknown>,
        status: 'PENDING',
        retryCount: 0,
        priority: 1,
        createdAt: new Date().toISOString(),
        idempotencyKey: `JV_REV_${reversalEntry.id}_${reversalEntry.entryNumber}`,
      });

      await db.auditLogs.put({
        id: storage.generateUUID(),
        timestamp: new Date().toISOString(),
        userId: 'system',
        userName: 'محرك القيود الذرية',
        action: 'عكس قيد محاسبي',
        details: `إنشاء القيد العكسي ${reversalNumber} لتصحيح ${original.entryNumber}`,
      });

      // مزامنة الذاكرة المؤقتة التوافقية
      const currentStorageEntries = storage.getJournalEntries();
      const origIndex = currentStorageEntries.findIndex((e) => e.id === originalEntryId);
      if (origIndex !== -1) {
        currentStorageEntries[origIndex] = original;
      }
      currentStorageEntries.unshift(reversalEntry);
      storage.saveJournalEntries(currentStorageEntries);

      return reversalEntry;
    });
  }
}

export const dexieDataService = new DexieDataService();
