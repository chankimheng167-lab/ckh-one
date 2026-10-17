import { Injectable } from '@nestjs/common';
import { Decimal, P } from '@ckh/shared';
import { has, TenantUser } from '../../common/auth-context';
import { AuditService } from '../../common/audit.service';
import { conflict, DomainError, forbidden, notFound } from '../../common/errors';
import type { Tx } from '../../db/database.service';
import { NumberingService } from '../../core/numbering.service';
import type { CreateOrderInput } from '../orders/order.schemas';
import { OrdersService } from '../orders/orders.service';
import { PricingService } from '../pricing.service';
import { SalesContextService } from '../sales-context.service';
import { VisitsService } from '../visits/visits.service';

export interface QuotationInput {
  customerId: string;
  salesRepId?: string;
  branchId?: string;
  warehouseId?: string;
  quotationDate?: string;
  validUntil?: string;
  deliveryAddressId?: string;
  paymentTermsDays?: number;
  notes?: string;
  visitId?: string;
  lines: CreateOrderInput['lines'];
}

const OPEN = ['DRAFT', 'SENT'];

/**
 * Quotations are priced on the server exactly like orders. Converting an
 * accepted quotation creates a draft order that is re-priced at today's
 * prices; any difference from the quote is reported back, and the order is
 * still fully revalidated when it is submitted.
 */
