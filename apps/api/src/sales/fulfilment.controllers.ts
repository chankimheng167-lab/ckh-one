import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { MODULES, P } from '@ckh/shared';
import { z } from 'zod';
import { CurrentUser, RequireModules, RequirePermissions, TenantUser } from '../common/auth-context';
import { decimalString, isoDate, parse, positiveDecimal, uuid } from '../common/validation';
import { DatabaseService, Tx } from '../db/database.service';
import { InvoicingService } from './billing/invoicing.service';
import { CollectionsService } from './collections/collections.service';
import { FulfilmentService } from './fulfilment/fulfilment.service';
import { ReturnsService } from './returns/returns.service';

const Paging = { limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) };

const DispatchInput = z.object({
  carrier: z.string().max(100).optional(),
  vehicleNo: z.string().max(40).optional(),
  driverName: z.string().max(100).optional(),
  trackingReference: z.string().max(100).optional(),
  lines: z.array(z.object({ orderLineId: uuid, quantity: positiveDecimal })).min(1).optional(),
});

const ConfirmInput = z.object({
  receivedByName: z.string().min(1).max(200),
  note: z.string().max(1000).optional(),
  lines: z.array(z.object({ orderLineId: uuid, quantityDelivered: decimalString })).min(1).optional(),
});

const ReturnInput = z.object({
  orderId: uuid,
  reason: z.string().min(3).max(1000),
  lines: z.array(z.object({ orderLineId: uuid, quantity: positiveDecimal, restock: z.boolean().default(true) })).min(1),
});

export const CollectionInput = z.object({
  clientReference: z.string().min(8).max(100).optional(),
  customerId: uuid,
  invoiceId: uuid.optional(),
  amount: positiveDecimal,
  currency: z.string().length(3).optional(),
  paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'KHQR', 'MOBILE_WALLET', 'CHEQUE', 'CARD', 'OTHER']),
  paymentReference: z.string().max(100).optional(),
  collectedOn: isoDate.optional(),
  receiptFileKey: z.string().max(300).optional(),
  notes: z.string().max(2000).optional(),
});

abstract class Base {
  constructor(protected readonly db: DatabaseService) {}
  protected tx<T>(user: TenantUser, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.withTenant(user.tenantId, user.userId, fn);
  }
}

/** Warehouse actions on an order. */
@RequireModules(MODULES.SALES_ORDER_MANAGEMENT, MODULES.INVENTORY)
@Controller('sales/orders')
export class FulfilmentController extends Base {
  constructor(db: DatabaseService, private readonly svc: FulfilmentService, private readonly invoicing: InvoicingService) {
    super(db);
  }

  @Get(':id/picking-list')
  @RequirePermissions(P.SALES_FULFILLMENT_PICK_PACK)
  pickingList(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tx(user, (tx) => this.svc.pickingList(tx, user, id));
  }

  @Post(':id/start-picking')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.SALES_FULFILLMENT_PICK_PACK)
  startPicking(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tx(user, (tx) => this.svc.startPicking(tx, user, id));
  }

  @Post(':id/pack')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.SALES_FULFILLMENT_PICK_PACK)
  pack(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { packageCount } = parse(z.object({ packageCount: z.number().int().min(1).max(10000).default(1) }), body ?? {});
    return this.tx(user, (tx) => this.svc.pack(tx, user, id, packageCount));
  }

  @Post(':id/dispatch')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.SALES_FULFILLMENT_DISPATCH)
  dispatch(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(DispatchInput, body ?? {});
    return this.tx(user, (tx) => this.svc.dispatch(tx, user, id, input));
  }

  @Post(':id/reserve-backorders')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.SALES_FULFILLMENT_RESERVE)
  reserveBackorders(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tx(user, (tx) => this.svc.reserveBackorders(tx, user, id));
  }

  @Post(':id/close-backorders')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.SALES_FULFILLMENT_RESERVE)
  closeBackorders(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: z.string().min(3).max(1000) }), body);
    return this.tx(user, (tx) => this.svc.closeBackorders(tx, user, id, reason));
  }

  @Post(':id/invoice')
  @RequireModules(MODULES.ACCOUNTING)
  @RequirePermissions(P.SALES_INVOICES_CREATE)
  invoice(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const opts = parse(z.object({ invoiceDate: isoDate.optional(), notes: z.string().max(1000).optional() }), body ?? {});
    return this.tx(user, (tx) => this.invoicing.invoiceOrder(tx, user.userId, id, opts));
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequireModules(MODULES.ACCOUNTING)
  @RequirePermissions(P.SALES_INVOICES_CREATE)
  close(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { comment } = parse(z.object({ comment: z.string().max(1000).optional() }), body ?? {});
    return this.tx(user, async (tx) => {
      await this.invoicing.closeOrder(tx, user.userId, id, comment ?? null);
      return tx.one('SELECT id, number, status, closed_at FROM sales_orders WHERE id = $1', [id]);
    });
  }
}

