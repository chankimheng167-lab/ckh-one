import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { DEFAULT_ROLES, MODULE_CATALOG, ModuleCode, APPROVAL_LEVEL } from '@ckh/shared';
import { defaultTimeZoneFor, isValidTimeZone } from '../../common/business-time';
import { DomainError } from '../../common/errors';
import type { Tx } from '../../db/database.service';

export interface NewTenantInput {
  code: string;
  name: string;
  baseCurrency?: string;
  countryCode?: string;
  /** IANA zone for business dates; defaults from the country (Asia/Phnom_Penh for KH). */
  timezone?: string;
  admin: { email: string; password: string; fullName: string };
  modules: ModuleCode[];
  subscription: { status: 'TRIAL' | 'ACTIVE'; endsAt: string | null; graceDays?: number; planCode?: string };
}

const ROLE_APPROVAL_LEVEL: Record<string, number> = {
  TENANT_ADMIN: APPROVAL_LEVEL.DIRECTOR,
  SALES_MANAGER: APPROVAL_LEVEL.MANAGER,
  SALES_SUPERVISOR: APPROVAL_LEVEL.SUPERVISOR,
  POS_SUPERVISOR: APPROVAL_LEVEL.SUPERVISOR,
  POS_MANAGER: APPROVAL_LEVEL.MANAGER,
  BRANCH_ADMIN: APPROVAL_LEVEL.MANAGER,
};

/** Validates that every module's prerequisites are also enabled. */
export function validateModuleSet(modules: string[]): void {
  const set = new Set(modules);
  for (const m of modules) {
    const def = MODULE_CATALOG.find((d) => d.code === m);
    if (!def) throw new DomainError('UNKNOWN_MODULE', `Unknown module ${m}`, 422);
    const missing = def.requires.filter((r) => !set.has(r));
    if (missing.length) {
      throw new DomainError('MODULE_DEPENDENCY', `${m} requires ${missing.join(', ')}`, 422, { module: m, missing });
    }
  }
}

/**
 * Creates a ready-to-use company: default roles, settings, numbering, tax,
 * unit, price list, branch, warehouse, chart of accounts, subscription and
 * the first administrator. Must run inside a platform-admin transaction.
 */
