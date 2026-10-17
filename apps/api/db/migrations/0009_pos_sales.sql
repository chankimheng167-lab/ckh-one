-- CKH ONE — POS Sales & Cashier Management.
--
-- Reuses the shared masters: products (variants are products with a parent),
-- customers, branches, warehouses, stock_levels / stock_movements, tax codes,
-- price lists, chart of accounts and journal_entries. POS adds only what a
-- till needs: registers, devices, cashier shifts and cash movements, POS
-- sales with their lines and payments, held carts, returns, receipt prints
-- and the device sync log. No second product, customer or stock table.

-- ---------------------------------------------------------------------------
-- Licensing (Super Admin owned; tenants may read their own row)
-- ---------------------------------------------------------------------------
CREATE TABLE pos_licenses (
  tenant_id               uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  max_branches            integer CHECK (max_branches IS NULL OR max_branches >= 0),
  max_registers           integer CHECK (max_registers IS NULL OR max_registers >= 0),
  max_devices             integer CHECK (max_devices IS NULL OR max_devices >= 0),
  -- How long a Windows POS may keep selling without reaching the server.
  offline_validity_hours  integer NOT NULL DEFAULT 72 CHECK (offline_validity_hours BETWEEN 1 AND 720),
  notes                   text,
  updated_by              uuid,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Tenant POS settings
-- ---------------------------------------------------------------------------
CREATE TABLE pos_settings (
  tenant_id                    uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  prices_include_tax           boolean NOT NULL DEFAULT false,
  -- Cashier (pos.discount.apply) limit; above it pos.discount.override is needed.
  cashier_max_discount_percent numeric(7,4) NOT NULL DEFAULT 5 CHECK (cashier_max_discount_percent BETWEEN 0 AND 100),
  -- Supervisors (pos.discount.override) may approve up to this.
  override_max_discount_percent numeric(7,4) NOT NULL DEFAULT 50 CHECK (override_max_discount_percent BETWEEN 0 AND 100),
  allow_negative_stock         boolean NOT NULL DEFAULT false,
  require_open_shift           boolean NOT NULL DEFAULT true,
  -- Shift differences above this need a supervisor's approval note.
  cash_difference_tolerance    numeric(18,2) NOT NULL DEFAULT 0 CHECK (cash_difference_tolerance >= 0),
  walk_in_customer_id          uuid,
  -- Receipt layout: header/footer lines per language, logo, tax id, paper.
  receipt                      jsonb NOT NULL DEFAULT '{"paper":"80","languages":["en"],"showLogo":true,"showTaxId":true,"header":{},"footer":{"en":"Thank you!"}}'::jsonb
                               CHECK (jsonb_typeof(receipt) = 'object'),
  -- Ledger mappings for POS (NULL = use accounting_settings).
  cash_account_id              uuid,
  pending_payment_account_id   uuid,
  cash_over_short_account_id   uuid,
  inventory_adjustment_account_id uuid,
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, walk_in_customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, cash_account_id) REFERENCES chart_of_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, pending_payment_account_id) REFERENCES chart_of_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, cash_over_short_account_id) REFERENCES chart_of_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, inventory_adjustment_account_id) REFERENCES chart_of_accounts (tenant_id, id),
  CHECK (override_max_discount_percent >= cashier_max_discount_percent)
);

CREATE TABLE pos_payment_methods (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code                   text NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,30}$'),
  name                   text NOT NULL,
  kind                   text NOT NULL CHECK (kind IN ('CASH', 'BANK_TRANSFER', 'QR', 'CARD', 'OTHER')),
  -- A reference (transfer id, QR transaction, card approval code) must be entered.
  requires_reference     boolean NOT NULL DEFAULT false,
  -- Payment stays PENDING_VERIFICATION until someone (or a verified provider callback) confirms it.
  requires_verification  boolean NOT NULL DEFAULT false,
  -- Integration that can confirm payments (e.g. a bank QR provider); NULL = manual.
  provider               text,
  -- Ledger account the money lands in (cash drawer, bank, card clearing).
  account_id             uuid,
  allow_offline          boolean NOT NULL DEFAULT false,
  sort_order             integer NOT NULL DEFAULT 0,
  is_active              boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES chart_of_accounts (tenant_id, id),
  -- Only cash can be taken offline: nothing else can be confirmed without the server.
  CHECK (NOT allow_offline OR kind = 'CASH')
);

