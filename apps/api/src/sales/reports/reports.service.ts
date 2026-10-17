import { Injectable } from '@nestjs/common';
import { MODULES, ModuleCode, P } from '@ckh/shared';
import { has, TenantUser } from '../../common/auth-context';
import { DomainError, forbidden } from '../../common/errors';
import type { Tx } from '../../db/database.service';
import { SubscriptionService } from '../../core/subscriptions/subscription.service';
import { SalesContextService } from '../sales-context.service';
import { TargetsService } from '../targets/targets.service';

export interface ReportFilters {
  from: string;
  to: string;
  salesRepId?: string;
  teamId?: string;
  territoryId?: string;
  customerId?: string;
}
export interface ReportColumn {
  key: string;
  label: string;
  type: 'text' | 'number' | 'money' | 'percent' | 'date';
}
export interface Report {
  code: string;
  title: string;
  filters: ReportFilters;
  generatedAt: string;
  currency: string;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  totals: Record<string, unknown> | null;
}

interface Def {
  title: string;
  modules: ModuleCode[];
  columns: ReportColumn[];
  /** Columns summed into the totals row. */
  sum?: string[];
  run: (tx: Tx, f: ReportFilters, reps: string[] | null) => Promise<Record<string, unknown>[]>;
}

const money = (key: string, label: string): ReportColumn => ({ key, label, type: 'money' });
const num = (key: string, label: string): ReportColumn => ({ key, label, type: 'number' });
const pct = (key: string, label: string): ReportColumn => ({ key, label, type: 'percent' });
const text = (key: string, label: string): ReportColumn => ({ key, label, type: 'text' });

/**
 * Net sales = invoiced net of line discounts and VAT, minus credit notes, by
 * document date. Both CTEs carry the dimensions every report groups by.
 * $1 from, $2 to, $3 rep ids (NULL = all visible), $4 rep, $5 team, $6 territory, $7 customer.
 */
const SALES_CTE = `
  inv AS (
    SELECT i.id, i.sales_rep_id, i.customer_id, i.invoice_date AS d, (i.subtotal - i.discount_total) AS net, i.discount_total, i.subtotal AS gross, i.grand_total
      FROM invoices i
     WHERE i.status <> 'VOID' AND i.status <> 'DRAFT' AND i.invoice_date BETWEEN $1 AND $2
  ),
  cn AS (
    SELECT c.id, o.sales_rep_id, c.customer_id, c.credit_date AS d, c.subtotal AS net
      FROM credit_notes c LEFT JOIN sales_orders o ON o.id = c.sales_order_id
     WHERE c.status = 'ISSUED' AND c.credit_date BETWEEN $1 AND $2
  ),
  terr AS (
    SELECT DISTINCT ON (customer_id) customer_id, territory_id FROM sales_customer_assignments
     WHERE assignment_type = 'PRIMARY' AND (valid_to IS NULL OR valid_to >= CURRENT_DATE) AND territory_id IS NOT NULL
     ORDER BY customer_id, valid_from DESC
  ),
  facts AS (
    SELECT 'INV' AS kind, inv.sales_rep_id, inv.customer_id, inv.net, inv.discount_total, inv.gross FROM inv
    UNION ALL
    SELECT 'CN', cn.sales_rep_id, cn.customer_id, -cn.net, 0, 0 FROM cn
  ),
  f AS (
    SELECT facts.*, r.team_id, terr.territory_id FROM facts
      LEFT JOIN sales_representatives r ON r.id = facts.sales_rep_id
      LEFT JOIN terr ON terr.customer_id = facts.customer_id
     WHERE ($3::uuid[] IS NULL OR facts.sales_rep_id = ANY($3::uuid[]))
       AND ($4::uuid IS NULL OR facts.sales_rep_id = $4)
       AND ($5::uuid IS NULL OR r.team_id = $5)
       AND ($6::uuid IS NULL OR terr.territory_id = $6)
       AND ($7::uuid IS NULL OR facts.customer_id = $7)
  )`;

const SALES_COLS = `
  count(*) FILTER (WHERE kind = 'INV') AS invoices,
  COALESCE(SUM(gross) FILTER (WHERE kind = 'INV'), 0)::numeric(18,2) AS gross_sales,
  COALESCE(SUM(discount_total), 0)::numeric(18,2) AS discounts,
  COALESCE(-SUM(net) FILTER (WHERE kind = 'CN'), 0)::numeric(18,2) AS returns,
  COALESCE(SUM(net), 0)::numeric(18,2) AS net_sales`;

const SALES_COLUMNS: ReportColumn[] = [num('invoices', 'Invoices'), money('gross_sales', 'Gross sales'), money('discounts', 'Discounts'), money('returns', 'Returns'), money('net_sales', 'Net sales')];
const SALES_SUM = ['invoices', 'gross_sales', 'discounts', 'returns', 'net_sales'];

const params = (f: ReportFilters, reps: string[] | null) => [f.from, f.to, reps, f.salesRepId ?? null, f.teamId ?? null, f.territoryId ?? null, f.customerId ?? null];

/** Rep-level filter for reports that don't use the sales CTE. Same parameter positions. */
const REP_FILTER = (alias: string) => `($3::uuid[] IS NULL OR ${alias}.sales_rep_id = ANY($3::uuid[]))
   AND ($4::uuid IS NULL OR ${alias}.sales_rep_id = $4)
   AND ($5::uuid IS NULL OR ${alias}.sales_rep_id IN (SELECT id FROM sales_representatives WHERE team_id = $5))`;

