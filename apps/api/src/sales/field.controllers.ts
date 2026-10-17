import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { MODULES, P } from '@ckh/shared';
import { z } from 'zod';
import { CurrentUser, RequireModules, RequirePermissions, TenantUser } from '../common/auth-context';
import { decimalString, isoDate, parse, positiveDecimal, uuid } from '../common/validation';
import { businessDate } from '../common/business-time';
import { DatabaseService, Tx } from '../db/database.service';
import { CommissionsService } from './commissions/commissions.service';
import { OrderLineInput } from './orders/order.schemas';
import { QuotationsService } from './quotations/quotations.service';
import { TargetsService } from './targets/targets.service';
import { TerritoriesService } from './territories/territories.service';
import { VisitsService } from './visits/visits.service';

const Paging = { limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) };
const isoDateTime = z.string().datetime({ offset: true });
const percent = decimalString.refine((v) => Number(v) >= 0 && Number(v) <= 100, 'must be 0–100');

export const QuotationInput = z.object({
  customerId: uuid,
  salesRepId: uuid.optional(),
  branchId: uuid.optional(),
  warehouseId: uuid.optional(),
  quotationDate: isoDate.optional(),
  validUntil: isoDate.optional(),
  deliveryAddressId: uuid.optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  notes: z.string().max(2000).optional(),
  visitId: uuid.optional(),
  lines: z.array(OrderLineInput).min(1).max(500),
});

export const VisitInput = z.object({
  clientReference: z.string().min(8).max(100).optional(),
  customerId: uuid,
  salesRepId: uuid.optional(),
  scheduledStart: isoDateTime,
  scheduledEnd: isoDateTime.optional(),
  purpose: z.string().max(500).optional(),
});
export const CheckInInput = z.object({
  locationConsent: z.boolean(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  accuracyM: z.number().min(0).max(100000).optional(),
  at: isoDateTime.optional(),
});
export const CheckOutInput = z.object({
  outcome: z.enum(['ORDER_TAKEN', 'FOLLOW_UP_NEEDED', 'NO_INTEREST', 'COLLECTION_MADE', 'CUSTOMER_UNAVAILABLE', 'OTHER']),
  outcomeSummary: z.string().max(2000).optional(),
  at: isoDateTime.optional(),
});
export const VisitNoteInput = z.object({
  noteType: z.enum(['NOTE', 'FOLLOW_UP_TASK']).default('NOTE'),
  body: z.string().min(1).max(4000),
  dueDate: isoDate.optional(),
  assignedToUserId: uuid.optional(),
});

const RulesInput = z.object({
  defaultRatePercent: percent,
  productRates: z.record(uuid, percent).optional(),
  categoryRates: z.record(uuid, percent).optional(),
  customerRates: z.record(uuid, percent).optional(),
  customerGroupRates: z.record(uuid, percent).optional(),
  clawbackOverdueDays: z.number().int().min(0).max(3650).optional(),
  tiers: z.array(z.object({ minAchievementPercent: decimalString, multiplier: decimalString })).max(20).optional(),
});

abstract class Base {
  constructor(protected readonly db: DatabaseService) {}
  protected tx<T>(user: TenantUser, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.withTenant(user.tenantId, user.userId, fn);
  }
}

// ---------------------------------------------------------------------------

@RequireModules(MODULES.SALES_ORDER_MANAGEMENT)
@Controller('sales/quotations')
export class QuotationsController extends Base {
  constructor(db: DatabaseService, private readonly svc: QuotationsService) {
    super(db);
  }

  @Get()
  @RequirePermissions(P.SALES_QUOTATIONS_MANAGE)
  list(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(z.object({ status: z.string().optional(), customerId: uuid.optional(), ...Paging }), query);
    return this.tx(user, (tx) => this.svc.list(tx, user, q));
  }

  @Get(':id')
  @RequirePermissions(P.SALES_QUOTATIONS_MANAGE)
  get(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tx(user, (tx) => this.svc.get(tx, user, id));
  }

  @Post()
  @RequirePermissions(P.SALES_QUOTATIONS_MANAGE)
  create(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const input = parse(QuotationInput, body);
    return this.tx(user, (tx) => this.svc.create(tx, user, input));
  }

  @Post(':id/:action(send|accept|reject|cancel)')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.SALES_QUOTATIONS_MANAGE)
  decide(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Param('action') action: string, @Body() body: unknown) {
    const { note } = parse(z.object({ note: z.string().max(1000).optional() }), body ?? {});
    const to = ({ send: 'SENT', accept: 'ACCEPTED', reject: 'REJECTED', cancel: 'CANCELLED' } as const)[action as 'send'];
    return this.tx(user, (tx) => this.svc.setStatus(tx, user, id, to, note));
  }

  @Post(':id/convert')
  @RequirePermissions(P.SALES_QUOTATIONS_MANAGE, P.SALES_ORDERS_CREATE)
  convert(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tx(user, (tx) => this.svc.convert(tx, user, id));
  }
}

