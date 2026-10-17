import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ALL_TENANT_PERMISSIONS, MODULES, P } from '@ckh/shared';
import * as bcrypt from 'bcryptjs';
import { z } from 'zod';
import { CurrentUser, RequireModules, RequirePermissions, TenantUser } from '../../common/auth-context';
import { AuditService } from '../../common/audit.service';
import { DomainError, notFound } from '../../common/errors';
import { decimalString, parse, uuid } from '../../common/validation';
import { DatabaseService } from '../../db/database.service';

const CreateUser = z.object({
  email: z.string().email(),
  fullName: z.string().min(1).max(200),
  phone: z.string().max(40).optional(),
  password: z.string().min(10).max(200),
  roleCodes: z.array(z.string()).min(1),
  warehouseIds: z.array(uuid).default([]),
});

const CreateTeam = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
  parentTeamId: uuid.optional(),
  supervisorUserId: uuid.optional(),
  managerUserId: uuid.optional(),
  branchId: uuid.optional(),
});

const CreateRep = z.object({
  userId: uuid,
  employeeCode: z.string().min(1).max(40),
  teamId: uuid.optional(),
  defaultBranchId: uuid.optional(),
  defaultWarehouseId: uuid.optional(),
  maxDiscountPercent: decimalString.nullable().optional(),
});

const SalesSettingsInput = z.object({
  approvalLimits: z
    .object({
      repMaxDiscountPercent: decimalString,
      supervisorMaxDiscountPercent: decimalString,
      managerMaxDiscountPercent: decimalString,
      managerOrderAmountThreshold: decimalString.nullable(),
      directorOrderAmountThreshold: decimalString.nullable(),
    })
    .refine(
      (l) => Number(l.repMaxDiscountPercent) <= Number(l.supervisorMaxDiscountPercent) && Number(l.supervisorMaxDiscountPercent) <= Number(l.managerMaxDiscountPercent),
      'Limits must increase: rep ≤ supervisor ≤ manager',
    )
    .optional(),
  workflow: z.object({ pickPackEnabled: z.boolean(), invoiceOnDispatch: z.boolean() }).optional(),
  allowPriceOverride: z.boolean().optional(),
  allowBackorders: z.boolean().optional(),
  showBalancesToReps: z.boolean().optional(),
  visitLocationCapture: z.enum(['OFF', 'ASK', 'REQUIRED']).optional(),
  offlineCatalogMaxAgeHours: z.number().int().min(1).max(720).optional(),
});

