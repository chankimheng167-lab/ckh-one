# CKH ONE Sales Force Automation — Implementation Status

_Last updated: 2026-10-17 · Phase 1 of 5_

The repository was empty when work began, so Phase 1 also builds the platform
foundation the SFA spec expects to reuse (tenancy, auth, roles, subscriptions,
master data, inventory, accounting tables).

## How this was verified

| Check | Status |
|---|---|
| All migrations apply cleanly on PostgreSQL 16 | ✅ verified |
| Database guards (`db/tests/schema_guards.sql`): tenant isolation via RLS, tenants cannot enable their own modules, composite FKs block cross-tenant references, anti-oversell, balanced journals, append-only audit log | ✅ verified |
| Every SQL statement in the API (175) prepared against the real schema | ✅ verified |
| TypeScript syntax of all files | ✅ verified |
| TypeScript type-check, unit tests, end-to-end tests | ⏳ **not yet run** — the build environment could not download npm packages. They run in GitHub Actions on first push, or locally with `pnpm install && pnpm test`. Expect a small number of compile fixes on the first run. |

## Phase 1 — foundation + order core (this delivery)

**Platform**
- Multi-tenant schema with composite `(tenant_id, id)` foreign keys and forced row-level security on every tenant table.
- Super Admin API: create tenants (fully provisioned: roles, chart of accounts, tax, numbering, branch, warehouse), switch modules on/off per tenant with prerequisite checks, set subscription dates/grace, suspend tenants.
- JWT auth for tenant users and Super Admins; users, roles, permissions and approval levels reloaded from the database on every request.
- One global access guard: authentication → active subscription → required modules → required permissions, on every route.
- Append-only audit log for every state change.
- Master data: products (variants, units, images), price lists (tiers, quantity breaks, validity), promotions, customers (groups, addresses, credit limit, credit hold, special discount), stock levels and movements, goods receipt with weighted-average cost.
- Configurable administrative locations (provinces/districts/communes) with validity dates, platform-wide or per tenant — nothing hardcoded.

**Sales Force Automation**
- All 19 required `sales_*` tables, plus `sales_settings` and `sales_territory_locations`.
- Six subscription modules (Sales Team Basic, Order Management, Territory, Commission, Advanced Analytics, Offline Ordering) and six default roles.
- My Customers / Customer Profile API with record-level access (rep → assigned; supervisor → team; manager → all) and balances shown only when permitted.
- Product catalog API: search, category filter, variants, units, promotions, customer-specific price, stock only for authorised warehouses, `stock_as_of` timestamp for stale-data display.
- Sales orders: drafts, optimistic locking, idempotent create (`clientReference`), server-side pricing (client prices rejected unless the tenant allows overrides; overrides count as discount for approval), VAT, KHR/USD rounding.
- Submit revalidates price, tax, stock, credit and permissions, then auto-approves or routes to approval.
- Approval policy: discount tiers (rep / supervisor / manager / director), order amount thresholds, credit limit and credit hold (accountant), per-rep and per-customer allowances. Self-approval blocked.
- Configurable workflow (pick/pack optional, invoice on dispatch or delivery) with full status history.
- Stock reservation with row locks, partial reservation + backorder, release on cancel, and a database trigger that makes overselling impossible in centrally controlled warehouses.

**Tests written (to run in CI)**: order creation and pricing, idempotency, customer access, auto-approval, discount approval tiers, rejection/revision, credit approval, stock reservation and release, concurrent reservation, tenant isolation, module switch-off, subscription expiry and grace period, suspension, Super-Admin-only routes.

## Remaining phases

| Phase | Scope |
|---|---|
| 2 — Fulfilment, invoicing, collections | Picking lists, pack, dispatch, delivery notes, partial delivery, returns; invoice generation with journal posting (AR / revenue / VAT) and COGS on delivery; payment collection submissions → accountant verification → customer receipt + allocation; credit notes. E2E: fulfilment, invoice, payment verification. |
| 3 — Visits, territories, targets, commissions | Visit scheduling and check-in with consent-based location; notes and follow-up tasks; territories and Cambodian location import; targets (rep/team/territory, month/quarter); commission plans, calculation, clawbacks, approval, payroll export. |
| 4 — Offline sync + PWA | Sync endpoint using `sales_offline_sync_events` (idempotency keys, payload hashing, revalidation, conflict results); Next.js PWA with all 18 pages, IndexedDB outbox, stale-stock indicators, Theme Studio tokens; E2E: offline order sync. |
| 5 — Reports & analytics | All 11 reports with Excel and PDF export; dashboards; Team Performance; Territory Map. |

## Known issues and decisions to review

1. **Not yet compiled or run end-to-end** (see above). First CI run is the real test.
2. `pnpm-lock.yaml` is not committed yet (generated on first `pnpm install`); commit it afterwards for reproducible builds.
3. Credit exposure assumes one currency per tenant. Multi-currency customers need exchange-rate conversion before comparing to the credit limit.
4. Access tokens are stateless JWTs (8 h). Disabling a user takes effect immediately (users are reloaded per request), but there is no refresh-token rotation or device revocation yet.
5. Commission accrual posting to the ledger and payroll integration depend on the HR & Payroll module, which does not exist yet; Phase 3 will define the hand-off table.
6. Cambodian administrative location data must be imported from an official, current source; the schema supports versioning but no dataset is bundled.
7. Receipt photo uploads for collections need object storage (e.g. S3-compatible); the column stores a storage key only.
