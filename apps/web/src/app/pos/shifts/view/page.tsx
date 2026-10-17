'use client';
import { useState } from 'react';
import { P } from '@ckh/shared';
import { PosShell, usePos } from '@/components/PosShell';
import { ApproveShiftSheet } from '@/components/PosShift';
import { Card, ErrorBox, Loading, Page, Status } from '@/components/ui';
import { dateTime, human, money } from '@/lib/format';
import { useApi, useQueryParam } from '@/lib/hooks';

export default function ShiftReportPage() {
  return (
    <PosShell needRegister={false}>
      <ShiftReport />
    </PosShell>
  );
}

/** The shift closing report: printable from the browser. */
function ShiftReport() {
  const id = useQueryParam('id');
  const { can } = usePos();
  const { data: s, error, loading, reload } = useApi(id ? `/pos/shifts/${id}` : null);
  const [approve, setApprove] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (loading || !s) return <Loading />;
  const cur = s.currency;
  return (
    <Page
      title={`Shift ${s.number}`}
      subtitle={`${s.register_name} · ${s.branch_name} · ${s.cashier_name}`}
      actions={
        <>
          <a className="btn" href={`/pos/sales/?shiftId=${s.id}`}>Sales</a>
          <button className="no-print" onClick={() => window.print()}>Print report</button>
          {s.status === 'CLOSED' && can(P.POS_SHIFT_APPROVE) && <button className="primary no-print" onClick={() => setApprove(true)}>Approve</button>}
        </>
      }
    >
      <div className="row"><Status s={s.status === 'CLOSED' ? 'PENDING_APPROVAL' : s.status === 'OPEN' ? 'IN_PROGRESS' : 'APPROVED'} /></div>
      <div className="grid-2">
        <Card title="Cash">
          <div className="kv">
            <span>Opened</span><span>{dateTime(s.opened_at)}</span>
            <span>Closed</span><span>{dateTime(s.closed_at)}{s.closed_by_name ? ` by ${s.closed_by_name}` : ''}</span>
            <span>Opening float</span><span>{money(s.opening_float, cur)}</span>
            {s.cash_summary.map((c: any) => [<span key={`${c.movement_type}l`}>{human(c.movement_type)} ({c.count})</span>, <span key={`${c.movement_type}v`}>{money(c.total, cur)}</span>])}
            <b>Expected in drawer</b><b>{money(s.expected_cash ?? s.expected_cash_now, cur)}</b>
            {s.counted_cash !== null && <><span>Counted</span><span>{money(s.counted_cash, cur)}</span></>}
            {s.cash_difference !== null && <><b>Difference</b><b style={{ color: Number(s.cash_difference) ? 'var(--ckh-danger)' : 'var(--ckh-success)' }}>{money(s.cash_difference, cur)}</b></>}
          </div>
          {s.closing_notes && <div className="small" style={{ marginTop: 6 }}>Cashier: {s.closing_notes}</div>}
          {s.approved_by_name && <div className="small muted">Approved by {s.approved_by_name}, {dateTime(s.approved_at)}{s.approval_notes ? `: ${s.approval_notes}` : ''}</div>}
        </Card>
        <Card title="Sales">
          <div className="kv">
            <span>Receipts</span><span>{s.sales_summary.sale_count}</span>
            <span>Sales (incl. tax)</span><span>{money(s.sales_summary.gross_sales, cur)}</span>
            <span>Discounts</span><span>{money(s.sales_summary.discounts, cur)}</span>
            <span>Tax</span><span>{money(s.sales_summary.tax, cur)}</span>
            <span>Refunds in this shift</span><span>{s.refunds.count} · {money(s.refunds.total, cur)}</span>
          </div>
          <h3 style={{ marginTop: 12 }}>By payment method</h3>
          <div className="kv">
            {s.by_payment_method.map((m: any) => [
              <span key={`${m.code}${m.status}l`}>{m.name}{m.status !== 'CONFIRMED' ? ` (${human(m.status).toLowerCase()})` : ''} · {m.count}</span>,
              <span key={`${m.code}${m.status}v`}>{money(m.amount, cur)}</span>,
            ])}
          </div>
        </Card>
      </div>
      {s.count_details && (
        <Card title="Cash count">
          <div className="kv" style={{ maxWidth: 320 }}>
            {Object.entries(s.count_details as Record<string, number>).map(([d, n]) => [<span key={`${d}l`}>{money(d, cur)} × {n}</span>, <span key={`${d}v`}>{money(Number(d) * n, cur)}</span>])}
          </div>
        </Card>
      )}
      <Card title="Drawer movements">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Type</th><th>Reference</th><th>By</th><th>Reason</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {s.movements.map((m: any) => (
                <tr key={m.id}>
                  <td>{dateTime(m.created_at)}</td>
                  <td>{human(m.movement_type)}</td>
                  <td>{m.reference_type === 'POS_SALE' ? <a href={`/pos/sales/view/?id=${m.reference_id}`}>{m.reference_number}</a> : m.reference_number ?? ''}</td>
                  <td>{m.created_by_name}</td>
                  <td>{m.reason}</td>
                  <td className="num">{money(m.amount, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {approve && <ApproveShiftSheet shift={s} currency={cur} onClose={() => setApprove(false)} onDone={() => { setApprove(false); reload(); }} />}
    </Page>
  );
}