// ---------------------------------------------------------------------------

@RequireModules(MODULES.SALES_TEAM_BASIC)
@Controller('sales/visits')
export class VisitsController extends Base {
  constructor(db: DatabaseService, private readonly svc: VisitsService) {
    super(db);
  }

  @Get()
  list(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(
      z.object({ from: isoDate.optional(), to: isoDate.optional(), status: z.string().optional(), salesRepId: uuid.optional(), customerId: uuid.optional(), ...Paging }),
      query,
    );
    return this.tx(user, (tx) => this.svc.list(tx, user, q));
  }

  @Get('follow-ups')
  @RequirePermissions(P.SALES_VISITS_MANAGE)
  followUps(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const { includeDone } = parse(z.object({ includeDone: z.coerce.boolean().default(false) }), query);
    return this.tx(user, (tx) => this.svc.followUps(tx, user, includeDone));
  }

  @Post('follow-ups/:id/complete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.SALES_VISITS_MANAGE)
  completeFollowUp(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tx(user, (tx) => this.svc.completeFollowUp(tx, user, id));
  }

  @Get(':id')
  get(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tx(user, (tx) => this.svc.get(tx, user, id));
  }

  @Post()
  @RequirePermissions(P.SALES_VISITS_MANAGE)
  schedule(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const input = parse(VisitInput, body);
    return this.tx(user, (tx) => this.svc.schedule(tx, user, input));
  }

  @Post(':id/check-in')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.SALES_VISITS_MANAGE)
  checkIn(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(CheckInInput, body);
    return this.tx(user, (tx) => this.svc.checkIn(tx, user, id, input));
  }

  @Post(':id/check-out')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.SALES_VISITS_MANAGE)
  checkOut(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(CheckOutInput, body);
    return this.tx(user, (tx) => this.svc.checkOut(tx, user, id, input));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.SALES_VISITS_MANAGE)
  cancel(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason, missed } = parse(z.object({ reason: z.string().min(3).max(1000), missed: z.boolean().default(false) }), body);
    return this.tx(user, (tx) => this.svc.cancel(tx, user, id, reason, missed));
  }

  @Post(':id/notes')
  @RequirePermissions(P.SALES_VISITS_MANAGE)
  note(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(VisitNoteInput, body);
    return this.tx(user, (tx) => this.svc.addNote(tx, user, id, input));
  }

  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.SALES_VISITS_VIEW_TEAM)
  review(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { comment } = parse(z.object({ comment: z.string().min(1).max(2000) }), body);
    return this.tx(user, (tx) => this.svc.review(tx, user, id, comment));
  }
}

// ---------------------------------------------------------------------------

@RequireModules(MODULES.SALES_TERRITORY_MANAGEMENT)
@Controller('sales/territories')
export class TerritoriesController extends Base {
  constructor(db: DatabaseService, private readonly svc: TerritoriesService) {
    super(db);
  }

  @Get()
  @RequirePermissions(P.SALES_DASHBOARD_VIEW)
  list(@CurrentUser() user: TenantUser) {
    return this.tx(user, (tx) => this.svc.list(tx));
  }

  @Post()
  @RequirePermissions(P.SALES_TERRITORIES_MANAGE)
  create(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(
      z.object({
        code: z.string().min(1).max(40),
        name: z.string().min(1).max(200),
        territoryType: z.enum(['REGION', 'AREA', 'TERRITORY']).default('TERRITORY'),
        parentId: uuid.nullable().optional(),
        teamId: uuid.nullable().optional(),
      }),
      body,
    );
    return this.tx(user, (tx) => this.svc.create(tx, i));
  }

  @Put(':id')
  @RequirePermissions(P.SALES_TERRITORIES_MANAGE)
  update(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parse(
      z.object({
        name: z.string().min(1).max(200).optional(),
        territoryType: z.enum(['REGION', 'AREA', 'TERRITORY']).optional(),
        parentId: uuid.nullable().optional(),
        teamId: uuid.nullable().optional(),
        isActive: z.boolean().optional(),
      }),
      body,
    );
    return this.tx(user, (tx) => this.svc.update(tx, id, i));
  }

  @Put(':id/locations')
  @RequirePermissions(P.SALES_TERRITORIES_MANAGE)
  locations(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { locationIds } = parse(z.object({ locationIds: z.array(uuid).max(2000) }), body);
    return this.tx(user, (tx) => this.svc.setLocations(tx, id, locationIds));
  }

