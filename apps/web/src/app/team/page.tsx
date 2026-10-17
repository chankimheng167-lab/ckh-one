'use client';
import { useState } from 'react';
import { Authed } from '@/components/Authed';
import { ErrorBox, Loading, Page, Progress, Stat } from '@/components/ui';
import { qs } from '@/lib/api';
import { money, monthStart, num, today } from '@/lib/format';
import { useApi } from '@/lib/hooks';

function Team() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const { data, error, loading } = useApi(`/sales/team-performance${qs({ from, to })}`);
  return (
    <Page title="Team performance" actions={<><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" /><input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" /></>}>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : data && (
        <>
          <div className="grid">
            <Stat label="Net sales" value={money(data.totals.netSales)} />
            <Stat label="Orders submitted" value={data.totals.ordersSubmitted} />
            <Stat label="Waiting approval" value={data.totals.ordersPending} href="/approvals/" />
            <Stat label="Visits completed" value={data.totals.visitsCompleted} />
            <Stat label="Collections verified" value={money(data.totals.collectionsVerified)} />
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Representative</th><th>Team</th><th className="num">Net sales</th><th style={{ minWidth: 140 }}>Target</th><th className="num">Orders</th><th className="num">Approved</th><th className="num">Avg disc.</th><th className="num">Visits</th><th className="num">Missed</th><th className="num">Collected</th><th className="num">Unverified</th></tr></thead>
              <tbody>
                {data.reps.map((r: any) => (
                  <tr key={r.sales_rep_id}>
                    <td><b>{r.rep_name}</b> <span className="muted small">{r.employee_code}</span></td><td>{r.team_name ?? '–'}</td>
                    <td className="num">{money(r.net_sales)}</td>
                    <td>{r.net_sales_target ? <><Progress value={Number(r.target_achievement_percent)} /><span className="small">{r.target_achievement_percent}% of {money(r.net_sales_target)}</span></> : <span className="muted small">no target</span>}</td>
                    <td className="num">{r.orders_submitted}</td><td className="num">{r.orders_approved}</td><td className="num">{num(r.avg_discount_percent)}%</td>
                    <td className="num">{r.visits_completed}</td><td className="num">{r.visits_missed}</td>
                    <td className="num">{money(r.collections_verified)}</td><td className="num">{money(r.collections_pending)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Page>
  );
}
export default function P() {
  return <Authed><Team /></Authed>;
}
