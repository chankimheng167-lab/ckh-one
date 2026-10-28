import { Injectable } from '@nestjs/common';
import { Decimal, P, periodBounds } from '@ckh/shared';
import { has, TenantUser } from '../../common/auth-context';
import { AuditService } from '../../common/audit.service';
import { DomainError, forbidden, notFound } from '../../common/errors';
import type { Tx } from '../../db/database.service';
import { SalesContextService } from '../sales-context.service';

export type TargetMetric = 'NET_SALES' | 'COLLECTIONS' | 'ORDER_COUNT' | 'QUANTITY' | 'NEW_CUSTOMERS' | 'VISITS';

export interface TargetInput {
  scope: 'REP' | 'TEAM' | 'TERRITORY';
  salesRepId?: string;
  teamId?: string;
  territoryId?: string;
  periodType: 'MONTH' | 'QUARTER' | 'YEAR';
  periodStart: string;
  metric: TargetMetric;
  productId?: string;
  categoryId?: string;
  targetValue: string;
}

export interface TargetRow {
  id: string;
  scope: 'REP' | 'TEAM' | 'TERRITORY';
  sales_rep_id: string | null;
  team_id: string | null;
  territory_id: string | null;
  period_type: string;
  period_start: string;
  period_end: string;
  metric: TargetMetric;
  product_id: string | null;
  category_id: string | null;
  target_value: string;
  currency: string | null;
}

/**
 * Sales targets and achievement. Actuals come from posted documents only:
 * net sales from invoices less credit notes, collections from verified
 * receipts, orders from submitted (not cancelled/rejected) orders.
 */
@Injectable()
export class TargetsService {
  constructor(
    private readonly ctx: SalesContextService,
    private readonly audit: AuditService,
  ) {}

  async create(tx: Tx, user: TenantUser, i: TargetInput) {
    const { start, end } = periodBounds(i.periodType, i.periodStart);
    if (i.scope === 'REP' && !i.salesRepId) throw new DomainError('TARGET_SCOPE', 'salesRepId is required for a rep target', 422);
    if (i.scope === 'TEAM' && !i.teamId) throw new DomainError('TARGET_SCOPE', 'teamId is required for a team target', 422);
    if (i.scope === 'TERRITORY' && !i.territoryId) throw new DomainError('TARGET_SCOPE', 'territoryId is required for a territory target', 422);
    const currency = ['NET_SALES', 'COLLECTIONS'].includes(i.metric)
      ? (await tx.one<{ base_currency: string }>('SELECT base_currency FROM tenants WHERE id = current_tenant_id()')).base_currency
      : null;
    const row = await tx.one(
      `INSERT INTO sales_targets (tenant_id, scope, sales_rep_id, team_id, territory_id, period_type, period_start, period_end,
          metric, product_id, category_id, target_value, currency, created_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (tenant_id, scope, COALESCE(sales_rep_id, team_id, territory_id), period_type, period_start, metric,
                    COALESCE(product_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid))
       DO UPDATE SET target_value = EXCLUDED.target_value
       RETURNING *`,
      [i.scope, i.scope === 'REP' ? i.salesRepId : null, i.scope === 'TEAM' ? i.teamId : null, i.scope === 'TERRITORY' ? i.territoryId : null,
        i.periodType, start, end, i.metric, i.productId ?? null, i.categoryId ?? null, i.targetValue, currency, user.userId],
    );
    await this.audit.record(tx, { action: 'SALES_TARGET_SET', entityType: 'sales_target', entityId: row.id, after: row });
    return { ...row, ...(await this.progress(tx, row)) };
  }

  async remove(tx: Tx, id: string) {
    const r = await tx.maybeOne('DELETE FROM sales_targets WHERE id = $1 RETURNING id', [id]);
    if (!r) throw notFound('Target');
    await this.audit.record(tx, { action: 'SALES_TARGET_DELETED', entityType: 'sales_target', entityId: id });
    return { deleted: true };
  }

