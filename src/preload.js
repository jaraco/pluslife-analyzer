'use strict';

// Minimal, safe bridge exposed to the upstream page's main world so the injected
// automation can persist small bits of state (e.g. the last-used test type)
// without granting the remote page any Node access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('plBridge', {
  getConfig: () => ipcRenderer.invoke('pluslife:getConfig'),
  setConfig: (patch) => ipcRenderer.invoke('pluslife:setConfig', patch),
});
