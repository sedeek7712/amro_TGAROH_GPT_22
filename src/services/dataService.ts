/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * واجهة تجريد البيانات الموحدة (IDataService Contract)
 * تعزل شاشات ومنطق العمل تماماً عن تفاصيل التخزين سواء كان Dexie/IndexedDB أو Django REST API
 */

import {
  CommercialActivity,
  CommercialActivityId,
  CompanyProfile,
  Account,
  Product,
  Party,
  Invoice,
  JournalEntry,
  CashBox,
  PaymentVoucher,
  AmanatRecord,
  SystemUser,
  SystemAuditLog,
  CostCenterId,
  OutboxQueueItem,
  Branch,
  PaymentAllocation,
  PartyAdvanceTransaction,
  AllocationAudit,
  VoucherManualAllocationInput,
} from '../types/erp';

export interface IDataService {
  // تهيئة الخدمة والتحقق من التخزين الدائم
  initialize(): Promise<void>;

  // الأنشطة التجارية الأربعة
  getActivities(): Promise<CommercialActivity[]>;

  // ملف الشركة وإعدادات الجهاز
  getCompanyProfile(): Promise<CompanyProfile>;
  saveCompanyProfile(profile: CompanyProfile): Promise<CompanyProfile>;
  getTerminalCode(): Promise<string>;
  setTerminalCode(terminalCode: string): Promise<string>;

  // الدليل المحاسبي ومراكز التكلفة
  getAccounts(): Promise<Account[]>;
  saveAccounts(accounts: Account[]): Promise<void>;
  updateAccountBalance(code: string, deltaBalance: number): Promise<void>;

  // المخزون والأصناف
  getProducts(activityId?: CommercialActivityId): Promise<Product[]>;
  getProductById(id: string): Promise<Product | undefined>;
  addProduct(product: Product): Promise<void>;
  updateProduct(product: Product): Promise<void>;
  deleteProduct(productId: string): Promise<void>;

  // العملاء والموردين
  getParties(type?: 'CUSTOMER' | 'SUPPLIER'): Promise<Party[]>;
  getPartyById(id: string): Promise<Party | undefined>;
  addParty(party: Party): Promise<void>;
  updateParty(party: Party): Promise<void>;
  updatePartyBalance(partyId: string, deltaBalance: number): Promise<void>;

  // الفواتير
  getInvoices(activityId?: CommercialActivityId): Promise<Invoice[]>;
  getInvoiceById(id: string): Promise<Invoice | undefined>;
  addInvoice(invoice: Invoice): Promise<void>;

  // القيود المحاسبية (ممنوع تعديل أو حذف القيد بعد ترحيله)
  getJournalEntries(costCenterId?: CostCenterId): Promise<JournalEntry[]>;
  getJournalEntryById(id: string): Promise<JournalEntry | undefined>;
  addJournalEntry(entry: JournalEntry): Promise<void>;
  reverseJournalEntry(originalEntryId: string, reversalReason: string): Promise<JournalEntry>;

  // المعاملات الذرية المركبة الحقيقية (ACID Multi-table Atomic Operations)
  createSalesInvoiceAtomic(params: {
    invoice: Invoice;
    totalCogs: number;
    stockDeductions: Array<{ productId: string; quantity: number; batchNumber?: string }>;
    applyAdvanceAmount?: number;
    clientRequestId?: string;
  }): Promise<{ success: boolean; invoice: Invoice; journalEntry: JournalEntry; advanceJournalEntry?: JournalEntry }>;

  createPurchaseInvoiceAtomic(params: {
    invoice: Invoice;
    itemsWithBatches: Array<{
      productId: string;
      quantity: number;
      costPrice: number;
      batchNumber?: string;
      expiryDate?: string;
    }>;
    clientRequestId?: string;
  }): Promise<{ success: boolean; invoice: Invoice; journalEntry: JournalEntry }>;

  createJournalEntryAtomic(entry: JournalEntry): Promise<JournalEntry>;
  reverseJournalEntryAtomic(originalEntryId: string, reversalReason: string): Promise<JournalEntry>;

  // الصناديق والبنوك
  getCashBoxes(): Promise<CashBox[]>;
  updateCashBoxBalance(id: string, deltaBalance: number): Promise<void>;

  // السندات (قبض وصرف)
  getVouchers(): Promise<PaymentVoucher[]>;
  addVoucher(voucher: PaymentVoucher): Promise<void>;

  // وحدة الأمانات المستقلة
  getAmanatRecords(): Promise<AmanatRecord[]>;
  getAmanatById(id: string): Promise<AmanatRecord | undefined>;
  addAmanatRecord(record: AmanatRecord): Promise<void>;
  updateAmanatRecord(record: AmanatRecord): Promise<void>;

  // المستخدمون وسجل التدقيق
  getUsers(): Promise<SystemUser[]>;
  getCurrentUser(): Promise<SystemUser>;
  setCurrentUser(user: SystemUser): Promise<void>;
  getAuditLogs(): Promise<SystemAuditLog[]>;
  logAction(action: string, details: string): Promise<void>;

