# CKH ONE — Repository Audit and Gap Report

_Audited 2026-10-17 against the CKH ONE master requirements. Every source file, migration, API route, web page and test was read; the README and IMPLEMENTATION_STATUS were not taken on trust. Test results below were produced by running the suites, not copied._

**Bottom line:** the repository is a solid, well-tested **Sales Force Automation (SFA) product on a multi-tenant platform core**. It is **not** the complete CKH ONE platform. POS (web and Windows), retail, restaurant, hotel, HR/payroll, purchasing, AP, bank reconciliation, financial statements, Cambodia tax reporting, subscription billing and Khmer/Chinese UI do not exist yet.

## 1. Test results (actual runs)

| Check | Before this audit (main) | After stage 1 (this branch) |
|---|---|---|
| `@ckh/shared` unit tests | 16 / 16 pass | 16 / 16 pass |
| API type-check | pass | pass |
| Database guard checks (`db/tests/schema_guards.sql`) | 7 / 7 guards fire | 7 / 7 guards fire |
| API end-to-end tests (real PostgreSQL 16, restricted RLS login) | 74 / 74 pass (6 suites) | **98 / 98 pass (7 suites)** |
| Web type-check + static build | pass | pass |
| Browser smoke test (Chromium; rep, manager, admin, accountant; every screen; offline order then sync) | not run in audit | **ALL GOOD** |

The only thing the sandbox could not show is map tiles (OpenStreetMap is unreachable from the build machine); the territory screen itself loads without errors.

## 2. Requirement comparison

Legend: ✅ fully implemented and tested · 🟡 partially implemented · 🖥 UI only · ⚙️ backend only · ❌ missing · ⚠️ failing or insecure (before stage 1)

### Platform and SaaS

| Requirement | Status | Evidence |
|---|---|---|
| Multi-tenant data model, composite tenant FKs | ✅ | `0001`–`0007` migrations; guard checks |
| Row-level security on every tenant table | ✅ (now verified by a catalogue test) | `R__rls.sql`; `security.e2e` checks every `tenant_id` table has forced RLS + policy |
| Super Admin API: create tenant, modules, subscription dates, suspend | 🟡 | `platform.controller.ts`; no tenant edit/delete, plans, billing or licence keys |
| Super Admin web dashboard | 🟡 | `/platform` page from PR #1 (create, modules, subscription, status) — no dashboard metrics, plan management, invoices |
| Module activation per tenant with prerequisites | ✅ | `validateModuleSet`, `tenancy-subscription.e2e` |
| Module licensing enforced on every protected API | ⚠️ → ✅ | Routes without `@RequireModules` were reachable without any licence; now fail closed to `CORE`, route inventory test |
| Subscription expiry / grace / suspension enforcement | ✅ | guard + `tenancy-subscription.e2e`, `offline-sync.e2e` |
| Subscription billing, renewal, payment verification | ❌ | `subscription_plans` table only; no invoices, payments or renewals |
| Licence keys / Windows device-bound offline licensing | ❌ | planned with Windows POS (stage 3) |
| Authentication | ⚠️ → ✅ | was: 8-hour JWT, no refresh, no revocation, no lockout. Now: 15-min access token + rotating refresh tokens + device sessions + lockout |
| Refresh-token rotation, device/session revocation | ❌ → ✅ | `session.service.ts`, `security.e2e` |
| Production demo credentials | ⚠️ → ✅ | seed used `ChangeMe!2026` for Super Admin when env unset; now refused in production |
| CORS | ⚠️ → ✅ | reflected any origin; now `CORS_ORIGINS` required in production |
| Tenant business time zone | ⚠️ → ✅ | all business dates were UTC (Cambodia activity 00:00–07:00 landed on the previous day); now per-tenant zone, default `Asia/Phnom_Penh` |
| Audit log (append-only) | ✅ | guard check: app login cannot update/delete |
| Notifications (push/SMS/email) | ❌ | none |

### Business modules

