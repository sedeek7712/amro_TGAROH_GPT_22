import type {
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
  Brand,
  ProductFamily,
  ProductCatalogMeta,
  ProductCatalogEntry,
  SaveBrandInput,
  CreateProductFamilyWithSkusInput,
  UpdateProductFamilyInput,
  AssignProductBrandInput,
  ProductImage,
  SyncConflict,
  SystemAuditLog,
  SystemUser,
  VoucherManualAllocationInput,
} from './erp';

export {};

interface DesktopSafeUser {
  id: string;
  tenantId: string;
  username: string;
  fullName: string;
  role: 'ADMIN' | 'ACCOUNTANT' | 'CASHIER' | 'INVENTORY_KEEPER';
  branchId: string;
  allowedBranches: string[];
  allowedActivities: string[];
  active: boolean;
  hasPassword?: boolean;
  mustChangePassword?: boolean;
  failedLoginAttempts?: number;
}

interface DesktopAuthResult {
  success: boolean;
  token?: string;
  expiresAt?: string;
  user?: DesktopSafeUser;
  mustChangePassword?: boolean;
  error?: string;
  lockedUntil?: string;
}

export interface DesktopLegacyPreview {
  sourceSystem: string;
  sourceVersion: string;
  exportedAt: string | null;
  tenants: number;
  sourceChecksum: string;
  rowCounts: Record<string, number>;
  financialTotals: Record<string, string>;
}

export interface DesktopLegacyImportResult {
  success: boolean;
  importId: string;
  importedAt: string;
  backupFilename: string;
  rowCounts: Record<string, number>;
  financialTotals: Record<string, string>;
}

export interface DesktopNativeBackupInfo {
  filename: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  location?: 'default' | 'custom';
  hasMediaSidecar?: boolean;
}

export interface DesktopBackupSettings {
  autoBackupOnExit: boolean;
  autoBackupIntervalHours: number;
  maxRetainedBackups: number;
  customBackupDirectory: string;
  defaultBackupDirectory?: string;
}

