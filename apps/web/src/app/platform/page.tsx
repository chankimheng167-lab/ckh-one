'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Empty, ErrorBox, Field, Loading, Page, Status } from '@/components/ui';
import { ApiError, deviceInfo, type IssuedTokens, platformApi, platformTokenStore } from '@/lib/api';
import { date, human } from '@/lib/format';
import { useAction } from '@/lib/hooks';

/**
 * Super Admin portal (platform owner): sign in with a platform admin account,
 * then create client companies and manage their modules, subscription and status.
 * Separate from the company sign-in at /login/.
 */

interface ModuleDef { code: string; name: string; requires: string[] }
interface Tenant {
  id: string;
  code: string;
  name: string;
  status: string;
  created_at: string;
  subscription_status: string | null;
  ends_at: string | null;
  modules: string[] | null;
}

/** Date input (YYYY-MM-DD) to the end of that day in UTC, or null for "no end date". */
const endOfDay = (d: string) => (d ? new Date(`${d}T23:59:59.000Z`).toISOString() : null);

/** Adds every prerequisite of the checked modules; CORE is always on. */
function withPrereqs(codes: Set<string>, catalog: ModuleDef[]) {
  const out = new Set(codes).add('CORE');
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of catalog) if (out.has(m.code)) for (const r of m.requires) if (!out.has(r)) { out.add(r); grew = true; }
  }
  return out;
}
/** Removes a module and everything that depends on it. */
function withoutDependents(codes: Set<string>, code: string, catalog: ModuleDef[]) {
  const out = new Set(codes);
  out.delete(code);
  let shrank = true;
  while (shrank) {
    shrank = false;
    for (const m of catalog) if (out.has(m.code) && m.requires.some((r) => !out.has(r))) { out.delete(m.code); shrank = true; }
  }
  return out;
}

