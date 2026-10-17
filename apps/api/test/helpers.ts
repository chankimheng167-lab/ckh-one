import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { businessDate } from '../src/common/business-time';

/** Today's business date for test companies (Cambodia, UTC+7), as the API computes it. */
export const localToday = () => businessDate('Asia/Phnom_Penh');

/** Jest runs globalSetup in a separate context; recompute the URLs here. */
function urls() {
  const adminUrl = process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres@localhost:5432/postgres';
  const u = new URL(adminUrl);
  u.pathname = `/${process.env.TEST_DB_NAME ?? 'ckh_one_test'}`;
  const ownerUrl = u.toString();
  const app = new URL(ownerUrl);
  app.username = 'ckh_app_test_user';
  app.password = 'ckh_app_test_pass';
  return { ownerUrl, appUrl: app.toString() };
}

export async function bootApp(): Promise<INestApplication> {
  process.env.DATABASE_URL = urls().appUrl;
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret!';
  const { AppModule } = await import('../src/app.module');
  const { applySecurity } = await import('../src/main');
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication({ logger: false });
  app.setGlobalPrefix('api/v1');
  applySecurity(app);
  await app.init();
  return app;
}

export const ownerUrl = () => urls().ownerUrl;

export class Api {
  constructor(private readonly app: INestApplication, public token?: string) {}
  private req(method: 'get' | 'post' | 'put' | 'delete', path: string, body?: unknown, headers: Record<string, string> = {}) {
    let r = request(this.app.getHttpServer())[method](`/api/v1${path}`);
    if (this.token) r = r.set('Authorization', `Bearer ${this.token}`);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return body === undefined ? r : r.send(body as object);
  }
  get = (p: string, h?: Record<string, string>) => this.req('get', p, undefined, h);
  post = (p: string, b?: unknown, h?: Record<string, string>) => this.req('post', p, b ?? {}, h);
  put = (p: string, b?: unknown) => this.req('put', p, b ?? {});
  del = (p: string) => this.req('delete', p);
  as = (token: string) => new Api(this.app, token);
}

export const ALL_SALES_MODULES = [
  'INVENTORY', 'ACCOUNTING', 'CRM', 'SALES_TEAM_BASIC', 'SALES_ORDER_MANAGEMENT',
  'SALES_TERRITORY_MANAGEMENT', 'SALES_COMMISSION_MANAGEMENT', 'SALES_ADVANCED_ANALYTICS', 'SALES_OFFLINE_ORDERING',
];

export interface Company {
  tenantId: string;
  code: string;
  tokens: { admin: string; manager: string; supervisor: string; rep: string; rep2: string; warehouse: string; accountant: string };
  repId: string;
  rep2Id: string;
  warehouseId: string;
  branchId: string;
  products: { rice: string; oil: string; water: string };
  customers: { sunrise: string; lucky: string; other: string };
  priceListId: string;
}

async function login(api: Api, tenantCode: string, email: string, password: string): Promise<string> {
  const r = await api.post('/auth/login', { tenantCode, email, password });
  if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}

