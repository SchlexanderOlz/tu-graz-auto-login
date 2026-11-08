# Design: unofficial OTP autofill for TU Graz

Status: v0.1.0 built, 2026-11-08. Autofill is tested against a fake login page only (see section 9).

A Chrome extension (Manifest V3) that works as a software TOTP token for TU Graz 2FA. You paste the setup key once. The extension then makes the codes itself, entirely in the browser, and fills in the OTP when the TUGRAZonline or SSO login asks for it.

It is a private open-source project. It is **not** made, endorsed or checked by TU Graz.

---

## 1. Facts this design rests on

| Fact | Source |
|---|---|
| A TOTP token is set up on `otp.tugraz.at` with a QR code, then confirmed with "Verify token". | [tu4u: 2FA](https://tu4u.tugraz.at/en/public/2-factor-authentication-2fa) |
| Any common authenticator app works. Desktop apps on the same PC as the browser are documented (2fast, Step Two, `oathtool`, `pass-otp`). | [tu4u: 2FA for desktop](https://tu4u.tugraz.at/en/public/2-factor-authentication-2fa/2fa-for-desktop) |
| The token's `otpauth://` URL shows **`algorithm=sha256`, `period=60`, `digits=6`**, issuer "ZID TU Graz". | same page, Linux section (`oathtool -b --totp=sha256 … -s 60`) |
| The general 2FA page says codes change "every 30 seconds". That conflicts with the line above. | [tu4u: 2FA](https://tu4u.tugraz.at/en/public/2-factor-authentication-2fa) |
| At most 4 tokens per account. TU Graz recommends at least 2 devices, because losing your token means losing access. | both tu4u pages |
| The backend is privacyIDEA (`privacyidea.tugraz.at`). privacyIDEA locks a token after too many wrong codes. | tu4u 2FA page; privacyIDEA's default `max_fail` behaviour |
| `online.tugraz.at` is CAMPUSonline "CA2", an Angular single-page app (`/tug_online/ee/ui/ca2/app/desktop/#/login`). | checked with curl on 2026-11-08 |

**Consequence:** the extension never hard-codes SHA-1/30 s. It reads algorithm, digits and period from the `otpauth://` URL. If you only paste a bare Base32 key, it uses TU Graz's documented values (SHA-256, 6 digits, 60 s), and you can change them.

**Not verified yet:** what the OTP step of the login looks like in the DOM. It only shows up after a real password login, which I can't do. See section 9.

---

## 2. Goals and non-goals

**Goals**
- Turn the setup key (or the full `otpauth://` URL) into the right code, offline, with no server.
- Detect the OTP prompt on TU Graz login pages and fill it in. Submitting it too is a setting, on by default.
- Code small enough to audit in one sitting: no build step, no dependencies, no network calls.
- Safe to publish: no TU Graz logo, a clear "unofficial" label, MIT licence.

**Non-goals**
- Storing or filling in the TU Graz password. Leave that to the browser's password manager.
- Any other site or account. It is not a general authenticator.
- Sync between devices, cloud backup or telemetry.
- Firefox or Safari for v1. MV3 is close to Firefox's model, so a port later is cheap.

---

## 3. Architecture

```
┌────────────── extension (isolated) ──────────────┐
│ options page    setup: paste key / otpauth URL,  │
│                 set passphrase, test code        │
│ popup           current code, countdown, copy,   │
│                 lock/unlock, autofill on/off     │
│ service worker  the only place the secret is     │
│ (background)    decrypted; computes TOTP;        │
│                 answers "give me a code"         │
└──────────▲───────────────────────────────────────┘
           │ chrome.runtime message: {type:"getCode"}
           │ reply: {code, validFor} (never the secret)
┌──────────┴──────── content script ───────────────┐
│ runs only on TU Graz login hosts, top frame only │
│ MutationObserver → finds OTP field → fills it    │
│ → optionally submits → watches for an error      │
└──────────────────────────────────────────────────┘
```

Files (plain JS modules, no bundler):

```
manifest.json
src/totp.js          RFC 4226/6238 with WebCrypto HMAC (SHA-1/256/512)
src/base32.js        RFC 4648 decode, lenient (spaces, lower case, no padding)
src/otpauth.js       parses otpauth://totp/...?secret=&algorithm=&digits=&period=
src/vault.js         encrypt/decrypt the secret, lock state
src/background.js    service worker: messages, lock timer
src/content.js       field detection and filling
src/popup.{html,js}
src/options.{html,js}
icons/               our own icon (see section 8)
test/                RFC 6238 test vectors, run with `node --test`
```

### 3.1 manifest.json (essentials)

```json
{
  "manifest_version": 3,
  "name": "Zweitschlüssel – OTP autofill for TU Graz (unofficial)",
  "permissions": ["storage"],
  "background": { "service_worker": "src/background.js", "type": "module" },
  "content_scripts": [{
    "matches": [
      "https://online.tugraz.at/*",
      "https://sso.tugraz.at/*"
    ],
    "js": ["src/content.js"],
    "run_at": "document_idle",
    "all_frames": true
  }],
  "action": { "default_popup": "src/popup.html" },
  "options_page": "src/options.html",
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'none'; connect-src 'none'"
  }
}
```

- **Only the `storage` permission.** No `tabs`, no `scripting`, no `<all_urls>`. The install prompt then only asks for "read and change your data on online.tugraz.at and sso.tugraz.at".
- `connect-src 'none'` makes "no network calls" a rule Chrome enforces, not just a promise.
- `all_frames: true`, because the CA2 login may render inside a frame. The script still only runs on the two TU Graz hosts.
- The host list is fixed after the live check (section 9). If the 2FA step runs on a different host, that host is added.

---

## 4. TOTP

- `counter = floor((now + offset) / period)`, 8-byte big-endian.
- `HMAC(key, counter)` through `crypto.subtle` with SHA-1, SHA-256 or SHA-512.
- Dynamic truncation (RFC 4226 §5.3), then `mod 10^digits`, padded with zeros.
- `offset` is a clock correction in seconds, 0 by default. It can be set in the options in case the PC clock is off.
- Tests: the RFC 6238 Appendix B vectors for all three algorithms, plus a vector for 60 s / SHA-256.

The code is never computed in the page. The content script only asks the service worker and gets back `{code, validFor}`.

---

## 5. Storing the secret

The setup key is as sensitive as a password: anyone who has it can make your codes forever.

| Mode | What is stored | Trade-off |
|---|---|---|
| **Passphrase (default)** | `chrome.storage.local`: the secret encrypted with AES-256-GCM. The key comes from the passphrase via PBKDF2-SHA-256 (600,000 iterations, random 16-byte salt, random 12-byte IV). | You type the passphrase once per browser session. The derived key then lives in `chrome.storage.session` (memory only, gone on restart). There is an optional auto-lock after N minutes. |
| **No passphrase (opt-in)** | The secret in plain text in `chrome.storage.local`. | Fully automatic, but anyone with access to your Chrome profile gets your second factor. The options page says so before you can switch to it. |

- Other extensions and web pages can't read `chrome.storage` of this extension. Malware on the PC can read the profile on disk, which is exactly what the passphrase mode protects against.
- **Honest limit:** with autofill, the password (in the browser's password manager) and the second factor live on the same device. That is a weaker setup than a phone. TU Graz itself documents desktop tokens on the same PC, so it is allowed. But the README must say it plainly and recommend keeping a second token on the phone. TU Graz recommends 2 devices anyway.
- To view or export the key you have to type the passphrase again. Codes are never logged, and the secret never goes into `console.*`.

---

## 6. Autofill on the login page

### 6.1 Finding the OTP field

CAMPUSonline is an Angular SPA, so the field appears after the password step without a page reload. The content script runs a `MutationObserver` on `document.body` and checks each change, throttled to every 250 ms.

A field counts as the OTP field if it is visible, enabled and empty, and **at least one strong** signal fits:

1. `autocomplete="one-time-code"`
2. `name` or `id` matches `/otp|totp|token|tan|one.?time/i`
3. The `<label>`, `aria-label` or `placeholder` matches `/einmal(passwort|kennwort|code)|otp|token|second factor|zweiter faktor|bestätigungscode|verification code/i`

**and** it does not look like a password field (`type!=="password"`, or the label mentions OTP).

Also: `maxlength` 6–8 or `inputmode="numeric"` raise confidence. If several fields fit, it does nothing.

The exact selectors come from the live check (section 9). The heuristic above is the fallback for when CAMPUSonline changes its markup.

### 6.2 Filling and submitting

1. Ask the service worker for a code. If it's locked, show a small in-page banner: "Unlock Zweitschlüssel" (opens the popup) instead of failing silently.
2. If `validFor < 5 s`, wait for the next code. A code that runs out on the way gets rejected and counts as a failed attempt.
3. Set the value via the native `HTMLInputElement.prototype.value` setter, then fire `input` and `change` (`bubbles: true`). A plain `el.value = x` is not noticed by Angular.
4. If auto-submit is on: click the form's submit button (`form.requestSubmit()` as fallback).

### 6.3 Not locking the account

privacyIDEA locks the token after too many wrong codes. So:

- **At most one automatic try per page load, and one per time window across reloads** (the service worker remembers the last automatic code).
- **Rejection detection:** If the OTP field shows up again, or an error text appears (`/ungültig|falsch|invalid|failed/i` near the field), the extension stops, shows "Code was rejected. Check the clock or the key", and doesn't try again until the next manual login.
- It never submits a code twice.
- The popup always shows the current code, so you can type it in yourself.

---

## 7. Setup flow (options page)

1. On `otp.tugraz.at`, start a new **TOTP** token. Under the QR code, copy the `otpauth://` URL (or the key).
   *To check:* whether the web page shows the URL for every OS or only in the Linux path of the guide. If only a QR code is shown, v1.1 can read the QR code from a screenshot with `BarcodeDetector` (built into Chrome, no library).
2. Paste it into the options page. The fields fill in from the URL (algorithm, digits, period, issuer) and can be edited.
3. Set a passphrase, or choose "no passphrase" after the warning.
4. The page shows the current code with a countdown. Type it into "Verify token" on `otp.tugraz.at`. If TU Graz accepts it, the setup is right.
   (Optional later: the content script also fills in the verify field on `otp.tugraz.at`.)
5. Note: "This counts as 1 of your 4 tokens. Keep a second one on your phone."

---

## 8. Branding and the TU Graz logo

**Result: don't use the TU Graz logo, the TU Graz colours as a brand, or "TU Graz"/"TUG" as the product name. Using "TU Graz" in a description is fine.**

What the sources say:

1. **The logo is a registered trademark.** The TU Graz names and trademarks directive, *RL 92000 MARK 058-02* of 10.09.2019, §1 "Eigentümer": TU Graz owns a word mark **"TU Graz"**, a **figurative mark** (the logo graphic) and a **combined word/figurative mark**, all registered with the Austrian Patent Office. The word mark **"TUG"** is protected too. ([PDF](https://www.tugraz.at/fileadmin/user_upload/tugrazExternal/02bfe6da-df31-4c20-9e9f-819251ecfd4b/2019_2020/Stk_1/RL_92000_MARK_058_02_20190910.pdf))
2. **Students need approval.** Same directive, §4.2: "Studierende dürfen die Namen und Marken der TU Graz ebenfalls nur mit Genehmigung des Rektorates verwenden." The contact is Kommunikation und Marketing (cd@tugraz.at).
3. **Third parties need a written licence.** §4.5: use by third parties is "ausschließlich nach vorheriger Genehmigung durch das Rektorat" allowed, and a written agreement with a trademark licence is required.
4. **The preamble covers outsiders as well.** TU Graz will protect its marks against misleading use by anyone not authorised, and use for products with no direct link to TU Graz or without written approval is forbidden.
5. **The logo may not be changed.** The corporate design directive, *RL 92000 CODE 057-02* of 10.09.2019, §1: the logo always consists of the word and figurative mark together "und darf nicht verändert werden". There are minimum sizes (15 mm / 20 mm in print). A 16×16 icon would be a change that isn't allowed. ([PDF](https://www.tugraz.at/fileadmin/user_upload/tugrazExternal/02bfe6da-df31-4c20-9e9f-819251ecfd4b/2019_2020/Stk_1/RL_92000_CODE_057_02_20190910.pdf))
6. **Trademark law applies independently.** §10 (1) MSchG lets the owner forbid use of the same or a confusingly similar sign in business dealings. §10 (3) Z 3 MSchG allows using a mark to name the purpose of a product ("Hinweis auf die Bestimmung"), if done in good faith. ([RIS §10 MSchG](https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10002180&Paragraf=10))

My conclusion (not a quote from a source):

- **Logo:** no. You're a student (§4.2 → approval needed), and once it's public anyone can install it (§4.5 → licence needed). The logo isn't needed to say what the extension is for, so §10 (3) Z 3 MSchG doesn't cover it. The CD directive's "verbindlich für Mitarbeiter" scope doesn't change this: §4.2 names students on purpose, and trademark law applies to everyone. Whether a free GitHub project counts as "business dealings" under §10 (1) is open. It doesn't matter, though, because the directive alone requires approval.
- **"TU Graz" in the text:** yes, as a description ("for TU Graz logins", "works with TUGRAZonline"). That is naming the purpose under §10 (3) Z 3. "Unofficial" must sit right next to it so nobody thinks TU Graz made it.
- **Product name:** its own name, **"Zweitschlüssel"**, with the description "OTP autofill for TU Graz (unofficial)". Not "TU Graz Authenticator", not "TUG-OTP".
- **Icon and colours:** our own icon (a key with a "2", neutral blue or grey). Don't use the logo's dot/square pattern or the TU Graz red `#e4154b` as the main colour.
- **README disclaimer:** "Not affiliated with, endorsed or reviewed by Graz University of Technology. 'TU Graz' is a registered trademark of Technische Universität Graz and is used only to describe compatibility."
- **If you want the logo anyway:** email cd@tugraz.at (Kommunikation und Marketing) asking the Rektorat for approval. Without written approval, leave it out.

---

## 9. Open points before building

1. **Live DOM of the OTP step.** Log in to `online.tugraz.at` once. When the OTP field appears, save the page (Ctrl+S, "complete") or copy the field's `outerHTML` and the URL. That fixes the selectors and the host list.
2. **Which hosts ask for the OTP:** only `online.tugraz.at`, or also `sso.tugraz.at` (Shibboleth) and the VPN web login? The first version covers TUGRAZonline. Others come later after the same check.
3. **30 s vs. 60 s:** the setup page will show the real value in the `otpauth://` URL. We trust that, not the docs.
4. **Does `otp.tugraz.at` show the key as text?** If not, add the QR-from-screenshot import (section 7) to v1.

---

## 10. Distribution

- GitHub, MIT licence. A release ZIP for "Load unpacked". Contents: README (setup, security limits, disclaimer), SECURITY.md (how to report issues), the tests.
- Chrome Web Store is optional later ($5 one-time developer fee). The store bans impersonation, so the unofficial label and our own icon from section 8 are needed there too. Without a store listing there are no automatic updates, which the README must say.

## 11. Build order (each step tested and committed)

1. `base32.js`, `otpauth.js`, `totp.js` with RFC test vectors (`node --test`).
2. Options page and vault (encryption, lock/unlock), with a code display to check against `otp.tugraz.at`.
3. Popup (code, countdown, copy).
4. Content script on the saved OTP page from section 9 (filling only).
5. Auto-submit and the lockout guard.
6. README, disclaimer, icon, release ZIP.
