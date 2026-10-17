import { Body, Controller, Get, Post } from '@nestjs/common';
import { MODULES, P } from '@ckh/shared';
import { z } from 'zod';
import { CurrentUser, RequireModules, RequirePermissions, TenantUser } from '../../common/auth-context';
import { AuditService } from '../../common/audit.service';
import { DomainError } from '../../common/errors';
import { decimalString, isoDate, parse, positiveDecimal, uuid } from '../../common/validation';
import { DatabaseService } from '../../db/database.service';

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
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

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
      const p = await tx.one(
        `INSERT INTO products (tenant_id, sku, barcode, name, name_local, category_id, base_unit_id, tax_code_id, list_price, cost_price, track_inventory, image_urls)
         VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, sku, name, list_price`,
        [i.sku, i.barcode ?? null, i.name, i.nameLocal ?? null, i.categoryId ?? null, unitId, i.taxCodeId ?? null, i.listPrice, i.costPrice, i.trackInventory, i.imageUrls],
      );
      await this.audit.record(tx, { action: 'PRODUCT_CREATED', entityType: 'product', entityId: p.id, after: p });
      return p;
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
          `INSERT INTO customer_addresses (tenant_id, customer_id, address_type, label, line1, line2, location_id, is_default)
           VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7)`,
          [c.id, a.addressType, a.label ?? null, a.line1, a.line2 ?? null, a.locationId ?? null, a.isDefault],
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
}
