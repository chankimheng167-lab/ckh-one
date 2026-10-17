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
const wh = () => api.as(co.tokens.warehouse);
const acct = () => api.as(co.tokens.accountant);
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
const onHand = async (productId: string) =>
  Number((await sql('SELECT qty_on_hand FROM stock_levels WHERE product_id = $1 AND warehouse_id = $2', [productId, co.warehouseId]))[0]?.qty_on_hand ?? 0);
const reserved = async (productId: string) =>
  Number((await sql('SELECT qty_reserved FROM stock_levels WHERE product_id = $1 AND warehouse_id = $2', [productId, co.warehouseId]))[0]?.qty_reserved ?? 0);
const balance = async (customerId: string) => Number((await sql('SELECT outstanding FROM customer_balances WHERE customer_id = $1', [customerId]))[0]?.outstanding ?? 0);

async function approvedOrder(lines: ReturnType<typeof line>[], customerId = co.customers.sunrise) {
  const created = await rep().post('/sales/orders', { customerId, lines });
  expect(created.status).toBe(201);
  const sub = await rep().post(`/sales/orders/${created.body.order.id}/submit`);
  expect(sub.body.order.status).toBe('APPROVED');
  return sub.body.order;
}

async function reservedAndPacked(lines: ReturnType<typeof line>[]) {
  const o = await approvedOrder(lines);
  expect((await wh().post(`/sales/orders/${o.id}/reserve`)).status).toBe(200);
  expect((await wh().post(`/sales/orders/${o.id}/start-picking`)).body.status).toBe('PICKING');
  expect((await wh().post(`/sales/orders/${o.id}/pack`, { packageCount: 2 })).body.status).toBe('PACKED');
  return o;
}

async function deliveredOrder(lines: ReturnType<typeof line>[]) {
  const o = await reservedAndPacked(lines);
  const dn = await wh().post(`/sales/orders/${o.id}/dispatch`, { carrier: 'Own truck' });
  expect(dn.status).toBe(200);
  const conf = await wh().post(`/sales/deliveries/${dn.body.id}/confirm`, { receivedByName: 'Shop owner' });
  expect(['DELIVERED', 'INVOICED']).toContain(conf.body.order_status); // INVOICED when revenue is recognised on delivery
  return o;
}

