import { Injectable } from '@nestjs/common';
import {
  allowedActions,
  ApprovalRequirement,
  canSatisfy,
  Decimal,
  EDITABLE_STATUSES,
  nextStatus,
  ORDER_ACTION,
  OrderAction,
  OrderStatus,
  P,
  priceOrder,
  requiredApprovals,
  RESERVATION_HOLDING_STATUSES,
} from '@ckh/shared';
import { has, TenantUser } from '../../common/auth-context';
import { AuditService } from '../../common/audit.service';
import { conflict, DomainError, forbidden, notFound } from '../../common/errors';
import type { Tx } from '../../db/database.service';
import { NumberingService } from '../../core/numbering.service';
import { CustomerPricingContext, PricingService } from '../pricing.service';
import { SalesContextService, SalesRep, SalesSettings } from '../sales-context.service';
import { VisitsService } from '../visits/visits.service';
import type { CreateOrderInput, UpdateOrderInput } from './order.schemas';

type LineInput = CreateOrderInput['lines'][number];

export interface BuiltLine {
  productId: string;
  unitId: string;
  unitFactor: string;
  quantity: string;
  unitPrice: string;
  priceSource: 'PRICE_LIST' | 'PROMOTION' | 'LIST_PRICE' | 'OVERRIDE';
  promotionId: string | null;
  discountPercent: string;
  discountAmount: string;
  taxCodeId: string | null;
  taxRatePercent: string;
  taxAmount: string;
  netAmount: string;
  lineTotal: string;
  notes: string | null;
  /** Discount vs. the server price, including any price override — used for approval. */
  effectiveDiscountPercent: string;
  sku: string;
  productName: string;
}

export interface BuiltOrder {
  lines: BuiltLine[];
  currency: string;
  priceListId: string | null;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  grandTotal: string;
  maxEffectiveDiscountPercent: string;
}

/** Order statuses that count towards a customer's credit exposure. */
const OPEN_EXPOSURE_STATUSES: OrderStatus[] = [
  'PENDING_APPROVAL', 'APPROVED', 'STOCK_RESERVED', 'PICKING', 'PACKED', 'DISPATCHED', 'PARTIALLY_DELIVERED', 'DELIVERED',
];

@Injectable()
export class OrdersService {
  constructor(
    private readonly ctx: SalesContextService,
    private readonly pricing: PricingService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly visits: VisitsService,
  ) {}

  // -------------------------------------------------------------------------
  // Create / update drafts
  // -------------------------------------------------------------------------

  async create(tx: Tx, user: TenantUser, input: CreateOrderInput, opts: { provisional?: boolean; source?: string; quotationId?: string } = {}) {
    if (input.clientReference) {
      const existing = await tx.maybeOne<{ id: string; created_by: string }>(
        'SELECT id, created_by FROM sales_orders WHERE client_reference = $1',
        [input.clientReference],
      );
      if (existing) {
        if (existing.created_by !== user.userId) throw conflict('CLIENT_REFERENCE_IN_USE', 'clientReference already used by another user');
        return { order: await this.get(tx, user, existing.id), replayed: true };
      }
    }

    const settings = await this.ctx.settings(tx);
    const rep = await this.resolveRep(tx, user, input.salesRepId);
    await this.ctx.assertCustomerAccess(tx, user, input.customerId);
    if (input.visitId) await this.visits.assertVisitForDocument(tx, input.visitId, rep.id, input.customerId);
    const header = await this.resolveHeader(tx, user, rep, input);
    const pricingCtx = await this.pricing.customerContext(tx, input.customerId);
    const built = await this.buildLines(tx, pricingCtx, input.lines, header.orderDate, settings);

    const number = await this.numbering.next(tx, 'SALES_ORDER');
    const order = await tx.one<{ id: string }>(
      `INSERT INTO sales_orders (tenant_id, number, customer_id, sales_rep_id, branch_id, warehouse_id, order_date,
          requested_delivery_date, status, currency, price_list_id, delivery_address_id, payment_terms_days, notes,
          subtotal, discount_total, tax_total, grand_total, max_discount_percent, source, is_provisional,
          visit_id, client_reference, created_by, quotation_id)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, 'DRAFT', $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
       RETURNING id`,
      [
        number, input.customerId, rep.id, header.branchId, header.warehouseId, header.orderDate,
        input.requestedDeliveryDate ?? null, built.currency, built.priceListId, header.deliveryAddressId,
        header.paymentTermsDays, input.notes ?? null, built.subtotal, built.discountTotal, built.taxTotal,
        built.grandTotal, built.maxEffectiveDiscountPercent, opts.source ?? (input.visitId ? 'VISIT' : input.source), opts.provisional ?? false,
        input.visitId ?? null, input.clientReference ?? null, user.userId, opts.quotationId ?? null,
      ],
    );
    await this.insertLines(tx, order.id, built.lines);
    await this.history(tx, order.id, null, 'DRAFT', 'CREATE', user.userId, null);
    await this.audit.record(tx, { action: 'SALES_ORDER_CREATED', entityType: 'sales_order', entityId: order.id, after: { number, grandTotal: built.grandTotal } });
    return { order: await this.get(tx, user, order.id), replayed: false };
  }