@Injectable()
export class ReportsService {
  constructor(
    private readonly ctx: SalesContextService,
    private readonly subs: SubscriptionService,
    private readonly targets: TargetsService,
  ) {}

  readonly defs: Record<string, Def> = {
    'sales-by-rep': {
      title: 'Sales by representative',
      modules: [MODULES.SALES_TEAM_BASIC],
      columns: [text('employee_code', 'Code'), text('rep_name', 'Representative'), text('team_name', 'Team'), ...SALES_COLUMNS],
      sum: SALES_SUM,
      run: (tx, f, reps) =>
        tx.query(
          `WITH ${SALES_CTE}
           SELECT r.employee_code, u.full_name AS rep_name, t.name AS team_name, ${SALES_COLS}
             FROM f JOIN sales_representatives r ON r.id = f.sales_rep_id JOIN users u ON u.id = r.user_id LEFT JOIN sales_teams t ON t.id = r.team_id
            GROUP BY r.id, r.employee_code, u.full_name, t.name ORDER BY net_sales DESC`,
          params(f, reps),
        ),
    },
    'sales-by-team': {
      title: 'Sales by team',
      modules: [MODULES.SALES_TEAM_BASIC, MODULES.SALES_ADVANCED_ANALYTICS],
      columns: [text('team_name', 'Team'), num('reps', 'Representatives'), ...SALES_COLUMNS],
      sum: SALES_SUM,
      run: (tx, f, reps) =>
        tx.query(
          `WITH ${SALES_CTE}
           SELECT COALESCE(t.name, '(No team)') AS team_name, count(DISTINCT f.sales_rep_id) AS reps, ${SALES_COLS}
             FROM f LEFT JOIN sales_teams t ON t.id = f.team_id
            GROUP BY t.id, t.name ORDER BY net_sales DESC`,
          params(f, reps),
        ),
    },
    'sales-by-territory': {
      title: 'Sales by territory',
      modules: [MODULES.SALES_TERRITORY_MANAGEMENT, MODULES.SALES_ADVANCED_ANALYTICS],
      columns: [text('territory_code', 'Code'), text('territory_name', 'Territory'), num('customers', 'Customers'), ...SALES_COLUMNS],
      sum: [...SALES_SUM, 'customers'],
      run: (tx, f, reps) =>
        tx.query(
          `WITH ${SALES_CTE}
           SELECT COALESCE(tr.code, '-') AS territory_code, COALESCE(tr.name, '(No territory)') AS territory_name,
                  count(DISTINCT f.customer_id) AS customers, ${SALES_COLS}
             FROM f LEFT JOIN sales_territories tr ON tr.id = f.territory_id
            GROUP BY tr.id, tr.code, tr.name ORDER BY net_sales DESC`,
          params(f, reps),
        ),
    },
    'sales-by-customer': {
      title: 'Sales by customer',
      modules: [MODULES.SALES_TEAM_BASIC],
      columns: [text('customer_code', 'Code'), text('customer_name', 'Customer'), ...SALES_COLUMNS],
      sum: SALES_SUM,
      run: (tx, f, reps) =>
        tx.query(
          `WITH ${SALES_CTE}
           SELECT c.code AS customer_code, c.name AS customer_name, ${SALES_COLS}
             FROM f JOIN customers c ON c.id = f.customer_id
            GROUP BY c.id, c.code, c.name ORDER BY net_sales DESC`,
          params(f, reps),
        ),
    },
    'sales-by-product': {
      title: 'Sales by product',
      modules: [MODULES.SALES_TEAM_BASIC, MODULES.SALES_ADVANCED_ANALYTICS],
      columns: [text('sku', 'SKU'), text('product_name', 'Product'), text('category_name', 'Category'), num('quantity', 'Quantity'), num('returned_qty', 'Returned'), money('net_sales', 'Net sales')],
      sum: ['quantity', 'returned_qty', 'net_sales'],
      run: (tx, f, reps) =>
        tx.query(
          `WITH lines AS (
             SELECT l.product_id, l.quantity, l.net_amount AS net, 0::numeric AS rq, i.sales_rep_id, i.customer_id
               FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
              WHERE i.status NOT IN ('VOID', 'DRAFT') AND i.invoice_date BETWEEN $1 AND $2
             UNION ALL
             SELECT l.product_id, 0, -l.net_amount, l.quantity, o.sales_rep_id, c.customer_id
               FROM credit_note_lines l JOIN credit_notes c ON c.id = l.credit_note_id LEFT JOIN sales_orders o ON o.id = c.sales_order_id
              WHERE c.status = 'ISSUED' AND c.credit_date BETWEEN $1 AND $2
           )
           SELECT p.sku, p.name AS product_name, pc.name AS category_name, SUM(lines.quantity) AS quantity, SUM(lines.rq) AS returned_qty,
                  SUM(lines.net)::numeric(18,2) AS net_sales
             FROM lines JOIN products p ON p.id = lines.product_id LEFT JOIN product_categories pc ON pc.id = p.category_id
            WHERE ${REP_FILTER('lines')} AND ($6::uuid IS NULL OR TRUE) AND ($7::uuid IS NULL OR lines.customer_id = $7)
            GROUP BY p.id, p.sku, p.name, pc.name ORDER BY net_sales DESC`,
          params(f, reps),
        ),
    },
    'order-conversion': {
      title: 'Order conversion rate',
      modules: [MODULES.SALES_ORDER_MANAGEMENT, MODULES.SALES_ADVANCED_ANALYTICS],
      columns: [
        text('rep_name', 'Representative'), num('visits_completed', 'Visits'), num('visits_with_order', 'Visits with order'), pct('visit_conversion', 'Visit → order %'),
        num('quotations', 'Quotations'), num('quotations_converted', 'Converted'), pct('quotation_conversion', 'Quote → order %'),
        num('orders_submitted', 'Orders submitted'), num('orders_approved', 'Approved'), num('orders_rejected', 'Rejected'), num('orders_cancelled', 'Cancelled'), pct('approval_rate', 'Approval %'),
      ],
      sum: ['visits_completed', 'visits_with_order', 'quotations', 'quotations_converted', 'orders_submitted', 'orders_approved', 'orders_rejected', 'orders_cancelled'],
      run: (tx, f, reps) =>
        tx.query(
          `WITH reps AS (
             SELECT r.id, u.full_name FROM sales_representatives r JOIN users u ON u.id = r.user_id
              WHERE ${REP_FILTER('r').replace(/r\.sales_rep_id/g, 'r.id')}
           ),
           v AS (SELECT sales_rep_id, count(*) FILTER (WHERE status = 'COMPLETED') AS done, count(*) FILTER (WHERE outcome = 'ORDER_TAKEN') AS won
                   FROM sales_visits WHERE scheduled_start::date BETWEEN $1 AND $2 GROUP BY sales_rep_id),
           q AS (SELECT sales_rep_id, count(*) AS n, count(*) FILTER (WHERE status = 'CONVERTED') AS conv
                   FROM sales_quotations WHERE quotation_date BETWEEN $1 AND $2 GROUP BY sales_rep_id),
           o AS (SELECT sales_rep_id, count(*) FILTER (WHERE submitted_at IS NOT NULL) AS sub,
                        count(*) FILTER (WHERE approved_at IS NOT NULL) AS appr,
                        count(*) FILTER (WHERE status = 'REJECTED') AS rej,
                        count(*) FILTER (WHERE status = 'CANCELLED' AND submitted_at IS NOT NULL) AS canc
                   FROM sales_orders WHERE order_date BETWEEN $1 AND $2 AND ($7::uuid IS NULL OR customer_id = $7) GROUP BY sales_rep_id)
           SELECT reps.full_name AS rep_name,
                  COALESCE(v.done, 0) AS visits_completed, COALESCE(v.won, 0) AS visits_with_order,
                  CASE WHEN COALESCE(v.done, 0) = 0 THEN NULL ELSE round(100.0 * v.won / v.done, 1) END AS visit_conversion,
                  COALESCE(q.n, 0) AS quotations, COALESCE(q.conv, 0) AS quotations_converted,
                  CASE WHEN COALESCE(q.n, 0) = 0 THEN NULL ELSE round(100.0 * q.conv / q.n, 1) END AS quotation_conversion,
                  COALESCE(o.sub, 0) AS orders_submitted, COALESCE(o.appr, 0) AS orders_approved, COALESCE(o.rej, 0) AS orders_rejected, COALESCE(o.canc, 0) AS orders_cancelled,
                  CASE WHEN COALESCE(o.sub, 0) = 0 THEN NULL ELSE round(100.0 * o.appr / o.sub, 1) END AS approval_rate
             FROM reps LEFT JOIN v ON v.sales_rep_id = reps.id LEFT JOIN q ON q.sales_rep_id = reps.id LEFT JOIN o ON o.sales_rep_id = reps.id
            WHERE ($6::uuid IS NULL OR TRUE)
            ORDER BY reps.full_name`,
          params(f, reps),
        ),
    },
    'target-achievement': {
      title: 'Target achievement',
      modules: [MODULES.SALES_TEAM_BASIC],
      columns: [text('scope', 'Scope'), text('target_for', 'For'), text('metric', 'Metric'), text('period', 'Period'), num('target_value', 'Target'), num('actual', 'Actual'), pct('achievement_percent', 'Achieved %'), pct('period_elapsed_percent', 'Period elapsed %')],
      run: async (tx, f, reps) => {
        const rows = await tx.query(
          `SELECT t.* , COALESCE(u.full_name, tm.name, tr.name) AS target_for FROM sales_targets t
             LEFT JOIN sales_representatives r ON r.id = t.sales_rep_id LEFT JOIN users u ON u.id = r.user_id
             LEFT JOIN sales_teams tm ON tm.id = t.team_id LEFT JOIN sales_territories tr ON tr.id = t.territory_id
            WHERE t.period_start <= $2 AND t.period_end >= $1
              AND ($3::uuid[] IS NULL OR t.sales_rep_id = ANY($3::uuid[]) OR t.team_id IN (SELECT team_id FROM sales_representatives WHERE id = ANY($3::uuid[])))
              AND ($4::uuid IS NULL OR t.sales_rep_id = $4) AND ($5::uuid IS NULL OR t.team_id = $5 OR r.team_id = $5)
              AND ($6::uuid IS NULL OR t.territory_id = $6) AND ($7::uuid IS NULL OR TRUE)
            ORDER BY t.period_start, t.scope, target_for, t.metric`,
          params(f, reps),
        );
        const out = [];
        for (const t of rows) {
          const p = await this.targets.progress(tx, t);
          out.push({
            scope: t.scope, target_for: t.target_for, metric: t.metric, period: `${t.period_start} – ${t.period_end}`,
            target_value: t.target_value, actual: p.actual, achievement_percent: p.achievementPercent, period_elapsed_percent: p.periodElapsedPercent,
          });
        }
        return out;
      },
    },
    'discount-analysis': {
      title: 'Discount analysis',
      modules: [MODULES.SALES_ORDER_MANAGEMENT, MODULES.SALES_ADVANCED_ANALYTICS],
      columns: [
        text('rep_name', 'Representative'), num('orders', 'Orders'), money('gross_value', 'Gross value'), money('discount_amount', 'Discount'), pct('avg_discount_percent', 'Avg discount %'),
        pct('max_discount_percent', 'Max discount %'), num('discount_approvals', 'Needed approval'), num('discount_approved', 'Approved'), num('discount_rejected', 'Rejected'),
      ],
      sum: ['orders', 'gross_value', 'discount_amount', 'discount_approvals', 'discount_approved', 'discount_rejected'],
      run: (tx, f, reps) =>
        tx.query(
          `WITH o AS (
             SELECT o.id, o.sales_rep_id, o.max_discount_percent FROM sales_orders o
              WHERE o.submitted_at IS NOT NULL AND o.order_date BETWEEN $1 AND $2 AND ${REP_FILTER('o')}
                AND ($7::uuid IS NULL OR o.customer_id = $7) AND ($6::uuid IS NULL OR TRUE)
           ),
           l AS (SELECT l.order_id, SUM(l.quantity * l.unit_price) AS gross, SUM(l.discount_amount) AS disc FROM sales_order_lines l WHERE l.order_id IN (SELECT id FROM o) GROUP BY l.order_id),
           a AS (SELECT order_id, bool_or(true) AS needed, bool_or(status = 'APPROVED') AS ok, bool_or(status = 'REJECTED') AS no
                   FROM sales_order_approvals WHERE reason = 'DISCOUNT' AND order_id IN (SELECT id FROM o) GROUP BY order_id)
           SELECT u.full_name AS rep_name, count(*) AS orders, COALESCE(SUM(l.gross), 0)::numeric(18,2) AS gross_value, COALESCE(SUM(l.disc), 0)::numeric(18,2) AS discount_amount,
                  CASE WHEN COALESCE(SUM(l.gross), 0) = 0 THEN 0 ELSE round(100 * SUM(l.disc) / SUM(l.gross), 2) END AS avg_discount_percent,
                  MAX(o.max_discount_percent) AS max_discount_percent,
                  count(*) FILTER (WHERE a.needed) AS discount_approvals, count(*) FILTER (WHERE a.ok) AS discount_approved, count(*) FILTER (WHERE a.no) AS discount_rejected
             FROM o JOIN sales_representatives r ON r.id = o.sales_rep_id JOIN users u ON u.id = r.user_id
             LEFT JOIN l ON l.order_id = o.id LEFT JOIN a ON a.order_id = o.id
            GROUP BY r.id, u.full_name ORDER BY discount_amount DESC`,
          params(f, reps),
        ),
    },
    'customer-balances': {
      title: 'Outstanding customer balances',
      modules: [MODULES.SALES_TEAM_BASIC, MODULES.ACCOUNTING],
      columns: [
        text('customer_code', 'Code'), text('customer_name', 'Customer'), text('rep_name', 'Representative'), money('credit_limit', 'Credit limit'),
        money('current', 'Not due'), money('d1_30', '1–30 days'), money('d31_60', '31–60'), money('d61_90', '61–90'), money('d90_plus', '90+'), money('outstanding', 'Outstanding'),
      ],
      sum: ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus', 'outstanding'],
      run: (tx, f, reps) =>
        tx.query(
          `WITH asg AS (
             SELECT DISTINCT ON (customer_id) customer_id, sales_rep_id FROM sales_customer_assignments
              WHERE assignment_type = 'PRIMARY' AND (valid_to IS NULL OR valid_to >= CURRENT_DATE) ORDER BY customer_id, valid_from DESC
           ),
           open AS (
             SELECT i.customer_id, (i.grand_total - i.amount_paid - i.amount_credited) AS bal, ($2::date - i.due_date) AS late
               FROM invoices i WHERE i.status IN ('ISSUED', 'PARTIALLY_PAID') AND i.invoice_date <= $2
           )
           SELECT c.code AS customer_code, c.name AS customer_name, u.full_name AS rep_name, c.credit_limit,
                  COALESCE(SUM(bal) FILTER (WHERE late <= 0), 0)::numeric(18,2) AS current,
                  COALESCE(SUM(bal) FILTER (WHERE late BETWEEN 1 AND 30), 0)::numeric(18,2) AS d1_30,
                  COALESCE(SUM(bal) FILTER (WHERE late BETWEEN 31 AND 60), 0)::numeric(18,2) AS d31_60,
                  COALESCE(SUM(bal) FILTER (WHERE late BETWEEN 61 AND 90), 0)::numeric(18,2) AS d61_90,
                  COALESCE(SUM(bal) FILTER (WHERE late > 90), 0)::numeric(18,2) AS d90_plus,
                  COALESCE(SUM(bal), 0)::numeric(18,2) AS outstanding
             FROM open JOIN customers c ON c.id = open.customer_id
             LEFT JOIN asg ON asg.customer_id = c.id LEFT JOIN sales_representatives r ON r.id = asg.sales_rep_id LEFT JOIN users u ON u.id = r.user_id
            WHERE ${REP_FILTER('asg')} AND ($7::uuid IS NULL OR c.id = $7) AND ($1::date IS NOT NULL)
              AND ($6::uuid IS NULL OR c.id IN (SELECT customer_id FROM sales_customer_assignments WHERE territory_id = $6 AND valid_to IS NULL))
            GROUP BY c.id, c.code, c.name, u.full_name, c.credit_limit
           HAVING SUM(bal) <> 0
            ORDER BY outstanding DESC`,
          params(f, reps),
        ),
    },
    commissions: {
      title: 'Commission report',
      modules: [MODULES.SALES_COMMISSION_MANAGEMENT],
      columns: [
        text('rep_name', 'Representative'), text('period', 'Month'), money('base_amount', 'Commission base'), money('estimated', 'Estimated'), money('approved', 'Approved'),
        money('sent_to_payroll', 'Sent to payroll'), money('paid', 'Paid'), money('clawbacks', 'Clawbacks'), money('total', 'Total'),
      ],
      sum: ['base_amount', 'estimated', 'approved', 'sent_to_payroll', 'paid', 'clawbacks', 'total'],
      run: (tx, f, reps) =>
        tx.query(
          `SELECT u.full_name AS rep_name, to_char(e.period_month, 'YYYY-MM') AS period,
                  SUM(e.base_amount) FILTER (WHERE e.source_type IN ('INVOICE', 'CREDIT_NOTE', 'COLLECTION'))::numeric(18,2) AS base_amount,
                  COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'ESTIMATED'), 0)::numeric(18,2) AS estimated,
                  COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'APPROVED'), 0)::numeric(18,2) AS approved,
                  COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'SENT_TO_PAYROLL'), 0)::numeric(18,2) AS sent_to_payroll,
                  COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'PAID'), 0)::numeric(18,2) AS paid,
                  COALESCE(SUM(e.amount) FILTER (WHERE e.source_type IN ('OVERDUE_CLAWBACK', 'CLAWBACK_REINSTATED')), 0)::numeric(18,2) AS clawbacks,
                  COALESCE(SUM(e.amount) FILTER (WHERE e.status <> 'REVERSED'), 0)::numeric(18,2) AS total
             FROM sales_commission_entries e JOIN sales_representatives r ON r.id = e.sales_rep_id JOIN users u ON u.id = r.user_id
            WHERE e.period_month BETWEEN date_trunc('month', $1::date) AND $2 AND ${REP_FILTER('e')}
              AND ($6::uuid IS NULL OR TRUE) AND ($7::uuid IS NULL OR TRUE)
            GROUP BY u.full_name, e.period_month ORDER BY e.period_month, u.full_name`,
          params(f, reps),
        ),
    },
    visits: {
      title: 'Customer visit report',
      modules: [MODULES.SALES_TEAM_BASIC],
      columns: [
        text('rep_name', 'Representative'), num('planned', 'Scheduled'), num('completed', 'Completed'), num('missed', 'Missed'), num('cancelled', 'Cancelled'),
        pct('completion_rate', 'Completion %'), num('orders_taken', 'Orders taken'), num('with_location', 'With location'), num('avg_minutes', 'Avg minutes'), num('customers_visited', 'Customers'),
      ],
      sum: ['planned', 'completed', 'missed', 'cancelled', 'orders_taken', 'with_location', 'customers_visited'],
      run: (tx, f, reps) =>
        tx.query(
          `SELECT u.full_name AS rep_name, count(*) AS planned,
                  count(*) FILTER (WHERE v.status = 'COMPLETED') AS completed, count(*) FILTER (WHERE v.status = 'MISSED') AS missed,
                  count(*) FILTER (WHERE v.status = 'CANCELLED') AS cancelled,
                  round(100.0 * count(*) FILTER (WHERE v.status = 'COMPLETED') / NULLIF(count(*) FILTER (WHERE v.status <> 'CANCELLED'), 0), 1) AS completion_rate,
                  count(*) FILTER (WHERE v.outcome = 'ORDER_TAKEN') AS orders_taken,
                  count(*) FILTER (WHERE v.check_in_latitude IS NOT NULL) AS with_location,
                  round(avg(EXTRACT(EPOCH FROM (v.checked_out_at - v.checked_in_at)) / 60) FILTER (WHERE v.checked_out_at IS NOT NULL)) AS avg_minutes,
                  count(DISTINCT v.customer_id) FILTER (WHERE v.status = 'COMPLETED') AS customers_visited
             FROM sales_visits v JOIN sales_representatives r ON r.id = v.sales_rep_id JOIN users u ON u.id = r.user_id
            WHERE v.scheduled_start::date BETWEEN $1 AND $2 AND ${REP_FILTER('v')} AND ($7::uuid IS NULL OR v.customer_id = $7) AND ($6::uuid IS NULL OR TRUE)
            GROUP BY r.id, u.full_name ORDER BY u.full_name`,
          params(f, reps),
        ),
    },
  };

