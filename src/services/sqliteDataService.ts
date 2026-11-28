import {
  Account,
  AllocationAudit,
  AmanatRecord,
  Branch,
  CashBox,
  CommercialActivity,
  CommercialActivityId,
  CompanyProfile,
  CostCenterId,
  Invoice,
  JournalEntry,
  OutboxQueueItem,
  Party,
  PartyAdvanceTransaction,
  PaymentAllocation,
  PaymentVoucher,
  Product,
  ProductUnit,
  SaveProductUnitInput,
  SystemAuditLog,
  SystemUser,
  VoucherManualAllocationInput,
} from '../types/erp';
import { IDataService } from './dataService';
import { desktopSession } from './desktopSession';
import { desktopAuthAdapter } from './desktopAuthAdapter';

function bridge() {
  const b = typeof window !== 'undefined' ? window.amroDesktop : undefined;
  if (!b) {
    throw new Error('واجهة SQLite المكتبية غير متاحة خارج بيئة Electron.');
  }
  return b;
}

function token(): string {
  return desktopSession.requireToken();
}

export class SqliteDataService implements IDataService {
  public async initialize(): Promise<void> {
    const b = bridge();
    await b.getRuntimeStatus();
  }

  public async getActivities(): Promise<CommercialActivity[]> {
    return await bridge().getActivities({ token: token() });
  }

  // --- Accounts ---
  public async getAccounts(): Promise<Account[]> {
    return await bridge().getAccounts({ token: token() });
  }

  public async saveAccounts(accounts: Account[]): Promise<void> {
    await bridge().saveAccounts({ token: token(), accounts });
    desktopSession.notifyChanged(['accounts', 'auditLogs']);
  }

  public async updateAccountBalance(_code: string, _deltaBalance: number): Promise<void> {
    throw new Error('تعديل الأرصدة مباشرة محظور؛ يجب استخدام المعاملات المحاسبية الذرية.');
  }

  public async createAccountAtomic(account: Account): Promise<Account> {
    const created = await bridge().createAccountAtomic({ token: token(), account });
    desktopSession.notifyChanged(['accounts', 'auditLogs']);
    return created;
  }

  // --- Products & Inventory (Batch B) ---
  public async getProducts(activityId?: CommercialActivityId): Promise<Product[]> {
    return await bridge().getProducts({ token: token(), activityId });
  }
  public async getProductById(id: string): Promise<Product | undefined> {
    return await bridge().getProductById({ token: token(), id });
  }
  public async getProductUnits(productId: string): Promise<ProductUnit[]> {
    return await bridge().getProductUnits({ token: token(), productId });
  }
  public async saveProductUnit(input: SaveProductUnitInput): Promise<ProductUnit> {
    const saved = await bridge().saveProductUnit({ token: token(), unit: input });
    desktopSession.notifyChanged(['productUnits', 'auditLogs']);
    return saved;
  }
  public async addProduct(product: Product): Promise<void> {
    await this.saveProductAtomic(product, false);
  }
  public async updateProduct(product: Product): Promise<void> {
    await this.saveProductAtomic(product, true);
  }
  public async deleteProduct(productId: string): Promise<void> {
    await this.deleteProductAtomic(productId);
  }
  public async saveProductAtomic(product: Product, isUpdate = false): Promise<Product> {
    const saved = await bridge().saveProductAtomic({ token: token(), product, isUpdate });
    desktopSession.notifyChanged(['products', 'outbox', 'auditLogs']);
    return saved;
  }
  public async deleteProductAtomic(productId: string): Promise<void> {
    await bridge().deleteProductAtomic({ token: token(), productId });
    desktopSession.notifyChanged(['products', 'outbox', 'auditLogs']);
  }
  public async adjustProductStockAtomic(params: {
    productId: string;
    deltaQuantity: number;
    reason: string;
    batchNumber?: string;
    expiryDate?: string;
  }): Promise<Product> {
    const updated = await bridge().adjustProductStockAtomic({ token: token(), params });
    desktopSession.notifyChanged(['products', 'outbox', 'auditLogs']);
    return updated;
  }

  // --- Parties (Batch B) ---
  public async getParties(type?: 'CUSTOMER' | 'SUPPLIER'): Promise<Party[]> {
    return await bridge().getParties({ token: token(), type });
  }
  public async getPartyById(id: string): Promise<Party | undefined> {
    return await bridge().getPartyById({ token: token(), id });
  }
  public async addParty(party: Party): Promise<void> {
    await this.savePartyAtomic(party, false);
  }
  public async updateParty(party: Party): Promise<void> {
    await this.savePartyAtomic(party, true);
  }
  public async updatePartyBalance(_partyId: string, _deltaBalance: number): Promise<void> {
    throw new Error('تعديل أرصدة العملاء والموردين يتم عبر الفواتير والسندات الذرية فقط.');
  }
  public async savePartyAtomic(party: Party, isUpdate = false): Promise<Party> {
    const saved = await bridge().savePartyAtomic({ token: token(), party, isUpdate });
    desktopSession.notifyChanged(['parties', 'outbox', 'auditLogs']);
    return saved;
  }

