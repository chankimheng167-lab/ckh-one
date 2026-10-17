# CKH ONE

Multi-tenant SaaS ERP/POS platform for C.K.H Business Consulting — POS, inventory, accounting, CRM, HR, and Sales Force Automation.

## Repository layout

```
apps/
  api/                 NestJS REST API (PostgreSQL)
    db/migrations/     versioned SQL migrations (source of truth for the schema)
    db/repeatable/     re-applied after every migration batch (row-level security)
    db/tests/          SQL checks for database-level guards
    src/core/          auth, Super Admin platform, tenant admin, master data, subscriptions
    src/sales/         Sales Force Automation module
    test/              end-to-end API tests (real Postgres)
  web/                 Next.js sales app: mobile-first PWA, works offline (IndexedDB outbox)
packages/
  shared/              domain logic shared by API and apps: permissions, subscription
                       modules, order state machine, pricing math, approval policy,
                       commission rules, Theme Studio tokens
docs/                  architecture notes and implementation status
```

## Requirements

- Node.js 20+ and pnpm 10 (`corepack enable`)
- PostgreSQL 14+ (16 recommended)

## First run

The quickest way to get PostgreSQL is Docker: `docker compose up -d` starts PostgreSQL 16 on
**`localhost:5433`** (not 5432, so it never clashes with another local Postgres) with user
`postgres`, password `postgres` and database `ckh_one` already created (skip step 1 below).
Use `postgres://postgres:postgres@localhost:5433/...` in the URLs, and for tests set
`TEST_PG_ADMIN_URL=postgres://postgres:postgres@localhost:5433/postgres`.

```bash
pnpm install
pnpm --filter @ckh/shared build

# 1. Create the database and the application login (once; not needed with Docker)
psql -U postgres -c "CREATE DATABASE ckh_one"

# 2. Run migrations as the database owner
MIGRATION_DATABASE_URL=postgres://postgres@localhost:5432/ckh_one pnpm db:migrate

# 3. Create the restricted application login used by the API (subject to row-level security)
psql -U postgres -d ckh_one -c "CREATE ROLE ckh_app_user LOGIN PASSWORD 'change-me' IN ROLE ckh_app"

# 4. Seed modules, plans, the Super Admin and a demo company
MIGRATION_DATABASE_URL=postgres://postgres@localhost:5432/ckh_one pnpm db:seed

# 5. Start the API
DATABASE_URL=postgres://ckh_app_user:change-me@localhost:5432/ckh_one pnpm --filter @ckh/api dev
```

The API listens on `http://localhost:3001/api/v1`. Demo logins (company code `demo`, password `ChangeMe!2026`):
`admin@`, `manager@`, `supervisor@`, `rep@`, `warehouse@`, `accountant@demo.ckh.one`.
Super Admin: `superadmin@ckh.one` via `POST /auth/platform/login`.

### Web app

```bash
cd apps/web
cp .env.example .env.local          # NEXT_PUBLIC_API_URL=http://localhost:3001/api/v1
pnpm dev                            # http://localhost:3100
# or a production build (static files in apps/web/out, serve them from any web server or CDN):
pnpm build
```

Sign in with company code `demo` and one of the demo logins above. The Super Admin (platform owner) signs in at
`http://localhost:3100/platform/` with `superadmin@ckh.one` to create client companies and switch their modules,
subscription and status. The app is a static export, so it can be hosted on any static host; set `CORS_ORIGINS` on the API to the app's origin. Offline ordering needs the **Offline Mobile Ordering** module on the tenant.

**Never run the API with the database owner or a superuser account.** Superusers bypass row-level security, and the app login must not be able to change the schema.

## Tests

```bash
pnpm --filter @ckh/shared test     # unit tests: pricing, approvals, workflow
pnpm --filter @ckh/api test        # end-to-end: creates a throwaway database
pnpm --filter @ckh/web build      # type-check and build the web app
node apps/web/scripts/smoke.cjs    # browser smoke test (API + web app running, demo data seeded)
```

End-to-end tests need a Postgres superuser URL in `TEST_PG_ADMIN_URL` (default `postgres://postgres@localhost:5432/postgres`). GitHub Actions runs everything on each push (`.github/workflows/ci.yml`).

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Restricted app login (member of `ckh_app`) |
| `MIGRATION_DATABASE_URL` | Owner login for migrations and seeding |
| `JWT_SECRET` | ≥ 32 characters in production |
| `JWT_TTL_SECONDS` | Access token lifetime (default 900 s = 15 min) |
| `REFRESH_TTL_DAYS` | Device session lifetime, sliding (default 30) |
| `REFRESH_REUSE_GRACE_SECONDS` | Tolerance for two tabs refreshing at once (default 30) |
| `LOGIN_MAX_FAILURES`, `LOGIN_LOCK_MINUTES` | Account lockout (default 5 failures → 15 min) |
| `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD` | First Super Admin (seed). Password required in production |
| `SEED_DEMO`, `DEMO_PASSWORD` | Demo company: on by default in development, off in production unless `SEED_DEMO=true` with a non-public `DEMO_PASSWORD` |
| `CORS_ORIGINS` | Comma-separated allowed origins (required in production) |

## Sign-in and sessions

`POST /auth/login` (company users) and `POST /auth/platform/login` (Super Admin) return a short-lived
`accessToken` and a `refreshToken`. Each sign-in is a device session: `POST /auth/refresh` swaps the refresh
token for a new pair (the old one stops working, and replaying an old one signs that device out),
`POST /auth/logout` ends the session, `GET /auth/sessions` / `DELETE /auth/sessions/:id` list and sign out
devices, and `POST /auth/password` changes the password and signs out every other device. Administrators can
sign a user out (`POST /admin/users/:id/revoke-sessions`) or reset a password (`PUT /admin/users/:id/password`).

Business dates (order dates, "today" in reports, document-number years) use the company's time zone
(`Asia/Phnom_Penh` for Cambodian companies), set by the Super Admin with `PUT /platform/tenants/:id/settings`.

The demo logins above are for local development only: production refuses the public demo password.

See [docs/AUDIT_REPORT.md](docs/AUDIT_REPORT.md) for the requirement comparison, missing features and roadmap,
[docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) for what is built, and
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for production deployment.
