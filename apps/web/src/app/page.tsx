'use client';
import { Authed } from '@/components/Authed';
import { Card, Empty, ErrorBox, Loading, Page, Progress, Stat, Status } from '@/components/ui';
import { ago, human, money, num } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

function Dashboard() {
  const s = useSession();
  const { data: d, error, loading, reload } = useApi(s.online ? '/sales/dashboard' : null);
  if (!s.online) return <Page title="Sales dashboard"><div className="notice warn">You are offline. Orders, visits and collections you record are saved on this device and sent when you reconnect.</div><OfflineSummary /></Page>;
  if (loading && !d) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const c = d.currency;
  return (
    <Page title={`Hello, ${s.me!.fullName.split(' ')[0]}`} subtitle={`${d.scope === 'COMPANY' ? 'Whole company' : d.scope === 'TEAM' ? 'Your team' : 'Your sales'} · updated ${ago(d.asOf)}`} actions={<button onClick={reload}>Refresh</button>}>
      <div className="grid">
        <Stat label="Today’s sales" value={money(d.todaySales, c)} />
        <Stat label="This month" value={money(d.monthSales, c)} />
        <Stat label="Orders submitted" value={d.ordersSubmitted} hint="this month" href="/orders/" />
        <Stat label="Pending approval" value={d.ordersPendingApproval} href={s.can('sales.orders.approve') ? '/approvals/' : '/orders/?status=PENDING_APPROVAL'} />
        <Stat label="Delivered" value={d.deliveredOrders} hint="this month" href="/deliveries/" />
        <Stat label="Assigned customers" value={d.assignedCustomers} href="/customers/" />
        {d.outstandingBalances !== null && <Stat label="Outstanding balances" value={money(d.outstandingBalances, c)} hint={`${money(d.overdueBalances, c)} overdue`} />}
        {d.commissionEstimate !== null && <Stat label="Commission estimate" value={money(d.commissionEstimate, c)} hint="this month" href="/commissions/" />}
        {d.draftOrders > 0 && <Stat label="Draft orders" value={d.draftOrders} hint="not yet submitted" href="/orders/?status=DRAFT" />}
      </div>
      <div className="grid-2">
        <Card title="Monthly targets" actions={<a href="/targets/" className="small">All targets</a>}>
          {d.monthlyTargets.length === 0 ? <Empty>No targets set for this month.</Empty> : (
            <ul className="list">
              {d.monthlyTargets.map((t: any) => (
                <li key={t.id}>
                  <div className="spread small"><b>{human(t.metric)}{t.for && d.scope !== 'OWN' ? ` · ${t.for}` : ''}</b><span>{num(t.actual)} / {num(t.target)} ({t.achievementPercent}%)</span></div>
                  <Progress value={Number(t.achievementPercent)} marker={Number(t.periodElapsedPercent)} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Recent activity">
          {d.recentActivities.length === 0 ? <Empty>Nothing yet.</Empty> : (
            <ul className="list">
              {d.recentActivities.map((a: any, i: number) => (
                <li key={i} className="spread small">
                  <span>
                    <b>{human(a.kind)}</b> {a.reference ?? ''} · {a.customer_name}
                    {a.kind === 'ORDER' && a.entity_id && <> · <a href={`/orders/view/?id=${a.entity_id}`}>open</a></>}
                  </span>
                  <span className="row"><Status s={a.status} /><span className="muted">{ago(a.at)}</span></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Page>
  );
}

function OfflineSummary() {
  const s = useSession();
  const snap = s.snapshot?.data;
  if (!snap) return <div className="muted">No offline data on this device yet.</div>;
  return (
    <div className="grid">
      <Stat label="Customers on device" value={snap.customers.length} href="/customers/" />
      <Stat label="Products on device" value={snap.products.length} href="/catalog/" />
      <Stat label="Waiting to sync" value={s.queue.pending} href="/sync/" />
      <Stat label="Planned visits" value={snap.visits.length} href="/visits/" />
    </div>
  );
}

export default function Home() {
  return <Authed><Dashboard /></Authed>;
}
