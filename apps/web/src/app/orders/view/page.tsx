'use client';
import { useState } from 'react';
import { Authed } from '@/components/Authed';
import { Card, Empty, ErrorBox, Loading, Page, Status } from '@/components/ui';
import { api } from '@/lib/api';
import { date, dateTime, human, money, num } from '@/lib/format';
import { useAction, useApi, useQueryParam } from '@/lib/hooks';
import { useSession } from '@/lib/session';

const STEPS = ['DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'STOCK_RESERVED', 'PICKING', 'PACKED', 'DISPATCHED', 'DELIVERED', 'INVOICED', 'CLOSED'];

/** Which button each workflow action becomes, and who may press it. */
const ACTIONS: Record<string, { label: string; path: string; perm: string; ask?: 'comment' | 'reason'; primary?: boolean }> = {
  SUBMIT: { label: 'Submit', path: 'submit', perm: 'sales.orders.create', primary: true },
  APPROVE: { label: 'Approve', path: 'approve', perm: 'sales.orders.approve', primary: true },
  REJECT: { label: 'Reject', path: 'reject', perm: 'sales.orders.approve', ask: 'comment' },
  REVISE: { label: 'Back to draft', path: 'revise', perm: 'sales.orders.create' },
  RESERVE: { label: 'Reserve stock', path: 'reserve', perm: 'sales.fulfillment.reserve', primary: true },
  START_PICKING: { label: 'Start picking', path: 'start-picking', perm: 'sales.fulfillment.pick_pack', primary: true },
  PACK: { label: 'Mark packed', path: 'pack', perm: 'sales.fulfillment.pick_pack', primary: true },
  DISPATCH: { label: 'Dispatch', path: 'dispatch', perm: 'sales.fulfillment.dispatch', primary: true },
  INVOICE: { label: 'Create invoice', path: 'invoice', perm: 'sales.invoices.create', primary: true },
  CLOSE: { label: 'Close order', path: 'close', perm: 'sales.invoices.create' },
  CANCEL: { label: 'Cancel order', path: 'cancel', perm: 'sales.orders.cancel', ask: 'reason' },
};

function OrderView() {
  const id = useQueryParam('id');
  const s = useSession();
  const { data: o, error, loading, reload } = useApi(id ? `/sales/orders/${id}` : null);
  const act = useAction();
  const [done, setDone] = useState<string | null>(null);
  if (!s.online) return <div className="notice warn">Order details need a connection.</div>;
  if (loading && !o) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!o) return null;

  async function run(action: string) {
    const a = ACTIONS[action];
    let body: Record<string, string> = {};
    if (a.ask) {
      const text = prompt(a.ask === 'comment' ? 'Reason for rejecting (shown to the rep)' : 'Reason for cancelling');
      if (!text) return;
      body = { [a.ask]: text };
    }
    const r = await act.run(() => api.post(`/sales/orders/${o.id}/${a.path}`, body));
    if (r !== undefined) {
      setDone(`${a.label}: done`);
      reload();
    }
  }
  const actions = (o.allowedActions as string[]).filter((a) => ACTIONS[a] && s.can(ACTIONS[a].perm));
  const reached = STEPS.indexOf(o.status);
  const c = o.currency;

  return (
    <Page
      title={`Order ${o.number}`}
      subtitle={<>{o.customer_name} · {date(o.order_date)} · {o.sales_rep_name} · <Status s={o.status} /> {o.source !== 'WEB' && <span className="badge">{human(o.source)}</span>}</>}
      actions={actions.map((a) => <button key={a} className={ACTIONS[a].primary ? 'primary' : a === 'CANCEL' || a === 'REJECT' ? 'danger' : ''} disabled={act.busy} onClick={() => run(a)}>{ACTIONS[a].label}</button>)}
    >
      <ErrorBox error={act.error} />
      {done && <div className="notice ok">{done}</div>}
      {o.status === 'PENDING_APPROVAL' && o.approval_requirements?.length > 0 && (
        <div className="notice warn"><b>Needs approval:</b> {o.approval_requirements.map((r: any) => r.detail).join(' · ')}</div>
      )}
      {['REJECTED', 'CANCELLED'].includes(o.status) && o.cancel_reason && <div className="notice bad">{o.cancel_reason}</div>}
      <div className="card tight" style={{ overflowX: 'auto' }}>
        <div className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
          {STEPS.filter((st) => st !== 'SUBMITTED').map((st, i) => (
            <span key={st} className={`badge ${STEPS.indexOf(st) <= reached && reached >= 0 ? 'ok' : ''}`} style={{ opacity: STEPS.indexOf(st) <= reached ? 1 : 0.5 }}>{i + 1}. {human(st)}</span>
          ))}
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Product</th><th className="num">Qty</th><th>Unit</th><th className="num">Price</th><th className="num">Disc</th><th className="num">Tax</th><th className="num">Total</th><th className="num">Reserved</th><th className="num">Delivered</th><th className="num">Invoiced</th></tr></thead>
          <tbody>
            {o.lines.map((l: any) => (
              <tr key={l.id}>
                <td>{l.product_name}<div className="muted small">{l.sku}{Number(l.qty_backordered) > 0 ? ` · ${num(l.qty_backordered)} backordered` : ''}</div></td>
                <td className="num">{num(l.quantity)}</td><td>{l.unit_code}</td><td className="num">{money(l.unit_price, c)}</td>
                <td className="num">{Number(l.discount_percent) ? `${num(l.discount_percent)}%` : '–'}</td><td className="num">{money(l.tax_amount, c)}</td>
                <td className="num"><b>{money(l.line_total, c)}</b></td><td className="num">{num(l.qty_reserved)}</td><td className="num">{num(l.qty_delivered)}</td><td className="num">{num(l.qty_invoiced)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={6} className="num">Subtotal {money(o.subtotal, c)} · Discount −{money(o.discount_total, c)} · Tax {money(o.tax_total, c)}</td><td className="num">{money(o.grand_total, c)}</td><td colSpan={3} /></tr>
          </tfoot>
        </table>
      </div>
      <div className="grid-2">
        <Card title="Delivery">
          <div className="small">
            {o.warehouse_name} · requested {date(o.requested_delivery_date)} · terms {o.payment_terms_days} days
            {o.delivery_address && <div>{o.delivery_address.line1}{o.delivery_address.line2 ? `, ${o.delivery_address.line2}` : ''}</div>}
          </div>
          {o.deliveries.length === 0 ? <Empty>Not dispatched yet.</Empty> : (
            <ul className="list small">{o.deliveries.map((d: any) => <li key={d.id} className="spread"><a href={`/deliveries/?id=${d.id}`}>{d.number}</a><span>{d.carrier ?? ''} {d.tracking_reference ?? ''}</span><Status s={d.status} /><span>{dateTime(d.delivered_at ?? d.dispatched_at)}</span></li>)}</ul>
          )}
        </Card>
        <Card title="Invoices">
          {o.invoices.length === 0 ? <Empty>Not invoiced yet.</Empty> : (
            <ul className="list small">{o.invoices.map((i: any) => <li key={i.id} className="spread"><span>{i.number}</span><span>due {date(i.due_date)}</span><Status s={i.status} /><b>{money(i.grand_total, c)}</b></li>)}</ul>
          )}
        </Card>
        <Card title="Approvals">
          {o.approvals.length === 0 ? <Empty>No approval needed.</Empty> : (
            <ul className="list small">{o.approvals.map((a: any) => <li key={a.id}><b>{human(a.reason)}</b> <Status s={a.status} /><div>{a.detail}</div>{a.decided_by_name && <div className="muted">{a.decided_by_name}: {a.comment}</div>}</li>)}</ul>
          )}
        </Card>
        <Card title="History">
          <ul className="list small">{o.history.map((h: any, i: number) => <li key={i}><b>{human(h.to_status)}</b> <span className="muted">{dateTime(h.created_at)} · {h.actor_name ?? 'System'}</span>{h.comment && <div>{h.comment}</div>}</li>)}</ul>
        </Card>
      </div>
    </Page>
  );
}
export default function P() {
  return <Authed><OrderView /></Authed>;
}
