import type { INestApplication } from '@nestjs/common';
import { Api, bootApp, rootApi } from './helpers';
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
const sale = (lines: unknown[], payments: unknown[], extra: Record<string, unknown> = {}) => ({
  clientSaleId: key(),
  registerId: co.pos.registerId,
  lines,
  payments,
  ...extra,
});
const cash = (amount: string) => ({ methodId: co.pos.methods.CASH, amount });

describe('POS cash checkout', () => {
  it('prices on the server, deducts stock, records the drawer and posts a balanced journal', async () => {
    const before = await stockOf(co.warehouseId, co.products.rice);
    const r = await cashier().post('/pos/sales', sale([{ productId: co.products.rice, quantity: '4' }], [cash('110')], { expectedTotal: '105.60' }));
    expect(r.status).toBe(201);
    const s = r.body.sale;
    expect(s.number).toMatch(/^POS-\d{4}-\d{6}$/);
    // Rice from the default price list (24.00), VAT 10% on top.
    expect(s.lines[0].unit_price).toBe('24.0000');
    expect(s.lines[0].price_source).toBe('PRICE_LIST');
    expect(s.subtotal).toBe('96.00');
    expect(s.tax_total).toBe('9.60');
    expect(s.grand_total).toBe('105.60');
    expect(s.amount_tendered).toBe('110.00');
    expect(s.change_due).toBe('4.40');
    expect(s.payments).toHaveLength(1);
    expect(s.payments[0].amount).toBe('105.60');
    expect(s.payment_status).toBe('PAID');

    expect(Number(await stockOf(co.warehouseId, co.products.rice))).toBe(Number(before) - 4);
    const mv = await sql('SELECT movement_type, quantity, unit_cost FROM stock_movements WHERE reference_id = $1', [s.id]);
    expect(mv).toEqual([{ movement_type: 'POS_SALE', quantity: '-4.0000', unit_cost: '18.000000' }]);

    // Dr cash 105.60 · Cr revenue 96.00 · Cr VAT 9.60 · Dr COGS 72.00 · Cr inventory 72.00
    expect(await journalFor('POS_SALE', s.id)).toEqual({ '1000': '105.60', '1200': '-72.00', '2100': '-9.60', '4000': '-96.00', '5000': '72.00' });

    const shift = await cashier().get(`/pos/shifts/${co.pos.shiftId}`);
    expect(shift.body.expected_cash_now).toBe('205.60');
  });

  it('ignores totals sent by the till and refuses a stale expected total', async () => {
    const r = await cashier().post('/pos/sales', sale([{ productId: co.products.oil, quantity: '2' }], [cash('10')], { expectedTotal: '1.00', grandTotal: '1.00' }));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('TOTAL_CHANGED');
    expect(r.body.error.details.grandTotal).toBe('5.50');
  });

  it('refuses to sell more than is in stock and records nothing', async () => {
    const id = key();
    const before = await stockOf(co.warehouseId, co.products.oil);
    const r = await cashier().post('/pos/sales', { ...sale([{ productId: co.products.oil, quantity: '9999' }], [cash('99999')]), clientSaleId: id });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(co.warehouseId, co.products.oil)).toBe(before);
    expect(await sql('SELECT 1 FROM pos_sales WHERE client_sale_id = $1', [id])).toHaveLength(0);
  });

  it('needs an open shift on the register', async () => {
    const r = await cashier().post('/pos/sales', { ...sale([{ productId: co.products.oil, quantity: '1' }], [cash('5')]), registerId: co.pos.register2Id });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('SHIFT_NOT_OPEN');
  });

  it('does not let another cashier sell on someone else’s shift', async () => {
    const r = await api.as(co.pos.cashier2).post('/pos/sales', sale([{ productId: co.products.oil, quantity: '1' }], [cash('5')]));
    expect(r.status).toBe(403);
  });
});

