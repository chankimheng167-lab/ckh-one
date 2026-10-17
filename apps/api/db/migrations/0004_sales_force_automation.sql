-- CKH ONE — Sales Force Automation module.
-- Reuses users, customers, products, warehouses, invoices; adds no second
-- customer or product master.

-- ---------------------------------------------------------------------------
-- Settings (one row per tenant)
-- ---------------------------------------------------------------------------
CREATE TABLE sales_settings (
  tenant_id                 uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- See ApprovalLimits in @ckh/shared
  approval_limits           jsonb NOT NULL DEFAULT '{"repMaxDiscountPercent":"5","supervisorMaxDiscountPercent":"10","managerMaxDiscountPercent":"20","managerOrderAmountThreshold":null,"directorOrderAmountThreshold":null}'::jsonb,
  -- See OrderWorkflowSettings in @ckh/shared
  workflow                  jsonb NOT NULL DEFAULT '{"pickPackEnabled":true,"invoiceOnDispatch":false}'::jsonb,
  -- Reps may edit unit prices only when this is true (still needs approval).
  allow_price_override      boolean NOT NULL DEFAULT false,
  -- Allow orders that exceed stock to be accepted with the shortfall backordered.
  allow_backorders          boolean NOT NULL DEFAULT true,
  -- Reps see customer outstanding balances (also needs permission).
  show_balances_to_reps     boolean NOT NULL DEFAULT true,
  -- Location capture on visit check-in: OFF, ASK (default), REQUIRED.
  visit_location_capture    text NOT NULL DEFAULT 'ASK' CHECK (visit_location_capture IN ('OFF', 'ASK', 'REQUIRED')),
  offline_catalog_max_age_hours integer NOT NULL DEFAULT 24,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Teams and representatives
-- ---------------------------------------------------------------------------
CREATE TABLE sales_teams (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code                text NOT NULL,
  name                text NOT NULL,
  parent_team_id      uuid,
  supervisor_user_id  uuid,
  manager_user_id     uuid,
  branch_id           uuid,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_team_id) REFERENCES sales_teams (tenant_id, id),
  FOREIGN KEY (tenant_id, supervisor_user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, manager_user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);

CREATE TABLE sales_representatives (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL,
  employee_code         text NOT NULL,
  team_id               uuid,
  default_branch_id     uuid,
  default_warehouse_id  uuid,
  -- Personal discount ceiling; NULL = tenant default (sales_settings).
  max_discount_percent  numeric(7,4) CHECK (max_discount_percent IS NULL OR max_discount_percent BETWEEN 0 AND 100),
  commission_plan_id    uuid,          -- FK added below
  hr_employee_id        uuid,          -- link to HR & Payroll employee
  status                text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  joined_on             date,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, employee_code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, team_id) REFERENCES sales_teams (tenant_id, id),
  FOREIGN KEY (tenant_id, default_branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, default_warehouse_id) REFERENCES warehouses (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Territories
-- ---------------------------------------------------------------------------
CREATE TABLE sales_territories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code            text NOT NULL,
  name            text NOT NULL,
  territory_type  text NOT NULL DEFAULT 'TERRITORY' CHECK (territory_type IN ('REGION', 'AREA', 'TERRITORY')),
  parent_id       uuid,
  team_id         uuid,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES sales_territories (tenant_id, id),
  FOREIGN KEY (tenant_id, team_id) REFERENCES sales_teams (tenant_id, id)
);

-- Geography covered by a territory (provinces, districts, communes...).
CREATE TABLE sales_territory_locations (
  tenant_id     uuid NOT NULL,
  territory_id  uuid NOT NULL,
  location_id   uuid NOT NULL REFERENCES admin_locations(id),
  PRIMARY KEY (territory_id, location_id),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES sales_territories (tenant_id, id) ON DELETE CASCADE
);

-- Representatives assigned to a territory (dated, so history is kept).
CREATE TABLE sales_territory_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  territory_id    uuid NOT NULL,
  sales_rep_id    uuid NOT NULL,
  role            text NOT NULL DEFAULT 'PRIMARY' CHECK (role IN ('PRIMARY', 'BACKUP')),
  valid_from      date NOT NULL DEFAULT CURRENT_DATE,
  valid_to        date,
  assigned_by     uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES sales_territories (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, sales_rep_id) REFERENCES sales_representatives (tenant_id, id)
);
CREATE INDEX sales_territory_assignments_rep_idx ON sales_territory_assignments (tenant_id, sales_rep_id);

