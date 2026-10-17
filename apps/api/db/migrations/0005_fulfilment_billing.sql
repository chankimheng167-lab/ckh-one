-- CKH ONE — Phase 2: picking, packing, dispatch, delivery notes, partial
-- deliveries, backorders, returns, invoicing, credit notes and verified
-- payment collections.

-- ---------------------------------------------------------------------------
-- Order line fulfilment counters (all in the line's unit)
--   qty_reserved    stock currently held for the line (not yet dispatched)
--   qty_dispatched  shipped on a delivery note
--   qty_delivered   confirmed received by the customer
--   qty_cancelled   remainder closed without shipping (short-closed backorder)
--   qty_invoiced    billed on invoices
--   qty_credited    reversed on credit notes
--   qty_returned    returned by the customer after delivery
-- ---------------------------------------------------------------------------
ALTER TABLE sales_order_lines
  ADD COLUMN qty_dispatched numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_dispatched >= 0),
  ADD COLUMN qty_cancelled  numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_cancelled >= 0),
  ADD COLUMN qty_credited   numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_credited >= 0),
  ADD CONSTRAINT sales_order_lines_fulfilment_chk CHECK (
    qty_delivered <= qty_dispatched
    AND qty_dispatched + qty_cancelled <= quantity
    AND qty_credited <= qty_invoiced
  );

ALTER TABLE sales_orders
  ADD COLUMN picking_started_at timestamptz,
  ADD COLUMN picked_by          uuid,
  ADD COLUMN packed_at          timestamptz,
  ADD COLUMN packed_by          uuid,
  ADD COLUMN package_count      integer CHECK (package_count IS NULL OR package_count > 0),
  ADD COLUMN closed_at          timestamptz,
  ADD FOREIGN KEY (tenant_id, picked_by) REFERENCES users (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, packed_by) REFERENCES users (tenant_id, id);

-- ---------------------------------------------------------------------------
-- Delivery notes
-- ---------------------------------------------------------------------------
CREATE TABLE sales_deliveries (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number                 text NOT NULL,
  order_id               uuid NOT NULL,
  warehouse_id           uuid NOT NULL,
  status                 text NOT NULL DEFAULT 'DISPATCHED' CHECK (status IN ('DISPATCHED', 'DELIVERED')),
  carrier                text,
  vehicle_no             text,
  driver_name            text,
  tracking_reference     text,
  dispatched_at          timestamptz NOT NULL DEFAULT now(),
  dispatched_by          uuid NOT NULL,
  delivered_at           timestamptz,
  confirmed_by           uuid,
  received_by_name       text,
  delivery_note          text,
  cogs_journal_entry_id  uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'DELIVERED' OR (delivered_at IS NOT NULL AND confirmed_by IS NOT NULL)),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, dispatched_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, confirmed_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, cogs_journal_entry_id) REFERENCES journal_entries (tenant_id, id)
);
-- One delivery on the road per order at a time.
CREATE UNIQUE INDEX sales_deliveries_one_open ON sales_deliveries (tenant_id, order_id) WHERE status = 'DISPATCHED';
CREATE INDEX sales_deliveries_status_idx ON sales_deliveries (tenant_id, status, dispatched_at DESC);

CREATE TABLE sales_delivery_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  delivery_id     uuid NOT NULL,
  order_line_id   uuid NOT NULL,
  product_id      uuid NOT NULL,
  quantity        numeric(18,4) NOT NULL CHECK (quantity > 0),
  quantity_base   numeric(18,4) NOT NULL CHECK (quantity_base > 0),
  unit_cost       numeric(18,6) NOT NULL DEFAULT 0,  -- per base unit, at dispatch
  qty_delivered   numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_delivered >= 0),
  CHECK (qty_delivered <= quantity),
  UNIQUE (delivery_id, order_line_id),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES sales_deliveries (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES sales_order_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Invoices ↔ order lines
-- ---------------------------------------------------------------------------
ALTER TABLE invoice_lines
  ADD FOREIGN KEY (tenant_id, sales_order_line_id) REFERENCES sales_order_lines (tenant_id, id);
CREATE INDEX invoices_order_idx ON invoices (tenant_id, sales_order_id);

-- ---------------------------------------------------------------------------
-- Customer returns (RMA)
-- ---------------------------------------------------------------------------
CREATE TABLE sales_returns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number            text NOT NULL,
  order_id          uuid NOT NULL,
  customer_id       uuid NOT NULL,
  warehouse_id      uuid NOT NULL,
  status            text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'RECEIVED', 'REJECTED')),
  reason            text NOT NULL,
  requested_by      uuid NOT NULL,
  decided_by        uuid,
  decided_at        timestamptz,
  rejection_reason  text,
  credit_note_id    uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'REJECTED' OR rejection_reason IS NOT NULL),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, credit_note_id) REFERENCES credit_notes (tenant_id, id)
);
CREATE INDEX sales_returns_order_idx ON sales_returns (tenant_id, order_id);