describe('POS discounts and price overrides', () => {
  it('lets a cashier discount within their limit', async () => {
    const r = await cashier().post('/pos/sales', sale([{ productId: co.products.oil, quantity: '2', discountPercent: '5' }], [cash('6')]));
    expect(r.status).toBe(201);
    expect(r.body.sale.discount_total).toBe('0.25');
    expect(r.body.sale.grand_total).toBe('5.23');
    expect(r.body.sale.discount_approved_by).toBeNull();
  });

  it('asks for a supervisor above the cashier limit and rejects a wrong PIN', async () => {
    const body = sale([{ productId: co.products.oil, quantity: '2', discountPercent: '20' }], [cash('6')]);
    const q = await cashier().post('/pos/quote', { registerId: co.pos.registerId, lines: body.lines });
    expect(q.body.approvalRequired).toEqual(['pos.discount.override']);

    const none = await cashier().post('/pos/sales', body);
    expect(none.status).toBe(403);
    expect(none.body.error.code).toBe('APPROVAL_REQUIRED');
    expect(none.body.error.details.missingPermissions).toEqual(['pos.discount.override']);

    const wrong = await cashier().post('/pos/sales', { ...body, approval: { userId: co.pos.supervisorId, pin: '1111' } });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('APPROVAL_INVALID');

    const right = await cashier().post('/pos/sales', { ...body, approval: { userId: co.pos.supervisorId, pin: SUPERVISOR_PIN } });
    expect(right.status).toBe(201);
    expect(right.body.sale.discount_approved_by).toBe(co.pos.supervisorId);
    expect(right.body.sale.discount_total).toBe('1.00');
    const audit = await sql(`SELECT after_data FROM audit_log WHERE entity_id = $1 AND action = 'POS_SALE_COMPLETED'`, [right.body.sale.id]);
    expect(audit[0].after_data.approvedBy).toBe(co.pos.supervisorId);
  });

  it('never allows a discount above the company maximum, even with approval', async () => {
    const r = await cashier().post(
      '/pos/sales',
      sale([{ productId: co.products.oil, quantity: '1', discountPercent: '60' }], [cash('5')], { approval: { userId: co.pos.supervisorId, pin: SUPERVISOR_PIN } }),
    );
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('DISCOUNT_ABOVE_LIMIT');
  });

  it('treats a changed unit price as a price override that needs approval', async () => {
    const lines = [{ productId: co.products.oil, quantity: '1', unitPrice: '2.00' }];
    const no = await cashier().post('/pos/sales', sale(lines, [cash('5')]));
    expect(no.status).toBe(403);
    expect(no.body.error.details.missingPermissions).toEqual(['pos.price.override']);
    const yes = await cashier().post('/pos/sales', sale(lines, [cash('5')], { approval: { userId: co.pos.supervisorId, pin: SUPERVISOR_PIN } }));
    expect(yes.status).toBe(201);
    expect(yes.body.sale.lines[0].price_source).toBe('OVERRIDE');
    expect(yes.body.sale.lines[0].list_unit_price).toBe('2.5000');
    expect(yes.body.sale.grand_total).toBe('2.20');
  });

  it('spreads an order discount over the lines and still balances the ledger', async () => {
    const r = await cashier().post(
      '/pos/sales',
      sale(
        [{ productId: co.products.oil, quantity: '1' }, { productId: co.products.rice, quantity: '1' }],
        [cash('30')],
        { orderDiscountAmount: '1.00' },
      ),
    );
    expect(r.status).toBe(201);
    const s = r.body.sale;
    expect(s.order_discount_total).toBe('1.00');
    expect(s.lines.map((l: any) => l.order_discount_share)).toEqual(['0.09', '0.91']);
    expect(s.grand_total).toBe('28.05'); // (26.50 − 1.00) + 10% VAT
    const j = await journalFor('POS_SALE', s.id);
    expect(j['4100']).toBe('1.00');
    const total = Object.values(j).reduce((a, v) => a + Math.round(Number(v) * 100), 0);
    expect(total).toBe(0);
  });
});

