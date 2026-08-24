'use strict';

const {
  app,
  BrowserWindow,
  session,
  ipcMain,
  powerSaveBlocker,
  dialog,
  Menu,
  shell,
  nativeImage,
} = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// App icon (built from the app's power.webp logo). The packaged app gets its
// icon from assets/icon.icns via electron-builder; this PNG drives the dev dock
// icon and the BrowserWindow icon (used on Windows/Linux).
const ICON_PNG = path.join(__dirname, '..', 'assets', 'icon.png');

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
// Expert mode unlocks the app's "Export raw data as JSON" control, which we use
// to auto-export results on completion. On unless explicitly disabled.
const EXPERT =
  process.env.PLUSLIFE_EXPERT !== '0' && !process.argv.includes('--no-expert');

let logFile = null; // set once app paths are available
function logLine(args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  return line;
}
function writeLog(line) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `${line}\n`);
  } catch {
    /* ignore */
  }
}
// Verbose tracing: file only under --pluslife-debug.
function dlog(...args) {
  const line = logLine(args);
  if (DEBUG) writeLog(line);
}
// Significant events (test complete, stall, recovery, salvage) always reach the
// log file: an `open`-launched app has no terminal, so this is the only record
// of a run that went wrong, and a stall is exactly the case nobody was watching.
function elog(...args) {
  writeLog(logLine(args));
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
// Keep the Mac awake *while a test is running* (driven by the renderer via the
// pluslife:setKeepAwake IPC). This is the core reason the app exists: a browser
// page can only hold a Screen Wake Lock (released the moment the tab is
// backgrounded), which is why tests were lost on sleep. `caffeinate` holds a
// real IOKit PreventUserIdleSystemSleep assertion that survives backgrounding
// and clamshell-on-external-display operation.
//   -i  prevent idle system sleep
//   -w  release automatically if this process (Electron main) dies mid-test
// startCaffeinate/stopCaffeinate are idempotent, so repeated calls are safe.
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

    // dlog, not console.log: an `open`-launched app has no terminal, so this
    // went nowhere -- and what the chooser can and cannot see is the first
    // question worth asking when a reconnect won't take.
    dlog(
      'bluetooth devices:',
      JSON.stringify(deviceList.map((d) => `${d.deviceName || '(unnamed)'}=${d.deviceId}`)),
    );

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

// Cancel an in-flight requestDevice() chooser. A page cannot abandon its own
// pending requestDevice(), and one that was scanning when the Bluetooth adapter
// cycled never resolves -- leaving the app stuck on "Reconnecting" with no way
// to start the fresh scan that would actually find the dock (#8). Only the main
// process holds the callback that ends it.
ipcMain.handle('pluslife:cancelBluetoothChooser', () => {
  if (!btCallback) return false;
  const cb = btCallback;
  btCallback = null;
  clearTimeout(btTimer);
  btTimer = null;
  try {
    cb(''); // rejects requestDevice() with NotFoundError, which upstream expects
  } catch (err) {
    dlog('chooser cancel failed:', err && err.message);
    return false;
  }
  dlog('cancelled a pending Bluetooth chooser');
  return true;
});

// Renderer toggles the native keep-awake assertion as a test starts/ends.
ipcMain.handle('pluslife:setKeepAwake', (_e, on) => {
  if (on) startCaffeinate();
  else stopCaffeinate();
  dlog(`keep-awake ${on ? 'started (test active)' : 'stopped (idle)'}`);
  return true;
});

// ---------------------------------------------------------------------------
// Auto-save on test completion: a screenshot of the results page plus the app's
// own JSON export, both written to the download folder (default ~/Downloads,
// overridable via the app menu, config.downloadDir, or PLUSLIFE_DOWNLOAD_DIR).
// ---------------------------------------------------------------------------
let lastMeta = {}; // { serial, testType } from the most recent completion

function downloadDir() {
  const dir = process.env.PLUSLIFE_DOWNLOAD_DIR || config.downloadDir || app.getPath('downloads');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* fall through; the write will surface any real error */
  }
  return dir;
}

function stamp() {
  // Filename-safe local timestamp: 2026-08-07_141530
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function baseName(meta) {
  const parts = ['pluslife'];
  if (meta.testType) parts.push(String(meta.testType).replace(/[^\w.-]+/g, '-'));
  if (meta.serial) parts.push(String(meta.serial).replace(/[^\w.-]+/g, '-'));
  // A capture taken mid-test (stall salvage or a manual save) has no result in
  // it; say so in the name rather than letting it pass for a finished run.
  if (meta.partial) parts.push('partial');
  parts.push(stamp());
  return parts.join('-');
}

// Route the app's JSON download (an <a download> click) straight to disk, no
// Save dialog. The only downloads this app produces are result exports.
function wireDownloads(ses) {
  ses.on('will-download', (_event, item) => {
    const target = path.join(downloadDir(), `${baseName(lastMeta)}.json`);
    item.setSavePath(target);
    item.once('done', (_e, state) => {
      dlog(state === 'completed' ? `saved JSON: ${target}` : `JSON download ${state}`);
    });
  });
}

// Full-page screenshot (the whole rendered document, not just the viewport) via
// the DevTools Protocol — the results page scrolls past the fold, and viewport-
// only capturePage() was clipping important data.
async function captureFullPage(wc) {
  const dbg = wc.debugger;
  const weAttached = !dbg.isAttached();
  if (weAttached) dbg.attach('1.3');
  try {
    const metrics = await dbg.sendCommand('Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize;
    const clip = {
      x: 0,
      y: 0,
      width: Math.ceil(size.width),
      height: Math.ceil(size.height),
      scale: 1,
    };
    const shot = await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      fromSurface: true,
      clip,
    });
    return Buffer.from(shot.data, 'base64');
  } finally {
    if (weAttached) {
      try {
        dbg.detach();
      } catch {
        /* ignore */
      }
    }
  }
}

