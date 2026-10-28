import { Injectable } from '@nestjs/common';
import { Decimal, looksLikeCardNumber, P } from '@ckh/shared';
import { z } from 'zod';
import { has, TenantUser } from '../common/auth-context';
import { AuditService } from '../common/audit.service';
import { conflict, DomainError, forbidden, notFound } from '../common/errors';
import { positiveDecimal, uuid } from '../common/validation';
import type { Tx } from '../db/database.service';
import { JournalService } from '../accounting/journal.service';
import { PosContextService } from './pos-context.service';
import { clientKey } from './pos-schemas';

const D = (v: Decimal.Value) => new Decimal(v);

export const VerifyInput = z.object({
  decision: z.enum(['CONFIRM', 'REJECT']),
  /** What the bank statement or QR provider shows, e.g. the bank's transaction id. */
  providerTransactionId: z.string().trim().min(1).max(120).optional(),
  notes: z.string().trim().max(500).optional(),
});

export const SettleInput = z.object({
  clientPaymentId: clientKey,
  registerId: uuid,
  methodId: uuid,
  amount: positiveDecimal,
  reference: z.string().trim().min(1).max(120).optional(),
});

export const PendingQuery = z.object({
  branchId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const ReviewInput = z.object({ notes: z.string().trim().min(1).max(500) });

/**
 * Verification of transfer and QR payments, and settlement of what a
 * rejected payment left unpaid.
 *
 * At checkout an unverified payment is posted to "payments pending
 * verification". A verifier (never the cashier who took it) then either
 * confirms it, moving the amount to the method's bank account, or rejects
 * it: the money never arrived, so the amount moves to cash over and short
 * and the sale shows a balance due. When the customer later pays that
 * balance, the settlement reverses the shortage.
 */
@Injectable()
export class PosPaymentsService {
  constructor(
    private readonly ctx: PosContextService,
    private readonly journal: JournalService,
    private readonly audit: AuditService,
  ) {}

  async pending(tx: Tx, user: TenantUser, q: z.infer<typeof PendingQuery>) {
    if (q.branchId) await this.ctx.assertBranch(tx, user, q.branchId);
    const branches = await this.ctx.branchIds(tx, user);
    return tx.query(
      `SELECT p.id, p.amount, p.reference, p.provider_transaction_id, p.kind, p.created_at, p.is_settlement, m.name AS method_name,
              s.id AS sale_id, s.number AS sale_number, s.sold_at, s.currency, s.cashier_id, u.full_name AS cashier_name,
              g.code AS register_code, b.name AS branch_name
         FROM pos_sale_payments p JOIN pos_sales s ON s.id = p.sale_id JOIN pos_payment_methods m ON m.id = p.method_id
         JOIN users u ON u.id = s.cashier_id JOIN pos_registers g ON g.id = s.register_id JOIN branches b ON b.id = s.branch_id
        WHERE p.status = 'PENDING_VERIFICATION' AND ($1::uuid IS NULL OR s.branch_id = $1)
          AND ($2::uuid[] IS NULL OR s.branch_id = ANY($2::uuid[]))
        ORDER BY p.created_at LIMIT $3`,
      [q.branchId ?? null, branches, q.limit],
    );
  }

  async verify(tx: Tx, user: TenantUser, paymentId: string, i: z.infer<typeof VerifyInput>) {
    const p = await tx.maybeOne(
      `SELECT p.*, m.name AS method_name, m.account_id AS method_account_id FROM pos_sale_payments p
         JOIN pos_payment_methods m ON m.id = p.method_id WHERE p.id = $1 FOR UPDATE OF p`,
      [paymentId],
    );
    if (!p) throw notFound('Payment');
    const sale = await tx.one('SELECT * FROM pos_sales WHERE id = $1 FOR UPDATE', [p.sale_id]);
    await this.ctx.assertBranch(tx, user, sale.branch_id);
    if (p.status !== 'PENDING_VERIFICATION') {
      throw conflict('PAYMENT_ALREADY_VERIFIED', `This payment was already ${p.status === 'CONFIRMED' ? 'confirmed' : 'rejected'}`);
    }
    // Segregation of duties: whoever took the payment cannot confirm it.
    const takenBy = p.is_settlement ? p.received_by : sale.cashier_id;
    if (takenBy === user.userId) throw forbidden('Someone other than the cashier who took this payment must verify it');
    if (i.decision === 'REJECT' && !i.notes) throw new DomainError('NOTES_REQUIRED', 'Say why the payment is rejected', 422);
    if (i.providerTransactionId && looksLikeCardNumber(i.providerTransactionId)) {
      throw new DomainError('CARD_NUMBER_NOT_ALLOWED', 'Do not enter card numbers', 422);
    }

    const { pending: pendingAccount, overShort } = await this.accounts(tx);
    const accounts = await this.journal.accounts(tx);
    const amount = D(p.amount);
    const confirm = i.decision === 'CONFIRM';
    const target = confirm ? (p.method_account_id ?? p.account_id ?? accounts.bank) : overShort;
    const journalId = await this.journal.post(tx, {
      date: tx.today(),
      description: `${confirm ? 'Verified' : 'Rejected'} ${p.method_name} payment on POS sale ${sale.number}`,
      sourceType: confirm ? 'POS_PAYMENT_VERIFIED' : 'POS_PAYMENT_REJECTED',
      sourceId: p.id,
      lines: [
        { accountId: target, debit: amount, description: confirm ? p.method_name : 'Payment not received' },
        { accountId: pendingAccount, credit: amount, description: 'Payments pending verification' },
      ],
    });
    try {
      await tx.query(
        `UPDATE pos_sale_payments SET status = $2, verified_by = $3, verified_at = now(), verification_notes = $4,
                provider_transaction_id = COALESCE($5, provider_transaction_id), verification_journal_id = $6,
                account_id = CASE WHEN $7 THEN $8::uuid ELSE account_id END
          WHERE id = $1`,
        [p.id, confirm ? 'CONFIRMED' : 'REJECTED', user.userId, i.notes ?? null, i.providerTransactionId ?? null, journalId, confirm, target],
      );
    } catch (e: any) {
      if (e?.code === '23505') throw conflict('DUPLICATE_PAYMENT_REFERENCE', 'That transaction id is already recorded against another payment');
      throw e;
    }
    if (!confirm) await tx.query('UPDATE pos_sales SET amount_unpaid = amount_unpaid + $2 WHERE id = $1', [sale.id, amount.toFixed(2)]);
    const after = await this.refreshStatus(tx, sale.id);
    await this.audit.record(tx, {
      action: confirm ? 'POS_PAYMENT_VERIFIED' : 'POS_PAYMENT_REJECTED',
      entityType: 'pos_sale_payment',
      entityId: p.id,
      after: { sale: sale.number, amount: p.amount, method: p.method_name, notes: i.notes ?? null, paymentStatus: after.payment_status },
    });
    return { paymentId: p.id, status: confirm ? 'CONFIRMED' : 'REJECTED', sale: after };
  }

  /** Takes payment of a balance left by a rejected transfer or QR payment. */
  async settle(tx: Tx, user: TenantUser, saleId: string, i: z.infer<typeof SettleInput>) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`pos-settle:${tx.tenantId}:${i.clientPaymentId}`]);
    const existing = await tx.maybeOne('SELECT id, sale_id, method_id, amount_tendered FROM pos_sale_payments WHERE client_payment_id = $1', [i.clientPaymentId]);
    if (existing) {
      if (existing.sale_id !== saleId || existing.method_id !== i.methodId || !D(existing.amount_tendered).eq(i.amount)) {
        throw conflict('IDEMPOTENCY_CONFLICT', 'This payment id was already used for a different payment');
      }
      return { paymentId: existing.id, replayed: true, sale: await tx.one('SELECT * FROM pos_sales WHERE id = $1', [saleId]) };
    }
    const reg = await this.ctx.register(tx, user, i.registerId);
    const sale = await tx.maybeOne('SELECT * FROM pos_sales WHERE id = $1 FOR UPDATE', [saleId]);
    if (!sale) throw notFound('Sale');
    await this.ctx.assertBranch(tx, user, sale.branch_id);
    const unpaid = D(sale.amount_unpaid);
    if (unpaid.lte(0)) throw conflict('NOTHING_TO_SETTLE', `Sale ${sale.number} has no balance due`);
    const m = (await this.ctx.paymentMethods(tx)).find((x) => x.id === i.methodId);
    if (!m) throw new DomainError('PAYMENT_METHOD_INVALID', 'Payment method is not available', 422);
    if (m.requires_reference && !i.reference) throw new DomainError('REFERENCE_REQUIRED', `${m.name}: enter the reference`, 422);
    if (i.reference && looksLikeCardNumber(i.reference)) {
      throw new DomainError('CARD_NUMBER_NOT_ALLOWED', 'Do not enter card numbers. Enter the terminal approval code instead.', 422);
    }
    const tendered = D(i.amount);
    if (m.kind !== 'CASH' && tendered.gt(unpaid)) throw new DomainError('OVERPAYMENT', `Only ${unpaid.toFixed(2)} ${sale.currency} is due`, 422);
    const applied = Decimal.min(tendered, unpaid);
    const shift = await this.ctx.openShift(tx, reg.id, true);
    if (m.kind === 'CASH' && !shift) throw conflict('SHIFT_NOT_OPEN', `Open a shift on ${reg.name} to take cash`);
    if (shift && shift.cashier_id !== user.userId && !has(user, P.POS_SHIFT_APPROVE)) {
      throw forbidden('The open shift on this register belongs to another cashier');
    }

    const settings = await this.ctx.settings(tx);
    const { pending: pendingAccount, overShort } = await this.accounts(tx);
    const accounts = await this.journal.accounts(tx);
    const pending = m.requires_verification;
    const methodAccount = m.account_id ?? (m.kind === 'CASH' ? settings.cashAccountId ?? accounts.cash : accounts.bank);
    const lineNo = (await tx.one<{ n: number }>('SELECT COALESCE(max(line_no), 0)::int + 1 AS n FROM pos_sale_payments WHERE sale_id = $1', [sale.id])).n;
    let payment: { id: string };
    try {
      payment = await tx.one(
        `INSERT INTO pos_sale_payments (tenant_id, sale_id, method_id, kind, amount_tendered, amount, reference, status, account_id, line_no,
            is_settlement, client_payment_id, received_by, shift_id)
         VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11, $12) RETURNING id`,
        [sale.id, m.id, m.kind, tendered.toFixed(2), applied.toFixed(2), i.reference ?? null, pending ? 'PENDING_VERIFICATION' : 'CONFIRMED',
          methodAccount, lineNo, i.clientPaymentId, user.userId, shift?.id ?? null],
      );
    } catch (e: any) {
      if (e?.code === '23505') throw conflict('DUPLICATE_PAYMENT_REFERENCE', 'That reference is already recorded against another payment');
      throw e;
    }
    // The shortage booked on rejection is reversed by the money now received (or now pending verification).
    const journalId = await this.journal.post(tx, {
      date: tx.today(),
      description: `Balance paid on POS sale ${sale.number}`,
      sourceType: 'POS_SALE_SETTLEMENT',
      sourceId: payment.id,
      lines: [
        { accountId: pending ? pendingAccount : methodAccount, debit: applied, description: `${m.name}${pending ? ' (pending verification)' : ''}` },
        { accountId: overShort, credit: applied, description: 'Balance received' },
      ],
    });
    await tx.query('UPDATE pos_sale_payments SET journal_entry_id = $2 WHERE id = $1', [payment.id, journalId]);
    if (m.kind === 'CASH' && shift) {
      await tx.query(
        `INSERT INTO pos_cash_movements (tenant_id, shift_id, movement_type, amount, reference_type, reference_id, created_by)
         VALUES (current_tenant_id(), $1, 'SALE', $2, 'POS_SETTLEMENT', $3, $4)`,
        [shift.id, applied.toFixed(2), payment.id, user.userId],
      );
    }
    await tx.query('UPDATE pos_sales SET amount_unpaid = amount_unpaid - $2 WHERE id = $1', [sale.id, applied.toFixed(2)]);
    const after = await this.refreshStatus(tx, sale.id);
    await this.audit.record(tx, {
      action: 'POS_SALE_BALANCE_PAID',
      entityType: 'pos_sale',
      entityId: sale.id,
      after: { sale: sale.number, method: m.name, amount: applied.toFixed(2), change: tendered.minus(applied).toFixed(2) },
    });
    return { paymentId: payment.id, replayed: false, change: tendered.minus(applied).toFixed(2), sale: after };
  }

  /** Marks an offline sale the server flagged (price, stock, serial or total differences) as reviewed. */
  async review(tx: Tx, user: TenantUser, saleId: string, i: z.infer<typeof ReviewInput>) {
    const sale = await tx.maybeOne('SELECT * FROM pos_sales WHERE id = $1 FOR UPDATE', [saleId]);
    if (!sale) throw notFound('Sale');
    await this.ctx.assertBranch(tx, user, sale.branch_id);
    if (sale.review_status !== 'NEEDS_REVIEW') throw conflict('NOT_FLAGGED', `Sale ${sale.number} does not need review`);
    if (sale.cashier_id === user.userId) throw forbidden('Someone other than the cashier must review this sale');
    const after = await tx.one(
      `UPDATE pos_sales SET review_status = 'REVIEWED', reviewed_by = $2, reviewed_at = now(), review_notes = $3 WHERE id = $1 RETURNING *`,
      [sale.id, user.userId, i.notes],
    );
    await this.audit.record(tx, { action: 'POS_SALE_REVIEWED', entityType: 'pos_sale', entityId: sale.id, after: { notes: i.notes, reasons: sale.review_reasons } });
    return after;
  }

  private async accounts(tx: Tx) {
    const s = await this.ctx.settings(tx);
    if (!s.pendingPaymentAccountId || !s.cashOverShortAccountId) {
      throw new DomainError('POS_ACCOUNTS_MISSING', 'Set the pending-payments and cash over/short accounts in POS settings', 422);
    }
    return { pending: s.pendingPaymentAccountId, overShort: s.cashOverShortAccountId };
  }

  /** PAID, PENDING_VERIFICATION while anything waits, BALANCE_DUE while something is owed. */
  private async refreshStatus(tx: Tx, saleId: string) {
    return tx.one(
      `UPDATE pos_sales s SET payment_status = CASE
           WHEN s.amount_unpaid > 0 THEN 'BALANCE_DUE'
           WHEN EXISTS (SELECT 1 FROM pos_sale_payments p WHERE p.sale_id = s.id AND p.status = 'PENDING_VERIFICATION') THEN 'PENDING_VERIFICATION'
           ELSE 'PAID' END
        WHERE s.id = $1
        RETURNING id, number, payment_status, amount_unpaid, grand_total`,
      [saleId],
    );
  }
}