/** Delivery tracking (reps see deliveries for their own orders). */
@RequireModules(MODULES.SALES_ORDER_MANAGEMENT)
@Controller('sales/deliveries')
export class DeliveriesController extends Base {
  constructor(db: DatabaseService, private readonly svc: FulfilmentService) {
    super(db);
  }

  @Get()
  list(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(z.object({ status: z.enum(['DISPATCHED', 'DELIVERED']).optional(), orderId: uuid.optional(), ...Paging }), query);
    return this.tx(user, (tx) => this.svc.listDeliveries(tx, user, q));
  }

  @Get(':id')
  get(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tx(user, (tx) => this.svc.delivery(tx, user, id));
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @RequireModules(MODULES.INVENTORY)
  @RequirePermissions(P.SALES_FULFILLMENT_DISPATCH)
  confirm(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(ConfirmInput, body);
    return this.tx(user, (tx) => this.svc.confirmDelivery(tx, user, id, input));
  }
}

@RequireModules(MODULES.SALES_ORDER_MANAGEMENT, MODULES.INVENTORY)
@Controller('sales/returns')
export class ReturnsController extends Base {
  constructor(db: DatabaseService, private readonly svc: ReturnsService) {
    super(db);
  }

  @Get()
  list(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(z.object({ status: z.enum(['REQUESTED', 'RECEIVED', 'REJECTED']).optional(), ...Paging }), query);
    return this.tx(user, (tx) => this.svc.list(tx, user, q));
  }

  @Get(':id')
  get(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tx(user, (tx) => this.svc.get(tx, user, id));
  }

  @Post()
  @RequirePermissions(P.SALES_RETURNS_REQUEST)
  request(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const input = parse(ReturnInput, body);
    return this.tx(user, (tx) => this.svc.request(tx, user, input));
  }

  @Post(':id/receive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.SALES_RETURNS_RECEIVE)
  receive(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tx(user, (tx) => this.svc.receive(tx, user, id));
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.SALES_RETURNS_RECEIVE)
  reject(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: z.string().min(3).max(1000) }), body);
    return this.tx(user, (tx) => this.svc.reject(tx, user, id, reason));
  }
}

@RequireModules(MODULES.SALES_TEAM_BASIC, MODULES.ACCOUNTING)
@Controller('sales/collections')
export class CollectionsController extends Base {
  constructor(db: DatabaseService, private readonly svc: CollectionsService) {
    super(db);
  }

  @Get()
  list(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(z.object({ status: z.enum(['PENDING_VERIFICATION', 'VERIFIED', 'REJECTED']).optional(), customerId: uuid.optional(), ...Paging }), query);
    return this.tx(user, (tx) => this.svc.list(tx, user, q));
  }

  @Get(':id')
  get(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tx(user, (tx) => this.svc.get(tx, user, id));
  }

  @Post()
  @RequirePermissions(P.SALES_COLLECTIONS_SUBMIT)
  submit(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const input = parse(CollectionInput, body);
    return this.tx(user, (tx) => this.svc.submit(tx, user, input));
  }

  @Post(':id/verify')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.SALES_COLLECTIONS_VERIFY)
  verify(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(z.object({ depositTo: z.enum(['CASH', 'BANK']).optional(), receiptDate: isoDate.optional(), comment: z.string().max(1000).optional() }), body ?? {});
    return this.tx(user, (tx) => this.svc.verify(tx, user, id, input));
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.SALES_COLLECTIONS_VERIFY)
  reject(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: z.string().min(3).max(1000) }), body);
    return this.tx(user, (tx) => this.svc.reject(tx, user, id, reason));
  }
}