declare global {
  interface Window {
    readonly amroDesktop?: {
      getRuntimeStatus(): Promise<{
        ready: boolean;
        databaseFile: string;
        schemaVersion: number;
        sqliteVersion: string;
      }>;
      getAuthSetupStatus(): Promise<{ setupRequired: boolean; userCount: number }>;
      createInitialAdmin(input: {
        username: string;
        fullName: string;
        password: string;
      }): Promise<{ success: boolean; user: DesktopSafeUser }>;
      login(input: { username: string; password: string }): Promise<DesktopAuthResult>;
      getCurrentActor(input: { token: string; branchId?: string }): Promise<DesktopSafeUser | null>;
      logout(token: string): Promise<{ success: boolean }>;
      completeMandatoryPasswordChange(input: {
        token: string;
        newPassword: string;
      }): Promise<DesktopAuthResult>;
      createUser(input: {
        token: string;
        input: {
          username: string;
          fullName: string;
          role: SystemUser['role'];
          allowedActivities: CommercialActivityId[];
          branchId: string;
          allowedBranches?: string[];
          plainPassword: string;
          mustChangePassword?: boolean;
        };
      }): Promise<DesktopSafeUser>;
      saveUserProfile(input: { token: string; user: SystemUser }): Promise<DesktopSafeUser>;
      adminResetPassword(input: {
        token: string;
        targetUserId: string;
        newPassword: string;
      }): Promise<DesktopSafeUser>;
      switchUser(input: {
        token: string;
        adminPassword: string;
        targetUserId: string;
      }): Promise<DesktopAuthResult>;

      previewLegacyBackup(input: { rawJson: string; token?: string }): Promise<DesktopLegacyPreview>;
      importLegacyBackup(input: { rawJson: string; token?: string }): Promise<DesktopLegacyImportResult>;

      getActivities(input: { token: string }): Promise<CommercialActivity[]>;
      getBranches(input: { token: string }): Promise<Branch[]>;
      getBranch(input: { token: string; branchId: string }): Promise<Branch | undefined>;
      addBranch(input: { token: string; branch: Branch }): Promise<Branch>;
      updateBranch(input: { token: string; branch: Branch }): Promise<Branch>;
      getActiveBranchId(input: { token: string }): Promise<string>;
      setActiveBranchId(input: { token: string; branchId: string }): Promise<string>;
      getTerminalCode(input: { token: string }): Promise<string>;
      setTerminalCode(input: { token: string; terminalCode: string }): Promise<string>;
      getAccounts(input: { token: string }): Promise<Account[]>;
      createAccountAtomic(input: { token: string; account: Account }): Promise<Account>;
      saveAccounts(input: { token: string; accounts: Account[] }): Promise<void>;
      getUsers(input: { token: string }): Promise<SystemUser[]>;
      getAuditLogs(input: { token: string }): Promise<SystemAuditLog[]>;
      logAction(input: { token: string; action: string; details: string }): Promise<SystemAuditLog>;
      generateBranchInvoiceNumber(input: {
        token: string;
        type: 'INV' | 'PUR' | 'RS' | 'RP';
        branchCode?: string;
        terminalCode?: string;
      }): Promise<string>;
      generateBranchVoucherNumber(input: {
        token: string;
        type: 'RCT' | 'PAY';
        branchCode?: string;
        terminalCode?: string;
      }): Promise<string>;
      getCompanyProfile(input: { token: string }): Promise<CompanyProfile>;
      saveCompanyProfile(input: { token: string; profile: CompanyProfile }): Promise<CompanyProfile>;
      getSyncConfig(input: { token: string; kind: 'django' | 'supabase' }): Promise<unknown>;
      saveSyncConfig(input: { token: string; kind: 'django' | 'supabase'; config: unknown }): Promise<unknown>;
      resetToCleanBooks(input: { token: string }): Promise<void>;

      getProducts(input: { token: string; activityId?: CommercialActivityId | 'all' }): Promise<Product[]>;
      getProductById(input: { token: string; id: string }): Promise<Product | undefined>;
      getProductUnits(input: { token: string; productId: string }): Promise<ProductUnit[]>;
      saveProductUnit(input: { token: string; unit: SaveProductUnitInput }): Promise<ProductUnit>;
      getBrands(input: { token: string; includeInactive?: boolean }): Promise<Brand[]>;
      saveBrandAtomic(input: { token: string; input: SaveBrandInput }): Promise<Brand>;
      archiveBrandAtomic(input: { token: string; brandId: string }): Promise<Brand>;
      getProductFamilies(input: {
        token: string;
        activityId?: CommercialActivityId | 'all';
        includeInactive?: boolean;
      }): Promise<ProductFamily[]>;
      getProductFamilyById(input: { token: string; familyId: string }): Promise<ProductFamily | undefined>;
      createProductFamilyWithSkusAtomic(input: {
        token: string;
        input: CreateProductFamilyWithSkusInput;
      }): Promise<{ family: ProductFamily; skus: ProductCatalogEntry[] }>;
      updateProductFamilyAtomic(input: { token: string; input: UpdateProductFamilyInput }): Promise<ProductFamily>;
      archiveProductFamilyAtomic(input: { token: string; familyId: string }): Promise<ProductFamily>;
      assignProductBrandAtomic(input: {
        token: string;
        input: AssignProductBrandInput;
      }): Promise<ProductCatalogMeta | undefined>;
      getProductCatalog(input: {
        token: string;
        activityId?: CommercialActivityId | 'all';
      }): Promise<ProductCatalogEntry[]>;
      getProductCatalogEntry(input: { token: string; productId: string }): Promise<ProductCatalogEntry | undefined>;
      getProductImages(input: { token: string; productId: string }): Promise<ProductImage[]>;
      getProductImageRecord(input: { token: string; imageId: string }): Promise<ProductImage | undefined>;
      getProductImageData(input: { token: string; imageId: string; variant?: 'original' | 'thumbnail' }): Promise<string | null>;
      addProductImage(input: {
        token: string;
        input: {
          productId: string;
          originalDataUrl: string;
          thumbnailDataUrl: string;
          mimeType: 'image/webp' | 'image/jpeg' | 'image/png';
          width: number;
          height: number;
          originalName?: string;
        };
      }): Promise<ProductImage>;
      setPrimaryProductImage(input: { token: string; imageId: string }): Promise<ProductImage>;
      deleteProductImage(input: { token: string; imageId: string }): Promise<void>;
      cacheRemoteProductImage(input: {
        token: string;
        input: { record: ProductImage; originalDataUrl: string; thumbnailDataUrl: string };
      }): Promise<ProductImage>;
      applyRemoteProductImageTombstone(input: { token: string; record: ProductImage }): Promise<void>;
      markProductImageSynced(input: { token: string; imageId: string }): Promise<ProductImage | undefined>;
      saveProductAtomic(input: { token: string; product: Product; isUpdate?: boolean }): Promise<Product>;
      deleteProductAtomic(input: { token: string; productId: string }): Promise<void>;
      adjustProductStockAtomic(input: {
        token: string;
        params: {
          productId: string;
          deltaQuantity: number;
          reason: string;
          batchNumber?: string;
          expiryDate?: string;
        };
      }): Promise<Product>;
      getParties(input: { token: string; type?: 'CUSTOMER' | 'SUPPLIER' }): Promise<Party[]>;
      getPartyById(input: { token: string; id: string }): Promise<Party | undefined>;
      savePartyAtomic(input: { token: string; party: Party; isUpdate?: boolean }): Promise<Party>;

      getInvoices(input: { token: string; activityId?: CommercialActivityId | 'all' }): Promise<Invoice[]>;
      getInvoiceById(input: { token: string; id: string }): Promise<Invoice | undefined>;
      createSalesInvoiceAtomic(input: {
        token: string;
        params: {
          invoice: Invoice;
          totalCogs: number;
          stockDeductions: Array<{ invoiceItemId?: string; productId: string; quantity: number; batchNumber?: string }>;
          applyAdvanceAmount?: number;
          clientRequestId?: string;
        };
      }): Promise<{ success: boolean; invoice: Invoice; journalEntry: JournalEntry; advanceJournalEntry?: JournalEntry }>;
      createPurchaseInvoiceAtomic(input: {
        token: string;
        params: {
          invoice: Invoice;
          itemsWithBatches: Array<{
            invoiceItemId?: string;
            productId: string;
            unitId?: string;
            quantity: number;
            costPrice: number;
            batchNumber?: string;
            expiryDate?: string;
          }>;
          applyAdvanceAmount?: number;
          clientRequestId?: string;
        };
      }): Promise<{ success: boolean; invoice: Invoice; journalEntry: JournalEntry; advanceJournalEntry?: JournalEntry }>;
      createSalesReturnAtomic(input: {
        token: string;
        params: {
          originalInvoiceId: string;
          items: Array<{ originalInvoiceItemId?: string; productId: string; quantity: number; batchNumber?: string }>;
          returnReason: string;
          refundMethod: 'AUTO' | 'AR_OFFSET' | 'CASH' | 'ADVANCE';
          cashBoxId?: string;
          date?: string;
          clientRequestId?: string;
        };
      }): Promise<{ success: boolean; invoice: Invoice; journalEntry: JournalEntry }>;
      createPurchaseReturnAtomic(input: {
        token: string;
        params: {
          originalInvoiceId: string;
          items: Array<{ originalInvoiceItemId?: string; productId: string; quantity: number; batchNumber?: string }>;
          returnReason: string;
          refundMethod: 'AUTO' | 'AP_OFFSET' | 'CASH' | 'ADVANCE';
          cashBoxId?: string;
          date?: string;
          clientRequestId?: string;
        };
      }): Promise<{ success: boolean; invoice: Invoice; journalEntry: JournalEntry }>;
      getCashBoxes(input: { token: string }): Promise<CashBox[]>;
      createCashBoxAtomic(input: { token: string; box: CashBox }): Promise<CashBox>;
      getVouchers(input: { token: string }): Promise<PaymentVoucher[]>;
      createCashVoucherAtomic(input: {
        token: string;
        params: {
          voucher: PaymentVoucher;
          manualAllocations?: VoucherManualAllocationInput[];
          overrideReason?: string;
        };
      }): Promise<{
        success: boolean;
        voucher: PaymentVoucher;
        journalEntry?: JournalEntry;
        allocations?: PaymentAllocation[];
        advanceTransaction?: PartyAdvanceTransaction;
      }>;
      postDraftCashVoucherAtomic(input: {
        token: string;
        params: {
          voucherId: string;
          manualAllocations?: VoucherManualAllocationInput[];
          overrideReason?: string;
        };
      }): Promise<{
        success: boolean;
        voucher: PaymentVoucher;
        journalEntry: JournalEntry;
        allocations: PaymentAllocation[];
        advanceTransaction?: PartyAdvanceTransaction;
      }>;
      cancelCashVoucherAtomic(input: {
        token: string;
        params: { voucherId: string; reason: string };
      }): Promise<PaymentVoucher>;
      reverseCashVoucherAtomic(input: {
        token: string;
        params: { voucherId: string; reversalReason: string };
      }): Promise<{
        success: boolean;
        voucher: PaymentVoucher;
        reversalJournalEntry: JournalEntry;
      }>;
      getPaymentAllocations(input: {
        token: string;
        partyId?: string;
        voucherId?: string;
      }): Promise<PaymentAllocation[]>;
      getPartyAdvanceTransactions(input: {
        token: string;
        partyId?: string;
      }): Promise<PartyAdvanceTransaction[]>;
      getAllocationAudits(input: {
        token: string;
        voucherId?: string;
      }): Promise<AllocationAudit[]>;
      getAmanatRecords(input: { token: string }): Promise<AmanatRecord[]>;
      getAmanatById(input: { token: string; id: string }): Promise<AmanatRecord | undefined>;
      createAmanatDepositAtomic(input: {
        token: string;
        params: { record: AmanatRecord; cashBoxId?: string };
      }): Promise<{ success: boolean; record: AmanatRecord; journalEntry?: JournalEntry }>;
      returnAmanatAtomic(input: {
        token: string;
        params: {
          recordId: string;
          cashBoxId?: string;
          returnAmount?: number;
          recipientSignatureName?: string;
          notes?: string;
        };
      }): Promise<{ success: boolean; record: AmanatRecord; journalEntry?: JournalEntry }>;
      cancelAmanatAtomic(input: {
        token: string;
        params: { recordId: string; reason: string };
      }): Promise<{ success: boolean; record: AmanatRecord; journalEntry?: JournalEntry }>;
      updateAmanatRecord(input: { token: string; record: AmanatRecord }): Promise<void>;
      getJournalEntries(input: { token: string; costCenterId?: CostCenterId | 'all' }): Promise<JournalEntry[]>;
      getJournalEntryById(input: { token: string; id: string }): Promise<JournalEntry | undefined>;
      createJournalEntryAtomic(input: { token: string; entry: JournalEntry }): Promise<JournalEntry>;
      reverseJournalEntryAtomic(input: {
        token: string;
        originalEntryId: string;
        reversalReason: string;
      }): Promise<JournalEntry>;

      listNativeBackups(input: { token: string }): Promise<DesktopNativeBackupInfo[]>;
      createNativeBackupNow(input: { token: string; prefix?: string }): Promise<DesktopNativeBackupInfo & { copiedToCustomPath?: string | null }>;
      getBackupSettings(input: { token: string }): Promise<DesktopBackupSettings>;
      saveBackupSettings(input: { token: string; settings: Partial<DesktopBackupSettings> }): Promise<DesktopBackupSettings>;
      exportSqliteBackupDialog(input: { token: string }): Promise<{
        canceled: boolean;
        path?: string;
        filename?: string;
        sizeBytes?: number;
        schemaVersion?: number;
        createdAt?: string;
      }>;
      restoreSqliteBackupDialog(input: { token: string }): Promise<{
        canceled: boolean;
        success?: boolean;
        restoredFrom?: string;
        safetyBackupPath?: string;
      }>;
      restoreSqliteBackupPath(input: { token: string; sourcePath: string }): Promise<{
        success: boolean;
        restoredFrom: string;
        safetyBackupPath: string;
      }>;
      chooseBackupDirectoryDialog(input: { token: string }): Promise<{
        canceled: boolean;
        directory?: string;
      }>;
      exportBackupJSON(input: { token: string }): Promise<string>;
      importBackupJSON(input: { token: string; rawJson: string }): Promise<{
        success: boolean;
        error?: string;
        importId?: string;
        backupFilename?: string;
      }>;

      getOutboxQueue(input: {
        token: string;
        statusFilter?: OutboxQueueItem['status'] | 'all';
        sortDir?: 'asc' | 'desc';
      }): Promise<OutboxQueueItem[]>;
      getOutboxStats(input: { token: string }): Promise<{
        total: number;
        pending: number;
        syncing: number;
        synced: number;
        failed: number;
      }>;
      getPendingEntityKeys(input: { token: string }): Promise<string[]>;
      queueOutboxItem(input: {
        token: string;
        item: {
          entityType: OutboxQueueItem['entityType'];
          entityId: string;
          action: OutboxQueueItem['action'];
          payload: Record<string, unknown>;
          priority?: number;
          idempotencyKey?: string;
          tenantId?: string;
          branchId?: string;
          dependsOn?: string[];
        };
      }): Promise<OutboxQueueItem | null>;
      claimReadyToSyncItems(input: {
        token: string;
        workerId: string;
        limit?: number;
        leaseMs?: number;
      }): Promise<OutboxQueueItem[]>;
      markOutboxSynced(input: { token: string; id: string; serverTimestamp?: string }): Promise<void>;
      markOutboxFailed(input: {
        token: string;
        id: string;
        errorMessage: string;
        isPermanent?: boolean;
      }): Promise<void>;
      retryFailedItems(input: { token: string }): Promise<number>;
      purgeOldSyncedRecords(input: { token: string; olderThanDays?: number }): Promise<number>;
      recoverStuckSyncingItems(input: { token: string; leaseTimeoutMinutes?: number }): Promise<number>;
      getConflicts(input: { token: string }): Promise<SyncConflict[]>;
      recordConflict(input: {
        token: string;
        params: {
          tenantId?: string;
          branchId?: string;
          entityType: OutboxQueueItem['entityType'];
          entityId: string;
          localPayload: Record<string, unknown>;
          remotePayload: Record<string, unknown>;
          notes?: string;
        };
      }): Promise<SyncConflict>;
      resolveConflict(input: {
        token: string;
        conflictId: string;
        status: SyncConflict['status'];
        notes?: string;
      }): Promise<void>;
      applyRemoteSyncEntity(input: {
        token: string;
        entityType: OutboxQueueItem['entityType'];
        row: Record<string, unknown>;
      }): Promise<void>;

      getDiagnosticLog(input: { token: string; maxLines?: number }): Promise<{
        logFilePath: string;
        totalLines: number;
        entries: Array<{
          timestamp: string;
          level: string;
          category: string;
          message: string;
          meta?: unknown;
        }>;
        runtime: {
          ready: boolean;
          schemaVersion: number;
          sqliteVersion: string;
          appVersion: string;
          isPackaged: boolean;
          platform: string;
          arch: string;
        };
      }>;
      exportDiagnosticLogDialog(input: { token: string }): Promise<{
        canceled: boolean;
        path?: string;
        filename?: string;
        entryCount?: number;
      }>;
      exportDocumentPdf(input: {
        token: string;
        title?: string;
        pageSize?: 'A4' | '80mm' | '58mm';
        pdfBase64?: string;
      }): Promise<{
        canceled: boolean;
        status?: 'SAVED' | 'CANCELED' | 'CREATE_FAILED' | 'WRITE_FAILED' | 'PATH_UNREACHABLE';
        path?: string;
        filename?: string;
        sizeBytes?: number;
        source?: 'SNAPSHOT_PDF' | 'PRINT_TO_PDF';
        error?: string;
      }>;
      exportDocumentPng(input: {
        token: string;
        title?: string;
        bytesBase64: string;
      }): Promise<{
        canceled: boolean;
        status?: 'SAVED' | 'CANCELED' | 'CREATE_FAILED' | 'WRITE_FAILED' | 'PATH_UNREACHABLE';
        path?: string;
        filename?: string;
        sizeBytes?: number;
        error?: string;
      }>;
      runNativePrint(input: {
        token: string;
        pageSize?: 'A4' | '80mm' | '58mm';
        contentHeightMm?: number;
      }): Promise<{
        printed: boolean;
        canceled: boolean;
        outcome?: 'sent' | 'canceled' | 'failed' | 'unconfirmed' | 'window-unavailable';
        failureReason?: string;
      }>;
      prepareShareTempFile(input: {
        token: string;
        documentKind: string;
        fileName: string;
        bytesBase64: string;
        mimeType?: string;
      }): Promise<{
        tempToken: string;
        fileName: string;
        sizeBytes: number;
      }>;
      copyShareImageToClipboard(input: {
        token: string;
        tempToken: string;
        messageText: string;
      }): Promise<{
        copied: boolean;
        imageCopied?: boolean;
        sizeBytes?: number;
        error?: string;
      }>;
      revealShareTempFile(input: {
        token: string;
        tempToken: string;
      }): Promise<{ revealed: boolean; exists?: boolean; error?: string }>;
      cleanupShareTempFile(input: { token: string; tempToken: string }): Promise<{ cleaned: boolean }>;
      openWhatsAppUrl(input: { token: string; url: string }): Promise<{ opened: boolean; error?: string }>;

      onDataChanged(callback: (domains: string[]) => void): () => void;
      onAuthInvalidated(callback: (reason: string) => void): () => void;
    };
  }
}