-- Which reps may see / sell to which customers.
CREATE TABLE sales_customer_assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  customer_id      uuid NOT NULL,
  sales_rep_id     uuid NOT NULL,
  territory_id     uuid,
  assignment_type  text NOT NULL DEFAULT 'PRIMARY' CHECK (assignment_type IN ('PRIMARY', 'SECONDARY')),
  valid_from       date NOT NULL DEFAULT CURRENT_DATE,
  valid_to         date,
  assigned_by      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, sales_rep_id) REFERENCES sales_representatives (tenant_id, id),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES sales_territories (tenant_id, id)
);
-- One open primary rep per customer.
CREATE UNIQUE INDEX sales_customer_assignments_one_primary
  ON sales_customer_assignments (tenant_id, customer_id)
  WHERE assignment_type = 'PRIMARY' AND valid_to IS NULL;
CREATE INDEX sales_customer_assignments_rep_idx ON sales_customer_assignments (tenant_id, sales_rep_id);

-- ---------------------------------------------------------------------------
-- Targets and commissions
-- ---------------------------------------------------------------------------
CREATE TABLE sales_targets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope         text NOT NULL CHECK (scope IN ('REP', 'TEAM', 'TERRITORY')),
  sales_rep_id  uuid,
  team_id       uuid,
  territory_id  uuid,
  period_type   text NOT NULL CHECK (period_type IN ('MONTH', 'QUARTER', 'YEAR')),
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  metric        text NOT NULL CHECK (metric IN ('NET_SALES', 'COLLECTIONS', 'ORDER_COUNT', 'QUANTITY', 'NEW_CUSTOMERS', 'VISITS')),
  product_id    uuid,
  category_id   uuid,
  target_value  numeric(18,2) NOT NULL CHECK (target_value > 0),
  currency      char(3),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  CHECK (
    (scope = 'REP' AND sales_rep_id IS NOT NULL AND team_id IS NULL AND territory_id IS NULL) OR
    (scope = 'TEAM' AND team_id IS NOT NULL AND sales_rep_id IS NULL AND territory_id IS NULL) OR
    (scope = 'TERRITORY' AND territory_id IS NOT NULL AND sales_rep_id IS NULL AND team_id IS NULL)
  ),
  FOREIGN KEY (tenant_id, sales_rep_id) REFERENCES sales_representatives (tenant_id, id),
  FOREIGN KEY (tenant_id, team_id) REFERENCES sales_teams (tenant_id, id),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES sales_territories (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES product_categories (tenant_id, id)
);
CREATE INDEX sales_targets_period_idx ON sales_targets (tenant_id, period_start, period_end);

CREATE TABLE sales_commission_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL,
  name        text NOT NULL,
  -- What a commission is earned on.
  basis       text NOT NULL CHECK (basis IN ('INVOICED_NET_SALES', 'COLLECTED_AMOUNT', 'GROSS_PROFIT')),
  -- Rule set: default rate, product / category / customer overrides, tiers,
  -- clawback rules for returns, credit notes and overdue invoices.
  rules       jsonb NOT NULL,
  valid_from  date NOT NULL,
  valid_to    date,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

ALTER TABLE sales_representatives
  ADD FOREIGN KEY (tenant_id, commission_plan_id) REFERENCES sales_commission_plans (tenant_id, id);

CREATE TABLE sales_commission_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  plan_id           uuid NOT NULL,
  sales_rep_id      uuid NOT NULL,
  period_month      date NOT NULL CHECK (EXTRACT(DAY FROM period_month) = 1),
  source_type       text NOT NULL CHECK (source_type IN ('INVOICE', 'COLLECTION', 'CREDIT_NOTE', 'RETURN', 'CANCELLATION', 'OVERDUE_CLAWBACK', 'MANUAL_ADJUSTMENT')),
  source_id         uuid,
  base_amount       numeric(18,2) NOT NULL,
  rate_percent      numeric(7,4),
  amount            numeric(18,2) NOT NULL,     -- negative for clawbacks
  currency          char(3) NOT NULL,
  status            text NOT NULL DEFAULT 'ESTIMATED' CHECK (status IN ('ESTIMATED', 'APPROVED', 'SENT_TO_PAYROLL', 'PAID', 'REVERSED')),
  approved_by       uuid,
  approved_at       timestamptz,
  payroll_reference text,
  journal_entry_id  uuid,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES sales_commission_plans (tenant_id, id),
  FOREIGN KEY (tenant_id, sales_rep_id) REFERENCES sales_representatives (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id)
);
CREATE INDEX sales_commission_entries_rep_idx ON sales_commission_entries (tenant_id, sales_rep_id, period_month);
-- A source document produces at most one entry of a given type per rep.
CREATE UNIQUE INDEX sales_commission_entries_source_uq
  ON sales_commission_entries (tenant_id, sales_rep_id, source_type, source_id)
  WHERE source_id IS NOT NULL AND source_type <> 'MANUAL_ADJUSTMENT';

