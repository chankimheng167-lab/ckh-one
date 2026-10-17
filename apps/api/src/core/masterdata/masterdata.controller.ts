import { Body, Controller, Get, Post } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Decimal, MODULES, P } from '@ckh/shared';
import { z } from 'zod';
import { CurrentUser, RequireModules, RequirePermissions, TenantUser } from '../../common/auth-context';
import { AuditService } from '../../common/audit.service';
import { DomainError } from '../../common/errors';
import { decimalString, isoDate, parse, positiveDecimal, uuid } from '../../common/validation';
import { DatabaseService } from '../../db/database.service';
import { JournalService } from '../../accounting/journal.service';
import { StockService } from '../../inventory/stock.service';

const CreateProduct = z.object({
  sku: z.string().min(1).max(60),
  barcode: z.string().max(60).optional(),
  name: z.string().min(1).max(300),
  nameLocal: z.string().max(300).optional(),
  categoryId: uuid.optional(),
  baseUnitId: uuid.optional(),
  taxCodeId: uuid.optional(),
  listPrice: decimalString,
  costPrice: decimalString.default('0'),
  trackInventory: z.boolean().default(true),
  imageUrls: z.array(z.string().url()).max(10).default([]),
  /** Variant of a template product (e.g. a size/colour of a shirt). */
  parentProductId: uuid.optional(),
  variantAttributes: z.record(z.string().min(1).max(40), z.string().min(1).max(60)).optional(),
  productType: z.enum(['STOCK', 'SERVICE', 'NON_STOCK']).default('STOCK'),
  serialTracked: z.boolean().default(false),
  reorderPoint: decimalString.nullable().optional(),
});

const CreateCategory = z.object({ code: z.string().min(1).max(40), name: z.string().min(1).max(200), parentId: uuid.optional() });

const StockAdjustment = z.object({
  warehouseId: uuid,
  reason: z.string().trim().min(3).max(300),
  lines: z
    .array(
      z.object({
        productId: uuid,
        /** Physical count; the difference to the system quantity is posted. */
        countedQuantity: decimalString,
      }),
    )
    .min(1)
    .max(500),
});

const CreateCustomer = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(300),
  nameLocal: z.string().max(300).optional(),
  customerGroupId: uuid.optional(),
  priceListId: uuid.optional(),
  vatTin: z.string().max(40).optional(),
  contactName: z.string().max(200).optional(),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).default(0),
  creditLimit: decimalString.nullable().default(null),
  specialDiscountPercent: decimalString.default('0'),
  addresses: z
    .array(
      z.object({
        addressType: z.enum(['BILLING', 'DELIVERY']),
        label: z.string().max(100).optional(),
        line1: z.string().min(1).max(300),
        line2: z.string().max(300).optional(),
        locationId: uuid.optional(),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        isDefault: z.boolean().default(false),
      }),
    )
    .default([]),
});

const StockReceipt = z.object({
  warehouseId: uuid,
  lines: z.array(z.object({ productId: uuid, quantity: positiveDecimal, unitCost: decimalString.optional() })).min(1),
  reference: z.string().max(100).optional(),
});

const PriceListItem = z.object({
  priceListId: uuid,
  productId: uuid,
  unitId: uuid.optional(),
  minQuantity: decimalString.default('0'),
  unitPrice: decimalString,
  validFrom: isoDate.optional(),
  validTo: isoDate.optional(),
});

