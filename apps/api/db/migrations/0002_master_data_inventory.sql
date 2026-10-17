-- CKH ONE — shared master data (the single customer and product masters used
-- by POS, CRM, Accounting and Sales) and inventory.

-- ---------------------------------------------------------------------------
-- Tax
-- ---------------------------------------------------------------------------
CREATE TABLE tax_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code          text NOT NULL,
  name          text NOT NULL,
  rate_percent  numeric(7,4) NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100),
  is_default    boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX tax_codes_one_default ON tax_codes (tenant_id) WHERE is_default;

-- ---------------------------------------------------------------------------
-- Products
-- ---------------------------------------------------------------------------
CREATE TABLE units (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code       text NOT NULL,
  name       text NOT NULL,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE product_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id  uuid,
  code       text NOT NULL,
  name       text NOT NULL,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES product_categories (tenant_id, id)
);

CREATE TABLE products (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku                 text NOT NULL,
  barcode             text,
  name                text NOT NULL,
  name_local          text,
  description         text,
  category_id         uuid,
  base_unit_id        uuid NOT NULL,
  tax_code_id         uuid,
  product_type        text NOT NULL DEFAULT 'STOCK' CHECK (product_type IN ('STOCK', 'SERVICE', 'NON_STOCK')),
  track_inventory     boolean NOT NULL DEFAULT true,
  -- Variant support: a variant points to its parent template product.
  parent_product_id   uuid,
  variant_attributes  jsonb,
  image_urls          text[] NOT NULL DEFAULT '{}',
  list_price          numeric(18,4) NOT NULL DEFAULT 0 CHECK (list_price >= 0),
  cost_price          numeric(18,4) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'DISCONTINUED')),
  is_sellable         boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES product_categories (tenant_id, id),
  FOREIGN KEY (tenant_id, base_unit_id) REFERENCES units (tenant_id, id),
  FOREIGN KEY (tenant_id, tax_code_id) REFERENCES tax_codes (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_product_id) REFERENCES products (tenant_id, id)
);
CREATE INDEX products_barcode_idx ON products (tenant_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX products_name_idx ON products (tenant_id, lower(name));
CREATE INDEX products_category_idx ON products (tenant_id, category_id);
CREATE TRIGGER products_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Alternative selling units (e.g. box of 24). factor = how many base units.
CREATE TABLE product_uoms (
  tenant_id   uuid NOT NULL,
  product_id  uuid NOT NULL,
  unit_id     uuid NOT NULL,
  factor      numeric(18,6) NOT NULL CHECK (factor > 0),
  barcode     text,
  PRIMARY KEY (product_id, unit_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, unit_id) REFERENCES units (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Price lists (price tiers) and promotions
-- ---------------------------------------------------------------------------
CREATE TABLE price_lists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL,
  name        text NOT NULL,
  currency    char(3) NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX price_lists_one_default ON price_lists (tenant_id) WHERE is_default;

CREATE TABLE price_list_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  price_list_id  uuid NOT NULL,
  product_id     uuid NOT NULL,
  unit_id        uuid,
  min_quantity   numeric(18,4) NOT NULL DEFAULT 0,
  unit_price     numeric(18,4) NOT NULL CHECK (unit_price >= 0),
  valid_from     date,
  valid_to       date,
  FOREIGN KEY (tenant_id, price_list_id) REFERENCES price_lists (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, unit_id) REFERENCES units (tenant_id, id),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE INDEX price_list_items_lookup ON price_list_items (tenant_id, price_list_id, product_id);

CREATE TABLE promotions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code              text NOT NULL,
  name              text NOT NULL,
  promo_type        text NOT NULL CHECK (promo_type IN ('PERCENT_OFF', 'FIXED_PRICE')),
  value             numeric(18,4) NOT NULL CHECK (value >= 0),
  product_id        uuid,
  category_id       uuid,
  customer_group_id uuid,
  min_quantity      numeric(18,4) NOT NULL DEFAULT 0,
  valid_from        timestamptz NOT NULL,
  valid_to          timestamptz NOT NULL,
  is_active         boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES product_categories (tenant_id, id),
  CHECK (valid_to > valid_from)
);

-- ---------------------------------------------------------------------------
-- Customers (single master shared with POS / CRM / Accounting)
-- ---------------------------------------------------------------------------
CREATE TABLE customer_groups (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code                      text NOT NULL,
  name                      text NOT NULL,
  default_price_list_id     uuid,
  default_payment_terms_days integer NOT NULL DEFAULT 0 CHECK (default_payment_terms_days >= 0),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, default_price_list_id) REFERENCES price_lists (tenant_id, id)
);

ALTER TABLE promotions
  ADD FOREIGN KEY (tenant_id, customer_group_id) REFERENCES customer_groups (tenant_id, id);

CREATE TABLE customers (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code                       text NOT NULL,
  name                       text NOT NULL,
  name_local                 text,
  customer_type              text NOT NULL DEFAULT 'BUSINESS' CHECK (customer_type IN ('BUSINESS', 'INDIVIDUAL')),
  customer_group_id          uuid,
  price_list_id              uuid,
  vat_tin                    text,
  contact_name               text,
  phone                      text,
  email                      text,
  payment_terms_days         integer NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0),
  credit_limit               numeric(18,2) CHECK (credit_limit IS NULL OR credit_limit >= 0),
  credit_hold                boolean NOT NULL DEFAULT false,
  -- Pre-approved special discount; orders up to this % need no approval.
  special_discount_percent   numeric(7,4) NOT NULL DEFAULT 0 CHECK (special_discount_percent BETWEEN 0 AND 100),
  currency                   char(3),
  status                     text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'BLOCKED')),
  crm_lead_id                uuid,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_group_id) REFERENCES customer_groups (tenant_id, id),
  FOREIGN KEY (tenant_id, price_list_id) REFERENCES price_lists (tenant_id, id)
);
CREATE INDEX customers_name_idx ON customers (tenant_id, lower(name));
CREATE TRIGGER customers_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE customer_addresses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  customer_id   uuid NOT NULL,
  address_type  text NOT NULL CHECK (address_type IN ('BILLING', 'DELIVERY')),
  label         text,
  line1         text NOT NULL,
  line2         text,
  location_id   uuid REFERENCES admin_locations(id),
  postal_code   text,
  latitude      numeric(9,6),
  longitude     numeric(9,6),
  contact_name  text,
  contact_phone text,
  is_default    boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX customer_addresses_one_default
  ON customer_addresses (customer_id, address_type) WHERE is_default;