  async update(tx: Tx, user: TenantUser, orderId: string, input: UpdateOrderInput) {
    const order = await this.lockForEdit(tx, user, orderId);
    if (order.version !== input.version) {
      throw conflict('VERSION_MISMATCH', 'This order was changed by someone else. Reload and try again.', { currentVersion: order.version });
    }
    const settings = await this.ctx.settings(tx);
    const rep = await tx.one<SalesRep>('SELECT * FROM sales_representatives WHERE id = $1', [order.sales_rep_id]);
    const header = await this.resolveHeader(tx, user, rep, { ...input, customerId: order.customer_id });
    const pricingCtx = await this.pricing.customerContext(tx, order.customer_id);
    const built = await this.buildLines(tx, pricingCtx, input.lines, header.orderDate, settings);

    await tx.query('DELETE FROM sales_order_lines WHERE order_id = $1', [orderId]);
    await this.insertLines(tx, orderId, built.lines);
    await tx.query(
      `UPDATE sales_orders SET branch_id = $2, warehouse_id = $3, order_date = $4, requested_delivery_date = $5,
          delivery_address_id = $6, payment_terms_days = $7, notes = $8, currency = $9, price_list_id = $10,
          subtotal = $11, discount_total = $12, tax_total = $13, grand_total = $14, max_discount_percent = $15,
          version = version + 1
        WHERE id = $1`,
      [
        orderId, header.branchId, header.warehouseId, header.orderDate, input.requestedDeliveryDate ?? null,
        header.deliveryAddressId, header.paymentTermsDays, input.notes ?? null, built.currency, built.priceListId,
        built.subtotal, built.discountTotal, built.taxTotal, built.grandTotal, built.maxEffectiveDiscountPercent,
      ],
    );
    await this.audit.record(tx, { action: 'SALES_ORDER_UPDATED', entityType: 'sales_order', entityId: orderId, after: { grandTotal: built.grandTotal } });
    return this.get(tx, user, orderId);
  }

  // -------------------------------------------------------------------------
  // Submit: full server-side revalidation, then auto-approve or route
  // -------------------------------------------------------------------------

  async submit(tx: Tx, user: TenantUser, orderId: string, opts: { deviceGrandTotal?: string } = {}) {
    const order = await this.lockForEdit(tx, user, orderId);
    const settings = await this.ctx.settings(tx);
    const rep = await tx.one<SalesRep>('SELECT * FROM sales_representatives WHERE id = $1', [order.sales_rep_id]);
    if (rep.status !== 'ACTIVE') throw new DomainError('REP_INACTIVE', 'The sales representative on this order is inactive', 422);
    await this.ctx.assertCustomerAccess(tx, user, order.customer_id);

    // 1. Re-price every line now — prices, promotions or tax may have changed
    //    since the draft was saved (or since an offline device cached them).
    const lines = await tx.query<{ product_id: string; unit_id: string; quantity: string; discount_percent: string; unit_price: string; price_source: string; notes: string | null }>(
      'SELECT product_id, unit_id, quantity, discount_percent, unit_price, price_source, notes FROM sales_order_lines WHERE order_id = $1 ORDER BY line_no',
      [orderId],
    );
    const pricingCtx = await this.pricing.customerContext(tx, order.customer_id);
    const today = tx.today();
    const built = await this.buildLines(
      tx,
      pricingCtx,
      lines.map((l) => ({
        productId: l.product_id,
        unitId: l.unit_id,
        quantity: l.quantity,
        discountPercent: l.discount_percent,
        unitPrice: l.price_source === 'OVERRIDE' ? l.unit_price : undefined,
        notes: l.notes ?? undefined,
      })),
      today,
      settings,
    );
    const priceChanged = !new Decimal(built.grandTotal).eq(order.grand_total);
    await tx.query('DELETE FROM sales_order_lines WHERE order_id = $1', [orderId]);
    await this.insertLines(tx, orderId, built.lines);

    // 2. Stock availability in the order's warehouse.
    const shortages = await this.stockShortages(tx, order.warehouse_id, built.lines);
    if (shortages.length && !settings.allowBackorders) {
      throw conflict('INSUFFICIENT_STOCK', 'Not enough stock for some lines and backorders are disabled', { shortages });
    }

    // 3. Approval requirements: discount, amount, credit.
    const credit = await this.creditPosition(tx, order.customer_id, orderId);
    const limits = { ...settings.approvalLimits };
    if (rep.max_discount_percent !== null) limits.repMaxDiscountPercent = rep.max_discount_percent;
    const requirements = requiredApprovals(
      {
        maxDiscountPercent: built.maxEffectiveDiscountPercent,
        customerDiscountAllowancePercent: credit.specialDiscountPercent,
        grandTotal: built.grandTotal,
        creditLimit: credit.creditLimit,
        creditExposure: credit.exposure,
        creditHold: credit.creditHold,
      },
      limits,
    );
    // An offline order whose total differs from what the device showed the customer needs a supervisor's OK.
    const offlineTotal = opts.deviceGrandTotal ?? (order.is_provisional ? order.grand_total : undefined);
    if (order.is_provisional && offlineTotal !== undefined && !new Decimal(built.grandTotal).eq(offlineTotal)) {
      requirements.push({ reason: 'OFFLINE_PRICE_CHANGE', level: 1, detail: `Offline total ${offlineTotal} revalidated to ${built.grandTotal}` });
    }

    const deliveryAddress = order.delivery_address_id
      ? await tx.maybeOne('SELECT line1, line2, location_id, contact_name, contact_phone, latitude, longitude FROM customer_addresses WHERE id = $1', [order.delivery_address_id])
      : null;

    await tx.query(
      `UPDATE sales_orders SET subtotal = $2, discount_total = $3, tax_total = $4, grand_total = $5, max_discount_percent = $6,
          approval_requirements = $7, delivery_address = $8, has_backorder = $9, is_provisional = false,
          submitted_at = now(), version = version + 1
        WHERE id = $1`,
      [orderId, built.subtotal, built.discountTotal, built.taxTotal, built.grandTotal, built.maxEffectiveDiscountPercent,
        JSON.stringify(requirements), deliveryAddress ? JSON.stringify(deliveryAddress) : null, shortages.length > 0],
    );

    let status = await this.transition(tx, orderId, order.status, ORDER_ACTION.SUBMIT, user.userId, priceChanged ? 'Prices revalidated on submit' : null, settings);
    if (requirements.length) {
      for (const r of requirements) {
        await tx.query(
          `INSERT INTO sales_order_approvals (tenant_id, order_id, reason, required_level, requires_credit_authority, detail)
           VALUES (current_tenant_id(), $1, $2, $3, $4, $5)`,
          [orderId, r.reason, r.level === 'CREDIT' ? null : r.level, r.level === 'CREDIT', r.detail],
        );
      }
      status = await this.transition(tx, orderId, status, ORDER_ACTION.REQUIRE_APPROVAL, null, requirements.map((r) => r.detail).join('; '), settings);
    } else {
      status = await this.transition(tx, orderId, status, ORDER_ACTION.AUTO_APPROVE, null, 'Within authorised limits', settings);
      await tx.query('UPDATE sales_orders SET approved_at = now() WHERE id = $1', [orderId]);
    }
    await this.audit.record(tx, { action: 'SALES_ORDER_SUBMITTED', entityType: 'sales_order', entityId: orderId, after: { status, requirements, grandTotal: built.grandTotal } });
    return { order: await this.get(tx, user, orderId), shortages, requirements };
  }

