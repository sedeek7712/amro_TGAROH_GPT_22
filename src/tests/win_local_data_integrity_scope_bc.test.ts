import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openErpDatabase } from '../../electron/sqlite/database.mjs';
import { createDesktopBackend } from '../../electron/sqlite/desktop-backend.mjs';
import { DesktopAuthenticationService } from '../../electron/security/authentication.mjs';
import { StorageService } from '../services/storageService';
import { desktopSession } from '../services/desktopSession';
import {
  clearDocumentOperationLogs,
  getDocumentOperationLogs,
  getWhatsAppDispatchAuditTrail,
  recordDocumentOperation,
  setDocumentOperationAuditProviderForTest,
} from '../services/documents/notificationLogService';

function createLocalStorageSpy() {
  const store = new Map<string, string>();
  const calls: Array<{ op: 'get' | 'set' | 'remove' | 'clear'; key?: string }> = [];
  return {
    calls,
    store,
    mock: {
      getItem(key: string) {
        calls.push({ op: 'get', key });
        return store.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        calls.push({ op: 'set', key });
        store.set(key, String(value));
      },
      removeItem(key: string) {
        calls.push({ op: 'remove', key });
        store.delete(key);
      },
      clear() {
        calls.push({ op: 'clear' });
        store.clear();
      },
    },
  };
}

