-- CKH ONE — platform core: tenants, subscriptions, users, roles, branches,
-- warehouses, audit log, admin locations, document numbering.
--
-- Tenant isolation is enforced twice:
--   1. Composite foreign keys (tenant_id, id) make cross-tenant references
--      impossible at the schema level.
--   2. Row-level security (applied in 0099_rls.sql) filters every query by
--      the session setting app.tenant_id, so a missing WHERE clause in
--      application code cannot leak another tenant's rows.

-- ---------------------------------------------------------------------------
-- Session context helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.platform_admin', true), '') = 'on'
$$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Application role. Deployments create a LOGIN user that is a member of it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ckh_app') THEN
    CREATE ROLE ckh_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Platform (Super Admin) tables
-- ---------------------------------------------------------------------------
CREATE TABLE platform_admins (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  password_hash  text NOT NULL,
  full_name      text NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_admins_email_uq ON platform_admins (lower(email));

CREATE TABLE tenants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name           text NOT NULL,
  legal_name     text,
  vat_tin        text,
  status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  base_currency  char(3) NOT NULL DEFAULT 'USD',
  timezone       text NOT NULL DEFAULT 'Asia/Phnom_Penh',
  country_code   char(2) NOT NULL DEFAULT 'KH',
  settings       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tenants_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE platform_modules (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  requires    text[] NOT NULL DEFAULT '{}',
  is_core     boolean NOT NULL DEFAULT false
);

CREATE TABLE subscription_plans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,
  name           text NOT NULL,
  price_monthly  numeric(18,2) NOT NULL DEFAULT 0,
  price_yearly   numeric(18,2),
  currency       char(3) NOT NULL DEFAULT 'USD',
  max_users      integer,
  max_branches   integer,
  modules        text[] NOT NULL DEFAULT '{}',
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_subscriptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id        uuid REFERENCES subscription_plans(id),
  status         text NOT NULL CHECK (status IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'EXPIRED', 'CANCELLED')),
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz,
  grace_ends_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- At most one current subscription row per tenant.
CREATE UNIQUE INDEX tenant_subscriptions_current_uq ON tenant_subscriptions (tenant_id)
  WHERE status IN ('TRIAL', 'ACTIVE', 'PAST_DUE');
CREATE TRIGGER tenant_subscriptions_updated_at BEFORE UPDATE ON tenant_subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Per-tenant module switches (Super Admin controls these).
CREATE TABLE tenant_modules (
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module_code    text NOT NULL REFERENCES platform_modules(code),
  enabled        boolean NOT NULL DEFAULT true,
  starts_at      timestamptz NOT NULL DEFAULT now(),
  ends_at        timestamptz,
  updated_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module_code)
);

-- ---------------------------------------------------------------------------
-- Tenant users, roles, permissions
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email          text NOT NULL,
  password_hash  text NOT NULL,
  full_name      text NOT NULL,
  phone          text,
  locale         text NOT NULL DEFAULT 'en',
  status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX users_tenant_email_uq ON users (tenant_id, lower(email));
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code            text NOT NULL,
  name            text NOT NULL,
  -- 0 none, 1 supervisor, 2 manager, 3 director (see @ckh/shared approval-policy)
  approval_level  smallint NOT NULL DEFAULT 0 CHECK (approval_level BETWEEN 0 AND 3),
  is_system       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE role_permissions (
  tenant_id        uuid NOT NULL,
  role_id          uuid NOT NULL,
  permission_code  text NOT NULL,
  PRIMARY KEY (role_id, permission_code),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE user_roles (
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  role_id    uuid NOT NULL,
  PRIMARY KEY (user_id, role_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Organisation structure
-- ---------------------------------------------------------------------------
CREATE TABLE branches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL,
  name        text NOT NULL,
  address     jsonb,
  phone       text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE warehouses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id           uuid NOT NULL,
  code                text NOT NULL,
  name                text NOT NULL,
  -- When true, reservations may never exceed on-hand stock (no overselling).
  centrally_controlled boolean NOT NULL DEFAULT true,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);

-- Warehouses whose stock a user may see / sell from. Users with
-- inventory.view see all warehouses.
CREATE TABLE user_warehouse_access (
  tenant_id     uuid NOT NULL,
  user_id       uuid NOT NULL,
  warehouse_id  uuid NOT NULL,
  PRIMARY KEY (user_id, warehouse_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Administrative locations (configurable, not hardcoded).
-- tenant_id NULL = platform-provided reference data (e.g. Cambodian
-- provinces/districts loaded from an official source); tenants may add their
-- own rows (e.g. sales regions that group provinces). Rows carry validity
-- dates so boundary changes can be versioned instead of overwritten.
-- ---------------------------------------------------------------------------
CREATE TABLE admin_locations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES tenants(id) ON DELETE CASCADE,
  country_code  char(2) NOT NULL DEFAULT 'KH',
  parent_id     uuid REFERENCES admin_locations(id),
  level         text NOT NULL CHECK (level IN ('COUNTRY', 'REGION', 'PROVINCE', 'DISTRICT', 'COMMUNE', 'VILLAGE')),
  code          text NOT NULL,
  name          text NOT NULL,
  name_local    text,
  valid_from    date,
  valid_to      date,
  source        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX admin_locations_code_uq
  ON admin_locations (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), country_code, level, code);
CREATE INDEX admin_locations_parent_idx ON admin_locations (parent_id);

-- ---------------------------------------------------------------------------
-- Document numbering (gap-free per tenant & document type)
-- ---------------------------------------------------------------------------
CREATE TABLE document_sequences (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  doc_type    text NOT NULL,
  prefix      text NOT NULL,
  next_value  bigint NOT NULL DEFAULT 1,
  padding     smallint NOT NULL DEFAULT 5,
  PRIMARY KEY (tenant_id, doc_type)
);

-- ---------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid REFERENCES tenants(id),
  actor_type     text NOT NULL CHECK (actor_type IN ('USER', 'PLATFORM_ADMIN', 'SYSTEM')),
  actor_id       uuid,
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      text,
  before_data    jsonb,
  after_data     jsonb,
  ip_address     inet,
  request_id     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (tenant_id, entity_type, entity_id);
CREATE INDEX audit_log_created_idx ON audit_log (tenant_id, created_at DESC);

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
