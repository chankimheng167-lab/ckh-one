import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { MODULES, P } from '@ckh/shared';
import { z } from 'zod';
import { CurrentUser, has, RequireModules, RequirePermissions, TenantUser } from '../common/auth-context';
import { AuditService } from '../common/audit.service';
import { decimalString, isoDate, parse, uuid } from '../common/validation';
import { DatabaseService } from '../db/database.service';
import { NumberingService } from '../core/numbering.service';
import { PaymentMethodInput, PosAdminService, RegisterInput, RegisterUpdate, SettingsInput } from './pos-admin.service';
import { PosCatalogService } from './pos-catalog.service';
import { PosContextService } from './pos-context.service';
import { HoldInput, PosHeldService } from './pos-held.service';
import { CheckoutInput, PosCartInput, SalesQuery } from './pos-schemas';
import { PosSalesService } from './pos-sales.service';
import { PosShiftsService } from './pos-shifts.service';
import { PosReceiptsService, PrintInput } from './pos-receipts.service';
import { DailyQuery, PosReportsService } from './pos-reports.service';
import { PosReturnsService, ReturnInput, ReturnsQuery } from './pos-returns.service';
import { PendingQuery, PosPaymentsService, ReviewInput, SettleInput, VerifyInput } from './pos-payments.service';
import { PosReconciliationService, ReconciliationQuery } from './pos-reconciliation.service';
import { ActivateInput, HeartbeatInput, PosDevicesService } from './pos-devices.service';
import { PosLicenseService } from './pos-license.service';
import { PosSyncService, SyncInput } from './pos-sync.service';

interface Response { setHeader(name: string, value: string): void; end(body: string | Buffer): void }

/** Sends a rendered receipt: JSON as data, anything else as the document itself. */
function sendReceipt(res: Response, r: { body: string | Buffer; contentType: string; copyNo: number; model: { number: string } }, format: string) {
  if (format === 'json') return { copyNo: r.copyNo, receipt: JSON.parse(r.body as string) };
  res.setHeader('Content-Type', r.contentType);
  res.setHeader('X-Receipt-Copy', String(r.copyNo));
  if (format === 'pdf') res.setHeader('Content-Disposition', `inline; filename="${r.model.number}.pdf"`);
  res.end(r.body);
  return undefined;
}

const RegisterQuery = z.object({ registerId: uuid });
const CatalogQuery = z.object({
  registerId: uuid,
  q: z.string().trim().max(100).optional(),
  categoryId: uuid.optional(),
  customerId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
  offset: z.coerce.number().int().min(0).default(0),
});
const QuickCustomer = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(40).optional(),
  email: z.string().email().optional(),
  vatTin: z.string().max(40).optional(),
});

