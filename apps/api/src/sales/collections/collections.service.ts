import { Injectable } from '@nestjs/common';
import { Decimal, P } from '@ckh/shared';
import { has, TenantUser } from '../../common/auth-context';
import { AuditService } from '../../common/audit.service';
import { conflict, DomainError, forbidden, notFound } from '../../common/errors';
import type { Tx } from '../../db/database.service';
import { JournalService } from '../../accounting/journal.service';
import { NumberingService } from '../../core/numbering.service';
import { InvoicingService } from '../billing/invoicing.service';
import { CommissionsService } from '../commissions/commissions.service';
import { SalesContextService } from '../sales-context.service';

const D = (v: Decimal.Value) => new Decimal(v);

export interface CollectionInput {
  clientReference?: string;
  customerId: string;
  invoiceId?: string;
  amount: string;
  currency?: string;
  paymentMethod: 'CASH' | 'BANK_TRANSFER' | 'KHQR' | 'MOBILE_WALLET' | 'CHEQUE' | 'CARD' | 'OTHER';
  paymentReference?: string;
  collectedOn?: string;
  receiptFileKey?: string;
  notes?: string;
}

/**
 * Field payment collections. A rep's submission is only a claim: it stays
 * PENDING_VERIFICATION and does not touch receivables or cash. An accountant
 * verifies it, which posts a customer receipt (Dr cash/bank, Cr AR) and
 * allocates it to invoices; or rejects it with a reason.
 */
@Injectable()
export class CollectionsService {
  constructor(
    private readonly ctx: SalesContextService,
    private readonly journal: JournalService,
    private readonly invoicing: InvoicingService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly commissions: CommissionsService,
  ) {}

  async submit(tx: Tx, user: TenantUser, input: CollectionInput, opts: { viaSync?: boolean } = {}) {
    if (input.clientReference) {
      const existing = await tx.maybeOne<{ id: string; created_by: string }>('SELECT id, created_by FROM sales_collection_submissions WHERE client_reference = $1', [input.clientReference]);
      if (existing) {
        if (existing.created_by !== user.userId) throw conflict('CLIENT_REFERENCE_IN_USE', 'clientReference already used by another user');
        return { collection: await this.get(tx, user, existing.id), replayed: true };
      }
    }
    const rep = await this.ctx.requireRep(tx, user);
    await this.ctx.assertCustomerAccess(tx, user, input.customerId);
    const tenant = await tx.one<{ base_currency: string }>('SELECT base_currency FROM tenants WHERE id = current_tenant_id()');
    let currency = input.currency ?? tenant.base_currency;
    if (input.invoiceId) {
      const inv = await tx.maybeOne<{ customer_id: string; currency: string; status: string; open: string }>(
        'SELECT customer_id, currency, status, grand_total - amount_paid - amount_credited AS open FROM invoices WHERE id = $1',
        [input.invoiceId],
      );
      if (!inv || inv.customer_id !== input.customerId) throw new DomainError('INVOICE_INVALID', 'Invoice does not belong to this customer', 422);
      if (!['ISSUED', 'PARTIALLY_PAID'].includes(inv.status)) throw conflict('INVOICE_NOT_OPEN', `Invoice is ${inv.status.toLowerCase()}`);
      if (input.currency && input.currency !== inv.currency) throw new DomainError('CURRENCY_MISMATCH', `Invoice is in ${inv.currency}`, 422);
      currency = inv.currency;
      if (D(input.amount).gt(inv.open)) throw new DomainError('AMOUNT_EXCEEDS_BALANCE', `Invoice balance is ${inv.open} ${inv.currency}`, 422, { balance: inv.open });
    }
    const number = await this.numbering.next(tx, 'COLLECTION');
    const c = await tx.one<{ id: string }>(
      `INSERT INTO sales_collection_submissions (tenant_id, number, customer_id, sales_rep_id, invoice_id, amount, currency, payment_method,
          payment_reference, collected_on, receipt_file_key, notes, client_reference, created_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::date, CURRENT_DATE), $10, $11, $12, $13) RETURNING id`,
      [number, input.customerId, rep.id, input.invoiceId ?? null, input.amount, currency, input.paymentMethod, input.paymentReference ?? null,
        input.collectedOn ?? null, input.receiptFileKey ?? null, input.notes ?? null, input.clientReference ?? null, user.userId],
    );
    await this.audit.record(tx, { action: 'COLLECTION_SUBMITTED', entityType: 'sales_collection', entityId: c.id, after: { number, amount: input.amount, currency, viaSync: !!opts.viaSync } });
    return { collection: await this.get(tx, user, c.id), replayed: false };
  }

