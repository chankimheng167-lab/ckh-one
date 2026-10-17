'use client';
import { useEffect, useState } from 'react';
import { P } from '@ckh/shared';
import { PosShell, usePos } from '@/components/PosShell';
import { Card, ErrorBox, Field, Loading, Page } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';

const LANGS = [
  ['en', 'English'],
  ['km', 'Khmer (ខ្មែរ)'],
  ['zh', 'Chinese (中文)'],
] as const;

export default function ReceiptSettingsPage() {
  return (
    <PosShell needRegister={false}>
      <ReceiptSettings />
    </PosShell>
  );
}

function ReceiptSettings() {
  const { can } = usePos();
  const { data, error, reload } = useApi<any>(can(P.POS_SETTINGS_MANAGE) ? '/pos/admin/settings' : null);
  const [f, setF] = useState<any>(null);
  const [saved, setSaved] = useState(false);
  const act = useAction();
  useEffect(() => {
    if (data) {
      const r = data.receipt ?? {};
      setF({ paper: r.paper ?? '80', languages: r.languages ?? ['en'], showLogo: r.showLogo !== false, showTaxId: r.showTaxId !== false, header: r.header ?? {}, footer: r.footer ?? {} });
    }
  }, [data]);
  if (!can(P.POS_SETTINGS_MANAGE)) return <Page title="Receipt settings"><div className="notice">Only POS managers can change receipt settings.</div></Page>;
  if (error) return <ErrorBox error={error} />;
  if (!f) return <Loading />;
  const toggle = (l: string) => {
    const has = f.languages.includes(l);
    const next = has ? f.languages.filter((x: string) => x !== l) : [...f.languages, l];
    setF({ ...f, languages: LANGS.map(([k]) => k).filter((k) => next.includes(k)) });
  };
  async function save() {
    setSaved(false);
    const r = await act.run(() => api.put('/pos/admin/settings', { receipt: f }));
    if (r) { setSaved(true); reload(); }
  }
  return (
    <Page title="Receipt settings" subtitle="Applies to every register. A register's own paper size, set under Printers, takes priority.">
      <Card title="Layout">
        <div className="form-grid">
          <Field label="Default paper">
            <select value={f.paper} onChange={(e) => setF({ ...f, paper: e.target.value })}>
              <option value="58">58 mm roll</option>
              <option value="80">80 mm roll</option>
              <option value="A4">A4 page</option>
            </select>
          </Field>
        </div>
        <div className="stack" style={{ marginTop: 10 }}>
          <label className="row small"><input type="checkbox" checked={f.showLogo} onChange={(e) => setF({ ...f, showLogo: e.target.checked })} /> Show the company logo</label>
          <label className="row small"><input type="checkbox" checked={f.showTaxId} onChange={(e) => setF({ ...f, showTaxId: e.target.checked })} /> Show the VAT TIN</label>
        </div>
      </Card>
      <Card title="Languages">
        <div className="small muted">Receipts print in the first one or two languages ticked, with labels side by side. Plain-text printing is English only; Khmer and Chinese print as HTML.</div>
        <div className="row" style={{ marginTop: 8 }}>
          {LANGS.map(([k, label]) => (
            <label key={k} className="row small"><input type="checkbox" checked={f.languages.includes(k)} disabled={f.languages.length === 1 && f.languages.includes(k)} onChange={() => toggle(k)} /> {label}</label>
          ))}
        </div>
      </Card>
      <Card title="Header and footer">
        <div className="form-grid">
          {LANGS.filter(([k]) => f.languages.includes(k)).map(([k, label]) => (
            <div key={k} className="stack">
              <Field label={`Header (${label})`}><textarea rows={3} maxLength={500} value={f.header[k] ?? ''} onChange={(e) => setF({ ...f, header: { ...f.header, [k]: e.target.value } })} /></Field>
              <Field label={`Footer (${label})`}><textarea rows={3} maxLength={500} value={f.footer[k] ?? ''} onChange={(e) => setF({ ...f, footer: { ...f.footer, [k]: e.target.value } })} /></Field>
            </div>
          ))}
        </div>
      </Card>
      <ErrorBox error={act.error} />
      <div className="row">
        <button className="primary" disabled={act.busy} onClick={save}>Save receipt settings</button>
        {saved && <span className="small" style={{ color: 'var(--ckh-success)' }}>Saved</span>}
      </div>
    </Page>
  );
}
