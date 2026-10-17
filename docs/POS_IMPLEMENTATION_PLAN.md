# CKH ONE — POS Sales & Cashier Management: Implementation Plan

_Started 2026-10-17 · built on top of the stage 1 security branch (refresh tokens, licensing on every route, Phnom Penh business dates)._

This document is the audit of the repository as it stood before POS work began, the design that came out of it, and
the phase-by-phase record of what was built and how it was checked. [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)
carries the short status; this file carries the reasoning.

## 1. Repository audit (before POS)

| Area | What exists | Reused by POS |
|---|---|---|
| Stack | pnpm + turbo monorepo. `apps/api` NestJS 10 + `pg` (raw SQL, no ORM) on PostgreSQL 16; `apps/web` Next.js 15 static-export PWA (React 19, Dexie); `packages/shared` pure TypeScript domain logic (decimal.js, zod) | Same stack; POS logic goes in `packages/shared/src/pos.ts`, API in `apps/api/src/pos`, screens in `apps/web/src/app/pos`, Windows app in `apps/desktop` |
| Migrations | `db/migrations/0001–0008` (versioned, checksum-locked) + `db/repeatable/R__rls.sql` (forced row-level security on every table with `tenant_id`) | New `0009_pos_sales.sql`; RLS script picks the new tables up automatically, `pos_licenses` added to the platform-write-only list |
| Tenancy | `tenants`, composite `(tenant_id, id)` foreign keys everywhere, RLS via `app.tenant_id`, `DatabaseService.withTenant()` opens one transaction per request | All POS tables follow the same pattern |
| Auth & permissions | Short-lived JWT + rotating refresh tokens (`auth_sessions`), roles → permission codes (`@ckh/shared/permissions`), approval levels 0–3, one global `AccessGuard` (session → subscription → modules → permissions) | POS permission codes and four new roles; supervisor PIN for in-store approvals |
| Subscriptions | `tenant_subscriptions`, `tenant_modules` (Super Admin only), `SubscriptionService.entitlements()`; a module code `POS` existed with nothing behind it | New module `POS_SALES` gates every POS route; `pos_licenses` holds branch/register/device limits and offline validity |
| Master data | Single `products` master (variants via `parent_product_id` + `variant_attributes`, `barcode`, `image_urls`, units, tax code), `product_categories`, `price_lists`/`price_list_items`, `promotions`, `customers`, `branches`, `warehouses` | Used as-is. Added `products.serial_tracked` and `products.reorder_point` |
| Pricing | `PricingService.resolve()` — price list → group list → default list → list price, best promotion, tax code | POS resolves every price through it (walk-in customer = tenant default list) |
| Inventory | `stock_levels` (on hand, reserved, weighted-average cost) with anti-oversell trigger, `stock_movements` (already allowed a `POS_SALE` type), `StockService` | POS deducts on-hand stock under row locks in product-id order; new `POS_RETURN` movement type |
| Accounting | `chart_of_accounts`, `accounting_settings` mappings, `journal_entries`/`journal_lines` with a deferred balance trigger, `JournalService.post()` | POS posts sales, COGS, refunds, verified payments and cash over/short through it |
| Sales (SFA) | Quotations → sales orders → reservation → dispatch → invoice → collection; returns + credit notes; offline order sync | Untouched. POS sales are a separate document (`pos_sales`): immediate payment, immediate stock issue, no approval workflow |
| Offline | SFA: Dexie snapshot + outbox, `sales_offline_sync_events` idempotency log | Same idempotency design for POS devices (`pos_sync_events`), but device-licensed and cash-only |
| Theme | Theme Studio tokens → CSS variables (`/theme`) | POS screens use the same variables |
| POS components | None (only the module code and the `POS_SALE` movement type) | — |
| Tests | 98 API end-to-end tests against a real database, 16 shared unit tests, SQL guard checks, browser smoke test | New `pos-*.e2e.spec.ts` suites and `pos.spec.ts` unit tests |

## 2. Architecture decisions

1. **POS sales are their own document, not sales orders.** A POS sale is priced, paid, and issued from stock in one
   transaction at the till. Sales orders keep their approval → reservation → delivery → invoice flow. Both share
   products, customers, prices (`PricingService`), stock (`stock_levels`/`stock_movements`), the ledger
   (`JournalService`), numbering, audit log and licensing.
