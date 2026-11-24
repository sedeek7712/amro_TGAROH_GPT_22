const { contextBridge, ipcRenderer } = require('electron');

const desktopBridge = Object.freeze({
  getRuntimeStatus: () => ipcRenderer.invoke('erp:runtime:status'),
  getAuthSetupStatus: () => ipcRenderer.invoke('erp:auth:setup-status'),
  createInitialAdmin: (input) => ipcRenderer.invoke('erp:auth:create-initial-admin', input),
  login: (input) => ipcRenderer.invoke('erp:auth:login', input),
  getCurrentActor: (input) => ipcRenderer.invoke('erp:auth:me', input),
  logout: (token) => ipcRenderer.invoke('erp:auth:logout', token),
  completeMandatoryPasswordChange: (input) =>
    ipcRenderer.invoke('erp:auth:complete-password-change', input),
  createUser: (input) => ipcRenderer.invoke('erp:auth:create-user', input),
  saveUserProfile: (input) => ipcRenderer.invoke('erp:auth:save-user-profile', input),
  adminResetPassword: (input) => ipcRenderer.invoke('erp:auth:admin-reset-password', input),
  switchUser: (input) => ipcRenderer.invoke('erp:auth:switch-user', input),

  previewLegacyBackup: (input) => ipcRenderer.invoke('erp:legacy:preview', input),
  importLegacyBackup: (input) => ipcRenderer.invoke('erp:legacy:import', input),

  getActivities: (input) => ipcRenderer.invoke('erp:core:get-activities', input),
  getBranches: (input) => ipcRenderer.invoke('erp:core:get-branches', input),
  getBranch: (input) => ipcRenderer.invoke('erp:core:get-branch', input),
  addBranch: (input) => ipcRenderer.invoke('erp:core:add-branch', input),
  updateBranch: (input) => ipcRenderer.invoke('erp:core:update-branch', input),
  getActiveBranchId: (input) => ipcRenderer.invoke('erp:core:get-active-branch-id', input),
  setActiveBranchId: (input) => ipcRenderer.invoke('erp:core:set-active-branch-id', input),
  getTerminalCode: (input) => ipcRenderer.invoke('erp:core:get-terminal-code', input),
  setTerminalCode: (input) => ipcRenderer.invoke('erp:core:set-terminal-code', input),
  getAccounts: (input) => ipcRenderer.invoke('erp:core:get-accounts', input),
  createAccountAtomic: (input) => ipcRenderer.invoke('erp:core:create-account', input),
  saveAccounts: (input) => ipcRenderer.invoke('erp:core:save-accounts', input),
  getUsers: (input) => ipcRenderer.invoke('erp:core:get-users', input),
  getAuditLogs: (input) => ipcRenderer.invoke('erp:core:get-audit-logs', input),
  logAction: (input) => ipcRenderer.invoke('erp:core:log-action', input),
  generateBranchInvoiceNumber: (input) => ipcRenderer.invoke('erp:core:generate-invoice-number', input),
  generateBranchVoucherNumber: (input) => ipcRenderer.invoke('erp:core:generate-voucher-number', input),
  getCompanyProfile: (input) => ipcRenderer.invoke('erp:core:get-company-profile', input),
  saveCompanyProfile: (input) => ipcRenderer.invoke('erp:core:save-company-profile', input),
  getSyncConfig: (input) => ipcRenderer.invoke('erp:core:get-sync-config', input),
  saveSyncConfig: (input) => ipcRenderer.invoke('erp:core:save-sync-config', input),
  resetToCleanBooks: (input) => ipcRenderer.invoke('erp:core:reset-clean-books', input),

  getProducts: (input) => ipcRenderer.invoke('erp:inventory:get-products', input),
  getProductById: (input) => ipcRenderer.invoke('erp:inventory:get-product', input),
  getProductImages: (input) => ipcRenderer.invoke('erp:inventory:get-product-images', input),
  getProductImageRecord: (input) => ipcRenderer.invoke('erp:inventory:get-product-image-record', input),
  getProductImageData: (input) => ipcRenderer.invoke('erp:inventory:get-product-image-data', input),
  addProductImage: (input) => ipcRenderer.invoke('erp:inventory:add-product-image', input),
  setPrimaryProductImage: (input) => ipcRenderer.invoke('erp:inventory:set-primary-product-image', input),
  deleteProductImage: (input) => ipcRenderer.invoke('erp:inventory:delete-product-image', input),
  cacheRemoteProductImage: (input) => ipcRenderer.invoke('erp:inventory:cache-remote-product-image', input),
  applyRemoteProductImageTombstone: (input) => ipcRenderer.invoke('erp:inventory:apply-remote-product-image-tombstone', input),
  markProductImageSynced: (input) => ipcRenderer.invoke('erp:inventory:mark-product-image-synced', input),
  saveProductAtomic: (input) => ipcRenderer.invoke('erp:inventory:save-product', input),
  deleteProductAtomic: (input) => ipcRenderer.invoke('erp:inventory:delete-product', input),
  adjustProductStockAtomic: (input) => ipcRenderer.invoke('erp:inventory:adjust-stock', input),

  getParties: (input) => ipcRenderer.invoke('erp:parties:get-parties', input),
  getPartyById: (input) => ipcRenderer.invoke('erp:parties:get-party', input),
  savePartyAtomic: (input) => ipcRenderer.invoke('erp:parties:save-party', input),

  getInvoices: (input) => ipcRenderer.invoke('erp:finance:get-invoices', input),
  getInvoiceById: (input) => ipcRenderer.invoke('erp:finance:get-invoice', input),
  createSalesInvoiceAtomic: (input) => ipcRenderer.invoke('erp:finance:create-sales-invoice', input),
  createPurchaseInvoiceAtomic: (input) => ipcRenderer.invoke('erp:finance:create-purchase-invoice', input),
  createSalesReturnAtomic: (input) => ipcRenderer.invoke('erp:finance:create-sales-return', input),
  createPurchaseReturnAtomic: (input) => ipcRenderer.invoke('erp:finance:create-purchase-return', input),
  getCashBoxes: (input) => ipcRenderer.invoke('erp:finance:get-cash-boxes', input),
  createCashBoxAtomic: (input) => ipcRenderer.invoke('erp:finance:create-cash-box', input),
  getVouchers: (input) => ipcRenderer.invoke('erp:finance:get-vouchers', input),
  createCashVoucherAtomic: (input) => ipcRenderer.invoke('erp:finance:create-cash-voucher', input),
  postDraftCashVoucherAtomic: (input) => ipcRenderer.invoke('erp:finance:post-draft-voucher', input),
  cancelCashVoucherAtomic: (input) => ipcRenderer.invoke('erp:finance:cancel-cash-voucher', input),
  reverseCashVoucherAtomic: (input) => ipcRenderer.invoke('erp:finance:reverse-cash-voucher', input),
  getPaymentAllocations: (input) => ipcRenderer.invoke('erp:finance:get-payment-allocations', input),
  getPartyAdvanceTransactions: (input) => ipcRenderer.invoke('erp:finance:get-party-advances', input),
  getAllocationAudits: (input) => ipcRenderer.invoke('erp:finance:get-allocation-audits', input),
  getAmanatRecords: (input) => ipcRenderer.invoke('erp:finance:get-amanat-records', input),
  getAmanatById: (input) => ipcRenderer.invoke('erp:finance:get-amanat', input),
  createAmanatDepositAtomic: (input) => ipcRenderer.invoke('erp:finance:create-amanat-deposit', input),
  returnAmanatAtomic: (input) => ipcRenderer.invoke('erp:finance:return-amanat', input),
  cancelAmanatAtomic: (input) => ipcRenderer.invoke('erp:finance:cancel-amanat', input),
  updateAmanatRecord: (input) => ipcRenderer.invoke('erp:finance:update-amanat', input),
  getJournalEntries: (input) => ipcRenderer.invoke('erp:finance:get-journal-entries', input),
  getJournalEntryById: (input) => ipcRenderer.invoke('erp:finance:get-journal-entry', input),
  createJournalEntryAtomic: (input) => ipcRenderer.invoke('erp:finance:create-journal-entry', input),
  reverseJournalEntryAtomic: (input) => ipcRenderer.invoke('erp:finance:reverse-journal-entry', input),

  // --- Batch D: Backups & Sync ---
  listNativeBackups: (input) => ipcRenderer.invoke('erp:backup:list', input),
  createNativeBackupNow: (input) => ipcRenderer.invoke('erp:backup:create-now', input),
  getBackupSettings: (input) => ipcRenderer.invoke('erp:backup:get-settings', input),
  saveBackupSettings: (input) => ipcRenderer.invoke('erp:backup:save-settings', input),
  exportSqliteBackupDialog: (input) => ipcRenderer.invoke('erp:backup:export-sqlite-dialog', input),
  restoreSqliteBackupDialog: (input) => ipcRenderer.invoke('erp:backup:restore-sqlite-dialog', input),
  restoreSqliteBackupPath: (input) => ipcRenderer.invoke('erp:backup:restore-sqlite-path', input),
  chooseBackupDirectoryDialog: (input) => ipcRenderer.invoke('erp:backup:choose-directory-dialog', input),
  exportBackupJSON: (input) => ipcRenderer.invoke('erp:backup:export-json', input),
  importBackupJSON: (input) => ipcRenderer.invoke('erp:backup:import-json', input),

  getOutboxQueue: (input) => ipcRenderer.invoke('erp:sync:get-outbox', input),
  getOutboxStats: (input) => ipcRenderer.invoke('erp:sync:get-outbox-stats', input),
  getPendingEntityKeys: (input) => ipcRenderer.invoke('erp:sync:get-pending-keys', input),
  queueOutboxItem: (input) => ipcRenderer.invoke('erp:sync:queue-outbox', input),
  claimReadyToSyncItems: (input) => ipcRenderer.invoke('erp:sync:claim-outbox', input),
  markOutboxSynced: (input) => ipcRenderer.invoke('erp:sync:mark-synced', input),
  markOutboxFailed: (input) => ipcRenderer.invoke('erp:sync:mark-failed', input),
  retryFailedItems: (input) => ipcRenderer.invoke('erp:sync:retry-failed', input),
  purgeOldSyncedRecords: (input) => ipcRenderer.invoke('erp:sync:purge-synced', input),
  recoverStuckSyncingItems: (input) => ipcRenderer.invoke('erp:sync:recover-stuck', input),
  getConflicts: (input) => ipcRenderer.invoke('erp:sync:get-conflicts', input),
  recordConflict: (input) => ipcRenderer.invoke('erp:sync:record-conflict', input),
  resolveConflict: (input) => ipcRenderer.invoke('erp:sync:resolve-conflict', input),
  applyRemoteSyncEntity: (input) => ipcRenderer.invoke('erp:sync:apply-remote', input),

  // --- Diagnostics, Print & Share ---
  getDiagnosticLog: (input) => ipcRenderer.invoke('erp:diagnostics:get-log', input),
  exportDiagnosticLogDialog: (input) => ipcRenderer.invoke('erp:diagnostics:export-dialog', input),
  exportDocumentPdf: (input) => ipcRenderer.invoke('erp:print:export-pdf', input),
  exportDocumentPng: (input) => ipcRenderer.invoke('erp:print:export-png', input),
  runNativePrint: (input) => ipcRenderer.invoke('erp:print:run-native', input),
  prepareShareTempFile: (input) => ipcRenderer.invoke('erp:share:prepare-temp-file', input),
  copyShareImageToClipboard: (input) => ipcRenderer.invoke('erp:share:copy-image-to-clipboard', input),
  revealShareTempFile: (input) => ipcRenderer.invoke('erp:share:reveal-temp-file', input),
  cleanupShareTempFile: (input) => ipcRenderer.invoke('erp:share:cleanup-temp-file', input),
  openWhatsAppUrl: (input) => ipcRenderer.invoke('erp:share:open-whatsapp-url', input),

  onDataChanged: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, domains) => callback(Array.isArray(domains) ? domains : ['all']);
    ipcRenderer.on('erp:data:changed', handler);
    return () => ipcRenderer.removeListener('erp:data:changed', handler);
  },

  onAuthInvalidated: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload && payload.reason ? payload.reason : '');
    ipcRenderer.on('erp:auth:invalidated', handler);
    return () => ipcRenderer.removeListener('erp:auth:invalidated', handler);
  },
});

contextBridge.exposeInMainWorld('amroDesktop', desktopBridge);
