import { Injectable } from '@nestjs/common';
import { Decimal, invoiceableStatuses, ORDER_ACTION, OrderStatus, priceLine } from '@ckh/shared';
import { AuditService } from '../../common/audit.service';
import { conflict, notFound } from '../../common/errors';
import type { Tx } from '../../db/database.service';
import { JournalService } from '../../accounting/journal.service';
import { NumberingService } from '../../core/numbering.service';
import { OrdersService } from '../orders/orders.service';
import { SalesContextService } from '../sales-context.service';

interface OrderLineRow {
  id: string;
  line_no: number;
  product_id: string;
  product_name: string;
  quantity: string;
  unit_price: string;
  discount_percent: string;
  tax_rate_percent: string;
  net_amount: string;
  tax_amount: string;
  line_total: string;
  discount_amount: string;
  qty_dispatched: string;
  qty_delivered: string;
  qty_returned: string;
  qty_invoiced: string;
  qty_credited: string;
}

interface Amounts {
  gross: Decimal;
  discount: Decimal;
  net: Decimal;
  tax: Decimal;
  total: Decimal;
}

const D = (v: Decimal.Value) => new Decimal(v);

/**
 * Turns fulfilled order quantities into accounts-receivable documents.
 *
 *  - Revenue is never posted when an order is created or approved; only an
 *    invoice posts revenue (Dr AR / Cr revenue, VAT; Dr sales discount).
 *  - With revenue recognition ON_DELIVERY the invoice is raised automatically
 *    when a delivery is confirmed; with ON_INVOICE an accountant raises it.
 *  - Credit notes reverse revenue and VAT for returned goods that were billed.
 */
@Injectable()
export class InvoicingService {
  constructor(
    private readonly orders: OrdersService,
    private readonly ctx: SalesContextService,
    private readonly journal: JournalService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  async invoiceOrder(tx: Tx, actorUserId: string | null, orderId: string, opts: { invoiceDate?: string; notes?: string } = {}) {
    const order = await tx.maybeOne<{ id: string; number: string; status: OrderStatus; customer_id: string; branch_id: string; sales_rep_id: string; currency: string; payment_terms_days: number }>(
      `SELECT id, number, status, customer_id, branch_id, sales_rep_id, currency, payment_terms_days FROM sales_orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    if (!order) throw notFound('Order');
    const settings = await this.ctx.settings(tx);
    if (!invoiceableStatuses(settings.workflow).includes(order.status)) {
      throw conflict('NOT_INVOICEABLE', `Order is ${order.status}; goods must be ${settings.workflow.invoiceOnDispatch ? 'dispatched' : 'delivered'} before invoicing`);
    }
    const lines = await this.lines(tx, orderId);
    const basis = (l: OrderLineRow) => D(settings.workflow.invoiceOnDispatch ? l.qty_dispatched : l.qty_delivered).minus(l.qty_returned);
    const toBill = lines
      .map((l) => ({ l, qty: basis(l).minus(D(l.qty_invoiced).minus(l.qty_credited)) }))
      .filter((x) => x.qty.gt(0));
    if (toBill.length === 0) throw conflict('NOTHING_TO_INVOICE', 'Everything shipped on this order has already been invoiced');

    const invoiceDate = opts.invoiceDate ?? today();
    const priced: { l: OrderLineRow; qty: Decimal; a: Amounts }[] = [];
    for (const { l, qty } of toBill) priced.push({ l, qty, a: await this.amountsForInvoice(tx, l, qty, order.currency) });
    const sum = (k: keyof Amounts) => priced.reduce((acc, p) => acc.plus(p.a[k]), D(0));

    const number = await this.numbering.next(tx, 'INVOICE');
    const inv = await tx.one<{ id: string }>(
      `INSERT INTO invoices (tenant_id, number, customer_id, branch_id, sales_order_id, sales_rep_id, invoice_date, due_date,
          currency, subtotal, discount_total, tax_total, grand_total, status, notes, created_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6::date, $6::date + $7::int, $8, $9, $10, $11, $12, 'ISSUED', $13, $14)
       RETURNING id`,
      [number, order.customer_id, order.branch_id, order.id, order.sales_rep_id, invoiceDate, order.payment_terms_days, order.currency,
        sum('gross').toFixed(2), sum('discount').toFixed(2), sum('tax').toFixed(2), sum('total').toFixed(2), opts.notes ?? `Order ${order.number}`, actorUserId],
    );
    let n = 0;
    for (const { l, qty, a } of priced) {
      n += 1;
      await tx.query(
        `INSERT INTO invoice_lines (tenant_id, invoice_id, line_no, product_id, description, quantity, unit_price, discount_amount,
            tax_rate_percent, tax_amount, net_amount, line_total, sales_order_line_id)
         VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [inv.id, n, l.product_id, l.product_name, qty.toString(), l.unit_price, a.discount.toFixed(2), l.tax_rate_percent,
          a.tax.toFixed(2), a.net.toFixed(2), a.total.toFixed(2), l.id],
      );
      await tx.query('UPDATE sales_order_lines SET qty_invoiced = qty_invoiced + $2 WHERE id = $1', [l.id, qty.toString()]);
    }

    const acc = await this.journal.accounts(tx);
    const je = await this.journal.post(tx, {
      date: invoiceDate,
      description: `Invoice ${number} (order ${order.number})`,
      sourceType: 'INVOICE',
      sourceId: inv.id,
      lines: [
        { accountId: acc.ar, debit: sum('total'), customerId: order.customer_id, description: 'Accounts receivable' },
        { accountId: acc.salesDiscount, debit: sum('discount'), description: 'Sales discount' },
        { accountId: acc.revenue, credit: sum('gross'), description: 'Sales revenue' },
        { accountId: acc.vatOutput, credit: sum('tax'), description: 'VAT output' },
      ],
    });
    await tx.query('UPDATE invoices SET journal_entry_id = $2 WHERE id = $1', [inv.id, je]);
    await this.orders.history(tx, orderId, order.status, order.status, 'INVOICE_ISSUED', actorUserId, `Invoice ${number} for ${sum('total').toFixed(2)} ${order.currency}`);
    await this.audit.record(tx, { actorType: actorUserId ? 'USER' : 'SYSTEM', action: 'INVOICE_ISSUED', entityType: 'invoice', entityId: inv.id, after: { number, orderId, grandTotal: sum('total').toFixed(2) } });
    await this.syncInvoicedStatus(tx, orderId, actorUserId);
    return this.invoice(tx, inv.id);
  }

