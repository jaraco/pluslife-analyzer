'use strict';

const { app, BrowserWindow, session, ipcMain, powerSaveBlocker } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// The upstream, community-maintained Pluslife web app. It already implements the
// full device protocol (BLE + USB) and amplification-curve analysis; we reuse it
// verbatim and only add native behaviors a browser page cannot provide.
const APP_URL = process.env.PLUSLIFE_URL || 'https://virus.sucks/pluslife_app/';
// Flags accepted via env OR argv, because `open`-launched apps don't inherit the
// shell environment. run.sh passes them as args after the app path.
const DEBUG = !!process.env.PLUSLIFE_DEBUG || process.argv.includes('--pluslife-debug');
// Skip the auto-connect click (useful for pure UI work in a plain terminal run,
// where touching Bluetooth would crash unless launched via `open`).
const NO_CONNECT = !!process.env.PLUSLIFE_NO_CONNECT || process.argv.includes('--no-connect');

let logFile = null; // set once app paths are available
function dlog(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  if (DEBUG && logFile) {
    try {
      fs.appendFileSync(logFile, `${line}\n`);
    } catch {
      /* ignore */
    }
  }
}

// Regex used to recognize the dock the first time, before we have a remembered id.
const DEVICE_NAME_HINT = new RegExp(
  process.env.PLUSLIFE_DEVICE_HINT || 'pluslife|minidock|mini dock|mira|mhealth|health',
  'i',
);

let win = null;
let caffeinate = null;
let psbId = -1;

// ---------------------------------------------------------------------------
// Persistent config (userData/config.json): remembered BT device + last test.
// ---------------------------------------------------------------------------
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}
function saveConfig(cfg) {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.error('[pluslife] failed to save config:', err);
  }
}
let config = {};

// ---------------------------------------------------------------------------
// Keep the Mac awake for the whole session. This is the core reason the app
// exists: a browser page can only hold a Screen Wake Lock (released the moment
// the tab is backgrounded), which is why tests were lost on sleep. `caffeinate`
// holds a real IOKit PreventUserIdleSystemSleep assertion that survives
// backgrounding and clamshell-on-external-display operation.
//   -i  prevent idle system sleep
//   -w  release automatically when this process (Electron main) exits
// ---------------------------------------------------------------------------
function startCaffeinate() {
  if (caffeinate) return;
  try {
    caffeinate = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], {
      stdio: 'ignore',
    });
    caffeinate.on('exit', () => {
      caffeinate = null;
    });
    caffeinate.on('error', (err) => {
      console.error('[pluslife] caffeinate failed to start:', err);
      caffeinate = null;
    });
    // Belt-and-suspenders: Electron's own assertion, in case caffeinate is
    // unavailable for any reason. Harmless if redundant.
    if (!powerSaveBlocker.isStarted(psbId)) {
      psbId = powerSaveBlocker.start('prevent-app-suspension');
    }
  } catch (err) {
    console.error('[pluslife] could not spawn caffeinate:', err);
  }
}
function stopCaffeinate() {
  if (caffeinate) {
    try {
      caffeinate.kill();
    } catch {
      /* ignore */
    }
    caffeinate = null;
  }
  if (psbId !== -1 && powerSaveBlocker.isStarted(psbId)) {
    powerSaveBlocker.stop(psbId);
    psbId = -1;
  }
}

// ---------------------------------------------------------------------------
// Web Bluetooth: intercept Chromium's device chooser and auto-pick the dock.
// The upstream app calls navigator.bluetooth.requestDevice(); Electron surfaces
// the discovered devices here instead of showing a picker. We select the
// remembered device, else a single candidate, else a name-hint match.
// ---------------------------------------------------------------------------
let btCallback = null;
let btTimer = null;

