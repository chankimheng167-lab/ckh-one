import { Injectable } from '@nestjs/common';
import { P } from '@ckh/shared';
import { has, TenantUser } from '../../common/auth-context';
import { AuditService } from '../../common/audit.service';
import { conflict, DomainError, forbidden, notFound } from '../../common/errors';
import type { Tx } from '../../db/database.service';
import { SalesContextService } from '../sales-context.service';

export interface ScheduleVisitInput {
  clientReference?: string;
  customerId: string;
  salesRepId?: string;
  scheduledStart: string;
  scheduledEnd?: string;
  purpose?: string;
}

export interface CheckInInput {
  /** The rep explicitly agreed to share their location for this check-in. */
  locationConsent: boolean;
  latitude?: number;
  longitude?: number;
  accuracyM?: number;
  at?: string;
}

export interface CheckOutInput {
  outcome: 'ORDER_TAKEN' | 'FOLLOW_UP_NEEDED' | 'NO_INTEREST' | 'COLLECTION_MADE' | 'CUSTOMER_UNAVAILABLE' | 'OTHER';
  outcomeSummary?: string;
  at?: string;
}

export interface VisitNoteInput {
  noteType: 'NOTE' | 'FOLLOW_UP_TASK';
  body: string;
  dueDate?: string;
  assignedToUserId?: string;
}

const LOCATION_PURPOSE = 'Proof of customer visit at check-in';

/**
 * Customer visits. Location is taken only at check-in, only when the tenant
 * allows it, and only with the rep's explicit consent for that check-in —
 * there is no background tracking. With the REQUIRED policy a check-in
 * without consent is refused rather than captured silently.
 */
@Injectable()
export class VisitsService {
  constructor(
    private readonly ctx: SalesContextService,
    private readonly audit: AuditService,
  ) {}

  async schedule(tx: Tx, user: TenantUser, i: ScheduleVisitInput) {
    const rep = await this.resolveRep(tx, user, i.salesRepId);
    await this.ctx.assertCustomerAccess(tx, user, i.customerId);
    if (i.scheduledEnd && i.scheduledEnd < i.scheduledStart) throw new DomainError('INVALID_TIME', 'Visit end must be after its start', 422);
    const v = await tx.one<{ id: string }>(
      `INSERT INTO sales_visits (tenant_id, sales_rep_id, customer_id, scheduled_start, scheduled_end, purpose, created_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6) RETURNING id`,
      [rep.id, i.customerId, i.scheduledStart, i.scheduledEnd ?? null, i.purpose ?? null, user.userId],
    );
    await this.audit.record(tx, { action: 'VISIT_SCHEDULED', entityType: 'sales_visit', entityId: v.id, after: i });
    return this.get(tx, user, v.id);
  }

  async checkIn(tx: Tx, user: TenantUser, visitId: string, i: CheckInInput) {
    const v = await this.lockOwn(tx, user, visitId);
    if (v.status !== 'PLANNED') throw conflict('VISIT_NOT_PLANNED', `Visit is ${v.status.toLowerCase()}`);
    const policy = (await this.ctx.settings(tx)).visitLocationCapture;
    const hasCoords = i.latitude !== undefined && i.longitude !== undefined;
    let store = false;
    if (policy === 'REQUIRED' && (!i.locationConsent || !hasCoords)) {
      throw new DomainError('LOCATION_REQUIRED', 'Your company requires location at check-in. Allow location for this check-in to continue.', 422);
    }
    if (policy !== 'OFF' && i.locationConsent && hasCoords) store = true;
    await tx.query(
      `UPDATE sales_visits SET status = 'IN_PROGRESS', checked_in_at = COALESCE($2::timestamptz, now()),
              location_consent = $3, check_in_latitude = $4, check_in_longitude = $5, check_in_accuracy_m = $6, location_purpose = $7
        WHERE id = $1`,
      [visitId, i.at ?? null, store, store ? i.latitude : null, store ? i.longitude : null, store ? i.accuracyM ?? null : null, store ? LOCATION_PURPOSE : null],
    );
    await this.audit.record(tx, { action: 'VISIT_CHECKED_IN', entityType: 'sales_visit', entityId: visitId, after: { locationCaptured: store, policy } });
    return this.get(tx, user, visitId);
  }

  async checkOut(tx: Tx, user: TenantUser, visitId: string, i: CheckOutInput) {
    const v = await this.lockOwn(tx, user, visitId);
    if (v.status !== 'IN_PROGRESS') throw conflict('VISIT_NOT_IN_PROGRESS', 'Check in before checking out');
    await tx.query(
      `UPDATE sales_visits SET status = 'COMPLETED', checked_out_at = COALESCE($2::timestamptz, now()), outcome = $3, outcome_summary = $4 WHERE id = $1`,
      [visitId, i.at ?? null, i.outcome, i.outcomeSummary ?? null],
    );
    await this.audit.record(tx, { action: 'VISIT_COMPLETED', entityType: 'sales_visit', entityId: visitId, after: i });
    return this.get(tx, user, visitId);
  }