@Injectable()
export class QuotationsService {
  constructor(
    private readonly orders: OrdersService,
    private readonly ctx: SalesContextService,
    private readonly pricing: PricingService,
    private readonly visits: VisitsService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  async create(tx: Tx, user: TenantUser, i: QuotationInput) {
    const settings = await this.ctx.settings(tx);
    const rep = await this.orders.resolveRep(tx, user, i.salesRepId);
    await this.ctx.assertCustomerAccess(tx, user, i.customerId);
    if (i.visitId) await this.visits.assertVisitForDocument(tx, i.visitId, rep.id, i.customerId);
    const header = await this.orders.resolveHeader(tx, user, rep, { ...i, orderDate: i.quotationDate });
    const pctx = await this.pricing.customerContext(tx, i.customerId);
    const built = await this.orders.buildLines(tx, pctx, i.lines, header.orderDate, settings);
    const validUntil = i.validUntil ?? addDays(header.orderDate, 14);
    if (validUntil < header.orderDate) throw new DomainError('INVALID_VALIDITY', 'validUntil must not be before the quotation date', 422);

    const number = await this.numbering.next(tx, 'SALES_QUOTATION');
    const q = await tx.one<{ id: string }>(
      `INSERT INTO sales_quotations (tenant_id, number, customer_id, sales_rep_id, branch_id, warehouse_id, quotation_date, valid_until,
          currency, price_list_id, subtotal, discount_total, tax_total, grand_total, notes, created_by, visit_id, delivery_address_id, payment_terms_days)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`,
      [number, i.customerId, rep.id, header.branchId, header.warehouseId, header.orderDate, validUntil, built.currency, built.priceListId,
        built.subtotal, built.discountTotal, built.taxTotal, built.grandTotal, i.notes ?? null, user.userId, i.visitId ?? null,
        header.deliveryAddressId, header.paymentTermsDays],
    );
    let n = 0;
    for (const l of built.lines) {
      n += 1;
      await tx.query(
        `INSERT INTO sales_quotation_lines (tenant_id, quotation_id, line_no, product_id, unit_id, unit_factor, quantity, unit_price,
            unit_price_source, discount_percent, discount_amount, tax_code_id, tax_rate_percent, tax_amount, net_amount, line_total, notes)
         VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [q.id, n, l.productId, l.unitId, l.unitFactor, l.quantity, l.unitPrice, l.priceSource, l.discountPercent, l.discountAmount,
          l.taxCodeId, l.taxRatePercent, l.taxAmount, l.netAmount, l.lineTotal, l.notes],
      );
    }
    await this.audit.record(tx, { action: 'QUOTATION_CREATED', entityType: 'sales_quotation', entityId: q.id, after: { number, grandTotal: built.grandTotal } });
    return this.get(tx, user, q.id);
  }

  async setStatus(tx: Tx, user: TenantUser, id: string, to: 'SENT' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED', note?: string) {
    const q = await this.lock(tx, user, id);
    const allowed: Record<string, string[]> = { SENT: ['DRAFT'], ACCEPTED: OPEN, REJECTED: OPEN, CANCELLED: OPEN };
    if (!allowed[to].includes(q.status)) throw conflict('INVALID_STATUS_TRANSITION', `Quotation is ${q.status}`);
    if (to === 'ACCEPTED' && q.expired) throw conflict('QUOTATION_EXPIRED', `Quotation expired on ${q.valid_until}`);
    await tx.query(
      `UPDATE sales_quotations SET status = $2, sent_at = CASE WHEN $2 = 'SENT' THEN now() ELSE sent_at END,
              decided_at = CASE WHEN $2 IN ('ACCEPTED', 'REJECTED', 'CANCELLED') THEN now() ELSE decided_at END,
              decision_note = COALESCE($3, decision_note)
        WHERE id = $1`,
      [id, to, note ?? null],
    );
    await this.audit.record(tx, { action: `QUOTATION_${to}`, entityType: 'sales_quotation', entityId: id, after: { note } });
    return this.get(tx, user, id);
  }

  /** Accepted (or still open) quotation → draft order at current prices. */
  async convert(tx: Tx, user: TenantUser, id: string) {
    const q = await this.lock(tx, user, id);
    if (![...OPEN, 'ACCEPTED'].includes(q.status)) throw conflict('INVALID_STATUS_TRANSITION', `Quotation is ${q.status}`);
    if (q.expired) throw conflict('QUOTATION_EXPIRED', `Quotation expired on ${q.valid_until}`);
    const lines = await tx.query<{ product_id: string; unit_id: string; quantity: string; discount_percent: string; unit_price: string; unit_price_source: string; notes: string | null }>(
      'SELECT product_id, unit_id, quantity, discount_percent, unit_price, unit_price_source, notes FROM sales_quotation_lines WHERE quotation_id = $1 ORDER BY line_no',
      [id],
    );
    const { order } = await this.orders.create(
      tx,
      user,
      {
        customerId: q.customer_id,
        salesRepId: q.sales_rep_id,
        branchId: q.branch_id,
        warehouseId: q.warehouse_id ?? undefined,
        deliveryAddressId: q.delivery_address_id ?? undefined,
        paymentTermsDays: q.payment_terms_days,
        notes: q.notes ?? undefined,
        source: 'WEB',
        visitId: q.visit_id ?? undefined,
        lines: lines.map((l) => ({
          productId: l.product_id,
          unitId: l.unit_id,
          quantity: l.quantity,
          discountPercent: l.discount_percent,
          unitPrice: l.unit_price_source === 'OVERRIDE' ? l.unit_price : undefined,
          notes: l.notes ?? undefined,
        })),
      },
      { source: 'QUOTATION', quotationId: id },
    );
    await tx.query(`UPDATE sales_quotations SET status = 'CONVERTED', converted_order_id = $2, decided_at = COALESCE(decided_at, now()) WHERE id = $1`, [id, order.id]);
    await this.audit.record(tx, { action: 'QUOTATION_CONVERTED', entityType: 'sales_quotation', entityId: id, after: { orderId: order.id } });
    const priceChanged = !new Decimal(order.grand_total).eq(q.grand_total);
    return { order, quotationTotal: q.grand_total, orderTotal: order.grand_total, priceChanged };
  }

  async get(tx: Tx, user: TenantUser, id: string) {
    const [scope, params] = await this.ctx.orderScope(tx, user, 'q', 2);
    const q = await tx.maybeOne(
      `SELECT q.*, (q.status IN ('DRAFT', 'SENT') AND q.valid_until < CURRENT_DATE) AS expired,
              c.code AS customer_code, c.name AS customer_name, u.full_name AS sales_rep_name, o.number AS converted_order_number
         FROM sales_quotations q JOIN customers c ON c.id = q.customer_id
         JOIN sales_representatives r ON r.id = q.sales_rep_id JOIN users u ON u.id = r.user_id
         LEFT JOIN sales_orders o ON o.id = q.converted_order_id
        WHERE q.id = $1 AND ${scope}`,
      [id, ...params],
    );
    if (!q) throw notFound('Quotation');
    const lines = await tx.query(
      `SELECT l.*, p.sku, p.name AS product_name, un.code AS unit_code FROM sales_quotation_lines l
         JOIN products p ON p.id = l.product_id JOIN units un ON un.id = l.unit_id WHERE l.quotation_id = $1 ORDER BY l.line_no`,
      [id],
    );
    return { ...q, status: q.expired ? 'EXPIRED' : q.status, lines };
  }

  async list(tx: Tx, user: TenantUser, q: { status?: string; customerId?: string; limit: number; offset: number }) {
    const [scope, scopeParams] = await this.ctx.orderScope(tx, user, 'q', 1);
    const params: unknown[] = [...scopeParams];
    const where = [scope];
    if (q.customerId) { params.push(q.customerId); where.push(`q.customer_id = $${params.length}`); }
    params.push(q.status ?? null);
    const statusParam = params.length;
    params.push(q.limit, q.offset);
    return tx.query(
      `SELECT * FROM (
         SELECT q.id, q.number, q.quotation_date, q.valid_until, q.grand_total, q.currency, c.name AS customer_name, u.full_name AS sales_rep_name,
                CASE WHEN q.status IN ('DRAFT', 'SENT') AND q.valid_until < CURRENT_DATE THEN 'EXPIRED' ELSE q.status END AS status
           FROM sales_quotations q JOIN customers c ON c.id = q.customer_id
           JOIN sales_representatives r ON r.id = q.sales_rep_id JOIN users u ON u.id = r.user_id
          WHERE ${where.join(' AND ')}) x
        WHERE ($${statusParam}::text IS NULL OR x.status = $${statusParam})
        ORDER BY x.quotation_date DESC, x.number DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
  }

  private async lock(tx: Tx, user: TenantUser, id: string) {
    const q = await this.get(tx, user, id);
    await tx.query('SELECT 1 FROM sales_quotations WHERE id = $1 FOR UPDATE', [id]);
    if (q.created_by !== user.userId && !has(user, P.SALES_ORDERS_VIEW_TEAM) && !has(user, P.SALES_ORDERS_VIEW_ALL)) {
      throw forbidden('Only the quotation owner or their manager can do this');
    }
    // `get` reports EXPIRED as the status; keep the stored status for transitions.
    const raw = await tx.one<{ status: string }>('SELECT status FROM sales_quotations WHERE id = $1', [id]);
    return { ...q, status: raw.status };
  }
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
