'use client';
import { useEffect, useState } from 'react';
import { Authed } from '@/components/Authed';
import { Card, Empty, ErrorBox, Field, Loading, Page, Status } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { dateTime, num } from '@/lib/format';
import { useAction, useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

function Deliveries() {
  const s = useSession();
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setSelected(new URLSearchParams(location.search).get('id')), []);
  const { data, error, loading, reload } = useApi<any[]>(`/sales/deliveries${qs({ status })}`);
  return (
    <Page title="Delivery tracking">
      <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 240 }} aria-label="Status">
        <option value="">All deliveries</option><option value="DISPATCHED">On the road</option><option value="DELIVERED">Delivered</option>
      </select>
      <ErrorBox error={error} />
      <div className="grid-2">
        <div>
          {loading && !data ? <Loading /> : (data ?? []).length === 0 ? <Empty>No deliveries.</Empty> : (
            <div className="card tight">
              <ul className="list">
                {data!.map((d) => (
                  <li key={d.id}>
                    <button className="link" style={{ width: '100%', textAlign: 'left', color: 'inherit', display: 'block' }} onClick={() => setSelected(d.id)}>
                      <div className="spread"><b>{d.number}</b><Status s={d.status} /></div>
                      <div className="small muted">{d.customer_name} · order {d.order_number} · {d.carrier ?? 'no carrier'} {d.vehicle_no ?? ''}</div>
                      <div className="small muted">Dispatched {dateTime(d.dispatched_at)}{d.delivered_at ? ` · delivered ${dateTime(d.delivered_at)}` : ''}</div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {selected && <DeliveryDetail id={selected} canConfirm={s.can('sales.fulfillment.dispatch')} onChange={reload} />}
      </div>
    </Page>
  );
}

function DeliveryDetail({ id, canConfirm, onChange }: { id: string; canConfirm: boolean; onChange: () => void }) {
  const { data: d, error, reload } = useApi(`/sales/deliveries/${id}`);
  const [name, setName] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const act = useAction();
  if (error) return <ErrorBox error={error} />;
  if (!d) return <Loading />;
  async function confirm() {
    const lines = Object.entries(qty).filter(([, v]) => v !== '').map(([orderLineId, quantityDelivered]) => ({ orderLineId, quantityDelivered }));
    const r = await act.run(() => api.post(`/sales/deliveries/${id}/confirm`, { receivedByName: name, lines: lines.length ? lines : undefined }));
    if (r) { reload(); onChange(); }
  }
  return (
    <Card title={`Delivery note ${d.number}`} actions={<Status s={d.status} />}>
      <div className="small">
        <div><b>{d.customer_name}</b> · order <a href={`/orders/view/?id=${d.order_id}`}>{d.order_number}</a></div>
        {d.delivery_address && <div>{d.delivery_address.line1} {d.delivery_address.contact_phone ? `· ${d.delivery_address.contact_phone}` : ''}</div>}
        <div>{d.carrier ?? ''} {d.vehicle_no ?? ''} {d.driver_name ? `· driver ${d.driver_name}` : ''} {d.tracking_reference ? `· ${d.tracking_reference}` : ''}</div>
        <div className="muted">From {d.warehouse_name}, dispatched by {d.dispatched_by_name} {dateTime(d.dispatched_at)}</div>
        {d.received_by_name && <div>Received by {d.received_by_name} {dateTime(d.delivered_at)}</div>}
      </div>
      <table style={{ marginTop: 8 }}>
        <thead><tr><th>Product</th><th className="num">Shipped</th><th className="num">Delivered</th></tr></thead>
        <tbody>
          {d.lines.map((l: any) => (
            <tr key={l.order_line_id}>
              <td>{l.product_name} <span className="muted small">{l.sku}</span></td>
              <td className="num">{num(l.quantity)} {l.unit_code}</td>
              <td className="num">{d.status === 'DISPATCHED' && canConfirm ? <input style={{ width: 80 }} placeholder={num(l.quantity)} value={qty[l.order_line_id] ?? ''} onChange={(e) => setQty({ ...qty, [l.order_line_id]: e.target.value })} /> : num(l.qty_delivered)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {d.status === 'DISPATCHED' && canConfirm && (
        <div className="stack" style={{ marginTop: 10 }}>
          <Field label="Received by"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <div className="muted small">Leave a quantity empty when everything was accepted. Anything not accepted goes back to stock.</div>
          <ErrorBox error={act.error} />
          <button className="primary" disabled={act.busy || !name} onClick={confirm}>Confirm delivery</button>
        </div>
      )}
    </Card>
  );
}
export default function P() {
  return <Authed><Deliveries /></Authed>;
}
