// Service worker. The only place where the secret is decrypted and codes are made.
// Content scripts only ever receive {code, validFor}, never the secret.

import { base32Decode } from './base32.js';
import { totp } from './totp.js';
import { encryptSecret, decryptSecret } from './vault.js';
import { parseSetupInput, validateParams } from './otpauth.js';

// auth.tugraz.at is the Keycloak SSO where the OTP step actually happens (checked 2026-11-08).
const LOGIN_HOSTS = ['auth.tugraz.at', 'online.tugraz.at', 'sso.tugraz.at'];
const DEFAULT_SETTINGS = { autofill: true, autoSubmit: true, lockMinutes: 0, offset: 0 };
const MIN_VALID_SECONDS = 5;
const MIN_PASSPHRASE = 8;

// ---------- storage helpers ----------

async function getCfg() {
  const { cfg } = await chrome.storage.local.get('cfg');
  if (!cfg) return null;
  cfg.settings = { ...DEFAULT_SETTINGS, ...cfg.settings };
  return cfg;
}

const setCfg = (cfg) => chrome.storage.local.set({ cfg });
const getSession = async (key) => (await chrome.storage.session.get(key))[key];
const setSession = (key, value) => chrome.storage.session.set({ [key]: value });

async function getSecret(cfg) {
  if (!cfg) return null;
  if (cfg.mode === 'plain') return cfg.secret;
  const unlocked = await getSession('unlocked');
  if (!unlocked) return null;
  const mins = cfg.settings.lockMinutes;
  if (mins > 0 && Date.now() - unlocked.at > mins * 60_000) {
    await chrome.storage.session.remove('unlocked');
    return null;
  }
  return unlocked.secret;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeCode(cfg, secret) {
  const key = base32Decode(secret);
  const opts = { ...cfg.params, offset: cfg.settings.offset };
  let r = await totp(key, opts);
  if (r.validFor < MIN_VALID_SECONDS) {
    // A code that expires on the way to the server counts as a failed attempt.
    await sleep(r.validFor * 1000 + 300);
    r = await totp(key, opts);
  }
  return r;
}

// ---------- who is asking ----------

function senderKind(sender) {
  if (sender.id !== chrome.runtime.id || !sender.url) return null;
  let url;
  try {
    url = new URL(sender.url);
  } catch {
    return null;
  }
  if (url.protocol === 'chrome-extension:' && url.host === chrome.runtime.id) return 'page';
  if (sender.tab && url.protocol === 'https:' && LOGIN_HOSTS.includes(url.hostname)) return 'content';
  return null;
}

// ---------- handlers ----------

async function status() {
  const cfg = await getCfg();
  if (!cfg) return { configured: false };
  const secret = await getSecret(cfg);
  const paused = await getSession('paused');
  return {
    configured: true,
    locked: !secret,
    mode: cfg.mode,
    issuer: cfg.issuer,
    label: cfg.label,
    params: cfg.params,
    settings: cfg.settings,
    paused: Boolean(paused),
  };
}

async function getCode({ auto }, kind) {
  const cfg = await getCfg();
  if (!cfg) return { status: 'unconfigured' };
  const secret = await getSecret(cfg);
  if (!secret) return { status: 'locked' };

  if (auto) {
    if (kind !== 'content') return { status: 'error', error: 'auto only from content script' };
    if (!cfg.settings.autofill) return { status: 'disabled' };
    if (await getSession('paused')) return { status: 'paused' };
    // At most one automatic code per time window, across page reloads.
    const last = await getSession('lastAuto');
    const windowMs = Math.max(2 * cfg.params.period, 120) * 1000;
    if (last && Date.now() - last < windowMs) return { status: 'blocked' };
    await setSession('lastAuto', Date.now());
  }

  const r = await makeCode(cfg, secret);
  return { status: 'ok', ...r, autoSubmit: cfg.settings.autoSubmit };
}

async function setup({ input, algorithm, digits, period, passphrase, plain }) {
  if (await getCfg()) throw new Error('A token is already set up. Remove it first.');
  const parsed = parseSetupInput(input);
  const params = validateParams({
    algorithm: algorithm ?? parsed.algorithm,
    digits: digits ?? parsed.digits,
    period: period ?? parsed.period,
  });
  const cfg = {
    v: 1,
    issuer: parsed.issuer || 'ZID TU Graz',
    label: parsed.label,
    params,
    settings: { ...DEFAULT_SETTINGS },
    createdAt: new Date().toISOString(),
  };
  if (plain) {
    cfg.mode = 'plain';
    cfg.secret = parsed.secret;
  } else {
    if (!passphrase || passphrase.length < MIN_PASSPHRASE) {
      throw new Error(`The passphrase needs at least ${MIN_PASSPHRASE} characters.`);
    }
    cfg.mode = 'passphrase';
    cfg.box = await encryptSecret(parsed.secret, passphrase);
    await setSession('unlocked', { secret: parsed.secret, at: Date.now() });
  }
  await setCfg(cfg);
  return { ok: true };
}

async function unlock({ passphrase }) {
  const cfg = await getCfg();
  if (!cfg) throw new Error('No token is set up.');
  if (cfg.mode === 'plain') return { ok: true };
  const secret = await decryptSecret(cfg.box, passphrase);
  await setSession('unlocked', { secret, at: Date.now() });
  return { ok: true };
}

async function reveal({ passphrase }) {
  const cfg = await getCfg();
  if (!cfg) throw new Error('No token is set up.');
  const secret = cfg.mode === 'plain' ? cfg.secret : await decryptSecret(cfg.box, passphrase);
  return { secret, params: cfg.params };
}

async function saveSettings({ settings }) {
  const cfg = await getCfg();
  if (!cfg) throw new Error('No token is set up.');
  const s = { ...cfg.settings };
  if ('autofill' in settings) s.autofill = Boolean(settings.autofill);
  if ('autoSubmit' in settings) s.autoSubmit = Boolean(settings.autoSubmit);
  if ('lockMinutes' in settings) {
    const m = Number(settings.lockMinutes);
    if (!Number.isInteger(m) || m < 0 || m > 1440) throw new Error('Auto-lock must be 0–1440 minutes.');
    s.lockMinutes = m;
  }
  if ('offset' in settings) {
    const o = Number(settings.offset);
    if (!Number.isInteger(o) || Math.abs(o) > 600) throw new Error('Clock offset must be −600 to 600 seconds.');
    s.offset = o;
  }
  cfg.settings = s;
  await setCfg(cfg);
  return { ok: true, settings: s };
}

async function reportRejected() {
  await setSession('paused', Date.now());
  await chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
  await chrome.action.setBadgeText({ text: '!' });
  return { ok: true };
}

async function resume() {
  await chrome.storage.session.remove(['paused', 'lastAuto']);
  await chrome.action.setBadgeText({ text: '' });
  return { ok: true };
}

async function lock() {
  await chrome.storage.session.remove('unlocked');
  return { ok: true };
}

async function reset() {
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  await chrome.action.setBadgeText({ text: '' });
  return { ok: true };
}

const HANDLERS = {
  status: { kinds: ['page', 'content'], fn: status },
  getCode: { kinds: ['page', 'content'], fn: getCode },
  reportRejected: { kinds: ['content'], fn: reportRejected },
  setup: { kinds: ['page'], fn: setup },
  unlock: { kinds: ['page'], fn: unlock },
  lock: { kinds: ['page'], fn: lock },
  reveal: { kinds: ['page'], fn: reveal },
  saveSettings: { kinds: ['page'], fn: saveSettings },
  resume: { kinds: ['page'], fn: resume },
  reset: { kinds: ['page'], fn: reset },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const kind = senderKind(sender);
  const h = msg && HANDLERS[msg.type];
  if (!kind || !h || !h.kinds.includes(kind)) {
    sendResponse({ error: 'Not allowed.' });
    return false;
  }
  h.fn(msg, kind).then(
    (res) => sendResponse(res),
    (err) => sendResponse({ error: err?.message || String(err) }),
  );
  return true; // async response
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install' && !(await getCfg())) chrome.runtime.openOptionsPage();
});
