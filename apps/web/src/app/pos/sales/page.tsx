'use client';
import { useEffect, useState } from 'react';
import { PosShell, usePos } from '@/components/PosShell';
import { Empty, ErrorBox, Field, Loading, Page, Status } from '@/components/ui';
import { qs } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import { useApi } from '@/lib/hooks';

export default function SalesHistoryPage() {
  return (
    <PosShell needRegister={false}>
      <History />
    </PosShell>
  );
}

const PAGE = 50;

function History() {
  const { ctx } = usePos();
  const [f, setF] = useState({ from: ctx.businessDate, to: ctx.businessDate, q: '', status: '', paymentStatus: '', reviewStatus: '', registerId: '', shiftId: '' });
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const preset = { paymentStatus: p.get('paymentStatus') ?? '', reviewStatus: p.get('reviewStatus') ?? '', shiftId: p.get('shiftId') ?? '' };
    if (preset.paymentStatus || preset.reviewStatus || preset.shiftId) setF((x) => ({ ...x, ...preset, from: '', to: '' }));
  }, []);
  const { data, error, loading } = useApi<any[]>(`/pos/sales${qs({ ...f, limit: PAGE, offset })}`);
  const total = Number(data?.[0]?.total_count ?? 0);
  const set = (k: keyof typeof f, v: string) => {
    setOffset(0);
    setF({ ...f, [k]: v });
  };
  return (
    <Page title="Sales history">
      <div className="form-grid">
        <Field label="From"><input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></Field>
        <Field label="To"><input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} /></Field>
        <Field label="Receipt no., customer or phone"><input value={f.q} onChange={(e) => set('q', e.target.value)} /></Field>
        <Field label="Register">
          <select value={f.registerId} onChange={(e) => set('registerId', e.target.value)}>
            <option value="">All</option>
            {ctx.registers.map((r) => <option key={r.id} value={r.id}>{r.code} · {r.name}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select value={f.status} onChange={(e) => set('status', e.target.value)}>
            <option value="">Any</option><option value="COMPLETED">Completed</option><option value="PARTIALLY_REFUNDED">Partly refunded</option><option value="REFUNDED">Refunded</option>
          </select>
        </Field>
        <Field label="Payment">
          <select value={f.paymentStatus} onChange={(e) => set('paymentStatus', e.target.value)}>
            <option value="">Any</option><option value="PAID">Paid</option><option value="PENDING_VERIFICATION">Waiting for verification</option><option value="BALANCE_DUE">Balance due</option>
          </select>
        </Field>
        <Field label="Review">
          <select value={f.reviewStatus} onChange={(e) => set('reviewStatus', e.target.value)}>
            <option value="">Any</option><option value="NEEDS_REVIEW">Needs review</option><option value="REVIEWED">Reviewed</option>
          </select>
        </Field>
      </div>
      <ErrorBox error={error} />
      {loading && !data && <Loading />}
      {data?.length === 0 && <Empty>No sales match.</Empty>}
      {!!data?.length && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Receipt</th><th>Time</th><th>Register</th><th>Cashier</th><th>Customer</th><th>Paid by</th><th className="num">Total</th><th>Status</th></tr>
            </thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.id}>
                  <td><a href={`/pos/sales/view/?id=${s.id}`}>{s.number}</a>{s.is_offline && <span className="badge info" style={{ marginLeft: 4 }}>Offline</span>}</td>
                  <td>{dateTime(s.sold_at)}</td>
                  <td>{s.register_code}</td>
                  <td>{s.cashier_name}</td>
                  <td>{s.customer_name ?? 'Walk-in'}</td>
                  <td>{s.payment_methods}</td>
                  <td className="num">{money(s.grand_total, s.currency)}{Number(s.refunded_total) > 0 && <div className="small muted">−{money(s.refunded_total, s.currency)}</div>}</td>
                  <td>
                    <Status s={s.status} /> {s.payment_status !== 'PAID' && <Status s={s.payment_status} />} {s.review_status === 'NEEDS_REVIEW' && <span className="badge warn">Review</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > PAGE && (
        <div className="row">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
          <span className="small muted">{offset + 1}–{Math.min(offset + PAGE, total)} of {total}</span>
          <button disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</button>
        </div>
      )}
    </Page>
  );
}
