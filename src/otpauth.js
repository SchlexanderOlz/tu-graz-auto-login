// Parses what the user pastes: either an otpauth://totp/... URL or a bare Base32 key.

import { base32Decode, normalizeBase32 } from './base32.js';

// Values from TU Graz's own guide (otpauth URL with algorithm=sha256, period=60, digits=6):
// https://tu4u.tugraz.at/en/public/2-factor-authentication-2fa/2fa-for-desktop
// Only used for a bare key. A pasted otpauth URL always wins.
export const TU_GRAZ_DEFAULTS = Object.freeze({ algorithm: 'SHA256', digits: 6, period: 60 });

const ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'];

export function normalizeAlgorithm(value) {
  const a = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!ALGORITHMS.includes(a)) throw new Error(`Unsupported algorithm "${value}". Use SHA1, SHA256 or SHA512.`);
  return a;
}

export function validateParams({ algorithm, digits, period }) {
  const out = {
    algorithm: normalizeAlgorithm(algorithm),
    digits: Number(digits),
    period: Number(period),
  };
  if (!Number.isInteger(out.digits) || out.digits < 6 || out.digits > 8) {
    throw new Error('Digits must be 6, 7 or 8.');
  }
  if (!Number.isInteger(out.period) || out.period < 10 || out.period > 300) {
    throw new Error('Period must be a whole number of seconds between 10 and 300.');
  }
  return out;
}

export function parseSetupInput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('Paste the setup key or the otpauth:// URL.');
  if (/^otpauth:\/\//i.test(text)) return parseOtpauthUri(text);
  const secret = normalizeBase32(text);
  base32Decode(secret);
  return { secret, ...TU_GRAZ_DEFAULTS, issuer: '', label: '', fromUri: false };
}

export function parseOtpauthUri(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    throw new Error('That is not a valid otpauth:// URL.');
  }
  if (url.protocol.toLowerCase() !== 'otpauth:') throw new Error('The URL must start with otpauth://');
  if (url.host.toLowerCase() !== 'totp') {
    throw new Error('Only time-based tokens are supported (otpauth://totp/...).');
  }

  const params = new Map();
  for (const [k, v] of url.searchParams) params.set(k.toLowerCase(), v);

  const rawSecret = params.get('secret');
  if (!rawSecret) throw new Error('The URL has no secret= parameter.');
  const secret = normalizeBase32(rawSecret);
  base32Decode(secret);

  let label = '';
  try {
    label = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  } catch {
    label = url.pathname.replace(/^\/+/, '');
  }

  // Defaults from the Key Uri Format spec, used only if the URL leaves a field out.
  const p = validateParams({
    algorithm: params.get('algorithm') ?? 'SHA1',
    digits: params.get('digits') ?? 6,
    period: params.get('period') ?? 30,
  });

  return {
    secret,
    ...p,
    issuer: params.get('issuer') ?? (label.includes(':') ? label.split(':')[0] : ''),
    label,
    fromUri: true,
  };
}
