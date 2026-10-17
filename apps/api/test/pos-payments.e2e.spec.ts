import type { INestApplication } from '@nestjs/common';
import { Api, bootApp } from './helpers';
import { createPosCompany, journalFor, key, PosCompany, sql } from './pos-helpers';

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
const manager = () => api.as(co.pos.manager);
let ref = 0;
/** 2 oil @2.50 + VAT 10% = 5.50, paid by KHQR. */
async function qrSale(as = cashier()) {
  const r = await as.post('/pos/sales', {
    clientSaleId: key(),
    registerId: co.pos.registerId,
    lines: [{ productId: co.products.oil, quantity: '2' }],
    payments: [{ methodId: co.pos.methods.KHQR, amount: '5.50', reference: `KHQR-${Date.now()}-${++ref}` }],
  });
  if (r.status !== 201) throw new Error(`sale failed: ${JSON.stringify(r.body)}`);
  return r.body.sale;
}
const settle = (saleId: string, methodId: string, amount: string, extra: Record<string, unknown> = {}) => ({
  clientPaymentId: key(),
  registerId: co.pos.registerId,
  methodId,
  amount,
  ...extra,
});

describe('POS payment verification and reconciliation', () => {
  it('confirms a KHQR payment: pending account to bank, sale becomes paid, once only', async () => {
    const s = await qrSale();
    expect(s.payment_status).toBe('PENDING_VERIFICATION');
    expect((await journalFor('POS_SALE', s.id))['1030']).toBe('5.50');
    const p = s.payments[0];

    const list = await supervisor().get('/pos/payments/pending');
    expect(list.status).toBe(200);
    expect(list.body.some((x: any) => x.id === p.id && x.sale_number === s.number)).toBe(true);

    // Cashiers cannot verify at all.
    expect((await cashier().post(`/pos/payments/${p.id}/verify`, { decision: 'CONFIRM' })).status).toBe(403);

    const ok = await supervisor().post(`/pos/payments/${p.id}/verify`, { decision: 'CONFIRM', providerTransactionId: 'ABA-778812' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('CONFIRMED');
    expect(ok.body.sale.payment_status).toBe('PAID');
    expect(await journalFor('POS_PAYMENT_VERIFIED', p.id)).toEqual({ '1010': '5.50', '1030': '-5.50' });

    const again = await supervisor().post(`/pos/payments/${p.id}/verify`, { decision: 'REJECT', notes: 'oops' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PAYMENT_ALREADY_VERIFIED');
    const details = (await supervisor().get(`/pos/sales/${s.id}`)).body;
    expect(details.payments[0].status).toBe('CONFIRMED');
    expect(details.payments[0].provider_transaction_id).toBe('ABA-778812');
  });

  it('never lets the person who took a payment verify it', async () => {
    const s = await qrSale(supervisor());
    const p = s.payments[0];
    const self = await supervisor().post(`/pos/payments/${p.id}/verify`, { decision: 'CONFIRM' });
    expect(self.status).toBe(403);
    expect((await manager().post(`/pos/payments/${p.id}/verify`, { decision: 'CONFIRM' })).status).toBe(200);
  });

  it('rejects an unpaid transfer to over/short, leaves a balance due, and settles it with change', async () => {
    const s = await qrSale();
    const p = s.payments[0];
    const noNote = await supervisor().post(`/pos/payments/${p.id}/verify`, { decision: 'REJECT' });
    expect(noNote.status).toBe(422);
    expect(noNote.body.error.code).toBe('NOTES_REQUIRED');

    const rej = await supervisor().post(`/pos/payments/${p.id}/verify`, { decision: 'REJECT', notes: 'Not on the bank statement' });
    expect(rej.status).toBe(200);
    expect(rej.body.sale).toMatchObject({ payment_status: 'BALANCE_DUE', amount_unpaid: '5.50' });
    expect(await journalFor('POS_PAYMENT_REJECTED', p.id)).toEqual({ '1030': '-5.50', '6900': '5.50' });

    // A card cannot pay more than is owed; cash can, with change.
    const over = await cashier().post(`/pos/sales/${s.id}/settle`, settle(s.id, co.pos.methods.CARD, '6.00', { reference: 'APP-1' }));
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('OVERPAYMENT');

    const shiftBefore = (await cashier().get(`/pos/shifts/${co.pos.shiftId}`)).body.expected_cash_now;
    const body = settle(s.id, co.pos.methods.CASH, '10.00');
    const paid = await cashier().post(`/pos/sales/${s.id}/settle`, body);
    expect(paid.status).toBe(201);
    expect(paid.body.change).toBe('4.50');
    expect(paid.body.sale).toMatchObject({ payment_status: 'PAID', amount_unpaid: '0.00' });
    expect(await journalFor('POS_SALE_SETTLEMENT', paid.body.paymentId)).toEqual({ '1000': '5.50', '6900': '-5.50' });
    const shiftAfter = (await cashier().get(`/pos/shifts/${co.pos.shiftId}`)).body.expected_cash_now;
    expect(Number(shiftAfter) - Number(shiftBefore)).toBeCloseTo(5.5, 2);

    // A retry returns the same payment; a second settlement finds nothing owed.
    const replay = await cashier().post(`/pos/sales/${s.id}/settle`, body);
    expect(replay.body).toMatchObject({ paymentId: paid.body.paymentId, replayed: true });
    const twice = await cashier().post(`/pos/sales/${s.id}/settle`, settle(s.id, co.pos.methods.CASH, '5.50'));
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('NOTHING_TO_SETTLE');
    expect((await sql('SELECT count(*)::int AS n FROM pos_sale_payments WHERE sale_id = $1', [s.id]))[0].n).toBe(2);
  });

  it('a balance settled by QR waits for verification again', async () => {
    const s = await qrSale();
    await supervisor().post(`/pos/payments/${s.payments[0].id}/verify`, { decision: 'REJECT', notes: 'Wrong account' });
    const r = await cashier().post(`/pos/sales/${s.id}/settle`, settle(s.id, co.pos.methods.KHQR, '5.50', { reference: `KHQR-RETRY-${Date.now()}` }));
    expect(r.status).toBe(201);
    expect(r.body.sale).toMatchObject({ payment_status: 'PENDING_VERIFICATION', amount_unpaid: '0.00' });
    expect(await journalFor('POS_SALE_SETTLEMENT', r.body.paymentId)).toEqual({ '1030': '5.50', '6900': '-5.50' });
    // Someone other than the cashier who took the settlement verifies it.
    const v = await supervisor().post(`/pos/payments/${r.body.paymentId}/verify`, { decision: 'CONFIRM' });
    expect(v.status).toBe(200);
    expect(v.body.sale.payment_status).toBe('PAID');
  });

  it('marks a flagged offline sale reviewed, by someone other than the cashier', async () => {
    const s = await qrSale();
    await sql(`UPDATE pos_sales SET review_status = 'NEEDS_REVIEW', review_reasons = '[{"code":"TOTAL_VARIANCE"}]' WHERE id = $1`, [s.id]);
    expect((await cashier().post(`/pos/sales/${s.id}/review`, { notes: 'fine' })).status).toBe(403);
    const r = await supervisor().post(`/pos/sales/${s.id}/review`, { notes: 'Price list changed while offline; accepted' });
    expect(r.status).toBe(200);
    expect(r.body.review_status).toBe('REVIEWED');
    expect((await supervisor().post(`/pos/sales/${s.id}/review`, { notes: 'again' })).status).toBe(409);
  });

  it('reconciles the day and the company ledger, and catches a tampered sale', async () => {
    // A cash sale, a return and a closed shift on top of the payments above.
    const s = (await cashier().post('/pos/sales', {
      clientSaleId: key(), registerId: co.pos.registerId,
      lines: [{ productId: co.products.oil, quantity: '1' }], payments: [{ methodId: co.pos.methods.CASH, amount: '5' }],
    })).body.sale;
    const r = await supervisor().post('/pos/returns', {
      clientReturnId: key(), saleId: s.id, registerId: co.pos.registerId, reason: 'test',
      lines: [{ saleLineId: s.lines[0].id, quantity: '1' }], refunds: [{ methodId: co.pos.methods.CASH, amount: '2.75' }],
    });
    expect(r.status).toBe(201);

    const rec = await supervisor().get('/pos/reconciliation');
    expect(rec.status).toBe(200);
    expect(rec.body.checks.filter((c: any) => !c.ok)).toEqual([]);
    expect(rec.body.ok).toBe(true);
    expect(rec.body.summary.rejected_in_period).toBeGreaterThanOrEqual(2);
    // The clearing account is company-wide: shown only to people who see every branch.
    const mgr = await manager().get('/pos/reconciliation');
    expect(mgr.body.checks.some((c: any) => c.code === 'PENDING_CLEARING_MATCHES' && c.ok)).toBe(true);

    const integrity = await api.as(co.tokens.accountant).get('/accounting/integrity');
    expect(integrity.status).toBe(200);
    const pos = integrity.body.checks.filter((c: any) => c.code.startsWith('POS_'));
    expect(pos.map((c: any) => [c.code, c.ok])).toEqual([
      ['POS_DOCUMENTS_POSTED', true],
      ['POS_PENDING_CLEARING_MATCHES', true],
    ]);
    expect(integrity.body.ok).toBe(true);

    // Someone edits a sale behind the system's back: reconciliation says which.
    await sql('UPDATE pos_sales SET grand_total = grand_total + 1 WHERE id = $1', [s.id]);
    try {
      const bad = await supervisor().get('/pos/reconciliation');
      expect(bad.body.ok).toBe(false);
      const failed = bad.body.checks.filter((c: any) => !c.ok).map((c: any) => c.code);
      expect(failed).toEqual(expect.arrayContaining(['SALES_POSTED_ONCE_AND_MATCH', 'SALE_PAYMENTS_ADD_UP']));
      expect(bad.body.checks.find((c: any) => c.code === 'SALE_PAYMENTS_ADD_UP').details[0].number).toBe(s.number);
    } finally {
      await sql('UPDATE pos_sales SET grand_total = grand_total - 1 WHERE id = $1', [s.id]);
    }
  });

  it('cannot post the same POS document twice, even directly in the database', async () => {
    const s = await qrSale();
    await expect(
      sql(
        `INSERT INTO journal_entries (tenant_id, number, entry_date, description, source_type, source_id)
         SELECT tenant_id, number || '-X', entry_date, description, source_type, source_id FROM journal_entries WHERE source_type = 'POS_SALE' AND source_id = $1`,
        [s.id],
      ),
    ).rejects.toThrow(/journal_entries_pos_source_uq/);
  });
});