/** The till: context, catalogue, customers, pricing, checkout, sales history, held sales. */
@RequireModules(MODULES.POS_SALES)
@Controller('pos')
export class PosController {
  constructor(
    private readonly db: DatabaseService,
    private readonly ctx: PosContextService,
    private readonly catalog: PosCatalogService,
    private readonly sales: PosSalesService,
    private readonly held: PosHeldService,
    private readonly admin: PosAdminService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  /** Everything the till needs to start: registers the user may use, settings, payment methods and (with registerId) the open shift. */
  @Get('context')
  @RequirePermissions(P.POS_ACCESS)
  context(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const { registerId } = parse(z.object({ registerId: uuid.optional() }), query);
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const settings = await this.ctx.settings(tx);
      const branches = await this.ctx.branchIds(tx, user);
      const registers = await tx.query(
        `SELECT r.id, r.code, r.name, r.branch_id, b.name AS branch_name, r.warehouse_id, w.name AS warehouse_name, r.hardware
           FROM pos_registers r JOIN branches b ON b.id = r.branch_id JOIN warehouses w ON w.id = r.warehouse_id
          WHERE r.status = 'ACTIVE' AND ($1::uuid[] IS NULL OR r.branch_id = ANY($1::uuid[])) ORDER BY b.name, r.code`,
        [branches],
      );
      const register = registerId ? await this.ctx.register(tx, user, registerId) : null;
      const shift = register ? await this.ctx.openShift(tx, register.id) : null;
      const tenant = await tx.one(
        `SELECT t.name, t.base_currency, t.timezone, s.logo_url, COALESCE(s.company_display_name, t.name) AS display_name
           FROM tenants t LEFT JOIN tenant_theme_settings s ON s.tenant_id = t.id WHERE t.id = current_tenant_id()`,
      );
      const walkIn = await this.ctx.walkInPricing(tx);
      return {
        company: tenant,
        currency: walkIn.currency,
        user: { id: user.userId, fullName: user.fullName, permissions: [...user.permissions].filter((p) => p.startsWith('pos.')).sort() },
        settings: {
          pricesIncludeTax: settings.pricesIncludeTax,
          cashierMaxDiscountPercent: settings.cashierMaxDiscountPercent,
          overrideMaxDiscountPercent: settings.overrideMaxDiscountPercent,
          allowNegativeStock: settings.allowNegativeStock,
          requireOpenShift: settings.requireOpenShift,
          walkInCustomerId: settings.walkInCustomerId,
          receipt: settings.receipt,
        },
        registers,
        register,
        shift,
        paymentMethods: (await this.ctx.paymentMethods(tx)).map(({ account_id: _a, ...m }) => m),
        license: await this.ctx.license(tx),
        serverTime: new Date().toISOString(),
        businessDate: tx.today(),
      };
    });
  }

  @Get('catalog')
  @RequirePermissions(P.POS_ACCESS)
  search(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(CatalogQuery, query);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.catalog.search(tx, user, q));
  }

  @Get('catalog/categories')
  @RequirePermissions(P.POS_ACCESS)
  categories(@CurrentUser() user: TenantUser) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.catalog.categories(tx));
  }

  @Get('catalog/products/:id')
  @RequirePermissions(P.POS_ACCESS)
  product(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Query() query: unknown) {
    const q = parse(z.object({ registerId: uuid, customerId: uuid.optional() }), query);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.catalog.product(tx, user, id, q.registerId, q.customerId));
  }

  @Get('catalog/barcode/:code')
  @RequirePermissions(P.POS_ACCESS)
  scan(@CurrentUser() user: TenantUser, @Param('code') code: string, @Query() query: unknown) {
    const q = parse(z.object({ registerId: uuid, customerId: uuid.optional() }), query);
    const c = parse(z.string().trim().min(1).max(60), code);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.catalog.scan(tx, user, c, q.registerId, q.customerId));
  }

  @Get('customers')
  @RequirePermissions(P.POS_ACCESS)
  customers(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const { q } = parse(z.object({ q: z.string().trim().max(100).default('') }), query);
    return this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.query(
        `SELECT c.id, c.code, c.name, c.name_local, c.phone, c.email, c.vat_tin, c.customer_type,
                (SELECT count(*)::int FROM pos_sales s WHERE s.customer_id = c.id) AS pos_sale_count
           FROM customers c
          WHERE c.status = 'ACTIVE' AND ($1 = '' OR lower(c.name) LIKE '%' || lower($1) || '%' OR c.phone LIKE '%' || $1 || '%' OR lower(c.code) = lower($1))
          ORDER BY c.name LIMIT 30`,
        [q],
      ),
    );
  }

  /** Cashiers can register a retail customer (name and phone) at the till. */
  @Post('customers')
  @RequirePermissions(P.POS_SALES_CREATE)
  createCustomer(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(QuickCustomer, body);
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const code = await this.numbering.next(tx, 'CUSTOMER');
      const c = await tx.one(
        `INSERT INTO customers (tenant_id, code, name, customer_type, phone, email, vat_tin)
         VALUES (current_tenant_id(), $1, $2, 'INDIVIDUAL', $3, $4, $5) RETURNING id, code, name, phone, email, vat_tin, customer_type`,
        [code, i.name, i.phone ?? null, i.email ?? null, i.vatTin ?? null],
      );
      await this.audit.record(tx, { action: 'CUSTOMER_CREATED', entityType: 'customer', entityId: c.id, after: { ...c, source: 'POS' } });
      return c;
    });
  }

  /** Prices a cart on the server (no writes): what the till displays. */
  @Post('quote')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.POS_SALES_CREATE)
  quote(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(PosCartInput, body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.sales.quote(tx, user, i));
  }

  /** Checkout: records the sale, payments, stock and ledger in one transaction. */
  @Post('sales')
  @RequirePermissions(P.POS_SALES_CREATE)
  checkout(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(CheckoutInput, body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.sales.checkout(tx, user, i));
  }

  @Get('sales')
  @RequirePermissions(P.POS_ACCESS)
  list(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(SalesQuery, query);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.sales.list(tx, user, q));
  }

  @Get('sales/:id')
  @RequirePermissions(P.POS_ACCESS)
  sale(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.sales.details(tx, user, id));
  }

  @Post('held-sales')
  @RequirePermissions(P.POS_SALES_CREATE)
  hold(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(HoldInput, body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.held.hold(tx, user, i));
  }

  @Get('held-sales')
  @RequirePermissions(P.POS_ACCESS)
  heldList(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(z.object({ registerId: uuid, status: z.enum(['HELD', 'RESUMED', 'CANCELLED']).default('HELD') }), query);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.held.list(tx, user, q.registerId, q.status));
  }

  @Post('held-sales/:id/resume')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.POS_SALES_CREATE)
  resume(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.held.resume(tx, user, id));
  }

  @Post('held-sales/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.POS_SALES_CREATE)
  cancelHeld(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: z.string().trim().min(1).max(300) }), body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.held.cancel(tx, user, id, reason));
  }

  /** Supervisors who can approve at this register (for the PIN prompt). */
  @Get('approvers')
  @RequirePermissions(P.POS_ACCESS)
  approvers(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const { registerId } = parse(RegisterQuery, query);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.admin.approvers(tx, user, registerId));
  }

  /** Sets the caller's approval PIN (re-enter password). */
  @Put('me/pin')
  @RequirePermissions(P.POS_ACCESS)
  setPin(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(z.object({ currentPassword: z.string().min(1).max(200), pin: z.string().regex(/^\d{4,8}$/, 'PIN is 4–8 digits') }), body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.admin.setOwnPin(tx, user, i));
  }

  /** Today at a glance for the POS dashboard. */
  @Get('dashboard')
  @RequirePermissions(P.POS_ACCESS)
  dashboard(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(z.object({ date: isoDate.optional(), registerId: uuid.optional() }), query);
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const day = q.date ?? tx.today();
      const [pred, params] = await this.sales.scope(tx, user, 3);
      const totals = await tx.one(
        `SELECT count(*)::int AS sale_count, COALESCE(sum(s.grand_total), 0) AS total, COALESCE(sum(s.refunded_total), 0) AS refunded,
                COALESCE(sum(s.discount_total), 0) AS discounts, COALESCE(avg(s.grand_total), 0)::numeric(18,2) AS average_sale
           FROM pos_sales s WHERE s.business_date = $1 AND ($2::uuid IS NULL OR s.register_id = $2) AND ${pred}`,
        [day, q.registerId ?? null, ...params],
      );
      const byMethod = await tx.query(
        `SELECT m.name, p.kind, sum(p.amount) AS amount, count(*)::int AS count
           FROM pos_sale_payments p JOIN pos_sales s ON s.id = p.sale_id JOIN pos_payment_methods m ON m.id = p.method_id
          WHERE s.business_date = $1 AND ($2::uuid IS NULL OR s.register_id = $2) AND p.status <> 'REJECTED' AND ${pred}
          GROUP BY m.name, p.kind, m.sort_order ORDER BY m.sort_order`,
        [day, q.registerId ?? null, ...params],
      );
      const branches = await this.ctx.branchIds(tx, user);
      const openShifts = await tx.query(
        `SELECT s.id, s.number, s.opened_at, r.name AS register_name, u.full_name AS cashier_name,
                (SELECT COALESCE(sum(amount), 0) FROM pos_cash_movements m WHERE m.shift_id = s.id) AS expected_cash
           FROM pos_shifts s JOIN pos_registers r ON r.id = s.register_id JOIN users u ON u.id = s.cashier_id
          WHERE s.status = 'OPEN' AND ($1::uuid[] IS NULL OR s.branch_id = ANY($1::uuid[])) ORDER BY s.opened_at`,
        [branches],
      );
      const pending = has(user, P.POS_PAYMENTS_VERIFY)
        ? await tx.one(`SELECT count(*)::int AS count, COALESCE(sum(amount), 0) AS amount FROM pos_sale_payments WHERE status = 'PENDING_VERIFICATION'`)
        : null;
      const toApprove = has(user, P.POS_SHIFT_APPROVE)
        ? await tx.one(`SELECT count(*)::int AS count FROM pos_shifts WHERE status = 'CLOSED' AND ($1::uuid[] IS NULL OR branch_id = ANY($1::uuid[]))`, [branches])
        : null;
      const review = has(user, P.POS_SALES_VIEW_ALL)
        ? await tx.one(`SELECT count(*)::int AS count FROM pos_sales WHERE review_status = 'NEEDS_REVIEW'`)
        : null;
      const lowStock = await tx.query(
        `SELECT p.id, p.sku, p.name, s.qty_on_hand, p.reorder_point, w.name AS warehouse
           FROM products p JOIN stock_levels s ON s.product_id = p.id JOIN warehouses w ON w.id = s.warehouse_id
          WHERE p.reorder_point IS NOT NULL AND p.status = 'ACTIVE' AND s.qty_on_hand <= p.reorder_point
            AND s.warehouse_id IN (SELECT warehouse_id FROM pos_registers WHERE ($1::uuid IS NULL OR id = $1))
          ORDER BY s.qty_on_hand LIMIT 20`,
        [q.registerId ?? null],
      );
      const top = await tx.query(
        `SELECT l.product_id, l.sku, l.description, sum(l.quantity - l.quantity_returned) AS quantity, sum(l.line_total) AS amount
           FROM pos_sale_lines l JOIN pos_sales s ON s.id = l.sale_id
          WHERE s.business_date = $1 AND ($2::uuid IS NULL OR s.register_id = $2) AND ${pred}
          GROUP BY l.product_id, l.sku, l.description ORDER BY amount DESC LIMIT 10`,
        [day, q.registerId ?? null, ...params],
      );
      return { date: day, totals, byMethod, openShifts, pendingPayments: pending, shiftsToApprove: toApprove, salesToReview: review, lowStock, topProducts: top };
    });
  }
}

