import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { platformTx, seedDemoPos, seedDemoTenant } from '../src/db/seed';
import { ALL_SALES_MODULES, bootApp, Company, createCompany, ownerUrl } from './helpers';

let app: INestApplication;
let other: Company;

beforeAll(async () => {
  app = await bootApp();
  other = await createCompany(app, { modules: [...ALL_SALES_MODULES, 'POS_SALES'] });
});
afterAll(async () => app?.close());

async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: ownerUrl() });
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end();
  }
}

describe('Demo seed on a database that already has other companies', () => {
  it('seeds the demo company and its POS data without touching the other company', async () => {
    // The other company has its own POS roles, an R1 register and a product sharing a demo SKU.
    const [{ id: branch }] = await sql(`SELECT id FROM branches WHERE tenant_id = $1 LIMIT 1`, [other.tenantId]);
    const [{ id: wh }] = await sql(`SELECT id FROM warehouses WHERE tenant_id = $1 LIMIT 1`, [other.tenantId]);
    const [{ id: unit }] = await sql(`SELECT id FROM units WHERE tenant_id = $1 LIMIT 1`, [other.tenantId]);
    await sql(`INSERT INTO pos_registers (tenant_id, code, name, branch_id, warehouse_id) VALUES ($1, 'R1', 'Their till', $2, $3)`, [other.tenantId, branch, wh]);
    const [{ id: theirRice }] = await sql(
      `INSERT INTO products (tenant_id, sku, name, base_unit_id, list_price, cost_price) VALUES ($1, 'RICE-25', 'Their rice', $2, 30, 20) RETURNING id`,
      [other.tenantId, unit],
    );

    await platformTx(ownerUrl(), (tx) => seedDemoTenant(tx));
    await platformTx(ownerUrl(), (tx) => seedDemoPos(tx));
    await platformTx(ownerUrl(), (tx) => seedDemoPos(tx)); // safe to run again

    const [{ id: demo }] = await sql(`SELECT id FROM tenants WHERE code = 'demo'`);
    const roles = await sql(
      `SELECT u.email, r.code, r.tenant_id = u.tenant_id AS same_tenant
         FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
        WHERE u.tenant_id = $1 AND u.email IN ('cashier@demo.ckh.one', 'possupervisor@demo.ckh.one', 'posmanager@demo.ckh.one')
        ORDER BY u.email`,
      [demo],
    );
    expect(roles).toEqual([
      { email: 'cashier@demo.ckh.one', code: 'POS_CASHIER', same_tenant: true },
      { email: 'posmanager@demo.ckh.one', code: 'POS_MANAGER', same_tenant: true },
      { email: 'possupervisor@demo.ckh.one', code: 'POS_SUPERVISOR', same_tenant: true },
    ]);
    expect(await sql(`SELECT 1 FROM pos_registers WHERE tenant_id = $1 AND code = 'R1'`, [demo])).toHaveLength(1);
    expect((await sql(`SELECT barcode FROM products WHERE tenant_id = $1 AND sku = 'RICE-25'`, [demo]))[0].barcode).toBe('8850001000017');
    const [theirs] = await sql(`SELECT barcode, category_id, reorder_point FROM products WHERE id = $1`, [theirRice]);
    expect(theirs).toEqual({ barcode: null, category_id: null, reorder_point: null });
  });
});
