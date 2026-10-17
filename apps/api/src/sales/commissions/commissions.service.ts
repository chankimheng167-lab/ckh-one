import { Injectable } from '@nestjs/common';
import {
  commissionAmount,
  commissionRate,
  CommissionBasis,
  CommissionRules,
  Decimal,
  P,
  tierMultiplier,
  validateCommissionRules,
} from '@ckh/shared';
import { has, TenantUser } from '../../common/auth-context';
import { AuditService } from '../../common/audit.service';
import { conflict, DomainError, forbidden, notFound } from '../../common/errors';
import type { Tx } from '../../db/database.service';
import { JournalService } from '../../accounting/journal.service';
import { NumberingService } from '../../core/numbering.service';
import { SalesContextService } from '../sales-context.service';
import { TargetsService } from '../targets/targets.service';

const D = (v: Decimal.Value) => new Decimal(v);
const monthOf = (date: string) => `${date.slice(0, 7)}-01`;

interface Plan {
  id: string;
  basis: CommissionBasis;
  rules: CommissionRules;
}

/**
 * Commission engine. Entries are created as ESTIMATED from source documents
 * (invoices, verified collections, credit notes, overdue clawbacks), approved
 * per rep and month by a manager (which accrues them in the ledger: Dr
 * commission expense / Cr commissions payable), then sent to HR & Payroll in a
 * batch that payroll marks paid.
 *
 * Nothing is earned on an order until it is invoiced (or, for collection
 * plans, paid), so cancelled orders never carry commission.
 */