/** Cashier shifts and the cash drawer. */
@RequireModules(MODULES.POS_SALES)
@Controller('pos/shifts')
export class PosShiftsController {
  constructor(private readonly db: DatabaseService, private readonly shifts: PosShiftsService) {}

  @Post('open')
  @RequirePermissions(P.POS_SALES_CREATE)
  open(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(z.object({ registerId: uuid, openingFloat: decimalString, notes: z.string().max(300).optional() }), body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.shifts.open(tx, user, i));
  }

  @Get('current')
  @RequirePermissions(P.POS_ACCESS)
  current(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const { registerId } = parse(RegisterQuery, query);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.shifts.current(tx, user, registerId));
  }

  @Get()
  @RequirePermissions(P.POS_ACCESS)
  list(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(
      z.object({
        from: isoDate.optional(), to: isoDate.optional(), registerId: uuid.optional(), status: z.enum(['OPEN', 'CLOSED', 'APPROVED']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
      }),
      query,
    );
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.shifts.list(tx, user, q));
  }

  @Get(':id')
  @RequirePermissions(P.POS_ACCESS)
  details(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.shifts.details(tx, user, id));
  }

  @Post(':id/cash-movements')
  @RequirePermissions(P.POS_CASH_DRAWER)
  cash(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parse(z.object({ type: z.enum(['CASH_IN', 'CASH_OUT']), amount: decimalString, reason: z.string().trim().min(3).max(300) }), body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.shifts.cashMovement(tx, user, id, i));
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.POS_SHIFT_CLOSE)
  close(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parse(
      z.object({ countedCash: decimalString, countDetails: z.record(z.string().max(20), z.number().int().min(0).max(100000)).optional(), notes: z.string().max(500).optional() }),
      body,
    );
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.shifts.close(tx, user, id, i));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.POS_SHIFT_APPROVE)
  approve(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parse(z.object({ notes: z.string().max(500).optional() }), body ?? {});
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.shifts.approve(tx, user, id, i));
  }
}