-- ---------------------------------------------------------------------------
-- Quotations
-- ---------------------------------------------------------------------------
CREATE TABLE sales_quotations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number             text NOT NULL,
  customer_id        uuid NOT NULL,
  sales_rep_id       uuid NOT NULL,
  branch_id          uuid NOT NULL,
  warehouse_id       uuid,
  quotation_date     date NOT NULL,
  valid_until        date NOT NULL,
  status             text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CONVERTED', 'CANCELLED')),
  currency           char(3) NOT NULL,
  price_list_id      uuid,
  subtotal           numeric(18,2) NOT NULL DEFAULT 0,
  discount_total     numeric(18,2) NOT NULL DEFAULT 0,
  tax_total          numeric(18,2) NOT NULL DEFAULT 0,
  grand_total        numeric(18,2) NOT NULL DEFAULT 0,
  notes              text,
  converted_order_id uuid,                       -- FK added below
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until >= quotation_date),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, sales_rep_id) REFERENCES sales_representatives (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, price_list_id) REFERENCES price_lists (tenant_id, id)
);
CREATE TRIGGER sales_quotations_updated_at BEFORE UPDATE ON sales_quotations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sales_quotation_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  quotation_id      uuid NOT NULL,
  line_no           integer NOT NULL,
  product_id        uuid NOT NULL,
  unit_id           uuid NOT NULL,
  unit_factor       numeric(18,6) NOT NULL DEFAULT 1,
  quantity          numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit_price        numeric(18,4) NOT NULL CHECK (unit_price >= 0),
  discount_percent  numeric(7,4) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  discount_amount   numeric(18,2) NOT NULL DEFAULT 0,
  tax_code_id       uuid,
  tax_rate_percent  numeric(7,4) NOT NULL DEFAULT 0,
  tax_amount        numeric(18,2) NOT NULL DEFAULT 0,
  net_amount        numeric(18,2) NOT NULL,
  line_total        numeric(18,2) NOT NULL,
  notes             text,
  UNIQUE (quotation_id, line_no),
  FOREIGN KEY (tenant_id, quotation_id) REFERENCES sales_quotations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES units (tenant_id, id),
  FOREIGN KEY (tenant_id, tax_code_id) REFERENCES tax_codes (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Customer visits
-- ---------------------------------------------------------------------------
CREATE TABLE sales_visits (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sales_rep_id            uuid NOT NULL,
  customer_id             uuid NOT NULL,
  scheduled_start         timestamptz NOT NULL,
  scheduled_end           timestamptz,
  status                  text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'MISSED')),
  purpose                 text,
  outcome                 text CHECK (outcome IS NULL OR outcome IN ('ORDER_TAKEN', 'FOLLOW_UP_NEEDED', 'NO_INTEREST', 'COLLECTION_MADE', 'CUSTOMER_UNAVAILABLE', 'OTHER')),
  outcome_summary         text,
  checked_in_at           timestamptz,
  checked_out_at          timestamptz,
  -- Location is captured only at check-in/out, with explicit consent.
  location_consent        boolean NOT NULL DEFAULT false,
  check_in_latitude       numeric(9,6),
  check_in_longitude      numeric(9,6),
  check_in_accuracy_m     numeric(10,2),
  created_by              uuid NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (location_consent OR (check_in_latitude IS NULL AND check_in_longitude IS NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, sales_rep_id) REFERENCES sales_representatives (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);
CREATE INDEX sales_visits_rep_idx ON sales_visits (tenant_id, sales_rep_id, scheduled_start);
CREATE TRIGGER sales_visits_updated_at BEFORE UPDATE ON sales_visits FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sales_visit_notes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  visit_id         uuid NOT NULL,
  author_user_id   uuid NOT NULL,
  note_type        text NOT NULL DEFAULT 'NOTE' CHECK (note_type IN ('NOTE', 'FOLLOW_UP_TASK')),
  body             text NOT NULL,
  due_date         date,
  assigned_to_user_id uuid,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, visit_id) REFERENCES sales_visits (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, author_user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_to_user_id) REFERENCES users (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Sales orders
-- ---------------------------------------------------------------------------
CREATE TABLE sales_orders (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number                   text NOT NULL,
  customer_id              uuid NOT NULL,
  sales_rep_id             uuid NOT NULL,
  branch_id                uuid NOT NULL,
  warehouse_id             uuid NOT NULL,
  order_date               date NOT NULL,
  requested_delivery_date  date,
  status                   text NOT NULL DEFAULT 'DRAFT' CHECK (status IN
                             ('DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'STOCK_RESERVED',
                              'PICKING', 'PACKED', 'DISPATCHED', 'PARTIALLY_DELIVERED', 'DELIVERED', 'INVOICED',
                              'CLOSED', 'CANCELLED')),
  currency                 char(3) NOT NULL,
  price_list_id            uuid,
  delivery_address_id      uuid,
  delivery_address         jsonb,      -- snapshot at submission
  payment_terms_days       integer NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0),
  notes                    text,
  subtotal                 numeric(18,2) NOT NULL DEFAULT 0,
  discount_total           numeric(18,2) NOT NULL DEFAULT 0,
  tax_total                numeric(18,2) NOT NULL DEFAULT 0,
  grand_total              numeric(18,2) NOT NULL DEFAULT 0,
  max_discount_percent     numeric(7,4) NOT NULL DEFAULT 0,
  approval_requirements    jsonb NOT NULL DEFAULT '[]'::jsonb,
  has_backorder            boolean NOT NULL DEFAULT false,
  source                   text NOT NULL DEFAULT 'WEB' CHECK (source IN ('WEB', 'MOBILE', 'OFFLINE_SYNC', 'QUOTATION', 'VISIT')),
  -- Provisional = created offline, not yet revalidated by the server.
  is_provisional           boolean NOT NULL DEFAULT false,
  quotation_id             uuid,
  visit_id                 uuid,
  -- Client-generated key: retries of the same create return the same order.
  client_reference         text,
  version                  integer NOT NULL DEFAULT 1,
  submitted_at             timestamptz,
  approved_at              timestamptz,
  cancelled_at             timestamptz,
  cancel_reason            text,
  created_by               uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_reference),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, sales_rep_id) REFERENCES sales_representatives (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, price_list_id) REFERENCES price_lists (tenant_id, id),
  FOREIGN KEY (tenant_id, delivery_address_id) REFERENCES customer_addresses (tenant_id, id),
  FOREIGN KEY (tenant_id, quotation_id) REFERENCES sales_quotations (tenant_id, id),
  FOREIGN KEY (tenant_id, visit_id) REFERENCES sales_visits (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX sales_orders_rep_idx ON sales_orders (tenant_id, sales_rep_id, order_date DESC);
CREATE INDEX sales_orders_customer_idx ON sales_orders (tenant_id, customer_id, order_date DESC);
CREATE INDEX sales_orders_status_idx ON sales_orders (tenant_id, status);
CREATE TRIGGER sales_orders_updated_at BEFORE UPDATE ON sales_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE sales_quotations
  ADD FOREIGN KEY (tenant_id, converted_order_id) REFERENCES sales_orders (tenant_id, id);
ALTER TABLE invoices
  ADD FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sales_orders (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, sales_rep_id) REFERENCES sales_representatives (tenant_id, id);

CREATE TABLE sales_order_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  order_id          uuid NOT NULL,
  line_no           integer NOT NULL,
  product_id        uuid NOT NULL,
  unit_id           uuid NOT NULL,
  unit_factor       numeric(18,6) NOT NULL DEFAULT 1 CHECK (unit_factor > 0),
  quantity          numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit_price        numeric(18,4) NOT NULL CHECK (unit_price >= 0),
  price_source      text NOT NULL CHECK (price_source IN ('PRICE_LIST', 'PROMOTION', 'LIST_PRICE', 'OVERRIDE')),
  promotion_id      uuid,
  discount_percent  numeric(7,4) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  discount_amount   numeric(18,2) NOT NULL DEFAULT 0,
  tax_code_id       uuid,
  tax_rate_percent  numeric(7,4) NOT NULL DEFAULT 0,
  tax_amount        numeric(18,2) NOT NULL DEFAULT 0,
  net_amount        numeric(18,2) NOT NULL,
  line_total        numeric(18,2) NOT NULL,
  -- Fulfilment progress, all in the line's unit.
  qty_reserved      numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_reserved >= 0),
  qty_backordered   numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_backordered >= 0),
  qty_delivered     numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_delivered >= 0),
  qty_invoiced      numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_invoiced >= 0),
  qty_returned      numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_returned >= 0),
  notes             text,
  CHECK (qty_delivered <= quantity AND qty_invoiced <= quantity AND qty_returned <= qty_delivered),
  UNIQUE (order_id, line_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES units (tenant_id, id),
  FOREIGN KEY (tenant_id, tax_code_id) REFERENCES tax_codes (tenant_id, id),
  FOREIGN KEY (tenant_id, promotion_id) REFERENCES promotions (tenant_id, id)
);