  async cancel(tx: Tx, user: TenantUser, visitId: string, reason: string, missed = false) {
    const v = await this.lockOwn(tx, user, visitId);
    if (!['PLANNED', 'IN_PROGRESS'].includes(v.status)) throw conflict('VISIT_CLOSED', `Visit is ${v.status.toLowerCase()}`);
    await tx.query(`UPDATE sales_visits SET status = $2, cancel_reason = $3 WHERE id = $1`, [visitId, missed ? 'MISSED' : 'CANCELLED', reason]);
    await this.audit.record(tx, { action: missed ? 'VISIT_MISSED' : 'VISIT_CANCELLED', entityType: 'sales_visit', entityId: visitId, after: { reason } });
    return this.get(tx, user, visitId);
  }

  async addNote(tx: Tx, user: TenantUser, visitId: string, i: VisitNoteInput) {
    await this.get(tx, user, visitId); // visibility
    if (i.noteType === 'FOLLOW_UP_TASK' && !i.dueDate) throw new DomainError('DUE_DATE_REQUIRED', 'A follow-up task needs a due date', 422);
    const assignee = i.noteType === 'FOLLOW_UP_TASK' ? i.assignedToUserId ?? user.userId : null;
    const note = await tx.one(
      `INSERT INTO sales_visit_notes (tenant_id, visit_id, author_user_id, note_type, body, due_date, assigned_to_user_id)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6) RETURNING *`,
      [visitId, user.userId, i.noteType, i.body, i.dueDate ?? null, assignee],
    );
    return note;
  }

  /** Supervisors review their team's visits. */
  async review(tx: Tx, user: TenantUser, visitId: string, comment: string) {
    if (!has(user, P.SALES_VISITS_VIEW_TEAM)) throw forbidden('Only supervisors can review visits');
    const v = await this.get(tx, user, visitId);
    if (v.created_by === user.userId || v.rep_user_id === user.userId) throw forbidden('You cannot review your own visit');
    await tx.query('UPDATE sales_visits SET reviewed_by = $2, reviewed_at = now(), review_comment = $3 WHERE id = $1', [visitId, user.userId, comment]);
    return this.get(tx, user, visitId);
  }

  async followUps(tx: Tx, user: TenantUser, includeDone: boolean) {
    return tx.query(
      `SELECT n.id, n.body, n.due_date, n.completed_at, n.created_at, v.id AS visit_id, c.id AS customer_id, c.name AS customer_name
         FROM sales_visit_notes n JOIN sales_visits v ON v.id = n.visit_id JOIN customers c ON c.id = v.customer_id
        WHERE n.note_type = 'FOLLOW_UP_TASK' AND n.assigned_to_user_id = $1 AND ($2::boolean OR n.completed_at IS NULL)
        ORDER BY n.completed_at NULLS FIRST, n.due_date`,
      [user.userId, includeDone],
    );
  }

  async completeFollowUp(tx: Tx, user: TenantUser, noteId: string) {
    const r = await tx.maybeOne(
      `UPDATE sales_visit_notes SET completed_at = now() WHERE id = $1 AND note_type = 'FOLLOW_UP_TASK' AND assigned_to_user_id = $2 AND completed_at IS NULL RETURNING *`,
      [noteId, user.userId],
    );
    if (!r) throw notFound('Open follow-up task');
    return r;
  }

  async get(tx: Tx, user: TenantUser, visitId: string) {
    const [pred, params] = await this.scope(tx, user, 2);
    const v = await tx.maybeOne(
      `SELECT v.*, c.code AS customer_code, c.name AS customer_name, u.full_name AS sales_rep_name, r.user_id AS rep_user_id,
              ru.full_name AS reviewed_by_name
         FROM sales_visits v JOIN customers c ON c.id = v.customer_id
         JOIN sales_representatives r ON r.id = v.sales_rep_id JOIN users u ON u.id = r.user_id
         LEFT JOIN users ru ON ru.id = v.reviewed_by
        WHERE v.id = $1 AND ${pred}`,
      [visitId, ...params],
    );
    if (!v) throw notFound('Visit');
    const notes = await tx.query(
      `SELECT n.id, n.note_type, n.body, n.due_date, n.completed_at, n.created_at, u.full_name AS author, au.full_name AS assigned_to
         FROM sales_visit_notes n JOIN users u ON u.id = n.author_user_id LEFT JOIN users au ON au.id = n.assigned_to_user_id
        WHERE n.visit_id = $1 ORDER BY n.created_at`,
      [visitId],
    );
    const orders = await tx.query(`SELECT id, number, status, grand_total, currency FROM sales_orders WHERE visit_id = $1 ORDER BY created_at`, [visitId]);
    const quotations = await tx.query(`SELECT id, number, status, grand_total, currency FROM sales_quotations WHERE visit_id = $1 ORDER BY created_at`, [visitId]);
    return { ...v, notes, orders, quotations };
  }

