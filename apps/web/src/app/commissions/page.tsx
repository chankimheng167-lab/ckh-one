'use client';
import { useState } from 'react';
import { Authed } from '@/components/Authed';
import { Card, Empty, ErrorBox, Loading, Page, Stat, Status } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { date, human, money, monthStart } from '@/lib/format';
import { useAction, useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

function Commissions() {
  const s = useSession();
  const [month, setMonth] = useState(monthStart().slice(0, 7));
  const periodMonth = `${month}-01`;
  const { data: entries, error, loading, reload } = useApi<any[]>(`/sales/commissions/entries${qs({ periodMonth, limit: 200 })}`);
  const { data: summary, reload: reloadSummary } = useApi<any[]>(`/sales/commissions/summary${qs({ from: periodMonth, to: periodMonth })}`);
  const manage = s.can('sales.commissions.manage');
  const act = useAction();
  const sum = (st?: string) => (entries ?? []).filter((e) => !st || e.status === st).reduce((t, e) => t + Number(e.amount), 0);
  const refresh = () => { reload(); reloadSummary(); };
  return (
    <Page title="Commissions" subtitle="Estimated until approved; approved commission is accrued in the ledger and handed to payroll" actions={<input type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" />}>
      <div className="grid">
        <Stat label="Estimated" value={money(sum('ESTIMATED'))} />
        <Stat label="Approved" value={money(sum('APPROVED'))} />
        <Stat label="Sent to payroll" value={money(sum('SENT_TO_PAYROLL'))} />
        <Stat label="Paid" value={money(sum('PAID'))} />
      </div>
      {manage && (
        <div className="row">
          <button className="primary" disabled={act.busy} onClick={async () => { await act.run(() => api.post('/sales/commissions/approve', { periodMonth })); refresh(); }}>Approve {month}</button>
          <button disabled={act.busy} onClick={async () => { await act.run(() => api.post('/sales/commissions/payroll-batches', { periodMonth })); refresh(); }}>Send approved to payroll</button>
          <button disabled={act.busy} onClick={async () => { const r = await act.run(() => api.post('/sales/commissions/run-clawbacks', {})); if (r) alert(`${r.clawedBack} overdue invoice(s) clawed back`); refresh(); }}>Run overdue clawbacks</button>
        </div>
      )}
      <ErrorBox error={error ?? act.error} />
      {manage && summary && summary.length > 0 && (
        <Card title="By representative">
          <div className="table-wrap"><table>
            <thead><tr>{Object.keys(summary[0]).filter((k) => !k.endsWith('_id')).map((k) => <th key={k}>{human(k)}</th>)}</tr></thead>
            <tbody>{summary.map((r, i) => <tr key={i}>{Object.entries(r).filter(([k]) => !k.endsWith('_id')).map(([k, v]) => <td key={k} className={typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? 'num' : ''}>{String(v ?? '–')}</td>)}</tr>)}</tbody>
          </table></div>
        </Card>
      )}
      <Card title="Entries">
        {loading && !entries ? <Loading /> : (entries ?? []).length === 0 ? <Empty>No commission for this month.</Empty> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Date</th><th>Representative</th><th>Source</th><th>Reference</th><th className="num">Base</th><th className="num">Rate</th><th className="num">Commission</th><th>Status</th></tr></thead>
            <tbody>{entries!.map((e) => (
              <tr key={e.id}><td>{date(e.created_at)}</td><td>{e.rep_name}</td><td>{human(e.source_type)}</td><td>{e.source_number ?? e.notes ?? ''}</td>
                <td className="num">{money(e.base_amount, e.currency)}</td><td className="num">{e.rate_percent ? `${Number(e.rate_percent)}%` : '–'}</td><td className="num"><b>{money(e.amount, e.currency)}</b></td><td><Status s={e.status} /></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </Page>
  );
}
export default function P() {
  return <Authed><Commissions /></Authed>;
}
