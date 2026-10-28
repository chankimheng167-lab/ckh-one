import { Injectable } from '@nestjs/common';
import { Decimal, looksLikeCardNumber, P, PricingError, refundForLine } from '@ckh/shared';
import { z } from 'zod';
import { has, TenantUser } from '../common/auth-context';
import { AuditService } from '../common/audit.service';
import { conflict, DomainError, forbidden, notFound } from '../common/errors';
import { isoDate, positiveDecimal, uuid } from '../common/validation';
import type { Tx } from '../db/database.service';
import { JournalLineInput, JournalService } from '../accounting/journal.service';
import { NumberingService } from '../core/numbering.service';
import { StockService } from '../inventory/stock.service';
import { PosContextService } from './pos-context.service';
import { canonical, clientKey, PosApproval, sha256 } from './pos-schemas';
import { PosSalesService } from './pos-sales.service';

const D = (v: Decimal.Value) => new Decimal(v);
/** A stored sale line as the shared refund maths expects it. */
const amounts = (l: any) => ({
  quantity: l.quantity, grossExTax: l.gross_ex_tax, discountExTax: l.discount_ex_tax, net: l.net_amount, tax: l.tax_amount, total: l.line_total,
});

export const ReturnInput = z.object({
  clientReturnId: clientKey,
  saleId: uuid,
  /** The register the goods come back to (its open shift pays out cash refunds). */
  registerId: uuid,
  reason: z.string().trim().min(1).max(500),
  lines: z
    .array(
      z.object({
        saleLineId: uuid,
        quantity: positiveDecimal,
        /** False for damaged goods: they are not put back on the shelf. */
        restock: z.boolean().default(true),
        serialNumbers: z.array(z.string().trim().min(1).max(100)).max(1000).default([]),
      }),
    )
    .min(1)
    .max(500),
  refunds: z
    .array(z.object({ methodId: uuid, amount: positiveDecimal, reference: z.string().trim().min(1).max(120).optional() }))
    .min(1)
    .max(10),
  approval: PosApproval.optional(),
});
export type ReturnInput = z.infer<typeof ReturnInput>;

export const ReturnsQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  registerId: uuid.optional(),
  saleId: uuid.optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Returns and refunds against a POS sale. Amounts are worked out from what
 * the customer actually paid for each line (discounts and tax included), in
 * proportion to the quantity returned, so several partial returns add up
 * exactly to the sale. Refunds go back to the methods the customer paid
 * with, never more than was paid by each; cash comes out of the open shift.
 */
