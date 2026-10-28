import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { TenantUser } from '../common/auth-context';
import { isoDate } from '../common/validation';
import type { Tx } from '../db/database.service';
import { PosContextService } from './pos-context.service';

export const ReconciliationQuery = z.object({ date: isoDate.optional(), to: isoDate.optional() });

export interface Check {
  code: string;
  ok: boolean;
  details: unknown;
}

/**
 * Proves the POS books agree with the POS documents: every sale, return,
 * shift difference, verification and settlement is posted exactly once and
 * for the right amount, the pending-verification clearing account equals the
 * payments still waiting, and every closed drawer adds up.
 */
@Injectable()
export class PosReconciliationService {
  constructor(private readonly ctx: PosContextService) {}

  async reconcile(tx: Tx, user: TenantUser, q: z.infer<typeof ReconciliationQuery>) {
    const from = q.date ?? tx.today();
    const to = q.to ?? from;
    const branches = await this.ctx.branchIds(tx, user);
    const checks = await this.documentChecks(tx, from, to, branches);
    // The clearing account is company-wide, so only someone who sees every branch can check it.
    if (!branches) checks.push(await this.clearingCheck(tx));
    const p = [from, to, branches];
    const scope = `($3::uuid[] IS NULL OR s.branch_id = ANY($3::uuid[]))`;
    const summary = await tx.one(
      `SELECT
         (SELECT count(*)::int FROM pos_sale_payments p JOIN pos_sales s ON s.id = p.sale_id WHERE p.status = 'PENDING_VERIFICATION' AND ${scope}) AS pending_payments,
         (SELECT COALESCE(sum(p.amount), 0) FROM pos_sale_payments p JOIN pos_sales s ON s.id = p.sale_id WHERE p.status = 'PENDING_VERIFICATION' AND ${scope}) AS pending_amount,
         (SELECT min(p.created_at) FROM pos_sale_payments p JOIN pos_sales s ON s.id = p.sale_id WHERE p.status = 'PENDING_VERIFICATION' AND ${scope}) AS oldest_pending,
         (SELECT count(*)::int FROM pos_sales s WHERE s.amount_unpaid > 0 AND ${scope}) AS balance_due_sales,
         (SELECT COALESCE(sum(s.amount_unpaid), 0) FROM pos_sales s WHERE ${scope}) AS balance_due_amount,
         (SELECT count(*)::int FROM pos_sales s WHERE s.review_status = 'NEEDS_REVIEW' AND ${scope}) AS sales_to_review,
         (SELECT count(*)::int FROM pos_sale_payments p JOIN pos_sales s ON s.id = p.sale_id
            WHERE p.status = 'REJECTED' AND p.verified_at::date BETWEEN $1 AND $2 AND ${scope}) AS rejected_in_period`,
      p,
    );
    return { from, to, ok: checks.every((c) => c.ok), checkedAt: new Date().toISOString(), checks, summary };
  }

  /** The checks `/accounting/integrity` adds for POS, over all dates and branches. */
  async ledgerChecks(tx: Tx): Promise<Check[]> {
    const posted = await this.documentChecks(tx, '0001-01-01', '9999-12-31', null);
    const clearing = await this.clearingCheck(tx);
    const failed = posted.filter((c) => !c.ok);
    return [
      { code: 'POS_DOCUMENTS_POSTED', ok: failed.length === 0, details: failed.length ? failed : { checks: posted.map((c) => c.code) } },
      { ...clearing, code: 'POS_PENDING_CLEARING_MATCHES' },
    ];
  }

  private async clearingCheck(tx: Tx): Promise<Check> {
    const r = await tx.one<{ ledger: string; payments: string }>(
      `SELECT
         (SELECT COALESCE(sum(l.debit - l.credit), 0) FROM journal_lines l
            JOIN journal_entries e ON e.id = l.journal_entry_id AND e.status = 'POSTED'
            JOIN pos_settings st ON st.pending_payment_account_id = l.account_id) AS ledger,
         (SELECT COALESCE(sum(amount), 0) FROM pos_sale_payments WHERE status = 'PENDING_VERIFICATION') AS payments`,
    );
    return { code: 'PENDING_CLEARING_MATCHES', ok: Number(r.ledger) === Number(r.payments), details: r };
  }

