'use client';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { P } from '@ckh/shared';
import { useSession } from '@/lib/session';

interface NavItem { href: string; label: string; short?: string; icon: string; perm?: string; anyPerm?: string[]; module?: string }
const GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Selling',
    items: [
      { href: '/', label: 'Dashboard', icon: '◧', perm: P.SALES_DASHBOARD_VIEW },
      { href: '/customers/', label: 'My customers', short: 'Customers', icon: '☺', perm: P.SALES_CUSTOMERS_VIEW_ASSIGNED },
      { href: '/catalog/', label: 'Product catalog', icon: '▦', perm: P.SALES_CATALOG_VIEW },
      { href: '/orders/new/', label: 'New order', icon: '＋', perm: P.SALES_ORDERS_CREATE, module: 'SALES_ORDER_MANAGEMENT' },
      { href: '/orders/', label: 'My orders', short: 'Orders', icon: '≣', module: 'SALES_ORDER_MANAGEMENT' },
      { href: '/visits/', label: 'Customer visits', short: 'Visits', icon: '⌖', perm: P.SALES_VISITS_MANAGE },
      { href: '/collections/', label: 'Payment collections', icon: '$', anyPerm: [P.SALES_COLLECTIONS_SUBMIT, P.SALES_COLLECTIONS_VERIFY], module: 'ACCOUNTING' },
    ],
  },
  {
    title: 'Point of sale',
    items: [
      { href: '/pos/sell/', label: 'POS checkout', icon: '▣', perm: P.POS_SALES_CREATE, module: 'POS_SALES' },
      { href: '/pos/', label: 'POS dashboard', icon: '◫', perm: P.POS_ACCESS, module: 'POS_SALES' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { href: '/approvals/', label: 'Pending approvals', icon: '✓', perm: P.SALES_ORDERS_APPROVE, module: 'SALES_ORDER_MANAGEMENT' },
      { href: '/deliveries/', label: 'Delivery tracking', icon: '⇄', module: 'SALES_ORDER_MANAGEMENT' },
      { href: '/sync/', label: 'Offline queue', icon: '⟳', module: 'SALES_OFFLINE_ORDERING' },
    ],
  },
  {
    title: 'Performance',
    items: [
      { href: '/targets/', label: 'Sales targets', icon: '◎', perm: P.SALES_TARGETS_VIEW },
      { href: '/commissions/', label: 'Commissions', icon: '%', perm: P.SALES_COMMISSIONS_VIEW, module: 'SALES_COMMISSION_MANAGEMENT' },
      { href: '/team/', label: 'Team performance', icon: '☷', anyPerm: [P.SALES_ORDERS_VIEW_TEAM, P.SALES_ORDERS_VIEW_ALL] },
      { href: '/territories/', label: 'Territory map', icon: '⌂', perm: P.SALES_DASHBOARD_VIEW, module: 'SALES_TERRITORY_MANAGEMENT' },
      { href: '/reports/', label: 'Sales reports', icon: '▤', perm: P.SALES_REPORTS_VIEW },
    ],
  },
  { title: 'Admin', items: [{ href: '/settings/', label: 'Sales settings', icon: '⚙', anyPerm: [P.SALES_SETTINGS_MANAGE, P.TENANT_SETTINGS_MANAGE] }] },
];
const MOBILE = ['/', '/customers/', '/orders/new/', '/orders/', '/visits/'];

export function AppShell({ children }: { children: ReactNode }) {
  const s = useSession();
  const [path, setPath] = useState('/');
  const [open, setOpen] = useState(false);
  useEffect(() => setPath(location.pathname.endsWith('/') ? location.pathname : `${location.pathname}/`), []);

  useEffect(() => {
    if (!s.loading && !s.me && !location.pathname.startsWith('/login')) location.href = '/login/';
  }, [s.loading, s.me]);
  if (!s.me) return <div className="content muted">{s.loading ? 'Loading…' : 'Redirecting to sign in…'}</div>;

  const visible = (i: NavItem) =>
    (!i.perm || s.can(i.perm)) && (!i.anyPerm || i.anyPerm.some((p) => s.can(p))) && (!i.module || s.hasModule(i.module));
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter(visible) })).filter((g) => g.items.length);
  const all = groups.flatMap((g) => g.items);
  const isActive = (href: string) => (href === '/' ? path === '/' : path.startsWith(href) && !(href === '/orders/' && path.startsWith('/orders/new')));
  const nav = (
    <>
      {groups.map((g) => (
        <div key={g.title}>
          <div className="navgroup">{g.title}</div>
          {g.items.map((i) => (
            <a key={i.href} href={i.href} className={isActive(i.href) ? 'active' : ''}>
              <span aria-hidden style={{ display: 'inline-block', width: 22 }}>{i.icon}</span>
              {i.label}
            </a>
          ))}
        </div>
      ))}
    </>
  );

  return (
    <div className="shell">
      <header className="topbar">
        <div className="row">
          <button className="menu-btn link" aria-label="Menu" onClick={() => setOpen(!open)} style={{ fontSize: 22, color: 'var(--ckh-text)' }}>☰</button>
          <Link href="/" className="brand">
            <span className="logo">C1</span> CKH ONE <span className="muted small" style={{ fontWeight: 400 }}>Sales</span>
          </Link>
        </div>
        <div className="row small">
          {!s.online && <span className="badge warn">Offline</span>}
          {s.queue.pending > 0 && <a href="/sync/" className="badge info">{s.queue.pending} to sync</a>}
          {s.queue.problems > 0 && <a href="/sync/" className="badge bad">{s.queue.problems} need attention</a>}
          <span className="muted" title={s.me.email}>{s.me.fullName}</span>
          <button className="link small" onClick={s.logout}>Sign out</button>
        </div>
      </header>
      <nav className="sidenav" aria-label="Main">{nav}</nav>
      {open && <nav className="drawer" onClick={() => setOpen(false)}>{nav}</nav>}
      <main className="content">{children}</main>
      <nav className="bottomnav" aria-label="Quick">
        {MOBILE.map((h) => all.find((i) => i.href === h)).filter(Boolean).slice(0, 4).concat([{ href: '#menu', label: 'More', icon: '⋯' } as NavItem]).map((i) =>
          i!.href === '#menu' ? (
            <a key="more" href="#" onClick={(e) => { e.preventDefault(); setOpen(!open); }}><span className="ico">⋯</span>More</a>
          ) : (
            <a key={i!.href} href={i!.href} className={isActive(i!.href) ? 'active' : ''}><span className="ico">{i!.icon}</span>{i!.short ?? i!.label}</a>
          ),
        )}
      </nav>
    </div>
  );
}
