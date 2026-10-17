import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { MODULES, P } from '@ckh/shared';
import { z } from 'zod';
import { CurrentUser, RequireModules, RequirePermissions, TenantUser } from '../common/auth-context';
import { parse, uuid } from '../common/validation';
import { DatabaseService, Tx } from '../db/database.service';
import { CatalogService } from './catalog/catalog.service';
import { SalesCustomersService } from './customers/sales-customers.service';
import {
  CancelInput,
  CreateOrderInput,
  DecisionInput,
  ListOrdersQuery,
  RejectInput,
  UpdateOrderInput,
} from './orders/order.schemas';
import { OrdersService } from './orders/orders.service';

const ListQuery = z.object({
  search: z.string().max(100).optional(),
  groupId: uuid.optional(),
  categoryId: uuid.optional(),
  customerId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

@RequireModules(MODULES.SALES_TEAM_BASIC)
@Controller('sales/customers')
export class SalesCustomersController {
  constructor(private readonly db: DatabaseService, private readonly svc: SalesCustomersService) {}

  @Get()
  @RequirePermissions(P.SALES_CUSTOMERS_VIEW_ASSIGNED)
  list(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(ListQuery, query);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.svc.list(tx, user, q));
  }

  @Get(':id')
  @RequirePermissions(P.SALES_CUSTOMERS_VIEW_ASSIGNED)
  profile(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.svc.profile(tx, user, id));
  }

  @Post(':id/notes')
  @RequirePermissions(P.SALES_CUSTOMERS_VIEW_ASSIGNED)
  addNote(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { body: text } = parse(z.object({ body: z.string().min(1).max(4000) }), body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.svc.addNote(tx, user, id, text));
  }

  @Post('assignments')
  @RequirePermissions(P.SALES_CUSTOMERS_ASSIGN)
  assign(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const input = parse(
      z.object({ customerId: uuid, salesRepId: uuid, assignmentType: z.enum(['PRIMARY', 'SECONDARY']).default('PRIMARY'), territoryId: uuid.optional() }),
      body,
    );
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.svc.assign(tx, user, input));
  }
}

@RequireModules(MODULES.SALES_TEAM_BASIC)
@Controller('sales/catalog')
export class CatalogController {
  constructor(private readonly db: DatabaseService, private readonly svc: CatalogService) {}

  @Get('products')
  @RequirePermissions(P.SALES_CATALOG_VIEW)
  search(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(ListQuery, query);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.svc.search(tx, user, q));
  }

  @Get('products/:id')
  @RequirePermissions(P.SALES_CATALOG_VIEW)
  details(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Query() query: unknown) {
    const { customerId } = parse(z.object({ customerId: uuid.optional() }), query);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.svc.details(tx, user, id, customerId));
  }
}

@RequireModules(MODULES.SALES_ORDER_MANAGEMENT)
@Controller('sales/orders')
export class OrdersController {
  constructor(private readonly db: DatabaseService, private readonly orders: OrdersService) {}

  private tx<T>(user: TenantUser, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.withTenant(user.tenantId, user.userId, fn);
  }

  @Get()
  list(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(ListOrdersQuery, query);
    return this.tx(user, (tx) => this.orders.list(tx, user, q));
  }

  @Get('pending-approvals')
  pending(@CurrentUser() user: TenantUser) {
    return this.tx(user, (tx) => this.orders.pendingApprovals(tx, user));
  }

  @Get(':id')
  get(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tx(user, (tx) => this.orders.get(tx, user, id));
  }

  @Post()
  @RequirePermissions(P.SALES_ORDERS_CREATE)
  create(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const input = parse(CreateOrderInput, body);
    return this.tx(user, (tx) => this.orders.create(tx, user, input));
  }

  @Put(':id')
  @RequirePermissions(P.SALES_ORDERS_CREATE)
  update(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(UpdateOrderInput, body);
    return this.tx(user, (tx) => this.orders.update(tx, user, id, input));
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.SALES_ORDERS_CREATE)
  submit(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tx(user, (tx) => this.orders.submit(tx, user, id));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { comment } = parse(DecisionInput, body ?? {});
    return this.tx(user, (tx) => this.orders.approve(tx, user, id, comment));
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { comment } = parse(RejectInput, body);
    return this.tx(user, (tx) => this.orders.reject(tx, user, id, comment));
  }

  @Post(':id/revise')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.SALES_ORDERS_CREATE)
  revise(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tx(user, (tx) => this.orders.revise(tx, user, id));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.SALES_ORDERS_CANCEL)
  cancel(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parse(CancelInput, body);
    return this.tx(user, (tx) => this.orders.cancel(tx, user, id, reason));
  }

  @Post(':id/reserve')
  @HttpCode(HttpStatus.OK)
  @RequireModules(MODULES.INVENTORY)
  @RequirePermissions(P.SALES_FULFILLMENT_RESERVE)
  reserve(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tx(user, (tx) => this.orders.reserve(tx, user, id));
  }
}
