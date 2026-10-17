import type { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { Api, bootApp, Company, createCompany, localToday } from './helpers';

let app: INestApplication;
let co: Company;
let api: Api;
const today = localToday();

const rep = () => api.as(co.tokens.rep);
const sup = () => api.as(co.tokens.supervisor);
const mgr = () => api.as(co.tokens.manager);
const wh = () => api.as(co.tokens.warehouse);
const acct = () => api.as(co.tokens.accountant);
const line = (productId: string, quantity: string, discountPercent = '0') => ({ productId, quantity, discountPercent });

async function invoiced(token: string, customerId: string, lines: ReturnType<typeof line>[]) {
  const a = api.as(token);
  const o = (await a.post('/sales/orders', { customerId, lines })).body.order;
  const s = (await a.post(`/sales/orders/${o.id}/submit`)).body.order;
  if (s.status === 'PENDING_APPROVAL') await mgr().post(`/sales/orders/${o.id}/approve`, { comment: 'ok' });
  await wh().post(`/sales/orders/${o.id}/reserve`);
  await wh().post(`/sales/orders/${o.id}/start-picking`);
  await wh().post(`/sales/orders/${o.id}/pack`);
  const dn = await wh().post(`/sales/orders/${o.id}/dispatch`);
  await wh().post(`/sales/deliveries/${dn.body.id}/confirm`, { receivedByName: 'x' });
  const inv = await acct().post(`/sales/orders/${o.id}/invoice`);
  expect(inv.status).toBe(201);
  return { order: (await a.get(`/sales/orders/${o.id}`)).body, invoice: inv.body };
}

const binary = (r: any) =>
  r.buffer(true).parse((res: any, cb: (e: Error | null, b: Buffer) => void) => {
    const d: Buffer[] = [];
    res.on('data', (c: Buffer) => d.push(c));
    res.on('end', () => cb(null, Buffer.concat(d)));
  });

beforeAll(async () => {
  app = await bootApp();
  co = await createCompany(app);
  api = new Api(app);

  // Rep 1: 10 rice (240) with 5% discount → 228 net; returns 1 bag later. Rep 2: 4 oil = 10 net.
  const a = await invoiced(co.tokens.rep, co.customers.sunrise, [line(co.products.rice, '10', '5')]);
  const ret = await rep().post('/sales/returns', { orderId: a.order.id, reason: 'Torn', lines: [{ orderLineId: a.order.lines[0].id, quantity: '1', restock: true }] });
  if (ret.status !== 201) throw new Error(`return ${ret.status} ${JSON.stringify(ret.body)}`);
  await wh().post(`/sales/returns/${ret.body.id}/receive`);
  await invoiced(co.tokens.rep2, co.customers.other, [line(co.products.oil, '4')]);

  // A pending draft, a quotation, a visit and a target for the other reports.
  await rep().post('/sales/orders', { customerId: co.customers.lucky, lines: [line(co.products.oil, '1')] });
  const q = await rep().post('/sales/quotations', { customerId: co.customers.sunrise, lines: [line(co.products.oil, '2')] });
  await rep().post(`/sales/quotations/${q.body.id}/convert`);
  const v = await rep().post('/sales/visits', { customerId: co.customers.sunrise, scheduledStart: new Date().toISOString() });
  await rep().post(`/sales/visits/${v.body.id}/check-in`, { locationConsent: true, latitude: 11.56, longitude: 104.92 });
  await rep().post(`/sales/visits/${v.body.id}/check-out`, { outcome: 'ORDER_TAKEN' });
  await mgr().post('/sales/targets', { scope: 'REP', salesRepId: co.repId, periodType: 'MONTH', periodStart: `${today.slice(0, 7)}-01`, metric: 'NET_SALES', targetValue: '400' });

  // Territory with a geo-located customer.
  const admin = api.as(co.tokens.admin);
  await admin.post('/masterdata/customers', {
    code: 'GEO', name: 'Geo Shop', paymentTermsDays: 0, creditLimit: null,
    addresses: [{ addressType: 'DELIVERY', line1: 'Riverside', isDefault: true, latitude: 11.57, longitude: 104.93 }],
  });
});
afterAll(async () => app?.close());

describe('Sales reports', () => {
  it('lists all 11 reports with availability', async () => {
    const r = await sup().get('/sales/reports');
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(11);
    expect(r.body.every((x: { available: boolean }) => x.available)).toBe(true);
    expect((await rep().get('/sales/reports')).status).toBe(403);
  });

  it('sales by representative nets out discounts and returns', async () => {
    const r = await mgr().get('/sales/reports/sales-by-rep');
    expect(r.status).toBe(200);
    const sr1 = r.body.rows.find((x: { employee_code: string }) => x.employee_code === 'SR1');
    expect(sr1).toMatchObject({ gross_sales: '240.00', discounts: '12.00', returns: '22.80', net_sales: '205.20' });
    const sr2 = r.body.rows.find((x: { employee_code: string }) => x.employee_code === 'SR2');
    expect(sr2.net_sales).toBe('10.00');
    expect(r.body.totals.net_sales).toBe('215.20');
    expect(r.body.columns.map((c: { key: string }) => c.key)).toContain('net_sales');
  });

  it('runs every report for the supervisor', async () => {
    const codes = (await sup().get('/sales/reports')).body.map((x: { code: string }) => x.code);
    for (const code of codes) {
      const r = await sup().get(`/sales/reports/${code}`);
      expect({ code, status: r.status, body: r.status === 200 ? 'ok' : r.body }).toEqual({ code, status: 200, body: 'ok' });
      expect(Array.isArray(r.body.rows)).toBe(true);
    }
    const prod = (await sup().get('/sales/reports/sales-by-product')).body.rows;
    expect(prod.find((p: { sku: string }) => p.sku === 'RICE')).toMatchObject({ quantity: '10.0000', returned_qty: '1.0000', net_sales: '205.20' });
    const conv = (await sup().get('/sales/reports/order-conversion')).body.rows.find((x: { rep_name: string }) => x.rep_name === 'rep');
    expect(conv).toMatchObject({ quotations: '1', quotations_converted: '1', visits_completed: '1', visits_with_order: '1' });
    const tgt = (await sup().get('/sales/reports/target-achievement')).body.rows[0];
    expect(tgt).toMatchObject({ target_value: '400.00', achievement_percent: '51.3' });
    const disc = (await sup().get('/sales/reports/discount-analysis')).body.rows.find((x: { rep_name: string }) => x.rep_name === 'rep');
    expect(Number(disc.discount_amount)).toBe(12);
    const bal = (await sup().get('/sales/reports/customer-balances')).body;
    expect(bal.rows.find((x: { customer_code: string }) => x.customer_code === 'SUNRISE').outstanding).toBe('225.72'); // 250.80 − 25.08 credit
    const vis = (await sup().get('/sales/reports/visits')).body.rows.find((x: { rep_name: string }) => x.rep_name === 'rep');
    expect(vis).toMatchObject({ completed: '1', with_location: '1', orders_taken: '1' });
  });

  it('filters by rep and validates the date range', async () => {
    const r = await sup().get(`/sales/reports/sales-by-customer?salesRepId=${co.rep2Id}`);
    expect(r.body.rows.map((x: { customer_code: string }) => x.customer_code)).toEqual(['OTHER']);
    expect((await sup().get('/sales/reports/sales-by-rep?from=2026-05-01&to=2026-04-01')).status).toBe(422);
    expect((await sup().get('/sales/reports/nope')).status).toBe(404);
    const old = await sup().get('/sales/reports/sales-by-rep?from=2025-01-01&to=2025-01-31');
    expect(old.body.rows).toHaveLength(0);
  });

  it('exports Excel and PDF', async () => {
    const x = await binary(mgr().get('/sales/reports/sales-by-rep?format=xlsx'));
    expect(x.status).toBe(200);
    expect(x.headers['content-type']).toContain('spreadsheetml');
    expect(x.headers['content-disposition']).toMatch(/sales-by-rep_.*\.xlsx/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.body);
    const ws = wb.worksheets[0];
    expect(ws.getCell('A1').value).toBe('Sales by representative');
    const values = ws.getSheetValues().flat().filter((v) => typeof v === 'number');
    expect(values).toContain(205.2);

    const p = await binary(mgr().get('/sales/reports/customer-balances?format=pdf'));
    expect(p.status).toBe(200);
    expect(p.headers['content-type']).toBe('application/pdf');
    expect(p.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('scopes a supervisor to their team and gates advanced reports by subscription', async () => {
    const basic = await createCompany(app, { modules: ['INVENTORY', 'ACCOUNTING', 'CRM', 'SALES_TEAM_BASIC', 'SALES_ORDER_MANAGEMENT'] });
    const s = api.as(basic.tokens.supervisor);
    const cat = (await s.get('/sales/reports')).body;
    expect(cat.find((x: { code: string }) => x.code === 'sales-by-team').available).toBe(false);
    expect(cat.find((x: { code: string }) => x.code === 'sales-by-rep').available).toBe(true);
    const r = await s.get('/sales/reports/sales-by-team');
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('MODULE_NOT_SUBSCRIBED');
    // Company A's data never appears in company B's reports.
    expect((await s.get('/sales/reports/sales-by-rep')).body.rows).toHaveLength(0);
  });
});

describe('Dashboards', () => {
  it('shows the rep their own mobile dashboard', async () => {
    const d = await rep().get('/sales/dashboard');
    expect(d.status).toBe(200);
    expect(d.body.scope).toBe('OWN');
    expect(d.body.assignedCustomers).toBe(2);
    expect(d.body.draftOrders).toBeGreaterThanOrEqual(2);
    expect(Number(d.body.monthSales)).toBeGreaterThan(0);
    expect(d.body.monthlyTargets[0]).toMatchObject({ metric: 'NET_SALES', achievementPercent: '51.3' });
    expect(d.body.commissionEstimate).toBe('0.00');
    expect(d.body.recentActivities.length).toBeGreaterThan(3);
    const d2 = (await api.as(co.tokens.rep2).get('/sales/dashboard')).body;
    expect(d2.assignedCustomers).toBe(1);
  });

  it('team performance for supervisors only', async () => {
    expect((await rep().get('/sales/team-performance')).status).toBe(403);
    const t = await sup().get('/sales/team-performance');
    expect(t.status).toBe(200);
    expect(t.body.reps).toHaveLength(2);
    const r1 = t.body.reps.find((x: { employee_code: string }) => x.employee_code === 'SR1');
    expect(r1).toMatchObject({ net_sales: '205.20', net_sales_target: '400.00', target_achievement_percent: '51.3', visits_completed: '1' });
    expect(t.body.totals.netSales).toBe('215.20');
  });

  it('territory map returns geo points and consented visit locations', async () => {
    const m = await mgr().get('/sales/territory-map?includeVisits=true');
    expect(m.status).toBe(200);
    expect(m.body.customers.find((c: { code: string }) => c.code === 'GEO')).toMatchObject({ latitude: expect.anything(), longitude: expect.anything() });
    expect(m.body.visits).toHaveLength(1);
  });
});
