'use client';
import { useState } from 'react';
import { P } from '@ckh/shared';
import { PosShell, usePos } from '@/components/PosShell';
import { CashMovementSheet } from '@/components/PosShift';
import { Empty, ErrorBox, Loading, Page, Stat } from '@/components/ui';
import { qs } from '@/lib/api';
import { dateTime, human, money } from '@/lib/format';
import { useApi } from '@/lib/hooks';

export default function CashMovementsPage() {
  return (
    <PosShell>
      <Cash />
    </PosShell>
  );
}

/** Every movement of the drawer in the open shift (float, sales, refunds, cash in/out). Movements cannot be edited or deleted. */
function Cash() {
  const { ctx, can } = usePos();
  const cur = ctx.currency;
  const { data: s, error, loading, reload } = useApi(`/pos/shifts/current${qs({ registerId: ctx.register!.id })}`);
  const [type, setType] = useState<'CASH_IN' | 'CASH_OUT' | null>(null);
  return (
    <Page
      title="Cash movements"
      subtitle={s ? `Shift ${s.number} · ${s.cashier_name}` : ctx.register!.name}
      actions={s && can(P.POS_CASH_DRAWER) ? <><button onClick={() => setType('CASH_IN')}>Cash in</button><button onClick={() => setType('CASH_OUT')}>Cash out</button></> : undefined}
    >
      <ErrorBox error={error} />
      {loading && !s && <Loading />}
      {!loading && !s && <Empty>No shift is open on this register. <a href="/pos/shifts/">Open one</a>.</Empty>}
      {s && (
        <>
          <div className="grid">
            {s.cash_summary.map((c: any) => <Stat key={c.movement_type} label={human(c.movement_type)} value={money(c.total, cur)} hint={`${c.count} movement(s)`} />)}
            {(s.cashier_id === ctx.user.id || can(P.POS_SHIFT_APPROVE)) && <Stat label="Expected in drawer" value={money(s.expected_cash_now, cur)} />}
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Time</th><th>Type</th><th>Reference</th><th>By</th><th>Reason</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {[...s.movements].reverse().map((m: any) => (
                  <tr key={m.id}>
                    <td>{dateTime(m.created_at)}</td>
                    <td>{human(m.movement_type)}</td>
                    <td>{m.reference_number ?? ''}</td>
                    <td>{m.created_by_name}</td>
                    <td>{m.reason}</td>
                    <td className="num" style={{ color: Number(m.amount) < 0 ? 'var(--ckh-danger)' : undefined }}>{money(m.amount, cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {type && s && <CashMovementSheet shiftId={s.id} type={type} onClose={() => setType(null)} onDone={() => { setType(null); reload(); }} />}
    </Page>
  );
}
