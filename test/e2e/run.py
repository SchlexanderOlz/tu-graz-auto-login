#!/usr/bin/env python3
"""End-to-end test: loads the unpacked extension into Chromium (Playwright),
maps online.tugraz.at to a local HTTPS server with a fake login page,
sets up a token through the options page and checks the autofill.

Run from the repo root:  python3 test/e2e/run.py
Needs: python playwright with chromium, openssl.
"""
import base64, hashlib, hmac, http.server, os, ssl, struct, subprocess, sys, tempfile, threading, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(os.environ.get('EXT_DIR') or Path(__file__).resolve().parents[2])  # EXT_DIR: test an unzipped build
FIXTURE = Path(__file__).with_name('fake-login.html').read_bytes()
KEYCLOAK = Path(__file__).with_name('keycloak-otp.html').read_text()
KC_PATH = '/auth/realms/tugraz/login-actions/authenticate'
KC_ERROR = '<div class="alert-error pf-c-alert pf-m-danger"><span class="kc-feedback-text">Ung\u00fcltiger Einmalcode.</span></div>'
posts = []  # (query, otp) for every Keycloak form submit
SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
URI = f'otpauth://totp/ZID%20TU%20Graz:test?secret={SECRET}&issuer=ZID%20TU%20Graz&algorithm=sha256&digits=6&period=60'


def totp(secret, period=60, digits=6, t=None):
    key = base64.b32decode(secret)
    c = int((t or time.time()) // period)
    mac = hmac.new(key, struct.pack('>Q', c), hashlib.sha256).digest()
    o = mac[-1] & 0x0F
    return str((struct.unpack('>I', mac[o:o + 4])[0] & 0x7FFFFFFF) % 10 ** digits).zfill(digits)


class Handler(http.server.BaseHTTPRequestHandler):
    def _send(self, body):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(body.encode() if isinstance(body, str) else body)

    def _keycloak(self, error):
        return KEYCLOAK.replace('__ACTION__', self.path).replace('<!--ERROR-->', KC_ERROR if error else '')

    def do_GET(self):
        if self.headers.get('Host', '').startswith('auth.tugraz.at'):
            return self._send(self._keycloak(False))
        self._send(FIXTURE)

    def do_POST(self):
        from urllib.parse import parse_qs, urlsplit
        n = int(self.headers.get('Content-Length', 0))
        form = parse_qs(self.rfile.read(n).decode())
        query = urlsplit(self.path).query
        posts.append((query, form.get('otp', [''])[0]))
        if 'reject=1' in query:
            return self._send(self._keycloak(True))
        self._send('<h1 id="done">Willkommen</h1>')

    def log_message(self, *a):
        pass


def serve(tmp):
    cert, key = tmp / 'c.pem', tmp / 'k.pem'
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=online.tugraz.at',
                    '-keyout', str(key), '-out', str(cert)], check=True, capture_output=True)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)  # free port
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def wait_safe_window():
    # Avoid running across a 60 s boundary (the extension would wait for the next code).
    left = 60 - (time.time() % 60)
    if left < 15:
        time.sleep(left + 1)