describe('POS split payments', () => {
  it('takes card and cash together and gives change from the cash', async () => {
    const r = await cashier().post(
      '/pos/sales',
      sale([{ productId: co.products.rice, quantity: '1' }], [{ methodId: co.pos.methods.CARD, amount: '20', reference: 'APPR-77812' }, cash('10')]),
    );
    expect(r.status).toBe(201);
    const s = r.body.sale;
    expect(s.grand_total).toBe('26.40');
    expect(s.change_due).toBe('3.60');
    expect(s.payments.map((p: any) => [p.kind, p.amount_tendered, p.amount])).toEqual([['CARD', '20.00', '20.00'], ['CASH', '10.00', '6.40']]);
    const j = await journalFor('POS_SALE', s.id);
    expect(j['1020']).toBe('20.00');
    expect(j['1000']).toBe('6.40');
  });

  it('requires the card approval code and refuses card numbers', async () => {
    const lines = [{ productId: co.products.oil, quantity: '1' }];
    const noRef = await cashier().post('/pos/sales', sale(lines, [{ methodId: co.pos.methods.CARD, amount: '2.75' }]));
    expect(noRef.body.error.code).toBe('REFERENCE_REQUIRED');
    const pan = await cashier().post('/pos/sales', sale(lines, [{ methodId: co.pos.methods.CARD, amount: '2.75', reference: '4111 1111 1111 1111' }]));
    expect(pan.body.error.code).toBe('CARD_NUMBER_NOT_ALLOWED');
  });

  it('prevents overpaying by card and underpaying', async () => {
    const lines = [{ productId: co.products.oil, quantity: '1' }];
    const over = await cashier().post('/pos/sales', sale(lines, [{ methodId: co.pos.methods.CARD, amount: '5', reference: 'A1' }]));
    expect(over.status).toBe(422);
    expect(over.body.error.message).toMatch(/cannot be more/);
    const under = await cashier().post('/pos/sales', sale(lines, [cash('1')]));
    expect(under.status).toBe(422);
    expect(under.body.error.message).toMatch(/do not cover/);
  });

  it('keeps KHQR payments pending until verified and never accepts the same transfer twice', async () => {
    const lines = [{ productId: co.products.oil, quantity: '2' }];
    const r = await cashier().post('/pos/sales', sale(lines, [{ methodId: co.pos.methods.KHQR, amount: '5.50', reference: 'KHQR-0001' }]));
    expect(r.status).toBe(201);
    expect(r.body.sale.payment_status).toBe('PENDING_VERIFICATION');
    expect(r.body.sale.payments[0].status).toBe('PENDING_VERIFICATION');
    const j = await journalFor('POS_SALE', r.body.sale.id);
    expect(j['1030']).toBe('5.50');
    expect(j['1010']).toBeUndefined();

    const dup = await cashier().post('/pos/sales', sale(lines, [{ methodId: co.pos.methods.KHQR, amount: '5.50', reference: 'khqr-0001' }]));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE');
  });

  it('never lets a bank or QR method skip verification, or a card method skip the approval code', async () => {
    const admin = api.as(co.tokens.admin);
    const qr = await admin.post('/pos/admin/payment-methods', { code: 'ABA_QR', name: 'ABA QR', kind: 'QR', requiresReference: true, requiresVerification: false });
    expect(qr.status).toBe(422);
    expect(qr.body.error.code).toBe('VERIFICATION_REQUIRED');
    const off = await admin.put(`/pos/admin/payment-methods/${co.pos.methods.KHQR}`, { requiresVerification: false });
    expect(off.body.error.code).toBe('VERIFICATION_REQUIRED');
    const card = await admin.put(`/pos/admin/payment-methods/${co.pos.methods.CARD}`, { requiresReference: false });
    expect(card.body.error.code).toBe('REFERENCE_REQUIRED');
    const offline = await admin.put(`/pos/admin/payment-methods/${co.pos.methods.CARD}`, { allowOffline: true });
    expect(offline.body.error.code).toBe('OFFLINE_CASH_ONLY');
    // The database holds the same line if the API is bypassed.
    await expect(sql(`UPDATE pos_payment_methods SET requires_verification = false WHERE id = $1`, [co.pos.methods.KHQR])).rejects.toThrow(/check constraint/);
  });
});

