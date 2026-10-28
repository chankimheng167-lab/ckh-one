import * as bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { MODULE_CATALOG } from '@ckh/shared';
import type { Tx } from './database.service';
import { businessDate, DEFAULT_TIMEZONE } from '../common/business-time';
import { PUBLIC_DEMO_PASSWORD } from '../config';
import { TenantProvisioningService } from '../core/platform/tenant-provisioning.service';

/** Run fn in a platform-admin transaction on a raw connection (seeding / tests). */
export async function platformTx<T>(connectionString: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.platform_admin', 'on', true)");
    const tx: Tx = {
      tenantId: null,
      userId: null,
      timezone: DEFAULT_TIMEZONE,
      today: () => businessDate(DEFAULT_TIMEZONE),
      query: async (sql, params) => (await client.query(sql, params as any[])).rows,
      one: async (sql, params) => {
        const r = await client.query(sql, params as any[]);
        if (!r.rows[0]) throw new Error('Expected one row');
        return r.rows[0];
      },
      maybeOne: async (sql, params) => (await client.query(sql, params as any[])).rows[0] ?? null,
    };
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

/** Reference data every installation needs. Idempotent. */
export async function seedPlatform(tx: Tx, admin: { email: string; password: string; fullName: string }) {
  for (const m of MODULE_CATALOG) {
    await tx.query(
      `INSERT INTO platform_modules (code, name, requires, is_core) VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, requires = EXCLUDED.requires, is_core = EXCLUDED.is_core`,
      [m.code, m.name, m.requires, m.code === 'CORE'],
    );
  }
  const plans: [string, string, number, string[]][] = [
    ['BASIC', 'Basic', 29, ['CORE', 'POS', 'INVENTORY']],
    ['PROFESSIONAL', 'Professional', 59, ['CORE', 'POS', 'INVENTORY', 'ACCOUNTING', 'CRM']],
    ['BUSINESS', 'Business', 99, ['CORE', 'POS', 'INVENTORY', 'ACCOUNTING', 'CRM', 'HR_PAYROLL', 'SALES_TEAM_BASIC', 'SALES_ORDER_MANAGEMENT']],
  ];
  for (const [code, name, price, modules] of plans) {
    await tx.query(
      `INSERT INTO subscription_plans (code, name, price_monthly, modules) VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, price_monthly = EXCLUDED.price_monthly, modules = EXCLUDED.modules`,
      [code, name, price, modules],
    );
  }
  await tx.query(
    `INSERT INTO platform_admins (email, password_hash, full_name) VALUES ($1, $2, $3)
     ON CONFLICT (lower(email)) DO NOTHING`,
    [admin.email, await bcrypt.hash(admin.password, 10), admin.fullName],
  );
}

/** A demo company with a sales team, customers, products and stock. */
export async function seedDemoTenant(tx: Tx, password: string = PUBLIC_DEMO_PASSWORD) {
  const exists = await tx.maybeOne(`SELECT 1 FROM tenants WHERE code = 'demo'`);
  if (exists) return;
  const { tenantId } = await new TenantProvisioningService().createTenant(tx, {
    code: 'demo',
    name: 'ABC Trading Co., Ltd.',
    admin: { email: 'admin@demo.ckh.one', password, fullName: 'Demo Admin' },
    modules: ['INVENTORY', 'ACCOUNTING', 'CRM', 'SALES_TEAM_BASIC', 'SALES_ORDER_MANAGEMENT', 'SALES_TERRITORY_MANAGEMENT', 'SALES_COMMISSION_MANAGEMENT', 'SALES_ADVANCED_ANALYTICS', 'SALES_OFFLINE_ORDERING'],
    subscription: { status: 'ACTIVE', endsAt: null },
  });
  await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
  const id = (sql: string, p: unknown[] = []) => tx.one<{ id: string }>(sql, p).then((r) => r.id);
  const pw = await bcrypt.hash(password, 10);
  const role = (code: string) => id('SELECT id FROM roles WHERE code = $1', [code]);
  const user = async (email: string, name: string, roleCode: string) => {
    const uid = await id(`INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, $2, $3, $4) RETURNING id`, [tenantId, email, pw, name]);
    await tx.query('INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)', [tenantId, uid, await role(roleCode)]);
    return uid;
  };
  const manager = await user('manager@demo.ckh.one', 'Sokha Manager', 'SALES_MANAGER');
  const supervisor = await user('supervisor@demo.ckh.one', 'Dara Supervisor', 'SALES_SUPERVISOR');
  const repUser = await user('rep@demo.ckh.one', 'Vanna Rep', 'SALES_REP');
  await user('warehouse@demo.ckh.one', 'Rith Warehouse', 'WAREHOUSE_OFFICER');
  await user('accountant@demo.ckh.one', 'Chenda Accountant', 'ACCOUNTANT');

  const branch = await id(`SELECT id FROM branches WHERE code = 'HQ'`);
  const wh = await id(`SELECT id FROM warehouses WHERE code = 'MAIN'`);
  const team = await id(
    `INSERT INTO sales_teams (tenant_id, code, name, supervisor_user_id, manager_user_id, branch_id) VALUES ($1, 'PP', 'Phnom Penh Team', $2, $3, $4) RETURNING id`,
    [tenantId, supervisor, manager, branch],
  );
  const rep = await id(
    `INSERT INTO sales_representatives (tenant_id, user_id, employee_code, team_id, default_branch_id, default_warehouse_id) VALUES ($1, $2, 'SR001', $3, $4, $5) RETURNING id`,
    [tenantId, repUser, team, branch, wh],
  );
  const pcs = await id(`SELECT id FROM units WHERE code = 'PCS'`);
  const products: [string, string, string][] = [
    ['RICE-25', 'Jasmine Rice 25kg', '28.00'],
    ['OIL-1L', 'Cooking Oil 1L', '2.50'],
    ['SUGAR-1', 'Sugar 1kg', '1.20'],
    ['WATER-24', 'Drinking Water 24x500ml', '3.80'],
  ];
  for (const [sku, name, price] of products) {
    const p = await id(`INSERT INTO products (tenant_id, sku, name, base_unit_id, list_price, cost_price) VALUES ($1, $2, $3, $4, $5, $5::numeric * 0.75) RETURNING id`, [tenantId, sku, name, pcs, price]);
    await tx.query(`INSERT INTO stock_levels (tenant_id, warehouse_id, product_id, qty_on_hand, avg_cost) VALUES ($1, $2, $3, 500, $4::numeric * 0.75)`, [tenantId, wh, p, price]);
  }
  for (const [code, name, limit] of [['C0001', 'Sunrise Retail', '5000'], ['C0002', 'Lucky Mart', '2000'], ['C0003', 'Golden Mini Market', null]] as const) {
    const c = await id(
      `INSERT INTO customers (tenant_id, code, name, payment_terms_days, credit_limit) VALUES ($1, $2, $3, 30, $4) RETURNING id`,
      [tenantId, code, name, limit],
    );
    await tx.query(
      `INSERT INTO customer_addresses (tenant_id, customer_id, address_type, line1, is_default) VALUES ($1, $2, 'DELIVERY', 'Phnom Penh', true)`,
      [tenantId, c],
    );
    await tx.query(`INSERT INTO sales_customer_assignments (tenant_id, customer_id, sales_rep_id) VALUES ($1, $2, $3)`, [tenantId, c, rep]);
  }
}