@Injectable()
export class CommissionsService {
  constructor(
    private readonly ctx: SalesContextService,
    private readonly targets: TargetsService,
    private readonly journal: JournalService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Plans
  // ---------------------------------------------------------------------------

  async createPlan(tx: Tx, user: TenantUser, i: { code: string; name: string; basis: CommissionBasis; rules: CommissionRules; validFrom: string; validTo?: string }) {
    const errors = validateCommissionRules(i.rules);
    if (errors.length) throw new DomainError('COMMISSION_RULES_INVALID', errors.join('; '), 422, { errors });
    const plan = await tx.one(
      `INSERT INTO sales_commission_plans (tenant_id, code, name, basis, rules, valid_from, valid_to)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6) RETURNING *`,
      [i.code, i.name, i.basis, JSON.stringify(i.rules), i.validFrom, i.validTo ?? null],
    );
    await this.audit.record(tx, { action: 'COMMISSION_PLAN_CREATED', entityType: 'sales_commission_plan', entityId: plan.id, after: plan });
    return plan;
  }

  async updatePlan(tx: Tx, id: string, i: { name?: string; rules?: CommissionRules; validTo?: string | null; status?: 'DRAFT' | 'ACTIVE' | 'RETIRED' }) {
    if (i.rules) {
      const errors = validateCommissionRules(i.rules);
      if (errors.length) throw new DomainError('COMMISSION_RULES_INVALID', errors.join('; '), 422, { errors });
    }
    const before = await tx.maybeOne('SELECT * FROM sales_commission_plans WHERE id = $1 FOR UPDATE', [id]);
    if (!before) throw notFound('Commission plan');
    const after = await tx.one(
      `UPDATE sales_commission_plans SET name = COALESCE($2, name), rules = COALESCE($3::jsonb, rules),
              valid_to = CASE WHEN $4::boolean THEN $5::date ELSE valid_to END, status = COALESCE($6, status)
        WHERE id = $1 RETURNING *`,
      [id, i.name ?? null, i.rules ? JSON.stringify(i.rules) : null, i.validTo !== undefined, i.validTo ?? null, i.status ?? null],
    );
    await this.audit.record(tx, { action: 'COMMISSION_PLAN_UPDATED', entityType: 'sales_commission_plan', entityId: id, before, after });
    return after;
  }

  listPlans(tx: Tx) {
    return tx.query(
      `SELECT p.*, (SELECT count(*) FROM sales_representatives r WHERE r.commission_plan_id = p.id) AS rep_count
         FROM sales_commission_plans p ORDER BY p.status, p.code`,
    );
  }

  async assignPlan(tx: Tx, salesRepId: string, planId: string | null) {
    const r = await tx.maybeOne('UPDATE sales_representatives SET commission_plan_id = $2 WHERE id = $1 RETURNING id, commission_plan_id', [salesRepId, planId]);
    if (!r) throw notFound('Sales representative');
    await this.audit.record(tx, { action: 'COMMISSION_PLAN_ASSIGNED', entityType: 'sales_representative', entityId: salesRepId, after: r });
    return r;
  }

  // ---------------------------------------------------------------------------
  // Event hooks (called inside the source document's transaction)
  // ---------------------------------------------------------------------------

  async onInvoice(tx: Tx, invoiceId: string) {
    if (!(await this.enabled(tx))) return;
    const inv = await tx.one<{ id: string; sales_rep_id: string | null; customer_id: string; customer_group_id: string | null; invoice_date: string; currency: string }>(
      `SELECT i.id, i.sales_rep_id, i.customer_id, c.customer_group_id, i.invoice_date, i.currency
         FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = $1`,
      [invoiceId],
    );
    if (!inv.sales_rep_id) return;
    const plan = await this.planFor(tx, inv.sales_rep_id, inv.invoice_date);
    if (!plan || plan.basis === 'COLLECTED_AMOUNT') return;
    const { base, amount } = await this.invoiceCommission(tx, plan, invoiceId, inv);
    await this.entry(tx, { plan, repId: inv.sales_rep_id, date: inv.invoice_date, sourceType: 'INVOICE', sourceId: invoiceId, invoiceId, base, amount, currency: inv.currency });
  }

  async onCreditNote(tx: Tx, creditNoteId: string) {
    if (!(await this.enabled(tx))) return;
    const cn = await tx.one<{ id: string; customer_id: string; customer_group_id: string | null; credit_date: string; currency: string; sales_rep_id: string | null; sales_order_id: string | null }>(
      `SELECT cn.id, cn.customer_id, c.customer_group_id, cn.credit_date, cn.currency, o.sales_rep_id, cn.sales_order_id
         FROM credit_notes cn JOIN customers c ON c.id = cn.customer_id LEFT JOIN sales_orders o ON o.id = cn.sales_order_id WHERE cn.id = $1`,
      [creditNoteId],
    );
    if (!cn.sales_rep_id || !cn.sales_order_id) return;
    // Reverse at the plan that paid the original invoice commission.
    const orig = await tx.maybeOne<{ plan_id: string }>(
      `SELECT e.plan_id FROM sales_commission_entries e JOIN invoices i ON i.id = e.invoice_id
        WHERE i.sales_order_id = $1 AND e.source_type = 'INVOICE' AND e.status <> 'REVERSED' ORDER BY e.created_at LIMIT 1`,
      [cn.sales_order_id],
    );
    if (!orig) return;
    const plan = await this.planById(tx, orig.plan_id);
    const lines = await tx.query<{ product_id: string; category_id: string | null; net_amount: string; quantity: string; sales_order_line_id: string | null }>(
      `SELECT cl.product_id, p.category_id, cl.net_amount, cl.quantity, cl.sales_order_line_id
         FROM credit_note_lines cl LEFT JOIN products p ON p.id = cl.product_id WHERE cl.credit_note_id = $1`,
      [creditNoteId],
    );
    let base = D(0);
    let amount = D(0);
    for (const l of lines) {
      const rate = commissionRate(plan.rules, { productId: l.product_id, categoryId: l.category_id, customerId: cn.customer_id, customerGroupId: cn.customer_group_id });
      let lineBase = D(l.net_amount);
      if (plan.basis === 'GROSS_PROFIT' && l.sales_order_line_id) lineBase = lineBase.minus(await this.costOf(tx, l.sales_order_line_id, l.quantity));
      base = base.plus(lineBase);
      amount = amount.plus(commissionAmount(lineBase, rate));
    }
    await this.entry(tx, { plan, repId: cn.sales_rep_id, date: cn.credit_date, sourceType: 'CREDIT_NOTE', sourceId: creditNoteId, invoiceId: null, base: base.neg(), amount: amount.neg(), currency: cn.currency });
  }

  /** Collection-based plans earn on verified receipts; paid invoices also reinstate overdue clawbacks. */
  async onReceipt(tx: Tx, receiptId: string) {
    if (!(await this.enabled(tx))) return;
    const allocs = await tx.query<{ invoice_id: string; amount: string; sales_rep_id: string | null; customer_id: string; customer_group_id: string | null; receipt_date: string; currency: string; subtotal: string; discount_total: string; grand_total: string; status: string }>(
      `SELECT a.invoice_id, a.amount, i.sales_rep_id, i.customer_id, c.customer_group_id, r.receipt_date, i.currency,
              i.subtotal, i.discount_total, i.grand_total, i.status
         FROM receipt_allocations a JOIN invoices i ON i.id = a.invoice_id JOIN customer_receipts r ON r.id = a.receipt_id
         JOIN customers c ON c.id = i.customer_id WHERE a.receipt_id = $1`,
      [receiptId],
    );
    const perRep = new Map<string, { plan: Plan; base: Decimal; amount: Decimal; date: string; currency: string }>();
    for (const a of allocs) {
      if (!a.sales_rep_id) continue;
      const plan = await this.planFor(tx, a.sales_rep_id, a.receipt_date);
      if (plan?.basis === 'COLLECTED_AMOUNT') {
        // Commission on the VAT-exclusive part of the payment, at the invoice's blended rate.
        const { base: invBase, amount: invAmt } = await this.invoiceCommission(tx, plan, a.invoice_id, a);
        const netShare = D(a.amount).mul(D(a.subtotal).minus(a.discount_total)).div(a.grand_total);
        const rate = invBase.isZero() ? D(0) : invAmt.div(invBase);
        const acc = perRep.get(a.sales_rep_id) ?? { plan, base: D(0), amount: D(0), date: a.receipt_date, currency: a.currency };
        acc.base = acc.base.plus(netShare);
        acc.amount = acc.amount.plus(netShare.mul(rate));
        perRep.set(a.sales_rep_id, acc);
      }
      if (a.status === 'PAID') await this.reinstateClawback(tx, a.invoice_id, a.receipt_date);
    }
    for (const [repId, v] of perRep) {
      await this.entry(tx, { plan: v.plan, repId, date: v.date, sourceType: 'COLLECTION', sourceId: receiptId, invoiceId: null, base: v.base, amount: v.amount.toDecimalPlaces(2), currency: v.currency });
    }
  }

  /** Claws back commission on invoices left unpaid past the plan's limit. Safe to run repeatedly (e.g. nightly). */
  async runClawbacks(tx: Tx, asOf: string) {
    if (!(await this.enabled(tx))) return { clawedBack: 0 };
    const rows = await tx.query<{ entry_id: string; plan_id: string; sales_rep_id: string; invoice_id: string; amount: string; base_amount: string; currency: string; open: string; grand_total: string; days: number }>(
      `SELECT e.id AS entry_id, e.plan_id, e.sales_rep_id, e.invoice_id, e.amount, e.base_amount, e.currency,
              i.grand_total - i.amount_paid - i.amount_credited AS open, i.grand_total,
              (p.rules->>'clawbackOverdueDays')::int AS days
         FROM sales_commission_entries e
         JOIN invoices i ON i.id = e.invoice_id
         JOIN sales_commission_plans p ON p.id = e.plan_id
        WHERE e.source_type = 'INVOICE' AND e.status <> 'REVERSED'
          AND p.rules ? 'clawbackOverdueDays'
          AND i.status IN ('ISSUED', 'PARTIALLY_PAID')
          AND i.due_date + (p.rules->>'clawbackOverdueDays')::int < $1::date
          AND NOT EXISTS (SELECT 1 FROM sales_commission_entries x WHERE x.source_type = 'OVERDUE_CLAWBACK' AND x.source_id = e.invoice_id AND x.sales_rep_id = e.sales_rep_id)`,
      [asOf],
    );
    for (const r of rows) {
      const share = D(r.open).div(r.grand_total);
      const plan = await this.planById(tx, r.plan_id);
      await this.entry(tx, {
        plan, repId: r.sales_rep_id, date: asOf, sourceType: 'OVERDUE_CLAWBACK', sourceId: r.invoice_id, invoiceId: r.invoice_id,
        base: D(r.base_amount).mul(share).neg().toDecimalPlaces(2), amount: D(r.amount).mul(share).neg().toDecimalPlaces(2), currency: r.currency,
        notes: `Unpaid more than ${r.days} days after due date`,
      });
    }
    return { clawedBack: rows.length };
  }

  // ---------------------------------------------------------------------------
  // Approval, adjustments, payroll hand-off
  // ---------------------------------------------------------------------------

  async adjust(tx: Tx, user: TenantUser, i: { salesRepId: string; periodMonth: string; amount: string; notes: string }) {
    const rep = await tx.maybeOne<{ commission_plan_id: string | null; user_id: string }>('SELECT commission_plan_id, user_id FROM sales_representatives WHERE id = $1', [i.salesRepId]);
    if (!rep) throw notFound('Sales representative');
    if (rep.user_id === user.userId) throw forbidden('You cannot adjust your own commission');
    if (!rep.commission_plan_id) throw new DomainError('NO_COMMISSION_PLAN', 'This representative has no commission plan', 422);
    const currency = (await tx.one<{ base_currency: string }>('SELECT base_currency FROM tenants WHERE id = current_tenant_id()')).base_currency;
    return tx.one(
      `INSERT INTO sales_commission_entries (tenant_id, plan_id, sales_rep_id, period_month, source_type, base_amount, amount, currency, notes, created_by)
       VALUES (current_tenant_id(), $1, $2, $3, 'MANUAL_ADJUSTMENT', 0, $4, $5, $6, $7) RETURNING *`,
      [rep.commission_plan_id, i.salesRepId, monthOf(i.periodMonth), i.amount, currency, i.notes, user.userId],
    );
  }

  /**
   * Approves the month's estimated entries (optionally for one rep): adds any
   * target-tier bonus, then accrues the approved total in the ledger.
   */
  async approve(tx: Tx, user: TenantUser, i: { periodMonth: string; salesRepId?: string }) {
    const month = monthOf(i.periodMonth);
    const reps = await tx.query<{ sales_rep_id: string; user_id: string; currency: string }>(
      `SELECT DISTINCT e.sales_rep_id, r.user_id, e.currency FROM sales_commission_entries e JOIN sales_representatives r ON r.id = e.sales_rep_id
        WHERE e.period_month = $1 AND e.status = 'ESTIMATED' AND ($2::uuid IS NULL OR e.sales_rep_id = $2)`,
      [month, i.salesRepId ?? null],
    );
    if (!reps.length) throw conflict('NOTHING_TO_APPROVE', 'No estimated commission for that month');
    if (reps.some((r) => r.user_id === user.userId)) throw forbidden('You cannot approve your own commission');

    const acc = await this.journal.accounts(tx);
    const summary: { salesRepId: string; amount: string; tierBonus: string }[] = [];
    for (const r of reps) {
      const rep = await tx.one<{ commission_plan_id: string | null }>('SELECT commission_plan_id FROM sales_representatives WHERE id = $1', [r.sales_rep_id]);
      let bonus = D(0);
      if (rep.commission_plan_id) {
        const plan = await this.planById(tx, rep.commission_plan_id);
        if (plan.rules.tiers?.length) {
          const ach = await this.targets.monthlyNetSalesAchievement(tx, r.sales_rep_id, month);
          const mult = D(tierMultiplier(plan.rules, ach ?? '0'));
          if (mult.gt(1)) {
            const est = await tx.one<{ s: string }>(
              `SELECT COALESCE(SUM(amount), 0) AS s FROM sales_commission_entries
                WHERE sales_rep_id = $1 AND period_month = $2 AND status = 'ESTIMATED' AND source_type <> 'TIER_BONUS'`,
              [r.sales_rep_id, month],
            );
            bonus = D(est.s).mul(mult.minus(1)).toDecimalPlaces(2);
            if (bonus.gt(0)) {
              await tx.query(
                `INSERT INTO sales_commission_entries (tenant_id, plan_id, sales_rep_id, period_month, source_type, base_amount, rate_percent, amount, currency, notes, created_by)
                 VALUES (current_tenant_id(), $1, $2, $3, 'TIER_BONUS', $4, $5, $6, $7, $8, $9)`,
                [plan.id, r.sales_rep_id, month, est.s, mult.minus(1).mul(100).toString(), bonus.toFixed(2), r.currency, `Target achievement ${ach}% → ×${mult}`, user.userId],
              );
            }
          }
        }
      }
      const total = await tx.one<{ s: string }>(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM sales_commission_entries WHERE sales_rep_id = $1 AND period_month = $2 AND status = 'ESTIMATED'`,
        [r.sales_rep_id, month],
      );
      const amt = D(total.s);
      const je = await this.journal.post(tx, {
        date: tx.today(),
        description: `Commission accrual ${month.slice(0, 7)}`,
        sourceType: 'COMMISSION',
        sourceId: r.sales_rep_id,
        lines: amt.gte(0)
          ? [{ accountId: acc.commissionExpense, debit: amt, description: 'Sales commission' }, { accountId: acc.commissionPayable, credit: amt, description: 'Commissions payable' }]
          : [{ accountId: acc.commissionPayable, debit: amt.neg(), description: 'Commissions payable' }, { accountId: acc.commissionExpense, credit: amt.neg(), description: 'Sales commission reversal' }],
      });
      await tx.query(
        `UPDATE sales_commission_entries SET status = 'APPROVED', approved_by = $3, approved_at = now(), journal_entry_id = $4
          WHERE sales_rep_id = $1 AND period_month = $2 AND status = 'ESTIMATED'`,
        [r.sales_rep_id, month, user.userId, je],
      );
      summary.push({ salesRepId: r.sales_rep_id, amount: amt.toFixed(2), tierBonus: bonus.toFixed(2) });
    }
    await this.audit.record(tx, { action: 'COMMISSIONS_APPROVED', entityType: 'sales_commission_entries', entityId: month, after: summary });
    return { periodMonth: month, approved: summary };
  }

  /** Sends the month's approved commission to HR & Payroll. */
  async sendToPayroll(tx: Tx, user: TenantUser, periodMonth: string) {
    const month = monthOf(periodMonth);
    const rows = await tx.query<{ sales_rep_id: string; employee_code: string; hr_employee_id: string | null; currency: string; amount: string; n: string }>(
      `SELECT e.sales_rep_id, r.employee_code, r.hr_employee_id, e.currency, SUM(e.amount) AS amount, count(*) AS n
         FROM sales_commission_entries e JOIN sales_representatives r ON r.id = e.sales_rep_id
        WHERE e.period_month = $1 AND e.status = 'APPROVED' AND e.payroll_batch_id IS NULL
        GROUP BY e.sales_rep_id, r.employee_code, r.hr_employee_id, e.currency`,
      [month],
    );
    if (!rows.length) throw conflict('NOTHING_TO_SEND', 'No approved commission waiting for payroll in that month');
    const currencies = [...new Set(rows.map((r) => r.currency))];
    if (currencies.length > 1) throw new DomainError('MIXED_CURRENCY', `Approved commission is in several currencies (${currencies.join(', ')})`, 422);
    const total = rows.reduce((s, r) => s.plus(r.amount), D(0));
    const number = await this.numbering.next(tx, 'PAYROLL_BATCH');
    const batch = await tx.one<{ id: string }>(
      `INSERT INTO payroll_commission_batches (tenant_id, number, period_month, currency, total_amount, created_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5) RETURNING id`,
      [number, month, currencies[0], total.toFixed(2), user.userId],
    );
    for (const r of rows) {
      await tx.query(
        `INSERT INTO payroll_commission_batch_lines (tenant_id, batch_id, sales_rep_id, hr_employee_id, employee_code, amount, entry_count)
         VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6)`,
        [batch.id, r.sales_rep_id, r.hr_employee_id, r.employee_code, r.amount, Number(r.n)],
      );
    }
    await tx.query(
      `UPDATE sales_commission_entries SET status = 'SENT_TO_PAYROLL', payroll_batch_id = $2, payroll_reference = $3
        WHERE period_month = $1 AND status = 'APPROVED' AND payroll_batch_id IS NULL`,
      [month, batch.id, number],
    );
    await this.audit.record(tx, { action: 'COMMISSIONS_SENT_TO_PAYROLL', entityType: 'payroll_commission_batch', entityId: batch.id, after: { number, total: total.toFixed(2) } });
    return this.batch(tx, batch.id);
  }

  async markBatchPaid(tx: Tx, user: TenantUser, batchId: string, hrReference: string) {
    const b = await tx.maybeOne<{ status: string; number: string }>('SELECT status, number FROM payroll_commission_batches WHERE id = $1 FOR UPDATE', [batchId]);
    if (!b) throw notFound('Payroll batch');
    if (b.status !== 'SENT') throw conflict('BATCH_NOT_OPEN', `Batch ${b.number} is ${b.status.toLowerCase()}`);
    await tx.query(`UPDATE payroll_commission_batches SET status = 'PAID', paid_at = now(), paid_by = $2, hr_reference = $3 WHERE id = $1`, [batchId, user.userId, hrReference]);
    await tx.query(`UPDATE sales_commission_entries SET status = 'PAID' WHERE payroll_batch_id = $1`, [batchId]);
    await this.audit.record(tx, { action: 'PAYROLL_BATCH_PAID', entityType: 'payroll_commission_batch', entityId: batchId, after: { hrReference } });
    return this.batch(tx, batchId);
  }

  async batch(tx: Tx, batchId: string) {
    const b = await tx.maybeOne('SELECT * FROM payroll_commission_batches WHERE id = $1', [batchId]);
    if (!b) throw notFound('Payroll batch');
    const lines = await tx.query(
      `SELECT l.*, u.full_name AS rep_name FROM payroll_commission_batch_lines l
         JOIN sales_representatives r ON r.id = l.sales_rep_id JOIN users u ON u.id = r.user_id WHERE l.batch_id = $1 ORDER BY l.employee_code`,
      [batchId],
    );
    return { ...b, lines };
  }

  listBatches(tx: Tx, status?: string) {
    return tx.query(
      `SELECT * FROM payroll_commission_batches WHERE ($1::text IS NULL OR status = $1) ORDER BY period_month DESC, number DESC`,
      [status ?? null],
    );
  }

  // ---------------------------------------------------------------------------
  // Read side
  // ---------------------------------------------------------------------------

  /** Entries visible to the user: own (reps), team (supervisors), all (commission managers). */
  async entries(tx: Tx, user: TenantUser, q: { periodMonth?: string; salesRepId?: string; status?: string; limit: number; offset: number }) {
    const [pred, scopeParams] = await this.scope(tx, user, 1);
    const params: unknown[] = [...scopeParams];
    const where = [pred];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (q.periodMonth) add('e.period_month = ?::date', monthOf(q.periodMonth));
    if (q.salesRepId) add('e.sales_rep_id = ?', q.salesRepId);
    if (q.status) add('e.status = ?', q.status);
    params.push(q.limit, q.offset);
    return tx.query(
      `SELECT e.id, e.period_month, e.source_type, e.source_id, e.base_amount, e.rate_percent, e.amount, e.currency, e.status,
              e.notes, e.created_at, e.payroll_reference, u.full_name AS rep_name, p.code AS plan_code,
              COALESCE(i.number, cn.number, rc.number) AS source_number, count(*) OVER () AS total_count
         FROM sales_commission_entries e
         JOIN sales_representatives r ON r.id = e.sales_rep_id JOIN users u ON u.id = r.user_id
         JOIN sales_commission_plans p ON p.id = e.plan_id
         LEFT JOIN invoices i ON i.id = e.source_id AND e.source_type IN ('INVOICE', 'OVERDUE_CLAWBACK', 'CLAWBACK_REINSTATED')
         LEFT JOIN credit_notes cn ON cn.id = e.source_id AND e.source_type = 'CREDIT_NOTE'
         LEFT JOIN customer_receipts rc ON rc.id = e.source_id AND e.source_type = 'COLLECTION'
        WHERE ${where.join(' AND ')}
        ORDER BY e.period_month DESC, e.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
  }

  /** Commission dashboard: per rep and month, estimated vs approved vs paid. */
  async summary(tx: Tx, user: TenantUser, q: { from?: string; to?: string }) {
    const [pred, params] = await this.scope(tx, user, 3);
    return tx.query(
      `SELECT e.sales_rep_id, u.full_name AS rep_name, e.period_month, e.currency,
              SUM(e.amount) FILTER (WHERE e.status = 'ESTIMATED') AS estimated,
              SUM(e.amount) FILTER (WHERE e.status = 'APPROVED') AS approved,
              SUM(e.amount) FILTER (WHERE e.status = 'SENT_TO_PAYROLL') AS sent_to_payroll,
              SUM(e.amount) FILTER (WHERE e.status = 'PAID') AS paid,
              SUM(e.amount) FILTER (WHERE e.amount < 0) AS adjustments,
              SUM(e.amount) AS total
         FROM sales_commission_entries e
         JOIN sales_representatives r ON r.id = e.sales_rep_id JOIN users u ON u.id = r.user_id
        WHERE e.period_month BETWEEN COALESCE($1::date, '1900-01-01') AND COALESCE($2::date, '2999-12-01') AND ${pred}
        GROUP BY e.sales_rep_id, u.full_name, e.period_month, e.currency
        ORDER BY e.period_month DESC, u.full_name`,
      [q.from ? monthOf(q.from) : null, q.to ? monthOf(q.to) : null, ...params],
    );
  }

  // ---------------------------------------------------------------------------

  private async scope(tx: Tx, user: TenantUser, start: number): Promise<[string, unknown[]]> {
    if (has(user, P.SALES_COMMISSIONS_MANAGE)) return ['TRUE', []];
    const rep = await this.ctx.repForUser(tx, user.userId);
    const teams = has(user, P.SALES_ORDERS_VIEW_TEAM) ? await this.ctx.managedTeamIds(tx, user.userId) : [];
    return [
      `(e.sales_rep_id = $${start} OR e.sales_rep_id IN (SELECT id FROM sales_representatives WHERE team_id = ANY($${start + 1}::uuid[])))`,
      [rep?.id ?? null, teams],
    ];
  }

  private async enabled(tx: Tx): Promise<boolean> {
    const r = await tx.maybeOne(
      `SELECT 1 FROM tenant_modules WHERE tenant_id = current_tenant_id() AND module_code = 'SALES_COMMISSION_MANAGEMENT'
          AND enabled AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())`,
    );
    return !!r;
  }

  private async planFor(tx: Tx, repId: string, onDate: string): Promise<Plan | null> {
    return tx.maybeOne<Plan>(
      `SELECT p.id, p.basis, p.rules FROM sales_representatives r JOIN sales_commission_plans p ON p.id = r.commission_plan_id
        WHERE r.id = $1 AND p.status = 'ACTIVE' AND p.valid_from <= $2::date AND (p.valid_to IS NULL OR p.valid_to >= $2::date)`,
      [repId, onDate],
    );
  }

  private planById(tx: Tx, id: string): Promise<Plan> {
    return tx.one<Plan>('SELECT id, basis, rules FROM sales_commission_plans WHERE id = $1', [id]);
  }

  private async invoiceCommission(tx: Tx, plan: Plan, invoiceId: string, inv: { customer_id: string; customer_group_id: string | null }) {
    const lines = await tx.query<{ product_id: string | null; category_id: string | null; net_amount: string; quantity: string; sales_order_line_id: string | null }>(
      `SELECT il.product_id, p.category_id, il.net_amount, il.quantity, il.sales_order_line_id
         FROM invoice_lines il LEFT JOIN products p ON p.id = il.product_id WHERE il.invoice_id = $1`,
      [invoiceId],
    );
    let base = D(0);
    let amount = D(0);
    for (const l of lines) {
      const rate = commissionRate(plan.rules, { productId: l.product_id ?? '', categoryId: l.category_id, customerId: inv.customer_id, customerGroupId: inv.customer_group_id });
      let lineBase = D(l.net_amount);
      if (plan.basis === 'GROSS_PROFIT' && l.sales_order_line_id) lineBase = lineBase.minus(await this.costOf(tx, l.sales_order_line_id, l.quantity));
      base = base.plus(lineBase);
      amount = amount.plus(commissionAmount(lineBase, rate));
    }
    return { base, amount };
  }

  /** Cost of `qty` (line units) of an order line, at the average cost it was shipped at. */
  private async costOf(tx: Tx, orderLineId: string, qty: string): Promise<Decimal> {
    const r = await tx.one<{ cost: string | null; factor: string }>(
      `SELECT (SELECT SUM(dl.unit_cost * dl.quantity_base) / NULLIF(SUM(dl.quantity_base), 0) FROM sales_delivery_lines dl WHERE dl.order_line_id = l.id) AS cost,
              l.unit_factor AS factor
         FROM sales_order_lines l WHERE l.id = $1`,
      [orderLineId],
    );
    return D(r.cost ?? 0).mul(r.factor).mul(qty).toDecimalPlaces(2);
  }

  private async reinstateClawback(tx: Tx, invoiceId: string, date: string) {
    const claws = await tx.query<{ plan_id: string; sales_rep_id: string; amount: string; base_amount: string; currency: string }>(
      `SELECT plan_id, sales_rep_id, amount, base_amount, currency FROM sales_commission_entries c
        WHERE source_type = 'OVERDUE_CLAWBACK' AND source_id = $1
          AND NOT EXISTS (SELECT 1 FROM sales_commission_entries x WHERE x.source_type = 'CLAWBACK_REINSTATED' AND x.source_id = $1 AND x.sales_rep_id = c.sales_rep_id)`,
      [invoiceId],
    );
    for (const c of claws) {
      const plan = await this.planById(tx, c.plan_id);
      await this.entry(tx, {
        plan, repId: c.sales_rep_id, date, sourceType: 'CLAWBACK_REINSTATED', sourceId: invoiceId, invoiceId,
        base: D(c.base_amount).neg(), amount: D(c.amount).neg(), currency: c.currency, notes: 'Invoice paid after clawback',
      });
    }
  }

  private async entry(
    tx: Tx,
    e: { plan: Plan; repId: string; date: string; sourceType: string; sourceId: string; invoiceId: string | null; base: Decimal; amount: Decimal; currency: string; notes?: string },
  ) {
    if (e.amount.isZero() && e.base.isZero()) return;
    const rate = e.base.isZero() ? null : e.amount.div(e.base).mul(100).toDecimalPlaces(4).toString();
    await tx.query(
      `INSERT INTO sales_commission_entries (tenant_id, plan_id, sales_rep_id, period_month, source_type, source_id, invoice_id,
          base_amount, rate_percent, amount, currency, notes)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT DO NOTHING`,
      [e.plan.id, e.repId, monthOf(e.date), e.sourceType, e.sourceId, e.invoiceId, e.base.toFixed(2), rate, e.amount.toFixed(2), e.currency, e.notes ?? null],
    );
  }
}
