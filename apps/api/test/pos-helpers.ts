import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { randomUUID } from 'crypto';
import { ALL_SALES_MODULES, Api, Company, createCompany, ownerUrl } from './helpers';

export interface PosCompany extends Company {
  pos: {
    cashier: string;
    cashier2: string;
    supervisor: string;
    manager: string;
    supervisorId: string;
    cashierId: string;
    registerId: string;
    register2Id: string;
    methods: Record<'CASH' | 'CARD' | 'KHQR' | 'BANK', string>;
    shiftId: string;
  };
}

export const SUPERVISOR_PIN = '4826';
const PW = 'Password!2026';

const ok = (r: { status: number; body: any }, what: string) => {
  if (r.status >= 300) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

/**
 * A company with the SFA fixture plus POS: cashier, second cashier,
 * supervisor (with an approval PIN) and POS manager; two registers on the head
 * office warehouse; the till open with a $100 float on register 1.
 */
export async function createPosCompany(app: INestApplication, opts: { modules?: string[]; openShift?: boolean } = {}): Promise<PosCompany> {
  const co = await createCompany(app, { modules: opts.modules ?? [...ALL_SALES_MODULES, 'POS_SALES'] });
  const api = new Api(app);
  const admin = api.as(co.tokens.admin);
  const login = async (email: string) => ok(await api.post('/auth/login', { tenantCode: co.code, email, password: PW }), `login ${email}`).accessToken as string;
  const mkUser = async (email: string, role: string) =>
    ok(await admin.post('/admin/users', { email, fullName: email.split('@')[0], password: PW, roleCodes: [role] }), `user ${email}`).id as string;
  const cashierId = await mkUser('cashier@x.test', 'POS_CASHIER');
  const cashier2Id = await mkUser('cashier2@x.test', 'POS_CASHIER');
  const supervisorId = await mkUser('possup@x.test', 'POS_SUPERVISOR');
  await mkUser('posmgr@x.test', 'POS_MANAGER');

  const r1 = ok(await admin.post('/pos/admin/registers', { code: 'R1', name: 'Till 1', branchId: co.branchId, warehouseId: co.warehouseId }), 'register 1');
  const r2 = ok(await admin.post('/pos/admin/registers', { code: 'R2', name: 'Till 2', branchId: co.branchId, warehouseId: co.warehouseId }), 'register 2');
  for (const u of [cashierId, cashier2Id, supervisorId]) ok(await admin.put(`/pos/admin/staff/${u}/branches`, { branchIds: [co.branchId] }), 'staff branch');

  const cashier = await login('cashier@x.test');
  const supervisor = await login('possup@x.test');
  ok(await api.as(supervisor).put('/pos/me/pin', { currentPassword: PW, pin: SUPERVISOR_PIN }), 'pin');

  const methods = ok(await admin.get('/pos/admin/payment-methods'), 'methods') as { id: string; code: string }[];
  const m = Object.fromEntries(methods.map((x) => [x.code, x.id])) as PosCompany['pos']['methods'];

  let shiftId = '';
  if (opts.openShift !== false) {
    shiftId = ok(await api.as(cashier).post('/pos/shifts/open', { registerId: r1.id, openingFloat: '100.00' }), 'open shift').id;
  }
  return {
    ...co,
    pos: {
      cashier,
      cashier2: await login('cashier2@x.test'),
      supervisor,
      manager: await login('posmgr@x.test'),
      supervisorId,
      cashierId,
      registerId: r1.id,
      register2Id: r2.id,
      methods: m,
      shiftId,
    },
  };
}

export const key = () => `sale-${randomUUID()}`;

/** Read-only checks straight against the database as the owner (bypassing the API). */
export async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: ownerUrl() });
  await c.connect();
  try {
    await c.query("SELECT set_config('app.platform_admin','on',false)");
    return (await c.query(text, params)).rows;
  } finally {
    await c.end();
  }
}

export async function stockOf(warehouseId: string, productId: string): Promise<string> {
  const r = await sql<{ qty_on_hand: string }>('SELECT qty_on_hand FROM stock_levels WHERE warehouse_id = $1 AND product_id = $2', [warehouseId, productId]);
  return r[0]?.qty_on_hand ?? '0.0000';
}

/** Journal lines for a source document, as {account code: signed amount (debit +, credit −)}. */
export async function journalFor(sourceType: string, sourceId: string): Promise<Record<string, string>> {
  const rows = await sql<{ code: string; amount: string }>(
    `SELECT a.code, sum(l.debit - l.credit)::numeric(18,2)::text AS amount
       FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id JOIN chart_of_accounts a ON a.id = l.account_id
      WHERE e.source_type = $1 AND e.source_id = $2 GROUP BY a.code ORDER BY a.code`,
    [sourceType, sourceId],
  );
  return Object.fromEntries(rows.map((r) => [r.code, r.amount]));
}
