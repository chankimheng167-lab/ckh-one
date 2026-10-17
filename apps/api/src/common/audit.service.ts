import { Injectable } from '@nestjs/common';
import type { Tx } from '../db/database.service';

/** Writes to the append-only audit_log inside the caller's transaction. */
@Injectable()
export class AuditService {
  async record(
    tx: Tx,
    entry: {
      actorType?: 'USER' | 'PLATFORM_ADMIN' | 'SYSTEM';
      actorId?: string | null;
      tenantId?: string | null;
      action: string;
      entityType: string;
      entityId?: string | null;
      before?: unknown;
      after?: unknown;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, before_data, after_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.tenantId ?? tx.tenantId,
        entry.actorType ?? 'USER',
        entry.actorId ?? tx.userId,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
      ],
    );
  }
}
