import { Injectable } from '@nestjs/common';
import { Decimal, P } from '@ckh/shared';
import { has, TenantUser } from '../common/auth-context';
import { AuditService } from '../common/audit.service';
import { conflict, DomainError, forbidden, notFound } from '../common/errors';
import type { Tx } from '../db/database.service';
import { JournalService } from '../accounting/journal.service';
import { NumberingService } from '../core/numbering.service';
import { PosContextService } from './pos-context.service';

const D = (v: Decimal.Value) => new Decimal(v);

/**
 * Cashier shifts. A shift opens with a counted float; every cash sale, cash
 * refund, cash in and cash out is an append-only movement, so expected cash
 * is simply their sum. Closing records the count and posts any difference to
 * "cash over and short"; a supervisor other than the cashier then approves.
 * Closed shifts are frozen by a database trigger.
 */
@Injectable()
export class PosShiftsService {
  constructor(
    private readonly ctx: PosContextService,
    private readonly journal: JournalService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  async open(tx: Tx, user: TenantUser, input: { registerId: string; openingFloat: string; notes?: string }) {
    const reg = await this.ctx.register(tx, user, input.registerId);
    if (D(input.openingFloat).lt(0)) throw new DomainError('INVALID_AMOUNT', 'The opening float cannot be negative', 422);
    const existing = await this.ctx.openShift(tx, reg.id);
    if (existing) throw conflict('SHIFT_ALREADY_OPEN', `Shift ${existing.number} is already open on ${reg.name}`);
    const mine = await tx.maybeOne<{ number: string; register: string }>(
      `SELECT s.number, r.name AS register FROM pos_shifts s JOIN pos_registers r ON r.id = s.register_id WHERE s.cashier_id = $1 AND s.status = 'OPEN'`,
      [user.userId],
    );
    if (mine) throw conflict('CASHIER_HAS_OPEN_SHIFT', `You already have shift ${mine.number} open on ${mine.register}`);
    const currency = (await tx.one<{ c: string }>('SELECT base_currency AS c FROM tenants WHERE id = current_tenant_id()')).c;
    const number = await this.numbering.next(tx, 'POS_SHIFT');
    const s = await tx.one<{ id: string }>(
      `INSERT INTO pos_shifts (tenant_id, number, register_id, branch_id, cashier_id, business_date, currency, opening_float, closing_notes)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, NULL) RETURNING id`,
      [number, reg.id, reg.branch_id, user.userId, tx.today(), currency, D(input.openingFloat).toFixed(2)],
    );
    if (D(input.openingFloat).gt(0)) {
      await tx.query(
        `INSERT INTO pos_cash_movements (tenant_id, shift_id, movement_type, amount, reason, created_by)
         VALUES (current_tenant_id(), $1, 'OPENING_FLOAT', $2, $3, $4)`,
        [s.id, D(input.openingFloat).toFixed(2), input.notes ?? 'Opening float', user.userId],
      );
    }
    await this.audit.record(tx, { action: 'POS_SHIFT_OPENED', entityType: 'pos_shift', entityId: s.id, after: { number, register: reg.code, openingFloat: input.openingFloat } });
    return this.details(tx, user, s.id);
  }

  async current(tx: Tx, user: TenantUser, registerId: string) {
    await this.ctx.register(tx, user, registerId, { allowInactive: true });
    const s = await this.ctx.openShift(tx, registerId);
    return s ? this.details(tx, user, s.id) : null;
  }

  private async lockShift(tx: Tx, user: TenantUser, id: string) {
    const s = await tx.maybeOne<{ id: string; number: string; status: string; cashier_id: string; register_id: string; branch_id: string; business_date: string; opening_float: string }>(
      `SELECT id, number, status, cashier_id, register_id, branch_id, business_date, opening_float FROM pos_shifts WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!s) throw notFound('Shift');
    await this.ctx.assertBranch(tx, user, s.branch_id);
    return s;
  }

  private assertOwnerOrSupervisor(user: TenantUser, s: { cashier_id: string }) {
    if (s.cashier_id !== user.userId && !has(user, P.POS_SHIFT_APPROVE)) throw forbidden('This shift belongs to another cashier');
  }

  async expectedCash(tx: Tx, shiftId: string): Promise<Decimal> {
    const r = await tx.one<{ total: string }>('SELECT COALESCE(sum(amount), 0) AS total FROM pos_cash_movements WHERE shift_id = $1', [shiftId]);
    return D(r.total);
  }

  /** Cash in (e.g. change from the safe) or cash out (e.g. paying a supplier, banking) with a reason. */
  async cashMovement(tx: Tx, user: TenantUser, shiftId: string, input: { type: 'CASH_IN' | 'CASH_OUT'; amount: string; reason: string }) {
    const s = await this.lockShift(tx, user, shiftId);
    if (s.status !== 'OPEN') throw conflict('SHIFT_CLOSED', `Shift ${s.number} is closed`);
    this.assertOwnerOrSupervisor(user, s);
    const amount = D(input.amount);
    if (amount.lte(0)) throw new DomainError('INVALID_AMOUNT', 'Amount must be greater than zero', 422);
    if (input.type === 'CASH_OUT') {
      const expected = await this.expectedCash(tx, s.id);
      if (amount.gt(expected)) throw conflict('NOT_ENOUGH_CASH', `The drawer should only hold ${expected.toFixed(2)}`);
    }
    const signed = input.type === 'CASH_OUT' ? amount.neg() : amount;
    const m = await tx.one(
      `INSERT INTO pos_cash_movements (tenant_id, shift_id, movement_type, amount, reason, created_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5) RETURNING *`,
      [s.id, input.type, signed.toFixed(2), input.reason, user.userId],
    );
    await this.audit.record(tx, { action: `POS_${input.type}`, entityType: 'pos_shift', entityId: s.id, after: { amount: signed.toFixed(2), reason: input.reason } });
    return { movement: m, expectedCash: (await this.expectedCash(tx, s.id)).toFixed(2) };
  }

  async close(tx: Tx, user: TenantUser, shiftId: string, input: { countedCash: string; countDetails?: Record<string, number>; notes?: string }) {
    const s = await this.lockShift(tx, user, shiftId);
    if (s.status !== 'OPEN') throw conflict('SHIFT_CLOSED', `Shift ${s.number} is already closed`);
    this.assertOwnerOrSupervisor(user, s);
    const counted = D(input.countedCash);
    if (counted.lt(0)) throw new DomainError('INVALID_AMOUNT', 'Counted cash cannot be negative', 422);
    const expected = await this.expectedCash(tx, s.id);
    const diff = counted.minus(expected);
    const settings = await this.ctx.settings(tx);
    let journalId: string | null = null;
    if (!diff.isZero()) {
      const acc = await this.journal.accounts(tx);
      const cash = settings.cashAccountId ?? acc.cash;
      const overShort = settings.cashOverShortAccountId as string;
      journalId = await this.journal.post(tx, {
        date: tx.today(),
        description: `Cash ${diff.isNeg() ? 'short' : 'over'} on shift ${s.number}`,
        sourceType: 'POS_SHIFT',
        sourceId: s.id,
        lines: diff.isNeg()
          ? [{ accountId: overShort, debit: diff.abs(), description: 'Cash short' }, { accountId: cash, credit: diff.abs(), description: 'Cash drawer' }]
          : [{ accountId: cash, debit: diff, description: 'Cash drawer' }, { accountId: overShort, credit: diff, description: 'Cash over' }],
      });
    }
    await tx.query(
      `UPDATE pos_shifts SET status = 'CLOSED', expected_cash = $2, counted_cash = $3, cash_difference = $4, count_details = $5,
              closing_notes = $6, closed_at = now(), closed_by = $7, journal_entry_id = $8
        WHERE id = $1`,
      [s.id, expected.toFixed(2), counted.toFixed(2), diff.toFixed(2), input.countDetails ? JSON.stringify(input.countDetails) : null,
        input.notes ?? null, user.userId, journalId],
    );
    const held = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM pos_held_sales WHERE register_id = $1 AND status = 'HELD'`, [s.register_id]);
    await this.audit.record(tx, {
      action: 'POS_SHIFT_CLOSED',
      entityType: 'pos_shift',
      entityId: s.id,
      after: { expected: expected.toFixed(2), counted: counted.toFixed(2), difference: diff.toFixed(2) },
    });
    const out = await this.details(tx, user, s.id);
    return { ...out, warnings: held.n ? [{ code: 'HELD_SALES_OPEN', message: `${held.n} held sale(s) are still parked on this register` }] : [] };
  }

  /** A supervisor (not the cashier) signs the closed shift off; large differences need a note. */
  async approve(tx: Tx, user: TenantUser, shiftId: string, input: { notes?: string }) {
    const s = await this.lockShift(tx, user, shiftId);
    if (s.status !== 'CLOSED') throw conflict('SHIFT_NOT_CLOSED', s.status === 'OPEN' ? `Shift ${s.number} is still open` : `Shift ${s.number} is already approved`);
    if (s.cashier_id === user.userId) throw forbidden('A different supervisor must approve your own shift');
    const diff = (await tx.one<{ d: string }>('SELECT cash_difference AS d FROM pos_shifts WHERE id = $1', [s.id])).d;
    const settings = await this.ctx.settings(tx);
    if (D(diff).abs().gt(settings.cashDifferenceTolerance) && !input.notes?.trim()) {
      throw new DomainError('NOTES_REQUIRED', `The cash difference is ${diff}; explain it before approving`, 422);
    }
    await tx.query(`UPDATE pos_shifts SET status = 'APPROVED', approved_at = now(), approved_by = $2, approval_notes = $3 WHERE id = $1`, [
      s.id, user.userId, input.notes ?? null,
    ]);
    await this.audit.record(tx, { action: 'POS_SHIFT_APPROVED', entityType: 'pos_shift', entityId: s.id, after: { difference: diff, notes: input.notes } });
    return this.details(tx, user, s.id);
  }

  async list(tx: Tx, user: TenantUser, q: { from?: string; to?: string; registerId?: string; status?: string; limit: number; offset: number }) {
    const branches = await this.ctx.branchIds(tx, user);
    const params: unknown[] = [];
    const where: string[] = ['TRUE'];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (!has(user, P.POS_SHIFT_APPROVE) && !has(user, P.POS_REPORTS_VIEW)) add('s.cashier_id = ?', user.userId);
    if (branches) add('s.branch_id = ANY(?::uuid[])', branches);
    if (q.from) add('s.business_date >= ?', q.from);
    if (q.to) add('s.business_date <= ?', q.to);
    if (q.registerId) add('s.register_id = ?', q.registerId);
    if (q.status) add('s.status = ?', q.status);
    params.push(q.limit, q.offset);
    return tx.query(
      `SELECT s.id, s.number, s.status, s.business_date, s.opened_at, s.closed_at, s.opening_float, s.expected_cash, s.counted_cash,
              s.cash_difference, s.currency, r.code AS register_code, r.name AS register_name, u.full_name AS cashier_name,
              a.full_name AS approved_by_name,
              (SELECT COALESCE(sum(amount), 0) FROM pos_cash_movements m WHERE m.shift_id = s.id) AS running_cash,
              (SELECT count(*)::int FROM pos_sales x WHERE x.shift_id = s.id) AS sale_count,
              count(*) OVER () AS total_count
         FROM pos_shifts s JOIN pos_registers r ON r.id = s.register_id JOIN users u ON u.id = s.cashier_id
         LEFT JOIN users a ON a.id = s.approved_by
        WHERE ${where.join(' AND ')}
        ORDER BY s.opened_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
  }

  /** Shift report: drawer movements, sales by payment method, refunds and the cash count. */
  async details(tx: Tx, user: TenantUser, id: string) {
    const s = await tx.maybeOne(
      `SELECT s.*, r.code AS register_code, r.name AS register_name, b.name AS branch_name, u.full_name AS cashier_name,
              cb.full_name AS closed_by_name, a.full_name AS approved_by_name
         FROM pos_shifts s JOIN pos_registers r ON r.id = s.register_id JOIN branches b ON b.id = s.branch_id
         JOIN users u ON u.id = s.cashier_id LEFT JOIN users cb ON cb.id = s.closed_by LEFT JOIN users a ON a.id = s.approved_by
        WHERE s.id = $1`,
      [id],
    );
    if (!s) throw notFound('Shift');
    await this.ctx.assertBranch(tx, user, s.branch_id);
    if (s.cashier_id !== user.userId && !has(user, P.POS_SHIFT_APPROVE) && !has(user, P.POS_REPORTS_VIEW)) throw forbidden();
    s.movements = await tx.query(
      `SELECT m.id, m.movement_type, m.amount, m.reason, m.reference_type, m.reference_id, m.created_at, u.full_name AS created_by_name,
              COALESCE(ps.number, pr.number) AS reference_number
         FROM pos_cash_movements m JOIN users u ON u.id = m.created_by
         LEFT JOIN pos_sales ps ON m.reference_type = 'POS_SALE' AND ps.id = m.reference_id
         LEFT JOIN pos_returns pr ON m.reference_type = 'POS_RETURN' AND pr.id = m.reference_id
        WHERE m.shift_id = $1 ORDER BY m.created_at, m.id`,
      [id],
    );
    s.cash_summary = await tx.query(
      `SELECT movement_type, count(*)::int AS count, sum(amount) AS total FROM pos_cash_movements WHERE shift_id = $1 GROUP BY movement_type ORDER BY movement_type`,
      [id],
    );
    s.expected_cash_now = (await this.expectedCash(tx, id)).toFixed(2);
    s.sales_summary = await tx.one(
      `SELECT count(*)::int AS sale_count, COALESCE(sum(grand_total), 0) AS gross_sales, COALESCE(sum(discount_total), 0) AS discounts,
              COALESCE(sum(tax_total), 0) AS tax, COALESCE(sum(net_total), 0) AS net_sales, COALESCE(sum(refunded_total), 0) AS refunded_on_these_sales
         FROM pos_sales WHERE shift_id = $1`,
      [id],
    );
    s.by_payment_method = await tx.query(
      `SELECT m.code, m.name, p.kind, p.status, count(*)::int AS count, sum(p.amount) AS amount
         FROM pos_sale_payments p JOIN pos_sales x ON x.id = p.sale_id JOIN pos_payment_methods m ON m.id = p.method_id
        WHERE x.shift_id = $1 GROUP BY m.code, m.name, p.kind, p.status, m.sort_order ORDER BY m.sort_order`,
      [id],
    );
    s.refunds = await tx.one(
      `SELECT count(*)::int AS count, COALESCE(sum(refund_total), 0) AS total FROM pos_returns WHERE shift_id = $1`,
      [id],
    );
    return s;
  }
}
