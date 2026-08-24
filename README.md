# Pluslife Analyzer

A one-click macOS app for running [Pluslife](https://virus.sucks/pluslife_app/)
molecular tests, built to fix five annoyances with using the web app in Chrome:

| Problem with the browser app | How this fixes it |
| --- | --- |
| Mac sleeps mid-test → connection drops, data lost | Holds a native `caffeinate -i` idle-sleep assertion **while a test is running** (heating/testing/reconnected), released when idle or done (a web page can only hold a Screen Wake Lock, which is released the moment the tab is backgrounded — that's why tests were lost) |
| Must re-select the Bluetooth device every launch | Intercepts Chromium's device chooser and auto-selects the remembered dock |
| Must re-select the test type every run | Remembers and re-applies your last test kit |
| Open Chrome → pick profile → load site | It's a normal `.app` with a dock icon |
| Results not captured anywhere by default | On completion, auto-saves a screenshot **and** the JSON export to `~/Downloads` |
| A stalled test is unrecoverable — the countdown freezes, nothing ever completes, and the data collected so far is stranded behind a results screen you never reach | Watches for the silence, saves what has been collected, then forces a reconnect (see *Stalled tests* below) |

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
  disclaimer, clicks *Connect via Bluetooth*, restores the last test kit,
  re-clicks *Reconnect* when the (hardware-flaky) Bluetooth link drops, and
  triggers the save-on-completion flow.

Config persists at
`~/Library/Application Support/pluslife-analyzer/config.json`.

## Saving results

When a test completes, the app automatically writes two files to your download
folder (default `~/Downloads`):

- `pluslife-<kit>-<serial>-<timestamp>.png` — a screenshot of the results page
  (via Electron `capturePage()`).
- `pluslife-<kit>-<serial>-<timestamp>.json` — the app's own *Export raw data as
  JSON*. This lives behind the app's **expert mode**, which the wrapper enables
  automatically (disable with `PLUSLIFE_EXPERT=0` / `--no-expert`).

**Change the folder** any of three ways (first match wins):

1. `PLUSLIFE_DOWNLOAD_DIR` environment variable.
2. **File → Set Download Folder…** in the menu (native folder picker; persists to
   `config.json`). **File → Open Download Folder** reveals it.
3. Otherwise `~/Downloads`.

### Configuration (env vars)

- `PLUSLIFE_URL` — override the app URL (e.g. a pinned local copy).
- `PLUSLIFE_DEVICE_HINT` — regex to recognize your dock by advertised name on
  first connect (default matches `pluslife|minidock|mira|mhealth|health`).
- `PLUSLIFE_DOWNLOAD_DIR` — where result artifacts are saved (default `~/Downloads`).
- `PLUSLIFE_EXPERT=0` — don't enable the app's expert mode (disables JSON export).
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
- **Save on completion** — validated end-to-end against a mock results page: the
  screenshot and JSON both land in `~/Downloads` with correct names, once per
  test. On a real dock, confirm the results screen exposes the expert-mode JSON
  button (it should, since the wrapper enables expert mode).

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
- **Reconnect watchdog** — clicks Reconnect on a drop (rate-limited to one click
  per 8 s); needs a real drop to tune timing.
Verified on a real dock (2026-08-23, five induced stalls):

- **Stall detection and salvage** — detected at exactly 20 s every time, with the
  `-partial-` screenshot and JSON on disk within 0.2 s, before anything touched the
  connection.
- **In-session recovery with the curve intact** — after a simulated silent stall
  (`File → Simulate Link Stall` in `--pluslife-debug` builds stops the notification
  stream while leaving the link up, which is what a brief radio glitch leaves
  behind), the app salvaged, forced the lost-link state, reconnected, and resumed the
  same test. The final export ran continuously from test start to completion with a
  single gap where the link was down — not a fresh series from the reconnect — and
  the result was captured normally.
- **Known limit** — if the *host's* Bluetooth adapter is cycled (rather than the link
  merely glitching), that renderer's Web Bluetooth scanning never recovers: no amount
  of clicking Reconnect finds the dock again, while a fresh process finds it in under
  a second. Salvage still happens, so no data is lost; recovery in that case needs
  the app restarted. See issue #8.

## Stalled tests

Occasionally a run just stops: **Remaining time** freezes, the graphs stop growing,
and the app sits there claiming to be connected forever. The countdown is pure wall
clock and only repaints when a packet arrives, so a frozen countdown means exactly
one thing — nothing is coming from the dock any more. The test never reaches DONE,
so the save-on-completion path above never fires.

Upstream cannot recover from this, for a reason worth knowing: **nothing in its
connect path has a timeout**. After a GATT drop its transport retries
`gatt.connect()`, and CoreBluetooth will wait forever for a peripheral that never
answers. That one pending promise wedges the writer routine; `disconnect()` wedges
behind it (it awaits the routine); the app keeps its green **Connected** badge; and
housekeeping times out every 7 s until you close the window. Recovery therefore
cannot trust *any* of those promises to settle — every step below has a deadline.

Measured against a real dock, temperature samples arrive every **2.0 s** (the ~30 s
spacing of points on the graph is decimation, not the stream rate) and reaction
samples in bursts about a minute apart. Twenty seconds of silence — ten missed
messages — is therefore the trigger. This app watches the test controller for it and
then, in order:

1. **Saves what you have** — screenshot plus the app's own JSON export, both tagged
   `-partial-` in the filename. The export lives on the test controller rather than
   on the results screen, so it works mid-test; the file simply has no `testResult`.
   The data is on disk *before* anything touches the connection.
2. **Forces a reconnect** — cancels the GATT link, then asks the transport to
   disconnect. If that hasn't completed in 5 s (it usually hasn't), declares the
   link lost directly so the app renders **Reconnect** instead of a green badge over
   a dead link, and stops the writer routine upstream would otherwise strand. The
   existing watchdog clicks Reconnect; that path runs a full connect and does
   re-subscribe to notifications. Retried every 45 s while the silence lasts.
3. **Keeps the app clickable** — a `requestDevice()` that was scanning when the
   Bluetooth adapter cycled never resolves, and the "Reconnecting" state renders no
   button to start a fresh one. After 30 s, the chooser is cancelled from the main
   process (something no web page can do for itself) and the app drops back so a new
   scan can begin.

Crucially, `test-view` stays mounted throughout — the app only tears the controller
down when it reaches "Not connected", which this path deliberately avoids. So the
samples collected before the stall survive in memory, and a successful reconnect
resumes *the same test*: one continuous curve, and a normal completion still writes
the full artifacts. You just also have the partial capture from the gap.

Upstream's `alert()` on a failed connection is replaced with a log line. It blocks
the renderer thread, which stops the watchdog and the retry loop dead until someone
clicks OK — fatal for a 35-minute test running unattended. `confirm()` is left alone,
since it guards stopping a test and enabling expert mode.

**File → Save Current Test Data** does step 1 on demand, at any point in a run.

Stall, recovery and salvage lines are always written to
`~/Library/Application Support/pluslife-analyzer/pluslife-debug.log`, even without
`--pluslife-debug`, since a stall is by definition something nobody was watching.

## Relationship to virus.sucks

This wrapper loads the upstream app as-is and is not affiliated with it. Two of
the four fixes (auto-reconnect to a known device via `getDevices()`, and
last-test-type memory) would be small upstream additions worth suggesting to the
maintainer (`hi@virus.sucks`); the keep-awake fix cannot be done from a browser
and is the main reason this native shell exists.
