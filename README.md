# Pluslife Analyzer

A one-click macOS app for running [Pluslife](https://virus.sucks/pluslife_app/)
molecular tests, built to fix four annoyances with using the web app in Chrome:

| Problem with the browser app | How this fixes it |
| --- | --- |
| Mac sleeps mid-test → connection drops, data lost | Holds a native `caffeinate -i` idle-sleep assertion for the whole session (a web page can only hold a Screen Wake Lock, which is released the moment the tab is backgrounded — that's why tests were lost) |
| Must re-select the Bluetooth device every launch | Intercepts Chromium's device chooser and auto-selects the remembered dock |
| Must re-select the test type every run | Remembers and re-applies your last test type *(scaffolded — see Status)* |
| Open Chrome → pick profile → load site | It's a normal `.app` with a dock icon |

It is a thin Electron shell around the community-maintained
[virus.sucks Pluslife Analyzer](https://virus.sucks/pluslife_app/). We deliberately
reuse that app's device protocol and amplification-curve analysis rather than
reimplementing them, and only add the native behaviors a browser page cannot.

## Run it (development)

```bash
cd ~/code/jaraco/pluslife-analyzer
npm install
npm start
```

`npm start` launches via `open` on purpose (see *macOS Bluetooth & TCC* below).
Verbose logging — prints discovered Bluetooth devices and the test-type controls
it finds (how we finalize the last selector, see Status) — goes to a file, since
an `open`-launched app has no terminal:

```bash
npm run debug
tail -f "$HOME/Library/Application Support/pluslife-analyzer/pluslife-debug.log"
```

For pure UI work without touching Bluetooth, `npm run start:ui` runs a plain
in-terminal build with auto-connect disabled.

### macOS Bluetooth & TCC

macOS kills any process that touches Bluetooth unless its **code-signed**
Info.plist carries `NSBluetoothAlwaysUsageDescription`, *and* it attributes the
permission to the **responsible process** — for an app launched as a child of a
terminal, that's the terminal, not Electron. So a plain `electron .` crashes
(`SIGABRT`, TCC violation) the instant it connects. Two consequences:

- The **packaged app** (launched from Finder/launchd) is its own responsible
  process and gets the key from `build.mac.extendInfo` — it just works.
- **Dev runs** must go through `open` (what `npm start` and `scripts/run.sh` do)
  and use a re-signed dev binary (`scripts/patch-dev-plist.sh` adds the key and
  re-seals the signature). First connect prompts for Bluetooth permission.

## Build a double-clickable app

```bash
npm run dist
```

Produces a `.dmg` / `.zip` under `dist/`. (The app is unsigned; first launch
needs right-click → Open, or an ad-hoc/Developer-ID signature.)

## How it works

- **`src/main.js`** — Electron main process. Spawns `caffeinate`, handles
  `select-bluetooth-device` to auto-pick the dock, and drives the renderer
  automation on a short interval with user activation so `requestDevice()` is
  allowed.
- **`src/preload.js`** — exposes a tiny `window.plBridge` (get/set config) over
  IPC; no Node access is given to the remote page.
- **`src/automation.js`** — injected into the app's shadow-DOM UI: accepts the
  disclaimer, clicks *Connect via Bluetooth*, restores the last test type, and
  re-clicks *Reconnect* when the (hardware-flaky) Bluetooth link drops.

Config persists at
`~/Library/Application Support/pluslife-analyzer/config.json`.

### Configuration (env vars)

- `PLUSLIFE_URL` — override the app URL (e.g. a pinned local copy).
- `PLUSLIFE_DEVICE_HINT` — regex to recognize your dock by advertised name on
  first connect (default matches `pluslife|minidock|mira|mhealth|health`).
- `PLUSLIFE_DEBUG=1` — verbose logging.

## Status

Verified without hardware:

- **Keep-awake** — `caffeinate -i -w <pid>` spawns, is tied to the app, and
  releases automatically on quit (no leaked assertion).
- **One-click launch, auto-accept disclaimer, auto-click Connect** — the
  injected automation drives the shadow-DOM UI on its own.
- **Web Bluetooth activation** — the auto-click reaches `requestDevice()`: on an
  `open`-launched build it triggers the OS Bluetooth permission prompt (proof the
  `executeJavaScript(code, userGesture)` gesture is accepted) instead of crashing.

Verified on a real dock:

- **Auto-connect to the remembered device** — connects on launch with no chooser
  (confirmed against S/N 2443010353).

Implemented, verify on your next test cycle:

- **Last test-type memory** — the app resets the selected kit (`_selectedKit`)
  every load, so it's never remembered. Featured kits render as `<sl-button>`s
  (the selected one is `variant="primary"`); the rest live behind an "Other..."
  dropdown. We persist the chosen kit by name and re-apply it (clicking the button
  or picking from the dropdown). It only appears on the pre-test selection screen,
  so: connect, pick your kit once, quit, relaunch — it should come back selected.
  `npm run debug` logs the kit buttons it sees.
- **Reconnect watchdog** — clicks Reconnect on a drop; needs a real drop to tune
  timing.

## Relationship to virus.sucks

This wrapper loads the upstream app as-is and is not affiliated with it. Two of
the four fixes (auto-reconnect to a known device via `getDevices()`, and
last-test-type memory) would be small upstream additions worth suggesting to the
maintainer (`hi@virus.sucks`); the keep-awake fix cannot be done from a browser
and is the main reason this native shell exists.
