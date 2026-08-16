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
    dumped: false,
    savedThisTest: false,
    keepAwake: false,
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
    if (btn && visible(btn)) {
      log('reconnecting after drop');
      btn.click();
    }
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
  // (but open) app doesn't prevent sleep. pluslife-app._state uses the app's
  // state enum: 2=TESTING, 4=BLOCKED_ALREADY_TESTING (reconnected to a running
  // test), 5=BLOCKED_NOT_READY (heating). Reading _state (not the lazily-created
  // .data) is reliable, and it's independent of window visibility — so keeping
  // it awake survives backgrounding, unlike the app's own screen wake lock.
  const KEEP_AWAKE_STATES = new Set([2, 4, 5]);
  function updateKeepAwake() {
    const el = document.querySelector('pluslife-app');
    const s = el && typeof el._state === 'number' ? el._state : null;
    const active = s != null && KEEP_AWAKE_STATES.has(s);
    if (active === state.keepAwake) return;
    state.keepAwake = active;
    log('keep-awake', active ? `ON (state ${s})` : `OFF (state ${s})`);
    if (window.plBridge && window.plBridge.setKeepAwake) window.plBridge.setKeepAwake(active);
  }

  function tick() {
    try {
      acceptDisclaimer();
      connectIfIdle();
      reconnectWatchdog();
      restoreTestType();
      saveOnComplete();
      updateKeepAwake();
    } catch (err) {
      log('tick error', err && err.message);
    }
  }

  window.__pluslife = { tick, deepQueryAll };
  log('automation installed');
})();
