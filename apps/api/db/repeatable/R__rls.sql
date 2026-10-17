-- Row-level security: every table that has a tenant_id column is filtered by
-- the current transaction's app.tenant_id. The API sets it with
--   SELECT set_config('app.tenant_id', $1, true)
-- at the start of every request transaction. FORCE makes the policy apply
-- to the table owner too, so nothing bypasses it by accident.
--
-- Super Admin operations set app.platform_admin = 'on' instead.
-- Re-run safely: policies are dropped and recreated.

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
      AND c.table_name NOT IN ('admin_locations', 'schema_migrations')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id() OR is_platform_admin()) '
      'WITH CHECK (tenant_id = current_tenant_id() OR is_platform_admin())',
      t.table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO ckh_app', t.table_name);
  END LOOP;
END $$;

-- Tenants: a tenant session sees only its own row.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self ON tenants;
CREATE POLICY tenant_self ON tenants
  USING (id = current_tenant_id() OR is_platform_admin())
  WITH CHECK (is_platform_admin());
GRANT SELECT, INSERT, UPDATE ON tenants TO ckh_app;

-- Admin locations: shared reference rows (tenant_id NULL) are readable by
-- everyone; only the platform can change them. Tenant rows are private.
ALTER TABLE admin_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_locations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_locations_read ON admin_locations;
DROP POLICY IF EXISTS admin_locations_write ON admin_locations;
CREATE POLICY admin_locations_read ON admin_locations FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = current_tenant_id() OR is_platform_admin());
CREATE POLICY admin_locations_write ON admin_locations FOR ALL
  USING (tenant_id = current_tenant_id() OR is_platform_admin())
  WITH CHECK (tenant_id = current_tenant_id() OR is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_locations TO ckh_app;

-- Subscription state: tenants may read their own, only the platform writes.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_modules', 'tenant_subscriptions'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_read ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS platform_write ON %I', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT USING (tenant_id = current_tenant_id() OR is_platform_admin())', t);
    EXECUTE format('CREATE POLICY platform_write ON %I FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin())', t);
  END LOOP;
END $$;

-- Audit log: insert + read only.
REVOKE UPDATE, DELETE ON audit_log FROM ckh_app;

-- Platform reference tables.
GRANT SELECT ON platform_modules, subscription_plans TO ckh_app;
GRANT SELECT, INSERT, UPDATE ON platform_admins TO ckh_app;
GRANT SELECT ON customer_balances TO ckh_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ckh_app;
