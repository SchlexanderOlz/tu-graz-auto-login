# Zweitschlüssel: OTP autofill for TU Graz (unofficial)

A Chrome extension that acts as your TU Graz 2FA token. You paste the setup key once. After that it makes the 6-digit codes inside your browser and fills them in when TUGRAZonline asks for the OTP.

> **Unofficial.** Not affiliated with, endorsed by or reviewed by Graz University of Technology. "TU Graz" is a registered trademark of Technische Universität Graz and is used here only to say what this extension works with.

- **No network access.** The extension's security policy blocks all requests (`connect-src 'none'`), so your key can't leave the browser.
- **No dependencies, no build step.** About 1,200 lines of plain JavaScript, HTML and CSS you can read in one sitting.
- **Minimal permissions.** It only needs `storage`, and it only runs on the TU Graz login hosts `auth.tugraz.at`, `online.tugraz.at` and `sso.tugraz.at`.
- **Encrypted key.** The key is protected with a passphrase you type once per browser session (AES-256-GCM, PBKDF2 with 600,000 rounds).
- **Lockout protection.** It tries at most one automatic code per login. If a code is rejected, autofill pauses, so TU Graz never locks your token.

## Install

1. Download **[`dist/zweitschluessel-0.1.1.zip`](dist/zweitschluessel-0.1.1.zip)**, or get it from the [latest release](../../releases/latest).
2. **Unzip it.** Chrome can't install a zip directly. You get a folder named `zweitschluessel`.
3. Open `chrome://extensions` and switch on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `zweitschluessel` folder.
5. The settings page opens. Pin the extension to the toolbar if you like.

Don't delete the folder afterwards: Chrome loads the extension from there. This install does not update itself. For a new version, replace the folder and click the reload icon on `chrome://extensions`.

Also works in Edge, Brave and other Chromium browsers (version 110 or newer).

## Set up your token

1. Go to **`otp.tugraz.at`** and add a new **TOTP** token. You need the one-time registration code. If you already have a token, use its current OTP instead.
2. Copy the **`otpauth://` link** shown with the QR code. The key on its own works too.
3. Paste it into the Zweitschlüssel settings page. Algorithm, digits and period are read from the link. For a bare key, TU Graz's documented values (SHA-256, 6 digits, 60 s) are used.
4. Choose a passphrase and click **Save token**.
5. Type the code shown into **"Verify token"** on `otp.tugraz.at`. If TU Graz accepts it, you're done.

You can have at most 4 tokens at TU Graz. **Keep a second token on your phone.** If you lose this browser profile and have no other token, you are locked out of TUGRAZonline.

## Everyday use

- Log in to TUGRAZonline as usual and let the browser fill in your password. When the OTP step appears, Zweitschlüssel fills in the code and submits it.
- If it's locked (after a browser restart), a small box appears at the bottom right of the page. Click the toolbar icon, type your passphrase, then click **Fill**.
- The toolbar popup always shows the current code with a **Copy** button, for any other place that asks for it.
- A red **!** on the icon means a code was rejected and autofill is paused. Usual causes are a wrong computer clock or the wrong key. Fix the cause, then click **Resume autofill** in the popup. The settings have a clock correction in seconds if needed.

## Security: what you should know

- **The setup key is as sensitive as a password.** Anyone who has it can make your codes forever.
- **With autofill, both factors are on one device:** the password in your password manager and the code in this extension. That is weaker than a code on your phone. TU Graz itself documents authenticator apps on the same computer, so this is allowed, but you should decide knowingly.
- **Passphrase mode (the default).** The key is stored encrypted. After you unlock, it is kept only in memory until Chrome closes, or until the auto-lock time you set.
- **"No passphrase" mode.** The key sits in plain text in your Chrome profile, and any malware that can read your profile can copy it. Only use this on a personal computer with disk encryption.
- **The page never sees your key.** The script on the login page only gets the 6-digit code from the extension's background worker.

Found a problem? See [SECURITY.md](SECURITY.md).

## Status and limits

- **Version 0.1.1.** The OTP step runs on `auth.tugraz.at` (Keycloak). Autofill is built for that page's real markup.
- The code generator is tested against the RFC 4226 and RFC 6238 test vectors.
- **Autofill is tested in Chromium against a copy of the real `auth.tugraz.at` OTP form** (field `#otp`, button "Anmelden", full page reload on a wrong code). If TU Graz changes the page and autofill stops working, open an issue with the OTP field's HTML (right-click → Inspect → copy `outerHTML`; never include your code or key). Meanwhile, use Copy in the popup.
- **Only TUGRAZonline and the TU Graz SSO are covered.** The VPN client is not.

## Development

```bash
npm test                  # unit tests (Node ≥ 20), RFC test vectors
python3 test/e2e/run.py   # end-to-end in Chromium (needs Python Playwright + openssl)
npm run build             # writes dist/zweitschluessel-<version>.zip
python3 scripts/make-icons.py   # redraws the icons
```

Design notes, sources and the reasoning on the TU Graz trademark are in [DESIGN.md](DESIGN.md).

## License

[MIT](LICENSE)