  // -------------------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------------------

  async approve(tx: Tx, user: TenantUser, orderId: string, comment?: string) {
    const { order, satisfiable, pending } = await this.loadForDecision(tx, user, orderId);
    for (const a of satisfiable) {
      await tx.query(
        `UPDATE sales_order_approvals SET status = 'APPROVED', decided_by = $2, decided_at = now(), comment = $3 WHERE id = $1`,
        [a.id, user.userId, comment ?? null],
      );
    }
    const remaining = pending.length - satisfiable.length;
    const settings = await this.ctx.settings(tx);
    if (remaining > 0) {
      await this.history(tx, orderId, order.status, order.status, 'PARTIAL_APPROVAL', user.userId,
        `${satisfiable.length} approval(s) given, ${remaining} still required`);
    } else {
      await this.transition(tx, orderId, order.status, ORDER_ACTION.APPROVE, user.userId, comment ?? null, settings);
      await tx.query('UPDATE sales_orders SET approved_at = now(), version = version + 1 WHERE id = $1', [orderId]);
    }
    await this.audit.record(tx, { action: 'SALES_ORDER_APPROVED', entityType: 'sales_order', entityId: orderId, after: { approvals: satisfiable.map((a) => a.reason), remaining } });
    return this.get(tx, user, orderId);
  }

  async reject(tx: Tx, user: TenantUser, orderId: string, comment: string) {
    const { order, satisfiable } = await this.loadForDecision(tx, user, orderId);
    await tx.query(
      `UPDATE sales_order_approvals SET status = 'REJECTED', decided_by = $2, decided_at = now(), comment = $3
        WHERE id = ANY($1::uuid[])`,
      [satisfiable.map((a) => a.id), user.userId, comment],
    );
    await tx.query(`UPDATE sales_order_approvals SET status = 'SUPERSEDED' WHERE order_id = $1 AND status = 'PENDING'`, [orderId]);
    await this.transition(tx, orderId, order.status, ORDER_ACTION.REJECT, user.userId, comment, await this.ctx.settings(tx));
    await tx.query('UPDATE sales_orders SET version = version + 1 WHERE id = $1', [orderId]);
    await this.audit.record(tx, { action: 'SALES_ORDER_REJECTED', entityType: 'sales_order', entityId: orderId, after: { comment } });
    return this.get(tx, user, orderId);
  }

  /** Rejected order goes back to draft so the rep can fix and resubmit. */
  async revise(tx: Tx, user: TenantUser, orderId: string) {
    const order = await this.lockVisible(tx, user, orderId);
    this.assertOwnerOrManager(user, order);
    await this.transition(tx, orderId, order.status, ORDER_ACTION.REVISE, user.userId, null, await this.ctx.settings(tx));
    await tx.query(`UPDATE sales_orders SET approval_requirements = '[]', version = version + 1 WHERE id = $1`, [orderId]);
    return this.get(tx, user, orderId);
  }