  /** DELIVERED → INVOICED once every delivered unit (net of returns) is billed. */
  async syncInvoicedStatus(tx: Tx, orderId: string, actorUserId: string | null) {
    const o = await tx.one<{ status: OrderStatus }>('SELECT status FROM sales_orders WHERE id = $1', [orderId]);
    if (o.status !== 'DELIVERED') return;
    const lines = await this.lines(tx, orderId);
    const anyBilled = lines.some((l) => D(l.qty_invoiced).gt(0));
    const allBilled = lines.every((l) => D(l.qty_invoiced).minus(l.qty_credited).gte(D(l.qty_delivered).minus(l.qty_returned)));
    if (anyBilled && allBilled) {
      await this.orders.transition(tx, orderId, o.status, ORDER_ACTION.INVOICE, actorUserId, 'All delivered goods invoiced', await this.ctx.settings(tx));
    }
  }

  /** INVOICED → CLOSED. Automatic once all its invoices are settled; accountants may also close manually. */
  async closeOrder(tx: Tx, actorUserId: string | null, orderId: string, comment: string | null) {
    const o = await tx.maybeOne<{ status: OrderStatus }>('SELECT status FROM sales_orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!o) throw notFound('Order');
    await this.orders.transition(tx, orderId, o.status, ORDER_ACTION.CLOSE, actorUserId, comment, await this.ctx.settings(tx));
    await tx.query('UPDATE sales_orders SET closed_at = now(), version = version + 1 WHERE id = $1', [orderId]);
  }

  async autoCloseSettledOrders(tx: Tx, invoiceIds: string[], actorUserId: string | null) {
    const orders = await tx.query<{ id: string }>(
      `SELECT DISTINCT o.id FROM invoices i JOIN sales_orders o ON o.id = i.sales_order_id
        WHERE i.id = ANY($1::uuid[]) AND o.status = 'INVOICED'
          AND NOT EXISTS (SELECT 1 FROM invoices x WHERE x.sales_order_id = o.id AND x.status IN ('ISSUED', 'PARTIALLY_PAID'))`,
      [invoiceIds],
    );
    for (const o of orders) await this.closeOrder(tx, actorUserId, o.id, 'All invoices settled');
  }

  /**
   * Credit note for returned goods that had been billed. `credits` are order
   * line quantities to reverse. Applies the credit to the order's open
   * invoices (oldest first); any remainder stays as unapplied customer credit.
   */
  async creditForReturn(
    tx: Tx,
    actorUserId: string,
    order: { id: string; number: string; customer_id: string; currency: string },
    returnId: string,
    reason: string,
    credits: { lineId: string; qty: Decimal }[],
  ): Promise<string | null> {
    if (credits.length === 0) return null;
    const lines = new Map((await this.lines(tx, order.id)).map((l) => [l.id, l]));
    const priced = credits.map((c) => {
      const l = lines.get(c.lineId)!;
      const p = priceLine({ quantity: c.qty.toString(), unitPrice: l.unit_price, discountPercent: l.discount_percent, taxRatePercent: l.tax_rate_percent }, order.currency);
      return { l, qty: c.qty, net: D(p.netAmount), tax: D(p.taxAmount), total: D(p.lineTotal) };
    });
    const net = priced.reduce((a, p) => a.plus(p.net), D(0));
    const tax = priced.reduce((a, p) => a.plus(p.tax), D(0));
    const total = net.plus(tax);
    if (total.lte(0)) return null;

    const number = await this.numbering.next(tx, 'CREDIT_NOTE');
    const date = today();
    const cn = await tx.one<{ id: string }>(
      `INSERT INTO credit_notes (tenant_id, number, customer_id, credit_date, reason, currency, subtotal, tax_total, grand_total,
          sales_order_id, sales_return_id, created_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [number, order.customer_id, date, reason, order.currency, net.toFixed(2), tax.toFixed(2), total.toFixed(2), order.id, returnId, actorUserId],
    );
    let n = 0;
    for (const p of priced) {
      n += 1;
      await tx.query(
        `INSERT INTO credit_note_lines (tenant_id, credit_note_id, line_no, product_id, description, quantity, unit_price,
            tax_rate_percent, tax_amount, net_amount, line_total, restock, sales_order_line_id)
         VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, $11)`,
        [cn.id, n, p.l.product_id, p.l.product_name, p.qty.toString(), p.l.unit_price, p.l.tax_rate_percent,
          p.tax.toFixed(2), p.net.toFixed(2), p.total.toFixed(2), p.l.id],
      );
      await tx.query('UPDATE sales_order_lines SET qty_credited = qty_credited + $2 WHERE id = $1', [p.l.id, p.qty.toString()]);
    }

    // Apply against this order's open invoices, oldest first.
    let left = total;
    const open = await tx.query<{ id: string; open: string }>(
      `SELECT id, grand_total - amount_paid - amount_credited AS open FROM invoices
        WHERE sales_order_id = $1 AND status IN ('ISSUED', 'PARTIALLY_PAID') ORDER BY invoice_date, number FOR UPDATE`,
      [order.id],
    );
    for (const inv of open) {
      if (left.lte(0)) break;
      const amt = Decimal.min(left, inv.open);
      if (amt.lte(0)) continue;
      await tx.query(`INSERT INTO credit_note_applications (tenant_id, credit_note_id, invoice_id, amount) VALUES (current_tenant_id(), $1, $2, $3)`, [cn.id, inv.id, amt.toFixed(2)]);
      await tx.query('UPDATE invoices SET amount_credited = amount_credited + $2 WHERE id = $1', [inv.id, amt.toFixed(2)]);
      left = left.minus(amt);
    }
    await this.refreshInvoiceStatuses(tx, open.map((i) => i.id));
    await tx.query('UPDATE credit_notes SET amount_applied = $2, invoice_id = (SELECT invoice_id FROM credit_note_applications WHERE credit_note_id = $1 LIMIT 1) WHERE id = $1', [cn.id, total.minus(left).toFixed(2)]);

    const acc = await this.journal.accounts(tx);
    const je = await this.journal.post(tx, {
      date,
      description: `Credit note ${number} (order ${order.number})`,
      sourceType: 'CREDIT_NOTE',
      sourceId: cn.id,
      lines: [
        { accountId: acc.revenue, debit: net, description: 'Sales returns' },
        { accountId: acc.vatOutput, debit: tax, description: 'VAT output reversal' },
        { accountId: acc.ar, credit: total, customerId: order.customer_id, description: 'Accounts receivable' },
      ],
    });
    await tx.query('UPDATE credit_notes SET journal_entry_id = $2 WHERE id = $1', [cn.id, je]);
    await this.audit.record(tx, { action: 'CREDIT_NOTE_ISSUED', entityType: 'credit_note', entityId: cn.id, after: { number, total: total.toFixed(2), returnId } });
    await this.autoCloseSettledOrders(tx, open.map((i) => i.id), actorUserId);
    return cn.id;
  }

  async refreshInvoiceStatuses(tx: Tx, invoiceIds: string[]) {
    if (!invoiceIds.length) return;
    await tx.query(
      `UPDATE invoices SET status = CASE
           WHEN amount_paid + amount_credited >= grand_total THEN 'PAID'
           WHEN amount_paid + amount_credited > 0 THEN 'PARTIALLY_PAID'
           ELSE 'ISSUED' END
        WHERE id = ANY($1::uuid[]) AND status <> 'VOID'`,
      [invoiceIds],
    );
  }

  async invoice(tx: Tx, invoiceId: string) {
    const inv = await tx.maybeOne(
      `SELECT i.*, c.code AS customer_code, c.name AS customer_name, o.number AS order_number,
              i.grand_total - i.amount_paid - i.amount_credited AS balance_due
         FROM invoices i JOIN customers c ON c.id = i.customer_id LEFT JOIN sales_orders o ON o.id = i.sales_order_id
        WHERE i.id = $1`,
      [invoiceId],
    );
    if (!inv) throw notFound('Invoice');
    const lines = await tx.query('SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no', [invoiceId]);
    const payments = await tx.query(
      `SELECT r.id, r.number, r.receipt_date, r.payment_method, a.amount FROM receipt_allocations a
         JOIN customer_receipts r ON r.id = a.receipt_id WHERE a.invoice_id = $1 ORDER BY r.receipt_date`,
      [invoiceId],
    );
    const credits = await tx.query(
      `SELECT cn.id, cn.number, cn.credit_date, cn.reason, a.amount FROM credit_note_applications a
         JOIN credit_notes cn ON cn.id = a.credit_note_id WHERE a.invoice_id = $1 ORDER BY cn.credit_date`,
      [invoiceId],
    );
    return { ...inv, lines, payments, credits };
  }

  private lines(tx: Tx, orderId: string) {
    return tx.query<OrderLineRow>(
      `SELECT l.id, l.line_no, l.product_id, p.name AS product_name, l.quantity, l.unit_price, l.discount_percent,
              l.tax_rate_percent, l.net_amount, l.tax_amount, l.line_total, l.discount_amount,
              l.qty_dispatched, l.qty_delivered, l.qty_returned, l.qty_invoiced, l.qty_credited
         FROM sales_order_lines l JOIN products p ON p.id = l.product_id
        WHERE l.order_id = $1 ORDER BY l.line_no FOR UPDATE OF l`,
      [orderId],
    );
  }

  /**
   * Amounts for invoicing `qty` of a line. When this invoice completes the
   * whole line, the amounts are the line's totals minus what earlier invoices
   * already billed, so the invoices always add up to the order exactly.
   */
  private async amountsForInvoice(tx: Tx, l: OrderLineRow, qty: Decimal, currency: string): Promise<Amounts> {
    const completesLine = D(l.qty_credited).isZero() && D(l.qty_invoiced).plus(qty).eq(l.quantity);
    if (completesLine) {
      const prev = await tx.one<{ net: string; tax: string; disc: string }>(
        `SELECT COALESCE(SUM(il.net_amount), 0) AS net, COALESCE(SUM(il.tax_amount), 0) AS tax, COALESCE(SUM(il.discount_amount), 0) AS disc
           FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
          WHERE il.sales_order_line_id = $1 AND i.status <> 'VOID'`,
        [l.id],
      );
      const net = D(l.net_amount).minus(prev.net);
      const tax = D(l.tax_amount).minus(prev.tax);
      const discount = D(l.discount_amount).minus(prev.disc);
      return { net, tax, discount, gross: net.plus(discount), total: net.plus(tax) };
    }
    const p = priceLine({ quantity: qty.toString(), unitPrice: l.unit_price, discountPercent: l.discount_percent, taxRatePercent: l.tax_rate_percent }, currency);
    return { gross: D(p.grossAmount), discount: D(p.discountAmount), net: D(p.netAmount), tax: D(p.taxAmount), total: D(p.lineTotal) };
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
