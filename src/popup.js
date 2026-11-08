import { formatCode } from './format.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const views = ['v-setup', 'v-locked', 'v-code'];
const show = (id) => views.forEach((v) => $(v).classList.toggle('hidden', v !== id));

let current = null;
let timer = null;

async function render() {
  const st = await send({ type: 'status' });
  if (st.error) return;
  if (!st.configured) return show('v-setup');
  if (st.locked) {
    show('v-locked');
    $('pp').focus();
    return;
  }
  show('v-code');
  $('who').textContent = st.label || st.issuer || 'TU Graz';
  $('lock').classList.toggle('hidden', st.mode === 'plain');
  $('paused').classList.toggle('hidden', !st.paused);
  $('autofill').checked = st.settings.autofill;
  $('autosubmit').checked = st.settings.autoSubmit;
  $('autosubmit').disabled = !st.settings.autofill;
  tick();
  clearInterval(timer);
  timer = setInterval(tick, 1000);
}

async function tick() {
  const r = await send({ type: 'getCode', auto: false });
  if (r.status === 'locked') return render();
  if (r.status !== 'ok') return;
  current = r.code;
  $('code').textContent = formatCode(r.code);
  $('bar').style.width = `${(r.validFor / r.period) * 100}%`;
}

$('open-setup').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('unlock-err').textContent = '';
  const r = await send({ type: 'unlock', passphrase: $('pp').value });
  $('pp').value = '';
  if (r.error) $('unlock-err').textContent = r.error;
  else render();
});

$('copy').addEventListener('click', async () => {
  if (!current) return;
  await navigator.clipboard.writeText(current);
  $('copy').textContent = 'Copied';
  setTimeout(() => ($('copy').textContent = 'Copy'), 1200);
});

$('lock').addEventListener('click', async () => {
  await send({ type: 'lock' });
  clearInterval(timer);
  render();
});

$('resume').addEventListener('click', async () => {
  await send({ type: 'resume' });
  render();
});

$('autofill').addEventListener('change', async (e) => {
  await send({ type: 'saveSettings', settings: { autofill: e.target.checked } });
  render();
});
$('autosubmit').addEventListener('change', async (e) => {
  await send({ type: 'saveSettings', settings: { autoSubmit: e.target.checked } });
});

render();