2. **The server decides every number.** The till sends product ids, quantities, discounts and tenders. The API looks
   up prices itself, prices the cart with `pricePosCart()` (exact decimals, half-up per line, order discount spread by
   largest remainder), checks discount limits and payment rules, and rejects a sale whose total differs from what the
   till showed (`expectedTotal`). The same shared code gives the till an instant preview and prices offline sales.
3. **One checkout = one database transaction**: validate shift/register/licence → price → lock stock rows in id order
   → insert sale, lines, payments → deduct stock + movements → cash drawer movement → revenue and COGS journals →
   audit. Any failure rolls back everything.
4. **Exactly once.** `pos_sales (tenant_id, client_sale_id)` is unique; a retry with the same id and payload returns
   the stored sale, the same id with a different payload is a `409`. Payment references for transfers/QR and provider
   transaction ids are unique per method, so one transfer cannot pay two sales. Stock is deducted only inside the
   sale transaction, so it cannot be deducted twice.
5. **Payments.** Methods are configurable per tenant (`pos_payment_methods`: cash, card, QR, bank transfer, other)
   with a ledger account each. Change is only given from cash; non-cash tenders may never exceed what is owed.
   Methods that need verification (KHQR, bank transfer) are recorded `PENDING_VERIFICATION` and posted to a
   *payments pending verification* clearing account; a person with `pos.payments.verify` (or a verified provider
   integration, when one exists) confirms or rejects them. Card payments go through the shop's card terminal; the
   till stores only the approval code, and rejects anything that looks like a card number.
6. **Discount and price authority.** Cashiers may discount up to `cashier_max_discount_percent`; above that, or for a
   price override, a supervisor approves on the till with their POS PIN (`pos.discount.override` /
   `pos.price.override`), up to `override_max_discount_percent`. The approver is recorded on the sale and in the audit
   log. Five wrong PINs lock the PIN for 15 minutes.
7. **Shifts.** One open shift per register (partial unique index). Every cash movement (float, cash sales, cash
   refunds, cash in/out) is an append-only row; expected cash is their sum. Closing records the count and the
   difference (posted to *cash over and short*); a supervisor other than the cashier approves. A database trigger
   freezes closed shifts and cash movements.
8. **Accounting.** Sale: Dr payment accounts (cash / card clearing / pending verification), Dr sales discounts,
   Cr sales revenue (gross ex-tax), Cr VAT output; COGS: Dr COGS, Cr inventory at weighted-average cost. Refunds
   reverse both in proportion. Every entry is checked to balance in code and by the deferred database trigger, and
   carries `source_type`/`source_id` so `/pos/reconciliation` can prove nothing was posted twice or missed.
   Tax rates come from the tenant's tax codes (VAT 10% default, exempt available); whether a given product or
   customer is taxable under Cambodian rules is a per-tenant configuration that the company's accountant must confirm.
9. **Licensing.** `POS_SALES` must be on for every POS route. `pos_licenses` (Super Admin only) limits branches,
   registers and devices and sets how long a Windows POS may sell offline. The global guard already blocks expired or
   suspended subscriptions.
10. **Windows POS** (`apps/desktop`): Electron + React. Business rules stay on the server; the app holds a device
    secret in the OS credential store, a signed offline licence (Ed25519, verified locally with the server's public
    key), an encrypted local database for the catalogue cache and the outbox, and talks to printers/drawers locally.
    No signing keys or database credentials ship in the app.

## 3. Database design (migration `0009_pos_sales.sql`)

