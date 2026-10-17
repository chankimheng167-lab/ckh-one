'use client';
import { useEffect, useState } from 'react';
import { THEME_TOKENS, themeCssVariables, type ThemeTokens } from '@ckh/shared';
import { Authed } from '@/components/Authed';
import { Card, ErrorBox, Field, Loading, Page } from '@/components/ui';
import { api } from '@/lib/api';
import { human } from '@/lib/format';
import { useAction, useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

function Settings() {
  const s = useSession();
  return (
    <Page title="Sales settings">
      {s.can('sales.settings.manage') && <SalesSettings />}
      {s.can('tenant.settings.manage') && <ThemeStudio />}
    </Page>
  );
}

function SalesSettings() {
  const { data, error, reload } = useApi('/admin/sales/settings');
  const [f, setF] = useState<any>(null);
  const act = useAction();
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (data) setF(structuredClone(data)); }, [data]);
  if (error) return <ErrorBox error={error} />;
  if (!f) return <Loading />;
  const lim = f.approval_limits;
  const setLim = (k: string, v: string) => setF({ ...f, approval_limits: { ...lim, [k]: v } });
  async function save() {
    setSaved(false);
    const r = await act.run(() => api.put('/admin/sales/settings', {
      approvalLimits: {
        repMaxDiscountPercent: String(lim.repMaxDiscountPercent), supervisorMaxDiscountPercent: String(lim.supervisorMaxDiscountPercent), managerMaxDiscountPercent: String(lim.managerMaxDiscountPercent),
        managerOrderAmountThreshold: lim.managerOrderAmountThreshold === '' ? null : lim.managerOrderAmountThreshold, directorOrderAmountThreshold: lim.directorOrderAmountThreshold === '' ? null : lim.directorOrderAmountThreshold,
      },
      workflow: f.workflow,
      allowPriceOverride: f.allow_price_override, allowBackorders: f.allow_backorders, showBalancesToReps: f.show_balances_to_reps,
      visitLocationCapture: f.visit_location_capture, offlineCatalogMaxAgeHours: Number(f.offline_catalog_max_age_hours),
    }));
    if (r) { setSaved(true); reload(); }
  }
  const toggle = (k: string, label: string, obj = f, set = (v: any) => setF({ ...f, [k]: v })) => (
    <label className="row small"><input type="checkbox" checked={!!obj[k]} onChange={(e) => set(e.target.checked)} /> {label}</label>
  );
  return (
    <Card title="Ordering and approvals">
      <div className="form-grid">
        <Field label="Rep max discount %"><input value={lim.repMaxDiscountPercent} onChange={(e) => setLim('repMaxDiscountPercent', e.target.value)} /></Field>
        <Field label="Supervisor approves up to %"><input value={lim.supervisorMaxDiscountPercent} onChange={(e) => setLim('supervisorMaxDiscountPercent', e.target.value)} /></Field>
        <Field label="Manager approves up to %"><input value={lim.managerMaxDiscountPercent} onChange={(e) => setLim('managerMaxDiscountPercent', e.target.value)} /></Field>
        <Field label="Manager approval above amount"><input value={lim.managerOrderAmountThreshold ?? ''} placeholder="No limit" onChange={(e) => setLim('managerOrderAmountThreshold', e.target.value)} /></Field>
        <Field label="Director approval above amount"><input value={lim.directorOrderAmountThreshold ?? ''} placeholder="No limit" onChange={(e) => setLim('directorOrderAmountThreshold', e.target.value)} /></Field>
        <Field label="Location at visit check-in">
          <select value={f.visit_location_capture} onChange={(e) => setF({ ...f, visit_location_capture: e.target.value })}>
            <option value="OFF">Never collect</option><option value="ASK">Ask the rep each time</option><option value="REQUIRED">Required (rep must allow)</option>
          </select>
        </Field>
        <Field label="Offline stock is stale after (hours)"><input inputMode="numeric" value={f.offline_catalog_max_age_hours} onChange={(e) => setF({ ...f, offline_catalog_max_age_hours: e.target.value })} /></Field>
      </div>
      <div className="stack" style={{ marginTop: 12 }}>
        {toggle('pickPackEnabled', 'Use picking and packing steps', f.workflow, (v) => setF({ ...f, workflow: { ...f.workflow, pickPackEnabled: v } }))}
        {toggle('invoiceOnDispatch', 'Allow invoicing at dispatch (before delivery is confirmed)', f.workflow, (v) => setF({ ...f, workflow: { ...f.workflow, invoiceOnDispatch: v } }))}
        {toggle('allow_price_override', 'Reps may change unit prices (always re-checked and logged)')}
        {toggle('allow_backorders', 'Accept orders beyond available stock as backorders')}
        {toggle('show_balances_to_reps', 'Show customer balances to reps')}
      </div>
      <ErrorBox error={act.error} />
      {saved && <div className="notice ok">Saved.</div>}
      <button className="primary" style={{ marginTop: 10 }} disabled={act.busy} onClick={save}>Save settings</button>
    </Card>
  );
}

