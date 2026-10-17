'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { P } from '@ckh/shared';
import { ErrorBox } from '@/components/ui';
import { useSession } from '@/lib/session';
import { usePosContext } from '@/lib/pos';

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

  if (!s.me) return <div className="content muted">{s.loading ? 'Loading…' : 'Redirecting to sign in…'}</div>;
  if (!s.hasModule('POS_SALES')) {
    return (
      <div className="pos-center">
        <div className="notice warn">POS Sales is not part of your company’s subscription. Ask your administrator or CKH ONE support to activate it.</div>
        <a href="/">Back to CKH ONE</a>
      </div>
    );
  }
  if (!s.can(P.POS_ACCESS)) {
    return (
      <div className="pos-center">
        <div className="notice warn">Your account does not have access to the POS. Ask your administrator for a cashier role.</div>
        <a href="/">Back to CKH ONE</a>
      </div>
    );
  }
  if (pos.loading && !pos.ctx) return <div className="pos-center muted">Loading the till…</div>;
  if (pos.error && !pos.ctx) {
    return (
      <div className="pos-center">
        <ErrorBox error={pos.error} />
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
        {!s.online && (
          <div className="notice warn pos-banner">
            This browser is offline. The web till only records sales online; use the CKH ONE POS desktop app for offline selling.
          </div>
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
      <a href="/">Back to CKH ONE</a>
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