async function captureScreenshot(meta) {
  if (!win || win.isDestroyed()) return;
  const target = path.join(downloadDir(), `${baseName(meta)}.png`);
  try {
    await fs.promises.writeFile(target, await captureFullPage(win.webContents));
    dlog(`saved screenshot: ${target}`);
  } catch (err) {
    // Full-page capture is the sole behavior; on failure we log and let the JSON
    // export still proceed rather than saving a clipped viewport image.
    dlog('screenshot failed:', err && err.message);
  }
}

// The renderer signals completion; we snapshot the page here, then it clicks the
// app's JSON export (caught by will-download above).
ipcMain.handle('pluslife:testComplete', async (_e, meta) => {
  lastMeta = meta || {};
  if (lastMeta.partial) elog(`partial capture: ${JSON.stringify(lastMeta)}`);
  else dlog(`test complete: ${JSON.stringify(lastMeta)}`);
  await captureScreenshot(lastMeta);
  return true;
});

// ---------------------------------------------------------------------------
// Application menu: let the user change where artifacts are saved.
// ---------------------------------------------------------------------------
// Salvage the data collected so far, at any point in a run. The upstream export
// lives on the test controller rather than on the results screen, so the
// renderer can call it mid-test -- see saveNow() in automation.js.
async function saveCurrentTestData() {
  if (!win || win.isDestroyed()) return;
  let res = null;
  try {
    res = await win.webContents.executeJavaScript(
      'window.__pluslife && window.__pluslife.saveNow()',
      true,
    );
  } catch (err) {
    res = { ok: false, reason: (err && err.message) || 'the page did not respond' };
  }
  if (res && res.ok) {
    elog(`manual save: ${res.samples} samples -> ${downloadDir()}`);
    return;
  }
  await dialog.showMessageBox(win, {
    type: 'info',
    message: 'Nothing to save yet',
    detail:
      (res && res.reason) ||
      'No test data has been collected. Connect the dock and start a test first.',
  });
}

async function chooseDownloadFolder() {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose download folder for test results',
    defaultPath: downloadDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (!res.canceled && res.filePaths[0]) {
    config.downloadDir = res.filePaths[0];
    saveConfig(config);
    dlog(`download folder set to ${config.downloadDir}`);
  }
}

// Debug-only: make the link go silent without touching the radio, so the stall
// watchdog and its recovery can be exercised on demand (see automation.js).
async function simulateStall() {
  if (!win || win.isDestroyed()) return;
  let res = null;
  try {
    res = await win.webContents.executeJavaScript(
      'window.__pluslife && window.__pluslife.simulateStall()',
      true,
    );
  } catch (err) {
    res = { ok: false, reason: (err && err.message) || 'the page did not respond' };
  }
  elog(`simulate stall: ${res && res.ok ? 'notifications stopped' : (res && res.reason) || 'failed'}`);
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Save Current Test Data', click: saveCurrentTestData },
        ...(DEBUG
          ? [{ label: 'Simulate Link Stall (debug)', click: simulateStall }]
          : []),
        { type: 'separator' },
        { label: 'Set Download Folder…', click: chooseDownloadFolder },
        {
          label: 'Open Download Folder',
          click: () => shell.openPath(downloadDir()),
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// App lifecycle.
// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 850,
    title: 'Pluslife Analyzer',
    icon: fs.existsSync(ICON_PNG) ? ICON_PNG : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Preload reads this to enable the app's expert mode (for JSON export)
      // before the page's scripts run.
      additionalArguments: EXPERT ? ['--pluslife-expert'] : [],
    },
  });

  wireBluetooth(win.webContents);
  wireDownloads(win.webContents.session);

  // The upstream page installs a `beforeunload` guard while a test is running or
  // finished (state 2/3). Electron honors that by cancelling the window close,
  // which made the app impossible to quit after a run (Cmd+Q/menu/dock all
  // silently vetoed). We auto-save results, so always allow the close.
  win.webContents.on('will-prevent-unload', (event) => {
    event.preventDefault();
  });

  // Electron 43 replaced the positional (event, level, message, ...) form with a
  // single event object; the old signature still fires but logs a deprecation.
  win.webContents.on('console-message', ({ message }) => {
    if (!message) return;
    if (!message.startsWith('[pluslife]')) {
      // Under --pluslife-debug, keep the upstream app's own console too: its
      // transport narrates every GATT drop, retry and timeout, which is the
      // only account of what the link actually did during a stall.
      if (DEBUG) dlog('page', message);
      return;
    }
    // Stall and recovery chatter is the evidence for what went wrong; keep it
    // whether or not this run was started with --pluslife-debug.
    if (/stall|recovery|export|resumed|disconnect|alert/i.test(message)) elog('renderer', message);
    else if (DEBUG) dlog('renderer', message);
  });

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
    dlog(`starting: url=${APP_URL} debug=${DEBUG} noConnect=${NO_CONNECT} expert=${EXPERT}`);
    // Dev dock icon (packaged builds get their icon from the app bundle).
    if (process.platform === 'darwin' && app.dock && fs.existsSync(ICON_PNG)) {
      app.dock.setIcon(nativeImage.createFromPath(ICON_PNG));
    }
    buildMenu();
    // Keep-awake is no longer session-wide; the renderer starts/stops it per
    // test via the pluslife:setKeepAwake IPC (see below).
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
