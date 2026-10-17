'use client';
import { useEffect, useState } from 'react';
import { Authed } from '@/components/Authed';
import { Empty, ErrorBox, Loading, Page, Status } from '@/components/ui';
import { qs } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { db, type OutboxItem } from '@/lib/db';

const FILTERS = ['', 'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'STOCK_RESERVED', 'DISPATCHED', 'DELIVERED', 'INVOICED', 'CLOSED', 'REJECTED', 'CANCELLED'];

function Orders() {
  const s = useSession();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [queued, setQueued] = useState<OutboxItem[]>([]);
  useEffect(() => setStatus(new URLSearchParams(location.search).get('status') ?? ''), []);
  useEffect(() => {
    db()?.outbox.where('status').anyOf('PENDING', 'SYNCING', 'REJECTED', 'CONFLICT').toArray().then((r) => setQueued(r.filter((x) => x.entityType === 'SALES_ORDER' && x.userId === s.me?.userId)));
  }, [s.me, s.queue]);
  const { data, error, loading } = useApi<any[]>(s.online ? `/sales/orders${qs({ status, search, limit: 100 })}` : null);
  return (
    <Page title="My orders" actions={s.can('sales.orders.create') ? <a className="btn primary" href="/orders/new/">New order</a> : undefined}>
      <div className="form-grid">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          {FILTERS.map((f) => <option key={f} value={f}>{f ? f.replace(/_/g, ' ').toLowerCase() : 'All statuses'}</option>)}
        </select>
        <input placeholder="Order number or customer" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {queued.length > 0 && (
        <div className="card tight">
          <h3>On this device</h3>
          <ul className="list small">{queued.map((q) => <li key={q.idempotencyKey} className="spread"><span>{q.label}</span><span className="row"><Status s={q.status} />{q.lastError && <span className="muted">{q.lastError}</span>}</span></li>)}</ul>
          <a className="small" href="/sync/">Open offline queue</a>
        </div>
      )}
      <ErrorBox error={error} />
      {!s.online ? <div className="notice warn">Order history needs a connection. Queued orders are listed above.</div> : loading && !data ? <Loading /> : (data ?? []).length === 0 ? <Empty>No orders.</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Order</th><th>Date</th><th>Customer</th><th>Representative</th><th>Status</th><th className="num">Total</th></tr></thead>
            <tbody>
              {data!.map((o) => (
                <tr key={o.id}>
                  <td><a href={`/orders/view/?id=${o.id}`}>{o.number}</a> {o.has_backorder && <span className="badge warn">Backorder</span>}</td>
                  <td>{date(o.order_date)}</td><td>{o.customer_name}</td><td>{o.sales_rep_name}</td><td><Status s={o.status} /></td>
                  <td className="num">{money(o.grand_total, o.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
export default function P() {
  return <Authed><Orders /></Authed>;
}