describe('Order fulfilment', () => {
  it('picks, packs, dispatches, delivers partially, then ships the rest', async () => {
    const riceBefore = await onHand(co.products.rice);
    const o = await reservedAndPacked([line(co.products.rice, '10'), line(co.products.oil, '4')]);

    const pick = await wh().get(`/sales/orders/${o.id}/picking-list`);
    expect(pick.status).toBe(200);
    expect(pick.body.lines.map((l: { sku: string; quantityToPick: string }) => [l.sku, Number(l.quantityToPick)])).toEqual([['RICE', 10], ['OIL', 4]]);

    // Reps cannot move goods.
    expect((await rep().post(`/sales/orders/${o.id}/dispatch`)).status).toBe(403);

    const dn = await wh().post(`/sales/orders/${o.id}/dispatch`, { carrier: 'Own truck', vehicleNo: '2A-1234', driverName: 'Sok' });
    expect(dn.status).toBe(200);
    expect(dn.body.number).toMatch(/^DN-\d{4}-\d{5}$/);
    expect(dn.body.order_status).toBe('DISPATCHED');
    expect(await onHand(co.products.rice)).toBe(riceBefore - 10);

    // Only one delivery on the road at a time.
    expect((await wh().post(`/sales/orders/${o.id}/dispatch`)).status).toBe(409);

    // The rep can track the delivery of their own order.
    const tracking = await rep().get('/sales/deliveries?status=DISPATCHED');
    expect(tracking.body.map((d: { id: string }) => d.id)).toContain(dn.body.id);
    expect((await rep().post(`/sales/deliveries/${dn.body.id}/confirm`, { receivedByName: 'x' })).status).toBe(403);

    // The customer accepts only 8 bags of rice: 2 come back and are re-reserved.
    const riceLine = o.lines.find((l: { sku: string }) => l.sku === 'RICE');
    const conf = await wh().post(`/sales/deliveries/${dn.body.id}/confirm`, {
      receivedByName: 'Shop owner',
      lines: [{ orderLineId: riceLine.id, quantityDelivered: '8' }],
    });
    expect(conf.status).toBe(200);
    expect(conf.body.status).toBe('DELIVERED');
    expect(conf.body.order_status).toBe('PARTIALLY_DELIVERED');
    expect(await onHand(co.products.rice)).toBe(riceBefore - 8);

    const mid = (await rep().get(`/sales/orders/${o.id}`)).body;
    const midRice = mid.lines.find((l: { sku: string }) => l.sku === 'RICE');
    expect(Number(midRice.qty_delivered)).toBe(8);
    expect(Number(midRice.qty_reserved)).toBe(2);
    expect(mid.allowedActions).toContain('DISPATCH');

    const dn2 = await wh().post(`/sales/orders/${o.id}/dispatch`, { carrier: 'Own truck' });
    expect(dn2.status).toBe(200);
    const conf2 = await wh().post(`/sales/deliveries/${dn2.body.id}/confirm`, { receivedByName: 'Shop owner' });
    expect(conf2.body.order_status).toBe('DELIVERED');
    expect(await onHand(co.products.rice)).toBe(riceBefore - 10);

    const final = (await rep().get(`/sales/orders/${o.id}`)).body;
    expect(final.deliveries).toHaveLength(2);
    expect(final.history.map((h: { to_status: string }) => h.to_status)).toEqual(
      expect.arrayContaining(['STOCK_RESERVED', 'PICKING', 'PACKED', 'DISPATCHED', 'PARTIALLY_DELIVERED', 'DELIVERED']),
    );
  });

  it('posts cost of goods sold at weighted-average cost on dispatch', async () => {
    const o = await reservedAndPacked([line(co.products.oil, '5')]);
    const dn = await wh().post(`/sales/orders/${o.id}/dispatch`);
    const je = await sql(`SELECT l.debit, l.credit, a.code FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
                           JOIN journal_entries e ON e.id = l.journal_entry_id WHERE e.source_type = 'DELIVERY' AND e.source_id = $1`, [dn.body.id]);
    expect(je.find((l) => l.code === '5000').debit).toBe('9.00'); // 5 × 1.80
    expect(je.find((l) => l.code === '1200').credit).toBe('9.00');
  });

  it('reserves backorders when stock arrives, or short-closes the remainder', async () => {
    const o = await approvedOrder([line(co.products.rice, '2'), line(co.products.water, '6')]);
    const r = await wh().post(`/sales/orders/${o.id}/reserve`);
    expect(r.body.order.has_backorder).toBe(true);

    expect((await wh().post(`/sales/orders/${o.id}/reserve-backorders`)).body.lines[0].reserved).toBe('0');
    await api.as(co.tokens.admin).post('/masterdata/stock/receipts', { warehouseId: co.warehouseId, lines: [{ productId: co.products.water, quantity: '4', unitCost: '3' }] });
    const rb = await wh().post(`/sales/orders/${o.id}/reserve-backorders`);
    expect(rb.status).toBe(200);
    expect(rb.body.lines[0]).toMatchObject({ reserved: '4', stillBackordered: '2' });
    expect(rb.body.order.has_backorder).toBe(true);

    await wh().post(`/sales/orders/${o.id}/start-picking`);
    await wh().post(`/sales/orders/${o.id}/pack`);
    const dn = await wh().post(`/sales/orders/${o.id}/dispatch`);
    const conf = await wh().post(`/sales/deliveries/${dn.body.id}/confirm`, { receivedByName: 'Buyer' });
    expect(conf.body.order_status).toBe('PARTIALLY_DELIVERED');

    const closed = await wh().post(`/sales/orders/${o.id}/close-backorders`, { reason: 'Customer no longer needs it' });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('DELIVERED');
    const water = closed.body.lines.find((l: { sku: string }) => l.sku === 'WATER');
    expect(Number(water.qty_cancelled)).toBe(2);
    expect(await reserved(co.products.water)).toBe(0);
  });
});

