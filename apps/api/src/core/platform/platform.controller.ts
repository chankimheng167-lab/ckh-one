import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { MODULE_CATALOG, MODULES, ModuleCode } from '@ckh/shared';
import { z } from 'zod';
import { CurrentAdmin, PlatformAdmin, PlatformOnly } from '../../common/auth-context';
import { AuditService } from '../../common/audit.service';
import { notFound } from '../../common/errors';
import { parse } from '../../common/validation';
import { DatabaseService } from '../../db/database.service';
import { TenantProvisioningService, validateModuleSet } from './tenant-provisioning.service';

const moduleCode = z.enum(Object.values(MODULES) as [ModuleCode, ...ModuleCode[]]);

const CreateTenant = z.object({
  code: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  name: z.string().min(2).max(200),
  baseCurrency: z.string().length(3).default('USD'),
  admin: z.object({ email: z.string().email(), password: z.string().min(10).max(200), fullName: z.string().min(1).max(200) }),
  modules: z.array(moduleCode).default([]),
  subscription: z.object({
    status: z.enum(['TRIAL', 'ACTIVE']),
    endsAt: z.string().datetime().nullable(),
    graceDays: z.number().int().min(0).max(90).default(7),
    planCode: z.string().optional(),
  }),
});

const SetModules = z.object({
  modules: z.array(
    z.object({ code: moduleCode, enabled: z.boolean(), endsAt: z.string().datetime().nullable().optional() }),
  ),
});

const SetSubscription = z.object({
  status: z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'EXPIRED', 'CANCELLED']),
  endsAt: z.string().datetime().nullable(),
  graceDays: z.number().int().min(0).max(90).default(0),
});

/** Super Admin portal API (platform owner). */
@PlatformOnly()
@Controller('platform')
export class PlatformController {
  constructor(
    private readonly db: DatabaseService,
    private readonly provisioning: TenantProvisioningService,
    private readonly audit: AuditService,
  ) {}

  @Get('modules')
  modules() {
    return MODULE_CATALOG;
  }

  @Get('tenants')
  tenants() {
    return this.db.withPlatform(null, (tx) =>
      tx.query(
        `SELECT t.id, t.code, t.name, t.status, t.created_at,
                s.status AS subscription_status, s.ends_at,
                (SELECT array_agg(module_code ORDER BY module_code) FROM tenant_modules m WHERE m.tenant_id = t.id AND m.enabled) AS modules
           FROM tenants t
           LEFT JOIN LATERAL (SELECT status, ends_at FROM tenant_subscriptions ts WHERE ts.tenant_id = t.id ORDER BY starts_at DESC LIMIT 1) s ON true
          ORDER BY t.created_at DESC`,
      ),
    );
  }

  @Post('tenants')
  createTenant(@Body() body: unknown, @CurrentAdmin() admin: PlatformAdmin) {
    const input = parse(CreateTenant, body);
    return this.db.withPlatform(admin.adminId, async (tx) => {
      const result = await this.provisioning.createTenant(tx, input);
      await this.audit.record(tx, {
        actorType: 'PLATFORM_ADMIN',
        tenantId: result.tenantId,
        action: 'TENANT_CREATED',
        entityType: 'tenant',
        entityId: result.tenantId,
        after: { code: input.code, modules: input.modules, subscription: input.subscription },
      });
      return result;
    });
  }

  /** Activate / deactivate subscription modules for a tenant. */
  @Put('tenants/:tenantId/modules')
  setModules(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() body: unknown, @CurrentAdmin() admin: PlatformAdmin) {
    const input = parse(SetModules, body);
    return this.db.withPlatform(admin.adminId, async (tx) => {
      const exists = await tx.maybeOne('SELECT 1 FROM tenants WHERE id = $1', [tenantId]);
      if (!exists) throw notFound('Tenant');
      const before = await tx.query('SELECT module_code, enabled, ends_at FROM tenant_modules WHERE tenant_id = $1', [tenantId]);
      for (const m of input.modules) {
        await tx.query(
          `INSERT INTO tenant_modules (tenant_id, module_code, enabled, ends_at, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (tenant_id, module_code) DO UPDATE
             SET enabled = EXCLUDED.enabled, ends_at = EXCLUDED.ends_at, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [tenantId, m.code, m.enabled, m.endsAt ?? null, admin.adminId],
        );
      }
      const after = await tx.query<{ module_code: string }>(
        'SELECT module_code FROM tenant_modules WHERE tenant_id = $1 AND enabled ORDER BY module_code',
        [tenantId],
      );
      // Reject combinations whose prerequisites are switched off.
      validateModuleSet(after.map((r) => r.module_code));
      await this.audit.record(tx, {
        actorType: 'PLATFORM_ADMIN',
        tenantId,
        action: 'TENANT_MODULES_CHANGED',
        entityType: 'tenant',
        entityId: tenantId,
        before,
        after: input.modules,
      });
      return { tenantId, enabledModules: after.map((r) => r.module_code) };
    });
  }

  @Put('tenants/:tenantId/subscription')
  setSubscription(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() body: unknown, @CurrentAdmin() admin: PlatformAdmin) {
    const input = parse(SetSubscription, body);
    return this.db.withPlatform(admin.adminId, async (tx) => {
      const current = await tx.maybeOne<{ id: string }>(
        `SELECT id FROM tenant_subscriptions WHERE tenant_id = $1 ORDER BY starts_at DESC LIMIT 1`,
        [tenantId],
      );
      if (!current) throw notFound('Subscription');
      await tx.query(
        `UPDATE tenant_subscriptions
            SET status = $2, ends_at = $3::timestamptz,
                grace_ends_at = $3::timestamptz + make_interval(days => $4)
          WHERE id = $1`,
        [current.id, input.status, input.endsAt, input.graceDays],
      );
      await this.audit.record(tx, {
        actorType: 'PLATFORM_ADMIN',
        tenantId,
        action: 'SUBSCRIPTION_CHANGED',
        entityType: 'tenant_subscription',
        entityId: current.id,
        after: input,
      });
      return { tenantId, ...input };
    });
  }

  @Put('tenants/:tenantId/status')
  setStatus(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() body: unknown, @CurrentAdmin() admin: PlatformAdmin) {
    const { status } = parse(z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']) }), body);
    return this.db.withPlatform(admin.adminId, async (tx) => {
      const r = await tx.maybeOne('UPDATE tenants SET status = $2 WHERE id = $1 RETURNING id, status', [tenantId, status]);
      if (!r) throw notFound('Tenant');
      await this.audit.record(tx, { actorType: 'PLATFORM_ADMIN', tenantId, action: 'TENANT_STATUS_CHANGED', entityType: 'tenant', entityId: tenantId, after: { status } });
      return r;
    });
  }
}
