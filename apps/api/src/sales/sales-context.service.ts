import { Injectable } from '@nestjs/common';
import {
  ApprovalLimits,
  DEFAULT_APPROVAL_LIMITS,
  DEFAULT_WORKFLOW_SETTINGS,
  OrderWorkflowSettings,
  P,
} from '@ckh/shared';
import { has, TenantUser } from '../common/auth-context';
import { DomainError, forbidden } from '../common/errors';
import type { Tx } from '../db/database.service';

export interface SalesRep {
  id: string;
  user_id: string;
  team_id: string | null;
  default_branch_id: string | null;
  default_warehouse_id: string | null;
  max_discount_percent: string | null;
  status: string;
}

export interface SalesSettings {
  approvalLimits: ApprovalLimits;
  workflow: OrderWorkflowSettings;
  allowPriceOverride: boolean;
  allowBackorders: boolean;
  showBalancesToReps: boolean;
  visitLocationCapture: 'OFF' | 'ASK' | 'REQUIRED';
  offlineCatalogMaxAgeHours: number;
}

/**
 * Record-level access rules for the sales module, in one place:
 *  - a rep sees customers with an active assignment to them;
 *  - a supervisor/manager with view_team sees their team members' customers;
 *  - customers.view_all sees every customer.
 * Every customer-scoped read and write calls one of these helpers.
 */
@Injectable()
export class SalesContextService {
  async settings(tx: Tx): Promise<SalesSettings> {
    const r = await tx.maybeOne(
      `SELECT approval_limits, workflow, allow_price_override, allow_backorders, show_balances_to_reps,
              visit_location_capture, offline_catalog_max_age_hours
         FROM sales_settings WHERE tenant_id = current_tenant_id()`,
    );
    return {
      approvalLimits: { ...DEFAULT_APPROVAL_LIMITS, ...(r?.approval_limits ?? {}) },
      workflow: { ...DEFAULT_WORKFLOW_SETTINGS, ...(r?.workflow ?? {}) },
      allowPriceOverride: r?.allow_price_override ?? false,
      allowBackorders: r?.allow_backorders ?? true,
      showBalancesToReps: r?.show_balances_to_reps ?? true,
      visitLocationCapture: r?.visit_location_capture ?? 'ASK',
      offlineCatalogMaxAgeHours: r?.offline_catalog_max_age_hours ?? 24,
    };
  }

  async repForUser(tx: Tx, userId: string): Promise<SalesRep | null> {
    return tx.maybeOne<SalesRep>(
      `SELECT id, user_id, team_id, default_branch_id, default_warehouse_id, max_discount_percent, status
         FROM sales_representatives WHERE user_id = $1`,
      [userId],
    );
  }

  async requireRep(tx: Tx, user: TenantUser): Promise<SalesRep> {
    const rep = await this.repForUser(tx, user.userId);
    if (!rep || rep.status !== 'ACTIVE') {
      throw new DomainError('NOT_A_SALES_REP', 'Your user account is not set up as an active sales representative', 403);
    }
    return rep;
  }

  /**
   * SQL predicate restricting `<alias>.id` (a customers row) to customers the
   * user may see. Returns [sqlFragment, params] to append; parameter numbers
   * start at `startIndex`.
   */
  async customerScope(tx: Tx, user: TenantUser, alias: string, startIndex: number): Promise<[string, unknown[]]> {
    if (has(user, P.CUSTOMERS_VIEW_ALL)) return ['TRUE', []];
    const rep = await this.repForUser(tx, user.userId);
    const teamIds = has(user, P.SALES_ORDERS_VIEW_TEAM) ? await this.managedTeamIds(tx, user.userId) : [];
    if (!rep && teamIds.length === 0) return ['FALSE', []];
    return [
      `EXISTS (SELECT 1 FROM sales_customer_assignments a
                 JOIN sales_representatives r ON r.id = a.sales_rep_id
                WHERE a.customer_id = ${alias}.id
                  AND a.valid_from <= CURRENT_DATE AND (a.valid_to IS NULL OR a.valid_to >= CURRENT_DATE)
                  AND (a.sales_rep_id = $${startIndex} OR r.team_id = ANY($${startIndex + 1}::uuid[])))`,
      [rep?.id ?? null, teamIds],
    ];
  }

  async assertCustomerAccess(tx: Tx, user: TenantUser, customerId: string): Promise<void> {
    const [pred, params] = await this.customerScope(tx, user, 'c', 2);
    const ok = await tx.maybeOne(`SELECT 1 FROM customers c WHERE c.id = $1 AND ${pred}`, [customerId, ...params]);
    if (!ok) throw forbidden('This customer is not assigned to you');
  }

  /** Teams the user supervises or manages, including their sub-teams. */
  async managedTeamIds(tx: Tx, userId: string): Promise<string[]> {
    const rows = await tx.query<{ id: string }>(
      `WITH RECURSIVE t AS (
         SELECT id FROM sales_teams WHERE supervisor_user_id = $1 OR manager_user_id = $1
         UNION
         SELECT st.id FROM sales_teams st JOIN t ON st.parent_team_id = t.id
       ) SELECT id FROM t`,
      [userId],
    );
    return rows.map((r) => r.id);
  }

  /**
   * SQL predicate restricting `<alias>` (a sales_orders row) to orders the
   * user may see: own orders, team orders, or all.
   */
  async orderScope(tx: Tx, user: TenantUser, alias: string, startIndex: number): Promise<[string, unknown[]]> {
    if (has(user, P.SALES_ORDERS_VIEW_ALL)) return ['TRUE', []];
    const rep = await this.repForUser(tx, user.userId);
    const teamIds = has(user, P.SALES_ORDERS_VIEW_TEAM) ? await this.managedTeamIds(tx, user.userId) : [];
    if (!has(user, P.SALES_ORDERS_VIEW_OWN) && teamIds.length === 0) return ['FALSE', []];
    return [
      `(${alias}.sales_rep_id = $${startIndex} OR ${alias}.sales_rep_id IN
          (SELECT id FROM sales_representatives WHERE team_id = ANY($${startIndex + 1}::uuid[])))`,
      [rep?.id ?? null, teamIds],
    ];
  }

  /** Warehouses whose stock the user may see and sell from. */
  async authorizedWarehouseIds(tx: Tx, user: TenantUser): Promise<string[]> {
    if (has(user, P.INVENTORY_VIEW) || has(user, P.SALES_ORDERS_VIEW_ALL)) {
      return (await tx.query<{ id: string }>('SELECT id FROM warehouses WHERE is_active')).map((r) => r.id);
    }
    const explicit = await tx.query<{ warehouse_id: string }>(
      'SELECT warehouse_id FROM user_warehouse_access WHERE user_id = $1',
      [user.userId],
    );
    const ids = new Set(explicit.map((r) => r.warehouse_id));
    const rep = await this.repForUser(tx, user.userId);
    if (rep?.default_warehouse_id) ids.add(rep.default_warehouse_id);
    return [...ids];
  }
}
