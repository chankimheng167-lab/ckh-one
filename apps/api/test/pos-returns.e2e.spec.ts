import type { INestApplication } from '@nestjs/common';
import { Api, bootApp } from './helpers';
import { createPosCompany, journalFor, key, PosCompany, sql, stockOf, SUPERVISOR_PIN } from './pos-helpers';

let app: INestApplication;
let co: PosCompany;
let api: Api;

beforeAll(async () => {
  app = await bootApp();
  co = await createPosCompany(app);
  api = new Api(app);
});
afterAll(async () => app?.close());

const cashier = () => api.as(co.pos.cashier);
const supervisor = () => api.as(co.pos.supervisor);
const pin = () => ({ userId: co.pos.supervisorId, pin: SUPERVISOR_PIN });
const cash = (amount: string) => ({ methodId: co.pos.methods.CASH, amount });
async function sell(lines: unknown[], payments: unknown[], extra: Record<string, unknown> = {}) {
  const r = await cashier().post('/pos/sales', { clientSaleId: key(), registerId: co.pos.registerId, lines, payments, ...extra });
  if (r.status !== 201) throw new Error(`sale failed: ${JSON.stringify(r.body)}`);
  return r.body.sale;
}
const ret = (saleId: string, lines: unknown[], refunds: unknown[], extra: Record<string, unknown> = {}) => ({
  clientReturnId: key(),
  saleId,
  registerId: co.pos.registerId,
  reason: 'Customer changed mind',
  lines,
  refunds,
  ...extra,
});