| Requirement | Status | Evidence / gap |
|---|---|---|
| Sales Force Automation (orders, approvals, fulfilment, invoicing, collections, quotations, visits, territories, targets, commissions, offline ordering, 11 reports) | ✅ | 5 phases, 18 screens, 6 e2e suites |
| Customer management | ✅ | master data + SFA customer screens |
| Inventory (stock, reservations, weighted average cost, anti-oversell) | 🟡 | stock levels, movements, receipts; no transfers, counts, adjustments UI, batches/serials |
| Accounting: double-entry journal, CoA, trial balance, AR | 🟡 | posting engine + balanced-entry trigger; **no** manual journals, AP, bank reconciliation, periods, P&L, balance sheet, cash flow |
| Accounting integrity checks | ❌ → ✅ | new `GET /accounting/integrity` (balanced journals, trial balance, AR control = sub-ledger, no oversell, offline events settled), asserted after billing and offline replay |
| POS (web) | ❌ | `POS` module code exists, no implementation |
| Windows desktop POS (Electron, SQLite, printing, offline sync) | ❌ | — |
| Retail POS (shoes/clothing, variants, barcode, returns) | ⚙️ partial data model | `products.parent_product_id` + `variant_attributes`, `barcode`; no POS checkout, size/colour matrix, barcode scanning |
| Restaurant (tables, menus, KDS, ingredient inventory) | ❌ | — |
| Hotel (rooms, availability, check-in/out, folios, housekeeping) | ❌ | — |
| HR & payroll | ❌ | only the commission → payroll hand-off |
| Purchasing, suppliers, trading, warehouse operations | ❌ | no suppliers, POs, goods receipts against POs, transfers |
| Theme & Appearance Studio | 🟡 | per-tenant tokens with contrast checks; **no** presets (need ≥ 20), menu layouts, brand accent `#064941` |
| Cambodia tax reporting | ❌ | only a default `VAT10` tax code; no VAT return, withholding, prepayment of profit tax, GDT formats |
| Integrated reporting and analytics | 🟡 | 11 sales reports with Excel/PDF; no financial or cross-module reports |

### UI / UX

| Requirement | Status |
|---|---|
| Real pages with navigation, tables, forms, filters | ✅ for SFA (18 screens) and Super Admin (1 page) |
| Master mockup styling, `#064941` accent | ❌ (current default accent `#1f6feb`) |
| English | ✅ |
| Khmer, Chinese | ❌ (no i18n framework) |
| Desktop, tablet, mobile | ✅ (responsive PWA) |
| Windows touchscreen POS | ❌ |

## 3. Security findings and what stage 1 changed

| # | Finding (severity) | Fix | Test |
|---|---|---|---|
| S1 | Access tokens lived 8 h and could not be revoked; a stolen phone stayed signed in (High) | Device sessions (`auth_sessions`); access tokens 15 min and carry the session id, checked on every request | `security.e2e` › logout, lost device, admin revoke, disable user |
| S2 | No refresh tokens; long-lived bearer token in `localStorage` (High) | Single-use refresh tokens stored as SHA-256 hashes, rotated on every use, **reuse of an old token revokes the session**; 30 s grace for two tabs racing. Web app keeps the access token in memory only | › rotation, replay, two tabs |
| S3 | No brute-force protection (Medium) | Lockout after 5 failures for 15 min; admin password reset unlocks and signs the user out | › lockout |
| S4 | Production seed fell back to the public password `ChangeMe!2026` for the Super Admin (High) | Production requires `SUPERADMIN_PASSWORD` (policy-checked, not the demo password); demo company not seeded in production unless `SEED_DEMO=true` + `DEMO_PASSWORD` | › seed options |
| S5 | CORS reflected any origin (Medium) | `CORS_ORIGINS` required in production; API refuses to start without it | › config |
| S6 | No security headers (Low) | nosniff, `DENY` framing, no-referrer, CSP, HSTS in production, `no-store` on auth; CSP on the web app | › headers |
| S7 | Licensing failed open: routes without `@RequireModules` needed no module (Medium) | Guard requires `CORE` when a route declares nothing; `CORE` cannot be switched off; route-inventory test | › licensing |
| S8 | `platform_admins` (password hashes) had no RLS, readable from tenant sessions via any SQL bug (Medium) | Forced RLS, platform-only policy | › RLS catalogue |
| S9 | JWT algorithm/issuer/audience not pinned (Low) | HS256 only, issuer `ckh-one`, audience `ckh-one-api` | › forged / wrong issuer / cross-tenant tokens |
| S10 | Business dates in UTC (Medium, data correctness) | Transaction `TimeZone` set to the tenant zone; JS dates via `tx.today()`; validated zone column; document-number year in local time | › time zone |
| S11 | No password change / admin reset endpoints | `POST /auth/password` (signs out other devices), `PUT /admin/users/:id/password` | › password change |

Residual risks, documented rather than fixed in this stage:

- The refresh token is in `localStorage` so reps can reopen the app offline. Mitigations: single-use rotation, reuse detection, CSP, server-side revocation. The Windows POS will use the OS credential store instead.
- `app.platform_admin` is a session setting the application login can set; a SQL-injection bug could use it. All SQL is parameterised. A separate database role for Super Admin operations is on the roadmap.
- Lockout is per account. Put the API behind a reverse proxy with per-IP rate limiting (see `DEPLOYMENT.md`).