@Controller('admin')
export class TenantAdminController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  @Get('roles')
  @RequirePermissions(P.TENANT_ROLES_MANAGE)
  roles(@CurrentUser() user: TenantUser) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.query(
        `SELECT r.id, r.code, r.name, r.approval_level, r.is_system, array_agg(rp.permission_code ORDER BY rp.permission_code) AS permissions
           FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id GROUP BY r.id ORDER BY r.name`,
      ),
    );
  }

  @Put('roles/:id')
  @RequirePermissions(P.TENANT_ROLES_MANAGE)
  updateRole(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(
      z.object({
        permissions: z.array(z.string()).refine((ps) => ps.every((p) => (ALL_TENANT_PERMISSIONS as string[]).includes(p)), 'Unknown permission'),
        approvalLevel: z.number().int().min(0).max(3),
      }),
      body,
    );
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const role = await tx.maybeOne('SELECT id, code FROM roles WHERE id = $1 FOR UPDATE', [id]);
      if (!role) throw notFound('Role');
      if (role.code === 'TENANT_ADMIN' && !input.permissions.includes(P.TENANT_ROLES_MANAGE)) {
        throw new DomainError('LOCKOUT_PREVENTED', 'The administrator role must keep role management permission', 422);
      }
      await tx.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
      await tx.query('INSERT INTO role_permissions (tenant_id, role_id, permission_code) SELECT current_tenant_id(), $1, unnest($2::text[])', [id, input.permissions]);
      await tx.query('UPDATE roles SET approval_level = $2 WHERE id = $1', [id, input.approvalLevel]);
      await this.audit.record(tx, { action: 'ROLE_UPDATED', entityType: 'role', entityId: id, after: input });
      return { id, ...input };
    });
  }

  @Post('users')
  @RequirePermissions(P.TENANT_USERS_MANAGE)
  createUser(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const input = parse(CreateUser, body);
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const roles = await tx.query<{ id: string; code: string }>('SELECT id, code FROM roles WHERE code = ANY($1::text[])', [input.roleCodes]);
      if (roles.length !== input.roleCodes.length) throw new DomainError('UNKNOWN_ROLE', 'One or more roles do not exist', 422);
      const hash = await bcrypt.hash(input.password, 10);
      const u = await tx.one<{ id: string }>(
        'INSERT INTO users (tenant_id, email, password_hash, full_name, phone) VALUES (current_tenant_id(), $1, $2, $3, $4) RETURNING id',
        [input.email, hash, input.fullName, input.phone ?? null],
      );
      await tx.query('INSERT INTO user_roles (tenant_id, user_id, role_id) SELECT current_tenant_id(), $1, unnest($2::uuid[])', [u.id, roles.map((r) => r.id)]);
      if (input.warehouseIds.length) {
        await tx.query('INSERT INTO user_warehouse_access (tenant_id, user_id, warehouse_id) SELECT current_tenant_id(), $1, unnest($2::uuid[])', [u.id, input.warehouseIds]);
      }
      await this.audit.record(tx, { action: 'USER_CREATED', entityType: 'user', entityId: u.id, after: { email: input.email, roles: input.roleCodes } });
      return { id: u.id, email: input.email, roles: input.roleCodes };
    });
  }

  @Put('users/:id/status')
  @RequirePermissions(P.TENANT_USERS_MANAGE)
  setUserStatus(@CurrentUser() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { status } = parse(z.object({ status: z.enum(['ACTIVE', 'DISABLED']) }), body);
    if (id === user.userId && status === 'DISABLED') throw new DomainError('LOCKOUT_PREVENTED', 'You cannot disable yourself', 422);
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const r = await tx.maybeOne('UPDATE users SET status = $2 WHERE id = $1 RETURNING id, status', [id, status]);
      if (!r) throw notFound('User');
      await this.audit.record(tx, { action: 'USER_STATUS_CHANGED', entityType: 'user', entityId: id, after: { status } });
      return r;
    });
  }

  @Post('sales/teams')
  @RequireModules(MODULES.SALES_TEAM_BASIC)
  @RequirePermissions(P.SALES_TEAMS_MANAGE)
  createTeam(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(CreateTeam, body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.one(
        `INSERT INTO sales_teams (tenant_id, code, name, parent_team_id, supervisor_user_id, manager_user_id, branch_id)
         VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6) RETURNING *`,
        [i.code, i.name, i.parentTeamId ?? null, i.supervisorUserId ?? null, i.managerUserId ?? null, i.branchId ?? null],
      ),
    );
  }

  @Post('sales/representatives')
  @RequireModules(MODULES.SALES_TEAM_BASIC)
  @RequirePermissions(P.SALES_TEAMS_MANAGE)
  createRep(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(CreateRep, body);
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const rep = await tx.one(
        `INSERT INTO sales_representatives (tenant_id, user_id, employee_code, team_id, default_branch_id, default_warehouse_id, max_discount_percent)
         VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6) RETURNING *`,
        [i.userId, i.employeeCode, i.teamId ?? null, i.defaultBranchId ?? null, i.defaultWarehouseId ?? null, i.maxDiscountPercent ?? null],
      );
      await this.audit.record(tx, { action: 'SALES_REP_CREATED', entityType: 'sales_representative', entityId: rep.id, after: rep });
      return rep;
    });
  }

  @Get('sales/settings')
  @RequireModules(MODULES.SALES_TEAM_BASIC)
  @RequirePermissions(P.SALES_SETTINGS_MANAGE)
  getSettings(@CurrentUser() user: TenantUser) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) => tx.one('SELECT * FROM sales_settings WHERE tenant_id = current_tenant_id()'));
  }

  @Put('sales/settings')
  @RequireModules(MODULES.SALES_TEAM_BASIC)
  @RequirePermissions(P.SALES_SETTINGS_MANAGE)
  putSettings(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(SalesSettingsInput, body);
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const before = await tx.one('SELECT * FROM sales_settings WHERE tenant_id = current_tenant_id() FOR UPDATE');
      const after = await tx.one(
        `UPDATE sales_settings SET
           approval_limits = COALESCE($1::jsonb, approval_limits),
           workflow = COALESCE($2::jsonb, workflow),
           allow_price_override = COALESCE($3, allow_price_override),
           allow_backorders = COALESCE($4, allow_backorders),
           show_balances_to_reps = COALESCE($5, show_balances_to_reps),
           visit_location_capture = COALESCE($6, visit_location_capture),
           offline_catalog_max_age_hours = COALESCE($7, offline_catalog_max_age_hours),
           updated_at = now()
         WHERE tenant_id = current_tenant_id() RETURNING *`,
        [
          i.approvalLimits ? JSON.stringify(i.approvalLimits) : null,
          i.workflow ? JSON.stringify(i.workflow) : null,
          i.allowPriceOverride ?? null,
          i.allowBackorders ?? null,
          i.showBalancesToReps ?? null,
          i.visitLocationCapture ?? null,
          i.offlineCatalogMaxAgeHours ?? null,
        ],
      );
      await this.audit.record(tx, { action: 'SALES_SETTINGS_UPDATED', entityType: 'sales_settings', before, after });
      return after;
    });
  }

  @Get('accounting/settings')
  @RequireModules(MODULES.ACCOUNTING)
  @RequirePermissions(P.TENANT_SETTINGS_MANAGE)
  getAccountingSettings(@CurrentUser() user: TenantUser) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) => tx.one('SELECT * FROM accounting_settings WHERE tenant_id = current_tenant_id()'));
  }

  /** When revenue is recognised: ON_INVOICE (accountant raises invoices) or ON_DELIVERY (automatic on proof of delivery). */
  @Put('accounting/settings')
  @RequireModules(MODULES.ACCOUNTING)
  @RequirePermissions(P.TENANT_SETTINGS_MANAGE)
  putAccountingSettings(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(z.object({ revenueRecognition: z.enum(['ON_INVOICE', 'ON_DELIVERY']) }), body);
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const after = await tx.one(
        'UPDATE accounting_settings SET revenue_recognition = $1 WHERE tenant_id = current_tenant_id() RETURNING *',
        [i.revenueRecognition],
      );
      await this.audit.record(tx, { action: 'ACCOUNTING_SETTINGS_UPDATED', entityType: 'accounting_settings', after: i });
      return after;
    });
  }
}