-- ---------------------------------------------------------------------------
-- Registers, devices, staff branch access
-- ---------------------------------------------------------------------------
CREATE TABLE pos_registers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id     uuid NOT NULL,
  warehouse_id  uuid NOT NULL,
  code          text NOT NULL CHECK (code ~ '^[A-Za-z0-9_-]{1,30}$'),
  name          text NOT NULL,
  -- Printer, drawer and scanner settings (see PosHardwareSettings in the API).
  hardware      jsonb NOT NULL DEFAULT '{"receiptPaper":"80","autoPrint":true,"openDrawerOnCash":true,"copies":1}'::jsonb
                CHECK (jsonb_typeof(hardware) = 'object'),
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id)
);

-- Branches a POS user works in. Users with pos.branches.all may use every branch.
CREATE TABLE pos_staff_branches (
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  branch_id  uuid NOT NULL,
  PRIMARY KEY (user_id, branch_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id) ON DELETE CASCADE
);

-- Supervisor PIN for approving discounts, price overrides and refunds at the till.
ALTER TABLE users
  ADD COLUMN pos_pin_hash text,
  ADD COLUMN pos_pin_failed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN pos_pin_locked_until timestamptz;

-- A licensed Windows POS installation, bound to one register.
CREATE TABLE pos_devices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  register_id         uuid NOT NULL,
  -- Installation id generated on the device.
  device_key          text NOT NULL CHECK (length(device_key) BETWEEN 8 AND 200),
  name                text NOT NULL,
  platform            text,
  app_version         text,
  -- SHA-256 of the device secret; the secret itself is only on the device (OS credential store).
  secret_hash         text NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  license_issued_at   timestamptz,
  license_expires_at  timestamptz,
  last_seen_at        timestamptz,
  last_sync_at        timestamptz,
  activated_by        uuid,
  revoked_by          uuid,
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, register_id) REFERENCES pos_registers (tenant_id, id)
);
CREATE UNIQUE INDEX pos_devices_key_uq ON pos_devices (tenant_id, device_key) WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- Cashier shifts and the cash drawer
-- ---------------------------------------------------------------------------
CREATE TABLE pos_shifts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number            text NOT NULL,
  register_id       uuid NOT NULL,
  branch_id         uuid NOT NULL,
  cashier_id        uuid NOT NULL,
  business_date     date NOT NULL,
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'APPROVED')),
  currency          char(3) NOT NULL,
  opening_float     numeric(18,2) NOT NULL CHECK (opening_float >= 0),
  expected_cash     numeric(18,2),
  counted_cash      numeric(18,2) CHECK (counted_cash IS NULL OR counted_cash >= 0),
  cash_difference   numeric(18,2),
  count_details     jsonb,
  closing_notes     text,
  opened_at         timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz,
  closed_by         uuid,
  approved_at       timestamptz,
  approved_by       uuid,
  approval_notes    text,
  journal_entry_id  uuid,
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, register_id) REFERENCES pos_registers (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, cashier_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id),
  CHECK (status = 'OPEN' OR (closed_at IS NOT NULL AND counted_cash IS NOT NULL AND expected_cash IS NOT NULL)),
  CHECK (status <> 'APPROVED' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
-- One open shift per register.
CREATE UNIQUE INDEX pos_shifts_one_open ON pos_shifts (tenant_id, register_id) WHERE status = 'OPEN';
CREATE INDEX pos_shifts_date_idx ON pos_shifts (tenant_id, business_date);

-- Closed shifts are frozen: only the supervisor approval may be added, once.
CREATE OR REPLACE FUNCTION pos_shift_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'APPROVED' THEN
    RAISE EXCEPTION 'Shift % is approved and cannot be changed', OLD.number USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_shift_closed';
  END IF;
  IF OLD.status = 'CLOSED' THEN
    IF NEW.status <> 'APPROVED'
       OR NEW.expected_cash IS DISTINCT FROM OLD.expected_cash
       OR NEW.counted_cash IS DISTINCT FROM OLD.counted_cash
       OR NEW.cash_difference IS DISTINCT FROM OLD.cash_difference
       OR NEW.opening_float IS DISTINCT FROM OLD.opening_float
       OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
       OR NEW.cashier_id IS DISTINCT FROM OLD.cashier_id THEN
      RAISE EXCEPTION 'Shift % is closed and cannot be changed', OLD.number USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_shift_closed';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pos_shifts_guard BEFORE UPDATE ON pos_shifts FOR EACH ROW EXECUTE FUNCTION pos_shift_guard();
CREATE OR REPLACE FUNCTION pos_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_no_delete';
END $$;
CREATE TRIGGER pos_shifts_no_delete BEFORE DELETE ON pos_shifts FOR EACH ROW EXECUTE FUNCTION pos_no_delete();

-- Every movement of cash in or out of the drawer (signed: + in, − out).
CREATE TABLE pos_cash_movements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shift_id        uuid NOT NULL,
  movement_type   text NOT NULL CHECK (movement_type IN ('OPENING_FLOAT', 'SALE', 'REFUND', 'CASH_IN', 'CASH_OUT')),
  amount          numeric(18,2) NOT NULL CHECK (amount <> 0),
  reason          text,
  reference_type  text,
  reference_id    uuid,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES pos_shifts (tenant_id, id),
  CHECK ((movement_type IN ('OPENING_FLOAT', 'SALE', 'CASH_IN') AND amount > 0) OR (movement_type IN ('REFUND', 'CASH_OUT') AND amount < 0)),
  CHECK (movement_type NOT IN ('CASH_IN', 'CASH_OUT') OR length(coalesce(reason, '')) > 0)
);
CREATE INDEX pos_cash_movements_shift_idx ON pos_cash_movements (tenant_id, shift_id);