  async cancel(tx: Tx, user: TenantUser, orderId: string, reason: string) {
    const order = await this.lockVisible(tx, user, orderId);
    const reserved = RESERVATION_HOLDING_STATUSES.includes(order.status);
    if (reserved && !has(user, P.SALES_FULFILLMENT_RESERVE) && !has(user, P.SALES_ORDERS_VIEW_ALL)) {
      throw forbidden('Orders already in the warehouse can only be cancelled by warehouse staff or a manager');
    }
    this.assertOwnerOrManager(user, order);
    const settings = await this.ctx.settings(tx);
    nextStatus(order.status, ORDER_ACTION.CANCEL, settings.workflow); // validate before side effects
    if (reserved) await this.releaseReservations(tx, orderId, user.userId);
    await tx.query(`UPDATE sales_order_approvals SET status = 'SUPERSEDED' WHERE order_id = $1 AND status = 'PENDING'`, [orderId]);
    await this.transition(tx, orderId, order.status, ORDER_ACTION.CANCEL, user.userId, reason, settings);
    await tx.query('UPDATE sales_orders SET cancelled_at = now(), cancel_reason = $2, version = version + 1 WHERE id = $1', [orderId, reason]);
    await this.audit.record(tx, { action: 'SALES_ORDER_CANCELLED', entityType: 'sales_order', entityId: orderId, after: { reason } });
    return this.get(tx, user, orderId);
  }

  // -------------------------------------------------------------------------
  // Stock reservation (warehouse)
  // -------------------------------------------------------------------------

  async reserve(tx: Tx, user: TenantUser, orderId: string) {
    const order = await tx.maybeOne<{ id: string; status: OrderStatus; warehouse_id: string }>(
      'SELECT id, status, warehouse_id FROM sales_orders WHERE id = $1 FOR UPDATE',
      [orderId],
    );
    if (!order) throw notFound('Order');
    const settings = await this.ctx.settings(tx);
    nextStatus(order.status, ORDER_ACTION.RESERVE, settings.workflow);
    const warehouses = await this.ctx.authorizedWarehouseIds(tx, user);
    if (!warehouses.includes(order.warehouse_id)) throw forbidden('You are not authorised for this warehouse');

    const lines = await tx.query<{ id: string; product_id: string; quantity: string; unit_factor: string; track_inventory: boolean; centrally_controlled: boolean }>(
      `SELECT l.id, l.product_id, l.quantity, l.unit_factor, p.track_inventory, w.centrally_controlled
         FROM sales_order_lines l
         JOIN products p ON p.id = l.product_id
         JOIN warehouses w ON w.id = $2
        WHERE l.order_id = $1
        ORDER BY l.product_id, l.line_no`,
      [orderId, order.warehouse_id],
    );

    // Lock stock rows in a stable order (by product id) to avoid deadlocks
    // between concurrent reservations.
    const productIds = [...new Set(lines.filter((l) => l.track_inventory).map((l) => l.product_id))].sort();
    for (const pid of productIds) {
      await tx.query(
        `INSERT INTO stock_levels (tenant_id, warehouse_id, product_id) VALUES (current_tenant_id(), $1, $2)
         ON CONFLICT (warehouse_id, product_id) DO NOTHING`,
        [order.warehouse_id, pid],
      );
    }
    const stock = new Map<string, Decimal>();
    for (const row of await tx.query<{ product_id: string; qty_on_hand: string; qty_reserved: string }>(
      `SELECT product_id, qty_on_hand, qty_reserved FROM stock_levels
        WHERE warehouse_id = $1 AND product_id = ANY($2::uuid[])
        ORDER BY product_id FOR UPDATE`,
      [order.warehouse_id, productIds],
    )) {
      stock.set(row.product_id, Decimal.max(0, new Decimal(row.qty_on_hand).minus(row.qty_reserved)));
    }

    let backorder = false;
    const result: { lineId: string; reserved: string; backordered: string }[] = [];
    for (const l of lines) {
      const factor = new Decimal(l.unit_factor);
      const needBase = new Decimal(l.quantity).mul(factor);
      if (!l.track_inventory) {
        await tx.query('UPDATE sales_order_lines SET qty_reserved = quantity, qty_backordered = 0 WHERE id = $1', [l.id]);
        result.push({ lineId: l.id, reserved: l.quantity, backordered: '0' });
        continue;
      }
      const available = l.centrally_controlled ? stock.get(l.product_id) ?? new Decimal(0) : needBase;
      const reserveBase = Decimal.min(available, needBase);
      const shortBase = needBase.minus(reserveBase);
      if (shortBase.gt(0) && !settings.allowBackorders) {
        throw conflict('INSUFFICIENT_STOCK', 'Not enough stock to reserve this order and backorders are disabled', {
          productId: l.product_id, required: needBase.toString(), available: available.toString(),
        });
      }
      if (reserveBase.gt(0)) {
        await tx.query(
          `INSERT INTO sales_order_reservations (tenant_id, order_id, order_line_id, warehouse_id, product_id, quantity_base, created_by)
           VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6)`,
          [orderId, l.id, order.warehouse_id, l.product_id, reserveBase.toString(), user.userId],
        );
        await tx.query(
          'UPDATE stock_levels SET qty_reserved = qty_reserved + $3 WHERE warehouse_id = $1 AND product_id = $2',
          [order.warehouse_id, l.product_id, reserveBase.toString()],
        );
        if (l.centrally_controlled) stock.set(l.product_id, available.minus(reserveBase));
      }
      const reservedQty = reserveBase.div(factor);
      const backQty = shortBase.div(factor);
      if (backQty.gt(0)) backorder = true;
      await tx.query('UPDATE sales_order_lines SET qty_reserved = $2, qty_backordered = $3 WHERE id = $1', [
        l.id, reservedQty.toString(), backQty.toString(),
      ]);
      result.push({ lineId: l.id, reserved: reservedQty.toString(), backordered: backQty.toString() });
    }

    await this.transition(tx, orderId, order.status, ORDER_ACTION.RESERVE, user.userId, backorder ? 'Partially reserved; remainder backordered' : null, settings);
    await tx.query('UPDATE sales_orders SET has_backorder = $2, version = version + 1 WHERE id = $1', [orderId, backorder]);
    await this.audit.record(tx, { action: 'SALES_ORDER_RESERVED', entityType: 'sales_order', entityId: orderId, after: { lines: result } });
    return { order: await this.get(tx, user, orderId), lines: result };
  }

