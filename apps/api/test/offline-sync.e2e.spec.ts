import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { ALL_SALES_MODULES, Api, bootApp, Company, createCompany, ownerUrl, rootApi } from './helpers';

let app: INestApplication;
let co: Company;
let other: Company;
let api: Api;

beforeAll(async () => {
  app = await bootApp();
  co = await createCompany(app);
  other = await createCompany(app);
  api = new Api(app);
});
afterAll(async () => app?.close());

const rep = () => api.as(co.tokens.rep);
const key = () => `dev-${randomUUID()}`;
const fresh = () => new Date().toISOString();
const line = (productId: string, quantity: string, discountPercent = '0') => ({ productId, quantity, discountPercent });

async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: ownerUrl() });
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end();
  }
}

const push = (token: string, events: unknown[], catalogSnapshotAt: string | undefined = fresh()) =>
  api.as(token).post('/sales/sync', { deviceId: 'phone-1', catalogSnapshotAt, events });

describe('Offline snapshot', () => {
  it('downloads only what this rep may see, with stock age and indicative prices', async () => {
    const r = await rep().get('/sales/sync/bootstrap');
    expect(r.status).toBe(200);
    expect(r.body.maxAgeHours).toBe(24);
    expect(new Date(r.body.staleAfter).getTime()).toBeGreaterThan(new Date(r.body.snapshotAt).getTime());
    expect(r.body.customers.map((c: { code: string }) => c.code).sort()).toEqual(['LUCKY', 'SUNRISE']);
    const rice = r.body.products.find((p: { sku: string }) => p.sku === 'RICE');
    expect(rice.stock[0].available).toBeDefined();
    expect(rice.stock_as_of).toBeTruthy();
    const items = r.body.priceLists.flatMap((l: { items: { product_id: string; unit_price: string }[] }) => l.items);
    expect(Number(items.find((i: { product_id: string }) => i.product_id === co.products.rice).unit_price)).toBe(24);
    expect(r.body.rep.id).toBe(co.repId);
    expect(r.body.settings.visitLocationCapture).toBe('ASK');
  });
});

