// Runs only on the TU Graz login hosts listed in manifest.json.
// Finds the OTP field, asks the service worker for a code, fills it in, optionally submits.
// It never sees the secret. At most one automatic try per page load (and the service
// worker allows one per time window across reloads), so a wrong code can't lock the token.

(() => {
  'use strict';

  const ATTR_RE = /otp|totp|one.?time|2fa|mfa|\btan\b|token|second.?factor|secondfactor/i;
  const LABEL_RE =
    /einmal(passwort|kennwort|code)|\botp\b|\btotp\b|token|second factor|zweite[rnms]? faktor|2fa|\bmfa\b|best[äa]tigungscode|sicherheitscode|verification code|authenticator|one.?time/i;
  const ERROR_RE = /ung[üu]ltig|falsch|fehlgeschlagen|abgelehnt|invalid|incorrect|wrong|failed|denied/i;
  const SUBMIT_RE = /anmelden|einloggen|log ?in|sign ?in|weiter|best[äa]tigen|absenden|pr[üu]fen|verif|submit|continue|^\s*ok\s*$/i;
  const TEXTISH = new Set(['text', 'tel', 'number', 'password', '']);
  const REJECT_WINDOW_MS = 60_000;

  let busy = false;
  let attemptAt = 0; // when we auto-submitted on this page
  let attemptedField = null;
  let reported = false;
  let stopped = false;
  let banner = null;

  // ---------- messaging ----------

  async function send(msg) {
    try {
      return (await chrome.runtime.sendMessage(msg)) ?? { error: 'No response' };
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  }

  // ---------- field detection ----------

  function isVisible(el) {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  }

  function labelText(el) {
    const parts = [el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('title')];
    if (el.labels) for (const l of el.labels) parts.push(l.textContent);
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    for (const id of ids) parts.push(document.getElementById(id)?.textContent);
    const wrap = el.closest('mat-form-field, label, .form-group, .form-field, [class*="field"], fieldset');
    if (wrap) parts.push(wrap.textContent?.slice(0, 300));
    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ');
  }

  function score(el) {
    if (!(el instanceof HTMLInputElement)) return 0;
    if (!TEXTISH.has(el.type) || el.disabled || el.readOnly || el.value !== '' || !isVisible(el)) return 0;
    const attrs = [el.name, el.id, el.getAttribute('formcontrolname'), el.className].join(' ');
    const text = labelText(el);
    const isOtc = (el.getAttribute('autocomplete') || '').toLowerCase() === 'one-time-code';

    let s = 0;
    if (isOtc) s += 3;
    if (ATTR_RE.test(attrs)) s += 2;
    if (LABEL_RE.test(text)) s += 2;
    if (s === 0) return 0;
    if (el.type === 'password' && !isOtc && !LABEL_RE.test(text) && !/otp|totp|token/i.test(attrs)) return 0;
    if (el.maxLength >= 6 && el.maxLength <= 8) s += 1;
    if (el.inputMode === 'numeric' || el.type === 'tel' || el.type === 'number' || /\\d|\[0-9\]/.test(el.pattern)) s += 1;
    return s;
  }

  function findOtpField() {
    let best = null;
    let bestScore = 0;
    let tie = false;
    for (const el of document.querySelectorAll('input')) {
      const s = score(el);
      if (s > bestScore) {
        best = el;
        bestScore = s;
        tie = false;
      } else if (s === bestScore && s > 0) {
        tie = true;
      }
    }
    return bestScore >= 2 && !tie ? best : null;
  }

  // ---------- filling ----------

  function setValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus();
    setter.call(el, value); // bypass framework-wrapped setters so Angular/React notice
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findSubmit(field) {
    const scope =
      field.form || field.closest('form, [role="dialog"], mat-card, .card, section, main') || document.body;
    const buttons = [...scope.querySelectorAll('button, input[type="submit"]')].filter(
      (b) => !b.disabled && isVisible(b),
    );
    return (
      buttons.find((b) => b.type === 'submit' && SUBMIT_RE.test(b.textContent || b.value || '')) ||
      buttons.find((b) => b.type === 'submit') ||
      buttons.find((b) => SUBMIT_RE.test(b.textContent || b.value || '')) ||
      null
    );
  }

  function submit(field) {
    const btn = findSubmit(field);
    if (btn) return btn.click();
    if (field.form) return field.form.requestSubmit();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      field.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
  }

  async function fill(field, { auto }) {
    const res = await send({ type: 'getCode', auto });
    switch (res.status) {
      case 'ok':
        break;
      case 'locked':
        return showBanner('Zweitschlüssel is locked. Unlock it in the toolbar popup, then click Fill.', field);
      case 'unconfigured':
        return showBanner('Zweitschlüssel is not set up yet. Open its settings to add your TU Graz token.');
      case 'paused':
        return showBanner('Autofill is paused because a code was rejected. Check the popup.', field);
      case 'blocked':
        return showBanner('Autofill already tried a code moments ago. Click Fill to try once more.', field);
      case 'disabled':
        return; // user turned autofill off
      default:
        return showBanner(`Zweitschlüssel: ${res.error || 'unknown error'}`);
    }
    if (!field.isConnected) return;
    setValue(field, res.code);
    hideBanner();
    if (auto && res.autoSubmit) {
      await new Promise((r) => setTimeout(r, 300));
      attemptAt = Date.now();
      attemptedField = field;
      submit(field);
      for (const ms of [2000, 5000, 10000]) setTimeout(checkRejected, ms);
    }
  }

  // ---------- rejection guard ----------

  function nearbyText(field) {
    const scope = field.closest('form, [role="dialog"], mat-card, .card, section, main') || document.body;
    return (scope.innerText || '').slice(0, 3000);
  }

  async function markRejected(field) {
    if (reported) return;
    reported = true;
    stopped = true;
    await send({ type: 'reportRejected' });
    showBanner(
      'The code was not accepted. Autofill is paused so your token does not get locked. ' +
        'Check your computer clock and the key, then resume in the popup.',
      field,
    );
  }

  // Rejected = shortly after our submit, the OTP field is empty again (same or re-rendered),
  // or an error message shows up next to the field we filled.
  function checkRejected() {
    const elapsed = Date.now() - attemptAt;
    if (!attemptAt || reported || elapsed < 1500 || elapsed > REJECT_WINDOW_MS) return;
    const emptyField = findOtpField();
    if (emptyField) return markRejected(emptyField);
    const f = attemptedField;
    if (f?.isConnected && isVisible(f) && ERROR_RE.test(nearbyText(f))) markRejected(f);
  }

  // ---------- banner (closed shadow root, trusted clicks only) ----------

  function hideBanner() {
    banner?.remove();
    banner = null;
  }

  function showBanner(text, field) {
    hideBanner();
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .b{font:14px/1.4 system-ui,sans-serif;background:#1d2a3a;color:#fff;padding:12px 14px;border-radius:10px;
           max-width:340px;box-shadow:0 6px 24px rgba(0,0,0,.25);display:grid;gap:10px}
        .r{display:flex;gap:8px;justify-content:flex-end}
        button{font:inherit;border:0;border-radius:6px;padding:6px 12px;cursor:pointer}
        .p{background:#7fb3ff;color:#0b1a2b;font-weight:600}.s{background:transparent;color:#cfd8e3}
      </style>
      <div class="b" role="status"><div class="t"></div><div class="r">
        <button class="s" data-a="close">Close</button>
        ${field ? '<button class="p" data-a="fill">Fill</button>' : ''}
      </div></div>`;
    root.querySelector('.t').textContent = text;
    root.addEventListener('click', (e) => {
      if (!e.isTrusted) return; // ignore clicks synthesized by page scripts
      const a = e.target?.dataset?.a;
      if (a === 'close') hideBanner();
      if (a === 'fill' && field?.isConnected) fill(field, { auto: false });
    });
    document.documentElement.appendChild(host);
    banner = host;
  }

  // ---------- main loop ----------

  async function check() {
    if (busy || stopped) return;
    const field = findOtpField();
    if (!field) return;

    if (attemptAt) return; // after our one try, only checkRejected() runs

    busy = true;
    try {
      await fill(field, { auto: true });
    } finally {
      busy = false;
      if (!attemptAt) stopped = true; // filled without submit, or showed a banner: one try per page
    }
  }

  let timer = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      check();
      checkRejected();
    }, 250);
  };

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'disabled'],
  });
  schedule();
})();