  async verify(tx: Tx, user: TenantUser, id: string, input: { depositTo?: 'CASH' | 'BANK'; receiptDate?: string; comment?: string }) {
    const c = await this.lockPending(tx, id);
    if (c.created_by === user.userId) throw forbidden('You cannot verify a collection you submitted');
    const acc = await this.journal.accounts(tx);
    const deposit = (input.depositTo ?? (c.payment_method === 'CASH' ? 'CASH' : 'BANK')) === 'CASH' ? acc.cash : acc.bank;
    const receiptDate = input.receiptDate ?? tx.today();

    const number = await this.numbering.next(tx, 'RECEIPT');
    const rc = await tx.one<{ id: string }>(
      `INSERT INTO customer_receipts (tenant_id, number, customer_id, receipt_date, amount, currency, payment_method, payment_reference,
          deposit_account_id, collection_id, created_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [number, c.customer_id, receiptDate, c.amount, c.currency, c.payment_method, c.payment_reference, deposit, c.id, user.userId],
    );

    // Allocate: the named invoice first, then the customer's oldest open invoices in the same currency.
    let left = D(c.amount);
    const invoices = await tx.query<{ id: string; open: string }>(
      `SELECT id, grand_total - amount_paid - amount_credited AS open FROM invoices
        WHERE customer_id = $1 AND currency = $2 AND status IN ('ISSUED', 'PARTIALLY_PAID')
        ORDER BY (id = $3) DESC, due_date, number FOR UPDATE`,
      [c.customer_id, c.currency, c.invoice_id],
    );
    const touched: string[] = [];
    for (const inv of invoices) {
      if (left.lte(0)) break;
      const amt = Decimal.min(left, inv.open);
      if (amt.lte(0)) continue;
      await tx.query('INSERT INTO receipt_allocations (tenant_id, receipt_id, invoice_id, amount) VALUES (current_tenant_id(), $1, $2, $3)', [rc.id, inv.id, amt.toFixed(2)]);
      await tx.query('UPDATE invoices SET amount_paid = amount_paid + $2 WHERE id = $1', [inv.id, amt.toFixed(2)]);
      touched.push(inv.id);
      left = left.minus(amt);
    }
    await this.invoicing.refreshInvoiceStatuses(tx, touched);
    await tx.query('UPDATE customer_receipts SET amount_allocated = $2 WHERE id = $1', [rc.id, D(c.amount).minus(left).toFixed(2)]);

    const je = await this.journal.post(tx, {
      date: receiptDate,
      description: `Receipt ${number} from collection ${c.number}`,
      sourceType: 'RECEIPT',
      sourceId: rc.id,
      lines: [
        { accountId: deposit, debit: c.amount, description: c.payment_method },
        { accountId: acc.ar, credit: c.amount, customerId: c.customer_id, description: 'Accounts receivable' },
      ],
    });
    await tx.query('UPDATE customer_receipts SET journal_entry_id = $2 WHERE id = $1', [rc.id, je]);
    await tx.query(
      `UPDATE sales_collection_submissions SET status = 'VERIFIED', verified_by = $2, verified_at = now(), customer_receipt_id = $3,
              notes = COALESCE(notes || E'\\n', '') || COALESCE($4, '') WHERE id = $1`,
      [id, user.userId, rc.id, input.comment ?? null],
    );
    await this.commissions.onReceipt(tx, rc.id);
    await this.audit.record(tx, { action: 'COLLECTION_VERIFIED', entityType: 'sales_collection', entityId: id, after: { receipt: number, allocated: D(c.amount).minus(left).toFixed(2), unallocated: left.toFixed(2) } });
    await this.invoicing.autoCloseSettledOrders(tx, touched, user.userId);
    return this.get(tx, user, id);
  }

  async reject(tx: Tx, user: TenantUser, id: string, reason: string) {
    const c = await this.lockPending(tx, id);
    if (c.created_by === user.userId) throw forbidden('You cannot reject a collection you submitted');
    await tx.query(
      `UPDATE sales_collection_submissions SET status = 'REJECTED', verified_by = $2, verified_at = now(), rejection_reason = $3 WHERE id = $1`,
      [id, user.userId, reason],
    );
    await this.audit.record(tx, { action: 'COLLECTION_REJECTED', entityType: 'sales_collection', entityId: id, after: { reason } });
    return this.get(tx, user, id);
  }

  async get(tx: Tx, user: TenantUser, id: string) {
    const [pred, params] = await this.scope(tx, user, 2);
    const c = await tx.maybeOne(
      `SELECT s.*, c.name AS customer_name, c.code AS customer_code, i.number AS invoice_number, u.full_name AS sales_rep_name,
              vu.full_name AS verified_by_name, r.number AS receipt_number
         FROM sales_collection_submissions s
         JOIN customers c ON c.id = s.customer_id
         JOIN sales_representatives sr ON sr.id = s.sales_rep_id JOIN users u ON u.id = sr.user_id
         LEFT JOIN invoices i ON i.id = s.invoice_id
         LEFT JOIN users vu ON vu.id = s.verified_by
         LEFT JOIN customer_receipts r ON r.id = s.customer_receipt_id
        WHERE s.id = $1 AND ${pred}`,
      [id, ...params],
    );
    if (!c) throw notFound('Collection');
    return c;
  }

  async list(tx: Tx, user: TenantUser, q: { status?: string; customerId?: string; limit: number; offset: number }) {
    const [pred, scopeParams] = await this.scope(tx, user, 1);
    const params: unknown[] = [...scopeParams];
    const where = [pred];
    if (q.status) { params.push(q.status); where.push(`s.status = $${params.length}`); }
    if (q.customerId) { params.push(q.customerId); where.push(`s.customer_id = $${params.length}`); }
    params.push(q.limit, q.offset);
    return tx.query(
      `SELECT s.id, s.number, s.status, s.amount, s.currency, s.payment_method, s.payment_reference, s.collected_on, s.created_at,
              s.rejection_reason, c.name AS customer_name, i.number AS invoice_number, u.full_name AS sales_rep_name, count(*) OVER () AS total_count
         FROM sales_collection_submissions s
         JOIN customers c ON c.id = s.customer_id
         JOIN sales_representatives sr ON sr.id = s.sales_rep_id JOIN users u ON u.id = sr.user_id
         LEFT JOIN invoices i ON i.id = s.invoice_id
        WHERE ${where.join(' AND ')}
        ORDER BY s.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
  }

  /** Accountants see all; supervisors their team's; reps their own. */
  private async scope(tx: Tx, user: TenantUser, start: number): Promise<[string, unknown[]]> {
    if (has(user, P.SALES_COLLECTIONS_VERIFY) || has(user, P.SALES_ORDERS_VIEW_ALL)) return ['TRUE', []];
    const rep = await this.ctx.repForUser(tx, user.userId);
    const teams = has(user, P.SALES_ORDERS_VIEW_TEAM) ? await this.ctx.managedTeamIds(tx, user.userId) : [];
    return [
      `(s.sales_rep_id = $${start} OR s.sales_rep_id IN (SELECT id FROM sales_representatives WHERE team_id = ANY($${start + 1}::uuid[])))`,
      [rep?.id ?? null, teams],
    ];
  }

  private async lockPending(tx: Tx, id: string) {
    const c = await tx.maybeOne<{ id: string; number: string; status: string; customer_id: string; invoice_id: string | null; amount: string; currency: string; payment_method: string; payment_reference: string | null; created_by: string }>(
      `SELECT id, number, status, customer_id, invoice_id, amount, currency, payment_method, payment_reference, created_by
         FROM sales_collection_submissions WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!c) throw notFound('Collection');
    if (c.status !== 'PENDING_VERIFICATION') throw conflict('COLLECTION_ALREADY_DECIDED', `Collection ${c.number} is already ${c.status.toLowerCase()}`);
    return c;
  }
}
