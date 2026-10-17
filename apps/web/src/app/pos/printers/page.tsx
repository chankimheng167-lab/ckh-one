'use client';
import { useEffect, useState } from 'react';
import { P } from '@ckh/shared';
import { PosShell, usePos } from '@/components/PosShell';
import { Card, ErrorBox, Field, Loading, Page } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';

export default function PrinterSettingsPage() {
  return (
    <PosShell needRegister={false}>
      <Printers />
    </PosShell>
  );
}

const DEFAULTS = { receiptPaper: '80', autoPrint: true, copies: 1, printerName: '', printerConnection: 'SYSTEM', printerAddress: '', openDrawerOnCash: true, drawerPin: 0, customerDisplay: false, scannerSuffix: 'ENTER' };

/**
 * Receipt printer, cash drawer and scanner settings, stored per register.
 * The web till prints through the browser's print dialog; the Windows POS
 * app uses these settings to print directly and open the drawer.
 */
function Printers() {
  const { ctx, can } = usePos();
  const regs = useApi<any[]>('/pos/admin/registers');
  const [rid, setRid] = useState<string>('');
  const [f, setF] = useState<any>(null);
  const act = useAction();
  const [saved, setSaved] = useState(false);
  useEffect(() => setRid(new URLSearchParams(location.search).get('registerId') ?? ctx.register?.id ?? ''), [ctx.register]);
  const reg = regs.data?.find((r) => r.id === rid);
  useEffect(() => { if (reg) setF({ ...DEFAULTS, ...reg.hardware }); }, [reg]);
  const manage = can(P.POS_DEVICES_MANAGE) || can(P.POS_REGISTERS_MANAGE);
  async function save() {
    setSaved(false);
    const hardware = { ...f, copies: Number(f.copies), drawerPin: Number(f.drawerPin), printerName: f.printerName || null, printerAddress: f.printerAddress || null };
    if (await act.run(() => api.put(`/pos/admin/registers/${rid}`, { hardware }))) { setSaved(true); regs.reload(); }
  }
  return (
    <Page title="Printer and hardware settings">
      <Field label="Register">
        <select value={rid} onChange={(e) => setRid(e.target.value)}>
          <option value="">Choose…</option>
          {(regs.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.code} · {r.name}</option>)}
        </select>
      </Field>
      <ErrorBox error={regs.error} />
      {regs.loading && <Loading />}
      {reg && f && (
        <Card title={`${reg.name}`}>
          <div className="form-grid">
            <Field label="Receipt paper">
              <select value={f.receiptPaper} onChange={(e) => setF({ ...f, receiptPaper: e.target.value })}>
                <option value="58">58 mm thermal</option><option value="80">80 mm thermal</option><option value="A4">A4</option>
              </select>
            </Field>
            <Field label="Copies"><input inputMode="numeric" value={f.copies} onChange={(e) => setF({ ...f, copies: e.target.value })} /></Field>
            <Field label="Printer connection (Windows app)">
              <select value={f.printerConnection} onChange={(e) => setF({ ...f, printerConnection: e.target.value })}>
                <option value="SYSTEM">Windows printer queue</option><option value="NETWORK">Network ESC/POS (IP:port)</option><option value="SERIAL">Serial/USB ESC/POS (COM port)</option>
              </select>
            </Field>
            <Field label={f.printerConnection === 'SYSTEM' ? 'Windows printer name' : 'Printer name (label)'}><input value={f.printerName ?? ''} onChange={(e) => setF({ ...f, printerName: e.target.value })} /></Field>
            {f.printerConnection !== 'SYSTEM' && (
              <Field label={f.printerConnection === 'NETWORK' ? 'Address (192.168.1.50:9100)' : 'Port (COM3)'}><input value={f.printerAddress ?? ''} onChange={(e) => setF({ ...f, printerAddress: e.target.value })} /></Field>
            )}
            <Field label="Cash drawer pin">
              <select value={f.drawerPin} onChange={(e) => setF({ ...f, drawerPin: e.target.value })}><option value={0}>Pin 2 (most drawers)</option><option value={1}>Pin 5</option></select>
            </Field>
            <Field label="Scanner sends after the code">
              <select value={f.scannerSuffix} onChange={(e) => setF({ ...f, scannerSuffix: e.target.value })}><option value="ENTER">Enter</option><option value="TAB">Tab</option><option value="NONE">Nothing</option></select>
            </Field>
          </div>
          <div className="stack" style={{ marginTop: 10 }}>
            <label className="row small"><input type="checkbox" checked={f.autoPrint} onChange={(e) => setF({ ...f, autoPrint: e.target.checked })} /> Print the receipt automatically after each sale</label>
            <label className="row small"><input type="checkbox" checked={f.openDrawerOnCash} onChange={(e) => setF({ ...f, openDrawerOnCash: e.target.checked })} /> Open the cash drawer on cash sales (Windows app)</label>
            <label className="row small"><input type="checkbox" checked={f.customerDisplay} onChange={(e) => setF({ ...f, customerDisplay: e.target.checked })} /> Customer display connected</label>
          </div>
          <p className="small muted">In a browser, receipts print through the browser’s print dialog and the drawer cannot be opened. Direct printing and the drawer kick need the CKH ONE POS Windows app.</p>
          <ErrorBox error={act.error} />
          {saved && <div className="notice ok">Saved.</div>}
          {manage && <button className="primary" disabled={act.busy} onClick={save}>Save</button>}
        </Card>
      )}
    </Page>
  );
}
