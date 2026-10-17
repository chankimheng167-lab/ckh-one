import { Injectable } from '@nestjs/common';
import { Decimal } from '@ckh/shared';
import { DomainError } from '../common/errors';
import type { Tx } from '../db/database.service';
import { NumberingService } from '../core/numbering.service';

export interface AccountMap {
  ar: string;
  revenue: string;
  salesDiscount: string;
  vatOutput: string;
  cogs: string;
  inventory: string;
  cash: string;
  bank: string;
  commissionExpense: string;
  commissionPayable: string;
  revenueRecognition: 'ON_INVOICE' | 'ON_DELIVERY';
}

export interface JournalLineInput {
  accountId: string;
  debit?: Decimal.Value;
  credit?: Decimal.Value;
  customerId?: string | null;
  description?: string;
}

/**
 * The single way sales documents reach the general ledger. Every entry is
 * checked to balance here and again by a deferred database trigger, so an
 * unbalanced posting can never be committed.
 */
@Injectable()
export class JournalService {
  constructor(private readonly numbering: NumberingService) {}

  async accounts(tx: Tx): Promise<AccountMap> {
    const s = await tx.maybeOne(
      `SELECT ar_account_id, revenue_account_id, sales_discount_account_id, vat_output_account_id, cogs_account_id,
              inventory_account_id, cash_account_id, bank_account_id, commission_expense_account_id,
              commission_payable_account_id, revenue_recognition
         FROM accounting_settings WHERE tenant_id = current_tenant_id()`,
    );
    if (!s) throw new DomainError('ACCOUNTING_NOT_CONFIGURED', 'Accounting settings are missing for this company', 422);
    return {
      ar: s.ar_account_id,
      revenue: s.revenue_account_id,
      salesDiscount: s.sales_discount_account_id,
      vatOutput: s.vat_output_account_id,
      cogs: s.cogs_account_id,
      inventory: s.inventory_account_id,
      cash: s.cash_account_id,
      bank: s.bank_account_id,
      commissionExpense: s.commission_expense_account_id,
      commissionPayable: s.commission_payable_account_id,
      revenueRecognition: s.revenue_recognition,
    };
  }

  /** Posts a balanced entry. Zero lines are dropped; returns null when nothing is left to post. */
  async post(
    tx: Tx,
    entry: { date: string; description: string; sourceType: string; sourceId: string; lines: JournalLineInput[] },
  ): Promise<string | null> {
    const lines = entry.lines
      .map((l) => ({ ...l, debit: new Decimal(l.debit ?? 0).toDecimalPlaces(2), credit: new Decimal(l.credit ?? 0).toDecimalPlaces(2) }))
      .filter((l) => !l.debit.isZero() || !l.credit.isZero());
    if (lines.length === 0) return null;
    for (const l of lines) {
      if (!l.accountId) throw new DomainError('ACCOUNTING_NOT_CONFIGURED', `No ledger account configured for: ${l.description ?? entry.description}`, 422);
      if (l.debit.isNeg() || l.credit.isNeg()) throw new Error('Journal amounts must not be negative');
    }
    const dr = lines.reduce((a, l) => a.plus(l.debit), new Decimal(0));
    const cr = lines.reduce((a, l) => a.plus(l.credit), new Decimal(0));
    if (!dr.eq(cr)) throw new Error(`Journal for ${entry.sourceType} ${entry.sourceId} does not balance: ${dr} vs ${cr}`);

    const number = await this.numbering.next(tx, 'JOURNAL');
    const je = await tx.one<{ id: string }>(
      `INSERT INTO journal_entries (tenant_id, number, entry_date, description, source_type, source_id, created_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6) RETURNING id`,
      [number, entry.date, entry.description, entry.sourceType, entry.sourceId, tx.userId],
    );
    for (const l of lines) {
      // A line carries either a debit or a credit; split mixed lines.
      for (const [d, c] of [[l.debit, new Decimal(0)], [new Decimal(0), l.credit]] as const) {
        if (d.isZero() && c.isZero()) continue;
        await tx.query(
          `INSERT INTO journal_lines (tenant_id, journal_entry_id, account_id, debit, credit, customer_id, description)
           VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6)`,
          [je.id, l.accountId, d.toFixed(2), c.toFixed(2), l.customerId ?? null, l.description ?? null],
        );
      }
    }
    return je.id;
  }
}
