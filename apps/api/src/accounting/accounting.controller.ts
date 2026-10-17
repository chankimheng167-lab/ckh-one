import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { MODULES, P } from '@ckh/shared';
import { z } from 'zod';
import { CurrentUser, RequireModules, RequirePermissions, TenantUser } from '../common/auth-context';
import { notFound } from '../common/errors';
import { isoDate, parse, uuid } from '../common/validation';
import { DatabaseService } from '../db/database.service';
import { InvoicingService } from '../sales/billing/invoicing.service';

/** Read side of receivables for accountants. Postings happen only through sales documents. */
@RequireModules(MODULES.ACCOUNTING)
@Controller('accounting')
export class AccountingController {
  constructor(private readonly db: DatabaseService, private readonly invoicing: InvoicingService) {}

  @Get('invoices')
  @RequirePermissions(P.SALES_INVOICES_CREATE)
  invoices(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(
      z.object({
        customerId: uuid.optional(),
        orderId: uuid.optional(),
        status: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      query,
    );
    return this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.query(
        `SELECT i.id, i.number, i.invoice_date, i.due_date, i.currency, i.grand_total, i.amount_paid, i.amount_credited,
                i.grand_total - i.amount_paid - i.amount_credited AS balance_due, i.status, c.name AS customer_name,
                o.number AS order_number, count(*) OVER () AS total_count
           FROM invoices i JOIN customers c ON c.id = i.customer_id LEFT JOIN sales_orders o ON o.id = i.sales_order_id
          WHERE ($1::uuid IS NULL OR i.customer_id = $1) AND ($2::uuid IS NULL OR i.sales_order_id = $2)
            AND ($3::text IS NULL OR i.status = ANY(string_to_array($3, ',')))
          ORDER BY i.invoice_date DESC, i.number DESC LIMIT $4 OFFSET $5`,
        [q.customerId ?? null, q.orderId ?? null, q.status ?? null, q.limit, q.offset],
      ),
    );
  }

  @Get('invoices/:id')
  @RequirePermissions(P.SALES_INVOICES_CREATE)
  invoice(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.invoicing.invoice(tx, id));
  }

  @Get('credit-notes')
  @RequirePermissions(P.SALES_INVOICES_CREATE)
  creditNotes(@CurrentUser() user: TenantUser) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.query(
        `SELECT cn.id, cn.number, cn.credit_date, cn.reason, cn.currency, cn.grand_total, cn.amount_applied, cn.status,
                c.name AS customer_name, o.number AS order_number
           FROM credit_notes cn JOIN customers c ON c.id = cn.customer_id LEFT JOIN sales_orders o ON o.id = cn.sales_order_id
          ORDER BY cn.credit_date DESC, cn.number DESC LIMIT 200`,
      ),
    );
  }

  @Get('journal-entries/:id')
  @RequirePermissions(P.SALES_INVOICES_CREATE)
  journal(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const je = await tx.maybeOne('SELECT * FROM journal_entries WHERE id = $1', [id]);
      if (!je) throw notFound('Journal entry');
      const lines = await tx.query(
        `SELECT a.code, a.name, l.debit, l.credit, l.description FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
          WHERE l.journal_entry_id = $1 ORDER BY l.debit DESC, a.code`,
        [id],
      );
      return { ...je, lines };
    });
  }

  /** Account balances (trial balance) up to a date. */
  @Get('trial-balance')
  @RequirePermissions(P.SALES_INVOICES_CREATE)
  trialBalance(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const { asOf } = parse(z.object({ asOf: isoDate.optional() }), query);
    return this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.query(
        `SELECT a.code, a.name, a.account_type,
                COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit,
                COALESCE(SUM(l.debit - l.credit), 0) AS balance
           FROM chart_of_accounts a
           LEFT JOIN (journal_lines l JOIN journal_entries e
                        ON e.id = l.journal_entry_id AND e.status = 'POSTED' AND ($1::date IS NULL OR e.entry_date <= $1))
             ON l.account_id = a.id
          GROUP BY a.id ORDER BY a.code`,
        [asOf ?? null],
      ),
    );
  }

  /** Receivables ageing per customer. */
  @Get('receivables')
  @RequirePermissions(P.SALES_CUSTOMERS_VIEW_BALANCE)
  receivables(@CurrentUser() user: TenantUser) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.query(
        `SELECT c.id AS customer_id, c.code, c.name, c.credit_limit, b.outstanding, b.overdue, b.oldest_due_date
           FROM customer_balances b JOIN customers c ON c.id = b.customer_id
          WHERE b.outstanding <> 0 ORDER BY b.overdue DESC, b.outstanding DESC`,
      ),
    );
  }
}