/** Registers, settings, payment methods and staff branches. */
@RequireModules(MODULES.POS_SALES)
@Controller('pos/admin')
export class PosAdminController {
  constructor(private readonly db: DatabaseService, private readonly admin: PosAdminService, private readonly ctx: PosContextService) {}

  @Get('registers')
  @RequirePermissions(P.POS_ACCESS)
  registers(@CurrentUser() user: TenantUser) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.admin.registers(tx, user));
  }

  @Post('registers')
  @RequirePermissions(P.POS_REGISTERS_MANAGE)
  createRegister(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(RegisterInput, body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.admin.createRegister(tx, user, i));
  }

  @Put('registers/:id')
  @RequirePermissions(P.POS_REGISTERS_MANAGE)
  updateRegister(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parse(RegisterUpdate, body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.admin.updateRegister(tx, user, id, i));
  }

  @Get('settings')
  @RequirePermissions(P.POS_SETTINGS_MANAGE)
  getSettings(@CurrentUser() user: TenantUser) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.admin.getSettings(tx));
  }

  @Put('settings')
  @RequirePermissions(P.POS_SETTINGS_MANAGE)
  putSettings(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(SettingsInput, body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.admin.putSettings(tx, i));
  }

  @Get('payment-methods')
  @RequirePermissions(P.POS_ACCESS)
  methods(@CurrentUser() user: TenantUser) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) =>
      user.permissions.has(P.POS_SETTINGS_MANAGE) ? tx.query('SELECT * FROM pos_payment_methods ORDER BY sort_order, name') : this.ctx.paymentMethods(tx),
    );
  }

  @Post('payment-methods')
  @RequirePermissions(P.POS_SETTINGS_MANAGE)
  createMethod(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(PaymentMethodInput, body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.admin.createPaymentMethod(tx, i));
  }

  @Put('payment-methods/:id')
  @RequirePermissions(P.POS_SETTINGS_MANAGE)
  updateMethod(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parse(PaymentMethodInput.partial(), body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.admin.updatePaymentMethod(tx, id, i));
  }

  @Get('staff')
  @RequirePermissions(P.POS_REGISTERS_MANAGE)
  staff(@CurrentUser() user: TenantUser) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.admin.staff(tx));
  }

  @Put('staff/:userId/branches')
  @RequirePermissions(P.POS_REGISTERS_MANAGE)
  setBranches(@CurrentUser() user: TenantUser, @Param('userId', ParseUUIDPipe) userId: string, @Body() body: unknown) {
    const { branchIds } = parse(z.object({ branchIds: z.array(uuid).max(200) }), body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.admin.setStaffBranches(tx, user, userId, branchIds));
  }

  @Get('license')
  @RequirePermissions(P.POS_ACCESS)
  license(@CurrentUser() user: TenantUser) {
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => ({
      ...(await this.ctx.license(tx)),
      usage: await tx.one(
        `SELECT (SELECT count(*)::int FROM pos_registers WHERE status = 'ACTIVE') AS registers,
                (SELECT count(DISTINCT branch_id)::int FROM pos_registers WHERE status = 'ACTIVE') AS branches,
                (SELECT count(*)::int FROM pos_devices WHERE status = 'ACTIVE') AS devices`,
      ),
    }));
  }
}