  // --- Invoices & Atomic Financial Engine (Batch C) ---
  public async getInvoices(activityId?: CommercialActivityId): Promise<Invoice[]> {
    return await bridge().getInvoices({ token: token(), activityId });
  }
  public async getInvoiceById(id: string): Promise<Invoice | undefined> {
    return await bridge().getInvoiceById({ token: token(), id });
  }
  public async addInvoice(_invoice: Invoice): Promise<void> {
    throw new Error('استخدم createSalesInvoiceAtomic أو createPurchaseInvoiceAtomic.');
  }
  public async getJournalEntries(costCenterId?: CostCenterId): Promise<JournalEntry[]> {
    return await bridge().getJournalEntries({ token: token(), costCenterId });
  }
  public async getJournalEntryById(id: string): Promise<JournalEntry | undefined> {
    return await bridge().getJournalEntryById({ token: token(), id });
  }
  public async addJournalEntry(entry: JournalEntry): Promise<void> {
    await this.createJournalEntryAtomic(entry);
  }
  public async reverseJournalEntry(originalEntryId: string, reversalReason: string): Promise<JournalEntry> {
    return await this.reverseJournalEntryAtomic(originalEntryId, reversalReason);
  }
  public async createSalesInvoiceAtomic(params: {
    invoice: Invoice;
    totalCogs: number;
    stockDeductions: Array<{ productId: string; quantity: number; batchNumber?: string }>;
    applyAdvanceAmount?: number;
    clientRequestId?: string;
  }): Promise<{ success: boolean; invoice: Invoice; journalEntry: JournalEntry; advanceJournalEntry?: JournalEntry }> {
    const res = await bridge().createSalesInvoiceAtomic({ token: token(), params });
    desktopSession.notifyChanged([
      'invoices',
      'products',
      'parties',
      'cashBoxes',
      'accounts',
      'journalEntries',
      'paymentAllocations',
      'partyAdvances',
      'outbox',
      'auditLogs',
    ]);
    return res;
  }
  public async createPurchaseInvoiceAtomic(params: {
    invoice: Invoice;
    itemsWithBatches: Array<{
      productId: string;
      quantity: number;
      costPrice: number;
      batchNumber?: string;
      expiryDate?: string;
    }>;
    applyAdvanceAmount?: number;
    clientRequestId?: string;
  }): Promise<{ success: boolean; invoice: Invoice; journalEntry: JournalEntry; advanceJournalEntry?: JournalEntry }> {
    const res = await bridge().createPurchaseInvoiceAtomic({ token: token(), params });
    desktopSession.notifyChanged([
      'invoices',
      'products',
      'parties',
      'cashBoxes',
      'accounts',
      'journalEntries',
      'paymentAllocations',
      'partyAdvances',
      'outbox',
      'auditLogs',
    ]);
    return res;
  }
  public async createSalesReturnAtomic(params: {
    originalInvoiceId: string;
    items: Array<{ productId: string; quantity: number; batchNumber?: string }>;
    returnReason: string;
    refundMethod: 'AUTO' | 'AR_OFFSET' | 'CASH' | 'ADVANCE';
    cashBoxId?: string;
    date?: string;
    clientRequestId?: string;
  }): Promise<{ success: boolean; invoice: Invoice; journalEntry: JournalEntry }> {
    const res = await bridge().createSalesReturnAtomic({ token: token(), params });
    desktopSession.notifyChanged([
      'invoices',
      'products',
      'parties',
      'cashBoxes',
      'accounts',
      'journalEntries',
      'paymentAllocations',
      'partyAdvances',
      'outbox',
      'auditLogs',
    ]);
    return res;
  }
  public async createPurchaseReturnAtomic(params: {
    originalInvoiceId: string;
    items: Array<{ productId: string; quantity: number; batchNumber?: string }>;
    returnReason: string;
    refundMethod: 'AUTO' | 'AP_OFFSET' | 'CASH' | 'ADVANCE';
    cashBoxId?: string;
    date?: string;
    clientRequestId?: string;
  }): Promise<{ success: boolean; invoice: Invoice; journalEntry: JournalEntry }> {
    const res = await bridge().createPurchaseReturnAtomic({ token: token(), params });
    desktopSession.notifyChanged([
      'invoices',
      'products',
      'parties',
      'cashBoxes',
      'accounts',
      'journalEntries',
      'paymentAllocations',
      'partyAdvances',
      'outbox',
      'auditLogs',
    ]);
    return res;
  }
  public async createJournalEntryAtomic(entry: JournalEntry): Promise<JournalEntry> {
    const created = await bridge().createJournalEntryAtomic({ token: token(), entry });
    desktopSession.notifyChanged(['journalEntries', 'accounts', 'cashBoxes', 'outbox', 'auditLogs']);
    return created;
  }
  public async reverseJournalEntryAtomic(originalEntryId: string, reversalReason: string): Promise<JournalEntry> {
    const reversed = await bridge().reverseJournalEntryAtomic({ token: token(), originalEntryId, reversalReason });
    desktopSession.notifyChanged(['journalEntries', 'accounts', 'cashBoxes', 'outbox', 'auditLogs']);
    return reversed;
  }
  public async getCashBoxes(): Promise<CashBox[]> {
    return await bridge().getCashBoxes({ token: token() });
  }
  public async updateCashBoxBalance(_id: string, _deltaBalance: number): Promise<void> {
    throw new Error('استخدم السندات الذرية لتعديل أرصدة الصناديق.');
  }
  public async createCashBoxAtomic(box: CashBox): Promise<CashBox> {
    const created = await bridge().createCashBoxAtomic({ token: token(), box });
    desktopSession.notifyChanged(['cashBoxes', 'outbox', 'auditLogs']);
    return created;
  }
  public async getVouchers(): Promise<PaymentVoucher[]> {
    return await bridge().getVouchers({ token: token() });
  }
  public async addVoucher(voucher: PaymentVoucher): Promise<void> {
    await this.createCashVoucherAtomic({ voucher });
  }
  public async createCashVoucherAtomic(params: {
    voucher: PaymentVoucher;
    manualAllocations?: VoucherManualAllocationInput[];
    overrideReason?: string;
  }): Promise<{
    success: boolean;
    voucher: PaymentVoucher;
    journalEntry?: JournalEntry;
    allocations?: PaymentAllocation[];
    advanceTransaction?: PartyAdvanceTransaction;
  }> {
    const res = await bridge().createCashVoucherAtomic({ token: token(), params });
    desktopSession.notifyChanged([
      'vouchers',
      'invoices',
      'cashBoxes',
      'accounts',
      'parties',
      'journalEntries',
      'paymentAllocations',
      'partyAdvances',
      'allocationAudits',
      'outbox',
      'auditLogs',
    ]);
    return res;
  }

