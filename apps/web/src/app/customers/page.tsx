'use client';
import { useState } from 'react';
import { Authed } from '@/components/Authed';
import { Empty, ErrorBox, Loading, Page } from '@/components/ui';
import { qs } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

function Customers() {
  const s = useSession();
  const [search, setSearch] = useState('');
  const { data, error, loading } = useApi<any[]>(s.online ? `/sales/customers${qs({ search, limit: 100 })}` : null);
  const rows: any[] = s.online ? data ?? [] : (s.snapshot?.data.customers ?? []).filter((c: any) => `${c.code} ${c.name}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <Page title="My customers" subtitle={s.online ? 'Customers you are allowed to serve' : 'Offline copy on this device'}>
      <input placeholder="Search name, code or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : rows.length === 0 ? <Empty>No customers found.</Empty> : (
        <div className="card tight">
          <ul className="list">
            {rows.map((c) => (
              <li key={c.id}>
                <a className="listlink spread" href={`/customers/view/?id=${c.id}`}>
                  <span>
                    <b>{c.name}</b> <span className="muted small">{c.code}</span>
                    <div className="muted small">{[c.contact_name, c.phone, c.group_name].filter(Boolean).join(' · ') || ' '}{c.last_order_date ? ` · last order ${date(c.last_order_date)}` : ''}</div>
                  </span>
                  <span className="right small">
                    {c.credit_hold && <span className="badge bad">Credit hold</span>}
                    {c.outstanding !== undefined && c.outstanding !== null && <div>{money(c.outstanding)}</div>}
                    {Number(c.overdue) > 0 && <div className="badge warn">{money(c.overdue)} overdue</div>}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Page>
  );
}
export default function P() {
  return <Authed><Customers /></Authed>;
}