describe('POS duplicate transaction prevention', () => {
  it('returns the stored sale on retry and deducts stock once', async () => {
    const before = Number(await stockOf(co.warehouseId, co.products.oil));
    const body = sale([{ productId: co.products.oil, quantity: '3' }], [cash('10')]);
    const [a, b] = await Promise.all([cashier().post('/pos/sales', body), cashier().post('/pos/sales', body)]);
    expect([a.status, b.status].sort()).toEqual([201, 201]);
    expect(a.body.sale.id).toBe(b.body.sale.id);
    expect([a.body.replayed, b.body.replayed].sort()).toEqual([false, true]);
    const c = await cashier().post('/pos/sales', body);
    expect(c.body.replayed).toBe(true);
    expect(Number(await stockOf(co.warehouseId, co.products.oil))).toBe(before - 3);
    expect(await sql(`SELECT 1 FROM journal_entries WHERE source_type = 'POS_SALE' AND source_id = $1`, [a.body.sale.id])).toHaveLength(1);
    expect(await sql(`SELECT 1 FROM pos_cash_movements WHERE reference_id = $1`, [a.body.sale.id])).toHaveLength(1);
  });

  it('refuses the same sale id for a different sale', async () => {
    const body = sale([{ productId: co.products.oil, quantity: '1' }], [cash('5')]);
    expect((await cashier().post('/pos/sales', body)).status).toBe(201);
    const r = await cashier().post('/pos/sales', { ...body, lines: [{ productId: co.products.oil, quantity: '2' }], payments: [cash('10')] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('POS catalogue, variants, serials and held sales', () => {
  let shirt: string;
  let shirtM: string;
  let phone: string;

  beforeAll(async () => {
    const admin = api.as(co.tokens.admin);
    const cat = (await admin.post('/masterdata/categories', { code: 'APPAREL', name: 'Apparel' })).body;
    shirt = (await admin.post('/masterdata/products', { sku: 'TEE', name: 'T-shirt', listPrice: '8.00', categoryId: cat.id })).body.id;
    shirtM = (
      await admin.post('/masterdata/products', { sku: 'TEE-M-RED', name: 'T-shirt M Red', listPrice: '8.00', barcode: '8850001000017', parentProductId: shirt, variantAttributes: { size: 'M', colour: 'Red' }, categoryId: cat.id, reorderPoint: '3' })
    ).body.id;
    await admin.post('/masterdata/products', { sku: 'TEE-L-RED', name: 'T-shirt L Red', listPrice: '8.50', parentProductId: shirt, variantAttributes: { size: 'L', colour: 'Red' }, categoryId: cat.id });
    phone = (await admin.post('/masterdata/products', { sku: 'PHONE', name: 'Phone', listPrice: '100.00', serialTracked: true })).body.id;
    await admin.post('/masterdata/stock/receipts', { warehouseId: co.warehouseId, lines: [{ productId: shirtM, quantity: '5', unitCost: '3' }, { productId: phone, quantity: '3', unitCost: '70' }] });
  });

  it('lists a product with variants once, then its sizes and colours', async () => {
    const list = await cashier().get(`/pos/catalog?registerId=${co.pos.registerId}&q=t-shirt`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].variant_count).toBe(2);
    expect(list.body.items[0].price_from).toBe('8.0000');
    const p = await cashier().get(`/pos/catalog/products/${shirt}?registerId=${co.pos.registerId}`);
    expect(p.body.variant_options).toEqual({ size: ['L', 'M'], colour: ['Red'] });
    expect(p.body.variants.find((v: any) => v.id === shirtM).available).toBe('5.0000');
  });

  it('scans a variant barcode and refuses to sell the template', async () => {
    const s = await cashier().get(`/pos/catalog/barcode/8850001000017?registerId=${co.pos.registerId}`);
    expect(s.status).toBe(200);
    expect(s.body.id).toBe(shirtM);
    expect(s.body.price).toBe('8.0000');
    const r = await cashier().post('/pos/sales', sale([{ productId: shirt, quantity: '1' }], [cash('10')]));
    expect(r.body.error.code).toBe('VARIANT_REQUIRED');
    const nf = await cashier().get(`/pos/catalog/barcode/000?registerId=${co.pos.registerId}`);
    expect(nf.status).toBe(404);
  });

  it('warns when a sale takes a product to its reorder point', async () => {
    const r = await cashier().post('/pos/sales', sale([{ productId: shirtM, quantity: '2' }], [cash('20')]));
    expect(r.status).toBe(201);
    expect(r.body.warnings.map((w: any) => w.code)).toEqual(['LOW_STOCK']);
  });

  it('requires one serial per unit and never sells a serial twice', async () => {
    const miss = await cashier().post('/pos/sales', sale([{ productId: phone, quantity: '1' }], [cash('110')]));
    expect(miss.body.error.code).toBe('SERIALS_REQUIRED');
    const ok = await cashier().post('/pos/sales', sale([{ productId: phone, quantity: '1', serialNumbers: ['SN-1'] }], [cash('110')]));
    expect(ok.status).toBe(201);
    const again = await cashier().post('/pos/sales', sale([{ productId: phone, quantity: '1', serialNumbers: ['SN-1'] }], [cash('110')]));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SERIAL_ALREADY_SOLD');
    // The till learns it while building the cart (any letter case), before taking payment.
    const quote = await cashier().post('/pos/quote', { registerId: co.pos.registerId, lines: [{ productId: phone, quantity: '1', serialNumbers: ['sn-1'] }] });
    expect(quote.status).toBe(409);
    expect(quote.body.error.code).toBe('SERIAL_ALREADY_SOLD');
  });

  it('holds a cart, lists it, resumes it once and cancels another', async () => {
    const cart = { registerId: co.pos.registerId, lines: [{ productId: co.products.oil, quantity: '2' }] };
    const h = await cashier().post('/pos/held-sales', { label: 'Lady in blue', cart });
    expect(h.status).toBe(201);
    expect(h.body.estimated_total).toBe('5.50');
    const list = await cashier().get(`/pos/held-sales?registerId=${co.pos.registerId}`);
    expect(list.body.map((x: any) => x.id)).toContain(h.body.id);
    const r = await cashier().post(`/pos/held-sales/${h.body.id}/resume`);
    expect(r.body.cart).toEqual({ ...cart, lines: [{ ...cart.lines[0], serialNumbers: [] }] });
    expect((await cashier().post(`/pos/held-sales/${h.body.id}/resume`)).status).toBe(409);

    const h2 = await cashier().post('/pos/held-sales', { label: 'Walk-out', cart });
    const other = await api.as(co.pos.cashier2).post(`/pos/held-sales/${h2.body.id}/cancel`, { reason: 'left' });
    expect(other.status).toBe(403);
    const mine = await cashier().post(`/pos/held-sales/${h2.body.id}/cancel`, { reason: 'Customer left' });
    expect(mine.body.status).toBe('CANCELLED');
  });

  it('prices tax-inclusive shelves when the company says prices include VAT', async () => {
    const mgr = api.as(co.pos.manager);
    expect((await mgr.put('/pos/admin/settings', { pricesIncludeTax: true })).status).toBe(200);
    const q = await cashier().post('/pos/quote', { registerId: co.pos.registerId, lines: [{ productId: co.products.water, quantity: '1' }] });
    expect(q.body.totals.grandTotal).toBe('4.00');
    expect(q.body.totals.netTotal).toBe('3.64');
    expect(q.body.totals.taxTotal).toBe('0.36');
    expect(q.body.stockShortfalls).toHaveLength(1);
    await mgr.put('/pos/admin/settings', { pricesIncludeTax: false });
  });
});

describe('POS permissions, branches, tenancy and licensing', () => {
  it('keeps the till away from users without POS permissions', async () => {
    const r = await api.as(co.tokens.rep).get('/pos/context');
    expect(r.status).toBe(403);
    const c = await cashier().post('/pos/admin/registers', { code: 'X', name: 'X', branchId: co.branchId, warehouseId: co.warehouseId });
    expect(c.status).toBe(403);
  });

  it('limits cashiers to the branches they are assigned to', async () => {
    const admin = api.as(co.tokens.admin);
    await admin.put(`/pos/admin/staff/${co.pos.cashierId}/branches`, { branchIds: [] });
    const r = await cashier().get(`/pos/catalog?registerId=${co.pos.registerId}`);
    expect(r.status).toBe(403);
    await admin.put(`/pos/admin/staff/${co.pos.cashierId}/branches`, { branchIds: [co.branchId] });
    expect((await cashier().get(`/pos/catalog?registerId=${co.pos.registerId}`)).status).toBe(200);
  });

  it('shows cashiers only their own sales history', async () => {
    const own = await cashier().get('/pos/sales');
    expect(own.body.length).toBeGreaterThan(0);
    expect(own.body.every((s: any) => s.cashier_name === 'cashier')).toBe(true);
    const other = await api.as(co.pos.cashier2).get(`/pos/sales/${own.body[0].id}`);
    expect(other.status).toBe(404);
    const sup = await api.as(co.pos.supervisor).get(`/pos/sales/${own.body[0].id}`);
    expect(sup.status).toBe(200);
  });

  it('isolates companies', async () => {
    const other = await createPosCompany(app);
    const mine = (await cashier().get('/pos/sales')).body[0];
    expect((await api.as(other.pos.supervisor).get(`/pos/sales/${mine.id}`)).status).toBe(404);
    const r = await api.as(other.pos.cashier).post('/pos/sales', sale([{ productId: other.products.oil, quantity: '1' }], [{ methodId: other.pos.methods.CASH, amount: '5' }]));
    expect(r.status).toBe(404); // co's register is invisible to the other company
    const cross = await api.as(other.pos.cashier).post('/pos/sales', {
      ...sale([{ productId: co.products.oil, quantity: '1' }], [{ methodId: other.pos.methods.CASH, amount: '5' }]),
      registerId: other.pos.registerId,
    });
    expect(cross.status).toBe(422);
  });

  it('enforces the POS licence: module, register limits and expired subscriptions', async () => {
    const root = await rootApi(app);
    const noPos = await createPosCompany(app);
    await root.put(`/platform/tenants/${noPos.tenantId}/modules`, { modules: [{ code: 'POS_SALES', enabled: false }] });
    const off = await api.as(noPos.pos.cashier).get('/pos/context');
    expect(off.status).toBe(402);
    expect(off.body.error.code).toBe('MODULE_NOT_SUBSCRIBED');

    await root.put(`/platform/tenants/${co.tenantId}/pos-license`, { maxBranches: 1, maxRegisters: 2, maxDevices: 1, offlineValidityHours: 48 });
    const third = await api.as(co.tokens.admin).post('/pos/admin/registers', { code: 'R3', name: 'Till 3', branchId: co.branchId, warehouseId: co.warehouseId });
    expect(third.status).toBe(402);
    expect(third.body.error.code).toBe('LICENSE_LIMIT');
    const lic = await root.get(`/platform/tenants/${co.tenantId}/pos-license`);
    expect(lic.body.usage.registers).toBe(2);
    expect(lic.body.license.offline_validity_hours).toBe(48);
    const usage = await root.get('/platform/pos/usage');
    expect(usage.body.find((t: any) => t.id === co.tenantId).sales_30d).toBeGreaterThan(0);

    const expired = await createPosCompany(app);
    await root.put(`/platform/tenants/${expired.tenantId}/subscription`, { status: 'ACTIVE', endsAt: '2020-01-01T00:00:00Z', graceDays: 0 });
    const r = await api.as(expired.pos.cashier).post('/pos/sales', {
      ...sale([{ productId: expired.products.oil, quantity: '1' }], [{ methodId: expired.pos.methods.CASH, amount: '5' }]),
      registerId: expired.pos.registerId,
    });
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('SUBSCRIPTION_EXPIRED');
  });
});
