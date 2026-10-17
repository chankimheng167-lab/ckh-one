'use client';
import { useState } from 'react';
import { P } from '@ckh/shared';
import { PosShell, Sheet, usePos } from '@/components/PosShell';
import { Card, Empty, ErrorBox, Field, Loading, Page, Status } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';

export default function RegistersPage() {
  return (
    <PosShell needRegister={false}>
      <Registers />
    </PosShell>
  );
}

function Registers() {
  const { can } = usePos();
  const regs = useApi<any[]>('/pos/admin/registers');
  const lic = useApi('/pos/admin/license');
  const ref = useApi('/masterdata/reference');
  const [edit, setEdit] = useState<any>(null);
  const manage = can(P.POS_REGISTERS_MANAGE);
  return (
    <Page title="Registers" subtitle="Each register is one checkout counter, selling from one warehouse." actions={manage ? <button className="primary" onClick={() => setEdit({})}>Add register</button> : undefined}>
      {lic.data && (
        <div className="notice small">
          Licence: {lic.data.usage.registers} of {lic.data.maxRegisters ?? 'unlimited'} registers, {lic.data.usage.branches} of {lic.data.maxBranches ?? 'unlimited'} branches,{' '}
          {lic.data.usage.devices} of {lic.data.maxDevices ?? 'unlimited'} desktop devices. Offline selling allowed for {lic.data.offlineValidityHours} hours without a connection.
        </div>
      )}
      <ErrorBox error={regs.error} />
      {regs.loading && !regs.data && <Loading />}
      {regs.data?.length === 0 && <Empty>No registers yet.</Empty>}
      {!!regs.data?.length && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>Branch</th><th>Warehouse</th><th>Open shift</th><th>Devices</th><th>Status</th><th /></tr></thead>
            <tbody>
              {regs.data.map((r) => (
                <tr key={r.id}>
                  <td>{r.code}</td>
                  <td>{r.name}</td>
                  <td>{r.branch_name}</td>
                  <td>{r.warehouse_name}</td>
                  <td>{r.open_shift_number ? `${r.open_shift_number} · ${r.open_shift_cashier}` : '–'}</td>
                  <td>{r.device_count}</td>
                  <td><Status s={r.status} /></td>
                  <td>
                    {manage && <button onClick={() => setEdit(r)}>Edit</button>} <a href={`/pos/printers/?registerId=${r.id}`}>Hardware</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {manage && <StaffBranches branches={ref.data?.branches ?? []} />}
      {edit && <RegisterSheet reg={edit} ref_={ref.data} onClose={() => setEdit(null)} onDone={() => { setEdit(null); regs.reload(); lic.reload(); }} />}
    </Page>
  );
}

function RegisterSheet({ reg, ref_, onClose, onDone }: { reg: any; ref_: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ code: reg.code ?? '', name: reg.name ?? '', branchId: reg.branch_id ?? '', warehouseId: reg.warehouse_id ?? '', status: reg.status ?? 'ACTIVE' });
  const act = useAction();
  const whs = (ref_?.warehouses ?? []).filter((w: any) => !f.branchId || !w.branch_id || w.branch_id === f.branchId);
  async function save() {
    const body = { code: f.code, name: f.name, branchId: f.branchId, warehouseId: f.warehouseId };
    const r = await act.run(() => (reg.id ? api.put(`/pos/admin/registers/${reg.id}`, { ...body, status: f.status }) : api.post('/pos/admin/registers', body)));
    if (r) onDone();
  }
  return (
    <Sheet title={reg.id ? `Register ${reg.code}` : 'New register'} onClose={onClose}>
      <div className="form-grid">
        <Field label="Code"><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="R1" /></Field>
        <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Front counter" /></Field>
        <Field label="Branch">
          <select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value, warehouseId: '' })}>
            <option value="">Choose…</option>
            {(ref_?.branches ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
        <Field label="Sells from warehouse">
          <select value={f.warehouseId} onChange={(e) => setF({ ...f, warehouseId: e.target.value })}>
            <option value="">Choose…</option>
            {whs.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </Field>
        {reg.id && (
          <Field label="Status">
            <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              <option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option>
            </select>
          </Field>
        )}
      </div>
      <ErrorBox error={act.error} />
      <button className="primary" disabled={act.busy || !f.code || !f.name || !f.branchId || !f.warehouseId} onClick={save}>Save</button>
    </Sheet>
  );
}

/** Which branches each POS user may sell in (users with “all branches” are not limited). */
function StaffBranches({ branches }: { branches: any[] }) {
  const staff = useApi<any[]>('/pos/admin/staff');
  const act = useAction();
  async function toggle(u: any, b: string) {
    const ids: string[] = u.branch_ids.includes(b) ? u.branch_ids.filter((x: string) => x !== b) : [...u.branch_ids, b];
    if (await act.run(() => api.put(`/pos/admin/staff/${u.id}/branches`, { branchIds: ids }))) staff.reload();
  }
  return (
    <Card title="POS staff and branches">
      <ErrorBox error={staff.error ?? act.error} />
      {!!staff.data?.length && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>User</th><th>Roles</th><th>PIN</th>{branches.map((b) => <th key={b.id}>{b.name}</th>)}</tr></thead>
            <tbody>
              {staff.data.map((u) => (
                <tr key={u.id}>
                  <td>{u.full_name}<div className="small muted">{u.email}</div></td>
                  <td className="small">{u.roles.join(', ')}</td>
                  <td>{u.has_pin ? 'Set' : '–'}</td>
                  {branches.map((b) => (
                    <td key={b.id}><input type="checkbox" aria-label={`${u.full_name} in ${b.name}`} checked={u.branch_ids.includes(b.id)} disabled={act.busy} onChange={() => toggle(u, b.id)} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