describe('POS returns and refunds', () => {
  it('refunds part of a discounted sale in proportion, restocks, pays from the drawer and reverses the ledger', async () => {
    // 3 oil @2.50 with 10% off the line, VAT 10%: net 6.75, tax 0.68 (rounded), total 7.43.
    const s = await sell([{ productId: co.products.oil, quantity: '3', discountPercent: '10' }], [cash('10')], { approval: pin() });
    expect(s.grand_total).toBe('7.43');
    const line = s.lines[0];
    const stockBefore = Number(await stockOf(co.warehouseId, co.products.oil));
    const cashBefore = (await cashier().get(`/pos/shifts/${co.pos.shiftId}`)).body.expected_cash_now;

    const r1 = await supervisor().post('/pos/returns', ret(s.id, [{ saleLineId: line.id, quantity: '1' }], [cash('2.48')]));
    expect(r1.status).toBe(201);
    const a = r1.body.return;
    expect(a.number).toMatch(/^PRT-\d{4}-\d{6}$/);
    expect(a.refund_total).toBe('2.48');
    expect(Number(await stockOf(co.warehouseId, co.products.oil))).toBe(stockBefore + 1);
    const after = (await cashier().get(`/pos/shifts/${co.pos.shiftId}`)).body;
    expect(Number(after.expected_cash_now)).toBeCloseTo(Number(cashBefore) - 2.48, 2);
    expect(after.movements.some((m: any) => m.movement_type === 'REFUND' && m.amount === '-2.48')).toBe(true);
    // Dr revenue 2.50 · Cr discount 0.25 · Dr VAT 0.23 · Cr cash 2.48 · Dr inventory / Cr COGS at sale cost.
    const j = await journalFor('POS_RETURN', a.id);
    expect(j['4000']).toBe('2.50');
    expect(j['4100']).toBe('-0.25');
    expect(j['2100']).toBe('0.23');
    expect(j['1000']).toBe('-2.48');
    expect(Number(j['1200'])).toBeGreaterThan(0);
    expect(Number(j['1200']) + Number(j['5000'])).toBe(0);

    // Returning the rest adds up to exactly what was paid.
    const r2 = await supervisor().post('/pos/returns', ret(s.id, [{ saleLineId: line.id, quantity: '2' }], [cash('4.95')]));
    expect(r2.status).toBe(201);
    const sale = (await supervisor().get(`/pos/sales/${s.id}`)).body;
    expect(sale.status).toBe('REFUNDED');
    expect(sale.refunded_total).toBe('7.43');
    expect(sale.lines[0].quantity_returned).toBe('3.0000');

    const more = await supervisor().post('/pos/returns', ret(s.id, [{ saleLineId: line.id, quantity: '1' }], [cash('2.48')]));
    expect(more.status).toBe(422);
    expect(more.body.error.code).toBe('RETURN_QUANTITY_INVALID');
  });

  it('needs refund permission or a supervisor PIN', async () => {
    const s = await sell([{ productId: co.products.oil, quantity: '1' }], [cash('5')]);
    const body = ret(s.id, [{ saleLineId: s.lines[0].id, quantity: '1' }], [cash('2.75')]);
    const no = await cashier().post('/pos/returns', body);
    expect(no.status).toBe(403);
    expect(no.body.error.code).toBe('APPROVAL_REQUIRED');
    const wrong = await cashier().post('/pos/returns', { ...body, approval: { userId: co.pos.supervisorId, pin: '0000' } });
    expect(wrong.status).toBe(403);
    const ok = await cashier().post('/pos/returns', { ...body, approval: pin() });
    expect(ok.status).toBe(201);
    expect(ok.body.return.approved_by_name).toBeTruthy();
    expect(ok.body.return.processed_by_name).toBe('cashier');
  });

  it('refunds only to the methods paid with, within what each paid, and never to an unverified transfer', async () => {
    const s = await sell(
      [{ productId: co.products.rice, quantity: '1' }],
      [{ methodId: co.pos.methods.CARD, amount: '20.00', reference: 'APP-77' }, cash('10')],
    );
    expect(s.grand_total).toBe('26.40');
    const l = [{ saleLineId: s.lines[0].id, quantity: '1' }];
    const mismatch = await supervisor().post('/pos/returns', ret(s.id, l, [cash('20')]));
    expect(mismatch.body.error.code).toBe('REFUND_TOTAL_MISMATCH');
    const tooMuchCash = await supervisor().post('/pos/returns', ret(s.id, l, [cash('26.40')]));
    expect(tooMuchCash.body.error.code).toBe('REFUND_EXCEEDS_PAYMENT');
    const notUsed = await supervisor().post('/pos/returns', ret(s.id, l, [{ methodId: co.pos.methods.BANK, amount: '26.40', reference: 'X1' }]));
    expect(notUsed.body.error.code).toBe('REFUND_METHOD_NOT_ALLOWED');
    const noRef = await supervisor().post('/pos/returns', ret(s.id, l, [{ methodId: co.pos.methods.CARD, amount: '20.00' }, cash('6.40')]));
    expect(noRef.body.error.code).toBe('REFERENCE_REQUIRED');
    const cardNo = await supervisor().post('/pos/returns', ret(s.id, l, [{ methodId: co.pos.methods.CARD, amount: '20.00', reference: '4111 1111 1111 1111' }, cash('6.40')]));
    expect(cardNo.body.error.code).toBe('CARD_NUMBER_NOT_ALLOWED');
    const ok = await supervisor().post('/pos/returns', ret(s.id, l, [{ methodId: co.pos.methods.CARD, amount: '20.00', reference: 'RF-77' }, cash('6.40')]));
    expect(ok.status).toBe(201);
    const j = await journalFor('POS_RETURN', ok.body.return.id);
    expect(j['1020']).toBe('-20.00');
    expect(j['1000']).toBe('-6.40');

    const qr = await sell([{ productId: co.products.oil, quantity: '1' }], [{ methodId: co.pos.methods.KHQR, amount: '2.75', reference: `KHQR-${Date.now()}` }]);
    const pending = await supervisor().post('/pos/returns', ret(qr.id, [{ saleLineId: qr.lines[0].id, quantity: '1' }], [{ methodId: co.pos.methods.KHQR, amount: '2.75', reference: 'R' }]));
    expect(pending.status).toBe(409);
    expect(pending.body.error.code).toBe('PAYMENT_NOT_VERIFIED');
  });

  it('keeps damaged goods off the shelf and leaves their cost expensed', async () => {
    await api.as(co.tokens.admin).post('/masterdata/stock/receipts', { warehouseId: co.warehouseId, lines: [{ productId: co.products.water, quantity: '10', unitCost: '2' }] });
    const s = await sell([{ productId: co.products.water, quantity: '2' }], [cash('10')]);
    const before = await stockOf(co.warehouseId, co.products.water);
    const p = await supervisor().post('/pos/returns/preview', { saleId: s.id, lines: [{ saleLineId: s.lines[0].id, quantity: '1' }] });
    const r = await supervisor().post('/pos/returns', ret(s.id, [{ saleLineId: s.lines[0].id, quantity: '1', restock: false }], [cash(p.body.refundTotal)], { reason: 'Broken bottle' }));
    expect(r.status).toBe(201);
    expect(await stockOf(co.warehouseId, co.products.water)).toBe(before);
    const j = await journalFor('POS_RETURN', r.body.return.id);
    expect(j['1200']).toBeUndefined();
    expect(j['5000']).toBeUndefined();
    expect(r.body.return.lines[0].restock).toBe(false);
  });

  it('takes a serial back so it can be sold again, and checks the serial was on the sale', async () => {
    const admin = api.as(co.tokens.admin);
    const phone = (await admin.post('/masterdata/products', { sku: `PH-${Date.now()}`, name: 'Phone X', listPrice: '100.00', serialTracked: true })).body.id;
    await admin.post('/masterdata/stock/receipts', { warehouseId: co.warehouseId, lines: [{ productId: phone, quantity: '2', unitCost: '70' }] });
    const two = await sell([{ productId: phone, quantity: '2', serialNumbers: ['IMEI-1', 'IMEI-2'] }], [cash('220')]);
    const first = await supervisor().post('/pos/returns', ret(two.id, [{ saleLineId: two.lines[0].id, quantity: '1', serialNumbers: ['IMEI-1'] }], [cash('110.00')]));
    expect(first.status).toBe(201);
    const twice = await supervisor().post('/pos/returns', ret(two.id, [{ saleLineId: two.lines[0].id, quantity: '1', serialNumbers: ['IMEI-1'] }], [cash('110.00')]));
    expect(twice.body.error.code).toBe('SERIAL_ALREADY_RETURNED');
    expect((await supervisor().get(`/pos/sales/${two.id}/returnable`)).body.lines[0].serialNumbers).toEqual(['IMEI-2']);
    await admin.post('/masterdata/stock/receipts', { warehouseId: co.warehouseId, lines: [{ productId: phone, quantity: '1', unitCost: '70' }] });
    const s = await sell([{ productId: phone, quantity: '1', serialNumbers: ['IMEI-9'] }], [cash('110')]);
    const wrong = await supervisor().post('/pos/returns', ret(s.id, [{ saleLineId: s.lines[0].id, quantity: '1', serialNumbers: ['IMEI-8'] }], [cash('110.00')]));
    expect(wrong.body.error.code).toBe('SERIAL_NOT_ON_SALE');
    const missing = await supervisor().post('/pos/returns', ret(s.id, [{ saleLineId: s.lines[0].id, quantity: '1' }], [cash('110.00')]));
    expect(missing.body.error.code).toBe('SERIALS_REQUIRED');
    const ok = await supervisor().post('/pos/returns', ret(s.id, [{ saleLineId: s.lines[0].id, quantity: '1', serialNumbers: ['imei-9'] }], [cash('110.00')]));
    expect(ok.status).toBe(201);
    const again = await sell([{ productId: phone, quantity: '1', serialNumbers: ['IMEI-9'] }], [cash('110')]);
    expect(again.lines[0].serial_numbers).toEqual(['IMEI-9']);
  });

  it('records a return once, however often the till retries it', async () => {
    const s = await sell([{ productId: co.products.oil, quantity: '2' }], [cash('10')]);
    const body = ret(s.id, [{ saleLineId: s.lines[0].id, quantity: '1' }], [cash('2.75')]);
    const a = await supervisor().post('/pos/returns', body);
    const b = await supervisor().post('/pos/returns', body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.replayed).toBe(true);
    expect(b.body.return.id).toBe(a.body.return.id);
    expect(await sql(`SELECT 1 FROM pos_returns WHERE sale_id = $1`, [s.id])).toHaveLength(1);
    const other = await supervisor().post('/pos/returns', { ...body, lines: [{ saleLineId: s.lines[0].id, quantity: '2' }], refunds: [cash('5.50')] });
    expect(other.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('does not pay out more cash than the drawer holds', async () => {
    const s = await sell([{ productId: co.products.rice, quantity: '20' }], [cash('600')]);
    // Take nearly everything out of the drawer, then try to refund in cash.
    const shift = (await cashier().get(`/pos/shifts/${co.pos.shiftId}`)).body;
    await supervisor().post(`/pos/shifts/${co.pos.shiftId}/cash-movements`, { type: 'CASH_OUT', amount: (Number(shift.expected_cash_now) - 10).toFixed(2), reason: 'Bank deposit' });
    const r = await supervisor().post('/pos/returns', ret(s.id, [{ saleLineId: s.lines[0].id, quantity: '1' }], [cash('26.40')]));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('NOT_ENOUGH_CASH');
  });

  it('looks a receipt up by its number and shows what can still be returned', async () => {
    const s = await sell([{ productId: co.products.oil, quantity: '2' }], [cash('10')]);
    const r = await cashier().get(`/pos/sales/by-number/${s.number.toLowerCase()}`);
    expect(r.body.found).toBe(true);
    expect(r.body.lines[0]).toMatchObject({ remaining: '2', refundIfAll: '5.50' });
    expect(r.body.methods[0]).toMatchObject({ name: 'Cash', available: '5.50' });
    const p = await cashier().post('/pos/returns/preview', { saleId: s.id, lines: [{ saleLineId: s.lines[0].id, quantity: '1' }] });
    expect(p.body.refundTotal).toBe('2.75');
    expect((await cashier().get('/pos/sales/by-number/POS-1999-000001')).body.found).toBe(false);
  });
});

describe('POS receipts', () => {
  it('prints the original once, then reprints only with permission, marked as a reprint', async () => {
    const s = await sell([{ productId: co.products.oil, quantity: '2' }], [cash('10')]);
    const first = await cashier().post(`/pos/sales/${s.id}/receipt`, { format: 'json' });
    expect(first.status).toBe(200);
    expect(first.body.copyNo).toBe(1);
    const m = first.body.receipt;
    expect(m).toMatchObject({ kind: 'SALE', reprint: false, number: s.number, currency: 'USD' });
    expect(m.totals).toMatchObject({ subtotal: '5.00', tax: '0.50', total: '5.50' });
    expect(m.payments[0]).toMatchObject({ method: 'Cash', amount: '5.50' });
    expect(m.change).toBe('4.50');

    const again = await cashier().post(`/pos/sales/${s.id}/receipt`, { format: 'html' });
    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe('APPROVAL_REQUIRED');
    const approved = await cashier().post(`/pos/sales/${s.id}/receipt`, { format: 'html', approval: pin() });
    expect(approved.status).toBe(200);
    expect(approved.headers['content-type']).toMatch(/text\/html/);
    expect(approved.text).toContain('REPRINT');
    expect(approved.text).toContain(s.number);
    expect(approved.headers['x-receipt-copy']).toBe('2');
    const log = await sql(`SELECT kind, copy_no FROM pos_receipts WHERE sale_id = $1 ORDER BY copy_no`, [s.id]);
    expect(log).toEqual([{ kind: 'ORIGINAL', copy_no: 1 }, { kind: 'REPRINT', copy_no: 2 }]);
    expect(await sql(`SELECT 1 FROM audit_log WHERE action = 'POS_RECEIPT_REPRINTED' AND entity_id = $1`, [s.id])).toHaveLength(1);
  });

  it('renders 58 mm text within 32 columns, 80 mm within 48, and A4 as a table', async () => {
    const s = await sell([{ productId: co.products.rice, quantity: '1' }, { productId: co.products.oil, quantity: '1' }], [cash('50')]);
    const t58 = await supervisor().post(`/pos/sales/${s.id}/receipt`, { format: 'text', paper: '58' });
    expect(t58.status).toBe(200);
    const lines58 = t58.text.split('\n');
    expect(Math.max(...lines58.map((l: string) => l.length))).toBeLessThanOrEqual(32);
    expect(t58.text).toContain('29.15');
    const t80 = await supervisor().post(`/pos/sales/${s.id}/receipt`, { format: 'text', paper: '80' });
    expect(Math.max(...t80.text.split('\n').map((l: string) => l.length))).toBeLessThanOrEqual(48);
    const a4 = await supervisor().post(`/pos/sales/${s.id}/receipt`, { format: 'html', paper: 'A4' });
    expect(a4.text).toContain('size: A4');
    expect(a4.text).toContain('<th class="r">Qty</th>');
  });

  it('prints Khmer and Chinese receipts as HTML, refuses them as plain text, and makes English PDFs', async () => {
    const s = await sell([{ productId: co.products.oil, quantity: '1' }], [cash('5')]);
    const km = await supervisor().post(`/pos/sales/${s.id}/receipt`, { format: 'html', language: 'km' });
    expect(km.status).toBe(200);
    expect(km.text).toContain('បង្កាន់ដៃ');
    expect(km.text).toContain('lang="km"');
    const zh = await supervisor().post(`/pos/sales/${s.id}/receipt`, { format: 'html', language: 'zh' });
    expect(zh.text).toContain('收据');
    const kmText = await supervisor().post(`/pos/sales/${s.id}/receipt`, { format: 'text', language: 'km' });
    expect(kmText.body.error.code).toBe('TEXT_RECEIPT_LATIN_ONLY');
    const pdf = await supervisor().post(`/pos/sales/${s.id}/receipt`, { format: 'pdf', language: 'en', paper: '80' }).buffer(true);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(pdf.body).subarray(0, 4).toString()).toBe('%PDF');
    const kmPdf = await supervisor().post(`/pos/sales/${s.id}/receipt`, { format: 'pdf', language: 'km' });
    expect(kmPdf.body.error.code).toBe('PDF_FONT_MISSING');
  });

  it('uses the company receipt header, footer and bilingual labels from POS settings', async () => {
    await api.as(co.tokens.admin).put('/pos/admin/settings', {
      receipt: { languages: ['km', 'en'], header: { en: 'Open 7am-9pm', km: 'បើក ៧ព្រឹក' }, footer: { en: 'No returns after 7 days' } },
    });
    const s = await sell([{ productId: co.products.oil, quantity: '1' }], [cash('5')]);
    const r = await supervisor().post(`/pos/sales/${s.id}/receipt`, { format: 'json' });
    expect(r.body.receipt.languages).toEqual(['km', 'en']);
    expect(r.body.receipt.labels.total).toBe('សរុប / Total');
    expect(r.body.receipt.header).toBe('បើក ៧ព្រឹក\nOpen 7am-9pm');
    expect(r.body.receipt.footer).toBe('No returns after 7 days');
    await api.as(co.tokens.admin).put('/pos/admin/settings', { receipt: { languages: ['en'], header: {}, footer: { en: 'Thank you!' } } });
  });

  it('prints a refund slip for a return', async () => {
    const s = await sell([{ productId: co.products.oil, quantity: '2' }], [cash('10')]);
    const r = await supervisor().post('/pos/returns', ret(s.id, [{ saleLineId: s.lines[0].id, quantity: '1' }], [cash('2.75')]));
    const slip = await supervisor().post(`/pos/returns/${r.body.return.id}/receipt`, { format: 'json' });
    expect(slip.status).toBe(200);
    expect(slip.body.receipt).toMatchObject({ kind: 'REFUND', number: r.body.return.number, saleNumber: s.number, reason: 'Customer changed mind' });
    expect(slip.body.receipt.totals.total).toBe('2.75');
  });

  it('keeps other cashiers from printing someone else’s receipt', async () => {
    const s = await sell([{ productId: co.products.oil, quantity: '1' }], [cash('5')]);
    const r = await api.as(co.pos.cashier2).post(`/pos/sales/${s.id}/receipt`, { format: 'json' });
    expect(r.status).toBe(404);
  });
});

describe('POS daily sales report', () => {
  it('adds up sales, refunds, payment methods and tax for the day, and exports CSV', async () => {
    const day = (await cashier().get('/pos/context')).body.businessDate;
    const r = await supervisor().get(`/pos/reports/daily?date=${day}`);
    expect(r.status).toBe(200);
    const sales = await sql<{ n: number; total: string; tax: string }>(
      `SELECT count(*)::int AS n, sum(grand_total)::text AS total, sum(tax_total)::text AS tax FROM pos_sales WHERE tenant_id = $1 AND business_date = $2`,
      [co.tenantId, day],
    );
    const refunds = await sql<{ total: string }>(`SELECT COALESCE(sum(refund_total), 0)::text AS total FROM pos_returns WHERE tenant_id = $1 AND business_date = $2`, [co.tenantId, day]);
    expect(r.body.summary.receipts).toBe(sales[0].n);
    expect(r.body.summary.gross_sales).toBe(sales[0].total);
    expect(r.body.summary.refunds).toBe(refunds[0].total);
    expect(Number(r.body.summary.net_after_refunds)).toBeCloseTo(Number(sales[0].total) - Number(refunds[0].total), 2);
    const cashRow = r.body.byMethod.find((m: any) => m.code === 'CASH');
    expect(Number(cashRow.refunds)).toBeGreaterThan(0);
    expect(Number(r.body.tax[0].rate)).toBe(10);
    expect(r.body.shifts.some((s: any) => s.id === co.pos.shiftId)).toBe(true);

    const csv = await supervisor().get(`/pos/reports/daily?date=${day}&format=csv`);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('By payment method');

    const denied = await cashier().get(`/pos/reports/daily?date=${day}`);
    expect(denied.status).toBe(403);
  });
});
