import { api } from './api';
import { db, newKey, type OutboxItem, type Snapshot } from './db';

/** Downloads customers, catalogue, stock and prices for offline use. */
export async function refreshSnapshot(userId: string): Promise<Snapshot> {
  const data = await api.get('/sales/sync/bootstrap');
  const snap: Snapshot = { id: 'current', userId, snapshotAt: data.snapshotAt, staleAfter: data.staleAfter, maxAgeHours: data.maxAgeHours, data };
  await db()?.snapshot.put(snap);
  return snap;
}

export async function loadSnapshot(userId: string): Promise<Snapshot | null> {
  const s = await db()?.snapshot.get('current');
  return s && s.userId === userId ? s : null;
}

/** Stock and prices older than the company's limit are shown as stale. */
export function isStale(s: Pick<Snapshot, 'staleAfter'> | null | undefined) {
  return !s || new Date(s.staleAfter).getTime() < Date.now();
}

export async function enqueue(userId: string, item: Pick<OutboxItem, 'entityType' | 'payload' | 'label'> & { idempotencyKey?: string }) {
  const row: OutboxItem = {
    idempotencyKey: item.idempotencyKey ?? newKey(),
    entityType: item.entityType,
    payload: item.payload,
    label: item.label,
    clientCreatedAt: new Date().toISOString(),
    status: 'PENDING',
    attempts: 0,
    userId,
  };
  await db()?.outbox.put(row);
  return row;
}

let running: Promise<{ sent: number }> | null = null;

/**
 * Sends queued items in creation order. Items keep their key across retries,
 * so the server never creates a duplicate; only network or temporary failures
 * leave an item PENDING.
 */
export function flushOutbox(userId: string): Promise<{ sent: number }> {
  if (running) return running;
  running = (async () => {
    const d = db();
    if (!d) return { sent: 0 };
    const pending = (await d.outbox.where('status').anyOf('PENDING', 'SYNCING').toArray())
      .filter((i) => i.userId === userId)
      .sort((a, b) => a.clientCreatedAt.localeCompare(b.clientCreatedAt));
    if (!pending.length) return { sent: 0 };
    const snap = await loadSnapshot(userId);
    let sent = 0;
    for (let i = 0; i < pending.length; i += 50) {
      const batch = pending.slice(i, i + 50);
      await d.outbox.bulkPut(batch.map((b) => ({ ...b, status: 'SYNCING' as const, attempts: b.attempts + 1 })));
      try {
        const res = await api.post('/sales/sync', {
          deviceId: deviceId(),
          catalogSnapshotAt: snap?.snapshotAt,
          events: batch.map((b) => ({ idempotencyKey: b.idempotencyKey, entityType: b.entityType, clientCreatedAt: b.clientCreatedAt, payload: b.payload })),
        });
        for (const r of res.results) {
          const item = batch.find((b) => b.idempotencyKey === r.idempotencyKey)!;
          const status = r.status === 'RETRY' ? 'PENDING' : r.status;
          await d.outbox.put({ ...item, attempts: item.attempts + 1, status, result: r, lastError: r.error?.message });
          if (status !== 'PENDING') sent += 1;
        }
      } catch (e) {
        await d.outbox.bulkPut(batch.map((b) => ({ ...b, status: 'PENDING' as const, attempts: b.attempts + 1, lastError: (e as Error).message })));
        break;
      }
    }
    return { sent };
  })().finally(() => {
    running = null;
  });
  return running;
}

export async function outboxCounts(userId: string) {
  const all = (await db()?.outbox.toArray())?.filter((i) => i.userId === userId) ?? [];
  return {
    pending: all.filter((i) => i.status === 'PENDING' || i.status === 'SYNCING').length,
    problems: all.filter((i) => i.status === 'REJECTED' || i.status === 'CONFLICT').length,
  };
}

function deviceId() {
  try {
    let id = localStorage.getItem('ckh.device');
    if (!id) {
      id = newKey();
      localStorage.setItem('ckh.device', id);
    }
    return id;
  } catch {
    return 'web-unknown';
  }
}