  public async postDraftCashVoucherAtomic(params: {
    voucherId: string;
    manualAllocations?: VoucherManualAllocationInput[];
    overrideReason?: string;
  }): Promise<{
    success: boolean;
    voucher: PaymentVoucher;
    journalEntry: JournalEntry;
    allocations: PaymentAllocation[];
    advanceTransaction?: PartyAdvanceTransaction;
  }> {
    const res = await bridge().postDraftCashVoucherAtomic({ token: token(), params });
    desktopSession.notifyChanged([
      'vouchers',
      'invoices',
      'cashBoxes',
      'accounts',
      'parties',
      'journalEntries',
      'paymentAllocations',
      'partyAdvances',
      'allocationAudits',
      'outbox',
      'auditLogs',
    ]);
    return res;
  }

  public async cancelCashVoucherAtomic(params: {
    voucherId: string;
    reason: string;
  }): Promise<PaymentVoucher> {
    const res = await bridge().cancelCashVoucherAtomic({ token: token(), params });
    desktopSession.notifyChanged(['vouchers', 'outbox', 'auditLogs']);
    return res;
  }

  public async reverseCashVoucherAtomic(params: {
    voucherId: string;
    reversalReason: string;
  }): Promise<{
    success: boolean;
    voucher: PaymentVoucher;
    reversalJournalEntry: JournalEntry;
  }> {
    const res = await bridge().reverseCashVoucherAtomic({ token: token(), params });
    desktopSession.notifyChanged([
      'vouchers',
      'invoices',
      'cashBoxes',
      'accounts',
      'parties',
      'journalEntries',
      'paymentAllocations',
      'partyAdvances',
      'outbox',
      'auditLogs',
    ]);
    return res;
  }

  public async getPaymentAllocations(partyId?: string, voucherId?: string): Promise<PaymentAllocation[]> {
    return await bridge().getPaymentAllocations({ token: token(), partyId, voucherId });
  }

