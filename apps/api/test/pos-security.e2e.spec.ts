import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { IS_PUBLIC, REQUIRED_MODULES, REQUIRED_PERMISSIONS } from '../src/common/auth-context';
import { Api, bootApp } from './helpers';
import { createPosCompany, key, PosCompany, sql, SUPERVISOR_PIN } from './pos-helpers';

let app: INestApplication;
let a: PosCompany;
let b: PosCompany;
let api: Api;

beforeAll(async () => {
  app = await bootApp();
  [a, b] = [await createPosCompany(app), await createPosCompany(app)];
  api = new Api(app);
});
afterAll(async () => app?.close());

const sale = (co: PosCompany, over: Record<string, unknown> = {}) => ({
  clientSaleId: key(),
  registerId: co.pos.registerId,
  lines: [{ productId: co.products.oil, quantity: '1' }],
  payments: [{ methodId: co.pos.methods.CASH, amount: '5' }],
  ...over,
});

async function activate(co: PosCompany) {
  const r = await api.as(co.pos.manager).post('/pos/devices/activate', { registerId: co.pos.registerId, deviceKey: `pc-${randomUUID()}`, name: 'Till PC' });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  await sql(`UPDATE pos_devices SET created_at = now() - interval '1 day' WHERE id = $1`, [r.body.deviceId]);
  return { ...r.body, header: { 'X-POS-Device': `${r.body.deviceId}:${r.body.deviceSecret}` } };
}

describe('POS route protection', () => {
  it('every POS route needs the POS licence and a named permission (or is deliberately public)', async () => {
    const { AppModule } = await import('../src/app.module');
    const controllers: any[] = Reflect.getMetadata('controllers', AppModule);
    const pos = controllers.filter((C) => /^Pos/.test(C.name));
    const missing: string[] = [];
    const publicRoutes: string[] = [];
    let routes = 0;
    for (const C of pos) {
      for (const name of Object.getOwnPropertyNames(C.prototype)) {
        const h = C.prototype[name];
        if (name === 'constructor' || typeof h !== 'function' || Reflect.getMetadata('path', h) === undefined) continue;
        routes++;
        if (Reflect.getMetadata(IS_PUBLIC, h)) {
          publicRoutes.push(`${C.name}.${name}`);
          continue;
        }
        const perms = Reflect.getMetadata(REQUIRED_PERMISSIONS, h) ?? Reflect.getMetadata(REQUIRED_PERMISSIONS, C);
        const mods = [...(Reflect.getMetadata(REQUIRED_MODULES, C) ?? []), ...(Reflect.getMetadata(REQUIRED_MODULES, h) ?? [])];
        if (!perms?.length || !mods.includes('POS_SALES')) missing.push(`${C.name}.${name}`);
      }
    }
    expect(routes).toBeGreaterThan(50);
    expect(missing).toEqual([]);
    // Only the licence verification key is public: it is meant to be embedded in installers.
    expect(publicRoutes).toEqual(['PosDevicesController.publicKey']);
  });

  it('a cashier is refused every manager and supervisor action', async () => {
    const c = api.as(a.pos.cashier);
    const s = (await c.post('/pos/sales', sale(a, { payments: [{ methodId: a.pos.methods.KHQR, amount: '2.75', reference: `QR-${randomUUID()}` }] }))).body.sale;
    const device = await activate(a);
    const calls: [string, () => Promise<{ status: number }>][] = [
      ['change POS settings', () => c.put('/pos/admin/settings', { cashierMaxDiscountPercent: '100' })],
      ['add a register', () => c.post('/pos/admin/registers', { code: 'Z', name: 'Z', branchId: a.branchId, warehouseId: a.warehouseId })],
      ['change a payment method', () => c.put(`/pos/admin/payment-methods/${a.pos.methods.KHQR}`, { requiresVerification: false })],
      ['assign staff branches', () => c.put(`/pos/admin/staff/${a.pos.cashierId}/branches`, { branchIds: [a.branchId] })],
      ['verify a payment', () => c.post(`/pos/payments/${s.payments[0].id}/verify`, { decision: 'CONFIRM' })],
      ['list payments to verify', () => c.get('/pos/payments/pending')],
      ['review a flagged sale', () => c.post(`/pos/sales/${s.id}/review`, { notes: 'ok' })],
      ['approve a shift', () => c.post(`/pos/shifts/${a.pos.shiftId}/approve`, { notes: 'ok' })],
      ['see reconciliation', () => c.get('/pos/reconciliation')],
      ['see the daily report', () => c.get('/pos/reports/daily')],
      ['activate a device', () => c.post('/pos/devices/activate', { registerId: a.pos.registerId, deviceKey: `pc-${randomUUID()}`, name: 'x' })],
      ['list devices', () => c.get('/pos/devices')],
      ['revoke a device', () => c.post(`/pos/devices/${device.deviceId}/revoke`, {})],
      ['see sync results', () => c.get('/pos/sync/events')],
    ];
    const allowed: string[] = [];
    for (const [what, call] of calls) if ((await call()).status !== 403) allowed.push(what);
    expect(allowed).toEqual([]);
    // Nothing changed behind the refusals.
    expect((await sql(`SELECT status FROM pos_devices WHERE id = $1`, [device.deviceId]))[0].status).toBe('ACTIVE');
    expect((await sql(`SELECT status FROM pos_sale_payments WHERE id = $1`, [s.payments[0].id]))[0].status).toBe('PENDING_VERIFICATION');
  });

  it('a manager limited to some branches sees and revokes only devices there', async () => {
    const device = await activate(a);
    const role = await sql<{ id: string }>(`SELECT id FROM roles WHERE tenant_id = $1 AND code = 'POS_SUPERVISOR'`, [a.tenantId]);
    await sql(`INSERT INTO role_permissions (tenant_id, role_id, permission_code) VALUES ($1, $2, 'pos.devices.manage') ON CONFLICT DO NOTHING`, [a.tenantId, role[0].id]);
    const login = await api.post('/auth/login', { tenantCode: a.code, email: 'possup@x.test', password: 'Password!2026' });
    const sup = api.as(login.body.accessToken);
    expect((await sup.get('/pos/devices')).body.some((d: any) => d.id === device.deviceId)).toBe(true);
    await api.as(a.tokens.admin).put(`/pos/admin/staff/${a.pos.supervisorId}/branches`, { branchIds: [] });
    try {
      expect((await sup.get('/pos/devices')).body).toEqual([]);
      expect((await sup.get('/pos/sync/events')).body).toEqual([]);
      expect((await sup.post(`/pos/devices/${device.deviceId}/revoke`, {})).status).toBe(403);
    } finally {
      await api.as(a.tokens.admin).put(`/pos/admin/staff/${a.pos.supervisorId}/branches`, { branchIds: [a.branchId] });
      await sql(`DELETE FROM role_permissions WHERE role_id = $1 AND permission_code = 'pos.devices.manage'`, [role[0].id]);
    }
  });
});

