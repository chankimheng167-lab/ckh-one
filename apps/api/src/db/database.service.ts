import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { loadConfig } from '../config';

/** A client bound to one transaction with tenant context already set. */
export interface Tx {
  query<R extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<R[]>;
  one<R extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<R>;
  maybeOne<R extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<R | null>;
  readonly tenantId: string | null;
  readonly userId: string | null;
}

export class NotFoundRowError extends Error {}

function wrap(client: PoolClient, tenantId: string | null, userId: string | null): Tx {
  return {
    tenantId,
    userId,
    async query(sql, params) {
      const r = await client.query(sql, params as any[]);
      return r.rows;
    },
    async one(sql, params) {
      const r = await client.query(sql, params as any[]);
      if (r.rows.length === 0) throw new NotFoundRowError('Expected one row, got none');
      return r.rows[0];
    },
    async maybeOne(sql, params) {
      const r = await client.query(sql, params as any[]);
      return r.rows[0] ?? null;
    },
  };
}

/**
 * All database work goes through withTenant() or withPlatform(). Both open a
 * transaction and set the session variables that row-level security reads,
 * so a query can never see another tenant's data even if it forgets a
 * tenant_id filter.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor() {
    const cfg = loadConfig();
    this.pool = new Pool({ connectionString: cfg.databaseUrl, max: 20 });
    // node-postgres returns NUMERIC as strings by default; money stays exact
    // and is handled with decimal.js, never JS floats.
    this.pool.on('connect', (c) => c.query("SET TIME ZONE 'UTC'"));
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  async withTenant<T>(tenantId: string, userId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run(async (client) => {
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.platform_admin', '', true)",
        [tenantId, userId ?? ''],
      );
      return fn(wrap(client, tenantId, userId));
    });
  }

  async withPlatform<T>(adminId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run(async (client) => {
      await client.query(
        "SELECT set_config('app.platform_admin', 'on', true), set_config('app.tenant_id', '', true), set_config('app.user_id', $1, true)",
        [adminId ?? ''],
      );
      return fn(wrap(client, null, adminId));
    });
  }

  private async run<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
