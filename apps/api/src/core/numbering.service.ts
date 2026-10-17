import { Injectable } from '@nestjs/common';
import type { Tx } from '../db/database.service';

/**
 * Gap-free document numbers per tenant and document type. The sequence row
 * is locked for the rest of the transaction, so numbers are only consumed
 * when the document is actually committed.
 */
@Injectable()
export class NumberingService {
  async next(tx: Tx, docType: string, at: Date = new Date()): Promise<string> {
    const row = await tx.maybeOne<{ prefix: string; next_value: string; padding: number }>(
      `UPDATE document_sequences SET next_value = next_value + 1
        WHERE tenant_id = current_tenant_id() AND doc_type = $1
        RETURNING prefix, next_value - 1 AS next_value, padding`,
      [docType],
    );
    if (!row) {
      // Lazily create a sequence for document types added after provisioning.
      await tx.query(
        `INSERT INTO document_sequences (tenant_id, doc_type, prefix, next_value)
         VALUES (current_tenant_id(), $1, $2, 1) ON CONFLICT DO NOTHING`,
        [docType, `${docType.slice(0, 3)}-{YYYY}-`],
      );
      return this.next(tx, docType, at);
    }
    const prefix = row.prefix.replace('{YYYY}', String(at.getUTCFullYear()));
    return prefix + String(row.next_value).padStart(row.padding, '0');
  }
}
