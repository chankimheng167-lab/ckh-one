# Deploying CKH ONE

This covers the API, the database and the web app. Windows POS installer instructions will be added with the
Windows POS stage.

## 1. Database (PostgreSQL 14+, 16 recommended)

```bash
# As the database owner (never the API's login):
psql -U postgres -c "CREATE DATABASE ckh_one"
MIGRATION_DATABASE_URL=postgres://owner:***@db:5432/ckh_one pnpm db:migrate

# Restricted login the API uses. It is a member of ckh_app and is subject to row-level security.
psql -U postgres -d ckh_one -c "CREATE ROLE ckh_app_user LOGIN PASSWORD '<strong password>' IN ROLE ckh_app"
```

Check the API login can never bypass row-level security:

```sql
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'ckh_app_user';  -- both must be false
```

Run migrations on every deploy before starting the new API version. They are idempotent, take an advisory
lock, and re-apply `db/repeatable/R__rls.sql` so new tables get row-level security.

## 2. First Super Admin

```bash
NODE_ENV=production \
MIGRATION_DATABASE_URL=postgres://owner:***@db:5432/ckh_one \
SUPERADMIN_EMAIL=owner@yourcompany.com \
SUPERADMIN_PASSWORD='<at least 10 characters, letters and numbers>' \
pnpm db:seed
```

In production the seed refuses to run without `SUPERADMIN_PASSWORD`, refuses the public demo password, and
does not create the demo company unless you set `SEED_DEMO=true` and a private `DEMO_PASSWORD`.

## 3. API

```bash
pnpm install --frozen-lockfile
pnpm --filter @ckh/shared build
pnpm --filter @ckh/api build
NODE_ENV=production node apps/api/dist/main.js
```

Required environment:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | the restricted `ckh_app_user` login |
| `JWT_SECRET` | ≥ 32 random characters (`openssl rand -base64 48`) |
| `CORS_ORIGINS` | the web app origin(s), e.g. `https://app.ckh.one` |

The API refuses to start in production without a strong `JWT_SECRET` and `CORS_ORIGINS`. Optional: `JWT_TTL_SECONDS`
(900), `REFRESH_TTL_DAYS` (30), `REFRESH_REUSE_GRACE_SECONDS` (30), `LOGIN_MAX_FAILURES` (5), `LOGIN_LOCK_MINUTES` (15), `PORT` (3001).

Put it behind a TLS-terminating reverse proxy (nginx, Caddy, a cloud load balancer). The API trusts one proxy
hop for client IPs in production. Add per-IP rate limiting on `/api/v1/auth/` at the proxy, for example nginx:

```nginx
limit_req_zone $binary_remote_addr zone=ckh_auth:10m rate=10r/m;
location /api/v1/auth/ { limit_req zone=ckh_auth burst=20 nodelay; proxy_pass http://ckh_api; }
location /api/v1/      { proxy_pass http://ckh_api; }
```

Health check: `GET /api/v1/health`.

## 4. Web app

```bash
cd apps/web
NEXT_PUBLIC_API_URL=https://api.ckh.one/api/v1 pnpm build   # static files in apps/web/out
```

Serve `apps/web/out` from any static host or CDN over HTTPS. `NEXT_PUBLIC_API_URL` is baked in at build time
and also sets the page's Content-Security-Policy `connect-src`, so rebuild when the API address changes.
Make sure the host does not cache `sw.js` for long (it controls offline updates).

## 5. After deploying

- Sign in at `/platform/` as the Super Admin and create the first company.
- Check the ledger for each company: `GET /api/v1/accounting/integrity` as an accountant should return `"ok": true`.
- Back up the database daily (`pg_dump -Fc`) and test a restore.

## Windows (local development)

PowerShell equivalents of the commands above:

```powershell
$env:MIGRATION_DATABASE_URL = "postgres://postgres:postgres@localhost:5433/ckh_one"
pnpm db:migrate
pnpm db:seed
$env:DATABASE_URL = "postgres://ckh_app_user:change-me@localhost:5433/ckh_one"
$env:CORS_ORIGINS = "http://localhost:3100"
pnpm --filter @ckh/api dev
```
