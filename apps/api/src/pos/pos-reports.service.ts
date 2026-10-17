import { Injectable } from '@nestjs/common';
import { Decimal } from '@ckh/shared';
import { z } from 'zod';
import type { TenantUser } from '../common/auth-context';
import { isoDate, uuid } from '../common/validation';
import type { Tx } from '../db/database.service';
import { PosContextService } from './pos-context.service';

export const DailyQuery = z.object({
  date: isoDate.optional(),
  to: isoDate.optional(),
  branchId: uuid.optional(),
  registerId: uuid.optional(),
});

/**
 * Daily sales report for a business day (or a range): sales and refunds by
 * register, cashier, payment method, hour, category and tax rate, with the
 * day's shifts and their cash differences. Limited to the user's branches.
 */
@Injectable()
export class PosReportsService {
  constructor(private readonly ctx: PosContextService) {}

  async daily(tx: Tx, user: TenantUser, q: z.infer<typeof DailyQuery>) {
    const from = q.date ?? tx.today();
    const to = q.to ?? from;
    const branches = await this.ctx.branchIds(tx, user);
    if (q.branchId) await this.ctx.assertBranch(tx, user, q.branchId);
    // $1 from, $2 to, $3 branch filter, $4 register, $5 allowed branches
    const p = [from, to, q.branchId ?? null, q.registerId ?? null, branches];
    const sales = `s.business_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR s.branch_id = $3) AND ($4::uuid IS NULL OR s.register_id = $4)
                   AND ($5::uuid[] IS NULL OR s.branch_id = ANY($5::uuid[]))`;
    const rets = sales.replaceAll('s.', 'r.');

    const totals = await tx.one(
      `SELECT count(*)::int AS receipts, COALESCE(sum(subtotal), 0) AS subtotal, COALESCE(sum(discount_total), 0) AS discounts,
              COALESCE(sum(net_total), 0) AS net_sales, COALESCE(sum(tax_total), 0) AS tax, COALESCE(sum(grand_total), 0) AS gross_sales,
              COALESCE(sum(cost_total), 0) AS cost, COALESCE(avg(grand_total), 0)::numeric(18,2) AS average_sale,
              count(*) FILTER (WHERE is_offline)::int AS offline_receipts
         FROM pos_sales s WHERE ${sales}`,
      p,
    );
    const refunds = await tx.one(
      `SELECT count(*)::int AS count, COALESCE(sum(refund_total), 0) AS total, COALESCE(sum(net_total), 0) AS net,
              COALESCE(sum(tax_total), 0) AS tax, COALESCE(sum(cost_total), 0) AS cost
         FROM pos_returns r WHERE ${rets}`,
      p,
    );
    const D = (v: string) => new Decimal(v);
    const summary = {
      ...totals,
      refunds: refunds.total,
      refund_count: refunds.count,
      net_after_refunds: D(totals.gross_sales).minus(refunds.total).toFixed(2),
      net_sales_after_refunds: D(totals.net_sales).minus(refunds.net).toFixed(2),
      tax_after_refunds: D(totals.tax).minus(refunds.tax).toFixed(2),
      gross_margin: D(totals.net_sales).minus(refunds.net).minus(D(totals.cost).minus(refunds.cost)).toFixed(2),
    };

    const byRegister = await tx.query(
      `SELECT g.code, g.name, b.name AS branch, count(*)::int AS receipts, sum(s.grand_total) AS total, sum(s.discount_total) AS discounts
         FROM pos_sales s JOIN pos_registers g ON g.id = s.register_id JOIN branches b ON b.id = s.branch_id
        WHERE ${sales} GROUP BY g.code, g.name, b.name ORDER BY b.name, g.code`,
      p,
    );
    const byCashier = await tx.query(
      `SELECT u.full_name AS cashier, count(*)::int AS receipts, sum(s.grand_total) AS total, sum(s.discount_total) AS discounts,
              COALESCE((SELECT sum(r.refund_total) FROM pos_returns r WHERE r.processed_by = u.id AND ${rets}), 0) AS refunds
         FROM pos_sales s JOIN users u ON u.id = s.cashier_id WHERE ${sales} GROUP BY u.id, u.full_name ORDER BY total DESC`,
      p,
    );
    const byMethod = await tx.query(
      `SELECT m.code, m.name, m.kind,
              COALESCE(sum(x.sales) , 0) AS sales, COALESCE(sum(x.pending), 0) AS pending, COALESCE(sum(x.refunds), 0) AS refunds,
              COALESCE(sum(x.sales), 0) - COALESCE(sum(x.refunds), 0) AS net
         FROM pos_payment_methods m
         JOIN (
           SELECT pp.method_id, CASE WHEN pp.status = 'CONFIRMED' THEN pp.amount ELSE 0 END AS sales,
                  CASE WHEN pp.status = 'PENDING_VERIFICATION' THEN pp.amount ELSE 0 END AS pending, 0::numeric AS refunds
             FROM pos_sale_payments pp JOIN pos_sales s ON s.id = pp.sale_id WHERE ${sales} AND pp.status <> 'REJECTED'
           UNION ALL
           SELECT rr.method_id, 0, 0, rr.amount FROM pos_return_refunds rr JOIN pos_returns r ON r.id = rr.return_id WHERE ${rets}
         ) x ON x.method_id = m.id
        GROUP BY m.code, m.name, m.kind, m.sort_order ORDER BY m.sort_order`,
      p,
    );
    const byHour = await tx.query(
      `SELECT extract(hour FROM s.sold_at AT TIME ZONE $6)::int AS hour, count(*)::int AS receipts, sum(s.grand_total) AS total
         FROM pos_sales s WHERE ${sales} GROUP BY 1 ORDER BY 1`,
      [...p, tx.timezone],
    );
    const byCategory = await tx.query(
      `SELECT COALESCE(c.name, 'Uncategorised') AS category, sum(l.quantity) AS quantity, sum(l.line_total) AS total
         FROM pos_sale_lines l JOIN pos_sales s ON s.id = l.sale_id JOIN products pr ON pr.id = l.product_id
         LEFT JOIN products parent ON parent.id = pr.parent_product_id
         LEFT JOIN product_categories c ON c.id = COALESCE(pr.category_id, parent.category_id)
        WHERE ${sales} GROUP BY 1 ORDER BY total DESC`,
      p,
    );
    const topProducts = await tx.query(
      `SELECT l.sku, l.description, sum(l.quantity) AS quantity, sum(l.quantity_returned) AS returned, sum(l.line_total) AS total
         FROM pos_sale_lines l JOIN pos_sales s ON s.id = l.sale_id WHERE ${sales}
        GROUP BY l.sku, l.description ORDER BY total DESC LIMIT 20`,
      p,
    );
    const tax = await tx.query(
      `SELECT l.tax_rate_percent AS rate, sum(l.net_amount) AS taxable, sum(l.tax_amount) AS tax,
              COALESCE((SELECT sum(rl.net_amount) FROM pos_return_lines rl JOIN pos_returns r ON r.id = rl.return_id JOIN pos_sale_lines sl ON sl.id = rl.sale_line_id
                         WHERE sl.tax_rate_percent = l.tax_rate_percent AND ${rets}), 0) AS returned_taxable,
              COALESCE((SELECT sum(rl.tax_amount) FROM pos_return_lines rl JOIN pos_returns r ON r.id = rl.return_id JOIN pos_sale_lines sl ON sl.id = rl.sale_line_id
                         WHERE sl.tax_rate_percent = l.tax_rate_percent AND ${rets}), 0) AS returned_tax
         FROM pos_sale_lines l JOIN pos_sales s ON s.id = l.sale_id WHERE ${sales} GROUP BY l.tax_rate_percent ORDER BY l.tax_rate_percent`,
      p,
    );
    const shifts = await tx.query(
      `SELECT s.id, s.number, s.status, g.code AS register, u.full_name AS cashier, s.opened_at, s.closed_at, s.opening_float,
              s.expected_cash, s.counted_cash, s.cash_difference
         FROM pos_shifts s JOIN pos_registers g ON g.id = s.register_id JOIN users u ON u.id = s.cashier_id
        WHERE ${sales} ORDER BY s.opened_at`,
      p,
    );
    const discounts = await tx.query(
      `SELECT u.full_name AS approved_by, count(*)::int AS receipts, sum(s.discount_total) AS discounts
         FROM pos_sales s JOIN users u ON u.id = s.discount_approved_by WHERE ${sales} GROUP BY u.full_name ORDER BY discounts DESC`,
      p,
    );
    return {
      from, to, currency: (await tx.one(`SELECT base_currency FROM tenants WHERE id = current_tenant_id()`)).base_currency,
      summary, byRegister, byCashier, byMethod, byHour, byCategory, topProducts, tax, shifts, approvedDiscounts: discounts,
    };
  }

  /** The same report as CSV sections (opens in Excel). */
  toCsv(r: Awaited<ReturnType<PosReportsService['daily']>>): string {
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      // Neutralise spreadsheet formulas in text cells.
      const safe = /^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const section = (title: string, rows: Record<string, unknown>[]) => {
      if (!rows.length) return `${title}\n(none)\n`;
      const keys = Object.keys(rows[0]);
      return [title, keys.join(','), ...rows.map((x) => keys.map((k) => cell(x[k])).join(','))].join('\n') + '\n';
    };
    return [
      `POS daily sales report,${r.from},${r.to},${r.currency}`,
      section('Summary', [r.summary]),
      section('By register', r.byRegister),
      section('By cashier', r.byCashier),
      section('By payment method', r.byMethod),
      section('By hour', r.byHour),
      section('By category', r.byCategory),
      section('Top products', r.topProducts),
      section('Tax', r.tax),
      section('Shifts', r.shifts.map(({ id: _i, ...s }: any) => s)),
    ].join('\n');
  }
}