  catalog(user: TenantUser, modules: Set<string>) {
    return Object.entries(this.defs).map(([code, d]) => ({
      code, title: d.title, available: d.modules.every((m) => modules.has(m)), missingModules: d.modules.filter((m) => !modules.has(m)),
    }));
  }

  async run(tx: Tx, user: TenantUser, code: string, f: ReportFilters): Promise<Report> {
    const def = this.defs[code];
    if (!def) throw new DomainError('NOT_FOUND', 'Unknown report', 404);
    const ent = await this.subs.entitlementsTx(tx);
    const missing = def.modules.filter((m) => !ent.modules.has(m));
    if (missing.length) throw new DomainError('MODULE_NOT_SUBSCRIBED', `This report needs: ${missing.join(', ')}`, 402, { modules: missing });
    if (f.to < f.from) throw new DomainError('INVALID_RANGE', '"to" must not be before "from"', 422);
    const reps = await this.visibleReps(tx, user);
    const rows = await def.run(tx, f, reps);
    const currency = (await tx.one<{ base_currency: string }>('SELECT base_currency FROM tenants WHERE id = current_tenant_id()')).base_currency;
    let totals: Record<string, unknown> | null = null;
    if (def.sum?.length) {
      totals = {};
      for (const k of def.sum) {
        const t = rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
        const col = def.columns.find((c) => c.key === k);
        totals[k] = col?.type === 'money' ? t.toFixed(2) : String(Math.round(t * 10000) / 10000);
      }
    }
    return { code, title: def.title, filters: f, generatedAt: new Date().toISOString(), currency, columns: def.columns, rows, totals };
  }

