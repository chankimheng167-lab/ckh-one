import { Injectable } from '@nestjs/common';
import { BACKORDER_RESERVABLE_STATUSES, Decimal, nextStatus, ORDER_ACTION, OrderStatus } from '@ckh/shared';
import type { TenantUser } from '../../common/auth-context';
import { AuditService } from '../../common/audit.service';
import { conflict, DomainError, forbidden, notFound } from '../../common/errors';
import type { Tx } from '../../db/database.service';
import { JournalService } from '../../accounting/journal.service';
import { NumberingService } from '../../core/numbering.service';
import { StockService } from '../../inventory/stock.service';
import { InvoicingService } from '../billing/invoicing.service';
import { OrdersService } from '../orders/orders.service';
import { SalesContextService } from '../sales-context.service';

const D = (v: Decimal.Value) => new Decimal(v);

interface LockedOrder {
  id: string;
  number: string;
  status: OrderStatus;
  warehouse_id: string;
  customer_id: string;
}

interface FulfilLine {
  id: string;
  line_no: number;
  product_id: string;
  sku: string;
  product_name: string;
  unit_code: string;
  quantity: string;
  unit_factor: string;
  qty_reserved: string;
  qty_backordered: string;
  qty_dispatched: string;
  qty_delivered: string;
  qty_cancelled: string;
  track_inventory: boolean;
  centrally_controlled: boolean;
}

export interface DispatchInput {
  carrier?: string;
  vehicleNo?: string;
  driverName?: string;
  trackingReference?: string;
  lines?: { orderLineId: string; quantity: string }[];
}

export interface ConfirmDeliveryInput {
  receivedByName: string;
  note?: string;
  lines?: { orderLineId: string; quantityDelivered: string }[];
}

/**
 * Warehouse side of an approved order:
 *   reserve (OrdersService) → start picking → pack → dispatch (delivery note,
 *   stock issued, COGS posted) → confirm delivery (full or partial) →
 *   reserve backorders → further dispatches, or short-close the remainder.
 */
