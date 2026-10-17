-- Phase 4: offline sync bookkeeping and Theme Studio.

-- Theme Studio: one row per tenant with validated design-token overrides.
CREATE TABLE tenant_theme_settings (
  tenant_id    uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  tokens       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(tokens) = 'object'),
  logo_url     text,
  company_display_name text,
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Speeds up resolving visitKey references between events of one user.
CREATE INDEX sales_offline_sync_events_entity_idx ON sales_offline_sync_events (tenant_id, user_id, entity_type, idempotency_key);
