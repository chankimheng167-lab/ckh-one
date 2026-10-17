import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { MODULES, P } from '@ckh/shared';
import { CurrentUser, RequireModules, RequirePermissions, TenantUser } from '../../common/auth-context';
import { parse } from '../../common/validation';
import { DatabaseService } from '../../db/database.service';
import { BootstrapQuery, SyncBatch, SyncHistoryQuery, SyncService } from './sync.service';

/** Offline field app: download a working snapshot, then push the outbox when back online. */
@RequireModules(MODULES.SALES_OFFLINE_ORDERING, MODULES.SALES_TEAM_BASIC)
@Controller('sales/sync')
export class SyncController {
  constructor(private readonly db: DatabaseService, private readonly svc: SyncService) {}

  @Get('bootstrap')
  @RequirePermissions(P.SALES_CATALOG_VIEW)
  bootstrap(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(BootstrapQuery, query);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.svc.bootstrap(tx, user, q));
  }

  /** Per-event outcomes; the HTTP status is 200 even when some events are rejected. */
  @Post()
  @HttpCode(HttpStatus.OK)
  push(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    return this.svc.push(user, parse(SyncBatch, body));
  }

  @Get('history')
  history(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(SyncHistoryQuery, query);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.svc.history(tx, user, q));
  }
}
