'use client';
import Link from 'next/link';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { P } from '@ckh/shared';
import { ErrorBox } from '@/components/ui';
import { useSession } from '@/lib/session';
import { usePosContext } from '@/lib/pos';
import { desktopOffline, DeviceStatus, LICENSE_REASONS, refreshDevice } from '@/lib/device';

type PosState = ReturnType<typeof usePosContext>;
const Ctx = createContext<PosState | null>(null);

export function usePos(): PosState & { ctx: NonNullable<PosState['ctx']> } {
  const s = useContext(Ctx);
  if (!s?.ctx) throw new Error('usePos outside PosShell');
  return s as PosState & { ctx: NonNullable<PosState['ctx']> };
}

const BOTTOM = [
  { href: '/pos/sell/', label: 'New sale', icon: '＋', perm: P.POS_SALES_CREATE },
  { href: '/pos/held/', label: 'Held sales', icon: '⏸' },
  { href: '/pos/sales/', label: 'Sales history', icon: '≣' },
  { href: '/pos/returns/', label: 'Returns', icon: '↺' },
  { href: '/pos/shifts/', label: 'Cash shifts', icon: '⌛' },
  { href: '/pos/menu/', label: 'Settings', icon: '⚙' },
];

/**
 * Full-screen frame for the till and the POS back office: who is selling, on
 * which register, whether the shift is open and whether the server is
 * reachable. Built for touch: large targets, no hover-only controls.
 */
