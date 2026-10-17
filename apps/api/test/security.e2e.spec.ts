import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';
import { Client } from 'pg';
import { ACCOUNT_ROUTE, IS_PUBLIC, PLATFORM_ONLY, REQUIRED_MODULES } from '../src/common/auth-context';
import { businessDate } from '../src/common/business-time';
import { DatabaseService } from '../src/db/database.service';
import { seedOptions } from '../src/db/seed.cli';
import { Api, bootApp, Company, createCompany, ownerUrl, rootApi } from './helpers';

let app: INestApplication;
let a: Company;
let b: Company;
let api: Api;
const PW = 'Password!2026';

beforeAll(async () => {
  app = await bootApp();
  [a, b] = await Promise.all([createCompany(app), createCompany(app)]);
  api = new Api(app);
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

const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

const login = (co: Company, email: string, password = PW, deviceName?: string) =>
  api.post('/auth/login', { tenantCode: co.code, email, password, deviceName });

describe('Sessions and refresh-token rotation', () => {
  it('signs in with a short-lived access token and a refresh token bound to a device session', async () => {
    const r = await login(a, 'rep@x.test', PW, 'Rep phone');
    expect(r.status).toBe(200);
    expect(r.body.accessToken).toBeTruthy();
    expect(r.body.refreshToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(r.body.expiresIn).toBeLessThanOrEqual(900);
    expect(r.body.sessionId).toBeTruthy();
    const stored = await sql('SELECT token_hash FROM auth_refresh_tokens WHERE session_id = $1', [r.body.sessionId]);
    expect(stored).toHaveLength(1);
    expect(stored[0].token_hash).not.toBe(r.body.refreshToken); // only the hash is stored
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('rotates the refresh token on every use and revokes the session when an old one is replayed', async () => {
    const s = (await login(a, 'rep@x.test')).body;
    const r1 = await api.post('/auth/refresh', { refreshToken: s.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(s.refreshToken);
    expect(r1.body.sessionId).toBe(s.sessionId);
    expect((await api.as(r1.body.accessToken).get('/auth/me')).status).toBe(200);

    // The first token was copied and replayed later: refused, and the whole session ends.
    await sql(`UPDATE auth_refresh_tokens SET used_at = now() - interval '5 minutes' WHERE token_hash = $1`, [sha256(s.refreshToken)]);
    const replay = await api.post('/auth/refresh', { refreshToken: s.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    expect((await api.post('/auth/refresh', { refreshToken: r1.body.refreshToken })).status).toBe(401);
    const me = await api.as(r1.body.accessToken).get('/auth/me');
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('SESSION_REVOKED');
    const [row] = await sql('SELECT revoked_reason FROM auth_sessions WHERE id = $1', [s.sessionId]);
    expect(row.revoked_reason).toBe('REFRESH_TOKEN_REUSE');
  });

  it('tolerates two tabs refreshing with the same token at the same moment', async () => {
    const s = (await login(a, 'rep@x.test')).body;
    const [t1, t2] = await Promise.all([
      api.post('/auth/refresh', { refreshToken: s.refreshToken }),
      api.post('/auth/refresh', { refreshToken: s.refreshToken }),
    ]);
    expect([t1.status, t2.status]).toEqual([200, 200]);
    expect((await api.as(t2.body.accessToken).get('/auth/me')).status).toBe(200);
    expect((await api.post('/auth/refresh', { refreshToken: t1.body.refreshToken })).status).toBe(200);
  });

  it('logout ends the session immediately, before the access token expires', async () => {
    const s = (await login(a, 'rep@x.test')).body;
    const me = api.as(s.accessToken);
    expect((await me.post('/auth/logout')).status).toBe(200);
    expect((await me.get('/auth/me')).status).toBe(401);
    expect((await api.post('/auth/refresh', { refreshToken: s.refreshToken })).status).toBe(401);
  });

  it('lists my devices and signs out a lost one, but never another user’s', async () => {
    const phone = (await login(a, 'supervisor@x.test', PW, 'Lost phone')).body;
    const laptop = (await login(a, 'supervisor@x.test', PW, 'Laptop')).body;
    const list = await api.as(laptop.accessToken).get('/auth/sessions');
    const names = list.body.map((x: { device_name: string }) => x.device_name);
    expect(names).toEqual(expect.arrayContaining(['Lost phone', 'Laptop']));
    expect(list.body.find((x: { current: boolean }) => x.current).id).toBe(laptop.sessionId);

    const repSession = (await login(a, 'rep@x.test')).body;
    expect((await api.as(laptop.accessToken).del(`/auth/sessions/${repSession.sessionId}`)).status).toBe(404);
    expect((await api.as(repSession.accessToken).get('/auth/me')).status).toBe(200);

    expect((await api.as(laptop.accessToken).del(`/auth/sessions/${phone.sessionId}`)).status).toBe(200);
    expect((await api.as(phone.accessToken).get('/auth/me')).status).toBe(401);
    expect((await api.as(laptop.accessToken).get('/auth/me')).status).toBe(200);
  });

  it('an administrator can sign a user out everywhere, and disabling a user ends their sessions', async () => {
    const admin = api.as(a.tokens.admin);
    const s = (await login(a, 'warehouse@x.test')).body;
    const me = (await api.as(s.accessToken).get('/auth/me')).body;
    expect((await admin.get(`/admin/users/${me.userId}/sessions`)).body.length).toBeGreaterThan(0);
    expect((await api.as(a.tokens.rep).post(`/admin/users/${me.userId}/revoke-sessions`)).status).toBe(403);
    expect((await admin.post(`/admin/users/${me.userId}/revoke-sessions`)).body.revoked).toBeGreaterThan(0);
    expect((await api.as(s.accessToken).get('/auth/me')).status).toBe(401);

    // Tenant B's administrator cannot touch tenant A's user.
    expect((await api.as(b.tokens.admin).post(`/admin/users/${me.userId}/revoke-sessions`)).status).toBe(404);

    const s2 = (await login(a, 'warehouse@x.test')).body;
    await admin.put(`/admin/users/${me.userId}/status`, { status: 'DISABLED' });
    const [{ n }] = await sql(`SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL`, [me.userId]);
    expect(n).toBe(0);
    expect((await api.post('/auth/refresh', { refreshToken: s2.refreshToken })).status).toBe(401);
    await admin.put(`/admin/users/${me.userId}/status`, { status: 'ACTIVE' });
  });

  it('changing a password signs out every other device', async () => {
    const keep = (await login(b, 'accountant@x.test')).body;
    const other = (await login(b, 'accountant@x.test')).body;
    const weak = await api.as(keep.accessToken).post('/auth/password', { currentPassword: PW, newPassword: 'short' });
    expect(weak.status).toBe(400);
    const r = await api.as(keep.accessToken).post('/auth/password', { currentPassword: PW, newPassword: 'NewPassword2027' });
    expect(r.status).toBe(200);
    expect(r.body.otherSessionsSignedOut).toBeGreaterThan(0);
    expect((await api.as(other.accessToken).get('/auth/me')).status).toBe(401);
    expect((await api.as(keep.accessToken).get('/auth/me')).status).toBe(200);
    expect((await login(b, 'accountant@x.test', PW)).status).toBe(401);
    expect((await login(b, 'accountant@x.test', 'NewPassword2027')).status).toBe(200);
  });

  it('works the same way for Super Admin sessions', async () => {
    const s = (await api.post('/auth/platform/login', { email: 'root@ckh.test', password: 'RootPassword!1' })).body;
    expect(s.refreshToken).toBeTruthy();
    const r = await api.post('/auth/refresh', { refreshToken: s.refreshToken });
    expect(r.status).toBe(200);
    expect((await api.as(r.body.accessToken).get('/platform/tenants')).status).toBe(200);
    expect((await api.as(r.body.accessToken).get('/auth/sessions')).status).toBe(200);
    expect((await api.as(r.body.accessToken).get('/sales/customers')).status).toBe(403);
    await api.as(r.body.accessToken).post('/auth/logout');
    expect((await api.as(r.body.accessToken).get('/platform/tenants')).status).toBe(401);
  });

  it('rejects tokens that are forged, have no session, or come from another issuer', async () => {
    const me = (await api.as(a.tokens.rep).get('/auth/me')).body;
    const secret = process.env.JWT_SECRET!;
    const jwt = new JwtService({ secret });
    const noSession = jwt.sign({ sub: me.userId, typ: 'user', tid: a.tenantId }, { issuer: 'ckh-one', audience: 'ckh-one-api' });
    expect((await api.as(noSession).get('/auth/me')).status).toBe(401);
    const wrongIssuer = jwt.sign({ sub: me.userId, typ: 'user', tid: a.tenantId, sid: me.sessionId }, { issuer: 'someone-else', audience: 'ckh-one-api' });
    expect((await api.as(wrongIssuer).get('/auth/me')).status).toBe(401);
    const forged = new JwtService({ secret: 'not-the-secret-not-the-secret-123' }).sign({ sub: me.userId, typ: 'user', tid: a.tenantId, sid: me.sessionId }, { issuer: 'ckh-one', audience: 'ckh-one-api' });
    expect((await api.as(forged).get('/auth/me')).status).toBe(401);
    // A real session id from tenant A presented with tenant B's id.
    const crossTenant = jwt.sign({ sub: me.userId, typ: 'user', tid: b.tenantId, sid: me.sessionId }, { issuer: 'ckh-one', audience: 'ckh-one-api' });
    expect((await api.as(crossTenant).get('/auth/me')).status).toBe(401);
  });
});

describe('Sign-in lockout', () => {
  it('locks an account after repeated wrong passwords, and an administrator reset unlocks it', async () => {
    for (let i = 0; i < 5; i++) expect((await login(b, 'rep2@x.test', 'wrong-password-1')).status).toBe(401);
    const locked = await login(b, 'rep2@x.test', PW);
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    const [u] = await sql(`SELECT id FROM users WHERE tenant_id = $1 AND email = 'rep2@x.test'`, [b.tenantId]);
    const reset = await api.as(b.tokens.admin).put(`/admin/users/${u.id}/password`, { password: 'Unlocked2027' });
    expect(reset.status).toBe(200);
    expect((await login(b, 'rep2@x.test', 'Unlocked2027')).status).toBe(200);
  });
});

describe('Production seed never relies on public demo credentials', () => {
  it('requires a strong Super Admin password and skips demo data unless asked', () => {
    expect(() => seedOptions({ NODE_ENV: 'production' })).toThrow(/SUPERADMIN_PASSWORD/);
    expect(() => seedOptions({ NODE_ENV: 'production', SUPERADMIN_PASSWORD: 'ChangeMe!2026' })).toThrow(/public demo password/);
    expect(() => seedOptions({ NODE_ENV: 'production', SUPERADMIN_PASSWORD: 'short1' })).toThrow();
    const ok = seedOptions({ NODE_ENV: 'production', SUPERADMIN_PASSWORD: 'Very-strong-2026-pass' });
    expect(ok.seedDemo).toBe(false);
    expect(() => seedOptions({ NODE_ENV: 'production', SUPERADMIN_PASSWORD: 'Very-strong-2026-pass', SEED_DEMO: 'true' })).toThrow(/DEMO_PASSWORD/);
    // Local development keeps the documented demo logins.
    expect(seedOptions({ NODE_ENV: 'development' }).seedDemo).toBe(true);
  });

  it('refuses to start in production without CORS origins or a strong JWT secret', async () => {
    const { loadConfig } = await import('../src/config');
    expect(() => loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40) })).toThrow(/CORS_ORIGINS/);
    expect(() => loadConfig({ NODE_ENV: 'production', CORS_ORIGINS: 'https://app.ckh.one' })).toThrow(/JWT_SECRET/);
    expect(loadConfig({ NODE_ENV: 'production', CORS_ORIGINS: 'https://app.ckh.one', JWT_SECRET: 'x'.repeat(40) }).corsOrigins).toEqual(['https://app.ckh.one']);
  });

  it('sends security headers on every response', async () => {
    const r = await api.get('/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });
});

describe('Module licensing on every protected API', () => {
  /** Controllers whose routes need only the CORE licence (shared platform features). */
  const CORE_CONTROLLERS = ['AuthController', 'MasterDataController', 'TenantAdminController', 'ThemeController', 'LocationsController'];

  it('every tenant route either declares its module(s) or belongs to a core controller', async () => {
    const { AppModule } = await import('../src/app.module');
    const controllers: any[] = Reflect.getMetadata('controllers', AppModule);
    const unlicensed: string[] = [];
    let tenantRoutes = 0;
    for (const C of controllers) {
      for (const name of Object.getOwnPropertyNames(C.prototype)) {
        const h = C.prototype[name];
        if (name === 'constructor' || typeof h !== 'function' || Reflect.getMetadata('path', h) === undefined) continue;
        const meta = (k: string) => Reflect.getMetadata(k, h) ?? Reflect.getMetadata(k, C);
        if (meta(IS_PUBLIC) || meta(PLATFORM_ONLY) || meta(ACCOUNT_ROUTE)) continue;
        tenantRoutes++;
        const modules = [...(Reflect.getMetadata(REQUIRED_MODULES, C) ?? []), ...(Reflect.getMetadata(REQUIRED_MODULES, h) ?? [])];
        if (!modules.length && !CORE_CONTROLLERS.includes(C.name)) unlicensed.push(`${C.name}.${name}`);
      }
    }
    expect(tenantRoutes).toBeGreaterThan(100);
    expect(unlicensed).toEqual([]);
  });

  it('routes that declare no module still require the CORE licence (fail closed)', async () => {
    await sql(`UPDATE tenant_modules SET enabled = false WHERE tenant_id = $1 AND module_code = 'CORE'`, [b.tenantId]);
    try {
      const r = await api.as(b.tokens.admin).get('/masterdata/reference');
      expect(r.status).toBe(402);
      expect(r.body.error.details.missingModules).toEqual(['CORE']);
    } finally {
      await sql(`UPDATE tenant_modules SET enabled = true WHERE tenant_id = $1 AND module_code = 'CORE'`, [b.tenantId]);
    }
    expect((await api.as(b.tokens.admin).get('/masterdata/reference')).status).toBe(200);
  });

  it('the Super Admin cannot switch CORE off', async () => {
    const root = await rootApi(app);
    const r = await root.put(`/platform/tenants/${a.tenantId}/modules`, { modules: [{ code: 'CORE', enabled: false }] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('CORE_REQUIRED');
  });

  it('account routes keep working when the subscription has lapsed, business routes do not', async () => {
    const root = await rootApi(app);
    const s = (await login(b, 'manager@x.test')).body;
    await root.put(`/platform/tenants/${b.tenantId}/subscription`, { status: 'ACTIVE', endsAt: new Date(Date.now() - 86400_000).toISOString(), graceDays: 0 });
    try {
      expect((await api.as(s.accessToken).get('/sales/customers')).status).toBe(402);
      expect((await api.as(s.accessToken).get('/auth/sessions')).status).toBe(200);
      expect((await api.as(s.accessToken).post('/auth/logout')).status).toBe(200);
    } finally {
      await root.put(`/platform/tenants/${b.tenantId}/subscription`, { status: 'ACTIVE', endsAt: null });
    }
  });
});

describe('Business time zone', () => {
  it('defaults Cambodian companies to Asia/Phnom_Penh and computes dates there, not in UTC', async () => {
    const me = (await api.as(a.tokens.rep).get('/auth/me')).body;
    expect(me.timezone).toBe('Asia/Phnom_Penh');
    const db = app.get(DatabaseService);
    const row = await db.withTenant(a.tenantId, null, (tx) => tx.one<{ d: string; tz: string }>(`SELECT CURRENT_DATE::text AS d, current_setting('TimeZone') AS tz`));
    expect(row.tz).toBe('Asia/Phnom_Penh');
    expect(row.d).toBe(businessDate('Asia/Phnom_Penh'));
    const o = await api.as(a.tokens.rep).post('/sales/orders', { customerId: a.customers.sunrise, lines: [{ productId: a.products.oil, quantity: '1' }] });
    expect(o.body.order.order_date).toBe(businessDate('Asia/Phnom_Penh'));
  });

  it('an early-morning Phnom Penh instant belongs to that local day', () => {
    // 06:30 on 2 Jan in Phnom Penh is still 1 Jan in UTC.
    expect(businessDate('Asia/Phnom_Penh', new Date('2026-01-01T23:30:00Z'))).toBe('2026-01-02');
    expect(businessDate('UTC', new Date('2026-01-01T23:30:00Z'))).toBe('2026-01-01');
  });

  it('the Super Admin can change a company’s zone; unknown zones are refused', async () => {
    const root = await rootApi(app);
    expect((await root.put(`/platform/tenants/${b.tenantId}/settings`, { timezone: 'Mars/Olympus' })).status).toBe(422);
    const r = await root.put(`/platform/tenants/${b.tenantId}/settings`, { timezone: 'Asia/Bangkok' });
    expect(r.status).toBe(200);
    const db = app.get(DatabaseService);
    expect((await db.withTenant(b.tenantId, null, (tx) => tx.one(`SELECT current_setting('TimeZone') AS tz`))).tz).toBe('Asia/Bangkok');
    await root.put(`/platform/tenants/${b.tenantId}/settings`, { timezone: 'Asia/Phnom_Penh' });
    await expect(sql(`UPDATE tenants SET timezone = 'Nowhere/Land' WHERE id = $1`, [b.tenantId])).rejects.toThrow(/Unknown time zone/);
  });
});

describe('Row-level security and tenant isolation (database catalogue)', () => {
  it('every table with tenant_id has forced RLS and a policy', async () => {
    const rows = await sql<{ table_name: string; rls: boolean; forced: boolean; policies: number }>(
      `SELECT c.relname AS table_name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`,
    );
    expect(rows.length).toBeGreaterThan(60);
    const weak = rows.filter((r) => !r.rls || !r.forced || r.policies === 0).map((r) => r.table_name);
    expect(weak).toEqual([]);
    expect(rows.map((r) => r.table_name)).toEqual(expect.arrayContaining(['auth_sessions', 'auth_refresh_tokens']));
  });

  it('the application login cannot bypass RLS and tenant sessions cannot read Super Admin accounts', async () => {
    const [role] = await sql(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'ckh_app_test_user'`);
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const db = app.get(DatabaseService);
    const seen = await db.withTenant(a.tenantId, null, (tx) => tx.one<{ n: string }>('SELECT count(*) AS n FROM platform_admins'));
    expect(Number(seen.n)).toBe(0);
    const sessions = await db.withTenant(a.tenantId, null, (tx) => tx.query<{ tenant_id: string | null }>('SELECT tenant_id FROM auth_sessions'));
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.tenant_id === a.tenantId)).toBe(true);
  });
});
