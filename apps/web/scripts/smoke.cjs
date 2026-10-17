/**
 * Browser smoke test against a running API (seeded demo company) and web app.
 * Visits every screen as rep, manager, admin and accountant, then takes an order
 * offline, reconnects and checks the server accepted it.
 *   WEB_URL=http://localhost:3100 node apps/web/scripts/smoke.cjs   (needs `npm i -g playwright` or a local install)
 */
const { chromium } = require('playwright');
const BASE = process.env.WEB_URL ?? 'http://localhost:3100';
const SHOTS = process.env.SHOTS_DIR ?? require('os').tmpdir();
const problems = [];

async function login(page, email) {
  await page.goto(`${BASE}/login/`);
  await page.fill('input >> nth=0', 'demo');
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', 'ChangeMe!2026');
  await page.click('button[type=submit]');
  await page.waitForURL(`${BASE}/`, { timeout: 15000 });
}
async function visit(page, who, path, waitText) {
  await page.goto(`${BASE}${path}`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(400);
  const bad = await page.locator('.notice.bad').allInnerTexts();
  if (bad.length) problems.push(`${who} ${path}: ${bad.join(' | ')}`);
  if (waitText && !(await page.getByText(waitText, { exact: false }).count())) problems.push(`${who} ${path}: missing "${waitText}"`);
  await page.screenshot({ path: `${SHOTS}/${who}${path.replace(/[/?=&]+/g, '_').slice(0, 60)}.png`, fullPage: true }).catch((e) => problems.push(`screenshot ${who} ${path}: ${e.message.split('\n')[0]}`));
}

(async () => {
  const browser = await chromium.launch();
  for (const [who, email, viewport, pages] of [
    ['rep', 'rep@demo.ckh.one', { width: 390, height: 844 }, [['/', 'Today'], ['/customers/', 'Sunrise'], ['/catalog/', 'available'], ['/orders/new/', 'New sales order'], ['/orders/', 'My orders'], ['/visits/', 'Customer visits'], ['/collections/', 'Payment collections'], ['/targets/', 'Sales targets'], ['/commissions/', 'Commissions'], ['/sync/', 'Offline queue']]],
    ['manager', 'manager@demo.ckh.one', { width: 1280, height: 860 }, [['/', 'This month'], ['/approvals/', 'Pending approvals'], ['/deliveries/', 'Delivery tracking'], ['/team/', 'Team performance'], ['/territories/', 'Territories'], ['/reports/', 'Net sales'], ['/targets/', 'Set a target'], ['/commissions/', 'Approve']]],
    ['admin', 'admin@demo.ckh.one', { width: 1280, height: 860 }, [['/settings/', 'Theme Studio']]],
    ['accountant', 'accountant@demo.ckh.one', { width: 1280, height: 860 }, [['/collections/', 'Payment collections']]],
  ]) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${who} pageerror ${page.url()}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && !/tile.openstreetmap|unpkg|Failed to load resource/.test(m.text()) && problems.push(`${who} console ${page.url()}: ${m.text()}`));
    await login(page, email);
    for (const [p, t] of pages) await visit(page, who, p, t);

    if (who === 'rep') {
      // Customer profile and product details via the lists.
      await page.goto(`${BASE}/customers/`); await page.waitForLoadState('networkidle');
      await page.locator('a.listlink').first().click(); await page.waitForLoadState('networkidle');
      await visit(page, who, new URL(page.url()).pathname + new URL(page.url()).search, 'Order history');
      await page.goto(`${BASE}/catalog/`); await page.waitForLoadState('networkidle');
      await page.locator('a.card').first().click(); await page.waitForLoadState('networkidle');
      await visit(page, who, new URL(page.url()).pathname + new URL(page.url()).search, 'Stock by warehouse');

      // Online order: choose customer, add product, submit.
      await page.goto(`${BASE}/orders/new/`); await page.waitForLoadState('networkidle');
      await page.waitForFunction(() => document.querySelectorAll('select')[0].options.length > 1); await page.selectOption('select >> nth=0', { index: 1 });
      await page.waitForTimeout(800);
      await page.fill('input[placeholder^="Search product"]', 'a');
      await page.locator('ul.list button.link').first().click();
      await page.waitForTimeout(200);
      await page.getByRole('button', { name: 'Submit order' }).click();
      await page.waitForURL(/orders\/view/, { timeout: 15000 }).catch(() => problems.push('online order did not open detail: ' + page.url()));
      await page.waitForLoadState('networkidle');
      await visit(page, who, new URL(page.url()).pathname + new URL(page.url()).search, 'History');

      // Offline order: queue it, reconnect, sync.
      await page.goto(`${BASE}/orders/new/`); await page.waitForLoadState('networkidle');
      await ctx.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await page.waitForTimeout(300);
      await page.waitForFunction(() => document.querySelectorAll('select')[0].options.length > 1); await page.selectOption('select >> nth=0', { index: 1 });
      await page.waitForTimeout(500);
      await page.fill('input[placeholder^="Search product"]', 'a');
      await page.locator('ul.list button.link').first().click();
      await page.getByRole('button', { name: 'Queue order' }).click();
      await page.waitForURL(/sync/, { timeout: 15000 }).catch(() => problems.push('offline order did not go to queue: ' + page.url()));
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${SHOTS}/rep_offline_queue.png`, fullPage: true });
      const pending = await page.getByText('Pending', { exact: false }).count();
      if (!pending) problems.push('offline order not shown as pending');
      await ctx.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await page.waitForTimeout(2500);
      await page.reload(); await page.waitForTimeout(1000);
      await page.screenshot({ path: `${SHOTS}/rep_after_sync.png`, fullPage: true });
      const accepted = await page.locator('.badge', { hasText: /Accepted/ }).count();
      if (!accepted) problems.push('offline order not accepted after reconnect');
    }
    await ctx.close();
  }
  await browser.close();
  console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'ALL GOOD');
})().catch((e) => { console.error(e); process.exit(1); });
