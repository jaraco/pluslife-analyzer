'use strict';

// Minimal, safe bridge exposed to the upstream page's main world so the injected
// automation can persist small bits of state (last test type, download folder)
// and signal test completion, without granting the remote page any Node access.
const { contextBridge, ipcRenderer } = require('electron');

// Enable the app's expert mode before its scripts run, so the "Export raw data
// as JSON" control exists on the results screen. The app reads this localStorage
// flag in its connectedCallback; preload runs at document-start, ahead of that.
if (process.argv.includes('--pluslife-expert')) {
  try {
    localStorage.setItem('expert-mode', 'true');
  } catch {
    /* localStorage may be unavailable on some internal pages */
  }
}

contextBridge.exposeInMainWorld('plBridge', {
  getConfig: () => ipcRenderer.invoke('pluslife:getConfig'),
  setConfig: (patch) => ipcRenderer.invoke('pluslife:setConfig', patch),
  // Signal that a test finished; main snapshots the page and arms the JSON save.
  testComplete: (meta) => ipcRenderer.invoke('pluslife:testComplete', meta),
  // Start/stop the native keep-awake assertion as a test starts/ends.
  setKeepAwake: (on) => ipcRenderer.invoke('pluslife:setKeepAwake', on),
  // Cancel a device chooser the page can no longer abandon on its own.
  cancelBluetoothChooser: () => ipcRenderer.invoke('pluslife:cancelBluetoothChooser'),
});