| Table | Purpose | Key constraints |
|---|---|---|
| `pos_licenses` | Super Admin limits per tenant: branches, registers, devices, offline hours | PK tenant; RLS: tenant read, platform write |
| `pos_settings` | Tax-inclusive prices, discount limits, negative stock, shift rules, walk-in customer, receipt layout, ledger mappings | FKs to customers/accounts; override ≥ cashier limit |
| `pos_payment_methods` | Configurable tenders and their ledger accounts | unique code; only cash may be taken offline |
| `pos_registers` | Till: branch + warehouse + hardware settings | unique code per tenant |
| `pos_staff_branches` | Which branches a cashier/supervisor works in | PK (user, branch) |
| `pos_devices` | Licensed Windows POS installations | secret stored as SHA-256 only; one active row per device key |
| `pos_shifts` | Cashier shifts | one OPEN per register; trigger freezes CLOSED/APPROVED |
| `pos_cash_movements` | Float, cash sales, refunds, cash in/out | signed amount by type; append-only; only into an OPEN shift |
| `pos_sales` | Completed POS sales (header) | unique `(tenant, client_sale_id)`; refunded ≤ total |
| `pos_sale_lines` | Lines with full price/discount/tax breakdown and unit cost | net + tax = total; returned ≤ sold |
| `pos_sold_serials` | Serial numbers out of the shop | a serial can be sold once until returned |
| `pos_sale_payments` | Tenders | change only on cash; unique transfer/QR reference and provider transaction id |
| `pos_held_sales` | Parked carts | — |
| `pos_returns`, `pos_return_lines`, `pos_return_refunds` | Returns against a sale and how money went back | unique `(tenant, client_return_id)`; refund = net + tax per line |
| `pos_receipts` | Every receipt printed (original, reprint, refund) | — |
| `pos_sync_events` | Offline transactions received from devices | unique `(tenant, idempotency_key)` |

