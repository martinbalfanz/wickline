// What the desktop app's pages may ask the app itself (everything else goes through the built-in
// server): the network proxy setting, read and changed from Data sources (desktop/proxy.mjs).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wicklineDesktop', {
  getProxy: () => ipcRenderer.invoke('proxy:get'),
  setProxy: (settings) => ipcRenderer.invoke('proxy:set', { mode: settings?.mode, server: settings?.server }),
});
