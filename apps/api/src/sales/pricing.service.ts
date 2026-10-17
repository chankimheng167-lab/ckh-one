import { Injectable } from '@nestjs/common';
import { Decimal } from '@ckh/shared';
import { DomainError } from '../common/errors';
import type { Tx } from '../db/database.service';

export interface ResolvedPrice {
  productId: string;
  unitId: string;
  unitFactor: string;
  unitPrice: string;
  priceSource: 'PRICE_LIST' | 'PROMOTION' | 'LIST_PRICE';
  promotionId: string | null;
  priceListId: string | null;
  taxCodeId: string | null;
  taxRatePercent: string;
  productName: string;
  sku: string;
}

export interface CustomerPricingContext {
  customerId: string;
  priceListId: string | null;
  customerGroupId: string | null;
  currency: string;
}

/**
 * Resolves the selling price on the server for a customer, product, unit,
 * quantity and date:
 *   1. customer's price list → customer group's default list → tenant default list
 *      (best matching row: unit-specific before base unit, highest min_quantity
 *      not above the ordered quantity, valid on the date);
 *   2. falls back to the product list price × unit factor;
 *   3. applies the best active promotion if it beats that price.
 */
@Injectable()
export class PricingService {
  async customerContext(tx: Tx, customerId: string): Promise<CustomerPricingContext> {
    const c = await tx.maybeOne<{ id: string; price_list_id: string | null; customer_group_id: string | null; currency: string | null; status: string; group_list: string | null; default_list: string | null; base_currency: string }>(
      `SELECT c.id, c.price_list_id, c.customer_group_id, c.currency, c.status,
              g.default_price_list_id AS group_list,
              (SELECT id FROM price_lists WHERE is_default AND is_active LIMIT 1) AS default_list,
              t.base_currency
         FROM customers c
         LEFT JOIN customer_groups g ON g.id = c.customer_group_id
         JOIN tenants t ON t.id = c.tenant_id
        WHERE c.id = $1`,
      [customerId],
    );
    if (!c) throw new DomainError('NOT_FOUND', 'Customer not found', 404);
    if (c.status !== 'ACTIVE') throw new DomainError('CUSTOMER_INACTIVE', `Customer is ${c.status.toLowerCase()}`, 422);
    const priceListId = c.price_list_id ?? c.group_list ?? c.default_list;
    let currency = c.currency ?? c.base_currency;
    if (priceListId) {
      const pl = await tx.one<{ currency: string }>('SELECT currency FROM price_lists WHERE id = $1', [priceListId]);
      currency = pl.currency;
    }
    return { customerId, priceListId, customerGroupId: c.customer_group_id, currency };
  }

  async resolve(
    tx: Tx,
    ctx: CustomerPricingContext,
    productId: string,
    unitId: string | null,
    quantity: string,
    on: string,
  ): Promise<ResolvedPrice> {
    const p = await tx.maybeOne<{
      id: string; sku: string; name: string; base_unit_id: string; list_price: string; tax_code_id: string | null;
      category_id: string | null; status: string; is_sellable: boolean;
    }>(
      `SELECT id, sku, name, base_unit_id, list_price, tax_code_id, category_id, status, is_sellable FROM products WHERE id = $1`,
      [productId],
    );
    if (!p) throw new DomainError('PRODUCT_NOT_FOUND', `Product ${productId} not found`, 422);
    if (p.status !== 'ACTIVE' || !p.is_sellable) throw new DomainError('PRODUCT_NOT_SELLABLE', `${p.name} (${p.sku}) cannot be sold`, 422);

    const effectiveUnit = unitId ?? p.base_unit_id;
    let factor = new Decimal(1);
    if (effectiveUnit !== p.base_unit_id) {
      const u = await tx.maybeOne<{ factor: string }>('SELECT factor FROM product_uoms WHERE product_id = $1 AND unit_id = $2', [productId, effectiveUnit]);
      if (!u) throw new DomainError('UNIT_NOT_ALLOWED', `Unit is not configured for ${p.name} (${p.sku})`, 422);
      factor = new Decimal(u.factor);
    }

    let listed: Decimal | null = null;
    let source: ResolvedPrice['priceSource'] = 'LIST_PRICE';
    if (ctx.priceListId) {
      const row = await tx.maybeOne<{ unit_price: string; unit_id: string | null }>(
        `SELECT unit_price, unit_id FROM price_list_items
          WHERE price_list_id = $1 AND product_id = $2
            AND (unit_id = $3 OR unit_id IS NULL)
            AND min_quantity <= $4::numeric
            AND (valid_from IS NULL OR valid_from <= $5::date)
            AND (valid_to IS NULL OR valid_to >= $5::date)
          ORDER BY (unit_id IS NOT NULL) DESC, min_quantity DESC
          LIMIT 1`,
        [ctx.priceListId, productId, effectiveUnit, quantity, on],
      );
      if (row) {
        // A base-unit price row applies to other units by the conversion factor.
        listed = row.unit_id ? new Decimal(row.unit_price) : new Decimal(row.unit_price).mul(factor);
        source = 'PRICE_LIST';
      }
    }
    let price: Decimal = listed ?? new Decimal(p.list_price).mul(factor);

    let promotionId: string | null = null;
    const promos = await tx.query<{ id: string; promo_type: string; value: string }>(
      `SELECT id, promo_type, value FROM promotions
        WHERE is_active AND valid_from <= $1::date + interval '1 day' AND valid_to > $1::date
          AND min_quantity <= $2::numeric
          AND (product_id = $3 OR (product_id IS NULL AND category_id = $4) OR (product_id IS NULL AND category_id IS NULL))
          AND (customer_group_id IS NULL OR customer_group_id = $5)`,
      [on, quantity, productId, p.category_id, ctx.customerGroupId],
    );
    for (const promo of promos) {
      const candidate: Decimal =
        promo.promo_type === 'PERCENT_OFF'
          ? price.mul(new Decimal(100).minus(promo.value)).div(100)
          : new Decimal(promo.value).mul(factor);
      if (candidate.lt(price)) {
        price = candidate;
        source = 'PROMOTION';
        promotionId = promo.id;
      }
    }

    const tax = p.tax_code_id
      ? await tx.one<{ id: string; rate_percent: string }>('SELECT id, rate_percent FROM tax_codes WHERE id = $1', [p.tax_code_id])
      : await tx.maybeOne<{ id: string; rate_percent: string }>('SELECT id, rate_percent FROM tax_codes WHERE is_default AND is_active LIMIT 1');

    return {
      productId,
      unitId: effectiveUnit,
      unitFactor: factor.toString(),
      unitPrice: price.toDecimalPlaces(4).toString(),
      priceSource: source,
      promotionId,
      priceListId: ctx.priceListId,
      taxCodeId: tax?.id ?? null,
      taxRatePercent: tax?.rate_percent ?? '0',
      productName: p.name,
      sku: p.sku,
    };
  }
}
