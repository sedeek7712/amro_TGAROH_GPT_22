import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqliteBackup, openErpDatabase } from './sqlite/database.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const STABLE_DATA_FOLDER = 'AmroAlnmaryERP';

let mainWindow = null;
let databaseRuntime = null;
let shuttingDown = false;

// The data directory is intentionally independent from the EXE installation directory
// and remains stable even if the application display name changes.
const stableUserDataPath = path.join(app.getPath('appData'), STABLE_DATA_FOLDER);
app.setName(STABLE_DATA_FOLDER);
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

  function registerSafeIpcHandlers() {
    ipcMain.handle('erp:runtime:status', (event) => {
      assertTrustedMainFrame(event);
      const latest = databaseRuntime.database.prepare(
        'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations'
      ).get();
      const sqliteVersion = databaseRuntime.database.prepare(
        'SELECT sqlite_version() AS version'
      ).get();
      return {
        ready: true,
        databaseFile: path.basename(databaseRuntime.databasePath),
        schemaVersion: latest.version,
        sqliteVersion: sqliteVersion.version,
      };
    });

    ipcMain.handle('erp:backup:create', async (event) => {
      assertTrustedMainFrame(event);
      const backupPath = await createSqliteBackup(
        databaseRuntime.database,
        databaseRuntime.backupDirectory,
        { prefix: 'manual-backup' }
      );
      return { success: true, filename: path.basename(backupPath) };
    });

    ipcMain.handle('erp:backup:open-folder', async (event) => {
      assertTrustedMainFrame(event);
      const errorMessage = await shell.openPath(databaseRuntime.backupDirectory);
      return { success: errorMessage.length === 0, error: errorMessage || undefined };
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
      databaseRuntime = await openErpDatabase({ userDataPath: app.getPath('userData') });
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

  app.on('before-quit', () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (databaseRuntime) {
      try {
        databaseRuntime.close();
      } finally {
        databaseRuntime = null;
      }
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
