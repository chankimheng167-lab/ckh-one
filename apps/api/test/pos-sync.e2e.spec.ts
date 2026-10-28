import type { INestApplication } from '@nestjs/common';
import { createPublicKey, verify } from 'crypto';
import { randomUUID } from 'crypto';
import { Api, bootApp } from './helpers';
import { createPosCompany, key, PosCompany, sql, stockOf } from './pos-helpers';

let app: INestApplication;
let co: PosCompany;
let api: Api;
let device: { deviceId: string; deviceSecret: string; license: { token: string; expiresAt: string }; publicKey: string };
let cashierId: string;

beforeAll(async () => {
  app = await bootApp();
  co = await createPosCompany(app);
  api = new Api(app);
  cashierId = co.pos.cashierId;
});
afterAll(async () => app?.close());

const manager = () => api.as(co.pos.manager);
const cashier = () => api.as(co.pos.cashier);
const header = (d = device) => ({ 'X-POS-Device': `${d.deviceId}:${d.deviceSecret}` });

/** Checks a licence the way the Windows app does: Ed25519 signature over "ckhpos1.<payload>". */
function check(token: string, publicKey: string) {
  const [p, body, sig] = token.split('.');
  const ok = verify(null, Buffer.from(`${p}.${body}`), createPublicKey(publicKey), Buffer.from(sig, 'base64url'));
  return { ok, payload: JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) };
}

function event(over: Record<string, any> = {}, sale: Record<string, any> = {}) {
  return {
    idempotencyKey: `evt-${randomUUID()}`,
    type: 'SALE',
    userId: cashierId,
    clientCreatedAt: new Date(Date.now() - 60_000).toISOString(),
    deviceTotal: '5.50',
    sale: {
      clientSaleId: key(),
      registerId: co.pos.registerId,
      lines: [{ productId: co.products.oil, quantity: '2', unitPrice: '2.5000' }],
      payments: [{ methodId: co.pos.methods.CASH, amount: '10.00' }],
      ...sale,
    },
    ...over,
  };
}

