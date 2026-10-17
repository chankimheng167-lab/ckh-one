'use client';
import { useEffect, useState } from 'react';
import { Authed } from '@/components/Authed';
import { Card, Empty, ErrorBox, Field, Loading, Page, Status } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { date, dateTime, human, today } from '@/lib/format';
import { useAction, useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { enqueue } from '@/lib/sync';

const OUTCOMES = ['ORDER_TAKEN', 'FOLLOW_UP_NEEDED', 'NO_INTEREST', 'COLLECTION_MADE', 'CUSTOMER_UNAVAILABLE', 'OTHER'];

/** Asks the browser for a position only after the rep chose to share it for this check-in. */
function currentPosition(): Promise<{ latitude: number; longitude: number; accuracyM: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  });
}

function Visits() {
  const s = useSession();
  const [tab, setTab] = useState<'today' | 'upcoming' | 'done' | 'followups'>('today');
  const [showNew, setShowNew] = useState(false);
  const [presetCustomer, setPreset] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.get('new')) setShowNew(true);
    setPreset(p.get('customerId') ?? '');
  }, []);
  const range = tab === 'today' ? { from: today(), to: today() } : tab === 'upcoming' ? { from: today() } : { status: 'COMPLETED' };
  const { data, error, loading, reload } = useApi<any[]>(s.online && tab !== 'followups' ? `/sales/visits${qs({ ...range, limit: 100 })}` : null);
  const offlineVisits = !s.online ? s.snapshot?.data.visits ?? [] : null;
  const rows = offlineVisits ?? data ?? [];
  const customers: any[] = s.snapshot?.data.customers ?? [];
  const name = (id: string) => customers.find((c) => c.id === id)?.name ?? '';

  return (
    <Page title="Customer visits" actions={<button className="primary" onClick={() => setShowNew(!showNew)}>Plan a visit</button>}>
      {showNew && <NewVisit customerId={presetCustomer} onDone={() => { setShowNew(false); reload(); }} />}
      <div className="tabs">
        {(['today', 'upcoming', 'done', 'followups'] as const).map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'followups' ? 'Follow-ups' : t === 'done' ? 'Completed' : human(t)}</button>)}
      </div>
      <ErrorBox error={error} />
      {tab === 'followups' ? <FollowUps /> : (
        <div className="grid-2">
          <div>
            {loading && !data && !offlineVisits ? <Loading /> : rows.length === 0 ? <Empty>No visits here.</Empty> : (
              <div className="card tight">
                <ul className="list">
                  {rows.map((v: any) => (
                    <li key={v.id}>
                      <button className="link" style={{ display: 'block', width: '100%', textAlign: 'left', color: 'inherit' }} onClick={() => setSelected(v.id)}>
                        <div className="spread"><b>{v.customer_name ?? name(v.customer_id)}</b><Status s={v.status} /></div>
                        <div className="small muted">{dateTime(v.scheduled_start)}{v.purpose ? ` · ${v.purpose}` : ''}{v.outcome ? ` · ${human(v.outcome)}` : ''}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          {selected && (s.online ? <VisitDetail id={selected} onChange={reload} /> : <OfflineVisit visit={rows.find((v: any) => v.id === selected)} customerName={name(rows.find((v: any) => v.id === selected)?.customer_id)} />)}
        </div>
      )}
    </Page>
  );
}

function NewVisit({ customerId, onDone }: { customerId: string; onDone: () => void }) {
  const s = useSession();
  const [form, setForm] = useState({ customerId, when: new Date(Date.now() + 3600_000).toISOString().slice(0, 16), purpose: '' });
  const act = useAction();
  const customers: any[] = s.snapshot?.data.customers ?? [];
  const { data: online } = useApi<any[]>(s.online ? '/sales/customers?limit=200' : null);
  const list = online ?? customers;
  async function save() {
    const body = { customerId: form.customerId, scheduledStart: new Date(form.when).toISOString(), purpose: form.purpose || undefined };
    if (!s.online) {
      await enqueue(s.me!.userId, { entityType: 'VISIT', label: `Visit to ${list.find((c) => c.id === form.customerId)?.name}`, payload: body });
      await s.refreshQueue();
      return onDone();
    }
    if (await act.run(() => api.post('/sales/visits', body))) onDone();
  }
  return (
    <Card title="Plan a visit">
      <div className="form-grid">
        <Field label="Customer"><select value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}><option value="">Choose…</option>{list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="When"><input type="datetime-local" value={form.when} onChange={(e) => setForm({ ...form, when: e.target.value })} /></Field>
        <Field label="Purpose"><input value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} /></Field>
      </div>
      <ErrorBox error={act.error} />
      <button className="primary" style={{ marginTop: 10 }} disabled={!form.customerId || act.busy} onClick={save}>Save visit</button>
    </Card>
  );
}

function CheckInBox({ onCheckIn, policy }: { onCheckIn: (body: Record<string, unknown>) => Promise<void>; policy: string }) {
  const [share, setShare] = useState(policy === 'REQUIRED');
  const [msg, setMsg] = useState<string | null>(null);
  async function go() {
    let body: Record<string, unknown> = { locationConsent: false };
    if (share && policy !== 'OFF') {
      setMsg('Getting your location…');
      const pos = await currentPosition();
      if (!pos && policy === 'REQUIRED') return setMsg('Your company requires location at check-in, and it could not be read. Allow location and try again.');
      body = pos ? { locationConsent: true, ...pos } : { locationConsent: false };
    }
    setMsg(null);
    await onCheckIn(body);
  }
  return (
    <div className="stack">
      {policy !== 'OFF' && (
        <label className="row small">
          <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} disabled={policy === 'REQUIRED'} />
          Share my location for this check-in only {policy === 'REQUIRED' && <span className="badge warn">Required by your company</span>}
        </label>
      )}
      <div className="muted small">Location is used only to confirm the visit happened at the customer. It is never tracked in the background.</div>
      {msg && <div className="notice warn">{msg}</div>}
      <button className="primary" onClick={go}>Check in</button>
    </div>
  );
}

function VisitDetail({ id, onChange }: { id: string; onChange: () => void }) {
  const s = useSession();
  const { data: v, error, reload } = useApi(`/sales/visits/${id}`);
  const policy = s.snapshot?.data.settings.visitLocationCapture ?? 'ASK';
  const act = useAction();
  const [outcome, setOutcome] = useState('ORDER_TAKEN');
  const [summary, setSummary] = useState('');
  const [note, setNote] = useState({ body: '', followUp: false, dueDate: '' });
  const [review, setReview] = useState('');
  if (error) return <ErrorBox error={error} />;
  if (!v) return <Loading />;
  const own = v.rep_user_id === s.me!.userId;
  const done = async (p: Promise<unknown>) => { if (await act.run(() => p)) { reload(); onChange(); } };
  return (
    <Card title={v.customer_name} actions={<Status s={v.status} />}>
      <div className="small muted">{dateTime(v.scheduled_start)} · {v.sales_rep_name}{v.purpose ? ` · ${v.purpose}` : ''}</div>
      {v.checked_in_at && <div className="small">Checked in {dateTime(v.checked_in_at)} {v.location_consent ? <span className="badge ok">Location shared</span> : <span className="badge">No location</span>}</div>}
      {v.checked_out_at && <div className="small">Checked out {dateTime(v.checked_out_at)} · {human(v.outcome)}{v.outcome_summary ? `: ${v.outcome_summary}` : ''}</div>}
      <ErrorBox error={act.error} />
      {own && v.status === 'PLANNED' && (
        <div style={{ marginTop: 10 }}>
          <CheckInBox policy={policy} onCheckIn={(body) => done(api.post(`/sales/visits/${id}/check-in`, body))} />
          <button className="link small" style={{ marginTop: 8 }} onClick={() => { const r = prompt('Why is this visit cancelled?'); if (r) void done(api.post(`/sales/visits/${id}/cancel`, { reason: r })); }}>Cancel visit</button>
        </div>
      )}
      {own && v.status === 'IN_PROGRESS' && (
        <div className="stack" style={{ marginTop: 10 }}>
          <div className="row">
            <a className="btn primary" href={`/orders/new/?customerId=${v.customer_id}&visitId=${v.id}`}>Take an order</a>
            <a className="btn" href={`/collections/?customerId=${v.customer_id}&new=1`}>Record payment</a>
          </div>
          <Field label="Outcome"><select value={outcome} onChange={(e) => setOutcome(e.target.value)}>{OUTCOMES.map((o) => <option key={o} value={o}>{human(o)}</option>)}</select></Field>
          <Field label="Summary"><input value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
          <button onClick={() => done(api.post(`/sales/visits/${id}/check-out`, { outcome, outcomeSummary: summary || undefined }))}>Check out</button>
        </div>
      )}
      <h3 style={{ marginTop: 14 }}>Notes and follow-ups</h3>
      <ul className="list small">{(v.notes ?? []).map((n: any) => <li key={n.id}>{n.note_type === 'FOLLOW_UP_TASK' && <span className="badge info">Follow-up {date(n.due_date)}</span>} {n.body}<div className="muted">{n.author ?? ''} {dateTime(n.created_at)}</div></li>)}</ul>
      {own && ['IN_PROGRESS', 'COMPLETED'].includes(v.status) && (
        <div className="stack">
          <textarea rows={2} placeholder="Add a note" value={note.body} onChange={(e) => setNote({ ...note, body: e.target.value })} />
          <label className="row small"><input type="checkbox" checked={note.followUp} onChange={(e) => setNote({ ...note, followUp: e.target.checked })} /> This is a follow-up task {note.followUp && <input type="date" value={note.dueDate} onChange={(e) => setNote({ ...note, dueDate: e.target.value })} style={{ width: 170 }} />}</label>
          <button disabled={!note.body} onClick={() => { void done(api.post(`/sales/visits/${id}/notes`, { body: note.body, noteType: note.followUp ? 'FOLLOW_UP_TASK' : 'NOTE', dueDate: note.followUp ? note.dueDate || undefined : undefined })); setNote({ body: '', followUp: false, dueDate: '' }); }}>Add note</button>
        </div>
      )}
      {(v.orders ?? []).length > 0 && <><h3 style={{ marginTop: 14 }}>Orders from this visit</h3><ul className="list small">{v.orders.map((o: any) => <li key={o.id}><a href={`/orders/view/?id=${o.id}`}>{o.number}</a> <Status s={o.status} /></li>)}</ul></>}
      {v.reviewed_at ? <div className="notice ok small" style={{ marginTop: 10 }}>Reviewed by {v.reviewed_by_name}: {v.review_comment}</div> : !own && s.can('sales.visits.view_team') && v.status === 'COMPLETED' && (
        <div className="row" style={{ marginTop: 10 }}>
          <input placeholder="Feedback for the rep" value={review} onChange={(e) => setReview(e.target.value)} style={{ flex: 1 }} />
          <button disabled={!review} onClick={() => done(api.post(`/sales/visits/${id}/review`, { comment: review }))}>Mark reviewed</button>
        </div>
      )}
    </Card>
  );
}

/** Offline: check-in/out are queued against the planned visit downloaded with the snapshot. */
function OfflineVisit({ visit, customerName }: { visit: any; customerName: string }) {
  const s = useSession();
  const [queued, setQueued] = useState<string | null>(null);
  const [outcome, setOutcome] = useState('ORDER_TAKEN');
  if (!visit) return null;
  const policy = s.snapshot?.data.settings.visitLocationCapture ?? 'ASK';
  async function queue(payload: Record<string, unknown>, label: string) {
    await enqueue(s.me!.userId, { entityType: 'VISIT', label, payload: { visitId: visit.id, ...payload } });
    await s.refreshQueue();
    setQueued(label);
  }
  return (
    <Card title={customerName} actions={<Status s={visit.status} />}>
      <div className="notice warn small">Offline: actions are saved on this device and sent when you reconnect.</div>
      {queued && <div className="notice ok small">{queued} queued.</div>}
      {visit.status === 'PLANNED' && !queued && <CheckInBox policy={policy} onCheckIn={(checkIn) => queue({ checkIn: { ...checkIn, at: new Date().toISOString() } }, 'Check-in')} />}
      <div className="row" style={{ marginTop: 10 }}>
        <select value={outcome} onChange={(e) => setOutcome(e.target.value)} style={{ maxWidth: 220 }}>{OUTCOMES.map((o) => <option key={o} value={o}>{human(o)}</option>)}</select>
        <button onClick={() => queue({ checkOut: { outcome, at: new Date().toISOString() } }, 'Check-out')}>Check out</button>
        <a className="btn" href={`/orders/new/?customerId=${visit.customer_id}&visitId=${visit.id}`}>Take an order</a>
      </div>
    </Card>
  );
}

function FollowUps() {
  const { data, error, loading, reload } = useApi<any[]>('/sales/visits/follow-ups');
  const act = useAction();
  if (error) return <ErrorBox error={error} />;
  if (loading && !data) return <Loading />;
  if (!data?.length) return <Empty>No open follow-ups.</Empty>;
  return (
    <div className="card tight">
      <ul className="list">
        {data.map((t) => (
          <li key={t.id} className="spread">
            <span>{t.body}<div className="small muted">{t.customer_name} · due {date(t.due_date)}{t.due_date < today() ? ' · overdue' : ''}</div></span>
            <button disabled={act.busy} onClick={async () => { await act.run(() => api.post(`/sales/visits/follow-ups/${t.id}/complete`)); reload(); }}>Done</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function P() {
  return <Authed><Visits /></Authed>;
}
