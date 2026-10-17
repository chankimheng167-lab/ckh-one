import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { ALL_SALES_MODULES, Api, bootApp, Company, createCompany, ownerUrl, localToday } from './helpers';

let app: INestApplication;
let co: Company;
let api: Api;

beforeAll(async () => {
  app = await bootApp();
  co = await createCompany(app, { modules: [...ALL_SALES_MODULES, 'HR_PAYROLL'] });
  api = new Api(app);
});
afterAll(async () => app?.close());

const rep = () => api.as(co.tokens.rep);
const rep2 = () => api.as(co.tokens.rep2);
const sup = () => api.as(co.tokens.supervisor);
const mgr = () => api.as(co.tokens.manager);
const admin = () => api.as(co.tokens.admin);
const wh = () => api.as(co.tokens.warehouse);
const acct = () => api.as(co.tokens.accountant);
const line = (productId: string, quantity: string, discountPercent = '0') => ({ productId, quantity, discountPercent });
const today = () => localToday();
const thisMonth = () => `${today().slice(0, 7)}-01`;

async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: ownerUrl() });
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end();
  }
}

async function invoicedOrder(token: string, customerId: string, lines: ReturnType<typeof line>[]) {
  const a = api.as(token);
  const created = await a.post('/sales/orders', { customerId, lines });
  expect(created.status).toBe(201);
  const o = (await a.post(`/sales/orders/${created.body.order.id}/submit`)).body.order;
  expect(o.status).toBe('APPROVED');
  expect((await wh().post(`/sales/orders/${o.id}/reserve`)).status).toBe(200);
  await wh().post(`/sales/orders/${o.id}/start-picking`);
  await wh().post(`/sales/orders/${o.id}/pack`);
  const dn = await wh().post(`/sales/orders/${o.id}/dispatch`);
  expect(dn.status).toBe(200);
  await wh().post(`/sales/deliveries/${dn.body.id}/confirm`, { receivedByName: 'Owner' });
  const inv = await acct().post(`/sales/orders/${o.id}/invoice`);
  expect(inv.status).toBe(201);
  return { order: o, invoice: inv.body };
}

const entriesFor = (sourceId: string) =>
  sql<{ source_type: string; amount: string; base_amount: string; rate_percent: string | null; status: string }>(
    'SELECT source_type, amount, base_amount, rate_percent, status FROM sales_commission_entries WHERE source_id = $1 ORDER BY created_at',
    [sourceId],
  );

// ---------------------------------------------------------------------------

describe('Quotations', () => {
  it('prices on the server, moves through send/accept, and converts into a draft order', async () => {
    const q = await rep().post('/sales/quotations', { customerId: co.customers.sunrise, lines: [line(co.products.rice, '10', '5')] });
    expect(q.status).toBe(201);
    expect(q.body.number).toMatch(/^QT-\d{4}-\d{5}$/);
    expect(q.body.status).toBe('DRAFT');
    expect(Number(q.body.lines[0].unit_price)).toBe(24); // customer price list, not the client
    expect(q.body.grand_total).toBe('250.80'); // 240 − 5% = 228 + 10% VAT

    // Other reps cannot see it; the supervisor can.
    expect((await rep2().get(`/sales/quotations/${q.body.id}`)).status).toBe(404);
    expect((await sup().get(`/sales/quotations/${q.body.id}`)).status).toBe(200);

    expect((await rep().post(`/sales/quotations/${q.body.id}/accept`)).body.status).toBe('ACCEPTED');
    expect((await rep().post(`/sales/quotations/${q.body.id}/send`)).status).toBe(409); // already decided

    const conv = await rep().post(`/sales/quotations/${q.body.id}/convert`);
    expect(conv.status).toBe(201);
    expect(conv.body.priceChanged).toBe(false);
    expect(conv.body.order.status).toBe('DRAFT');
    expect(conv.body.order.source).toBe('QUOTATION');
    expect(conv.body.order.quotation_id).toBe(q.body.id);

    const after = (await rep().get(`/sales/quotations/${q.body.id}`)).body;
    expect(after.status).toBe('CONVERTED');
    expect(after.converted_order_number).toBe(conv.body.order.number);
    expect((await rep().post(`/sales/quotations/${q.body.id}/convert`)).status).toBe(409);
  });

  it('reports expired quotations and refuses to accept or convert them', async () => {
    const q = await rep().post('/sales/quotations', {
      customerId: co.customers.sunrise, quotationDate: '2026-01-02', validUntil: '2026-01-10', lines: [line(co.products.oil, '2')],
    });
    expect(q.status).toBe(201);
    expect(q.body.status).toBe('EXPIRED');
    expect((await rep().post(`/sales/quotations/${q.body.id}/accept`)).body.error.code).toBe('QUOTATION_EXPIRED');
    expect((await rep().post(`/sales/quotations/${q.body.id}/convert`)).status).toBe(409);
    const list = (await rep().get('/sales/quotations?status=EXPIRED')).body;
    expect(list.map((x: { id: string }) => x.id)).toContain(q.body.id);
  });

  it('rejects quotations for customers the rep does not serve', async () => {
    const q = await rep().post('/sales/quotations', { customerId: co.customers.other, lines: [line(co.products.oil, '1')] });
    expect([403, 404]).toContain(q.status);
  });
});