/** Returns and refunds, receipts and the daily report. */
@RequireModules(MODULES.POS_SALES)
@Controller('pos')
export class PosDocumentsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly returns: PosReturnsService,
    private readonly receipts: PosReceiptsService,
    private readonly reports: PosReportsService,
  ) {}

  /** What can still be returned from a sale (lines and refundable amount per payment method). */
  @Get('sales/:id/returnable')
  @RequirePermissions(P.POS_SALES_CREATE)
  returnable(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.returns.returnable(tx, user, id));
  }

  /** Finds a sale by its receipt number (the number printed on the customer's receipt). */
  @Get('sales/by-number/:number')
  @RequirePermissions(P.POS_SALES_CREATE)
  byNumber(@CurrentUser() user: TenantUser, @Param('number') number: string) {
    const n = parse(z.string().trim().min(3).max(40), number);
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const s = await tx.maybeOne<{ id: string }>('SELECT id FROM pos_sales WHERE upper(number) = upper($1)', [n]);
      if (!s) return { found: false };
      return { found: true, ...(await this.returns.returnable(tx, user, s.id)) };
    });
  }

  @Post('returns/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.POS_SALES_CREATE)
  preview(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(z.object({ saleId: uuid, lines: z.array(z.object({ saleLineId: uuid, quantity: decimalString })).min(1).max(500) }), body);
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      await this.returns.returnable(tx, user, i.saleId);
      return this.returns.preview(tx, i.saleId, i.lines);
    });
  }

  /** Records a return: refund, stock back, drawer and ledger in one transaction (refund permission or a supervisor PIN). */
  @Post('returns')
  @RequirePermissions(P.POS_SALES_CREATE)
  createReturn(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(ReturnInput, body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.returns.create(tx, user, i));
  }

  @Get('returns')
  @RequirePermissions(P.POS_ACCESS)
  listReturns(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(ReturnsQuery, query);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.returns.list(tx, user, q));
  }

  @Get('returns/:id')
  @RequirePermissions(P.POS_ACCESS)
  getReturn(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.returns.details(tx, user, id));
  }

  /** Prints (and logs) a sale receipt; a second print is a reprint and needs permission or a supervisor PIN. */
  @Post('sales/:id/receipt')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.POS_ACCESS)
  async saleReceipt(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const i = parse(PrintInput, body ?? {});
    const r = await this.db.withTenant(user.tenantId, user.userId, (tx) => this.receipts.print(tx, user, { saleId: id }, i));
    return sendReceipt(res, r, i.format);
  }

  @Post('returns/:id/receipt')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.POS_ACCESS)
  async returnReceipt(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const i = parse(PrintInput, body ?? {});
    const r = await this.db.withTenant(user.tenantId, user.userId, (tx) => this.receipts.print(tx, user, { returnId: id }, i));
    return sendReceipt(res, r, i.format);
  }

  @Get('reports/daily')
  @RequirePermissions(P.POS_REPORTS_VIEW)
  async daily(@CurrentUser() user: TenantUser, @Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    const { format, ...q } = parse(DailyQuery.extend({ format: z.enum(['json', 'csv']).default('json') }), query);
    const r = await this.db.withTenant(user.tenantId, user.userId, (tx) => this.reports.daily(tx, user, q));
    if (format === 'json') return r;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pos-daily-${r.from}${r.to !== r.from ? `_${r.to}` : ''}.csv"`);
    res.end(`\ufeff${this.reports.toCsv(r)}`);
    return undefined;
  }
}