Changed: `products` (+`serial_tracked`, `reorder_point`), `users` (+POS PIN hash and lockout), `stock_movements`
(+`POS_RETURN`), `stock_levels_no_oversell` (negative on-hand allowed only where reserved stock is zero, so offline
sales and the company's negative-stock policy work; reserved stock still can never exceed on hand).

Every existing company gets: four ledger accounts (1020 card clearing, 1030 payments pending verification, 5100
inventory adjustments, 6900 cash over and short), POS settings, four payment methods (Cash, Card, KHQR, Bank transfer),
a licence row, document numbering, the four POS roles, POS permissions on the administrator role, and `POS_SALES`
wherever the old `POS` switch was on.

## 4. Permissions

| Permission | Cashier | Supervisor | Manager | Branch admin | Tenant admin |
|---|:-:|:-:|:-:|:-:|:-:|
| `pos.access`, `pos.sales.create`, `pos.cash.drawer`, `pos.shift.close` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `pos.discount.apply` (up to cashier limit) | ✓ | ✓ | ✓ | ✓ | ✓ |
| `pos.discount.override`, `pos.price.override` | | ✓ | ✓ | ✓ | ✓ |
| `pos.refunds.create`, `pos.receipts.reprint` | | ✓ | ✓ | ✓ | ✓ |
| `pos.shift.approve`, `pos.payments.verify`, `pos.reports.view`, `pos.sales.view_all` | | ✓ | ✓ | ✓ | ✓ |
| `pos.registers.manage`, `pos.devices.manage` | | | ✓ | ✓ | ✓ |
| `pos.settings.manage`, `pos.branches.all` | | | ✓ | | ✓ |

Without `pos.branches.all` a user works only in branches listed in `pos_staff_branches`. A cashier refund or an
over-limit discount can still go through when a supervisor approves it with their PIN on the till. All checks run in
the API; menus only hide what the API would refuse anyway.

## 5. Phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Audit, database design, architecture, shared POS money logic | ✅ |
| 2 | POS backend: registers, catalogue, checkout transaction, permissions, inventory | ✅ |
| 3 | Touchscreen POS screen and payment workflow | ✅ |
| 4 | Receipts, returns/refunds, shifts, reports | ✅ |
| 5 | Accounting integration and reconciliation | ✅ |
| 6 | Windows desktop POS and hardware | |
| 7 | Offline sync and device licensing | |
| 8 | Security tests, documentation, deployment | |

### Phase 1 — done
- This audit and design.
- `packages/shared/src/pos.ts`: cart pricing (line + order discounts, tax-exclusive and tax-inclusive), split-tender
  settlement, proportional refunds, card-number guard. 14 unit tests.
- `0009_pos_sales.sql` applied cleanly to an empty database and RLS re-applied.
- POS permissions, roles and the `POS_SALES` module in `@ckh/shared`; new companies are provisioned with POS defaults.

### Phase 2 — done
- APIs under `/pos`: context, catalogue (search, categories, variants, barcode/pack/SKU scan), customers (search, quick add),
  quote, checkout, sales history and details, held sales, approvers, approval PIN, dashboard; `/pos/shifts` (open, cash
  in/out, close with blind count and over/short journal, supervisor approval); `/pos/admin` (registers with licence
  limits, settings, payment methods, staff branches, licence usage). Super Admin: `GET/PUT /platform/tenants/:id/pos-license`,
  `GET /platform/pos/usage`.
- Checkout is one transaction: server pricing, discount/price-override limits with supervisor PIN, split payments
  (change only from cash, no non-cash overpayment, card numbers refused), stock row locks, serials, drawer movement and one
  balanced `POS_SALE` journal (payments, revenue, discounts, VAT, COGS/inventory). Idempotent on `clientSaleId`.
- Bank transfer and QR methods must carry a reference and wait for verification; card methods need the approval code
  (enforced by the API and by CHECK constraints).
- 28 end-to-end tests in `apps/api/test/pos-checkout.e2e.spec.ts`.
- Upgrade path checked: a database at the previous release with the demo company and a stock reservation migrated to
  `0009` cleanly; the old `POS` module flag carried over to `POS_SALES`.

### Phase 3 — done
- Web POS at `/pos/` (static export, same PWA, Theme Studio colours): full-screen touch layout with header (company logo,
  branch, register, cashier, shift, online/offline, clock) and bottom bar (New sale, Held sales, Sales history, Returns,
  Cash shifts, Settings).
- Till (`/pos/sell/`): category chips, search, product grid with images, stock and low-stock badges; keyboard-wedge
  barcode capture (Enter/Tab suffix per register); variant picker; serial-number entry; line sheet (quantity, % or amount
  discount, price override by permission); order discount; customer search and quick add; hold; cancel. Every change is
  priced by `POST /pos/quote`; the till shows server totals only.
- Payment sheet: cash with quick-tender buttons and change, card with approval code, KHQR and bank transfer flagged as
  “verified later”, split tenders, supervisor PIN approval prompt, retry-safe (same client sale id after a network error).
- Pages: POS dashboard, product catalog, held sales, sales history, sale details, cash shifts (open, cash in/out, blind
  close with denomination count, approve), shift report, cash movements, registers and staff branches, printer/hardware
  settings per register, POS settings (rules, ledger accounts, payment methods, own PIN), menu.
- Demo data: `pnpm --filter @ckh/api db:seed` adds POS users (`cashier@demo.ckh.one`, `possupervisor@demo.ckh.one` PIN
  2468, `posmanager@demo.ckh.one` PIN 1357), register R1, categories, barcodes, a T-shirt with sizes and a serial-numbered
  phone to the demo company (also on an existing demo database).
- Browser run-through (Playwright, Chromium, 1366×768 and 800×1100): sign in as cashier, open shift, tap products, scan a
  barcode, pick a variant, enter a serial, discount above the cashier limit, split card + cash payment with supervisor PIN,
  sale details, hold and resume, cash out, close shift. All steps passed.
- The web till is online-only by design; offline selling is the Windows app (phase 7). Receipts print in phase 4.

### Phase 4 — done
- Returns and refunds (`POST /pos/returns`, preview, list, details, `GET /pos/sales/:id/returnable`, lookup by receipt
  number): partial or full returns of a sale, priced proportionally by the shared `refundForLine` (discount and VAT come
  back in the same share), never more than was sold. Refund permission or a supervisor PIN; each refund goes back only
  to tenders that were confirmed on that sale and up to what they paid; non-cash refunds need a reference; a cash refund
  needs enough cash in the drawer. Restock or mark damaged per line; serial numbers must be named, belong to the sale and
  be returned only once. One transaction writes the return, stock back at the sale's cost, a negative drawer movement
  and a balanced `POS_RETURN` journal (revenue, discount, VAT, tender, inventory/COGS). Idempotent on `clientReturnId`.
- Receipts (`POST /pos/sales/:id/receipt`, `POST /pos/returns/:id/receipt`): 58 mm, 80 mm and A4, as HTML, PDF or plain
  text, in English, Khmer and Chinese (one or two languages side by side). The first print is the original; every later
  print is marked REPRINT, needs reprint permission or a supervisor PIN, and is audited. Every print is logged in
  `pos_receipts`. Header, footer, logo and TIN come from receipt settings. The web till prints the original by itself
  after a sale (switchable per register) through the browser print dialog.
- Daily sales report (`GET /pos/reports/daily`, JSON or CSV): totals, refunds, net after refunds, margin, by register,
  cashier, payment method (confirmed, waiting for verification, refunded), hour, category, top products, VAT by rate
  with returned VAT, shifts with cash differences, and approved discounts. Limited to the user's branches; CSV cells
  that look like formulas are neutralised.
- Pages: returns (lookup and list), new return, return details, receipt print and preview (paper and language), daily
  report with CSV download, receipt settings.
- 15 end-to-end tests in `apps/api/test/pos-returns.e2e.spec.ts`; API suite 141/141.
- Browser run-through (Chromium): cash sale, automatic original print, reprint with supervisor PIN, receipt page,
  return of one item with supervisor PIN, return details, daily report and CSV as supervisor, receipt settings as
  manager. All steps passed; the database showed ORIGINAL, REPRINT and REFUND prints logged.
- Limits, stated plainly:
  - Receipt printing was tested only as far as the browser print call and the rendered HTML; no physical receipt
    printer has been tested. Silent printing, ESC/POS and the cash drawer belong to the Windows app (phase 6).
  - Plain-text receipts are English only. Khmer and Chinese PDFs need a font installed on the server
    (`RECEIPT_FONT_KM`, `RECEIPT_FONT_ZH` paths to TTF/OTF files); without one the API refuses the PDF and HTML is used.
  - The Khmer and Chinese receipt labels were written by us and need checking by a native speaker before customer use.
  - Refunds to bank, QR or card are recorded with a reference; the money is sent back outside CKH ONE. No payment
    provider is integrated.

### Phase 5 — done
- Payment verification (`GET /pos/payments/pending`, `POST /pos/payments/:id/verify`, `pos.payments.verify`): someone
  other than the cashier who took a transfer/QR payment confirms it (Dr the method's bank account, Cr payments pending
  verification) or rejects it with a reason (Dr cash over and short, Cr pending). A rejected payment leaves
  `amount_unpaid` on the sale and the sale shows *Balance due*. A payment is verified once only.
- Balance settlement (`POST /pos/sales/:id/settle`): the customer pays what is owed by any method (cash may give change,
  other methods may not exceed the balance); Dr the method (or pending again for QR/transfer), Cr cash over and short,
  with a drawer movement for cash. Idempotent on `clientPaymentId`.
- Offline-sale review (`POST /pos/sales/:id/review`): a supervisor other than the cashier marks a flagged sale reviewed
  with a note.
- Reconciliation (`GET /pos/reconciliation`, `pos.reports.view`) for a date range: each sale posted once and for its
  payments + discounts + cost; payments + balance due = sale total; each return posted, balanced and equal to its
  refunds; every verification, rejection and settlement posted; closed drawers add up and every over/short posted;
  the pending-verification account equals the payments still waiting (shown to users who see all branches). Plus the
  pending amount, balances due, rejections and sales to review.
- `/accounting/integrity` gains `POS_DOCUMENTS_POSTED` and `POS_PENDING_CLEARING_MATCHES` (all dates, all branches).
- A unique index allows one journal entry per POS document (`journal_entries_pos_source_uq`), so nothing can be
  posted twice, even by a direct database write.
- Pages: payments to verify, verify/reject sheet, balance payment on the sale page, mark reviewed, reconciliation.
- 7 end-to-end tests in `apps/api/test/pos-payments.e2e.spec.ts` (including tampering detection); API suite 148/148.
- Browser run-through: KHQR sale (cashier gets no Verify button), supervisor rejects it from the list, cashier takes
  the balance in cash with change, manager sees a clean reconciliation. All steps passed.
- To confirm with the company's accountant: a rejected transfer is booked to *cash over and short* (6900) until the
  customer pays. A company that prefers a receivable can map that account in POS settings to another account.
  KHQR/bank statements are checked by a person; there is no bank or Bakong API integration.
