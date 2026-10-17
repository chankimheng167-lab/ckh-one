/**
 * Drives the real Electron app (built main + preload, bundled web build)
 * against a running API: sign in, sell, print to PDF, switch to a network
 * ESC/POS printer (a local TCP listener stands in for it) and check the bytes,
 * and check the window cannot be navigated away or open new windows.
 *
 *   CKH_API_URL=http://localhost:3001/api/v1 xvfb-run -a node e2e/run.js
 *
 * Needs `playwright` (any recent version) resolvable from this folder or PLAYWRIGHT_DIR.
 * CKH_APP_EXE=release/linux-unpacked/ckhdesktop runs the packaged app instead
 * (it reads its settings from config.json, and prints to a real printer, so
 * the PDF step is skipped).
 */
const { mkdtempSync, readdirSync, statSync, writeFileSync } = require('fs');
const { createServer } = require('net');
const { tmpdir } = require('os');
const { join } = require('path');
const { _electron: electron } = require(process.env.PLAYWRIGHT_DIR ? join(process.env.PLAYWRIGHT_DIR, 'node_modules/playwright') : 'playwright');

const API = process.env.CKH_API_URL ?? 'http://localhost:3001/api/v1';
const results = [];
const step = async (name, fn) => {
  try {
    await fn();
    results.push(['ok', name]);
    console.log('ok  ', name);
  } catch (e) {
    results.push(['FAIL', name]);
    console.log('FAIL', name, e.message.split('\n')[0]);
    throw e;
  }
};