CREATE TABLE sales_return_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  return_id      uuid NOT NULL,
  order_line_id  uuid NOT NULL,
  product_id     uuid NOT NULL,
  quantity       numeric(18,4) NOT NULL CHECK (quantity > 0),
  restock        boolean NOT NULL DEFAULT true,
  UNIQUE (return_id, order_line_id),
  FOREIGN KEY (tenant_id, return_id) REFERENCES sales_returns (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES sales_order_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Credit notes: how much has been applied against invoices, and the source
-- ---------------------------------------------------------------------------
ALTER TABLE credit_notes
  ADD COLUMN amount_applied  numeric(18,2) NOT NULL DEFAULT 0 CHECK (amount_applied >= 0),
  ADD COLUMN sales_order_id  uuid,
  ADD COLUMN sales_return_id uuid,
  ADD CONSTRAINT credit_notes_applied_chk CHECK (amount_applied <= grand_total),
  ADD FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sales_orders (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, sales_return_id) REFERENCES sales_returns (tenant_id, id);

CREATE TABLE credit_note_applications (
  tenant_id       uuid NOT NULL,
  credit_note_id  uuid NOT NULL,
  invoice_id      uuid NOT NULL,
  amount          numeric(18,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (credit_note_id, invoice_id),
  FOREIGN KEY (tenant_id, credit_note_id) REFERENCES credit_notes (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);

ALTER TABLE credit_note_lines
  ADD COLUMN sales_order_line_id uuid,
  ADD FOREIGN KEY (tenant_id, sales_order_line_id) REFERENCES sales_order_lines (tenant_id, id);

-- A verified collection links to its receipt; reject duplicate verification.
ALTER TABLE customer_receipts
  ADD COLUMN collection_id uuid,
  ADD COLUMN amount_allocated numeric(18,2) NOT NULL DEFAULT 0 CHECK (amount_allocated >= 0),
  ADD CONSTRAINT customer_receipts_alloc_chk CHECK (amount_allocated <= amount);
CREATE UNIQUE INDEX customer_receipts_collection_uq ON customer_receipts (tenant_id, collection_id) WHERE collection_id IS NOT NULL;
CREATE INDEX invoices_open_idx ON invoices (tenant_id, customer_id, due_date) WHERE status IN ('ISSUED', 'PARTIALLY_PAID');

-- ---------------------------------------------------------------------------
-- Customer balance = open invoices − unapplied credit notes − unallocated
-- receipts (customer advances). Only verified receipts count.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS customer_balances;
CREATE VIEW customer_balances WITH (security_invoker = true) AS
WITH inv AS (
  SELECT tenant_id, customer_id,
         SUM(grand_total - amount_paid - amount_credited) AS open_amount,
         SUM(CASE WHEN due_date < CURRENT_DATE THEN grand_total - amount_paid - amount_credited ELSE 0 END) AS overdue,
         MIN(due_date) FILTER (WHERE grand_total - amount_paid - amount_credited > 0) AS oldest_due_date
    FROM invoices WHERE status IN ('ISSUED', 'PARTIALLY_PAID')
   GROUP BY tenant_id, customer_id
), cred AS (
  SELECT tenant_id, customer_id, SUM(grand_total - amount_applied) AS unapplied
    FROM credit_notes WHERE status = 'ISSUED' AND grand_total > amount_applied
   GROUP BY tenant_id, customer_id
), adv AS (
  SELECT tenant_id, customer_id, SUM(amount - amount_allocated) AS unallocated
    FROM customer_receipts WHERE status = 'POSTED' AND amount > amount_allocated
   GROUP BY tenant_id, customer_id
), keys AS (
  SELECT tenant_id, customer_id FROM inv UNION SELECT tenant_id, customer_id FROM cred UNION SELECT tenant_id, customer_id FROM adv
)
SELECT k.tenant_id, k.customer_id,
       COALESCE(inv.open_amount, 0) - COALESCE(cred.unapplied, 0) - COALESCE(adv.unallocated, 0) AS outstanding,
       COALESCE(inv.overdue, 0) AS overdue,
       inv.oldest_due_date
  FROM keys k
  LEFT JOIN inv  ON inv.tenant_id = k.tenant_id AND inv.customer_id = k.customer_id
  LEFT JOIN cred ON cred.tenant_id = k.tenant_id AND cred.customer_id = k.customer_id
  LEFT JOIN adv  ON adv.tenant_id = k.tenant_id AND adv.customer_id = k.customer_id;

-- ---------------------------------------------------------------------------
-- Stock movements may reference delivery notes and returns.
-- ---------------------------------------------------------------------------
-- (reference_type/reference_id are free-form; no change needed.)

-- ---------------------------------------------------------------------------
-- Data: numbering for returns, and new permissions on existing system roles.
-- ---------------------------------------------------------------------------
SELECT set_config('app.platform_admin', 'on', true);

INSERT INTO document_sequences (tenant_id, doc_type, prefix)
SELECT id, 'SALES_RETURN', 'RMA-{YYYY}-' FROM tenants
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT r.tenant_id, r.id, p.code
  FROM roles r
  JOIN (VALUES
    ('TENANT_ADMIN', 'sales.returns.request'), ('TENANT_ADMIN', 'sales.returns.receive'),
    ('SALES_REP', 'sales.returns.request'), ('SALES_SUPERVISOR', 'sales.returns.request'),
    ('SALES_MANAGER', 'sales.returns.request'), ('WAREHOUSE_OFFICER', 'sales.returns.receive'),
    ('WAREHOUSE_OFFICER', 'sales.orders.cancel')
  ) AS p(role_code, code) ON p.role_code = r.code
 WHERE r.is_system
ON CONFLICT DO NOTHING;

SELECT set_config('app.platform_admin', '', true);
