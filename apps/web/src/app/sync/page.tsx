'use client';
import { useEffect, useState } from 'react';
import { Authed } from '@/components/Authed';
import { Card, Empty, Page, StaleBadge, Status } from '@/components/ui';
import { db, type OutboxItem } from '@/lib/db';
import { dateTime, human } from '@/lib/format';
import { useSession } from '@/lib/session';
import { flushOutbox } from '@/lib/sync';

function SyncQueue() {
  const s = useSession();
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [queuedMsg, setQueuedMsg] = useState(false);
  const load = async () => setItems(((await db()?.outbox.toArray()) ?? []).filter((i) => i.userId === s.me?.userId).sort((a, b) => b.clientCreatedAt.localeCompare(a.clientCreatedAt)));
  useEffect(() => { void load(); setQueuedMsg(new URLSearchParams(location.search).has('queued')); }, [s.queue]); // eslint-disable-line react-hooks/exhaustive-deps

  async function syncNow() {
    setBusy(true);
    await s.syncNow();
    await load();
    setBusy(false);
  }
  async function retry(i: OutboxItem) {
    // A rejected item keeps its result on the server; retrying needs a new key so the server re-checks it.
    await db()?.outbox.delete(i.idempotencyKey);
    await db()?.outbox.put({ ...i, idempotencyKey: `${i.idempotencyKey}-r${i.attempts}`, status: 'PENDING', result: undefined, lastError: undefined });
    await flushOutbox(s.me!.userId);
    await s.refreshQueue();
    await load();
  }
  async function discard(i: OutboxItem) {
    if (!confirm('Remove this item from the device? It will not be sent.')) return;
    await db()?.outbox.delete(i.idempotencyKey);
    await s.refreshQueue();
    await load();
  }
  return (
    <Page title="Offline queue" subtitle="Orders, visits and payments recorded on this device" actions={<>
      <StaleBadge />
      <button className="primary" disabled={!s.online || busy} onClick={syncNow}>{busy ? 'Syncing…' : 'Sync now'}</button>
    </>}>
      {queuedMsg && items.some((i) => i.status === 'PENDING') && <div className="notice ok">Saved on this device. It will be sent and checked by the server as soon as you are online.</div>}
      {!s.online && <div className="notice warn">You are offline. Items will be sent automatically when the connection returns.</div>}
      <Card title="Offline data">
        <div className="small">
          {s.snapshot ? <>Downloaded {dateTime(s.snapshot.snapshotAt)}: {s.snapshot.data.customers.length} customers, {s.snapshot.data.products.length} products. Treated as stale after {s.snapshot.maxAgeHours} hours.</> : 'Nothing downloaded yet.'}
        </div>
      </Card>
      {items.length === 0 ? <Empty>Nothing waiting.</Empty> : (
        <div className="card tight">
          <ul className="list">
            {items.map((i) => (
              <li key={i.idempotencyKey}>
                <div className="spread"><b>{i.label}</b><Status s={i.status} /></div>
                <div className="small muted">{human(i.entityType)} · recorded {dateTime(i.clientCreatedAt)}{i.attempts ? ` · ${i.attempts} attempt(s)` : ''}</div>
                {i.result?.number && <div className="small">Created {i.result.number}{i.result.entityType === 'SALES_ORDER' && i.result.entityId && <> · <a href={`/orders/view/?id=${i.result.entityId}`}>open</a></>}</div>}
                {i.result?.changes?.map((c: any) => <div key={c.code} className="notice warn small" style={{ marginTop: 4 }}>{c.message}</div>)}
                {i.lastError && <div className="notice bad small" style={{ marginTop: 4 }}>{i.lastError}</div>}
                {['REJECTED', 'CONFLICT'].includes(i.status) && (
                  <div className="row" style={{ marginTop: 6 }}><button onClick={() => retry(i)} disabled={!s.online}>Try again</button><button className="danger" onClick={() => discard(i)}>Discard</button></div>
                )}
                {['ACCEPTED', 'ACCEPTED_WITH_CHANGES'].includes(i.status) && <button className="link small" onClick={() => discard(i)}>Clear</button>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Page>
  );
}
export default function P() {
  return <Authed><SyncQueue /></Authed>;
}
