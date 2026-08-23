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
  };

  // A running test that has gone this long without a single packet is stalled:
  // samples arrive roughly every 30 s, so two minutes of silence is well past
  // any normal gap. Recovery is then re-attempted on this cadence for as long as
  // the silence lasts -- long enough for a reconnect (which re-runs the device
  // handshake) to actually land before we judge it failed.
  const STALL_MS = 120000;
  const RECOVERY_SETTLE_MS = 45000;

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
  // cheerfully "Connected" forever. Upstream's BLE transport re-acquires the
  // write characteristic after a GATT drop but never re-subscribes to
  // notifications, so it writes into a void; its own 5 s request timeouts are
  // swallowed by the housekeeping routine. Nothing ever reaches DONE, so the
  // save-on-completion path never fires and the data collected so far is stranded.
  //
  // We watch the controller's data for silence, put what we have on disk first,
  // and only then tear the link down so the app offers "Reconnect" -- which runs
  // a full _connect() and does re-subscribe. The controller (and its samples)
  // outlives that, so a successful reconnect resumes the same test.

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
    try {
      Promise.resolve(pl.disconnect('pluslife-analyzer stall watchdog')).catch((err) =>
        log('forced disconnect rejected', err && err.message),
      );
    } catch (err) {
      log('forced disconnect threw', err && err.message);
    }
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
    } catch (err) {
      log('tick error', err && err.message);
    }
  }

  // Driven by File -> Save Current Test Data. Unlike the watchdog's one-shot
  // salvage, this always exports, so it can be used at any point in a run.
  function saveNow() {
    return exportNow('manual save');
  }

  window.__pluslife = { tick, saveNow, deepQueryAll };
  log('automation installed');
})();