/** Payment verification, balance settlement, offline review and reconciliation. */
@RequireModules(MODULES.POS_SALES)
@Controller('pos')
export class PosPaymentsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly payments: PosPaymentsService,
    private readonly reconciliation: PosReconciliationService,
  ) {}

  /** Transfer and QR payments waiting for someone to check the bank or provider. */
  @Get('payments/pending')
  @RequirePermissions(P.POS_PAYMENTS_VERIFY)
  pending(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(PendingQuery, query);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.payments.pending(tx, user, q));
  }

  @Post('payments/:id/verify')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.POS_PAYMENTS_VERIFY)
  verify(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parse(VerifyInput, body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.payments.verify(tx, user, id, i));
  }

  /** The customer pays what a rejected payment left owing. */
  @Post('sales/:id/settle')
  @RequirePermissions(P.POS_SALES_CREATE)
  settle(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parse(SettleInput, body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.payments.settle(tx, user, id, i));
  }

  /** A supervisor marks an offline sale the server flagged as reviewed. */
  @Post('sales/:id/review')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.POS_SHIFT_APPROVE)
  review(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parse(ReviewInput, body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.payments.review(tx, user, id, i));
  }

  @Get('reconciliation')
  @RequirePermissions(P.POS_REPORTS_VIEW)
  reconcile(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(ReconciliationQuery, query);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.reconciliation.reconcile(tx, user, q));
  }
}

