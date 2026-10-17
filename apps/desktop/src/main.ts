import { app, BrowserWindow, ipcMain, IpcMainEvent, IpcMainInvokeEvent, protocol, safeStorage, session, WebContents } from 'electron';
import { randomUUID } from 'crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { extname, join, resolve, sep } from 'path';
import { DesktopConfig, loadConfig, PrinterConfig, saveConfig, sanitize } from './config';
import { openDrawerBytes, receipt } from './escpos';
import { sendRaw } from './network-printer';
import { OfflineVault } from './offline';
import { APP_ORIGIN, csp, isAppUrl, resolveAppPath } from './security';
import { SecureStore } from './secure-store';
import { checkForUpdates } from './updates';

// Lets tests and a second install use their own profile folder.
if (process.env.CKH_USER_DATA) app.setPath('userData', resolve(process.env.CKH_USER_DATA));

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const configFile = () => join(app.getPath('userData'), 'config.json');
const log = (m: string) => {
  try {
    appendFileSync(join(app.getPath('userData'), 'pos.log'), `${new Date().toISOString()} ${m}\n`);
  } catch {
    /* logging must never stop the till */
  }
};
let config: DesktopConfig;
let win: BrowserWindow | null = null;
let store: SecureStore;
let vault: OfflineVault;

/** The bundled web app: resources/web when installed, apps/web/out in development. */
const webDir = () => resolve(process.env.CKH_WEB_DIR ?? (app.isPackaged ? join(process.resourcesPath, 'web') : join(__dirname, '..', '..', 'web', 'out')));

/** What the bundled web build was made for (written by scripts/copy-web.js): API address and licence key. */
function builtFor(): { apiUrl?: string; licensePublicKey?: string } {
  try {
    return JSON.parse(readFileSync(join(webDir(), 'ckh-desktop.json'), 'utf8'));
  } catch {
    return {};
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.txt': 'text/plain',
};

function serveApp() {
  const root = webDir();
  protocol.handle('app', async (req) => {
    const rel = resolveAppPath(req.url);
    let file = rel ? join(root, rel) : null;
    if (file && !file.startsWith(root + sep)) file = null;
    if (file && !existsSync(file)) file = existsSync(join(root, '404.html')) ? join(root, '404.html') : null;
    if (!file) return new Response('Not found', { status: 404 });
    return new Response(readFileSync(file), {
      headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'content-security-policy': csp(config.apiUrl) },
    });
  });
}

/** Every IPC call must come from the app's own page, never from a frame or another origin. */
function fromApp(e: IpcMainEvent | IpcMainInvokeEvent) {
  const url = e.senderFrame?.url ?? '';
  if (!isAppUrl(url) || e.senderFrame !== e.sender.mainFrame) throw new Error('Refused: not the POS app');
}

/** webContents.print takes microns. */
const paperSize = (paper: string) =>
  paper === 'A4' ? ('A4' as const) : { width: (paper === '58' ? 58 : 80) * 1000, height: 297000 };
/** printToPDF takes inches. */
const pdfPaperSize = (paper: string) => (paper === 'A4' ? ('A4' as const) : { width: (paper === '58' ? 58 : 80) / 25.4, height: 297 / 25.4 });

/** Renders receipt HTML in a hidden window with scripts off and prints it to the configured Windows printer. */
async function printHtml(html: string, paper: string, p: PrinterConfig): Promise<{ printed: boolean; file?: string }> {
  const w = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } });
  try {
    await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    // Development and tests only: write a PDF instead of printing.
    if (!app.isPackaged && process.env.CKH_PRINT_TO_PDF_DIR) {
      const pdf = await w.webContents.printToPDF({ pageSize: pdfPaperSize(paper), margins: { top: 0, bottom: 0, left: 0, right: 0 }, printBackground: true });
      const file = join(process.env.CKH_PRINT_TO_PDF_DIR, `receipt-${Date.now()}.pdf`);
      writeFileSync(file, pdf);
      return { printed: true, file };
    }
    await new Promise<void>((ok, fail) =>
      w.webContents.print(
        { silent: true, printBackground: true, deviceName: p.deviceName || undefined, margins: { marginType: 'none' }, pageSize: paperSize(paper) },
        (success, reason) => (success ? ok() : fail(new Error(`Printer: ${reason}`))),
      ),
    );
    return { printed: true };
  } finally {
    w.destroy();
  }
}

