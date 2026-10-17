'use client';
import { useEffect, useState } from 'react';
import { P } from '@ckh/shared';
import { PosShell, usePos } from '@/components/PosShell';
import { ApproveShiftSheet, CashMovementSheet, CloseShiftSheet, OpenShiftSheet } from '@/components/PosShift';
import { Card, Empty, ErrorBox, Field, Loading, Page, Status } from '@/components/ui';
import { qs } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import { useApi } from '@/lib/hooks';

export default function ShiftsPage() {
  return (
    <PosShell needRegister={false}>
      <Shifts />
    </PosShell>
  );
}

function Shifts() {
  const pos = usePos();
  const { ctx, can } = pos;
  const cur = ctx.currency;
  const [sheet, setSheet] = useState<null | 'open' | 'in' | 'out' | 'close'>(null);
  const [approve, setApprove] = useState<any>(null);
  const [closed, setClosed] = useState<any>(null);
  const [status, setStatus] = useState('');
  useEffect(() => setStatus(new URLSearchParams(location.search).get('status') ?? ''), []);
  const current = useApi(ctx.register ? `/pos/shifts/current${qs({ registerId: ctx.register.id })}` : null);
  const list = useApi<any[]>(`/pos/shifts${qs({ status, limit: 100 })}`);
  const reload = () => {
    current.reload();
    list.reload();
    pos.reload();
  };
  const shift = current.data;
  const mine = shift && shift.cashier_id === ctx.user.id;
  const canClose = shift && can(P.POS_SHIFT_CLOSE) && (mine || can(P.POS_SHIFT_APPROVE));

  return (
    <Page title="Cash shifts">
      {ctx.register && (
        <Card title={`${ctx.register.name}: current shift`}>
          {current.loading && !shift && <Loading />}
          <ErrorBox error={current.error} />
          {!current.loading && !shift && (
            <div className="row">
              <span className="muted">No shift is open on this register.</span>
              {can(P.POS_SALES_CREATE) && <button className="primary" onClick={() => setSheet('open')}>Open shift</button>}
            </div>
          )}
          {shift && (
            <div className="stack">
              <div className="row">
                <b>{shift.number}</b> <span className="muted">{shift.cashier_name} · opened {dateTime(shift.opened_at)}</span>
              </div>
              <div className="kv" style={{ maxWidth: 420 }}>
                <span>Opening float</span><span>{money(shift.opening_float, cur)}</span>
                <span>Sales</span><span>{shift.sales_summary.sale_count} · {money(shift.sales_summary.gross_sales, cur)}</span>
                {(mine || can(P.POS_SHIFT_APPROVE)) && <><span>Cash in drawer now (expected)</span><b>{money(shift.expected_cash_now, cur)}</b></>}
              </div>
              <div className="row">
                {can(P.POS_CASH_DRAWER) && <button onClick={() => setSheet('in')}>Cash in</button>}
                {can(P.POS_CASH_DRAWER) && <button onClick={() => setSheet('out')}>Cash out</button>}
                <a className="btn" href={`/pos/shifts/view/?id=${shift.id}`}>Shift report</a>
                {canClose && <button className="primary" onClick={() => setSheet('close')}>Close shift</button>}
              </div>
            </div>
          )}
        </Card>
      )}
      {closed && (
        <div className={`notice ${Number(closed.cash_difference) === 0 ? 'ok' : 'warn'}`}>
          Shift {closed.number} closed. Expected {money(closed.expected_cash, cur)}, counted {money(closed.counted_cash, cur)}, difference <b>{money(closed.cash_difference, cur)}</b>.
          {closed.warnings?.map((w: any) => <div key={w.code} className="small">{w.message}</div>)}
          <div><a href={`/pos/shifts/view/?id=${closed.id}`}>Open the closing report</a></div>
        </div>
      )}

      <div className="spread">
        <h2 style={{ margin: 0 }}>Shift history</h2>
        <Field label="">
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="">All</option><option value="OPEN">Open</option><option value="CLOSED">Closed, waiting for approval</option><option value="APPROVED">Approved</option>
          </select>
        </Field>
      </div>
      <ErrorBox error={list.error} />
      {list.data?.length === 0 && <Empty>No shifts.</Empty>}
      {!!list.data?.length && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Shift</th><th>Register</th><th>Cashier</th><th>Opened</th><th>Closed</th><th className="num">Sales</th><th className="num">Expected</th><th className="num">Counted</th><th className="num">Difference</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.id}>
                  <td><a href={`/pos/shifts/view/?id=${s.id}`}>{s.number}</a></td>
                  <td>{s.register_code}</td>
                  <td>{s.cashier_name}</td>
                  <td>{dateTime(s.opened_at)}</td>
                  <td>{dateTime(s.closed_at)}</td>
                  <td className="num">{s.sale_count}</td>
                  <td className="num">{money(s.expected_cash ?? s.running_cash, s.currency)}</td>
                  <td className="num">{s.counted_cash ? money(s.counted_cash, s.currency) : '–'}</td>
                  <td className="num" style={{ color: Number(s.cash_difference) ? 'var(--ckh-danger)' : undefined }}>{s.cash_difference ? money(s.cash_difference, s.currency) : '–'}</td>
                  <td><Status s={s.status === 'CLOSED' ? 'PENDING_APPROVAL' : s.status === 'OPEN' ? 'IN_PROGRESS' : 'APPROVED'} /></td>
                  <td>{s.status === 'CLOSED' && can(P.POS_SHIFT_APPROVE) && <button onClick={() => setApprove(s)}>Approve</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sheet === 'open' && ctx.register && <OpenShiftSheet registerId={ctx.register.id} onClose={() => setSheet(null)} onDone={() => { setSheet(null); reload(); }} />}
      {(sheet === 'in' || sheet === 'out') && shift && (
        <CashMovementSheet shiftId={shift.id} type={sheet === 'in' ? 'CASH_IN' : 'CASH_OUT'} onClose={() => setSheet(null)} onDone={() => { setSheet(null); reload(); }} />
      )}
      {sheet === 'close' && shift && <CloseShiftSheet shift={shift} currency={cur} onClose={() => setSheet(null)} onDone={(r) => { setSheet(null); setClosed(r); reload(); }} />}
      {approve && <ApproveShiftSheet shift={approve} currency={cur} onClose={() => setApprove(null)} onDone={() => { setApprove(null); reload(); }} />}
    </Page>
  );
}