  @Post(':id/representatives')
  @RequirePermissions(P.SALES_TERRITORIES_MANAGE)
  assignRep(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parse(z.object({ salesRepId: uuid, role: z.enum(['PRIMARY', 'BACKUP']).default('PRIMARY'), validFrom: isoDate.optional() }), body);
    return this.tx(user, (tx) => this.svc.assignRep(tx, user, id, i));
  }

  @Post('assignments/:assignmentId/end')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.SALES_TERRITORIES_MANAGE)
  endAssignment(@CurrentUser() user: TenantUser, @Param('assignmentId', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { validTo } = parse(z.object({ validTo: isoDate.optional() }), body ?? {});
    return this.tx(user, (tx) => this.svc.endAssignment(tx, id, validTo));
  }

  @Post(':id/assign-customers')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.SALES_TERRITORIES_MANAGE, P.SALES_CUSTOMERS_ASSIGN)
  assignCustomers(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reassign } = parse(z.object({ reassign: z.boolean().default(false) }), body ?? {});
    return this.tx(user, (tx) => this.svc.assignCustomersByLocation(tx, user, id, reassign));
  }
}

/** Administrative locations: platform reference data plus the tenant's own groupings. */
@Controller('locations')
export class LocationsController extends Base {
  constructor(db: DatabaseService, private readonly svc: TerritoriesService) {
    super(db);
  }

  @Get()
  list(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(
      z.object({ level: z.enum(['COUNTRY', 'REGION', 'PROVINCE', 'DISTRICT', 'COMMUNE', 'VILLAGE']).optional(), parentId: uuid.optional(), search: z.string().max(100).optional(), countryCode: z.string().length(2).optional() }),
      query,
    );
    return this.tx(user, (tx) => this.svc.locations(tx, q));
  }

  @Post('import')
  @RequireModules(MODULES.SALES_TERRITORY_MANAGEMENT)
  @RequirePermissions(P.SALES_TERRITORIES_MANAGE)
  import(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(LocationImport, body);
    return this.tx(user, (tx) => this.svc.importLocations(tx, user.tenantId, i.countryCode, i.source, i.rows));
  }
}

export const LocationImport = z.object({
  countryCode: z.string().length(2).default('KH'),
  source: z.string().min(1).max(300),
  rows: z
    .array(
      z.object({
        level: z.enum(['COUNTRY', 'REGION', 'PROVINCE', 'DISTRICT', 'COMMUNE', 'VILLAGE']),
        code: z.string().min(1).max(40),
        name: z.string().min(1).max(200),
        nameLocal: z.string().max(200).optional(),
        parentCode: z.string().max(40).optional(),
        parentLevel: z.enum(['COUNTRY', 'REGION', 'PROVINCE', 'DISTRICT', 'COMMUNE', 'VILLAGE']).optional(),
        validFrom: isoDate.optional(),
        validTo: isoDate.optional(),
      }),
    )
    .min(1)
    .max(20000),
});

// ---------------------------------------------------------------------------

@RequireModules(MODULES.SALES_TEAM_BASIC)
@Controller('sales/targets')
export class TargetsController extends Base {
  constructor(db: DatabaseService, private readonly svc: TargetsService) {
    super(db);
  }

  @Get()
  @RequirePermissions(P.SALES_TARGETS_VIEW)
  list(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(z.object({ on: isoDate.optional(), salesRepId: uuid.optional(), scope: z.enum(['REP', 'TEAM', 'TERRITORY']).optional(), periodType: z.enum(['MONTH', 'QUARTER', 'YEAR']).optional() }), query);
    return this.tx(user, (tx) => this.svc.list(tx, user, q));
  }

  @Post()
  @RequirePermissions(P.SALES_TARGETS_MANAGE)
  create(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(
      z.object({
        scope: z.enum(['REP', 'TEAM', 'TERRITORY']),
        salesRepId: uuid.optional(),
        teamId: uuid.optional(),
        territoryId: uuid.optional(),
        periodType: z.enum(['MONTH', 'QUARTER', 'YEAR']),
        periodStart: isoDate,
        metric: z.enum(['NET_SALES', 'COLLECTIONS', 'ORDER_COUNT', 'QUANTITY', 'NEW_CUSTOMERS', 'VISITS']),
        productId: uuid.optional(),
        categoryId: uuid.optional(),
        targetValue: positiveDecimal,
      }),
      body,
    );
    return this.tx(user, (tx) => this.svc.create(tx, user, i));
  }

  @Delete(':id')
  @RequirePermissions(P.SALES_TARGETS_MANAGE)
  remove(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tx(user, (tx) => this.svc.remove(tx, id));
  }
}

// ---------------------------------------------------------------------------

@RequireModules(MODULES.SALES_COMMISSION_MANAGEMENT)
@Controller('sales/commissions')
export class CommissionsController extends Base {
  constructor(db: DatabaseService, private readonly svc: CommissionsService) {
    super(db);
  }

