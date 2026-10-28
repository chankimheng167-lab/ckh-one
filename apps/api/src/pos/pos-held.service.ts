import { Injectable } from '@nestjs/common';
import { P } from '@ckh/shared';
import { z } from 'zod';
import { has, TenantUser } from '../common/auth-context';
import { AuditService } from '../common/audit.service';
import { conflict, forbidden, notFound } from '../common/errors';
import type { Tx } from '../db/database.service';
import { PosContextService } from './pos-context.service';
import { PosCartInput } from './pos-schemas';
import { PosSalesService } from './pos-sales.service';

export const HoldInput = z.object({
  label: z.string().trim().min(1).max(80),
  cart: PosCartInput,
});

/**
 * Parked carts: a cashier holds a sale (customer went to fetch something),
 * serves the next customer, and resumes it later. A held cart is not a sale:
 * no stock moves and nothing is posted until it is checked out.
 */
@Injectable()
export class PosHeldService {
  constructor(private readonly ctx: PosContextService, private readonly sales: PosSalesService, private readonly audit: AuditService) {}

  async hold(tx: Tx, user: TenantUser, i: z.infer<typeof HoldInput>) {
    const reg = await this.ctx.register(tx, user, i.cart.registerId);
    // Price it now so the list can show an estimate (prices are re-checked at checkout).
    await tx.query('SAVEPOINT pos_hold_price');
    const priced = await this.sales.price(tx, user, i.cart).catch(async () => {
      await tx.query('ROLLBACK TO SAVEPOINT pos_hold_price');
      return null;
    });
    const shift = await this.ctx.openShift(tx, reg.id);
    const h = await tx.one(
      `INSERT INTO pos_held_sales (tenant_id, register_id, shift_id, held_by, label, customer_id, cart, item_count, estimated_total)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [reg.id, shift?.id ?? null, user.userId, i.label, i.cart.customerId ?? null, JSON.stringify(i.cart), i.cart.lines.length, priced?.cart.grandTotal ?? null],
    );
    await this.audit.record(tx, { action: 'POS_SALE_HELD', entityType: 'pos_held_sale', entityId: h.id, after: { label: i.label, items: i.cart.lines.length } });
    return h;
  }

  async list(tx: Tx, user: TenantUser, registerId: string, status: 'HELD' | 'RESUMED' | 'CANCELLED' = 'HELD') {
    await this.ctx.register(tx, user, registerId, { allowInactive: true });
    return tx.query(
      `SELECT h.id, h.label, h.status, h.item_count, h.estimated_total, h.created_at, h.closed_at, h.cancel_reason, h.cart,
              u.full_name AS held_by_name, c.name AS customer_name
         FROM pos_held_sales h JOIN users u ON u.id = h.held_by LEFT JOIN customers c ON c.id = h.customer_id
        WHERE h.register_id = $1 AND h.status = $2 ORDER BY h.created_at DESC LIMIT 200`,
      [registerId, status],
    );
  }

  private async lock(tx: Tx, user: TenantUser, id: string) {
    const h = await tx.maybeOne('SELECT * FROM pos_held_sales WHERE id = $1 FOR UPDATE', [id]);
    if (!h) throw notFound('Held sale');
    await this.ctx.register(tx, user, h.register_id, { allowInactive: true });
    if (h.status !== 'HELD') throw conflict('HELD_SALE_CLOSED', `This held sale was already ${h.status.toLowerCase()}`);
    return h;
  }

  /** Takes the cart back to the till (once); the till then checks it out normally. */
  async resume(tx: Tx, user: TenantUser, id: string) {
    const h = await this.lock(tx, user, id);
    await tx.query(`UPDATE pos_held_sales SET status = 'RESUMED', resumed_by = $2, closed_at = now() WHERE id = $1`, [id, user.userId]);
    await this.audit.record(tx, { action: 'POS_SALE_RESUMED', entityType: 'pos_held_sale', entityId: id });
    return { id, label: h.label, cart: h.cart };
  }

  /** Cancels a held sale. Someone else's needs a supervisor. */
  async cancel(tx: Tx, user: TenantUser, id: string, reason: string) {
    const h = await this.lock(tx, user, id);
    if (h.held_by !== user.userId && !has(user, P.POS_SHIFT_APPROVE)) throw forbidden('Only the cashier who held it or a supervisor can cancel it');
    await tx.query(`UPDATE pos_held_sales SET status = 'CANCELLED', cancelled_by = $2, cancel_reason = $3, closed_at = now() WHERE id = $1`, [id, user.userId, reason]);
    await this.audit.record(tx, { action: 'POS_HELD_SALE_CANCELLED', entityType: 'pos_held_sale', entityId: id, after: { reason, label: h.label, items: h.item_count } });
    return { id, status: 'CANCELLED' };
  }
}
