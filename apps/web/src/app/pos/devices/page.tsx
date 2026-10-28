'use client';
import { useEffect, useState } from 'react';
import { P } from '@ckh/shared';
import { PosShell, usePos } from '@/components/PosShell';
import { Empty, ErrorBox, Field, Loading, Page } from '@/components/ui';
import { api, tokenStore } from '@/lib/api';
import { desktopOffline, type DeviceStatus, LICENSE_REASONS, refreshDevice } from '@/lib/device';
import { ago, dateTime } from '@/lib/format';
import { useAction, useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

export default function DevicesPage() {
  return (
    <PosShell needRegister={false}>
      <Devices />
    </PosShell>
  );
}

function Devices() {
  const { ctx, can } = usePos();
  const manage = can(P.POS_DEVICES_MANAGE);
  const list = useApi<any[]>(manage ? '/pos/devices' : null);
  const act = useAction();
  const active = (list.data ?? []).filter((d) => d.status === 'ACTIVE').length;
  async function revoke(d: any) {
    if (!confirm(`Revoke ${d.name}? It stops selling offline at once and must be activated again to be used.`)) return;
    if (await act.run(() => api.post(`/pos/devices/${d.id}/revoke`, {}))) list.reload();
  }
  return (
    <Page title="POS devices" subtitle="Windows computers activated as tills. Each holds a signed offline licence that is renewed while it is online.">
      <ThisComputer onChange={list.reload} />
      {!manage && <div className="notice">Only managers activate and revoke devices.</div>}
      {manage && (
        <>
          <h2>Activated devices</h2>
          <div className="small muted">
            {active} active{ctx.license.maxDevices !== null ? ` of ${ctx.license.maxDevices} allowed by your plan` : ''}. Offline licences last up to {ctx.license.offlineValidityHours} hours and never beyond your subscription.
          </div>
          <ErrorBox error={list.error ?? act.error} />
          {list.loading && !list.data && <Loading />}
          {list.data?.length === 0 && <Empty>No device is activated yet. Open the CKH ONE POS app on the till computer and activate it here.</Empty>}
          {!!list.data?.length && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Device</th><th>Register</th><th>Status</th><th>Licence until</th><th>Last seen</th><th>Last upload</th><th className="num">Uploaded</th><th className="num">Refused</th><th /></tr></thead>
                <tbody>
                  {list.data.map((d) => (
                    <tr key={d.id}>
                      <td>{d.name}<div className="small muted">{[d.platform, d.app_version && `v${d.app_version}`].filter(Boolean).join(' · ')}</div></td>
                      <td>{d.branch_name} · {d.register_code}</td>
                      <td><span className={`badge ${d.status === 'ACTIVE' ? 'ok' : 'bad'}`}>{d.status === 'ACTIVE' ? 'Active' : 'Revoked'}</span>{d.revoked_by_name && <div className="small muted">by {d.revoked_by_name}</div>}</td>
                      <td>{dateTime(d.license_expires_at)}</td>
                      <td>{d.last_seen_at ? ago(d.last_seen_at) : '–'}</td>
                      <td>{d.last_sync_at ? ago(d.last_sync_at) : '–'}</td>
                      <td className="num">{d.synced_events}</td>
                      <td className="num">{d.refused_events ? <a href={`/pos/sync/?deviceId=${d.id}&status=REJECTED`}>{d.refused_events}</a> : 0}</td>
                      <td>{d.status === 'ACTIVE' && <button className="danger" disabled={act.busy} onClick={() => revoke(d)}>Revoke</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Page>
  );
}

/** Activation and licence state of the computer this page runs on (Windows app only). */
function ThisComputer({ onChange }: { onChange: () => void }) {
  const { ctx, can } = usePos();
  const s = useSession();
  const d = desktopOffline();
  const [st, setSt] = useState<DeviceStatus | null>(null);
  const [registerId, setRegisterId] = useState(ctx.register?.id ?? ctx.registers[0]?.id ?? '');
  const [name, setName] = useState('');
  const act = useAction();
  const [storeError, setStoreError] = useState<string | null>(null);
  useEffect(() => {
    void d?.device.status().then(setSt, (e: Error) => setStoreError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));
  }, [d]);
  if (!d) return <div className="notice">Open this page in the CKH ONE POS app on a till computer to activate it for offline selling.</div>;
  if (storeError) return <div className="notice bad">This computer cannot keep offline data safely: {storeError}</div>;
  if (!st) return <Loading />;
  async function activate() {
    const r = await act.run(async () => {
      await api.get('/auth/me'); // makes sure the sign-in is fresh
      const token = tokenStore.get();
      if (!token) throw new Error('Sign in again first');
      const out = await d!.device.activate(token, { registerId, name: name.trim() });
      await refreshDevice(s.me!.userId, can(P.POS_SALES_CREATE)).catch(() => undefined);
      return out;
    });
    if (r) {
      setSt(await d!.device.status());
      onChange();
    }
  }
  async function renew() {
    const r = await act.run(() => refreshDevice(s.me!.userId, can(P.POS_SALES_CREATE)));
    if (r) setSt(r);
  }
  const reg = ctx.registers.find((r) => r.id === st.registerId);
  return (
    <div className="card stack" data-testid="this-computer">
      <h2 style={{ margin: 0 }}>This computer</h2>
      {st.activated ? (
        <>
          <div className="kv">
            <span>Register</span><span>{reg ? `${reg.branch_name} · ${reg.code} ${reg.name}` : st.registerId}</span>
            <span>Offline selling</span>
            <span>{st.license.valid ? <span className="badge ok">Allowed until {dateTime(st.license.expiresAt)}</span> : <span className="badge bad">{LICENSE_REASONS[st.license.reason ?? 'NO_LICENSE']}</span>}</span>
            <span>Offline catalogue</span><span>{st.snapshotAt ? `saved ${dateTime(st.snapshotAt)}` : 'not saved yet'}</span>
            <span>Waiting to upload</span><span>{st.queued}{st.refused ? ` (${st.refused} refused earlier)` : ''}</span>
          </div>
          <div className="row">
            <button disabled={act.busy || st.license.reason === 'REVOKED'} onClick={renew}>Renew licence and catalogue now</button>
            {st.license.valid && <a className="btn" href="/pos/offline/">Open the offline till</a>}
          </div>
        </>
      ) : can(P.POS_DEVICES_MANAGE) ? (
        <>
          <p className="small muted">Activating gives this computer its own secret and a signed licence to sell for cash when the internet is down. It counts towards your plan’s device limit.</p>
          <div className="grid-2">
            <Field label="Register">
              <select value={registerId} onChange={(e) => setRegisterId(e.target.value)}>
                {ctx.registers.map((r) => <option key={r.id} value={r.id}>{r.branch_name} · {r.code} {r.name}</option>)}
              </select>
            </Field>
            <Field label="Name of this computer">
              <input value={name} placeholder="e.g. Front counter PC" onChange={(e) => setName(e.target.value)} maxLength={80} />
            </Field>
          </div>
          <button className="primary" disabled={act.busy || !registerId || !name.trim()} onClick={activate}>Activate this computer</button>
        </>
      ) : (
        <div className="notice">This computer is not activated. Ask a manager to activate it.</div>
      )}
      <ErrorBox error={act.error} />
    </div>
  );
}
