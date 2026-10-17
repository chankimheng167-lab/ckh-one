'use client';
import type { ReactNode } from 'react';
import { ago, human } from '@/lib/format';
import { useSession } from '@/lib/session';

export function Page({ title, subtitle, actions, children }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="stack">
      <div className="spread">
        <div>
          <h1>{title}</h1>
          {subtitle && <div className="muted small">{subtitle}</div>}
        </div>
        {actions && <div className="row">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export const Card = ({ title, children, actions, tight }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; tight?: boolean }) => (
  <section className={`card${tight ? ' tight' : ''}`}>
    {(title || actions) && (
      <div className="spread" style={{ marginBottom: 8 }}>
        {title ? <h2 style={{ margin: 0 }}>{title}</h2> : <span />}
        {actions}
      </div>
    )}
    {children}
  </section>
);

export const Stat = ({ label, value, hint, href }: { label: string; value: ReactNode; hint?: ReactNode; href?: string }) => {
  const body = (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
  return href ? <a href={href} className="listlink">{body}</a> : body;
};

const TONE: Record<string, string> = {
  DRAFT: '', SUBMITTED: 'info', PENDING_APPROVAL: 'warn', APPROVED: 'ok', REJECTED: 'bad', CANCELLED: 'bad', STOCK_RESERVED: 'info',
  PICKING: 'info', PACKED: 'info', DISPATCHED: 'info', PARTIALLY_DELIVERED: 'warn', DELIVERED: 'ok', INVOICED: 'ok', CLOSED: '',
  PLANNED: 'info', IN_PROGRESS: 'warn', COMPLETED: 'ok', MISSED: 'bad', PENDING_VERIFICATION: 'warn', VERIFIED: 'ok',
  SENT: 'info', ACCEPTED: 'ok', EXPIRED: 'bad', CONVERTED: 'ok', ESTIMATED: 'warn', SENT_TO_PAYROLL: 'info', PAID: 'ok',
  PENDING: 'warn', SYNCING: 'info', ACCEPTED_WITH_CHANGES: 'warn', CONFLICT: 'bad', ISSUED: 'info', PARTIALLY_PAID: 'warn',
  REQUESTED: 'warn', RECEIVED: 'ok', TRIAL: 'info', ACTIVE: 'ok', PAST_DUE: 'warn', SUSPENDED: 'bad',
};
export const Status = ({ s }: { s: string | null | undefined }) => (s ? <span className={`badge ${TONE[s] ?? ''}`}>{human(s)}</span> : null);

export const Loading = () => <div className="muted">Loading…</div>;
export function ErrorBox({ error }: { error: { message: string; code?: string; status?: number } | string | null | undefined }) {
  if (!error) return null;
  const e = typeof error === 'string' ? { message: error } : error;
  if (e.status === 402) return <div className="notice warn">This feature is not included in your company’s subscription. Ask your administrator.</div>;
  if (e.status === 403) return <div className="notice warn">You don’t have permission to see this.</div>;
  return <div className="notice bad">{e.message}</div>;
}
export const Empty = ({ children }: { children: ReactNode }) => <div className="muted" style={{ padding: '12px 0' }}>{children}</div>;

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** Shown wherever stock or prices come from the offline snapshot. */
export function StaleBadge({ asOf }: { asOf?: string | null }) {
  const { stale, online, snapshot } = useSession();
  const when = asOf ?? snapshot?.snapshotAt;
  if (online && !stale) return when ? <span className="badge ok" title={new Date(when).toLocaleString()}>Stock live</span> : null;
  if (!when) return <span className="badge bad">No offline stock data</span>;
  return (
    <span className={`badge ${stale ? 'bad' : 'warn'}`} title="Stock and prices will be re-checked by the server when you sync">
      {stale ? 'Stale stock' : 'Offline stock'} · {ago(when)}
    </span>
  );
}

export function Progress({ value, marker }: { value: number; marker?: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      {marker !== undefined && <b style={{ left: `${Math.min(100, marker)}%` }} />}
    </div>
  );
}