  public async getPartyAdvanceTransactions(partyId?: string): Promise<PartyAdvanceTransaction[]> {
    return await bridge().getPartyAdvanceTransactions({ token: token(), partyId });
  }

  public async getAllocationAudits(voucherId?: string): Promise<AllocationAudit[]> {
    return await bridge().getAllocationAudits({ token: token(), voucherId });
  }
  public async getAmanatRecords(): Promise<AmanatRecord[]> {
    return await bridge().getAmanatRecords({ token: token() });
  }
  public async getAmanatById(id: string): Promise<AmanatRecord | undefined> {
    return await bridge().getAmanatById({ token: token(), id });
  }
  public async addAmanatRecord(record: AmanatRecord): Promise<void> {
    await this.createAmanatDepositAtomic({ record, cashBoxId: record.cashBoxId });
  }
  public async updateAmanatRecord(record: AmanatRecord): Promise<void> {
    await bridge().updateAmanatRecord({ token: token(), record });
    desktopSession.notifyChanged(['amanat', 'outbox', 'auditLogs']);
  }
  public async createAmanatDepositAtomic(params: {
    record: AmanatRecord;
    cashBoxId?: string;
  }): Promise<{ success: boolean; record: AmanatRecord; journalEntry?: JournalEntry }> {
    const res = await bridge().createAmanatDepositAtomic({ token: token(), params });
    desktopSession.notifyChanged(['amanat', 'cashBoxes', 'accounts', 'journalEntries', 'outbox', 'auditLogs']);
    return res;
  }
  public async returnAmanatAtomic(params: {
    recordId: string;
    cashBoxId?: string;
    returnAmount?: number;
    recipientSignatureName?: string;
    notes?: string;
  }): Promise<{ success: boolean; record: AmanatRecord; journalEntry?: JournalEntry }> {
    const res = await bridge().returnAmanatAtomic({ token: token(), params });
    desktopSession.notifyChanged(['amanat', 'cashBoxes', 'accounts', 'journalEntries', 'outbox', 'auditLogs']);
    return res;
  }
  public async cancelAmanatAtomic(params: {
    recordId: string;
    reason: string;
  }): Promise<{ success: boolean; record: AmanatRecord; journalEntry?: JournalEntry }> {
    const res = await bridge().cancelAmanatAtomic({ token: token(), params });
    desktopSession.notifyChanged(['amanat', 'cashBoxes', 'accounts', 'journalEntries', 'outbox', 'auditLogs']);
    return res;
  }

  // --- Users & Audit Logs (Batch A) ---
  public async getUsers(): Promise<SystemUser[]> {
    return await bridge().getUsers({ token: token() });
  }

  public async getCurrentUser(): Promise<SystemUser> {
    const actor = desktopSession.getActor();
    if (!actor) throw new Error('لا توجد جلسة نشطة.');
    return actor;
  }

  public async setCurrentUser(user: SystemUser): Promise<void> {
    const t = token();
    desktopSession.setActorSession(t, user);
  }

  public async saveUserAtomic(user: SystemUser): Promise<SystemUser> {
    const saved = await desktopAuthAdapter.saveUserProfile(token(), user);
    const result: SystemUser = {
      ...saved,
      role: saved.role as SystemUser['role'],
      allowedActivities: saved.allowedActivities as CommercialActivityId[],
    };
    desktopSession.notifyChanged(['users', 'auditLogs']);
    return result;
  }

  public async createUserAtomic(params: {
    username: string;
    fullName: string;
    role: SystemUser['role'];
    allowedActivities: CommercialActivityId[];
    branchId: string;
    allowedBranches?: string[];
    plainPassword: string;
  }): Promise<SystemUser> {
    const created = await desktopAuthAdapter.createUser(token(), params);
    const result: SystemUser = {
      ...created,
      role: created.role as SystemUser['role'],
      allowedActivities: created.allowedActivities as CommercialActivityId[],
    };
    desktopSession.notifyChanged(['users', 'auditLogs']);
    return result;
  }

  public async getAuditLogs(): Promise<SystemAuditLog[]> {
    return await bridge().getAuditLogs({ token: token() });
  }

  public async logAction(action: string, details: string): Promise<void> {
    await bridge().logAction({ token: token(), action, details });
    desktopSession.notifyChanged(['auditLogs']);
  }

  // --- Branches & Sequences (Batch A) ---
  public async getBranches(): Promise<Branch[]> {
    const branches = await bridge().getBranches({ token: token() });
    desktopSession.setBranchesLocal(branches);
    return branches;
  }

