import { parseSetupInput } from './otpauth.js';
import { formatCode } from './format.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
let timer = null;
let state = null;

async function render() {
  state = await send({ type: 'status' });
  $('v-setup').classList.toggle('hidden', state.configured);
  $('v-ready').classList.toggle('hidden', !state.configured);
  clearInterval(timer);
  if (!state.configured) return;

  $('who').textContent = state.label || state.issuer;
  const p = state.params;
  $('params').textContent = `Token: ${p.algorithm}, ${p.digits} digits, ${p.period} s period. Mode: ${
    state.mode === 'plain' ? 'no passphrase' : 'passphrase'
  }.`;
  $('s-autofill').checked = state.settings.autofill;
  $('s-autosubmit').checked = state.settings.autoSubmit;
  $('s-autosubmit').disabled = !state.settings.autofill;
  $('s-lock').value = state.settings.lockMinutes;
  $('s-offset').value = state.settings.offset;
  $('s-lock').disabled = state.mode === 'plain';
  $('rpp').classList.toggle('hidden', state.mode === 'plain');
  $('rpp-label').classList.toggle('hidden', state.mode === 'plain');

  $('code-box').classList.toggle('hidden', state.locked);
  $('unlock-form').classList.toggle('hidden', !state.locked);
  if (!state.locked) {
    tick();
    timer = setInterval(tick, 1000);
  }
}

async function tick() {
  const r = await send({ type: 'getCode', auto: false });
  if (r.status === 'locked') return render();
  if (r.status !== 'ok') return;
  $('code').textContent = formatCode(r.code);
  $('bar').style.width = `${(r.validFor / r.period) * 100}%`;
}

// ---------- setup ----------

$('input').addEventListener('input', () => {
  const v = $('input').value.trim();
  $('setup-err').textContent = '';
  if (!v) return ($('detected').textContent = '');
  try {
    const r = parseSetupInput(v);
    $('alg').value = r.algorithm;
    $('digits').value = r.digits;
    $('period').value = r.period;
    $('detected').textContent = r.fromUri
      ? `Read from the link: ${r.algorithm}, ${r.digits} digits, ${r.period} s${r.issuer ? `, issuer “${r.issuer}”` : ''}.`
      : 'Bare key detected. Using TU Graz defaults below; change them if your token differs.';
    $('detected').className = 'small ok';
  } catch (e) {
    $('detected').textContent = e.message;
    $('detected').className = 'small error';
  }
});

$('plain').addEventListener('change', () => {
  const plain = $('plain').checked;
  $('plain-warn').classList.toggle('hidden', !plain);
  $('pp1').disabled = plain;
  $('pp2').disabled = plain;
});

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('setup-err').textContent = '';
  const plain = $('plain').checked;
  if (!plain && $('pp1').value !== $('pp2').value) {
    $('setup-err').textContent = 'The passphrases do not match.';
    return;
  }
  $('save').disabled = true;
  const r = await send({
    type: 'setup',
    input: $('input').value,
    algorithm: $('alg').value,
    digits: Number($('digits').value),
    period: Number($('period').value),
    passphrase: plain ? null : $('pp1').value,
    plain,
  });
  $('save').disabled = false;
  if (r.error) {
    $('setup-err').textContent = r.error;
    return;
  }
  for (const id of ['input', 'pp1', 'pp2']) $(id).value = '';
  render();
});

// ---------- configured ----------

$('unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await send({ type: 'unlock', passphrase: $('upp').value });
  $('upp').value = '';
  $('unlock-err').textContent = r.error || '';
  if (!r.error) render();
});

$('settings-form').addEventListener('change', async () => {
  $('settings-err').textContent = '';
  const r = await send({
    type: 'saveSettings',
    settings: {
      autofill: $('s-autofill').checked,
      autoSubmit: $('s-autosubmit').checked,
      lockMinutes: Number($('s-lock').value),
      offset: Number($('s-offset').value),
    },
  });
  if (r.error) {
    $('settings-err').textContent = r.error;
    return;
  }
  $('settings-ok').textContent = 'Saved';
  setTimeout(() => ($('settings-ok').textContent = ''), 1200);
  render();
});
$('settings-form').addEventListener('submit', (e) => e.preventDefault());

$('reveal-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await send({ type: 'reveal', passphrase: $('rpp').value });
  $('rpp').value = '';
  $('reveal-err').textContent = r.error || '';
  if (r.error) return;
  const p = r.params;
  $('revealed').textContent =
    `Key: ${r.secret}\n` +
    `otpauth://totp/Zweitschluessel?secret=${r.secret}&issuer=${encodeURIComponent('ZID TU Graz')}` +
    `&algorithm=${p.algorithm}&digits=${p.digits}&period=${p.period}`;
  $('revealed').classList.remove('hidden');
  setTimeout(() => {
    $('revealed').textContent = '';
    $('revealed').classList.add('hidden');
  }, 60_000);
});

$('reset').addEventListener('click', async () => {
  const ok = confirm(
    'Remove the token from this browser? You can only add it again with the key. ' +
      'The token stays registered at TU Graz; remove it there on otp.tugraz.at if you no longer use it.',
  );
  if (!ok) return;
  await send({ type: 'reset' });
  render();
});

render();
