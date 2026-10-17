import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { MODULE_CATALOG, MODULES, ModuleCode } from '@ckh/shared';
import { z } from 'zod';
import { CurrentAdmin, PlatformAdmin, PlatformOnly } from '../../common/auth-context';
import { AuditService } from '../../common/audit.service';
import { DomainError, notFound } from '../../common/errors';
import { isValidTimeZone } from '../../common/business-time';
import { newPassword, parse } from '../../common/validation';
import { DatabaseService, Tx } from '../../db/database.service';
import { TenantProvisioningService, validateModuleSet } from './tenant-provisioning.service';

const moduleCode = z.enum(Object.values(MODULES) as [ModuleCode, ...ModuleCode[]]);

const CreateTenant = z.object({
  code: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  name: z.string().min(2).max(200),
  baseCurrency: z.string().length(3).default('USD'),
  countryCode: z.string().length(2).default('KH'),
  timezone: z.string().min(1).max(64).optional(),
  admin: z.object({ email: z.string().email(), password: newPassword, fullName: z.string().min(1).max(200) }),
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

const PosLicenseInput = z.object({
  maxBranches: z.number().int().min(0).max(10000).nullable(),
  maxRegisters: z.number().int().min(0).max(100000).nullable(),
  maxDevices: z.number().int().min(0).max(100000).nullable(),
  offlineValidityHours: z.number().int().min(1).max(720),
  notes: z.string().max(500).nullable().optional(),
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
        `SELECT t.id, t.code, t.name, t.status, t.timezone, t.country_code, t.created_at,
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
    if (input.modules.some((m) => m.code === MODULES.CORE && (!m.enabled || m.endsAt))) {
      throw new DomainError('CORE_REQUIRED', 'The Core Platform module cannot be switched off; suspend the company instead', 422);
    }
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

  /** POS licence limits for a company (POS_SALES itself is switched on with the modules endpoint). */
  @Get('tenants/:tenantId/pos-license')
  posLicense(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.db.withPlatform(null, async (tx) => {
      const t = await tx.maybeOne('SELECT id FROM tenants WHERE id = $1', [tenantId]);
      if (!t) throw notFound('Tenant');
      const lic = await tx.maybeOne('SELECT * FROM pos_licenses WHERE tenant_id = $1', [tenantId]);
      const usage = await this.posUsageRow(tx, tenantId);
      const module = await tx.maybeOne(`SELECT enabled, ends_at FROM tenant_modules WHERE tenant_id = $1 AND module_code = 'POS_SALES'`, [tenantId]);
      return { tenantId, enabled: !!module?.enabled, moduleEndsAt: module?.ends_at ?? null, license: lic, usage };
    });
  }

  @Put('tenants/:tenantId/pos-license')
  setPosLicense(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() body: unknown, @CurrentAdmin() admin: PlatformAdmin) {
    const i = parse(PosLicenseInput, body);
    return this.db.withPlatform(admin.adminId, async (tx) => {
      const t = await tx.maybeOne('SELECT id FROM tenants WHERE id = $1', [tenantId]);
      if (!t) throw notFound('Tenant');
      const before = await tx.maybeOne('SELECT * FROM pos_licenses WHERE tenant_id = $1', [tenantId]);
      const after = await tx.one(
        `INSERT INTO pos_licenses (tenant_id, max_branches, max_registers, max_devices, offline_validity_hours, notes, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (tenant_id) DO UPDATE SET max_branches = EXCLUDED.max_branches, max_registers = EXCLUDED.max_registers,
           max_devices = EXCLUDED.max_devices, offline_validity_hours = EXCLUDED.offline_validity_hours, notes = EXCLUDED.notes,
           updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING *`,
        [tenantId, i.maxBranches, i.maxRegisters, i.maxDevices, i.offlineValidityHours, i.notes ?? null, admin.adminId],
      );
      await this.audit.record(tx, { actorType: 'PLATFORM_ADMIN', tenantId, action: 'POS_LICENSE_CHANGED', entityType: 'pos_license', entityId: tenantId, before, after });
      return after;
    });
  }

  /** POS usage across all companies: registers, devices, sales in the last 30 days, last sync. */
  @Get('pos/usage')
  posUsage() {
    return this.db.withPlatform(null, async (tx) => {
      const tenants = await tx.query<{ id: string; code: string; name: string; status: string }>(
        `SELECT t.id, t.code, t.name, t.status FROM tenants t
          WHERE EXISTS (SELECT 1 FROM tenant_modules m WHERE m.tenant_id = t.id AND m.module_code = 'POS_SALES' AND m.enabled)
          ORDER BY t.name`,
      );
      const out = [];
      for (const t of tenants) out.push({ ...t, ...(await this.posUsageRow(tx, t.id)), license: await tx.maybeOne('SELECT * FROM pos_licenses WHERE tenant_id = $1', [t.id]) });
      return out;
    });
  }

  private async posUsageRow(tx: Tx, tenantId: string) {
    return tx.one(
      `SELECT (SELECT count(*)::int FROM pos_registers WHERE tenant_id = $1 AND status = 'ACTIVE') AS registers,
              (SELECT count(DISTINCT branch_id)::int FROM pos_registers WHERE tenant_id = $1 AND status = 'ACTIVE') AS branches,
              (SELECT count(*)::int FROM pos_devices WHERE tenant_id = $1 AND status = 'ACTIVE') AS devices,
              (SELECT count(*)::int FROM pos_sales WHERE tenant_id = $1 AND sold_at > now() - interval '30 days') AS sales_30d,
              (SELECT COALESCE(sum(grand_total), 0) FROM pos_sales WHERE tenant_id = $1 AND sold_at > now() - interval '30 days') AS sales_total_30d,
              (SELECT max(sold_at) FROM pos_sales WHERE tenant_id = $1) AS last_sale_at,
              (SELECT max(last_sync_at) FROM pos_devices WHERE tenant_id = $1) AS last_device_sync_at,
              (SELECT count(*)::int FROM pos_sync_events WHERE tenant_id = $1 AND status IN ('REJECTED', 'CONFLICT')) AS sync_problems`,
      [tenantId],
    );
  }

  /** Company settings the platform owns: business time zone and country. */
  @Put('tenants/:tenantId/settings')
  setSettings(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() body: unknown, @CurrentAdmin() admin: PlatformAdmin) {
    const input = parse(z.object({ timezone: z.string().min(1).max(64).optional(), countryCode: z.string().length(2).optional() }), body);
    if (input.timezone && !isValidTimeZone(input.timezone)) throw new DomainError('INVALID_TIMEZONE', `Unknown time zone ${input.timezone}`, 422);
    return this.db.withPlatform(admin.adminId, async (tx) => {
      const r = await tx.maybeOne(
        `UPDATE tenants SET timezone = COALESCE($2, timezone), country_code = COALESCE($3, country_code)
          WHERE id = $1 RETURNING id, timezone, country_code`,
        [tenantId, input.timezone ?? null, input.countryCode?.toUpperCase() ?? null],
      );
      if (!r) throw notFound('Tenant');
      this.db.forgetTimezone(tenantId);
      await this.audit.record(tx, { actorType: 'PLATFORM_ADMIN', tenantId, action: 'TENANT_SETTINGS_CHANGED', entityType: 'tenant', entityId: tenantId, after: input });
      return r;
    });
  }
}
