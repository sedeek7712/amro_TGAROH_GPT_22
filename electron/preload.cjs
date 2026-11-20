const { contextBridge, ipcRenderer } = require('electron');

const desktopBridge = Object.freeze({
  getRuntimeStatus: () => ipcRenderer.invoke('erp:runtime:status'),
  createBackup: () => ipcRenderer.invoke('erp:backup:create'),
  openBackupFolder: () => ipcRenderer.invoke('erp:backup:open-folder'),
});

contextBridge.exposeInMainWorld('amroDesktop', desktopBridge);
