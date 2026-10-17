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
packages/
  shared/              domain logic shared by API and apps: permissions, subscription
                       modules, order state machine, pricing math, approval policy
docs/                  architecture notes and implementation status
```

## Requirements

- Node.js 20+ and pnpm 10 (`corepack enable`)
- PostgreSQL 14+ (16 recommended)

## First run

The quickest way to get PostgreSQL is Docker: `docker compose up -d` starts PostgreSQL 16 on
`localhost:5432` with user `postgres`, password `postgres` and database `ckh_one` already created
(skip step 1 below). Use `postgres://postgres:postgres@localhost:5432/...` in the URLs.

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

**Never run the API with the database owner or a superuser account.** Superusers bypass row-level security, and the app login must not be able to change the schema.

## Tests

```bash
pnpm --filter @ckh/shared test     # unit tests: pricing, approvals, workflow
pnpm --filter @ckh/api test        # end-to-end: creates a throwaway database
```

End-to-end tests need a Postgres superuser URL in `TEST_PG_ADMIN_URL` (default `postgres://postgres@localhost:5432/postgres`). GitHub Actions runs everything on each push (`.github/workflows/ci.yml`).

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Restricted app login (member of `ckh_app`) |
| `MIGRATION_DATABASE_URL` | Owner login for migrations and seeding |
| `JWT_SECRET` | ≥ 32 characters in production |
| `JWT_TTL_SECONDS` | Access token lifetime (default 8 h) |
| `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD` | First Super Admin (seed) |
| `SEED_DEMO` | `false` to skip the demo company |
| `CORS_ORIGINS` | Comma-separated allowed origins |

See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) for what is built and what is next.
