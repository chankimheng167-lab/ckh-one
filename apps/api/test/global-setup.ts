import { Client } from 'pg';

/**
 * Creates a fresh test database, migrates it as the owner, creates the
 * restricted application login (member of ckh_app, subject to RLS) and seeds
 * platform reference data. Tests then connect as the restricted login, so
 * row-level security is exercised exactly as in production.
 *
 * Env: TEST_PG_ADMIN_URL (default postgres://postgres@localhost:5432/postgres)
 */
export default async function globalSetup() {
  const adminUrl = process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres@localhost:5432/postgres';
  const dbName = process.env.TEST_DB_NAME ?? 'ckh_one_test';
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  const ownerUrl = u.toString();

  // ts-node is not used here: jest's transformer handles these imports.
  const { migrate } = await import('../src/db/migrate');
  await migrate(ownerUrl, () => undefined);

  const owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await owner.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ckh_app_test_user') THEN
        CREATE ROLE ckh_app_test_user LOGIN PASSWORD 'ckh_app_test_pass' IN ROLE ckh_app;
      END IF;
    END $$`);
  await owner.end();

  const { platformTx, seedPlatform } = await import('../src/db/seed');
  await platformTx(ownerUrl, (tx) => seedPlatform(tx, { email: 'root@ckh.test', password: 'RootPassword!1', fullName: 'Test Root' }));

  const appUrl = new URL(ownerUrl);
  appUrl.username = 'ckh_app_test_user';
  appUrl.password = 'ckh_app_test_pass';
  process.env.DATABASE_URL = appUrl.toString();
  process.env.TEST_OWNER_URL = ownerUrl;
}