function ThemeStudio() {
  const s = useSession();
  const { data } = useApi('/theme');
  const [tokens, setTokens] = useState<ThemeTokens>({});
  const [name, setName] = useState('');
  const [logo, setLogo] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const act = useAction();
  useEffect(() => {
    if (!data) return;
    setTokens(data.tokens ?? {});
    setName(data.companyDisplayName ?? '');
    setLogo(data.logoUrl ?? '');
  }, [data]);
  const preview = themeCssVariables(tokens);
  async function save() {
    const r = await act.run(() => api.put('/admin/theme', { tokens, companyDisplayName: name || null, logoUrl: logo || null }));
    if (r) {
      setWarnings(r.warnings);
      s.applyTheme(r.cssVariables);
    }
  }
  return (
    <Card title="Theme Studio" actions={<button className="link small" onClick={() => setTokens({})}>Reset to defaults</button>}>
      <div className="grid-2">
        <div className="stack">
          <div className="form-grid">
            <Field label="Company name on screens"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Logo URL (https)"><input value={logo} onChange={(e) => setLogo(e.target.value)} placeholder="https://…" /></Field>
          </div>
          <div className="form-grid">
            {Object.entries(THEME_TOKENS).map(([k, def]) => (
              <Field key={k} label={human(k.replace(/([A-Z])/g, '_$1'))}>
                {def.kind === 'color' ? (
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <input type="color" className="swatch" value={(tokens as any)[k] ?? def.default} onChange={(e) => setTokens({ ...tokens, [k]: e.target.value })} />
                    <input value={(tokens as any)[k] ?? def.default} onChange={(e) => setTokens({ ...tokens, [k]: e.target.value })} />
                  </div>
                ) : (
                  <input value={(tokens as any)[k] ?? def.default} onChange={(e) => setTokens({ ...tokens, [k]: e.target.value })} />
                )}
              </Field>
            ))}
          </div>
        </div>
        <div style={{ ...(preview as any), background: 'var(--ckh-bg)', color: 'var(--ckh-text)', fontFamily: 'var(--ckh-font)', padding: 14, borderRadius: 'var(--ckh-radius)', border: '1px solid var(--ckh-border)' }}>
          <div className="muted small">Preview</div>
          <div className="card" style={{ marginTop: 8 }}>
            <b>{name || 'Your company'}</b>
            <div className="muted small">Order SO-2026-00042 · Sunrise Mart</div>
            <div className="row" style={{ marginTop: 8 }}>
              <span className="badge ok">Approved</span><span className="badge warn">Pending approval</span><span className="badge bad">Stale stock</span>
            </div>
            <div className="row" style={{ marginTop: 10 }}><button className="primary">Submit order</button><button>Save draft</button></div>
          </div>
        </div>
      </div>
      {warnings.map((w) => <div key={w} className="notice warn small" style={{ marginTop: 8 }}>{w}</div>)}
      <ErrorBox error={act.error} />
      <button className="primary" style={{ marginTop: 10 }} disabled={act.busy} onClick={save}>Save theme</button>
    </Card>
  );
}
export default function P() {
  return <Authed><Settings /></Authed>;
}
