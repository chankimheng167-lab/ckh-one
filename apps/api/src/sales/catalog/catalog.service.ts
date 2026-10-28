import { Injectable } from '@nestjs/common';
import type { TenantUser } from '../../common/auth-context';
import { notFound } from '../../common/errors';
import type { Tx } from '../../db/database.service';
import { PricingService } from '../pricing.service';
import { SalesContextService } from '../sales-context.service';

@Injectable()
export class CatalogService {
  constructor(
    private readonly ctx: SalesContextService,
    private readonly pricing: PricingService,
  ) {}

  /**
   * Product search for reps. Stock is shown only for warehouses the user is
   * authorised for. When customerId is given, the customer-specific price is
   * resolved on the server (and the customer must be visible to the user).
   */
  async search(tx: Tx, user: TenantUser, q: { search?: string; categoryId?: string; customerId?: string; limit: number; offset: number }) {
    if (q.customerId) await this.ctx.assertCustomerAccess(tx, user, q.customerId);
    const warehouses = await this.ctx.authorizedWarehouseIds(tx, user);
    const params: unknown[] = [warehouses];
    const where = [`p.status = 'ACTIVE'`, 'p.is_sellable'];
    if (q.search) {
      params.push(`%${q.search.toLowerCase()}%`, q.search);
      where.push(`(lower(p.name) LIKE $${params.length - 1} OR lower(p.sku) LIKE $${params.length - 1} OR p.barcode = $${params.length})`);
    }
    if (q.categoryId) {
      params.push(q.categoryId);
      where.push(`p.category_id = $${params.length}`);
    }
    params.push(q.limit, q.offset);
    const rows = await tx.query(
      `SELECT p.id, p.sku, p.barcode, p.name, p.name_local, p.image_urls, p.list_price, p.category_id,
              pc.name AS category_name, u.code AS unit_code, p.base_unit_id, p.parent_product_id, p.variant_attributes,
              p.track_inventory,
              COALESCE((SELECT json_agg(json_build_object('warehouseId', w.id, 'warehouse', w.name,
                         'available', GREATEST(s.qty_on_hand - s.qty_reserved, 0)) ORDER BY w.name)
                  FROM stock_levels s JOIN warehouses w ON w.id = s.warehouse_id
                 WHERE s.product_id = p.id AND s.warehouse_id = ANY($1::uuid[])), '[]') AS stock,
              now() AS stock_as_of,
              count(*) OVER () AS total_count
         FROM products p
         JOIN units u ON u.id = p.base_unit_id
         LEFT JOIN product_categories pc ON pc.id = p.category_id
        WHERE ${where.join(' AND ')}
        ORDER BY p.name
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    if (q.customerId && rows.length) {
      const pctx = await this.pricing.customerContext(tx, q.customerId);
      const today = tx.today();
      for (const r of rows) {
        const price = await this.pricing.resolve(tx, pctx, r.id, null, '1', today);
        Object.assign(r, { customer_price: price.unitPrice, price_source: price.priceSource, currency: pctx.currency, tax_rate_percent: price.taxRatePercent });
      }
    }
    return rows;
  }

  async details(tx: Tx, user: TenantUser, productId: string, customerId?: string) {
    const warehouses = await this.ctx.authorizedWarehouseIds(tx, user);
    const p = await tx.maybeOne(
      `SELECT p.*, pc.name AS category_name, u.code AS unit_code, t.rate_percent AS tax_rate_percent
         FROM products p JOIN units u ON u.id = p.base_unit_id
         LEFT JOIN product_categories pc ON pc.id = p.category_id
         LEFT JOIN tax_codes t ON t.id = p.tax_code_id
        WHERE p.id = $1 AND p.status = 'ACTIVE'`,
      [productId],
    );
    if (!p) throw notFound('Product');
    delete p.cost_price; // reps never see cost
    const units = await tx.query(
      `SELECT pu.unit_id, u.code, u.name, pu.factor FROM product_uoms pu JOIN units u ON u.id = pu.unit_id WHERE pu.product_id = $1`,
      [productId],
    );
    const variants = await tx.query(
      `SELECT id, sku, name, variant_attributes, list_price FROM products WHERE parent_product_id = $1 AND status = 'ACTIVE' ORDER BY sku`,
      [productId],
    );
    const stock = await tx.query(
      `SELECT w.id AS warehouse_id, w.name AS warehouse, GREATEST(s.qty_on_hand - s.qty_reserved, 0) AS available, s.updated_at
         FROM stock_levels s JOIN warehouses w ON w.id = s.warehouse_id
        WHERE s.product_id = $1 AND s.warehouse_id = ANY($2::uuid[]) ORDER BY w.name`,
      [productId, warehouses],
    );
    const promotions = await tx.query(
      `SELECT id, code, name, promo_type, value, min_quantity, valid_to FROM promotions
        WHERE is_active AND now() BETWEEN valid_from AND valid_to
          AND (product_id = $1 OR (product_id IS NULL AND category_id = $2))`,
      [productId, p.category_id],
    );
    let customerPrice = null;
    if (customerId) {
      await this.ctx.assertCustomerAccess(tx, user, customerId);
      const pctx = await this.pricing.customerContext(tx, customerId);
      customerPrice = await this.pricing.resolve(tx, pctx, productId, null, '1', tx.today());
    }
    return { ...p, units, variants, stock, stockAsOf: new Date().toISOString(), promotions, customerPrice };
  }
}
