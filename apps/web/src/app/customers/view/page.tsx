'use client';
import { useState } from 'react';
import { Authed } from '@/components/Authed';
import { Card, Empty, ErrorBox, Loading, Page, Status } from '@/components/ui';
import { api } from '@/lib/api';
import { date, dateTime, human, money } from '@/lib/format';
import { useAction, useApi, useQueryParam } from '@/lib/hooks';
import { useSession } from '@/lib/session';

function Profile() {
  const id = useQueryParam('id');
  const s = useSession();
  const { data: c, error, loading, reload } = useApi(id && s.online ? `/sales/customers/${id}` : null);
  const [note, setNote] = useState('');
  const act = useAction();
  const offline = !s.online ? s.snapshot?.data.customers.find((x: any) => x.id === id) : null;
  if (!s.online) {
    if (!offline) return <Empty>This customer is not on the device.</Empty>;
    return (
      <Page title={offline.name} subtitle={`${offline.code} · offline copy`} actions={<a className="btn primary" href={`/orders/new/?customerId=${id}`}>New order</a>}>
        <Card title="Contact">{offline.phone ?? 'No phone'}<div className="muted small">{offline.addresses.map((a: any) => a.line1).join(' · ')}</div></Card>
        {offline.outstanding !== null && <Card title="Balance">{money(offline.outstanding)} outstanding, {money(offline.overdue)} overdue (as of last sync)</Card>}
      </Page>
    );
  }
  if (loading && !c) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!c) return null;
  const cur = c.currency ?? 'USD';
  return (
    <Page
      title={c.name}
      subtitle={<>{c.code}{c.name_local ? ` · ${c.name_local}` : ''} · {human(c.customer_type)} {c.credit_hold && <span className="badge bad">Credit hold</span>}</>}
      actions={<>
        {s.can('sales.orders.create') && <a className="btn primary" href={`/orders/new/?customerId=${c.id}`}>New order</a>}
        {s.can('sales.visits.manage') && <a className="btn" href={`/visits/?customerId=${c.id}&new=1`}>Plan visit</a>}
        {s.can('sales.collections.submit') && <a className="btn" href={`/collections/?customerId=${c.id}&new=1`}>Record payment</a>}
      </>}
    >
      <div className="grid-2">
        <Card title="Profile">
          <dl className="small" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', margin: 0 }}>
            <dt className="muted">Contact</dt><dd style={{ margin: 0 }}>{c.contact_name ?? '–'}</dd>
            <dt className="muted">Phone</dt><dd style={{ margin: 0 }}>{c.phone ? <a href={`tel:${c.phone}`}>{c.phone}</a> : '–'}</dd>
            <dt className="muted">Email</dt><dd style={{ margin: 0 }}>{c.email ?? '–'}</dd>
            <dt className="muted">Group</dt><dd style={{ margin: 0 }}>{c.group_name ?? '–'}</dd>
            <dt className="muted">Price tier</dt><dd style={{ margin: 0 }}>{c.price_list_name ?? 'Default'}</dd>
            <dt className="muted">Payment terms</dt><dd style={{ margin: 0 }}>{c.payment_terms_days} days</dd>
            <dt className="muted">Credit limit</dt><dd style={{ margin: 0 }}>{c.credit_limit === null ? 'No limit' : money(c.credit_limit, cur)}</dd>
            <dt className="muted">Assigned to</dt><dd style={{ margin: 0 }}>{(c.assigned_reps ?? []).map((r: any) => `${r.name} (${human(r.type)})`).join(', ') || '–'}</dd>
          </dl>
        </Card>
        <Card title="Balance">
          {c.balances ? (
            <>
              <div className="grid">
                <div className="stat"><div className="label">Outstanding</div><div className="value">{money(c.balances.outstanding, cur)}</div></div>
                <div className="stat"><div className="label">Overdue</div><div className="value" style={{ color: Number(c.balances.overdue) > 0 ? 'var(--ckh-danger)' : undefined }}>{money(c.balances.overdue, cur)}</div></div>
              </div>
              <h3 style={{ marginTop: 12 }}>Open invoices</h3>
              {c.openInvoices.length === 0 ? <Empty>None.</Empty> : (
                <ul className="list small">{c.openInvoices.map((i: any) => <li key={i.id} className="spread"><span>{i.number} · due {date(i.due_date)}</span><b>{money(i.balance_due, i.currency)}</b></li>)}</ul>
              )}
            </>
          ) : <div className="muted">Balances are hidden by company policy.</div>}
        </Card>
        <Card title="Addresses">
          <ul className="list small">
            {c.addresses.map((a: any) => (
              <li key={a.id}>
                <b>{human(a.address_type)}</b> {a.is_default && <span className="badge">Default</span>} {a.label}
                <div>{a.line1}{a.line2 ? `, ${a.line2}` : ''}{a.location_name ? `, ${a.location_name}` : ''}</div>
                {a.latitude && <a className="small" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${a.latitude}&mlon=${a.longitude}#map=17/${a.latitude}/${a.longitude}`}>Open map</a>}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Order history">
          {c.recentOrders.length === 0 ? <Empty>No orders yet.</Empty> : (
            <ul className="list small">{c.recentOrders.map((o: any) => <li key={o.id} className="spread"><a href={`/orders/view/?id=${o.id}`}>{o.number}</a><span>{date(o.order_date)}</span><Status s={o.status} /><b>{money(o.grand_total, o.currency)}</b></li>)}</ul>
          )}
        </Card>
        <Card title="Payment history">
          {(c.recentPayments ?? []).length === 0 ? <Empty>No verified payments.</Empty> : (
            <ul className="list small">{c.recentPayments.map((p: any) => <li key={p.id} className="spread"><span>{p.number} · {human(p.payment_method)}</span><span>{date(p.receipt_date)}</span><b>{money(p.amount, p.currency)}</b></li>)}</ul>
          )}
        </Card>
        <Card title="Notes">
          <form className="row" onSubmit={async (e) => { e.preventDefault(); if (!note.trim()) return; await act.run(() => api.post(`/sales/customers/${c.id}/notes`, { body: note })); setNote(''); reload(); }}>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note" style={{ flex: 1 }} />
            <button disabled={act.busy}>Add</button>
          </form>
          <ErrorBox error={act.error} />
          <ul className="list small">{c.notes.map((n: any) => <li key={n.id}>{n.body}<div className="muted">{n.author} · {dateTime(n.created_at)}</div></li>)}</ul>
        </Card>
      </div>
    </Page>
  );
}
export default function P() {
  return <Authed><Profile /></Authed>;
}
