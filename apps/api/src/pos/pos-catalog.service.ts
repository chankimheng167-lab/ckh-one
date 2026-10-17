import { Injectable } from '@nestjs/common';
import { Decimal } from '@ckh/shared';
import type { TenantUser } from '../common/auth-context';
import { conflict, DomainError, notFound } from '../common/errors';
import type { Tx } from '../db/database.service';
import { CustomerPricingContext, PricingService } from '../sales/pricing.service';
import { PosContextService } from './pos-context.service';

/** Unit prices are shown with the same 4 decimals as the price list. */
const px = (v: string) => new Decimal(v).toFixed(4);

export interface CatalogQuery {
  registerId: string;
  q?: string;
  categoryId?: string;
  customerId?: string;
  limit: number;
  offset: number;
}

/**
 * Product lookup for the till: the shared product master, priced on the
 * server for the selected customer (or walk-in), with stock in the register's
 * warehouse. Products that have variants are listed once; their variants
 * (size, colour…) come from the product endpoint.
 */
@Injectable()
export class PosCatalogService {
  constructor(private readonly ctx: PosContextService, private readonly pricing: PricingService) {}

  async pricingContext(tx: Tx, customerId: string | null | undefined): Promise<CustomerPricingContext> {
    return customerId ? this.pricing.customerContext(tx, customerId) : this.ctx.walkInPricing(tx);
  }

