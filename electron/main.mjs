import { app, BrowserWindow, ClipboardItem, clipboard, dialog, ipcMain, Menu, nativeImage, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { Blob } from 'node:buffer';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  backupSqliteToDestination,
  createSqliteBackup,
  openErpDatabase,
  restoreSqliteBackupFile,
} from './sqlite/database.mjs';
import { getAppSetting } from './sqlite/modules/core-service.mjs';
import { pruneAutoBackups } from './sqlite/modules/backup-sync-service.mjs';
import { assertPermission } from './sqlite/rbac.mjs';
import { DesktopAuthenticationService } from './security/authentication.mjs';
import { createDesktopBackend } from './sqlite/desktop-backend.mjs';
import { createDiagnosticLogger } from './logging/diagnostic-logger.mjs';
import {
  copyShareTempPngToClipboardOnDisk,
  executeCleanupShareTempFileIpc,
  executeExportPdfIpc,
  executeExportPngIpc,
  executeRunNativePrintIpc,
  openAllowedWhatsAppUrl,
  prepareShareTempFileOnDisk,
  purgeStaleShareTempFiles as purgeShareTempDirFiles,
  revealShareTempFileOnDisk,
} from './document-ipc-helpers.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const STABLE_DATA_FOLDER = 'AmroAlnmaryERP';

let mainWindow = null;
let databaseRuntime = null;
let authenticationService = null;
let desktopBackend = null;
let shuttingDown = false;
let exitBackupCompleted = false;
let scheduledBackupTimer = null;
let shareTempCleanupTimer = null;
let autoBackupInFlight = false;
const shareTempFiles = new Map();

function getShareTempDirectory() {
  return path.join(app.getPath('temp'), 'AmroErpShareTemp');
}

const SHARE_TEMP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function purgeStaleShareTempFiles() {
  purgeShareTempDirFiles({
    tempDir: getShareTempDirectory(),
    shareTempFiles,
    retentionMs: SHARE_TEMP_RETENTION_MS,
  });
}

// Recheck temporary attachments during long-running sessions; they still expire after 7 days.
shareTempCleanupTimer = setInterval(purgeStaleShareTempFiles, 60 * 60 * 1000);
shareTempCleanupTimer.unref?.();

// The data directory is intentionally independent from the EXE installation directory
// and remains stable even if the application display name changes.
const stableUserDataPath = path.join(app.getPath('appData'), STABLE_DATA_FOLDER);
app.setName(STABLE_DATA_FOLDER);
app.setAppUserModelId('com.amroalnmary.erp');
app.setPath('userData', stableUserDataPath);

const diagnosticLogger = createDiagnosticLogger({
  logDirectory: path.join(stableUserDataPath, 'Logs'),
});

process.on('uncaughtException', (error) => {
  diagnosticLogger.log('ERROR', 'process', 'Uncaught exception in Electron main process', error);
});