CREATE TABLE customer_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  customer_id     uuid NOT NULL,
  author_user_id  uuid NOT NULL,
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, author_user_id) REFERENCES users (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Inventory
-- ---------------------------------------------------------------------------
CREATE TABLE stock_levels (
  tenant_id     uuid NOT NULL,
  warehouse_id  uuid NOT NULL,
  product_id    uuid NOT NULL,
  qty_on_hand   numeric(18,4) NOT NULL DEFAULT 0,
  qty_reserved  numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_reserved >= 0),
  avg_cost      numeric(18,6) NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (warehouse_id, product_id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);
CREATE INDEX stock_levels_product_idx ON stock_levels (tenant_id, product_id);
CREATE TRIGGER stock_levels_updated_at BEFORE UPDATE ON stock_levels FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Anti-oversell guard: in centrally controlled warehouses reserved stock may
-- never exceed stock on hand. Enforced in the database so concurrent
-- requests cannot race past it.
CREATE OR REPLACE FUNCTION stock_levels_no_oversell() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  controlled boolean;
BEGIN
  SELECT centrally_controlled INTO controlled FROM warehouses WHERE id = NEW.warehouse_id;
  IF controlled AND NEW.qty_reserved > NEW.qty_on_hand THEN
    RAISE EXCEPTION 'Reserved quantity (%) would exceed stock on hand (%) for product % in warehouse %',
      NEW.qty_reserved, NEW.qty_on_hand, NEW.product_id, NEW.warehouse_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_levels_no_oversell';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_levels_no_oversell BEFORE INSERT OR UPDATE ON stock_levels
  FOR EACH ROW EXECUTE FUNCTION stock_levels_no_oversell();

CREATE TABLE stock_movements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  warehouse_id    uuid NOT NULL,
  product_id      uuid NOT NULL,
  movement_type   text NOT NULL CHECK (movement_type IN
                    ('RECEIPT', 'ISSUE', 'ADJUSTMENT', 'TRANSFER_IN', 'TRANSFER_OUT', 'SALE_DELIVERY', 'SALE_RETURN', 'POS_SALE')),
  quantity        numeric(18,4) NOT NULL CHECK (quantity <> 0),  -- signed: + in, - out
  unit_cost       numeric(18,6),
  reference_type  text,
  reference_id    uuid,
  notes           text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);
CREATE INDEX stock_movements_product_idx ON stock_movements (tenant_id, product_id, created_at DESC);
CREATE INDEX stock_movements_reference_idx ON stock_movements (tenant_id, reference_type, reference_id);