  /** Rep ids the user may report on; null means everyone in the company. */
  async visibleReps(tx: Tx, user: TenantUser): Promise<string[] | null> {
    if (has(user, P.SALES_ORDERS_VIEW_ALL)) return null;
    const teams = has(user, P.SALES_ORDERS_VIEW_TEAM) ? await this.ctx.managedTeamIds(tx, user.userId) : [];
    const rep = await this.ctx.repForUser(tx, user.userId);
    const ids = teams.length ? (await tx.query<{ id: string }>('SELECT id FROM sales_representatives WHERE team_id = ANY($1::uuid[])', [teams])).map((r) => r.id) : [];
    if (rep) ids.push(rep.id);
    if (!ids.length) throw forbidden('You have no sales team to report on');
    return ids;
  }

  // ---------------------------------------------------------------------------
  // Dashboards
  // ---------------------------------------------------------------------------

  /** The mobile sales dashboard: everything is scoped to what the user may see. */
  async dashboard(tx: Tx, user: TenantUser) {
    const reps = await this.visibleReps(tx, user).catch((e) => {
      if (e instanceof DomainError) return [] as string[];
      throw e;
    });
    const today = tx.today();
    const month = `${today.slice(0, 7)}-01`;
    const ent = await this.subs.entitlementsTx(tx);
    const k = await tx.one<Record<string, string>>(
      `SELECT
         COALESCE(SUM(grand_total) FILTER (WHERE order_date = $2 AND status NOT IN ('DRAFT', 'CANCELLED', 'REJECTED')), 0)::numeric(18,2) AS today_sales,
         COALESCE(SUM(grand_total) FILTER (WHERE order_date >= $3 AND status NOT IN ('DRAFT', 'CANCELLED', 'REJECTED')), 0)::numeric(18,2) AS month_sales,
         count(*) FILTER (WHERE submitted_at >= $3) AS orders_submitted,
         count(*) FILTER (WHERE status = 'PENDING_APPROVAL') AS pending_approval,
         count(*) FILTER (WHERE status = 'DRAFT') AS drafts,
         count(*) FILTER (WHERE status IN ('DELIVERED', 'INVOICED', 'CLOSED') AND order_date >= $3) AS delivered_orders
       FROM sales_orders WHERE ($1::uuid[] IS NULL OR sales_rep_id = ANY($1::uuid[]))`,
      [reps, today, month],
    );
    const customers = await tx.one<{ n: string; outstanding: string; overdue: string }>(
      `SELECT count(DISTINCT a.customer_id) AS n, COALESCE(SUM(b.outstanding), 0)::numeric(18,2) AS outstanding, COALESCE(SUM(b.overdue), 0)::numeric(18,2) AS overdue
         FROM (SELECT DISTINCT customer_id FROM sales_customer_assignments
                WHERE (valid_to IS NULL OR valid_to >= CURRENT_DATE) AND ($1::uuid[] IS NULL OR sales_rep_id = ANY($1::uuid[]))) a
         LEFT JOIN customer_balances b ON b.customer_id = a.customer_id`,
      [reps],
    );
    const settings = await this.ctx.settings(tx);
    const showBalances = has(user, P.SALES_CUSTOMERS_VIEW_BALANCE) || settings.showBalancesToReps;
    const targets = has(user, P.SALES_TARGETS_VIEW) ? await this.targets.list(tx, user, { on: today, periodType: 'MONTH' }) : [];
    let commissionEstimate: string | null = null;
    if (ent.modules.has(MODULES.SALES_COMMISSION_MANAGEMENT) && has(user, P.SALES_COMMISSIONS_VIEW)) {
      const c = await tx.one<{ s: string }>(
        `SELECT COALESCE(SUM(amount), 0)::numeric(18,2) AS s FROM sales_commission_entries
          WHERE period_month = $2 AND status <> 'REVERSED' AND ($1::uuid[] IS NULL OR sales_rep_id = ANY($1::uuid[]))`,
        [reps, month],
      );
      commissionEstimate = c.s;
    }
    const recent = await tx.query(
      `SELECT h.created_at AS at, 'ORDER' AS kind, o.id AS entity_id, o.number AS reference, c.name AS customer_name, h.to_status AS status, h.comment AS note
         FROM sales_order_status_history h JOIN sales_orders o ON o.id = h.order_id JOIN customers c ON c.id = o.customer_id
        WHERE ($1::uuid[] IS NULL OR o.sales_rep_id = ANY($1::uuid[]))
       UNION ALL
       SELECT COALESCE(v.checked_out_at, v.checked_in_at, v.created_at), 'VISIT', v.id, NULL, c.name, v.status, v.outcome
         FROM sales_visits v JOIN customers c ON c.id = v.customer_id
        WHERE ($1::uuid[] IS NULL OR v.sales_rep_id = ANY($1::uuid[]))
       UNION ALL
       SELECT s.created_at, 'COLLECTION', s.id, s.number, c.name, s.status, s.amount::text
         FROM sales_collection_submissions s JOIN customers c ON c.id = s.customer_id
        WHERE ($1::uuid[] IS NULL OR s.sales_rep_id = ANY($1::uuid[]))
       ORDER BY 1 DESC LIMIT 15`,
      [reps],
    );
    const currency = (await tx.one<{ base_currency: string }>('SELECT base_currency FROM tenants WHERE id = current_tenant_id()')).base_currency;
    return {
      asOf: new Date().toISOString(),
      currency,
      scope: reps === null ? 'COMPANY' : reps.length > 1 ? 'TEAM' : 'OWN',
      todaySales: k.today_sales,
      monthSales: k.month_sales,
      ordersSubmitted: Number(k.orders_submitted),
      ordersPendingApproval: Number(k.pending_approval),
      draftOrders: Number(k.drafts),
      deliveredOrders: Number(k.delivered_orders),
      assignedCustomers: Number(customers.n),
      outstandingBalances: showBalances ? customers.outstanding : null,
      overdueBalances: showBalances ? customers.overdue : null,
      monthlyTargets: targets.map((t) => ({ id: t.id, metric: t.metric, target: t.target_value, actual: t.actual, achievementPercent: t.achievementPercent, periodElapsedPercent: t.periodElapsedPercent, for: t.rep_name ?? t.team_name ?? t.territory_name })),
      commissionEstimate,
      recentActivities: recent,
    };
  }