@Injectable()
export class TenantProvisioningService {
  async createTenant(tx: Tx, input: NewTenantInput): Promise<{ tenantId: string; adminUserId: string }> {
    const modules = Array.from(new Set<ModuleCode>(['CORE', ...input.modules]));
    validateModuleSet(modules);
    const currency = input.baseCurrency ?? 'USD';
    const country = (input.countryCode ?? 'KH').toUpperCase();
    const timezone = input.timezone ?? defaultTimeZoneFor(country);
    if (!isValidTimeZone(timezone)) throw new DomainError('INVALID_TIMEZONE', `Unknown time zone ${timezone}`, 422);

    const { id: tenantId } = await tx.one<{ id: string }>(
      'INSERT INTO tenants (code, name, base_currency, country_code, timezone) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [input.code.toLowerCase(), input.name, currency, country, timezone],
    );

    // Roles and permissions
    const roleIds: Record<string, string> = {};
    for (const [code, def] of Object.entries(DEFAULT_ROLES)) {
      const r = await tx.one<{ id: string }>(
        `INSERT INTO roles (tenant_id, code, name, approval_level, is_system) VALUES ($1, $2, $3, $4, true) RETURNING id`,
        [tenantId, code, def.name, ROLE_APPROVAL_LEVEL[code] ?? 0],
      );
      roleIds[code] = r.id;
      await tx.query(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_code) SELECT $1, $2, unnest($3::text[])`,
        [tenantId, r.id, def.permissions],
      );
    }

    // First administrator
    const hash = await bcrypt.hash(input.admin.password, 10);
    const { id: adminUserId } = await tx.one<{ id: string }>(
      'INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, $2, $3, $4) RETURNING id',
      [tenantId, input.admin.email, hash, input.admin.fullName],
    );
    await tx.query('INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)', [tenantId, adminUserId, roleIds.TENANT_ADMIN]);

    // Defaults
    await tx.query('INSERT INTO sales_settings (tenant_id) VALUES ($1)', [tenantId]);
    await tx.query(
      `INSERT INTO document_sequences (tenant_id, doc_type, prefix) VALUES
         ($1, 'SALES_ORDER', 'SO-{YYYY}-'), ($1, 'SALES_QUOTATION', 'QT-{YYYY}-'),
         ($1, 'INVOICE', 'INV-{YYYY}-'), ($1, 'RECEIPT', 'RC-{YYYY}-'),
         ($1, 'CREDIT_NOTE', 'CN-{YYYY}-'), ($1, 'COLLECTION', 'COL-{YYYY}-'),
         ($1, 'JOURNAL', 'JV-{YYYY}-'), ($1, 'DELIVERY', 'DN-{YYYY}-'),
         ($1, 'SALES_RETURN', 'RMA-{YYYY}-'), ($1, 'PAYROLL_BATCH', 'PCB-{YYYY}-')`,
      [tenantId],
    );
    await tx.query(
      `INSERT INTO tax_codes (tenant_id, code, name, rate_percent, is_default) VALUES
         ($1, 'VAT10', 'VAT 10%', 10, true), ($1, 'EXEMPT', 'VAT exempt', 0, false)`,
      [tenantId],
    );
    await tx.query(`INSERT INTO units (tenant_id, code, name) VALUES ($1, 'PCS', 'Piece')`, [tenantId]);
    await tx.query(
      `INSERT INTO price_lists (tenant_id, code, name, currency, is_default) VALUES ($1, 'STANDARD', 'Standard price', $2, true)`,
      [tenantId, currency],
    );
    const { id: branchId } = await tx.one<{ id: string }>(
      `INSERT INTO branches (tenant_id, code, name) VALUES ($1, 'HQ', 'Head Office') RETURNING id`,
      [tenantId],
    );
    await tx.query(`INSERT INTO warehouses (tenant_id, branch_id, code, name) VALUES ($1, $2, 'MAIN', 'Main Warehouse')`, [tenantId, branchId]);

    await this.seedChartOfAccounts(tx, tenantId);
    // POS defaults (accounts, settings, payment methods, licence row, numbering); see migration 0009.
    await tx.query('SELECT pos_provision_tenant($1)', [tenantId]);

    // Subscription
    const plan = input.subscription.planCode
      ? await tx.maybeOne<{ id: string }>('SELECT id FROM subscription_plans WHERE code = $1', [input.subscription.planCode])
      : null;
    await tx.query(
      `INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, starts_at, ends_at, grace_ends_at)
       VALUES ($1, $2, $3, now(), $4::timestamptz, $4::timestamptz + make_interval(days => $5))`,
      [tenantId, plan?.id ?? null, input.subscription.status, input.subscription.endsAt, input.subscription.graceDays ?? 0],
    );
    await tx.query(
      `INSERT INTO tenant_modules (tenant_id, module_code, enabled, updated_by) SELECT $1, unnest($2::text[]), true, $3`,
      [tenantId, modules, tx.userId || null],
    );
    return { tenantId, adminUserId };
  }

  private async seedChartOfAccounts(tx: Tx, tenantId: string) {
    const accounts: [string, string, string][] = [
      ['1000', 'Cash on hand', 'ASSET'],
      ['1010', 'Bank', 'ASSET'],
      ['1100', 'Accounts receivable', 'ASSET'],
      ['1200', 'Inventory', 'ASSET'],
      ['2100', 'VAT output payable', 'LIABILITY'],
      ['2200', 'Commissions payable', 'LIABILITY'],
      ['3000', "Owner's equity", 'EQUITY'],
      ['4000', 'Sales revenue', 'REVENUE'],
      ['4100', 'Sales discounts', 'REVENUE'],
      ['5000', 'Cost of goods sold', 'EXPENSE'],
      ['6100', 'Sales commissions', 'EXPENSE'],
    ];
    const ids: Record<string, string> = {};
    for (const [code, name, type] of accounts) {
      const r = await tx.one<{ id: string }>(
        'INSERT INTO chart_of_accounts (tenant_id, code, name, account_type) VALUES ($1, $2, $3, $4) RETURNING id',
        [tenantId, code, name, type],
      );
      ids[code] = r.id;
    }
    await tx.query(
      `INSERT INTO accounting_settings (tenant_id, cash_account_id, bank_account_id, ar_account_id, inventory_account_id,
         vat_output_account_id, commission_payable_account_id, revenue_account_id, sales_discount_account_id,
         cogs_account_id, commission_expense_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [tenantId, ids['1000'], ids['1010'], ids['1100'], ids['1200'], ids['2100'], ids['2200'], ids['4000'], ids['4100'], ids['5000'], ids['6100']],
    );
  }
}