const expectOk = (r: request.Response, what: string) => {
  if (r.status >= 300) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

/**
 * Builds a complete company purely through the public API:
 * Super Admin creates the tenant; the tenant admin creates staff, a team,
 * two reps, products, prices, customers (with assignments) and stock.
 */
export async function createCompany(app: INestApplication, opts: { modules?: string[] } = {}): Promise<Company> {
  const api = new Api(app);
  const root = expectOk(await api.post('/auth/platform/login', { email: 'root@ckh.test', password: 'RootPassword!1' }), 'root login');
  const sa = api.as(root.accessToken);
  const code = `co-${randomUUID().slice(0, 8)}`;
  const pw = 'Password!2026';
  const t = expectOk(
    await sa.post('/platform/tenants', {
      code,
      name: `Company ${code}`,
      admin: { email: 'admin@x.test', password: pw, fullName: 'Admin' },
      modules: opts.modules ?? ALL_SALES_MODULES,
      subscription: { status: 'ACTIVE', endsAt: null },
    }),
    'create tenant',
  );

  const adminToken = await login(api, code, 'admin@x.test', pw);
  const admin = api.as(adminToken);
  const ref = expectOk(await admin.get('/masterdata/reference'), 'reference');
  const branchId = ref.branches[0].id;
  const warehouseId = ref.warehouses[0].id;
  const priceListId = ref.priceLists[0].id;

  const mkUser = async (email: string, roleCodes: string[]) =>
    expectOk(await admin.post('/admin/users', { email, fullName: email.split('@')[0], password: pw, roleCodes }), `user ${email}`).id as string;
  const managerId = await mkUser('manager@x.test', ['SALES_MANAGER']);
  const supervisorId = await mkUser('supervisor@x.test', ['SALES_SUPERVISOR']);
  const repUserId = await mkUser('rep@x.test', ['SALES_REP']);
  const rep2UserId = await mkUser('rep2@x.test', ['SALES_REP']);
  await mkUser('warehouse@x.test', ['WAREHOUSE_OFFICER']);
  await mkUser('accountant@x.test', ['ACCOUNTANT']);

  const team = expectOk(
    await admin.post('/admin/sales/teams', { code: 'T1', name: 'Team 1', supervisorUserId: supervisorId, managerUserId: managerId, branchId }),
    'team',
  );
  const mkRep = async (userId: string, code: string) =>
    expectOk(
      await admin.post('/admin/sales/representatives', { userId, employeeCode: code, teamId: team.id, defaultBranchId: branchId, defaultWarehouseId: warehouseId }),
      'rep',
    ).id as string;
  const repId = await mkRep(repUserId, 'SR1');
  const rep2Id = await mkRep(rep2UserId, 'SR2');

  const mkProduct = async (sku: string, price: string) =>
    expectOk(await admin.post('/masterdata/products', { sku, name: sku, listPrice: price, costPrice: '1' }), sku).id as string;
  const rice = await mkProduct('RICE', '25.00');
  const oil = await mkProduct('OIL', '2.50');
  const water = await mkProduct('WATER', '4.00');
  // Customer price list overrides the list price for rice.
  expectOk(await admin.post('/masterdata/price-list-items', { priceListId, productId: rice, unitPrice: '24.00' }), 'price');

  expectOk(
    await admin.post('/masterdata/stock/receipts', { warehouseId, lines: [{ productId: rice, quantity: '100', unitCost: '18' }, { productId: oil, quantity: '50', unitCost: '1.8' }] }),
    'stock',
  );

  const mkCustomer = async (c: string, creditLimit: string | null) =>
    expectOk(
      await admin.post('/masterdata/customers', {
        code: c, name: c, paymentTermsDays: 30, creditLimit,
        addresses: [{ addressType: 'DELIVERY', line1: 'Phnom Penh', isDefault: true }],
      }),
      `customer ${c}`,
    ).id as string;
  const sunrise = await mkCustomer('SUNRISE', '10000');
  const lucky = await mkCustomer('LUCKY', '100');
  const other = await mkCustomer('OTHER', null);

  const supToken = await login(api, code, 'supervisor@x.test', pw);
  const sup = api.as(supToken);
  for (const c of [sunrise, lucky]) {
    expectOk(await sup.post('/sales/customers/assignments', { customerId: c, salesRepId: repId }), 'assign');
  }
  expectOk(await sup.post('/sales/customers/assignments', { customerId: other, salesRepId: rep2Id }), 'assign other');

  return {
    tenantId: t.tenantId,
    code,
    tokens: {
      admin: adminToken,
      manager: await login(api, code, 'manager@x.test', pw),
      supervisor: supToken,
      rep: await login(api, code, 'rep@x.test', pw),
      rep2: await login(api, code, 'rep2@x.test', pw),
      warehouse: await login(api, code, 'warehouse@x.test', pw),
      accountant: await login(api, code, 'accountant@x.test', pw),
    },
    repId,
    rep2Id,
    warehouseId,
    branchId,
    products: { rice, oil, water },
    customers: { sunrise, lucky, other },
    priceListId,
  };
}

export async function rootApi(app: INestApplication): Promise<Api> {
  const api = new Api(app);
  const r = await api.post('/auth/platform/login', { email: 'root@ckh.test', password: 'RootPassword!1' });
  return api.as(r.body.accessToken);
}
