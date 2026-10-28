'use client';
import { P } from '@ckh/shared';
import { PosShell, usePos } from '@/components/PosShell';
import { Card, Empty, ErrorBox, Loading, Stat } from '@/components/ui';
import { qs } from '@/lib/api';
import { dateTime, money, num } from '@/lib/format';
import { useApi } from '@/lib/hooks';

export default function PosDashboardPage() {
  return (
    <PosShell needRegister={false}>
      <Dashboard />
    </PosShell>
  );
}

function Dashboard() {
  const { ctx, can } = usePos();
  const cur = ctx.currency;
  const { data: d, error, loading } = useApi(`/pos/dashboard${qs({ registerId: ctx.register?.id })}`);
  return (
    <div className="stack">
      <div className="spread">
        <div>
          <h1>POS today</h1>
          <div className="muted small">{ctx.register ? `${ctx.register.name}, ${ctx.register.branch_name}` : 'All registers'} · {ctx.businessDate}</div>
        </div>
        {can(P.POS_SALES_CREATE) && <a className="btn primary" style={{ minHeight: 52, padding: '0 28px' }} href="/pos/sell/">Start selling</a>}
      </div>
      <ErrorBox error={error} />
      {loading && !d && <Loading />}
      {d && (
        <>
          <div className="grid">
            <Stat label="Sales" value={money(d.totals.total, cur)} hint={`${d.totals.sale_count} receipts`} href="/pos/sales/" />
            <Stat label="Average sale" value={money(d.totals.average_sale, cur)} />
            <Stat label="Discounts given" value={money(d.totals.discounts, cur)} />
            <Stat label="Refunded" value={money(d.totals.refunded, cur)} href="/pos/returns/" />
            {d.pendingPayments && <Stat label="Payments to verify" value={d.pendingPayments.count} hint={money(d.pendingPayments.amount, cur)} href="/pos/sales/?paymentStatus=PENDING_VERIFICATION" />}
            {d.shiftsToApprove && <Stat label="Shifts to approve" value={d.shiftsToApprove.count} href="/pos/shifts/?status=CLOSED" />}
            {d.salesToReview && <Stat label="Offline sales to review" value={d.salesToReview.count} href="/pos/sales/?reviewStatus=NEEDS_REVIEW" />}
          </div>
          <div className="grid-2">
            <Card title="By payment method">
              {d.byMethod.length === 0 ? <Empty>No payments yet today.</Empty> : (
                <div className="kv">{d.byMethod.map((m: any) => [<span key={`${m.name}l`}>{m.name} <span className="muted small">({m.count})</span></span>, <span key={`${m.name}v`}>{money(m.amount, cur)}</span>])}</div>
              )}
            </Card>
            <Card title="Open shifts">
              {d.openShifts.length === 0 ? <Empty>No shift is open.</Empty> : (
                <ul className="list">
                  {d.openShifts.map((s: any) => (
                    <li key={s.id}>
                      <a href={`/pos/shifts/view/?id=${s.id}`}>{s.register_name}</a> · {s.cashier_name}
                      <div className="small muted">Since {dateTime(s.opened_at)} · cash expected {money(s.expected_cash, cur)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Top products today">
              {d.topProducts.length === 0 ? <Empty>No sales yet today.</Empty> : (
                <table><tbody>{d.topProducts.map((p: any) => (
                  <tr key={p.product_id}><td>{p.description}</td><td className="num">{num(p.quantity)}</td><td className="num">{money(p.amount, cur)}</td></tr>
                ))}</tbody></table>
              )}
            </Card>
            <Card title="Low stock">
              {d.lowStock.length === 0 ? <Empty>Nothing at or below its reorder point.</Empty> : (
                <table><tbody>{d.lowStock.map((p: any) => (
                  <tr key={`${p.id}${p.warehouse}`}><td>{p.name}<div className="small muted">{p.sku} · {p.warehouse}</div></td><td className="num">{num(p.qty_on_hand)} / {num(p.reorder_point)}</td></tr>
                ))}</tbody></table>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
