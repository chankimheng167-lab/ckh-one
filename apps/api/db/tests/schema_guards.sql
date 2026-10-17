-- Run against a freshly migrated database as a superuser:
--   psql -d <db> -f apps/api/db/tests/schema_guards.sql
-- Every block marked "expect ..." must raise the stated error.
\set ON_ERROR_STOP 0
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ckh_app_test') THEN CREATE ROLE ckh_app_test LOGIN IN ROLE ckh_app; END IF; END $$;
-- seed two tenants as platform admin
SET app.platform_admin = 'on';
INSERT INTO tenants (id, code, name) VALUES ('11111111-1111-1111-1111-111111111111','alpha','Alpha'),('22222222-2222-2222-2222-222222222222','beta','Beta');
INSERT INTO branches (id, tenant_id, code, name) VALUES ('a0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','HQ','HQ'),('b0000000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','HQ','HQ');
INSERT INTO warehouses (id, tenant_id, branch_id, code, name) VALUES ('a0000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-000000000001','WH1','Main');
INSERT INTO units (id, tenant_id, code, name) VALUES ('a0000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','PCS','Piece');
INSERT INTO products (id, tenant_id, sku, name, base_unit_id) VALUES ('a0000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','SKU1','Rice 25kg','a0000000-0000-0000-0000-000000000003');
INSERT INTO stock_levels (tenant_id, warehouse_id, product_id, qty_on_hand) VALUES ('11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000004',10);
INSERT INTO customers (tenant_id, code, name) VALUES ('11111111-1111-1111-1111-111111111111','C1','Alpha customer'),('22222222-2222-2222-2222-222222222222','C1','Beta customer');
RESET app.platform_admin;
SET ROLE ckh_app_test;
\echo '--- no tenant set: expect 0 customers'
SELECT count(*) FROM customers;
\echo '--- as beta: expect only Beta customer'
BEGIN; SELECT set_config('app.tenant_id','22222222-2222-2222-2222-222222222222',true); SELECT name FROM customers; 
\echo '--- beta tries to insert a row for alpha: expect RLS violation'
INSERT INTO customers (tenant_id, code, name) VALUES ('11111111-1111-1111-1111-111111111111','X','sneaky');
ROLLBACK;
\echo '--- beta tries to enable a module for itself: expect RLS violation'
BEGIN; SELECT set_config('app.tenant_id','22222222-2222-2222-2222-222222222222',true);
INSERT INTO platform_modules VALUES ('X','x','{}',false);
ROLLBACK;
BEGIN; SELECT set_config('app.tenant_id','22222222-2222-2222-2222-222222222222',true);
INSERT INTO tenant_modules (tenant_id, module_code) VALUES ('22222222-2222-2222-2222-222222222222','CORE');
ROLLBACK;
\echo '--- beta product pointing at alpha unit: expect FK violation (composite key)'
RESET ROLE; SET app.platform_admin='on';
INSERT INTO products (tenant_id, sku, name, base_unit_id) VALUES ('22222222-2222-2222-2222-222222222222','SKU1','x','a0000000-0000-0000-0000-000000000003');
RESET app.platform_admin; SET ROLE ckh_app_test;
\echo '--- alpha reserves 8 of 10: ok; then 3 more: expect oversell block'
BEGIN; SELECT set_config('app.tenant_id','11111111-1111-1111-1111-111111111111',true);
UPDATE stock_levels SET qty_reserved = qty_reserved + 8 RETURNING qty_on_hand, qty_reserved;
UPDATE stock_levels SET qty_reserved = qty_reserved + 3;
ROLLBACK;
\echo '--- unbalanced journal: expect failure at COMMIT'
BEGIN; SELECT set_config('app.tenant_id','11111111-1111-1111-1111-111111111111',true);
INSERT INTO chart_of_accounts (id, tenant_id, code, name, account_type) VALUES ('a0000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','1100','AR','ASSET'),('a0000000-0000-0000-0000-0000000000a2','11111111-1111-1111-1111-111111111111','4000','Sales','REVENUE');
INSERT INTO journal_entries (id, tenant_id, number, entry_date) VALUES ('a0000000-0000-0000-0000-0000000000a3','11111111-1111-1111-1111-111111111111','JV1',CURRENT_DATE);
INSERT INTO journal_lines (tenant_id, journal_entry_id, account_id, debit) VALUES ('11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-0000000000a3','a0000000-0000-0000-0000-0000000000a1',100);
INSERT INTO journal_lines (tenant_id, journal_entry_id, account_id, credit) VALUES ('11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-0000000000a3','a0000000-0000-0000-0000-0000000000a2',90);
COMMIT;
\echo '--- audit log cannot be altered'
BEGIN; SELECT set_config('app.tenant_id','11111111-1111-1111-1111-111111111111',true);
INSERT INTO audit_log (tenant_id, actor_type, action, entity_type) VALUES ('11111111-1111-1111-1111-111111111111','SYSTEM','x','y');
UPDATE audit_log SET action='tampered';
ROLLBACK;
