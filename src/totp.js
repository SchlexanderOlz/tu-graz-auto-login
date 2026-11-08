// HOTP (RFC 4226) and TOTP (RFC 6238) on top of WebCrypto.
// Works in the extension service worker, extension pages and Node >= 20.

const HASHES = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

export async function hotp(keyBytes, counter, { algorithm = 'SHA1', digits = 6 } = {}) {
  const hash = HASHES[algorithm];
  if (!hash) throw new Error(`Unsupported algorithm: ${algorithm}`);

  const msg = new Uint8Array(8);
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) {
    msg[i] = Number(c & 0xffn);
    c >>= 8n;
  }

  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));

  // Dynamic truncation, RFC 4226 section 5.3
  const off = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[off] & 0x7f) << 24) |
    (mac[off + 1] << 16) |
    (mac[off + 2] << 8) |
    mac[off + 3];

  return String(bin % 10 ** digits).padStart(digits, '0');
}

/**
 * @returns {Promise<{code: string, validFor: number, period: number}>}
 *   validFor = whole seconds until this code expires.
 */
export async function totp(
  keyBytes,
  { algorithm = 'SHA1', digits = 6, period = 30, offset = 0, now = Date.now() } = {},
) {
  const t = Math.floor(now / 1000) + offset;
  const counter = Math.floor(t / period);
  const code = await hotp(keyBytes, counter, { algorithm, digits });
  return { code, validFor: period - (t % period), period };
}