-- Cash movements are append-only and only allowed while the shift is open.
CREATE OR REPLACE FUNCTION pos_cash_movement_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Cash movements cannot be changed or deleted' USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_cash_movement_immutable';
  END IF;
  SELECT status INTO st FROM pos_shifts WHERE id = NEW.shift_id;
  IF st IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION 'The shift is closed' USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_shift_closed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pos_cash_movements_guard BEFORE INSERT OR UPDATE OR DELETE ON pos_cash_movements
  FOR EACH ROW EXECUTE FUNCTION pos_cash_movement_guard();

-- ---------------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------------
CREATE TABLE pos_sales (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number                text NOT NULL,
  -- Idempotency key from the till (one per checkout attempt; a retry reuses it).
  client_sale_id        text NOT NULL CHECK (length(client_sale_id) BETWEEN 8 AND 100),
  payload_hash          text NOT NULL,
  register_id           uuid NOT NULL,
  shift_id              uuid,
  branch_id             uuid NOT NULL,
  warehouse_id          uuid NOT NULL,
  cashier_id            uuid NOT NULL,
  customer_id           uuid,
  device_id             uuid,
  business_date         date NOT NULL,
  sold_at               timestamptz NOT NULL DEFAULT now(),
  status                text NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')),
  -- Payment state: PENDING while a transfer/QR waits for verification; BALANCE_DUE if one was rejected.
  payment_status        text NOT NULL DEFAULT 'PAID' CHECK (payment_status IN ('PAID', 'PENDING_VERIFICATION', 'BALANCE_DUE')),
  currency              char(3) NOT NULL,
  prices_include_tax    boolean NOT NULL,
  subtotal              numeric(18,2) NOT NULL,
  line_discount_total   numeric(18,2) NOT NULL DEFAULT 0,
  order_discount_total  numeric(18,2) NOT NULL DEFAULT 0,
  discount_total        numeric(18,2) NOT NULL DEFAULT 0,
  net_total             numeric(18,2) NOT NULL,
  tax_total             numeric(18,2) NOT NULL DEFAULT 0,
  grand_total           numeric(18,2) NOT NULL CHECK (grand_total >= 0),
  amount_tendered       numeric(18,2) NOT NULL DEFAULT 0,
  change_due            numeric(18,2) NOT NULL DEFAULT 0 CHECK (change_due >= 0),
  refunded_total        numeric(18,2) NOT NULL DEFAULT 0 CHECK (refunded_total >= 0),
  cost_total            numeric(18,2) NOT NULL DEFAULT 0,
  discount_approved_by  uuid,
  notes                 text,
  -- Offline sales: recorded when the device reconnects.
  is_offline            boolean NOT NULL DEFAULT false,
  client_created_at     timestamptz,
  review_status         text NOT NULL DEFAULT 'NONE' CHECK (review_status IN ('NONE', 'NEEDS_REVIEW', 'REVIEWED')),
  review_reasons        jsonb,
  journal_entry_id      uuid,
  cogs_journal_entry_id uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_sale_id),
  CHECK (refunded_total <= grand_total),
  CHECK (amount_tendered - change_due >= 0),
  FOREIGN KEY (tenant_id, register_id) REFERENCES pos_registers (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES pos_shifts (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, cashier_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES pos_devices (tenant_id, id),
  FOREIGN KEY (tenant_id, discount_approved_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, cogs_journal_entry_id) REFERENCES journal_entries (tenant_id, id)
);
CREATE INDEX pos_sales_date_idx ON pos_sales (tenant_id, business_date, branch_id);
CREATE INDEX pos_sales_shift_idx ON pos_sales (tenant_id, shift_id);
CREATE INDEX pos_sales_cashier_idx ON pos_sales (tenant_id, cashier_id, sold_at DESC);
CREATE INDEX pos_sales_customer_idx ON pos_sales (tenant_id, customer_id) WHERE customer_id IS NOT NULL;

CREATE TABLE pos_sale_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  sale_id               uuid NOT NULL,
  line_no               integer NOT NULL CHECK (line_no > 0),
  product_id            uuid NOT NULL,
  sku                   text NOT NULL,
  description           text NOT NULL,
  variant_attributes    jsonb,
  quantity              numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit_price            numeric(18,4) NOT NULL CHECK (unit_price >= 0),
  list_unit_price       numeric(18,4) NOT NULL,
  price_source          text NOT NULL CHECK (price_source IN ('PRICE_LIST', 'PROMOTION', 'LIST_PRICE', 'OVERRIDE', 'OFFLINE')),
  gross_amount          numeric(18,2) NOT NULL,
  line_discount         numeric(18,2) NOT NULL DEFAULT 0,
  order_discount_share  numeric(18,2) NOT NULL DEFAULT 0,
  discount_total        numeric(18,2) NOT NULL DEFAULT 0,
  gross_ex_tax          numeric(18,2) NOT NULL,
  discount_ex_tax       numeric(18,2) NOT NULL DEFAULT 0,
  net_amount            numeric(18,2) NOT NULL,
  tax_code_id           uuid,
  tax_rate_percent      numeric(7,4) NOT NULL DEFAULT 0,
  tax_amount            numeric(18,2) NOT NULL DEFAULT 0,
  line_total            numeric(18,2) NOT NULL,
  unit_cost             numeric(18,6) NOT NULL DEFAULT 0,
  track_inventory       boolean NOT NULL,
  quantity_returned     numeric(18,4) NOT NULL DEFAULT 0 CHECK (quantity_returned >= 0),
  serial_numbers        text[] NOT NULL DEFAULT '{}',
  UNIQUE (sale_id, line_no),
  UNIQUE (tenant_id, id),
  CHECK (quantity_returned <= quantity),
  CHECK (net_amount + tax_amount = line_total),
  FOREIGN KEY (tenant_id, sale_id) REFERENCES pos_sales (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, tax_code_id) REFERENCES tax_codes (tenant_id, id)
);
CREATE INDEX pos_sale_lines_product_idx ON pos_sale_lines (tenant_id, product_id);

