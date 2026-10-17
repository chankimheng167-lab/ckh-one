'use client';
import { useState } from 'react';
import { P } from '@ckh/shared';
import { PosShell, usePos } from '@/components/PosShell';
import { Card, Empty, ErrorBox, Field, Loading, Page } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import { useAction, useApi } from '@/lib/hooks';

export default function ReturnsPage() {
  return (
    <PosShell needRegister={false}>
      <Returns />
    </PosShell>
  );
}

function Returns() {
  const { ctx, can } = usePos();
  const [number, setNumber] = useState('');
  const [f, setF] = useState({ from: ctx.businessDate, to: ctx.businessDate, q: '' });
  const list = useApi<any[]>(`/pos/returns${qs({ ...f, limit: 100 })}`);
  const act = useAction();
  async function find() {
    const r = await act.run(() => api.get(`/pos/sales/by-number/${encodeURIComponent(number.trim())}`));
    if (!r) return;
    if (!r.found) act.setError(`No sale with receipt number ${number.trim()}`);
    else location.href = `/pos/returns/new/?saleId=${r.sale.id}`;
  }
  return (
    <Page title="Returns and refunds">
      {can(P.POS_SALES_CREATE) && (
        <Card title="Start a return">
          <div className="row">
            <input
              style={{ maxWidth: 320 }}
              autoFocus
              placeholder="Scan or type the receipt number"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && number.trim() && find()}
            />
            <button className="primary" disabled={!number.trim() || act.busy} onClick={find}>Find sale</button>
            <a href="/pos/sales/">Search sales history</a>
          </div>
          <ErrorBox error={act.error} />
          {!can(P.POS_REFUNDS_CREATE) && <div className="small muted" style={{ marginTop: 6 }}>A supervisor approves each refund with their PIN.</div>}
        </Card>
      )}
      <div className="form-grid">
        <Field label="From"><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label="To"><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        <Field label="Return or sale number"><input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></Field>
      </div>
      <ErrorBox error={list.error} />
      {list.loading && !list.data && <Loading />}
      {list.data?.length === 0 && <Empty>No returns in this period.</Empty>}
      {!!list.data?.length && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Return</th><th>Time</th><th>Sale</th><th>Register</th><th>By</th><th>Approved by</th><th>Refunded to</th><th>Reason</th><th className="num">Refund</th></tr></thead>
            <tbody>
              {list.data.map((r) => (
                <tr key={r.id}>
                  <td><a href={`/pos/returns/view/?id=${r.id}`}>{r.number}</a></td>
                  <td>{dateTime(r.created_at)}</td>
                  <td><a href={`/pos/sales/view/?id=${r.sale_id}`}>{r.sale_number}</a></td>
                  <td>{r.register_code}</td>
                  <td>{r.processed_by_name}</td>
                  <td>{r.approved_by_name ?? ''}</td>
                  <td>{r.refund_methods}</td>
                  <td>{r.reason}</td>
                  <td className="num">{money(r.refund_total, r.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
