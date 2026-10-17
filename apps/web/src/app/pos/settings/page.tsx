'use client';
import { useEffect, useState } from 'react';
import { P } from '@ckh/shared';
import { PosShell, Sheet, usePos } from '@/components/PosShell';
import { Card, ErrorBox, Field, Loading, Page } from '@/components/ui';
import { api } from '@/lib/api';
import { human } from '@/lib/format';
import { useAction, useApi } from '@/lib/hooks';

export default function PosSettingsPage() {
  return (
    <PosShell needRegister={false}>
      <Settings />
    </PosShell>
  );
}

function Settings() {
  const { can } = usePos();
  return (
    <Page title="POS settings">
      {can(P.POS_SETTINGS_MANAGE) ? (
        <>
          <General />
          <Methods />
        </>
      ) : (
        <div className="notice">Only POS managers can change POS settings.</div>
      )}
      <MyPin />
    </Page>
  );
}

function General() {
  const { data, error, reload } = useApi('/pos/admin/settings');
  const [f, setF] = useState<any>(null);
  const act = useAction();
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (data) setF(structuredClone(data)); }, [data]);
  if (error) return <ErrorBox error={error} />;
  if (!f) return <Loading />;
  const acc = (type?: string) => f.accounts.filter((a: any) => !type || a.account_type === type);
  const accountSelect = (k: string, label: string, type?: string, nullable?: boolean) => (
    <Field label={label}>
      <select value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value || null })}>
        {nullable && <option value="">Company default</option>}
        {acc(type).map((a: any) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
      </select>
    </Field>
  );
  async function save() {
    setSaved(false);
    const r = await act.run(() =>
      api.put('/pos/admin/settings', {
        pricesIncludeTax: f.prices_include_tax,
        cashierMaxDiscountPercent: String(f.cashier_max_discount_percent),
        overrideMaxDiscountPercent: String(f.override_max_discount_percent),
        allowNegativeStock: f.allow_negative_stock,
        requireOpenShift: f.require_open_shift,
        cashDifferenceTolerance: String(f.cash_difference_tolerance),
        cashAccountId: f.cash_account_id,
        pendingPaymentAccountId: f.pending_payment_account_id,
        cashOverShortAccountId: f.cash_over_short_account_id,
        inventoryAdjustmentAccountId: f.inventory_adjustment_account_id,
      }),
    );
    if (r) { setSaved(true); reload(); }
  }
  return (
    <Card title="Selling rules">
      <div className="form-grid">
        <Field label="Cashier may discount up to %"><input inputMode="decimal" value={f.cashier_max_discount_percent} onChange={(e) => setF({ ...f, cashier_max_discount_percent: e.target.value })} /></Field>
        <Field label="Supervisor may approve up to %"><input inputMode="decimal" value={f.override_max_discount_percent} onChange={(e) => setF({ ...f, override_max_discount_percent: e.target.value })} /></Field>
        <Field label="Cash difference accepted without a note"><input inputMode="decimal" value={f.cash_difference_tolerance} onChange={(e) => setF({ ...f, cash_difference_tolerance: e.target.value })} /></Field>
      </div>
      <div className="stack" style={{ marginTop: 10 }}>
        <label className="row small"><input type="checkbox" checked={f.prices_include_tax} onChange={(e) => setF({ ...f, prices_include_tax: e.target.checked })} /> Shelf prices include VAT</label>
        <label className="row small"><input type="checkbox" checked={f.require_open_shift} onChange={(e) => setF({ ...f, require_open_shift: e.target.checked })} /> A shift must be open to sell</label>
        <label className="row small"><input type="checkbox" checked={f.allow_negative_stock} onChange={(e) => setF({ ...f, allow_negative_stock: e.target.checked })} /> Allow selling more than the recorded stock</label>
      </div>
      <h3 style={{ marginTop: 14 }}>Ledger accounts</h3>
      <div className="form-grid">
        {accountSelect('cash_account_id', 'Cash drawer', 'ASSET', true)}
        {accountSelect('pending_payment_account_id', 'Payments waiting for verification', 'ASSET')}
        {accountSelect('cash_over_short_account_id', 'Cash over and short', 'EXPENSE')}
        {accountSelect('inventory_adjustment_account_id', 'Inventory adjustments', 'EXPENSE')}
      </div>
      <p className="small muted">VAT treatment and account mappings should be confirmed with your accountant for Cambodian tax rules before going live.</p>
      <ErrorBox error={act.error} />
      {saved && <div className="notice ok">Saved.</div>}
      <button className="primary" disabled={act.busy} onClick={save}>Save settings</button>
    </Card>
  );
}