  private async documentChecks(tx: Tx, from: string, to: string, branches: string[] | null): Promise<Check[]> {
    const p = [from, to, branches];
    const scope = `($3::uuid[] IS NULL OR s.branch_id = ANY($3::uuid[]))`;
    // Each sale's entry: Dr payments (= grand total) + discounts ex tax + cost of goods, and the same in credits.
    const sales = await tx.query(
      `SELECT s.number, s.grand_total, x.expected, j.debit, j.credit, j.n
         FROM pos_sales s
         CROSS JOIN LATERAL (SELECT s.grand_total + s.cost_total + COALESCE((SELECT sum(l.discount_ex_tax) FROM pos_sale_lines l WHERE l.sale_id = s.id), 0) AS expected) x
         LEFT JOIN LATERAL (SELECT count(DISTINCT e.id)::int AS n, sum(l.debit) AS debit, sum(l.credit) AS credit
                              FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id
                             WHERE e.source_type = 'POS_SALE' AND e.source_id = s.id AND e.status = 'POSTED') j ON true
        WHERE s.business_date BETWEEN $1 AND $2 AND ${scope}
          AND NOT (x.expected = 0 AND COALESCE(j.n, 0) = 0)
          AND (COALESCE(j.n, 0) <> 1 OR j.debit <> x.expected OR j.credit <> x.expected OR s.journal_entry_id IS NULL)
        ORDER BY s.number LIMIT 50`,
      p,
    );
    const payments = await tx.query(
      `SELECT s.number, s.grand_total, s.amount_unpaid, x.paid
         FROM pos_sales s
         CROSS JOIN LATERAL (SELECT COALESCE(sum(amount), 0) AS paid FROM pos_sale_payments WHERE sale_id = s.id AND status <> 'REJECTED') x
        WHERE s.business_date BETWEEN $1 AND $2 AND ${scope} AND x.paid + s.amount_unpaid <> s.grand_total
        ORDER BY s.number LIMIT 50`,
      p,
    );
    // Each return's entry credits exactly what was refunded to the customer's tenders.
    const returns = await tx.query(
      `SELECT r.number, r.refund_total, x.refunds, j.n, j.balanced
         FROM pos_returns r JOIN pos_sales s ON s.id = r.sale_id
         CROSS JOIN LATERAL (SELECT COALESCE(sum(amount), 0) AS refunds FROM pos_return_refunds WHERE return_id = r.id) x
         LEFT JOIN LATERAL (SELECT count(DISTINCT e.id)::int AS n, sum(l.debit) = sum(l.credit) AS balanced
                              FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id
                             WHERE e.source_type = 'POS_RETURN' AND e.source_id = r.id AND e.status = 'POSTED') j ON true
        WHERE r.business_date BETWEEN $1 AND $2 AND ${scope}
          AND (x.refunds <> r.refund_total OR (r.refund_total > 0 AND (COALESCE(j.n, 0) <> 1 OR NOT j.balanced)))
        ORDER BY r.number LIMIT 50`,
      p,
    );
    // Verified and rejected payments and settlements each have their own entry.
    const verifications = await tx.query(
      `SELECT s.number, p.line_no, p.status, p.amount, p.is_settlement
         FROM pos_sale_payments p JOIN pos_sales s ON s.id = p.sale_id
        WHERE s.business_date BETWEEN $1 AND $2 AND ${scope} AND p.amount > 0
          AND ((p.verified_at IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM journal_entries e WHERE e.id = p.verification_journal_id AND e.source_id = p.id
                    AND e.source_type = CASE p.status WHEN 'CONFIRMED' THEN 'POS_PAYMENT_VERIFIED' ELSE 'POS_PAYMENT_REJECTED' END))
            OR (p.is_settlement AND NOT EXISTS (
                 SELECT 1 FROM journal_entries e WHERE e.id = p.journal_entry_id AND e.source_type = 'POS_SALE_SETTLEMENT' AND e.source_id = p.id)))
        ORDER BY s.number, p.line_no LIMIT 50`,
      p,
    );
    // Closed drawers: the stored expected cash is the sum of the movements, and any difference was posted.
    const shifts = await tx.query(
      `SELECT s.number, s.expected_cash, x.movements, s.cash_difference, s.journal_entry_id IS NOT NULL AS posted
         FROM pos_shifts s
         CROSS JOIN LATERAL (SELECT COALESCE(sum(amount), 0) AS movements FROM pos_cash_movements WHERE shift_id = s.id) x
        WHERE s.status <> 'OPEN' AND s.business_date BETWEEN $1 AND $2 AND ${scope}
          AND (s.expected_cash <> x.movements OR (s.cash_difference <> 0 AND s.journal_entry_id IS NULL))
        ORDER BY s.number LIMIT 50`,
      p,
    );
    return [
      { code: 'SALES_POSTED_ONCE_AND_MATCH', ok: sales.length === 0, details: sales },
      { code: 'SALE_PAYMENTS_ADD_UP', ok: payments.length === 0, details: payments },
      { code: 'RETURNS_POSTED_AND_MATCH', ok: returns.length === 0, details: returns },
      { code: 'VERIFICATIONS_POSTED', ok: verifications.length === 0, details: verifications },
      { code: 'SHIFT_CASH_ADDS_UP', ok: shifts.length === 0, details: shifts },
    ];
  }
}