  // نظام الفروع ونقاط البيع المستقلة (Multi-Branch System)
  getBranches(): Promise<Branch[]>;
  getActiveBranch(): Promise<Branch>;
  setActiveBranchId(branchId: string): Promise<void>;
  addBranch(branch: Branch): Promise<void>;
  updateBranch(branch: Branch): Promise<void>;
  generateBranchInvoiceNumber(type: 'INV' | 'PUR', branchCode?: string, terminalCode?: string): Promise<string>;
  generateBranchVoucherNumber(type: 'RCT' | 'PAY', branchCode?: string, terminalCode?: string): Promise<string>;

  // طابور الإرسال للمزامنة مع Django
  getOutboxQueue(): Promise<OutboxQueueItem[]>;
  queueOutboxItem(item: Omit<OutboxQueueItem, 'id' | 'createdAt' | 'status' | 'retryCount' | 'idempotencyKey'> & { idempotencyKey?: string }): Promise<void>;
  markOutboxSynced(id: string): Promise<void>;

  // النسخ الاحتياطي والاستعادة المستقلة دون إنترنت
  exportBackupJSON(): Promise<string>;
  importBackupJSON(jsonContent: string): Promise<{ success: boolean; error?: string }>;

  // واجهات المجال التي تحتاجها الشاشات، مستقلة عن مزود التخزين.
  saveProductAtomic(product: Product, isUpdate?: boolean): Promise<Product>;
  deleteProductAtomic(productId: string): Promise<void>;
  adjustProductStockAtomic(params: {
    productId: string;
    deltaQuantity: number;
    reason: string;
    batchNumber?: string;
    expiryDate?: string;
  }): Promise<Product>;
  createAccountAtomic(account: Account): Promise<Account>;
  createCashBoxAtomic(box: CashBox): Promise<CashBox>;
  createCashVoucherAtomic(params: {
    voucher: PaymentVoucher;
    manualAllocations?: VoucherManualAllocationInput[];
    overrideReason?: string;
  }): Promise<{
    success: boolean;
    voucher: PaymentVoucher;
    journalEntry?: JournalEntry;
    allocations?: PaymentAllocation[];
    advanceTransaction?: PartyAdvanceTransaction;
  }>;
  postDraftCashVoucherAtomic(params: {
    voucherId: string;
    manualAllocations?: VoucherManualAllocationInput[];
    overrideReason?: string;
  }): Promise<{
    success: boolean;
    voucher: PaymentVoucher;
    journalEntry: JournalEntry;
    allocations: PaymentAllocation[];
    advanceTransaction?: PartyAdvanceTransaction;
  }>;
  cancelCashVoucherAtomic(params: {
    voucherId: string;
    reason: string;
  }): Promise<PaymentVoucher>;
  reverseCashVoucherAtomic(params: {
    voucherId: string;
    reversalReason: string;
  }): Promise<{
    success: boolean;
    voucher: PaymentVoucher;
    reversalJournalEntry: JournalEntry;
  }>;
  getPaymentAllocations(partyId?: string, voucherId?: string): Promise<PaymentAllocation[]>;
  getPartyAdvanceTransactions(partyId?: string): Promise<PartyAdvanceTransaction[]>;
  getAllocationAudits(voucherId?: string): Promise<AllocationAudit[]>;
  createAmanatDepositAtomic(params: {
    record: AmanatRecord;
    cashBoxId?: string;
  }): Promise<{ success: boolean; record: AmanatRecord; journalEntry?: JournalEntry }>;
  returnAmanatAtomic(params: {
    recordId: string;
    cashBoxId?: string;
    recipientSignatureName?: string;
  }): Promise<{ success: boolean; record: AmanatRecord; journalEntry?: JournalEntry }>;
  savePartyAtomic(party: Party, isUpdate?: boolean): Promise<Party>;
  saveUserAtomic(user: SystemUser): Promise<SystemUser>;
  createUserAtomic(params: {
    username: string;
    fullName: string;
    role: SystemUser['role'];
    allowedActivities: CommercialActivityId[];
    branchId: string;
    allowedBranches?: string[];
    plainPassword: string;
  }): Promise<SystemUser>;

  // تصفير الدفاتر للبدء النظيف
  resetToCleanBooks(): Promise<void>;
}

// تصدير تطبيق خدمة البيانات الموحدة: SQLite في نسخة Windows/Electron و Dexie في الويب
import { dexieDataService, DexieDataService } from './dexieDataService';
import { sqliteDataService, SqliteDataService } from './sqliteDataService';

const isElectronDesktop =
  typeof window !== 'undefined' && Boolean((window as Window).amroDesktop);

export const dataService: IDataService = isElectronDesktop
  ? sqliteDataService
  : dexieDataService;
export { dexieDataService, DexieDataService, sqliteDataService, SqliteDataService };