function ModulePicker({ catalog, value, onChange }: { catalog: ModuleDef[]; value: Set<string>; onChange: (v: Set<string>) => void }) {
  const byCode = Object.fromEntries(catalog.map((m) => [m.code, m.name]));
  return (
    <div className="grid-2" style={{ gap: 6 }}>
      {catalog.map((m) => (
        <label key={m.code} className="row small" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
          <input
            type="checkbox"
            checked={value.has(m.code)}
            disabled={m.code === 'CORE'}
            onChange={(e) => onChange(e.target.checked ? withPrereqs(new Set(value).add(m.code), catalog) : withoutDependents(value, m.code, catalog))}
          />
          <span>
            {m.name}
            {m.requires.length > 0 && <span className="muted"> · needs {m.requires.map((r) => byCode[r] ?? r).join(', ')}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await platformApi.post<IssuedTokens>('/auth/platform/login', { email: email.trim(), password, ...deviceInfo() });
      platformTokenStore.set(r);
      onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError && err.isNetwork ? 'Cannot reach the server. Is the API running?' : 'Email or password is incorrect.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <form className="card stack" style={{ width: '100%', maxWidth: 380 }} onSubmit={submit}>
        <div className="brand" style={{ fontSize: '1.2rem' }}>
          <span className="logo">C1</span> CKH ONE
        </div>
        <div className="muted small">Super Admin sign-in (platform owner)</div>
        <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></Field>
        <Field label="Password"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></Field>
        {error && <div className="notice bad">{error}</div>}
        <button className="primary" disabled={busy} type="submit">{busy ? 'Signing in…' : 'Sign in'}</button>
        <div className="small muted">Company users sign in at <a href="/login/">/login</a>.</div>
      </form>
    </div>
  );
}

function NewClient({ catalog, onCreated, onCancel }: { catalog: ModuleDef[]; onCreated: (code: string) => void; onCancel: () => void }) {
  const [f, setF] = useState({ code: '', name: '', baseCurrency: 'USD', adminName: '', adminEmail: '', adminPassword: '', status: 'TRIAL', endsAt: '', graceDays: '7' });
  const [mods, setMods] = useState<Set<string>>(new Set(['CORE']));
  const act = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = await act.run(() =>
      platformApi.post('/platform/tenants', {
        code: f.code.trim().toLowerCase(),
        name: f.name.trim(),
        baseCurrency: f.baseCurrency.trim().toUpperCase(),
        admin: { email: f.adminEmail.trim(), password: f.adminPassword, fullName: f.adminName.trim() },
        modules: [...mods],
        subscription: { status: f.status, endsAt: endOfDay(f.endsAt), graceDays: Number(f.graceDays || 0) },
      }),
    );
    if (r) onCreated(f.code.trim().toLowerCase());
  }
  return (
    <Card title="New client company">
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Company code (used to sign in)"><input value={f.code} onChange={set('code')} placeholder="e.g. shop2" pattern="[a-z0-9][a-z0-9\-]{1,40}" autoCapitalize="none" required /></Field>
          <Field label="Company name"><input value={f.name} onChange={set('name')} minLength={2} required /></Field>
          <Field label="Currency"><input value={f.baseCurrency} onChange={set('baseCurrency')} maxLength={3} minLength={3} required /></Field>
          <Field label="Admin full name"><input value={f.adminName} onChange={set('adminName')} required /></Field>
          <Field label="Admin email"><input type="email" value={f.adminEmail} onChange={set('adminEmail')} required /></Field>
          <Field label="Admin password (10+ characters)"><input type="text" value={f.adminPassword} onChange={set('adminPassword')} minLength={10} required /></Field>
          <Field label="Subscription">
            <select value={f.status} onChange={set('status')}><option value="TRIAL">Trial</option><option value="ACTIVE">Active</option></select>
          </Field>
          <Field label="Ends on (blank = no end)"><input type="date" value={f.endsAt} onChange={set('endsAt')} /></Field>
          <Field label="Grace days after end"><input inputMode="numeric" value={f.graceDays} onChange={set('graceDays')} /></Field>
        </div>
        <h3>Modules</h3>
        <ModulePicker catalog={catalog} value={mods} onChange={setMods} />
        {act.error && <div className="notice bad">{act.error}</div>}
        <div className="row">
          <button className="primary" type="submit" disabled={act.busy}>{act.busy ? 'Creating…' : 'Create client'}</button>
          <button type="button" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </Card>
  );
}

function ManageClient({ tenant, catalog, onChanged }: { tenant: Tenant; catalog: ModuleDef[]; onChanged: () => void }) {
  const current = useMemo(() => new Set(tenant.modules ?? []), [tenant.modules]);
  const [mods, setMods] = useState<Set<string>>(current);
  const [sub, setSub] = useState({ status: tenant.subscription_status ?? 'ACTIVE', endsAt: tenant.ends_at?.slice(0, 10) ?? '', graceDays: '7' });
  const [status, setStatus] = useState(tenant.status);
  const [saved, setSaved] = useState<string | null>(null);
  const act = useAction();
  useEffect(() => {
    setMods(new Set(tenant.modules ?? []));
    setSub({ status: tenant.subscription_status ?? 'ACTIVE', endsAt: tenant.ends_at?.slice(0, 10) ?? '', graceDays: '7' });
    setStatus(tenant.status);
  }, [tenant]);

  const changedModules = catalog.filter((m) => mods.has(m.code) !== current.has(m.code));
  async function saveModules() {
    setSaved(null);
    // Only send what changed, so per-module end dates on untouched modules are kept.
    const r = await act.run(() =>
      platformApi.put(`/platform/tenants/${tenant.id}/modules`, { modules: changedModules.map((m) => ({ code: m.code, enabled: mods.has(m.code) })) }),
    );
    if (r) { setSaved('Modules saved.'); onChanged(); }
  }
  async function saveSubscription() {
    setSaved(null);
    const r = await act.run(() =>
      platformApi.put(`/platform/tenants/${tenant.id}/subscription`, { status: sub.status, endsAt: endOfDay(sub.endsAt), graceDays: Number(sub.graceDays || 0) }),
    );
    if (r) { setSaved('Subscription saved.'); onChanged(); }
  }
  async function saveStatus() {
    setSaved(null);
    const r = await act.run(() => platformApi.put(`/platform/tenants/${tenant.id}/status`, { status }));
    if (r) { setSaved('Company status saved.'); onChanged(); }
  }

  return (
    <Card title={`${tenant.name} (${tenant.code})`}>
      <div className="stack">
        {act.error && <div className="notice bad">{act.error}</div>}
        {saved && <div className="notice ok">{saved}</div>}
        <div>
          <h3>Modules</h3>
          <ModulePicker catalog={catalog} value={mods} onChange={setMods} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" disabled={act.busy || changedModules.length === 0} onClick={saveModules}>Save modules</button>
            {changedModules.length > 0 && <span className="small muted">{changedModules.length} change(s) not saved</span>}
          </div>
        </div>
        <div>
          <h3>Subscription</h3>
          <div className="form-grid">
            <Field label="Status">
              <select value={sub.status} onChange={(e) => setSub({ ...sub, status: e.target.value })}>
                {['TRIAL', 'ACTIVE', 'PAST_DUE', 'EXPIRED', 'CANCELLED'].map((s) => <option key={s} value={s}>{human(s)}</option>)}
              </select>
            </Field>
            <Field label="Ends on (blank = no end)"><input type="date" value={sub.endsAt} onChange={(e) => setSub({ ...sub, endsAt: e.target.value })} /></Field>
            <Field label="Grace days after end"><input inputMode="numeric" value={sub.graceDays} onChange={(e) => setSub({ ...sub, graceDays: e.target.value })} /></Field>
          </div>
          <button style={{ marginTop: 8 }} disabled={act.busy} onClick={saveSubscription}>Save subscription</button>
        </div>
        <div>
          <h3>Company status</h3>
          <div className="row">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended (users cannot sign in)</option><option value="CLOSED">Closed</option>
            </select>
            <button className={status === 'ACTIVE' ? '' : 'danger'} disabled={act.busy || status === tenant.status} onClick={saveStatus}>Save status</button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function Portal({ onSignOut }: { onSignOut: () => void }) {
  const [catalog, setCatalog] = useState<ModuleDef[]>([]);
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, t] = await Promise.all([platformApi.get<ModuleDef[]>('/platform/modules'), platformApi.get<Tenant[]>('/platform/tenants')]);
      setCatalog(m);
      setTenants(t);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onSignOut();
      else setError(e as ApiError);
    }
  }, [onSignOut]);
  useEffect(() => { void load(); }, [load]);

  const tenant = tenants?.find((t) => t.id === selected) ?? null;
  return (
    <div className="content" style={{ maxWidth: 1100, margin: '0 auto', padding: 16 }}>
      <Page
        title="Super Admin"
        subtitle="Client companies, their modules and subscriptions"
        actions={<><button className="primary" onClick={() => { setCreating(true); setSelected(null); setCreated(null); }}>New client</button><button onClick={onSignOut}>Sign out</button></>}
      >
        <ErrorBox error={error} />
        {created && <div className="notice ok">Client “{created}” created. Its admin can now sign in at /login with that company code.</div>}
        {creating && (
          <NewClient
            catalog={catalog}
            onCancel={() => setCreating(false)}
            onCreated={async (code) => { setCreating(false); setCreated(code); await load(); }}
          />
        )}
        <Card title="Clients" tight>
          {!tenants ? <Loading /> : tenants.length === 0 ? <Empty>No clients yet.</Empty> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Code</th><th>Name</th><th>Status</th><th>Subscription</th><th>Ends</th><th>Modules</th><th /></tr></thead>
                <tbody>
                  {tenants.map((t) => (
                    <tr key={t.id} style={t.id === selected ? { background: 'color-mix(in srgb, var(--ckh-primary) 8%, transparent)' } : undefined}>
                      <td>{t.code}</td>
                      <td>{t.name}</td>
                      <td><span className={`badge ${t.status === 'ACTIVE' ? 'ok' : 'bad'}`}>{human(t.status)}</span></td>
                      <td><Status s={t.subscription_status} /></td>
                      <td>{t.ends_at ? date(t.ends_at) : 'No end'}</td>
                      <td className="small">{(t.modules ?? []).length}</td>
                      <td className="right"><button className="link" onClick={() => { setSelected(t.id); setCreating(false); }}>Manage</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        {tenant && <ManageClient key={tenant.id} tenant={tenant} catalog={catalog} onChanged={load} />}
      </Page>
    </div>
  );
}

export default function PlatformPage() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => setSignedIn(platformTokenStore.hasSession()), []);
  const signOut = useCallback(() => {
    void platformApi.post('/auth/logout').catch(() => undefined);
    platformTokenStore.set(null);
    setSignedIn(false);
  }, []);
  if (signedIn === null) return <div className="content muted">Loading…</div>;
  return signedIn ? <Portal onSignOut={signOut} /> : <SignIn onSignedIn={() => setSignedIn(true)} />;
}