-- Serial numbers sold: a serial can be out of the shop only once at a time.
CREATE TABLE pos_sold_serials (
  tenant_id     uuid NOT NULL,
  product_id    uuid NOT NULL,
  serial_no     text NOT NULL CHECK (length(serial_no) BETWEEN 1 AND 100),
  sale_line_id  uuid NOT NULL,
  returned      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, sale_line_id) REFERENCES pos_sale_lines (tenant_id, id)
);
CREATE UNIQUE INDEX pos_sold_serials_out_uq ON pos_sold_serials (tenant_id, product_id, serial_no) WHERE NOT returned;

ALTER TABLE products
  ADD COLUMN serial_tracked boolean NOT NULL DEFAULT false,
  ADD COLUMN reorder_point numeric(18,4) CHECK (reorder_point IS NULL OR reorder_point >= 0);
CREATE INDEX products_parent_idx ON products (tenant_id, parent_product_id) WHERE parent_product_id IS NOT NULL;

CREATE TABLE pos_sale_payments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  sale_id                uuid NOT NULL,
  method_id              uuid NOT NULL,
  kind                   text NOT NULL CHECK (kind IN ('CASH', 'BANK_TRANSFER', 'QR', 'CARD', 'OTHER')),
  amount_tendered        numeric(18,2) NOT NULL CHECK (amount_tendered > 0),
  -- The part of the sale this payment settles (cash tendered minus change).
  amount                 numeric(18,2) NOT NULL CHECK (amount >= 0),
  -- Transfer id, QR transaction id or card approval code. Never a card number.
  reference              text CHECK (reference IS NULL OR length(reference) <= 120),
  provider_transaction_id text,
  status                 text NOT NULL CHECK (status IN ('CONFIRMED', 'PENDING_VERIFICATION', 'REJECTED')),
  account_id             uuid NOT NULL,
  verified_by            uuid,
  verified_at            timestamptz,
  verification_notes     text,
  journal_entry_id       uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (amount <= amount_tendered),
  CHECK (kind = 'CASH' OR amount = amount_tendered),
  FOREIGN KEY (tenant_id, sale_id) REFERENCES pos_sales (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, method_id) REFERENCES pos_payment_methods (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES chart_of_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id)
);
CREATE INDEX pos_sale_payments_sale_idx ON pos_sale_payments (tenant_id, sale_id);
CREATE INDEX pos_sale_payments_pending_idx ON pos_sale_payments (tenant_id, status) WHERE status = 'PENDING_VERIFICATION';
-- The same provider transaction or transfer reference can never pay two sales.
CREATE UNIQUE INDEX pos_sale_payments_provider_uq ON pos_sale_payments (tenant_id, method_id, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL AND status <> 'REJECTED';
CREATE UNIQUE INDEX pos_sale_payments_reference_uq ON pos_sale_payments (tenant_id, method_id, lower(reference))
  WHERE reference IS NOT NULL AND kind IN ('BANK_TRANSFER', 'QR') AND status <> 'REJECTED';

-- ---------------------------------------------------------------------------
-- Held (parked) carts
-- ---------------------------------------------------------------------------
CREATE TABLE pos_held_sales (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  register_id   uuid NOT NULL,
  shift_id      uuid,
  held_by       uuid NOT NULL,
  label         text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  customer_id   uuid,
  cart          jsonb NOT NULL CHECK (jsonb_typeof(cart) = 'object'),
  item_count    integer NOT NULL DEFAULT 0,
  estimated_total numeric(18,2),
  status        text NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD', 'RESUMED', 'CANCELLED')),
  resumed_by    uuid,
  cancelled_by  uuid,
  cancel_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, register_id) REFERENCES pos_registers (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES pos_shifts (tenant_id, id),
  FOREIGN KEY (tenant_id, held_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);
CREATE INDEX pos_held_sales_open_idx ON pos_held_sales (tenant_id, register_id) WHERE status = 'HELD';

-- ---------------------------------------------------------------------------
-- Returns and refunds
-- ---------------------------------------------------------------------------
CREATE TABLE pos_returns (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number             text NOT NULL,
  client_return_id   text NOT NULL CHECK (length(client_return_id) BETWEEN 8 AND 100),
  sale_id            uuid NOT NULL,
  register_id        uuid NOT NULL,
  shift_id           uuid,
  branch_id          uuid NOT NULL,
  processed_by       uuid NOT NULL,
  approved_by        uuid,
  business_date      date NOT NULL,
  reason             text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  currency           char(3) NOT NULL,
  gross_ex_tax       numeric(18,2) NOT NULL,
  discount_ex_tax    numeric(18,2) NOT NULL DEFAULT 0,
  net_total          numeric(18,2) NOT NULL,
  tax_total          numeric(18,2) NOT NULL DEFAULT 0,
  refund_total       numeric(18,2) NOT NULL CHECK (refund_total > 0),
  cost_total         numeric(18,2) NOT NULL DEFAULT 0,
  journal_entry_id   uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_return_id),
  FOREIGN KEY (tenant_id, sale_id) REFERENCES pos_sales (tenant_id, id),
  FOREIGN KEY (tenant_id, register_id) REFERENCES pos_registers (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES pos_shifts (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, processed_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id)
);
CREATE INDEX pos_returns_sale_idx ON pos_returns (tenant_id, sale_id);
CREATE INDEX pos_returns_date_idx ON pos_returns (tenant_id, business_date);

CREATE TABLE pos_return_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  return_id        uuid NOT NULL,
  sale_line_id     uuid NOT NULL,
  product_id       uuid NOT NULL,
  quantity         numeric(18,4) NOT NULL CHECK (quantity > 0),
  restock          boolean NOT NULL,
  gross_ex_tax     numeric(18,2) NOT NULL,
  discount_ex_tax  numeric(18,2) NOT NULL DEFAULT 0,
  net_amount       numeric(18,2) NOT NULL,
  tax_amount       numeric(18,2) NOT NULL DEFAULT 0,
  refund_amount    numeric(18,2) NOT NULL,
  unit_cost        numeric(18,6) NOT NULL DEFAULT 0,
  serial_numbers   text[] NOT NULL DEFAULT '{}',
  FOREIGN KEY (tenant_id, return_id) REFERENCES pos_returns (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, sale_line_id) REFERENCES pos_sale_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  CHECK (net_amount + tax_amount = refund_amount)
);

CREATE TABLE pos_return_refunds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  return_id    uuid NOT NULL,
  method_id    uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('CASH', 'BANK_TRANSFER', 'QR', 'CARD', 'OTHER')),
  amount       numeric(18,2) NOT NULL CHECK (amount > 0),
  reference    text CHECK (reference IS NULL OR length(reference) <= 120),
  account_id   uuid NOT NULL,
  FOREIGN KEY (tenant_id, return_id) REFERENCES pos_returns (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, method_id) REFERENCES pos_payment_methods (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES chart_of_accounts (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Receipts printed (originals, reprints, refund slips)
-- ---------------------------------------------------------------------------
CREATE TABLE pos_receipts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sale_id      uuid,
  return_id    uuid,
  kind         text NOT NULL CHECK (kind IN ('ORIGINAL', 'REPRINT', 'REFUND')),
  copy_no      integer NOT NULL DEFAULT 1,
  paper        text NOT NULL CHECK (paper IN ('58', '80', 'A4')),
  language     text NOT NULL CHECK (language IN ('en', 'km', 'zh')),
  format       text NOT NULL CHECK (format IN ('json', 'html', 'pdf', 'text')),
  printed_by   uuid NOT NULL,
  printed_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (sale_id IS NOT NULL OR return_id IS NOT NULL),
  FOREIGN KEY (tenant_id, sale_id) REFERENCES pos_sales (tenant_id, id),
  FOREIGN KEY (tenant_id, return_id) REFERENCES pos_returns (tenant_id, id),
  FOREIGN KEY (tenant_id, printed_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX pos_receipts_sale_idx ON pos_receipts (tenant_id, sale_id);

-- ---------------------------------------------------------------------------
-- Device sync log (idempotent replay of offline transactions)
-- ---------------------------------------------------------------------------
CREATE TABLE pos_sync_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id            uuid NOT NULL,
  user_id              uuid NOT NULL,
  idempotency_key      text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  event_type           text NOT NULL CHECK (event_type IN ('SALE')),
  payload              jsonb NOT NULL,
  payload_hash         text NOT NULL,
  client_created_at    timestamptz NOT NULL,
  catalog_snapshot_at  timestamptz,
  status               text NOT NULL CHECK (status IN ('ACCEPTED', 'ACCEPTED_WITH_CHANGES', 'REJECTED', 'CONFLICT')),
  result               jsonb,
  resulting_sale_id    uuid,
  received_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, device_id) REFERENCES pos_devices (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, resulting_sale_id) REFERENCES pos_sales (tenant_id, id)
);
CREATE INDEX pos_sync_events_device_idx ON pos_sync_events (tenant_id, device_id, received_at DESC);

-- ---------------------------------------------------------------------------
-- Inventory: POS returns and counted adjustments
-- ---------------------------------------------------------------------------
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check CHECK (movement_type IN
  ('RECEIPT', 'ISSUE', 'ADJUSTMENT', 'TRANSFER_IN', 'TRANSFER_OUT', 'SALE_DELIVERY', 'SALE_RETURN', 'POS_SALE', 'POS_RETURN'));

-- Negative on-hand stock is only possible when the company allows it (or for
-- offline sales already handed over); reserved stock still can never exceed
-- what is on hand.
CREATE OR REPLACE FUNCTION stock_levels_no_oversell() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  controlled boolean;
BEGIN
  SELECT centrally_controlled INTO controlled FROM warehouses WHERE id = NEW.warehouse_id;
  IF controlled AND NEW.qty_reserved > 0 AND NEW.qty_reserved > NEW.qty_on_hand THEN
    RAISE EXCEPTION 'Reserved quantity (%) would exceed stock on hand (%) for product % in warehouse %',
      NEW.qty_reserved, NEW.qty_on_hand, NEW.product_id, NEW.warehouse_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_levels_no_oversell';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Existing companies: POS ledger accounts, settings, default payment methods,
-- the new POS roles, and the POS module wherever the old POS switch was on.
-- ---------------------------------------------------------------------------
-- Per-company POS defaults: ledger accounts, settings, payment methods,
-- licence row and document numbering. Idempotent; called for every existing
-- company here and for each new company by TenantProvisioningService.
CREATE OR REPLACE FUNCTION pos_provision_tenant(t uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO chart_of_accounts (tenant_id, code, name, account_type)
  VALUES (t, '1020', 'Card clearing', 'ASSET'),
         (t, '1030', 'Payments pending verification', 'ASSET'),
         (t, '5100', 'Inventory adjustments', 'EXPENSE'),
         (t, '6900', 'Cash over and short', 'EXPENSE')
  ON CONFLICT (tenant_id, code) DO NOTHING;

  INSERT INTO pos_settings (tenant_id, pending_payment_account_id, cash_over_short_account_id, inventory_adjustment_account_id)
  VALUES (t,
          (SELECT id FROM chart_of_accounts WHERE tenant_id = t AND code = '1030'),
          (SELECT id FROM chart_of_accounts WHERE tenant_id = t AND code = '6900'),
          (SELECT id FROM chart_of_accounts WHERE tenant_id = t AND code = '5100'))
  ON CONFLICT (tenant_id) DO NOTHING;

  INSERT INTO pos_payment_methods (tenant_id, code, name, kind, requires_reference, requires_verification, account_id, allow_offline, sort_order)
  SELECT t, m.code, m.name, m.kind, m.ref, m.verify,
         (SELECT id FROM chart_of_accounts c WHERE c.tenant_id = t AND c.code = m.account), m.offline, m.sort
    FROM (VALUES ('CASH', 'Cash', 'CASH', false, false, '1000', true, 1),
                 ('CARD', 'Card (terminal)', 'CARD', true, false, '1020', false, 2),
                 ('KHQR', 'KHQR', 'QR', true, true, '1010', false, 3),
                 ('BANK', 'Bank transfer', 'BANK_TRANSFER', true, true, '1010', false, 4)) AS m(code, name, kind, ref, verify, account, offline, sort)
  ON CONFLICT (tenant_id, code) DO NOTHING;

  INSERT INTO pos_licenses (tenant_id) VALUES (t) ON CONFLICT DO NOTHING;

  INSERT INTO document_sequences (tenant_id, doc_type, prefix, padding)
  VALUES (t, 'POS_SALE', 'POS-{YYYY}-', 6), (t, 'POS_RETURN', 'PRT-{YYYY}-', 6), (t, 'POS_SHIFT', 'SHF-{YYYY}-', 6)
  ON CONFLICT DO NOTHING;
END $$;

SELECT set_config('app.platform_admin', 'on', true);
SELECT pos_provision_tenant(id) FROM tenants;

INSERT INTO platform_modules (code, name, requires, is_core)
VALUES ('POS_SALES', 'POS Sales & Cashier', '{CORE,INVENTORY}', false)
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, requires = EXCLUDED.requires;

-- Companies that already had the POS switch on get POS Sales.
INSERT INTO tenant_modules (tenant_id, module_code, enabled, starts_at, ends_at)
SELECT m.tenant_id, 'POS_SALES', m.enabled, m.starts_at, m.ends_at FROM tenant_modules m
 WHERE m.module_code = 'POS'
   AND EXISTS (SELECT 1 FROM tenant_modules i WHERE i.tenant_id = m.tenant_id AND i.module_code = 'INVENTORY' AND i.enabled)
ON CONFLICT (tenant_id, module_code) DO NOTHING;

UPDATE subscription_plans SET modules = array_append(modules, 'POS_SALES')
 WHERE 'POS' = ANY(modules) AND NOT 'POS_SALES' = ANY(modules);

-- POS roles for existing companies (new companies get them from DEFAULT_ROLES).
WITH defs(code, name, level, perms) AS (VALUES
  ('POS_CASHIER', 'POS Cashier', 0, ARRAY['pos.access','pos.sales.create','pos.discount.apply','pos.cash.drawer','pos.shift.close','products.view']),
  ('POS_SUPERVISOR', 'POS Supervisor', 1, ARRAY['pos.access','pos.sales.create','pos.sales.view_all','pos.discount.apply','pos.discount.override','pos.price.override',
     'pos.refunds.create','pos.receipts.reprint','pos.cash.drawer','pos.shift.close','pos.shift.approve','pos.payments.verify','pos.reports.view','products.view','inventory.view']),
  ('POS_MANAGER', 'POS Manager', 2, ARRAY['pos.access','pos.sales.create','pos.sales.view_all','pos.discount.apply','pos.discount.override','pos.price.override',
     'pos.refunds.create','pos.receipts.reprint','pos.cash.drawer','pos.shift.close','pos.shift.approve','pos.payments.verify','pos.reports.view','pos.branches.all',
     'pos.registers.manage','pos.devices.manage','pos.settings.manage','products.view','products.manage','inventory.view','inventory.adjust','customers.manage']),
  ('BRANCH_ADMIN', 'Branch Administrator', 2, ARRAY['pos.access','pos.sales.create','pos.sales.view_all','pos.discount.apply','pos.discount.override','pos.price.override',
     'pos.refunds.create','pos.receipts.reprint','pos.cash.drawer','pos.shift.close','pos.shift.approve','pos.payments.verify','pos.reports.view',
     'pos.registers.manage','pos.devices.manage','products.view','inventory.view','inventory.adjust','customers.manage'])
), ins AS (
  INSERT INTO roles (tenant_id, code, name, approval_level, is_system)
  SELECT t.id, d.code, d.name, d.level, true FROM tenants t CROSS JOIN defs d
  ON CONFLICT (tenant_id, code) DO NOTHING
  RETURNING id, tenant_id, code
)
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT ins.tenant_id, ins.id, unnest(d.perms) FROM ins JOIN defs d ON d.code = ins.code
ON CONFLICT DO NOTHING;

-- Tenant administrators get every POS permission.
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT r.tenant_id, r.id, p.code
  FROM roles r
 CROSS JOIN unnest(ARRAY['pos.access','pos.sales.create','pos.sales.view_all','pos.discount.apply','pos.discount.override','pos.price.override',
   'pos.refunds.create','pos.receipts.reprint','pos.cash.drawer','pos.shift.close','pos.shift.approve','pos.payments.verify','pos.reports.view',
   'pos.branches.all','pos.registers.manage','pos.devices.manage','pos.settings.manage']) AS p(code)
 WHERE r.code = 'TENANT_ADMIN'
ON CONFLICT DO NOTHING;