@Injectable()
export class FulfilmentService {
  constructor(
    private readonly orders: OrdersService,
    private readonly ctx: SalesContextService,
    private readonly stock: StockService,
    private readonly journal: JournalService,
    private readonly invoicing: InvoicingService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  async pickingList(tx: Tx, user: TenantUser, orderId: string) {
    const order = await this.lockOrder(tx, user, orderId, false);
    const header = await tx.one(
      `SELECT o.number, o.status, o.requested_delivery_date, o.delivery_address, o.notes, c.code AS customer_code, c.name AS customer_name,
              w.code AS warehouse_code, w.name AS warehouse_name
         FROM sales_orders o JOIN customers c ON c.id = o.customer_id JOIN warehouses w ON w.id = o.warehouse_id WHERE o.id = $1`,
      [orderId],
    );
    const lines = (await this.lines(tx, order.id, false))
      .filter((l) => D(l.qty_reserved).gt(0))
      .map((l) => ({
        orderLineId: l.id,
        lineNo: l.line_no,
        sku: l.sku,
        product: l.product_name,
        unit: l.unit_code,
        quantityToPick: l.qty_reserved,
        backordered: l.qty_backordered,
      }));
    return { ...header, lines, generatedAt: new Date().toISOString() };
  }

  async startPicking(tx: Tx, user: TenantUser, orderId: string) {
    const order = await this.lockOrder(tx, user, orderId);
    await this.orders.transition(tx, orderId, order.status, ORDER_ACTION.START_PICKING, user.userId, null, await this.ctx.settings(tx));
    await tx.query('UPDATE sales_orders SET picking_started_at = now(), picked_by = $2, version = version + 1 WHERE id = $1', [orderId, user.userId]);
    await this.audit.record(tx, { action: 'SALES_ORDER_PICKING_STARTED', entityType: 'sales_order', entityId: orderId });
    return this.orders.get(tx, user, orderId);
  }

  async pack(tx: Tx, user: TenantUser, orderId: string, packageCount: number) {
    const order = await this.lockOrder(tx, user, orderId);
    await this.orders.transition(tx, orderId, order.status, ORDER_ACTION.PACK, user.userId, `${packageCount} package(s)`, await this.ctx.settings(tx));
    await tx.query('UPDATE sales_orders SET packed_at = now(), packed_by = $2, package_count = $3, version = version + 1 WHERE id = $1', [orderId, user.userId, packageCount]);
    await this.audit.record(tx, { action: 'SALES_ORDER_PACKED', entityType: 'sales_order', entityId: orderId, after: { packageCount } });
    return this.orders.get(tx, user, orderId);
  }

  async dispatch(tx: Tx, user: TenantUser, orderId: string, input: DispatchInput) {
    const order = await this.lockOrder(tx, user, orderId);
    const settings = await this.ctx.settings(tx);
    nextStatus(order.status, ORDER_ACTION.DISPATCH, settings.workflow);
    const open = await tx.maybeOne(`SELECT number FROM sales_deliveries WHERE order_id = $1 AND status = 'DISPATCHED'`, [orderId]);
    if (open) throw conflict('DELIVERY_IN_PROGRESS', `Delivery ${open.number} is still on the road; confirm it before dispatching again`);

    const lines = await this.lines(tx, orderId);
    const requested = new Map((input.lines ?? []).map((l) => [l.orderLineId, D(l.quantity)]));
    for (const id of requested.keys()) if (!lines.some((l) => l.id === id)) throw new DomainError('LINE_NOT_ON_ORDER', 'A dispatch line does not belong to this order', 422);
    const ship = lines
      .map((l) => ({ l, qty: input.lines ? requested.get(l.id) ?? D(0) : D(l.qty_reserved) }))
      .filter((x) => x.qty.gt(0));
    for (const { l, qty } of ship) {
      if (qty.gt(l.qty_reserved)) {
        throw conflict('NOT_RESERVED', `Line ${l.line_no} (${l.sku}): only ${D(l.qty_reserved)} reserved, cannot ship ${qty}`);
      }
    }
    if (ship.length === 0) throw conflict('NOTHING_TO_DISPATCH', 'No reserved stock to dispatch on this order');

    const number = await this.numbering.next(tx, 'DELIVERY');
    const dn = await tx.one<{ id: string }>(
      `INSERT INTO sales_deliveries (tenant_id, number, order_id, warehouse_id, carrier, vehicle_no, driver_name, tracking_reference, dispatched_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [number, orderId, order.warehouse_id, input.carrier ?? null, input.vehicleNo ?? null, input.driverName ?? null, input.trackingReference ?? null, user.userId],
    );

    await this.stock.lock(tx, order.warehouse_id, ship.filter((s) => s.l.track_inventory).map((s) => s.l.product_id));
    let cogs = D(0);
    for (const { l, qty } of ship.sort((a, b) => a.l.product_id.localeCompare(b.l.product_id))) {
      const base = qty.mul(l.unit_factor);
      let unitCost = D(0);
      if (l.track_inventory) {
        unitCost = await this.stock.issueReserved(tx, {
          warehouseId: order.warehouse_id, productId: l.product_id, qtyBase: base,
          referenceType: 'SALES_DELIVERY', referenceId: dn.id, userId: user.userId, notes: `${number} / ${order.number}`,
        });
        await this.consumeReservations(tx, l.id, base);
        cogs = cogs.plus(base.mul(unitCost));
      }
      await tx.query(
        `INSERT INTO sales_delivery_lines (tenant_id, delivery_id, order_line_id, product_id, quantity, quantity_base, unit_cost)
         VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6)`,
        [dn.id, l.id, l.product_id, qty.toString(), base.toString(), unitCost.toString()],
      );
      await tx.query('UPDATE sales_order_lines SET qty_reserved = qty_reserved - $2, qty_dispatched = qty_dispatched + $2 WHERE id = $1', [l.id, qty.toString()]);
    }

    const acc = await this.journal.accounts(tx);
    const je = await this.journal.post(tx, {
      date: tx.today(),
      description: `Cost of goods shipped ${number} (order ${order.number})`,
      sourceType: 'DELIVERY',
      sourceId: dn.id,
      lines: [
        { accountId: acc.cogs, debit: cogs, description: 'Cost of goods sold' },
        { accountId: acc.inventory, credit: cogs, description: 'Inventory' },
      ],
    });
    await tx.query('UPDATE sales_deliveries SET cogs_journal_entry_id = $2 WHERE id = $1', [dn.id, je]);
    await this.orders.transition(tx, orderId, order.status, ORDER_ACTION.DISPATCH, user.userId, `Delivery ${number}`, settings);
    await tx.query('UPDATE sales_orders SET version = version + 1 WHERE id = $1', [orderId]);
    await this.audit.record(tx, { action: 'SALES_ORDER_DISPATCHED', entityType: 'sales_delivery', entityId: dn.id, after: { number, orderId, lines: ship.map((s) => ({ lineId: s.l.id, qty: s.qty.toString() })) } });
    return this.delivery(tx, user, dn.id);
  }

  /**
   * Proof of delivery. Quantities not received go back into the warehouse
   * and are re-reserved for the order (they show as reserved, ready to ship
   * again); their cost is reversed out of COGS.
   */
  async confirmDelivery(tx: Tx, user: TenantUser, deliveryId: string, input: ConfirmDeliveryInput) {
    const dn = await tx.maybeOne<{ id: string; number: string; order_id: string; status: string; warehouse_id: string }>(
      'SELECT id, number, order_id, status, warehouse_id FROM sales_deliveries WHERE id = $1 FOR UPDATE',
      [deliveryId],
    );
    if (!dn) throw notFound('Delivery');
    const order = await this.lockOrder(tx, user, dn.order_id);
    if (dn.status !== 'DISPATCHED') throw conflict('DELIVERY_ALREADY_CONFIRMED', `Delivery ${dn.number} is already ${dn.status.toLowerCase()}`);
    const settings = await this.ctx.settings(tx);

    const dlines = await tx.query<{ id: string; order_line_id: string; product_id: string; quantity: string; quantity_base: string; unit_cost: string; unit_factor: string; track_inventory: boolean }>(
      `SELECT dl.id, dl.order_line_id, dl.product_id, dl.quantity, dl.quantity_base, dl.unit_cost, l.unit_factor, p.track_inventory
         FROM sales_delivery_lines dl JOIN sales_order_lines l ON l.id = dl.order_line_id JOIN products p ON p.id = dl.product_id
        WHERE dl.delivery_id = $1 ORDER BY dl.product_id`,
      [deliveryId],
    );
    const given = new Map((input.lines ?? []).map((l) => [l.orderLineId, D(l.quantityDelivered)]));
    for (const id of given.keys()) if (!dlines.some((l) => l.order_line_id === id)) throw new DomainError('LINE_NOT_ON_DELIVERY', 'A confirmed line is not on this delivery note', 422);

    await this.stock.lock(tx, dn.warehouse_id, dlines.filter((l) => l.track_inventory).map((l) => l.product_id));
    let cogsReversal = D(0);
    let anyShort = false;
    for (const dl of dlines) {
      const delivered = given.has(dl.order_line_id) ? given.get(dl.order_line_id)! : D(dl.quantity);
      if (delivered.lt(0) || delivered.gt(dl.quantity)) throw new DomainError('INVALID_QUANTITY', `Delivered quantity must be between 0 and ${D(dl.quantity)}`, 422);
      const short = D(dl.quantity).minus(delivered);
      await tx.query('UPDATE sales_delivery_lines SET qty_delivered = $2 WHERE id = $1', [dl.id, delivered.toString()]);
      await tx.query('UPDATE sales_order_lines SET qty_delivered = qty_delivered + $2 WHERE id = $1', [dl.order_line_id, delivered.toString()]);
      if (short.gt(0)) {
        anyShort = true;
        const base = short.mul(dl.unit_factor);
        await tx.query('UPDATE sales_order_lines SET qty_dispatched = qty_dispatched - $2, qty_reserved = qty_reserved + $2 WHERE id = $1', [dl.order_line_id, short.toString()]);
        if (dl.track_inventory) {
          await this.stock.receiveBack(tx, {
            warehouseId: dn.warehouse_id, productId: dl.product_id, qtyBase: base, unitCost: D(dl.unit_cost), reserve: true,
            referenceType: 'SALES_DELIVERY', referenceId: dn.id, userId: user.userId, notes: `Not delivered on ${dn.number}`,
          });
          await tx.query(
            `INSERT INTO sales_order_reservations (tenant_id, order_id, order_line_id, warehouse_id, product_id, quantity_base, created_by)
             VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6)`,
            [order.id, dl.order_line_id, dn.warehouse_id, dl.product_id, base.toString(), user.userId],
          );
          cogsReversal = cogsReversal.plus(base.mul(dl.unit_cost));
        }
      }
    }
    await tx.query(
      `UPDATE sales_deliveries SET status = 'DELIVERED', delivered_at = now(), confirmed_by = $2, received_by_name = $3, delivery_note = $4 WHERE id = $1`,
      [deliveryId, user.userId, input.receivedByName, input.note ?? null],
    );
    if (cogsReversal.gt(0)) {
      const acc = await this.journal.accounts(tx);
      await this.journal.post(tx, {
        date: tx.today(),
        description: `Goods not delivered on ${dn.number} returned to stock`,
        sourceType: 'DELIVERY',
        sourceId: dn.id,
        lines: [
          { accountId: acc.inventory, debit: cogsReversal, description: 'Inventory' },
          { accountId: acc.cogs, credit: cogsReversal, description: 'Cost of goods sold reversal' },
        ],
      });
    }

    const full = await this.isFullyDelivered(tx, order.id);
    const action = full ? ORDER_ACTION.DELIVER : ORDER_ACTION.DELIVER_PARTIAL;
    await this.orders.transition(tx, order.id, order.status, action, user.userId, `${dn.number} received by ${input.receivedByName}${anyShort ? ' (short delivery)' : ''}`, settings);
    await tx.query('UPDATE sales_orders SET version = version + 1 WHERE id = $1', [order.id]);
    await this.audit.record(tx, { action: 'SALES_DELIVERY_CONFIRMED', entityType: 'sales_delivery', entityId: dn.id, after: { receivedBy: input.receivedByName, full, short: anyShort } });

    if ((await this.journal.accounts(tx)).revenueRecognition === 'ON_DELIVERY') {
      const hasDelivered = await tx.maybeOne(`SELECT 1 FROM sales_delivery_lines WHERE delivery_id = $1 AND qty_delivered > 0`, [dn.id]);
      if (hasDelivered) await this.invoicing.invoiceOrder(tx, null, order.id, { notes: `Auto-invoiced on delivery ${dn.number}` });
    }
    await this.invoicing.syncInvoicedStatus(tx, order.id, user.userId);
    return this.delivery(tx, user, dn.id);
  }

  /** Reserve newly arrived stock for backordered lines. */
  async reserveBackorders(tx: Tx, user: TenantUser, orderId: string) {
    const order = await this.lockOrder(tx, user, orderId);
    if (!BACKORDER_RESERVABLE_STATUSES.includes(order.status)) throw conflict('INVALID_STATUS_TRANSITION', `Cannot reserve backorders when order is ${order.status}`);
    const lines = (await this.lines(tx, orderId)).filter((l) => D(l.qty_backordered).gt(0));
    if (!lines.length) throw conflict('NO_BACKORDER', 'This order has nothing on backorder');
    const stock = await this.stock.lock(tx, order.warehouse_id, lines.filter((l) => l.track_inventory).map((l) => l.product_id));
    const result: { lineId: string; reserved: string; stillBackordered: string }[] = [];
    for (const l of lines) {
      const factor = D(l.unit_factor);
      const needBase = D(l.qty_backordered).mul(factor);
      const avail = !l.track_inventory || !l.centrally_controlled ? needBase : stock.get(l.product_id)?.available ?? D(0);
      const takeBase = Decimal.min(avail, needBase);
      if (takeBase.gt(0)) {
        if (l.track_inventory) {
          await this.stock.reserve(tx, order.warehouse_id, l.product_id, takeBase);
          await tx.query(
            `INSERT INTO sales_order_reservations (tenant_id, order_id, order_line_id, warehouse_id, product_id, quantity_base, created_by)
             VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6)`,
            [orderId, l.id, order.warehouse_id, l.product_id, takeBase.toString(), user.userId],
          );
          const s = stock.get(l.product_id);
          if (s) s.available = s.available.minus(takeBase);
        }
        const take = takeBase.div(factor);
        await tx.query('UPDATE sales_order_lines SET qty_reserved = qty_reserved + $2, qty_backordered = qty_backordered - $2 WHERE id = $1', [l.id, take.toString()]);
      }
      result.push({ lineId: l.id, reserved: takeBase.div(factor).toString(), stillBackordered: needBase.minus(takeBase).div(factor).toString() });
    }
    const left = await tx.one<{ n: string }>('SELECT count(*) AS n FROM sales_order_lines WHERE order_id = $1 AND qty_backordered > 0', [orderId]);
    await tx.query('UPDATE sales_orders SET has_backorder = $2, version = version + 1 WHERE id = $1', [orderId, Number(left.n) > 0]);
    await this.orders.history(tx, orderId, order.status, order.status, 'RESERVE_BACKORDER', user.userId, result.map((r) => `${r.reserved} reserved`).join(', '));
    await this.audit.record(tx, { action: 'SALES_ORDER_BACKORDER_RESERVED', entityType: 'sales_order', entityId: orderId, after: { lines: result } });
    return { order: await this.orders.get(tx, user, orderId), lines: result };
  }

  /** Stop waiting for backordered goods: the unshipped remainder is cancelled and its stock released. */
  async closeBackorders(tx: Tx, user: TenantUser, orderId: string, reason: string) {
    const order = await this.lockOrder(tx, user, orderId);
    if (order.status !== 'PARTIALLY_DELIVERED') {
      throw conflict('INVALID_STATUS_TRANSITION', `Only partially delivered orders can be short-closed (order is ${order.status}); cancel the order instead`);
    }
    const open = await tx.maybeOne(`SELECT number FROM sales_deliveries WHERE order_id = $1 AND status = 'DISPATCHED'`, [orderId]);
    if (open) throw conflict('DELIVERY_IN_PROGRESS', `Confirm delivery ${open.number} first`);
    await this.orders.releaseReservations(tx, orderId, user.userId);
    await tx.query('UPDATE sales_order_lines SET qty_cancelled = quantity - qty_dispatched WHERE order_id = $1', [orderId]);
    await tx.query('UPDATE sales_orders SET has_backorder = false, version = version + 1 WHERE id = $1', [orderId]);
    await this.orders.transition(tx, orderId, order.status, ORDER_ACTION.DELIVER, user.userId, `Remainder short-closed: ${reason}`, await this.ctx.settings(tx));
    await this.audit.record(tx, { action: 'SALES_ORDER_BACKORDER_CLOSED', entityType: 'sales_order', entityId: orderId, after: { reason } });
    await this.invoicing.syncInvoicedStatus(tx, orderId, user.userId);
    return this.orders.get(tx, user, orderId);
  }

  async delivery(tx: Tx, user: TenantUser, deliveryId: string) {
    const [scope, params] = await this.ctx.orderScope(tx, user, 'o', 2);
    const warehouseView = user.permissions.has('sales.fulfillment.dispatch') || user.permissions.has('sales.orders.view_all');
    const dn = await tx.maybeOne(
      `SELECT d.*, o.number AS order_number, o.status AS order_status, o.delivery_address, c.name AS customer_name,
              w.name AS warehouse_name, u.full_name AS dispatched_by_name
         FROM sales_deliveries d JOIN sales_orders o ON o.id = d.order_id JOIN customers c ON c.id = o.customer_id
         JOIN warehouses w ON w.id = d.warehouse_id JOIN users u ON u.id = d.dispatched_by
        WHERE d.id = $1 AND (${warehouseView ? 'TRUE' : scope})`,
      [deliveryId, ...(warehouseView ? [] : params)],
    );
    if (!dn) throw notFound('Delivery');
    const lines = await tx.query(
      `SELECT dl.order_line_id, dl.quantity, dl.qty_delivered, p.sku, p.name AS product_name, un.code AS unit_code
         FROM sales_delivery_lines dl JOIN sales_order_lines l ON l.id = dl.order_line_id
         JOIN products p ON p.id = dl.product_id JOIN units un ON un.id = l.unit_id
        WHERE dl.delivery_id = $1 ORDER BY l.line_no`,
      [deliveryId],
    );
    return { ...dn, lines };
  }

  /** Delivery tracking list, limited to orders the user may see. */
  async listDeliveries(tx: Tx, user: TenantUser, q: { status?: string; orderId?: string; limit: number; offset: number }) {
    const warehouseView = user.permissions.has('sales.fulfillment.dispatch') || user.permissions.has('sales.orders.view_all');
    const [scope, scopeParams] = await this.ctx.orderScope(tx, user, 'o', 1);
    const params: unknown[] = warehouseView ? [] : [...scopeParams];
    const where = [warehouseView ? 'TRUE' : scope];
    if (q.status) { params.push(q.status); where.push(`d.status = $${params.length}`); }
    if (q.orderId) { params.push(q.orderId); where.push(`d.order_id = $${params.length}`); }
    params.push(q.limit, q.offset);
    return tx.query(
      `SELECT d.id, d.number, d.status, d.carrier, d.vehicle_no, d.driver_name, d.tracking_reference, d.dispatched_at, d.delivered_at,
              d.received_by_name, o.id AS order_id, o.number AS order_number, o.status AS order_status, c.name AS customer_name,
              count(*) OVER () AS total_count
         FROM sales_deliveries d JOIN sales_orders o ON o.id = d.order_id JOIN customers c ON c.id = o.customer_id
        WHERE ${where.join(' AND ')}
        ORDER BY d.dispatched_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
  }

  // ---------------------------------------------------------------------------

  private async lockOrder(tx: Tx, user: TenantUser, orderId: string, forUpdate = true): Promise<LockedOrder> {
    const order = await tx.maybeOne<LockedOrder>(
      `SELECT id, number, status, warehouse_id, customer_id FROM sales_orders WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [orderId],
    );
    if (!order) throw notFound('Order');
    const warehouses = await this.ctx.authorizedWarehouseIds(tx, user);
    if (!warehouses.includes(order.warehouse_id)) throw forbidden('You are not authorised for this warehouse');
    return order;
  }

  private lines(tx: Tx, orderId: string, forUpdate = true) {
    return tx.query<FulfilLine>(
      `SELECT l.id, l.line_no, l.product_id, p.sku, p.name AS product_name, un.code AS unit_code, l.quantity, l.unit_factor,
              l.qty_reserved, l.qty_backordered, l.qty_dispatched, l.qty_delivered, l.qty_cancelled,
              p.track_inventory, w.centrally_controlled
         FROM sales_order_lines l
         JOIN sales_orders o ON o.id = l.order_id
         JOIN products p ON p.id = l.product_id
         JOIN units un ON un.id = l.unit_id
         JOIN warehouses w ON w.id = o.warehouse_id
        WHERE l.order_id = $1 ORDER BY l.line_no ${forUpdate ? 'FOR UPDATE OF l' : ''}`,
      [orderId],
    );
  }

  /** Marks reservation rows consumed for `base` units shipped, splitting a row when only part of it ships. */
  private async consumeReservations(tx: Tx, orderLineId: string, base: Decimal) {
    let left = base;
    const rows = await tx.query<{ id: string; quantity_base: string }>(
      `SELECT id, quantity_base FROM sales_order_reservations WHERE order_line_id = $1 AND status = 'ACTIVE' ORDER BY created_at FOR UPDATE`,
      [orderLineId],
    );
    for (const r of rows) {
      if (left.lte(0)) break;
      const q = D(r.quantity_base);
      if (q.lte(left)) {
        await tx.query(`UPDATE sales_order_reservations SET status = 'CONSUMED', closed_at = now() WHERE id = $1`, [r.id]);
        left = left.minus(q);
      } else {
        await tx.query('UPDATE sales_order_reservations SET quantity_base = $2 WHERE id = $1', [r.id, q.minus(left).toString()]);
        await tx.query(
          `INSERT INTO sales_order_reservations (tenant_id, order_id, order_line_id, warehouse_id, product_id, quantity_base, status, created_by, closed_at)
           SELECT tenant_id, order_id, order_line_id, warehouse_id, product_id, $2, 'CONSUMED', created_by, now() FROM sales_order_reservations WHERE id = $1`,
          [r.id, left.toString()],
        );
        left = D(0);
      }
    }
  }

  private async isFullyDelivered(tx: Tx, orderId: string): Promise<boolean> {
    const r = await tx.one<{ open: string }>(
      'SELECT count(*) AS open FROM sales_order_lines WHERE order_id = $1 AND qty_delivered + qty_cancelled < quantity',
      [orderId],
    );
    return Number(r.open) === 0;
  }
}
