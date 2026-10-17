import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { Api, bootApp, Company, createCompany, ownerUrl } from './helpers';

let app: INestApplication;
let co: Company;
let api: Api;

beforeAll(async () => {
  app = await bootApp();
  co = await createCompany(app);
  api = new Api(app);
});
afterAll(async () => app?.close());

const rep = () => api.as(co.tokens.rep);
const line = (productId: string, quantity: string, discountPercent = '0', extra: Record<string, unknown> = {}) => ({ productId, quantity, discountPercent, ...extra });

async function stock(productId: string) {
  const c = new Client({ connectionString: ownerUrl() });
  await c.connect();
  await c.query("SELECT set_config('app.platform_admin','on',false)");
  const r = await c.query('SELECT qty_on_hand, qty_reserved FROM stock_levels WHERE product_id = $1 AND warehouse_id = $2', [productId, co.warehouseId]);
  await c.end();
  return r.rows[0] ?? { qty_on_hand: '0', qty_reserved: '0' };
}

describe('Salesperson creating an order', () => {
  it('prices on the server and ignores client totals', async () => {
    const r = await rep().post('/sales/orders', {
      customerId: co.customers.sunrise,
      lines: [line(co.products.rice, '2'), line(co.products.oil, '4')],
      grandTotal: '0.01', // ignored: not part of the schema
    });
    expect(r.status).toBe(201);
    const o = r.body.order;
    expect(o.status).toBe('DRAFT');
    expect(o.number).toMatch(/^SO-\d{4}-\d{5}$/);
    // rice from the price list (24.00), oil from list price (2.50), VAT 10%
    expect(o.lines[0].unit_price).toBe('24.0000');
    expect(o.lines[0].price_source).toBe('PRICE_LIST');
    expect(o.lines[1].unit_price).toBe('2.5000');
    expect(o.subtotal).toBe('58.00');
    expect(o.tax_total).toBe('5.80');
    expect(o.grand_total).toBe('63.80');
  });

  it('rejects a client-supplied price that differs from the server price', async () => {
    const r = await rep().post('/sales/orders', { customerId: co.customers.sunrise, lines: [line(co.products.rice, '1', '0', { unitPrice: '1.00' })] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('PRICE_MISMATCH');
  });

  it('is idempotent on clientReference', async () => {
    const body = { clientReference: 'device-1-order-0001', customerId: co.customers.sunrise, lines: [line(co.products.oil, '1')] };
    const a = await rep().post('/sales/orders', body);
    const b = await rep().post('/sales/orders', body);
    expect(a.status).toBe(201);
    expect(b.body.replayed).toBe(true);
    expect(b.body.order.id).toBe(a.body.order.id);
  });

  it('blocks customers not assigned to the rep', async () => {
    const r = await rep().post('/sales/orders', { customerId: co.customers.other, lines: [line(co.products.oil, '1')] });
    expect(r.status).toBe(403);
    const list = await rep().get('/sales/customers');
    const ids = list.body.map((c: { id: string }) => c.id);
    expect(ids).toEqual(expect.arrayContaining([co.customers.sunrise, co.customers.lucky]));
    expect(ids).not.toContain(co.customers.other);
  });

  it('auto-approves an order within limits and records history', async () => {
    const created = await rep().post('/sales/orders', { customerId: co.customers.sunrise, lines: [line(co.products.oil, '2', '5')] });
    const sub = await rep().post(`/sales/orders/${created.body.order.id}/submit`);
    expect(sub.status).toBe(200);
    expect(sub.body.order.status).toBe('APPROVED');
    expect(sub.body.order.history.map((h: { to_status: string }) => h.to_status)).toEqual(['DRAFT', 'SUBMITTED', 'APPROVED']);
  });

  it('does not allow editing after submission', async () => {
    const created = await rep().post('/sales/orders', { customerId: co.customers.sunrise, lines: [line(co.products.oil, '1')] });
    await rep().post(`/sales/orders/${created.body.order.id}/submit`);
    const upd = await rep().put(`/sales/orders/${created.body.order.id}`, { version: 99, lines: [line(co.products.oil, '5')] });
    expect(upd.status).toBe(409);
    expect(upd.body.error.code).toBe('ORDER_NOT_EDITABLE');
  });
});

describe('Discount approval', () => {
  async function submitWithDiscount(discount: string) {
    const created = await rep().post('/sales/orders', { customerId: co.customers.sunrise, lines: [line(co.products.oil, '2', discount)] });
    const sub = await rep().post(`/sales/orders/${created.body.order.id}/submit`);
    return sub.body.order;
  }

  it('routes 8% to a supervisor; the rep cannot approve their own order', async () => {
    const o = await submitWithDiscount('8');
    expect(o.status).toBe('PENDING_APPROVAL');
    expect(o.approvals).toHaveLength(1);
    expect(o.approvals[0]).toMatchObject({ reason: 'DISCOUNT', required_level: 1 });

    const self = await rep().post(`/sales/orders/${o.id}/approve`);
    expect(self.status).toBe(403);

    const pending = await api.as(co.tokens.supervisor).get('/sales/orders/pending-approvals');
    expect(pending.body.map((p: { id: string }) => p.id)).toContain(o.id);

    const ok = await api.as(co.tokens.supervisor).post(`/sales/orders/${o.id}/approve`, { comment: 'ok for loyal customer' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('APPROVED');
    expect(ok.body.approvals[0].status).toBe('APPROVED');
  });

  it('routes 15% to a manager; a supervisor is refused', async () => {
    const o = await submitWithDiscount('15');
    expect(o.approvals[0].required_level).toBe(2);
    const sup = await api.as(co.tokens.supervisor).post(`/sales/orders/${o.id}/approve`);
    expect(sup.status).toBe(403);
    const mgr = await api.as(co.tokens.manager).post(`/sales/orders/${o.id}/approve`);
    expect(mgr.body.status).toBe('APPROVED');
  });

  it('rejection sends the order back to the rep for revision', async () => {
    const o = await submitWithDiscount('9');
    const rej = await api.as(co.tokens.supervisor).post(`/sales/orders/${o.id}/reject`, { comment: 'Too much discount' });
    expect(rej.body.status).toBe('REJECTED');
    const rev = await rep().post(`/sales/orders/${o.id}/revise`);
    expect(rev.body.status).toBe('DRAFT');
    const upd = await rep().put(`/sales/orders/${o.id}`, { version: rev.body.version, lines: [line(co.products.oil, '2', '5')] });
    expect(upd.status).toBe(200);
    const sub = await rep().post(`/sales/orders/${o.id}/submit`);
    expect(sub.body.order.status).toBe('APPROVED');
  });

  it('respects tenant-configured limits', async () => {
    const admin = api.as(co.tokens.admin);
    const put = await admin.put('/admin/sales/settings', {
      approvalLimits: { repMaxDiscountPercent: '10', supervisorMaxDiscountPercent: '12', managerMaxDiscountPercent: '25', managerOrderAmountThreshold: null, directorOrderAmountThreshold: null },
    });
    expect(put.status).toBe(200);
    const o = await submitWithDiscount('9');
    expect(o.status).toBe('APPROVED');
    await admin.put('/admin/sales/settings', {
      approvalLimits: { repMaxDiscountPercent: '5', supervisorMaxDiscountPercent: '10', managerMaxDiscountPercent: '20', managerOrderAmountThreshold: null, directorOrderAmountThreshold: null },
    });
  });

  it('sends credit-limit breaches to the accountant, not to sales managers', async () => {
    const created = await rep().post('/sales/orders', { customerId: co.customers.lucky, lines: [line(co.products.rice, '5')] }); // > $100 limit
    const sub = await rep().post(`/sales/orders/${created.body.order.id}/submit`);
    expect(sub.body.order.status).toBe('PENDING_APPROVAL');
    expect(sub.body.requirements[0].reason).toBe('CREDIT_LIMIT');
    const mgr = await api.as(co.tokens.manager).post(`/sales/orders/${created.body.order.id}/approve`);
    expect(mgr.status).toBe(403);
    const acc = await api.as(co.tokens.accountant).post(`/sales/orders/${created.body.order.id}/approve`);
    expect(acc.body.status).toBe('APPROVED');
  });
});

describe('Stock reservation', () => {
  it('reserves stock, backorders shortfalls, and releases on cancel', async () => {
    const before = await stock(co.products.rice);
    const created = await rep().post('/sales/orders', {
      customerId: co.customers.sunrise,
      lines: [line(co.products.rice, '10'), line(co.products.water, '3')], // water has no stock
    });
    const sub = await rep().post(`/sales/orders/${created.body.order.id}/submit`);
    expect(sub.body.shortages.map((s: { sku: string }) => s.sku)).toEqual(['WATER']);
    expect(sub.body.order.status).toBe('APPROVED');

    // Reps cannot reserve.
    expect((await rep().post(`/sales/orders/${created.body.order.id}/reserve`)).status).toBe(403);

    const res = await api.as(co.tokens.warehouse).post(`/sales/orders/${created.body.order.id}/reserve`);
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('STOCK_RESERVED');
    expect(res.body.order.has_backorder).toBe(true);
    const [riceLine, waterLine] = res.body.order.lines;
    expect(riceLine.qty_reserved).toBe('10.0000');
    expect(waterLine.qty_backordered).toBe('3.0000');

    const during = await stock(co.products.rice);
    expect(Number(during.qty_reserved) - Number(before.qty_reserved)).toBe(10);

    const cancel = await api.as(co.tokens.warehouse).post(`/sales/orders/${created.body.order.id}/cancel`, { reason: 'Customer withdrew' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('CANCELLED');
    const after = await stock(co.products.rice);
    expect(after.qty_reserved).toBe(before.qty_reserved);
  });

  it('never reserves more than is on hand, even under concurrency', async () => {
    const { qty_on_hand, qty_reserved } = await stock(co.products.oil);
    const free = Number(qty_on_hand) - Number(qty_reserved);
    const qty = String(Math.ceil(free * 0.6));
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const c = await rep().post('/sales/orders', { customerId: co.customers.sunrise, lines: [line(co.products.oil, qty)] });
      await rep().post(`/sales/orders/${c.body.order.id}/submit`);
      ids.push(c.body.order.id);
    }
    const wh = api.as(co.tokens.warehouse);
    const results = await Promise.all(ids.map((id) => wh.post(`/sales/orders/${id}/reserve`)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const reservedTotal = results.reduce((s, r) => s + Number(r.body.order.lines[0].qty_reserved), 0);
    expect(reservedTotal).toBeLessThanOrEqual(free);
    expect(results.some((r) => r.body.order.has_backorder)).toBe(true);
    const end = await stock(co.products.oil);
    expect(Number(end.qty_reserved)).toBeLessThanOrEqual(Number(end.qty_on_hand));
  });
});