// ---------------------------------------------------------------------------

describe('Customer visits', () => {
  const schedule = async (customerId = co.customers.sunrise) => {
    const v = await rep().post('/sales/visits', { customerId, scheduledStart: new Date().toISOString(), purpose: 'Monthly stock check' });
    expect(v.status).toBe(201);
    expect(v.body.status).toBe('PLANNED');
    return v.body;
  };
  const stored = async (id: string) =>
    (await sql('SELECT location_consent, check_in_latitude, check_in_longitude, location_purpose FROM sales_visits WHERE id = $1', [id]))[0];

  afterAll(async () => {
    await admin().put('/admin/sales/settings', { visitLocationCapture: 'ASK' });
  });

  it('stores location only with consent, and enforces the REQUIRED policy', async () => {
    // ASK (default): no consent → checked in without any location.
    const v1 = await schedule();
    const c1 = await rep().post(`/sales/visits/${v1.id}/check-in`, { locationConsent: false, latitude: 11.55, longitude: 104.92 });
    expect(c1.status).toBe(200);
    expect(c1.body.status).toBe('IN_PROGRESS');
    expect(await stored(v1.id)).toMatchObject({ location_consent: false, check_in_latitude: null, check_in_longitude: null });

    expect((await admin().put('/admin/sales/settings', { visitLocationCapture: 'REQUIRED' })).status).toBe(200);
    const v2 = await schedule();
    const refused = await rep().post(`/sales/visits/${v2.id}/check-in`, { locationConsent: false });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('LOCATION_REQUIRED');
    const ok = await rep().post(`/sales/visits/${v2.id}/check-in`, { locationConsent: true, latitude: 11.5564, longitude: 104.9282, accuracyM: 12 });
    expect(ok.status).toBe(200);
    const s = await stored(v2.id);
    expect(s.location_consent).toBe(true);
    expect(Number(s.check_in_latitude)).toBeCloseTo(11.5564, 4);
    expect(s.location_purpose).toBeTruthy();

    // OFF: never stored, even when offered.
    await admin().put('/admin/sales/settings', { visitLocationCapture: 'OFF' });
    const v3 = await schedule();
    await rep().post(`/sales/visits/${v3.id}/check-in`, { locationConsent: true, latitude: 11.5, longitude: 104.9 });
    expect((await stored(v3.id)).check_in_latitude).toBeNull();
  });

  it('only the visiting rep can check in, and only once', async () => {
    const v = await schedule();
    expect([403, 404]).toContain((await rep2().post(`/sales/visits/${v.id}/check-in`, { locationConsent: false })).status);
    expect((await rep().post(`/sales/visits/${v.id}/check-out`, { outcome: 'NO_INTEREST' })).status).toBe(409);
    await rep().post(`/sales/visits/${v.id}/check-in`, { locationConsent: false });
    expect((await rep().post(`/sales/visits/${v.id}/check-in`, { locationConsent: false })).status).toBe(409);
  });

  it('links orders to an active visit, records outcome, follow-ups and supervisor review', async () => {
    const v = await schedule();
    // Documents need a started visit.
    const early = await rep().post('/sales/orders', { customerId: co.customers.sunrise, visitId: v.id, lines: [line(co.products.oil, '1')] });
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('VISIT_NOT_STARTED');

    await rep().post(`/sales/visits/${v.id}/check-in`, { locationConsent: false });
    const wrongCustomer = await rep().post('/sales/orders', { customerId: co.customers.lucky, visitId: v.id, lines: [line(co.products.oil, '1')] });
    expect(wrongCustomer.body.error.code).toBe('VISIT_INVALID');
    const o = await rep().post('/sales/orders', { customerId: co.customers.sunrise, visitId: v.id, lines: [line(co.products.oil, '1')] });
    expect(o.status).toBe(201);
    expect(o.body.order.source).toBe('VISIT');
    expect(o.body.order.visit_id).toBe(v.id);

    expect((await rep().post(`/sales/visits/${v.id}/notes`, { noteType: 'FOLLOW_UP_TASK', body: 'Bring new price list' })).body.error.code).toBe('DUE_DATE_REQUIRED');
    const fu = await rep().post(`/sales/visits/${v.id}/notes`, { noteType: 'FOLLOW_UP_TASK', body: 'Bring new price list', dueDate: today() });
    expect(fu.status).toBe(201);
    await rep().post(`/sales/visits/${v.id}/notes`, { body: 'Owner wants larger bags' });

    const out = await rep().post(`/sales/visits/${v.id}/check-out`, { outcome: 'ORDER_TAKEN', outcomeSummary: '1 carton oil' });
    expect(out.status).toBe(200);
    expect(out.body.status).toBe('COMPLETED');

    const open = (await rep().get('/sales/visits/follow-ups')).body;
    const task = open.find((t: { body: string }) => t.body === 'Bring new price list');
    expect(task).toBeTruthy();
    expect((await rep().post(`/sales/visits/follow-ups/${task.id}/complete`)).status).toBe(200);
    expect((await rep().get('/sales/visits/follow-ups')).body.find((t: { id: string }) => t.id === task.id)).toBeUndefined();

    expect((await rep().post(`/sales/visits/${v.id}/review`, { comment: 'Self review' })).status).toBe(403);
    const rev = await sup().post(`/sales/visits/${v.id}/review`, { comment: 'Good visit' });
    expect(rev.status).toBe(200);
    expect(rev.body.reviewed_at).toBeTruthy();

    const detail = (await sup().get(`/sales/visits/${v.id}`)).body;
    expect(detail.notes.length).toBeGreaterThanOrEqual(2);
    expect((await rep2().get(`/sales/visits/${v.id}`)).status).toBe(404);
  });

  it('cancels or marks visits missed with a reason', async () => {
    const v = await schedule();
    expect((await rep().post(`/sales/visits/${v.id}/cancel`, {})).status).toBe(400);
    const m = await rep().post(`/sales/visits/${v.id}/cancel`, { reason: 'Shop closed', missed: true });
    expect(m.body.status).toBe('MISSED');
    expect((await rep().post(`/sales/visits/${v.id}/check-in`, { locationConsent: false })).status).toBe(409);
  });
});