describe('Invoice generation', () => {
  it('cannot invoice before delivery, and only accountants invoice', async () => {
    const o = await approvedOrder([line(co.products.oil, '1')]);
    expect((await acct().post(`/sales/orders/${o.id}/invoice`)).status).toBe(409);
    const d = await deliveredOrder([line(co.products.oil, '1')]);
    expect((await rep().post(`/sales/orders/${d.id}/invoice`)).status).toBe(403);
  });

  it('bills delivered quantities, posts AR / revenue / VAT, and marks the order invoiced', async () => {
    const o = await deliveredOrder([line(co.products.rice, '3', '5'), line(co.products.oil, '2')]);
    const before = await balance(co.customers.sunrise);
    const inv = await acct().post(`/sales/orders/${o.id}/invoice`);
    expect(inv.status).toBe(201);
    expect(inv.body.number).toMatch(/^INV-\d{4}-\d{5}$/);
    // Same totals as the order; nothing posted to revenue before this point.
    expect(inv.body.grand_total).toBe(o.grand_total);
    expect(inv.body.lines).toHaveLength(2);
    expect(await balance(co.customers.sunrise)).toBeCloseTo(before + Number(o.grand_total), 2);

    const je = (await acct().get(`/accounting/journal-entries/${inv.body.journal_entry_id}`)).body;
    const dr = je.lines.reduce((s: number, l: { debit: string }) => s + Number(l.debit), 0);
    const cr = je.lines.reduce((s: number, l: { credit: string }) => s + Number(l.credit), 0);
    expect(dr).toBeCloseTo(cr, 2);
    expect(je.lines.find((l: { code: string }) => l.code === '1100').debit).toBe(o.grand_total);
    expect(je.lines.find((l: { code: string }) => l.code === '2100').credit).toBe(o.tax_total);

    const after = (await rep().get(`/sales/orders/${o.id}`)).body;
    expect(after.status).toBe('INVOICED');
    expect((await acct().post(`/sales/orders/${o.id}/invoice`)).status).toBe(409);
  });

  it('auto-invoices on delivery when revenue is recognised on delivery', async () => {
    const admin = api.as(co.tokens.admin);
    expect((await admin.put('/admin/accounting/settings', { revenueRecognition: 'ON_DELIVERY' })).status).toBe(200);
    try {
      const o = await deliveredOrder([line(co.products.oil, '3')]);
      const after = (await rep().get(`/sales/orders/${o.id}`)).body;
      expect(after.status).toBe('INVOICED');
      expect(after.invoices).toHaveLength(1);
      expect(after.invoices[0].grand_total).toBe(o.grand_total);
    } finally {
      await admin.put('/admin/accounting/settings', { revenueRecognition: 'ON_INVOICE' });
    }
  });
});