  async list(tx: Tx, user: TenantUser, q: { from?: string; to?: string; status?: string; salesRepId?: string; customerId?: string; limit: number; offset: number }) {
    const [pred, scopeParams] = await this.scope(tx, user, 1);
    const params: unknown[] = [...scopeParams];
    const where = [pred];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (q.from) add('v.scheduled_start >= ?::date', q.from);
    if (q.to) add(`v.scheduled_start < ?::date + 1`, q.to);
    if (q.status) add(`v.status = ANY(string_to_array(?, ','))`, q.status);
    if (q.salesRepId) add('v.sales_rep_id = ?', q.salesRepId);
    if (q.customerId) add('v.customer_id = ?', q.customerId);
    params.push(q.limit, q.offset);
    return tx.query(
      `SELECT v.id, v.status, v.scheduled_start, v.scheduled_end, v.purpose, v.outcome, v.checked_in_at, v.checked_out_at,
              v.location_consent, v.reviewed_at, c.id AS customer_id, c.name AS customer_name, u.full_name AS sales_rep_name,
              (SELECT count(*) FROM sales_orders o WHERE o.visit_id = v.id) AS order_count, count(*) OVER () AS total_count
         FROM sales_visits v JOIN customers c ON c.id = v.customer_id
         JOIN sales_representatives r ON r.id = v.sales_rep_id JOIN users u ON u.id = r.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY v.scheduled_start DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
  }

  /** Validates that an order or quotation raised "during a visit" really belongs to that visit. */
  async assertVisitForDocument(tx: Tx, visitId: string, repId: string, customerId: string) {
    const v = await tx.maybeOne<{ sales_rep_id: string; customer_id: string; status: string }>('SELECT sales_rep_id, customer_id, status FROM sales_visits WHERE id = $1', [visitId]);
    if (!v || v.sales_rep_id !== repId || v.customer_id !== customerId) throw new DomainError('VISIT_INVALID', 'The visit does not belong to this representative and customer', 422);
    if (!['IN_PROGRESS', 'COMPLETED'].includes(v.status)) throw new DomainError('VISIT_NOT_STARTED', 'Check in to the visit before raising documents for it', 422);
  }

  // ---------------------------------------------------------------------------

  private async scope(tx: Tx, user: TenantUser, start: number): Promise<[string, unknown[]]> {
    if (has(user, P.SALES_ORDERS_VIEW_ALL) && has(user, P.SALES_VISITS_VIEW_TEAM)) return ['TRUE', []];
    const rep = await this.ctx.repForUser(tx, user.userId);
    const teams = has(user, P.SALES_VISITS_VIEW_TEAM) ? await this.ctx.managedTeamIds(tx, user.userId) : [];
    return [
      `(v.sales_rep_id = $${start} OR v.sales_rep_id IN (SELECT id FROM sales_representatives WHERE team_id = ANY($${start + 1}::uuid[])))`,
      [rep?.id ?? null, teams],
    ];
  }

  private async resolveRep(tx: Tx, user: TenantUser, salesRepId?: string) {
    const own = await this.ctx.repForUser(tx, user.userId);
    if (!salesRepId || salesRepId === own?.id) return this.ctx.requireRep(tx, user);
    const rep = await tx.maybeOne<{ id: string; team_id: string | null; status: string }>('SELECT id, team_id, status FROM sales_representatives WHERE id = $1', [salesRepId]);
    if (!rep || rep.status !== 'ACTIVE') throw new DomainError('REP_INVALID', 'Sales representative not found or inactive', 422);
    const teams = has(user, P.SALES_VISITS_VIEW_TEAM) ? await this.ctx.managedTeamIds(tx, user.userId) : [];
    if (!has(user, P.SALES_ORDERS_VIEW_ALL) && (!rep.team_id || !teams.includes(rep.team_id))) throw forbidden('You cannot schedule visits for this representative');
    return rep;
  }

  /** Only the visiting rep checks in/out. */
  private async lockOwn(tx: Tx, user: TenantUser, visitId: string) {
    const v = await tx.maybeOne<{ id: string; status: string; rep_user_id: string }>(
      `SELECT v.id, v.status, r.user_id AS rep_user_id FROM sales_visits v JOIN sales_representatives r ON r.id = v.sales_rep_id WHERE v.id = $1 FOR UPDATE OF v`,
      [visitId],
    );
    if (!v) throw notFound('Visit');
    if (v.rep_user_id !== user.userId) {
      await this.get(tx, user, visitId); // 404 if not visible at all
      throw forbidden('Only the visiting representative can do this');
    }
    return v;
  }
}