def main():
    failures = []
    def check(name, cond, detail=''):
        print(('PASS ' if cond else 'FAIL ') + name + (f' — {detail}' if detail and not cond else ''))
        if not cond:
            failures.append(name)

    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        srv = serve(tmp)
        port = srv.server_address[1]
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(
                str(tmp / 'profile'), headless=False,
                args=['--headless=new', f'--disable-extensions-except={ROOT}', f'--load-extension={ROOT}',
                      f'--host-resolver-rules=MAP online.tugraz.at:443 127.0.0.1:{port}, MAP auth.tugraz.at:443 127.0.0.1:{port}', '--ignore-certificate-errors'])
            sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
            ext_id = sw.url.split('/')[2]

            # --- setup via options page ---
            opt = ctx.new_page()
            opt.goto(f'chrome-extension://{ext_id}/src/options.html')
            opt.fill('#input', URI)
            opt.dispatch_event('#input', 'input')
            check('options reads params from otpauth URL', 'SHA256, 6 digits, 60 s' in opt.inner_text('#detected'),
                  opt.inner_text('#detected'))
            opt.fill('#pp1', 'test-passphrase')
            opt.fill('#pp2', 'test-passphrase')
            opt.click('#save')
            opt.wait_for_selector('#v-ready:not(.hidden)')
            wait_safe_window()
            opt.wait_for_function("document.getElementById('code').textContent.trim().length === 7")
            shown = opt.inner_text('#code').replace(' ', '')
            check('options shows the correct code', shown == totp(SECRET), f'{shown} vs {totp(SECRET)}')

            # --- autofill + submit ---
            wait_safe_window()
            page = ctx.new_page()
            page.goto('https://online.tugraz.at/tug_online/ee/ui/ca2/app/desktop/#/login')
            page.wait_for_selector('#done', timeout=10000)
            subs = page.evaluate('window.submissions')
            check('autofill submits exactly one code', len(subs) == 1, str(subs))
            check('submitted code is correct (framework saw the input event)', subs and subs[0] == totp(SECRET),
                  f'{subs} vs {totp(SECRET)}')

            # --- reload right after: the per-window guard must block a second auto code ---
            page.goto('https://online.tugraz.at/tug_online/ee/ui/ca2/app/desktop/?x=2#/login')
            time.sleep(3)
            check('no second automatic code within the window', page.evaluate('window.submissions') == [])

            # --- rejection: page rejects, extension must stop and pause ---
            sw.evaluate("chrome.storage.session.remove(['lastAuto','paused'])")
            wait_safe_window()
            bad = ctx.new_page()
            bad.goto('https://online.tugraz.at/tug_online/ee/ui/ca2/app/desktop/?reject=1#/login')
            time.sleep(8)
            subs = bad.evaluate('window.submissions')
            check('after a rejected code there is no retry', len(subs) == 1, str(subs))
            paused = sw.evaluate("chrome.storage.session.get('paused').then(r => Boolean(r.paused))")
            check('autofill is paused after rejection', paused)

            # --- real host: Keycloak OTP step on auth.tugraz.at ---
            sw.evaluate("chrome.storage.session.remove(['lastAuto','paused'])")
            sw.evaluate("chrome.action.setBadgeText({text: ''})")
            wait_safe_window()
            kc = ctx.new_page()
            kc.goto(f'https://auth.tugraz.at{KC_PATH}?session_code=abc')
            kc.wait_for_selector('#done', timeout=10000)
            check('keycloak: one correct code posted', posts == [('session_code=abc', totp(SECRET))], str(posts))

            # --- keycloak rejects: full page reload with error box, must not retry and must pause ---
            posts.clear()
            sw.evaluate("chrome.storage.session.remove(['lastAuto','paused'])")
            wait_safe_window()
            kc2 = ctx.new_page()
            kc2.goto(f'https://auth.tugraz.at{KC_PATH}?reject=1')
            time.sleep(6)
            check('keycloak reject: exactly one post, no retry', len(posts) == 1, str(posts))
            paused = sw.evaluate("chrome.storage.session.get('paused').then(r => Boolean(r.paused))")
            check('keycloak reject: autofill paused', paused)
            check('keycloak reject: field left empty', kc2.input_value('#otp') == '')

            # --- locked: after lock, nothing is filled ---
            sw.evaluate("chrome.storage.session.clear()")
            locked = ctx.new_page()
            locked.goto('https://online.tugraz.at/tug_online/ee/ui/ca2/app/desktop/?l=1#/login')
            time.sleep(3)
            check('locked extension does not fill', locked.evaluate('window.submissions') == [] and
                  locked.input_value('#tok') == '')

            # --- the secret is stored encrypted ---
            stored = sw.evaluate("chrome.storage.local.get('cfg').then(r => JSON.stringify(r.cfg))")
            check('secret is not stored in plain text', SECRET not in stored and '"box"' in stored)

            ctx.close()
        srv.shutdown()

    print(f'\n{"ALL PASSED" if not failures else f"{len(failures)} FAILED"}')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