/** Core master data shared by POS, Inventory, Accounting and Sales. */
@Controller('masterdata')
export class MasterDataController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
    private readonly journal: JournalService,
  ) {}

  @Get('reference')
  reference(@CurrentUser() user: TenantUser) {
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => ({
      branches: await tx.query('SELECT id, code, name FROM branches WHERE is_active ORDER BY name'),
      warehouses: await tx.query('SELECT id, code, name, branch_id FROM warehouses WHERE is_active ORDER BY name'),
      units: await tx.query('SELECT id, code, name FROM units ORDER BY code'),
      taxCodes: await tx.query('SELECT id, code, name, rate_percent, is_default FROM tax_codes WHERE is_active ORDER BY code'),
      priceLists: await tx.query('SELECT id, code, name, currency, is_default FROM price_lists WHERE is_active ORDER BY name'),
      customerGroups: await tx.query('SELECT id, code, name FROM customer_groups ORDER BY name'),
      categories: await tx.query('SELECT id, code, name, parent_id FROM product_categories ORDER BY name'),
    }));
  }

  @Post('products')
  @RequirePermissions(P.PRODUCTS_MANAGE)
  createProduct(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(CreateProduct, body);
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const unitId = i.baseUnitId ?? (await tx.one<{ id: string }>(`SELECT id FROM units WHERE code = 'PCS'`)).id;
      if (i.barcode) {
        const dup = await tx.maybeOne<{ sku: string }>(`SELECT sku FROM products WHERE barcode = $1 AND status = 'ACTIVE'`, [i.barcode]);
        if (dup) throw new DomainError('DUPLICATE_BARCODE', `Barcode ${i.barcode} is already used by ${dup.sku}`, 409);
      }
      if (i.parentProductId) {
        const parent = await tx.maybeOne<{ parent_product_id: string | null }>('SELECT parent_product_id FROM products WHERE id = $1', [i.parentProductId]);
        if (!parent) throw new DomainError('NOT_FOUND', 'Parent product not found', 404);
        if (parent.parent_product_id) throw new DomainError('INVALID_PARENT', 'A variant cannot have variants of its own', 422);
      }
      const p = await tx.one(
        `INSERT INTO products (tenant_id, sku, barcode, name, name_local, category_id, base_unit_id, tax_code_id, list_price, cost_price, track_inventory,
            image_urls, parent_product_id, variant_attributes, product_type, serial_tracked, reorder_point)
         VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id, sku, name, list_price`,
        [i.sku, i.barcode ?? null, i.name, i.nameLocal ?? null, i.categoryId ?? null, unitId, i.taxCodeId ?? null, i.listPrice, i.costPrice,
          i.trackInventory && i.productType === 'STOCK', i.imageUrls, i.parentProductId ?? null, i.variantAttributes ? JSON.stringify(i.variantAttributes) : null,
          i.productType, i.serialTracked, i.reorderPoint ?? null],
      );
      await this.audit.record(tx, { action: 'PRODUCT_CREATED', entityType: 'product', entityId: p.id, after: p });
      return p;
    });
  }

  @Post('categories')
  @RequirePermissions(P.PRODUCTS_MANAGE)
  createCategory(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(CreateCategory, body);
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const c = await tx.one(
        `INSERT INTO product_categories (tenant_id, code, name, parent_id) VALUES (current_tenant_id(), $1, $2, $3) RETURNING *`,
        [i.code, i.name, i.parentId ?? null],
      );
      await this.audit.record(tx, { action: 'CATEGORY_CREATED', entityType: 'product_category', entityId: c.id, after: c });
      return c;
    });
  }

  @Post('price-list-items')
  @RequirePermissions(P.PRODUCTS_MANAGE)
  addPrice(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(PriceListItem, body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.one(
        `INSERT INTO price_list_items (tenant_id, price_list_id, product_id, unit_id, min_quantity, unit_price, valid_from, valid_to)
         VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [i.priceListId, i.productId, i.unitId ?? null, i.minQuantity, i.unitPrice, i.validFrom ?? null, i.validTo ?? null],
      ),
    );
  }

  @Post('customers')
  @RequirePermissions(P.CUSTOMERS_MANAGE)
  createCustomer(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(CreateCustomer, body);
    if (i.creditLimit !== null && !user.permissions.has(P.CUSTOMERS_CREDIT_MANAGE)) {
      throw new DomainError('FORBIDDEN', 'Setting a credit limit requires credit management permission', 403);
    }
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const c = await tx.one(
        `INSERT INTO customers (tenant_id, code, name, name_local, customer_group_id, price_list_id, vat_tin, contact_name, phone, email,
            payment_terms_days, credit_limit, special_discount_percent)
         VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, code, name`,
        [i.code, i.name, i.nameLocal ?? null, i.customerGroupId ?? null, i.priceListId ?? null, i.vatTin ?? null, i.contactName ?? null,
          i.phone ?? null, i.email ?? null, i.paymentTermsDays, i.creditLimit, i.specialDiscountPercent],
      );
      for (const a of i.addresses) {
        await tx.query(
          `INSERT INTO customer_addresses (tenant_id, customer_id, address_type, label, line1, line2, location_id, is_default, latitude, longitude)
           VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [c.id, a.addressType, a.label ?? null, a.line1, a.line2 ?? null, a.locationId ?? null, a.isDefault, a.latitude ?? null, a.longitude ?? null],
        );
      }
      await this.audit.record(tx, { action: 'CUSTOMER_CREATED', entityType: 'customer', entityId: c.id, after: { ...c, creditLimit: i.creditLimit } });
      return c;
    });
  }

  /** Goods receipt: increases stock on hand and records a movement (weighted-average cost). */
  @Post('stock/receipts')
  @RequireModules(MODULES.INVENTORY)
  @RequirePermissions(P.INVENTORY_ADJUST)
  receive(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(StockReceipt, body);
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      for (const l of [...i.lines].sort((a, b) => a.productId.localeCompare(b.productId))) {
        await tx.query(
          `INSERT INTO stock_levels (tenant_id, warehouse_id, product_id, qty_on_hand, avg_cost)
           VALUES (current_tenant_id(), $1, $2, $3, COALESCE($4::numeric, 0))
           ON CONFLICT (warehouse_id, product_id) DO UPDATE SET
             avg_cost = CASE WHEN $4::numeric IS NULL OR stock_levels.qty_on_hand + $3::numeric <= 0 THEN stock_levels.avg_cost
                             ELSE (stock_levels.qty_on_hand * stock_levels.avg_cost + $3::numeric * $4::numeric) / (stock_levels.qty_on_hand + $3::numeric) END,
             qty_on_hand = stock_levels.qty_on_hand + $3::numeric`,
          [i.warehouseId, l.productId, l.quantity, l.unitCost ?? null],
        );
        await tx.query(
          `INSERT INTO stock_movements (tenant_id, warehouse_id, product_id, movement_type, quantity, unit_cost, reference_type, notes, created_by)
           VALUES (current_tenant_id(), $1, $2, 'RECEIPT', $3, $4, 'GOODS_RECEIPT', $5, $6)`,
          [i.warehouseId, l.productId, l.quantity, l.unitCost ?? null, i.reference ?? null, user.userId],
        );
      }
      await this.audit.record(tx, { action: 'STOCK_RECEIVED', entityType: 'warehouse', entityId: i.warehouseId, after: i });
      return { received: i.lines.length };
    });
  }

  /**
   * Stock count adjustment: sets on-hand to the counted quantity, records an
   * ADJUSTMENT movement, and posts the value difference against the
   * inventory-adjustments account at weighted-average cost.
   */
  @Post('stock/adjustments')
  @RequireModules(MODULES.INVENTORY)
  @RequirePermissions(P.INVENTORY_ADJUST)
  adjust(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(StockAdjustment, body);
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const ids = i.lines.map((l) => l.productId);
      if (new Set(ids).size !== ids.length) throw new DomainError('DUPLICATE_LINE', 'Each product may appear once', 422);
      await this.stock.lock(tx, i.warehouseId, ids);
      const results: { productId: string; before: string; counted: string; difference: string; value: string }[] = [];
      let gain = new Decimal(0);
      let loss = new Decimal(0);
      const adjustmentId = randomUUID();
      for (const l of [...i.lines].sort((a, b) => a.productId.localeCompare(b.productId))) {
        const row = await tx.one<{ qty_on_hand: string; qty_reserved: string; avg_cost: string }>(
          'SELECT qty_on_hand, qty_reserved, avg_cost FROM stock_levels WHERE warehouse_id = $1 AND product_id = $2',
          [i.warehouseId, l.productId],
        );
        const counted = new Decimal(l.countedQuantity);
        if (counted.lt(0)) throw new DomainError('INVALID_QUANTITY', 'Counted quantity cannot be negative', 422);
        const diff = counted.minus(row.qty_on_hand);
        if (diff.isZero()) continue;
        await tx.query('UPDATE stock_levels SET qty_on_hand = $3 WHERE warehouse_id = $1 AND product_id = $2', [i.warehouseId, l.productId, counted.toString()]);
        await tx.query(
          `INSERT INTO stock_movements (tenant_id, warehouse_id, product_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by)
           VALUES (current_tenant_id(), $1, $2, 'ADJUSTMENT', $3, $4, 'STOCK_ADJUSTMENT', $5, $6, $7)`,
          [i.warehouseId, l.productId, diff.toString(), row.avg_cost, adjustmentId, i.reason, user.userId],
        );
        const value = diff.abs().mul(row.avg_cost).toDecimalPlaces(2);
        if (diff.gt(0)) gain = gain.plus(value);
        else loss = loss.plus(value);
        results.push({ productId: l.productId, before: row.qty_on_hand, counted: counted.toString(), difference: diff.toString(), value: value.toFixed(2) });
      }
      let journalId: string | null = null;
      if (!gain.isZero() || !loss.isZero()) {
        const acc = await this.journal.accounts(tx);
        const adj = await tx.one<{ id: string | null }>('SELECT inventory_adjustment_account_id AS id FROM pos_settings WHERE tenant_id = current_tenant_id()');
        journalId = await this.journal.post(tx, {
          date: tx.today(),
          description: `Stock adjustment: ${i.reason}`,
          sourceType: 'STOCK_ADJUSTMENT',
          sourceId: adjustmentId,
          lines: [
            { accountId: acc.inventory, debit: gain, description: 'Stock found' },
            { accountId: adj.id as string, credit: gain, description: 'Stock found' },
            { accountId: adj.id as string, debit: loss, description: 'Stock lost' },
            { accountId: acc.inventory, credit: loss, description: 'Stock lost' },
          ],
        });
      }
      await this.audit.record(tx, { action: 'STOCK_ADJUSTED', entityType: 'warehouse', entityId: i.warehouseId, after: { reason: i.reason, results, journalId } });
      return { adjustmentId, journalId, lines: results };
    });
  }
}