  /** Targets visible to the user, with achievement. Reps see their own; supervisors their team; managers all. */
  async list(tx: Tx, user: TenantUser, q: { on?: string; salesRepId?: string; scope?: string; periodType?: string }) {
    const on = q.on ?? tx.today();
    const all = has(user, P.SALES_TARGETS_MANAGE) || has(user, P.SALES_ORDERS_VIEW_ALL);
    const rep = await this.ctx.repForUser(tx, user.userId);
    const teams = has(user, P.SALES_ORDERS_VIEW_TEAM) ? await this.ctx.managedTeamIds(tx, user.userId) : [];
    const ownTeam = rep?.team_id ? [rep.team_id] : [];
    const rows = await tx.query<TargetRow & { rep_name: string | null; team_name: string | null; territory_name: string | null }>(
      `SELECT t.*, u.full_name AS rep_name, tm.name AS team_name, tr.name AS territory_name
         FROM sales_targets t
         LEFT JOIN sales_representatives r ON r.id = t.sales_rep_id LEFT JOIN users u ON u.id = r.user_id
         LEFT JOIN sales_teams tm ON tm.id = t.team_id LEFT JOIN sales_territories tr ON tr.id = t.territory_id
        WHERE $1::date BETWEEN t.period_start AND t.period_end
          AND ($2::uuid IS NULL OR t.sales_rep_id = $2)
          AND ($3::text IS NULL OR t.scope = $3)
          AND ($4::text IS NULL OR t.period_type = $4)
          AND ($5::boolean
               OR t.sales_rep_id = $6
               OR t.team_id = ANY($7::uuid[])
               OR t.team_id = ANY($8::uuid[])
               OR t.sales_rep_id IN (SELECT id FROM sales_representatives WHERE team_id = ANY($7::uuid[])))
        ORDER BY t.scope, t.period_type, t.metric`,
      // Managed teams expose members' personal targets; a rep's own team only exposes the team target.
      [on, q.salesRepId ?? null, q.scope ?? null, q.periodType ?? null, all, rep?.id ?? null, teams, ownTeam],
    );
    const out = [];
    for (const r of rows) out.push({ ...r, ...(await this.progress(tx, r)) });
    return out;
  }

  async progress(tx: Tx, t: TargetRow) {
    const actual = await this.actual(tx, t);
    const today = tx.today();
    const totalDays = daysBetween(t.period_start, t.period_end) + 1;
    const elapsed = Math.min(totalDays, Math.max(0, daysBetween(t.period_start, today) + 1));
    const achievement = new Decimal(actual).div(t.target_value).mul(100);
    return {
      actual,
      achievementPercent: achievement.toDecimalPlaces(1).toString(),
      remaining: Decimal.max(0, new Decimal(t.target_value).minus(actual)).toString(),
      periodElapsedPercent: new Decimal(elapsed).div(totalDays).mul(100).toDecimalPlaces(1).toString(),
    };
  }

