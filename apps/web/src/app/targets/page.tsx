'use client';
import { useState } from 'react';
import { Authed } from '@/components/Authed';
import { Card, Empty, ErrorBox, Field, Loading, Page, Progress } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { date, human, monthStart, num, today } from '@/lib/format';
import { useAction, useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

const METRICS = ['NET_SALES', 'COLLECTIONS', 'ORDER_COUNT', 'QUANTITY', 'NEW_CUSTOMERS', 'VISITS'];

function Targets() {
  const s = useSession();
  const [on, setOn] = useState(today());
  const { data, error, loading, reload } = useApi<any[]>(`/sales/targets${qs({ on })}`);
  const manage = s.can('sales.targets.manage');
  return (
    <Page title="Sales targets" actions={<input type="date" value={on} onChange={(e) => setOn(e.target.value)} aria-label="Targets active on" />}>
      {manage && <NewTarget onDone={reload} />}
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : (data ?? []).length === 0 ? <Empty>No targets for this date.</Empty> : (
        <div className="grid-2">
          {data!.map((t) => {
            const ach = Number(t.achievementPercent);
            const pace = Number(t.periodElapsedPercent);
            return (
              <div key={t.id} className="card">
                <div className="spread"><b>{human(t.metric)}</b><span className="badge">{human(t.scope)} · {t.rep_name ?? t.team_name ?? t.territory_name}</span></div>
                <div className="small muted">{human(t.period_type)} {date(t.period_start)} – {date(t.period_end)}</div>
                <div className="spread" style={{ margin: '8px 0 4px' }}><span style={{ fontSize: '1.3rem', fontWeight: 700 }}>{num(t.actual)}</span><span className="muted">of {num(t.target_value)}</span></div>
                <Progress value={ach} marker={pace} />
                <div className="small" style={{ marginTop: 6 }}>
                  {ach}% achieved · {pace}% of the period gone ·{' '}
                  {ach >= pace ? <span style={{ color: 'var(--ckh-success)' }}>on track</span> : <span style={{ color: 'var(--ckh-warning)' }}>{num(t.remaining)} to go</span>}
                </div>
                {manage && <button className="link small" onClick={async () => { if (confirm('Remove this target?')) { await api.del(`/sales/targets/${t.id}`); reload(); } }}>Remove</button>}
              </div>
            );
          })}
        </div>
      )}
    </Page>
  );
}

function NewTarget({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ scope: 'REP', salesRepId: '', teamId: '', territoryId: '', periodType: 'MONTH', periodStart: monthStart(), metric: 'NET_SALES', targetValue: '' });
  const act = useAction();
  const { data: team } = useApi(open ? '/sales/team-performance' : null);
  const { data: territories } = useApi<any[]>(open && f.scope === 'TERRITORY' ? '/sales/territories' : null);
  if (!open) return <button onClick={() => setOpen(true)}>Set a target</button>;
  const reps: any[] = team?.reps ?? [];
  async function save() {
    const body: any = { scope: f.scope, periodType: f.periodType, periodStart: f.periodStart, metric: f.metric, targetValue: f.targetValue };
    if (f.scope === 'REP') body.salesRepId = f.salesRepId;
    if (f.scope === 'TERRITORY') body.territoryId = f.territoryId;
    if (f.scope === 'TEAM') body.teamId = f.teamId;
    if (await act.run(() => api.post('/sales/targets', body))) { setOpen(false); onDone(); }
  }
  return (
    <Card title="Set a target">
      <div className="form-grid">
        <Field label="For"><select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}><option value="REP">Representative</option><option value="TERRITORY">Territory</option></select></Field>
        {f.scope === 'REP' && <Field label="Representative"><select value={f.salesRepId} onChange={(e) => setF({ ...f, salesRepId: e.target.value })}><option value="">Choose…</option>{reps.map((r) => <option key={r.sales_rep_id} value={r.sales_rep_id}>{r.rep_name}</option>)}</select></Field>}
        {f.scope === 'TERRITORY' && <Field label="Territory"><select value={f.territoryId} onChange={(e) => setF({ ...f, territoryId: e.target.value })}><option value="">Choose…</option>{(territories ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>}
        <Field label="Metric"><select value={f.metric} onChange={(e) => setF({ ...f, metric: e.target.value })}>{METRICS.map((m) => <option key={m} value={m}>{human(m)}</option>)}</select></Field>
        <Field label="Period"><select value={f.periodType} onChange={(e) => setF({ ...f, periodType: e.target.value })}><option value="MONTH">Month</option><option value="QUARTER">Quarter</option><option value="YEAR">Year</option></select></Field>
        <Field label="Starting"><input type="date" value={f.periodStart} onChange={(e) => setF({ ...f, periodStart: e.target.value })} /></Field>
        <Field label="Target"><input inputMode="decimal" value={f.targetValue} onChange={(e) => setF({ ...f, targetValue: e.target.value })} /></Field>
      </div>
      <ErrorBox error={act.error} />
      <div className="row" style={{ marginTop: 10 }}><button className="primary" disabled={act.busy} onClick={save}>Save target</button><button onClick={() => setOpen(false)}>Cancel</button></div>
    </Card>
  );
}
export default function P() {
  return <Authed><Targets /></Authed>;
}
