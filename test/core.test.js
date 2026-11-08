import { test } from 'node:test';
import assert from 'node:assert/strict';

import { base32Decode } from '../src/base32.js';
import { hotp, totp } from '../src/totp.js';
import { parseSetupInput, TU_GRAZ_DEFAULTS } from '../src/otpauth.js';
import { encryptSecret, decryptSecret } from '../src/vault.js';

const ascii = (s) => new TextEncoder().encode(s);

// RFC 6238 Appendix B
const KEYS = {
  SHA1: ascii('12345678901234567890'),
  SHA256: ascii('12345678901234567890123456789012'),
  SHA512: ascii('1234567890123456789012345678901234567890123456789012345678901234'),
};
const VECTORS = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];

test('TOTP matches RFC 6238 vectors for SHA1/256/512', async () => {
  for (const [t, sha1, sha256, sha512] of VECTORS) {
    for (const [alg, want] of [['SHA1', sha1], ['SHA256', sha256], ['SHA512', sha512]]) {
      const { code } = await totp(KEYS[alg], { algorithm: alg, digits: 8, period: 30, now: t * 1000 });
      assert.equal(code, want, `${alg} at T=${t}`);
    }
  }
});

test('HOTP matches RFC 4226 Appendix D', async () => {
  const want = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  for (let i = 0; i < want.length; i++) {
    assert.equal(await hotp(KEYS.SHA1, i), want[i]);
  }
});

test('validFor counts down within the period', async () => {
  const r = await totp(KEYS.SHA256, { algorithm: 'SHA256', period: 60, now: 125_000 });
  assert.equal(r.validFor, 55);
  const r2 = await totp(KEYS.SHA256, { algorithm: 'SHA256', period: 60, now: 120_000 });
  assert.equal(r2.validFor, 60);
});

test('clock offset shifts the time step', async () => {
  const a = await totp(KEYS.SHA1, { now: 59_000, offset: 1 });
  const b = await totp(KEYS.SHA1, { now: 60_000 });
  assert.equal(a.code, b.code);
});

test('Base32 is decoded leniently', () => {
  // "12345678901234567890" in Base32
  const b32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.deepEqual(base32Decode(b32), KEYS.SHA1);
  assert.deepEqual(base32Decode('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq=='), KEYS.SHA1);
  assert.throws(() => base32Decode('GEZDGNBV1Y3TQOJQ'), /invalid character/);
  assert.throws(() => base32Decode('GEZDG'), /too short/);
});

test('otpauth URL params win over defaults', () => {
  const r = parseSetupInput(
    'otpauth://totp/ZID%20TU%20Graz:student?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=ZID%20TU%20Graz&algorithm=sha256&digits=6&period=60',
  );
  assert.equal(r.algorithm, 'SHA256');
  assert.equal(r.period, 60);
  assert.equal(r.digits, 6);
  assert.equal(r.issuer, 'ZID TU Graz');
  assert.equal(r.label, 'ZID TU Graz:student');
});

test('otpauth URL without params uses spec defaults (SHA1/30)', () => {
  const r = parseSetupInput('otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(r.algorithm, 'SHA1');
  assert.equal(r.period, 30);
});

test('bare key uses TU Graz defaults', () => {
  const r = parseSetupInput('  GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ ');
  assert.equal(r.algorithm, TU_GRAZ_DEFAULTS.algorithm);
  assert.equal(r.period, TU_GRAZ_DEFAULTS.period);
  assert.equal(r.secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
});

test('HOTP URLs and bad input are rejected', () => {
  assert.throws(() => parseSetupInput('otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQ&counter=1'), /time-based/);
  assert.throws(() => parseSetupInput('otpauth://totp/x?issuer=a'), /secret/);
  assert.throws(() => parseSetupInput('otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZD&digits=4'), /Digits/);
  assert.throws(() => parseSetupInput(''), /Paste/);
});

test('vault round-trips and rejects a wrong passphrase', async () => {
  const box = await encryptSecret('GEZDGNBVGY3TQOJQ', 'correct horse', 1000);
  assert.equal(await decryptSecret(box, 'correct horse'), 'GEZDGNBVGY3TQOJQ');
  await assert.rejects(decryptSecret(box, 'wrong'), /Wrong passphrase/);
  const box2 = await encryptSecret('GEZDGNBVGY3TQOJQ', 'correct horse', 1000);
  assert.notEqual(box.ct, box2.ct, 'fresh salt/IV each time');
});