  @Get('plans')
  @RequirePermissions(P.SALES_COMMISSIONS_VIEW)
  plans(@CurrentUser() user: TenantUser) {
    return this.tx(user, (tx) => this.svc.listPlans(tx));
  }

  @Post('plans')
  @RequirePermissions(P.SALES_COMMISSIONS_MANAGE)
  createPlan(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(
      z.object({
        code: z.string().min(1).max(40),
        name: z.string().min(1).max(200),
        basis: z.enum(['INVOICED_NET_SALES', 'COLLECTED_AMOUNT', 'GROSS_PROFIT']),
        rules: RulesInput,
        validFrom: isoDate,
        validTo: isoDate.optional(),
      }),
      body,
    );
    return this.tx(user, (tx) => this.svc.createPlan(tx, user, i));
  }

  @Put('plans/:id')
  @RequirePermissions(P.SALES_COMMISSIONS_MANAGE)
  updatePlan(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parse(
      z.object({ name: z.string().min(1).max(200).optional(), rules: RulesInput.optional(), validTo: isoDate.nullable().optional(), status: z.enum(['DRAFT', 'ACTIVE', 'RETIRED']).optional() }),
      body,
    );
    return this.tx(user, (tx) => this.svc.updatePlan(tx, id, i));
  }

  @Put('representatives/:repId/plan')
  @RequirePermissions(P.SALES_COMMISSIONS_MANAGE)
  assign(@CurrentUser() user: TenantUser, @Param('repId', ParseUUIDPipe) repId: string, @Body() body: unknown) {
    const { planId } = parse(z.object({ planId: uuid.nullable() }), body);
    return this.tx(user, (tx) => this.svc.assignPlan(tx, repId, planId));
  }

  @Get('entries')
  @RequirePermissions(P.SALES_COMMISSIONS_VIEW)
  entries(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(z.object({ periodMonth: isoDate.optional(), salesRepId: uuid.optional(), status: z.string().optional(), ...Paging }), query);
    return this.tx(user, (tx) => this.svc.entries(tx, user, q));
  }

  @Get('summary')
  @RequirePermissions(P.SALES_COMMISSIONS_VIEW)
  summary(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(z.object({ from: isoDate.optional(), to: isoDate.optional() }), query);
    return this.tx(user, (tx) => this.svc.summary(tx, user, q));
  }

  @Post('adjustments')
  @RequirePermissions(P.SALES_COMMISSIONS_MANAGE)
  adjust(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(z.object({ salesRepId: uuid, periodMonth: isoDate, amount: decimalString, notes: z.string().min(3).max(1000) }), body);
    return this.tx(user, (tx) => this.svc.adjust(tx, user, i));
  }

  @Post('run-clawbacks')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.SALES_COMMISSIONS_MANAGE)
  clawbacks(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const { asOf } = parse(z.object({ asOf: isoDate.optional() }), body ?? {});
    return this.tx(user, (tx) => this.svc.runClawbacks(tx, asOf ?? businessDate(user.timezone)));
  }

  @Post('approve')
  @HttpCode(HttpStatus.OK)
  @RequireModules(MODULES.ACCOUNTING)
  @RequirePermissions(P.SALES_COMMISSIONS_MANAGE)
  approve(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(z.object({ periodMonth: isoDate, salesRepId: uuid.optional() }), body);
    return this.tx(user, (tx) => this.svc.approve(tx, user, i));
  }

  @Post('payroll-batches')
  @RequirePermissions(P.SALES_COMMISSIONS_MANAGE)
  sendToPayroll(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const { periodMonth } = parse(z.object({ periodMonth: isoDate }), body);
    return this.tx(user, (tx) => this.svc.sendToPayroll(tx, user, periodMonth));
  }
}

/** The HR & Payroll side of the commission hand-off. */
@RequireModules(MODULES.HR_PAYROLL)
@Controller('hr/payroll/commission-batches')
export class PayrollHandoffController extends Base {
  constructor(db: DatabaseService, private readonly svc: CommissionsService) {
    super(db);
  }

  @Get()
  @RequirePermissions(P.HR_PAYROLL_MANAGE)
  list(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const { status } = parse(z.object({ status: z.enum(['SENT', 'PAID', 'CANCELLED']).optional() }), query);
    return this.tx(user, (tx) => this.svc.listBatches(tx, status));
  }

  @Get(':id')
  @RequirePermissions(P.HR_PAYROLL_MANAGE)
  get(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tx(user, (tx) => this.svc.batch(tx, id));
  }

  @Post(':id/paid')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(P.HR_PAYROLL_MANAGE)
  paid(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { hrReference } = parse(z.object({ hrReference: z.string().min(1).max(100) }), body);
    return this.tx(user, (tx) => this.svc.markBatchPaid(tx, user, id, hrReference));
  }
}