process.on('unhandledRejection', (reason) => {
  diagnosticLogger.log(
    'ERROR',
    'process',
    'Unhandled promise rejection in Electron main process',
    reason instanceof Error ? reason : { reason: String(reason) }
  );
});

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
      mediaDirectory: path.join(app.getPath('userData'), 'ProductMedia'),
      authenticationService,
      onDataChanged: emitDataChanged,
    });
  }

  function getStoredBackupSettings() {
    if (!databaseRuntime) {
      return {
        autoBackupOnExit: true,
        autoBackupIntervalHours: 24,
        maxRetainedBackups: 15,
        customBackupDirectory: '',
      };
    }
    return getAppSetting(databaseRuntime.database, 'tenant_main', 'backup_settings', {
      autoBackupOnExit: true,
      autoBackupIntervalHours: 24,
      maxRetainedBackups: 15,
      customBackupDirectory: '',
    });
  }

  async function runAutomaticBackup(prefix = 'auto-scheduled') {
    if (!databaseRuntime || autoBackupInFlight) return null;
    autoBackupInFlight = true;
    try {
      const settings = getStoredBackupSettings();
      const maxRetained = Math.max(1, Number(settings?.maxRetainedBackups || 15));
      const createdPath = await createSqliteBackup(
        databaseRuntime.database,
        databaseRuntime.backupDirectory,
        { prefix }
      );
      desktopBackend.productMediaStorage.backupTo(createdPath + '.media');
      pruneAutoBackups(databaseRuntime.backupDirectory, maxRetained);

      const customDir =
        typeof settings?.customBackupDirectory === 'string'
          ? settings.customBackupDirectory.trim()
          : '';
      if (customDir && path.resolve(customDir) !== path.resolve(databaseRuntime.backupDirectory)) {
        if (!existsSync(customDir)) mkdirSync(customDir, { recursive: true });
        const customDatabasePath = path.join(customDir, path.basename(createdPath));
        await backupSqliteToDestination(databaseRuntime.database, customDatabasePath);
        desktopBackend.productMediaStorage.backupTo(customDatabasePath + '.media');
        pruneAutoBackups(customDir, maxRetained);
      }

      diagnosticLogger.log('INFO', 'backup', `Automatic backup completed (${prefix})`, {
        filename: path.basename(createdPath),
      });
      return createdPath;
    } catch (err) {
      diagnosticLogger.log('ERROR', 'backup', `Automatic backup failed (${prefix})`, err);
      return null;
    } finally {
      autoBackupInFlight = false;
    }
  }

  function clearScheduledBackupTimer() {
    if (scheduledBackupTimer) {
      clearInterval(scheduledBackupTimer);
      scheduledBackupTimer = null;
    }
  }

  function syncScheduledBackupTimer() {
    clearScheduledBackupTimer();
    if (!databaseRuntime) return;
    const settings = getStoredBackupSettings();
    const intervalHours = Number(settings?.autoBackupIntervalHours ?? 24);
    if (!Number.isFinite(intervalHours) || intervalHours <= 0) return;

    const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;
    scheduledBackupTimer = setInterval(() => {
      if (!shuttingDown && databaseRuntime) {
        void runAutomaticBackup('auto-scheduled').then((created) => {
          if (created) emitDataChanged(['backup']);
        });
      }
    }, intervalMs);
    if (typeof scheduledBackupTimer.unref === 'function') {
      scheduledBackupTimer.unref();
    }
  }

  function handleTrustedIpc(channel, handler) {
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedMainFrame(event);
      try {
        return await handler(event, ...args);
      } catch (error) {
        diagnosticLogger.log('ERROR', 'ipc', `IPC handler failed: ${channel}`, error);
        throw error;
      }
    });
  }

  async function performSqliteRestore(token, sourceBackupPath) {
    const actor = desktopBackend.requireActor(token);
    assertPermission(actor, 'backup:restore', 'استعادة نسخة احتياطية SQLite');
    const reopenOptions = { userDataPath: app.getPath('userData') };
    const safetyMediaPath = path.join(app.getPath('temp'), `amro-media-pre-restore-${randomUUID()}`);
    let preserveSafetyMedia = false;
    desktopBackend.productMediaStorage.backupTo(safetyMediaPath);
    try {
      const restored = await restoreSqliteBackupFile({
        databasePath: databaseRuntime.databasePath,
        backupDirectory: databaseRuntime.backupDirectory,
        sourceBackupPath,
        currentDatabase: databaseRuntime.database,
        reopenOptions,
      });
      bindDatabaseRuntime(restored.databaseRuntime);

      try {
        const restoredMediaFound = desktopBackend.productMediaStorage.restoreFrom(sourceBackupPath + '.media');
        const productImageCount = databaseRuntime.database.prepare(
          'SELECT COUNT(*) AS count FROM product_images WHERE is_deleted = 0'
        ).get().count;
        if (!restoredMediaFound && productImageCount > 0) {
          throw new Error('النسخة الاحتياطية تحتوي على سجلات صور، لكن مجلد الصور المرفق (.media) غير موجود.');
        }
        if (!restoredMediaFound) {
          desktopBackend.productMediaStorage.clear();
          diagnosticLogger.log('WARN', 'backup', 'Legacy SQLite backup has no product image records or media sidecar; media folder was cleared.', {
            restoredFrom: path.basename(sourceBackupPath),
          });
        }
        desktopBackend.verifyProductMediaIntegrity();
      } catch (mediaRestoreError) {
        try {
          const rollback = await restoreSqliteBackupFile({
            databasePath: databaseRuntime.databasePath,
            backupDirectory: databaseRuntime.backupDirectory,
            sourceBackupPath: restored.safetyBackupPath,
            currentDatabase: databaseRuntime.database,
            reopenOptions,
          });
          bindDatabaseRuntime(rollback.databaseRuntime);
          const mediaRollbackSucceeded = desktopBackend.productMediaStorage.restoreFrom(safetyMediaPath);
          if (!mediaRollbackSucceeded) {
            throw new Error('تعذر استعادة مجلد الصور من نسخة الأمان.');
          }
          rmSync(safetyMediaPath, { recursive: true, force: true });
          syncScheduledBackupTimer();
          emitAuthInvalidated('تعذرت استعادة صور النسخة؛ تم التراجع إلى قاعدة البيانات والملفات السابقة. يرجى تسجيل الدخول مجدداً.');
          emitDataChanged(['all', 'session']);
        } catch (rollbackError) {
          preserveSafetyMedia = true;
          diagnosticLogger.log('CRITICAL', 'backup', 'Database/media restore rollback failed; safety media copy retained.', {
            mediaRestoreError,
            rollbackError,
            safetyMediaPath,
          });
          throw new Error('فشلت استعادة الصور وتعذر إكمال التراجع الآلي. تم الإبقاء على نسخة أمان الصور داخل مجلد الملفات المؤقتة؛ لا تحذفها.');
        }
        throw new Error(
          'تم رفض استعادة النسخة لأن ملفات صور الأصناف غير مكتملة؛ أعيد النظام إلى حالته السابقة. السبب: ' +
          (mediaRestoreError instanceof Error ? mediaRestoreError.message : String(mediaRestoreError))
        );
      }

      rmSync(safetyMediaPath, { recursive: true, force: true });
      syncScheduledBackupTimer();
      diagnosticLogger.log('INFO', 'backup', 'SQLite database and product media restored', {
        restoredFrom: path.basename(restored.restoredFrom),
        safetyBackupPath: path.basename(restored.safetyBackupPath),
      });
      emitAuthInvalidated('تمت استعادة قاعدة البيانات من النسخة الاحتياطية؛ يرجى تسجيل الدخول مجدداً.');
      emitDataChanged(['all', 'session']);
      return {
        success: true,
        restoredFrom: restored.restoredFrom,
        safetyBackupPath: restored.safetyBackupPath,
      };
    } catch (error) {
      diagnosticLogger.log('ERROR', 'backup', 'SQLite database restore failed', error);
      if (error && error.rolledBackRuntime) {
        bindDatabaseRuntime(error.rolledBackRuntime);
        desktopBackend.productMediaStorage.restoreFrom(safetyMediaPath);
        syncScheduledBackupTimer();
        emitAuthInvalidated('تعذرت استعادة النسخة وتم التراجع للوضع الآمن؛ يرجى تسجيل الدخول مجدداً.');
        emitDataChanged(['all', 'session']);
      }
      if (!preserveSafetyMedia) {
        rmSync(safetyMediaPath, { recursive: true, force: true });
      }
      throw error;
    }
  }

  function registerSafeIpcHandlers() {
    handleTrustedIpc('erp:runtime:status', () => {
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

    ipcMain.handle('erp:inventory:get-product-units', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getProductUnits({ token: input?.token, productId: input?.productId });
    });

    ipcMain.handle('erp:inventory:save-product-unit', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.saveProductUnit({ token: input?.token, unit: input?.unit });
    });

    ipcMain.handle('erp:inventory:get-brands', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getBrands({ token: input?.token, includeInactive: input?.includeInactive });
    });

    ipcMain.handle('erp:inventory:save-brand', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.saveBrandAtomic({ token: input?.token, input: input?.input });
    });

    ipcMain.handle('erp:inventory:archive-brand', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.archiveBrandAtomic({ token: input?.token, brandId: input?.brandId });
    });

    ipcMain.handle('erp:inventory:get-product-families', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getProductFamilies({
        token: input?.token,
        activityId: input?.activityId,
        includeInactive: input?.includeInactive,
      });
    });

    ipcMain.handle('erp:inventory:get-product-family', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getProductFamilyById({ token: input?.token, familyId: input?.familyId });
    });

    ipcMain.handle('erp:inventory:create-product-family-with-skus', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.createProductFamilyWithSkusAtomic({ token: input?.token, input: input?.input });
    });

    ipcMain.handle('erp:inventory:update-product-family', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.updateProductFamilyAtomic({ token: input?.token, input: input?.input });
    });

    ipcMain.handle('erp:inventory:archive-product-family', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.archiveProductFamilyAtomic({ token: input?.token, familyId: input?.familyId });
    });

    ipcMain.handle('erp:inventory:assign-product-brand', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.assignProductBrandAtomic({ token: input?.token, input: input?.input });
    });

    ipcMain.handle('erp:inventory:get-product-catalog', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getProductCatalog({ token: input?.token, activityId: input?.activityId });
    });

    ipcMain.handle('erp:inventory:get-product-catalog-entry', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getProductCatalogEntry({ token: input?.token, productId: input?.productId });
    });

    ipcMain.handle('erp:inventory:get-product-images', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getProductImages({ token: input?.token, productId: input?.productId });
    });
    ipcMain.handle('erp:inventory:get-product-image-record', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getProductImageRecord({ token: input?.token, imageId: input?.imageId });
    });
    ipcMain.handle('erp:inventory:get-product-image-data', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getProductImageData({ token: input?.token, imageId: input?.imageId, variant: input?.variant });
    });
    ipcMain.handle('erp:inventory:add-product-image', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.addProductImage({ token: input?.token, input: input?.input });
    });
    ipcMain.handle('erp:inventory:set-primary-product-image', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.setPrimaryProductImage({ token: input?.token, imageId: input?.imageId });
    });
    ipcMain.handle('erp:inventory:delete-product-image', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.deleteProductImage({ token: input?.token, imageId: input?.imageId });
    });
    ipcMain.handle('erp:inventory:cache-remote-product-image', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.cacheRemoteProductImage({ token: input?.token, input: input?.input });
    });
    ipcMain.handle('erp:inventory:apply-remote-product-image-tombstone', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.applyRemoteProductImageTombstone({ token: input?.token, record: input?.record });
    });
    ipcMain.handle('erp:inventory:mark-product-image-synced', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.markProductImageSynced({ token: input?.token, imageId: input?.imageId });
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

    ipcMain.handle('erp:finance:create-sales-return', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.createSalesReturnAtomic({ token: input?.token, params: input?.params });
    });

    ipcMain.handle('erp:finance:create-purchase-return', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.createPurchaseReturnAtomic({ token: input?.token, params: input?.params });
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

    ipcMain.handle('erp:finance:post-draft-voucher', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.postDraftCashVoucherAtomic({ token: input?.token, params: input?.params });
    });

    ipcMain.handle('erp:finance:cancel-cash-voucher', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.cancelCashVoucherAtomic({ token: input?.token, params: input?.params });
    });

    ipcMain.handle('erp:finance:reverse-cash-voucher', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.reverseCashVoucherAtomic({ token: input?.token, params: input?.params });
    });

    ipcMain.handle('erp:finance:get-payment-allocations', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getPaymentAllocations({
        token: input?.token,
        partyId: input?.partyId,
        voucherId: input?.voucherId,
      });
    });

    ipcMain.handle('erp:finance:get-party-advances', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getPartyAdvanceTransactions({
        token: input?.token,
        partyId: input?.partyId,
      });
    });

    ipcMain.handle('erp:finance:get-allocation-audits', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.getAllocationAudits({
        token: input?.token,
        voucherId: input?.voucherId,
      });
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

    ipcMain.handle('erp:finance:cancel-amanat', (event, input) => {
      assertTrustedMainFrame(event);
      return desktopBackend.cancelAmanatAtomic({ token: input?.token, params: input?.params });
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
      const saved = desktopBackend.saveBackupSettings({
        token: input?.token,
        settings: input?.settings,
      });
      syncScheduledBackupTimer();
      return saved;
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

    handleTrustedIpc('erp:diagnostics:get-log', (_event, input) => {
      const actor = desktopBackend.requireActor(input?.token);
      assertPermission(actor, 'backup:manage', 'عرض سجل التشخيص والأخطاء');
      const status = desktopBackend.getRuntimeStatus();
      const recent = diagnosticLogger.readRecentEntries({ maxLines: input?.maxLines || 150 });
      return {
        ...recent,
        runtime: {
          ...status,
          appVersion: app.getVersion(),
          isPackaged: app.isPackaged,
          platform: process.platform,
          arch: process.arch,
        },
      };
    });

    handleTrustedIpc('erp:diagnostics:export-dialog', async (_event, input) => {
      const actor = desktopBackend.requireActor(input?.token);
      assertPermission(actor, 'backup:export', 'تصدير تقرير التشخيص والأخطاء');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const res = await dialog.showSaveDialog(mainWindow, {
        title: 'حفظ سجل التشخيص والأخطاء (Diagnostic Report)',
        defaultPath: path.join(path.dirname(diagnosticLogger.getLogFilePath()), `amro-diagnostics-${stamp}.json`),
        filters: [{ name: 'Diagnostic JSON Report', extensions: ['json', 'log'] }],
      });
      if (res.canceled || !res.filePath) {
        return { canceled: true };
      }
      const status = desktopBackend.getRuntimeStatus();
      const exported = diagnosticLogger.exportDiagnosticsReport(res.filePath, {
        ...status,
        appVersion: app.getVersion(),
        isPackaged: app.isPackaged,
        platform: process.platform,
        arch: process.arch,
        exportedBy: actor.username,
      });
      diagnosticLogger.log('INFO', 'diagnostics', 'Diagnostic report exported', {
        filename: exported.filename,
        entryCount: exported.entryCount,
      });
      return { canceled: false, ...exported };
    });

    handleTrustedIpc('erp:print:export-pdf', async (_event, input) => {
      const actor = desktopBackend.requireActor(input?.token);
      return await executeExportPdfIpc({
        mainWindow,
        dialog,
        input,
        actor,
        logger: diagnosticLogger,
      });
    });

    handleTrustedIpc('erp:print:export-png', async (_event, input) => {
      const actor = desktopBackend.requireActor(input?.token);
      return await executeExportPngIpc({
        mainWindow,
        dialog,
        input,
        actor,
        logger: diagnosticLogger,
      });
    });

    handleTrustedIpc('erp:print:run-native', async (_event, input) => {
      const actor = desktopBackend.requireActor(input?.token);
      return await executeRunNativePrintIpc({
        mainWindow,
        input,
        actor,
        logger: diagnosticLogger,
      });
    });

    handleTrustedIpc('erp:share:prepare-temp-file', async (_event, input) => {
      const actor = desktopBackend.requireActor(input?.token);
      const permissionByDocumentKind = {
        SALE: 'invoices:view',
        RETURN_SALE: 'invoices:view',
        PURCHASE: 'invoices:view',
        RETURN_PURCHASE: 'invoices:view',
        RECEIPT_VOUCHER: 'voucher:receipt',
        PAYMENT_VOUCHER: 'voucher:payment',
        AMANAT_RECEIPT: 'amanat:view',
        AMANAT_RETURN: 'amanat:view',
        STATEMENT: 'party:view',
        JOURNAL: 'view:accounting',
        REPORT: 'view:reports',
      };
      const requiredPermission = permissionByDocumentKind[String(input?.documentKind || '')];
      if (!requiredPermission) {
        throw new Error('نوع المستند غير مدعوم للمشاركة عبر واتساب.');
      }
      assertPermission(actor, requiredPermission, 'مشاركة مستند عبر واتساب');
      purgeStaleShareTempFiles();
      return prepareShareTempFileOnDisk({
        tempDir: getShareTempDirectory(),
        shareTempFiles,
        input,
      });
    });

    handleTrustedIpc('erp:share:copy-image-to-clipboard', async (_event, input) => {
      desktopBackend.requireActor(input?.token);
      return copyShareTempPngToClipboardOnDisk({
        tempDir: getShareTempDirectory(),
        shareTempFiles,
        clipboard,
        nativeImage,
        ClipboardItemCtor: ClipboardItem,
        BlobCtor: Blob,
        tempToken: input?.tempToken,
        messageText: input?.messageText,
      });
    });

    handleTrustedIpc('erp:share:reveal-temp-file', async (_event, input) => {
      desktopBackend.requireActor(input?.token);
      return revealShareTempFileOnDisk({
        tempDir: getShareTempDirectory(),
        shareTempFiles,
        shell,
        tempToken: input?.tempToken,
      });
    });

    handleTrustedIpc('erp:share:cleanup-temp-file', async (_event, input) => {
      desktopBackend.requireActor(input?.token);
      return executeCleanupShareTempFileIpc({
        tempDir: getShareTempDirectory(),
        shareTempFiles,
        tempToken: input?.tempToken,
      });
    });

    handleTrustedIpc('erp:share:open-whatsapp-url', async (_event, input) => {
      desktopBackend.requireActor(input?.token);
      return await openAllowedWhatsAppUrl({
        shell,
        url: input?.url,
        logger: diagnosticLogger,
      });
    });
  }

  function resolveWindowIconPath() {
    const candidates = [
      path.join(MODULE_DIR, '..', 'dist', 'pwa-512x512.png'),
      path.join(MODULE_DIR, '..', 'public', 'pwa-512x512.png'),
    ];
    return candidates.find((p) => existsSync(p));
  }

  async function createMainWindow() {
    const windowIconPath = resolveWindowIconPath();
    if (app.isPackaged) {
      Menu.setApplicationMenu(null);
    }

    mainWindow = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 980,
      minHeight: 680,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#0f172a',
      ...(windowIconPath ? { icon: windowIconPath } : {}),
      webPreferences: {
        preload: path.join(MODULE_DIR, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        devTools: !app.isPackaged,
      },
    });

    if (app.isPackaged) {
      mainWindow.webContents.on('before-input-event', (event, input) => {
        const key = String(input.key || '').toUpperCase();
        const isDevToolsShortcut =
          key === 'F12' ||
          ((input.control || input.meta) && input.shift && ['I', 'J', 'C'].includes(key));
        if (isDevToolsShortcut) {
          event.preventDefault();
        }
      });
    }

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
      purgeStaleShareTempFiles();
      registerSafeIpcHandlers();
      syncScheduledBackupTimer();
      diagnosticLogger.log('INFO', 'startup', 'Desktop application started and SQLite verified', {
        schemaVersion: desktopBackend.getRuntimeStatus().schemaVersion,
        isPackaged: app.isPackaged,
      });
      await createMainWindow();
    } catch (error) {
      diagnosticLogger.log('ERROR', 'startup', 'Desktop application failed startup verification', error);
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
    clearScheduledBackupTimer();
    if (shareTempCleanupTimer) {
      clearInterval(shareTempCleanupTimer);
      shareTempCleanupTimer = null;
    }
    purgeStaleShareTempFiles();
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
      const settings = getStoredBackupSettings();
      if (settings && settings.autoBackupOnExit !== false) {
        await runAutomaticBackup('auto-exit');
      }
    } catch (err) {
      diagnosticLogger.log('WARN', 'backup', 'Auto-backup on exit warning', err);
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