test('WO-SCOPE-B-01: Electron StorageService.initialize() does zero localStorage reads/writes/migrations while generateUUID works and Web path stays intact', () => {
  const prevWindow = (globalThis as Record<string, unknown>).window;
  const prevLocalStorageDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  try {
    // 1. Electron mode: amroDesktop present -> zero localStorage access
    const electronLs = createLocalStorageSpy();
    electronLs.store.set('alharaj_erp_products', JSON.stringify([{ id: 'legacy-p1' }]));
    (globalThis as Record<string, unknown>).window = {
      amroDesktop: { getRuntimeStatus: async () => ({ ok: true }) },
    };
    Object.defineProperty(globalThis, 'localStorage', {
      value: electronLs.mock,
      configurable: true,
      writable: true,
    });

    const electronStorage = new StorageService();
    electronStorage.initialize();
    const migrationRes = electronStorage.migrateLegacyLocalStorage();
    assert.equal(migrationRes.migrated, false);
    assert.equal(electronLs.calls.length, 0);

    // Pure helper generateUUID remains available in Electron
    const uuid = electronStorage.generateUUID();
    assert.ok(typeof uuid === 'string' && uuid.length >= 16);

    // 2. Web mode: no amroDesktop -> initialize() seeds & migrates browser localStorage cleanly
    const webLs = createLocalStorageSpy();
    webLs.store.set('alharaj_erp_products', JSON.stringify([{ id: 'legacy-web-p1' }]));
    (globalThis as Record<string, unknown>).window = {};
    Object.defineProperty(globalThis, 'localStorage', {
      value: webLs.mock,
      configurable: true,
      writable: true,
    });

    const webStorage = new StorageService();
    webStorage.initialize();
    assert.ok(webLs.calls.some((c) => c.op === 'set' && c.key === 'multi_activity_erp_products'));
    assert.equal(
      JSON.parse(webLs.store.get('multi_activity_erp_products') || '[]')[0]?.id,
      'legacy-web-p1'
    );

    // 3. Legacy Django PostgreSQL DDL export is hidden/blocked in Electron UI
    const syncModalSource = readFileSync(
      path.resolve(process.cwd(), 'src/components/sync/SyncBackupModal.tsx'),
      'utf8'
    );
    assert.ok(syncModalSource.includes('!isDesktop && showSqlViewer'));
    assert.ok(syncModalSource.includes('{!isDesktop && ('));
  } finally {
    (globalThis as Record<string, unknown>).window = prevWindow;
    if (prevLocalStorageDesc) {
      Object.defineProperty(globalThis, 'localStorage', prevLocalStorageDesc);
    } else {
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  }
});

test('WO-SCOPE-C-01: Windows document operation logs persist to SQLite across reopen without touching localStorage and fail closed on write errors', async () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'erp-wo-scope-c-'));
  const prevWindow = (globalThis as Record<string, unknown>).window;
  const prevLocalStorageDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const lsSpy = createLocalStorageSpy();

  try {
    Object.defineProperty(globalThis, 'localStorage', {
      value: lsSpy.mock,
      configurable: true,
      writable: true,
    });

    // Session 1: Real SQLite DB + Desktop Backend wired to window.amroDesktop
    const runtime1 = await openErpDatabase({ userDataPath });
    const auth1 = new DesktopAuthenticationService(runtime1.database);
    const setup1 = auth1.createInitialAdmin({
      username: 'admin',
      fullName: 'المدير العام',
      password: 'AdminStrong#2026',
    });
    assert.equal(setup1.success, true);
    const backend1 = createDesktopBackend({
      database: runtime1.database,
      backupDirectory: runtime1.backupDirectory,
      mediaDirectory: path.join(userDataPath, 'media'),
      authenticationService: auth1,
    });
    const login1 = auth1.authenticate({ username: 'admin', password: 'AdminStrong#2026' });
    assert.equal(login1.success, true);
    assert.ok(login1.token);

    desktopSession.setActorSession(login1.token, login1.user);
    (globalThis as Record<string, unknown>).window = {
      amroDesktop: {
        logAction: async (input: { token: string; action: string; details: string }) =>
          backend1.logAction(input),
        getAuditLogs: async (input: { token: string }) => backend1.getAuditLogs(input),
      },
    };

    await recordDocumentOperation({
      operationType: 'PRINT',
      status: 'PRINT_SENT',
      documentId: 'inv-c-1',
      documentNumber: 'INV-C-101',
      documentType: 'SALES_INVOICE',
      userId: login1.user.id,
      userName: login1.user.fullName,
      branchId: 'branch_main',
      channel: 'NATIVE_PRINT',
    });
    await recordDocumentOperation({
      operationType: 'PDF_EXPORT',
      status: 'SAVED',
      documentId: 'inv-c-1',
      documentNumber: 'INV-C-101',
      documentType: 'SALES_INVOICE',
      fileName: 'C:\\Users\\Secret\\Desktop\\INV-C-101.pdf',
      channel: 'ELECTRON_DIALOG',
    });
    await recordDocumentOperation({
      operationType: 'PNG_EXPORT',
      status: 'SAVED',
      documentId: 'rct-c-2',
      documentNumber: 'RCT-C-202',
      documentType: 'RECEIPT_VOUCHER',
      fileName: 'D:\\Exports\\RCT-C-202.png',
      channel: 'ELECTRON_DIALOG',
    });
    await recordDocumentOperation({
      operationType: 'SHARE',
      status: 'WHATSAPP_LAUNCHED',
      documentId: 'rct-c-2',
      documentNumber: 'RCT-C-202',
      documentType: 'RECEIPT_VOUCHER',
      dispatchId: 'disp-sqlite-1',
      recipientName: 'أحمد الصالح',
      recipientPhoneMasked: '967••••8899',
      channel: 'WHATSAPP',
    });

    // Reject DELIVERED even on Electron
    await assert.rejects(
      () =>
        recordDocumentOperation({
          operationType: 'SHARE',
          status: 'DELIVERED' as never,
          documentId: 'rct-c-2',
          documentNumber: 'RCT-C-202',
          documentType: 'RECEIPT_VOUCHER',
        }),
      /DELIVERED/
    );

    // Strictly zero localStorage interactions on Windows!
    assert.equal(lsSpy.calls.length, 0);

    // Close DB and reopen fresh runtime + service
    desktopSession.clear();
    runtime1.close();

    const runtime2 = await openErpDatabase({ userDataPath });
    const auth2 = new DesktopAuthenticationService(runtime2.database);
    const backend2 = createDesktopBackend({
      database: runtime2.database,
      backupDirectory: runtime2.backupDirectory,
      mediaDirectory: path.join(userDataPath, 'media'),
      authenticationService: auth2,
    });
    const login2 = auth2.authenticate({ username: 'admin', password: 'AdminStrong#2026' });
    assert.equal(login2.success, true);
    assert.ok(login2.token);

    desktopSession.setActorSession(login2.token, login2.user);
    (globalThis as Record<string, unknown>).window = {
      amroDesktop: {
        logAction: async (input: { token: string; action: string; details: string }) =>
          backend2.logAction(input),
        getAuditLogs: async (input: { token: string }) => backend2.getAuditLogs(input),
      },
    };

    const allLogs = await getDocumentOperationLogs();
    assert.equal(allLogs.length, 4);
    assert.ok(allLogs.some((l) => l.operationType === 'PRINT' && l.status === 'PRINT_SENT' && l.documentNumber === 'INV-C-101'));
    const pdfLog = allLogs.find((l) => l.operationType === 'PDF_EXPORT');
    assert.ok(pdfLog);
    assert.equal(pdfLog.fileName, 'INV-C-101.pdf');
    assert.ok(!JSON.stringify(pdfLog).includes('C:\\Users'));

    // Backward-compatible WHATSAPP_DISPATCH_EVENT trail works from SQLite
    const waTrail = await getWhatsAppDispatchAuditTrail({ dispatchId: 'disp-sqlite-1' });
    assert.equal(waTrail.length, 1);
    assert.equal(waTrail[0].status, 'WHATSAPP_LAUNCHED');
    assert.equal(waTrail[0].recipientPhoneMasked, '967••••8899');

    // Still zero localStorage calls on read!
    assert.equal(lsSpy.calls.length, 0);

    // Write failure propagates cleanly without faking success or touching localStorage
    setDocumentOperationAuditProviderForTest({
      async logAction() {
        throw new Error('SQLite disk write failed');
      },
      async getAuditLogs() {
        throw new Error('SQLite read unavailable');
      },
    });
    await assert.rejects(
      () =>
        recordDocumentOperation({
          operationType: 'PDF_EXPORT',
          status: 'SAVED',
          documentId: 'inv-fail',
          documentNumber: 'INV-FAIL',
          documentType: 'SALES_INVOICE',
        }),
      /SQLite disk write failed/
    );
    await assert.rejects(() => getDocumentOperationLogs(), /SQLite read unavailable/);
    assert.equal(lsSpy.calls.length, 0);

    runtime2.close();
  } finally {
    setDocumentOperationAuditProviderForTest(null);
    desktopSession.clear();
    (globalThis as Record<string, unknown>).window = prevWindow;
    if (prevLocalStorageDesc) {
      Object.defineProperty(globalThis, 'localStorage', prevLocalStorageDesc);
    } else {
      delete (globalThis as Record<string, unknown>).localStorage;
    }
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('WO-SCOPE-C-02: Web document operation logs continue reading and writing via localStorage cleanly', async () => {
  const prevWindow = (globalThis as Record<string, unknown>).window;
  const prevLocalStorageDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const webLs = createLocalStorageSpy();

  try {
    (globalThis as Record<string, unknown>).window = {};
    Object.defineProperty(globalThis, 'localStorage', {
      value: webLs.mock,
      configurable: true,
      writable: true,
    });
    setDocumentOperationAuditProviderForTest(null);
    clearDocumentOperationLogs();

    await recordDocumentOperation({
      operationType: 'PNG_EXPORT',
      status: 'DOWNLOAD_INITIATED',
      documentId: 'web-doc-1',
      documentNumber: 'WEB-001',
      documentType: 'SALES_INVOICE',
      fileName: 'WEB-001.png',
      channel: 'BROWSER_DOWNLOAD',
      syncAudit: false,
    });

    const logs = await getDocumentOperationLogs({ documentNumber: 'WEB-001' });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 'DOWNLOAD_INITIATED');
    assert.ok(webLs.calls.some((c) => c.op === 'set' && c.key === 'amro_doc_ops_logs_v1'));
  } finally {
    clearDocumentOperationLogs();
    (globalThis as Record<string, unknown>).window = prevWindow;
    if (prevLocalStorageDesc) {
      Object.defineProperty(globalThis, 'localStorage', prevLocalStorageDesc);
    } else {
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  }
});
