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
});

contextBridge.exposeInMainWorld('amroDesktop', desktopBridge);
