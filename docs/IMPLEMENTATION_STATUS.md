# CKH ONE Sales Force Automation — Implementation Status

_Last updated: 2026-10-17 · all 5 phases built_

The repository was empty when work began, so Phase 1 also built the platform
foundation the SFA spec expects to reuse (tenancy, auth, roles, subscriptions,
master data, inventory, accounting).

## How this was verified

Everything below was run locally on PostgreSQL 16 / Node 22 before delivery.

| Check | Result |
|---|---|
| Migrations 0001–0007 + row-level security apply cleanly to an empty database | ✅ |
| Database guard checks (`db/tests/schema_guards.sql`): RLS isolation, tenants cannot enable their own modules, composite FKs block cross-tenant references, anti-oversell trigger, balanced journals, append-only audit log | ✅ all 7 guards fire |
| `@ckh/shared` unit tests (pricing, approvals, workflow, commission rules) | ✅ 16 / 16 |
| API type-check | ✅ |
| API end-to-end tests against a real database (6 suites) | ✅ **74 / 74** |
| Web app type-check and production build (23 static routes) | ✅ |
| Browser smoke test (Chromium, phone and desktop sizes, 4 roles, every screen; online order, then an order taken offline, queued, and accepted after reconnecting) | ✅ no errors |

The spec's required end-to-end scenarios and where they are tested:

| Scenario | Test |
|---|---|
| Salesperson creating an order | `sales-orders.e2e.spec.ts` |
| Discount approval | `sales-orders.e2e.spec.ts` |
| Stock reservation | `sales-orders.e2e.spec.ts`, `fulfilment-billing.e2e.spec.ts` |
| Order fulfilment | `fulfilment-billing.e2e.spec.ts` |
| Invoice generation | `fulfilment-billing.e2e.spec.ts` |
| Payment verification | `fulfilment-billing.e2e.spec.ts` |
| Offline order synchronisation | `offline-sync.e2e.spec.ts` (+ browser smoke test) |
| Tenant isolation | `tenancy-subscription.e2e.spec.ts`, `offline-sync.e2e.spec.ts`, `reports.e2e.spec.ts` |
| Subscription expiration | `tenancy-subscription.e2e.spec.ts`, `offline-sync.e2e.spec.ts` |

## What is built

### Phase 1 — platform foundation and order core
- Multi-tenant schema with composite `(tenant_id, id)` foreign keys and forced row-level security on every tenant table.
- Super Admin API: provision tenants, switch modules per tenant (with prerequisite checks), subscription dates and grace period, suspension.
- JWT auth; users, roles, permissions and approval levels reloaded on every request. One global guard: authentication → active subscription → modules → permissions.
- Append-only audit log for every state change.
- Master data: products (variants, units, images), price lists (tiers, quantity breaks, validity), promotions, customers (groups, addresses with coordinates, credit limit/hold, special discount), stock with weighted-average cost.
- Sales orders: drafts, optimistic locking, idempotent create, server-side pricing and VAT, submit-time revalidation (price, tax, stock, credit, permissions), discount/amount/credit approval tiers, configurable workflow, stock reservation with an oversell-proof trigger.

### Phase 2 — fulfilment, invoicing, collections
- Picking list, start picking, pack, dispatch (delivery note), delivery confirmation with partial acceptance (rejected goods return to stock and are re-reserved, COGS reversed), backorder reservation and short-close.
- Invoices posted to the ledger (AR, discount, revenue, VAT); COGS at dispatch; revenue recognition on delivery or manual.
- Returns with restock at shipped cost and credit notes for the invoiced part.
- Field payment collections: rep submits → accountant verifies (no self-verification) → customer receipt, allocation to the named invoice then oldest, ledger posting, auto-close of settled orders.