  /** Actual value of a target's metric over its period. */
  async actual(tx: Tx, t: TargetRow): Promise<string> {
    const { repIds, customerIds } = await this.scopeFilter(tx, t);
    const p = [t.period_start, t.period_end, repIds, customerIds, t.product_id, t.category_id];
    const repF = (col: string) => `($3::uuid[] IS NULL OR ${col} = ANY($3::uuid[]))`;
    const custF = (col: string) => `($4::uuid[] IS NULL OR ${col} = ANY($4::uuid[]))`;
    const prodF = (lineAlias: string) => `($5::uuid IS NULL OR ${lineAlias}.product_id = $5) AND ($6::uuid IS NULL OR p.category_id = $6)`;
    let sql: string;
    switch (t.metric) {
      case 'NET_SALES':
      case 'QUANTITY': {
        const col = t.metric === 'NET_SALES' ? 'net_amount' : 'quantity';
        sql = `SELECT
          COALESCE((SELECT SUM(il.${col}) FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id LEFT JOIN products p ON p.id = il.product_id
                     WHERE i.status <> 'VOID' AND i.invoice_date BETWEEN $1 AND $2 AND ${repF('i.sales_rep_id')} AND ${custF('i.customer_id')} AND ${prodF('il')}), 0)
        - COALESCE((SELECT SUM(cl.${col}) FROM credit_note_lines cl JOIN credit_notes cn ON cn.id = cl.credit_note_id
                     LEFT JOIN sales_orders o ON o.id = cn.sales_order_id LEFT JOIN products p ON p.id = cl.product_id
                     WHERE cn.status <> 'VOID' AND cn.credit_date BETWEEN $1 AND $2 AND ${repF('o.sales_rep_id')} AND ${custF('cn.customer_id')} AND ${prodF('cl')}), 0) AS v`;
        break;
      }
      case 'COLLECTIONS':
        sql = `SELECT COALESCE(SUM(r.amount), 0) AS v FROM customer_receipts r JOIN sales_collection_submissions s ON s.customer_receipt_id = r.id
                WHERE r.status = 'POSTED' AND r.receipt_date BETWEEN $1 AND $2 AND ${repF('s.sales_rep_id')} AND ${custF('r.customer_id')}
                  AND $5::uuid IS NULL AND $6::uuid IS NULL`;
        break;
      case 'ORDER_COUNT':
        sql = `SELECT count(*) AS v FROM sales_orders o
                WHERE o.order_date BETWEEN $1 AND $2 AND o.status NOT IN ('DRAFT', 'CANCELLED', 'REJECTED')
                  AND ${repF('o.sales_rep_id')} AND ${custF('o.customer_id')}
                  AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM sales_order_lines l WHERE l.order_id = o.id AND l.product_id = $5))
                  AND ($6::uuid IS NULL OR EXISTS (SELECT 1 FROM sales_order_lines l JOIN products p ON p.id = l.product_id WHERE l.order_id = o.id AND p.category_id = $6))`;
        break;
      case 'NEW_CUSTOMERS':
        sql = `SELECT count(*) AS v FROM (
                 SELECT DISTINCT ON (o.customer_id) o.customer_id, o.order_date, o.sales_rep_id FROM sales_orders o
                  WHERE o.status NOT IN ('DRAFT', 'CANCELLED', 'REJECTED') ORDER BY o.customer_id, o.order_date, o.created_at) f
                WHERE f.order_date BETWEEN $1 AND $2 AND ${repF('f.sales_rep_id')} AND ${custF('f.customer_id')}
                  AND $5::uuid IS NULL AND $6::uuid IS NULL`;
        break;
      case 'VISITS':
        sql = `SELECT count(*) AS v FROM sales_visits v
                WHERE v.status = 'COMPLETED' AND v.checked_out_at::date BETWEEN $1 AND $2 AND ${repF('v.sales_rep_id')} AND ${custF('v.customer_id')}
                  AND $5::uuid IS NULL AND $6::uuid IS NULL`;
        break;
    }
    const r = await tx.one<{ v: string }>(sql, p);
    return new Decimal(r.v ?? 0).toString();
  }

  /** Reps (REP/TEAM targets) or customers (TERRITORY targets) whose results count. */
  private async scopeFilter(tx: Tx, t: TargetRow): Promise<{ repIds: string[] | null; customerIds: string[] | null }> {
    if (t.scope === 'REP') return { repIds: [t.sales_rep_id!], customerIds: null };
    if (t.scope === 'TEAM') {
      const reps = await tx.query<{ id: string }>(
        `WITH RECURSIVE tm AS (SELECT id FROM sales_teams WHERE id = $1 UNION SELECT s.id FROM sales_teams s JOIN tm ON s.parent_team_id = tm.id)
         SELECT r.id FROM sales_representatives r WHERE r.team_id IN (SELECT id FROM tm)`,
        [t.team_id],
      );
      return { repIds: reps.map((r) => r.id), customerIds: null };
    }
    const custs = await tx.query<{ customer_id: string }>(
      `WITH RECURSIVE tr AS (SELECT id FROM sales_territories WHERE id = $1 UNION SELECT s.id FROM sales_territories s JOIN tr ON s.parent_id = tr.id)
       SELECT DISTINCT customer_id FROM sales_customer_assignments
        WHERE territory_id IN (SELECT id FROM tr) AND valid_from <= $3 AND (valid_to IS NULL OR valid_to >= $2)`,
      [t.territory_id, t.period_start, t.period_end],
    );
    return { repIds: null, customerIds: custs.map((c) => c.customer_id) };
  }

  /** REP NET_SALES monthly achievement %, used for commission tiers. */
  async monthlyNetSalesAchievement(tx: Tx, salesRepId: string, periodMonth: string): Promise<string | null> {
    const t = await tx.maybeOne<TargetRow>(
      `SELECT * FROM sales_targets WHERE scope = 'REP' AND sales_rep_id = $1 AND period_type = 'MONTH' AND period_start = $2
          AND metric = 'NET_SALES' AND product_id IS NULL AND category_id IS NULL`,
      [salesRepId, periodMonth],
    );
    if (!t) return null;
    return (await this.progress(tx, t)).achievementPercent;
  }

  assertCanManage(user: TenantUser) {
    if (!has(user, P.SALES_TARGETS_MANAGE)) throw forbidden('You cannot manage targets');
  }
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
