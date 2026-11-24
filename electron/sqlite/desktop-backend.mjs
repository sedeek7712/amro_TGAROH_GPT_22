import { createCoreService } from './modules/core-service.mjs';
import { createInventoryPartiesService } from './modules/inventory-parties-service.mjs';
import { createFinancialService } from './modules/financial-service.mjs';
import { createBackupSyncService } from './modules/backup-sync-service.mjs';
import { createProductMediaStorage } from '../product-media-storage.mjs';
import { createProductMediaService } from './modules/product-media-service.mjs';
import { importLegacyBackup, previewLegacyBackup } from './legacy-backup-importer.mjs';
import { PermissionError } from './rbac.mjs';

export function createDesktopBackend({
  database,
  backupDirectory,
  mediaDirectory,
  authenticationService,
  onDataChanged = () => {},
}) {
  if (!database || !authenticationService) {
    throw new TypeError('database and authenticationService are required');
  }

  const core = createCoreService(database);
  const inventoryParties = createInventoryPartiesService(database, core);
  const financial = createFinancialService(database, core);
  const backupSync = createBackupSyncService(database, backupDirectory);
  const mediaStorage = createProductMediaStorage({ rootDirectory: mediaDirectory || `${backupDirectory || process.cwd()}.product-media` });
  const productMedia = createProductMediaService(database, mediaStorage);

  function requireActor(token, requestedBranchId) {
    const actor = authenticationService.getActor(token, requestedBranchId);
    if (!actor) {
      throw new PermissionError('انتهت الجلسة أو الرمز غير صالح؛ يرجى تسجيل الدخول مجدداً.', 'auth:session');
    }
    return actor;
  }

  return {
    core,
    inventoryParties,
    financial,
    backupSync,
    productMediaStorage: mediaStorage,
    requireActor,

    // --- Runtime & Auth ---
    getRuntimeStatus() {
      const latest = database.prepare(
        'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations'
      ).get();
      const sqliteVersion = database.prepare('SELECT sqlite_version() AS version').get();
      return {
        ready: true,
        schemaVersion: latest.version,
        sqliteVersion: sqliteVersion.version,
      };
    },

    // --- Legacy Dexie JSON Import (Allowed on fresh unconfigured DB OR authenticated ADMIN) ---
    previewLegacyBackup({ rawJson, token }) {
      const setup = authenticationService.getSetupStatus();
      const isFreshUnconfigured = setup.setupRequired && setup.userCount === 0;
      if (!isFreshUnconfigured) {
        const actor = requireActor(token);
        if (actor.role !== 'ADMIN') {
          throw new PermissionError('حظر صلاحيات: معاينة واستيراد النسخ القديمة محصورة بالمدير العام.', 'backup:manage');
        }
      }
      return previewLegacyBackup(rawJson);
    },

    async importLegacyBackup({ rawJson, token }) {
      const setup = authenticationService.getSetupStatus();
      const isFreshUnconfigured = setup.setupRequired && setup.userCount === 0;
      if (!isFreshUnconfigured) {
        const actor = requireActor(token);
        if (actor.role !== 'ADMIN') {
          throw new PermissionError('حظر صلاحيات: استيراد النسخ القديمة محصور بالمدير العام.', 'backup:manage');
        }
      }
      const result = await importLegacyBackup(database, backupDirectory, rawJson);
      onDataChanged(['all']);
      return result;
    },

    // --- User Management via Auth Service ---
    createUser({ token, input }) {
      const created = authenticationService.createUser({ token, input });
      onDataChanged(['users', 'auditLogs']);
      return created;
    },

    saveUserProfile({ token, user }) {
      const saved = authenticationService.saveUserProfile({ token, user });
      onDataChanged(['users', 'auditLogs']);
      return saved;
    },

    adminResetPassword({ token, targetUserId, newPassword }) {
      const updated = authenticationService.adminResetPassword({ token, targetUserId, newPassword });
      onDataChanged(['users', 'auditLogs']);
      return updated;
    },

    switchUser({ token, adminPassword, targetUserId }) {
      const result = authenticationService.switchUser({ token, adminPassword, targetUserId });
      if (result.success) {
        onDataChanged(['session', 'auditLogs']);
      }
      return result;
    },

    // --- Core Domain Methods ---
    getActivities({ token }) {
      const actor = requireActor(token);
      return core.getActivities(actor);
    },

    getBranches({ token }) {
      const actor = requireActor(token);
      return core.getBranches(actor);
    },

    getBranch({ token, branchId }) {
      const actor = requireActor(token);
      return core.getBranch(actor, branchId);
    },

    addBranch({ token, branch }) {
      const actor = requireActor(token);
      const created = core.addBranch(actor, branch);
      onDataChanged(['branches', 'outbox', 'auditLogs']);
      return created;
    },

    updateBranch({ token, branch }) {
      const actor = requireActor(token);
      const updated = core.updateBranch(actor, branch);
      onDataChanged(['branches', 'outbox', 'auditLogs']);
      return updated;
    },

    getActiveBranchId({ token }) {
      const actor = requireActor(token);
      return core.getActiveBranchId(actor);
    },

    setActiveBranchId({ token, branchId }) {
      const actor = requireActor(token);
      const next = core.setActiveBranchId(actor, branchId);
      onDataChanged(['branches', 'session']);
      return next;
    },

    getTerminalCode({ token }) {
      const actor = requireActor(token);
      return core.getTerminalCode(actor);
    },

    setTerminalCode({ token, terminalCode }) {
      const actor = requireActor(token);
      const next = core.setTerminalCode(actor, terminalCode);
      onDataChanged(['settings']);
      return next;
    },

    getAccounts({ token }) {
      const actor = requireActor(token);
      return core.getAccounts(actor);
    },

    createAccountAtomic({ token, account }) {
      const actor = requireActor(token);
      const created = core.createAccountAtomic(actor, account);
      onDataChanged(['accounts', 'outbox', 'auditLogs']);
      return created;
    },

    saveAccounts({ token, accounts }) {
      const actor = requireActor(token);
      core.saveAccounts(actor, accounts);
      onDataChanged(['accounts', 'auditLogs']);
    },

    getUsers({ token }) {
      const actor = requireActor(token);
      return core.getUsers(actor);
    },

    getAuditLogs({ token }) {
      const actor = requireActor(token);
      return core.getAuditLogs(actor);
    },

    logAction({ token, action, details }) {
      const actor = requireActor(token);
      const entry = core.logAction(actor, action, details);
      onDataChanged(['auditLogs']);
      return entry;
    },

    generateBranchInvoiceNumber({ token, type, branchCode, terminalCode }) {
      const actor = requireActor(token);
      return core.generateBranchInvoiceNumber(actor, type, branchCode, terminalCode);
    },

    generateBranchVoucherNumber({ token, type, branchCode, terminalCode }) {
      const actor = requireActor(token);
      return core.generateBranchVoucherNumber(actor, type, branchCode, terminalCode);
    },

    getCompanyProfile({ token }) {
      const actor = requireActor(token);
      return core.getCompanyProfile(actor);
    },

    saveCompanyProfile({ token, profile }) {
      const actor = requireActor(token);
      const updated = core.saveCompanyProfile(actor, profile);
      onDataChanged(['settings', 'auditLogs']);
      return updated;
    },

    getSyncConfig({ token, kind }) {
      const actor = requireActor(token);
      return core.getSyncConfig(actor, kind);
    },

    saveSyncConfig({ token, kind, config }) {
      const actor = requireActor(token);
      const saved = core.saveSyncConfig(actor, kind, config);
      onDataChanged(['settings', 'auditLogs']);
      return saved;
    },

    resetToCleanBooks({ token }) {
      const actor = requireActor(token);
      core.resetToCleanBooks(actor);
      onDataChanged(['all']);
    },

    // --- Batch B: Products, Product Batches & Parties ---
    getProducts({ token, activityId }) {
      const actor = requireActor(token);
      return inventoryParties.getProducts(actor, activityId);
    },

    getProductById({ token, id }) {
      const actor = requireActor(token);
      return inventoryParties.getProductById(actor, id);
    },

    getProductImages({ token, productId }) {
      return productMedia.getProductImages(requireActor(token), productId);
    },

    getProductImageRecord({ token, imageId }) {
      return productMedia.getProductImageRecord(requireActor(token), imageId);
    },

    getProductImageData({ token, imageId, variant }) {
      return productMedia.getProductImageData(requireActor(token), imageId, variant);
    },

    addProductImage({ token, input }) {
      const result = productMedia.addProductImage(requireActor(token), input);
      onDataChanged(['productImages', 'outbox', 'auditLogs']);
      return result;
    },

    setPrimaryProductImage({ token, imageId }) {
      const result = productMedia.setPrimaryProductImage(requireActor(token), imageId);
      onDataChanged(['productImages', 'outbox', 'auditLogs']);
      return result;
    },

    deleteProductImage({ token, imageId }) {
      productMedia.deleteProductImage(requireActor(token), imageId);
      onDataChanged(['productImages', 'outbox', 'auditLogs']);
    },

    cacheRemoteProductImage({ token, input }) {
      const result = productMedia.cacheRemoteProductImage(requireActor(token), input);
      onDataChanged(['productImages']);
      return result;
    },

    applyRemoteProductImageTombstone({ token, record }) {
      productMedia.applyRemoteProductImageTombstone(requireActor(token), record);
      onDataChanged(['productImages']);
    },

    markProductImageSynced({ token, imageId }) {
      const result = productMedia.markProductImageSynced(requireActor(token), imageId);
      onDataChanged(['productImages']);
      return result;
    },

    saveProductAtomic({ token, product, isUpdate }) {
      const actor = requireActor(token);
      const saved = inventoryParties.saveProductAtomic(actor, product, Boolean(isUpdate));
      onDataChanged(['products', 'outbox', 'auditLogs']);
      return saved;
    },

    deleteProductAtomic({ token, productId }) {
      const actor = requireActor(token);
      inventoryParties.deleteProductAtomic(actor, productId);
      onDataChanged(['products', 'outbox', 'auditLogs']);
    },

    adjustProductStockAtomic({ token, params }) {
      const actor = requireActor(token);
      const updated = inventoryParties.adjustProductStockAtomic(actor, params);
      onDataChanged(['products', 'outbox', 'auditLogs']);
      return updated;
    },

    getParties({ token, type }) {
      const actor = requireActor(token);
      return inventoryParties.getParties(actor, type);
    },

    getPartyById({ token, id }) {
      const actor = requireActor(token);
      return inventoryParties.getPartyById(actor, id);
    },

    savePartyAtomic({ token, party, isUpdate }) {
      const actor = requireActor(token);
      const saved = inventoryParties.savePartyAtomic(actor, party, Boolean(isUpdate));
      onDataChanged(['parties', 'outbox', 'auditLogs']);
      return saved;
    },

    // --- Batch C: Financial Engine (Invoices, CashBoxes, Vouchers, Amanat, Journals) ---
    getInvoices({ token, activityId }) {
      const actor = requireActor(token);
      return financial.getInvoices(actor, activityId);
    },

    getInvoiceById({ token, id }) {
      const actor = requireActor(token);
      return financial.getInvoiceById(actor, id);
    },

    createSalesInvoiceAtomic({ token, params }) {
      const actor = requireActor(token);
      const result = financial.createSalesInvoiceAtomic(actor, params);
      onDataChanged([
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
      return result;
    },

    createPurchaseInvoiceAtomic({ token, params }) {
      const actor = requireActor(token);
      const result = financial.createPurchaseInvoiceAtomic(actor, params);
      onDataChanged([
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
      return result;
    },

    createSalesReturnAtomic({ token, params }) {
      const actor = requireActor(token);
      const result = financial.createSalesReturnAtomic(actor, params);
      onDataChanged([
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
      return result;
    },

    createPurchaseReturnAtomic({ token, params }) {
      const actor = requireActor(token);
      const result = financial.createPurchaseReturnAtomic(actor, params);
      onDataChanged([
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
      return result;
    },

    getCashBoxes({ token }) {
      const actor = requireActor(token);
      return financial.getCashBoxes(actor);
    },

    createCashBoxAtomic({ token, box }) {
      const actor = requireActor(token);
      const created = financial.createCashBoxAtomic(actor, box);
      onDataChanged(['cashBoxes', 'outbox', 'auditLogs']);
      return created;
    },

    getVouchers({ token }) {
      const actor = requireActor(token);
      return financial.getVouchers(actor);
    },

    createCashVoucherAtomic({ token, params }) {
      const actor = requireActor(token);
      const result = financial.createCashVoucherAtomic(actor, params);
      onDataChanged([
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
      return result;
    },

    postDraftCashVoucherAtomic({ token, params }) {
      const actor = requireActor(token);
      const result = financial.postDraftCashVoucherAtomic(actor, params);
      onDataChanged([
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
      return result;
    },

    cancelCashVoucherAtomic({ token, params }) {
      const actor = requireActor(token);
      const result = financial.cancelCashVoucherAtomic(actor, params);
      onDataChanged(['vouchers', 'outbox', 'auditLogs']);
      return result;
    },

    reverseCashVoucherAtomic({ token, params }) {
      const actor = requireActor(token);
      const result = financial.reverseCashVoucherAtomic(actor, params);
      onDataChanged([
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
      return result;
    },

    getPaymentAllocations({ token, partyId, voucherId }) {
      const actor = requireActor(token);
      return financial.getPaymentAllocations(actor, partyId, voucherId);
    },

    getPartyAdvanceTransactions({ token, partyId }) {
      const actor = requireActor(token);
      return financial.getPartyAdvanceTransactions(actor, partyId);
    },

    getAllocationAudits({ token, voucherId }) {
      const actor = requireActor(token);
      return financial.getAllocationAudits(actor, voucherId);
    },

    getAmanatRecords({ token }) {
      const actor = requireActor(token);
      return financial.getAmanatRecords(actor);
    },

    getAmanatById({ token, id }) {
      const actor = requireActor(token);
      return financial.getAmanatById(actor, id);
    },

    createAmanatDepositAtomic({ token, params }) {
      const actor = requireActor(token);
      const result = financial.createAmanatDepositAtomic(actor, params);
      onDataChanged(['amanat', 'cashBoxes', 'accounts', 'journalEntries', 'outbox', 'auditLogs']);
      return result;
    },

    returnAmanatAtomic({ token, params }) {
      const actor = requireActor(token);
      const result = financial.returnAmanatAtomic(actor, params);
      onDataChanged(['amanat', 'cashBoxes', 'accounts', 'journalEntries', 'outbox', 'auditLogs']);
      return result;
    },

    cancelAmanatAtomic({ token, params }) {
      const actor = requireActor(token);
      const result = financial.cancelAmanatAtomic(actor, params);
      onDataChanged(['amanat', 'cashBoxes', 'accounts', 'journalEntries', 'outbox', 'auditLogs']);
      return result;
    },

    updateAmanatRecord({ token, record }) {
      const actor = requireActor(token);
      financial.updateAmanatRecord(actor, record);
      onDataChanged(['amanat', 'outbox', 'auditLogs']);
    },

    getJournalEntries({ token, costCenterId }) {
      const actor = requireActor(token);
      return financial.getJournalEntries(actor, costCenterId);
    },

    getJournalEntryById({ token, id }) {
      const actor = requireActor(token);
      return financial.getJournalEntryById(actor, id);
    },

    createJournalEntryAtomic({ token, entry }) {
      const actor = requireActor(token);
      const created = financial.createJournalEntryAtomic(actor, entry);
      onDataChanged(['journalEntries', 'accounts', 'cashBoxes', 'outbox', 'auditLogs']);
      return created;
    },

    reverseJournalEntryAtomic({ token, originalEntryId, reversalReason }) {
      const actor = requireActor(token);
      const reversed = financial.reverseJournalEntryAtomic(actor, originalEntryId, reversalReason);
      onDataChanged(['journalEntries', 'accounts', 'cashBoxes', 'outbox', 'auditLogs']);
      return reversed;
    },

    // --- Batch D: Native SQLite Backup/Restore, JSON Backup & Sync Outbox/Conflicts ---
    getBackupSettings({ token }) {
      const actor = requireActor(token);
      return backupSync.getBackupSettings(actor);
    },

    saveBackupSettings({ token, settings }) {
      const actor = requireActor(token);
      const updated = backupSync.saveBackupSettings(actor, settings);
      onDataChanged(['settings', 'auditLogs']);
      return updated;
    },

    listNativeBackups({ token }) {
      const actor = requireActor(token);
      return backupSync.listNativeBackups(actor);
    },

    async createNativeBackupNow({ token, prefix }) {
      const actor = requireActor(token);
      const created = await backupSync.createNativeBackupNow(actor, prefix);
      mediaStorage.backupTo(created.path + '.media');
      if (created.copiedToCustomPath) mediaStorage.backupTo(created.copiedToCustomPath + '.media');
      onDataChanged(['backups', 'auditLogs']);
      return created;
    },

    async exportNativeBackupToPath({ token, destinationPath }) {
      const actor = requireActor(token);
      const exported = await backupSync.exportNativeBackupToPath(actor, destinationPath);
      mediaStorage.backupTo(exported.path + '.media');
      onDataChanged(['auditLogs']);
      return exported;
    },

    exportBackupJSON({ token }) {
      const actor = requireActor(token);
      return backupSync.exportBackupJSON(actor);
    },

    async importBackupJSON({ token, rawJson }) {
      const actor = requireActor(token);
      const result = await backupSync.importBackupJSON(actor, rawJson);
      if (result.success) {
        onDataChanged(['all']);
      }
      return result;
    },

    getOutboxQueue({ token, statusFilter, sortDir }) {
      const actor = requireActor(token);
      return backupSync.getOutboxQueue(actor, statusFilter, sortDir);
    },

    getOutboxStats({ token }) {
      const actor = requireActor(token);
      return backupSync.getOutboxStats(actor);
    },

    getPendingEntityKeys({ token }) {
      const actor = requireActor(token);
      return backupSync.getPendingEntityKeys(actor);
    },

    queueOutboxItem({ token, item }) {
      const actor = requireActor(token);
      const queued = backupSync.queueOutboxItem(actor, item);
      onDataChanged(['outbox']);
      return queued;
    },

    claimReadyToSyncItems({ token, workerId, limit, leaseMs }) {
      const actor = requireActor(token);
      const claimed = backupSync.claimReadyToSyncItems(actor, workerId, limit, leaseMs);
      if (claimed.length > 0) {
        onDataChanged(['outbox']);
      }
      return claimed;
    },

    markOutboxSynced({ token, id, serverTimestamp }) {
      const actor = requireActor(token);
      backupSync.markOutboxSynced(actor, id, serverTimestamp);
      onDataChanged(['outbox']);
    },

    markOutboxFailed({ token, id, errorMessage, isPermanent }) {
      const actor = requireActor(token);
      backupSync.markOutboxFailed(actor, id, errorMessage, Boolean(isPermanent));
      onDataChanged(['outbox']);
    },

    retryFailedItems({ token }) {
      const actor = requireActor(token);
      const count = backupSync.retryFailedItems(actor);
      if (count > 0) {
        onDataChanged(['outbox']);
      }
      return count;
    },

    purgeOldSyncedRecords({ token, olderThanDays }) {
      const actor = requireActor(token);
      const count = backupSync.purgeOldSyncedRecords(actor, olderThanDays);
      if (count > 0) {
        onDataChanged(['outbox']);
      }
      return count;
    },

    recoverStuckSyncingItems({ token, leaseTimeoutMinutes }) {
      const actor = requireActor(token);
      const count = backupSync.recoverStuckSyncingItems(actor, leaseTimeoutMinutes);
      if (count > 0) {
        onDataChanged(['outbox']);
      }
      return count;
    },

    getConflicts({ token }) {
      const actor = requireActor(token);
      return backupSync.getConflicts(actor);
    },

    recordConflict({ token, params }) {
      const actor = requireActor(token);
      const conflict = backupSync.recordConflict(actor, params);
      onDataChanged(['conflicts', 'outbox']);
      return conflict;
    },

    resolveConflict({ token, conflictId, status, notes }) {
      const actor = requireActor(token);
      backupSync.resolveConflict(actor, conflictId, status, notes);
      onDataChanged(['conflicts', 'auditLogs']);
    },

    applyRemoteEntity({ token, entityType, row }) {
      const actor = requireActor(token);
      backupSync.applyRemoteEntity(actor, entityType, row);
      onDataChanged(['all']);
    },
  };
}