describe('Offline order sync', () => {
  it('creates, revalidates and submits an offline order, and replays retries idempotently', async () => {
    const k = key();
    const ev = { idempotencyKey: k, entityType: 'SALES_ORDER', clientCreatedAt: fresh(), payload: { customerId: co.customers.sunrise, deviceGrandTotal: '52.80', lines: [line(co.products.rice, '2')] } };
    const r = await push(co.tokens.rep, [ev]);
    expect(r.status).toBe(200);
    const res = r.body.results[0];
    expect(res).toMatchObject({ idempotencyKey: k, status: 'ACCEPTED', replayed: false });
    expect(res.number).toMatch(/^SO-/);
    expect(res.result.orderStatus).toBe('APPROVED');

    const o = (await sql('SELECT source, is_provisional, grand_total FROM sales_orders WHERE id = $1', [res.entityId]))[0];
    expect(o).toMatchObject({ source: 'OFFLINE_SYNC', is_provisional: false, grand_total: '52.80' });

    // The phone lost the response and retries: same result, no second order.
    const again = await push(co.tokens.rep, [ev]);
    expect(again.body.results[0]).toMatchObject({ status: 'ACCEPTED', replayed: true, entityId: res.entityId });
    expect((await sql('SELECT count(*)::int AS n FROM sales_orders WHERE client_reference = $1', [`sync:${k}`]))[0].n).toBe(1);

    // Same key, different content: refused rather than silently ignored.
    const clash = await push(co.tokens.rep, [{ ...ev, payload: { ...ev.payload, lines: [line(co.products.rice, '3')] } }]);
    expect(clash.body.results[0].status).toBe('CONFLICT');
    expect(clash.body.results[0].error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('flags a price the device got wrong and routes it for approval', async () => {
    const r = await push(co.tokens.rep, [
      { idempotencyKey: key(), entityType: 'SALES_ORDER', payload: { customerId: co.customers.sunrise, deviceGrandTotal: '50.00', lines: [line(co.products.rice, '2')] } },
    ]);
    const res = r.body.results[0];
    expect(res.status).toBe('ACCEPTED_WITH_CHANGES');
    expect(res.changes.map((c: { code: string }) => c.code)).toEqual(expect.arrayContaining(['PRICE_CHANGED', 'NEEDS_APPROVAL']));
    expect(res.result).toMatchObject({ orderStatus: 'PENDING_APPROVAL', grandTotal: '52.80', deviceGrandTotal: '50.00' });
    const appr = await sql('SELECT reason FROM sales_order_approvals WHERE order_id = $1', [res.entityId]);
    expect(appr.map((a) => a.reason)).toContain('OFFLINE_PRICE_CHANGE');
  });

  it('marks orders built from a stale catalogue and reports stock shortages', async () => {
    const old = new Date(Date.now() - 3 * 86400_000).toISOString();
    const r = await push(co.tokens.rep, [
      { idempotencyKey: key(), entityType: 'SALES_ORDER', payload: { customerId: co.customers.sunrise, lines: [line(co.products.water, '3')] } },
    ], old);
    const res = r.body.results[0];
    expect(res.status).toBe('ACCEPTED_WITH_CHANGES');
    const codes = res.changes.map((c: { code: string }) => c.code);
    expect(codes).toContain('STALE_CATALOG');
    expect(codes).toContain('BACKORDER'); // no water in stock
  });

  it('rejects one bad event without blocking the rest of the outbox', async () => {
    const ok1 = key();
    const bad = key();
    const ok2 = key();
    const r = await push(co.tokens.rep, [
      { idempotencyKey: ok1, entityType: 'SALES_ORDER', payload: { customerId: co.customers.sunrise, lines: [line(co.products.oil, '1')] } },
      { idempotencyKey: bad, entityType: 'SALES_ORDER', payload: { customerId: co.customers.other, lines: [line(co.products.oil, '1')] } }, // not this rep's customer
      { idempotencyKey: ok2, entityType: 'SALES_ORDER', payload: { customerId: co.customers.lucky, submit: false, lines: [line(co.products.oil, '1')] } },
    ]);
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(['ACCEPTED', 'REJECTED', 'ACCEPTED']);
    expect(r.body.results[1].error.code).toBeTruthy();
    expect(r.body.results[2].result.orderStatus).toBe('DRAFT');
    expect(r.body.summary).toMatchObject({ ACCEPTED: 2, REJECTED: 1 });
    // A rejected event is final: retrying returns the same rejection.
    const retry = await push(co.tokens.rep, [{ idempotencyKey: bad, entityType: 'SALES_ORDER', payload: { customerId: co.customers.other, lines: [line(co.products.oil, '1')] } }]);
    expect(retry.body.results[0]).toMatchObject({ status: 'REJECTED', replayed: true });
    // Nothing was left behind for the rejected order.
    expect((await sql('SELECT count(*)::int AS n FROM sales_orders WHERE client_reference = $1', [`sync:${bad}`]))[0].n).toBe(0);
  });

  it('syncs a whole offline visit, its note and its order in one batch', async () => {
    const vKey = key();
    const r = await push(co.tokens.rep, [
      {
        idempotencyKey: vKey, entityType: 'VISIT',
        payload: { customerId: co.customers.sunrise, scheduledStart: fresh(), purpose: 'Weekly round', checkIn: { locationConsent: true, latitude: 11.56, longitude: 104.92 } },
      },
      { idempotencyKey: key(), entityType: 'VISIT_NOTE', payload: { visitKey: vKey, body: 'Shelf space doubled' } },
      { idempotencyKey: key(), entityType: 'SALES_ORDER', payload: { customerId: co.customers.sunrise, visitKey: vKey, lines: [line(co.products.oil, '2')] } },
      { idempotencyKey: key(), entityType: 'VISIT', payload: { visitKeyIgnored: true, visitId: undefined, checkOut: { outcome: 'ORDER_TAKEN' } } },
    ]);
    const [v, n, o, bad] = r.body.results;
    expect(v).toMatchObject({ status: 'ACCEPTED', result: { visitStatus: 'IN_PROGRESS' } });
    expect(n.status).toBe('ACCEPTED');
    expect(o.status).toBe('ACCEPTED');
    expect(bad.status).toBe('REJECTED');
    const order = (await sql('SELECT visit_id FROM sales_orders WHERE id = $1', [o.entityId]))[0];
    expect(order.visit_id).toBe(v.entityId);
    const visit = (await rep().get(`/sales/visits/${v.entityId}`)).body;
    expect(visit.notes.map((x: { body: string }) => x.body)).toContain('Shelf space doubled');

    const out = await push(co.tokens.rep, [{ idempotencyKey: key(), entityType: 'VISIT', payload: { visitId: v.entityId, checkOut: { outcome: 'ORDER_TAKEN' } } }]);
    expect(out.body.results[0].result.visitStatus).toBe('COMPLETED');

    const orphan = await push(co.tokens.rep, [{ idempotencyKey: key(), entityType: 'VISIT_NOTE', payload: { visitKey: 'never-synced-key', body: 'x' } }]);
    expect(orphan.body.results[0].error.code).toBe('DEPENDENCY_NOT_SYNCED');
  });

  it('queues offline collections for verification like online ones', async () => {
    const r = await push(co.tokens.rep, [
      { idempotencyKey: key(), entityType: 'COLLECTION', payload: { customerId: co.customers.sunrise, amount: '10.00', paymentMethod: 'CASH' } },
    ]);
    expect(r.body.results[0].status).toBe('ACCEPTED');
    expect(r.body.results[0].result.collectionStatus).toBe('PENDING_VERIFICATION');
  });

  it('applies current permissions: a warehouse user cannot sync orders', async () => {
    const r = await push(co.tokens.warehouse, [{ idempotencyKey: key(), entityType: 'SALES_ORDER', payload: { customerId: co.customers.sunrise, lines: [line(co.products.oil, '1')] } }]);
    expect([403, 200]).toContain(r.status);
    if (r.status === 200) expect(r.body.results[0].status).toBe('REJECTED');
  });

  it('shows the device its sync history', async () => {
    const h = await rep().get('/sales/sync/history?deviceId=phone-1');
    expect(h.status).toBe(200);
    expect(h.body.length).toBeGreaterThan(5);
    expect(h.body.every((x: { device_id: string }) => x.device_id === 'phone-1')).toBe(true);
  });
});

describe('Offline sync isolation and entitlements', () => {
  it('keeps idempotency keys and data per company', async () => {
    const k = key();
    const a = await push(co.tokens.rep, [{ idempotencyKey: k, entityType: 'SALES_ORDER', payload: { customerId: co.customers.sunrise, lines: [line(co.products.oil, '1')] } }]);
    expect(a.body.results[0].status).toBe('ACCEPTED');
    // Another company may reuse the same key; it cannot touch company A's customer.
    const b = await push(other.tokens.rep, [{ idempotencyKey: k, entityType: 'SALES_ORDER', payload: { customerId: co.customers.sunrise, lines: [line(other.products.oil, '1')] } }]);
    expect(b.body.results[0].status).toBe('REJECTED');
    const c = await push(other.tokens.rep, [{ idempotencyKey: key(), entityType: 'SALES_ORDER', payload: { customerId: other.customers.sunrise, lines: [line(other.products.oil, '1')] } }]);
    expect(c.body.results[0].status).toBe('ACCEPTED');
    expect((await api.as(other.tokens.rep).get('/sales/sync/history')).body.find((x: { idempotency_key: string; status: string }) => x.idempotency_key === k).status).toBe('REJECTED');
  });

  it('stops syncing when offline ordering is switched off or the subscription expires', async () => {
    const root = await rootApi(app);
    await root.put(`/platform/tenants/${other.tenantId}/modules`, { modules: [{ code: 'SALES_OFFLINE_ORDERING', enabled: false }] });
    const off = await push(other.tokens.rep, [{ idempotencyKey: key(), entityType: 'SALES_ORDER', payload: { customerId: other.customers.sunrise, lines: [line(other.products.oil, '1')] } }]);
    expect(off.status).toBe(402);
    expect(off.body.error.code).toBe('MODULE_NOT_SUBSCRIBED');
    expect((await api.as(other.tokens.rep).get('/sales/sync/bootstrap')).status).toBe(402);
    await root.put(`/platform/tenants/${other.tenantId}/modules`, { modules: ALL_SALES_MODULES.filter((m) => m.startsWith('SALES_')).map((code) => ({ code, enabled: true })) });

    await root.put(`/platform/tenants/${other.tenantId}/subscription`, { status: 'ACTIVE', endsAt: new Date(Date.now() - 86400_000).toISOString(), graceDays: 0 });
    const exp = await push(other.tokens.rep, [{ idempotencyKey: key(), entityType: 'SALES_ORDER', payload: { customerId: other.customers.sunrise, lines: [line(other.products.oil, '1')] } }]);
    expect(exp.status).toBe(402);
    expect(exp.body.error.code).toBe('SUBSCRIPTION_EXPIRED');
    await root.put(`/platform/tenants/${other.tenantId}/subscription`, { status: 'ACTIVE', endsAt: null });
  });
});

describe('Theme Studio', () => {
  it('stores validated tokens and serves them as CSS variables', async () => {
    const admin = api.as(co.tokens.admin);
    expect((await rep().put('/admin/theme', { tokens: { primary: '#000000' } })).status).toBe(403);
    const bad = await admin.put('/admin/theme', { tokens: { primary: 'red; background:url(x)', fontFamily: 'Inter' } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('INVALID_THEME');
    const ok = await admin.put('/admin/theme', { tokens: { primary: '#0a7c42', primaryText: '#fafafa', radius: '12px' }, companyDisplayName: 'Sunrise Trading' });
    expect(ok.status).toBe(200);
    expect(ok.body.cssVariables['--ckh-primary']).toBe('#0a7c42');
    expect(ok.body.cssVariables['--ckh-bg']).toBeTruthy(); // default filled in
    const low = await admin.put('/admin/theme', { tokens: { primary: '#ffff00', primaryText: '#ffffff' } });
    expect(low.body.warnings.length).toBeGreaterThan(0);
    await admin.put('/admin/theme', { tokens: { primary: '#0a7c42' } });

    expect((await rep().get('/theme')).body.cssVariables['--ckh-primary']).toBe('#0a7c42');
    const pub = await new Api(app).get(`/auth/theme?tenantCode=${co.code}`);
    expect(pub.status).toBe(200);
    expect(pub.body.companyDisplayName).toBe('Sunrise Trading');
    expect((await api.as(other.tokens.rep).get('/theme')).body.cssVariables['--ckh-primary']).toBe('#1f6feb');
  });
});

describe('Accounting consistency after offline replay', () => {
  it('books balance and receivables match the sub-ledger once every queued event is replayed', async () => {
    const accountant = api.as(co.tokens.accountant);
    // Verify any collections the replays submitted, so receipts post to the ledger too.
    const pending = (await accountant.get('/sales/collections?status=PENDING_VERIFICATION')).body;
    for (const c of Array.isArray(pending) ? pending : []) await accountant.post(`/sales/collections/${c.id}/verify`, {});
    const r = await accountant.get('/accounting/integrity');
    expect(r.status).toBe(200);
    expect(r.body.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
  });
});
