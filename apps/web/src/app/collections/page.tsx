'use client';
import { useEffect, useState } from 'react';
import { Authed } from '@/components/Authed';
import { Card, Empty, ErrorBox, Field, Loading, Page, Status } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { newKey } from '@/lib/db';
import { date, human, money } from '@/lib/format';
import { useAction, useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { enqueue } from '@/lib/sync';

const METHODS = ['CASH', 'BANK_TRANSFER', 'KHQR', 'MOBILE_WALLET', 'CHEQUE', 'CARD', 'OTHER'];

function Collections() {
  const s = useSession();
  const [status, setStatus] = useState('');
  const [show, setShow] = useState(false);
  const [customerId, setCustomerId] = useState('');
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    setShow(!!p.get('new'));
    setCustomerId(p.get('customerId') ?? '');
    if (!p.get('new') && s.can('sales.collections.verify')) setStatus('PENDING_VERIFICATION');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { data, error, loading, reload } = useApi<any[]>(s.online ? `/sales/collections${qs({ status, limit: 100 })}` : null);
  const act = useAction();
  const canVerify = s.can('sales.collections.verify');

  async function verify(id: string, ok: boolean) {
    const reason = ok ? undefined : prompt('Why is this payment rejected? (e.g. no matching bank transfer)');
    if (!ok && !reason) return;
    await act.run(() => api.post(`/sales/collections/${id}/${ok ? 'verify' : 'reject'}`, ok ? { comment: 'Verified' } : { reason }));
    reload();
  }
  return (
    <Page title="Payment collections" subtitle="Payments collected in the field count only after an accountant verifies them" actions={s.can('sales.collections.submit') ? <button className="primary" onClick={() => setShow(!show)}>Record payment</button> : undefined}>
      {show && <NewCollection customerId={customerId} onDone={() => { setShow(false); reload(); }} />}
      <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 260 }} aria-label="Status">
        <option value="">All</option><option value="PENDING_VERIFICATION">Waiting for verification</option><option value="VERIFIED">Verified</option><option value="REJECTED">Rejected</option>
      </select>
      <ErrorBox error={error ?? act.error} />
      {!s.online ? <div className="notice warn">Collection history needs a connection. Payments you record now are queued.</div> : loading && !data ? <Loading /> : (data ?? []).length === 0 ? <Empty>No collections.</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Number</th><th>Date</th><th>Customer</th><th>Invoice</th><th>Method</th><th>Rep</th><th>Status</th><th className="num">Amount</th>{canVerify && <th />}</tr></thead>
            <tbody>
              {data!.map((c) => (
                <tr key={c.id}>
                  <td>{c.number}</td><td>{date(c.collected_on ?? c.created_at)}</td><td>{c.customer_name}</td><td>{c.invoice_number ?? '–'}</td>
                  <td>{human(c.payment_method)}{c.payment_reference ? ` · ${c.payment_reference}` : ''}</td><td>{c.sales_rep_name}</td>
                  <td><Status s={c.status} />{c.rejection_reason && <div className="small muted">{c.rejection_reason}</div>}</td>
                  <td className="num">{money(c.amount, c.currency)}</td>
                  {canVerify && <td>{c.status === 'PENDING_VERIFICATION' && <span className="row"><button className="primary" disabled={act.busy} onClick={() => verify(c.id, true)}>Verify</button><button className="danger" disabled={act.busy} onClick={() => verify(c.id, false)}>Reject</button></span>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

function NewCollection({ customerId, onDone }: { customerId: string; onDone: () => void }) {
  const s = useSession();
  const [f, setF] = useState({ customerId, invoiceId: '', amount: '', paymentMethod: 'CASH', paymentReference: '', collectedOn: new Date().toISOString().slice(0, 10), notes: '' });
  const [clientReference] = useState(newKey);
  const act = useAction();
  const { data: customers } = useApi<any[]>(s.online ? '/sales/customers?limit=200' : null);
  const { data: profile } = useApi(s.online && f.customerId ? `/sales/customers/${f.customerId}` : null);
  const list = customers ?? s.snapshot?.data.customers ?? [];
  const invoices: any[] = profile?.openInvoices ?? [];
  async function save() {
    const body = { customerId: f.customerId, invoiceId: f.invoiceId || undefined, amount: f.amount, paymentMethod: f.paymentMethod, paymentReference: f.paymentReference || undefined, collectedOn: f.collectedOn, notes: f.notes || undefined };
    if (!s.online) {
      await enqueue(s.me!.userId, { entityType: 'COLLECTION', label: `Payment ${f.amount} from ${list.find((c: any) => c.id === f.customerId)?.name}`, payload: body });
      await s.refreshQueue();
      return onDone();
    }
    if (await act.run(() => api.post('/sales/collections', { ...body, clientReference }))) onDone();
  }
  return (
    <Card title="Record a payment">
      <div className="form-grid">
        <Field label="Customer"><select value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value, invoiceId: '' })}><option value="">Choose…</option>{list.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Invoice (optional)">
          <select value={f.invoiceId} onChange={(e) => { const inv = invoices.find((i) => i.id === e.target.value); setF({ ...f, invoiceId: e.target.value, amount: inv ? inv.balance_due : f.amount }); }}>
            <option value="">Oldest invoices first</option>
            {invoices.map((i) => <option key={i.id} value={i.id}>{i.number} · {money(i.balance_due, i.currency)} due {date(i.due_date)}</option>)}
          </select>
        </Field>
        <Field label="Amount"><input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Method"><select value={f.paymentMethod} onChange={(e) => setF({ ...f, paymentMethod: e.target.value })}>{METHODS.map((m) => <option key={m} value={m}>{human(m)}</option>)}</select></Field>
        <Field label="Reference"><input placeholder="Bank / KHQR reference" value={f.paymentReference} onChange={(e) => setF({ ...f, paymentReference: e.target.value })} /></Field>
        <Field label="Collected on"><input type="date" value={f.collectedOn} onChange={(e) => setF({ ...f, collectedOn: e.target.value })} /></Field>
      </div>
      <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <ErrorBox error={act.error} />
      <button className="primary" style={{ marginTop: 10 }} disabled={!f.customerId || !Number(f.amount) || act.busy} onClick={save}>{s.online ? 'Submit for verification' : 'Queue payment'}</button>
    </Card>
  );
}
export default function P() {
  return <Authed><Collections /></Authed>;
}