/** Windows POS devices, offline licences and offline sale upload. */
@RequireModules(MODULES.POS_SALES)
@Controller('pos')
export class PosDevicesController {
  constructor(
    private readonly db: DatabaseService,
    private readonly devices: PosDevicesService,
    private readonly sync: PosSyncService,
    private readonly licenses: PosLicenseService,
  ) {}

  /** A manager, signed in on the new computer, activates it for a register. The secret is returned once. */
  @Post('devices/activate')
  @RequirePermissions(P.POS_DEVICES_MANAGE)
  activate(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(ActivateInput, body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.devices.activate(tx, user, i));
  }

  @Get('devices')
  @RequirePermissions(P.POS_DEVICES_MANAGE)
  list(@CurrentUser() user: TenantUser) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.devices.list(tx));
  }

  @Post('devices/:id/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.POS_DEVICES_MANAGE)
  revoke(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.devices.revoke(tx, user, id));
  }

  /** The device checks in: proves it is still active and gets a fresh offline licence. */
  @Post('devices/heartbeat')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.POS_ACCESS)
  heartbeat(@CurrentUser() user: TenantUser, @Headers('x-pos-device') device: string | undefined, @Body() body: unknown) {
    const i = parse(HeartbeatInput, body ?? {});
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => this.devices.heartbeat(tx, user, await this.devices.authenticate(tx, device), i));
  }

  @Get('license/public-key')
  @RequirePermissions(P.POS_ACCESS)
  publicKey() {
    return { algorithm: 'Ed25519', publicKey: this.licenses.publicKeyPem() };
  }

  /** Catalogue, prices and offline payment methods for the device's register. */
  @Get('sync/bootstrap')
  @RequirePermissions(P.POS_SALES_CREATE)
  bootstrap(@CurrentUser() user: TenantUser, @Headers('x-pos-device') device: string | undefined) {
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => this.sync.bootstrap(tx, user, await this.devices.authenticate(tx, device)));
  }

  /** Upload of sales recorded offline. Each is replayed in its own transaction. */
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.POS_SALES_CREATE)
  push(@CurrentUser() user: TenantUser, @Headers('x-pos-device') device: string | undefined, @Body() body: unknown) {
    return this.sync.push(user, device, parse(SyncInput, body));
  }

  @Get('sync/events')
  @RequirePermissions(P.POS_DEVICES_MANAGE)
  events(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(
      z.object({
        deviceId: uuid.optional(),
        status: z.enum(['ACCEPTED', 'ACCEPTED_WITH_CHANGES', 'REJECTED', 'CONFLICT']).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      query,
    );
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.sync.events(tx, q));
  }
}