function wireBluetooth(contents) {
  contents.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault();
    btCallback = callback;

    if (DEBUG) {
      console.log(
        '[pluslife] bluetooth devices:',
        deviceList.map((d) => `${d.deviceName || '(unnamed)'} = ${d.deviceId}`),
      );
    }

    const pick = chooseDevice(deviceList);
    if (pick) {
      remember(pick);
      clearTimeout(btTimer);
      btTimer = null;
      btCallback = null;
      callback(pick.deviceId);
      return;
    }

    // No confident match yet. Keep waiting for more advertisements; after a
    // grace period, take the first device rather than hanging forever.
    if (!btTimer) {
      btTimer = setTimeout(() => {
        btTimer = null;
        if (!btCallback) return;
        const cb = btCallback;
        btCallback = null;
        const fallback = deviceList[0];
        if (fallback) {
          remember(fallback);
          cb(fallback.deviceId);
        } else {
          cb(''); // cancel; the watchdog will retry
        }
      }, 4000);
    }
  });

  // Grant Bluetooth without extra prompts for our own trusted app URL.
  const ses = contents.session;
  ses.setPermissionCheckHandler(() => true);
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  if (ses.setDevicePermissionHandler) {
    ses.setDevicePermissionHandler(() => true);
  }
}

function chooseDevice(list) {
  if (!list.length) return null;
  if (config.bluetoothDeviceId) {
    const remembered = list.find((d) => d.deviceId === config.bluetoothDeviceId);
    if (remembered) return remembered;
  }
  const named = list.filter((d) => DEVICE_NAME_HINT.test(d.deviceName || ''));
  if (named.length === 1) return named[0];
  if (list.length === 1) return list[0];
  return null;
}

function remember(device) {
  config.bluetoothDeviceId = device.deviceId;
  config.bluetoothDeviceName = device.deviceName || config.bluetoothDeviceName;
  saveConfig(config);
}

// ---------------------------------------------------------------------------
// Renderer automation. automation.js drives the (shadow-DOM) UI: accept the
// disclaimer, click "Connect via Bluetooth", restore the last test type, and
// re-click "Reconnect" when the flaky BT link drops. It must run with user
// activation for requestDevice(), so we re-invoke tick() from here with
// userGesture=true on a short interval.
// ---------------------------------------------------------------------------
const automationSource = fs.readFileSync(path.join(__dirname, 'automation.js'), 'utf8');
let tickTimer = null;

function installAutomation(contents) {
  const boot = `window.__PLUSLIFE_DEBUG=${DEBUG};window.__PLUSLIFE_NO_CONNECT=${NO_CONNECT};\n${automationSource}\n//# sourceURL=pluslife-automation.js`;
  contents
    .executeJavaScript(boot, true)
    .then(() => {
      if (tickTimer) clearInterval(tickTimer);
      tickTimer = setInterval(() => {
        if (!win || win.isDestroyed()) return;
        contents
          .executeJavaScript('window.__pluslife && window.__pluslife.tick()', true)
          .catch(() => {});
      }, 750);
    })
    .catch((err) => console.error('[pluslife] automation injection failed:', err));
}

// ---------------------------------------------------------------------------
// IPC bridge so the injected automation can read/write persistent config
// (last test type, etc.) via preload's window.plBridge.
// ---------------------------------------------------------------------------
ipcMain.handle('pluslife:getConfig', () => config);
ipcMain.handle('pluslife:setConfig', (_e, patch) => {
  config = { ...config, ...patch };
  saveConfig(config);
  return config;
});

// ---------------------------------------------------------------------------
// App lifecycle.
// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 850,
    title: 'Pluslife Analyzer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  wireBluetooth(win.webContents);

  if (DEBUG) {
    win.webContents.on('console-message', (_e, _level, message) => {
      if (message.startsWith('[pluslife]')) dlog('renderer', message);
    });
  }

  win.webContents.on('did-finish-load', () => installAutomation(win.webContents));
  win.on('closed', () => {
    win = null;
  });

  win.loadURL(APP_URL);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    logFile = path.join(app.getPath('userData'), 'pluslife-debug.log');
    config = loadConfig();
    dlog(`starting: url=${APP_URL} debug=${DEBUG} noConnect=${NO_CONNECT}`);
    startCaffeinate();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    stopCaffeinate();
    app.quit();
  });

  app.on('before-quit', stopCaffeinate);
}