@Injectable()
export class PosReturnsService {
  constructor(
    private readonly ctx: PosContextService,
    private readonly sales: PosSalesService,
    private readonly stock: StockService,
    private readonly journal: JournalService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  async create(tx: Tx, user: TenantUser, input: ReturnInput) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`pos-return:${tx.tenantId}:${input.clientReturnId}`]);
    const { approval: _a, ...hashed } = input;
    const payloadHash = sha256(canonical(hashed));
    const existing = await tx.maybeOne<{ id: string; payload_hash: string }>('SELECT id, payload_hash FROM pos_returns WHERE client_return_id = $1', [
      input.clientReturnId,
    ]);
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw conflict('IDEMPOTENCY_CONFLICT', 'This return id was already used for a different return');
      return { return: await this.details(tx, user, existing.id), replayed: true };
    }

    const reg = await this.ctx.register(tx, user, input.registerId);
    // Lock the sale: two returns of the same sale are processed one after the other.
    const sale = await tx.maybeOne('SELECT * FROM pos_sales WHERE id = $1 FOR UPDATE', [input.saleId]);
    if (!sale) throw notFound('Sale');
    await this.ctx.assertBranch(tx, user, sale.branch_id);
    const approverId = await this.ctx.authorise(tx, user, [P.POS_REFUNDS_CREATE], input.approval, reg.branch_id, 'this refund');
    const settings = await this.ctx.settings(tx);
    const shift = await this.ctx.openShift(tx, reg.id, true);
    if (!shift && settings.requireOpenShift) throw conflict('SHIFT_NOT_OPEN', `Open a shift on ${reg.name} before refunding`);
    if (shift && shift.cashier_id !== user.userId && !has(user, P.POS_SHIFT_APPROVE)) {
      throw forbidden('The open shift on this register belongs to another cashier');
    }

    // Lines: what can still be returned, and its share of what was paid.
    const soldLines = new Map(
      (await tx.query('SELECT * FROM pos_sale_lines WHERE sale_id = $1 FOR UPDATE', [sale.id])).map((l: any) => [l.id as string, l]),
    );
    const returnedSerials = await this.returnedSerials(tx, sale.id);
    const seen = new Set<string>();
    const lines = input.lines.map((l, i) => {
      const s = soldLines.get(l.saleLineId);
      if (!s) throw new DomainError('RETURN_LINE_INVALID', `Line ${i + 1} is not part of sale ${sale.number}`, 422);
      if (seen.has(l.saleLineId)) throw new DomainError('RETURN_LINE_INVALID', `Line ${i + 1}: ${s.description} is listed twice`, 422);
      seen.add(l.saleLineId);
      let refund;
      try {
        refund = refundForLine(
          amounts(s),
          s.quantity_returned,
          l.quantity,
          sale.currency,
        );
      } catch (e) {
        if (e instanceof PricingError) throw new DomainError('RETURN_QUANTITY_INVALID', `${s.description}: ${e.message}`, 422);
        throw e;
      }
      const sold: string[] = s.serial_numbers ?? [];
      if (sold.length) {
        if (!D(l.quantity).isInteger() || l.serialNumbers.length !== Number(l.quantity)) {
          throw new DomainError('SERIALS_REQUIRED', `${s.description}: enter the serial number of each unit returned`, 422);
        }
        const back = new Set(returnedSerials.get(s.id) ?? []);
        for (const sn of l.serialNumbers) {
          if (!sold.some((x) => x.toLowerCase() === sn.toLowerCase())) {
            throw new DomainError('SERIAL_NOT_ON_SALE', `Serial ${sn} was not sold on ${sale.number}`, 422);
          }
          if (back.has(sn.toLowerCase())) throw conflict('SERIAL_ALREADY_RETURNED', `Serial ${sn} was already returned`);
        }
        if (new Set(l.serialNumbers.map((x) => x.toLowerCase())).size !== l.serialNumbers.length) {
          throw new DomainError('SERIAL_DUPLICATE', 'The same serial number is entered twice', 422);
        }
      } else if (l.serialNumbers.length) {
        throw new DomainError('SERIALS_NOT_TRACKED', `${s.description} does not use serial numbers`, 422);
      }
      return { input: l, sold: s, amounts: refund };
    });
    const total = lines.reduce((a, l) => a.plus(l.amounts.total), D(0));

    // Refund tenders: back to the methods used on the sale, within what each paid.
    const paid = await this.refundableByMethod(tx, sale.id);
    const refundTotal = input.refunds.reduce((a, r) => a.plus(r.amount), D(0));
    if (!refundTotal.eq(total)) {
      throw new DomainError('REFUND_TOTAL_MISMATCH', `Refund ${total.toFixed(2)} ${sale.currency}; the refund payments add up to ${refundTotal.toFixed(2)}`, 422, {
        refundTotal: total.toFixed(2),
      });
    }
    const perMethod = new Map<string, Decimal>();
    const tenders = input.refunds.map((r) => {
      const p = paid.find((x) => x.method_id === r.methodId);
      if (!p) throw new DomainError('REFUND_METHOD_NOT_ALLOWED', 'Refunds go back to a payment method used on this sale', 422);
      if (D(p.paid).isZero() && p.pending) {
        throw conflict('PAYMENT_NOT_VERIFIED', `${p.name} on this sale is not verified yet; verify it before refunding to it`);
      }
      if (r.reference && looksLikeCardNumber(r.reference)) {
        throw new DomainError('CARD_NUMBER_NOT_ALLOWED', 'Do not enter card numbers. Enter the terminal refund code instead.', 422);
      }
      const used = (perMethod.get(p.method_id) ?? D(0)).plus(r.amount);
      perMethod.set(p.method_id, used);
      const left = D(p.paid).minus(p.refunded);
      if (used.gt(left)) {
        throw new DomainError('REFUND_EXCEEDS_PAYMENT', `Only ${left.toFixed(2)} ${sale.currency} paid by ${p.name} can still be refunded`, 422);
      }
      if (p.kind !== 'CASH' && !r.reference) throw new DomainError('REFERENCE_REQUIRED', `${p.name}: enter the refund reference`, 422);
      return { input: r, method: p };
    });
    const cashOut = tenders.filter((t) => t.method.kind === 'CASH').reduce((a, t) => a.plus(t.input.amount), D(0));
    if (cashOut.gt(0)) {
      if (!shift) throw conflict('SHIFT_NOT_OPEN', 'Cash refunds are paid from an open shift');
      const inDrawer = D((await tx.one<{ t: string }>('SELECT COALESCE(sum(amount), 0) AS t FROM pos_cash_movements WHERE shift_id = $1', [shift.id])).t);
      if (inDrawer.lt(cashOut)) throw conflict('NOT_ENOUGH_CASH', `Only ${inDrawer.toFixed(2)} ${sale.currency} is in the drawer`);
    }

    const number = await this.numbering.next(tx, 'POS_RETURN');
    const day = tx.today();
    const sum = (k: 'grossExTax' | 'discountExTax' | 'net' | 'tax') => lines.reduce((a, l) => a.plus(l.amounts[k]), D(0));
    const ret = await tx.one<{ id: string }>(
      `INSERT INTO pos_returns (tenant_id, number, client_return_id, payload_hash, sale_id, register_id, shift_id, branch_id, processed_by, approved_by,
          business_date, reason, currency, gross_ex_tax, discount_ex_tax, net_total, tax_total, refund_total)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
      [number, input.clientReturnId, payloadHash, sale.id, reg.id, shift?.id ?? null, reg.branch_id, user.userId, approverId, day, input.reason,
        sale.currency, sum('grossExTax').toFixed(2), sum('discountExTax').toFixed(2), sum('net').toFixed(2), sum('tax').toFixed(2), total.toFixed(2)],
    );

    // Stock back on the shelf (at the cost it left with), serials released, lines marked.
    let restockedCost = D(0);
    for (const l of lines) {
      const s = l.sold;
      const unitCost = D(s.unit_cost ?? 0);
      const restock = l.input.restock && s.track_inventory;
      if (restock) {
        await this.stock.receiveBack(tx, {
          warehouseId: sale.warehouse_id, productId: s.product_id, qtyBase: D(l.input.quantity), unitCost, reserve: false,
          referenceType: 'POS_RETURN', referenceId: ret.id, userId: user.userId, type: 'POS_RETURN', notes: `Return ${number} of ${sale.number}`,
        });
        restockedCost = restockedCost.plus(unitCost.mul(l.input.quantity));
      }
      await tx.query(
        `INSERT INTO pos_return_lines (tenant_id, return_id, sale_line_id, product_id, quantity, restock, gross_ex_tax, discount_ex_tax, net_amount,
            tax_amount, refund_amount, unit_cost, serial_numbers)
         VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [ret.id, s.id, s.product_id, l.input.quantity, restock, l.amounts.grossExTax, l.amounts.discountExTax, l.amounts.net, l.amounts.tax,
          l.amounts.total, unitCost.toString(), l.input.serialNumbers],
      );
      await tx.query('UPDATE pos_sale_lines SET quantity_returned = quantity_returned + $2 WHERE id = $1', [s.id, l.input.quantity]);
      for (const sn of l.input.serialNumbers) {
        await tx.query(`UPDATE pos_sold_serials SET returned = true WHERE sale_line_id = $1 AND lower(serial_no) = lower($2) AND NOT returned`, [s.id, sn]);
      }
    }
    const costTotal = restockedCost.toDecimalPlaces(2);
    await tx.query('UPDATE pos_returns SET cost_total = $2 WHERE id = $1', [ret.id, costTotal.toFixed(2)]);

    for (const t of tenders) {
      await tx.query(
        `INSERT INTO pos_return_refunds (tenant_id, return_id, method_id, kind, amount, reference, account_id)
         VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6)`,
        [ret.id, t.method.method_id, t.method.kind, t.input.amount, t.input.reference ?? null, t.method.account_id],
      );
    }
    if (cashOut.gt(0) && shift) {
      await tx.query(
        `INSERT INTO pos_cash_movements (tenant_id, shift_id, movement_type, amount, reference_type, reference_id, reason, created_by)
         VALUES (current_tenant_id(), $1, 'REFUND', $2, 'POS_RETURN', $3, $4, $5)`,
        [shift.id, cashOut.neg().toFixed(2), ret.id, input.reason, user.userId],
      );
    }

    // Ledger: the sale entry in reverse for the part returned.
    const acc = await this.journal.accounts(tx);
    const jl: JournalLineInput[] = [
      { accountId: acc.revenue, debit: sum('grossExTax'), description: 'Sales returns' },
      { accountId: acc.salesDiscount, credit: sum('discountExTax'), description: 'Discounts reversed' },
      { accountId: acc.vatOutput, debit: sum('tax'), description: 'VAT output reversed' },
      ...tenders.map((t) => ({ accountId: t.method.account_id, credit: D(t.input.amount), description: `Refund ${t.method.name}` })),
      { accountId: acc.inventory, debit: costTotal, description: 'Inventory returned' },
      { accountId: acc.cogs, credit: costTotal, description: 'Cost of goods returned' },
    ];
    const journalId = await this.journal.post(tx, { date: day, description: `POS return ${number} of ${sale.number}`, sourceType: 'POS_RETURN', sourceId: ret.id, lines: jl });
    await tx.query('UPDATE pos_returns SET journal_entry_id = $2 WHERE id = $1', [ret.id, journalId]);

    const left = await tx.one<{ open: boolean }>('SELECT bool_or(quantity_returned < quantity) AS open FROM pos_sale_lines WHERE sale_id = $1', [sale.id]);
    await tx.query(`UPDATE pos_sales SET refunded_total = refunded_total + $2, status = $3 WHERE id = $1`, [
      sale.id, total.toFixed(2), left.open ? 'PARTIALLY_REFUNDED' : 'REFUNDED',
    ]);
    await this.audit.record(tx, {
      action: 'POS_RETURN_CREATED',
      entityType: 'pos_return',
      entityId: ret.id,
      after: {
        number, sale: sale.number, total: total.toFixed(2), reason: input.reason, approvedBy: approverId,
        lines: lines.map((l) => ({ sku: l.sold.sku, quantity: l.input.quantity, restock: l.input.restock })),
        refunds: tenders.map((t) => ({ method: t.method.name, amount: t.input.amount })),
      },
    });
    return { return: await this.details(tx, user, ret.id), replayed: false };
  }

  async details(tx: Tx, user: TenantUser, id: string) {
    const r = await tx.maybeOne(
      `SELECT r.*, s.number AS sale_number, s.sold_at AS sale_sold_at, s.customer_id, c.name AS customer_name, reg.code AS register_code,
              reg.name AS register_name, b.name AS branch_name, b.address AS branch_address, b.phone AS branch_phone,
              u.full_name AS processed_by_name, a.full_name AS approved_by_name, je.number AS journal_number
         FROM pos_returns r JOIN pos_sales s ON s.id = r.sale_id JOIN pos_registers reg ON reg.id = r.register_id
         JOIN branches b ON b.id = r.branch_id JOIN users u ON u.id = r.processed_by
         LEFT JOIN users a ON a.id = r.approved_by LEFT JOIN customers c ON c.id = s.customer_id
         LEFT JOIN journal_entries je ON je.id = r.journal_entry_id
        WHERE r.id = $1`,
      [id],
    );
    if (!r) throw notFound('Return');
    await this.ctx.assertBranch(tx, user, r.branch_id);
    if (!has(user, P.POS_SALES_VIEW_ALL) && !has(user, P.POS_REFUNDS_CREATE) && r.processed_by !== user.userId) throw notFound('Return');
    r.lines = await tx.query(
      `SELECT rl.*, sl.line_no, sl.sku, sl.description, sl.unit_price FROM pos_return_lines rl JOIN pos_sale_lines sl ON sl.id = rl.sale_line_id
        WHERE rl.return_id = $1 ORDER BY sl.line_no`,
      [id],
    );
    r.refunds = await tx.query(
      `SELECT rr.id, rr.kind, rr.amount, rr.reference, m.code AS method_code, m.name AS method_name
         FROM pos_return_refunds rr JOIN pos_payment_methods m ON m.id = rr.method_id WHERE rr.return_id = $1 ORDER BY m.sort_order`,
      [id],
    );
    if (!has(user, P.POS_REPORTS_VIEW)) {
      delete r.cost_total;
      for (const l of r.lines) delete l.unit_cost;
    }
    return r;
  }

  async list(tx: Tx, user: TenantUser, q: z.infer<typeof ReturnsQuery>) {
    const branches = await this.ctx.branchIds(tx, user);
    const params: unknown[] = [];
    const where = ['TRUE'];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replaceAll('?', `$${params.length}`));
    };
    if (branches) add('r.branch_id = ANY(?::uuid[])', branches);
    if (!has(user, P.POS_SALES_VIEW_ALL) && !has(user, P.POS_REFUNDS_CREATE)) add('r.processed_by = ?', user.userId);
    if (q.from) add('r.business_date >= ?', q.from);
    if (q.to) add('r.business_date <= ?', q.to);
    if (q.registerId) add('r.register_id = ?', q.registerId);
    if (q.saleId) add('r.sale_id = ?', q.saleId);
    if (q.q) add('(r.number ILIKE ? OR s.number ILIKE ?)', `%${q.q}%`);
    params.push(q.limit, q.offset);
    return tx.query(
      `SELECT r.id, r.number, r.business_date, r.created_at, r.reason, r.refund_total, r.currency, s.id AS sale_id, s.number AS sale_number,
              reg.code AS register_code, u.full_name AS processed_by_name, a.full_name AS approved_by_name,
              (SELECT string_agg(DISTINCT m.name, ', ') FROM pos_return_refunds rr JOIN pos_payment_methods m ON m.id = rr.method_id WHERE rr.return_id = r.id) AS refund_methods,
              count(*) OVER () AS total_count
         FROM pos_returns r JOIN pos_sales s ON s.id = r.sale_id JOIN pos_registers reg ON reg.id = r.register_id
         JOIN users u ON u.id = r.processed_by LEFT JOIN users a ON a.id = r.approved_by
        WHERE ${where.join(' AND ')}
        ORDER BY r.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
  }

  /** Serials already brought back, per sale line (lower case). */
  private async returnedSerials(tx: Tx, saleId: string): Promise<Map<string, string[]>> {
    const rows = await tx.query<{ sale_line_id: string; serials: string[] }>(
      `SELECT rl.sale_line_id, array_agg(lower(sn)) AS serials
         FROM pos_return_lines rl JOIN pos_returns r ON r.id = rl.return_id, unnest(rl.serial_numbers) AS sn
        WHERE r.sale_id = $1 GROUP BY rl.sale_line_id`,
      [saleId],
    );
    return new Map(rows.map((r) => [r.sale_line_id, r.serials]));
  }

  /**
   * Confirmed payments per method on a sale, less what was already refunded
   * to each. Payments still waiting for verification cannot be refunded to.
   */
  private refundableByMethod(tx: Tx, saleId: string) {
    return tx.query<{ method_id: string; kind: string; name: string; account_id: string; paid: string; refunded: string; pending: boolean }>(
      `SELECT p.method_id, p.kind, m.name, m.sort_order, (array_agg(p.account_id))[1] AS account_id,
              COALESCE(sum(p.amount) FILTER (WHERE p.status = 'CONFIRMED'), 0) AS paid,
              bool_or(p.status = 'PENDING_VERIFICATION') AS pending,
              COALESCE((SELECT sum(rr.amount) FROM pos_return_refunds rr JOIN pos_returns r ON r.id = rr.return_id
                         WHERE r.sale_id = $1 AND rr.method_id = p.method_id), 0) AS refunded
         FROM pos_sale_payments p JOIN pos_payment_methods m ON m.id = p.method_id
        WHERE p.sale_id = $1 AND p.status <> 'REJECTED'
        GROUP BY p.method_id, p.kind, m.name, m.sort_order ORDER BY m.sort_order`,
      [saleId],
    );
  }

  /**
   * Sale lines with what can still be returned and its refund value, for the
   * returns screen. Anyone working the till in the sale's branch can look a
   * receipt up; recording the refund still needs refund permission or a PIN.
   */
  async returnable(tx: Tx, user: TenantUser, saleId: string) {
    const s = await tx.maybeOne<{ branch_id: string }>('SELECT branch_id FROM pos_sales WHERE id = $1', [saleId]);
    if (!s) throw notFound('Sale');
    await this.ctx.assertBranch(tx, user, s.branch_id);
    const sale = await this.sales.details(tx, user, saleId, { skipScope: true });
    const refundable = await this.refundableByMethod(tx, saleId);
    const back = await this.returnedSerials(tx, saleId);
    return {
      sale,
      lines: sale.lines.map((l: any) => {
        const remaining = D(l.quantity).minus(l.quantity_returned);
        return {
          saleLineId: l.id, lineNo: l.line_no, sku: l.sku, description: l.description, quantity: l.quantity, quantityReturned: l.quantity_returned,
          remaining: remaining.toString(), trackInventory: l.track_inventory, lineTotal: l.line_total,
          serialNumbers: ((l.serial_numbers ?? []) as string[]).filter((x) => !(back.get(l.id) ?? []).includes(x.toLowerCase())),
          refundIfAll: remaining.gt(0)
            ? refundForLine(amounts(l), l.quantity_returned, remaining.toString(), sale.currency).total
            : '0.00',
        };
      }),
      methods: refundable.map(({ account_id: _a, ...m }) => ({ ...m, available: D(m.paid).minus(m.refunded).toFixed(2) })),
    };
  }

  /** Prices a return without recording it (what the returns screen shows). */
  async preview(tx: Tx, saleId: string, lines: { saleLineId: string; quantity: string }[]) {
    const sale = await tx.maybeOne('SELECT currency FROM pos_sales WHERE id = $1', [saleId]);
    if (!sale) throw notFound('Sale');
    let total = D(0);
    const out = [];
    for (const l of lines) {
      const s = await tx.maybeOne('SELECT * FROM pos_sale_lines WHERE id = $1 AND sale_id = $2', [l.saleLineId, saleId]);
      if (!s) throw new DomainError('RETURN_LINE_INVALID', 'Line is not part of this sale', 422);
      try {
        const a = refundForLine(amounts(s), s.quantity_returned, l.quantity, sale.currency);
        total = total.plus(a.total);
        out.push({ saleLineId: l.saleLineId, ...a });
      } catch (e) {
        if (e instanceof PricingError) throw new DomainError('RETURN_QUANTITY_INVALID', `${s.description}: ${e.message}`, 422);
        throw e;
      }
    }
    return { lines: out, refundTotal: total.toFixed(2), currency: sale.currency };
  }
}
