import { Injectable } from '@nestjs/common';
import { P } from '@ckh/shared';
import { has, TenantUser } from '../../common/auth-context';
import { AuditService } from '../../common/audit.service';
import { DomainError, notFound } from '../../common/errors';
import type { Tx } from '../../db/database.service';
import { SalesContextService } from '../sales-context.service';

@Injectable()
export class SalesCustomersService {
  constructor(
    private readonly ctx: SalesContextService,
    private readonly audit: AuditService,
  ) {}

  private async canSeeBalances(tx: Tx, user: TenantUser): Promise<boolean> {
    if (!has(user, P.SALES_CUSTOMERS_VIEW_BALANCE)) return false;
    if (has(user, P.CUSTOMERS_VIEW_ALL)) return true;
    return (await this.ctx.settings(tx)).showBalancesToReps;
  }

  /** "My Customers" — only customers this user is authorised to see. */
  async list(tx: Tx, user: TenantUser, q: { search?: string; groupId?: string; limit: number; offset: number }) {
    const [scope, params] = await this.ctx.customerScope(tx, user, 'c', 1);
    const all: unknown[] = [...params];
    const where = [scope, `c.status <> 'INACTIVE'`];
    if (q.search) {
      all.push(`%${q.search.toLowerCase()}%`);
      where.push(`(lower(c.name) LIKE $${all.length} OR lower(c.code) LIKE $${all.length} OR c.phone LIKE $${all.length})`);
    }
    if (q.groupId) {
      all.push(q.groupId);
      where.push(`c.customer_group_id = $${all.length}`);
    }
    const balances = await this.canSeeBalances(tx, user);
    all.push(q.limit, q.offset);
    return tx.query(
      `SELECT c.id, c.code, c.name, c.name_local, c.phone, c.contact_name, c.status, c.credit_hold,
              g.name AS group_name,
              ${balances ? 'COALESCE(b.outstanding, 0) AS outstanding, COALESCE(b.overdue, 0) AS overdue,' : ''}
              (SELECT max(order_date) FROM sales_orders o WHERE o.customer_id = c.id AND o.status <> 'CANCELLED') AS last_order_date,
              count(*) OVER () AS total_count
         FROM customers c
         LEFT JOIN customer_groups g ON g.id = c.customer_group_id
         LEFT JOIN customer_balances b ON b.customer_id = c.id
        WHERE ${where.join(' AND ')}
        ORDER BY c.name
        LIMIT $${all.length - 1} OFFSET $${all.length}`,
      all,
    );
  }

  /** Customer profile with addresses, notes, recent orders and (if allowed) balances and payments. */
  async profile(tx: Tx, user: TenantUser, customerId: string) {
    await this.ctx.assertCustomerAccess(tx, user, customerId);
    const c = await tx.maybeOne(
      `SELECT c.*, g.name AS group_name, pl.name AS price_list_name,
              (SELECT json_agg(json_build_object('repId', r.id, 'name', u.full_name, 'type', a.assignment_type))
                 FROM sales_customer_assignments a
                 JOIN sales_representatives r ON r.id = a.sales_rep_id JOIN users u ON u.id = r.user_id
                WHERE a.customer_id = c.id AND a.valid_to IS NULL) AS assigned_reps
         FROM customers c
         LEFT JOIN customer_groups g ON g.id = c.customer_group_id
         LEFT JOIN price_lists pl ON pl.id = c.price_list_id
        WHERE c.id = $1`,
      [customerId],
    );
    if (!c) throw notFound('Customer');
    const addresses = await tx.query(
      `SELECT a.id, a.address_type, a.label, a.line1, a.line2, a.location_id, l.name AS location_name,
              a.contact_name, a.contact_phone, a.is_default, a.latitude, a.longitude
         FROM customer_addresses a LEFT JOIN admin_locations l ON l.id = a.location_id
        WHERE a.customer_id = $1 ORDER BY a.address_type, a.is_default DESC`,
      [customerId],
    );
    const notes = await tx.query(
      `SELECT n.id, n.body, n.created_at, u.full_name AS author FROM customer_notes n JOIN users u ON u.id = n.author_user_id
        WHERE n.customer_id = $1 ORDER BY n.created_at DESC LIMIT 50`,
      [customerId],
    );
    const orders = await tx.query(
      `SELECT id, number, order_date, status, grand_total, currency FROM sales_orders
        WHERE customer_id = $1 ORDER BY order_date DESC, number DESC LIMIT 20`,
      [customerId],
    );
    let balances: unknown = null;
    let payments: unknown[] = [];
    if (await this.canSeeBalances(tx, user)) {
      balances = await tx.maybeOne('SELECT outstanding, overdue, oldest_due_date FROM customer_balances WHERE customer_id = $1', [customerId]);
      payments = await tx.query(
        `SELECT id, number, receipt_date, amount, currency, payment_method FROM customer_receipts
          WHERE customer_id = $1 AND status = 'POSTED' ORDER BY receipt_date DESC LIMIT 20`,
        [customerId],
      );
    } else {
      delete (c as any).credit_limit;
    }
    return { ...c, addresses, notes, recentOrders: orders, balances, recentPayments: payments };
  }