// ---------------------------------------------------------------------------

describe('Territories', () => {
  let territoryId: string;
  let newCustomer: string;

  it('imports administrative locations and builds a territory from them', async () => {
    const imp = await admin().post('/locations/import', {
      countryCode: 'KH',
      source: 'Test gazetteer',
      rows: [
        { level: 'PROVINCE', code: 'T-12', name: 'Test Province' },
        { level: 'DISTRICT', code: 'T-1201', name: 'Test District', parentCode: 'T-12', parentLevel: 'PROVINCE' },
      ],
    });
    expect(imp.status).toBe(201);
    // Re-importing the same codes updates rather than duplicates.
    const again = await admin().post('/locations/import', { source: 'Test gazetteer v2', rows: [{ level: 'PROVINCE', code: 'T-12', name: 'Test Province (renamed)' }] });
    expect(again.status).toBe(201);
    const provinces = (await rep().get('/locations?level=PROVINCE&search=Test')).body;
    expect(provinces.filter((l: { code: string }) => l.code === 'T-12')).toHaveLength(1);
    expect(provinces.find((l: { code: string }) => l.code === 'T-12').name).toBe('Test Province (renamed)');
    const district = (await rep().get(`/locations?parentId=${provinces[0].id}`)).body[0];
    expect(district.code).toBe('T-1201');

    expect((await rep().post('/sales/territories', { code: 'X', name: 'X' })).status).toBe(403);
    const t = await mgr().post('/sales/territories', { code: 'TP', name: 'Test Province Territory' });
    expect(t.status).toBe(201);
    territoryId = t.body.id;
    expect((await mgr().put(`/sales/territories/${territoryId}/locations`, { locationIds: [provinces[0].id] })).status).toBe(200);

    newCustomer = (
      await admin().post('/masterdata/customers', {
        code: 'DISTRICT-SHOP', name: 'District Shop', paymentTermsDays: 30, creditLimit: null,
        addresses: [{ addressType: 'DELIVERY', line1: 'Market St', isDefault: true, locationId: district.id }],
      })
    ).body.id;
  });

  it('assigns customers in the territory (including sub-locations) to its primary rep', async () => {
    const none = await mgr().post(`/sales/territories/${territoryId}/assign-customers`);
    expect(none.body.error.code).toBe('NO_PRIMARY_REP');

    expect((await mgr().post(`/sales/territories/${territoryId}/representatives`, { salesRepId: co.rep2Id })).status).toBe(201);
    const r = await mgr().post(`/sales/territories/${territoryId}/assign-customers`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ matched: 1, assigned: 1, skipped: 0 });
    expect((await rep2().get(`/sales/customers/${newCustomer}`)).status).toBe(200);
    expect([403, 404]).toContain((await rep().get(`/sales/customers/${newCustomer}`)).status);

    // A new primary replaces the old one; existing customer assignments stay unless reassigned.
    await mgr().post(`/sales/territories/${territoryId}/representatives`, { salesRepId: co.repId });
    const list = (await mgr().get('/sales/territories')).body;
    const t = list.find((x: { id: string }) => x.id === territoryId);
    const primaries = t.representatives.filter((a: { role: string }) => a.role === 'PRIMARY');
    expect(primaries.map((a: { salesRepId: string }) => a.salesRepId)).toEqual([co.repId]);

    const keep = await mgr().post(`/sales/territories/${territoryId}/assign-customers`);
    expect(keep.body).toMatchObject({ assigned: 0, skipped: 1 });
    const move = await mgr().post(`/sales/territories/${territoryId}/assign-customers`, { reassign: true });
    expect(move.body).toMatchObject({ assigned: 1 });
    expect((await rep().get(`/sales/customers/${newCustomer}`)).status).toBe(200);
    expect([403, 404]).toContain((await rep2().get(`/sales/customers/${newCustomer}`)).status);
  });

  it('refuses parent cycles', async () => {
    const child = (await mgr().post('/sales/territories', { code: 'TP-A', name: 'Area A', territoryType: 'AREA', parentId: territoryId })).body;
    const cyc = await mgr().put(`/sales/territories/${territoryId}`, { parentId: child.id });
    expect(cyc.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------

describe('Targets and commissions', () => {
  let planId: string;
  let invoiceId: string;
  let orderId: string;
  let collectionPlanId: string;

  it('sets targets per rep and shows achievement from invoiced sales', async () => {
    expect((await rep().post('/sales/targets', { scope: 'REP', salesRepId: co.repId, periodType: 'MONTH', periodStart: thisMonth(), metric: 'NET_SALES', targetValue: '100' })).status).toBe(403);
    const t = await mgr().post('/sales/targets', { scope: 'REP', salesRepId: co.repId, periodType: 'MONTH', periodStart: thisMonth(), metric: 'NET_SALES', targetValue: '1000' });
    expect(t.status).toBe(201);
    // Same target again updates in place.
    const t2 = await mgr().post('/sales/targets', { scope: 'REP', salesRepId: co.repId, periodType: 'MONTH', periodStart: thisMonth(), metric: 'NET_SALES', targetValue: '200' });
    expect(t2.body.id).toBe(t.body.id);
    await mgr().post('/sales/targets', { scope: 'REP', salesRepId: co.repId, periodType: 'MONTH', periodStart: thisMonth(), metric: 'VISITS', targetValue: '20' });

    const mine = (await rep().get('/sales/targets')).body;
    const ns = mine.find((x: { metric: string }) => x.metric === 'NET_SALES');
    expect(ns.target_value).toBe('200.00');
    expect(ns.period_end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number(mine.find((x: { metric: string }) => x.metric === 'VISITS').actual)).toBeGreaterThanOrEqual(1);
    // Rep 2 does not see rep 1's targets.
    expect((await rep2().get('/sales/targets')).body.find((x: { id: string }) => x.id === t.body.id)).toBeUndefined();
  });

  it('accrues invoice-based commission at product rates and reverses it on credit notes', async () => {
    expect((await rep().post('/sales/commissions/plans', {})).status).toBe(403);
    const bad = await mgr().post('/sales/commissions/plans', { code: 'BAD', name: 'x', basis: 'INVOICED_NET_SALES', validFrom: '2026-01-01', rules: { defaultRatePercent: '150' } });
    expect(bad.status).toBe(400);
    const p = await mgr().post('/sales/commissions/plans', {
      code: 'STD', name: 'Standard', basis: 'INVOICED_NET_SALES', validFrom: '2026-01-01',
      rules: { defaultRatePercent: '2', productRates: { [co.products.rice]: '5' }, clawbackOverdueDays: 30, tiers: [{ minAchievementPercent: '100', multiplier: '1.5' }] },
    });
    expect(p.status).toBe(201);
    planId = p.body.id;
    if (p.body.status !== 'ACTIVE') await mgr().put(`/sales/commissions/plans/${planId}`, { status: 'ACTIVE' });
    expect((await mgr().put(`/sales/commissions/representatives/${co.repId}/plan`, { planId })).status).toBe(200);

    // 10 rice × 24 = 240 at 5% = 12.00; 4 oil × 2.50 = 10 at 2% = 0.20
    const { order, invoice } = await invoicedOrder(co.tokens.rep, co.customers.sunrise, [line(co.products.rice, '10'), line(co.products.oil, '4')]);
    invoiceId = invoice.id;
    orderId = order.id;
    const e = await entriesFor(invoice.id);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ source_type: 'INVOICE', base_amount: '250.00', amount: '12.20', status: 'ESTIMATED' });

    // Return 2 bags of rice → credit note → −2.40 commission.
    const riceLine = order.lines.find((l: { sku: string }) => l.sku === 'RICE');
    const ret = await rep().post('/sales/returns', { orderId: order.id, reason: 'Torn bags', lines: [{ orderLineId: riceLine.id, quantity: '2', restock: true }] });
    const rec = await wh().post(`/sales/returns/${ret.body.id}/receive`);
    expect(rec.status).toBe(200);
    const cn = (await sql('SELECT id FROM credit_notes WHERE sales_return_id = $1', [ret.body.id]))[0];
    expect((await entriesFor(cn.id))[0]).toMatchObject({ source_type: 'CREDIT_NOTE', amount: '-2.40', base_amount: '-48.00' });

    // Reps see only their own commission.
    const mine = (await rep().get('/sales/commissions/entries')).body;
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect((await rep2().get('/sales/commissions/entries')).body).toHaveLength(0);
  });

  it('claws back commission on long-overdue invoices and reinstates it when paid', async () => {
    const far = new Date(Date.now() + 120 * 86400_000).toISOString().slice(0, 10);
    const r = await mgr().post('/sales/commissions/run-clawbacks', { asOf: far });
    expect(r.body.clawedBack).toBeGreaterThanOrEqual(1);
    expect((await mgr().post('/sales/commissions/run-clawbacks', { asOf: far })).body.clawedBack).toBe(0); // idempotent

    const cb = (await sql(`SELECT amount FROM sales_commission_entries WHERE source_type = 'OVERDUE_CLAWBACK' AND source_id = $1`, [invoiceId]))[0];
    expect(Number(cb.amount)).toBeLessThan(0);

    const inv = (await acct().get(`/accounting/invoices/${invoiceId}`)).body;
    const c = await rep().post('/sales/collections', { customerId: co.customers.sunrise, invoiceId, amount: inv.balance_due, paymentMethod: 'CASH' });
    expect((await acct().post(`/sales/collections/${c.body.collection.id}/verify`)).status).toBe(200);
    const re = await sql(`SELECT amount FROM sales_commission_entries WHERE source_type = 'CLAWBACK_REINSTATED' AND source_id = $1`, [invoiceId]);
    expect(re).toHaveLength(1);
    expect(Number(re[0].amount)).toBe(-Number(cb.amount));
    expect((await rep().get(`/sales/orders/${orderId}`)).body.status).toBe('CLOSED');
  });

  it('earns collection-based commission only on verified receipts', async () => {
    const p = await mgr().post('/sales/commissions/plans', {
      code: 'COL', name: 'On collection', basis: 'COLLECTED_AMOUNT', validFrom: '2026-01-01', rules: { defaultRatePercent: '10' },
    });
    collectionPlanId = p.body.id;
    if (p.body.status !== 'ACTIVE') await mgr().put(`/sales/commissions/plans/${collectionPlanId}`, { status: 'ACTIVE' });
    await mgr().put(`/sales/commissions/representatives/${co.rep2Id}/plan`, { planId: collectionPlanId });

    // 4 oil = 10.00 net, 11.00 with VAT.
    const { invoice } = await invoicedOrder(co.tokens.rep2, co.customers.other, [line(co.products.oil, '4')]);
    expect(await entriesFor(invoice.id)).toHaveLength(0);

    const c = await rep2().post('/sales/collections', { customerId: co.customers.other, invoiceId: invoice.id, amount: '5.50', paymentMethod: 'CASH' });
    const pending = await sql(`SELECT 1 FROM sales_commission_entries WHERE sales_rep_id = $1 AND source_type = 'COLLECTION'`, [co.rep2Id]);
    expect(pending).toHaveLength(0);
    const v = await acct().post(`/sales/collections/${c.body.collection.id}/verify`);
    const rcId = (await sql('SELECT id FROM customer_receipts WHERE collection_id = $1', [c.body.collection.id]))[0].id;
    expect(v.status).toBe(200);
    // Half the invoice paid → half the VAT-exclusive base (5.00) at 10%.
    expect((await entriesFor(rcId))[0]).toMatchObject({ source_type: 'COLLECTION', base_amount: '5.00', amount: '0.50' });
  });

  it('approves with a target tier bonus, accrues it in the ledger, and hands off to payroll', async () => {
    // Rep 1 sold 250 − 48 = 202 net against a 200 target → ≥100% → ×1.5.
    expect((await rep().post('/sales/commissions/approve', { periodMonth: thisMonth() })).status).toBe(403);
    await mgr().post('/sales/commissions/adjustments', { salesRepId: co.repId, periodMonth: thisMonth(), amount: '1.00', notes: 'Spot bonus' });

    const est = (await sql(`SELECT COALESCE(SUM(amount), 0) AS s FROM sales_commission_entries WHERE sales_rep_id = $1 AND status = 'ESTIMATED' AND period_month = $2`, [co.repId, thisMonth()]))[0].s;
    const ap = await mgr().post('/sales/commissions/approve', { periodMonth: thisMonth(), salesRepId: co.repId });
    expect(ap.status).toBe(200);
    const mine = ap.body.approved.find((x: { salesRepId: string }) => x.salesRepId === co.repId);
    expect(mine.tierBonus).toBe((Number(est) * 0.5).toFixed(2));
    expect(mine.amount).toBe((Number(est) * 1.5).toFixed(2));
    expect((await mgr().post('/sales/commissions/approve', { periodMonth: thisMonth(), salesRepId: co.repId })).body.error.code).toBe('NOTHING_TO_APPROVE');

    const je = await sql(
      `SELECT a.code, l.debit, l.credit FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN chart_of_accounts a ON a.id = l.account_id WHERE e.source_type = 'COMMISSION' AND e.source_id = $1`,
      [co.repId],
    );
    expect(je.find((l) => l.code === '6100').debit).toBe(mine.amount);
    expect(je.find((l) => Number(l.credit) > 0).credit).toBe(mine.amount);

    await mgr().post('/sales/commissions/approve', { periodMonth: thisMonth() }); // rep 2

    const summary = (await mgr().get('/sales/commissions/summary')).body;
    expect(summary.length).toBeGreaterThanOrEqual(2);

    const b = await mgr().post('/sales/commissions/payroll-batches', { periodMonth: thisMonth() });
    expect(b.status).toBe(201);
    expect(b.body.number).toMatch(/^PCB-\d{4}-\d{5}$/);
    expect(b.body.status).toBe('SENT');
    expect(b.body.lines).toHaveLength(2);
    expect((await mgr().post('/sales/commissions/payroll-batches', { periodMonth: thisMonth() })).body.error.code).toBe('NOTHING_TO_SEND');

    // HR side: the sales manager has no payroll access; the HR admin marks it paid.
    expect((await mgr().get('/hr/payroll/commission-batches')).status).toBe(403);
    const list = (await admin().get('/hr/payroll/commission-batches?status=SENT')).body;
    expect(list.map((x: { id: string }) => x.id)).toContain(b.body.id);
    const paid = await admin().post(`/hr/payroll/commission-batches/${b.body.id}/paid`, { hrReference: 'PAYRUN-2026-10' });
    expect(paid.body.status).toBe('PAID');
    expect((await admin().post(`/hr/payroll/commission-batches/${b.body.id}/paid`, { hrReference: 'again' })).status).toBe(409);
    const statuses = await sql(`SELECT DISTINCT status FROM sales_commission_entries WHERE payroll_batch_id = $1`, [b.body.id]);
    expect(statuses).toEqual([{ status: 'PAID' }]);
  });

  it('keeps the ledger balanced', async () => {
    const tb = (await acct().get('/accounting/trial-balance')).body;
    const d = tb.reduce((s: number, a: { debit: string }) => s + Number(a.debit), 0);
    const c = tb.reduce((s: number, a: { credit: string }) => s + Number(a.credit), 0);
    expect(d.toFixed(2)).toBe(c.toFixed(2));
  });
});

describe('Module gating', () => {
  it('blocks commission and territory routes when the modules are off', async () => {
    const basic = await createCompany(app, { modules: ['INVENTORY', 'ACCOUNTING', 'CRM', 'SALES_TEAM_BASIC', 'SALES_ORDER_MANAGEMENT'] });
    const m = api.as(basic.tokens.manager);
    expect((await m.get('/sales/commissions/plans')).status).toBe(402);
    expect((await m.get('/sales/territories')).status).toBe(402);
    expect((await api.as(basic.tokens.admin).get('/hr/payroll/commission-batches')).status).toBe(402);
    // Invoicing still works and creates no commission.
    const { invoice } = await (async () => {
      const a = api.as(basic.tokens.rep);
      const o = (await a.post('/sales/orders', { customerId: basic.customers.sunrise, lines: [line(basic.products.oil, '1')] })).body.order;
      await a.post(`/sales/orders/${o.id}/submit`);
      const w = api.as(basic.tokens.warehouse);
      await w.post(`/sales/orders/${o.id}/reserve`);
      await w.post(`/sales/orders/${o.id}/start-picking`);
      await w.post(`/sales/orders/${o.id}/pack`);
      const dn = await w.post(`/sales/orders/${o.id}/dispatch`);
      await w.post(`/sales/deliveries/${dn.body.id}/confirm`, { receivedByName: 'x' });
      return { invoice: (await api.as(basic.tokens.accountant).post(`/sales/orders/${o.id}/invoice`)).body };
    })();
    expect(invoice.id).toBeTruthy();
    expect(await entriesFor(invoice.id)).toHaveLength(0);
  });
});