  async search(tx: Tx, user: TenantUser, q: CatalogQuery) {
    const reg = await this.ctx.register(tx, user, q.registerId);
    const params: unknown[] = [reg.warehouse_id];
    const where = [`p.status = 'ACTIVE'`, 'p.is_sellable', 'p.parent_product_id IS NULL'];
    if (q.q) {
      params.push(`%${q.q.toLowerCase()}%`, q.q);
      const like = `$${params.length - 1}`;
      const exact = `$${params.length}`;
      where.push(`(lower(p.name) LIKE ${like} OR lower(p.sku) LIKE ${like} OR lower(coalesce(p.name_local, '')) LIKE ${like} OR p.barcode = ${exact}
                   OR EXISTS (SELECT 1 FROM products v WHERE v.parent_product_id = p.id AND v.status = 'ACTIVE' AND (v.barcode = ${exact} OR lower(v.sku) LIKE ${like})))`);
    }
    if (q.categoryId) {
      params.push(q.categoryId);
      where.push(`p.category_id = $${params.length}`);
    }
    params.push(q.limit, q.offset);
    const rows = await tx.query(
      `SELECT p.id, p.sku, p.barcode, p.name, p.name_local, p.image_urls, p.category_id, pc.name AS category_name,
              p.track_inventory, p.product_type, p.serial_tracked, p.reorder_point,
              (SELECT count(*)::int FROM products v WHERE v.parent_product_id = p.id AND v.status = 'ACTIVE' AND v.is_sellable) AS variant_count,
              s.qty_on_hand, GREATEST(COALESCE(s.qty_on_hand, 0) - COALESCE(s.qty_reserved, 0), 0) AS available,
              count(*) OVER () AS total_count
         FROM products p
         LEFT JOIN product_categories pc ON pc.id = p.category_id
         LEFT JOIN stock_levels s ON s.product_id = p.id AND s.warehouse_id = $1
        WHERE ${where.join(' AND ')}
        ORDER BY p.name
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const pctx = await this.pricingContext(tx, q.customerId);
    const today = tx.today();
    for (const r of rows) {
      if (r.variant_count > 0) {
        const range = await tx.one<{ min: string | null; max: string | null; available: string | null }>(
          `SELECT min(v.list_price) AS min, max(v.list_price) AS max,
                  sum(GREATEST(COALESCE(s.qty_on_hand, 0) - COALESCE(s.qty_reserved, 0), 0)) AS available
             FROM products v LEFT JOIN stock_levels s ON s.product_id = v.id AND s.warehouse_id = $2
            WHERE v.parent_product_id = $1 AND v.status = 'ACTIVE' AND v.is_sellable`,
          [r.id, reg.warehouse_id],
        );
        Object.assign(r, { price: null, price_from: range.min, price_to: range.max, available: range.available ?? '0', currency: pctx.currency });
      } else {
        const price = await this.pricing.resolve(tx, pctx, r.id, null, '1', today);
        Object.assign(r, { price: px(price.unitPrice), price_source: price.priceSource, tax_rate_percent: price.taxRatePercent, currency: pctx.currency });
      }
      r.low_stock = this.isLow(r);
    }
    return { registerId: reg.id, warehouseId: reg.warehouse_id, stockAsOf: new Date().toISOString(), items: rows };
  }

  /** One product with its variants (each priced and with stock). */
  async product(tx: Tx, user: TenantUser, productId: string, registerId: string, customerId?: string) {
    const reg = await this.ctx.register(tx, user, registerId);
    const p = await tx.maybeOne(
      `SELECT p.id, p.sku, p.barcode, p.name, p.name_local, p.description, p.image_urls, p.category_id, p.track_inventory, p.product_type,
              p.serial_tracked, p.reorder_point, p.variant_attributes, p.parent_product_id
         FROM products p WHERE p.id = $1 AND p.status = 'ACTIVE'`,
      [productId],
    );
    if (!p) throw notFound('Product');
    const pctx = await this.pricingContext(tx, customerId);
    const today = tx.today();
    const variants = await tx.query(
      `SELECT v.id, v.sku, v.barcode, v.name, v.variant_attributes, v.image_urls, v.track_inventory, v.serial_tracked, v.reorder_point,
              s.qty_on_hand, GREATEST(COALESCE(s.qty_on_hand, 0) - COALESCE(s.qty_reserved, 0), 0) AS available
         FROM products v LEFT JOIN stock_levels s ON s.product_id = v.id AND s.warehouse_id = $2
        WHERE v.parent_product_id = $1 AND v.status = 'ACTIVE' AND v.is_sellable ORDER BY v.sku`,
      [productId, reg.warehouse_id],
    );
    for (const v of variants) {
      const price = await this.pricing.resolve(tx, pctx, v.id, null, '1', today);
      Object.assign(v, { price: px(price.unitPrice), price_source: price.priceSource, tax_rate_percent: price.taxRatePercent, low_stock: this.isLow(v) });
    }
    // Attribute options (e.g. size: [S, M, L], colour: [Red, Blue]) for the picker.
    const options: Record<string, string[]> = {};
    for (const v of variants) {
      for (const [k, val] of Object.entries((v.variant_attributes ?? {}) as Record<string, unknown>)) {
        const list = (options[k] ??= []);
        if (!list.includes(String(val))) list.push(String(val));
      }
    }
    const stock = await tx.maybeOne(
      `SELECT qty_on_hand, GREATEST(qty_on_hand - qty_reserved, 0) AS available FROM stock_levels WHERE product_id = $1 AND warehouse_id = $2`,
      [productId, reg.warehouse_id],
    );
    const own = variants.length ? null : await this.pricing.resolve(tx, pctx, productId, null, '1', today);
    // Branch stock elsewhere, so the cashier can tell a customer where to find it.
    const elsewhere = await tx.query(
      `SELECT w.id AS warehouse_id, w.name AS warehouse, GREATEST(s.qty_on_hand - s.qty_reserved, 0) AS available
         FROM stock_levels s JOIN warehouses w ON w.id = s.warehouse_id
        WHERE s.product_id = ANY($1::uuid[]) AND s.warehouse_id <> $2 AND w.is_active AND s.qty_on_hand > s.qty_reserved
        ORDER BY w.name`,
      [[productId, ...variants.map((v) => v.id)], reg.warehouse_id],
    );
    return {
      ...p,
      currency: pctx.currency,
      price: own ? px(own.unitPrice) : null,
      price_source: own?.priceSource ?? null,
      tax_rate_percent: own?.taxRatePercent ?? null,
      qty_on_hand: stock?.qty_on_hand ?? '0',
      available: stock?.available ?? '0',
      low_stock: this.isLow({ ...p, qty_on_hand: stock?.qty_on_hand }),
      variants,
      variant_options: options,
      other_warehouses: elsewhere,
      stockAsOf: new Date().toISOString(),
    };
  }

  /**
   * Barcode scan: product barcode, a pack barcode (product_uoms, sold as that
   * many base units), or an exact SKU. Two active products with the same code
   * are reported rather than guessed.
   */
  async scan(tx: Tx, user: TenantUser, code: string, registerId: string, customerId?: string) {
    const reg = await this.ctx.register(tx, user, registerId);
    let hits = await tx.query<{ id: string; quantity: string }>(
      `SELECT id, '1' AS quantity FROM products WHERE status = 'ACTIVE' AND is_sellable AND barcode = $1
       UNION
       SELECT pu.product_id, pu.factor::text FROM product_uoms pu JOIN products p ON p.id = pu.product_id
        WHERE pu.barcode = $1 AND p.status = 'ACTIVE' AND p.is_sellable`,
      [code],
    );
    if (hits.length === 0) {
      hits = await tx.query(`SELECT id, '1' AS quantity FROM products WHERE status = 'ACTIVE' AND is_sellable AND lower(sku) = lower($1)`, [code]);
    }
    if (hits.length === 0) throw new DomainError('BARCODE_NOT_FOUND', `No product with barcode ${code}`, 404);
    if (hits.length > 1) throw conflict('AMBIGUOUS_BARCODE', `Barcode ${code} is used by ${hits.length} products; fix it in the product catalogue`);
    const pctx = await this.pricingContext(tx, customerId);
    const quantity = new Decimal(hits[0].quantity).toString();
    const price = await this.pricing.resolve(tx, pctx, hits[0].id, null, quantity, tx.today());
    const p = await tx.one(
      `SELECT p.id, p.sku, p.name, p.name_local, p.image_urls, p.variant_attributes, p.parent_product_id, p.track_inventory, p.serial_tracked,
              p.reorder_point, (SELECT count(*)::int FROM products v WHERE v.parent_product_id = p.id AND v.status = 'ACTIVE') AS variant_count,
              s.qty_on_hand, GREATEST(COALESCE(s.qty_on_hand, 0) - COALESCE(s.qty_reserved, 0), 0) AS available
         FROM products p LEFT JOIN stock_levels s ON s.product_id = p.id AND s.warehouse_id = $2 WHERE p.id = $1`,
      [hits[0].id, reg.warehouse_id],
    );
    if (p.variant_count > 0) throw new DomainError('VARIANT_REQUIRED', `${p.name} has variants; scan or pick the size/colour`, 422, { productId: p.id });
    return { ...p, quantity, price: px(price.unitPrice), price_source: price.priceSource, tax_rate_percent: price.taxRatePercent, currency: pctx.currency, low_stock: this.isLow(p) };
  }

  async categories(tx: Tx) {
    return tx.query(
      `SELECT c.id, c.code, c.name, c.parent_id,
              (SELECT count(*)::int FROM products p WHERE p.category_id = c.id AND p.status = 'ACTIVE' AND p.is_sellable AND p.parent_product_id IS NULL) AS product_count
         FROM product_categories c ORDER BY c.name`,
    );
  }

  private isLow(r: { reorder_point?: string | null; qty_on_hand?: string | null; track_inventory?: boolean }): boolean {
    if (r.track_inventory === false || r.reorder_point === null || r.reorder_point === undefined) return false;
    return new Decimal(r.qty_on_hand ?? 0).lte(r.reorder_point);
  }
}
