'use client';
import { useEffect, useState } from 'react';
import { Authed } from '@/components/Authed';
import { Empty, ErrorBox, Loading, Page, StaleBadge } from '@/components/ui';
import { qs } from '@/lib/api';
import { money, num } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

function Catalog() {
  const s = useSession();
  const [search, setSearch] = useState('');
  const [categoryId, setCategory] = useState('');
  const [customerId, setCustomer] = useState('');
  useEffect(() => setCustomer(new URLSearchParams(location.search).get('customerId') ?? ''), []);
  const { data, error, loading } = useApi<any[]>(s.online ? `/sales/catalog/products${qs({ search, categoryId, customerId, limit: 100 })}` : null);
  const offline = !s.online ? (s.snapshot?.data.products ?? []).filter((p: any) => `${p.sku} ${p.name} ${p.barcode ?? ''}`.toLowerCase().includes(search.toLowerCase()) && (!categoryId || p.category_id === categoryId)) : null;
  const rows: any[] = offline ?? data ?? [];
  const customers: any[] = s.snapshot?.data.customers ?? [];
  const categories = [...new Map(rows.filter((p) => p.category_id).map((p) => [p.category_id, p.category_name])).entries()];
  return (
    <Page title="Product catalog" actions={<StaleBadge asOf={offline ? s.snapshot?.snapshotAt : rows[0]?.stock_as_of} />}>
      <div className="form-grid">
        <input placeholder="Search name, SKU or scan barcode" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={categoryId} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {categories.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        {s.online && customers.length > 0 && (
          <select value={customerId} onChange={(e) => setCustomer(e.target.value)} aria-label="Price for customer">
            <option value="">List prices</option>
            {customers.map((c) => <option key={c.id} value={c.id}>Prices for {c.name}</option>)}
          </select>
        )}
      </div>
      <ErrorBox error={error} />
      {loading && !data && !offline ? <Loading /> : rows.length === 0 ? <Empty>No products match.</Empty> : (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          {rows.map((p) => {
            const avail = (p.stock ?? []).reduce((t: number, w: any) => t + Number(w.available), 0);
            return (
              <a key={p.id} className="card listlink" href={`/catalog/view/?id=${p.id}${customerId ? `&customerId=${customerId}` : ''}`}>
                {p.image_urls?.[0] ? <img src={p.image_urls[0]} alt="" style={{ width: '100%', height: 120, objectFit: 'cover', borderRadius: 6 }} /> : <div style={{ height: 60, display: 'grid', placeItems: 'center', background: 'var(--ckh-bg)', borderRadius: 6 }} className="muted small">No image</div>}
                <div style={{ marginTop: 8 }}><b>{p.name}</b></div>
                <div className="muted small">{p.sku}{p.barcode ? ` · ${p.barcode}` : ''} · {p.unit_code}</div>
                <div className="spread" style={{ marginTop: 6 }}>
                  <b>{money(p.customer_price ?? p.list_price, p.currency)}</b>
                  {p.track_inventory && <span className={`badge ${avail > 0 ? 'ok' : 'bad'}`}>{avail > 0 ? `${num(avail)} available` : 'Out of stock'}</span>}
                </div>
                {p.price_source && p.price_source !== 'LIST' && <div className="small muted">{p.price_source.replace('_', ' ').toLowerCase()} price</div>}
              </a>
            );
          })}
        </div>
      )}
    </Page>
  );
}
export default function P() {
  return <Authed><Catalog /></Authed>;
}
