const { contextBridge, ipcRenderer } = require('electron');

const desktopBridge = Object.freeze({
  getRuntimeStatus: () => ipcRenderer.invoke('erp:runtime:status'),
});

contextBridge.exposeInMainWorld('amroDesktop', desktopBridge);