## 4. Missing-feature checklist

- [x] Refresh-token rotation, device sessions, revocation, lockout
- [x] Tenant business time zone (Asia/Phnom_Penh default)
- [x] Fail-closed module licensing on every API
- [x] RLS catalogue verification, Super Admin rows hidden from tenants
- [x] Ledger integrity endpoint (incl. after offline replay)
- [x] No public demo credentials in production
- [ ] Super Admin dashboard: tenant edit/close, plans and pricing, metrics, audit viewer, impersonation-free support tools
- [ ] Subscription billing: subscription invoices, payment recording and verification (ABA / bank transfer reference), renewals, reminders, automatic expiry
- [ ] Licence keys: signed licence tokens, Windows device activation and device-bound offline licence with expiry
- [ ] Windows POS (Electron): encrypted SQLite, cashier sign-in and shifts, cash drawer, receipt printing (ESC/POS 80 mm), barcode scanners, offline queue and sync, installer
- [ ] Web POS + Retail: variant matrix (size × colour), barcode lookup, held sales, discounts, split tender, returns/exchanges, receipts
- [ ] Restaurant: floor plan and tables, menus and modifiers, orders to kitchen display, recipes and ingredient deduction
- [ ] Hotel: room types and rooms, rates, availability calendar, reservations, check-in/out, folios, housekeeping board
- [ ] Accounting: manual journals, periods and closing, AP (supplier bills and payments), bank accounts and reconciliation, P&L, balance sheet, cash flow, general ledger report
- [ ] HR and payroll: employees, contracts, attendance, leave, payroll runs with Cambodian salary tax and NSSF, payslips, ledger posting
- [ ] Purchasing and warehouse: suppliers, purchase orders, goods receipts, supplier returns, transfers, stock counts
- [ ] Theme Studio: ≥ 20 presets, custom colours, menu layouts, logo/branding, `#064941` accent default
- [ ] Cambodia tax: configurable rules (VAT, withholding, prepayment of profit tax, specific tax, accommodation tax), monthly return reports, verified against GDT guidance with a review step
- [ ] Integrated reporting: financial statements, inventory, POS, restaurant, hotel, HR dashboards
- [ ] Internationalisation: English, Khmer (ខ្មែរ), Chinese (中文)
- [ ] Notifications (email/SMS/Telegram) for approvals, expiries, renewals

## 5. Prioritised roadmap

Delivered as one pull request per stage, each with migrations, API, UI, automated tests and documentation.

| Stage | Scope | Why this order |
|---|---|---|
| **1. Audit and security** (this PR) | Everything in section 3 | Everything else builds on authentication, licensing and correct dates |
| **2. Super Admin and subscription licensing** | Full Super Admin dashboard on the PR #1 page; plans; subscription invoices, payment verification, renewals and automatic expiry; signed licence tokens; licence enforcement tests | The business needs to sell and control licences before shipping POS |
| **3. Windows POS** | Web POS API (shifts, sales, payments, returns) + Electron app with encrypted SQLite, receipt printing, offline queue, device-bound offline licence, Windows installer | Most-requested client deliverable; depends on stage 2 licensing |
| 4. Retail | Variant matrix, barcode, exchanges | Extends the POS |
| 5. Purchasing and warehouse | Suppliers, POs, receipts, transfers, counts | Needed by retail, restaurant ingredients and AP |
| 6. Full accounting | AP, bank reconciliation, periods, statements | Needs purchasing for AP |
| 7. Restaurant | Tables, menus, KDS, recipes | Uses POS + ingredient inventory |
| 8. Hotel | Rooms, reservations, folios, housekeeping | Uses POS folio charges + accounting |
| 9. HR and payroll | Employees, attendance, leave, payroll + ledger | Replaces the commission hand-off |
| 10. Cambodia tax | Configurable rules + returns | Needs complete accounting data |
| 11. Theme Studio, i18n (EN/KM/ZH), `#064941` design system | Cross-cutting UI | Can run alongside stages 4–10 |
| 12. Integrated reporting | Cross-module dashboards | Last: reads everything else |

## 6. Decisions to review

1. **Access token lifetime 15 min, sessions 30 days sliding** (`JWT_TTL_SECONDS`, `REFRESH_TTL_DAYS`). A rep who stays offline more than 30 days must sign in again.
2. **Refresh reuse grace 30 s** (`REFRESH_REUSE_GRACE_SECONDS`). Shorter is stricter but signs people out when two tabs refresh together.
3. **Existing companies keep their stored zone** (`Asia/Phnom_Penh` was already the column default). The Super Admin can change it with `PUT /platform/tenants/:id/settings`.