describe('POS company isolation', () => {
  it('another company cannot read, verify, settle, review, return, print or revoke anything of ours', async () => {
    const s = (await api.as(a.pos.cashier).post('/pos/sales', sale(a, { payments: [{ methodId: a.pos.methods.KHQR, amount: '2.75', reference: `QR-${randomUUID()}` }] }))).body.sale;
    const device = await activate(a);
    const mgr = api.as(b.pos.manager);
    const tries: [string, () => Promise<{ status: number }>][] = [
      ['read the sale', () => mgr.get(`/pos/sales/${s.id}`)],
      ['print its receipt', () => mgr.post(`/pos/sales/${s.id}/receipt`, { format: 'text' })],
      ['verify its payment', () => mgr.post(`/pos/payments/${s.payments[0].id}/verify`, { decision: 'CONFIRM' })],
      ['settle it', () => mgr.post(`/pos/sales/${s.id}/settle`, { clientPaymentId: key(), registerId: b.pos.registerId, methodId: b.pos.methods.CASH, amount: '5' })],
      ['review it', () => mgr.post(`/pos/sales/${s.id}/review`, { notes: 'x' })],
      ['see what can be returned', () => mgr.get(`/pos/sales/${s.id}/returnable`)],
      ['read our shift', () => mgr.get(`/pos/shifts/${a.pos.shiftId}`)],
      ['revoke our device', () => mgr.post(`/pos/devices/${device.deviceId}/revoke`, {})],
    ];
    const leaked: string[] = [];
    for (const [what, call] of tries) {
      const r = await call();
      if (r.status !== 404) leaked.push(`${what}: ${r.status}`);
    }
    expect(leaked).toEqual([]);
    expect((await mgr.get('/pos/devices')).body.some((d: any) => d.id === device.deviceId)).toBe(false);
    expect((await mgr.get('/pos/payments/pending')).body.some((p: any) => p.id === s.payments[0].id)).toBe(false);
    const ret = await mgr.post('/pos/returns', {
      clientReturnId: key(), saleId: s.id, registerId: b.pos.registerId, reason: 'x',
      lines: [{ saleLineId: s.lines[0].id, quantity: '1' }], refunds: [{ methodId: b.pos.methods.CASH, amount: '1' }],
    });
    expect([404, 422]).toContain(ret.status);
    expect((await sql(`SELECT count(*)::int AS n FROM pos_returns WHERE sale_id = $1`, [s.id]))[0].n).toBe(0);
  });

  it('a device secret only works in its own company', async () => {
    const device = await activate(a);
    const r = await api.as(b.pos.cashier).post('/pos/devices/heartbeat', {}, device.header);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('DEVICE_UNKNOWN');
    const up = await api.as(b.pos.cashier).post('/pos/sync', { events: [] }, device.header);
    expect(up.status).not.toBe(200);
  });
});

