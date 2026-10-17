import { Controller, Get, Param, Query, Res } from '@nestjs/common';
interface Response { setHeader(name: string, value: string): void; end(body: Buffer): void }
import { MODULES, P } from '@ckh/shared';
import { z } from 'zod';
import { CurrentUser, RequireModules, RequirePermissions, TenantUser } from '../../common/auth-context';
import { isoDate, parse, uuid } from '../../common/validation';
import { DatabaseService } from '../../db/database.service';
import { SubscriptionService } from '../../core/subscriptions/subscription.service';
import { reportToPdf, reportToXlsx } from './report-export';
import { ReportsService } from './reports.service';

const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01`;
const today = () => new Date().toISOString().slice(0, 10);
const Range = { from: isoDate.optional(), to: isoDate.optional() };
const ReportQuery = z.object({
  ...Range,
  salesRepId: uuid.optional(),
  teamId: uuid.optional(),
  territoryId: uuid.optional(),
  customerId: uuid.optional(),
  format: z.enum(['json', 'xlsx', 'pdf']).default('json'),
});

@RequireModules(MODULES.SALES_TEAM_BASIC)
@Controller('sales')
export class ReportsController {
  constructor(private readonly db: DatabaseService, private readonly svc: ReportsService, private readonly subs: SubscriptionService) {}

  @Get('dashboard')
  @RequirePermissions(P.SALES_DASHBOARD_VIEW)
  dashboard(@CurrentUser() user: TenantUser) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.svc.dashboard(tx, user));
  }

  @Get('team-performance')
  @RequirePermissions(P.SALES_DASHBOARD_VIEW)
  team(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(z.object({ ...Range, teamId: uuid.optional() }), query);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.svc.teamPerformance(tx, user, { from: q.from ?? monthStart(), to: q.to ?? today(), teamId: q.teamId }));
  }

  @Get('territory-map')
  @RequireModules(MODULES.SALES_TERRITORY_MANAGEMENT)
  @RequirePermissions(P.SALES_DASHBOARD_VIEW)
  map(@CurrentUser() user: TenantUser, @Query() query: unknown) {
    const q = parse(z.object({ ...Range, includeVisits: z.coerce.boolean().default(false) }), query);
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.svc.territoryMap(tx, user, { from: q.from ?? monthStart(), to: q.to ?? today(), includeVisits: q.includeVisits }));
  }

  @Get('reports')
  @RequirePermissions(P.SALES_REPORTS_VIEW)
  async catalog(@CurrentUser() user: TenantUser) {
    const ent = await this.subs.entitlements(user.tenantId);
    return this.svc.catalog(user, ent.modules);
  }

  @Get('reports/:code')
  @RequirePermissions(P.SALES_REPORTS_VIEW)
  async report(@CurrentUser() user: TenantUser, @Param('code') code: string, @Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    const { format, ...q } = parse(ReportQuery, query);
    const report = await this.db.withTenant(user.tenantId, user.userId, (tx) =>
      this.svc.run(tx, user, code, { ...q, from: q.from ?? monthStart(), to: q.to ?? today() }),
    );
    if (format === 'json') return report;
    const name = `${code}_${report.filters.from}_${report.filters.to}`;
    if (format === 'xlsx') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
      res.end(await reportToXlsx(report));
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`);
    res.end(await reportToPdf(report));
  }
}