CREATE TABLE sales_order_approvals (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL,
  order_id                   uuid NOT NULL,
  reason                     text NOT NULL CHECK (reason IN ('DISCOUNT', 'ORDER_AMOUNT', 'CREDIT_LIMIT', 'OFFLINE_PRICE_CHANGE')),
  required_level             smallint CHECK (required_level BETWEEN 1 AND 3),
  requires_credit_authority  boolean NOT NULL DEFAULT false,
  detail                     text NOT NULL,
  status                     text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED')),
  decided_by                 uuid,
  decided_at                 timestamptz,
  comment                    text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (required_level IS NOT NULL OR requires_credit_authority),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, decided_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX sales_order_approvals_pending_idx ON sales_order_approvals (tenant_id, status) WHERE status = 'PENDING';

CREATE TABLE sales_order_status_history (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  order_id      uuid NOT NULL,
  from_status   text,
  to_status     text NOT NULL,
  action        text NOT NULL,
  actor_user_id uuid,
  comment       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX sales_order_status_history_order_idx ON sales_order_status_history (order_id, id);

CREATE TABLE sales_order_reservations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  order_id       uuid NOT NULL,
  order_line_id  uuid NOT NULL,
  warehouse_id   uuid NOT NULL,
  product_id     uuid NOT NULL,
  quantity_base  numeric(18,4) NOT NULL CHECK (quantity_base > 0),
  status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RELEASED', 'CONSUMED')),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz,
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES sales_order_lines (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);
CREATE INDEX sales_order_reservations_active_idx ON sales_order_reservations (tenant_id, order_id) WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- Payment collections (pending until accounting verifies them)
-- ---------------------------------------------------------------------------
CREATE TABLE sales_collection_submissions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number              text NOT NULL,
  customer_id         uuid NOT NULL,
  sales_rep_id        uuid NOT NULL,
  invoice_id          uuid,
  amount              numeric(18,2) NOT NULL CHECK (amount > 0),
  currency            char(3) NOT NULL,
  payment_method      text NOT NULL CHECK (payment_method IN ('CASH', 'BANK_TRANSFER', 'KHQR', 'MOBILE_WALLET', 'CHEQUE', 'CARD', 'OTHER')),
  payment_reference   text,
  collected_on        date NOT NULL,
  receipt_file_key    text,
  notes               text,
  status              text NOT NULL DEFAULT 'PENDING_VERIFICATION' CHECK (status IN ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED')),
  verified_by         uuid,
  verified_at         timestamptz,
  rejection_reason    text,
  customer_receipt_id uuid,
  client_reference    text,
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Verified collections must be linked to a posted accounting receipt.
  CHECK (status <> 'VERIFIED' OR (customer_receipt_id IS NOT NULL AND verified_by IS NOT NULL)),
  CHECK (status <> 'REJECTED' OR rejection_reason IS NOT NULL),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, client_reference),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, sales_rep_id) REFERENCES sales_representatives (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, verified_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_receipt_id) REFERENCES customer_receipts (tenant_id, id)
);
CREATE INDEX sales_collection_submissions_status_idx ON sales_collection_submissions (tenant_id, status);

-- ---------------------------------------------------------------------------
-- Offline sync log (idempotent replay of queued mobile submissions)
-- ---------------------------------------------------------------------------
CREATE TABLE sales_offline_sync_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL,
  device_id            text NOT NULL,
  idempotency_key      text NOT NULL,
  entity_type          text NOT NULL CHECK (entity_type IN ('SALES_ORDER', 'COLLECTION', 'VISIT', 'VISIT_NOTE')),
  payload              jsonb NOT NULL,
  payload_hash         text NOT NULL,
  client_created_at    timestamptz,
  catalog_snapshot_at  timestamptz,
  status               text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'ACCEPTED', 'ACCEPTED_WITH_CHANGES', 'REJECTED', 'CONFLICT')),
  result               jsonb,
  resulting_entity_id  uuid,
  received_at          timestamptz NOT NULL DEFAULT now(),
  processed_at         timestamptz,
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX sales_offline_sync_events_user_idx ON sales_offline_sync_events (tenant_id, user_id, received_at DESC);