function ipc() {
  ipcMain.on('ckh:boot', (e) => {
    try {
      fromApp(e);
      e.returnValue = { apiUrl: config.apiUrl, version: app.getVersion(), platform: process.platform };
    } catch {
      e.returnValue = { apiUrl: '', version: '', platform: '' };
    }
  });
  const handle = (ch: string, fn: (...a: any[]) => unknown) =>
    ipcMain.handle(ch, async (e, ...a) => {
      fromApp(e);
      try {
        return await fn(...a);
      } catch (err) {
        log(`${ch}: ${(err as Error).message}`);
        throw err;
      }
    });
  handle('ckh:printer:get', () => config.printer);
  // Only printer settings can be changed from the app; the API address is set at install time.
  handle('ckh:printer:save', (s: unknown) => {
    config = sanitize({ ...config, printer: s }, config);
    saveConfig(configFile(), config);
    return config.printer;
  });
  handle('ckh:printers', async () => (await win!.webContents.getPrintersAsync()).map((p) => ({ name: p.name, isDefault: (p as any).isDefault ?? false })));
  handle('ckh:print:html', async (html: unknown, opts: { paper?: string }) => {
    if (typeof html !== 'string' || html.length > 2_000_000) throw new Error('Receipt is not valid');
    const p = config.printer;
    if (p.mode === 'none') return { printed: false, reason: 'Printing is turned off on this computer' };
    if (p.mode === 'network') throw new Error('This till prints to a network ESC/POS printer: print the text receipt');
    return printHtml(html, opts?.paper ?? p.paper, p);
  });
  handle('ckh:print:text', async (text: unknown, opts: { openDrawer?: boolean }) => {
    if (typeof text !== 'string' || text.length > 200_000) throw new Error('Receipt is not valid');
    const p = config.printer;
    if (p.mode !== 'network' || !p.host) throw new Error('No network receipt printer is set up on this computer');
    await sendRaw(p.host, p.port, receipt(text, { cut: true, openDrawer: !!opts?.openDrawer && p.drawer, drawerPin: p.drawerPin }));
    return { printed: true, drawer: !!opts?.openDrawer && p.drawer };
  });
  handle('ckh:drawer:open', async () => {
    const p = config.printer;
    if (!p.drawer) return { opened: false, reason: 'No cash drawer is set up on this computer' };
    if (p.mode !== 'network' || !p.host) return { opened: false, reason: 'The drawer opens through the printer driver: set “open drawer” in the Windows printer settings' };
    await sendRaw(p.host, p.port, openDrawerBytes(p.drawerPin));
    return { opened: true };
  });
  // Offline selling. The device secret never leaves this process: it is added
  // to the till's API calls below, in sendDeviceHeader.
  handle('ckh:device:status', () => ({ ...vault.status(), apiMatches: vault.device()?.apiUrl === config.apiUrl }));
  handle('ckh:device:activate', async (accessToken: unknown, body: { registerId?: unknown; name?: unknown }) => {
    if (typeof accessToken !== 'string' || accessToken.length > 4000) throw new Error('Sign in first');
    let installId = store.get<string>('installId');
    if (!installId) {
      installId = `pc-${randomUUID()}`;
      store.set('installId', installId);
    }
    const res = await fetch(`${config.apiUrl}/pos/devices/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ registerId: body?.registerId, name: body?.name, deviceKey: installId, platform: process.platform, appVersion: app.getVersion() }),
    });
    const r = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(r?.error?.message ?? `Activation failed (${res.status})`);
    vault.activate({ deviceId: r.deviceId, deviceSecret: r.deviceSecret, registerId: r.registerId, apiUrl: config.apiUrl, publicKey: r.publicKey }, r.license);
    reloadDevice();
    log(`device activated ${r.deviceId}`);
    return vault.status();
  });
  handle('ckh:device:renew', (token: unknown, publicKey: unknown) => {
    if (typeof token !== 'string') throw new Error('Licence is not valid');
    return vault.renew(token, typeof publicKey === 'string' ? publicKey : undefined);
  });
  handle('ckh:device:revoked', () => {
    vault.revoked();
    log('device revoked by the server');
    return vault.status();
  });
  handle('ckh:offline:snapshot:save', (snap: unknown) => vault.saveSnapshot(snap));
  handle('ckh:offline:snapshot', () => vault.snapshot() ?? null);
  handle('ckh:offline:enqueue', (e: any) => vault.enqueue(e));
  handle('ckh:offline:queue', () => vault.queue());
  handle('ckh:offline:settle', (results: any) => vault.settle(results));
  handle('ckh:offline:refused', () => vault.refused());
  handle('ckh:print:test', async () => {
    const p = config.printer;
    const text = ['CKH ONE POS', 'Printer test', new Date().toLocaleString('en-GB'), ''].join('\n');
    if (p.mode === 'network') {
      if (!p.host) throw new Error('No network receipt printer is set up on this computer');
      await sendRaw(p.host, p.port, receipt(text, { cut: true }));
      return { printed: true };
    }
    if (p.mode === 'none') return { printed: false, reason: 'Printing is turned off on this computer' };
    return printHtml(`<pre style="font:12px monospace">${text}</pre>`, p.paper, p);
  });
}

/** The device identity in memory, so the request hook never touches the encrypted file. */
let deviceCache: ReturnType<OfflineVault['device']>;
const reloadDevice = () => {
  deviceCache = vault.device();
};

/** Adds "X-POS-Device: <id>:<secret>" to the till's POS calls to its own API, and nowhere else. */
function sendDeviceHeader() {
  const origin = new URL(config.apiUrl).origin;
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, cb) => {
    const d = deviceCache;
    const headers = { ...details.requestHeaders };
    delete headers['X-POS-Device'];
    if (d && d.apiUrl === config.apiUrl && details.url.startsWith(`${config.apiUrl}/pos/`) && details.method !== 'OPTIONS') {
      headers['X-POS-Device'] = `${d.deviceId}:${d.deviceSecret}`;
    }
    cb({ requestHeaders: headers });
  });
}

function lockDown(contents: WebContents) {
  contents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  contents.on('will-redirect', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 800,
    minHeight: 600,
    title: 'CKH ONE POS',
    backgroundColor: '#ffffff',
    kiosk: process.env.CKH_KIOSK === '1',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.loadURL(`${APP_ORIGIN}/pos/`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on('web-contents-created', (_e, contents) => lockDown(contents));
  app.whenReady().then(() => {
    const built = builtFor();
    config = loadConfig(configFile(), built.apiUrl, app.isPackaged ? undefined : process.env.CKH_API_URL);
    // Development and tests on Linux without a keyring only; the installed app never does this.
    if (!app.isPackaged && process.platform === 'linux' && process.env.CKH_DEV_PLAINTEXT_KEYSTORE === '1') safeStorage.setUsePlainTextEncryption(true);
    store = new SecureStore(join(app.getPath('userData'), 'secure.dat'), {
      // Linux without a keyring falls back to a fixed built-in key ("basic_text"): not encryption, so the
      // installed app refuses it. Windows always uses DPAPI. Development runs may use it for tests.
      available: () =>
        safeStorage.isEncryptionAvailable() &&
        !(process.platform === 'linux' && app.isPackaged && safeStorage.getSelectedStorageBackend() === 'basic_text'),
      encrypt: (b) => safeStorage.encryptString(b.toString('base64')),
      decrypt: (b) => Buffer.from(safeStorage.decryptString(b), 'base64'),
    });
    vault = new OfflineVault(store, built.licensePublicKey);
    try {
      reloadDevice();
    } catch (e) {
      log(`secure store: ${(e as Error).message}`);
    }
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    serveApp();
    sendDeviceHeader();
    ipc();
    createWindow();
    void checkForUpdates(log);
  });
  app.on('window-all-closed', () => app.quit());
}

