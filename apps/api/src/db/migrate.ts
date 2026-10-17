import { Client } from 'pg';
import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const REPEATABLE_DIR = join(__dirname, '..', '..', 'db', 'repeatable');

/**
 * Applies versioned migrations (db/migrations/NNNN_name.sql) once each, in
 * order, each in its own transaction; then re-applies repeatable scripts
 * (db/repeatable/R__*.sql, e.g. row-level security) whose content changed —
 * and always after any new versioned migration, so new tables get RLS.
 * A Postgres advisory lock prevents two deploys migrating at once.
 */
export async function migrate(connectionString: string, log: (m: string) => void = console.log): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(726354)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    const applied = new Map<string, string>(
      (await client.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]),
    );

    let appliedVersioned = false;
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex');
      if (applied.has(file)) {
        if (applied.get(file) !== sum) {
          throw new Error(`Migration ${file} was modified after being applied. Create a new migration instead.`);
        }
        continue;
      }
      log(`applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, sum]);
        await client.query('COMMIT');
        appliedVersioned = true;
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
      }
    }

    for (const file of readdirSync(REPEATABLE_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = readFileSync(join(REPEATABLE_DIR, file), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex');
      if (!appliedVersioned && applied.get(file) === sum) continue;
      log(`applying repeatable ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)
           ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
          [file, sum],
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Repeatable ${file} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(726354)').catch(() => undefined);
    await client.end();
  }
}