describe('Payment verification', () => {
  let invoice: { id: string; grand_total: string };
  let orderId: string;
  beforeAll(async () => {
    const o = await deliveredOrder([line(co.products.rice, '2')]); // 2 × 24 + 10% VAT = 52.80
    orderId = o.id;
    invoice = (await acct().post(`/sales/orders/${o.id}/invoice`)).body;
  });

  it('keeps a submitted collection pending and out of the ledger until verified', async () => {
    const before = await balance(co.customers.sunrise);
    const c = await rep().post('/sales/collections', {
      customerId: co.customers.sunrise, invoiceId: invoice.id, amount: '20.00', paymentMethod: 'CASH', clientReference: 'dev1-col-000001',
    });
    expect(c.status).toBe(201);
    expect(c.body.collection.status).toBe('PENDING_VERIFICATION');
    expect(c.body.collection.number).toMatch(/^COL-\d{4}-\d{5}$/);
    expect(await balance(co.customers.sunrise)).toBe(before);
    const receipts = await sql('SELECT count(*)::int AS n FROM customer_receipts WHERE customer_id = $1', [co.customers.sunrise]);
    expect(receipts[0].n).toBe(0);

    // Idempotent replay from a flaky connection.
    const again = await rep().post('/sales/collections', {
      customerId: co.customers.sunrise, invoiceId: invoice.id, amount: '20.00', paymentMethod: 'CASH', clientReference: 'dev1-col-000001',
    });
    expect(again.body.replayed).toBe(true);

    // Reps cannot verify their own or anyone's collection.
    expect((await rep().post(`/sales/collections/${c.body.collection.id}/verify`)).status).toBe(403);

    const v = await acct().post(`/sales/collections/${c.body.collection.id}/verify`, { comment: 'Cash counted' });
    expect(v.status).toBe(200);
    expect(v.body.status).toBe('VERIFIED');
    expect(v.body.receipt_number).toMatch(/^RC-\d{4}-\d{5}$/);
    expect(await balance(co.customers.sunrise)).toBeCloseTo(before - 20, 2);
    const inv = (await acct().get(`/accounting/invoices/${invoice.id}`)).body;
    expect(inv.status).toBe('PARTIALLY_PAID');
    expect(inv.balance_due).toBe('32.80');

    expect((await acct().post(`/sales/collections/${c.body.collection.id}/verify`)).status).toBe(409);
  });

  it('rejects a collection with a reason and never posts it', async () => {
    const c = await rep().post('/sales/collections', { customerId: co.customers.sunrise, invoiceId: invoice.id, amount: '5.00', paymentMethod: 'KHQR', paymentReference: 'ABA-123' });
    const bad = await acct().post(`/sales/collections/${c.body.collection.id}/reject`, {});
    expect(bad.status).toBe(400);
    const rej = await acct().post(`/sales/collections/${c.body.collection.id}/reject`, { reason: 'No matching bank transfer' });
    expect(rej.body.status).toBe('REJECTED');
    const inv = (await acct().get(`/accounting/invoices/${invoice.id}`)).body;
    expect(inv.balance_due).toBe('32.80');
  });

  it('refuses collections above the invoice balance', async () => {
    const r = await rep().post('/sales/collections', { customerId: co.customers.sunrise, invoiceId: invoice.id, amount: '999', paymentMethod: 'CASH' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('AMOUNT_EXCEEDS_BALANCE');
  });

  it('settling the invoice closes the order', async () => {
    const c = await rep().post('/sales/collections', { customerId: co.customers.sunrise, invoiceId: invoice.id, amount: '32.80', paymentMethod: 'BANK_TRANSFER', paymentReference: 'TT-889' });
    await acct().post(`/sales/collections/${c.body.collection.id}/verify`);
    expect((await acct().get(`/accounting/invoices/${invoice.id}`)).body.status).toBe('PAID');
    expect((await rep().get(`/sales/orders/${orderId}`)).body.status).toBe('CLOSED');
  });

  it('cannot collect for a customer that is not assigned to the rep', async () => {
    const r = await rep().post('/sales/collections', { customerId: co.customers.other, amount: '1', paymentMethod: 'CASH' });
    expect(r.status).toBe(403);
  });
});

describe('Returns and credit notes', () => {
  it('restocks returned goods and credits the billed part', async () => {
    const o = await deliveredOrder([line(co.products.rice, '4')]); // 4 × 24 × 1.1 = 105.60
    const inv = (await acct().post(`/sales/orders/${o.id}/invoice`)).body;
    const stockBefore = await onHand(co.products.rice);
    const riceLine = o.lines[0];

    const tooMany = await rep().post('/sales/returns', { orderId: o.id, reason: 'Damaged bags', lines: [{ orderLineId: riceLine.id, quantity: '5' }] });
    expect(tooMany.status).toBe(409);

    const req = await rep().post('/sales/returns', { orderId: o.id, reason: 'Wet bags', lines: [{ orderLineId: riceLine.id, quantity: '1', restock: true }] });
    expect(req.status).toBe(201);
    expect(req.body.status).toBe('REQUESTED');
    expect((await rep().post(`/sales/returns/${req.body.id}/receive`)).status).toBe(403);

    const rec = await wh().post(`/sales/returns/${req.body.id}/receive`);
    expect(rec.status).toBe(200);
    expect(rec.body.status).toBe('RECEIVED');
    expect(rec.body.credit_note_total).toBe('26.40');
    expect(await onHand(co.products.rice)).toBe(stockBefore + 1);

    const invAfter = (await acct().get(`/accounting/invoices/${inv.id}`)).body;
    expect(invAfter.amount_credited).toBe('26.40');
    expect(invAfter.balance_due).toBe('79.20');
    const line1 = (await rep().get(`/sales/orders/${o.id}`)).body.lines[0];
    expect(Number(line1.qty_returned)).toBe(1);
    expect(Number(line1.qty_credited)).toBe(1);
  });

  it('returned goods that were never invoiced simply are not billed', async () => {
    const o = await deliveredOrder([line(co.products.oil, '4')]);
    const req = await rep().post('/sales/returns', { orderId: o.id, reason: 'Leaking', lines: [{ orderLineId: o.lines[0].id, quantity: '1', restock: false }] });
    const rec = await wh().post(`/sales/returns/${req.body.id}/receive`);
    expect(rec.body.credit_note_id).toBeNull();
    const inv = await acct().post(`/sales/orders/${o.id}/invoice`);
    expect(inv.body.lines[0].quantity).toBe('3.0000');
    expect((await rep().get(`/sales/orders/${o.id}`)).body.status).toBe('INVOICED');
  });
});

describe('Ledger integrity', () => {
  it('every journal entry balances and receivables match open documents', async () => {
    const unbalanced = await sql(`SELECT journal_entry_id FROM journal_lines GROUP BY journal_entry_id HAVING SUM(debit) <> SUM(credit)`);
    expect(unbalanced).toEqual([]);
    const tb = (await acct().get('/accounting/trial-balance')).body;
    const ar = Number(tb.find((a: { code: string }) => a.code === '1100').balance);
    const open = await sql(
      `SELECT COALESCE(SUM(outstanding), 0) AS s FROM customer_balances WHERE tenant_id = $1`,
      [co.tenantId],
    );
    expect(ar).toBeCloseTo(Number(open[0].s), 2);
  });
});
