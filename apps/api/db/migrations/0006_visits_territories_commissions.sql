-- CKH ONE — Phase 3: quotations, customer visits, territories, targets,
-- commissions and the HR & Payroll hand-off.

-- ---------------------------------------------------------------------------
-- Quotations: link to visits, remember the order they became.
-- ---------------------------------------------------------------------------
ALTER TABLE sales_quotations
  ADD COLUMN visit_id uuid,
  ADD COLUMN delivery_address_id uuid,
  ADD COLUMN payment_terms_days integer NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0),
  ADD COLUMN sent_at timestamptz,
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decision_note text,
  ADD FOREIGN KEY (tenant_id, visit_id) REFERENCES sales_visits (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, delivery_address_id) REFERENCES customer_addresses (tenant_id, id);

ALTER TABLE sales_quotation_lines
  ADD COLUMN unit_price_source text NOT NULL DEFAULT 'PRICE_LIST' CHECK (unit_price_source IN ('PRICE_LIST', 'PROMOTION', 'LIST_PRICE', 'OVERRIDE'));

-- ---------------------------------------------------------------------------
-- Visits: why location was captured, check-out time, cancellation reason.
-- ---------------------------------------------------------------------------
ALTER TABLE sales_visits
  ADD COLUMN location_purpose text,
  ADD COLUMN cancel_reason text,
  ADD COLUMN reviewed_by uuid,
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN review_comment text,
  ADD CONSTRAINT sales_visits_checkout_after_checkin CHECK (checked_out_at IS NULL OR (checked_in_at IS NOT NULL AND checked_out_at >= checked_in_at)),
  ADD FOREIGN KEY (tenant_id, reviewed_by) REFERENCES users (tenant_id, id);
CREATE INDEX sales_visit_notes_tasks_idx ON sales_visit_notes (tenant_id, assigned_to_user_id)
  WHERE note_type = 'FOLLOW_UP_TASK' AND completed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Territory geography may include a location and everything under it.
-- ---------------------------------------------------------------------------
CREATE INDEX admin_locations_level_idx ON admin_locations (country_code, level, parent_id);
CREATE INDEX customer_addresses_location_idx ON customer_addresses (tenant_id, location_id);

-- ---------------------------------------------------------------------------
-- Commissions
-- ---------------------------------------------------------------------------
ALTER TABLE sales_commission_entries DROP CONSTRAINT IF EXISTS sales_commission_entries_source_type_check;
ALTER TABLE sales_commission_entries
  ADD CONSTRAINT sales_commission_entries_source_type_check CHECK (source_type IN
    ('INVOICE', 'COLLECTION', 'CREDIT_NOTE', 'RETURN', 'CANCELLATION', 'OVERDUE_CLAWBACK', 'CLAWBACK_REINSTATED', 'TIER_BONUS', 'MANUAL_ADJUSTMENT')),
  ADD COLUMN invoice_id uuid,
  ADD COLUMN payroll_batch_id uuid,
  ADD COLUMN created_by uuid,
  ADD FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id);
DROP INDEX IF EXISTS sales_commission_entries_source_uq;
CREATE UNIQUE INDEX sales_commission_entries_source_uq
  ON sales_commission_entries (tenant_id, sales_rep_id, source_type, source_id)
  WHERE source_id IS NOT NULL AND source_type NOT IN ('MANUAL_ADJUSTMENT');
CREATE INDEX sales_commission_entries_invoice_idx ON sales_commission_entries (tenant_id, invoice_id);

-- Hand-off to HR & Payroll: approved commission is sent in monthly batches;
-- payroll marks a batch paid with its own reference.
CREATE TABLE payroll_commission_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number            text NOT NULL,
  period_month      date NOT NULL CHECK (EXTRACT(DAY FROM period_month) = 1),
  currency          char(3) NOT NULL,
  total_amount      numeric(18,2) NOT NULL,
  status            text NOT NULL DEFAULT 'SENT' CHECK (status IN ('SENT', 'PAID', 'CANCELLED')),
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  paid_at           timestamptz,
  paid_by           uuid,
  hr_reference      text,
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, paid_by) REFERENCES users (tenant_id, id)
);

CREATE TABLE payroll_commission_batch_lines (
  tenant_id       uuid NOT NULL,
  batch_id        uuid NOT NULL,
  sales_rep_id    uuid NOT NULL,
  hr_employee_id  uuid,
  employee_code   text NOT NULL,
  amount          numeric(18,2) NOT NULL,
  entry_count     integer NOT NULL,
  PRIMARY KEY (batch_id, sales_rep_id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES payroll_commission_batches (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, sales_rep_id) REFERENCES sales_representatives (tenant_id, id)
);

ALTER TABLE sales_commission_entries
  ADD FOREIGN KEY (tenant_id, payroll_batch_id) REFERENCES payroll_commission_batches (tenant_id, id);

-- Targets: one target per scope / period / metric / product filter.
CREATE UNIQUE INDEX sales_targets_unique ON sales_targets (
  tenant_id, scope, COALESCE(sales_rep_id, team_id, territory_id), period_type, period_start, metric,
  COALESCE(product_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

-- ---------------------------------------------------------------------------
-- Data
-- ---------------------------------------------------------------------------
SELECT set_config('app.platform_admin', 'on', true);

INSERT INTO document_sequences (tenant_id, doc_type, prefix)
SELECT id, 'PAYROLL_BATCH', 'PCB-{YYYY}-' FROM tenants
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT r.tenant_id, r.id, 'hr.payroll.manage' FROM roles r WHERE r.is_system AND r.code = 'TENANT_ADMIN'
ON CONFLICT DO NOTHING;

SELECT set_config('app.platform_admin', '', true);