describe('POS input hardening', () => {
  it('refuses malformed quantities, amounts and oversized carts without recording anything', async () => {
    const c = api.as(a.pos.cashier);
    const before = (await sql(`SELECT count(*)::int AS n FROM pos_sales WHERE tenant_id = $1`, [a.tenantId]))[0].n;
    const bad = [
      sale(a, { lines: [{ productId: a.products.oil, quantity: '-1' }] }),
      sale(a, { lines: [{ productId: a.products.oil, quantity: '0' }] }),
      sale(a, { lines: [{ productId: a.products.oil, quantity: '1e3' }] }),
      sale(a, { lines: [{ productId: a.products.oil, quantity: 'NaN' }] }),
      sale(a, { lines: [{ productId: a.products.oil, quantity: '1', discountPercent: '-5' }] }),
      sale(a, { payments: [{ methodId: a.pos.methods.CASH, amount: '-5' }] }),
      sale(a, { payments: [{ methodId: a.pos.methods.CASH, amount: '5.001' }] }),
      sale(a, { lines: Array.from({ length: 501 }, () => ({ productId: a.products.oil, quantity: '1' })) }),
      sale(a, { clientSaleId: "x'; DROP TABLE pos_sales; --" }),
      sale(a, { lines: [{ productId: 'not-a-uuid', quantity: '1' }] }),
    ];
    const codes: number[] = [];
    for (const body of bad) codes.push((await c.post('/pos/sales', body)).status);
    // 400: rejected by validation; 422: rejected by the business rules. Never recorded.
    expect(codes.map((s) => s === 400 || s === 422)).toEqual(bad.map(() => true));
    expect((await sql(`SELECT count(*)::int AS n FROM pos_sales WHERE tenant_id = $1`, [a.tenantId]))[0].n).toBe(before);
  });

  it('never stores a card number, in any reference field', async () => {
    const pan = '4111 1111 1111 1111';
    const c = api.as(a.pos.cashier);
    const viaRef = await c.post('/pos/sales', sale(a, { payments: [{ methodId: a.pos.methods.CARD, amount: '2.75', reference: pan }] }));
    const viaProvider = await c.post('/pos/sales', sale(a, { payments: [{ methodId: a.pos.methods.CARD, amount: '2.75', reference: 'APP-1', providerTransactionId: pan }] }));
    expect([viaRef.body.error?.code, viaProvider.body.error?.code]).toEqual(['CARD_NUMBER_NOT_ALLOWED', 'CARD_NUMBER_NOT_ALLOWED']);
    const s = (await c.post('/pos/sales', sale(a, { payments: [{ methodId: a.pos.methods.KHQR, amount: '2.75', reference: `QR-${randomUUID()}` }] }))).body.sale;
    const v = await api.as(a.pos.supervisor).post(`/pos/payments/${s.payments[0].id}/verify`, { decision: 'CONFIRM', providerTransactionId: pan.replace(/ /g, '') });
    expect(v.body.error?.code).toBe('CARD_NUMBER_NOT_ALLOWED');
    const stored = await sql(
      `SELECT count(*)::int AS n FROM pos_sale_payments WHERE tenant_id = $1 AND (regexp_replace(coalesce(reference,'') || coalesce(provider_transaction_id,''), '\\D', '', 'g') LIKE '%4111111111111111%')`,
      [a.tenantId],
    );
    expect(stored[0].n).toBe(0);
  });

  it('does not accept a supervisor PIN by guessing: wrong PINs are refused and audited approvals name the approver', async () => {
    const c = api.as(a.pos.cashier);
    const wrong = await c.post('/pos/sales', sale(a, { lines: [{ productId: a.products.oil, quantity: '1', discountPercent: '50' }], approval: { userId: a.pos.supervisorId, pin: '0000' } }));
    expect(wrong.status).toBe(403);
    const ok = await c.post('/pos/sales', sale(a, { lines: [{ productId: a.products.oil, quantity: '1', discountPercent: '20' }], payments: [{ methodId: a.pos.methods.CASH, amount: '5' }], approval: { userId: a.pos.supervisorId, pin: SUPERVISOR_PIN } }));
    expect(ok.status).toBe(201);
    expect((await sql('SELECT discount_approved_by FROM pos_sales WHERE id = $1', [ok.body.sale.id]))[0].discount_approved_by).toBe(a.pos.supervisorId);
  });
});

describe('POS audit trail', () => {
  it('records who did each sensitive action', async () => {
    const actions = (await sql<{ action: string; actor_id: string }>(`SELECT action, actor_id FROM audit_log WHERE tenant_id = $1`, [a.tenantId]));
    const seen = new Set(actions.map((x) => x.action));
    for (const act of ['POS_SHIFT_OPENED', 'POS_SALE_COMPLETED', 'POS_DEVICE_ACTIVATED', 'POS_STAFF_BRANCHES_SET', 'POS_PIN_SET']) expect(seen).toContain(act);
    expect(actions.filter((x) => x.action.startsWith('POS_')).every((x) => !!x.actor_id)).toBe(true);
  });
});
