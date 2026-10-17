import { Injectable } from '@nestjs/common';
import { Decimal, OrderStatus, P, RETURNABLE_STATUSES } from '@ckh/shared';
import { has, TenantUser } from '../../common/auth-context';
import { AuditService } from '../../common/audit.service';
import { conflict, DomainError, forbidden, notFound } from '../../common/errors';
import type { Tx } from '../../db/database.service';
import { JournalService } from '../../accounting/journal.service';
import { NumberingService } from '../../core/numbering.service';
import { StockService } from '../../inventory/stock.service';
import { InvoicingService } from '../billing/invoicing.service';
import { SalesContextService } from '../sales-context.service';

const D = (v: Decimal.Value) => new Decimal(v);

export interface ReturnRequestInput {
  orderId: string;
  reason: string;
  lines: { orderLineId: string; quantity: string; restock: boolean }[];
}

/**
 * Customer returns after delivery. A rep (or anyone who can see the order)
 * requests the return; the warehouse receives it, which puts restockable
 * goods back on hand at their original cost, records the returned quantity,
 * and issues a credit note for any part that had already been invoiced.
 * Returned goods that were never invoiced simply drop out of what can be
 * invoiced. Damaged goods (restock = false) stay written off in COGS.
 */
@Injectable()
export class ReturnsService {
  constructor(
    private readonly ctx: SalesContextService,
    private readonly stock: StockService,
    private readonly journal: JournalService,
    private readonly invoicing: InvoicingService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  async request(tx: Tx, user: TenantUser, input: ReturnRequestInput) {
    const [scope, params] = await this.ctx.orderScope(tx, user, 'o', 2);
    const order = await tx.maybeOne<{ id: string; number: string; status: OrderStatus; customer_id: string; warehouse_id: string }>(
      `SELECT o.id, o.number, o.status, o.customer_id, o.warehouse_id FROM sales_orders o WHERE o.id = $1 AND ${scope} FOR UPDATE`,
      [input.orderId, ...params],
    );
    if (!order) throw notFound('Order');
    if (!RETURNABLE_STATUSES.includes(order.status)) throw conflict('NOT_RETURNABLE', `Nothing has been delivered on this order yet (${order.status})`);
    await this.checkReturnable(tx, order.id, input.lines, null);

    const number = await this.numbering.next(tx, 'SALES_RETURN');
    const r = await tx.one<{ id: string }>(
      `INSERT INTO sales_returns (tenant_id, number, order_id, customer_id, warehouse_id, reason, requested_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6) RETURNING id`,
      [number, order.id, order.customer_id, order.warehouse_id, input.reason, user.userId],
    );
    for (const l of input.lines) {
      await tx.query(
        `INSERT INTO sales_return_lines (tenant_id, return_id, order_line_id, product_id, quantity, restock)
         SELECT current_tenant_id(), $1, id, product_id, $3, $4 FROM sales_order_lines WHERE id = $2`,
        [r.id, l.orderLineId, l.quantity, l.restock],
      );
    }
    await this.audit.record(tx, { action: 'SALES_RETURN_REQUESTED', entityType: 'sales_return', entityId: r.id, after: { number, ...input } });
    return this.get(tx, user, r.id);
  }

  async receive(tx: Tx, user: TenantUser, returnId: string) {
    const ret = await this.lockPending(tx, user, returnId);
    const order = await tx.one<{ id: string; number: string; customer_id: string; currency: string; warehouse_id: string }>(
      'SELECT id, number, customer_id, currency, warehouse_id FROM sales_orders WHERE id = $1 FOR UPDATE',
      [ret.order_id],
    );
    const lines = await tx.query<{ order_line_id: string; product_id: string; quantity: string; restock: boolean; unit_factor: string; track_inventory: boolean }>(
      `SELECT rl.order_line_id, rl.product_id, rl.quantity, rl.restock, l.unit_factor, p.track_inventory
         FROM sales_return_lines rl JOIN sales_order_lines l ON l.id = rl.order_line_id JOIN products p ON p.id = rl.product_id
        WHERE rl.return_id = $1 ORDER BY rl.product_id`,
      [returnId],
    );
    await this.checkReturnable(tx, order.id, lines.map((l) => ({ orderLineId: l.order_line_id, quantity: l.quantity })), returnId);

    const restocked = lines.filter((l) => l.restock && l.track_inventory);
    await this.stock.lock(tx, ret.warehouse_id, restocked.map((l) => l.product_id));
    let costBack = D(0);
    for (const l of lines) {
      if (l.restock && l.track_inventory) {
        const base = D(l.quantity).mul(l.unit_factor);
        const unitCost = await this.shippedUnitCost(tx, l.order_line_id);
        await this.stock.receiveBack(tx, {
          warehouseId: ret.warehouse_id, productId: l.product_id, qtyBase: base, unitCost, reserve: false,
          referenceType: 'SALES_RETURN', referenceId: returnId, userId: user.userId, notes: `${ret.number} / ${order.number}`,
        });
        costBack = costBack.plus(base.mul(unitCost));
      }
      await tx.query('UPDATE sales_order_lines SET qty_returned = qty_returned + $2 WHERE id = $1', [l.order_line_id, l.quantity]);
    }
    if (costBack.gt(0)) {
      const acc = await this.journal.accounts(tx);
      await this.journal.post(tx, {
        date: tx.today(),
        description: `Returned goods restocked ${ret.number}`,
        sourceType: 'SALES_RETURN',
        sourceId: returnId,
        lines: [
          { accountId: acc.inventory, debit: costBack, description: 'Inventory' },
          { accountId: acc.cogs, credit: costBack, description: 'Cost of goods sold reversal' },
        ],
      });
    }

    // Credit whatever is now billed beyond what the customer keeps.
    const after = await tx.query<{ id: string; qty_delivered: string; qty_returned: string; qty_invoiced: string; qty_credited: string }>(
      'SELECT id, qty_delivered, qty_returned, qty_invoiced, qty_credited FROM sales_order_lines WHERE id = ANY($1::uuid[])',
      [lines.map((l) => l.order_line_id)],
    );
    const credits = after
      .map((l) => ({ lineId: l.id, qty: D(l.qty_invoiced).minus(l.qty_credited).minus(D(l.qty_delivered).minus(l.qty_returned)) }))
      .filter((c) => c.qty.gt(0));
    const creditNoteId = await this.invoicing.creditForReturn(tx, user.userId, order, returnId, `Return ${ret.number}: ${ret.reason}`, credits);

    await tx.query(
      `UPDATE sales_returns SET status = 'RECEIVED', decided_by = $2, decided_at = now(), credit_note_id = $3 WHERE id = $1`,
      [returnId, user.userId, creditNoteId],
    );
    await tx.query(
      `INSERT INTO sales_order_status_history (tenant_id, order_id, from_status, to_status, action, actor_user_id, comment)
       SELECT current_tenant_id(), id, status, status, 'RETURN_RECEIVED', $2, $3 FROM sales_orders WHERE id = $1`,
      [order.id, user.userId, `Return ${ret.number} received`],
    );
    await this.audit.record(tx, { action: 'SALES_RETURN_RECEIVED', entityType: 'sales_return', entityId: returnId, after: { creditNoteId, costBack: costBack.toFixed(2) } });
    return this.get(tx, user, returnId);
  }

  async reject(tx: Tx, user: TenantUser, returnId: string, reason: string) {
    await this.lockPending(tx, user, returnId);
    await tx.query(
      `UPDATE sales_returns SET status = 'REJECTED', decided_by = $2, decided_at = now(), rejection_reason = $3 WHERE id = $1`,
      [returnId, user.userId, reason],
    );
    await this.audit.record(tx, { action: 'SALES_RETURN_REJECTED', entityType: 'sales_return', entityId: returnId, after: { reason } });
    return this.get(tx, user, returnId);
  }

  async get(tx: Tx, user: TenantUser, returnId: string) {
    const r = await tx.maybeOne(
      `SELECT r.*, o.number AS order_number, c.name AS customer_name, cn.number AS credit_note_number, cn.grand_total AS credit_note_total
         FROM sales_returns r JOIN sales_orders o ON o.id = r.order_id JOIN customers c ON c.id = r.customer_id
         LEFT JOIN credit_notes cn ON cn.id = r.credit_note_id WHERE r.id = $1`,
      [returnId],
    );
    if (!r) throw notFound('Return');
    if (!has(user, P.SALES_RETURNS_RECEIVE) && !has(user, P.SALES_ORDERS_VIEW_ALL)) {
      const [scope, params] = await this.ctx.orderScope(tx, user, 'o', 2);
      const ok = await tx.maybeOne(`SELECT 1 FROM sales_orders o WHERE o.id = $1 AND ${scope}`, [r.order_id, ...params]);
      if (!ok) throw notFound('Return');
    }
    const lines = await tx.query(
      `SELECT rl.order_line_id, rl.quantity, rl.restock, p.sku, p.name AS product_name
         FROM sales_return_lines rl JOIN products p ON p.id = rl.product_id WHERE rl.return_id = $1`,
      [returnId],
    );
    return { ...r, lines };
  }

  async list(tx: Tx, user: TenantUser, q: { status?: string; limit: number; offset: number }) {
    const all = has(user, P.SALES_RETURNS_RECEIVE) || has(user, P.SALES_ORDERS_VIEW_ALL);
    const [scope, scopeParams] = await this.ctx.orderScope(tx, user, 'o', 1);
    const params: unknown[] = all ? [] : [...scopeParams];
    const where = [all ? 'TRUE' : scope];
    if (q.status) { params.push(q.status); where.push(`r.status = $${params.length}`); }
    params.push(q.limit, q.offset);
    return tx.query(
      `SELECT r.id, r.number, r.status, r.reason, r.created_at, o.number AS order_number, c.name AS customer_name, count(*) OVER () AS total_count
         FROM sales_returns r JOIN sales_orders o ON o.id = r.order_id JOIN customers c ON c.id = r.customer_id
        WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
  }

  // ---------------------------------------------------------------------------

  private async lockPending(tx: Tx, user: TenantUser, returnId: string) {
    const r = await tx.maybeOne<{ id: string; number: string; order_id: string; warehouse_id: string; status: string; reason: string; requested_by: string }>(
      'SELECT id, number, order_id, warehouse_id, status, reason, requested_by FROM sales_returns WHERE id = $1 FOR UPDATE',
      [returnId],
    );
    if (!r) throw notFound('Return');
    const warehouses = await this.ctx.authorizedWarehouseIds(tx, user);
    if (!warehouses.includes(r.warehouse_id)) throw forbidden('You are not authorised for this warehouse');
    if (r.status !== 'REQUESTED') throw conflict('RETURN_ALREADY_DECIDED', `Return ${r.number} is already ${r.status.toLowerCase()}`);
    return r;
  }

  /** Requested quantities must fit within delivered − already returned − other open requests. */
  private async checkReturnable(tx: Tx, orderId: string, lines: { orderLineId: string; quantity: string }[], excludeReturnId: string | null) {
    if (!lines.length) throw new DomainError('NO_LINES', 'A return needs at least one line', 422);
    const seen = new Set<string>();
    for (const l of lines) {
      if (seen.has(l.orderLineId)) throw new DomainError('DUPLICATE_LINE', 'Each order line may appear once', 422);
      seen.add(l.orderLineId);
      const row = await tx.maybeOne<{ line_no: number; qty_delivered: string; qty_returned: string; pending: string }>(
        `SELECT l.line_no, l.qty_delivered, l.qty_returned,
                COALESCE((SELECT SUM(rl.quantity) FROM sales_return_lines rl JOIN sales_returns r ON r.id = rl.return_id
                           WHERE rl.order_line_id = l.id AND r.status = 'REQUESTED' AND r.id IS DISTINCT FROM $3), 0) AS pending
           FROM sales_order_lines l WHERE l.id = $1 AND l.order_id = $2`,
        [l.orderLineId, orderId, excludeReturnId],
      );
      if (!row) throw new DomainError('LINE_NOT_ON_ORDER', 'A return line does not belong to this order', 422);
      const max = D(row.qty_delivered).minus(row.qty_returned).minus(row.pending);
      if (D(l.quantity).gt(max)) throw conflict('RETURN_EXCEEDS_DELIVERED', `Line ${row.line_no}: at most ${max} can be returned`);
    }
  }

  /** Weighted cost per base unit of what was actually delivered on the line. */
  private async shippedUnitCost(tx: Tx, orderLineId: string): Promise<Decimal> {
    const r = await tx.one<{ cost: string | null }>(
      `SELECT SUM(dl.unit_cost * dl.qty_delivered) / NULLIF(SUM(dl.qty_delivered), 0) AS cost
         FROM sales_delivery_lines dl WHERE dl.order_line_id = $1 AND dl.qty_delivered > 0`,
      [orderLineId],
    );
    return D(r.cost ?? 0);
  }
}
