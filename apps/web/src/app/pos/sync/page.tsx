'use client';
import { useEffect, useState } from 'react';
import { P } from '@ckh/shared';
import { PosShell, usePos } from '@/components/PosShell';
import { Empty, ErrorBox, Loading, Page } from '@/components/ui';
import { qs } from '@/lib/api';
import { desktopOffline, type OfflineEvent, uploadQueue } from '@/lib/device';
import { dateTime, human, money } from '@/lib/format';
import { useAction, useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

export default function SyncPage() {
  return (
    <PosShell needRegister={false}>
      <Sync />
    </PosShell>
  );
}

const STATUS_BADGE: Record<string, string> = { ACCEPTED: 'ok', ACCEPTED_WITH_CHANGES: 'warn', REJECTED: 'bad', CONFLICT: 'bad' };

function Sync() {
  const { can, ctx } = usePos();
  const [filter, setFilter] = useState<{ deviceId?: string; status?: string }>({});
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    setFilter({ deviceId: p.get('deviceId') ?? undefined, status: p.get('status') ?? undefined });
  }, []);
  const manage = can(P.POS_DEVICES_MANAGE);
  const ev = useApi<any[]>(manage ? `/pos/sync/events${qs({ ...filter, limit: 200 })}` : null);
  return (
    <Page title="Offline sync" subtitle="Sales recorded on Windows tills while offline, and what the server did with each.">
      <LocalQueue currency={ctx.currency} />
      {manage && (
        <>
          <h2>Uploaded from devices</h2>
          <div className="row">
            {['', 'ACCEPTED', 'ACCEPTED_WITH_CHANGES', 'REJECTED', 'CONFLICT'].map((s) => (
              <button key={s} className={(filter.status ?? '') === s ? 'primary' : ''} onClick={() => setFilter((f) => ({ ...f, status: s || undefined }))}>
                {s ? human(s) : 'All'}
              </button>
            ))}
            {filter.deviceId && <button className="link" onClick={() => setFilter((f) => ({ ...f, deviceId: undefined }))}>All devices</button>}
          </div>
          <ErrorBox error={ev.error} />
          {ev.loading && !ev.data && <Loading />}
          {ev.data?.length === 0 && <Empty>No offline sales uploaded{filter.status ? ' with this result' : ''}.</Empty>}
          {!!ev.data?.length && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Sold at</th><th>Received</th><th>Device</th><th>Cashier</th><th>Result</th><th>Sale</th><th>Details</th></tr></thead>
                <tbody>
                  {ev.data.map((e) => (
                    <tr key={e.id}>
                      <td>{dateTime(e.client_created_at)}</td>
                      <td>{dateTime(e.received_at)}</td>
                      <td>{e.device_name}</td>
                      <td>{e.cashier_name}</td>
                      <td><span className={`badge ${STATUS_BADGE[e.status] ?? ''}`}>{human(e.status)}</span></td>
                      <td>{e.resulting_sale_id ? <a href={`/pos/sales/view/?id=${e.resulting_sale_id}`}>{e.sale_number}</a> : '–'}</td>
                      <td className="small">
                        {e.result?.error?.message}
                        {(e.result?.reviewReasons ?? []).map((r: any) => <div key={r.code}>{r.message ?? human(r.code)}</div>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Page>
  );
}

/** Sales queued on this computer (Windows app only). */
function LocalQueue({ currency }: { currency: string }) {
  const s = useSession();
  const d = desktopOffline();
  const [queue, setQueue] = useState<OfflineEvent[] | null>(null);
  const [refused, setRefused] = useState<any[]>([]);
  const act = useAction();
  const [note, setNote] = useState<string | null>(null);
  const load = async () => {
    if (!d) return;
    setQueue(await d.offline.queue());
    setRefused(await d.offline.refused());
  };
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return null;
  async function upload() {
    const r = await act.run(() => uploadQueue(s.me!.userId));
    if (r) setNote(`Uploaded ${r.sent}; ${r.left} still waiting.`);
    await load();
  }
  const others = (queue ?? []).filter((e) => e.userId !== s.me?.userId).length;
  return (
    <div className="card stack" data-testid="local-queue">
      <h2 style={{ margin: 0 }}>On this computer</h2>
      {queue === null ? <Loading /> : queue.length === 0 ? <Empty>No offline sales waiting to upload.</Empty> : (
        <>
          <div>{queue.length} sale{queue.length === 1 ? '' : 's'} waiting to upload{others ? `, ${others} by other cashiers (they upload when that cashier signs in)` : ''}.</div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Sold at</th><th className="num">Total</th><th>Items</th></tr></thead>
              <tbody>
                {queue.map((e) => (
                  <tr key={e.idempotencyKey}><td>{dateTime(e.clientCreatedAt)}</td><td className="num">{money(e.deviceTotal, currency)}</td><td>{e.sale.lines.length}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row"><button className="primary" disabled={act.busy} onClick={upload}>Upload my sales now</button>{note && <span>{note}</span>}</div>
        </>
      )}
      <ErrorBox error={act.error} />
      {refused.length > 0 && (
        <div className="notice warn small">
          {refused.length} offline sale{refused.length === 1 ? ' was' : 's were'} refused by the server and not recorded:{' '}
          {refused.slice(0, 5).map((r) => `${dateTime(r.clientCreatedAt)} ${money(r.deviceTotal, currency)} (${r.error?.message ?? human(r.status)})`).join('; ')}
        </div>
      )}
    </div>
  );
}