describe('POS devices, offline licences and offline sync', () => {
  it('activates a device once, within the plan limit, with a signed licence', async () => {
    const body = { registerId: co.pos.registerId, deviceKey: `pc-${randomUUID()}`, name: 'Front till PC', platform: 'win32', appVersion: '0.1.0' };
    expect((await cashier().post('/pos/devices/activate', body)).status).toBe(403);
    const r = await manager().post('/pos/devices/activate', body);
    expect(r.status).toBe(201);
    device = r.body;
    expect(device.deviceSecret.length).toBeGreaterThan(30);
    const stored = await sql('SELECT secret_hash FROM pos_devices WHERE id = $1', [device.deviceId]);
    expect(stored[0].secret_hash).not.toContain(device.deviceSecret);

    const lic = check(device.license.token, device.publicKey);
    expect(lic.ok).toBe(true);
    expect(lic.payload).toMatchObject({ deviceId: device.deviceId, registerId: co.pos.registerId, offlineMethods: [co.pos.methods.CASH] });
    const hours = (new Date(lic.payload.expiresAt).getTime() - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(71);
    expect(hours).toBeLessThanOrEqual(72);
    // A tampered licence fails the signature check.
    const [p, b, s] = device.license.token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...lic.payload, expiresAt: '2099-01-01T00:00:00Z' })).toString('base64url');
    expect(check(`${p}.${forged}.${s}`, device.publicKey).ok).toBe(false);
    void b;

    // Anyone can fetch the verification key (installers embed it); it is the one licences verify with.
    const pub = await api.get('/pos/license/public-key');
    expect(pub.status).toBe(200);
    expect(pub.body.publicKey).toBe(device.publicKey);

    expect((await manager().post('/pos/devices/activate', body)).body.error.code).toBe('DEVICE_ALREADY_ACTIVE');
    await sql('INSERT INTO pos_licenses (tenant_id, max_devices) VALUES ($1, 1) ON CONFLICT (tenant_id) DO UPDATE SET max_devices = 1', [co.tenantId]);
    const over = await manager().post('/pos/devices/activate', { ...body, deviceKey: `pc-${randomUUID()}` });
    expect(over.status).toBe(403);
    expect(over.body.error.code).toBe('LICENSE_LIMIT_REACHED');
    await sql('UPDATE pos_licenses SET max_devices = NULL WHERE tenant_id = $1', [co.tenantId]);
  });

  it('licence never outlives the subscription', async () => {
    const until = new Date(Date.now() + 5 * 3600_000).toISOString();
    await sql(`UPDATE tenant_modules SET ends_at = $2 WHERE tenant_id = $1 AND module_code = 'POS_SALES'`, [co.tenantId, until]);
    try {
      const r = await cashier().post('/pos/devices/heartbeat', { appVersion: '0.1.1' }, header());
      expect(r.status).toBe(200);
      expect(new Date(r.body.license.expiresAt).getTime()).toBe(new Date(until).getTime());
    } finally {
      await sql(`UPDATE tenant_modules SET ends_at = NULL WHERE tenant_id = $1 AND module_code = 'POS_SALES'`, [co.tenantId]);
    }
    const r2 = await cashier().post('/pos/devices/heartbeat', {}, header());
    expect(check(r2.body.license.token, r2.body.publicKey).ok).toBe(true);
  });

  it('device calls need the device secret', async () => {
    expect((await cashier().post('/pos/devices/heartbeat', {})).body.error.code).toBe('DEVICE_REQUIRED');
    const wrong = await cashier().post('/pos/devices/heartbeat', {}, header({ ...device, deviceSecret: 'x'.repeat(43) }));
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('DEVICE_UNKNOWN');
  });

  it('gives the device a catalogue to sell from offline', async () => {
    const r = await cashier().get('/pos/sync/bootstrap', header());
    expect(r.status).toBe(200);
    const oil = r.body.products.find((p: any) => p.id === co.products.oil);
    expect(oil).toMatchObject({ price: '2.5000' });
    expect(Number(oil.tax_rate_percent)).toBe(10);
    expect(r.body.methods.map((m: any) => m.kind)).toEqual(['CASH']);
    expect(r.body.register.id).toBe(co.pos.registerId);
  });

  it('replays an offline cash sale once, at the time it was made', async () => {
    // The till was activated yesterday (sales cannot predate activation).
    await sql(`UPDATE pos_devices SET created_at = now() - interval '1 day' WHERE id = $1`, [device.deviceId]);
    const before = Number(await stockOf(co.warehouseId, co.products.oil));
    const e = event();
    const r = await cashier().post('/pos/sync', { events: [e] }, header());
    expect(r.status).toBe(200);
    const res = r.body.results[0];
    expect(res.status).toBe('ACCEPTED');
    expect(res.grandTotal).toBe('5.50');
    const sale = (await cashier().get(`/pos/sales/${res.saleId}`)).body;
    expect(sale).toMatchObject({ is_offline: true, device_id: device.deviceId, change_due: '4.50' });
    expect(new Date(sale.sold_at).toISOString()).toBe(new Date(e.clientCreatedAt).toISOString());
    expect(Number(await stockOf(co.warehouseId, co.products.oil))).toBe(before - 2);

    const again = await cashier().post('/pos/sync', { events: [e] }, header());
    expect(again.body.results[0]).toMatchObject({ status: 'ACCEPTED', saleId: res.saleId, replayed: true });
    const changed = await cashier().post('/pos/sync', { events: [{ ...e, deviceTotal: '1.00' }] }, header());
    expect(changed.body.results[0]).toMatchObject({ status: 'CONFLICT', error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect((await sql('SELECT count(*)::int AS n FROM pos_sales WHERE client_sale_id = $1', [e.sale.clientSaleId]))[0].n).toBe(1);
  });

  it('keeps what the customer paid at an old price, and flags it for review', async () => {
    const r = await cashier().post('/pos/sync', { events: [event({ deviceTotal: '4.40' }, { lines: [{ productId: co.products.oil, quantity: '2', unitPrice: '2.0000' }] })] }, header());
    const res = r.body.results[0];
    expect(res.status).toBe('ACCEPTED_WITH_CHANGES');
    expect(res.grandTotal).toBe('4.40');
    expect(res.reviewReasons.map((x: any) => x.code)).toContain('PRICE_VARIANCE');
    const sale = (await cashier().get(`/pos/sales/${res.saleId}`)).body;
    expect(sale.review_status).toBe('NEEDS_REVIEW');
  });

  it('refuses offline sales the device was not allowed to make, and records why', async () => {
    const qr = event({}, { payments: [{ methodId: co.pos.methods.KHQR, amount: '5.50', reference: 'KHQR-OFF-1' }] });
    const other = event({ userId: co.pos.supervisorId });
    const early = event({ clientCreatedAt: new Date(Date.now() - 30 * 86400_000).toISOString() });
    const future = event({ clientCreatedAt: new Date(Date.now() + 3600_000).toISOString() });
    const r = await cashier().post('/pos/sync', { events: [qr, other, early, future] }, header());
    expect(r.body.results.map((x: any) => [x.status, x.error?.code])).toEqual([
      ['REJECTED', 'OFFLINE_PAYMENT_NOT_ALLOWED'],
      ['REJECTED', 'FORBIDDEN'],
      ['REJECTED', 'OUTSIDE_OFFLINE_LICENSE'],
      ['REJECTED', 'CLOCK_AHEAD'],
    ]);
    const ev = await manager().get(`/pos/sync/events?deviceId=${device.deviceId}&status=REJECTED`);
    expect(ev.body.length).toBe(4);
    expect((await sql('SELECT count(*)::int AS n FROM pos_sales WHERE client_sale_id = $1', [qr.sale.clientSaleId]))[0].n).toBe(0);
  });

  it('a revoked device can no longer check in or upload', async () => {
    const list = await manager().get('/pos/devices');
    expect(list.body.find((d: any) => d.id === device.deviceId)).toMatchObject({ status: 'ACTIVE', synced_events: 6, refused_events: 4 });
    expect((await manager().post(`/pos/devices/${device.deviceId}/revoke`, {})).status).toBe(200);
    const hb = await cashier().post('/pos/devices/heartbeat', {}, header());
    expect(hb.status).toBe(403);
    expect(hb.body.error.code).toBe('DEVICE_REVOKED');
    expect((await cashier().post('/pos/sync', { events: [event()] }, header())).body.error.code).toBe('DEVICE_REVOKED');
  });
});