### Phase 3 — quotations, visits, territories, targets, commissions
- Quotations: server-priced, send/accept/reject/cancel, expiry, conversion to a draft order at today's prices with a price-change flag.
- Visits: scheduling, check-in with **consent-based location** (company policy OFF / ASK / REQUIRED; nothing stored without the rep's consent for that check-in), check-out with outcome, notes and follow-up tasks, supervisor review; orders linked to an active visit.
- Territories: hierarchy with cycle protection, administrative locations (import/upsert, versioned), primary/backup reps, bulk assignment of customers by location (including sub-locations).
- Targets per rep/team/territory and month/quarter/year for net sales, collections, order count, quantity, new customers and visits, with achievement and pacing.
- Commission plans (invoiced net sales, collected amount or gross profit; product/category/customer/group rates; achievement tiers; overdue clawback and reinstatement), approval with ledger accrual, payroll batch hand-off and HR "mark paid".

### Phase 4 — offline ordering and the web app
- `GET /sales/sync/bootstrap`: the rep's customers, catalogue with stock per authorised warehouse, price lists, tax codes, planned visits, and when the data becomes stale.
- `POST /sales/sync`: batched outbox replay. Each event is its own transaction, idempotent by key (same key + different payload = `CONFLICT`), re-checks subscription, modules and permissions, and goes through the normal services. Orders are re-priced; a total different from what the device showed is routed for approval (`OFFLINE_PRICE_CHANGE`); stale catalogues and backorders are reported back. Visits, visit notes (linked by `visitKey` within a batch) and collections sync too.
- Theme Studio: validated design tokens per tenant served as CSS variables (also on the sign-in page by company code), with contrast warnings.
- `apps/web`: Next.js static PWA with all 18 required screens, responsive (bottom navigation on phones, sidebar on desktop), Dexie/IndexedDB snapshot and outbox, automatic sync on reconnect, service worker for opening the app offline, and stale-stock badges wherever offline data is shown.

| # | Screen | Route |
|---|---|---|
| 1 | Sales Dashboard | `/` |
| 2 | My Customers | `/customers/` |
| 3 | Customer Profile | `/customers/view/?id=` |
| 4 | Product Catalog | `/catalog/` |
| 5 | Product Details | `/catalog/view/?id=` |
| 6 | Create Sales Order | `/orders/new/` |
| 7 | Sales Order Details | `/orders/view/?id=` |
| 8 | My Orders | `/orders/` |
| 9 | Pending Approvals | `/approvals/` |
| 10 | Delivery Tracking | `/deliveries/` |
| 11 | Customer Visits | `/visits/` |
| 12 | Payment Collections | `/collections/` |
| 13 | Sales Targets | `/targets/` |
| 14 | Commission Dashboard | `/commissions/` |
| 15 | Sales Territory Map | `/territories/` |
| 16 | Team Performance | `/team/` |
| 17 | Sales Reports | `/reports/` |
| 18 | Sales Settings (incl. Theme Studio) | `/settings/` |
| + | Offline queue | `/sync/` |

### Phase 5 — reports and analytics
- 11 reports at `GET /sales/reports/:code` (`format=json|xlsx|pdf`): sales by representative, team, territory, customer and product; order conversion; target achievement; discount analysis; customer balances with ageing; commissions; customer visits. Scoped to what the user may see and gated by subscription module (Advanced Analytics, Territory, Commission).
- Mobile sales dashboard, team performance, and territory map data (customer points sized by sales, consented visit check-ins only).

## Known issues and decisions to review

1. **CI on GitHub.** The code is on GitHub (`chankimheng167-lab/ckh-one`); `.github/workflows/ci.yml` runs the same checks on every push.
2. **Dates use UTC.** "Today", default report ranges and visit dates are computed in UTC. Cambodia is UTC+7, so activity between 00:00 and 07:00 local time lands on the previous day. Fix: store a tenant time zone and compute business dates with it.
3. **Order line ids change on submit.** Submit re-prices and re-inserts the lines; anything referencing a line (e.g. a return) must read the order after submit. Harmless today, but a future API should keep line ids stable.
4. **Offline catalogue size.** The snapshot carries up to 5,000 products and is a full download each time; large catalogues need paging and delta sync (`since` is accepted but not used yet).
5. **Offline orders from a stale catalogue are accepted** (and flagged). If the company prefers to block them, that is a one-line policy change in `SyncService`.
6. **Sign-in token lives in browser storage.** Fine for a PWA that must work offline, but it is readable by any injected script; keep a strict Content-Security-Policy and consider short-lived tokens with refresh. There is no refresh-token rotation or device revocation yet.
7. **Admin screens for teams, territories and commission plans are API-only.** The web app covers the 18 required screens; creating territories, assigning reps and editing commission plans is done through the API (or a later admin screen). Quotations and return requests also have full APIs but no dedicated screens.
8. **HR & Payroll is a hand-off only.** Commission batches are sent to `hr/payroll/commission-batches` and marked paid there; there is no payroll engine yet.
9. **Notifications are not sent.** Approvers, reps and accountants see their work in the app, but no push, SMS or email notifications exist yet.
10. **Map tiles** come from the public OpenStreetMap servers and Leaflet's stylesheet from unpkg. Production use needs a tile provider agreement (or self-hosted tiles).
11. Credit exposure assumes one currency per tenant; multi-currency customers need exchange-rate conversion.
12. No Cambodian administrative location dataset is bundled; import one from an official, current source with `POST /locations/import`. Platform-wide (all tenants) import is not exposed yet.
13. Collection receipt photos need object storage; the API stores a storage key only.
14. Territory sales reports use each customer's current territory, not the territory at the time of the sale.
15. The browser smoke test (`apps/web/scripts/smoke.cjs`) is run manually against a seeded demo company; it is not part of CI yet.
