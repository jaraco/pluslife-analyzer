'use strict';

// Injected into the upstream Pluslife app's main world. The app renders its UI
// inside nested shadow roots (a <pluslife-app> web component built on Shoelace
// <sl-*> elements), so every lookup pierces shadow boundaries.
//
// main.js calls window.__pluslife.tick() on a short interval, each call carrying
// user activation, so the "Connect via Bluetooth" click satisfies Web
// Bluetooth's transient-activation requirement.
//
// NOTE: the test-type controls only exist after a device is connected, which
// requires the hardware. That section (restoreTestType) is best-effort and, in
// PLUSLIFE_DEBUG mode, logs the controls it finds so the exact selectors can be
// pinned down against a live dock. Everything else is final.

(() => {
  if (window.__pluslife) return; // install once

  const DEBUG = /* replaced at build time if desired */ false || !!window.__PLUSLIFE_DEBUG;
  const log = (...a) => console.log('[pluslife]', ...a);

  const state = {
    cfg: {},
    lastConnectClick: 0,
    connectCooldownMs: 8000,
    lastReconnectClick: 0,
    dumped: false,
    savedThisTest: false,
    keepAwake: false,
    // Stall watchdog (#8): dataAt is the newest datum the app has, seenAt is when
    // we first saw that value, so "silence" is measured on our own clock.
    dataAt: 0,
    seenAt: 0,
    salvaged: false,
    recoveries: 0,
    lastRecoveryAt: 0,
    exportPending: false,
    disconnectDeadline: 0,
    reconnectingSince: 0,
  };

  // A running test that has gone this long without a single packet is stalled.
  // Measured against a real dock: temperature samples land every 2.0 s (174 of
  // them across a 5.7 min run; min 1.7 s, max 2.2 s), with reaction samples
  // arriving in bursts about a minute apart. The graph's ~30 s point spacing is
  // decimation, not the stream rate. Twenty seconds is therefore ten missed
  // messages -- past any plausible hiccup, including the ~5-10 s upstream's own
  // GATT retry loop takes to heal or give up, without waiting minutes to react.
  // Recovery is then re-attempted on the second cadence for as long as the
  // silence lasts: long enough for a reconnect (which re-runs the device
  // handshake) to actually land before we judge it failed.
  const STALL_MS = 20000;
  const RECOVERY_SETTLE_MS = 45000;

  // Neither gatt.connect() nor CoreBluetooth beneath it has a timeout, so a link
  // that dies mid-test leaves promises pending forever: upstream's writer routine
  // wedges awaiting a reconnect that never settles, its disconnect() wedges behind
  // that (it awaits the routine), and the app sits on a green "Connected" badge
  // over a dead link. Recovery therefore cannot trust any of those promises to
  // settle -- each step below gets a deadline, after which we set the state the
  // app should have reached on its own. Observed on a real dock; see #8.
  const DISCONNECT_TIMEOUT_MS = 5000;
  const RECONNECTING_TIMEOUT_MS = 30000;

  // Upstream reports connection failures with alert(), which blocks the renderer
  // thread outright: while a dialog is up our tick stops, the stall watchdog stops,
  // and a failed reconnect waits for a human. Tests run ~35 minutes unattended, so
  // that dialog is fatal to exactly the recovery this wrapper exists to perform --
  // observed costing 35 s of a live recovery until someone clicked OK. Log instead.
  // confirm() is deliberately left alone: it guards stopping a running test and
  // enabling expert mode, where auto-answering would be wrong.
  window.alert = function (msg) {
    log('suppressed alert:', String(msg).replace(/\s+/g, ' ').slice(0, 300));
  };

  // Load persisted config once (async; fine if the first few ticks miss it).
  if (window.plBridge) {
    window.plBridge.getConfig().then((c) => {
      state.cfg = c || {};
    });
  }

  // --- shadow-DOM-aware queries ------------------------------------------
  function deepQueryAll(selector, root = document) {
    const out = [];
    const visit = (node) => {
      if (!node || !node.querySelectorAll) return;
      node.querySelectorAll(selector).forEach((el) => out.push(el));
      node.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) visit(el.shadowRoot);
      });
    };
    visit(root);
    return out;
  }
  const deepQuery = (selector, root) => deepQueryAll(selector, root)[0] || null;

  function byText(selector, re) {
    return deepQueryAll(selector).find((el) => re.test((el.textContent || '').trim()));
  }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // --- individual behaviors ----------------------------------------------
  function acceptDisclaimer() {
    const cb = deepQuery('#terms-checkbox');
    if (cb && !cb.checked) {
      cb.checked = true;
      cb.dispatchEvent(new Event('sl-change', { bubbles: true }));
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const cont = byText('sl-button, button', /^continue$/i);
    if (cont && !cont.disabled && visible(cont)) cont.click();
  }

  function connectIfIdle() {
    if (window.__PLUSLIFE_NO_CONNECT) return;
    // If the Bluetooth connect button is on screen, we are not connected.
    const btn = byText('sl-button, button', /connect via bluetooth/i);
    if (!btn || !visible(btn)) return;
    if (Date.now() - state.lastConnectClick < state.connectCooldownMs) return;
    state.lastConnectClick = Date.now();
    log('clicking Connect via Bluetooth');
    btn.click();
  }

  function reconnectWatchdog() {
    const btn = byText('sl-button, button', /re-?connect/i);
    if (!btn || !visible(btn)) return;
    // Each click runs a full requestDevice() + handshake; at tick speed we would
    // stack a dozen of them before the first resolves. Same cooldown as Connect.
    if (Date.now() - state.lastReconnectClick < state.connectCooldownMs) return;
    state.lastReconnectClick = Date.now();
    log('reconnecting after drop');
    btn.click();
  }

  // The test "kit" is an <sl-select> of <sl-option value=zs(kit)>kit.name</sl-option>.
  // The app resets the selection (_selectedKit) on every load, which is why the
  // test type has to be re-picked each run. We persist the chosen kit by its
  // human name (kit.name), which is a stable, non-localized product string.
  //
  // On the "Select a test kit" screen the featured kits render as <sl-button>s
  // (the selected one is variant="primary"); the rest live in an <sl-select>
  // revealed by an "Other..." button. We track the current selection by reading
  // the UI and persist/restore by kit name, covering both paths.
  const FEATURED_KITS = ['SARS-CoV-2', 'SARS-CoV-2/Flu A/Flu B', 'Flu A/Flu B/RSV', 'Strep A'];
  const btnText = (b) => (b.textContent || '').trim();
  const isPrimary = (el) => el.getAttribute && el.getAttribute('variant') === 'primary';
  // Fire the 'click' the Lit @click handler listens for, bypassing Shoelace's
  // own .click() (which throws if the button's internals aren't rendered yet).
  const clickEl = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  function kitButtons() {
    return deepQueryAll('sl-button').filter((b) => FEATURED_KITS.includes(btnText(b)));
  }
  function otherButton() {
    const feat = kitButtons()[0];
    if (!feat || !feat.parentElement) return null;
    return (
      [...feat.parentElement.querySelectorAll('sl-button')].find(
        (b) => !FEATURED_KITS.includes(btnText(b)),
      ) || null
    );
  }
  function kitDropdown() {
    return deepQueryAll('sl-select').find((s) => s.querySelector('sl-option')) || null;
  }
  function currentKitLabel() {
    const active = kitButtons().find(isPrimary);
    if (active) return btnText(active);
    const sel = kitDropdown();
    if (sel && sel.value) {
      const opt = [...sel.querySelectorAll('sl-option')].find((o) => o.value === sel.value);
      if (opt) return (opt.textContent || '').trim();
    }
    return null;
  }

  function persistKit(label) {
    if (!label || label === state.cfg.lastTestName) return;
    state.cfg.lastTestName = label;
    if (window.plBridge) window.plBridge.setConfig({ lastTestName: label });
    log('remembered kit:', label);
  }

  function restoreKit(wanted) {
    // Featured kit → click its button.
    const btn = kitButtons().find((b) => btnText(b) === wanted);
    if (btn) {
      clickEl(btn);
      log('restored kit:', wanted);
      return;
    }
    // Non-featured kit → open "Other..." then select it in the dropdown.
    const sel = kitDropdown();
    if (!sel) {
      const other = otherButton();
      if (other) clickEl(other); // reveals the dropdown on the next tick
      return;
    }
    const opt = [...sel.querySelectorAll('sl-option')].find(
      (o) => (o.textContent || '').trim() === wanted,
    );
    if (opt && sel.value !== opt.value) {
      sel.value = opt.value;
      sel.dispatchEvent(new Event('sl-change', { bubbles: true }));
      log('restored kit (other):', wanted);
    }
  }

  function restoreTestType() {
    // Only act on the select-a-kit screen (featured buttons present).
    if (!kitButtons().length) return;

    if (DEBUG && !state.dumped) {
      state.dumped = true;
      log('kit buttons:', kitButtons().map(btnText));
    }

    const current = currentKitLabel();
    if (current) {
      persistKit(current); // remember whatever is selected now
    } else if (state.cfg.lastTestName) {
      restoreKit(state.cfg.lastTestName); // nothing selected yet → re-apply
    }
  }

  // When a test completes, the results screen shows an "Export raw data as JSON"
  // button (expert mode, enabled by preload). "JSON" is in that label in every
  // locale, so it's a reliable, language-independent completion signal. On first
  // sight we snapshot the page (via main) and click it to export the results.
  // The expert-mode "Load test from JSON" importer also contains "JSON" and sits
  // next to a hidden <input type="file">. Exclude it so we never trigger its file
  // picker; the real export button ("Export raw data as JSON") has no file input.
  function importButtons() {
    const set = new Set();
    deepQueryAll('input[type="file"]').forEach((inp) => {
      // parentNode, not parentElement: the input is a direct child of a
      // ShadowRoot, whose parentElement is null but which has querySelectorAll.
      const parent = inp.parentNode;
      if (!parent || !parent.querySelectorAll) return;
      parent.querySelectorAll('sl-button').forEach((b) => {
        if (/json/i.test(btnText(b))) set.add(b);
      });
    });
    return set;
  }
  function exportButton() {
    const skip = importButtons();
    return (
      deepQueryAll('sl-button').find((b) => /json/i.test(btnText(b)) && !skip.has(b)) || null
    );
  }
  function deviceSerial() {
    // The transport keeps the serial from the handshake; the S/N badge only
    // renders while connected, which is exactly not the case during a stall.
    const app = document.querySelector('pluslife-app');
    if (app && app.pluslife && app.pluslife.deviceSN) return app.pluslife.deviceSN;
    const badge = deepQueryAll('sl-badge, span, div').find((el) =>
      /S\/N[:\s]/i.test((el.textContent || '').trim()),
    );
    if (!badge) return null;
    const m = (badge.textContent || '').match(/S\/N[:\s]*([\w-]+)/i);
    return m ? m[1] : null;
  }

  function saveOnComplete() {
    const btn = exportButton();
    if (!btn) {
      state.savedThisTest = false; // left the results screen; arm for next test
      return;
    }
    if (state.savedThisTest) return;
    state.savedThisTest = true; // set before await so we fire exactly once

    const meta = { serial: deviceSerial(), testType: state.cfg.lastTestName || null };
    log('test complete, saving artifacts', JSON.stringify(meta));
    const done = window.plBridge
      ? window.plBridge.testComplete(meta) // main captures the screenshot first
      : Promise.resolve();
    done
      .then(() => {
        const b = exportButton(); // re-query in case Lit re-rendered
        if (b) clickEl(b); // triggers the JSON download → saved by main
      })
      .catch((err) => log('save-on-complete failed', err && err.message));
  }

  // Keep the Mac awake only while a test is actually in progress, so an idle
  // (but open) app doesn't prevent sleep. The test state lives on the test
  // controller at <test-view>.data.state: 2=TESTING, 4=BLOCKED_ALREADY_TESTING
  // (reconnected to a running test), 5=BLOCKED_NOT_READY (heating).
  //
  // Do NOT reach for pluslife-app._state: it is a *different* enum — the
  // connection state (0=not connected, 1=connecting, 2=connected, 3=connection
  // lost, 4=disconnecting, 5=reconnecting). Reading it held the assertion for as
  // long as the dock was connected, idle or not, and released it the moment the
  // link dropped mid-test — exactly when the Mac must stay awake to reconnect.
  //
  // The controller is independent of window visibility, so this survives
  // backgrounding, unlike the app's own screen wake lock.
  const KEEP_AWAKE_STATES = new Set([2, 4, 5]);
  // <test-view>.data is the test controller: it owns the test state, the samples
  // collected so far, and downloadJSON(). It exists from the moment a device is
  // connected and survives a disconnect, since test-view stays mounted for every
  // connection state except "not connected"/"connecting".
  function controller() {
    const tv = deepQuery('test-view');
    return (tv && tv.data) || null;
  }
  function testState() {
    const c = controller();
    return c && typeof c.state === 'number' ? c.state : null;
  }
  function updateKeepAwake() {
    const s = testState();
    const active = s != null && KEEP_AWAKE_STATES.has(s);
    if (active === state.keepAwake) return;
    state.keepAwake = active;
    log('keep-awake', active ? `ON (state ${s})` : `OFF (state ${s})`);
    if (window.plBridge && window.plBridge.setKeepAwake) window.plBridge.setKeepAwake(active);
  }

  // --- stall detection and recovery (#8) ---------------------------------
  //
  // A stalled test looks like nothing at all: the countdown freezes (it only
  // repaints when a packet arrives), the graphs stop growing, and the app stays
  // cheerfully "Connected" forever while housekeeping times out every 7 s.
  //
  // Measured cause, against a real dock: nothing in upstream's connect path has a
  // timeout. When the link dies, its writer routine retries gatt.connect(), and
  // CoreBluetooth waits indefinitely for a peripheral that never answers. That one
  // pending promise wedges the routine; disconnect() wedges behind it (it awaits
  // the routine); isConnected stays true, so the app never reports a lost link and
  // never offers Reconnect. Nothing reaches DONE, so save-on-completion never fires
  // and the samples collected so far are stranded.
  //
  // A briefer glitch can leave the link healthy but silent instead: CoreBluetooth
  // completes the pending reconnect on its own, and upstream re-acquires only the
  // write characteristic without re-subscribing to notifications. Indistinguishable
  // from here, and handled identically.
  //
  // So: watch the controller's data for silence, put what we have on disk first,
  // and only then touch the link -- giving every step a deadline, since none of
  // upstream's promises can be trusted to settle. test-view stays mounted across
  // "Connection lost" (it is only torn down at "Not connected"), so the controller
  // and its samples survive and a successful reconnect resumes the same test --
  // verified on hardware as one continuous curve across the gap.

  // Newest datum the app holds. Reaction samples stamp _lastSampleTime; the
  // temperature series carries its own timestamps and rides the same notification
  // stream. Either one moving means packets are still arriving.
  function lastDataAt(c) {
    let newest = 0;
    if (c._lastSampleTime instanceof Date) newest = c._lastSampleTime.getTime();
    const temps = (c.testData && c.testData.temperatureSamples) || [];
    const last = temps.length ? temps[temps.length - 1].time : null;
    if (last instanceof Date) newest = Math.max(newest, last.getTime());
    return newest;
  }

  // downloadJSON() dereferences _kitConfig.name and getFirstTimestamp() (the
  // first temperature sample) without guarding either, so refuse to call it
  // before there is something to export.
  function canExport(c) {
    return !!(
      c &&
      typeof c.downloadJSON === 'function' &&
      c._kitConfig &&
      c.testData &&
      c.testData.temperatureSamples &&
      c.testData.temperatureSamples.length
    );
  }

  // Export whatever the controller holds right now. This is the app's own JSON
  // export, called directly instead of through the results screen, so it works
  // mid-test -- testResult is simply absent from the file. main takes the
  // screenshot first (via testComplete) and catches the download.
  function exportNow(reason) {
    const c = controller();
    if (!canExport(c)) {
      log('nothing to export yet', reason);
      return Promise.resolve({ ok: false, reason: 'no test data collected yet' });
    }
    const meta = {
      serial: deviceSerial(),
      testType: (c._kitConfig && c._kitConfig.name) || state.cfg.lastTestName || null,
      partial: c.state !== 3, // 3 = DONE; anything else is an in-progress capture
      note: reason,
    };
    log('exporting test data:', reason, JSON.stringify(meta));
    state.exportPending = true;
    const done = window.plBridge ? window.plBridge.testComplete(meta) : Promise.resolve();
    return done
      .then(() => {
        c.downloadJSON();
        return { ok: true, samples: c.testData.samples.length };
      })
      .catch((err) => {
        log('export failed', err && err.message);
        return { ok: false, reason: (err && err.message) || 'export failed' };
      })
      .then((result) => {
        state.exportPending = false;
        return result;
      });
  }

  // Tear down the link so the app notices. Upstream only shows "Reconnect" once
  // its transport reports disconnected, and a stalled-but-"connected" transport
  // never gets there on its own.
  function forceReconnect() {
    const app = document.querySelector('pluslife-app');
    const pl = app && app.pluslife;
    if (!pl) return;
    state.recoveries += 1;
    state.lastRecoveryAt = Date.now();
    if (!pl.connected()) {
      log(`recovery ${state.recoveries}: already disconnected, waiting for Reconnect`);
      return; // reconnectWatchdog will click the button
    }
    log(`recovery ${state.recoveries}: dropping the link to force a reconnect`);
    // Cancel the GATT link at the source first. This does *not* unwedge the
    // pending gatt.connect() -- the disconnect below still hangs and the deadline
    // below still has to fire -- but it is what releases the peripheral: with it,
    // the dock resumed advertising on its own, where previously only cycling the
    // host's Bluetooth ever brought it back.
    try {
      const gatt = pl.bluetoothDevice && pl.bluetoothDevice.gatt;
      if (gatt) gatt.disconnect();
    } catch (err) {
      log('gatt.disconnect threw', err && err.message);
    }
    try {
      Promise.resolve(pl.disconnect('pluslife-analyzer stall watchdog')).catch((err) =>
        log('forced disconnect rejected', err && err.message),
      );
    } catch (err) {
      log('forced disconnect threw', err && err.message);
    }
    state.disconnectDeadline = Date.now() + DISCONNECT_TIMEOUT_MS;
  }

  // Upstream's interval routines reschedule themselves forever and are only ever
  // stopped by a disconnect that runs to completion. When we force the lost-link
  // state instead, the writer routine is left running, and the next _connect()
  // overwrites the reference -- so it spins on a null gattServer once a second for
  // the life of the app (TypeError: Cannot read properties of null), one more
  // orphan per recovery. stop() flips its `stopped` flag synchronously, which is
  // what ends the rescheduling; the promise it returns may never settle (it awaits
  // the same wedged work), so it must not be awaited.
  function stopRoutine(routine, what) {
    if (!routine || typeof routine.stop !== 'function' || routine.stopped) return;
    try {
      const done = routine.stop();
      if (done && typeof done.catch === 'function') done.catch(() => {});
      log(`stopped the orphaned ${what} routine`);
    } catch (err) {
      log(`could not stop the ${what} routine`, err && err.message);
    }
  }

  // The two places the app can hang forever, each resolved to the state it would
  // have reached itself if the promise it is waiting on could fail.
  function unwedgeConnection() {
    const app = document.querySelector('pluslife-app');
    const pl = app && app.pluslife;
    if (!app || !pl) return;

    // (a) A forced disconnect that never completed. Declare the link gone so the
    // app renders "Connection lost" and its Reconnect button, rather than a green
    // badge over a link that stopped delivering minutes ago.
    //
    // The deadline belongs to one disconnect attempt. Once the transport reports
    // disconnected the attempt has landed, so retire it -- otherwise a reconnect
    // that completes inside the window gets torn down by a deadline meant for the
    // link before it, costing another round trip (observed 2026-08-23: reconnected
    // at +3.0s, deadline fired at +5.3s, reconnected again at +9.0s).
    if (state.disconnectDeadline && !pl.connected()) state.disconnectDeadline = 0;
    if (state.disconnectDeadline && Date.now() > state.disconnectDeadline) {
      state.disconnectDeadline = 0;
      if (pl.connected()) {
        log('disconnect never completed; forcing the app into its lost-link state');
        // Do this before the reconnect replaces the reference and strands it.
        stopRoutine(pl.writerRoutine, 'writer');
        pl.isConnected = false;
        try {
          pl.broadcastConnectionStatus();
        } catch (err) {
          log('broadcast failed', err && err.message);
        }
      }
    }

    // (b) Stuck in "Reconnecting" (connection state 5). The requestDevice() behind
    // it does not survive the adapter being cycled -- which is exactly what revives
    // the dock -- so it can never resolve, and state 5 renders no Reconnect button
    // to start a fresh one. Drop back to "Connection lost" so a new scan can begin.
    if (app._state !== 5) {
      state.reconnectingSince = 0;
      return;
    }
    if (!state.reconnectingSince) {
      state.reconnectingSince = Date.now();
      return;
    }
    if (Date.now() - state.reconnectingSince < RECONNECTING_TIMEOUT_MS) return;
    state.reconnectingSince = 0;
    log('reconnect stuck; cancelling the chooser and re-arming Reconnect');
    if (window.plBridge && window.plBridge.cancelBluetoothChooser) {
      window.plBridge.cancelBluetoothChooser();
    }
    app._state = 3;
  }

  function stallWatchdog() {
    const c = controller();
    if (!c || c.state !== 2) {
      // Only a running test can stall. Anything else re-arms the watchdog.
      state.dataAt = 0;
      state.seenAt = 0;
      state.salvaged = false;
      state.recoveries = 0;
      state.lastRecoveryAt = 0;
      return;
    }

    const now = Date.now();
    const at = lastDataAt(c);
    if (at !== state.dataAt || !state.seenAt) {
      // Fresh data (or the first look at this test): the link is alive, so a
      // recovered stall re-arms for the next one.
      if (state.seenAt && state.salvaged) log('data resumed after a stall');
      state.dataAt = at;
      state.seenAt = now;
      state.salvaged = false;
      state.recoveries = 0;
      state.lastRecoveryAt = 0;
      state.disconnectDeadline = 0; // the stall is over; nothing left to force
      return;
    }

    const silent = now - state.seenAt;
    if (silent < STALL_MS) return;

    // Data first: get it on disk before touching the connection, so recovery can
    // never cost us what we already have.
    if (!state.salvaged) {
      state.salvaged = true;
      log(`stalled: no data for ${Math.round(silent / 1000)}s`);
      exportNow(`stalled after ${Math.round(silent / 1000)}s of silence`);
      return; // let the export finish before disturbing the link
    }

    // Never disturb the link while the screenshot is being taken or the export
    // is still writing: recovery must not cost us the capture it just triggered.
    if (state.exportPending) return;
    if (state.lastRecoveryAt && now - state.lastRecoveryAt < RECOVERY_SETTLE_MS) return;
    forceReconnect();
  }

  function tick() {
    try {
      acceptDisclaimer();
      connectIfIdle();
      reconnectWatchdog();
      restoreTestType();
      saveOnComplete();
      updateKeepAwake();
      stallWatchdog();
      unwedgeConnection();
    } catch (err) {
      log('tick error', err && err.message);
    }
  }

  // Driven by File -> Save Current Test Data. Unlike the watchdog's one-shot
  // salvage, this always exports, so it can be used at any point in a run.
  function saveNow() {
    return exportNow('manual save');
  }

  // Debug-only fault injection (File menu, --pluslife-debug builds). Stops the
  // GATT notification stream while leaving the link connected -- which is exactly
  // what a brief radio glitch leaves behind once CoreBluetooth silently completes
  // upstream's pending reconnect and it re-acquires only the write characteristic.
  // The app notices nothing: green badge, frozen countdown, housekeeping timing
  // out. Recovering from this without losing the curve is the whole question.
  function simulateStall() {
    const app = document.querySelector('pluslife-app');
    const pl = app && app.pluslife;
    if (!pl || !pl.notificationCharacteristic) {
      return Promise.resolve({ ok: false, reason: 'not connected over Bluetooth' });
    }
    log('DEBUG: stopping notifications to simulate a silent stall');
    return Promise.resolve(pl.notificationCharacteristic.stopNotifications())
      .then(() => ({ ok: true }))
      .catch((err) => ({ ok: false, reason: (err && err.message) || 'stopNotifications failed' }));
  }

  window.__pluslife = { tick, saveNow, simulateStall, deepQueryAll };
  log('automation installed');
})();