export function PosShell({ children, needRegister = true, wide }: { children: ReactNode; needRegister?: boolean; wide?: boolean }) {
  const s = useSession();
  const pos = usePosContext();
  const [path, setPath] = useState('');
  const [clock, setClock] = useState('');
  useEffect(() => setPath(location.pathname.endsWith('/') ? location.pathname : `${location.pathname}/`), []);
  useEffect(() => {
    const t = () => setClock(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    t();
    const i = setInterval(t, 15_000);
    return () => clearInterval(i);
  }, []);
  useEffect(() => {
    if (!s.loading && !s.me) location.href = '/login/';
  }, [s.loading, s.me]);
  const device = useDevice();

  if (!s.me) return <div className="content muted">{s.loading ? 'Loading…' : 'Redirecting to sign in…'}</div>;
  if (!s.hasModule('POS_SALES')) {
    return (
      <div className="pos-center">
        <div className="notice warn">POS Sales is not part of your company’s subscription. Ask your administrator or CKH ONE support to activate it.</div>
        <Link href="/">Back to CKH ONE</Link>
      </div>
    );
  }
  if (!s.can(P.POS_ACCESS)) {
    return (
      <div className="pos-center">
        <div className="notice warn">Your account does not have access to the POS. Ask your administrator for a cashier role.</div>
        <Link href="/">Back to CKH ONE</Link>
      </div>
    );
  }
  if (pos.loading && !pos.ctx) return <div className="pos-center muted">Loading the till…</div>;
  if (pos.error && !pos.ctx) {
    return (
      <div className="pos-center">
        <ErrorBox error={pos.error} />
        {pos.error.isNetwork && device && <OfflineTillLink device={device} />}
        <button onClick={pos.reload}>Try again</button>
      </div>
    );
  }
  const ctx = pos.ctx!;

  return (
    <Ctx.Provider value={pos}>
      <div className="pos">
        <header className="pos-top">
          <a href="/pos/" className="brand">
            {ctx.company.logo_url ? <img src={ctx.company.logo_url} alt="" /> : <span className="logo">C1</span>}
            <span>{ctx.company.display_name}</span>
          </a>
          <div className="pos-top-info">
            {ctx.register ? (
              <>
                <span title="Branch">{ctx.register.branch_name}</span>
                <button className="link" title="Change register" onClick={() => pos.choose(null)}>
                  {ctx.register.code} · {ctx.register.name}
                </button>
              </>
            ) : (
              <span className="muted">No register</span>
            )}
            <span title="Cashier">{ctx.user.fullName}</span>
            {ctx.register &&
              (ctx.shift ? (
                <a href="/pos/shifts/" className="badge ok" title={`Opened ${new Date(ctx.shift.opened_at).toLocaleString()}`}>Shift {ctx.shift.number}</a>
              ) : (
                <a href="/pos/shifts/" className="badge warn">No open shift</a>
              ))}
            <span className={`badge ${s.online ? 'ok' : 'bad'}`}>{s.online ? 'Online' : 'Offline'}</span>
            <span className="muted">{clock}</span>
          </div>
        </header>
        {!s.online &&
          (device ? (
            <div className="notice warn pos-banner"><OfflineTillLink device={device} /></div>
          ) : (
            <div className="notice warn pos-banner">
              This browser is offline. The web till only records sales online; use the CKH ONE POS desktop app for offline selling.
            </div>
          ))}
        {s.online && device && device.queued > 0 && (
          <div className="notice pos-banner">{device.queued} offline sale{device.queued === 1 ? '' : 's'} on this computer waiting to upload.</div>
        )}
        {s.online && device?.license.reason === 'REVOKED' && (
          <div className="notice bad pos-banner">{LICENSE_REASONS.REVOKED}</div>
        )}
        <main className={`pos-main${wide ? ' wide' : ''}`}>
          {needRegister && !ctx.register ? <RegisterPicker pos={pos} /> : children}
        </main>
        <nav className="pos-bottom" aria-label="POS">
          {BOTTOM.filter((b) => !b.perm || pos.can(b.perm)).map((b) => (
            <a key={b.href} href={b.href} className={path.startsWith(b.href) ? 'active' : ''}>
              <span className="ico" aria-hidden>{b.icon}</span>
              {b.label}
            </a>
          ))}
        </nav>
      </div>
    </Ctx.Provider>
  );
}

const REFRESH_KEY = 'ckh.pos.deviceRefreshedAt';

/**
 * On the Windows app: renews the offline licence, refreshes the offline
 * catalogue and uploads waiting sales, at most every five minutes (and at
 * once when the connection comes back or sales are waiting).
 */
function useDevice() {
  const s = useSession();
  const [device, setDevice] = useState<DeviceStatus | null>(null);
  const userId = s.me?.userId;
  const canSell = s.can(P.POS_SALES_CREATE);
  useEffect(() => {
    const d = desktopOffline();
    if (!userId || !d) return;
    let stop = false;
    const run = async (force = false) => {
      const st = await d.device.status().catch(() => null);
      if (stop || !st) return;
      setDevice(st);
      if (!navigator.onLine || !st.activated) return;
      let last = 0;
      try {
        last = Number(sessionStorage.getItem(REFRESH_KEY) ?? 0);
      } catch {
        /* storage unavailable */
      }
      if (!force && st.queued === 0 && Date.now() - last < 5 * 60_000) return;
      const next = await refreshDevice(userId, canSell).catch(() => null);
      try {
        sessionStorage.setItem(REFRESH_KEY, String(Date.now()));
      } catch {
        /* storage unavailable */
      }
      if (!stop) setDevice(next ?? (await d.device.status().catch(() => st)));
    };
    void run();
    const online = () => void run(true);
    window.addEventListener('online', online);
    const t = setInterval(() => void run(), 5 * 60_000);
    return () => {
      stop = true;
      window.removeEventListener('online', online);
      clearInterval(t);
    };
  }, [userId, canSell]);
  return device;
}

function OfflineTillLink({ device }: { device: DeviceStatus }) {
  if (!device.activated) return <span>The server cannot be reached, and this computer is not activated for offline selling.</span>;
  if (!device.license.valid) return <span>The server cannot be reached. {LICENSE_REASONS[device.license.reason ?? 'NO_LICENSE']}</span>;
  return (
    <span>
      The server cannot be reached. You can keep selling for cash on the offline till until{' '}
      {new Date(device.license.expiresAt!).toLocaleString()}.{' '}
      <a href="/pos/offline/" className="btn primary">Open the offline till</a>
    </span>
  );
}

function RegisterPicker({ pos }: { pos: PosState }) {
  const regs = pos.ctx!.registers;
  return (
    <div className="pos-center" style={{ maxWidth: 640 }}>
      <h1>Choose this till’s register</h1>
      <p className="muted">This device will remember it. Registers are set up under Settings → Registers.</p>
      {regs.length === 0 && <div className="notice warn">There are no active registers in your branches yet.</div>}
      <div className="pos-tiles">
        {regs.map((r) => (
          <button key={r.id} className="pos-tile" onClick={() => pos.choose(r.id)}>
            <b>{r.code}</b>
            <span>{r.name}</span>
            <span className="muted small">{r.branch_name} · {r.warehouse_name}</span>
          </button>
        ))}
      </div>
      <Link href="/">Back to CKH ONE</Link>
    </div>
  );
}

/** A modal sheet; closes on Escape and on the backdrop. */
export function Sheet({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="sheet-back" onClick={onClose}>
      <div className={`sheet${wide ? ' wide' : ''}`} role="dialog" aria-modal onClick={(e) => e.stopPropagation()}>
        <div className="spread sheet-head">
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="link" aria-label="Close" onClick={onClose} style={{ fontSize: 22 }}>×</button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

/** Numeric keypad for touch screens (amounts, quantities, PINs). */
export function Keypad({ value, onChange, decimals = true, mask }: { value: string; onChange: (v: string) => void; decimals?: boolean; mask?: boolean }) {
  const press = (k: string) => {
    if (k === '⌫') return onChange(value.slice(0, -1));
    if (k === 'C') return onChange('');
    if (k === '.' && (!decimals || value.includes('.'))) return;
    if (decimals && value.includes('.') && value.split('.')[1].length >= 2) return;
    onChange(value === '0' && k !== '.' ? k : value + k);
  };
  return (
    <div>
      <div className="keypad-display">{mask ? '•'.repeat(value.length) : value || '0'}</div>
      <div className="keypad">
        {['7', '8', '9', '4', '5', '6', '1', '2', '3', decimals ? '.' : 'C', '0', '⌫'].map((k) => (
          <button key={k} type="button" onClick={() => press(k)}>{k}</button>
        ))}
      </div>
    </div>
  );
}