  public async getActiveBranch(): Promise<Branch> {
    const branches = await this.getBranches();
    const activeId = await bridge().getActiveBranchId({ token: token() });
    const found = branches.find((b) => b.id === activeId) || branches[0];
    if (!found) throw new Error('لا يوجد فرع نشط مصرح به.');
    return found;
  }

  public async setActiveBranchId(branchId: string): Promise<void> {
    const updated = await bridge().setActiveBranchId({ token: token(), branchId });
    desktopSession.setActiveBranchLocal(updated);
  }

  public async addBranch(branch: Branch): Promise<void> {
    await bridge().addBranch({ token: token(), branch });
    desktopSession.notifyChanged(['branches', 'auditLogs']);
  }

  public async updateBranch(branch: Branch): Promise<void> {
    await bridge().updateBranch({ token: token(), branch });
    desktopSession.notifyChanged(['branches', 'auditLogs']);
  }

  public async generateBranchInvoiceNumber(
    type: 'INV' | 'PUR' | 'RS' | 'RP',
    branchCode?: string,
    terminalCode?: string
  ): Promise<string> {
    return await bridge().generateBranchInvoiceNumber({
      token: token(),
      type,
      branchCode,
      terminalCode,
    });
  }

  public async generateBranchVoucherNumber(
    type: 'RCT' | 'PAY',
    branchCode?: string,
    terminalCode?: string
  ): Promise<string> {
    return await bridge().generateBranchVoucherNumber({
      token: token(),
      type,
      branchCode,
      terminalCode,
    });
  }

  // --- Company Profile & Settings helpers (Batch A) ---
  public async getCompanyProfile(): Promise<CompanyProfile> {
    const profile = await bridge().getCompanyProfile({ token: token() });
    desktopSession.setCompanyProfileLocal(profile);
    return profile;
  }

  public async saveCompanyProfile(profile: CompanyProfile): Promise<CompanyProfile> {
    const updated = await bridge().saveCompanyProfile({ token: token(), profile });
    desktopSession.setCompanyProfileLocal(updated);
    return updated;
  }

  public async getTerminalCode(): Promise<string> {
    const code = await bridge().getTerminalCode({ token: token() });
    desktopSession.setTerminalCodeLocal(code);
    return code;
  }

  public async setTerminalCode(terminalCode: string): Promise<string> {
    const code = await bridge().setTerminalCode({ token: token(), terminalCode });
    desktopSession.setTerminalCodeLocal(code);
    return code;
  }

  // --- Outbox & Backup (Batch D) ---
  public async getOutboxQueue(): Promise<OutboxQueueItem[]> {
    return await bridge().getOutboxQueue({ token: token(), statusFilter: 'all', sortDir: 'desc' });
  }

  public async queueOutboxItem(
    item: Omit<OutboxQueueItem, 'id' | 'createdAt' | 'status' | 'retryCount' | 'idempotencyKey'> & {
      idempotencyKey?: string;
    }
  ): Promise<void> {
    await bridge().queueOutboxItem({ token: token(), item });
    desktopSession.notifyChanged(['outbox']);
  }

  public async markOutboxSynced(id: string): Promise<void> {
    await bridge().markOutboxSynced({ token: token(), id });
    desktopSession.notifyChanged(['outbox']);
  }

  public async exportBackupJSON(): Promise<string> {
    return await bridge().exportBackupJSON({ token: token() });
  }

  public async importBackupJSON(jsonContent: string): Promise<{ success: boolean; error?: string }> {
    const res = await bridge().importBackupJSON({ token: token(), rawJson: jsonContent });
    if (res.success) {
      const currentToken = token();
      const freshActor = await bridge().getCurrentActor({ token: currentToken }).catch(() => null);
      if (freshActor) {
        const mapped: SystemUser = {
          id: freshActor.id,
          tenantId: freshActor.tenantId,
          username: freshActor.username,
          fullName: freshActor.fullName,
          role: freshActor.role,
          allowedActivities: freshActor.allowedActivities as CommercialActivityId[],
          branchId: freshActor.branchId,
          allowedBranches: [...freshActor.allowedBranches],
          active: freshActor.active,
          hasPassword: freshActor.hasPassword,
          mustChangePassword: freshActor.mustChangePassword,
          failedLoginAttempts: freshActor.failedLoginAttempts,
        };
        await desktopSession.hydrate(currentToken, mapped);
      }
      desktopSession.notifyChanged(['all']);
    }
    return { success: res.success, error: res.error };
  }

  public async resetToCleanBooks(): Promise<void> {
    await bridge().resetToCleanBooks({ token: token() });
    desktopSession.notifyChanged(['all']);
  }
}

export const sqliteDataService = new SqliteDataService();
