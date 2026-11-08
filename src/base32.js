// RFC 4648 Base32 decoding, lenient about spaces, dashes, case and padding.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function normalizeBase32(input) {
  return String(input ?? '')
    .replace(/[\s-]/g, '')
    .replace(/=+$/, '')
    .toUpperCase();
}

export function base32Decode(input) {
  const s = normalizeBase32(input);
  if (!s) throw new Error('The key is empty.');
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`The key contains an invalid character: "${ch}".`);
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (out.length < 10) throw new Error('The key is too short (need at least 16 Base32 characters).');
  return new Uint8Array(out);
}