(async () => {
  const userData = mkdtempSync(join(tmpdir(), 'ckh-pos-'));
  const pdfDir = mkdtempSync(join(tmpdir(), 'ckh-pdf-'));
  const packaged = !!process.env.CKH_APP_EXE;
  if (packaged) writeFileSync(join(userData, 'config.json'), JSON.stringify({ apiUrl: API, printer: { mode: 'none' } }));
  const app = await electron.launch({
    executablePath: packaged ? process.env.CKH_APP_EXE : require('electron'),
    args: packaged ? ['--no-sandbox'] : ['--no-sandbox', join(__dirname, '..')],
    env: { ...process.env, CKH_USER_DATA: userData, CKH_API_URL: API, CKH_PRINT_TO_PDF_DIR: pdfDir, CKH_DISABLE_UPDATES: '1' },
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    await step('opens the bundled POS on the app origin', async () => {
      for (let i = 0; i < 80 && !/^app:\/\/ckh\/login\//.test(page.url()); i++) await page.waitForTimeout(250);
      await page.getByLabel('Company code').waitFor({ timeout: 15000 });
      if (!page.url().startsWith('app://ckh/login/')) throw new Error(page.url());
    });
    await step('exposes only window.ckhPos to the page (no Node)', async () => {
      const r = await page.evaluate(() => ({
        desktop: window.ckhPos?.isDesktop, api: window.ckhPos?.apiUrl, req: typeof window.require, proc: typeof window.process, buf: typeof window.Buffer,
      }));
      if (!r.desktop || r.api !== API || r.req !== 'undefined' || r.proc !== 'undefined' || r.buf !== 'undefined') throw new Error(JSON.stringify(r));
    });
    await step('signs in as the cashier through the configured API', async () => {
      await page.getByLabel('Company code').fill('demo');
      await page.locator('input[type=email], input[autocomplete=username]').first().fill('cashier@demo.ckh.one');
      await page.locator('input[type=password]').fill('ChangeMe!2026');
      await page.getByRole('button', { name: /sign in/i }).click();
      await page.waitForURL(/\/pos\/$/, { timeout: 15000 });
    });
    const sell = async () => {
      await page.evaluate(() => { location.href = '/pos/sell/'; });
      await page.locator('.till-grid .prod').first().waitFor();
      if (await page.getByText('Open a shift to start selling').isVisible()) {
        await page.getByPlaceholder('Opening float').fill('50');
        await page.getByRole('button', { name: 'Open shift' }).click();
      }
      await page.getByText(/Shift SHF-/).waitFor();
      await page.locator('.prod', { hasText: 'Iced Coffee' }).click();
      await page.locator('.pay').click();
      await page.locator('.methods button', { hasText: 'Cash' }).click();
      await page.locator('.sheet .row button').filter({ hasText: /^\$\d/ }).last().click();
      await page.getByRole('button', { name: /Complete/ }).click();
      return (await page.getByText(/Sale POS-\d{4}-\d+ recorded/).innerText({ timeout: 15000 })).match(/POS-\d{4}-\d+/)[0];
    };
    if (!packaged) await step('cash sale prints the receipt without a dialog (Windows printer mode, written as PDF here)', async () => {
      await sell();
      for (let i = 0; i < 40 && !readdirSync(pdfDir).length; i++) await page.waitForTimeout(250);
      const files = readdirSync(pdfDir);
      if (files.length !== 1) throw new Error(`expected one PDF, got ${files.length}`);
      if (statSync(join(pdfDir, files[0])).size < 1000) throw new Error('PDF is empty');
      if (await page.getByText('Receipt not printed').count()) throw new Error(await page.getByText('Receipt not printed').innerText());
    });
    await step('network ESC/POS printer: receipt text, cut and drawer pulse arrive over TCP', async () => {
      const got = [];
      const server = createServer((s) => s.on('data', (d) => got.push(d)));
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;
      await page.evaluate((port) => window.ckhPos.savePrinterSettings({ mode: 'network', host: '127.0.0.1', port, paper: '80', drawer: true, drawerPin: 0 }), port);
      const number = await sell();
      for (let i = 0; i < 40 && !Buffer.concat(got).includes(Buffer.from([0x1b, 0x70, 0x00])); i++) await page.waitForTimeout(250);
      const all = Buffer.concat(got);
      server.close();
      if (!all.slice(0, 2).equals(Buffer.from([0x1b, 0x40]))) throw new Error('no ESC @');
      if (!all.toString('latin1').includes(number)) throw new Error(`receipt number ${number} not printed`);
      if (!all.includes(Buffer.from([0x1d, 0x56, 66]))) throw new Error('no cut');
      if (!all.includes(Buffer.from([0x1b, 0x70, 0x00, 25, 250]))) throw new Error('no drawer pulse');
    });
    await step('a printer that is off shows "Receipt not printed" instead of failing silently', async () => {
      await page.evaluate(() => window.ckhPos.savePrinterSettings({ mode: 'network', host: '127.0.0.1', port: 9, drawer: true }));
      await sell();
      await page.getByText(/Receipt not printed/).waitFor({ timeout: 15000 });
    });
    await step('the window cannot be sent to another site or open new windows', async () => {
      const before = page.url();
      await page.evaluate(() => { location.href = 'https://example.com/'; });
      await page.waitForTimeout(1000);
      if (!page.url().startsWith('app://ckh/')) throw new Error(`navigated to ${page.url()}`);
      const opened = await page.evaluate(() => window.open('https://example.com/') === null);
      if (!opened) throw new Error('window.open was allowed');
      if (app.windows().length !== 1) throw new Error(`${app.windows().length} windows`);
      void before;
    });
    await step('the API address cannot be changed from the page', async () => {
      await page.evaluate(() => window.ckhPos.savePrinterSettings({ apiUrl: 'https://evil.example' }));
      const cfg = require('fs').readFileSync(join(userData, 'config.json'), 'utf8');
      if (cfg.includes('evil')) throw new Error('apiUrl changed');
    });
  } finally {
    console.log('page errors', errors);
    try { console.log('pos.log:', require('fs').readFileSync(join(userData, 'pos.log'), 'utf8')); } catch { /* none */ }
    await page.screenshot({ path: join(tmpdir(), 'ckh-desktop-last.png') }).catch(() => undefined);
    await app.close();
  }
  if (results.some((r) => r[0] === 'FAIL')) process.exit(1);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