function Methods() {
  const { data, error, reload } = useApi<any[]>('/pos/admin/payment-methods');
  const [edit, setEdit] = useState<any>(null);
  return (
    <Card title="Payment methods" actions={<button onClick={() => setEdit({ kind: 'CARD', is_active: true, sort_order: 10 })}>Add method</button>}>
      <ErrorBox error={error} />
      <table>
        <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Reference</th><th>Verified later</th><th>Offline</th><th>Active</th><th /></tr></thead>
        <tbody>
          {(data ?? []).map((m) => (
            <tr key={m.id}>
              <td>{m.code}</td><td>{m.name}</td><td>{human(m.kind)}</td><td>{m.requires_reference ? 'Yes' : ''}</td><td>{m.requires_verification ? 'Yes' : ''}</td>
              <td>{m.allow_offline ? 'Yes' : ''}</td><td>{m.is_active ? 'Yes' : 'No'}</td>
              <td><button onClick={() => setEdit(m)}>Edit</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">Bank transfers and QR payments always wait for verification; card payments need the terminal approval code. Card numbers are never stored.</p>
      {edit && <MethodSheet m={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
    </Card>
  );
}

function MethodSheet({ m, onClose, onDone }: { m: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({
    code: m.code ?? '', name: m.name ?? '', kind: m.kind ?? 'CARD', requiresReference: !!m.requires_reference, requiresVerification: !!m.requires_verification,
    allowOffline: !!m.allow_offline, sortOrder: m.sort_order ?? 10, isActive: m.is_active ?? true,
  });
  const act = useAction();
  const forced = f.kind === 'BANK_TRANSFER' || f.kind === 'QR';
  const body = { ...f, sortOrder: Number(f.sortOrder), requiresReference: f.requiresReference || forced || f.kind === 'CARD', requiresVerification: f.requiresVerification || forced, allowOffline: f.kind === 'CASH' && f.allowOffline };
  return (
    <Sheet title={m.id ? `Payment method ${m.code}` : 'New payment method'} onClose={onClose}>
      <div className="form-grid">
        <Field label="Code"><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
        <Field label="Name on screen and receipt"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Type">
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {['CASH', 'CARD', 'QR', 'BANK_TRANSFER', 'OTHER'].map((k) => <option key={k} value={k}>{human(k)}</option>)}
          </select>
        </Field>
        <Field label="Order"><input inputMode="numeric" value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: e.target.value as any })} /></Field>
      </div>
      <label className="row small"><input type="checkbox" checked={body.requiresReference} disabled={forced || f.kind === 'CARD'} onChange={(e) => setF({ ...f, requiresReference: e.target.checked })} /> Cashier must enter a reference</label>
      <label className="row small"><input type="checkbox" checked={body.requiresVerification} disabled={forced} onChange={(e) => setF({ ...f, requiresVerification: e.target.checked })} /> Counts as paid only after verification</label>
      {f.kind === 'CASH' && <label className="row small"><input type="checkbox" checked={f.allowOffline} onChange={(e) => setF({ ...f, allowOffline: e.target.checked })} /> Accept while offline (Windows app)</label>}
      <label className="row small"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Active</label>
      <ErrorBox error={act.error} />
      <button className="primary" disabled={act.busy} onClick={async () => (await act.run(() => (m.id ? api.put(`/pos/admin/payment-methods/${m.id}`, body) : api.post('/pos/admin/payment-methods', body)))) && onDone()}>
        Save
      </button>
    </Sheet>
  );
}

/** Supervisors approve discounts, price changes and refunds on the cashier's screen with this PIN. */
function MyPin() {
  const [f, setF] = useState({ currentPassword: '', pin: '' });
  const act = useAction();
  const [ok, setOk] = useState(false);
  return (
    <Card title="My approval PIN">
      <p className="small muted">Used when you approve something on another cashier’s till. 4 to 8 digits; locked for 15 minutes after 5 wrong tries.</p>
      <div className="form-grid">
        <Field label="Your password"><input type="password" autoComplete="current-password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} /></Field>
        <Field label="New PIN"><input type="password" inputMode="numeric" autoComplete="off" value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '').slice(0, 8) })} /></Field>
      </div>
      <ErrorBox error={act.error} />
      {ok && <div className="notice ok">PIN saved.</div>}
      <button disabled={act.busy || f.pin.length < 4 || !f.currentPassword} onClick={async () => { setOk(false); if (await act.run(() => api.put('/pos/me/pin', f))) { setOk(true); setF({ currentPassword: '', pin: '' }); } }}>
        Save PIN
      </button>
    </Card>
  );
}
