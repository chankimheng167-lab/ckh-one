import { Injectable } from '@nestjs/common';
import { Decimal } from '@ckh/shared';
import type { Tx } from '../db/database.service';

/**
 * Stock level changes made by the sales module. Rows are always locked in
 * product-id order so concurrent documents cannot deadlock, and the
 * anti-oversell trigger on stock_levels is the final guard.
 */
@Injectable()
export class StockService {
  /** Ensures stock rows exist and locks them; returns available (on hand − reserved) per product. */
  async lock(tx: Tx, warehouseId: string, productIds: string[]): Promise<Map<string, { available: Decimal; avgCost: Decimal }>> {
    const ids = [...new Set(productIds)].sort();
    for (const pid of ids) {
      await tx.query(
        `INSERT INTO stock_levels (tenant_id, warehouse_id, product_id) VALUES (current_tenant_id(), $1, $2)
         ON CONFLICT (warehouse_id, product_id) DO NOTHING`,
        [warehouseId, pid],
      );
    }
    const rows = await tx.query<{ product_id: string; qty_on_hand: string; qty_reserved: string; avg_cost: string }>(
      `SELECT product_id, qty_on_hand, qty_reserved, avg_cost FROM stock_levels
        WHERE warehouse_id = $1 AND product_id = ANY($2::uuid[]) ORDER BY product_id FOR UPDATE`,
      [warehouseId, ids],
    );
    return new Map(rows.map((r) => [r.product_id, { available: Decimal.max(0, new Decimal(r.qty_on_hand).minus(r.qty_reserved)), avgCost: new Decimal(r.avg_cost) }]));
  }

  async reserve(tx: Tx, warehouseId: string, productId: string, qtyBase: Decimal.Value) {
    await tx.query('UPDATE stock_levels SET qty_reserved = qty_reserved + $3 WHERE warehouse_id = $1 AND product_id = $2', [warehouseId, productId, String(qtyBase)]);
  }

  /** Ships reserved goods out: on hand and reserved both drop. Returns the unit cost used for COGS. */
  async issueReserved(
    tx: Tx,
    m: { warehouseId: string; productId: string; qtyBase: Decimal; referenceType: string; referenceId: string; userId: string | null; notes?: string },
  ): Promise<Decimal> {
    const r = await tx.one<{ avg_cost: string }>(
      `UPDATE stock_levels SET qty_on_hand = qty_on_hand - $3, qty_reserved = qty_reserved - $3
        WHERE warehouse_id = $1 AND product_id = $2 RETURNING avg_cost`,
      [m.warehouseId, m.productId, m.qtyBase.toString()],
    );
    await this.movement(tx, { ...m, type: 'SALE_DELIVERY', qty: m.qtyBase.neg(), unitCost: new Decimal(r.avg_cost) });
    return new Decimal(r.avg_cost);
  }

  /**
   * Goods leave at the till without a reservation (POS). Rows must already be
   * locked with lock(). Returns the weighted-average unit cost used for COGS.
   */
  async issueDirect(
    tx: Tx,
    m: { warehouseId: string; productId: string; qtyBase: Decimal; referenceType: string; referenceId: string; userId: string | null; notes?: string },
  ): Promise<Decimal> {
    const r = await tx.one<{ avg_cost: string }>(
      `UPDATE stock_levels SET qty_on_hand = qty_on_hand - $3 WHERE warehouse_id = $1 AND product_id = $2 RETURNING avg_cost`,
      [m.warehouseId, m.productId, m.qtyBase.toString()],
    );
    await this.movement(tx, { ...m, type: 'POS_SALE', qty: m.qtyBase.neg(), unitCost: new Decimal(r.avg_cost) });
    return new Decimal(r.avg_cost);
  }

  /** Goods come back (undelivered or returned). Optionally re-reserved for the same order. */
  async receiveBack(
    tx: Tx,
    m: { warehouseId: string; productId: string; qtyBase: Decimal; unitCost: Decimal; reserve: boolean; referenceType: string; referenceId: string; userId: string | null; notes?: string; type?: 'SALE_RETURN' | 'POS_RETURN' },
  ) {
    await tx.query(
      `INSERT INTO stock_levels (tenant_id, warehouse_id, product_id) VALUES (current_tenant_id(), $1, $2)
       ON CONFLICT (warehouse_id, product_id) DO NOTHING`,
      [m.warehouseId, m.productId],
    );
    await tx.query(
      `UPDATE stock_levels SET
         avg_cost = CASE WHEN qty_on_hand + $3::numeric <= 0 THEN avg_cost
                         ELSE (GREATEST(qty_on_hand, 0) * avg_cost + $3::numeric * $4::numeric) / (GREATEST(qty_on_hand, 0) + $3::numeric) END,
         qty_on_hand = qty_on_hand + $3::numeric,
         qty_reserved = qty_reserved + CASE WHEN $5 THEN $3::numeric ELSE 0 END
       WHERE warehouse_id = $1 AND product_id = $2`,
      [m.warehouseId, m.productId, m.qtyBase.toString(), m.unitCost.toString(), m.reserve],
    );
    await this.movement(tx, { ...m, type: m.type ?? 'SALE_RETURN', qty: m.qtyBase, unitCost: m.unitCost });
  }

  private async movement(
    tx: Tx,
    m: { warehouseId: string; productId: string; type: string; qty: Decimal; unitCost: Decimal; referenceType: string; referenceId: string; userId: string | null; notes?: string },
  ) {
    await tx.query(
      `INSERT INTO stock_movements (tenant_id, warehouse_id, product_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [m.warehouseId, m.productId, m.type, m.qty.toString(), m.unitCost.toString(), m.referenceType, m.referenceId, m.notes ?? null, m.userId],
    );
  }
}