  /** Supervisor / manager view: one row per rep with the numbers that matter for coaching. */
  async teamPerformance(tx: Tx, user: TenantUser, f: { from: string; to: string; teamId?: string }) {
    if (!has(user, P.SALES_ORDERS_VIEW_TEAM) && !has(user, P.SALES_ORDERS_VIEW_ALL)) throw forbidden('Only supervisors and managers can see team performance');
    const reps = await this.visibleReps(tx, user);
    const rows = await tx.query(
      `WITH rr AS (
         SELECT r.id, r.employee_code, u.full_name, t.name AS team_name, r.team_id FROM sales_representatives r JOIN users u ON u.id = r.user_id
           LEFT JOIN sales_teams t ON t.id = r.team_id
          WHERE r.status = 'ACTIVE' AND ($3::uuid[] IS NULL OR r.id = ANY($3::uuid[])) AND ($4::uuid IS NULL OR r.team_id = $4)
       ),
       inv AS (SELECT sales_rep_id, SUM(subtotal - discount_total) AS net FROM invoices WHERE status NOT IN ('VOID', 'DRAFT') AND invoice_date BETWEEN $1 AND $2 GROUP BY sales_rep_id),
       cn AS (SELECT o.sales_rep_id, SUM(c.subtotal) AS net FROM credit_notes c JOIN sales_orders o ON o.id = c.sales_order_id WHERE c.status = 'ISSUED' AND c.credit_date BETWEEN $1 AND $2 GROUP BY o.sales_rep_id),
       ord AS (SELECT sales_rep_id, count(*) FILTER (WHERE submitted_at IS NOT NULL) AS submitted, count(*) FILTER (WHERE approved_at IS NOT NULL) AS approved,
                      count(*) FILTER (WHERE status = 'PENDING_APPROVAL') AS pending, avg(max_discount_percent) FILTER (WHERE submitted_at IS NOT NULL) AS avg_disc
                 FROM sales_orders WHERE order_date BETWEEN $1 AND $2 GROUP BY sales_rep_id),
       vis AS (SELECT sales_rep_id, count(*) FILTER (WHERE status = 'COMPLETED') AS done, count(*) FILTER (WHERE status = 'MISSED') AS missed
                 FROM sales_visits WHERE scheduled_start::date BETWEEN $1 AND $2 GROUP BY sales_rep_id),
       col AS (SELECT sales_rep_id, SUM(amount) FILTER (WHERE status = 'VERIFIED') AS verified, SUM(amount) FILTER (WHERE status = 'PENDING_VERIFICATION') AS pending
                 FROM sales_collection_submissions WHERE created_at::date BETWEEN $1 AND $2 GROUP BY sales_rep_id),
       tgt AS (SELECT DISTINCT ON (sales_rep_id) sales_rep_id, id, target_value FROM sales_targets
                WHERE scope = 'REP' AND metric = 'NET_SALES' AND period_start <= $2 AND period_end >= $1 ORDER BY sales_rep_id, period_start DESC)
       SELECT rr.id AS sales_rep_id, rr.employee_code, rr.full_name AS rep_name, rr.team_name,
              (COALESCE(inv.net, 0) - COALESCE(cn.net, 0))::numeric(18,2) AS net_sales,
              tgt.target_value AS net_sales_target,
              CASE WHEN tgt.target_value > 0 THEN round(100 * (COALESCE(inv.net, 0) - COALESCE(cn.net, 0)) / tgt.target_value, 1) END AS target_achievement_percent,
              COALESCE(ord.submitted, 0) AS orders_submitted, COALESCE(ord.approved, 0) AS orders_approved, COALESCE(ord.pending, 0) AS orders_pending,
              round(COALESCE(ord.avg_disc, 0), 2) AS avg_discount_percent,
              COALESCE(vis.done, 0) AS visits_completed, COALESCE(vis.missed, 0) AS visits_missed,
              COALESCE(col.verified, 0)::numeric(18,2) AS collections_verified, COALESCE(col.pending, 0)::numeric(18,2) AS collections_pending
         FROM rr LEFT JOIN inv ON inv.sales_rep_id = rr.id LEFT JOIN cn ON cn.sales_rep_id = rr.id LEFT JOIN ord ON ord.sales_rep_id = rr.id
         LEFT JOIN vis ON vis.sales_rep_id = rr.id LEFT JOIN col ON col.sales_rep_id = rr.id LEFT JOIN tgt ON tgt.sales_rep_id = rr.id
        ORDER BY net_sales DESC, rr.full_name`,
      [f.from, f.to, reps, f.teamId ?? null],
    );
    const total = (k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
    return {
      from: f.from, to: f.to, reps: rows,
      totals: {
        netSales: total('net_sales').toFixed(2), ordersSubmitted: total('orders_submitted'), ordersPending: total('orders_pending'),
        visitsCompleted: total('visits_completed'), collectionsVerified: total('collections_verified').toFixed(2),
      },
    };
  }

  /**
   * Territory map: each territory with its customers' delivery points (only
   * addresses that have coordinates) and period sales. Visit check-in points
   * are included only where the rep consented to location capture.
   */
  async territoryMap(tx: Tx, user: TenantUser, f: { from: string; to: string; includeVisits: boolean }) {
    const reps = await this.visibleReps(tx, user);
    const territories = await tx.query(
      `SELECT t.id, t.code, t.name, t.territory_type, t.parent_id,
              (SELECT json_agg(json_build_object('salesRepId', a.sales_rep_id, 'name', u.full_name, 'role', a.role))
                 FROM sales_territory_assignments a JOIN sales_representatives r ON r.id = a.sales_rep_id JOIN users u ON u.id = r.user_id
                WHERE a.territory_id = t.id AND a.valid_from <= CURRENT_DATE AND (a.valid_to IS NULL OR a.valid_to >= CURRENT_DATE)) AS representatives
         FROM sales_territories t WHERE t.is_active ORDER BY t.code`,
    );
    const points = await tx.query(
      `WITH asg AS (
         SELECT DISTINCT ON (customer_id) customer_id, sales_rep_id, territory_id FROM sales_customer_assignments
          WHERE assignment_type = 'PRIMARY' AND (valid_to IS NULL OR valid_to >= CURRENT_DATE) ORDER BY customer_id, valid_from DESC
       ),
       s AS (SELECT customer_id, SUM(subtotal - discount_total) AS net FROM invoices WHERE status NOT IN ('VOID', 'DRAFT') AND invoice_date BETWEEN $1 AND $2 GROUP BY customer_id)
       SELECT DISTINCT ON (c.id) c.id AS customer_id, c.code, c.name, a.latitude, a.longitude, asg.territory_id, asg.sales_rep_id,
              COALESCE(s.net, 0)::numeric(18,2) AS net_sales, COALESCE(b.outstanding, 0)::numeric(18,2) AS outstanding
         FROM customers c JOIN customer_addresses a ON a.customer_id = c.id AND a.address_type = 'DELIVERY' AND a.latitude IS NOT NULL
         LEFT JOIN asg ON asg.customer_id = c.id LEFT JOIN s ON s.customer_id = c.id LEFT JOIN customer_balances b ON b.customer_id = c.id
        WHERE c.status = 'ACTIVE' AND ($3::uuid[] IS NULL OR asg.sales_rep_id = ANY($3::uuid[]))
        ORDER BY c.id, a.is_default DESC`,
      [f.from, f.to, reps],
    );
    const byTerritory = new Map<string, { customers: number; netSales: number }>();
    for (const p of points) {
      const key = p.territory_id ?? 'none';
      const t = byTerritory.get(key) ?? { customers: 0, netSales: 0 };
      t.customers += 1;
      t.netSales += Number(p.net_sales);
      byTerritory.set(key, t);
    }
    const visits = f.includeVisits
      ? await tx.query(
          `SELECT v.id, v.sales_rep_id, v.customer_id, v.check_in_latitude AS latitude, v.check_in_longitude AS longitude, v.checked_in_at, v.status
             FROM sales_visits v WHERE v.location_consent AND v.check_in_latitude IS NOT NULL AND v.checked_in_at::date BETWEEN $1 AND $2
              AND ($3::uuid[] IS NULL OR v.sales_rep_id = ANY($3::uuid[]))`,
          [f.from, f.to, reps],
        )
      : [];
    return {
      from: f.from, to: f.to,
      territories: territories.map((t) => ({ ...t, customers: byTerritory.get(t.id)?.customers ?? 0, netSales: (byTerritory.get(t.id)?.netSales ?? 0).toFixed(2) })),
      customers: points,
      visits,
    };
  }
}