  async releaseReservations(tx: Tx, orderId: string, userId: string) {
    const active = await tx.query<{ id: string; warehouse_id: string; product_id: string; quantity_base: string }>(
      `SELECT id, warehouse_id, product_id, quantity_base FROM sales_order_reservations
        WHERE order_id = $1 AND status = 'ACTIVE' ORDER BY product_id FOR UPDATE`,
      [orderId],
    );
    for (const r of active) {
      await tx.query('UPDATE stock_levels SET qty_reserved = qty_reserved - $3 WHERE warehouse_id = $1 AND product_id = $2', [
        r.warehouse_id, r.product_id, r.quantity_base,
      ]);
      await tx.query(`UPDATE sales_order_reservations SET status = 'RELEASED', closed_at = now() WHERE id = $1`, [r.id]);
    }
    await tx.query('UPDATE sales_order_lines SET qty_reserved = 0, qty_backordered = 0 WHERE order_id = $1', [orderId]);
    if (active.length) {
      await this.audit.record(tx, { actorId: userId, action: 'SALES_ORDER_RESERVATIONS_RELEASED', entityType: 'sales_order', entityId: orderId, after: { count: active.length } });
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  async get(tx: Tx, user: TenantUser, orderId: string) {
    const [scope, params] = await this.ctx.orderScope(tx, user, 'o', 2);
    const visibleToWarehouse = has(user, P.SALES_FULFILLMENT_RESERVE) || has(user, P.SALES_INVOICES_CREATE);
    const order = await tx.maybeOne(
      `SELECT o.*, c.code AS customer_code, c.name AS customer_name, u.full_name AS sales_rep_name,
              w.name AS warehouse_name, b.name AS branch_name
         FROM sales_orders o
         JOIN customers c ON c.id = o.customer_id
         JOIN sales_representatives r ON r.id = o.sales_rep_id
         JOIN users u ON u.id = r.user_id
         JOIN warehouses w ON w.id = o.warehouse_id
         JOIN branches b ON b.id = o.branch_id
        WHERE o.id = $1 AND (${visibleToWarehouse ? 'TRUE' : scope})`,
      [orderId, ...(visibleToWarehouse ? [] : params)],
    );
    if (!order) throw notFound('Order');
    const lines = await tx.query(
      `SELECT l.*, p.sku, p.name AS product_name, un.code AS unit_code
         FROM sales_order_lines l JOIN products p ON p.id = l.product_id JOIN units un ON un.id = l.unit_id
        WHERE l.order_id = $1 ORDER BY l.line_no`,
      [orderId],
    );
    const approvals = await tx.query(
      `SELECT a.id, a.reason, a.required_level, a.requires_credit_authority, a.detail, a.status, a.comment,
              a.decided_at, u.full_name AS decided_by_name
         FROM sales_order_approvals a LEFT JOIN users u ON u.id = a.decided_by
        WHERE a.order_id = $1 ORDER BY a.created_at`,
      [orderId],
    );
    const history = await tx.query(
      `SELECT h.from_status, h.to_status, h.action, h.comment, h.created_at, u.full_name AS actor_name
         FROM sales_order_status_history h LEFT JOIN users u ON u.id = h.actor_user_id
        WHERE h.order_id = $1 ORDER BY h.id`,
      [orderId],
    );
    const deliveries = await tx.query(
      `SELECT id, number, status, carrier, tracking_reference, dispatched_at, delivered_at, received_by_name
         FROM sales_deliveries WHERE order_id = $1 ORDER BY dispatched_at`,
      [orderId],
    );
    const invoices = await tx.query(
      `SELECT id, number, invoice_date, due_date, grand_total, amount_paid, amount_credited, status
         FROM invoices WHERE sales_order_id = $1 ORDER BY invoice_date, number`,
      [orderId],
    );
    const returns = await tx.query(
      `SELECT r.id, r.number, r.status, r.reason, r.created_at, cn.number AS credit_note_number
         FROM sales_returns r LEFT JOIN credit_notes cn ON cn.id = r.credit_note_id WHERE r.order_id = $1 ORDER BY r.created_at`,
      [orderId],
    );
    const settings = await this.ctx.settings(tx);
    return { ...order, lines, approvals, history, deliveries, invoices, returns, allowedActions: allowedActions(order.status, settings.workflow) };
  }

  async list(tx: Tx, user: TenantUser, q: { status?: string; customerId?: string; salesRepId?: string; from?: string; to?: string; mine?: boolean; limit: number; offset: number }) {
    const [scope, scopeParams] = await this.ctx.orderScope(tx, user, 'o', 1);
    const params: unknown[] = [...scopeParams];
    const where = [scope];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.status) add('o.status = ANY(string_to_array(?, \',\'))', q.status);
    if (q.customerId) add('o.customer_id = ?', q.customerId);
    if (q.salesRepId) add('o.sales_rep_id = ?', q.salesRepId);
    if (q.from) add('o.order_date >= ?::date', q.from);
    if (q.to) add('o.order_date <= ?::date', q.to);
    if (q.mine) add('o.created_by = ?', user.userId);
    params.push(q.limit, q.offset);
    return tx.query(
      `SELECT o.id, o.number, o.status, o.order_date, o.requested_delivery_date, o.grand_total, o.currency,
              o.is_provisional, o.has_backorder, c.name AS customer_name, u.full_name AS sales_rep_name,
              count(*) OVER () AS total_count
         FROM sales_orders o
         JOIN customers c ON c.id = o.customer_id
         JOIN sales_representatives r ON r.id = o.sales_rep_id
         JOIN users u ON u.id = r.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY o.order_date DESC, o.number DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
  }

  /** Orders waiting for a decision this user is allowed to make. */
  async pendingApprovals(tx: Tx, user: TenantUser) {
    const canCredit = has(user, P.CUSTOMERS_CREDIT_MANAGE);
    const canApprove = has(user, P.SALES_ORDERS_APPROVE);
    const [scope, params] = await this.ctx.orderScope(tx, user, 'o', 5);
    return tx.query(
      `SELECT o.id, o.number, o.order_date, o.grand_total, o.currency, o.max_discount_percent,
              c.name AS customer_name, u.full_name AS sales_rep_name,
              json_agg(json_build_object('id', a.id, 'reason', a.reason, 'requiredLevel', a.required_level,
                       'requiresCreditAuthority', a.requires_credit_authority, 'detail', a.detail)) AS pending
         FROM sales_orders o
         JOIN sales_order_approvals a ON a.order_id = o.id AND a.status = 'PENDING'
         JOIN customers c ON c.id = o.customer_id
         JOIN sales_representatives r ON r.id = o.sales_rep_id
         JOIN users u ON u.id = r.user_id
        WHERE o.status = 'PENDING_APPROVAL' AND o.created_by <> $1
          AND ((a.required_level IS NOT NULL AND $3::boolean AND a.required_level <= $2)
               OR (a.requires_credit_authority AND $4::boolean))
          AND (${canCredit ? 'TRUE' : scope})
        GROUP BY o.id, c.name, u.full_name
        ORDER BY o.submitted_at`,
      [user.userId, user.approvalLevel, canApprove, canCredit, ...(canCredit ? [] : params)],
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async resolveRep(tx: Tx, user: TenantUser, salesRepId?: string): Promise<SalesRep> {
    const own = await this.ctx.repForUser(tx, user.userId);
    if (!salesRepId || salesRepId === own?.id) {
      if (!own || own.status !== 'ACTIVE') throw new DomainError('NOT_A_SALES_REP', 'Your account is not an active sales representative; choose a rep for this order', 422);
      return own;
    }
    const rep = await tx.maybeOne<SalesRep>('SELECT * FROM sales_representatives WHERE id = $1', [salesRepId]);
    if (!rep || rep.status !== 'ACTIVE') throw new DomainError('REP_INVALID', 'Sales representative not found or inactive', 422);
    if (!has(user, P.SALES_ORDERS_VIEW_ALL)) {
      const teams = has(user, P.SALES_ORDERS_VIEW_TEAM) ? await this.ctx.managedTeamIds(tx, user.userId) : [];
      if (!rep.team_id || !teams.includes(rep.team_id)) throw forbidden('You cannot create orders on behalf of this representative');
    }
    return rep;
  }

  async resolveHeader(
    tx: Tx,
    user: TenantUser,
    rep: SalesRep,
    input: { customerId: string; branchId?: string; warehouseId?: string; orderDate?: string; deliveryAddressId?: string; paymentTermsDays?: number },
  ) {
    const branchId = input.branchId ?? rep.default_branch_id;
    if (!branchId) throw new DomainError('BRANCH_REQUIRED', 'Choose a branch for this order', 422);
    const warehouseId = input.warehouseId ?? rep.default_warehouse_id;
    if (!warehouseId) throw new DomainError('WAREHOUSE_REQUIRED', 'Choose a warehouse for this order', 422);
    const allowed = await this.ctx.authorizedWarehouseIds(tx, user);
    if (!allowed.includes(warehouseId)) throw forbidden('You are not authorised to sell from this warehouse');
    const wh = await tx.maybeOne<{ branch_id: string; is_active: boolean }>('SELECT branch_id, is_active FROM warehouses WHERE id = $1', [warehouseId]);
    if (!wh?.is_active) throw new DomainError('WAREHOUSE_INACTIVE', 'Warehouse is inactive', 422);

    let deliveryAddressId: string | null = input.deliveryAddressId ?? null;
    if (deliveryAddressId) {
      const a = await tx.maybeOne('SELECT 1 FROM customer_addresses WHERE id = $1 AND customer_id = $2 AND address_type = $3', [deliveryAddressId, input.customerId, 'DELIVERY']);
      if (!a) throw new DomainError('ADDRESS_INVALID', 'Delivery address does not belong to this customer', 422);
    } else {
      const d = await tx.maybeOne<{ id: string }>(
        `SELECT id FROM customer_addresses WHERE customer_id = $1 AND address_type = 'DELIVERY' ORDER BY is_default DESC LIMIT 1`,
        [input.customerId],
      );
      deliveryAddressId = d?.id ?? null;
    }

    const cust = await tx.one<{ payment_terms_days: number }>('SELECT payment_terms_days FROM customers WHERE id = $1', [input.customerId]);
    const paymentTermsDays = input.paymentTermsDays ?? cust.payment_terms_days;
    if (paymentTermsDays > cust.payment_terms_days && !has(user, P.CUSTOMERS_CREDIT_MANAGE)) {
      throw new DomainError('TERMS_EXCEED_CUSTOMER', `Payment terms cannot exceed the customer's ${cust.payment_terms_days} days`, 422);
    }
    const orderDate = input.orderDate ?? tx.today();
    return { branchId, warehouseId, deliveryAddressId, paymentTermsDays, orderDate };
  }

  async buildLines(tx: Tx, pctx: CustomerPricingContext, inputs: LineInput[], on: string, settings: SalesSettings): Promise<BuiltOrder> {
    const resolved = [];
    for (const l of inputs) {
      const r = await this.pricing.resolve(tx, pctx, l.productId, l.unitId ?? null, l.quantity, on);
      let unitPrice = r.unitPrice;
      let priceSource: BuiltLine['priceSource'] = r.priceSource;
      if (l.unitPrice !== undefined && !new Decimal(l.unitPrice).eq(r.unitPrice)) {
        if (!settings.allowPriceOverride) {
          throw new DomainError('PRICE_MISMATCH', `Price for ${r.sku} is ${r.unitPrice}; manual prices are not allowed`, 422, {
            productId: r.productId, serverPrice: r.unitPrice, clientPrice: l.unitPrice,
          });
        }
        unitPrice = l.unitPrice;
        priceSource = 'OVERRIDE';
      }
      // Effective discount vs the server price (an override below price counts as discount).
      const serverPrice = new Decimal(r.unitPrice);
      const netUnit = new Decimal(unitPrice).mul(new Decimal(100).minus(l.discountPercent)).div(100);
      const effective = serverPrice.gt(0) ? Decimal.max(0, new Decimal(1).minus(netUnit.div(serverPrice)).mul(100)) : new Decimal(0);
      resolved.push({ input: l, r, unitPrice, priceSource, effective });
    }
    const priced = priceOrder(
      resolved.map((x) => ({ quantity: x.input.quantity, unitPrice: x.unitPrice, discountPercent: x.input.discountPercent, taxRatePercent: x.r.taxRatePercent })),
      pctx.currency,
    );
    const lines: BuiltLine[] = resolved.map((x, i) => ({
      productId: x.r.productId,
      unitId: x.r.unitId,
      unitFactor: x.r.unitFactor,
      quantity: priced.lines[i].quantity,
      unitPrice: x.unitPrice,
      priceSource: x.priceSource,
      promotionId: x.priceSource === 'PROMOTION' ? x.r.promotionId : null,
      discountPercent: priced.lines[i].discountPercent,
      discountAmount: priced.lines[i].discountAmount,
      taxCodeId: x.r.taxCodeId,
      taxRatePercent: priced.lines[i].taxRatePercent,
      taxAmount: priced.lines[i].taxAmount,
      netAmount: priced.lines[i].netAmount,
      lineTotal: priced.lines[i].lineTotal,
      notes: x.input.notes ?? null,
      effectiveDiscountPercent: x.effective.toDecimalPlaces(4).toString(),
      sku: x.r.sku,
      productName: x.r.productName,
    }));
    const maxEff = lines.reduce((m, l) => Decimal.max(m, l.effectiveDiscountPercent), new Decimal(0));
    return {
      lines,
      currency: pctx.currency,
      priceListId: pctx.priceListId,
      subtotal: priced.subtotal,
      discountTotal: priced.discountTotal,
      taxTotal: priced.taxTotal,
      grandTotal: priced.grandTotal,
      maxEffectiveDiscountPercent: maxEff.toString(),
    };
  }

  private async insertLines(tx: Tx, orderId: string, lines: BuiltLine[]) {
    let n = 0;
    for (const l of lines) {
      n += 1;
      await tx.query(
        `INSERT INTO sales_order_lines (tenant_id, order_id, line_no, product_id, unit_id, unit_factor, quantity, unit_price,
            price_source, promotion_id, discount_percent, discount_amount, tax_code_id, tax_rate_percent, tax_amount,
            net_amount, line_total, notes)
         VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [orderId, n, l.productId, l.unitId, l.unitFactor, l.quantity, l.unitPrice, l.priceSource, l.promotionId,
          l.discountPercent, l.discountAmount, l.taxCodeId, l.taxRatePercent, l.taxAmount, l.netAmount, l.lineTotal, l.notes],
      );
    }
  }

  private async stockShortages(tx: Tx, warehouseId: string, lines: BuiltLine[]) {
    const need = new Map<string, Decimal>();
    for (const l of lines) need.set(l.productId, (need.get(l.productId) ?? new Decimal(0)).plus(new Decimal(l.quantity).mul(l.unitFactor)));
    const rows = await tx.query<{ id: string; sku: string; track_inventory: boolean; available: string | null }>(
      `SELECT p.id, p.sku, p.track_inventory, (s.qty_on_hand - s.qty_reserved) AS available
         FROM products p LEFT JOIN stock_levels s ON s.product_id = p.id AND s.warehouse_id = $1
        WHERE p.id = ANY($2::uuid[])`,
      [warehouseId, [...need.keys()]],
    );
    return rows
      .filter((r) => r.track_inventory && new Decimal(r.available ?? 0).lt(need.get(r.id)!))
      .map((r) => ({ productId: r.id, sku: r.sku, required: need.get(r.id)!.toString(), available: new Decimal(r.available ?? 0).toString() }));
  }

  private async creditPosition(tx: Tx, customerId: string, excludeOrderId: string) {
    const c = await tx.one<{ credit_limit: string | null; credit_hold: boolean; special_discount_percent: string; outstanding: string; open_orders: string }>(
      `SELECT c.credit_limit, c.credit_hold, c.special_discount_percent,
              COALESCE((SELECT outstanding FROM customer_balances b WHERE b.customer_id = c.id), 0) AS outstanding,
              COALESCE((SELECT SUM(grand_total) FROM sales_orders o
                         WHERE o.customer_id = c.id AND o.id <> $2 AND o.status = ANY($3::text[])), 0) AS open_orders
         FROM customers c WHERE c.id = $1`,
      [customerId, excludeOrderId, OPEN_EXPOSURE_STATUSES],
    );
    return {
      creditLimit: c.credit_limit,
      creditHold: c.credit_hold,
      specialDiscountPercent: c.special_discount_percent,
      exposure: new Decimal(c.outstanding).plus(c.open_orders).toString(),
    };
  }

  private async lockVisible(tx: Tx, user: TenantUser, orderId: string) {
    const [scope, params] = await this.ctx.orderScope(tx, user, 'o', 2);
    const order = await tx.maybeOne<{ id: string; status: OrderStatus; created_by: string; sales_rep_id: string; customer_id: string; version: number; grand_total: string; warehouse_id: string; is_provisional: boolean; delivery_address_id: string | null }>(
      `SELECT o.id, o.status, o.created_by, o.sales_rep_id, o.customer_id, o.version, o.grand_total, o.warehouse_id, o.is_provisional, o.delivery_address_id
         FROM sales_orders o WHERE o.id = $1 AND ${scope} FOR UPDATE`,
      [orderId, ...params],
    );
    if (!order) throw notFound('Order');
    return order;
  }

  private async lockForEdit(tx: Tx, user: TenantUser, orderId: string) {
    const order = await this.lockVisible(tx, user, orderId);
    if (!EDITABLE_STATUSES.includes(order.status)) {
      throw conflict('ORDER_NOT_EDITABLE', `Order is ${order.status}; only drafts can be changed or submitted`);
    }
    this.assertOwnerOrManager(user, order);
    return order;
  }

  private assertOwnerOrManager(user: TenantUser, order: { created_by: string }) {
    if (order.created_by !== user.userId && !has(user, P.SALES_ORDERS_VIEW_TEAM) && !has(user, P.SALES_ORDERS_VIEW_ALL)) {
      throw forbidden('Only the order owner or their manager can do this');
    }
  }

  private async loadForDecision(tx: Tx, user: TenantUser, orderId: string) {
    const canCredit = has(user, P.CUSTOMERS_CREDIT_MANAGE);
    const canApprove = has(user, P.SALES_ORDERS_APPROVE);
    if (!canCredit && !canApprove) throw forbidden('You cannot approve orders');
    const order = canCredit
      ? await tx.maybeOne<{ id: string; status: OrderStatus; created_by: string }>('SELECT id, status, created_by FROM sales_orders WHERE id = $1 FOR UPDATE', [orderId])
      : await this.lockVisible(tx, user, orderId);
    if (!order) throw notFound('Order');
    if (order.status !== 'PENDING_APPROVAL') throw conflict('NOT_PENDING_APPROVAL', `Order is ${order.status}`);
    if (order.created_by === user.userId) throw forbidden('You cannot approve or reject your own order');
    const pending = await tx.query<{ id: string; reason: ApprovalRequirement['reason']; required_level: number | null; requires_credit_authority: boolean }>(
      `SELECT id, reason, required_level, requires_credit_authority FROM sales_order_approvals WHERE order_id = $1 AND status = 'PENDING'`,
      [orderId],
    );
    const satisfiable = pending.filter((a) => {
      const req: ApprovalRequirement = { reason: a.reason, level: a.requires_credit_authority ? 'CREDIT' : (a.required_level as 1 | 2 | 3), detail: '' };
      if (req.level === 'CREDIT') return canSatisfy(req, user.approvalLevel, canCredit);
      return canApprove && canSatisfy(req, user.approvalLevel, canCredit);
    });
    if (satisfiable.length === 0) {
      throw forbidden('This order needs approval above your authorisation level');
    }
    return { order, pending, satisfiable };
  }

  async transition(tx: Tx, orderId: string, from: OrderStatus, action: OrderAction, actor: string | null, comment: string | null, settings: SalesSettings): Promise<OrderStatus> {
    const to = nextStatus(from, action, settings.workflow);
    await tx.query('UPDATE sales_orders SET status = $2 WHERE id = $1', [orderId, to]);
    await this.history(tx, orderId, from, to, action, actor, comment);
    return to;
  }

  async history(tx: Tx, orderId: string, from: string | null, to: string, action: string, actor: string | null, comment: string | null) {
    await tx.query(
      `INSERT INTO sales_order_status_history (tenant_id, order_id, from_status, to_status, action, actor_user_id, comment)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6)`,
      [orderId, from, to, action, actor, comment],
    );
  }
}
