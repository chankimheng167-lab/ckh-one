# CKH ONE POS for Windows

An Electron shell around the same POS screens as the web app, with direct
receipt printing, the cash drawer, and encrypted local storage. It talks only
to the CKH ONE API; it holds no private keys.

## What it does

- Loads the bundled web build from `app://ckh` (no remote pages). Navigation
  to other sites, new windows, webviews and browser permissions (camera,
  location, …) are refused. Pages run sandboxed with context isolation and no
  Node.js; a Content Security Policy limits network access to the API.
- Exposes `window.ckhPos` to the POS screens: printer settings, silent
  printing, drawer, test print. Every call is checked to come from the app's
  own page.
- **Printing**
  - *Windows printer* (default): the receipt HTML from the API is printed
    silently to the chosen Windows printer, at 58 mm, 80 mm or A4. Works for
    English, Khmer and Chinese, because the printer driver renders it.
  - *Network ESC/POS printer* (IP, port 9100): the API's plain-text receipt is
    sent as ESC/POS bytes with a paper cut. English only.
- **Cash drawer**: on a network ESC/POS printer the drawer is pulsed (ESC p)
  with the receipt of a cash sale, or from Printer settings. With a Windows
  printer, use the driver's "open cash drawer" option.
- **Barcode scanners**: USB scanners in keyboard mode work as in the browser
  (the till listens for the Enter/Tab suffix).
- **Encrypted storage** (`secure.dat`): AES-256-GCM, with the data key
  protected by Windows DPAPI for the signed-in user (Electron `safeStorage`).
  Used by offline mode and device activation.
- **Updates**: when built with `CKH_UPDATE_URL`, checks for updates on start,
  verifies the SHA-512 and (on Windows) that the update is signed by the same
  publisher, and installs only when the cashier chooses to restart.

## Not supported (yet)

- Serial/COM and USB printers in raw ESC/POS mode (use the Windows driver).
- Printing Khmer or Chinese on ESC/POS without a driver.
- Customer displays.

## Develop (PowerShell)

```powershell
pnpm install
pnpm --filter @ckh/shared build
pnpm --filter @ckh/web build          # the bundle the app loads
$env:CKH_API_URL = "http://localhost:3001/api/v1"
pnpm --filter @ckh/desktop start
```

The API must allow the app's origin: add `app://ckh` to `CORS_ORIGINS`, e.g.
`$env:CORS_ORIGINS = "http://localhost:3100,app://ckh"`.

## Build the installer (PowerShell, on Windows)

```powershell
$env:NEXT_PUBLIC_API_URL = "https://api.example.com/api/v1"
pnpm --filter @ckh/web build
$env:CSC_LINK = "C:\certs\ckh-codesign.pfx"; $env:CSC_KEY_PASSWORD = "<password>"
$env:CKH_PUBLISHER_NAME = "Your Company Co., Ltd."
$env:CKH_UPDATE_URL = "https://downloads.example.com/pos/"
pnpm --filter @ckh/desktop dist:win
```

The installer is written to `apps/desktop/release/`. Upload it together with
`latest.yml` to the update URL. Keep the certificate off the build machine's
disk when you can (a hardware token or a signing service). An unsigned build
(no `CSC_LINK`) is for testing only.

Settings on each computer live in `%APPDATA%\CKH ONE POS\config.json`
(`apiUrl` overrides the address the installer was built for; printer settings
are changed from POS → Printer settings → This computer).

## Tests

- `pnpm --filter @ckh/desktop test`: ESC/POS bytes, network printer over TCP,
  encrypted store (including tampering and another user's key), config and URL
  rules.
- `e2e/run.js` drives the real app with Playwright against a running API:
  sign-in, a cash sale printed silently (to PDF in test mode), a network
  ESC/POS printer (a local TCP listener) receiving the receipt, cut and drawer
  pulse, a printer that is off, navigation and window-opening refused, the API
  address not changeable from the page. Run it with
  `CKH_APP_EXE=release/linux-unpacked/ckh-one-pos` against the packaged build too.