  async addNote(tx: Tx, user: TenantUser, customerId: string, body: string) {
    await this.ctx.assertCustomerAccess(tx, user, customerId);
    return tx.one(
      `INSERT INTO customer_notes (tenant_id, customer_id, author_user_id, body) VALUES (current_tenant_id(), $1, $2, $3)
       RETURNING id, body, created_at`,
      [customerId, user.userId, body],
    );
  }

  /** Assign a customer to a rep (supervisor / manager). Closes any previous primary assignment. */
  async assign(tx: Tx, user: TenantUser, input: { customerId: string; salesRepId: string; assignmentType: 'PRIMARY' | 'SECONDARY'; territoryId?: string }) {
    const rep = await tx.maybeOne<{ id: string; team_id: string | null; status: string }>('SELECT id, team_id, status FROM sales_representatives WHERE id = $1', [input.salesRepId]);
    if (!rep || rep.status !== 'ACTIVE') throw new DomainError('REP_INVALID', 'Sales representative not found or inactive', 422);
    if (!has(user, P.CUSTOMERS_VIEW_ALL)) {
      const teams = await this.ctx.managedTeamIds(tx, user.userId);
      if (!rep.team_id || !teams.includes(rep.team_id)) throw new DomainError('FORBIDDEN', 'You can only assign customers to reps in your team', 403);
    }
    const customer = await tx.maybeOne('SELECT id FROM customers WHERE id = $1', [input.customerId]);
    if (!customer) throw notFound('Customer');
    if (input.assignmentType === 'PRIMARY') {
      await tx.query(
        `UPDATE sales_customer_assignments SET valid_to = CURRENT_DATE - 1
          WHERE customer_id = $1 AND assignment_type = 'PRIMARY' AND valid_to IS NULL AND valid_from < CURRENT_DATE`,
        [input.customerId],
      );
      // Same-day reassignment: remove the open row instead of creating a zero-length range.
      await tx.query(
        `DELETE FROM sales_customer_assignments
          WHERE customer_id = $1 AND assignment_type = 'PRIMARY' AND valid_to IS NULL AND valid_from >= CURRENT_DATE`,
        [input.customerId],
      );
    }
    const row = await tx.one(
      `INSERT INTO sales_customer_assignments (tenant_id, customer_id, sales_rep_id, territory_id, assignment_type, assigned_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5) RETURNING *`,
      [input.customerId, input.salesRepId, input.territoryId ?? null, input.assignmentType, user.userId],
    );
    await this.audit.record(tx, { action: 'CUSTOMER_ASSIGNED', entityType: 'customer', entityId: input.customerId, after: row });
    return row;
  }
}
