import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  backupSqliteToDestination,
  createSqliteBackup,
  openErpDatabase,
  restoreSqliteBackupFile,
} from './sqlite/database.mjs';
import { getAppSetting } from './sqlite/modules/core-service.mjs';
import { pruneAutoExitBackups } from './sqlite/modules/backup-sync-service.mjs';
import { assertPermission } from './sqlite/rbac.mjs';
import { DesktopAuthenticationService } from './security/authentication.mjs';
import { createDesktopBackend } from './sqlite/desktop-backend.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const STABLE_DATA_FOLDER = 'AmroAlnmaryERP';

let mainWindow = null;
let databaseRuntime = null;
let authenticationService = null;
let desktopBackend = null;
let shuttingDown = false;
let exitBackupCompleted = false;

// The data directory is intentionally independent from the EXE installation directory
// and remains stable even if the application display name changes.
const stableUserDataPath = path.join(app.getPath('appData'), STABLE_DATA_FOLDER);
app.setName(STABLE_DATA_FOLDER);
app.setAppUserModelId('com.amroalnmary.erp');
app.setPath('userData', stableUserDataPath);

const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  function assertTrustedMainFrame(event) {
    if (
      !mainWindow ||
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    ) {
      throw new Error('Rejected IPC call from an untrusted renderer frame');
    }
  }

  function emitDataChanged(domains) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('erp:data:changed', Array.isArray(domains) ? domains : ['all']);
    }
  }

  function emitAuthInvalidated(reason) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('erp:auth:invalidated', {
        reason: String(reason || 'تم استعادة قاعدة البيانات؛ يرجى تسجيل الدخول مجدداً.'),
      });
    }
  }

  function bindDatabaseRuntime(runtime) {
    databaseRuntime = runtime;
    authenticationService = new DesktopAuthenticationService(databaseRuntime.database);
    desktopBackend = createDesktopBackend({
      database: databaseRuntime.database,
      backupDirectory: databaseRuntime.backupDirectory,
      authenticationService,
      onDataChanged: emitDataChanged,
    });
  }

  async function performSqliteRestore(token, sourceBackupPath) {
    const actor = desktopBackend.requireActor(token);
    assertPermission(actor, 'backup:restore', 'استعادة نسخة احتياطية SQLite');
    const reopenOptions = { userDataPath: app.getPath('userData') };
    try {
      const restored = await restoreSqliteBackupFile({
        databasePath: databaseRuntime.databasePath,
        backupDirectory: databaseRuntime.backupDirectory,
        sourceBackupPath,
        currentDatabase: databaseRuntime.database,
        reopenOptions,
      });
      bindDatabaseRuntime(restored.databaseRuntime);
      emitAuthInvalidated('تمت استعادة قاعدة البيانات من النسخة الاحتياطية؛ يرجى تسجيل الدخول مجدداً.');
      emitDataChanged(['all', 'session']);
      return {
        success: true,
        restoredFrom: restored.restoredFrom,
        safetyBackupPath: restored.safetyBackupPath,
      };
    } catch (error) {
      if (error && error.rolledBackRuntime) {
        bindDatabaseRuntime(error.rolledBackRuntime);
        emitAuthInvalidated('تعذرت استعادة النسخة وتم التراجع للوضع الآمن؛ يرجى تسجيل الدخول مجدداً.');
        emitDataChanged(['all', 'session']);
      }
      throw error;
    }
  }

  function registerSafeIpcHandlers() {
    ipcMain.handle('erp:runtime:status', (event) => {
      assertTrustedMainFrame(event);
      return {
        ...desktopBackend.getRuntimeStatus(),
        databaseFile: path.basename(databaseRuntime.databasePath),
      };
    });

    ipcMain.handle('erp:auth:setup-status', (event) => {
      assertTrustedMainFrame(event);
      return authenticationService.getSetupStatus();
    });

    ipcMain.handle('erp:auth:create-initial-admin', (event, input) => {
      assertTrustedMainFrame(event);
      const res = authenticationService.createInitialAdmin(input);
      emitDataChanged(['users', 'auditLogs', 'branches', 'accounts']);
      return res;
    });

    ipcMain.handle('erp:auth:login', (event, input) => {
      assertTrustedMainFrame(event);
      return authenticationService.authenticate(input);
    });

    ipcMain.handle('erp:auth:me', (event, input) => {
      assertTrustedMainFrame(event);
      return authenticationService.getActor(input?.token, input?.branchId);
    });

    ipcMain.handle('erp:auth:logout', (event, token) => {
      assertTrustedMainFrame(event);
      return authenticationService.logout(token);
    });

    ipcMain.handle('erp:auth:complete-password-change', (event, input) => {
      assertTrustedMainFrame(event);
      return authenticationService.completeMandatoryPasswordChange(input);
    });

    ipcMain.handle('erp:auth:create-user', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.createUser({ token: input?.token, input: input?.input });
    });

    ipcMain.handle('erp:auth:save-user-profile', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.saveUserProfile({ token: input?.token, user: input?.user });
    });

    ipcMain.handle('erp:auth:admin-reset-password', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.adminResetPassword({
        token: input?.token,
        targetUserId: input?.targetUserId,
        newPassword: input?.newPassword,
      });
    });

    ipcMain.handle('erp:auth:switch-user', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.switchUser({
        token: input?.token,
        adminPassword: input?.adminPassword,
        targetUserId: input?.targetUserId,
      });
    });

    // --- Legacy Dexie JSON Preview / Import ---
    ipcMain.handle('erp:legacy:preview', (event, input) => {
      assertTrustedMainFrame(event);
      if (!input || typeof input.rawJson !== 'string') {
        throw new Error('محتوى ملف النسخة الاحتياطية غير صالح.');
      }
      return desktopBackend.previewLegacyBackup({ rawJson: input.rawJson, token: input.token });
    });

    ipcMain.handle('erp:legacy:import', async (event, input) => {
      assertTrustedMainFrame(event);
      if (!input || typeof input.rawJson !== 'string') {
        throw new Error('محتوى ملف النسخة الاحتياطية غير صالح.');
      }
      return await desktopBackend.importLegacyBackup({ rawJson: input.rawJson, token: input.token });
    });

    // --- Batch A: Core Settings, Branches, Accounts, Users, Audit, Sequences ---
    ipcMain.handle('erp:core:get-activities', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getActivities({ token: input?.token });
    });

    ipcMain.handle('erp:core:get-branches', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getBranches({ token: input?.token });
    });

    ipcMain.handle('erp:core:get-branch', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getBranch({ token: input?.token, branchId: input?.branchId });
    });

    ipcMain.handle('erp:core:add-branch', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.addBranch({ token: input?.token, branch: input?.branch });
    });

    ipcMain.handle('erp:core:update-branch', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.updateBranch({ token: input?.token, branch: input?.branch });
    });

    ipcMain.handle('erp:core:get-active-branch-id', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getActiveBranchId({ token: input?.token });
    });

    ipcMain.handle('erp:core:set-active-branch-id', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.setActiveBranchId({ token: input?.token, branchId: input?.branchId });
    });

    ipcMain.handle('erp:core:get-terminal-code', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getTerminalCode({ token: input?.token });
    });

    ipcMain.handle('erp:core:set-terminal-code', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.setTerminalCode({ token: input?.token, terminalCode: input?.terminalCode });
    });

    ipcMain.handle('erp:core:get-accounts', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getAccounts({ token: input?.token });
    });

    ipcMain.handle('erp:core:create-account', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.createAccountAtomic({ token: input?.token, account: input?.account });
    });

    ipcMain.handle('erp:core:save-accounts', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.saveAccounts({ token: input?.token, accounts: input?.accounts });
    });

    ipcMain.handle('erp:core:get-users', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getUsers({ token: input?.token });
    });

    ipcMain.handle('erp:core:get-audit-logs', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getAuditLogs({ token: input?.token });
    });

    ipcMain.handle('erp:core:log-action', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.logAction({
        token: input?.token,
        action: input?.action,
        details: input?.details,
      });
    });

    ipcMain.handle('erp:core:generate-invoice-number', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.generateBranchInvoiceNumber({
        token: input?.token,
        type: input?.type,
        branchCode: input?.branchCode,
        terminalCode: input?.terminalCode,
      });
    });

    ipcMain.handle('erp:core:generate-voucher-number', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.generateBranchVoucherNumber({
        token: input?.token,
        type: input?.type,
        branchCode: input?.branchCode,
        terminalCode: input?.terminalCode,
      });
    });

    ipcMain.handle('erp:core:get-company-profile', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getCompanyProfile({ token: input?.token });
    });

    ipcMain.handle('erp:core:save-company-profile', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.saveCompanyProfile({ token: input?.token, profile: input?.profile });
    });

    ipcMain.handle('erp:core:get-sync-config', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getSyncConfig({ token: input?.token, kind: input?.kind });
    });

    ipcMain.handle('erp:core:save-sync-config', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.saveSyncConfig({
        token: input?.token,
        kind: input?.kind,
        config: input?.config,
      });
    });

    ipcMain.handle('erp:core:reset-clean-books', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.resetToCleanBooks({ token: input?.token });
    });

    // --- Batch B: Inventory & Parties ---
    ipcMain.handle('erp:inventory:get-products', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getProducts({ token: input?.token, activityId: input?.activityId });
    });

    ipcMain.handle('erp:inventory:get-product', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getProductById({ token: input?.token, id: input?.id });
    });

    ipcMain.handle('erp:inventory:save-product', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.saveProductAtomic({
        token: input?.token,
        product: input?.product,
        isUpdate: input?.isUpdate,
      });
    });

    ipcMain.handle('erp:inventory:delete-product', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.deleteProductAtomic({
        token: input?.token,
        productId: input?.productId,
      });
    });

    ipcMain.handle('erp:inventory:adjust-stock', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.adjustProductStockAtomic({
        token: input?.token,
        params: input?.params,
      });
    });

    ipcMain.handle('erp:parties:get-parties', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getParties({ token: input?.token, type: input?.type });
    });

    ipcMain.handle('erp:parties:get-party', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getPartyById({ token: input?.token, id: input?.id });
    });

    ipcMain.handle('erp:parties:save-party', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.savePartyAtomic({
        token: input?.token,
        party: input?.party,
        isUpdate: input?.isUpdate,
      });
    });

    // --- Batch C: Financial Engine ---
    ipcMain.handle('erp:finance:get-invoices', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getInvoices({ token: input?.token, activityId: input?.activityId });
    });

    ipcMain.handle('erp:finance:get-invoice', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getInvoiceById({ token: input?.token, id: input?.id });
    });

    ipcMain.handle('erp:finance:create-sales-invoice', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.createSalesInvoiceAtomic({ token: input?.token, params: input?.params });
    });

    ipcMain.handle('erp:finance:create-purchase-invoice', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.createPurchaseInvoiceAtomic({ token: input?.token, params: input?.params });
    });

    ipcMain.handle('erp:finance:get-cash-boxes', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getCashBoxes({ token: input?.token });
    });

    ipcMain.handle('erp:finance:create-cash-box', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.createCashBoxAtomic({ token: input?.token, box: input?.box });
    });

    ipcMain.handle('erp:finance:get-vouchers', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getVouchers({ token: input?.token });
    });

    ipcMain.handle('erp:finance:create-cash-voucher', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.createCashVoucherAtomic({ token: input?.token, params: input?.params });
    });

    ipcMain.handle('erp:finance:get-amanat-records', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getAmanatRecords({ token: input?.token });
    });

    ipcMain.handle('erp:finance:get-amanat', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getAmanatById({ token: input?.token, id: input?.id });
    });

    ipcMain.handle('erp:finance:create-amanat-deposit', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.createAmanatDepositAtomic({ token: input?.token, params: input?.params });
    });

    ipcMain.handle('erp:finance:return-amanat', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.returnAmanatAtomic({ token: input?.token, params: input?.params });
    });

    ipcMain.handle('erp:finance:update-amanat', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.updateAmanatRecord({ token: input?.token, record: input?.record });
    });

    ipcMain.handle('erp:finance:get-journal-entries', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getJournalEntries({
        token: input?.token,
        costCenterId: input?.costCenterId,
      });
    });

    ipcMain.handle('erp:finance:get-journal-entry', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getJournalEntryById({ token: input?.token, id: input?.id });
    });

    ipcMain.handle('erp:finance:create-journal-entry', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.createJournalEntryAtomic({ token: input?.token, entry: input?.entry });
    });

    ipcMain.handle('erp:finance:reverse-journal-entry', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.reverseJournalEntryAtomic({
        token: input?.token,
        originalEntryId: input?.originalEntryId,
        reversalReason: input?.reversalReason,
      });
    });

    // --- Batch D: Native SQLite Backup/Restore, JSON Backup & Sync ---
    ipcMain.handle('erp:backup:list', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.listNativeBackups({ token: input?.token });
    });

    ipcMain.handle('erp:backup:create-now', async (event, input) => {
      assertTrustedMainFrame(event);
      return await desktopBackend.createNativeBackupNow({
        token: input?.token,
        prefix: input?.prefix,
      });
    });

    ipcMain.handle('erp:backup:get-settings', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getBackupSettings({ token: input?.token });
    });

    ipcMain.handle('erp:backup:save-settings', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.saveBackupSettings({
        token: input?.token,
        settings: input?.settings,
      });
    });

    ipcMain.handle('erp:backup:export-sqlite-dialog', async (event, input) => {
      assertTrustedMainFrame(event);
      const actor = desktopBackend.requireActor(input?.token);
      assertPermission(actor, 'backup:export', 'تصدير نسخة احتياطية SQLite');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const res = await dialog.showSaveDialog(mainWindow, {
        title: 'حفظ نسخة احتياطية كاملة لقاعدة البيانات (SQLite)',
        defaultPath: path.join(databaseRuntime.backupDirectory, `amro-erp-backup-${stamp}.sqlite`),
        filters: [{ name: 'SQLite Database', extensions: ['sqlite', 'db'] }],
      });
      if (res.canceled || !res.filePath) {
        return { canceled: true };
      }
      const exported = await desktopBackend.exportNativeBackupToPath({
        token: input?.token,
        destinationPath: res.filePath,
      });
      return { canceled: false, ...exported };
    });

    ipcMain.handle('erp:backup:restore-sqlite-dialog', async (event, input) => {
      assertTrustedMainFrame(event);
      const actor = desktopBackend.requireActor(input?.token);
      assertPermission(actor, 'backup:restore', 'استعادة نسخة احتياطية SQLite');
      const res = await dialog.showOpenDialog(mainWindow, {
        title: 'اختيار ملف نسخة احتياطية SQLite للاستعادة',
        defaultPath: databaseRuntime.backupDirectory,
        properties: ['openFile'],
        filters: [{ name: 'SQLite Database', extensions: ['sqlite', 'db'] }],
      });
      if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
        return { canceled: true };
      }
      const result = await performSqliteRestore(input?.token, res.filePaths[0]);
      return { canceled: false, ...result };
    });

    ipcMain.handle('erp:backup:restore-sqlite-path', async (event, input) => {
      assertTrustedMainFrame(event);
      return await performSqliteRestore(input?.token, input?.sourcePath);
    });

    ipcMain.handle('erp:backup:choose-directory-dialog', async (event, input) => {
      assertTrustedMainFrame(event);
      const actor = desktopBackend.requireActor(input?.token);
      assertPermission(actor, 'backup:manage', 'تحديد مجلد النسخ الاحتياطي');
      const res = await dialog.showOpenDialog(mainWindow, {
        title: 'اختيار مجلد حفظ النسخ الاحتياطية الإضافية',
        defaultPath: databaseRuntime.backupDirectory,
        properties: ['openDirectory', 'createDirectory'],
      });
      if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
        return { canceled: true };
      }
      return { canceled: false, directory: res.filePaths[0] };
    });

    ipcMain.handle('erp:backup:export-json', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.exportBackupJSON({ token: input?.token });
    });

    ipcMain.handle('erp:backup:import-json', async (event, input) => {
      assertTrustedMainFrame(event);
      return await desktopBackend.importBackupJSON({
        token: input?.token,
        rawJson: input?.rawJson,
      });
    });

    ipcMain.handle('erp:sync:get-outbox', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getOutboxQueue({
        token: input?.token,
        statusFilter: input?.statusFilter,
        sortDir: input?.sortDir,
      });
    });

    ipcMain.handle('erp:sync:get-outbox-stats', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getOutboxStats({ token: input?.token });
    });

    ipcMain.handle('erp:sync:get-pending-keys', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getPendingEntityKeys({ token: input?.token });
    });

    ipcMain.handle('erp:sync:queue-outbox', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.queueOutboxItem({ token: input?.token, item: input?.item });
    });

    ipcMain.handle('erp:sync:claim-outbox', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.claimReadyToSyncItems({
        token: input?.token,
        workerId: input?.workerId,
        limit: input?.limit,
        leaseMs: input?.leaseMs,
      });
    });

    ipcMain.handle('erp:sync:mark-synced', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.markOutboxSynced({
        token: input?.token,
        id: input?.id,
        serverTimestamp: input?.serverTimestamp,
      });
    });

    ipcMain.handle('erp:sync:mark-failed', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.markOutboxFailed({
        token: input?.token,
        id: input?.id,
        errorMessage: input?.errorMessage,
        isPermanent: input?.isPermanent,
      });
    });

    ipcMain.handle('erp:sync:retry-failed', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.retryFailedItems({ token: input?.token });
    });

    ipcMain.handle('erp:sync:purge-synced', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.purgeOldSyncedRecords({
        token: input?.token,
        olderThanDays: input?.olderThanDays,
      });
    });

    ipcMain.handle('erp:sync:recover-stuck', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.recoverStuckSyncingItems({
        token: input?.token,
        leaseTimeoutMinutes: input?.leaseTimeoutMinutes,
      });
    });

    ipcMain.handle('erp:sync:get-conflicts', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getConflicts({ token: input?.token });
    });

    ipcMain.handle('erp:sync:record-conflict', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.recordConflict({ token: input?.token, params: input?.params });
    });

    ipcMain.handle('erp:sync:resolve-conflict', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.resolveConflict({
        token: input?.token,
        conflictId: input?.conflictId,
        status: input?.status,
        notes: input?.notes,
      });
    });

    ipcMain.handle('erp:sync:apply-remote', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.applyRemoteEntity({
        token: input?.token,
        entityType: input?.entityType,
        row: input?.row,
      });
    });
  }

  async function createMainWindow() {
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 980,
      minHeight: 680,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#0f172a',
      webPreferences: {
        preload: path.join(MODULE_DIR, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
      },
    });

    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, destination) => {
      if (destination !== mainWindow.webContents.getURL()) {
        event.preventDefault();
      }
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    const devServerUrl = process.env.ERP_DEV_SERVER_URL;
    if (devServerUrl && !app.isPackaged) {
      await mainWindow.loadURL(devServerUrl);
    } else {
      await mainWindow.loadFile(path.join(MODULE_DIR, '..', 'dist', 'index.html'));
    }
    mainWindow.show();
  }

  app.whenReady().then(async () => {
    try {
      const opened = await openErpDatabase({ userDataPath: app.getPath('userData') });
      bindDatabaseRuntime(opened);
      registerSafeIpcHandlers();
      await createMainWindow();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown startup error';
      dialog.showErrorBox(
        'تعذر تشغيل نظام عمرو النماري',
        'لم يتم تشغيل النظام لأن قاعدة البيانات لم تجتز فحص السلامة.\n\n' + message +
        '\n\nلم يتم إنشاء قاعدة بديلة أو حذف قاعدة البيانات الحالية.'
      );
      app.quit();
    }
  });

  app.on('before-quit', async (event) => {
    if (exitBackupCompleted) return;
    if (shuttingDown) {
      event.preventDefault();
      return;
    }
    shuttingDown = true;

    if (!databaseRuntime) {
      exitBackupCompleted = true;
      return;
    }

    event.preventDefault();
    try {
      const settings = getAppSetting(databaseRuntime.database, 'tenant_main', 'backup_settings', {
        autoBackupOnExit: true,
        maxRetainedBackups: 15,
        customBackupDirectory: '',
      });
      if (settings && settings.autoBackupOnExit !== false) {
        const createdPath = await createSqliteBackup(
          databaseRuntime.database,
          databaseRuntime.backupDirectory,
          { prefix: 'auto-exit' }
        );
        pruneAutoExitBackups(databaseRuntime.backupDirectory, settings.maxRetainedBackups || 15);
        const customDir = typeof settings.customBackupDirectory === 'string' ? settings.customBackupDirectory.trim() : '';
        if (customDir && path.resolve(customDir) !== path.resolve(databaseRuntime.backupDirectory)) {
          if (!existsSync(customDir)) mkdirSync(customDir, { recursive: true });
          await backupSqliteToDestination(
            databaseRuntime.database,
            path.join(customDir, path.basename(createdPath))
          );
          pruneAutoExitBackups(customDir, settings.maxRetainedBackups || 15);
        }
      }
    } catch (err) {
      console.warn('[main] Auto-backup on exit notice:', err);
    } finally {
      try {
        databaseRuntime.close();
      } finally {
        databaseRuntime = null;
        exitBackupCompleted = true;
        app.exit(0);
      }
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
