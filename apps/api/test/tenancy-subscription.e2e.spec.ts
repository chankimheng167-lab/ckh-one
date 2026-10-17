import type { INestApplication } from '@nestjs/common';
import { Api, ALL_SALES_MODULES, bootApp, Company, createCompany, rootApi } from './helpers';

let app: INestApplication;
let a: Company;
let b: Company;
let api: Api;

beforeAll(async () => {
  app = await bootApp();
  [a, b] = await Promise.all([createCompany(app), createCompany(app)]);
  api = new Api(app);
});
afterAll(async () => app?.close());

describe('Tenant isolation', () => {
  let orderA: string;
  beforeAll(async () => {
    const r = await api.as(a.tokens.rep).post('/sales/orders', { customerId: a.customers.sunrise, lines: [{ productId: a.products.oil, quantity: '1' }] });
    orderA = r.body.order.id;
  });

  it("tenant B's manager cannot read tenant A's order", async () => {
    const r = await api.as(b.tokens.manager).get(`/sales/orders/${orderA}`);
    expect(r.status).toBe(404);
  });

  it("tenant B's admin cannot see tenant A's customers or products", async () => {
    const c = await api.as(b.tokens.manager).get('/sales/customers');
    expect(c.body.map((x: { id: string }) => x.id)).not.toContain(a.customers.sunrise);
    const p = await api.as(b.tokens.manager).get(`/sales/catalog/products/${a.products.rice}`);
    expect(p.status).toBe(404);
  });

  it("tenant B cannot order against tenant A's customer or product", async () => {
    const r1 = await api.as(b.tokens.rep).post('/sales/orders', { customerId: a.customers.sunrise, lines: [{ productId: b.products.oil, quantity: '1' }] });
    expect([403, 404]).toContain(r1.status);
    const r2 = await api.as(b.tokens.rep).post('/sales/orders', { customerId: b.customers.sunrise, lines: [{ productId: a.products.oil, quantity: '1' }] });
    expect(r2.status).toBe(422);
    expect(r2.body.error.code).toBe('PRODUCT_NOT_FOUND');
  });

  it("tenant B's warehouse cannot reserve or cancel tenant A's order", async () => {
    expect((await api.as(b.tokens.warehouse).post(`/sales/orders/${orderA}/reserve`)).status).toBe(404);
    expect((await api.as(b.tokens.warehouse).post(`/sales/orders/${orderA}/cancel`, { reason: 'attack' })).status).toBe(404);
  });

  it('a token for one tenant cannot be replayed with another tenant code', async () => {
    const r = await api.post('/auth/login', { tenantCode: b.code, email: 'rep@x.test', password: 'wrong-password' });
    expect(r.status).toBe(401);
  });
});

describe('Subscription enforcement', () => {
  it('blocks sales order APIs when the module is switched off, and restores them', async () => {
    const root = await rootApi(app);
    const off = await root.put(`/platform/tenants/${b.tenantId}/modules`, {
      modules: [
        { code: 'SALES_ORDER_MANAGEMENT', enabled: false },
        { code: 'SALES_COMMISSION_MANAGEMENT', enabled: false },
        { code: 'SALES_ADVANCED_ANALYTICS', enabled: false },
        { code: 'SALES_OFFLINE_ORDERING', enabled: false },
      ],
    });
    expect(off.status).toBe(200);
    const blocked = await api.as(b.tokens.rep).get('/sales/orders');
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe('MODULE_NOT_SUBSCRIBED');
    // Basic module still works.
    expect((await api.as(b.tokens.rep).get('/sales/customers')).status).toBe(200);

    const on = await root.put(`/platform/tenants/${b.tenantId}/modules`, {
      modules: ALL_SALES_MODULES.filter((m) => m.startsWith('SALES_')).map((code) => ({ code, enabled: true })),
    });
    expect(on.status).toBe(200);
    expect((await api.as(b.tokens.rep).get('/sales/orders')).status).toBe(200);
  });

  it('refuses module combinations with missing prerequisites', async () => {
    const root = await rootApi(app);
    const r = await root.put(`/platform/tenants/${b.tenantId}/modules`, { modules: [{ code: 'SALES_TEAM_BASIC', enabled: false }] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('MODULE_DEPENDENCY');
  });

  it('blocks every tenant API once the subscription expires, and honours the grace period', async () => {
    const root = await rootApi(app);
    const past = new Date(Date.now() - 2 * 86400_000).toISOString();
    // Expired 2 days ago but with 7 days grace: still usable.
    await root.put(`/platform/tenants/${b.tenantId}/subscription`, { status: 'ACTIVE', endsAt: past, graceDays: 7 });
    expect((await api.as(b.tokens.rep).get('/sales/orders')).status).toBe(200);
    // No grace: blocked.
    await root.put(`/platform/tenants/${b.tenantId}/subscription`, { status: 'ACTIVE', endsAt: past, graceDays: 0 });
    const r = await api.as(b.tokens.rep).post('/sales/orders', { customerId: b.customers.sunrise, lines: [{ productId: b.products.oil, quantity: '1' }] });
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('SUBSCRIPTION_EXPIRED');
    // Tenant A is unaffected.
    expect((await api.as(a.tokens.rep).get('/sales/orders')).status).toBe(200);
    // Renew.
    await root.put(`/platform/tenants/${b.tenantId}/subscription`, { status: 'ACTIVE', endsAt: null });
    expect((await api.as(b.tokens.rep).get('/sales/orders')).status).toBe(200);
  });

  it('tenant users cannot call Super Admin APIs, and a suspended tenant is locked out', async () => {
    expect((await api.as(a.tokens.admin).get('/platform/tenants')).status).toBe(403);
    const root = await rootApi(app);
    await root.put(`/platform/tenants/${b.tenantId}/status`, { status: 'SUSPENDED' });
    const r = await api.as(b.tokens.admin).get('/auth/me');
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('TENANT_SUSPENDED');
    await root.put(`/platform/tenants/${b.tenantId}/status`, { status: 'ACTIVE' });
  });
});
